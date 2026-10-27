/* ============================================================
   The control room: a 2D schematic of the control plane's real mechanisms, driven by the same simulation state
   as the yard. It watches the state for changes (a Deployment applied, a Pod bound, a probe passing) and plays the
   true sequence for each as messages between the boxes:
     kubectl -> kube-apiserver pipeline (authentication, authorization, mutating admission, validating admission,
     schema validation, write) -> etcd (Raft: the leader proposes and appends the entry, replicates it to the
     followers, a quorum acknowledges, it is committed and applied) -> the watch cache fans the event out to every
     watcher -> controllers (informer cache -> work queue -> reconcile -> a write back to the API server), the
     scheduler (filter -> score -> bind), the kubelet on the bound node (watch -> CRI pull and start -> probes ->
     status) and kube-proxy (EndpointSlices -> rules).
   Two extra Break choices stop an etcd follower (nothing changes: the leader still has a quorum) or the leader
   (election: the term goes up, writes wait, then resume). Everything here is drawing; the only state it changes
   is st.cp.hold while etcd has no leader.
   ============================================================ */
(() => {
const INKC = '#231e16', PAPERC = '#f2efe7', CREAMC = '#fff4d6', GREEN = '#43c25c', AMBER = '#f2b230', REDC = '#e2483d', BLUEC = '#5a82c6', MUTED = '#857d6e';
let el, svg, dyn, logEl, cfg, prev = null, shown = false;
const R = { now: 0, flows: [], timers: [], lit: new Map(), chips: { dep: [], rs: [], ep: [] }, term: 1, leader: 0, down: null, noLeader: false, waiting: 0, rv: 1042, index: 0,
  members: [0, 1, 2].map(i => ({ name: 'etcd-' + (i + 1), up: true, role: i === 0 ? 'leader' : 'follower', log: [], commit: 0 })),
  node: 'node-a', proxyNode: 'node-a', gate: new Map(), inflight: new Map(), log: '', driving: false, lastT: 0, fb: 0, scoreNote: '', filterOn: {} };
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f4b829';

/* ---------- geometry ---------- */
const STAGES = ['AuthN', 'AuthZ (RBAC)', 'Mutating\nadmission', 'Validating\nadmission', 'Schema\nvalidation', 'Write\n(storage)'];
const sx = i => 162 + i*76 + 35, SY = 81;                       // API pipeline stage centres
const mx = i => 662 + i*108 + 48, MY = 106;                      // etcd member centres
const CTRL = { dep: { x: 32, title: 'Deployment controller' }, rs: { x: 228, title: 'ReplicaSet controller' }, ep: { x: 424, title: 'EndpointSlice controller' } };
const cx = id => CTRL[id].x + 93;                                // a controller loop's centre line
const WATCH = [385, 138], BUS = 186;                             // the watch cache, and the line events run along
const KSTAGES = ['Watch\nbound Pods', 'CRI: pull\nimage', 'CRI: start\ncontainers', 'Probes\nready / live', 'Status\nPodReady'];
const kx = i => 32 + i*116 + 50, KY = 492;
const SCH = { queue: [662, 250], filter: [662, 288], score: [662, 330], bind: [662, 364] };
const PRX = { informer: [815, 468], rules: [815, 518], out: [815, 562] };

/* ---------- the static drawing ---------- */
const box = (x, y, w, h, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r == null ? 6 : o.r}" fill="${o.fill || CREAMC}" stroke="${INKC}" stroke-width="${o.sw || 1.4}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
const text = (s, x, y, o = {}) => s.split('\n').map((ln, i, a) => `<text x="${x}" y="${y + (i - (a.length - 1)/2)*(o.size || 11.5)*1.15}" text-anchor="${o.anchor || 'middle'}" font-size="${o.size || 11.5}" font-weight="${o.weight || 700}" fill="${o.col || INKC}" letter-spacing="${o.ls == null ? '.03em' : o.ls}">${ln}</text>`).join('');
const title = (s, x, y) => text(s.toUpperCase(), x, y, { size: 11, weight: 800, anchor: 'start', ls: '.12em', col: MUTED });
const arrow = (pts, o = {}) => `<path d="M${pts.map(p => p.join(' ')).join('L')}" fill="none" stroke="${o.col || INKC}" stroke-width="${o.w || 1.1}" ${o.dash ? `stroke-dasharray="${o.dash}"` : ''} marker-end="url(#ah)"/>`;
function staticSvg(){
  let s = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INKC}"/></marker></defs>`;
  s += `<rect x="1" y="1" width="998" height="598" rx="12" fill="none" stroke="${INKC}" stroke-width="1.2" stroke-dasharray="3 4" opacity=".5"/>`;
  // kubectl
  s += box(20, 60, 100, 56) + text('kubectl', 70, 82, { size: 13 }) + text('apply · scale\nset image · drain', 70, 101, { size: 9.5, weight: 600, col: MUTED });
  s += arrow([[120, 88], [148, 88]]);
  // the API server pipeline
  s += box(150, 20, 470, 150, { fill: PAPERC, sw: 1.8 }) + title('kube-apiserver :6443', 162, 42) + `<g id="rv"></g>`;
  STAGES.forEach((n, i) => { s += `<g id="stage${i}">` + box(sx(i) - 35, 58, 70, 46, { r: 5 }) + text(n, sx(i), 81, { size: 10 }) + '</g>'; if (i) s += arrow([[sx(i) - 41, 81], [sx(i) - 36, 81]], { w: 1 }); });
  s += `<g id="watch">` + box(162, 118, 446, 40, { r: 5 }) + text('WATCH CACHE', 185, 138, { size: 10, anchor: 'start', ls: '.1em' }) + '</g>';
  s += arrow([[sx(5) + 36, 81], [648, 81]]);
  // etcd
  s += box(650, 20, 330, 150, { fill: PAPERC, sw: 1.8 }) + title('etcd · raft', 662, 42) + `<g id="term"></g>`;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) s += `<path d="M${mx(i)} ${MY}L${mx(j)} ${MY}" stroke="${INKC}" stroke-width=".8" opacity=".35"/>`;
  s += `<g id="members"></g>`;
  // the events bus: from the watch cache down to every watcher
  s += `<path d="M${WATCH[0]} 158L${WATCH[0]} ${BUS}L815 ${BUS}" fill="none" stroke="${INKC}" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>`;
  s += `<path d="M${WATCH[0]} ${BUS}L82 ${BUS}" fill="none" stroke="${INKC}" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>`;
  s += text('watch events', 400, BUS - 5, { size: 9.5, weight: 600, col: MUTED, anchor: 'start' });
  for (const x of [cx('dep'), cx('rs'), cx('ep'), 815]) s += arrow([[x, BUS], [x, 234]], { w: 1, dash: '2 3' });
  s += arrow([[82, BUS], [82, 444]], { w: 1, dash: '2 3' }) + arrow([[815, 382], [815, 444]], { w: 1, dash: '2 3' });
  // controllers
  s += box(20, 200, 600, 180, { fill: PAPERC, sw: 1.8 }) + title('kube-controller-manager', 32, 222);
  for (const [id, c] of Object.entries(CTRL)){ const x = c.x, X = cx(id);
    s += `<g id="c-${id}">` + box(x, 236, 186, 130, { r: 7 }) + text(c.title.toUpperCase(), x + 8, 250, { size: 9.5, anchor: 'start', ls: '.08em', col: MUTED }) + '</g>';
    s += `<g id="inf-${id}">` + box(x + 10, 258, 166, 24, { r: 4 }) + text('informer cache', X, 270, { size: 10 }) + '</g>';
    s += `<g id="q-${id}">` + box(x + 10, 290, 166, 24, { r: 4 }) + text('work queue', x + 50, 302, { size: 10 }) + '</g>';
    s += `<g id="rec-${id}">` + box(x + 10, 322, 166, 32, { r: 4 }) + text('reconcile', x + 50, 338, { size: 10 }) + text(id === 'dep' ? 'wants a ReplicaSet' : id === 'rs' ? 'wants N Pods' : 'wants Ready endpoints', x + 110, 338, { size: 8.5, weight: 600, col: MUTED }) + '</g>';
    s += arrow([[X, 282], [X, 289]], { w: 1 }) + arrow([[X, 314], [X, 321]], { w: 1 });
    s += `<path d="M${x + 176} 338L${x + 186} 338L${x + 186} ${BUS + 8}" fill="none" stroke="${INKC}" stroke-width="1" opacity=".55"/>` + text('write', x + 184, BUS + 20, { size: 8.5, weight: 600, col: MUTED, anchor: 'end' });
  }
  // scheduler
  s += box(650, 200, 330, 180, { fill: PAPERC, sw: 1.8 }) + title('kube-scheduler', 662, 222);
  s += `<g id="s-queue">` + box(662, 236, 306, 28, { r: 4 }) + text('SCHEDULING QUEUE', 672, 250, { size: 10, anchor: 'start' }) + `<g id="s-pending"></g></g>`;
  s += `<g id="s-filter">` + box(662, 272, 306, 32, { r: 4 }) + text('FILTER', 672, 288, { size: 10, anchor: 'start' }) + '</g>';
  [['room', 'room'], ['gpu', 'GPU'], ['cordon', 'cordon'], ['gang', 'gang']].forEach(([k, n], i) => { s += `<g id="f-${k}">` + box(728 + i*58, 278, 52, 20, { r: 10, sw: 1 }) + text(n, 754 + i*58, 288, { size: 9.5 }) + '</g>'; });
  s += `<g id="s-score">` + box(662, 312, 306, 28, { r: 4 }) + text('SCORE', 672, 326, { size: 10, anchor: 'start' }) + text('spread: fewest pods first', 728, 326, { size: 9.5, weight: 600, col: MUTED, anchor: 'start' }) + `<g id="s-scorenote"></g></g>`;
  s += `<g id="s-bind">` + box(662, 348, 306, 24, { r: 4 }) + text('BIND', 672, 360, { size: 10, anchor: 'start' }) + text('write pod.spec.nodeName', 728, 360, { size: 9.5, weight: 600, col: MUTED, anchor: 'start' }) + '</g>';
  s += arrow([[815, 264], [815, 271]], { w: 1 }) + arrow([[815, 304], [815, 311]], { w: 1 }) + arrow([[815, 340], [815, 347]], { w: 1 });
  s += `<path d="M968 360L978 360L978 ${BUS + 8}" fill="none" stroke="${INKC}" stroke-width="1" opacity=".55"/>` + text('write', 976, BUS + 20, { size: 8.5, weight: 600, col: MUTED, anchor: 'end' });
  // kubelet
  s += box(20, 410, 600, 170, { fill: PAPERC, sw: 1.8 }) + `<g id="k-title"></g>`;
  KSTAGES.forEach((n, i) => { s += `<g id="k${i}">` + box(kx(i) - 50, 462, 100, 60, { r: 5 }) + text(n, kx(i), KY, { size: 10 }) + '</g>'; if (i) s += arrow([[kx(i) - 57, KY], [kx(i) - 51, KY]], { w: 1 }); });
  s += `<path d="M${kx(3)} 522L${kx(3)} 540L${kx(2)} 540L${kx(2)} 523" fill="none" stroke="${INKC}" stroke-width="1" marker-end="url(#ah)"/>` + text('liveness failed: restart', (kx(2) + kx(3))/2, 551, { size: 8.5, weight: 600, col: MUTED });
  s += `<path d="M${kx(4) + 50} 492L612 492L612 ${BUS + 8}" fill="none" stroke="${INKC}" stroke-width="1" opacity=".55"/>` + text('write', 610, BUS + 20, { size: 8.5, weight: 600, col: MUTED, anchor: 'end' });
  // kube-proxy
  s += box(650, 410, 330, 170, { fill: PAPERC, sw: 1.8 }) + `<g id="p-title"></g>`;
  s += `<g id="p-inf">` + box(662, 456, 306, 24, { r: 4 }) + text('informer: EndpointSlices', 815, 468, { size: 10 }) + '</g>';
  s += `<g id="p-rules">` + box(662, 506, 306, 24, { r: 4 }) + text('rules: iptables / IPVS / nftables', 815, 518, { size: 10 }) + '</g>';
  s += `<g id="p-out">` + box(662, 550, 306, 24, { r: 4 }) + text('ClusterIP -> one Ready endpoint', 815, 562, { size: 10 }) + '</g>';
  s += arrow([[815, 480], [815, 505]], { w: 1 }) + arrow([[815, 530], [815, 549]], { w: 1 });
  s += `<g id="dyn"></g>`;
  return s;
}

