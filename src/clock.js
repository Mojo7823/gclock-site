import * as THREE from 'three';
import { uniforms, glslCommon, EYE, MOUNTAIN, heightAt } from './common.js';
import { glslWind } from './wind.js';
import { trees } from './layout.js';
import { settings, onSetting, CHOICES, hourMinute } from './settings.js';

// The clock (the Clock tab's clock.* settings; docs/CLOCK.md). Contract used by main.js:
//   clockLayer                            added to the scene once
//   updateClock(date, hours, camera, dt)  every frame after the scene update: date = the time to show, as is (real time
//                                         plus main.js's offset), hours = the scene's time of day, dt = real seconds
// One quad, four depths (clock.layer): behind = on the far plane before the clouds (mountain, trees and clouds cover it);
// mountain = depth 150 m (past every tree, short of the far land) before the clouds; clouds = the same depth after the
// clouds and bolts; front = a screen-space overlay after everything. Digital or analog (clock.type), six fonts, colour,
// glow, transparency, a border (frosted box or the dial's rings), an outline and a drop shadow, placed between the big
// tree and the summit. Two canvases hold masks (R strokes, G their outline; R drop shadow, G near glow, B wide glow at a
// quarter resolution), redrawn when the shown minute
// (second) or a setting changes; the shader colours them live, draws the border and the analog hands, lights them.
// ?clock=behind|mountain|clouds|front|off, ?clocktype=digital|analog, ?clockfont=<id> override for this load (not saved).

// the fonts in public/fonts (Latin subsets as served by Google Fonts, each with its OFL text), for the credits panel
export const FONT_CREDITS = [
  { title: 'Cormorant Infant', author: 'Christian Thalmann', url: 'https://fonts.google.com/specimen/Cormorant+Infant', license: 'OFL 1.1', licenseUrl: 'https://openfontlicense.org' },
  { title: 'Great Vibes', author: 'Robert Leuschke', url: 'https://fonts.google.com/specimen/Great+Vibes', license: 'OFL 1.1', licenseUrl: 'https://openfontlicense.org' },
  { title: 'Kalnia', author: 'Frida Medrano', url: 'https://fonts.google.com/specimen/Kalnia', license: 'OFL 1.1', licenseUrl: 'https://openfontlicense.org' },
  { title: 'Montserrat', author: 'Julieta Ulanovsky et al.', url: 'https://fonts.google.com/specimen/Montserrat', license: 'OFL 1.1', licenseUrl: 'https://openfontlicense.org' },
];
export const clockLayer = new THREE.Group();

const SYSTEM = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const FONTS = { // loaded on first use (FontFace); the fallback draws until then only if loading failed
  serif: { face: 'Clock Serif', file: 'cormorant-infant-600.woff2', weight: 600, fallback: 'Georgia, serif' },
  script: { face: 'Clock Script', file: 'great-vibes-400.woff2', weight: 400, fallback: 'cursive' },
  fantasy: { face: 'Clock Fantasy', file: 'kalnia-500.woff2', weight: 500, fallback: 'serif' },
  geometric: { face: 'Clock Geometric', file: 'montserrat-400.woff2', weight: 400, fallback: 'sans-serif', outline: true }, // outlined, like the references
  sans: { weight: 600, fallback: SYSTEM },
  segment: { weight: 700, fallback: SYSTEM, segments: true }, // procedural 7-segment digits; labels (AM/PM) in the system face
};
const fontReady = (f) => {
  if (!f.file || f.state === 'ready' || f.state === 'failed') return true;
  if (!f.state) {
    f.state = 'loading';
    const face = new FontFace(f.face, `url(fonts/${f.file})`, { weight: String(f.weight) });
    face.load().then(() => { document.fonts.add(face); f.state = 'ready'; }, () => { f.state = 'failed'; }).finally(() => { dirty = true; });
  }
  return false;
};
const css = (f, px) => `${f.weight} ${px}px ${f.face ? `"${f.face}", ` : ''}${f.fallback}`;

// ---------- settings (dev params override them for this load; a pick in the tab wins) ----------
const over = {};
const cfg = (k) => over[k] ?? settings[k];
let on = false, analog = false, font = FONTS.serif, dirty = true, placeDirty = true, shown = -1, srShown = -1;
let fmt, srFmt;
const periodFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', hourCycle: 'h12' }); // the analog face's AM/PM marker
const sr = document.getElementById('clock-text'); // visually hidden time for screen readers (role timer: not announced)

// ---------- the canvases: masks drawn additively on opaque black (a transparent canvas loses colour to premultiplied alpha) ----------
// strokes (R) at full resolution; the glows (G near, B wide) at a quarter: soft anyway, and blurring is the costly part
function maskCanvas(uniform) {
  const canvas = document.createElement('canvas');
  const c = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), tex: null, uniform }; // CPU-backed: a GPU reset blanks GPU canvases (NOTES.md, leaf canvas)
  c.size = (w, h) => {
    if (c.tex && canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    c.tex?.dispose(); // a new size needs a new GPU texture (three allocates immutable storage)
    c.tex = new THREE.CanvasTexture(canvas, undefined, undefined, undefined, THREE.LinearFilter, THREE.LinearFilter);
    c.tex.generateMipmaps = false; // drawn at its screen size (place()): no mip chain to build on every upload
    U[uniform].value = c.tex;
  };
  return c;
}
const strokes = maskCanvas('uMap'), glows = maskCanvas('uGlowMap'), GLOW_RES = 0.25;
let ctx = strokes.ctx; // what the drawing helpers draw on

