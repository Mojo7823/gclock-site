import * as THREE from 'three';
import { weather } from './weather.js';

// Seeded RNG so the scene is identical on every load.
export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// hash at a whole-number point, remembered: building the scene asks 29 million times for the same ~27,000 points
// (a third of the start-up was Math.sin). Outside the table it is worked out as before: the same numbers either way.
const LATTICE = 256, lattice = new Float64Array(LATTICE * LATTICE).fill(-1);
function latticeHash(xi, yi) {
  const cx = xi + LATTICE / 2, cy = yi + LATTICE / 2;
  if (!(cx >= 0 && cx < LATTICE && cy >= 0 && cy < LATTICE)) return hash(xi, yi); // also NaN and Infinity
  const k = cy * LATTICE + cx, v = lattice[k];
  return v >= 0 ? v : (lattice[k] = hash(xi, yi));
}

// 2D value noise in [0, 1].
export function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = latticeHash(xi, yi), b = latticeHash(xi + 1, yi), c = latticeHash(xi, yi + 1), d = latticeHash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y) {
  return valueNoise(x, y) * 0.55 + valueNoise(x * 2.1, y * 2.1) * 0.3 + valueNoise(x * 4.3, y * 4.3) * 0.15;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// River (roadmap step 2): crosses the view behind the trees and flows toward +x, nearer to the camera
// on the left. riverZ = centre line, riverHalfWidth = water half width, both in metres.
export const WATER_Y = -3.2; // water surface height
export const BEACH = 1.6; // width of the mud/pebble band above the waterline (m)
export const riverZ = (x) => -28.5 - 6.5 * Math.sin(x * 0.045) - 1.5 * Math.sin(x * 0.12 + 0.8);
export const riverHalfWidth = (x) => 6 + 1.1 * Math.sin(x * 0.07 + 0.5);

// Distance (m) from the water's edge, negative in the water. Across-the-curve distance is
// approximated by |dz| * cos(slope), close enough for these gentle meanders.
let edgeX = NaN, edgeZ = NaN, edge = 0; // the last answer: builders ask for one spot's edge, height and clearance in a row (7 sines each)
export function riverEdge(x, z) {
  if (x === edgeX && z === edgeZ) return edge;
  const slope = riverZ(x + 0.5) - riverZ(x - 0.5);
  edgeX = x; edgeZ = z;
  return edge = Math.abs(z - riverZ(x)) / Math.hypot(1, slope) - riverHalfWidth(x);
}

// Ground height. Near the camera an almost flat meadow; from a few metres in front of it the ground
// slopes down into the river valley, steeper than the sight line, so the water shows over the grass
// from eye height. Low beach at the waterline, hills beyond the river.
const VALLEY = 34; // the valley side reaches the meadow this far from the water (m)
export function heightAt(x, z) {
  const e = riverEdge(x, z);
  const meadow = (fbm(x * 0.04, z * 0.04) - 0.5) * 1.2 * smoothstep(2, 10, e);
  const hills = smoothstep(42, 110, -z + Math.abs(x) * 0.4) * fbm(x * 0.012 + 7, z * 0.012) * 32 * smoothstep(4, 30, e);
  let river;
  if (e < 0) river = WATER_Y - Math.min(0.9, -e * 0.45); // bed
  else {
    const t = Math.min(1, Math.max(0, (e - BEACH) / (VALLEY - BEACH))), beach = 0.35;
    river = WATER_Y + beach * Math.min(e / BEACH, 1) // low beach
      + (-WATER_Y - beach) * (t + smoothstep(0, 1, t)) / 2; // valley side: nearly straight, softened ends
  }
  const near = meadow + hills + river;
  const far = Math.hypot(x - EYE.x, z - EYE.z);
  return far < FAR_LAND ? near : farLand(x, z, near, far);
}

// Summit of the big snowy peak in the background (mountain.js); the clouds keep a cap on it (cloudvolume.js).
// Keep everything visible within ~450 m of the camera: the sky dome (r 460) paints over anything beyond.
export const MOUNTAIN = { x: 110, y: 165, z: -340 };
// Base of the sheet deck (weather.layer, cloudvolume.js; its underside swells ±12 m): over the summit, so the peak and its
// cap stay in sight under an overcast sky. Lightning out of the sheet starts in it.
export const DECK_BASE = 182;

// Far land: terrain.js draws the ground up to FAR_LAND m from the clock camera's foot (EYE), mountain.js from there
// to SKY_EDGE, just inside the sky dome (r 460, it paints over anything beyond). Out there the land rises into three
// fold ranges across the horizon, ~320-425 m out, and the big peak at MOUNTAIN stands among them; behind the last
// range the land drops away again, out of sight, so the end of the land never shows.
export const EYE = { x: 0, z: 11 };
export const EYE_HEIGHT = 3; // default eye height of the clock camera above the meadow (m); the viewer can raise or lower it (settings 'camera.height')
export const FAR_LAND = 190;
export const EYE_Y = heightAt(EYE.x, EYE.z) + EYE_HEIGHT; // the default eye (world y, m): what the mountain's tree horizon and the cap cloud's sight line assume
export const SKY_EDGE = 452;
// The hero: one broad pyramid. Four arêtes (directions from the summit, relative to the side facing the camera): one
// comes down toward the camera right of centre (it splits the lit face from the shaded one), two run out left and
// right (the silhouette), one goes back. The summit is a short rounded ridge across the view, not a needle.
const HERO_FRONT = Math.atan2(EYE.z - MOUNTAIN.z, EYE.x - MOUNTAIN.x);
const HERO = {
  radius: 170, // base radius: ~0.9x across a face, ~1.1x along an arête
  ridges: [-0.35, 1.6, Math.PI + 0.15, -1.7].map((a) => HERO_FRONT + a),
  crest: 8, // half length of the summit ridge (m)
  ax: Math.cos(HERO_FRONT), az: Math.sin(HERO_FRONT), // toward the camera
};
// Fold mountains: long ranges on arcs around the clock camera, parallel and wandering together, in three layers: a low
// foothill ridge in front, the main range, and behind it a farther one, a little lower on the horizon and hazier (it
// shows over the main range's saddles and cols). All well below the big peak, so it stays the one focus.
// [distance of the fold's axis from EYE (m), half width (m), crest height (m), seed]
const FOLDS = [[318, 34, 55, 1], [372, 40, 98, 2], [424, 30, 104, 3]].map(([r, w, h, seed]) => ({ r, w, h, seed: seed * 17.3 }));

// 0..1, sharp crests (crags and ridges) and rounded troughs
function ridged(x, z) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 3; i++, a *= 0.5, f *= 2.03) {
    const n = 1 - Math.abs(valueNoise(x * f, z * f) * 2 - 1);
    s += a * n * n;
  }
  return s / 0.875;
}
const rib = (x, y) => 1 - Math.abs(valueNoise(x, y) * 2 - 1); // 0..1, a sharp crest where the noise crosses 0.5

