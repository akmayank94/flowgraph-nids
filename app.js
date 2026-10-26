"use strict";
// Flowgraph NIDS dashboard: replays the recorded output of the streaming engine (Phase 6) and shows the evaluation results.
const $ = (s, el = document) => el.querySelector(s);
const NETS = [["unsw_nb15", "UNSW-NB15"], ["cse_cic_ids2018", "CSE-CIC-IDS2018"], ["ton_iot", "ToN-IoT"]];
const LANES = 16, AUTO_SECONDS = 45, HISTORY_WALL_S = 12;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? "–" : (+v).toFixed(d);
const pct = (v, d = 2) => (v === null || v === undefined) ? "–" : (100 * v).toFixed(d) + "%";
const int = v => (v === null || v === undefined) ? "–" : Math.round(v).toLocaleString("en-US");
const PROTO = { 1: "ICMP", 6: "TCP", 17: "UDP" };

const cache = {};
let S = null;           // current scenario state
let net = "ton_iot", scenIdx = null, playing = true, speedMode = "auto", showTruth = true;
let lastFrame = 0, lastPanel = 0;

// ---------------- data ----------------
async function getJSON(f) { const r = await fetch("data/" + f); if (!r.ok) throw new Error(f + " " + r.status); return r.json(); }
async function loadNet(key) { if (!cache[key]) cache[key] = await getJSON(`replay_${key}.json`); return cache[key]; }

function prepare(rep, idx) {
  const sc = rep.scenarios[idx], c = sc.cols, n = sc.n, P = rep.policy;
  const st = {
    rep, sc, n, c, P, dur: Math.max(c.t[n - 1], 1), clock: 0, cur: 0,
    thrG: Math.round(P.thr_gnn * 1000), thrL: Math.round(P.thr_lgb * 1000),
    hostLane: new Map(), laneHost: new Array(LANES).fill(null), lastSeen: new Map(), host: new Map(),
    k: { flows: 0, gnn: 0, lgb: 0, disagree: 0, alerts: 0, tp: 0, fp: 0 },
    epClass: sc.episode_id >= 0 ? sc.classes.indexOf(sc.title) : -1, epStart: null, epReported: null, alertItems: []
  };
  st.su = c.su || c.g.map(g => g > st.thrG ? 1 : 0);
  st.lf = c.lf || c.l.map(l => l > st.thrL ? 1 : 0);
  return st;
}
function speed() { return speedMode === "auto" ? S.dur / (AUTO_SECONDS * 1000) : +speedMode; }

// ---------------- replay logic ----------------
function laneFor(st, h, t) {
  st.lastSeen.set(h, t);
  if (st.hostLane.has(h)) return;
  let free = st.laneHost.indexOf(null);
  if (free < 0) {           // evict the least recently seen host that is not in ALERT
    let best = -1, bt = Infinity;
    st.laneHost.forEach((hh, i) => { const on = st.host.get(hh)?.on; const ls = st.lastSeen.get(hh); const key = on ? ls + 1e12 : ls; if (key < bt) { bt = key; best = i; } });
    st.hostLane.delete(st.laneHost[best]); free = best;
  }
  st.laneHost[free] = h; st.hostLane.set(h, free);
}
function reveal(st, upto) {
  const c = st.c;
  for (let i = st.cur; i < upto; i++) {
    const s = c.s[i], t = c.t[i];
    laneFor(st, s, t);
    st.k.flows++; if (st.su[i]) st.k.gnn++; if (st.lf[i]) st.k.lgb++; if (st.su[i] !== st.lf[i]) st.k.disagree++;
    st.host.set(s, { r: c.r[i] / 100, t, on: !!c.on[i] });
    if (st.epClass >= 0 && c.y[i] === 1 && c.a[i] === st.epClass) {
      if (st.epStart === null) st.epStart = t;
      if (st.epReported === null && st.su[i] && c.on[i]) st.epReported = t;
    }
    if (c.al[i]) { st.k.alerts++; c.y[i] ? st.k.tp++ : st.k.fp++; st.alertItems.unshift(i); if (st.alertItems.length > 80) st.alertItems.pop(); st.newAlert = true; }
  }
  st.cur = upto;
}
function advance(dtWall) {
  if (!S || !playing) return;
  S.clock = Math.min(S.dur, S.clock + dtWall * speed());
  let hi = S.cur; const t = S.c.t;
  while (hi < S.n && t[hi] <= S.clock) hi++;
  if (hi > S.cur) reveal(S, hi);
  if (S.clock >= S.dur && S.cur >= S.n) { playing = false; setPlayLabel(); }
}

