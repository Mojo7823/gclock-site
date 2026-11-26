import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, heightAt, uniforms, glslCommon, MAX_TREES, EYE, EYE_HEIGHT, EYE_Y } from './common.js';
import { glslWind } from './wind.js';
import { castShadow } from './shadow.js';
import windrise from './shapes/windrise.js';
import knotwood from './shapes/knotwood.js';

// How the canopy avoids both "bad" looks from the reference:
//  - every leaf card is a billboard that always faces the camera, so the crown never loses volume
//    (no card is ever seen edge-on, no backface culling question at all);
//  - every card gets its normal from a smooth proxy shape (the crown's ellipsoid blended with its
//    clump's sphere), not from the card itself, so light and shade fall across the crown as one
//    soft form instead of per-card noise.

const UP = new THREE.Vector3(0, 1, 0);

// Wind in the trees: one smooth displacement field over the rest position, shared by limbs and leaves,
// so leaves stay on their limbs and gust fronts roll through a crown from upwind. The base stays put,
// the bend grows with height². tree = base xyz, height H (attribute aTree on bark and leaf cards; models.js uses it too).
export const glslSway = /* glsl */ `
vec2 treeSway(vec3 p, vec4 tree) {
  // a crown averages out the small puffs (~9 m long: half a puff apart they cancel; they only flutter the leaves), else it jitters in a gale
  float g = 0.5 * (windGust(p.xz) + windGust(p.xz - uWindDir * 4.5));
  float t = clamp((p.y - tree.y) / tree.w, 0.0, 1.2), ph = hash12(tree.xz) * 6.283;
  // metres at the top of a 10 m tree (drag ~ speed^1.5, x up to ~1.8 in a gust): 0.07 at 3 m/s, 0.27 at 7, 0.6 at 12, capped 0.9;
  // smaller plants bend by the same angle, bigger trees are stiffer
  float amp = min(0.0144 * pow(uWindStrength, 1.5), 0.9) * min(tree.w * 0.1, pow(tree.w * 0.1, 0.3));
  float along = 0.3 + 1.1 * g + 0.3 * (0.4 + g) * sin(uWindPhase + ph); // steady lean + gusts pressing it over + rocking back
  float across = 0.25 * g * sin(uWindPhase * 2.0 + ph);
  return (uWindDir * along + vec2(-uWindDir.y, uWindDir.x) * across) * amp * t * t;
}
`;

// Birch bark: warm grey, short dark dashes and blots.
const barkMat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, uColor: { value: new THREE.Color('#bdb5a8') }, uMark: { value: new THREE.Color('#3b3835') } },
  vertexShader: glslCommon + glslWind + glslSway + /* glsl */ `
    attribute vec4 aTree;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      wp.xz += treeSway(wp.xyz, aTree);
      vWorldPos = wp.xyz;
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    uniform vec3 uColor;
    uniform vec3 uMark;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vec3 n = normalize(vNormal);
      float ndl = dot(n, uSunDir), shadow = mix(0.5, 1.0, shadowAt(vWorldPos + n * 0.1)); // half shade under its crown
      vec2 q = vec2(dot(vWorldPos.xz, vec2(0.7)), vWorldPos.y); // seamless 'around' coordinate
      float mark = max(step(0.72, vnoise(q * vec2(12.0, 22.0))), step(0.72, vnoise(q * vec2(2.5, 1.2) + 17.0))); // dashes, blots
      float lit = toon(ndl, 0.08) * shadow;
      vec3 albedo = mix(uColor, uMark, mark);
      albedo = mix(albedo, uGround, 0.15 + 0.3 * (1.0 - lit)); // green bounce light from leaves and grass, stronger in shade
      gl_FragColor = vec4(applyFog(albedo * mix(uShadeColor, uSunColor, lit), vWorldPos), 1.0);
      #include <colorspace_fragment>
    }`,
});

// Leaf palettes (ref resources/tree-variant.jpg): base, sunlit side / top, deep inside. Layout key `leaf`.
// Lit by the shared light like everything else, so they follow the time of day.
export const LEAVES = {
  green: ['#7ea82f', '#c2d84a', '#3b5a22'],
  lime: ['#9cbb1c', '#d8e84a', '#526f18'],
  gold: ['#dca21c', '#ffd448', '#8c5810'],
  amber: ['#d2721c', '#f7a63c', '#843614'],
};

