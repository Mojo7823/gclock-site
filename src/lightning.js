import * as THREE from 'three';
import { mulberry32, uniforms, heightAt, DECK_BASE } from './common.js';
import { weather } from './weather.js';
import { sunDir } from './daycycle.js';
import { settings } from './settings.js';
import { stormCloudsAt } from './clouds.js';

// Lightning. Like the clouds, strikes are rebuilt from the scene clock (same storm for everyone at the
// same moment): time is cut into 1 s slots and each slot holds at most one strike. Only strikes whose
// window contains the current time are active, so a slider jump never replays the ones it skipped.
// A strike: a faint stepped leader flickering down (0.08-0.2 s), the bright return stroke, 1-4 restrikes down the same
// channel 35-135 ms apart, then the afterglow of the last one (continuing current). Every strike comes out of a cloud
// that is there at that moment (clouds.js stormCloudsAt), or out of the sheet when the sheet is all there is.
const TAIL = 0.7; // s after the last stroke (afterglow; keeps every strike inside its slot + 2.1 s)
const HOLD = 0.04, DECAY = 0.06, GLOW = 0.22; // stroke: full for HOLD (>= 2 frames at 60 fps), then decays (s); the last one glows longer
const VIEW_AZ = Math.atan2(1.5, -15); // the default camera at (0, 1.5, 11) looks this way
const SHEET_Y = DECK_BASE + 14; // a strike out of the sheet starts in it, above its swelling base
const azOff = (x, z) => Math.abs(Math.atan2(Math.sin(Math.atan2(x, z - 11) - VIEW_AZ), Math.cos(Math.atan2(x, z - 11) - VIEW_AZ)));

// The cloud a strike comes out of, picked by u (0..1) from the storm clouds alive at time t: 45% of the time from the
// clouds within 300 m (when there are any: far clouds outnumber them), else from all; towers 2x as often as the lumpy
// layer, clouds in the default view 4x (so strikes are seen). Not out of a cloud whose base is above ~28° from the eye
// (in the default view the bolt would hang from the top of the frame, its cloud out of sight), not out of a cloud still
// forming or evaporating.
const NEAR = 300;
function sourceCloud(t, u) {
  const list = stormCloudsAt(t);
  let all = 0, near = 0;
  for (const c of list) {
    const d = (c.d = Math.hypot(c.x, c.z - 11));
    c.w = c.growth < 0.5 || d < Math.max(40 + 0.2 * c.W, 1.9 * (c.y - 4.5)) || d > 800 ? 0 : c.growth * (c.name === 'cb' ? 2 : 1) * (azOff(c.x, c.z) < 0.7 ? 4 : 1) / (1 + d / 300);
    all += c.w;
    if (d < NEAR) near += c.w;
  }
  const close = u < 0.45 && near > 0, sum = close ? near : all;
  u = u < 0.45 ? u / 0.45 : (u - 0.45) / 0.55;
  for (const c of list) if (c.w > 0 && (!close || c.d < NEAR) && (u -= c.w / sum) <= 0) return c;
  return null;
}
const FLASH = new THREE.Color(0.75, 0.82, 1); // bluish white
const forceEvery = Number(new URLSearchParams(location.search).get('bolt')) || 0; // dev: ?bolt=N forces a strike every N s