/* ---------- the moving parts ---------- */
const sleep = ms => new Promise(r => R.timers.push({ at: R.now + ms, r }));
const plen = pts => pts.reduce((a, p, i) => i ? a + Math.hypot(p[0] - pts[i-1][0], p[1] - pts[i-1][1]) : 0, 0);
function bead(pts, o = {}){ const L = plen(pts); return new Promise(r => { R.flows.push({ pts, L, col: o.col || BLUEC, label: o.label || '', t: 0, dur: o.dur || Math.max(220, L*2.2), small: !!o.small, r }); drive(); }); }
const at = (f, u) => { let d = u*f.L; for (let i = 1; i < f.pts.length; i++){ const a = f.pts[i-1], b = f.pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d <= l || i === f.pts.length - 1){ const k = l ? Math.min(1, d/l) : 0; return [a[0] + (b[0] - a[0])*k, a[1] + (b[1] - a[1])*k]; } d -= l; } return f.pts[f.pts.length - 1]; };
function lit(id, ms = 700){ R.lit.set(id, R.now + ms); drive(); }
function logLine(s){ R.log = s; if (logEl) logEl.textContent = s; }
function tick(dt){
  R.now += dt*1000*cfg.speed();
  for (const t of R.timers.slice()) if (R.now >= t.at){ R.timers.splice(R.timers.indexOf(t), 1); t.r(); }
  for (const f of R.flows.slice()){ f.t += dt*1000*cfg.speed(); if (f.t >= f.dur){ R.flows.splice(R.flows.indexOf(f), 1); f.r(); } }
  for (const [k, until] of R.lit) if (R.now >= until) R.lit.delete(k);
  return R.flows.length > 0 || R.timers.length > 0 || R.lit.size > 0;
}
const frame = () => { if (!R.driving) return; R.driving = false; clearTimeout(R.fb); const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - R.lastT)/1000)); R.lastT = now; const busy = tick(dt); render(); if (busy) drive(); };
function drive(){ if (R.driving) return; if (!R.flows.length && !R.timers.length && !R.lit.size) R.lastT = performance.now(); R.driving = true; requestAnimationFrame(frame); R.fb = setTimeout(frame, 60); }
function render(){
  if (!svg) return; const st = cfg.st, A = accent();
  let s = '';
  // lit boxes: a tinted copy over the static one
  for (const id of R.lit.keys()){ const g = svg.querySelector('#' + CSS.escape(id) + ' > rect'); if (!g) continue; s += `<rect x="${g.getAttribute('x')}" y="${g.getAttribute('y')}" width="${g.getAttribute('width')}" height="${g.getAttribute('height')}" rx="${g.getAttribute('rx')}" fill="${A}" opacity=".55"/>`; }
  // etcd members
  let mem = ''; R.members.forEach((m, i) => { const x = mx(i) - 48, y = 56, down = !m.up;
    mem += box(x, y, 96, 100, { fill: down ? '#e6e1d6' : i === R.leader && !R.noLeader ? '#fff1bf' : CREAMC, dash: down ? '3 3' : '' }) + text(m.name, mx(i), y + 14, { size: 11.5 });
    mem += text(down ? 'STOPPED' : m.role.toUpperCase(), mx(i), y + 28, { size: 9.5, col: down ? REDC : m.role === 'leader' ? INKC : MUTED, ls: '.1em' });
    if (m.role === 'leader' && m.up && !R.noLeader) mem += `<path d="M${mx(i) - 8} ${y + 40}l4 -8 4 5 4 -5 4 8z" fill="${A}" stroke="${INKC}" stroke-width=".9"/>`;
    mem += text(`term ${m.term == null ? R.term : m.term}`, mx(i), y + 54, { size: 9.5, weight: 600, col: MUTED });
    const last = m.log.slice(-9); last.forEach((e, j) => { const ex = mx(i) - 40 + j*9.5, ey = y + 64; mem += `<rect x="${ex}" y="${ey}" width="7" height="7" rx="1.5" fill="${e.state === 'applied' ? INKC : e.state === 'committed' ? '#9a948a' : 'none'}" stroke="${INKC}" stroke-width=".8"/>`; });
    mem += text(`log ${m.log.length} · commit ${m.commit}`, mx(i), y + 88, { size: 8.5, weight: 600, col: MUTED }); });
  svg.querySelector('#members').innerHTML = mem;
  svg.querySelector('#term').innerHTML = text(`term ${R.term}${R.noLeader ? ' · NO LEADER: ELECTION' : R.down != null ? ' · quorum 2 of 3' : ' · quorum 3 of 3'}`, 968, 42, { size: 10, anchor: 'end', col: R.noLeader ? REDC : MUTED, ls: '.08em' });
  svg.querySelector('#rv').innerHTML = text(`resourceVersion ${R.rv}${R.waiting ? `  ·  ${R.waiting} write${R.waiting > 1 ? 's' : ''} waiting for etcd` : ''}`, 608, 42, { size: 10, anchor: 'end', col: R.waiting ? REDC : MUTED, ls: '.08em' });
  // queue chips on the controllers
  for (const [id, keys] of Object.entries(R.chips)){ const x = CTRL[id].x; keys.slice(0, 3).forEach((k, i) => { s += box(x + 92 + i*28, 294, 26, 16, { r: 8, fill: A, sw: .9 }) + text(k.slice(0, 4), x + 105 + i*28, 302, { size: 8 }); }); }
  const pend = st.pods.filter(p => p.phase === 'pending' && !(p.sys && !st.showSys)).length;
  svg.querySelector('#s-pending').innerHTML = text(pend ? `${pend} Pending` : 'empty', 958, 250, { size: 10, anchor: 'end', col: pend ? INKC : MUTED });
  svg.querySelector('#s-scorenote').innerHTML = R.scoreNote ? text(R.scoreNote, 958, 326, { size: 8.5, anchor: 'end', weight: 600 }) : '';
  svg.querySelector('#k-title').innerHTML = title(`kubelet · ${R.node}`, 32, 432) + text(`container runtime (CRI) · probes · status`, 608, 432, { size: 9.5, weight: 600, col: MUTED, anchor: 'end' });
  svg.querySelector('#p-title').innerHTML = title(`kube-proxy · ${R.proxyNode}`, 662, 432) + text('data plane', 968, 432, { size: 9.5, weight: 600, col: MUTED, anchor: 'end' });
  // beads
  for (const f of R.flows){ const u = Math.min(1, f.t/f.dur), [x, y] = at(f, u), r = f.small ? 3.5 : 5;
    for (let i = 3; i >= 1; i--){ const [qx, qy] = at(f, Math.max(0, u - i*.035)); s += `<circle cx="${qx.toFixed(1)}" cy="${qy.toFixed(1)}" r="${(r - i*.7).toFixed(1)}" fill="${f.col}" opacity="${(.45 - i*.1).toFixed(2)}"/>`; }
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${f.col}" stroke="${INKC}" stroke-width="1.1"/>`;
    if (f.label){ const w = f.label.length*6 + 10; s += `<rect x="${(x + 8).toFixed(1)}" y="${(y - 15).toFixed(1)}" width="${w}" height="15" rx="7.5" fill="${CREAMC}" stroke="${INKC}" stroke-width=".8"/>` + text(f.label, x + 8 + w/2, y - 7.5, { size: 9.5, weight: 700 }); } }
  dyn.innerHTML = s;
}

