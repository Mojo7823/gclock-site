import * as THREE from 'three';
import { uniforms, glslCommon, mulberry32, heightAt, riverZ, riverHalfWidth, WATER_Y, EYE, MOUNTAIN } from './common.js';
import { trees } from './layout.js';
import { animals } from './weather.js';
import { settings } from './settings.js';

// Fireflies from dusk into the night (docs/LIFE.md): soft yellow-green glows low over the grass, under the trees and
// bushes, along the banks, most across the river. Each one out is a creature you can follow: a dim ember wandering
// slowly around its home, glowing up for ~1 s every 4-6 s in step with its loose group. How many are out is one
// number (uDensity) from the hour, the night (some nights many, some few), the wind, the rain and the setting; it
// moves slowly, so each fades in or out over >= 5 s. Glow and path are a function of the scene clock in the shader
// (deterministic); main.js ticks updateFireflies.
export const fireflyLayer = new THREE.Group();

const { smoothstep } = THREE.MathUtils;
const PEAK = 19.6; // scene hours (sunset 18:00): most 1-2 h after sunset
const WIND = [5, 8]; // m/s: all out at 5, none from 8 (a breezy evening still has some)
const forced = new URLSearchParams(globalThis.location?.search ?? '').has('fireflies'); // dev: a best night, whatever the hour

// Presence 0..1 at scene hour h: in from just after sunset, most 19:00-21:30, about half from midnight until they go
// before dawn (04:00-05:30), none by day. (Until 2026-10-28 none from 02:00: the owner looked late and saw none.)
export function fireflyHours(h) {
  const x = h < 12 ? h + 24 : h;
  return smoothstep(x, 18.3, PEAK - 0.4) * (1 - 0.5 * smoothstep(x, 21.5, 24)) * (1 - smoothstep(x, 28, 29.5));
}
// The night's crowd (0.6 fewer .. 1 many): a hash of the date of the evening it began, like sky.js's meteors
export const nightCrowd = (y, m, d) => { const r = mulberry32(y * 10000 + m * 100 + d + 7)(); return 0.6 + 0.4 * r; };

// ---------- homes ----------
// Seeded once: around and under the crowns of trees and bushes within ~80 m, along both river banks (over the
// beach and the water's edge), the near meadow's sides and the far bank. Most across the river: only half of
// the near side's are kept, so the meadow in front of the clock stays quiet. Few in the middle of the clock view
// (the big tree and the river in front of it stay calm). Heights 0.4-1.7 m over the highest ground its path
// crosses, mostly low.
const az = (x, z) => Math.atan2(x - EYE.x, EYE.z - z); // bearing from the clock spot, right of -z
const BIG = trees.find((t) => t.type === 'giant') ?? { x: 0, z: -60 };
const MIDDLE = (az(BIG.x, BIG.z) * 3 + az(MOUNTAIN.x, MOUNTAIN.z)) / 4; // between the big tree and the view's centre (main.js clockView)
export const homes = [];
{
  const rand = mulberry32(5150);
  const add = (x, z) => {
    const d = Math.hypot(x - EYE.x, z - EYE.z);
    if (d < 4 || d > 80 || Math.abs(az(x, z)) > 1.25) return; // in the wedge the viewer can turn to, not on the lens
    if (rand() > 0.12 + 0.88 * smoothstep(Math.abs(az(x, z) - MIDDLE), 0.06, 0.2)) return; // the calm middle
    if (z > riverZ(x) && rand() > 0.5) return; // this side of the river: half as many
    let ground = WATER_Y; // the highest ground its wander (x +-3 m, z +-1.1 m) passes over, so it never dips into a slope
    for (let u = -3; u <= 3; u += 1) for (let v = -1.1; v <= 1.1; v += 0.55) ground = Math.max(ground, heightAt(x + u, z + v));
    homes.push([x, ground + 0.4 + 1.3 * rand() ** 1.8, z]);
  };
  for (const t of trees) { // under the crowns, a few around each: bushes 3, trees 5 (the big one 6)
    const r = t.type === 'bush' ? t.height * 0.7 : t.height * (t.type === 'giant' ? 0.5 : 0.3);
    for (let i = 0, n = t.type === 'bush' ? 3 : t.type === 'giant' ? 6 : 5; i < n; i++) {
      const a = rand() * 6.283, s = r * (0.3 + 1.1 * rand());
      add(t.x + Math.cos(a) * s, t.z + Math.sin(a) * s);
    }
  }
  for (let i = 0; i < 105; i++) { // the banks, from 1 m over the water to 4 m up the beach
    const x = -60 + 115 * rand(), side = rand() < 0.5 ? 1 : -1, e = -1 + 5 * rand() ** 1.5;
    add(x, riverZ(x) + side * (riverHalfWidth(x) + e));
  }
  for (let i = 0; i < 45; i++) { // the near meadow's sides, and where it tips into the valley
    const left = rand() < 0.5, x = (left ? -1 : 1) * (6 + 30 * rand()), z = 6 - 26 * rand();
    add(x, z);
  }
  for (let i = 0; i < 40; i++) add(-55 + 110 * rand(), -40 - 30 * rand()); // the far bank's meadow
}
const COUNT = homes.length;

