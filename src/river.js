import * as THREE from 'three';
import { uniforms, glslCommon, riverZ, riverHalfWidth, heightAt, WATER_Y } from './common.js';
import { REEDS } from './layout.js';
import { weather } from './weather.js';
import { glslWind } from './wind.js';
import { onSetting } from './settings.js';
import { skyBodies } from './daycycle.js';
import { skyLayer } from './sky.js';

// Toon river: a flat strip along the centre line (common.js) at WATER_Y, a little wider than the water,
// so the carved banks cut the shoreline. Flows toward +x (with the wind and the clouds).
const X0 = -200, X1 = 200; // same extent as the terrain
const SPEED = [0.45, 1.3]; // m/s at the banks and mid-stream
const SCALE = 0.35; // noise cells per metre along the river
const PERIOD = 64; // the noise tiles every 64 cells, so the drift (scene time ~1.7e9 s) wraps on the CPU without a seam
const CYCLE = 3; // flow-map cycle (s): ripples ride the local current for a cycle, then fade into a fresh patch
const RES = 0.5; // reflection target, fraction of the drawing buffer
const MAX_ROCKS = 4;

function riverGeometry() {
  const pos = [], river = [], dir = [], idx = [];
  let along = 0, pz = riverZ(X0);
  for (let x = X0, i = 0; x <= X1; x++, i++) {
    const z = riverZ(x), s = riverZ(x + 0.5) - riverZ(x - 0.5), l = Math.hypot(1, s);
    along += Math.hypot(1, z - pz);
    pz = z;
    const hw = riverHalfWidth(x), a = hw + 2; // reaches under the banks
    for (const k of [-a, a]) { // across: + toward the near (camera) bank
      pos.push(x - (s / l) * k, WATER_Y, z + k / l);
      river.push(along, k, hw);
      dir.push(1 / l, s / l);
    }
    if (i) idx.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2); // counter-clockwise from above
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aRiver', new THREE.Float32BufferAttribute(river, 3));
  geo.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2));
  geo.setIndex(idx);
  return geo;
}

const local = {
  uShallow: { value: new THREE.Color('#86e3cf') },
  uDeep: { value: new THREE.Color('#1f8299') },
  uFlow: { value: new THREE.Vector2() }, // noise drift at the banks / mid-stream, in cells, wrapped
  uCycle: { value: 0 }, // rain ripple clock: whole + fractional ripple cycles, wrapped
  uRain: { value: 0 },
  uRocks: { value: Array.from({ length: MAX_ROCKS }, () => new THREE.Vector4()) }, // x, z, radius at the waterline
  uPhase: { value: new THREE.Vector4() }, // flow map: phases A, B (0..1, half a cycle apart), their noise jumps (cells)
  uReflection: { value: null }, // the mirrored scene (renderReflection), null/off: the old sky-and-band fake
  uReflect: { value: 0 },
  uTexMat: { value: new THREE.Matrix4() }, // world -> reflection texture (projective)
};

