// quant.js — Capa cuantitativa determinista (server-side, sin IA):
// Poisson exacto, de-vig del mercado, probabilidad derivada por pick,
// calibración histórica, stake por Kelly fraccional e índice de confianza.

export const round2 = (n) => Math.round(n * 100) / 100;
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const stripAcc = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------- Poisson exacto (grilla 0..kMax por equipo, normalizada) ----------
export function poissonGrid(xgL, xgV, kMax = 12) {
  const pmf = (lam) => {
    let p = Math.exp(-clamp(lam, 0.05, 6));
    const arr = [p];
    for (let k = 1; k <= kMax; k++) { p *= clamp(lam, 0.05, 6) / k; arr.push(p); }
    return arr;
  };
  const a = pmf(xgL), b = pmf(xgV);
  let pH = 0, pD = 0, pA = 0, btts = 0, mass = 0;
  const totals = new Array(2 * kMax + 1).fill(0);
  for (let i = 0; i <= kMax; i++) {
    for (let j = 0; j <= kMax; j++) {
      const p = a[i] * b[j];
      mass += p;
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
      if (i > 0 && j > 0) btts += p;
      totals[i + j] += p;
    }
  }
  const over = (line) => {
    let s = 0;
    for (let t = Math.ceil(line); t < totals.length; t++) s += totals[t];
    return s / mass;
  };
  return { pH: pH / mass, pD: pD / mass, pA: pA / mass, btts: btts / mass, over };
}

// ---------- Poisson para CONTEOS (córners/remates): P(X > line) con X~Poisson(λ) ----------
// line es una línea de casa (ej. 8.5) => devuelve P(X >= 9) = 1 - CDF(8).
export function poissonOverCount(lambda, line) {
  const lam = clamp(Number(lambda), 0.1, 60);
  const k = Math.floor(Number(line));
  if (!Number.isFinite(k) || k < 0) return NaN;
  let p = Math.exp(-lam), cdf = p;
  for (let i = 1; i <= k; i++) { p *= lam / i; cdf += p; }
  return clamp(1 - cdf, 0, 1);
}

// ---------- Mercado: cuotas 1X2 → probabilidades implícitas sin margen ----------
export function marketProbs(cuotas) {
  if (!cuotas) return null;
  const c = [Number(cuotas.local), Number(cuotas.empate), Number(cuotas.visitante)];
  if (c.some(x => !Number.isFinite(x) || x < 1.02 || x > 100)) return null;
  const inv = c.map(x => 1 / x);
  const s = inv[0] + inv[1] + inv[2];
  if (s < 0.9 || s > 1.4) return null; // margen absurdo => cuotas poco fiables
  return {
    local: inv[0] / s * 100,
    empate: inv[1] / s * 100,
    visitante: inv[2] / s * 100,
    overround: round2((s - 1) * 100)
  };
}

