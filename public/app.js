/* FIJALAB ✕ QUANT — frontend terminal */
'use strict';

const $ = (id) => document.getElementById(id);
const CLR = { green: '#00FF87', red: '#FF3B5C', amber: '#FFB300', cyan: '#00D9FF', purple: '#B266FF', yellow: '#FFE600', dim: '#5A5A5A', border: '#1C1C1C' };
const fmt = (n, d = 1) => Number(n).toFixed(d);
const nowTs = () => new Date().toLocaleTimeString('es-PE', { hour12: false });

let CONFIG = { demo: true, provider: 'DEMO', model: '—' };
let STATS = null;
let running = false;

/* ═══ RELOJ ═══ */
setInterval(() => { $('clock').textContent = nowTs(); }, 1000);
$('clock').textContent = nowTs();

/* ═══ TABS ═══ */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    $('view-dashboard').style.display = view === 'dashboard' ? 'grid' : 'none';
    $('view-history').style.display = view === 'history' ? 'grid' : 'none';
    if (view === 'history') refreshHistoryView();
  });
});

/* ═══ TICKER ═══ */
function renderTicker() {
  const s = STATS || {};
  const chips = [
    `<span class="chip"><span class="dot-red"></span><span class="v red">LIVE</span></span>`,
    `<span class="chip"><span class="k">MOTOR</span><span class="v cyan">${CONFIG.provider} · ${CONFIG.model}</span></span>`,
    `<span class="chip"><span class="k">WIN RATE</span><span class="v ${(s.winrate ?? 0) >= 50 ? 'green' : 'red'}">${s.winrate == null ? '—' : fmt(s.winrate) + '%'}</span></span>`,
    `<span class="chip"><span class="k">ROI</span><span class="v ${(s.roi ?? 0) >= 0 ? 'green' : 'red'}">${s.roi == null ? '—' : (s.roi >= 0 ? '+' : '') + fmt(s.roi) + '%'}</span></span>`,
    `<span class="chip"><span class="k">PROFIT</span><span class="v ${(s.profit ?? 0) >= 0 ? 'green' : 'red'}">S/ ${fmt(s.profit ?? 0, 2)}</span></span>`,
    `<span class="chip"><span class="k">BANCA</span><span class="v yellow">S/ ${fmt(s.banca ?? 500, 0)}</span></span>`,
    `<span class="chip"><span class="k">RACHA</span><span class="v ${s.streak?.type === 'GANADA' ? 'green' : s.streak?.type === 'PERDIDA' ? 'red' : 'dim'}">${s.streak?.type ? (s.streak.type === 'GANADA' ? 'W' : 'L') + s.streak.count : '—'}</span></span>`,
    `<span class="chip"><span class="k">PICKS LIQUIDADOS</span><span class="v">${s.settled ?? 0}</span></span>`,
    `<span class="chip"><span class="k">PENDIENTES</span><span class="v amber">${s.pending ?? 0}</span></span>`,
    `<span class="chip"><span class="k">MODO</span><span class="v ${CONFIG.demo ? 'amber' : 'green'}">${CONFIG.demo ? 'DEMO — SIN API KEY' : 'API LIVE'}</span></span>`
  ].join('');
  $('tickerTrack').innerHTML = chips + chips; // duplicado para loop continuo
}