// Fold ranges at (x, z), `far` m from EYE: the highest of the folds there (m)
function folds(x, z, far) {
  const az = Math.atan2(x - EYE.x, EYE.z - z), side = smoothstep(2.0, 1.65, Math.abs(az)); // across the view, sinking away behind it
  if (side <= 0) return 0;
  const wander = 24 * (valueNoise(az * 2.2 + 4, 0.5) - 0.5); // all folds bend together (parallel ranges)...
  let top = 0;
  for (const f of FOLDS) {
    const s = az * f.r; // along the fold (m)
    const q = far - f.r - wander - 12 * (valueNoise(s * 0.004 + f.seed, 1.5) - 0.5); // ...and a little on their own; + = beyond the axis
    const t = q < 0 ? -q / (f.w * 1.5) : q / (f.w * 0.8); // the near side longer (a tilted fold; it hides the far one's foot)
    if (t >= 1) continue;
    // the crest: a row of pointed tops with rounded saddles between (ridged noise along the fold), higher stretches,
    // and a few deep cols
    const tops = 0.72 * rib(s * 0.04 + f.seed, 2.5) + 0.28 * rib(s * 0.065 + f.seed, 3.5); // long ridges, not a comb of small tops
    let crest = f.h * (0.7 + 0.32 * tops + 0.15 * (valueNoise(s * 0.006 + f.seed, 5.5) - 0.5));
    crest *= 1 - 0.3 * smoothstep(0.6, 0.82, valueNoise(s * 0.0045 + f.seed, 4.5));
    const u = (Math.hypot(t, 0.05) - 0.05) / (Math.hypot(1, 0.05) - 0.05); // a sharp crest, just not a knife edge
    let h = crest * (1 - u) ** 1.6; // concave flanks: steep rock up top, gentle grass below
    // spurs and gullies down the flanks, none on the crest and the foot (the bigger ones run down from the tops: same noise)
    const rel = h / crest, ribs = 0.6 * rib(s * 0.04 + f.seed, 2.5 + q * 0.006) + 0.4 * rib(s * 0.07 + f.seed, q * 0.025);
    h += crest * 0.2 * (ribs - 0.62) * smoothstep(0.08, 0.3, rel) * (1 - smoothstep(0.8, 0.97, rel));
    top = Math.max(top, h);
  }
  return top * side;
}