// ---------- Probabilidad derivada de un pick (Poisson / mercado+modelo) ----------
// ctx = { probs: {local, empate, visitante} en 0-100 ya ancladas, poisson: grid, local, visitante }
// Devuelve { prob: 0..1, fuente } o null si el mercado del pick no es derivable (córners, hándicaps…)
export function derivePickProb(pick, ctx) {
  const s = stripAcc(`${pick.mercado || ''} ${pick.seleccion || ''}`);
  const { probs, poisson } = ctx;
  const L = stripAcc(ctx.local || ''), V = stripAcc(ctx.visitante || '');
  const hasL = L.length > 2 && s.includes(L);
  const hasV = V.length > 2 && s.includes(V);

  // BTTS — se evalúa ANTES del guardia de mercados no derivables
  // (para que "ambos anotan" no lo capture el filtro de "anota" de goleador).
  if (/ambos\s+(equipos\s+)?(marcan|anotan)|btts|\bgg\b/.test(s)) {
    const no = /\bno\b/.test(s) && !/\bsi\b/.test(s);
    return { prob: no ? 1 - poisson.btts : poisson.btts, fuente: 'POISSON·xG' };
  }

  // Mercados SIN modelo server-side (confianza queda en manos de la IA):
  // tarjetas y mercados de jugador (goleador/anotador, remates de un jugador).
  if (/tarjeta|amarilla|roja|saque|goleador|anotador|\banota\b|jugador/.test(s)) return null;

  const num = (t) => parseFloat(t.replace(',', '.'));

  // CÓRNERS y REMATES: modelo Poisson con λ derivado de los promedios de los
  // últimos partidos (ctx.rates, saneado server-side). Sin rates => null (IA manda).
  const isCorner = /corner|esquina/.test(s);
  const isRemate = !isCorner && /tiro|remate|disparo|shot/.test(s);
  if (isCorner || isRemate) {
    const rates = ctx.rates || null;
    // líneas por mitad no se modelan con el λ del partido completo
    if (!rates || /(primer|segundo)\s+tiempo|1er|2do|descanso|mitad|\bht\b/.test(s)) return null;
    const alArco = /(al arco|a puerta|on target|al marco|a porteria)/.test(s);
    const grp = isCorner ? rates.corners : (alArco ? rates.rematesArco : rates.remates);
    if (!grp) return null;
    let lam = null;
    if (hasL && !hasV) lam = grp.L;
    else if (hasV && !hasL) lam = grp.V;
    else if (!hasL && !hasV) lam = (grp.L != null && grp.V != null) ? grp.L + grp.V : null; // total del partido
    if (!Number.isFinite(lam) || lam <= 0) return null;
    const fuente = isCorner ? 'POISSON·CÓRNERS' : (alArco ? 'POISSON·TIROS·ARCO' : 'POISSON·REMATES');
    let mc = s.match(/(?:over|mas de)\s*(\d+[.,]?\d*)/);
    if (mc) return { prob: poissonOverCount(lam, num(mc[1])), fuente };
    mc = s.match(/(?:under|menos de)\s*(\d+[.,]?\d*)/);
    if (mc) return { prob: 1 - poissonOverCount(lam, num(mc[1])), fuente };
    return null;
  }

  // over/under de goles TOTALES (Poisson). Si la línea es de UN solo equipo
  // (ej. "Francia más de 1.5 goles"), el Poisson de goles totales no aplica:
  // devolvemos null y la confianza se encoge hacia 50.
  const oneTeam = hasL !== hasV;
  let m = s.match(/(?:over|mas de)\s*(\d+[.,]?\d*)/);
  if (m) return oneTeam ? null : { prob: poisson.over(num(m[1])), fuente: 'POISSON·xG' };
  m = s.match(/(?:under|menos de)\s*(\d+[.,]?\d*)/);
  if (m) return oneTeam ? null : { prob: 1 - poisson.over(num(m[1])), fuente: 'POISSON·xG' };

  // 1X2 / doble oportunidad
  const empate = /empate/.test(s);
  const p = probs;
  if (/\b1x\b/.test(s) || (hasL && empate && !hasV)) return { prob: (p.local + p.empate) / 100, fuente: 'MERCADO+MODELO' };
  if (/\bx2\b/.test(s) || (hasV && empate && !hasL)) return { prob: (p.empate + p.visitante) / 100, fuente: 'MERCADO+MODELO' };
  if (/\b12\b/.test(s) || (hasL && hasV && !empate)) return { prob: (p.local + p.visitante) / 100, fuente: 'MERCADO+MODELO' };
  if (empate && !hasL && !hasV) return { prob: p.empate / 100, fuente: 'MERCADO+MODELO' };
  if (hasL && !hasV) return { prob: p.local / 100, fuente: 'MERCADO+MODELO' };
  if (hasV && !hasL) return { prob: p.visitante / 100, fuente: 'MERCADO+MODELO' };
  return null;
}

