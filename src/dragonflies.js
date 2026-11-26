import * as THREE from 'three';
import { uniforms, glslCommon, heightAt, riverZ, riverHalfWidth, WATER_Y } from './common.js';
import { glslWind } from './wind.js';
import { animals, weather } from './weather.js';
import { REEDS } from './layout.js';
import { settings } from './settings.js';

// Dragonflies over the river on warm days (docs/LIFE.md): 1-4 at once (sometimes none) patrol the near bank's reeds,
// darting between hovering spots and now and then perching on a reed tip. Each of the 4 slots may visit in each 5 min
// block (odds from the hour, the wind, the rain, the cloud): it flies in from up over the far side, dashes and hovers
// around a reed patch, and flies off again. Flight is worked out on the CPU from the scene clock (seeded per block, so
// dev views agree); the wing beat, the reed's sway under a perched one and the sun's glint on the wings are in the shader.
export const dragonflyLayer = new THREE.Group();

const { smoothstep } = THREE.MathUtils;
const SLOTS = 4, BLOCK = 300; // s
const ODDS = [0.85, 0.6, 0.4, 0.25]; // the slots' chances of a visit in a block on a perfect day: usually 1-2, rarely 4 or none
const WIND = [4, 6]; // m/s: all out at 4, none from 6
const forced = new URLSearchParams(globalThis.location?.search ?? '').has('dragonflies'); // dev: every slot, any hour

// Odds 0..1 at scene hour h: warm hours with the sun well up, ~10:00-17:00
export const dragonflyHours = (h) => smoothstep(h, 9.5, 10.5) * (1 - smoothstep(h, 16.5, 17.5));

// ---------- reed tips (perches) ----------
// The tips of the reeds (layout.js REEDS) on the near bank in the clock view's stretch of river.
export const reeds = [];
for (let i = 0; i < REEDS.params.length / 4; i++) {
  const [px, y, pz] = REEDS.offsets.slice(3 * i, 3 * i + 3), [rot, h, cattail, rnd] = REEDS.params.slice(4 * i, 4 * i + 4);
  const lean = cattail ? 0 : h * 0.15; // a blade's tip leans out (river.js), a cattail's stem stands straight
  if (pz > riverZ(px) && px > -32 && px < 40) reeds.push({ x: px + Math.sin(rot) * lean, y: y + h + 0.012, z: pz + Math.cos(rot) * lean, rootX: px, rootZ: pz, h, rnd });
}
reeds.sort((a, b) => a.x - b.x);

