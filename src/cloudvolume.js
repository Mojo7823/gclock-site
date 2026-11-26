import * as THREE from 'three';
import { uniforms, MOUNTAIN, DECK_BASE, heightAt } from './common.js';
import { weather } from './weather.js';

// Volumetric clouds (docs/CLOUDS.md). clouds.js decides where every cloud is (from the scene clock) and hands its puffs
// in as blobs; this module turns them into a density field and ray-marches it:
// 1. Weather maps: every blob is drawn from above into a map with MAX blending, so each texel holds the union of the
//    blobs over it: coverage, top height, base height (stored as 1 - base), darkness. Three maps: the heap clouds
//    (cumulus, towers, banks), the lumpy stratocumulus layer and the scud, so a cloud over another is never merged
//    with it into one column (scud under a cumulus stood as a pillar).
// 2. Density at a point = the map's coverage inside its [base, top] band, eroded by a tiling 3D Perlin-Worley noise (the
//    billows) and a finer Worley noise on the surface, plus a sheet deck (weather.layer) and the cap on the summit.
// 3. The march (half resolution, jittered every frame, accumulated over frames): Beer-Lambert extinction along the view,
//    a short light march toward the sun or moon for self-shadowing, multiple-scattering octaves and a forward phase
//    lobe (light passing through thin cloud, silver linings), sky light from above, ground bounce from below.
// 4. A sun transmittance map on the ground plane (the same density marched along the sun ray): cloud-shaped shadows
//    on the land (cloudShadow in common.js) and the god rays (godrays.js).

export const SLAB = { lo: 8, hi: 290 }; // the cloud layer's floor and ceiling (m)
const MAP = { x0: -1150, z0: -1250, w: 2300, h: 2050, size: 1024 }; // weather maps: world rect (m) and texels
const MAXD = 1100; // the march ends this far out (the far deck goes on in the sky dome)
const NOISE = 64; // noise texture size (texels per side, tiling)
// world size of one tile of the noise (m): billows, surface detail, deck patches
const PERIOD = { shape: 64, detail: 19, deck: 900 };
const MAX_BLOBS = 6000;
const DENSITY = 0.5; // extinction per metre at density 1 (this sky is ~1/15 scale: real clouds' ~0.03-0.1, scaled up)
const MIN_SUN = 0.12; // the shadow map projects with the sun at least this high (a dawn sun sent it kilometres out)
const SHADOW_SIZE = 512;
const f1 = (v) => v.toFixed(1);

// Ground heights (hills, the mountain range, the big peak), baked once from heightAt: the march stops at the land
// and the summit's cap hugs the rock. shortcut: 5 m cells (narrower crags are missed) over the land in front of the camera.
const GROUND = { x0: -480, x1: 480, z0: -460, z1: 40, step: 5 };
function groundTexture() {
  const { x0, x1, z0, z1, step } = GROUND, w = (x1 - x0) / step + 1, h = (z1 - z0) / step + 1, data = new Uint16Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = THREE.DataUtils.toHalfFloat(heightAt(x0 + i * step, z0 + j * step));
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  // rect: world xz -> texture coordinates (samples sit on texel centres)
  return { tex, rect: new THREE.Vector4(x0 - step / 2, z0 - step / 2, 1 / (w * step), 1 / (h * step)) };
}
export const groundHeights = groundTexture();

