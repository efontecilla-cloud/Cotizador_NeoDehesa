// Cotizador Vía Trapenses — servidor web (Node 18+ / Express)
// Sirve el cotizador (public/index.html) y una API JSON para bloqueos, clientes, cotizaciones y valor UF.
// Acceso con usuario y contraseña (cookie de sesión). Roles: 'vendedor' (solo cotizador) y 'admin' (cotizador + administración).
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '';          // opcional: si se define, los cambios exigen además el PIN
const UF_CACHE_MS = 6 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;      // una sesión caduca tras 30 días sin uso
const ONLINE_MS = 10 * 60 * 1000;                      // "en línea" = actividad en los últimos 10 minutos
const COOKIE = 'vt_sesion';

// ---------- usuarios ----------
// Las contraseñas NO están en el código: cada usuario la lee de una variable de entorno (claveEnv),
// que se define en Render (Environment). Alternativa: la variable USERS con un JSON [{ usuario, clave, rol, nombre, fono, email }].
const DEFAULT_USERS = [
  { usuario: 'Leonor',   claveEnv: 'CLAVE_LEONOR',   rol: 'vendedor', nombre: 'Leonor Olavarria', fono: '+56 9 8150 4390', email: 'Lolavarria@ivitalia.cl' },
  { usuario: 'Exequiel', claveEnv: 'CLAVE_EXEQUIEL', rol: 'admin',    nombre: 'Exequiel',         fono: '',                email: '' }
];
const USERS = (() => {
  if (process.env.USERS) {
    try { const u = JSON.parse(process.env.USERS); if (Array.isArray(u) && u.length) return u; }
    catch (e) { console.error('USERS inválido (se usan los usuarios por defecto):', e.message); }
  }
  return DEFAULT_USERS.map(u => Object.assign({}, u, { clave: process.env[u.claveEnv] || '' }));
})();
USERS.filter(u => !u.clave).forEach(u => console.warn(`AVISO: el usuario ${u.usuario} no tiene contraseña configurada${u.claveEnv ? ' (variable ' + u.claveEnv + ')' : ''}; no podrá ingresar.`));
const findUser = name => USERS.find(u => u.clave && u.usuario.toLowerCase() === String(name || '').trim().toLowerCase());
const publicUser = u => u ? { usuario: u.usuario, rol: u.rol, nombre: u.nombre || u.usuario, fono: u.fono || '', email: u.email || '' } : null;
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- base de datos (archivo JSON) ----------
function emptyDb() { return { seq: 0, blocked: {}, clientes: [], cotizaciones: [], sesiones: {}, accesos: [] }; }
function loadDb() {
  try { return Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { return emptyDb(); }
}
function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);                              // Render está detrás de un proxy https
app.use(express.json({ limit: '2mb' }));

