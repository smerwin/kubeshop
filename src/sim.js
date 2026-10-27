/* ============================================================
   Longshore simulation: the cluster, its controllers, scheduler, crane, pods, traffic, bootstrap and snapshots.
   Shared by figure/longshore.html (the Colorfigures SVG engine) and figure/longshore3d.html (three.js).
   It needs these globals from the page: PALS, matOf, ease (shading palette helpers), ui (flash / animate /
   render) and reframe() (re-frame the view when the cluster changes size).
   ============================================================ */

/* ---------- units (x = depth, y = width, z = up) ---------- */
const PL = 24, PW = 10, PH = 10;                 // a pod: a 20-ft container lying along y
const SLD = 50, SLW = 66, SLH = 3;               // a node slab: 50 deep, 66 wide, 3 thick
const ROWS = 3, COLS = 2;                        // container slots per tier: 3 along x, 2 along y
const SX0 = 50, SY0 = 40, NGAP = 16, ROWGAP = 20;
const REG_Y0 = 176, REG_GAP = 26, REG_MAX = 4;   // image registry shelf: a stack per app
let W = 150, D = 284, HTOP = 70, XR0 = 44, XR1 = 106, HZT = 36, BZ = 58, LANE = 129;
const PAPER = '#f2efe7';
const CONC = { l:'#dedad0', m:'#c3bfb3', d:'#9d9889' };
const YARD = { l:'#e8e3d6', m:'#d2cbbb', d:'#aba394' };
const CRATE = { l:'#f1e6c8', m:'#d9ca9f', d:'#a8956a' };
const GLASS = '#1d2a26';
const LAMPC = { green:'#43c25c', amber:'#f2b230', red:'#e2483d', grey:'#9a948a' };
const APP_PALS = { web: PALS.cobalt, api: PALS.mint, db: PALS.tomato, cache: PALS.blush, train: matOf('#f08a2b'), spark: matOf('#9b7bd6') };
const GOLD = '#f2c230';
const EXTRA_PALS = ['#9b7bd6', '#4fb3b3', '#f08a2b', '#b9c45a', '#d98fd4', '#8aa0b8', '#c9a066', '#6fb86f'].map(matOf);
const palOf = app => { if (!APP_PALS[app]) APP_PALS[app] = EXTRA_PALS[Object.keys(APP_PALS).length % EXTRA_PALS.length]; return APP_PALS[app]; };

/* ---------- the demo cluster (the same shape tools/longshore.py writes; a raw kubectl List loads too) ---------- */
const DEMO = {
  context: 'demo',
  nodes: [ { name:'node-a' }, { name:'node-b' }, { name:'node-c', gpus:2 } ],
  deployments: [
    { name:'web', app:'web', replicas:3, version:'v1', containers:[{ name:'nginx', image:'nginx:1.27' }], configMap:'web-config', dependsOn:'api' },
    { name:'api', app:'api', replicas:2, version:'v1', containers:[{ name:'api', image:'yard/api:1.4' }, { name:'log-shipper', image:'fluent-bit:3' }], secret:'api-keys', dependsOn:'db' },
    { name:'db', app:'db', kind:'StatefulSet', replicas:1, version:'v1', containers:[{ name:'postgres', image:'postgres:16' }], pvc:'data-db-0' },
    { name:'coredns', namespace:'kube-system', app:'coredns', replicas:2, version:'1.12', containers:[{ name:'coredns', image:'coredns/coredns:1.12.0' }], system:true } ],
  services: [ { name:'web', selector:{ app:'web' }, ports:[80] }, { name:'api', selector:{ app:'api' }, ports:[8080] }, { name:'db', selector:{ app:'db' }, ports:[5432] }, { name:'kube-dns', namespace:'kube-system', selector:{ app:'coredns' }, ports:[53], clusterIP:'10.96.0.10' } ],
  ingresses: [ { host:'shop.example.com', service:'web', port:80 } ] };

/* ---------- names ---------- */
const SUF = 'abcdefghijkmnpqrstuvwxyz0123456789';
let rseed = 7; const rnd = () => (rseed = (rseed * 48271) % 2147483647) / 2147483647;
const suffix = n => Array.from({ length:n }, () => SUF[Math.floor(rnd()*SUF.length)]).join('');
const rsHash = (app, ver) => { let h = 7; for (const ch of app + '/' + ver) h = (h*31 + ch.charCodeAt(0)) >>> 0; return (h.toString(36) + 'xxxxx').slice(0, 5); };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const lerp3 = (a, b, t) => [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t];
const dist3 = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

/* ---------- layout: where every node, rail and lane is ----------
   Two models share this file. The yard (the first draft): pods are containers in 3x2 slots stacked in tiers, and a crane
   carries each one from the registry. The shop (figure/shopfloor.html): pods are machines in a cell's bays, a flat grid of
   4 across and 3 deep that grows by rows, bound by a job card and pulled by the cell's own AGV. */
const isShop = () => st.model === 'shop';
const BAYX = 14, BAYY = 12, SHOP_COLS = 4, SHOP_ROWS = 3, SHOP_MAXROWS = 8;   // a cell's bays: BAYY apart across (y), BAYX apart deep (x)
const slotPos = (n, sl) => isShop() ? [n.x0 + 6 + sl.r*BAYX, n.y0 + 7 + sl.c*BAYY, 0] : [n.x0 + 6 + sl.r*(PW + 4), n.y0 + 6 + sl.c*(PL + 6), SLH + sl.t*PH];
const slotKey = sl => `${sl.c},${sl.r},${sl.t}`;
function freeSlot(n){
  if (isShop()){ for (let r = 0; r < SHOP_MAXROWS; r++) for (let c = 0; c < SHOP_COLS; c++){ const sl = { c, r, t:0 }; if (!n.used.has(slotKey(sl))) return sl; } return null; }
  for (let t = 0; t < 9; t++) for (let r = ROWS - 1; r >= 0; r--) for (let c = 0; c < COLS; c++){ const sl = { c, r, t }; if (!n.used.has(slotKey(sl))) return sl; } return null; }
const cellRows = n => { let r = SHOP_ROWS; for (const k of n.used) r = Math.max(r, +k.split(',')[1] + 1); return r; };
const cellDepth = n => isShop() ? 8 + cellRows(n)*BAYX : SLD;          // a cell grows deeper (along x) when it holds more than 12 machines
function layout(st){
  const ns = st.nodes, rows = Math.max(1, Math.ceil(ns.length / 3)), cols = Math.min(3, Math.max(1, ns.length));
  const depth = []; for (let r = 0; r < rows; r++) depth.push(Math.max(SLD, ...ns.slice(r*3, r*3 + 3).map(cellDepth)));
  let x = SX0; ns.forEach((n, i) => { const r = Math.floor(i/3); if (i % 3 === 0 && r > 0) x += depth[r - 1] + ROWGAP; n.x0 = x; n.y0 = SY0 + (i % 3)*(SLW + NGAP); n.row = r; n.depth = cellDepth(n); });
  const xEnd = x + depth[rows - 1];
  W = xEnd + 50; D = Math.max(284, SY0 + cols*(SLW + NGAP) - NGAP + 14);
  XR0 = SX0 - 6; XR1 = xEnd + 6; LANE = W - 21;
  let maxT = 2; for (const p of st.pods) if (p.slot) maxT = Math.max(maxT, p.slot.t);
  HZT = SLH + (maxT + 1)*PH + 3; BZ = HZT + 22; HTOP = isShop() ? 62 : BZ + 12;
  for (const p of st.pods) if (p.slot && p.node && st.crane.carry !== p && !NOPOS.has(p.phase)){ const n = ns.find(n => n.name === p.node); if (n) p.pos = slotPos(n, p.slot); }
}
const NOPOS = new Set(['scheduled', 'bound']);   // bound but not yet on the floor: the crane has it, or the job card is in the tube
const OFFICE = [20, 22, 26];                      // where the job cards leave the planning office: the counter on the mezzanine (shop)
// the words each figure's toasts use for the same Kubernetes fact
const VOC = () => isShop() ? {
  b0: 'kubeadm init: an empty floor and a dark office. Nothing can be scheduled until the control plane is up', bca: 'kubeadm init phase certs: the seal press makes the cluster CA and stamps a badge for the ledger, the counter and the dispatcher; from here on every message between them is mutual TLS', b1: 'etcd is up: the ledger drawers light; the cluster has a memory',
  b2: 'kube-apiserver is serving on :6443: the counter opens and the tube pressurises; kubectl works from here on', b3: "kube-controller-manager and kube-scheduler are running: the dispatcher's desk opens and job cards can be issued",
  bj: n => `kubeadm join: ${n} powers on its controller cabinet (kubelet and container runtime)`, br: n => `${n} registered with the API server and is Ready: its cell is open for job cards`,
  bapp: 'kubectl apply -f app/: orders web x3, api x2 and db x1 posted on the board; their ReplicaSets raise the job cards', live: 'This is a real cluster and the floor only watches it' } : {
  b0: 'kubeadm init: an empty yard. Nothing can be scheduled until the control plane is up', bca: 'kubeadm init phase certs: the CA is created and every control-plane component gets its certificate', b1: 'etcd is up: the cluster has a memory (every object will live in that cabinet)',
  b2: 'kube-apiserver is serving on :6443: kubectl works from here on', b3: 'kube-controller-manager and kube-scheduler are running: the crane powers up',
  bj: n => `kubeadm join: ${n} is bootstrapping its kubelet and container runtime`, br: n => `${n} registered with the API server and is Ready (kube-proxy and the CNI are on it)`,
  bapp: 'kubectl apply -f app/: Deployments web, api and db created; their ReplicaSets want 3, 2 and 1 Pods', live: 'This is a real cluster and the yard only watches it' };
