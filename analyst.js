// analyst.js — Orquesta el ciclo de análisis: BUSCAR → EXTRAER → VALIDAR → PONDERAR → ARMAR → EMITIR
import { detectProvider } from './providers.js';

const SYSTEM_PROMPT = `Eres FIJALAB ✕ QUANT, un analista cuantitativo profesional de apuestas de fútbol.
Tu trabajo: usar la búsqueda web para investigar el partido indicado y emitir un análisis en JSON ESTRICTO.

INVESTIGA (con búsqueda web):
- Forma reciente de ambos equipos (últimos 5 partidos)
- Promedios de goles anotados/recibidos y córners a favor/en contra
- Remates y remates al arco por partido
- Cuotas 1X2 actuales del mercado (casas de apuestas)
- Alineaciones probables, bajas y lesionados
- Contexto: localía, motivación, historial reciente H2H

RESPONDE SOLO CON UN OBJETO JSON VÁLIDO, sin markdown, sin \`\`\`, sin texto antes ni después. Esquema exacto:
{
  "partido": {"local": "...", "visitante": "...", "torneo": "..."},
  "prob": {"local": 0-100, "empate": 0-100, "visitante": 0-100},
  "cuotas": {"local": 0.0, "empate": 0.0, "visitante": 0.0},
  "xg": {"local": 0.0, "visitante": 0.0},
  "picks": [
    {"tipo": "ganador|goles|corners|libre", "mercado": "...", "seleccion": "...", "confianza": 0-100, "cuota": 0.0, "valor": true/false, "riesgo": "bajo|medio|alto", "razon": "1-2 frases con datos"}
  ],
  "combinada": {"patas": [{"seleccion": "...", "mercado": "...", "cuota": 0.0}], "cuota_total": 0.0, "prob_estimada": 0-100},
  "advertencias": ["..."],
  "resumen": "2-3 frases del análisis global"
}

REGLAS INNEGOCIABLES:
1. prob.local + prob.empate + prob.visitante = 100 (aprox).
2. "valor": true SOLO si la cuota de mercado paga MÁS que la cuota justa (cuota_justa = 100/confianza). Si no, false.
3. Exactamente 4 picks: uno de ganador (1X2/doble oportunidad), uno de goles (over/under/BTTS), uno de córners, y uno libre (el de mayor valor que encuentres).
4. "confianza" es TU probabilidad estimada de que el pick acierte. Sé honesto: nada es seguro.
5. La combinada tiene 2-4 patas según el perfil de riesgo del usuario (conservador: 2 patas de baja cuota y alta confianza; balanceado: 2-3 patas; agresivo: 3-4 patas). NUNCA patas contradictorias entre sí (ej: over 2.5 + under 2.5, o gana local + gana visitante).
6. Usa cuotas REALES del mercado encontradas en la búsqueda; si no encuentras cuotas, estímalas y decláralo en advertencias.
7. xg = goles esperados estimados por equipo para ESTE partido según los datos.
8. Si NO encuentras información del partido (no existe, nombres mal escritos, ya se jugó), responde SOLO: {"error": "descripción clara del problema"}.
9. Números con punto decimal, sin símbolos de moneda ni %.`;

function buildUserPrompt({ local, visitante, torneo, perfil }, opts = {}) {
  const hoy = new Date().toLocaleDateString('es-PE', { year: 'numeric', month: 'long', day: 'numeric' });
  const base = `Fecha de hoy: ${hoy}.
Analiza el próximo partido: ${local} vs ${visitante}${torneo ? ` (${torneo})` : ''}.
Perfil de riesgo del usuario: ${perfil}.`;
  if (opts.local) {
    return `${base}
NO tienes acceso a búsqueda web en tiempo real. Estima los datos (forma, goles, córners, cuotas 1X2, xG) con tu conocimiento y modelo probabilístico, y DECLÁRALO en "advertencias" con el texto "DATOS NO EN VIVO: estimados sin búsqueda web". Responde SOLO con el JSON del esquema.`;
  }
  return `${base}
Busca en la web los datos actuales (forma, goles, córners, remates, cuotas 1X2, alineaciones y bajas) y responde SOLO con el JSON del esquema.`;
}

