import * as THREE from 'three';
import { mulberry32, uniforms, glslCommon } from './common.js';
import { weather } from './weather.js';
import { sunDir, moonDir, moon, starFrame, setSceneClock } from './daycycle.js';

// The sky behind everything: a dome with the horizon -> zenith gradient, the night glow over the
// horizon, twilight glow, moon halo, Milky Way and shooting stars, plus the stars as points. By day it
// is a faint gradient; the night is built from the same scene clock as the clouds (same sky for everyone).

const { smoothstep } = THREE.MathUtils;
const R = 460; // beyond the terrain (~360 m) and the sun/moon discs (440 m), inside the far plane

// Galactic frame in equatorial coordinates (x = RA 0h, z = north celestial pole; starFrame turns it into the world)
const eq = (ra, dec) => {
  const a = THREE.MathUtils.degToRad(ra), d = THREE.MathUtils.degToRad(dec);
  return new THREE.Vector3(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
};
const GNP = eq(192.859, 27.128); // galactic north pole
const GC = eq(266.405, -28.936); // galactic centre (Sagittarius)
GC.addScaledVector(GNP, -GC.dot(GNP)).normalize();
const GL90 = new THREE.Vector3().crossVectors(GNP, GC); // galactic longitude 90° (Cygnus)
const vec3 = (v) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;

// ---------- dome: gradient, glows, Milky Way, shooting stars ----------
const domeUniforms = {
  ...uniforms,
  uCel: { value: new THREE.Matrix3() }, // world -> equatorial
  uAirglow: { value: new THREE.Color() },
  uTwilight: { value: new THREE.Color() },
  uTwilightHigh: { value: new THREE.Color() },
  uBelt: { value: new THREE.Color() },
  uMoonHalo: { value: new THREE.Color() },
  uMilky: { value: 0 },
  uMoonRadius: { value: moon.radius },
  uMeteorA: { value: new THREE.Vector3(1, 0, 0) },
  uMeteorB: { value: new THREE.Vector3(0, 1, 0) },
  uMeteor: { value: new THREE.Vector2() }, // head position along the path 0..1, brightness
};
const MW_CELLS = 40; // noise cells around the galactic plane (tiles, so there is no seam at l = 180°)
const domeMat = new THREE.ShaderMaterial({
  uniforms: domeUniforms,
  side: THREE.BackSide,
  transparent: true, // drawn after the opaque scene (hidden pixels are skipped), before the discs and clouds
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    uniform vec3 uSkySunDir;
    uniform vec3 uSkyMoonDir;
    uniform mat3 uCel;
    uniform vec3 uAirglow;
    uniform vec3 uTwilight;
    uniform vec3 uTwilightHigh;
    uniform vec3 uBelt;
    uniform vec3 uMoonHalo;
    uniform float uMilky;
    uniform float uMoonRadius;
    uniform vec3 uMeteorA;
    uniform vec3 uMeteorB;
    uniform vec2 uMeteor;
    varying vec3 vDir;
    float vnoiseP(vec2 p, float per) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash12(mod(i, per)), hash12(mod(i + vec2(1, 0), per)), u.x),
                 mix(hash12(mod(i + vec2(0, 1), per)), hash12(mod(i + vec2(1, 1), per)), u.x), u.y);
    }
    float fbmP(vec2 p, int octaves) {
      float s = 0.0, a = 0.5, per = ${MW_CELLS.toFixed(1)}, n = 0.0;
      for (int i = 0; i < 4; i++) {
        if (i == octaves) break;
        s += a * vnoiseP(p, per); n += a; p *= 2.0; per *= 2.0; a *= 0.5;
      }
      return s / n;
    }
    // Milky Way (colour) in equatorial direction c: a band along the galactic plane, wider and brighter
    // toward the centre, broken into star clouds with ragged edges, split by dark dust lanes (the Great
    // Rift runs from Cygnus to Sagittarius), bluish with a warmer core and faint violet nebula patches.
    vec3 milkyWay(vec3 c) {
      float b = asin(clamp(dot(c, ${vec3(GNP)}), -1.0, 1.0));
      float l = atan(dot(c, ${vec3(GL90)}), dot(c, ${vec3(GC)})); // 0 = galactic centre
      float warm = exp(-l * l / 0.6), width = 0.1 + 0.09 * warm;
      if (abs(b) > 2.6 * width) return vec3(0.0); // the band is ~invisible beyond (saves the noise)
      vec2 p = vec2(l, b) * ${(MW_CELLS / (2 * Math.PI)).toFixed(4)};
      float clouds = fbmP(p * vec2(1.4, 2.2), 4);
      width *= 0.75 + 0.5 * clouds;
      float band = exp(-b * b / (width * width)) * (1.0 - smoothstep(1.9, 2.6, abs(b) / (0.1 + 0.09 * warm))); // fades out before the cut-off
      float lane = (b - 0.025 * sin(l * 3.0 + 1.0)) / (0.03 + 0.03 * warm); // a wavy lane along the plane
      float dust = smoothstep(0.42, 0.7, fbmP(p * vec2(1.5, 5.0) + 17.0, 3)) * exp(-lane * lane); // stretched along the band
      float rift = smoothstep(-0.1, 0.15, l) * (1.0 - smoothstep(1.0, 1.5, l)) * exp(-pow((b - 0.015) / 0.035, 2.0));
      float bulge = exp(-l * l / 0.1 - b * b / 0.02);
      float mw = band * (0.35 + 0.65 * warm) * (0.15 + 1.5 * clouds * clouds) + bulge * 0.6;
      mw *= 1.0 - 0.85 * clamp(max(dust, rift * (0.6 + 0.4 * clouds)), 0.0, 1.0);
      vec3 tint = mix(vec3(0.42, 0.5, 1.0), vec3(1.0, 0.8, 0.62), warm * 0.7);
      return mix(tint, vec3(0.8, 0.5, 1.0), 0.6 * smoothstep(0.55, 0.8, vnoiseP(p * 0.7 + 41.0, ${MW_CELLS.toFixed(1)}))) * mw;
    }
    void main() {
      vec3 d = normalize(vDir);
      float e = max(d.y, 0.0);
      // glows start at the horizon, where the sky equals the fog colour (far terrain blends into it)
      float up = smoothstep(0.0, 0.03, d.y);
      vec3 col = mix(uFogColor, uZenithColor, pow(e, 0.6));
      // night: a lighter band over the horizon (airglow), so the far hills stand out as dark shapes
      col += uAirglow * up * exp(-e / 0.2);
      // twilight: warm glow toward the sun, rose above it; opposite, a pink band over the earth's shadow
      vec2 h = normalize(d.xz + vec2(1e-5)), s = normalize(uSkySunDir.xz + vec2(1e-5));
      float toward = dot(h, s) * 0.5 + 0.5;
      col += up * uTwilight * pow(toward, 4.0) * exp(-e / (0.04 + 0.12 * toward));
      col += up * uTwilightHigh * toward * toward * exp(-e / 0.35);
      col += uBelt * (1.0 - toward) * (1.0 - toward) * smoothstep(0.03, 0.12, e) * exp(-e / 0.22);
      // moonlit sky around the moon
      float toMoon = max(dot(d, uSkyMoonDir), 0.0), moonD = distance(d, uSkyMoonDir);
      col += up * uMoonHalo * (pow(toMoon, 400.0) * 0.5 + pow(toMoon, 40.0) * 0.2 + pow(toMoon, 6.0) * 0.06);
      if (uMilky > 0.001) {
        col += milkyWay(uCel * d) * uMilky * smoothstep(0.03, 0.4, e) * smoothstep(uMoonRadius, uMoonRadius * 1.15, moonD);
      }
      // shooting star along the great circle A -> B, far up in the air: a small bright head and a short fading trail
      // of steady width (~1 px at any resolution: a far thing, not a streak close by)
      float px = length(fwidth(d));
      if (uMeteor.y > 0.0) {
        vec3 n = normalize(cross(uMeteorA, uMeteorB)), t = cross(n, uMeteorA);
        float len = acos(clamp(dot(uMeteorA, uMeteorB), -1.0, 1.0));
        float along = atan(dot(d, t), dot(d, uMeteorA)) / len; // 0 at A, 1 at B
        float tail = (uMeteor.x - along) / 0.6; // 0 at the head .. 1 at the end of the trail
        float trail = step(0.0, tail) * step(0.0, along) * pow(max(1.0 - tail, 0.0), 2.0) * exp(-pow(dot(d, n) / (px * 0.7), 2.0));
        vec3 head = uMeteorA * cos(uMeteor.x * len) + t * sin(uMeteor.x * len);
        trail = trail * 0.6 + 1.5 * exp(-pow(distance(d, head) / (px * 0.9), 2.0));
        col += vec3(0.85, 0.94, 1.0) * uMeteor.y * trail * up;
      }
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
      gl_FragColor.rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0; // dither: the dark gradient bands in 8 bit
    }`,
});
const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 32), domeMat);
dome.renderOrder = -2; // first of the transparent pass: before the stars, flowers, discs (1) and cloud dome (2)
dome.frustumCulled = false;

// ---------- stars ----------
// Seeded field: a few bright stars, many faint ones (log brightness distribution), plus a crowd of faint
// stars along the Milky Way. Positions are equatorial; the points turn with starFrame (sidereal time).
// shortcut: random stars, not a catalogue (no real constellations; the Milky Way is in its real place); load a
// bright-star list (to mag ~5) instead of the FIELD loop if constellations matter.
const FIELD = 9000, BAND = 7000;
const TWINKLE_PERIOD = 600; // s; twinkle rates are whole cycles per period, so wrapping the clock is seamless
const starGeo = new THREE.BufferGeometry();
{
  const rand = mulberry32(4242), n = FIELD + BAND;
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const pos = new Float32Array(n * 3), info = new Float32Array(n * 4), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let mag;
    if (i < FIELD) {
      const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z);
      v.set(s * Math.cos(a), s * Math.sin(a), z);
      mag = 6.5 + 2 * Math.log10(1 - rand()); // few bright, many faint
    } else {
      const l = rand() < 0.6 ? gauss() * 0.9 : (rand() * 2 - 1) * Math.PI; // crowded toward the centre
      const b = gauss() * (0.05 + 0.07 * Math.exp((-l * l) / 0.6));
      v.copy(GC).multiplyScalar(Math.cos(l) * Math.cos(b)).addScaledVector(GL90, Math.sin(l) * Math.cos(b)).addScaledVector(GNP, Math.sin(b));
      mag = 6.8 + 2 * Math.log10(1 - rand());
    }
    v.multiplyScalar(R - 5).toArray(pos, i * 3);
    // brightness (display value; > 1 grows a glow and spikes), colour 0 blue .. 0.5 white .. 1 orange,
    // twinkle rate (cycles per period), phase
    info.set([1.6 * Math.exp(-0.36 * Math.max(mag, -1)), THREE.MathUtils.clamp(0.5 + 0.2 * gauss(), 0, 1), 150 + Math.floor(550 * rand()), rand() * 6.283], i * 4);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aStar', new THREE.BufferAttribute(info, 4));
}
const starMat = new THREE.ShaderMaterial({
  uniforms: {
    uLimit: { value: 9 }, uGain: { value: 0 }, uMoonWash: { value: 0 }, uTwinkle: { value: 0 }, uPixelRatio: { value: 1 },
    uMoonDir: { value: moonDir }, uMoonRadius: { value: moon.radius },
  },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    uniform float uLimit;
    uniform float uGain;
    uniform float uMoonWash;
    uniform float uTwinkle;
    uniform float uPixelRatio;
    uniform vec3 uMoonDir;
    uniform float uMoonRadius;
    attribute vec4 aStar;
    varying vec3 vColor;
    varying float vSize;
    varying float vSigma;
    varying float vSpike;
    void main() {
      vec3 dir = normalize(mat3(modelMatrix) * position);
      float e = dir.y, moonD = distance(dir, uMoonDir);
      // twinkle, much stronger low in the sky (more air); extinction toward the horizon
      float tw = 0.15 + 0.5 * (1.0 - smoothstep(0.05, 0.45, e));
      float v = aStar.x * uGain * smoothstep(-0.02, 0.3, e);
      v *= 1.0 - tw * (0.5 + 0.5 * sin(aStar.z * uTwinkle + aStar.w)) * (0.5 + 0.5 * sin(floor(aStar.z * 0.63) * uTwinkle + aStar.w * 3.0));
      // a brighter sky (twilight, moonlight; most near the moon) hides the faint stars first
      float lim = uLimit + uMoonWash * exp(-moonD * 4.0);
      v *= smoothstep(lim, lim + 0.2, v);
      if (v < 0.01 || moonD < uMoonRadius * 1.1) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); gl_PointSize = 0.0; return; } // behind the moon
      float c = aStar.y * 2.0;
      vColor = (c < 1.0 ? mix(vec3(0.7, 0.82, 1.0), vec3(1.0, 0.98, 0.94), c) : mix(vec3(1.0, 0.98, 0.94), vec3(1.0, 0.72, 0.5), c - 1.0))
        * mix(vec3(1.0, 0.78, 0.6), vec3(1.0), smoothstep(0.0, 0.25, e)) * v; // redder low down
      vSigma = 0.8 + 0.5 * smoothstep(0.2, 1.4, v); // px; never sharper, or faint stars flicker as they drift across pixels
      vSpike = smoothstep(0.6, 1.3, v);
      vSize = max(vSigma * 7.0, vSpike * 22.0) * uPixelRatio;
      gl_PointSize = vSize;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uPixelRatio;
    varying vec3 vColor;
    varying float vSize;
    varying float vSigma;
    varying float vSpike;
    void main() {
      vec2 p = (gl_PointCoord - 0.5) * vSize / uPixelRatio; // CSS px from the centre
      float r2 = dot(p, p);
      float core = exp(-r2 / (2.0 * vSigma * vSigma));
      float glow = exp(-sqrt(r2) / (vSigma * 2.0)) * (0.1 + 0.25 * vSpike);
      // bright stars: a small four-point sparkle
      float spike = (exp(-abs(p.y) * 1.5 - abs(p.x) * 0.28) + exp(-abs(p.x) * 1.5 - abs(p.y) * 0.28)) * vSpike;
      vec3 col = vColor * (core + glow + spike);
      gl_FragColor = vec4(min(col, vec3(1.0)), 1.0); // display values, added (stars only ever brighten the sky)
    }`,
});
const stars = new THREE.Points(starGeo, starMat);
stars.matrixAutoUpdate = false;
stars.frustumCulled = false;
stars.renderOrder = -1;
stars.onBeforeRender = (renderer) => { starMat.uniforms.uPixelRatio.value = renderer.getPixelRatio(); };

