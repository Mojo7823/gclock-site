import * as THREE from 'three';
import { uniforms } from './common.js';
import { weather } from './weather.js';

// Sun path: rises at 06:00 just left of the big peak, climbs nearly straight up its left flank and passes over its
// summit about 08:00 (the sunrise is in the clock view), swings round behind the viewer (60° up at 12:00, behind-left:
// the front-lit scene) and sets in view, 15° left of centre, at 18:00 (behind the hills a little earlier), like a
// high-latitude summer day seen facing the pole. Its height follows the celestial equator below all day (so the
// keyframes, shadows and twilight keep their timing) and from noon to sunset it is on it; the morning and the night
// swing the azimuth round on smooth curves (no kinks at 06:00, 12:00 or 18:00).
// The moon and the stars keep to the celestial frame: the moon on the equator, trailing the sun's clock by its phase
// (full: rises behind-right at sunset, up behind the viewer at midnight; new: with the sun), lit from the real sun.
// shortcut: fixed 06:00/18:00 path, the morning art-directed (the sun leaves the stars' frame) and the moon on the
// equator; upgrade with the real solar/lunar position from lat/long + date (roadmap step 5).
const NOON = new THREE.Vector3(-0.483, 0.866, 0.129), SET = new THREE.Vector3(-0.259, 0, -0.966);
// The sky's frame: the celestial equator through NOON and SET, its pole 30° up in the north (+x).
const POLE = new THREE.Vector3().crossVectors(NOON, SET).negate().normalize();
const EQUATORIAL = new THREE.Matrix4().makeBasis(NOON, SET.clone().negate(), POLE); // RA 0h on the meridian -> world
// the equator at u = (hours - 12) / 6 of its own clock: NOON at 0, SET at 1, below the horizon from 1 to 3
const equator = (u, out) => out.copy(SET).multiplyScalar(Math.sin((Math.PI / 2) * u)).addScaledVector(NOON, Math.cos((Math.PI / 2) * u));
const RISE_AZ = THREE.MathUtils.degToRad(3); // azimuth of the sunrise (+ = right of straight ahead, -z); the summit is at 17°
const azimuth = (v) => Math.atan2(v.x, -v.z);
const hermite = (p0, m0, p1, m1, t) => (2 * t ** 3 - 3 * t ** 2 + 1) * p0 + (t ** 3 - 2 * t ** 2 + t) * m0 + (3 * t ** 2 - 2 * t ** 3) * p1 + (t ** 3 - t ** 2) * m1;
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
const slope = (u) => (azimuth(equator(u + 1e-4, v1)) - azimuth(equator(u - 1e-4, v2))) / 2e-4; // d azimuth / du on the equator
const NOON_AZ = azimuth(NOON) + 2 * Math.PI, SET_AZ = azimuth(SET) + 2 * Math.PI, M_NOON = slope(0), M_SET = slope(1 - 1e-4);
// morning azimuth: RISE_AZ + (NOON_AZ - RISE_AZ) w(t), w = t³(a + bt): it starts still (the sun climbs straight up until
// ~07:30) and meets the equator's turn rate at noon
const K = M_NOON / (NOON_AZ - RISE_AZ), morning = (t) => RISE_AZ + (NOON_AZ - RISE_AZ) * t ** 3 * (4 - K + (K - 3) * t);
// direction toward the sun at u = (hours - 12) / 6 (any value; the path repeats every 4)
function sunPath(u, out) {
  u = ((((u + 1) % 4) + 4) % 4) - 1; // -1 (06:00) .. 3 (06:00 next day)
  if (u >= 0 && u <= 1) return equator(u, out);
  const a = u < 0 ? morning(u + 1) : hermite(SET_AZ, 2 * M_SET, RISE_AZ + 2 * Math.PI, 0, (u - 1) / 2); // (at night it may overshoot a little, far below the horizon)
  const y = NOON.y * Math.cos((Math.PI / 2) * u), r = Math.sqrt(1 - y * y);
  return out.set(r * Math.sin(a), y, -r * Math.cos(a));
}

