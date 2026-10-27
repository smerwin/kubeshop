/* ============================================================
   The view: everything about looking at a three.js scene of the cluster that is not the scene itself. The camera is
   a map (a focus point, a yaw, a pitch, a zoom; every move an expo-out flight), the gestures (one finger orbits with
   a glide that snaps to the corner views, two fingers pinch and pan, taps pick, double-tap and two-finger tap zoom,
   the wheel), follow mode, the labels drawn as screen-sized HTML placed by projection with levels of detail, the
   compass, the camera memory, the one clock that drives simulation steps and frames on demand, and the mount.
   The scene module (yard3d.js has its own older copy of this; shop3d.js uses this one) supplies the hooks in cfg:
     scene, camera (orthographic), pickables, render(moving), syncAll(), bboxOf(act), faceViews, followTarget(),
     labelItems({ L1, L2, facing }), calloutItems(), compassPoints(), pickAct(hit), onRelayout().
   ============================================================ */
window.View3D = function(THREE, cfg){
const html = document.documentElement, Q = new URLSearchParams(location.search);
const canvas = document.getElementById('gl'), zwrap = document.getElementById('zwrap'), ov = document.getElementById('ov'), lblEl = document.getElementById('lbls');
const V3 = (x, y, z) => new THREE.Vector3(x, z, y);
const COARSE = matchMedia('(pointer:coarse)').matches;
const { scene, camera } = cfg;
const YAW0 = 45, PITCH0 = Math.atan(1/Math.SQRT2)*180/Math.PI, ZMIN = .6, ZMAX = 8;
const cam = { yaw: YAW0, pitch: PITCH0, focus: new THREE.Vector3(), zoom: 1, custom: false };
let frame = { w: 1, h: 1, ymid: 0 }, box = { w: 1, h: 1, left: 0, top: 0 };
const YARD_MODE = () => html.classList.contains('yard');
const clampP = p => Math.max(6, Math.min(78, p));
const viewDir = (yaw, pitch) => { const t = yaw*Math.PI/180, p = pitch*Math.PI/180; return new THREE.Vector3(Math.cos(p)*Math.cos(t), Math.sin(p), Math.cos(p)*Math.sin(t)); };
const basis = (yaw, pitch) => { const d = viewDir(yaw, pitch), R = new THREE.Vector3(Math.sin(yaw*Math.PI/180), 0, -Math.cos(yaw*Math.PI/180)), U = new THREE.Vector3().crossVectors(d, R).normalize(); return { d, R, U }; };
const measure = () => { const r = zwrap.getBoundingClientRect(); box = { w: Math.max(1, r.width), h: Math.max(1, r.height), left: r.left, top: r.top }; };
function reframe(){
  layout(st); measure();
  const { R, U } = basis(YAW0, PITCH0), c = V3(W/2, D/2, HTOP/2), xs = [], ys = [];
  for (const x of [0, W]) for (const y of [0, D]) for (const z of [0, HTOP]){ const q = V3(x, y, z).sub(c); xs.push(q.dot(R)); ys.push(q.dot(U)); }
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys), A = box.h/box.w, yard = YARD_MODE(), phone = box.w < 560;
  const fw = yard ? .9 : phone ? .74 : .64, fh = yard ? .6 : .88;
  const vbW = Math.max(bw/fw, bh/fh/A); frame = { w: vbW, h: vbW*A, ymid: (Math.max(...ys) + Math.min(...ys))/2 };
  if (!cam.custom) cam.focus.copy(overviewFocus());
  applyFrame(); camMoved = false; if (cfg.onRelayout) cfg.onRelayout(); invalidate();
}
window.reframe = reframe;
function overviewFocus(){ const f = YARD_MODE() ? .5 : box.w < 560 ? .44 : .42; return V3(W/2, D/2, HTOP/2).add(new THREE.Vector3(0, (frame.ymid + (f - .5)*frame.h)/Math.cos(PITCH0*Math.PI/180), 0)); }
let camMoved = false, restT = 0;
function applyFrame(){ camMoved = true; placeCam(); }
function placeCam(){ const w = frame.w/cam.zoom, h = frame.h/cam.zoom;
  cam.focus.x = Math.max(-40, Math.min(W + 40, cam.focus.x)); cam.focus.z = Math.max(-40, Math.min(D + 40, cam.focus.z)); cam.focus.y = Math.max(-90, Math.min(HTOP + 90, cam.focus.y));
  camera.left = -w/2; camera.right = w/2; camera.top = h/2; camera.bottom = -h/2; camera.updateProjectionMatrix();
  camera.position.copy(cam.focus).add(viewDir(cam.yaw, cam.pitch).multiplyScalar(1000)); camera.up.set(0, 1, 0); camera.lookAt(cam.focus); camera.updateMatrixWorld(); }
