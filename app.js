"use strict";
// Flowgraph NIDS v2 dashboard: replays recorded engine output (v1 engine, v2 evidence cards) and shows the v2 results.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NETS = [["unsw_nb15", "UNSW-NB15"], ["cse_cic_ids2018", "CSE-CIC-IDS2018"], ["ton_iot", "ToN-IoT"]];
const LABEL = Object.fromEntries(NETS);
const LANES = 16, AUTO_SECONDS = 45, HISTORY_WALL_S = 12;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(+v)) ? "–" : (+v).toFixed(d);
const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v)) ? "–" : (100 * v).toFixed(d) + "%";
const int = v => (v === null || v === undefined) ? "–" : Math.round(v).toLocaleString("en-US");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PROTO = { 1: "ICMP", 6: "TCP", 17: "UDP" };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const nice = c => String(c).replace(/_/g, " ").replace(/^DoS attacks-/, "DoS ").replace(/^DDoS attacks-/, "DDoS ").replace(/^DDOS attack-/, "DDoS ").replace(/ \(FTP-BruteForce \+ DoS-SlowHTTPTest\)/, "");

// measurement names in plain words, with units
const MEASURE = {
  IN_BYTES: ["bytes sent by the source", "B"], OUT_BYTES: ["bytes sent back", "B"], IN_PKTS: ["packets sent by the source", ""], OUT_PKTS: ["packets sent back", ""],
  FLOW_DURATION_MILLISECONDS: ["flow duration", "ms"], DURATION_IN: ["duration, source side", "ms"], DURATION_OUT: ["duration, reply side", "ms"],
  LONGEST_FLOW_PKT: ["largest packet", "B"], SHORTEST_FLOW_PKT: ["smallest packet", "B"], MIN_IP_PKT_LEN: ["smallest IP packet", "B"], MAX_IP_PKT_LEN: ["largest IP packet", "B"],
  SRC_TO_DST_SECOND_BYTES: ["bytes per second, source side", "B/s"], DST_TO_SRC_SECOND_BYTES: ["bytes per second, reply side", "B/s"],
  RETRANSMITTED_IN_BYTES: ["re-sent bytes, source side", "B"], RETRANSMITTED_IN_PKTS: ["re-sent packets, source side", ""], RETRANSMITTED_OUT_BYTES: ["re-sent bytes, reply side", "B"], RETRANSMITTED_OUT_PKTS: ["re-sent packets, reply side", ""],
  SRC_TO_DST_AVG_THROUGHPUT: ["throughput, source side", "bit/s"], DST_TO_SRC_AVG_THROUGHPUT: ["throughput, reply side", "bit/s"],
  NUM_PKTS_UP_TO_128_BYTES: ["packets up to 128 B", ""], NUM_PKTS_128_TO_256_BYTES: ["packets 128–256 B", ""], NUM_PKTS_256_TO_512_BYTES: ["packets 256–512 B", ""],
  NUM_PKTS_512_TO_1024_BYTES: ["packets 512–1024 B", ""], NUM_PKTS_1024_TO_1514_BYTES: ["packets 1024–1514 B", ""], TCP_WIN_MAX_IN: ["TCP window, source side", "B"], TCP_WIN_MAX_OUT: ["TCP window, reply side", "B"],
  DNS_TTL_ANSWER: ["DNS answer lifetime", "s"], SRC_TO_DST_IAT_MIN: ["shortest gap between source packets", "ms"], SRC_TO_DST_IAT_MAX: ["longest gap between source packets", "ms"],
  SRC_TO_DST_IAT_AVG: ["average gap between source packets", "ms"], SRC_TO_DST_IAT_STDDEV: ["spread of gaps, source packets", "ms"], DST_TO_SRC_IAT_MIN: ["shortest gap between reply packets", "ms"],
  DST_TO_SRC_IAT_MAX: ["longest gap between reply packets", "ms"], DST_TO_SRC_IAT_AVG: ["average gap between reply packets", "ms"], DST_TO_SRC_IAT_STDDEV: ["spread of gaps, reply packets", "ms"]
};
const val = (v, u) => { const a = Math.abs(v); const s = a >= 1e6 ? (v / 1e6).toFixed(1) + "M" : a >= 1e4 ? (v / 1e3).toFixed(0) + "k" : a >= 100 ? Math.round(v).toLocaleString("en-US") : a >= 1 ? (+v.toFixed(1)).toString() : (+v.toFixed(2)).toString(); return s + (u ? " " + u : ""); };

const cache = {}, evCache = {};
let V2 = null, SUM = null, P6 = null, TERMS = null;
let S = null, net = "ton_iot", scenIdx = null, playing = true, speedMode = "auto", showTruth = true;
let lastFrame = 0, lastPanel = 0, sel = { i: -1, host: null, view: "ev" };

async function getJSON(f) { const r = await fetch("data/" + f); if (!r.ok) throw new Error(`${f} could not be loaded (HTTP ${r.status})`); return r.json(); }
async function loadNet(k) { if (!cache[k]) cache[k] = await getJSON(`replay_${k}.json`); return cache[k]; }
async function loadEv(k) { if (!evCache[k]) evCache[k] = await getJSON(`evidence_${k}.json`); return evCache[k]; }

// ======================= theme =======================
function setTheme(t) {
  document.documentElement.dataset.theme = t; try { localStorage.setItem("fg-theme", t); } catch (e) { }
  $("#themeBtn").setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  if (S) { draw(); renderInspector(); }
}
$("#themeBtn").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

// ======================= hero animation =======================
function runPipe() {
  const p = $("#pipe"); if (reduceMotion) return;
  clearTimeout(runPipe.t); p.classList.remove("run"); void p.getBoundingClientRect(); p.classList.add("run");
  try { $("#packetMove").beginElement(); } catch (e) { }
  runPipe.t = setTimeout(() => p.classList.remove("run"), 6500);   // then rest in the final state (tab switches do not replay it)
}
$("#replayAnim").addEventListener("click", runPipe);
if (reduceMotion) $("#replayAnim").hidden = true;

// ======================= replay =======================
function prepare(rep, idx, ev) {
  const sc = rep.scenarios[idx], c = sc.cols, n = sc.n, P = rep.policy;
  const st = { rep, sc, n, c, P, ev, dur: Math.max(c.t[n - 1], 1), clock: 0, cur: 0, thrG: Math.round(P.thr_gnn * 1000), thrL: Math.round(P.thr_lgb * 1000),
    hostLane: new Map(), lanes: Math.min(LANES, Math.max(6, new Set(c.s).size)), laneHost: null, lastSeen: new Map(), host: new Map(),
    k: { flows: 0, gnn: 0, lgb: 0, alerts: 0, tp: 0, fp: 0 }, epClass: sc.episode_id >= 0 ? sc.classes.indexOf(sc.title) : -1, epStart: null, epReported: null, alertItems: [] };
  st.laneHost = new Array(st.lanes).fill(null);
  st.su = c.su || c.g.map(g => g > st.thrG ? 1 : 0); st.lf = c.lf || c.l.map(l => l > st.thrL ? 1 : 0);
  return st;
}
const card = i => S.ev.cards[String(S.sc.first_row + i)];
function speed() { return speedMode === "auto" ? S.dur / (AUTO_SECONDS * 1000) : +speedMode; }
function laneFor(st, h, t) {
  st.lastSeen.set(h, t); if (st.hostLane.has(h)) return;
  let free = st.laneHost.indexOf(null);
  if (free < 0) { let best = -1, bt = Infinity;
    st.laneHost.forEach((hh, i) => { const on = st.host.get(hh)?.on, ls = st.lastSeen.get(hh), key = (on || hh === sel.host) ? ls + 1e12 : ls; if (key < bt) { bt = key; best = i; } });
    st.hostLane.delete(st.laneHost[best]); free = best; }
  st.laneHost[free] = h; st.hostLane.set(h, free);
}
function reveal(st, upto) {
  const c = st.c;
  for (let i = st.cur; i < upto; i++) {
    const s = c.s[i], t = c.t[i]; laneFor(st, s, t);
    st.k.flows++; if (st.su[i]) st.k.gnn++; if (st.lf[i]) st.k.lgb++;
    st.host.set(s, { r: c.r[i] / 100, t, on: !!c.on[i] });
    if (st.epClass >= 0 && c.y[i] === 1 && c.a[i] === st.epClass) { if (st.epStart === null) st.epStart = t; if (st.epReported === null && st.su[i] && c.on[i]) st.epReported = t; }
    if (c.al[i]) { st.k.alerts++; c.y[i] ? st.k.tp++ : st.k.fp++; st.alertItems.unshift(i); if (st.alertItems.length > 80) st.alertItems.pop(); st.newAlert = true;
      if (sel.i < 0 && !st.autoPicked) { st.autoPicked = true; select(i, false); } }
  }
  st.cur = upto;
}
function advance(dt) {
  if (!S || !playing) return;
  S.clock = Math.min(S.dur, S.clock + dt * speed());
  let hi = S.cur; const t = S.c.t; while (hi < S.n && t[hi] <= S.clock) hi++;
  if (hi > S.cur) reveal(S, hi);
  if (S.clock >= S.dur && S.cur >= S.n) { playing = false; setPlayLabel(); }
}