const PULL = { cold: 1.4, warm: .25, start: .5 };  // an image the cell has never pulled, one from its rack, powering the machine up
const ROT = 48;                                    // a kubelet certificate's lifetime here (simulated seconds); it rotates at 80% of it, as the real one does
const GRACE = 2, GRACE_MAX = 5;                    // terminationGracePeriodSeconds, scaled down: a machine drains (finishes the parts already sent to it, takes no new ones) before it powers down; past GRACE_MAX it is killed
const regIndex = (st, app) => { const i = st.regApps.indexOf(app); return i < 0 ? -1 : i; };
const regPos = (st, app) => { const i = Math.max(0, regIndex(st, app)); return [9, REG_Y0 + 4 + i*REG_GAP, 2 + 2*PH]; };
const nodeCenterY = n => n.y0 + SLW/2;

/* ---------- state ---------- */
let ui;
const st = { t:0, mode:'demo', model:'yard', nodes:[], pods:[], deploys:[], services:[], ingresses:[], regApps:[], seq:0,
  crane:{ x:75, y:130, z:36, carry:null, job:null, queue:[] }, caps:[], strobe:0, parcels:[], boom:0, boomT:0, rr:0, showSys:false,
  live:{ url:null, poll:0, timer:0, status:'' }, said:{}, pending503:0, cp:{ etcd:1, api:1, ctrl:1, hold:0 }, boot:null, reqs:{ sent:0, ok:0, err:0, reset:0 },
  // security: the CA (the seal press), badges signed, the NetworkPolicy in force, refusals at the counter (the room plays them), forged job cards in the tube, the inspector's sign, timed follow-ups
  sec:{ ca:1, badges:0, netpol:null, refuse:[], refuseT:0, forged:[], inspect:0, stamp:0, queue:[] },
  // networking: the fabric (static routes, or BGP from every cabinet to its row's junction with two spine lanes), Service addressing,
  // the directory (CoreDNS), the mesh (sidecars, the mesh's own CA, a weighted canary) and a managed control plane behind the fence
  net:{ fabric:'static', svc:'iptables', lane:0, ann:[], hops:[], dns:{ n:0, flash:0 }, mesh:{ on:false, canary:0, n:0 }, managed:false } };
// on the shop floor a machine that is powering down still counts for a moment, so its replacement card is raised after it stops
const podsOf = (app, alive = true) => st.pods.filter(p => p.app === app && (!alive || p.phase !== 'terminating' || (isShop() && p.phaseT < .6)));
const isReady = p => p.phase === 'running' && p.ready;
const lampOf = p => p.phase === 'terminating' ? LAMPC.grey : p.phase === 'done' ? '#5a82c6' : p.phase === 'crash' ? (p.phaseT < 1 ? LAMPC.red : LAMPC.amber) : isReady(p) ? LAMPC.green : LAMPC.amber;
const imageOf = p => (p.containers[0] || {}).image || p.app;
const depOf = app => st.deploys.find(d => d.app === app);
function say(key, text, ms = 2300){ if (!ui) return; const now = performance.now(); if (st.said[key] && now - st.said[key] < 2600) return; st.said[key] = now; ui.flash(text, ms); }

function makePod(dep, ver){
  ver = ver || dep.version;
  return { id: ++st.seq, name: `${dep.name}-${rsHash(dep.app, ver)}-${suffix(5)}`, ns: dep.ns || 'default', app: dep.app, ver, band: false,
    node: null, slot: null, phase: 'pending', phaseT: 0, ready: false, restarts: 0, alpha: 1, fire: 0, pos: null,
    containers: dep.containers || [{ name: dep.app, image: dep.app }], pvc: dep.pvc, configMap: dep.configMap, secret: dep.secret, sys: !!dep.sys, born: st.t,
    gpu: dep.gpu || 0, gang: dep.gang ? dep.app : null, job: dep.kind === 'Job', waitingOn: null, drop: null, pass: { issued: st.t, exp: st.t + 3600 } };
}
function placePod(p, n, sl){ p.node = n.name; p.slot = sl; n.used.add(slotKey(sl)); p.pos = slotPos(n, sl); }
function removePod(p){ const n = st.nodes.find(n => n.name === p.node); if (n && p.slot) n.used.delete(slotKey(p.slot)); if (st.crane.carry === p) st.crane.carry = null;
  st.crane.queue = st.crane.queue.filter(j => j.pod !== p); st.caps = st.caps.filter(c => c.pod !== p); st.pods = st.pods.filter(q => q !== p); }
// the newest version of an app (when there is more than one) wears the pale band
function markBands(){ for (const app of new Set(st.pods.map(p => p.app))){ const vs = [...new Set(podsOf(app, false).map(p => p.ver))];
  if (vs.length < 2){ for (const p of podsOf(app, false)) p.band = false; continue; } vs.sort(); const top = vs[vs.length - 1]; for (const p of podsOf(app, false)) p.band = p.ver === top; } }
function refreshRegistry(){ const count = {}; for (const p of st.pods) count[p.app] = (count[p.app] || 0) + 1; for (const d of st.deploys) count[d.app] = count[d.app] || 0;
  const apps = Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b)); const keep = st.regApps.filter(a => apps.includes(a));
  for (const a of apps) if (!keep.includes(a) && keep.length < REG_MAX) keep.push(a); st.regApps = keep; }

/* ---------- controllers (demo mode): Deployments and ReplicaSets want N pods of the current version ---------- */
function reconcile(){
  for (const p of st.pods) if (!depOf(p.app) && p.phase !== 'terminating' && st.mode === 'demo') terminate(p);
  for (const dep of st.deploys){
    if (dep.kind === 'Job'){ if (!dep.spawned){ dep.spawned = true; for (let i = 0; i < dep.replicas; i++) st.pods.push(makePod(dep));
        say('job-' + dep.app, dep.gang ? `Volcano PodGroup ${dep.app} (minMember ${dep.minMember || dep.replicas}): ${dep.replicas} Pods Pending until all fit at once` : `Job ${dep.app}: ${dep.replicas} Pods Pending`); } continue; }
    const live = podsOf(dep.app), newer = live.filter(p => p.ver === dep.version), older = live.filter(p => p.ver !== dep.version);
    const readyN = live.filter(isReady).length;
    if (!older.length){
      while (podsOf(dep.app).length < dep.replicas){ st.pods.push(makePod(dep)); say('rs-' + dep.app, `ReplicaSet ${dep.name}-${rsHash(dep.app, dep.version)} wants ${dep.replicas}: a new Pod is Pending`); }
      const extra = live.length - dep.replicas;
      if (extra > 0) live.slice().sort((a, b) => b.born - a.born).slice(0, extra).forEach(p => terminate(p));
    } else {
      // rolling update, maxSurge 1 / maxUnavailable 0: one new pod up, then one old pod down once it is Ready; a paused rollout holds with its first new pod up
      if (dep.paused && newer.length >= 1){ /* kubectl rollout pause: the canary stays, the old ReplicaSet keeps its pods */ }
      else if (live.length < dep.replicas + 1 && newer.length < dep.replicas){ st.pods.push(makePod(dep)); say('roll-' + dep.app, `Rollout: new ReplicaSet ${dep.name}-${rsHash(dep.app, dep.version)} surges one ${dep.version} Pod`); }
      if (!(dep.paused && newer.length >= 1) && readyN > dep.replicas && older.length){ terminate(older.sort((a, b) => a.born - b.born)[0]); say('rolldown-' + dep.app, `A ${dep.version} Pod is Ready, so one old Pod is scaled down`); }
    }
  }
  markBands(); refreshRegistry();
}
function terminate(p){ if (p.phase === 'terminating') return; if (p.phase === 'crash') p.down = true; p.phase = 'terminating'; p.phaseT = 0; p.ready = false; p.drop = null; p.alpha = 1; }
// draining: Terminating but still within its grace period, finishing the parts already inside it (a Service never sends it new ones)
const draining = p => p.phase === 'terminating' && !p.down && (p.phaseT < GRACE || p.phaseT < GRACE_MAX && st.parcels.some(pc => pc.pod === p && pc.dir === 1));
// gone for an in-flight request: removed, crashed, or past its grace period and powered down
const poweredDown = p => !st.pods.includes(p) || p.phase === 'crash' || (p.phase === 'terminating' && !draining(p));
// a pod's readiness probe needs the thing it talks to: api needs a Ready db, web needs a Ready api
const depHealthy = app => { const d = depOf(app); return !d || !d.dependsOn || podsOf(d.dependsOn).some(isReady); };
function checkDependencies(){
  for (const p of st.pods) if (p.phase === 'running' && p.ready && !depHealthy(p.app)){ const d = depOf(p.app);
    p.phase = 'unready'; p.phaseT = 0; p.ready = false; p.waitingOn = d.dependsOn; say('dep-' + p.app, `${p.app} readiness probes failing: Service ${d.dependsOn} has no Ready endpoints (${p.app} stays up but gets no traffic)`); }
}
const gpuUsed = n => st.pods.filter(p => p.node === n.name && p.phase !== 'terminating').reduce((a, p) => a + (p.gpu || 0), 0);
const gpuFree = n => (n.gpus || 0) - gpuUsed(n);
const slotsFree = n => (isShop() ? SHOP_COLS*SHOP_MAXROWS : ROWS*COLS*9) - n.used.size;
const cellCap = () => isShop() ? SHOP_COLS*SHOP_ROWS : ROWS*COLS*3;
/* scheduler: every Pending pod gets a node with a free slot (fewest pods first), then the crane delivers it */
function schedule(){
  scheduleGangs();
  for (const p of st.pods){ if (p.phase !== 'pending' || p.gang) continue;   // system pods are scheduled like any other; hiding them only stops the drawing
    let cands = st.nodes.filter(n => n.ready && !n.cordoned && freeSlot(n) && (st.mode === 'live' || gpuFree(n) >= (p.gpu || 0)));
    if (st.mode === 'live') cands = cands.filter(n => n.name === p.wantNode);
    if (!cands.length){ if (st.mode === 'demo') say(p.gpu ? 'nogpu' : 'nosched', p.gpu ? `Pending: ${p.name} requests nvidia.com/gpu: ${p.gpu} and no node has a free GPU` : 'Pending: no schedulable node has room (uncordon one)'); continue; }
    cands.sort((a, b) => countOn(a) - countOn(b) || a.name.localeCompare(b.name));
    const n = cands[0], sl = freeSlot(n); placePod(p, n, sl); p.pos = null;
    if (isShop()){ p.phase = 'bound'; p.phaseT = 0; st.caps.push(mkCap(p, n)); say('bind', `Scheduler bound ${p.name} to ${n.name}: spec.nodeName written, the job card is on its way to the cell`); continue; }
    p.phase = 'scheduled';
    st.crane.queue.push({ pod: p, from: regPos(st, p.app), to: slotPos(n, sl) });
    say('bind', `Scheduler bound ${p.name} to ${n.name}`);
  }
}
const countOn = n => st.pods.filter(p => p.node === n.name && p.phase !== 'terminating').length;
/* gang scheduling (Volcano PodGroup): a group is admitted only when every member fits at once; then the whole
   group lands together, by parachute, without the crane */