// Per slot: home + rank (out while rank < uDensity, reshuffled each night), glow (cycles per hour, phase, glow
// length), wander (whole cycles per hour, so the hourly wrap of the clock is seamless). A loose group per 7 m cell
// shares a rhythm; each member runs up to 2 cycles an hour faster or slower, so they slide in and out of step over
// 15-60 min.
let density = -1, shuffle = 0, last = 0; // uDensity (rate-limited), uNight, the scene clock last frame
const FADE = 0.08; // rank band a firefly fades over: with uDensity moving at most FADE/5 per s, every fade takes >= 5 s
const EMBER = 0.3; // between glows: a faint ember, so each one can be followed
const slot = { home: new Float32Array(COUNT * 4), glow: new Float32Array(COUNT * 4), wander: new Float32Array(COUNT * 4) };
{
  const rand = mulberry32(5151), { home, glow, wander } = slot;
  for (let i = 0; i < COUNT; i++) {
    const [x, y, z] = homes[i];
    const g = mulberry32(Math.floor(x / 7 + 100) * 1000 + Math.floor(z / 7 + 100))(); // its group: a 7 m cell
    home.set([x, y, z, rand()], i * 4);
    // a 3.8-6 s period (group), glowing ~1-1.4 s of it, within 0.1 cycle of the group's phase
    glow.set([Math.round(600 + 350 * g) + Math.floor(5 * rand()) - 2, g * 7.3 % 1 + 0.1 * rand(), 1 + 0.4 * rand(), 0], i * 4);
    wander.set([20 + Math.floor(30 * rand()), 25 + Math.floor(35 * rand()), 50 + Math.floor(60 * rand()), rand()], i * 4);
  }
}
// What the vertex shader draws for slot i at clock c (s mod 3600), as JS for tools/fireflies-test.mjs: keep in step.
const ss = (a, b, x) => smoothstep(x, a, b);
export function fireflyAt(i, c, d = density, night = shuffle) {
  const h = slot.home, g = slot.glow, w = slot.wander, j = i * 4;
  const show = Math.min(1, Math.max(0, (d - ((h[j + 3] + night) % 1)) / FADE));
  const P = 3600 / g[j], cyc = c / P + g[j + 1], s = (cyc - Math.floor(cyc)) * P, D = g[j + 2];
  const f = ss(0, 0.35 * D, s) * (1 - ss(0.35 * D, D, s));
  const wx = 6.2831853 * ((c * w[j] / 3600) % 1) + w[j + 3] * 6.3, wy = 6.2831853 * ((c * w[j + 1] / 3600) % 1) + w[j + 3] * 2.1;
  const wz = 6.2831853 * ((c * w[j + 2] / 3600) % 1) + w[j + 3] * 4.7;
  return {
    x: h[j] + 2.2 * Math.sin(wx) + 0.8 * Math.sin(wz), y: h[j + 1] + 0.2 * Math.sin(wx - wy) + 0.12 * f, z: h[j + 2] + 0.7 * Math.sin(wy) + 0.3 * Math.cos(wz),
    show, glow: f, a: show * (EMBER + (1 - EMBER) * f), period: P,
  };
}

const quad = new THREE.PlaneGeometry(1, 1);
const geo = new THREE.InstancedBufferGeometry();
geo.setIndex(quad.index);
geo.setAttribute('position', quad.getAttribute('position'));
geo.setAttribute('aHome', new THREE.InstancedBufferAttribute(slot.home, 4));
geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(slot.glow, 4));
geo.setAttribute('aWander', new THREE.InstancedBufferAttribute(slot.wander, 4));
geo.instanceCount = COUNT;

