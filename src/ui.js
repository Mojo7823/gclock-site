// The (i) panel (camera, sound, location, clock, alarm, settings, changelog, credits), the first-visit consent dialog
// (cookies, location, a place) and the hidden debug menu (the bug button, 5 presses). initUI(api) is called once by main.js:
//   api.dev        dev URL params: never ask, never open anything by itself
//   api.debug      ?debug: show the debug menu at once
//   api.clockView  back to the clock view
import * as audio from './audio.js';
import { settings, setSetting, onSetting, resetSettings, CHOICES } from './settings.js';
import { searchPlaces, onForecast, forecastStatus, DATA_CREDITS } from './forecast.js';
import { MODEL_CREDITS } from './models.js';
import { testAlarm, ALARM_CREDITS } from './alarm.js';
import { FONT_CREDITS } from './clock.js';

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export function initUI(api) {
  initPanel(api);
  initDebug(api);
  initConsent(api);
}

function initPanel(api) {
  const panel = $('panel'), info = $('info'), tablist = panel.querySelector('[role="tablist"]'), tabs = [...tablist.children];
  const select = (tab) => {
    for (const t of tabs) {
      t.setAttribute('aria-selected', t === tab);
      t.tabIndex = t === tab ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = t !== tab;
    }
  };
  const open = () => { panel.hidden = false; info.setAttribute('aria-expanded', 'true'); };
  const close = () => {
    panel.hidden = true;
    info.setAttribute('aria-expanded', 'false');
    info.focus();
  };
  select(tabs[0]);
  info.addEventListener('click', () => { if (!panel.hidden) return close(); open(); tabs.find((t) => t.tabIndex === 0).focus(); });
  $('panel-close').addEventListener('click', close);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) close(); }); // Escape snoozes an open alarm first
  tablist.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  tablist.addEventListener('keydown', (e) => { // arrow keys, Home and End move between tabs
    const i = tabs.indexOf(e.target), step = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
    if (i < 0 || step === undefined) return;
    e.preventDefault();
    const t = tabs[(i + step + tabs.length) % tabs.length];
    select(t);
    t.focus();
  });

  $('pane-camera').prepend(slider('camera.height', 'Eye height', 2, 8, 0.1, (v) => `${v.toFixed(1)} m`));
  $('clock-view').addEventListener('click', api.clockView);

  const pct = (v) => `${Math.round(v * 100)}%`;
  $('pane-sound').append(...['master', 'birds', 'crickets', 'frogs', 'bees', 'wind', 'rain', 'thunder', 'river', 'alarm']
    .map((name) => slider(`volume.${name}`, name[0].toUpperCase() + name.slice(1), 0, 1, 0.05, pct)));
  // under the Birds slider: a switch per species (each call keeps its own random loudness; the slider scales them all)
  $('set-volume-birds').parentElement.after(el('details', { className: 'birds' }, el('summary', { textContent: 'Bird sounds' }),
    el('div', {}, ...audio.BIRDS.map((b) => toggle(`birds.${b.id}`, b.name)))));

  const aa = $('antialias');
  aa.closest('p').before(
    slider('quality.grass', 'Grass density', 0.1, 1, 0.05, pct),
    slider('quality.resolution', 'Resolution', 0.5, 2, 0.25, (v) => `${v}×`),
  );
  onSetting('quality.antialias', (v) => { aa.checked = v; });
  aa.addEventListener('change', () => setSetting('quality.antialias', aa.checked));
  aa.closest('p').after(el('p', {}, toggle('quality.reflections', 'Reflections'), '\u2003', toggle('quality.shadows', 'Tree shadows'), '\u2003', toggle('glass.rain', 'Rain on the glass')));

  // Location: the viewer's location, a chosen place (the first-visit dialog's search, inline) or off (main.js follows
  // the settings); a pressed button that hides moves focus on. The cookie answer can change here too.
  const yes = $('loc-yes'), choose = $('loc-place'), off = $('loc-off'), search = $('loc-search'), status = $('loc-status');
  status.before(el('p', {}, toggle('privacy.storage', 'Save settings on this device (cookies)')));
  const showSearch = (on) => { search.hidden = !on; choose.setAttribute('aria-expanded', on); if (on) search.querySelector('input').focus(); };
  search.append(placeSearch('loc-search-text', () => { showSearch(false); choose.focus(); }));
  const showButtons = () => { yes.hidden = settings['privacy.location'] === true; off.hidden = !settings['privacy.location'] && !settings['place.name']; };
  onSetting('privacy.location', showButtons);
  onSetting('place.name', showButtons);
  yes.addEventListener('click', () => { setSetting('privacy.location', true); setSetting('manual.on', false); showSearch(false); choose.focus(); });
  choose.addEventListener('click', () => showSearch(search.hidden));
  off.addEventListener('click', () => { setSetting('privacy.location', false); setSetting('place.name', ''); yes.focus(); });
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const showStatus = (s) => {
    status.textContent = settings['manual.on'] ? 'Bypassed: the weather below.' : {
      off: 'Off: local time, default weather.',
      locating: 'Locating…',
      loading: `Loading the forecast${s.place ? ` for ${s.place}` : ''}…`,
      ready: `${s.place ?? 'Your area'}${s.updated ? `, ${time(s.updated)}` : ''}`,
      error: `${s.message || 'No local weather.'} ${s.updated ? `Using the forecast from ${time(s.updated)}.` : 'Default weather.'}`,
    }[s.state] ?? '';
  };
  onForecast(showStatus);
  // Bypass location (Settings tab): the weather, wind and direction controls (main.js) show there and drive the scene
  const manual = $('manual');
  manual.addEventListener('change', () => setSetting('manual.on', manual.checked));
  onSetting('manual.on', (v) => {
    manual.checked = v;
    showControls();
    showStatus(forecastStatus);
  });

  // Settings: the clock, "Bypass local time" (the Time slider shows and holds the scene there), volume stabilization, sound timing, how much meadow life
  const bypass = $('bypass-time');
  bypass.addEventListener('change', () => setSetting('time.bypass', bypass.checked));
  onSetting('time.bypass', (v) => { bypass.checked = v; showControls(); });
  $('timing').previousElementSibling.before(el('p', {}, toggle('sound.stabilize', 'Volume stabilization')));
  const often = (v) => (v ? `${v}×` : 'Never');
  $('timing').append(...[['birds', 'Birds'], ['calls', 'Bird calls'], ['thunder', 'Lightning'], ['bees', 'Bees']]
    .map(([k, text]) => slider(`often.${k}`, text, 0, 3, 0.25, often)));
  $('life').append(...[['butterflies', 'Butterflies'], ['fireflies', 'Fireflies'], ['dragonflies', 'Dragonflies'], ['leaves', 'Falling leaves']]
    .map(([k, text]) => slider(`life.${k}`, text, 0, 2, 0.25, (v) => (v ? `${v}×` : 'None'))));

  // Clock (clock.js draws it from these)
  const shift = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  $('pane-clock').append(
    el('p', {}, toggle('clock.on', 'Clock'), '\u2003', toggle('clock.seconds', 'Seconds'), '\u2003', toggle('clock.h24', '24-hour')),
    choice('clock.type', 'Type', { digital: 'Digital', analog: 'Analog' }),
    choice('clock.layer', 'Place', { behind: 'Behind everything', mountain: 'In front of the mountain', clouds: 'In front of the clouds', front: 'In front of everything' }),
    choice('clock.font', 'Font', { serif: 'Elegant serif', script: 'Script', fantasy: 'Fantasy', geometric: 'Geometric', segment: 'Digital segments', sans: 'Plain' }),
    slider('clock.size', 'Size', 0.4, 2.5, 0.05, (v) => `${v.toFixed(2)}×`),
    slider('clock.x', 'Left / right', -0.5, 0.5, 0.01, shift),
    slider('clock.y', 'Down / up', -0.5, 0.5, 0.01, shift),
    color('clock.color', 'Color'),
    slider('clock.glow', 'Glow', 0, 1, 0.05, pct),
    slider('clock.transparency', 'Transparency', 0, 0.9, 0.05, pct),
    el('h3', { textContent: 'Border' }),
    color('clock.borderColor', 'Color'),
    slider('clock.borderTransparency', 'Transparency', 0, 1, 0.05, pct),
    slider('clock.borderGlow', 'Glow', 0, 1, 0.05, pct),
    el('h3', { textContent: 'Outline' }),
    color('clock.outlineColor', 'Color'),
    slider('clock.outline', 'Width', 0, 1, 0.05, pct),
    el('h3', { textContent: 'Shadow' }),
    color('clock.shadowColor', 'Color'),
    slider('clock.shadow', 'Strength', 0, 1, 0.05, pct),
  );

  // Alarm (alarm.js rings it and shows the dialog)
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const at = el('input', { id: 'alarm-time', type: 'time', required: true });
  onSetting('alarm.time', (v) => { at.value = hhmm(v); });
  at.addEventListener('change', () => { const [h, m] = at.value.split(':').map(Number); if (at.value) setSetting('alarm.time', h * 60 + m); });
  $('pane-alarm').append(
    el('p', {}, toggle('alarm.on', 'Alarm')),
    el('div', { className: 'row' }, el('label', { htmlFor: 'alarm-time', textContent: 'Time' }), at),
    slider('alarm.snooze', 'Snooze', 1, 30, 1, (v) => `${v} min`),
    el('div', { className: 'buttons' }, el('button', { type: 'button', textContent: 'Test', onclick: testAlarm })),
  );

  credits($('pane-credits'));
  $('reset').addEventListener('click', resetSettings);
}

