// db.js — SQLite nativo de Node (node:sqlite), sin dependencias externas
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'fijalab.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    local TEXT NOT NULL,
    visitante TEXT NOT NULL,
    torneo TEXT,
    perfil TEXT,
    proveedor TEXT,
    resumen TEXT,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,            -- PICK | COMBI
    mercado TEXT NOT NULL,
    seleccion TEXT NOT NULL,
    cuota REAL NOT NULL,
    confianza REAL,
    ev REAL,
    valor INTEGER DEFAULT 0,
    riesgo TEXT,
    razon TEXT,
    stake REAL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'PENDIENTE',  -- PENDIENTE | GANADA | PERDIDA | NULA
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function getBanca() {
  return Number(getSetting('banca', '500'));
}

export function saveAnalysis(params, result, proveedor) {
  const info = db.prepare(
    'INSERT INTO analyses (local, visitante, torneo, perfil, proveedor, resumen, json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    params.local, params.visitante, params.torneo || '', params.perfil || 'balanceado',
    proveedor || 'demo', result.resumen || '', JSON.stringify(result)
  );
  const analysisId = Number(info.lastInsertRowid);

  const ins = db.prepare(`
    INSERT INTO picks (analysis_id, tipo, mercado, seleccion, cuota, confianza, ev, valor, riesgo, razon, stake)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pickIds = [];
  for (const p of result.picks || []) {
    const r = ins.run(analysisId, 'PICK', p.mercado, p.seleccion, p.cuota, p.confianza,
      p.ev ?? null, p.valor ? 1 : 0, p.riesgo || '', p.razon || '', p.stake ?? 0);
    pickIds.push(Number(r.lastInsertRowid));
  }
  if (result.combinada && Array.isArray(result.combinada.patas) && result.combinada.patas.length) {
    const c = result.combinada;
    const sel = c.patas.map(x => x.seleccion).join(' + ');
    const r = ins.run(analysisId, 'COMBI', 'COMBINADA', sel, c.cuota_total,
      c.prob_estimada ?? null, c.ev ?? null, 0, 'alto', '', c.stake ?? 0);
    pickIds.push(Number(r.lastInsertRowid));
  }
  return { analysisId, pickIds };
}

export function listAnalyses(limit = 50) {
  const rows = db.prepare('SELECT * FROM analyses ORDER BY id DESC LIMIT ?').all(limit);
  const pickStmt = db.prepare('SELECT * FROM picks WHERE analysis_id = ? ORDER BY id');
  return rows.map(a => ({ ...a, json: undefined, picks: pickStmt.all(a.id) }));
}

export function settlePick(pickId, estado) {
  const valid = ['GANADA', 'PERDIDA', 'NULA', 'PENDIENTE'];
  if (!valid.includes(estado)) throw new Error('Estado inválido');
  const settledAt = estado === 'PENDIENTE' ? null : new Date().toISOString();
  const r = db.prepare('UPDATE picks SET estado = ?, settled_at = ? WHERE id = ?')
    .run(estado, settledAt, pickId);
  if (r.changes === 0) throw new Error('Pick no encontrado');
  return db.prepare('SELECT * FROM picks WHERE id = ?').get(pickId);
}

function profitOf(p) {
  if (p.estado === 'GANADA') return p.stake * (p.cuota - 1);
  if (p.estado === 'PERDIDA') return -p.stake;
  return 0;
}

export function categorizeMercado(p) {
  if (p.tipo === 'COMBI') return 'COMBINADA';
  const m = (p.mercado + ' ' + p.seleccion).toLowerCase();
  if (/c[oó]rner|corner|esquina/.test(m)) return 'CÓRNERS';
  if (/gol|over|under|total|ambos|btts|marcan/.test(m)) return 'GOLES';
  if (/ganador|1x2|resultado|gana|victoria|doble oportunidad|empate|hándicap|handicap/.test(m)) return 'GANADOR';
  return 'OTROS';
}

export function getStats() {
  const banca = getBanca();
  const settled = db.prepare(`
    SELECT * FROM picks WHERE estado IN ('GANADA','PERDIDA','NULA') ORDER BY settled_at ASC, id ASC
  `).all();

  const won = settled.filter(p => p.estado === 'GANADA');
  const lost = settled.filter(p => p.estado === 'PERDIDA');
  const decided = won.length + lost.length;
  const staked = settled.reduce((s, p) => s + (p.estado === 'NULA' ? 0 : p.stake), 0);
  const profit = settled.reduce((s, p) => s + profitOf(p), 0);

  // Racha actual (ignora nulas)
  let streak = { type: null, count: 0 };
  const chrono = settled.filter(p => p.estado !== 'NULA').reverse();
  for (const p of chrono) {
    if (streak.type === null) { streak = { type: p.estado, count: 1 }; }
    else if (p.estado === streak.type) streak.count++;
    else break;
  }

  // Curva de equity
  let eq = banca;
  const equity = [{ x: 0, y: banca, label: 'INICIO' }];
  settled.forEach((p, i) => {
    eq += profitOf(p);
    equity.push({ x: i + 1, y: Math.round(eq * 100) / 100, label: p.seleccion });
  });

  // Rendimiento por mercado
  const byMarket = {};
  for (const p of settled) {
    const cat = categorizeMercado(p);
    if (!byMarket[cat]) byMarket[cat] = { mercado: cat, total: 0, ganadas: 0, perdidas: 0, nulas: 0, profit: 0 };
    const b = byMarket[cat];
    b.total++;
    if (p.estado === 'GANADA') b.ganadas++;
    else if (p.estado === 'PERDIDA') b.perdidas++;
    else b.nulas++;
    b.profit = Math.round((b.profit + profitOf(p)) * 100) / 100;
  }
  for (const b of Object.values(byMarket)) {
    const d = b.ganadas + b.perdidas;
    b.winrate = d ? Math.round((b.ganadas / d) * 1000) / 10 : null;
  }

  const pending = db.prepare(`SELECT COUNT(*) AS n FROM picks WHERE estado = 'PENDIENTE'`).get().n;

  return {
    banca,
    settled: settled.length,
    pending,
    won: won.length,
    lost: lost.length,
    voided: settled.length - decided,
    winrate: decided ? Math.round((won.length / decided) * 1000) / 10 : null,
    roi: staked > 0 ? Math.round((profit / staked) * 1000) / 10 : null,
    profit: Math.round(profit * 100) / 100,
    streak,
    equity,
    byMarket: Object.values(byMarket).sort((a, b) => b.total - a.total)
  };
}