// ---------- flight ----------
// A slot's day: visits (one per block at most), each a chain of segments: a dash from a to b (t0..t1, smootherstep: it
// stops into the hover), then a hover (or a perch on reed tip b) until t2, when the next dash starts. Two segments are
// kept (cur, nxt: the turn toward the next dash comes at the end of the hover).
const seg = () => ({ t0: 0, t1: 0, t2: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, yaw0: 0, yaw: 0, reed: null, from: null });
export const slots = Array.from({ length: SLOTS }, (_, k) => ({
  k, block: NaN, u: 1, start: 0, end: 0, homeX: 0, species: 0, seed: 0,
  on: false, exiting: false, done: false, cur: seg(), nxt: seg(),
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fly: 1, perch: 0, perchReed: null, // the pose (evaluate)
}));
const rnd = (s) => { // mulberry32 on the slot's own state: no closures per segment
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const turn = (a, b, f) => a + (Math.atan2(Math.sin(b - a), Math.cos(b - a))) * f; // the short way round

// The block slot s is in at time t (blocks staggered per slot) and its visit: when, around which reed patch, which colour
function plan(s, j) {
  s.block = j;
  s.seed = j * 7919 + s.k * 104729 + 13;
  const from = j * BLOCK - s.k * 77 - 150;
  s.u = rnd(s);
  s.start = from + 5 + 60 * rnd(s);
  s.end = s.start + 120 + 100 * rnd(s); // ends by from + 285: a gap before the next block's
  s.homeX = reeds[Math.floor(rnd(s) * reeds.length)].x;
  s.species = rnd(s) < 0.6 ? 0 : 1; // 0 blue, 1 green
  s.on = s.exiting = s.done = false;
}

// The next segment after p: a hover spot over the water by the near bank (or the beach), up to 7 m from the patch's
// middle and 6 m from the last spot, or now and then (not twice in a row) a reed tip nearby to perch on for a while.
function next(s, p, n) {
  n.t0 = p.t2; n.ax = p.bx; n.ay = p.by; n.az = p.bz; n.from = p.reed; n.reed = null;
  if (!p.reed && rnd(s) < 0.1) {
    for (let i = 0; i < 6 && !n.reed; i++) {
      const r = reeds[Math.floor(rnd(s) * reeds.length)];
      if (Math.abs(r.x - s.homeX) < 8 && Math.hypot(r.x - n.ax, r.z - n.az) < 8) n.reed = r;
    }
  }
  if (n.reed) { n.bx = n.reed.x; n.by = n.reed.y; n.bz = n.reed.z; }
  else {
    const x = s.homeX + (rnd(s) * 2 - 1) * 7, z = riverZ(x) + riverHalfWidth(x) - 3.8 + 4.6 * rnd(s);
    n.bx = x; n.bz = z; n.by = Math.max(heightAt(x, z), WATER_Y) + 0.35 + 1.2 * rnd(s);
    const dx = n.bx - n.ax, dz = n.bz - n.az, d = Math.hypot(dx, dz);
    if (d > 6) { n.bx = n.ax + (dx * 6) / d; n.bz = n.az + (dz * 6) / d; n.by = Math.max(n.by, Math.max(heightAt(n.bx, n.bz), WATER_Y) + 0.35); }
  }
  const d = Math.hypot(n.bx - n.ax, n.by - n.ay, n.bz - n.az);
  n.t1 = n.t0 + Math.max(0.25, d / (2.5 + 2.5 * rnd(s))); // 2.5-5 m/s on average, twice that at the dash's peak
  n.t2 = n.t1 + (n.reed ? 5 + 15 * rnd(s) : 0.4 + 3 * rnd(s));
  n.yaw0 = n.yaw = Math.atan2(n.bx - n.ax, n.bz - n.az);
}

// Arrive at t0: from 18 m upstream or downstream, 7 m up and 10 m out over the far side, onto the first hover spot
function arrive(s, t0) {
  const c = s.cur, dir = rnd(s) < 0.5 ? -1 : 1;
  c.bx = s.homeX + (rnd(s) * 2 - 1) * 4;
  c.bz = riverZ(c.bx) + riverHalfWidth(c.bx) - 1 - 2 * rnd(s);
  c.by = WATER_Y + 0.5 + rnd(s);
  c.ax = c.bx - dir * 18; c.az = c.bz - 10; c.ay = c.by + 7;
  c.from = c.reed = null;
  c.t0 = t0; c.t1 = t0 + 4.5; c.t2 = c.t1 + 1 + 2 * rnd(s);
  c.yaw0 = c.yaw = Math.atan2(c.bx - c.ax, c.bz - c.az);
  next(s, c, s.nxt);
  s.on = true;
}

// Leave at t: from where it is, off over the far side the same way (from a perch: the reed lets go of it)
function leave(s, t) {
  pose(s, t);
  const c = s.cur, dir = Math.sin(s.yaw) < 0 ? -1 : 1;
  c.from = s.perch > 0.5 ? s.perchReed : null; c.reed = null;
  c.ax = s.x; c.ay = s.y; c.az = s.z;
  c.bx = s.x + dir * 18; c.bz = s.z - 10; c.by = s.y + 7;
  c.t0 = t; c.t1 = t + 4.5; c.t2 = Infinity;
  c.yaw0 = s.yaw; c.yaw = Math.atan2(c.bx - c.ax, c.bz - c.az);
  s.exiting = true;
}

// The pose at time t within the current segment: position, heading, pitch, wing beat (fly 1, held flat 0), perch
// weight (how much it rides the reed's sway, shader) and that reed
function pose(s, t) {
  const c = s.cur;
  if (t < c.t1) { // dash
    const u = Math.max(0, (t - c.t0) / (c.t1 - c.t0)), e = u * u * u * (u * (u * 6 - 15) + 10);
    const lift = Math.sin(Math.PI * u) * 0.12 * Math.min(1, (c.t1 - c.t0) / 1.5); // a shallow arc
    s.x = c.ax + (c.bx - c.ax) * e; s.y = c.ay + (c.by - c.ay) * e + lift; s.z = c.az + (c.bz - c.az) * e;
    s.yaw = turn(c.yaw0, c.yaw, smoothstep(t, c.t0, c.t0 + 0.12));
    const run = Math.hypot(c.bx - c.ax, c.bz - c.az);
    s.pitch = Math.sin(Math.PI * u) * Math.atan2(c.by - c.ay, Math.max(run, 0.1)) * 0.5;
    s.fly = 1;
    s.perchReed = c.from ?? c.reed;
    s.perch = c.from ? 1 - smoothstep(u, 0, 0.25) : c.reed ? smoothstep(u, 0.75, 1) : 0;
    return;
  }
  const settle = smoothstep(t, c.t1, c.t1 + 0.3) * (1 - smoothstep(t, c.t2 - 0.3, c.t2)); // bob only mid-hover
  s.x = c.bx; s.y = c.by; s.z = c.bz; s.pitch = 0;
  if (c.reed) { // perched: still, wings held flat from shortly after landing until just before take-off
    s.yaw = c.yaw;
    s.fly = 1 - settle;
    s.perch = 1; s.perchReed = c.reed;
  } else { // hovering: a small bob and sway, the head swinging a little
    s.x += 0.03 * Math.sin(t * 4.4 + s.k) * settle; s.y += 0.02 * Math.sin(t * 11.9) * settle; s.z += 0.03 * Math.cos(t * 3.1 + s.k) * settle;
    s.yaw = c.yaw + 0.15 * Math.sin(t * 0.8 + s.k) * settle;
    s.fly = 1;
    s.perch = 0; s.perchReed = null;
  }
  if (!s.exiting) s.yaw = turn(s.yaw, s.nxt.yaw, smoothstep(t, c.t2 - 0.15, c.t2)); // the sharp turn before the next dash
}

// Advance slot s to time t; odds = its chance of being around now (0..1). Returns whether it is out.
function step(s, t, odds) {
  const j = Math.floor((t + s.k * 77 + 150) / BLOCK);
  if (j !== s.block) plan(s, j);
  const welcome = forced || s.u < odds * ODDS[s.k] * settings['life.dragonflies'];
  if (!s.on && !s.done && welcome && t >= s.start && t < s.end - 30) arrive(s, t); // (a reset replays from the start: replay)
  if (!s.on) return false;
  const until = Math.min(t, s.end);
  while (!s.exiting && until >= s.cur.t2) { const c = s.cur; s.cur = s.nxt; s.nxt = c; next(s, s.cur, s.nxt); }
  if (!s.exiting && (t >= s.end || !welcome)) leave(s, until);
  if (s.exiting && t >= s.cur.t1) { s.on = false; s.done = true; return false; }
  pose(s, t);
  return true;
}

// ---------- drawing ----------
// Per instance (one per slot): aPos xyz + species, aPose yaw, pitch, fly, shown; aReed root x, z, height, random (the
// perch's sway, as river.js's reeds) and aPerch, how much it rides it.
const attrs = { aPos: 4, aPose: 4, aReed: 4, aPerch: 1 };
for (const k in attrs) attrs[k] = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * attrs[k]), attrs[k]).setUsage(THREE.DynamicDrawUsage);
function instanced(base) {
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(base.index);
  for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
  for (const k in attrs) g.setAttribute(k, attrs[k]);
  g.instanceCount = SLOTS;
  return g;
}

