/* ============================================================
   Longshore in three.js: the same yard as figure/longshore.html, drawn with real depth.
   World coordinates are the simulation's (x = depth toward viewer-right, y = width toward viewer-left, z = up);
   three.js sees them as (X = x, Y = z, Z = y), which keeps every screen image the same as the SVG engine's.
   Look: every body has three flat tones picked by how its face meets a light that stays put relative to the
   viewer (BandMaterial), ink comes from one post-pass over depth + normals (heavy at silhouettes, thin at creases,
   wobbled a little), the ground shadow is a flat blue tint from two small shadow maps, text and paint are canvas
   textures on the faces. See src/sim.js for the cluster model this draws.
   ============================================================ */
import * as THREE from './vendor/three.module.js';
THREE.ColorManagement.enabled = false;            // every colour here is an sRGB hex taken as written, like the SVG

const Q = new URLSearchParams(location.search);
if (!st.pal) st.pal = PALS[Q.get('pal')] ? Q.get('pal') : 'mustard';
const V3 = (x, y, z) => new THREE.Vector3(x, z, y);
const PHONE = () => innerWidth <= 560;
const COARSE = matchMedia('(pointer:coarse)').matches;
const DPR = () => Math.min(devicePixelRatio || 1, COARSE ? 1.5 : 2);
const CHANNEL = hex => new THREE.Color(hex);

/* ---------- lights, fixed in view space: the sun from over the viewer's right shoulder, a softer one for insides ---------- */
const SUN = new THREE.Vector3(.556, .805, .177).normalize(), LIN = new THREE.Vector3(.239, .414, .878).normalize();
const TONE = { hi:-.15, lo:-.45 }, TONE_I = { hi:.6, lo:.05 };

/* ---------- materials ---------- */
const shared = {   // uniforms every BandMaterial shares (one object each, so one update reaches all)
  shadowVP: { value: new THREE.Matrix4() }, shadowMap: { value: null }, shadowMap2: { value: null }, shadowOn: { value: 1 },
  shadowCol: { value: CHANNEL(SHADOW) }, shadowTexel: { value: 1/1024 } };
const BAND_VS = `varying vec3 vN; varying vec3 vW; varying vec2 vUv;
void main(){ vN = normalize(normalMatrix * normal); vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vUv = uv; gl_Position = projectionMatrix * viewMatrix * w; }`;
const BAND_FS = `#include <packing>
varying vec3 vN; varying vec3 vW; varying vec2 vUv;
uniform vec3 cl, cm, cd, lightDir, shadowCol; uniform float hi, lo, opacity, receive, hasMap, shadowOn, shadowTexel; uniform sampler2D map, shadowMap, shadowMap2; uniform mat4 shadowVP;
float ss(float a, float b, float x){ float k = clamp((x - a)/(b - a), 0., 1.); return k*k*(3. - 2.*k); }
float lit(sampler2D sm, vec3 s){ if (s.x < 0. || s.x > 1. || s.y < 0. || s.y > 1.) return 0.; float z = unpackRGBAToDepth(texture2D(sm, s.xy)); return s.z - .0018 > z ? 1. : 0.; }
void main(){
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  float d = dot(n, lightDir), a = ss(hi - .18, hi + .18, d), b = ss(lo - .18, lo + .18, d);
  vec3 c = a >= 1. ? cl : b <= 0. ? cd : a > 0. ? mix(cm, cl, a) : b < 1. ? mix(cd, cm, b) : cm;
  if (hasMap > 0.){ vec4 t = texture2D(map, vUv); c = mix(c, t.rgb, t.a); }
  if (receive > 0. && shadowOn > 0.){ vec4 sp = shadowVP * vec4(vW, 1.); vec3 s = sp.xyz / sp.w * .5 + .5;
    float sh = 0.; for (int i = -1; i <= 1; i += 2) for (int j = -1; j <= 1; j += 2) sh += lit(shadowMap, s + vec3(float(i), float(j), 0.) * shadowTexel * .5);
    sh = sh * .25; float sh2 = lit(shadowMap2, s) * .45; c = mix(c, shadowCol, max(sh, sh2)); }
  gl_FragColor = vec4(c, opacity);
}`;
function band(pal, o = {}){
  const t = o.shade === 'tone' ? TONE : TONE_I;
  const m = new THREE.ShaderMaterial({ vertexShader: BAND_VS, fragmentShader: BAND_FS, uniforms: {
    cl: { value: CHANNEL(pal.l) }, cm: { value: CHANNEL(pal.m) }, cd: { value: CHANNEL(pal.d) }, lightDir: { value: o.shade === 'tone' ? SUN : LIN },
    hi: { value: t.hi }, lo: { value: t.lo }, opacity: { value: o.opacity == null ? 1 : o.opacity }, receive: { value: o.receive ? 1 : 0 },
    hasMap: { value: o.map ? 1 : 0 }, map: { value: o.map || null }, ...shared } });
  m.transparent = m.uniforms.opacity.value < 1; m.depthWrite = !m.transparent; m.userData.pal = pal; m.userData.palKey = o.palKey || null;
  return m;
}
const setPal = (m, pal) => { m.uniforms.cl.value.set(pal.l); m.uniforms.cm.value.set(pal.m); m.uniforms.cd.value.set(pal.d); m.userData.pal = pal; };
function setAlpha(mesh, a){   // a mesh (or group): every band / flat material gets opacity a, the ink pass is told too
  mesh.traverse(ob => { if (!ob.isMesh) return; ob.userData.ink = a; for (const m of (Array.isArray(ob.material) ? ob.material : [ob.material])){
    if (m.uniforms && m.uniforms.opacity){ m.uniforms.opacity.value = a * (m.userData.baseA == null ? 1 : m.userData.baseA); m.transparent = m.uniforms.opacity.value < 1; m.depthWrite = !m.transparent; }
    else if (m.isMeshBasicMaterial && m.userData.fades !== false){ m.opacity = a * (m.userData.baseA == null ? 1 : m.userData.baseA); m.transparent = m.opacity < 1; m.depthWrite = !m.transparent && !m.userData.decal; } } });
}
// flat (unshaded) colour: lamps, flames, beads, paint that must not take the tones
const flat = (hex, o = {}) => { const m = new THREE.MeshBasicMaterial({ color: hex, transparent: o.opacity != null && o.opacity < 1, opacity: o.opacity == null ? 1 : o.opacity, depthWrite: o.depthWrite !== false, side: o.side || THREE.FrontSide, map: o.map || null }); if (o.opacity != null) m.userData.baseA = o.opacity; if (o.map) m.userData.decal = true; return m; };
// the ink pass sees normals (rgb) and an ink weight (a) per object; a fading pod fades its lines with it
const EDGE_MAT = new THREE.ShaderMaterial({ uniforms: { inkW: { value: 1 } }, vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `varying vec3 vN; uniform float inkW; void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; gl_FragColor = vec4(n * .5 + .5, inkW); }` });
const edgeHook = function(r, s, c, g, material){ if (material === EDGE_MAT){ material.uniforms.inkW.value = this.userData.ink == null ? 1 : this.userData.ink; material.uniformsNeedUpdate = true; } };
const DEPTH_MAT = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

/* ---------- canvas textures: text, paint, corrugation, glass ---------- */
const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const texCache = new Map();
// a face texture in world units: w along the reading direction, h down the face; draw(g, w, h) paints with the unit scale set
function faceTex(key, w, h, draw, ppu = 8){
  if (key && texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas'); c.width = Math.max(2, Math.ceil(w*ppu)); c.height = Math.max(2, Math.ceil(h*ppu));
  const g = c.getContext('2d'); g.scale(c.width/w, c.height/h); g.lineCap = 'round'; g.lineJoin = 'round'; draw(g, w, h);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  if (key) texCache.set(key, t); return t;
}
const txt = (g, s, x, y, size, col = INK, weight = 800, align = 'center') => { g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };
const rect = (g, x, y, w, h, fill, stroke, lw = .4) => { if (fill){ g.fillStyle = fill; g.fillRect(x, y, w, h); } if (stroke){ g.strokeStyle = stroke; g.lineWidth = lw; g.strokeRect(x, y, w, h); } };
const lineTo = (g, pts, col, lw, dash) => { g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(dash || []); g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]); };
const dot = (g, x, y, r, fill, stroke, lw = .3) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI*2); if (fill){ g.fillStyle = fill; g.fill(); } if (stroke){ g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
const glassPane = (g, x, y, w, h, streak = true) => { rect(g, x, y, w, h, GLASS, INK, .6); if (streak){ g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = .7; g.beginPath(); g.moveTo(x + .8, y + .9); g.lineTo(x + Math.min(w - .8, 3), y + .9); g.stroke(); } };
function noiseTex(n, smooth){ const c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d'), im = g.createImageData(n, n);
  for (let i = 0; i < im.data.length; i += 4){ im.data[i] = Math.random()*255; im.data[i+1] = Math.random()*255; im.data[i+2] = Math.random()*255; im.data[i+3] = 255; } g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = t.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter; t.generateMipmaps = false; return t; }

/* ---------- geometry: boxes with a texture per face, cylinders, rods, lamps ---------- */
const FACE_IDX = { px:0, nx:1, top:2, bot:3, py:4, ny:5 };
const geoCache = new Map();
const boxGeo = (w, h, d) => { const k = `b${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)}`; if (!geoCache.has(k)) geoCache.set(k, new THREE.BoxGeometry(w, h, d)); return geoCache.get(k); };
const cylGeo = (r0, r1, h, n, open) => { const k = `c${r0},${r1},${h.toFixed(3)},${n},${open ? 1 : 0}`; if (!geoCache.has(k)) geoCache.set(k, new THREE.CylinderGeometry(r0, r1, h, n, 1, !!open)); return geoCache.get(k); };
const sphGeo = (r, n = 12) => { const k = `s${r},${n}`; if (!geoCache.has(k)) geoCache.set(k, new THREE.SphereGeometry(r, n, Math.max(6, n/2|0))); return geoCache.get(k); };
let UNIT_CYL;
// an axis-aligned box from its min to its max corner. o.faces: { px, nx, top, bot, py, ny } textures (world faces: +x, -x, up,
// down, +y, -y); o.shade 'tone' (sunlit exterior) or default interior; o.receive for ground that takes the cast shadow
function mkBox(x0, y0, z0, x1, y1, z1, pal, o = {}){
  const g = boxGeo(x1 - x0, z1 - z0, y1 - y0);
  let mat;
  if (o.faces && Object.keys(o.faces).length){ const base = band(pal, o); mat = [base, base, base, base, base, base];
    for (const [f, t] of Object.entries(o.faces)) if (t) mat[FACE_IDX[f]] = band(pal, { ...o, map: t }); }
  else mat = band(pal, o);
  const m = new THREE.Mesh(g, mat); m.position.copy(V3((x0 + x1)/2, (y0 + y1)/2, (z0 + z1)/2));
  m.onBeforeRender = edgeHook; if (o.layer != null) m.layers.set(o.layer); if (o.ink != null) m.userData.ink = o.ink; return m;
}
function mkCyl(x, y, z0, z1, r, pal, o = {}){ const m = new THREE.Mesh(cylGeo(r, o.r1 == null ? r : o.r1, z1 - z0, o.n || 18, o.open), o.mat || band(pal, o)); m.position.copy(V3(x, y, (z0 + z1)/2)); m.onBeforeRender = edgeHook; if (o.layer != null) m.layers.set(o.layer); return m; }
// a rod between two world points (a cable, a post, a strut); r1 for a cone
function mkRod(a, b, r, pal, o = {}){
  if (!UNIT_CYL) UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
  const g = o.r1 != null ? cylGeo(o.r1, r, 1, o.n || 12) : UNIT_CYL;
  const m = new THREE.Mesh(g, o.mat || band(pal, o)); m.onBeforeRender = edgeHook; if (o.layer != null) m.layers.set(o.layer);
  rodTo(m, a, b, r); return m;
}
function rodTo(m, a, b, r){ const A = V3(...a), B = V3(...b), d = B.clone().sub(A), L = d.length() || 1e-4;
  m.position.copy(A).add(B).multiplyScalar(.5); m.scale.set(r, L, r); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); }
