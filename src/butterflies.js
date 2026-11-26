import * as THREE from 'three';
import { mulberry32, hash, heightAt, riverZ, uniforms, glslCommon, EYE, WATER_Y } from './common.js';
import { animals, weather } from './weather.js';
import { plants, rocks } from './layout.js';
import { settings } from './settings.js';
import bellflower from './shapes/bellflower.js';
import stars from './shapes/stars.js';

// Butterflies by day around the flower clusters (docs/LIFE.md). Twelve lanes in pairs (even: the near meadow, odd: the
// far bank), each with its own hashed visits: a slot of 5-9 min of scene time holds at most one visit of 2-5 min (fly in
// from out of sight, wander between the flowers, land on a few, fly off out of sight), present when a hash beats the
// time of day x a 25 min "mood" (lively, quiet, none). The path is a pure function of the scene clock (dev views agree
// every run); only wind, rain, cloud and the Nature setting send them away, eased in real time. They are never drawn
// popping in or out: the ends of a path lie off the clock view's sides or far beyond the flowers, shrinking to nothing.
export const butterflyLayer = new THREE.Group();

const LANES = 12; // pairs: setting 1 lets 5 pairs in, 1.25 or more all 6
const MAXK = 160; // path knots per visit
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ihash = (a, b) => { let s = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35); s = Math.imul(s ^ (s >>> 13), 0x27d4eb2f); return (s ^ (s >>> 16)) >>> 0; };
const turn = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k; // angle lerp, the short way round
const noise1 = (x, seed) => { const i = Math.floor(x), f = x - i; return hash(i, seed) + (hash(i + 1, seed) - hash(i, seed)) * f * f * (3 - 2 * f); };

// ?butterflies (dev): every lane on a visit all slot long; ?butterflies=x,z homes them all on the cluster nearest (x, z)
const forcedParam = new URLSearchParams(globalThis.location?.search ?? '').get('butterflies');
const forcedAt = forcedParam?.split(',').map(Number);
export const force = { on: forcedParam !== null, at: forcedAt?.length === 2 && forcedAt.every(Number.isFinite) ? forcedAt : null };

// ---------- where: landing spots on the flowers, near meadow and far bank ----------
// On top of each plant's three highest flower cards (kind 2; lower ones hide among the cards in front), placed as tree.js
// modelMatrix places the model (same seed draws).
// shortcut: the spots don't follow the flowers' wind sway (a few cm at fair noon); fine at this size.
const unpack = (b64, T) => new T(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
const SHAPES = { bellflower, stars };
const isFar = (p) => p.z < riverZ(p.x); // across the river (60-110 m out)
const used = plants.filter((p) => SHAPES[p.type] && (isFar(p) || Math.hypot(p.x - EYE.x, p.z - EYE.z) < 27));
export const clusters = []; // { x, z, far, plants: [], spots: [] } plants within 4 m of each other
for (const p of used) {
  const shape = SHAPES[p.type], d = shape.cards, q = unpack(d.center, Uint16Array), rec = unpack(d.card, Uint8Array), b = d.box;
  const rand = mulberry32(p.seed); rand();
  const s = p.height / shape.height, ang = rand() * 2 * Math.PI, c = Math.cos(ang), sn = Math.sin(ang), y0 = heightAt(p.x, p.z) - 0.1 - 0.02 * p.height;
  const own = [];
  for (let i = 0; i < d.count; i++) {
    if (rec[i * 4 + 3] !== 2) continue;
    const [x, y, z] = [0, 1, 2].map((k) => b[k] + (q[i * 3 + k] / 65535) * (b[k + 3] - b[k]));
    own.push([p.x + s * (x * c + z * sn), y0 + s * y + 0.55 * (rec[i * 4] / 255) * d.size * s, p.z + s * (-x * sn + z * c)]);
  }
  own.sort((u, v) => v[1] - u[1]);
  const picked = [];
  for (const o of own) if (picked.length < 3 && picked.every((u) => Math.hypot(u[0] - o[0], u[2] - o[2]) > 0.25)) picked.push(o);
  let home = clusters.find((cl) => cl.plants.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 4));
  if (!home) clusters.push(home = { x: 0, z: 0, far: isFar(p), plants: [], spots: [] });
  home.plants.push(p);
  home.spots.push(...picked);
}
for (const cl of clusters) {
  cl.x = cl.plants.reduce((a, p) => a + p.x, 0) / cl.plants.length;
  cl.z = cl.plants.reduce((a, p) => a + p.z, 0) / cl.plants.length;
}
const pickHome = (r, far) => { // weighted by plant count, on one side of the river
  const side = clusters.filter((cl) => cl.far === far);
  let x = r * side.reduce((a, cl) => a + cl.plants.length, 0);
  for (const cl of side) if ((x -= cl.plants.length) < 0) return cl;
  return side[0];
};
const nearestHome = (x, z) => clusters.reduce((a, cl) => (Math.hypot(cl.x - x, cl.z - z) < Math.hypot(a.x - x, a.z - z) ? cl : a));

