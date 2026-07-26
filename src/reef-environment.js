import * as THREE from 'three';

class SeededRandom {
  constructor(seed) {
    this.w = (123456789 + seed) | 0;
    this.z = (987654321 - seed) | 0;
  }

  value(max = 1, min = 0) {
    this.z = (36969 * (this.z & 65535) + (this.z >> 16)) | 0;
    this.w = (18000 * (this.w & 65535) + (this.w >> 16)) | 0;
    const normalized = (((this.z << 16) + (this.w & 65535)) >>> 0) / 4294967296;
    return min + (max - min) * normalized;
  }
}

function smoothNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const easeX = tx * tx * (3 - 2 * tx);
  const easeZ = tz * tz * (3 - 2 * tz);
  const hash = (gridX, gridZ) => {
    const value = Math.sin(gridX * 127.1 + gridZ * 311.7 + seed * 74.7) * 43758.5453123;
    return value - Math.floor(value);
  };
  const a = hash(x0, z0);
  const b = hash(x0 + 1, z0);
  const c = hash(x0, z0 + 1);
  const d = hash(x0 + 1, z0 + 1);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, easeX),
    THREE.MathUtils.lerp(c, d, easeX),
    easeZ,
  );
}

function smoothstep(edge0, edge1, value) {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function createReefField({ seed = 42, radius = 80 } = {}) {
  const sample = (x, z) => {
    const distance = Math.hypot(x, z);
    const outerFalloff = 1 - smoothstep(radius * 0.58, radius * 1.12, distance);
    const broad = smoothNoise(x * 0.035, z * 0.035, seed);
    const ridges = 1 - Math.abs(smoothNoise(x * 0.11, z * 0.11, seed + 13) * 2 - 1);
    const detail = smoothNoise(x * 0.32, z * 0.32, seed + 29);
    const shelf = smoothNoise(x * 0.017, z * 0.017, seed + 47);
    const height = outerFalloff * (1.8 + broad * 4.8 + ridges * 1.65 + detail * 0.65 + shelf * 1.2);
    const habitat = THREE.MathUtils.clamp(
      outerFalloff * (0.25 + broad * 0.45 + ridges * 0.3),
      0,
      1,
    );

    return { height, habitat, outerFalloff };
  };

  return {
    seed,
    radius,
    sample,
    sampleHeight: (x, z) => sample(x, z).height,
  };
}

function buildRockGeometry(random, size) {
  const geometry = new THREE.IcosahedronGeometry(size, 2);
  const positions = geometry.attributes.position;
  const normal = new THREE.Vector3();

  for (let index = 0; index < positions.count; index++) {
    normal.set(positions.getX(index), positions.getY(index), positions.getZ(index)).normalize();
    const distortion = 0.72 + random.value(0.42);
    positions.setXYZ(
      index,
      normal.x * size * distortion * (1 + normal.y * 0.12),
      normal.y * size * distortion * 0.66,
      normal.z * size * distortion,
    );
  }

  geometry.computeVertexNormals();
  return geometry;
}

export function createReefTerrain({ field, seafloorY = -50, segments = 104 } = {}) {
  const terrainSize = field.radius * 2.45;
  const terrain = new THREE.PlaneGeometry(terrainSize, terrainSize, segments, segments);
  terrain.rotateX(-Math.PI / 2);
  const positions = terrain.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const sand = new THREE.Color(0x9a8058);
  const algae = new THREE.Color(0x496a55);
  const coralShelf = new THREE.Color(0x6e7258);
  const color = new THREE.Color();

  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const sample = field.sample(x, z);
    const slopeProbe = Math.abs(field.sampleHeight(x + 0.7, z) - field.sampleHeight(x - 0.7, z))
      + Math.abs(field.sampleHeight(x, z + 0.7) - field.sampleHeight(x, z - 0.7));
    const rockness = THREE.MathUtils.clamp(sample.habitat * 0.55 + slopeProbe * 0.09, 0, 1);

    positions.setY(index, seafloorY + sample.height);
    color.copy(sand).lerp(algae, sample.habitat * 0.5).lerp(coralShelf, rockness * 0.48);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }

  terrain.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrain.computeVertexNormals();
  terrain.computeBoundingSphere();

  const terrainMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
  });
  const group = new THREE.Group();
  group.name = 'reef-terrain';
  group.add(new THREE.Mesh(terrain, terrainMaterial));

  const random = new SeededRandom(field.seed + 901);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x59675e,
    roughness: 0.93,
    metalness: 0,
  });
  const rockCount = 34;

  for (let index = 0; index < rockCount; index++) {
    const angle = random.value(Math.PI * 2);
    const distance = random.value(field.radius * 0.86, field.radius * 0.1);
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const sample = field.sample(x, z);
    if (sample.habitat < 0.32) continue;

    const size = random.value(2.5, 0.75) * (0.55 + sample.habitat * 0.75);
    const rock = new THREE.Mesh(buildRockGeometry(random, size), rockMaterial);
    rock.position.set(x, seafloorY + sample.height + size * 0.22, z);
    rock.rotation.set(random.value(Math.PI), random.value(Math.PI), random.value(Math.PI));
    rock.scale.set(1, random.value(1.15, 0.75), random.value(1.25, 0.78));
    group.add(rock);
  }

  return group;
}

export function createSuspendedParticles({ seed = 811, count = 900, reefRadius = 90, seafloorY = -50 } = {}) {
  const random = new SeededRandom(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const restPositions = new Float32Array(count * 3);
  const bright = new THREE.Color(0xc8e8f0);
  const blue = new THREE.Color(0x5fb7cd);
  const color = new THREE.Color();

  for (let index = 0; index < count; index++) {
    const angle = random.value(Math.PI * 2);
    const radius = Math.sqrt(random.value()) * reefRadius;
    const offset = index * 3;
    restPositions[offset] = Math.cos(angle) * radius;
    restPositions[offset + 1] = random.value(-4, seafloorY + 2);
    restPositions[offset + 2] = random.value(140, -80);
    positions.set(restPositions.slice(offset, offset + 3), offset);
    phases[index] = random.value(Math.PI * 2);
    color.copy(blue).lerp(bright, random.value());
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.14,
    vertexColors: true,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const particles = new THREE.Points(geometry, material);
  particles.name = 'underwater-particulates';
  particles.userData.restPositions = restPositions;
  particles.userData.phases = phases;
  return particles;
}

export function updateSuspendedParticles(particles, elapsed) {
  const positions = particles.geometry.attributes.position;
  const restPositions = particles.userData.restPositions;
  const phases = particles.userData.phases;

  for (let index = 0; index < positions.count; index++) {
    const offset = index * 3;
    const phase = phases[index];
    positions.setXYZ(
      index,
      restPositions[offset] + Math.sin(elapsed * 0.42 + phase) * 0.22,
      restPositions[offset + 1] + Math.sin(elapsed * 0.33 + phase * 1.7) * 0.16,
      restPositions[offset + 2] + Math.cos(elapsed * 0.29 + phase * 0.73) * 0.18,
    );
  }

  positions.needsUpdate = true;
}