const toScreen = p => { const v = V3(...p).project(camera); return [(v.x + 1)/2*box.w, (1 - v.y)/2*box.h, v.z]; };
const ppu = () => box.w/(frame.w/cam.zoom);
const zoomFor = px => Math.min(ZMAX, Math.max(ZMIN, px*frame.w/box.w));
const touched = () => { cam.custom = true; applyFrame(); invalidate(); saveCam(); };
function zoomAt(k, px, py, ms){ const z2 = Math.min(ZMAX, Math.max(ZMIN, cam.zoom*k)); k = z2/cam.zoom; if (Math.abs(k - 1) < 1e-4) return;
  const { R, U } = basis(cam.yaw, cam.pitch), w = frame.w/cam.zoom, h = frame.h/cam.zoom, u = (px/box.w - .5)*w, v = (.5 - py/box.h)*h;
  const f = cam.focus.clone().addScaledVector(R, u*(1 - 1/k)).addScaledVector(U, v*(1 - 1/k));
  if (ms){ cam.custom = true; flyTo({ focus: f, zoom: z2 }, ms); } else { cam.focus.copy(f); cam.zoom = z2; touched(); } }
function panBy(dx, dy){ const { R, U } = basis(cam.yaw, cam.pitch), w = frame.w/cam.zoom, h = frame.h/cam.zoom; cam.focus.addScaledVector(R, -dx*w/box.w).addScaledVector(U, dy*h/box.h); touched(); }
let camAnim = 0; const eo = t => t >= 1 ? 1 : 1 - Math.pow(2, -10*t);
function flyTo(to, ms = 500, done){ const id = ++camAnim, y0 = cam.yaw, p0 = cam.pitch, f0 = cam.focus.clone(), z0 = cam.zoom;
  const y1 = to.yaw == null ? y0 : y0 + (((to.yaw - y0 + 540) % 360) - 180), p1 = to.pitch == null ? p0 : clampP(to.pitch), f1 = to.focus ? to.focus.clone() : f0, z1 = Math.min(ZMAX, Math.max(ZMIN, to.zoom == null ? z0 : to.zoom)); let t = 0;
  const end = () => { cam.yaw = ((y1 % 360) + 360) % 360; cam.pitch = p1; cam.focus.copy(f1); cam.zoom = z1; applyFrame(); invalidate(); saveCam(); if (done) done(); };
  if (ms <= 0) return end();
  ui.animate(dt => { if (id !== camAnim) return false; t += dt*1000; if (t >= ms){ end(); return false; } const e = eo(t/ms);
    cam.yaw = y0 + (y1 - y0)*e; cam.pitch = p0 + (p1 - p0)*e; cam.focus.lerpVectors(f0, f1, e); cam.zoom = z0*Math.pow(z1/z0, e); applyFrame(); invalidate(); return true; }); }
function frameBox(b, o = {}){ const yaw = o.yaw == null ? cam.yaw : o.yaw, pitch = o.pitch == null ? cam.pitch : o.pitch, { R, U } = basis(yaw, pitch);
  const c = V3((b[0][0] + b[1][0])/2, (b[0][1] + b[1][1])/2, (b[0][2] + b[1][2])/2), xs = [], ys = [];
  for (const x of [b[0][0], b[1][0]]) for (const y of [b[0][1], b[1][1]]) for (const z of [b[0][2], b[1][2]]){ const q = V3(x, y, z).sub(c); xs.push(q.dot(R)); ys.push(q.dot(U)); }
  const bw = Math.max(1, Math.max(...xs) - Math.min(...xs)), bh = Math.max(1, Math.max(...ys) - Math.min(...ys)), fill = o.fill || .4, below = o.below || 0;
  const zoom = Math.min(o.maxZoom || ZMAX, Math.max(ZMIN, Math.min(frame.w*fill/bw, frame.h*(1 - below)*fill/bh)));
  const focus = c.addScaledVector(U, (Math.max(...ys) + Math.min(...ys))/2 - below/2*frame.h/zoom);
  cam.custom = true; flyTo({ yaw, pitch, focus, zoom }, o.ms == null ? 500 : o.ms, o.done); }
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
function frameAct(a, o = {}){ const b = cfg.bboxOf(a); if (!b) return; const view = {};
  const face = (cfg.faceViews || {})[a.type];
  if (face && Math.abs(angDiff(cam.yaw, face[0])) > face[1]) view.yaw = face[0];
  view.pitch = a.type === 'app' ? Math.max(28, Math.min(55, cam.pitch)) : a.type === 'node' ? Math.max(30, Math.min(60, cam.pitch)) : Math.max(16, Math.min(44, cam.pitch));
  const fill = o.fill || (a.type === 'pod' ? .36 : a.type === 'app' ? .5 : .42), maxZoom = a.type === 'pod' ? zoomFor(7) : a.type === 'app' || a.type === 'node' ? zoomFor(4.5) : zoomFor(5);
  frameBox(b, { ...view, fill, maxZoom, below: o.below || 0, ms: o.ms, done: o.done }); }
