import * as THREE from 'three';
import { mulberry32, heightAt, uniforms } from './common.js';
import { weather } from './weather.js';

// Rain: thin streaks in boxes that wrap around the camera, splashes on the meadow, wet ground (uWet).
export const rainLayer = new THREE.Group();

const DROPS = 24000;
const SPLASHES = 500;
const rand = mulberry32(91);

// rain colour: the sky colour lifted toward the light, a little blue; a lightning flash lights it up
const rainColor = /* glsl */ `
  uniform vec3 uFogColor;
  uniform vec3 uSunColor;
  // uFogColor/uSunColor already carry lightning flashes (scaled by distance in lightning.js)
  vec3 rainColor() { return mix(uFogColor, uSunColor, 0.4) * vec3(0.92, 0.97, 1.08) * 1.3; }
`;

// ---------- streaks ----------
// Each drop wraps in its own box around the camera (pushed forward so few are wasted behind it).
// Box sizes range from 12 to 70 m: dense close up, sparser far away, still reading as rain in front of the trees.
const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0); // y 0 = head (bottom) .. 1 = tail
const geo = new THREE.InstancedBufferGeometry();
geo.setIndex(quad.index);
geo.setAttribute('position', quad.getAttribute('position'));
const seeds = new Float32Array(DROPS * 4), boxes = new Float32Array(DROPS * 2);
for (let i = 0; i < DROPS; i++) {
  seeds.set([rand(), rand(), rand(), rand()], i * 4);
  boxes.set([12 + 58 * rand() ** 1.5, rand()], i * 2);
}
geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
geo.setAttribute('aBox', new THREE.InstancedBufferAttribute(boxes, 2));
geo.instanceCount = DROPS;