// First visit: a centred dialog asks about cookies, then location, then (instead of location) a place. Answered steps
// are skipped; Escape takes the safe choice (Decline; no location, default weather). Never with dev params (screenshots).
function initConsent(api) {
  if (api.dev || (settings['privacy.storage'] !== null && settings['privacy.location'] !== null)) return;
  const dialog = $('consent'), steps = ['consent-cookies', 'consent-location', 'consent-place'].map($);
  let step = 0;
  const show = (i) => {
    step = i;
    steps.forEach((s, j) => { s.hidden = j !== i; });
    dialog.setAttribute('aria-labelledby', `${steps[i].id}-q`);
    if (!dialog.open) dialog.showModal();
    steps[i].querySelector('input, button').focus();
  };
  const cookies = (yes) => { setSetting('privacy.storage', yes); settings['privacy.location'] === null ? show(1) : dialog.close(); };
  $('cookies-yes').addEventListener('click', () => cookies(true));
  $('cookies-no').addEventListener('click', () => cookies(false));
  $('consent-allow').addEventListener('click', () => { setSetting('privacy.location', true); setSetting('manual.on', false); dialog.close(); });
  $('consent-choose').addEventListener('click', () => show(2));
  $('consent-skip').addEventListener('click', () => dialog.close());
  steps[2].querySelector('.buttons').before(placeSearch('consent-search', () => dialog.close()));
  dialog.addEventListener('cancel', (e) => { if (step === 0) { e.preventDefault(); cookies(false); } }); // Escape; later steps just close
  dialog.addEventListener('close', () => { // however it closed, an unanswered question is a no (location: not asked again)
    if (settings['privacy.storage'] === null) setSetting('privacy.storage', false);
    if (settings['privacy.location'] === null) setSetting('privacy.location', false);
  });
  show(settings['privacy.storage'] === null ? 0 : 1);
}