// ---------- Utilidades ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export function extractJson(text) {
  if (!text) throw new Error('El modelo devolvió una respuesta vacía');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No se encontró JSON en la respuesta del modelo');
  const raw = text.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    // Intento de reparación: comas colgantes
    try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); }
    catch { throw new Error('El JSON del modelo es inválido y no se pudo reparar'); }
  }
}

function validate(r) {
  if (r.error) throw new Error(`ANALISTA: ${r.error}`);
  if (!r.partido || !r.prob || !r.xg || !Array.isArray(r.picks) || r.picks.length === 0) {
    throw new Error('Respuesta incompleta del modelo: faltan campos del esquema');
  }
  for (const p of r.picks) {
    if (!p.mercado || !p.seleccion || typeof p.cuota !== 'number' || typeof p.confianza !== 'number') {
      throw new Error('Pick inválido en la respuesta del modelo');
    }
  }
}

// Detección de patas contradictorias en la combinada
export function findContradictions(patas) {
  const issues = [];
  const norm = patas.map(p => (p.mercado + ' ' + p.seleccion).toLowerCase());
  const overs = norm.filter(s => /over|más de|mas de/.test(s));
  const unders = norm.filter(s => /under|menos de/.test(s));
  for (const o of overs) for (const u of unders) {
    const lo = o.match(/(\d+[.,]?\d*)/)?.[1];
    const lu = u.match(/(\d+[.,]?\d*)/)?.[1];
    const sameKind = (/c[oó]rner/.test(o) === /c[oó]rner/.test(u));
    if (lo && lu && sameKind && parseFloat(lo.replace(',', '.')) >= parseFloat(lu.replace(',', '.'))) {
      issues.push(`Patas contradictorias: "${o}" vs "${u}"`);
    }
  }
  const winHome = norm.some(s => /gana .*local|victoria local|^1\b/.test(s));
  const winAway = norm.some(s => /gana .*visita|victoria visita|^2\b/.test(s));
  if (winHome && winAway) issues.push('Patas contradictorias: victoria local y visitante a la vez');
  return issues;
}

const STAKE_PCT = { conservador: 0.01, balanceado: 0.015, agresivo: 0.02 };

// PONDERAR + ARMAR: recalcula EV y "valor" en el servidor, asigna stakes, verifica la combinada
export function postProcess(r, params, banca) {
  // Normalizar probabilidades 1X2
  const P = r.prob;
  const sum = (P.local || 0) + (P.empate || 0) + (P.visitante || 0);
  if (sum > 0 && Math.abs(sum - 100) > 1) {
    P.local = round2(P.local / sum * 100);
    P.empate = round2(P.empate / sum * 100);
    P.visitante = round2(100 - P.local - P.empate);
  }

  const pct = STAKE_PCT[params.perfil] ?? 0.015;
  r.advertencias = Array.isArray(r.advertencias) ? r.advertencias : [];

  for (const p of r.picks) {
    p.confianza = clamp(Number(p.confianza) || 50, 1, 99);
    p.cuota = round2(Math.max(1.01, Number(p.cuota) || 1.5));
    const prob = p.confianza / 100;
    p.cuota_justa = round2(1 / prob);
    p.ev = round2((prob * p.cuota - 1) * 100);        // EV en %
    p.valor = p.cuota > p.cuota_justa;                 // regla dura server-side
    p.stake = round2(banca * pct);
    if (!p.riesgo) p.riesgo = p.confianza >= 70 ? 'bajo' : p.confianza >= 55 ? 'medio' : 'alto';
  }

  if (r.combinada && Array.isArray(r.combinada.patas) && r.combinada.patas.length) {
    const c = r.combinada;
    c.patas = c.patas.map(x => ({ ...x, cuota: round2(Math.max(1.01, Number(x.cuota) || 1.3)) }));
    const prod = c.patas.reduce((m, x) => m * x.cuota, 1);
    c.cuota_total = round2(prod);
    c.prob_estimada = clamp(round2(Number(c.prob_estimada) || (100 / prod) * 0.9), 1, 99);
    c.ev = round2(((c.prob_estimada / 100) * c.cuota_total - 1) * 100);
    c.stake = round2(banca * pct * 0.5); // media unidad para combinadas
    const contra = findContradictions(c.patas);
    if (contra.length) r.advertencias.push(...contra);
    r.contradicciones = contra;
  } else {
    r.combinada = null;
    r.contradicciones = [];
  }

  r.xg.local = round2(clamp(Number(r.xg.local) || 1.2, 0.1, 5));
  r.xg.visitante = round2(clamp(Number(r.xg.visitante) || 1.0, 0.1, 5));
  return r;
}