// a status lamp: a dark base ring, a coloured dome, a faint halo
function mkLamp(x, y, z, col, r = 1.1){
  const g = new THREE.Group(); g.add(mkCyl(x, y, z, z + .7, r, DARK, { n: 10 }));
  const dome = new THREE.Mesh(sphGeo(1, 10), flat(col)); dome.scale.setScalar(r*.85); dome.position.copy(V3(x, y, z + .75)); dome.onBeforeRender = edgeHook; g.add(dome);
  const halo = new THREE.Mesh(cylGeo(1, 1, .05, 12), flat(col, { opacity: .22, depthWrite: false })); halo.scale.set(r*2.2, 1, r*2.2); halo.position.copy(V3(x, y, z + .8)); halo.layers.set(3); g.add(halo);
  g.userData.lamp = { dome, halo }; return g;
}
const lampColor = (g, col) => { const l = g.userData.lamp; if (l.dome.material.color.getHexString() !== col.slice(1)){ l.dome.material.color.set(col); l.halo.material.color.set(col); } };
// a flat decal on a plane (text on a cylinder, a halo): n = the face normal, u = the reading direction
function mkDecal(p, n, u, w, h, tex, o = {}){
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), flat('#ffffff', { map: tex, opacity: o.opacity == null ? 1 : o.opacity, depthWrite: false }));
  m.material.transparent = true; m.position.copy(V3(...p)); const N = V3(...n).normalize(), U = V3(...u).normalize(), V = new THREE.Vector3().crossVectors(N, U);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(U, V, N)); m.layers.set(3); return m;
}
function dispose(ob){ ob.traverse(x => { if (x.isMesh){ for (const m of (Array.isArray(x.material) ? x.material : [x.material])) if (m && !m.userData.shared) m.dispose(); } }); if (ob.parent) ob.parent.remove(ob); }

/* ---------- the pieces of the yard (world coordinates, exactly the SVG figure's) ---------- */
const m0 = () => PALS[st.pal];
const PAUSE = { l:'#8d98a8', m:'#6c7686', d:'#434b58' }, LOCK = { l:'#5a5751', m:'#3d3a35', d:'#26241f' }, TANK = { l:'#dfe6ea', m:'#b9c5cb', d:'#7f8d94' }, RAIL = { l:'#9aa3a8', m:'#6f7a80', d:'#454d52' };
const CREAM = '#fff4d6', RED = '#e2483d', BLUE = '#2d7bd6';

// the long side of a container: corrugation, the app stencil, the version, the pale v2 band, the gold GPU band
function sideTex(pm, app, ver, bandOn, gpu){
  return faceTex(`side|${pm.l}|${app}|${ver}|${bandOn ? 1 : 0}|${gpu || 0}`, PL, PH, (g, w, h) => {
    g.strokeStyle = 'rgba(35,30,22,.35)'; g.lineWidth = .3; for (let y = 2; y < w - 1; y += 2){ g.beginPath(); g.moveTo(y, 1); g.lineTo(y, h - 1); g.stroke(); }
    lineTo(g, [[.4, .8], [w - .4, .8]], INK, .4); lineTo(g, [[.4, h - .8], [w - .4, h - .8]], INK, .4);
    if (bandOn) rect(g, .4, 1.3, w - .8, 1.9, mix(pm.l, '#ffffff', .62));
    const tc = mix(pm.d, '#000000', .25);
    txt(g, app.slice(0, 9).toUpperCase(), w/2, h - 3.1, 4.2, tc, 800); txt(g, ver, w/2, h - 6.2, 2.3, tc, 700);
    if (gpu){ rect(g, .4, h - 2.4, w - .8, 1.8, GOLD); txt(g, `GPU x${gpu}`, w/2, h - 1.5, 1.6, INK, 800); } }, 10);
}
const doorTex = (pm, name) => faceTex(`door|${pm.l}|${name}`, PW, PH, (g, w, h) => {
  lineTo(g, [[w/2, .6], [w/2, h - .6]], INK, .7); for (const dx of [2.1, 3.5, 6.5, 7.9]) lineTo(g, [[dx, 1], [dx, h - 1]], INK, .5);
  for (const dx of [3.5, 6.5]) lineTo(g, [[dx - .9, h - 4.6], [dx + .9, h - 4.6]], INK, .7);
  if (name) txt(g, name.slice(-5), w/2, 1.6, 1.9, mix(pm.d, '#000000', .3), 700); }, 12);
const backTex = pm => faceTex(`back|${pm.l}`, PW, PH, (g, w, h) => rect(g, 1, 1, w - 2, h - 2, null, INK, .45), 10);
const bandTopTex = pm => faceTex(`bandtop|${pm.l}`, PW, PL, (g, w, h) => { g.globalAlpha = .55; rect(g, .3, .4, w - .6, h - .8, mix(pm.l, '#ffffff', .62)); }, 6);
// a container body at its min corner (a pod, or an image on the registry shelf)
function mkContainer(x0, y0, z0, pm, o){
  const faces = { px: sideTex(pm, o.app, o.ver, o.band, o.gpu), nx: sideTex(pm, o.app, o.ver, o.band, o.gpu), py: doorTex(pm, o.name), ny: backTex(pm) };
  if (o.band) faces.top = bandTopTex(pm);
  return mkBox(x0, y0, z0, x0 + PW, y0 + PL, z0 + PH, pm, { shade: 'tone', faces });
}
// what is inside a pod: one crate per container, the pause box with its socket and cable, the ConfigMap clipboard, the Secret lockbox
function mkPodInside(p, x0, y0, z0){
  const g = new THREE.Group(), z = z0 + .5, n = p.containers.length, cw = Math.min(7, (PL - 7)/n - 1.2);
  p.containers.forEach((c, i) => { const cy0 = y0 + 2.2 + i*(cw + 1.2), cx0 = x0 + 2;
    const tex = faceTex(`crate|${c.name}|${cw.toFixed(2)}`, cw, 6, (gg, w, h) => { txt(gg, c.name.slice(0, 9), w/2, h - 2.6, 1.5, '#5a4a2a', 700); lineTo(gg, [[.6, h - 4.2], [w - .6, h - 4.2]], INK, .35); lineTo(gg, [[.6, h - 1.3], [w - .6, h - 1.3]], INK, .35); }, 12);
    g.add(mkBox(cx0, cy0, z, cx0 + 6, cy0 + cw, z + 6, CRATE, { faces: { px: tex } })); });
  g.add(mkBox(x0 + .8, y0 + PL - 3.4, z, x0 + 3.4, y0 + PL - .8, z + 2.4, PAUSE));
  const sock = mkBox(x0 + .12, y0 + PL - 3, z0 + 4, x0 + .4, y0 + PL - 1.2, z0 + 6, matOf(GLASS)); g.add(sock);
  for (const [a, b] of [[[x0 + .4, y0 + PL - 2.1, z0 + 5], [x0 + .5, y0 + PL - 2.1, z0 + 2.4]], [[x0 + .5, y0 + PL - 2.1, z0 + 2.4], [x0 + 2.1, y0 + PL - 2.1, z0 + 2.4]]]) g.add(mkRod(a, b, .45, matOf(BLUE)));
  if (p.configMap){ const tex = faceTex('clip', 4.8, 5.6, (gg, w, h) => { for (const zz of [1.2, 2.6, 4]) lineTo(gg, [[.8, h - zz], [w - .8, h - zz]], INK, .35); }, 12);
    g.add(mkBox(x0 + 2.6, y0 + .3, z0 + 3, x0 + 7.4, y0 + .9, z0 + 8.6, CERAMIC, { faces: { py: tex } })); g.add(mkBox(x0 + 4.4, y0 + .2, z0 + 8.2, x0 + 5.6, y0 + 1.1, z0 + 9.2, DARK)); }
  if (p.secret){ const tex = faceTex('lock', 3.2, 2.6, (gg, w, h) => dot(gg, w/2, h/2, .6, GOLD), 16); g.add(mkBox(x0 + 6, y0 + 1.2, z, x0 + 9, y0 + 4.4, z + 2.6, LOCK, { faces: { px: tex } })); }
  return g;
}
// the PersistentVolume: a tank on two brackets off the container's far end
function mkTank(x0, y0, z0){
  const g = new THREE.Group(), cx = x0 + 5, cy = y0 - 3.2, r = 2.6;
  g.add(mkBox(x0 + 3.2, y0 - 2.2, z0 + 1.6, x0 + 6.8, y0, z0 + 2.4, DARK), mkBox(x0 + 3.2, y0 - 2.2, z0 + 7.4, x0 + 6.8, y0, z0 + 8.2, DARK));
  g.add(mkCyl(cx, cy, z0 + .4, z0 + 9.4, r, TANK, { n: 18 }));
  g.add(mkDecal([cx + r + .06, cy, z0 + 4], [1, 0, 0], [0, -1, 0], 3.4, 2.4, faceTex('pv', 3.4, 2.4, (gg, w, h) => txt(gg, 'PV', w/2, h/2, 2.2, '#4d5a60', 800), 20)));
  g.add(mkRod([cx, cy, z0 + 9.4], [cx, cy, z0 + 10.4], .6, DARK)); return g;
}
// a parachute: a striped canopy with four shroud lines to the container's top corners
function mkChute(pm){
  const g = new THREE.Group(), R = 13, n = 16, zt = PH, rimZ = zt + 8, apex = zt + 17;
  const geo = new THREE.CylinderGeometry(1.2, R, apex - rimZ, n, 1, true); geo.clearGroups(); for (let i = 0; i < n; i++) geo.addGroup(i*6, 6, i % 2);
  const canopy = new THREE.Mesh(geo, [band(CERAMIC, { shade: 'tone' }), band(pm, { shade: 'tone' })]); canopy.material.forEach(m => m.side = THREE.DoubleSide);
  canopy.position.copy(V3(PW/2, PL/2, (rimZ + apex)/2)); canopy.onBeforeRender = edgeHook; g.add(canopy);
  for (const [i, c] of [[2, [PW - .4, PL - .4]], [6, [.4, PL - .4]], [10, [.4, .4]], [14, [PW - .4, .4]]]){ const a = (i/n + .5/n)*Math.PI*2;   // the rim seam nearest each corner
    g.add(mkRod([PW/2 + R*Math.cos(a), PL/2 + R*Math.sin(a), rimZ], [c[0], c[1], zt], .22, DARK)); }
  return g;
}
function mkFire(){ const g = new THREE.Group();
  for (const [dy, h] of [[-5, 5], [0, 7.5], [5, 5.5]]){ const f1 = new THREE.Mesh(cylGeo(0, 2.3, h, 7), flat('#ff6a2a')); f1.position.copy(V3(PW/2, PL/2 + dy, PH + h/2)); f1.onBeforeRender = edgeHook; g.add(f1);
    const f2 = new THREE.Mesh(cylGeo(0, 1.2, h*.6, 7), flat('#ffd23c')); f2.position.copy(V3(PW/2 + .6, PL/2 + dy, PH + h*.3)); f2.layers.set(3); g.add(f2); }
  for (const [dy, h, r] of [[-3, 10, 2], [2, 13, 2.6], [6, 16, 3]]){ const s = new THREE.Mesh(sphGeo(1, 8), flat('#8a8580', { opacity: .5, depthWrite: false })); s.scale.setScalar(r); s.position.copy(V3(PW/2, PL/2 + dy, PH + h)); s.layers.set(3); g.add(s); }
  return g; }

/* ---------- scene state: what is built, and what it was built from ---------- */
const scene = new THREE.Scene();
const Y = { statics: new THREE.Group(), nodes: new Map(), pods: new Map(), parcels: [], crane: null, registry: null, board: null, kiosk: null, gate: null, tower: null, key: '' };
scene.add(Y.statics);
const pickables = [];