// ---------- shared GLSL ----------
const glslHead = /* glsl */ `
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
`;
const glslQuadVert = glslHead + /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// The density field, shared by the march, the light march, the shadow map and the reflection's cheap version.
const glslDensity = /* glsl */ `
uniform sampler2D uMapL;  // low clouds: coverage, top, 1 - base, darkness
uniform sampler2D uMapS;  // stratocumulus layer, same channels
uniform sampler2D uMapF;  // scud (fractus), same channels
uniform vec4 uMapRect;    // x0, z0, 1 / width, 1 / depth (m)
uniform sampler3D uNoise; // R Perlin-Worley, G/B/A Worley fbm at 4/8/16 cells per tile
uniform sampler2D uGroundH;
uniform vec4 uGroundRect;
uniform vec3 uOffShape;   // noise drift (m), wrapped to each tile
uniform vec3 uOffDetail;
uniform vec2 uOffDeck;
uniform vec4 uDeck;       // sheet deck: cover, base, top (m), darkness
uniform vec4 uCap;        // the summit's cap: amount, swirl angle (rad), greyness, -
const float LO = ${f1(SLAB.lo)}, HI = ${f1(SLAB.hi)};
const vec3 PEAK = vec3(${f1(MOUNTAIN.x)}, ${f1(MOUNTAIN.y)}, ${f1(MOUNTAIN.z)});

float remap01(float v, float a, float b) { return clamp((v - a) / (b - a), 0.0, 1.0); }
float groundAt(vec2 xz) {
  vec2 uv = (xz - uGroundRect.xy) * uGroundRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -100.0;
  return texture(uGroundH, uv).r;
}
// The field of a column from b to t with coverage cov: the nearest of the horizontal coverage and the vertical
// distance to the domed top (soft, ~a third of the column) and to the base (over soft metres: firm for the flat
// base of a heap cloud, the weight of it; soft for the deck's underside), so the surfaces the erosion carves follow
// the domes instead of extruding one cross-section up the whole column.
float field(float y, float cov, float b, float t, float soft, out float hf) {
  float h = t - b;
  hf = clamp((y - b) / max(h, 1.0), 0.0, 1.0);
  if (h < 1.0) return 0.0;
  return clamp(min(cov, min((t - y) / clamp(0.35 * h, 4.0, 16.0), (y - b) / soft)), 0.0, 1.0);
}
// the sheet deck at xz: cover, and how far its base and top swell up or down (m): a textured underside, not a slab
vec3 deckAt(vec2 xz) {
  if (uDeck.x < 0.01) return vec3(0.0);
  vec4 n = texture(uNoise, vec3((xz + uOffDeck) / ${f1(PERIOD.deck)}, 0.37).xzy);
  float v = 0.6 * n.r + 0.4 * n.g;
  return vec3(smoothstep(1.0 - uDeck.x - 0.15, 1.0 - uDeck.x + 0.25, v) * smoothstep(0.0, 0.3, uDeck.x), (n.b - 0.5) * 24.0, (n.a - 0.5) * 24.0);
}
float deckCover(vec2 xz) { return deckAt(xz).x; }
// the cap: a band of cloud hugging the rock under the summit
float capAt(vec3 p, out float h) {
  h = 0.5;
  if (uCap.x < 0.01 || p.y < PEAK.y - 54.0 || p.y > PEAK.y - 2.0) return 0.0;
  vec2 r = p.xz - PEAK.xz;
  if (dot(r, r) > 110.0 * 110.0) return 0.0;
  float above = p.y - groundAt(p.xz);
  h = (p.y - PEAK.y + 52.0) / 48.0;
  return uCap.x * smoothstep(PEAK.y - 52.0, PEAK.y - 40.0, p.y) * smoothstep(PEAK.y - 3.0, PEAK.y - 13.0, p.y)
    * smoothstep(-4.0, 1.0, above) * smoothstep(19.0, 6.0, above);
}

// density (0 none .. 1) at p, or -1 outside every cloud's band (the march may take a long step there); dark =
// greyness, hf = height in the cloud (0 base .. 1 top)
float cloudAt(vec3 p, bool detail, out float dark, out float hf) {
  dark = 0.0; hf = 0.5;
  if (p.y < LO || p.y > HI) return 0.0;
  vec2 uv = (p.xz - uMapRect.xy) * uMapRect.zw;
  vec4 a = texture(uMapL, uv), s = texture(uMapS, uv), f = texture(uMapF, uv);
  float hA, hS, hF, hD, hC;
  float cA = a.r > 0.0 ? field(p.y, a.r, mix(LO, HI, 1.0 - a.b), mix(LO, HI, a.g), 2.5, hA) : 0.0;
  float cS = s.r > 0.0 ? field(p.y, s.r, mix(LO, HI, 1.0 - s.b), mix(LO, HI, s.g), 2.5, hS) : 0.0;
  float cF = f.r > 0.0 ? field(p.y, f.r, mix(LO, HI, 1.0 - f.b), mix(LO, HI, f.g), 2.5, hF) : 0.0;
  float cD = 0.0;
  if (uDeck.x > 0.01 && p.y > uDeck.y - 12.0 && p.y < uDeck.z + 12.0) {
    vec3 dk = deckAt(p.xz);
    cD = field(p.y, dk.x, uDeck.y + dk.y, uDeck.z + dk.z, 8.0, hD);
  }
  float cC = capAt(p, hC);
  float cov = max(max(max(cA, cS), cF), max(cD, cC));
  if (cov < 0.01) return -1.0; // outside every cloud's band: the march may take a long step
  // the strongest layer here shapes it
  vec3 q = p + uOffShape;
  if (cov == cC) { // the cap churns round the peak
    hf = hC; dark = uCap.z;
    float an = uCap.y * (1.0 + 0.6 * hC), c = cos(an), sn = sin(an);
    vec2 r = p.xz - PEAK.xz;
    q = vec3(PEAK.x + r.x * c - r.y * sn, p.y, PEAK.z + r.x * sn + r.y * c) + uOffShape * 0.3;
  } else {
    if (cov == cA) { hf = hA; dark = a.a; }
    else if (cov == cS) { hf = hS; dark = s.a; }
    else if (cov == cF) { hf = hF; dark = f.a; }
    else { hf = hD; dark = uDeck.w; }
    // soft contact with the land (not for the cap, which hugs the rock): a low cloud thins out over the last 10 m
    // above a hill instead of being sliced by it along the land's 5 m grid
    if (detail && p.y < 200.0) {
      float g = groundAt(p.xz);
      cov *= smoothstep(g, g + 10.0, p.y);
    }
  }
  vec4 n = texture(uNoise, q / ${f1(PERIOD.shape)});
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = smoothstep(0.3, 0.9, remap01(n.r, fbm - 1.0, 1.0)); // Perlin-Worley sculpted by the Worley fbm: round billows
  // erode the edges: thin coverage survives only where the billows are; the base erodes least (flat bottoms),
  // the top most (cauliflower tops). A steep ramp past the threshold: crisp billowed outlines, not a soft fade
  float d = clamp((cov - (1.0 - shape) * mix(0.55, 0.9, hf)) * 3.0, 0.0, 1.0);
  if (detail && d > 0.0 && d < 0.9) {
    vec4 m = texture(uNoise, (p + uOffDetail) / ${f1(PERIOD.detail)});
    float w = m.g * 0.625 + m.b * 0.25 + m.a * 0.125;
    // wispy torn bottoms, round bulging tops
    d = clamp((d - mix(1.0 - w, w, clamp(hf * 3.0, 0.0, 1.0)) * 0.4) * 2.0, 0.0, 1.0);
  }
  return d;
}
`;

