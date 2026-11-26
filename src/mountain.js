import * as THREE from 'three';
import { heightAt, hash, valueNoise, mulberry32, uniforms, glslCommon, MOUNTAIN, EYE, EYE_Y, FAR_LAND, SKY_EDGE } from './common.js';

// The far land and the mountain range at the end of the background (heights from heightAt, which holds the
// foothills and the peaks; the big snowy one has its summit at MOUNTAIN), plus small impostor trees on the
// foothills and lower slopes. Lit by the active light and hazed by applyFog like everything else.

const lin = (hex) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
const { smoothstep } = THREE.MathUtils;
const FOLD_SNOW = 8; // the snow line lies this much higher on the fold ranges than on the big peak: the hero is the snowy one

// ---------- land and rock: one polar mesh around the clock camera ----------
// From a few metres inside the end of the terrain mesh (FAR_LAND) out to SKY_EDGE. Cells are ~square in angle and
// radius (a facet is about the same size on screen near and far), ~3x finer toward the hero peak and 2x across the
// range (r > 300 m, where the ridgelines and the silhouette are; ~2 m cells, 5 px from the clock: finer ones cost
// more in half-covered pixel quads than they show), coarse behind the camera (only dev views look there).
// Vertices jittered so the cells don't line up.
const R_IN = FAR_LAND - 6, R_OUT = SKY_EDGE, STEP = (2 * Math.PI) / 540;
const deg = (a) => (a * 180) / Math.PI;
// cells per STEP: azimuth a (rad, 0 = straight ahead, + = right) and radius r (m)
const colDensity = (a) => 0.5 + 0.7 * smoothstep(-Math.abs(deg(a)), -95, -75) + 1.6 * smoothstep(deg(a), -10, -2) * smoothstep(-deg(a), -46, -38);
const rowDensity = (r) => 1 + 1.2 * smoothstep(r, 270, 320);
// positions where the integral of density (cells per unit of x) reaches each integer, from x0 to exactly x1
function spaced(x0, x1, density) {
  const fine = 20000, dx = (x1 - x0) / fine, cum = [0];
  for (let k = 1; k <= fine; k++) cum.push(cum[k - 1] + density(x0 + (k - 0.5) * dx) * dx);
  const n = Math.round(cum[fine]), out = [];
  for (let i = 0, k = 0; i <= n; i++) {
    const target = (i / n) * cum[fine];
    while (k < fine && cum[k + 1] < target) k++;
    out.push(x0 + ((k + (target - cum[k]) / (cum[k + 1] - cum[k] || 1)) / fine) * (x1 - x0));
  }
  return out;
}
const ANGLES = spaced(-Math.PI, Math.PI, (a) => colDensity(a) / STEP); // ANGLES[COLS] = ANGLES[0] + 2 pi
const RADII = spaced(Math.log(R_IN), Math.log(R_OUT), (l) => rowDensity(Math.exp(l)) / STEP).map(Math.exp); // log-spaced
const COLS = ANGLES.length - 1, ROWS = RADII.length;

