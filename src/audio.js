import * as THREE from 'three';
import { uniforms, hash, EYE, riverZ, riverHalfWidth } from './common.js';
import { weather, animals } from './weather.js';
import { sunDir } from './daycycle.js';
import { onStrike, strikeAt } from './lightning.js';
import { settings, onSetting } from './settings.js';
import { trees } from './layout.js';
import { gust } from './wind.js';

// Ambient sound: real field recordings (public/sounds/, built by tools/sounds/make.py) mixed from the scene
// state. Contract used by main.js and ui.js:
//   startAudio()          call from a user gesture (browsers block audio before one); safe to call again
//   updateAudio(dt, hours, camera, sceneSeconds)   every frame: dt real seconds, hours = scene time of day
//                         (0..24), sceneSeconds = the scene clock (s; seeds the bird and bee schedules)
//   audioMix              { birds, crickets, frogs, bees, wind, rain, thunder, river }: each channel's target gain
//                         (0..1, before the viewer's volume), plus odds: each species' chance of being around now
//                         ('robin* 38% · ...', * = around) for the debug menu; audioMix.present (hidden): the species
//                         around now ('dove wren'), for tests; audioMix.log = [] (hidden) records every bird and frog call { t, id, take, gain, x, z, pan, rate };
//                         audioMix.pan (hidden): each placed loop's stereo pan this frame, by file name
//   BIRDS                 [{ id, name, ... }]: the species (the Sound tab lists them; 'birds.<id>' turns one off)
//   birdCall(b, slot, hours, k)   the call species b makes in call slot `slot` (or null): pure, for tests
//   FROGS, frogCall(f, slot, hours, k), frogWeather(rain, wet, wind)   the frogs by the river, the same way (pure, for tests)
//   thunderGain(distance, type)   a strike's thunder loudness (pure, for tests)
//   SOUND_CREDITS         [{ title, author, url, license, licenseUrl, file, changes }] for the credits panel
// Volumes come from settings.js ('volume.master', 'volume.<channel>', 'birds.<id>'), read here with onSetting / settings;
// so do the timings ('often.birds' presence, 'often.calls' call chance, 'often.bees' bursts; 0 = never, 1 = normal).
const { smoothstep, clamp } = THREE.MathUtils;
const PAD = 0.25; // s of wrap-around before and after each loop in the file (tools/sounds/make.py)
const CHANNELS = ['birds', 'crickets', 'frogs', 'bees', 'wind', 'rain', 'thunder', 'river'];
// Places: sources sit in the world and are panned from the camera's heading every frame (StereoPanner), so turning the
// view moves them; one behind is a touch quieter (x0.7). A place is kept as a vector from the clock spot: its direction,
// and its length how focused it is (1 = a point; the river or the trees, spread wide, pan less and fade less behind).
// shortcut: directions are from EYE, not camera.position (only the dev views move the camera); use the camera's position
// if the eye can ever walk.
const toward = (x, z) => { const d = Math.hypot(x - EYE.x, z - EYE.z) || 1; return [(x - EYE.x) / d, (z - EYE.z) / d, d]; };
function spread(pts) { // [[x, z, weight = 1], ...] -> [dx, dz]
  let x = 0, z = 0, w = 0;
  for (const [px, pz, pw = 1] of pts) { const [ux, uz] = toward(px, pz); x += pw * ux; z += pw * uz; w += pw; }
  return [x / w, z / w];
}
// leaves rustle from the trees, each by height / distance: ~2:1 on the left of the clock view (pan -0.3 there)
const TREES = trees.map((t) => [t.x, t.z, t.height / toward(t.x, t.z)[2]]);
// the river along its line, by 1 / distance (37 m away at its nearest, ahead and wide)
const RIVER = Array.from({ length: 31 }, (_, i) => { const x = 10 * i - 150, z = riverZ(x); return [x, z, 1 / toward(x, z)[2]]; });
// [file, channel, loop length in s (= its len in tools/sounds/make.py), place, playback rate]. place: none = as recorded
// (the stereo beds), [x, z] = a point in the world, [[x, z, w], ...] = spread over points, 'wide' = two copies half a loop
// apart panned -0.7 / 0.7 (mono rain all around), 'moving' = set every frame in updateAudio (bees, the air). A placed loop
// (a campfire, say) is one entry: ['campfire', <channel>, <len>, [x, z]] plus its level in updateAudio.
// level = target gain, set = last value sent; p = pan now, ps = last pan sent. cricket-1..3: single close crickets in the
// meadow (in the clock view at pan -0.55, 0.6, 0.15), each with its own pitch, over the chorus.
const LOOPS = [
  ['crickets', 'crickets', 50], ['cricket-1', 'crickets', 12, [-2, 6.5], 1.08], ['cricket-2', 'crickets', 20, [5, 6], 0.96], ['cricket-3', 'crickets', 18, [3, 2.5], 1.05],
  ['bees', 'bees', 46, 'moving'], ['wind-strong', 'wind', 60, TREES], ['wind-calm', 'wind', 110, 'moving'],
  ['rain-light', 'rain', 60, 'wide'], ['rain-heavy', 'rain', 36, 'wide'], ['rain-ground', 'rain', 50], ['river', 'river', 60, RIVER],
].map(([name, ch, len, at, rate = 1]) => {
  const [dx, dz] = Array.isArray(at) ? spread(Array.isArray(at[0]) ? at : [at]) : [0, 0];
  return { name, ch, len, rate, placed: !!at && at !== 'wide', wide: at === 'wide', dx, dz, p: 0, ps: NaN, boost: 1, level: 0, set: -1, offAt: 0, gain: null, pan: null, copies: null, source: null, source2: null, buffer: null };
});
const loop = Object.fromEntries(LOOPS.map((l) => [l.name, l]));
// the camera's heading on the ground (unit, set each frame); pan = along its right (-fz, fx), behind: x0.85 side, x0.7 back
let fx = 0, fz = -1;
const panOf = (dx, dz) => dz * fx - dx * fz;
const behind = (dx, dz) => 0.85 + 0.15 * (dx * fx + dz * fz);
// birds perch in the trees and bushes within 50 m (19, 12 of them on the left of the clock view)
const PERCHES = trees.filter((t) => toward(t.x, t.z)[2] < 50);
// thunder one-shots by distance: close cracks, a clap with a rolling tail, far rumbles
const THUNDER = { near: ['thunder-near-1', 'thunder-near-2'], mid: ['thunder-mid', 'thunder-near-1'], far: ['thunder-far-1', 'thunder-far-2'] };
const SOFT_CLIP = Float32Array.from({ length: 2049 }, (_, i) => {
  const x = i / 1024 - 1, a = Math.abs(x);
  return a <= 0.45 ? x : Math.sign(x) * (0.45 + 0.045 * Math.tanh((a - 0.45) / 0.045)); // tops out at 0.99 (the 2x oversampling rings a little)
});
const MAX_THUNDER = 6; // scheduled or playing at once; more are skipped (3 left ~30% of storm strikes silent)