// "10:42", seconds and the day period ("PM", "上午" or none) with its side, from the viewer's locale
function timeParts(date) {
  const t = { main: '', hour: '', minute: '', sec: '', period: '', periodFirst: false };
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'hour') t.main = t.hour = p.value;
    else if (p.type === 'minute') { t.minute = p.value; t.main += p.value; }
    else if (p.type === 'literal' && t.hour && !t.minute) t.main += p.value.trim() || ':';
    else if (p.type === 'second') t.sec = p.value;
    else if (p.type === 'dayPeriod') { t.period = p.value; t.periodFirst = !t.hour; }
  }
  if (font.segments && /^\d$/.test(t.hour)) t.main = '~' + t.main; // an unlit leading digit: only its ghost shows
  return t;
}

// 7-segment digits: a..g bits per digit, and each segment as a bevelled hexagon in a w x h cell (baseline y)
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const SEG_W = 0.56, SEG_T = 0.15, SEG_ADV = 0.78, SEG_COLON = 0.34, SEG_INK = 0.72; // x the digit height; digit height x px
function segPath(x, y, h, mask) {
  const w = h * SEG_W, t = h * SEG_T, hw = t / 2, g = t * 0.14, top = y - h, mid = y - h / 2, l = x + hw, r = x + w - hw;
  const hex = (pts) => { ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < 12; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); };
  const H = (yc) => hex([l + g, yc, l + hw + g, yc - hw, r - hw - g, yc - hw, r - g, yc, r - hw - g, yc + hw, l + hw + g, yc + hw]);
  const V = (xc, y0, y1) => hex([xc, y0 + g, xc + hw, y0 + hw + g, xc + hw, y1 - hw - g, xc, y1 - g, xc - hw, y1 - hw - g, xc - hw, y0 + hw + g]);
  const segs = [() => H(top + hw), () => V(r, top + hw, mid), () => V(r, mid, y - hw), () => H(y - hw), () => V(l, mid, y - hw), () => V(l, top + hw, mid), () => H(mid)];
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) segs[i]();
}
// text width at px in font f (segments: digits, separators, anything else in the system face)
function measure(f, s, px) {
  if (!f.segments) { ctx.font = css(f, px); return ctx.measureText(s).width; }
  let w = 0;
  const h = px * SEG_INK;
  for (const ch of s) w += /[\d~]/.test(ch) ? h * SEG_ADV : /[:.]/.test(ch) ? h * SEG_COLON : measure(FONTS.sans, ch, px);
  return w;
}
// extra line width for the outline pass and the shadow it casts ('o', 's'), at font size px
const fatOf = (kind, px) => (kind === 'o' || kind === 's' ? 2 * outlineW * px * (analog ? 2 : 1) : 0); // the dial's numerals are small: x 2
// draws s with its left end at x on baseline y; kind 'r' = the strokes, 'g'/'b' = a glow pass (fatter, no ghosts),
// 'o' = the outline (the strokes widened), 's' = the drop shadow (as 'o', blurred and shifted)
function drawStr(f, s, x, y, px, kind) {
  const fat = fatOf(kind, px); // lineWidth = 0 is ignored by canvas: only stroked when > 0
  if (f.segments) {
    const h = px * SEG_INK;
    for (const ch of s) {
      if (/[\d~]/.test(ch)) {
        if (kind === 'r') { ink(0.16); ctx.beginPath(); segPath(x, y, h, 0x7f); ctx.fill(); ink(1); } // ghost segments (unlit)
        if (ch !== '~') { ctx.beginPath(); segPath(x, y, h, SEG[ch]); ctx.fill(); if (fat) { ctx.lineWidth = fat; ctx.stroke(); } }
        x += h * SEG_ADV;
      } else if (/[:.]/.test(ch)) {
        const d = h * SEG_T * 0.62, cx = x + h * SEG_COLON / 2 - h * 0.04;
        ctx.beginPath();
        for (const cy of ch === ':' ? [y - h * 0.3, y - h * 0.7] : [y - d]) { ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d, cy); ctx.lineTo(cx, cy + d); ctx.lineTo(cx - d, cy); ctx.closePath(); }
        ctx.fill();
        if (fat) { ctx.lineWidth = fat; ctx.stroke(); }
        x += h * SEG_COLON;
      } else { drawStr(FONTS.sans, ch, x, y, px, kind); x += measure(FONTS.sans, ch, px); }
    }
    return;
  }
  ctx.font = css(f, px);
  if (f.outline) { ctx.lineWidth = px * (kind === 'g' || kind === 'b' ? 0.08 : 0.04) + fat; ctx.strokeText(s, x, y); return; } // hollow: the outline edges its stroke
  ctx.fillText(s, x, y);
  if (kind === 'g' || kind === 'b') { ctx.lineWidth = px * 0.05; ctx.strokeText(s, x, y); }
  if (fat) { ctx.lineWidth = fat; ctx.strokeText(s, x, y); }
}
let kindNow = 'r', outlineW = 0, shadowDrawn = false; // outline width per side x font size; whether the shadow mask is drawn
const ink = (level) => { if (kindNow === 'r') ctx.fillStyle = ctx.strokeStyle = `rgb(${Math.round(level * 255)},0,0)`; };
// one mask pass: 'r'/'o' crisp; 'g'/'b'/'s' their blurred shadow only (drawn off the canvas, the shadow shifted back in,
// plus dx, dy for the drop shadow; canvas shadow offsets and blur ignore the transform, hence x k)
const OFF = 20000;
function pass(kind, blur, k, draw, dx = 0, dy = 0) {
  kindNow = kind;
  const soft = kind !== 'r' && kind !== 'o';
  ctx.fillStyle = ctx.strokeStyle = ctx.shadowColor = kind === 'b' ? '#00f' : kind === 'g' || kind === 'o' ? '#0f0' : '#f00';
  ctx.shadowBlur = soft ? blur * k : 0;
  ctx.shadowOffsetX = soft ? OFF + dx * k : 0;
  ctx.shadowOffsetY = soft ? dy * k : 0;
  ctx.setTransform(k, 0, 0, k, soft ? -OFF : 0, 0);
  draw(kind);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
}
// both canvases cleared, then the glow (and shadow) passes on the small one, the strokes (and outline) on the big one;
// shadow = [dx, dy, blur] in canvas units
function paint(k, nearBlur, wideBlur, shadow, draw) {
  shadowDrawn = settings['clock.shadow'] > 0;
  for (const c of [glows, strokes]) {
    ctx = c.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.canvas.width, c.canvas.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (c === glows) {
      pass('b', wideBlur, k * GLOW_RES, draw);
      pass('g', nearBlur, k * GLOW_RES, draw);
      if (shadowDrawn) pass('s', shadow[2], k * GLOW_RES, draw, shadow[0], shadow[1]);
    } else {
      pass('r', 0, k, draw);
      if (outlineW) pass('o', 0, k, draw);
    }
    c.tex.needsUpdate = true;
  }
  ctx = strokes.ctx;
}

