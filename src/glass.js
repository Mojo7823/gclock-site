import * as THREE from 'three';
import { mulberry32, uniforms } from './common.js';
import { weather } from './weather.js';
import { gust } from './wind.js';
import { settings } from './settings.js';

// Rain on the glass (settings 'glass.rain'): drops on a clear pane between the viewer and the scene. The scene stays
// sharp; each drop is a little lens that shows the scene behind it upside down and zoomed out (big drops more, small
// droplets a little), with a dark rim, a glint from the sky and a brighter bottom. The light comes from the frame
// itself (copied after it is drawn), so day, night, the clock's glow and lightning flashes all show in the drops.
//
// Simulation on the CPU in CSS pixels (y down), real time:
//   droplets: small, still; land with the rain, wiped off by drops running through them, dry up when it stops.
//   drops: bigger; the rain's fine spray feeds them and they merge when they touch; from SLIDE on the bigger ones give
//     way and run (stop-go, faster the bigger and the harder it rains), wiping a clean path through the droplets and
//     leaving a trail of new ones behind, slanted by the wind.
// Rain types follow weather.rain (lightrain 0.3: sparse, slow; rain 0.75; storm 1: dense, big, fast) plus the storm's
// lightning rate (splatter round each hit) and its gusts (bursts). Wind (glassWind): the part across the view slants
// the runs and moves where new drops land toward the downwind side; the part toward the viewer drives more rain onto
// the pane, from behind fewer.
// Drawing: each drop adds a soft blob to a CSS-sized float "water map" (sum of weights, so touching drops flow into one
// shape) carrying where in the drop each pixel is; one full-screen pass then bends the copied frame through it.

const MAX_SMALL = 6000, MAX_BIG = 450;
const rand = mulberry32(77);
const { clamp } = THREE.MathUtils;

// ---------- wind across the pane ----------
// dir = uWindDir (xz the wind blows toward), speed m/s, fwd = the camera's forward (xz used).
// slant: sideways px per px a drop runs down (+ = to the right); exposure: x the rain reaching the pane (toward the
// viewer = onto the glass); bias -1..1: where new drops land, toward the downwind side.
export function glassWind(dir, speed, fwd) {
  const fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
  const across = dir.x * -fz + dir.y * fx; // along the view's right
  const toward = -(dir.x * fx + dir.y * fz); // toward the viewer
  return {
    slant: clamp(across * speed * 0.045, -0.65, 0.65), // ~8° at 3 m/s straight across, ~30° at 12
    exposure: clamp(1 + 0.45 * toward * Math.min(1, speed / 6), 0.55, 1.45),
    bias: across * Math.min(1, speed / 8),
  };
}

// ---------- simulation ----------
const small = { x: new Float32Array(MAX_SMALL), y: new Float32Array(MAX_SMALL), r: new Float32Array(MAX_SMALL), n: 0 };
let drops = []; // { x, y, r, vx, vy, moving, stall, run, next, seed }
let smallCap = 0, carrySmall = 0, carryBig = 0;
const GRID = 16; // px: droplet lookup cells for the wipe
let head = new Int32Array(0);
const next = new Int32Array(MAX_SMALL);

// what is on the glass now (tools/glass-test.mjs)
export const glassCount = () => ({ small: small.n, drops: drops.length, moving: drops.filter((d) => d.moving).length });
export const glassDrops = () => drops;
export function clearGlass() { small.n = 0; drops = []; carrySmall = carryBig = 0; }

function addSmall(x, y, r) {
  let i = small.n;
  if (i >= smallCap) { if (!i) return; i = Math.floor(rand() * i); } // full: a new one lands where an old one was
  else small.n++;
  small.x[i] = x; small.y[i] = y; small.r[i] = r;
}

