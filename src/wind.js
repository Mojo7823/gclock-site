import { MathUtils } from 'three';
import { uniforms } from './common.js';
import { windDir, weather } from './weather.js';

// Wind. uWindStrength is the wind speed in m/s: the weather's speed times a time-of-day factor from
// daycycle.js (calmer at night, breeziest in the afternoon), or the Wind slider as is. Gusts are a
// noise field rolling downwind; blades and leaves flutter on a phase that runs faster in stronger
// wind. Both are integrated here, so changing the speed never makes anything jump.
// Shaders that sway use glslCommon + glslWind.
// Direction: uWindDir is the xz direction the wind blows toward, from weather.js's eased compass bearing (degrees it
// blows FROM) plus a gust swing of a few degrees. Compass here: east is straight ahead of the clock view (-z), north
// to its left (-x), so a north wind blows left to right (+x) and an east wind toward the viewer (+z).
const DEG = Math.PI / 180;
const towardFrom = (from, v) => v.set(Math.cos(from * DEG), Math.sin(from * DEG));

// Random gusts on top of the noise field (live only, live = false keeps dev views the same every run): they come at truly
// random moments (Math.random), ramp up over 1-2 s, hold 2-5 s and die away over 3-7 s, raising uWindStrength by `extra`
// (so the sway, the rain's slant and the wind sound swell together). How often and how strong grow with the gust excess,
// speed x (weather.gust - 1): the forecast's gust factor, else the preset's. A calm 1 m/s (excess ~0.6) gets a 0.2-0.5 m/s
// puff every ~3 min; fair 3 m/s (1.8) ~1 m/s every 2 min; a gusty 8 m/s day with gusts of 15 ~2.7/min of 3-6 m/s; a storm
// ~3/min, capped at +8 m/s.
export const gust = { env: 0, extra: 0, peak: 0, t: 0, rise: 0, hold: 0, fall: 0, count: 0 };
export const gustRate = (excess) => (0.3 + 2.5 * MathUtils.smoothstep(excess, 0.5, 8)) / 60; // gusts a second
function gusts(dt, live, s) {
  const excess = s * Math.max(0, weather.gust - 1);
  if (gust.peak && (gust.t += dt) >= gust.rise + gust.hold + gust.fall) gust.peak = 0;
  if (!gust.peak && live && Math.random() < gustRate(excess) * dt) {
    const r = Math.random;
    Object.assign(gust, { peak: Math.min(8, excess * (0.4 + 0.4 * r())), t: 0, rise: 1 + r(), hold: 2 + 3 * r(), fall: 3 + 4 * r(), count: gust.count + 1 });
  }
  const { t, rise, hold, fall } = gust;
  gust.env = !gust.peak ? 0 : t < rise ? MathUtils.smoothstep(t, 0, rise) : 1 - MathUtils.smoothstep(t, rise + hold, rise + hold + fall);
  return (gust.extra = gust.peak * gust.env);
}

// Call every frame after setTime (which sets the speed). dt in real seconds; live: random gusts on (main.js: not in dev).
export function updateWind(dt, live = false) {
  const s = (uniforms.uWindStrength.value += gusts(dt, live, uniforms.uWindStrength.value));
  // shortcut: wraps every 50 km of wind (~4.5 h at 3 m/s) and the gust pattern pops once; tile the noise if it shows
  uniforms.uWindTime.value = (uniforms.uWindTime.value + s * dt) % 5e4;
  uniforms.uWindPhase.value = (uniforms.uWindPhase.value + (0.8 + 0.3 * s) * dt) % (200 * Math.PI);
  // ±4° swing, quicker in stronger wind (whole multiples of 0.01 x the phase, so its wrap is seamless)
  const ph = uniforms.uWindPhase.value;
  if (windDir.from !== null) towardFrom(windDir.from + 4 * (0.6 * Math.sin(ph * 0.02) + 0.4 * Math.sin(ph * 0.05 + 1.7)), uniforms.uWindDir.value);
  // air blown past as a vector, for patterns drifting downwind (a direction times uWindTime jumps when it turns)
  // shortcut: reset after 50 km (pops the ground-mist wisps once); tile the noise if it shows
  const drift = uniforms.uWindDrift.value.addScaledVector(uniforms.uWindDir.value, s * dt);
  if (drift.lengthSq() > 2.5e9) drift.set(0, 0);
}

// Tuned on blade tips (1 m blade): ~5 / 10 cm lean (mean / p95) at the fair noon 2.7 m/s, 21 / 39 cm
// at 7, 41 / 68 cm at 12, 64 / 87 cm at 20 m/s (the docs have the full table).
export const glslWind = /* glsl */ `
uniform float uWindTime; // metres of air blown past (integral of the speed)
uniform float uWindPhase; // flutter phase, faster in stronger wind; use whole multiples only (it wraps every 100 turns)

// 0..1 gust strength at p (world xz): broad gust fronts, long across the wind, plus smaller puffs, rolling
// downwind at 60% of the wind speed (the speed is the 10 m wind; at grass height it is ~60%, log profile).
// Mostly lulls, with gusts now and then. The puffs travel a little faster, so the pattern keeps changing.
float windGust(vec2 p) {
  vec2 q = vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x))); // along, across the wind
  q.x -= uWindTime * 0.6;
  float n = vnoise(q * vec2(0.04, 0.018)) * 0.7 + vnoise((q - vec2(uWindTime * 0.15, 0.0)) * vec2(0.11, 0.06) + 7.3) * 0.3;
  return smoothstep(0.3, 0.8, n);
}

// Wind bend of a stalk at height fraction t (0 root, 1 tip), shared by grass, flowers and reeds so they sway together.
// The push grows like drag (~speed²) and the lean saturates, so a storm flattens stalks without stretching them.
// Flutter is mostly in step with the neighbours (a slow sway rolling downwind), plus a little per-blade detail.
vec2 windBend(vec2 root, float t, float h, float rnd) {
  float g = windGust(root), s = uWindStrength;
  float flutter = sin(uWindPhase + rnd * 2.0 + dot(root, uWindDir) * 0.35) * 0.7 + sin(2.0 * uWindPhase + rnd * 6.283) * 0.3;
  float push = s * (s + 4.0) * 0.004 * (0.25 + 1.5 * g + 0.3 * flutter * (0.5 + g));
  return uWindDir * 0.85 * (1.0 - exp(-push)) * t * t * h;
}
`;
