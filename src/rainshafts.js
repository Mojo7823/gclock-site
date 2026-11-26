import * as THREE from 'three';
import { uniforms, glslCommon, mulberry32, MOUNTAIN, DECK_BASE } from './common.js';
import { weather } from './weather.js';
import { liveClouds } from './clouds.js';

// Distant rain shafts (docs/WEATHER.md → Rain shafts): grey curtains of rain over the valley in front of the far ranges,
// seen against the mountain slopes. Two kinds, one look:
// - under a rain cloud: towers (cb) mostly rain; the lumpy layer (sc) more often the wetter the weather (a shower now and
//   then on a cloudy day, most of them in rain);
// - under the deck (deckShowers): in rain the sheet covers the sky, so curtains also hang from it (from its base,
//   common.js DECK_BASE) at hashed places, fading in and out over 3 min of their 15-25.
// Only 170-440 m out: nearer, the local rain (rain.js) is the rain; behind the far ridge (~380 m, 11-12° up) a cloud base
// sits below its line, so every shaft there is hidden. One camera-facing quad per shaft (turning about the vertical only),
// from the base down under the land (the land's depth hides the rest), its foot blown downwind; drawn before the clouds
// (3), so a cloud's base covers the top.
const MAX = 24;
const NEAR = [170, 230], FAR = [360, 440]; // m from the clock spot
const VIEW = { x: 0, z: 11 };
const HEADING = Math.atan2(MOUNTAIN.x - VIEW.x, VIEW.z - MOUNTAIN.z); // the summit's bearing, near the clock view's middle
const DECK = { slot: 90, life: [900, 1500] }; // a deck shower candidate every 90 s of scene time, each 15-25 min
// ?rainshafts=<gain> (dev): 0 = off, >1 exaggerates them (A/B shots)
const GAIN = Number(new URLSearchParams(globalThis.location?.search ?? '').get('rainshafts') ?? 1) || 0;
const { smoothstep } = THREE.MathUtils;

// How much cloud c rains as a shaft (0..1), for the weather w: towers (cb) 80-100% of them by the weather's darkness,
// the lumpy layer (sc) up to 95% by rain, darkness and the sheet (cloudy ~11%, overcast ~32%, light rain ~67%, rain 95%);
// each cloud's own rank (from its seed) fades it in or out as the weather moves past it, so none pops.
// Pure, like deckShowers: tools/rainshafts-test.mjs.
export function shaftAmount(c, w = weather) {
  const share = c.name === 'cb' ? 0.8 + 0.2 * w.dark : c.name === 'sc' ? Math.min(0.95, 0.5 * w.dark + 0.9 * w.rain + 0.15 * w.layer) : 0;
  if (share <= 0) return 0;
  const rank = (c.seed % 1000) / 1000, d = Math.hypot(c.x - VIEW.x, c.z - VIEW.z);
  return smoothstep(share, rank - 0.05, rank + 0.05) * smoothstep(c.growth, 0.4, 0.8) * smoothstep(d, NEAR[0], NEAR[1]) * (1 - smoothstep(d, FAR[0], FAR[1]));
}

// Curtains from the deck at scene time t (s): a share of the candidates by the sheet x rain (overcast ~5%, light rain
// ~26%, rain ~55%, storm ~51%), within ±75° of the clock view, 190-350 m out, 50-110 m wide.
export function deckShowers(t, w = weather) {
  const share = w.layer * Math.min(0.6, 0.15 * w.dark + 0.6 * w.rain), out = [];
  if (share < 0.01) return out;
  for (let k = Math.floor((t - DECK.life[1]) / DECK.slot), k1 = Math.floor(t / DECK.slot); k <= k1; k++) {
    const r = mulberry32(k * 7919 + 4243), rank = r(), birth = (k + r()) * DECK.slot, life = DECK.life[0] + (DECK.life[1] - DECK.life[0]) * r();
    const a = HEADING + (r() - 0.5) * 2.6, d = 190 + 160 * r(), y = DECK_BASE + 2 + 10 * r(), width = 50 + 60 * r(), age = t - birth;
    if (age < 0 || age > life) continue;
    const amount = smoothstep(share, rank - 0.05, rank + 0.05) * smoothstep(age, 0, 180) * (1 - smoothstep(age, life - 180, life));
    if (amount > 0.01) out.push({ x: VIEW.x + Math.sin(a) * d, y, z: VIEW.z - Math.cos(a) * d, width, amount, seed: k });
  }
  return out;
}

const quad = new THREE.PlaneGeometry(1, 1);
const geo = new THREE.InstancedBufferGeometry();
geo.setIndex(quad.index);
geo.setAttribute('position', quad.getAttribute('position'));
const aTop = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage); // base centre xyz, width
const aShaft = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage); // foot offset x, z, opacity, seed
geo.setAttribute('aTop', aTop);
geo.setAttribute('aShaft', aShaft);
geo.instanceCount = 0;

