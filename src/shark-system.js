import * as THREE from 'three';

// ============================================================
// AAA Procedural Shark Model
// Following threejs-procedural-geometry build order:
//   1. Define dimensions and semantic segments
//   2. Generate centerline (spine)
//   3. Build local parameterization (oriented rings)
//   4. Emit vertices with intentional seams
//   5. Generate UVs from real distance
//   6. Validate winding, normals
// ============================================================

// ============================================================
// Shark Dimension Contract
// ============================================================
const SHARK_DIMENSIONS = {
  totalLength: 6.0,       // meters nose to tail
  bodyMaxRadius: 0.7,
  headLength: 1.2,
  bodyLength: 2.5,
  tailLength: 2.3,
  dorsalFinHeight: 1.0,
  dorsalFinLength: 1.2,
  pectoralFinSpan: 1.8,
  pectoralFinLength: 1.5,
  caudalFinHeight: 1.5,    // tail fin
  caudalFinLength: 1.2,
  radialSegments: 12,
  spineSegments: 32,
};

// ============================================================
// Spine Profile (cross-section radius along body length)
// ============================================================
function spineProfile(t) {
  // t: 0 = nose, 1 = tail tip
  // Returns radius multiplier
  if (t < 0.05) {
    // Pointed nose
    return 0.15 + t * 6.0;
  } else if (t < 0.2) {
    // Head widening
    return 0.45 + (t - 0.05) * 3.0;
  } else if (t < 0.55) {
    // Main body (widest point around 0.35)
    const bodyT = (t - 0.2) / 0.35;
    return 0.9 + Math.sin(bodyT * Math.PI) * 0.1;
  } else if (t < 0.7) {
    // Taper to caudal peduncle
    const taperT = (t - 0.55) / 0.15;
    return 0.9 - taperT * 0.55;
  } else {
    // Thin caudal peduncle to tail
    const tailT = (t - 0.7) / 0.3;
    return 0.35 - tailT * 0.25;
  }
}

// Cross-section vertical/horizontal aspect ratio (sharks are wider than tall at body)
function crossSectionAspect(t) {
  if (t < 0.15) return { h: 0.9, v: 1.0 }; // Head slightly round
  if (t < 0.6) return { h: 1.2, v: 0.85 }; // Body wider than tall
  return { h: 0.7, v: 0.6 }; // Tail narrow
}

// ============================================================
// Build Shark Body Geometry
// ============================================================
function buildSharkBody(dims) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const skinIndices = [];
  const bellyIndices = [];

  const { spineSegments, radialSegments, totalLength, bodyMaxRadius } = dims;

  // Generate spine centerline
  const spinePoints = [];
  for (let i = 0; i <= spineSegments; i++) {
    const t = i / spineSegments;
    // Shark swims along +Z direction, spine is straight at rest
    spinePoints.push(new THREE.Vector3(0, 0, -t * totalLength + totalLength * 0.2));
  }

  // Emit oriented rings along spine
  for (let i = 0; i <= spineSegments; i++) {
    const t = i / spineSegments;
    const center = spinePoints[i];
    const radius = spineProfile(t) * bodyMaxRadius;
    const aspect = crossSectionAspect(t);

    // Tangent direction
    let tangent;
    if (i < spineSegments) {
      tangent = new THREE.Vector3().subVectors(spinePoints[i + 1], spinePoints[i]).normalize();
    } else {
      tangent = new THREE.Vector3().subVectors(spinePoints[i], spinePoints[i - 1]).normalize();
    }

    // Build frame
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, tangent).normalize();
    const localUp = new THREE.Vector3().crossVectors(tangent, right).normalize();

    // UV distance
    const uDist = t;

    for (let j = 0; j <= radialSegments; j++) {
      const angle = (j / radialSegments) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // Asymmetric cross-section: flatten belly, round top
      let hScale = aspect.h;
      let vScale = aspect.v;

      // Flatten belly (bottom half)
      if (sin < 0) {
        vScale *= 0.85;
      }

      const nx = cos * hScale;
      const ny = sin * vScale;
      const nLen = Math.sqrt(nx * nx + ny * ny);

      positions.push(
        center.x + right.x * cos * radius * hScale + localUp.x * sin * radius * vScale,
        center.y + right.y * cos * radius * hScale + localUp.y * sin * radius * vScale,
        center.z + right.z * cos * radius * hScale + localUp.z * sin * radius * vScale
      );

      normals.push(
        right.x * nx / nLen + localUp.x * ny / nLen,
        right.y * nx / nLen + localUp.y * ny / nLen,
        right.z * nx / nLen + localUp.z * ny / nLen
      );

      uvs.push(j / radialSegments, uDist);
    }
  }

  // Emit indices
  for (let i = 0; i < spineSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * (radialSegments + 1) + j;
      const b = a + 1;
      const c = a + (radialSegments + 1);
      const d = c + 1;
      const angle = ((j + 0.5) / radialSegments) * Math.PI * 2;
      const targetIndices = Math.sin(angle) < -0.22 && i < spineSegments * 0.75
        ? bellyIndices
        : skinIndices;
      targetIndices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([...skinIndices, ...bellyIndices]);
  geometry.addGroup(0, skinIndices.length, 0);
  geometry.addGroup(skinIndices.length, bellyIndices.length, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

// ============================================================
// Fin Geometry (flat profile sweep with taper)
// ============================================================
function buildFinGeometry(width, height, lengthSegments = 8, widthSegments = 4) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let r = 0; r <= lengthSegments; r++) {
    const t = r / lengthSegments;
    const currentWidth = width * (1 - t * 0.7); // Taper towards tip
    const y = t * height;

    // Slight backward sweep
    const sweep = t * t * width * 0.3;

    for (let c = 0; c <= widthSegments; c++) {
      const s = c / widthSegments;
      const x = (s - 0.5) * currentWidth;

      // Fin curvature
      const z = -sweep + Math.sin(s * Math.PI) * 0.05 * (1 - t);

      positions.push(x, y, z);
      normals.push(0, 0, 1); // Will be recomputed
      uvs.push(s, t);
    }
  }

  for (let r = 0; r < lengthSegments; r++) {
    for (let c = 0; c < widthSegments; c++) {
      const a = r * (widthSegments + 1) + c;
      const b = a + 1;
      const d = a + (widthSegments + 1);
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// ============================================================
// Shark Material System
// ============================================================
function createSharkMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x4d7283,
    roughness: 0.38,
    metalness: 0.02,
    clearcoat: 0.18,
    clearcoatRoughness: 0.48,
    side: THREE.DoubleSide,
  });
}

function createSharkBellyMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xd3dee0,
    roughness: 0.48,
    metalness: 0.0,
    clearcoat: 0.08,
    clearcoatRoughness: 0.55,
    side: THREE.DoubleSide,
  });
}

// ============================================================
// Compile Full Shark Assembly
// ============================================================
export function compileShark() {
  const dims = SHARK_DIMENSIONS;
  const group = new THREE.Group();
  group.name = 'shark-assembly';

  const sharkMat = createSharkMaterial();
  const bellyMat = createSharkBellyMaterial();

  // 1. Body
  const bodyGeo = buildSharkBody(dims);
  const body = new THREE.Mesh(bodyGeo, [sharkMat, bellyMat]);
  group.add(body);

  // 2. Dorsal fin
  const dorsalGeo = buildFinGeometry(dims.dorsalFinLength, dims.dorsalFinHeight, 8, 4);
  const dorsal = new THREE.Mesh(dorsalGeo, sharkMat);
  dorsal.position.set(0, dims.bodyMaxRadius * 0.85, -dims.totalLength * 0.15);
  dorsal.rotation.x = -0.15;
  group.add(dorsal);

  // 3. Pectoral fins (left and right)
  const pectoralGeo = buildFinGeometry(dims.pectoralFinLength, dims.pectoralFinSpan * 0.5, 8, 4);

  const pectoralLeft = new THREE.Mesh(pectoralGeo, sharkMat);
  pectoralLeft.position.set(dims.bodyMaxRadius * 0.9, -dims.bodyMaxRadius * 0.3, dims.totalLength * 0.05);
  pectoralLeft.rotation.set(0, 0.3, -Math.PI * 0.35);
  group.add(pectoralLeft);

  const pectoralRight = new THREE.Mesh(pectoralGeo, sharkMat);
  pectoralRight.position.set(-dims.bodyMaxRadius * 0.9, -dims.bodyMaxRadius * 0.3, dims.totalLength * 0.05);
  pectoralRight.rotation.set(0, -0.3, Math.PI * 0.35);
  group.add(pectoralRight);

  // 4. Caudal (tail) fin — two-lobed
  const caudalUpperGeo = buildFinGeometry(dims.caudalFinLength, dims.caudalFinHeight * 0.7, 6, 3);
  const caudalUpper = new THREE.Mesh(caudalUpperGeo, sharkMat);
  caudalUpper.position.set(0, dims.bodyMaxRadius * 0.1, -dims.totalLength * 0.78);
  caudalUpper.rotation.x = -0.5;
  group.add(caudalUpper);

  const caudalLowerGeo = buildFinGeometry(dims.caudalFinLength * 0.6, dims.caudalFinHeight * 0.4, 6, 3);
  const caudalLower = new THREE.Mesh(caudalLowerGeo, sharkMat);
  caudalLower.position.set(0, -dims.bodyMaxRadius * 0.15, -dims.totalLength * 0.78);
  caudalLower.rotation.x = Math.PI + 0.3;
  group.add(caudalLower);
  group.userData.tailParts = [caudalUpper, caudalLower];
  group.userData.pectoralParts = [pectoralLeft, pectoralRight];
  group.userData.restRotations = new Map([
    [caudalUpper, caudalUpper.rotation.clone()],
    [caudalLower, caudalLower.rotation.clone()],
    [pectoralLeft, pectoralLeft.rotation.clone()],
    [pectoralRight, pectoralRight.rotation.clone()],
  ]);

  // 5. Eyes
  const eyeGeo = new THREE.SphereGeometry(0.08, 8, 8);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.8 });
  const eyeLeft = new THREE.Mesh(eyeGeo, eyeMat);
  eyeLeft.position.set(dims.bodyMaxRadius * 0.55, 0.15, dims.totalLength * 0.12);
  group.add(eyeLeft);
  const eyeRight = new THREE.Mesh(eyeGeo, eyeMat);
  eyeRight.position.set(-dims.bodyMaxRadius * 0.55, 0.15, dims.totalLength * 0.12);
  group.add(eyeRight);

  // 6. Gill slits
  for (let side = -1; side <= 1; side += 2) {
    for (let g = 0; g < 5; g++) {
      const slitGeo = new THREE.PlaneGeometry(0.02, 0.2);
      const slitMat = new THREE.MeshStandardMaterial({ color: 0x333333, side: THREE.DoubleSide });
      const slit = new THREE.Mesh(slitGeo, slitMat);
      slit.position.set(
        side * dims.bodyMaxRadius * 0.85,
        -0.1,
        dims.totalLength * 0.08 - g * 0.15
      );
      slit.rotation.y = side * Math.PI * 0.5;
      group.add(slit);
    }
  }

  // Count triangles
  let totalTris = 0;
  group.traverse(child => {
    if (child.isMesh && child.geometry) {
      const idx = child.geometry.index;
      totalTris += idx ? idx.count / 3 : child.geometry.attributes.position.count / 3;
    }
  });
  console.log(`[shark] Compiled: ~${totalTris.toLocaleString()} triangles`);

  return group;
}