// Card sprites, one 256 px cell each in a row: the first three are grey (= per-leaf brightness, tinted with the LEAVES palette in
// the shader), the rest painted flowers for the converted plants (models.js). `leaves` = many small leaves in four clumps, for
// the big cards of the Windrise tree (the plain sprig on its ~2.5 m cards gives leaves twice the size of the other trees').
export const SPRITES = ['leaf', 'leaves', 'stem', 'lilac', 'blue', 'pod'];
const PAINTED = 3;

// A sprig of leaves around the origin: n leaves at radius r0..r0 + dr, len0..len0 + dlen long, grey brightness.
function sprig(g, seed, n, r0, dr, len0, dlen) {
  const rand = mulberry32(seed);
  const leaves = Array.from({ length: n }, () => ({ a: rand() * Math.PI * 2, r: r0 + rand() * dr, k: rand() }))
    .sort((p, q) => p.r - q.r); // inner leaves first, outer ones overlap them
  for (const { a, r, k } of leaves) {
    const len = len0 + k * dlen, wid = len * 0.42;
    const v = Math.round(255 * (0.55 + 0.45 * (r / (r0 + dr)) * (0.7 + 0.3 * rand()))); // outer leaves catch more light
    g.save();
    g.rotate(a);
    g.translate(r, 0);
    g.rotate((rand() - 0.5) * 0.9);
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.quadraticCurveTo(0, -wid, len / 2, 0);
    g.quadraticCurveTo(0, wid, -len / 2, 0);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fill();
    g.restore();
  }
}

let atlas;
function spriteTexture() {
  if (atlas) return atlas;
  const s = 256, cv = document.createElement('canvas');
  cv.width = s * SPRITES.length;
  cv.height = s;
  const g = cv.getContext('2d', { willReadFrequently: true }); // CPU-backed: a GPU reset would blank an accelerated canvas
  const cell = (name, draw) => { g.save(); g.translate(s * (SPRITES.indexOf(name) + 0.5), s / 2); draw(); g.restore(); };
  const ellipse = (x, y, rx, ry, a, fill) => { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); g.fill(); };
  const flower = (x, y, n, len, wid, fill, light, eye) => { // two tones per petal ring = the toon look
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ellipse(x + Math.cos(a) * len / 2, y + Math.sin(a) * len / 2, len / 2, wid / 2, a, fill); }
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ellipse(x + Math.cos(a) * len / 3, y + Math.sin(a) * len / 3, len / 4, wid / 4, a, light); }
    ellipse(x, y, len / 5, len / 5, 0, eye);
  };
  cell('leaf', () => sprig(g, 3, 22, 22, 66, 32, 22));
  cell('leaves', () => [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, y], i) => { g.save(); g.translate(x * 42, y * 42); sprig(g, 4 + i, 24, 4, 38, 18, 12); g.restore(); }));
  cell('stem', () => ellipse(0, 0, 100, 100, 0, '#3a3a3a'));
  cell('lilac', () => { // a cone of small florets (bellflower)
    const rand = mulberry32(5);
    for (let i = 0; i < 34; i++) {
      const t = rand(), y = 100 - t * 200, w = 70 * (1 - t) ** 0.7 + 12;
      flower((rand() * 2 - 1) * w, y, 4, 24, 18, '#a48fd8', '#d4c6f4', '#f6efff');
    }
  });
  cell('blue', () => [[-40, 30, 1], [38, 42, 0.85], [0, -40, 1.1]].forEach(([x, y, k]) => flower(x, y, 5, 56 * k, 42 * k, '#4f82dc', '#8db4f4', '#fff1a8'))); // shrub
  cell('pod', () => { // a round, papery seed pod on a stalk (stars)
    ellipse(0, 6, 78, 104, 0, '#c2a7bb');
    ellipse(-14, -10, 56, 76, -0.2, '#e2d1dc');
    g.strokeStyle = '#a58ea4';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(0, 110); g.quadraticCurveTo(-8, 0, 4, -92); g.stroke();
  });
  return (atlas = new THREE.CanvasTexture(cv));
}

