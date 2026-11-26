// Worker de la app Cartera (Cloudflare Workers, plan gratuito).
// 1) /api/...  → repetidor de precios de EODHD (añade CORS y, si existe, la clave EODHD_TOKEN).
// 2) /sync     → guarda y lee tus datos (datos.json) en tu repositorio PRIVADO de GitHub.
// 3) /focus    → app Operación Batman: retos de hábitos con amigos (base de datos D1 enlazada como DB).
// Variables (Settings → Variables and Secrets): EODHD_TOKEN, SYNC_KEY, GITHUB_TOKEN, DATA_REPO (opcional).
export default {
  async fetch(request, env, ctx) {
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
      try { return await focus(request, env, url, json, ctx); }
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
// Cada hábito se marca con una foto hecha en el momento. Todo se guarda en una base de datos
// Cloudflare D1 enlazada al Worker con el nombre DB (gratis). Los avisos van por Web Push con
// claves que el propio Worker genera y guarda en la base la primera vez.
const HABITOS = [
  { id: 'gym', nombre: 'Gimnasio', emoji: '🏋️' },
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
const idOk = s => typeof s === 'string' && /^[a-z0-9]{4,16}$/.test(s);
async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function vistaPublica(code, r) {
  const { tokens, subs, ...resto } = r;
  return { code, hoy: hoyMadrid(), ...resto };
}

// ── Web Push (RFC 8291 + VAPID, RFC 8292) con WebCrypto ──
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const une = (...as) => { const out = new Uint8Array(as.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of as) { out.set(a, i); i += a.length; } return out; };
const enc = s => new TextEncoder().encode(s);
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function cifrarPush(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, une(enc('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, une(enc('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, une(enc('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, une(enc(payload), new Uint8Array([2]))));
  return une(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function jwtVapid(endpoint, vapid) {
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:focus@example.com' })));
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(h + '.' + p));
  return h + '.' + p + '.' + b64u(firma);
}
async function enviarPush(sub, payload, vapid) {
  const body = await cifrarPush(sub, payload);
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
    Authorization: `vapid t=${await jwtVapid(sub.endpoint, vapid)}, k=${vapid.publicKey}` } });
  return r.status;
}

let esquemaListo = false;
async function esquema(db) {
  if (esquemaListo) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS retos (code TEXT PRIMARY KEY, data TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS miembros (code TEXT, id TEXT, nombre TEXT, emoji TEXT, color TEXT, unido TEXT, token TEXT, PRIMARY KEY (code, id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS marcas (code TEXT, id TEXT, fecha TEXT, habito TEXT, ts INTEGER, PRIMARY KEY (code, id, fecha, habito))'),
    db.prepare('CREATE TABLE IF NOT EXISTS fotos (code TEXT, id TEXT, fecha TEXT, habito TEXT, img TEXT, PRIMARY KEY (code, id, fecha, habito))'),
    db.prepare('CREATE TABLE IF NOT EXISTS subs (code TEXT, id TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, ts INTEGER, PRIMARY KEY (code, endpoint))'),
    db.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)'),
  ]);
  esquemaListo = true;
}

async function focus(request, env, url, json, ctx) {
  const db = env.DB;
  if (!db) throw ferr(500, 'Falta enlazar la base de datos (binding DB) al Worker.');
  await esquema(db);
  const q = (sql, ...a) => db.prepare(sql).bind(...a);

  const leerReto = async (code) => {
    const fila = await q('SELECT data FROM retos WHERE code = ?', code).first();
    if (!fila) return null;
    const r = JSON.parse(fila.data);
    // Los hábitos son siempre los actuales (así un cambio de hábitos llega también a los retos ya creados).
    const maxDia = HABITOS.length + 1, metaVieja = Math.round(r.dias * ((r.habitos?.length || HABITOS.length) + 1) * 0.8 / 5) * 5;
    if (r.meta === metaVieja) r.meta = Math.round(r.dias * maxDia * 0.8 / 5) * 5;
    r.meta = Math.min(r.meta, r.dias * maxDia);
    r.habitos = HABITOS;
    const ms = (await q('SELECT id, nombre, emoji, color, unido, token FROM miembros WHERE code = ? ORDER BY rowid', code).all()).results;
    r.miembros = {}; r.tokens = {}; r.marcas = {}; r.fotos = {};
    for (const m of ms) { r.miembros[m.id] = { nombre: m.nombre, emoji: m.emoji, color: m.color, unido: m.unido }; r.tokens[m.id] = m.token; r.marcas[m.id] = {}; }
    const orden = HABITOS.map(h => h.id);
    const mk = (await q('SELECT id, fecha, habito, ts FROM marcas WHERE code = ?', code).all()).results;
    for (const m of mk) {
      if (!r.marcas[m.id] || !orden.includes(m.habito)) continue;
      (r.marcas[m.id][m.fecha] ||= []).push(m.habito);
      ((r.fotos[m.id] ||= {})[m.fecha] ||= {})[m.habito] = m.ts;
    }
    for (const id in r.marcas) for (const f in r.marcas[id]) r.marcas[id][f].sort((a, b) => orden.indexOf(a) - orden.indexOf(b));
    return r;
  };
  const guardarDatos = (code, r) => q('UPDATE retos SET data = ? WHERE code = ?',
    JSON.stringify({ nombre: r.nombre, creado: r.creado, inicio: r.inicio, dias: r.dias, meta: r.meta, habitos: r.habitos, creador: r.creador }), code).run();

  // Claves de notificaciones: se crean solas la primera vez y se guardan en la base.
  const vapid = async () => {
    const f = await q("SELECT v FROM config WHERE k = 'vapid'").first();
    if (f) return JSON.parse(f.v);
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const v = { publicKey: b64u(await crypto.subtle.exportKey('raw', k.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', k.privateKey) };
    await q("INSERT OR IGNORE INTO config (k, v) VALUES ('vapid', ?)", JSON.stringify(v)).run();
    return JSON.parse((await q("SELECT v FROM config WHERE k = 'vapid'").first()).v); // por si otro la creó a la vez
  };
  // Avisa a todos los del reto menos al que ha marcado. Las suscripciones caducadas se borran.
  const avisar = (code, deId, titulo, cuerpo) => ctx?.waitUntil((async () => {
    try {
      const subs = (await q('SELECT endpoint, p256dh, auth FROM subs WHERE code = ? AND id != ?', code, deId).all()).results;
      if (!subs.length) return;
      const v = await vapid();
      const payload = JSON.stringify({ title: titulo, body: cuerpo, tag: code + deId, url: './' });
      await Promise.all(subs.map(async s => {
        try {
          const st = await enviarPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, v);
          if (st === 404 || st === 410) await q('DELETE FROM subs WHERE code = ? AND endpoint = ?', code, s.endpoint).run();
        } catch {}
      }));
    } catch {}
  })());

  const autorizar = async (r, id, token) => {
    if (!r) throw ferr(404, 'Ese reto no existe. Revisa el código.');
    if (!id || !r.tokens?.[id] || r.tokens[id] !== await sha(String(token || ''))) throw ferr(403, 'Este móvil no está identificado en el reto.');
  };
  const nuevoMiembro = async (code, r, body) => {
    const nombre = texto(body.nombre, 20);
    if (!nombre) throw ferr(400, 'Escribe tu nombre.');
    const ids = Object.keys(r.miembros || {});
    if (ids.length >= 20) throw ferr(400, 'El reto ya tiene 20 miembros.');
    if (ids.some(k => r.miembros[k].nombre.toLowerCase() === nombre.toLowerCase())) throw ferr(400, 'Ya hay alguien con ese nombre en el reto.');
    const id = aleatorio(8, 'abcdefghijkmnpqrstuvwxyz23456789');
    const token = aleatorio(32, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789');
    await q('INSERT INTO miembros (code, id, nombre, emoji, color, unido, token) VALUES (?, ?, ?, ?, ?, ?, ?)',
      code, id, nombre, texto(body.emoji, 4) || '🔥', COLORES[ids.length % COLORES.length], hoyMadrid(), await sha(token)).run();
    return { id, token, nombre };
  };
  const fechaValida = (r, f) => {
    if (!esFecha(f)) throw ferr(400, 'Fecha no válida');
    const hoy = hoyMadrid(), fin = sumaDias(r.inicio, r.dias - 1);
    if (f < r.inicio || f > fin) throw ferr(400, 'Ese día no es parte del reto.');
    if (f > hoy) throw ferr(400, 'No puedes marcar días que aún no han llegado.');
    if (f < sumaDias(hoy, -1)) throw ferr(400, 'Solo puedes marcar hoy y ayer.');
  };
  const borrarMiembro = (code, id) => db.batch(['miembros', 'marcas', 'fotos', 'subs'].map(t => q(`DELETE FROM ${t} WHERE code = ? AND id = ?`, code, id)));

  const ruta = url.pathname.replace(/\/+$/, '');
  if (request.method === 'GET' && ruta === '/focus') {
    const code = texto(url.searchParams.get('c'), 12).toUpperCase();
    const r = await leerReto(code);
    if (!r) throw ferr(404, 'Ese reto no existe. Revisa el código.');
    return json(vistaPublica(code, r));
  }
  if (request.method === 'GET' && ruta === '/focus/vapid') return json({ publicKey: (await vapid()).publicKey });
  if (request.method === 'GET' && ruta === '/focus/foto') {
    const code = texto(url.searchParams.get('c'), 12).toUpperCase(), id = url.searchParams.get('m') || '';
    const f = url.searchParams.get('f') || '', h = url.searchParams.get('h') || '';
    if (!/^[A-Z0-9]{4,12}$/.test(code) || !idOk(id) || !esFecha(f) || !HABITOS.some(x => x.id === h)) throw ferr(400, 'Foto no válida');
    const fila = await q('SELECT img FROM fotos WHERE code = ? AND id = ? AND fecha = ? AND habito = ?', code, id, f, h).first();
    if (!fila) throw ferr(404, 'Foto no encontrada');
    const bytes = Uint8Array.from(atob(fila.img), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
  }
  if (request.method !== 'POST') throw ferr(405, 'Método no permitido');
  let body;
  try { body = JSON.parse(await request.text()); } catch { throw ferr(400, 'Petición no válida'); }
  if (!body || typeof body !== 'object') throw ferr(400, 'Petición no válida');
  const code = texto(body.code, 12).toUpperCase();

  if (ruta === '/focus/crear') {
    const inicio = esFecha(body.inicio) ? body.inicio : hoyMadrid();
    const dias = Math.min(60, Math.max(3, parseInt(body.dias) || 21));
    let c;
    for (let i = 0; i < 10; i++) { c = aleatorio(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); if (!(await q('SELECT 1 FROM retos WHERE code = ?', c).first())) break; }
    const r = { nombre: texto(body.reto, 40) || 'Operación Batman', creado: hoyMadrid(), inicio, dias,
      meta: Math.min(dias * (HABITOS.length + 1), Math.max(10, parseInt(body.meta) || Math.round(dias * (HABITOS.length + 1) * 0.8 / 5) * 5)), habitos: HABITOS, miembros: {} };
    await q('INSERT INTO retos (code, data) VALUES (?, ?)', c, '{}').run();
    const yo = await nuevoMiembro(c, r, body);
    r.creador = yo.id;
    await guardarDatos(c, r);
    return json({ code: c, id: yo.id, token: yo.token, reto: vistaPublica(c, await leerReto(c)) });
  }
  if (ruta === '/focus/unirse') {
    const r = await leerReto(code);
    if (!r) throw ferr(404, 'Ese reto no existe. Revisa el código.');
    const yo = await nuevoMiembro(code, r, body);
    avisar(code, yo.id, 'Operación Batman', `${yo.nombre} se ha unido al reto 💪`);
    return json({ code, id: yo.id, token: yo.token, reto: vistaPublica(code, await leerReto(code)) });
  }
  if (ruta === '/focus/cumplir') {
    // Marca un hábito con su foto (JPEG en base64, ya reducida en el móvil).
    const h = String(body.habito || '');
    if (!HABITOS.some(x => x.id === h)) throw ferr(400, 'Hábito no válido');
    const img = String(body.foto || '').replace(/^data:image\/\w+;base64,/, '');
    if (img.length < 2000) throw ferr(400, 'Falta la foto.');
    if (img.length > 1_500_000) throw ferr(400, 'La foto es demasiado grande.');
    if (!/^[A-Za-z0-9+/=]+$/.test(img) || !img.startsWith('/9j/')) throw ferr(400, 'La foto debe ser un JPEG.');
    const r0 = await leerReto(code);
    await autorizar(r0, body.id, body.token);
    fechaValida(r0, body.fecha);
    await db.batch([
      q('INSERT OR REPLACE INTO fotos (code, id, fecha, habito, img) VALUES (?, ?, ?, ?, ?)', code, body.id, body.fecha, h, img),
      q('INSERT OR REPLACE INTO marcas (code, id, fecha, habito, ts) VALUES (?, ?, ?, ?, ?)', code, body.id, body.fecha, h, Date.now()),
    ]);
    const r = await leerReto(code);
    const n = (r.marcas[body.id]?.[body.fecha] || []).length, total = r.habitos.length, nombre = r.miembros[body.id].nombre;
    const hb = HABITOS.find(x => x.id === h);
    if (body.fecha === hoyMadrid()) avisar(code, body.id, n === total ? `🔥 ${nombre}: ¡día perfecto!` : `${hb.emoji} ${nombre}`,
      n === total ? `Ha cumplido los ${total} hábitos de hoy. +1 casilla extra.` : `Ha cumplido ${hb.nombre} (${n}/${total} hoy). ¿Y tú?`);
    return json({ ok: true, reto: vistaPublica(code, r) });
  }
  if (ruta === '/focus/desmarcar') {
    const r0 = await leerReto(code);
    await autorizar(r0, body.id, body.token);
    fechaValida(r0, body.fecha);
    await db.batch(['marcas', 'fotos'].map(t => q(`DELETE FROM ${t} WHERE code = ? AND id = ? AND fecha = ? AND habito = ?`, code, body.id, body.fecha, String(body.habito || ''))));
    return json({ ok: true, reto: vistaPublica(code, await leerReto(code)) });
  }
  if (ruta === '/focus/avisos') {
    // Guarda (o quita) la suscripción de avisos de este móvil. Máximo 3 dispositivos por persona.
    const r = await leerReto(code);
    await autorizar(r, body.id, body.token);
    const s = body.sub;
    const valida = s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.keys?.p256dh && s.keys?.auth;
    if (s?.endpoint) await q('DELETE FROM subs WHERE code = ? AND endpoint = ?', code, String(s.endpoint)).run();
    if (body.activar && valida) {
      await q('INSERT INTO subs (code, id, endpoint, p256dh, auth, ts) VALUES (?, ?, ?, ?, ?, ?)', code, body.id, s.endpoint, String(s.keys.p256dh), String(s.keys.auth), Date.now()).run();
      await q('DELETE FROM subs WHERE code = ? AND id = ? AND endpoint NOT IN (SELECT endpoint FROM subs WHERE code = ? AND id = ? ORDER BY ts DESC LIMIT 3)', code, body.id, code, body.id).run();
    }
    return json({ ok: true });
  }
  if (ruta === '/focus/probar-aviso') {
    const r = await leerReto(code);
    await autorizar(r, body.id, body.token);
    const lista = (await q('SELECT endpoint, p256dh, auth FROM subs WHERE code = ? AND id = ?', code, body.id).all()).results;
    if (!lista.length) throw ferr(400, 'Este móvil no tiene los avisos activados.');
    const v = await vapid();
    const st = await Promise.all(lista.map(s => enviarPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({ title: 'Operación Batman', body: '✅ Los avisos funcionan. ¡A tope!', url: './' }), v).catch(() => 0)));
    return json({ ok: st.some(x => x >= 200 && x < 300), estados: st });
  }
  if (ruta === '/focus/ajustes') {
    const r = await leerReto(code);
    await autorizar(r, body.id, body.token);
    if (body.id !== r.creador) throw ferr(403, 'Solo quien creó el reto puede cambiarlo.');
    if (body.reto) r.nombre = texto(body.reto, 40) || r.nombre;
    if (esFecha(body.inicio)) r.inicio = body.inicio;
    if (body.dias) r.dias = Math.min(60, Math.max(3, parseInt(body.dias) || r.dias));
    if (body.meta) r.meta = Math.min(r.dias * (HABITOS.length + 1), Math.max(10, parseInt(body.meta) || r.meta));
    await guardarDatos(code, r);
    if (body.expulsar && body.expulsar !== r.creador && r.miembros[body.expulsar]) await borrarMiembro(code, body.expulsar);
    return json({ ok: true, reto: vistaPublica(code, await leerReto(code)) });
  }
  if (ruta === '/focus/salir') {
    const r = await leerReto(code);
    await autorizar(r, body.id, body.token);
    if (body.id === r.creador) throw ferr(400, 'Quien creó el reto no puede salir de él.');
    await borrarMiembro(code, body.id);
    return json({ ok: true });
  }
  throw ferr(404, 'Ruta no encontrada');
}
