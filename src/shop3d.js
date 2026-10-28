/* ============================================================
   The shop floor: the cluster as a job shop, drawn in three.js with real materials and light. World coordinates are
   the simulation's (x = depth toward viewer-right, y = width toward viewer-left, z = up); three.js sees (x, z, y).
   A node is a fenced work cell with machine bays, a controller cabinet (the kubelet), a tool rack (its image cache)
   and its own AGV; a pod is a machine with an andon stack; the planning office on the mezzanine holds the counter
   (API server), the ledger (etcd), the dispatcher (scheduler) and the order board (controllers); job cards reach the
   cells through a pneumatic tube (the watch stream); parts travel the conveyor through the dock
   (Ingress) and the sorting station (Service). See src/sim.js for the model and src/view3d.js for the camera.
   ============================================================ */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const Q = new URLSearchParams(location.search);
st.model = 'shop';
if (!st.pal) st.pal = PALS[Q.get('pal')] ? Q.get('pal') : 'mustard';
const V3 = (x, y, z) => new THREE.Vector3(x, z, y);
const COARSE = matchMedia('(pointer:coarse)').matches;
const DPR = () => Math.min(devicePixelRatio || 1, 2);
const html = document.documentElement;

/* ---------- palette and materials ---------- */
const YEL = '#f2b824', CONCRETE = '#9b978e', FLOOR = '#86837c', WALL = '#d6d3cb', STEEL = '#8d9196', DARKM = '#2e3135', WHITE = '#f4f2ec', GLASS = '#9fc3d6';
const LAMP = { green: '#2fd45e', amber: '#ffb020', red: '#ff3b2f', blue: '#4b8cff', unknown: '#7f93b3', off: '#2a2d31' };
const matCache = new Map();
// a shared material for a fixed colour (bodies that never fade); o.r roughness, o.m metalness, o.e emissive intensity
function M(hex, o = {}){ const key = hex + JSON.stringify(o); if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({ color: hex, roughness: o.r == null ? .6 : o.r, metalness: o.m == null ? .05 : o.m, emissive: o.e ? hex : '#000000', emissiveIntensity: o.e || 0,
    transparent: o.a != null && o.a < 1, opacity: o.a == null ? 1 : o.a, side: o.side || THREE.FrontSide, flatShading: !!o.flat }); if (o.map){ m.map = o.map; } matCache.set(key, m); return m; }
// an unshared material for a thing that fades or changes colour
const own = (hex, o = {}) => { const m = M(hex, o).clone(); m.userData.base = m.opacity; m.userData.noDepth = o.a != null && o.a < .5; return m; };
const geoCache = new Map();
const rbox = (w, h, d, r = .6) => { const k = `r${w.toFixed(2)},${h.toFixed(2)},${d.toFixed(2)},${r}`; if (!geoCache.has(k)) geoCache.set(k, new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w/2.2, h/2.2, d/2.2))); return geoCache.get(k); };
const boxG = (w, h, d) => { const k = `b${w.toFixed(2)},${h.toFixed(2)},${d.toFixed(2)}`; if (!geoCache.has(k)) geoCache.set(k, new THREE.BoxGeometry(w, h, d)); return geoCache.get(k); };
const cylG = (r0, r1, h, n = 16) => { const k = `c${r0},${r1},${h.toFixed(2)},${n}`; if (!geoCache.has(k)) geoCache.set(k, new THREE.CylinderGeometry(r0, r1, h, n)); return geoCache.get(k); };
const sphG = r => { const k = `s${r}`; if (!geoCache.has(k)) geoCache.set(k, new THREE.SphereGeometry(r, 14, 10)); return geoCache.get(k); };
let UNIT_CYL;
// a box from its min to its max world corner; o.r rounds its edges (0 = sharp)
function box(x0, y0, z0, x1, y1, z1, mat, o = {}){ const g = o.r === 0 ? boxG(x1 - x0, z1 - z0, y1 - y0) : rbox(x1 - x0, z1 - z0, y1 - y0, o.r == null ? .5 : o.r);
  const m = new THREE.Mesh(g, mat); m.position.copy(V3((x0 + x1)/2, (y0 + y1)/2, (z0 + z1)/2)); m.castShadow = o.shadow !== false; m.receiveShadow = o.receive !== false; if (o.layer != null) m.layers.set(o.layer); return m; }
function cyl(x, y, z0, z1, r, mat, o = {}){ const m = new THREE.Mesh(cylG(r, o.r1 == null ? r : o.r1, z1 - z0, o.n || 16), mat); m.position.copy(V3(x, y, (z0 + z1)/2)); m.castShadow = o.shadow !== false; m.receiveShadow = true; return m; }
function rod(a, b, r, mat){ if (!UNIT_CYL) UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 10, 1); const m = new THREE.Mesh(UNIT_CYL, mat); m.castShadow = true; rodTo(m, a, b, r); return m; }
function rodTo(m, a, b, r){ const A = V3(...a), B = V3(...b), d = B.clone().sub(A), L = d.length() || 1e-4; m.position.copy(A).add(B).multiplyScalar(.5); m.scale.set(r, L, r); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); }
// a flat decal: a plane with a canvas texture, n = the face normal, u = the reading direction
function decal(p, n, u, w, h, tex){ const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: .5, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.position.copy(V3(...p)); const N = V3(...n).normalize(), U = V3(...u).normalize(), Vv = new THREE.Vector3().crossVectors(N, U); m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(U, Vv, N)); m.userData.decal = true; return m; }
// a soft dark patch on the floor under a thing (baked contact shadow)
const aoTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 4, 32, 32, 32); r.addColorStop(0, 'rgba(0,0,0,.55)'); r.addColorStop(.6, 'rgba(0,0,0,.22)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); return t; })();
function ao(x, y, w, d){ const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })); m.rotation.x = -Math.PI/2; m.position.copy(V3(x, y, .06)); m.receiveShadow = false; return m; }
const lamp = (x, y, z, col, r = .9) => { const m = new THREE.Mesh(sphG(1), own(col, { e: 2.6, r: .3 })); m.scale.setScalar(r); m.position.copy(V3(x, y, z)); m.castShadow = false; return m; };
const setLamp = (m, col, on = true) => { const c = on ? col : LAMP.off; if (m.material.color.getHexString() !== c.slice(1)){ m.material.color.set(c); m.material.emissive.set(c); } m.material.emissiveIntensity = on ? 2.6 : .1; };
function dispose(ob){ ob.traverse(x => { if (x.isMesh){ for (const m of (Array.isArray(x.material) ? x.material : [x.material])) if (m && !matCache.has(m.userData.key) && m.userData.base != null) m.dispose(); } }); if (ob.parent) ob.parent.remove(ob); }
function setAlpha(ob, a){ ob.traverse(x => { if (!x.isMesh) return; for (const m of (Array.isArray(x.material) ? x.material : [x.material])){ if (m.userData.base == null) continue; const op = a*m.userData.base; m.opacity = op; m.transparent = op < 1; m.depthWrite = !m.userData.noDepth && op > .05; } }); }

/* ---------- canvas textures: paint and decals ---------- */
const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const texCache = new Map();
function tex(key, w, h, draw, ppu = 8){ if (key && texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas'); c.width = Math.max(2, Math.ceil(w*ppu)); c.height = Math.max(2, Math.ceil(h*ppu)); const g = c.getContext('2d'); g.scale(c.width/w, c.height/h); g.lineCap = 'round'; g.lineJoin = 'round'; draw(g, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; if (key) texCache.set(key, t); return t; }
const txt = (g, s, x, y, size, col = WHITE, weight = 800, align = 'center') => { g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };
// text that never leaves its face: shrink the font until the line fits the width (down to a floor), and split a long name onto two
// lines at a hyphen, dot or underscore before shrinking it, so a live cluster's app names (cert-manager, synctrack-frontend) read whole
function fitTxt(g, s, x, y, size, maxW, col = WHITE, weight = 800, align = 'center', min = .22){ g.font = `${weight} ${size}px ${FONT}`; const w = g.measureText(s).width; if (w > maxW) size = Math.max(min, size*maxW/w); txt(g, s, x, y, size, col, weight, align); return size; }
function nameLines(g, s, size, maxW, weight = 800){ g.font = `${weight} ${size}px ${FONT}`; if (g.measureText(s).width <= maxW) return [s];
  const cut = Math.max(s.lastIndexOf('-', s.length - 2), s.lastIndexOf('.', s.length - 2), s.lastIndexOf('_', s.length - 2)); let i = cut > 1 ? cut + 1 : Math.ceil(s.length/2);
  if (cut > 1 && s.length - cut - 1 < 2) i = Math.ceil(s.length/2); return [s.slice(0, i), s.slice(i)]; }
// a name and a version line centred on a face of w × h: one line when the name fits, two when it does not, both fitted to the width
function nameBlock(g, w, h, name, ver, o = {}){ const nz = o.size || Math.min(1.9, h*.34), vz = o.vsize || nz*.7, maxW = w - (o.pad == null ? .6 : o.pad), lines = nameLines(g, name.toUpperCase(), nz, maxW);
  if (lines.length === 1){ fitTxt(g, lines[0], w/2, h*(o.y1 || .36), nz, maxW); fitTxt(g, ver, w/2, h*(o.yv || .7), vz, o.vmax || maxW, WHITE, 700); }
  else { fitTxt(g, lines[0], w/2, h*.22, nz*.8, maxW); fitTxt(g, lines[1], w/2, h*.46, nz*.8, maxW); fitTxt(g, ver, w/2, h*(o.yv2 || .76), vz*.9, o.vmax || maxW, WHITE, 700); } }
const rect = (g, x, y, w, h, fill, stroke, lw = .4) => { if (fill){ g.fillStyle = fill; g.fillRect(x, y, w, h); } if (stroke){ g.strokeStyle = stroke; g.lineWidth = lw; g.strokeRect(x, y, w, h); } };
const line = (g, pts, col, lw, dash) => { g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(dash || []); g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]); };
// a round seal: gold with a tick while the certificate is good, red with a cross when it has expired
const badgeTex = ok => tex('badge|' + ok, 2, 2, (g, w, h) => { g.fillStyle = ok ? '#e8b923' : '#e2483d'; g.beginPath(); g.arc(1, 1, .95, 0, Math.PI*2); g.fill(); g.strokeStyle = ok ? '#5a4408' : '#5a1410'; g.lineWidth = .1; g.stroke(); txt(g, ok ? '✓' : '✕', 1, 1.05, 1.1, ok ? '#2b2208' : WHITE); }, 48);
// a cabinet's badge carries the kubelet's identity: the certificate's CN is system:node:<name>, its group system:nodes
const idBadgeTex = (ok, name) => tex(`idbadge|${ok}|${name}`, 5.2, 2.2, (g, w, h) => { rect(g, 0, 0, w, h, ok ? '#fff1bf' : '#f3c9c4'); g.strokeStyle = '#5a4408'; g.lineWidth = .08; g.strokeRect(.04, .04, w - .08, h - .08);
  g.fillStyle = ok ? '#e8b923' : '#e2483d'; g.beginPath(); g.arc(1.1, 1.1, .85, 0, Math.PI*2); g.fill(); txt(g, ok ? '✓' : '✕', 1.1, 1.15, .95, ok ? '#2b2208' : WHITE);
  txt(g, 'system:node:', 3.55, .72, .5, '#5e5a52', 800); txt(g, name, 3.55, 1.5, .62, '#1d1f22', 800); }, 48);
const hatch = (g, x, y, w, h, c1 = YEL, c2 = '#1d1f22') => { rect(g, x, y, w, h, c1); g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.strokeStyle = c2; g.lineWidth = Math.min(w, h)*.5; for (let s = -h; s < w + h; s += Math.min(w, h)*1.6){ g.beginPath(); g.moveTo(x + s, y + h); g.lineTo(x + s + h, y); g.stroke(); } g.restore(); };

/* ---------- dimensions ---------- */
const MW = 9, ML = 10, MH = 8;                         // a machine: 9 deep (x), 10 wide (y), 8 tall
const TRUSS_Z = 50;                                    // the trusses' height; the tube (TRUNK, tubePath in the simulation) rides the belts at TZ
const OFF = { x0: 2, x1: 36, y0: 2, y1: 40, z0: 24, z1: 42 };   // the planning office on its mezzanine
const ox = () => st.net.managed ? -42 : 0;                        // in managed mode the office stands in the provider's building past the floor's back edge
const OFFV = () => ({ ...OFF, x0: OFF.x0 + ox(), x1: OFF.x1 + ox() });
const DNSBOARD = () => ({ x0: W - 33.2, x1: W - 32.4, y0: 23, y1: 37, z0: 3, z1: 10.2 });   // the directory board (the kube-dns Service) on the wall beside the dock, across the belt from the parts coming in
const CRIB = () => ({ x0: 4, x1: 30, y0: REG_Y0 - 4, y1: REG_Y0 + REG_MAX*REG_GAP, h: 22 });
const DOCK = () => ({ x0: W - 36, x1: W - 6, y0: 14, y1: 24 });
const STATION = () => ({ x0: W - 44, x1: W - 30, y0: 36, y1: 54 });
const cellBox = n => ({ x0: n.x0, x1: n.x0 + n.depth, y0: n.y0, y1: n.y0 + SLW });
const cabinet = n => { const c = cellBox(n); return { x0: c.x0 - 10, x1: c.x0 - 4, y0: c.y1 - 14, y1: c.y1 - 4, h: 15 }; };
const rackOf = n => { const c = cellBox(n); return { x0: c.x0 - 10, x1: c.x0 - 4, y0: c.y1 - 32, y1: c.y1 - 17, h: 12 }; };
const agvHome = n => { const c = cellBox(n); return [c.x0 - 7, c.y1 - 40, 0]; };
function along(pts, t){ const segs = []; let L = 0; for (let i = 0; i < pts.length - 1; i++){ const l = dist3(pts[i], pts[i + 1]); segs.push([L, l, i]); L += l; } const d = t*L;
  for (const [s0, l, i] of segs) if (d <= s0 + l + 1e-6) return lerp3(pts[i], pts[i + 1], l ? (d - s0)/l : 0); return pts[pts.length - 1]; }
// the AGV's run: cabinet to the crib's door (a cold pull) or just to the rack (a warm one), and back
// the AGV's lane runs in front of the cabinets (x0 - 14, between the office side and the cells); a back row reaches it by the corridor at the far end of the floor
function agvPath(n, warm){ const h = agvHome(n), r = rackOf(n), c = CRIB(), lx = n.x0 - 14, door = [c.x1 + 5, c.y0 - 8, 0]; if (warm) return [h, [h[0], r.y1 + 2, 0]];
  return n.row ? [h, [lx, h[1], 0], [lx, D - 6, 0], [SX0 - 14, D - 6, 0], [SX0 - 14, c.y0 - 8, 0], door] : [h, [lx, h[1], 0], [lx, c.y0 - 8, 0], door]; }

