import * as THREE from 'three';
import { mulberry32, uniforms, glslCommon, MOUNTAIN, EYE_Y } from './common.js';
import { weather } from './weather.js';
import { beginBlobs, addBlob, updateVolume, volumeLayer, mapsDue } from './cloudvolume.js';

// See docs/CLOUDS.md. Where the clouds are: cumulus, stratocumulus, cumulonimbus, fractus and horizon banks, each a
// cluster of round puffs, rebuilt on the CPU every other frame from the scene time, so the sky is the same for everyone at
// the same moment and the time slider fast-forwards it. The puffs go to cloudvolume.js as blobs of a density field
// that is ray-marched (light passing through, self-shadowing, cloud-shaped shadows and god rays); the cap on the
// summit and the sheet deck live there too. Cirrus, the far end of the deck and far clouds are drawn on a sky dome.

const AREA = { x0: -750, x1: 750, z0: -850, z1: 400 }; // where clouds live, around the camera
const FADE = [650, 850]; // horizontal distance from the camera where clouds fade out

const { smoothstep } = THREE.MathUtils;
const pick = (r, t) => r[0] + (r[1] - r[0]) * t;
// Per-frame code avoids Math.hypot (it boxes its arguments: ~4 MB/s of garbage at 60 fps); this one inlines.
const hypot = (x, y, z = 0) => Math.sqrt(x * x + y * y + z * z);

// ---------- puff layouts (cloud-local metres, base at y = 0) ----------
// th = growth threshold: core and bottom puffs condense first, edges and tops last; they evaporate in the reverse
// order. k = height / width of the puff (flat cells and anvils are oblate). own = the puff keeps its own rounded
// bottom instead of reaching down to the cloud's flat base (the anvil's overhang, cloudlets torn off the side).
function addPuff(list, x, y, z, r, W, H, rand, k = 1) {
  const d = Math.hypot(x, z) / (W / 2), hf = Math.min(1, y / H);
  list.push({ x, y, z, r, k, th: Math.min(1, 0.5 * d + 0.3 * hf + 0.2 * rand()) });
}

// Small cloudlets torn off around a cloud: they condense last and evaporate first.
function cloudlets(list, rand, W, H, n) {
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, d = W * (0.5 + 0.3 * rand()), r = W * (0.035 + 0.04 * rand());
    const x = Math.cos(a) * d, y = H * (0.1 + 0.45 * rand()), z = Math.sin(a) * d * 0.6;
    list.push({ x, y, z, r, k: 0.8, th: 0.7 + 0.3 * rand(), own: true });
  }
}

// Broad flat base on the condensation level, with 2-4 stacked turrets rising out of it.
function cumulus(rand, W) {
  const H = W * (0.4 + 0.3 * rand()), list = [];
  for (let i = 0, n = Math.round(4 + W / 14); i < n; i++) {
    const a = rand() * Math.PI * 2, u = Math.sqrt(rand()), r = W * (0.15 + 0.05 * rand());
    addPuff(list, Math.cos(a) * u * W * 0.36, r * 0.45, Math.sin(a) * u * W * 0.22, r, W, H, rand, 0.8);
  }
  for (let t = 0, nt = 2 + Math.floor(rand() * 3); t < nt; t++) {
    const tx = (rand() - 0.5) * W * 0.55, tz = (rand() - 0.5) * W * 0.24;
    const top = H * (1 - 1.1 * Math.abs(tx) / W - (t ? 0.3 * rand() : 0)); // the first turret is the tallest; ones away from the middle are lower
    let r = W * (0.16 + 0.03 * rand());
    for (let y = r * 0.9; y < top - r * 0.6; y += r * 0.75, r *= 0.88) {
      addPuff(list, tx + (rand() - 0.5) * r * 0.6, y, tz + (rand() - 0.5) * r * 0.6, r, W, H, rand);
    }
  }
  cloudlets(list, rand, W, H, Math.floor(rand() * 7));
  return { list, H, flat: true };
}

