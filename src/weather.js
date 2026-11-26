// Weather presets: what the sky does for each weather type.
//   cu / sc / cb / fr = cloud cover per type: the fraction of cloud slots (see clouds.js) that hold a
//     cloud of that type. cu cumulus, sc stratocumulus, cb cumulonimbus (storm tower), fr fractus (low
//     ragged scud; also the morning mist lifting off the meadow).
//   ci = cirrus (high wisps), layer = sheet cloud over the whole sky (both on the sky dome).
//   layerDark / dark = how grey the sheet / the puff clouds get.
//   dim = how much the cover blocks the sun: dimmer, flatter light, weaker shadows, greyer sky.
//   wind = wind speed (m/s; the Wind slider overrides it), mist, haze feed the scene (sway, ground mist, fog distance).
//   rain = rain intensity (0..1, rain.js), bolt = lightning strikes per minute (lightning.js).
//   gust = gust factor (peak gust / mean wind; wind.js's random gusts) when the forecast has none or the wind is set by hand.
export const PRESETS = {
  clear: { cu: 0.06, sc: 0, cb: 0, fr: 0, ci: 0.2, layer: 0, layerDark: 0, dark: 0, dim: 0, wind: 2, mist: 0, haze: 0, rain: 0, bolt: 0, gust: 1.5 },
  fair: { cu: 0.7, sc: 0.08, cb: 0, fr: 0, ci: 0.3, layer: 0, layerDark: 0, dark: 0, dim: 0, wind: 3, mist: 0, haze: 0, rain: 0, bolt: 0, gust: 1.6 },
  cloudy: { cu: 0.9, sc: 0.6, cb: 0, fr: 0.15, ci: 0.25, layer: 0.25, layerDark: 0.1, dark: 0.15, dim: 0.3, wind: 4, mist: 0, haze: 0.1, rain: 0, bolt: 0, gust: 1.7 },
  overcast: { cu: 0.15, sc: 0.75, cb: 0, fr: 0.3, ci: 0, layer: 0.95, layerDark: 0.3, dark: 0.35, dim: 0.6, wind: 4, mist: 0.15, haze: 0.3, rain: 0, bolt: 0, gust: 1.5 },
  lightrain: { cu: 0.05, sc: 0.6, cb: 0, fr: 0.55, ci: 0, layer: 1, layerDark: 0.45, dark: 0.5, dim: 0.7, wind: 5, mist: 0.3, haze: 0.45, rain: 0.3, bolt: 0, gust: 1.7 },
  rain: { cu: 0, sc: 0.5, cb: 0.15, fr: 0.85, ci: 0, layer: 1, layerDark: 0.65, dark: 0.65, dim: 0.8, wind: 7, mist: 0.45, haze: 0.6, rain: 0.75, bolt: 0, gust: 1.9 },
  storm: { cu: 0.1, sc: 0.3, cb: 0.7, fr: 0.7, ci: 0, layer: 0.85, layerDark: 0.8, dark: 0.8, dim: 0.85, wind: 12, mist: 0.25, haze: 0.5, rain: 1, bolt: 4, gust: 2.2 },
};

// Animals (heard and seen) keep away in any rain and come back over ~4 min once it stops: dry = real seconds since the
// rain stopped, back = 0..1 (audio.js, butterflies.js, fireflies.js, dragonflies.js). Set by updateWeather.
export const animals = { dry: 1e9, back: 1 };

// Current values, eased toward the target preset so a weather change rolls in instead of popping.
// byHour: 1 = the time of day scales the wind (daycycle.js), 0 = the Wind slider's speed as is.
export const weather = { ...PRESETS.fair, byHour: 1 };
let target = { ...weather };
// Easing time constants (s): ~90% of the way after 2.3 of them. The dev picker takes ~20 s, the wind answers the
// slider within seconds, real weather (followForecast) rolls in over a few minutes.
let pace = 8, windPace = 2;

export function setWeather(name, instant = false) {
  target = { ...(PRESETS[name] ?? PRESETS.fair), byHour: 1 };
  pace = 8;
  windPace = 2;
  if (instant) Object.assign(weather, target);
}

// Wind slider: sets the wind speed (m/s) until the weather changes again.
export function setWind(speed) { target = { ...target, wind: speed, byHour: 0 }; windPace = 2; }

// The forecast (forecast.js, via main.js): a new hour's weather and its measured wind (m/s, as is: the hourly
// data already has the day's rhythm) ease in over a few minutes; instant for the first hour after the data arrives.
// gust (m/s, wind_gusts_10m) sets the gust factor (1..3; the preset's without it).
export function followForecast(name, wind, instant = false, gust = null) {
  target = { ...(PRESETS[name] ?? PRESETS.fair), wind, byHour: 0 };
  if (gust > wind) target.gust = Math.min(3, gust / Math.max(wind, 1));
  pace = windPace = 60;
  if (instant) Object.assign(weather, target);
}

// Wind direction: the compass bearing it blows FROM (degrees, 0 = north, 90 = east; wind.js maps it onto the scene).
// It turns like a critically damped spring toward `to` (eases out and in, no overshoot): ~90% of a turn in 15 s, in
// ~65 s at the forecast's pace (slow). The first call, or instant, sets it at once.
export const windDir = { from: null, to: 0, vel: 0, slow: false };
const short = (d) => ((d % 360) + 540) % 360 - 180; // -180..180, the short way round

// Call every frame with the bearing to turn toward (main.js: pinned, forecast or wander).
export function setWindFrom(deg, slow = false, instant = false) {
  Object.assign(windDir, { to: deg, slow });
  if (instant || windDir.from === null) Object.assign(windDir, { from: deg, vel: 0 });
}

// No forecast: a prevailing wind that changes every 4 h (turning the short way over its last 72 min) and veers up to
// ±25° on top, from any side, the front or the back. Fixed by the scene clock (t in s), so every load agrees.
const BLOCK = 4 * 3600;
const hashDeg = (k) => { let s = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b); s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35); return (((s ^ (s >>> 16)) >>> 0) / 2 ** 32) * 360; };
export function wanderFrom(t) {
  const p = t / BLOCK, k = Math.floor(p), a = hashDeg(k), s = Math.min(1, Math.max(0, (p - k - 0.7) / 0.3));
  const veer = 15 * Math.sin(t / 1500) + 10 * Math.sin(t / 530);
  return (a + short(hashDeg(k + 1) - a) * s * s * (3 - 2 * s) + veer + 720) % 360;
}

// dt in real seconds.
export function updateWeather(dt) {
  animals.dry = weather.rain > 0.02 ? 0 : animals.dry + dt;
  const b = Math.min(1, (animals.dry - 20) / 220);
  animals.back = b > 0 ? b * b * (3 - 2 * b) : 0; // smoothstep 20..240 s (no three here: forecast-test runs this in node)
  const k = 1 - Math.exp(-dt / pace), kWind = 1 - Math.exp(-dt / windPace);
  for (const key in target) weather[key] += (target[key] - weather[key]) * (key === 'wind' || key === 'byHour' ? kWind : k);
  if (windDir.from === null) return;
  const w = windDir.slow ? 0.06 : 0.26;
  windDir.vel += (w * w * short(windDir.to - windDir.from) - 2 * w * windDir.vel) * dt;
  windDir.from = (windDir.from + windDir.vel * dt + 360) % 360;
}
