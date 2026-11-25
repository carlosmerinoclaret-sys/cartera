// Worker de la app Cartera (Cloudflare Workers, plan gratuito).
// 1) /api/...  → repetidor de precios de EODHD (añade CORS y, si existe, la clave EODHD_TOKEN).
// 2) /sync     → guarda y lee tus datos (datos.json) en tu repositorio PRIVADO de GitHub.
// Variables (Settings → Variables and Secrets): EODHD_TOKEN, SYNC_KEY, GITHUB_TOKEN, DATA_REPO (opcional).
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const json = (o, status = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o),
      { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    if (url.pathname === '/sync') {
      if (!env.SYNC_KEY || request.headers.get('X-Sync-Key') !== env.SYNC_KEY) return json({ error: 'unauthorized' }, 401);
      const api = `https://api.github.com/repos/${env.DATA_REPO || 'carlosmerinoclaret-sys/cartera-datos'}/contents/datos.json`;
      const gh = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'cartera-sync', Accept: 'application/vnd.github+json' };
      const current = async () => {
        const r = await fetch(api, { headers: gh });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('github ' + r.status);
        return r.json();
      };
      if (request.method === 'GET') {
        const f = await current();
        if (!f) return json({});
        return json(decodeURIComponent(escape(atob(f.content.replace(/\n/g, '')))));
      }
      if (request.method === 'PUT') {
        let data;
        try { data = JSON.parse(await request.text()); } catch { return json({ error: 'bad json' }, 400); }
        const text = JSON.stringify(data, null, 1);
        for (let i = 0; i < 2; i++) {
          const f = await current();
          const r = await fetch(api, { method: 'PUT', headers: gh, body: JSON.stringify({
            message: 'Actualización desde la app', content: btoa(unescape(encodeURIComponent(text))), ...(f ? { sha: f.sha } : {}) }) });
          if (r.ok) return json({ ok: true });
          if (r.status !== 409 && r.status !== 422) return json({ error: 'github ' + r.status }, 502);
        }
        return json({ error: 'conflict' }, 409);
      }
      return json({ error: 'method' }, 405);
    }

    if (request.method !== 'GET' || !url.pathname.startsWith('/api/')) {
      return new Response('Cartera: repetidor de datos activo.', { status: 200, headers: cors });
    }
    const target = new URL('https://eodhd.com' + url.pathname + url.search);
    if (!target.searchParams.get('api_token') && env.EODHD_TOKEN) target.searchParams.set('api_token', env.EODHD_TOKEN);
    const upstream = await fetch(target.toString(), { headers: { Accept: 'application/json' } });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