// Wide lumpy layer: cells scattered round a grid (jittered up to ±40% of the spacing: a straighter grid lined up into
// rows, read edge-on as stripes), uneven sizes, heights and flatness (a level row of like lenses also read edge-on as
// stripes), small gaps between them, most with a lump on top.
function stratocumulus(rand, W) {
  const H = W * 0.12, list = [], s = W * 0.15;
  for (let gx = -0.5; gx <= 0.5; gx += s / W) {
    for (let gz = -0.32; gz <= 0.32; gz += s / W) {
      const x = gx * W + (rand() - 0.5) * 0.8 * s, z = gz * W + (rand() - 0.5) * 0.8 * s, r = s * (0.4 + 0.5 * rand());
      if ((x / (W * 0.5)) ** 2 + (z / (W * 0.32)) ** 2 > 1 || rand() < 0.15) continue; // elliptic patch with a few holes
      addPuff(list, x, r * (0.2 + 0.5 * rand()), z, r, W, H, rand, 0.45 + 0.4 * rand());
      if (rand() < 0.7) addPuff(list, x + (rand() - 0.5) * r, r * (0.6 + 0.5 * rand()), z + (rand() - 0.5) * r * 0.6, r * (0.5 + 0.3 * rand()), W, H, rand, 0.8);
    }
  }
  return { list, H, flat: true };
}

// Storm tower: broad base, stacked body narrowing slowly with bulges, and a wide anvil sheared downwind (+x, the
// cloud faces the wind) hanging over the land.
function cumulonimbus(rand, W) {
  const H = W * 1.35, list = [];
  for (let y = 0, k = 0; y < H * 0.78; k++) {
    const f = y / H, r = W * (0.21 - 0.06 * f);
    for (let j = 0, n = k ? 4 : 7; j < n; j++) {
      const a = rand() * Math.PI * 2, u = (k ? 0.32 : 0.55) * (0.5 + 0.5 * rand());
      addPuff(list, Math.cos(a) * u * W * (1 - 0.3 * f), y + r * 0.6, Math.sin(a) * u * W * 0.8 * (1 - 0.3 * f), r * (0.85 + 0.3 * rand()), W, H, rand);
    }
    y += r * 0.85;
  }
  for (let i = 0; i < 26; i++) {
    const t = rand(), r = W * (0.12 + 0.05 * rand()) * (1 - 0.3 * t); // t: 0 above the tower .. 1 far downwind
    addPuff(list, W * (-0.3 + 1.6 * t), H * (0.88 + 0.04 * rand()) - t * W * 0.06, (rand() - 0.5) * W * (0.7 + 0.9 * t), r, W, H, rand, 0.45);
    list[list.length - 1].own = true;
  }
  return { list, H, flat: true };
}

// Ragged scud: small torn lobes, no flat base.
function fractus(rand, W) {
  const H = W * 0.2, list = [];
  for (let i = 0, n = Math.round(8 + W / 8); i < n; i++) {
    addPuff(list, (rand() - 0.5) * W * 0.9, rand() * H, (rand() - 0.5) * W * 0.5, W * (0.08 + 0.1 * rand()), W, H, rand, 0.6);
  }
  return { list, H, flat: false };
}

// Horizon bank: a long row of cumulus mounds on one flat base, tallest in the middle, lying across the view
// (along the wind) 550+ m out, just above the hills, its base melting into the haze.
function bank(rand, W) {
  const H = W * (0.22 + 0.14 * rand()), list = [], nm = 4 + Math.floor(rand() * 4);
  for (let m = 0; m < nm; m++) {
    const f = m / (nm - 1) - 0.5, mx = f * W * 0.85 + (rand() - 0.5) * W * 0.06, mz = (rand() - 0.5) * W * 0.12;
    const top = H * (0.45 + 0.55 * rand()) * (1 - 1.2 * f * f);
    let r = W * (0.075 + 0.03 * rand());
    for (let y = r * 0.45; y < top - r * 0.3; y += r * 0.8, r *= 0.86) {
      addPuff(list, mx + (rand() - 0.5) * r * 0.8, y, mz + (rand() - 0.5) * r * 0.6, r, W, H, rand);
    }
  }
  return { list, H, flat: true };
}