function staticKey(){ return [W, D, HTOP, HZT, BZ, XR0, XR1, LANE, st.pal, st.nodes.map(n => n.name + ':' + n.row).join(','), (st.ingresses[0] || {}).host, (svcMain() || {}).name].join('|'); }
function rebuildStatic(){
  dispose(Y.statics); Y.statics = new THREE.Group(); scene.add(Y.statics); pickables.length = 0;
  for (const N of Y.nodes.values()) dispose(N.g); Y.nodes.clear();
  const m = m0(), S = Y.statics;
  // the yard board: a rounded slab, its top painted with the lane, the branch lanes to each dock and the kiosk, and the edge line
  const shape = new THREE.Shape(); const r = 6; shape.moveTo(r, 0); shape.lineTo(W - r, 0); shape.absarc(W - r, r, r, -Math.PI/2, 0); shape.lineTo(W, D - r); shape.absarc(W - r, D - r, r, 0, Math.PI/2); shape.lineTo(r, D); shape.absarc(r, D - r, r, Math.PI/2, Math.PI); shape.lineTo(0, r); shape.absarc(r, r, r, Math.PI, Math.PI*1.5);
  const bg = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false, curveSegments: 6 });
  // ExtrudeGeometry lies in its own xy plane; turn it so shape x = world x, shape y = world y, extrusion = up
  bg.rotateX(Math.PI/2); bg.translate(0, 0, 0);
  const paint = faceTex(`paint|${W}|${D}|${st.nodes.map(n => n.row === 0 ? n.y0 : '').join(',')}`, W, D, (g, w, h) => {
    rect(g, 0, 0, w, h, YARD.l); rect(g, W - 32, 0, 22, D, '#d8d2c3');
    lineTo(g, [[W - 32, 0], [W - 32, D]], CREAM, 1.1); lineTo(g, [[W - 10, 0], [W - 10, D]], CREAM, 1.1); lineTo(g, [[W - 21, 0], [W - 21, D]], CREAM, .9, [5, 4]);
    for (const n of st.nodes) if (n.row === 0){ const y = n.y0 + SLW/2; lineTo(g, [[W - 32, y], [n.x0 + SLD + 2, y]], CREAM, 1, [3, 3]);
      g.fillStyle = CREAM; g.beginPath(); g.moveTo(n.x0 + SLD + 2, y - 2.2); g.lineTo(n.x0 + SLD + 2, y + 2.2); g.lineTo(n.x0 + SLD - 1.5, y); g.fill(); }
    lineTo(g, [[W - 32, 45], [W - 42, 45]], CREAM, 1, [3, 3]); g.strokeStyle = INK; g.lineWidth = .5; g.strokeRect(.25, .25, w - .5, h - .5); }, 4);
  // the extrude's top face UVs run with world x and y, so the paint maps straight on (the sides take the plain tones)
  const bmat = [band(YARD, { map: paint, receive: true }), band(YARD)];
  const board = new THREE.Mesh(bg, bmat); board.position.copy(V3(0, 0, 0)); board.onBeforeRender = edgeHook; S.add(board);
  fixExtrudeUV(bg, W, D);
  // rails on the floor
  for (const x of [XR0, XR1]) S.add(mkBox(x - 1, 0, 0, x + 1, D, 1.5, RAIL, { faces: { top: faceTex('railtop', 2, D, (g, w, h) => lineTo(g, [[1, 0], [1, h]], 'rgba(35,30,22,.5)', .35), 4) } }));
  Y.tower = mkTower(m); S.add(Y.tower.g);
  Y.board = mkBoard(); S.add(Y.board.g);
  Y.registry = mkRegistry(m); S.add(Y.registry.g);
  Y.kiosk = mkKiosk(m); S.add(Y.kiosk.g);
  Y.gate = mkGate(m); S.add(Y.gate.g);
  Y.crane = mkCrane(m); S.add(Y.crane.g);
  for (const P of Y.pods.values()) pickables.push(P.body);
  Y.key = staticKey();
}
// ExtrudeGeometry's UVs are in shape units; scale them to 0..1 across the board for the paint
function fixExtrudeUV(geo, w, d){ const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i)/w, 1 - uv.getY(i)/d); uv.needsUpdate = true; }

/* the control tower: base, glazed cab, roof, mast; inside: etcd, API server, scheduler, controller manager */
function mkTower(m){
  const g = new THREE.Group(), out = { g, cases: [], insides: [] }, tc = mix(m.d, '#000000', .2);
  const baseTex = faceTex(`towerpx|${m.l}`, 24, 30, (gg, w, h) => { txt(gg, 'CONTROL', w - 10, h - 16.4, 3.3, tc); txt(gg, 'PLANE', w - 10, h - 12.4, 3.3, tc);
    rect(gg, w - 15, h - 9, 6, 9, mix(m.d, '#000000', .3), INK, .8); for (const z of [20, 25]) glassPane(gg, w - 22.5, h - z - 2.6, 4, 2.6, false); }, 10);
  const baseSide = faceTex(`towerpy|${m.l}`, 24, 30, (gg, w, h) => { for (const z of [12, 18, 24]) glassPane(gg, 4, h - z - 2.6, 4, 2.6, false); }, 10);
  const base = mkBox(6, 6, 0, 30, 30, 30, m, { shade: 'tone', faces: { px: baseTex, py: baseSide }, palKey: 1 }); g.add(base); out.cases.push(base);
  const ins = new THREE.Group();
  const etcdTex = faceTex('etcd', 12, 12, (gg, w, h) => { for (const z of [3, 6.5, 10]) lineTo(gg, [[1.5, h - z], [w - 1.5, h - z]], INK, .5); txt(gg, 'etcd', w/2, h - 1.9, 1.9, PAPER, 800); }, 12);
  ins.add(mkBox(9, 9, 0, 21, 21, 12, LOCK, { faces: { px: etcdTex } }));
  ins.add(mkBox(7, 7, 14, 29, 29, 15, CONC));
  out.apiTex = () => faceTex(`api|${st.cp.api}`, 10, 7, (gg, w, h) => { for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) dot(gg, w - 1.5 - i*1.4, h - 2.5 - j*2, .45, !st.cp.api ? '#6b6560' : (i + j) % 3 ? LAMPC.green : LAMPC.amber); txt(gg, 'API', w/2, h - 1.6, 1.9, '#5a4a2a', 800); }, 14);
  out.api = mkBox(8, 12, 15, 26, 22, 22, CERAMIC, { faces: { px: out.apiTex() } }); ins.add(out.api);
  ins.add(mkBox(7, 7, 29, 29, 29, 30, CONC));
  // the cab: glass on all four sides with mullions and a streak
  const glassTex = (w, h, key) => faceTex(`cab|${key}|${m.l}`, w, h, (gg, ww, hh) => { glassPane(gg, 1, 2, ww - 2, 7); for (const u of [11, 18, 25]) lineTo(gg, [[u - 3, 2], [u - 3, 9]], INK, .6); }, 8);
  const cab = mkBox(3, 3, 30, 33, 33, 42, m, { shade: 'tone', faces: { px: glassTex(30, 12, 'px'), nx: glassTex(30, 12, 'nx'), py: glassTex(30, 12, 'py'), ny: glassTex(30, 12, 'ny') }, palKey: 1 }); g.add(cab); out.cases.push(cab);
  const ins2 = new THREE.Group();
  const deskTex = faceTex('scrn', 9, 5, (gg, w, h) => { for (const i of [1, 2, 3]) lineTo(gg, [[1, h - 1 - i], [w - 1, h - 1 - i]], INK, .35); rect(gg, 3, h - 1.9, 3, .7, PALS.cobalt.l); }, 14);
  ins2.add(mkBox(6, 20, 30, 16, 31, 35, WOOD), mkBox(6.5, 21, 35, 7.3, 30, 40, CERAMIC, { faces: { px: deskTex } }));
  const gearTex = faceTex('gears', 10, 8, (gg, w, h) => { for (const [y, z, r] of [[9, 33, 1.8], [13, 35.5, 1.4], [9.5, 36.5, .9]]){ const cx = 16 - y, cy = 38 - z; dot(gg, cx, cy, r, METAL.m, INK, .4); dot(gg, cx, cy, r*.3, INK); } }, 14);
  ins2.add(mkBox(20, 6, 30, 30, 16, 38, DARK, { faces: { px: gearTex } }));
  g.add(ins, ins2); out.insides.push(ins, ins2);
  const roof = mkBox(2, 2, 42, 34, 34, 44, DARK, { shade: 'tone' }); g.add(roof);
  g.add(mkRod([18, 18, 44], [18, 18, 56], .5, METAL), mkRod([10, 18, 44], [10, 18, 49], .4, METAL), mkRod([10, 18, 49], [6, 22, 51], .3, METAL));
  out.lamp = mkLamp(18, 18, 56, LAMPC.green, 1); g.add(out.lamp);
  // the etcd lamp on the cabinet's front: a flat dot on the face is enough
  out.etcdDot = mkDecal([21.08, 15, 4.8], [1, 0, 0], [0, -1, 0], 2, 2, faceTex('dotgold', 2, 2, (gg, w, h) => dot(gg, 1, 1, .9, GOLD), 20)); ins.add(out.etcdDot);
  out.etcdDotOff = mkDecal([21.08, 15, 4.8], [1, 0, 0], [0, -1, 0], 2, 2, faceTex('dotoff', 2, 2, (gg, w, h) => dot(gg, 1, 1, .9, '#6b6560'), 20)); ins.add(out.etcdDotOff);
  return out;
}
/* the Deployments status board by the tower */
function mkBoard(){
  const g = new THREE.Group(), Y0 = 40, Y1 = 72, out = { g, key: '' };
  g.add(mkRod([37, Y0 + 2, 0], [37, Y0 + 2, 22], .7, METAL), mkRod([37, Y1 - 2, 0], [37, Y1 - 2, 22], .7, METAL));
  out.face = mkBox(36, Y0, 6, 38, Y1, 26, CERAMIC, { faces: { px: boardTex(out) } }); g.add(out.face); return out;
}
function boardRows(){ const deps = st.deploys.filter(d => !d.sys || st.showSys).slice(0, 4);
  return deps.map(d => { const live = podsOf(d.app), rd = d.kind === 'Job' ? (d.spawned && !live.length ? d.replicas : live.filter(p => p.phase === 'done').length) : live.filter(isReady).length;
    return { col: palOf(d.app).l, text: `${d.name.slice(0, 7)} ${rd}/${d.replicas} ${d.kind === 'Job' ? (rd === d.replicas ? 'done' : 'job') : d.version.slice(0, 6)}`, bad: rd < d.replicas }; }); }
function boardTex(out){ const rows = boardRows(); out.key = JSON.stringify(rows);
  return faceTex('board|' + out.key, 32, 20, (g, w, h) => { rect(g, .3, h - 19.7, w - .6, 3.3, INK); txt(g, 'DEPLOYMENTS', w/2, h - 18.9, 2.6, PAPER, 800);
    rows.forEach((r, i) => { const z = 19.2 - i*3.6 - 6; rect(g, 2.5, h - z - 1.4, 3, 2.4, r.col, INK, .4); txt(g, r.text, w/2 + 2.5, h - z - .9, 2.5, r.bad ? '#b3261e' : INK, 800); });
    if (!rows.length) txt(g, 'nothing applied', w/2, h - 10, 2.3, '#857d6e', 700); }, 12); }
/* the image registry shelf */
function mkRegistry(m){
  const g = new THREE.Group(), y1 = REG_Y0 + REG_MAX*REG_GAP, out = { g, stacks: new THREE.Group(), key: '' };
  g.add(mkBox(4, REG_Y0, 0, 6, y1, 18, m, { shade: 'tone', faces: { px: faceTex(`reg|${m.l}`, y1 - REG_Y0, 18, (gg, w, h) => txt(gg, 'IMAGE REGISTRY', w/2, h - 12, 4.6, mix(m.d, '#000000', .2)), 8) }, palKey: 1 }));
  g.add(mkBox(6, REG_Y0, 0, 28, y1, 2, CONC, { shade: 'tone', receive: true })); g.add(out.stacks); return out;
}
function syncRegistry(){ const R = Y.registry, key = st.regApps.map(a => a + ':' + (depOf(a) ? depOf(a).version : 'img') + ':' + palOf(a).l).join(',');
  if (key === R.key) return; R.key = key; dispose(R.stacks); R.stacks = new THREE.Group(); R.g.add(R.stacks);
  st.regApps.forEach((app, i) => { const y0 = REG_Y0 + 4 + i*REG_GAP, pm = palOf(app), dep = depOf(app);
    for (let t = 0; t < 2; t++) R.stacks.add(mkContainer(9, y0, 2 + t*PH, pm, { app, ver: dep ? dep.version : 'img', band: false, name: '' })); }); }