// ---------- canvas ----------
const cv = $("#graph"), g2 = cv.getContext("2d");
let geo = null, hoverIdx = -1;
function resize() {
  const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect(); if (!r.width) return;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  geo = { W: r.width, H: r.height, L: r.width < 520 ? 92 : 124, T: 6, B: 22 };
}
function lowerBound(a, v, hi) { let lo = 0; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }
function niceStep(span) { const raw = span / 6, p = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p; return 10 * p; }
function draw() {
  if (!S || !geo) return;
  const { W, H, L, T, B } = geo, c = S.c, view = Math.max(40, speed() * HISTORY_WALL_S * 1000);
  const t1 = S.clock, t0 = t1 - view, pw = W - L - 10, rows = S.lanes + 1, lh = (H - T - B) / rows;
  const X = t => L + (t - t0) / view * pw;
  const laneOf = i => { const l = S.hostLane.get(c.s[i]); return l === undefined ? S.lanes : l; };
  const Y = i => T + (laneOf(i) + 0.5) * lh + (((c.d[i] * 37) % 9) - 4) * lh / 16;
  g2.clearRect(0, 0, W, H);
  g2.font = `12px ${css("--mono")}`; g2.textBaseline = "middle";
  const cGrid = css("--line"), cBg2 = css("--bg-2");
  for (let r = 0; r < rows; r++) {
    const y = T + r * lh, h = r < S.lanes ? S.laneHost[r] : null, st = h !== null ? S.host.get(h) : null;
    if (h !== null && h === sel.host) { g2.fillStyle = css("--panel-2"); g2.fillRect(0, y, W, lh); }
    else if (r % 2 === 0) { g2.fillStyle = cBg2; g2.fillRect(L, y, pw, lh); }
    g2.fillStyle = st && st.on ? css("--threat") : css("--ink-2");
    g2.fillText(r === S.lanes ? "other hosts" : (h === null ? "" : S.sc.ips[h]), 6, y + lh / 2);
  }
  const step = niceStep(view), first = Math.ceil(Math.max(0, t0) / step) * step;
  g2.strokeStyle = cGrid; g2.lineWidth = 1; g2.fillStyle = css("--ink-3"); g2.textBaseline = "alphabetic"; g2.font = `11.5px ${css("--body")}`;
  for (let g = first; g <= t1; g += step) { const x = X(g); g2.beginPath(); g2.moveTo(x, T); g2.lineTo(x, H - B); g2.stroke(); g2.fillText("+" + (g / 1000).toFixed(step < 100 ? 2 : step < 1000 ? 1 : 0) + " s", x + 3, H - 6); }
  const lo = lowerBound(c.t, t0, S.cur), hi = S.cur, eFrom = Math.max(lo, hi - 2500), ecol = [css("--e-conv"), css("--e-src"), css("--e-dst")];
  g2.lineWidth = 1; g2.globalAlpha = 0.55;
  for (let ty = 0; ty < 3; ty++) {
    g2.strokeStyle = ecol[ty]; g2.beginPath();
    for (let i = eFrom; i < hi; i++) { const nb = c.nb[i], xi = X(c.t[i]), yi = Y(i), a = ty === 0 ? 0 : ty === 1 ? 1 : 6, b = ty === 0 ? 1 : ty === 1 ? 6 : 9;
      for (let j = a; j < b; j++) { const m = nb[j]; if (m >= lo && m < hi) { g2.moveTo(X(c.t[m]), Y(m)); g2.lineTo(xi, yi); } } }
    g2.stroke();
  }
  g2.globalAlpha = 1;
  const cFlow = css("--flow"), cHot = css("--threat"), cLgb = css("--lgb"), cTruth = css("--truth");
  for (let i = lo; i < hi; i++) {
    const x = X(c.t[i]), y = Y(i);
    if (showTruth && c.y[i]) { g2.fillStyle = cTruth; g2.fillRect(x - 1, y + 5, 2, 6); }
    if (S.lf[i]) { g2.strokeStyle = cLgb; g2.lineWidth = 1.4; g2.beginPath(); g2.arc(x, y, 6, 0, 7); g2.stroke(); }
    g2.fillStyle = S.su[i] ? cHot : cFlow; g2.beginPath(); g2.arc(x, y, S.su[i] ? 3.6 : 2.5, 0, 7); g2.fill();
  }
  for (let i = lo; i < hi; i++) if (c.al[i]) { g2.strokeStyle = cHot; g2.lineWidth = 2.5; g2.beginPath(); g2.arc(X(c.t[i]), Y(i), 10, 0, 7); g2.stroke(); }
  for (const i of [hoverIdx, sel.i]) if (i >= lo && i < hi) { g2.strokeStyle = i === sel.i ? css("--signal") : css("--ink"); g2.lineWidth = 2; g2.beginPath(); g2.arc(X(c.t[i]), Y(i), 8, 0, 7); g2.stroke(); }
  geo.X = X; geo.Y = Y; geo.lo = lo; geo.hi = hi;
}
function nearest(e) {
  const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; let best = -1, bd = 140;
  for (let i = geo.lo; i < geo.hi; i++) { const dx = geo.X(S.c.t[i]) - mx, dy = geo.Y(i) - my, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } }
  return best;
}
cv.addEventListener("mousemove", e => {
  if (!S || !geo || !geo.X) return; hoverIdx = nearest(e); const tip = $("#tip");
  if (hoverIdx < 0) { tip.hidden = true; return; }
  const c = S.c, i = hoverIdx, cd = card(i);
  tip.innerHTML = `<b class="mono">${S.sc.ips[c.s[i]]} → ${S.sc.ips[c.d[i]]}:${c.p[i]}</b> ${PROTO[c.pr[i]] || "proto " + c.pr[i]}<br>
    +${(c.t[i] / 1000).toFixed(3)} s, ${int(c.b[i])} bytes, ${int(c.du[i])} ms<br>TF-GNN ${(c.g[i] / 1000).toFixed(3)}${S.su[i] ? " (flagged)" : ""}, LightGBM ${(c.l[i] / 1000).toFixed(3)}${S.lf[i] ? " (flagged)" : ""}
    ${cd ? `<br>Looks like <b>${esc(nice(cd.like))}</b> (${cd.votes}/5)` : ""}${showTruth ? `<br>Ground truth: ${esc(nice(S.sc.classes[c.a[i]]))}` : ""}${S.su[i] ? "<br><i>Click to investigate</i>" : ""}`;
  tip.hidden = false; const wrap = $(".graphwrap").getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 300) + "px"; tip.style.top = (e.clientY - wrap.top + 14) + "px";
});
cv.addEventListener("mouseleave", () => { hoverIdx = -1; $("#tip").hidden = true; });
cv.addEventListener("click", e => { if (!S || !geo || !geo.X) return; const i = nearest(e); if (i >= 0) select(i, true); });

