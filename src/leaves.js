import * as THREE from 'three';
import { uniforms, glslCommon, heightAt, riverZ, riverHalfWidth, riverEdge, WATER_Y, EYE } from './common.js';
import { gust } from './wind.js';
import { weather } from './weather.js';
import { trees } from './layout.js';
import { LEAVES } from './tree.js';
import { settings } from './settings.js';

// Falling leaves from the canopies the clock sees (docs/LIFE.md): a few now and then in calm air, more with wind,
// a flurry with each gust, more in rain. They flutter down (pendulum glides or tumbling cards), ride the wind,
// settle on the ground and fade; on the river they float downstream and fade.
// A fixed pool; the CPU moves each leaf (a light pass, most slots idle), the GPU turns and lights its card.
// Deterministic from the scene clock: slot i gets a chance to drop a leaf at (k + i/N) * P s for every cycle k, a
// hash of (i, k) decides whether it does and how; after a load or a time jump each leaf is replayed from its start.
export const leafLayer = new THREE.Group();

const N = 768; // pool: a spawn chance every P/N s (12.8 a second at most)
const P = 60; // s, one cycle per slot: the longest a leaf can live (falls from the big tree's top in < 40 s, then fades)
const STEP = 0.2; // s, replay step after a load or a time jump
const LIFT = 0.02; // m above the ground / water when settled
// ?leaves[=x] (dev): x times the rate (default 5), for screenshots
const force = new URLSearchParams(location.search).get('leaves');
const FORCE = force === null ? 1 : Number(force) || 5;

// Leaves a second over all the trees: ~1.2 in calm air (1 m/s), 2.4 on a fair day (3), 8.4 at 7, the pool's 12.8 in a
// storm (12, x1.6 in heavy rain); a gust adds 1.5 a second per m/s it adds (wind.js: fair ~+1 m/s, a gusty day +3-6).
// Each falls for only a few seconds and most land in the grass, so a fair day shows a few in the air at a time.
const rate = (s) => FORCE * (force === null ? settings['life.leaves'] : 1) * (1 + 0.15 * s * s + 1.5 * gust.extra) * (1 + 0.6 * weather.rain);

