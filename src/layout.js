import { mulberry32, riverZ, riverHalfWidth, EYE, heightAt, valueNoise } from './common.js';

// Where things stand in the scene (metres; the clock's camera is at (0, EYE_HEIGHT = 3, 11) looking toward -z).
// The clock view looks halfway between the big tree and the mountain summit (MOUNTAIN in common.js), so moving
// the big tree turns the view. Seen from the clock: nothing nearer may cover the big tree (its crown spans -16°..+18°
// around straight ahead, its top ~5° below the summit) or the mountain above ~12° elevation (snow, summit, cap);
// far-bank trees under the mountain stay below that. The near framing trees and the gold and forked trees on the
// right stand clear of the big tree's crown; the tall amber tree fills the gap between them (seen on a portrait phone).
// The left side (seen when the viewer turns left, down to the yaw limit ~66° left of -z): Green Knotwood trees and
// birches near the viewer (x -16..-50, z 1..-12) and across the river (60-130 m out); from the default zoom the near
// ones hide most of the far ones. Riverbank shrubs, and a few flower clusters in the meadow. Nothing on the near bank
// in the middle of the view: from eye height a 1 m shrub at the water's edge covers the whole river behind it.
// Model trees (SHAPES with a `model`, tree.js) and `plants` are the owner's models, converted to shapes/*.js (models.js).

export const rocks = [
  { x: -6, z: 0.5, size: 1.1, seed: 31 },
  { x: 8.6, z: -6.5, size: 1.4, seed: 32 },
  { x: -12.5, z: -19, size: 1.9, seed: 33 },
  { x: 1.2, z: -15, size: 1.0, seed: 34 },
  { x: 17, z: -31, size: 2.2, seed: 35 },
  { x: -7, z: -28, size: 1.5, seed: 36 },
  // far bank (the first four rocks standing in the water get river foam, see setRiverRocks)
  { x: 3, z: -35.5, size: 1.6, seed: 37 },
  { x: -24, z: -31, size: 1.8, seed: 38 },
  { x: -14, z: -44, size: 2.4, seed: 39 },
  { x: 9.5, z: -51.5, size: 1.8, seed: 40 },
  { x: -3.5, z: -49, size: 1.4, seed: 41 },
  { x: 27, z: -52, size: 2.2, seed: 42 },
  { x: -36, z: -56, size: 2.6, seed: 43 },
];