// ---------------- canvas ----------------
const cv = $("#graph"), ctx = cv.getContext("2d");
let geo = null, hoverIdx = -1;
function resize() {
  const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  geo = { W: r.width, H: r.height, L: r.width < 520 ? 84 : 118, T: 8, B: 22 };
}
function lowerBound(a, v, hi) { let lo = 0; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }
function niceStep(span) { const raw = span / 6, p = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p; return 10 * p; }
function draw() {
  if (!S || !geo) return;
  const { W, H, L, T, B } = geo, c = S.c, view = Math.max(40, speed() * HISTORY_WALL_S * 1000);
  const t1 = S.clock, t0 = t1 - view, pw = W - L - 10, rows = LANES + 1, lh = (H - T - B) / rows;
  const X = t => L + (t - t0) / view * pw;
  const laneOf = i => { const l = S.hostLane.get(c.s[i]); return l === undefined ? LANES : l; };
  const Y = i => T + (laneOf(i) + 0.5) * lh + (((c.d[i] * 37) % 9) - 4) * lh / 16;
  ctx.clearRect(0, 0, W, H);
  // lanes + labels
  ctx.font = "12px 'Schibsted Grotesk', sans-serif"; ctx.textBaseline = "middle";
  for (let r = 0; r < rows; r++) {
    const y = T + r * lh;
    if (r % 2 === 0) { ctx.fillStyle = css("--grid"); ctx.globalAlpha = 0.45; ctx.fillRect(L, y, pw, lh); ctx.globalAlpha = 1; }
    const h = r < LANES ? S.laneHost[r] : null, st = h !== null ? S.host.get(h) : null;
    ctx.fillStyle = st && st.on ? css("--alert") : css("--ink-2");
    const label = r === LANES ? "other hosts" : (h === null ? "" : S.sc.ips[h]);
    ctx.fillText(label, 6, y + lh / 2);
  }
  // time grid
  const step = niceStep(view), first = Math.ceil(Math.max(0, t0) / step) * step;
  ctx.strokeStyle = css("--rule"); ctx.lineWidth = 1; ctx.fillStyle = css("--ink-3"); ctx.textBaseline = "alphabetic";
  for (let g = first; g <= t1; g += step) {
    const x = X(g); ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
    ctx.fillText("+" + (g / 1000).toFixed(step < 100 ? 2 : step < 1000 ? 1 : 0) + " s", x + 3, H - 6);
  }
  const lo = lowerBound(c.t, t0, S.cur), hi = S.cur;
  // edges (causal neighbours)
  const eFrom = Math.max(lo, hi - 2500), ecol = [css("--e-conv"), css("--e-src"), css("--e-dst")];
  ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
  for (let ty = 0; ty < 3; ty++) {
    ctx.strokeStyle = ecol[ty]; ctx.beginPath();
    for (let i = eFrom; i < hi; i++) {
      const nb = c.nb[i], xi = X(c.t[i]), yi = Y(i);
      const a = ty === 0 ? 0 : ty === 1 ? 1 : 6, b = ty === 0 ? 1 : ty === 1 ? 6 : 9;
      for (let j = a; j < b; j++) { const m = nb[j]; if (m >= lo && m < hi) { ctx.moveTo(X(c.t[m]), Y(m)); ctx.lineTo(xi, yi); } }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // flows
  const cFlow = css("--flow"), cHot = css("--alert"), cLgb = css("--lgb"), cTruth = css("--truth");
  for (let i = lo; i < hi; i++) {
    const x = X(c.t[i]), y = Y(i);
    if (showTruth && c.y[i]) { ctx.fillStyle = cTruth; ctx.fillRect(x - 1, y + 5, 2, 6); }
    if (S.lf[i]) { ctx.strokeStyle = cLgb; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.stroke(); }
    ctx.fillStyle = S.su[i] ? cHot : cFlow; ctx.beginPath(); ctx.arc(x, y, S.su[i] ? 3.6 : 2.6, 0, 7); ctx.fill();
  }
  for (let i = lo; i < hi; i++) if (c.al[i]) {
    const x = X(c.t[i]), y = Y(i);
    ctx.strokeStyle = cHot; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke();
  }
  if (hoverIdx >= lo && hoverIdx < hi) { ctx.strokeStyle = css("--ink"); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(c.t[hoverIdx]), Y(hoverIdx), 8, 0, 7); ctx.stroke(); }
  geo.X = X; geo.Y = Y; geo.lo = lo; geo.hi = hi;
}
cv.addEventListener("mousemove", e => {
  if (!S || !geo.X) return;
  const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; let best = -1, bd = 100;
  for (let i = geo.lo; i < geo.hi; i++) { const dx = geo.X(S.c.t[i]) - mx, dy = geo.Y(i) - my, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } }
  hoverIdx = best; const tip = $("#tip");
  if (best < 0) { tip.hidden = true; return; }
  const c = S.c, i = best;
  tip.innerHTML = `<b>${S.sc.ips[c.s[i]]} → ${S.sc.ips[c.d[i]]}:${c.p[i]}</b> ${PROTO[c.pr[i]] || "proto " + c.pr[i]}<br>
    +${(c.t[i] / 1000).toFixed(3)} s · ${int(c.b[i])} bytes · ${int(c.du[i])} ms<br>
    TF-GNN ${(c.g[i] / 1000).toFixed(3)} ${S.su[i] ? "(flagged)" : ""}<br>LightGBM ${(c.l[i] / 1000).toFixed(3)} ${S.lf[i] ? "(flagged)" : ""}<br>
    Host risk ${(c.r[i] / 100).toFixed(2)}${c.al[i] ? " · alert raised" : ""}${showTruth ? `<br>Ground truth: ${S.sc.classes[c.a[i]]}` : ""}`;
  tip.hidden = false;
  const wrap = $(".graphwrap").getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 290) + "px"; tip.style.top = (e.clientY - wrap.top + 14) + "px";
});
cv.addEventListener("mouseleave", () => { hoverIdx = -1; $("#tip").hidden = true; });

