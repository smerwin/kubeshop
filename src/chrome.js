/* ============================================================
   The page around the three.js yard: the action buttons (a column of popovers on a page, a thumb-height toolbar
   with bottom sheets in yard mode), the switches, the colour swatches, the stats strip, the card that opens for
   whatever was tapped (a pod, a node, the tower, the kiosk, the gate, the registry, a Deployments row) with the
   actions that make sense there, the chapter sheet (?chapter=id pulls that chapter's prose out of the guide), and
   the yard-mode toggle. It talks to the yard through window.yard (camera flights, framing, follow) and to the
   simulation through its globals (st, depOf, scaleTo, ...).
   ============================================================ */
window.Chrome = (() => {
const html = document.documentElement, $ = s => document.querySelector(s), esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const Q = new URLSearchParams(location.search);
const GUIDE = /\/figure\//.test(location.pathname) ? '../guide.html' : 'guide.html';   // the guide sits beside the root figure, one level up from figure/
let yard = null;
const isYard = () => html.classList.contains('yard');
const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} };
const noteErr = m => { html.dataset.errors = (html.dataset.errors || '') + ' ' + m + ';'; };
const starts = (s, t) => String(s).trim().toLowerCase().startsWith(t.trim().toLowerCase());

/* ---------- the actions: one list for the page popovers and the yard-mode sheets ---------- */
const BUTTONS = [
  { label:'Bootstrap', onClick: () => bootstrap() },
  { label:'Apply', choices: () => [
    { label:'cache x2 (new app)', current: !!depOf('cache') && st.mode === 'demo', onClick: () => applyCache() },
    { label:'delete cache', disabled: !depOf('cache'), why:'cache is not deployed', onClick: () => deleteDep('cache') },
    { label:'train x3 (1 GPU each)', current: !!depOf('train') && st.mode === 'demo', onClick: () => applyTrain() },
    { label:'delete train', disabled: !depOf('train'), why:'train is not deployed', onClick: () => deleteDep('train') },
    { label:'spark x4 (gang, Volcano)', current: !!depOf('spark') && st.mode === 'demo', onClick: () => applySpark() },
    { label:'delete spark', disabled: !depOf('spark'), why:'spark is not deployed', onClick: () => deleteDep('spark') },
    ...(SHOP() ? [ { label:'NetworkPolicy: db accepts only api', current: !!st.sec.netpol && st.mode === 'demo', onClick: () => applyNetpol() },
      { label:'remove the policy', disabled: !st.sec.netpol, why:'no NetworkPolicy in force', onClick: () => removeNetpol() } ] : []),
    { label:'reset the demo', onClick: () => { startDemo(); say('reset', 'Demo cluster reset: web x3, api x2, db x1'); } } ] },
  { label:'Scale web', short:'Scale', choices: () => scaleChoices('web') },
  { label:'Roll out', choices: () => { const w = depOf('web'), a = depOf('api'); return [
    { label:'web v2 (rolling)', current: !!w && w.version === 'v2', onClick: () => rollout('web', 'v2') },
    { label:'web back to v1', current: !!w && w.version === 'v1', onClick: () => rollout('web', 'v1') },
    { label:'api v2', current: !!a && a.version === 'v2', onClick: () => rollout('api', 'v2') } ]; } },
  { label:'Break', choices: () => [
    { label:'delete a web pod', onClick: () => deletePod() },
    { label:'delete the db pod', onClick: () => deletePod('db') },
    { label:'crash a container', onClick: () => crashPod() },
    { label:'fail a readiness probe', onClick: () => unreadyPod() },
    ...(SHOP() ? [ { label:'forge a job card', onClick: () => forgeCard() }, { label:"let node-b's badge expire", onClick: () => expireBadge('node-b') }, { label:'apply a privileged pod', onClick: () => applyPrivileged() } ] : []),
    { label:'stop an etcd follower', onClick: () => window.ControlRoom && ControlRoom.stopFollower() },
    { label:'stop the etcd leader', onClick: () => window.ControlRoom && ControlRoom.stopLeader() } ] },
  { label:'Drain', choices: () => st.nodes.map(n => ({ label: n.cordoned ? `uncordon ${n.name}` : `drain ${n.name}`, onClick: () => n.cordoned ? uncordon(n) : drain(n) })) },
  { label:'Send a request', short:'Request', onClick: () => { request(); run(); } },
  { label:'Cluster', choices: () => [
    { label: SHOP() ? 'the demo floor' : 'the demo yard', current: st.mode === 'demo', onClick: () => { startDemo(); say('demo', 'Back to the demo cluster'); } },
    { label:'open a kubectl JSON file', onClick: () => loadFile() },
    { label:'watch localhost:8788', current: st.live.url === 'http://localhost:8788/cluster.json', onClick: () => watchUrl('http://localhost:8788/cluster.json', 5) },
    { label: st.showSys ? 'hide system pods' : 'show system pods', onClick: () => { st.showSys = !st.showSys; for (const p of st.pods) if (p.sys && !st.showSys && p.node){ removeFromNode(p); p.phase = 'pending'; } run(); } } ] } ];