// type = a key of SHAPES in tree.js (default 'round'), leaf = a key of LEAVES (default 'green').
// The first MAX_TREES (16, common.js) also cast ground shadows: trees in the clock view first.
export const trees = [
  // near bank
  { x: 9.5, z: 2.5, height: 10, seed: 1 }, // framing the right edge of the clock view
  { x: -9.5, z: -11.5, height: 8, seed: 2, type: 'forked', leaf: 'lime' },
  { x: -9, z: -4, height: 10.5, seed: 3, type: 'tall' }, // and the left edge
  { x: 15.2, z: -19.4, height: 8.5, seed: 4, leaf: 'gold' },
  { x: 23.5, z: -22.5, height: 10, seed: 6, type: 'forked' },
  { x: -16, z: -3, height: 10, seed: 90, type: 'knotwood' }, // the left side, near
  { x: -27, z: -8, height: 9, seed: 91, type: 'knotwood', leaf: 'gold' },
  { x: -21.5, z: 1.5, height: 9.5, seed: 92, leaf: 'lime' },
  // across the river: the one big tree (width: its crown is narrower than the model's), then the bank
  { x: 2, z: -55, height: 25, width: 0.7, seed: 202, type: 'giant' },
  { x: -19, z: -31, height: 11, seed: 5, type: 'tall' },
  { x: -30, z: -40, height: 9, seed: 8, leaf: 'gold' },
  { x: 36, z: -50, height: 8, seed: 9, leaf: 'lime' },
  { x: 20.6, z: -47.5, height: 11, seed: 10, type: 'tall', leaf: 'amber' },
  { x: -33, z: -62, height: 9.5, seed: 11 },
  { x: 30, z: -61, height: 10, seed: 12, leaf: 'lime' },
  { x: 41, z: -46, height: 9, seed: 14, type: 'forked' },
  // (no ground shadow from here on)
  { x: -42, z: -49, height: 10, seed: 13, type: 'forked', leaf: 'lime' },
  { x: -44, z: -36, height: 11, seed: 93, type: 'knotwood' }, // the left side, across the river
  { x: -38, z: -9, height: 11, seed: 94, type: 'knotwood', leaf: 'lime' },
  { x: -50, z: -12, height: 10, seed: 95, type: 'tall', leaf: 'gold' },
  { x: -62, z: -52, height: 12, seed: 96, type: 'knotwood', leaf: 'lime' },
  { x: -82, z: -46, height: 13, seed: 97, type: 'knotwood', leaf: 'gold' },
  { x: -70, z: -48, height: 11, seed: 98, type: 'tall', leaf: 'amber' },
  { x: -100, z: -50, height: 14, seed: 99, type: 'knotwood' },
  { x: -112, z: -48, height: 12, seed: 100, leaf: 'amber' },
  { x: -62, z: -70, height: 10, seed: 15, leaf: 'amber' },
  { x: -46, z: -70, height: 12, seed: 16, type: 'tall', leaf: 'amber' },
  { x: 54, z: -59, height: 10, seed: 17, leaf: 'gold' },
  { x: 62, z: -52, height: 12, seed: 18, type: 'tall' },
  { x: -48, z: -86, height: 11, seed: 19, leaf: 'lime' },
  { x: 76, z: -60, height: 10, seed: 20, leaf: 'gold' },
  { x: -58, z: -96, height: 12, seed: 28, leaf: 'gold' },
  { x: 72, z: -76, height: 12, seed: 29, leaf: 'amber' },
  { x: 56, z: -104, height: 13, seed: 30, type: 'tall' },
  // bushes, near bank
  { x: 6.8, z: 0.2, height: 1.5, seed: 21, type: 'bush' },
  { x: 11.8, z: -0.6, height: 1.2, seed: 22, type: 'bush', leaf: 'amber' },
  { x: -6.2, z: -10.5, height: 1.3, seed: 23, type: 'bush' },
  { x: -10.5, z: -13.5, height: 1.6, seed: 24, type: 'bush' },
  { x: 11, z: -16.5, height: 1.3, seed: 25, type: 'bush' },
  { x: -4.8, z: -18.5, height: 1.4, seed: 26, type: 'bush' },
  { x: 19.5, z: -22.5, height: 1.8, seed: 27, type: 'bush' },
  { x: -23, z: -5, height: 1.7, seed: 60, type: 'bush', leaf: 'lime' },
  { x: -33, z: -4, height: 1.5, seed: 61, type: 'bush' },
  // bushes, far bank
  { x: -16, z: -41, height: 1.8, seed: 51, type: 'bush' },
  { x: -27, z: -36, height: 1.6, seed: 52, type: 'bush', leaf: 'lime' },
  { x: 11, z: -44.5, height: 1.7, seed: 53, type: 'bush', leaf: 'lime' },
  { x: 25, z: -45, height: 1.5, seed: 54, type: 'bush', leaf: 'gold' },
  { x: -7, z: -52, height: 2, seed: 55, type: 'bush' },
  { x: -12, z: -60, height: 2.2, seed: 56, type: 'bush', leaf: 'amber' },
  { x: 34, z: -56, height: 2, seed: 57, type: 'bush' },
  { x: -38, z: -60, height: 2.2, seed: 58, type: 'bush' },
  { x: 46, z: -50, height: 1.8, seed: 59, type: 'bush', leaf: 'lime' },
  { x: -54, z: -40, height: 2, seed: 62, type: 'bush', leaf: 'gold' },
];