// ---------- noise texture (generated once on the GPU) ----------
const noiseRT = new THREE.WebGL3DRenderTarget(NOISE, NOISE, NOISE, { depthBuffer: false });
Object.assign(noiseRT.texture, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
const noiseMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uZ: { value: 0 } },
  depthTest: false,
  depthWrite: false,
  vertexShader: glslQuadVert,
  fragmentShader: glslHead + /* glsl */ `
    uniform float uZ;
    in vec2 vUv;
    out vec4 outColor;
    vec3 hash33(vec3 p) {
      p = fract(p * vec3(0.1031, 0.1030, 0.0973));
      p += dot(p, p.yxz + 33.33);
      return fract((p.xxy + p.yxx) * p.zyx);
    }
    // 1 at a cell's point, falling off with distance; tiles every per cells
    float worley(vec3 p, float per) {
      vec3 i = floor(p), f = fract(p);
      float d = 1.0;
      for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(x, y, z), r = g + hash33(mod(i + g, per)) - f;
        d = min(d, dot(r, r));
      }
      return 1.0 - sqrt(d);
    }
    float gradAt(vec3 i, vec3 f, vec3 o, float per) { return dot(hash33(mod(i + o, per)) * 2.0 - 1.0, f - o); }
    float perlin(vec3 p, float per) {
      vec3 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      return mix(mix(mix(gradAt(i, f, vec3(0, 0, 0), per), gradAt(i, f, vec3(1, 0, 0), per), u.x),
                     mix(gradAt(i, f, vec3(0, 1, 0), per), gradAt(i, f, vec3(1, 1, 0), per), u.x), u.y),
                 mix(mix(gradAt(i, f, vec3(0, 0, 1), per), gradAt(i, f, vec3(1, 0, 1), per), u.x),
                     mix(gradAt(i, f, vec3(0, 1, 1), per), gradAt(i, f, vec3(1, 1, 1), per), u.x), u.y), u.z);
    }
    void main() {
      vec3 p = vec3(vUv, uZ);
      float pf = 0.0, amp = 0.5, fr = 4.0;
      for (int o = 0; o < 5; o++) { pf += amp * perlin(p * fr, fr); fr *= 2.0; amp *= 0.5; }
      pf = clamp(pf * 1.1 + 0.5, 0.0, 1.0);
      float w4 = worley(p * 4.0, 4.0), w8 = worley(p * 8.0, 8.0), w16 = worley(p * 16.0, 16.0), w32 = worley(p * 32.0, 32.0);
      float wf = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
      float pw = clamp((pf - (wf - 1.0)) / (2.0 - wf), 0.0, 1.0); // Perlin-Worley: remap(perlin, worley fbm - 1, 1, 0, 1)
      outColor = vec4(pw, wf, w8 * 0.625 + w16 * 0.25 + w32 * 0.125, w16 * 0.75 + w32 * 0.25);
    }`,
});

// ---------- fullscreen passes ----------
const quadGeo = new THREE.PlaneGeometry(2, 2);
const passCam = new THREE.Camera();
const pass = (material) => {
  const mesh = new THREE.Mesh(quadGeo, material);
  mesh.frustumCulled = false;
  return new THREE.Scene().add(mesh);
};
const noiseScene = pass(noiseMat);

// ---------- weather maps (blobs drawn from above) ----------
const mapOpts = { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
// half float: tops and bases in 8 bits stepped every 1.1 m, drawn as contour lines on smooth domes
const weatherOpts = { ...mapOpts, type: THREE.HalfFloatType };
const mapL = new THREE.WebGLRenderTarget(MAP.size, MAP.size, weatherOpts), mapS = new THREE.WebGLRenderTarget(MAP.size, MAP.size, weatherOpts);
const mapF = new THREE.WebGLRenderTarget(MAP.size, MAP.size, weatherOpts);
const mapRect = new THREE.Vector4(MAP.x0, MAP.z0, 1 / MAP.w, 1 / MAP.h);
const blobGeo = new THREE.InstancedBufferGeometry();
blobGeo.index = new THREE.PlaneGeometry(1, 1).index;
blobGeo.setAttribute('position', new THREE.PlaneGeometry(1, 1).getAttribute('position'));
const blobAttr = (name, size) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLOBS * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  blobGeo.setAttribute(name, a);
  return a;
};
const aBlob = blobAttr('aBlob', 4), aBlob2 = blobAttr('aBlob2', 4), aDark = blobAttr('aDark', 1);
blobGeo.instanceCount = 0;
const blobMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uMapRect: { value: mapRect }, uLayer: { value: 0 } },
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  vertexShader: glslHead + /* glsl */ `
    in vec3 position;
    in vec4 aBlob;  // x, z, horizontal radius (m), layer (0 heap clouds, 1 stratocumulus, 2 scud)
    in vec4 aBlob2; // centre height, vertical radius, flat base (-1e4: its own rounded bottom), coverage
    in float aDark;
    uniform vec4 uMapRect;
    uniform float uLayer;
    out vec2 vQ;
    out vec4 vB;
    out float vDark;
    void main() {
      vQ = position.xy * 2.0;
      vB = aBlob2;
      vDark = aDark;
      vec2 uv = (aBlob.xy + vQ * aBlob.z - uMapRect.xy) * uMapRect.zw;
      gl_Position = aBlob.w == uLayer ? vec4(uv * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    }`,
  fragmentShader: glslHead + /* glsl */ `
    in vec2 vQ;
    in vec4 vB;
    in float vDark;
    out vec4 outColor;
    void main() {
      float q2 = dot(vQ, vQ);
      if (q2 >= 1.0) discard;
      // a mound: the sphere's top in the middle, falling on past its equator to its bottom at the rim with no cliff
      // (a sphere's own column, or a mound with a steep rim, stood as a wall over the puffs below it: stacked ledges)
      float h = vB.y * (1.0 - 2.0 * q2);
      float top = vB.x + h, bottom = vB.z > -1e3 ? vB.z : vB.x - h;
      const float LO = ${f1(SLAB.lo)}, HI = ${f1(SLAB.hi)};
      outColor = vec4(vB.w * (1.0 - q2 * q2), clamp((top - LO) / (HI - LO), 0.0, 1.0), clamp(1.0 - (bottom - LO) / (HI - LO), 0.0, 1.0), vDark);
    }`,
});
const blobScene = new THREE.Scene().add(Object.assign(new THREE.Mesh(blobGeo, blobMat), { frustumCulled: false }));

