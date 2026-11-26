// Viewer settings (the (i) panel): flat keys with change listeners, kept in localStorage once the viewer accepts
// ('privacy.storage'; declined = only that answer is kept, the rest lasts for this visit).
// Every module reads its own keys: settings[key], onSetting(key, fn) (fn(value) now and on every change).
import { EYE_HEIGHT } from './common.js';

// touch-first screens (phones, tablets): their GPUs pay for every pixel, and 1.5x still looks sharp there (NOTES.md → Performance)
const PHONE = !!globalThis.matchMedia?.('(hover: none) and (pointer: coarse)').matches;

export const DEFAULTS = {
  'camera.height': EYE_HEIGHT, // eye height above the clock spot (m); middle-drag or the Camera tab changes it
  'volume.master': 0.8,
  'volume.birds': 1,
  'volume.crickets': 1,
  'volume.bees': 1,
  'volume.wind': 1,
  'volume.rain': 1,
  'volume.thunder': 1,
  'volume.river': 0.5, // a little way off from the clock spot
  'volume.frogs': 1,
  'volume.alarm': 1,
  'sound.stabilize': true, // volume stabilization: storms, gusts and thunder stay nearer the usual level (audio.js)
  // one switch per bird species (audio.js BIRDS ids; the Sound tab lists them)
  ...Object.fromEntries(['dove', 'greattit', 'bluetit', 'robin', 'blackbird', 'thrush', 'wren', 'chaffinch', 'crow'].map((id) => [`birds.${id}`, true])),
  'quality.grass': 1, // fraction of grass blades drawn
  'quality.antialias': true, // applies on reload
  'quality.reflections': true, // the river mirrors the banks, trees and sky
  'quality.shadows': true, // tree shadows from a shadow map (off: soft blobs)
  'glass.rain': true, // raindrops on the glass in front of the view when it rains (glass.js)
  'quality.resolution': PHONE ? 1.5 : 2, // pixel ratio's upper limit; the device's own ratio if lower
  'manual.on': false, // "Bypass location": the weather and wind controls drive the scene, no forecast
  'manual.weather': 'fair',
  'manual.wind': 3,
  'manual.windDir': 15, // degrees the wind blows from (compass: 0 = north = left of the clock view, 90 = east = ahead); 15 = from the left
  'time.bypass': false, // "Bypass local time": the scene and the clock run time.offset ahead of the real clock
  'time.offset': 0, // minutes
  // the clock tab (clock.js draws it)
  'clock.on': true,
  'clock.type': 'digital',
  'clock.layer': 'behind', // behind = mountain, trees and clouds cover it; mountain = in front of the mountain only;
  //                          clouds = in front of the mountain and clouds, trees still cover it; front = in front of everything
  'clock.font': 'serif',
  'clock.seconds': false,
  'clock.h24': !/h1[12]/.test(new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hourCycle), // the viewer's locale (h11/h12 = 12-hour)
  'clock.x': 0, // shift from the default spot, in screen widths
  'clock.y': 0, // in screen heights, up
  'clock.size': 1, // x the default size
  'clock.color': '#ffe9b8',
  'clock.glow': 0.6,
  'clock.transparency': 0,
  'clock.borderColor': '#fff4dc',
  'clock.borderTransparency': 0.4,
  'clock.borderGlow': 0.5,
  'clock.outline': 0, // the digits' own outline (0 = none) and its colour
  'clock.outlineColor': '#5a3d1e',
  'clock.shadow': 0, // a soft drop shadow behind the digits (0 = none) and its colour
  'clock.shadowColor': '#000000',
  // alarm (alarm.js): rings at the clock's shown time
  'alarm.on': false,
  'alarm.time': 420, // minutes since midnight
  'alarm.snooze': 5, // minutes
  // sound timing (x normal): how often birds come by, how chatty they are, lightning in storms, bee visits
  'often.birds': 1,
  'often.calls': 1,
  'often.thunder': 1,
  'often.bees': 1,
  // meadow life (docs/LIFE.md): x normal, 0 = none
  'life.butterflies': 1,
  'life.fireflies': 1,
  'life.dragonflies': 1,
  'life.leaves': 1,
  'privacy.storage': null, // cookies (localStorage): null = not asked yet, true = accepted, false = declined
  'privacy.location': null, // null = not asked yet, true = accepted, false = declined
  // a place the viewer chose instead of sharing their location (name '' = none); rounded to ~1 km
  'place.name': '',
  'place.lat': 0,
  'place.lon': 0,
};

