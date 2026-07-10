/* FIJALAB ✕ QUANT — frontend terminal */
'use strict';

const $ = (id) => document.getElementById(id);
const CLR = { green: '#00FF87', red: '#FF3B5C', amber: '#FFB300', cyan: '#00D9FF', purple: '#B266FF', yellow: '#FFE600', dim: '#5A5A5A', border: '#1C1C1C' };
const fmt = (n, d = 1) => Number(n).toFixed(d);
// Selecciones ambiguas ("Sí"/"No") se muestran con el mercado para que se entiendan.
const betLabel = (mercado, seleccion) => {
  const s = String(seleccion || '').trim();
  return /^(sí|si|no|yes)$/i.test(s) ? `${mercado}: ${s}` : s;
};
const nowTs = () => new Date().toLocaleTimeString('es-PE', { hour12: false });

let CONFIG = { demo: true, provider: 'DEMO', model: '—' };
let STATS = null;
let running = false;

/* ═══ RELOJ ═══ */
setInterval(() => { $('clock').textContent = nowTs(); }, 1000);
$('clock').textContent = nowTs();

/* ═══ TABS ═══ */
const VIEWS = ['dashboard', 'tournament', 'history'];
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    VIEWS.forEach(v => { $('view-' + v).style.display = view === v ? 'grid' : 'none'; });
    if (view === 'history') refreshHistoryView();
  });
});

/* ═══ TICKER ═══ */
function renderTicker() {
  const s = STATS || {};
  const chips = [
    `<span class="chip"><span class="dot-red"></span><span class="v red">LIVE</span></span>`,
    `<span class="chip"><span class="k">MOTOR</span><span class="v cyan">${CONFIG.provider} · ${CONFIG.model}</span></span>`,
    `<span class="chip"><span class="k">ACIERTO REAL</span><span class="v ${(s.winrate ?? 0) >= 50 ? 'green' : 'red'}">${s.winrate == null ? '—' : fmt(s.winrate) + '%'}</span></span>`,
    `<span class="chip"><span class="k">RACHA</span><span class="v ${s.streak?.type === 'GANADA' ? 'green' : s.streak?.type === 'PERDIDA' ? 'red' : 'dim'}">${s.streak?.type ? (s.streak.type === 'GANADA' ? 'W' : 'L') + s.streak.count : '—'}</span></span>`,
    `<span class="chip"><span class="k">PATAS MARCADAS</span><span class="v">${s.settled ?? 0}</span></span>`,
    `<span class="chip"><span class="k">PENDIENTES</span><span class="v amber">${s.pending ?? 0}</span></span>`,
    `<span class="chip"><span class="k">CALIBRACIÓN</span><span class="v ${s.calibracion?.global == null ? 'dim' : s.calibracion.global < 0.9 ? 'red' : 'green'}">${s.calibracion?.global == null ? 'JUNTANDO DATOS' : 'x' + s.calibracion.global + (s.calibracion.global < 0.9 ? ' SOBRECONFIADO' : ' OK')}</span></span>`,
    `<span class="chip"><span class="k">MODO</span><span class="v ${CONFIG.demo ? 'amber' : 'green'}">${CONFIG.demo ? 'DEMO — SIN API KEY' : 'API LIVE'}</span></span>`
  ].join('');
  $('tickerTrack').innerHTML = chips + chips; // duplicado para loop continuo
}

async function refreshConfig() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
    $('engineTag').textContent = `MOTOR: ${CONFIG.provider} · ${CONFIG.model}`;
    $('tEngineTag').textContent = `MOTOR: ${CONFIG.provider} · ${CONFIG.model}`;
    if (CONFIG.error) feedLine('ERR', `CONFIG: ${CONFIG.error}`, 'badge-red');
  } catch { /* offline */ }
}
async function refreshStats() {
  try { STATS = await (await fetch('/api/stats')).json(); } catch { /* offline */ }
  renderTicker();
}

/* ═══ FEED ═══ */
function feedLine(tag, text, badgeClass) {
  const cls = badgeClass || ({ PICK: 'badge-green', 'PICK+EV': 'badge-yellow', COMBI: 'badge-purple', ERR: 'badge-red', SYS: 'badge-cyan', INFO: 'badge-cyan', WARN: 'badge-amber' }[tag] || 'badge-cyan');
  const div = document.createElement('div');
  div.className = 'feed-line';
  div.innerHTML = `<span class="ftime">${nowTs()}</span><span class="badge ${cls}">${tag}</span><span class="ftxt">${text}</span>`;
  const feed = $('feed');
  feed.prepend(div);
  while (feed.children.length > 80) feed.lastChild.remove();
}

/* ═══ PIPELINE ═══ */
function pipeReset() {
  document.querySelectorAll('.pstep').forEach(el => el.classList.remove('active', 'done', 'error'));
  $('pipeElapsed').textContent = '';
}
function pipeSet(step) {
  document.querySelectorAll('.pstep').forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle('done', n < step);
    el.classList.toggle('active', n === step);
    if (n > step) el.classList.remove('done', 'active');
    el.classList.remove('error');
  });
}
function pipeDone() {
  document.querySelectorAll('.pstep').forEach(el => { el.classList.remove('active'); el.classList.add('done'); });
}
function pipeError() {
  const act = document.querySelector('.pstep.active');
  if (act) { act.classList.remove('active'); act.classList.add('error'); }
}

/* ═══ ANALIZAR (SSE sobre POST) ═══ */
$('analyzeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (running) return;
  running = true;
  $('btnAnalyze').disabled = true;
  $('btnAnalyze').textContent = '■ EJECUTANDO…';
  pipeReset();
  $('alertsList').innerHTML = '<span class="dim">validando…</span>';

  const payload = {
    local: $('inLocal').value, visitante: $('inVisitante').value,
    torneo: $('inTorneo').value, perfil: $('inPerfil').value
  };
  feedLine('SYS', `ORDEN: analizar ${payload.local} vs ${payload.visitante} · perfil ${payload.perfil.toUpperCase()}`);

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) handleEvent(JSON.parse(line.slice(6)));
      }
    }
  } catch (err) {
    pipeError();
    feedLine('ERR', `FALLO DE CONEXIÓN: ${err.message}`);
    renderAlerts([`Fallo de conexión con el backend: ${err.message}`], []);
  } finally {
    running = false;
    $('btnAnalyze').disabled = false;
    $('btnAnalyze').textContent = '▶ ANALIZAR';
  }
});

