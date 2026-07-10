// analyst.js — Orquesta el ciclo de análisis: BUSCAR → EXTRAER → VALIDAR → PONDERAR → ARMAR → EMITIR
import { detectProvider } from './providers.js';
import { getCalibration } from './db.js';
import {
  round2, clamp, stripAcc,
  poissonGrid, marketProbs, derivePickProb, calibFactor,
  kellyStake, buildCombinada, computeConfidenceIndex, ratesFromAverages, computeFormaStats
} from './quant.js';

const SYSTEM_PROMPT = `Eres FIJALAB ✕ QUANT, un analista cuantitativo profesional de apuestas de fútbol.
Tu trabajo: usar la búsqueda web para investigar el partido indicado y emitir un análisis en JSON ESTRICTO.

INVESTIGA (con búsqueda web), EN ESTE ORDEN DE PRIORIDAD:
1. ÚLTIMOS 5 PARTIDOS DE CADA EQUIPO POR SEPARADO (lo MÁS importante, no te limites al H2H):
   para CADA partido: rival, marcador, SEDE (si el equipo jugó de LOCAL="H" o de VISITANTE="A" ese día),
   córners a favor/en contra, remates totales y remates al arco.
   Busca en Flashscore/SofaScore/FotMob las estadísticas partido a partido. Tu trabajo CRÍTICO es traer
   estos números CRUDOS y EXACTOS: el servidor calcula los promedios él mismo desde estos datos (ponderando
   por recencia y por sede), así que NO necesitas promediar tú (los promedios que reportes son solo respaldo).
   Si inventas los datos partido a partido, todo el modelo de córners/remates se rompe. Reporta solo lo que
   REALMENTE encuentres; si de un partido no hallaste córners o remates, omite ese campo (no pongas 0).
2. H2H reciente entre ambos (enfrentamientos previos)
3. Cuotas 1X2 actuales del mercado (casas de apuestas)
4. Alineaciones probables, bajas y lesionados
5. Contexto: localía, motivación, estilo de juego (equipos que centran mucho generan córners; equipos que rematan de lejos generan volumen de tiros)
6. FACTOR SORPRESA (momentum): batacazos recientes de cualquiera de los dos (ej. eliminar o vencer a un favorito) y si vienen jugando por ENCIMA o por DEBAJO de su nivel histórico en los últimos 1-3 partidos

RESPONDE SOLO CON UN OBJETO JSON VÁLIDO, sin markdown, sin \`\`\`, sin texto antes ni después. Esquema exacto:
{
  "partido": {"local": "...", "visitante": "...", "torneo": "..."},
  "prob": {"local": 0-100, "empate": 0-100, "visitante": 0-100},
  "cuotas": {"local": 0.0, "empate": 0.0, "visitante": 0.0},
  "cuotas_estimadas": true/false,
  "fuentes": ["Flashscore", "SofaScore", "..."],
  "xg": {"local": 0.0, "visitante": 0.0},
  "forma": {
    "local": [{"rival": "...", "marcador": "2-1", "res": "G|E|P", "sede": "H|A", "corners": 6, "corners_contra": 3, "remates": 14, "remates_arco": 5}],
    "visitante": [{"rival": "...", "marcador": "0-1", "res": "P", "sede": "A", "corners": 4, "corners_contra": 7, "remates": 9, "remates_arco": 2}]
  },
  "promedios": {
    "local": {"goles_favor": 0.0, "goles_contra": 0.0, "corners_favor": 0.0, "corners_contra": 0.0, "remates": 0.0, "remates_arco": 0.0},
    "visitante": {"goles_favor": 0.0, "goles_contra": 0.0, "corners_favor": 0.0, "corners_contra": 0.0, "remates": 0.0, "remates_arco": 0.0}
  },
  "picks": [
    {"tipo": "ganador|goles|corners|goleador|tiros|libre", "mercado": "...", "seleccion": "...", "confianza": 0-100, "cuota": 0.0, "valor": true/false, "riesgo": "bajo|medio|alto", "razon": "1-2 frases con datos"}
  ],
  "combinada": {"patas": [{"seleccion": "...", "mercado": "...", "cuota": 0.0}], "cuota_total": 0.0, "prob_estimada": 0-100},
  "advertencias": ["..."],
  "resumen": "2-3 frases del análisis global"
}

REGLAS INNEGOCIABLES:
1. prob.local + prob.empate + prob.visitante = 100 (aprox).
2. "valor": true SOLO si la cuota de mercado paga MÁS que la cuota justa (cuota_justa = 100/confianza). Si no, false.
3. Devuelve entre 12 y 16 picks del MISMO partido (esto alimenta un "Bet Builder" estilo casa de apuestas). En "seleccion" escribe la apuesta COMPLETA y autoexplicativa (ej. "Más de 1.5 goles totales", NUNCA solo "Sí").
   REGLA DE CUOTA (DURA): TODA pata debe tener cuota entre 1.15 y 2.00. Menos de 1.15 no aporta a la fija (ej. "Más de 0.5 goles" @1.05) y más de 2.00 es una moneda al aire que tumba el builder — NO incluyas ninguna de las dos. Zona ideal: 1.20-1.85.
   FOCO DE MERCADOS: al menos el 70% de los picks deben ser de CÓRNERS, REMATES/TIROS y GOLES (son los mercados que este sistema modela matemáticamente). Máximo 2-3 picks de ganador/doble oportunidad y máximo 2 de jugador.
   A) CÓRNERS (mínimo 4 picks): córners totales over/under; córners por equipo con línea piso que aporte, ej. "<Local> Más de 3.5 córners", "<Visitante> Más de 2.5 córners". Elige la línea usando los promedios REALES de los últimos 5 (si el local promedia 6.2 córners y el rival concede 5.8, "Más de 4.5 córners del local" es sólido y paga).
   B) REMATES (mínimo 3 picks): remates TOTALES de todo tipo (ej. "Más de 22.5 remates totales", "<Local> Más de 10.5 remates") y tiros AL ARCO (ej. "<Local> Más de 3.5 tiros al arco"). Son mercados DIFERENTES: distínguelos siempre. Ancla las líneas a los promedios de los últimos 5.
   C) GOLES (mínimo 3 picks): over/under de goles totales (1.5/2.5/3.5), ambos marcan (BTTS), goles por equipo.
   D) COMPLEMENTO (máx 4-5 picks): ganador/doble oportunidad (1X/X2) si la cuota cae en el rango; goleador "<Nombre> (<Equipo>) anota en cualquier momento" (tipo "goleador"); remates de un jugador clave (tipo "tiros", mercado "Tiros de jugador").
   Agrega 1-2 picks de valor si los detectas (siempre dentro del rango de cuota).
4. "confianza" es TU probabilidad estimada de que el pick acierte. Sé honesto: nada es seguro. El servidor modela córners y remates con Poisson usando TUS "promedios": tu confianza en esos mercados debe ser coherente con esos mismos promedios o el sistema te lo va a corregir y advertir. Goleador y mercados de jugador NO tienen ancla matemática: sé conservador ahí.
5. "combinada" = un BET BUILDER del mismo partido. Incluye SOLO patas de ALTA confianza y NUNCA contradictorias entre sí (ej: over 2.5 + under 2.5, o gana local + gana visitante). El servidor la RECONSTRUYE y filtra por confianza y perfil, así que propón como patas los picks más seguros de tu lista (más largo = más cuota pero MENOS probabilidad de que pegue todo). Longitud orientativa: conservador ~4-6 patas, balanceado ~6-9, agresivo ~8-12.
6. Usa cuotas REALES del mercado encontradas en la búsqueda y marca "cuotas_estimadas": false. Si NO encuentras cuotas reales, estímalas, marca "cuotas_estimadas": true y decláralo en advertencias.
7. xg = goles esperados estimados por equipo para ESTE partido según los datos.
8. Un partido FUTURO que aún no se ha jugado NO es un error: es el caso normal y esperado (el objetivo es PREDECIR partidos por venir). Aunque no existan aún cuotas, alineaciones ni estadísticas de "este" partido, SIEMPRE debes emitir el análisis completo estimando con: historial H2H entre ambos (enfrentamientos previos en mundiales, eliminatorias u otros torneos), forma reciente y nivel de cada selección, resultados en el torneo actual y contexto. Marca "cuotas_estimadas": true y decláralo en "advertencias" (ej: "Partido futuro sin cuotas de mercado publicadas: probabilidades estimadas por H2H histórico y forma reciente"). NUNCA devuelvas {"error"} solo porque el partido todavía no se jugó o no haya datos "en vivo". Responde con {"error": "descripción clara"} ÚNICAMENTE si: el partido ya se jugó (no se puede apostar), uno de los equipos no existe o está tan mal escrito que no puedes identificarlo.
9. Números con punto decimal, sin símbolos de moneda ni %.
10. PONDERA EL FACTOR SORPRESA: si un equipo acaba de dar un batacazo o viene en racha inesperada (o al revés, en crisis), ajusta prob/confianza en su favor o en su contra y DECLÁRALO en "advertencias" (ej: "Cabo Verde viene de eliminar a un favorito: cuota del rival menos segura de lo que parece"). La fija no existe.
11. "fuentes": lista los sitios de donde sacaste los datos (máx 6, ej. "Flashscore", "SofaScore", "Betano"). Si un dato clave NO fue verificado con búsqueda, decláralo en advertencias.
12. Sé conservador con "confianza": en fútbol casi ningún pick honesto supera 85. Rango típico: 50-80. Sobreestimar confianza destruye la calibración del sistema.
13. "forma": los últimos 5 partidos REALES de cada equipo, EL MÁS RECIENTE PRIMERO (el orden importa: el servidor pondera por recencia). Incluye "sede" ("H" si ese día jugó de local, "A" si de visitante) — es clave porque el servidor pondera más los partidos de la MISMA condición que el próximo partido. Reporta los datos que ENCONTRASTE; si de un partido no hallaste córners o remates, omite ese campo (no pongas 0 ni lo inventes). "promedios" es opcional/respaldo: el servidor recalcula los de córners y remates desde "forma".
14. ELIGE LAS LÍNEAS de córners/remates mirando los datos partido a partido: una buena línea es la que el equipo superó en 3-4 de sus últimos 5 (probabilidad ~65-75%, que es la que paga cuota 1.20-1.85). No propongas líneas que el equipo casi nunca alcanza ni líneas tan bajas que siempre entran (cuota <1.15). La "razon" debe citar esos números (ej. "el local superó 4.5 córners en 4 de 5; el rival concede 6.1 por partido").`;