function scheduleGangs(){
  const groups = {}; for (const p of st.pods) if (p.phase === 'pending' && p.gang) (groups[p.gang] = groups[p.gang] || []).push(p);
  for (const [app, members] of Object.entries(groups)){ const dep = depOf(app), need = dep ? (dep.minMember || dep.replicas) : members.length;
    if (members.length < need) continue;
    const room = st.nodes.filter(n => n.ready && !n.cordoned).map(n => ({ n, slots: slotsFree(n), gpus: gpuFree(n), count: countOn(n) }));
    const plan = [];
    for (const p of members){ room.sort((a, b) => a.count - b.count || a.n.name.localeCompare(b.n.name)); const r = room.find(r => r.slots > 0 && r.gpus >= (p.gpu || 0)); if (!r) break; r.slots--; r.gpus -= p.gpu || 0; r.count++; plan.push([p, r.n]); }
    if (plan.length < members.length){ say('gang-' + app, `PodGroup ${app}: ${members.length} Pods stay Pending; the gang needs ${need} slots free at the same time`); continue; }
    if (isShop()){ for (const [p, n] of plan){ const sl = freeSlot(n); placePod(p, n, sl); p.pos = null; p.phase = 'dropping'; p.phaseT = 0; st.caps.push(mkCap(p, n)); }
      say('gangok-' + app, `Volcano admitted PodGroup ${app}: all ${members.length} Pods bound at once; every cell pulls, and they start together`); continue; }
    for (const [p, n] of plan){ const sl = freeSlot(n); placePod(p, n, sl); const to = slotPos(n, sl); p.phase = 'dropping'; p.phaseT = 0; p.drop = { t: 0, from: [to[0], to[1], HTOP + 42], to }; p.pos = p.drop.from.slice(); }
    const c = st.crane; if (!c.job && !c.queue.length){ c.job = { pod: null, i: 0, steps: [{ y: D - 14, z: HZT, dur: Math.max(.4, Math.abs(c.y - (D - 14))/SPD.travel) }] }; }
    say('gangok-' + app, `Volcano admitted PodGroup ${app}: all ${members.length} Pods bound at once and landing together`);
  }
}

/* ---------- the crane: one job at a time, registry shelf to slot ---------- */
const SPD = { travel: 120, hoist: 90 };
function craneTick(dt){
  const c = st.crane;
  if (!c.job){ const j = c.queue.shift(); if (!j) return false;
    if (j.pod && j.pod.phase !== 'scheduled'){ return true; }
    const [fx, fy, fz] = j.from, [tx, ty, tz] = j.to, hc = [fx + PW/2, fy + PL/2], tc = [tx + PW/2, ty + PL/2];
    const dur = (a, b, sp) => Math.max(.28, Math.hypot(a[0] - b[0], a[1] - b[1]) / sp);
    j.steps = [
      { x: hc[0], y: hc[1], z: HZT, dur: Math.max(dur([c.x, c.y], hc, SPD.travel), Math.abs(c.z - HZT)/SPD.hoist) },
      { z: fz, dur: Math.max(.3, (HZT - fz)/SPD.hoist) },
      { dur: .14, done: () => { c.carry = j.pod; j.pod.pos = [fx, fy, fz]; } },
      { z: HZT, dur: Math.max(.3, (HZT - fz)/SPD.hoist) },
      { x: tc[0], y: tc[1], dur: dur(hc, tc, SPD.travel) },
      { z: tz, dur: Math.max(.3, (HZT - tz)/SPD.hoist) },
      { dur: .12, done: () => { c.carry = null; j.pod.pos = j.to; j.pod.phase = 'creating'; j.pod.phaseT = 0; say('pull', `kubelet on ${j.pod.node} is pulling ${j.pod.containers[0].image} and starting ${j.pod.containers.length > 1 ? 'the containers' : 'the container'}`); } },
      { z: HZT, dur: .45 } ];
    j.i = 0; c.job = j; }
  const j = c.job, s = j.steps[j.i];
  if (s.t == null){ s.t = 0; s.from = { x: c.x, y: c.y, z: c.z }; }
  s.t += dt; const u = ease(Math.min(1, s.t / s.dur));
  for (const kk of ['x', 'y', 'z']) if (s[kk] != null) c[kk] = s.from[kk] + (s[kk] - s.from[kk])*u;
  if (c.carry) c.carry.pos = [c.x - PW/2, c.y - PL/2, c.z];
  if (s.t >= s.dur){ if (s.done) s.done(); j.i++; if (j.i >= j.steps.length) c.job = null; }
  return true;
}

/* ---------- the shop: job cards through the tube, the cell's AGV fetching the image, machines powering up ----------
   Binding is instant (the scheduler only writes spec.nodeName). What takes time is the kubelet's side: it pulls images one at
   a time per node (serialised by default), from the registry when the node has never seen the image and from its own cache
   when it has, and only then starts the containers. Nodes pull in parallel. A gang's members each pull, then start together. */
const cellDoor = n => [n.x0 - 4, n.y0 + SLW - 6, 12];    // the cell's job board on the controller cabinet, where the tube ends
function mkCap(p, n){ const to = cellDoor(n), L = Math.abs(OFFICE[0] - to[0]) + Math.abs(OFFICE[1] - to[1]) + 70; return { pod: p, node: n.name, t: 0, dur: Math.max(.7, L/170) }; }
function shopTick(dt){ let busy = false;
  for (const c of st.caps){ c.t += dt/c.dur; busy = true;
    if (c.t >= 1){ c.done = true; const p = c.pod, n = st.nodes.find(n => n.name === c.node); if (n && (p.phase === 'bound' || p.phase === 'dropping')){ p.pos = slotPos(n, p.slot); p.phase = 'queued'; p.phaseT = 0; } } }
  st.caps = st.caps.filter(c => !c.done);
  for (const n of st.nodes){ if (!n.cache) n.cache = new Set();
    if (!n.pull){ const p = st.pods.find(p => p.node === n.name && p.phase === 'queued'); const key = p && p.app + ':' + p.ver, warm = p && n.cache.has(key);
      if (p && !warm && st.lastCold != null && st.t - st.lastCold < .35){ busy = true; continue; }   // two AGVs never leave for the crib lane in the same moment
      if (p){ if (!warm) st.lastCold = st.t;
      n.pull = { pod: p, t: 0, dur: warm ? PULL.warm : PULL.cold, warm }; p.phase = 'pulling'; p.phaseT = 0;
      say(warm ? 'pullw' : 'pullc', warm ? `${n.name} already has ${imageOf(p)} in its image cache: no pull, the container starts at once` : `kubelet on ${n.name} is pulling ${imageOf(p)} from the registry (one pull at a time per node)`); } }
    if (n.pull){ n.pull.t += dt; busy = true;
      if (n.pull.t >= n.pull.dur){ const p = n.pull.pod; n.cache.add(p.app + ':' + p.ver); n.pull = null; if (p.phase === 'pulling'){ p.phase = p.gang ? 'staged' : 'creating'; p.phaseT = 0;
        say(p.gang ? 'staged-' + p.gang : 'start', p.gang ? `${n.name}: crate loaded for ${p.name}; the gang waits for every member's crate` : `${n.name}: crate loaded, the runtime starts ${imageOf(p)} (the machine powers up)`); } } } }
  const groups = {}; for (const p of st.pods) if (p.gang && ['dropping', 'queued', 'pulling', 'staged'].includes(p.phase)) (groups[p.gang] = groups[p.gang] || []).push(p);
  for (const ps of Object.values(groups)) if (ps.every(p => p.phase === 'staged')){ for (const p of ps){ p.phase = 'creating'; p.phaseT = 0; } st.strobe = 1.2; say('gangstart', `PodGroup ${ps[0].gang}: every cell has its image, all ${ps.length} machines start in sync`); }
  if (st.strobe > 0){ st.strobe = Math.max(0, st.strobe - dt); busy = true; }
  return busy; }