/* ---------- scene ---------- */
const scene = new THREE.Scene(); scene.background = new THREE.Color('#b8b4ac');
const Y = { statics: new THREE.Group(), nodes: new Map(), pods: new Map(), caps: [], parts: [], key: '', office: null, board: null, crib: null, station: null, dock: null };
scene.add(Y.statics);
const pickables = [];
const m0 = () => PALS[st.pal];
function staticKey(){ return [W, D, st.pal, st.nodes.map(n => n.name + ':' + n.row + ':' + n.depth).join(','), (st.ingresses[0] || {}).host, (svcMain() || {}).name, st.net.fabric, st.net.managed, dnsIP()].join('|'); }
function rebuildStatic(){
  dispose(Y.statics); Y.statics = new THREE.Group(); scene.add(Y.statics); pickables.length = 0;
  for (const N of Y.nodes.values()) dispose(N.g); Y.nodes.clear();
  const S = Y.statics;
  // the hall: a wide floor beyond the shop floor, the shop floor itself with its painted lanes and the yellow edge stripes
  const hall = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), M(FLOOR, { r: .95 })); hall.rotation.x = -Math.PI/2; hall.position.copy(V3(W/2, D/2, -.2)); hall.receiveShadow = true; S.add(hall);
  const paint = tex(`paint|${W}|${D}|${st.nodes.map(n => n.row === 0 ? n.y0 : '').join(',')}|${st.net.fabric}`, W, D, (g, w, h) => {
    rect(g, 0, 0, w, h, CONCRETE); for (let i = 0; i < 1800; i++){ g.fillStyle = `rgba(${60 + Math.random()*40|0},${60 + Math.random()*40|0},${60 + Math.random()*35|0},${.05 + Math.random()*.08})`; g.fillRect(Math.random()*w, Math.random()*h, .6 + Math.random()*1.6, .6 + Math.random()*1.6); }
    hatch(g, 0, 0, 2.2, h); hatch(g, w - 2.2, 0, 2.2, h); hatch(g, 0, 0, w, 2.2); hatch(g, 0, h - 2.2, w, 2.2);
    rect(g, W - 30, 0, 18, D, '#8f8c85'); line(g, [[W - 30, 0], [W - 30, D]], WHITE, .9); line(g, [[W - 12, 0], [W - 12, D]], WHITE, .9);
    // the belts: the spine (two of them with BGP), and per row the spur from its diverter to the corridor, the corridor, and each cell's entry
    const belt = (x0, y0, x1, y1) => { const w = 1.5; rect(g, Math.min(x0, x1) - w, Math.min(y0, y1) - w, Math.abs(x1 - x0) + 2*w, Math.abs(y1 - y0) + 2*w, '#726f68'); line(g, [[x0, y0], [x1, y1]], WHITE, .7, [3, 3]); };
    belt(LANE, 0, LANE, D); if (st.net.fabric === 'bgp') belt(SPINE2(), 44, SPINE2(), D - 8);
    for (let r = 0; r < 8; r++){ const Dv = DIVERTER(r); if (!Dv) break; const ys = Dv.cells.map(cellEntry); belt(LANE, Dv.y, Dv.cx, Dv.y); belt(Dv.cx, Math.min(Dv.y, ...ys), Dv.cx, Math.max(Dv.y, ...ys)); for (const n of Dv.cells) belt(Dv.cx, cellEntry(n), n.x0 + n.depth, cellEntry(n)); }
    for (const n of st.nodes){ const lx = n.x0 - 14; line(g, [[lx, n.y0 + 4], [lx, n.row ? D - 6 : REG_Y0 - 12]], '#e3c766', .8, [2, 3]); if (n.row) line(g, [[lx, D - 6], [SX0 - 14, D - 6]], '#e3c766', .8, [2, 3]); }
    line(g, [[SX0 - 14, REG_Y0 - 12], [30, REG_Y0 - 12]], '#e3c766', .8, [2, 3]);
    for (const n of st.nodes){ const c = cellBox(n); hatch(g, c.x0 - 1.4, c.y0 - 1.4, c.x1 - c.x0 + 2.8, 1.4); hatch(g, c.x0 - 1.4, c.y1, c.x1 - c.x0 + 2.8, 1.4); hatch(g, c.x0 - 1.4, c.y0, 1.4, c.y1 - c.y0); hatch(g, c.x1, c.y0, 1.4, c.y1 - c.y0); }
    line(g, [[W - 30, 45], [W - 44, 45]], WHITE, .8, [3, 3]); }, 4);
  paint.anisotropy = 8;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: paint, roughness: .92, metalness: 0 })); floor.rotation.x = -Math.PI/2; floor.position.copy(V3(W/2, D/2, 0)); floor.receiveShadow = true; S.add(floor);
  // the pneumatic tube: up from the counter, over to the spine, then along the spine belt just above it; per row the spur and the corridor
  // (the cells' own branches are theirs, lit when they join), with a fitting on the tube over each diverter
  const tubeM = M(GLASS, { a: .32, r: .15, m: .1 }); tubeM.depthWrite = false; const T = TRUNK();
  for (let i = 0; i < T.length - 1; i++) S.add(rod(T[i], T[i + 1], 1.1, tubeM));
  for (let r = 0; r < 8; r++){ const Dv = DIVERTER(r); if (!Dv) break; const ys = Dv.cells.map(n => cellDoor(n)[1]); S.add(rod([LANE, Dv.y, TZ], [Dv.cx, Dv.y, TZ], 1.1, tubeM)); S.add(rod([Dv.cx, Math.min(Dv.y, ...ys), TZ], [Dv.cx, Math.max(Dv.y, ...ys), TZ], 1.1, tubeM));
    S.add(box(LANE - 1.7, Dv.y - 1.7, TZ - 1.7, LANE + 1.7, Dv.y + 1.7, TZ + 1.7, M('#5a6068', { r: .4, m: .5 }), { r: .3 })); S.add(box(Dv.cx - 1.5, Dv.y - 1.5, TZ - 1.5, Dv.cx + 1.5, Dv.y + 1.5, TZ + 1.5, M('#5a6068', { r: .4, m: .5 }), { r: .3 })); }
  for (const y of [60, 130, 200]) if (y < D - 24) S.add(rod([LANE + 3.2, y, 0], [LANE + 3.2, y, TZ - .4], .4, M(DARKM, { r: .5 })));   // hangers off the belt's edge
  Y.office = mkOffice(); Y.office.g.position.x = ox(); S.add(Y.office.g);
  if (st.net.managed){ const F = new THREE.Group(); for (let y = -8; y <= 64; y += 12) F.add(cyl(-3, y, 0, 10, .5, M(YEL, { r: .5 }), { n: 8 })); const pm = own('#4a4e54', { a: .35, r: .5, m: .4 }); pm.depthWrite = false; pm.side = THREE.DoubleSide;
    const pnl = new THREE.Mesh(boxG(.15, 8.5, 72), pm); pnl.position.copy(V3(-3, 28, 5.2)); pnl.castShadow = false; F.add(pnl); F.add(rod([-3, -8, 10], [-3, 64, 10], .35, M(YEL, { r: .5 })));
    F.add(box(-3.3, 14, 10, -2.7, 42, 15, M(WHITE, { r: .5 }), { r: .15 })); F.add(decal([-2.68, 28, 12.5], [1, 0, 0], [0, -1, 0], 26, 4.4, tex('provider', 26, 4.4, (g, w, h) => { rect(g, 0, 0, w, h, '#2b3a66'); txt(g, 'PROVIDER · MANAGED CONTROL PLANE', w/2, 1.5, 1.3, WHITE); txt(g, 'the office is theirs, the cells are yours · konnectivity tunnel to every cabinet', w/2, 3.2, .85, '#c9d2ea', 700); }, 24)));
    S.add(F); }
  Y.divs = []; for (let r = 0; r < 8; r++){ const Dv = DIVERTER(r); if (!Dv) break; const out = mkDiverter(r, Dv); Y.divs.push(out); S.add(out.g); }
  Y.dnsBoard = mkDnsBoard(); S.add(Y.dnsBoard.g);
  Y.crib = mkCrib(); S.add(Y.crib.g);
  Y.station = mkStation(); S.add(Y.station.g);
  Y.dock = mkDock(); S.add(Y.dock.g);
  mkConveyor(S);
  for (const P of Y.pods.values()) pickables.push(P.body);
  Y.key = staticKey();
}
/* the planning office: a glazed box on a mezzanine; inside, the counter, the ledger cabinet, the dispatcher's desk; the order board on its wall */
function mkOffice(){
  const g = new THREE.Group(), o = OFF, out = { g, cases: [], insides: [], screens: {} }, m = m0();
  for (const [x, y] of [[o.x0 + 3, o.y0 + 3], [o.x1 - 3, o.y0 + 3], [o.x0 + 3, o.y1 - 3], [o.x1 - 3, o.y1 - 3], [o.x1 - 3, (o.y0 + o.y1)/2]]) g.add(cyl(x, y, 0, o.z0, 1.4, M(STEEL, { r: .4, m: .6 }), { n: 10 }));
  g.add(box(o.x0, o.y0, o.z0 - 2.5, o.x1, o.y1, o.z0, M(CONCRETE, { r: .8 }), { r: .4 }));
  g.add(box(o.x0 - .6, o.y0 - .6, o.z0, o.x1 + .6, o.y1 + .6, o.z0 + 1.2, M(m.l, { r: .5 }), { r: .3 }));
  const glassM = own(GLASS, { a: .28, r: .1, m: .2 }); glassM.depthWrite = false; glassM.side = THREE.DoubleSide;
  const glaze = box(o.x0, o.y0, o.z0 + 1.2, o.x1, o.y1, o.z1, glassM, { r: 0, shadow: false }); glaze.userData.act = { type: 'tower' }; pickables.push(glaze); g.add(glaze); out.cases.push(glaze);
  for (const [a, b] of [[[o.x0, o.y0], [o.x1, o.y0]], [[o.x1, o.y0], [o.x1, o.y1]], [[o.x1, o.y1], [o.x0, o.y1]], [[o.x0, o.y1], [o.x0, o.y0]]]) for (const z of [o.z0 + 1.2, o.z1]) g.add(rod([a[0], a[1], z], [b[0], b[1], z], .5, M(DARKM, { r: .4, m: .5 })));
  for (const [x, y] of [[o.x0, o.y0], [o.x1, o.y0], [o.x0, o.y1], [o.x1, o.y1], [o.x1, o.y0 + 13], [o.x1, o.y0 + 26], [o.x0, o.y0 + 19]]) g.add(rod([x, y, o.z0 + 1.2], [x, y, o.z1], .5, M(DARKM, { r: .4, m: .5 })));
  g.add(box(o.x0 - 1, o.y0 - 1, o.z1, o.x1 + 1, o.y1 + 1, o.z1 + 1.6, M(DARKM, { r: .6 }), { r: .3 }));
  out.beacon = lamp((o.x0 + o.x1)/2, (o.y0 + o.y1)/2, o.z1 + 3.4, LAMP.amber, 1.3); setLamp(out.beacon, LAMP.amber, false); g.add(out.beacon); g.add(cyl((o.x0 + o.x1)/2, (o.y0 + o.y1)/2, o.z1 + 1.6, o.z1 + 2.6, 1.6, M(DARKM), { n: 10 }));
  const z = o.z0 + 1.2, ins = new THREE.Group();
  // the counter (API server) by the tube's mouth, with a screen
  ins.add(box(o.x0 + 14, o.y0 + 14, z, o.x0 + 22, o.y0 + 26, z + 5, M(WHITE, { r: .5 }), { r: .4 }));
  out.screens.api = box(o.x0 + 14.4, o.y0 + 16, z + 5, o.x0 + 16.4, o.y0 + 24, z + 9, own(LAMP.green, { e: 1.6, r: .3 }), { r: .2, shadow: false }); ins.add(out.screens.api);
  ins.add(cyl(OFF.x0 + 18, OFFICE[1], z, OFFICE[2], 1.4, M(DARKM), { n: 12 }));
  // the ledger: a cabinet with three drawers (the Raft members), a lamp each
  ins.add(box(o.x0 + 3, o.y0 + 3, z, o.x0 + 11, o.y0 + 11, z + 13, M('#4a4f55', { r: .5, m: .3 }), { r: .4 }));
  out.drawers = [0, 1, 2].map(i => { const l = lamp(o.x0 + 11.2, o.y0 + 7, z + 11 - i*4, LAMP.green, .55); ins.add(box(o.x0 + 11, o.y0 + 4, z + 9.6 - i*4, o.x0 + 11.4, o.y0 + 10, z + 12.4 - i*4, M('#5b6168', { r: .5, m: .3 }), { r: .15 })); ins.add(l); return l; });
  // the dispatcher's desk with its screen
  ins.add(box(o.x0 + 4, o.y1 - 16, z, o.x0 + 13, o.y1 - 4, z + 4.5, M(WHITE, { r: .5 }), { r: .4 }));
  out.screens.sched = box(o.x0 + 12.6, o.y1 - 14, z + 4.5, o.x0 + 13.6, o.y1 - 6, z + 9.5, own(LAMP.blue, { e: 1.3, r: .3 }), { r: .2, shadow: false }); ins.add(out.screens.sched);
  ins.add(cyl(o.x0 + 8.5, o.y1 - 10, z + 4.5, z + 5.3, 2.2, M(DARKM), { n: 12 }));
  // the seal press (the cluster CA) on a bench behind the counter: its head stamps the badges at kubeadm init; a lamp while the CA exists
  const sp = { x: o.x0 + 27, y: o.y0 + 31 };
  ins.add(box(sp.x - 3, sp.y - 3, z, sp.x + 3, sp.y + 3, z + 3.2, M('#4a4f55', { r: .5, m: .3 }), { r: .3 })); ins.add(cyl(sp.x - 2.2, sp.y, z + 3.2, z + 9.2, .55, M(STEEL, { r: .3, m: .7 }), { n: 10 }));
  out.pressHead = box(sp.x - 1.4, sp.y - 1.4, z + 6.4, sp.x + 1.4, sp.y + 1.4, z + 8.4, M(DARKM, { r: .4, m: .4 }), { r: .3 }); ins.add(out.pressHead); out.pressY = out.pressHead.position.y;
  out.pressLamp = lamp(sp.x + 2.3, sp.y - 2.3, z + 3.9, LAMP.green, .4); ins.add(out.pressLamp);
  ins.add(box(sp.x - 3, sp.y + 3.6, z, sp.x + 3, sp.y + 6.6, z + 2.2, M('#4a4f55', { r: .5, m: .3 }), { r: .3 })); ins.add(cyl(sp.x, sp.y + 5.1, z + 2.2, z + 3.4, 1.1, M('#e8b923', { r: .35, m: .8 }), { n: 12 }));   // the second die: the service-account key pair, for visitor passes
  ins.add(decal([sp.x + 3.02, sp.y + 5.1, z + 1.1], [1, 0, 0], [0, -1, 0], 5.6, 1.8, tex('passdie', 5.6, 1.8, (g, w, h) => { txt(g, 'PASS DIE', w/2, .6, .62, WHITE); txt(g, 'service-account key', w/2, 1.3, .48, LAMP.amber, 700); }, 32)));
  ins.add(decal([sp.x + 3.02, sp.y, z + 1.6], [1, 0, 0], [0, -1, 0], 5.6, 2.4, tex('sealpress', 5.6, 2.4, (g, w, h) => { txt(g, 'SEAL PRESS', w/2, .8, .8, WHITE); txt(g, 'cluster CA', w/2, 1.75, .7, LAMP.amber, 700); }, 32)));
  // the badges the press stamped: on the ledger, the counter and the dispatcher's desk
  out.badges = [decal([o.x0 + 7, o.y0 + 2.98, z + 11], [0, -1, 0], [-1, 0, 0], 2, 2, badgeTex(true)), decal([o.x0 + 22.02, o.y0 + 17, z + 2.6], [1, 0, 0], [0, -1, 0], 2, 2, badgeTex(true)), decal([o.x0 + 13.02, o.y1 - 6.2, z + 2.3], [1, 0, 0], [0, -1, 0], 2, 2, badgeTex(true))];
  for (const b of out.badges) ins.add(b);
  // the locked drawer (Secrets encrypted at rest) beside the ledger, and the office's key on the counter
  ins.add(box(o.x0 + 3, o.y0 + 12.5, z, o.x0 + 9.5, o.y0 + 18, z + 5, M('#2f3338', { r: .45, m: .4 }), { r: .3 }));
  ins.add(decal([o.x0 + 9.52, o.y0 + 15.25, z + 2.5], [1, 0, 0], [0, -1, 0], 5, 4, tex('drawer', 5, 4, (g, w, h) => { txt(g, 'SECRETS', w/2, .8, .75, WHITE); txt(g, 'encrypted at rest', w/2, 1.7, .5, '#c9c4b8', 700); g.fillStyle = '#e8b923'; g.beginPath(); g.arc(w/2, 3, .45, 0, Math.PI*2); g.fill(); rect(g, w/2 - .12, 3, .24, .7, '#e8b923'); }, 40)));
  ins.add(rod([o.x0 + 15, o.y0 + 24.5, z + 5.1], [o.x0 + 16.6, o.y0 + 24.5, z + 5.1], .22, M('#e8b923', { r: .35, m: .8 }))); ins.add(cyl(o.x0 + 14.7, o.y0 + 24.5, z + 5, z + 5.25, .5, M('#e8b923', { r: .35, m: .8 }), { n: 10 }));
  // the inspector at the counter (Pod Security Admission): raises a STOP sign when a job is refused
  const ip = { x: o.x0 + 24.5, y: o.y0 + 11 }; ins.add(cyl(ip.x, ip.y, z, z + 4.2, 1.1, M('#2b3a66', { r: .6 }), { n: 12 })); const head = new THREE.Mesh(sphG(.9), M('#e0b48a', { r: .7 })); head.position.copy(V3(ip.x, ip.y, z + 5.2)); ins.add(head);
  out.sign = new THREE.Group(); out.sign.add(rod([ip.x + 1.5, ip.y, z + 2.6], [ip.x + 1.5, ip.y, z + 6.4], .18, M(DARKM))); out.sign.add(box(ip.x + 1.2, ip.y - 1.8, z + 6.4, ip.x + 1.8, ip.y + 1.8, z + 8.6, M('#e2483d', { r: .5 }), { r: .3 }));
  out.sign.add(decal([ip.x + 1.82, ip.y, z + 7.5], [1, 0, 0], [0, -1, 0], 3.4, 2, tex('stop', 3.4, 2, (g, w, h) => { txt(g, 'STOP', w/2, .68, .72, WHITE); txt(g, 'ADMISSION', w/2, 1.45, .5, WHITE, 700); }, 48))); out.signY = out.sign.position.y; ins.add(out.sign);
  g.add(ins); out.insides.push(ins);
  // the order board on the outside wall toward the crib (the side face), so the counter and the inspector stay in view through the front glass
  out.board = box(o.x0 + 6, o.y1 + .4, o.z0 + 4, o.x1 - 6, o.y1 + 1.2, o.z1 - 3, M(WHITE, { r: .5 }), { r: .2 }); out.board.userData.act = { type: 'board' }; pickables.push(out.board); g.add(out.board);
  out.boardDecal = decal([(o.x0 + o.x1)/2, o.y1 + 1.25, (o.z0 + 4 + o.z1 - 3)/2], [0, 1, 0], [1, 0, 0], o.x1 - o.x0 - 12, o.z1 - o.z0 - 7, boardTex()); g.add(out.boardDecal);
  g.add(ao(o.x0 + 12, o.y0 + 20, 80, 60));
  // the mesh desk in the annex: istiod or the Linkerd control plane, with the mesh's own badge press (its CA is not the cluster CA)
  const ax = { x0: o.x1 + 1.5, x1: o.x1 + 13, y0: o.y0 + 1, y1: o.y0 + 15 }; out.annex = new THREE.Group();
  out.annex.add(cyl(ax.x1 - 2, ax.y0 + 2, 0, o.z0, 1.2, M(STEEL, { r: .4, m: .6 }), { n: 10 })); out.annex.add(cyl(ax.x1 - 2, ax.y1 - 2, 0, o.z0, 1.2, M(STEEL, { r: .4, m: .6 }), { n: 10 }));
  out.annex.add(box(ax.x0, ax.y0, o.z0 - 2.5, ax.x1, ax.y1, o.z0, M(CONCRETE, { r: .8 }), { r: .4 })); out.annex.add(box(ax.x0 - .5, ax.y0 - .5, o.z0, ax.x1 + .5, ax.y1 + .5, o.z0 + 1.2, M(m.l, { r: .5 }), { r: .3 }));
  const ag = own(GLASS, { a: .28, r: .1, m: .2 }); ag.depthWrite = false; ag.side = THREE.DoubleSide; out.annex.add(box(ax.x0, ax.y0, o.z0 + 1.2, ax.x1, ax.y1, o.z0 + 10, ag, { r: 0, shadow: false })); out.annex.add(box(ax.x0 - .6, ax.y0 - .6, o.z0 + 10, ax.x1 + .6, ax.y1 + .6, o.z0 + 11, M(DARKM, { r: .6 }), { r: .2 }));
  out.annex.add(box(ax.x0 + 2, ax.y0 + 3, z, ax.x0 + 8, ax.y1 - 3, z + 4, M(WHITE, { r: .5 }), { r: .3 })); out.annex.add(box(ax.x0 + 3, ax.y0 + 4, z + 4, ax.x0 + 6, ax.y0 + 7, z + 6.6, M('#4a4f55', { r: .5, m: .3 }), { r: .3 })); out.annex.add(cyl(ax.x0 + 4.5, ax.y0 + 5.5, z + 6.6, z + 7.6, .8, M('#9b7bd6', { r: .35, m: .6 }), { n: 10 }));
  out.annex.add(decal([ax.x1 + .02, (ax.y0 + ax.y1)/2, o.z0 + 5.5], [1, 0, 0], [0, -1, 0], 12, 3.6, tex('meshdesk', 12, 3.6, (g, w, h) => { rect(g, 0, 0, w, h, '#3b2a66'); txt(g, 'MESH DESK · istiod / linkerd', w/2, 1, .85, WHITE); txt(g, 'MESH CA: not the cluster CA', w/2, 2.4, .8, '#d9c8ff', 700); }, 24)));
  out.annex.visible = false; g.add(out.annex);
  return out;
}
/* a row's diverter: the top-of-rack switch, a switch arm on the spine belt where the row's spur leaves it, with the route strip of
   what it has learned from the cells on its row (painted on with static routes; a line per announcement with BGP) */