// ---------- layout, in canvas units at P0 (the canvas is drawn scaled to its resolution) ----------
// W x H the quad; boxW x boxH the border box (digital) or the outer ring's square (analog: R = boxH / 2)
const P0 = 100;
const lay = { W: 1, H: 1, boxW: 1, boxH: 1, inkH: 1 };
const inkOf = (f, px) => { // ascent, descent of the digits
  if (f.segments) return [px * SEG_INK, 0];
  ctx.font = css(f, px);
  const m = ctx.measureText('0123456789');
  return [m.actualBoundingBoxAscent, m.actualBoundingBoxDescent];
};
function layoutDigital(t) {
  const f = font, lf = f.segments ? FONTS.sans : f, sP = P0 * 0.5, gap = P0 * 0.14;
  const [A, D] = inkOf(f, P0), inkH = A + D, padX = 0.5 * inkH, padY = 0.36 * inkH, m = 0.55 * inkH;
  let pP = P0 * 0.34, pA = 0;
  if (t.period) { // above the seconds it must fit their gap (a script "PM" is tall)
    ctx.font = css(lf, pP);
    const pm = ctx.measureText(t.period), k = t.sec ? Math.min(1, (A * 0.5 - P0 * 0.08) / (pm.actualBoundingBoxAscent + pm.actualBoundingBoxDescent)) : 1;
    pP *= k;
    pA = pm.actualBoundingBoxAscent * k;
  }
  const mainW = measure(f, t.main.replace(/\d/g, '0'), P0); // steady while the digits change
  const secW = t.sec ? measure(f, '00', sP) : 0, perW = t.period ? measure(lf, t.period, pP) : 0;
  const colW = Math.max(secW, perW), textW = mainW + (colW ? gap + colW : 0);
  Object.assign(lay, { boxW: textW + 2 * padX, boxH: inkH + 2 * padY, inkH });
  lay.W = lay.boxW + 2 * m; lay.H = lay.boxH + 2 * m;
  const x0 = m + padX, base = m + padY + A, mainX = t.periodFirst && colW ? x0 + colW + gap : x0, colX = mainX === x0 ? x0 + mainW + gap : x0;
  lay.main = [mainX + (mainW - measure(f, t.main, P0)) / 2, base];
  lay.sec = [colX, base];
  lay.period = [colX, t.sec ? base - A + pA : base, pP]; // above the seconds, or on the baseline
}
function layoutAnalog() {
  Object.assign(lay, { W: 250, H: 250, boxW: 200, boxH: 200, inkH: 20 }); // R = 100, room for the glow around the ring
}

