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
const LAMPC = { green:'#43c25c', amber:'#f2b230', red:'#e2483d', grey:'#9a948a', unknown:'#7f93b3' };
const APP_PALS = { web: PALS.cobalt, api: PALS.mint, db: PALS.tomato, cache: PALS.blush, train: matOf('#f08a2b'), spark: matOf('#9b7bd6') };
const GOLD = '#f2c230';
const EXTRA_PALS = ['#9b7bd6', '#4fb3b3', '#f08a2b', '#b9c45a', '#d98fd4', '#8aa0b8', '#c9a066', '#6fb86f'].map(matOf);
const palOf = app => { if (!APP_PALS[app]) APP_PALS[app] = EXTRA_PALS[Object.keys(APP_PALS).length % EXTRA_PALS.length]; return APP_PALS[app]; };

/* ---------- the demo cluster (the same shape tools/longshore.py writes; a raw kubectl List loads too) ---------- */
// every container carries its requests and limits (millicores, MiB): the scheduler fits requests, the kubelet enforces limits; tags map a
// version to the image it rolls out; dependsOn is what the program calls at request time (never what its probe checks)
const DEMO = {
  context: 'demo',
  nodes: [ { name:'node-a', cpu:4000, mem:8192 }, { name:'node-b', cpu:4000, mem:8192 }, { name:'node-c', cpu:8000, mem:16384, gpus:2 } ],
  deployments: [
    { name:'web', app:'web', replicas:3, version:'v1', containers:[{ name:'nginx', image:'nginx:1.27', ports:[80], req:{ cpu:250, mem:128 }, lim:{ cpu:500, mem:256 } }], tags:{ nginx:{ v1:'nginx:1.27', v2:'nginx:1.28', v3:'nginx:1.29' } }, configMap:'web-config', dependsOn:'api', pdb:{ name:'web-pdb', maxUnavailable:1 } },
    { name:'api', app:'api', replicas:2, version:'v1', containers:[{ name:'api', image:'yard/api:1.4', ports:[8080], req:{ cpu:500, mem:256 }, lim:{ cpu:1000, mem:512 } }, { name:'log-shipper', image:'fluent-bit:3', req:{ cpu:100, mem:64 }, lim:{ cpu:200, mem:128 } }], tags:{ api:{ v1:'yard/api:1.4', v2:'yard/api:1.5', v3:'yard/api:1.6' } }, secret:'api-keys', dependsOn:'db' },
    { name:'db', app:'db', kind:'StatefulSet', replicas:1, version:'v1', containers:[{ name:'postgres', image:'postgres:16', ports:[5432], req:{ cpu:1000, mem:1024 }, lim:{ cpu:1000, mem:1024 } }], tags:{ postgres:{ v1:'postgres:16', v2:'postgres:17' } }, pvc:'data-db' },
    { name:'coredns', namespace:'kube-system', app:'coredns', replicas:2, version:'1.12', containers:[{ name:'coredns', image:'coredns/coredns:1.12.0', ports:[53], req:{ cpu:100, mem:70 }, lim:{ mem:170 } }], antiAffinity:'preferred', system:true } ],
  services: [ { name:'web', selector:{ app:'web' }, ports:[80] }, { name:'api', selector:{ app:'api' }, ports:[8080] }, { name:'db', selector:{ app:'db' }, ports:[5432], clusterIP:'None' }, { name:'kube-dns', namespace:'kube-system', selector:{ app:'coredns' }, ports:[53], clusterIP:'10.96.0.10' } ],
  ingresses: [ { host:'shop.example.com', service:'web', port:80 } ] };
const NODE_DEFAULT = { cpu:4000, mem:8192 };          // allocatable for a node that states none
const reqOf = c => (c.req || { cpu:0, mem:0 });
const podReq = p => p.containers.reduce((a, c) => ({ cpu: a.cpu + reqOf(c).cpu, mem: a.mem + reqOf(c).mem }), { cpu:0, mem:0 });
// QoS: Guaranteed when every container's limits equal its requests, Burstable with any request, BestEffort with none
const qosOf = p => { const cs = p.containers; if (!cs.some(c => c.req || c.lim)) return 'BestEffort';
  return cs.every(c => c.lim && c.req && c.lim.cpu === c.req.cpu && c.lim.mem === c.req.mem) ? 'Guaranteed' : 'Burstable'; };
const fmtCpu = m => m >= 1000 && m % 1000 === 0 ? (m/1000) + '' : m + 'm';
const fmtMem = mi => mi >= 1024 && mi % 1024 === 0 ? (mi/1024) + 'Gi' : mi + 'Mi';

/* ---------- names ---------- */
const SUF = 'abcdefghijkmnpqrstuvwxyz0123456789';
let rseed = 7; const rnd = () => (rseed = (rseed * 48271) % 2147483647) / 2147483647;
const suffix = n => Array.from({ length:n }, () => SUF[Math.floor(rnd()*SUF.length)]).join('');
// a ReplicaSet's pod-template hash: two templates that differ by one character get two different names (FNV-1a, then mixed, base-36)
const rsHash = (app, ver) => { let h = 0x811c9dc5; for (const ch of app + '/' + ver){ h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; return ('xxxxx' + h.toString(36)).slice(-5); };
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
  b0: 'kubeadm init --control-plane-endpoint on cp-1: an empty cluster, its control plane (the office) still dark. Nothing can be scheduled until the control plane is up', bca: 'kubeadm init phase certs: the cluster CA is created and signs certificates for etcd, the API server and the scheduler; from here on every message between them is mutual TLS', b1: 'etcd is up on cp-1 (the first ledger drawer lights), a Raft group of one for now; the cluster has a memory',
  b2: 'kube-apiserver is serving on :6443 (the counter opens) and the watch stream is live (the tube pressurises); kubectl works from here on', b3: 'kube-controller-manager and kube-scheduler are running: controllers can create Pods and the scheduler can bind them',
  bj: n => `kubeadm join: ${n} starts its kubelet and container runtime (the cabinet powers on)`, br: n => `${n} registered with the API server and is Ready: the scheduler may bind Pods to it`,
  bapp: 'kubectl apply -f app/: Deployments web x3, api x2 and db x1 created (the orders on the board); their ReplicaSets create the Pods', live: 'This is a real cluster and the figure only watches it' } : {
  b0: 'kubeadm init: an empty yard. Nothing can be scheduled until the control plane is up', bca: 'kubeadm init phase certs: the CA is created and every control-plane component gets its certificate', b1: 'etcd is up on the first control-plane node, a Raft group of one for now: the cluster has a memory (every object will live in that cabinet)',
  b2: 'kube-apiserver is serving on :6443: kubectl works from here on', b3: 'kube-controller-manager and kube-scheduler are running: the crane powers up',
  bj: n => `kubeadm join: ${n} is bootstrapping its kubelet and container runtime`, br: n => `${n} registered with the API server and is Ready (kube-proxy and the CNI are on it)`,
  bapp: 'kubectl apply -f app/: Deployments web, api and db created; their ReplicaSets want 3, 2 and 1 Pods', live: 'This is a real cluster and the yard only watches it' };
const PULL = { cold: 1.4, warm: .25, start: .5 };  // an image the cell has never pulled, one from its rack, powering the machine up
const ROT = 600;                                   // a kubelet certificate's lifetime here (simulated seconds, ten minutes; kubeadm's is a year); it rotates at 80% of it, as the real one does
let rotToasted = false;                            // the rotation toast once per session; later rotations only flash the badge
const GRACE = 2, GRACE_MAX = 5;                    // terminationGracePeriodSeconds, scaled down: a machine drains (finishes the parts already sent to it, takes no new ones) before it powers down; past GRACE_MAX it is killed
const BACKOFF_0 = 10, BACKOFF_MAX = 300, BACKOFF_RESET = 600;   // the kubelet's restart back-off: 10 s, doubling to 5 min, forgotten after 10 min of running (the real values, on the clock)
const regIndex = (st, app) => { const i = st.regApps.indexOf(app); return i < 0 ? -1 : i; };
const regPos = (st, app) => { const i = Math.max(0, regIndex(st, app)); return [9, REG_Y0 + 4 + i*REG_GAP, 2 + 2*PH]; };
const nodeCenterY = n => n.y0 + SLW/2;

/* ---------- state ---------- */
let ui;
const st = { t:0, mode:'demo', model:'yard', nodes:[], pods:[], deploys:[], services:[], ingresses:[], regApps:[], seq:0, pvs:{},
  crane:{ x:75, y:130, z:36, carry:null, job:null, queue:[] }, caps:[], strobe:0, parcels:[], boom:0, boomT:0, rr:0, showSys:false,
  live:{ url:null, poll:0, timer:0, status:'' }, said:{}, pending503:0, cp:{ etcd:1, api:1, ctrl:1, hold:0, members:3 }, boot:null, reqs:{ sent:0, ok:0, err:0, reset:0 },
  // security: the CA (the seal press), badges signed, the NetworkPolicy in force, refusals at the counter (the room plays them), forged job cards in the tube, the inspector's sign, timed follow-ups
  sec:{ ca:1, badges:0, netpol:null, refuse:[], refuseT:0, forged:[], inspect:0, stamp:0, queue:[] },
  // networking: the fabric (static routes, or BGP from every cabinet to its row's diverter with two spine belts), Service addressing,
  // the directory (CoreDNS), the mesh (sidecars, the mesh's own CA, a weighted canary) and a managed control plane behind the fence
  net:{ fabric:'static', svc:'iptables', lane:0, ann:[], hops:[], flick:{}, dns:{ n:0, flash:0, hl:null, hlT:0, key:'' }, mesh:{ on:false, canary:0, n:0 }, managed:false } };
// a pod with a deletionTimestamp (Terminating) no longer counts for its ReplicaSet: the replacement is created at once, while the old
// one is still draining. A pod evicted from an unreachable node is Terminating too, but still exists: a StatefulSet waits for it
const podsOf = (app, alive = true) => st.pods.filter(p => p.app === app && (!alive || (p.phase !== 'terminating' && !p.orphan)));
const stsPods = app => st.pods.filter(p => p.app === app);                 // every pod object of a StatefulSet, Terminating and orphaned ones included
const isReady = p => p.phase === 'running' && p.ready;
const lampOf = p => p.phase === 'terminating' ? LAMPC.grey : p.unknown ? LAMPC.unknown : p.phase === 'done' ? '#5a82c6' : p.phase === 'crash' ? (p.phaseT < 1 ? LAMPC.red : LAMPC.amber) : isReady(p) ? LAMPC.green : LAMPC.amber;
const imageOf = p => (p.containers[0] || {}).image || p.app;
const depOf = app => st.deploys.find(d => d.app === app);
function say(key, text, ms = 2300){ if (!ui) return; const now = performance.now(); if (st.said[key] && now - st.said[key] < 2600) return; st.said[key] = now; ui.flash(text, ms); }

// the image a container runs at a version: the template's tags map, or the template's image with its tag replaced
const imageAt = (dep, c, ver) => { const t = dep.tags && dep.tags[c.name]; if (t && t[ver]) return t[ver]; if (!dep.version || ver === dep.version || !c.image) return c.image || dep.app; return c.image.split(':')[0] + ':' + ver; };
const containersAt = (dep, ver) => (dep.containers || [{ name: dep.app, image: dep.app }]).map(c => ({ ...c, image: imageAt(dep, c, ver) }));
// a StatefulSet's pods are db-0, db-1, ... : the lowest ordinal no pod of its name holds, Terminating ones included (the controller
// never creates db-0 again while the old db-0 exists); each ordinal's claim is its own (data-db-0)
const isSts = dep => dep && dep.kind === 'StatefulSet';
function stsOrdinal(dep){ const taken = new Set(st.pods.filter(p => p.app === dep.app).map(p => p.ordinal)); let i = 0; while (taken.has(i)) i++; return i; }
function makePod(dep, ver){
  ver = ver || dep.version; const sts = isSts(dep), ord = sts ? stsOrdinal(dep) : null;
  return { id: ++st.seq, name: sts ? `${dep.name}-${ord}` : `${dep.name}-${rsHash(dep.app, ver)}-${suffix(5)}`, ordinal: ord, ns: dep.ns || 'default', app: dep.app, ver, band: false, labels: { app: dep.app, version: ver },
    node: null, slot: null, phase: 'pending', phaseT: 0, ready: false, restarts: 0, backoff: 0, alpha: 1, fire: 0, pos: null,
    containers: containersAt(dep, ver), pvc: dep.pvc ? (sts ? dep.pvc.replace(/-\d+$/, '') + '-' + ord : dep.pvc) : undefined, configMap: dep.configMap, secret: dep.secret, sys: !!dep.sys, born: st.t,
    gpu: dep.gpu || 0, gang: dep.gang ? dep.app : null, job: dep.kind === 'Job', drop: null, pass: { issued: st.t, exp: st.t + 3600 } };
}
/* ---------- volumes: a claim is bound to one PersistentVolume, attached to one node at a time (ReadWriteOnce) ----------
   The attach/detach controller attaches the volume when a pod using the claim is bound to a node and detaches it once that pod is
   gone. While the old pod exists, even Terminating on a node that cannot answer, the volume stays attached there: that is why a
   StatefulSet never creates a replacement first. The yard draws nothing for this; the shop tags the pallet. */