const stripLines = Dv => { const bgp = st.net.fabric === 'bgp'; return Dv.cells.map(n => { const i = st.nodes.indexOf(n); return { text: bgp ? `10.200.${i}.0/24  ${n.name}  ${n.cut ? 'withdrawn (peer down)' : 'learned'}` : `10.200.${i}.0/24  via ${n.name}  static`, off: !!n.cut }; }); };
const stripH = Dv => 1.5 + Dv.cells.length*1.05;
function routeTex(r, Dv){ const bgp = st.net.fabric === 'bgp', lines = stripLines(Dv);
  return tex(`strip|${r}|${bgp}|${lines.map(l => l.text + l.off).join(';')}`, 9, stripH(Dv), (g, w, h) => { rect(g, 0, 0, w, h, '#f4f2ec'); rect(g, 0, 0, w, .95, '#1d1f22'); txt(g, bgp ? `DIVERTER ${r + 1} · ROUTES LEARNED · BGP` : `DIVERTER ${r + 1} · ROUTES · STATIC`, w/2, .5, .5, WHITE);
    lines.forEach((l, i) => txt(g, l.text, .3, 1.55 + i*1.05, .5, l.off ? '#9a948a' : '#3a3d42', 700, 'left')); }, 40); }
function mkDiverter(r, Dv){ const g = new THREE.Group(), out = { g, key: '', r, Dv, arms: [] }, x = Dv.x, y = Dv.y, bgp = st.net.fabric === 'bgp', lanes = bgp ? [SPINE2(), LANE] : [LANE], x0 = lanes[0] - 4.5, x1 = x + 4.5;
  // the frame across the belt(s) with a pivot post per belt; the arm lies along the belt and swings across it to send a part down the spur
  const frame = box(x0, y - 3.4, 0, x1, y + 3.4, 1, M('#3d4147', { r: .45, m: .4 }), { r: .2 }); frame.userData.act = { type: 'diverter', row: r }; pickables.push(frame); g.add(frame);
  g.add(box(x0, y + 2.6, 0, x1, y + 3.4, 4.2, M(YEL, { r: .5 }), { r: .15 }));
  for (const lx of lanes){ const arm = new THREE.Group(); arm.position.copy(V3(lx + 2.6, y + 2.6, 2.4)); arm.add(rod([0, 0, 0], [0, -6.4, 0], .42, M('#e2483d', { r: .5 }))); arm.add(cyl(0, 0, -1.8, 1.4, .8, M(DARKM, { r: .4 }), { n: 10 })); arm.add(lamp(0, 0, 1.9, LAMP.green, .32)); g.add(arm); out.arms.push({ g: arm, lane: lx, lamp: arm.children[2] }); }
  // the route strip: a plate standing beside the belt, facing the way the camera looks by default
  const h = stripH(Dv); g.add(box(x1 + .8, y - 4.5, 0, x1 + 1.3, y + 4.5, h + 1.4, M(DARKM, { r: .5 }), { r: .1 })); out.stripDecal = decal([x1 + 1.32, y, .9 + h/2], [1, 0, 0], [0, -1, 0], 9, h, routeTex(r, Dv)); g.add(out.stripDecal);
  out.lamp = lamp(x1 + 1.05, y + 4.5, h + 1.7, LAMP.green, .45); g.add(out.lamp); g.add(ao(x, y, 22, 14)); return out; }
/* the directory board at the dock: the kube-dns Service as a wall board of names and where they go; every part glances at it on the way in and
   the CoreDNS machines in the cells keep it current (an update tick from one of them); with no CoreDNS machine Ready it reads NO ANSWER */
function dnsBoardTex(){ const up = dnsUp(), lines = boardLines(), hl = st.net.dns.hl, ip = dnsIP();
  return tex(`dnsboard|${up}|${hl || ''}|${ip}|${lines.map(l => l.text).join(';')}`, 14, 7.2, (g, w, h) => { rect(g, 0, 0, w, h, up ? '#1d2a26' : '#2a2320'); rect(g, 0, 0, w, 1, '#ffe3a0'); txt(g, `DIRECTORY · kube-dns ${ip}`, w/2, .5, .52, '#1d1f22');
    if (!up){ txt(g, 'NO ANSWER', w/2, 3.4, 1.3, '#ff5a4e'); txt(g, 'kube-dns has no Ready endpoints', w/2, 4.9, .55, '#c9c4b8', 700); return; }
    lines.forEach((l, i) => { const y = 1.75 + i*.92; if (l.svc === hl) rect(g, .2, y - .42, w - .4, .84, '#ffe3a0'); txt(g, l.text, .5, y, .48, l.svc === hl ? '#1d1f22' : '#ffe3a0', 700, 'left'); }); }, 40); }
function mkDnsBoard(){ const d = DNSBOARD(), g = new THREE.Group(), out = { g }, m = m0();
  for (const y of [d.y0 + .6, d.y1 - .6]) g.add(cyl(d.x1 - .4, y, 0, d.z1 + .6, .45, M(DARKM, { r: .45 }), { n: 10 }));
  out.panel = box(d.x0, d.y0, d.z0, d.x1, d.y1, d.z1, M('#3a3d42', { r: .5, m: .3 }), { r: .15 }); out.panel.userData.act = { type: 'dns' }; pickables.push(out.panel); g.add(out.panel);
  g.add(box(d.x0 - .3, d.y0 - .3, d.z1, d.x1 + 1.3, d.y1 + .3, d.z1 + .5, M(m.l, { r: .5 }), { r: .15 }));   // a hood over it
  out.decal = decal([d.x1 + .02, (d.y0 + d.y1)/2, (d.z0 + d.z1)/2], [1, 0, 0], [0, -1, 0], 14, 7.2, dnsBoardTex()); g.add(out.decal);
  out.lamp = lamp(d.x1 + .5, d.y1 + .2, d.z1 + 1, LAMP.green, .45); g.add(out.lamp); g.add(ao((d.x0 + d.x1)/2, (d.y0 + d.y1)/2, 8, 18)); return out; }
function boardRows(){ const deps = st.deploys.filter(d => !d.sys || st.showSys).slice(0, 5);
  return deps.map(d => { const live = podsOf(d.app), rd = d.kind === 'Job' ? (d.spawned && !live.length ? d.replicas : live.filter(p => p.phase === 'done').length) : live.filter(isReady).length;
    return { col: palOf(d.app).l, name: d.name, stats: `x${d.replicas}  ${d.kind === 'Job' ? (rd === d.replicas ? 'done' : 'job') : d.version.slice(0, 5)}  running ${rd}`, text: `${d.name}  x${d.replicas}  ${d.kind === 'Job' ? (rd === d.replicas ? 'done' : 'job') : d.version.slice(0, 5)}  running ${rd}`, bad: rd < d.replicas }; }); }
function boardTex(){ const rows = boardRows(), key = 'board|' + JSON.stringify(rows);
  return tex(key, 26, 11, (g, w, h) => { rect(g, 0, 0, w, 2.2, '#1d1f22'); txt(g, 'ORDERS · DEPLOYMENTS', w/2, 1.1, 1.3, WHITE, 800);
    // a row fits the board: the font shrinks a little for a long name, and past that the name is shortened with an ellipsis so the counts stay readable
    rows.forEach((r, i) => { const y = 3.6 + i*1.7, maxW = w - 3.8, col = r.bad ? '#b3261e' : '#1d1f22'; rect(g, 1, y - .6, 1.4, 1.2, r.col, '#1d1f22', .15);
      g.font = `700 .85px ${FONT}`; let name = r.name; while (name.length > 4 && g.measureText(`${name}  ${r.stats}`).width > maxW) name = name.slice(0, name.length - 2).replace(/…$/, '') + '…';
      fitTxt(g, `${name}  ${r.stats}`, 3.2, y, 1.1, maxW, col, 700, 'left', .85); });
    if (!rows.length) txt(g, 'no orders posted', w/2, 6, 1.3, '#857d6e', 700); }, 24); }
/* the tool crib: a caged store with shelves of crates per app */
function mkCrib(){ const c = CRIB(), g = new THREE.Group(), out = { g, stacks: new THREE.Group(), key: '' }, m = m0();
  g.add(box(c.x0, c.y0, 0, c.x1, c.y1, 1.2, M(CONCRETE, { r: .85 }), { r: .2 }));
  const cage = own('#3a3d42', { a: .45, r: .5, m: .5 }); cage.depthWrite = false; cage.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(boxG(c.x1 - c.x0, c.h, c.y1 - c.y0), cage); mesh.position.copy(V3((c.x0 + c.x1)/2, (c.y0 + c.y1)/2, c.h/2 + 1.2)); mesh.castShadow = false; mesh.userData.act = { type: 'registry' }; pickables.push(mesh); g.add(mesh);
  for (const [x, y] of [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1], [c.x1, (c.y0 + c.y1)/2], [c.x0, (c.y0 + c.y1)/2]]) g.add(rod([x, y, 0], [x, y, c.h + 1.2], .7, M(YEL, { r: .5 })));
  g.add(box(c.x0 - .5, c.y0 - .5, c.h + 1.2, c.x1 + .5, c.y1 + .5, c.h + 2.4, M(m.l, { r: .5 }), { r: .3 }));
  const sign = decal([c.x1 + .02, (c.y0 + c.y1)/2, c.h + 1.8], [1, 0, 0], [0, -1, 0], 30, 1.4, tex('cribsign', 30, 1.4, (g, w, h) => txt(g, 'TOOL CRIB · IMAGE REGISTRY', w/2, h/2, 1.1, WHITE), 24)); g.add(sign);
  for (const z of [1.2, 7.4, 13.6]) g.add(box(c.x0 + 2, c.y0 + 2, z, c.x1 - 2, c.y1 - 2, z + .5, M(STEEL, { r: .4, m: .5 }), { r: 0 }));
  g.add(out.stacks); g.add(ao((c.x0 + c.x1)/2, (c.y0 + c.y1)/2, c.x1 - c.x0 + 10, c.y1 - c.y0 + 10)); return out; }
function crate(x0, y0, z0, pm, app, ver, w = 7, d = 7, h = 5){ const g = new THREE.Group(); g.add(box(x0, y0, z0, x0 + w, y0 + d, z0 + h, M(pm.l, { r: .55 }), { r: .3 }));
  // the label fits its face whatever the name's length; the tamper seal (the image's signature) sits in the bottom corner beside the version
  g.add(decal([x0 + w + .02, y0 + d/2, z0 + h/2], [1, 0, 0], [0, -1, 0], d - 1, h - 1, tex(`crate|${app}|${ver}|${d}|${h}`, d - 1, h - 1, (g, ww, hh) => { const r = Math.min(.5, hh*.14);
    nameBlock(g, ww, hh, app, ver, { size: Math.min(1.4, hh*.36), vsize: Math.min(1.1, hh*.28), pad: .5, vmax: ww - 2*r - 1.2, yv: .74, yv2: .8 });
    g.fillStyle = '#b3261e'; g.beginPath(); g.arc(ww - r - .2, hh - r - .2, r, 0, Math.PI*2); g.fill(); txt(g, '✓', ww - r - .2, hh - r - .15, r*1.1, WHITE); }, 24))); return g; }