export function strikeAt(slot) { // (exported for tools/sound-test.mjs)
  const rand = mulberry32(slot * 7907 + 4231);
  // fixed draw order: reordering or adding rand() calls changes every storm (last changed 2026-10-25: strikes come out
  // of real clouds)
  const r = rand();
  if (!(forceEvery ? slot % forceEvery === 0 : r < (weather.bolt * settings['often.thunder']) / 60)) return null;
  const start = slot + 0.25 + 0.6 * rand(); // the return stroke; its leader starts in this slot too
  const pick = rand(), oa = rand() * Math.PI * 2, or = Math.sqrt(rand()), hy = rand(), la = rand() * Math.PI * 2, lr = rand(), g = rand();
  const c = sourceCloud(start, pick);
  let x, z, y, ly, R, ground;
  if (c) {
    // origin inside the cloud's footprint, the channel from its flat base (a flash in the cloud: inside it), the cloud lit
    // from inside around it
    x = c.x + Math.cos(oa) * or * 0.25 * c.W; z = c.z + Math.sin(oa) * or * 0.25 * c.W;
    // cloud-to-ground bolt, else an intra-cloud flash: far towers mostly flash inside (their low bases hide a bolt
    // behind the hills; the lit tower is what shows)
    ground = g < (c.d < 350 ? 0.65 : 0.3);
    y = ground ? c.y + 2 : c.y + c.H * (c.name === 'cb' ? 0.2 + 0.4 * hy : 0.5);
    ly = c.y + c.H * (c.name === 'cb' ? 0.3 : 0.5);
    R = Math.max(0.6 * c.W, 0.5 * c.H);
  } else {
    if (weather.layer < 0.6) return null; // no cloud and no sheet: no bolt out of a clear sky
    // only the sheet: anywhere under it, from its base
    const az = VIEW_AZ + (oa - Math.PI) * (pick < 0.5 ? 0.18 : 1), dist = 80 + 500 * or * or;
    x = Math.sin(az) * dist; z = 11 + Math.cos(az) * dist;
    ground = g < 0.5;
    y = ly = SHEET_Y;
    R = 150;
  }
  // a ground bolt leans a little on its way down
  const gx = ground ? x + Math.cos(la) * lr * 0.15 * y : x, gz = ground ? z + Math.sin(la) * lr * 0.15 * y : z;
  const seed = (rand() * 2 ** 32) >>> 0; // bolt shape (own RNG, so the shape can change freely)
  const leader = 0.08 + 0.12 * rand(), steps = 4 + Math.floor(rand() * 3);
  const pulses = [];
  for (let i = 0; i < steps; i++) pulses.push({ t: start - leader * (1 - i / steps), a: 0.05 + 0.08 * (i / steps) * rand(), d: 0.012 });
  pulses.push({ t: start, a: 1, d: DECAY });
  for (let i = 1 + Math.floor(rand() * 4), t = start; i > 0; i--) pulses.push({ t: (t += 0.035 + 0.1 * rand()), a: 0.4 + 0.5 * rand(), d: DECAY });
  pulses.at(-1).d = GLOW;
  // x, z = where it ends (the ground point, or the flash itself), tx, y, tz = the channel's top, (tx, ly, tz) and R = the
  // light inside the cloud and its radius; cloud = the key of the cloud it comes out of (null: the sheet)
  return { slot, start, lead: start - leader, end: pulses.at(-1).t + TAIL, x: gx, z: gz, tx: x, y, tz: z, ly, R, ground, pulses, seed, cloud: c?.key ?? null };
}

function envelope(s, t) {
  let e = 0;
  for (const p of s.pulses) {
    const x = t - p.t;
    if (x >= 0) e = Math.max(e, p.a * (x < HOLD ? 1 : Math.exp(-(x - HOLD) / p.d)));
  }
  return e;
}

// Bolt: camera-facing ribbon strips (expanded in the vertex shader), white core, blue-violet glow.
const MAX_PTS = 400;
const geo = new THREE.BufferGeometry();
const attr = (size) => new THREE.BufferAttribute(new Float32Array(MAX_PTS * 2 * size), size).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', attr(3));
geo.setAttribute('aDir', attr(3));
geo.setAttribute('aInfo', attr(4));
geo.setIndex(new THREE.BufferAttribute(new Uint16Array(MAX_PTS * 6), 1));

