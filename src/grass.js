import * as THREE from 'three';
import { mulberry32, heightAt, valueNoise, clearance, riverEdge, uniforms, glslCommon } from './common.js';
import { glslWind } from './wind.js';
import { onSetting } from './settings.js';

// Blades from one root, [sideways lean, height] each (fractions of the blade height), `seg` segments
// each, the last one a single tip triangle. Near: one blade. Far: a tuft of three thin ones (single
// wide blades looked like little pine trees from across the river).
function bladeGeometry(seg, blades) {
  const pos = [], idx = [];
  for (const [lean, top] of blades) {
    const b = pos.length / 3;
    for (let i = 0; i < seg; i++) { const t = i / seg, w = 0.5 * (1 - t); pos.push(-w, t * top, lean * t, w, t * top, lean * t); }
    pos.push(0, top, lean);
    for (let i = 0; i < seg - 1; i++) { const a = b + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    idx.push(b + (seg - 1) * 2, b + (seg - 1) * 2 + 1, b + seg * 2);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

const bank = (x, z) => 0.2 + 0.8 * THREE.MathUtils.smoothstep(riverEdge(x, z), 4, 20); // shorter down the river bank, so the water shows over it

// Blades fill a wedge in front of the camera at `origin` (x, z): dense close up, sparse far away,
// where the ground colour underneath takes over. `avoid`: [x, z, radius] circles left bare (rocks).
// A second, sparser patch of bigger three-blade tufts (`farCount`) carries on from 40 m to `far`, across
// the river and up the valley side, so the far bank isn't bare painted ground. Returns a group of both.
export function makeGrass({ count = 100000, farCount = 20000, seed = 7, origin = [0, 11], radius = 48, far = 120, avoid = [] } = {}) {
  const rand = mulberry32(seed);
  const offsets = new Float32Array(count * 3), params = new Float32Array(count * 4);
  for (let i = 0; i < count;) {
    const x = origin[0] + (rand() * 2 - 1) * radius, z = origin[1] - rand() * radius;
    const dx = x - origin[0], dz = origin[1] - z, d = Math.hypot(dx, dz);
    if (d < 1 || d > radius || Math.abs(dx) > dz * 2.6) continue;
    const clear = clearance(x, z, avoid);
    if (clear === 0 || rand() > Math.min(1, Math.max(0.1, 1.3 - d / 25))) continue;
    const fade = Math.min(1, (radius - d) / 8); // shrink blades at the rim so the edge doesn't show
    const tall = 0.7 + 0.6 * valueNoise(x * 0.15, z * 0.15);
    offsets.set([x, heightAt(x, z) - 0.03, z], i * 3);
    params.set([
      rand() * Math.PI * 2, // rotation
      0.09 * (1 + d / 20) * (0.8 + 0.4 * rand()), // width, wider far away to keep coverage
      1.05 * tall * fade * (0.3 + 0.7 * clear) * (0.7 + 0.6 * rand()) * bank(x, z), // height, short next to rocks and down the bank
      rand(),
    ], i * 4);
    i++;
  }

  // Far patch: an even spread over distance (uniform d and angle = density ~1/d per m², roughly constant
  // on screen as the blades widen), growing in where the near rim shrinks and fading out before `far`.
  const farOffsets = new Float32Array(farCount * 3), farParams = new Float32Array(farCount * 4), farUp = new Float32Array(farCount * 3);
  for (let i = 0; i < farCount;) {
    const d = radius - 8 + rand() * (far - radius + 8), a = (rand() * 2 - 1) * Math.atan(2.6); // same wedge as above
    const x = origin[0] + Math.sin(a) * d, z = origin[1] - Math.cos(a) * d;
    const clear = clearance(x, z, avoid);
    if (clear === 0) continue;
    const fade = Math.min(1, (d - radius + 8) / 8, (far - d) / 15);
    const tall = 0.7 + 0.6 * valueNoise(x * 0.15, z * 0.15);
    farOffsets.set([x, heightAt(x, z) - 0.1, z], i * 3);
    const nx = heightAt(x - 1, z) - heightAt(x + 1, z), nz = heightAt(x, z - 1) - heightAt(x, z + 1), n = Math.hypot(nx, 2, nz);
    farUp.set([nx / n, 2 / n, nz / n], i * 3); // lit like the slope under it: at golden hour the far bank faces away from the sun
    farParams.set([
      Math.atan2(origin[0] - x, origin[1] - z) + (rand() - 0.5) * 1.2, // roughly facing the camera: most coverage per blade
      0.04 * (1 + d / 20) * (0.8 + 0.4 * rand()),
      0.9 * tall * fade * (0.3 + 0.7 * clear) * (0.7 + 0.6 * rand()) * bank(x, z),
      rand(),
    ], i * 4);
    i++;
  }

  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: glslCommon + glslWind + /* glsl */ `
      attribute vec3 aOffset;
      attribute vec4 aParams; // rotation, width, height, random
      attribute vec3 aUp; // ground normal the blade is lit with
      varying float vT;
      varying float vRand;
      varying float vSheen;
      varying float vLit;
      varying vec3 vWorldPos;
      void main() {
        float t = position.y, h = aParams.z;
        vec3 p = vec3(position.x * aParams.y + position.z * h, t * h, t * t * h * (0.2 + 0.35 * aParams.w)); // tuft lean, natural curve
        float s = sin(aParams.x), c = cos(aParams.x);
        vec3 wp = aOffset + vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
        vec2 bend = windBend(aOffset.xz, t, h, aParams.w);
        wp.xz += bend;
        wp.y -= length(bend) * 0.3 * t;
        vT = t;
        vRand = aParams.w;
        vLit = toon(dot(aUp, uSunDir), 0.1);
        vSheen = smoothstep(0.35, 1.0, windGust(aOffset.xz)) * min(uWindStrength / 8.0, 1.0); // gusts press the blades over: a lighter wave rolls across
        vWorldPos = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: glslCommon + /* glsl */ `
      varying float vT;
      varying float vRand;
      varying float vSheen;
      varying float vLit;
      varying vec3 vWorldPos;
      void main() {
        // root matches the ground (slightly darker = occlusion), tip fades to a bright yellow-green
        vec3 tip = uGrassTip * mix(vec3(0.82, 0.95, 0.8), vec3(1.05, 1.0, 0.85), vRand) // some blades greener, some yellower
                 * (0.85 + 0.3 * vnoise(vWorldPos.xz * 0.25)); // and clumps of lighter / darker grass
        vec3 root = groundColor(vWorldPos.xz) * 0.5;
        root = mix(root, mix(root, uGrassTip, 0.62), smoothstep(25.0, 60.0, distance(vWorldPos, cameraPosition))); // far away the roots take the painted ground's colour (terrain.js): no dark gaps
        vec3 col = mix(root, tip, smoothstep(0.0, 1.15, vT));
        col *= 1.0 + 0.3 * vSheen * vT; // bent blades turn their lit faces up: sheen on the tips
        // lit like the ground it grows from (near: up normal) so the field reads as one smooth surface
        float lit = vLit * shadowAt(vWorldPos);
        col *= mix(uShadeColor, uSunColor, lit);
        gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // A patch draws its blades near to far (the camera stays at `origin`), so the depth test drops the blades hidden behind
  // nearer ones before they are shaded. `thin(f)` keeps the first f of the blades made: each is an independent random draw
  // from the same spread, so any first n thin the whole field evenly (the Quality setting).
  const patch = (offsets, params, up, geo) => {
    const n = params.length / 4, d = new Float32Array(n).map((_, i) => Math.hypot(offsets[i * 3] - origin[0], offsets[i * 3 + 2] - origin[1]));
    const order = new Uint32Array(n).map((_, i) => i).sort((a, b) => d[a] - d[b]);
    const attrs = [['aOffset', offsets, 3], ['aUp', up, 3], ['aParams', params, 4]].map(([name, from, size]) => {
      const to = new THREE.InstancedBufferAttribute(new Float32Array(from.length), size);
      geo.setAttribute(name, to);
      return [from, to, size];
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // blades are placed in the shader; the geometry bounds don't know about them
    mesh.userData.thin = (f) => {
      const keep = Math.round(n * THREE.MathUtils.clamp(f, 0, 1));
      let k = 0;
      for (const i of order) {
        if (i >= keep) continue;
        for (const [from, to, size] of attrs) for (let c = 0; c < size; c++) to.array[k * size + c] = from[i * size + c];
        k++;
      }
      for (const [, to] of attrs) to.needsUpdate = true;
      geo.instanceCount = keep;
    };
    return mesh;
  };
  const group = new THREE.Group().add(
    patch(offsets, params, new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), bladeGeometry(4, [[0, 1]])),
    patch(farOffsets, farParams, farUp, bladeGeometry(2, [[-0.45, 0.75], [0.05, 1], [0.5, 0.8]])),
  );
  group.children[1].renderOrder = 0.5; // the far patch after the trees that stand in front of it (before the mountain, 1)
  onSetting('quality.grass', (f) => { for (const m of group.children) m.userData.thin(f); });
  return group;
}