/* ---------- the sequences ---------- */
const PORT = { kubectl: [120, 88], dep: [CTRL.dep.x + 186, BUS + 8], rs: [CTRL.rs.x + 186, BUS + 8], ep: [CTRL.ep.x + 186, BUS + 8], sched: [978, BUS + 8], kubelet: [612, BUS + 8] };
const INF = { dep: [cx('dep'), 258], rs: [cx('rs'), 258], ep: [cx('ep'), 258], sched: [815, 236], kubelet: [82, 462], proxy: [815, 456] };
// a request into the API server, through the pipeline, into etcd, then the watch fan-out to `watchers`
async function apiCall(from, label, col, watchers = [], o = {}){
  const p0 = PORT[from] || from, entry = [sx(0), 104];
  const route = from === 'kubectl' ? [p0, [148, 88], [sx(0) - 35, 88]] : [p0, [p0[0], BUS - 10], [sx(0), BUS - 10], entry];
  await bead(route, { label, col, dur: from === 'kubectl' ? 420 : 620 });
  logLine(`${o.verb || (from === 'kubectl' ? 'kubectl' : from)} -> ${o.method || 'PUT'} ${label}`);
  for (let i = 0; i < 6; i++){ lit('stage' + i, 520); if (i) await bead([[sx(i-1), SY], [sx(i), SY]], { label, col, dur: 150 }); else await sleep(120); }
  const idx = await raftWrite(label, col);
  R.rv++; logLine(`etcd: txn ${idx} committed and applied -> watch event (resourceVersion ${R.rv})`);
  await bead([[mx(R.leader), MY + 50], [mx(R.leader), 138], [610, 138]], { label: 'event', col, dur: 320 }); lit('watch', 600);
  const paths = watchers.map(w => w === 'kubelet' ? [[WATCH[0], 158], [WATCH[0], BUS], [82, BUS], INF.kubelet] : w === 'proxy' ? [[WATCH[0], 158], [WATCH[0], BUS], [815, BUS], [815, 382], INF.proxy] : [[WATCH[0], 158], [WATCH[0], BUS], [INF[w][0], BUS], INF[w]]);
  await Promise.all(paths.map((p, i) => bead(p, { label: o.event || label.split(' ')[0], col, dur: 520 + i*40 }).then(() => lit(w2id(watchers[i]), 700))));
}
const w2id = w => w === 'sched' ? 's-queue' : w === 'kubelet' ? 'k0' : w === 'proxy' ? 'p-inf' : 'inf-' + w;
// Raft: propose, append, replicate, acknowledge (a quorum), commit, apply. Waits while there is no leader.
async function raftWrite(label, col){
  if (R.noLeader){ R.waiting++; render(); while (R.noLeader) await sleep(150); R.waiting--; }
  const L = R.members[R.leader], e = { idx: ++R.index, state: 'proposed', term: R.term }; L.log.push(e); lit('stage5', 400); render();
  const fol = R.members.filter((m, i) => i !== R.leader && m.up);
  await Promise.all(fol.map(m => bead([[mx(R.leader), MY], [mx(R.members.indexOf(m)), MY]], { label: 'append', col, dur: 260, small: true }).then(() => { m.log.push({ ...e }); })));
  await Promise.all(fol.map(m => bead([[mx(R.members.indexOf(m)), MY], [mx(R.leader), MY]], { label: 'ack', col: GREEN, dur: 260, small: true })));
  // the leader counts itself: with 3 members it needs one follower
  e.state = 'committed'; for (const m of fol){ const f = m.log[m.log.length - 1]; if (f) f.state = 'committed'; m.commit = e.idx; } L.commit = e.idx; render();
  await sleep(140); e.state = 'applied'; for (const m of fol){ const f = m.log[m.log.length - 1]; if (f) f.state = 'applied'; } render();
  return e.idx;
}
// a controller loop: the informer hands a key to the queue, reconcile runs, and (usually) writes something
async function controllerLoop(id, key, writeFn){
  R.chips[id].push(key); lit('inf-' + id, 500); await sleep(200); lit('q-' + id, 500); await sleep(260);
  R.chips[id] = R.chips[id].filter(k => k !== key); lit('rec-' + id, 800); await sleep(380);
  if (writeFn) await writeFn();
}
async function schedulerCycle(p, nodeName, o = {}){
  lit('s-queue', 500); await sleep(200); lit('s-filter', 700); const st = cfg.st;
  for (const f of ['room', ...(p.gpu ? ['gpu'] : []), ...(st.nodes.some(n => n.cordoned) ? ['cordon'] : []), ...(p.gang ? ['gang'] : [])]){ lit('f-' + f, 600); await sleep(110); }
  lit('s-score', 600); R.scoreNote = nodeName ? `${nodeName}: ${countOn(st.nodes.find(n => n.name === nodeName))} pods` : ''; await sleep(260);
  lit('s-bind', 600); await sleep(160);
  await apiCall('sched', o.label || `Binding ${p.name.slice(0, 12)} -> ${nodeName}`, col(p), ['kubelet'], { method: 'POST', verb: 'scheduler', event: 'Pod bound' });
}
async function kubeletStart(p){ R.node = p.node || R.node; lit('k0', 500); await sleep(220); lit('k1', 900); logLine(`kubelet ${R.node}: CRI pull ${p.containers[0].image}`); await sleep(700); lit('k2', 700); await sleep(420); }
async function kubeletStatus(p, label, watchers, o){ R.node = p.node || R.node; lit('k3', 700); await sleep(380); lit('k4', 600); await sleep(200); await apiCall('kubelet', label, col(p), watchers, { method: 'PATCH', verb: 'kubelet', ...o }); }
async function endpointsUpdate(svcName, podCol){ await controllerLoop('ep', svcName, () => apiCall('ep', `EndpointSlice ${svcName}`, podCol, ['proxy'], { verb: 'endpointslice ctrl' })); lit('p-rules', 800); logLine(`kube-proxy: rules updated for Service ${svcName}`); }
const col = p => (window.palOf ? palOf(p.app).l : BLUEC);
const gateOf = p => { if (!R.gate.has(p.id)) R.gate.set(p.id, {}); return R.gate.get(p.id); };
const promised = (g, k) => { if (!g[k]) g[k] = new Promise(r => { g[k + 'R'] = r; }); return g[k]; };
const settle = (g, k) => { promised(g, k); g[k + 'R'](); };
const raced = (pr, ms) => Promise.race([pr, sleep(ms)]);