// ---------- panels ----------
function counters() {
  const k = S.k, ep = S.epClass >= 0;
  let epTxt = "No attack", epSub = "benign-only window";
  if (ep) { if (S.epStart === null) { epTxt = "Waiting"; epSub = "attack not started yet"; }
    else if (S.epReported !== null) { epTxt = ((S.epReported - S.epStart) / 1000).toFixed(2) + " s"; epSub = "attack start to host alert"; }
    else { epTxt = "Not yet"; epSub = `attack running ${((S.clock - S.epStart) / 1000).toFixed(1)} s`; } }
  $("#counters").innerHTML = `<div><b>${int(k.flows)}</b><span>flows of ${int(S.n)}</span></div>
    <div><b>${int(k.gnn)}</b><span><i class="sw" style="background:var(--threat)"></i>flagged by TF-GNN</span></div>
    <div><b>${int(k.lgb)}</b><span><i class="sw" style="background:var(--lgb)"></i>flagged by LightGBM</span></div>
    <div><b>${int(k.alerts)}</b><span>${showTruth ? `host alerts, ${k.tp} real, ${k.fp} false` : "host alerts"}</span></div>
    <div><b>${int(S.host.size)}</b><span>hosts seen</span></div>
    <div><b>${epTxt}</b><span>${epSub}</span></div>`;
}
function hosts() {
  const R = S.P.R, tau = S.P.tau_s * 1000, list = [];
  S.host.forEach((v, h) => { const r = v.r * Math.exp(-(S.clock - v.t) / tau); if (r > 0.05 || v.on || h === sel.host) list.push([h, r, v.on]); });
  list.sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]));
  const top = list.slice(0, 7), max = Math.max(R * 1.5, ...top.map(x => x[1]));
  $("#hosts").innerHTML = top.map(([h, r, on]) => { const st = on ? ["alert", "In alert"] : r >= R / 2 ? ["watch", "Watching"] : ["quiet", "Quiet"];
    return `<li><button data-host="${h}" aria-pressed="${h === sel.host}"><span class="mono">${S.sc.ips[h]}</span><span class="state ${st[0]}">${st[1]}</span>
      <span class="meter" title="risk ${r.toFixed(2)}, alert level ${R}"><span style="width:${Math.min(100, 100 * r / max)}%;background:${on ? "var(--threat)" : r >= R / 2 ? "var(--watch)" : "var(--flow)"}"></span><em style="left:${100 * R / max}%"></em></span></button></li>`; }).join("")
    || `<li class="empty">No host has built up risk yet.</li>`;
}
function queue() {
  if (!S.newAlert && S.alertItems.length && !S.forceQ) return; S.newAlert = false; S.forceQ = false;
  const c = S.c; $("#qcount").textContent = S.alertItems.length ? `${S.alertItems.length} raised` : "";
  $("#queue").innerHTML = S.alertItems.length ? S.alertItems.map(i => { const cd = card(i);
    return `<li><button data-i="${i}" aria-pressed="${i === sel.i}"><span class="t">+${(c.t[i] / 1000).toFixed(2)} s</span><span class="who mono">${S.sc.ips[c.s[i]]}</span>
      ${showTruth ? (c.y[i] ? `<span class="tag threat">attack</span>` : `<span class="tag quiet">false alarm</span>`) : ""}
      <span class="sub">${cd ? `looks like ${esc(nice(cd.like))} (${cd.votes}/5)` : "no card"} · score ${(c.g[i] / 1000).toFixed(3)}</span></button></li>`; }).join("")
    : `<li class="empty">No alerts yet. A host is reported once its risk reaches the alert level.</li>`;
}
// lists re-render while the replay runs, so selection happens on press (pointerdown); click covers keyboard use
const pickAlert = e => { const b = e.target.closest("button[data-i]"); if (b && +b.dataset.i !== sel.i) select(+b.dataset.i, true); };
const pickHost = e => { const b = e.target.closest("button[data-host]"); if (b && (+b.dataset.host !== sel.host || sel.view !== "host")) { sel.host = +b.dataset.host; sel.view = "host"; renderInspector(true); hosts(); } };
for (const ev of ["pointerdown", "click"]) { $("#queue").addEventListener(ev, pickAlert); $("#hosts").addEventListener(ev, pickHost); }
function panels(force) {
  const now = performance.now(); if (!force && now - lastPanel < 220) return; lastPanel = now;
  counters(); hosts(); queue();
  $("#clock").textContent = "+" + (S.clock / 1000).toFixed(S.dur < 10000 ? 3 : 1) + " s"; $("#progress").style.width = (100 * S.clock / S.dur) + "%";
  if (sel.view === "host" && sel.host !== null) renderHostLine();
}
function frame(ts) { const dt = lastFrame ? Math.min(ts - lastFrame, 100) : 0; lastFrame = ts; advance(dt); if (!$("#tab-console").hidden) { draw(); if (S) panels(false); } requestAnimationFrame(frame); }

// ---------- inspector ----------
function select(i, user) {
  sel.i = i; sel.host = S.c.s[i]; sel.view = "ev"; S.forceQ = true; queue(); renderInspector(user);
  if (user && innerWidth < 1180) $("#inspect").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}