function handleEvent(ev) {
  switch (ev.type) {
    case 'step': pipeSet(ev.step); break;
    case 'tick': $('pipeElapsed').textContent = `T+${ev.elapsed}s — consultando motor de IA…`; break;
    case 'log': feedLine(ev.msg.startsWith('⚠') ? 'WARN' : 'INFO', ev.msg); break;
    case 'error':
      pipeError();
      feedLine('ERR', ev.message);
      renderAlerts([ev.message], []);
      break;
    case 'result':
      pipeDone();
      $('pipeElapsed').textContent = `COMPLETADO — análisis #${ev.analysisId}`;
      renderResult(ev.data, ev.meta, ev.banca);
      refreshStats();
      break;
  }
}

/* ═══ RENDER DEL RESULTADO ═══ */
function renderResult(r, meta, banca) {
  const P = r.partido;
  $('heroMatch').textContent = `${P.local} vs ${P.visitante}${P.torneo ? ' · ' + P.torneo : ''}`;

  // pick principal = mayor confianza
  const main = [...r.picks].sort((a, b) => b.confianza - a.confianza)[0];
  animateNumber($('heroConf'), main.confianza, 0);
  $('heroPick').textContent = `${betLabel(main.mercado, main.seleccion)} @ ${fmt(main.cuota, 2)}`;
  $('p1').textContent = fmt(r.prob.local, 0) + '%';
  $('pX').textContent = fmt(r.prob.empate, 0) + '%';
  $('p2').textContent = fmt(r.prob.visitante, 0) + '%';
  $('c1').textContent = '@ ' + fmt(r.cuotas?.local ?? 0, 2);
  $('cX').textContent = '@ ' + fmt(r.cuotas?.empate ?? 0, 2);
  $('c2').textContent = '@ ' + fmt(r.cuotas?.visitante ?? 0, 2);
  $('xgTxt').textContent = `${fmt(r.xg.local, 2)} / ${fmt(r.xg.visitante, 2)}`;
  $('resumenTxt').textContent = r.resumen || '—';

  renderForma(r, P);
  renderBuilder(r.combinada, banca);
  renderConfChart(r.picks);
  renderMatrix(r.picks);
  renderGauge(r);
  runMonteCarlo(r.xg.local, r.xg.visitante, r.prob);
  renderAlerts(r.advertencias || [], r.contradicciones || [], r);

  // feed: picks como órdenes
  for (const p of r.picks) {
    const valorTxt = p.valor ? 'CON VALOR ✓' : 'sin valor vs cuota';
    feedLine(p.valor ? 'PICK+EV' : 'PICK',
      `${p.seleccion} @ ${fmt(p.cuota, 2)} · conf ${fmt(p.confianza, 0)}% (IA ${fmt(p.confianza_modelo ?? p.confianza, 0)}%) · EV ${p.ev >= 0 ? '+' : ''}${fmt(p.ev, 1)}% · ${valorTxt} · riesgo ${p.riesgo.toUpperCase()}`);
  }
  if (r.fuentes?.length) feedLine('INFO', `FUENTES: ${r.fuentes.join(', ')}`);
  if (r.combinada) {
    feedLine('COMBI', `Bet Builder ${r.combinada.patas.length} patas · prob real ≈ ${fmt(r.combinada.prob_estimada, 0)}% · cuota mín. p/ valor @${fmt(r.combinada.cuota_justa ?? 0, 2)} (ingresa la cuota real para EV/stake)`);
  }
}

/* ═══ FORMA RECIENTE: últimos 5 partidos por equipo ═══ */
function renderForma(r, P) {
  const forma = r.forma, promedios = r.promedios;
  const panel = $('formaPanel');
  const hasData = forma && (forma.local?.length || forma.visitante?.length);
  if (!hasData) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  // muestra efectiva: la de cualquier pick de córners/remates ya ponderado
  const nEff = (r.picks || []).map(p => p.muestra_efectiva).find(n => Number.isFinite(n));
  const fuente = r.promedios_fuente === 'CALCULADO·SERVER'
    ? `promedios CALCULADOS server-side de los datos (recencia + sede${nEff ? ` · muestra efectiva ≈${fmt(nEff, 1)}` : ''})`
    : 'promedios estimados por el modelo (sin datos partido a partido)';
  $('formaMeta').textContent = fuente;

  const resBadge = (r) => r === 'G' ? '<span class="green">G</span>' : r === 'P' ? '<span class="red">P</span>' : r === 'E' ? '<span class="amber">E</span>' : '<span class="dim">?</span>';
  const sedeBadge = (s) => s === 'H' ? '<span class="cyan" title="jugó de local">CASA</span>' : s === 'A' ? '<span class="amber" title="jugó de visitante">FUERA</span>' : '<span class="dim">—</span>';
  const cell = (v) => v == null ? '<span class="dim">—</span>' : v;
  const table = (rows) => {
    if (!rows?.length) return '<tbody><tr><td class="dim empty">sin datos de forma</td></tr></tbody>';
    const head = '<thead><tr><th>RIVAL</th><th>SEDE</th><th>RES</th><th>MARC.</th><th>CÓRN.</th><th>C.CONTRA</th><th>REM.</th><th>AL ARCO</th></tr></thead>';
    const body = rows.map(m =>
      `<tr><td>${m.rival}</td><td>${sedeBadge(m.sede)}</td><td>${resBadge(m.res)}</td><td>${cell(m.marcador)}</td><td>${cell(m.corners)}</td><td>${cell(m.corners_contra)}</td><td>${cell(m.remates)}</td><td>${cell(m.remates_arco)}</td></tr>`
    ).join('');
    return head + '<tbody>' + body + '</tbody>';
  };
  const avgTxt = (a) => {
    if (!a) return 'sin promedios — mercados de córners/remates SIN ancla matemática';
    const f = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(1) : null;
    const parts = [];
    if (f(a.goles_favor)) parts.push(`goles ${f(a.goles_favor)}`);
    if (f(a.corners_favor)) parts.push(`córners ${f(a.corners_favor)}${f(a.corners_contra) ? ` (concede ${f(a.corners_contra)})` : ''}`);
    if (f(a.remates)) parts.push(`remates ${f(a.remates)}`);
    if (f(a.remates_arco)) parts.push(`al arco ${f(a.remates_arco)}`);
    return parts.length ? 'PROMEDIOS/5: ' + parts.join(' · ') : 'sin promedios utilizables';
  };
  $('formaLocalName').textContent = (P?.local || 'LOCAL').toUpperCase();
  $('formaVisName').textContent = (P?.visitante || 'VISITANTE').toUpperCase();
  $('formaLocal').innerHTML = table(forma.local);
  $('formaVis').innerHTML = table(forma.visitante);
  $('formaLocalAvg').textContent = avgTxt(promedios?.local);
  $('formaVisAvg').textContent = avgTxt(promedios?.visitante);
}