const mat = new THREE.ShaderMaterial({
  uniforms: { uBolt: { value: 0 }, uBranch: { value: 0 }, uCut: { value: -1e4 } },
  vertexShader: /* glsl */ `
    attribute vec3 aDir;
    attribute vec4 aInfo; // side (+-1), half width, brightness along the line, 1 = branch
    varying vec3 vInfo;
    varying float vY;
    void main() {
      vY = position.y;
      vec3 toCam = cameraPosition - position; // positions are world space (the layer sits at the origin)
      // width grows with distance: the channel keeps about the same pixel width near and far
      vec3 side = normalize(cross(aDir, toCam)) * aInfo.x * aInfo.y * length(toCam) * 0.012;
      vInfo = aInfo.xzw;
      gl_Position = projectionMatrix * viewMatrix * vec4(position + side, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uBolt, uBranch, uCut;
    varying vec3 vInfo;
    varying float vY;
    void main() {
      if (vY < uCut) discard; // the leader has not reached down here yet
      float u = abs(vInfo.x);
      float core = 1.0 - smoothstep(0.1, 0.2, u);
      float glow = pow(1.0 - u, 3.0);
      vec3 col = (vec3(1.0) * core + vec3(0.45, 0.4, 1.0) * glow) * vInfo.y * mix(uBolt, uBranch, vInfo.z);
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false, // hills and trees in front still hide it (depth test stays on)
});
const bolt = new THREE.Mesh(geo, mat);
bolt.frustumCulled = false;
bolt.renderOrder = 4; // after the clouds (3): the bolt shows in front of the sky
bolt.visible = false;
export const lightningLayer = new THREE.Group().add(bolt);

// Jagged line from a to b: midpoint displacement, 2^levels segments.
function jag(a, b, levels, rand) {
  let pts = [a, b];
  for (let l = 0; l < levels; l++) {
    const next = [a];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], len = p.distanceTo(q);
      const mid = new THREE.Vector3().lerpVectors(p, q, 0.5);
      mid.x += (rand() - 0.5) * len * 0.45; mid.y += (rand() - 0.5) * len * 0.15; mid.z += (rand() - 0.5) * len * 0.45;
      next.push(mid, q);
    }
    pts = next;
  }
  return pts;
}

let built = null; // slot of the strike currently in the geometry

function build(s) {
  const rand = mulberry32(s.seed);
  const gy = heightAt(s.x, s.z);
  const main = jag(new THREE.Vector3(s.tx, s.y, s.tz), new THREE.Vector3(s.x, gy, s.z), 5, rand);
  const lines = [{ pts: main, w0: 1, w1: 0.8, branch: 0 }];
  const fork = (from, depth) => {
    const p = from[Math.floor((0.1 + 0.6 * rand()) * (from.length - 1))];
    const len = (p.y - gy) * (0.2 + 0.3 * rand()), a = rand() * Math.PI * 2;
    const pts = jag(p, new THREE.Vector3(p.x + Math.cos(a) * len * 0.7, p.y - len, p.z + Math.sin(a) * len * 0.7), depth, rand);
    lines.push({ pts, w0: depth === 4 ? 0.6 : 0.4, w1: 0.1, branch: 1 });
    return pts;
  };
  for (let i = 3 + Math.floor(rand() * 4); i > 0; i--) {
    const b = fork(main, 4);
    if (rand() < 0.5) fork(b, 3);
  }

  const pos = geo.attributes.position.array, dir = geo.attributes.aDir.array, info = geo.attributes.aInfo.array, idx = geo.index.array;
  let v = 0, k = 0;
  for (const { pts, w0, w1, branch } of lines) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1), prev = pts[Math.max(i - 1, 0)], next = pts[Math.min(i + 1, n - 1)];
      const bright = branch ? 1 - 0.6 * f : THREE.MathUtils.smoothstep(f, 0, 0.12); // main channel emerges from the cloud base
      if (i < n - 1) { idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], k); k += 6; }
      for (const side of [-1, 1]) {
        pos.set([pts[i].x, pts[i].y, pts[i].z], v * 3);
        dir.set([next.x - prev.x, next.y - prev.y, next.z - prev.z], v * 3);
        info.set([side, w0 + (w1 - w0) * f, bright, branch], v * 4);
        v++;
      }
    }
  }
  for (const name of ['position', 'aDir', 'aInfo']) geo.attributes[name].needsUpdate = true;
  geo.index.needsUpdate = true;
  geo.setDrawRange(0, k);
  built = s.slot;
}

const listeners = [];
const fired = new Set(); // slots whose onStrike already ran (or that were missed: no thunder without its flash)
let lastT = null;
const tmp = new THREE.Color();

// Thunder hook (audio.js): cb({ start, distance, type }) runs once per strike, in the frame that shows its return
// stroke or a restrike (uFlash > 0.3 is already set), never for a strike whose flash was not drawn (slider jump,
// hidden tab). type 'ground' | 'cloud'; distance in scene metres from the camera to the nearest part of the channel.
export function onStrike(cb) { listeners.push(cb); }

// t = scene time (s), camera, dt = real seconds since the last frame. Runs after setTime/updateClouds.
export function updateLightning(t, camera, dt) {
  const slot = Math.floor(t);
  for (const s of fired) if (Math.abs(s - slot) > 2) fired.delete(s);
  // slider jump (not real time): no flash and no thunder for strikes we landed in, or dragging strobes
  const jumped = lastT !== null && Math.abs(t - lastT - dt) > 1;
  lastT = t;
  if (jumped) {
    fired.add(slot - 2); fired.add(slot - 1); fired.add(slot);
    uniforms.uFlash.value = 0;
    uniforms.uFlashLight.value.set(0, 0, 100, 0);
    bolt.visible = false;
    return;
  }
  // shortcut: only the brightest active strike lights the scene and is drawn (overlaps are rare at
  // ~4/min); keep a list if storms get much denser.
  let best = null, env = 0, dist = 0, thunder = null;
  for (const k of [slot - 2, slot - 1, slot]) { // a strike ends by its slot + 2.1 s
    const s = strikeAt(k);
    if (!s || t < s.lead || t > s.end) continue;
    // nearest part of the channel: a ground bolt runs from the deck down to the ground, an intra-cloud flash stays up there
    const cx = camera.position.x - s.x, cz = camera.position.z - s.z;
    const d = s.ground ? Math.hypot(cx, cz) : Math.hypot(cx, camera.position.y - s.y, cz);
    const e = envelope(s, t);
    if (!fired.has(k) && t >= s.start && e > 0.3) { fired.add(k); thunder = { start: s.start, distance: d, type: s.ground ? 'ground' : 'cloud' }; }
    if (e >= env) { best = s; env = e; dist = d; }
  }
  uniforms.uFlash.value = env;
  uniforms.uFlashLight.value.set(0, 0, 100, 0);
  bolt.visible = !!best && best.ground && env > 0.02;
  if (best) {
    uniforms.uFlashPos.value.set(best.tx, best.ly, best.tz); // the light inside its cloud
    // Flash on the scene, seen from any direction, day or night: the deck scatters it over the whole sky, the haze
    // and the land light up, less for far strikes (never under 35%, so a far one behind you still flashes).
    // setTime rewrote these colours this frame, so adding does not accumulate.
    // shortcut: the flash brightens the existing light (sun/moon direction) instead of lighting from the
    // strike; give it its own light direction if close strikes need to cast their own shading.
    // daylight already lights the sky and the meadow: a smaller step there, still visible (a full one turned the day sunny)
    const day = THREE.MathUtils.smoothstep(sunDir.y, 0, 0.3);
    // by day a higher floor for far strikes: at 35% a far in-cloud flash brightened the screen only ~6% before its thunder
    const near = env * THREE.MathUtils.clamp((250 / dist) ** 0.7, 0.35 + 0.3 * day, 1) * (best.ground ? 1 : 0.7);
    const sky = near * (1 - 0.5 * day), ground = near * (1 - 0.7 * day);
    uniforms.uFlashLight.value.set(sky, best.ground && t >= best.start ? env * (1 - 0.5 * day) : 0, best.R, best.cloud ? 0 : 1);
    uniforms.uSunColor.value.add(tmp.copy(FLASH).multiplyScalar(0.75 * ground));
    uniforms.uShadeColor.value.add(tmp.copy(FLASH).multiplyScalar(0.6 * ground));
    uniforms.uFogColor.value.add(tmp.copy(FLASH).multiplyScalar(0.35 * sky)); // the rain haze and the horizon glow
    uniforms.uZenithColor.value.add(tmp.copy(FLASH).multiplyScalar(0.25 * sky));
  }
  if (bolt.visible) {
    if (built !== best.slot) build(best);
    const haze = 1 - 0.5 * THREE.MathUtils.smoothstep(dist, 150, 700); // rain haze dims far bolts
    const leading = t < best.start, gy = heightAt(best.x, best.z);
    // the leader: a faint flickering tip stepping down from the cloud, branches and all
    mat.uniforms.uCut.value = leading ? best.y - (best.y - gy) * ((t - best.lead) / (best.start - best.lead)) : -1e4;
    mat.uniforms.uBolt.value = (leading ? 0.25 + 2 * env : env) * haze;
    // branches show in the return stroke; restrikes re-light the main channel
    mat.uniforms.uBranch.value = mat.uniforms.uBolt.value * (t < best.start + HOLD + DECAY ? 1 : 0.3);
  }
  if (thunder) for (const cb of listeners) cb(thunder); // after uFlash is set: tests read it here
}