const local = {
  uClock: { value: 0 }, // scene seconds mod 3600
  uDensity: { value: 0 },
  uNight: { value: 0 }, // this night's shuffle of the ranks
  uHalfPx: { value: 450 }, // half the target's height (px): the main view or the river's half-size mirror
  uMinPx: { value: 1.4 }, // smallest glow core radius (px), so far ones don't shimmer between pixels
  uGain: { value: 1 },
};
const mat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, ...local },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: glslCommon + /* glsl */ `
    uniform float uClock;
    uniform float uDensity;
    uniform float uNight;
    uniform float uHalfPx;
    uniform float uMinPx;
    uniform float uGain;
    attribute vec4 aHome;
    attribute vec4 aGlow;
    attribute vec4 aWander;
    varying vec2 vUv;
    varying vec3 vCol;
    const float TAU = 6.2831853;
    void main() {
      float show = clamp((uDensity - fract(aHome.w + uNight)) / ${FADE.toFixed(3)}, 0.0, 1.0);
      if (show < 0.004) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; } // not out tonight
      // glow: one cycle = aGlow.x per hour, P s long; a soft rise over 0.35 D and fall over the rest of D (1-1.4 s),
      // then the dim ember until the next
      float P = 3600.0 / aGlow.x, cyc = uClock / P + aGlow.y, s = (cyc - floor(cyc)) * P, D = aGlow.z;
      float f = smoothstep(0.0, 0.35 * D, s) * (1.0 - smoothstep(0.35 * D, D, s));
      float a = show * (${EMBER.toFixed(2)} + ${(1 - EMBER).toFixed(2)} * f);
      // a slow wander along a looping path, mostly sideways (along the banks and slopes: it keeps its height over
      // the ground): ~3 m across, 0.2-0.35 m/s, periods 33-180 s; rising a little while it glows (the J-flash)
      vec3 w = TAU * fract(uClock * aWander.xyz / 3600.0) + aWander.w * vec3(6.3, 2.1, 4.7);
      vec3 p = aHome.xyz + vec3(2.2 * sin(w.x) + 0.8 * sin(w.z), 0.2 * sin(w.x - w.y) + 0.12 * f, 0.7 * sin(w.y) + 0.3 * cos(w.z));
      vec4 mv = viewMatrix * vec4(p, 1.0);
      float dist = -mv.z, pxPerM = projectionMatrix[1][1] * uHalfPx / max(dist, 0.1);
      // a ~3.5 cm core (a real lantern is ~1 cm; the glow round it reads a little wider) with a faint halo 3x as wide;
      // never under uMinPx (px), dimmer instead of smaller far away
      float core = 0.035 * pxPerM, r = max(core, uMinPx);
      mv.xy += position.xy * 8.0 * r / pxPerM;
      gl_Position = projectionMatrix * mv;
      vUv = position.xy * 8.0; // in core radii
      vec3 haze = applyFog(vec3(1.0), p) - applyFog(vec3(0.0), p); // what of an added light gets through the fog and mist
      vCol = vec3(0.75, 1.0, 0.22) * a * uGain * haze * (0.6 + 0.4 * core / r) * smoothstep(0.6, 2.0, dist);
    }`,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vCol;
    void main() {
      float r = length(vUv);
      float glow = 3.0 * exp(-r * r * 1.4) + 0.12 * exp(-r * 1.1) * (1.0 - smoothstep(2.5, 4.0, r));
      gl_FragColor = vec4(vCol * glow, 1.0);
      #include <colorspace_fragment>
    }`,
});
const mesh = new THREE.Mesh(geo, mat);
mesh.frustumCulled = false; // placed in the shader
// the main view or the river's half-size mirror (river.js renderReflection): size the glow for the target it draws into
const size = new THREE.Vector2();
mesh.onBeforeRender = (renderer) => {
  const target = renderer.getRenderTarget(), pr = renderer.getPixelRatio();
  local.uHalfPx.value = (target ? target.height : renderer.getDrawingBufferSize(size).y) / 2;
  local.uMinPx.value = target ? Math.max(1.5, 1.4 * pr) : 1.4 * pr; // the mirror: at least 1.5 of its pixels (half-size ones)
  local.uGain.value = target ? 2 : 1; // the water dims and smears its mirror image: twice as bright there, so they still read
};
fireflyLayer.add(mesh);

let night = { from: Infinity, to: -Infinity, crowd: 0, shuffle: 0 };
function nightOf(t) { // the evening around scene time t (s): noon to noon
  const d = new Date(t * 1000);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  const from = d.getTime() / 1000, crowd = nightCrowd(d.getFullYear(), d.getMonth(), d.getDate());
  d.setDate(d.getDate() + 1);
  return { from, to: d.getTime() / 1000, crowd, shuffle: (crowd * 7.77) % 1 };
}
let calm = -1; // the wind limit, eased over ~8 s so a gust doesn't blink them all out at once

// sceneSeconds = the scene clock (s), hours = the scene's time of day (0..24), dt = real seconds
export function updateFireflies(sceneSeconds, hours, camera, dt) {
  if (sceneSeconds < night.from || sceneSeconds >= night.to) night = nightOf(sceneSeconds);
  const c = 1 - smoothstep(uniforms.uWindStrength.value, WIND[0], WIND[1]);
  calm = calm < 0 ? c : calm + (c - calm) * (1 - Math.exp(-dt / 8));
  // x1.5 or more = every home (x1: three quarters); 1 + FADE so the last ranks are fully out too
  const want = (1 + FADE) * (forced ? 1 : fireflyHours(hours) * night.crowd * calm * animals.back * Math.min(1, settings['life.fireflies'] * 0.75));
  // at most FADE per 5 s, so none pops; a jump of the scene clock (load, time slider, a hidden tab) just sets it
  const jump = density < 0 || Math.abs(sceneSeconds - last - dt) > 5;
  density = jump ? want : density + Math.min(FADE / 5 * dt, Math.max(-FADE / 5 * dt, want - density));
  last = sceneSeconds;
  local.uDensity.value = density;
  local.uNight.value = shuffle = night.shuffle;
  local.uClock.value = ((sceneSeconds % 3600) + 3600) % 3600;
  mesh.visible = density > 0.001;
}