// ============================================================
// Shark Animation Controller
// Following threejs-procedural-animation:
//   - Spring-follow motion
//   - Quaternion orientation from velocity
//   - Separate body undulation from trajectory
//   - Frame-rate-independent response
// ============================================================
export class SharkAnimator {
  constructor(sharkGroup) {
    this.group = sharkGroup;
    this.velocity = new THREE.Vector3();
    this.targetPosition = new THREE.Vector3();
    this.dummyObj = new THREE.Object3D();
    this.targetQuaternion = new THREE.Quaternion();
    this.acceleration = new THREE.Vector3();
    this.lookAhead = new THREE.Vector3();
    this.modelForwardCorrection = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI,
    );
    this.rollQuaternion = new THREE.Quaternion();
  }

  setTarget(position) {
    this.targetPosition.copy(position);
  }

  update(elapsed, delta) {
    const springForce = 4.8;
    const damping = 4.4;
    this.acceleration
      .subVectors(this.targetPosition, this.group.position)
      .multiplyScalar(springForce)
      .addScaledVector(this.velocity, -damping);
    this.velocity.addScaledVector(this.acceleration, delta).clampLength(0, 10);
    this.group.position.addScaledVector(this.velocity, delta);

    // Orientation from velocity (direction of travel)
    if (this.velocity.lengthSq() > 0.01) {
      this.lookAhead.copy(this.group.position).add(this.velocity);
      this.dummyObj.position.copy(this.group.position);
      this.dummyObj.lookAt(this.lookAhead);
      this.targetQuaternion.copy(this.dummyObj.quaternion).multiply(this.modelForwardCorrection);
      this.rollQuaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(elapsed * 3.2) * 0.055);
      this.targetQuaternion.multiply(this.rollQuaternion).normalize();
      const slerpFactor = 1 - Math.exp(-8 * delta);
      this.group.quaternion.slerp(this.targetQuaternion, slerpFactor);
    }

    const tailWave = Math.sin(elapsed * 5.2) * 0.22;
    const finLift = Math.sin(elapsed * 2.6) * 0.035;
    const restRotations = this.group.userData.restRotations;
    this.group.userData.tailParts.forEach((part, index) => {
      const rest = restRotations.get(part);
      part.rotation.set(rest.x, rest.y + tailWave * (index === 0 ? 1 : 0.8), rest.z);
    });
    this.group.userData.pectoralParts.forEach((part, index) => {
      const rest = restRotations.get(part);
      part.rotation.set(rest.x, rest.y, rest.z + (index === 0 ? finLift : -finLift));
    });
  }
}

// ============================================================
// Shark Waypoint AI
// ============================================================
export class SharkAI {
  constructor(cameraRef) {
    this.camera = cameraRef;
    this.orbitRadius = 20;
    this.orbitSpeed = 0.35;
    this.verticalRange = 8;
    this.target = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
  }

  update(elapsed) {
    const phase = elapsed * this.orbitSpeed;
    this.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.001) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.right.crossVectors(this.forward, new THREE.Vector3(0, 1, 0)).normalize();

    this.target.copy(this.camera.position)
      .addScaledVector(this.forward, 16 + Math.cos(phase) * 6)
      .addScaledVector(this.right, Math.sin(phase) * this.orbitRadius);
    this.target.y = THREE.MathUtils.clamp(
      this.camera.position.y - 3 + Math.sin(phase * 1.3) * this.verticalRange,
      -48,
      -5,
    );
    return this.target;
  }
}