// integer hash -> [0, 1): the j-th number of slot i's cycle k
function rnd(i, j, k) {
  let h = Math.imul(i * 64 + j, 0x9e3779b1) ^ Math.imul(k + 0x632be5ab, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fract = (x) => x - Math.floor(x);

// ---------- cards ----------
const quad = new THREE.PlaneGeometry(1, 1);
const geo = new THREE.InstancedBufferGeometry();
geo.setIndex(quad.index);
geo.setAttribute('position', quad.getAttribute('position'));
const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
const rotAttr = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('aPos', posAttr); // xyz, alpha (0 = slot idle)
geo.setAttribute('aRot', rotAttr); // swing or spin phase (rad), settle 0..1, palette + 4 x tumbling, seed
geo.instanceCount = N;

const palette = Object.values(LEAVES);
const mat = new THREE.ShaderMaterial({
  uniforms: {
    ...uniforms,
    uPixel: { value: 0.001 }, // world size of one screen pixel at 1 m
    uLeaf: { value: palette.map((p) => new THREE.Color(p[0])) },
    uLeafTop: { value: palette.map((p) => new THREE.Color(p[1])) },
  },
  side: THREE.DoubleSide, // cards turn both faces to the camera as they tumble
  forceSinglePass: true, // one draw: three.js would draw the back faces, then the front, refreshing the program each time
  transparent: true, // they fade out where they settle
  depthWrite: false,
  vertexShader: glslCommon + /* glsl */ `
    uniform float uPixel;
    attribute vec4 aPos;
    attribute vec4 aRot;
    varying vec2 vUv;
    varying float vAlpha, vLit, vSeed, vPal;
    varying vec3 vFog0, vFog1;
    void main() {
      if (aPos.w <= 0.0) { gl_Position = vec4(0.0); return; }
      float seed = aRot.w, tumble = step(3.5, aRot.z), ph = aRot.x;
      float yaw = fract(seed * 11.0) * 6.283;
      vec3 up = vec3(0.0, 1.0, 0.0), u, v;
      if (tumble > 0.5) { // a card rolling over about a near-level axis in its plane, which turns slowly
        float a = yaw + ph * 0.15;
        v = normalize(vec3(cos(a), 0.6 * (fract(seed * 13.0) - 0.5), sin(a)));
        vec3 u0 = normalize(cross(v, up));
        u = u0 * cos(ph) + cross(v, u0) * sin(ph);
      } else { // pendulum glide (the swing is the CPU's): rocking nose-up toward each end of the swing, banking through
        // the middle like a glider (flat leaves seen from eye height would be edge-on most of the time)
        float sw = fract(seed * 7.0) * 6.283, tilt = 0.7 * sin(ph), bank = 0.8 * cos(ph);
        vec3 d = vec3(cos(sw), 0.0, sin(sw)), side = vec3(-d.z, 0.0, d.x);
        u = d * cos(tilt) + up * sin(tilt);
        v = side * cos(bank) + cross(u, side) * sin(bank);
      }
      // settled: lies flat, eased in over the landing (the position stops where it touched down)
      vec3 uf = vec3(cos(yaw), 0.0, sin(yaw));
      u = normalize(mix(u, uf, aRot.y));
      v = normalize(mix(v, vec3(-uf.z, 0.0, uf.x), aRot.y));
      // 13-18 cm long, like the canopy's stylised leaves (real 6-8 cm ones vanish next to them); at least ~8 px (about a
      // leaf on the big tree's far-LOD cards, seen from the clock 66 m away), so a far one still reads as a leaf
      float len = max(0.13 + 0.05 * fract(seed * 31.0), distance(aPos.xyz, cameraPosition) * uPixel * 8.0);
      vec3 p = aPos.xyz + (u * position.y + v * position.x * 0.6) * len;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      // two-sided: the face the camera sees; the back of a sunlit leaf glows through
      vec3 n = normalize(cross(u, v));
      if (dot(n, cameraPosition - p) < 0.0) n = -n;
      float ndl = dot(n, uSunDir);
      vLit = mix(toon(ndl, 0.1), 0.55, step(ndl, 0.0)) * shadowAt(aPos.xyz);
      vUv = position.xy;
      vAlpha = aPos.w;
      vSeed = seed;
      vPal = aRot.z - 4.0 * tumble;
      vFog0 = applyFog(vec3(0.0), aPos.xyz); // per card, like the canopy's
      vFog1 = applyFog(vec3(1.0), aPos.xyz) - vFog0;
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    #define LEAVES ${palette.length}
    uniform vec3 uLeaf[LEAVES];
    uniform vec3 uLeafTop[LEAVES];
    varying vec2 vUv;
    varying float vAlpha, vLit, vSeed, vPal;
    varying vec3 vFog0, vFog1;
    void main() {
      // leaf outline: a short stem, widest a third of the way up, a pointed tip
      float t = vUv.y + 0.5, w = 0.5 * pow(max(sin(3.1416 * pow(clamp((t - 0.08) / 0.92, 0.0, 1.0), 0.8)), 0.0), 0.9);
      float stem = step(t, 0.1) * step(abs(vUv.x), 0.04);
      if (abs(vUv.x) > w && stem < 0.5) discard;
      int i = fract(vSeed * 13.0) < 0.35 ? 2 : int(vPal + 0.5); // a third have turned gold: the crown's own greens hid them
      vec3 albedo = mix(uLeaf[i], uLeafTop[i], 0.45 + 0.55 * fract(vSeed * 5.0)) * (0.95 + 0.15 * vLit) * mix(1.0, 0.8, max(stem, step(abs(vUv.x), 0.03)));
      vec3 col = albedo * mix(mix(uShadeColor, uSunColor, 0.2), uSunColor, vLit); // the canopy's olive shade
      col = max(mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, 1.0 + 0.15 * uWet), 0.0); // applyFog's wet saturation
      gl_FragColor = vec4(col * vFog1 + vFog0, vAlpha);
      #include <colorspace_fragment>
    }`,
});
const mesh = new THREE.Mesh(geo, mat);
mesh.frustumCulled = false; // placed in the shader
mesh.renderOrder = 4; // after the clouds (3), before the rain (5); the river is opaque, so floating ones show on it
leafLayer.add(mesh);

// ---------- leaves ----------
const AIR = 1, GROUND = 2, WATER = 3;
const pool = Array.from({ length: N }, () => ({
  k: NaN, on: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, age: 0, tau: 0, ga: 0,
  fall: 1, amp: 0, w: 0, ph: 0, dx: 1, dz: 0, spin: 0, life: 20, pal: 0, tumble: 0, seed: 0,
}));
// the crowns (common.js uTrees: the first 16 trees, those the clock sees; written by tree.js at load), weighted by size
// and nearness to the clock: the big tree drops the most (~half), the near trees more than the far bank (where a leaf is
// a speck), so the leaves that can be seen are not too rare
const crowns = [];
let crownSum = 0;
function readCrowns() {
  for (let i = 0; i < uniforms.uTreeCount.value; i++) {
    const c = uniforms.uTrees.value[i];
    const wgt = c.w ** 1.7 * (1 + 30 / Math.hypot(c.x - EYE.x, c.z - EYE.z));
    crowns.push({ c, wgt, pal: Math.max(0, Object.keys(LEAVES).indexOf(trees[i].leaf ?? 'green')) });
    crownSum += wgt;
  }
}

// slot i's leaf of cycle k, if it drops one (decided with the rate now)
function spawn(L, i, k) {
  L.k = k; L.on = 0;
  if (!crowns.length || rnd(i, 0, k) >= rate(uniforms.uWindStrength.value) * P / N) return;
  let pick = rnd(i, 1, k) * crownSum, j = 0;
  while (j < crowns.length - 1 && (pick -= crowns[j].wgt) > 0) j++;
  const cr = crowns[j];
  // anywhere under the crown (a disc as wide as its cards reach, a quarter wider than its shadow), from its underside:
  // an ellipsoid's lower surface, held at least halfway up the tree; at the rim that is the crown's sides, seen against
  // the sky. Mostly the side the clock sees (behind the big tree they would fall unseen).
  const { c } = cr, a = Math.atan2(EYE.z - c.z, EYE.x - c.x) + (rnd(i, 2, k) - 0.5) * 4, q = Math.sqrt(rnd(i, 3, k));
  L.x = c.x + Math.cos(a) * q * c.w * 1.25; L.z = c.z + Math.sin(a) * q * c.w * 1.25;
  const ground = Math.max(heightAt(L.x, L.z), WATER_Y), foot = heightAt(c.x, c.z);
  L.y = Math.max(c.y - 0.7 * c.w * Math.sqrt(1 - q * q) * (0.6 + 0.4 * rnd(i, 4, k)), foot + 0.5 * (c.y - foot), ground + 1.5);
  L.fall = Math.max(0.5 + rnd(i, 5, k), (L.y - ground) / 38); // 0.5-1.5 m/s, down within the cycle
  L.tumble = rnd(i, 6, k) < 0.35 + 0.03 * uniforms.uWindStrength.value ? 1 : 0; // more tumble in strong wind
  L.amp = L.tumble ? 0.05 + 0.1 * rnd(i, 7, k) : 0.15 + 0.3 * rnd(i, 7, k); // swing (m)
  L.w = 2.2 + 1.4 * rnd(i, 8, k); // swing rate (rad/s)
  L.ph = rnd(i, 9, k) * 2 * Math.PI;
  L.spin = (5 + 7 * rnd(i, 10, k)) * (rnd(i, 11, k) < 0.5 ? -1 : 1); // tumbling (rad/s)
  L.life = 10 + 20 * rnd(i, 12, k); // s settled before it is gone
  L.seed = rnd(i, 13, k);
  const sw = fract(L.seed * 7) * 2 * Math.PI; // the swing's direction (the shader derives it the same way)
  L.dx = Math.cos(sw); L.dz = Math.sin(sw);
  L.pal = cr.pal;
  L.vx = L.vz = 0; L.age = L.tau = L.ga = 0; L.on = AIR;
}

// where the leaf is drawn: its drifting centre plus the pendulum swing (rising a little toward each end)
const swing = (L) => L.amp * Math.sin(L.w * L.tau + L.ph);

function step(L, h) {
  L.age += h;
  if (L.on === AIR) {
    // horizontal: eases (~0.6 s) to the wind at its height (log profile: ~35% near the ground, 90% at crown tops), so a
    // change of wind speed or direction bends its path, never jumps it
    const s = uniforms.uWindStrength.value, d = uniforms.uWindDir.value;
    const ground = heightAt(L.x, L.z), carry = THREE.MathUtils.clamp(0.35 + 0.06 * (L.y - ground), 0.35, 0.9);
    // (exact for the step, so 0.2 s replay steps and 60 fps frames put a leaf in the same place)
    const tx = d.x * s * carry, tz = d.y * s * carry, e = Math.exp(-h / 0.6), k = 0.6 * (1 - e);
    L.x += tx * h + (L.vx - tx) * k; L.z += tz * h + (L.vz - tz) * k;
    L.vx = tx + (L.vx - tx) * e; L.vz = tz + (L.vz - tz) * e;
    L.y -= L.fall * h; L.tau += h;
    const sw = swing(L), py = L.y + 0.25 * sw * sw / L.amp;
    let px = L.x + L.dx * sw, pz = L.z + L.dz * sw, floor = heightAt(px, pz);
    if (py <= Math.max(floor, WATER_Y) + LIFT) { // touched down where it is drawn (backed up by the step's overshoot), the swing stops
      const over = Math.min(1, (Math.max(floor, WATER_Y) + LIFT - py) / (L.fall * h));
      px -= L.vx * h * over; pz -= L.vz * h * over; floor = heightAt(px, pz);
      L.x = px; L.z = pz; L.y = Math.max(floor, WATER_Y) + LIFT; L.amp = 0;
      L.on = floor < WATER_Y - 0.05 ? WATER : GROUND;
    }
  } else {
    L.ga += h;
    if (L.on === WATER) { // the current (river.js: 0.45 m/s at the banks, 1.3 mid-stream) and a little wind push
      const sl = riverZ(L.x + 0.5) - riverZ(L.x - 0.5), l = Math.hypot(1, sl), k = (L.z - riverZ(L.x)) / l / riverHalfWidth(L.x);
      const u = 0.45 + 0.85 * (1 - Math.min(k * k, 1)), wp = 0.04 * uniforms.uWindStrength.value, d = uniforms.uWindDir.value;
      const nx = L.x + (u / l + d.x * wp) * h, nz = L.z + (u * sl / l + d.y * wp) * h;
      if (riverEdge(nx, nz) < -0.15) { L.x = nx; L.z = nz; } else L.on = GROUND; // washed onto the beach: stays
    }
    if (L.ga >= L.life) L.on = 0;
  }
  if (L.age >= P) L.on = 0;
}

let lastT = null, jumpedAt = -Infinity, held = false;
const out = posAttr.array, rot = rotAttr.array;

// sceneSeconds = the scene clock (s), hours = the scene's time of day (0..24), dt = real seconds
export function updateLeaves(sceneSeconds, hours, camera, dt) {
  if (!crowns.length) readCrowns();
  const t = sceneSeconds, h = lastT === null ? -1 : t - lastT;
  // load, a slider jump or a hidden tab: replay every slot from its start (~19 ms in a storm, ~6 ms on a fair day). While
  // the time slider is dragged (jumps < 0.25 s apart) the leaves hide and replay once it rests: a replay every frame of
  // a drag made storm frames 51-77 ms
  const jump = !(h >= 0 && h < 1), real = uniforms.uTime.value;
  lastT = t;
  if (jump && real - jumpedAt < 0.25) held = true;
  if (jump) jumpedAt = real;
  if (held && real - jumpedAt < 0.25) { leafLayer.visible = false; return; }
  const replay = jump || held;
  held = false;
  leafLayer.visible = true;
  for (let i = 0; i < N; i++) {
    const L = pool[i], k = Math.floor(t / P - i / N), i4 = i * 4;
    if (replay || k !== L.k) {
      spawn(L, i, k);
      // replayed from its start (k + i/N) P under today's wind: the same leaves wherever the clock is set
      for (let left = t - (k + i / N) * P; L.on && left > 0; left -= STEP) step(L, Math.min(STEP, left));
    } else if (L.on) step(L, h);
    if (!L.on) { out[i4 + 3] = 0; continue; }
    const air = L.on === AIR, sw = air ? swing(L) : 0;
    out[i4] = L.x + L.dx * sw;
    out[i4 + 1] = air ? L.y + 0.25 * sw * sw / L.amp : L.y;
    out[i4 + 2] = L.z + L.dz * sw;
    // fade in as it leaves the crown, out over the last ~2/3 of its time settled, and before its slot's next cycle
    out[i4 + 3] = THREE.MathUtils.smoothstep(L.age, 0, 0.5) * (1 - THREE.MathUtils.smoothstep(L.ga, L.life * 0.35, L.life)) * (1 - THREE.MathUtils.smoothstep(L.age, P - 3, P));
    rot[i4] = L.tumble ? L.spin * L.tau : L.w * L.tau + L.ph;
    rot[i4 + 1] = air ? 0 : THREE.MathUtils.smoothstep(L.ga, 0, 0.4);
    rot[i4 + 2] = L.pal + 4 * L.tumble;
    rot[i4 + 3] = L.seed;
  }
  posAttr.needsUpdate = rotAttr.needsUpdate = true;
  mat.uniforms.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;
}