// slot = seconds between candidate clouds of this type; life (s), width (m), alt = base height (m): one
// condensation level per type, so bases line up with a little jitter; speed (m/s along the cloud's heading; this sky
// is ~1/15 scale, so real ~10 m/s drift is ~0.6 m/s here), opacity = coverage of a grown puff (thin types let the sun
// through), dark = [base greyness, how much weather.dark adds], near = towers and banks evaporate nearer than this
// to the view (m, plus 0.4 × their width), layer = which weather map (1: the stratocumulus layer, 2: scud; apart from
// the heap clouds, so one over another never merges with it into one column), fade = horizontal distance where the
// type fades out (default FADE).
const TYPES = {
  cu: { slot: 24, life: [1500, 3200], width: [40, 100], alt: [60, 66], speed: 0.6, opacity: 0.95, dark: [0, 0.6], build: cumulus },
  sc: { slot: 44, life: [2400, 4200], width: [140, 260], alt: [86, 94], speed: 0.5, opacity: 0.85, dark: [0.1, 0.55], layer: 1, build: stratocumulus },
  cb: { slot: 300, life: [3600, 6000], width: [100, 150], alt: [48, 54], speed: 0.4, opacity: 1, dark: [0.3, 0.6], near: 160, build: cumulonimbus },
  fr: { slot: 20, life: [900, 1800], width: [30, 70], alt: [38, 50], speed: 1, opacity: 0.7, dark: [0.05, 0.8], layer: 2, build: fractus },
  bk: { slot: 100, life: [2400, 4800], width: [150, 300], alt: [50, 64], speed: 0.25, opacity: 0.95, dark: [0, 0.6], near: 470, fade: [900, 1100], build: bank },
};
// The clock's camera: towers and banks keep their distance from it, the cap cloud stays in sight from it.
const VIEW = { x: 0, z: 11 };
const TYPE_SEED = { cu: 11, sc: 23, cb: 37, fr: 51, bk: 67 };

// Cover per type for this hour: fair-weather cumulus build up by day (convection) and mostly
// vanish at night; low wisps rise from the morning mist; banks lie on the horizon whenever there is cumulus
// or a lumpy layer about, a few also on clear mornings; a sheet hides most of them.
function coverAt(h) {
  const day = smoothstep(h, 7.5, 11) * (1 - smoothstep(h, 17, 20.5));
  const morning = smoothstep(h, 5.5, 7) * (1 - smoothstep(h, 8.5, 10.5));
  const bk = (Math.min(1, 0.8 * weather.cu + 0.4 * weather.sc) * (0.45 + 0.55 * Math.max(day, morning)) + 0.15 * morning) * (1 - 0.7 * weather.layer);
  return { cu: weather.cu * (0.3 + 0.7 * day), sc: weather.sc, cb: weather.cb, fr: Math.max(weather.fr, 0.35 * morning), bk };
}

// Cloud base drifts with the hour: cumulus bases (and the banks) rise as the day warms; scud sits low before
// the morning mist lifts.
function altShift(name, h) {
  if (name === 'cu') return 30 * smoothstep(h, 9, 15);
  if (name === 'bk') return 14 * smoothstep(h, 8, 15);
  if (name === 'fr') return -22 * (1 - smoothstep(h, 6.5, 10.5));
  return 0;
}