// The hero at (x, z), dHero m from the summit (m)
function hero(x, z, dHero) {
  const dx = x - MOUNTAIN.x, dz = z - MOUNTAIN.z, phi = Math.atan2(dz, dx);
  // arêtes: the slope reaches further out along them, so the contours are square-ish (pyramid faces between them)
  let ridge = 0;
  for (const r of HERO.ridges) ridge = Math.max(ridge, Math.exp(-2.2 * (1 - Math.cos(phi - r))));
  // the summit ridge runs across the view: along it the distance grows slowly, so the crest falls gently from the top
  const along = Math.abs(dz * HERO.ax - dx * HERO.az), across = dx * HERO.ax + dz * HERO.az;
  const d = Math.hypot(Math.max(along - HERO.crest, 0) + 0.3 * Math.min(along, HERO.crest), across);
  // the faces rounded over at the top (a crown, not a needle), on a wide pedestal (the shoulders and the strong base)
  const u = d / (HERO.radius * (0.62 + 0.5 * ridge)), c = 0.04;
  let h = MOUNTAIN.y * Math.max(u < 1 ? (1 - (Math.hypot(u, c) - c) / (Math.hypot(1, c) - c)) ** 1.1 : 0,
    0.5 * Math.max(0, 1 - dHero / (HERO.radius * 1.45)) ** 1.25);
  // ribs and couloirs running down the fall line from the summit: ridged noise in polar coordinates around the peak
  // (they converge toward the top), two scales; none on the top ~50 m (the cap cloud fits it) and the foot. Max 0.11 h deep.
  const ang = Math.atan2(Math.sin(phi - HERO_FRONT), Math.cos(phi - HERO_FRONT)), rel = h / MOUNTAIN.y;
  const ribs = 0.65 * rib(ang * 3.8, dHero * 0.012) + 0.35 * rib(ang * 10, dHero * 0.035);
  h += MOUNTAIN.y * 0.11 * (ribs - 0.62) * smoothstep(0.08, 0.3, rel) * (1 - smoothstep(0.75, 0.97, rel)) * smoothstep(45, 85, dHero);
  return h;
}

function farLand(x, z, near, far) {
  // the valley floors between the folds, low enough not to drown them
  const land = near + smoothstep(260, 385, far) * smoothstep(SKY_EDGE, 405, far) * (8 + 18 * fbm(x * 0.008 + 3, z * 0.008));
  const dHero = Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z);
  let peak = Math.max(folds(x, z, far), dHero < HERO.radius * 1.45 ? hero(x, z, dHero) : 0);
  if (peak > 0) {
    // crags and gullies cut into the rock (deeper where it is higher); none on the hero's top so the summit stays at MOUNTAIN
    // (shallower on the folds, so their crests stay long lines)
    peak -= (1 - ridged(x * 0.02, z * 0.02)) * (0.2 + 0.1 * smoothstep(60, 160, dHero) - 0.16 * smoothstep(170, 260, dHero)) * peak * smoothstep(0, 40, dHero);
    // finer crags break up the ridgelines (the silhouette), on the rock only; the hero's top ~50 m keeps its shape
    if (peak > 45) peak += (ridged(x * 0.06 + 5, z * 0.06) - 0.55) * 7 * smoothstep(45, 110, peak) * smoothstep(40, 70, dHero);
  }
  // none in front of the hills, and the backs of the ranges drop out of sight before the end of the land
  const fadeIn = smoothstep(FAR_LAND, FAR_LAND + 60, far);
  peak *= fadeIn * smoothstep(SKY_EDGE + 8, 432, far);
  // smooth max: the rock rises out of the land without a crease (its bump on low land fades in too, else the ground
  // stepped up to 3 m at FAR_LAND, a toothed band where the near plane ends)
  const k = 12, t = Math.max(k - Math.abs(peak - land), 0) / k;
  return Math.max(peak, land) + t * t * k / 4 * fadeIn;
}