function syncCrib(){ const R = Y.crib, key = st.regApps.map(a => a + ':' + (depOf(a) ? depOf(a).version : 'img') + ':' + palOf(a).l).join(','); if (key === R.key) return; R.key = key;
  dispose(R.stacks); R.stacks = new THREE.Group(); R.g.add(R.stacks); const c = CRIB();
  st.regApps.forEach((app, i) => { const pm = palOf(app), dep = depOf(app), y0 = c.y0 + 4 + (i % 4)*REG_GAP; for (let z = 0; z < 3; z++) R.stacks.add(crate(c.x0 + 4 + z*8, y0, 1.7 + (z % 2)*6.2, pm, app, dep ? dep.version : 'img', 6, 8, 5)); }); }
/* the conveyor along the lane, the sorting station on it, the receiving dock at its head */
function mkConveyor(S){ const beltT = tex('belt', 8, 40, (g, w, h) => { rect(g, 0, 0, w, h, '#2b2e32'); for (let y = 0; y < h; y += 2) line(g, [[.6, y], [w - .6, y]], '#55595f', .5); }, 6); beltT.wrapT = THREE.RepeatWrapping; beltT.repeat.set(1, D/40);
  const belt = new THREE.Mesh(new THREE.PlaneGeometry(8, D), new THREE.MeshStandardMaterial({ map: beltT, roughness: .7, metalness: .2 })); belt.rotation.x = -Math.PI/2; belt.position.copy(V3(LANE, D/2, 2)); belt.receiveShadow = true; S.add(belt);
  for (const x of [LANE - 4.4, LANE + 4.4]) S.add(box(x - .6, 0, 0, x + .6, D, 2.2, M(STEEL, { r: .4, m: .6 }), { r: .2 }));
  for (let y = 4; y < D; y += 24) for (const x of [LANE - 3.5, LANE + 3.5]) S.add(cyl(x, y, 0, 1.9, .9, M(DARKM), { n: 8, shadow: false })); }
function mkStation(){ const s = STATION(), g = new THREE.Group(), out = { g, cases: [], insides: [], key: '' }, m = m0();
  const body = box(s.x0, s.y0, 2, s.x1, s.y1, 12, own(WHITE, { r: .5 }), { r: .5 }); body.userData.act = { type: 'kiosk' }; pickables.push(body); g.add(body); out.cases.push(body);
  g.add(box(s.x0 - .6, s.y0 - .6, 12, s.x1 + .6, s.y1 + .6, 13.4, M(m.l, { r: .5 }), { r: .3 }));
  g.add(box(s.x1 - 1, s.y0 + 2, 13.4, s.x1 + .2, s.y1 - 2, 19, M(DARKM, { r: .5 }), { r: .3 }));
  const svc = svcMain(); g.add(decal([s.x1 + .22, (s.y0 + s.y1)/2, 16.2], [1, 0, 0], [0, -1, 0], s.y1 - s.y0 - 5, 4.6, tex(`stsign|${svc ? svc.name + (svc.ports || [])[0] : ''}`, 13, 4.6, (g, w, h) => { txt(g, 'SORTING STATION', w/2, 1.3, 1.1, WHITE); txt(g, svc ? `${svc.name}:${(svc.ports || [])[0] || 80}` : 'no service', w/2, 3.3, 1.5, LAMP.amber); }, 24)));
  g.add(box(s.x1 - 2, s.y0 + 1, 2, s.x1 - 1.2, s.y1 - 1, 7, M('#2b2e32'), { r: .2 })); out.panel = new THREE.Group(); g.add(out.panel);
  const ins = new THREE.Group(); ins.add(box(s.x0 + 2, s.y0 + 2, 2, s.x0 + 5, s.y1 - 2, 9, M('#4a4f55', { r: .5, m: .3 }), { r: .3 })); for (let i = 0; i < 5; i++) ins.add(rod([s.x0 + 5, s.y0 + 4 + i*2.4, 7], [s.x0 + 9, s.y0 + 4 + i*2.4, 7], .3, M('#2d7bd6')));
  g.add(ins); out.insides.push(ins); g.add(ao((s.x0 + s.x1)/2, (s.y0 + s.y1)/2, 24, 28)); return out; }
function mkDock(){ const d = DOCK(), g = new THREE.Group(), out = { g }, m = m0(), ing = st.ingresses[0], host = ing ? ing.host : 'ingress';
  for (const x of [d.x0, d.x1 - 3]) g.add(box(x, d.y0, 0, x + 3, d.y1, 20, M(m.l, { r: .5 }), { r: .4 }));
  const beam = box(d.x0 - 1, d.y0 - .5, 20, d.x1 + 1, d.y1 + .5, 25, M(m.l, { r: .5 }), { r: .4 }); beam.userData.act = { type: 'gate' }; pickables.push(beam); g.add(beam);
  g.add(decal([(d.x0 + d.x1)/2, d.y1 + .52, 22.5], [0, 1, 0], [1, 0, 0], d.x1 - d.x0 - 4, 3.2, tex(`host|${host}`, d.x1 - d.x0 - 4, 3.2, (g, w, h) => txt(g, host, w/2, h/2, 1.9, WHITE), 24)));
  g.add(decal([(d.x0 + d.x1)/2, d.y0 - .52, 22.5], [0, -1, 0], [-1, 0, 0], d.x1 - d.x0 - 4, 3.2, tex('dockin', d.x1 - d.x0 - 4, 3.2, (g, w, h) => txt(g, 'RECEIVING · INGRESS', w/2, h/2, 1.7, WHITE), 24)));
  out.door = new THREE.Group(); out.door.add(box(d.x0 + 3, d.y0 + 4, 0, d.x1 - 3, d.y0 + 5.2, 20, M('#6b7076', { r: .55, m: .3 }), { r: .2 })); for (let z = 2; z < 20; z += 3) out.door.add(box(d.x0 + 3.2, d.y0 + 4.1, z, d.x1 - 3.2, d.y0 + 5.3, z + .4, M('#3a3e43'), { r: 0, shadow: false }));
  g.add(out.door); out.lamp = lamp(d.x1 - 1.5, d.y1 + 1, 21, LAMP.red, .8); g.add(out.lamp); return out; }
/* a work cell */
function bayTex(n){ const w = n.depth, h = SLW; return tex(`bays|${w}`, w, h, (g, ww, hh) => { rect(g, 0, 0, ww, hh, '#b3afa6'); for (let i = 0; i < 600; i++){ g.fillStyle = `rgba(70,66,60,${.04 + Math.random()*.06})`; g.fillRect(Math.random()*ww, Math.random()*hh, .5 + Math.random()*1.2, .5 + Math.random()*1.2); } }, 8); }
// the bay outlines: dashed white lines lying flat, built in world coordinates so they sit exactly under the machines
function bayLines(n){ const rows = cellRows(n), pos = [], dash = 1.2, gap = .9, wdt = .36, z = .18;
  const quad = (x0, y0, x1, y1) => { pos.push(x0, z, y0, x1, z, y1, x1, z, y0, x0, z, y0, x0, z, y1, x1, z, y1); };   // wound to face up
  const seg = (ax, ay, bx, by) => { const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax)/L, uy = (by - ay)/L; for (let d = 0; d < L; d += dash + gap){ const e = Math.min(L, d + dash);
    const x0 = ax + ux*d, y0 = ay + uy*d, x1 = ax + ux*e, y1 = ay + uy*e; if (Math.abs(ux) > .5) quad(Math.min(x0, x1), y0 - wdt/2, Math.max(x0, x1), y0 + wdt/2); else quad(x0 - wdt/2, Math.min(y0, y1), x0 + wdt/2, Math.max(y0, y1)); } };
  for (let r = 0; r < rows; r++) for (let c = 0; c < SHOP_COLS; c++){ const [sx, sy] = slotPos(n, { c, r, t:0 }), x0 = sx - .8, y0 = sy - .8, x1 = sx + MW + .8, y1 = sy + ML + .8; seg(x0, y0, x1, y0); seg(x1, y0, x1, y1); seg(x1, y1, x0, y1); seg(x0, y1, x0, y0); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: WHITE, roughness: .8, polygonOffset: true, polygonOffsetFactor: -1 })); m.receiveShadow = true; m.castShadow = false; return m; }