// A place from the search: lat/lon before the name (main.js follows place.name); it replaces the viewer's location.
function pickPlace(p) {
  setSetting('place.lat', p.lat);
  setSetting('place.lon', p.lon);
  if (p.name === settings['place.name']) setSetting('place.name', ''); // same name, other coordinates: still refetch
  setSetting('place.name', p.name);
  setSetting('privacy.location', false);
  setSetting('manual.on', false);
}

// The place search (Open-Meteo geocoding) for the dialog and the Location tab: lists up to 5 places as the viewer
// types (or at once on Enter; names as text only), picking one sets it, then done().
function placeSearch(id, done) {
  const input = el('input', { id, type: 'search', autocomplete: 'off', spellcheck: false });
  const note = el('p', { className: 'hint' }), list = el('div', { className: 'places' });
  const form = el('form', { className: 'place-search' }, input, note, list);
  input.setAttribute('aria-label', 'Place');
  note.setAttribute('role', 'status');
  form.setAttribute('role', 'search');
  let asked = 0, timer = 0;
  const search = async () => {
    clearTimeout(timer);
    const n = ++asked;
    list.replaceChildren();
    if (input.value.trim().length < 2) { note.textContent = ''; return; } // the API matches nothing shorter
    note.textContent = 'Searching…';
    const found = await searchPlaces(input.value).catch(() => null);
    if (n !== asked) return; // a newer search is on its way
    note.textContent = !found ? 'Could not reach the place search.' : found.length ? `${found.length} found` : 'No places found.';
    list.append(...(found ?? []).map((p) => el('button', { type: 'button', textContent: p.name, onclick: () => { pickPlace(p); done(); } })));
  };
  input.addEventListener('input', () => { clearTimeout(timer); asked++; timer = setTimeout(search, 350); }); // one request per pause in typing; older answers dropped
  form.addEventListener('submit', (e) => { e.preventDefault(); search(); });
  return form;
}