/* ---------- pods: phase timers ---------- */
function podTick(p, dt){
  if (p.phaseT < -1e8) return false;                      // a state read from a real cluster: it changes when the cluster does
  p.phaseT += dt;
  switch (p.phase){
    case 'bound': case 'queued': case 'pulling': case 'staged': return true;
    case 'dropping': { const d = p.drop; if (!d) return true; d.t += dt; const k = ease(Math.min(1, d.t / 2)); p.pos = lerp3(d.from, d.to, k);
      if (d.t >= 2){ p.pos = d.to; p.drop = null; p.phase = 'creating'; p.phaseT = 0; } return true; }
    case 'creating': if (p.phaseT > (isShop() ? PULL.start : 1.1)){ p.phaseT = 0;
        if (st.mode === 'demo' && !depHealthy(p.app)){ p.phase = 'unready'; p.waitingOn = depOf(p.app).dependsOn; say('dep-' + p.app, `${p.name} started but its readiness probe fails: Service ${p.waitingOn} has no Ready endpoints`); }
        else { p.phase = 'running'; p.ready = true; say('ready', `Readiness probe passed: ${p.name} is Ready${p.job ? '' : ' and a Service endpoint'}`); } } return true;
    case 'running': if (p.job && p.phaseT > 9){ p.phase = 'done'; p.phaseT = 0; p.ready = false; say('done-' + p.app, `${p.app} Pods completed (Succeeded): a Job's Pods are not replaced`); } return !!p.job;
    case 'done': if (p.phaseT > 1.6) terminate(p); return true;
    case 'crash': p.fire = p.phaseT < 1 ? 1 : 0; if (p.phaseT > .95 && !p.counted){ p.counted = true; p.restarts++; }
      if (p.phaseT > 2.1){ p.phase = 'running'; p.phaseT = 0; p.ready = true; p.counted = false; say('restarted', `kubelet restarted the container in place: ${p.name} restarts=${p.restarts}`); } return true;
    case 'unready': if (p.nodeDown){ const n = st.nodes.find(n => n.name === p.node); if (!n || !n.ready){ p.phaseT = 0; return true; }
        if (p.phaseT > .5){ p.phase = 'running'; p.ready = true; p.phaseT = 0; p.nodeDown = false; say('nodeback-' + n.name, `${n.name} reports again: its machines' probes pass and they are back in their Services`); } return true; }
      if (p.waitingOn){ if (!depHealthy(p.app)){ p.phaseT = 0; return true; }
        if (p.phaseT > .7){ p.phase = 'running'; p.ready = true; p.phaseT = 0; say('reready-' + p.app, `Service ${p.waitingOn} is back, so ${p.app} probes pass again`); p.waitingOn = null; } return true; }
      if (p.phaseT > 4.5){ p.phase = 'running'; p.ready = true; p.phaseT = 0; say('reready', `Probe passing again: ${p.name} is back in the Service`); } return true;
    case 'terminating': { if (draining(p)){ p.alpha = 1; return true; } p.fadeT = (p.fadeT || 0) + dt; p.alpha = Math.max(0, 1 - p.fadeT / .8); if (p.alpha <= 0) removePod(p); return true; }
  }
  return false;
}

/* ---------- traffic: a request through the gate, the kiosk, to one Ready endpoint, and back ---------- */
const svcMain = () => { const ing = st.ingresses[0]; return (ing && st.services.find(s => s.name === ing.service)) || st.services[0]; };
function endpointsOf(svc){ if (!svc) return []; const sel = svc.selector || {}; return st.pods.filter(p => isReady(p) && p.pos && p.slot && Object.entries(sel).every(([k, v]) => k === 'app' ? p.app === v : true)).sort((a, b) => a.name.localeCompare(b.name)); }
function request(){
  const svc = svcMain(), eps = endpointsOf(svc);
  if (!svc) return say('nosvc', 'No Service to route to');
  st.reqs.sent++;
  if (!eps.length){ st.parcels.push(makeParcel(null, svc)); st.reqs.err++; return say('503', `503: Service ${svc.name} has no Ready endpoints`); }
  const M = st.net.mesh, split = M.on && M.canary > 0 && svc.name === 'web' && eps.some(p => p.ver === 'v2') && eps.some(p => p.ver !== 'v2');
  let p; if (split){ const v2 = eps.filter(p => p.ver === 'v2'), v1 = eps.filter(p => p.ver !== 'v2'); p = (++M.n % Math.round(100/M.canary) === 0) ? v2[M.n % v2.length] : v1[st.rr++ % v1.length]; } else p = eps[st.rr++ % eps.length];
  const pc = makeParcel(p, svc); if (split) pc.canary = p.ver === 'v2'; st.parcels.push(pc);
  say('req', `GET ${st.ingresses[0] ? st.ingresses[0].host : svc.name} -> ${pc.dnsPod ? 'directory: ' + svc.name + '.default.svc.cluster.local -> ClusterIP (answered by ' + pc.dnsPod.name + ')' : 'directory: no CoreDNS machine is up'} -> Service ${svc.name} -> ${p.name}${split ? (pc.canary ? ' (the canary: the sidecars\' 90/10 split, a VirtualService / HTTPRoute, not a Service feature)' : ' (v1, by the sidecars\' weighted split)') : ''}`);
}
// the spine has two lanes when the fabric runs BGP: consecutive parts take turns (equal-cost multipath); a canary part rides the second lane so the split shows
const SPINE2 = () => LANE - 6.5;
function laneX(canary){ if (canary != null) return canary ? SPINE2() : LANE; return st.net.fabric === 'bgp' && isShop() ? (st.net.lane++ % 2 ? SPINE2() : LANE) : LANE; }
function makeParcel(p, svc){
  const n = p && st.nodes.find(n => n.name === p.node), dns = isShop(), pts = dns ? [[LANE, 1, 2.2], [LANE, 20, 2.2], [LANE, 30, 2.2], [LANE, 45, 2.2]] : [[LANE, 1, 2.2], [LANE, 20, 2.2], [LANE, 45, 2.2]];
  if (p && n && isShop()){ const [px, py, pz] = p.pos, y1 = n.y0 + SLW, x1 = n.x0 + n.depth, r = p.slot.r, gx = r >= 2 ? x1 - 3.5 : n.x0 + 17.5 + r*BAYX, yt = y1 + 8, yd = y1 - 5, lx = laneX(p.ver === 'v2' && st.net.mesh.on && st.net.mesh.canary ? true : null);
    // the directory, the station, the spine lane, the corridor between cells, the cell's conveyor-side opening, the cross-aisle after the machine's row, the machine
    if (lx !== LANE) pts.push([lx, 50, 2.2]); pts.push([lx, yt, 2.2], [x1 + 4, yt, 2.2], [x1 + 4, yd, 2.2], [gx, yd, 2.2], [gx, py + 5, 2.2], [px + 10.6, py + 5, 2.2]); }
  else if (p && n){ const [px, py, pz] = p.pos, yt = py + PL + 3; pts.push([LANE, yt, 2.2], [n.x0 + SLD + 3, yt, 2.2], [n.x0 + SLD, yt, SLH + 2.2], [px + PW/2, yt, SLH + 2.2], [px + PW/2, yt, pz + 2.2], [px + PW/2, py + PL + .8, pz + 2.2]); }
  const segs = []; let L = 0; for (let i = 0; i < pts.length - 1; i++){ const l = dist3(pts[i], pts[i+1]); segs.push({ a: pts[i], b: pts[i+1], s0: L, l }); L += l; }
  const dirD = dns ? segs[1].s0 + segs[1].l : -1, kioskD = dns ? segs[2].s0 + segs[2].l : segs[1].s0 + segs[1].l, dp = dns ? dnsPick() : null;
  return { pts, segs, L, pod: p, svc, t: 0, dir: 1, col: p ? palOf(p.app).l : LAMPC.red, hold: 0, dirD, kioskD, dhold: 0, dns: dns ? (dp ? 'ok' : 'fail') : null, dnsPod: dp };
}
// a part from one machine to another (a Pod calling a Service): out of its bay to the cross aisle, the cell's conveyor-side opening, the lane, and into the other cell
function makeLink(a, b, blocked){
  const na = st.nodes.find(n => n.name === a.node), nb = st.nodes.find(n => n.name === b.node), z = 2.2;
  const bay = (p, n) => { const [px, py] = p.pos, y1 = n.y0 + SLW, x1 = n.x0 + n.depth, r = p.slot.r; return { px, py, x1, yt: y1 + 8, yd: y1 - 5, gx: r >= 2 ? x1 - 3.5 : n.x0 + 17.5 + r*BAYX }; };
  const A = bay(a, na), B = bay(b, nb), pts = [[A.px + 10.6, A.py + 5, z], [A.gx, A.py + 5, z], [A.gx, A.yd, z]];
  // two cells in one row share a junction: the part stays on the row's corridor; across rows it takes the spine (one of its lanes)
  if (na !== nb && na.row === nb.row && st.net.fabric === 'bgp'){ const cx = Math.max(A.x1, B.x1) + 4; pts.push([cx, A.yd, z], [cx, B.yd, z]); }
  else if (na !== nb){ const lx = laneX(); pts.push([A.x1 + 4, A.yd, z], [A.x1 + 4, A.yt, z], [lx, A.yt, z], [lx, B.yt, z], [B.x1 + 4, B.yt, z], [B.x1 + 4, B.yd, z]); }
  pts.push([B.gx, B.yd, z], [B.gx, B.py + 5, z], [B.px + 10.6, B.py + 5, z]);
  const segs = []; let L = 0; for (let i = 0; i < pts.length - 1; i++){ const l = dist3(pts[i], pts[i+1]); segs.push({ a: pts[i], b: pts[i+1], s0: L, l }); L += l; }
  const meshed = st.net.mesh.on && MESHED.has(a.app) && MESHED.has(b.app);
  return { pts, segs, L, pod: b, svc: st.services.find(s => (s.selector || {}).app === b.app) || { name: b.app }, from: a, link: true, blocked: !!blocked, stop: L - 4.5, t: 0, dir: 1, col: palOf(a.app).l, hold: 0, sleeve: meshed, kioskD: -1, dirD: -1 };
}
function parcelAt(pc, d){ for (const s of pc.segs) if (d <= s.s0 + s.l + 1e-6) return lerp3(s.a, s.b, s.l ? (d - s.s0)/s.l : 0); return pc.pts[pc.pts.length - 1]; }
// the target is chosen when the part leaves the station (a Ready endpoint then) and re-checked every frame after: a machine that is
// draining still answers (in-flight connections finish inside the grace period); one that has powered down, crashed or been removed
// cannot, so the part turns red where the machine was and comes back as a connection reset
function parcelTick(pc, dt){
  const spd = 95, kioskD = pc.kioskD != null ? pc.kioskD : pc.link ? -1 : pc.segs[1].s0 + pc.segs[1].l, dirD = pc.dirD == null ? -1 : pc.dirD;
  if (pc.dir === 1){
    // the directory: a lookup first (the name to a ClusterIP); with CoreDNS down the part waits out the timeout and comes back with no address
    if (dirD >= 0 && pc.t < dirD + .01 && pc.t + spd*dt >= dirD){ pc.t = dirD; if (!pc.dhold && pc.dnsPod){ st.net.hops.push({ pod: pc.dnsPod, t: 0, dur: .3 }); st.net.dns.flash = .3; } pc.dhold += dt; if (pc.dns === 'fail'){ if (pc.dhold > .9){ pc.dir = -1; pc.col = LAMPC.red; st.reqs.err++; say('nxdomain', `${pc.svc.name}.default.svc.cluster.local: lookup timed out, kube-dns has no Ready endpoints (no CoreDNS machine is up); connections already open keep working, new ones cannot find an address`); } return true; } if (pc.dhold < .3) return true; }
    if (pc.t < kioskD && pc.t + spd*dt >= kioskD && pc.hold < .3){ pc.hold += dt; pc.t = kioskD; return true; }
    // a NetworkPolicy gate: the part stops at the machine's gate, is dropped there (the CNI drops the packet; the caller times out) and comes back red
    if (pc.blocked && pc.t + spd*dt >= pc.stop){ pc.t = pc.stop; pc.hold += dt; if (pc.hold > .9){ pc.dir = -1; pc.col = LAMPC.red; st.reqs.err++; const pol = st.sec.netpol;
        say('netpol-drop', `NetworkPolicy ${pol ? pol.name : ''}: ${pc.from.app} -> ${pc.pod.app} is not allowed, so the CNI drops the packet at ${pc.pod.name}'s gate (the caller times out; nothing in the office is asked)`); } return true; }
    if (pc.pod && !pc.reset && pc.t > kioskD && poweredDown(pc.pod)){ pc.reset = pc.pod.phase === 'crash' ? 'crashed' : st.pods.includes(pc.pod) ? 'powered down' : 'was removed'; }
    pc.t += spd*dt;
    if (pc.t >= pc.L){ pc.dir = -1; pc.t = pc.L;
      if (!pc.pod) pc.col = LAMPC.red;
      else if (pc.reset){ pc.col = LAMPC.red; st.reqs.err++; st.reqs.reset++; say('reset-' + pc.pod.id, `Connection reset: ${pc.pod.name} ${pc.reset} while the part was on its way; no reply (the client retries, the Service already routes elsewhere)`); }
      else { pc.col = LAMPC.green; st.reqs.ok++; } }
    return true; }
  pc.t -= spd*dt*1.15; return pc.t > 0;
}

