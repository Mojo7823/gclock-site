// The alarm (settings 'alarm.on', 'alarm.time' minutes, 'alarm.snooze' minutes, 'volume.alarm'). Contract:
//   initAlarm(now)  once from main.js; now() returns the clock's shown time (a Date: real time plus any bypass offset)
//   testAlarm()     rings it now (the Alarm tab's Test button)
//   ALARM_CREDITS   [{ title, author, url, license, licenseUrl }] for the credits panel
// It rings when the shown clock runs into alarm.time (once per alarm per day): the dialog (#alarm in index.html) and a
// rooster crowing every PERIOD s, louder over the first minute, until Snooze (again in alarm.snooze min) or Dismiss.
// Timers, not frames: it rings in a hidden tab too. Its own AudioContext: audio.js suspends the scene's while hidden.
import { settings, onSetting, hourMinute } from './settings.js';

export const ALARM_CREDITS = [
  { title: 'Rooster crows', author: 'jsbarrett', url: 'https://freesound.org/people/jsbarrett/sounds/200334/', license: 'CC0 1.0 (public domain)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' },
];

const SOUND = new URL('../sounds/alarm-rooster.mp3', import.meta.url); // two crows, 6.85 s (tools/sounds/make.py ALARMS)
const PERIOD = 10; // s from one pair of crows to the next
const GIVE_UP = 5 * 60e3; // ms unanswered: it snoozes once by itself; unanswered again, it stops
const LATE = 5 * 60e3; // ms: an alarm passed longer ago than this (a laptop asleep) is skipped, not rung late

const dialog = document.getElementById('alarm'), at = document.getElementById('alarm-at');
let now = () => new Date();
let lastShown = 0, lastReal = 0, rung = ''; // the previous check, and the alarm (day + time) that rang last
let snoozeAt = 0, giveUpAt = 0, autoSnoozed = false; // real ms
let ctx = null, volume = null, buffer = null, sources = [], playing = 0;
let format;

export function initAlarm(fn) {
  now = fn;
  lastShown = now().getTime();
  lastReal = Date.now();
  // shortcut: Chrome runs timers in a hidden tab once a second, and after 5 min hidden and silent once a minute, so a
  // background ring can be up to a minute late; a Notification Triggers / push wake-up would be the upgrade if that matters.
  setInterval(check, 1000);
  document.addEventListener('visibilitychange', check);
  onSetting('alarm.time', () => { snoozeAt = 0; });
  onSetting('alarm.on', (on) => { if (!on) snoozeAt = 0; });
  onSetting('clock.h24', (h24) => { format = new Intl.DateTimeFormat(undefined, hourMinute(h24)); });
  document.getElementById('alarm-snooze').addEventListener('click', () => snooze(false));
  document.getElementById('alarm-dismiss').addEventListener('click', dismiss);
  dialog.addEventListener('close', () => { if (giveUpAt) snooze(false); }); // Escape (or the browser) closed it: a snooze
}

export function testAlarm() { ring(); }

function check() {
  const shown = now(), t = shown.getTime(), real = Date.now();
  // only while the shown clock runs with the real one: a bypass offset change or a jump rings nothing it skipped over
  const flowing = real >= lastReal && Math.abs(t - lastShown - (real - lastReal)) < 2000;
  if (settings['alarm.on'] && flowing) {
    const due = new Date(shown);
    due.setHours(0, settings['alarm.time'], 0, 0);
    if (due > shown) due.setDate(due.getDate() - 1);
    const key = `${due.toDateString()} ${settings['alarm.time']}`;
    if (due.getTime() > lastShown && t - due < LATE && key !== rung) { rung = key; ring(); }
  }
  lastShown = t;
  lastReal = real;
  if (snoozeAt && real >= snoozeAt) ring();
  if (giveUpAt && real >= giveUpAt) autoSnoozed ? dismiss() : snooze(true);
}

function ring() {
  snoozeAt = 0;
  giveUpAt = Date.now() + GIVE_UP;
  at.textContent = format.format(new Date(2000, 0, 1, 0, settings['alarm.time']));
  if (!dialog.open) dialog.showModal(); // focus goes to Snooze
  play();
}

function snooze(auto) {
  autoSnoozed = auto;
  stop();
  snoozeAt = Date.now() + settings['alarm.snooze'] * 60e3;
}

function dismiss() {
  autoSnoozed = false;
  stop();
  snoozeAt = 0;
}

function stop() {
  giveUpAt = 0;
  playing++;
  for (const s of sources) s.stop();
  sources = [];
  ctx?.suspend();
  if (dialog.open) dialog.close();
}

// Every crow for the next GIVE_UP is scheduled at once on the audio clock (no timers). Without a click or key on the
// page yet the browser keeps the context suspended: the dialog shows anyway and the crowing starts with the first one.
async function play() {
  const id = ++playing;
  for (const s of sources) s.stop();
  sources = [];
  if (!ctx) {
    ctx = new AudioContext();
    volume = ctx.createGain();
    volume.connect(ctx.destination);
    const set = () => volume.gain.setTargetAtTime(settings['volume.master'] * settings['volume.alarm'], ctx.currentTime, 0.05);
    onSetting('volume.master', set);
    onSetting('volume.alarm', set);
    for (const type of ['pointerup', 'keydown']) addEventListener(type, () => { if (giveUpAt) ctx.resume(); });
  }
  ctx.resume();
  buffer ??= await fetch(SOUND).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
    .then((data) => ctx.decodeAudioData(data))
    .catch((e) => { console.warn('alarm sound not loaded:', e.message); return null; });
  if (!buffer || id !== playing) return; // no sound (the dialog still rings), or stopped meanwhile
  const t0 = ctx.currentTime + 0.05;
  for (let k = 0; k * PERIOD * 1000 < GIVE_UP; k++) {
    const src = new AudioBufferSourceNode(ctx, { buffer }), gain = new GainNode(ctx, { gain: Math.min(1, 0.4 + 0.1 * k) }); // gently louder
    src.connect(gain).connect(volume);
    src.start(t0 + k * PERIOD);
    sources.push(src);
  }
}
