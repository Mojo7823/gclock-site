import { heightAt, MOUNTAIN, EYE, EYE_Y } from './common.js';
import { trees, rocks, plants } from './layout.js';

// Dev camera views (the View picker and ?view=<id>; hidden in production with the sliders): one per
// tree shape and leaf colour (the nearest of each; model trees too), each plant model (the nearest), every rock, the
// mountain and its summit.
// Each item is seen from the clock's side. Returns [{ id, group, name, pos, target, fov? }].
export function debugViews() {
  const views = [], seen = new Set(), away = (o) => Math.hypot(o.x, o.z - 11);
  for (const t of [...trees].sort((a, b) => away(a) - away(b))) {
    const id = `tree-${t.type ?? 'round'}-${t.leaf ?? 'green'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    views.push({ id, group: 'Trees', name: id.slice(5).replace('-', ', '), ...frame(t.x, t.z, t.height, t.type === 'giant' ? 2.1 : t.type === 'bush' ? 4 : 2, t.type === 'bush') });
  }
  for (const p of [...plants].sort((a, b) => away(a) - away(b))) {
    if (seen.has(p.type)) continue;
    seen.add(p.type);
    views.push({ id: `plant-${p.type}`, group: 'Plants', name: p.type, ...frame(p.x, p.z, p.height, 3, true) });
  }
  rocks.forEach((r, i) => views.push({ id: `rock-${i + 1}`, group: 'Rocks', name: `rock ${i + 1} (${Math.round(away(r))} m)`, ...frame(r.x, r.z, r.size, 3.5) }));
  views.push(
    { id: 'mountain', group: 'Mountain', name: 'mountain', pos: [MOUNTAIN.x - 40, 70, MOUNTAIN.z + 180], target: [MOUNTAIN.x, MOUNTAIN.y * 0.6, MOUNTAIN.z] },
    { id: 'summit', group: 'Mountain', name: 'summit, zoomed from the clock', pos: [EYE.x, EYE_Y, EYE.z], target: [MOUNTAIN.x, MOUNTAIN.y - 25, MOUNTAIN.z], fov: 20 },
  );
  return views;
}

// Camera `dist` × size away from (x, z), on the clock's side (never past the clock, so it stays over the grass),
// looking at the item's middle; low items are seen from above the grass. Swings around the item (up to ±63°) until
// no other tree or bush stands in or near the line of sight (the nearest of them excepted), else takes the clearest.
function frame(x, z, size, dist, low = false) {
  const r = Math.min(size * dist, Math.hypot(x, 11 - z) - 1), toClock = Math.atan2(-x, 11 - z);
  const others = trees.filter((t) => Math.hypot(t.x - x, t.z - z) > size + 1);
  const clear = (a) => Math.min(Infinity, ...others.map((t) => sightGap(t, x + Math.sin(toClock + a) * r, z + Math.cos(toClock + a) * r, x, z) - Math.max(2, t.height * 0.4)));
  const swings = [0, 0.4, -0.4, 0.8, -0.8, 1.1, -1.1];
  const a = swings.find((a) => clear(a) >= 0) ?? swings.reduce((best, a) => (clear(a) > clear(best) ? a : best));
  const px = x + Math.sin(toClock + a) * r, pz = z + Math.cos(toClock + a) * r, y = heightAt(x, z);
  return { pos: [px, low ? y + size + 1.6 : Math.max(heightAt(px, pz), y) + 1.2 + size * 0.2, pz], target: [x, y + size * 0.45, z] };
}

// Distance on the ground from tree t to the sight line from the camera (px, pz) to the item (x, z).
function sightGap(t, px, pz, x, z) {
  const dx = x - px, dz = z - pz, k = Math.min(1, Math.max(0, ((t.x - px) * dx + (t.z - pz) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px + k * dx - t.x, pz + k * dz - t.z);
}
