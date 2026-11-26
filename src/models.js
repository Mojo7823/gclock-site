import * as THREE from 'three';
import { mulberry32, uniforms, glslCommon } from './common.js';
import { glslWind } from './wind.js';
import { castShadow } from './shadow.js';
import { glslSway, LEAVES, SHAPES, SPRITES, unpack, unbox, modelMatrix, shapeCards, makeCanopy } from './tree.js';
import { trees, plants } from './layout.js';
import bellflower from './shapes/bellflower.js';
import shrub from './shapes/shrub.js';
import stars from './shapes/stars.js';

// The owner's 3D models, as shapes only: tools/models/convert.py turned them into public/src/shapes/*.js (the bark mesh and
// the foliage as leaf-card records; none of their textures). Everything is drawn with the scene's own shaders and sprites:
//  - the model trees (SHAPES types with a `model`): their leaf cards join tree.js's canopy; their bark is drawn here, one
//    InstancedMesh per model with an instance per layout entry, with the procedural brown bark below (the model's UVs are
//    only its around/along coordinates), two-tone light, cloud and tree shadows, treeSway, haze;
//  - the plants (`plants` in layout.js): their leaf, stem and flower cards in one more canopy (tree.js's sprites).
// The shapes are static imports, so everything is there from the first frame.
// Contract used by main.js and ui.js:
//   modelLayer            a Group added to the scene
//   modelsReady           a Promise, already resolved (kept for main.js's html[data-ready])
//   MODEL_CREDITS         [{ title, by, url, site }] for the credits panel
export const modelLayer = new THREE.Group();
export const modelsReady = Promise.resolve();

// shortcut: each model's own page on The Models Resource could not be looked up (the site refuses scripted requests),
// so every entry links the uploader's profile; put the page URLs in when someone has them.
export const MODEL_CREDITS = [
  'Symbol of Mondstadt\'s Hero (the Windrise tree)',
  'Green Knotwood Tree',
  'Like the Shimmering Distant Stars',
  'Bellflower Haze',
  'Flowering Shrub Amidst Harbor Mists',
].map((title) => ({ title, by: 'adverse56', url: 'https://models.spriters-resource.com/profile/adverse56/', site: 'https://models.spriters-resource.com' }));

// Bark plates (around the limb, ~0.55 m wide) and colours per model tree type: plate, fissure.
const PLATE = 0.55;
const BARK = { giant: ['#8a6242', '#33231a'], knotwood: ['#7f7466', '#2e2a25'] }; // the knotwood greyer

const vertexShader = glslCommon + glslWind + glslSway + /* glsl */ `
  attribute float aTone; // per instance
  uniform float uHeight; // model height in its own units
  uniform vec2 uTexel; // model units per UV unit along u (around the limb) and v (along it)
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vBark; // around in plates, along in metres, plates per UV unit
  varying float vAbove; // height above the base / tree height
  varying float vFoot; // metres above the base
  varying float vTone;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 tree = vec4(m[3].xyz, uHeight * length(m[1].xyz)); // base, height in metres (aTree of the procedural trees)
    vec4 wp = m * vec4(position, 1.0);
    vFoot = wp.y - tree.y;
    vAbove = vFoot / tree.w;
    // a whole number of plates per UV unit, so the pattern wraps where the model's UVs do
    float plates = max(2.0, floor(uTexel.x * length(m[0].xyz) / ${PLATE} + 0.5));
    vBark = vec3(uv.x * plates, uv.y * uTexel.y * length(m[1].xyz), plates);
    wp.xz += treeSway(wp.xyz, tree);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(m) * normal);
    vTone = aTone;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const fragmentShader = glslCommon + /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uMark;
  uniform float uCrown; // where the crown starts (fraction of the height): bark above it sits in its shade
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vBark;
  varying float vAbove;
  varying float vFoot;
  varying float vTone;
  // value noise wrapping with period n in x (around the limb: no seam)
  float pnoise(vec2 p, float n) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, n), x1 = mod(i.x + 1.0, n);
    return mix(mix(hash12(vec2(x0, i.y)), hash12(vec2(x1, i.y)), u.x), mix(hash12(vec2(x0, i.y + 1.0)), hash12(vec2(x1, i.y + 1.0)), u.x), u.y);
  }
  void main() {
    vec3 n = normalize(vNormal);
    float inCrown = smoothstep(uCrown - 0.1, uCrown + 0.05, vAbove);
    float ndl = dot(n, uSunDir), shadow = mix(0.5, 1.0, shadowAt(vWorldPos + n * 0.1)) * (1.0 - 0.7 * inCrown); // the trunk under the crown is shaded
    // plates between wandering fissures of varying width
    float x = vBark.x + 0.8 * (pnoise(vec2(vBark.x, vBark.y * 0.35), vBark.z) - 0.5) + 0.25 * (pnoise(vec2(vBark.x * 2.0, vBark.y * 1.3), vBark.z * 2.0) - 0.5);
    float id = mod(floor(x), vBark.z), tone = vnoise(vec2(id * 7.0, vBark.y * 0.4));
    float ridge = 1.0 - abs(fract(x) * 2.0 - 1.0); // 0 in a fissure, 1 on the crest of a plate
    float fissure = step(ridge, 0.03 + 0.14 * vnoise(vec2(id * 3.1, vBark.y * 1.2))) * 0.75;
    float lit = toon(ndl + 0.45 * (ridge - 0.5), 0.06) * shadow; // crests catch the light first: a ragged shade edge along the plates
    vec3 albedo = mix(uColor * (0.85 + 0.3 * tone) * (0.85 + 0.25 * ridge) * (1.0 + 0.2 * ridge * lit) * (0.94 + 0.12 * vTone), uMark, fissure);
    // moss: patchy at the foot and on top of the boughs
    float patches = vnoise(vec2(vBark.x * 0.7, vBark.y * 1.1) + 5.0);
    float moss = max(smoothstep(1.2, 0.3, vFoot) * step(0.45, patches), smoothstep(0.6, 0.85, n.y) * step(0.5, patches)) * (1.0 - fissure);
    albedo = mix(albedo, mix(uGround, uGrassTip, 0.3) * 0.75, moss);
    albedo = mix(albedo, uGround, 0.08 + 0.15 * (1.0 - lit)); // a little green bounce
    vec3 shade = mix(uShadeColor, uSunColor * vec3(0.8, 0.72, 0.62), 0.35) * (1.0 - 0.35 * inCrown); // warm: brown in blue shade turned grey
    gl_FragColor = vec4(applyFog(albedo * mix(shade, uSunColor, lit), vWorldPos), 1.0);
    #include <colorspace_fragment>
  }`;

