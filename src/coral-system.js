import * as THREE from 'three';

// ============================================================
// Seeded PRNG (from threejs-procedural-vegetation pattern)
// ============================================================
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

// ============================================================
// Coral Branch Geometry Generator (growth hierarchy approach)
// ============================================================
function generateBranchGeometry(rng, origin, direction, radius, length, level, maxLevel, segments, positions, normals, uvs, indices) {
  const up = new THREE.Vector3(0, 1, 0);
  const dir = direction.clone().normalize();

  // Build oriented rings along the branch (profile sweep)
  const ringCount = segments + 1;
  const radialSegments = 6 + level * 2; // more detail on trunk
  const taper = 0.3 + rng.value(0.4);

  const frames = [];
  const currentPos = origin.clone();
  const currentDir = dir.clone();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const r = radius * (1 - t * taper);

    // Add organic curvature
    if (i > 0) {
      const curvature = 0.15 * (1 + level * 0.5);
      currentDir.x += (rng.value(curvature, -curvature));
      currentDir.y += 0.02 + rng.value(0.05); // slight upward tropism
      currentDir.z += (rng.value(curvature, -curvature));
      currentDir.normalize();
      currentPos.addScaledVector(currentDir, length / segments);
    }

    frames.push({ position: currentPos.clone(), direction: currentDir.clone(), radius: r });
  }

  // Emit vertices as oriented rings (following procedural-geometry build order)
  const baseIndex = positions.length / 3;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const t = i / segments;

    // Build local coordinate frame using parallel transport
    let tangent = frame.direction.clone().normalize();
    let normal = new THREE.Vector3();
    if (Math.abs(tangent.dot(up)) < 0.99) {
      normal.crossVectors(up, tangent).normalize();
    } else {
      normal.crossVectors(new THREE.Vector3(1, 0, 0), tangent).normalize();
    }
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();

    for (let j = 0; j <= radialSegments; j++) {
      const angle = (j / radialSegments) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const nx = cos * normal.x + sin * binormal.x;
      const ny = cos * normal.y + sin * binormal.y;
      const nz = cos * normal.z + sin * binormal.z;

      positions.push(
        frame.position.x + nx * frame.radius,
        frame.position.y + ny * frame.radius,
        frame.position.z + nz * frame.radius
      );
      normals.push(nx, ny, nz);
      uvs.push(j / radialSegments, t);
    }
  }

  // Emit triangle indices
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = baseIndex + i * (radialSegments + 1) + j;
      const b = a + 1;
      const c = a + (radialSegments + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Spawn children (recursive growth hierarchy)
  const lastFrame = frames[frames.length - 1];
  if (level < maxLevel) {
    const childCount = Math.max(1, 3 - level);
    for (let c = 0; c < childCount; c++) {
      const spawnT = 0.4 + rng.value(0.5);
      const spawnIndex = Math.floor(spawnT * (frames.length - 1));
      const spawnFrame = frames[spawnIndex];

      const childDir = spawnFrame.direction.clone();
      const spreadAngle = 0.4 + rng.value(0.6);
      childDir.x += Math.cos(rng.value(Math.PI * 2)) * spreadAngle;
      childDir.z += Math.sin(rng.value(Math.PI * 2)) * spreadAngle;
      childDir.y += rng.value(0.3, -0.1);
      childDir.normalize();

      generateBranchGeometry(
        rng,
        spawnFrame.position.clone(),
        childDir,
        spawnFrame.radius * (0.5 + rng.value(0.2)),
        length * (0.5 + rng.value(0.2)),
        level + 1,
        maxLevel,
        Math.max(3, segments - 2),
        positions, normals, uvs, indices
      );
    }
  }
}