// A tapered cylinder from a to b in world space; makeTrees merges all limbs into one mesh.
function limb(limbs, a, b, r0, r1) {
  const dir = b.clone().sub(a), len = dir.length();
  const geo = new THREE.CylinderGeometry(r1, r0, len, 12, 1, true).translate(0, len / 2, 0)
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize())).translate(a.x, a.y, a.z);
  limbs.push(geo);
}

function randomUnit(rand) {
  const z = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return new THREE.Vector3(s * Math.cos(a), z, s * Math.sin(a));
}

// Crown proportions relative to tree height H: where the leaves start, how tall and how wide. `model` = a converted model
// (shapes/*.js): its leaf cards join the canopy here, models.js draws its bark (the numbers then only place its ground
// shadow and the bark's crown shade; tools/models/convert.py prints them).
export const SHAPES = {
  round: { start: 0.22, height: 0.78, radius: 0.32 }, // egg crown on a short trunk (the step-1 tree)
  tall: { start: 0.5, height: 0.5, radius: 0.2 }, // long bare trunk, small high crown
  forked: { start: 0.3, height: 0.7, radius: 0.42 }, // trunk splits into big limbs, each with its own leaf mass
  bush: { start: 0, height: 1, radius: 0.6 }, // low dome from the ground up, no trunk
  giant: { start: 0.23, height: 0.57, radius: 0.87, model: windrise, sprite: 'leaves', dense: 1.3 }, // the one big tree: Windrise's 'Symbol of Mondstadt's Hero'
  knotwood: { start: 0.31, height: 0.6, radius: 0.36, model: knotwood, dense: 1.35, fill: 2 }, // Green Knotwood Tree (ginkgo leaves)
};

// Far crowns get fewer, bigger cards: at least 1/50 of their distance from the clock camera (~1.1°).
const CLOCK_CAMERA = new THREE.Vector3(EYE.x, EYE_HEIGHT, EYE.z), LOD = 0.02;