const dropMat = new THREE.ShaderMaterial({
  uniforms: {
    ...uniforms,
    uRain: { value: 0 },
    uRainOffset: { value: new THREE.Vector3() }, // fall + wind drift so far (m), integrated on the CPU
    uRainVel: { value: new THREE.Vector3(0, -8, 0) },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uPixel: { value: 0.001 }, // world size of one screen pixel at 1 m
  },
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    uniform float uRain;
    uniform vec3 uRainOffset;
    uniform vec3 uRainVel;
    uniform vec3 uCamFwd;
    uniform float uPixel;
    attribute vec4 aSeed; // xyz position in the unit box, w speed variation
    attribute vec2 aBox;  // box size (m), rank: drawn while rank < uRain, so intensity thins drops evenly
    varying vec2 vUv;
    varying float vAlpha;
    void main() {
      float show = clamp((uRain - aBox.y) * 20.0, 0.0, 1.0);
      if (show <= 0.0) { gl_Position = vec4(0.0); return; }
      vec3 size = vec3(aBox.x, aBox.x * 0.5 + 6.0, aBox.x);
      vec3 centre = cameraPosition + (uCamFwd * 0.35 + vec3(0.0, 0.15, 0.0)) * size;
      float spd = 0.8 + 0.4 * aSeed.w;
      vec3 rel = mod(aSeed.xyz * size + uRainOffset * spd - centre, size) - size * 0.5;
      vec3 head = centre + rel;
      vec3 e = abs(rel) / (size * 0.5);
      float edge = 1.0 - smoothstep(0.7, 1.0, max(e.x, max(e.y, e.z))); // drops wrap unseen at the box faces

      vec3 dir = normalize(uRainVel);
      float len = length(uRainVel) * spd * 0.05; // motion blur: streak length follows fall speed
      vec3 toCam = cameraPosition - head;
      float dist = length(toCam);
      vec3 side = normalize(cross(toCam, dir)); // this order faces the camera (front face)
      // at least ~1 px wide, fainter instead of thinner far away (sub-pixel streaks flicker)
      float w = 0.009, ww = max(w, dist * uPixel * 1.2);
      vec3 p = head - dir * len * position.y + side * position.x * ww;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      vUv = position.xy + vec2(0.5, 0.0);
      float lens = smoothstep(0.8, 2.5, dist); // no huge streaks right in front of the lens
      vAlpha = show * edge * lens * (w / ww) * (0.35 + 0.15 * uRain);
    }`,
  fragmentShader: rainColor + /* glsl */ `
    varying vec2 vUv;
    varying float vAlpha;
    void main() {
      float a = vAlpha * (1.0 - abs(vUv.x * 2.0 - 1.0)) * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.5, vUv.y);
      gl_FragColor = vec4(rainColor(), a);
      #include <colorspace_fragment>
    }`,
});
const drops = new THREE.Mesh(geo, dropMat);
drops.frustumCulled = false; // placed in the shader
drops.renderOrder = 5; // after the clouds (3) and lightning bolts (4), which are always farther away

// ---------- splashes ----------
// Short-lived crowns (ring + a few droplets) on the meadow near the camera, among the grass tips.
// shortcut: camera-facing sprites at random heights in the grass, not real hits on blades/rocks; fine from the clock view.
const sGeo = new THREE.InstancedBufferGeometry();
const sQuad = new THREE.PlaneGeometry(1, 1);
sGeo.setIndex(sQuad.index);
sGeo.setAttribute('position', sQuad.getAttribute('position'));
const splash = new THREE.InstancedBufferAttribute(new Float32Array(SPLASHES * 4), 4).setUsage(THREE.DynamicDrawUsage);
sGeo.setAttribute('aSplash', splash); // xyz, age (0..1 drawn; -1..0 a new one's delay; below -1 a pause before the next draw)
const sRand = new Float32Array(SPLASHES).map(() => rand());
sGeo.setAttribute('aRand', new THREE.InstancedBufferAttribute(sRand, 1));
sGeo.instanceCount = SPLASHES;
for (let i = 0; i < SPLASHES; i++) splash.array[i * 4 + 3] = 1; // all respawn (placed near the camera) on the first update

const splashMat = new THREE.ShaderMaterial({
  uniforms: dropMat.uniforms,
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    attribute vec4 aSplash;
    attribute float aRand;
    varying vec2 vUv;
    varying float vAge;
    varying float vSquash;
    varying float vRand;
    varying float vNear;
    void main() {
      if (aSplash.w < 0.0 || aSplash.w >= 1.0) { gl_Position = vec4(0.0); return; }
      vec4 mv = viewMatrix * vec4(aSplash.xyz, 1.0);
      mv.xy += position.xy * (0.16 + 0.1 * aRand) * 2.0;
      gl_Position = projectionMatrix * mv;
      vUv = position.xy * 2.0;
      vAge = aSplash.w;
      vSquash = clamp(abs(normalize(cameraPosition - aSplash.xyz).y), 0.15, 1.0); // ring seen at the view's slant
      vRand = aRand;
      vNear = smoothstep(1.5, 4.0, distance(cameraPosition, aSplash.xyz)); // fainter right under the camera
    }`,
  fragmentShader: rainColor + /* glsl */ `
    uniform float uRain;
    varying vec2 vUv;
    varying float vAge;
    varying float vSquash;
    varying float vRand;
    varying float vNear;
    void main() {
      vec2 base = vec2(0.0, -0.5);
      // ring spreading on the surface
      float r = 0.15 + 0.75 * vAge;
      float ring = 1.0 - smoothstep(0.0, 0.04, abs(length((vUv - base) / vec2(1.0, vSquash)) - r));
      // droplets thrown up and out, falling back
      float d = 0.0;
      for (int k = 0; k < 4; k++) {
        float fk = float(k);
        float sx = (fk - 1.5) / 1.5 * (0.6 + 0.3 * fract(vRand * 7.0 + fk * 0.37));
        float hy = 0.9 + 0.5 * fract(vRand * 13.0 + fk * 0.61);
        vec2 p = base + vec2(sx * vAge, hy * 4.0 * vAge * (1.0 - vAge) * (1.0 - abs(sx) * 0.4));
        d = max(d, 1.0 - smoothstep(0.03, 0.055, length(vUv - p))); // small: big droplets read as bubbles
      }
      float a = max(ring * 0.7, d) * (1.0 - vAge) * (0.6 + 0.3 * uRain) * vNear; // none right under the lens: a close one fills the view
      if (a < 0.01) discard;
      gl_FragColor = vec4(rainColor() * 1.15, a);
      #include <colorspace_fragment>
    }`,
});
const splashes = new THREE.Mesh(sGeo, splashMat);
splashes.frustumCulled = false;
splashes.renderOrder = 5;