/* ---------- one clock for everything ---------- */
let loopOn = false;
let SPEED = 1;
function tick(dt){
  dt *= SPEED; st.t += dt; let busy = false;
  if (st.boot && bootTick(dt)) busy = true;
  // cp.hold: etcd has no leader, so the API server cannot write; controllers and the scheduler wait (the crane finishes
  // a bind it already has, the kubelets carry on, nothing new is created or bound)
  if (st.cp.ctrl){ if (!st.cp.hold){ if (st.mode === 'demo'){ reconcile(); checkDependencies(); } schedule(); } if (!isShop() && (craneTick(dt) || st.crane.queue.length)) busy = true; }
  if (isShop() && shopTick(dt)) busy = true;
  for (const n of st.nodes) if (n.joining && n.joined < 1){ n.joined = Math.min(1, n.joined + dt/.9); busy = true; }   // a node joins only once its own kubeadm join has run
  for (const p of st.pods.slice()) if (podTick(p, dt)) busy = true;
  for (const n of st.nodes){ const g = n.cordoned ? 1 : 0; if (n.tape !== g){ n.tape = Math.max(0, Math.min(1, n.tape + (g - n.tape > 0 ? dt/.5 : -dt/.5))); busy = true; } }
  if (secTick(dt)) busy = true; if (netTick(dt)) busy = true;
  st.parcels = st.parcels.filter(pc => parcelTick(pc, dt)); if (st.parcels.length) busy = true;
  const boomUp = st.parcels.some(pc => Math.abs(pc.t - 20) < 30 || pc.t < 50) ? 1 : 0;
  if (st.boom !== boomUp){ st.boom = Math.max(0, Math.min(1, st.boom + (boomUp ? dt/.35 : -dt/.5))); busy = true; }
  if (st.live.pending){ busy = true; }
  return busy;
}
function run(){ if (loopOn || !ui) return; loopOn = true; ui.animate(dt => { const busy = tick(dt); if (!busy) loopOn = false; return busy; }, 'sim'); }


/* ---------- bootstrapping: an empty yard comes up in the real order ---------- */
function bootstrap(){
  if (st.mode === 'live') return liveNote('kubeadm init (control plane), then kubeadm join on each node');
  startDemo(); st.pods = []; st.deploys = []; st.crane.queue = []; st.crane.job = null; st.crane.carry = null; st.caps = []; st.parcels = []; st.said = {};
  for (const n of st.nodes){ n.used = new Set(); n.joined = 0; n.joining = false; n.ready = false; n.cordoned = false; n.tape = 0; n.cache = new Set(); n.pull = null; }
  st.cp = { etcd:0, api:0, ctrl:0, hold:0 }; st.crane.z = 1; st.crane.x = (XR0 + XR1)/2; st.crane.y = D/2; refreshRegistry();
  Object.assign(st.sec, { ca: 0, badges: 0, refuse: [], refuseT: 0, forged: [], inspect: 0, stamp: 0, queue: [] }); for (const n of st.nodes){ n.cert = null; n.csr = false; }
  const V = VOC(); const ev = [
    [.2, () => say('b0', V.b0)],
    [1.4, () => { st.sec.ca = 1; st.sec.badges = 3; st.sec.stamp = 1.5; say('bca', V.bca); }],   // the CA first: nothing below can talk to anything without its certificate
    [2.8, () => { st.cp.etcd = 1; say('b1', V.b1); }],
    [4.2, () => { st.cp.api = 1; say('b2', V.b2); }],
    [5.6, () => { st.cp.ctrl = 1; say('b3', V.b3); }] ];
  st.nodes.forEach((n, i) => { ev.push([7.2 + i*1.7, () => { n.joining = true; n.csr = true; say('bj' + i, V.bj(n.name)); }]);
    ev.push([7.2 + i*1.7 + 1.1, () => { issueCert(n); n.ready = true; say('br' + i, V.br(n.name)); }]); });
  const tEnd = 7.2 + st.nodes.length*1.7 + .8;
  ev.push([tEnd, () => { st.deploys = JSON.parse(JSON.stringify(DEMO.deployments)).map(d => ({ ...d, ns:'default', kind: d.kind || 'Deployment' })); refreshRegistry(); say('bapp', V.bapp); }]);
  ev.push([tEnd + .3, () => { st.boot = null; }]);
  st.boot = { t: 0, i: 0, ev }; run();
}
function bootTick(dt){ const b = st.boot; b.t += dt; while (b.i < b.ev.length && b.t >= b.ev[b.i][0]) b.ev[b.i++][1]();
  if (st.cp.ctrl && st.crane.z < HZT && !st.crane.job) st.crane.z = Math.min(HZT, st.crane.z + dt*42);
  return !!st.boot; }