function overview(ms = 500){ cam.custom = false; flyTo({ focus: overviewFocus(), zoom: 1 }, ms, () => { cam.custom = false; saveCam(); }); }
function front(){ spinOff(); flyTo({ yaw: YAW0, pitch: PITCH0 }, 600); }
/* follow */
const follow = { on: false };
function followTick(dt){ const t = cfg.followTarget(zoomFor); if (!t) return; const k = 1 - Math.exp(-dt*6); cam.focus.lerp(V3(...t.p), k); cam.zoom += (t.z - cam.zoom)*k*.7; cam.custom = true; applyFrame(); dirty = true; }
function setFollow(on){ follow.on = !!on; if (on) camAnim++; Chrome.syncSw(); if (on) invalidate(); }
/* the camera is remembered for the tab */
const CAMKEY = 'longshore.cam.' + (cfg.key || 'yard'); let saveT = 0;
function saveCam(){ clearTimeout(saveT); saveT = setTimeout(() => { try { sessionStorage.setItem(CAMKEY, JSON.stringify({ yaw: cam.yaw, pitch: cam.pitch, f: cam.focus.toArray(), zoom: cam.zoom, custom: cam.custom, W, D, yard: YARD_MODE() })); } catch {} }, 300); }
function loadCam(){ try { const s = JSON.parse(sessionStorage.getItem(CAMKEY)); if (!s || s.W !== W || s.D !== D) return false; cam.yaw = s.yaw; cam.pitch = s.pitch;
  if (s.custom && s.yard === YARD_MODE()){ cam.custom = true; cam.focus.fromArray(s.f); cam.zoom = s.zoom; } applyFrame(); camMoved = false; return true; } catch { return false; } }

/* ---------- the clock: simulation steps, camera moves, frames on demand (a timer fallback for hidden tabs) ---------- */
const steps = new Set(); let driving = false, lastT = 0, dirty = true, fbT = 0;
const frameFn = () => { if (!driving) return; driving = false; clearTimeout(fbT);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - lastT)/1000)); lastT = now;
  for (const s of [...steps]) if (s(dt) === false) steps.delete(s);
  if (follow.on && steps.size) followTick(dt);
  if (steps.size || dirty){ dirty = false; const moving = camMoved; camMoved = false;
    const t0 = performance.now(); cfg.syncAll(dt); const t1 = performance.now(); placeCam(); cfg.render(moving, now); const t2 = performance.now();
    Chrome.tick(); drawLabels(); drawCompass(); if (window.ControlRoom) ControlRoom.observe();
    clearTimeout(restT); if (moving) restT = setTimeout(invalidate, 90);
    window.__ft = { sync: t1 - t0, render: t2 - t1, post: performance.now() - t2, moving, frames: (window.__ft ? window.__ft.frames : 0) + 1, ...(cfg.stats ? cfg.stats() : {}) }; }
  if (steps.size) drive(); };
const drive = () => { if (driving) return; driving = true; requestAnimationFrame(frameFn); fbT = setTimeout(frameFn, 60); };
function invalidate(){ dirty = true; drive(); }
ui = { st, render: invalidate, invalidate, animate: step => { if (!steps.size && !driving) lastT = performance.now(); steps.add(step); drive(); },
  flash: (text, ms = 1600) => { const t = document.getElementById('toast'); t.textContent = text[0].toUpperCase() + text.slice(1); t.classList.add('show'); clearTimeout(ui._ft); ui._ft = setTimeout(() => t.classList.remove('show'), ms); } };