// Birds: short real calls (bird-<id>-<n>.mp3, n = 1..takes, tools/sounds/make.py BIRDS), never a loop. Each species likes
// some hours (scene hours: 6 = sunrise, 18 = sunset; [from, to, activity] with 0.5 h ramps), comes and goes (visit:
// [shortest, longest stay, cycle] in minutes: one stay at a hashed time per cycle, none with probability skip) and while
// there calls every ~gap s at irregular times, busier or quieter minute by minute. level: its loudness (x 0.35..1 per call).
// Cycles are 0.8x the first ones: 25% more visits at 'often.birds' 1x (tools/sound-test.mjs keeps the old ones to compare).
export const BIRDS = [
  { id: 'dove', name: 'Mourning dove', takes: 3, hours: [[5.25, 10, 1], [10, 13, 0.25]], visit: [10, 35, 44], skip: 0.2, gap: 14, level: 0.8 },
  { id: 'greattit', name: 'Great tit', takes: 3, hours: [[5.5, 10, 1], [10, 16, 0.2]], visit: [10, 30, 36], skip: 0.15, gap: 7, level: 0.55 },
  { id: 'bluetit', name: 'Blue tit', takes: 3, hours: [[6, 10.5, 1], [10.5, 16, 0.2]], visit: [8, 25, 40], skip: 0.2, gap: 6, level: 0.5 },
  { id: 'robin', name: 'European robin', takes: 4, hours: [[5, 8.5, 1], [8.5, 16.5, 0.15], [16.5, 19.5, 0.9]], visit: [10, 30, 40], skip: 0.15, gap: 8, level: 0.55 },
  { id: 'blackbird', name: 'Blackbird', takes: 4, hours: [[5, 8, 0.8], [8, 17, 0.1], [17, 19.75, 1]], visit: [10, 35, 48], skip: 0.15, gap: 9, level: 0.6 },
  { id: 'thrush', name: 'Song thrush', takes: 3, hours: [[5, 7.5, 0.7], [17.5, 20, 1]], visit: [10, 30, 52], skip: 0.2, gap: 8, level: 0.55 },
  { id: 'wren', name: 'Wren', takes: 3, hours: [[6, 11, 0.8], [11, 17, 0.2]], visit: [5, 20, 32], skip: 0.25, gap: 12, level: 0.5 },
  { id: 'chaffinch', name: 'Chaffinch', takes: 3, hours: [[6, 11, 0.9], [11, 18, 0.2]], visit: [10, 30, 44], skip: 0.2, gap: 9, level: 0.5 },
  { id: 'crow', name: 'Crow', takes: 2, hours: [[17, 23, 1]], visit: [4, 12, 60], skip: 0.4, gap: 25, level: 0.45 }, // evening to night, now and then
];
BIRDS.forEach((b, i) => Object.assign(b, { ch: 'birds', seed: 10 * i + 10.37, key: `birds.${b.id}`, k: NaN, f: NaN, start: 0, end: 0, perch: 0, slot: NaN, next: null, busy: 0, offAt: 0, buffers: [] }));
const MAX_CALLS = 4; // bird calls at once (voices: gain + stereo panner, reused); the frogs have one voice each

export const audioMix = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
Object.defineProperty(audioMix, 'present', { value: '', writable: true }); // hidden: odds marks who is around (the line must stay short)
audioMix.odds = ''; // each species' chance of being around now (birdOdds), likeliest first, '*' = around: the debug menu
Object.defineProperty(audioMix, 'log', { value: null, writable: true }); // tests: [] records bird calls (hidden from the debug menu)
Object.defineProperty(audioMix, 'pan', { value: Object.fromEntries(LOOPS.filter((l) => l.placed).map((l) => [l.name, 0])) });

let ctx = null, master = null;
const bus = {}; // channel gain nodes (the viewer's volume per channel)
const voices = []; // bird and frog call voices { ch, gain, pan, level, end, dx, dz, ps }
const buffers = new Map(); // file -> Promise<AudioBuffer | null>, fetched once and kept

function load(name) {
  if (!buffers.has(name)) {
    buffers.set(name, fetch(new URL(`../sounds/${name}.mp3`, import.meta.url))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => ctx.decodeAudioData(data))
      .catch((e) => { console.warn(`sound ${name} not loaded:`, e.message); return null; }));
  }
  return buffers.get(name);
}

// Suspended while the tab is hidden or the master volume is 0: no audio thread work at all.
function wake() {
  if (!ctx) return;
  if (document.hidden || settings['volume.master'] === 0) ctx.suspend();
  else ctx.resume();
}

