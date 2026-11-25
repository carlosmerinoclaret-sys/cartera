// Repetidor para la app Cartera (Cloudflare Workers, plan gratuito).
// EODHD no acepta llamadas directas desde páginas web (CORS). Este Worker recibe
// las peticiones de la app, las reenvía SOLO a https://eodhd.com/api/ y devuelve
// la respuesta con las cabeceras que el navegador necesita.
//
// Opcional (recomendado): en el Worker → Settings → Variables and Secrets añade
//   EODHD_TOKEN    = tu clave de EODHD   (así la clave no se guarda en el móvil)
//   ALLOWED_ORIGIN = la dirección de tu app, p. ej. https://tu-usuario.github.io
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/')) {
      return new Response('Cartera: repetidor de datos activo.', { status: 200, headers: cors });
    }

    const target = new URL('https://eodhd.com' + url.pathname + url.search);
    if (!target.searchParams.get('api_token') && env.EODHD_TOKEN) {
      target.searchParams.set('api_token', env.EODHD_TOKEN);
    }

    const upstream = await fetch(target.toString(), { headers: { Accept: 'application/json' } });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