window.ui = ui; window.__st = st;
window.__proj = p => toScreen(p); window.__cam = cam; window.__labels = () => labelItems().map(it => ({ key: it.key, at: toScreen(it.at), pri: it.pri })); window.__zoomTo = (p, k) => { overview(0); const [x, y] = toScreen(p); zoomAt(k, x, y); };

/* ---------- gestures ---------- */
const P = new Map(); let ges = null, lastTap = null, tapT = 0, spin = false;
const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} };
const two = () => { const [a, b] = [...P.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x)/2, y: (a.y + b.y)/2 }; };
const evPos = e => [e.clientX - box.left, e.clientY - box.top];
const raycaster = new THREE.Raycaster();
function pick(e){ const [px, py] = evPos(e); raycaster.setFromCamera(new THREE.Vector2((px/box.w)*2 - 1, -(py/box.h)*2 + 1), camera);
  raycaster.layers.enableAll(); const hits = raycaster.intersectObjects(cfg.pickables, false); if (!hits.length) return null; return cfg.pickAct ? cfg.pickAct(hits[0]) : hits[0].object.userData.act; }
const release = () => { if (follow.on) setFollow(false); spinOff(); camAnim++; };
function spinOff(){ if (spin){ spin = false; Chrome.spinOff(); } }
zwrap.addEventListener('contextmenu', e => e.preventDefault());
zwrap.addEventListener('pointerdown', e => { if (e.target.closest('.zchip, .lb, .card, .compass, .toast')) return; if (e.button > 2) return;
  measure(); P.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { zwrap.setPointerCapture(e.pointerId); } catch {}
  camAnim++; spinOff();
  if (P.size === 2){ const t = two(); ges = { type:'pinch', x: t.x, y: t.y, d: t.d, t0: performance.now(), moved: false }; return; }
  if (P.size > 2){ ges = null; return; }
  ges = { type: e.button === 0 && !e.shiftKey ? 'orbit' : 'pan', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, s: [] }; });
zwrap.addEventListener('pointermove', e => {
  if (!P.has(e.pointerId)){ if (e.pointerType !== 'touch') zwrap.classList.toggle('pick', !!pick(e)); return; }
  P.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (!ges) return;
  if (ges.type === 'pinch'){ if (P.size < 2) return; const t = two();
    if (!ges.moved){ if (Math.hypot(t.x - ges.x, t.y - ges.y) < 6 && Math.abs(t.d - ges.d) < 6) return; ges.moved = true; release(); }
    panBy(t.x - ges.x, t.y - ges.y); zoomAt(t.d/Math.max(1, ges.d), t.x - box.left, t.y - box.top); ges.x = t.x; ges.y = t.y; ges.d = t.d; return; }
  if (!ges.moved){ if (Math.hypot(e.clientX - ges.x0, e.clientY - ges.y0) < 5) return; ges.moved = true; release(); zwrap.classList.add('drag'); }
  const dx = e.clientX - ges.x, dy = e.clientY - ges.y;
  if (ges.type === 'pan') panBy(dx, dy);
  else { const k = 300/box.w; cam.yaw += dx*.55*k; cam.pitch = clampP(cam.pitch + dy*.35*k); ges.s.push({ t: performance.now(), yaw: cam.yaw, pitch: cam.pitch }); if (ges.s.length > 10) ges.s.shift(); touched(); }
  ges.x = e.clientX; ges.y = e.clientY; });
const endPointer = e => { if (!P.has(e.pointerId)) return; P.delete(e.pointerId); zwrap.classList.remove('drag');
  if (ges && ges.type === 'pinch'){
    if (P.size === 1){ if (!ges.moved && performance.now() - ges.t0 < 350) ges = { type:'tap2' }; else { const [r] = P.values(); ges = { type:'orbit', x: r.x, y: r.y, x0: r.x, y0: r.y, t0: performance.now(), moved: true, s: [] }; } }
    else if (!P.size){ ges = null; rest(); } return; }
  if (ges && ges.type === 'tap2'){ if (!P.size){ ges = null; zoomAt(.5, box.w/2, box.h/2, 420); buzz(6); } return; }
  const g = ges; ges = null; if (!g) return;
  if (!g.moved){ if (performance.now() - g.t0 < 500) tap(e); rest(); return; }
  if (g.type === 'orbit') glide(g.s); else rest(); };