// ---------- when ----------
// Most from mid-morning to late afternoon (scene hours: 6 sunrise, 18 sunset), none at night.
const activity = (h) => smooth(7, 9, h) * (1 - smooth(16, 17.5, h));
const MOOD = 1500; // s: some of these quieter (half as likely), some lively
const CHANCE = 0.9; // per lane at a lively midday
const mood = (t) => 0.5 + 0.5 * ihash(991, Math.floor(t / MOOD)) / 2 ** 32;
// Species: wingspan (m; real 5-8 cm, half again larger so they read from the clock view; the shader grows them far away), flaps a second, chance
const SPECIES = [[0.12, 9, 0.35], [0.13, 8, 0.25], [0.11, 12, 0.2], [0.14, 10, 0.2]]; // white, sulphur, blue, orange

// One visit per lane slot: its window, species and path (knots: position, time, tangent; holds = landings).
const lanes = Array.from({ length: LANES }, (_, i) => ({
  i, slot: 300 + 23 * i, key: NaN, start: 0, end: 0, chance: 0, rank: 0, u: 0, species: 0, flap: 10, rest: 4, seed: 0,
  far: false, ux: 0, uz: 1, dHome: 0, entry: [0, 0, 0], span: 0, // home's side, the clock spot -> home direction and distance
  // knots: hold 1 = lands here, 2 = takes off here (both: zero tangent); yaw = its heading on the flower
  n: 0, P: new Float32Array(MAXK * 3), M: new Float32Array(MAXK * 3), T: new Float32Array(MAXK), hold: new Uint8Array(MAXK), yaw: new Float32Array(MAXK),
  exit: [0, 0, 0], seg: 0, away: 0, lastYaw: 0, visible: false, landed: false, x: 0, y: 0, z: 0,
}));

