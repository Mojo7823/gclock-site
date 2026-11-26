import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, heightAt, uniforms, glslCommon } from './common.js';
import { castShadow } from './shadow.js';

const mat = new THREE.ShaderMaterial({
  uniforms: { ...uniforms, uRock: { value: new THREE.Color('#a9a59a') } },
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: glslCommon + /* glsl */ `
    uniform vec3 uRock;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vec3 n = normalize(vNormal);
      // moss cap on the flat top with a ragged edge; soft painterly tone variation across the stone
      float moss = smoothstep(0.8, 0.82, n.y + (vnoise(vWorldPos.xz * 2.0) - 0.5) * 0.4);
      vec3 albedo = mix(uRock * (0.88 + 0.24 * vnoise(vWorldPos.xz * 1.3 + vWorldPos.y * 2.0)), mix(uGround, uGround2, 0.3), moss);
      float lit = toon(dot(n, uSunDir), 0.08) * shadowAt(vWorldPos + n * 0.08);
      vec3 shade = mix(uShadeColor, uSunColor * vec3(0.8, 0.78, 0.74), 0.5); // warmer than the ground's shade, grey rock turned slate blue
      gl_FragColor = vec4(applyFog(albedo * mix(shade, uSunColor, lit), vWorldPos), 1.0);
      #include <colorspace_fragment>
    }`,
});

// Polished boulder (unit radius): a smooth sphere with a few planes pressed into it, giving broad
// faces with soft rounded edges once the normals are smoothed.
function rockGeometry(rand) {
  // welded (indexed) so computeVertexNormals averages across faces = smooth shading
  const geo = mergeVertices(new THREE.IcosahedronGeometry(1, 5).deleteAttribute('normal').deleteAttribute('uv'));
  const planes = Array.from({ length: 6 }, () => ({
    n: new THREE.Vector3(rand() - 0.5, rand() * 0.8 - 0.2, rand() - 0.5).normalize(), // mostly sides and top
    d: 0.6 + 0.2 * rand(),
  }));
  const ph = [rand(), rand()].map((r) => r * Math.PI * 2);
  const pos = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    for (const { n, d } of planes) { const k = v.dot(n) - d; if (k > 0) v.addScaledVector(n, -k * 0.85); }
    v.multiplyScalar(1 + 0.05 * Math.sin(v.x * 5 + ph[0]) * Math.sin(v.z * 4 + ph[1])); // gentle lumps
    pos.setXYZ(i, v.x * 1.15, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// list: [{ x, z, size, seed }], size = radius in metres; the centre sits 0.4 * size above the ground.
export function makeRocks(list) {
  const group = new THREE.Group();
  for (const r of list) {
    const rand = mulberry32(r.seed);
    const mesh = new THREE.Mesh(rockGeometry(rand), mat);
    mesh.scale.setScalar(r.size);
    mesh.position.set(r.x, heightAt(r.x, r.z) + r.size * 0.4, r.z);
    mesh.rotation.y = rand() * Math.PI * 2;
    castShadow(mesh);
    group.add(mesh);
  }
  return group;
}