function mkNode(n){
  const g = new THREE.Group(), out = { g, cases: [], insides: [], key: '', crates: new THREE.Group(), crateKey: '' }, c = cellBox(n), cb = cabinet(n), rk = rackOf(n), m = m0();
  out.rise = new THREE.Group(); g.add(out.rise);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(c.x1 - c.x0, c.y1 - c.y0), new THREE.MeshStandardMaterial({ map: bayTex(n), roughness: .9 })); plate.rotation.x = -Math.PI/2; plate.position.copy(V3((c.x0 + c.x1)/2, (c.y0 + c.y1)/2, .12)); plate.receiveShadow = true; plate.userData.act = { type: 'node', node: n.name }; pickables.push(plate); out.plate = plate; out.rise.add(plate); out.rise.add(bayLines(n));
  out.rise.add(decal([c.x1 - 3, (c.y0 + c.y1)/2, .2], [0, 0, 1], [0, -1, 0], 40, 4, tex(`cellname|${n.name}`, 40, 4, (g, w, h) => txt(g, n.name.toUpperCase(), w/2, h/2, 3.2, '#5e5a52'), 12)));   // reads left to right from the front, tops toward the back of the hall
  // the cell's PodCIDR (where its machines' addresses come from) and the routes to the other cells' ranges, painted under the name
  const ni = Math.max(0, st.nodes.indexOf(n)), cidr = k => `10.200.${k}.0/24`, others = st.nodes.filter(m => m !== n).slice(0, 3);
  out.rise.add(decal([c.x1 - 7.1, (c.y0 + c.y1)/2, .2], [0, 0, 1], [0, -1, 0], 40, 2.4, tex(`cidr|${ni}`, 40, 2.4, (g, w, h) => txt(g, `PodCIDR ${cidr(ni)}`, w/2, h/2, 1.7, '#5e5a52'), 12)));
  // the host's routes to the other cells' ranges, one per line, painted on the free strip in front of the fence (the lanes start there)
  if (others.length){ const lh = 1.6, rh = 1.3 + lh*(others.length + 1); out.rise.add(decal([c.x1 + 1.2 + rh/2, (c.y0 + c.y1)/2, .2], [0, 0, 1], [0, -1, 0], 36, rh, tex(`routes|${ni}|${others.map(m => m.name).join(',')}`, 36, rh, (g, w, h) => {
    txt(g, `ROUTES FROM ${n.name.toUpperCase()}`, w/2, .9, 1.2, '#5e5a52'); others.forEach((m, k) => txt(g, `${cidr(st.nodes.indexOf(m))}  via  ${m.name}`, w/2, 2.1 + lh*k + .5, 1.25, '#6f6a60', 800)); }, 12))); }
  const nx = st.nodes[ni + 1]; if (nx && nx.row === n.row) out.rise.add(decal([c.x1 - 9, c.y1 + NGAP/2, .2], [0, 0, 1], [0, -1, 0], 14, 2.6, tex('route', 14, 2.6, (g, w, h) => txt(g, 'ROUTE', w/2, h/2, 2, '#e3c766'), 12)));   // the lane between two cells is the route between their ranges
  // the fence: yellow posts and mesh panels, open along the aisle side (the cabinet side) for the AGV
  const postM = M(YEL, { r: .5 }), panelM = own('#4a4e54', { a: .35, r: .5, m: .4 }); panelM.depthWrite = false; panelM.side = THREE.DoubleSide;
  const edges = [[[c.x0, c.y0], [c.x1, c.y0]], [[c.x1, c.y0], [c.x1, c.y1 - 9]], [[c.x1, c.y1 - 1], [c.x1, c.y1]], [[c.x1, c.y1], [c.x0, c.y1]]];   // the gap at y1-9..y1-1 is the parts' way in
  for (const y of [c.y1 - 9, c.y1 - 1]) out.rise.add(cyl(c.x1, y, 0, 9.6, .7, M(DARKM, { r: .4 }), { n: 10 }));
  for (const [a, b] of edges){ const L = Math.hypot(b[0] - a[0], b[1] - a[1]), nseg = Math.max(1, Math.round(L/16));
    for (let i = 0; i <= nseg; i++){ const t = i/nseg; out.rise.add(cyl(a[0] + (b[0] - a[0])*t, a[1] + (b[1] - a[1])*t, 0, 9, .5, postM, { n: 8 })); }
    const p = new THREE.Mesh(boxG(L, 7.5, .15), panelM); p.position.copy(V3((a[0] + b[0])/2, (a[1] + b[1])/2, 5)); p.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); p.castShadow = false; out.rise.add(p);
    out.rise.add(rod([a[0], a[1], 9], [b[0], b[1], 9], .35, postM)); }
  // the controller cabinet (kubelet) with its job board, gauge and lamp; the drive unit and the switch inside
  const cab = box(cb.x0, cb.y0, 0, cb.x1, cb.y1, cb.h, own('#6b7178', { r: .45, m: .35 }), { r: .4 }); cab.userData.act = { type: 'node', node: n.name }; pickables.push(cab); out.rise.add(cab); out.cases.push(cab);
  out.rise.add(box(cb.x0 - .3, cb.y0 - .3, cb.h, cb.x1 + .3, cb.y1 + .3, cb.h + .8, M(m.l, { r: .5 }), { r: .2 }));
  out.jobBoard = box(cb.x1 - .2, cb.y0 + 1, 9.5, cb.x1 + .5, cb.y1 - 1, 13.5, M(WHITE, { r: .5 }), { r: .15 }); out.rise.add(out.jobBoard);
  out.rise.add(decal([cb.x1 + .52, (cb.y0 + cb.y1)/2, 11.5], [1, 0, 0], [0, -1, 0], 7, 3.4, tex('jobboard', 7, 3.4, (g, w, h) => { txt(g, 'KUBELET', w/2, 1, 1, '#1d1f22'); txt(g, 'job board', w/2, 2.5, .9, '#5e5a52', 700); }, 24)));
  out.gauge = new THREE.Group(); out.rise.add(out.gauge); out.gaugeKey = '';
  // the cabinet's badge: the kubelet's client certificate, stamped at join, renewed on rotation (it flashes), red once expired
  out.badge = decal([cb.x1 + .52, cb.y1 - 4.2, 3.4], [1, 0, 0], [0, -1, 0], 5.2, 2.2, idBadgeTex(true, n.name)); out.badge.visible = false; out.rise.add(out.badge); out.badgeKey = '';
  out.badgeLamp = lamp(cb.x1 + .5, cb.y1 - 7.2, 3.4, LAMP.amber, .3); setLamp(out.badgeLamp, LAMP.amber, false); out.rise.add(out.badgeLamp);
  // how Service addresses are rewritten here: kube-proxy's iptables chains, or the CNI's eBPF programs in place of kube-proxy
  out.svcDecal = decal([cb.x1 + .52, cb.y1 - 4.2, 1.3], [1, 0, 0], [0, -1, 0], 5.2, 1.2, svcTex(st.net.svc)); out.rise.add(out.svcDecal); out.svcKey = st.net.svc;
  // the BGP speaker on the cabinet (a small mast and flag, shown while the fabric runs BGP) and the konnectivity relay (managed mode)
  out.bgp = new THREE.Group(); out.bgp.add(rod([cb.x1 - 1.5, cb.y0 + 5, cb.h + .8], [cb.x1 - 1.5, cb.y0 + 5, cb.h + 5.2], .18, M(DARKM))); out.bgp.add(box(cb.x1 - 1.6, cb.y0 + 5, cb.h + 3.8, cb.x1 - 1.4, cb.y0 + 7.6, cb.h + 5.2, M('#2d7bd6', { r: .5 }), { r: .1 }));
  out.bgp.add(decal([cb.x1 - 1.38, cb.y0 + 6.3, cb.h + 4.5], [1, 0, 0], [0, -1, 0], 2.4, 1.2, tex('bgpflag', 2.4, 1.2, (g2, w, h) => { rect(g2, 0, 0, w, h, '#2d7bd6'); txt(g2, 'BGP', w/2, h/2, .6, WHITE); }, 48))); out.bgp.visible = false; out.rise.add(out.bgp);
  out.relay = new THREE.Group(); out.relay.add(box(cb.x0 + .8, cb.y0 + .8, cb.h + .8, cb.x0 + 4.4, cb.y0 + 4.2, cb.h + 2.6, M('#2b3a66', { r: .5 }), { r: .2 })); out.relay.add(lamp(cb.x0 + 4.2, cb.y0 + 2.5, cb.h + 2.9, LAMP.blue, .3));
  out.relay.add(decal([cb.x0 + 4.42, cb.y0 + 2.5, cb.h + 1.7], [1, 0, 0], [0, -1, 0], 3.2, 1.4, tex('relay', 3.2, 1.4, (g2, w, h) => { txt(g2, 'RELAY', w/2, .45, .5, WHITE); txt(g2, 'konnectivity', w/2, 1.05, .42, '#c9d2ea', 700); }, 48))); out.relay.visible = false; out.rise.add(out.relay);
  out.lamp = lamp(cb.x1 - 1.2, cb.y0 + 1.5, cb.h + 1.8, LAMP.green, .8); out.rise.add(out.lamp); out.rise.add(cyl(cb.x1 - 1.2, cb.y0 + 1.5, cb.h + .8, cb.h + 1.4, .5, M(DARKM), { n: 8 }));
  const ins = new THREE.Group(); ins.add(box(cb.x0 + 1, cb.y0 + 1, 1, cb.x1 - 1, cb.y0 + 4.5, 6, M('#2b2e32', { r: .4 }), { r: .2 })); ins.add(cyl((cb.x0 + cb.x1)/2, cb.y0 + 2.7, 6, 9, 1.4, M(STEEL, { r: .3, m: .7 }), { n: 12 }));
  ins.add(box(cb.x0 + 1, cb.y1 - 5, 1, cb.x1 - 1, cb.y1 - 1.5, 4, M('#1f2226', { r: .4 }), { r: .2 })); for (let i = 0; i < 4; i++) ins.add(lamp(cb.x1 - 1, cb.y1 - 4.4 + i*.9, 4.3, [LAMP.green, LAMP.amber, LAMP.blue, LAMP.green][i], .25));
  for (let i = 0; i < 3; i++) ins.add(rod([cb.x1 - 1, cb.y1 - 4 + i*1.2, 4], [cb.x1 - 1, cb.y1 - 4 + i*1.2, 8 + i*1.5], .22, M('#2d7bd6')));
  g.add(ins); out.insides.push(ins);
  // the tool rack: the node's image cache, a crate per image it has pulled
  out.rise.add(box(rk.x0, rk.y0, 0, rk.x1, rk.y1, .8, M(STEEL, { r: .4, m: .5 }), { r: .1 })); for (const z of [5.5, 10.5]) out.rise.add(box(rk.x0, rk.y0, z, rk.x1, rk.y1, z + .4, M(STEEL, { r: .4, m: .5 }), { r: 0 }));
  for (const [x, y] of [[rk.x0 + .4, rk.y0 + .4], [rk.x1 - .4, rk.y0 + .4], [rk.x0 + .4, rk.y1 - .4], [rk.x1 - .4, rk.y1 - .4]]) out.rise.add(rod([x, y, 0], [x, y, rk.h], .3, M(STEEL, { r: .4, m: .5 })));
  out.rise.add(decal([rk.x1 + .42, (rk.y0 + rk.y1)/2, rk.h - 1], [1, 0, 0], [0, -1, 0], 10, 1.4, tex('racksign', 10, 1.4, (g, w, h) => txt(g, 'IMAGE CACHE', w/2, h/2, 1, '#1d1f22'), 24)));
  out.rise.add(out.crates);
  // the cell's branch of the tube, unlit until the cell joins; a power strip on the cabinet that lights with it; the gate on the opening, closed until Ready
  out.branch = new THREE.Group(); const bm = own(GLASS, { a: .32, r: .15, m: .1 }); bm.depthWrite = false; const tp = tubePath(n); for (let i = 7; i < tp.length - 1; i++) out.branch.add(rod(tp[i], tp[i + 1], 1.1, bm)); const dr = cellDoor(n); out.branch.add(cyl(dr[0], dr[1], dr[2] + 3, dr[2] + 5, 1.6, M(DARKM, { r: .4 }), { n: 12 })); g.add(out.branch);
  out.power = box(cb.x1 - .1, cb.y0 + 3.4, 5.5, cb.x1 + .25, cb.y1 - 1.4, 6.5, own('#ffe3a0', { e: 1.4, r: .4 }), { r: .1, shadow: false }); out.rise.add(out.power);
  out.gate = new THREE.Group(); for (const z of [3, 6.5]) out.gate.add(rod([c.x1, c.y1 - 9, z], [c.x1, c.y1 - 1, z], .35, M(YEL, { r: .5 }))); out.gate.add(decal([c.x1 + .4, c.y1 - 5, 4.8], [1, 0, 0], [0, -1, 0], 6, 1.6, tex('gateclosed', 6, 1.6, (g, w, h) => { rect(g, 0, 0, w, h, YEL); txt(g, 'NOT READY', w/2, h/2, .9, '#1d1f22'); }, 40))); g.add(out.gate);
  // the AGV
  const h = agvHome(n); out.agv = new THREE.Group(); out.agv.add(box(-3, -4, .6, 3, 4, 2.4, M(YEL, { r: .5 }), { r: .5 })); out.agv.add(box(-2.6, -3.6, 2.4, 2.6, 3.6, 2.9, M(DARKM), { r: .2 }));
  for (const [dx, dy] of [[-2.2, -3], [2.2, -3], [-2.2, 3], [2.2, 3]]){ const w = new THREE.Mesh(cylG(.8, .8, .8, 10), M('#1f2226')); w.rotation.z = Math.PI/2; w.position.copy(V3(dx, dy, .8)); out.agv.add(w); }
  out.agvLamp = lamp(0, -3.2, 3.3, LAMP.amber, .4); out.agv.add(out.agvLamp); out.agvCrate = new THREE.Group(); out.agv.add(out.agvCrate); out.agv.position.copy(V3(...h)); g.add(out.agv);
  // presses for the GPUs along the cell's front margin
  out.presses = []; for (let i = 0; i < (n.gpus || 0); i++){ const px = c.x0 + 5 + i*14, py = c.y0 + .8; const P = new THREE.Group();
    P.add(box(px, py, 0, px + 8, py + 6, 3, M(DARKM), { r: .3 })); P.add(box(px + .8, py + .6, 3, px + 7.2, py + 5.4, 14, M('#5a6068', { r: .4, m: .4 }), { r: .4 })); P.add(box(px - .3, py - .2, 14, px + 8.3, py + 6.2, 17, M(YEL, { r: .5 }), { r: .4 }));
    for (const [dx, dy] of [[1.4, 1], [6.6, 1], [1.4, 5], [6.6, 5]]) P.add(rod([px + dx, py + dy, 3], [px + dx, py + dy, 14], .45, M(STEEL, { r: .3, m: .7 })));
    const led = lamp(px + 4, py + 6.1, 15.5, LAMP.green, .5); P.add(led); P.add(decal([px + 4, py - .22, 9], [0, -1, 0], [-1, 0, 0], 6, 2, tex('gpu', 6, 2, (g, w, h) => txt(g, 'GPU PRESS', w/2, h/2, 1, WHITE), 24))); out.presses.push(led); out.rise.add(P); }
  // cordon: tape on posts around the cell and a sign
  out.tape = new THREE.Group(); const corners = [[c.x0 - 2, c.y0 - 2], [c.x1 + 2, c.y0 - 2], [c.x1 + 2, c.y1 + 2], [c.x0 - 2, c.y1 + 2]]; out.posts = []; out.tapes = [];
  const tapeT = tex('tape', 20, 1, (g, w, h) => hatch(g, 0, 0, w, h, YEL, '#1d1f22'), 12); tapeT.wrapS = THREE.RepeatWrapping;
  for (const [x, y] of corners){ const p = rod([x, y, 0], [x, y, 1], .5, M('#d8d5cd', { r: .5 })); out.tape.add(p); out.posts.push([p, x, y]); }
  for (let i = 0; i < 4; i++){ const a = corners[i], b = corners[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]); const t = tapeT.clone(); t.repeat.set(L/20, 1); t.needsUpdate = true;
    const tp = new THREE.Mesh(boxG(L, 1.1, .2), new THREE.MeshStandardMaterial({ map: t, roughness: .6, transparent: true })); tp.material.userData.base = 1; tp.position.copy(V3((a[0] + b[0])/2, (a[1] + b[1])/2, 8)); tp.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); tp.castShadow = false; out.tape.add(tp); out.tapes.push(tp); }
  const my = (c.y0 + c.y1)/2; out.sign = box(c.x1 + 1.6, my - 8, 4, c.x1 + 2, my + 8, 9, own(WHITE, { r: .5 }), { r: .15 }); out.tape.add(out.sign);
  out.signDecal = decal([c.x1 + 2.02, my, 6.5], [1, 0, 0], [0, -1, 0], 15, 4, tex('maint', 15, 4, (g, w, h) => { rect(g, 0, 0, w, h, YEL); txt(g, 'MAINTENANCE', w/2, 1.5, 1.7, '#1d1f22'); txt(g, 'cordoned · no new jobs', w/2, 3.1, .95, '#1d1f22', 700); }, 24)); out.tape.add(out.signDecal);
  g.add(out.tape);
  // the break: with the uplink cut, a red cross on the belt into the cell and on the tube above it, just inside the corridor
  out.cut = new THREE.Group(); { const b = breakAt(n), red = own('#e2483d', { e: 1.8, r: .5 });
    for (const s of [1, -1]){ const bar = box(-.35, -2.9, .15, .35, 2.9, .9, red, { r: .1 }); const gg = new THREE.Group(); gg.add(bar); gg.position.copy(V3(b.x, b.y, 0)); gg.rotation.y = s*Math.PI/4; out.cut.add(gg); }
    for (const s of [1, -1]){ const bar = box(-.3, -2.3, -.3, .3, 2.3, .3, red, { r: .1 }); const gg = new THREE.Group(); gg.add(bar); gg.position.copy(V3(b.x, b.ty, TZ)); gg.rotation.x = s*Math.PI/4; out.cut.add(gg); }
    out.cut.add(rod([b.x - 1.2, b.ty, TZ], [b.x + 1.2, b.ty, TZ], 1.45, red)); out.cutLamp = lamp(b.x, b.y - 4, 3, LAMP.red, .45); out.cut.add(out.cutLamp); }
  out.cut.visible = false; g.add(out.cut);
  g.add(ao((c.x0 + c.x1)/2, (c.y0 + c.y1)/2, c.x1 - c.x0 + 24, c.y1 - c.y0 + 10)); return out;
}
const svcTex = mode => tex('svc|' + mode, 5.2, 1.2, (g, w, h) => { rect(g, 0, 0, w, h, mode === 'ebpf' ? '#1f4034' : '#3a3d42'); txt(g, mode === 'ebpf' ? 'eBPF · no kube-proxy' : 'kube-proxy · iptables', w/2, h/2, .5, WHITE); }, 48);
function gaugeMesh(n, out){ const cb = cabinet(n), cap = cellCap(), frac = Math.min(1, n.used.size/cap), q = Math.round(frac*20)/20, key = q + '|' + cap; if (out.gaugeKey === key) return; out.gaugeKey = key;
  dispose(out.gauge); out.gauge = new THREE.Group(); out.rise.add(out.gauge); const col = frac > .85 ? LAMP.red : frac > .6 ? LAMP.amber : LAMP.green;
  out.gauge.add(box(cb.x1 - .1, cb.y0 + 1, 2, cb.x1 + .3, cb.y0 + 2.6, 8.5, M('#1f2226'), { r: .1 })); out.gauge.add(box(cb.x1 + .3, cb.y0 + 1.2, 2.2, cb.x1 + .5, cb.y0 + 2.4, 2.2 + Math.max(.2, 6.1*q), own(col, { e: 1.4, r: .4 }), { r: 0, shadow: false })); }
function syncNodes(dt){
  const seen = new Set(), k = ease(st.xr || 0);
  for (const n of st.nodes){ seen.add(n.name); let N = Y.nodes.get(n.name); if (!N){ N = mkNode(n); Y.nodes.set(n.name, N); scene.add(N.g); }
    // a cell is there before it joins, dark: no power, no andon, gate shut, its tube branch unlit; the join lights it, Ready opens the gate
    const j = ease(n.joined); N.tape.visible = n.tape > 0; N.gauge.visible = j >= 1; N.gate.visible = !n.ready;
    N.power.material.emissiveIntensity = 1.6*j; N.power.material.color.set(j > 0 ? '#ffe3a0' : '#3a3d42'); if (N.jk !== j){ N.jk = j; setAlpha(N.branch, .12 + .88*j); }
    const used = gpuUsed(n); N.presses.forEach((l, i) => setLamp(l, i < used ? LAMP.amber : LAMP.green, j >= 1));
    const lc = n.ready ? (n.cordoned ? LAMP.amber : LAMP.green) : n.joined < 1 ? null : st.boot ? LAMP.amber : LAMP.red; setLamp(N.lamp, lc || LAMP.red, !!lc); gaugeMesh(n, N);
    N.cut.visible = !!n.cut; if (n.cut) setLamp(N.cutLamp, LAMP.red, Math.floor(n.cutT*3) % 2 === 0);
    N.bgp.visible = st.net.fabric === 'bgp' && j >= 1; N.relay.visible = st.net.managed && j >= 1; if (N.svcKey !== st.net.svc){ N.svcKey = st.net.svc; N.svcDecal.material.map = svcTex(st.net.svc); N.svcDecal.material.needsUpdate = true; }
    if (n.cert){ N.badge.visible = true; const bk = n.cert.ok ? 'ok' : 'bad'; if (N.badgeKey !== bk){ N.badgeKey = bk; N.badge.material.map = idBadgeTex(n.cert.ok, n.name); N.badge.material.needsUpdate = true; }
      const f = n.cert.flash || 0; N.badge.scale.setScalar(1 + .5*Math.sin(Math.min(1, f/.9)*Math.PI)); setLamp(N.badgeLamp, LAMP.amber, f > 0 && Math.floor(f*8) % 2 === 0); }
    else { N.badge.visible = false; setLamp(N.badgeLamp, LAMP.amber, false); }
    // the rack holds a crate per image this node has pulled
    const ck = [...(n.cache || [])].sort().join(','); if (ck !== N.crateKey){ N.crateKey = ck; dispose(N.crates); N.crates = new THREE.Group(); N.rise.add(N.crates); const rk = rackOf(n);
      [...(n.cache || [])].sort().slice(0, 6).forEach((key, i) => { const [app, ver] = key.split(':'); N.crates.add(crate(rk.x0 + .5, rk.y0 + 1 + (i % 3)*4.8, .8 + Math.floor(i/3)*5, palOf(app), app, ver, 5, 4.2, 3.8)); }); }
    // the AGV: out to the crib or the rack and back with the crate while the node pulls
    const h = agvHome(n); if (n.pull){ const u = n.pull.t/n.pull.dur, path = agvPath(n, n.pull.warm), tt = u < .5 ? u*2 : 2 - u*2, p = along(path, ease(Math.min(1, tt)));
      N.agv.position.copy(V3(...p)); const back = u >= .5; if (N.agvHas !== back + ':' + n.pull.pod.app){ N.agvHas = back + ':' + n.pull.pod.app; dispose(N.agvCrate); N.agvCrate = new THREE.Group(); N.agv.add(N.agvCrate); if (back) N.agvCrate.add(crate(-2.5, -2.5, 2.9, palOf(n.pull.pod.app), n.pull.pod.app, n.pull.pod.ver, 5, 5, 3.6)); }
      setLamp(N.agvLamp, LAMP.amber); } else { N.agv.position.copy(V3(...h)); if (N.agvHas){ N.agvHas = ''; dispose(N.agvCrate); N.agvCrate = new THREE.Group(); N.agv.add(N.agvCrate); } setLamp(N.agvLamp, LAMP.green, j >= 1); }
    if (n.tape > 0){ for (const [p, x, y] of N.posts) rodTo(p, [x, y, 0], [x, y, .5 + 8*n.tape], .5); for (const tp of N.tapes) tp.position.y = 8*n.tape; N.sign.visible = N.signDecal.visible = n.tape > .9; setAlpha(N.tape, n.tape); }
    if (N.k !== k){ N.k = k; for (const c of N.cases) setAlpha(c, 1 - .78*k); for (const i of N.insides){ i.visible = k > 0; if (k > 0) setAlpha(i, k); } }
  }
  for (const [name, N] of Y.nodes) if (!seen.has(name)){ dispose(N.g); Y.nodes.delete(name); N.g.traverse(o => { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); }); }
}
/* machines */
function verTex(pm, app, ver, gpu, sys){ return tex(`ver|${app}|${ver}|${gpu || 0}|${sys ? 1 : 0}`, ML - 2, MH - 2.4, (g, w, h) => { nameBlock(g, w, h, app, ver, { size: 1.9, vsize: 1.3, y1: sys ? .4 : .36, yv: gpu ? .64 : .7, yv2: gpu ? .68 : .76 }); if (gpu){ rect(g, w/2 - 2.6, h - 1.3, 5.2, 1.1, YEL); txt(g, `GPU x${gpu}`, w/2, h - .75, .8, '#1d1f22'); }
  if (sys){ rect(g, 0, 0, w, 1, '#2b3a66'); txt(g, 'kube-system', w/2, .5, .62, WHITE, 800); } }, 24); }   // a system pod wears its namespace as a band