const scaleChoices = app => [1, 2, 3, 5, 8].map(n => ({ label:`${n} replica${n === 1 ? '' : 's'}`, current: st.mode === 'demo' && !!depOf(app) && depOf(app).replicas === n, onClick: () => scaleTo(app, n) }));
const btns = document.getElementById('btns');
const closeChips = () => document.querySelectorAll('.stepwrap.open').forEach(w => w.classList.remove('open'));
function buildButtons(){
  for (const b of BUTTONS){ const wrap = document.createElement('div'); wrap.className = 'stepwrap'; const el = document.createElement('button'); el.className = 'act'; el.dataset.label = b.label;
    el.innerHTML = `<span class="long">${b.label}</span><span class="short">${b.short || b.label}</span>${b.choices ? '<span class="car">▾</span>' : ''}`; wrap.appendChild(el); btns.appendChild(wrap);
    if (!b.choices){ el.onclick = () => { closeChips(); hideCard(); b.onClick(); yard.invalidate(); }; continue; }
    const chips = document.createElement('div'); chips.className = 'chips'; wrap.appendChild(chips);
    el.onclick = e => { e.stopPropagation(); const open = !wrap.classList.contains('open'); closeChips(); if (isYard()){ openSheet(b.label, b.choices()); return; } if (!open) return; chips.innerHTML = '';
      for (const c of b.choices()){ const ch = document.createElement('button'); ch.className = 'chip' + (c.current ? ' current' : c.disabled ? ' off' : ''); ch.textContent = c.label; if (c.current) ch.setAttribute('aria-pressed', 'true');
        ch.onclick = ev => { ev.stopPropagation(); closeChips(); choose(c); }; chips.appendChild(ch); }
      wrap.classList.add('open'); }; }
  document.addEventListener('click', closeChips);
}
function choose(c){ if (c.current) return ui.flash(`${c.label} — already set`); if (c.disabled) return ui.flash(c.why || `${c.label} isn't possible right now`); c.onClick(); yard.invalidate(); }
// testing: ?press=Label@ms,Label>Choice@ms presses the buttons after load; unknown labels are recorded on <html data-errors>
function press(label, choice){ const b = [...btns.querySelectorAll('.act')].find(b => starts(b.dataset.label, label)); if (!b) return noteErr(`no button "${label}"`); b.click(); if (choice == null) return;
  const pool = isYard() ? [...sheet.querySelectorAll('.items button')] : [...b.parentElement.querySelectorAll('.chip')]; const c = pool.find(c => starts(c.textContent, choice));
  if (c && !c.classList.contains('off')) c.click(); else noteErr(`no choice "${choice}" in "${label}"`); }

/* ---------- sheets: action choices, the chapter's prose, the control room (yard mode) ---------- */
const scrim = $('#scrim'), sheet = $('#sheet'), chap = $('#chap'), chapb = $('#chapb');
function openSheet(title, items){ hideCard(); sheet.querySelector('h3').textContent = title; const box = sheet.querySelector('.items'); box.innerHTML = '';
  for (const c of items){ const b = document.createElement('button'); b.className = c.current ? 'current' : c.disabled ? 'off' : '';
    b.innerHTML = `<span>${esc(c.label)}</span>${c.sub ? `<small>${esc(c.sub)}</small>` : c.current ? '<small>current</small>' : c.disabled && c.why ? `<small>${esc(c.why)}</small>` : ''}`;
    b.onclick = () => { if (c.current || c.disabled) return choose(c); closeSheets(); choose(c); }; box.appendChild(b); }
  chap.classList.remove('open'); sheet.classList.add('open'); scrim.classList.add('open'); }
function closeSheets(){ sheet.classList.remove('open'); chap.classList.remove('open'); if (isYard() && html.classList.contains('room')) setRoom(false); scrim.classList.remove('open'); }
scrim.onclick = closeSheets;
chap.querySelector('.x').onclick = closeSheets;
function openChapter(){ sheet.classList.remove('open'); chap.classList.add('open'); scrim.classList.add('open'); }
chapb.onclick = () => chap.classList.contains('open') ? closeSheets() : openChapter();
// the chapter's prose comes out of the guide itself, so there is one text to keep right
async function loadChapter(id){ try {
  const r = await fetch(GUIDE, { cache: 'force-cache' }); if (!r.ok) return; const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const sec = doc.getElementById(id); if (!sec) return; const col = sec.querySelector(':scope > div'); if (!col) return;
  chap.querySelector('.prose').innerHTML = col.innerHTML + `<a class="more" href="${GUIDE}#${encodeURIComponent(id)}">Back to the guide ↗</a>`; chapb.hidden = false; } catch {} }
// a camera intent per chapter: frame the thing the chapter is about, or follow the operation it presses
const CHAPTER = {
  boot: { follow: 1 }, apply: { follow: 1 }, scale: { follow: 1 }, rollout: { follow: 1 }, heal: { follow: 1 }, probes: { follow: 1 }, gang: { follow: 1 }, traffic: { follow: 1 }, security: { follow: 1 },
  pods: { frame: () => { const p = st.pods.find(p => p.pos && p.configMap) || st.pods.find(p => p.pos); return p && { type:'pod', id: p.id }; } },
  nodes: { frame: () => st.nodes[0] && { type:'node', node: st.nodes[0].name } },
  control: { frame: () => ({ type:'tower' }) },
  gpu: { frame: () => { const n = st.nodes.find(n => n.gpus); return n && { type:'node', node: n.name }; } },
  drain: { frame: () => ({ type:'node', node: 'node-a' }), follow: 1 } };
function applyChapter(id, camParams){ const c = CHAPTER[id]; if (!c) return;
  if (c.frame && !camParams){ const a = c.frame(); if (a) yard.frameAct(a, { fill: .42, ms: 800 }); }
  if (c.follow) yard.follow(true); }

/* ---------- the card: what was tapped, with the actions that make sense there ---------- */
const card = $('#card'); let cardAct = null, cardHtml = '';
card.querySelector('.x').onclick = hideCard;
function hideCard(){ card.classList.remove('open'); cardAct = null; html.style.setProperty('--cardh', '0px'); yard && yard.select(null); }
function open(a){ cardAct = a; cardHtml = ''; renderCard(); card.classList.add('open'); yard.select(a);
  html.style.setProperty('--cardh', isYard() ? (card.offsetHeight + 8) + 'px' : '0px');   // the toast sits above the card in full screen
  if (a.type !== 'explain') yard.frameAct(a, { below: cardFrac() }); }