const mat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, ...local },
  vertexShader: /* glsl */ `
    attribute vec3 aRiver;
    attribute vec2 aDir;
    varying vec3 vRiver;
    varying vec2 vDir;
    varying vec3 vWorldPos;
    varying vec4 vRefl;
    uniform mat4 uTexMat;
    void main() {
      vRiver = aRiver;
      vDir = aDir;
      vWorldPos = position;
      vRefl = uTexMat * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    #define PERIOD ${PERIOD.toFixed(1)}
    uniform vec3 uShallow;
    uniform vec3 uDeep;
    uniform vec2 uFlow;
    uniform float uCycle;
    uniform float uRain;
    uniform vec4 uRocks[${MAX_ROCKS}];
    uniform vec4 uPhase;
    uniform sampler2D uReflection;
    uniform float uReflect;
    varying vec3 vRiver; // along (m), across (m, + toward the near bank), half width (m)
    varying vec2 vDir; // downstream, xz
    varying vec3 vWorldPos;
    varying vec4 vRefl;

    float vnoiseP(vec2 p, float per) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash12(mod(i, per)), hash12(mod(i + vec2(1, 0), per)), u.x),
                 mix(hash12(mod(i + vec2(0, 1), per)), hash12(mod(i + vec2(1, 1), per)), u.x), u.y);
    }
    // flow noise at 'freq' times the base scale, drifted by 'drift' base cells (integer freq keeps the wrap seamless)
    float flowNoise(vec2 q, float drift, float freq) {
      return vnoiseP(vec2(q.x * ${SCALE} - drift, q.y) * freq, PERIOD * freq);
    }
    // value noise and its gradient
    vec3 vnoiseD(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
      float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1)), e = a - b - c + d;
      return vec3(a + (b - a) * u.x + (c - a) * u.y + e * u.x * u.y, du * vec2(b - a + e * u.y, c - a + e * u.x));
    }
    // two octaves of ripples at cell c carried by velocity vc (cells/s) through this phase: height, gradient (per cell)
    vec3 ripples(vec2 c, vec2 vc, float ph, float jump) {
      vec2 s = c - vc * ((ph - 0.5) * ${CYCLE.toFixed(1)}) + jump * vec2(1.0, 1.7);
      return vnoiseD(s) * 0.6 + vnoiseD(s * 2.0 + 5.3) * vec3(0.4, 0.8, 0.8);
    }
    // flow map: phase A fades out while it jumps to a fresh patch, B half a cycle later; the blend's lost contrast restored
    vec3 advect(vec2 c, vec2 vc, float seed) {
      float w = 1.0 - abs(2.0 * uPhase.x - 1.0);
      vec3 h = mix(ripples(c, vc, uPhase.y, uPhase.w + seed), ripples(c, vc, uPhase.x, uPhase.z + seed), w);
      return vec3(0.5, 0.0, 0.0) + (h - vec3(0.5, 0.0, 0.0)) * inversesqrt(w * w + (1.0 - w) * (1.0 - w));
    }

    void main() {
      vec3 p = vWorldPos;
      vec3 V = normalize(cameraPosition - p);
      float dist = distance(p, cameraPosition);
      float hw = vRiver.z;
      float edge = hw - abs(vRiver.y); // metres from the shoreline
      vec2 across = vec2(-vDir.y, vDir.x); // + across, world xz
      vec2 q = vec2(vRiver.x, vRiver.y * 1.6); // along / across, streaks stretched along the flow
      float fN = flowNoise(q + 40.0, uFlow.x, 4.0);

      // current (m/s along, across): parabolic across the channel; potential flow around each rock (the water parts in
      // front and speeds past its flanks), slack water in its wake. Rock foam: a ring and two lines trailing from the flanks.
      float k = clamp(vRiver.y / hw, -1.0, 1.0), u = mix(${SPEED[0]}, ${SPEED[1]}, 1.0 - k * k);
      vec2 vel = vec2(u, 0.0);
      float wake = 0.0, ringF = 0.0, lineF = 0.0;
      for (int i = 0; i < ${MAX_ROCKS}; i++) {
        vec4 r = uRocks[i];
        if (r.z <= 0.0) continue;
        vec2 rel = p.xz - r.xy, l = vec2(dot(rel, vDir), dot(rel, across));
        float a2 = r.z * r.z, d2 = max(dot(l, l), a2);
        vel += u * a2 / (d2 * d2) * vec2(l.y * l.y - l.x * l.x, -2.0 * l.x * l.y);
        float trail = step(0.0, l.x) * exp(-l.x / (5.0 * r.z));
        wake = max(wake, trail * (1.0 - smoothstep(0.6 * r.z, 1.2 * r.z + 0.15 * l.x, abs(l.y))));
        ringF = max(ringF, 1.0 - smoothstep(0.25, 0.55, (length(rel) - r.z) / (0.5 + 0.8 * fN)));
        lineF = max(lineF, trail * (1.0 - smoothstep(0.06, 0.3, abs(abs(l.y) - 0.85 * r.z - 0.12 * l.x) / r.z)));
      }
      vel.x *= 1.0 - 0.6 * wake;

      // ripples riding the current (flow map in cells: 0.35/m along, 1.6/m across, so they stretch along the stream);
      // rougher mid-stream and behind the rocks
      const vec2 CELL = vec2(${SCALE}, 1.6);
      vec3 h = advect(vRiver.xy * CELL, vel * CELL, 0.0);
      float flow = h.x;
      vec2 G = (h.y * CELL.x * vDir + h.z * CELL.y * across) * 0.05 * (0.6 + 0.5 * u / ${SPEED[1]} + 0.8 * wake); // slope, world xz
      // wind chop: finer ripples, crests across the wind, carried by the wind and the current; none in a calm
      vec2 wd = uWindDir, wn = vec2(-wd.y, wd.x), drift = vel.x * vDir + vel.y * across + wd * 0.06 * uWindStrength;
      const vec2 CHOP = vec2(2.2, 0.8);
      vec3 ch = advect(vec2(dot(p.xz, wd), dot(p.xz, wn)) * CHOP, vec2(dot(drift, wd), dot(drift, wn)) * CHOP, 23.0);
      G += (ch.y * CHOP.x * wd + ch.z * CHOP.y * wn) * 0.035 * smoothstep(0.5, 8.0, uWindStrength);
      vec3 N = normalize(vec3(-G.x, 1.0, -G.y));

      // depth: light turquoise shallows along the banks (ragged, sandbars) -> deep teal mid-stream
      float deep = smoothstep(0.6, 0.7 * hw, edge + (vnoise(p.xz * 0.15) - 0.5) * 2.5);
      vec3 albedo = mix(uShallow, uDeep, deep);
      albedo = mix(albedo, uShallow * 1.1, smoothstep(0.62, 0.74, flow) * 0.45 * (1.0 - uRain)); // soft streaks
      albedo = mix(albedo, vec3(dot(albedo, vec3(0.33))), 0.35 * uRain); // rain: greyer, churned

      float cs = cloudShadow(p), lit = toon(uSunDir.y, 0.1) * treeShadow(p) * cs;
      vec3 light = mix(uShadeColor, uSunColor, lit);
      vec3 col = albedo * light;

      float facing = 1.0 - max(dot(V, N), 0.0);
      vec3 env;
      float fres;
      if (uReflect > 0.5) {
        // mirror (renderReflection): shifted by the ripples, more up and down (reflections stretch toward the viewer);
        // a little darker and tinted by the water, mostly mirror at grazing angles, water colour looking down
        env = texture(uReflection, vRefl.xy / vRefl.w + vec2(N.x, N.z * 2.0) * 0.12).rgb;
        float bright = smoothstep(0.7, 1.0, max(env.r, max(env.g, env.b))); // the moon, the sun, stars, lit cloud tops
        env = mix(env * 0.85, col, 0.2);
        fres = max(0.12 + 0.68 * pow(facing, 3.0), 0.85 * bright); // ...still shine in the water when looking down
      } else {
        // sky: horizon colour at grazing angles, zenith colour looking down steeply; a dark band from the far bank
        vec3 R = reflect(-V, N);
        vec3 zenith = min(uZenithColor, uFogColor * 1.3 + 0.02); // guard: the sky overhead never outshines the horizon much (dark night water)
        env = mix(uFogColor, zenith, smoothstep(0.02, 0.5, R.y));
        float side = sign(dot(across, cameraPosition.xz - p.xz)); // which bank the camera is on
        float farShore = hw + vRiver.y * side; // metres from the far shore
        float bankW = clamp(1.2 * abs(dot(normalize(V.xz), across)) / max(V.y, 0.02), 0.6, hw);
        env = mix(env, uGround * light * 0.55, 0.6 * (1.0 - smoothstep(0.0, bankW, farShore + (flow - 0.5) * 1.5)));
        fres = 0.08 + 0.62 * pow(facing, 4.0);
      }
      col = mix(col, env, fres * (1.0 - 0.4 * uRain));

      // white foam: a broken line along both banks, rings around rocks in the water, their wake lines broken by the flow
      float aa = fwidth(edge) + 0.02;
      float foam = 1.0 - smoothstep(0.45 * fN + 0.15 - aa, 0.45 * fN + 0.15 + aa, edge);
      foam = max(foam, (1.0 - smoothstep(0.9, 1.0, edge / (0.6 + 0.9 * fN))) * step(0.55, fN) * 0.7);
      foam = max(foam, max(ringF, lineF * smoothstep(0.45, 0.6, flow)));
      col = mix(col, light * 1.05, clamp(foam, 0.0, 1.0) * 0.9);

      // rain ripples: one expanding ring per 0.9 m cell, at a new spot every cycle
      if (uRain > 0.01) {
        vec2 c = p.xz / 0.9, ci = floor(c);
        float h = hash12(ci), ph = fract(uCycle + h), cyc = mod(floor(uCycle + h), 64.0); // same spot across the CPU wrap
        vec2 ctr = 0.25 + 0.5 * vec2(hash12(ci + cyc * 7.1), hash12(ci + cyc * 3.7 + 9.0));
        float ring = abs(length(c - ci - ctr) - ph * 0.35);
        col += light * 0.35 * (1.0 - smoothstep(0.0, 0.05, ring)) * (1.0 - ph) * step(h, uRain) * (1.0 - smoothstep(15.0, 40.0, dist));
      }

      // glints: toon sparkles in the light's glitter path (the moon at night), a few anywhere while the light is strong
      vec3 Rs = reflect(-V, normalize(vec3(-G.x * 5.0, 1.0, -G.y * 5.0))); // tilted more: a wide glitter path
      float path = smoothstep(0.86, 0.995, dot(Rs, uSunDir));
      float sp = flowNoise(q + 90.0, uFlow.y, 8.0) * flowNoise(q + 120.0, uFlow.x, 8.0);
      float glint = smoothstep(0.42, 0.5, sp) * (path + 0.25 * smoothstep(0.2, 0.6, uSunDir.y));
      col += uSunColor * glint * 1.4 * uShadowStrength * cs * (1.0 - uRain);

      gl_FragColor = vec4(applyFog(col, p), 1.0);
      #include <colorspace_fragment>
    }`,
});