// The MAX union leaves a crease wherever one puff's mound takes over from another's (stacked turret puffs: rings,
// read as stripes once self-shadowed). A small blur rounds them into smooth shoulders, and a puff's rim (its own
// bottom included: anvils, scud) into a soft edge instead of the map's texel steps.
const blurTmp = new THREE.WebGLRenderTarget(MAP.size, MAP.size, weatherOpts);
const blurMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
  depthTest: false,
  depthWrite: false,
  vertexShader: glslQuadVert,
  fragmentShader: glslHead + /* glsl */ `
    uniform sampler2D uSrc;
    uniform vec2 uStep; // one texel along the blur
    in vec2 vUv;
    out vec4 outColor;
    // 9 Gaussian taps (0.2270 centre; 0.1945, 0.1216, 0.0540, 0.0162 out to 4 texels) read as 5: each pair of neighbours
    // in one linear-filtered fetch between them, weighted by the pair's sum
    void main() {
      vec4 s = 0.2270 * texture(uSrc, vUv);
      s += 0.3161 * (texture(uSrc, vUv + 1.3846 * uStep) + texture(uSrc, vUv - 1.3846 * uStep));
      s += 0.0702 * (texture(uSrc, vUv + 3.2308 * uStep) + texture(uSrc, vUv - 3.2308 * uStep));
      outColor = s;
    }`,
});
const blurScene = pass(blurMat);
function blurMap(renderer, map) {
  for (const [src, dst, x, y] of [[map, blurTmp, 1, 0], [blurTmp, map, 0, 1]]) {
    blurMat.uniforms.uSrc.value = src.texture;
    blurMat.uniforms.uStep.value.set(x / MAP.size, y / MAP.size);
    renderer.setRenderTarget(dst);
    renderer.render(blurScene, passCam);
  }
}
let blobN = 0;

// clouds.js: beginBlobs() and addBlob(...) per puff on the frames the maps are drawn (mapsDue), then updateVolume every frame
export function beginBlobs() { blobN = 0; }
// layer 0 heap clouds / 1 stratocumulus / 2 scud; x, z centre, r horizontal radius, y centre height, rv vertical radius,
// flat = base height of a flat-bottomed cloud (or -1e4: rounded bottom), cov = coverage 0..1, dark = greyness
export function addBlob(layer, x, z, r, y, rv, flat, cov, dark) {
  if (blobN >= MAX_BLOBS) return;
  const i = blobN * 4;
  const b = aBlob.array, b2 = aBlob2.array;
  b[i] = x; b[i + 1] = z; b[i + 2] = r; b[i + 3] = layer;
  b2[i] = y; b2[i + 1] = rv; b2[i + 2] = flat; b2[i + 3] = cov;
  aDark.array[blobN] = dark;
  blobN++;
}

// ---------- the density uniforms (shared by every pass) ----------
const offShape = new THREE.Vector3(), offDetail = new THREE.Vector3(), offDeck = new THREE.Vector2();
const D = {
  uMapL: { value: mapL.texture }, uMapS: { value: mapS.texture }, uMapF: { value: mapF.texture }, uMapRect: { value: mapRect },
  uNoise: { value: noiseRT.texture },
  uGroundH: { value: groundHeights.tex }, uGroundRect: { value: groundHeights.rect },
  uOffShape: { value: offShape }, uOffDetail: { value: offDetail }, uOffDeck: { value: offDeck },
  uDeck: { value: new THREE.Vector4() }, uCap: { value: new THREE.Vector4(1, 0, 0, 0) },
};

// ---------- sun transmittance (cloud shadows on the land, god rays) ----------
// A map on the ground plane: texel g holds how much sunlight gets through the clouds along the sun ray from (g, 0)
// up, and from 60 / 120 / 180 m up (RGBA), so a hillside or the summit is shadowed only by the clouds above it.
// A point p looks up g = p.xz - sun.xz / sun.y * p.y.
const transMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { ...D, uRegion: { value: new THREE.Vector4() }, uSunRatio: { value: new THREE.Vector2() } },
  depthTest: false,
  depthWrite: false,
  vertexShader: glslQuadVert,
  fragmentShader: glslHead + glslDensity + /* glsl */ `
    uniform vec4 uRegion;   // x0, z0, width, depth (m)
    uniform vec2 uSunRatio; // sun.xz / sun.y
    in vec2 vUv;
    out vec4 outColor;
    void main() {
      vec2 g = uRegion.xy + vUv * uRegion.zw;
      const int N = 36;
      float dy = (HI - LO) / float(N), seg = dy * length(vec3(uSunRatio.x, 1.0, uSunRatio.y));
      float od = 0.0, od60 = 0.0, od120 = 0.0, od180 = 0.0, dk, hk;
      for (int i = 0; i < N; i++) {
        float y = LO + (float(i) + 0.5) * dy;
        float d = max(cloudAt(vec3(g + uSunRatio * y, y).xzy, false, dk, hk), 0.0) * seg;
        od += d;
        if (y < 60.0) od60 += d;
        if (y < 120.0) od120 += d;
        if (y < 180.0) od180 += d;
      }
      float e = ${(DENSITY * 0.3).toFixed(3)}; // softer than the view: light scattered through and around a cloud still reaches the land
      outColor = exp(-e * vec4(od, od - od60, od - od120, od - od180));
    }`,
});
const transScene = pass(transMat);
const sunRatio = new THREE.Vector2();
// renders the sun transmittance over region (x0, z0, width, depth) with the sun at ratio (sun.xz / sun.y) into target
// (godrays.js has its own region and sun clamp)
export function renderTransmittance(renderer, target, region, ratio) {
  transMat.uniforms.uRegion.value.copy(region);
  transMat.uniforms.uSunRatio.value.copy(ratio);
  renderer.setRenderTarget(target);
  renderer.render(transScene, passCam);
}
const shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, mapOpts);
const shadowRegion = new THREE.Vector4(), shadowSun = new THREE.Vector3();
uniforms.uCloudShadowMap.value = shadowRT.texture;