function plan(L, k) {
  const r = mulberry32(ihash(L.i * 7919 + 13, k)), slotStart = k * L.slot - L.i * 1013;
  const dur = force.on ? L.slot - 60 : Math.min(110 + 170 * r(), L.slot - 40); // the whole visit, flights in and out included
  L.key = k;
  L.start = force.on ? slotStart : slotStart + r() * (L.slot - dur - 40); // ends >= 20 s before the slot does (see below)
  const mid = L.start + dur / 2;
  L.chance = activity(hoursAt(mid)) * mood(mid) * CHANCE;
  const roll = r();
  L.chance = force.on ? 1 : L.chance > roll ? 1 : 0; // present or not, fixed for the whole visit
  L.rank = force.on ? 0 : r();
  L.u = r(); // where it stands among its pair's lanes for the setting (updateButterflies)
  let sp = 0; for (let x = r(); sp < 3 && (x -= SPECIES[sp][2]) > 0;) sp++;
  L.species = sp;
  L.flap = SPECIES[sp][1] * (0.9 + 0.2 * r());
  L.rest = 3 + 3 * r(); // s per slow open-close while landed
  L.seed = r() * 100;
  // the visit's home (near meadow on even lanes, far bank on odd): often the mood slot's favourite, so they gather
  const far = L.i % 2 === 1;
  const home = force.at ? nearestHome(force.at[0], force.at[1]) : r() < 0.6 ? pickHome(ihash(17 + L.i % 2, Math.floor(mid / MOOD)) / 2 ** 32, far) : pickHome(r(), far);
  const local = home.spots;
  L.far = home.far;
  const ex = home.x - EYE.x, ez = home.z - EYE.z;
  L.dHome = Math.hypot(ex, ez); L.ux = ex / L.dHome; L.uz = ez / L.dHome;
  // Ends out of sight: off the clock view's side, beside or a little behind the clock spot (78-104 deg from straight
  // ahead, past where the view can turn), or "away", 32-46 m on beyond the flowers, where it shrinks into the haze
  // (size in updateButterflies). Near-meadow visits mostly come and go sideways, far-bank ones mostly away; the rest
  // cross the river.
  const side = Math.sign(ex) || 1;
  const end = () => {
    let x, z;
    if ((r() < 0.3) !== L.far) {
      const a = Math.atan2(ez, ex) + (r() - 0.5) * 1.2, d = 32 + 14 * r();
      x = home.x + Math.cos(a) * d; z = home.z + Math.sin(a) * d;
    } else {
      const b = side * (1.36 + 0.45 * r()), d = 16 + 12 * r();
      x = EYE.x + Math.sin(b) * d; z = EYE.z - Math.cos(b) * d;
    }
    return [x, Math.max(heightAt(x, z), WATER_Y) + 1.2 + 1.2 * r(), z];
  };
  const knot = (p, t, isHold, yaw = 0) => { L.P.set(p, L.n * 3); L.T[L.n] = t; L.hold[L.n] = isHold; L.yaw[L.n] = yaw; L.n++; };
  L.n = 0;
  L.entry = end();
  L.exit = end();
  const outTime = (Math.hypot(L.exit[0] - home.x, L.exit[2] - home.z) + 5) / 3;
  knot(L.entry, 0, 0);
  let t = 0, last = L.entry, landings = 0;
  while (t < dur - outTime && L.n < MAXK - 3) { // overshoots by one hop or landing at most (< 25 s)
    let p, isHold = landings < 6 && r() < 0.32;
    if (isHold) p = local[Math.floor(r() * local.length)];
    else {
      const a = r() * 2 * Math.PI, d = 0.5 + 4 * r();
      p = [home.x + Math.cos(a) * d, 0, home.z + Math.sin(a) * d];
      const ex = p[0] - EYE.x, ez = p[2] - EYE.z, e = Math.hypot(ex, ez);
      if (e < 5) { p[0] = EYE.x + ex / e * 5; p[2] = EYE.z + ez / e * 5; } // keep off the lens
      p[1] = heightAt(p[0], p[2]) + 0.8 + 1.6 * r() ** 1.3; // over the grass tops (~1 m), up to 2.4 m
      for (const o of rocks) if (Math.hypot(o.x - p[0], o.z - p[2]) < o.size + 0.4) p[1] = Math.max(p[1], heightAt(o.x, o.z) + o.size * 1.3); // over, not into, a rock
      for (const o of home.plants) if (Math.hypot(o.x - p[0], o.z - p[2]) < 0.4 * o.height + 0.3) p[1] = Math.max(p[1], heightAt(o.x, o.z) + 0.9 * o.height + 0.15); // over the flowers
    }
    const dist = Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]);
    if (isHold && dist < 0.3) continue; // already there
    t += Math.max(1.2, dist / (L.n === 1 ? 3 : 1.1 + 0.9 * r()));
    if (isHold) { const yaw = r() * 2 * Math.PI; knot(p, t, 1, yaw); t += 4 + 10 * r(); knot(p, t, 2, yaw); landings++; } else knot(p, t, 0);
    last = p;
  }
  t += Math.hypot(L.exit[0] - last[0], L.exit[2] - last[2]) / 3;
  knot(L.exit, t, 0);
  L.end = L.start + t;
  // tangents: Catmull-Rom in time through the air knots, zero at landings (they ease in and out)
  const P = L.P, T = L.T, M = L.M;
  for (let j = 0; j < L.n; j++) {
    const a = Math.max(0, j - 1), b = Math.min(L.n - 1, j + 1);
    for (let c = 0; c < 3; c++) M[j * 3 + c] = L.hold[j] ? 0 : (P[b * 3 + c] - P[a * 3 + c]) / (T[b] - T[a]);
  }
  L.seg = 0;
}