// ---------- Promedios REALES desde los datos partido-a-partido ----------
// Los LLM son malos promediando: en vez de confiar en su "promedios", lo
// calculamos NOSOTROS desde los córners/remates partido a partido (forma), con
// dos ponderaciones legítimas:
//   • RECENCIA: los partidos más recientes pesan más (decaimiento geométrico).
//   • SEDE: los partidos jugados en la MISMA condición (local/visitante) que el
//     próximo partido pesan más — córners y remates dependen mucho de jugar en
//     casa o fuera.
// Devuelve también el tamaño de muestra EFECTIVO (Kish) por estadística, para
// encoger la confianza cuando hay pocos datos reales.
const RECENCY_DECAY = 0.82;   // peso_i = DECAY^i, i=0 = el más reciente
const VENUE_BOOST = 1.6;      // partidos de la misma sede pesan x1.6
// [claveSalida (en promedios), claveEntrada (en cada partido de forma)]
const FORMA_MAP = [
  ['corners_favor', 'corners'],
  ['corners_contra', 'corners_contra'],
  ['remates', 'remates'],
  ['remates_arco', 'remates_arco']
];

export function computeFormaStats(forma, venue) {
  const games = Array.isArray(forma) ? forma.slice(0, 5) : [];
  if (!games.length) return null;
  const anyVenue = games.some(g => g.sede === 'H' || g.sede === 'A');
  const weightOf = (g, i) => {
    const rec = Math.pow(RECENCY_DECAY, i);
    const ven = (anyVenue && venue && g.sede === venue) ? VENUE_BOOST : 1;
    return rec * ven;
  };
  const promedios = {}, ns = {};
  for (const [outKey, inKey] of FORMA_MAP) {
    let sw = 0, swx = 0, sw2 = 0;
    games.forEach((g, i) => {
      const x = Number(g[inKey]);
      if (!Number.isFinite(x) || x <= 0) return;   // dato ausente => no cuenta
      const w = weightOf(g, i);
      sw += w; swx += w * x; sw2 += w * w;
    });
    if (sw > 0) {
      promedios[outKey] = round2(swx / sw);
      ns[outKey] = round2((sw * sw) / sw2);   // tamaño de muestra efectivo (Kish)
    }
  }
  if (!Object.keys(promedios).length) return null;
  return { promedios, ns, venue: anyVenue };
}

// ---------- Rates λ por equipo desde promedios de los últimos partidos ----------
// Córners: mezcla lo que el equipo GENERA con lo que el rival CONCEDE (mitad y mitad).
// Remates: promedio propio (los datos de remates concedidos son menos fiables/disponibles).
// Devuelve null si no hay datos utilizables => los picks de córners/remates quedan sin ancla.
export function ratesFromAverages(promedios) {
  if (!promedios) return null;
  const g = (team, key, min, max) => {
    const v = Number(promedios?.[team]?.[key]);
    return Number.isFinite(v) && v > 0 ? clamp(v, min, max) : null;
  };
  const cf = { L: g('local', 'corners_favor', 0.5, 12), V: g('visitante', 'corners_favor', 0.5, 12) };
  const cc = { L: g('local', 'corners_contra', 0.5, 12), V: g('visitante', 'corners_contra', 0.5, 12) };
  const corners = {
    L: cf.L != null ? (cc.V != null ? (cf.L + cc.V) / 2 : cf.L) : null,
    V: cf.V != null ? (cc.L != null ? (cf.V + cc.L) / 2 : cf.V) : null
  };
  const remates = { L: g('local', 'remates', 2, 30), V: g('visitante', 'remates', 2, 30) };
  const rematesArco = { L: g('local', 'remates_arco', 0.5, 15), V: g('visitante', 'remates_arco', 0.5, 15) };
  const any = (o) => o.L != null || o.V != null;
  if (!any(corners) && !any(remates) && !any(rematesArco)) return null;
  return {
    corners: any(corners) ? corners : null,
    remates: any(remates) ? remates : null,
    rematesArco: any(rematesArco) ? rematesArco : null
  };
}