function drawDigital(t, k) {
  const f = font, lf = f.segments ? FONTS.sans : f;
  const draw = (kind) => {
    drawStr(f, t.main, lay.main[0], lay.main[1], P0, kind);
    if (t.sec) drawStr(f, t.sec, lay.sec[0], lay.sec[1], P0 * 0.5, kind);
    if (t.period) drawStr(lf, t.period, ...lay.period, kind);
  };
  paint(k, lay.inkH * 0.09, lay.inkH * 0.45, [0.05, 0.07, 0.08].map((s) => s * lay.inkH), draw);
}

// the analog face (hands and outer rings are the shader's): ticks, numerals, a faint inner ring and gears, AM/PM
function gear(cx, cy, r, teeth) {
  ctx.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * 2 * Math.PI, s = (2 * Math.PI) / teeth;
    for (const [da, rr] of [[0, 0.84], [0.12, 1], [0.42, 1], [0.54, 0.84]]) ctx.lineTo(cx + Math.cos(a + da * s) * r * rr, cy + Math.sin(a + da * s) * r * rr);
  }
  ctx.closePath();
  ctx.moveTo(cx + r * 0.3, cy); ctx.arc(cx, cy, r * 0.3, 0, 7);
  for (let i = 0; i < 5; i++) { const a = i * 1.2566; ctx.moveTo(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3); ctx.lineTo(cx + Math.cos(a) * r * 0.76, cy + Math.sin(a) * r * 0.76); }
  ctx.stroke();
}
function drawAnalog(period, k) {
  const f = font, c = 125, R = 100, np = R * 0.21, [A, D] = inkOf(f, np);
  const draw = (kind) => {
    const strokes = kind === 'r';
    for (let i = 0; i < 60; i++) { // minute ticks, longer and brighter at the hours
      const major = i % 5 === 0, a = (i / 30) * Math.PI, s = Math.sin(a), co = -Math.cos(a), r0 = R * (major ? 0.79 : 0.84);
      if (!major && !strokes) continue;
      ink(major ? 1 : 0.55);
      ctx.lineWidth = R * (major ? 0.022 : 0.009) + fatOf(kind, np);
      ctx.beginPath(); ctx.moveTo(c + s * r0, c + co * r0); ctx.lineTo(c + s * R * 0.88, c + co * R * 0.88); ctx.stroke();
    }
    ink(1);
    for (let n = 1; n <= 12; n++) {
      const a = (n / 6) * Math.PI, s = String(n);
      drawStr(f, s, c + Math.sin(a) * R * 0.655 - measure(f, s, np) / 2, c - Math.cos(a) * R * 0.655 + (A - D) / 2, np, kind);
    }
    if (period) { ink(0.75); drawStr(f.segments ? FONTS.sans : f, period, c - measure(f.segments ? FONTS.sans : f, period, R * 0.1) / 2, c + R * 0.42, R * 0.1, kind); }
    if (!strokes) return;
    ink(0.4); ctx.lineWidth = R * 0.006; // inner ring
    ctx.beginPath(); ctx.arc(c, c, R * 0.52, 0, 7); ctx.stroke();
    ink(0.2); ctx.lineWidth = R * 0.008; // clockwork, faint
    gear(c, c - R * 0.22, R * 0.2, 14);
    gear(c + R * 0.27, c + R * 0.1, R * 0.14, 10);
    gear(c - R * 0.06, c + R * 0.3, R * 0.11, 9);
    gear(c - R * 0.29, c + R * 0.04, R * 0.12, 10);
  };
  paint(k, R * 0.035, R * 0.16, ANALOG_SHADOW.map((s) => s * R), draw);
}