// Body: a slim lathe, 8.4 cm from the tail tip to the big-eyed head (+z), 6 sides
const profile = [[0, -0.05], [0.0018, -0.049], [0.0021, -0.03], [0.0025, -0.012], [0.004, -0.005], [0.0055, 0.005], [0.0052, 0.016],
  [0.0034, 0.021], [0.0058, 0.026], [0.005, 0.031], [0, 0.034]].map(([r, y]) => new THREE.Vector2(r, y));
const bodyGeo = instanced(new THREE.LatheGeometry(profile, 6).rotateX(Math.PI / 2));
// Wings: four slim quads (forewings at z 1.3 cm, hindwings a little wider at 0.4 cm), 4.4 cm long, plus one quad for the glint
const wing = { position: [], uv: [], aWing: [] }, idx = [];
const quadAt = (xyz, uvs, w) => { const o = wing.position.length / 3; wing.position.push(...xyz); wing.uv.push(...uvs); for (let i = 0; i < 4; i++) wing.aWing.push(...w); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
for (const [z, chord, hind] of [[0.013, 0.0085, 0], [0.004, 0.011, 1]]) {
  for (const side of [-1, 1]) {
    const x0 = side * 0.003, x1 = side * 0.047, sweep = -0.004; // tips swept back
    quadAt([x0, 0.004, z - chord / 2, x1, 0.004, z - chord / 2 + sweep, x1, 0.004, z + chord / 2 + sweep, x0, 0.004, z + chord / 2], [0, 0, 1, 0, 1, 1, 0, 1], [side, z, hind, 0]);
  }
}
quadAt([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, 0, 1]);
const wingBase = new THREE.BufferGeometry();
wingBase.setAttribute('position', new THREE.Float32BufferAttribute(wing.position, 3));
wingBase.setAttribute('uv', new THREE.Float32BufferAttribute(wing.uv, 2));
wingBase.setAttribute('aWing', new THREE.Float32BufferAttribute(wing.aWing, 4));
wingBase.setIndex(idx);
const wingGeo = instanced(wingBase);

const local = {
  uFlap: { value: 0 }, // wing beat phase (rad), ~23 Hz from the scene clock
  uHalfPx: { value: 450 }, // half the target's height (px): main view or the river's half-size mirror
  uMinPx: { value: 1.2 },
};
// Shared: where an instance is and how it is turned. Seen from afar (the clock view is ~40 m off) it grows up to 1.6x,
// so it still reads as a speck rather than vanishing between pixels.
const glslPlace = glslCommon + glslWind + /* glsl */ `
  attribute vec4 aPos;
  attribute vec4 aPose;
  attribute vec4 aReed;
  attribute float aPerch;
  vec3 origin() {
    vec3 o = aPos.xyz;
    if (aPerch > 0.0) { // ride the reed tip's sway (river.js: windBend at the tip, the tip drops as it leans)
      vec2 b = windBend(aReed.xy, 1.0, aReed.z * 0.6, aReed.w) * aPerch;
      o.xz += b;
      o.y -= length(b) * 0.3;
    }
    return o;
  }
  vec3 turnIt(vec3 p) { // pitch (nose up +), then heading (yaw 0 = +z)
    float cp = cos(aPose.y), sp = sin(aPose.y), cy = cos(aPose.x), sy = sin(aPose.x);
    p = vec3(p.x, p.y * cp + p.z * sp, p.z * cp - p.y * sp);
    return vec3(p.x * cy + p.z * sy, p.y, p.z * cy - p.x * sy);
  }
  float grow(vec3 o) { return clamp(distance(cameraPosition, o) / 25.0, 1.0, 1.6); }
`;
const hidden = 'if (aPose.w < 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }';

const bodyMat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, ...local },
  vertexShader: glslPlace + /* glsl */ `
    varying vec3 vN;
    varying vec3 vWorldPos;
    varying float vZ;
    varying float vSpecies;
    void main() {
      ${hidden}
      vec3 o = origin();
      vWorldPos = o + turnIt(position) * grow(o);
      vN = turnIt(normal);
      vZ = position.z;
      vSpecies = aPos.w;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    varying vec3 vN;
    varying vec3 vWorldPos;
    varying float vZ;
    varying float vSpecies;
    void main() {
      vec3 N = normalize(vN), V = normalize(cameraPosition - vWorldPos);
      // iridescent: the body's colour turns toward teal at grazing angles; a darker thorax, big pale eyes
      vec3 base = vSpecies < 0.5 ? vec3(0.08, 0.3, 0.95) : vec3(0.12, 0.7, 0.3);
      vec3 col = mix(base, vec3(0.15, 0.85, 0.8), 0.6 * pow(1.0 - abs(dot(N, V)), 2.0));
      col = mix(col, col * 0.45, smoothstep(0.0, 0.006, vZ) * (1.0 - smoothstep(0.018, 0.022, vZ)));
      col = mix(col, vSpecies < 0.5 ? vec3(0.35, 0.65, 0.95) : vec3(0.45, 0.8, 0.4), step(0.022, vZ));
      float lit = toon(dot(N, uSunDir), 0.2) * shadowAt(vWorldPos);
      col *= mix(uShadeColor, uSunColor, lit);
      col += uSunColor * 0.6 * lit * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 24.0); // a metallic sheen
      gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
      #include <colorspace_fragment>
    }`,
});