/* the gantry crane: rails are on the floor; two columns a side, a tie beam over the girder, the girder, the cab, the trolley, cables, spreader */
function mkCrane(m){
  const g = new THREE.Group(), out = { g }, TZ = BZ + 4.5, XB0 = 3;
  g.layers.set(2);
  for (const x of [XR0, XR1]){ for (const dy of [-15, 15]){ g.add(mkBox(x - 1.2, dy - 1.2, 1.5, x + 1.2, dy + 1.2, TZ, m, { shade: 'tone', palKey: 1 }), mkBox(x - 2, dy - 2, 1.5, x + 2, dy + 2, 4, DARK)); }
    g.add(mkBox(x - 2, -16.4, TZ, x + 2, 16.4, TZ + 3.5, m, { shade: 'tone', palKey: 1 })); }
  const truss = faceTex('truss', XR1 + 2.5 - XB0, 4.5, (gg, w, h) => { gg.strokeStyle = 'rgba(35,30,22,.5)'; gg.lineWidth = .4; gg.beginPath(); for (let x = 2; x < w - 4; x += 7){ gg.moveTo(x, h - .5); gg.lineTo(x + 3.5, h - 4); gg.lineTo(x + 7, h - .5); } gg.stroke(); }, 8);
  const trussR = faceTex('trussR', XR1 + 2.5 - XB0, 4.5, (gg, w, h) => { gg.strokeStyle = 'rgba(35,30,22,.5)'; gg.lineWidth = .4; gg.beginPath(); for (let x = 2; x < w - 4; x += 7){ gg.moveTo(w - x, h - .5); gg.lineTo(w - x - 3.5, h - 4); gg.lineTo(w - x - 7, h - .5); } gg.stroke(); }, 8);
  g.add(mkBox(XB0, -2.2, BZ, XR1 + 2.5, 2.2, BZ + 4.5, m, { shade: 'tone', palKey: 1, faces: { py: truss, ny: trussR, px: faceTex(`sched|${m.l}`, 4.4, 4.5, (gg, w, h) => txt(gg, 'SCHED', w/2, h - 3.2, 1.6, mix(m.d, '#000000', .2)), 20) } }));
  const cy0 = 16.5, cy1 = 22.5, cz0 = TZ - 3.5, cz1 = TZ + 3.5;
  const cabG = (w, h, key) => faceTex(`ccab|${key}`, w, h, (gg, ww, hh) => glassPane(gg, .8, .8, ww - 1.6, hh - 1.8, false), 10);
  g.add(mkBox(XR1 - 2, cy0, cz0, XR1 + 4, cy1, cz1, m, { shade: 'tone', palKey: 1, faces: { px: cabG(6, 7, 'px'), py: cabG(6, 7, 'py') } }));
  // the trolley runs along the girder; the hoist hangs under it
  out.trolley = new THREE.Group(); out.trolley.add(mkBox(-3.2, -3.2, BZ - 4.5, 3.2, 3.2, BZ, DARK)); g.add(out.trolley);
  out.hoist = new THREE.Group();
  out.hoist.add(mkBox(-PW/2 + .5, -PL/2 + .5, PH, PW/2 - .5, PL/2 - .5, PH + 1.6, matOf('#f2c230')));
  for (const dy of [-PL/2 + 1.5, PL/2 - 1.5]) out.hoist.add(mkBox(-PW/2 + .8, dy - .6, PH - .9, PW/2 - .8, dy + .6, PH, DARK));
  out.cables = [mkRod([-1, 0, 0], [-1, 0, 1], .3, DARK), mkRod([1, 0, 0], [1, 0, 1], .3, DARK)]; out.hoist.add(...out.cables); g.add(out.hoist);
  g.traverse(o => o.layers.set(2)); return out;
}
function syncCrane(){ const c = st.crane, C = Y.crane; C.g.position.copy(V3(0, c.y, 0)); C.trolley.position.copy(V3(c.x, 0, 0)); C.hoist.position.copy(V3(c.x, 0, c.z));
  const top = BZ - 4.5 - c.z - PH - 1.6; for (const [i, dx] of [[0, -1], [1, 1]]) rodTo(C.cables[i], [dx, 0, PH + 1.6], [dx, 0, PH + 1.6 + Math.max(.1, top)], .3); }
/* the Service kiosk and the Ingress gate */
function mkKiosk(m){
  const g = new THREE.Group(), x0 = W - 42, x1 = W - 32, y0 = 36, y1 = 54, out = { g, cases: [], insides: [], key: '' };
  const win = faceTex('kwin', 18, 11, (gg, w, h) => glassPane(gg, 2.5, h - 8.6, 13, 4.6), 10);
  const body = mkBox(x0, y0, 0, x1, y1, 11, CONC, { shade: 'tone', faces: { px: win } }); body.userData.act = { type: 'kiosk' }; pickables.push(body); g.add(body); out.cases.push(body);
  g.add(mkBox(x1, y0 + 2, 3, x1 + 2.2, y1 - 2, 4, WOOD), mkBox(x0 - .8, y0 - .8, 11, x1 + .8, y1 + .8, 12.5, m, { shade: 'tone', palKey: 1 }));
  const svc = svcMain();
  g.add(mkBox(x1 - 2.2, y0 + 1, 12.5, x1 - .6, y1 - 1, 20, CERAMIC, { shade: 'tone', faces: { px: faceTex(`ksign|${svc ? svc.name + (svc.ports || [])[0] : ''}`, 16, 7.5, (gg, w, h) => { txt(gg, 'SERVICE', w/2, h - 2.9, 2.8, INK); txt(gg, svc ? `${svc.name}:${(svc.ports || [])[0] || 80}` : 'none', w/2, h - 6.1, 2.4, '#5a82c6'); }, 12) } }));
  const ins = new THREE.Group(); out.panel = mkBox(x0 + 1, y0 + 2, 0, x0 + 2.4, y1 - 2, 9, DARK, { faces: { px: panelTex(out) } }); ins.add(out.panel);
  ins.add(mkBox(x0 + 4, y0 + 2, 0, x1 - 1, y0 + 8, 4, WOOD));
  for (const [a, b] of [[[x0 + 2.4, y0 + 6, 1], [x0 + 5, y0 + 6, 1]], [[x0 + 5, y0 + 6, 1], [x0 + 5, y0 - 1, 1]], [[x0 + 5, y0 - 1, 1], [x0 - 2, y0 - 1, 1]]]) ins.add(mkRod(a, b, .45, matOf(BLUE)));
  g.add(ins); out.insides.push(ins); return out;
}
function panelTex(out){ const svc = svcMain(), all = st.pods.filter(p => svc && p.app === (svc.selector || {}).app && p.pos && p.phase !== 'terminating').slice(0, 10);
  const key = all.map(p => isReady(p) ? 'g' : 'a').join(''); out.key = key;
  return faceTex('panel|' + key, 16, 9, (g, w, h) => { all.forEach((p, i) => { const zz = 6.5 - Math.floor(i/5)*2.6; dot(g, w - 4 - (i % 5)*2.6, h - zz, .7, isReady(p) ? LAMPC.green : LAMPC.amber, INK, .3); }); }, 12); }
function mkGate(m){
  const g = new THREE.Group(), gx0 = W - 36, gx1 = W - 9, ing = st.ingresses[0], out = { g }, tc = mix(m.d, '#000000', .2);
  for (const x of [gx0, gx1]) g.add(mkBox(x, 18, 0, x + 3, 21.5, 18, m, { shade: 'tone', palKey: 1 }), mkBox(x - .6, 17.4, 0, x + 3.6, 22.1, 1.2, DARK));
  const bw = gx1 + 4 - (gx0 - 1), host = ing ? ing.host : 'ingress';
  const beam = mkBox(gx0 - 1, 17.5, 18, gx1 + 4, 22, 22.5, m, { shade: 'tone', palKey: 1, faces: {
    py: faceTex(`host|${host}|${m.l}`, bw, 4.5, (gg, w, h) => txt(gg, host, w/2, h - 3, 2.6, tc), 10),
    ny: faceTex(`ingress|${m.l}`, bw, 4.5, (gg, w, h) => txt(gg, 'INGRESS', w/2, h - 3, 2.8, tc), 10),
    px: faceTex(`in|${m.l}`, 4.5, 4.5, (gg, w, h) => txt(gg, 'IN', w/2, h - 3, 2, tc), 20) } });
  beam.userData.act = { type: 'gate' }; pickables.push(beam); g.add(beam);
  // boom barrier on the near post, swinging up for traffic: a group pivoted at the post
  out.boom = new THREE.Group(); const piv = [gx1 - .5, 19.75, 7], len = gx1 - gx0 - 5;
  out.boom.position.copy(V3(...piv));
  out.boom.add(mkRod([0, 0, 0], [-len, 0, 0], .7, CERAMIC)); for (let i = 1; i <= 3; i++){ const t0 = (i*2 - 1)/7, t1 = (i*2)/7; out.boom.add(mkRod([-len*t0, 0, 0], [-len*t1, 0, 0], .76, matOf(RED))); }
  g.add(out.boom); const hub = new THREE.Mesh(cylGeo(1.4, 1.4, 2, 10), band(DARK)); hub.rotation.z = Math.PI/2; hub.position.copy(V3(gx1 - .5, 19.75, 7)); hub.onBeforeRender = edgeHook; g.add(hub);
  return out;
}
/* a node: slab (slot outlines, the name stencil), GPU units, kubelet booth, capacity gauge, cordon tape */
function slabTex(n){ const used = []; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) used.push(n.used.has(slotKey({ c, r, t:0 })) ? 1 : 0);
  return faceTex(`slab|${n.name}|${n.gpus || 0}|${used.join('')}`, SLD, SLW, (g, w, h) => { let i = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++, i++) if (!used[i]){ const [sx, sy] = slotPos(n, { c, r, t:0 }); g.strokeStyle = 'rgba(35,30,22,.45)'; g.lineWidth = .5; g.setLineDash([2, 1.5]); g.strokeRect(sx - n.x0, sy - n.y0, PW, PL); g.setLineDash([]); }
    g.save(); g.translate(w - 3.2, h/2); g.rotate(-Math.PI/2); txt(g, n.name + (n.gpus ? `  GPU x${n.gpus}` : ''), 0, 0, 4.2, '#6b6559', 800); g.restore(); }, 8); }