export const MAX_TREES = 16; // shadow casters: trees and bushes

// 0 inside any [x, z, radius] circle (rocks), in the river and on its beach band, rising to 1 at 1.5 m
// outside a rock / 2.5 m above the band, so grass thins out around them and flowers keep away.
export function clearance(x, z, avoid) {
  let m = THREE.MathUtils.smoothstep(riverEdge(x, z), BEACH, BEACH + 2.5);
  for (let i = 0; i < avoid.length; i++) {
    const a = avoid[i], dx = x - a[0], dz = z - a[1], reach = a[2] + 1.6;
    if (dx * dx + dz * dz > reach * reach) continue; // clear of this one (1 from 1.5 m out): asked ~150,000 times, nearly always the case
    m = Math.min(m, THREE.MathUtils.smoothstep(Math.hypot(dx, dz), a[2], a[2] + 1.5));
  }
  return m;
}

const deck = new THREE.Vector2();
// Shared by every material: change a value here and the whole scene follows.
// daycycle.js drives the light, colours, wind and shadow values from the time of day.
export const uniforms = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(-0.45, 0.8, 0.5).normalize() }, // toward the light: the sun by day, the moon by night
  uSunColor: { value: new THREE.Color('#fff6e3') }, // colour of that light
  uShadeColor: { value: new THREE.Color('#93a8cf') }, // multiplier for the unlit side / shadows
  uFogColor: { value: new THREE.Color('#a9d4f2') }, // sky colour at the horizon (fog blends into it)
  uZenithColor: { value: new THREE.Color('#7fb6e8') }, // sky colour overhead (written by daycycle.js)
  uFogRange: { value: new THREE.Vector2(40, 220) }, // fog starts x m out and thickens like a smoothstep toward y m (applyFog; set in daycycle.js)
  uHaze: { value: new THREE.Vector2(0.08, 60) }, // far haze (applyFog): x = where the fog stops thickening fast, y = haze layer depth (m) far out
  uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() }, // blowing toward (xz); wind.js turns it
  uWindDrift: { value: new THREE.Vector2() }, // wind.js: metres of air blown past, as a vector (patterns drifting downwind)
  uWindStrength: { value: 3 }, // wind speed, m/s (set by daycycle.js from the weather or the Wind slider)
  uWindTime: { value: 0 }, // wind.js: gust travel and flutter phase, integrated every frame
  uWindPhase: { value: 0 },
  uShadowStrength: { value: 1 }, // 0 = no tree shadows (twilight), 1 = full (midday sun)
  uGround: { value: new THREE.Color('#4a9440') },
  uGround2: { value: new THREE.Color('#74ad4c') },
  uGrassTip: { value: new THREE.Color('#a6d272') },
  uTrees: { value: Array.from({ length: MAX_TREES }, () => new THREE.Vector4()) }, // xyz canopy centre, w radius
  uTreeCount: { value: 0 },
  // the light's shadow map (shadow.js): depth texture, world -> map uv + depth, 1 while it is drawn (quality.shadows)
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowMapOn: { value: 0 },
  // ground mist (morning / evening condensation), driven by daycycle.js
  uMist: { value: 0 },
  uMistHeight: { value: 3 },
  uMistColor: { value: new THREE.Color('#ffffff') },
  // cloud shadows on the land, written by cloudvolume.js: the sun transmittance map (RGBA = light through the clouds
  // above 0 / 60 / 120 / 180 m), its world rect (x0, z0, 1 / width, 1 / depth) and the sun (x / y, z / y, strength)
  uCloudShadowMap: { value: null },
  uCloudShadowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uCloudShadowSun: { value: new THREE.Vector3() },
  // light on the sky (clouds) — separate from the ground light so clouds keep the sunset afterglow
  uSkySunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSkySunColor: { value: new THREE.Color() },
  uSkyMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uSkyMoonColor: { value: new THREE.Color() },
  // lightning (written by lightning.js): flash brightness 0..1 and where it is, for lighting clouds/rain
  uFlash: { value: 0 },
  uFlashPos: { value: new THREE.Vector3() },
  // x = sky-wide glow, y = a ground channel is lit (cloud bases glow from below), z = radius of the cloud the flash
  // lights from inside (around uFlashPos), w = 1: the strike comes out of the sheet (its own bright patch there)
  uFlashLight: { value: new THREE.Vector4(0, 0, 100, 0) },
  uWet: { value: 0 }, // ground wetness 0..1 (written by rain.js)
  // the sheet-cloud deck for applyFog: x = cover, y = darkness, read live from weather.js (clouds.js keeps its own copies)
  uDeck: { get value() { return deck.set(weather.layer, weather.layerDark); } },
};

