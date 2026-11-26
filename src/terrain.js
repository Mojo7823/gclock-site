import * as THREE from 'three';
import { heightAt, riverEdge, BEACH, uniforms, glslCommon, EYE, FAR_LAND } from './common.js';

export function makeTerrain() {
  // covers the whole circle of FAR_LAND m around the camera's foot, also behind it (dev views; the haze no longer hides a gap there)
  const geo = new THREE.PlaneGeometry(400, 500, 200, 250).rotateX(-Math.PI / 2).translate(0, 0, -50);
  const pos = geo.attributes.position, edge = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    edge[i] = riverEdge(pos.getX(i), pos.getZ(i));
  }
  geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  // the ground ends FAR_LAND m out; mountain.js draws the far land and the mountains from a few metres inside that
  const index = geo.index.array, keep = [];
  for (let i = 0; i < index.length; i += 3) {
    const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const d = Math.hypot(x - EYE.x, z - EYE.z);
    if (d < FAR_LAND) keep.push([d, a, b, c]);
  }
  geo.setIndex(keep.flatMap((t) => t.slice(1)));
  geo.computeVertexNormals();
  // drawn near to far from the clock spot, and (renderOrder, below) after the grass and the trees: the depth test then
  // drops the ground they hide, and the ground behind a rise, before it is shaded
  geo.setIndex(keep.sort((p, q) => p[0] - q[0]).flatMap((t) => t.slice(1)));

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uSand: { value: new THREE.Color('#cbb994') } },
    vertexShader: /* glsl */ `
      attribute float aEdge;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vEdge;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normal;
        vEdge = aEdge;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: glslCommon + /* glsl */ `
      uniform vec3 uSand;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vEdge;
      void main() {
        float lit = toon(dot(normalize(vNormal), uSunDir), 0.1) * shadowAt(vWorldPos);
        // roughly the average colour of the grass field, so the ground past the grass doesn't show a seam
        vec3 col = mix(groundColor(vWorldPos.xz) * 0.5, uGrassTip, 0.62);
        // past the blades (far bank, valley side, hills): painted grass instead of a flat fill, soft
        // light/dark patches and short dark tufts across the view, faded out far away (no speckle)
        float dist = distance(vWorldPos, cameraPosition), far = smoothstep(30.0, 50.0, dist);
        col *= mix(1.0, 0.86 + 0.28 * vnoise(vWorldPos.xz * 0.05 + 5.0), far);
        float tuft = smoothstep(0.64, 0.74, vnoise(vWorldPos.xz * vec2(1.5, 4.0))) * (1.0 - smoothstep(90.0, 160.0, dist));
        col = mix(col, col * vec3(0.78, 0.85, 0.72), tuft * far);
        // river bank: a band of pebbles and mud at the waterline (ragged toon edge), darker where wet
        float n = vnoise(vWorldPos.xz * 0.8);
        float e = vEdge + (n - 0.5) * 0.9;
        vec3 sand = uSand * (0.9 + 0.2 * step(0.68, vnoise(vWorldPos.xz * 5.0))); // pebbles
        sand = mix(sand * vec3(0.5, 0.52, 0.5), sand, smoothstep(0.15, 0.75, e)); // wet right at the water
        col = mix(col, sand, 1.0 - smoothstep(${BEACH.toFixed(2)} - 0.08, ${BEACH.toFixed(2)} + 0.08, e));
        col *= mix(uShadeColor, uSunColor, lit);
        gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 0.6; // after the far grass (0.5), before the mountain (1)
  return mesh;
}
