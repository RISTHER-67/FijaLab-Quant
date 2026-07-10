// server.js — FIJALAB ✕ QUANT backend (Express + SQLite + IA multi-proveedor)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnalysis, runTournament } from './analyst.js';
import { detectProvider, PROVIDERS } from './providers.js';
import { initDb, saveAnalysis, listAnalyses, settlePick, getStats, getBanca, setSetting } from './db.js';

// Carga .env si existe (soporte nativo de Node 21.7+)
try { process.loadEnvFile('.env'); } catch { /* sin .env, se usan variables del sistema */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config del motor (para el ticker) ---
app.get('/api/config', (req, res) => {
  let provider = null, error = null;
  try { provider = detectProvider(); } catch (e) { error = e.message; }
  res.json({
    demo: !provider,
    provider: provider ? provider.label : 'DEMO',
    model: provider ? provider.model : 'sintético',
    error,
    disponibles: Object.entries(PROVIDERS).map(([k, v]) => ({ id: k, env: v.env, defaultModel: v.defaultModel }))
  });
});

// --- Análisis con Server-Sent Events sobre POST ---
app.post('/api/analyze', async (req, res) => {
  const { local, visitante, torneo, perfil } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    if (!local?.trim() || !visitante?.trim()) throw new Error('Faltan los nombres de los equipos');
    const params = {
      local: local.trim(),
      visitante: visitante.trim(),
      torneo: (torneo || '').trim(),
      perfil: ['conservador', 'balanceado', 'agresivo'].includes(perfil) ? perfil : 'balanceado'
    };
    const banca = await getBanca();
    const { result, meta } = await runAnalysis(params, banca, send);
    const { analysisId, merged, added } = await saveAnalysis(params, result, meta.provider);
    send({ type: 'step', step: 6 });
    send({
      type: 'log',
      msg: merged
        ? `EMITIDO: partido ya analizado antes — fusionado en análisis #${analysisId} (+${added} patas nuevas, sin duplicar)`
        : `EMITIDO: análisis #${analysisId} guardado (${added} patas)`
    });
    send({ type: 'result', data: result, meta, analysisId, banca });
  } catch (e) {
    console.error('[analyze]', e);
    send({ type: 'error', message: e.message || 'Error desconocido en el análisis' });
  } finally {
    res.end();
  }
});

// --- Simulador de torneo (SSE): 1 llamada a IA + Monte Carlo del bracket en el cliente ---
app.post('/api/tournament', async (req, res) => {
  const { equipos, torneo, ronda } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const clean = (Array.isArray(equipos) ? equipos : []).map(s => String(s || '').trim()).filter(Boolean);
    if (clean.length < 2) throw new Error('Se necesitan al menos 2 equipos');
    if (clean.length % 2 !== 0) throw new Error('El número de equipos debe ser par (bracket de eliminación directa)');
    if (new Set(clean.map(s => s.toLowerCase())).size !== clean.length) throw new Error('Hay equipos repetidos en el bracket');
    const params = {
      equipos: clean,
      torneo: (torneo || '').trim(),
      ronda: (ronda || '').trim() || `${clean.length} equipos`
    };
    send({ type: 'step', step: 1 });
    const { data, meta } = await runTournament(params, send);
    send({ type: 'step', step: 2 });
    send({ type: 'tournament', data, meta, params });
  } catch (e) {
    console.error('[tournament]', e);
    send({ type: 'error', message: e.message || 'Error desconocido en la simulación del torneo' });
  } finally {
    res.end();
  }
});

// --- Historial y tracking ---
app.get('/api/history', async (req, res) => {
  try {
    res.json({ analyses: await listAnalyses(60) });
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/picks/:id/result', async (req, res) => {
  try {
    const pick = await settlePick(Number(req.params.id), String(req.body?.estado || '').toUpperCase());
    res.json({ ok: true, pick });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    res.json(await getStats());
  } catch (e) {
    console.error('[stats]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  res.json({ banca: await getBanca() });
});

app.post('/api/settings', async (req, res) => {
  const banca = Number(req.body?.banca);
  if (!Number.isFinite(banca) || banca <= 0) return res.status(400).json({ ok: false, error: 'Banca inválida' });
  await setSetting('banca', banca);
  res.json({ ok: true, banca });
});

const PORT = Number(process.env.PORT) || 4577;

// Conecta y crea las tablas en Supabase ANTES de escuchar. Si falla, no arranca.
try {
  await initDb();
  console.log('DB Postgres/Supabase lista (tablas verificadas)');
} catch (e) {
  console.error(`\n[!] No se pudo conectar a la base de datos: ${e.message}`);
  console.error('    Revisa DATABASE_URL en tu .env (cadena del "Session pooler" de Supabase).\n');
  process.exit(1);
}

const srv = app.listen(PORT, () => {
  let modo = 'DEMO (sin API key)';
  try {
    const p = detectProvider();
    if (p) modo = `${p.label} · ${p.model}`;
  } catch (e) { modo = `ERROR CONFIG: ${e.message}`; }
  console.log(`\nFIJALAB ✕ QUANT ► http://localhost:${PORT}  |  motor: ${modo}\n`);
});

srv.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] El puerto ${PORT} ya está en uso. Otra copia del servidor sigue corriendo.`);
    console.error(`    Opciones:`);
    console.error(`      • Usa otro puerto:  PORT=4578 npm start   (PowerShell: $env:PORT=4578; npm start)`);
    console.error(`      • O libera el ${PORT}:  npx kill-port ${PORT}   (o cierra la ventana/terminal anterior)\n`);
    process.exit(1);
  }
  throw err;
});