// The weather/wind and time controls: shown in their tab while bypassed, always while the debug menu holds them.
function showControls() {
  const debugging = !$('debug').hidden;
  $('controls').hidden = !debugging && !settings['manual.on'];
  $('time-controls').hidden = !debugging && !settings['time.bypass'];
}

// A labelled range input bound to a setting (it follows changes from elsewhere too, e.g. middle-drag).
function slider(key, text, min, max, step, format) {
  const id = `set-${key.replace('.', '-')}`, input = el('input', { id, type: 'range', min, max, step }), out = el('output');
  out.htmlFor = id;
  input.addEventListener('input', () => setSetting(key, Number(input.value)));
  onSetting(key, (v) => {
    input.value = v;
    out.value = format(Number(input.value));
    input.setAttribute('aria-valuetext', out.value);
  });
  return el('div', { className: 'row' }, el('label', { htmlFor: id, textContent: text }), out, input);
}

// A labelled select bound to a setting; names: { value: label } in CHOICES order.
function choice(key, text, names) {
  const id = `set-${key.replace('.', '-')}`, input = el('select', { id }, ...CHOICES[key].map((v) => new Option(names[v], v)));
  input.addEventListener('change', () => setSetting(key, input.value));
  onSetting(key, (v) => { input.value = v; });
  return el('div', { className: 'row' }, el('label', { htmlFor: id, textContent: text }), input);
}

// A labelled colour picker bound to a '#rrggbb' setting.
function color(key, text) {
  const id = `set-${key.replace('.', '-')}`, input = el('input', { id, type: 'color' });
  input.addEventListener('input', () => setSetting(key, input.value));
  onSetting(key, (v) => { input.value = v; });
  return el('div', { className: 'row' }, el('label', { htmlFor: id, textContent: text }), input);
}

// A labelled checkbox bound to a boolean setting.
function toggle(key, text) {
  const input = el('input', { type: 'checkbox' });
  input.addEventListener('change', () => setSetting(key, input.checked));
  onSetting(key, (v) => { input.checked = v; });
  return el('label', {}, input, ` ${text}`);
}

const SOFTWARE = [
  { title: 'three.js', url: 'https://threejs.org', license: 'MIT', licenseUrl: 'https://github.com/mrdoob/three.js/blob/dev/LICENSE' },
  { title: 'Blender', url: 'https://www.blender.org', license: 'GPL', licenseUrl: 'https://www.blender.org/about/license/' },
  { title: 'Playwright', url: 'https://playwright.dev', license: 'Apache-2.0', licenseUrl: 'https://github.com/microsoft/playwright/blob/main/LICENSE' },
];