// ---------- the material ----------
const ANALOG_SHADOW = [0.02, 0.028, 0.035]; // the dial's drop shadow: dx, dy (down-right), blur, x R (canvas and the shader's hands)
const U = {
  ...uniforms,
  uMap: { value: null },
  uGlowMap: { value: null },
  uFront: { value: 0 }, // 1 = screen-space overlay
  uRect: { value: new THREE.Vector4() }, // overlay: NDC left, bottom, right, top
  uDepth: { value: 0 }, // view distance (m) its depth is written at; 0 = the far plane
  uHazeAmt: { value: 0 }, // share of applyFog at its 450 m spot
  uAnalog: { value: 0 },
  uQuad: { value: new THREE.Vector2(1, 1) }, // quad size in border units (half the box height; the ring radius)
  uBox: { value: new THREE.Vector3() }, // digital: box half width, half height (1), corner radius, in border units
  uHands: { value: new THREE.Vector4() }, // hour, minute, second angle (rad, clockwise from 12), second hand on
  uColor: { value: new THREE.Color() },
  uBorderColor: { value: new THREE.Color() },
  uLook: { value: new THREE.Vector4() }, // glow, opacity, border glow, border opacity
  uOutlineColor: { value: new THREE.Color() },
  uShadowColor: { value: new THREE.Color() },
  uLook2: { value: new THREE.Vector2() }, // the hands' outline width (x R), shadow strength
  uPatch: { value: new THREE.Vector4() }, // overlay: the meadow patch its shade comes from: centre xz, right axis xz (m)
  uPatchFwd: { value: new THREE.Vector2() }, // its forward axis xz (m)
};
const mat = new THREE.ShaderMaterial({
  uniforms: U,
  transparent: true,
  premultipliedAlpha: true, // glows add light, strokes cover
  depthWrite: false,
  vertexShader: /* glsl */ `
    uniform float uFront;
    uniform vec4 uRect;
    uniform float uDepth;
    varying vec2 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = uv;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      if (uFront > 0.5) { gl_Position = vec4(mix(uRect.xy, uRect.zw, uv), 0.0, 1.0); return; }
      gl_Position = projectionMatrix * viewMatrix * w;
      // far plane: every opaque thing hides it; uDepth: only what is nearer (trees), not the far land and the mountain
      gl_Position.z = gl_Position.w * (uDepth > 0.0 ? (projectionMatrix[3][2] - projectionMatrix[2][2] * uDepth) / uDepth : 0.99999);
    }`,
  fragmentShader: glslCommon + glslWind + /* glsl */ `
    uniform sampler2D uMap;
    uniform sampler2D uGlowMap;
    uniform float uFront;
    uniform float uHazeAmt;
    uniform float uAnalog;
    uniform vec2 uQuad;
    uniform vec3 uBox;
    uniform vec4 uHands;
    uniform vec3 uColor;
    uniform vec3 uBorderColor;
    uniform vec4 uLook;
    uniform vec3 uOutlineColor;
    uniform vec3 uShadowColor;
    uniform vec2 uLook2;
    uniform vec4 uPatch;
    uniform vec2 uPatchFwd;
    varying vec2 vUv;
    varying vec3 vWorld;
    float luma(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
    vec3 pale(vec3 c) { return mix(vec3(1.0), c / max(max(c.r, c.g), max(c.b, 1e-3)), 0.5); } // the light's hue, kept light
    float hand(vec2 p, vec2 a, vec2 b, float w0, float w1) { // tapered segment a..b
      vec2 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h) - mix(w0, w1, h);
    }
    vec2 dirOf(float a) { return vec2(sin(a), cos(a)); }
    void over(inout vec4 acc, vec3 c, float a) { acc = vec4(c * a, a) + acc * (1.0 - a); } // premultiplied
    float hands(vec2 p) { // signed distance to the hands and the hub (R = 1)
      vec2 h = dirOf(uHands.x), mi = dirOf(uHands.y), s = dirOf(uHands.z);
      float r = length(p), d = min(hand(p, -h * 0.1, h * 0.5, 0.03, 0.01), hand(p, -mi * 0.12, mi * 0.76, 0.022, 0.007));
      d = min(d, abs(length(p - h * 0.3) - 0.05) - 0.01); // the hour hand's ring
      d = min(min(d, abs(r - 0.062) - 0.014), r - 0.022); // the hub
      if (uHands.w > 0.5) d = min(d, hand(p, -s * 0.2, s * 0.86, 0.007, 0.004));
      return d;
    }
    void main() {
      vec2 sm = texture2D(uMap, vUv).rg;
      vec3 gm = texture2D(uGlowMap, vUv).rgb;
      vec2 p = (vUv - 0.5) * uQuad;
      float aa = length(fwidth(p)) * 0.75;
      float edge, inside, rate, ink = sm.r, outl = sm.g, drop = gm.r, near = gm.g, wide = gm.b;
      if (uAnalog > 0.5) {
        float r = length(p);
        edge = min(abs(r - 1.0) - 0.016, abs(r - 0.94) - 0.005); // the outer rings
        inside = 1.0 - smoothstep(-aa, aa, r - 1.0);
        rate = 12.0;
        float d = hands(p);
        ink = max(ink, 1.0 - smoothstep(-aa, aa, d));
        if (uLook2.x > 0.0) outl = max(outl, 1.0 - smoothstep(-aa, aa, d - uLook2.x));
        const vec3 S = vec3(${ANALOG_SHADOW.join(', ')}); // canvas y is down, p.y up
        if (uLook2.y > 0.0) drop = max(drop, 1.0 - smoothstep(-S.z, S.z, hands(p - vec2(S.x, -S.y))));
        near = max(near, exp(-max(d, 0.0) * 30.0) * 0.9);
        wide = max(wide, exp(-max(d, 0.0) * 8.0) * 0.5);
      } else {
        vec2 q = abs(p) - uBox.xy + uBox.z;
        float b = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uBox.z;
        edge = abs(b) - 0.02; // the box outline
        inside = 1.0 - smoothstep(-aa, aa, b);
        rate = 6.0;
      }
      float border = 1.0 - smoothstep(-aa, aa, edge), rim = exp(-max(edge, 0.0) * rate);
      // the sky behind it (sky.js's gradient, greyed under a deck like applyFog)
      float e = uFront > 0.5 ? 0.25 : max(normalize(vWorld - cameraPosition).y, 0.0);
      vec3 sky = mix(uFogColor, uZenithColor, pow(e, 0.6));
      sky = mix(sky, vec3(luma(sky)), 0.65 * uDeck.x);
      float skyL = luma(sky), night = 1.0 - smoothstep(0.04, 0.25, skyL);
      // its own light, tinted by the scene's: warm at golden hour, a little cooler and dimmer by moonlight
      vec3 tint = mix(vec3(1.0), pale(uSunColor), mix(0.45, 0.15, night));
      vec3 fill = uColor * tint, line = uBorderColor * tint, olc = uOutlineColor * tint, dark = uShadowColor;
      if (uFront > 0.5) {
        // it "hangs" over a patch of meadow ahead: the cloud shadows crossing it cross the clock; leaf shade on the left
        vec2 w = uPatch.xy + (vUv.x - 0.5) * uPatch.zw + (vUv.y - 0.5) * uPatchFwd;
        float lit = cloudShadow(vec3(w.x, 0.0, w.y));
        vec2 lq = vec2(vUv.x * uQuad.x / uQuad.y, vUv.y) * 2.2;
        float g = windGust(w), s = min(uWindStrength / 10.0, 1.0);
        lq += vec2(sin(uWindPhase), cos(uWindPhase * 0.7)) * (0.04 + 0.12 * g) * s + uWindDrift * 0.002;
        float leaves = smoothstep(0.5, 0.62, vnoise(lq) * 0.65 + vnoise(lq * 2.3 + 5.0) * 0.35);
        lit *= 1.0 - 0.55 * uShadowStrength * leaves * (1.0 - smoothstep(0.15, 0.75, vUv.x));
        vec3 shade = mix(pale(uShadeColor) * 0.75, vec3(1.0), lit);
        fill *= shade;
        line *= shade;
        olc *= shade;
      } else {
        // the air between: hazy in weather, warm at dusk; then a step lighter than the sky behind, so it never sinks into it
        float haze = uHazeAmt * mix(1.0, 0.35, night); // it glows: the night air dims it less
        fill = mix(fill, applyFog(fill, vWorld), haze);
        line = mix(line, applyFog(line, vWorld), haze);
        olc = mix(olc, applyFog(olc, vWorld), haze);
        dark = mix(dark, applyFog(dark, vWorld), haze);
        fill *= clamp((skyL * 1.3 + 0.08) / max(luma(fill), 1e-3), 1.0, 1.6);
      }
      vec4 acc = vec4(0.0);
      float day = smoothstep(0.12, 0.45, skyL);
      over(acc, dark, min(drop * uLook2.y * 0.9, 0.9)); // the drop shadow, under everything: it darkens what is behind
      over(acc, mix(sky, line, 0.3) + 0.05, inside * uLook.w * mix(0.2, 0.08, day)); // frosted glass: a pale veil (nothing behind is blurred)
      over(acc, sky * 0.3, day * min(near * 0.9 + wide * 0.8, 0.8)); // a soft dark backing on a bright sky: contrast for a pale clock
      over(acc, line, border * uLook.w);
      over(acc, olc, outl);
      over(acc, fill, ink);
      // glows: light added around the strokes and the border, also covering a little so they show on a bright sky
      vec3 glow = (fill * uLook.x * (near * 1.1 + wide * 0.9) + line * uLook.z * uLook.w * rim) * (1.0 - max(ink, outl)) * (1.0 - 0.85 * day); // daylight would wash it out
      acc.rgb += glow;
      acc.a += min(luma(glow) * 0.7, 1.0) * (1.0 - acc.a);
      if (acc.a < 0.003) discard;
      float a = acc.a * uLook.y * (1.0 - 0.2 * uDeck.x * (1.0 - uFront)); // a sheet deck veils it in the sky
      gl_FragColor = vec4(linearToOutputTexel(vec4(acc.rgb / acc.a, 1.0)).rgb * a, a);
    }`,
});
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
mesh.frustumCulled = false;
clockLayer.add(mesh);
const LAYERS = { // render order (sky dome -2, sun/moon 1, deck 2, puffs 3, bolts 4, rain 5), depth (m, 0 = far), haze
  behind: [2.5, 0, 0.7],
  mountain: [2.5, 150, 0.45], // 150 m: past the farthest tree (~135 m), short of the far land (190 m+)
  clouds: [4.5, 150, 0.2],
  front: [10, 0, 0],
};