/* ---------- snapshots: the demo, a kubectl JSON file, or a polled URL ---------- */
function normalize(raw){
  if (raw && Array.isArray(raw.nodes) && !raw.items) return raw;
  const items = raw && raw.items ? raw.items : Array.isArray(raw) ? raw : [];
  const out = { context: raw.context || 'cluster', nodes: [], pods: [], deployments: [], services: [], ingresses: [] }; let tunnel = false, cpPods = false;
  const lab = (o, k) => o.metadata && o.metadata.labels ? o.metadata.labels[k] : undefined;
  const appOf = o => { const m = o.metadata || {}, l = m.labels || {}; if (l.app) return l.app; if (l['app.kubernetes.io/name']) return l['app.kubernetes.io/name']; if (l['k8s-app']) return l['k8s-app'];
    const own = (m.ownerReferences || [])[0]; if (own && own.kind === 'ReplicaSet') return own.name.replace(/-[a-z0-9]{6,10}$/, ''); if (own) return own.name; return (m.name || 'pod').replace(/(-[a-z0-9]{5,10}){1,2}$/, ''); };
  for (const o of items){ const m = o.metadata || {}, sp = o.spec || {}, stt = o.status || {};
    if (o.kind === 'Node') out.nodes.push({ name: m.name, ready: (stt.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'), cordoned: !!sp.unschedulable, gpus: +((stt.allocatable || {})['nvidia.com/gpu'] || 0) });
    else if (o.kind === 'Pod'){ const cs = stt.containerStatuses || [], own = (m.ownerReferences || [])[0];
      const vols = sp.volumes || [], img = ((sp.containers || [])[0] || {}).image || '';
      const gpuOf = c => +(((c.resources || {}).limits || {})['nvidia.com/gpu'] || ((c.resources || {}).requests || {})['nvidia.com/gpu'] || 0);
      out.pods.push({ name: m.name, namespace: m.namespace, node: sp.nodeName || null, app: appOf(o), phase: stt.phase, gpu: (sp.containers || []).reduce((a, c) => a + gpuOf(c), 0),
        ready: cs.length > 0 && cs.every(c => c.ready), restarts: cs.reduce((a, c) => a + (c.restartCount || 0), 0),
        containers: (sp.containers || []).map(c => ({ name: c.name, image: c.image })),
        version: lab(o, 'version') || lab(o, 'app.kubernetes.io/version') || (own && own.kind === 'ReplicaSet' ? own.name.slice(-5) : (img.split(':')[1] || 'v1')),
        pvc: (vols.find(v => v.persistentVolumeClaim) || {}).name, configMap: (vols.find(v => v.configMap) || {}).name, secret: (vols.find(v => v.secret) || {}).name,
        system: m.namespace === 'kube-system' || (own && own.kind === 'DaemonSet') }); }
    if (o.kind === 'DaemonSet' && /konnectivity-agent|cloud-provider|cloud-controller/.test(m.name || '')) tunnel = true;
    if (o.kind === 'Pod' && /^(kube-apiserver|etcd|kube-controller-manager|kube-scheduler)-/.test(m.name || '')) cpPods = true;
    if (o.kind === 'Deployment' || o.kind === 'StatefulSet' || o.kind === 'DaemonSet'){ const sel = (sp.selector && sp.selector.matchLabels) || {};
      const tpl = (sp.template && sp.template.spec) || {}, img = ((tpl.containers || [])[0] || {}).image || '';
      out.deployments.push({ name: m.name, namespace: m.namespace, kind: o.kind, app: sel.app || sel['app.kubernetes.io/name'] || sel['k8s-app'] || m.name, replicas: sp.replicas != null ? sp.replicas : (stt.desiredNumberScheduled || 0),
        ready: stt.readyReplicas || stt.numberReady || 0, version: img.split(':')[1] || 'v1', containers: (tpl.containers || []).map(c => ({ name: c.name, image: c.image })), system: m.namespace === 'kube-system' || o.kind === 'DaemonSet' }); }
    else if (o.kind === 'Service') out.services.push({ name: m.name, namespace: m.namespace, selector: sp.selector || {}, ports: (sp.ports || []).map(p => p.port), clusterIP: sp.clusterIP });
    else if (o.kind === 'Ingress'){ for (const r of (sp.rules || [])){ const pth = ((r.http || {}).paths || [])[0] || {}, be = (pth.backend || {}).service || {}; out.ingresses.push({ host: r.host || '*', service: be.name, port: (be.port || {}).number }); } }
  }
  out.managed = tunnel && !cpPods;   // a tunnel agent on every node and no control-plane pods in sight: the office is the provider's
  return out;
}
function applySnapshot(data, instant){
  data = normalize(data); if (st.mode === 'live' && data.managed != null && data.managed !== st.net.managed) setManaged(data.managed, true);
  const nodeNames = (data.nodes || []).map(n => n.name), sameNodes = nodeNames.length === st.nodes.length && nodeNames.every((n, i) => st.nodes[i].name === n);
  if (!sameNodes){ const old = new Map(st.nodes.map(n => [n.name, n]));
    st.nodes = (data.nodes || []).map(n => Object.assign(old.get(n.name) || { used: new Set(), tape: 0, joined: 1, joining: true, cache: new Set(), pull: null }, { name: n.name, ready: n.ready !== false, cordoned: !!n.cordoned, gpus: n.gpus || 0 }));
    for (const p of st.pods){ if (!st.nodes.find(n => n.name === p.node)){ p.node = null; p.slot = null; p.pos = null; p.phase = 'pending'; } }
    for (const n of st.nodes){ n.used = new Set(); for (const p of st.pods) if (p.node === n.name && p.slot) n.used.add(slotKey(p.slot)); }
    layout(st); }
  else for (const n of st.nodes){ const d = data.nodes.find(x => x.name === n.name); n.ready = d.ready !== false; n.cordoned = !!d.cordoned; n.gpus = d.gpus || 0; if (instant) n.tape = n.cordoned ? 1 : 0; }
  st.deploys = (data.deployments || []).map(d => ({ name: d.name, ns: d.namespace || 'default', app: d.app || d.name, kind: d.kind || 'Deployment', replicas: d.replicas || 0, ready: d.ready, version: d.version || 'v1', containers: d.containers, pvc: d.pvc, configMap: d.configMap, secret: d.secret, sys: !!d.system, dependsOn: d.dependsOn, gpu: d.gpu || 0, gang: !!d.gang, minMember: d.minMember }));
  st.services = data.services || []; st.ingresses = data.ingresses || [];
  if (st.mode === 'demo' && !(data.pods || []).length){ /* the demo builds its pods from the deployments */ }
  else {
    const seen = new Set();
    for (const d of (data.pods || [])){ seen.add(d.name); let p = st.pods.find(p => p.name === d.name);
      const dep = st.deploys.find(x => x.app === d.app) || { name: d.app, app: d.app, version: d.version, containers: d.containers };
      if (!p){ p = makePod(dep, d.version || 'v1'); p.name = d.name; p.ns = d.namespace || 'default'; p.containers = d.containers && d.containers.length ? d.containers : p.containers; p.pvc = d.pvc; p.configMap = d.configMap; p.secret = d.secret; p.sys = !!d.system; p.gpu = d.gpu || 0; st.pods.push(p); }
      p.wantNode = d.node; p.restarts = d.restarts || 0;
      const want = d.phase === 'Running' ? (d.ready ? 'running' : 'unready') : d.phase === 'Pending' ? 'pending' : d.phase === 'Failed' || d.phase === 'CrashLoopBackOff' ? 'crash' : d.phase === 'Succeeded' ? 'terminating' : 'running';
      if (p.node && p.node !== d.node){ removeFromNode(p); }
      if (!p.node && d.node){ const n = st.nodes.find(n => n.name === d.node); const sl = n && freeSlot(n);
        if (n && sl && (instant || p.sys && !st.showSys)){ placePod(p, n, sl); p.phase = want === 'pending' ? 'creating' : want; p.ready = want === 'running'; if (n.cache) n.cache.add(p.app + ':' + p.ver); }
        else if (n && sl){ p.phase = 'pending'; }
        else { p.phase = 'pending'; } }
      else if (p.node && p.phase !== 'scheduled' && p.phase !== 'creating' && want !== 'pending'){
        if (want === 'unready' && p.phase !== 'unready'){ p.phase = 'unready'; p.phaseT = -1e9; p.ready = false; }
        else if (want === 'running' && p.phase !== 'running'){ p.phase = 'running'; p.ready = true; p.phaseT = 0; }
        else if (want === 'crash' && p.phase !== 'crash'){ p.phase = 'crash'; p.phaseT = -1e9; p.fire = 1; p.ready = false; }
        else if (want === 'terminating') terminate(p); }
    }
    for (const p of st.pods) if (!seen.has(p.name)) terminate(p);
  }
  markBands(); refreshRegistry(); layout(st); if (ui) reframe();
  if (st.mode === 'live') run();
}
function removeFromNode(p){ const n = st.nodes.find(n => n.name === p.node); if (n && p.slot) n.used.delete(slotKey(p.slot)); p.node = null; p.slot = null; p.pos = null; }
function startDemo(){
  st.mode = 'demo'; stopLive(); st.pods = []; st.crane.queue = []; st.crane.job = null; st.crane.carry = null; st.caps = []; st.parcels = []; st.nodes = [];
  applySnapshot(JSON.parse(JSON.stringify(DEMO)), true);
  for (const n of st.nodes){ n.used = new Set(); n.tape = 0; n.cordoned = false; n.cache = new Set(); n.pull = null; }
  // the demo starts deployed: pods spread over the nodes, all Running (so every node has those images cached)
  const order = ['web', 'api', 'db', 'coredns']; let i = 0;
  for (const app of order){ const dep = depOf(app); if (!dep) continue; for (let r = 0; r < dep.replicas; r++){ const p = makePod(dep); const n = st.nodes[i++ % st.nodes.length]; placePod(p, n, freeSlot(n)); p.phase = 'running'; p.ready = true; n.cache.add(p.app + ':' + p.ver); st.pods.push(p); } }
  markBands(); refreshRegistry(); layout(st); st.crane.x = (XR0 + XR1)/2; st.crane.y = D/2; st.crane.z = HZT; if (ui) reframe();
  Object.assign(st.sec, { ca: 1, badges: 3, netpol: null, refuse: [], refuseT: 0, forged: [], inspect: 0, stamp: 0, queue: [] }); st.reqs = { sent:0, ok:0, err:0, reset:0 };
  st.nodes.forEach((n, i) => { n.cert = { issued: st.t - 7 - i*9, exp: st.t - 7 - i*9 + ROT, ok: true, flash: 0 }; n.csr = false; n.rotated = 0; }); st.sec.badges = 3 + st.nodes.length;
}
function stopLive(){ if (st.live.timer) clearInterval(st.live.timer); st.live.timer = 0; st.live.url = null; st.live.status = ''; }
async function pollOnce(first){
  try { const r = await fetch(st.live.url, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); const data = await r.json();
    st.live.status = 'live'; applySnapshot(data, first); if (first) say('live', `Watching ${data.context || st.live.url}: ${st.pods.length} pods on ${st.nodes.length} nodes`); ui.render(); }
  catch (e){ st.live.status = 'error'; say('liveerr', `Could not read ${st.live.url}: ${e.message}`, 3200); ui.render(); }
}
function watchUrl(url, every){
  stopLive(); st.mode = 'live'; st.pods = []; st.crane.queue = []; st.crane.job = null; st.crane.carry = null; st.caps = []; st.parcels = [];
  for (const n of st.nodes){ n.used = new Set(); n.pull = null; }
  st.live.url = url; st.live.poll = every; pollOnce(true); if (every > 0) st.live.timer = setInterval(() => pollOnce(false), every*1000);
}
function loadFile(){
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = () => { const fl = inp.files[0]; if (!fl) return; fl.text().then(txt => { let data; try { data = JSON.parse(txt); } catch (e){ return say('badjson', 'That file is not JSON', 2600); }
    stopLive(); st.mode = 'live'; st.pods = []; st.crane.queue = []; st.crane.job = null; st.crane.carry = null; st.caps = []; st.parcels = []; for (const n of st.nodes){ n.used = new Set(); n.pull = null; }
    applySnapshot(data, true); st.live.status = 'file'; say('file', `Loaded ${fl.name}: ${st.pods.length} pods on ${st.nodes.length} nodes`); ui.render(); }); };
  inp.click();
}
const liveNote = cmd => say('ro-' + cmd, `${VOC().live}. Run: ${cmd}`, 3400);

/* ---------- buttons ---------- */
function scaleTo(app, n){ if (st.mode === 'live') return liveNote(`kubectl scale deploy/${app} --replicas=${n}`); const d = depOf(app); if (!d) return; d.replicas = n; say('scale', `kubectl scale deploy/${app} --replicas=${n}`); run(); }
function rollout(app, ver){ if (st.mode === 'live') return liveNote(`kubectl set image deploy/${app} ${app}=${app}:${ver}`); const d = depOf(app); if (!d || d.version === ver) return; d.version = ver;
  say('rollout', `kubectl set image deploy/${app} ${app}=${app}:${ver}  (rolling update, one at a time)`); run(); }
function applyTrain(){ if (st.mode === 'live') return liveNote('kubectl apply -f train.yaml'); if (depOf('train')) return say('train', 'train is already applied');
  st.deploys.push({ name:'train', ns:'default', app:'train', kind:'Deployment', replicas:3, version:'v1', containers:[{ name:'trainer', image:'pytorch:2.4-cuda' }], gpu:1 });
  say('apply', 'kubectl apply -f train.yaml: 3 replicas, each requests nvidia.com/gpu: 1; only node-c has GPUs (2)'); run(); }
function applySpark(){ if (st.mode === 'live') return liveNote('kubectl apply -f spark-podgroup.yaml'); if (depOf('spark')) return say('spark', 'spark is already applied');
  st.deploys.push({ name:'spark', ns:'default', app:'spark', kind:'Job', replicas:4, version:'v1', containers:[{ name:'executor', image:'spark:3.5' }], gang:true, minMember:4 });
  say('apply', 'kubectl apply -f spark-podgroup.yaml: Job spark with schedulerName: volcano, PodGroup minMember 4'); run(); }
function applyCache(){ if (st.mode === 'live') return liveNote('kubectl apply -f cache.yaml'); if (depOf('cache')) return say('cache', 'cache is already applied');
  st.deploys.push({ name:'cache', ns:'default', app:'cache', kind:'Deployment', replicas:2, version:'v1', containers:[{ name:'redis', image:'redis:7' }] });
  say('apply', 'kubectl apply -f cache.yaml: Deployment cache created, ReplicaSet wants 2'); run(); }
function deleteDep(app){ if (st.mode === 'live') return liveNote(`kubectl delete deploy/${app}`); if (!depOf(app)) return say('nodep', `${app} is not deployed`); st.deploys = st.deploys.filter(d => d.app !== app); say('del', `kubectl delete deploy/${app}: its ReplicaSet and Pods go with it`); run(); }
function pickPod(app){ const c = st.pods.filter(p => p.app === app && isReady(p) && p.pos); return c.length ? c[Math.floor(rnd()*c.length)] : null; }
function deletePod(app = 'web', pod){ if (st.mode === 'live') return liveNote('kubectl delete pod <name>'); const p = pod || pickPod(app); if (!p) return say('nopod', `No Ready ${app} Pod to delete right now`);
  p.phase = 'crash'; p.phaseT = .4; p.fire = 1; p.ready = false; p.doomed = true; p.down = true; st.sec.queue.push([st.t + .7, () => terminate(p)]); say('delpod', `kubectl delete pod ${p.name}: the ReplicaSet will replace it`); run(); }
function crashPod(pod){ if (st.mode === 'live') return liveNote('kubectl exec <pod> -- kill 1'); const p = pod || pickPod('api') || pickPod('web'); if (!p) return say('nopod', 'No Ready Pod to crash right now');
  p.phase = 'crash'; p.phaseT = 0; p.fire = 1; p.ready = false; say('crash', `Crash: ${p.name} container exited; the kubelet restarts it in place (the Pod keeps its name and node)`); run(); }
function unreadyPod(pod){ if (st.mode === 'live') return liveNote('(make a readiness probe fail: e.g. stop the health endpoint)'); const p = pod || pickPod('web'); if (!p) return say('nopod', 'No Ready web Pod right now');
  p.phase = 'unready'; p.phaseT = 0; p.ready = false; say('unready', `Probe: ${p.name} readiness failing, so the Service stops sending it traffic (the Pod is not restarted)`); run(); }
function drain(n){ if (st.mode === 'live') return liveNote(`kubectl drain ${n.name} --ignore-daemonsets`); n.cordoned = true; announce(n, true); const ev = st.pods.filter(p => p.node === n.name && p.phase !== 'terminating'); ev.forEach(terminate);
  say('drain', `kubectl drain ${n.name}: cordoned, ${ev.length} Pod${ev.length === 1 ? '' : 's'} evicted; ReplicaSets recreate them elsewhere`); run(); }
function uncordon(n){ if (st.mode === 'live') return liveNote(`kubectl uncordon ${n.name}`); n.cordoned = false; announce(n, false); say('uncordon', `kubectl uncordon ${n.name}: schedulable again`); run(); }
function podInfo(p){ const d = depOf(p.app); say('info-' + p.id, `${p.name} · ${p.node || 'Pending'} · ${p.phase === 'running' ? (p.ready ? 'Running, Ready' : 'Running') : p.phase} · ${p.containers.length} container${p.containers.length === 1 ? '' : 's'} · restarts ${p.restarts}${p.pvc ? ' · volume ' + p.pvc : ''}${d && d.kind === 'StatefulSet' ? ' · StatefulSet' : ''}`, 3000); }


/* ---------- security: the CA and its badges, the kubelet's certificate rotation, admission refusals, NetworkPolicy ----------
   kubeadm makes the cluster CA before anything else; every control-plane component and every kubelet holds a certificate it
   signed, and all of them talk mutual TLS. A kubelet gets its first certificate through a CSR (approved for the bootstrap
   token's group, signed by the controller manager's signer) and rotates it at about 80% of its lifetime the same way. */
function issueCert(n){ n.cert = { issued: st.t, exp: st.t + ROT, ok: true, flash: .9 }; n.csr = false; n.certDown = null; st.sec.badges++; }
function secTick(dt){ let busy = false; const S = st.sec;
  if (S.stamp > 0){ S.stamp -= dt; busy = true; }
  if (S.refuseT > 0){ S.refuseT -= dt; busy = true; }
  if (S.inspect > 0){ S.inspect -= dt; busy = true; }
  for (const f of S.forged){ f.t += dt/f.dur; busy = true; if (f.t >= 1 && !f.done){ f.done = true; S.refuseT = 1.6; S.refuse.push({ kind: 'authn', t: st.t });
    say('401', '401 Unauthorized: the forged card carries no seal (no certificate this CA signed, no valid token), so the counter refuses it before reading it; nothing is written and nothing is scheduled'); } }
  S.forged = S.forged.filter(f => !f.done || f.t < 1.3);
  for (const [t, fn] of S.queue.slice()) if (st.t >= t){ S.queue.splice(S.queue.indexOf(S.queue.find(q => q[1] === fn)), 1); fn(); }
  if (S.queue.length) busy = true;
  for (const n of st.nodes){ const c = n.cert; if (!c) continue;
    if (c.flash > 0){ c.flash = Math.max(0, c.flash - dt); busy = true; }
    if (c.ok && st.t > c.exp - ROT*.2){ c.issued = st.t; c.exp = st.t + ROT; c.flash = .9; n.rotated = (n.rotated || 0) + 1; st.sec.badges++; busy = true;
      if (!(S.rotSaid > st.t - 120)){ S.rotSaid = st.t; say('rot', `${n.name}: the kubelet rotated its client certificate before it expired (a new CSR, approved and signed by the CA); the badge flashes as it is renewed. Every cell does this on its own schedule`); } }   // the toast once in a while; the flash every time
    if (!c.ok){ n.certDown = (n.certDown || 0) + dt; busy = true;
      if (n.certDown > .6 && n.ready){ n.ready = false; for (const p of st.pods) if (p.node === n.name && (p.phase === 'running' || p.phase === 'unready')){ p.phase = 'unready'; p.phaseT = 0; p.ready = false; p.nodeDown = true; }
        say('certdown', `${n.name}'s kubelet certificate has expired: the counter refuses its status updates (401), the node-lifecycle controller marks it NotReady, its machines stop being endpoints and the dispatcher sends it nothing`); }
      if (n.certDown > 4.5){ issueCert(n); n.ready = true; say('certback', `${n.name}: re-bootstrapped with a fresh token, a new CSR is approved and signed by the CA; the kubelet reports again and the node is Ready (in real life: kubeadm certs renew, or a new kubeadm join)`); } } }
  return busy; }
function forgeCard(){ if (st.mode === 'live') return liveNote('(send the API server a request with no credentials: curl -k https://<api>:6443/api/v1/pods)'); if (!st.cp.api) return say('noapi', 'The counter is closed: nothing to refuse yet');
  st.sec.forged.push({ t: 0, dur: 2.4 }); say('forge', 'A forged job card comes up the tube from the floor: no seal on it, no client certificate, no token (kubectl with a made-up kubeconfig)'); run(); }
function expireBadge(name = 'node-b'){ if (st.mode === 'live') return liveNote('kubeadm certs check-expiration   # on the node: openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates');
  const n = st.nodes.find(n => n.name === name) || st.nodes[1] || st.nodes[0]; if (!n || !n.cert) return say('nocert', `${name} has no badge yet`); if (!n.cert.ok) return say('certalready', `${n.name}'s badge is already expired`);
  n.cert.ok = false; n.cert.exp = st.t; n.certDown = 0; say('expire', `${n.name}'s kubelet client certificate expires now (its badge goes red): the next status update it sends will be refused`); run(); }
function applyPrivileged(){ if (st.mode === 'live') return liveNote('kubectl apply -f privileged.yaml   # refused by Pod Security Admission in a restricted namespace'); if (!st.cp.api) return say('noapi', 'The counter is closed');
  st.sec.inspect = 1.8; st.sec.refuseT = 1.6; st.sec.refuse.push({ kind: 'psa', t: st.t });
  say('psa', 'kubectl apply -f privileged.yaml: the inspector refuses it because this namespace is labelled pod-security.kubernetes.io/enforce=restricted, so privileged: true is a 403 and nothing is written. Without that label (Kubernetes The Hard Way labels none and runs --allow-privileged=true) the same card passes'); run(); }
// kubectl logs: a read, not a write; the counter checks the badge and RBAC, then calls the cabinet itself, over TLS the other way
function podLogs(p){ if (st.mode === 'live') return liveNote(`kubectl logs ${p.name}`); if (!p.node) return say('nologs', `${p.name} has no node yet: no kubelet to ask`);
  say('logs-' + p.id, `kubectl logs ${p.name}: the counter checks the badge and RBAC (pods/log), then calls ${p.node}'s cabinet on :10250 with its own kubelet-client certificate; the cabinet asks the counter whether this caller may read logs (SubjectAccessReview) before it answers`, 3200);
  if (window.ControlRoom && ControlRoom.logs) ControlRoom.logs(p); run(); }
function applyNetpol(quiet){ if (st.mode === 'live') return liveNote('kubectl apply -f netpol-db.yaml'); if (st.sec.netpol) return say('netpol', 'The NetworkPolicy is already in force');
  st.sec.netpol = { name: 'db-from-api', to: 'db', from: ['api'] }; if (quiet) return;
  say('netpol', 'kubectl apply -f netpol-db.yaml: NetworkPolicy db-from-api selects the db machines and allows ingress on 5432 from api only; the CNI closes every other gate into them');
  st.sec.queue.push([st.t + 1.1, () => linkRequest('web', 'db')], [st.t + 2.6, () => linkRequest('api', 'db')]); run(); }
function removeNetpol(){ if (st.mode === 'live') return liveNote('kubectl delete networkpolicy db-from-api'); if (!st.sec.netpol) return say('nonetpol', 'No NetworkPolicy to remove');
  st.sec.netpol = null; say('netpoldel', 'kubectl delete networkpolicy db-from-api: with no policy selecting them the db gates are open again (the default is allow-all)'); run(); }
// a part from one machine to another: web calling db, api calling db
function linkRequest(fromApp, toApp){ const a = pickPod(fromApp), b = pickPod(toApp); if (!a || !b) return say('nolink', `No Ready ${!a ? fromApp : toApp} machine right now`);
  const pol = st.sec.netpol, blocked = !!(pol && pol.to === toApp && !pol.from.includes(fromApp)); st.reqs.sent++; st.parcels.push(makeLink(a, b, blocked));
  say('link-' + fromApp, `${a.name} -> Service ${toApp}:${(st.services.find(s => s.name === toApp) || { ports: [0] }).ports[0] || ''} -> ${b.name}${blocked ? ' (the policy will drop it at the gate)' : pol && pol.to === toApp ? ' (allowed by the policy)' : ''}`); run(); }
// a slow heartbeat so the badges age while the floor is idle (the loop only runs while something moves); it follows the Clock and never draws a frame of its own
setInterval(() => { if (!ui || loopOn || SPEED <= 0 || st.mode !== 'demo' || !st.sec.ca) return; st.t += SPEED; if (secTick(SPEED)) run(); else if (document.querySelector('.card.open')) ui.render(); }, 1000);

/* ---------- networking: the fabric, the directory, the mesh, a managed control plane ----------
   The fabric is the floor's road network drawn as a small Clos: a junction per row of cells (the top-of-rack switch) and a
   main avenue with two lanes (the spine, equal-cost multipath). With static routes (Kubernetes The Hard Way) each host knows
   the other cells' ranges by hand; with BGP every cabinet announces its own PodCIDR to its junction and withdraws it when the
   cell is drained. The directory is CoreDNS: two pods behind the kube-dns ClusterIP that every pod's resolv.conf points at.
   The mesh adds a sidecar escort to each meshed machine, its own CA and a weighted split the Service never had. */
const MESHED = new Set(['web', 'api']);
function announce(n, withdraw){ if (st.net.fabric !== 'bgp' || !isShop()) return; st.net.ann.push({ node: n.name, t: 0, dur: 1.4, withdraw: !!withdraw }); say('bgp-' + n.name, withdraw ? `${n.name}: cordoned, its BGP speaker withdraws 10.200.${st.nodes.indexOf(n)}.0/24 from the junction; no new part is routed to it` : `${n.name}: its BGP speaker announces 10.200.${st.nodes.indexOf(n)}.0/24 to the junction again`); run(); }
function setFabric(f, quiet){ if (st.net.fabric === f) return quiet ? 0 : say('fabric', `The fabric already runs ${f === 'bgp' ? 'BGP' : 'static routes'}`); st.net.fabric = f;
  if (f === 'bgp'){ for (const n of st.nodes) if (n.joined >= 1 && !n.cordoned) st.net.ann.push({ node: n.name, t: 0, dur: 1.4, withdraw: false }); }
  if (!quiet) say('fabric', f === 'bgp' ? 'Fabric: BGP. Every cabinet runs a speaker (Cilium or Calico) that announces its PodCIDR to the row\'s junction; the junctions share them over the spine, whose two lanes carry parts in turn (ECMP)' : 'Fabric: static routes, the Hard Way: every host carries a route to each other cell\'s range, written by hand; one lane, no announcements');
  run(); }
function setSvcMode(m, quiet){ if (st.net.svc === m) return quiet ? 0 : say('svcmode', 'Already set'); st.net.svc = m;
  if (!quiet) say('svcmode', m === 'ebpf' ? 'Service addressing: eBPF. The CNI (Cilium) replaces kube-proxy: a Service address is rewritten at the socket or the packet by programs loaded into the kernel, no iptables chains; DigitalOcean Kubernetes ships this way' : 'Service addressing: kube-proxy in iptables mode writes a chain per Service that rewrites the ClusterIP to one Ready endpoint'); run(); }
// CoreDNS is pods in cells: the booth is only the kube-dns Service, and a lookup is answered by one Ready CoreDNS machine, round robin
const isDnsPod = p => p.app === 'coredns' || p.app === 'kube-dns';
const dnsPods = () => st.pods.filter(p => isDnsPod(p) && isReady(p) && p.pos);
function dnsPick(){ const ps = dnsPods(); if (!ps.length) return null; return ps[st.net.dns.n++ % ps.length]; }
const dnsUp = () => dnsPods().length > 0;
const dnsIP = () => { const s = st.services.find(s => s.name === 'kube-dns'); return (s && s.clusterIP) || '10.96.0.10'; };
function stopDns(){ if (st.mode === 'live') return liveNote('kubectl -n kube-system delete pod -l k8s-app=kube-dns'); const ps = st.pods.filter(p => isDnsPod(p) && p.phase !== 'terminating' && p.phase !== 'crash'); if (!ps.length) return say('dnsdown', 'No CoreDNS machine is up to stop');
  for (const p of ps){ p.phase = 'crash'; p.phaseT = .4; p.fire = 1; p.ready = false; p.doomed = true; p.down = true; st.sec.queue.push([st.t + .7, () => terminate(p)]); }   // on the simulation clock, like everything else
  say('dnsstop', `kubectl -n kube-system delete pod -l k8s-app=kube-dns: both CoreDNS machines go down, kube-dns has no endpoints and the directory window goes dark; new lookups fail, open connections do not notice. The kube-system Deployment is already raising replacement cards`); run(); }
function applyMesh(quiet){ if (st.mode === 'live') return liveNote('istioctl install / linkerd install, then label the namespace for injection'); const M = st.net.mesh; if (M.on) return quiet ? 0 : say('mesh', 'The mesh is already installed'); M.on = true;
  if (!quiet) say('mesh', 'kubectl label ns default istio-injection=enabled, then a rollout restart: every web and api machine gets an escort cartridge (the sidecar proxy); the mesh desk in the annex issues each one a certificate from the mesh\'s own CA, and parts between them travel in a sealed sleeve (mutual TLS the cluster CA knows nothing about)'); run(); }
function applyCanary(pct, quiet){ if (st.mode === 'live') return liveNote('kubectl apply -f virtualservice-web.yaml   # weight 90 / 10'); if (!st.net.mesh.on) applyMesh(true); const M = st.net.mesh, d = depOf('web'); if (!d) return;
  M.canary = pct; M.n = 0; if (d.version !== 'v2'){ d.version = 'v2'; } d.paused = true;
  if (!quiet) say('canary', `kubectl set image deploy/web ... v2 && kubectl rollout pause deploy/web, then a VirtualService (or an HTTPRoute) with weights 90 / 10: one v2 machine comes up and stays, and the sidecars send one part in ten to it. The Service itself would round-robin all of them equally; this split lives in the mesh`); run(); }
function removeMesh(){ if (st.mode === 'live') return liveNote('istioctl uninstall --purge'); const M = st.net.mesh, d = depOf('web'); if (!M.on && !M.canary) return say('nomesh', 'No mesh to remove'); M.on = false; M.canary = 0;
  if (d && d.paused){ d.paused = false; say('meshoff', 'Mesh removed: the escorts and the sleeves go, the sorting station is back to round robin, and kubectl rollout resume deploy/web lets the paused rollout finish to v2'); } else say('meshoff', 'Mesh removed: the escorts and the sleeves go, parts travel in the clear again and the station is back to round robin'); run(); }
function setManaged(on, quiet){ if (st.net.managed === !!on) return; st.net.managed = !!on; OFFICE[0] = on ? -22 : 20;
  if (!quiet) say('managed', on ? 'Managed control plane: the planning office moves into the provider\'s building behind the fence. The counter still takes every request; the cells reach it, and it reaches them for logs and exec, through the konnectivity tunnel (a relay on every cabinet). The provider owns the office, you own the cells' : 'The control plane is yours again: the office is back on the mezzanine, no tunnel needed');
  if (ui) reframe(); run(); }
function netTick(dt){ let busy = false; const N = st.net;
  for (const a of N.ann){ a.t += dt/a.dur; busy = true; } N.ann = N.ann.filter(a => a.t < 1.25);
  for (const h of N.hops){ h.t += dt/h.dur; busy = true; } N.hops = N.hops.filter(h => h.t < 1); if (N.dns.flash > 0){ N.dns.flash -= dt; busy = true; }
  const up = dnsUp(); if (up && N.dns.wasDown){ N.dns.wasDown = false; say('dnsback', 'A replacement CoreDNS machine is Ready: kube-dns has an endpoint again and the directory window lights up'); } if (!up && !N.dns.wasDown && st.pods.some(isDnsPod)) N.dns.wasDown = true;
  return busy; }