function cardFrac(){ if (!isYard()) return .2; const r = card.getBoundingClientRect(); return Math.max(.1, Math.min(.6, (innerHeight - r.top)/innerHeight)); }
const LAMP = c => `<span class="lamp" style="background:${c}"></span>`;
const SHOP = () => st.model === 'shop';
// the two drafts name their parts differently; the Kubernetes objects behind them are the same
const T = () => SHOP() ? { node: 'Work cell', tower: 'Planning office', kiosk: 'Sorting station', gate: 'Receiving dock', registry: 'Tool crib', crane: 'Dispatcher', board: 'Order board', runs: 'kubelet cabinet, runtime drive, kube-proxy switch', pullNote: 'The cell\'s AGV fetches images from the crib; what it has fetched before sits on its rack.', kick: 'On the floor', inflight: 'parts on the conveyor now', boot: 'empty the floor and bring it up in order' }
  : { node: 'Node', tower: 'Harbour tower', kiosk: 'Kiosk', gate: 'the gate', registry: 'Registry shelf', crane: 'Gantry crane', board: 'Deployments board', runs: 'kubelet, container runtime, kube-proxy', pullNote: 'The kubelet pulls from here before a container can start.', kick: 'In the yard', inflight: 'requests in the yard now', boot: 'empty the yard and bring it up in order' };
const phaseText = p => p.phase === 'pending' ? 'Pending' : p.phase === 'scheduled' ? 'Bound, waiting for the crane' : p.phase === 'bound' ? 'Bound: the job card is in the tube to the cell' : p.phase === 'queued' ? 'Bound, waiting for the cell\'s image pull' : p.phase === 'pulling' ? 'ContainerCreating: the cell is pulling the image' : p.phase === 'staged' ? 'Image ready, waiting for the rest of the gang'
  : p.phase === 'creating' ? (SHOP() ? 'ContainerCreating: the machine is powering up' : 'ContainerCreating (pulling the image)') : p.phase === 'dropping' ? (SHOP() ? 'Bound as a gang, job cards in the tube' : 'Bound as a gang, landing')
  : p.phase === 'running' ? (p.ready ? 'Running, Ready' : 'Running') : p.phase === 'unready' ? `Running, not Ready${p.nodeDown ? ' (its node is NotReady)' : p.waitingOn ? ' (Service ' + p.waitingOn + ' has no endpoints)' : ' (probe failing)'}` : p.phase === 'crash' ? 'Crashed, the kubelet is restarting it' : p.phase === 'terminating' ? (draining(p) ? 'Terminating: draining, finishing in-flight requests (grace period)' : 'Terminating: powered down') : p.phase === 'done' ? 'Succeeded' : p.phase;
const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
const gatesText = (n, mine) => { const pol = st.sec.netpol; if (!pol) return 'all open: no NetworkPolicy selects anything here'; const k = mine.filter(p => p.app === pol.to).length;
  return k ? `${k} ${pol.to} machine${k > 1 ? 's' : ''} gated: ingress from ${pol.from.join(', ')} only (${pol.name})` : `open: ${pol.name} selects ${pol.to} machines and none are in this cell`; };