// x of a new drop: 0..W, denser toward the downwind side (pdf 1 + a(2u - 1))
function landX(W, bias) {
  const a = 0.8 * bias, u = rand();
  return W * (Math.abs(a) < 1e-3 ? u : (-(1 - a) + Math.sqrt((1 - a) ** 2 + 4 * a * u)) / (2 * a));
}

// env: { rain 0..1, storm 0..1, gust 0..1, slant, exposure, bias }; W, H the view (CSS px).
export function stepGlass(dt, env, W, H) {
  const S = clamp(Math.sqrt(W * H) / 1200, 0.75, 1.4); // drop size scale: 1 at 1600x900
  const area = (W * H) / 1.44e6, k = env.rain;
  const hit = k * env.exposure * (1 + 1.2 * env.gust * env.storm); // storm gusts throw bursts at the pane
  const SLIDE = 5 * S, RUN = 13 * S; // a drop may start to run from SLIDE, must from RUN
  const pace = 0.4 + 1.1 * k, stallRate = 1.6 - 1.2 * k;
  smallCap = Math.min(MAX_SMALL, Math.round(3600 * (0.3 + 0.7 * k) * area));
  const bigCap = Math.min(MAX_BIG, Math.round(MAX_BIG * (0.35 + 0.65 * k) * Math.min(area, 1.5)));

  // new hits
  if (k > 0.002) {
    carrySmall += 280 * hit ** 1.5 * area * dt;
    for (; carrySmall >= 1; carrySmall--) addSmall(landX(W, env.bias), rand() * H, (1 + 2.2 * rand() ** 2) * S * (0.85 + 0.3 * k));
    carryBig += 30 * hit ** 1.5 * area * dt;
    for (; carryBig >= 1 && drops.length < bigCap; carryBig--) {
      const x = landX(W, env.bias), y = rand() * H, r = (3 + 9 * rand() ** 2.5) * S * (0.8 + 0.4 * k);
      drops.push({ x, y, r, vx: 0, vy: 0, moving: false, stall: 0, run: 0, next: r * 3, seed: rand() * 100 });
      if (rand() < env.storm * 0.6) { // a hard hit splatters, the spray thrown downwind
        for (let s = 2 + Math.floor(rand() * 4); s > 0; s--) {
          addSmall(x + (env.slant * 2 + rand() - 0.5) * r * 3, y + (rand() - 0.5) * r * 2.5, (0.6 + rand()) * S);
        }
      }
    }
    carryBig = Math.min(carryBig, 1);
  }

  // droplets in a grid, for the drops running through them
  const cols = Math.ceil(W / GRID) + 2, rows = Math.ceil(H / GRID) + 2;
  if (head.length < cols * rows) head = new Int32Array(cols * rows);
  head.fill(-1, 0, cols * rows);
  const col = (x) => clamp(Math.floor(x / GRID) + 1, 0, cols - 1), row = (y) => clamp(Math.floor(y / GRID) + 1, 0, rows - 1);
  for (let i = 0; i < small.n; i++) { const c = col(small.x[i]) + row(small.y[i]) * cols; next[i] = head[c]; head[c] = i; }
  const nGrid = small.n; // trail droplets added below aren't in the grid: a drop never swallows its own trail

  const dry = k < 0.02;
  for (const d of drops) {
    if (!d.moving) {
      // still drops: the fine spray of the rain feeds them; the bigger, the likelier one gives way and runs
      if (!dry) d.r += dt * 0.1 * k * k * S;
      const over = (d.r - SLIDE) / SLIDE;
      if (d.r > RUN || (over > 0 && rand() < dt * (0.02 + 0.25 * k * k) * over * over)) Object.assign(d, { moving: true, vy: 0, stall: 0 });
    }
    if (d.moving) {
      if (d.stall > 0) { d.stall -= dt; d.vy *= Math.exp(-dt * 10); } // caught on the glass for a moment
      else {
        d.vy += ((d.r - SLIDE * 0.5) * 20 * pace - d.vy) * (1 - Math.exp(-dt * 4));
        if (rand() < dt * stallRate * (SLIDE * 1.5) / d.r) d.stall = 0.15 + rand() * (1.2 - 0.8 * k);
      }
      const wobble = 0.12 * Math.sin(d.y * 0.07 + d.seed) + 0.1 * Math.sin(d.y * 0.023 + d.seed * 3);
      d.vx = d.vy * (env.slant + wobble);
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      // wipe: droplets in the path join the drop (part of their water stays on the glass as film)
      const reach = d.r * 0.95 + 2 * S;
      for (let cy = row(d.y - reach), cy1 = row(d.y + reach); cy <= cy1; cy++) {
        for (let cx = col(d.x - reach), cx1 = col(d.x + reach); cx <= cx1; cx++) {
          for (let j = head[cx + cy * cols]; j >= 0; j = next[j]) {
            const rj = small.r[j], dx = small.x[j] - d.x, dy = small.y[j] - d.y, rr = d.r * 0.95 + rj * 0.5;
            if (rj > 0 && j < nGrid && dx * dx + dy * dy < rr * rr) { d.r = Math.cbrt(d.r ** 3 + 0.7 * rj ** 3); small.r[j] = 0; }
          }
        }
      }
      // trail: a line of droplets left behind
      if ((d.run += d.vy * dt) > d.next) {
        d.run = 0;
        d.next = d.r * (0.5 + 2.5 * rand());
        const rt = d.r * (0.14 + 0.16 * rand());
        if (rt > 0.5 * S) {
          addSmall(d.x - d.vx / Math.max(d.vy, 1) * d.r + (rand() - 0.5) * d.r * 0.4, d.y - d.r * (1.1 + 0.4 * rand()), rt);
          d.r = Math.cbrt(d.r ** 3 - rt ** 3);
        }
      }
      if (d.r < SLIDE * 0.7) d.moving = false; // ran out of water: it stops and waits for more
    } else if (dry) d.r -= dt * 0.06 * S; // drying
  }

  // drops that touch flow together (the bigger one keeps going)
  for (let i = 0; i < drops.length; i++) {
    const a = drops[i];
    if (a.r <= 0) continue;
    for (let j = i + 1; j < drops.length; j++) {
      const b = drops[j];
      if (b.r <= 0) continue;
      const dx = a.x - b.x, dy = a.y - b.y, rr = (a.r + b.r) * 0.85;
      if (dx * dx + dy * dy >= rr * rr) continue;
      const [keep, gone] = a.r >= b.r ? [a, b] : [b, a], va = keep.r ** 3, vb = gone.r ** 3, v = va + vb;
      keep.x = (keep.x * va + gone.x * vb) / v;
      keep.y = (keep.y * va + gone.y * vb) / v;
      keep.r = Math.cbrt(v);
      keep.vy = Math.max(keep.vy, gone.vy);
      keep.moving ||= gone.moving;
      gone.r = 0;
      if (gone === a) break;
    }
  }
  drops = drops.filter((d) => d.r > 0.6 * S && d.y - 2 * d.r < H && d.x > -2 * d.r && d.x < W + 2 * d.r);

  // compact the droplets; drying ones shrink away
  let n = 0;
  for (let i = 0; i < small.n; i++) {
    const r = dry ? small.r[i] - dt * 0.025 * S : small.r[i];
    if (r < 0.4 * S || small.y[i] > H + 4) continue;
    small.x[n] = small.x[i]; small.y[n] = small.y[i]; small.r[n] = r; n++;
  }
  small.n = n;
}