// ---------- Modo DEMO (sin API key): datos sintéticos verosímiles ----------
function seededRng(seed) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

async function demoAnalysis(params, emit) {
  const rng = seededRng(params.local + '|' + params.visitante);
  const rnd = (a, b, d = 2) => Math.round((a + rng() * (b - a)) * 10 ** d) / 10 ** d;

  emit({ type: 'log', msg: `MODO DEMO — sin API key configurada, generando análisis sintético` });
  emit({ type: 'step', step: 1 }); await sleep(600);
  emit({ type: 'log', msg: `WEB_SEARCH (simulada): forma reciente de ${params.local}` });
  await sleep(500);
  emit({ type: 'log', msg: `WEB_SEARCH (simulada): cuotas 1X2 y córners de ${params.visitante}` });
  emit({ type: 'step', step: 2 }); await sleep(600);

  const pl = rnd(32, 55, 0), pe = rnd(18, 30, 0), pv = Math.max(5, 100 - pl - pe);
  const xgL = rnd(0.9, 2.3), xgV = rnd(0.6, 1.9);
  const cuotaL = round2(clamp(100 / pl * rnd(0.95, 1.15), 1.2, 9));
  const cuotaE = round2(clamp(100 / pe * rnd(0.95, 1.1), 2.8, 5.2));
  const cuotaV = round2(clamp(100 / pv * rnd(0.95, 1.15), 1.3, 12));
  const totalXg = xgL + xgV;
  const overSel = totalXg > 2.4 ? 'Over 2.5 goles' : 'Under 2.5 goles';
  const ganadorSel = pl >= pv ? `Gana ${params.local} o empate (1X)` : `Gana ${params.visitante} o empate (X2)`;
  const cornerLine = rnd(8, 10, 0) + 0.5;

  const result = {
    partido: { local: params.local, visitante: params.visitante, torneo: params.torneo || 'DEMO' },
    prob: { local: pl, empate: pe, visitante: pv },
    cuotas: { local: cuotaL, empate: cuotaE, visitante: cuotaV },
    xg: { local: xgL, visitante: xgV },
    picks: [
      { tipo: 'ganador', mercado: 'Doble oportunidad', seleccion: ganadorSel, confianza: rnd(62, 78, 0), cuota: rnd(1.3, 1.65), riesgo: 'bajo', razon: `Forma reciente favorable y ventaja de localía (xG ${xgL} vs ${xgV}). [DEMO]` },
      { tipo: 'goles', mercado: 'Total de goles', seleccion: overSel, confianza: rnd(55, 70, 0), cuota: rnd(1.7, 2.05), riesgo: 'medio', razon: `xG combinado de ${round2(totalXg)}; promedios de gol sostienen la línea. [DEMO]` },
      { tipo: 'corners', mercado: 'Córners totales', seleccion: `Over ${cornerLine} córners`, confianza: rnd(52, 66, 0), cuota: rnd(1.75, 2.1), riesgo: 'medio', razon: `Ambos equipos promedian volumen alto de córners por partido. [DEMO]` },
      { tipo: 'libre', mercado: 'Ambos marcan', seleccion: rng() > 0.5 ? 'Ambos marcan: Sí' : 'Ambos marcan: No', confianza: rnd(50, 64, 0), cuota: rnd(1.7, 2.15), riesgo: 'medio', razon: `Defensas con fugas recientes en ambos lados. [DEMO]` }
    ],
    combinada: null,
    advertencias: ['MODO DEMO: datos sintéticos, no usar para apostar. Configura una API key en .env'],
    resumen: `Análisis DEMO de ${params.local} vs ${params.visitante}: ligera ventaja ${pl >= pv ? 'local' : 'visitante'} con xG ${xgL}-${xgV}. Datos simulados para probar la interfaz.`
  };
  const nLegs = params.perfil === 'agresivo' ? 3 : 2;
  result.combinada = {
    patas: result.picks.slice(0, nLegs).map(p => ({ seleccion: p.seleccion, mercado: p.mercado, cuota: p.cuota })),
    cuota_total: 0, prob_estimada: 0
  };

  emit({ type: 'step', step: 3 }); await sleep(400);
  emit({ type: 'step', step: 4 }); await sleep(400);
  return { result, meta: { provider: 'demo', label: 'DEMO', model: 'sintético', searches: 4 } };
}