const EXPLAIN = {
  'CONTAINER': 'One crate per container. The containers of a pod always land together on one node and share its network namespace and volumes.',
  'POD NETWORK': 'The pod\'s one IP and port space: the socket on the back wall, wired by the node\'s trunk to kube-proxy.',
  'CONFIGMAP': 'Configuration mounted in from a ConfigMap, so the same image runs in every environment.',
  'SECRET': 'A Secret mounted in: credentials kept out of the image and out of the pod spec.',
  'VOLUME (PV)': 'A PersistentVolume bound through a claim: storage that outlives any container in the pod.',
  'VOLUME': 'A PersistentVolume bound through a claim: storage that outlives any container in the pod.',
  'KUBELET': 'The node agent. It watches for pods bound here, asks the runtime to pull and start them, runs the probes and reports status back.',
  'RUNTIME': 'The container runtime (containerd, CRI-O): pulls images and starts containers when the kubelet asks over the CRI.',
  'KUBE-PROXY': 'Programs the node\'s networking so a Service address reaches one of its Ready pods.',
  'ETCD': 'The cabinet of record: every object the cluster knows, kept by a Raft group of usually three members.',
  'API SERVER': 'The one door: authenticates, authorises, admits and validates every request, then writes it to etcd and fans the change out to watchers.',
  'CONTROLLERS': 'Loops that each watch one kind of object and nudge the world toward what it says: Deployments make ReplicaSets, ReplicaSets make Pods.',
  'ENDPOINTS': 'The Ready pods behind the Service right now, kept in EndpointSlices and wired into every node by kube-proxy.',
  'SCHEDULER': 'Picks a node for every Pending pod: filter out the nodes that cannot take it, score the rest, bind by writing spec.nodeName. It never starts anything.',
  'NODE': 'A machine with room for a number of pods, a kubelet and kube-proxy.',
  'CAPACITY': 'How much of the node\'s room is allocated. The scheduler only binds a pod where its requests fit.',
  'POD': 'The unit Kubernetes schedules: one or more containers placed and moved as one thing.',
  'READY LAMP': 'Green: the readiness probe passes and the pod is a Service endpoint. Amber: not yet or not now. Red: crashed.',
  'GPU': 'An extended resource (nvidia.com/gpu) advertised by a device plugin. A GPU request is all-or-nothing per device.',
  'CONTROL': 'The control plane: etcd, the API server, the scheduler and the controller manager.',
  'DEPLOYMENTS': 'The desired counts and versions. The yard is reconciled to the board, never the other way round.',
  'REGISTRY': 'Where images come from: the kubelet pulls from here before a container can start.',
  'SERVICE': 'A stable name and virtual IP that forwards to whichever pods match its selector and are Ready.',
  'INGRESS': 'The HTTP front door: hostnames and paths routed to Services.',
  'GATE': 'The way traffic enters the yard from outside.',
  'CELL': 'A Node: a fenced work cell with room for a number of machines, its own controller cabinet (the kubelet) and switch (kube-proxy).',
  'OFFICE': 'The control plane: the counter (API server), the ledger (etcd), the dispatcher (scheduler) and the order board (the controllers).',
  'MACHINE': 'A Pod: a machine running a program. Everything inside it (its program cartridges, data port, pallet) is placed and moved as one thing.',
  'PROGRAM': 'A container: a program cartridge slotted into the machine. Sidecars are smaller cartridges in the same machine, sharing its data port and pallet.',
  'DATA PORT': 'The pod\'s one IP and port space, patched to the cell\'s kube-proxy switch.',
  'SETUP SHEET': 'A ConfigMap clipped to the machine: configuration mounted in, so the same image runs in every environment.',
  'PALLET': 'A PersistentVolume bound through a claim: the fixture pallet with the part on it outlives any program.',
  'CABINET': 'The kubelet: the cell\'s controller. It watches for job cards bound here, has the runtime pull and start the programs, runs the probes and reports status.',
  'DRIVE': 'The container runtime (containerd, CRI-O): the drive unit the kubelet tells, over the CRI, to pull an image and start a container.',
  'SWITCH': 'kube-proxy: the cell\'s network switch, patched so a Service address reaches a Ready machine.',
  'RACK': 'The node\'s image cache: crates of every image this cell has pulled before. A second pull of the same image is instant.',
  'AGV': 'The pull: the cell\'s own robot fetches an image crate from the crib, one trip at a time per cell (serialised image pulls).',
  'JOB BOARD': 'Where the cell\'s bound job cards arrive from the tube: the kubelet\'s watch on Pods with its nodeName.',
  'TUBE': 'The watch stream made physical: every write the API server commits is blown to every cell that watches for it.',
  'LEDGER': 'etcd: the cabinet of record in the office, three drawers for the three Raft members.',
  'COUNTER': 'The API server: the one counter every request goes through, checked and written to the ledger.',
  'DISPATCHER': 'The scheduler: for each job card without a cell, filter the cells that cannot take it, score the rest, write the cell\'s name on the card.',
  'ORDER BOARD': 'The controllers: the orders on the wall (web x3 rev1) that the floor is kept matching to.',
  'CRIB': 'The image registry: the caged store the cells fetch crates (images) from.',
  'PRESS': 'A GPU: an extended resource only this cell advertises. A job that needs one is all-or-nothing per press.',
  'ANDON': 'Green: Ready and a Service endpoint. Amber: starting or not ready. Red: crashed. Blue: completed. Off: terminating.',
  'STATION': 'A Service: the sorting station that routes each incoming part to any green-andon machine of that job, round robin.',
  'DOCK': 'An Ingress: the receiving dock where parts for a hostname come in and are sent to a Service.',
  'SEAL PRESS': 'The cluster CA: kubeadm makes it first and signs a certificate for every component with it; the controller manager signs the kubelets\' CSRs with the same CA.',
  'BADGE': 'The kubelet\'s client certificate, signed by the CA through a CSR at join; it rotates at about 80% of its lifetime, and an expired one means the node cannot report.',
  'VISITOR PASS': 'A bound ServiceAccount token projected into the machine: short-lived, audience-bound, refreshed by the kubelet; RBAC decides which doors it opens.',
  'LOCKED DRAWER': 'Secrets encrypted at rest: with an EncryptionConfiguration the API server encrypts Secret values before they reach etcd, with a key only the office holds (or a KMS).',
  'INSPECTOR': 'Pod Security Admission: a validating admission check that refuses a Pod breaking the namespace\'s level (privileged, baseline, restricted) before anything is written.',
  'POLICY GATE': 'A NetworkPolicy: the CNI closes every spur into the selected machines except from the pods and ports the policy allows; with no policy every gate is open.',
  'TAMPER SEAL': 'An image signature (cosign): an admission policy verifies the crate\'s seal against a public key before a Pod may use it; an unsigned image is refused.',
  'LOGBOOK': 'The audit log: the API server writes every request it decided, with who, what and the verdict, to the audit backend.' };