// ---------- placement ----------
// The default spot, measured in main.js's clock view for this screen shape: right of the clock just short of the cap
// cloud, in the sky above the big tree's crown, level with the summit; x/y/size from there, kept on the screen. The
// world layers stay at that spot in the world (450 m out); the overlay keeps its screen rectangle.
const DIST = 450, vcam = new THREE.PerspectiveCamera(50, 1, 0.1, 1200), v = new THREE.Vector3(), look3 = new THREE.Vector3();
const giant = trees.find((t) => t.type === 'giant') ?? { x: 0, z: -60, height: 25 };
const ground = heightAt(EYE.x, EYE.z), deg = THREE.MathUtils.degToRad;
const crownTop = new THREE.Vector3(giant.x, heightAt(giant.x, giant.z) + giant.height, giant.z);
const capLeft = new THREE.Vector3(MOUNTAIN.x - 45, MOUNTAIN.y + 10, MOUNTAIN.z), summit = new THREE.Vector3(MOUNTAIN.x, MOUNTAIN.y, MOUNTAIN.z);
function clockCamera(aspect) { // as main.js clockView()
  const g = Math.atan2(giant.x, EYE.z - giant.z), m = Math.atan2(MOUNTAIN.x, EYE.z - MOUNTAIN.z), portrait = aspect < 1;
  const heading = portrait ? (g - deg(18) + m + deg(7)) / 2 : (g + m) / 2, half = portrait ? (m - g + deg(25)) / 2 + deg(0.5) : 0;
  const h = THREE.MathUtils.clamp(settings['camera.height'], 2, 8);
  vcam.fov = THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(half) / aspect)), 50, portrait ? 82 : 55);
  vcam.aspect = aspect;
  vcam.position.set(EYE.x, ground + h, EYE.z);
  vcam.lookAt(EYE.x + 15 * Math.sin(heading), ground + h + 2.3 - 0.26 * (h - 1.5), EYE.z - 15 * Math.cos(heading));
  vcam.updateProjectionMatrix();
  vcam.updateMatrixWorld();
}
let placedAspect = 0, placedH = 0, placedBox = 0, level = 0;
function place(aspect) {
  placedAspect = aspect;
  placedH = innerHeight;
  placedBox = lay.boxW / lay.boxH;
  placeDirty = false;
  clockCamera(aspect);
  const right = v.copy(capLeft).project(vcam).x - 0.04, crownY = v.copy(crownTop).project(vcam).y, peakY = v.copy(summit).project(vcam).y;
  let bh = analog ? 0.62 : 0.36, bw = (bh * placedBox) / aspect; // box height (NDC): 18% of the screen, the dial 31%
  if (bw > right + 0.94) { bh *= (right + 0.94) / bw; bw = right + 0.94; } // fit between the left edge and the cap
  const cx0 = right - bw / 2, cy0 = Math.min(Math.max(crownY + 0.4 * bh, peakY), 0.9 - bh / 2);
  const size = cfg('clock.size');
  bh *= size; bw *= size;
  const fit = Math.min(1, (2 - 48 / innerWidth) / bw, (2 - 48 / innerHeight) / bh); // never wider or taller than the screen (size 2.5 on a phone)
  bh *= fit; bw *= fit;
  const keep = (c, half, edge) => (half < 1 - edge ? THREE.MathUtils.clamp(c, -1 + edge + half, 1 - edge - half) : 0); // the box stays on the screen, 12 px in
  const cx = keep(cx0 + 2 * cfg('clock.x'), bw / 2, 24 / innerWidth), cy = keep(cy0 + 2 * cfg('clock.y'), bh / 2, 24 / innerHeight);
  const qh = (bh * lay.H) / lay.boxH, qw = (qh * lay.W) / lay.H / aspect;
  U.uRect.value.set(cx - qw / 2, cy - qh / 2, cx + qw / 2, cy + qh / 2);
  // anchored where the clock view shows it; updateClock keeps it parallel to the live image plane (level and
  // undistorted when the viewer turns; facing the eye instead would skew a wide one)
  v.set(cx, cy, 0.5).unproject(vcam).sub(vcam.position).normalize();
  mesh.position.copy(vcam.position).addScaledVector(v, DIST);
  mesh.quaternion.copy(vcam.quaternion);
  const wh = DIST * v.dot(vcam.getWorldDirection(look3)) * Math.tan(deg(vcam.fov / 2)) * qh;
  mesh.scale.set((wh * lay.W) / lay.H, wh, 1);
  // canvas resolution: the drawn height in device pixels, in steps of √2 (a size drag re-allocates only at a step)
  const px = (qh / 2) * innerHeight * Math.min(devicePixelRatio, settings['quality.resolution']);
  const next = Math.min(2 ** (Math.ceil(Math.log2(Math.max(px, 96)) * 2) / 2), 2048, (4096 * lay.H) / lay.W);
  if (Math.abs(next - level) > 1) { level = next; dirty = true; }
}