export const skyLayer = new THREE.Group().add(dome, stars);

// ---------- shooting stars ----------
// Far up (~100 km): a short thin trail behind a small head, under a second; fainter and shorter low down (more air).
// At most 5 a night: picked from the night's date (local noon to noon), one in each fifth of 19:30 .. 05:00, so there
// are never more however long someone watches (by day, dusk or dawn they are faded out by darkness). Fixed draw
// order: reordering the rand() calls changes every meteor.
// ?meteor (dev): one every 2 s in the clock view; ?meteor=0.5 holds it halfway along its path, for screenshots.
const NIGHT_METEORS = 5, NIGHT_FROM = 7.5, NIGHT_HOURS = 9.5; // h after local noon: 19:30 .. 05:00
function meteorFrom(rand) {
  // half cross the clock's view (west, in front of the camera), the rest anywhere above ~15°
  const front = rand() < 0.5;
  const az = front ? (rand() - 0.5) * 1.1 : rand() * Math.PI * 2, el = front ? 0.22 + 0.3 * rand() : 0.25 + 0.9 * rand();
  const a = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const side = new THREE.Vector3(0, 1, 0).cross(a).normalize(), up = a.clone().cross(side);
  const high = smoothstep(el, 0.2, 0.9); // 0 low .. 1 high: more air to see through low down
  const dir = Math.PI * 1.5 + (rand() - 0.5) * 2.2, len = (0.035 + 0.04 * rand()) * (0.5 + 0.5 * high); // 1-4.3°; mostly falling
  const travel = side.multiplyScalar(Math.cos(dir)).addScaledVector(up, Math.sin(dir));
  const b = a.clone().multiplyScalar(Math.cos(len)).addScaledVector(travel, Math.sin(len));
  return { start: 0, life: 0.35 + 0.6 * rand(), a, b, bright: (0.8 + 0.6 * rand()) * (0.35 + 0.65 * high) };
}
function nightOf(t) { // the night around scene time t (s): its span and its meteors
  const d = new Date(t * 1000);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  const from = d.getTime() / 1000, rand = mulberry32(d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate()), list = [];
  for (let i = 0; i < NIGHT_METEORS; i++) {
    const m = meteorFrom(rand);
    m.start = from + (NIGHT_FROM + (NIGHT_HOURS * (i + 0.1 + 0.8 * rand())) / NIGHT_METEORS) * 3600;
    list.push(m);
  }
  d.setDate(d.getDate() + 1);
  return { from, to: d.getTime() / 1000, list };
}
let night = { from: Infinity, to: -Infinity, list: [] };
const forced = new URLSearchParams(location.search).get('meteor');
const FORCED = forced === null ? null : Object.assign(meteorFrom(() => 0.3), { life: 0.8 }); // a fixed one in the clock view