// ---------- sesiones (cookie) ----------
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSessionCookie(req, res, token, clear) {
  const parts = [`${COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${clear ? 0 : Math.floor(SESSION_IDLE_MS / 1000)}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function purgeSessions(db) {
  const limit = Date.now() - SESSION_IDLE_MS; let changed = false;
  for (const [t, s] of Object.entries(db.sesiones)) { if (new Date(s.ultimo || s.creada).getTime() < limit) { delete db.sesiones[t]; changed = true; } }
  return changed;
}
// Identifica al usuario de la sesión (si la hay) y registra su última actividad (como máximo una vez por minuto).
app.use((req, res, next) => {
  req.user = null;
  const token = getCookie(req, COOKIE);
  if (!token) return next();
  const db = loadDb();
  const s = db.sesiones[token];
  if (!s || new Date(s.ultimo || s.creada).getTime() < Date.now() - SESSION_IDLE_MS) { setSessionCookie(req, res, '', true); return next(); }
  const u = findUser(s.usuario);
  if (!u) { delete db.sesiones[token]; saveDb(db); setSessionCookie(req, res, '', true); return next(); }
  req.user = u; req.sessionToken = token;
  if (Date.now() - new Date(s.ultimo || 0).getTime() > 60 * 1000) { s.ultimo = nowIso(); saveDb(db); }
  next();
});

// Intentos fallidos por IP: 8 fallos seguidos → 10 minutos de espera
const loginFails = {};
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'x';
  const f = loginFails[ip] || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const { usuario, clave } = req.body || {};
  const u = findUser(usuario);
  if (!u || !safeEq(u.clave, clave || '')) {
    f.n += 1; if (f.n >= 8) { f.n = 0; f.until = Date.now() + 10 * 60 * 1000; } loginFails[ip] = f;
    const db = loadDb(); db.accesos.unshift({ usuario: String(usuario || '').slice(0, 40), fecha: nowIso(), ok: false }); db.accesos = db.accesos.slice(0, 200); saveDb(db);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  delete loginFails[ip];
  const db = loadDb();
  purgeSessions(db);
  const token = crypto.randomBytes(24).toString('hex');
  db.sesiones[token] = { usuario: u.usuario, creada: nowIso(), ultimo: nowIso(), ua: String(req.get('user-agent') || '').slice(0, 120) };
  db.accesos.unshift({ usuario: u.usuario, fecha: nowIso(), ok: true }); db.accesos = db.accesos.slice(0, 200);
  saveDb(db);
  setSessionCookie(req, res, token);
  res.json(publicUser(u));
});
app.post('/api/logout', (req, res) => {
  if (req.sessionToken) { const db = loadDb(); delete db.sesiones[req.sessionToken]; saveDb(db); }
  setSessionCookie(req, res, '', true);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => req.user ? res.json(publicUser(req.user)) : res.status(401).json({ error: 'login' }));
app.get('/healthz', (req, res) => res.send('ok'));

// A partir de aquí todo exige sesión: la página principal redirige al login; la API responde 401 {error:'login'}.
app.get(['/', '/index.html'], (req, res, next) => req.user ? next() : res.redirect('/login.html'));
app.use('/api', (req, res, next) => req.user ? next() : res.status(401).json({ error: 'login' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

function requirePin(req, res, next) {
  if (!ADMIN_PIN) return next();
  if ((req.get('x-pin') || req.query.pin || '') === ADMIN_PIN) return next();
  return res.status(401).json({ error: 'PIN requerido' });
}
function requireAdmin(req, res, next) {
  if (req.user && req.user.rol === 'admin') return next();
  return res.status(403).json({ error: 'Solo el administrador puede ver esta información' });
}

// Estado completo para la página
app.get('/api/state', (req, res) => {
  const db = loadDb();
  res.json({
    user: publicUser(req.user),
    pinRequired: !!ADMIN_PIN,
    blocked: db.blocked,
    clientes: db.clientes,
    cotizaciones: db.cotizaciones.map(c => ({
      id: c.id, numero: c.numero, creada: c.creada, fecha: c.fecha, unidad: c.unidad, cliente: c.cliente,
      aplica: c.aplica, totales: c.totales, vendedor: c.vendedor, uf: c.uf, usuario: c.usuario
    }))
  });
});

// ---------- administración (solo rol admin) ----------
app.get('/api/admin/usuarios', requireAdmin, (req, res) => {
  const db = loadDb();
  if (purgeSessions(db)) saveDb(db);
  const now = Date.now();
  const usuarios = USERS.map(u => {
    const ses = Object.values(db.sesiones).filter(s => s.usuario === u.usuario);
    const ultimo = ses.reduce((m, s) => Math.max(m, new Date(s.ultimo || s.creada).getTime()), 0);
    const ingreso = db.accesos.find(a => a.ok && a.usuario === u.usuario);
    return Object.assign(publicUser(u), {
      sesiones: ses.length,
      enLinea: ultimo > now - ONLINE_MS,
      ultimaActividad: ultimo ? new Date(ultimo).toISOString() : null,
      ultimoIngreso: ingreso ? ingreso.fecha : null,
      esteUsuario: u.usuario === req.user.usuario
    });
  });
  res.json({ usuarios, accesos: db.accesos.slice(0, 30) });
});

// ---------- bloqueos (departamentos vendidos) ----------
app.post('/api/bloqueos', requirePin, (req, res) => {
  const { key, blocked, motivo, unidad } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key requerida' });
  const db = loadDb();
  if (blocked) db.blocked[key] = { fecha: nowIso(), motivo: motivo || 'Vendido', unidad: unidad || null, usuario: req.user.usuario };
  else delete db.blocked[key];
  saveDb(db);
  res.json({ ok: true, blocked: db.blocked });
});

// ---------- clientes ----------
app.get('/api/clientes', (req, res) => res.json(loadDb().clientes));
app.post('/api/clientes', requirePin, (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'nombre requerido' });
  const db = loadDb();
  let c = b.id ? db.clientes.find(x => x.id === b.id) : null;
  if (!c) { c = { id: newId(), creado: nowIso(), usuario: req.user.usuario }; db.clientes.push(c); }
  Object.assign(c, { nombre: String(b.nombre).trim(), rut: String(b.rut || '').trim(), contacto: String(b.contacto || '').trim(), notas: String(b.notas || '').trim(), actualizado: nowIso() });
  saveDb(db);
  res.json(c);
});
app.delete('/api/clientes/:id', requirePin, (req, res) => {
  const db = loadDb();
  db.clientes = db.clientes.filter(c => c.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});
app.get('/api/clientes.xlsx', (req, res) => {
  const db = loadDb();
  const cotPorCliente = {};
  db.cotizaciones.forEach(c => { const k = (c.cliente && c.cliente.id) || ((c.cliente && c.cliente.nombre) || '').toLowerCase(); cotPorCliente[k] = (cotPorCliente[k] || 0) + 1; });
  const rows = db.clientes.map(c => ({
    'Nombre': c.nombre, 'RUT': c.rut, 'Contacto': c.contacto, 'Notas': c.notas,
    'Cotizaciones': cotPorCliente[c.id] || cotPorCliente[(c.nombre || '').toLowerCase()] || 0,
    'Creado': fmtDate(c.creado), 'Actualizado': fmtDate(c.actualizado), 'Registrado por': c.usuario || ''
  }));
  sendXlsx(res, rows, 'Clientes', 'Clientes Via Trapenses');
});

// ---------- cotizaciones ----------
app.get('/api/cotizaciones', (req, res) => res.json(loadDb().cotizaciones));
app.get('/api/cotizaciones/:id', (req, res) => {
  const c = loadDb().cotizaciones.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'no encontrada' });
  res.json(c);
});
app.post('/api/cotizaciones', requirePin, (req, res) => {
  const p = req.body || {};
  if (!p.unidad || !p.unidad.key) return res.status(400).json({ error: 'unidad requerida' });
  const db = loadDb();
  if (db.blocked[p.unidad.key]) return res.status(409).json({ error: 'La unidad está marcada como vendida' });
  db.seq += 1;
  const ymd = String(p.fecha || nowIso().slice(0, 10)).replace(/-/g, '');
  const numero = `VT-${ymd}-${String(db.seq).padStart(4, '0')}`;
  const c = Object.assign({}, p, { id: newId(), numero, creada: nowIso(), usuario: req.user.usuario });
  db.cotizaciones.push(c);
  saveDb(db);
  res.json({ ok: true, id: c.id, numero });
});
app.get('/api/cotizaciones.xlsx', (req, res) => {
  const db = loadDb();
  const rows = db.cotizaciones.map(c => ({
    'N°': c.numero, 'Fecha': c.fecha, 'Emitida': fmtDate(c.creada),
    'Unidad': c.unidad && c.unidad.label, 'Piso': c.unidad && c.unidad.piso, 'Tipología': c.unidad && c.unidad.tipologia, 'Orientación': c.unidad && c.unidad.orientacion,
    'Cliente': c.cliente && c.cliente.nombre, 'RUT': c.cliente && c.cliente.rut, 'Contacto': c.cliente && c.cliente.contacto,
    'Con descuento': c.aplica ? 'Sí' : 'No',
    'Precio lista UF': c.totales && c.totales.lista, 'Descuento UF': c.totales && c.totales.descuento, 'Total UF': c.totales && c.totales.total,
    'Valor UF': c.uf || '', 'Total $': (c.uf && c.totales) ? Math.round(c.totales.total * c.uf) : '',
    'Estacionamientos': c.nEst || 0, 'Bodegas': c.nBod || 0,
    'Pie contado %': c.pay && c.pay.pie1, 'Pie cuotas %': c.pay && c.pay.pie2, 'N° cuotas': c.pay && c.pay.cuotas, 'Crédito %': c.pay && c.pay.credito,
    'Vendedor': c.vendedor && c.vendedor.nombre, 'Usuario': c.usuario || ''
  }));
  sendXlsx(res, rows, 'Cotizaciones', 'Cotizaciones Via Trapenses');
});

// ---------- valor UF (mindicador.cl, con caché) ----------
let ufCache = { at: 0, data: null };
app.get('/api/uf', async (req, res) => {
  if (ufCache.data && Date.now() - ufCache.at < UF_CACHE_MS) return res.json(ufCache.data);
  try {
    const r = await fetch('https://mindicador.cl/api/uf', { headers: { 'accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const s = (j.serie && j.serie[0]) || null;
    if (!s) throw new Error('sin serie');
    ufCache = { at: Date.now(), data: { valor: s.valor, fecha: String(s.fecha).slice(0, 10), fuente: 'mindicador.cl' } };
    res.json(ufCache.data);
  } catch (e) {
    if (ufCache.data) return res.json(Object.assign({ stale: true }, ufCache.data));
    res.status(502).json({ error: 'No se pudo obtener la UF: ' + e.message });
  }
});

// ---------- respaldo (solo admin) ----------
app.get('/api/backup', requireAdmin, requirePin, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="via-trapenses-backup-${nowIso().slice(0, 10)}.json"`);
  res.json(loadDb());
});
app.post('/api/restore', requireAdmin, requirePin, (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || !Array.isArray(b.clientes) || !Array.isArray(b.cotizaciones)) return res.status(400).json({ error: 'respaldo inválido' });
  const db = Object.assign(emptyDb(), b);
  db.sesiones = loadDb().sesiones;                      // las sesiones abiertas se conservan
  saveDb(db);
  res.json({ ok: true });
});

// ---------- utilidades ----------
function fmtDate(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) : ''; }
function sendXlsx(res, rows, sheet, filename) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Sin datos': '' }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename} ${nowIso().slice(0, 10)}.xlsx"`);
  res.send(buf);
}

app.listen(PORT, () => console.log(`Cotizador Vía Trapenses escuchando en puerto ${PORT} · datos en ${DATA_DIR} · ${USERS.length} usuarios${ADMIN_PIN ? ' · PIN activo' : ''}`));