function mkPod(p){
  const g = new THREE.Group(), pm = palOf(p.app), out = { g, key: '', pm, machine: new THREE.Group(), card: null, fire: null };
  out.body = box(0, 0, 0, MW, ML, MH - 1.5, own(pm.l, { r: .42, m: .18 }), { r: .7 }); out.body.userData.act = { type: 'pod', id: p.id }; pickables.push(out.body); out.machine.add(out.body);
  out.machine.add(box(.6, .6, MH - 1.5, MW - .6, ML - .6, MH, own('#2b2e32', { r: .5, m: .3 }), { r: .3 }));
  out.decal = decal([MW + .02, ML/2, (MH - 1.5)/2], [1, 0, 0], [0, -1, 0], ML - 2, MH - 2.4, verTex(pm, p.app, p.ver, p.gpu, p.sys)); out.decal.material.userData.base = 1; out.machine.add(out.decal);
  out.spindle = new THREE.Group(); out.spindle.add(cyl(0, 0, 0, 1.6, 1.2, own(STEEL, { r: .3, m: .8 }), { n: 12 })); out.spindle.add(box(-.3, -1.3, 1.6, .3, 1.3, 2.2, own(DARKM), { r: .1 })); out.spindle.position.copy(V3(MW*.35, ML*.35, MH)); out.machine.add(out.spindle);
  out.machine.add(cyl(MW - 1.6, ML - 1.6, MH, MH + 2, .35, own(DARKM), { n: 8 }));
  out.andon = [LAMP.green, LAMP.amber, LAMP.red].map((c, i) => { const l = new THREE.Mesh(cylG(.9, .9, 1.1, 12), own(c, { e: 2.6, r: .3 })); l.position.copy(V3(MW - 1.6, ML - 1.6, MH + 2.6 + i*1.2)); l.castShadow = false; out.machine.add(l); setLamp(l, c, false); return l; });
  const ins = new THREE.Group(); p.containers.forEach((c, i) => { const w = i ? 2.2 : 3.4, h = i ? 2.4 : 3.6; ins.add(box(1.5 + i*(w + .8), 1.2, 1.2, 1.5 + i*(w + .8) + w, 1.2 + 2.6, 1.2 + h, own(i ? '#c9a066' : '#e8e1d2', { r: .5 }), { r: .25 })); });
  ins.add(box(1.2, ML - 2.8, 2.2, 2.6, ML - 1.2, 3.8, own('#2d7bd6', { r: .4, m: .4 }), { r: .2 })); ins.add(rod([2.6, ML - 2, 3], [MW - .5, ML - 2, 3], .25, own('#2d7bd6')));
  out.inside = ins; ins.visible = false; out.machine.add(ins);
  if (p.configMap){ const sh = box(MW - .2, 1.2, 2.2, MW + .3, 5.4, 6.6, own(WHITE, { r: .6 }), { r: .1 }); out.machine.add(sh); out.machine.add(decal([MW + .32, 3.3, 4.4], [1, 0, 0], [0, -1, 0], 3.8, 4, tex('setup', 3.8, 4, (g, w, h) => { for (let y = 1.7; y < h; y += .7) line(g, [[.4, y], [w - .4, y]], '#8a8580', .18); txt(g, 'SETUP', w/2, .5, .6, '#1d1f22'); txt(g, 'CONFIGMAP', w/2, 1.15, .42, '#5e5a52', 800); }, 32))); }
  if (p.secret){ out.machine.add(box(-1.8, ML - 4, 0, -.2, ML - 1, 2.6, own('#3a3d42', { r: .5, m: .4 }), { r: .2 }));
    out.machine.add(decal([-1.82, ML - 2.5, 1.3], [-1, 0, 0], [0, 1, 0], 2.6, 2.2, tex('secretdoor', 2.6, 2.2, (g, w, h) => { txt(g, 'SECRET', w/2, .5, .5, WHITE, 800); g.strokeStyle = '#e8b923'; g.lineWidth = .14; g.beginPath(); g.arc(w/2, 1.3, .32, Math.PI, 0); g.stroke(); rect(g, w/2 - .42, 1.3, .84, .6, '#e8b923'); }, 48))); }
  if (p.pvc){ out.machine.add(box(-.4, -.4, 0, MW + .4, ML + .4, .5, own('#8e6236', { r: .7 }), { r: .1 })); out.machine.add(decal([MW + .42, ML/2, .25], [1, 0, 0], [0, -1, 0], 6, .4, tex(`pvtag|${p.pvc}`, 6, .4, (g, w, h) => txt(g, 'PVC ' + p.pvc.slice(0, 12), w/2, h/2, .32, WHITE), 60))); }
  // the visitor pass (a bound ServiceAccount token) hung on the machine's side
  out.machine.add(box(2, -.25, 2.8, 4, -.02, 5.4, own(WHITE, { r: .6 }), { r: .08 })); out.machine.add(decal([3, -.27, 4.1], [0, -1, 0], [-1, 0, 0], 1.8, 2.4, tex('pass', 1.8, 2.4, (g, w, h) => { rect(g, 0, 0, w, .55, '#2d7bd6'); txt(g, 'PASS', w/2, .28, .38, WHITE); txt(g, 'SA', w/2, 1.15, .62, '#1d1f22'); txt(g, 'token', w/2, 1.8, .4, '#5e5a52', 700); }, 48)));
  // the policy gate on the machine's spur: drawn only while a NetworkPolicy selects this app; the boom lifts for a part the policy allows
  out.gate = new THREE.Group(); for (const y of [1.2, ML - 1.2]) out.gate.add(cyl(MW + 2.6, y, 0, 4.2, .3, own(YEL, { r: .5 }), { n: 8 }));
  out.boom = rod([MW + 2.6, 1.2, 2.8], [MW + 2.6, ML - 1.2, 2.8], .26, own('#e2483d', { r: .5 })); out.gate.add(out.boom); out.boomUp = 0;
  out.gateLamp = lamp(MW + 2.6, ML/2, 4.6, LAMP.red, .35); out.gate.add(out.gateLamp);
  out.gate.add(box(MW + 2.45, ML/2 - 1.7, .9, MW + 2.75, ML/2 + 1.7, 2.2, own(WHITE, { r: .6 }), { r: .08 })); out.gate.add(decal([MW + 2.77, ML/2, 1.55], [1, 0, 0], [0, -1, 0], 3.2, 1.1, tex('polsign', 3.2, 1.1, (g, w, h) => { rect(g, 0, 0, w, h, '#e2483d'); txt(g, 'NETWORK POLICY', w/2, h/2, .36, WHITE); }, 60)));
  out.gate.visible = false; g.add(out.gate);
  // the escort: the sidecar proxy riding on a meshed machine, handling its parts in and out
  out.escort = new THREE.Group(); out.escort.add(box(5.4, -1.3, .3, 7.8, -.02, 3.2, own('#3b2a66', { r: .5, m: .2 }), { r: .25 })); out.escort.add(lamp(7.5, -1.4, 3.4, LAMP.blue, .25));
  out.escort.add(decal([6.6, -1.32, 1.75], [0, -1, 0], [-1, 0, 0], 2.2, 2.4, tex('escort', 2.2, 2.4, (g2, w, h) => { txt(g2, 'ESCORT', w/2, .6, .48, WHITE); txt(g2, 'sidecar', w/2, 1.3, .42, '#d9c8ff', 700); txt(g2, 'proxy', w/2, 1.9, .42, '#d9c8ff', 700); }, 48))); out.escort.visible = false; out.machine.add(out.escort);
  out.machine.add(ao(MW/2, ML/2, MW + 6, ML + 6)); g.add(out.machine);
  // the job card on the bay while the cell waits for the image
  out.card = new THREE.Group(); out.card.add(box(MW/2 - 2.2, ML/2 - 1.4, 1.2, MW/2 + 2.2, ML/2 + 1.4, 1.5, own(WHITE, { r: .6 }), { r: .1 })); out.card.add(rod([MW/2, ML/2, 0], [MW/2, ML/2, 1.2], .25, own(DARKM))); g.add(out.card);
  return out;
}
let spinA = 0;
function syncPods(dt){
  const seen = new Set(), k = ease(st.xr || 0); spinA += dt*SPEED*9;
  for (const p of st.pods){ if (!(p.pos && !NOPOS.has(p.phase) && !(p.sys && !st.showSys))) continue; seen.add(p.id);
    let P = Y.pods.get(p.id); if (!P){ P = mkPod(p); Y.pods.set(p.id, P); scene.add(P.g); }
    P.g.position.copy(V3(...p.pos));
    const waiting = p.phase === 'queued' || p.phase === 'pulling' || p.phase === 'staged' || p.phase === 'dropping';
    P.card.visible = waiting; P.machine.visible = !waiting;
    P.escort.visible = st.net.mesh.on && MESHED.has(p.app) && !waiting && p.phase !== 'terminating';
    const pol = st.sec.netpol, gated = !!(pol && pol.to === p.app && !waiting && p.phase !== 'terminating'); P.gate.visible = gated;
    if (gated){ const open = st.parcels.some(pc => pc.pod === p && pc.link && !pc.blocked && pc.L - pc.t < (pc.dir === 1 ? 44 : 12)) ? 1 : 0; P.boomUp = Math.max(0, Math.min(1, P.boomUp + (open ? dt : -dt)*6));   // lifts as an allowed part comes down the aisle, drops once it has left
      rodTo(P.boom, [MW + 2.6, 1.2, 2.8 + 4*ease(P.boomUp)], [MW + 2.6, ML - 1.2, 2.8 + 4*ease(P.boomUp)], .26); setLamp(P.gateLamp, P.boomUp > .5 ? LAMP.green : LAMP.red); }
    if (!waiting){ const up = p.phase === 'creating' ? .25 + .75*ease(Math.min(1, p.phaseT/PULL.start)) : 1; P.machine.scale.set(1, up, 1);
      const bk = `${p.ver}|${p.gpu || 0}|${p.sys ? 1 : 0}`; if (P.key !== bk){ P.key = bk; P.decal.material.map = verTex(P.pm, p.app, p.ver, p.gpu, p.sys); P.decal.material.needsUpdate = true; }
      const col = lampOf(p); P.andon.forEach((l, i) => setLamp(l, [LAMP.green, LAMP.amber, LAMP.red][i], col === [LAMPC.green, LAMPC.amber, LAMPC.red][i]));
      if (p.phase === 'done') setLamp(P.andon[0], LAMP.blue, true);
      if (p.unknown && p.phase !== 'terminating'){ P.andon.forEach(l => setLamp(l, LAMP.off, false)); setLamp(P.andon[0], LAMP.unknown, true); P.andon[0].material.emissiveIntensity = 1.1; }   // Unknown: the node has not reported; a dim grey-blue
      if (p.phase === 'terminating'){ P.andon.forEach(l => setLamp(l, LAMP.off, false)); if (draining(p)) setLamp(P.andon[1], LAMP.amber, Math.floor(p.phaseT*5) % 2 === 0); }   // draining: the amber andon blinks while the machine finishes what it has
      if (p.phase === 'running' || p.phase === 'unready' || draining(p)) P.spindle.rotation.y = spinA;
      if (p.fire > 0){ if (!P.fire){ P.fire = mkFire(); P.g.add(P.fire); } P.fire.children.forEach((c, i) => { if (c.userData.spark){ c.position.set(MW/2 + Math.sin(spinA*3 + i)*2.5, MH + 1 + Math.abs(Math.sin(spinA*2.3 + i*1.7))*3, ML/2 + Math.cos(spinA*2.7 + i)*2.5); } else c.position.y = MH + 3 + ((spinA*1.5 + i*2) % 8); }); }
      else if (P.fire){ dispose(P.fire); P.fire = null; }
      P.inside.visible = k > 0; if (P.alpha !== p.alpha || P.k !== k){ P.alpha = p.alpha; P.k = k; setAlpha(P.machine, p.alpha); setAlpha(P.body, p.alpha*(1 - .75*k)); if (k > 0) setAlpha(P.inside, p.alpha*k); } }
  }
  for (const [id, P] of Y.pods) if (!seen.has(id)){ dispose(P.g); Y.pods.delete(id); const i = pickables.indexOf(P.body); if (i >= 0) pickables.splice(i, 1); }
}
function mkFire(){ const g = new THREE.Group(); for (let i = 0; i < 6; i++){ const s = new THREE.Mesh(sphG(.35), own('#ffd166', { e: 4, r: .3 })); s.userData.spark = true; s.castShadow = false; g.add(s); }
  for (let i = 0; i < 3; i++){ const s = new THREE.Mesh(sphG(1.6 + i*.5), own('#6b6a66', { a: .45, r: .9 })); s.material.depthWrite = false; s.castShadow = false; s.position.copy(V3(MW/2, ML/2, MH + 3 + i*2)); g.add(s); } return g; }
/* capsules in the tube, parts on the conveyor */
function syncCaps(){ while (Y.caps.length < st.caps.length){ const g = new THREE.Group(); const c = new THREE.Mesh(cylG(1, 1, 3.2, 12), M(WHITE, { r: .4 })); c.castShadow = false; g.add(c); const l = lamp(0, 0, 0, LAMP.amber, .5); g.add(l);
    const wax = new THREE.Mesh(cylG(.5, .5, .22, 10), M('#8f1d1d', { r: .6 })); wax.rotation.z = Math.PI/2; wax.position.set(.95, .5, 0); wax.castShadow = false; c.add(wax);   // the wax seal: the capsule is from the counter and signed
    scene.add(g); Y.caps.push({ g, cap: c }); }
  // forged capsules: grey, unsealed, coming up the trunk the wrong way; refused at the counter they drop and fade
  Y.forged = Y.forged || []; while (Y.forged.length < st.sec.forged.length){ const g = new THREE.Group(); const c = new THREE.Mesh(cylG(1, 1, 3.2, 12), own('#6b6a66', { r: .6 })); c.castShadow = false; g.add(c); scene.add(g); Y.forged.push({ g, cap: c }); }
  while (Y.forged.length > st.sec.forged.length){ const C = Y.forged.pop(); dispose(C.g); }
  st.sec.forged.forEach((f, i) => { const C = Y.forged[i], path = FORGE(), t = Math.min(1, f.t), a = along(path, t), b = along(path, Math.min(1, t + .01)); const sink = Math.max(0, f.t - 1);
    C.g.position.copy(V3(a[0], a[1], a[2] - 14*sink*sink)); const d = V3(b[0] - a[0], b[1] - a[1], b[2] - a[2]); if (d.length() > 1e-4) C.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); setAlpha(C.g, Math.max(0, 1 - sink/.3)); });
  while (Y.caps.length > st.caps.length){ const C = Y.caps.pop(); dispose(C.g); }
  st.caps.forEach((cp, i) => { const n = st.nodes.find(n => n.name === cp.node); if (!n) return; const path = tubePath(n), t = Math.min(1, cp.t), a = along(path, t), b = along(path, Math.min(1, t + .01)), C = Y.caps[i];
    C.g.position.copy(V3(...a)); const d = V3(b[0] - a[0], b[1] - a[1], b[2] - a[2]); if (d.length() > 1e-4) C.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); }); }