function gaugeTex(frac, gc){ const q = Math.round(frac*20)/20; return faceTex(`gauge|${q}|${gc}`, 2.6, 10.5, (g, w, h) => { rect(g, .3, h - .6 - 9.2, w - .6, 9.2, '#efe9da'); rect(g, .3, h - .6 - Math.max(.3, 9.2*q), w - .6, Math.max(.3, 9.2*q), gc); for (let i = 1; i < 4; i++) lineTo(g, [[.3, h - .6 - 9.2*i/4], [w - .3, h - .6 - 9.2*i/4]], INK, .3); }, 24); }
const tapeTex = faceTex('tape', 20, 1.1, (g, w, h) => { rect(g, 0, 0, w, h, CREAM); g.strokeStyle = RED; g.lineWidth = h; g.setLineDash([2.5, 2.5]); g.beginPath(); g.moveTo(0, h/2); g.lineTo(w, h/2); g.stroke(); }, 10);
tapeTex.wrapS = THREE.RepeatWrapping;
function mkNode(n){
  const g = new THREE.Group(), out = { g, cases: [], insides: [], key: '' }, x0 = n.x0, y0 = n.y0, x1 = x0 + SLD, y1 = y0 + SLW;
  out.rise = new THREE.Group(); g.add(out.rise);   // scales up from the ground while the node joins
  out.slab = mkBox(x0, y0, 0, x1, y1, SLH, CONC, { shade: 'tone', receive: true, faces: { top: slabTex(n) } }); out.rise.add(out.slab);
  out.gpus = []; for (let i = 0; i < (n.gpus || 0); i++){ const gy0 = y0 + 8 + i*11, gx0 = x0 + 1;
    const unit = mkBox(gx0, gy0, SLH, gx0 + 4, gy0 + 8, SLH + 5, LOCK, { faces: { px: faceTex('gpuface', 8, 5, (gg, w, h) => { rect(gg, .4, h - 4.6, w - .8, 1, GOLD); txt(gg, 'GPU', w/2, h - 1.2, 1.7, GOLD); }, 16), top: faceTex('gputop', 4, 8, (gg, w, h) => { gg.strokeStyle = 'rgba(35,30,22,.6)'; gg.lineWidth = .3; for (let fy = 1; fy < 8; fy += 1){ gg.beginPath(); gg.moveTo(.5, fy); gg.lineTo(3.5, fy); gg.stroke(); } }, 16) } });
    const led = mkLamp(gx0 + 2, gy0 + 6.6, SLH + 5, LAMPC.green, .6); g.add(unit, led); out.gpus.push(led); }
  // kubelet booth behind the slab's far corner
  const bx0 = x0 - 18, bx1 = x0 - 8, by0 = y1 - 16, by1 = y1 - 4, bz = 12;
  const boothFront = faceTex('booth', 12, 12, (gg, w, h) => { glassPane(gg, 3, h - 9.4, 6, 4.4); txt(gg, 'KUBELET', w/2, h - 11.2, 1.8, '#6b6559'); }, 12);
  const boothDoor = faceTex('bdoor', 10, 12, (gg, w, h) => { rect(gg, 2.5, h - 8.4, 4, 8.4, null, INK, .7); dot(gg, 5.8, h - 4.4, .4, INK); }, 12);
  const booth = mkBox(bx0, by0, 0, bx1, by1, bz, CONC, { shade: 'tone', faces: { px: boothFront, py: boothDoor } }); booth.userData.act = { type: 'booth', node: n.name }; pickables.push(booth);
  out.rise.add(booth); out.cases.push(booth);
  out.roof = mkBox(bx0 - .8, by0 - .8, bz, bx1 + .8, by1 + .8, bz + 1.5, m0(), { shade: 'tone', palKey: 1 }); out.rise.add(out.roof);
  out.mast = new THREE.Group(); out.mast.add(mkRod([bx0 + 3, by1 - 3, bz + 1.5], [bx0 + 3, by1 - 3, bz + 8], .35, METAL)); out.lamp = mkLamp(bx0 + 3, by1 - 3, bz + 8, LAMPC.green, .9); out.mast.add(out.lamp); g.add(out.mast);
  const ins = new THREE.Group();
  ins.add(mkBox(bx0 + 1, by0 + 1, 0, bx0 + 5, by1 - 1, 5, WOOD), mkBox(bx0 + 1.4, by0 + 4, 5, bx0 + 2.2, by1 - 4, 9, DARK, { faces: { px: faceTex('kscreen', 4, 4, (gg, w, h) => rect(gg, .4, .5, w - .8, 3, '#8af0ae'), 16) } }));
  ins.add(mkBox(bx0 + 6, by0 + 1, 0, bx1 - 1, by0 + 5.5, 4.5, METAL), mkCyl(bx0 + 7.5, by0 + 3.2, 4.5, 6.4, 1.2, DARK, { n: 10 }), mkCyl(bx1 - 2.5, by0 + 3.2, 4.5, 6.4, 1.2, DARK, { n: 10 }));
  ins.add(mkBox(bx0 + 6, by1 - 5, 0, bx1 - 1, by1 - 1.2, 8, DARK, { faces: { py: faceTex('patch', 3, 8, (gg, w, h) => [BLUE, LAMPC.green, LAMPC.amber, LAMPC.red].forEach((c, i) => dot(gg, .8 + i*.9, h - 6.4, .3, c)), 24) } }));
  const trunk = [[bx1 - 1, by1 - 3, 2], [bx1 + .4, by1 - 3, 2], [bx1 + .4, by1 - 10, 2], [bx1 + .4, y1 - 10, SLH + .2], [x0 - 2, y1 - 10, SLH + .2]];
  for (let i = 0; i < trunk.length - 1; i++) ins.add(mkRod(trunk[i], trunk[i + 1], .45, matOf(BLUE)));
  g.add(ins); out.insides.push(ins); out.trunks = new THREE.Group(); g.add(out.trunks); out.trunkKey = '';
  // capacity gauge on a post by the slab's near corner
  const gx = x0 - 2.5, gy = y0 + 3; g.add(mkRod([gx, gy, 0], [gx, gy, 16], .7, METAL));
  out.gauge = mkBox(gx - 1.3, gy - 1.5, 5, gx + 1.3, gy + 1.5, 15.5, CERAMIC, { faces: { px: gaugeTex(0, LAMPC.green), py: gaugeTex(0, LAMPC.green) } }); g.add(out.gauge);
  // cordon tape: four posts and four striped tapes, raised with n.tape
  out.tape = new THREE.Group(); const cs = [[x0 + 1.2, y0 + 1.2], [x1 - 1.2, y0 + 1.2], [x1 - 1.2, y1 - 1.2], [x0 + 1.2, y1 - 1.2]]; out.posts = []; out.tapes = [];
  for (const [cx, cy] of cs){ const post = mkRod([cx, cy, SLH], [cx, cy, SLH + 8.8], .55, CERAMIC), stripe = mkRod([cx, cy, SLH + 2], [cx, cy, SLH + 4.5], .62, matOf(RED)); out.tape.add(post, stripe); out.posts.push([post, stripe, cx, cy]); }
  for (let i = 0; i < 4; i++){ const a = cs[i], b = cs[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = tapeTex.clone(); t.repeat.set(L/20, 1); t.needsUpdate = true; const mat = band(CERAMIC, { map: t });
    const tp = new THREE.Mesh(boxGeo(L, 1.1, .3), mat); tp.onBeforeRender = edgeHook; tp.position.copy(V3((a[0] + b[0])/2, (a[1] + b[1])/2, SLH + 8));
    tp.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); out.tape.add(tp); out.tapes.push(tp); }
  const my = (y0 + y1)/2; out.sign = mkBox(x1 - 1.4, my - 7, SLH + 8 - 4.2, x1 - 1, my + 7, SLH + 8 - .3, CERAMIC, { faces: { px: faceTex('cordoned', 14, 3.9, (gg, w, h) => txt(gg, 'CORDONED', w/2, h - 1.6, 2.1, '#b3261e'), 14) } }); out.tape.add(out.sign);
  g.add(out.tape); return out;
}
function syncNodes(){
  const seen = new Set();
  for (const n of st.nodes){ seen.add(n.name); let N = Y.nodes.get(n.name); if (!N){ N = mkNode(n); Y.nodes.set(n.name, N); scene.add(N.g); }
    const j = ease(n.joined); N.g.visible = j > 0; if (j <= 0) continue;
    N.rise.scale.y = Math.max(.03, j); N.mast.visible = j >= 1; N.tape.visible = n.tape > 0; N.gauge.visible = j >= 1; for (const l of N.gpus) l.visible = j >= 1;
    const sk = `${n.name}|${n.gpus}|${[...n.used].filter(k => k.endsWith(',0')).sort().join(';')}`; if (N.key !== sk){ N.key = sk; const mat = N.slab.material[FACE_IDX.top]; mat.uniforms.map.value = slabTex(n); }
    lampColor(N.lamp, n.ready ? (n.cordoned ? LAMPC.amber : LAMPC.green) : LAMPC.red);
    const used = gpuUsed(n); N.gpus.forEach((l, i) => lampColor(l, i < used ? LAMPC.amber : LAMPC.green));
    const cap = ROWS*COLS*3, frac = Math.min(1, n.used.size/cap), gc = frac > .85 ? LAMPC.red : frac > .6 ? LAMPC.amber : LAMPC.green, gt = gaugeTex(frac, gc);
    for (const f of ['px', 'py']) N.gauge.material[FACE_IDX[f]].uniforms.map.value = gt;
    if (n.tape > 0){ const tz = SLH + 8*n.tape; for (const [post, stripe, cx, cy] of N.posts){ rodTo(post, [cx, cy, SLH], [cx, cy, tz + .8], .55); rodTo(stripe, [cx, cy, SLH + 2*n.tape], [cx, cy, SLH + 4.5*n.tape], .62); }
      for (const tp of N.tapes) tp.position.y = tz; N.sign.visible = n.tape > .95; N.sign.position.y = tz - 2.25; setAlpha(N.tape, n.tape); }
    // see-through: the blue trunk from each container's socket to the booth, flat on the slab
    const k = ease(st.xr || 0); const mine = st.pods.filter(p => p.node === n.name && p.pos && p.slot && p.phase !== 'scheduled');
    const tk = k > 0 ? mine.map(p => p.id + ':' + p.pos.map(v => v.toFixed(1)).join(',')).join('|') : '';
    if (tk !== N.trunkKey){ N.trunkKey = tk; dispose(N.trunks); N.trunks = new THREE.Group(); N.g.add(N.trunks);
      for (const p of mine){ const pts = [[p.pos[0] + .5, p.pos[1] + PL - 2.1, SLH + .45], [n.x0 + 2, p.pos[1] + PL - 2.1, SLH + .45], [n.x0 + 2, n.y0 + SLW - 10, SLH + .45], [n.x0 - 2, n.y0 + SLW - 10, SLH + .45]];
        for (let i = 0; i < pts.length - 1; i++) N.trunks.add(mkRod(pts[i], pts[i + 1], .45, matOf(BLUE))); } }
    N.trunks.visible = k > 0; if (k > 0) setAlpha(N.trunks, k);
  }
  for (const [name, N] of Y.nodes) if (!seen.has(name)){ dispose(N.g); Y.nodes.delete(name); }
}
/* pods */
function mkPod(p){
  const g = new THREE.Group(), pm = palOf(p.app), out = { g, key: '', alpha: -1, fire: null, chute: null, pm };
  out.body = mkContainer(0, 0, 0, pm, { app: p.app, ver: p.ver, band: p.band, name: p.name, gpu: p.gpu }); out.body.userData.act = { type: 'pod', id: p.id }; pickables.push(out.body); g.add(out.body);
  out.lamp = mkLamp(PW - 2, PL - 2.6, PH, lampOf(p)); g.add(out.lamp);
  out.inside = mkPodInside(p, 0, 0, 0); out.inside.visible = false; g.add(out.inside);
  if (p.pvc){ out.tank = mkTank(0, 0, 0); g.add(out.tank); }
  return out;
}
function syncPods(){
  const seen = new Set(), k = ease(st.xr || 0);
  for (const p of st.pods){ if (!(p.pos && p.phase !== 'pending' && !(p.sys && !st.showSys))) continue; seen.add(p.id);
    let P = Y.pods.get(p.id); if (!P){ P = mkPod(p); Y.pods.set(p.id, P); scene.add(P.g); }
    P.g.position.copy(V3(...p.pos));
    const bk = `${p.ver}|${p.band ? 1 : 0}|${p.gpu || 0}`; if (P.key !== bk){ P.key = bk; const pm = P.pm; const faces = { px: sideTex(pm, p.app, p.ver, p.band, p.gpu), nx: sideTex(pm, p.app, p.ver, p.band, p.gpu), top: p.band ? bandTopTex(pm) : null };
      for (const [f, t] of Object.entries(faces)){ const mat = P.body.material[FACE_IDX[f]]; if (t){ if (mat === P.body.material[FACE_IDX.bot]) P.body.material[FACE_IDX[f]] = band(pm, { shade: 'tone', map: t }); else mat.uniforms.map.value = t; } else if (f === 'top' && mat !== P.body.material[FACE_IDX.bot]) P.body.material[FACE_IDX.top] = P.body.material[FACE_IDX.bot]; } }
    lampColor(P.lamp, lampOf(p));
    // fire and smoke on a crash; the parachute while a gang member drops
    if (p.fire > 0){ if (!P.fire){ P.fire = mkFire(); P.g.add(P.fire); } setAlpha(P.fire, Math.min(1, p.fire)); } else if (P.fire){ dispose(P.fire); P.fire = null; }
    if (p.drop){ if (!P.chute){ P.chute = mkChute(P.pm); P.g.add(P.chute); } } else if (P.chute){ dispose(P.chute); P.chute = null; }
    // see-through: the case goes to a ghost over its lit insides
    const a = p.alpha; P.inside.visible = k > 0;
    if (P.alpha !== a || P.k !== k){ P.alpha = a; P.k = k;
      setAlpha(P.body, a*(1 - .8*k)); P.body.layers.set(k > 0 ? 1 : 0); P.body.userData.ink = k > 0 ? .6*k*a : a;
      setAlpha(P.lamp, a); if (P.tank) setAlpha(P.tank, a); if (k > 0) setAlpha(P.inside, a*k); }
  }
  for (const [id, P] of Y.pods) if (!seen.has(id)){ dispose(P.g); Y.pods.delete(id); const i = pickables.indexOf(P.body); if (i >= 0) pickables.splice(i, 1); }
}
/* the request beads: a bead with a short trail and a glow */
function syncParcels(){
  while (Y.parcels.length < st.parcels.length){ const g = new THREE.Group(); const bead = new THREE.Mesh(sphGeo(2.2, 12), flat('#ffffff')); bead.onBeforeRender = edgeHook; g.add(bead);
    const glow = new THREE.Mesh(sphGeo(4.2, 10), flat('#ffffff', { opacity: .25, depthWrite: false })); glow.layers.set(3); g.add(glow);
    const trail = [1, 2, 3].map(i => { const s = new THREE.Mesh(sphGeo(1, 8), flat('#ffffff', { opacity: .5 - i*.12, depthWrite: false })); s.scale.setScalar(2.2 - i*.45); s.layers.set(3); g.add(s); return s; });
    scene.add(g); Y.parcels.push({ g, bead, glow, trail }); }
  while (Y.parcels.length > st.parcels.length){ const P = Y.parcels.pop(); dispose(P.g); }
  st.parcels.forEach((pc, i) => { const P = Y.parcels[i], p = parcelAt(pc, pc.t); P.g.position.set(0, 0, 0); P.bead.position.copy(V3(...p)); P.glow.position.copy(V3(...p));
    for (const [m, c] of [[P.bead.material, pc.col], [P.glow.material, pc.col]]) if (m.color.getHexString() !== pc.col.slice(1)) m.color.set(pc.col);
    P.trail.forEach((s, j) => { const q = parcelAt(pc, Math.max(0, Math.min(pc.L, pc.t - pc.dir*(j + 1)*3.2))); s.position.copy(V3(...q)); if (s.material.color.getHexString() !== pc.col.slice(1)) s.material.color.set(pc.col); }); });
}
function syncStatics(){
  const T = Y.tower; lampColor(T.lamp, st.cp.ctrl ? LAMPC.green : st.cp.api ? LAMPC.amber : LAMPC.red); T.etcdDot.visible = !!st.cp.etcd && !st.cp.hold; T.etcdDotOff.visible = !T.etcdDot.visible;
  const at = `api|${st.cp.api}`; if (T.apiKey !== at){ T.apiKey = at; T.api.material[FACE_IDX.px].uniforms.map.value = T.apiTex(); }
  const B = Y.board; const rows = JSON.stringify(boardRows()); if (rows !== B.key){ B.face.material[FACE_IDX.px].uniforms.map.value = boardTex(B); }
  const K = Y.kiosk; const svc = svcMain(), all = st.pods.filter(p => svc && p.app === (svc.selector || {}).app && p.pos && p.phase !== 'terminating').slice(0, 10), pk = all.map(p => isReady(p) ? 'g' : 'a').join('');
  if (pk !== K.key) K.panel.material[FACE_IDX.px].uniforms.map.value = panelTex(K);
  Y.gate.boom.rotation.z = -st.boom*78*Math.PI/180;
  // see-through: tower, booths and kiosk ghost over their insides
  const k = ease(st.xr || 0);
  for (const O of [Y.tower, Y.kiosk, ...Y.nodes.values()]){ if (O.k === k) continue; O.k = k;
    for (const c of O.cases){ setAlpha(c, 1 - .8*k); c.layers.set(k > 0 ? 1 : 0); c.userData.ink = k > 0 ? .6*k : 1; }
    for (const i of O.insides){ i.visible = k > 0; if (k > 0) setAlpha(i, k); } }
}
function syncAll(){ if (staticKey() !== Y.key) rebuildStatic(); syncNodes(); syncPods(); syncRegistry(); syncCrane(); syncStatics(); syncParcels(); }