const SYNODIC = 29.530588 * 86400, NEW_MOON = Date.UTC(2000, 0, 6, 18, 14) / 1000; // a reference new moon
const YEAR = 31556925, EQUINOX = Date.UTC(2000, 2, 20, 7, 35) / 1000; // tropical year, a March equinox

// The look of the day by hour: light = sun/moon colour (night: a full moon), shade = ambient/shadow
// multiplier, sky = horizon + fog, zenith = sky overhead, wind = factor on the weather's wind speed (not on the Wind slider's), shadow = shadow strength,
// mist = ground-mist density, mistH = how high it reaches (m): it pools at dawn, rises and thins by
// 10:00, forms again at dusk. Shadow is 0 at 06:00 and 18:00, the moment the light swaps between sun
// and moon. Warm hours keep plenty of green in the light so grass stays green (hue >= ~65°); the
// warmth lives in sky and shade. By day the zenith is only a shade deeper than the horizon.
const KEYS = [
  [0, '#7385b5', '#2f3a5c', '#1d2848', '#0a1236', 0.5, 0.45, 0.35, 3.5], // night, moonlight
  [4.6, '#7385b5', '#2f3a5c', '#1d2848', '#0a1236', 0.45, 0.45, 0.45, 3],
  [5.5, '#a39cb4', '#4c4c7c', '#6c6c9e', '#283066', 0.35, 0, 0.7, 3], // dawn twilight
  [6, '#ffc89a', '#7f7cab', '#f1b9a2', '#c9aac4', 0.35, 0, 0.75, 3.5], // sunrise
  [7, '#ffd8b0', '#8a95c4', '#c8d6ec', '#bcd0ec', 0.5, 0.75, 0.6, 5], // early morning: mist starts lifting
  [8.5, '#fff1d6', '#90a5cc', '#a5d0f0', '#97c6ee', 0.7, 1, 0.3, 10], // morning
  [10, '#fff4dd', '#92a7ce', '#a8d3f2', '#99c8f0', 0.8, 1, 0, 18], // mist burnt off
  [12, '#fff6e3', '#93a8cf', '#a9d4f2', '#9ac9f0', 0.9, 1, 0, 18], // noon (the step-1 look)
  [16, '#ffe9c4', '#93a3cc', '#a3cdee', '#95c2ec', 1.15, 1, 0, 6], // afternoon, breeziest
  [16.8, '#ffdcaa', '#9199c4', '#dde9f0', '#c6dbef', 1.1, 0.95, 0, 4], // bright haze between blue and gold (a direct blend went grey)
  [17.3, '#ffc677', '#8f88b4', '#efc08e', '#e8bc91', 1, 0.85, 0, 3], // golden hour
  [18, '#ffb98a', '#6a7298', '#e8907a', '#d08a88', 0.8, 0, 0.08, 2], // sunset: condensation starts on the meadow
  [18.8, '#71809e', '#3c4672', '#4a4d7e', '#232858', 0.6, 0, 0.45, 3.5], // dusk: mist rises off the meadow
  [20, '#7385b5', '#2f3a5c', '#1d2848', '#0a1236', 0.5, 0.45, 0.45, 4], // night
  [24, '#7385b5', '#2f3a5c', '#1d2848', '#0a1236', 0.5, 0.45, 0.35, 3.5],
].map(([h, light, shade, sky, zenith, wind, shadow, mist, mistH]) => ({
  h, light: new THREE.Color(light), shade: new THREE.Color(shade), sky: new THREE.Color(sky), zenith: new THREE.Color(zenith), wind, shadow, mist, mistH,
}));