export function startAudio() {
  if (ctx) return wake();
  ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 32000 }); // 16 kHz bandwidth is plenty here; decoded loops take 2/3 of the memory they would at 48 kHz
  master = ctx.createGain();
  // a limiter at 0 dBFS: a close strike (up to +6 dB) over a storm's rain and wind would clip; with threshold 0 and no knee
  // it has no makeup gain, so it leaves everything under full scale as it is. It overshoots a crack by ~1 dB, so a soft
  // clip follows: untouched up to 0.9, then a tanh knee to 0.99 (the shaper's curve spans ±1, hence the halve and double)
  // Before the limiter, volume stabilization ('sound.stabilize'): a gentle compressor that leaves a calm day or night as it
  // is (within 0.3 dB) and brings a storm down ~5 dB, its loudest thunder ~8 dB, a 10 m/s wind ~1 dB. The spec's automatic
  // makeup gain ((1 / full-range gain)^0.6: +8.81 dB at these settings, measured) is taken back off after it; off = ratio 1,
  // which has none.
  const steady = new DynamicsCompressorNode(ctx, { attack: 0.3, release: 1 }), unmakeup = new GainNode(ctx);
  onSetting('sound.stabilize', (on) => {
    steady.threshold.value = on ? -20 : 0;
    steady.knee.value = on ? 6 : 0;
    steady.ratio.value = on ? 6 : 1;
    unmakeup.gain.value = on ? 10 ** (-8.81 / 20) : 1;
  });
  master.connect(steady).connect(unmakeup).connect(new DynamicsCompressorNode(ctx, { threshold: 0, knee: 0, ratio: 20, attack: 0, release: 0.2 }))
    .connect(new GainNode(ctx, { gain: 0.5 })).connect(new WaveShaperNode(ctx, { curve: SOFT_CLIP, oversample: '2x' }))
    .connect(new GainNode(ctx, { gain: 2 })).connect(ctx.destination);
  onSetting('volume.master', (v) => { master.gain.setTargetAtTime(v, ctx.currentTime, 0.05); wake(); });
  for (const c of CHANNELS) {
    bus[c] = ctx.createGain();
    bus[c].connect(master);
    onSetting(`volume.${c}`, (v) => bus[c].gain.setTargetAtTime(v, ctx.currentTime, 0.05));
  }
  for (const l of LOOPS) {
    l.gain = ctx.createGain();
    l.gain.gain.value = 0;
    // a mono copy panned by -0.7 / 0.7 into each side: two decorrelated copies keep the power of the centred one
    if (l.wide) l.copies = [-0.7, 0.7].map((pan) => { const p = new StereoPannerNode(ctx, { pan }); p.connect(l.gain); return p; });
    if (l.placed) l.gain.connect((l.pan = new StereoPannerNode(ctx, { pan: l.p }))).connect(bus[l.ch]);
    else l.gain.connect(bus[l.ch]);
  }
  for (const ch of [...FROGS.map((f) => f.ch), ...Array(MAX_CALLS).fill('birds')]) { // the birds' last (tools/sound-test.mjs finds their bus that way)
    const v = { ch, gain: ctx.createGain(), pan: ctx.createStereoPanner(), level: 0, end: 0, dx: 0, dz: 0, ps: 0 };
    v.gain.connect(v.pan).connect(bus[ch]);
    voices.push(v);
  }
  document.addEventListener('visibilitychange', wake);
  wake();
}

// Thunder: sound travels ~8x slower than real metres suggest (the sky is ~1/15 scale; the full 15x left most
// rumbles 15-30 s behind their flash), so a strike 300 m away rumbles in ~7 s; farther = quieter and duller.
// Placed where the strike hits (a far rumble is spread a little wider), panned while it rolls. Timed from the frame that
// drew the return stroke (onStrike), less the output latency, so the sound leaves the speakers distance x 8 / 343 s after
// the flash was seen; the near files start on their crack (make.py). Loudness (250 / d)^0.8 up to x2 (+6 dB, the
// limiter in startAudio keeps it from clipping): 100 m 2, 150 m 1.5, 250 m 1, 420 m 0.66, 700 m 0.44; far rumbles stay
// audible over the rain.
const thunders = []; // { start, end, gain, dx, dz, pan, ps, g, k } scheduled or playing (g its gain node, k its level facing it)
export const thunderGain = (distance, type) => Math.min(2, (250 / distance) ** 0.8) * (type === 'cloud' ? 0.6 : 1);
onStrike(({ start, distance, type }) => {
  if (!ctx || ctx.state !== 'running' || thunders.length >= MAX_THUNDER) return;
  const set = THUNDER[distance < 250 ? 'near' : distance < 420 ? 'mid' : 'far'];
  const name = set[Math.floor(hash(start, distance) * set.length)];
  const gain = thunderGain(distance, type);
  const s = strikeAt(Math.floor(start)), [ux, uz] = s ? toward(s.x, s.z) : [0, 0], focus = clamp(300 / distance, 0.6, 1);
  const at = ctx.currentTime + (distance * 8) / 343 - ctx.baseLatency - (ctx.outputLatency || 0);
  const t = { start: at, end: at + 30, gain, dx: ux * focus, dz: uz * focus, pan: null, ps: NaN, g: null, k: 0 };
  thunders.push(t);
  const done = () => thunders.splice(thunders.indexOf(t), 1);
  load(name).then((buffer) => {
    if (!buffer || ctx.currentTime > at + 1) return done();
    const src = ctx.createBufferSource(), lowpass = ctx.createBiquadFilter(), g = (t.g = ctx.createGain());
    src.buffer = buffer;
    lowpass.frequency.value = clamp(9000 * (150 / distance) ** 1.5, 300, 12000);
    t.k = gain * (buffer.numberOfChannels === 1 ? Math.SQRT2 : 1); // a panned mono file: +3 dB, as loud as unpanned
    g.gain.value = t.k * behind(t.dx, t.dz);
    t.pan = new StereoPannerNode(ctx, { pan: (t.ps = panOf(t.dx, t.dz)) });
    src.connect(lowpass).connect(g).connect(t.pan).connect(bus.thunder);
    src.onended = () => { done(); g.disconnect(); t.pan.disconnect(); };
    t.start = Math.max(at, ctx.currentTime);
    t.end = t.start + buffer.duration;
    src.start(t.start);
  });
});