// ---------- the march ----------
const traceOpts = { count: 2, type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
const traceRT = new THREE.WebGLRenderTarget(1, 1, traceOpts); // colour (premultiplied, linear) + distance
const history = [new THREE.WebGLRenderTarget(1, 1, traceOpts), new THREE.WebGLRenderTarget(1, 1, traceOpts)];
const L = { // the light on the clouds (updateVolume)
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color() },
  uAmbTop: { value: new THREE.Color() }, uAmbBottom: { value: new THREE.Color() },
  uFogColor: uniforms.uFogColor, uFlash: uniforms.uFlash, uFlashPos: uniforms.uFlashPos, uFlashLight: uniforms.uFlashLight,
};
const cam = { // the camera of this frame (renderVolume)
  uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
};
const glslRay = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
vec3 rayDir(vec2 uv) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
}
`;
const traceMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { ...D, ...L, ...cam, uFrame: { value: 0 } },
  depthTest: false,
  depthWrite: false,
  vertexShader: glslQuadVert,
  fragmentShader: glslHead + glslDensity + glslRay + /* glsl */ `
    uniform vec3 uKeyDir;    // toward the sun (or the moon at night)
    uniform vec3 uKeyColor;
    uniform vec3 uAmbTop;    // sky light from above
    uniform vec3 uAmbBottom; // the shaded side and light bounced up from the land
    uniform vec3 uFogColor;
    uniform float uFlash;
    uniform vec3 uFlashPos;
    uniform vec4 uFlashLight; // lightning.js: sky-wide glow, ground channel lit, radius of the lit cloud, out of the sheet
    uniform float uFrame;
    in vec2 vUv;
    layout(location = 0) out vec4 outColor;
    layout(location = 1) out vec4 outDepth;
    // Henyey-Greenstein, scaled so isotropic scattering is 1
    float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
    // a strong forward lobe (light through the cloud toward the viewer, silver linings) and a soft back lobe
    float phase(float c, float k) { return mix(hg(c, 0.6 * k), hg(c, -0.25 * k), 0.3); }
    // optical depth toward the light: 6 growing steps (~80 m, started at a jittered offset: no contour bands), plus
    // the deck overhead if the light comes through it
    float lightDepth(vec3 p, float j) {
      float od = 0.0, s = 1.0 * (0.5 + j), dk, hk;
      vec3 q = p;
      for (int i = 0; i < 10; i++) { q += uKeyDir * s; od += max(cloudAt(q, false, dk, hk), 0.0) * s; s *= 1.5; }
      if (uDeck.x > 0.01 && p.y < uDeck.y && uKeyDir.y > 0.05) {
        float mid = 0.5 * (uDeck.y + uDeck.z);
        od += deckCover(p.xz + uKeyDir.xz * (mid - p.y) / uKeyDir.y) * (uDeck.z - uDeck.y) * 0.6 / max(uKeyDir.y, 0.2);
      }
      return od;
    }
    void main() {
      vec3 ro = uCamPos, rd = rayDir(vUv);
      float t0 = 0.0, t1 = ${f1(MAXD)};
      if (abs(rd.y) > 1e-4) {
        float ta = (LO - ro.y) / rd.y, tb = (HI - ro.y) / rd.y;
        t0 = max(min(ta, tb), 0.0);
        t1 = min(max(ta, tb), t1);
      } else if (ro.y < LO || ro.y > HI) t1 = 0.0;
      vec3 col = vec3(0.0);
      float T = 1.0, tFirst = -1.0, tHalf = -1.0;
      if (t1 > t0) {
        // a fresh random start per pixel and frame (interleaved gradient noise shifted per frame left blocky steps
        // along edges once accumulated)
        vec3 hq = fract(vec3(gl_FragCoord.xy, uFrame) * vec3(0.1031, 0.1030, 0.0973));
        hq += dot(hq, hq.yzx + 33.33);
        float jitter = fract((hq.x + hq.y) * hq.z);
        float cosT = dot(rd, uKeyDir);
        float t = t0 + jitter * max(1.2, 0.009 * t0);
        // long steps through clear air (0.03 t: ~150 steps to the horizon); on reaching a cloud's band, back up over the
        // last long step and walk in finely, so its front surface isn't skipped (fine steps everywhere ran out of
        // steps under rain scud before reaching the deck: holes in it)
        float back = 0.0, tFine = -1.0;
        for (int i = 0; i < 256; i++) {
          if (t > t1 || T < 0.01) break;
          float ds = max(1.2, 0.009 * t); // about a pixel or two of the march at any distance
          vec3 p = ro + rd * t;
          if (p.y < 200.0 && p.y < groundAt(p.xz)) break; // into the land: the rest is hidden
          float dark, hf, d = cloudAt(p, true, dark, hf);
          if (d < 0.0 && t > tFine) { back = max(4.0, 0.03 * t); t += back; continue; }
          if (back > 0.0) { tFine = t; t -= back; back = 0.0; continue; }
          if (d < 0.0) { t += ds; continue; }
          if (d > 0.002) {
            if (tFirst < 0.0) tFirst = t;
            float od = lightDepth(p, fract(jitter + float(i) * 0.618)), e = ${DENSITY.toFixed(3)};
            // multiple scattering: each octave goes deeper (less extinction), softer and less directional, so the
            // shaded side keeps a soft light instead of going black, and a deck glows grey-white from below like an
            // overcast sky (sum normalised: unshadowed ~ the light's colour)
            float direct = 0.0, a = 1.0, b = 1.0, c = 1.0;
            for (int o = 0; o < 4; o++) { direct += a * exp(-od * e * b) * phase(cosT, c); a *= 0.75; b *= 0.2; c *= 0.6; }
            direct /= 1.0 + 0.2 * direct; // a soft knee: thin cloud right by the sun glows, not a flat white cut-out
            float albedo = 1.0 - dark * mix(0.8, 0.35, hf); // rain clouds: dark bases, tops still catch light
            vec3 amb = mix(uAmbBottom, uAmbTop, smoothstep(0.0, 1.0, hf)) * (1.0 - 0.45 * dark);
            // under the deck the sky light is the deck's grey, not blue
            float under = p.y < uDeck.y ? deckCover(p.xz) : 0.0;
            amb = mix(amb, vec3(dot(amb, vec3(0.3, 0.59, 0.11))), 0.7 * under);
            vec3 li = albedo * (uKeyColor * direct * 0.45 + amb);
            // lightning lights its cloud from inside, the whole sky glows, a ground channel lights the bases from below
            float inside = 1.0 - smoothstep(0.5, 1.4, distance(p, uFlashPos) / uFlashLight.z);
            float below = (1.0 - hf) * (1.0 - smoothstep(30.0, 250.0, distance(p.xz, uFlashPos.xz)));
            li += vec3(0.55, 0.6, 0.75) * (uFlash * inside * 2.0 + uFlashLight.x * 0.45 + uFlashLight.y * below * 0.8);
            float tr = exp(-d * e * ds);
            col += T * li * (1.0 - tr);
            T *= tr;
            if (tHalf < 0.0 && T < 0.5) tHalf = t;
          }
          t += ds;
        }
      }
      float dist = tHalf > 0.0 ? tHalf : tFirst > 0.0 ? tFirst : ${f1(MAXD)};
      // low and distant clouds melt into the haze (near the horizon either way: from a dev camera above them too)
      float haze = max(1.0 - smoothstep(0.0, 0.1, abs(rd.y)), smoothstep(350.0, 1000.0, dist) * 0.6) * 0.55;
      col = mix(col, uFogColor * (1.0 - T), haze);
      outColor = vec4(col, 1.0 - T);
      outDepth = vec4(dist, 0.0, 0.0, 1.0);
    }`,
});
const traceScene = pass(traceMat);

// temporal accumulation: this frame's jittered march blended into the reprojected history, clamped to the
// neighbourhood of this frame (no ghosts when the clouds or the view change fast)
const resolveMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    ...cam, uCur: { value: null }, uCurDepth: { value: null }, uHist: { value: null }, uHistDepth: { value: null },
    uPrevViewProj: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uReset: { value: 1 },
  },
  depthTest: false,
  depthWrite: false,
  vertexShader: glslQuadVert,
  fragmentShader: glslHead + glslRay + /* glsl */ `
    uniform sampler2D uCur;
    uniform sampler2D uCurDepth;
    uniform sampler2D uHist;
    uniform sampler2D uHistDepth;
    uniform mat4 uPrevViewProj;
    uniform vec2 uTexel;
    uniform float uReset;
    in vec2 vUv;
    layout(location = 0) out vec4 outColor;
    layout(location = 1) out vec4 outDepth;
    void main() {
      // the neighbourhood's mean and spread (variance clipping: a min/max box clamp left square steps along edges)
      vec4 c = texture(uCur, vUv), m1 = vec4(0.0), m2 = vec4(0.0);
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec4 n = texture(uCur, vUv + vec2(x, y) * uTexel);
        m1 += n; m2 += n * n;
      }
      m1 /= 9.0;
      vec4 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0)), lo = m1 - 1.25 * sd, hi = m1 + 1.25 * sd;
      float dist = texture(uCurDepth, vUv).r;
      vec4 pc = uPrevViewProj * vec4(uCamPos + rayDir(vUv) * dist, 1.0);
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      bool ok = uReset < 0.5 && pc.w > 0.0 && puv.x >= 0.0 && puv.y >= 0.0 && puv.x <= 1.0 && puv.y <= 1.0;
      vec4 h = clamp(texture(uHist, puv), lo, hi);
      outColor = ok ? mix(h, c, 0.15) : c;
      outDepth = vec4(dist, 0.0, 0.0, 1.0);
    }`,
});
const resolveScene = pass(resolveMat);

// ---------- composite: the clouds in the scene ----------
// A fullscreen quad in the transparent pass (after the sun, moon, cirrus, god rays and far clock, before rain): the
// accumulated clouds, with the depth of each pixel's cloud, so trees and the land in front hide them crisply.
// Seen in the river's mirror (another camera), a cheap flat version of the same maps instead.
const comp = {
  uCloudTex: { value: null }, uCloudDist: { value: null }, uMode: { value: 0 },
  uProj: { value: new THREE.Matrix4() }, uInvProjC: { value: new THREE.Matrix4() }, uInvViewport: { value: new THREE.Vector2() },
};
const compMat = new THREE.ShaderMaterial({
  uniforms: { ...D, ...L, ...comp },
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  vertexShader: /* glsl */ `
    uniform mat4 uInvProjC;
    varying vec3 vView;
    varying vec3 vWorldDir;
    void main() {
      vec4 v = uInvProjC * vec4(position.xy, 1.0, 1.0);
      vView = v.xyz / v.w;
      vWorldDir = (inverse(viewMatrix) * vec4(vView, 0.0)).xyz;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: glslDensity + /* glsl */ `
    uniform sampler2D uCloudTex;
    uniform sampler2D uCloudDist;
    uniform float uMode; // 0 = the main camera, 1 = the river's mirror
    uniform mat4 uProj;
    uniform vec2 uInvViewport;
    uniform vec3 uKeyColor;
    uniform vec3 uAmbTop;
    uniform vec3 uAmbBottom;
    uniform vec3 uFogColor;
    varying vec3 vView;
    varying vec3 vWorldDir;
    void main() {
      vec4 c;
      float dist;
      vec3 vd = normalize(vView);
      if (uMode < 0.5) {
        vec2 uv = gl_FragCoord.xy * uInvViewport;
        c = texture(uCloudTex, uv);
        dist = texture(uCloudDist, uv).r;
      } else {
        // mirror: where the ray meets the middle of the cloud layer, the maps' cover there, softly lit
        vec3 rd = normalize(vWorldDir);
        if (rd.y < 0.02) discard;
        dist = min((110.0 - cameraPosition.y) / rd.y, 1000.0);
        vec2 xz = cameraPosition.xz + rd.xz * dist, uv = (xz - uMapRect.xy) * uMapRect.zw;
        vec4 a = texture(uMapL, uv), s = texture(uMapS, uv), f = texture(uMapF, uv);
        float cov = smoothstep(0.1, 0.5, max(max(max(a.r, s.r), f.r), deckCover(xz)));
        vec3 col = mix(uAmbBottom, uAmbTop, 0.6) * (1.0 - 0.5 * max(a.a, uDeck.w)) + uKeyColor * 0.35;
        col = mix(col, uFogColor, 1.0 - smoothstep(0.02, 0.15, rd.y));
        c = vec4(col * cov, cov);
      }
      if (c.a < 0.003) discard;
      vec4 clip = uProj * vec4(vd * dist, 1.0);
      gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
      // encode to sRGB first, then premultiply: encoding an already-premultiplied colour makes thin edges glow
      gl_FragColor = vec4(linearToOutputTexel(vec4(c.rgb / c.a, 1.0)).rgb * c.a, c.a);
    }`,
});
const compMesh = new THREE.Mesh(quadGeo, compMat);
compMesh.frustumCulled = false;
compMesh.renderOrder = 3; // after the sun/moon (1), the cirrus dome (2), the god rays (2.4), far clock (2.5) and rain shafts (2.6)
let mainCamera = null;
const viewport = new THREE.Vector4();
compMesh.onBeforeRender = (renderer, scene, camera) => {
  comp.uMode.value = camera === mainCamera ? 0 : 1;
  comp.uProj.value.copy(camera.projectionMatrix);
  comp.uInvProjC.value.copy(camera.projectionMatrixInverse);
  renderer.getCurrentViewport(viewport);
  comp.uInvViewport.value.set(1 / viewport.z, 1 / viewport.w);
  compMat.uniformsNeedUpdate = true;
};
export const volumeLayer = new THREE.Group().add(compMesh);