// ---------- settings and the frame update ----------
function configure() {
  on = cfg('clock.on');
  analog = cfg('clock.type') === 'analog';
  font = FONTS[cfg('clock.font')] ?? FONTS.serif;
  const [order, depth, haze] = LAYERS[cfg('clock.layer')] ?? LAYERS.behind;
  mesh.renderOrder = order;
  mat.depthTest = order < 10;
  U.uFront.value = order < 10 ? 0 : 1;
  U.uDepth.value = depth;
  U.uHazeAmt.value = haze;
  U.uAnalog.value = analog ? 1 : 0;
  const hour = hourMinute(cfg('clock.h24'));
  srFmt = new Intl.DateTimeFormat(undefined, hour);
  fmt = cfg('clock.seconds') ? new Intl.DateTimeFormat(undefined, { ...hour, second: '2-digit' }) : srFmt;
  clockLayer.visible = on;
  if (sr) sr.hidden = !on;
  dirty = placeDirty = true;
  srShown = -1;
}
const look = () => {
  U.uColor.value.set(settings['clock.color']);
  U.uBorderColor.value.set(settings['clock.borderColor']);
  U.uLook.value.set(settings['clock.glow'], 1 - settings['clock.transparency'], settings['clock.borderGlow'], 1 - settings['clock.borderTransparency']);
  U.uOutlineColor.value.set(settings['clock.outlineColor']);
  U.uShadowColor.value.set(settings['clock.shadowColor']);
  outlineW = settings['clock.outline'] * 0.05;
  U.uLook2.value.set(outlineW * 0.42, settings['clock.shadow']); // the hands as the numerals: x 2 x 0.21 (their size, R = 1)
};
const PICKS = ['clock.on', 'clock.type', 'clock.layer', 'clock.font', 'clock.seconds', 'clock.h24'];
for (const k of PICKS) onSetting(k, () => { delete over[k]; configure(); });
for (const k of ['clock.color', 'clock.glow', 'clock.transparency', 'clock.borderColor', 'clock.borderTransparency', 'clock.borderGlow', 'clock.outlineColor', 'clock.shadowColor']) onSetting(k, look);
onSetting('clock.outline', () => { look(); dirty = true; }); // a wider stroke: redrawn
onSetting('clock.shadow', (v) => { look(); if (v > 0 !== shadowDrawn) dirty = true; }); // strength is live; the mask is drawn only when on
for (const k of ['clock.size', 'clock.x', 'clock.y', 'camera.height', 'quality.resolution']) onSetting(k, () => { placeDirty = true; });
const params = new URLSearchParams(location.search), layerParam = params.get('clock');
if (layerParam === 'off') over['clock.on'] = false;
else if (CHOICES['clock.layer'].includes(layerParam)) Object.assign(over, { 'clock.on': true, 'clock.layer': layerParam });
if (CHOICES['clock.type'].includes(params.get('clocktype'))) over['clock.type'] = params.get('clocktype');
if (CHOICES['clock.font'].includes(params.get('clockfont'))) over['clock.font'] = params.get('clockfont');
configure();