function cardFor(a){
  if (a.type === 'pod'){ const p = st.pods.find(p => p.id === a.id); if (!p) return null; const d = depOf(p.app), live = st.mode === 'live';
    return { kick: `${d ? d.kind : 'Pod'} · ${esc(p.app)}`, title: `<span class="sw" style="background:${palOf(p.app).l}"></span>${esc(p.name)}`,
      body: `<table>${row('Status', LAMP(lampOf(p)) + esc(phaseText(p)))}${row('Node', esc(p.node || '—'))}${row('Version', esc(p.ver) + (p.gpu ? ` · GPU x${p.gpu}` : ''))}` +
        row('Containers', p.containers.map(c => `${esc(c.name)} <span style="color:var(--muted)">${esc(c.image || '')}</span>`).join('<br>')) + row('Restarts', p.restarts) +
        (p.pvc ? row('Volume', esc(p.pvc)) : '') + (p.configMap ? row('ConfigMap', esc(p.configMap)) : '') + (p.secret ? row('Secret', esc(p.secret) + ' (from the locked drawer: encrypted at rest)') : '') +
        (SHOP() && p.pass ? row('Visitor pass', `bound ServiceAccount token, expires in ${Math.max(1, Math.round((p.pass.exp - st.t)/60))} min; RBAC decides what it may ask the counter`) + row('Image seal', 'signature verified by the admission policy before loading') : '') + '</table>',
      acts: [ { label:'delete', title: live ? 'shows the kubectl command' : 'the ReplicaSet replaces it', onClick: () => { deletePod(p.app, p); run(); } },
        { label:'crash', onClick: () => { crashPod(p); run(); } }, { label:'fail probe', onClick: () => { unreadyPod(p); run(); } },
        d && d.kind !== 'Job' ? { label:'app…', onClick: () => open({ type:'app', app: p.app }) } : null ].filter(Boolean) }; }
  if (a.type === 'node'){ const n = st.nodes.find(n => n.name === a.node); if (!n) return null; const mine = st.pods.filter(p => p.node === n.name && p.phase !== 'terminating' && !(p.sys && !st.showSys)), cap = cellCap();
    return { kick: T().node, title: esc(n.name), body: `<table>${row('Status', n.joined < 1 ? LAMP(LAMPC.grey) + (n.joining ? 'Joining: the kubelet is registering' : 'Not registered (no kubelet yet)') : LAMP(n.ready ? (n.cordoned ? LAMPC.amber : LAMPC.green) : LAMPC.red) + (n.ready ? 'Ready' : 'NotReady') + (n.cordoned ? ', cordoned (SchedulingDisabled)' : ''))}` +
      row('Pods', `${mine.length} on this node`) + row('Capacity', `${n.used.size}/${cap} ${SHOP() ? 'bays' : 'slots'} allocated`) + (n.gpus ? row('GPUs', `${gpuUsed(n)}/${n.gpus} in use`) : '') +
      (SHOP() ? row('Image cache', n.cache && n.cache.size ? [...n.cache].map(esc).join(', ') : 'empty') + row('Pulling', n.pull ? esc(imageOf(n.pull.pod)) + (n.pull.warm ? ' (from the cache)' : ' (from the registry)') : 'nothing; ' + st.pods.filter(p => p.node === n.name && p.phase === 'queued').length + ' queued') : '') +
      row('Runs', T().runs) + (SHOP() ? row('Badge', n.cert ? (n.cert.ok ? `kubelet certificate valid, expires in ${Math.max(0, n.cert.exp - st.t).toFixed(0)} s, rotates at 80%` : '<span style="color:#b3261e">kubelet certificate expired: its status updates are refused</span>') : 'none yet: no CSR signed') + row('Gates', gatesText(n, mine)) : '') + '</table>',
      acts: [ n.cordoned ? { label:'uncordon', onClick: () => { uncordon(n); run(); } } : { label:'drain', title:'cordon, then evict every pod', onClick: () => { drain(n); run(); } } ] }; }
  if (a.type === 'tower'){ const R = window.ControlRoom ? ControlRoom.R : null, cp = st.cp;
    return { kick: 'Control plane', title: T().tower, body: `<table>${row('etcd', LAMP(cp.etcd && !cp.hold ? LAMPC.green : cp.etcd ? LAMPC.amber : LAMPC.red) + (!cp.etcd ? 'down' : cp.hold ? 'no leader, election running' : R ? `leader ${esc(R.members[R.leader].name)}, term ${R.term}, ${R.members.filter(m => m.up).length}/3 up` : 'up'))}` +
      row('API server', LAMP(cp.api ? LAMPC.green : LAMPC.red) + (cp.api ? 'serving on :6443' : 'down')) + row('Controllers', LAMP(cp.ctrl ? LAMPC.green : LAMPC.red) + (cp.ctrl ? 'controller manager and scheduler running' : 'not running')) +
      row('Pending', `${st.pods.filter(p => p.phase === 'pending').length} pods waiting for a node`) +
      (SHOP() ? row('CA', st.sec.ca ? `${LAMP(LAMPC.green)}cluster CA from kubeadm; ${st.sec.badges} certificates signed` : LAMP(LAMPC.grey) + 'not created yet') + row('Admission', 'Pod Security Admission enforces restricted on default') + row('Secrets', 'encrypted at rest (EncryptionConfiguration; the key stays in the office)') + row('Audit', 'every request in the logbook (the control room log)') : '') + '</table>',
      acts: [ { label:'control room', onClick: () => setRoom(!html.classList.contains('room')) }, { label:'bootstrap', title: T().boot, onClick: () => bootstrap() } ] }; }
  if (a.type === 'kiosk'){ const svc = svcMain(); if (!svc) return { kick:'Service', title: T().kiosk, body:'<p>No Service in this cluster.</p>', acts: [] }; const eps = endpointsOf(svc), all = st.pods.filter(p => p.app === (svc.selector || {}).app && p.pos && p.phase !== 'terminating');
    return { kick: 'Service · ClusterIP', title: `${esc(svc.name)}:${(svc.ports || [])[0] || 80}`, body: `<table>${row('Selector', esc(Object.entries(svc.selector || {}).map(([k, v]) => k + '=' + v).join(', ') || '—'))}` +
      row('Endpoints', eps.length ? eps.map(p => LAMP(LAMPC.green) + esc(p.name)).join('<br>') : '<span style="color:#b3261e">none Ready (503)</span>') +
      (all.length > eps.length ? row('Not Ready', all.filter(p => !eps.includes(p)).map(p => LAMP(lampOf(p)) + esc(p.name)).join('<br>')) : '') + row('Round robin', `next: ${eps.length ? esc(eps[st.rr % eps.length].name) : '—'}`) + '</table>',
      acts: [ { label:'send a request', go: true, onClick: () => { request(); run(); } } ] }; }
  if (a.type === 'gate'){ const ing = st.ingresses[0], svc = svcMain();
    return { kick: 'Ingress', title: esc(ing ? ing.host : T().gate), body: `<table>${row('Routes to', svc ? `Service ${esc(svc.name)}:${ing && ing.port || (svc.ports || [])[0] || 80}` : '—')}${row('Then', 'kube-proxy sends it to one Ready endpoint')}${row('Requests', `${st.parcels.length} ${T().inflight}`)}${row('Answered', `${st.reqs.ok} of ${st.reqs.sent}`)}${row('Errors', st.reqs.err ? `${st.reqs.err}: ${st.reqs.reset} connection reset, ${st.reqs.err - st.reqs.reset} with no endpoint (503)` : 'none')}</table>`,
      acts: [ { label:'send a request', go: true, onClick: () => { request(); run(); } } ] }; }
  if (a.type === 'registry'){ return { kick: 'Image registry', title: T().registry, body: `<table>${st.regApps.map(app => { const d = depOf(app); return row(esc(app), esc(d && d.containers && d.containers[0] ? d.containers[0].image : app) + (d ? ` · ${esc(d.version)}` : '')); }).join('') || row('Images', 'none')}</table><p style="color:var(--muted);margin-top:6px">${T().pullNote}</p>`,
      acts: [ { label:'apply…', onClick: () => press('Apply') } ] }; }
  if (a.type === 'board'){ const deps = st.deploys.filter(d => !d.sys || st.showSys);
    return { kick: 'Deployments', title: T().board, body: `<div class="rows">${deps.map(d => { const live = podsOf(d.app), rd = d.kind === 'Job' ? live.filter(p => p.phase === 'done').length : live.filter(isReady).length;
      return `<button data-app="${esc(d.app)}"><i style="background:${palOf(d.app).l}"></i><span class="nm">${esc(d.name)}</span><span class="${rd < d.replicas ? 'bad' : ''}">${rd}/${d.replicas}</span><span class="ver">${esc(d.version)}</span></button>`; }).join('') || '<p>nothing applied</p>'}</div>`,
      acts: [], onBody: b => b.querySelectorAll('button[data-app]').forEach(x => x.onclick = () => open({ type:'app', app: x.dataset.app })) }; }
  if (a.type === 'app'){ const d = depOf(a.app); if (!d) return null; const live = podsOf(d.app);
    return { kick: `${esc(d.kind)} · ${esc(d.ns || 'default')}`, title: `<span class="sw" style="background:${palOf(d.app).l}"></span>${esc(d.name)}`,
      body: `<table>${row('Replicas', `${live.filter(isReady).length} ready of ${d.replicas} wanted`)}${row('Version', esc(d.version))}${row('Pods', live.map(p => LAMP(lampOf(p)) + esc(p.name)).join('<br>') || '—')}</table>`,
      acts: d.kind === 'Job' ? [] : [ { label:'scale…', onClick: () => openSheet(`Scale ${d.name}`, scaleChoices(d.app)) },
        { label:'roll out…', onClick: () => openSheet(`Roll out ${d.name}`, ['v1', 'v2', 'v3'].map(v => ({ label: `${d.name} ${v}`, current: d.version === v, onClick: () => rollout(d.app, v) }))) },
        { label:'delete', onClick: () => { deleteDep(d.app); hideCard(); } } ] }; }
  if (a.type === 'crane'){ const c = st.crane; return { kick: 'Scheduler', title: T().crane, body: SHOP() ? `<p>${st.caps.length ? `${st.caps.length} job card${st.caps.length === 1 ? '' : 's'} in the tube` : 'No job cards in flight'}; ${st.pods.filter(p => p.phase === 'pending').length} Pending.</p><p style="color:var(--muted)">${EXPLAIN.SCHEDULER}</p>` : `<p>${c.carry ? `Carrying ${esc(c.carry.name)} to ${esc(c.carry.node)}` : c.job && c.job.pod ? `Fetching ${esc(c.job.pod.name)} from the registry` : 'Idle'}${c.queue.length ? `; ${c.queue.length} more bound and waiting` : ''}.</p><p style="color:var(--muted)">${EXPLAIN.SCHEDULER}</p>`,
      acts: [ { label: yard.following() ? 'stop following' : 'follow', onClick: () => yard.follow(!yard.following()) } ] }; }
  if (a.type === 'explain') return { kick: T().kick, title: esc(a.text), body: `<p>${esc(EXPLAIN[a.text] || '')}</p>`, acts: [] };
  return null;
}
function renderCard(){ if (!cardAct) return; const c = cardFor(cardAct); if (!c){ hideCard(); return; }
  const h = c.kick + '|' + c.title + '|' + c.body + '|' + c.acts.map(x => x.label).join(','); if (h === cardHtml) return; cardHtml = h;
  card.querySelector('.kick').innerHTML = c.kick; card.querySelector('h3').innerHTML = c.title; const body = card.querySelector('.body'); body.innerHTML = c.body; if (c.onBody) c.onBody(body);
  const acts = card.querySelector('.acts'); acts.innerHTML = ''; for (const x of c.acts){ const b = document.createElement('button'); b.textContent = x.label; if (x.title) b.title = x.title; if (x.go) b.className = 'go'; b.onclick = () => { x.onClick(); yard.invalidate(); }; acts.appendChild(b); } }