function syncParts(){ while (Y.parts.length < st.parcels.length){ const g = new THREE.Group(); const b = box(-1.6, -1.6, 0, 1.6, 1.6, 3, own(WHITE, { r: .5 }), { r: .4 }); g.add(b); const l = lamp(0, 0, 3.6, LAMP.green, .45); g.add(l);
    const sm = own('#9b7bd6', { a: .35, r: .2, m: .1 }); sm.depthWrite = false; const sl = box(-2.4, -2.4, -.3, 2.4, 2.4, 4.2, sm, { r: .8, shadow: false }); sl.visible = false; g.add(sl);   // the mesh's sealed sleeve: mutual TLS between escorts
    scene.add(g); Y.parts.push({ g, b, l, sl }); }
  while (Y.parts.length > st.parcels.length){ const P = Y.parts.pop(); dispose(P.g); }
  st.parcels.forEach((pc, i) => { const P = Y.parts[i], p = parcelAt(pc, pc.t); P.g.position.copy(V3(p[0], p[1], p[2] - 2.2)); if (P.b.material.color.getHexString() !== pc.col.slice(1)) P.b.material.color.set(pc.col); setLamp(P.l, pc.canary && pc.col !== LAMPC.red ? LAMP.amber : pc.col); P.sl.visible = !!pc.sleeve && pc.col !== LAMPC.red; }); }
// BGP announcements: a pulse with a flag runs from the cabinet across the cell's entry, up the corridor and the spur to the row's diverter (red: a withdrawal)
function annPath(n){ const cb = cabinet(n), Dv = DIVERTER(n.row), yd = cellEntry(n), cx = Dv ? Dv.cx : n.x0 + n.depth + 4, ys = Dv ? Dv.y : yd; return [[(cb.x0 + cb.x1)/2, (cb.y0 + cb.y1)/2, cb.h + 2], [(cb.x0 + cb.x1)/2, yd, 6], [cx, yd, 6], [cx, ys, 6], [LANE, ys, 6], [LANE + 5, ys, 6]]; }
function syncNet(){ Y.ann = Y.ann || []; while (Y.ann.length < st.net.ann.length){ const g = new THREE.Group(); const s = new THREE.Mesh(sphG(.9), own(LAMP.green, { e: 2, r: .3 })); s.castShadow = false; g.add(s); g.add(box(.8, -.1, .6, 1, 2.2, 2.2, own('#2d7bd6', { r: .5 }), { r: .1 })); scene.add(g); Y.ann.push({ g, s }); }
  while (Y.ann.length > st.net.ann.length){ const A = Y.ann.pop(); dispose(A.g); }
  st.net.ann.forEach((a, i) => { const n = st.nodes.find(n => n.name === a.node), A = Y.ann[i]; if (!n) return; const p = along(annPath(n), Math.min(1, a.t)); A.g.position.copy(V3(...p)); setLamp(A.s, a.withdraw ? LAMP.red : LAMP.green); setAlpha(A.g, a.t > 1 ? Math.max(0, 1 - (a.t - 1)/.25) : 1); });
  for (const Dv of Y.divs || []){ const key = st.net.fabric + '|' + Dv.Dv.cells.map(n => (n.cut ? 2 : 0)).join(''); if (Dv.key !== key){ Dv.key = key; Dv.stripDecal.material.map = routeTex(Dv.r, Dv.Dv); Dv.stripDecal.material.needsUpdate = true; } setLamp(Dv.lamp, st.net.fabric === 'bgp' ? LAMP.green : LAMP.amber);
    const f = st.net.flick[Dv.r]; for (const a of Dv.arms){ const on = f && f.lane === a.lane, u = on ? 1 - f.t/.55 : 0; a.g.rotation.y = 1.1*Math.sin(Math.PI*u); setLamp(a.lamp, on ? LAMP.amber : LAMP.green); } }   // the arm swings out across the belt and back
  const Bd = Y.dnsBoard; if (Bd){ const up = dnsUp(), fl = st.net.dns.flash > 0, t = dnsBoardTex(); if (Bd.decal.material.map !== t){ Bd.decal.material.map = t; Bd.decal.material.needsUpdate = true; } setLamp(Bd.lamp, up ? (fl ? LAMP.amber : LAMP.green) : LAMP.red); Bd.decal.material.emissive.set(fl ? '#5a4a18' : '#000000'); }
  // the update tick: a dashed line and a dot from the CoreDNS machine to the board (only while those machines are drawn)
  Y.hops = Y.hops || []; while (Y.hops.length < st.net.hops.length){ const g = new THREE.Group(); const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), new THREE.LineDashedMaterial({ color: '#ffe3a0', dashSize: 2, gapSize: 1.4 })); g.add(line); const dot = lamp(0, 0, 0, LAMP.amber, .5); g.add(dot); scene.add(g); Y.hops.push({ g, line, dot }); }
  while (Y.hops.length > st.net.hops.length){ const H = Y.hops.pop(); dispose(H.g); }
  st.net.hops.forEach((h, i) => { const H = Y.hops[i], p = h.pod, dd = DNSBOARD(); if (!p.pos || (p.sys && !st.showSys)){ H.g.visible = false; return; } H.g.visible = true; const a = V3(dd.x1 + .4, (dd.y0 + dd.y1)/2, (dd.z0 + dd.z1)/2), b = V3(p.pos[0] + MW/2, p.pos[1] + ML/2, p.pos[2] + MH + 1.5);
    H.line.geometry.setFromPoints([b, a]); H.line.computeLineDistances(); H.dot.position.lerpVectors(b, a, ease(Math.min(1, h.t))); });
  const O = Y.office; if (O && O.annex) O.annex.visible = st.net.mesh.on; }
function syncStatics(){
  const O = Y.office, cp = st.cp, SEC = st.sec; setLamp(O.screens.api, SEC.refuseT > 0 ? LAMP.red : LAMP.green, !!cp.api); setLamp(O.screens.sched, LAMP.blue, !!cp.ctrl);   // the counter's screen goes red while it refuses a request
  setLamp(O.pressLamp, LAMP.green, !!SEC.ca); O.pressHead.position.y = O.pressY - 1.7*Math.abs(Math.sin(Math.max(0, SEC.stamp)*Math.PI*2)); for (const b of O.badges) b.visible = !!SEC.ca;
  O.sign.position.y = O.signY + 2.6*ease(Math.min(1, Math.max(0, SEC.inspect)/.6));
  // the ledger's drawers: one per etcd member, lit as each joins (a pulse for the learner-then-voter), the leader amber once there is a quorum of two;
  // alone, the first member blinks slowly (no quorum yet); outside bootstrap the control room's Break presses turn a stopped member's lamp off
  const R = window.ControlRoom ? ControlRoom.R : null, members = cp.members || 3, pulse = st.cp.pulse, lead = R ? R.leader : 0;
  O.drawers.forEach((l, i) => { let on = !!cp.etcd && i < members && !(R && R.members[i] && !R.members[i].up && !st.boot);
    if (on && pulse && pulse.i === i) on = Math.floor(pulse.t*6) % 2 === 0; else if (on && members === 1 && !cp.hold) on = Math.floor(st.t*1.2) % 2 === 0;
    setLamp(l, members >= 2 && lead === i && cp.etcd && !cp.hold ? LAMP.amber : LAMP.green, on); });
  const strobe = st.strobe > 0 && Math.floor(st.strobe*12) % 2 === 0; setLamp(O.beacon, LAMP.amber, strobe || !!(st.boot && cp.ctrl && !cp.hold && false)); O.beacon.material.emissiveIntensity = strobe ? 6 : .1;
  const rows = JSON.stringify(boardRows()); if (rows !== Y.boardKey){ Y.boardKey = rows; O.boardDecal.material.map = boardTex(); O.boardDecal.material.needsUpdate = true; }
  const S = Y.station, svc = svcMain(), all = st.pods.filter(p => svc && p.app === (svc.selector || {}).app && p.pos && p.phase !== 'terminating').slice(0, 10), pk = all.map(p => isReady(p) ? 'g' : 'a').join('');
  if (pk !== S.key){ S.key = pk; dispose(S.panel); S.panel = new THREE.Group(); S.g.add(S.panel); const s = STATION(); all.forEach((p, i) => S.panel.add(lamp(s.x1 - 1.2, s.y0 + 2.2 + (i % 5)*2.6, 6 - Math.floor(i/5)*2.4, isReady(p) ? LAMP.green : LAMP.amber, .4))); }
  const D0 = Y.dock; D0.door.position.y = 16*ease(st.boom); setLamp(D0.lamp, st.boom > .5 ? LAMP.green : LAMP.red);
  const k = ease(st.xr || 0); for (const Ob of [Y.office, Y.station]){ if (Ob.k === k) continue; Ob.k = k; for (const c of Ob.cases) setAlpha(c, Ob === Y.office ? .28*(1 - .6*k) : 1 - .75*k); for (const i of Ob.insides){ if (k > 0 || Ob === Y.office) i.visible = true; else i.visible = true; } }
  key.intensity = 2.4 + (strobe ? 1.5 : 0);
}
function syncAll(dt){ if (staticKey() !== Y.key) rebuildStatic(); syncNodes(dt); syncPods(dt); syncCrib(); syncCaps(); syncParts(); syncNet(); syncStatics(); }

/* ---------- light and the render pipeline ---------- */
const canvas = document.getElementById('gl'), zwrap = document.getElementById('zwrap');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture; scene.environmentIntensity = .45; pmrem.dispose();
const key = new THREE.DirectionalLight('#fff0dc', 2.4); key.castShadow = true; key.shadow.mapSize.set(COARSE ? 1024 : 2048, COARSE ? 1024 : 2048); key.shadow.bias = -.0006; key.shadow.normalBias = .6; key.shadow.radius = 3; scene.add(key, key.target);
scene.add(new THREE.HemisphereLight('#e6ecff', '#5e584f', .55));
const fills = [0, 1, 2].map(() => { const l = new THREE.PointLight('#ffe9c4', 900, 220, 2); scene.add(l); return l; });
function placeLights(){ const c = V3(W/2, D/2, 0); key.position.copy(c).add(V3(-.55, .35, 1).normalize().multiplyScalar(500)); key.target.position.copy(c); key.target.updateMatrixWorld();
  const s = key.shadow.camera, R = Math.max(W, D)*.62; s.left = -R; s.right = R; s.top = R; s.bottom = -R; s.near = 1; s.far = 1200; s.updateProjectionMatrix();
  fills.forEach((l, i) => l.position.copy(V3(W/2, D*(.2 + .3*i), TRUSS_Z - 4))); }
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2400);
const composer = new EffectComposer(renderer), renderPass = new RenderPass(scene, camera), bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), .38, .55, .86), outPass = new OutputPass();
composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(outPass);
let vp = { w: 1, h: 1 }, sizeKey = '', bloomOK = true, slowRest = 0;
const perf = { scale: COARSE ? .7 : .85, lo: .55, hi: COARSE ? .8 : 1, lastT: 0, slow: 0, fast: 0 };
function perfTick(now){ if (perf.lastT){ const dt = now - perf.lastT;
    if (dt > 21){ perf.slow++; perf.fast = 0; } else if (dt < 13){ perf.fast++; perf.slow = Math.max(0, perf.slow - 1); }
    if (perf.slow >= 4){ perf.scale = Math.max(perf.lo, +(perf.scale - .05).toFixed(2)); perf.slow = 0; perf.fast = 0; }
    else if (perf.fast >= 40){ perf.scale = Math.min(perf.hi, +(perf.scale + .05).toFixed(2)); perf.fast = 0; } }
  perf.lastT = now; }
let restLast = 0;
function render(moving, now){
  const r = zwrap.getBoundingClientRect(); vp = window.__forceVp || { w: Math.max(1, r.width), h: Math.max(1, r.height) };   // __forceVp: a capture from a hidden tab names its own size
  const dpr = DPR(), s = moving ? perf.scale : 1, w = Math.max(2, Math.round(vp.w*dpr*s)), h = Math.max(2, Math.round(vp.h*dpr*s)), k = w + 'x' + h;
  if (moving) perfTick(now); else perf.lastT = 0;
  if (k !== sizeKey){ sizeKey = k; renderer.setPixelRatio(1); renderer.setSize(w, h, false); if (!moving && bloomOK){ composer.setSize(w, h); bloom.setSize(w/2, h/2); } }
  placeLights();
  // a frame at rest with bloom; while the camera moves, or on a device that cannot keep up, the plain render
  if (!moving && bloomOK){ const t0 = performance.now(); composer.render(); const t = performance.now() - t0;
    if (now - restLast < 120 && t > 45){ if (++slowRest >= 6){ bloomOK = false; sizeKey = ''; } } else slowRest = Math.max(0, slowRest - 1); restLast = now; }
  else renderer.render(scene, camera);
  window.__scale = s; window.__bloom = bloomOK; window.__Y = Y;
}
// for the browser checks and the README frames: one full frame drawn now, returned as an image
window.__shot = (q, w, h) => { window.__forceVp = w ? { w, h } : null; sizeKey = ''; render(false, performance.now()); window.__forceVp = null; sizeKey = ''; return canvas.toDataURL('image/jpeg', q || .88); };

/* ---------- what the view needs to know about this scene ---------- */
function bboxOf(a){ const p = a.type === 'pod' && st.pods.find(p => p.id === a.id), n = a.type === 'node' && st.nodes.find(n => n.name === a.node);
  if (p && p.pos) return [[p.pos[0] - 1, p.pos[1] - 1, p.pos[2]], [p.pos[0] + MW + 1, p.pos[1] + ML + 1, p.pos[2] + MH + 5]];
  if (n){ const c = cellBox(n); return [[c.x0 - 12, c.y0, 0], [c.x1, c.y1, 18]]; }
  if (a.type === 'tower') return [[OFF.x0 + ox(), OFF.y0, 0], [OFF.x1 + 2 + ox(), OFF.y1, OFF.z1 + 4]];
  if (a.type === 'dns'){ const d = DNSBOARD(); return [[d.x0 - 2, d.y0 - 1, 0], [d.x1 + 6, d.y1 + 1, d.z1 + 2]]; }
  if (a.type === 'diverter'){ const Dv = DIVERTER(a.row || 0); return Dv ? [[SPINE2() - 5, Dv.y - 6, 0], [Dv.x + 7, Dv.y + 6, 8]] : null; }
  if (a.type === 'board') return [[OFF.x0 + 6 + ox(), OFF.y1, OFF.z0 + 4], [OFF.x1 - 6 + ox(), OFF.y1 + 2, OFF.z1 - 3]];
  if (a.type === 'registry'){ const c = CRIB(); return [[c.x0, c.y0, 0], [c.x1, c.y1, c.h + 3]]; }
  if (a.type === 'kiosk'){ const s = STATION(); return [[s.x0, s.y0, 0], [s.x1 + 2, s.y1, 20]]; }
  if (a.type === 'gate'){ const d = DOCK(); return [[d.x0 - 1, d.y0 - 1, 0], [d.x1 + 1, d.y1 + 1, 25]]; }
  if (a.type === 'crane') return [[OFF.x0 + ox(), OFF.y0, OFF.z0], [OFF.x1 + ox(), OFF.y1, OFF.z1]];
  if (a.type === 'app'){ const ps = st.pods.filter(p => p.app === a.app && p.pos); if (!ps.length) return null; const b = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
    for (const p of ps) for (let i = 0; i < 3; i++){ b[0][i] = Math.min(b[0][i], p.pos[i]); b[1][i] = Math.max(b[1][i], p.pos[i] + [MW, ML, MH + 4][i]); } return b; }
  return null; }
