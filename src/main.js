import * as THREE from 'three';
import { uniforms, MOUNTAIN, EYE, heightAt } from './common.js';
import { makeTerrain } from './terrain.js';
import { makeGrass } from './grass.js';
import { makeTrees } from './tree.js';
import { makeRocks } from './rocks.js';
import { setTime, skyBodies } from './daycycle.js';
import { setWeather, setWind, followForecast, updateWeather, PRESETS, setWindFrom, wanderFrom } from './weather.js';
import { cloudLayer, updateClouds } from './clouds.js';
import { renderVolume } from './cloudvolume.js';
import { rainLayer, updateRain } from './rain.js';
import { lightningLayer, updateLightning } from './lightning.js';
import { riverLayer, updateRiver, setRiverRocks, renderReflection } from './river.js';
import { skyLayer, updateSky } from './sky.js';
import { updateWind } from './wind.js';
import { rocks, trees } from './layout.js';
import { mountainLayer } from './mountain.js';
import { debugViews } from './views.js';
import { settings, setSetting, onSetting, hourMinute } from './settings.js';
import { startAudio, updateAudio } from './audio.js';
import { requestForecast, pauseForecast, forgetForecast, forgetCache, forecastAt, forecastWhere } from './forecast.js';
import { dayHours } from './sun.js';
import { modelLayer, modelsReady } from './models.js';
import { initUI } from './ui.js';
import { clockLayer, updateClock } from './clock.js';
import { initAlarm } from './alarm.js';
import { renderShadows } from './shadow.js';
import { butterflyLayer, updateButterflies } from './butterflies.js';
import { leafLayer, updateLeaves } from './leaves.js';
import { fireflyLayer, updateFireflies } from './fireflies.js';
import { dragonflyLayer, updateDragonflies } from './dragonflies.js';
import { godRayLayer, updateGodRays, renderGodRays } from './godrays.js';
import { rainShaftLayer, updateRainShafts } from './rainshafts.js';
import { updateGlass, renderGlass } from './glass.js';

const renderer = new THREE.WebGLRenderer({ antialias: settings['quality.antialias'] }); // antialias can't change on a live context: next load
onSetting('quality.resolution', (r) => renderer.setPixelRatio(Math.min(devicePixelRatio, THREE.MathUtils.clamp(r, 0.5, 2))));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = uniforms.uFogColor.value; // horizon colour behind the sky dome (sky.js), e.g. if the dome is ever hidden

setRiverRocks(rocks); // foam around the rocks that stand in the water
const bare = rocks.map((r) => [r.x, r.z, r.size * 1.05]); // no grass inside rocks, short grass around them
const GRASS = 100000; // blades (the flowers are the model plants in layout.js)
const grass = makeGrass({ count: GRASS, avoid: bare });
const noReflection = [grass, rainLayer, clockLayer, godRayLayer]; // never seen in the river (river.js); the rays' slices face the main camera

scene.add(
  makeTerrain(),
  grass,
  makeRocks(rocks),
  makeTrees(trees),
  skyBodies,
  cloudLayer,
  godRayLayer,
  rainShaftLayer,
  rainLayer,
  lightningLayer,
  riverLayer,
  skyLayer,
  mountainLayer,
  modelLayer,
  butterflyLayer,
  leafLayer,
  fireflyLayer,
  dragonflyLayer,
  clockLayer,
);

// ?cam=px,py,pz,tx,ty,tz overrides the view (?view=<id> picks a dev view, views.js), ?time=HH:MM the starting
// time, ?weather=<preset> the weather, ?winddir=<deg> where the wind blows from (compass, 90 = from the front),
// ?date=YYYY-MM-DD the date (moon phase, star season) (used by tools/shot.mjs)
const params = new URLSearchParams(location.search);
// any dev param (tools/shot.mjs) pins the scene: no consent prompt, no forecast, same picture every run
const dev = ['time', 'cam', 'view', 'weather', 'winddir', 'date'].some((p) => params.has(p));
// One visit per page load, counted by the site's worker (worker.js; the GitHub Pages copy counts there too): a number
// per day, nothing about the viewer. Not from dev views, nor from a copy served without https (localhost).
if (!dev && location.protocol === 'https:') fetch('https://gclock.my.id/api/visit', { method: 'POST', mode: 'no-cors' }).catch(() => {});
const cam = params.get('cam')?.split(',').map(Number);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1200); // far enough for the clouds
const look = new THREE.Euler(0, 0, 0, 'YXZ');
const { clamp, degToRad } = THREE.MathUtils;
let free = false; // dev views (?cam, ?view, the View picker) turn without limits
let moved = false; // the viewer has turned or zoomed (a resize then keeps their view)