/* ---------- the clock: a dial for simulated time, in the strip on a page and as a sheet in full screen ---------- */
const CLK = { stops: [.1, .25, .5, 1, 2, 4], speed: 1, paused: false };
const fmt = v => (v >= 1 ? v : +v.toFixed(2)) + '×';
function setClock(speed, paused, quiet){ CLK.speed = Math.max(.05, Math.min(8, speed)); CLK.paused = !!paused; const was = SPEED; SPEED = CLK.paused ? 0 : CLK.speed;
  try { sessionStorage.setItem('kubeshop.clock', String(CLK.speed)); } catch {}
  drawClock(); if (was === 0 && SPEED > 0 && yard.resume) yard.resume(); if (!quiet && yard) yard.invalidate(); }
function stepClock(){ if (!CLK.paused) setClock(CLK.speed, true); if (yard.step) yard.step(.1); }
function nudgeClock(d){ const i = CLK.stops.findIndex(s => Math.abs(s - CLK.speed) < 1e-6), j = i < 0 ? (d > 0 ? CLK.stops.findIndex(s => s > CLK.speed) : CLK.stops.length - 1 - [...CLK.stops].reverse().findIndex(s => s < CLK.speed)) : i + d;
  if (j >= 0 && j < CLK.stops.length) setClock(CLK.stops[j], CLK.paused); }