function barkGeometry(b) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(unbox(unpack(b.position, Uint16Array), b.box), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(unpack(b.normal, Int8Array), 3, true));
  geo.setAttribute('uv', new THREE.BufferAttribute(unbox(unpack(b.uv, Uint16Array), b.uvBox, 2), 2));
  geo.setIndex(new THREE.BufferAttribute(unpack(b.index, Uint16Array), 1));
  return geo;
}

// model trees: bark, one InstancedMesh per model (their leaf cards are in tree.js's canopy)
const byModel = new Map();
for (const t of trees) {
  const type = t.type ?? 'round';
  if (SHAPES[type].model) byModel.set(type, [...(byModel.get(type) ?? []), t]);
}
for (const [type, list] of byModel) {
  const shape = SHAPES[type].model, [color, mark] = BARK[type];
  const geo = barkGeometry(shape.bark);
  geo.setAttribute('aTone', new THREE.InstancedBufferAttribute(Float32Array.from(list, (t) => mulberry32(t.seed)()), 1));
  const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uColor: { value: new THREE.Color(color) },
      uMark: { value: new THREE.Color(mark) },
      uHeight: { value: shape.height },
      uTexel: { value: new THREE.Vector2(...shape.bark.texel) },
      uCrown: { value: SHAPES[type].start },
    },
    vertexShader,
    fragmentShader,
  }), list.length);
  list.forEach((t, i) => mesh.setMatrixAt(i, modelMatrix(t, shape.height)));
  mesh.name = `${type}-bark`;
  castShadow(mesh);
  modelLayer.add(mesh);
}

// plants: cards only; SPRITES per card kind (leaf, stem, flower)
const PLANTS = { bellflower: [bellflower, 'lilac'], shrub: [shrub, 'blue'], stars: [stars, 'pod'] };
const cards = { center: [], normal: [], card: [], tree: [], leaf: [], sprite: [] }, green = Object.keys(LEAVES).indexOf('green');
for (const p of plants) {
  const [shape, flower] = PLANTS[p.type], matrix = modelMatrix(p, shape.height), n0 = cards.card.length / 4;
  shapeCards(cards, shape, matrix, mulberry32(p.seed + 1), ['leaf', 'stem', flower].map((s) => SPRITES.indexOf(s)), 0.6 * p.height, 1.15);
  const base = new THREE.Vector3().setFromMatrixPosition(matrix);
  for (let k = n0; k < cards.card.length / 4; k++) cards.tree.push(base.x, base.y, base.z, p.height), cards.leaf.push(green);
}
modelLayer.add(makeCanopy(cards));