const mesh = new THREE.Mesh(riverGeometry(), mat);
mesh.frustumCulled = false; // spans the whole terrain
mesh.renderOrder = 0.6; // with the ground (terrain.js), after the grass and trees: the water they hide is never shaded

// Reeds: patches of tall blades and cattails at the waterline (layout.js REEDS), swaying with the grass (windBend).
function makeReeds({ offsets, params } = REEDS) {
  const count = offsets.length / 3;
  const geo = new THREE.InstancedBufferGeometry();
  const rows = [0, 0.35, 0.68, 0.7, 0.88, 0.9, 1]; // the cattail head sits between 0.7 and 0.88
  geo.setAttribute('position', new THREE.Float32BufferAttribute(rows.flatMap((t) => [-0.5, t, 0, 0.5, t, 0]), 3));
  geo.setIndex(rows.slice(1).flatMap((_, i) => [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2]));
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 3));
  geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(new Float32Array(params), 4));
  geo.instanceCount = count;
  const reeds = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: glslCommon + glslWind + /* glsl */ `
      attribute vec3 aOffset;
      attribute vec4 aParams; // rotation, height, cattail, random
      varying float vT;
      varying float vHead;
      varying vec3 vWorldPos;
      void main() {
        float t = position.y, h = aParams.y;
        float head = aParams.z * step(0.69, t) * step(t, 0.89);
        float w = mix(0.07 * (1.0 - t), 0.018 + 0.05 * head, aParams.z); // leaf blade or cattail stem + head
        vec3 p = vec3(position.x * w, t * h, t * t * h * 0.15 * (1.0 - aParams.z));
        float s = sin(aParams.x), c = cos(aParams.x);
        vec3 wp = aOffset + vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
        vec2 bend = windBend(aOffset.xz, t, h * 0.6, aParams.w);
        wp.xz += bend;
        wp.y -= length(bend) * 0.3 * t; // lean, don't stretch, in a strong wind
        vT = t;
        vHead = head;
        vWorldPos = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: glslCommon + /* glsl */ `
      varying float vT;
      varying float vHead;
      varying vec3 vWorldPos;
      void main() {
        vec3 col = mix(uGround * 0.55, uGrassTip * vec3(0.95, 0.9, 0.6), vT); // darker, olive-tipped
        col = mix(col, vec3(0.2, 0.09, 0.04), step(0.5, vHead)); // cattail
        col *= mix(uShadeColor, uSunColor, toon(uSunDir.y, 0.1) * shadowAt(vWorldPos));
        gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  reeds.frustumCulled = false; // placed in the shader
  return reeds;
}