function buildUserPrompt({ local, visitante, torneo, perfil }, opts = {}) {
  const hoy = new Date().toLocaleDateString('es-PE', { year: 'numeric', month: 'long', day: 'numeric' });
  const base = `Fecha de hoy: ${hoy}.
Analiza el próximo partido: ${local} vs ${visitante}${torneo ? ` (${torneo})` : ''}.
Perfil de riesgo del usuario: ${perfil}.`;
  if (opts.local) {
    return `${base}
NO tienes acceso a búsqueda web en tiempo real. Estima los datos (forma, goles, córners, cuotas 1X2, xG) con tu conocimiento y modelo probabilístico, marca "cuotas_estimadas": true y DECLÁRALO en "advertencias" con el texto "DATOS NO EN VIVO: estimados sin búsqueda web". Responde SOLO con el JSON del esquema.`;
  }
  return `${base}
Busca en la web los datos actuales (forma, goles, córners, remates, cuotas 1X2, alineaciones y bajas) y responde SOLO con el JSON del esquema.`;
}

// ---------- Utilidades ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Reintentos con backoff ante errores transitorios del proveedor (429 / 5xx / red)
async function callWithRetry(provider, system, user, emit) {
  const delays = [4000, 9000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.call(provider.apiKey, provider.model, system, user);
    } catch (e) {
      const msg = String(e.message || e);
      const retriable = /HTTP (429|500|502|503|504)/.test(msg) || /fetch failed|ECONNRESET|ETIMEDOUT|socket|network/i.test(msg);
      if (!retriable || attempt >= delays.length) throw e;
      emit({ type: 'log', msg: `⚠ Error transitorio del proveedor — reintento ${attempt + 1}/${delays.length} en ${delays[attempt] / 1000}s (${msg.slice(0, 90)})` });
      await sleep(delays[attempt]);
    }
  }
}