function animateNumber(el, target, decimals) {
  const t0 = performance.now(), dur = 900, from = 0;
  function frame(t) {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = (from + (target - from) * eased).toFixed(decimals);
    if (k < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// EV HONESTO del builder: se calcula contra la CUOTA REAL que ingresa el
// usuario (no contra el producto de cuotas, que la casa nunca paga en un builder).
function updateBuilderEV(prob) {
  const odds = Number($('combiRealOdds').value);
  const verdictEl = $('combiVerdict');
  if (!Number.isFinite(odds) || odds <= 1) {
    $('combiEv').textContent = '—'; $('combiEv').className = 'dim';
    verdictEl.textContent = '—'; verdictEl.className = 'dim';
    return;
  }
  const p = prob / 100;
  const ev = (p * odds - 1) * 100;
  $('combiEv').textContent = (ev >= 0 ? '+' : '') + fmt(ev, 1) + '%';
  $('combiEv').className = ev >= 0 ? 'green' : 'red';
  verdictEl.textContent = ev >= 3 ? 'VALE LA PENA ✓' : ev >= 0 ? 'JUSTA' : 'NO CONVIENE';
  verdictEl.className = ev >= 3 ? 'green' : ev >= 0 ? 'amber' : 'red';
}

function renderBuilder(c, banca) {
  const oddsEl = $('combiRealOdds');
  if (!c || !c.patas?.length) {
    $('combiMulti').textContent = 'X—';
    $('combiLegs').innerHTML = '<div class="dim empty">sin combinada</div>';
    $('combiProb').textContent = '--%'; $('combiVerdict').textContent = '—'; $('combiEv').textContent = '--%';
    $('combiFair').textContent = '—'; $('combiNota').textContent = '';
    oddsEl.value = ''; oddsEl.oninput = null;
    return;
  }
  $('combiMulti').textContent = 'X' + fmt(c.cuota_total, 2);
  $('combiMulti').title = `Cuota TEÓRICA (producto de las ${c.patas.length} patas). Un Bet Builder real paga MENOS por la correlación entre patas del mismo partido.`;
  $('combiPerfil').textContent = $('inPerfil').value.toUpperCase();
  $('combiLegs').innerHTML = c.patas.map(l =>
    `<div class="leg"><span class="lsel" title="${l.mercado}">${betLabel(l.mercado, l.seleccion)}</span><span class="lodd">@${fmt(l.cuota, 2)}</span></div>`
  ).join('');
  $('combiProb').textContent = fmt(c.prob_estimada, 0) + '%';
  $('combiProb').title = c.prob_independiente != null
    ? `Prob. de que pegue TODA la fija: ${fmt(c.prob_estimada, 0)}% (ajustada por correlación ρ=${c.correlacion}). Si las patas fueran independientes: ${fmt(c.prob_independiente, 0)}%.`
    : '';
  const fair = c.cuota_justa ?? (c.prob_estimada ? 100 / c.prob_estimada : null);
  $('combiFair').textContent = fair ? '@' + fmt(fair, 2) : '—';
  $('combiFair').title = 'Cuota mínima que la casa debe pagar para que la fija tenga valor esperado positivo.';
  $('combiNota').textContent = c.nota || '';
  // EV se calcula contra la cuota real que escriba el usuario
  oddsEl.value = '';
  const recompute = () => updateBuilderEV(c.prob_estimada);
  oddsEl.oninput = recompute;
  recompute();
}

/* ═══ CANVAS: helpers ═══ */
function setupCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth - 24;
  canvas.width = w * dpr; canvas.height = cssH * dpr;
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = '9px "JetBrains Mono", monospace';
  return { ctx, w, h: cssH };
}

function confColor(v) { return v >= 68 ? CLR.green : v >= 55 ? CLR.amber : CLR.red; }

function renderConfChart(picks) {
  const { ctx, w, h } = setupCanvas($('confChart'), 190);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 8, r: 8, t: 10, b: 26 };
  const bw = (w - pad.l - pad.r) / picks.length;
  // guías
  ctx.strokeStyle = '#111'; ctx.setLineDash([3, 4]);
  [25, 50, 75, 100].forEach(v => {
    const y = pad.t + (h - pad.t - pad.b) * (1 - v / 100);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = CLR.dim; ctx.fillText(String(v), pad.l, y - 2);
  });
  ctx.setLineDash([]);
  picks.forEach((p, i) => {
    const x = pad.l + i * bw + bw * 0.18;
    const bh = (h - pad.t - pad.b) * (p.confianza / 100);
    const y = h - pad.b - bh;
    const col = confColor(p.confianza);
    const grad = ctx.createLinearGradient(0, y, 0, h - pad.b);
    grad.addColorStop(0, col); grad.addColorStop(1, col + '22');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, bw * 0.64, bh);
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillText(fmt(p.confianza, 0), x + bw * 0.32, y - 4);
    ctx.fillStyle = CLR.dim; ctx.font = '8px "JetBrains Mono", monospace';
    const label = (p.tipo || p.mercado).toUpperCase().slice(0, 10);
    ctx.fillText(label, x + bw * 0.32, h - pad.b + 12);
    if (p.valor) { ctx.fillStyle = CLR.yellow; ctx.fillText('+EV', x + bw * 0.32, h - pad.b + 22); }
    ctx.textAlign = 'left';
  });
}

function renderMatrix(picks) {
  const tb = $('matrix').querySelector('tbody');
  tb.innerHTML = picks.map(p => {
    const cCls = p.confianza >= 68 ? 'cell-good' : p.confianza >= 55 ? 'cell-mid' : 'cell-bad';
    const eCls = p.ev >= 3 ? 'cell-good' : p.ev >= 0 ? 'cell-mid' : 'cell-bad';
    const rCls = p.riesgo === 'bajo' ? 'cell-good' : p.riesgo === 'medio' ? 'cell-mid' : 'cell-bad';
    const fuente = p.fuente_prob ? ` · ajuste: ${p.fuente_prob}` : '';
    return `<tr title="${((p.razon || '') + fuente).replace(/"/g, '&quot;')}">
      <td class="dim">${p.mercado}</td>
      <td>${p.seleccion}</td>
      <td class="dim">${fmt(p.confianza_modelo ?? p.confianza, 0)}%</td>
      <td class="${cCls}">${fmt(p.confianza, 0)}%</td>
      <td class="amber">${fmt(p.cuota, 2)}</td>
      <td class="dim">${fmt(p.cuota_justa ?? (100 / p.confianza), 2)}</td>
      <td class="${eCls}">${p.ev >= 0 ? '+' : ''}${fmt(p.ev, 1)}%${p.valor ? ' ✓' : ''}</td>
      <td class="${p.en_fija ? 'cell-fija' : p.valor ? 'cell-good' : 'dim'}">${p.en_fija ? '★ EN FIJA' : p.valor ? 'CANDIDATO' : '—'}</td>
      <td class="${rCls}">${(p.riesgo || '—').toUpperCase()}</td>
    </tr>`;
  }).join('');
}