// ---------- Orquestador principal ----------
export async function runAnalysis(params, banca, emit) {
  let provider;
  try { provider = detectProvider(); }
  catch (e) { throw new Error(e.message); }

  let out;
  if (!provider) {
    out = await demoAnalysis(params, emit);
  } else {
    emit({ type: 'step', step: 1 });
    if (provider.local) {
      emit({ type: 'log', msg: `⚠ MOTOR LOCAL: ${provider.label} · ${provider.model} — SIN búsqueda web: datos estimados, NO en vivo` });
    } else {
      emit({ type: 'log', msg: `MOTOR: ${provider.label} · ${provider.model} — lanzando búsqueda web del partido` });
    }
    const t0 = Date.now();
    const heartbeat = setInterval(() => {
      emit({ type: 'tick', elapsed: Math.round((Date.now() - t0) / 1000) });
    }, 2000);
    let text, searches;
    try {
      ({ text, searches } = await provider.call(
        provider.apiKey, provider.model, SYSTEM_PROMPT,
        buildUserPrompt(params, { local: provider.local })
      ));
    } finally {
      clearInterval(heartbeat);
    }
    emit({ type: 'step', step: 2 });
    emit({ type: 'log', msg: `RESPUESTA RECIBIDA en ${Math.round((Date.now() - t0) / 1000)}s · búsquedas web: ${searches || 's/d'}` });

    emit({ type: 'step', step: 3 });
    const parsed = extractJson(text);
    validate(parsed);
    emit({ type: 'log', msg: `JSON validado: ${parsed.picks.length} picks + ${parsed.combinada?.patas?.length || 0} patas de combinada` });
    emit({ type: 'step', step: 4 });
    out = { result: parsed, meta: { provider: provider.name, label: provider.label, model: provider.model, searches } };
  }

  const r = postProcess(out.result, params, banca);
  const conEv = r.picks.filter(p => p.valor).length;
  emit({ type: 'log', msg: `PONDERACIÓN: EV recalculado server-side — ${conEv}/${r.picks.length} picks con +EV real` });
  emit({ type: 'step', step: 5 });
  if (r.contradicciones.length) {
    emit({ type: 'log', msg: `⚠ ALERTA: ${r.contradicciones.length} contradicción(es) detectada(s) en la combinada` });
  }
  return { result: r, meta: out.meta };
}