const pvOf = pvc => st.pvs[pvc] || (st.pvs[pvc] = { node: null, pods: 0 });
function attachPV(p){ if (!p.pvc || !p.node) return; const v = pvOf(p.pvc); if (v.node === p.node) return;
  say('attach-' + p.pvc, v.node ? `PV for ${p.pvc}: detached from ${v.node} (its pod is gone), attached to ${p.node}; the kubelet mounts it before the container starts` : `PV for ${p.pvc} attached to ${p.node} and mounted`); v.node = p.node; }
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
    if (isSts(dep)){
      // a StatefulSet: one pod at a time, in ordinal order, and only while every existing pod object is Running and Ready. A Terminating
      // pod, even one on a node that cannot confirm it stopped, blocks the next create: db-0 is never two things at once, and its
      // volume (attached to the old node) is never claimed by a second pod
      const all = stsPods(dep.app);
      const stuck = all.find(p => p.orphan);
      if (all.length < dep.replicas){ if (all.every(isReady)){ st.pods.push(makePod(dep)); say('sts-' + dep.app, `StatefulSet ${dep.name} wants ${dep.replicas}: ${dep.name}-${all.length} is Pending (ordered: one at a time, after the one before it is Ready)`); } }
      else if (stuck && !all.some(isReady)) say('stswait-' + dep.app, `StatefulSet ${dep.name}: ${stuck.name} is Terminating on a node that cannot confirm it stopped, so no replacement is created (at most one ${stuck.name}; its volume is still attached to ${stuck.node})`, 3600);
      else if (all.length > dep.replicas){ const extra = all.filter(p => p.phase !== 'terminating').sort((a, b) => b.ordinal - a.ordinal)[0]; if (extra){ terminate(extra); say('stsdown-' + dep.app, `StatefulSet ${dep.name} scaled down: ${extra.name} (the highest ordinal) terminates; its claim ${extra.pvc} stays bound`); } }
      continue; }
    const live = podsOf(dep.app), newer = live.filter(p => p.ver === dep.version), older = live.filter(p => p.ver !== dep.version);
    const readyN = live.filter(isReady).length;
    if (!older.length){
      while (podsOf(dep.app).length < dep.replicas){ st.pods.push(makePod(dep)); say('rs-' + dep.app, `ReplicaSet ${dep.name}-${rsHash(dep.app, dep.version)} wants ${dep.replicas}: a new Pod is Pending`); }
      const extra = live.length - dep.replicas;
      if (extra > 0) live.slice().sort((a, b) => b.born - a.born).slice(0, extra).forEach(p => terminate(p));
    } else {
      // rolling update with the defaults, maxSurge 25% (rounded up) and maxUnavailable 25% (rounded down): at 3 replicas that is 1 and 0,
      // one new pod up and one old down once it is Ready; at 8 it is 2 and 2, so four pods change hands at once. A paused rollout holds
      const surge = Math.max(1, Math.ceil(dep.replicas*.25)), unavail = Math.floor(dep.replicas*.25), lim = dep.replicas - unavail;
      const paused = dep.paused && newer.length >= 1;   // kubectl rollout pause: the canary stays, the old ReplicaSet keeps its pods
      let made = 0; while (!paused && live.length + made < dep.replicas + surge && newer.length + made < dep.replicas) made++;
      for (let i = 0; i < made; i++) st.pods.push(makePod(dep));
      if (made) say('roll-' + dep.app, `Rollout: new ReplicaSet ${dep.name}-${rsHash(dep.app, dep.version)} surges ${made === 1 ? 'one' : made} ${dep.version} Pod${made === 1 ? '' : 's'} (maxSurge 25% = ${surge}, maxUnavailable 25% = ${unavail} of ${dep.replicas})`);
      let down = 0; const oldest = older.slice().sort((a, b) => a.born - b.born);
      while (!paused && oldest.length && readyN - down - 1 >= lim && (newer.length + made > 0)){ terminate(oldest.shift()); down++; }
      if (down) say('rolldown-' + dep.app, `${newer.filter(isReady).length ? `${newer.filter(isReady).length} ${dep.version} Pod${newer.filter(isReady).length === 1 ? ' is' : 's are'} Ready, so` : 'Within maxUnavailable,'} ${down === 1 ? 'one old Pod is' : down + ' old Pods are'} scaled down (${readyN - down} available, at least ${lim} must stay)`);
    }
  }
  markBands(); refreshRegistry();
}
function terminate(p){ if (p.phase === 'terminating') return; if (p.phase === 'crash') p.down = true; p.phase = 'terminating'; p.phaseT = 0; p.ready = false; p.drop = null; p.alpha = 1; }
// draining: Terminating but still within its grace period, finishing the parts already inside it (a Service never sends it new ones)
const draining = p => p.phase === 'terminating' && !p.down && (p.phaseT < GRACE || p.phaseT < GRACE_MAX && st.parcels.some(pc => pc.pod === p && pc.dir === 1));
// gone for an in-flight request: removed, crashed, or past its grace period and powered down
const poweredDown = p => !st.pods.includes(p) || p.phase === 'crash' || (p.phase === 'terminating' && !draining(p));
// what a program calls at request time: web calls api, api calls db. A readiness probe checks only its own pod (the docs warn against
// probing a dependency: it turns one failure into a cascade with nothing to route to), so the pods stay Ready and the request fails
// where it really does, inside the handler, as a 5xx with the first missing Service in the chain
const depHealthy = app => { const d = depOf(app); return !d || !d.dependsOn || podsOf(d.dependsOn).some(isReady); };
function chainBreak(app){ const seen = new Set(); let a = app; while (a && !seen.has(a)){ seen.add(a); const d = depOf(a); if (!d || !d.dependsOn) return null; if (!podsOf(d.dependsOn).some(isReady)) return { caller: a, missing: d.dependsOn }; a = d.dependsOn; } return null; }
// the pods that hold a node's resources: everything bound there that has not been confirmed gone (a Terminating pod still holds them)
const holdsOn = n => st.pods.filter(p => p.node === n.name && p.phase !== 'terminating');
const gpuUsed = n => holdsOn(n).reduce((a, p) => a + (p.gpu || 0), 0);
const gpuFree = n => (n.gpus || 0) - gpuUsed(n);
const allocOn = n => holdsOn(n).reduce((a, p) => { const r = podReq(p); return { cpu: a.cpu + r.cpu, mem: a.mem + r.mem }; }, { cpu:0, mem:0 });
const nodeCpu = n => n.cpu || NODE_DEFAULT.cpu, nodeMem = n => n.mem || NODE_DEFAULT.mem;
const slotsFree = n => (isShop() ? SHOP_COLS*SHOP_MAXROWS : ROWS*COLS*9) - n.used.size;
const cellCap = () => isShop() ? SHOP_COLS*SHOP_ROWS : ROWS*COLS*3;
// the taints a node carries: cordoned, not ready, unreachable; the filter reads them like the real one (NoSchedule keeps new pods off)
const taintsOf = n => [n.cordoned ? 'node.kubernetes.io/unschedulable:NoSchedule' : null, n.unreach ? 'node.kubernetes.io/unreachable:NoExecute' : !n.ready && n.joined >= 1 ? 'node.kubernetes.io/not-ready:NoSchedule' : null].filter(Boolean);
/* the scheduler's filter: why a node cannot take this pod, or null when it can. The real plugins by name: TaintToleration, NodeResourcesFit,
   NodeUnschedulable; the bay count stands in for maxPods */
function unfit(n, p){ if (n.joined < 1 || !n.ready) return 'not Ready'; if (n.cordoned) return 'unschedulable'; if (!freeSlot(n)) return 'maxPods'; if (st.mode === 'live') return null;
  if (gpuFree(n) < (p.gpu || 0)) return 'Insufficient nvidia.com/gpu'; const r = podReq(p), a = allocOn(n);
  if (a.cpu + r.cpu > nodeCpu(n)) return 'Insufficient cpu'; if (a.mem + r.mem > nodeMem(n)) return 'Insufficient memory'; return null; }
/* the scheduler's score, higher is better: NodeResourcesFit LeastAllocated (the node with the most of its cpu and memory still free), a
   preferred anti-affinity against a node already running the same app, then the pod count as the tie-break the fewest-pods rule was */
function score(n, p){ const r = podReq(p), a = allocOn(n); const free = (1 - (a.cpu + r.cpu)/nodeCpu(n) + 1 - (a.mem + r.mem)/nodeMem(n))/2;
  const d = depOf(p.app), same = d && d.antiAffinity ? holdsOn(n).filter(q => q.app === p.app).length : 0; return free*100 - same*60 - countOn(n)*.01; }
