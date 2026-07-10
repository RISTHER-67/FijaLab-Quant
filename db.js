// db.js — Postgres (Supabase) vía node-postgres. Todas las funciones son ASYNC.
// La conexión se toma de DATABASE_URL (cadena del "Session pooler" de Supabase).
import pg from 'pg';

const { Pool } = pg;

let pool = null;

// Pool perezoso: se crea en el primer uso, cuando el .env ya fue cargado por server.js.
export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'Falta DATABASE_URL en el entorno (.env). Copia la connection string del ' +
        '"Session pooler" de Supabase (Connect → Session pooler).'
      );
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // Supabase exige TLS
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
  }
  return pool;
}

const q = (text, params) => getPool().query(text, params);

// Crea las tablas si no existen. server.js la llama (await) antes de escuchar.
export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS analyses (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      local       TEXT NOT NULL,
      visitante   TEXT NOT NULL,
      torneo      TEXT,
      perfil      TEXT,
      proveedor   TEXT,
      resumen     TEXT,
      json        TEXT NOT NULL
    )
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS picks (
      id          SERIAL PRIMARY KEY,
      analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      tipo        TEXT NOT NULL,            -- PICK | COMBI
      mercado     TEXT NOT NULL,
      seleccion   TEXT NOT NULL,
      cuota       REAL NOT NULL,
      confianza   REAL,
      ev          REAL,
      valor       INTEGER DEFAULT 0,
      riesgo      TEXT,
      razon       TEXT,
      stake       REAL DEFAULT 0,
      estado      TEXT NOT NULL DEFAULT 'PENDIENTE',  -- PENDIENTE | GANADA | PERDIDA | NULA
      settled_at  TIMESTAMPTZ
    )
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