// ---------------- panels ----------------
function kpis() {
  const k = S.k, ep = S.epClass >= 0;
  let epTxt = "No attack in this window", epSub = "benign-only scenario";
  if (ep) {
    if (S.epStart === null) { epTxt = "Waiting"; epSub = "attack has not started yet"; }
    else if (S.epReported !== null) { epTxt = ((S.epReported - S.epStart) / 1000).toFixed(2) + " s"; epSub = "from first attack flow to host alert"; }
    else { epTxt = "Not yet"; epSub = `attack running for ${((S.clock - S.epStart) / 1000).toFixed(1)} s`; }
  }
  $("#kpis").innerHTML = `
    <div class="kpi"><b>${int(k.flows)}</b><span>flows replayed of ${int(S.n)}</span></div>
    <div class="kpi"><b>${int(k.gnn)}</b><span><i class="sw" style="background:var(--alert)"></i>flagged by TF-GNN</span></div>
    <div class="kpi"><b>${int(k.lgb)}</b><span><i class="sw" style="background:var(--lgb)"></i>flagged by LightGBM</span></div>
    <div class="kpi"><b>${int(k.disagree)}</b><span>flows where the two disagree</span></div>
    <div class="kpi"><b>${int(k.alerts)}</b><span>${showTruth ? `host alerts: ${k.tp} on attacks, ${k.fp} false` : "host alerts raised"}</span></div>
    <div class="kpi"><b>${epTxt}</b><span>${ep ? "Time to report: " : ""}${epSub}</span></div>`;
}
function hosts() {
  const R = S.P.R, tau = S.P.tau_s * 1000, list = [];
  S.host.forEach((v, h) => { const r = v.r * Math.exp(-(S.clock - v.t) / tau); if (r > 0.05 || v.on) list.push([h, r, v.on]); });
  list.sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]));
  const max = Math.max(R * 1.5, ...list.slice(0, 8).map(x => x[1]));
  $("#hosts").innerHTML = list.slice(0, 8).map(([h, r, on]) => {
    const state = on ? ["alert", "▲ Alert"] : r >= R / 2 ? ["watch", "● Watching"] : ["quiet", "○ Quiet"];
    return `<li><span>${S.sc.ips[h]}</span><span class="state ${state[0]}">${state[1]}</span>
      <div class="meter" title="risk ${r.toFixed(2)} of alert level ${R}"><span style="width:${Math.min(100, 100 * r / max)}%;background:${on ? "var(--alert)" : r >= R / 2 ? "var(--watch)" : "var(--flow)"}"></span><em style="left:${100 * R / max}%"></em></div></li>`;
  }).join("") || `<li><span class="state quiet">No host has risk yet.</span></li>`;
}
function alerts() {
  if (!S.newAlert && S.alertItems.length) return; S.newAlert = false;
  const c = S.c;
  $("#alerts").innerHTML = S.alertItems.length ? S.alertItems.map(i => `<li><span class="t">+${(c.t[i] / 1000).toFixed(2)} s</span>
      <span class="who">${S.sc.ips[c.s[i]]}</span> → ${S.sc.ips[c.d[i]]}:${c.p[i]}
      ${showTruth ? (c.y[i] ? `<span class="chip tp">▲ Attack: ${S.sc.classes[c.a[i]]}</span>` : `<span class="chip fp">○ Benign flow: false alert</span>`) : ""}
      <div class="sc">TF-GNN ${(c.g[i] / 1000).toFixed(3)} · LightGBM ${(c.l[i] / 1000).toFixed(3)} · risk ${(c.r[i] / 100).toFixed(1)}</div></li>`).join("")
    : `<li class="empty">No alerts yet. A host is reported when its risk reaches the alert level.</li>`;
}
function panels(force) {
  const now = performance.now(); if (!force && now - lastPanel < 200) return; lastPanel = now;
  kpis(); hosts(); alerts();
  $("#clock").textContent = "+" + (S.clock / 1000).toFixed(S.dur < 10000 ? 3 : 1) + " s";
  $("#progress").style.width = (100 * S.clock / S.dur) + "%";
}
function frame(ts) {
  const dt = lastFrame ? Math.min(ts - lastFrame, 100) : 0; lastFrame = ts;
  advance(dt); draw(); if (S) panels(false);
  requestAnimationFrame(frame);
}