// Converted models (shapes/*.js): base64 arrays; positions and UVs are Uint16 inside a box [min..., max...] of n components.
export const unpack = (b64, Type) => new Type(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
export const unbox = (q, box, n = 3) => Float32Array.from(q, (v, i) => box[i % n] + (v / 65535) * (box[(i % n) + n] - box[i % n]));

// Where a model stands, for its bark (models.js) and its cards alike: sunk a little (roots and stems go into the ground;
// slopes), turned by the second value of its seed (the first is the bark's tone, models.js), scaled to the layout height,
// `width` on top of that across.
export function modelMatrix(t, H) {
  const rand = mulberry32(t.seed), s = t.height / H, w = s * (t.width ?? 1);
  rand();
  return new THREE.Matrix4().compose(new THREE.Vector3(t.x, heightAt(t.x, t.z) - 0.1 - 0.02 * t.height, t.z),
    new THREE.Quaternion().setFromAxisAngle(UP, rand() * 2 * Math.PI), new THREE.Vector3(w, s, w));
}

// A converted model's cards (one record per card of its leaf mesh: centre, size, transferred normal, occlusion, random, kind
// 0 leaf / 1 stem / 2 flower) placed by `matrix`, into `cards`. sprites = the SPRITES cell per kind. crown()'s LOD: far from
// the clock a model keeps (size / LOD size)² of its leaf cards, grown to the LOD size (at most maxSize), so its leaf cover
// stays the same; stems and flowers keep their size and stand upright. dense grows the leaf cards (a fuller crown); fill adds
// that many copies of each leaf card, scattered around it and pulled towards the crown's middle, darker as they go in (a
// sparse model's crown then reads as one mass with a shaded inside instead of sky between its cards).
export function shapeCards(cards, shape, matrix, rand, sprites, maxSize, dense = 1, fill = 0) {
  const d = shape.cards, centre = unbox(unpack(d.center, Uint16Array), d.box), nrm = unpack(d.normal, Int8Array), rec = unpack(d.card, Uint8Array);
  const scale = Math.cbrt(matrix.determinant()), toWorld = new THREE.Matrix3().getNormalMatrix(matrix), p = new THREE.Vector3(), n = new THREE.Vector3();
  const middle = new THREE.Vector3().fromArray(d.box).add(new THREE.Vector3().fromArray(d.box, 3)).multiplyScalar(0.5).applyMatrix4(matrix);
  const push = (q, size, angle, ao, sprite) => {
    cards.center.push(q.x, q.y, q.z);
    cards.normal.push(n.x, n.y, n.z);
    cards.card.push(size, angle, ao, rand());
    cards.sprite.push(sprite);
  };
  for (let i = 0; i < d.count; i++) {
    const [size8, ao8, rnd8, kind] = rec.subarray(i * 4, i * 4 + 4), own = (size8 / 255) * d.size * scale * (kind ? 1 : dense);
    p.fromArray(centre, i * 3).applyMatrix4(matrix);
    const size = kind ? own : Math.max(own, Math.min(p.distanceTo(CLOCK_CAMERA) * LOD, maxSize));
    if (rnd8 / 255 > (own / size) ** 2) continue;
    n.fromArray(nrm, i * 3).applyMatrix3(toWorld).normalize();
    push(p, size, kind ? (rand() - 0.5) * 0.6 : rand() * Math.PI * 2, ao8 / 255, sprites[kind]);
    for (let k = 0; k < (kind ? 0 : fill); k++) {
      const inward = 0.1 + 0.3 * rand();
      const q = p.clone().lerp(middle, inward).addScaledVector(randomUnit(rand), 0.45 * size);
      push(q, size * (0.7 + 0.25 * rand()), rand() * Math.PI * 2, (ao8 / 255) * (1 - 0.9 * inward), sprites[kind]);
    }
  }
}

// Crown radius at height fraction t: dome (flat bottom) or teardrop with a conical top.
function profileFn(radius, dome) {
  const [pa, pb] = dome ? [0.3, 0.5] : [0.4, 1];
  const shape = (t) => Math.pow(t, pa) * Math.pow(1 - t, pb), peak = shape(pa / (pa + pb));
  return (t) => radius * shape(t) / peak;
}

// One leaf mass: clumps hugging the profile, cards scattered over the clumps (appended to `cards`).
function crown(cards, rand, { x, z, bottom, height, radius, clumps, bush = false, dome = bush }) {
  const centre = new THREE.Vector3(x, bottom + height * 0.42, z);
  const axes = new THREE.Vector3(radius, height * 0.5, radius);
  const profile = profileFn(radius, dome);

  // Leaf clumps: spheres hugging the profile, some bulging out so the silhouette stays lumpy.
  const blobs = [];
  for (let i = 0; i < clumps; i++) {
    const t = 0.06 + 0.86 * (i + rand()) / clumps, r = profile(t);
    const br = r * (0.38 + 0.32 * rand()) + 0.3;
    const off = Math.max(0, r - br) * (0.85 + 0.5 * rand()), a = rand() * Math.PI * 2;
    blobs.push({ c: new THREE.Vector3(x + Math.cos(a) * off, bottom + t * height, z + Math.sin(a) * off), r: br });
  }

  const cardSize = Math.min(Math.max(bush ? 0.32 : radius * 0.234, centre.distanceTo(CLOCK_CAMERA) * LOD), radius * 0.6);
  const area = blobs.reduce((s, b) => s + b.r * b.r, 0), total = Math.round(132 * radius * height / cardSize ** 2); // same leaf density at any size
  for (const b of blobs) {
    const n = Math.round(total * b.r * b.r / area);
    for (let k = 0; k < n; k++) {
      const dir = randomUnit(rand);
      // most on the clump's skin, some fill the inside, a few stick out as sprigs
      const depth = rand() < 0.2 ? rand() : 0.8 + 0.32 * rand();
      const p = b.c.clone().addScaledVector(dir, b.r * depth);
      if (p.y < bottom - 0.3) continue;
      const local = p.clone().sub(centre).divide(axes);
      const normal = local.clone().divide(axes).normalize().lerp(dir, 0.65);
      if (bush) normal.y *= 0.5; // a low dome points mostly up and would turn all lime
      normal.normalize();
      // occlusion: dark deep inside the crown and towards its underside
      const ao = THREE.MathUtils.smoothstep(local.length(), 0.3, 1.0) * (0.6 + 0.4 * depth) * (0.75 + 0.25 * THREE.MathUtils.clamp((p.y - bottom) / height, 0, 1)) * (bush ? 0.7 : 1);
      cards.center.push(p.x, p.y, p.z);
      cards.normal.push(normal.x, normal.y, normal.z);
      cards.card.push(cardSize * (0.8 + 0.4 * rand()) * (depth > 1 ? 0.7 : 1), rand() * Math.PI * 2, ao, rand());
      cards.sprite.push(0);
    }
  }
}

// One tree (see SHAPES): limbs into `limbs`, leaf cards into `cards` (a model tree: placed by `matrix`). Returns its shadow sphere.
function growTree(base, H, rand, cards, limbs, type = 'round', matrix) {
  const s = SHAPES[type], bush = type === 'bush';
  const bottom = base.y + s.start * H, height = s.height * H, radius = s.radius * H;
  if (type === 'forked') {
    // the trunk splits low; every limb ends in its own smaller crown, the last one goes up the middle
    const fork = new THREE.Vector3(base.x, bottom, base.z);
    limb(limbs, base, fork, 0.032 * H, 0.024 * H);
    const n = 3 + Math.floor(rand() * 2);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.8, r = i === n ? 0 : radius * (0.5 + 0.2 * rand());
      const end = fork.clone().add(new THREE.Vector3(Math.cos(a) * r, height * (0.4 + 0.2 * rand()), Math.sin(a) * r));
      limb(limbs, fork, end, 0.018 * H, 0.007 * H);
      const sub = radius * (0.5 + 0.1 * rand());
      crown(cards, rand, { x: end.x, z: end.z, bottom: end.y - sub * 0.6, height: sub * 1.9, radius: sub, clumps: 7 });
    }
  } else if (s.model) {
    const leaf = SPRITES.indexOf(s.sprite ?? 'leaf');
    shapeCards(cards, s.model, matrix, rand, [leaf, leaf, leaf], radius * 0.6, s.dense, s.fill); // its bark: models.js
  } else {
    if (!bush) {
      const profile = profileFn(radius, false);
      limb(limbs, base, new THREE.Vector3(base.x, bottom + height * 0.55, base.z), 0.028 * H, 0.008 * H);
      for (let i = 0; i < 6; i++) {
        const t = 0.05 + 0.45 * rand(), a = rand() * Math.PI * 2, r = profile(t) * 0.5;
        const from = new THREE.Vector3(base.x, bottom + t * height * 0.6, base.z);
        limb(limbs, from, from.clone().add(new THREE.Vector3(Math.cos(a) * r, r * 0.8, Math.sin(a) * r)), 0.01 * H, 0.004 * H);
      }
    }
    crown(cards, rand, { x: base.x, z: base.z, bottom, height, radius, clumps: Math.round(10 + H), bush });
  }
  return new THREE.Vector4(base.x, bottom + height * 0.42, base.z, radius * 0.95);
}