async function refreshConfig() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
    $('engineTag').textContent = `MOTOR: ${CONFIG.provider} · ${CONFIG.model}`;
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
  $('heroPick').textContent = `${main.seleccion} @ ${fmt(main.cuota, 2)}`;
  $('p1').textContent = fmt(r.prob.local, 0) + '%';
  $('pX').textContent = fmt(r.prob.empate, 0) + '%';
  $('p2').textContent = fmt(r.prob.visitante, 0) + '%';
  $('c1').textContent = '@ ' + fmt(r.cuotas?.local ?? 0, 2);
  $('cX').textContent = '@ ' + fmt(r.cuotas?.empate ?? 0, 2);
  $('c2').textContent = '@ ' + fmt(r.cuotas?.visitante ?? 0, 2);
  $('xgTxt').textContent = `${fmt(r.xg.local, 2)} / ${fmt(r.xg.visitante, 2)}`;
  $('resumenTxt').textContent = r.resumen || '—';

  renderBuilder(r.combinada, banca);
  renderConfChart(r.picks);
  renderMatrix(r.picks);
  renderGauge(r.picks);
  runMonteCarlo(r.xg.local, r.xg.visitante, r.prob);
  renderAlerts(r.advertencias || [], r.contradicciones || []);

  // feed: picks como órdenes
  for (const p of r.picks) {
    feedLine(p.valor ? 'PICK+EV' : 'PICK',
      `${p.seleccion} @ ${fmt(p.cuota, 2)} · conf ${fmt(p.confianza, 0)}% · EV ${p.ev >= 0 ? '+' : ''}${fmt(p.ev, 1)}% · stake S/ ${fmt(p.stake, 2)} · riesgo ${p.riesgo.toUpperCase()}`);
  }
  if (r.combinada) {
    feedLine('COMBI', `Combinada x${fmt(r.combinada.cuota_total, 2)} (${r.combinada.patas.length} patas) · prob ${fmt(r.combinada.prob_estimada, 0)}% · stake S/ ${fmt(r.combinada.stake, 2)}`);
  }
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

function renderBuilder(c, banca) {
  if (!c || !c.patas?.length) {
    $('combiMulti').textContent = 'X—';
    $('combiLegs').innerHTML = '<div class="dim empty">sin combinada</div>';
    $('combiProb').textContent = '--%'; $('combiStake').textContent = 'S/ --'; $('combiEv').textContent = '--%';
    return;
  }
  $('combiMulti').textContent = 'X' + fmt(c.cuota_total, 2);
  $('combiPerfil').textContent = $('inPerfil').value.toUpperCase();
  $('combiLegs').innerHTML = c.patas.map(l =>
    `<div class="leg"><span class="lsel" title="${l.mercado}">${l.seleccion}</span><span class="lodd">@${fmt(l.cuota, 2)}</span></div>`
  ).join('');
  $('combiProb').textContent = fmt(c.prob_estimada, 0) + '%';
  $('combiStake').textContent = 'S/ ' + fmt(c.stake, 2);
  $('combiEv').textContent = (c.ev >= 0 ? '+' : '') + fmt(c.ev, 1) + '%';
  $('combiEv').className = c.ev >= 0 ? 'green' : 'red';
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
    return `<tr title="${(p.razon || '').replace(/"/g, '&quot;')}">
      <td class="dim">${p.mercado}</td>
      <td>${p.seleccion}</td>
      <td class="${cCls}">${fmt(p.confianza, 0)}%</td>
      <td class="amber">${fmt(p.cuota, 2)}</td>
      <td class="dim">${fmt(p.cuota_justa ?? (100 / p.confianza), 2)}</td>
      <td class="${eCls}">${p.ev >= 0 ? '+' : ''}${fmt(p.ev, 1)}%${p.valor ? ' ✓' : ''}</td>
      <td class="${rCls}">${(p.riesgo || '—').toUpperCase()}</td>
    </tr>`;
  }).join('');
}