// Wings: clear and faintly tinted (premultiplied alpha), a sharp sun glint off each; the glint quad adds a soft star
// at the body when a wing catches the sun, never smaller than uMinPx (the speck you see darting from the clock view)
const wingMat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, ...local },
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  forceSinglePass: true, // one draw: three.js would draw the back faces, then the front, refreshing the program each time
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  vertexShader: glslPlace + /* glsl */ `
    uniform float uFlap;
    uniform float uHalfPx;
    uniform float uMinPx;
    attribute vec4 aWing; // side, hinge z, hindwing, glint quad
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vWorldPos;
    varying vec3 vGlint;
    varying float vPart; // 1 = the glint quad
    // the sun's mirror glint off a wing with normal n seen from v (0..1, sharp)
    float glint(vec3 n, vec3 v) { return pow(max(abs(dot(n, normalize(uSunDir + v))), 0.0), 24.0); }
    void main() {
      ${hidden}
      vec3 o = origin();
      vec3 V = normalize(cameraPosition - o);
      float sun = toon(uSunDir.y, 0.05) * shadowAt(o) * smoothstep(0.0, 0.15, uSunDir.y);
      // beat: ±32° at ~23 Hz, hindwings a quarter beat ahead; held flat and a touch down when perched
      float fore = mix(-0.06, 0.55 * sin(uFlap), aPose.z), hind = mix(-0.06, 0.55 * sin(uFlap + 1.57), aPose.z);
      vGlint = vN = vWorldPos = vec3(0.0);
      vUv = uv;
      vPart = aWing.w;
      if (aWing.w > 0.5) { // the glint quad: the brightest wing's flash, camera-facing
        float g = 0.0;
        for (int i = 0; i < 4; i++) {
          float a = i < 2 ? fore : hind, s = mod(float(i), 2.0) * 2.0 - 1.0;
          g = max(g, glint(turnIt(vec3(-s * sin(a), cos(a), 0.0)), V));
        }
        g = sun * (0.5 * aPose.z + 1.5 * g); // a flying one always sparkles a little (the beating wings)
        if (g < 0.01) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
        vec4 mv = viewMatrix * vec4(o, 1.0);
        float pxPerM = projectionMatrix[1][1] * uHalfPx / max(-mv.z, 0.1), core = 0.005 * pxPerM, r = max(core, uMinPx);
        mv.xy += position.xy * 4.0 * r / pxPerM;
        gl_Position = projectionMatrix * mv;
        vUv = position.xy * 4.0; // in core radii
        vGlint = uSunColor * g * (applyFog(vec3(1.0), o) - applyFog(vec3(0.0), o)) * mix(1.0, 0.2, smoothstep(1.0, 4.0, core / uMinPx)); // close up the wings themselves glint
        return;
      }
      float a = aWing.z > 0.5 ? hind : fore, x = abs(position.x);
      vec3 p = vec3(aWing.x * x * cos(a), position.y + x * sin(a), position.z);
      vN = turnIt(vec3(-aWing.x * sin(a), cos(a), 0.0));
      vWorldPos = o + turnIt(p) * grow(o);
      vGlint = vec3(sun); // carries the light on the wing
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vWorldPos;
    varying vec3 vGlint;
    varying float vPart;
    void main() {
      if (vPart > 0.5) { // the glint quad
        float r = length(vUv), g = exp(-r * r * 1.5) + 0.12 * exp(-r) * (1.0 - smoothstep(2.5, 4.0, r));
        gl_FragColor = vec4(vGlint * g, 0.0); // added
        #include <colorspace_fragment>
        return;
      }
      // a slim rounded wing (u along the span, v across), a dark spot near the tip, faint veins
      vec2 q = vec2(vUv.x, (vUv.y - 0.5) * 2.0);
      float shape = 1.0 - smoothstep(0.85, 1.0, length(vec2(q.x * 1.0, q.y / (0.55 + 0.45 * sin(3.1416 * min(q.x * 1.1, 1.0))))));
      if (shape < 0.01) discard;
      vec3 N = normalize(vN), V = normalize(cameraPosition - vWorldPos);
      float lit = vGlint.x;
      float stigma = step(0.8, q.x) * step(q.x, 0.87) * step(abs(q.y), 0.35);
      float a = shape * (0.22 + 0.25 * stigma + 0.06 * step(0.92, fract(q.x * 9.0)));
      vec3 col = mix(vec3(0.85, 0.92, 1.0), vec3(0.15, 0.1, 0.05), stigma) * mix(uShadeColor, uSunColor, lit);
      vec3 spec = uSunColor * lit * pow(abs(dot(N, normalize(uSunDir + V))), 40.0) * 1.5 * shape;
      col = applyFog(col, vWorldPos);
      gl_FragColor = vec4(col * a + spec, a);
      #include <colorspace_fragment>
    }`,
});

