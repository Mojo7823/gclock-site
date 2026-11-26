// Local weather for the scene: the viewer's location (browser geolocation, IP lookup as a fallback, rounded to
// ~1 km) or a place they chose, two days of hourly weather from Open-Meteo (no key), cached for an hour. Contract
// used by main.js and ui.js:
//   requestForecast({ place, keep })  after the viewer allowed their location (place null: locate) or chose a place
//                         ({ lat, lon, name }: no locating at all); keep = cookies accepted (cache in localStorage,
//                         otherwise none and any old cache removed). Fetches 24 h, refreshes itself every hour until
//                         forgetForecast(); no argument = the same source again. Another source drops the old data.
//   forgetForecast()      the viewer declined or revoked: drop location and cached data
//   searchPlaces(text)    "Choose a place": up to 5 { name: 'Name, region, country', lat, lon } (Open-Meteo geocoding)
//   pauseForecast()       bypass: stop refreshing, keep the cache
//   forecastAt(date)      the weather for that moment: { preset (weather.js PRESETS key), wind (m/s), gust (m/s),
//                         dir (degrees the wind blows from, or null), precipitation (mm in that hour) } or null (no data, outside the 2 days, unknown code)
//   forecastWhere()       { lat, lon } (rounded) of the location or place in use, else of the cached one, or null:
//                         the sun times for the scene (sun.js)
//   forecastStatus        { state: 'off' | 'locating' | 'loading' | 'ready' | 'error', place, updated (Date), message }
//   onForecast(fn)        fn(forecastStatus) now and on every status change
//   DATA_CREDITS          [{ name, url, license, licenseUrl, note }] for the credits panel
// Nothing here runs or touches the network until requestForecast() or searchPlaces(): asking for consent is the caller's job.

const HOUR = 3600e3;
const KEY = 'scenic-clock-forecast'; // { lat, lon, place, src (keyOf), fetched (ms), hourly } as Open-Meteo sends it (older caches also have daily)
const IP_URL = 'https://get.geojs.io/v1/ip/geo.json';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=';
const API = 'https://api.open-meteo.com/v1/forecast?hourly=weather_code,cloud_cover,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m'
  + '&wind_speed_unit=ms&timezone=auto&timeformat=unixtime&forecast_days=2'; // today + tomorrow covers the next 24 h

// WMO weather code -> PRESETS key. The scene has no fog or snow: fog and light snow are overcast, steadier snow
// light rain. 0-2 also look at the cloud cover (presetFor).
const CODES = {
  0: 'clear', 1: 'fair', 2: 'cloudy', 3: 'overcast', 45: 'overcast', 48: 'overcast',
  51: 'lightrain', 53: 'lightrain', 55: 'lightrain', 56: 'lightrain', 57: 'lightrain', 61: 'lightrain', 80: 'lightrain',
  63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain', 81: 'rain', 82: 'rain',
  71: 'overcast', 77: 'overcast', 85: 'overcast', 73: 'lightrain', 75: 'lightrain', 86: 'lightrain',
  95: 'storm', 96: 'storm', 99: 'storm',
};
const SKY = ['clear', 'fair', 'cloudy'];

// Codes 0-2 take the cloudier of the code and the cloud cover (%): a "clear" hour with 50% cover is fair.
export function presetFor(code, cover) {
  const preset = CODES[code] ?? null, sky = SKY.indexOf(preset);
  return sky < 0 ? preset : SKY[Math.max(sky, cover > 70 ? 2 : cover > 30 ? 1 : 0)];
}

export const forecastStatus = { state: 'off', place: null, updated: null, message: '' };
const listeners = [];
let data = null, here = null, pending = null, timer = 0, generation = 0, peek, source = { place: null, keep: false };
const keyOf = (s) => (s.place ? `${s.place.lat},${s.place.lon},${s.place.name}` : 'here');

export function onForecast(fn) { listeners.push(fn); fn(forecastStatus); }

function status(state, message = '') {
  Object.assign(forecastStatus, { state, message, place: data?.place ?? here?.place ?? null, updated: data ? new Date(data.fetched) : null });
  for (const fn of listeners) fn(forecastStatus);
}

export function requestForecast(next) {
  if (next) {
    next = { place: null, keep: false, ...next };
    if (keyOf(next) !== keyOf(source)) drop(); // another source: its data and any request in flight don't apply
    source = next;
    if (!source.keep) try { localStorage.removeItem(KEY); } catch { /* blocked storage: nothing was cached */ }
  }
  if (!pending) { const p = pending = refresh().finally(() => { if (pending === p) pending = null; }); }
  return pending;
}

function drop() {
  generation++; // a request still in flight drops its answer
  clearTimeout(timer);
  pending = data = here = null;
  peek = undefined; // the next source's cache, read again
}

// Bypass location: stop refreshing (timer and any request in flight) but keep the cache for later.
export function pauseForecast() {
  generation++;
  clearTimeout(timer);
  pending = null;
}

export function forgetForecast() {
  drop();
  forgetCache();
  status('off');
}

// Cookies declined: no forecast (location, place, weather) kept on the device, even while bypassed.
export function forgetCache() {
  try { localStorage.removeItem(KEY); } catch { /* blocked storage: nothing was cached */ }
  peek = null;
}