// Hermite on the knots at visit time tau into pos, vel (m/s); wa, wb = easing out of a take-off / into a landing (0 on
// the flower .. 1 flying); returns how much it is flying (0 sitting on a flower)
const pos = new THREE.Vector3(), vel = new THREE.Vector3();
let wa = 1, wb = 1;
function evalPath(L, tau) {
  const T = L.T, P = L.P, M = L.M;
  tau = Math.min(Math.max(tau, 0), T[L.n - 1]);
  let j = L.seg;
  if (j >= L.n - 1 || tau < T[j]) j = 0;
  while (j < L.n - 2 && tau > T[j + 1]) j++;
  L.seg = j;
  const h = T[j + 1] - T[j], s = (tau - T[j]) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s, d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
  const a = j * 3, b = a + 3;
  for (let c = 0; c < 3; c++) {
    pos.setComponent(c, h00 * P[a + c] + h10 * h * M[a + c] + h01 * P[b + c] + h11 * h * M[b + c]);
    vel.setComponent(c, (d00 * P[a + c] + d10 * h * M[a + c] + d01 * P[b + c] + d11 * h * M[b + c]) / h);
  }
  if (L.hold[j] === 1) return (wa = wb = 0); // sitting on a flower
  const ease = Math.min(1, h * 0.5);
  wa = L.hold[j] === 2 ? smooth(0, ease, tau - T[j]) : 1;
  wb = L.hold[j + 1] === 1 ? smooth(0, ease, T[j + 1] - tau) : 1;
  return wa * wb;
}

// ---------- look: two wing cards hinged on a thin body ----------
// One instance per butterfly: position x = part (-1 left wing, 1 right wing, 0 body), y = out (0 body .. 1 wing tip;
// body: across), z = along (-1 tail .. 1 head).
const corners = [];
for (const part of [-1, 1, 0]) for (const [y, z] of [[part ? 0 : -1, -1], [1, -1], [1, 1], [part ? 0 : -1, 1]]) corners.push(part, y, z);
const geo = new THREE.InstancedBufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(LANES * 4), 4).setUsage(THREE.DynamicDrawUsage);
const poseAttr = new THREE.InstancedBufferAttribute(new Float32Array(LANES * 4), 4).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('aPos', posAttr); // xyz, yaw (heading: x = cos, z = sin)
geo.setAttribute('aPose', poseAttr); // wing angle (0 flat, pi/2 up and closed), pitch, species, wingspan (m)
geo.instanceCount = 0;