const clockItems = () => [ { label: CLK.paused ? 'Resume' : 'Pause', sub: CLK.paused ? 'the floor and the room are held' : 'hold the floor and the room; the camera still moves', onClick: () => setClock(CLK.speed, !CLK.paused) },
  { label: 'Step 0.1 s', sub: 'one simulated slice, pausing first', onClick: stepClock },
  ...CLK.stops.map(s => ({ label: fmt(s), current: !CLK.paused && Math.abs(s - CLK.speed) < 1e-6, sub: s < 1 ? 'slower: follow each event' : s > 1 ? 'faster' : 'real time', onClick: () => setClock(s, false) })) ];
function drawClock(){ const row = $('#clock'), pill = $('#clockb'); if (pill) pill.textContent = 'Clock ' + (CLK.paused ? '⏸ ' + fmt(CLK.speed) : fmt(CLK.speed));
  if (!row) return; if (!row.childElementCount){ row.innerHTML = '<span class="k">Clock</span>' + CLK.stops.map(s => `<button data-s="${s}">${fmt(s)}</button>`).join('') + '<button data-p>Pause</button><button data-step title="advance one simulated 0.1 s">Step</button>';
    row.querySelectorAll('button[data-s]').forEach(b => b.onclick = () => setClock(+b.dataset.s, false)); row.querySelector('button[data-p]').onclick = () => setClock(CLK.speed, !CLK.paused); row.querySelector('button[data-step]').onclick = stepClock; }
  row.querySelectorAll('button[data-s]').forEach(b => b.setAttribute('aria-pressed', !CLK.paused && Math.abs(+b.dataset.s - CLK.speed) < 1e-6)); const p = row.querySelector('button[data-p]'); p.textContent = CLK.paused ? 'Resume' : 'Pause'; p.setAttribute('aria-pressed', CLK.paused); }
function wireClock(){ let s0 = 1; try { s0 = +sessionStorage.getItem('kubeshop.clock') || 1; } catch {} if (Q.has('speed')) s0 = Math.max(.1, +Q.get('speed') || 1);
  setClock(s0, false, true); const pill = $('#clockb'); if (pill) pill.onclick = () => openSheet('Clock', clockItems());
  addEventListener('keydown', e => { if (/input|textarea|select/i.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '[') nudgeClock(-1); else if (e.key === ']') nudgeClock(1); else if (e.key === ' ' && !document.querySelector('.sheet.open')){ e.preventDefault(); setClock(CLK.speed, !CLK.paused); } }); }

/* ---------- stats, switches, swatches, view ---------- */
const statsEl = document.getElementById('stats'), prevStats = {};
function drawStats(){ const shown = st.pods.filter(p => !(p.sys && !st.showSys) && p.phase !== 'terminating');
  const list = [ { label:'Pods ready', value:`${shown.filter(isReady).length}/${shown.length}` },
    { label:'Nodes', value: st.nodes.every(n => n.ready) ? String(st.nodes.length) : `${st.nodes.filter(n => n.ready).length}/${st.nodes.length}`, small:true },
    st.nodes.some(n => n.gpus) ? { label:'GPUs', value:`${st.nodes.reduce((a, n) => a + gpuUsed(n), 0)}/${st.nodes.reduce((a, n) => a + (n.gpus || 0), 0)}`, small:true } : null,
    st.mode === 'live' ? { label: st.live.status === 'error' ? 'Live: error' : st.live.status === 'file' ? 'From file' : 'Live', value: st.live.poll ? `${st.live.poll}s` : '', small:true } : null ].filter(Boolean);
  const h = list.map(x => `<div class="stat${x.small ? ' small' : ''}"><div class="k">${x.label}</div><div class="v" data-k="${x.label}">${x.value}</div></div>`).join('');
  if (statsEl._html !== h){ statsEl._html = h; statsEl.innerHTML = h; statsEl.querySelectorAll('.v').forEach(v => { if (prevStats[v.dataset.k] != null && prevStats[v.dataset.k] !== v.textContent) v.classList.add('bump'); prevStats[v.dataset.k] = v.textContent; }); } }
const xrb = $('#xrb'), lblb = $('#lblb'), roomb = $('#roomb'), folb = $('#folb'), ovb = $('#ovb'), yardb = $('#yardb'), vsp = $('#vspin');
function syncSw(){ xrb.setAttribute('aria-pressed', !!st.xrT); lblb.setAttribute('aria-pressed', !html.classList.contains('nolabels')); roomb.setAttribute('aria-pressed', html.classList.contains('room')); folb.setAttribute('aria-pressed', yard.following()); yardb.setAttribute('aria-pressed', isYard()); }
function setRoom(on){ html.classList.toggle('room', on); syncSw(); if (window.ControlRoom) ControlRoom.shown(on); if (isYard()){ scrim.classList.toggle('open', on); if (on){ sheet.classList.remove('open'); chap.classList.remove('open'); hideCard(); } } }
function setYard(on){ html.classList.toggle('yard', on); closeSheets(); hideCard(); closeChips(); scrollTo(0, 0);
  const u = new URL(location.href); if (on) u.searchParams.set('yard', '1'); else u.searchParams.set('yard', '0'); history.replaceState(null, '', u); syncSw(); yard.relayout(); }
function wireSwitches(){
  st.xr = 0; st.xrT = 0; if (Q.get('xr') === '1') st.xr = st.xrT = 1;
  xrb.onclick = () => { st.xrT = st.xrT ? 0 : 1; syncSw(); ui.animate(dt => { const g = Math.sign(st.xrT - st.xr); st.xr = Math.min(1, Math.max(0, st.xr + g*dt/.7)); return st.xr !== st.xrT; }); };
  lblb.onclick = () => { html.classList.toggle('nolabels'); syncSw(); yard.invalidate(); };
  roomb.onclick = () => setRoom(!html.classList.contains('room'));
  folb.onclick = () => { yard.follow(!yard.following()); syncSw(); };
  ovb.onclick = () => yard.overview();
  yardb.onclick = () => setYard(!isYard());
  if (Q.get('labels') === '1') html.classList.remove('nolabels');
  if (Q.get('text') === '0') html.classList.add('notext');
  if (Q.get('room') === '1') setRoom(true);
  // colour swatches recolour the crane, the tower, the roofs, the registry wall and the gate
  const palsEl = document.getElementById('pals');
  for (const [k, p] of Object.entries(PALS)){ const b = document.createElement('button'); b.className = 'sw'; b.title = k; b.style.background = p.l; b.setAttribute('aria-pressed', k === st.pal);
    b.onclick = () => { st.pal = k; [...palsEl.children].forEach(c => c.setAttribute('aria-pressed', c === b)); html.style.setProperty('--accent', p.l); yard.invalidate(); }; palsEl.appendChild(b); }
  html.style.setProperty('--accent', PALS[st.pal].l);
  $('#vreset').onclick = () => yard.front();
  vsp.onclick = () => { const on = yard.spin(); vsp.setAttribute('aria-pressed', on); };
  document.getElementById('compass').onclick = () => yard.front();
  syncSw();
}