function pickNode(p, cands){ return cands.slice().sort((a, b) => score(b, p) - score(a, p) || a.name.localeCompare(b.name))[0]; }
/* scheduler: every Pending pod gets the node that fits it and scores best, then the crane delivers it */
function schedule(){
  scheduleGangs();
  for (const p of st.pods){ if (p.phase !== 'pending' || p.gang) continue;   // system pods are scheduled like any other; hiding them only stops the drawing
    let cands = st.nodes.filter(n => !unfit(n, p));
    if (st.mode === 'live') cands = cands.filter(n => n.name === p.wantNode);
    if (!cands.length){ if (st.mode === 'demo'){ const why = {}; for (const n of st.nodes) why[unfit(n, p)] = (why[unfit(n, p)] || 0) + 1; const r = podReq(p);
        say('nosched-' + p.app, `Pending: 0/${st.nodes.length} nodes are available for ${p.name}: ${Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', ')} (it requests ${fmtCpu(r.cpu)} cpu, ${fmtMem(r.mem)}${p.gpu ? `, nvidia.com/gpu: ${p.gpu}` : ''})`, 3400); } continue; }
    const n = pickNode(p, cands), sl = freeSlot(n); placePod(p, n, sl); p.pos = null;
    if (isShop()){ p.phase = 'bound'; p.phaseT = 0; st.caps.push(mkCap(p, n)); const a = allocOn(n); say('bind', `Scheduler bound ${p.name} to ${n.name} (${cands.length} of ${st.nodes.length} fit; it scored best: ${fmtCpu(nodeCpu(n) - a.cpu)} cpu and ${fmtMem(nodeMem(n) - a.mem)} still free after it${depOf(p.app) && depOf(p.app).antiAffinity ? ', no other ' + p.app + ' there' : ''}): spec.nodeName written; the binding (the job card) is on its way to the node`); continue; }
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
    const room = st.nodes.filter(n => n.ready && !n.cordoned && n.joined >= 1).map(n => { const a = allocOn(n); return { n, slots: slotsFree(n), gpus: gpuFree(n), cpu: nodeCpu(n) - a.cpu, mem: nodeMem(n) - a.mem, count: countOn(n) }; });
    const plan = [];
    for (const p of members){ const r = podReq(p); room.sort((a, b) => (b.cpu/nodeCpu(b.n) + b.mem/nodeMem(b.n)) - (a.cpu/nodeCpu(a.n) + a.mem/nodeMem(a.n)) || a.n.name.localeCompare(b.n.name));
      const f = room.find(x => x.slots > 0 && x.gpus >= (p.gpu || 0) && x.cpu >= r.cpu && x.mem >= r.mem); if (!f) break; f.slots--; f.gpus -= p.gpu || 0; f.cpu -= r.cpu; f.mem -= r.mem; f.count++; plan.push([p, f.n]); }
    if (plan.length < members.length){ const r = podReq(members[0]); say('gang-' + app, `PodGroup ${app}: ${members.length} Pods stay Pending; the gang needs room for all ${need} at once (${fmtCpu(r.cpu)} cpu, ${fmtMem(r.mem)}${members[0].gpu ? ', a GPU' : ''} each) and only ${plan.length} fit`); continue; }
    if (isShop()){ for (const [p, n] of plan){ const sl = freeSlot(n); placePod(p, n, sl); p.pos = null; p.phase = 'dropping'; p.phaseT = 0; st.caps.push(mkCap(p, n)); }
      say('gangok-' + app, `Volcano admitted PodGroup ${app}: all ${members.length} Pods bound at once; every node pulls, and they start together`); continue; }
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
function mkCap(p, n){ return { pod: p, node: n.name, t: 0, dur: Math.max(.7, pathLen(tubePath(n))/240) }; }
function shopTick(dt){ let busy = false;
  for (const c of st.caps){ const n = st.nodes.find(n => n.name === c.node); if (n && n.cut && c.t + dt/c.dur >= cutT(n)){ c.t = cutT(n); busy = true; continue; }   // the card stops at the break until the uplink is back
    c.t += dt/c.dur; busy = true;
    if (c.t >= 1){ c.done = true; const p = c.pod; if (p.orphan) removePod(p); else if (n && (p.phase === 'bound' || p.phase === 'dropping')){ p.pos = slotPos(n, p.slot); p.phase = 'queued'; p.phaseT = 0; } } }
  st.caps = st.caps.filter(c => !c.done);
  for (const n of st.nodes){ if (!n.cache) n.cache = new Set();
    if (n.cut){ if (n.pull || st.pods.some(p => p.node === n.name && p.phase === 'queued')) busy = true; continue; }   // no uplink: the AGV cannot reach the crib and no pull starts or finishes
    // every container's image is pulled, one after another (serialised per node), each from the crib the first time and from the rack after
    if (!n.pull){ const p = st.pods.find(p => p.node === n.name && p.phase === 'pulling') || st.pods.find(p => p.node === n.name && p.phase === 'queued');
      if (p){ const img = p.containers[p.pullI || 0].image, warm = n.cache.has(img);
        if (!warm && st.lastCold != null && st.t - st.lastCold < .35){ busy = true; continue; }   // two AGVs never leave for the crib lane in the same moment
        if (!warm) st.lastCold = st.t;
        n.pull = { pod: p, image: img, t: 0, dur: warm ? PULL.warm : PULL.cold, warm }; if (p.phase === 'queued'){ p.phase = 'pulling'; p.phaseT = 0; p.pullI = 0; }
        const k = p.containers.length > 1 ? ` (${(p.pullI || 0) + 1} of ${p.containers.length} images)` : '';
        say(warm ? 'pullw' : 'pullc', warm ? `${n.name} already has ${img} in its image cache: no pull${k}` : `kubelet on ${n.name} is pulling ${img} from the registry${k} (one pull at a time per node)`); } }
    if (n.pull){ n.pull.t += dt; busy = true;
      if (n.pull.t >= n.pull.dur){ const p = n.pull.pod; n.cache.add(n.pull.image); n.pull = null;
        if (p.phase === 'pulling'){ p.pullI = (p.pullI || 0) + 1; if (p.pullI < p.containers.length){ busy = true; continue; }   // the next image of the same pod
          p.pullI = 0; p.phase = p.gang ? 'staged' : 'creating'; p.phaseT = 0;
          say(p.gang ? 'staged-' + p.gang : 'start', p.gang ? `${n.name}: images present for ${p.name}; the gang waits for every member's images` : `${n.name}: ${p.containers.length > 1 ? 'all ' + p.containers.length + ' images present' : 'image present'}, the container runtime starts ${p.containers.map(c => c.image).join(' and ')} (the Pod powers up)`); } } } }
  const groups = {}; for (const p of st.pods) if (p.gang && ['dropping', 'queued', 'pulling', 'staged'].includes(p.phase)) (groups[p.gang] = groups[p.gang] || []).push(p);
  for (const ps of Object.values(groups)) if (ps.every(p => p.phase === 'staged')){ for (const p of ps){ p.phase = 'creating'; p.phaseT = 0; } st.strobe = 1.2; say('gangstart', `PodGroup ${ps[0].gang}: every node has the image, all ${ps.length} Pods start in sync`); }
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
    case 'creating': if (!p.mounted){ p.mounted = true; attachPV(p); }   // the volume is attached and mounted before the container starts
      if (p.phaseT > (isShop() ? PULL.start : 1.1)){ p.phaseT = 0; p.phase = 'running'; p.ready = true; p.since = st.t; say('ready', `Readiness probe passed: ${p.name} is Ready${p.job ? '' : ' and a Service endpoint'}`); } return true;
    case 'running': if (p.job && p.phaseT > 9){ p.phase = 'done'; p.phaseT = 0; p.ready = false; say('done-' + p.app, `${p.app} Pods completed (Succeeded): a Job's Pods are not replaced`); }
      if (p.backoff && st.t - (p.since || 0) > BACKOFF_RESET){ p.backoff = 0; }   // ten minutes up without an exit: the kubelet forgets the back-off
      return !!p.job;
    case 'done': if (p.phaseT > 1.6) terminate(p); return true;
    // a crash: the container exits, the kubelet counts a restart and waits out its back-off before it starts the container again
    // (10 s, doubling each exit, capped at 5 minutes: CrashLoopBackOff); the first restart after a long run is immediate
    case 'crash': p.fire = p.phaseT < 1 ? 1 : 0; if (p.phaseT > .95 && !p.counted){ p.counted = true; p.restarts++; p.wait = p.backoff; p.backoff = p.backoff ? Math.min(BACKOFF_MAX, p.backoff*2) : BACKOFF_0;
        if (p.wait) say('backoff-' + p.id, `${p.name}: CrashLoopBackOff, back-off ${p.wait} s restarting failed container (the kubelet doubles it on every exit, up to ${BACKOFF_MAX/60} min; a container that runs ${BACKOFF_RESET/60} min clears it)`, 3400); }
      if (p.phaseT > 1.1 + (p.wait || 0)){ p.phase = 'running'; p.phaseT = 0; p.ready = true; p.counted = false; p.since = st.t; say('restarted', `kubelet restarted the container in place${p.wait ? ` after ${p.wait} s of back-off` : ''}: ${p.name} restarts=${p.restarts}${p.reason ? ' (last state: ' + p.reason + ')' : ''}`); p.wait = 0; } return true;
    case 'unready': if (p.nodeDown){ const n = st.nodes.find(n => n.name === p.node); if (!n || !n.ready){ p.phaseT = 0; return true; }
        if (p.phaseT > .5){ p.phase = 'running'; p.ready = true; p.phaseT = 0; p.nodeDown = false; say('nodeback-' + n.name, `${n.name} reports again: its Pods' readiness probes pass and they are back in their Services`); } return true; }
      if (p.phaseT > 4.5){ p.phase = 'running'; p.ready = true; p.phaseT = 0; say('reready', `Probe passing again: ${p.name} is back in the Service`); } return true;
    case 'terminating': { if (draining(p)){ p.alpha = 1; return true; } p.fadeT = (p.fadeT || 0) + dt; p.alpha = Math.max(0, 1 - p.fadeT / .8); if (p.alpha <= 0) removePod(p); return true; }
  }
  return false;
}

/* ---------- traffic: a request through the gate, the kiosk, to one Ready endpoint, and back ---------- */
const svcMain = () => { const ing = st.ingresses[0]; return (ing && st.services.find(s => s.name === ing.service)) || st.services[0]; };
// a Service's endpoints: the Ready pods in its namespace whose labels match every key of its selector and that listen on its port
// (an EndpointSlice is built the same way; a pod in another namespace or without the port is not one, whatever its app label says)
const podLabels = p => p.labels || { app: p.app, version: p.ver };
const servesPort = (p, port) => !port || !p.containers.some(c => c.ports && c.ports.length) || p.containers.some(c => (c.ports || []).includes(port));
function endpointsOf(svc){ if (!svc) return []; const sel = svc.selector || {}, ns = svc.namespace || 'default', port = (svc.targetPorts || svc.ports || [])[0];
  return st.pods.filter(p => isReady(p) && p.pos && p.slot && (p.ns || 'default') === ns && Object.entries(sel).every(([k, v]) => podLabels(p)[k] === v) && servesPort(p, port)).sort((a, b) => a.name.localeCompare(b.name)); }
// one Ready endpoint, the way kube-proxy picks it: iptables mode is random (a probability per rule), and Cilium's eBPF default is random too;
// only IPVS's rr scheduler, or the mesh's split, hands them out in turn
const pickEndpoint = eps => eps[Math.floor(rnd()*eps.length)];
/* a request from outside: the Ingress controller (nginx, say) is a pod at the dock that watches the EndpointSlices itself and proxies
   straight to a pod IP. It never asks the cluster's DNS (the outside client resolved shop.example.com with the public DNS) and never
   passes through the ClusterIP, so neither CoreDNS nor kube-proxy is on this path */
function request(){
  const svc = svcMain(), eps = endpointsOf(svc), ing = st.ingresses[0];
  if (!svc) return say('nosvc', 'No Service to route to');
  st.reqs.sent++;
  if (!eps.length){ st.parcels.push(makeParcel(null, svc)); st.reqs.err++; return say('503', `503 Service Unavailable from the Ingress controller: the EndpointSlice of ${svc.name} lists no Ready endpoint`); }
  const M = st.net.mesh, split = M.on && M.canary > 0 && svc.name === 'web' && eps.some(p => p.ver === 'v2') && eps.some(p => p.ver !== 'v2');
  let p; if (split){ const v2 = eps.filter(p => p.ver === 'v2'), v1 = eps.filter(p => p.ver !== 'v2'); p = (++M.n % Math.round(100/M.canary) === 0) ? v2[M.n % v2.length] : pickEndpoint(v1); } else p = pickEndpoint(eps);
  const pc = makeParcel(p, svc); if (split) pc.canary = p.ver === 'v2'; pc.fail = st.mode === 'demo' ? chainBreak(p.app) : null; st.parcels.push(pc);
  say('req', `GET ${ing ? ing.host : svc.name} -> Ingress controller (the dock; host rule -> Service ${svc.name}; it holds the EndpointSlice itself, so no DNS lookup and no ClusterIP) -> ${p.name} on ${p.node}${split ? (pc.canary ? ' (the canary: the sidecars\' 90/10 split, a VirtualService / HTTPRoute, not a Service feature)' : ' (v1, by the sidecars\' weighted split)') : ''}${pc.fail ? `; it will answer 502: ${pc.fail.caller} calls Service ${pc.fail.missing} and that has no Ready endpoints` : ''}`);
}
// the spine has two lanes when the fabric runs BGP: consecutive parts take turns (equal-cost multipath); a canary part rides the second lane so the split shows
const SPINE2 = () => LANE - 6.5;
// the fabric's geometry: a row of cells is a rack, and its top-of-rack switch is a diverter on the spine belt; one spur per row leaves
// the spine there, runs along a cross-aisle to the row's corridor, and the corridor runs along the cells' conveyor-side openings
// (rows past the third share a cross-aisle, a few units apart)
const rowCells = r => st.nodes.filter(n => n.row === r);
const rowSpur = r => { const cols = Math.min(3, Math.max(1, st.nodes.length)); return SY0 + (r % cols)*(SLW + NGAP) + SLW + 8 + 4*Math.floor(r/cols); };
const rowCorridor = r => Math.max(...rowCells(r).map(n => n.x0 + n.depth)) + 4;
const DIVERTER = r => { const cells = rowCells(r); return cells.length ? { x: LANE, y: rowSpur(r), cx: rowCorridor(r), cells } : null; };
const flick = (r, lane) => { st.net.flick[r] = { t: .55, lane }; };   // the diverter's arm swings as a part is sent down its spur
const cellEntry = n => n.y0 + SLW - 5;                                 // the y of the cell's opening on the corridor side (the gap in the fence)
// the pneumatic tube rides the fabric: up from the counter to the trusses, over to the spine, down to just above the belt, along the spine to
// the row's diverter, out the spur and along the corridor with the belts, then across the cell to the cabinet's job board. One right of way
// carries control and data: the cell's spur is where a cut uplink severs both
const TZ = 18;
const TRUNK = () => [[OFFICE[0], OFFICE[1], OFFICE[2]], [OFFICE[0], OFFICE[1], 46], [OFFICE[0], 30, 46], [LANE, 30, 46], [LANE, 30, TZ], [LANE, D - 20, TZ]];
function tubePath(n){ const d = cellDoor(n), ys = rowSpur(n.row), cx = rowCorridor(n.row); return [...TRUNK().slice(0, 5), [LANE, ys, TZ], [cx, ys, TZ], [cx, d[1], TZ], [d[0], d[1], TZ], [d[0], d[1], d[2] + 4]]; }
const FORGE = () => TRUNK().slice().reverse();                        // a forged job card's way in: up the trunk backwards, to the counter
const pathLen = pts => pts.reduce((a, p, i) => i ? a + dist3(pts[i - 1], p) : 0, 0);
const breakAt = n => ({ x: rowCorridor(n.row) - 2.5, y: cellEntry(n), ty: cellDoor(n)[1] });   // where the cell's spur is severed: just inside the corridor
const cutT = n => { const P = tubePath(n); return (pathLen(P.slice(0, 8)) + 2.5)/pathLen(P); };   // a job card's stop at the break, as a fraction of its way
function laneX(canary){ if (canary != null) return canary ? SPINE2() : LANE; return st.net.fabric === 'bgp' && isShop() ? (st.net.lane++ % 2 ? SPINE2() : LANE) : LANE; }
function makeParcel(p, svc){
  // the part passes the directory board and the sorting station without stopping: the Ingress controller already knows the pod's address
  const n = p && st.nodes.find(n => n.name === p.node), dns = false, pts = isShop() ? [[LANE, 1, 2.2], [LANE, 20, 2.2], [LANE, 30, 2.2], [LANE, 45, 2.2]] : [[LANE, 1, 2.2], [LANE, 20, 2.2], [LANE, 45, 2.2]];
  const divs = [];
  if (p && n && isShop()){ const [px, py, pz] = p.pos, x1 = n.x0 + n.depth, r = p.slot.r, gx = r >= 2 ? x1 - 3.5 : n.x0 + 17.5 + r*BAYX, yd = cellEntry(n), ys = rowSpur(n.row), cx = rowCorridor(n.row), lx = laneX(p.ver === 'v2' && st.net.mesh.on && st.net.mesh.canary ? true : null);
    // the directory board, the station, the spine lane to the row's diverter, the spur to the row's corridor, the corridor to the cell's opening, the cross-aisle after the machine's row, the machine
    if (lx !== LANE) pts.push([lx, 50, 2.2]); divs.push({ row: n.row, lane: lx, at: pts.length }); pts.push([lx, ys, 2.2], [cx, ys, 2.2], [cx, yd, 2.2], [gx, yd, 2.2], [gx, py + 5, 2.2], [px + 10.6, py + 5, 2.2]); }
  else if (p && n){ const [px, py, pz] = p.pos, yt = py + PL + 3; pts.push([LANE, yt, 2.2], [n.x0 + SLD + 3, yt, 2.2], [n.x0 + SLD, yt, SLH + 2.2], [px + PW/2, yt, SLH + 2.2], [px + PW/2, yt, pz + 2.2], [px + PW/2, py + PL + .8, pz + 2.2]); }
  const segs = []; let L = 0; for (let i = 0; i < pts.length - 1; i++){ const l = dist3(pts[i], pts[i+1]); segs.push({ a: pts[i], b: pts[i+1], s0: L, l }); L += l; }
  const dirD = -1, kioskD = -1, dp = null;   // no lookup at the board, no stop at the station: the controller proxies to the pod it chose
  for (const d of divs) d.d = segs[d.at] ? segs[d.at].s0 : L;
  return { pts, segs, L, pod: p, svc, t: 0, dir: 1, col: p ? palOf(p.app).l : LAMPC.red, hold: 0, dirD, kioskD, dhold: 0, dns: null, dnsPod: dp, divs, ingress: true };
}
// a part from one machine to another (a Pod calling a Service): out of its bay to the cross aisle, the cell's conveyor-side opening, the lane, and into the other cell
function makeLink(a, b, blocked){
  const na = st.nodes.find(n => n.name === a.node), nb = st.nodes.find(n => n.name === b.node), z = 2.2;
  const bay = (p, n) => { const [px, py] = p.pos, y1 = n.y0 + SLW, x1 = n.x0 + n.depth, r = p.slot.r; return { px, py, x1, yt: y1 + 8, yd: y1 - 5, gx: r >= 2 ? x1 - 3.5 : n.x0 + 17.5 + r*BAYX }; };
  const A = bay(a, na), B = bay(b, nb), cxA = rowCorridor(na.row), cxB = rowCorridor(nb.row), pts = [[A.px + 10.6, A.py + 5, z], [A.gx, A.py + 5, z], [A.gx, A.yd, z]], divs = [];
  // two cells in one row share a diverter: with BGP the switch forwards locally and the part stays on the row's corridor; across rows
  // (or with static routes) it goes out the spur to the diverter, along the spine on one of its lanes, and in by the other row's spur
  if (na !== nb && na.row === nb.row && st.net.fabric === 'bgp'){ pts.push([cxA, A.yd, z], [cxA, B.yd, z]); }
  else if (na !== nb){ const lx = laneX(), ysA = rowSpur(na.row), ysB = rowSpur(nb.row); pts.push([cxA, A.yd, z], [cxA, ysA, z]); divs.push({ row: na.row, lane: lx, at: pts.length }); pts.push([lx, ysA, z]);
    divs.push({ row: nb.row, lane: lx, at: pts.length }); pts.push([lx, ysB, z], [cxB, ysB, z], [cxB, B.yd, z]); }
  pts.push([B.gx, B.yd, z], [B.gx, B.py + 5, z], [B.px + 10.6, B.py + 5, z]);
  const segs = []; let L = 0; for (let i = 0; i < pts.length - 1; i++){ const l = dist3(pts[i], pts[i+1]); segs.push({ a: pts[i], b: pts[i+1], s0: L, l }); L += l; }
  for (const d of divs) d.d = segs[d.at] ? segs[d.at].s0 : L;
  const meshed = st.net.mesh.on && MESHED.has(a.app) && MESHED.has(b.app);
  // a pod calling a Service by name: its resolv.conf points at the kube-dns ClusterIP, so the lookup is the first thing that leaves the bay
  // (a UDP packet to a CoreDNS pod, through its own node's kube-proxy); with no CoreDNS up the caller waits out the timeout at its own door.
  // Then the ClusterIP is rewritten to one endpoint on the caller's own cabinet (kube-proxy, or the CNI's eBPF): there is no station to visit
  const dns = isShop(), dp = dns ? dnsPick() : null;
  return { pts, segs, L, pod: b, svc: st.services.find(s => (s.selector || {}).app === b.app) || { name: b.app }, from: a, link: true, blocked: !!blocked, stop: L - 4.5, t: 0, dir: 1, col: palOf(a.app).l, hold: 0, sleeve: meshed, kioskD: -1, dirD: dns ? segs[0].s0 + segs[0].l : -1, dhold: 0, dns: dns ? (dp ? 'ok' : 'fail') : null, dnsPod: dp, divs };
}
// where a part's path crosses a cut cell's break (the stretch along the cell's entry y at the break's x), as a distance along the path
function breakD(pc, n){ const b = breakAt(n); for (const s of pc.segs) if (Math.abs(s.a[1] - b.y) < .01 && Math.abs(s.b[1] - b.y) < .01 && (s.a[0] - b.x)*(s.b[0] - b.x) <= 0) return s.s0 + Math.abs(b.x - s.a[0]); return -1; }
function parcelAt(pc, d){ for (const s of pc.segs) if (d <= s.s0 + s.l + 1e-6) return lerp3(s.a, s.b, s.l ? (d - s.s0)/s.l : 0); return pc.pts[pc.pts.length - 1]; }
// the target is chosen when the part leaves the station (a Ready endpoint then) and re-checked every frame after: a machine that is
// draining still answers (in-flight connections finish inside the grace period); one that has powered down, crashed or been removed
// cannot, so the part turns red where the machine was and comes back as a connection reset
function parcelTick(pc, dt){
  const spd = 95, kioskD = pc.kioskD != null ? pc.kioskD : pc.link ? -1 : pc.segs[1].s0 + pc.segs[1].l, dirD = pc.dirD == null ? -1 : pc.dirD;
  if (pc.dir === 1){
    // the directory: a lookup first (the name to a ClusterIP); with CoreDNS down the part waits out the timeout and comes back with no address
    // the directory board at the dock: a glance at it first (the name to a ClusterIP); with no CoreDNS machine up the part stalls there,
    // behind any part already waiting, until one is Ready again or resolv.conf's timeout runs out and it comes back with no address
    if (dirD >= 0 && !pc.looked){ const stopAt = dirD - 4.4*(pc.qi || 0);
      if (pc.t + spd*dt >= stopAt){ pc.t = stopAt; pc.dhold += dt; if (pc.qi) return true;
        if (!pc.dnsPod) pc.dnsPod = dnsPick();
        if (pc.dnsPod){ if (!pc.asked){ pc.asked = true; pc.dns = 'ok'; pc.dhold = 0; lookup(pc); } if (pc.dhold < .3) return true; pc.looked = true; }
        else { pc.dns = 'fail'; if (pc.dhold > DNS_TIMEOUT){ pc.dir = -1; pc.col = LAMPC.red; st.reqs.err++; say('nxdomain', `${pc.from ? pc.from.name : 'the caller'}: lookup of ${pc.svc.name}.default.svc.cluster.local timed out after ${DNS_TIMEOUT} s (resolv.conf timeout:5), kube-dns has no Ready endpoints; the request never leaves the Pod. Connections already open keep working; traffic through the Ingress is untouched, its controller holds the endpoints itself`); } return true; } } }
    if (pc.t < kioskD && pc.t + spd*dt >= kioskD && pc.hold < .3){ pc.hold += dt; pc.t = kioskD; return true; }
    for (const dv of pc.divs || []) if (pc.t < dv.d && pc.t + spd*dt >= dv.d) flick(dv.row, dv.lane);   // the diverter sends it down the spur
    // a cut uplink: the belt into (or out of) that cell is severed at the corridor, so the part stops at the break and the caller times out
    { const cn = [pc.pod, pc.from].map(p => p && st.nodes.find(n => n.name === p.node)).find(n => n && n.cut), bd = cn ? breakD(pc, cn) : -1;
      if (bd >= 0 && pc.t < bd + .01 && pc.t + spd*dt >= bd){ pc.t = bd; pc.hold += dt; if (pc.hold > .9){ pc.dir = -1; pc.col = LAMPC.red; st.reqs.err++;
          say('cut-' + cn.name, `No route: ${cn.name}'s uplink is cut, so the request stops at the break in the data path (the belt) and the caller times out${cn.unreach ? '' : ' (the Service still lists the Pod: the node is not NotReady yet)'}`); } return true; } }
    // a NetworkPolicy gate: the part stops at the machine's gate, is dropped there (the CNI drops the packet; the caller times out) and comes back red
    if (pc.blocked && pc.t + spd*dt >= pc.stop){ pc.t = pc.stop; pc.hold += dt; if (pc.hold > .9){ pc.dir = -1; pc.col = LAMPC.red; st.reqs.err++; const pol = st.sec.netpol;
        say('netpol-drop', `NetworkPolicy ${pol ? pol.name : ''}: ${pc.from.app} -> ${pc.pod.app} is not allowed, so the CNI drops the packet at ${pc.pod.name}'s NetworkPolicy gate (the caller times out; the control plane is never asked)`); } return true; }
    if (pc.pod && !pc.reset && pc.t > kioskD && poweredDown(pc.pod)){ pc.reset = pc.pod.phase === 'crash' ? 'crashed' : st.pods.includes(pc.pod) ? 'powered down' : 'was removed'; }
    pc.t += spd*dt;
    if (pc.t >= pc.L){ pc.dir = -1; pc.t = pc.L;
      if (!pc.pod) pc.col = LAMPC.red;
      else if (pc.reset){ pc.col = LAMPC.red; st.reqs.err++; st.reqs.reset++; say('reset-' + pc.pod.id, `Connection reset: ${pc.pod.name} ${pc.reset} while the request was on its way; no reply (the client retries, the EndpointSlice already lists others)`); }
      // the handler ran and called the next Service in the chain: with no Ready endpoint there it answers 502, and stays Ready itself
      else if (pc.fail){ pc.col = LAMPC.red; st.reqs.err++; st.reqs.bad = (st.reqs.bad || 0) + 1; say('502-' + pc.fail.missing, `502 Bad Gateway from ${pc.pod.name}: ${pc.fail.caller} called Service ${pc.fail.missing} and its EndpointSlice is empty (connection refused). ${pc.fail.caller}'s own readiness probe still passes, so it stays an endpoint and keeps taking requests; a probe that checked ${pc.fail.missing} would empty ${pc.fail.caller}'s Service too and leave nothing to answer at all`, 4200); }
      else { pc.col = LAMPC.green; st.reqs.ok++; if (st.mode === 'demo' && !pc.link && depOf(pc.pod.app) && depOf(pc.pod.app).dependsOn && podsOf(depOf(pc.pod.app).dependsOn).some(isReady)) callNext(pc.pod); } }
    return true; }
  for (const dv of pc.divs || []) if (pc.t > dv.d && pc.t - spd*dt*1.15 <= dv.d) flick(dv.row, dv.lane);   // and merges it back on the way out
  { const cn = [pc.pod, pc.from].map(p => p && st.nodes.find(n => n.name === p.node)).find(n => n && n.cut), bd = cn ? breakD(pc, cn) : -1;
    if (bd >= 0 && !pc.cutBack && pc.t > bd && pc.t - spd*dt*1.15 <= bd){ pc.cutBack = true; if (pc.col !== LAMPC.red){ pc.col = LAMPC.red; st.reqs.err++; } } }   // a reply cannot get out either
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
  if (st.cp.ctrl){ if (!st.cp.hold){ if (st.mode === 'demo') reconcile(); schedule(); } if (!isShop() && (craneTick(dt) || st.crane.queue.length)) busy = true; }
  if (drainTick(dt)) busy = true;
  if (isShop() && shopTick(dt)) busy = true;
  for (const n of st.nodes) if (n.joining && n.joined < 1){ n.joined = Math.min(1, n.joined + dt/.9); busy = true; }   // a node joins only once its own kubeadm join has run
  for (const p of st.pods.slice()) if (podTick(p, dt)) busy = true;
  for (const n of st.nodes){ const g = n.cordoned ? 1 : 0; if (n.tape !== g){ n.tape = Math.max(0, Math.min(1, n.tape + (g - n.tape > 0 ? dt/.5 : -dt/.5))); busy = true; } }
  if (secTick(dt)) busy = true; if (netTick(dt)) busy = true;
  { let q = 0; for (const pc of st.parcels) if (pc.dir === 1 && pc.dirD >= 0 && !pc.looked && !pc.link){ pc.qi = q; if (pc.dhold > 0) q++; } }   // parts waiting at the board queue up behind each other
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
  for (const n of st.nodes){ n.used = new Set(); n.joined = 0; n.joining = false; n.ready = false; n.cordoned = false; n.tape = 0; n.cache = new Set(); n.pull = null; n.cut = false; n.unreach = false; n.evicted = false; n.cutT = 0; }
  st.cp = { etcd:0, api:0, ctrl:0, hold:0, members:0 }; st.pvs = {}; st.crane.z = 1; st.crane.x = (XR0 + XR1)/2; st.crane.y = D/2; refreshRegistry();
  Object.assign(st.sec, { ca: 0, badges: 0, refuse: [], refuseT: 0, forged: [], inspect: 0, stamp: 0, queue: [] }); for (const n of st.nodes){ n.cert = null; n.csr = false; }
  // the office is a stacked control plane of three: kubeadm init on the first, kubeadm join --control-plane on two more, so the ledger's
  // Raft group really has three members and the elections in the control room have something to elect
  const V = VOC(); const ev = [
    [.2, () => say('b0', V.b0)],
    [1.4, () => { st.sec.ca = 1; st.sec.badges = 3; st.sec.stamp = 1.5; say('bca', V.bca); }],   // the CA first: nothing below can talk to anything without its certificate
    [2.8, () => { st.cp.etcd = 1; st.cp.members = 1; say('b1', V.b1); }],
    [4.2, () => { st.cp.api = 1; say('b2', V.b2); }],
    [5.6, () => { st.cp.ctrl = 1; say('b3', V.b3); }],
    [7.2, () => { st.cp.members = 2; say('bcp2', 'kubeadm join --control-plane cp-2 (with the certificate key): the second office node runs its own etcd, API server, scheduler and controller manager; etcd-2 joins the Raft group as a learner, then a voter (2 members: both needed for quorum)', 3600); }],
    [8.9, () => { st.cp.members = 3; say('bcp3', 'kubeadm join --control-plane cp-3: etcd-3 joins; etcd (the ledger) is a group of three, quorum 2, and can lose one member. Three API servers sit behind the control-plane endpoint; one scheduler and one controller manager hold the leader Lease', 3600); }] ];
  st.nodes.forEach((n, i) => { ev.push([10.8 + i*1.7, () => { n.joining = true; n.csr = true; say('bj' + i, V.bj(n.name)); }]);
    ev.push([10.8 + i*1.7 + 1.1, () => { issueCert(n); n.ready = true; say('br' + i, V.br(n.name)); }]); });
  const tEnd = 10.8 + st.nodes.length*1.7 + .8;
  ev.push([tEnd, () => { st.deploys = JSON.parse(JSON.stringify(DEMO.deployments)).map(d => ({ ...d, ns:'default', kind: d.kind || 'Deployment' })); refreshRegistry(); say('bapp', V.bapp); }]);
  ev.push([tEnd + .3, () => { st.boot = null; }]);
  st.boot = { t: 0, i: 0, ev }; run();
}
function bootTick(dt){ const b = st.boot; b.t += dt; while (b.i < b.ev.length && b.t >= b.ev[b.i][0]) b.ev[b.i++][1]();
  if (st.cp.ctrl && st.crane.z < HZT && !st.crane.job) st.crane.z = Math.min(HZT, st.crane.z + dt*42);
  return !!st.boot; }

/* ---------- snapshots: the demo, a kubectl JSON file, or a polled URL ---------- */
// Kubernetes quantities: cpu to millicores, memory to MiB
const qCpu = q => q == null ? undefined : /m$/.test(q) ? +String(q).slice(0, -1) : Math.round(+q*1000);
const qMem = q => { if (q == null) return undefined; const m = /^(\d+(?:\.\d+)?)([KMGTPE]i?)?$/.exec(String(q)); if (!m) return undefined; const u = { K:1e3, M:1e6, G:1e9, T:1e12, Ki:1024, Mi:1024**2, Gi:1024**3, Ti:1024**4 }[m[2] || ''] || 1; return Math.round(+m[1]*u/1024**2); };
const resOf = c => { const r = (c.resources || {}).requests || {}, l = (c.resources || {}).limits || {}, o = {};
  if (r.cpu != null || r.memory != null) o.req = { cpu: qCpu(r.cpu) || 0, mem: qMem(r.memory) || 0 }; if (l.cpu != null || l.memory != null) o.lim = { cpu: qCpu(l.cpu), mem: qMem(l.memory) }; return o; };
function normalize(raw){
  if (raw && Array.isArray(raw.nodes) && !raw.items) return raw;
  const items = raw && raw.items ? raw.items : Array.isArray(raw) ? raw : [];
  const out = { context: raw.context || 'cluster', nodes: [], pods: [], deployments: [], services: [], ingresses: [] }; let tunnel = false, cpPods = false;
  const lab = (o, k) => o.metadata && o.metadata.labels ? o.metadata.labels[k] : undefined;
  const appOf = o => { const m = o.metadata || {}, l = m.labels || {}; if (l.app) return l.app; if (l['app.kubernetes.io/name']) return l['app.kubernetes.io/name']; if (l['k8s-app']) return l['k8s-app'];
    const own = (m.ownerReferences || [])[0]; if (own && own.kind === 'ReplicaSet') return own.name.replace(/-[a-z0-9]{6,10}$/, ''); if (own) return own.name; return (m.name || 'pod').replace(/(-[a-z0-9]{5,10}){1,2}$/, ''); };
  for (const o of items){ const m = o.metadata || {}, sp = o.spec || {}, stt = o.status || {};
    if (o.kind === 'Node'){ const al = stt.allocatable || {}; out.nodes.push({ name: m.name, ready: (stt.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'), cordoned: !!sp.unschedulable, gpus: +(al['nvidia.com/gpu'] || 0), cpu: qCpu(al.cpu), mem: qMem(al.memory) }); }
    else if (o.kind === 'Pod'){ const cs = stt.containerStatuses || [], own = (m.ownerReferences || [])[0];
      const vols = sp.volumes || [], img = ((sp.containers || [])[0] || {}).image || '';
      const gpuOf = c => +(((c.resources || {}).limits || {})['nvidia.com/gpu'] || ((c.resources || {}).requests || {})['nvidia.com/gpu'] || 0);
      out.pods.push({ name: m.name, namespace: m.namespace, node: sp.nodeName || null, app: appOf(o), phase: stt.phase, gpu: (sp.containers || []).reduce((a, c) => a + gpuOf(c), 0), labels: m.labels,
        ready: cs.length > 0 && cs.every(c => c.ready), restarts: cs.reduce((a, c) => a + (c.restartCount || 0), 0),
        containers: (sp.containers || []).map(c => ({ name: c.name, image: c.image, ports: (c.ports || []).map(x => x.containerPort), ...resOf(c) })),
        version: lab(o, 'version') || lab(o, 'app.kubernetes.io/version') || (own && own.kind === 'ReplicaSet' ? own.name.slice(-5) : (img.split(':')[1] || 'v1')),
        pvc: (vols.find(v => v.persistentVolumeClaim) || {}).name, configMap: (vols.find(v => v.configMap) || {}).name, secret: (vols.find(v => v.secret) || {}).name,
        system: m.namespace === 'kube-system' || (own && own.kind === 'DaemonSet') }); }
    if (o.kind === 'DaemonSet' && /konnectivity-agent|cloud-provider|cloud-controller/.test(m.name || '')) tunnel = true;
    if (o.kind === 'Pod' && /^(kube-apiserver|etcd|kube-controller-manager|kube-scheduler)-/.test(m.name || '')) cpPods = true;
    if (o.kind === 'Deployment' || o.kind === 'StatefulSet' || o.kind === 'DaemonSet'){ const sel = (sp.selector && sp.selector.matchLabels) || {};
      const tpl = (sp.template && sp.template.spec) || {}, img = ((tpl.containers || [])[0] || {}).image || '';
      out.deployments.push({ name: m.name, namespace: m.namespace, kind: o.kind, app: sel.app || sel['app.kubernetes.io/name'] || sel['k8s-app'] || m.name, replicas: sp.replicas != null ? sp.replicas : (stt.desiredNumberScheduled || 0),
        ready: stt.readyReplicas || stt.numberReady || 0, version: img.split(':')[1] || 'v1', containers: (tpl.containers || []).map(c => ({ name: c.name, image: c.image, ports: (c.ports || []).map(x => x.containerPort), ...resOf(c) })), system: m.namespace === 'kube-system' || o.kind === 'DaemonSet',
        antiAffinity: tpl.affinity && tpl.affinity.podAntiAffinity ? (tpl.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution ? 'required' : 'preferred') : undefined }); }
    else if (o.kind === 'PodDisruptionBudget'){ const sel = (sp.selector && sp.selector.matchLabels) || {}; out.pdbs = out.pdbs || []; out.pdbs.push({ name: m.name, namespace: m.namespace, app: sel.app || sel['app.kubernetes.io/name'] || sel['k8s-app'], minAvailable: sp.minAvailable, maxUnavailable: sp.maxUnavailable }); }
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
    st.nodes = (data.nodes || []).map(n => Object.assign(old.get(n.name) || { used: new Set(), tape: 0, joined: 1, joining: true, cache: new Set(), pull: null }, { name: n.name, ready: n.ready !== false, cordoned: !!n.cordoned, gpus: n.gpus || 0, cpu: n.cpu, mem: n.mem }));
    for (const p of st.pods){ if (!st.nodes.find(n => n.name === p.node)){ p.node = null; p.slot = null; p.pos = null; p.phase = 'pending'; } }
    for (const n of st.nodes){ n.used = new Set(); for (const p of st.pods) if (p.node === n.name && p.slot) n.used.add(slotKey(p.slot)); }
    layout(st); }
  else for (const n of st.nodes){ const d = data.nodes.find(x => x.name === n.name); n.ready = d.ready !== false; n.cordoned = !!d.cordoned; n.gpus = d.gpus || 0; n.cpu = d.cpu; n.mem = d.mem; if (instant) n.tape = n.cordoned ? 1 : 0; }
  st.deploys = (data.deployments || []).map(d => ({ name: d.name, ns: d.namespace || 'default', app: d.app || d.name, kind: d.kind || 'Deployment', replicas: d.replicas || 0, ready: d.ready, version: d.version || 'v1', containers: d.containers, tags: d.tags, pvc: d.pvc, configMap: d.configMap, secret: d.secret, sys: !!d.system, dependsOn: d.dependsOn, gpu: d.gpu || 0, gang: !!d.gang, minMember: d.minMember, antiAffinity: d.antiAffinity, pdb: d.pdb }));
  // PodDisruptionBudgets: the demo's ride on their workloads; a kubectl List carries its own
  for (const b of (data.pdbs || [])){ const d = st.deploys.find(x => x.app === b.app && (x.ns || 'default') === (b.namespace || 'default')); if (d) d.pdb = { name: b.name, minAvailable: b.minAvailable, maxUnavailable: b.maxUnavailable }; }
  st.services = data.services || []; st.ingresses = data.ingresses || [];
  if (st.mode === 'demo' && !(data.pods || []).length){ /* the demo builds its pods from the deployments */ }
  else {
    const seen = new Set();
    for (const d of (data.pods || [])){ seen.add(d.name); let p = st.pods.find(p => p.name === d.name);
      const dep = st.deploys.find(x => x.app === d.app) || { name: d.app, app: d.app, version: d.version, containers: d.containers };
      if (!p){ p = makePod(dep, d.version || 'v1'); p.name = d.name; p.ns = d.namespace || 'default'; p.containers = d.containers && d.containers.length ? d.containers : p.containers; p.pvc = d.pvc; p.configMap = d.configMap; p.secret = d.secret; p.sys = !!d.system; p.gpu = d.gpu || 0; if (d.labels) p.labels = d.labels; st.pods.push(p); }
      p.wantNode = d.node; p.restarts = d.restarts || 0;
      const want = d.phase === 'Running' ? (d.ready ? 'running' : 'unready') : d.phase === 'Pending' ? 'pending' : d.phase === 'Failed' || d.phase === 'CrashLoopBackOff' ? 'crash' : d.phase === 'Succeeded' ? 'terminating' : 'running';
      if (p.node && p.node !== d.node){ removeFromNode(p); }
      if (!p.node && d.node){ const n = st.nodes.find(n => n.name === d.node); const sl = n && freeSlot(n);
        if (n && sl && (instant || p.sys && !st.showSys)){ placePod(p, n, sl); p.phase = want === 'pending' ? 'creating' : want; p.ready = want === 'running'; if (n.cache) for (const c of p.containers) n.cache.add(c.image); }
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
  st.pvs = {}; st.cp.members = 3;
  for (const app of order){ const dep = depOf(app); if (!dep) continue; for (let r = 0; r < dep.replicas; r++){ const p = makePod(dep); st.pods.push(p); const n = st.nodes[i++ % st.nodes.length]; placePod(p, n, freeSlot(n)); p.phase = 'running'; p.ready = true; p.since = st.t; p.mounted = true; if (p.pvc) pvOf(p.pvc).node = n.name; for (const c of p.containers) n.cache.add(c.image); } }
  markBands(); refreshRegistry(); layout(st); st.crane.x = (XR0 + XR1)/2; st.crane.y = D/2; st.crane.z = HZT; if (ui) reframe();
  Object.assign(st.sec, { ca: 1, badges: 3, netpol: null, refuse: [], refuseT: 0, forged: [], inspect: 0, stamp: 0, queue: [] }); st.reqs = { sent:0, ok:0, err:0, reset:0 };
  st.nodes.forEach((n, i) => { n.cert = { issued: st.t - 7 - i*60, exp: st.t - 7 - i*60 + ROT, ok: true, flash: 0 }; n.csr = false; n.rotated = 0; }); st.sec.badges = 3 + st.nodes.length;
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
function rollout(app, ver){ const d = depOf(app); if (!d) return; const c = (d.containers || [])[0] || { name: app }, img = imageAt(d, c, ver);
  if (st.mode === 'live') return liveNote(`kubectl set image deploy/${app} ${c.name}=${img}`); if (d.version === ver) return; d.version = ver;
  const surge = Math.max(1, Math.ceil(d.replicas*.25)), unavail = Math.floor(d.replicas*.25);
  say('rollout', `kubectl set image ${isSts(d) ? 'sts' : 'deploy'}/${d.name} ${c.name}=${img}: a new pod template, so a new ReplicaSet ${d.name}-${rsHash(app, ver)}; RollingUpdate with the defaults, maxSurge 25% (${surge} of ${d.replicas}) and maxUnavailable 25% (${unavail})`, 3400); run(); }
function applyTrain(){ if (st.mode === 'live') return liveNote('kubectl apply -f train.yaml'); if (depOf('train')) return say('train', 'train is already applied');
  st.deploys.push({ name:'train', ns:'default', app:'train', kind:'Deployment', replicas:3, version:'v1', containers:[{ name:'trainer', image:'pytorch:2.4-cuda', req:{ cpu:2000, mem:4096 }, lim:{ cpu:2000, mem:4096 } }], gpu:1 });
  say('apply', 'kubectl apply -f train.yaml: 3 replicas, each requests 2 cpu, 4Gi and nvidia.com/gpu: 1; only node-c has GPUs (2)'); run(); }
function applySpark(){ if (st.mode === 'live') return liveNote('kubectl apply -f spark-podgroup.yaml'); if (depOf('spark')) return say('spark', 'spark is already applied');
  st.deploys.push({ name:'spark', ns:'default', app:'spark', kind:'Job', replicas:4, version:'v1', containers:[{ name:'executor', image:'spark:3.5', req:{ cpu:1000, mem:2048 }, lim:{ cpu:2000, mem:4096 } }], gang:true, minMember:4 });
  say('apply', 'kubectl apply -f spark-podgroup.yaml: Job spark with schedulerName: volcano, PodGroup minMember 4; each executor requests 1 cpu, 2Gi'); run(); }
function applyCache(){ if (st.mode === 'live') return liveNote('kubectl apply -f cache.yaml'); if (depOf('cache')) return say('cache', 'cache is already applied');
  st.deploys.push({ name:'cache', ns:'default', app:'cache', kind:'Deployment', replicas:2, version:'v1', containers:[{ name:'redis', image:'redis:7', ports:[6379], req:{ cpu:2000, mem:2048 }, lim:{ cpu:2000, mem:4096 } }] });
  say('apply', 'kubectl apply -f cache.yaml: Deployment cache created, ReplicaSet wants 2 (each requests 2 cpu, 2Gi)'); run(); }
function deleteDep(app){ if (st.mode === 'live') return liveNote(`kubectl delete deploy/${app}`); if (!depOf(app)) return say('nodep', `${app} is not deployed`); st.deploys = st.deploys.filter(d => d.app !== app); say('del', `kubectl delete deploy/${app}: its ReplicaSet and Pods go with it`); run(); }
function pickPod(app){ const c = st.pods.filter(p => p.app === app && isReady(p) && p.pos); return c.length ? c[Math.floor(rnd()*c.length)] : null; }
// kubectl delete pod: a deletionTimestamp, nothing more. The pod leaves its EndpointSlices at once, its owner creates the replacement at
// once, and the kubelet sends SIGTERM and waits terminationGracePeriodSeconds (30 s; GRACE here) before SIGKILL: no fire, a drain
function deletePod(app = 'web', pod){ if (st.mode === 'live') return liveNote('kubectl delete pod <name>'); const p = pod || pickPod(app); if (!p) return say('nopod', `No Ready ${app} Pod to delete right now`);
  const d = depOf(p.app); p.doomed = true; terminate(p);
  say('delpod', `kubectl delete pod ${p.name}: deletionTimestamp set, so it leaves Service ${p.app}'s endpoints now and ${isSts(d) ? `StatefulSet ${d.name} recreates ${p.name} once this one is gone (same name, same claim ${p.pvc})` : `its ReplicaSet creates a replacement now, while it drains`}; the kubelet sends SIGTERM and gives it ${GRACE} s (terminationGracePeriodSeconds 30 in real life) to finish its in-flight requests before SIGKILL`, 3800); run(); }
// a crash: the container exits (kill 1), or the kernel kills it for passing its memory limit (OOMKilled, exit 137)
function crashPod(pod, reason){ if (st.mode === 'live') return liveNote(reason === 'OOMKilled' ? '(a process that allocates past the container\'s memory limit: the cgroup OOM killer ends it, exit 137)' : 'kubectl exec <pod> -- kill 1'); const p = pod || pickPod('api') || pickPod('web'); if (!p) return say('nopod', 'No Ready Pod to crash right now');
  if (p.phase === 'crash') return say('crashing', `${p.name} is already down: ${p.wait ? 'CrashLoopBackOff, ' + p.wait + ' s' : 'restarting'}`);
  const c = p.containers[0], lim = c.lim && c.lim.mem; p.reason = reason || 'Error (exit 1)'; p.phase = 'crash'; p.phaseT = 0; p.fire = 1; p.ready = false;
  say(reason === 'OOMKilled' ? 'oom' : 'crash', reason === 'OOMKilled' ? `OOMKilled: ${c.name} in ${p.name} passed its memory limit${lim ? ` (${fmtMem(lim)})` : ''} and the kernel's OOM killer ended it (exit 137); the kubelet restarts it in place with the same limit (restartPolicy Always), after any back-off` : `Crash: ${p.name} container exited; the kubelet restarts it in place (the Pod keeps its name and node)${p.backoff ? ', after a back-off of ' + p.backoff + ' s' : ''}`); run(); }
function unreadyPod(pod){ if (st.mode === 'live') return liveNote('(make a readiness probe fail: e.g. stop the health endpoint)'); const p = pod || pickPod('web'); if (!p) return say('nopod', 'No Ready web Pod right now');
  p.phase = 'unready'; p.phaseT = 0; p.ready = false; say('unready', `Probe: ${p.name} readiness failing, so the Service stops sending it traffic (the Pod is not restarted)`); run(); }
/* kubectl drain: cordon, then one Eviction per pod through the API. An eviction is refused (429) while it would break a
   PodDisruptionBudget, and drain retries it every few seconds until the owner has a replacement Ready elsewhere; pods without a
   budget go at once. Nothing is moved: each pod is deleted and its owner makes a new one wherever the scheduler says.
   BGP has nothing to say about it: the node is up, its speaker keeps announcing its PodCIDR, the routes stay */
const DRAIN_RETRY = 5;
function pdbOf(app){ const d = depOf(app); return d && d.pdb ? d.pdb : null; }
// may this pod be disrupted now: the budget's minAvailable (or replicas - maxUnavailable) must still hold after it goes
function pdbAllows(p){ const b = pdbOf(p.app), d = depOf(p.app); if (!b || !d) return true; const ready = podsOf(p.app).filter(isReady).length;
  const minA = b.minAvailable != null ? +b.minAvailable : d.replicas - +b.maxUnavailable; return ready - (isReady(p) ? 1 : 0) >= minA; }
function drain(n){ if (st.mode === 'live') return liveNote(`kubectl drain ${n.name} --ignore-daemonsets`); if (n.drain) return say('draining', `${n.name} is already draining`);
  n.cordoned = true; const left = st.pods.filter(p => p.node === n.name && p.phase !== 'terminating'); n.drain = { left, t: 0, refused: new Set() };
  const budgets = [...new Set(left.map(p => p.app))].filter(pdbOf).map(a => `${pdbOf(a).name} (${a})`);
  say('drain', `kubectl drain ${n.name}: cordoned (node.kubernetes.io/unschedulable:NoSchedule), then an Eviction for each of its ${left.length} Pod${left.length === 1 ? '' : 's'}${budgets.length ? '; ' + budgets.join(', ') + ' decides how many may be down at once, the rest are evicted now' : ''}`, 3600); run(); }
function drainTick(dt){ let busy = false;
  for (const n of st.nodes){ const D = n.drain; if (!D) continue; busy = true; D.t += dt;
    D.left = D.left.filter(p => st.pods.includes(p) && p.phase !== 'terminating');
    if (!D.left.length){ n.drain = null; say('drained', `${n.name} drained: every pod is evicted, each replaced by its owner on another node; the node is still cordoned (kubectl uncordon to take pods again)`, 3200); continue; }
    if (D.t < DRAIN_RETRY && D.tried) continue;   // drain retries the refused evictions every few seconds
    D.t = 0; D.tried = true;
    for (const p of D.left.slice()){ if (pdbAllows(p)){ terminate(p); if (D.refused.has(p.id)) say('evictok-' + p.id, `Eviction of ${p.name} allowed now: a replacement is Ready, so the budget holds without it`); }
      else { const b = pdbOf(p.app); if (!D.refused.has(p.id)) say('evictno-' + p.app, `Eviction of ${p.name} refused (429 Too Many Requests): PodDisruptionBudget ${b.name} ${b.minAvailable != null ? 'needs ' + b.minAvailable + ' available' : 'allows ' + b.maxUnavailable + ' unavailable'} and ${p.app} is at its limit until a replacement is Ready; kubectl drain retries every ${DRAIN_RETRY} s`, 3600); D.refused.add(p.id); } } }
  return busy; }
function uncordon(n){ if (st.mode === 'live') return liveNote(`kubectl uncordon ${n.name}`); n.cordoned = false; if (n.drain){ n.drain = null; say('drainstop', `${n.name}: drain abandoned, the remaining pods stay`); } say('uncordon', `kubectl uncordon ${n.name}: the unschedulable taint is gone, the scheduler may bind here again (nothing moves back on its own)`); run(); }
function podInfo(p){ const d = depOf(p.app); say('info-' + p.id, `${p.name} · ${p.node || 'Pending'} · ${p.phase === 'running' ? (p.ready ? 'Running, Ready' : 'Running') : p.phase} · ${p.containers.length} container${p.containers.length === 1 ? '' : 's'} · restarts ${p.restarts}${p.pvc ? ' · volume ' + p.pvc : ''}${d && d.kind === 'StatefulSet' ? ' · StatefulSet' : ''}`, 3000); }


/* ---------- security: the CA and its badges, the kubelet's certificate rotation, admission refusals, NetworkPolicy ----------
   kubeadm makes the cluster CA before anything else; every control-plane component and every kubelet holds a certificate it
   signed, and all of them talk mutual TLS. A kubelet gets its first certificate through a CSR (approved for the bootstrap
   token's group, signed by the controller manager's signer) and rotates it at about 80% of its lifetime the same way. */
// a badge's lifetime is staggered by cell, so no two rotate together
function issueCert(n){ const k = Math.max(0, st.nodes.indexOf(n)); n.cert = { issued: st.t, exp: st.t + ROT - 45*k, ok: true, flash: .9 }; n.csr = false; n.certDown = null; st.sec.badges++; }
function secTick(dt){ let busy = false; const S = st.sec;
  if (S.stamp > 0){ S.stamp -= dt; busy = true; }
  if (S.refuseT > 0){ S.refuseT -= dt; busy = true; }
  if (S.inspect > 0){ S.inspect -= dt; busy = true; }
  for (const f of S.forged){ f.t += dt/f.dur; busy = true; if (f.t >= 1 && !f.done){ f.done = true; S.refuseT = 1.6; S.refuse.push({ kind: 'authn', t: st.t });
    say('401', '401 Unauthorized: the request carries no client certificate this CA signed and no valid token, so the API server rejects it before reading it (the forged card is refused at the counter); nothing is written and nothing is scheduled'); } }
  S.forged = S.forged.filter(f => !f.done || f.t < 1.3);
  for (const [t, fn] of S.queue.slice()) if (st.t >= t){ S.queue.splice(S.queue.indexOf(S.queue.find(q => q[1] === fn)), 1); fn(); }
  if (S.queue.length) busy = true;
  for (const n of st.nodes){ const c = n.cert; if (!c) continue;
    if (c.flash > 0){ c.flash = Math.max(0, c.flash - dt); busy = true; }
    // a cell with its uplink cut cannot reach the CA: no rotation; if the badge's expiry passes meanwhile it goes red, and the cell needs the CA again once reconnected
    if (n.cut){ if (c.ok && st.t > c.exp){ c.ok = false; n.certCut = true; busy = true; say('certcut', `${n.name}'s kubelet certificate expired while its uplink was cut: it could not send the CSR to rotate it (its badge goes red); once reconnected the node needs a new certificate from the CA before it can report`, 4200); } continue; }
    if (c.ok && st.t > c.exp - ROT*.2){ c.issued = st.t; c.exp = st.t + ROT; c.flash = .9; n.rotated = (n.rotated || 0) + 1; st.sec.badges++; busy = true;
      if (!rotToasted){ rotToasted = true; say('rot', `${n.name}: the kubelet rotated its client certificate before it expired (a new CSR, approved and signed by the CA; the badge flashes). kubeadm issues kubelet certificates for a year and the kubelet renews them at 70-90% of their lifetime; here a certificate lasts ${ROT/60} simulated minutes and rotates at 80%. Later rotations only flash it; the node's card shows the expiry`, 5200); } }   // the toast once per session; the flash every time
    // an expired badge: every status update and Lease renewal is a 401, so to the node lifecycle controller the node has simply gone quiet;
    // it waits the same node-monitor-grace-period as for a cut cable, then marks it NotReady. Nothing heals this on its own
    if (!c.ok){ n.certDown = (n.certDown || 0) + dt; busy = true;
      if (n.certDown > NODE_GRACE && n.ready){ n.ready = false; for (const p of st.pods) if (p.node === n.name && (p.phase === 'running' || p.phase === 'unready')){ p.phase = 'unready'; p.phaseT = 0; p.ready = false; p.nodeDown = true; }
        say('certdown', `${n.name} is NotReady: its kubelet certificate expired ${NODE_GRACE} s ago and every status update since was refused (401), so no Lease was renewed for node-monitor-grace-period. Its Pods leave their Services and the scheduler binds nothing to it. It stays so until someone acts: kubeadm certs renew, or Break ▸ re-join ${n.name}`, 5200); } } }
  return busy; }
// the fix for an expired kubelet certificate is a person: a fresh bootstrap token and kubeadm join (or kubeadm certs renew on the node)
function rejoinNode(name = 'node-b'){ if (st.mode === 'live') return liveNote('kubeadm token create --print-join-command; on the node: kubeadm reset && kubeadm join ...'); const n = st.nodes.find(n => n.name === name); if (!n) return;
  if (n.cut) return say('cutstill', `${n.name}'s uplink is still cut: nothing it sends reaches the API server`); if (n.cert && n.cert.ok && n.ready) return say('nojoin', `${n.name} is Ready with a valid kubelet certificate; nothing to re-join`);
  n.csr = true; issueCert(n); n.certDown = 0; n.certCut = false; n.ready = true; st.sec.queue.push([st.t + .5, () => { for (const p of st.pods) if (p.node === n.name && p.nodeDown){ p.phaseT = 0; } }]);
  say('rejoin', `kubeadm join on ${n.name} again, with a fresh bootstrap token: a new CSR is approved and signed by the CA, the kubelet reports with its new certificate (the badge), the node is Ready and its Pods are endpoints again`, 4200); run(); }
function forgeCard(){ if (st.mode === 'live') return liveNote('(send the API server a request with no credentials: curl -k https://<api>:6443/api/v1/pods)'); if (!st.cp.api) return say('noapi', 'The API server is not up yet: nothing to refuse');
  st.sec.forged.push({ t: 0, dur: 2.4 }); say('forge', 'A forged request heads for the API server (a grey capsule up the tube): no client certificate, no token (kubectl with a made-up kubeconfig)'); run(); }
function expireBadge(name = 'node-b'){ if (st.mode === 'live') return liveNote('kubeadm certs check-expiration   # on the node: openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates');
  const n = st.nodes.find(n => n.name === name) || st.nodes[1] || st.nodes[0]; if (!n || !n.cert) return say('nocert', `${name} has no kubelet certificate yet`); if (!n.cert.ok) return say('certalready', `${n.name}'s kubelet certificate is already expired`);
  n.cert.ok = false; n.cert.exp = st.t; n.certDown = 0; say('expire', `${n.name}'s kubelet client certificate expires now (its badge goes red): the next status update it sends will be refused`); run(); }
function applyPrivileged(){ if (st.mode === 'live') return liveNote('kubectl apply -f privileged.yaml   # refused by Pod Security Admission in a restricted namespace'); if (!st.cp.api) return say('noapi', 'The API server is not up yet');
  st.sec.inspect = 1.8; st.sec.refuseT = 1.6; st.sec.refuse.push({ kind: 'psa', t: st.t });
  say('psa', 'kubectl apply -f privileged.yaml: Pod Security Admission (the inspector) refuses it because this namespace is labelled pod-security.kubernetes.io/enforce=restricted, so privileged: true is a 403 and nothing is written. Without that label (Kubernetes The Hard Way labels none and runs --allow-privileged=true) the same Pod passes'); run(); }
// kubectl logs: a read, not a write; the counter checks the badge and RBAC, then calls the cabinet itself, over TLS the other way
function podLogs(p){ if (st.mode === 'live') return liveNote(`kubectl logs ${p.name}`); if (!p.node) return say('nologs', `${p.name} has no node yet: no kubelet to ask`);
  say('logs-' + p.id, `kubectl logs ${p.name}: the API server checks the client certificate and RBAC (pods/log), then calls ${p.node}'s kubelet on :10250 with its own kubelet-client certificate; the kubelet asks the API server whether this caller may read logs (SubjectAccessReview) before it answers`, 3200);
  if (window.ControlRoom && ControlRoom.logs) ControlRoom.logs(p); run(); }
function applyNetpol(quiet){ if (st.mode === 'live') return liveNote('kubectl apply -f netpol-db.yaml'); if (st.sec.netpol) return say('netpol', 'The NetworkPolicy is already in force');
  st.sec.netpol = { name: 'db-from-api', to: 'db', from: ['api'] }; if (quiet) return;
  say('netpol', 'kubectl apply -f netpol-db.yaml: NetworkPolicy db-from-api selects the db Pods and allows ingress on 5432 from api only; the CNI drops every other connection into them (the gates close)');
  st.sec.queue.push([st.t + 1.1, () => linkRequest('web', 'db')], [st.t + 2.6, () => linkRequest('api', 'db')]); run(); }
function removeNetpol(){ if (st.mode === 'live') return liveNote('kubectl delete networkpolicy db-from-api'); if (!st.sec.netpol) return say('nonetpol', 'No NetworkPolicy to remove');
  st.sec.netpol = null; say('netpoldel', 'kubectl delete networkpolicy db-from-api: with no policy selecting them the db Pods accept any connection again (the gates open; the default is allow-all)'); run(); }
// a part from one machine to another: web calling db, api calling db
function linkRequest(fromApp, toApp, from){ const a = from || pickPod(fromApp), svc = st.services.find(s => s.name === toApp), eps = svc ? endpointsOf(svc) : st.pods.filter(p => p.app === toApp && isReady(p) && p.pos), b = eps.length ? pickEndpoint(eps) : null;
  if (!a || !b) return say('nolink', `No Ready ${!a ? fromApp : toApp} Pod right now`);
  const pol = st.sec.netpol, blocked = !!(pol && pol.to === toApp && !pol.from.includes(fromApp)); st.reqs.sent++; const pc = makeLink(a, b, blocked); st.parcels.push(pc);
  const headless = svc && svc.clusterIP === 'None', sw = st.net.svc === 'ebpf' ? 'the CNI\'s eBPF program' : 'kube-proxy\'s iptables';
  say('link-' + fromApp, `${a.name} -> ${pc.dnsPod ? `lookup ${toApp}.default.svc at kube-dns (UDP, answered by ${pc.dnsPod.name})` : `lookup ${toApp}.default.svc: kube-dns has no endpoint, the caller waits ${DNS_TIMEOUT} s`} -> ${headless ? `the pod addresses themselves (headless), it picks ${b.name}` : `ClusterIP, rewritten on ${a.node} itself by ${sw} to one Ready endpoint at random: ${b.name}`}${blocked ? ' (the policy will drop it at the gate)' : pol && pol.to === toApp ? ' (allowed by the policy)' : ''}`, 3400); run(); }
// a handler that answered a part now calls the next Service in its chain (web calls api, api calls db), as a part of its own
function callNext(a){ const d = depOf(a.app); if (!d || !d.dependsOn) return; linkRequest(a.app, d.dependsOn, a); }
// a slow heartbeat so the badges age while the floor is idle (the loop only runs while something moves); it follows the Clock and never draws a frame of its own
setInterval(() => { if (!ui || loopOn || SPEED <= 0 || st.mode !== 'demo' || !st.sec.ca) return; st.t += SPEED; if (secTick(SPEED)) run(); else if (document.querySelector('.card.open')) ui.render(); }, 1000);

/* ---------- networking: the fabric, the directory, the mesh, a managed control plane ----------
   The fabric is the floor's conveyor network drawn as a small Clos: a diverter per row of cells (the top-of-rack switch, where
   the row's spur leaves the spine) and the spine itself, two belts of equal cost (equal-cost multipath). With static routes (Kubernetes The Hard Way) each host knows
   the other cells' ranges by hand; with BGP every cabinet announces its own PodCIDR to its diverter and withdraws it when the
   cell is drained. The directory is a board at the dock (the kube-dns Service) kept current by two CoreDNS pods in the cells;
   every pod's resolv.conf points at kube-dns's ClusterIP, and a lookup is data plane: a UDP part to that address through kube-proxy.
   The mesh adds a sidecar escort to each meshed machine, its own CA and a weighted split the Service never had. */
const MESHED = new Set(['web', 'api']);
// a route lives as long as the BGP session: a cordon or a drain changes nothing on the diverter (the node is up, its speaker still
// peers, DaemonSet pods still need the route); a cut uplink drops the session (BFD in milliseconds, the hold timer in 90 s without it)
// and the diverter withdraws the PodCIDR; the session comes back with the cable
function announce(n, withdraw){ if (st.net.fabric !== 'bgp' || !isShop()) return; st.net.ann.push({ node: n.name, t: 0, dur: 1.4, withdraw: !!withdraw }); say('bgp-' + n.name, withdraw ? `${n.name}: the BGP session to its top-of-rack switch (the diverter) drops (BFD notices in milliseconds; the hold timer would take 90 s), so the switch withdraws 10.200.${st.nodes.indexOf(n)}.0/24: the line greys on its route strip and nothing is sent that way` : `${n.name}: the BGP session is back, its speaker announces 10.200.${st.nodes.indexOf(n)}.0/24 again; its line is back on the top-of-rack switch's route strip`); run(); }
function setFabric(f, quiet){ if (st.net.fabric === f) return quiet ? 0 : say('fabric', `The fabric already runs ${f === 'bgp' ? 'BGP' : 'static routes'}`); st.net.fabric = f;
  if (f === 'bgp'){ for (const n of st.nodes) if (n.joined >= 1 && !n.cut) st.net.ann.push({ node: n.name, t: 0, dur: 1.4, withdraw: false }); }
  if (!quiet) say('fabric', f === 'bgp' ? 'Fabric: BGP. Every node runs a BGP speaker (Cilium or Calico) that announces its PodCIDR to the row\'s top-of-rack switch (the diverter); the switches share what they learn over the spine, whose two equal-cost paths (the belts) carry traffic in turn (ECMP)' : 'Fabric: static routes, the Hard Way: every node carries a route to each other node\'s range, written by hand; the top-of-rack switch\'s route strip is painted on, one path, no announcements');
  run(); }
function setSvcMode(m, quiet){ if (st.net.svc === m) return quiet ? 0 : say('svcmode', 'Already set'); st.net.svc = m;
  if (!quiet) say('svcmode', m === 'ebpf' ? 'Service addressing: eBPF. The CNI (Cilium) replaces kube-proxy: a Service address is rewritten at the socket or the packet by programs loaded into the kernel, no iptables chains; DigitalOcean Kubernetes ships this way' : 'Service addressing: kube-proxy in iptables mode writes a chain per Service that rewrites the ClusterIP to one Ready endpoint'); run(); }
// CoreDNS is pods in cells: the board at the dock is only the kube-dns Service; one Ready CoreDNS machine answers each lookup, round robin
const isDnsPod = p => p.app === 'coredns' || p.app === 'kube-dns';
const dnsPods = () => st.pods.filter(p => isDnsPod(p) && isReady(p) && p.pos);
function dnsPick(){ const ps = dnsPods(); if (!ps.length) return null; return ps[st.net.dns.n++ % ps.length]; }
const dnsUp = () => dnsPods().length > 0;
const dnsIP = () => { const s = st.services.find(s => s.name === 'kube-dns'); return (s && s.clusterIP) || '10.96.0.10'; };
const DNS_TIMEOUT = 5;                                   // resolv.conf's timeout: how long a part waits at the board before it gives up
// what the directory board says: a Service's name to its ClusterIP (and where that goes), a headless Service to its pods' own addresses
const svcIP = s => s.clusterIP === 'None' ? null : s.clusterIP || (s.name === 'web' ? '10.96.0.12' : `10.96.0.${20 + s.name.length}`);
const podIP = p => `10.200.${Math.max(0, st.nodes.findIndex(n => n.name === p.node))}.${10 + (p.id % 200)}`;
function boardLines(){ const main = svcMain(); return st.services.filter(s => s.name !== 'kube-dns').slice(0, 6).map(s => { const ip = svcIP(s), ns = s.namespace || 'default';
  if (!ip){ const ps = endpointsOf(s); return { svc: s.name, text: `${s.name}.${ns}.svc -> ${ps.length ? ps.slice(0, 2).map(podIP).join(', ') + (ps.length > 2 ? ', …' : '') : 'no Ready pod'} (headless)` }; }
  return { svc: s.name, text: `${s.name}.${ns}.svc -> ${ip} -> ${s === main ? 'station' : 'kube-proxy'}` }; }); }
// a part consults the board: the matching line lights and one Ready CoreDNS machine sends the board an update tick (it keeps the board current)
function lookup(pc){ st.net.hops.push({ pod: pc.dnsPod, t: 0, dur: .35 }); st.net.dns.hl = pc.svc.name; st.net.dns.hlT = .5; st.net.dns.flash = .3; }
function stopDns(){ if (st.mode === 'live') return liveNote('kubectl -n kube-system delete pod -l k8s-app=kube-dns'); const ps = st.pods.filter(p => isDnsPod(p) && p.phase !== 'terminating' && p.phase !== 'crash'); if (!ps.length) return say('dnsdown', 'No CoreDNS Pod is up to stop');
  for (const p of ps){ p.phase = 'crash'; p.phaseT = .4; p.fire = 1; p.ready = false; p.doomed = true; p.down = true; st.sec.queue.push([st.t + .7, () => terminate(p)]); }   // on the simulation clock, like everything else
  say('dnsstop', `kubectl -n kube-system delete pod -l k8s-app=kube-dns: both CoreDNS Pods go down, kube-dns has no endpoints and its board (the directory) goes blank. A Pod calling another Service by name now waits ${DNS_TIMEOUT} s and gives up; open connections do not notice, and traffic through the Ingress is untouched (the Ingress controller holds the endpoints itself). The kube-system Deployment is already creating replacement Pods, one per node by its anti-affinity`, 5200); run(); }
function applyMesh(quiet){ if (st.mode === 'live') return liveNote('istioctl install / linkerd install, then label the namespace for injection'); const M = st.net.mesh; if (M.on) return quiet ? 0 : say('mesh', 'The mesh is already installed'); M.on = true;
  if (!quiet) say('mesh', 'kubectl label ns default istio-injection=enabled, then a rollout restart: every web and api Pod gets a sidecar proxy (the escort); the mesh control plane, istiod (the mesh desk), issues each one a certificate from the mesh\'s own CA, and requests between them are mutual TLS (the sealed sleeve) that the cluster CA knows nothing about'); run(); }
function applyCanary(pct, quiet){ if (st.mode === 'live') return liveNote('kubectl apply -f virtualservice-web.yaml   # weight 90 / 10'); if (!st.net.mesh.on) applyMesh(true); const M = st.net.mesh, d = depOf('web'); if (!d) return;
  M.canary = pct; M.n = 0; if (d.version !== 'v2'){ d.version = 'v2'; } d.paused = true;
  if (!quiet) say('canary', `kubectl set image deploy/web ... v2 && kubectl rollout pause deploy/web, then a VirtualService (or an HTTPRoute) with weights 90 / 10: one v2 Pod comes up and stays, and the sidecar proxies send one request in ten to it. The Service itself would round-robin all of them equally; this split lives in the mesh`); run(); }
function removeMesh(){ if (st.mode === 'live') return liveNote('istioctl uninstall --purge'); const M = st.net.mesh, d = depOf('web'); if (!M.on && !M.canary) return say('nomesh', 'No mesh to remove'); M.on = false; M.canary = 0;
  if (d && d.paused){ d.paused = false; say('meshoff', 'Mesh removed: the sidecar proxies (the escorts) go, the Service is back to its plain endpoint choice, and kubectl rollout resume deploy/web lets the paused rollout finish to v2'); } else say('meshoff', 'Mesh removed: the sidecar proxies (the escorts) go, requests travel in the clear again and the Service is back to its plain endpoint choice'); run(); }
function setManaged(on, quiet){ if (st.net.managed === !!on) return; st.net.managed = !!on; OFFICE[0] = on ? -22 : 20;
  if (!quiet) say('managed', on ? 'Managed control plane: the control plane (the office) moves into the provider\'s building behind the fence. The nodes reach the API server the ordinary way, over the network to its public endpoint (every kubelet, every watch, every kubectl). What cannot cross the fence is the other direction: the API server calling a kubelet for logs, exec or a webhook. For that each node runs a konnectivity agent that dials out to the provider and keeps a tunnel open; the API server\'s calls ride back through it. The provider owns the control plane, you own the nodes' : 'The control plane is yours again (the office is back on the mezzanine), no tunnel needed');
  if (ui) reframe(); run(); }
// a node's uplink: with it cut the kubelet cannot renew its Lease; the node lifecycle controller marks the node NotReady after
// node-monitor-grace-period, and the taint manager evicts its pods after the unreachable toleration (the real defaults, on the clock)
const NODE_LEASE = 10, NODE_GRACE = 40, NODE_TOLERATION = 300;
function cutUplink(name = 'node-b'){ if (st.mode === 'live') return liveNote('(on the node: ip link set eth0 down, or pull the cable; then kubectl get nodes -w)'); const n = st.nodes.find(n => n.name === name) || st.nodes[1] || st.nodes[0]; if (!n || n.joined < 1) return say('nocut', `${name} has not joined yet`); if (n.cut) return say('cutalready', `${n.name}'s uplink is already cut`);
  n.cut = true; n.cutT = 0; n.unreach = false; n.evicted = false; announce(n, true);
  say('cut', `${n.name}'s uplink is cut: the data path (the belt) and the control path (the tube) into it are severed. Its kubelet can no longer renew its Lease (it tries every ${NODE_LEASE} s, node-status-update-frequency) and nothing reaches the node; the node lifecycle controller waits node-monitor-grace-period (${NODE_GRACE} s) before it marks the node NotReady. Requests and Pod bindings for ${n.name} stop at the break`, 5200); run(); }
function restoreUplink(name = 'node-b'){ const n = st.nodes.find(n => n.name === name); if (!n || !n.cut) return say('nocut2', `${name}'s uplink is not cut`); n.cut = false;
  const mine = st.pods.filter(p => p.node === n.name && p.phase !== 'terminating'), sts = mine.filter(p => p.orphan && isSts(depOf(p.app)));
  if (n.evicted){ for (const p of mine){ p.unknown = false; p.down = true; p.orphan = false; terminate(p); } n.unreach = false; n.evicted = false; n.ready = true;
    say('restore', `${n.name}'s uplink is back: the kubelet reports in, sees the deletionTimestamps on its Pods and stops their containers; the API finally removes the objects. The Deployments' replacements have been running elsewhere since the eviction${sts.length ? `; only now does the StatefulSet create ${sts.map(p => p.name).join(', ')} again, with its volume detached from here first` : ''}`, 5200); }
  else if (n.unreach){ for (const p of mine){ if (p.unknown){ p.unknown = false; p.ready = !!p.wasReady; } } n.unreach = false; n.ready = true;
    say('restore', `${n.name}'s uplink is back before the toleration ran out: the kubelet renews its Lease, the node is Ready again and its Pods rejoin their Services; nothing moved`, 4200); }
  else say('restore', `${n.name}'s uplink is back within the grace period: the Lease is renewed and the controller never noticed; the requests and bindings waiting at the break go on`, 3600);
  if (n.certCut){ n.certCut = false; n.certDown = NODE_GRACE + 1; n.ready = false; for (const p of st.pods) if (p.node === n.name && (p.phase === 'running' || p.phase === 'unready')){ p.phase = 'unready'; p.phaseT = 0; p.ready = false; p.nodeDown = true; }
    say('certcut2', `${n.name} is reconnected, but its kubelet certificate expired while it was cut off: every report it sends is refused (401), so it stays NotReady until someone runs kubeadm certs renew on it, or Break ▸ re-join ${n.name}`, 4600); }
  announce(n, false); run(); }
function uplinkTick(dt){ let busy = false;
  for (const n of st.nodes){ if (!n.cut) continue; n.cutT += dt; busy = true;
    if (!n.unreach && n.cutT >= NODE_GRACE){ n.unreach = true; n.ready = false; for (const p of st.pods) if (p.node === n.name && (p.phase === 'running' || p.phase === 'unready')){ p.unknown = true; p.wasReady = p.ready; p.ready = false; }
      say('unreach', `${n.name} is NotReady: no Lease renewal for ${NODE_GRACE} s (node-monitor-grace-period). Its Pods' status is Unknown and they leave their Services; the node gets the taint node.kubernetes.io/unreachable:NoExecute, which its pods tolerate for ${NODE_TOLERATION} s (tolerationSeconds) before they are evicted`, 5200); }
    if (n.unreach && !n.evicted && n.cutT >= NODE_GRACE + NODE_TOLERATION){ n.evicted = true; const mine = st.pods.filter(p => p.node === n.name && p.phase !== 'terminating'); for (const p of mine){ p.orphan = true; p.ready = false; }
      const sts = mine.filter(p => isSts(depOf(p.app)));
      say('evict', `${NODE_TOLERATION} s up: the taint manager deletes ${n.name}'s ${mine.length} pods, but a kubelet that cannot be reached cannot confirm, so they only get a deletionTimestamp and sit Terminating. The ReplicaSets count them as gone and create replacement Pods now${sts.length ? `; StatefulSet ${sts.map(p => p.app).join(', ')} does not: ${sts.map(p => p.name).join(', ')} stays Terminating, its volume attached to ${n.name}, and no second copy is made (force-delete it and you choose the split brain yourself)` : ''}. The node keeps the containers running, orphaned, until its uplink returns`, 6200); } }
  return busy; }
function netTick(dt){ let busy = false; const N = st.net; if (uplinkTick(dt)) busy = true;
  for (const a of N.ann){ a.t += dt/a.dur; busy = true; } N.ann = N.ann.filter(a => a.t < 1.25);
  for (const k of Object.keys(N.flick)){ N.flick[k].t -= dt; if (N.flick[k].t <= 0) delete N.flick[k]; else busy = true; }
  for (const h of N.hops){ h.t += dt/h.dur; busy = true; } N.hops = N.hops.filter(h => h.t < 1); if (N.dns.flash > 0){ N.dns.flash -= dt; busy = true; }
  if (N.dns.hlT > 0){ N.dns.hlT -= dt; busy = true; if (N.dns.hlT <= 0) N.dns.hl = null; }
  // a Service (or a headless Service's pods) changed: one CoreDNS machine updates the board
  if (isShop()){ const bk = boardLines().map(l => l.text).join('|'); if (bk !== N.dns.key){ const first = !N.dns.key, dp = dnsPick(); N.dns.key = bk; if (dp && !first){ N.hops.push({ pod: dp, t: 0, dur: .35 }); N.dns.flash = .3; } } }
  const up = dnsUp(); if (up && N.dns.wasDown){ N.dns.wasDown = false; say('dnsback', 'A replacement CoreDNS Pod is Ready: kube-dns has an endpoint again (its board lights up) and the Pods waiting on a lookup get their answer'); } if (!up && !N.dns.wasDown && st.pods.some(isDnsPod)) N.dns.wasDown = true;
  return busy; }