export async function getSetting(key, fallback = null) {
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

export async function getBanca() {
  return Number(await getSetting('banca', '500'));
}

// Normaliza un nombre de equipo para comparar (sin acentos, minúsculas)
const normTeam = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Guarda un análisis. Si el MISMO partido ya fue analizado hace poco (≤7 días, en
// cualquier orden de equipos), NO crea otra fila: fusiona — agrega solo las patas
// NUEVAS (selección no repetida) y refresca resumen/json. Todo en una transacción.
export async function saveAnalysis(params, result, proveedor) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // ¿Existe ya este partido reciente? (equipos en cualquier orden)
    const a = normTeam(params.local), b = normTeam(params.visitante);
    const recent = await client.query(
      `SELECT id, local, visitante FROM analyses
       WHERE created_at >= now() - interval '7 days'
       ORDER BY id DESC LIMIT 40`
    );
    let existingId = null;
    for (const r of recent.rows) {
      const x = normTeam(r.local), y = normTeam(r.visitante);
      if ((x === a && y === b) || (x === b && y === a)) { existingId = r.id; break; }
    }

    let analysisId, merged = false, added = 0;
    let existingSels = new Set();
    if (existingId != null) {
      analysisId = existingId;
      merged = true;
      await client.query(
        'UPDATE analyses SET resumen = $1, json = $2, proveedor = $3, perfil = $4 WHERE id = $5',
        [result.resumen || '', JSON.stringify(result), proveedor || 'demo', params.perfil || 'balanceado', analysisId]
      );
      const ex = await client.query('SELECT seleccion FROM picks WHERE analysis_id = $1', [analysisId]);
      existingSels = new Set(ex.rows.map(r => normTeam(r.seleccion)));
    } else {
      const ins = await client.query(
        `INSERT INTO analyses (local, visitante, torneo, perfil, proveedor, resumen, json)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [params.local, params.visitante, params.torneo || '', params.perfil || 'balanceado',
          proveedor || 'demo', result.resumen || '', JSON.stringify(result)]
      );
      analysisId = ins.rows[0].id;
    }

    const pickIds = [];
    const addPick = async (tipo, mercado, seleccion, cuota, conf, ev, valor, riesgo, razon) => {
      const key = normTeam(seleccion);
      if (existingSels.has(key)) return;       // pata repetida => no se duplica
      existingSels.add(key);
      const r = await client.query(
        `INSERT INTO picks (analysis_id, tipo, mercado, seleccion, cuota, confianza, ev, valor, riesgo, razon, stake)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0) RETURNING id`,
        [analysisId, tipo, mercado, seleccion, cuota, conf, ev, valor, riesgo, razon]
      );
      pickIds.push(r.rows[0].id);
      added++;
    };
    for (const p of result.picks || []) {
      await addPick('PICK', p.mercado, p.seleccion, p.cuota, p.confianza,
        p.ev ?? null, p.valor ? 1 : 0, p.riesgo || '', p.razon || '');
    }
    if (result.combinada && Array.isArray(result.combinada.patas) && result.combinada.patas.length) {
      const c = result.combinada;
      const sel = c.patas.map(x => x.seleccion).join(' + ');
      await addPick('COMBI', 'COMBINADA', sel, c.cuota_total, c.prob_estimada ?? null, c.ev ?? null, 0, 'alto', '');
    }

    await client.query('COMMIT');
    return { analysisId, pickIds, merged, added };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listAnalyses(limit = 50) {
  const { rows: analyses } = await q(
    `SELECT id, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
            local, visitante, torneo, perfil, proveedor, resumen
     FROM analyses ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  if (!analyses.length) return [];
  const ids = analyses.map(a => a.id);
  const { rows: picks } = await q(
    'SELECT * FROM picks WHERE analysis_id = ANY($1) ORDER BY id',
    [ids]
  );
  const byA = new Map(analyses.map(a => [a.id, { ...a, picks: [] }]));
  for (const p of picks) byA.get(p.analysis_id)?.picks.push(p);
  return analyses.map(a => byA.get(a.id));
}

export async function settlePick(pickId, estado) {
  const valid = ['GANADA', 'PERDIDA', 'NULA', 'PENDIENTE'];
  if (!valid.includes(estado)) throw new Error('Estado inválido');
  const settledAt = estado === 'PENDIENTE' ? null : new Date().toISOString();
  const r = await q('UPDATE picks SET estado = $1, settled_at = $2 WHERE id = $3', [estado, settledAt, pickId]);
  if (r.rowCount === 0) throw new Error('Pick no encontrado');
  const { rows } = await q('SELECT * FROM picks WHERE id = $1', [pickId]);
  return rows[0];
}

export function categorizeMercado(p) {
  if (p.tipo === 'COMBI') return 'COMBINADA';
  const m = (p.mercado + ' ' + p.seleccion).toLowerCase();
  if (/c[oó]rner|corner|esquina/.test(m)) return 'CÓRNERS';
  if (/goleador|anotador|anota en cualquier|primer gol|marca primero/.test(m)) return 'ANOTADOR';
  if (/tiro|remate|disparo|shot/.test(m)) return 'TIROS';
  if (/gol|over|under|total|ambos|btts|marcan/.test(m)) return 'GOLES';
  if (/ganador|1x2|resultado|gana|victoria|doble oportunidad|empate|hándicap|handicap/.test(m)) return 'GANADOR';
  return 'OTROS';
}

// Calibración: compara la confianza declarada por el modelo con el winrate REAL
// por tramo de confianza. factor < 1 => el modelo sobreestima; > 1 => subestima.
export async function getCalibration() {
  const { rows } = await q(
    `SELECT confianza, estado FROM picks
     WHERE tipo = 'PICK' AND estado IN ('GANADA','PERDIDA') AND confianza IS NOT NULL`
  );
  const mk = (min, max) => ({ min, max, n: 0, wins: 0, confSum: 0, factor: null });
  const buckets = [mk(0, 55), mk(55, 65), mk(65, 75), mk(75, 101)];
  let n = 0, wins = 0, confSum = 0;
  for (const r of rows) {
    const c = Number(r.confianza);
    if (!Number.isFinite(c)) continue;
    const b = buckets.find(b => c >= b.min && c < b.max);
    if (!b) continue;
    b.n++; b.confSum += c;
    n++; confSum += c;
    if (r.estado === 'GANADA') { b.wins++; wins++; }
  }
  const factorOf = (w, cnt, cSum, minN) => {
    if (cnt < minN) return null;
    const actual = (w + 1) / (cnt + 2);            // suavizado de Laplace
    const expected = (cSum / cnt) / 100;
    if (expected <= 0) return null;
    return Math.round(Math.min(1.15, Math.max(0.55, actual / expected)) * 100) / 100;
  };
  for (const b of buckets) b.factor = factorOf(b.wins, b.n, b.confSum, 8);
  return { total: n, global: factorOf(wins, n, confSum, 15), buckets };
}

// Estadísticas de PRECISIÓN del bot (sin dinero): el historial existe para
// registrar aciertos por pata y alimentar la calibración, no para contabilidad.
export async function getStats() {
  const { rows: settled } = await q(
    `SELECT * FROM picks WHERE estado IN ('GANADA','PERDIDA','NULA')
     ORDER BY settled_at ASC NULLS FIRST, id ASC`
  );

  const won = settled.filter(p => p.estado === 'GANADA');
  const lost = settled.filter(p => p.estado === 'PERDIDA');
  const decided = won.length + lost.length;

  // Racha actual (ignora nulas)
  let streak = { type: null, count: 0 };
  const chrono = settled.filter(p => p.estado !== 'NULA').reverse();
  for (const p of chrono) {
    if (streak.type === null) { streak = { type: p.estado, count: 1 }; }
    else if (p.estado === streak.type) streak.count++;
    else break;
  }

  // Precisión por mercado (córners vs remates vs goles…)
  const byMarket = {};
  for (const p of settled) {
    const cat = categorizeMercado(p);
    if (!byMarket[cat]) byMarket[cat] = { mercado: cat, total: 0, ganadas: 0, perdidas: 0, nulas: 0 };
    const b = byMarket[cat];
    b.total++;
    if (p.estado === 'GANADA') b.ganadas++;
    else if (p.estado === 'PERDIDA') b.perdidas++;
    else b.nulas++;
  }
  for (const b of Object.values(byMarket)) {
    const d = b.ganadas + b.perdidas;
    b.winrate = d ? Math.round((b.ganadas / d) * 1000) / 10 : null;
  }

  const pendRes = await q(`SELECT COUNT(*)::int AS n FROM picks WHERE estado = 'PENDIENTE'`);
  const pending = pendRes.rows[0].n;

  return {
    settled: settled.length,
    pending,
    won: won.length,
    lost: lost.length,
    voided: settled.length - decided,
    winrate: decided ? Math.round((won.length / decided) * 1000) / 10 : null,
    streak,
    byMarket: Object.values(byMarket).sort((a, b) => b.total - a.total),
    calibracion: await getCalibration()
  };
}

// Borra TODO el historial (para empezar limpio). No toca settings.
export async function clearHistory() {
  await q('TRUNCATE picks, analyses RESTART IDENTITY CASCADE');
}