export const glslCommon = /* glsl */ `
#define MAX_TREES ${MAX_TREES}
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShadeColor;
uniform vec3 uFogColor;
uniform vec3 uZenithColor; // sky colour overhead
uniform vec2 uFogRange;
uniform vec2 uHaze;
uniform vec2 uWindDir;
uniform vec2 uWindDrift;
uniform float uWindStrength;
uniform float uShadowStrength;
uniform vec3 uGround;
uniform vec3 uGround2;
uniform vec3 uGrassTip;
uniform vec4 uTrees[MAX_TREES];
uniform int uTreeCount;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowMapOn;
uniform float uMist;
uniform float uMistHeight;
uniform vec3 uMistColor;
uniform sampler2D uCloudShadowMap;
uniform vec4 uCloudShadowRect;
uniform vec3 uCloudShadowSun;
uniform float uWet;
uniform vec2 uDeck; // sheet-cloud deck: cover, darkness

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// Two-tone toon step with a soft edge.
float toon(float ndl, float soft) { return smoothstep(-soft, soft, ndl); }

vec3 groundColor(vec2 xz) {
  float n = vnoise(xz * 0.07) * 0.65 + vnoise(xz * 0.31) * 0.35;
  return mix(uGround, uGround2, smoothstep(0.35, 0.75, n));
}

// Shadow map (shadow.js): x = how much of p's shadow it gives (fades to 0 over the map's outer 8%, and with the setting
// off), y = lit fraction there: 4 taps of hardware 2x2 PCF, then a smoothstep for a crisp-but-soft toon edge.
// Not in the shadow pass itself (SHADOW): its casters must not sample the map they draw into.
vec2 mapShadow(vec3 p) {
#ifdef SHADOW
  return vec2(0.0, 1.0);
#else
  if (uShadowMapOn < 0.5) return vec2(0.0, 1.0);
  vec3 s = (uShadowMatrix * vec4(p, 1.0)).xyz;
  vec2 e = min(s.xy, 1.0 - s.xy);
  float w = smoothstep(0.0, 0.08, min(e.x, e.y));
  if (w <= 0.0) return vec2(0.0, 1.0);
  vec2 t = 1.2 / vec2(textureSize(uShadowMap, 0));
  float lit = texture(uShadowMap, vec3(s.xy + vec2(-0.6, -0.2) * t, s.z)) + texture(uShadowMap, vec3(s.xy + vec2(0.2, -0.6) * t, s.z))
    + texture(uShadowMap, vec3(s.xy + vec2(0.6, 0.2) * t, s.z)) + texture(uShadowMap, vec3(s.xy + vec2(-0.2, 0.6) * t, s.z));
  return vec2(w, smoothstep(0.3, 3.7, lit));
#endif
}

// Blob shadows, beyond the shadow map (and with it off): 1 = sunlit, 0 = inside a tree's shadow. Each canopy is a
// sphere projected along the sun.
float blobShadow(vec3 p) {
  float lit = 1.0;
  float sy = max(uSunDir.y, 0.15);
  vec2 sd = normalize(uSunDir.xz + 1e-5);
  float edge = vnoise(p.xz * 1.6) - 0.5;
  for (int i = 0; i < MAX_TREES; i++) {
    if (i >= uTreeCount) break;
    vec4 t = uTrees[i];
    if (p.y > t.y) continue; // ground above the crown (far hills) can't be in its shadow
    vec2 d = p.xz - (t.xz - uSunDir.xz / sy * (t.y - p.y));
    float r = length(vec2(dot(d, sd) * sy, dot(d, vec2(-sd.y, sd.x)))); // ellipse stretched along the sun
    r += edge * 0.35 * t.w;
    lit = min(lit, smoothstep(t.w * 0.78, t.w, r));
    lit = min(lit, smoothstep(0.08, 0.3, length(p.xz - t.xz) / t.w)); // contact shadow at the trunk base
  }
  return lit;
}

// 1 = sunlit, 0 = in a tree's shadow: the shadow map where it reaches, the blobs beyond (blended over its rim).
// Casters that receive too (bark, rocks) pass p pushed out along their normal, against self-shadowing acne.
float treeShadow(vec3 p) {
  vec2 m = mapShadow(p);
  float lit = mix(m.x < 1.0 ? blobShadow(p) : 1.0, m.y, m.x);
  return mix(1.0, lit, uShadowStrength);
}

// 1 = sunlit, 0 = under a cloud: the sun transmittance map (cloudvolume.js), looked up where p's sun ray meets the
// ground, at p's height (only the clouds above p shade it); fully lit off the map's edge.
float cloudShadow(vec3 p) {
  if (uCloudShadowSun.z <= 0.0) return 1.0;
  vec2 uv = (p.xz - uCloudShadowSun.xy * p.y - uCloudShadowRect.xy) * uCloudShadowRect.zw;
  vec4 m = texture2D(uCloudShadowMap, uv);
  float h = clamp(p.y / 60.0, 0.0, 3.0);
  float lit = h < 1.0 ? mix(m.r, m.g, h) : h < 2.0 ? mix(m.g, m.b, h - 1.0) : mix(m.b, m.a, h - 2.0);
  vec2 e = min(uv, 1.0 - uv);
  lit = mix(1.0, lit, smoothstep(0.0, 0.02, min(e.x, e.y)));
  return mix(1.0, lit, uShadowStrength * uCloudShadowSun.z);
}

float shadowAt(vec3 p) { return treeShadow(p) * cloudShadow(p); }

vec3 applyFog(vec3 col, vec3 worldPos) {
  // wet after rain: darker and a little more saturated (this is the last step of every ground/plant material)
  col = max(mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, 1.0 + 0.15 * uWet), 0.0) * mix(vec3(1.0), vec3(0.68, 0.71, 0.76), uWet); // wet: darker, a touch cooler (more saturation read as lush, not wet)
  float d = distance(worldPos, cameraPosition);
  // aerial perspective, monotonic with distance: the optical depth grows like a smoothstep from uFogRange.x
  // (3 s^2 = the old smoothstep fog near the camera), then only linearly from s = uHaze.x on, so far land never fogs
  // out before nearer land does: the range keeps a visible foot. Clear days turn linear early (long, light haze);
  // night and rain late (the far land sinks into the dark or the grey).
  float s = max(d - uFogRange.x, 0.0) / (uFogRange.y - uFogRange.x), k = max(s - uHaze.x, 0.0);
  float tau = 3.0 * (s * s - k * k);
  // the haze lies on the ground, thinning upward (exponential layer, 60 m deep nearby, uHaze.y m far out): a sight
  // line climbing to a high point crosses less of it, so summits stay clearer than their foot; at night the range
  // rises out of the shallow valley fog. Nothing within ~150 m is high enough for this to matter much.
  float depth = mix(60.0, uHaze.y, smoothstep(150.0, 320.0, d));
  float a = max(cameraPosition.y, 0.0) / depth, b = max(worldPos.y, 0.0) / depth;
  tau *= abs(b - a) > 1e-3 ? (exp(-a) - exp(-b)) / (b - a) : exp(-a);
  // fade into the sky right behind the point (the sky dome's gradient, sky.js), so a fogged summit is never lighter
  // than the sky above it at dusk
  float e = max(normalize(worldPos - cameraPosition).y, 0.0);
  vec3 sky = mix(uFogColor, uZenithColor, pow(e, 0.6));
  // under a cloud deck: about the deck's grey (clouds.js), not the blue it hides, else hazed land is a pale blue cut-out;
  // darker decks (darkness 0.3 -> 0.7, light rain to storm) darken it up to 50%, so far land stays a step below the sky
  sky = mix(sky, vec3(dot(sky, vec3(0.3, 0.59, 0.11))) * vec3(1.0, 0.97, 1.04), 0.65 * uDeck.x) * (1.0 - 0.5 * uDeck.x * clamp(2.5 * uDeck.y - 0.75, 0.0, 1.0));
  col = mix(col, sky, 1.0 - exp(-tau));
  // ground mist: thick on the ground, thinning with height (pools in the low meadow, hills poke out),
  // and thin right in front of the camera; drifting wisps
  float m = uMist * exp(-max(worldPos.y, 0.0) / uMistHeight) * (1.0 - exp(-d * 0.03));
  m *= 0.65 + 0.35 * vnoise(worldPos.xz * 0.04 - uWindDrift * 0.1);
  return mix(col, uMistColor, clamp(m, 0.0, 0.85));
}
`;