function renderGauge(r) {
  const idx = r.indice_confianza;
  const score = idx ? idx.score : r.picks.reduce((s, p) => s + p.confianza, 0) / r.picks.length;
  const C = 2 * Math.PI * 50;
  const arc = $('gaugeArc');
  arc.style.strokeDashoffset = C * (1 - score / 100);
  arc.style.stroke = confColor(score);
  animateNumber($('gaugeNum'), score, 0);
  $('gaugeVerdict').textContent = idx
    ? `CONFIANZA ${idx.nivel}`
    : (score >= 68 ? 'SEÑAL FUERTE' : score >= 55 ? 'SEÑAL MODERADA' : 'SEÑAL DÉBIL');
  $('gaugeVerdict').style.color = confColor(score);
  $('gaugeReasons').innerHTML = (idx?.motivos || []).slice(0, 4).map(m => `<div>· ${m}</div>`).join('');
}

/* ═══ MONTE CARLO (Poisson real, 5000 sims) ═══ */
function poissonSample(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function runMonteCarlo(xgL, xgV, modelProb) {
  const N = 5000;
  const totals = new Array(11).fill(0); // 0..9, 10+
  const scores = new Map();
  let over25 = 0, btts = 0, hw = 0, dr = 0, aw = 0;
  for (let i = 0; i < N; i++) {
    const gl = poissonSample(xgL), gv = poissonSample(xgV);
    const tot = gl + gv;
    totals[Math.min(tot, 10)]++;
    if (tot > 2.5) over25++;
    if (gl > 0 && gv > 0) btts++;
    if (gl > gv) hw++; else if (gl === gv) dr++; else aw++;
    const key = `${gl}-${gv}`;
    scores.set(key, (scores.get(key) || 0) + 1);
  }
  const topScore = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];

  $('mcOver').textContent = fmt(over25 / N * 100, 1) + '%';
  $('mcUnder').textContent = fmt((1 - over25 / N) * 100, 1) + '%';
  $('mcBtts').textContent = fmt(btts / N * 100, 1) + '%';
  $('mcScore').textContent = `${topScore[0]} (${fmt(topScore[1] / N * 100, 1)}%)`;
  $('mcSelf').textContent = `${fmt(hw / N * 100, 0)}/${fmt(dr / N * 100, 0)}/${fmt(aw / N * 100, 0)}`;
  const delta = Math.abs(hw / N * 100 - modelProb.local) + Math.abs(dr / N * 100 - modelProb.empate) + Math.abs(aw / N * 100 - modelProb.visitante);
  $('mcMeta').textContent = `xG ${fmt(xgL, 2)}–${fmt(xgV, 2)} · Δ self-check ${fmt(delta / 3, 1)}pp ${delta / 3 < 8 ? '✓ coherente' : '⚠ divergente'}`;

  // histograma
  const { ctx, w, h } = setupCanvas($('mcChart'), 150);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 8, r: 8, t: 14, b: 18 };
  const max = Math.max(...totals);
  const bw = (w - pad.l - pad.r) / totals.length;
  totals.forEach((cnt, g) => {
    const bh = (h - pad.t - pad.b) * (cnt / max);
    const x = pad.l + g * bw + bw * 0.12;
    const y = h - pad.b - bh;
    const isOverLine = g >= 3;
    const col = isOverLine ? CLR.green : CLR.red;
    const grad = ctx.createLinearGradient(0, y, 0, h - pad.b);
    grad.addColorStop(0, col); grad.addColorStop(1, col + '18');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, bw * 0.76, bh);
    ctx.fillStyle = CLR.dim; ctx.textAlign = 'center'; ctx.font = '8.5px "JetBrains Mono", monospace';
    ctx.fillText(g === 10 ? '10+' : String(g), x + bw * 0.38, h - 5);
    if (cnt / max > 0.12) {
      ctx.fillStyle = col; ctx.fillText(fmt(cnt / 5000 * 100, 0) + '%', x + bw * 0.38, y - 3);
    }
  });
  // línea 2.5
  const xLine = pad.l + 3 * bw - bw * 0.06;
  ctx.strokeStyle = CLR.yellow; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(xLine, pad.t - 4); ctx.lineTo(xLine, h - pad.b); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CLR.yellow; ctx.textAlign = 'left';
  ctx.fillText('LÍNEA 2.5', xLine + 4, pad.t + 2);
}

/* ═══ ALERTAS ═══ */
function renderAlerts(advertencias, contradicciones, r) {
  const items = [];
  for (const c of contradicciones) items.push(`<div class="alert-line">⛔ <span>${c}</span></div>`);
  for (const a of advertencias) {
    if (contradicciones.includes(a)) continue;
    items.push(`<div class="alert-line warn">⚠ <span>${a}</span></div>`);
  }
  const idx = r?.indice_confianza;
  if (idx) {
    for (const m of idx.motivos || []) items.push(`<div class="alert-line info">ℹ <span>${m}</span></div>`);
  }
  if (r?.prob_mercado) {
    items.push(`<div class="alert-line info">ℹ <span>Mercado (de-vig): ${fmt(r.prob_mercado.local, 0)}/${fmt(r.prob_mercado.empate, 0)}/${fmt(r.prob_mercado.visitante, 0)} · margen casa ${fmt(r.prob_mercado.overround, 1)}%</span></div>`);
  }
  $('alertsList').innerHTML = items.length
    ? items.join('')
    : '<span class="green" style="font-size:11px">✓ SIN CONTRADICCIONES — combinada estructuralmente válida</span>';
}

/* ═══ HISTORIAL ═══ */
async function refreshHistoryView() {
  await refreshStats();
  renderStatsView();
  renderCalibChart();
  renderMarketTable();
  await renderHistory();
}