// Bees: some evenings, a few short visits an hour. Scene time is cut into 10 min slots, each with at
// most one burst, all from hashes of the scene clock (same for everyone at the same moment).
// 'often.bees' f: a slot holds a burst with chance 1 - 0.4^f (0.6 at 1, 0.84 at 2, none at 0).
// A burst flies across the meadow along x (left to right or back in the clock view), 3-9 m in front of the clock spot.
const BEE_SLOT = 600;
let beeSlot = NaN, beeF = NaN, beeStart = 0, beeEnd = 0, beeSide = 1, beeNear = 5;
function beeBurst(t, f) {
  const slot = Math.floor(t / BEE_SLOT);
  if (slot !== beeSlot || f !== beeF) {
    beeSlot = slot;
    beeF = f;
    const on = hash(slot, 7.1) < 1 - 0.4 ** f;
    beeStart = on ? slot * BEE_SLOT + hash(slot, 3.3) * (BEE_SLOT - 60) : -1e9;
    beeEnd = beeStart + 15 + 25 * hash(slot, 5.9);
    beeSide = hash(slot, 8.3) < 0.5 ? -1 : 1;
    beeNear = 3 + 6 * hash(slot, 9.7);
  }
  return smoothstep(t, beeStart, beeStart + 4) * (1 - smoothstep(t, beeEnd - 4, beeEnd));
}

// How much species b likes hour h (0..1).
function activity(b, h) {
  let a = 0;
  for (const s of b.hours) a = Math.max(a, s[2] * smoothstep(h, s[0] - 0.25, s[0] + 0.25) * (1 - smoothstep(h, s[1] - 0.25, s[1] + 0.25)));
  return a;
}

// Quiet spells for all birds at once (each species coming and going alone still left some bird around ~90% of the
// day): 10-30 min in most hours, rarer around the dawn chorus. Uses presence() like a species, with the inverse of
// 'often.birds' (more birds: fewer, shorter quiet spells; none from 3x).
const AWAY = { visit: [10, 30, 60], skip: 0.35, seed: 97.3, k: NaN, f: NaN, start: 0, end: 0, perch: 0 };
const away = (t, hours) => presence(AWAY, t, 1 / settings['often.birds']) * (1 - 0.7 * smoothstep(hours, 4.75, 5.25) * (1 - smoothstep(hours, 8.25, 8.75)));

// Is species b around at scene time t (0..1, 90 s to arrive and to leave)? Its stay in this cycle is hashed once per cycle.
// f ('often.birds' for birds): skips a cycle with chance skip / f and stays sqrt(f) times as long (0 = never there).
function presence(b, t, f = 1) {
  const cycle = b.visit[2] * 60, k = Math.floor(t / cycle);
  if (k !== b.k || f !== b.f) {
    const stay = Math.min(cycle - 180, (b.visit[0] + (b.visit[1] - b.visit[0]) * hash(k, b.seed)) * 60 * Math.sqrt(f));
    b.k = k;
    b.f = f;
    b.start = hash(k, b.seed + 0.5) < b.skip / f ? 0 : k * cycle + hash(k, b.seed + 0.25) * (cycle - stay);
    b.end = b.start && b.start + stay;
    b.perch = Math.floor(hash(k, b.seed + 0.75) * PERCHES.length); // the tree it sits in (PERCHES), the calls scatter around it
  }
  return smoothstep(t, b.start, b.start + 90) * (1 - smoothstep(t, b.end - 90, b.end));
}

// The share of time presence(b, t, f) is up: cycles kept (1 - skip / f) x the mean stay (capped like above) / cycle.
function share(b, f) {
  const c = b.visit[2] - 3, lo = b.visit[0] * Math.sqrt(f), hi = b.visit[1] * Math.sqrt(f), m = Math.min(c, hi);
  return f > 0 && Math.max(0, 1 - b.skip / f) * (lo >= c ? c : ((m - lo) * (lo + m) / 2 + (hi - m) * c) / (hi - lo)) / b.visit[2];
}
// Species b's chance (0..1) of being around (audioMix.present) at hour `hours`: 0 when switched off or when the hour or
// the weather (gate: rain, wind) keeps it away, else its share less the shared quiet spells (away; not at dawn). The
// odds, not the schedule: which cycles hold a stay is hashed.
function birdOdds(b, hours, gate) {
  const f = settings['often.birds'];
  if (!settings[b.key] || activity(b, hours) * gate <= 0.02) return 0;
  return share(b, f) * (1 - share(AWAY, 1 / f) * (1 - smoothstep(hours, 4.75, 5.25) * (1 - smoothstep(hours, 8.25, 8.75))));
}

// Single crickets (loops cricket-1..3): each sings for a stay of 5-15 min per 16-20 min cycle (skipping 5-15% of
// cycles), at its own place and pitch (LOOPS); `until`: scene hour before dawn after which it is quiet. Some single
// cricket sings in ~85% of night minutes (tools/sound-test.mjs). Levels 0.5 / 0.42 / 0.35 were 0.7 / 0.6 / 0.5 before
// placed mono loops got +3 dB (boost): the same loudness.
const CRICKETS = [[8, 15, 16, 0.05, 0.5, 4.5], [6, 14, 18, 0.1, 0.42, 3.5], [5, 13, 20, 0.15, 0.35, 2.5]]
  .map(([a, b, cycle, skip, level, until], i) => ({ visit: [a, b, cycle], skip, level, until, seed: 61.7 + 7 * i, k: NaN, f: NaN, start: 0, end: 0, perch: 0, loop: loop[`cricket-${i + 1}`] }));