// The clock view: the eye 'camera.height' (2-8 m: middle-drag, the Camera tab) above the clock spot EYE, heading halfway
// between the big tree and the mountain summit so both are in view on any screen, looking 8.7° up at 1.5 m and ~1° less
// per metre higher (more meadow, the cap stays in view). A portrait screen centres on the big tree's crown edge (−18°) to
// the far end of the cap (+7°) instead, with a lens just wide enough for that span (~79° at 390x844).
const ground = heightAt(EYE.x, EYE.z), eyeHeight = () => clamp(settings['camera.height'], 2, 8); // a stored value can't leave the limits
function clockView() {
  const giant = trees.find((t) => t.type === 'giant') ?? { x: 0, z: -60 };
  const g = Math.atan2(giant.x, 11 - giant.z), m = Math.atan2(MOUNTAIN.x, 11 - MOUNTAIN.z); // right of -z
  const portrait = camera.aspect < 1, heading = portrait ? (g - degToRad(18) + m + degToRad(7)) / 2 : (g + m) / 2;
  const half = portrait ? (m - g + degToRad(25)) / 2 + degToRad(0.5) : 0;
  const fov = clamp(2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(half) / camera.aspect)), 50, maxFov());
  const h = eyeHeight();
  return { pos: [EYE.x, ground + h, EYE.z], target: [EYE.x + 15 * Math.sin(heading), ground + h + 2.3 - 0.26 * (h - 1.5), EYE.z - 15 * Math.cos(heading)], fov };
}
const maxFov = () => (camera.aspect < 1 ? 82 : 55);

// Look around: drag (or arrow keys) turns the head, wheel / pinch (or +/-) zooms; the camera never moves.
// Turning stops before the view reaches the edge of the grass (a ±69° wedge around -z); the half width
// counts the lower corners, which fan out wider on the ground when looking down.
function aim(dYaw, dPitch, zoom = 1) {
  if (dYaw || dPitch || zoom !== 1) moved = true;
  camera.fov = clamp(camera.fov * zoom, 20, maxFov());
  look.y += dYaw;
  look.x += dPitch;
  look.x = clamp(look.x, degToRad(free ? -89 : -20), degToRad(free ? 89 : 65)); // dev views too: never upside down
  if (!free) {
    const tanV = Math.tan(degToRad(camera.fov / 2)), down = Math.max(0, -look.x);
    const turn = Math.max(0, degToRad(66) - Math.atan((tanV * camera.aspect) / (Math.cos(down) - tanV * Math.sin(down))));
    look.y = clamp(look.y, -turn, turn);
  }
  camera.quaternion.setFromEuler(look);
  camera.updateProjectionMatrix();
}

function setView(v, isFree) {
  free = isFree;
  moved = false;
  camera.position.fromArray(v.pos);
  camera.fov = v.fov ?? 50;
  camera.lookAt(...v.target);
  look.setFromQuaternion(camera.quaternion, 'YXZ');
  aim(0, 0);
}
const views = debugViews(), viewPicker = document.getElementById('view');
const pickView = (id) => { const v = views.find((v) => v.id === id); setView(v ?? clockView(), !!v); };
if (cam) setView({ pos: cam.slice(0, 3), target: cam.slice(3, 6) }, true);
else pickView(params.get('view'));
onSetting('camera.height', () => { if (!free) { camera.position.y = ground + eyeHeight(); aim(0, 0); } }); // keeps the viewer's heading
viewPicker.append(new Option('clock view', 'clock'));
for (const v of views) {
  let group = [...viewPicker.children].find((g) => g.label === v.group);
  if (!group) viewPicker.append(group = Object.assign(document.createElement('optgroup'), { label: v.group }));
  group.append(new Option(v.name, v.id));
}
viewPicker.value = views.some((v) => v.id === params.get('view')) ? params.get('view') : 'clock';
viewPicker.addEventListener('change', () => pickView(viewPicker.value));