/* ---------- renderer, camera, framing ---------- */
const canvas = document.getElementById('gl'), zwrap = document.getElementById('zwrap'), ov = document.getElementById('ov');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2400);
const YAW0 = 45, PITCH0 = Math.atan(1/Math.SQRT2)*180/Math.PI;
let YAW = YAW0, PITCH = PITCH0, target = new THREE.Vector3(), frame = { w: 1, h: 1, top: 0, bw: 1, bh: 1 }, zoomK = 1, pan = [0, 0];
const setCam = (y, p) => { YAW = y; PITCH = Math.max(6, Math.min(78, p)); };
const viewDir = (yaw, pitch) => { const t = yaw*Math.PI/180, p = pitch*Math.PI/180; return new THREE.Vector3(Math.cos(p)*Math.cos(t), Math.sin(p), Math.cos(p)*Math.sin(t)); };
function reframe(){   // the whole yard fills ~64% of the width / ~88% of the height of the frame, sitting a little high (shadows fall downward)
  layout(st);
  const b0 = viewDir(YAW0, PITCH0), R = new THREE.Vector3(Math.sin(YAW0*Math.PI/180), 0, -Math.cos(YAW0*Math.PI/180)), U = new THREE.Vector3().crossVectors(b0, R).normalize();
  if (U.y < 0) U.negate();
  target = V3(W/2, D/2, HTOP/2); let xs = [], ys = [];
  for (const x of [0, W]) for (const y of [0, D]) for (const z of [0, HTOP]){ const q = V3(x, y, z).sub(target); xs.push(q.dot(R)); ys.push(q.dot(U)); }
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys), A = PHONE() ? 1.1 : .75;
  const vbW = Math.max(bw/(PHONE() ? .74 : .64), bh/.88/A), vbH = vbW*A;
  // the yard's centre sits a little above the frame's centre (shadows fall downward), and stays in frame at every pitch
  const f = PHONE() ? .44 : .42; frame = { w: vbW, h: vbH, bw, bh, top: (Math.max(...ys) + Math.min(...ys))/2 + f*vbH };
  applyFrame(); placeCamera(); invalidate();
}
window.reframe = reframe;
function applyFrame(){ const w = frame.w/zoomK, h = frame.h/zoomK, cx = pan[0], cy = frame.top - frame.h/2 + pan[1];
  camera.left = cx - w/2; camera.right = cx + w/2; camera.top = cy + h/2; camera.bottom = cy - h/2; camera.updateProjectionMatrix(); }
function placeCamera(){ camera.position.copy(target).add(viewDir(YAW, PITCH).multiplyScalar(1000)); camera.up.set(0, 1, 0); camera.lookAt(target); camera.updateMatrixWorld(); }

/* ---------- the post pass: ink from depth and normals, wobble, grain ---------- */
let colRT, edgeRT, ghostRT, shadowRT, shadowRT2, sizeKey = '';
const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const noiseT = noiseTex(64, true), grainT = noiseTex(256, false), blotT = noiseTex(32, true);
const POST = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending, uniforms: {
  tCol: { value: null }, tN: { value: null }, tD: { value: null }, tN2: { value: null }, tD2: { value: null }, tNoise: { value: noiseT }, tGrain: { value: grainT }, tBlot: { value: blotT },
  res: { value: new THREE.Vector2(1, 1) }, dpr: { value: 1 }, ghost: { value: 0 }, zRange: { value: 1 }, ink: { value: CHANNEL(INK) }, wob: { value: 2.4 }, quality: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `precision highp float; varying vec2 vUv;
  uniform sampler2D tCol, tN, tD, tN2, tD2, tNoise, tGrain, tBlot; uniform vec2 res; uniform float dpr, ghost, zRange, wob, quality; uniform vec3 ink;
  // silhouettes from depth jumps (heavy), creases from normal turns (thin); the weight is the nearer object's ink
  void edges(sampler2D tn, sampler2D td, vec2 uv, float rS, float rC, out float sil, out float cre){
    vec4 n0 = texture2D(tn, uv); float d0 = texture2D(td, uv).r; vec3 nn0 = n0.rgb*2. - 1.; float gz = 1. - abs(nn0.z);
    float thr = (1.6 + 9.0*gz*gz) / zRange; sil = 0.; cre = 0.;
    for (int i = 0; i < 8; i++){ float a = float(i)*0.7854; vec2 o = vec2(cos(a), sin(a));
      vec2 u = uv + o*rS*dpr/res; float di = texture2D(td, u).r; vec4 ni = texture2D(tn, u);
      float w = d0 <= di ? n0.a : ni.a; float dd = abs(d0 - di); sil = max(sil, w*smoothstep(thr*.6, thr*1.4, dd));
      if (i < 4){ vec2 u2 = uv + o*rC*dpr/res; vec4 nj = texture2D(tn, u2); vec3 nnj = nj.rgb*2. - 1.; float dj = texture2D(td, u2).r;
        float same = 1. - smoothstep(thr*.6, thr*1.4, abs(d0 - dj)); cre = max(cre, same*min(n0.a, nj.a)*smoothstep(.22, .5, 1. - dot(nn0, nnj))); } } }
  void main(){
    vec2 asp = vec2(res.x/res.y, 1.);
    vec2 wb = (texture2D(tNoise, vUv*asp*res.y/(dpr*900.)).rg - .5) * wob*dpr/res;
    vec2 uv = vUv + wb;
    vec4 col = texture2D(tCol, uv);
    float sil, cre; edges(tN, tD, uv, 1.15, .75, sil, cre);
    float k = max(sil, cre*.75);
    if (ghost > 0.){ float s2, c2; edges(tN2, tD2, uv, 1.0, .7, s2, c2); k = max(k, max(s2, c2*.6)*ghost); }
    float g1 = texture2D(tGrain, vUv*asp*res.y/(dpr*1.6*256.)).r, g2 = texture2D(tBlot, vUv*asp*res.y/(dpr*2000.)).r;
    float grain = min(1., .84 + .3*g1) * min(1., .85 + .3*g2);
    vec3 rgb = col.rgb*grain*(1. - k) + ink*k; float a = col.a*(1. - k) + k;
    gl_FragColor = vec4(rgb, a);
  }` });
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), POST));
function ensureTargets(){
  const r = zwrap.getBoundingClientRect(), dpr = fastMode ? 1 : DPR(), w = Math.max(2, Math.round(r.width*dpr)), h = Math.max(2, Math.round(r.height*dpr)), key = w + 'x' + h;
  if (key === sizeKey) return; sizeKey = key;
  renderer.setPixelRatio(1); renderer.setSize(w, h, false);
  for (const t of [colRT, edgeRT, ghostRT]) if (t) t.dispose();
  colRT = new THREE.WebGLRenderTarget(w, h, { samples: COARSE ? 2 : 4, depthBuffer: true });
  const mkEdge = () => { const t = new THREE.WebGLRenderTarget(w, h); t.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); t.depthTexture.format = THREE.DepthFormat; return t; };
  edgeRT = mkEdge(); ghostRT = mkEdge();
  if (!shadowRT){ const S = COARSE ? 1024 : 2048; shadowRT = new THREE.WebGLRenderTarget(S, S); shadowRT2 = new THREE.WebGLRenderTarget(S/2, S/2); shared.shadowMap.value = shadowRT.texture; shared.shadowMap2.value = shadowRT2.texture; shared.shadowTexel.value = 1/S; }
  POST.uniforms.res.value.set(w, h); POST.uniforms.dpr.value = dpr; POST.uniforms.zRange.value = camera.far - camera.near;
  POST.uniforms.tCol.value = colRT.texture; POST.uniforms.tN.value = edgeRT.texture; POST.uniforms.tD.value = edgeRT.depthTexture; POST.uniforms.tN2.value = ghostRT.texture; POST.uniforms.tD2.value = ghostRT.depthTexture;
}
// the shadow light: toward the lower left of the screen, turning with the viewer's yaw only (never with the pitch)
function placeShadowCam(){
  const a = 105*Math.PI/180, t = (YAW - YAW0)*Math.PI/180, lx = -.45*Math.cos(a), ly = -.45*Math.sin(a);
  const dir = V3(lx*Math.cos(t) - ly*Math.sin(t), lx*Math.sin(t) + ly*Math.cos(t), 1).normalize();
  const c = V3(W/2, D/2, HTOP/2); shadowCam.position.copy(c).add(dir.clone().multiplyScalar(800)); shadowCam.up.set(0, 1, 0); shadowCam.lookAt(c); shadowCam.updateMatrixWorld();
  const inv = shadowCam.matrixWorldInverse; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const x of [-20, W + 20]) for (const y of [-20, D + 20]) for (const z of [-3, HTOP + 60]){ const q = V3(x, y, z).applyMatrix4(inv); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); z0 = Math.min(z0, -q.z); z1 = Math.max(z1, -q.z); }
  shadowCam.left = x0; shadowCam.right = x1; shadowCam.top = y1; shadowCam.bottom = y0; shadowCam.near = Math.max(1, z0 - 10); shadowCam.far = z1 + 10; shadowCam.updateProjectionMatrix();
  shared.shadowVP.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
}
let fastMode = false;
function render(){
  ensureTargets(); placeCamera(); placeShadowCam();
  const k = ease(st.xr || 0);
  // shadows: everything solid into one map, the crane into a lighter one
  scene.overrideMaterial = DEPTH_MAT;
  shadowCam.layers.set(0); shadowCam.layers.enable(1); renderer.setRenderTarget(shadowRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, shadowCam);
  shadowCam.layers.set(2); renderer.setRenderTarget(shadowRT2); renderer.clear(); renderer.render(scene, shadowCam);
  // normals + ink weight (and depth) of the inked things; the ghost cases apart
  scene.overrideMaterial = EDGE_MAT; renderer.setClearColor(0x000000, 0);
  camera.layers.set(0); camera.layers.enable(2); renderer.setRenderTarget(edgeRT); renderer.clear(); renderer.render(scene, camera);
  if (k > 0){ camera.layers.set(1); renderer.setRenderTarget(ghostRT); renderer.clear(); renderer.render(scene, camera); }
  // colour
  scene.overrideMaterial = null; camera.layers.enableAll(); renderer.setRenderTarget(colRT); renderer.clear(); renderer.render(scene, camera);
  // composite to the page
  POST.uniforms.ghost.value = .6*k; renderer.setRenderTarget(null); renderer.clear(); renderer.render(quadScene, quadCam);
}

/* ---------- one clock: simulation steps, camera moves, drawing on demand ---------- */
// frames follow the screen, with a timer fallback for when they don't come (a hidden tab, headless shots)
const steps = new Set(); let driving = false, lastT = 0, dirty = true, fbT = 0;
const frameFn = () => { if (!driving) return; driving = false; clearTimeout(fbT);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - lastT)/1000)); lastT = now;
  for (const s of [...steps]) if (s(dt) === false) steps.delete(s);
  if (steps.size || dirty){ dirty = false; const t0 = performance.now(); syncAll(); const t1 = performance.now(); render(); const t2 = performance.now(); drawStats(); drawCallouts(); if (window.ControlRoom) ControlRoom.observe(); window.__ft = { sync: t1 - t0, render: t2 - t1, calls: renderer.info.render.calls, geos: renderer.info.memory.geometries, tex: renderer.info.memory.textures, frames: (window.__ft ? window.__ft.frames : 0) + 1 }; }
  if (steps.size) drive(); };
const drive = () => { if (driving) return; driving = true; requestAnimationFrame(frameFn); fbT = setTimeout(frameFn, 60); };
function invalidate(){ dirty = true; drive(); }
ui = { st, render: invalidate, invalidate, animate: step => { if (!steps.size && !driving) lastT = performance.now(); steps.add(step); drive(); },
  flash: (text, ms = 1600) => { const t = document.getElementById('toast'); t.textContent = text[0].toUpperCase() + text.slice(1); t.classList.add('show'); clearTimeout(ui._ft); ui._ft = setTimeout(() => t.classList.remove('show'), ms); } };