// Sun and moon discs: camera-facing quads with a crisp toon disc and a soft additive glow.
// uCover (0..1) fades them behind heavy cloud, where the sky dome draws only a faint brighter patch.
// The moon (PHASE) is a lit sphere: the side facing the sun is bright, the rest shows a faint earthshine.
const DISC = 0.31; // disc radius in quad units (half the quad = 1)
function body(color, size, phase = false, light = sunDir) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uCover: { value: 0 },
      uLightDir: { value: light }, uEarthshine: { value: 0 }, uGlow: { value: 1 },
    },
    defines: phase ? { PHASE: 1 } : {},
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCenter;
      void main() {
        vUv = position.xy * 2.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vCenter = mv.xyz;
        mv.xy += position.xy * ${size.toFixed(1)};
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uCover;
      uniform vec3 uLightDir;
      uniform float uEarthshine;
      uniform float uGlow;
      varying vec2 vUv;
      varying vec3 vCenter;
      void main() {
        float r = length(vUv);
        float disc = (1.0 - smoothstep(${(DISC - 0.01).toFixed(2)}, ${(DISC + 0.01).toFixed(2)}, r)) * (1.0 - 0.97 * uCover);
        float glow = pow(max(0.0, 1.0 - r), 3.0) * 0.6 * (1.0 - 0.85 * uCover);
        #ifdef PHASE
          // sphere normal in a frame facing the camera (view space), lit by the sun: the phase
          vec3 z = -normalize(vCenter), x = normalize(cross(vec3(0.0, 1.0, 0.0), z)), y = cross(z, x);
          vec2 q = vUv / ${DISC.toFixed(2)};
          vec3 n = mat3(x, y, z) * vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
          float lit = smoothstep(-0.05, 0.05, dot(n, normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz)));
          // a few soft grey seas (stylised maria)
          float maria = 1.0 - smoothstep(0.25, 0.45, length(q - vec2(-0.28, 0.22))) + 1.0 - smoothstep(0.12, 0.3, length(q - vec2(0.22, 0.38)))
            + (1.0 - smoothstep(0.14, 0.32, length(q - vec2(0.12, -0.22)))) * 0.8 + (1.0 - smoothstep(0.06, 0.2, length(q - vec2(-0.1, -0.5)))) * 0.6;
          disc *= mix(uEarthshine, 1.0 - 0.2 * min(maria, 1.0), lit);
          glow *= uGlow * smoothstep(${(DISC - 0.01).toFixed(2)}, ${(DISC + 0.01).toFixed(2)}, r); // the halo stays off the disc: the dark side stays dark
        #endif
        gl_FragColor = vec4(uColor * (disc + glow), 1.0);
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false, // hills in front still hide them (depth test stays on)
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // before the clouds, so clouds pass in front (thin ones let it shine through)
  return mesh;
}

const SKY_DISTANCE = 440; // beyond the far end of the terrain (~360 m) and inside the sky dome (450 m) and the far plane
const MOON_SIZE = 79;
export const sunDir = new THREE.Vector3();
export const moonDir = new THREE.Vector3();
const moonLight = new THREE.Vector3(); // lights the moon disc (setTime)
// phase: 0 new, 0.5 full; lit: illuminated fraction; radius: angular radius of the disc (rad), for sky.js
export const moon = { phase: 0, lit: 1, radius: (DISC * MOON_SIZE) / 2 / SKY_DISTANCE };
// Rotates the star field from equatorial coordinates (x = RA 0h, z = north celestial pole) into the world.
export const starFrame = new THREE.Matrix4();

const sun = body('#fff4d6', 108);
const moonDisc = body('#dfe6ff', MOON_SIZE, true, moonLight);

// Keep this group on the camera (main.js) so the discs behave as if infinitely far away.
export const skyBodies = new THREE.Group().add(sun, moonDisc);

// main.js passes only the hour to setTime; sky.js hands over the scene clock (s) for the date (moon
// phase, the stars' season). setTime uses it from the next frame on: one frame late, invisible.
let clock = Date.now() / 1000;
export function setSceneClock(t) { clock = t; }

const AFTERGLOW = new THREE.Color('#ff8a7a'); // clouds stay pink for a while after the ground goes dark
const MOONLIGHT = new THREE.Color('#9fb0d8');
const MOON_DISC = new THREE.Color('#dfe6ff'), MOON_LOW = new THREE.Color('#ffd2a0'); // a rising moon is warm
const tmp = new THREE.Color();
const { smoothstep } = THREE.MathUtils;

// cloud cover: sky greyed and darkened by up to 60% x dark
function grey(c) {
  const g = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  c.lerp(tmp.setRGB(g, g, g * 1.08).multiplyScalar(1 - 0.6 * weather.dark), 0.8 * weather.dim);
}