export const riverLayer = new THREE.Group().add(mesh, makeReeds());

// Rocks standing in the water get foam around them: list = the rock layout from main.js ({ x, z, size }).
export function setRiverRocks(list) {
  let n = 0;
  for (const r of list) {
    const ground = heightAt(r.x, r.z), dy = WATER_Y - ground - r.size * 0.4; // from the rock centre, see rocks.js
    if (ground < WATER_Y && Math.abs(dy) < r.size && n < MAX_ROCKS) local.uRocks.value[n++].set(r.x, r.z, Math.sqrt(r.size * r.size - dy * dy) * 1.1, 0);
  }
}

// t = scene time (s), camera, dt = real seconds since the last frame.
export function updateRiver(t, camera, dt) {
  const w = (s) => (t * s * SCALE) % PERIOD; // exact in double precision on the CPU
  local.uFlow.value.set(w(SPEED[0]), w(SPEED[1]));
  const c = t / CYCLE; // flow-map phases and a new noise patch per cycle, exact on the CPU
  local.uPhase.value.set(c % 1, (c + 0.5) % 1, (Math.floor(c) * 7.31) % PERIOD, (Math.floor(c + 0.5) * 5.17 + 31) % PERIOD);
  local.uCycle.value = (t * 1.1) % 64;
  local.uRain.value = weather.rain;
}