const fwd = new THREE.Vector3();
export function updateClock(date, hours, camera, dt) {
  if (!on) return;
  const ms = date.getTime(), minute = Math.floor(ms / 60000);
  if (minute !== srShown && sr) { srShown = minute; sr.textContent = srFmt.format(date); }
  const seconds = fmt !== srFmt, step = analog ? (date.getHours() < 12 ? 0 : 1) : Math.floor(ms / (seconds ? 1000 : 60000));
  if (dirty || step !== shown) {
    if (!fontReady(font)) { mesh.visible = false; return; } // a moment on first use, rather than a jump from the fallback face
    dirty = false;
    shown = step;
    const t = analog ? null : timeParts(date);
    if (analog) layoutAnalog(); else layoutDigital(t);
    if (placeDirty || camera.aspect !== placedAspect || innerHeight !== placedH || Math.abs(lay.boxW / lay.boxH - placedBox) > 1e-3) place(camera.aspect);
    dirty = false; // place() may ask for a new resolution: drawn right here
    const k = level / lay.H;
    strokes.size(Math.ceil(lay.W * k), Math.ceil(lay.H * k));
    glows.size(Math.ceil(lay.W * k * GLOW_RES), Math.ceil(lay.H * k * GLOW_RES));
    if (analog) drawAnalog(periodFmt.formatToParts(date).find((p) => p.type === 'dayPeriod')?.value ?? '', k); else drawDigital(t, k);
    U.uQuad.value.set(lay.W, lay.H).divideScalar(lay.boxH / 2);
    U.uBox.value.set(lay.boxW / lay.boxH, 1, 0.36);
    mesh.visible = true;
  }
  if (placeDirty || camera.aspect !== placedAspect || innerHeight !== placedH) { place(camera.aspect); if (dirty) return; } // redrawn next frame at the new resolution
  if (!U.uFront.value) mesh.quaternion.copy(camera.quaternion);
  if (analog) {
    const s = date.getSeconds(), m = date.getMinutes() + s / 60, TAU = 2 * Math.PI;
    U.uHands.value.set((((date.getHours() % 12) + m / 60) / 12) * TAU, (m / 60) * TAU, (s / 60) * TAU, seconds ? 1 : 0);
  }
  if (U.uFront.value) {
    // the meadow patch: 70 m ahead of the camera, 160 m across, 80 m deep (the top of the clock is the far side)
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    U.uPatch.value.set(camera.position.x + fwd.x * 70, camera.position.z + fwd.z * 70, -fwd.z * 160, fwd.x * 160);
    U.uPatchFwd.value.set(fwd.x * 80, fwd.z * 80);
  }
}