const median = (arr) => {
  const a = arr.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Fusión de N análisis independientes (ENSEMBLE_RUNS>1): mediana de números,
// voto de mayoría por pick; si discrepan, se reduce la confianza y se advierte.
function aggregateEnsemble(runsArr, perfil) {
  const first = runsArr[0];
  const agg = JSON.parse(JSON.stringify(first));
  const med = (get) => median(runsArr.map(get));
  agg.prob = {
    local: med(r => r.prob?.local),
    empate: med(r => r.prob?.empate),
    visitante: med(r => r.prob?.visitante)
  };
  agg.xg = { local: med(r => r.xg?.local), visitante: med(r => r.xg?.visitante) };
  agg.cuotas = {
    local: med(r => r.cuotas?.local),
    empate: med(r => r.cuotas?.empate),
    visitante: med(r => r.cuotas?.visitante)
  };
  agg.cuotas_estimadas = runsArr.filter(r => r.cuotas_estimadas).length * 2 > runsArr.length;

  const extraAdv = [];
  let agreed = 0, tipos = 0;
  agg.picks = (first.picks || []).map(p0 => {
    const tipo = stripAcc(p0.tipo || p0.mercado || '');
    const cands = [];
    for (const r of runsArr) {
      const m = (r.picks || []).find(p => stripAcc(p.tipo || p.mercado || '') === tipo);
      if (m) cands.push(m);
    }
    tipos++;
    const groups = new Map();
    for (const c of cands) {
      const k = stripAcc(c.seleccion || '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [p0];
    const rep = { ...best[0] };
    rep.confianza = median(best.map(x => x.confianza)) ?? rep.confianza;
    rep.cuota = median(best.map(x => x.cuota)) ?? rep.cuota;
    if (best.length * 2 > runsArr.length) {
      agreed++;
    } else {
      rep.confianza = (Number(rep.confianza) || 50) * 0.85;
      extraAdv.push(`ENSEMBLE: los análisis NO coinciden en el pick de ${p0.tipo || p0.mercado} — confianza reducida.`);
    }
    return rep;
  });

  const all = [...runsArr.flatMap(r => Array.isArray(r.advertencias) ? r.advertencias : []), ...extraAdv];
  agg.advertencias = [...new Set(all.map(String))].slice(0, 12);
  agg.fuentes = [...new Set(runsArr.flatMap(r => Array.isArray(r.fuentes) ? r.fuentes : []))].slice(0, 10);
  agg.combinada = buildCombinada(agg.picks, perfil);
  return { agg, agreement: tipos ? agreed / tipos : 1 };
}

// Limpieza previa: quita fences de markdown y normaliza comillas/espacios "tipográficos"
function sanitizeJsonText(text) {
  return String(text)
    .replace(/```(?:json)?/gi, '')   // fences ```json … ```
    .replace(/[“”]/g, '"')  // comillas dobles tipográficas “ ”
    .replace(/[‘’]/g, "'")  // comillas simples tipográficas ‘ ’
    .replace(/ /g, ' ');         // espacio duro
}

// Intenta cerrar un JSON truncado balanceando llaves/corchetes abiertos
function closeTruncatedJson(raw) {
  let depth0 = 0, depth1 = 0, inStr = false, esc = false;
  for (const ch of raw) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth0++; else if (ch === '}') depth0--;
    else if (ch === '[') depth1++; else if (ch === ']') depth1--;
  }
  let fixed = raw;
  if (inStr) fixed += '"';               // string sin cerrar
  fixed = fixed.replace(/,\s*$/, '');     // coma colgante final
  fixed += ']'.repeat(Math.max(0, depth1)) + '}'.repeat(Math.max(0, depth0));
  return fixed;
}

// Quita cierres (} o ]) SOBRANTES que cierran una estructura antes de tiempo:
// el modelo a veces emite una llave de más (ej. "...}]}}, "promedios":...") que
// cierra el objeto raíz cuando todavía quedan campos. Detecta cuándo la
// profundidad vuelve a 0 pero sigue habiendo contenido (una coma) y elimina ese
// cierre espurio. Itera por si hay más de uno.
function dropPrematureClosers(raw, maxFixes = 6) {
  let s = raw;
  for (let pass = 0; pass < maxFixes; pass++) {
    let depth = 0, inStr = false, esc = false, fixedThisPass = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          const rest = s.slice(i + 1).replace(/^\s+/, '');
          if (rest && rest[0] === ',') {   // cierre prematuro: hay más contenido después
            s = s.slice(0, i) + s.slice(i + 1);
            fixedThisPass = true;
            break;
          }
        }
      }
    }
    if (!fixedThisPass) break;
  }
  return s;
}

export function extractJson(text) {
  if (!text) throw new Error('El modelo devolvió una respuesta vacía');
  const clean = sanitizeJsonText(text);
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No se encontró JSON en la respuesta del modelo');
  const raw = clean.slice(start, end + 1);

  // 1) tal cual
  try { return JSON.parse(raw); } catch {}
  // 2) comas colgantes
  const noTrailingCommas = raw.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(noTrailingCommas); } catch {}
  // 3) cierres sobrantes (llave/corchete de más que cierra el objeto raíz antes de tiempo)
  const noExtraClosers = dropPrematureClosers(noTrailingCommas);
  try { return JSON.parse(noExtraClosers); } catch {}
  // 4) posible truncamiento: recorta hasta la última '}' completa y balancea llaves/corchetes
  try { return JSON.parse(closeTruncatedJson(noExtraClosers)); } catch {}

  const err = new Error('El JSON del modelo es inválido y no se pudo reparar');
  err.raw = raw;
  throw err;
}

function validate(r) {
  if (r.error) throw new Error(`ANALISTA: ${r.error}`);
  if (!r.partido || !r.prob || !r.xg || !Array.isArray(r.picks) || r.picks.length === 0) {
    throw new Error('Respuesta incompleta del modelo: faltan campos del esquema');
  }
  for (const k of ['local', 'empate', 'visitante']) {
    if (!Number.isFinite(Number(r.prob[k]))) throw new Error(`prob.${k} no numérica en la respuesta del modelo`);
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

  // BTTS Sí + Under ≤1.5 es imposible (ambos marcan => mínimo 2 goles)
  const bttsYes = norm.some(s => /(ambos (equipos )?(marcan|anotan)|btts)/.test(s) && !/\bno\b/.test(s));
  if (bttsYes) {
    for (const u of unders) {
      const lu = u.match(/(\d+[.,]?\d*)/)?.[1];
      if (lu && !/c[oó]rner/.test(u) && parseFloat(lu.replace(',', '.')) <= 1.5) {
        issues.push(`Patas contradictorias: "ambos marcan: sí" es imposible con "${u}"`);
      }
    }
  }
  // Empate seco + victoria seca de cualquiera
  const drawLeg = norm.some(s => /empate/.test(s) && !/1x|x2|doble|oportunidad|gana/.test(s));
  const pureWin = norm.some(s => /gana|victoria/.test(s) && !/empate|1x|x2|doble/.test(s));
  if (drawLeg && pureWin) issues.push('Patas contradictorias: empate y victoria a la vez');
  // Patas duplicadas
  const dup = norm.find((s, i) => norm.indexOf(s) !== i);
  if (dup) issues.push(`Patas duplicadas en la combinada: "${dup}"`);
  return issues;
}

const STAKE_PCT = { conservador: 0.01, balanceado: 0.015, agresivo: 0.02 };

// Perfil → umbral de confianza mínimo y nº máximo de patas del Bet Builder.
// RANGO DE CUOTA DURO por pata: [minCuota, maxCuota]. Menos no aporta a la fija,
// más es una moneda al aire que tumba el builder completo.
const BUILDER_CFG = {
  conservador: { minConf: 70, minCuota: 1.16, maxCuota: 2.00, max: 5 },
  balanceado:  { minConf: 62, minCuota: 1.18, maxCuota: 2.00, max: 7 },
  agresivo:    { minConf: 55, minCuota: 1.20, maxCuota: 2.00, max: 10 }
};
// Correlación asumida entre patas del MISMO partido (0 = independientes, 1 = perfecta).
const BUILDER_RHO = 0.35;

// Mercados FOCO del sistema (modelables): córners, remates/tiros y goles.
// Tienen prioridad en la fija por sobre ganador/jugador a igual confianza.
export function isFocusMarket(p) {
  const s = stripAcc(`${p.tipo || ''} ${p.mercado || ''} ${p.seleccion || ''}`);
  if (/goleador|anotador|\banota\b|jugador/.test(s)) return false;
  return /corner|esquina|tiro|remate|disparo|shot|gol|over|under|btts|ambos/.test(s);
}

// ARMA el Bet Builder de forma determinista a partir de los picks YA ponderados:
// prioriza mercados foco (córners/remates/goles), exige cuota dentro del rango
// [minCuota, maxCuota] y descarta patas contradictorias, hasta el tope del perfil.
export function buildBetBuilder(picks, perfil) {
  const cfg = BUILDER_CFG[perfil] || BUILDER_CFG.balanceado;
  const FOCUS_BONUS = 8; // pp de ventaja en el orden para córners/remates/goles
  const score = (p) => (Number(p.confianza) || 0) + (isFocusMarket(p) ? FOCUS_BONUS : 0);
  const sorted = [...picks].sort((a, b) => score(b) - score(a));
  const inRange = (p) => {
    const c = Number(p.cuota) || 0;
    return c >= cfg.minCuota && c <= cfg.maxCuota;
  };
  const legs = [];
  const tryAdd = (p) => {
    if (legs.length >= cfg.max) return;
    const cand = { seleccion: p.seleccion, mercado: p.mercado, cuota: p.cuota };
    if (legs.some(l => stripAcc(l.seleccion) === stripAcc(cand.seleccion))) return;
    if (findContradictions([...legs, cand]).length) return;
    legs.push(cand);
  };
  // Pass 1: confianza suficiente Y cuota dentro del rango duro.
  for (const p of sorted) {
    if ((Number(p.confianza) || 0) >= cfg.minConf && inRange(p)) tryAdd(p);
  }
  // Pass 2: si quedaron menos de 2, completa con cualquier pata dentro del rango.
  for (const p of sorted) {
    if (legs.length >= 2) break;
    if (inRange(p)) tryAdd(p);
  }
  // Pass 3 (último recurso): las mejores por confianza, aunque salgan del rango.
  for (const p of sorted) {
    if (legs.length >= 2) break;
    tryAdd(p);
  }
  return { patas: legs, cuota_total: 0, prob_estimada: 0 };
}

// PONDERAR + ARMAR (server-side, determinista):
// 1) sanea xG y normaliza el 1X2 del modelo
// 2) self-check Poisson: ¿el 1X2 declarado es coherente con el propio xG?
// 3) ancla al mercado: cuotas 1X2 → probabilidades sin margen (de-vig) y mezcla
// 4) por pick: prob derivada (Poisson/mercado) + calibración histórica → confianza ajustada
// 5) EV y "valor" con la confianza ajustada; stake por Kelly fraccional (0 = NO APOSTAR)
// 6) combinada: prob = producto de patas, contradicciones, EV real
// 7) índice de confianza 0-100 del análisis completo
export function postProcess(r, params, banca, ctx = {}) {
  const meta = ctx.meta || {};
  r.advertencias = [...new Set((Array.isArray(r.advertencias) ? r.advertencias : []).map(String))];
  r.cuotas_estimadas = Boolean(r.cuotas_estimadas);
  r.fuentes = Array.isArray(r.fuentes)
    ? r.fuentes.map(s => String(s).slice(0, 60)).filter(Boolean).slice(0, 10)
    : [];

  // 0) FORMA (últimos 5 por equipo) y PROMEDIOS saneados → rates λ para Poisson
  //    de córners/remates. Si el modelo no los trajo, los picks de esos mercados
  //    quedan sin ancla matemática (comportamiento anterior) y se advierte.
  //    sede: 'H' (jugó en casa) / 'A' (jugó fuera) / '' (desconocido).
  const sanitizeForma = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 5).map(p => {
    // 0 córners/remates en un partido real es casi imposible: el modelo manda 0
    // cuando NO encontró el dato => se trata como "sin dato" (null).
    const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
    const sede = /^[HA]$/i.test(String(p?.sede || '')) ? String(p.sede).toUpperCase() : '';
    return {
      rival: String(p?.rival || '').slice(0, 40),
      marcador: String(p?.marcador || '').slice(0, 12),
      res: /^[GEP]$/i.test(String(p?.res || '')) ? String(p.res).toUpperCase() : '',
      sede,
      corners: n(p?.corners), corners_contra: n(p?.corners_contra),
      remates: n(p?.remates), remates_arco: n(p?.remates_arco)
    };
  }).filter(p => p.rival);
  r.forma = {
    local: sanitizeForma(r.forma?.local),
    visitante: sanitizeForma(r.forma?.visitante)
  };

  // Promedios REALES: los calculamos NOSOTROS desde los datos partido-a-partido
  // (recencia + sede) en vez de confiar en la aritmética del modelo. El próximo
  // partido es LOCAL para 'local' (venue 'H') y VISITA para 'visitante' (venue 'A').
  const statsL = computeFormaStats(r.forma.local, 'H');
  const statsV = computeFormaStats(r.forma.visitante, 'A');
  const modelProm = r.promedios || {};
  const numN = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? round2(x) : null; };
  const mergeProm = (side, stats) => {
    const m = modelProm[side] || {};
    const s = stats?.promedios || {};
    return {
      // goles: del modelo (el marcador partido-a-partido es ambiguo de atribuir)
      goles_favor: numN(m.goles_favor), goles_contra: numN(m.goles_contra),
      // córners/remates: recalculados server-side; el modelo es solo fallback
      corners_favor: s.corners_favor ?? numN(m.corners_favor),
      corners_contra: s.corners_contra ?? numN(m.corners_contra),
      remates: s.remates ?? numN(m.remates),
      remates_arco: s.remates_arco ?? numN(m.remates_arco)
    };
  };
  r.promedios = { local: mergeProm('local', statsL), visitante: mergeProm('visitante', statsV) };
  r.promedios_fuente = (statsL || statsV) ? 'CALCULADO·SERVER' : 'MODELO';
  // Muestra efectiva mínima entre ambos equipos (córners) => encoge la confianza
  // de los picks Poisson de córners/remates cuando hay pocos partidos con dato.
  const nEff = (st) => st?.ns?.corners_favor ?? st?.ns?.remates ?? 0;
  const sampleN = Math.min(nEff(statsL) || 5, nEff(statsV) || 5);

  const rates = ratesFromAverages(r.promedios);
  if (rates) rates._n = sampleN;
  if (!rates) {
    r.advertencias.push('Sin datos de córners/remates de los últimos partidos: esos mercados NO tienen ancla matemática en este análisis.');
  } else if (r.promedios_fuente !== 'CALCULADO·SERVER') {
    r.advertencias.push('El modelo no detalló los últimos partidos con córners/remates: promedios tomados de su estimación, menos verificables.');
  } else if (sampleN < 3) {
    r.advertencias.push(`Muestra chica de córners/remates (≈${round2(sampleN)} partidos con dato): confianza de esos mercados encogida.`);
  }

  // 1) xG saneado + grilla Poisson exacta
  r.xg = r.xg || {};
  r.xg.local = round2(clamp(Number(r.xg.local) || 1.2, 0.1, 5));
  r.xg.visitante = round2(clamp(Number(r.xg.visitante) || 1.0, 0.1, 5));
  const grid = poissonGrid(r.xg.local, r.xg.visitante);

  // Normalizar 1X2 del modelo
  const P = r.prob = r.prob || {};
  P.local = Number(P.local) || 0; P.empate = Number(P.empate) || 0; P.visitante = Number(P.visitante) || 0;
  const sum = P.local + P.empate + P.visitante;
  if (sum <= 0) {
    P.local = round2(grid.pH * 100); P.empate = round2(grid.pD * 100); P.visitante = round2(100 - P.local - P.empate);
  } else if (Math.abs(sum - 100) > 1) {
    P.local = round2(P.local / sum * 100);
    P.empate = round2(P.empate / sum * 100);
    P.visitante = round2(100 - P.local - P.empate);
  }
  const modelP = { ...P };

  // 2) self-check Poisson (1X2 declarado vs lo que implica su propio xG)
  const divPoisson = round2((
    Math.abs(modelP.local - grid.pH * 100) +
    Math.abs(modelP.empate - grid.pD * 100) +
    Math.abs(modelP.visitante - grid.pA * 100)
  ) / 3);
  r.poisson = {
    local: round2(grid.pH * 100), empate: round2(grid.pD * 100), visitante: round2(grid.pA * 100),
    over25: round2(grid.over(2.5) * 100), btts: round2(grid.btts * 100), divergencia: divPoisson
  };
  if (divPoisson > 15) {
    r.advertencias.push(`Incoherencia interna: el 1X2 del modelo difiere ${divPoisson}pp de lo que implica su propio xG.`);
  }

  // 3) ancla de mercado (de-vig) y mezcla de probabilidades
  const market = marketProbs(r.cuotas);
  let divMercado = null;
  if (market) {
    divMercado = round2((
      Math.abs(P.local - market.local) +
      Math.abs(P.empate - market.empate) +
      Math.abs(P.visitante - market.visitante)
    ) / 3);
    const w = r.cuotas_estimadas ? 0.25 : 0.55; // cuotas reales => el mercado pesa más
    P.local = round2(w * market.local + (1 - w) * P.local);
    P.empate = round2(w * market.empate + (1 - w) * P.empate);
    P.visitante = round2(100 - P.local - P.empate);
    r.prob_mercado = {
      local: round2(market.local), empate: round2(market.empate),
      visitante: round2(market.visitante), overround: market.overround
    };
    if (divMercado > 12) {
      r.advertencias.push(`El modelo diverge ${divMercado}pp del mercado en el 1X2 — probabilidades ancladas hacia las cuotas reales.`);
    }
  } else {
    r.prob_mercado = null;
    // sin mercado: mezclar con Poisson para corregir incoherencias internas
    P.local = round2(0.7 * P.local + 0.3 * grid.pH * 100);
    P.empate = round2(0.7 * P.empate + 0.3 * grid.pD * 100);
    P.visitante = round2(100 - P.local - P.empate);
    if (!r.cuotas_estimadas) r.advertencias.push('Sin cuotas 1X2 utilizables: no se pudo anclar el modelo al mercado.');
  }

  // 4) + 5) picks: prob derivada + calibración + Kelly
  const pct = STAKE_PCT[params.perfil] ?? 0.015;
  const calib = ctx.calib || null;
  const dctx = { probs: P, poisson: grid, local: params.local, visitante: params.visitante, rates };
  for (const p of r.picks) {
    // El modelo a veces manda seleccion "Sí"/"No" y deja la apuesta descrita en
    // mercado. Normalizamos: seleccion SIEMPRE autoexplicativa (el dedupe de la
    // fija, las contradicciones y la UI dependen de eso).
    const mercadoTxt = String(p.mercado || '').trim();
    const selRaw = String(p.seleccion || '').trim();
    if (/^(si|sí|yes|over)$/i.test(selRaw) && mercadoTxt) {
      p.seleccion = /m[aá]s de|menos de|over|under/i.test(mercadoTxt) ? mercadoTxt : `${mercadoTxt}: Sí`;
    } else if (/^(no|under)$/i.test(selRaw) && mercadoTxt) {
      p.seleccion = /m[aá]s de|menos de|over|under/i.test(mercadoTxt) ? mercadoTxt : `${mercadoTxt}: No`;
    }

    const confModelo = clamp(Number(p.confianza) || 50, 1, 99);
    p.confianza_modelo = round2(confModelo);
    p.cuota = round2(Math.max(1.01, Number(p.cuota) || 1.5));
    // Rango objetivo del sistema: 1.15–2.00 por pata. Fuera de rango NO entra a la fija.
    p.rango_ok = p.cuota >= 1.15 && p.cuota <= 2.00;

    const der = derivePickProb(p, dctx);
    let conf;
    if (der) {
      const derPct = clamp(der.prob * 100, 1, 99);
      p.prob_derivada = round2(derPct);
      p.fuente_prob = der.fuente;
      // Peso de la derivación vs la IA. Para córners/remates (Poisson desde los
      // promedios reales) el peso depende del TAMAÑO DE MUESTRA: con pocos
      // partidos con dato el Poisson es ruidoso y confiamos menos en él.
      let wDer = 0.55;
      if (der.fuente.startsWith('POISSON') && der.fuente !== 'POISSON·xG') {
        const n = rates?._n ?? 3;
        wDer = n >= 5 ? 0.62 : n >= 3 ? 0.50 : n >= 2 ? 0.38 : 0.28;
        p.muestra_efectiva = round2(n);
      }
      conf = (1 - wDer) * confModelo + wDer * derPct;
      if (Math.abs(derPct - confModelo) > 15) {
        r.advertencias.push(`"${p.seleccion}": la IA dice ${round2(confModelo)}% pero ${der.fuente} da ${round2(derPct)}% — confianza ajustada.`);
      }
    } else {
      // mercado no derivable (córners, hándicaps…): encoger hacia 50 (alta varianza)
      conf = 50 + (confModelo - 50) * 0.85;
      p.fuente_prob = 'MODELO·IA';
    }

    const f = calibFactor(calib, conf);
    if (f != null && f !== 1) { p.factor_calibracion = f; conf *= f; }

    p.confianza = round2(clamp(conf, 1, 99));
    const prob = p.confianza / 100;
    p.cuota_justa = round2(1 / prob);
    p.ev = round2((prob * p.cuota - 1) * 100);        // EV en %
    p.valor = p.cuota > p.cuota_justa;                 // regla dura server-side
    p.stake = kellyStake(prob, p.cuota, banca, pct);   // 0 => NO APOSTAR
    p.riesgo = p.confianza >= 70 ? 'bajo' : p.confianza >= 55 ? 'medio' : 'alto';
  }
  if (!r.picks.some(p => p.stake > 0)) {
    r.advertencias.push('Ningún pick tiene valor esperado positivo tras el ajuste: la recomendación honesta es NO apostar este partido.');
  }

  // 6) BET BUILDER: reconstruido server-side desde los picks YA ponderados
  //    (filtra por confianza y perfil, sin patas contradictorias). La prob se
  //    calcula de dos formas: independiente (producto) y ajustada por la
  //    correlación intra-partido, que es la honesta para un builder de un solo juego.
  const c = buildBetBuilder(r.picks, params.perfil);
  if (c.patas.length) {
    c.patas = c.patas.map(x => ({ ...x, cuota: round2(Math.max(1.01, Number(x.cuota) || 1.3)) }));
    c.cuota_total = round2(c.patas.reduce((m, x) => m * x.cuota, 1));
    const legProbs = c.patas.map(leg => {
      const match = r.picks.find(p => stripAcc(p.seleccion) === stripAcc(leg.seleccion));
      return match ? clamp(match.confianza / 100, 0.01, 0.99) : Math.min(0.97, (1 / leg.cuota) * 0.97);
    });
    const prodIndep = legProbs.reduce((m, x) => m * x, 1);
    const minLeg = Math.min(...legProbs);
    // Correlación positiva intra-partido: la prob real sube desde el producto
    // (independencia) hacia la pata más débil (correlación perfecta).
    const probCorr = clamp(prodIndep + BUILDER_RHO * (minLeg - prodIndep), 0.01, 0.99);
    c.prob_independiente = round2(prodIndep * 100);
    c.prob_estimada = round2(probCorr * 100);
    c.correlacion = BUILDER_RHO;
    c.cuota_justa = round2(1 / probCorr);          // cuota mínima para que la apuesta tenga valor
    c.kelly_cap = round2(pct * 0.5);               // fracción de banca tope (para el cálculo con cuota real)
    // OJO: NO calculamos EV/stake con el producto de cuotas: una casa paga MENOS que
    // eso en un builder por la correlación. El EV/stake honesto se calcula en el
    // cliente contra la CUOTA REAL que el usuario ingrese.
    c.ev = null;
    c.stake = null;
    c.nota = `Bet Builder de ${c.patas.length} patas · prob real de que pegue TODO ≈ ${c.prob_estimada}% (ajustada por correlación ρ=${BUILDER_RHO}; independiente daría ${c.prob_independiente}%). La cuota teórica X${c.cuota_total} es el producto de patas — la casa pagará MENOS. Solo tiene valor si la cuota real del Bet Builder es MAYOR a ${c.cuota_justa}.`;
    const contra = findContradictions(c.patas);
    if (contra.length) r.advertencias.push(...contra);
    r.contradicciones = contra;
    r.combinada = c;
    // Marca qué picks forman la fija (para no mostrarles "NO APOSTAR" como pata suelta).
    const legSet = new Set(c.patas.map(l => stripAcc(l.seleccion)));
    for (const p of r.picks) p.en_fija = legSet.has(stripAcc(p.seleccion));
  } else {
    r.combinada = null;
    r.contradicciones = [];
  }

  // 7) índice de confianza del análisis completo
  r.indice_confianza = computeConfidenceIndex(r, { provider: meta.provider, searches: meta.searches }, {
    local: meta.local,
    divPoisson,
    divMercado,
    ensembleRuns: meta.ensembleRuns,
    ensembleAgreement: meta.ensembleAgreement,
    calib
  });
  r.advertencias = [...new Set(r.advertencias)].slice(0, 14);
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
  const star = (t) => `Delantero de ${t}`;

  const mkForma = (nCorners) => Array.from({ length: 5 }, (_, i) => ({
    rival: `Rival ${i + 1}`,
    marcador: `${Math.round(rng() * 3)}-${Math.round(rng() * 2)}`,
    res: ['G', 'E', 'P'][Math.floor(rng() * 3)],
    sede: i % 2 === 0 ? 'H' : 'A',
    corners: Math.round(nCorners + rng() * 4 - 2),
    corners_contra: Math.round(4 + rng() * 3),
    remates: Math.round(10 + rng() * 8),
    remates_arco: Math.round(3 + rng() * 4)
  }));
  const cornersL = rnd(4.5, 6.5, 1), cornersV = rnd(3.5, 5.5, 1);

  const result = {
    partido: { local: params.local, visitante: params.visitante, torneo: params.torneo || 'DEMO' },
    prob: { local: pl, empate: pe, visitante: pv },
    cuotas: { local: cuotaL, empate: cuotaE, visitante: cuotaV },
    xg: { local: xgL, visitante: xgV },
    forma: { local: mkForma(cornersL), visitante: mkForma(cornersV) },
    promedios: {
      local: { goles_favor: rnd(1.0, 2.2, 1), goles_contra: rnd(0.7, 1.6, 1), corners_favor: cornersL, corners_contra: rnd(3.5, 5.5, 1), remates: rnd(11, 16, 1), remates_arco: rnd(3.5, 6, 1) },
      visitante: { goles_favor: rnd(0.8, 1.8, 1), goles_contra: rnd(0.9, 1.8, 1), corners_favor: cornersV, corners_contra: rnd(4, 6, 1), remates: rnd(9, 14, 1), remates_arco: rnd(2.5, 5, 1) }
    },
    picks: [
      { tipo: 'ganador', mercado: 'Doble oportunidad', seleccion: ganadorSel, confianza: rnd(66, 82, 0), cuota: rnd(1.3, 1.65), riesgo: 'bajo', razon: `Forma reciente favorable y ventaja de localía (xG ${xgL} vs ${xgV}). [DEMO]` },
      { tipo: 'goles', mercado: 'Total de goles', seleccion: 'Más de 1.5 goles', confianza: rnd(74, 88, 0), cuota: rnd(1.28, 1.5), riesgo: 'bajo', razon: `Línea baja casi segura con xG combinado ${round2(totalXg)}. [DEMO]` },
      { tipo: 'goles', mercado: 'Total de goles', seleccion: overSel, confianza: rnd(53, 68, 0), cuota: rnd(1.7, 2.05), riesgo: 'medio', razon: `xG combinado de ${round2(totalXg)}; promedios de gol sostienen la línea. [DEMO]` },
      { tipo: 'goles', mercado: 'Ambos marcan', seleccion: rng() > 0.5 ? 'Ambos marcan: Sí' : 'Ambos marcan: No', confianza: rnd(52, 66, 0), cuota: rnd(1.7, 2.15), riesgo: 'medio', razon: `Defensas con fugas recientes en ambos lados. [DEMO]` },
      { tipo: 'corners', mercado: 'Córners totales', seleccion: `Más de ${cornerLine} córners`, confianza: rnd(54, 68, 0), cuota: rnd(1.75, 2.1), riesgo: 'medio', razon: `Ambos equipos promedian volumen alto de córners. [DEMO]` },
      { tipo: 'corners', mercado: `${params.local} córners`, seleccion: `${params.local} Más de ${Math.max(2, Math.round(cornersL) - 2)}.5 córners`, confianza: rnd(70, 84, 0), cuota: rnd(1.3, 1.6), riesgo: 'bajo', razon: `El local promedia ${cornersL} córners en los últimos 5. [DEMO]` },
      { tipo: 'corners', mercado: `${params.visitante} córners`, seleccion: `${params.visitante} Más de ${Math.max(1, Math.round(cornersV) - 2)}.5 córners`, confianza: rnd(72, 86, 0), cuota: rnd(1.25, 1.5), riesgo: 'bajo', razon: `El visitante promedia ${cornersV} córners en los últimos 5. [DEMO]` },
      { tipo: 'tiros', mercado: 'Remates totales', seleccion: `Más de ${Math.round(rnd(19, 23, 0))}.5 remates totales`, confianza: rnd(62, 76, 0), cuota: rnd(1.4, 1.75), riesgo: 'medio', razon: `Suma de promedios de remates de ambos sostiene la línea. [DEMO]` },
      { tipo: 'tiros', mercado: `${params.local} tiros al arco`, seleccion: `${params.local} Más de 2.5 tiros al arco`, confianza: rnd(70, 84, 0), cuota: rnd(1.35, 1.6), riesgo: 'bajo', razon: `El local genera volumen de remates al arco por partido. [DEMO]` },
      { tipo: 'tiros', mercado: `${params.visitante} tiros al arco`, seleccion: `${params.visitante} Más de 1.5 tiros al arco`, confianza: rnd(68, 82, 0), cuota: rnd(1.3, 1.55), riesgo: 'bajo', razon: `El visitante remata al arco lo suficiente para la línea piso. [DEMO]` },
      { tipo: 'goleador', mercado: 'Anota en cualquier momento', seleccion: `${star(pl >= pv ? params.local : params.visitante)} anota en cualquier momento`, confianza: rnd(55, 70, 0), cuota: rnd(1.8, 2.0), riesgo: 'medio', razon: `Referente ofensivo del favorito ante una defensa vulnerable. [DEMO]` },
      { tipo: 'tiros', mercado: 'Tiros de jugador', seleccion: `${star(pl >= pv ? params.local : params.visitante)} Más de 1.5 remates`, confianza: rnd(64, 78, 0), cuota: rnd(1.4, 1.75), riesgo: 'medio', razon: `El delantero titular acumula remates casi todos los partidos. [DEMO]` }
    ],
    combinada: null,
    cuotas_estimadas: true,
    fuentes: [],
    advertencias: ['MODO DEMO: datos sintéticos, no usar para apostar. Configura una API key en .env'],
    resumen: `Análisis DEMO de ${params.local} vs ${params.visitante}: ligera ventaja ${pl >= pv ? 'local' : 'visitante'} con xG ${xgL}-${xgV}. Datos simulados para probar la interfaz.`
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

  let calib = null;
  try { calib = await getCalibration(); } catch { /* sin historial */ }

  let out;
  if (!provider) {
    out = await demoAnalysis(params, emit);
  } else {
    const nRuns = provider.local ? 1 : clamp(parseInt(process.env.ENSEMBLE_RUNS, 10) || 1, 1, 3);
    emit({ type: 'step', step: 1 });
    if (provider.local) {
      emit({ type: 'log', msg: `⚠ MOTOR LOCAL: ${provider.label} · ${provider.model} — SIN búsqueda web: datos estimados, NO en vivo` });
    } else {
      emit({ type: 'log', msg: `MOTOR: ${provider.label} · ${provider.model} — lanzando búsqueda web del partido${nRuns > 1 ? ` · ensemble x${nRuns}` : ''}` });
    }
    const t0 = Date.now();
    const heartbeat = setInterval(() => {
      emit({ type: 'tick', elapsed: Math.round((Date.now() - t0) / 1000) });
    }, 2000);
    let settledRuns;
    try {
      const jobs = Array.from({ length: nRuns }, () =>
        callWithRetry(provider, SYSTEM_PROMPT, buildUserPrompt(params, { local: provider.local }), emit));
      settledRuns = await Promise.allSettled(jobs);
    } finally {
      clearInterval(heartbeat);
    }
    emit({ type: 'step', step: 2 });

    const okRuns = [];
    const errors = [];
    let searches = 0;
    settledRuns.forEach((s, i) => {
      if (s.status === 'rejected') { errors.push(s.reason); return; }
      searches += Number(s.value.searches) || 0;
      try {
        const parsed = extractJson(s.value.text);
        validate(parsed);
        okRuns.push(parsed);
      } catch (e) {
        if (e.raw) emit({ type: 'log', msg: `JSON CRUDO (run ${i + 1} falló): ${e.raw.slice(0, 400)}` });
        errors.push(e);
      }
    });
    if (!okRuns.length) throw errors[0] || new Error('Ningún análisis válido del motor');
    emit({ type: 'log', msg: `RESPUESTA(S): ${okRuns.length}/${nRuns} válidas en ${Math.round((Date.now() - t0) / 1000)}s · búsquedas web: ${searches || 's/d'}` });

    emit({ type: 'step', step: 3 });
    let parsed, agreement = null;
    if (okRuns.length > 1) {
      ({ agg: parsed, agreement } = aggregateEnsemble(okRuns, params.perfil));
      emit({ type: 'log', msg: `ENSEMBLE: ${okRuns.length} análisis fusionados por mediana · acuerdo en picks: ${Math.round(agreement * 100)}%` });
    } else {
      parsed = okRuns[0];
    }
    emit({ type: 'log', msg: `JSON validado: ${parsed.picks.length} picks + ${parsed.combinada?.patas?.length || 0} patas de combinada` });
    emit({ type: 'step', step: 4 });
    out = {
      result: parsed,
      meta: {
        provider: provider.name, label: provider.label, model: provider.model, searches,
        local: !!provider.local, ensembleRuns: okRuns.length, ensembleAgreement: agreement
      }
    };
  }

  const r = postProcess(out.result, params, banca, { calib, meta: out.meta });
  const conEv = r.picks.filter(p => p.valor).length;
  emit({ type: 'log', msg: `PONDERACIÓN: mercado (de-vig) + Poisson + calibración server-side — ${conEv}/${r.picks.length} picks con +EV real` });
  emit({ type: 'step', step: 5 });
  if (r.contradicciones.length) {
    emit({ type: 'log', msg: `⚠ ALERTA: ${r.contradicciones.length} contradicción(es) detectada(s) en la combinada` });
  }
  emit({ type: 'log', msg: `ÍNDICE DE CONFIANZA: ${r.indice_confianza.score}/100 (${r.indice_confianza.nivel})` });
  return { result: r, meta: out.meta };
}

// ═══════════ MODO TORNEO: ratings de equipos para simular el bracket ═══════════
const SYSTEM_TORNEO = `Eres FIJALAB ✕ QUANT, analista cuantitativo de fútbol.
Te dan una lista de equipos que siguen vivos en un torneo de eliminación directa.
Investiga con búsqueda web la forma reciente, goles anotados/recibidos, xG, plantel/bajas y nivel de cada equipo, y asígnale ratings.

RESPONDE SOLO CON UN OBJETO JSON VÁLIDO, sin markdown, sin \`\`\`, sin texto antes ni después. Esquema exacto:
{
  "equipos": [
    {"nombre": "<exactamente el nombre dado>", "ataque": 0.0, "defensa": 0.0, "fuerza": 0-100, "momentum": -100 a 100, "nota": "1 frase con el dato clave"}
  ],
  "resumen": "2-3 frases sobre los favoritos al título"
}

REGLAS INNEGOCIABLES:
1. "ataque" = goles esperados que ESE equipo ANOTA por partido ante rivales de este nivel (rango realista 0.6–2.8).
2. "defensa" = goles esperados que ESE equipo CONCEDE por partido (rango realista 0.5–2.2). Menor = mejor defensa.
3. "fuerza" = nivel global 0-100 (se usa para desempates por penales). El mejor equipo ~90, el más débil ~55.
4. "momentum" = FACTOR SORPRESA direccional de -100 a +100: qué tan por ENCIMA (+) o por DEBAJO (-) de su nivel histórico está jugando el equipo AHORA MISMO en este torneo. BUSCA sus resultados de los últimos días: si acaba de dar un batacazo (ej. eliminar o vencer a un favorito), jugar mucho mejor de lo esperado o venir en racha => positivo alto (+50 a +85). Si está en crisis, ganando sin convencer o con bajas clave => negativo (-30 a -70). Rendimiento normal según su nivel => cercano a 0. NO dupliques lo ya reflejado en ataque/defensa: momentum captura la TENDENCIA de los últimos 1-3 partidos.
5. Devuelve EXACTAMENTE un objeto por cada equipo de la lista, con el MISMO nombre escrito igual. No agregues ni quites equipos.
6. Números con punto decimal, sin símbolos de moneda ni %.
7. Si no reconoces un equipo, estima con criterio y decláralo en su "nota".`;

function buildTorneoPrompt(equipos, torneo, ronda, local) {
  const hoy = new Date().toLocaleDateString('es-PE', { year: 'numeric', month: 'long', day: 'numeric' });
  const lista = equipos.map((e, i) => `${i + 1}. ${e}`).join('\n');
  const base = `Fecha de hoy: ${hoy}.
Torneo: ${torneo || 'torneo de eliminación directa'}. Ronda actual: ${ronda}.
Equipos que siguen vivos:
${lista}`;
  if (local) {
    return `${base}
NO tienes búsqueda web en tiempo real. Estima los ratings con tu conocimiento y decláralo en las notas. Responde SOLO con el JSON del esquema.`;
  }
  return `${base}
Busca en la web datos actuales de cada equipo y responde SOLO con el JSON del esquema.`;
}

// Garantiza un rating por cada equipo de entrada, en el MISMO orden (= orden del bracket), y con rangos sanos
export function normalizeTorneoRatings(data, equipos) {
  const byName = new Map();
  for (const e of (data?.equipos || [])) {
    if (e && e.nombre) byName.set(stripAcc(e.nombre), e);
  }
  const out = equipos.map((nombre) => {
    const r = byName.get(stripAcc(nombre)) || {};
    return {
      nombre,
      ataque: round2(clamp(Number(r.ataque) || 1.3, 0.3, 3.5)),
      defensa: round2(clamp(Number(r.defensa) || 1.2, 0.3, 3.0)),
      fuerza: Math.round(clamp(Number(r.fuerza) || 70, 40, 99)),
      momentum: Math.round(clamp(Number(r.momentum) || 0, -100, 100)),
      nota: String(r.nota || '').slice(0, 140)
    };
  });
  return { equipos: out, resumen: String(data?.resumen || '') };
}

// params: { equipos:[nombres en orden de bracket], torneo, ronda }
export async function runTournament(params, emit) {
  let provider;
  try { provider = detectProvider(); }
  catch (e) { throw new Error(e.message); }

  if (!provider) {
    emit({ type: 'log', msg: 'MODO DEMO — ratings sintéticos (sin API key configurada)' });
    const equipos = params.equipos.map((nombre) => {
      const rng = seededRng('TORNEO|' + nombre);
      return {
        nombre,
        ataque: round2(0.9 + rng() * 1.6),
        defensa: round2(0.7 + rng() * 1.2),
        fuerza: Math.round(60 + rng() * 32),
        momentum: Math.round(-40 + rng() * 100),
        nota: 'DEMO: rating sintético'
      };
    });
    return {
      data: { equipos, resumen: 'Ratings DEMO sintéticos — configura una API key en .env para datos en vivo.' },
      meta: { provider: 'demo', label: 'DEMO', model: 'sintético', searches: 0 }
    };
  }

  if (provider.local) {
    emit({ type: 'log', msg: `⚠ MOTOR LOCAL: ${provider.label} · ${provider.model} — SIN búsqueda web: ratings estimados` });
  } else {
    emit({ type: 'log', msg: `MOTOR: ${provider.label} · ${provider.model} — investigando ${params.equipos.length} equipos del bracket` });
  }
  const t0 = Date.now();
  const heartbeat = setInterval(() => emit({ type: 'tick', elapsed: Math.round((Date.now() - t0) / 1000) }), 2000);
  let text, searches;
  try {
    ({ text, searches } = await callWithRetry(
      provider, SYSTEM_TORNEO,
      buildTorneoPrompt(params.equipos, params.torneo, params.ronda, provider.local),
      emit
    ));
  } finally { clearInterval(heartbeat); }
  emit({ type: 'log', msg: `RATINGS RECIBIDOS en ${Math.round((Date.now() - t0) / 1000)}s · búsquedas web: ${searches || 's/d'}` });

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    if (e.raw) emit({ type: 'log', msg: `JSON CRUDO (falló): ${e.raw.slice(0, 800)}` });
    throw e;
  }
  const data = normalizeTorneoRatings(parsed, params.equipos);
  emit({ type: 'log', msg: `${data.equipos.length} equipos rateados — lanzando 10,000 simulaciones del bracket` });
  return { data, meta: { provider: provider.name, label: provider.label, model: provider.model, searches } };
}