function landGeometry() {
  const n = ROWS * COLS, pos = new Float32Array(n * 3), land = new Float32Array(n * 2);
  let summit = 0, best = Infinity;
  for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
    const rim = i === 0 || i === ROWS - 1;
    const r = rim ? RADII[i] : RADII[i] + (hash(i, j) - 0.5) * 0.6 * (RADII[i + 1] - RADII[i]);
    const a = ANGLES[j] + (hash(j + 0.5, i + 0.5) - 0.5) * 0.6 * (ANGLES[j + 1] - ANGLES[j]);
    const k = i * COLS + j, x = EYE.x + r * Math.sin(a), z = EYE.z - r * Math.cos(a);
    pos[k * 3] = x; pos[k * 3 + 2] = z;
    const d = Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z);
    if (d < best) { best = d; summit = k; }
  }
  pos[summit * 3] = MOUNTAIN.x; pos[summit * 3 + 2] = MOUNTAIN.z; // a vertex right on the summit keeps the tip at MOUNTAIN.y
  for (let k = 0; k < n; k++) pos[k * 3 + 1] = heightAt(pos[k * 3], pos[k * 3 + 2]);
  // concavity: how far a vertex sits below its neighbours ~12 m away (m; + = gully, - = crest), for snow and crevices;
  // and the forest: where the impostor trees grow in groves (same noise and sector as treeGeometry), a darker floor under them
  const y = (i, j) => pos[(Math.min(ROWS - 1, Math.max(0, i)) * COLS + ((j + COLS) % COLS)) * 3 + 1];
  for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
    const r = RADII[i], di = Math.max(1, Math.round(12 / (RADII[Math.min(i + 1, ROWS - 1)] - RADII[Math.max(i - 1, 0)]) * 2));
    const dj = Math.max(1, Math.round(12 / (r * (ANGLES[j + 1] - ANGLES[j]))));
    const k = i * COLS + j;
    land[k * 2] = (y(i - di, j) + y(i + di, j) + y(i, j - dj) + y(i, j + dj)) / 4 - y(i, j);
    const sector = smoothstep(deg(ANGLES[j]), -90, -80) * (1 - smoothstep(deg(ANGLES[j]), 90, 100)) * smoothstep(r, 215, 235);
    land[k * 2 + 1] = sector * smoothstep(valueNoise(pos[k * 3] * 0.025 + 3, pos[k * 3 + 2] * 0.025), 0.45, 0.65);
  }
  const index = new Uint32Array((ROWS - 1) * COLS * 6);
  let o = 0;
  for (let i = 0; i < ROWS - 1; i++) for (let j = 0; j < COLS; j++) {
    const a = i * COLS + j, b = i * COLS + ((j + 1) % COLS), c = a + COLS, d = b + COLS;
    if (hash(i + 0.3, j + 0.7) < 0.5) index.set([a, b, c, b, d, c], o); // random diagonals: irregular facets
    else index.set([a, b, d, a, d, c], o);
    o += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aLand', new THREE.BufferAttribute(land, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return geo;
}