const AIRGLOW = new THREE.Color('#2b3f7a'); // night glow over the horizon
const TWILIGHT = new THREE.Color('#ff9a5c'); // low, toward the sun
const TWILIGHT_HIGH = new THREE.Color('#9a5f96'); // rose-violet, higher above the sun
const BELT = new THREE.Color('#a8708e'); // belt of Venus, opposite the sun
const MOON_HALO = new THREE.Color('#5d6f9c');

// t = scene time (s), hours = time of day, camera. Runs right after setTime.
export function updateSky(t, hours, camera) {
  setSceneClock(t);
  skyLayer.position.copy(camera.position);
  stars.matrix.copy(starFrame);
  stars.matrixWorldNeedsUpdate = true;
  domeUniforms.uCel.value.setFromMatrix4(starFrame).transpose();

  const dark = smoothstep(-sunDir.y, 0.02, 0.25); // 0 by day .. 1 when twilight is over (~70 min after sunset)
  const moonSky = moon.lit ** 1.5 * smoothstep(moonDir.y, -0.05, 0.3); // how much the moon lights the sky
  const clear = (1 - smoothstep(weather.layer, 0.4, 0.85)) * (1 - 0.6 * weather.haze); // a sheet hides the stars
  const twilight = smoothstep(-sunDir.y, -0.02, 0.06) * smoothstep(sunDir.y, -0.4, -0.06); // after sunset (the keyframes own the sunset itself)
  const open = 1 - 0.8 * weather.dim;
  const u = domeUniforms;
  u.uAirglow.value.copy(AIRGLOW).multiplyScalar(dark * open * (1 + 0.8 * moonSky)); // moonlit air glows more: the hills read as dark shapes against it
  u.uTwilight.value.copy(TWILIGHT).multiplyScalar(twilight * open);
  u.uTwilightHigh.value.copy(TWILIGHT_HIGH).multiplyScalar(twilight * open * 0.5);
  u.uBelt.value.copy(BELT).multiplyScalar(twilight * (1 - smoothstep(-sunDir.y, 0.05, 0.15)) * open * 0.4);
  u.uMoonHalo.value.copy(MOON_HALO).multiplyScalar(moonSky * (0.3 + 0.7 * dark) * open);
  u.uMilky.value = 0.55 * smoothstep(-sunDir.y, 0.15, 0.32) * (1 - 0.5 * moonSky) * clear; // only once it is really dark; stylised: a full moon fades it, doesn't erase it

  const s = starMat.uniforms;
  s.uLimit.value = (1 - dark) * 2.5 + 0.04 * moonSky; // bright stars come out first in the twilight; none by day (brightest 2.3)
  s.uMoonWash.value = 0.25 * moonSky;
  s.uGain.value = clear;
  s.uTwinkle.value = ((((t % TWINKLE_PERIOD) + TWINKLE_PERIOD) % TWINKLE_PERIOD) / TWINKLE_PERIOD) * 2 * Math.PI;

  if (t < night.from || t >= night.to) night = nightOf(t);
  let m = null, p = 2;
  if (FORCED) { m = FORCED; p = forced ? Number(forced) : (t % 2) / m.life; }
  else for (const c of night.list) if (t >= c.start && t <= c.start + c.life) { m = c; p = (t - c.start) / c.life; }
  if (p <= 1) {
    u.uMeteorA.value.copy(m.a);
    u.uMeteorB.value.copy(m.b);
    u.uMeteor.value.set(p, m.bright * smoothstep(p, 0, 0.1) * (1 - smoothstep(p, 0.7, 1)) * dark * clear * (1 - 0.5 * moonSky));
  } else u.uMeteor.value.set(0, 0);
}