/* ---------- watching the state ---------- */
function snap(){ const st = cfg.st; return {
  deps: Object.fromEntries(st.deploys.map(d => [d.name, { replicas: d.replicas, version: d.version, app: d.app, kind: d.kind }])),
  pods: Object.fromEntries(st.pods.map(p => [p.id, { phase: p.phase, node: p.node, doomed: !!p.doomed, restarts: p.restarts }])),
  nodes: Object.fromEntries(st.nodes.map(n => [n.name, { cordoned: n.cordoned, ready: n.ready, joined: n.joined }])),
  cp: { ...st.cp }, parcels: st.parcels.length, mode: st.mode }; }
function observe(){
  const st = cfg.st, now = snap(); if (!prev || prev.mode !== now.mode){ prev = now; return; }
  const live = st.mode === 'live', who = live ? 'kubectl' : 'kubectl';
  // Deployments: applied, deleted, scaled, a new image
  for (const [name, d] of Object.entries(now.deps)){ const o = prev.deps[name], dep = st.deploys.find(x => x.name === name), c = (window.palOf ? palOf(d.app).l : BLUEC);
    if (!o){ chain(`dep:${name}`, async () => { await apiCall(who, `${d.kind} ${name}`, c, ['dep'], { method: 'POST', verb: 'kubectl apply' }); R.rolling = R.rolling || {};
      await controllerLoop('dep', name, () => apiCall('dep', `ReplicaSet ${name}-${rsHash(d.app, d.version)}`, c, ['rs'], { method: 'POST', verb: 'deployment ctrl' }));
      await controllerLoop('rs', name, () => podWrite(d.app, c)); }); }
    else if (o.replicas !== d.replicas){ const down = d.replicas < o.replicas, k = Math.abs(d.replicas - o.replicas); chain(`dep:${name}`, async () => { await apiCall(who, `Deployment ${name} replicas=${d.replicas}`, c, ['dep'], { method: 'PATCH', verb: 'kubectl scale' });
      await controllerLoop('dep', name, () => apiCall('dep', `ReplicaSet ${name}-${rsHash(d.app, d.version)} replicas=${d.replicas}`, c, ['rs'], { method: 'PATCH', verb: 'deployment ctrl' }));
      await controllerLoop('rs', name, () => down ? apiCall('rs', `delete Pod x${k} (youngest first)`, c, ['kubelet', 'ep'], { method: 'DELETE', verb: 'replicaset ctrl' }) : podWrite(d.app, c)); }); }
    else if (o.version !== d.version){ chain(`dep:${name}`, async () => { await apiCall(who, `Deployment ${name} image ${d.version}`, c, ['dep'], { method: 'PATCH', verb: 'kubectl set image' });
      await controllerLoop('dep', name, () => apiCall('dep', `ReplicaSet ${name}-${rsHash(d.app, d.version)} replicas=1 (surge)`, c, ['rs'], { method: 'POST', verb: 'deployment ctrl' }));
      await controllerLoop('rs', name, () => podWrite(d.app, c)); }); } }
  for (const [name, o] of Object.entries(prev.deps)) if (!now.deps[name]){ const c = (window.palOf ? palOf(o.app).l : BLUEC);
    chain(`dep:${name}`, async () => { await apiCall(who, `delete ${o.kind} ${name}`, c, ['dep'], { method: 'DELETE', verb: 'kubectl delete' });
      await controllerLoop('dep', name, () => apiCall('dep', `delete ReplicaSet ${name}-${rsHash(o.app, o.version)} (garbage collector)`, c, ['rs'], { method: 'DELETE', verb: 'garbage collector' }));
      await controllerLoop('rs', name, () => apiCall('rs', `delete Pods of ${name}`, c, ['kubelet', 'ep'], { method: 'DELETE', verb: 'garbage collector' })); }); }
  // Pods: created, bound, started, ready, crashed, unready, terminating
  const created = {}, bound = [], dropped = [], started = [], ready = [], crashed = [], deleted = [], unready = [], reready = [], gone = {};
  for (const p of st.pods){ const o = prev.pods[p.id], n = now.pods[p.id]; if (p.sys && !st.showSys) continue;
    if (!o){ if (['pending', 'creating', 'running', 'bound', 'queued', 'pulling'].includes(p.phase)) (created[p.app] = created[p.app] || []).push(p); continue; }
    if (o.phase === n.phase) continue;
    if (n.phase === 'scheduled' || n.phase === 'bound') bound.push(p); else if (n.phase === 'dropping') dropped.push(p); else if (n.phase === 'creating' && o.phase !== 'pulling' && o.phase !== 'staged' || n.phase === 'pulling') started.push(p);
    else if (n.phase === 'running' && (o.phase === 'creating')) ready.push(p); else if (n.phase === 'creating' || n.phase === 'queued' || n.phase === 'staged') continue; else if (n.phase === 'running' && (o.phase === 'unready' || o.phase === 'crash')) reready.push(p);
    else if (n.phase === 'crash' && n.doomed) deleted.push(p); else if (n.phase === 'crash') crashed.push(p); else if (n.phase === 'unready') unready.push(p);
    else if (n.phase === 'terminating' && !o.doomed) (gone[p.app] = gone[p.app] || []).push(p); }
  for (const [app, ps] of Object.entries(created)){ const c = col(ps[0]), key = `dep:${depOfName(app)}`;
    if (R.inflight.has(key)){ R.expect = R.expect || {}; (R.expect[app] = R.expect[app] || []).push(...ps); }
    else if (live) chain(`pod:${app}`, () => apiCall('rs', `Pod ${ps[0].name.slice(0, 14)}${ps.length > 1 ? ' x' + ps.length : ''}`, c, ['sched', 'rs'], { method: 'POST', verb: 'controller' }).then(() => ps.forEach(p => settle(gateOf(p), 'created'))));
    else chain(`pod:${app}`, async () => { await controllerLoop('rs', app, () => podWrite(app, c, ps)); }); }
  for (const [app, ps] of Object.entries(gone)){ const c = col(ps[0]), n = st.nodes.find(n => n.name === ps[0].node), evict = n && n.cordoned;
    chain(`gone:${app}`, async () => { if (evict){ await apiCall(who, `Eviction ${ps[0].name.slice(0, 12)}${ps.length > 1 ? ' x' + ps.length : ''}`, c, ['kubelet'], { method: 'POST', verb: 'kubectl drain' }); }
      else { const d = st.deploys.find(d => d.app === app); if (!R.inflight.has(`dep:${d ? d.name : app}`)) await controllerLoop('rs', app, () => apiCall('rs', `delete Pod ${ps[0].name.slice(0, 12)}${ps.length > 1 ? ' x' + ps.length : ''}`, c, ['kubelet', 'ep'], { method: 'DELETE', verb: 'replicaset ctrl' })); }
      R.node = ps[0].node || R.node; lit('k2', 700); logLine(`kubelet ${R.node}: SIGTERM, then the containers stop (grace period)`); await sleep(500); lit('k4', 500); }); }
  for (const p of deleted) chain(`del:${p.id}`, async () => { await apiCall(who, `delete Pod ${p.name.slice(0, 14)}`, col(p), ['kubelet', 'rs', 'ep'], { method: 'DELETE', verb: 'kubectl delete pod' }); R.node = p.node; lit('k2', 600); });
  if (bound.length) bound.forEach((p, i) => chain(`bind:${p.id}`, async () => { await raced(promised(gateOf(p), 'created'), 9000); await sleep(i*180); await schedulerCycle(p, p.node); settle(gateOf(p), 'bound'); }));
  if (dropped.length){ const p = dropped[0]; chain(`gang:${p.app}`, async () => { await raced(promised(gateOf(p), 'created'), 9000); lit('f-gang', 1200); logLine(`Volcano: PodGroup ${p.app} admitted, ${dropped.length} of ${dropped.length} fit at once`); await schedulerCycle(p, p.node, { label: `Binding x${dropped.length} (PodGroup ${p.app})` }); dropped.forEach(q => settle(gateOf(q), 'bound')); }); }
  for (const p of started) chain(`start:${p.id}`, async () => { await raced(promised(gateOf(p), 'bound'), 9000); await kubeletStart(p); settle(gateOf(p), 'started'); });
  for (const p of dropped) chain(`start:${p.id}`, async () => { await raced(promised(gateOf(p), 'bound'), 9000); await kubeletStart(p); settle(gateOf(p), 'started'); });
  for (const p of ready) chain(`ready:${p.id}`, async () => { await raced(promised(gateOf(p), 'started'), 9000); await kubeletStatus(p, `Pod ${p.name.slice(0, 12)} Ready=true`, ['ep', 'rs'], { event: 'Pod Ready' }); if (!p.job) await endpointsUpdate(p.app, col(p)); });
  for (const p of crashed) chain(`crash:${p.id}`, async () => { R.node = p.node; lit('k3', 600); logLine(`kubelet ${R.node}: container exited (${p.containers[0].name}); restartPolicy Always`); await sleep(400); lit('k2', 700); await sleep(500); await kubeletStatus(p, `Pod ${p.name.slice(0, 12)} restarts=${p.restarts + 1}`, ['rs'], { event: 'Pod status' }); });
  for (const p of unready) chain(`unready:${p.id}`, async () => { await kubeletStatus(p, `Pod ${p.name.slice(0, 12)} Ready=false`, ['ep'], { event: 'Pod NotReady' }); await endpointsUpdate(p.app, col(p)); });
  for (const p of reready) chain(`reready:${p.id}`, async () => { await kubeletStatus(p, `Pod ${p.name.slice(0, 12)} Ready=true`, ['ep'], { event: 'Pod Ready' }); await endpointsUpdate(p.app, col(p)); });
  // Nodes: cordon / uncordon, joining and registering
  for (const [name, n] of Object.entries(now.nodes)){ const o = prev.nodes[name]; if (!o) continue;
    if (o.cordoned !== n.cordoned) chain(`node:${name}`, () => apiCall(who, `Node ${name} unschedulable=${n.cordoned}`, AMBER, ['sched'], { method: 'PATCH', verb: n.cordoned ? 'kubectl cordon' : 'kubectl uncordon', event: 'Node' }).then(() => lit('f-cordon', 900)));
    if (!o.ready && n.ready) chain(`node:${name}`, async () => { R.node = name; lit('k0', 600); await kubeletStatus({ node: name, app: 'web', name }, `Node ${name} Ready (register)`, ['sched'], { method: 'POST', verb: 'kubelet', event: 'Node' }); }); }
  // the control plane coming up
  if (!prev.cp.etcd && now.cp.etcd) chain('cp:etcd', async () => { R.members.forEach(m => { m.up = true; m.log = []; m.commit = 0; m.role = 'follower'; }); R.term = 0; await election(-1); });
  if (!prev.cp.api && now.cp.api) chain('cp:api', async () => { for (let i = 0; i < 6; i++) lit('stage' + i, 900); lit('watch', 900); logLine('kube-apiserver: serving on :6443 (etcd reachable)'); });
  if (!prev.cp.ctrl && now.cp.ctrl) chain('cp:ctrl', async () => { for (const id of ['dep', 'rs', 'ep']) lit('c-' + id, 900); lit('s-queue', 900); logLine('kube-controller-manager and kube-scheduler: Lease acquired (leader election), informers synced'); });
  // traffic: the data plane
  if (now.parcels > prev.parcels) chain('req', async () => { const pc = st.parcels[st.parcels.length - 1]; R.proxyNode = pc.pod ? pc.pod.node : R.proxyNode; lit('p-rules', 600); await bead([[815, 530], [815, 549]], { label: pc.pod ? 'request' : '503', col: pc.pod ? col(pc.pod) : REDC, dur: 300 }); lit('p-out', 600); logLine(pc.pod ? `kube-proxy ${R.proxyNode}: ClusterIP ${pc.svc.name} DNAT -> ${pc.pod.name}` : `kube-proxy: Service ${pc.svc.name} has no Ready endpoints -> connection refused (503 at the Ingress)`); });
  prev = now;
}
const depOfName = app => { const d = cfg.st.deploys.find(d => d.app === app); return d ? d.name : app; };
// the ReplicaSet controller creating Pods: the ones already made for this app (the simulation is instant), as one write
async function podWrite(app, c, ps){ ps = ps || ((R.expect || {})[app] || []).splice(0); if (R.expect) R.expect[app] = [];
  const n = ps.length || 1, label = ps.length ? `Pod ${ps[0].name.slice(0, 14)}${n > 1 ? ' x' + n : ''}` : `Pod ${app}`;
  await apiCall('rs', label, c, ['sched', 'rs'], { method: 'POST', verb: 'replicaset ctrl', event: 'Pod (Pending)' }); ps.forEach(p => settle(gateOf(p), 'created')); }
