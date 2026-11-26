// The real sun for the scene: dawn, sunrise, solar noon, sunset and dusk for a place and date, worked out on the
// device (NOAA's solar equations, no network), and the remap of local clock hours onto the day cycle's hours, so the
// scene shows each moment when it happens there.
//   sunTimes(lat, lon, utcDay)   { noon, dawn: [rise, civil, nautical], dusk: [set, civil, nautical] } as ms; utcDay =
//                                Date.UTC(y, m, d) of the date. An event that doesn't happen that day falls on solar
//                                noon (the sun stays below that height) or 12 h from it (it stays above)
//   solarRemap(rel, dawn, dusk)  day-cycle hours for rel = clock hours from solar noon (-12..12), dawn / dusk = hours
//                                from each dawn event to noon / from noon to each dusk event (as sunTimes')
//   dayHours(where, date)        day-cycle hours at that moment (a Date) at { lat, lon }; null: its local clock hours

const RAD = Math.PI / 180;
const DEPTHS = [0.833, 6, 12]; // degrees below the horizon: sunrise/sunset (refraction, the disc's radius), civil, nautical
// Day-cycle hours from noon where the scene's sun is that low (daycycle.js: sin(elevation) = 0.866 cos(π (h - 12) / 12),
// before 06:00 mirrored): sunrise/sunset on the scene's horizon at 06:00/18:00, civil dusk 18:28, nautical dusk 18:56
// (sky.js is fully dark from 19:10, between nautical and astronomical, so deeper events add nothing).
const SCENE = [6, 6.462, 6.926];
// shortcut: where an event doesn't happen (polar day or night, white nights), it sits GAP h from its neighbour toward
// noon or midnight, so the scene still runs through its whole cycle, quickly (30 min of night under a midnight sun);
// upgrade by letting the day cycle hold at the real sun's height (daycycle.js would need the elevation, not the hour).
const GAP = 0.25;

// Declination (rad) and equation of time (min) at that moment (NOAA solar calculator).
function sunAt(ms) {
  const T = (ms / 864e5 - 10957.5) / 36525; // Julian centuries since J2000.0
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) * RAD, M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * RAD;
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T), omega = (125.04 - 1934.136 * T) * RAD;
  const C = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M) * (0.019993 - 0.000101 * T) + Math.sin(3 * M) * 0.000289;
  const lambda = L0 + (C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps = (23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega)) * RAD;
  const y = Math.tan(eps / 2) ** 2;
  const eot = y * Math.sin(2 * L0) - 2 * e * Math.sin(M) + 4 * e * y * Math.sin(M) * Math.cos(2 * L0) - 0.5 * y * y * Math.sin(4 * L0) - 1.25 * e * e * Math.sin(2 * M);
  return { decl: Math.asin(Math.sin(eps) * Math.sin(lambda)), eot: (4 * eot) / RAD };
}

export function sunTimes(lat, lon, utcDay) {
  const phi = lat * RAD, base = utcDay + 432e5 - lon * 240e3; // mean solar noon there
  const at = (depth, sign) => { // sign -1 dawn, 1 dusk, 0 noon; two passes with the sun's place at the event itself
    let t = base;
    for (let k = 0; k < 2; k++) {
      const { decl, eot } = sunAt(t);
      const c = (Math.sin(-depth * RAD) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
      t = base - eot * 60e3 + sign * (Math.acos(Math.min(1, Math.max(-1, c))) / RAD) * 240e3;
    }
    return t;
  };
  return { noon: at(0, 0), dawn: DEPTHS.map((d) => at(d, -1)), dusk: DEPTHS.map((d) => at(d, 1)) };
}

export function solarRemap(rel, dawn, dusk) {
  const fit = (d) => d.map((h, k) => Math.min(12 - (3 - k) * GAP, Math.max((k + 1) * GAP, h))); // in order, apart
  const a = fit(dawn), b = fit(dusk);
  const x = [-12, -a[2], -a[1], -a[0], 0, ...b, 12], y = [-12, -SCENE[2], -SCENE[1], -SCENE[0], 0, ...SCENE, 12];
  let i = 1;
  while (i < 8 && rel > x[i]) i++;
  return 12 + y[i - 1] + ((y[i] - y[i - 1]) * (rel - x[i - 1])) / (x[i] - x[i - 1]);
}

const clockHours = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
const days = new Map(); // a few days' sun times per place, worked out once
function dayAt(where, utcDay) {
  const key = `${where.lat},${where.lon},${utcDay}`;
  if (!days.has(key)) {
    if (days.size > 4) days.clear();
    const { noon, dawn, dusk } = sunTimes(where.lat, where.lon, utcDay);
    days.set(key, { noon, dawn: dawn.map((t) => (noon - t) / 36e5), dusk: dusk.map((t) => (t - noon) / 36e5) });
  }
  return days.get(key);
}

export function dayHours(where, date) {
  if (!where) return clockHours(date);
  // the day whose solar noon is nearest: it changes at solar midnight, where every day maps to 0/24; all in real time
  // from that noon, so a DST change moves nothing. Noons are 24 h ± 30 s apart: the clamp holds midnight that long.
  const utcDay = Math.round((date - 432e5 + where.lon * 240e3) / 864e5) * 864e5; // by the mean noon, then the true one
  let day = dayAt(where, utcDay);
  if (Math.abs(date - day.noon) > 432e5) day = dayAt(where, utcDay + Math.sign(date - day.noon) * 864e5);
  return solarRemap(Math.max(-12, Math.min(12, (date - day.noon) / 36e5)), day.dawn, day.dusk);
}