const canvas = renderer.domElement, pointers = new Map();
const perPixel = () => degToRad(camera.fov) / innerHeight; // the scene follows the finger at any zoom
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY, e.button]); });
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // middle button: no autoscroll
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (p[2] === 1) { if (!free) setSetting('camera.height', Math.round(clamp(eyeHeight() - (e.clientY - p[1]) * 0.02, 2, 8) * 100) / 100); } // middle-drag up raises the eye
  else if (pointers.size === 1) aim((e.clientX - p[0]) * perPixel(), (e.clientY - p[1]) * perPixel());
  else { // pinch: zoom by the change in finger spread
    const [a, b] = [...pointers.values()], before = Math.hypot(a[0] - b[0], a[1] - b[1]);
    p[0] = e.clientX; p[1] = e.clientY;
    aim(0, 0, before / Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])));
  }
  p[0] = e.clientX; p[1] = e.clientY;
});
const release = (e) => pointers.delete(e.pointerId);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); aim(0, 0, Math.exp(e.deltaY * 0.001)); }, { passive: false });
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, #panel, dialog')) return; // the sliders, pickers, tabs, panel scrolling and the alarm dialog use the keys themselves
  const step = degToRad(camera.fov) * 0.05, keys = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step], '+': [0, 0, 0.9], '=': [0, 0, 0.9], '-': [0, 0, 1.1] };
  if (keys[e.key]) { e.preventDefault(); aim(...keys[e.key]); }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  renderer.setSize(innerWidth, innerHeight);
  if (!free && !moved) setView(clockView(), false); // a rotated phone gets its own framing
  else aim(0, 0); // re-clamp: a narrower window allows less turning
});