$$(".itabs button").forEach(b => b.addEventListener("click", () => { sel.view = b.dataset.it; renderInspector(true); }));
function renderInspector() {
  $$(".itabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.it === sel.view));
  if (sel.view === "host") return renderHostLine(true);
  const body = $("#inspectBody");
  if (sel.i < 0) { body.innerHTML = `<div class="ev-empty"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 L54 13 V31 C54 45 44 55 32 60 C20 55 10 45 10 31 V13 Z" fill="none" stroke="var(--line-2)" stroke-width="2"/><circle cx="29" cy="30" r="9" fill="none" stroke="var(--signal)" stroke-width="2.5"/><path d="M36 37 L44 45" stroke="var(--signal)" stroke-width="3" stroke-linecap="round"/></svg>
      <div><b>Pick an alert to investigate.</b><br>Click an alert in the queue or any red flow in the graph. The card shows which known traffic it looks like, which measurements are unusual, and what its source did just before.</div></div>`;
    $("#inspectTitle").textContent = "Investigate"; return; }
  const c = S.c, i = sel.i, cd = card(i), net_ = LABEL[S.rep.dataset], acc = V2.evidence_accuracy[net_];
  $("#inspectTitle").textContent = "Evidence";
  const head = `<div class="evhead"><span class="route">${S.sc.ips[c.s[i]]} → ${S.sc.ips[c.d[i]]}:${c.p[i]}</span><span class="muted">${PROTO[c.pr[i]] || "proto " + c.pr[i]}, +${(c.t[i] / 1000).toFixed(3)} s, ${int(c.b[i])} bytes</span>
    <span class="tag ${S.su[i] ? "threat" : "quiet"}">TF-GNN ${(c.g[i] / 1000).toFixed(3)}${S.su[i] ? ", above threshold " + S.P.thr_gnn.toFixed(2) : ", below threshold"}</span>
    ${c.al[i] ? `<span class="tag threat">raised the host alert</span>` : ""}${showTruth ? `<span class="tag ${c.y[i] ? "watch" : "ok"}">truth: ${esc(nice(S.sc.classes[c.a[i]]))}</span>` : ""}</div>`;
  if (!cd) { body.innerHTML = head + `<p class="muted">This flow is below the alert threshold, so the engine made no evidence card for it. Red flows and alerts have cards.</p>`; return; }
  const pc = acc.per_class[cd.like], ben = cd.like === "Benign";
  const likeTxt = ben ? `<p class="muted">The 5 closest known flows are mostly normal traffic. On ${net_}, ${pct(acc.fa_benign, 1)} of false alarms got this same vote${acc.fa_benign > 0.9 ? ", so check this one first: it is probably harmless." : ", so the vote alone does not clear it."}</p>`
    : `<p class="muted">On ${net_}, this suggestion was right for ${pc !== undefined ? pct(pc, 0) : "–"} of detected ${esc(nice(cd.like))} flows${cd.votes === 5 ? `, and for ${pct(acc.all5, 0)} of all alerts where all 5 agree` : ""}.</p>`;
  const outs = cd.out.filter(o => Math.abs(o[3]) >= 2);
  const so = outs.length ? `<div class="so">${outs.map(([m, v, nv, z]) => { const md = MEASURE[m] || [m, ""], lv = Math.log10(Math.max(v, 0) + 1), ln = Math.log10(Math.max(nv, 0) + 1), mx = Math.max(lv, ln, 1) * 1.15;
      return `<div class="row"><span class="nm">${md[0]}</span><span class="scale" aria-hidden="true"><i style="left:${100 * ln / mx}%;background:var(--ink-3)"></i><i style="left:${100 * lv / mx}%;background:var(--threat)"></i></span>
        <span class="vals">${val(v, md[1])} here, normal ${val(nv, md[1])} (${z > 0 ? "+" : ""}${z} robust z)</span></div>`; }).join("")}</div>`
    : `<p class="muted">No single measurement of this flow is unusual compared with normal traffic. The alert comes from its pattern together with its earlier flows.</p>`;
  const x = cd.ctx, prev = x[3] >= 119.5 ? "none in 120 s" : x[3] + " s ago";
  body.innerHTML = head + `<div class="evcard">
    <section><h3>Looks like</h3><div class="like">${esc(nice(cd.like))}</div><div class="votes" aria-label="${cd.votes} of 5 nearest known flows agree">${[0, 1, 2, 3, 4].map(k => `<i class="${k < cd.votes ? "on" : ""}"></i>`).join("")}</div>
      <span class="faint">${cd.votes} of the 5 most similar training flows, similarity ${cd.sim.toFixed(2)}</span>${likeTxt}</section>
    <section><h3>What stands out</h3>${so}</section>
    <section><h3>What the source did just before</h3><div class="ctx">
      <span>its flows in the last 10 s</span><b>${int(x[0])}</b><span>its flows in the last 120 s</span><b>${int(x[1])}</b>
      <span>flows to this destination, 120 s</span><b>${int(x[2])}</b><span>its previous flow</span><b>${prev}</b>
      <span>distinct destinations, last 5 flows</span><b>${x[4]}</b><span>distinct ports, last 5 flows</span><b>${x[5]}</b></div>
      <button class="btn" style="margin-top:12px" id="toHost">Open host timeline</button></section></div>`;
  $("#toHost").addEventListener("click", () => { sel.view = "host"; renderInspector(true); });
}
function renderHostLine(full) {
  const body = $("#inspectBody"); $$(".itabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.it === sel.view));
  if (sel.host === null) { body.innerHTML = `<p class="muted">Pick a host in "Hosts by risk", or an alert, to see its timeline.</p>`; return; }
  $("#inspectTitle").textContent = "Host timeline";
  const c = S.c, h = sel.host, idx = []; for (let i = 0; i < S.cur; i++) if (c.s[i] === h) idx.push(i);
  const W = Math.max(320, Math.round(body.clientWidth || 1000)), H = 190, L = 58, R = 12, T = 14, B = 26, x = t => L + (t / S.dur) * (W - L - R);
  // square-root scale: the alert level stays readable even when a busy attacker's risk climbs far past it
  const Rl = S.P.R, maxR = Math.max(Rl * 1.6, ...idx.map(i => c.r[i] / 100)), yR = r => T + (1 - Math.sqrt(Math.max(r, 0) / maxR)) * (H - T - B - 34);
  let path = ""; idx.forEach((i, k) => path += (k ? "L" : "M") + x(c.t[i]).toFixed(1) + " " + yR(c.r[i] / 100).toFixed(1));
  const nFl = idx.length, nSu = idx.filter(i => S.su[i]).length, nAl = idx.filter(i => c.al[i]).length, nAt = idx.filter(i => c.y[i]).length;
  const svg = `<svg class="hostline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Risk of host ${S.sc.ips[h]} over the scenario, with its flows and alerts">
    <line x1="${L}" x2="${W - R}" y1="${yR(Rl)}" y2="${yR(Rl)}" stroke="var(--ink-2)" stroke-dasharray="5 5"/><text x="${L - 6}" y="${yR(Rl) + 4}" text-anchor="end">alert ${Rl}</text>
    <text x="${L - 6}" y="${yR(0) + 4}" text-anchor="end">0</text>${maxR > Rl * 2 ? `<text x="${L - 6}" y="${yR(maxR) + 4}" text-anchor="end">${Math.round(maxR)}</text>` : ""}
    <path d="${path}" fill="none" stroke="var(--watch)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${idx.map(i => `<rect x="${x(c.t[i]) - 1}" y="${H - B - 22}" width="2" height="${S.su[i] ? 18 : 9}" fill="${S.su[i] ? "var(--threat)" : "var(--flow)"}"/>`).join("")}
    ${idx.filter(i => c.al[i]).map(i => `<circle cx="${x(c.t[i])}" cy="${yR(c.r[i] / 100)}" r="6" fill="none" stroke="var(--threat)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`).join("")}
    <line x1="${x(S.clock)}" x2="${x(S.clock)}" y1="${T}" y2="${H - B}" stroke="var(--signal)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <text x="${L}" y="${H - 6}">+0 s</text><text x="${W - R}" y="${H - 6}" text-anchor="end">+${(S.dur / 1000).toFixed(1)} s</text></svg>`;
  body.innerHTML = `<div class="evhead"><span class="route">${S.sc.ips[h]}</span><span class="muted">${int(nFl)} flows so far, ${int(nSu)} flagged, ${nAl} alert${nAl === 1 ? "" : "s"}${showTruth ? `, ${int(nAt)} attack flows (truth)` : ""}</span></div>${svg}
    <p class="faint">Amber line: the host's risk on a square-root scale (each flagged flow adds 1, fading with a ${S.P.tau_s} s memory). Ticks: its flows, tall red ones flagged. Rings: alerts. Blue line: replay clock.</p>`;
}

// ---------- controls ----------
function setPlayLabel() { const b = $("#playBtn"); b.textContent = playing ? "Pause" : (S && S.clock >= S.dur ? "Replay" : "Play"); }
function note() {
  const P = S.P, sp = speed();
  $("#replayNote").textContent = `Recorded engine output on held-out ${LABEL[net]} test flows, not live traffic. A flow is flagged when its TF-GNN score passes ${P.thr_gnn.toFixed(3)} (1% false alarms on validation); a host alert fires when its risk reaches ${P.R}. Playing at ${sp >= 1 ? sp.toFixed(sp < 10 ? 1 : 0) + "×" : "1/" + Math.round(1 / sp) + " speed"}.`;
  $("#riskHint").textContent = `mark = alert level ${P.R}`; $("#dur").textContent = "+" + (S.dur / 1000).toFixed(S.dur < 10000 ? 3 : 1) + " s";
}
async function start() {
  const [rep, ev] = await Promise.all([loadNet(net), loadEv(net)]);
  $("#scenario").innerHTML = rep.scenarios.map((s, i) => `<option value="${i}">${s.title === "Benign only" ? "Normal traffic only" : "Attack: " + nice(s.title)} (${int(s.n)} flows)</option>`).join("");
  if (scenIdx === null) { let best = 0, bv = -1; rep.scenarios.forEach((s, i) => { const at = s.cols.y.reduce((x, y) => x + y, 0), v = Math.min(at, s.n - at); if (v > bv) { bv = v; best = i; } }); scenIdx = best; }
  scenIdx = Math.min(scenIdx, rep.scenarios.length - 1); $("#scenario").value = scenIdx;
  S = prepare(rep, scenIdx, ev); sel = { i: -1, host: null, view: "ev" };
  cv.style.height = Math.round(Math.min(460, 70 + (S.lanes + 1) * (innerWidth < 640 ? 22 : 26))) + "px"; playing = true; setPlayLabel(); note(); resize(); panels(true); S.forceQ = true; queue(); renderInspector();
}
function legend() {
  $("#legend").innerHTML = `<span><i class="dot" style="background:var(--flow)"></i>flow</span><span><i class="dot" style="background:var(--threat)"></i>flagged</span>
    <span><i class="ring"></i>LightGBM flag</span><span><i class="ring" style="border-color:var(--threat);width:14px;height:14px"></i>alert</span>
    <span><i class="line" style="background:var(--e-src)"></i>same source</span><span><i class="line" style="background:var(--e-dst)"></i>same destination</span>
    <span><i class="line" style="background:var(--e-conv)"></i>same conversation</span><span id="truthLeg"><i class="tick"></i>attack (truth)</span>`;
}
function seg(el, items, cur, onPick) {
  el.innerHTML = items.map(([k, l]) => `<button role="radio" aria-checked="${k === cur}" data-k="${k}">${l}</button>`).join("");
  el.onclick = e => { const b = e.target.closest("button"); if (!b) return; $$("button", el).forEach(x => x.setAttribute("aria-checked", x === b)); onPick(b.dataset.k); };
}
function initControls() {
  seg($("#netSeg"), NETS.map(([k, l]) => [k, l.replace("CSE-CIC-IDS2018", "CSE-CIC")]), net, k => { net = k; scenIdx = null; start().catch(fail); });
  $("#scenario").addEventListener("change", e => { scenIdx = +e.target.value; start().catch(fail); });
  $("#playBtn").addEventListener("click", () => { if (S.clock >= S.dur) { start().catch(fail); return; } playing = !playing; setPlayLabel(); });
  $("#restartBtn").addEventListener("click", () => start().catch(fail));
  $("#speed").addEventListener("change", e => { speedMode = e.target.value; note(); });
  $("#truth").addEventListener("change", e => { showTruth = e.target.checked; $("#truthLeg").style.display = showTruth ? "" : "none"; S.forceQ = true; panels(true); renderInspector(); });
  $$(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab, true)));
  window.addEventListener("resize", () => { resize(); draw(); });
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1) || "console", false));
}
function showTab(t, push) {
  if (!$("#tab-" + t)) t = "console";
  $$(".tabs button").forEach(x => x.setAttribute("aria-selected", x.dataset.tab === t));
  $$(".tab").forEach(s => s.hidden = s.id !== "tab-" + t);
  if (push) history.replaceState(null, "", t === "console" ? location.pathname : "#" + t);
  if (t === "console") { resize(); draw(); }
  window.scrollTo(0, 0);
}
function fail(e) { $("#replayNote").textContent = "The replay data could not be loaded: " + e.message + ". Reload the page to try again."; }

