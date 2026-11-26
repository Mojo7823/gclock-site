import * as THREE from 'three';
import { uniforms, glslCommon, MOUNTAIN } from './common.js';
import { weather } from './weather.js';
import { groundHeights, renderTransmittance } from './cloudvolume.js';

// God rays: sunbeams through the gaps in broken cloud (docs/CLOUDS.md → God rays). World space, not a screen-space blur:
// the clock view rarely has the sun on screen at the right moment, and shafts must slant over the land from any side.
// 1. A light map on the ground plane (MAP² render target, renderGodRays): every point of the air below the clouds is
//    looked up at g = its xz moved along the sun ray down to y = 0, so a whole shaft (a line toward the sun) shares one
//    texel. The clouds' own density is marched along each shaft (cloudvolume.js renderTransmittance), so the shafts
//    follow the real gaps; a texel is a beam where it is sunlit AND shadow lies close by (lit × (1 - open around)):
//    rays at the edges of the gaps, never a haze over open sky or under a deck.
// 2. SLICES vertical camera-facing sheets at fixed distances, drawn additively: each looks up the map, so the slices
//    together sample the beams in 3D (parallax, perspective fan toward the sun), faded on the land (baked heights,
//    cloudvolume.js: no seam where a slice meets the ground), toward the cloud base, with distance, and brighter
//    toward the sun (forward scattering). A fine noise in g (drifting slowly) splits the beams into rays.
const MAP = 256;
// distances (m) and weights: from just behind the big tree (~70 m from the clock: no veil on it) to well short of the
// mountain (~350 m), fainter far out
const SLICES = [[80, 0.8], [100, 1], [125, 1], [155, 1], [190, 0.9], [235, 0.75]];
const SPAN = 1.15; // slices reach this much past the side of the view (the region of the map covers them)
const BOTTOM = -12; // lowest point of a slice (the river valley); the land hides the rest
// ?godrays=<gain> (dev): 0 = off, >1 exaggerates them to see where they are (A/B shots, GPU timing)
const GAIN = Number(new URLSearchParams(location.search).get('godrays') ?? 1) || 0;
const MIN_SUN = 0.08; // shafts are projected with the sun at least this high (a dawn sun sent the map 1-2 km out)
const RINGS = [40, 90]; // how far around a sunlit texel the shadow it needs may lie (m)

const { smoothstep } = THREE.MathUtils;
const region = new THREE.Vector3(); // map centre x, z and half size (m)
const rect = new THREE.Vector4(); // the same as x0, z0, width, depth
const sun = new THREE.Vector3(); // toward the sun, y clamped to MIN_SUN
const ratio = new THREE.Vector2(); // sun.xz / sun.y