// All leaf cards in one draw: `cards` = arrays per card (center xyz, normal xyz, card = size, angle, occlusion, random,
// tree = base xyz + height, leaf = LEAVES palette, sprite = SPRITES cell). models.js draws its plants with it too.
export function makeCanopy({ center, normal, card, tree, leaf, sprite }) {
  // The cards in a draw order (smallest `key` first). In the order they grew, a crown's hidden layers were textured and
  // shaded before nearer cards covered them; ordered, the depth test drops them first.
  const quad = new THREE.PlaneGeometry(1, 1), count = card.length / 4;
  const ordered = (key) => {
    const keys = new Float32Array(count).map((_, i) => key(i)), order = new Uint32Array(count).map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.index);
    geo.setAttribute('position', quad.getAttribute('position'));
    for (const [name, values, size] of [['aCenter', center, 3], ['aNormal', normal, 3], ['aCard', card, 4], ['aTree', tree, 4], ['aLeaf', leaf, 1], ['aSprite', sprite, 1]]) {
      const out = new Float32Array(count * size);
      for (let j = 0; j < count; j++) for (let k = 0; k < size; k++) out[j * size + k] = values[order[j] * size + k];
      geo.setAttribute(name, new THREE.InstancedBufferAttribute(out, size));
    }
    geo.instanceCount = count;
    return geo;
  };

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uLeafTex: { value: spriteTexture() },
      uLeaf: { value: Object.values(LEAVES).map((p) => new THREE.Color(p[0])) },
      uLeafTop: { value: Object.values(LEAVES).map((p) => new THREE.Color(p[1])) },
      uLeafDeep: { value: Object.values(LEAVES).map((p) => new THREE.Color(p[2])) },
    },
    vertexShader: glslCommon + glslWind + glslSway + /* glsl */ `
      attribute vec3 aCenter;
      attribute vec3 aNormal;
      attribute vec4 aCard; // size, angle, occlusion, random
      attribute vec4 aTree; // base xyz, height
      attribute float aLeaf; // palette
      attribute float aSprite; // SPRITES cell
      varying vec2 vUv;
      varying vec3 vNormal;
      varying float vAO;
      varying float vRand;
      varying float vLeaf;
      varying float vSprite;
      varying float vShadow; // cloud and tree shadows
      varying vec3 vFog0, vFog1;
      varying vec2 vLocal; // the card's corner offset in view space (-0.5..0.5), turned with it
      void main() {
        vec3 c = aCenter;
        c.xz += treeSway(c, aTree);
        // flutter: outer cards tremble a little in the lulls and twist hard where a gust is passing (so the front
        // shows rolling through the crown), none in still air
        float g = (0.15 + windGust(aCenter.xz)) * min(uWindStrength * 0.1, 1.5) * aCard.z;
        float f = sin(uWindPhase * 3.0 + aCard.w * 40.0);
        c += vec3(uWindDir.x, 0.6, uWindDir.y) * f * g * 0.08 * aCard.x;
        vec4 mv = viewMatrix * vec4(c, 1.0);
        float a = aCard.y + f * g * 0.3;
        vLocal = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
        mv.xy += vLocal * aCard.x; // billboard in view space
        gl_Position = projectionMatrix * mv;
        vUv = vec2((position.x + 0.5 + aSprite) / ${SPRITES.length}.0, position.y + 0.5);
        vSprite = aSprite;
        vNormal = aNormal;
        vAO = aCard.z;
        vRand = aCard.w;
        vLeaf = aLeaf;
        #ifndef SHADOW
        // per card, not per fragment (the canopy has heavy overdraw): cloud shadows are tens of metres wide, and haze and
        // mist hardly change across a card; applyFog is affine in the colour but for its wet saturation (done per fragment).
        // Tree shadows too, from the shadow map only (a blob would hold the whole crown): a card in a crown's shade, or
        // under another tree's, is shaded whole; looked up half a card toward the light, out of its own clump's shadow,
        // and only in part (the sunlit side of a crown keeps its lime highlights; at golden hour the long shadows of the
        // trees behind would dull the big tree's lit rim)
        vec2 m = mapShadow(c + uSunDir * (0.15 + 0.5 * aCard.x));
        vShadow = cloudShadow(c) * mix(1.0, m.y, mix(0.35, 0.8, smoothstep(0.15, 0.45, uSunDir.y)) * m.x * uShadowStrength);
        vFog0 = applyFog(vec3(0.0), c);
        vFog1 = applyFog(vec3(1.0), c) - vFog0;
        #endif
      }`,
    fragmentShader: glslCommon + /* glsl */ `
      #define LEAVES ${Object.keys(LEAVES).length}
      uniform sampler2D uLeafTex;
      uniform vec3 uLeaf[LEAVES];
      uniform vec3 uLeafTop[LEAVES];
      uniform vec3 uLeafDeep[LEAVES];
      varying vec2 vUv;
      varying vec3 vNormal;
      varying float vAO;
      varying float vRand;
      varying float vLeaf;
      varying float vSprite;
      varying float vShadow; // cloud and tree shadows
      varying vec3 vFog0, vFog1;
      varying vec2 vLocal;
      void main() {
        int i = int(vLeaf + 0.5);
        vec4 tex = texture2D(uLeafTex, vUv);
        if (tex.a < 0.5) discard; // hard cutout: crisp toon edges, no sorting (alpha-to-coverage left light seams)
        vec3 n = vNormal; // normalised per card
        bool painted = vSprite > ${PAINTED - 0.5};
        if (painted) { // flower heads are round: a sphere normal across the card gives each a lit and a shaded side
          vec2 q = vLocal * 2.0;
          n = normalize(mix(n, (vec4(q, sqrt(max(0.0, 1.0 - dot(q, q))), 0.0) * viewMatrix).xyz, 0.55)); // (0.75 lost the warm lit florets when backlit)
        }
        float grey = painted ? 0.75 : tex.r;
        // the leaf brightness nudges the terminator so the light/shade edge follows leaf shapes
        float lit = smoothstep(0.0, 0.12, dot(n, uSunDir) + (grey - 0.75) * 0.5) * vShadow;
        vec3 albedo = mix(uLeaf[i], uLeafTop[i], clamp(smoothstep(0.1, 0.8, n.y) * 0.55 + lit * 0.3, 0.0, 1.0)); // sunlit side and top turn yellow
        albedo = mix(uLeafDeep[i], albedo, vAO) * (0.8 + 0.25 * grey) * (0.94 + 0.12 * vRand);
        if (painted) albedo = pow(tex.rgb, vec3(2.2)) * mix(0.7, 1.05, vAO) * (0.94 + 0.12 * vRand); // flowers keep their colours (sRGB canvas)
        vec3 shade = mix(uShadeColor, uSunColor, 0.2); // less blue than the ground's shade, keeps the leaves olive
        vec3 col = albedo * mix(shade, uSunColor, lit);
        col = max(mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, 1.0 + 0.15 * uWet), 0.0); // applyFog's wet saturation
        gl_FragColor = vec4(col * vFog1 + vFog0, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // the view: near to far from the clock spot (the camera only turns there)
  const mesh = new THREE.Mesh(ordered((i) => Math.hypot(center[i * 3] - EYE.x, center[i * 3 + 1] - EYE_Y, center[i * 3 + 2] - EYE.z)), mat);
  // the same cut-out in the shadow map: leaf-shaped gaps (the cards face the light there). Its own copy, top down (the
  // light comes from above), drawn in the shadow pass only (layer 1, shadow.js)
  const shade = new THREE.Mesh(ordered((i) => -center[i * 3 + 1]), mat);
  mesh.frustumCulled = shade.frustumCulled = false; // cards are expanded in the shader
  castShadow(shade, `uniform sampler2D uLeafTex; varying vec2 vUv; void main() { if (texture2D(uLeafTex, vUv).a < 0.5) discard; }`);
  shade.layers.set(1);
  mesh.add(shade);
  return mesh;
}

// layout: [{ x, z, height, seed, type?, leaf?, width? }], type = a key of SHAPES (default 'round'), leaf = a key of
// LEAVES (default 'green'), width = horizontal scale of a model tree. The first MAX_TREES canopies are registered as ground-shadow casters.
export function makeTrees(layout) {
  const group = new THREE.Group();
  const cards = { center: [], normal: [], card: [], tree: [], leaf: [], sprite: [] }, limbs = [];
  layout.forEach((t, i) => {
    const model = SHAPES[t.type ?? 'round'].model, matrix = model && modelMatrix(t, model.height);
    const base = matrix ? new THREE.Vector3().setFromMatrixPosition(matrix) : new THREE.Vector3(t.x, heightAt(t.x, t.z) - 0.1, t.z);
    const n0 = cards.card.length / 4, l0 = limbs.length;
    const shadow = growTree(base, t.height, mulberry32(t.seed), cards, limbs, t.type, matrix);
    if (i < MAX_TREES) uniforms.uTrees.value[i].copy(shadow).setW(shadow.w * (t.width ?? 1));
    // tag its leaf cards and limbs with the tree (wind sway) and the palette
    const tag = [base.x, base.y, base.z, t.height], leaf = Object.keys(LEAVES).indexOf(t.leaf ?? 'green');
    for (let k = n0; k < cards.card.length / 4; k++) cards.tree.push(...tag), cards.leaf.push(leaf);
    for (const geo of limbs.slice(l0)) {
      geo.setAttribute('aTree', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 4).map((_, j) => tag[j % 4]), 4));
    }
  });
  const bark = new THREE.Mesh(mergeGeometries(limbs), barkMat);
  castShadow(bark);
  group.add(bark);
  uniforms.uTreeCount.value = Math.min(layout.length, MAX_TREES);
  group.add(makeCanopy(cards));
  return group;
}