function followTarget(zoomFor){ const mid = p => [p.pos[0] + MW/2, p.pos[1] + ML/2, p.pos[2] + MH/2];
  // the bootstrap spotlight: the office, the CA press, each etcd drawer as it joins (then the whole cabinet once there are three), the counter,
  // the dispatcher's desk, each node's cabinet and cell as it joins, and the order board when the Deployments are applied
  const sp = st.boot && st.cp.spot; if (sp){ const o = OFFV(), z = o.z0 + 1.2, drawer = i => [o.x0 + 11, o.y0 + 7, z + 11 - i*4];
    if (sp.what === 'office') return { p: [(o.x0 + o.x1)/2, (o.y0 + o.y1)/2, z + 6], z: zoomFor(1.8) };
    if (sp.what === 'ca') return { p: [o.x0 + 27, o.y0 + 31, z + 5], z: zoomFor(3.2) };
    if (sp.what === 'drawer') return { p: drawer(sp.i), z: zoomFor(3.2) };
    if (sp.what === 'bcp3') return sp.t < .9 ? { p: drawer(2), z: zoomFor(3.2) } : { p: [o.x0 + 11, o.y0 + 7, z + 7], z: zoomFor(2.4) };
    if (sp.what === 'api') return { p: [o.x0 + 15.4, o.y0 + 20, z + 7], z: zoomFor(3) };
    if (sp.what === 'sched') return { p: [o.x0 + 16, o.y1 - 6, z + 8], z: zoomFor(2.4) };
    if (sp.what === 'board') return { p: [(o.x0 + o.x1)/2, o.y1 + 1, (o.z0 + o.z1)/2], z: zoomFor(2.8) };
    const n = st.nodes.find(n => n.name === sp.node); if (n){ if (sp.what === 'cab'){ const cb = cabinet(n); return { p: [(cb.x0 + cb.x1)/2, (cb.y0 + cb.y1)/2, cb.h/2], z: zoomFor(3) }; } const c = cellBox(n); return { p: [(c.x0 + c.x1)/2, (c.y0 + c.y1)/2, 6], z: zoomFor(2.2) }; } }
  if (st.sec.forged.length){ const f = st.sec.forged[0]; return { p: along(FORGE(), Math.min(1, f.t)), z: zoomFor(3) }; }
  if (st.sec.inspect > 0 || st.sec.refuseT > 0) return { p: [OFF.x0 + ox() + 21, OFF.y0 + 16, OFF.z0 + 6], z: zoomFor(3.2) };
  if (st.net.ann.length){ const a = st.net.ann[0], n = st.nodes.find(n => n.name === a.node); if (n) return { p: along(annPath(n), Math.min(1, a.t)), z: zoomFor(3.2) }; }
  if (st.caps.length){ const cp = st.caps[0], n = st.nodes.find(n => n.name === cp.node); if (n) return { p: along(tubePath(n), Math.min(1, cp.t)), z: zoomFor(3) }; }
  const pn = st.nodes.find(n => n.pull); if (pn) return { p: along(agvPath(pn, pn.pull.warm), (() => { const u = pn.pull.t/pn.pull.dur; return ease(Math.min(1, u < .5 ? u*2 : 2 - u*2)); })()), z: zoomFor(3.6) };
  if (st.parcels.length){ const pc = st.parcels[0]; return { p: parcelAt(pc, pc.t), z: zoomFor(4) }; }
  const cr = st.pods.find(p => (p.fire > 0 || p.phase === 'crash') && p.pos); if (cr) return { p: mid(cr), z: zoomFor(4) };
  const st2 = st.pods.find(p => p.phase === 'creating' && p.pos); if (st2) return { p: mid(st2), z: zoomFor(4) };
  const cf = st.nodes.find(n => n.cert && (n.cert.flash > 0 || !n.cert.ok)); if (cf){ const cb = cabinet(cf); return { p: [(cb.x0 + cb.x1)/2, (cb.y0 + cb.y1)/2, 5], z: zoomFor(3.6) }; }
  const un = st.pods.find(p => p.phase === 'unready' && p.phaseT > -1e8 && p.pos); if (un) return { p: mid(un), z: zoomFor(3.6) };
  const bt = st.nodes.find(n => n.joined > 0 && n.joined < 1); if (bt){ const c = cellBox(bt); return { p: [(c.x0 + c.x1)/2, (c.y0 + c.y1)/2, 6], z: zoomFor(2.2) }; }
  return null; }
function labelItems({ L1, L2 }){ const items = [];
  for (const n of st.nodes){ if (n.joined < 1) continue; const c = cellBox(n); items.push({ key: 'n:' + n.name, cls: 'node', text: esc(n.name) + (n.gpus ? ` · GPU x${n.gpus}` : ''), at: [c.x1 + 4, (c.y0 + c.y1)/2, 0], pri: 8, act: { type:'node', node: n.name } }); }
  const rows = boardRows(); if (rows.length){ const full = L2 || L1 && rows.length <= 2;
    items.push({ key: 'board', cls: 'board', lines: full ? rows.length : 1, text: full ? rows.map(r => `<i style="background:${r.col}"></i>${r.bad ? '<span style="color:#b3261e">' : ''}${esc(r.text)}${r.bad ? '</span>' : ''}`).join('<br>') : rows.map(r => `<i style="background:${r.col}"></i>${esc(r.text.split(/\s+/)[1] || '')} ${esc((r.text.match(/running (\d+)/) || [])[1] || '')}`).join(' '), at: [(OFF.x0 + OFF.x1)/2 + ox(), OFF.y1 + 2, OFF.z1 - 1], pri: 7, act: { type:'board' } }); }
  if (L1) for (const p of st.pods){ if (!p.pos || NOPOS.has(p.phase) || p.sys && !st.showSys || p.alpha < .5) continue;
    items.push({ key: 'p:' + p.id, cls: 'pod', col: palOf(p.app).l, text: `${esc(p.app)} ${esc(p.ver)}` + (p.gpu ? `<b>GPU x${p.gpu}</b>` : ''), sub: L2 ? p.name : '', at: [p.pos[0] + MW/2, p.pos[1] + ML/2, p.pos[2] + MH + 5.5], up: true, pri: 6, act: { type:'pod', id: p.id } }); }
  return items; }
function calloutItems(){ const k = ease(st.xr || 0), items = [], o = OFFV(), n0 = st.nodes[0], p0 = st.pods.find(p => p.pos && !NOPOS.has(p.phase) && p.configMap) || st.pods.find(p => p.pos && !NOPOS.has(p.phase));
  if (k > .6){ if (p0){ const [x, y, z] = p0.pos; items.push({ at:[x + 3, y + 2.5, z + 3], text:'CONTAINER', on: isReady(p0) }, { at:[x + 2, y + ML - 2, z + 3], text:'POD IP', on: isReady(p0) }); if (p0.configMap) items.push({ at:[x + MW, y + 3.3, z + 4.4], text:`CONFIGMAP ${p0.configMap}`, on:false }); }
    const sec = st.pods.find(p => p.pos && p.secret); if (sec) items.push({ at:[sec.pos[0] - 1, sec.pos[1] + ML - 2.5, sec.pos[2] + 1.3], text:`SECRET ${sec.secret}`, on:false });
    if (n0 && n0.joined >= 1){ const cb = cabinet(n0); items.push({ at:[(cb.x0 + cb.x1)/2, cb.y0 + 2.7, 7], text:'RUNTIME', on: !!n0.pull }, { at:[(cb.x0 + cb.x1)/2, cb.y1 - 3, 3], text:'KUBE-PROXY', on: st.parcels.length > 0 }, { at:[(cb.x0 + cb.x1)/2, (cb.y0 + cb.y1)/2, cb.h], text:'KUBELET', on: !!n0.pull }); }
    items.push({ at:[o.x0 + 27, o.y0 + 31, o.z0 + 10], text:'CLUSTER CA', on: st.sec.stamp > 0 }, { at:[o.x0 + 6, o.y0 + 15, o.z0 + 7], text:'SECRETS AT REST', on:false }, { at:[o.x0 + 25, o.y0 + 11, o.z0 + 9], text:'ADMISSION', on: st.sec.inspect > 0 });
    items.push({ at:[o.x0 + 7, o.y0 + 7, o.z0 + 8], text:'ETCD', on:false }, { at:[o.x0 + 18, o.y0 + 20, o.z0 + 6], text:'API SERVER', on: st.caps.length > 0 }, { at:[o.x0 + 8, o.y1 - 10, o.z0 + 6], text:'SCHEDULER', on: st.pods.some(p => p.phase === 'pending') || st.caps.length > 0 }, { at:[LANE, 72, TZ], text:'WATCH STREAM', on: st.caps.length > 0 }); }
  else { const ing = st.ingresses[0], gn = st.nodes.find(n => n.gpus && n.joined >= 1);
    if (n0 && n0.joined >= 1){ const c = cellBox(n0), cb = cabinet(n0), rk = rackOf(n0), h = agvHome(n0); items.push({ at:[c.x1 - 3, c.y0 + 6, 9], text:'NODE', on:false }, { at:[(cb.x0 + cb.x1)/2, (cb.y0 + cb.y1)/2, cb.h + 1], text:'KUBELET', on: !!n0.pull }, { at:[cb.x1 + .4, cb.y0 + 1.8, 6], text:'CAPACITY', on:false }, { at:[(rk.x0 + rk.x1)/2, (rk.y0 + rk.y1)/2, rk.h], text:'IMAGE CACHE', on: !!(n0.pull && n0.pull.warm) }, { at:[h[0], h[1], 3], text:'IMAGE PULL', on: !!n0.pull }, { at:[cb.x1 + .5, (cb.y0 + cb.y1)/2, 11.5], text:'KUBELET WATCH', on: st.caps.some(c => c.node === n0.name) }); }
    if (p0){ const [x, y, z] = p0.pos; items.push({ at:[x + MW, y + ML/2, z + 3], text:'POD', on: isReady(p0) }, { at:[x + MW - 1.6, y + ML - 1.6, z + MH + 5], text:'READINESS', on: isReady(p0) }, { at:[x + 3, y - .3, z + 4.1], text:'SA TOKEN', on:false }); }
    const pv = st.pods.find(p => p.pos && !NOPOS.has(p.phase) && p.pvc); if (pv) items.push({ at:[pv.pos[0] + MW/2, pv.pos[1] - .4, pv.pos[2] + .3], text:`PVC ${pv.pvc}`, on:false });   // the pallet is under whichever machine has a claim
    items.push({ at:[o.x0 + 25, o.y0 + 11, o.z0 + 10], text:'ADMISSION', on: st.sec.inspect > 0 });
    if (n0 && n0.cert){ const cb = cabinet(n0); items.push({ at:[cb.x1 + .5, cb.y1 - 3.4, 3.4], text:'CLIENT CERT', on: n0.cert.flash > 0 || !n0.cert.ok }); }
    if (st.sec.netpol){ const gp = st.pods.find(p => p.app === st.sec.netpol.to && p.pos && !NOPOS.has(p.phase)); if (gp) items.push({ at:[gp.pos[0] + MW + 2.6, gp.pos[1] + ML/2, gp.pos[2] + 4.6], text:'NETWORKPOLICY', on: st.parcels.some(pc => pc.link) }); }
    { const rk = st.nodes[0] && rackOf(st.nodes[0]); if (rk && st.nodes[0].cache && st.nodes[0].cache.size) items.push({ at:[rk.x0 + .5, rk.y0 + 3, 3], text:'IMAGE SIGNATURE', on:false }); }
    { const Dv = DIVERTER(0), dd = DNSBOARD(); if (Dv) items.push({ at:[Dv.x + 2.6, Dv.y, 5], text:'TOR SWITCH', on: !!st.net.flick[0] || st.net.ann.length > 0 }); items.push({ at:[dd.x1 + .5, (dd.y0 + dd.y1)/2, dd.z1 + .6], text:'KUBE-DNS', on: st.net.dns.flash > 0 });
      if (st.showSys) for (const p of st.pods.filter(p => isDnsPod(p) && p.pos && !NOPOS.has(p.phase))) items.push({ at:[p.pos[0] + MW/2, p.pos[1] + 1, p.pos[2] + MH + 2], text:'COREDNS', on: st.net.hops.some(h => h.pod === p) });
      if (st.net.fabric === 'bgp'){ items.push({ at:[SPINE2(), 90, 2.5], text:'SPINE', on: st.parcels.length > 0 }); if (n0 && n0.joined >= 1){ const cb = cabinet(n0); items.push({ at:[cb.x1 - 1.5, cb.y0 + 6.3, cb.h + 5], text:'BGP SPEAKER', on: st.net.ann.some(a => a.node === n0.name) }); } }
      if (st.net.mesh.on){ const mp = st.pods.find(p => p.pos && !NOPOS.has(p.phase) && MESHED.has(p.app)); if (mp) items.push({ at:[mp.pos[0] + 6.6, mp.pos[1] - 1.3, mp.pos[2] + 3.4], text:'SIDECAR', on: st.parcels.some(pc => pc.sleeve) }); items.push({ at:[o.x1 + 13, o.y0 + 8, o.z0 + 11], text:'MESH CA', on:false }); }
      if (st.net.managed){ items.push({ at:[-3, 28, 15], text:'PROVIDER', on:false }); if (n0 && n0.joined >= 1){ const cb = cabinet(n0); items.push({ at:[cb.x0 + 2.6, cb.y0 + 2.5, cb.h + 3], text:'KONNECTIVITY', on: st.caps.length > 0 }); } } }
    if (gn){ const c = cellBox(gn); items.push({ at:[c.x0 + 9, c.y0 + 3, 17], text:'GPU', on: gpuUsed(gn) > 0 }); }
    const cr = CRIB(), s = STATION(), d = DOCK();
    items.push({ at:[(o.x0 + o.x1)/2, (o.y0 + o.y1)/2, o.z1 + 2], text:'CONTROL PLANE', on:false }, { at:[(o.x0 + o.x1)/2, o.y1 + 1.3, o.z1 - 4], text:'DEPLOYMENTS', on:false }, { at:[cr.x1, (cr.y0 + cr.y1)/2, cr.h], text:'REGISTRY', on: st.nodes.some(n => n.pull && !n.pull.warm) },
      { at:[s.x1, (s.y0 + s.y1)/2, 16], text:'SERVICE', on: st.parcels.length > 0 }, { at:[(d.x0 + d.x1)/2, d.y1, 24], text:'INGRESS', on: st.boom > .5 }, { at:[LANE, 72, TZ], text:'WATCH STREAM', on: st.caps.length > 0 });
    for (const n of st.nodes) if (n.cut){ const b = breakAt(n); items.push({ at:[b.x, b.y, TZ + 2.5], text:'UPLINK CUT', on: true }); } }
  return items; }
function pickAct(h){ const a = h.object.userData.act; if (a && a.type === 'board'){ const rows = st.deploys.filter(d => !d.sys || st.showSys).slice(0, 5), zTop = OFF.z1 - 3 - 1.9, i = Math.floor((zTop - h.point.y)/1.7); if (rows[i] && i >= 0) return { type:'app', app: rows[i].app }; } return a; }

/* ---------- mount ---------- */
const view = View3D(THREE, { key: 'shop', scene, camera, pickables, render, syncAll, bboxOf, followTarget, labelItems, calloutItems, pickAct,
  faceViews: { board: [100, 45], kiosk: [30, 60], gate: [75, 60], registry: [20, 50], tower: [20, 70] },
  compassPoints: () => ({ G: [W - 20, 19], T: [19 + ox(), 21], R: [17, REG_Y0 + 40] }), extent: () => ({ x0: st.net.managed ? -48 : 0 }), onResize: () => { sizeKey = ''; }, stats: () => ({ calls: renderer.info.render.calls, scale: window.__scale, bloom: bloomOK }) });
view.mount();