function renderGauge(picks) {
  const avg = picks.reduce((s, p) => s + p.confianza, 0) / picks.length;
  const C = 2 * Math.PI * 50;
  const arc = $('gaugeArc');
  arc.style.strokeDashoffset = C * (1 - avg / 100);
  arc.style.stroke = confColor(avg);
  animateNumber($('gaugeNum'), avg, 0);
  $('gaugeVerdict').textContent = avg >= 68 ? 'SEÑAL FUERTE' : avg >= 55 ? 'SEÑAL MODERADA' : 'SEÑAL DÉBIL';
  $('gaugeVerdict').style.color = confColor(avg);
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
function renderAlerts(advertencias, contradicciones) {
  const items = [];
  for (const c of contradicciones) items.push(`<div class="alert-line">⛔ <span>${c}</span></div>`);
  for (const a of advertencias) {
    if (contradicciones.includes(a)) continue;
    items.push(`<div class="alert-line warn">⚠ <span>${a}</span></div>`);
  }
  $('alertsList').innerHTML = items.length
    ? items.join('')
    : '<span class="green" style="font-size:11px">✓ SIN CONTRADICCIONES — combinada estructuralmente válida</span>';
}

/* ═══ HISTORIAL ═══ */
async function refreshHistoryView() {
  await refreshStats();
  renderStatsView();
  renderEquity();
  renderMarketTable();
  await renderHistory();
  $('inBanca').value = STATS?.banca ?? 500;
}

function renderStatsView() {
  const s = STATS || {};
  $('statMeta').textContent = `${s.settled ?? 0} picks liquidados · ${s.pending ?? 0} pendientes`;
  $('stWinrate').textContent = s.winrate == null ? '—' : fmt(s.winrate) + '%';
  $('stWinrate').style.color = (s.winrate ?? 0) >= 50 ? CLR.green : CLR.red;
  $('stRoi').textContent = s.roi == null ? '—' : (s.roi >= 0 ? '+' : '') + fmt(s.roi) + '%';
  $('stRoi').style.color = (s.roi ?? 0) >= 0 ? CLR.green : CLR.red;
  $('stProfit').textContent = 'S/ ' + fmt(s.profit ?? 0, 2);
  $('stProfit').style.color = (s.profit ?? 0) >= 0 ? CLR.green : CLR.red;
  $('stStreak').textContent = s.streak?.type ? (s.streak.type === 'GANADA' ? 'W' : 'L') + s.streak.count : '—';
  $('stStreak').style.color = s.streak?.type === 'GANADA' ? CLR.green : s.streak?.type === 'PERDIDA' ? CLR.red : CLR.dim;
}

function renderEquity() {
  const { ctx, w, h } = setupCanvas($('equityChart'), 190);
  ctx.clearRect(0, 0, w, h);
  const eq = STATS?.equity || [];
  const pad = { l: 46, r: 10, t: 12, b: 20 };
  if (eq.length < 2) {
    ctx.fillStyle = CLR.dim; ctx.fillText('liquida picks para ver tu curva de banca', pad.l, h / 2);
    return;
  }
  const ys = eq.map(p => p.y);
  const yMin = Math.min(...ys) * 0.98, yMax = Math.max(...ys) * 1.02;
  const X = (i) => pad.l + (w - pad.l - pad.r) * (i / (eq.length - 1));
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - yMin) / (yMax - yMin || 1));
  // guías
  ctx.strokeStyle = '#111'; ctx.setLineDash([3, 4]);
  for (let g = 0; g <= 3; g++) {
    const v = yMin + (yMax - yMin) * g / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillStyle = CLR.dim; ctx.textAlign = 'right'; ctx.fillText('S/' + v.toFixed(0), pad.l - 4, Y(v) + 3);
  }
  ctx.setLineDash([]); ctx.textAlign = 'left';
  // línea banca inicial
  ctx.strokeStyle = CLR.dim; ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, Y(eq[0].y)); ctx.lineTo(w - pad.r, Y(eq[0].y)); ctx.stroke();
  ctx.setLineDash([]);
  // área + línea
  const last = eq[eq.length - 1].y;
  const col = last >= eq[0].y ? CLR.green : CLR.red;
  ctx.beginPath();
  eq.forEach((p, i) => i === 0 ? ctx.moveTo(X(0), Y(p.y)) : ctx.lineTo(X(i), Y(p.y)));
  ctx.strokeStyle = col; ctx.lineWidth = 1.6;
  ctx.shadowColor = col; ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineTo(X(eq.length - 1), h - pad.b); ctx.lineTo(pad.l, h - pad.b); ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, col + '33'); grad.addColorStop(1, col + '00');
  ctx.fillStyle = grad; ctx.fill();
  ctx.lineWidth = 1;
  // último valor
  ctx.fillStyle = col; ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText('S/ ' + fmt(last, 2), w - pad.r, Y(last) - 6);
  ctx.textAlign = 'left';
}