async function refresh() {
  clearTimeout(timer);
  const gen = generation;
  const { place, keep } = source, src = keyOf(source);
  data ??= keep ? load(src) : null; // the last good data stays in use while refetching and when offline
  if (data && fresh(data)) return ready(); // synchronous: a fresh cache is in place before the first frame
  try {
    status(place ? 'loading' : 'locating');
    const where = place ? at(place.lat, place.lon, place.name) : here ?? await locate();
    if (gen !== generation) return;
    here = where;
    status('loading');
    const res = await fetch(`${API}&latitude=${here.lat}&longitude=${here.lon}`);
    const { hourly } = res.ok ? await res.json() : {};
    const next = { ...here, src, fetched: Date.now(), hourly };
    if (gen !== generation) return;
    if (!valid(next)) throw new Error('unexpected answer');
    data = next;
    if (keep) try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* not cached: refetched next visit */ }
    ready();
  } catch (e) {
    if (gen !== generation) return;
    if (e?.code === 1) return status('error', 'Your browser blocks location for this site, so local weather is off.'); // no retry
    status('error', forecastStatus.state === 'locating' ? 'Could not find your location.' : 'Could not reach the weather service.');
    timer = setTimeout(requestForecast, 15 * 60e3);
  }
}

// Refetch when the data is an hour old or the date changes, whichever comes first.
function ready() {
  status('ready');
  timer = setTimeout(requestForecast, Math.max(60e3, Math.min(data.fetched + HOUR, new Date().setHours(24, 0, 0, 0)) - Date.now()));
}

function fresh(d) {
  const age = Date.now() - d.fetched;
  return age >= 0 && age < HOUR && new Date(d.fetched).toDateString() === new Date().toDateString();
}

function valid(d) {
  const h = d?.hourly, n = h?.time?.length;
  return Number.isFinite(d?.fetched) && Number.isFinite(h?.time?.[0])
    && ['weather_code', 'cloud_cover', 'wind_speed_10m'].every((k) => Array.isArray(h[k]) && h[k].length === n);
}

// The cache only counts for the source it was fetched for (an older cache without src: refetched once).
function load(src) {
  try { const d = JSON.parse(localStorage.getItem(KEY)); return valid(d) && d.src === src ? d : null; } catch { return null; }
}

// Browser location first (low accuracy, a cached fix is fine); unavailable or no answer: by IP address. A Block
// in the browser's prompt is a no, so no IP lookup then either.
function locate() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), reject, { enableHighAccuracy: false, timeout: 10e3, maximumAge: HOUR });
    setTimeout(reject, 30e3); // the timeout above only starts once the browser's own permission prompt is answered
  }).then((c) => at(c.latitude, c.longitude)).catch(async (err) => {
    if (err?.code === 1) throw err; // PERMISSION_DENIED
    const res = await fetch(IP_URL);
    const j = res.ok ? await res.json() : {};
    return at(Number(j.latitude), Number(j.longitude), [j.city, j.country].filter((s) => typeof s === 'string' && s).join(', '));
  });
}

// Rounded to 2 decimals (~1 km) before anything is sent or stored.
function at(lat, lon, name) {
  lat = Math.round(lat * 100) / 100;
  lon = Math.round(lon * 100) / 100;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error('no location');
  return { lat, lon, place: name || `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}` };
}

// Throws when the search can't be reached; [] for no match. Names come from the API: callers show them as text only.
export async function searchPlaces(text) {
  text = String(text).trim();
  if (text.length < 2) return []; // the API matches nothing shorter
  const res = await fetch(GEO_URL + encodeURIComponent(text));
  if (!res.ok) throw new Error('place search failed');
  const { results } = await res.json();
  return (Array.isArray(results) ? results : []).flatMap((r) => {
    const name = [...new Set([r.name, r.admin1, r.country])].filter((s) => typeof s === 'string' && s).join(', ').slice(0, 100);
    if (!name || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return [];
    try { const { lat, lon } = at(r.latitude, r.longitude, name); return [{ name, lat, lon }]; } catch { return []; }
  }).slice(0, 5);
}

// Hourly values are fixed for the whole hour; wind clamped to the Wind slider's 0-20 m/s.
export function forecastAt(date) {
  const h = data?.hourly;
  if (!h) return null;
  const i = Math.floor((date / 1000 - h.time[0]) / 3600);
  if (!(i >= 0 && i < h.time.length)) return null;
  const preset = presetFor(h.weather_code[i], h.cloud_cover[i]), wind = h.wind_speed_10m[i];
  if (!preset || !Number.isFinite(wind)) return null;
  return { preset, wind: Math.round(Math.min(20, Math.max(0, wind)) * 10) / 10, gust: h.wind_gusts_10m?.[i] ?? null, dir: h.wind_direction_10m?.[i] ?? null, precipitation: h.precipitation?.[i] ?? null };
}

// Bypassed since the page loaded, nothing is requested: the cached source's coordinates stand in (read once).
export function forecastWhere() {
  if (peek === undefined) peek = load(keyOf(source));
  return here ?? data ?? peek;
}

export const DATA_CREDITS = [
  {
    name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    note: 'Weather data by Open-Meteo.com. Free API for non-commercial use only (under 10,000 calls a day): https://open-meteo.com/en/terms',
  },
  {
    name: 'GeoJS', url: 'https://www.geojs.io/', license: 'Free API, GeoLite2 data by MaxMind', licenseUrl: 'https://www.maxmind.com',
    note: 'Approximate location from the IP address when the browser shares none. This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com. No key, no stated rate limit, no access logs (https://www.geojs.io/privacy/).',
  },
  {
    name: 'GeoNames', url: 'https://www.geonames.org/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    note: 'Place search by the Open-Meteo geocoding API; location data based on GeoNames.',
  },
];