const link = (text, url) => (/^https?:\/\//.test(url ?? '') ? el('a', { href: url, target: '_blank', rel: 'noopener', textContent: text }) : text);
const license = (c) => (c.license ? [', ', link(c.license.replace(/ \(.*\)$/, ''), c.licenseUrl)] : []);

// Whatever the credit lists hold (audio.js, models.js and forecast.js fill them): name, author, licence.
function credits(pane) {
  const list = (title, items, line) => {
    if (items?.length) pane.append(el('h3', { textContent: title }), el('ul', {}, ...items.map((c) => el('li', {}, ...line(c)))));
  };
  pane.append(
    el('p', {}, el('strong', { textContent: 'Built by Claude - Opus 5.5' })),
    el('p', { className: 'hint', textContent: 'Free to use and share, without warranty. No tracking, no ads; visits are only counted. Looks may resemble HoYoverse’s Genshin Impact; not affiliated with HoYoverse.' }),
  );
  list('Software', SOFTWARE, (c) => [link(c.title, c.url), ...license(c)]);
  // CC BY asks to say a work was changed: the cuts are listed in sounds/CREDITS.md
  list('Sounds', audio.SOUND_CREDITS, (c) => [link(`“${c.title}”`, c.url), c.author ? ` by ${c.author}` : '', ...license(c),
    ...(c.license?.startsWith('CC BY') ? [', ', link('edited', new URL('sounds/CREDITS.md', document.baseURI).href)] : [])]);
  list('Alarm sound', ALARM_CREDITS, (c) => [link(`“${c.title}”`, c.url), c.author ? ` by ${c.author}` : '', ...license(c)]);
  list('Fonts', FONT_CREDITS, (c) => [link(c.title, c.url), c.author ? ` by ${c.author}` : '', ...license(c)]);
  list('3D models', MODEL_CREDITS, (c) => [link(c.title, c.url)]);
  const m = MODEL_CREDITS[0];
  if (m) pane.append(el('p', { className: 'hint' }, `By ${m.by}, `, link('The Models Resource', m.site), '. Genshin Impact © HoYoverse.'));
  list('Weather data', DATA_CREDITS, (c) => [link(c.name, c.url), ...license(c)]);
}

// Debug menu (view picker, time, weather, wind: main.js wires those): the bug button pressed 5 times within 3 s
// shows it, once more hides it. The bug button shows only while the pointer is near the bottom-left corner. The
// time and weather/wind controls (Settings tab) move into the debug menu while it is open.
function initDebug(api) {
  const bug = $('bug'), bar = $('debug'), mix = $('mix');
  const groups = [$('time-controls'), $('controls')].map((g) => ({ g, home: g.parentElement, after: g.nextSibling }));
  let presses = [], timer = 0;
  const info = $('info');
  const near = (e) => {
    bug.classList.toggle('near', e.clientX < 120 && e.clientY > innerHeight - 120);
    info.classList.toggle('near', e.clientX > innerWidth - 140 && e.clientY < 140); // the (i) button firms up as the pointer comes close
  };
  addEventListener('pointermove', near);
  addEventListener('pointerdown', near);
  const showMix = () => { // audio.js's current channel levels, if it shares them
    mix.hidden = false;
    mix.value = Object.entries(audio.audioMix).map(([k, v]) => `${k}\u00a0${typeof v === 'number' ? v.toFixed(2) : v}`).join('   ');
  };
  const show = (on) => {
    bar.hidden = !on;
    bug.setAttribute('aria-expanded', on);
    for (const { g, home, after } of groups) on ? bar.insertBefore(g, $('live')) : home.insertBefore(g, after);
    showControls();
    clearInterval(timer);
    if (on && audio.audioMix) timer = setInterval(showMix, 250);
  };
  bug.addEventListener('click', (e) => {
    if (!bar.hidden) return show(false);
    presses = [...presses.filter((t) => e.timeStamp - t < 3000), e.timeStamp];
    if (presses.length >= 5) { presses = []; show(true); }
  });
  show(api.debug);
}