// mulberry32 (common.js) reseeded per cloud candidate instead of a new closure per candidate per frame (same numbers);
// the state sits in an Int32Array because a plain variable is boxed once it leaves the small-integer range.
const slot = new Int32Array(1);
function slotRand() {
  const s = (slot[0] = (slot[0] + 0x6d2b79f5) | 0);
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Every cloud alive at scene time t (seconds), fully determined by t: one candidate per type per slot.
// A candidate exists if its random draw is under the cover, and fades in/out as the cover moves past
// it, so weather changes make clouds condense or evaporate instead of popping.
// Each cloud keeps the heading (uWindDir) it had when it first showed up: when the wind turns, the clouds aloft keep
// going and the new ones come in on the new wind, so nothing jumps. (So a load, or a jump of the time slider, puts
// every cloud on the wind of that moment: the same picture for the same time and wind.)
const NAMES = Object.keys(TYPES), headings = new Map();
function cloudsAt(t, h, names = NAMES) {
  const out = [], cover = coverAt(h), wind = uniforms.uWindDir.value, rand = slotRand;
  for (const name of names) {
    const T = TYPES[name];
    if (cover[name] < 0.001) continue;
    for (let k = Math.floor((t - T.life[1]) / T.slot), k1 = Math.floor(t / T.slot); k <= k1; k++) {
      slot[0] = k * 7919 + TYPE_SEED[name];
      const r = rand(), vis = smoothstep(cover[name], r - 0.04, r + 0.04);
      const birth = (k + rand()) * T.slot, life = pick(T.life, rand());
      const W = pick(T.width, rand()), alt = pick(T.alt, rand()), px = rand(), pz = rand(), seed = (rand() * 2 ** 32) >>> 0;
      const age = t - birth;
      if (vis <= 0 || age < 0 || age > life) continue;
      const u = age / life, growth = vis * smoothstep(u, 0, 0.3) * (1 - smoothstep(u, 0.65, 1));
      if (growth < 0.01) continue;
      // start upwind so the cloud crosses the area around mid-life; paths are spread evenly over the area, so clouds
      // pass overhead, to the sides and in front alike
      const drift = T.speed * (age - life / 2), key = name + k;
      let hd = headings.get(key);
      if (!hd) headings.set(key, (hd = [wind.x, wind.y, 0]));
      hd[2] = frameNo;
      const x0 = AREA.x0 + (AREA.x1 - AREA.x0) * px, z0 = AREA.z0 + (AREA.z1 - AREA.z0) * pz;
      const x = x0 + hd[0] * drift, z = z0 + hd[1] * drift, y = alt + altShift(name, h);
      // towers and banks read best out on the horizon: one drifting nearer than `near` evaporates, edges first
      const away = T.near ? smoothstep(hypot(x - VIEW.x, z - VIEW.z), 0.7 * (T.near + 0.4 * W), T.near + 0.4 * W) : 1;
      out.push({
        key, name, T, W, seed, hd, growth: growth * away * capClear(x, y + W * 0.25, z, W), x, z, y, x0, z0,
        dark: Math.min(0.95, T.dark[0] + T.dark[1] * weather.dark),
      });
    }
  }
  return out;
}

// The cap cloud on the summit stays in sight from the clock view: a cloud nearer than the summit evaporates
// (edges first, like any cloud) while it passes in front of it, and condenses again beyond. Clouds lower than the
// summit clear the peak's body too (dark storm clouds at the sky's brightness erased it).
const CAP_DIR = new THREE.Vector3(MOUNTAIN.x - VIEW.x, MOUNTAIN.y - 19 - EYE_Y, MOUNTAIN.z - VIEW.z), CAP_DIST = CAP_DIR.length();
CAP_DIR.normalize();
const CAP_ANGLE = 0.1; // angular radius of the crown seen from the view (rad); 0.16 kept the whole sky above the summit empty
function capClear(x, y, z, W) {
  const dx = x - VIEW.x, dy = y - EYE_Y, dz = z - VIEW.z, d = hypot(dx, dy, dz);
  if (d > CAP_DIST) return 1;
  const angle = Math.acos(Math.min(1, (dx * CAP_DIR.x + dy * CAP_DIR.y + dz * CAP_DIR.z) / d)), keep = (y < MOUNTAIN.y ? 0.22 : CAP_ANGLE) + Math.atan(0.5 * W / d);
  return smoothstep(angle, keep * 0.8, keep * 1.2);
}

// Layout cache: built the first time a cloud shows up, dropped when it is gone.
const layouts = new Map();
function layoutOf(c) {
  let L = layouts.get(c.key);
  if (L) return L;
  const rand = mulberry32(c.seed);
  L = c.T.build(rand, c.W);
  // anvils point down the cloud's wind, banks lie across the line of sight from the view (at mid-life), the rest at random
  const yaw = c.name === 'cb' ? -Math.atan2(c.hd[1], c.hd[0]) : c.name === 'bk' ? Math.atan2(c.x0 - VIEW.x, VIEW.z - c.z0) : rand() * Math.PI * 2;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  for (const p of L.list) {
    [p.x, p.z] = [p.x * cs - p.z * sn, p.x * sn + p.z * cs];
    p.ph = rand() * 100;
  }
  layouts.set(c.key, L);
  return L;
}

// Storm clouds alive at scene time t (lightning.js picks the cloud a strike comes out of): towers and the lumpy layer,
// with their layout height H. The hour is the last frame's (towers and the layer don't depend on it).
const STORM = ['cb', 'sc'];
export function stormCloudsAt(t) {
  const out = cloudsAt(t, lastH, STORM);
  for (const c of out) c.H = layoutOf(c).H;
  return out;
}

// rain shafts (rainshafts.js): the clouds of the last layout (updateClouds: this frame's or the one before)
export const liveClouds = () => drawn;

// ---------- sky dome: cirrus, and the deck beyond the march ----------
// The volume is marched out to ~1.1 km; the deck (~190 m up) is that far only within ~10° of the horizon. Below that (and
// below the horizon, where the terrain ends) the dome draws the deck in its horizon colour, so the sun/moon glow there
// is covered exactly as just above it. Behind both, two faint rows of far clouds standing on the horizon.
const NOISE_PERIOD = 64; // the dome noise tiles every 64 cells, so drift offsets can wrap without a seam
const wrap1 = (v) => v - Math.floor(v);
const domeMat = new THREE.ShaderMaterial({
  uniforms: {
    ...uniforms,
    uCirrus: { value: 0 }, uLayer: { value: 0 }, uLayerDark: { value: 0 },
    uCirrusOffset: { value: new THREE.Vector2() }, uLayerOffset: { value: new THREE.Vector2() }, uAloft: { value: new THREE.Vector2() },
    uFar: { value: new THREE.Vector4() },
  },
  side: THREE.BackSide,
  transparent: true,
  depthWrite: false,
  premultipliedAlpha: true,
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    uniform vec3 uSkySunDir;
    uniform vec3 uSkySunColor;
    uniform vec3 uSkyMoonDir;
    uniform vec3 uSkyMoonColor;
    uniform float uFlash;
    uniform vec3 uFlashPos;
    uniform vec4 uFlashLight; // lightning.js: sky-wide glow, ground channel lit, radius of the lit cloud, out of the sheet
    uniform float uCirrus;
    uniform float uLayer;
    uniform float uLayerDark;
    uniform vec2 uCirrusOffset;
    uniform vec2 uLayerOffset;
    uniform vec2 uAloft; // the wind up there (updateClouds)
    uniform vec4 uFar; // far clouds: cover, morph time (0..64), near and far row's slide (turns)
    varying vec3 vDir;
    float vnoiseP(vec2 p, vec2 per) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash12(mod(i, per)), hash12(mod(i + vec2(1, 0), per)), u.x),
                 mix(hash12(mod(i + vec2(0, 1), per)), hash12(mod(i + vec2(1, 1), per)), u.x), u.y);
    }
    float fbmP(vec2 p) {
      float s = 0.0, a = 0.5; vec2 per = vec2(${NOISE_PERIOD.toFixed(1)});
      for (int i = 0; i < 4; i++) { s += a * vnoiseP(p, per); p *= 2.0; per *= 2.0; a *= 0.5; }
      return s / 0.9375;
    }
    // How much far cloud there is along a row (0..1), k cells per turn, morphing with T.
    float farCover(float x, float k, float T) {
      float n = 0.7 * vnoiseP(vec2(x, T), vec2(k, 64.0)) + 0.3 * vnoiseP(vec2(x * 2.0, T + 17.0), vec2(k * 2.0, 64.0));
      return smoothstep(1.0 - 0.75 * uFar.x, 1.3 - 0.75 * uFar.x, n); // a wide ramp: lobes step down to the edges
    }
    // A row of far clouds, k cells per turn (tiles round the circle and with the morph time), up to h radians tall over
    // their base: three round lobes per cell, each sized and raised by the cover there, small lobes on top; under the
    // highest lobe is cloud. Returns coverage and the height in the cloud (0 base .. 1 top).
    vec2 farRow(float az, float e, float k, float h, float slide, float seed) {
      float u = 6.2832 / (k * 3.0), x = (az + slide) * k * 3.0, y = e / u, T = uFar.y + seed, top = -1.0; // in lobe cells
      for (int j = -1; j <= 1; j++) {
        float c = floor(x) + float(j), cov = farCover((c + 0.5) / 3.0, k, T), dx = x - c - 0.5;
        float r = (0.55 + 0.45 * hash12(vec2(mod(c, k * 3.0), seed))) * (0.6 + 0.4 * cov); // small clouds: low domes
        float t = cov * h / u * (0.6 + 0.4 * vnoiseP(vec2(c, 2.0 * T), vec2(k * 3.0, 64.0)));
        if (cov > 0.02 && abs(dx) < r) top = max(top, t * sqrt(1.0 - dx * dx / (r * r))); // a half ellipse: no wall where a tall lobe ends
      }
      float small = 0.0;
      for (int j = -1; j <= 1; j++) {
        float c = floor(x * 2.0) + float(j), r = 0.35 + 0.55 * hash12(vec2(mod(c, k * 6.0), seed + 3.0)), dx = x * 2.0 - c - 0.5;
        small = max(small, sqrt(max(r * r - dx * dx, 0.0)) - 0.3 * r);
      }
      top += small / 2.0;
      return vec2(smoothstep(-0.05, 0.05, top - y), clamp(y / max(top, 1e-3), 0.0, 1.0));
    }
    void main() {
      vec3 d = normalize(vDir);
      float e = max(d.y, 0.0);
      vec2 p = d.xz / (e + 0.035); // where the view ray meets a flat cloud deck, in deck heights (smooth at the horizon)
      float far = smoothstep(0.0, 0.12, e); // toward the horizon the deck is far away: detail averages out
      vec2 w = uAloft;
      // cirrus: thin streaks stretched along the wind
      float ci = smoothstep(0.58, 0.88, fbmP(vec2(dot(p, w), dot(p, vec2(-w.y, w.x))) * vec2(1.4, 5.0) + uCirrusOffset)) * uCirrus;
      ci *= smoothstep(0.02, 0.2, e);
      // the deck past the march: a soft blanket near the horizon (the volume takes over above ~10°)
      float ln = mix(0.5, fbmP(p * 1.6 + uLayerOffset), far);
      float layer = smoothstep(1.0 - uLayer - 0.15, 1.0 - uLayer + 0.25, ln) * smoothstep(0.0, 0.3, uLayer) * (1.0 - smoothstep(0.12, 0.22, e));

      vec3 sky = uFogColor;
      float toSun = max(dot(d, uSkySunDir), 0.0), toMoon = max(dot(d, uSkyMoonDir), 0.0);
      vec3 sunW = mix(vec3(dot(uSkySunColor, vec3(0.333))), uSkySunColor, 0.5); // ice crystals: white by day, still pink at dusk
      vec3 ciCol = sky * 0.45 + sunW * 0.95 + uSkyMoonColor * 0.6;
      vec3 grey = vec3(dot(sky, vec3(0.3, 0.59, 0.11)));
      vec3 layerCol = (mix(sky, grey, 0.6) * 0.9 + (uSkySunColor + uSkyMoonColor) * 0.35) * (1.0 - uLayerDark * (0.45 + 0.5 * smoothstep(0.4, 0.9, ln)));
      // the far deck is seen through the haze: it reaches the horizon in the haze colour (no light gap under it, no
      // bright band where the fogged hills meet it)
      layerCol = mix(sky, layerCol, smoothstep(0.0, 0.4, e));
      // the sun/moon shine through a thin sheet; a thick deck only shows a faint brighter patch
      layerCol += uSkySunColor * (pow(toSun, 24.0) * (1.0 - uLayerDark) * 0.8 + pow(toSun, 3.0) * 0.1);
      layerCol += uSkyMoonColor * (pow(toMoon, 24.0) * (1.0 - uLayerDark) * 0.6 + pow(toMoon, 3.0) * 0.08);
      // far clouds (beyond the march): hazed toward the horizon colour, the farther row more; lit tops, sun side brighter
      vec2 f0 = vec2(0.0), f1 = vec2(0.0);
      float az = atan(d.x, -d.z) / 6.2832, fb = 0.13 * smoothstep(0.3, 0.08, abs(az)); // the base: on the horizon, raised behind the ridges (0.15-0.23 ahead) so the tops clear them
      if (uFar.x > 0.01 && e > fb && e < fb + 0.25) {
        f0 = farRow(az, e - fb, 24.0, 0.18, uFar.z, 0.0);
        f1 = farRow(az, e - fb, 40.0, 0.12, uFar.w, 31.0);
      }
      float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-4), normalize(uSkySunDir.xz + 1e-4));
      vec3 farLit = sky * 0.5 + uSkySunColor * (0.45 + 0.4 * sunSide) + uSkyMoonColor * 0.3;
      vec3 farShade = mix(sky, vec3(dot(sky, vec3(0.3, 0.59, 0.11))), 0.5) * 0.85 + uSkyMoonColor * 0.15; // grey-blue under the lit tops
      float low = smoothstep(fb, fb + 0.1, e); // the bottoms melt into the haze
      vec3 far0Col = mix(sky, mix(farShade, farLit, smoothstep(0.15, 0.9, f0.y)), 0.7);
      vec3 far1Col = mix(sky, mix(farShade, farLit, smoothstep(0.15, 0.9, f1.y)), 0.5);
      float aF0 = f0.x * 0.6 * low, aF1 = f1.x * 0.45 * low;
      // lightning: the whole sheet lights up, most toward the flash; a bright patch right over it only when it comes
      // out of the sheet
      float toFlash = max(dot(d, normalize(uFlashPos - cameraPosition + vec3(0.0, 1e-3, 0.0))), 0.0);
      layerCol += vec3(0.6, 0.64, 0.8) * (uFlashLight.x * (0.5 + 0.9 * pow(toFlash, 4.0) * (0.4 + 0.6 * uFlashLight.w)) + uFlash * 0.5 * uFlashLight.w * pow(toFlash, 24.0));
      float aC = ci * 0.45, aL = layer * mix(0.85, 1.0, uLayerDark); // only dark sheets fully hide the sun
      vec3 ciOut = linearToOutputTexel(vec4(ciCol, 1.0)).rgb, layerOut = linearToOutputTexel(vec4(layerCol, 1.0)).rgb;
      vec3 far0Out = linearToOutputTexel(vec4(far0Col, 1.0)).rgb, far1Out = linearToOutputTexel(vec4(far1Col, 1.0)).rgb;
      // premultiplied, back to front; encoded to sRGB before multiplying by alpha (encoding a premultiplied colour makes thin edges glow)
      vec4 o = vec4(ciOut * aC, aC);
      o = o * (1.0 - aF1) + vec4(far1Out * aF1, aF1);
      o = o * (1.0 - aF0) + vec4(far0Out * aF0, aF0);
      gl_FragColor = o * (1.0 - aL) + vec4(layerOut * aL, aL);
    }`,
});
const dome = new THREE.Mesh(new THREE.SphereGeometry(450, 48, 24), domeMat);
dome.renderOrder = 2;
dome.frustumCulled = false;

export const cloudLayer = new THREE.Group().add(dome, volumeLayer);

// ---------- per-frame update ----------
const drawn = [];
let frameNo = 0, lastH = 12, domeT = null;

// t = scene time in seconds (real clock + slider offset), h = hour of day, camera for distances.
export function updateClouds(t, h, camera) {
  const cam = camera.position;
  lastH = h;
  dome.position.copy(cam);

  // the puffs are laid out for the weather maps, which are drawn every other frame (cloudvolume.js): on those frames only
  if (mapsDue()) {
    frameNo++;
    const clouds = cloudsAt(t, h);
    headings.forEach((hd, key) => hd[2] !== frameNo && headings.delete(key));
    drawn.length = 0;
    beginBlobs();
    for (const c of clouds) {
      if (c.growth < 0.01) continue; // evaporated (a tower too near the view, a cloud in front of the cap)
      const L = layoutOf(c), far = c.T.fade ?? FADE;
      L.frame = frameNo;
      const fade = 1 - smoothstep(hypot(c.x - cam.x, c.z - cam.z), far[0], far[1]);
      if (fade <= 0) continue;
      drawn.push(c);
      const layer = c.T.layer ?? 0;
      for (const p of L.list) {
        const s = smoothstep(c.growth, p.th * 0.7, p.th * 0.7 + 0.3); // forming puffs grow from the core out
        if (s < 0.01) continue;
        const r = p.r * 1.3 * (0.4 + 0.6 * s) * (1 + 0.07 * Math.sin(t * 0.02 + p.ph)); // erosion eats the rim; slow churning
        addBlob(layer, c.x + p.x, c.z + p.z, r, c.y + p.y, r * p.k, L.flat && !p.own ? c.y : -1e4,
          smoothstep(s, 0, 0.25) * c.T.opacity * fade, c.dark);
      }
    }
    layouts.forEach((L, key) => L.frame !== frameNo && layouts.delete(key));
  }

  // dome: cover from the weather; the wind up there follows the one below over ~10 min of scene time (a quick turn spun
  // the cirrus round the zenith), the sheet drifts with it from the scene time (wrapped to the noise period)
  const du = domeMat.uniforms, aloft = du.uAloft.value, off = du.uLayerOffset.value, wrap = (v) => ((v % NOISE_PERIOD) + NOISE_PERIOD) % NOISE_PERIOD;
  if (domeT === null) { aloft.copy(uniforms.uWindDir.value); off.set(wrap(t * 0.0025), wrap(t * 0.0025)); } // not x the wind: x t ~1.8e9 s, a 1e-5 difference between loads moved the sheet a whole tile
  else {
    aloft.lerp(uniforms.uWindDir.value, 1 - Math.exp(-THREE.MathUtils.clamp(t - domeT, 0, 600) / 600)).normalize();
    off.set(wrap(off.x + aloft.x * (t - domeT) * 0.0025), wrap(off.y + aloft.y * (t - domeT) * 0.0025));
  }
  // far clouds: more than the horizon banks' cover (the eye sees much farther there), morphing over ~15 min of scene time
  // (the same for every page), sliding with the cross wind at 0.6 m/s seen from ~2 km (the far row ~4 km) from where
  // the page opened (from t itself, a 1e-7 difference in the wind moved them a whole cloud). shortcut: one slide round
  // the whole circle (right ahead, backwards behind the view); fine while the views look north.
  const far = du.uFar.value, slide = domeT === null ? 0 : -aloft.x * 0.6 / 2000 / (2 * Math.PI) * (t - domeT);
  far.set(Math.min(1, 1.4 * coverAt(h).bk), (t / 900) % 64, wrap1(far.z + slide), wrap1(far.w + slide / 2));
  domeT = t;
  du.uCirrus.value = weather.ci;
  du.uLayer.value = weather.layer;
  du.uLayerDark.value = weather.layerDark;
  du.uCirrusOffset.value.set((t * 0.0006) % NOISE_PERIOD, 0);

  // the cap: greyer in bad weather
  updateVolume(t, aloft, Math.min(0.95, 0.05 + 0.6 * weather.dark));
}