// ---------- drawing ----------
// Water map: per drop a quad 1.414 x its radius; weight (1 - d²)², so a lone drop's edge (sum 0.25) is at its radius.
// RGBA = sum of w * (where in the quad, -1..1 with y up), w * lens (px: how far the drop's view reaches), w.
const quad = new THREE.PlaneGeometry(1, 1);
const geo = new THREE.InstancedBufferGeometry();
geo.setIndex(quad.index);
geo.setAttribute('position', quad.getAttribute('position'));
const MAX_BLOBS = MAX_SMALL + MAX_BIG * 3; // drops running get two tail blobs: a teardrop
const blob = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLOBS * 4), 4).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('aDrop', blob); // x, y (CSS px, y down), quad radius (px), lens (px)
geo.instanceCount = 0;

const view = { value: new THREE.Vector2(1, 1) }; // the view in CSS px
const waterMat = new THREE.ShaderMaterial({
  uniforms: { uView: view },
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending, // plain sums (alpha too)
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  vertexShader: /* glsl */ `
    uniform vec2 uView;
    attribute vec4 aDrop;
    varying vec2 vQ;
    varying float vLens;
    void main() {
      vQ = position.xy * 2.0;
      vLens = aDrop.w;
      vec2 px = aDrop.xy + vec2(vQ.x, -vQ.y) * aDrop.z;
      gl_Position = vec4(px.x / uView.x * 2.0 - 1.0, 1.0 - px.y / uView.y * 2.0, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec2 vQ;
    varying float vLens;
    void main() {
      float d2 = dot(vQ, vQ);
      if (d2 >= 1.0) discard;
      float w = (1.0 - d2) * (1.0 - d2);
      gl_FragColor = vec4(vQ * w, vLens * w, w);
    }`,
});
const waterMesh = new THREE.Mesh(geo, waterMat);
waterMesh.frustumCulled = false;
const waterScene = new THREE.Scene().add(waterMesh);
const water = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });

// The pane: the copied frame bent through the water map, blended over the frame where there is water.
// Works in the frame's own (sRGB) values: the copy is read and written back as is.
const glassMat = new THREE.ShaderMaterial({
  uniforms: { uScene: { value: null }, uWater: { value: water.texture }, uView: view, uHi: { value: new THREE.Color() } },
  depthTest: false,
  depthWrite: false,
  transparent: true,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uScene;
    uniform sampler2D uWater;
    uniform vec2 uView;
    uniform vec3 uHi; // light off the sky (sRGB), lightning included
    varying vec2 vUv;
    void main() {
      vec4 w = texture2D(uWater, vUv);
      float f = w.a, aa = max(fwidth(f), 1e-3);
      float mask = smoothstep(0.25 - aa, 0.25 + aa, f);
      if (mask <= 0.0) discard;
      vec2 q = w.rg / f; // where in the drop (y up); |q| = 0.707 at a lone drop's edge
      vec2 qn = q / 0.707;
      float l2 = min(dot(qn, qn), 1.0);
      vec3 n = normalize(vec3(qn * 0.9, sqrt(1.0 - l2) + 0.2)); // a flattened dome
      // the drop as a lens: the scene around it, upside down and zoomed out
      vec3 c = texture2D(uScene, clamp(vUv - q * (w.b / f) / uView, 0.0, 1.0)).rgb;
      float edge = smoothstep(0.35, 1.0, l2);
      c *= 1.0 - 0.55 * edge; // dark rim: light bent away at the steep edge
      float glint = pow(max(dot(n, normalize(vec3(-0.35, 0.55, 1.0))), 0.0), 80.0); // the sky's glint, upper left
      float focus = smoothstep(0.1, 0.8, -qn.y) * (1.0 - edge); // light gathered at the bottom
      c += uHi * (1.4 * glint + 0.12 * focus + 0.1 * edge * smoothstep(0.0, 0.7, qn.y));
      gl_FragColor = vec4(c, mask);
    }`,
});
const glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glassMat);
glassMesh.frustumCulled = false;
const glassScene = new THREE.Scene().add(glassMesh);
const flat = new THREE.Camera(); // both passes place themselves

let frame = null, active = false, warm = true;
const fwd = new THREE.Vector3(), buffer = new THREE.Vector2(), css = new THREE.Vector2(), clearColor = new THREE.Color(), tint = new THREE.Color();

function writeBlobs() {
  const a = blob.array;
  let n = 0;
  const put = (x, y, r, lens) => { a[n * 4] = x; a[n * 4 + 1] = y; a[n * 4 + 2] = r * 1.414; a[n * 4 + 3] = lens * r * 1.414; n++; };
  for (let i = 0; i < small.n; i++) put(small.x[i], small.y[i], small.r[i], 1.8);
  for (const d of drops) {
    put(d.x, d.y, d.r, 4.2);
    const e = d.moving ? clamp(d.vy / 50, 0, 1) : 0;
    if (e < 0.05) continue;
    const v = Math.hypot(d.vx, d.vy), bx = -d.vx / v, by = -d.vy / v;
    put(d.x + bx * d.r * 0.85, d.y + by * d.r * 0.85, d.r * 0.72 * e, 4.2);
    put(d.x + bx * d.r * 1.6, d.y + by * d.r * 1.6, d.r * 0.45 * e, 4.2);
  }
  geo.instanceCount = n;
  blob.clearUpdateRanges();
  blob.addUpdateRange(0, n * 4);
  blob.needsUpdate = true;
}

// dt = real seconds since the last frame. Call every frame (main.js), before renderGlass.
export function updateGlass(dt, camera) {
  if (!settings['glass.rain']) { clearGlass(); active = false; warm = true; return; }
  const W = innerWidth, H = innerHeight;
  camera.getWorldDirection(fwd);
  const env = { rain: weather.rain, storm: clamp(weather.bolt / 4, 0, 1), gust: gust.env, ...glassWind(uniforms.uWindDir.value, uniforms.uWindStrength.value, fwd) };
  // the first frame with it on: loaded (or switched on) mid-rain, the glass has been out in it a while (2 min)
  if (warm && env.rain > 0.05) for (let i = 0; i < 600; i++) stepGlass(0.2, env, W, H); // ~80 ms, once
  warm = false;
  stepGlass(dt, env, W, H);
  active = small.n + drops.length > 0;
  if (!active) return;
  writeBlobs();
  view.value.set(W, H);
  // the glint: sky light, the sun's (or moon's) when it gets through; never quite black, so drops still read at night
  const hi = glassMat.uniforms.uHi.value.copy(uniforms.uFogColor.value).multiplyScalar(0.55)
    .add(tint.copy(uniforms.uSunColor.value).multiplyScalar(0.45 * (1 - 0.6 * weather.dim))).convertLinearToSRGB();
  hi.setRGB(Math.max(hi.r, 0.07), Math.max(hi.g, 0.08), Math.max(hi.b, 0.1), THREE.NoColorSpace);
}

// After the frame is drawn (main.js): copy it, draw the water map, bend the copy through it onto the frame.
export function renderGlass(renderer) {
  if (!active) return;
  renderer.getDrawingBufferSize(buffer);
  renderer.getSize(css);
  if (frame?.image.width !== buffer.x || frame?.image.height !== buffer.y) {
    frame?.dispose();
    frame = new THREE.FramebufferTexture(buffer.x, buffer.y);
    frame.minFilter = frame.magFilter = THREE.LinearFilter;
    glassMat.uniforms.uScene.value = frame;
  }
  if (water.width !== css.x || water.height !== css.y) water.setSize(css.x, css.y);
  renderer.setRenderTarget(null);
  renderer.copyFramebufferToTexture(frame);
  renderer.getClearColor(clearColor);
  const clearAlpha = renderer.getClearAlpha(), autoClear = renderer.autoClear;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(water);
  renderer.render(waterScene, flat);
  renderer.setRenderTarget(null);
  renderer.setClearColor(clearColor, clearAlpha);
  renderer.autoClear = false;
  renderer.render(glassScene, flat);
  renderer.autoClear = autoClear;
}