function renderStatsView() {
  const s = STATS || {};
  $('statMeta').textContent = `${s.settled ?? 0} patas marcadas · ${s.pending ?? 0} pendientes`;
  $('stWinrate').textContent = s.winrate == null ? '—' : fmt(s.winrate) + '%';
  $('stWinrate').style.color = (s.winrate ?? 0) >= 50 ? CLR.green : CLR.red;
  $('stGP').textContent = `${s.won ?? 0} / ${s.lost ?? 0}`;
  $('stStreak').textContent = s.streak?.type ? (s.streak.type === 'GANADA' ? 'W' : 'L') + s.streak.count : '—';
  $('stStreak').style.color = s.streak?.type === 'GANADA' ? CLR.green : s.streak?.type === 'PERDIDA' ? CLR.red : CLR.dim;
  const g = s.calibracion?.global;
  $('stCalib').textContent = g == null ? '—' : 'x' + g;
  $('stCalib').style.color = g == null ? CLR.dim : g < 0.9 ? CLR.red : g > 1.05 ? CLR.amber : CLR.green;
}

// Calibración: por cada tramo de confianza, barra de lo DECLARADO (lo que el bot
// dijo) vs lo REAL (lo que acertó). Si la barra real queda por debajo de la
// declarada, el bot está sobreconfiado en ese tramo.
function renderCalibChart() {
  const { ctx, w, h } = setupCanvas($('calibChart'), 190);
  ctx.clearRect(0, 0, w, h);
  const cal = STATS?.calibracion;
  const buckets = (cal?.buckets || []).filter(b => b.n > 0);
  const pad = { l: 34, r: 10, t: 14, b: 34 };
  const plotH = h - pad.t - pad.b;
  const Y = (frac) => pad.t + plotH * (1 - frac);
  // guías horizontales 0-100%
  ctx.strokeStyle = '#111'; ctx.setLineDash([3, 4]);
  ctx.textAlign = 'right'; ctx.fillStyle = CLR.dim;
  for (let g = 0; g <= 4; g++) {
    const frac = g / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(frac)); ctx.lineTo(w - pad.r, Y(frac)); ctx.stroke();
    ctx.fillText(Math.round(frac * 100) + '%', pad.l - 4, Y(frac) + 3);
  }
  ctx.setLineDash([]); ctx.textAlign = 'center';
  if (!buckets.length) {
    ctx.fillStyle = CLR.dim; ctx.textAlign = 'left';
    ctx.fillText('marca patas como G/P para ver si el bot está bien calibrado', pad.l, h / 2);
    return;
  }
  const slot = (w - pad.l - pad.r) / buckets.length;
  buckets.forEach((b, i) => {
    const cx = pad.l + slot * (i + 0.5);
    const bw = Math.min(26, slot * 0.32);
    const declarado = (b.confSum / b.n) / 100;      // confianza media que el bot declaró
    const real = b.wins / b.n;                        // acierto real
    // barra declarada (fantasma) y real (sólida)
    ctx.fillStyle = CLR.dim + '55';
    ctx.fillRect(cx - bw - 2, Y(declarado), bw, Y(0) - Y(declarado));
    const col = real >= declarado - 0.05 ? CLR.green : CLR.red;
    ctx.fillStyle = col;
    ctx.fillRect(cx + 2, Y(real), bw, Y(0) - Y(real));
    // etiquetas de tramo y n
    ctx.fillStyle = CLR.dim; ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(`${b.min}-${b.max === 101 ? '100' : b.max}%`, cx, h - pad.b + 14);
    ctx.fillText(`n=${b.n}`, cx, h - pad.b + 25);
  });
  // leyenda
  ctx.textAlign = 'left'; ctx.font = '9px "JetBrains Mono", monospace';
  ctx.fillStyle = CLR.dim; ctx.fillText('▪ declarado', pad.l, 10);
  ctx.fillStyle = CLR.green; ctx.fillText('▪ acierto real', pad.l + 68, 10);
}

function renderMarketTable() {
  const tb = $('marketTable').querySelector('tbody');
  const rows = STATS?.byMarket || [];
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="dim empty">sin patas marcadas</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(m => `<tr>
    <td><span class="badge ${{ GANADOR: 'badge-cyan', GOLES: 'badge-green', 'CÓRNERS': 'badge-purple', ANOTADOR: 'badge-red', TIROS: 'badge-amber', COMBINADA: 'badge-yellow', OTROS: 'badge-amber' }[m.mercado] || 'badge-cyan'}">${m.mercado}</span></td>
    <td>${m.total}</td>
    <td class="cell-good">${m.ganadas}</td>
    <td class="cell-bad">${m.perdidas}</td>
    <td class="${m.winrate == null ? 'dim' : m.winrate >= 50 ? 'cell-good' : 'cell-bad'}">${m.winrate == null ? '—' : fmt(m.winrate) + '%'}</td>
  </tr>`).join('');
}

// Etiqueta corta de mercado para el badge del historial
function mercadoTag(mercado) {
  const m = (mercado || '').toLowerCase();
  if (/c[oó]rner|esquina/.test(m)) return 'CÓRNER';
  if (/tiro|remate|disparo/.test(m)) return 'REMATE';
  if (/gol|over|under|ambos|btts/.test(m)) return 'GOL';
  if (/goleador|anotador|anota/.test(m)) return 'GOLEADOR';
  if (/ganador|doble|1x2|oportunidad/.test(m)) return 'GANADOR';
  return 'PICK';
}

async function renderHistory() {
  const { analyses } = await (await fetch('/api/history')).json();
  const box = $('historyList');
  if (!analyses.length) {
    box.innerHTML = '<div class="dim empty">sin análisis registrados todavía</div>';
    return;
  }
  box.innerHTML = analyses.map(a => {
    const picks = a.picks || [];
    const g = picks.filter(p => p.estado === 'GANADA').length;
    const pl = picks.filter(p => p.estado === 'PERDIDA').length;
    const pend = picks.filter(p => p.estado === 'PENDIENTE').length;
    return `
    <div class="hcard">
      <div class="hcard-head">
        <span class="hcard-title">${a.local} <span class="dim">vs</span> ${a.visitante}
          <span class="badge badge-cyan">${a.torneo || 's/torneo'}</span>
          <span class="badge badge-green" title="patas acertadas">✓ ${g}</span>
          <span class="badge badge-red" title="patas falladas">✗ ${pl}</span>
          <span class="badge badge-cyan" title="patas pendientes">◷ ${pend}</span>
        </span>
        <span class="dim" style="font-size:10px">#${a.id} · ${a.created_at} · ${picks.length} patas · motor: ${a.proveedor}</span>
      </div>
      ${picks.map(p => `
        <div class="hpick ${p.estado === 'GANADA' ? 'won' : p.estado === 'PERDIDA' ? 'lost' : ''}">
          <span class="badge ${p.tipo === 'COMBI' ? 'badge-purple' : 'badge-green'}">${p.tipo === 'COMBI' ? 'FIJA' : mercadoTag(p.mercado)}</span>
          <span class="psel">${p.seleccion}</span>
          <span class="podd">@${fmt(p.cuota, 2)}</span>
          <span class="settle">
            <button class="sbtn g ${p.estado === 'GANADA' ? 'on' : ''}" onclick="settle(${p.id},'GANADA')" title="Acertó">G</button>
            <button class="sbtn p ${p.estado === 'PERDIDA' ? 'on' : ''}" onclick="settle(${p.id},'PERDIDA')" title="Falló">P</button>
            <button class="sbtn n ${p.estado === 'NULA' ? 'on' : ''}" onclick="settle(${p.id},'NULA')" title="Nula/anulada">N</button>
          </span>
        </div>`).join('')}
    </div>`;
  }).join('');
}

