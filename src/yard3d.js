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
const COARSE = matchMedia('(pointer:coarse)').matches;
const DPR = () => Math.min(devicePixelRatio || 1, 2);
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
// every surface shader writes two targets at once: the colour, and the normal with the object's ink weight for the edge pass
const GBUF = `\nlayout(location = 0) out highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\nlayout(location = 1) out vec4 gNormal; uniform float inkW;\n`;
const BAND_FS = `#include <packing>
varying vec3 vN; varying vec3 vW; varying vec2 vUv; ${GBUF}
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
  gl_FragColor = vec4(c, opacity); gNormal = vec4(n*.5 + .5, inkW);
}`;
function band(pal, o = {}){
  const t = o.shade === 'tone' ? TONE : TONE_I;
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BAND_VS, fragmentShader: BAND_FS, uniforms: { inkW: { value: 1 },
    cl: { value: CHANNEL(pal.l) }, cm: { value: CHANNEL(pal.m) }, cd: { value: CHANNEL(pal.d) }, lightDir: { value: o.shade === 'tone' ? SUN : LIN },
    hi: { value: t.hi }, lo: { value: t.lo }, opacity: { value: o.opacity == null ? 1 : o.opacity }, receive: { value: o.receive ? 1 : 0 },
    hasMap: { value: o.map ? 1 : 0 }, map: { value: o.map || null }, ...shared } });
  m.transparent = m.uniforms.opacity.value < 1; m.depthWrite = !m.transparent; m.userData.pal = pal; m.userData.palKey = o.palKey || null;
  return m;
}
const setPal = (m, pal) => { m.uniforms.cl.value.set(pal.l); m.uniforms.cm.value.set(pal.m); m.uniforms.cd.value.set(pal.d); m.userData.pal = pal; };
function setAlpha(mesh, a){   // a mesh (or group): every band / flat material gets opacity a, the ink pass is told too
  mesh.traverse(ob => { if (!ob.isMesh) return; ob.userData.ink = a; for (const m of (Array.isArray(ob.material) ? ob.material : [ob.material])){
    if (!m.uniforms || !m.uniforms.opacity) continue; const op = a * (m.userData.baseA == null ? 1 : m.userData.baseA);
    m.uniforms.opacity.value = op; m.transparent = op < 1; m.depthWrite = !m.userData.noDepth && op > .02; } });
}
// a see-through case: drawn as a ghost (no depth, no ink of its own); its edges come from the second edge pass at a lighter weight
function ghost(mesh, on){ mesh.layers.set(on ? 1 : 0); for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) m.depthWrite = !on && m.uniforms.opacity.value > .02; }
// flat (unshaded) colour: lamps, flames, beads, paint that must not take the tones
const FLAT_FS = `varying vec3 vN; varying vec2 vUv; ${GBUF} uniform vec3 color; uniform float opacity, hasMap; uniform sampler2D map;
void main(){ vec4 c = vec4(color, opacity); if (hasMap > 0.) c *= texture2D(map, vUv); vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; gl_FragColor = c; gNormal = vec4(n*.5 + .5, inkW); }`;
const flat = (hex, o = {}) => { const op = o.opacity == null ? 1 : o.opacity;
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BAND_VS, fragmentShader: FLAT_FS, uniforms: { inkW: { value: 1 }, color: { value: CHANNEL(hex) }, opacity: { value: op }, hasMap: { value: o.map ? 1 : 0 }, map: { value: o.map || null } },
    transparent: op < 1, depthWrite: o.depthWrite !== false, side: o.side || THREE.FrontSide });
  Object.defineProperty(m, 'color', { get: () => m.uniforms.color.value });
  if (o.opacity != null) m.userData.baseA = o.opacity; if (o.depthWrite === false) m.userData.noDepth = true; return m; };