window.ui = ui; window.__st = st;
// for the browser checks: where a world point lands on the canvas (CSS px), and a zoom toward it
window.__proj = p => toScreen(p, zwrap.getBoundingClientRect()); window.__zoomTo = (p, k) => { zoomK = 1; pan = [0, 0]; applyFrame(); placeCamera(); const [x, y] = window.__proj(p); zoomAt(k, x, y); };
// the figure's own run() (sim.js) animates through ui.animate; camera moves are steps too
let camAnim = 0;
const camTo = (y, p, ms = 700) => { const y0 = YAW, p0 = PITCH, dy = ((y - y0 + 540) % 360) - 180, id = ++camAnim; let t = 0;
  ui.animate(dt => { if (id !== camAnim) return false; t += dt*1000; const k = Math.min(1, t/ms), e = ease(k); setCam(y0 + dy*e, p0 + (p - p0)*e); return k < 1; }); };

/* ---------- orbit, zoom, picking ---------- */
let drag = null, spin = false; const pts = new Map(); let pinch = null; const vsp = document.getElementById('vspin');
const raycaster = new THREE.Raycaster();
function pick(ev){ const r = zwrap.getBoundingClientRect(); const x = ((ev.clientX - r.left)/r.width)*2 - 1, y = -((ev.clientY - r.top)/r.height)*2 + 1; raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  raycaster.layers.enableAll(); const hits = raycaster.intersectObjects(pickables, false); return hits.length ? hits[0].object.userData.act : null; }
zwrap.addEventListener('pointerdown', e => { if (e.button) return; if (e.target.closest('.zchip')) return;
  if (e.pointerType === 'touch'){ pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2){ pinch = two(); drag = null; return; } }
  camAnim++; drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, yaw: YAW, pitch: PITCH, t: performance.now(), moved: false }; zwrap.classList.add('drag'); try { zwrap.setPointerCapture(e.pointerId); } catch {} });
zwrap.addEventListener('pointermove', e => {
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pts.size === 2){ e.preventDefault(); const n = two(), r = zwrap.getBoundingClientRect(); pan[0] -= (n.x - pinch.x)*frame.w/r.width/zoomK; pan[1] += (n.y - pinch.y)*frame.h/r.height/zoomK; zoomAt(n.d/pinch.d, n.x - r.left, n.y - r.top); pinch = n; return; }
  if (!drag) return; const k = 300/zwrap.getBoundingClientRect().width; if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true;
  if (drag.moved){ setCam(drag.yaw + (e.clientX - drag.x)*.55*k, drag.pitch + (e.clientY - drag.y)*.35*k); fastMode = COARSE; invalidate(); } });
const endDrag = e => { if (pts.has(e.pointerId)) pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
  if (drag && !drag.moved && performance.now() - drag.t < 600){ const a = pick(e); if (a) act(a); }
  drag = null; zwrap.classList.remove('drag'); if (fastMode){ fastMode = false; sizeKey = ''; invalidate(); } };
zwrap.addEventListener('pointerup', endDrag); zwrap.addEventListener('pointercancel', endDrag);
zwrap.addEventListener('dblclick', e => { if (e.target.closest('.zchip')) return; spin = false; vsp.setAttribute('aria-pressed', false); zoomK = 1; pan = [0, 0]; applyFrame(); camTo(YAW0, PITCH0); document.querySelector('.zchip .zp').textContent = '100%'; });
zwrap.addEventListener('pointermove', e => { if (drag || e.pointerType === 'touch') return; zwrap.classList.toggle('pick', !!pick(e)); });
addEventListener('keydown', e => { const k = { ArrowLeft:[-15, 0], ArrowRight:[15, 0], ArrowUp:[0, 8], ArrowDown:[0, -8] }[e.key]; if (!k || /input|textarea/i.test(e.target.tagName)) return; e.preventDefault(); camTo(YAW + k[0], PITCH + k[1], 260); });
const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x)/2, y: (a.y + b.y)/2 }; };
function act(a){ if (a.type === 'pod'){ const p = st.pods.find(p => p.id === a.id); if (p) podInfo(p); } else if (a.type === 'booth'){ const n = st.nodes.find(n => n.name === a.node); if (n) n.cordoned ? uncordon(n) : drain(n); } else { request(); run(); } invalidate(); }
// zoom: ctrl/cmd + wheel (a trackpad pinch arrives the same way), two fingers, the chip; the view zooms toward the cursor
function zoomAt(k, px, py){ const r = zwrap.getBoundingClientRect(), z2 = Math.min(5, Math.max(1, zoomK*k));
  const ux = (px/r.width - .5)*frame.w, uy = (.5 - py/r.height)*frame.h;   // the cursor in frame units from the centre
  pan[0] += ux*(1/zoomK - 1/z2); pan[1] += uy*(1/zoomK - 1/z2); zoomK = z2; clampPan(); applyFrame(); invalidate();
  document.querySelector('.zchip .zp').textContent = Math.round(zoomK*100) + '%'; }
function clampPan(){ if (zoomK <= 1.001){ zoomK = 1; pan = [0, 0]; return; } const mx = frame.w*(1 - 1/zoomK)/2, my = frame.h*(1 - 1/zoomK)/2; pan[0] = Math.max(-mx, Math.min(mx, pan[0])); pan[1] = Math.max(-my, Math.min(my, pan[1])); }
zwrap.addEventListener('wheel', e => { const r = zwrap.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey){ e.preventDefault(); zoomAt(Math.exp(-Math.max(-50, Math.min(50, e.deltaY))*.006), e.clientX - r.left, e.clientY - r.top); }
  else if (zoomK > 1){ e.preventDefault(); pan[0] += e.deltaX*frame.w/r.width/zoomK; pan[1] -= e.deltaY*frame.h/r.height/zoomK; clampPan(); applyFrame(); invalidate(); } }, { passive: false });
document.querySelector('.zchip .zi').onclick = () => { const r = zwrap.getBoundingClientRect(); zoomAt(1.5, r.width/2, r.height/2); };
document.querySelector('.zchip .zm').onclick = () => { const r = zwrap.getBoundingClientRect(); zoomAt(1/1.5, r.width/2, r.height/2); };
document.querySelector('.zchip .zp').onclick = () => { zoomK = 1; pan = [0, 0]; applyFrame(); invalidate(); document.querySelector('.zchip .zp').textContent = '100%'; };

/* ---------- page chrome: buttons, stats, switches, swatches, view ---------- */
const BUTTONS = [
  { label:'Bootstrap', onClick: () => bootstrap() },
  { label:'Apply', choices: st => [
    { label:'cache x2 (new app)', current: !!depOf('cache') && st.mode === 'demo', onClick: () => applyCache() },
    { label:'delete cache', disabled: !depOf('cache'), why:'cache is not deployed', onClick: () => deleteDep('cache') },
    { label:'train x3 (1 GPU each)', current: !!depOf('train') && st.mode === 'demo', onClick: () => applyTrain() },
    { label:'delete train', disabled: !depOf('train'), why:'train is not deployed', onClick: () => deleteDep('train') },
    { label:'spark x4 (gang, Volcano)', current: !!depOf('spark') && st.mode === 'demo', onClick: () => applySpark() },
    { label:'delete spark', disabled: !depOf('spark'), why:'spark is not deployed', onClick: () => deleteDep('spark') },
    { label:'reset the demo', onClick: () => { startDemo(); say('reset', 'Demo cluster reset: web x3, api x2, db x1'); } } ] },
  { label:'Scale web', choices: st => [1, 2, 3, 5, 8].map(n => ({ label:`${n} replica${n === 1 ? '' : 's'}`, current: st.mode === 'demo' && !!depOf('web') && depOf('web').replicas === n, onClick: () => scaleTo('web', n) })) },
  { label:'Roll out', choices: st => { const w = depOf('web'), a = depOf('api'); return [
    { label:'web v2 (rolling)', current: !!w && w.version === 'v2', onClick: () => rollout('web', 'v2') },
    { label:'web back to v1', current: !!w && w.version === 'v1', onClick: () => rollout('web', 'v1') },
    { label:'api v2', current: !!a && a.version === 'v2', onClick: () => rollout('api', 'v2') } ]; } },
  { label:'Break', choices: st => [
    { label:'delete a web pod', onClick: () => deletePod() },
    { label:'delete the db pod', onClick: () => deletePod('db') },
    { label:'crash a container', onClick: () => crashPod() },
    { label:'fail a readiness probe', onClick: () => unreadyPod() },
    { label:'stop an etcd follower', onClick: () => window.ControlRoom && ControlRoom.stopFollower() },
    { label:'stop the etcd leader', onClick: () => window.ControlRoom && ControlRoom.stopLeader() } ] },
  { label:'Drain', choices: st => st.nodes.map(n => ({ label: n.cordoned ? `uncordon ${n.name}` : `drain ${n.name}`, onClick: () => n.cordoned ? uncordon(n) : drain(n) })) },
  { label:'Send a request', onClick: () => { request(); run(); } },
  { label:'Cluster', choices: st => [
    { label:'the demo yard', current: st.mode === 'demo', onClick: () => { startDemo(); say('demo', 'Back to the demo cluster'); } },
    { label:'open a kubectl JSON file', onClick: () => loadFile() },
    { label:'watch localhost:8788', current: st.live.url === 'http://localhost:8788/cluster.json', onClick: () => watchUrl('http://localhost:8788/cluster.json', 5) },
    { label: st.showSys ? 'hide system pods' : 'show system pods', onClick: () => { st.showSys = !st.showSys; for (const p of st.pods) if (p.sys && !st.showSys && p.node){ removeFromNode(p); p.phase = 'pending'; } run(); } } ] } ];
const btns = document.getElementById('btns');
const closeChips = () => document.querySelectorAll('.stepwrap.open').forEach(w => w.classList.remove('open'));
for (const b of BUTTONS){ const wrap = document.createElement('div'); wrap.className = 'stepwrap'; const el = document.createElement('button'); el.className = 'act'; el.innerHTML = `${b.label}${b.choices ? '<span class="car">▾</span>' : ''}`; wrap.appendChild(el); btns.appendChild(wrap);
  if (!b.choices){ el.onclick = () => { closeChips(); b.onClick(st, ui); invalidate(); }; continue; }
  const chips = document.createElement('div'); chips.className = 'chips'; wrap.appendChild(chips);
  el.onclick = e => { e.stopPropagation(); const open = !wrap.classList.contains('open'); closeChips(); if (!open) return; chips.innerHTML = '';
    for (const c of b.choices(st)){ const ch = document.createElement('button'); ch.className = 'chip' + (c.current ? ' current' : c.disabled ? ' off' : ''); ch.textContent = c.label; if (c.current) ch.setAttribute('aria-pressed', 'true');
      ch.onclick = ev => { ev.stopPropagation(); closeChips(); if (c.current) return ui.flash(`${c.label} — already set`); if (c.disabled) return ui.flash(c.why || `${c.label} isn't possible right now`); c.onClick(st, ui); invalidate(); }; chips.appendChild(ch); }
    wrap.classList.add('open'); }; }
document.addEventListener('click', closeChips);
const statsEl = document.getElementById('stats'), prevStats = {};
function drawStats(){ const shown = st.pods.filter(p => !(p.sys && !st.showSys) && p.phase !== 'terminating');
  const list = [ { label:'Pods ready', value:`${shown.filter(isReady).length}/${shown.length}` },
    { label:'Nodes', value: st.nodes.every(n => n.ready) ? String(st.nodes.length) : `${st.nodes.filter(n => n.ready).length}/${st.nodes.length}`, small:true },
    st.nodes.some(n => n.gpus) ? { label:'GPUs', value:`${st.nodes.reduce((a, n) => a + gpuUsed(n), 0)}/${st.nodes.reduce((a, n) => a + (n.gpus || 0), 0)}`, small:true } : null,
    st.mode === 'live' ? { label: st.live.status === 'error' ? 'Live: error' : st.live.status === 'file' ? 'From file' : 'Live', value: st.live.poll ? `${st.live.poll}s` : '', small:true } : null ].filter(Boolean);
  const html = list.map(x => `<div class="stat${x.small ? ' small' : ''}"><div class="k">${x.label}</div><div class="v" data-k="${x.label}">${x.value}</div></div>`).join('');
  if (statsEl._html !== html){ statsEl._html = html; statsEl.innerHTML = html; statsEl.querySelectorAll('.v').forEach(v => { if (prevStats[v.dataset.k] != null && prevStats[v.dataset.k] !== v.textContent) v.classList.add('bump'); prevStats[v.dataset.k] = v.textContent; }); } }