// ======================= hero status =======================
function heroStatus() {
  const E = V2.engine, acc = V2.evidence_accuracy, ci = Object.fromEntries(V2.tfgnn_ci.map(r => [r.network, r]));
  const fps = E.map(e => e.fps), fah = E.map(e => e.fa_hosts_day);
  $("#status").innerHTML = `<span><i></i><b>Engine verified</b> equal to offline scores</span>
    <span><b>${Math.round(Math.min(...fps) / 1000)}–${Math.round(Math.max(...fps) / 1000)}k</b> flows per second on a CPU</span>
    <span><b>${pct(ci["CSE-CIC-IDS2018"].recall_mean, 1)}</b> of CSE attacks caught at 1% false alarms</span>
    <span><b>${Math.min(...fah)}–${Math.max(...fah)}</b> falsely alarmed hosts per day</span>
    <span><b>${pct(acc["CSE-CIC-IDS2018"].overall, 0)}</b> of alerts named correctly</span>`;
}

// ======================= retrain =======================
let RT = { net: "CSE-CIC-IDS2018", fam: null, model: "LightGBM", k: 100 };
function retrain() {
  const F = V2.fewshot_family, nets = [...new Set(F.map(r => r.network))];
  seg($("#rtNet"), nets.map(n => [n, n.replace("CSE-CIC-IDS2018", "CSE-CIC")]), RT.net, k => { RT.net = k; RT.fam = null; retrainDraw(); });
  $("#rtFam").addEventListener("change", e => { RT.fam = e.target.value; retrainDraw(); });
  retrainDraw(); newNet(); tonDiag();
}
const FAMNAME = { dos: "DoS", ddos: "DDoS", bruteforce: "Brute force", web: "Web attacks", recon: "Scanning / recon", backdoor_bot: "Backdoor and bots" };
function retrainDraw() {
  const F = V2.fewshot_family.filter(r => r.network === RT.net), fams = [...new Set(F.map(r => r.family))];
  if (!RT.fam || !fams.includes(RT.fam)) RT.fam = fams.includes("web") ? "web" : fams[0];
  $("#rtFam").innerHTML = fams.map(f => `<option value="${f}" ${f === RT.fam ? "selected" : ""}>${FAMNAME[f] || f}</option>`).join("");
  const models = [...new Set(F.filter(r => r.family === RT.fam).map(r => r.model))];
  if (!models.includes(RT.model)) RT.model = models[0];
  seg($("#rtModel"), models.map(m => [m, m === "TF-GNN" ? "TF-GNN (fine-tuned)" : "LightGBM (retrained)"]), RT.model, k => { RT.model = k; retrainDraw(); });
  const R = F.filter(r => r.family === RT.fam && r.model === RT.model), ks = [...new Set(R.map(r => r.k))].sort((a, b) => a - b).filter(k => k > 0);
  if (!ks.includes(RT.k)) RT.k = ks.includes(100) ? 100 : ks[0];
  seg($("#rtK"), ks.map(k => [String(k), int(k)]), String(RT.k), k => { RT.k = +k; retrainDraw(); });
  const cls = [...new Set(R.map(r => r.attack))], SD = V2.fewshot_seeds_cse;
  const useSeeds = RT.net === "CSE-CIC-IDS2018" && RT.model === "LightGBM" && [10, 100].includes(RT.k);
  $("#rtRangeLeg").style.display = useSeeds ? "" : "none";
  $("#rtBars").innerHTML = cls.map(c => {
    const b = R.find(r => r.attack === c && r.k === 0)?.recall ?? 0, a = R.find(r => r.attack === c && r.k === RT.k)?.recall ?? 0;
    const sv = useSeeds ? SD.filter(r => r.attack === c && r.k === RT.k).map(r => r.recall) : [];
    const rng = sv.length > 1 ? `<span class="range" style="left:${100 * Math.min(...sv)}%;width:${100 * (Math.max(...sv) - Math.min(...sv))}%" title="5 runs: ${Math.min(...sv).toFixed(2)}–${Math.max(...sv).toFixed(2)}"></span>` : "";
    return `<div class="bar-row"><span class="nm">${esc(nice(c))}</span><span class="track" role="img" aria-label="${esc(nice(c))}: ${b.toFixed(2)} unseen, ${a.toFixed(2)} after ${RT.k} labels">
      <span class="before" style="width:${100 * b}%"></span><span class="after" style="width:${100 * a}%"></span>${rng}<span class="goal"></span></span><span class="v">${a.toFixed(2)}</span></div>`;
  }).join("");
  const run = V2.fewshot_runs.find(r => r.network === RT.net && r.family === RT.fam && r.model === RT.model && r.k === RT.k);
  $("#rtRun").textContent = run ? `With ${int(RT.k)} labelled flows (${int(run.k_actual)} used, the earliest of each attack type): other attacks caught ${pct(run.other_attacks_recall, 1)} (before ${pct(run.other_recall_k0, 1)}), false alarms on test ${pct(run.test_FPR, 2)}. ${RT.model === "TF-GNN" ? "TF-GNN was fine-tuned for one epoch; on ToN-IoT this sometimes lowered other attacks, so v2 retrains instead of fine-tuning." : "LightGBM is retrained from scratch in about a minute."}` : "";
}
function lineChart(series, opt) {
  const W = 560, H = 230, L = 40, R = 120, T = 12, B = 30, xs = [0, 10, 100, 1000], X = k => L + (xs.indexOf(k) / (xs.length - 1)) * (W - L - R), Y = v => T + (1 - v) * (H - T - B);
  const pal = [css("--signal"), css("--lgb"), css("--e-dst"), css("--ok"), css("--watch"), css("--threat")];
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${opt.label}">`;
  for (const v of [0, .5, .8, 1]) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" ${v === .8 ? 'stroke-dasharray="4 4"' : ""}/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  xs.forEach(k => s += `<text x="${X(k)}" y="${H - 10}" text-anchor="middle">${k}</text>`);
  const ends = series.map((se, i) => ({ y: Y(se.pts[se.pts.length - 1][1]), i })).sort((a, b) => a.y - b.y);
  for (let j = 1; j < ends.length; j++) if (ends[j].y - ends[j - 1].y < 14) ends[j].y = ends[j - 1].y + 14;
  series.forEach((se, i) => { const col = pal[i % pal.length];
    s += `<path d="${se.pts.map((p, j) => (j ? "L" : "M") + X(p[0]) + " " + Y(p[1])).join("")}" fill="none" stroke="${col}" stroke-width="2"/>`;
    se.pts.forEach(p => s += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3.5" fill="${col}"><title>${se.name}, k=${p[0]}: ${p[1].toFixed(3)}</title></circle>`);
    const ly = ends.find(e => e.i === i).y; s += `<text class="lab" x="${W - R + 8}" y="${ly + 4}" style="fill:${col}">${se.name}</text>`; });
  return s + `</svg><p class="faint">${opt.foot}</p>`;
}
function newNet() {
  const N = V2.fewshot_newnet, pairs = [...new Set(N.map(r => r.source + "|" + r.new_network))], short = n => n.replace("CSE-CIC-IDS2018", "CSE").replace("UNSW-NB15", "UNSW").replace("ToN-IoT", "ToN");
  $("#rtNew").innerHTML = lineChart(pairs.map(p => { const [a, b] = p.split("|"); return { name: `${short(a)} → ${short(b)}`, pts: N.filter(r => r.source === a && r.new_network === b).sort((x, y) => x.k - y.k).map(r => [r.k, r.recall]) }; }),
    { label: "Recall on a new network versus number of labelled attack flows", foot: "Horizontal axis: labelled attack flows from the new network (0, 10, 100, 1,000). Dashed line: 0.80. Labels flow in for CSE and UNSW quickly; ToN-IoT stays low." });
}
function tonDiag() {
  const D = V2.ton_diag.filter(r => r.k === 1000 || r.mode === "all"), cls = [...new Set(D.map(r => r.attack))];
  const get = (c, m) => D.find(r => r.attack === c && r.mode === m)?.recall;
  const verdict = c => { const e = get(c, "earliest"), b = Math.max(get(c, "random"), get(c, "latest")); if (b - e >= .3) return ["watch", "changes over time"]; if (get(c, "all") < .5) return ["threat", "not separable"]; return ["quiet", "needs more labels"]; };
  $("#rtDiag").innerHTML = `<div class="scroll"><table class="tbl"><thead><tr><th>Attack</th><th>first 1,000</th><th>spread over time</th><th>latest 1,000</th><th>all training data</th><th>reading</th></tr></thead><tbody>
    ${cls.map(c => { const v = verdict(c); return `<tr><td>${esc(c)}</td><td>${fmt(get(c, "earliest"), 2)}</td><td>${fmt(get(c, "random"), 2)}</td><td>${fmt(get(c, "latest"), 2)}</td><td>${fmt(get(c, "all"), 2)}</td><td><span class="tag ${v[0]}">${v[1]}</span></td></tr>`; }).join("")}</tbody></table></div>`;
}

// ======================= performance =======================
function intervalChart(rows) {
  const W = 1100, H = 40 + rows.length * 56, L = 160, R = 24, x0 = 0.5, X = v => L + (v - x0) / (1 - x0) * (W - L - R);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="TF-GNN recall per training run with 95% intervals">`;
  for (const v of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) s += `<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${H - 22}" stroke="var(--line)"/><text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v.toFixed(1)}</text>`;
  rows.forEach((r, k) => { const y = 30 + k * 54, [lo, hi] = r["recall_95CI_blocks+seeds"], sd = V2.tfgnn_seeds.filter(x => x.network === r.network);
    s += `<text class="lab" x="${L - 12}" y="${y + 4}" text-anchor="end">${r.network}</text>
      <rect x="${X(lo)}" y="${y - 9}" width="${X(hi) - X(lo)}" height="18" rx="4" fill="var(--signal)" opacity=".18"><title>95% interval ${lo}–${hi}</title></rect>
      ${sd.map(z => `<circle cx="${X(z.recall)}" cy="${y}" r="${z.seed === 0 ? 6 : 4.5}" fill="${z.seed === 0 ? "var(--threat)" : "var(--signal)"}" stroke="var(--panel)" stroke-width="1.5"><title>run ${z.seed}${z.seed === 0 ? " (v1)" : ""}: ${z.recall}</title></circle>`).join("")}
      <text x="${X(lo)}" y="${y + 26}">${lo.toFixed(2)}</text><text x="${X(hi)}" y="${y + 26}" text-anchor="end">${hi.toFixed(2)}</text>`; });
  return s + `</svg>`;
}
function burdenChart(e) {
  const W = 460, H = 170, L = 30, R = 10, T = 10, B = 28, D = e.per_day, n = D.length, bw = (W - L - R) / n, mx = Math.max(10, ...D.map(d => d.alerts)), Y = v => T + (1 - v / mx) * (H - T - B);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${e.network}: alerts and falsely alarmed hosts per test day">`;
  for (const v of [0, Math.round(mx / 2), mx]) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  D.forEach((d, i) => { const x = L + i * bw + bw * .18, w = bw * .64, tr = d.alerts - d.false_alerts;
    s += `<rect x="${x}" y="${Y(d.alerts)}" width="${w}" height="${Y(0) - Y(d.alerts)}" fill="var(--flow)" rx="2"><title>day ${i + 1}: ${d.alerts} alerts, ${d.false_alerts} false, ${d.fa_hosts} falsely alarmed hosts of ${d.hosts}</title></rect>
      <rect x="${x}" y="${Y(tr)}" width="${w}" height="${Y(0) - Y(tr)}" fill="var(--threat)" rx="2"/>
      <circle cx="${x + w / 2}" cy="${Y(d.fa_hosts)}" r="4" fill="var(--watch)" stroke="var(--panel)" stroke-width="1.5"/>
      <text x="${x + w / 2}" y="${H - 10}" text-anchor="middle">${i + 1}</text>`; });
  return s + `</svg>`;
}
function perfTab() {
  const E = V2.engine, CI = V2.tfgnn_ci, A = V2.evidence_accuracy, rates = Object.fromEntries(SUM.rates.map(r => [r.dataset, r]));
  const v1p1 = n => SUM.p1.find(r => r.network === n && r.model === "TF-GNN");
  let h = `<div class="grid3">${["UNSW-NB15", "CSE-CIC-IDS2018", "ToN-IoT"].map(n => { const c = CI.find(r => r.network === n), p = v1p1(n);
    return `<div class="panel"><h2>${n}</h2>${c ? `<div class="bignum">${fmt(c.recall_mean, 3)} <span class="pm">± ${fmt(c.recall_sd, c.recall_sd < 0.001 ? 4 : 3)}</span></div><span class="faint">attacks caught, mean of 5 training runs</span>
      <dl class="kv" style="margin-top:10px"><dt>95% interval</dt><dd>${c["recall_95CI_blocks+seeds"].map(v => v.toFixed(2)).join(" to ")}</dd><dt>false alarms</dt><dd>${pct(c.FPR_mean, 2)} of normal flows (interval ${c["FPR_95CI_blocks+seeds"].map(v => pct(v, 1)).join(" to ")})</dd><dt>PR-AUC</dt><dd>${fmt(c.PR_AUC_mean, 3)} ± ${fmt(c.PR_AUC_sd, c.PR_AUC_sd < 0.001 ? 4 : 3)}</dd></dl>`
      : `<div class="bignum">${fmt(p.recall_DR, 3)}</div><span class="faint">attacks caught, one run (every model scores 1.0 here, so it was not repeated)</span><dl class="kv" style="margin-top:10px"><dt>false alarms</dt><dd>${pct(p.FPR_FAR, 2)}</dd><dt>PR-AUC</dt><dd>${fmt(p.PR_AUC, 3)}</dd></dl>`}</div>`; }).join("")}</div>`;
  h += `<div class="panel"><div class="ph"><h2>How sure: 5 training runs and 95% intervals</h2></div><p class="lede">Dots are separate training runs (red = the v1 model); the band is a 95% interval from resampling whole attack bursts. Training randomness barely moves the result; which attack bursts happen to be in the test set moves it a lot, because most attack types appear in only one burst.</p>${intervalChart(CI)}</div>`;
  h += `<div class="panel"><div class="ph"><h2>What an analyst would face each day</h2></div><p class="lede">Deployed v1 policy (a host alert when its risk reaches 10; risk memory 600 s on UNSW and ToN, 30 s on CSE), on every test day. Bars: alerts per day, red part real attacks, grey part false. Amber dots: hosts falsely alarmed that day.</p>
    <div class="grid3">${E.map(e => `<div><h3>${e.network}</h3>${burdenChart(e)}<p class="faint">Median ${e.fa_hosts_day} falsely alarmed hosts per day out of ${int(e.hosts_day)} hosts seen; ${e.false_alerts} of ${e.alerts} alerts false over ${e.days} days.</p></div>`).join("")}</div></div>`;
  h += `<div class="grid2"><div class="panel"><h2>Engine</h2><p class="lede">Every test flow was streamed through the engine and compared with the offline pipeline: same neighbours, same scores (largest difference 0.0000001), same alerts.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Network</th><th>flows streamed</th><th>proofs</th><th>flows / s</th><th>busiest second seen</th></tr></thead><tbody>
    ${E.map(e => `<tr><td>${e.network}</td><td>${int(e.flows)}</td><td><span class="tag ${e.proofs ? "ok" : "threat"}">${e.proofs ? "pass" : "fail"}</span></td><td>${int(e.fps)}</td><td>${int(rates[e.network]?.max_flows_per_s)}</td></tr>`).join("")}</tbody></table></div>
    <p class="faint">Kaggle CPU, full pipeline: graph, features, TF-GNN, LightGBM second opinion, alerting and an evidence card for every alert.</p></div>
    <div class="panel"><h2>Evidence cards</h2><p class="lede">How often "looks like" names the right attack type for detected attacks, against simply guessing the most common type.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Network</th><th>named correctly</th><th>guessing</th><th>when all 5 agree</th><th>false alarms voted normal</th></tr></thead><tbody>
    ${Object.entries(A).map(([n, a]) => `<tr><td>${n}</td><td><b>${pct(a.overall, 1)}</b></td><td>${pct(a.baseline, 0)}</td><td>${pct(a.all5, 1)} (of ${pct(a.share_all5, 0)})</td><td>${pct(a.fa_benign, 1)}</td></tr>`).join("")}</tbody></table></div></div></div>`;
  const cc = V2.tfgnn_class_ci;
  h += `<div class="panel"><h2>Known blind spots</h2><p class="lede">Attack types this detector misses or only partly catches, even after training on them, with the range over 5 runs. Reported so nobody relies on it where it is weak.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Network</th><th>Attack</th><th>caught (5 runs)</th><th class="wrap">why</th></tr></thead><tbody>
    ${[["ToN-IoT", "scanning", "Looks like normal traffic in flow records; even 50,000 labelled flows reach only 0.08 with LightGBM."], ["CSE-CIC-IDS2018", "Infilteration", "Many of its flows look like normal traffic: half of CSE false alarms are named as Infilteration by the evidence card."],
       ["ToN-IoT", "password", "Large, varied attack type; needs far more examples."], ["CSE-CIC-IDS2018", "SQL_Injection", "Very few test flows (64), so the number swings between runs."]].map(([n, a, w]) => { const r = cc.find(x => x.network === n && x.attack === a);
       return r ? `<tr><td>${n}</td><td>${esc(nice(a))}</td><td>${fmt(r.recall_seed_min, 2)}–${fmt(r.recall_seed_max, 2)}</td><td class="wrap">${w}</td></tr>` : ""; }).join("")}
    <tr><td>ToN-IoT</td><td>all traffic</td><td>–</td><td class="wrap">Traffic drifts from day to day: at a 1% validation threshold, test false alarms run at 1.8–2.3%.</td></tr>
    <tr><td>any new network</td><td>all attacks</td><td>–</td><td class="wrap">Without labels from the new network the detector does not transfer; 10–100 labelled flows fix it for CSE and UNSW, not for ToN-IoT.</td></tr></tbody></table></div></div>`;
  h += `<details class="more panel"><summary>Version 1 benchmark tables</summary>${v1tables()}</details>`;
  $("#perfBody").innerHTML = h;
}
function table(cols, rows, opt = {}) {
  return `<div class="scroll"><table class="tbl">${opt.caption ? `<caption>${opt.caption}</caption>` : ""}<thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${opt.hl && opt.hl(r) ? "hl" : ""}">${cols.map(c => `<td>${c[1](r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function v1tables() {
  const ORDER = ["TF-GNN", "TF-GNN-noEdges", "LightGBM+ctx", "LightGBM", "RandomForest", "MLP-noGraph", "IsolationForest"];
  const p1 = n => SUM.p1.filter(r => r.network === n).sort((a, b) => ORDER.indexOf(a.model) - ORDER.indexOf(b.model));
  return `<p class="lede" style="margin-top:12px">Single-run results from version 1 (protocol P1: each network trained on its earlier traffic and tested on later traffic). TF-GNN-noEdges is the same model without the graph.</p>
    <div class="grid3">${["UNSW-NB15", "CSE-CIC-IDS2018", "ToN-IoT"].map(n => table([["Model", r => r.model], ["PR-AUC", r => fmt(r.PR_AUC, 4)], ["Recall", r => fmt(r.recall_DR)], ["FPR", r => pct(r.FPR_FAR, 2)]], p1(n), { caption: n, hl: r => r.model === "TF-GNN" })).join("")}</div>
    <h3 style="margin-top:16px">Other networks without labels (P3)</h3>${table([["Trained on", r => r.train], ["Tested on", r => r.test], ["Model", r => r.model.replace("-cross", "")], ["ROC-AUC", r => fmt(r.ROC_AUC)], ["Recall", r => fmt(r.recall_DR)], ["FPR", r => pct(r.FPR_FAR, 2)]], SUM.p3)}`;
}

// ======================= findings =======================
const PHASES = [
  ["V0", "pass", "Reproduce version 1 exactly", "All 48 v1 test results and every alert were recomputed from the frozen backup.", "The starting point is trustworthy: largest difference 0.0001."],
  ["V1", "diag", "Diagnose why v1 fails elsewhere", "Measured calibration vs ranking, daily false-alarm drift, how different the networks are, and which unseen attack types are visible at all.", "On other networks the model ranks badly, not just with the wrong threshold; ToN-IoT's false alarms drift up to 3.8× from day to day."],
  ["V2", "fail", "Re-tune thresholds without labels", "Thresholds were re-estimated each day from flows presumed normal.", "Excluding alerted hosts removed the busiest normal hosts, so thresholds collapsed (53–82% false alarms). Fixed thresholds stay."],
  ["V3", "fail", "Learn only normal traffic (graph autoencoder)", "GraphMAE rebuilt flows from their causal neighbours; badly rebuilt flows were treated as attacks.", "Works on the small UNSW network (0.95), fails on CSE and ToN at 1% false alarms: rare but harmless flows sit above most attacks."],
  ["V4", "fail", "Judge whole hosts, not single flows", "Behaviour of each source over 60 s: counts, fan-out, ports, repetition.", "A few very busy normal servers look more unusual than attackers, so the threshold lands on them. Same lesson one level up."],
  ["V5", "fail", "How many labels teach a new attack?", "Removed an attack family, then gave back 10, 100 or 1,000 labelled flows.", "On CSE, 10–100 labels recover new attack types and new networks at 1% false alarms. ToN-IoT needs far more, and fine-tuning TF-GNN can hurt other attacks: retrain instead."],
  ["V5-E", "diag", "Why ToN-IoT is hard", "Compared first, latest, spread-out and all labelled flows.", "Three causes: DoS changes over time, XSS and passwords need many labels, scanning is not separable in flow records."],
  ["V6", "fail", "Five training runs and confidence intervals", "TF-GNN retrained with 4 more seeds; block bootstrap over attack bursts.", "CSE is rock-steady (0.964 ± 0.0002) and v1 was not a lucky run. ToN varies slightly more than the 0.03 limit. Intervals are wide because test sets hold few attack bursts."],
  ["V7", "pass", "Evidence for every alert, inside the engine", "Nearest known flows, unusual measurements and context; engine re-verified end to end.", "Alerts are named correctly 97.8% (CSE) and 97.9% (ToN) of the time; the engine still equals v1 exactly and runs at 20–26k flows/s."]
];
function findings() {
  const lab = { pass: "pass", fail: "fail", diag: "diagnostic" };
  $("#timeline").innerHTML = PHASES.map(([id, v, t, what, learned]) => `<li><div class="num ${v}">${id}</div><div class="body"><h3>${t} <span class="tag ${v === "pass" ? "ok" : v === "fail" ? "threat" : "watch"}">${lab[v]}</span></h3>
    <p>${what}</p><p class="learned"><b>Learned:</b> ${learned}</p></div></li>`).join("");
}

// ======================= guide =======================
function guide() {
  $("#howBody").innerHTML = `<h2 style="margin-bottom:12px">From one flow to one alert</h2><ol class="steps">
    <li><span><b>Link to the past.</b> Each finished flow is connected to the previous flow of the same conversation, the last five from the same source and the last three to the same destination, within 120 s.</span></li>
    <li><span><b>Describe the context.</b> Thirteen numbers say how busy the source and destination are, how many targets and ports the source touched, and how long since it last appeared.</span></li>
    <li><span><b>Score with the graph network.</b> A two-layer temporal flow GNN combines the flow with its neighbours and their neighbours. Neighbour embeddings are cached, so each flow costs the same however long the stream runs.</span></li>
    <li><span><b>Build host risk.</b> Each flagged flow adds 1 to its source's risk, which fades over time (a 30 s memory on CSE, 600 s on the others). One alert is raised when risk reaches 10, instead of one per flow.</span></li>
    <li><span><b>Explain the alert.</b> The evidence card names the 5 most similar known flows, the measurements furthest from normal and what the source did just before.</span></li>
    <li><span><b>Teach it new attacks.</b> When an analyst confirms flows of a new attack, LightGBM retrains in about a minute; label examples spread over time, not only the first ones.</span></li></ol>`;
  $("#limitsBody").innerHTML = `<h2 style="margin-bottom:12px">What it does not claim</h2><ul class="muted" style="padding-left:18px;margin:0">
    <li>Catching attack types it has never seen without any labels. Four label-free methods were tried in version 2; all fail on realistic networks at 1% false alarms.</li>
    <li>Working on a new network out of the box. It needs labelled flows from that network.</li>
    <li>Seeing ToN-IoT scanning, which looks like normal traffic in flow records.</li>
    <li>Live capture. This page replays recorded engine output on public research datasets; a live deployment needs an exporter producing the same NetFlow v3 features.</li></ul>
    <h2 style="margin:18px 0 8px">Data</h2><p class="muted">NF-UNSW-NB15-v3, NF-CSE-CIC-IDS2018-v3 and NF-ToN-IoT-v3, published by the University of Queensland. Duplicates removed, every network split by time with a purge gap, preprocessing fitted on training data only, thresholds chosen on validation data only.</p>`;
  const groups = [...new Set(TERMS.map(t => t.g))];
  $("#glGroup").innerHTML = `<option value="">All topics</option>` + groups.map(g => `<option>${esc(g)}</option>`).join("");
  const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, '<span class="mono">$1</span>');
  const render = () => { const q = $("#glSearch").value.trim().toLowerCase(), g = $("#glGroup").value;
    const list = TERMS.filter(t => (!g || t.g === g) && (!q || (t.t + " " + t.d + " " + t.c).toLowerCase().includes(q)));
    $("#glCount").textContent = `${list.length} of ${TERMS.length} terms, from the project's TERMS.md.`;
    $("#terms").innerHTML = list.map(t => `<div class="term"><b>${md(t.t)}</b><p>${md(t.d)}</p><small>${md(t.c)}</small></div>`).join("") || `<p class="muted">No term matches "${esc(q)}". Try a shorter word.</p>`; };
  $("#glSearch").addEventListener("input", render); $("#glGroup").addEventListener("change", render); render();
}

// ======================= boot =======================
(async function boot() {
  legend(); initControls(); resize();
  try { [V2, SUM, P6, TERMS] = await Promise.all([getJSON("v2.json"), getJSON("summary.json"), getJSON("phase6.json"), getJSON("terms.json")]); }
  catch (e) { $("#replayNote").textContent = "Results could not be loaded: " + e.message + ". Reload the page to try again."; return; }
  heroStatus(); findings(); guide(); perfTab(); retrain();
  showTab(location.hash.slice(1) || "console", false);
  await start().catch(fail);
  requestAnimationFrame(frame);
  setTimeout(runPipe, 250);
})();