// ---------------- controls ----------------
function setPlayLabel() { const b = $("#playBtn"); b.textContent = playing ? "Pause" : (S && S.clock >= S.dur ? "Replay" : "Play"); b.setAttribute("aria-label", b.textContent); }
function note() {
  const P = S.P, sp = speed(), label = NETS.find(n => n[0] === net)[1];
  $("#replayNote").textContent = `Recorded output of the streaming engine on held-out ${label} test flows (a replay of real NetFlow records, not live traffic). ` +
    `A flow is flagged when its TF-GNN score exceeds ${P.thr_gnn.toFixed(3)} (1% false positives on validation). A host alert fires when its risk reaches ${P.R} ` +
    `(risk fades with a ${P.tau_s} s memory). Playing at ${sp >= 1 ? sp.toFixed(sp < 10 ? 1 : 0) + "×" : "1/" + Math.round(1 / sp) + " speed (slow motion)"}.`;
  $("#riskHint").textContent = `Bar = current risk; black mark = alert level ${P.R}.`;
  $("#dur").textContent = "+" + (S.dur / 1000).toFixed(S.dur < 10000 ? 3 : 1) + " s";
}
async function start() {
  const rep = await loadNet(net);
  const sel = $("#scenario"); sel.innerHTML = rep.scenarios.map((s, i) => `<option value="${i}">${s.title === "Benign only" ? "Benign traffic only" : "Attack: " + s.title} (${int(s.n)} flows)</option>`).join("");
  if (scenIdx === null) {   // open on the scenario with the most even mix of benign and attack flows
    let best = 0, bv = -1;
    rep.scenarios.forEach((s, i) => { const at = s.cols.y.reduce((x, y) => x + y, 0), v = Math.min(at, s.n - at); if (v > bv) { bv = v; best = i; } });
    scenIdx = best;
  }
  scenIdx = Math.min(scenIdx, rep.scenarios.length - 1); sel.value = scenIdx;
  S = prepare(rep, scenIdx); playing = true; setPlayLabel(); note(); panels(true);
}
function legend() {
  $("#legend").innerHTML = `<span><i class="dot" style="background:var(--flow)"></i>flow</span>
    <span><i class="dot" style="background:var(--alert)"></i>flagged by TF-GNN</span>
    <span><i class="ring"></i>flagged by LightGBM</span>
    <span><i class="ring" style="border-color:var(--alert);border-width:2.5px;width:14px;height:14px"></i>host alert</span>
    <span><i class="line" style="background:var(--e-src)"></i>same source</span>
    <span><i class="line" style="background:var(--e-dst)"></i>same destination</span>
    <span><i class="line" style="background:var(--e-conv)"></i>same conversation</span>
    <span id="truthLeg"><i class="tick"></i>attack (ground truth)</span>`;
}
function initControls() {
  $("#netSeg").innerHTML = NETS.map(([k, l]) => `<button role="radio" aria-checked="${k === net}" data-net="${k}">${l}</button>`).join("");
  $("#netSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; net = b.dataset.net; scenIdx = null;
    $("#netSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", x === b)); start(); });
  $("#scenario").addEventListener("change", e => { scenIdx = +e.target.value; start(); });
  $("#playBtn").addEventListener("click", () => { if (S.clock >= S.dur) { start(); return; } playing = !playing; setPlayLabel(); });
  $("#restartBtn").addEventListener("click", () => start());
  $("#speed").addEventListener("change", e => { speedMode = e.target.value; note(); });
  $("#truth").addEventListener("change", e => { showTruth = e.target.checked; $("#truthLeg").style.display = showTruth ? "" : "none"; S.newAlert = true; panels(true); });
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll(".tab").forEach(s => s.hidden = s.id !== "tab-" + b.dataset.tab);
    if (b.dataset.tab === "live") resize();
  }));
  window.addEventListener("resize", resize);
}