// ---------- Calibración: factor según tramo de confianza ----------
export function calibFactor(calib, conf) {
  if (!calib || !calib.total) return null;
  const b = (calib.buckets || []).find(b => conf >= b.min && conf < b.max);
  if (b && b.factor != null) return b.factor;
  return calib.global ?? null;
}

// ---------- Kelly fraccional (1/4) con tope por perfil; 0 si no hay ventaja ----------
export function kellyStake(prob, cuota, banca, capPct) {
  const b = cuota - 1;
  if (b <= 0 || !(prob > 0)) return 0;
  const f = (b * prob - (1 - prob)) / b;
  if (f <= 0) return 0;
  return round2(banca * Math.min(f / 4, capPct));
}

// ---------- Combinada reconstruida (modo ensemble): patas de mayor confianza ----------
export function buildCombinada(picks, perfil) {
  const nMax = perfil === 'agresivo' ? 4 : perfil === 'conservador' ? 2 : 3;
  const legs = [...picks]
    .sort((a, b) => (Number(b.confianza) || 0) - (Number(a.confianza) || 0))
    .slice(0, nMax)
    .map(p => ({ seleccion: p.seleccion, mercado: p.mercado, cuota: p.cuota }));
  return { patas: legs, cuota_total: 0, prob_estimada: 0 };
}

// ---------- Índice de confianza del análisis completo (0-100) ----------
export function computeConfidenceIndex(r, meta = {}, extra = {}) {
  const motivos = [];
  let score;
  if (meta.provider === 'demo') {
    score = 12; motivos.push('MODO DEMO: datos sintéticos, no apostar');
  } else if (extra.local) {
    score = 45; motivos.push('Motor local sin búsqueda web: datos estimados, no en vivo');
  } else {
    score = 88;
    const s = Number(meta.searches) || 0;
    if (s === 0) { score -= 22; motivos.push('El motor no ejecutó búsquedas web: datos posiblemente de memoria'); }
    else if (s >= 3) { score += 4; motivos.push(`${s} búsquedas web ejecutadas`); }
  }
  if (r.cuotas_estimadas) { score -= 12; motivos.push('Cuotas ESTIMADAS por el modelo, no confirmadas en casas'); }
  if (extra.divPoisson != null) {
    if (extra.divPoisson > 15) { score -= 18; motivos.push(`Modelo vs Poisson divergen ${extra.divPoisson}pp en el 1X2`); }
    else if (extra.divPoisson > 8) { score -= 8; motivos.push(`Modelo vs Poisson divergen ${extra.divPoisson}pp`); }
    else motivos.push(`Coherencia modelo↔Poisson OK (Δ ${extra.divPoisson}pp)`);
  }
  if (extra.divMercado != null) {
    if (extra.divMercado > 12) { score -= 10; motivos.push(`Modelo vs mercado divergen ${extra.divMercado}pp`); }
    else motivos.push(`Modelo alineado con el mercado (Δ ${extra.divMercado}pp)`);
  }
  const nContra = (r.contradicciones || []).length;
  if (nContra) { score -= 15 * nContra; motivos.push(`${nContra} contradicción(es) en la combinada`); }
  if ((extra.ensembleRuns || 0) >= 2) {
    if (extra.ensembleAgreement >= 0.99) { score += 7; motivos.push(`Ensemble x${extra.ensembleRuns}: los análisis coinciden`); }
    else if (extra.ensembleAgreement < 0.5) { score -= 12; motivos.push(`Ensemble x${extra.ensembleRuns}: los análisis discrepan entre sí`); }
    else motivos.push(`Ensemble x${extra.ensembleRuns}: acuerdo parcial`);
  }
  if (extra.calib && extra.calib.total >= 20 && extra.calib.global != null && extra.calib.global < 0.85) {
    score -= 8;
    motivos.push(`Historial real: el modelo sobreestima su confianza (factor ${extra.calib.global})`);
  }
  score = Math.round(clamp(score, 3, 97));
  const nivel = score >= 72 ? 'ALTA' : score >= 52 ? 'MEDIA' : 'BAJA';
  return { score, nivel, motivos };
}