// the panel's slider ranges; stored or set values are clamped to them
const RANGES = {
  'camera.height': [2, 8], 'quality.grass': [0.1, 1], 'quality.resolution': [0.5, 2], 'manual.wind': [0, 20], 'time.offset': [-1440, 1440],
  'clock.x': [-0.5, 0.5], 'clock.y': [-0.5, 0.5], 'clock.size': [0.4, 2.5], 'clock.transparency': [0, 0.9], 'alarm.time': [0, 1439], 'alarm.snooze': [1, 30],
  'manual.windDir': [0, 360], 'place.lat': [-90, 90], 'place.lon': [-180, 180],
};
const range = (k) => RANGES[k] ?? (/^(volume\.|clock\.(glow|outline$|shadow$|border(Transparency|Glow)))/.test(k) ? [0, 1] : k.startsWith('often.') ? [0, 3] : k.startsWith('life.') ? [0, 2] : null);
// 'clock.h24' as Intl options, hours and minutes: the clock, the Time label (main.js) and the alarm (alarm.js) all show it so
export const hourMinute = (h24) => ({ hour: h24 ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: h24 ? 'h23' : 'h12' });
export const CHOICES = {
  'clock.type': ['digital', 'analog'],
  'clock.layer': ['behind', 'mountain', 'clouds', 'front'],
  'clock.font': ['serif', 'script', 'fantasy', 'geometric', 'segment', 'sans'], // clock.js maps them to the fonts in public/fonts
};
const COLOR = /^#[0-9a-f]{6}$/i;
// a value of the right kind for k, or undefined: numbers clamped, the location answer only true or false (or unasked)
function valid(k, v) {
  const d = DEFAULTS[k];
  if (d === null) return v === true || v === false ? v : undefined;
  if (typeof v !== typeof d || (typeof v === 'number' && !Number.isFinite(v))) return undefined;
  if (CHOICES[k] && !CHOICES[k].includes(v)) return undefined;
  if (k.endsWith('olor') && !COLOR.test(v)) return undefined; // clock.*olor: #rrggbb only
  const r = range(k);
  if (typeof v === 'number' && k.startsWith('alarm.')) v = Math.round(v); // whole minutes (a stored 420.5 blanked the time box)
  return r ? Math.min(r[1], Math.max(r[0], v)) : v;
}

const KEY = 'scenic-clock-settings';
const listeners = new Map();
let stored = {};
try {
  stored = JSON.parse(localStorage.getItem(KEY)) ?? {};
  // renamed from quality.pixelRatio (2026-11-03): its old default 2 gives way to the new one (1.5 on phones), a chosen value stays
  if (!('quality.resolution' in stored) && stored['quality.pixelRatio'] !== 2) stored['quality.resolution'] = stored['quality.pixelRatio'];
} catch { /* private mode, blocked storage or a broken entry: defaults */ }
export const settings = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, valid(k, stored[k]) ?? v]));

function save() {
  const keep = settings['privacy.storage'] === true ? settings : settings['privacy.storage'] === false ? { 'privacy.storage': false } : null;
  try { if (keep) localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* not saved: still works for this visit */ }
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  value = valid(key, value);
  if (value === undefined || settings[key] === value) return;
  settings[key] = value;
  save();
  for (const fn of listeners.get(key) ?? []) fn(value);
}

export function onSetting(key, fn) {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(fn);
  fn(settings[key]);
}

// Back to the defaults, except the privacy answers and the chosen place (the Location tab changes those).
export function resetSettings() {
  for (const [k, v] of Object.entries(DEFAULTS)) if (!/^(privacy|place)\./.test(k)) setSetting(k, v);
}