// The call species b makes in call slot `slot` (gap s long), or null: at a hashed time, more likely while it is around,
// likes the hour (hours) and in a busy minute; k scales the chance (weather), and so does 'often.calls'. A random take,
// loudness, place (x, z: within 2 m of the visit's perch) and pitch. Pure for given settings.
export function birdCall(b, slot, hours, k = 1) {
  const at = (slot + 0.8 * hash(slot, b.seed + 1)) * b.gap;
  const mood = hash(Math.floor(at / 60), b.seed + 2); // some minutes busy, many quiet
  const chance = presence(b, at, settings['often.birds']) * (1 - away(at, hours)) * activity(b, hours) * (0.1 + 0.9 * mood * mood) * k * settings['often.calls'];
  if (hash(slot, b.seed + 3) >= chance) return null;
  return {
    at, take: Math.floor(hash(slot, b.seed + 4) * b.takes), gain: b.level * (0.35 + 0.65 * hash(slot, b.seed + 5)),
    x: PERCHES[b.perch].x + 4 * (hash(slot, b.seed + 6) - 0.5), z: PERCHES[b.perch].z + 4 * (hash(slot, b.seed + 8) - 0.5), rate: 0.94 + 0.12 * hash(slot, b.seed + 7),
  };
}

// Frogs: edible frog croak bouts (frog-<n>.mp3, tools/sounds/make.py CALLS) from the river's banks, never a loop. Two
// frogs, each scheduled like a bird species: dusk and night only (none by day), come and go (visit), call at a hashed time
// in ~gap s slots, busier or quieter minute by minute. A visit sits at a spot on the near bank (or, 30%, the far one)
// within 60 m along the river, each call within 4 m of it, quieter beyond 45 m. level: 0.3 x 0.4..1 per call, under the birds.
const FROG_TAKES = 4, frogBuffers = []; // both frogs share the takes
let frogsOffAt = 0;
export const FROGS = [{ seed: 131.3, visit: [15, 45, 60], skip: 0.2, gap: 11 }, { seed: 147.9, visit: [10, 30, 50], skip: 0.35, gap: 15 }]
  .map((f) => Object.assign(f, { id: 'frog', ch: 'frogs', hours: [[17.75, 23.25, 1], [22.75, 25, 0.6], [-1, 4.5, 0.6], [4.5, 6, 0.2]], level: 0.3, takes: FROG_TAKES, k: NaN, f: NaN, start: 0, end: 0, perch: 0, slot: NaN, next: null, busy: 0, buffers: frogBuffers }));

// Livelier in light rain and on wet ground after it (uWet: dries over ~30 min of scene time), fewer in heavy rain and in
// strong wind (a storm has both): x1 on a dry calm night, x2.5 wet, ~x0.6 in rain, ~x0.15 in a storm.
export const frogWeather = (rain, wet, wind) => (1 + 1.5 * Math.max(wet, smoothstep(rain, 0.02, 0.2))) * (1 - 0.8 * smoothstep(rain, 0.35, 0.8)) * (1 - 0.7 * smoothstep(wind, 6, 12));

// The croak frog f makes in call slot `slot` (or null), like birdCall: k = frogWeather. Pure.
export function frogCall(f, slot, hours, k = 1) {
  const at = (slot + 0.8 * hash(slot, f.seed + 1)) * f.gap;
  const mood = hash(Math.floor(at / 60), f.seed + 2);
  if (hash(slot, f.seed + 3) >= presence(f, at) * activity(f, hours) * (0.15 + 0.85 * mood * mood) * k) return null;
  const x = 120 * (hash(f.k, f.seed + 0.9) - 0.5) + 8 * (hash(slot, f.seed + 6) - 0.5), side = hash(f.k, f.seed + 0.6) < 0.7 ? 1 : -1;
  const z = riverZ(x) + side * (riverHalfWidth(x) + 0.5);
  return { at, take: Math.floor(hash(slot, f.seed + 4) * FROG_TAKES), gain: f.level * (0.4 + 0.6 * hash(slot, f.seed + 5)) * Math.min(1, 45 / toward(x, z)[2]), x, z, rate: 0.94 + 0.12 * hash(slot, f.seed + 7) };
}

function playCall(b, c, now) {
  const buffer = b.buffers[c.take], v = voices.find((v) => v.ch === b.ch && v.end <= now);
  if (!buffer || !v || b.busy > now) return; // not loaded yet, all voices busy, or it is still singing its last one
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = c.rate;
  [v.dx, v.dz] = toward(c.x, c.z);
  v.gain.gain.setValueAtTime((v.level = c.gain) * behind(v.dx, v.dz), now); // (updateAudio glides both as the view turns)
  v.pan.pan.setValueAtTime((v.ps = panOf(v.dx, v.dz)), now);
  src.connect(v.gain);
  src.onended = () => src.disconnect();
  src.start(now);
  v.end = b.busy = now + buffer.duration / c.rate;
  audioMix.log?.push({ t: c.at, id: b.id, take: c.take, gain: c.gain, x: c.x, z: c.z, pan: v.ps, rate: c.rate });
}

let lastT = NaN, presentMask = -1, oddsSec = NaN;
export const swell = { k: 1, to: 1, left: 0 }; // the calm wind's random drift (x0.7-1.3), real time; held by sound-test

// (callers without the scene clock get today's date; main.js passes sceneSeconds)
const MIDNIGHT = new Date().setHours(0, 0, 0, 0) / 1000;