const col = (...c) => c.map((h) => new THREE.Color(h));
const mat = new THREE.ShaderMaterial({
  uniforms: {
    ...uniforms,
    // per species (white, sulphur, blue, orange): wing, markings, spots
    uWing: { value: col('#f6f3e8', '#f5e15a', '#86bdf0', '#f39233') },
    uMark: { value: col('#3b3a40', '#e0b52c', '#2c3f6e', '#3a2418') },
    uSpot: { value: col('#3b3a40', '#f08a2c', '#ffffff', '#fff3d6') },
  },
  transparent: true,
  side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
    attribute vec4 aPos;
    attribute vec4 aPose;
    varying vec3 vUv; // part, out, along (in half spans)
    varying vec3 vNormal; // wings: the upper side's normal
    varying vec3 vWorldPos;
    varying float vSpecies;
    void main() {
      float yaw = aPos.w, wing = aPose.x, pitch = aPose.y;
      vec3 f = vec3(cos(yaw) * cos(pitch), sin(pitch), sin(yaw) * cos(pitch)); // head
      vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0))), u = cross(r, f);
      // larger far away (2.8x at 22 m: ~8-12 px from the clock view instead of 3-4), as set close up (aPose.w: CPU size)
      float span = aPose.w * mix(1.0, 2.8, smoothstep(3.0, 22.0, distance(aPos.xyz, cameraPosition)));
      float W = span * 0.5, L = W * 0.9;
      vec3 p;
      if (position.x != 0.0) {
        vec3 o = r * position.x * cos(wing) + u * sin(wing); // out along the wing, hinged on the body
        p = aPos.xyz + o * position.y * W + f * position.z * L;
        vNormal = u * cos(wing) - r * position.x * sin(wing);
      } else { // body: a thin card along the head axis, turned to the camera
        vec3 side = normalize(cross(f, cameraPosition - aPos.xyz) + 1e-6);
        p = aPos.xyz + f * (position.z * 0.5 - 0.05) * L + side * position.y * span * 0.04;
        vNormal = u;
      }
      vUv = vec3(position.x, position.y, position.z * 0.9);
      vWorldPos = p;
      vSpecies = aPose.z;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    uniform vec3 uWing[4];
    uniform vec3 uMark[4];
    uniform vec3 uSpot[4];
    varying vec3 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    varying float vSpecies;
    // signed distance-ish to an ellipse (0 on the rim, -1 at the centre)
    float ell(vec2 q, vec2 c, vec2 ax, float a) {
      q -= c;
      q = mat2(cos(a), sin(a), -sin(a), cos(a)) * q;
      return length(q / ax) - 1.0;
    }
    void main() {
      int sp = int(vSpecies + 0.5);
      vec3 toCam = normalize(cameraPosition - vWorldPos);
      vec3 n = normalize(vNormal);
      float facing = dot(n, toCam);
      bool under = facing < 0.0 && vUv.x != 0.0; // the underside: paler, few markings
      n *= sign(facing + 1e-4);
      vec3 albedo;
      float e;
      if (vUv.x == 0.0) { // body: a capsule, dark
        e = length(vec2(vUv.y, max(abs(vUv.z) - 0.6, 0.0) / 0.3)) - 1.0;
        albedo = sp == 0 ? vec3(0.12, 0.12, 0.13) : vec3(0.05, 0.04, 0.035);
      } else {
        vec2 q = vUv.yz; // out, along (half spans)
        float fore = ell(q, vec2(0.48, 0.27), vec2(0.53, 0.25), -0.45); // forewing: long, swept forward to the tip
        float hind = ell(q, vec2(0.32, -0.27), vec2(0.36, 0.33), 0.3); // hindwing: round, behind
        e = min(fore, hind);
        albedo = uWing[sp];
        vec3 mark = uMark[sp], spot = uSpot[sp];
        float rim = e > -0.16 ? 1.0 : 0.0;
        if (sp == 0) { // white: dark forewing tip, a spot
          albedo = mix(albedo, mark, step(0.0, fore - hind) < 0.5 && q.x + q.y * 0.4 > 0.88 ? 1.0 : 0.0);
          albedo = mix(albedo, spot, step(length(q - vec2(0.52, 0.18)), 0.07));
        } else if (sp == 1) { // sulphur: an orange dot on each wing, a slightly deeper rim
          albedo = mix(albedo, mark, rim * 0.6);
          albedo = mix(albedo, spot, max(step(length(q - vec2(0.42, 0.24)), 0.055), step(length(q - vec2(0.34, -0.28)), 0.065)));
        } else if (sp == 2) { // blue: a dark rim with a white fringe
          albedo = mix(albedo, mark, rim);
          albedo = mix(albedo, spot, step(-0.05, e));
        } else { // orange: wide dark rim with pale dots, a few dark spots inside
          float band = e > -0.28 ? 1.0 : 0.0;
          albedo = mix(albedo, mark, band);
          float dots = step(abs(fract(atan(q.y, q.x) * 4.0) - 0.5), 0.2) * step(-0.18, e) * step(e, -0.08);
          albedo = mix(albedo, spot, dots * band);
          albedo = mix(albedo, mark, step(length(q - vec2(0.5, 0.2)), 0.06) + step(length(q - vec2(0.3, -0.18)), 0.05));
        }
        if (under) albedo = mix(uWing[sp], vec3(0.9, 0.88, 0.8), 0.35) * (0.95 - 0.15 * rim); // pale, faintly rimmed
      }
      float a = 1.0 - smoothstep(-fwidth(e), fwidth(e), e);
      if (a < 0.02) discard;
      float sh = shadowAt(vWorldPos);
      float lit = toon(dot(n, uSunDir), 0.3) * sh;
      vec3 c = albedo * mix(uShadeColor, uSunColor, lit);
      // light through the wing when the sun is behind it
      if (vUv.x != 0.0) c += albedo * uSunColor * 0.45 * max(0.0, -dot(n, uSunDir)) * sh;
      gl_FragColor = vec4(applyFog(c, vWorldPos), a);
      #include <colorspace_fragment>
    }`,
});
const mesh = new THREE.Mesh(geo, mat);
mesh.frustumCulled = false; // placed per instance
butterflyLayer.add(mesh);

// ---------- motion ----------
const tmp = new THREE.Vector3();
let now = 0, nowHours = 12, calm = null; // calm: the wind (m/s) over the last ~20 s, so a passing gust doesn't scatter them
const hoursAt = (s) => (((nowHours + (s - now) / 3600) % 24) + 24) % 24; // the time of day at scene time s

// sceneSeconds = the scene clock (s), hours = the scene's time of day (0..24), dt = real seconds
export function updateButterflies(sceneSeconds, hours, camera, dt) {
  const t = (now = sceneSeconds), first = calm === null;
  nowHours = hours;
  const s = uniforms.uWindStrength.value;
  calm = first ? s : calm + (s - calm) * (1 - Math.exp(-dt / 20));
  // who may stay: back after rain x calm (out between 5 and 9 m/s, gusts included, averaged over ~20 s) x bright (fewer
  // under a grey sky); each visit has a rank and leaves while this is below it, the shy ones first
  const cond = force.on ? 1 : animals.back * (1 - smooth(5, 9, calm)) * (1 - 0.4 * weather.dim);
  const admit = 5 * settings['life.butterflies']; // lane pairs the Nature setting lets in (0: none, 1: 5, 1.25+: all 6)
  const wind = uniforms.uWindDir.value, ws = Math.min(s, 7), cam = camera.position;
  let n = 0;
  for (const L of lanes) {
    const k = Math.floor((t + L.i * 1013) / L.slot);
    if (k !== L.key) plan(L, k);
    const inside = L.chance > 0 && t >= L.start && t <= L.end;
    const want = cond > L.rank && (force.on || (L.i >> 1) + L.u < admit) ? 0 : 1;
    L.visible = false;
    if (first || !inside) L.away = want;
    if (!inside) continue;
    const tau = t - L.start;
    let w = evalPath(L, tau);
    // away: 0 on its path .. 1 gone to its exit point; eased in real time at ~3 m/s (at least 6 s), set at once while
    // it isn't around
    const rate = Math.min(1 / 6, 3 / Math.max(1, Math.hypot(L.exit[0] - pos.x, L.exit[1] - pos.y, L.exit[2] - pos.z)));
    L.away += Math.sign(want - L.away) * Math.min(Math.abs(want - L.away), dt * rate);
    if (L.away >= 1) continue;
    const j = L.seg, landed = w === 0;
    // heading: along the path in the air, turning to / from a landing's own heading as it settles or takes off
    let yaw = Math.hypot(vel.x, vel.z) > 0.02 ? Math.atan2(vel.z, vel.x) : L.lastYaw;
    if (landed) yaw = L.yaw[j];
    else {
      if (L.hold[j + 1] === 1) yaw = turn(L.yaw[j + 1], yaw, wb);
      if (L.hold[j] === 2) yaw = turn(L.yaw[j], yaw, wa);
    }
    const pitch = (0.25 + 0.5 * Math.atan2(vel.y, Math.hypot(vel.x, vel.z) + 0.3)) * w + 0.05 * (1 - w);
    // fluttery: a wandering wobble, bobbing with the wing beats, gliding now and then, a sway downwind
    const glide = smooth(0.62, 0.8, noise1(tau * 0.7, L.seed)) * w;
    const phase = 2 * Math.PI * L.flap * tau, sway = ws * 0.1 * (0.7 + 0.3 * Math.sin(tau * 0.8 + L.seed));
    pos.x += (0.14 * (0.6 * Math.sin(1.9 * tau + L.seed) + 0.4 * Math.sin(3.3 * tau + 2 * L.seed)) + wind.x * sway) * w;
    pos.z += (0.14 * (0.6 * Math.sin(1.6 * tau + 3 * L.seed) + 0.4 * Math.sin(2.9 * tau + L.seed)) + wind.y * sway) * w;
    pos.y += (0.08 * Math.sin(1.3 * tau + 5 * L.seed) + 0.025 * Math.sin(phase - 1) * (1 - glide)) * w;
    // leaving (wind, rain, a grey sky): flies off toward its exit point, and back when it may
    if (L.away > 0) {
      const a = smooth(0, 1, L.away);
      tmp.fromArray(L.exit);
      yaw = turn(yaw, Math.atan2(tmp.z - pos.z, tmp.x - pos.x), Math.min(1, a * 4));
      pos.lerp(tmp, a);
      w = Math.max(w, Math.min(1, L.away * 5));
    }
    // 0.3-2.5 m above the ground or the river (the curves overshoot a little; a straight flight off may cross a rise)
    const g = Math.max(heightAt(pos.x, pos.z), WATER_Y);
    pos.y = Math.min(Math.max(pos.y, g + 0.3), g + 2.5);
    L.lastYaw = yaw;
    L.landed = w === 0;
    // never right in front of the lens: closer than 4 m it is pushed out softly (2 m at the least)
    tmp.subVectors(pos, cam);
    const d = tmp.length();
    if (d < 4 && !L.landed) pos.copy(cam).addScaledVector(tmp, (2 + (d * d) / 8) / Math.max(d, 1e-3));
    // size: up to 4.5x beyond 22 m (with the shader's 2.8x: ~16 px on the far bank instead of 2), down to a fifth once
    // 5-25 m on beyond its flowers (as seen from the clock spot: under a pixel there), and to nothing within 7 m of
    // either end of its path (~2 s), so it never pops in or out, wherever the ends lie
    const beyond = (pos.x - EYE.x) * L.ux + (pos.z - EYE.z) * L.uz - L.dHome;
    const ends = Math.min(Math.hypot(pos.x - L.entry[0], pos.y - L.entry[1], pos.z - L.entry[2]), Math.hypot(pos.x - L.exit[0], pos.y - L.exit[1], pos.z - L.exit[2]));
    const size = Math.min(4.5, Math.max(1, Math.hypot(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z) / 22)) * (1 - 0.8 * smooth(5, 25, beyond)) * smooth(1, 7, ends);
    if (size < 0.02) continue; // nothing to see
    L.visible = true;
    L.span = SPECIES[L.species][0] * size;
    // wings: beating (or held out in a glide) in the air, slowly opening and closing on a flower
    const beat = 0.45 + 0.85 * Math.sin(phase), rest = 0.15 + 1.3 * (0.5 - 0.5 * Math.cos((2 * Math.PI * tau) / L.rest)); // open flat .. closed upright
    const wing = rest + (beat + (0.3 - beat) * glide - rest) * w;
    L.x = pos.x; L.y = pos.y; L.z = pos.z;
    const p = posAttr.array, q = poseAttr.array, o = n * 4;
    p[o] = pos.x; p[o + 1] = pos.y; p[o + 2] = pos.z; p[o + 3] = yaw;
    q[o] = wing; q[o + 1] = pitch; q[o + 2] = L.species; q[o + 3] = L.span;
    n++;
  }
  geo.instanceCount = n;
  butterflyLayer.visible = n > 0;
  if (n) { posAttr.needsUpdate = true; poseAttr.needsUpdate = true; }
}

export { lanes }; // tools/butterflies-test.mjs
