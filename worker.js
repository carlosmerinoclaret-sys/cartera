// Worker de la app Cartera (Cloudflare Workers, plan gratuito).
// 1) /api/...  → repetidor de precios de EODHD (añade CORS y, si existe, la clave EODHD_TOKEN).
// 2) /sync     → guarda y lee tus datos (datos.json) en tu repositorio PRIVADO de GitHub.
// 3) /focus    → app Focus: retos de hábitos con amigos (focus.json en el mismo repositorio privado).
// Variables (Settings → Variables and Secrets): EODHD_TOKEN, SYNC_KEY, GITHUB_TOKEN, DATA_REPO (opcional).
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

    if (url.pathname === '/focus' || url.pathname.startsWith('/focus/')) {
      try { return await focus(request, env, url, json); }
      catch (e) { return json({ error: e.status ? e.message : 'Error del servidor' }, e.status || 500); }
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

// ───────────────────────── Focus ─────────────────────────
// Retos de hábitos en grupo. Sin cuentas: cada reto tiene un código para unirse y
// cada miembro recibe un token secreto (guardado en su móvil) para marcar solo lo suyo.
const HABITOS = [
  { id: 'gym', nombre: 'Gimnasio', emoji: '🏋️' },
  { id: 'deporte', nombre: 'Deporte', emoji: '⚽' },
  { id: 'estudio', nombre: 'Estudio', emoji: '📚' },
  { id: 'comida', nombre: 'Comida sana', emoji: '🥗' },
  { id: 'alcohol', nombre: '0 alcohol', emoji: '🚫' },
];
const COLORES = ['#c6ff3d', '#ff6b4a', '#4ad7ff', '#ffc93d', '#c08bff', '#ff5fa8', '#5cffb1', '#ff9f43', '#7d9bff', '#e8e8e8'];
const ferr = (status, message) => Object.assign(new Error(message), { status });
const hoyMadrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const sumaDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esFecha = f => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(new Date(f + 'T12:00:00Z'));
const texto = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const aleatorio = (n, abc) => { const a = crypto.getRandomValues(new Uint8Array(n)); return [...a].map(x => abc[x % abc.length]).join(''); };
async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function vistaPublica(code, r) {
  const { tokens, ...resto } = r;
  return { code, hoy: hoyMadrid(), ...resto };
}

async function focus(request, env, url, json) {
  const api = `https://api.github.com/repos/${env.DATA_REPO || 'carlosmerinoclaret-sys/cartera-datos'}/contents/focus.json`;
  const gh = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'cartera-focus', Accept: 'application/vnd.github+json' };
  const leer = async () => {
    const r = await fetch(api, { headers: gh });
    if (r.status === 404) return { datos: { retos: {} }, sha: null };
    if (!r.ok) throw ferr(502, 'No se pudo leer los datos (GitHub ' + r.status + ')');
    const f = await r.json();
    return { datos: JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))))), sha: f.sha };
  };
  // Lee, aplica el cambio y guarda; si otro amigo guardó a la vez, lo reintenta.
  const cambiar = async (fn) => {
    for (let i = 0; i < 5; i++) {
      const { datos, sha: s } = await leer();
      datos.retos ||= {};
      const resultado = await fn(datos);
      const body = JSON.stringify({ message: 'Focus', content: btoa(unescape(encodeURIComponent(JSON.stringify(datos)))), ...(s ? { sha: s } : {}) });
      const r = await fetch(api, { method: 'PUT', headers: gh, body });
      if (r.ok) return resultado;
      if (r.status !== 409 && r.status !== 422) throw ferr(502, 'No se pudo guardar (GitHub ' + r.status + ')');
      await new Promise(ok => setTimeout(ok, 150 + Math.random() * 400));
    }
    throw ferr(409, 'Mucha gente guardando a la vez. Inténtalo de nuevo.');
  };
  const autorizar = async (r, id, token) => {
    if (!r) throw ferr(404, 'Ese reto no existe. Revisa el código.');
    if (!id || !r.tokens?.[id] || r.tokens[id] !== await sha(String(token || ''))) throw ferr(403, 'Este móvil no está identificado en el reto.');
  };
  const nuevoMiembro = async (r, body) => {
    const nombre = texto(body.nombre, 20);
    if (!nombre) throw ferr(400, 'Escribe tu nombre.');
    const ids = Object.keys(r.miembros || {});
    if (ids.length >= 20) throw ferr(400, 'El reto ya tiene 20 miembros.');
    if (ids.some(k => r.miembros[k].nombre.toLowerCase() === nombre.toLowerCase())) throw ferr(400, 'Ya hay alguien con ese nombre en el reto.');
    const id = aleatorio(8, 'abcdefghijkmnpqrstuvwxyz23456789');
    const token = aleatorio(32, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789');
    r.miembros ||= {}; r.tokens ||= {}; r.marcas ||= {};
    r.miembros[id] = { nombre, emoji: texto(body.emoji, 4) || '🔥', color: COLORES[ids.length % COLORES.length], unido: hoyMadrid() };
    r.tokens[id] = await sha(token);
    r.marcas[id] = {};
    return { id, token };
  };

  const ruta = url.pathname.replace(/\/+$/, '');
  if (request.method === 'GET' && ruta === '/focus') {
    const code = texto(url.searchParams.get('c'), 12).toUpperCase();
    const { datos } = await leer();
    const r = datos.retos?.[code];
    if (!r) throw ferr(404, 'Ese reto no existe. Revisa el código.');
    return json(vistaPublica(code, r));
  }
  if (request.method !== 'POST') throw ferr(405, 'Método no permitido');
  let body;
  try { body = JSON.parse(await request.text()); } catch { throw ferr(400, 'Petición no válida'); }
  if (!body || typeof body !== 'object') throw ferr(400, 'Petición no válida');

  if (ruta === '/focus/crear') {
    const inicio = esFecha(body.inicio) ? body.inicio : hoyMadrid();
    const dias = Math.min(60, Math.max(3, parseInt(body.dias) || 21));
    return json(await cambiar(async datos => {
      let code; do { code = aleatorio(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); } while (datos.retos[code]);
      const r = { nombre: texto(body.reto, 40) || 'Focus', creado: hoyMadrid(), inicio, dias,
        meta: Math.min(dias * 6, Math.max(10, parseInt(body.meta) || Math.round(dias * 6 * 0.8 / 5) * 5)),
        habitos: HABITOS, miembros: {}, tokens: {}, marcas: {} };
      const yo = await nuevoMiembro(r, body);
      r.creador = yo.id;
      datos.retos[code] = r;
      return { code, ...yo, reto: vistaPublica(code, r) };
    }));
  }
  if (ruta === '/focus/unirse') {
    const code = texto(body.code, 12).toUpperCase();
    return json(await cambiar(async datos => {
      const r = datos.retos[code];
      if (!r) throw ferr(404, 'Ese reto no existe. Revisa el código.');
      const yo = await nuevoMiembro(r, body);
      return { code, ...yo, reto: vistaPublica(code, r) };
    }));
  }
  if (ruta === '/focus/marcar') {
    const code = texto(body.code, 12).toUpperCase();
    if (!esFecha(body.fecha)) throw ferr(400, 'Fecha no válida');
    return json(await cambiar(async datos => {
      const r = datos.retos[code];
      await autorizar(r, body.id, body.token);
      const hoy = hoyMadrid(), fin = sumaDias(r.inicio, r.dias - 1);
      if (body.fecha < r.inicio || body.fecha > fin) throw ferr(400, 'Ese día no es parte del reto.');
      if (body.fecha > hoy) throw ferr(400, 'No puedes marcar días que aún no han llegado.');
      if (body.fecha < sumaDias(hoy, -1)) throw ferr(400, 'Solo puedes marcar hoy y ayer.');
      const validos = new Set(r.habitos.map(h => h.id));
      const lista = [...new Set((Array.isArray(body.habitos) ? body.habitos : []).filter(h => validos.has(h)))];
      r.marcas[body.id] ||= {};
      if (lista.length) r.marcas[body.id][body.fecha] = lista; else delete r.marcas[body.id][body.fecha];
      return { ok: true, reto: vistaPublica(code, r) };
    }));
  }
  if (ruta === '/focus/ajustes') {
    const code = texto(body.code, 12).toUpperCase();
    return json(await cambiar(async datos => {
      const r = datos.retos[code];
      await autorizar(r, body.id, body.token);
      if (body.id !== r.creador) throw ferr(403, 'Solo quien creó el reto puede cambiarlo.');
      if (body.reto) r.nombre = texto(body.reto, 40) || r.nombre;
      if (esFecha(body.inicio)) r.inicio = body.inicio;
      if (body.dias) r.dias = Math.min(60, Math.max(3, parseInt(body.dias) || r.dias));
      if (body.meta) r.meta = Math.min(r.dias * 6, Math.max(10, parseInt(body.meta) || r.meta));
      if (body.expulsar && body.expulsar !== r.creador && r.miembros[body.expulsar]) {
        delete r.miembros[body.expulsar]; delete r.tokens[body.expulsar]; delete r.marcas[body.expulsar];
      }
      return { ok: true, reto: vistaPublica(code, r) };
    }));
  }
  if (ruta === '/focus/salir') {
    const code = texto(body.code, 12).toUpperCase();
    return json(await cambiar(async datos => {
      const r = datos.retos[code];
      await autorizar(r, body.id, body.token);
      if (body.id === r.creador) throw ferr(400, 'Quien creó el reto no puede salir de él.');
      delete r.miembros[body.id]; delete r.tokens[body.id]; delete r.marcas[body.id];
      return { ok: true };
    }));
  }
  throw ferr(404, 'Ruta no encontrada');
}