// the ink pass sees normals (rgb) and an ink weight (a) per object; a fading pod fades its lines with it
const EDGE_MAT = new THREE.ShaderMaterial({ uniforms: { inkW: { value: 1 } }, vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `varying vec3 vN; uniform float inkW; void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; gl_FragColor = vec4(n * .5 + .5, inkW); }` });
const edgeHook = function(r, s, c, g, material){ const u = material.uniforms; if (!u || !u.inkW) return; const ink = this.userData.ink == null ? 1 : this.userData.ink;
  u.inkW.value = material === EDGE_MAT || !(this.layers.mask & 10) ? ink : 0; material.uniformsNeedUpdate = true; };
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
    const f2 = new THREE.Mesh(cylGeo(0, 1.2, h*.6, 7), flat('#ffd23c', { depthWrite: false })); f2.position.copy(V3(PW/2 + .6, PL/2 + dy, PH + h*.3)); f2.layers.set(3); g.add(f2); }
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
  const base = mkBox(6, 6, 0, 30, 30, 30, m, { shade: 'tone', faces: { px: baseTex, py: baseSide }, palKey: 1 }); base.userData.act = { type: 'tower' }; pickables.push(base); g.add(base); out.cases.push(base);
  const ins = new THREE.Group();
  const etcdTex = faceTex('etcd', 12, 12, (gg, w, h) => { for (const z of [3, 6.5, 10]) lineTo(gg, [[1.5, h - z], [w - 1.5, h - z]], INK, .5); txt(gg, 'etcd', w/2, h - 1.9, 1.9, PAPER, 800); }, 12);
  ins.add(mkBox(9, 9, 0, 21, 21, 12, LOCK, { faces: { px: etcdTex } }));
  ins.add(mkBox(7, 7, 14, 29, 29, 15, CONC));
  out.apiTex = () => faceTex(`api|${st.cp.api}`, 10, 7, (gg, w, h) => { for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) dot(gg, w - 1.5 - i*1.4, h - 2.5 - j*2, .45, !st.cp.api ? '#6b6560' : (i + j) % 3 ? LAMPC.green : LAMPC.amber); txt(gg, 'API', w/2, h - 1.6, 1.9, '#5a4a2a', 800); }, 14);
  out.api = mkBox(8, 12, 15, 26, 22, 22, CERAMIC, { faces: { px: out.apiTex() } }); ins.add(out.api);
  ins.add(mkBox(7, 7, 29, 29, 29, 30, CONC));
  // the cab: glass on all four sides with mullions and a streak
  const glassTex = (w, h, key) => faceTex(`cab|${key}|${m.l}`, w, h, (gg, ww, hh) => { glassPane(gg, 1, 2, ww - 2, 7); for (const u of [11, 18, 25]) lineTo(gg, [[u - 3, 2], [u - 3, 9]], INK, .6); }, 8);
  const cab = mkBox(3, 3, 30, 33, 33, 42, m, { shade: 'tone', faces: { px: glassTex(30, 12, 'px'), nx: glassTex(30, 12, 'nx'), py: glassTex(30, 12, 'py'), ny: glassTex(30, 12, 'ny') }, palKey: 1 }); cab.userData.act = { type: 'tower' }; pickables.push(cab); g.add(cab); out.cases.push(cab);
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
  out.face = mkBox(36, Y0, 6, 38, Y1, 26, CERAMIC, { faces: { px: boardTex(out) } }); out.face.userData.act = { type: 'board' }; pickables.push(out.face); g.add(out.face); return out;
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
  const wall = mkBox(4, REG_Y0, 0, 6, y1, 18, m, { shade: 'tone', faces: { px: faceTex(`reg|${m.l}`, y1 - REG_Y0, 18, (gg, w, h) => txt(gg, 'IMAGE REGISTRY', w/2, h - 12, 4.6, mix(m.d, '#000000', .2)), 8) }, palKey: 1 }); wall.userData.act = { type: 'registry' }; pickables.push(wall); g.add(wall);
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
  const girder = mkBox(XB0, -2.2, BZ, XR1 + 2.5, 2.2, BZ + 4.5, m, { shade: 'tone', palKey: 1, faces: { py: truss, ny: trussR, px: faceTex(`sched|${m.l}`, 4.4, 4.5, (gg, w, h) => txt(gg, 'SCHED', w/2, h - 3.2, 1.6, mix(m.d, '#000000', .2)), 20) } }); girder.userData.act = { type: 'crane' }; pickables.push(girder); g.add(girder);
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
  out.slab = mkBox(x0, y0, 0, x1, y1, SLH, CONC, { shade: 'tone', receive: true, faces: { top: slabTex(n) } }); out.slab.userData.act = { type: 'node', node: n.name }; pickables.push(out.slab); out.rise.add(out.slab);
  out.gpus = []; for (let i = 0; i < (n.gpus || 0); i++){ const gy0 = y0 + 8 + i*11, gx0 = x0 + 1;
    const unit = mkBox(gx0, gy0, SLH, gx0 + 4, gy0 + 8, SLH + 5, LOCK, { faces: { px: faceTex('gpuface', 8, 5, (gg, w, h) => { rect(gg, .4, h - 4.6, w - .8, 1, GOLD); txt(gg, 'GPU', w/2, h - 1.2, 1.7, GOLD); }, 16), top: faceTex('gputop', 4, 8, (gg, w, h) => { gg.strokeStyle = 'rgba(35,30,22,.6)'; gg.lineWidth = .3; for (let fy = 1; fy < 8; fy += 1){ gg.beginPath(); gg.moveTo(.5, fy); gg.lineTo(3.5, fy); gg.stroke(); } }, 16) } });
    const led = mkLamp(gx0 + 2, gy0 + 6.6, SLH + 5, LAMPC.green, .6); g.add(unit, led); out.gpus.push(led); }
  // kubelet booth behind the slab's far corner
  const bx0 = x0 - 18, bx1 = x0 - 8, by0 = y1 - 16, by1 = y1 - 4, bz = 12;
  const boothFront = faceTex('booth', 12, 12, (gg, w, h) => { glassPane(gg, 3, h - 9.4, 6, 4.4); txt(gg, 'KUBELET', w/2, h - 11.2, 1.8, '#6b6559'); }, 12);
  const boothDoor = faceTex('bdoor', 10, 12, (gg, w, h) => { rect(gg, 2.5, h - 8.4, 4, 8.4, null, INK, .7); dot(gg, 5.8, h - 4.4, .4, INK); }, 12);
  const booth = mkBox(bx0, by0, 0, bx1, by1, bz, CONC, { shade: 'tone', faces: { px: boothFront, py: boothDoor } }); booth.userData.act = { type: 'node', node: n.name }; pickables.push(booth);
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
  for (const [name, N] of Y.nodes) if (!seen.has(name)){ dispose(N.g); Y.nodes.delete(name); N.g.traverse(o => { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); }); }
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
      setAlpha(P.body, a*(1 - .8*k)); ghost(P.body, k > 0); P.body.userData.ink = k > 0 ? .6*k*a : a;
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
    for (const c of O.cases){ setAlpha(c, 1 - .8*k); ghost(c, k > 0); c.userData.ink = k > 0 ? .6*k : 1; }
    for (const i of O.insides){ i.visible = k > 0; if (k > 0) setAlpha(i, k); } }
}
function syncAll(){ if (staticKey() !== Y.key) rebuildStatic(); syncNodes(); syncPods(); syncRegistry(); syncCrane(); syncStatics(); syncParcels(); }
/* ---------- renderer, camera, framing ----------
   The camera is a map: a focus point (what sits at the centre of the screen), a yaw and a pitch around it, and a
   zoom (1 = the whole yard framed). Every move is a flight to a new one of those, eased out exponentially. */