// ---------------- results tab ----------------
const MODEL_ORDER = ["TF-GNN", "TF-GNN-noEdges", "LightGBM+ctx", "LightGBM", "RandomForest", "MLP-noGraph", "IsolationForest"];
function table(cols, rows, opt = {}) {
  return `<div class="scroll"><table class="tbl">${opt.caption ? `<caption>${opt.caption}</caption>` : ""}<thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${opt.hl && opt.hl(r) ? "hl" : ""}">${cols.map(c => `<td>${c[1](r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function dumbbell(rows) {
  const W = 760, rh = 24, L = 250, R = 30, H = rows.length * rh + 34, x = v => L + v * (W - L - R);
  let s = `<svg class="dumb" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recall when the family is in training versus removed from training">`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) s += `<line x1="${x(v)}" x2="${x(v)}" y1="4" y2="${H - 22}" stroke="var(--grid)"/><text x="${x(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`;
  rows.forEach((r, i) => {
    const y = 14 + i * rh, a = r.recall_when_seen_P1, b = r.recall_when_unseen_P2;
    s += `<text x="${L - 10}" y="${y + 4}" text-anchor="end">${r.held_out_family} in ${r.test_set}</text>
      <line x1="${x(Math.min(a, b))}" x2="${x(Math.max(a, b))}" y1="${y}" y2="${y}" stroke="var(--ink-3)" stroke-width="2"/>
      <circle cx="${x(a)}" cy="${y}" r="5" fill="var(--gnn)"><title>in training: ${a.toFixed(3)}</title></circle>
      <circle cx="${x(b)}" cy="${y}" r="5" fill="var(--alert)" stroke="var(--panel)" stroke-width="2"><title>never seen: ${b.toFixed(3)}</title></circle>`;
  });
  return s + `</svg>`;
}
async function results() {
  let Sm, P6 = null;
  try { Sm = await getJSON("summary.json"); } catch (e) { $("#evalBody").textContent = "Results file is missing (data/summary.json)."; return; }
  try { P6 = await getJSON("phase6.json"); } catch (e) { }
  const nets = ["UNSW-NB15", "CSE-CIC-IDS2018", "ToN-IoT"];
  const p1 = net => Sm.p1.filter(r => r.network === net).sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model));
  let h = `<div class="block"><h3>Detection inside each network</h3>
    <p class="lede">Each model is trained on one network's earlier traffic and tested on its later traffic (protocol P1). TF-GNN is the deployed model; TF-GNN-noEdges is the same network with the graph removed, so the difference between them is what message passing adds. UNSW-NB15 is saturated: every model separates it perfectly, because its attacks come from four attack-only hosts.</p>
    <div class="grid3">${nets.map(n => table([["Model", r => r.model], ["PR-AUC", r => fmt(r.PR_AUC, 4)], ["Recall", r => fmt(r.recall_DR)], ["Precision", r => fmt(r.precision)], ["FPR", r => pct(r.FPR_FAR)]],
      p1(n), { caption: n, hl: r => r.model === "TF-GNN" })).join("")}</div></div>`;
  h += `<div class="block"><h3>From flagged flows to host alerts</h3>
    <p class="lede">Flagged flows feed a per-host risk score that fades over time; a host is reported once its risk reaches the alert level. Settings are chosen on validation (at most 2 false alerts per hour) and applied to test. An episode counts as detected when an alert is raised during it.</p>
    ${table([["Network", r => r.dataset], ["Model", r => r.model], ["Memory τ", r => r.chosen_tau_s + " s"], ["Alert level", r => r.chosen_R], ["Flagged flows", r => int(r.suspicious_flows)], ["Alerts", r => int(r.alerts)], ["False alerts / h", r => fmt(r.false_alerts_per_hour, 2)], ["Episodes detected", r => `${r.episodes_detected} of ${r.attack_episodes}`], ["Median time to detect", r => fmt(r.median_time_to_detect_s, 2) + " s"]],
      Sm.alerting_p5, { hl: r => r.model === "TF-GNN" })}`;
  if (P6) h += `<p class="lede" style="margin-top:16px">Revised rule used by the engine: an episode is <i>covered</i> when a flagged attack flow comes from a host that is already in alert, and ties are broken by fewer false alerts. Test rows below.</p>
    ${table([["Network", r => r.dataset], ["Rule", r => r.rule === "revised" ? "revised (engine)" : "Phase 5"], ["τ", r => r.tau_s + " s"], ["R", r => r.R], ["Alerts", r => int(r.alerts)], ["False alerts / h", r => fmt(r.false_alerts_per_hour, 2)], ["Detected", r => `${r.episodes_detected} of ${r.attack_episodes}`], ["Covered", r => `${r.episodes_covered} of ${r.attack_episodes}`], ["Median time to cover", r => fmt(r.median_ttd_covered_s, 2) + " s"]],
      P6.policy.filter(r => r.split === "test"), { hl: r => r.rule === "revised" })}`;
  h += `</div>`;
  h += `<div class="block"><h3>Limits: attack families never seen in training</h3>
    <p class="lede">The model trained on all three networks is retrained with one attack family removed (protocol P2). Blue is recall when the family is in training, red when it was never seen. A supervised detector mostly does not find what it was never shown; recall survives only where a close relative stays in training (DoS helps with DDoS) or where the attack hosts are trivially separable (UNSW-NB15).</p>
    ${dumbbell(Sm.p2)}</div>`;
  h += `<div class="block"><h3>Limits: other networks and later time periods</h3>
    <p class="lede">Applied to a network it was not trained on (P3), no model works: ROC-AUC between 0.21 and 0.65, and a threshold calibrated on one network gives anywhere from 0.5% to 99.99% false positives on another. On a strict time split where later attack types are unseen (P4), the GNN has no advantage over LightGBM.</p>
    <div class="grid3" style="grid-template-columns:repeat(2,minmax(0,1fr))">
    ${table([["Trained on", r => r.train], ["Tested on", r => r.test], ["Model", r => r.model.replace("-cross", "")], ["ROC-AUC", r => fmt(r.ROC_AUC)], ["Recall", r => fmt(r.recall_DR)], ["FPR", r => pct(r.FPR_FAR, 2)]], Sm.p3, { caption: "Other networks (P3)" })}
    ${table([["Network", r => r.network], ["Model", r => r.model.replace(" (P4 prep)", "")], ["PR-AUC", r => fmt(r.PR_AUC, 4)], ["Recall", r => fmt(r.recall_DR)], ["Precision", r => fmt(r.precision)], ["FPR", r => pct(r.FPR_FAR)]], Sm.p4, { caption: "Later time period (P4)" })}
    </div></div>`;
  if (P6) {
    const pr = P6.proofs.filter(r => r.check === "ALL PROOFS");
    h += `<div class="block"><h3>The streaming engine</h3>
      <p class="lede">The engine keeps small per-host memories and caches each flow's first-layer embedding when it arrives, so a new flow is scored from at most nine past neighbours without rebuilding the graph. Streaming the whole test split reproduced the offline pipeline exactly: ${pr.map(r => `${r.dataset} <span class="${r.value === "PASS" ? "pass" : "fail"}">${r.value}</span>`).join(", ")}.</p>
      ${table([["Network", r => r.dataset], ["Batch size", r => r.batch_size], ["Median latency", r => fmt(r.p50_ms, 2) + " ms"], ["p99 latency", r => fmt(r.p99_ms, 2) + " ms"], ["Flows / s", r => int(r.flows_per_s)], ["vs p99 traffic rate", r => r.x_p99_rate + "×"], ["vs busiest second", r => r.x_peak_second + "×"]], P6.latency)}
      <p class="lede" style="margin-top:10px">Measured on a Kaggle CPU notebook; full pipeline (graph, features, TF-GNN, LightGBM shadow, alerting). Scoring one flow at a time gives the lowest latency; small batches are needed to keep up with the busiest seconds.</p></div>`;
  }
  $("#evalBody").innerHTML = h;
}