function buildBranchCoralGeometry(rng, preset) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const branchCount = preset.branches || 3;
  for (let b = 0; b < branchCount; b++) {
    const angle = (b / branchCount) * Math.PI * 2 + rng.value(0.5);
    const dir = new THREE.Vector3(
      Math.cos(angle) * 0.3,
      0.8 + rng.value(0.2),
      Math.sin(angle) * 0.3
    ).normalize();

    generateBranchGeometry(
      rng,
      new THREE.Vector3(0, 0, 0),
      dir,
      preset.baseRadius,
      preset.height,
      0,
      preset.maxLevel,
      preset.segments,
      positions, normals, uvs, indices
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// ============================================================
// Brain Coral Geometry (SDF-inspired displacement sphere)
// ============================================================
function buildBrainCoralGeometry(rng, radius, detail) {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;

  // Organic displacement using layered noise
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    // Multi-octave displacement for brain coral texture
    const freq1 = 3.0, freq2 = 7.0, freq3 = 15.0;
    const d1 = Math.sin(x * freq1 + y * 2.0) * Math.cos(z * freq1) * 0.15;
    const d2 = Math.sin(x * freq2 + z * 3.0) * Math.cos(y * freq2 + x) * 0.06;
    const d3 = Math.sin(y * freq3) * Math.cos(x * freq3 + z * freq3) * 0.02;
    const displacement = d1 + d2 + d3;

    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);

    pos.setXYZ(i,
      x + nx * displacement * radius,
      y + ny * displacement * radius,
      z + nz * displacement * radius
    );
  }

  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================
// Fan Coral Geometry (flat profile sweep)
// ============================================================
function buildFanCoralGeometry(rng, width, height, segments) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const rows = segments;
  const cols = segments;

  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const y = t * height;
    const spreadFactor = Math.sin(t * Math.PI) * 0.8 + 0.2;
    const currentWidth = width * spreadFactor;

    for (let c = 0; c <= cols; c++) {
      const s = c / cols;
      const x = (s - 0.5) * currentWidth;

      // Organic waviness
      const wave = Math.sin(s * Math.PI * 4 + t * 3.0) * 0.1 * (1 - t * 0.5);
      const z = wave + Math.sin(t * Math.PI * 2) * 0.05;

      positions.push(x, y, z);

      // Surface normal (approximate)
      const nx = -wave * 2;
      const nz = 1.0;
      const len = Math.sqrt(nx * nx + nz * nz);
      normals.push(nx / len, 0, nz / len);
      uvs.push(s, t);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + (cols + 1);
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================
// Tube/Sponge Coral Geometry (lathe profile)
// ============================================================
function buildTubeCoralGeometry(rng, radius, height, tubeCount) {
  const group = new THREE.Group();
  for (let t = 0; t < tubeCount; t++) {
    const angle = rng.value(Math.PI * 2);
    const dist = rng.value(radius * 0.8);
    const tubeRadius = 0.15 + rng.value(0.2);
    const tubeHeight = height * (0.5 + rng.value(0.5));

    // Lathe profile for tube shape
    const points = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      const r = tubeRadius * (1 + Math.sin(s * Math.PI * 2) * 0.15);
      const y = s * tubeHeight;
      points.push(new THREE.Vector2(r, y));
    }
    // Close top with slight opening
    points.push(new THREE.Vector2(tubeRadius * 1.3, tubeHeight));
    points.push(new THREE.Vector2(tubeRadius * 0.8, tubeHeight + tubeRadius * 0.5));
    points.push(new THREE.Vector2(tubeRadius * 0.3, tubeHeight + tubeRadius * 0.3));

    const geo = new THREE.LatheGeometry(points, 8);
    const mesh = new THREE.Mesh(geo);
    mesh.position.set(
      Math.cos(angle) * dist,
      0,
      Math.sin(angle) * dist
    );
    mesh.rotation.x = rng.value(0.2, -0.2);
    mesh.rotation.z = rng.value(0.2, -0.2);
    group.add(mesh);
  }
  return group;
}

// ============================================================
// Coral Material System (PBR identity from causes)
// ============================================================
function createCoralMaterial(color, type = 'branch') {
  const roughness = type === 'brain' ? 0.78 : type === 'fan' ? 0.64 : 0.7;
  const clearcoat = type === 'fan' ? 0.2 : type === 'tube' ? 0.16 : 0.1;

  return new THREE.MeshPhysicalMaterial({
    color,
    vertexColors: true,
    roughness,
    metalness: 0,
    clearcoat,
    clearcoatRoughness: 0.72,
    side: type === 'fan' ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function applyCoralColorVariation(geometry, color, type) {
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const colors = new Float32Array(positions.count * 3);
  const baseColor = new THREE.Color(color);
  const shadedColor = new THREE.Color();

  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const normalY = normals ? normals.getY(index) : 0;
    const grain = Math.sin(x * 7.1 + z * 5.3 + y * 3.7) * 0.5 + 0.5;
    const cavity = Math.sin(x * 12.7 - y * 9.4 + z * 8.3) * 0.5 + 0.5;
    const surfaceLift = THREE.MathUtils.clamp(normalY * 0.16 + grain * 0.12 - cavity * 0.07, -0.16, 0.22);
    const typeLift = type === 'brain' ? grain * 0.1 : type === 'fan' ? normalY * 0.08 : 0;

    shadedColor.copy(baseColor).multiplyScalar(1 + surfaceLift + typeLift);
    colors[index * 3] = shadedColor.r;
    colors[index * 3 + 1] = shadedColor.g;
    colors[index * 3 + 2] = shadedColor.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ============================================================
// Coral Species Table (structured growth preset)
// ============================================================
const CORAL_SPECIES = [
  // Staghorn-like branching coral
  {
    type: 'branch',
    baseRadius: 0.3,
    height: 4.0,
    maxLevel: 3,
    segments: 8,
    branches: 4,
    colors: [0xff6b9d, 0xff9a76, 0xffc078],
    scale: [0.8, 1.2],
    frequency: 0.25,
  },
  // Elkhorn branching coral
  {
    type: 'branch',
    baseRadius: 0.5,
    height: 3.0,
    maxLevel: 2,
    segments: 6,
    branches: 3,
    colors: [0xd4a574, 0xc9956b, 0xb8845a],
    scale: [1.0, 1.5],
    frequency: 0.15,
  },
  // Brain coral
  {
    type: 'brain',
    radius: 1.5,
    detail: 4,
    colors: [0x8bcc5a, 0x5fa332, 0x7db84a],
    scale: [0.6, 1.4],
    frequency: 0.2,
  },
  // Fan coral
  {
    type: 'fan',
    width: 3.0,
    height: 4.0,
    segments: 16,
    colors: [0xcc44aa, 0x9933cc, 0xff55bb],
    scale: [0.7, 1.3],
    frequency: 0.15,
  },
  // Tube sponge coral
  {
    type: 'tube',
    radius: 1.0,
    height: 3.0,
    tubeCount: 5,
    colors: [0x4488ff, 0x3366cc, 0x55aaff],
    scale: [0.6, 1.0],
    frequency: 0.1,
  },
  // Small mushroom coral (table coral)
  {
    type: 'brain',
    radius: 0.8,
    detail: 3,
    colors: [0xeedd88, 0xddcc66, 0xccbb55],
    scale: [0.5, 1.0],
    frequency: 0.15,
  },
];

// ============================================================
// Reef Compiler (placement + instancing)
// ============================================================
export function compileCoralReef({
  seed = 42,
  clusterCount = 8,
  coralsPerCluster = 12,
  reefRadius = 80,
  seafloorY = -50,
  field,
} = {}) {
  const rng = new SeededRandom(seed);
  const reefGroup = new THREE.Group();
  reefGroup.name = 'coral-reef';

  // Generate deterministic cluster centers
  const clusterCenters = [];
  for (let i = 0; i < clusterCount; i++) {
    const angle = rng.value(Math.PI * 2);
    const dist = rng.value(reefRadius * 0.9, reefRadius * 0.1);
    clusterCenters.push(new THREE.Vector3(
      Math.cos(angle) * dist,
      seafloorY,
      Math.sin(angle) * dist
    ));
  }

  let totalTriangles = 0;

  for (const center of clusterCenters) {
    const clusterGroup = new THREE.Group();
    clusterGroup.position.copy(center);

    for (let c = 0; c < coralsPerCluster; c++) {
      // Select species based on weighted frequency
      const roll = rng.value();
      let cumulative = 0;
      let species = CORAL_SPECIES[0];
      for (const sp of CORAL_SPECIES) {
        cumulative += sp.frequency;
        if (roll <= cumulative) { species = sp; break; }
      }

      const color = species.colors[Math.floor(rng.value(species.colors.length))];
      const scale = rng.value(species.scale[1], species.scale[0]);

      let mesh;

      if (species.type === 'branch') {
        const geo = buildBranchCoralGeometry(rng, species);
        applyCoralColorVariation(geo, color, 'branch');
        const mat = createCoralMaterial(color, 'branch');
        mesh = new THREE.Mesh(geo, mat);
      } else if (species.type === 'brain') {
        const geo = buildBrainCoralGeometry(rng, species.radius, species.detail);
        applyCoralColorVariation(geo, color, 'brain');
        const mat = createCoralMaterial(color, 'brain');
        mesh = new THREE.Mesh(geo, mat);
      } else if (species.type === 'fan') {
        const geo = buildFanCoralGeometry(rng, species.width, species.height, species.segments);
        applyCoralColorVariation(geo, color, 'fan');
        const mat = createCoralMaterial(color, 'fan');
        mesh = new THREE.Mesh(geo, mat);
      } else if (species.type === 'tube') {
        mesh = buildTubeCoralGeometry(rng, species.radius, species.height, species.tubeCount);
        mesh.traverse(child => {
          if (child.isMesh) {
            applyCoralColorVariation(child.geometry, color, 'tube');
            child.material = createCoralMaterial(color, 'tube');
          }
        });
      }

      // Place within cluster with jitter
      const localAngle = rng.value(Math.PI * 2);
      const localDist = rng.value(12, 0.5);
      const localX = Math.cos(localAngle) * localDist;
      const localZ = Math.sin(localAngle) * localDist;
      const worldX = center.x + localX;
      const worldZ = center.z + localZ;
      const reefHeight = field ? field.sampleHeight(worldX, worldZ) : 0;
      mesh.position.set(localX, reefHeight + (species.type === 'brain' ? species.radius * scale : 0), localZ);
      mesh.rotation.y = rng.value(Math.PI * 2);
      mesh.scale.setScalar(scale);

      clusterGroup.add(mesh);

      // Count triangles
      mesh.traverse(child => {
        if (child.isMesh && child.geometry) {
          const idx = child.geometry.index;
          totalTriangles += idx ? idx.count / 3 : child.geometry.attributes.position.count / 3;
        }
      });
    }

    reefGroup.add(clusterGroup);
  }

  console.log(`[coral-reef] Compiled: ${clusterCount} clusters, ~${totalTriangles.toLocaleString()} triangles`);
  return reefGroup;
}

// ============================================================
// Seaweed / Kelp (animated vegetation)
// ============================================================
export function createSeaweed({
  seed = 99,
  count = 30,
  reefRadius = 80,
  seafloorY = -50,
  field,
} = {}) {
  const rng = new SeededRandom(seed);
  const group = new THREE.Group();
  group.name = 'seaweed';

  const seaweedMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d8a4e,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  for (let i = 0; i < count; i++) {
    const x = rng.value(reefRadius, -reefRadius);
    const z = rng.value(reefRadius, -reefRadius);
    const height = rng.value(8, 3);
    const width = rng.value(0.6, 0.2);
    const segments = 12;

    const geo = new THREE.PlaneGeometry(width, height, 1, segments);
    const positions = geo.attributes.position;

    const restPositions = new Float32Array(positions.count * 3);
    for (let v = 0; v < positions.count; v++) {
      const x = positions.getX(v);
      const y = positions.getY(v) + height / 2;
      const z = positions.getZ(v);
      const t = y / height;
      const restZ = z + Math.sin(t * Math.PI * 2 + rng.value(5)) * 0.2 * t;
      positions.setXYZ(v, x, y, restZ);
      restPositions[v * 3] = x;
      restPositions[v * 3 + 1] = y;
      restPositions[v * 3 + 2] = restZ;
    }

    const mesh = new THREE.Mesh(geo, seaweedMaterial.clone());
    mesh.material.color.setHSL(
      0.35 + rng.value(0.1, -0.05),
      0.5 + rng.value(0.3),
      0.25 + rng.value(0.15)
    );
    mesh.position.set(x, seafloorY + (field ? field.sampleHeight(x, z) : 0), z);
    mesh.userData.restPositions = restPositions;
    mesh.userData.height = height;
    mesh.userData.phase = rng.value(Math.PI * 2);
    group.add(mesh);
  }

  return group;
}

export function animateSeaweed(group, time) {
  group.children.forEach((mesh, i) => {
    const positions = mesh.geometry.attributes.position;
    const restPositions = mesh.userData.restPositions;
    const height = mesh.userData.height;

    for (let v = 0; v < positions.count; v++) {
      const offset = v * 3;
      const t = restPositions[offset + 1] / height;
      const sway = Math.sin(time * 1.5 + mesh.userData.phase + t * 2) * t * t * 0.8;
      positions.setXYZ(
        v,
        restPositions[offset] + sway,
        restPositions[offset + 1],
        restPositions[offset + 2] + Math.sin(time * 0.8 + i + t * Math.PI * 2) * 0.3 * t * t,
      );
    }
    positions.needsUpdate = true;
  });
}
