// Cotizador Vía Trapenses — servidor web (Node 18+ / Express)
// Sirve el cotizador (public/index.html) y una API JSON para bloqueos, clientes, cotizaciones y valor UF.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '';          // opcional: si se define, los cambios exigen el PIN
const UF_CACHE_MS = 6 * 60 * 60 * 1000;

// ---------- base de datos (archivo JSON) ----------
function emptyDb() { return { seq: 0, blocked: {}, clientes: [], cotizaciones: [] }; }
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
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

function requirePin(req, res, next) {
  if (!ADMIN_PIN) return next();
  if ((req.get('x-pin') || req.query.pin || '') === ADMIN_PIN) return next();
  return res.status(401).json({ error: 'PIN requerido' });
}

// Estado completo para la página
app.get('/api/state', (req, res) => {
  const db = loadDb();
  res.json({
    pinRequired: !!ADMIN_PIN,
    blocked: db.blocked,
    clientes: db.clientes,
    cotizaciones: db.cotizaciones.map(c => ({
      id: c.id, numero: c.numero, creada: c.creada, fecha: c.fecha, unidad: c.unidad, cliente: c.cliente,
      aplica: c.aplica, totales: c.totales, vendedor: c.vendedor, uf: c.uf
    }))
  });
});

// ---------- bloqueos (departamentos vendidos) ----------
app.post('/api/bloqueos', requirePin, (req, res) => {
  const { key, blocked, motivo, unidad } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key requerida' });
  const db = loadDb();
  if (blocked) db.blocked[key] = { fecha: nowIso(), motivo: motivo || 'Vendido', unidad: unidad || null };
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
  if (!c) { c = { id: newId(), creado: nowIso() }; db.clientes.push(c); }
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
    'Creado': fmtDate(c.creado), 'Actualizado': fmtDate(c.actualizado)
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
  const c = Object.assign({}, p, { id: newId(), numero, creada: nowIso() });
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
    'Vendedor': c.vendedor && c.vendedor.nombre
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

// ---------- respaldo ----------
app.get('/api/backup', requirePin, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="via-trapenses-backup-${nowIso().slice(0, 10)}.json"`);
  res.json(loadDb());
});
app.post('/api/restore', requirePin, (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || !Array.isArray(b.clientes) || !Array.isArray(b.cotizaciones)) return res.status(400).json({ error: 'respaldo inválido' });
  saveDb(Object.assign(emptyDb(), b));
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

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

app.listen(PORT, () => console.log(`Cotizador Vía Trapenses escuchando en puerto ${PORT} · datos en ${DATA_DIR}${ADMIN_PIN ? ' · PIN activo' : ''}`));