// ---------- the light map ----------
const mapOpts = { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
const trans = new THREE.WebGLRenderTarget(MAP, MAP, mapOpts); // sunlight through the clouds along each shaft
const target = new THREE.WebGLRenderTarget(MAP, MAP, mapOpts);
const gateMat = new THREE.ShaderMaterial({
  uniforms: { uTrans: { value: trans.texture }, uRing: { value: new THREE.Vector2() } },
  depthTest: false,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uTrans;
    uniform vec2 uRing; // ring radii (map uv)
    varying vec2 vUv;
    void main() {
      float lit = texture2D(uTrans, vUv).r, open = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7854 + 0.39;
        vec2 d = vec2(cos(a), sin(a));
        open += texture2D(uTrans, vUv + d * uRing.x).r + texture2D(uTrans, vUv + d.yx * uRing.y).r;
      }
      gl_FragColor = vec4(lit * (1.0 - open / 16.0), 0.0, 0.0, 1.0);
    }
  `,
});
const mapScene = new THREE.Scene().add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gateMat), { frustumCulled: false }));
const mapCam = new THREE.Camera();

// ---------- the slices ----------
const quad = new THREE.PlaneGeometry(2, 1);
const geo = new THREE.InstancedBufferGeometry();
geo.index = quad.index;
geo.attributes.position = quad.attributes.position;
geo.setAttribute('aSlice', new THREE.InstancedBufferAttribute(new Float32Array(SLICES.flat()), 2));
geo.instanceCount = SLICES.length;

const view = new THREE.Vector4(); // camera x, z, horizontal forward x, z
const off = new THREE.Vector2(); // ray noise drift (noise cells, wrapped to its period)
const U = {
  uGodMap: { value: target.texture },
  uGodRegion: { value: region },
  uGodSun: { value: sun },
  uGodColor: { value: new THREE.Color() },
  uGodTop: { value: 60 },
  uGodView: { value: view },
  uGodSpan: { value: 1 }, // half width of a slice per metre of distance
  uGodOff: { value: off },
  uGroundH: { value: groundHeights.tex },
  uGroundRect: { value: groundHeights.rect },
};
const mat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, ...U },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  forceSinglePass: true, // one draw: three.js would draw the back faces, then the front, refreshing the program each time
  vertexShader: /* glsl */ `
    attribute vec2 aSlice; // distance (m), weight
    uniform vec4 uGodView;
    uniform float uGodTop;
    uniform float uGodSpan;
    varying vec3 vWorld;
    varying float vWeight;
    void main() {
      vec2 f = uGodView.zw, s = vec2(-f.y, f.x);
      vec2 xz = uGodView.xy + f * aSlice.x + s * position.x * aSlice.x * uGodSpan;
      vWorld = vec3(xz.x, mix(${BOTTOM.toFixed(1)}, uGodTop, position.y + 0.5), xz.y);
      vWeight = aSlice.y;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    ${glslCommon}
    uniform sampler2D uGodMap;
    uniform vec3 uGodRegion;
    uniform vec3 uGodSun;
    uniform vec3 uGodColor;
    uniform float uGodTop;
    uniform vec2 uGodOff;
    uniform sampler2D uGroundH;
    uniform vec4 uGroundRect;
    varying vec3 vWorld;
    varying float vWeight;
    // 1 = the big peak is not behind p: the peak as a cone (apex MOUNTAIN, radius 170 m at y = 0, as the hero's base);
    // the view ray's closest pass by its axis, past p, inside the cone's radius at that height
    float peakFree(vec3 p) {
      vec3 r = normalize(p - cameraPosition);
      vec2 toPeak = vec2(${MOUNTAIN.x.toFixed(1)}, ${MOUNTAIN.z.toFixed(1)}) - cameraPosition.xz;
      float h = max(length(r.xz), 1e-4), t = dot(toPeak, r.xz) / (h * h); // ray parameter of the closest pass
      float miss = length(cameraPosition.xz + r.xz * t - vec2(${MOUNTAIN.x.toFixed(1)}, ${MOUNTAIN.z.toFixed(1)}));
      float R = 170.0 * (1.0 - (cameraPosition.y + r.y * t) / ${MOUNTAIN.y.toFixed(1)}); // < 0: passing over the top
      return R > 0.0 && t > distance(p, cameraPosition) ? smoothstep(0.75 * R, R + 10.0, miss) : 1.0;
    }
    // value noise tiling every 64 cells, so the drift offset wraps on the CPU without a jump
    float vnoise64(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash12(mod(i, 64.0)), hash12(mod(i + vec2(1, 0), 64.0)), u.x),
                 mix(hash12(mod(i + vec2(0, 1), 64.0)), hash12(mod(i + vec2(1, 1), 64.0)), u.x), u.y);
    }
    void main() {
      vec3 p = vWorld;
      vec2 g = p.xz - uGodSun.xz / uGodSun.y * p.y; // where this point's shaft meets the ground
      float b = texture2D(uGodMap, (g - uGodRegion.xy) / (2.0 * uGodRegion.z) + 0.5).r;
      if (b < 0.004) discard;
      float h = texture2D(uGroundH, (p.xz - uGroundRect.xy) * uGroundRect.zw).r;
      vec3 v = p - cameraPosition;
      float d = length(v), fwd = max(dot(v / d, normalize(uGodSun)), 0.0);
      b *= vWeight * smoothstep(h, h + 10.0, p.y) * smoothstep(uGodTop, uGodTop * 0.5, p.y) * peakFree(p); // the peak stays clear
      float f2 = fwd * fwd, f4 = f2 * f2;
      b *= 0.08 + 0.5 * f2 + 1.7 * f4 * f4; // forward scattering: vivid toward the sun, faint looking away
      b *= 1.0 - smoothstep(uFogRange.x * 0.5, uFogRange.y * 1.2, d); // lost in the haze far out (and off the mountain)
      // separate rays, not a sheen: two scales of noise across the shafts (constant along each), cut into streaks
      // covering about a third of the air, drifting slowly
      float n = 0.65 * vnoise64(g * 0.06 + uGodOff) + 0.35 * vnoise64(g * 0.19 - uGodOff.yx * 2.0);
      b *= smoothstep(0.5, 0.74, n);
      gl_FragColor = vec4(uGodColor * b, 1.0);
      #include <colorspace_fragment>
    }
  `,
});
const slices = new THREE.Mesh(geo, mat);
slices.frustumCulled = false;
slices.renderOrder = 2.4; // before the far clock (2.5) and the clouds (3): beams come out from behind clouds, never over the digits

export const godRayLayer = new THREE.Group().add(slices);
godRayLayer.visible = false;

// ---------- per-frame update ----------
const fwd = new THREE.Vector3(), WARM = new THREE.Color(1, 0.88, 0.7);
const wrap = (x) => ((x % 64) + 64) % 64;

// How much god-ray weather it is: the sun up (strongest low), broken cumulus about, no deck, no rain.
export function godRayStrength(sunY, w = weather) {
  return smoothstep(sunY, 0.03, 0.12) * (1 - 0.6 * smoothstep(sunY, 0.3, 0.8))
    * smoothstep(w.cu + w.sc + w.fr, 0.15, 0.5) * (1 - 0.45 * smoothstep(w.cu + w.sc + w.fr, 0.9, 1.6)) * (1 - smoothstep(w.layer, 0.35, 0.75)) * (1 - smoothstep(w.rain, 0.01, 0.15));
}

// sceneSeconds = the scene clock (s), hours = the scene's time of day (0..24), dt = real seconds
// the map's corners: the nearest and farthest slice, both sides, cloud base and bottom (YS[1] = the base, per frame)
const ENDS = [SLICES[0][0], SLICES[SLICES.length - 1][0]], SIDES = [-1, 1], YS = [BOTTOM, 0];
export function updateGodRays(sceneSeconds, hours, camera, dt) {
  const a = uniforms.uSkySunDir.value, strength = godRayStrength(a.y) * GAIN;
  // the rays drift slowly along a fixed heading, straight from the scene clock (same picture for the same moment): tied
  // to the wind, t × wind (t ~ 1.8e9 s) turned the wind's first-frame jitter into a random offset every load
  const k = 0.3 * 0.06; // ~0.3 m/s × noise frequency
  off.set(wrap(sceneSeconds * k * 0.8), wrap(sceneSeconds * k * 0.6));
  godRayLayer.visible = strength > 0.002;
  if (!godRayLayer.visible) return;

  sun.set(a.x, Math.max(a.y, MIN_SUN), a.z);
  const sx = sun.x / sun.y, sz = sun.z / sun.y;
  camera.getWorldDirection(fwd);
  let fx = fwd.x, fz = fwd.z, fl = Math.sqrt(fx * fx + fz * fz);
  if (fl < 1e-3) { fx = 0; fz = -1; fl = 1; } // straight up or down: any heading
  fx /= fl; fz /= fl;
  const cx = camera.position.x, cz = camera.position.z, top = 60 + 30 * smoothstep(hours, 9, 15); // the cumulus base (clouds.js)
  view.set(cx, cz, fx, fz);
  U.uGodTop.value = YS[1] = top;
  const span = (U.uGodSpan.value = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect * SPAN);

  // the map covers every slice's shafts: the slices' footprint moved along the sun ray, bottom to top
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const D of ENDS) for (const side of SIDES) for (const y of YS) {
    const l = side * D * span, gx = cx + fx * D - fz * l - sx * y, gz = cz + fz * D + fx * l - sz * y;
    x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); z0 = Math.min(z0, gz); z1 = Math.max(z1, gz);
  }
  region.set((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2 + 10);
  rect.set(region.x - region.z, region.y - region.z, region.z * 2, region.z * 2);
  ratio.set(sx, sz);
  gateMat.uniforms.uRing.value.set(RINGS[0] / rect.z, RINGS[1] / rect.z);

  U.uGodColor.value.copy(uniforms.uSunColor.value).multiply(WARM).multiplyScalar(0.05 * strength);
}

// Draws the light map; main.js calls it once a frame after renderVolume (its weather maps) and before the scene renders
// (nothing while the rays are off).
export function renderGodRays(renderer) {
  if (!godRayLayer.visible) return;
  const before = renderer.getRenderTarget();
  renderTransmittance(renderer, trans, rect, ratio);
  renderer.setRenderTarget(target);
  renderer.render(mapScene, mapCam);
  renderer.setRenderTarget(before);
}