function how() {
  $("#howBody").innerHTML = `<h2 class="big">How a flow becomes an alert</h2>
  <p>The system reads NetFlow v3 records (53 nProbe features per flow) in the order the flows finish. Every step uses only flows that have already finished, so it can run on a live stream.</p>
  <ol class="steps">
    <li><b>Link to the past.</b> The new flow is connected to the previous flow of the same conversation, the last five flows from the same source and the last three to the same destination, within 120 seconds.</li>
    <li><b>Describe the context.</b> Thirteen context features are computed from those neighbours: how busy the source and destination are, how many distinct targets and ports the source touched, and how long since it last appeared.</li>
    <li><b>Score with the graph network.</b> A two-layer temporal flow GNN combines the flow's own features with its neighbours' and their neighbours'. Neighbour embeddings are cached when they arrive, so scoring costs the same no matter how long the stream runs.</li>
    <li><b>Second opinion.</b> LightGBM scores the same flow from its own features only, and the dashboard shows where the two disagree.</li>
    <li><b>Watch, then confirm.</b> Flagged flows raise their source host's risk, which fades with time. One alert is raised when the risk reaches the alert level, instead of one per flow.</li>
  </ol>
  <h3>What version 1 shows</h3>
  <ul>
    <li>Detection inside a network the model was trained on, with thresholds fixed in advance on validation data and test traffic at its real attack ratio.</li>
    <li>That the streaming engine gives exactly the offline results, with measured latency.</li>
    <li>Alert-level numbers: false alerts per hour and time to report an attack.</li>
  </ul>
  <h3>What it does not claim</h3>
  <ul>
    <li>Detecting attack families it has never seen, working on a different network, or keeping its false-positive rate when traffic drifts over months. All three were tested and fail; the results tab shows how.</li>
    <li>Live packet capture. This page replays recorded engine output on public research datasets; a live deployment needs an exporter that produces the same nProbe features.</li>
  </ul>
  <h3>Data</h3>
  <p>NF-UNSW-NB15-v3, NF-CSE-CIC-IDS2018-v3 and NF-ToN-IoT-v3, the NetFlow v3 versions published by the University of Queensland. Exact duplicate rows were removed, each network was split by time into train, validation and test with a purge gap, and preprocessing was fitted on training data only.</p>`;
}

// ---------------- boot ----------------
legend(); initControls(); how(); resize();
start().catch(e => { $("#replayNote").textContent = "Could not load replay data: " + e.message; });
results();
requestAnimationFrame(frame);