const html = document.documentElement;
const canvas = document.getElementById('gl'), zwrap = document.getElementById('zwrap'), ov = document.getElementById('ov'), lblEl = document.getElementById('lbls');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2400);
const YAW0 = 45, PITCH0 = Math.atan(1/Math.SQRT2)*180/Math.PI, ZMIN = .6, ZMAX = 8;
const cam = { yaw: YAW0, pitch: PITCH0, focus: new THREE.Vector3(), zoom: 1, custom: false };
let frame = { w: 1, h: 1, ymid: 0 }, box = { w: 1, h: 1, left: 0, top: 0 };   // frame: world units across the view at zoom 1; box: the canvas in css px
const YARD_MODE = () => html.classList.contains('yard');
const clampP = p => Math.max(6, Math.min(78, p));
const viewDir = (yaw, pitch) => { const t = yaw*Math.PI/180, p = pitch*Math.PI/180; return new THREE.Vector3(Math.cos(p)*Math.cos(t), Math.sin(p), Math.cos(p)*Math.sin(t)); };
// the screen's right and up directions in world (three) space for a view
const basis = (yaw, pitch) => { const d = viewDir(yaw, pitch), R = new THREE.Vector3(Math.sin(yaw*Math.PI/180), 0, -Math.cos(yaw*Math.PI/180)), U = new THREE.Vector3().crossVectors(d, R).normalize(); return { d, R, U }; };
const measure = () => { const r = zwrap.getBoundingClientRect(); box = { w: Math.max(1, r.width), h: Math.max(1, r.height), left: r.left, top: r.top }; };
function reframe(){   // zoom 1 frames the whole yard as seen from the front view, at any yaw after that
  layout(st); measure();
  const { R, U } = basis(YAW0, PITCH0), c = V3(W/2, D/2, HTOP/2), xs = [], ys = [];
  for (const x of [0, W]) for (const y of [0, D]) for (const z of [0, HTOP]){ const q = V3(x, y, z).sub(c); xs.push(q.dot(R)); ys.push(q.dot(U)); }
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys), A = box.h/box.w, yard = YARD_MODE(), phone = box.w < 560;
  const fw = yard ? .9 : phone ? .74 : .64, fh = yard ? .6 : .88;
  const vbW = Math.max(bw/fw, bh/fh/A); frame = { w: vbW, h: vbW*A, ymid: (Math.max(...ys) + Math.min(...ys))/2 };
  if (!cam.custom) cam.focus.copy(overviewFocus());
  applyFrame(); camMoved = false; invalidate();
}
window.reframe = reframe;
// the whole yard, a little above the middle of the frame (shadows fall downward); only ever offset straight up, so orbiting keeps it centred
function overviewFocus(){ const f = YARD_MODE() ? .5 : box.w < 560 ? .44 : .42; return V3(W/2, D/2, HTOP/2).add(new THREE.Vector3(0, (frame.ymid + (f - .5)*frame.h)/Math.cos(PITCH0*Math.PI/180), 0)); }
let camMoved = false, restT = 0;
function applyFrame(){ camMoved = true; placeCam(); }
function placeCam(){ const w = frame.w/cam.zoom, h = frame.h/cam.zoom;
  cam.focus.x = Math.max(-40, Math.min(W + 40, cam.focus.x)); cam.focus.z = Math.max(-40, Math.min(D + 40, cam.focus.z)); cam.focus.y = Math.max(-90, Math.min(HTOP + 90, cam.focus.y));
  camera.left = -w/2; camera.right = w/2; camera.top = h/2; camera.bottom = -h/2; camera.updateProjectionMatrix();
  camera.position.copy(cam.focus).add(viewDir(cam.yaw, cam.pitch).multiplyScalar(1000)); camera.up.set(0, 1, 0); camera.lookAt(cam.focus); camera.updateMatrixWorld(); }
const toScreen = p => { const v = V3(...p).project(camera); return [(v.x + 1)/2*box.w, (1 - v.y)/2*box.h, v.z]; };
const ppu = () => box.w/(frame.w/cam.zoom);                      // screen pixels per world unit
const zoomFor = px => Math.min(ZMAX, Math.max(ZMIN, px*frame.w/box.w));
const touched = () => { cam.custom = true; applyFrame(); invalidate(); saveCam(); };
// zoom toward a screen point (the thing under the finger stays put), and pan by a screen offset
function zoomAt(k, px, py, ms){ const z2 = Math.min(ZMAX, Math.max(ZMIN, cam.zoom*k)); k = z2/cam.zoom; if (Math.abs(k - 1) < 1e-4) return;
  const { R, U } = basis(cam.yaw, cam.pitch), w = frame.w/cam.zoom, h = frame.h/cam.zoom, u = (px/box.w - .5)*w, v = (.5 - py/box.h)*h;
  const f = cam.focus.clone().addScaledVector(R, u*(1 - 1/k)).addScaledVector(U, v*(1 - 1/k));
  if (ms){ cam.custom = true; flyTo({ focus: f, zoom: z2 }, ms); } else { cam.focus.copy(f); cam.zoom = z2; touched(); } }
function panBy(dx, dy){ const { R, U } = basis(cam.yaw, cam.pitch), w = frame.w/cam.zoom, h = frame.h/cam.zoom; cam.focus.addScaledVector(R, -dx*w/box.w).addScaledVector(U, dy*h/box.h); touched(); }
// flights: every camera move is one of these, expo-out, short
let camAnim = 0; const eo = t => t >= 1 ? 1 : 1 - Math.pow(2, -10*t);
function flyTo(to, ms = 500, done){ const id = ++camAnim, y0 = cam.yaw, p0 = cam.pitch, f0 = cam.focus.clone(), z0 = cam.zoom;
  const y1 = to.yaw == null ? y0 : y0 + (((to.yaw - y0 + 540) % 360) - 180), p1 = to.pitch == null ? p0 : clampP(to.pitch), f1 = to.focus ? to.focus.clone() : f0, z1 = Math.min(ZMAX, Math.max(ZMIN, to.zoom == null ? z0 : to.zoom)); let t = 0;
  const end = () => { cam.yaw = ((y1 % 360) + 360) % 360; cam.pitch = p1; cam.focus.copy(f1); cam.zoom = z1; applyFrame(); invalidate(); saveCam(); if (done) done(); };
  if (ms <= 0) return end();
  ui.animate(dt => { if (id !== camAnim) return false; t += dt*1000; if (t >= ms){ end(); return false; } const e = eo(t/ms);
    cam.yaw = y0 + (y1 - y0)*e; cam.pitch = p0 + (p1 - p0)*e; cam.focus.lerpVectors(f0, f1, e); cam.zoom = z0*Math.pow(z1/z0, e); applyFrame(); invalidate(); return true; }); }