// ---------- per frame ----------
const { smoothstep } = THREE.MathUtils;
const wrap = (v, p) => ((v % p) + p) % p;
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const tmpColor = new THREE.Color(), GREY = new THREE.Color(0.5, 0.5, 0.5);
let drift = null, driftT = 0; // metres the clouds' air has moved along the wind aloft (double precision, then wrapped)

// t = scene time (s), aloft = the wind up there (unit xz, clouds.js), capGrey = the cap's greyness
export function updateVolume(t, aloft, capGrey) {
  blobGeo.instanceCount = blobN;
  for (const a of [aBlob, aBlob2, aDark]) {
    a.clearUpdateRanges();
    a.addUpdateRange(0, blobN * a.itemSize);
    a.needsUpdate = true;
  }
  // the billows ride the wind with the clouds (~0.6 m/s, cumulus speed) and rise slowly (convection); integrated, so a
  // turn of the wind never slides them; from the scene clock at the start
  if (drift === null) drift = [aloft.x * t * 0.6, aloft.y * t * 0.6];
  else { const dt = THREE.MathUtils.clamp(t - driftT, -600, 600); drift[0] += aloft.x * dt * 0.6; drift[1] += aloft.y * dt * 0.6; }
  driftT = t;
  const up = t * 0.04;
  offShape.set(wrap(-drift[0], PERIOD.shape), wrap(-up, PERIOD.shape), wrap(-drift[1], PERIOD.shape));
  offDetail.set(wrap(-drift[0] * 1.1, PERIOD.detail), wrap(-up * 2, PERIOD.detail), wrap(-drift[1] * 1.1, PERIOD.detail));
  offDeck.set(wrap(-drift[0] * 0.8, PERIOD.deck), wrap(-drift[1] * 0.8, PERIOD.deck));
  // the deck: over the summit (common.js DECK_BASE; lightning out of the sheet starts in it), thicker the darker it is
  // (rain, storm)
  const dk = weather.layerDark;
  D.uDeck.value.set(weather.layer, DECK_BASE, DECK_BASE + 28 + 30 * dk, Math.min(0.95, 0.15 + 0.8 * dk));
  D.uCap.value.set(1, wrap(t * 0.004, Math.PI * 2), capGrey, 0);

  // key light: the sun, or the moon when it is the brighter (the other adds to the sky light)
  const sun = uniforms.uSkySunColor.value, moon = uniforms.uSkyMoonColor.value, sunUp = lum(sun) >= lum(moon);
  L.uKeyDir.value.copy(sunUp ? uniforms.uSkySunDir.value : uniforms.uSkyMoonDir.value);
  L.uKeyColor.value.copy(sunUp ? sun : moon).multiplyScalar(1.25);
  const other = sunUp ? moon : sun;
  // sky light from above (between the zenith and the horizon colour), and from below: the shade colour plus the
  // light bounced off the meadow
  L.uAmbTop.value.copy(uniforms.uZenithColor.value).lerp(uniforms.uFogColor.value, 0.4).multiplyScalar(0.95).add(tmpColor.copy(other).multiplyScalar(0.3));
  L.uAmbBottom.value.copy(uniforms.uFogColor.value).lerp(uniforms.uShadeColor.value, 0.5).multiplyScalar(0.6)
    .add(tmpColor.copy(uniforms.uGround.value).lerp(GREY, 0.5).multiply(sun).multiplyScalar(0.2));

  // the shadow map: over the land in front of the camera and the mountain, cast along the sun (held at least MIN_SUN high)
  const s = uniforms.uSunDir.value, sy = Math.max(s.y, MIN_SUN);
  sunRatio.set(s.x / sy, s.z / sy);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of [[-480, -460], [480, -460], [-480, 60], [480, 60]]) for (const y of [0, MOUNTAIN.y]) {
    const gx = x - sunRatio.x * y, gz = z - sunRatio.y * y;
    x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); z0 = Math.min(z0, gz); z1 = Math.max(z1, gz);
  }
  shadowRegion.set(x0, z0, x1 - x0, z1 - z0);
  shadowSun.set(sunRatio.x, sunRatio.y, smoothstep(s.y, 0.02, 0.1)); // to the uniforms with the map it was drawn for (renderVolume)
}