// Small converted models (models.js): { x, z, height, seed, type = a plant in models.js (shapes/<type>.js) }. Flower clusters in the
// meadow, then the riverbank shrubs (generated below).
export const plants = [
  { x: -12, z: 1, height: 2.2, seed: 101, type: 'bellflower' }, // left meadow
  { x: -13.4, z: 2.8, height: 1.7, seed: 102, type: 'bellflower' },
  { x: -10.6, z: 3, height: 1.5, seed: 103, type: 'bellflower' },
  { x: 13, z: -9, height: 2, seed: 104, type: 'bellflower' }, // right meadow
  { x: 14.2, z: -7.6, height: 1.5, seed: 105, type: 'bellflower' },
  { x: -7.3, z: 1.6, height: 1.6, seed: 106, type: 'stars' }, // by the rocks
  { x: -4.7, z: 1.9, height: 1.3, seed: 107, type: 'stars' },
  { x: -14.5, z: -15.5, height: 1.5, seed: 108, type: 'stars' },
  { x: 7.4, z: -7.6, height: 1.5, seed: 109, type: 'stars' },
  { x: -24, z: -44, height: 2, seed: 110, type: 'stars' },
];

// Riverbank shrubs: on the beach just above the water, every ~7 m along both banks (seeded), the near bank only left
// and right of the clock view's middle (see the header).
const rand = mulberry32(77);
for (let x = -75; x < 45; x += 4 + 6 * rand()) {
  for (const side of [1, -1]) {
    const nearMiddle = side > 0 && x > -22 && x < 28;
    if (nearMiddle || rand() < 0.35) continue;
    const z = riverZ(x) + side * (riverHalfWidth(x) + 0.5 + 0.7 * rand());
    plants.push({ x: +x.toFixed(1), z: +z.toFixed(1), height: 1 + 0.5 * rand(), seed: 200 + plants.length, type: 'shrub' });
  }
}

// The meadow's flowers (there are no procedural ones): seeded clusters of bellflowers and 'stars' near the viewer and
// out on the far bank, inside the view's wedge, clear of rocks, trees and the river. The middle of the near view stays
// open (a centre lane, and the river behind the near meadow).
const prand = mulberry32(91);
const clear = (x, z) => !rocks.some((o) => Math.hypot(o.x - x, o.z - z) < o.size + 1.5)
  && !trees.some((t) => Math.hypot(t.x - x, t.z - z) < (t.type === 'bush' ? t.height + 1 : 2))
  && Math.abs(z - riverZ(x)) > riverHalfWidth(x) + 3;
for (const [x0, x1, z0, z1, n] of [[-18, 18, 6, -18, 7], [-70, 70, -38, -100, 12]]) { // near meadow, far bank
  for (let k = 0, tries = 0; k < n && tries < 1000; tries++) {
    const x = x0 + (x1 - x0) * prand(), z = z0 + (z1 - z0) * prand();
    if (Math.abs(Math.atan2(x - EYE.x, EYE.z - z)) > 1.05 || Math.abs(x) < 4 || (Math.abs(x) < 10 && z < -8 && z > -30) || !clear(x, z)) continue;
    const type = prand() < 0.6 ? 'bellflower' : 'stars';
    for (let i = 0, m = 2 + Math.floor(prand() * 3); i < m; i++) {
      const px = x + (prand() - 0.5) * 3.5, pz = z + (prand() - 0.5) * 3.5;
      if (clear(px, pz)) plants.push({ x: +px.toFixed(1), z: +pz.toFixed(1), height: (type === 'bellflower' ? 1.4 : 1.1) + 0.7 * prand(), seed: 300 + plants.length, type });
    }
    k++;
  }
}

// Reeds (river.js draws them): patches of tall blades and cattails at the waterline. Each reed's root (offsets: x, y, z)
// and params (rotation, height, cattail, random); dragonflies.js perches on their tips.
export const REEDS = { offsets: [], params: [] };
{
  const rand = mulberry32(41), { offsets, params } = REEDS;
  while (offsets.length < 900 * 3) {
    const x = (rand() * 2 - 1) * 70, side = rand() < 0.5 ? -1 : 1, k = side * (riverHalfWidth(x) - 0.3 + rand() * 0.9);
    if (valueNoise(x * 0.09, side * 7) < 0.58) continue; // patches along parts of the banks
    const s = riverZ(x + 0.5) - riverZ(x - 0.5), l = Math.hypot(1, s), px = x - (s / l) * k, pz = riverZ(x) + k / l;
    offsets.push(px, heightAt(px, pz) - 0.05, pz);
    params.push(rand() * Math.PI * 2, 1.1 + 0.8 * rand(), rand() < 0.3 ? 1 : 0, rand()); // rotation, height, cattail, random
  }
}