// switches: See-through (the cases fade over ~.7 s), Labels, Control room
const html = document.documentElement, xrb = document.getElementById('xrb'), lblb = document.getElementById('lblb'), roomb = document.getElementById('roomb');
st.xr = 0; st.xrT = 0; if (Q.get('xr') === '1') st.xr = st.xrT = 1;
const syncSw = () => { xrb.setAttribute('aria-pressed', !!st.xrT); lblb.setAttribute('aria-pressed', !html.classList.contains('nolabels')); roomb.setAttribute('aria-pressed', html.classList.contains('room')); };
xrb.onclick = () => { st.xrT = st.xrT ? 0 : 1; syncSw(); ui.animate(dt => { const g = Math.sign(st.xrT - st.xr); st.xr = Math.min(1, Math.max(0, st.xr + g*dt/.7)); return st.xr !== st.xrT; }); };
lblb.onclick = () => { html.classList.toggle('nolabels'); syncSw(); invalidate(); };
roomb.onclick = () => { html.classList.toggle('room'); syncSw(); if (window.ControlRoom) ControlRoom.shown(html.classList.contains('room')); };
if (Q.get('labels') === '1') html.classList.remove('nolabels');
if (Q.get('room') === '1') html.classList.add('room');
syncSw();
// colour swatches recolour the crane, the tower, the roofs, the registry wall and the gate
const palsEl = document.getElementById('pals');
if (PALS[Q.get('pal')]) st.pal = Q.get('pal');
for (const [k, p] of Object.entries(PALS)){ const b = document.createElement('button'); b.className = 'sw'; b.title = k; b.style.background = p.l; b.setAttribute('aria-pressed', k === st.pal);
  b.onclick = () => { st.pal = k; [...palsEl.children].forEach(c => c.setAttribute('aria-pressed', c === b)); html.style.setProperty('--accent', p.l); invalidate(); }; palsEl.appendChild(b); }
html.style.setProperty('--accent', PALS[st.pal].l);
document.getElementById('vreset').onclick = () => { spin = false; vsp.setAttribute('aria-pressed', false); camTo(YAW0, PITCH0); };
vsp.onclick = () => { spin = !spin; vsp.setAttribute('aria-pressed', spin); camAnim++; if (spin) ui.animate(dt => { if (!spin) return false; if (!drag) setCam(YAW + dt*18, PITCH); return true; }); };
if (Q.has('yaw') || Q.has('pitch')) setCam(+(Q.get('yaw') ?? YAW0), +(Q.get('pitch') ?? PITCH0));
// testing: ?press=Label@ms,Label>Choice@ms clicks the buttons after load; unknown labels are recorded on <html data-errors>
const noteErr = m => { html.dataset.errors = (html.dataset.errors || '') + ' ' + m + ';'; };
const starts = (el, t) => el.textContent.trim().toLowerCase().startsWith(t.trim().toLowerCase());
if (Q.has('press')) Q.get('press').split(',').forEach(item => { const [what, ms] = item.split('@'), [label, choice] = what.split('>');
  setTimeout(() => { const b = [...btns.querySelectorAll('.act')].find(b => starts(b, label)); if (!b) return noteErr(`no button "${label}"`); b.click(); if (choice == null) return;
    const c = [...b.parentElement.querySelectorAll('.chip')].find(c => starts(c, choice)); if (c && !c.disabled) c.click(); else noteErr(`no choice "${choice}" in "${label}"`); }, +ms || 0); });

/* ---------- labels: pills in two columns either side of the yard, leaders never crossing; numbered badges on a phone ---------- */
const NS = 'http://www.w3.org/2000/svg';
const lblNum = new Map(); let lblSel = 0;
function calloutItems(){ const k = ease(st.xr || 0), c = st.crane, items = [];
  if (k > .6){ const web = st.pods.find(p => p.pos && p.configMap) || st.pods.find(p => p.pos), sec = st.pods.find(p => p.pos && p.secret), pv = st.pods.find(p => p.pos && p.pvc), n0 = st.nodes[0];
    if (web){ const [x, y, z] = web.pos; items.push({ at:[x + 5, y + 5, z + 6], text:'CONTAINER', on: isReady(web) }, { at:[x + 2, y + PL - 2, z + 2.4], text:'POD NETWORK', on: isReady(web) }, { at:[x + 5, y + .6, z + 6], text:'CONFIGMAP', on:false }); }
    if (sec){ const [x, y, z] = sec.pos; items.push({ at:[x + 9, y + 2.8, z + 1.8], text:'SECRET', on:false }); }
    if (pv){ const [x, y, z] = pv.pos; items.push({ at:[x + 5, y - 3.2, z + 9.4], text:'VOLUME (PV)', on:false }); }
    if (n0 && n0.joined >= 1){ const bx0 = n0.x0 - 18, by1 = n0.y0 + SLW - 4; items.push({ at:[bx0 + 3, by1 - 8, 9], text:'KUBELET', on: st.pods.some(p => p.node === n0.name && p.phase === 'creating') }, { at:[bx0 + 8, by1 - 13, 6], text:'RUNTIME', on:false }, { at:[bx0 + 8, by1 - 3, 7], text:'KUBE-PROXY', on: st.parcels.length > 0 }); }
    items.push({ at:[21, 15, 8], text:'ETCD', on:false }, { at:[26, 17, 19], text:'API SERVER', on: !!c.job || st.pods.some(p => p.phase === 'pending') }, { at:[30, 11, 35], text:'CONTROLLERS', on: st.pods.some(p => p.phase === 'pending' || p.phase === 'terminating') },
      { at:[W - 40, 45, 6], text:'ENDPOINTS', on: st.parcels.length > 0 }, { at:[c.x, c.y, BZ + 2], text:'SCHEDULER', on: !!c.job }); }
  else { const n0 = st.nodes[0], ing = st.ingresses[0], pv = st.pods.find(p => p.pos && p.pvc), p0 = st.pods.find(p => p.pos && p.slot && p.slot.t === 0);
    if (n0 && n0.joined >= 1) items.push({ at:[n0.x0 + SLD - 3, n0.y0 + SLW/2, SLH], text:'NODE', on:false }, { at:[n0.x0 - 13, n0.y0 + SLW - 10, 13.5], text:'KUBELET', on:false }, { at:[n0.x0 - 2.5, n0.y0 + 3, 15.5], text:'CAPACITY', on:false });
    if (p0) items.push({ at:[p0.pos[0] + PW, p0.pos[1] + PL/2, p0.pos[2] + 5], text:'POD', on: isReady(p0) }, { at:[p0.pos[0] + PW - 2, p0.pos[1] + PL - 2.6, p0.pos[2] + PH + 1], text:'READY LAMP', on: isReady(p0) });
    if (pv) items.push({ at:[pv.pos[0] + 5, pv.pos[1] - 3.2, pv.pos[2] + 9.4], text:'VOLUME', on:false });
    const gn = st.nodes.find(n => n.gpus && n.joined >= 1); if (gn) items.push({ at:[gn.x0 + 3, gn.y0 + 12, SLH + 5], text:'GPU', on: gpuUsed(gn) > 0 });
    items.push({ at:[18, 18, 56], text:'CONTROL', on:false }, { at:[38, 56, 24], text:'DEPLOYMENTS', on:false }, { at:[14, REG_Y0 + 16, 22], text:'REGISTRY', on: !!c.job }, { at:[c.x, c.y, BZ + 4.5], text:'SCHEDULER', on: !!c.job },
      { at:[W - 33, 45, 19], text:'SERVICE', on: st.parcels.length > 0 }, { at:[W - 22, 20, 22.5], text: ing ? 'INGRESS' : 'GATE', on: st.boom > .5 }); }
  return items; }
const toScreen = (p, r) => { const v = V3(...p).project(camera); return [(v.x + 1)/2*r.width, (1 - v.y)/2*r.height]; };
let lgdSig = '';
function drawCallouts(){
  if (html.classList.contains('nolabels')){ if (ov.childNodes.length) ov.innerHTML = ''; return; }
  const r = zwrap.getBoundingClientRect(), items = calloutItems(), phone = PHONE();
  const corners = []; for (const x of [0, W]) for (const y of [0, D]) for (const z of [0, HTOP]) corners.push(toScreen([x, y, z], r));
  const xmin = Math.min(...corners.map(p => p[0])), xmax = Math.max(...corners.map(p => p[0])), cx = (xmin + xmax)/2;
  const fs = phone ? 10 : 10, hgt = phone ? 17 : fs*1.8, gap = hgt + 3;
  const wOf = it => phone ? hgt*(lblNum.get(it.text) > 9 ? 1.3 : 1) : it.text.length*fs*.62 + fs*1.5;
  for (const it of items) if (!lblNum.has(it.text)) lblNum.set(it.text, lblNum.size + 1);
  const wMax = Math.max(...items.map(wOf)) + 12, roomL = xmin >= wMax, roomR = r.width - xmax >= wMax;
  const Lc = [], Rc = [];
  for (const it of items){ const [X, Y] = toScreen(it.at, r); ((X < cx && roomL) || !roomR ? Lc : Rc).push({ ...it, X, Y }); }
  // the columns start under the buttons (left) and the stats + switches (right)
  // the columns start under the buttons (left) and the stats + switches (right); a pill level with the buttons moves right of them
  const top = { [-1]: fs, [1]: fs }, keep = { [-1]: null, [1]: null }; if (!phone) for (const [sel, side] of [['#btns', -1], ['#stats', 1], ['.vset', 1]]){ const el = document.querySelector(sel); if (!el) continue; const b = el.getBoundingClientRect(), y = b.bottom - r.top + 10;
    if (y > r.height*.5){ keep[side] = { bottom: y, edge: side < 0 ? b.right - r.left : b.left - r.left }; continue; } if (y > top[side]) top[side] = y + hgt/2; }
  let s = '';
  for (const [col, side] of [[Lc, -1], [Rc, 1]]){ col.sort((a, b) => a.Y - b.Y); let y = -1e9; for (const c of col){ c.py = Math.max(c.Y, y + gap, top[side]); y = c.py; }
    const shift = col.length ? Math.max(0, col.reduce((a, c) => a + c.py - c.Y, 0)/col.length) : 0, room = col.length ? col[0].py - top[side] : 0; for (const c of col) c.py -= Math.min(shift, room);
    for (const c of col){ const n = lblNum.get(c.text), w = wOf(c); let px = side < 0 ? xmin - 10 - w/2 : xmax + 10 + w/2; px = Math.max(w/2 + 2, Math.min(r.width - w/2 - 2, px));
      const kp = keep[side]; if (kp && c.py < kp.bottom) px = side < 0 ? Math.max(px, kp.edge + 8 + w/2) : Math.min(px, kp.edge - 8 - w/2);
      const ex = px - side*w/2;
      s += `<g class="tag${c.on ? ' on' : ''}${lblSel === n ? ' sel' : ''}" data-n="${n}" data-t="${c.text}"><path d="M${c.X.toFixed(1)} ${c.Y.toFixed(1)}L${(ex - side*4).toFixed(1)} ${c.py.toFixed(1)}L${ex.toFixed(1)} ${c.py.toFixed(1)}" fill="none" stroke="${INK}" stroke-width="${lblSel === n ? 2.4 : 1}"/>`
        + `<circle cx="${c.X.toFixed(1)}" cy="${c.Y.toFixed(1)}" r="1.4" fill="${INK}"/><rect x="${(px - w/2).toFixed(1)}" y="${(c.py - hgt/2).toFixed(1)}" width="${w.toFixed(1)}" height="${hgt}" rx="${hgt/2}" stroke="${INK}" stroke-width="1.2"${lblSel === n ? ` style="fill:${INK}"` : ''}/>`
        + `<text x="${px.toFixed(1)}" y="${(c.py + fs*.36).toFixed(1)}" text-anchor="middle"${lblSel === n ? ' style="fill:#fff4d6"' : ''}>${phone ? n : c.text}</text></g>`; } }
  ov.innerHTML = s;
  // the legend under the figure on a phone
  const lg = document.getElementById('lgd'); const sig = phone ? JSON.stringify(items.map(it => [lblNum.get(it.text), it.text, it.on])) + lblSel : '';
  if (sig !== lgdSig){ lgdSig = sig; lg.classList.toggle('has', phone && items.length > 0);
    lg.innerHTML = phone ? items.map(it => { const n = lblNum.get(it.text); return `<button data-n="${n}" class="${it.on ? 'on' : ''}${lblSel === n ? ' sel' : ''}"><b>${n}</b><span>${it.text}</span></button>`; }).join('') : ''; }
}
document.getElementById('lgd').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; lblSel = lblSel === +b.dataset.n ? 0 : +b.dataset.n; invalidate(); });

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
startDemo(); params(Q); reframe();
if (Q.has('cluster')) watchUrl(Q.get('cluster'), +(Q.get('poll') || 0));
else if (Q.has('web') || Q.get('v2') === '1' || Q.get('cache') === '1' || Q.get('train') === '1' || Q.get('spark') === '1') run();
if (window.ControlRoom) ControlRoom.mount(document.getElementById('room'), { st, ui, speed: () => SPEED, run, say });
addEventListener('resize', () => { sizeKey = ''; reframe(); });
new ResizeObserver(() => { sizeKey = ''; invalidate(); }).observe(zwrap);
invalidate();