zwrap.addEventListener('pointerup', endPointer); zwrap.addEventListener('pointercancel', endPointer);
function rest(){ cam.yaw = ((cam.yaw % 360) + 360) % 360; saveCam(); }
const CARD = () => [0, 90, 180, 270].map(a => YAW0 + a);
const nearestCardinal = y => CARD().reduce((best, c) => Math.abs(angDiff(c, y)) < Math.abs(angDiff(best, y)) ? c : best, CARD()[0]);
function glide(s){ const now = performance.now(), a = s.find(x => now - x.t < 110) || s[s.length - 1], b = s[s.length - 1], dt = b && a ? (b.t - a.t)/1000 : 0;
  let vy = dt > 0 ? (b.yaw - a.yaw)/dt : 0, vp = dt > 0 ? (b.pitch - a.pitch)/dt : 0; vy = Math.max(-900, Math.min(900, vy)); vp = Math.max(-400, Math.min(400, vp));
  const TAU = .14, restYaw = cam.yaw + vy*TAU, near = nearestCardinal(restYaw), off = angDiff(near, restYaw);
  if ((Math.abs(vy) > 80 && Math.abs(off) < 16) || Math.abs(off) < 4){ flyTo({ yaw: near, pitch: cam.pitch + vp*TAU }, 340, () => { buzz(8); const c = document.getElementById('compass'); c.classList.remove('snap'); void c.offsetWidth; c.classList.add('snap'); rest(); }); return; }
  if (Math.abs(vy) < 40 && Math.abs(vp) < 40){ rest(); return; }
  const id = ++camAnim; ui.animate(dt => { if (id !== camAnim) return false; const k = Math.exp(-dt/TAU); cam.yaw += vy*TAU*(1 - k); cam.pitch = clampP(cam.pitch + vp*TAU*(1 - k)); vy *= k; vp *= k; applyFrame(); invalidate();
    if (Math.abs(vy) < 5 && Math.abs(vp) < 5){ rest(); return false; } return true; }); }
function tap(e){ const now = performance.now(), [x, y] = evPos(e);
  if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 26){ clearTimeout(tapT); lastTap = null; release(); zoomAt(2, x, y, 420); return; }
  lastTap = { t: now, x, y }; const a = pick(e); clearTimeout(tapT);
  tapT = setTimeout(() => { if (a) act(a); else Chrome.hideCard(); }, e.pointerType === 'mouse' ? 0 : 240); }
function act(a){ release(); Chrome.open(a); invalidate(); }
let wheelT = 0, wheelMouse = false;
zwrap.addEventListener('wheel', e => { measure(); const [x, y] = evPos(e), now = performance.now();
  if (e.ctrlKey || e.metaKey){ e.preventDefault(); release(); zoomAt(Math.exp(-Math.max(-50, Math.min(50, e.deltaY))*.01), x, y); return; }
  if (YARD_MODE()){ e.preventDefault(); release();
    const burst = now - wheelT < 60; wheelT = now;
    const trackpad = e.shiftKey || e.deltaMode === 0 && (e.deltaX !== 0 || (Math.abs(e.deltaY) < 40 && (burst || !Number.isInteger(e.deltaY)))) && !(wheelMouse && burst);
    wheelMouse = !trackpad;
    if (trackpad) panBy(-e.deltaX, -e.deltaY); else zoomAt(Math.exp(-Math.sign(e.deltaY)*.18), x, y, 160); return; }
  if (cam.zoom > 1.001){ e.preventDefault(); release(); panBy(-e.deltaX, -e.deltaY); } }, { passive: false });
addEventListener('keydown', e => { if (/input|textarea/i.test(e.target.tagName)) return; const k = { ArrowLeft:[-15, 0], ArrowRight:[15, 0], ArrowUp:[0, 8], ArrowDown:[0, -8] }[e.key];
  if (k){ e.preventDefault(); release(); flyTo({ yaw: cam.yaw + k[0], pitch: cam.pitch + k[1] }, 300); return; }
  if (e.key === '+' || e.key === '='){ release(); zoomAt(1.5, box.w/2, box.h/2, 300); } else if (e.key === '-'){ release(); zoomAt(1/1.5, box.w/2, box.h/2, 300); } else if (e.key === '0'){ release(); overview(); } else if (e.key === 'f'){ release(); front(); } });