/* ---------- mount ---------- */
function init(api){ yard = api; buildButtons(); wireSwitches(); wireClock();
  const ch = Q.get('chapter'); if (ch){ loadChapter(ch); }
  if (Q.get('netpol') === '1' && SHOP()) applyNetpol(true);
  if (Q.has('press')) Q.get('press').split(',').forEach(item => { const [what, ms] = item.split('@'), [label, choice] = what.split('>'); setTimeout(() => press(label, choice), +ms || 0); });
  const tst = $('#toast'); if (tst) tst.addEventListener('click', e => { e.stopPropagation(); fanToasts(); });
  addEventListener('keydown', e => { if (e.key === 'Escape'){ closeSheets(); hideCard(); } });
}
/* ---------- toasts: a stack of cards receding in space, newest in front; tapping the stack fans them out for a moment ---------- */
const TOAST = { max: 4, step: 8, scale: .96, gap: 6, fanMs: 2600 };
const toasts = [];   // front first, each { el, h, timer, hold }
let fanT = 0;
// the front card shows its whole text (hFull); the ones behind it are clipped to two lines (hClip) until the stack is fanned out, and each
// sits with its top exactly a step above the front card's top, so only paper edges peek out, never a line of text
function layoutToasts(){
  const fan = fanT > 0, up = isYard(), hOf = (c, i) => fan || i === 0 ? c.hFull : c.hClip, h0 = toasts.length ? toasts[0].hFull : 0; let y = 0;
  toasts.forEach((c, i) => {
    let tf, op = 1, fl = 'none'; c.el.classList.toggle('front', i === 0);
    if (fan){ if (i) y += up ? -(hOf(toasts[i - 1], i - 1) + TOAST.gap) : hOf(c, i) + TOAST.gap; tf = `translateY(${y}px)`; }
    else { const s = Math.pow(TOAST.scale, i); tf = `translateY(${-(TOAST.step*i + (h0 - s*c.hClip))}px) scale(${s})`; fl = i ? `blur(${(.35*i).toFixed(2)}px) saturate(${1 - .12*i}) contrast(${1 - .2*i}) brightness(${1 - .07*i})` : 'none'; }   // dimmed by filter, never by opacity: every card's paper stays opaque, so nothing shows through
    c.el.style.transform = tf; c.el.style.opacity = op; c.el.style.filter = fl; c.el.style.zIndex = 20 - i; });
}
function dropToast(c, dy){ const i = toasts.indexOf(c); if (i < 0) return; toasts.splice(i, 1); clearTimeout(c.timer); const el = c.el;
  el.style.pointerEvents = 'none'; el.style.zIndex = 0; el.style.opacity = 0; el.style.transform = `translateY(${dy}px) scale(${i ? .94 : 1})`; el.style.filter = 'none'; setTimeout(() => el.remove(), 320); }   // it fades out underneath the stack, never over the new front card
function expireToast(c){ if (fanT > 0){ c.timer = setTimeout(() => expireToast(c), Math.max(200, fanT - performance.now() + 200)); return; } dropToast(c, 10); layoutToasts(); }
function toast(line, hold = 1600){
  const t = $('#toast'); if (!t) return; const el = document.createElement('div'); el.className = 'tc'; el.innerHTML = `<span>${esc(line)}</span>`;
  el.style.transform = 'translateY(14px) scale(1.04)'; el.classList.add('front', 'in'); t.appendChild(el);   // the paper is opaque from the first frame; only the text fades in, so nothing behind ever shows through
  // measured once, on arrival, never per frame: the full height as the front card (a step smaller in type if it would cover more than a third
  // of the screen), and the two-line height it has behind another card
  const lim = innerHeight/3; let hFull = el.offsetHeight;
  if (hFull > lim){ el.classList.add('small'); hFull = el.offsetHeight; if (hFull > lim){ el.classList.replace('small', 'xsmall'); hFull = el.offsetHeight; } }
  el.classList.remove('front'); const hClip = el.offsetHeight; el.classList.add('front'); el.classList.remove('in');
  const c = { el, hFull, hClip, hold };
  toasts.unshift(c); while (toasts.length > TOAST.max) dropToast(toasts[toasts.length - 1], -TOAST.step*TOAST.max);
  c.timer = setTimeout(() => expireToast(c), hold); layoutToasts(); }
function fanToasts(){ const t = $('#toast'); clearTimeout(t._fan); if (fanT > 0){ fanT = 0; t.classList.remove('fan'); layoutToasts(); return; }
  fanT = performance.now() + TOAST.fanMs; t.classList.add('fan'); layoutToasts(); t._fan = setTimeout(() => { fanT = 0; t.classList.remove('fan'); layoutToasts(); }, TOAST.fanMs); }
function tick(){ drawStats(); if (cardAct) renderCard(); }
return { init, tick, open, hideCard, press, openSheet, closeSheets, setRoom, setYard, setClock, stepClock, toast, syncSw, applyChapter, spinOff: () => vsp.setAttribute('aria-pressed', false), EXPLAIN };
})();