// frame a world box [[x0,y0,z0],[x1,y1,z1]]: it fills `fill` of the view, centred in the part of the screen a card leaves free
function frameBox(b, o = {}){ const yaw = o.yaw == null ? cam.yaw : o.yaw, pitch = o.pitch == null ? cam.pitch : o.pitch, { R, U } = basis(yaw, pitch);
  const c = V3((b[0][0] + b[1][0])/2, (b[0][1] + b[1][1])/2, (b[0][2] + b[1][2])/2), xs = [], ys = [];
  for (const x of [b[0][0], b[1][0]]) for (const y of [b[0][1], b[1][1]]) for (const z of [b[0][2], b[1][2]]){ const q = V3(x, y, z).sub(c); xs.push(q.dot(R)); ys.push(q.dot(U)); }
  const bw = Math.max(1, Math.max(...xs) - Math.min(...xs)), bh = Math.max(1, Math.max(...ys) - Math.min(...ys)), fill = o.fill || .4, below = o.below || 0;
  const zoom = Math.min(o.maxZoom || ZMAX, Math.max(ZMIN, Math.min(frame.w*fill/bw, frame.h*(1 - below)*fill/bh)));
  const focus = c.addScaledVector(U, (Math.max(...ys) + Math.min(...ys))/2 - below/2*frame.h/zoom);
  cam.custom = true; flyTo({ yaw, pitch, focus, zoom }, o.ms == null ? 500 : o.ms, o.done); }
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
// where things are, and the view that shows them best (a face to read turns the camera toward it; a box keeps the viewer's yaw)
function bboxOf(a){ const p = a.type === 'pod' && st.pods.find(p => p.id === a.id), n = a.type === 'node' && st.nodes.find(n => n.name === a.node);
  if (p && p.pos) return [[p.pos[0], p.pos[1] - (p.pvc ? 6 : 0), p.pos[2]], [p.pos[0] + PW, p.pos[1] + PL, p.pos[2] + PH]];
  if (n) return [[n.x0 - 18, n.y0, 0], [n.x0 + SLD, n.y0 + SLW, 20]];
  if (a.type === 'tower') return [[2, 2, 0], [34, 34, 58]];
  if (a.type === 'board') return [[36, 40, 0], [38, 72, 26]];
  if (a.type === 'registry') return [[4, REG_Y0, 0], [28, REG_Y0 + REG_MAX*REG_GAP, 24]];
  if (a.type === 'kiosk') return [[W - 42, 36, 0], [W - 30, 54, 20]];
  if (a.type === 'gate') return [[W - 37, 17, 0], [W - 5, 22.5, 22.5]];
  if (a.type === 'crane'){ const c = st.crane; return [[c.x - 8, c.y - 14, c.z - 2], [c.x + 8, c.y + 14, BZ + 6]]; }
  if (a.type === 'app'){ const ps = st.pods.filter(p => p.app === a.app && p.pos); if (!ps.length) return null; const b = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
    for (const p of ps) for (let i = 0; i < 3; i++){ b[0][i] = Math.min(b[0][i], p.pos[i]); b[1][i] = Math.max(b[1][i], p.pos[i] + [PW, PL, PH][i]); } return b; }
  return null; }
function frameAct(a, o = {}){ const b = bboxOf(a); if (!b) return; const view = {};
  const face = { board: [12, 45], kiosk: [30, 60], gate: [75, 60], registry: [20, 50] }[a.type];   // [best yaw, tolerance]
  if (face && Math.abs(angDiff(cam.yaw, face[0])) > face[1]) view.yaw = face[0];
  view.pitch = a.type === 'app' ? Math.max(28, Math.min(55, cam.pitch)) : a.type === 'node' ? Math.max(30, Math.min(60, cam.pitch)) : Math.max(16, Math.min(44, cam.pitch));
  const fill = o.fill || (a.type === 'pod' ? .36 : a.type === 'app' ? .5 : .42), maxZoom = a.type === 'pod' ? zoomFor(7) : a.type === 'app' || a.type === 'node' ? zoomFor(4.5) : zoomFor(5);
  frameBox(b, { ...view, fill, maxZoom, below: o.below || 0, ms: o.ms, done: o.done }); }
function overview(ms = 500){ cam.custom = false; flyTo({ focus: overviewFocus(), zoom: 1 }, ms, () => { cam.custom = false; saveCam(); }); }
function front(){ spinOff(); flyTo({ yaw: YAW0, pitch: PITCH0 }, 600); }

/* follow: the camera tracks whatever the operation is doing: the crane's load, a landing gang, the request bead, a crashing pod */
const follow = { on: false };
function followTarget(){ const c = st.crane, mid = p => [p.pos[0] + PW/2, p.pos[1] + PL/2, p.pos[2] + PH/2];
  if (c.carry && c.carry.pos) return { p: mid(c.carry), z: zoomFor(3.6) };
  const dr = st.pods.find(p => p.drop && p.pos); if (dr) return { p: mid(dr), z: zoomFor(2.2) };
  if (st.parcels.length){ const pc = st.parcels[0]; return { p: parcelAt(pc, pc.t), z: zoomFor(4) }; }
  const cr = st.pods.find(p => (p.fire > 0 || p.phase === 'crash') && p.pos); if (cr) return { p: mid(cr), z: zoomFor(4) };
  if (c.job) return { p: [c.x, c.y, c.z + PH/2], z: zoomFor(3.2) };
  const cr2 = st.pods.find(p => p.phase === 'creating' && p.pos); if (cr2) return { p: mid(cr2), z: zoomFor(4) };
  const un = st.pods.find(p => p.phase === 'unready' && p.phaseT > -1e8 && p.pos); if (un) return { p: mid(un), z: zoomFor(3.6) };
  const bt = st.nodes.find(n => n.joined > 0 && n.joined < 1); if (bt) return { p: [bt.x0 + SLD/2 - 8, bt.y0 + SLW/2, 8], z: zoomFor(2.2) };
  return null; }
function followTick(dt){ const t = followTarget(); if (!t) return; const k = 1 - Math.exp(-dt*6); cam.focus.lerp(V3(...t.p), k); cam.zoom += (t.z - cam.zoom)*k*.7; cam.custom = true; applyFrame(); dirty = true; }
function setFollow(on){ follow.on = !!on; if (on) camAnim++; Chrome.syncSw(); if (on) invalidate(); }
// the camera is remembered for this tab, so the guide's figures do not snap back to the front view
const CAMKEY = 'longshore.cam'; let saveT = 0;
function saveCam(){ clearTimeout(saveT); saveT = setTimeout(() => { try { sessionStorage.setItem(CAMKEY, JSON.stringify({ yaw: cam.yaw, pitch: cam.pitch, f: cam.focus.toArray(), zoom: cam.zoom, custom: cam.custom, W, D, yard: YARD_MODE() })); } catch {} }, 300); }
function loadCam(){ try { const s = JSON.parse(sessionStorage.getItem(CAMKEY)); if (!s || s.W !== W || s.D !== D) return false; cam.yaw = s.yaw; cam.pitch = s.pitch;
  if (s.custom && s.yard === YARD_MODE()){ cam.custom = true; cam.focus.fromArray(s.f); cam.zoom = s.zoom; } applyFrame(); camMoved = false; return true; } catch { return false; } }