document.querySelector('.zchip .zi').onclick = () => { release(); zoomAt(1.5, box.w/2, box.h/2, 300); };
document.querySelector('.zchip .zm').onclick = () => { release(); zoomAt(1/1.5, box.w/2, box.h/2, 300); };
document.querySelector('.zchip .zp').onclick = () => { release(); overview(); };
function spinToggle(){ spin = !spin; camAnim++; if (spin){ setFollow(false); ui.animate(dt => { if (!spin) return false; if (!ges) cam.yaw += dt*18; applyFrame(); invalidate(); return true; }); } return spin; }

/* ---------- labels: screen-sized text placed by projection; the scene says what, the view says where and when ---------- */
const LB = new Map(); let selKey = null;
const estW = it => { const main = it.text.replace(/<[^>]+>/g, ''), fs = it.cls === 'callout' ? 10 : it.cls === 'node' ? 10.5 : 11, sw = (it.text.match(/<i /g) || []).length*14;
  return Math.max(main.length*fs*.62 + sw, (it.sub || '').length*9*.62) + 18; };
const estH = it => (it.lines ? it.lines*14 : 11) + (it.sub ? 13 : 0) + 10;
function labelItems(){ const z = ppu(), facing = viewDir(cam.yaw, cam.pitch).x >= 0 ? 1 : -1, items = html.classList.contains('notext') ? [] : cfg.labelItems({ L1: z >= 2.2, L2: z >= 4.4, facing, ppu: z });
  for (const c of cfg.calloutItems()) items.push({ key: 'c:' + c.text, cls: 'callout', text: esc(c.text), at: c.at, on: c.on, lead: true, pri: (st.xr || 0) > .6 ? 6.5 : 4, act: { type:'explain', text: c.text } });
  return items; }
function drawLabels(){ if (html.classList.contains('nolabels')){ if (LB.size){ for (const L of LB.values()){ clearTimeout(L.outT); L.el.remove(); } LB.clear(); } if (ov._h){ ov._h = ''; ov.innerHTML = ''; } return; }
  const items = labelItems(), placed = [], want = new Set(), writes = []; let leaders = '';
  for (const it of items){ const s = toScreen(it.at); it.x = s[0]; it.y = s[1]; it.depth = s[2]; }
  items.sort((a, b) => b.pri - a.pri || a.depth - b.depth);
  for (const it of items){ const w = estW(it), h = estH(it); let x = it.x, y = it.y; if (it.lead) y -= 30; else if (it.up) y -= h/2 + 3; else if (it.cls === 'node') y += h/2 + 2; else if (it.cls === 'board') y -= h/2 + 4;
    x = Math.max(w/2 + 3, Math.min(box.w - w/2 - 3, x)); if (it.x < -40 || it.x > box.w + 40 || it.y < -40 || it.y > box.h + 40) continue;
    const yard = YARD_MODE(), y0 = h/2 + 3 + (yard ? 46 : 0), y1 = box.h - h/2 - 3 - (yard ? 66 : 0);
    if (it.lead) y = Math.max(y0, Math.min(y1, y)); else if (y < y0 - h || y > y1 + h) continue;
    const r = [x - w/2 - 3, y - h/2 - 3, x + w/2 + 3, y + h/2 + 3]; if (placed.some(q => q[0] < r[2] && q[2] > r[0] && q[1] < r[3] && q[3] > r[1])) continue; placed.push(r); want.add(it.key);
    let L = LB.get(it.key); if (!L){ const el = document.createElement('button'); el.className = 'lb ' + it.cls; el.type = 'button'; L = { el, html: '', col: '' }; LB.set(it.key, L); lblEl.appendChild(el); requestAnimationFrame(() => el.classList.add('in')); }
    const hh = it.text + (it.sub ? `<small>${esc(it.sub)}</small>` : ''); L.act = it.act; const el = L.el;
    writes.push(() => { if (L.html !== hh){ L.html = hh; el.innerHTML = hh; } if (it.col && L.col !== it.col){ L.col = it.col; el.style.setProperty('--c', it.col); }
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; el.classList.toggle('on', !!it.on); el.classList.toggle('sel', selKey === it.key); if (L.outT){ clearTimeout(L.outT); L.outT = 0; el.classList.remove('out'); } });
    if (it.lead) leaders += `<path d="M${it.x.toFixed(1)} ${it.y.toFixed(1)}L${x.toFixed(1)} ${(y + h/2).toFixed(1)}"/><circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="1.7"/>`; }
  for (const [key, L] of LB) if (!want.has(key) && !L.outT){ L.el.classList.add('out'); L.outT = setTimeout(() => { L.el.remove(); LB.delete(key); }, 280); }
  for (const w of writes) w();
  if (ov._h !== leaders){ ov._h = leaders; ov.innerHTML = leaders; } }