rainLayer.add(drops, splashes);

let lastT = null;

// t = scene time (s), camera, dt = real seconds since the last frame.
export function updateRain(t, camera, dt) {
  const rain = weather.rain;
  const u = dropMat.uniforms;

  // Wet ground: soaks up over a few minutes of scene time while it rains, dries over ~30 min.
  // Scene time, so the slider time-lapse dries it too; big jumps are clamped, jumps back count as nothing.
  if (lastT === null) uniforms.uWet.value = rain > 0.05 ? 1 : 0; // loaded mid-rain: it has been raining a while
  const sdt = lastT === null ? 0 : THREE.MathUtils.clamp(t - lastT, 0, 3600); // backward jumps count as nothing; a long hidden tab still dries/soaks
  lastT = t;
  uniforms.uWet.value = THREE.MathUtils.clamp(uniforms.uWet.value + sdt * (rain > 0.05 ? rain / 150 : -1 / 1800), 0, 1);

  const showing = rainLayer.visible;
  rainLayer.visible = rain > 0.002;
  if (!rainLayer.visible) { // dry: end every splash, or one caught mid-life would pop back where it was when rain returns
    if (showing) for (let i = 3; i < splash.array.length; i += 4) splash.array[i] = 1;
    return;
  }

  // Falling: real time (rain doesn't speed up with the time-lapse). Wind slants it.
  const wind = uniforms.uWindDir.value, ws = uniforms.uWindStrength.value * 0.3; // m/s of wind -> drift (the streaks would lie flat at full speed)
  u.uRainVel.value.set(wind.x * ws, -(6.5 + 3 * rain), wind.y * ws);
  u.uRainOffset.value.addScaledVector(u.uRainVel.value, dt);
  if (u.uRainOffset.value.lengthSq() > 1e8) u.uRainOffset.value.set(0, 0, 0); // keep float precision; the jump is invisible in random drops
  u.uRain.value = rain;
  camera.getWorldDirection(u.uCamFwd.value);
  u.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;

  // Splashes: each slot lives ~0.35 s, then waits or respawns somewhere in front of the camera.
  const a = splash.array, cam = camera.position, heading = Math.atan2(u.uCamFwd.value.z, u.uCamFwd.value.x);
  for (let i = 0; i < SPLASHES; i++) {
    const i4 = i * 4, was = a[i4 + 3];
    a[i4 + 3] += dt / 0.35;
    if (was < -1 && a[i4 + 3] >= -1) a[i4 + 3] = 1; // a pause ends in the next draw, never in the drawn range (0..1): it replayed the last splash in its old spot
    if (a[i4 + 3] < 1) continue;
    // thin with the streaks: in a fading shower (a time jump eases the weather over minutes) the streaks vanish first,
    // and lone splashes read as puddles. No splash this time: a hidden pause as long as a life, then draw again.
    if (rand() > rain * THREE.MathUtils.smoothstep(rain, 0.04, 0.3)) { a[i4 + 3] = -2 - rand() * 0.5; continue; }
    const ang = heading + (rand() - 0.5) * 1.8, d = 1.5 + 12 * Math.sqrt(rand());
    const x = cam.x + Math.cos(ang) * d, z = cam.z + Math.sin(ang) * d;
    a[i4] = x; a[i4 + 1] = heightAt(x, z) + 0.2 + rand() * 0.7; a[i4 + 2] = z; // somewhere among the grass tips
    a[i4 + 3] = -rand() * 0.3;
  }
  splash.needsUpdate = true;
}