// Time of day: starts at the real local time and keeps ticking; dragging the slider shifts it.
const slider = document.getElementById('time'), label = document.getElementById('time-label');
const realMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const pinned = params.get('time')?.split(':').map(Number);
// "Bypass local time" (settings 'time.bypass'): the scene and the clock keep running 1:1, 'time.offset' minutes from
// the real clock (the Time slider sets it; kept across reloads). Otherwise the slider's shift lasts for this visit.
const bypassed = () => settings['time.bypass'] && !dev;
let offset = pinned ? pinned[0] * 60 + (pinned[1] || 0) - realMinutes() : bypassed() ? settings['time.offset'] : 0;
const date = params.get('date'), dayShift = date ? Math.round((new Date(`${date}T00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5) * 86400 || 0 : 0; // a malformed ?date falls back to today
slider.addEventListener('input', () => { offset = Number(slider.value) - realMinutes(); if (bypassed()) setSetting('time.offset', offset); });
// the time the label, the clock and the alarm go by: real time + offset (local time maths: on a DST day they still agree)
const shownAt = (d) => { d.setTime(Date.now()); d.setSeconds(d.getSeconds() + Math.round(offset * 60)); return d; };
const shown = new Date();
initAlarm(() => shownAt(new Date()));
let timeFormat;
onSetting('clock.h24', (h24) => { timeFormat = new Intl.DateTimeFormat(undefined, hourMinute(h24)); });
onSetting('time.bypass', (on) => { if (!dev) on ? setSetting('time.offset', offset) : (offset = 0); }); // ticked: from the time shown, no jump

// Weather: the forecast drives it once the viewer allowed their location or chose a place (ui.js asks); the debug
// picker and Wind slider override it until "Back to live"; "Bypass location" (settings 'manual.on') keeps them in charge.
const picker = document.getElementById('weather');
picker.append(...Object.keys(PRESETS).map((name) => new Option(name, name)));
const liveWeather = PRESETS[params.get('weather')] ? params.get('weather') : 'fair'; // when there's no forecast
picker.value = liveWeather;
// Wind speed (m/s): starts at the weather's, dragging overrides it until the weather changes.
const windSlider = document.getElementById('wind'), windLabel = document.getElementById('wind-label');
const showWind = () => { windLabel.textContent = `${windSlider.value} m/s`; windSlider.setAttribute('aria-valuetext', windLabel.textContent); };
const pickWeather = (instant) => { setWeather(picker.value, instant); windSlider.value = PRESETS[picker.value].wind; showWind(); };
pickWeather(true);
let override = false, forecastKey = 'none';
picker.addEventListener('change', () => {
  override = true;
  pickWeather(false);
  if (settings['manual.on'] && !dev) { setSetting('manual.weather', picker.value); setSetting('manual.wind', PRESETS[picker.value].wind); }
});
windSlider.addEventListener('input', () => {
  override = true;
  setWind(Number(windSlider.value));
  showWind();
  if (settings['manual.on'] && !dev) setSetting('manual.wind', Number(windSlider.value));
});
// Wind direction (compass degrees it blows from): pinned by ?winddir, "Bypass location" or the Direction slider (until
// "Back to live"), else the forecast's, else a slow wander from the scene clock (weather.js). Shown from the clock view.
const dirParam = params.has('winddir') ? ((Number(params.get('winddir')) % 360) + 360) % 360 || 0 : null;
const dirSlider = document.getElementById('winddir'), dirLabel = document.getElementById('winddir-label');
const SIDES = ['the front', 'the front right', 'the right', 'the back right', 'behind', 'the back left', 'the left', 'the front left'];
let windFrom = dirParam, shownDir = null;
const showDir = (deg) => {
  shownDir = Math.round(deg / 15) % 24;
  dirSlider.value = shownDir * 15;
  dirLabel.textContent = `From ${SIDES[Math.round(((deg + 270) % 360) / 45) % 8]}`; // straight ahead is east (90)
  dirSlider.setAttribute('aria-valuetext', dirLabel.textContent);
};
dirSlider.addEventListener('input', () => {
  override = true;
  windFrom = Number(dirSlider.value);
  if (settings['manual.on'] && !dev) setSetting('manual.windDir', windFrom);
});
const live = () => { override = false; forecastKey = ''; windFrom = dirParam; if (!bypassed()) offset = 0; }; // a bypassed time stays
document.getElementById('live').addEventListener('click', () => { setSetting('time.bypass', false); setSetting('time.offset', 0); live(); setSetting('manual.on', false); });
onSetting('manual.on', (on) => { // (runs at once too: then off changes nothing, so ?time stays pinned)
  if (dev) return;
  if (!on) { if (override) live(); return; }
  pauseForecast(); // no requests while bypassed
  override = true;
  picker.value = PRESETS[settings['manual.weather']] ? settings['manual.weather'] : 'fair';
  pickWeather(false);
  windSlider.value = settings['manual.wind'];
  setWind(settings['manual.wind']);
  showWind();
  windFrom = settings['manual.windDir'];
});
let lastMs = 0;

// The forecast's source: the viewer's location once allowed, else a chosen place, else none (also at load); cached
// only with cookies accepted. ui.js sets place.name after place.lat/lon, so the name alone triggers.
const followSource = () => {
  if (dev) return;
  if (settings['privacy.storage'] !== true) forgetCache();
  if (settings['manual.on']) return;
  const place = settings['place.name'] && { lat: settings['place.lat'], lon: settings['place.lon'], name: settings['place.name'] };
  if (!settings['privacy.location'] && !place) return forgetForecast();
  requestForecast({ place: settings['privacy.location'] ? null : place, keep: settings['privacy.storage'] === true });
};
for (const key of ['manual.on', 'privacy.location', 'privacy.storage', 'place.name']) onSetting(key, followSource);
// Where the sun times come from (the bypasses too): the location (in use or cached), else the chosen place, else none
const sunPlace = () => (settings['privacy.location'] && forecastWhere())
  || (settings['place.name'] ? { lat: settings['place.lat'], lon: settings['place.lon'] } : null);
// Sound needs a user gesture before browsers let it play: a touch only counts on release, and every later gesture
// retries a context the browser left suspended (startAudio is safe to call again)
for (const type of ['pointerup', 'keydown']) addEventListener(type, startAudio);
initUI({ dev, debug: params.has('debug'), clockView: () => { viewPicker.value = 'clock'; pickView('clock'); } });
// html[data-ready] once a frame is drawn (tools/shot.mjs waits for it)
modelsReady.finally(() => requestAnimationFrame(() => requestAnimationFrame(() => { document.documentElement.dataset.ready = '1'; })));

renderer.setAnimationLoop((ms) => {
  // screens over ~105 Hz (120/144 Hz phones and monitors) draw every other refresh: the same calm scene for half the heat
  if (ms - lastMs < 9.5) return;
  uniforms.uTime.value = ms / 1000;
  const dt = Math.min(0.1, (ms - lastMs) / 1000);
  lastMs = ms;
  updateWeather(dt);
  const sceneSeconds = Date.now() / 1000 + offset * 60 + dayShift; // the scene clock: real time + slider offset
  const minutes = (((realMinutes() + offset) % 1440) + 1440) % 1440;
  const text = timeFormat.format(shownAt(shown));
  slider.value = minutes;
  if (label.textContent !== text) { label.textContent = text; slider.setAttribute('aria-valuetext', text); }
  const f = dev || override ? null : forecastAt(new Date(sceneSeconds * 1000)), key = f ? `${f.preset}/${f.wind}/${f.gust}` : 'none';
  let firstHour = false;
  if (!override && key !== forecastKey) { // a new forecast hour (eases in), the first one (at once), or no forecast any more
    const first = !forecastKey.includes('/');
    forecastKey = key;
    firstHour = first && !!f;
    picker.value = f?.preset ?? liveWeather;
    if (!f) pickWeather(false);
    else { followForecast(f.preset, f.wind, first, f.gust); windSlider.value = f.wind; showWind(); }
  }
  const from = windFrom ?? f?.dir ?? wanderFrom(sceneSeconds);
  setWindFrom(from, windFrom === null && f?.dir != null, firstHour); // turns slowly to a new forecast hour's
  if (Math.round(from / 15) % 24 !== shownDir) showDir(from);
  const hours = dev ? minutes / 60 : dayHours(sunPlace(), shown); // the place's real dawn, sunrise, ... dusk on the shown date land on the day cycle's
  setTime(hours);
  updateWind(dt, !dev); // after setTime, which sets the wind speed; random gusts only live (dev pins the scene)
  updateSky(sceneSeconds, hours, camera);
  updateClouds(sceneSeconds, hours, camera); // clouds follow the scene clock
  updateGodRays(sceneSeconds, hours, camera, dt);
  updateRainShafts(sceneSeconds, camera); // after the clouds: curtains under the far rain clouds
  updateLightning(sceneSeconds, camera, dt); // after setTime: a flash brightens the light it set
  updateRain(sceneSeconds, camera, dt);
  updateGlass(dt, camera); // drops on the glass in front of the view
  updateRiver(sceneSeconds, camera, dt);
  updateButterflies(sceneSeconds, hours, camera, dt); // meadow life (docs/LIFE.md)
  updateLeaves(sceneSeconds, hours, camera, dt);
  updateFireflies(sceneSeconds, hours, camera, dt);
  updateDragonflies(sceneSeconds, hours, camera, dt);
  updateAudio(dt, hours, camera, sceneSeconds);
  updateClock(shown, hours, camera, dt);
  skyBodies.position.copy(camera.position);
  renderVolume(renderer, camera); // the clouds: weather maps, sun shadow map, march (before anything samples them)
  renderShadows(renderer, scene); // the light's shadow map, before anything samples it
  renderReflection(renderer, scene, camera, noReflection); // the river's mirror image
  renderGodRays(renderer); // the god rays' light map (after renderVolume: it marches the same clouds)
  renderer.render(scene, camera);
  renderGlass(renderer); // over the finished frame
});