let noiseReady = false, frame = 0, tick = 0, cur = 0, reset = true, watching = false;
const size = new THREE.Vector2(), viewProj = new THREE.Matrix4(), prevViewProj = new THREE.Matrix4(), clearColor = new THREE.Color();
// true before a frame whose renderVolume draws the weather maps (clouds.js lays its puffs out for those)
export const mapsDue = () => tick % 2 === 0;
// main.js, every frame before anything samples the cloud shadows: weather maps, shadow map, march, accumulation
export function renderVolume(renderer, camera) {
  const before = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.setClearColor(0x000000, 0);
  if (!watching) { // a lost and restored context comes back with empty render targets: build the noise again
    renderer.domElement.addEventListener('webglcontextrestored', () => { noiseReady = false; reset = true; });
    watching = true;
  }
  if (!noiseReady) {
    for (let z = 0; z < NOISE; z++) {
      noiseMat.uniforms.uZ.value = (z + 0.5) / NOISE;
      renderer.setRenderTarget(noiseRT, z);
      renderer.render(noiseScene, passCam);
    }
    noiseReady = true;
  }
  // the weather maps and the cloud shadows every other frame (the tree shadow map takes the frames between, shadow.js):
  // clouds drift far less than a 2 m texel a frame, and a phone pays for these passes at any screen size
  const turn = tick++ % 2 === 0;
  if (turn) {
    for (const [target, layer] of [[mapL, 0], [mapS, 1], [mapF, 2]]) {
      blobMat.uniforms.uLayer.value = layer;
      renderer.setRenderTarget(target);
      renderer.render(blobScene, passCam);
      blurMap(renderer, target);
    }
    uniforms.uCloudShadowRect.value.set(shadowRegion.x, shadowRegion.y, 1 / shadowRegion.z, 1 / shadowRegion.w);
    uniforms.uCloudShadowSun.value.copy(shadowSun);
    if (shadowSun.z > 0) renderTransmittance(renderer, shadowRT, shadowRegion, sunRatio);
  }

  // half the CSS resolution (a quarter at the Resolution setting's 0.5x), at most ~0.5 MP
  mainCamera = camera;
  renderer.getDrawingBufferSize(size);
  const pr = renderer.getPixelRatio(), k = Math.min(0.5 * Math.min(pr, 1) / pr, Math.sqrt(5.2e5 / (size.x * size.y)));
  const w = Math.max(1, Math.round(size.x * k)), h = Math.max(1, Math.round(size.y * k));
  if (traceRT.width !== w || traceRT.height !== h) {
    for (const rt of [traceRT, ...history]) rt.setSize(w, h);
    reset = true;
  }
  camera.updateMatrixWorld();
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  // The march on those frames too while the view stands still: the picture it lays over the screen changes by ~0.14/255
  // a frame (measured: 99% of its pixels under 2/255), and it is the costliest pass on a weak GPU. A view that turns or
  // zooms (the picture is as marched: it would lag the scene), a lightning flash and new buffers march at once.
  const flash = uniforms.uFlash.value + uniforms.uFlashLight.value.x + uniforms.uFlashLight.value.y > 0;
  if (turn || reset || flash || !viewProj.equals(prevViewProj)) {
    cam.uInvProj.value.copy(camera.projectionMatrixInverse);
    cam.uCamWorld.value.copy(camera.matrixWorld);
    cam.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    traceMat.uniforms.uFrame.value = frame = (frame + 1) % 1024;
    renderer.setRenderTarget(traceRT);
    renderer.render(traceScene, passCam);

    const prev = history[cur];
    cur ^= 1;
    const R = resolveMat.uniforms;
    R.uCur.value = traceRT.textures[0];
    R.uCurDepth.value = traceRT.textures[1];
    R.uHist.value = prev.textures[0];
    R.uHistDepth.value = prev.textures[1];
    R.uPrevViewProj.value.copy(prevViewProj);
    R.uTexel.value.set(1 / w, 1 / h);
    R.uReset.value = reset ? 1 : 0;
    renderer.setRenderTarget(history[cur]);
    renderer.render(resolveScene, passCam);
    reset = false;
    prevViewProj.copy(viewProj);
    comp.uCloudTex.value = history[cur].textures[0];
    comp.uCloudDist.value = history[cur].textures[1];
  }

  renderer.setRenderTarget(before);
  renderer.setClearColor(clearColor, alpha);
}
