import * as THREE from 'three';
import { uniforms } from './common.js';
import { settings } from './settings.js';

// Tree shadows from a shadow map: one orthographic depth pass from the active light (the sun, the moon at night) every
// other frame, so leaf-shaped shadows sway with the wind. It covers the part of the scene seen up close from the clock (the
// meadow, the near bank, the river and the big tree across it); common.js's treeShadow() samples it there and keeps the
// blob shadows beyond. Casters (castShadow) draw with their own vertex shader (the same sway and billboards) compiled
// with SHADOW defined, layer 1 picks them out of the scene. No pass with 'quality.shadows' off or no shadows to show.
// Contract used by main.js: renderShadows(renderer, scene) once a frame, before the scene renders.
const SIZE = 2048; // ~4 cm a texel over the region
const REGION = [new THREE.Vector3(-40, -4.5, -72), new THREE.Vector3(40, 26, 14)]; // receivers seen in detail (box, m)
const REACH = 120; // casters this far toward the light from the region still count (long shadows at golden hour, m)
const BIAS = 0.03; // depth bias for plain receivers (m); casters that receive add a normal offset

const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { format: THREE.RedFormat }); // the colour is never written
target.depthTexture = new THREE.DepthTexture(SIZE, SIZE, THREE.UnsignedIntType);
target.depthTexture.compareFunction = THREE.LessEqualCompare; // + its default linear filter = hardware 2x2 PCF

const camera = new THREE.OrthographicCamera();
camera.layers.set(1);
camera.up.set(0, 0, -1); // never parallel to the light (its elevation is kept >= 8.6 deg below)
const corners = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(REGION[i & 1].x, REGION[(i >> 1) & 1].y, REGION[i >> 2].z));
const v = new THREE.Vector3(), toUv = new THREE.Matrix4();

// mesh casts with its own material's vertex shader; fragmentShader only for cut-outs (leaf cards). Meshes sharing a
// material share the depth material.
const casters = [], depthMats = new Map();
export function castShadow(mesh, fragmentShader = 'void main() {}') {
  const m = mesh.material;
  if (!depthMats.has(m)) {
    depthMats.set(m, new THREE.ShaderMaterial({ uniforms: m.uniforms, vertexShader: m.vertexShader, fragmentShader, side: m.side, colorWrite: false, defines: { SHADOW: '' } }));
  }
  mesh.layers.enable(1);
  casters.push([mesh, m, depthMats.get(m)]);
}

// The light camera fitted tightly around REGION, seen along the light; its size changes in 2 m steps and it moves in
// whole texels, so still shadow edges don't crawl as the sun moves.
function fit() {
  camera.position.copy(uniforms.uSunDir.value);
  camera.position.y = Math.max(camera.position.y, 0.15); // the light stays above the ground (strength fades it out there)
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const c of corners) {
    v.copy(c).applyMatrix4(camera.matrixWorldInverse);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
  }
  const w = Math.ceil((x1 - x0) / 2) * 2, h = Math.ceil((y1 - y0) / 2) * 2, tx = w / SIZE, ty = h / SIZE;
  camera.left = Math.floor((x0 + x1 - w) / 2 / tx) * tx;
  camera.right = camera.left + w;
  camera.bottom = Math.floor((y0 + y1 - h) / 2 / ty) * ty;
  camera.top = camera.bottom + h;
  camera.near = -z1 - REACH;
  camera.far = -z0 + 10;
  camera.updateProjectionMatrix();
  // clip space -> map uv and depth (0..1), minus the bias
  toUv.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5 - BIAS / (camera.far - camera.near), 0, 0, 0, 1);
  uniforms.uShadowMatrix.value.multiplyMatrices(toUv, camera.projectionMatrix).multiply(camera.matrixWorldInverse);
}

let n = 0, wasOn = false;
export function renderShadows(renderer, scene) {
  const on = settings['quality.shadows'] && uniforms.uShadowStrength.value > 0.005;
  uniforms.uShadowMapOn.value = on ? 1 : 0;
  const start = on && !wasOn; // just switched on: draw now, the map may be from another time
  wasOn = on;
  // every other frame, between the cloud maps' (cloudvolume.js): its 2048² cut-out leaves are the costliest pass on a
  // phone, and the dapples still sway 30 times a second
  if (++n % 2 && !start && uniforms.uShadowMap.value) return;
  if (!on && uniforms.uShadowMap.value) return;
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  if (on) {
    fit();
    for (const c of casters) c[0].material = c[2];
    renderer.render(scene, camera);
    for (const c of casters) c[0].material = c[1];
  } else renderer.clear(); // a first frame with the map off still allocates it: a shadow sampler on a bare texture fails every draw
  renderer.setRenderTarget(before);
  uniforms.uShadowMap.value = target.depthTexture;
}