export function updateAudio(dt, hours, camera, sceneSeconds = MIDNIGHT + hours * 3600) {
  const sun = sunDir.y, morning = hours < 12, rain = weather.rain, wind = uniforms.uWindStrength.value;
  const e = camera.matrixWorld.elements, fl = Math.hypot(e[8], e[10]) || 1; // the camera looks along its -z
  fx = -e[8] / fl;
  fz = -e[10] / fl;

  // no animal in any rain; back over ~4 min once it stopped (birds, crickets, bees; weather.js)
  const back = animals.back;
  // crickets: a far chorus from dusk until before dawn (they stop as the birds start), and single crickets close by
  // that sing a few minutes, pause, sing again; they drop out one by one in the small hours and keep low in strong wind
  const night = morning ? smoothstep(-sun, 0.1, 0.2) : smoothstep(-sun, -0.02, 0.08);
  loop.crickets.level = 0.35 * night * back * (1 - 0.5 * smoothstep(wind, 6, 12));
  for (const c of CRICKETS) {
    const late = morning ? 1 - smoothstep(hours, c.until - 0.5, c.until + 0.5) : 1;
    c.loop.level = c.level * presence(c, sceneSeconds) * night * late * back * (1 - 0.8 * smoothstep(wind, 5, 11));
  }
  // bees: 16:00-19:00 with the sun up, calm and dry, on two evenings in three; a burst crosses from one side to the
  // other, loudest as it passes closest
  const day = Math.round((sceneSeconds - hours * 3600) / 86400);
  const evening = smoothstep(hours, 15.75, 16.25) * (1 - smoothstep(hours, 18.75, 19.25)) * smoothstep(sun, -0.02, 0.06);
  const beeWeather = (1 - smoothstep(wind, 4, 6.5)) * back;
  const fBees = settings['often.bees']; // more: more evenings (1 - 0.33^f) and more bursts
  const bees = evening * beeWeather > 0 && hash(day, 1.7) < 1 - 0.33 ** fBees ? 0.45 * evening * beeWeather * beeBurst(sceneSeconds, fBees) : 0;
  const bx = beeSide * (60 * clamp((sceneSeconds - beeStart) / (beeEnd - beeStart), 0, 1) - 30), br = Math.hypot(bx, beeNear);
  loop.bees.dx = bx / br;
  loop.bees.dz = -beeNear / br;
  loop.bees.level = bees * (0.35 + 0.65 * (beeNear / br));
  // wind: a soft breeze in the grass and trees from upwind (uWindDir: where the wind blows to), a little spread, always
  // there and subtle; it drifts a little louder and softer at random (swell, every 4-12 s) and swells with each random
  // gust (wind.js; heard as it is seen: the wind loops glide faster, below). A windstorm in the trees (LOOPS) comes in
  // only in strong wind, from 6 m/s.
  const w = uniforms.uWindDir.value, wl = -0.7 / (Math.hypot(w.x, w.y) || 1);
  loop['wind-calm'].dx = w.x * wl;
  loop['wind-calm'].dz = w.y * wl;
  if ((swell.left -= dt) <= 0) { swell.to = 0.7 + 0.6 * Math.random(); swell.left = 4 + 8 * Math.random(); }
  swell.k += (swell.to - swell.k) * (1 - Math.exp(-dt / 2.5));
  loop['wind-calm'].level = (0.08 + 0.17 * smoothstep(wind, 0.5, 8)) * swell.k * (1 + 0.5 * gust.env) * (1 - 0.4 * smoothstep(wind, 8, 14));
  loop['wind-strong'].level = 0.45 * smoothstep(wind, 6, 14);
  // rain: light patter alone in light rain, the downpour over it from ~0.4
  loop['rain-light'].level = 0.7 * smoothstep(rain, 0.02, 0.25) * (1 - 0.6 * smoothstep(rain, 0.4, 0.8));
  loop['rain-heavy'].level = smoothstep(rain, 0.35, 0.9);
  // and the ground: drops and splashes in the puddles under both, louder as it pours
  loop['rain-ground'].level = smoothstep(rain, 0.02, 0.3) * (0.6 + 0.4 * smoothstep(rain, 0.4, 0.9));
  // river: always there, from where it runs (ahead, left to right); 0.22 facing it, 0.15 with it behind (3 dB under the
  // 0.31 it was until 2026-10-28). Its distance is in the slider's default (volume.river 0.5), not here
  loop.river.level = 0.22;
  // placed loops: pan from the heading, a touch quieter behind
  for (const l of LOOPS) if (l.placed) { audioMix.pan[l.name] = l.p = panOf(l.dx, l.dz); l.level *= behind(l.dx, l.dz); }

  for (const c of CHANNELS) audioMix[c] = 0;
  for (const l of LOOPS) audioMix[l.ch] = Math.max(audioMix[l.ch], l.level);

  // birds: who is around (debug read-out), then each species' call slots; nobody calls in rain or a strong wind
  const t = sceneSeconds, gate = back * (1 - smoothstep(wind, 7, 11)), calm = gate * (1 - away(t, hours)), step = t - lastT;
  let mask = 0;
  for (let i = 0; i < BIRDS.length; i++) {
    const b = BIRDS[i], on = settings[b.key] && presence(b, t, settings['often.birds']) * activity(b, hours) * calm > 0.02;
    if (on) mask |= 1 << i;
    if (!ctx) continue;
    const now = ctx.currentTime;
    if (on) {
      b.offAt = now;
      for (let n = b.buffers.length; n < b.takes; n++) { b.buffers.push(null); load(`bird-${b.id}-${n + 1}`).then((buf) => { if (b.buffers.length) b.buffers[n] = buf; }); }
    } else if (b.buffers.length && now - b.offAt > 300) { // gone for 5 min: free its calls
      for (let n = 1; n <= b.takes; n++) buffers.delete(`bird-${b.id}-${n}`);
      b.buffers.length = 0;
    }
    const slot = Math.floor(t / b.gap);
    if (slot !== b.slot) { b.slot = slot; b.next = birdCall(b, slot, hours, calm); }
    if (b.next && b.next.at <= t) {
      // a call in this frame's stretch of the scene clock (not one skipped over by the time slider)
      if (b.next.at > lastT && step < 5 && on && ctx.state === 'running') playCall(b, b.next, now);
      b.next = null;
    }
  }
  // frogs: the same per call slot, from the banks; nothing fetched or played while the Frogs slider is at 0
  const fk = frogWeather(rain, uniforms.uWet.value, wind), frogsOn = settings['volume.frogs'] > 0;
  let frogsAround = false;
  for (const f of FROGS) {
    frogsAround ||= frogsOn && presence(f, t) * activity(f, hours) > 0.02;
    const slot = Math.floor(t / f.gap);
    if (slot !== f.slot) { f.slot = slot; f.next = frogsOn ? frogCall(f, slot, hours, fk) : null; }
    if (!ctx || !f.next || f.next.at > t) continue;
    if (frogsOn && f.next.at > lastT && step < 5 && ctx.state === 'running') playCall(f, f.next, ctx.currentTime);
    f.next = null;
  }
  if (ctx && frogsAround) {
    frogsOffAt = ctx.currentTime;
    for (let n = frogBuffers.length; n < FROG_TAKES; n++) { frogBuffers.push(null); load(`frog-${n + 1}`).then((buf) => { if (frogBuffers.length) frogBuffers[n] = buf; }); }
  } else if (ctx && frogBuffers.length && ctx.currentTime - frogsOffAt > 300) { // gone for 5 min: free the takes
    for (let n = 1; n <= FROG_TAKES; n++) buffers.delete(`frog-${n}`);
    frogBuffers.length = 0;
  }
  lastT = t;
  if (mask !== presentMask) { presentMask = mask; audioMix.present = BIRDS.filter((b, i) => mask & (1 << i)).map((b) => b.id).join(' '); oddsSec = NaN; }
  if (Math.floor(t) !== oddsSec) { // once a scene second: 'robin* 38% · blackbird 22% · ...', none at 0%
    oddsSec = Math.floor(t);
    audioMix.odds = BIRDS.map((b, i) => [b.id + (mask & (1 << i) ? '*' : ''), Math.round(100 * birdOdds(b, hours, gate))])
      .filter(([, p]) => p).sort((x, y) => y[1] - x[1]).map(([id, p]) => `${id} ${p}%`).join(' · ');
  }

  if (!ctx) return;
  const now = ctx.currentTime;
  for (const t of thunders) if (now >= t.start && now < t.end) audioMix.thunder = Math.max(audioMix.thunder, t.gain);
  for (const v of voices) if (now < v.end) audioMix[v.ch] = Math.max(audioMix[v.ch], v.level);
  if (ctx.state !== 'running') return;
  // the view turned: glide pans (and the behind dip of calls and thunder) over ~0.3 s; re-sent only when moved
  for (const t of thunders) {
    if (!t.pan || Math.abs(panOf(t.dx, t.dz) - t.ps) <= 0.01) continue;
    t.pan.pan.setTargetAtTime((t.ps = panOf(t.dx, t.dz)), now, 0.15);
    t.g.gain.setTargetAtTime(t.k * behind(t.dx, t.dz), now, 0.15);
  }
  for (const v of voices) {
    if (now >= v.end || Math.abs(panOf(v.dx, v.dz) - v.ps) <= 0.01) continue;
    v.pan.pan.setTargetAtTime((v.ps = panOf(v.dx, v.dz)), now, 0.15);
    v.gain.gain.setTargetAtTime(v.level * behind(v.dx, v.dz), now, 0.15);
  }

  for (const l of LOOPS) {
    const want = l.level > 0.001;
    // a panned mono file gets +3 dB: the panner's equal-power split leaves it 3 dB under the same file unpanned
    if (want && !buffers.has(l.name)) load(l.name).then((b) => { l.buffer = b; l.boost = l.placed && b?.numberOfChannels === 1 ? Math.SQRT2 : 1; });
    if (want && l.buffer && !l.source) {
      l.source = play(l, now, sceneSeconds, l.copies?.[0] ?? l.gain);
      if (l.wide) l.source2 = play(l, now, sceneSeconds + l.len / 2, l.copies[1]); // half a loop on: decorrelated
      l.gain.gain.cancelScheduledValues(now);
      l.gain.gain.setValueAtTime(0, now);
      l.set = -1; // fade in from silence
    }
    // silent for 5 min: free the decoded buffer too (tens of MB each); refetched from the HTTP cache when needed
    if (!want && !l.source && l.buffer && now - l.offAt > 300) { buffers.delete(l.name); l.buffer = null; }
    if (!l.source) continue;
    if (l.pan && Math.abs(l.p - l.ps) > 0.01) l.pan.pan.setTargetAtTime((l.ps = l.p), now, 0.15);
    const v = want ? l.level : 0;
    if (Math.abs(v - l.set) > 0.003 || (v === 0 && l.set !== 0)) {
      // ~3 s to settle: slider drags, weather changes and turning glide; the wind in ~1 s, so a gust swells with the sway
      l.gain.gain.setTargetAtTime(v * l.boost, now, l.ch === 'wind' ? 0.3 : 1);
      if (v === 0) l.offAt = now;
      l.set = v;
    }
    if (l.set === 0 && now - l.offAt > 8) { // silent: free the voice, keep the buffer
      for (const s of [l.source, l.source2]) { s?.stop(); s?.disconnect(); }
      l.source = l.source2 = null;
    }
  }
}