// hours: local time of day, 0..24 (fractions allowed).
export function setTime(hours) {
  hours = ((hours % 24) + 24) % 24;
  moon.phase = ((((clock - NEW_MOON) / SYNODIC) % 1) + 1) % 1;
  moon.lit = (1 - Math.cos(moon.phase * 2 * Math.PI)) / 2;
  const u = (hours - 12) / 6;
  sunPath(u, sunDir);
  equator(u - 4 * moon.phase, moonDir);
  // the moon disc's light: its phase's angle from the moon, on the side toward the sun (the sun may be off the equator)
  const e = Math.PI - Math.abs(Math.PI - moon.phase * 2 * Math.PI);
  v1.copy(sunDir).addScaledVector(moonDir, -sunDir.dot(moonDir));
  if (v1.lengthSq() < 1e-8) v1.set(0, 1, 0).addScaledVector(moonDir, -moonDir.y);
  moonLight.copy(moonDir).multiplyScalar(Math.cos(e)).addScaledVector(v1.normalize(), Math.sin(e));
  // local sidereal time: the sun's hour angle + its right ascension (one turn a year from the March equinox)
  const lst = ((hours - 12) / 12) * Math.PI + ((((clock - EQUINOX) / YEAR) % 1) + 1) % 1 * 2 * Math.PI;
  starFrame.makeRotationZ(-lst).premultiply(EQUATORIAL);

  const day = sunDir.y >= 0;
  uniforms.uSunDir.value.copy(day ? sunDir : moonDir);
  sun.position.copy(sunDir).multiplyScalar(SKY_DISTANCE);
  moonDisc.position.copy(moonDir).multiplyScalar(SKY_DISTANCE);
  // moonlight follows the phase (a half moon gives ~1/3 of a full moon's light) and needs the moon up;
  // moonSky: how much it brightens the night sky
  const moonPower = moon.lit ** 1.5 * smoothstep(moonDir.y, 0, 0.1);
  const night = smoothstep(-sunDir.y, 0.05, 0.3);
  const moonSky = moon.lit ** 1.5 * smoothstep(moonDir.y, -0.05, 0.3);

  const i = KEYS.findIndex((k) => k.h > hours), k0 = KEYS[i - 1], k1 = KEYS[i];
  const t = (hours - k0.h) / (k1.h - k0.h);
  uniforms.uSunColor.value.lerpColors(k0.light, k1.light, t);
  uniforms.uShadeColor.value.lerpColors(k0.shade, k1.shade, t);
  uniforms.uFogColor.value.lerpColors(k0.sky, k1.sky, t);
  uniforms.uZenithColor.value.lerpColors(k0.zenith, k1.zenith, t);
  uniforms.uWindStrength.value = weather.wind * (1 + (k0.wind + (k1.wind - k0.wind) * t - 1) * weather.byHour);
  uniforms.uShadowStrength.value = (k0.shadow + (k1.shadow - k0.shadow) * t) * (1 - weather.dim) * (day ? 1 : moonPower);
  const light = uniforms.uSunColor.value, shade = uniforms.uShadeColor.value, sky = uniforms.uFogColor.value;
  const zenith = uniforms.uZenithColor.value;
  // the keyframed night is a full moon: without it the sky is darker and the scene is lit by the
  // sky alone (flat, a little lifted so it still reads)
  sky.multiplyScalar(1 - 0.3 * night * (1 - moonSky));
  zenith.multiplyScalar(1 - 0.45 * night * (1 - moonSky));
  shade.multiplyScalar(1 + 0.15 * night * (1 - moonPower));
  if (day) sun.material.uniforms.uColor.value.copy(light); // orange at sunset

  // Light on the clouds, before the ground-only tweaks below: the sun keeps lighting them a little
  // after it has set for the ground (afterglow), the moon lights them at night (by phase, not in
  // daylight). Cloud cover dims both.
  const cover = 1 - 0.85 * weather.dim; // clouds sit under the sheet, so they lose more sun than the ground
  uniforms.uSkySunDir.value.copy(sunDir);
  uniforms.uSkyMoonDir.value.copy(moonDir);
  uniforms.uSkySunColor.value.lerpColors(AFTERGLOW, light, smoothstep(sunDir.y, -0.04, 0.04)).multiplyScalar(smoothstep(sunDir.y, -0.25, 0.02) * cover); // blended: a hard swap jumped at 06:00/18:00
  uniforms.uSkyMoonColor.value.copy(MOONLIGHT).multiplyScalar(smoothstep(moonDir.y, -0.02, 0.15) * 0.7 * cover
    * moon.lit ** 1.5 * (1 - smoothstep(sunDir.y, -0.15, 0.05)));
  // fair/cloudy: the discs stay bright and the clouds in front hide them; overcast and darker: they fade out
  sun.material.uniforms.uCover.value = moonDisc.material.uniforms.uCover.value = smoothstep(weather.dim, 0.3, 0.85);
  // the moon: pale by day, glowing (by phase) and with earthshine at night, warm near the horizon
  const mu = moonDisc.material.uniforms, dark = 1 - smoothstep(sunDir.y, -0.1, 0.1);
  mu.uColor.value.lerpColors(MOON_LOW, MOON_DISC, smoothstep(moonDir.y, 0, 0.25)).multiplyScalar(0.025 * (1 - (sky.r * 0.3 + sky.g * 0.59 + sky.b * 0.11)) + 0.675 * dark); // by day only a little lighter than the sky: the blend is additive and encoded to sRGB first, less on a bright sky
  mu.uGlow.value = moon.lit ** 1.5 * dark;
  mu.uEarthshine.value = 0.008 * dark;

  // Ground mist: glows with the light it is in (pink at dawn); weather adds more.
  // A moonless night has thinner, darker mist (else it reads as a grey haze over the dark meadow).
  const moonless = night * (1 - moonPower);
  uniforms.uMist.value = (k0.mist + (k1.mist - k0.mist) * t + weather.mist) * (1 - 0.4 * moonless);
  uniforms.uMistHeight.value = k0.mistH + (k1.mistH - k0.mistH) * t;
  uniforms.uMistColor.value.copy(sky).lerp(light, 0.4).multiplyScalar(1 - 0.35 * moonless);

  // Near the horizon the light fades into the shade colour, so lit and shaded sides match when the
  // light swaps between sun and moon (any directions) and nothing flips (~25 min each side). At night
  // the same fade follows the moon's height and phase: no moon = no light, so it can rise or set freely.
  light.lerp(shade, 1 - (day ? smoothstep(sunDir.y, 0, 0.1) : smoothstep(-sunDir.y, 0, 0.1) * moonPower));

  // Cloud cover: dimmer, flatter light (shade catches up with the light), greyer sky, closer haze.
  light.multiplyScalar(1 - 0.6 * weather.dim);
  shade.lerp(tmp.copy(light).multiplyScalar(0.8), 0.6 * weather.dim);
  grey(sky);
  grey(zenith);
  // at night distant ground sinks into the dark sooner, so the hills read as silhouettes against the glow above them;
  // a clear day gets a longer, lighter haze (less on the big tree, the mountain keeps its foot)
  const nightFog = night * (1 - weather.haze), clearDay = (1 - night) * (1 - smoothstep(weather.haze, 0, 0.3));
  uniforms.uFogRange.value.set(40 - 25 * weather.haze - 15 * nightFog, 170 - 90 * weather.haze - 60 * nightFog + 50 * clearDay);
  // far haze (applyFog): it stops thickening fast early on a clear day, late in rain and at night (far land sinks
  // away); its layer is deep under cover, so the mountain fades mostly into the grey with a faint top left, and
  // shallow at night, so the moonlit range rises out of the valley fog
  const turn = 0.08 + 0.7 * weather.haze, depth = 28 + 32 * (1 - smoothstep(weather.haze, 0, 0.3));
  uniforms.uHaze.value.set(turn + (0.8 - turn) * nightFog ** 2, depth * (6 / depth) ** nightFog);
}