// Reflection: the scene seen from the camera mirrored in the water, at RES of the screen, into a texture the water
// samples projectively (like three's Reflector, but a horizontal plane only and without the layers that can't show).
// sRGB storage: the linear output keeps its dark shades (night water) in 8 bits.
const rt = new THREE.WebGLRenderTarget(1, 1);
rt.texture.colorSpace = THREE.SRGBColorSpace;
const mirror = new THREE.PerspectiveCamera(), plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4();
const size = new THREE.Vector2(), look = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
let reflections = true;
onSetting('quality.reflections', (on) => { reflections = on; if (!on) { local.uReflection.value = null; rt.dispose(); } }); // off: the old fake, memory freed

// The mirror is drawn into a texture (linear output), the view onto the screen (sRGB): a material drawn into both makes
// three.js work out its program again at every switch, ~60 times a frame. So the mirror draws with twins: copies with
// the same shaders and the same uniform objects.
const twins = new Map(), swapped = [];
function twin(m) {
  if (!twins.has(m)) {
    const u = m.uniforms;
    m.uniforms = {}; // clone() would deep-copy them
    twins.set(m, Object.assign(m.clone(), { uniforms: u }));
    m.uniforms = u;
  }
  return twins.get(m);
}

// Before the main render. skip: objects never seen in the water (grass in front of it, rain, the clock).
// Every other frame while the view stands still, on the tree shadow map's frames (shadow.js; the clouds' maps take the
// others): the ripples smear this picture, and what is in it still moves 30 times a second. It is laid over the screen
// as drawn, so a turning or zooming view draws it every frame, as do a lightning flash and a resized picture.
const wasVisible = [], drawnAt = new THREE.Vector3(), drawnTurn = new THREE.Quaternion(), drawnLens = new THREE.Matrix4();
let n = 0, watching = false;
export function renderReflection(renderer, scene, camera, skip) {
  if (!watching) { // a lost and restored context comes back with an empty mirror: draw it on the next frame, whoever's turn it is
    renderer.domElement.addEventListener('webglcontextrestored', () => { local.uReflection.value = null; });
    watching = true;
  }
  const turn = n++ % 2 === 1;
  local.uReflect.value = reflections && camera.position.y > WATER_Y ? 1 : 0;
  if (!local.uReflect.value) return;
  renderer.getDrawingBufferSize(size);
  const w = Math.ceil(size.x * RES), h = Math.ceil(size.y * RES);
  const flash = uniforms.uFlash.value + uniforms.uFlashLight.value.x + uniforms.uFlashLight.value.y > 0;
  const still = local.uReflection.value === rt.texture && rt.width === w && rt.height === h
    && drawnAt.equals(camera.position) && drawnTurn.equals(camera.quaternion) && drawnLens.equals(camera.projectionMatrix);
  if (!turn && !flash && still) return;
  drawnAt.copy(camera.position);
  drawnTurn.copy(camera.quaternion);
  drawnLens.copy(camera.projectionMatrix);
  if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
  local.uReflection.value = rt.texture;
  // a plain lookAt camera below the water (so the camera-facing and cameraPosition shaders just work); its picture is
  // the mirror image flipped left-right, which the texture matrix undoes
  mirror.position.copy(camera.position).setY(2 * WATER_Y - camera.position.y);
  camera.getWorldDirection(look).setY(-look.y).add(mirror.position);
  mirror.up.copy(UP).applyQuaternion(camera.quaternion).y *= -1;
  mirror.lookAt(look);
  mirror.updateMatrixWorld();
  mirror.projectionMatrix.copy(camera.projectionMatrix);
  local.uTexMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    .multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
  // oblique near plane on the water (Lengyel): nothing under the surface gets mirrored
  plane.set(UP, -WATER_Y).applyMatrix4(mirror.matrixWorldInverse);
  clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  const e = mirror.projectionMatrix.elements;
  q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
  clip.multiplyScalar(2 / clip.dot(q));
  e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;
  // only rows below the horizon (+ the ripples' shift) can show in the water: its picture lines up with the screen's rows
  camera.getWorldDirection(look).setY(0).normalize().add(camera.position).project(camera);
  rt.scissor.set(0, 0, w, Math.max(1, Math.min(h, Math.ceil(h * ((look.y + 1) / 2 + 0.05)))) || h);
  rt.scissorTest = true;

  for (let i = 0; i < skip.length; i++) { wasVisible[i] = skip[i].visible; skip[i].visible = false; } // put back as found (the clock and rain hide themselves)
  mesh.visible = false;
  skyLayer.position.copy(mirror.position); // the sky and its discs centre on whichever camera looks
  skyBodies.position.copy(mirror.position);
  const target = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.state.buffers.depth.setMask(true); // the clear must reach the depth buffer (see Reflector)
  scene.traverseVisible((o) => { if (o.material) { swapped.push(o, o.material); o.material = twin(o.material); } });
  try { renderer.render(scene, mirror); } finally { // a throw must not leave the twins on (the next frame would twin them again)
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    swapped.length = 0;
  }
  renderer.setRenderTarget(target);
  skyLayer.position.copy(camera.position);
  skyBodies.position.copy(camera.position);
  mesh.visible = true;
  for (let i = 0; i < skip.length; i++) skip[i].visible = wasVisible[i];
}