// one chain of events per key; a new one for the same key waits for the old one
function chain(key, fn){ const prevP = R.inflight.get(key) || Promise.resolve(); const p = prevP.then(fn).catch(e => console.error(e)).then(() => { if (R.inflight.get(key) === p) R.inflight.delete(key); }); R.inflight.set(key, p); drive(); return p; }
// a Raft election: a follower's timer fires, it asks for votes, a majority answers, the term goes up
async function election(from){
  R.noLeader = true; R.term++; const live = R.members.map((m, i) => i).filter(i => R.members[i].up && i !== from);
  const cand = live[0]; R.members[cand].role = 'candidate'; render(); logLine(`etcd-${cand + 1}: election timeout, RequestVote for term ${R.term}`);
  const others = live.filter(i => i !== cand);
  await Promise.all(others.map(i => bead([[mx(cand), MY], [mx(i), MY]], { label: `RequestVote t${R.term}`, col: AMBER, dur: 300, small: true })));
  await Promise.all(others.map(i => bead([[mx(i), MY], [mx(cand), MY]], { label: 'vote', col: GREEN, dur: 300, small: true })));
  R.leader = cand; R.members.forEach((m, i) => { m.role = i === cand ? 'leader' : 'follower'; if (m.up) m.term = R.term; }); R.noLeader = false; render();
  logLine(`etcd-${cand + 1} is the leader for term ${R.term}: writes go through again`);
}
async function stopFollower(){ if (R.down != null) return cfg.say('etcd-down', 'One etcd member is already stopped: with 3 members only one can be lost and keep a quorum');
  const i = R.members.findIndex((m, j) => j !== R.leader && m.up); R.down = i; R.members[i].up = false; render();
  cfg.say('etcd-f', `etcd-${i + 1} (a follower) stopped: the leader still has a quorum of 2 of 3, so every write goes on as before`, 3400); logLine(`etcd-${i + 1} stopped; quorum 2 of 3 holds`);
  chain('etcd:follower', async () => { await sleep(7000); const m = R.members[i]; m.up = true; m.term = R.term; const L = R.members[R.leader]; const missed = L.log.length - m.log.length; m.log = L.log.map(e => ({ ...e })); m.commit = L.commit; R.down = null; render();
    cfg.say('etcd-fb', `etcd-${i + 1} is back: the leader replays the ${missed} entr${missed === 1 ? 'y' : 'ies'} it missed and it catches up`, 3000); logLine(`etcd-${i + 1} rejoined and caught up (${missed} entries replayed)`); });
}
async function stopLeader(){ if (R.down != null) return cfg.say('etcd-down', 'One etcd member is already stopped: with 3 members only one can be lost and keep a quorum');
  const i = R.leader; R.down = i; R.members[i].up = false; R.members[i].role = 'stopped'; R.noLeader = true; cfg.st.cp.hold = 1; render();
  cfg.say('etcd-l', `etcd-${i + 1} (the leader) stopped: no leader, so the API server cannot commit any write until an election finishes (reads still serve)`, 3600); logLine(`etcd-${i + 1} (leader) stopped: writes wait`);
  chain('etcd:leader', async () => { await sleep(1500); await election(i); cfg.st.cp.hold = 0; cfg.say('etcd-le', `Term ${R.term}: etcd-${R.leader + 1} elected leader; the queued writes go through and the controllers resume`, 3200); cfg.run();
    await sleep(6000); const m = R.members[i]; m.up = true; m.role = 'follower'; m.term = R.term; const L = R.members[R.leader]; m.log = L.log.map(e => ({ ...e })); m.commit = L.commit; R.down = null; render();
    cfg.say('etcd-lb', `etcd-${i + 1} is back as a follower in term ${R.term} and catches up on the log`, 3000); logLine(`etcd-${i + 1} rejoined as a follower (term ${R.term})`); });
}

/* ---------- mount ---------- */
function mount(host, c){ cfg = c; el = host;
  el.innerHTML = `<div class="cap"><b>CONTROL ROOM</b><span>what the control plane does for every yard operation</span></div><div class="scroll"><svg viewBox="0 0 1000 600" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace,Menlo,Consolas,monospace"></svg></div><div class="log"></div>`;
  svg = el.querySelector('svg'); svg.innerHTML = staticSvg(); dyn = svg.querySelector('#dyn'); logEl = el.querySelector('.log');
  R.lastT = performance.now(); render(); logLine('Idle. Press a yard button and watch the messages.');
}
window.ControlRoom = { mount, observe: () => { if (cfg) observe(); }, shown: v => { shown = v; if (v && svg) render(); }, stopFollower, stopLeader, R };
})();