const body = new THREE.Mesh(bodyGeo, bodyMat), wings = new THREE.Mesh(wingGeo, wingMat);
body.frustumCulled = wings.frustumCulled = false; // placed in the shader
const size = new THREE.Vector2();
wings.onBeforeRender = (renderer) => { // the main view or the river's half-size mirror: size the glint for that target
  const target = renderer.getRenderTarget(), pr = renderer.getPixelRatio();
  local.uHalfPx.value = (target ? target.height : renderer.getDrawingBufferSize(size).y) / 2;
  local.uMinPx.value = target ? Math.max(1.2, 0.8 * pr) : 1.3 * pr;
};
dragonflyLayer.add(body, wings);

let calm = -1, lastT = null; // the wind limit eased over ~8 s; the last scene time (jumps replay from the visit's start)

// sceneSeconds = the scene clock (s), hours = the scene's time of day (0..24), dt = real seconds
export function updateDragonflies(sceneSeconds, hours, camera, dt) {
  const t = sceneSeconds;
  const c = 1 - smoothstep(uniforms.uWindStrength.value, WIND[0], WIND[1]);
  calm = calm < 0 ? c : calm + (c - calm) * (1 - Math.exp(-dt / 8));
  const odds = dragonflyHours(hours) * calm * animals.back * (1 - 0.5 * weather.dim);
  // first frame, or the clock jumped (slider, a hidden tab): plan again and replay the visit from its start
  if (lastT === null || t < lastT || t - lastT > 10) for (const s of slots) { s.block = NaN; replay(s, t, odds); }
  lastT = t;
  let any = false;
  for (const s of slots) {
    const out = step(s, t, odds), i = s.k;
    any ||= out;
    attrs.aPose.array[i * 4 + 3] = out ? 1 : 0;
    if (!out) continue;
    attrs.aPos.array[i * 4] = s.x; attrs.aPos.array[i * 4 + 1] = s.y; attrs.aPos.array[i * 4 + 2] = s.z; attrs.aPos.array[i * 4 + 3] = s.species;
    attrs.aPose.array[i * 4] = s.yaw; attrs.aPose.array[i * 4 + 1] = s.pitch; attrs.aPose.array[i * 4 + 2] = s.fly;
    const r = s.perchReed;
    if (r) { attrs.aReed.array[i * 4] = r.rootX; attrs.aReed.array[i * 4 + 1] = r.rootZ; attrs.aReed.array[i * 4 + 2] = r.h; attrs.aReed.array[i * 4 + 3] = r.rnd; }
    attrs.aPerch.array[i] = r ? s.perch : 0;
  }
  for (const k in attrs) attrs[k].needsUpdate = true;
  local.uFlap.value = ((t * 23) % 1) * Math.PI * 2;
  body.visible = wings.visible = any;
}

// Bring slot s to time t as if it had been watched all along (a visit under way started at its start time)
function replay(s, t, odds) {
  const j = Math.floor((t + s.k * 77 + 150) / BLOCK);
  plan(s, j);
  if ((forced || s.u < odds * ODDS[s.k] * settings['life.dragonflies']) && t >= s.start && t < s.end + 5) { arrive(s, s.start); step(s, s.start, odds); }
}