const local = { uFall: { value: 0 }, uDrift: { value: 0 } };
const mat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, ...local },
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    attribute vec4 aTop;
    attribute vec4 aShaft;
    varying vec2 vM; // across (m from the middle), down (m below the cloud base)
    varying vec3 vWorldPos;
    varying vec3 vShaft; // half width, height, opacity
    varying float vSeed;
    void main() {
      float t = 0.5 - position.y; // 0 at the cloud base .. 1 at the foot
      float H = aTop.y + 20.0; // down to 20 m below sea level: the land hides the foot
      vec3 base = aTop.xyz + vec3(aShaft.xy * t, 0.0).xzy;
      base.y -= H * t;
      vec3 side = normalize(vec3(cameraPosition.z - base.z, 0.0, base.x - cameraPosition.x) + 1e-4); // across the view
      float hw = 0.5 * aTop.w * (1.0 + 0.25 * t); // half width, spreading a little as it falls
      vec3 p = base + side * position.x * 2.0 * hw;
      vM = vec2(position.x * 2.0 * hw, H * t);
      vShaft = vec3(hw, H, aShaft.z);
      vSeed = aShaft.w;
      vWorldPos = p;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    uniform float uFall;
    uniform float uDrift;
    uniform vec3 uSkySunColor;
    uniform vec3 uSkyMoonColor;
    uniform vec4 uFlashLight; // lightning.js: x = the sky-wide glow
    varying vec2 vM;
    varying vec3 vWorldPos;
    varying vec3 vShaft;
    varying float vSeed;
    void main() {
      float x = vM.x / vShaft.x; // -1..1 across
      // ragged sides: the edge wanders down the shaft and slowly in time
      float edge = 0.75 + 0.25 * vnoise(vec2(vM.y * 0.02 + vSeed, uDrift + x * 0.5));
      float across = 1.0 - smoothstep(0.6 * edge, edge, abs(x));
      // denser and thinner bands that drift, and fine falling streaks
      float bands = 0.3 + 0.7 * smoothstep(0.2, 0.8, vnoise(vec2(vM.x * 0.05 + vSeed * 7.0, uDrift)));
      float streaks = 0.6 + 0.4 * vnoise(vec2(vM.x * 0.6, (vM.y - uFall) * 0.012));
      float top = smoothstep(0.0, 0.15 * vShaft.y, vM.y); // out of the cloud base
      float a = vShaft.z * across * bands * streaks * top;
      if (a < 0.003) discard;
      // the haze's grey, a little darker (rain is thick haze: over a slope it veils the rock, against the sky it is a
      // step darker); a touch of sun or moon on it; lit by lightning. (A darker grey matched the hazed slopes: unseen there.)
      vec3 rd = normalize(vWorldPos - cameraPosition);
      vec3 sky = mix(uFogColor, uZenithColor, pow(max(rd.y, 0.0), 0.6));
      vec3 col = mix(sky, vec3(dot(sky, vec3(0.3, 0.59, 0.11))), 0.6) * mix(0.95, 0.8, uDeck.y) + (uSkySunColor + uSkyMoonColor) * 0.05;
      col += vec3(0.55, 0.6, 0.75) * uFlashLight.x * 0.35;
      // far ones melt into the haze, like the clouds
      col = mix(col, uFogColor, smoothstep(250.0, 500.0, distance(vWorldPos, cameraPosition)) * 0.2);
      gl_FragColor = vec4(linearToOutputTexel(vec4(col, 1.0)).rgb * a, a); // premultiplied, as the clouds
    }`,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
});
const mesh = new THREE.Mesh(geo, mat);
mesh.frustumCulled = false; // placed per instance
mesh.renderOrder = 2.6; // after the far clock (2.5: a shaft in front of it covers it), before the clouds (3)
export const rainShaftLayer = new THREE.Group().add(mesh);

const picked = [];
// After updateClouds. sceneSeconds = the scene clock (s).
export function updateRainShafts(sceneSeconds, camera) {
  picked.length = 0;
  const cam = camera.position, add = (x, y, z, width, amount, seed) => picked.push({ x, y, z, width, amount, seed, d: (x - cam.x) ** 2 + (z - cam.z) ** 2 });
  if (GAIN > 0) {
    for (const c of liveClouds()) {
      const amount = shaftAmount(c);
      if (amount > 0.01) add(c.x, c.y, c.z, c.W * (c.name === 'cb' ? 0.55 : 0.4), amount * (c.name === 'cb' ? 1.25 : 1), c.seed % 997);
    }
    for (const s of deckShowers(sceneSeconds)) add(s.x, s.y, s.z, s.width, s.amount, s.seed % 997);
  }
  picked.sort((a, b) => b.d - a.d); // far to near: they blend over each other
  if (picked.length > MAX) picked.splice(0, picked.length - MAX); // shortcut: drops the farthest when over 24; fine so far
  // the foot blown downwind: rain falls ~7 m/s, so it drifts wind/7 of its fall (at most one fall), seen from the base
  const w = uniforms.uWindDir.value, slant = Math.min(1, uniforms.uWindStrength.value / 7) * 0.6;
  const opacity = (0.55 + 0.35 * weather.dark) * GAIN;
  const top = aTop.array, s = aShaft.array;
  picked.forEach((p, i) => {
    const fall = p.y + 20, j = i * 4;
    top[j] = p.x; top[j + 1] = p.y + 2; top[j + 2] = p.z; top[j + 3] = p.width;
    s[j] = w.x * fall * slant; s[j + 1] = w.y * fall * slant; s[j + 2] = Math.min(0.9, opacity * p.amount); s[j + 3] = p.seed / 97;
  });
  geo.instanceCount = picked.length;
  mesh.visible = picked.length > 0;
  aTop.needsUpdate = aShaft.needsUpdate = true;
  // shortcut: the streaks' fall wraps every ~18 min (the faint streak pattern jumps once); make the noise periodic if it shows
  local.uFall.value = (sceneSeconds * 9) % 1e4; // streaks fall ~9 m/s
  local.uDrift.value = (sceneSeconds * 0.01) % 1e3;
}