/* ---------- the post pass: ink from depth and normals, wobble, grain ---------- */
let shadowRT, shadowRT2, sizeKey = '';
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
    float thr = (1.6 + 9.0*gz*gz) / zRange; sil = 0.; cre = 0.; int n = quality > .5 ? 8 : 4;
    for (int i = 0; i < 8; i++){ if (i >= n) break; float a = float(i)*6.2832/float(n); vec2 o = vec2(cos(a), sin(a));
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
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), POST); quadScene.add(quad);
const BLIT = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending, uniforms: { t: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`, fragmentShader: `varying vec2 vUv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, vUv); }` });
/* two sets of targets: the full-size multisampled one for a frame at rest, and a smaller one for frames while the camera
   moves (the same ink, computed on fewer pixels and stretched back with linear filtering, so the lines never drop out).
   The motion scale follows the frame interval: a phone that drops frames gets a smaller buffer, a fast one a sharper view. */
const RT = { full: null, motion: null, motionScale: 0 };
const perf = { scale: COARSE ? .7 : .85, lo: .6, hi: COARSE ? .8 : 1, lastT: 0, slow: 0, fast: 0 };
function perfTick(now){ if (perf.lastT){ const dt = now - perf.lastT;
    if (dt > 21){ perf.slow++; perf.fast = 0; } else if (dt < 13){ perf.fast++; perf.slow = Math.max(0, perf.slow - 1); }
    if (perf.slow >= 4){ perf.scale = Math.max(perf.lo, +(perf.scale - .05).toFixed(2)); perf.slow = 0; perf.fast = 0; }
    else if (perf.fast >= 40){ perf.scale = Math.min(perf.hi, +(perf.scale + .05).toFixed(2)); perf.fast = 0; } }
  perf.lastT = now; }
function mkSet(w, h, samples){
  const rt = new THREE.WebGLRenderTarget(w, h, { count: 2, samples, depthBuffer: true }); rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); rt.depthTexture.format = THREE.DepthFormat;
  const ghost = new THREE.WebGLRenderTarget(w, h); ghost.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); ghost.depthTexture.format = THREE.DepthFormat;
  return { rt, ghost, ink: samples ? null : new THREE.WebGLRenderTarget(w, h), w, h }; }
const disposeSet = S => { if (!S) return; S.rt.dispose(); S.ghost.dispose(); if (S.ink) S.ink.dispose(); };
function ensureTargets(moving){
  const dpr = DPR(), w = Math.max(2, Math.round(box.w*dpr)), h = Math.max(2, Math.round(box.h*dpr)), key = w + 'x' + h;
  if (key !== sizeKey){ sizeKey = key; renderer.setPixelRatio(1); renderer.setSize(w, h, false); disposeSet(RT.full); RT.full = mkSet(w, h, COARSE ? 2 : 4); disposeSet(RT.motion); RT.motion = null; }
  if (moving && (!RT.motion || RT.motionScale !== perf.scale)){ disposeSet(RT.motion); RT.motion = mkSet(Math.max(2, Math.round(w*perf.scale)), Math.max(2, Math.round(h*perf.scale)), 0); RT.motionScale = perf.scale; }
  if (!shadowRT){ const S = COARSE ? 1024 : 2048; shadowRT = new THREE.WebGLRenderTarget(S, S); shadowRT2 = new THREE.WebGLRenderTarget(S/2, S/2); shared.shadowMap.value = shadowRT.texture; shared.shadowMap2.value = shadowRT2.texture; shared.shadowTexel.value = 1/S; }
  const S = moving ? RT.motion : RT.full, u = POST.uniforms;
  u.res.value.set(S.w, S.h); u.dpr.value = dpr*(moving ? perf.scale : 1); u.zRange.value = camera.far - camera.near; u.quality.value = moving ? 0 : 1;
  u.tCol.value = S.rt.textures[0]; u.tN.value = S.rt.textures[1]; u.tD.value = S.rt.depthTexture; u.tN2.value = S.ghost.texture; u.tD2.value = S.ghost.depthTexture;
  return S;
}
// the shadow light: toward the lower left of the screen, turning with the viewer's yaw only (never with the pitch)
function placeShadowCam(){
  const a = 105*Math.PI/180, t = (cam.yaw - YAW0)*Math.PI/180, lx = -.45*Math.cos(a), ly = -.45*Math.sin(a);
  const dir = V3(lx*Math.cos(t) - ly*Math.sin(t), lx*Math.sin(t) + ly*Math.cos(t), 1).normalize();
  const c = V3(W/2, D/2, HTOP/2); shadowCam.position.copy(c).add(dir.clone().multiplyScalar(800)); shadowCam.up.set(0, 1, 0); shadowCam.lookAt(c); shadowCam.updateMatrixWorld();
  const inv = shadowCam.matrixWorldInverse; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const x of [-20, W + 20]) for (const y of [-20, D + 20]) for (const z of [-3, HTOP + 60]){ const q = V3(x, y, z).applyMatrix4(inv); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); z0 = Math.min(z0, -q.z); z1 = Math.max(z1, -q.z); }
  shadowCam.left = x0; shadowCam.right = x1; shadowCam.top = y1; shadowCam.bottom = y0; shadowCam.near = Math.max(1, z0 - 10); shadowCam.far = z1 + 10; shadowCam.updateProjectionMatrix();
  shared.shadowVP.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
}
function render(moving){
  const S = ensureTargets(moving); placeCam();
  const k = ease(st.xr || 0);
  // shadows: everything solid into one map, the crane into a lighter one
  scene.overrideMaterial = DEPTH_MAT;
  placeShadowCam();
  shadowCam.layers.set(0); shadowCam.layers.enable(1); renderer.setRenderTarget(shadowRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, shadowCam);
  shadowCam.layers.set(2); renderer.setRenderTarget(shadowRT2); renderer.clear(); renderer.render(scene, shadowCam);
  // one draw of the scene: colour, normals + ink weight, depth
  scene.overrideMaterial = null; renderer.setClearColor(0x000000, 0); camera.layers.enableAll(); renderer.setRenderTarget(S.rt); renderer.clear(); renderer.render(scene, camera);
  // the ghost cases' edges apart, lighter
  if (k > 0){ scene.overrideMaterial = EDGE_MAT; camera.layers.set(1); renderer.setRenderTarget(S.ghost); renderer.clear(); renderer.render(scene, camera); scene.overrideMaterial = null; }
  // composite: at rest straight to the page; in motion into the small buffer, then stretched to the page
  POST.uniforms.ghost.value = .6*k; quad.material = POST;
  if (moving){ renderer.setRenderTarget(S.ink); renderer.clear(); renderer.render(quadScene, quadCam); quad.material = BLIT; BLIT.uniforms.t.value = S.ink.texture; }
  renderer.setRenderTarget(null); renderer.clear(); renderer.render(quadScene, quadCam);
}

/* ---------- one clock: simulation steps, camera moves, drawing on demand ---------- */
// frames follow the screen, with a timer fallback for when they don't come (a hidden tab, headless shots)
const steps = new Set(); let driving = false, lastT = 0, dirty = true, fbT = 0;
const frameFn = () => { if (!driving) return; driving = false; clearTimeout(fbT);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - lastT)/1000)); lastT = now;
  for (const s of [...steps]) if (s(dt) === false) steps.delete(s);
  if (follow.on && steps.size) followTick(dt);
  if (steps.size || dirty){ dirty = false; const moving = camMoved; camMoved = false; if (moving) perfTick(now); else perf.lastT = 0;
    const t0 = performance.now(); syncAll(); const t1 = performance.now(); render(moving); const t2 = performance.now();
    Chrome.tick(); drawLabels(); drawCompass(); if (window.ControlRoom) ControlRoom.observe();
    clearTimeout(restT); if (moving) restT = setTimeout(invalidate, 90);
    window.__ft = { sync: t1 - t0, render: t2 - t1, post: performance.now() - t2, moving, scale: moving ? perf.scale : 1, calls: renderer.info.render.calls, geos: renderer.info.memory.geometries, tex: renderer.info.memory.textures, frames: (window.__ft ? window.__ft.frames : 0) + 1 }; }
  if (steps.size) drive(); };
const drive = () => { if (driving) return; driving = true; requestAnimationFrame(frameFn); fbT = setTimeout(frameFn, 60); };
function invalidate(){ dirty = true; drive(); }
ui = { st, render: invalidate, invalidate, animate: step => { if (!steps.size && !driving) lastT = performance.now(); steps.add(step); drive(); },
  flash: (text, ms = 1600) => { const t = document.getElementById('toast'); t.textContent = text[0].toUpperCase() + text.slice(1); t.classList.add('show'); clearTimeout(ui._ft); ui._ft = setTimeout(() => t.classList.remove('show'), ms); } };
window.ui = ui; window.__st = st;
// for the browser checks: where a world point lands on the canvas (CSS px), the camera, and a zoom toward a point
window.__proj = p => toScreen(p); window.__cam = cam; window.__labels = () => labelItems().map(it => ({ key: it.key, at: toScreen(it.at), pri: it.pri })); window.__zoomTo = (p, k) => { overview(0); const [x, y] = toScreen(p); zoomAt(k, x, y); };

/* ---------- gestures: one finger orbits, two pinch and pan, taps pick, flicks glide and snap ---------- */
const P = new Map(); let ges = null, lastTap = null, tapT = 0, spin = false;
const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} };
const two = () => { const [a, b] = [...P.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x)/2, y: (a.y + b.y)/2 }; };
const evPos = e => [e.clientX - box.left, e.clientY - box.top];
const raycaster = new THREE.Raycaster();
function pick(e){ const [px, py] = evPos(e); raycaster.setFromCamera(new THREE.Vector2((px/box.w)*2 - 1, -(py/box.h)*2 + 1), camera);
  raycaster.layers.enableAll(); const hits = raycaster.intersectObjects(pickables, false); if (!hits.length) return null; const h = hits[0], a = h.object.userData.act;
  if (a && a.type === 'board'){ const i = Math.round((20.1 - h.point.y)/3.6), rows = st.deploys.filter(d => !d.sys || st.showSys).slice(0, 4); if (rows[i] && Math.abs(h.point.y - (20.1 - i*3.6)) < 1.7) return { type:'app', app: rows[i].app }; }
  return a; }
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
// a flick keeps turning and slows quickly; one that would come to rest near a cardinal view snaps onto it
function glide(s){ const now = performance.now(), a = s.find(x => now - x.t < 110) || s[s.length - 1], b = s[s.length - 1], dt = b && a ? (b.t - a.t)/1000 : 0;
  let vy = dt > 0 ? (b.yaw - a.yaw)/dt : 0, vp = dt > 0 ? (b.pitch - a.pitch)/dt : 0; vy = Math.max(-900, Math.min(900, vy)); vp = Math.max(-400, Math.min(400, vp));
  const TAU = .14, restYaw = cam.yaw + vy*TAU, near = nearestCardinal(restYaw), off = angDiff(near, restYaw);
  if ((Math.abs(vy) > 80 && Math.abs(off) < 16) || Math.abs(off) < 4){ flyTo({ yaw: near, pitch: cam.pitch + vp*TAU }, 340, () => { buzz(8); const c = document.getElementById('compass'); c.classList.remove('snap'); void c.offsetWidth; c.classList.add('snap'); rest(); }); return; }
  if (Math.abs(vy) < 40 && Math.abs(vp) < 40){ rest(); return; }
  const id = ++camAnim; ui.animate(dt => { if (id !== camAnim) return false; const k = Math.exp(-dt/TAU); cam.yaw += vy*TAU*(1 - k); cam.pitch = clampP(cam.pitch + vp*TAU*(1 - k)); vy *= k; vp *= k; applyFrame(); invalidate();
    if (Math.abs(vy) < 5 && Math.abs(vp) < 5){ rest(); return false; } return true; }); }
// a tap picks; a second tap on the same spot zooms in there instead
function tap(e){ const now = performance.now(), [x, y] = evPos(e);
  if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 26){ clearTimeout(tapT); lastTap = null; release(); zoomAt(2, x, y, 420); return; }
  lastTap = { t: now, x, y }; const a = pick(e); clearTimeout(tapT);
  tapT = setTimeout(() => { if (a) act(a); else Chrome.hideCard(); }, e.pointerType === 'mouse' ? 0 : 240); }
function act(a){ release(); Chrome.open(a); invalidate(); }
// wheel: ctrl/cmd (a trackpad pinch) zooms anywhere; in yard mode a mouse wheel zooms and a trackpad's two fingers pan; on a page a plain wheel scrolls it
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
const zpEl = document.querySelector('.zchip .zp');
document.querySelector('.zchip .zi').onclick = () => { release(); zoomAt(1.5, box.w/2, box.h/2, 300); };
document.querySelector('.zchip .zm').onclick = () => { release(); zoomAt(1/1.5, box.w/2, box.h/2, 300); };
zpEl.onclick = () => { release(); overview(); };
function spinToggle(){ spin = !spin; camAnim++; if (spin){ setFollow(false); ui.animate(dt => { if (!spin) return false; if (!ges) cam.yaw += dt*18; applyFrame(); invalidate(); return true; }); } return spin; }

/* ---------- labels: screen-sized text placed by projection, more of it the closer you are ----------
   overview: node names and the board's counts; from ~2x: app and version on every container, GPU bands;
   from ~4x: pod name plates and the board's full rows. Nothing overlaps: the lower priority drops out. */
const LB = new Map(); let selKey = null;
const estW = it => { const main = it.text.replace(/<[^>]+>/g, ''), fs = it.cls === 'callout' ? 10 : it.cls === 'node' ? 10.5 : 11, sw = (it.text.match(/<i /g) || []).length*14;
  return Math.max(main.length*fs*.62 + sw, (it.sub || '').length*9*.62) + 18; };
const estH = it => (it.lines ? it.lines*14 : 11) + (it.sub ? 13 : 0) + 10;
function labelItems(){ const items = [], z = ppu(), L1 = z >= 2.2, L2 = z >= 4.4, facing = viewDir(cam.yaw, cam.pitch).x >= 0 ? 1 : -1, notext = html.classList.contains('notext');
  if (!notext){
    for (const n of st.nodes){ if (n.joined < 1) continue; items.push({ key: 'n:' + n.name, cls: 'node', text: esc(n.name) + (n.gpus ? ` · GPU x${n.gpus}` : ''), at: [n.x0 + SLD + 5, n.y0 + SLW/2, 0], pri: 8, act: { type:'node', node: n.name } }); }
    const rows = boardRows(); if (rows.length){ const full = L2 || z >= 3.2 && rows.length <= 2;
      items.push({ key: 'board', cls: 'board', lines: full ? rows.length : 1, text: full ? rows.map(r => `<i style="background:${r.col}"></i>${r.bad ? '<span style="color:#b3261e">' : ''}${esc(r.text)}${r.bad ? '</span>' : ''}`).join('<br>') : rows.map(r => `<i style="background:${r.col}"></i>${esc(r.text.split(' ')[1] || '')}`).join(' '), at: [38, 56, 27.5], pri: 7, act: { type:'board' } }); }
    if (L1) for (const p of st.pods){ if (!p.pos || p.sys && !st.showSys || p.alpha < .5 || p.phase === 'scheduled') continue; const n = st.nodes.find(n => n.name === p.node);
      const covered = n && p.slot && st.crane.carry !== p && !p.drop && n.used.has(slotKey({ c: p.slot.c, r: p.slot.r, t: p.slot.t + 1 }));
      const at = covered ? [p.pos[0] + (facing > 0 ? PW + .2 : -.2), p.pos[1] + PL/2, p.pos[2] + PH*.62] : [p.pos[0] + PW/2, p.pos[1] + PL/2, p.pos[2] + PH + .4];
      items.push({ key: 'p:' + p.id, cls: 'pod', col: palOf(p.app).l, text: `${esc(p.app)} ${esc(p.ver)}` + (p.gpu ? `<b>GPU x${p.gpu}</b>` : ''), sub: L2 ? p.name : '', at, up: !covered, pri: covered ? 5 : 6, act: { type:'pod', id: p.id } }); } }
  if (!html.classList.contains('nolabels')) for (const c of calloutItems()) items.push({ key: 'c:' + c.text, cls: 'callout', text: esc(c.text), at: c.at, on: c.on, lead: true, pri: (st.xr || 0) > .6 ? 6.5 : 4, act: { type:'explain', text: c.text } });   // inside a see-through pod the part names matter more than its own
  return items; }
function drawLabels(){ if (html.classList.contains('nolabels')){ if (LB.size){ for (const L of LB.values()){ clearTimeout(L.outT); L.el.remove(); } LB.clear(); } if (ov._h){ ov._h = ''; ov.innerHTML = ''; } return; }
  const items = labelItems(), placed = [], want = new Set(), writes = []; let leaders = '';
  for (const it of items){ const s = toScreen(it.at); it.x = s[0]; it.y = s[1]; it.depth = s[2]; }
  items.sort((a, b) => b.pri - a.pri || a.depth - b.depth);
  for (const it of items){ const w = estW(it), h = estH(it); let x = it.x, y = it.y; if (it.lead) y -= 30; else if (it.up) y -= h/2 + 3; else if (it.cls === 'node') y += h/2 + 2; else if (it.cls === 'board') y -= h/2 + 4;
    x = Math.max(w/2 + 3, Math.min(box.w - w/2 - 3, x)); if (it.x < -40 || it.x > box.w + 40 || it.y < -40 || it.y > box.h + 40) continue;
    const yard = YARD_MODE(), y0 = h/2 + 3 + (yard ? 46 : 0), y1 = box.h - h/2 - 3 - (yard ? 66 : 0);   // the strip and the toolbar cover the canvas in yard mode
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
// the see-through callouts, and the plain ones, as before: a world point and a word
function calloutItems(){ const k = ease(st.xr || 0), c = st.crane, items = [];
  if (k > .6){ const web = st.pods.find(p => p.pos && p.configMap) || st.pods.find(p => p.pos), sec = st.pods.find(p => p.pos && p.secret), pv = st.pods.find(p => p.pos && p.pvc), n0 = st.nodes[0];
    if (web){ const [x, y, z] = web.pos; items.push({ at:[x + 5, y + 5, z + 6], text:'CONTAINER', on: isReady(web) }, { at:[x + 2, y + PL - 2, z + 2.4], text:'POD NETWORK', on: isReady(web) }, { at:[x + 5, y + .6, z + 6], text:'CONFIGMAP', on:false }); }
    if (sec){ const [x, y, z] = sec.pos; items.push({ at:[x + 9, y + 2.8, z + 1.8], text:'SECRET', on:false }); }
    if (pv){ const [x, y, z] = pv.pos; items.push({ at:[x + 5, y - 3.2, z + 9.4], text:'VOLUME (PV)', on:false }); }
    if (n0 && n0.joined >= 1){ const bx0 = n0.x0 - 18, by1 = n0.y0 + SLW - 4; items.push({ at:[bx0 + 3, by1 - 8, 9], text:'KUBELET', on: st.pods.some(p => p.node === n0.name && p.phase === 'creating') }, { at:[bx0 + 8, by1 - 13, 6], text:'RUNTIME', on:false }, { at:[bx0 + 8, by1 - 3, 7], text:'KUBE-PROXY', on: st.parcels.length > 0 }); }
    items.push({ at:[21, 15, 8], text:'ETCD', on:false }, { at:[26, 17, 19], text:'API SERVER', on: !!c.job || st.pods.some(p => p.phase === 'pending') }, { at:[30, 11, 35], text:'CONTROLLERS', on: st.pods.some(p => p.phase === 'pending' || p.phase === 'terminating') },
      { at:[W - 40, 45, 6], text:'ENDPOINTS', on: st.parcels.length > 0 }, { at:[c.x, c.y, BZ + 2], text:'SCHEDULER', on: !!c.job }); }
  else { const n0 = st.nodes[0], ing = st.ingresses[0], pv = st.pods.find(p => p.pos && p.pvc), p0 = st.pods.find(p => p.pos && p.slot && p.slot.t === 0);
    if (n0 && n0.joined >= 1) items.push({ at:[n0.x0 + SLD - 3, n0.y0 + 8, SLH], text:'NODE', on:false }, { at:[n0.x0 - 13, n0.y0 + SLW - 10, 13.5], text:'KUBELET', on:false }, { at:[n0.x0 - 2.5, n0.y0 + 3, 15.5], text:'CAPACITY', on:false });
    if (p0) items.push({ at:[p0.pos[0] + PW, p0.pos[1] + PL/2, p0.pos[2] + 5], text:'POD', on: isReady(p0) }, { at:[p0.pos[0] + PW - 2, p0.pos[1] + PL - 2.6, p0.pos[2] + PH + 1], text:'READY LAMP', on: isReady(p0) });
    if (pv) items.push({ at:[pv.pos[0] + 5, pv.pos[1] - 3.2, pv.pos[2] + 9.4], text:'VOLUME', on:false });
    const gn = st.nodes.find(n => n.gpus && n.joined >= 1); if (gn) items.push({ at:[gn.x0 + 3, gn.y0 + 12, SLH + 5], text:'GPU', on: gpuUsed(gn) > 0 });
    items.push({ at:[18, 18, 56], text:'CONTROL', on:false }, { at:[38, 44, 24], text:'DEPLOYMENTS', on:false }, { at:[14, REG_Y0 + 16, 22], text:'REGISTRY', on: !!c.job }, { at:[c.x, c.y, BZ + 4.5], text:'SCHEDULER', on: !!c.job },
      { at:[W - 33, 45, 19], text:'SERVICE', on: st.parcels.length > 0 }, { at:[W - 22, 20, 22.5], text: ing ? 'INGRESS' : 'GATE', on: st.boom > .5 }); }
  return items; }

/* ---------- the compass: the gate, the tower and the registry around the yard's middle, turning with the camera ---------- */
const cmp = { N: document.getElementById('cN'), G: document.getElementById('cG'), T: document.getElementById('cT'), R: document.getElementById('cR'), key: '' };
function drawCompass(){ const { R, U } = basis(cam.yaw, cam.pitch), c = [W/2, D/2];
  const place = (el, wx, wy, rad) => { const v = V3(wx - c[0], wy - c[1], 0), sx = v.dot(R), sy = -v.dot(U), L = Math.hypot(sx, sy) || 1; el.style.transform = `translate(${(sx/L*rad).toFixed(1)}px,${(sy/L*rad).toFixed(1)}px)`; };
  const key = cam.yaw.toFixed(1) + '|' + cam.pitch.toFixed(1) + '|' + W + '|' + D; if (key === cmp.key) return; cmp.key = key;
  place(cmp.G, W - 22, 20, 19.5); place(cmp.T, 18, 18, 19.5); place(cmp.R, 16, REG_Y0 + 40, 19.5);
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
window.yard = { cam, flyTo, frameBox, frameAct, overview, front, follow: setFollow, following: () => follow.on, invalidate, relayout: () => { sizeKey = ''; cam.custom = false; reframe(); }, spin: spinToggle, select: a => { selKey = a && a.type === 'explain' ? 'c:' + a.text : null; invalidate(); }, toScreen, isYard: YARD_MODE, box: () => box };
Chrome.init(window.yard);
startDemo(); params(Q); reframe();
const camParams = Q.has('yaw') || Q.has('pitch');
if (camParams){ cam.yaw = +(Q.get('yaw') ?? YAW0); cam.pitch = clampP(+(Q.get('pitch') ?? PITCH0)); applyFrame(); } else loadCam();
if (Q.has('cluster')) watchUrl(Q.get('cluster'), +(Q.get('poll') || 0));
else if (Q.has('web') || Q.get('v2') === '1' || Q.get('cache') === '1' || Q.get('train') === '1' || Q.get('spark') === '1') run();
if (window.ControlRoom) ControlRoom.mount(document.getElementById('room'), { st, ui, speed: () => SPEED, run, say });
if (Q.has('chapter')) setTimeout(() => Chrome.applyChapter(Q.get('chapter'), camParams), 350);
addEventListener('resize', () => { sizeKey = ''; reframe(); });
new ResizeObserver(() => { sizeKey = ''; measure(); invalidate(); }).observe(zwrap);
invalidate();