window.settle = async function (pickId, estado) {
  const res = await fetch(`/api/picks/${pickId}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado })
  });
  const json = await res.json();
  if (!json.ok) { feedLine('ERR', json.error); return; }
  await refreshHistoryView();
};

/* ═══════════ MODO TORNEO ═══════════ */
const RONDA_PAIRS = { 'Cuartos de final': 4, 'Semifinales': 2, 'Final': 1 };
const TORNEO_PH = ['Argentina', 'Francia', 'Brasil', 'Inglaterra', 'España', 'Portugal', 'Países Bajos', 'Alemania'];
let tRunning = false;

function renderBracketInputs() {
  const nPairs = RONDA_PAIRS[$('tRonda').value] || 4;
  const box = $('bracketInput');
  let html = '';
  for (let p = 0; p < nPairs; p++) {
    const iA = p * 2, iB = p * 2 + 1;
    html += `<div class="pair-row">
      <span class="pair-tag">LLAVE ${p + 1}</span>
      <input class="pair-input" id="tTeam${iA}" type="text" placeholder="${TORNEO_PH[iA] || 'Equipo'}" autocomplete="off" />
      <span class="pair-vs">vs</span>
      <input class="pair-input" id="tTeam${iB}" type="text" placeholder="${TORNEO_PH[iB] || 'Equipo'}" autocomplete="off" />
    </div>`;
  }
  box.innerHTML = html;
}

function tPipeReset() {
  $('tPipeline').querySelectorAll('.pstep').forEach(el => el.classList.remove('active', 'done', 'error'));
  $('tPipeElapsed').textContent = '';
}
function tPipeSet(step) {
  $('tPipeline').querySelectorAll('.pstep').forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle('done', n < step);
    el.classList.toggle('active', n === step);
    if (n > step) el.classList.remove('done', 'active');
  });
}
function tPipeDone() { $('tPipeline').querySelectorAll('.pstep').forEach(el => { el.classList.remove('active'); el.classList.add('done'); }); }
function tPipeError() { const a = $('tPipeline').querySelector('.pstep.active'); if (a) { a.classList.remove('active'); a.classList.add('error'); } }

// Un partido de eliminación: Poisson por xG; empate => penales ponderados por "fuerza".
// FACTOR SORPRESA (momentum -100..+100): cuánto por encima/debajo de su nivel viene
// jugando el equipo. Desplaza su ataque Y su solidez defensiva (±30% máx) y pesa en
// los penales => un matagigantes en racha (ej. Cabo Verde) da más batacazos reales.
function simMatch(A, B) {
  const fA = 1 + (A.momentum ?? 0) / 100 * 0.3;
  const fB = 1 + (B.momentum ?? 0) / 100 * 0.3;
  const lamA = Math.max(0.05, (A.ataque * fA + B.defensa / fB) / 2);
  const lamB = Math.max(0.05, (B.ataque * fB + A.defensa / fA) / 2);
  const ga = poissonSample(lamA), gb = poissonSample(lamB);
  if (ga === gb) {
    const wA = A.fuerza * fA, wB = B.fuerza * fB;
    return Math.random() < wA / (wA + wB) ? A : B;
  }
  return ga > gb ? A : B;
}

// Monte Carlo del bracket: equipos en orden de llaves (pares consecutivos).
// reach[r][i] = veces que el equipo i superó r rondas (reach[0] = participa = N).
function simulateTournament(equipos, N) {
  const n = equipos.length;
  const R = Math.round(Math.log2(n));
  const idx = new Map(equipos.map((e, i) => [e.nombre, i]));
  const reach = Array.from({ length: R + 1 }, () => new Array(n).fill(0));
  reach[0].fill(N);
  for (let s = 0; s < N; s++) {
    let round = equipos, r = 0;
    while (round.length > 1) {
      const next = [];
      for (let i = 0; i < round.length; i += 2) next.push(simMatch(round[i], round[i + 1]));
      r++;
      for (const t of next) reach[r][idx.get(t.nombre)]++;
      round = next;
    }
  }
  return equipos.map((e, i) => ({
    ...e,
    reach: reach.map(row => row[i] / N * 100), // % de superar cada ronda
    pTitulo: reach[R][i] / N * 100,
    pFinal: reach[Math.max(R - 1, 0)][i] / N * 100,
    pLlave: reach[Math.min(1, R)][i] / N * 100
  }));
}

function renderTournament(data, meta, params) {
  const N = 10000;
  const sim = simulateTournament(data.equipos, N);
  const ranked = [...sim].sort((a, b) => b.pTitulo - a.pTitulo);
  const champTeam = ranked[0];

  // Campeón proyectado
  $('tChampName').textContent = champTeam.nombre;
  $('tChampPct').textContent = fmt(champTeam.pTitulo, 1) + '%';
  $('tChampMeta').textContent = `${params.torneo || params.ronda} · motor ${meta.label}`;
  $('tResumen').textContent = data.resumen || '—';
  $('tRankMeta').textContent = `${data.equipos.length} equipos · ${N.toLocaleString('es-PE')} sims`;

  // Barras de probabilidad de título
  const maxP = Math.max(...ranked.map(t => t.pTitulo), 1);
  $('champBars').innerHTML = ranked.map((t, i) => {
    const col = i === 0 ? CLR.green : i === 1 ? CLR.cyan : i === 2 ? CLR.amber : CLR.dim;
    return `<div class="cbar-row">
      <span class="cbar-rank">${i + 1}</span>
      <span class="cbar-name">${t.nombre}</span>
      <span class="cbar-track"><span class="cbar-fill" style="width:${t.pTitulo / maxP * 100}%;background:${col}"></span></span>
      <span class="cbar-pct" style="color:${col}">${fmt(t.pTitulo, 1)}%</span>
    </div>`;
  }).join('');

  // Bracket árbol animado: se guarda el estado y aparece el botón de lanzamiento
  bState = { sim, ranked, params, N, rounds: null };
  $('bracketStage').innerHTML = `<div class="blaunch">
    <button type="button" id="btnBracketGo" class="blaunch-btn">▶ SIMULAR ${params.ronda.toUpperCase()}</button>
    <div class="blaunch-hint dim">avance proyectado cruce a cruce · % del enfrentamiento directo · 10,000 sims por cruce</div>
  </div>`;
  $('btnBracketGo').addEventListener('click', launchBracket);
  $('tBracketMeta').textContent = `${sim.length} equipos rateados · pulsa el botón para ver el camino al título`;

  // Tabla de ratings
  $('ratingsTable').querySelector('tbody').innerHTML = ranked.map(t => `<tr title="${(t.nota || '').replace(/"/g, '&quot;')}">
    <td>${t.nombre}</td>
    <td class="green">${fmt(t.ataque, 2)}</td>
    <td class="${t.defensa <= 1 ? 'green' : t.defensa <= 1.4 ? 'amber' : 'red'}">${fmt(t.defensa, 2)}</td>
    <td class="cyan">${t.fuerza}</td>
    <td class="${(t.momentum ?? 0) >= 30 ? 'green' : (t.momentum ?? 0) <= -30 ? 'red' : 'dim'}">${(t.momentum ?? 0) > 0 ? '+' : ''}${t.momentum ?? 0}${(t.momentum ?? 0) >= 50 ? ' ⚡' : (t.momentum ?? 0) <= -50 ? ' 🔻' : ''}</td>
    <td class="cell-good">${fmt(t.pTitulo, 1)}%</td>
    <td class="amber">${fmt(t.pFinal, 0)}%</td>
    <td class="dim">${t.nota || '—'}</td>
  </tr>`).join('');

  feedLine('SYS', `TORNEO simulado: campeón más probable ${champTeam.nombre} (${fmt(champTeam.pTitulo, 1)}%)`, 'badge-purple');
}

/* ═══ BRACKET ÁRBOL ANIMADO ═══ */
let bState = null, bAnimating = false;
const bSleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROUND_LABELS = { 3: ['CUARTOS', 'SEMIFINAL', 'FINAL'], 2: ['SEMIFINAL', 'FINAL'], 1: ['FINAL'] };

// % real del cruce CONCRETO A vs B: mini Monte Carlo del partido (Poisson + momentum + penales)
function h2hProb(A, B, n = 10000) {
  let w = 0;
  for (let i = 0; i < n; i++) if (simMatch(A, B) === A) w++;
  return w / n * 100;
}

// Camino proyectado: en cada cruce avanza el favorito del enfrentamiento directo
function buildBracketPath(sim) {
  const rounds = [];
  let alive = sim;
  while (alive.length > 1) {
    const matches = [];
    const next = [];
    for (let i = 0; i < alive.length; i += 2) {
      const A = alive[i], B = alive[i + 1];
      const pA = h2hProb(A, B);
      const winner = pA >= 50 ? A : B;
      matches.push({ A, B, pA, pB: 100 - pA, winner });
      next.push(winner);
    }
    rounds.push(matches);
    alive = next;
  }
  return rounds;
}

const bmEl = (r, m) => document.getElementById(`bm-${r}-${m}`);

function bmatchHtml(r, m, label, isFinal) {
  const teamRow = (side) => `<div class="bm-team" data-side="${side}">
    <span class="bm-name dim">POR DEFINIR</span><span class="bm-pct">—</span>
    <span class="bm-bar"><span class="bm-fill"></span></span></div>`;
  return `<div class="bmatch${isFinal ? ' bm-final' : ''}" id="bm-${r}-${m}">
    <div class="bm-head"><span>${isFinal ? '🏆 FINAL' : `${label} · M${m + 1}`}</span></div>
    ${teamRow('A')}${teamRow('B')}</div>`;
}

function setTeam(r, m, side, name) {
  const el = bmEl(r, m).querySelector(`.bm-team[data-side="${side}"] .bm-name`);
  el.textContent = name;
  el.classList.remove('dim');
}

// Árbol con la final al centro: mitad izquierda → FINAL ← mitad derecha (espejo)
function renderBracketTree(rounds, params) {
  const R = rounds.length;
  const labels = ROUND_LABELS[R] || rounds.map((_, i) => `RONDA ${i + 1}`);
  const cols = [], widths = [];
  const colHtml = (inner, head, extra = '') =>
    `<div class="btree-col ${extra}"><div class="btree-head">${head}</div><div class="btree-body">${inner}</div></div>`;
  const connHtml = (srcCount, side) => srcCount <= 1
    ? `<div class="btree-conn"><div class="bconn-h"></div></div>`
    : `<div class="btree-conn">${Array.from({ length: srcCount / 2 }, () =>
        `<div class="bconn-elbow ${side === 'L' ? 'el-l' : 'el-r'}" style="height:${100 / srcCount}%"></div>`).join('')}</div>`;

  for (let r = 0; r < R - 1; r++) { // lado izquierdo
    const half = rounds[r].length / 2;
    cols.push(colHtml(rounds[r].slice(0, half).map((_, m) => bmatchHtml(r, m, labels[r], false)).join(''), labels[r]));
    widths.push('1fr');
    cols.push(connHtml(half, 'L')); widths.push('26px');
  }
  cols.push(colHtml(bmatchHtml(R - 1, 0, 'FINAL', true), 'FINAL', 'btree-center')); widths.push('1.15fr');
  for (let r = R - 2; r >= 0; r--) { // lado derecho (espejo)
    const half = rounds[r].length / 2;
    cols.push(connHtml(half, 'R')); widths.push('26px');
    cols.push(colHtml(rounds[r].slice(half).map((_, k) => bmatchHtml(r, half + k, labels[r], false)).join(''), labels[r]));
    widths.push('1fr');
  }
  $('bracketStage').innerHTML = `<div class="btree" style="grid-template-columns:${widths.join(' ')}">${cols.join('')}</div>`;
  rounds[0].forEach((mt, m) => { setTeam(0, m, 'A', mt.A.nombre); setTeam(0, m, 'B', mt.B.nombre); });
  $('tBracketMeta').textContent = `% = probabilidad del cruce directo · verde = avanza · ${(params.torneo || params.ronda)}`;
}

function countUp(el, target, ms = 700) {
  return new Promise(res => {
    const t0 = performance.now();
    (function tick(t) {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = (target * (1 - Math.pow(1 - k, 3))).toFixed(0) + '%';
      if (k < 1) requestAnimationFrame(tick); else res();
    })(t0);
  });
}

async function resolveMatch(r, m, mt, hasNext) {
  const card = bmEl(r, m);
  card.classList.add('resolving');
  const rowA = card.querySelector('[data-side="A"]'), rowB = card.querySelector('[data-side="B"]');
  rowA.querySelector('.bm-fill').style.width = mt.pA + '%';
  rowB.querySelector('.bm-fill').style.width = mt.pB + '%';
  await Promise.all([
    countUp(rowA.querySelector('.bm-pct'), mt.pA),
    countUp(rowB.querySelector('.bm-pct'), mt.pB)
  ]);
  const winA = mt.winner === mt.A;
  (winA ? rowA : rowB).classList.add('win');
  (winA ? rowB : rowA).classList.add('lose');
  card.classList.remove('resolving');
  card.classList.add('done');
  await bSleep(350);
  if (hasNext) {
    const nm = Math.floor(m / 2), side = m % 2 === 0 ? 'A' : 'B';
    setTeam(r + 1, nm, side, mt.winner.nombre);
    const row = bmEl(r + 1, nm).querySelector(`[data-side="${side}"]`);
    row.classList.add('arrive');
    setTimeout(() => row.classList.remove('arrive'), 900);
  }
}

async function launchBracket() {
  if (!bState || bAnimating) return;
  bAnimating = true;
  try {
    if (!bState.rounds) bState.rounds = buildBracketPath(bState.sim); // se calcula 1 vez por análisis
    const rounds = bState.rounds;
    renderBracketTree(rounds, bState.params);
    feedLine('SYS', `BRACKET: resolviendo ${rounds.reduce((s, r) => s + r.length, 0)} cruces — avanza el favorito de cada enfrentamiento`, 'badge-purple');
    await bSleep(600);
    const R = rounds.length;
    for (let r = 0; r < R; r++) {
      for (let m = 0; m < rounds[r].length; m++) {
        await resolveMatch(r, m, rounds[r][m], r < R - 1);
        await bSleep(300);
      }
      if (r < R - 1) await bSleep(850);
    }
    await bSleep(500);
    celebrateChampion(rounds[R - 1][0]);
  } finally { bAnimating = false; }
}

function celebrateChampion(finalMt) {
  const champ = finalMt.winner;
  const loser = champ === finalMt.A ? finalMt.B : finalMt.A;
  const pFinal = champ === finalMt.A ? finalMt.pA : finalMt.pB;
  const t = bState.ranked.find(x => x.nombre === champ.nombre);
  const ov = document.createElement('div');
  ov.className = 'bchamp-ov';
  ov.innerHTML = `
    <div class="bconfetti"></div>
    <div class="bchamp-card">
      <div class="bchamp-troph">🏆</div>
      <div class="bchamp-name">${champ.nombre.toUpperCase()}</div>
      <div class="bchamp-sub">¡CAMPEÓN${bState.params.torneo ? ' · ' + bState.params.torneo.toUpperCase() : ''}!</div>
      <div class="bchamp-line dim">venció a ${loser.nombre} en la final (${fmt(pFinal, 0)}% del cruce) · ${fmt(t?.pTitulo ?? 0, 1)}% de título en ${bState.N.toLocaleString('es-PE')} sims</div>
      <div class="bchamp-actions">
        <button type="button" class="bch-btn" id="bchClose">VER BRACKET</button>
        <button type="button" class="bch-btn bch-replay" id="bchReplay">↻ REPETIR</button>
      </div>
    </div>`;
  $('bracketStage').appendChild(ov);
  spawnConfetti(ov.querySelector('.bconfetti'));
  ov.querySelector('#bchClose').addEventListener('click', () => ov.remove());
  ov.querySelector('#bchReplay').addEventListener('click', () => { ov.remove(); launchBracket(); });
  feedLine('SYS', `🏆 CAMINO AL TÍTULO: ${champ.nombre} campeón proyectado — venció a ${loser.nombre} en la final`, 'badge-purple');
}

function spawnConfetti(box) {
  const colors = [CLR.green, CLR.cyan, CLR.amber, CLR.purple, '#ffffff'];
  for (let i = 0; i < 90; i++) {
    const s = document.createElement('span');
    s.className = 'bconf';
    s.style.left = Math.random() * 100 + '%';
    s.style.background = colors[i % colors.length];
    s.style.width = s.style.height = (4 + Math.random() * 5) + 'px';
    if (i % 3 === 0) s.style.borderRadius = '50%';
    s.style.animationDuration = (2.4 + Math.random() * 2.2) + 's';
    s.style.animationDelay = (Math.random() * 1.2) + 's';
    box.appendChild(s);
  }
  setTimeout(() => box.remove(), 6500);
}

$('tRonda').addEventListener('change', renderBracketInputs);

$('tournamentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (tRunning) return;
  const nPairs = RONDA_PAIRS[$('tRonda').value] || 4;
  const equipos = [];
  for (let i = 0; i < nPairs * 2; i++) equipos.push($('tTeam' + i).value.trim());
  if (equipos.some(x => !x)) { feedLine('ERR', 'Faltan equipos por completar en el bracket'); return; }

  tRunning = true;
  $('btnTournament').disabled = true;
  $('btnTournament').textContent = '■ SIMULANDO…';
  tPipeReset();
  feedLine('SYS', `ORDEN: simular torneo · ${$('tRonda').value} · ${nPairs * 2} equipos`, 'badge-purple');

  try {
    const res = await fetch('/api/tournament', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equipos, torneo: $('tTorneo').value, ronda: $('tRonda').value })
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) handleTournamentEvent(JSON.parse(line.slice(6)));
      }
    }
  } catch (err) {
    tPipeError();
    feedLine('ERR', `FALLO: ${err.message}`);
  } finally {
    tRunning = false;
    $('btnTournament').disabled = false;
    $('btnTournament').textContent = '▶ SIMULAR TORNEO';
  }
});

function handleTournamentEvent(ev) {
  switch (ev.type) {
    case 'step': tPipeSet(ev.step); break;
    case 'tick': $('tPipeElapsed').textContent = `T+${ev.elapsed}s — consultando motor de IA…`; break;
    case 'log': feedLine(ev.msg.startsWith('⚠') ? 'WARN' : 'INFO', ev.msg); break;
    case 'error': tPipeError(); feedLine('ERR', ev.message); break;
    case 'tournament':
      tPipeSet(3);
      renderTournament(ev.data, ev.meta, ev.params);
      tPipeDone();
      $('tPipeElapsed').textContent = 'COMPLETADO';
      break;
  }
}

/* ═══ INIT ═══ */
(async function init() {
  renderBracketInputs();
  await refreshConfig();
  await refreshStats();
  renderTicker();
  setInterval(refreshStats, 60000);
})();