const landMat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    attribute vec2 aLand;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec2 vLand;
    void main() {
      vWorldPos = position;
      vNormal = normal;
      vLand = aLand;
      gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec2 vLand; // concavity (m, + = gully), forest 0..1
    // value noise with its gradient: x = value, yz = d/dp (analytic, so bumps stay smooth per pixel)
    vec3 vnoiseG(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
      float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1)), k = a - b - c + d;
      return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * vec2(b - a + k * u.y, c - a + k * u.x));
    }
    // crags: ridged value noise at frequency f projected three ways (weights w from the normal), so it wraps over
    // cliffs and ledges unstretched. x = 0..1 (sharp crests), yzw = its world-space gradient
    vec4 crag(vec3 p, vec3 w, float f) {
      vec3 a = vnoiseG(p.zy * f), b = vnoiseG(p.xz * f), c = vnoiseG(p.xy * f);
      float n = a.x * w.x + b.x * w.y + c.x * w.z, s = sign(2.0 * n - 1.0);
      vec3 g = w.x * vec3(0.0, a.z, a.y) + w.y * vec3(b.y, 0.0, b.z) + w.z * vec3(c.y, c.z, 0.0);
      return vec4(1.0 - abs(2.0 * n - 1.0), -2.0 * s * f * g);
    }
    // angular rock plates: cellular noise in one projection; x = distance to the nearest plate border (cell units),
    // yz = the plate's random tilt
    vec3 cells(vec2 q) {
      vec2 i = floor(q), f = fract(q), id = i;
      float d1 = 9.0, d2 = 9.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(x, y), r = g + vec2(hash12(i + g), hash12(i + g + 19.7)) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = i + g; } else d2 = min(d2, d);
      }
      return vec3(sqrt(d2) - sqrt(d1), hash12(id + 5.3) - 0.5, hash12(id + 11.1) - 0.5);
    }
    // plates at frequency f projected three ways like crag(), on cliffs wider than tall (blocks in layers):
    // x = border distance, yzw = the tilt in world space
    vec4 plates(vec3 p, vec3 w, float f) {
      vec4 r = vec4(0.0);
      p.y *= 1.6;
      if (w.x > 0.0) { vec3 c = cells(p.zy * f); r += w.x * vec4(c.x, 0.0, c.z, c.y); }
      if (w.y > 0.0) { vec3 c = cells(p.xz * f); r += w.y * vec4(c.x, c.y, 0.0, c.z); }
      if (w.z > 0.0) { vec3 c = cells(p.xy * f); r += w.z * vec4(c.x, c.y, c.z, 0.0); }
      return r;
    }
    void main() {
      vec3 p = vWorldPos, sn = normalize(vNormal);
      vec3 w = sn * sn * sn * sn; w = max(w / (w.x + w.y + w.z) - 0.12, 0.0); w /= w.x + w.y + w.z; // at most two projections at once
      float px = length(fwidth(p)); // metres per pixel: detail fades out before it would alias
      float far = smoothstep(0.35, 0.8, px); // 1 from the clock (~0.6 m/px), 0 in the zooms: stronger tones where the haze flattens them
      float n1 = vnoise(p.xz * 0.035), n2 = vnoise(p.xz * 0.11 + 7.0), gully = vLand.x;
      // rock where it is steep or high, grass on the gentle land below (ragged toon edge)
      float rv = 0.57 - sn.y + 0.006 * max(p.y - 50.0, 0.0) + 0.16 * (n1 - 0.5) + 0.08 * (n2 - 0.5);
      float rock = smoothstep(-1.0, 1.0, rv / max(fwidth(rv), 0.004));
      // strata: rock layers 5-10 m thick, folded and dipping; each leans out over the ledge of the one below. They show
      // in patches (cliff bands), not all over the face
      vec3 fold = vnoiseG(p.xz * 0.012);
      float thick = 5.0 + 5.0 * vnoise(p.xz * 0.006 + 2.0), sy = p.y / thick + 1.6 * fold.x + 0.003 * (p.x - p.z), lf = fract(sy);
      float cliffs = smoothstep(0.45, 0.6, vnoise(p.xz * 0.02 + 13.0)) * (1.0 - smoothstep(0.3, 0.7, px));
      float t = clamp((lf - 0.82) / 0.18, 0.0, 1.0);
      vec3 gradSy = vec3(0.003 + 1.6 * 0.012 * fold.y, 1.0 / thick, -0.003 + 1.6 * 0.012 * fold.z);
      vec3 G = 2.0 * cliffs * (1.0 - 6.0 * t * (1.0 - t) / 0.18) * gradSy;
      // big crags cut in as V-shaped clefts (7 m), and on them angular plates, ~10 m and ~3 m, each tilted its own way
      float f1 = 1.0 - smoothstep(1.2, 3.0, px), f2 = 1.0 - smoothstep(0.4, 1.0, px);
      vec4 c0 = crag(p, w, 0.035), p1 = vec4(1.0, 0.0, 0.0, 0.0), p2 = p1;
      if (rock * f1 > 0.0) p1 = plates(p, w, 0.1); // (on the rock only: the most expensive part)
      if (rock * f2 > 0.0) p2 = plates(p + 5.0, w, 0.3);
      G -= 7.0 * c0.yzw - 1.0 * p1.yzw * f1 - 0.6 * p2.yzw * f2;
      G *= rock;
      vec3 n = normalize(sn - (G - dot(G, sn) * sn)); // bumped normal: minus the bump's slope along the surface
      float ndl = dot(n, uSunDir), lit = toon(ndl, 0.04) * cloudShadow(p);
      // a third, middle tone on lit faces turned from the light: the crags and ledges read even under a high sun
      float mid = 1.0 - (0.2 + 0.12 * far) * smoothstep(0.5, 0.42, ndl + 0.08 * (n2 - 0.5));
      // snow: on faces that point up (ledges too) from a wavy snow line up, more of them higher up; streaks down the
      // gullies on the rock below the line; a lip along the crests (cornices). Painted breakup, crisp antialiased edges.
      // The gully terms are capped and the masks below the line beat them: deep valleys and sharp crests (the folds)
      // below the line stay bare
      float breakup = 0.6 * vnoise(p.xz * 0.05 + 11.0) + 0.4 * vnoise(p.xz * 0.16 + p.y * 0.1) + 0.5 * (p1.y + p1.z + p1.w) * f1;
      float line = 98.0 + 34.0 * (n1 - 0.5) + ${FOLD_SNOW.toFixed(1)} * smoothstep(150.0, 260.0, distance(p.xz, vec2(${MOUNTAIN.x.toFixed(1)}, ${MOUNTAIN.z.toFixed(1)}))), hi = smoothstep(line - 10.0, line + 55.0, p.y);
      float sv = n.y - mix(0.88, 0.64, hi) + 0.35 * (breakup - 0.5) + 0.15 * min(gully, 4.0) - smoothstep(line, line - 25.0, p.y + 30.0 * (breakup - 0.5));
      sv = max(sv, 0.5 * min(gully, 4.0) + 0.6 * breakup + 0.3 * hi - 1.0 - 3.0 * smoothstep(line - 30.0, line - 45.0, p.y) - (1.0 - rock) - step(n.y, 0.3));
      sv = max(sv, -0.4 * max(gully, -4.0) - 1.0 - smoothstep(line + 30.0, line + 5.0, p.y) - smoothstep(0.62, 0.48, n.y));
      // the hero's summit dome (nothing else is this high): wind-scoured, rock shows through the snow in ragged patches
      // (all snow, the bald dome over the cap cloud read as a helmet)
      float scour = 0.65 * vnoise(p.xz * 0.2 + 17.0) + 0.35 * vnoise(p.xz * 0.5 + p.y * 0.2) + 0.3 * (breakup - 0.5);
      sv -= 1.5 * smoothstep(${(MOUNTAIN.y - 24).toFixed(1)}, ${(MOUNTAIN.y - 10).toFixed(1)}, p.y) * smoothstep(0.5, 0.56, scour);
      float snow = smoothstep(-1.0, 1.0, sv / max(fwidth(sv), 0.01));
      // painted rock: cool blue-grey, warmer where lit, each stratum a little lighter or darker, dark in the gullies
      vec3 stone = mix(${lin('#4d5262')}, ${lin('#8a817b')}, clamp(0.1 + (0.45 - 0.25 * far) * lit + 0.4 * (n2 - 0.5), 0.0, 1.0));
      stone *= (0.86 + 0.26 * mix(0.5, hash12(vec2(floor(sy), 3.7)), cliffs)) * (1.0 - (0.3 + 0.2 * far) * smoothstep(0.5, 2.5, gully));
      // a few deep joints between the plates, and the dark band under each overhanging ledge
      stone *= 1.0 - 0.25 * smoothstep(0.06, 0.02, p1.x) * f1 * smoothstep(0.3, 0.6, abs(p1.y + p1.z + p1.w));
      stone *= 1.0 - 0.3 * cliffs * smoothstep(0.55, 0.8, lf) * (1.0 - t);
      vec3 grass = mix(groundColor(p.xz) * 0.5, uGrassTip, 0.62) * (0.86 + 0.28 * vnoise(p.xz * 0.05 + 5.0));
      // alpine meadow: painted patches of drier, yellower autumn grass (crisp edges), a darker forest floor under the groves
      grass = mix(grass, grass * vec3(1.1, 1.0, 0.7), 0.7 * smoothstep(0.52, 0.56, vnoise(p.xz * 0.03 + 21.0) + 0.15 * vnoise(p.xz * 0.2)));
      grass = mix(grass, grass * vec3(0.5, 0.6, 0.5), vLand.y);
      vec3 albedo = mix(mix(grass, stone, rock), ${lin('#f2f5ff')}, snow);
      // snow and rock in shade: a greyer shade plus a little bounced light, cool but never the sky's blue (read as holes)
      vec3 shade = mix(uShadeColor, mix(vec3(dot(uShadeColor, vec3(0.3, 0.59, 0.11))), uShadeColor, 0.2) + 0.15 * uSunColor, max(snow, 0.5 * rock));
      gl_FragColor = vec4(applyFog(albedo * mix(shade, uSunColor * mix(1.0, mid, rock), lit), p), 1.0);
      #include <colorspace_fragment>
    }`,
});

// ---------- trees on the foothills and lower slopes ----------
// shortcut: flat camera-facing impostors (a lumpy crown or a tiered cone, ~10-20 px tall from the clock);
// upgrade to real meshes only if the camera ever gets close.
const TREES = 1800;
// Horizon seen from the clock camera: per 0.5° of azimuth, the steepest sight line (slope) to the ground from 60 m
// out to every 8 m step, so seen() is a lookup. shortcut: placed once for the default eye (EYE_Y); a lower eye may
// see a few crowns over a nearer crest; re-place on a 'camera.height' change if that shows.
const H_BIN = 0.5, H_STEP = 8, H_MIN = 60;
const horizon = new Map();
function horizonAt(a, r) {
  const bin = Math.round(deg(a) / H_BIN);
  let row = horizon.get(bin);
  if (!row) {
    const az = (bin * H_BIN * Math.PI) / 180, s = Math.sin(az), c = Math.cos(az);
    row = [];
    for (let d = H_MIN, m = -Infinity; d < SKY_EDGE; d += H_STEP) row.push(m = Math.max(m, (heightAt(EYE.x + d * s, EYE.z - d * c) - EYE_Y) / d));
    horizon.set(bin, row);
  }
  return row[Math.max(0, Math.min(row.length - 1, Math.floor((r - H_MIN) / H_STEP)))];
}
// true if the ground at (x, h, z) and ~10 m below it show from the clock camera (no nearer ground rises above
// the line of sight) by a small margin, so a tree there stands on visible ground, not on a ledge seen edge-on
function seen(x, z, h) {
  const dx = x - EYE.x, dz = z - EYE.z, r = Math.hypot(dx, dz);
  return r < H_MIN + 28 || (h - 10 - EYE_Y) / r >= horizonAt(Math.atan2(dx, -dz), r - 28) + 0.004;
}
// true if land rises above a crown top at height `top` within ~100 m behind it, seen from the clock camera: no tree
// stands on a skyline (against the sky or a farther range)
function backed(x, z, top) {
  const dx = x - EYE.x, dz = z - EYE.z, r = Math.hypot(dx, dz), s = (top - EYE_Y) / r;
  for (let k = 10; k <= 100; k += 10) if ((heightAt(x + (dx / r) * k, z + (dz / r) * k) - EYE_Y) / (r + k) > s) return true;
  return false;
}
// GLSL hash12 / vnoise (common.js) in JS, so tree placement can ask where the land shader paints snow
const fract = (v) => v - Math.floor(v);
function hash12(x, y) {
  const a = fract(x * 0.1031), b = fract(y * 0.1031), d = a * (b + 33.33) + b * (a + 33.33) + a * (a + 33.33);
  return fract((a + b + 2 * d) * (a + d));
}
function vnoiseGL(x, y) {
  const i = Math.floor(x), j = Math.floor(y), u = smoothstep(x - i, 0, 1), v = smoothstep(y - j, 0, 1);
  const a = hash12(i, j), b = hash12(i + 1, j), c = hash12(i, j + 1), d = hash12(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// true where landMat may paint snow at (x, h, z), ny = the slope normal's y, gully = the concavity: its three snow terms with
// the mesh normal and an average breakup, plus a margin for both
function snowy(x, z, h, ny, gully) {
  const n1 = vnoiseGL(x * 0.035, z * 0.035), line = 98 + 34 * (n1 - 0.5) + FOLD_SNOW * smoothstep(Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z), 150, 260);
  if (h < line - 45) return false; // no snow down there
  const n2 = vnoiseGL(x * 0.11 + 7, z * 0.11 + 7), hi = smoothstep(h, line - 10, line + 55);
  const rock = 0.57 - ny + 0.006 * Math.max(h - 50, 0) + 0.16 * (n1 - 0.5) + 0.08 * (n2 - 0.5) > 0 ? 1 : 0;
  return Math.max(ny - 0.88 + 0.24 * hi + 0.15 * Math.min(gully, 4) - (1 - smoothstep(h, line - 25, line)),
    0.5 * Math.min(gully, 4) + 0.3 * hi - 0.7 - 3 * (1 - smoothstep(h, line - 45, line - 30)) - (1 - rock),
    -0.4 * Math.max(gully, -4) - 1 - (1 - smoothstep(h, line + 5, line + 30)) - (1 - smoothstep(ny, 0.48, 0.62))) > -0.2;
}
function treeGeometry(place = true) {
  const rand = mulberry32(2024), data = [];
  for (let tries = 0; place && data.length < TREES * 6 && tries < 200000; tries++) {
    // mostly in front of and around the big peak, a few groves elsewhere
    const a = (rand() < 0.7 ? -10 + rand() * 60 : -80 + rand() * 170) * (Math.PI / 180), r = 230 + rand() * 200;
    const x = EYE.x + r * Math.sin(a), z = EYE.z - r * Math.cos(a);
    // in groves, dense in their middle (forest texture), with a few loose trees around them
    const grove = valueNoise(x * 0.025 + 3, z * 0.025) + 0.25 * (valueNoise(x * 0.11, z * 0.11) - 0.5);
    if (grove < 0.5 + 0.25 * rand()) continue;
    // on ground that shows over the hills, up into the lower snow; each grove its own band, so they don't line up on a contour
    const h = heightAt(x, z), band = 30 * (valueNoise(x * 0.02 + 9, z * 0.02) - 0.5);
    if (h < 36 + band || h > 112 + band) continue;
    if (h > 105 && Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z) < 200) continue; // no lone firs on the hero's face under the cap
    if (!seen(x, z, h)) continue; // a crown poking over a nearer crest would float
    const gx = heightAt(x + 2, z) - heightAt(x - 2, z), gz = heightAt(x, z + 2) - heightAt(x, z - 2);
    const ny = 4 / Math.hypot(gx, gz, 4);
    if (ny < 0.72) continue; // too steep
    // concavity as in landGeometry (+ = gully, - = crest): none on crests, where a row of crowns reads as a fringe
    const gully = (heightAt(x + 12, z) + heightAt(x - 12, z) + heightAt(x, z + 12) + heightAt(x, z - 12)) / 4 - h;
    if (gully < -2.5 || snowy(x, z, h, ny, gully) || !backed(x, z, h + 7)) continue;
    // conifers take over higher up (like the reference: autumn broadleaf below, dark firs into the snow)
    const conifer = rand() < 0.25 + 0.5 * smoothstep(h, 60, 105) ? 1 : 0;
    data.push(x, h - 1, z, conifer ? 5 + rand() * 3 : 4 + rand() * 1.8, conifer, rand());
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(data), 6);
  geo.setAttribute('aTree', new THREE.InterleavedBufferAttribute(buf, 4, 0));
  geo.setAttribute('aKind', new THREE.InterleavedBufferAttribute(buf, 2, 4));
  geo.instanceCount = data.length / 6;
  return geo;
}

const treeMat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    attribute vec4 aTree; // base x, y, z, height
    attribute vec2 aKind; // 1 = conifer, random
    varying float vBase;
    varying vec2 vUv;
    varying vec2 vKind;
    varying vec3 vWorldPos;
    varying vec3 vRight;
    varying vec3 vToCam;
    void main() {
      vec3 toCam = cameraPosition - aTree.xyz;
      toCam = normalize(vec3(toCam.x, 0.0, toCam.z));
      vRight = vec3(toCam.z, 0.0, -toCam.x);
      vToCam = toCam;
      vBase = aTree.y;
      vUv = position.xy;
      vKind = aKind;
      vWorldPos = aTree.xyz + vRight * position.x * aTree.w * (aKind.x > 0.5 ? 0.42 : 0.66) + vec3(0.0, position.y * aTree.w, 0.0);
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    varying float vBase;
    varying vec2 vUv;
    varying vec2 vKind;
    varying vec3 vWorldPos;
    varying vec3 vRight;
    varying vec3 vToCam;
    void main() {
      vec2 q = vUv;
      float rnd = vKind.y;
      vec2 nn; // crown normal in the card (right, up); the rest points at the camera
      vec3 albedo;
      if (vKind.x > 0.5) { // conifer: stacked tiers
        float w = 0.5 * (1.0 - q.y) * (0.72 + 0.28 * fract(q.y * 4.0 + rnd));
        if (q.y < 0.1) { if (abs(q.x) > 0.05) discard; albedo = ${lin('#3a2e26')}; nn = vec2(0.0); }
        else { if (abs(q.x) > w) discard; albedo = mix(${lin('#1d3a2c')}, ${lin('#2c4d36')}, rnd); nn = vec2(q.x / w * 0.8, 0.3); }
      } else { // broadleaf, autumn: a lumpy egg-shaped crown, narrower to the top, on a short trunk
        vec2 d = (q - vec2(0.0, 0.57)) / vec2(0.46, 0.43);
        d.x *= 1.0 + 0.55 * max(d.y, 0.0);
        float r = length(d) - 0.09 * sin(atan(d.y, d.x) * 5.0 + rnd * 40.0);
        if (r > 1.0) { if (q.y > 0.35 || abs(q.x) > 0.04) discard; albedo = ${lin('#4a3b30')}; nn = vec2(0.0); }
        else {
          // ochre, burnt orange, gold, rust, olive: yellowish, since orange turns mauve in the blue haze
          albedo = rnd < 0.35 ? ${lin('#b5852a')} : rnd < 0.6 ? ${lin('#bb6a26')} : rnd < 0.78 ? ${lin('#c9a133')} : rnd < 0.92 ? ${lin('#94502a')} : ${lin('#7f8030')};
          nn = d * 0.85;
        }
      }
      // warm crowns turn ochre and olive with distance (orange in the blue haze reads pink), and get more saturated:
      // the haze greys them back to gold instead of khaki
      float fd = smoothstep(200.0, 320.0, distance(vWorldPos, cameraPosition));
      albedo.g = max(albedo.g, albedo.r * mix(0.42, 0.62, fd));
      albedo.b *= mix(1.0, 0.35, fd);
      albedo = max(mix(vec3(dot(albedo, vec3(0.3, 0.59, 0.11))), albedo, 1.0 + 0.6 * fd), 0.0);
      vec3 n = vRight * nn.x + vec3(0.0, nn.y, 0.0) + vToCam * sqrt(max(0.0, 1.0 - dot(nn, nn)));
      float lit = toon(dot(n, uSunDir) + 0.3 * (vnoise(q * 9.0 + rnd * 30.0) - 0.5), 0.08) * cloudShadow(vWorldPos);
      // the shade side darker than the shade colour alone: a dense crown blocks the sky light too
      vec3 col = albedo * mix(uShadeColor * 0.7, uSunColor, lit);
      // hazed like the ground it stands on (the haze thins with height), else it floats in front of the haze
      gl_FragColor = vec4(applyFog(col, vec3(vWorldPos.x, vBase + 1.0, vWorldPos.z)), 1.0);
      #include <colorspace_fragment>
    }`,
});

const land = new THREE.Mesh(landGeometry(), landMat);
// The slope trees are placed after the first frame (~0.2 s of heightAt calls, more on a phone, would delay it); the
// first frame draws none but compiles their shader with the rest, so the later swap is only a buffer upload.
const trees = new THREE.Mesh(treeGeometry(false), treeMat);
requestAnimationFrame(() => setTimeout(() => { trees.geometry.dispose(); trees.geometry = treeGeometry(); }));
trees.frustumCulled = false; // instances spread over the whole range
// drawn after the other opaque objects (both sit at the origin, so they'd sort first): nearer trees and hills then
// hide them before their shaders run
land.renderOrder = trees.renderOrder = 1;
export const mountainLayer = new THREE.Group().add(land, trees);