// A loop's source, started where the loop would be at scene time t, into dst.
function play(l, now, t, dst) {
  const s = ctx.createBufferSource();
  Object.assign(s, { buffer: l.buffer, loop: true, loopStart: PAD, loopEnd: PAD + l.len });
  s.playbackRate.value = l.rate;
  s.connect(dst);
  s.start(now, PAD + (((t % l.len) + l.len) % l.len));
  return s;
}

const CC0 = { license: 'CC0 1.0 (public domain)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
const fs = (user, id) => `https://freesound.org/people/${user}/sounds/${id}/`;
const calls = (n, what) => `${n} cut out (${what}), high-passed, faded, levelled, mono MP3`;
export const SOUND_CREDITS = [
  { title: 'mourning_dove _2017-06-06.wav', author: 'nathankwright', url: fs('nathankwright', 456930), file: 'bird-dove-1..3.mp3', changes: calls('three songs', 'mourning dove') },
  { title: '20260318_05h05 Albi - Great tit', author: 'Sadiquecat', url: fs('Sadiquecat', 849589), file: 'bird-greattit-1.mp3', changes: calls('one phrase', 'great tit') },
  { title: 'Great tit', author: 'roelofmellema', url: fs('roelofmellema', 790795), file: 'bird-greattit-2..3.mp3', changes: calls('two phrases', 'great tit') },
  { title: 'BlueTit', author: 'DistinctlyAverage', url: fs('DistinctlyAverage', 872964), file: 'bird-bluetit-1..3.mp3', changes: calls('three calls', 'blue tit') },
  { title: 'Robin singing', author: 'naturenotesuk', url: fs('naturenotesuk', 418425), file: 'bird-robin-1..2.mp3', changes: calls('two phrases', 'European robin') },
  { title: 'robin song', author: 'Andrew.soundscape', url: fs('Andrew.soundscape', 671058), file: 'bird-robin-3.mp3', changes: calls('one phrase', 'European robin') },
  { title: 'Robin.wav', author: 'BeeProductive', url: fs('BeeProductive', 372219), file: 'bird-robin-4.mp3', changes: calls('one phrase', 'European robin') },
  { title: 'Blackbird (isolated)', author: 'richwise', url: fs('richwise', 811988), file: 'bird-blackbird-1..3.mp3', changes: calls('three phrases', 'blackbird') },
  { title: 'Blackbird  Song', author: 'Sacha.Julien', url: fs('Sacha.Julien', 725046), file: 'bird-blackbird-4.mp3', changes: calls('one phrase', 'blackbird') },
  { title: 'Song Thrush', author: 'richwise', url: fs('richwise', 785669), file: 'bird-thrush-1..3.mp3', changes: calls('three phrases', 'song thrush') },
  { title: '110714_wren.wav', author: 'Andy_Gardner', url: fs('Andy_Gardner', 125423), file: 'bird-wren-1..3.mp3', changes: calls('three songs', 'wren') },
  { title: 'Madeiran Chaffinch Song', author: 'Sacha.Julien', url: fs('Sacha.Julien', 725195), file: 'bird-chaffinch-1..3.mp3', changes: calls('three songs', 'chaffinch') },
  { title: 'Kraehenruf.mp3', author: 'cfrooos', url: fs('cfrooos', 181088), file: 'bird-crow-1.mp3', changes: calls('one caw series', 'carrion crow') },
  { title: 'Winter crow March 11 2025', author: 'kvgarlic', url: fs('kvgarlic', 792274), file: 'bird-crow-2.mp3', changes: calls('one caw series', 'American crow') },
  { title: 'loud-cricket2.aif', author: 'alienistcog', url: fs('alienistcog', 124424), file: 'cricket-1.mp3', changes: '0:01-0:13, high-passed 2 kHz, looped, levelled, mono MP3' },
  { title: '200906 Cricket, single close loud, PEC pm.flac', author: 'TRP', url: fs('TRP', 568820), file: 'cricket-2.mp3', changes: '0:39-0:59, high-passed 2 kHz, looped, levelled, mono MP3' },
  { title: 'Single Cricket Chirping, Close Perspective 03', author: 'HECKFRICKER', url: fs('HECKFRICKER', 753280), file: 'cricket-3.mp3', changes: '0:40-0:58, high-passed 2 kHz, looped, levelled, mono MP3' },
  { title: 'AMB_Rural_Summer_Night.wav', author: 'AnthonyRamirez', url: fs('AnthonyRamirez', 425425), file: 'crickets.mp3', changes: '0:03-0:53, high-passed 400 Hz, looped, levelled, MP3' },
  { title: 'Soft wind shaking the grass and a tree, muffled wind sometimes, slight insect noises, road hum very far away', author: 'felix.blume', url: fs('felix.blume', 653942), file: 'wind-calm.mp3', changes: '4:04-5:54, high-passed 120 Hz, looped, levelled, MP3' },
  { title: 'Strong Wind Blowing Through Trees', author: 'HECKFRICKER', url: fs('HECKFRICKER', 646549), file: 'wind-strong.mp3', changes: '1:50-2:50, high-passed 120 Hz, looped, levelled, MP3' },
  { title: 'Rain light 2 (rural)', author: 'jmbphilmes', url: fs('jmbphilmes', 200273), file: 'rain-light.mp3', changes: '0:03-1:03, high-passed 200 Hz, looped, levelled, mono MP3' },
  { title: 'Rain heavy 2 (rural)', author: 'jmbphilmes', url: fs('jmbphilmes', 200272), file: 'rain-heavy.mp3', changes: '0:02-0:38, high-passed 200 Hz, looped, levelled, mono MP3' },
  { title: 'puddleinwoods.aiff', author: 'klangfabrik', url: fs('klangfabrik', 157161), file: 'rain-ground.mp3', changes: '1:47-2:37, high-passed 250 Hz, looped, levelled, MP3' },
  { title: 'Water stream calmed 3', author: 'frederic.font', url: fs('frederic.font', 168897), file: 'river.mp3', changes: '0:20-1:20, high-passed 80 Hz, looped, levelled, MP3' },
  { title: 'Bees gallore - garden hedge full of bees', author: 'myrinvp', url: fs('myrinvp', 859809), file: 'bees.mp3', changes: '0:23-1:09, high-passed 150 Hz, looped, levelled, mono MP3' },
  { title: '200817 Thunder, pretty close crack 4pm.flac', author: 'TRP', url: fs('TRP', 567945), file: 'thunder-near-1.mp3', changes: 'trimmed, faded out, levelled, MP3' },
  { title: 'Thunderclap', author: 'Fission9', url: fs('Fission9', 534023), file: 'thunder-near-2.mp3', changes: 'trimmed, faded out, levelled, MP3' },
  { title: '230724 Thunder, close crack light rain, mixpreroof, Toronto 5pm', author: 'TRP', url: fs('TRP', 717909), file: 'thunder-mid.mp3', changes: 'trimmed, faded out, levelled, MP3' },
  { title: 'Distant rumbles', author: 'richwise', url: fs('richwise', 584946), file: 'thunder-far-1.mp3, thunder-far-2.mp3', changes: 'two rumbles cut out (0:56, 0:37), low-passed 9 kHz, faded out, levelled, MP3' },
  { title: 'frogs in ditch 220517_0351.flac', author: 'klankbeeld', url: fs('klankbeeld', 634459), file: 'frog-1..4.mp3', changes: calls('four croak bouts', 'edible frog'), license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
].map((c) => ({ ...CC0, ...c }));