lblEl.addEventListener('click', e => { const el = e.target.closest('.lb'); if (!el) return; for (const [key, L] of LB) if (L.el === el){ selKey = L.act.type === 'explain' ? key : null; act(L.act); break; } });

/* ---------- the compass ---------- */
const cmp = { N: document.getElementById('cN'), G: document.getElementById('cG'), T: document.getElementById('cT'), R: document.getElementById('cR'), key: '' };
function drawCompass(){ const { R, U } = basis(cam.yaw, cam.pitch), c = [W/2, D/2], pts = cfg.compassPoints();
  const place = (el, wx, wy, rad) => { const v = V3(wx - c[0], wy - c[1], 0), sx = v.dot(R), sy = -v.dot(U), L = Math.hypot(sx, sy) || 1; el.style.transform = `translate(${(sx/L*rad).toFixed(1)}px,${(sy/L*rad).toFixed(1)}px)`; };
  const key = cam.yaw.toFixed(1) + '|' + cam.pitch.toFixed(1) + '|' + W + '|' + D; if (key === cmp.key) return; cmp.key = key;
  place(cmp.G, pts.G[0], pts.G[1], 19.5); place(cmp.T, pts.T[0], pts.T[1], 19.5); place(cmp.R, pts.R[0], pts.R[1], 19.5);
  const f = viewDir(YAW0, 0); cmp.N.style.transform = `rotate(${(Math.atan2(-V3(f.x, f.z, 0).dot(U), V3(f.x, f.z, 0).dot(R))*180/Math.PI + 90).toFixed(1)}deg)`; }

/* ---------- mount ---------- */
const params = q => {
  if (q.has('speed')) SPEED = Math.max(.1, +q.get('speed') || 1);
  if (q.get('boot') === '1') setTimeout(() => bootstrap(), 400);
  if (q.has('web')) depOf('web').replicas = +q.get('web');
  if (q.get('v2') === '1') depOf('web').version = 'v2';
  if (q.get('cache') === '1') applyCache();
  if (q.get('train') === '1') applyTrain();
  if (q.get('spark') === '1') applySpark();
  if (q.has('cordon')){ const n = st.nodes.find(n => n.name === q.get('cordon')); if (n){ n.cordoned = true; n.tape = 1; } } };
const api = { cam, flyTo, frameBox, frameAct, overview, front, follow: setFollow, following: () => follow.on, invalidate, relayout: () => { cam.custom = false; reframe(); }, spin: spinToggle,
  select: a => { selKey = a && a.type === 'explain' ? 'c:' + a.text : null; invalidate(); }, toScreen, isYard: YARD_MODE, box: () => box, ppu, zoomFor, basis: () => basis(cam.yaw, cam.pitch), viewDir: () => viewDir(cam.yaw, cam.pitch), COARSE };
window.yard = api;
function mount(){
  Chrome.init(api);
  startDemo(); params(Q); reframe();
  const camParams = Q.has('yaw') || Q.has('pitch');
  if (camParams){ cam.yaw = +(Q.get('yaw') ?? YAW0); cam.pitch = clampP(+(Q.get('pitch') ?? PITCH0)); applyFrame(); camMoved = false; } else loadCam();
  if (Q.has('cluster')) watchUrl(Q.get('cluster'), +(Q.get('poll') || 0));
  else if (Q.has('web') || Q.get('v2') === '1' || Q.get('cache') === '1' || Q.get('train') === '1' || Q.get('spark') === '1') run();
  if (window.ControlRoom) ControlRoom.mount(document.getElementById('room'), { st, ui, speed: () => SPEED, run, say });
  if (Q.has('chapter')) setTimeout(() => Chrome.applyChapter(Q.get('chapter'), camParams), 350);
  addEventListener('resize', () => { if (cfg.onResize) cfg.onResize(); reframe(); });
  new ResizeObserver(() => { if (cfg.onResize) cfg.onResize(); measure(); invalidate(); }).observe(zwrap);
  invalidate();
}
return { ...api, mount, measure, box: () => box, V3 };
};