function renderMarketTable() {
  const tb = $('marketTable').querySelector('tbody');
  const rows = STATS?.byMarket || [];
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4" class="dim empty">sin picks liquidados</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(m => `<tr>
    <td><span class="badge ${{ GANADOR: 'badge-cyan', GOLES: 'badge-green', 'CÓRNERS': 'badge-purple', COMBINADA: 'badge-yellow', OTROS: 'badge-amber' }[m.mercado] || 'badge-cyan'}">${m.mercado}</span></td>
    <td>${m.total}</td>
    <td class="${m.winrate == null ? 'dim' : m.winrate >= 50 ? 'cell-good' : 'cell-bad'}">${m.winrate == null ? '—' : fmt(m.winrate) + '%'}</td>
    <td class="${m.profit >= 0 ? 'cell-good' : 'cell-bad'}">${m.profit >= 0 ? '+' : ''}S/ ${fmt(m.profit, 2)}</td>
  </tr>`).join('');
}

async function renderHistory() {
  const { analyses } = await (await fetch('/api/history')).json();
  const box = $('historyList');
  if (!analyses.length) {
    box.innerHTML = '<div class="dim empty">sin análisis registrados todavía</div>';
    return;
  }
  box.innerHTML = analyses.map(a => `
    <div class="hcard">
      <div class="hcard-head">
        <span class="hcard-title">${a.local} <span class="dim">vs</span> ${a.visitante}
          <span class="badge badge-cyan">${a.torneo || 's/torneo'}</span>
          <span class="badge badge-purple">${(a.perfil || '').toUpperCase()}</span>
        </span>
        <span class="dim" style="font-size:10px">#${a.id} · ${a.created_at} · motor: ${a.proveedor}</span>
      </div>
      ${a.picks.map(p => `
        <div class="hpick">
          <span class="badge ${p.tipo === 'COMBI' ? 'badge-purple' : p.valor ? 'badge-yellow' : 'badge-green'}">${p.tipo === 'COMBI' ? 'COMBI' : p.valor ? 'PICK+EV' : 'PICK'}</span>
          <span class="psel">${p.seleccion}</span>
          <span class="podd">@${fmt(p.cuota, 2)}</span>
          <span class="pstake">stake S/${fmt(p.stake, 2)}</span>
          <span class="badge ${{ GANADA: 'badge-green', PERDIDA: 'badge-red', NULA: 'badge-amber', PENDIENTE: 'badge-cyan' }[p.estado]}">${p.estado}</span>
          <span class="settle">
            <button class="sbtn g ${p.estado === 'GANADA' ? 'on' : ''}" onclick="settle(${p.id},'GANADA')" title="Ganada">G</button>
            <button class="sbtn p ${p.estado === 'PERDIDA' ? 'on' : ''}" onclick="settle(${p.id},'PERDIDA')" title="Perdida">P</button>
            <button class="sbtn n ${p.estado === 'NULA' ? 'on' : ''}" onclick="settle(${p.id},'NULA')" title="Nula">N</button>
          </span>
        </div>`).join('')}
    </div>`).join('');
}

window.settle = async function (pickId, estado) {
  const res = await fetch(`/api/picks/${pickId}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado })
  });
  const json = await res.json();
  if (!json.ok) { feedLine('ERR', json.error); return; }
  await refreshHistoryView();
};

$('btnBanca').addEventListener('click', async () => {
  const banca = Number($('inBanca').value);
  const res = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ banca })
  });
  const json = await res.json();
  if (json.ok) { feedLine('SYS', `Banca actualizada: S/ ${fmt(json.banca, 2)}`); await refreshHistoryView(); }
});

/* ═══ INIT ═══ */
(async function init() {
  await refreshConfig();
  await refreshStats();
  renderTicker();
  setInterval(refreshStats, 60000);
})();
