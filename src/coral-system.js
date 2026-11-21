import * as THREE from 'three';
import { WORLD_BOUNDS, MEDIUM_GLSL } from './env/medium.js';
import {
  rseed,
  rnd,
  rr,
  vnoise,
  seg2,
  MESAS,
  ARCHES,
  CLEARS,
  bindSharedUniforms,
  createSolidMaterial,
  createSolidShadowMaterial,
} from './env/terrain.js';

// ============================================================================
// Quaternion Math Helpers (Matching GLSL qrot Convention)
// ============================================================================
function qFromAxisAngle(ax, ay, az, angle) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const l = Math.hypot(ax, ay, az) || 1;
  return [ax / l * s, ay / l * s, az / l * s, Math.cos(half)];
}

function qMul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qFromYToNormal(nx, ny, nz, yaw = 0) {
  // Rotate +Y axis to align with surface normal (nx, ny, nz), then apply local yaw
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = nx / len, y = ny / len, z = nz / len;
  let qNorm;
  if (y < -0.999) {
    qNorm = [1, 0, 0, 0];
  } else if (y > 0.9999) {
    qNorm = [0, 0, 0, 1];
  } else {
    // cross([0,1,0], [x,y,z]) = [z, 0, -x], w = 1 + y
    const qx = z, qy = 0, qz = -x, qw = 1 + y;
    const ql = Math.hypot(qx, qy, qz, qw);
    qNorm = [qx / ql, qy / ql, qz / ql, qw / ql];
  }
  const qYaw = qFromAxisAngle(0, 1, 0, yaw);
  return qMul(qNorm, qYaw);
}

function qApplyVec(q, vx, vy, vz) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const cx1 = qy * vz - qz * vy + qw * vx;
  const cy1 = qz * vx - qx * vz + qw * vy;
  const cz1 = qx * vy - qy * vx + qw * vz;
  return [
    vx + 2 * (qy * cz1 - qz * cy1),
    vy + 2 * (qz * cx1 - qx * cz1),
    vz + 2 * (qx * cy1 - qy * cx1),
  ];
}

const _fanY = new THREE.Vector3();
const _fanZ = new THREE.Vector3();
const _fanX = new THREE.Vector3();
const _fanMat = new THREE.Matrix4();
const _fanQ = new THREE.Quaternion();

// Orient Giant Sea Fan so stem (+Y) extends out from cliff along dir=(dx,dy,dz) and broad face stands tilted against water currents
function qAlignFan(dx, dy, dz, twistOffset = 0, faceHint = null) {
  _fanY.set(dx, dy, dz).normalize();
  if (faceHint) {
    _fanZ.set(faceHint[0], faceHint[1], faceHint[2]);
  } else {
    // Tangent roughly perpendicular to wall normal + slightly upward (broadside toward canyon currents, not lying flat!)
    _fanZ.set(-_fanY.z, 0.42, _fanY.x).applyAxisAngle(_fanY, twistOffset);
  }
  _fanZ.addScaledVector(_fanY, -_fanZ.dot(_fanY));
  if (_fanZ.lengthSq() < 1e-4) _fanZ.set(0, 1, 0).cross(_fanY);
  _fanZ.normalize();
  _fanX.crossVectors(_fanY, _fanZ).normalize();
  _fanZ.crossVectors(_fanX, _fanY).normalize();
  _fanMat.makeBasis(_fanX, _fanY, _fanZ);
  _fanQ.setFromRotationMatrix(_fanMat);
  return [_fanQ.x, _fanQ.y, _fanQ.z, _fanQ.w];
}

// ============================================================================
// Procedural Mesh Builder (Exact Geometry Control + Cavity AO)
// ============================================================================
class ProcMesh {
  constructor() {
    this.pos = [];
    this.ao = [];
    this.idx = [];
  }

  v(x, y, z, ao = 1.0) {
    const id = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.ao.push(ao);
    return id;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  tube(points, sides, radiusFn, capStart = false, capEnd = true, aoFn = null) {
    const nPts = points.length;
    if (nPts < 2) return;
    const rings = [];

    // Parallel transport frames to avoid twist artifacts
    let prevT = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
    let up = Math.abs(prevT.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    let binorm = new THREE.Vector3().crossVectors(prevT, up).normalize();
    let norm = new THREE.Vector3().crossVectors(binorm, prevT).normalize();

    for (let i = 0; i < nPts; i++) {
      const t = i / (nPts - 1);
      const p = points[i];
      let tang;
      if (i === 0) tang = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
      else if (i === nPts - 1) tang = new THREE.Vector3().subVectors(points[i], points[i - 1]).normalize();
      else tang = new THREE.Vector3().subVectors(points[i + 1], points[i - 1]).normalize();

      const rotAxis = new THREE.Vector3().crossVectors(prevT, tang);
      const sinA = rotAxis.length();
      if (sinA > 1e-5) {
        rotAxis.divideScalar(sinA);
        const angle = Math.asin(Math.min(1, sinA));
        const q = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);
        norm.applyQuaternion(q).normalize();
        binorm.crossVectors(tang, norm).normalize();
      }
      prevT.copy(tang);

      const rad = typeof radiusFn === 'function' ? radiusFn(t, i) : radiusFn;
      const ring = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const vx = p.x + (norm.x * ca + binorm.x * sa) * rad;
        const vy = p.y + (norm.y * ca + binorm.y * sa) * rad;
        const vz = p.z + (norm.z * ca + binorm.z * sa) * rad;
        const aoVal = aoFn ? aoFn(t, a) : 0.65 + 0.35 * t;
        ring.push(this.v(vx, vy, vz, aoVal));
      }
      rings.push(ring);
    }

    for (let i = 0; i < nPts - 1; i++) {
      const r0 = rings[i];
      const r1 = rings[i + 1];
      for (let s = 0; s < sides; s++) {
        const ns = (s + 1) % sides;
        this.quad(r0[s], r0[ns], r1[ns], r1[s]);
      }
    }

    if (capStart) {
      const center = this.v(points[0].x, points[0].y, points[0].z, 0.6);
      const r0 = rings[0];
      for (let s = 0; s < sides; s++) {
        const ns = (s + 1) % sides;
        this.tri(center, r0[ns], r0[s]);
      }
    }
    if (capEnd) {
      const last = points[nPts - 1];
      const center = this.v(last.x, last.y, last.z, 1.0);
      const rN = rings[nPts - 1];
      for (let s = 0; s < sides; s++) {
        const ns = (s + 1) % sides;
        this.tri(center, rN[s], rN[ns]);
      }
    }
  }

  build() {
    const nv = this.pos.length / 3;
    const pArr = new Float32Array(this.pos);
    const nArr = new Float32Array(nv * 3);
    const aoArr = new Float32Array(this.ao);

    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i], b = this.idx[i + 1], c = this.idx[i + 2];
      const ax = pArr[a * 3], ay = pArr[a * 3 + 1], az = pArr[a * 3 + 2];
      const e1x = pArr[b * 3] - ax, e1y = pArr[b * 3 + 1] - ay, e1z = pArr[b * 3 + 2] - az;
      const e2x = pArr[c * 3] - ax, e2y = pArr[c * 3 + 1] - ay, e2z = pArr[c * 3 + 2] - az;
      const fx = e1y * e2z - e1z * e2y;
      const fy = e1z * e2x - e1x * e2z;
      const fz = e1x * e2y - e1y * e2x;
      nArr[a * 3] += fx; nArr[a * 3 + 1] += fy; nArr[a * 3 + 2] += fz;
      nArr[b * 3] += fx; nArr[b * 3 + 1] += fy; nArr[b * 3 + 2] += fz;
      nArr[c * 3] += fx; nArr[c * 3 + 1] += fy; nArr[c * 3 + 2] += fz;
    }

    for (let i = 0; i < nv; i++) {
      const x = nArr[i * 3], y = nArr[i * 3 + 1], z = nArr[i * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      nArr[i * 3] = x / l;
      nArr[i * 3 + 1] = y / l;
      nArr[i * 3 + 2] = z / l;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pArr, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nArr, 3));
    geo.setAttribute('aAo', new THREE.BufferAttribute(aoArr, 1));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

// ============================================================================
// 10 Sculpted Procedural Reef & Artifact Geometry Archetypes
// ============================================================================

// 1-3. Faceted Cleavage-Sliced Rock Chunks & Boulders (Chiseled Rock Silhouette)
function meshChunk(variant) {
  const ico = new THREE.IcosahedronGeometry(1.0, 2);
  const posAttr = ico.getAttribute('position');
  const m = new ProcMesh();
  rseed(9100 + variant * 131);

  // 4 random rock cleavage planes flatten/chisel sides just like fractured limestone/basalt
  const planes = [];
  for (let p = 0; p < 4; p++) {
    const th = rr(0, Math.PI * 2);
    const cz = rr(-0.6, 0.85);
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
    planes.push([Math.cos(th) * sz, cz, Math.sin(th) * sz, rr(0.52, 0.78)]);
  }

  const map = new Map();
  const vertIds = [];
  const off = variant * 13.7 + 2.1;

  function getV(x, y, z) {
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    if (map.has(k)) return map.get(k);

    const n1 = vnoise(x * 2.1 + off, y * 2.3, z * 2.1 - off) - 0.5;
    const n2 = vnoise(x * 4.8 - off, y * 4.5, z * 4.8 + off) - 0.5;
    let vx = x * (1.0 + n1 * 0.42 + n2 * 0.14);
    let vy = y * (variant === 2 ? 0.62 : 0.76) * (1.0 + n1 * 0.35);
    let vz = z * (variant === 0 ? 1.18 : 1.0) * (1.0 + n1 * 0.38);

    // Cleave protruding vertices sharply against fracture planes
    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      const d = vx * pl[0] + vy * pl[1] + vz * pl[2];
      if (d > pl[3]) {
        const push = d - pl[3];
        vx -= pl[0] * push;
        vy -= pl[1] * push;
        vz -= pl[2] * push;
      }
    }
    vy += 0.12;

    const ao = Math.max(0.35, Math.min(1.0, 0.68 + n1 * 0.45 + Math.max(0, y) * 0.25));
    const vid = m.v(vx, vy, vz, ao);
    map.set(k, vid);
    return vid;
  }

  for (let i = 0; i < posAttr.count; i++) {
    vertIds.push(getV(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
  }

  const idxAttr = ico.index;
  if (idxAttr) {
    for (let i = 0; i < idxAttr.count; i += 3) {
      m.tri(vertIds[idxAttr.getX(i)], vertIds[idxAttr.getX(i + 1)], vertIds[idxAttr.getX(i + 2)]);
    }
  } else {
    for (let i = 0; i < vertIds.length; i += 3) {
      m.tri(vertIds[i], vertIds[i + 1], vertIds[i + 2]);
    }
  }
  ico.dispose();
  return m.build();
}

// 3b. Twisted 3-Strand Kelp Stipe Trunk (Normalized height 0..1)
function meshKelpStipe() {
  const m = new ProcMesh();
  const segsY = 14;
  for (let s = 0; s < 3; s++) {
    const pts = [];
    const ph0 = (s / 3) * Math.PI * 2;
    for (let iy = 0; iy <= segsY; iy++) {
      const t = iy / segsY;
      const twist = ph0 + t * 8.5;
      const spiralR = 0.008 * (1.0 - 0.55 * t) * Math.sin(Math.min(1, t * 4.0) * Math.PI * 0.5);
      const bendX = Math.sin(t * Math.PI * 1.5) * 0.016;
      const bendZ = Math.cos(t * Math.PI * 1.2) * 0.012;
      pts.push(new THREE.Vector3(
        Math.cos(twist) * spiralR + bendX,
        t,
        Math.sin(twist) * spiralR + bendZ
      ));
    }
    m.tube(
      pts,
      5,
      (t) => 0.0042 * (1.15 - 0.60 * t),
      s === 0,
      true,
      (t) => 0.45 + 0.55 * t
    );
  }
  return m.build();
}

// 4-6. Barrel Sponges (fluted exterior + hollow interior throat)
function meshLathe(variant) {
  const m = new ProcMesh();
  const segs = 22;
  // Profile: base -> outer swell -> rim lip -> inner cavity wall down to floor
  const steps = [
    { y: -0.05, r: 0.42, ao: 0.55 },
    { y: 0.18, r: 0.58 + variant * 0.05, ao: 0.75 },
    { y: 0.45, r: 0.70, ao: 0.88 },
    { y: 0.78, r: 0.68 - variant * 0.04, ao: 0.96 },
    { y: 1.05, r: 0.58, ao: 1.0 }, // Top outer rim
    { y: 1.08, r: 0.49, ao: 0.92 }, // Rim crest
    { y: 1.00, r: 0.41, ao: 0.72 }, // Inner mouth entry
    { y: 0.65, r: 0.35, ao: 0.42 },
    { y: 0.25, r: 0.22, ao: 0.24 }, // Deep lumen shadow
  ];

  const rings = [];
  for (let iy = 0; iy < steps.length; iy++) {
    const st = steps[iy];
    const ring = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const flute = 1.0 + Math.sin(a * (7 + variant * 2) + iy * 0.4) * (iy < 5 ? 0.09 : 0.03);
      const lipWave = iy >= 3 && iy <= 6 ? Math.sin(a * 3.0 + variant * 2.1) * 0.06 : 0;
      const r = st.r * flute;
      const vx = Math.cos(a) * r;
      const vz = Math.sin(a) * r;
      const vy = st.y + lipWave;
      ring.push(m.v(vx, vy, vz, st.ao));
    }
    rings.push(ring);
  }

  for (let iy = 0; iy < rings.length - 1; iy++) {
    const r0 = rings[iy];
    const r1 = rings[iy + 1];
    for (let s = 0; s < segs; s++) {
      const ns = (s + 1) % segs;
      m.quad(r0[s], r1[s], r1[ns], r0[ns]);
    }
  }
  // Bottom inner floor center
  const innerBot = m.v(0, 0.18, 0, 0.20);
  const lastRing = rings[rings.length - 1];
  for (let s = 0; s < segs; s++) {
    const ns = (s + 1) % segs;
    m.tri(innerBot, lastRing[s], lastRing[ns]);
  }
  return m.build();
}

// 7 & 8. Branching Staghorn Coral & Gorgonian Fan Coral
function meshCoral(isFan) {
  const m = new ProcMesh();
  rseed(isFan ? 9921 : 4487);

  function grow(origin, dir, length, radius, depth, planeBias) {
    const segs = 4;
    const pts = [origin.clone()];
    const curPos = origin.clone();
    const curDir = dir.clone().normalize();
    const segLen = length / segs;

    for (let i = 1; i <= segs; i++) {
      curDir.x += rr(-0.12, 0.12) * (isFan ? 0.8 : 1.0);
      curDir.y += 0.14;
      curDir.z += rr(-0.12, 0.12) * (isFan ? 0.15 : 1.0);
      if (isFan) curDir.z *= planeBias;
      curDir.normalize();
      curPos.addScaledVector(curDir, segLen);
      pts.push(curPos.clone());
    }

    m.tube(
      pts,
      isFan ? 6 : 7,
      (t) => radius * (1.0 - 0.42 * t),
      depth === 0,
      depth >= (isFan ? 3 : 2),
      (t) => Math.max(0.35, Math.min(1.0, 0.48 + 0.16 * depth + 0.2 * t))
    );

    const maxDepth = isFan ? 3 : 2;
    if (depth < maxDepth) {
      const tip = pts[pts.length - 1];
      const branches = isFan ? (depth === 0 ? 3 : 2) : (depth === 0 ? 4 : 3);
      for (let b = 0; b < branches; b++) {
        const spread = isFan ? 0.55 : 0.65;
        const bDir = curDir.clone();
        const angle = (b / Math.max(1, branches - 1) - 0.5) * 2.0 * spread + rr(-0.15, 0.15);
        if (isFan) {
          bDir.x += Math.sin(angle) * 0.78;
          bDir.y += Math.abs(Math.cos(angle)) * 0.35;
          bDir.z += rr(-0.08, 0.08);
        } else {
          const az = (b / branches) * Math.PI * 2 + rr(-0.35, 0.35);
          bDir.x += Math.cos(az) * 0.65;
          bDir.y += rr(0.25, 0.55);
          bDir.z += Math.sin(az) * 0.65;
        }
        bDir.normalize();
        const startPt = b === 0 ? tip : pts[Math.max(1, pts.length - 2)];
        grow(startPt, bDir, length * rr(0.62, 0.78), radius * 0.62, depth + 1, planeBias);
      }
    }
  }

  grow(
    new THREE.Vector3(0, -0.05, 0),
    new THREE.Vector3(0, 1, 0),
    isFan ? 0.75 : 0.85,
    isFan ? 0.065 : 0.11,
    0,
    isFan ? 0.25 : 1.0
  );
  return m.build();
}

// 9. Organ-Pipe / Tube Coral Cluster
function meshTubes() {
  const m = new ProcMesh();
  rseed(7733);
  const count = 15;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rr(-0.18, 0.18);
    const radial = i < 4 ? rr(0.0, 0.16) : rr(0.2, 0.52);
    const ox = Math.cos(a) * radial;
    const oz = Math.sin(a) * radial;
    const h = i < 4 ? rr(0.95, 1.35) : rr(0.45, 0.95);
    const lean = radial * 0.55;
    const pts = [];
    const steps = 6;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      pts.push(new THREE.Vector3(
        ox + Math.cos(a) * lean * t * t,
        -0.05 + h * t,
        oz + Math.sin(a) * lean * t * t
      ));
    }
    const baseR = rr(0.065, 0.095);
    m.tube(
      pts,
      10,
      (t) => baseR * (0.72 + 0.36 * smoothStepSimple(t)),
      true,
      true,
      (t) => 0.45 + 0.55 * t
    );
  }
  return m.build();
}

function smoothStepSimple(t) {
  return t * t * (3 - 2 * t);
}

// 10. Monumental Stone Whale Fluke
function meshFluke() {
  const m = new ProcMesh();
  // Two swept hydrofoil fluke lobes fanning upward from embedded tail stock
  const segsU = 18;
  const segsV = 12;

  function buildSide(sign) {
    const grid = [];
    for (let iu = 0; iu <= segsU; iu++) {
      const u = iu / segsU; // 0 = base peduncle, 1 = outer tip
      const span = sign * (0.15 + u * 2.55);
      const sweepY = Math.pow(u, 0.72) * 2.45 + (1 - Math.abs(u - 0.55)) * 0.15;
      const sweepZ = -Math.pow(u, 1.4) * 1.15;
      const chord = (1.15 - u * 0.82) * (u < 0.15 ? 0.65 + (u / 0.15) * 0.35 : 1.0);
      const thick = (0.36 * (1 - u * 0.85)) + 0.03;

      const ring = [];
      for (let iv = 0; iv < segsV; iv++) {
        const theta = (iv / segsV) * Math.PI * 2;
        const localZ = Math.cos(theta) * chord;
        const localN = Math.sin(theta) * thick * (Math.cos(theta) > 0 ? 1.1 : 0.85);
        // Slightly twisted dihedral tilt so the monument catches sunlight dramatically
        const vx = span + localN * 0.18 * sign;
        const vy = sweepY + localN * 0.35 - 0.25;
        const vz = sweepZ + localZ * 0.92;
        const ao = Math.max(0.45, Math.min(1.0, 0.6 + 0.4 * u));
        ring.push(m.v(vx, vy, vz, ao));
      }
      grid.push(ring);
    }

    for (let iu = 0; iu < segsU; iu++) {
      const r0 = grid[iu];
      const r1 = grid[iu + 1];
      for (let iv = 0; iv < segsV; iv++) {
        const nv = (iv + 1) % segsV;
        if (sign > 0) m.quad(r0[iv], r0[nv], r1[nv], r1[iv]);
        else m.quad(r0[iv], r1[iv], r1[nv], r0[nv]);
      }
    }
    // Cap wingtip
    const tipRing = grid[segsU];
    const tx = sign * 2.75, ty = 2.45, tz = -1.18;
    const tipV = m.v(tx, ty, tz, 1.0);
    for (let iv = 0; iv < segsV; iv++) {
      const nv = (iv + 1) % segsV;
      if (sign > 0) m.tri(tipV, tipRing[iv], tipRing[nv]);
      else m.tri(tipV, tipRing[nv], tipRing[iv]);
    }
  }

  buildSide(1);
  buildSide(-1);

  // Heavy cylindrical tail peduncle rooted into seabed sand
  const pedPts = [
    new THREE.Vector3(0, -1.2, 0.3),
    new THREE.Vector3(0, -0.35, 0.15),
    new THREE.Vector3(0, 0.4, 0.05),
  ];
  m.tube(pedPts, 14, (t) => 0.72 - t * 0.32, true, true, (t) => 0.48 + t * 0.45);
  return m.build();
}

// 11. GTA-6-Grade Sunken 18th-Century Wooden Galleon Shipwreck
// Thick Double-Walled Oak Hull + Dramatic Smashed Hull Breaches + 16 Exposed Curved Frame Ribs +
// Carved Stern Transom & Mullioned Captain's Cabin Windows + Rudder + Raised Quarterdeck +
// Ship's Helm Wheel + 2 Naval Cannons on Carriages + Open Cargo Hatch Grating + Barrels +
// Splintered Mainmast with Crow's Nest & Snapped Yardarm + Foremast + Bowsprit +
// Draped Catenary Rigging Shrouds + Hanging Admiralty Iron Anchor & Chain
function meshShip() {
  const m = new ProcMesh();
  const stations = 34;
  const arcSegs = 20;
  const length = 13.2;
  const halfLen = length * 0.5;
  const hullThick = 0.16;

  // Helper: oriented wooden plank / structural timber / hardware box with clean outward normals
  function addBox(cx, cy, cz, hx, hy, hz, rotY = 0, rotX = 0, rotZ = 0, aoBot = 0.55, aoTop = 0.92) {
    const cY = Math.cos(rotY), sY = Math.sin(rotY);
    const cX = Math.cos(rotX), sX = Math.sin(rotX);
    const cZ = Math.cos(rotZ), sZ = Math.sin(rotZ);
    const corners = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const verts = corners.map(([lx, ly, lz]) => {
      // Z -> X -> Y rotation
      let x1 = lx * cZ - ly * sZ;
      let y1 = lx * sZ + ly * cZ;
      let z1 = lz;
      let y2 = y1 * cX - z1 * sX;
      let z2 = y1 * sX + z1 * cX;
      let x2 = x1;
      let x3 = x2 * cY + z2 * sY;
      let z3 = -x2 * sY + z2 * cY;
      let y3 = y2;
      return m.v(cx + x3, cy + y3, cz + z3, ly > 0 ? aoTop : aoBot);
    });
    // 6 faces CCW outward
    m.quad(verts[0], verts[3], verts[2], verts[1]); // -Z
    m.quad(verts[4], verts[5], verts[6], verts[7]); // +Z
    m.quad(verts[0], verts[1], verts[5], verts[4]); // -Y
    m.quad(verts[3], verts[7], verts[6], verts[2]); // +Y
    m.quad(verts[0], verts[4], verts[7], verts[3]); // -X
    m.quad(verts[1], verts[2], verts[6], verts[5]); // +X
  }

  function hullBeamAt(u) {
    // Broad galleon amidships, sculpted tumblehome stern (u=0), sharp curving bow (u=1)
    if (u < 0.08) return 1.48 + (u / 0.08) * 0.45;
    if (u > 0.78) {
      const t = (u - 0.78) / 0.22;
      return Math.max(0.06, 2.18 * Math.pow(Math.max(0.0, 1.0 - t), 0.72));
    }
    return 1.93 + Math.sin(((u - 0.08) / 0.70) * Math.PI) * 0.56;
  }

  function hullSheerAt(u) {
    // Classic high raised stern quarterdeck (u < 0.25) & sweeping forecastle bow (u > 0.80)
    const sternLift = u < 0.30 ? Math.pow(1.0 - u / 0.30, 1.8) * 1.15 : 0.0;
    const bowLift = u > 0.74 ? Math.pow((u - 0.74) / 0.26, 1.7) * 0.82 : 0.0;
    return sternLift + bowLift;
  }

  function hullPoint(u, v, inset = 0.0) {
    const z = (u - 0.5) * length;
    const beam = Math.max(0.04, hullBeamAt(u) - inset);
    const sheer = hullSheerAt(u);
    const rocker = Math.pow(u - 0.48, 2.0) * 0.85;
    const a = (v - 0.5) * Math.PI; // -PI/2 port gunwale -> 0 keel -> +PI/2 starboard gunwale
    const absSin = Math.abs(Math.sin(a));
    // Tumblehome slight inward curve near upper gunwale on galleon hull
    const tumble = absSin > 0.82 ? 1.0 - Math.pow((absSin - 0.82) / 0.18, 2.0) * 0.075 : 1.0;
    const x = Math.sin(a) * beam * tumble;
    const y = -Math.cos(a) * (1.62 - inset * 0.65) + rocker + absSin * (0.88 + sheer) + 0.62;
    return [x, y, z];
  }

  // Smashed hull breach masks (starboard midship gash & port forward breach exposing internal oak ribs!)
  function isBreachCell(i, j) {
    const u = (i + 0.5) / stations;
    const v = (j + 0.5) / arcSegs;
    // Dramatic jagged starboard breach amidships
    const d1 = Math.hypot((u - 0.52) / 0.13, (v - 0.84) / 0.16);
    if (d1 < 0.92 + Math.sin(i * 3.1 + j * 2.3) * 0.18) return true;
    // Secondary port forward hull puncture
    const d2 = Math.hypot((u - 0.67) / 0.085, (v - 0.16) / 0.14);
    if (d2 < 0.88 + Math.cos(i * 4.2 - j * 1.9) * 0.16) return true;
    // Broken port waist gunwale bite
    if (u > 0.36 && u < 0.50 && v < 0.12) return true;
    return false;
  }

  // ---- 1. Thick Double-Walled Curved Oak Hull Shell (Outer Planks + Inner Ceiling + Gunwale Cap) ----
  const outerRings = [];
  const innerRings = [];
  for (let i = 0; i <= stations; i++) {
    const u = i / stations;
    const oRing = [];
    const iRing = [];
    for (let j = 0; j <= arcSegs; j++) {
      const v = j / arcSegs;
      const [ox, oy, oz] = hullPoint(u, v, 0.0);
      const [ix, iy, iz] = hullPoint(u, v, hullThick);
      const sideFactor = Math.abs(v - 0.5) * 2.0; // 0 at keel, 1 at gunwale
      const oAo = 0.48 + 0.52 * sideFactor;
      const iAo = 0.24 + 0.44 * sideFactor;
      oRing.push(m.v(ox, oy, oz, oAo));
      iRing.push(m.v(ix, iy, iz, iAo));
    }
    outerRings.push(oRing);
    innerRings.push(iRing);
  }

  for (let i = 0; i < stations; i++) {
    const o0 = outerRings[i], o1 = outerRings[i + 1];
    const n0 = innerRings[i], n1 = innerRings[i + 1];
    for (let j = 0; j < arcSegs; j++) {
      if (isBreachCell(i, j)) continue;
      // Outer hull planks (outward normals)
      m.quad(o0[j], o1[j], o1[j + 1], o0[j + 1]);
      // Inner bilge ceiling planks (inward normals)
      m.quad(n0[j], n0[j + 1], n1[j + 1], n1[j]);
      // Stitch breach boundary thickness caps so smashed hull edges look like thick solid timber!
      if (i > 0 && isBreachCell(i - 1, j)) m.quad(o0[j], o0[j + 1], n0[j + 1], n0[j]);
      if (i < stations - 1 && isBreachCell(i + 1, j)) m.quad(o1[j], n1[j], n1[j + 1], o1[j + 1]);
      if (j > 0 && isBreachCell(i, j - 1)) m.quad(o0[j], n0[j], n1[j], o1[j]);
      if (j < arcSegs - 1 && isBreachCell(i, j + 1)) m.quad(o0[j + 1], o1[j + 1], n1[j + 1], n0[j + 1]);
    }
    // Thick gunwale cap rails along port (j=0) and starboard (j=arcSegs)
    if (!isBreachCell(i, 0)) {
      m.quad(o0[0], n0[0], n1[0], o1[0]);
    }
    if (!isBreachCell(i, arcSegs - 1)) {
      m.quad(o0[arcSegs], o1[arcSegs], n1[arcSegs], n0[arcSegs]);
    }
  }

  // ---- 2. Heavy Structural Oak Keel, Sweeping Stempost Prow & Carved Stern Transom Gallery ----
  // Keel timber along centerline bottom + curved stempost prow rising out front
  const keelPts = [];
  for (let k = 0; k <= 12; k++) {
    const u = k / 12;
    const [kx, ky, kz] = hullPoint(u, 0.5, -0.06);
    keelPts.push(new THREE.Vector3(kx, ky - 0.14, kz));
  }
  keelPts.push(
    new THREE.Vector3(0, 0.35, halfLen + 0.35),
    new THREE.Vector3(0, 1.55, halfLen + 0.72),
    new THREE.Vector3(0, 2.38, halfLen + 0.92)
  );
  m.tube(keelPts, 6, (t) => (t > 0.78 ? 0.17 - (t - 0.78) * 0.25 : 0.22), true, true, (t) => 0.45 + 0.45 * t);

  // Heavy Stern Transom Wall + Ornate Captain's Cabin Gallery (3 Mullioned Stern Windows + Railings)
  const sternZ = -halfLen;
  const sternBeam = hullBeamAt(0.0);
  // Solid lower stern transom planks
  addBox(0, 0.48, sternZ, sternBeam * 0.88, 0.95, 0.14, 0, -0.14, 0, 0.42, 0.74);
  // Stern cabin upper cornice & vertical mullion pillars framing 3 recessed dark cabin windows
  const winY = 1.62;
  addBox(0, winY + 0.56, sternZ - 0.10, sternBeam * 0.92, 0.12, 0.20, 0, 0, 0, 0.65, 0.92);
  addBox(0, winY - 0.44, sternZ - 0.04, sternBeam * 0.90, 0.12, 0.20, 0, 0, 0, 0.55, 0.85);
  // Dark recessed cabin window backing plate
  addBox(0, winY + 0.06, sternZ + 0.08, sternBeam * 0.80, 0.46, 0.06, 0, 0, 0, 0.14, 0.18);
  // 4 Vertical Mullions + Horizontal Transom Bars across cabin windows
  for (let w = -1.5; w <= 1.5; w += 1.0) {
    addBox(w * 0.76, winY + 0.06, sternZ - 0.06, 0.08, 0.50, 0.10, 0, 0, 0, 0.55, 0.88);
  }
  addBox(0, winY + 0.06, sternZ - 0.05, sternBeam * 0.82, 0.045, 0.08, 0, 0, 0, 0.65, 0.88);
  // Tilted Wooden Rudder Blade hinged at sternpost
  addBox(0.18, -0.05, sternZ - 0.46, 0.08, 1.15, 0.48, 0.34, 0, 0, 0.42, 0.75);

  // ---- 3. 16 Continuous Curved Internal Oak Frame Ribs (Visible through Hull Breaches!) ----
  for (let i = 2; i <= stations - 3; i += 2) {
    const u = i / stations;
    const ribPts = [];
    for (let s = 0; s <= 12; s++) {
      const v = 0.02 + (s / 12) * 0.96;
      const [rx, ry, rz] = hullPoint(u, v, hullThick * 0.92);
      ribPts.push(new THREE.Vector3(rx, ry, rz));
    }
    m.tube(ribPts, 5, 0.085, true, true, (t) => 0.38 + 0.52 * Math.abs(t - 0.5) * 2.0);
  }

  // ---- 4. Weathered Planked Main Deck, Shattered Hold Opening, Raised Quarterdeck & Railings ----
  // Raised Quarterdeck floor at stern (z: -halfLen .. -2.8)
  const qDeckY = 1.92;
  for (let p = -4; p <= 4; p++) {
    const px = p * 0.34;
    const plankLen = 1.85 + Math.sin(p * 2.3) * 0.25;
    addBox(px, qDeckY, sternZ + plankLen + 0.12, 0.145, 0.055, plankLen, 0, 0.04, 0, 0.55, 0.88);
  }
  // Quarterdeck forward balustrade rail & stanchions
  addBox(0, qDeckY + 0.68, -2.85, 1.86, 0.07, 0.08, 0, 0, 0, 0.72, 0.95);
  for (let b = -4; b <= 4; b++) {
    if (b === 0) continue; // companionway stair gap
    addBox(b * 0.44, qDeckY + 0.34, -2.85, 0.05, 0.34, 0.05, 0, 0, 0, 0.52, 0.85);
  }
  // Port & Starboard quarterdeck bulwark rail stanchions
  for (const side of [-1, 1]) {
    addBox(side * 1.82, qDeckY + 0.64, -4.65, 0.08, 0.08, 1.92, 0, 0.08, 0, 0.70, 0.95);
    for (let k = 0; k < 5; k++) {
      addBox(side * 1.82, qDeckY + 0.32, -6.3 + k * 0.82, 0.05, 0.34, 0.05, 0, 0, 0, 0.55, 0.85);
    }
  }

  // Hero Wooden Ship's Helm Wheel on Quarterdeck (hub, octagonal rim, 8 turned spokes!)
  {
    const wx = 0.0, wy = qDeckY + 0.78, wz = -4.35;
    // Wheel pedestal & binnacle compass post
    addBox(wx, qDeckY + 0.36, wz - 0.18, 0.14, 0.36, 0.16, 0, 0, 0, 0.52, 0.82);
    addBox(wx, qDeckY + 0.44, wz + 0.38, 0.15, 0.44, 0.15, 0, 0, 0, 0.55, 0.86);
    // Wheel hub axle
    m.tube([new THREE.Vector3(wx, wy, wz - 0.24), new THREE.Vector3(wx, wy, wz + 0.14)], 8, 0.09, true, true, () => 0.78);
    // Outer wheel rim ring + 8 projecting turned handle spokes
    const rimPts = [];
    const rimR = 0.48;
    for (let s = 0; s <= 12; s++) {
      const a = (s / 12) * Math.PI * 2;
      rimPts.push(new THREE.Vector3(wx + Math.cos(a) * rimR, wy + Math.sin(a) * rimR, wz));
    }
    m.tube(rimPts, 6, 0.055, false, false, () => 0.92);
    for (let sp = 0; sp < 8; sp++) {
      const a = (sp / 8) * Math.PI * 2 + 0.18;
      m.tube([
        new THREE.Vector3(wx + Math.cos(a) * 0.06, wy + Math.sin(a) * 0.06, wz),
        new THREE.Vector3(wx + Math.cos(a) * (rimR + 0.22), wy + Math.sin(a) * (rimR + 0.22), wz),
      ], 5, (t) => (t > 0.7 ? 0.032 : 0.026), true, true, () => 0.92);
    }
  }

  // Main Deck Cross-Beams & Partially Shattered Deck Planks (opening into dark cargo hold!)
  for (let i = 9; i <= 29; i += 2) {
    const u = i / stations;
    const z = (u - 0.5) * length;
    const beam = hullBeamAt(u) - 0.22;
    const yDeck = 0.96 + hullSheerAt(u) * 0.72;
    // Dramatic open cargo hold gap amidships (i = 15, 17, 19) with broken splintered stub beams
    if (i === 15 || i === 17 || i === 19) {
      addBox(-beam * 0.68, yDeck, z, beam * 0.30, 0.08, 0.10, 0.06, 0, -0.05, 0.48, 0.80);
      addBox(beam * 0.72, yDeck, z, beam * 0.26, 0.08, 0.10, -0.08, 0, 0.07, 0.48, 0.80);
      continue;
    }
    addBox(0, yDeck, z, beam, 0.085, 0.105, 0, 0, 0, 0.52, 0.84);
  }
  // Forward forecastle deck planking & deck capstan (windlass)
  for (let p = -3; p <= 3; p++) {
    const px = p * 0.32;
    const maxLen = Math.max(0.55, 1.55 - Math.abs(p) * 0.24);
    addBox(px, 1.24, 4.15 - (1.55 - maxLen) * 0.35, 0.14, 0.05, maxLen, 0, -0.06, 0, 0.55, 0.88);
  }
  // Wooden Deck Capstan drum + capstan bars
  m.tube([new THREE.Vector3(0, 1.24, 3.35), new THREE.Vector3(0, 2.02, 3.35)], 10, (t) => 0.28 - Math.sin(t * Math.PI) * 0.06, true, true, () => 0.82);

  // Slatted Wooden Cargo Hatch Coaming & Grating forward of mainmast
  addBox(0, 1.12, 1.55, 0.88, 0.14, 0.92, 0, 0, 0, 0.48, 0.78);
  addBox(0, 1.22, 1.55, 0.74, 0.05, 0.78, 0, 0, 0, 0.18, 0.24); // dark hatch interior
  for (let g = -3; g <= 3; g++) {
    if (g === 1) continue; // one broken missing grate slat!
    addBox(g * 0.21, 1.27, 1.55, 0.04, 0.035, 0.78, 0, 0, 0, 0.65, 0.92);
  }

  // ---- 5. Two Iron Naval Cannons on Stepped Wooden Gun Carriages + Tumbled Cargo Barrels ----
  const cannonSpecs = [
    { x: -1.22, y: 1.18, z: 2.35, rotY: -1.42 },
    { x: 1.25, y: 1.18, z: -1.95, rotY: 1.52 },
  ];
  for (const cn of cannonSpecs) {
    // Stepped oak gun carriage + small wooden truck wheels
    addBox(cn.x, cn.y + 0.16, cn.z, 0.32, 0.16, 0.48, cn.rotY, 0, 0, 0.45, 0.78);
    // Tapered heavy cast-iron cannon barrel + cascabel knob
    const dx = Math.sin(cn.rotY), dz = Math.cos(cn.rotY);
    m.tube([
      new THREE.Vector3(cn.x - dx * 0.58, cn.y + 0.36, cn.z - dz * 0.58),
      new THREE.Vector3(cn.x + dx * 0.92, cn.y + 0.42, cn.z + dz * 0.92),
    ], 10, (t) => (t < 0.12 ? 0.09 : 0.165 - t * 0.058 + (t > 0.88 ? 0.025 : 0.0)), true, true, () => 0.35);
  }

  // Tumbled Oak Cargo Barrels & Sunken Treasure Chest inside the open hold
  const barrelSpecs = [
    { x: 0.75, y: 0.18, z: -0.35, rx: 0.22, rz: 0.45 },
    { x: 0.92, y: 0.24, z: 0.52, rx: 1.48, rz: 0.30 },
    { x: -0.58, y: 0.14, z: -0.85, rx: 0.12, rz: -0.35 },
  ];
  for (const br of barrelSpecs) {
    const bPts = [];
    for (let k = 0; k <= 6; k++) {
      const u = k / 6 - 0.5;
      bPts.push(new THREE.Vector3(
        br.x + Math.sin(br.rz) * u * 0.92,
        br.y + Math.cos(br.rx) * Math.cos(br.rz) * u * 0.92,
        br.z + Math.sin(br.rx) * u * 0.92
      ));
    }
    m.tube(bPts, 10, (t) => 0.26 + Math.sin(t * Math.PI) * 0.08, true, true, () => 0.62);
  }
  // Iron-banded wooden cargo chest resting in hold
  addBox(-0.62, 0.08, 0.35, 0.44, 0.26, 0.28, 0.42, 0.08, -0.14, 0.44, 0.78);

  // ---- 6. Shattered Mainmast with Crow's Nest, Snapped Yardarm, Foremast, Bowsprit & Rigging ----
  // Tall Splintered Mainmast (5.6m) with Crow's Nest Fighting Top platform
  m.tube(
    [
      new THREE.Vector3(0, -0.55, -0.85),
      new THREE.Vector3(0.08, 2.40, -0.92),
      new THREE.Vector3(0.24, 5.25, -1.04),
      new THREE.Vector3(0.32, 5.65, -1.08),
    ],
    10,
    (t) => (t > 0.88 ? 0.13 * (1.0 - (t - 0.88) / 0.12 * 0.65) : 0.27 - t * 0.11),
    true,
    true,
    (t) => 0.55 + 0.42 * t
  );
  // Crow's Nest platform & rim slats around mainmast (y = 3.85)
  addBox(0.16, 3.82, -0.98, 0.76, 0.08, 0.66, 0.04, 0, -0.05, 0.58, 0.92);
  addBox(0.16, 4.06, -1.60, 0.76, 0.16, 0.06, 0.04, 0, -0.05, 0.65, 0.94);
  addBox(0.16, 4.06, -0.36, 0.76, 0.16, 0.06, 0.04, 0, -0.05, 0.65, 0.94);
  addBox(-0.58, 4.06, -0.98, 0.06, 0.16, 0.66, 0.04, 0, -0.05, 0.65, 0.94);
  addBox(0.90, 4.06, -0.98, 0.06, 0.16, 0.66, 0.04, 0, -0.05, 0.65, 0.94);

  // Tilted Snapped Main Yardarm hanging askew across mainmast
  m.tube(
    [
      new THREE.Vector3(-2.45, 2.35, -0.82),
      new THREE.Vector3(0.10, 2.88, -0.92),
      new THREE.Vector3(2.25, 3.22, -1.12),
    ],
    8,
    (t) => 0.115 - Math.abs(t - 0.5) * 0.11,
    true,
    true,
    () => 0.88
  );

  // Shattered Foremast Stump forward of cargo hatch
  m.tube(
    [
      new THREE.Vector3(0, -0.25, 3.75),
      new THREE.Vector3(-0.08, 2.15, 3.82),
      new THREE.Vector3(-0.18, 3.05, 3.92),
    ],
    9,
    (t) => (t > 0.82 ? 0.14 * (1.0 - (t - 0.82) / 0.18 * 0.7) : 0.22 - t * 0.07),
    true,
    true,
    (t) => 0.55 + 0.40 * t
  );

  // Sweeping Bowsprit & Jibboom jutting dramatically over the prow
  m.tube(
    [
      new THREE.Vector3(0, 1.38, halfLen - 1.35),
      new THREE.Vector3(0, 2.18, halfLen + 1.15),
      new THREE.Vector3(0, 2.95, halfLen + 3.65),
    ],
    8,
    (t) => 0.19 - t * 0.125,
    true,
    true,
    () => 0.90
  );

  // Draped Catenary Hemp Rigging Shrouds & Stays sagging gracefully from Crow's Nest to Gunwales & Bowsprit
  function addCatenaryRope(pA, pB, sag = 0.45, r = 0.032) {
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const p = new THREE.Vector3().lerpVectors(pA, pB, t);
      p.y -= Math.sin(t * Math.PI) * sag;
      pts.push(p);
    }
    m.tube(pts, 5, r, false, false, () => 0.76);
  }
  const mastTop = new THREE.Vector3(0.16, 3.75, -0.98);
  addCatenaryRope(mastTop, new THREE.Vector3(-2.12, 1.55, -1.65), 0.32, 0.034);
  addCatenaryRope(mastTop, new THREE.Vector3(-2.18, 1.50, -0.45), 0.28, 0.030);
  addCatenaryRope(mastTop, new THREE.Vector3(2.15, 1.52, -1.55), 0.35, 0.034);
  addCatenaryRope(mastTop, new THREE.Vector3(2.18, 1.48, -0.35), 0.30, 0.030);
  addCatenaryRope(mastTop, new THREE.Vector3(-0.10, 2.75, 3.85), 0.62, 0.036); // Forestay
  addCatenaryRope(new THREE.Vector3(-0.10, 2.75, 3.85), new THREE.Vector3(0, 2.55, halfLen + 2.35), 0.55, 0.032); // Jibstay

  // ---- 7. Heavy Corroded Admiralty Iron Anchor & Draped Anchor Chain off Port Bow ----
  {
    const ax = -1.62, ay = 0.25, az = halfLen - 1.45;
    // Anchor shank
    m.tube([new THREE.Vector3(ax, ay + 1.05, az), new THREE.Vector3(ax - 0.12, ay - 0.55, az + 0.12)], 7, 0.068, true, true, () => 0.34);
    // Wooden/iron anchor stock cross-bar
    m.tube([new THREE.Vector3(ax - 0.18, ay + 0.85, az - 0.52), new THREE.Vector3(ax + 0.14, ay + 0.88, az + 0.52)], 6, 0.055, true, true, () => 0.40);
    // Curved crescent anchor arms + pointed flukes
    const armPts = [];
    for (let k = 0; k <= 10; k++) {
      const u = (k / 10) * 2.0 - 1.0; // -1..+1
      armPts.push(new THREE.Vector3(
        ax - 0.12 + u * 0.62,
        ay - 0.55 + u * u * 0.42,
        az + 0.12 + u * 0.18
      ));
    }
    m.tube(armPts, 6, (t) => 0.065 + (Math.abs(t - 0.5) > 0.36 ? 0.045 : 0.0), true, true, () => 0.32);
    // Anchor chain curving from bow hawsehole down to anchor ring
    addCatenaryRope(new THREE.Vector3(-0.92, 1.55, halfLen - 1.05), new THREE.Vector3(ax, ay + 1.05, az), 0.24, 0.048);
  }

  return m.build();
}

function meshAnemone() {
  const m = new ProcMesh();
  rseed(5519);

  // Fleshy pedal column base anchored onto reef rock (lp.y <= 0.28)
  const colPts = [
    new THREE.Vector3(0, -0.04, 0),
    new THREE.Vector3(0, 0.08, 0),
    new THREE.Vector3(0, 0.18, 0),
    new THREE.Vector3(0, 0.28, 0),
  ];
  const colRadii = [0.34, 0.29, 0.32, 0.36];
  m.tube(colPts, 14, (t, idx) => colRadii[idx] || 0.32, true, true, (t) => 0.25 + 0.25 * t);

  // 40 plump, curved, bulbous-tipped tentacles in 3 concentric rings (8 inner, 14 mid, 18 outer)
  const rings = [
    { count: 8, rad: 0.11, hMin: 0.78, hMax: 0.96, flare: 0.24, rBase: 0.052 },
    { count: 14, rad: 0.21, hMin: 0.72, hMax: 0.90, flare: 0.48, rBase: 0.046 },
    { count: 18, rad: 0.30, hMin: 0.60, hMax: 0.78, flare: 0.72, rBase: 0.040 },
  ];

  const tSteps = 5;
  for (let ri = 0; ri < rings.length; ri++) {
    const rg = rings[ri];
    for (let k = 0; k < rg.count; k++) {
      const a = (k / rg.count) * Math.PI * 2 + ri * 0.37 + rr(-0.12, 0.12);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const h = rr(rg.hMin, rg.hMax);
      const spread = rg.flare + rr(-0.08, 0.10);
      const pts = [];
      for (let s = 0; s <= tSteps; s++) {
        const u = s / tSteps;
        const archR = rg.rad + spread * Math.pow(u, 1.35);
        const curY = 0.20 + u * h * (1.0 - 0.14 * spread * u);
        pts.push(new THREE.Vector3(ca * archR, curY, sa * archR));
      }
      const r0 = rg.rBase;
      m.tube(
        pts,
        6,
        (u) => {
          // Tapered tentacle body with swollen bubble-tip vesicle near u = 0.85..0.95
          const bubble = Math.exp(-Math.pow((u - 0.86) / 0.11, 2.0)) * 0.036;
          return Math.max(0.014, r0 * (1.0 - 0.55 * u) + bubble) * (u > 0.96 ? 0.65 : 1.0);
        },
        false,
        true,
        (u) => 0.25 + 0.75 * u
      );
    }
  }
  return m.build();
}

// 13. GTA-6-Grade Sunken WWII Monoplane Fighter Wreck (Mitsubishi A6M Zero / Radial Fighter)
// High-Res Sculpted Fuselage (28x24) + Exposed 9-Cylinder Finned Radial Engine & Cowl Flaps +
// Oil Cooler Scoop & Nose Gun Troughs + Deep Cockpit Tub (Pilot Seat, Stick, Instrument Coaming,
// Gunsight, Crash Pylon & Shattered Greenhouse Canopy Frames) + Twisted Airfoil 3-Blade Propeller +
// 26-Span NACA Airfoil Wings with Torn Corrosion Bays Exposing Internal Spars/Ribs + 20mm Wing Cannons +
// Dropped Flaps & Ailerons + Sculpted Airfoil Vertical Fin/Deflected Rudder & Horizontal Stabilizers
function meshFighterWreck() {
  const m = new ProcMesh();

  function addBox(cx, cy, cz, hx, hy, hz, rotY = 0, rotX = 0, rotZ = 0, aoBot = 0.45, aoTop = 0.88) {
    const cY = Math.cos(rotY), sY = Math.sin(rotY);
    const cX = Math.cos(rotX), sX = Math.sin(rotX);
    const cZ = Math.cos(rotZ), sZ = Math.sin(rotZ);
    const corners = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const verts = corners.map(([lx, ly, lz]) => {
      const x1 = lx * cZ - ly * sZ;
      const y1 = lx * sZ + ly * cZ;
      const y2 = y1 * cX - lz * sX;
      const z2 = y1 * sX + lz * cX;
      const x3 = x1 * cY + z2 * sY;
      const z3 = -x1 * sY + z2 * cY;
      return m.v(cx + x3, cy + y2, cz + z3, ly > 0 ? aoTop : aoBot);
    });
    m.quad(verts[0], verts[3], verts[2], verts[1]);
    m.quad(verts[4], verts[5], verts[6], verts[7]);
    m.quad(verts[0], verts[1], verts[5], verts[4]);
    m.quad(verts[3], verts[7], verts[6], verts[2]);
    m.quad(verts[0], verts[4], verts[7], verts[3]);
    m.quad(verts[1], verts[2], verts[6], verts[5]);
  }

  // ---- A. High-Resolution Tapered Radial-Engine Fuselage (Tailpost z=-5.25 -> Engine Cowl Lip z=+4.58) ----
  const fStations = [
    { z: -5.25, rx: 0.11, ry: 0.25, y0: 0.15, cockpit: 0 },
    { z: -4.45, rx: 0.24, ry: 0.36, y0: 0.12, cockpit: 0 },
    { z: -3.55, rx: 0.38, ry: 0.48, y0: 0.08, cockpit: 0 },
    { z: -2.55, rx: 0.50, ry: 0.58, y0: 0.04, cockpit: 0 },
    { z: -1.55, rx: 0.60, ry: 0.66, y0: 0.02, cockpit: 0 },
    { z: -0.75, rx: 0.66, ry: 0.72, y0: 0.00, cockpit: 0 },
    { z: -0.45, rx: 0.68, ry: 0.73, y0: 0.00, cockpit: 1 }, // Aft cockpit bulkhead
    { z: 0.15, rx: 0.71, ry: 0.74, y0: 0.00, cockpit: 1 },  // Pilot seat bay
    { z: 0.85, rx: 0.72, ry: 0.75, y0: 0.00, cockpit: 1 },  // Control stick & instrument well
    { z: 1.28, rx: 0.73, ry: 0.75, y0: 0.00, cockpit: 0 },  // Forward windshield cowl deck
    { z: 2.15, rx: 0.74, ry: 0.75, y0: 0.00, cockpit: 0 },  // Nose MG deck
    { z: 3.12, rx: 0.75, ry: 0.75, y0: 0.00, cockpit: 0 },  // Cowl flap ring
    { z: 3.22, rx: 0.78, ry: 0.78, y0: 0.00, cockpit: 0 },  // Flared engine cowling rear lip
    { z: 3.95, rx: 0.74, ry: 0.74, y0: 0.00, cockpit: 0 },  // Engine cowl barrel
    { z: 4.46, rx: 0.65, ry: 0.65, y0: 0.00, cockpit: 0 },  // Rounded NACA cowl nose curve
    { z: 4.58, rx: 0.56, ry: 0.56, y0: 0.00, cockpit: 0 },  // Cowl intake lip
    { z: 4.44, rx: 0.50, ry: 0.50, y0: 0.00, cockpit: 0 },  // Inner cowl intake wall
    { z: 3.62, rx: 0.48, ry: 0.48, y0: 0.00, cockpit: 0 },  // Firewall deep inside radial engine bay
  ];
  const fArcs = 24;
  const fRings = [];
  for (let i = 0; i < fStations.length; i++) {
    const st = fStations[i];
    const ring = [];
    for (let s = 0; s < fArcs; s++) {
      const a = (s / fArcs) * Math.PI * 2;
      const sa = Math.sin(a), ca = Math.cos(a);
      let vx = sa * st.rx;
      let vy = ca * st.ry + st.y0;
      let ao = 0.45 + 0.55 * (0.5 + 0.5 * ca);

      // Authentic WWII radial fighter nose machine-gun troughs on upper engine deck (z: 1.5..3.1)
      if (st.z >= 1.28 && st.z <= 3.15 && ca > 0.78 && Math.abs(sa) > 0.14 && Math.abs(sa) < 0.42) {
        vy -= 0.055;
        ao = 0.34;
      }
      // Deep open cockpit tub recessed inside fuselage with coaming rim
      if (st.cockpit && ca > 0.48) {
        const deep = Math.min(1.0, (ca - 0.48) / 0.25);
        vx *= 1.0 - deep * 0.20;
        vy = st.y0 + 0.36 - deep * 0.64;
        ao = 0.18 + (1.0 - deep) * 0.35;
      }
      if (i >= 16) ao = 0.16; // dark engine bay interior
      ring.push(m.v(vx, vy, st.z, ao));
    }
    fRings.push(ring);
  }
  for (let i = 0; i < fRings.length - 1; i++) {
    const r0 = fRings[i], r1 = fRings[i + 1];
    for (let s = 0; s < fArcs; s++) {
      const ns = (s + 1) % fArcs;
      m.quad(r0[s], r1[s], r1[ns], r0[ns]);
    }
  }
  const tailCap = m.v(0, 0.15, -5.30, 0.65);
  for (let s = 0; s < fArcs; s++) {
    const ns = (s + 1) % fArcs;
    m.tri(tailCap, fRings[0][ns], fRings[0][s]);
  }
  const cowlBackCap = m.v(0, 0.0, 3.58, 0.14);
  const lastRing = fRings[fRings.length - 1];
  for (let s = 0; s < fArcs; s++) {
    const ns = (s + 1) % fArcs;
    m.tri(cowlBackCap, lastRing[s], lastRing[ns]);
  }

  // Ventral chin oil-cooler scoop beneath engine cowl & dorsal radio mast antenna
  addBox(0, -0.78, 3.65, 0.19, 0.12, 0.42, 0, 0.06, 0, 0.38, 0.68);
  m.tube([new THREE.Vector3(0, 0.68, -0.95), new THREE.Vector3(0, 1.38, -1.12)], 6, (t) => 0.042 * (1.0 - t * 0.55), true, true, () => 0.85);

  // ---- B. Exposed 9-Cylinder Finned Radial Engine, Crankcase & Cowl Exhaust Stubs ----
  // Central radial crankcase gear housing inside open nose cowl
  m.tube([new THREE.Vector3(0, 0, 3.68), new THREE.Vector3(0, 0, 4.48)], 12, (t) => 0.28 - t * 0.06, true, true, () => 0.32);
  // 9 Star-burst Radial Engine Cylinders with Cooling Fins & Pushrod Tubes
  for (let c = 0; c < 9; c++) {
    const ang = (c / 9) * Math.PI * 2 + 0.2;
    const dx = Math.sin(ang), dy = Math.cos(ang);
    m.tube([
      new THREE.Vector3(dx * 0.20, dy * 0.20, 4.02),
      new THREE.Vector3(dx * 0.52, dy * 0.52, 4.02),
    ], 8, (t) => 0.092 + Math.sin(t * Math.PI * 6.0) * 0.016, true, true, () => 0.30);
    // Twin pushrod tubes on front face of each radial cylinder
    m.tube([
      new THREE.Vector3(dx * 0.22, dy * 0.22, 4.18),
      new THREE.Vector3(dx * 0.50, dy * 0.50, 4.12),
    ], 5, 0.018, true, true, () => 0.38);
  }
  // Flared exhaust collector stubs protruding along lower-side engine cowl ring
  for (const side of [-1, 1]) {
    for (let e = 0; e < 3; e++) {
      const ey = -0.18 - e * 0.19;
      const ex = side * Math.sqrt(Math.max(0.08, 0.74 * 0.74 - ey * ey));
      m.tube([
        new THREE.Vector3(ex * 0.92, ey, 3.22),
        new THREE.Vector3(ex * 1.09, ey - 0.03, 2.95),
      ], 6, 0.044, true, true, () => 0.26);
    }
  }

  // ---- C. Detailed Open Cockpit Interior + Shattered WWII "Greenhouse" Canopy Frame ----
  // Armored Pilot Bucket Seat + Headrest Crash Pylon + Flight Control Stick + Instrument Panel Coaming
  addBox(0, 0.12, -0.12, 0.24, 0.36, 0.05, 0, -0.18, 0, 0.34, 0.65); // Seat back
  addBox(0, -0.18, 0.12, 0.25, 0.05, 0.24, 0, 0, 0, 0.28, 0.52);     // Seat pan
  addBox(0, 0.58, -0.28, 0.11, 0.26, 0.10, 0, -0.14, 0, 0.42, 0.78); // Roll-over headrest armor pylon
  // Flight control stick (joystick) rising from cockpit floor
  m.tube([new THREE.Vector3(0, -0.22, 0.48), new THREE.Vector3(0.05, 0.24, 0.38)], 6, 0.028, true, true, () => 0.55);
  // Instrument dashboard panel & gunsight ring
  addBox(0, 0.44, 0.96, 0.38, 0.22, 0.08, 0, 0, 0, 0.26, 0.55);
  addBox(0, 0.72, 1.06, 0.06, 0.11, 0.09, 0, 0, 0, 0.45, 0.75);

  // Authentic WWII Multi-Pane "Greenhouse" Canopy Framing (open/shattered glass panes)
  const canopyHoops = [
    { z: 1.24, r: 0.37, y: 0.58, hScale: 1.02 }, // Forward armored windshield arch
    { z: 0.84, r: 0.41, y: 0.60, hScale: 1.12 }, // Windshield rear bow
    { z: 0.22, r: 0.42, y: 0.60, hScale: 1.14 }, // Sliding canopy mid arch
    { z: -0.34, r: 0.38, y: 0.59, hScale: 1.08 }, // Aft canopy hoop
    { z: -0.92, r: 0.30, y: 0.58, hScale: 0.92 }, // Rear turtledeck glazing frame
  ];
  for (let hi = 0; hi < canopyHoops.length; hi++) {
    const h = canopyHoops[hi];
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const th = -Math.PI * 0.48 + (k / 8) * Math.PI * 0.96;
      pts.push(new THREE.Vector3(Math.sin(th) * h.r, h.y + Math.cos(th) * h.r * h.hScale, h.z));
    }
    m.tube(pts, 6, 0.032, true, true, () => 0.82);
  }
  // Canopy longitudinal spine bar + left/right canopy sill rails + windshield center brace
  m.tube([new THREE.Vector3(0, 0.95, 1.24), new THREE.Vector3(0, 1.06, 0.84), new THREE.Vector3(0, 1.07, 0.22), new THREE.Vector3(0, 0.99, -0.34), new THREE.Vector3(0, 0.85, -0.92)], 6, 0.030, true, true, () => 0.84);
  for (const side of [-1, 1]) {
    m.tube([new THREE.Vector3(side * 0.37, 0.60, 1.24), new THREE.Vector3(side * 0.41, 0.62, 0.22), new THREE.Vector3(side * 0.30, 0.60, -0.92)], 5, 0.028, true, true, () => 0.78);
    // Angled windshield A-pillars
    m.tube([new THREE.Vector3(side * 0.20, 0.74, 1.38), new THREE.Vector3(side * 0.22, 1.02, 0.84)], 5, 0.026, true, true, () => 0.82);
  }

  // ---- D. Nose Spinner Cone & Sculpted Twisted-Airfoil 3-Blade Propeller (1 Blade Impact-Curled!) ----
  m.tube(
    [new THREE.Vector3(0, 0, 4.35), new THREE.Vector3(0, 0, 4.78), new THREE.Vector3(0, 0, 5.14)],
    14,
    (t) => (t < 0.45 ? 0.26 : 0.26 * Math.pow(Math.max(0.0, 1.0 - (t - 0.45) / 0.55), 0.72)),
    false,
    true,
    (t) => 0.62 + 0.38 * t
  );
  // 3 Sculpted Twisted Flat-Airfoil Propeller Blades (wide chord paddle shape, NOT round sticks!)
  for (let b = 0; b < 3; b++) {
    const ang = b * (Math.PI * 2 / 3) + 0.35;
    const rx = Math.sin(ang), ry = Math.cos(ang); // radial outward dir
    const tx = Math.cos(ang), ty = -Math.sin(ang); // tangential chord dir
    const isBent = b === 1; // Bottom blade curls backward from reef impact!
    const bSteps = 10;
    const bSec = 8;
    const bRings = [];
    for (let i = 0; i <= bSteps; i++) {
      const u = i / bSteps;
      const rad = 0.16 + u * 1.46;
      const bendZ = isBent ? -Math.pow(Math.max(0, u - 0.25), 1.85) * 1.18 : -u * 0.04;
      const bendR = isBent ? rad * (1.0 - Math.pow(Math.max(0, u - 0.35), 2.0) * 0.28) : rad;
      const chord = 0.065 + Math.sin(Math.pow(u, 0.65) * Math.PI * 0.92) * 0.135;
      const thick = (0.048 * (1.0 - u * 0.78) + 0.008);
      const pitch = 0.78 - u * 0.48; // realistic aerodynamic propeller twist from root to tip!
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const cx = rx * bendR;
      const cy = ry * bendR;
      const cz = 4.76 + bendZ;
      const ring = [];
      for (let j = 0; j < bSec; j++) {
        const a = (j / bSec) * Math.PI * 2;
        const lc = Math.cos(a) * chord;
        const lt = Math.sin(a) * thick;
        const offT = lc * cp - lt * sp;
        const offZ = lc * sp + lt * cp;
        ring.push(m.v(cx + tx * offT, cy + ty * offT, cz + offZ, 0.58 + 0.42 * u));
      }
      bRings.push(ring);
    }
    for (let i = 0; i < bSteps; i++) {
      for (let j = 0; j < bSec; j++) {
        const nj = (j + 1) % bSec;
        m.quad(bRings[i][j], bRings[i + 1][j], bRings[i + 1][nj], bRings[i][nj]);
      }
    }
    const tipV = m.v(rx * (isBent ? 1.18 : 1.64), ry * (isBent ? 1.18 : 1.64), 4.76 + (isBent ? -0.78 : -0.05), 0.92);
    for (let j = 0; j < bSec; j++) {
      const nj = (j + 1) % bSec;
      m.tri(tipV, bRings[bSteps][j], bRings[bSteps][nj]);
    }
  }

  // ---- E. High-Res 26-Span NACA-23012 Main Wings + Torn Skin Bays + Internal Spars/Ribs + 20mm Cannons + Flaps ----
  function buildWingSide(sideSign) {
    const nSpan = 26;
    const spanLen = 5.65;
    const dihedral = 0.088;
    const rootX = sideSign * 0.54;
    // Authentic WWII coral-wreck rectangular torn aluminum skin bays exposing internal rib structure (like Photo 1!)
    const openBays = sideSign < 0
      ? new Set([5, 6, 7, 8, 15, 16, 17, 18])
      : new Set([6, 7, 8, 16, 17, 18]);

    function wingSection(u) {
      const absX = Math.abs(rootX) + u * spanLen;
      const x = sideSign * absX;
      const yBase = -0.24 + u * spanLen * dihedral;
      const zLE = 1.72 - u * 0.48 - Math.pow(u, 3.0) * 0.36;
      const chord = 2.48 * (1.0 - 0.54 * u) - Math.pow(u, 4.0) * 0.24;
      const rootFillet = u < 0.12 ? Math.pow(1.0 - u / 0.12, 2.0) * 0.14 : 0.0;
      const thick = 0.24 * (1.0 - 0.66 * u) + rootFillet;
      return { x, yBase, zLE, chord, thick };
    }

    // 14-point smooth NACA airfoil cross-section around chord
    const foilN = 14;
    const wRings = [];
    for (let i = 0; i <= nSpan; i++) {
      const u = i / nSpan;
      const ws = wingSection(u);
      const ring = [];
      for (let k = 0; k < foilN; k++) {
        const a = (k / foilN) * Math.PI * 2;
        const uChord = 0.5 - 0.5 * Math.cos(a); // 0 = LE -> 1 = TE -> 0 = LE
        const isTop = k <= foilN / 2;
        const yt = 5.0 * (0.2969 * Math.sqrt(Math.max(1e-4, uChord)) - 0.126 * uChord - 0.3516 * uChord * uChord + 0.2843 * Math.pow(uChord, 3) - 0.1015 * Math.pow(uChord, 4));
        const camber = 0.18 * Math.sin(uChord * Math.PI);
        const z = ws.zLE - uChord * ws.chord;
        const y = ws.yBase + (isTop ? (yt + camber) : (-yt * 0.72 + camber * 0.4)) * ws.thick;
        const ao = isTop ? 0.74 + 0.26 * (1.0 - Math.abs(uChord - 0.35)) : 0.42;
        ring.push(m.v(ws.x, y, z, ao));
      }
      wRings.push(ring);
    }

    for (let i = 0; i < nSpan; i++) {
      const r0 = wRings[i], r1 = wRings[i + 1];
      const isCutBay = openBays.has(i);
      for (let k = 0; k < foilN; k++) {
        // Tear open upper-mid aluminum skin panels across openBays (k=2..5) so internal wing ribs & spars shine through!
        if (isCutBay && k >= 2 && k <= 5) continue;
        const nk = (k + 1) % foilN;
        if (sideSign > 0) m.quad(r0[k], r1[k], r1[nk], r0[nk]);
        else m.quad(r0[k], r0[nk], r1[nk], r1[k]);
      }
    }

    // Internal heavy aluminum Main Wing Spars + Stringers visible inside every torn corrosion bay!
    for (const sparFrac of [0.28, 0.54, 0.76]) {
      const sPts = [];
      for (let i = 1; i <= nSpan - 1; i++) {
        const ws = wingSection(i / nSpan);
        sPts.push(new THREE.Vector3(ws.x, ws.yBase + 0.035, ws.zLE - ws.chord * sparFrac));
      }
      m.tube(sPts, 5, (t) => 0.044 * (1.0 - t * 0.42), true, true, () => 0.34);
    }
    // Internal Chordwise Wing Ribs inside open torn bays
    openBays.forEach((bi) => {
      for (const sub of [0.25, 0.75]) {
        const ws = wingSection((bi + sub) / nSpan);
        const zFore = ws.zLE - ws.chord * 0.18;
        const zAft = ws.zLE - ws.chord * 0.86;
        m.tube(
          [
            new THREE.Vector3(ws.x, ws.yBase + 0.055, zFore),
            new THREE.Vector3(ws.x, ws.yBase + 0.068, 0.5 * (zFore + zAft)),
            new THREE.Vector3(ws.x, ws.yBase + 0.025, zAft),
          ],
          5,
          0.028,
          true,
          true,
          () => 0.46
        );
      }
    });

    // Smooth rounded elliptical wingtip fairing cap
    const wsTip = wingSection(1.0);
    const tipCenter = m.v(wsTip.x + sideSign * 0.18, wsTip.yBase + 0.01, wsTip.zLE - wsTip.chord * 0.46, 0.84);
    const tipRing = wRings[nSpan];
    for (let k = 0; k < foilN; k++) {
      const nk = (k + 1) % foilN;
      if (sideSign > 0) m.tri(tipCenter, tipRing[nk], tipRing[k]);
      else m.tri(tipCenter, tipRing[k], tipRing[nk]);
    }

    // Protruding 20mm Type-99 Wing Cannon Barrel on leading edge (u ~ 0.34) + Pitot tube on port wing!
    const gunWs = wingSection(0.34);
    m.tube([
      new THREE.Vector3(gunWs.x, gunWs.yBase + 0.02, gunWs.zLE - 0.10),
      new THREE.Vector3(gunWs.x, gunWs.yBase + 0.02, gunWs.zLE + 0.62),
    ], 7, (t) => 0.036 - t * 0.010, true, true, () => 0.30);
    if (sideSign < 0) {
      const ptWs = wingSection(0.74);
      m.tube([
        new THREE.Vector3(ptWs.x, ptWs.yBase, ptWs.zLE),
        new THREE.Vector3(ptWs.x, ptWs.yBase, ptWs.zLE + 0.48),
      ], 5, 0.014, true, true, () => 0.55);
    }

    // Dropped Split Landing Flap (inner trailing edge) & Deflected Aileron Panel (outer trailing edge)
    const f0 = wingSection(0.10), f1 = wingSection(0.46);
    const fMidX = 0.5 * (f0.x + f1.x);
    const fMidY = 0.5 * (f0.yBase + f1.yBase) - 0.10;
    const fMidZ = 0.5 * (f0.zLE - f0.chord + f1.zLE - f1.chord) - 0.14;
    addBox(fMidX, fMidY, fMidZ, Math.abs(f1.x - f0.x) * 0.48, 0.032, 0.22, sideSign * 0.10, 0.36, sideSign * dihedral, 0.46, 0.78);

    const a0 = wingSection(0.50), a1 = wingSection(0.90);
    const aMidX = 0.5 * (a0.x + a1.x);
    const aMidY = 0.5 * (a0.yBase + a1.yBase) - 0.04;
    const aMidZ = 0.5 * (a0.zLE - a0.chord + a1.zLE - a1.chord) - 0.10;
    addBox(aMidX, aMidY, aMidZ, Math.abs(a1.x - a0.x) * 0.47, 0.028, 0.18, sideSign * 0.12, sideSign > 0 ? 0.18 : -0.14, sideSign * dihedral, 0.50, 0.82);
  }
  buildWingSide(-1);
  buildWingSide(1);

  // ---- F. Sculpted Airfoil Empennage: Vertical Fin + Deflected Rudder + Horizontal Stabilizers & Elevators ----
  // 1. Vertical Stabilizer & slightly deflected Rudder (lofted airfoil, NOT a crude 4-sided tube!)
  {
    const vSteps = 10;
    const vFoil = 10;
    const vRings = [];
    for (let i = 0; i <= vSteps; i++) {
      const u = i / vSteps;
      const y = 0.14 + u * 1.92;
      const zLE = -3.32 - Math.pow(u, 1.15) * 1.02;
      const chord = 1.62 * (1.0 - u * 0.52) * (u > 0.82 ? Math.cos(((u - 0.82) / 0.18) * Math.PI * 0.46) : 1.0);
      const thick = 0.115 * (1.0 - u * 0.72) + 0.012;
      const ring = [];
      for (let k = 0; k < vFoil; k++) {
        const a = (k / vFoil) * Math.PI * 2;
        const uc = 0.5 - 0.5 * Math.cos(a);
        const side = Math.sin(a) >= 0 ? 1 : -1;
        const yt = Math.sin(Math.pow(uc, 0.65) * Math.PI) * thick;
        // Slight realistic rudder deflection to port on trailing 38% of fin
        const rudderSwing = uc > 0.62 ? (uc - 0.62) * 0.24 : 0.0;
        ring.push(m.v(side * yt + rudderSwing, y, zLE - uc * chord, 0.64 + 0.34 * u));
      }
      vRings.push(ring);
    }
    for (let i = 0; i < vSteps; i++) {
      for (let k = 0; k < vFoil; k++) {
        const nk = (k + 1) % vFoil;
        m.quad(vRings[i][k], vRings[i + 1][k], vRings[i + 1][nk], vRings[i][nk]);
      }
    }
    const vTip = m.v(0.05, 2.10, -4.55, 0.90);
    for (let k = 0; k < vFoil; k++) {
      const nk = (k + 1) % vFoil;
      m.tri(vTip, vRings[vSteps][k], vRings[vSteps][nk]);
    }
  }

  // 2. Swept Airfoil Horizontal Stabilizers & Drooping Elevators (Left & Right)
  for (const side of [-1, 1]) {
    const hSteps = 10;
    const hFoil = 10;
    const hRings = [];
    for (let i = 0; i <= hSteps; i++) {
      const u = i / hSteps;
      const x = side * (0.14 + u * 2.08);
      const yBase = 0.18 + u * 0.04;
      const zLE = -3.72 - u * 0.42;
      const chord = 1.12 * (1.0 - u * 0.48) * (u > 0.84 ? Math.cos(((u - 0.84) / 0.16) * Math.PI * 0.46) : 1.0);
      const thick = 0.085 * (1.0 - u * 0.70) + 0.010;
      const ring = [];
      for (let k = 0; k < hFoil; k++) {
        const a = (k / hFoil) * Math.PI * 2;
        const uc = 0.5 - 0.5 * Math.cos(a);
        const topSign = Math.sin(a) >= 0 ? 1 : -1;
        const yt = Math.sin(Math.pow(uc, 0.65) * Math.PI) * thick;
        // Gravity-drooped elevator along trailing 36% of tailplane
        const elevDroop = uc > 0.64 ? -(uc - 0.64) * 0.16 : 0.0;
        ring.push(m.v(x, yBase + topSign * yt + elevDroop, zLE - uc * chord, topSign > 0 ? 0.84 : 0.48));
      }
      hRings.push(ring);
    }
    for (let i = 0; i < hSteps; i++) {
      for (let k = 0; k < hFoil; k++) {
        const nk = (k + 1) % hFoil;
        if (side > 0) m.quad(hRings[i][k], hRings[i + 1][k], hRings[i + 1][nk], hRings[i][nk]);
        else m.quad(hRings[i][k], hRings[i][nk], hRings[i + 1][nk], hRings[i + 1][k]);
      }
    }
    const hTip = m.v(side * 2.28, 0.22, -4.35, 0.82);
    for (let k = 0; k < hFoil; k++) {
      const nk = (k + 1) % hFoil;
      if (side > 0) m.tri(hTip, hRings[hSteps][nk], hRings[hSteps][k]);
      else m.tri(hTip, hRings[hSteps][k], hRings[hSteps][nk]);
    }
  }

  // Fixed rear tailwheel strut under tailpost
  m.tube([new THREE.Vector3(0, -0.04, -4.65), new THREE.Vector3(0, -0.36, -4.78)], 6, 0.042, true, true, () => 0.32);

  return m.build();
}

// 14. Monumental Giant Gorgonian Sea Fan (3D Woody Bifurcating Ribs + Sculpted Ruffled Lace Membrane)
function meshGiantFan() {
  const m = new ProcMesh();
  rseed(88421);

  function ruffleZ(x, rNorm) {
    return (Math.sin(x * 3.1 + rNorm * 2.5) * 0.065 + Math.cos(x * 5.2 - rNorm * 3.1) * 0.032) * rNorm;
  }

  // A. Flared holdfast collar anchoring into vertical drop-off cliff wall (y = -0.12..+0.16, ao <= 0.42 -> opaque!)
  m.tube(
    [new THREE.Vector3(0, -0.12, 0), new THREE.Vector3(0, 0.02, 0), new THREE.Vector3(0, 0.16, 0)],
    8,
    (t) => 0.16 * (1.0 - t * 0.52),
    true,
    false,
    () => 0.26
  );

  // B. Recursive 3D bifurcating mahogany skeletal veins threaded smoothly along the ruffled fan sheet
  function growVein(origin, angle, len, radius, tier) {
    const segs = 4;
    const pts = [origin.clone()];
    let cx = origin.x;
    let cy = origin.y;
    let curAng = angle;
    const segL = len / segs;

    for (let i = 1; i <= segs; i++) {
      curAng += rr(-0.12, 0.12);
      cx += Math.sin(curAng) * segL;
      cy += Math.cos(curAng) * segL;
      const rNorm = Math.min(1.0, Math.hypot(cx, cy - 0.10) / 1.75);
      pts.push(new THREE.Vector3(cx, cy, ruffleZ(cx, rNorm)));
    }

    m.tube(
      pts,
      tier <= 1 ? 5 : 4,
      (t) => Math.max(0.008, radius * (1.0 - 0.45 * t)),
      tier === 0,
      tier >= 3,
      () => Math.min(0.44, 0.22 + tier * 0.06)
    );

    if (tier < 3) {
      const tip = pts[pts.length - 1];
      const branches = tier === 0 ? 3 : 2;
      const spread = tier === 0 ? 0.92 : 0.44;
      for (let b = 0; b < branches; b++) {
        const subOff = (b / Math.max(1, branches - 1) - 0.5) * 2.0 * spread + rr(-0.08, 0.08);
        growVein(tip, curAng + subOff, len * rr(0.66, 0.78), radius * 0.56, tier + 1);
      }
    }
  }
  growVein(new THREE.Vector3(0, 0.10, 0), 0.0, 0.60, 0.040, 0);

  // C. Wide 238° rounded reniform polar lacy membrane (aAo = 0.88..0.98 -> perforated smoothly in GLSL cutout)
  const radRings = 14;
  const angSegs = 42;
  const maxTheta = 2.08;
  const webGrid = [];
  for (let ir = 0; ir <= radRings; ir++) {
    const rt = ir / radRings;
    const row = [];
    for (let ia = 0; ia <= angSegs; ia++) {
      const at = (ia / angSegs - 0.5) * 2.0 * maxTheta;
      const reniform = 1.76 * (0.64 + 0.36 * Math.cos(Math.max(-1.65, Math.min(1.65, at * 0.72))));
      const lobeScale = 1.0 + 0.08 * Math.sin(at * 5.0) + 0.048 * Math.cos(at * 11.0);
      const rMax = reniform * lobeScale;
      const r = 0.08 + rt * rMax;
      const x = Math.sin(at) * r;
      const y = 0.10 + Math.cos(at) * r;
      const z = ruffleZ(x, rt);
      row.push(m.v(x, y, z, 0.88 + 0.10 * rt));
    }
    webGrid.push(row);
  }
  for (let ir = 0; ir < radRings; ir++) {
    for (let ia = 0; ia < angSegs; ia++) {
      const a = webGrid[ir][ia];
      const b = webGrid[ir + 1][ia];
      const c = webGrid[ir + 1][ia + 1];
      const d_ = webGrid[ir][ia + 1];
      m.quad(a, b, c, d_);
    }
  }

  return m.build();
}

// 15. Fractured Coral Rubble & Limestone Reef Shards (breaks up close-range voxel rock transitions)
function meshCoralRubble() {
  const m = new ProcMesh();
  rseed(33107);
  // Cluster of 3 angular limestone shards + 1 dead staghorn branch stub
  const shards = [
    { ox: 0.0, oz: 0.0, rx: 0.42, ry: 0.14, rz: 0.28, yaw: 0.2 },
    { ox: 0.34, oz: 0.22, rx: 0.26, ry: 0.11, rz: 0.22, yaw: 1.5 },
    { ox: -0.28, oz: 0.18, rx: 0.22, ry: 0.09, rz: 0.30, yaw: -0.8 },
  ];
  for (let si = 0; si < shards.length; si++) {
    const s = shards[si];
    const cs = Math.cos(s.yaw);
    const sn = Math.sin(s.yaw);
    const base = [];
    const top = [];
    const nSides = 6;
    for (let k = 0; k < nSides; k++) {
      const a = (k / nSides) * Math.PI * 2;
      const radNoise = 0.78 + rnd() * 0.42;
      const lx = Math.cos(a) * s.rx * radNoise;
      const lz = Math.sin(a) * s.rz * radNoise;
      const wx = s.ox + lx * cs - lz * sn;
      const wz = s.oz + lx * sn + lz * cs;
      base.push(m.v(wx, -0.05, wz, 0.38));
      top.push(m.v(wx * 0.78 + s.ox * 0.22, s.ry * (0.75 + rnd() * 0.5), wz * 0.78 + s.oz * 0.22, 0.85));
    }
    const peak = m.v(s.ox, s.ry * 1.15, s.oz, 0.96);
    for (let k = 0; k < nSides; k++) {
      const nk = (k + 1) % nSides;
      m.quad(base[k], base[nk], top[nk], top[k]);
      m.tri(top[k], top[nk], peak);
    }
  }
  return m.build();
}

// 16. Giant Fluted Tridacna Reef Clam (Corrugated Ivory Shell Valves + Ruffled Electric Velvet Mantle Lip)
function meshReefShell() {
  const m = new ProcMesh();
  const uSegs = 14;
  const vSegs = 6;

  // Build both left & right gaping fluted bivalve shells (aAo = 0.30..0.58)
  for (const side of [-1, 1]) {
    const grid = [];
    for (let iv = 0; iv <= vSegs; iv++) {
      const v = iv / vSegs; // 0 = hinge base -> 1 = fluted rim
      const row = [];
      for (let iu = 0; iu <= uSegs; iu++) {
        const u = iu / uSegs; // 0..1 along shell width
        const a = (u - 0.5) * Math.PI * 0.92;
        const flute = Math.sin(u * Math.PI * 7.0) * 0.055 * v;
        const x = Math.sin(a) * (0.28 + 0.44 * Math.sin(v * Math.PI * 0.78));
        const openAngle = 0.42 + v * 0.48;
        const z = side * (0.04 + Math.sin(openAngle) * v * 0.34 + flute);
        const y = Math.cos(a) * 0.08 + v * 0.44 + Math.cos(u * Math.PI * 7.0) * 0.035 * v;
        row.push(m.v(x, y, z, 0.30 + 0.28 * v));
      }
      grid.push(row);
    }
    for (let iv = 0; iv < vSegs; iv++) {
      for (let iu = 0; iu < uSegs; iu++) {
        const a = grid[iv][iu];
        const b = grid[iv][iu + 1];
        const c = grid[iv + 1][iu + 1];
        const d_ = grid[iv + 1][iu];
        if (side > 0) m.quad(a, b, c, d_);
        else m.quad(a, d_, c, b);
      }
    }
  }

  // Ruffled iridescent velvet mantle protruding gently between shell lips (aAo = 0.85..0.98)
  const mRows = 4;
  const mGrid = [];
  for (let ir = 0; ir <= mRows; ir++) {
    const rt = ir / mRows;
    const row = [];
    for (let iu = 0; iu <= uSegs; iu++) {
      const u = iu / uSegs;
      const a = (u - 0.5) * Math.PI * 0.86;
      const x = Math.sin(a) * (0.58 * (0.45 + 0.55 * rt));
      const wave = Math.sin(u * Math.PI * 9.0) * 0.045 * rt;
      const z = (rt - 0.5) * 0.44 + wave;
      const y = 0.26 + Math.sin(rt * Math.PI) * 0.19 + Math.abs(wave) * 0.4;
      row.push(m.v(x, y, z, 0.84 + 0.14 * Math.sin(rt * Math.PI)));
    }
    mGrid.push(row);
  }
  for (let ir = 0; ir < mRows; ir++) {
    for (let iu = 0; iu < uSegs; iu++) {
      m.quad(mGrid[ir][iu], mGrid[ir][iu + 1], mGrid[ir + 1][iu + 1], mGrid[ir + 1][iu]);
    }
  }
  return m.build();
}

// Base kelp / seagrass blade ribbon geometry (width [-1..1] tapered, height [0..1])
function buildBladeGeometry(segmentsY, widthRatio = 1.0) {
  const pos = [];
  const norm = [];
  const uv = [];
  const ao = [];
  const idx = [];

  for (let iy = 0; iy <= segmentsY; iy++) {
    const t = iy / segmentsY;
    // Smooth natural taper at holdfast & tip
    const w = widthRatio * Math.pow(Math.max(0.0, Math.sin(Math.PI * Math.pow(t, 0.72))), 0.55);
    const waveX = Math.sin(t * Math.PI * 3.0) * 0.04 * t;
    const aoV = 0.38 + 0.62 * Math.pow(t, 0.65);

    pos.push(-w + waveX, t, 0, w + waveX, t, 0);
    norm.push(0, 0, 1, 0, 0, 1);
    uv.push(0, t, 1, t);
    ao.push(aoV, aoV);
  }

  for (let iy = 0; iy < segmentsY; iy++) {
    const b = iy * 2;
    idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aAo', new THREE.Float32BufferAttribute(ao, 1));
  geo.setIndex(idx);
  return geo;
}

// ============================================================================
// Instanced Solid Helper & Ecology Materials (GLSL3)
// ============================================================================
function createInstancedBatch(baseGeo, instances, material, shadowMaterial) {
  const count = instances.length;
  if (count === 0) return null;

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = baseGeo.index;
  geo.attributes.position = baseGeo.attributes.position;
  geo.attributes.normal = baseGeo.attributes.normal;
  geo.attributes.aAo = baseGeo.attributes.aAo;
  if (baseGeo.attributes.uv) geo.attributes.uv = baseGeo.attributes.uv;
  geo.instanceCount = count;

  const posScale = new Float32Array(count * 4);
  const quat = new Float32Array(count * 4);
  const meta = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const it = instances[i];
    const i4 = i * 4;
    posScale[i4] = it.x;
    posScale[i4 + 1] = it.y;
    posScale[i4 + 2] = it.z;
    posScale[i4 + 3] = it.scale;
    quat[i4] = it.q[0];
    quat[i4 + 1] = it.q[1];
    quat[i4 + 2] = it.q[2];
    quat[i4 + 3] = it.q[3];
    meta[i4] = it.kind;
    meta[i4 + 1] = it.seed;
    meta[i4 + 2] = it.zoneTint;
    meta[i4 + 3] = it.extra;
  }

  geo.setAttribute('iPosScale', new THREE.InstancedBufferAttribute(posScale, 4));
  geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(quat, 4));
  geo.setAttribute('iMeta', new THREE.InstancedBufferAttribute(meta, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -25, 0), 260);

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;

  const shadowMesh = new THREE.Mesh(geo, shadowMaterial);
  shadowMesh.frustumCulled = false;

  return { mesh, shadowMesh, count };
}

function createLeafMaterial(sharedUniforms, { shadow = false } = {}) {
  const vs = /* glsl */ `
    attribute float aAo;
    attribute vec4 iPosScale;
    attribute vec4 iQuat;
    attribute vec4 iMeta;

    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec2 vUv;
    out vec4 vMeta;
    out float vAo;

    void main() {
      float t = uv.y;
      float sideX = uv.x * 2.0 - 1.0;
      float kind = floor(iMeta.x + 0.5);
      float seed = iMeta.y;
      float droop = iMeta.w;

      // Blade local dimensions scaled cleanly across 8 marine flora types
      float h = iPosScale.w;
      float w = kind < 1.5 ? 0.19 : (kind < 2.5 ? 0.065 : (kind > 6.5 ? 0.09 : 0.13));

      // Gentle ocean current surge + traveling frond ripple along height
      float ph = seed * 6.2831 + iPosScale.x * 0.14 + iPosScale.z * 0.17;
      float waveSpeed = kind < 1.5 ? 1.05 : 1.75;
      float surge = sin(uTime * waveSpeed + ph - t * 3.8);
      float crossSurge = cos(uTime * waveSpeed * 0.78 + ph * 1.3 - t * 2.9);

      // Arch bend grows smoothly along blade length
      float bend = pow(t, 1.45) * (0.28 + 0.45 * droop) * h;
      float flutter = sin(t * 9.0 + uTime * 2.6 + ph) * 0.05 * w * (kind < 1.5 ? 1.8 : 0.6);

      vec3 lp = vec3(
        position.x * w + surge * (0.22 * t * t * h) + sideX * flutter,
        t * h * (1.0 - 0.16 * droop * t),
        bend * 0.42 + crossSurge * (0.16 * t * t * h) + sin(t * 7.0 + ph) * (kind < 1.5 ? 0.12 : 0.02)
      );

      // Rotate blade gracefully around local Y by helical twist in giant kelp
      if (kind < 1.5) {
        float tw = t * (2.6 + seed * 1.8) + sin(uTime * 0.6 + ph) * 0.25;
        float ct = cos(tw), st = sin(tw);
        lp.xz = mat2(ct, -st, st, ct) * lp.xz;
      }

      // Smooth analytical curved ribbon normal (across-ribbon cylindrical profile + longitudinal bend slope)
      float dBend = 1.45 * pow(max(t, 0.01), 0.45) * (0.28 + 0.45 * droop);
      vec3 ln = normalize(vec3(sideX * 0.58 + flutter * 2.5, -dBend * 0.38, 1.0));
      if (kind < 1.5) {
        float tw = t * (2.6 + seed * 1.8);
        float ct = cos(tw), st = sin(tw);
        ln.xz = mat2(ct, -st, st, ct) * ln.xz;
      }

      vec3 wpRest = iPosScale.xyz + qrot(iQuat, lp);
      vec3 wn = normalize(qrot(iQuat, ln));

      // Real-time swimmer deflection + 3D damped harmonic wake-spring bending (arc-length preserved)
      vec3 rel = wpRest - iPosScale.xyz;
      float restLen = length(rel);
      float flex = pow(t, 1.32) * (0.55 + 0.45 * min(h, 2.6));
      vec3 disp = evalFloraPhysicsDisp(wpRest, iPosScale.xyz, flex);
      float dispLen = length(disp);
      if (dispLen > 0.001) {
        float maxD = restLen * 0.92 + 0.38;
        disp *= (maxD / (dispLen + maxD));
        rel += disp;
        if (restLen > 0.04 && length(rel) > restLen) {
          rel = normalize(rel) * restLen;
        }
        wn = normalize(wn + disp * 0.48);
      }

      vec3 wp = iPosScale.xyz + rel;
      // Keep deflected blades from clipping cleanly across near lens plane
      float camPostD = distance(wp, uCamPos);
      if (camPostD < 0.72) {
        vec3 away = wp - uCamPos;
        wp = uCamPos + (camPostD > 0.02 ? away / camPostD : vec3(0.0, 0.0, 1.0)) * 0.72;
      }

      // Keep blades cleanly beneath ocean waves
      wp.y = min(wp.y, uWaveHeight - 0.35);

      vWPos = wp;
      vWNorm = wn;
      vUv = uv;
      vMeta = iMeta;
      vAo = aAo;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  if (shadow) {
    const fsShadow = /* glsl */ `
      precision highp float;
      in vec2 vUv;
      layout(location = 0) out vec4 fragColor;
      void main() {
        fragColor = vec4(1.0);
      }
    `;
    const mat = new THREE.ShaderMaterial({
      uniforms: sharedUniforms,
      vertexShader: vs,
      fragmentShader: fsShadow,
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1.5,
      polygonOffsetUnits: 1.5,
    });
    return bindSharedUniforms(mat, sharedUniforms);
  }

  const fsColor = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in vec2 vUv;
    in vec4 vMeta;
    in float vAo;

    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 V = normalize(uCamPos - vWPos);
      vec3 N = normalize(vWNorm);
      if (dot(N, V) < 0.0) N = -N;

      float t = vUv.y;
      float edgeDist = abs(vUv.x - 0.5) * 2.0;
      float kind = floor(vMeta.x + 0.5);
      float seed = vMeta.y;
      float zoneTint = vMeta.z;

      // 8 rich abyssal flora species palettes (kelp, seagrass, magenta fans, purple plumes, cave vines)
      vec3 col = vec3(0.14, 0.22, 0.11);
      vec3 sssTint = vec3(0.35, 0.44, 0.16);
      float rimSpec = 0.20;
      float flu = 0.0;

      if (kind < 0.5) {
        // 0: Giant Kelp Fronds (golden-olive amber-brown to translucent emerald-ochre)
        vec3 olive = mix(vec3(0.15, 0.19, 0.07), vec3(0.29, 0.26, 0.09), t);
        olive = mix(olive, vec3(0.24, 0.16, 0.08), fract(seed * 4.7) * 0.45);
        col = olive;
        sssTint = vec3(0.50, 0.46, 0.15);
        rimSpec = 0.26;
      } else if (kind < 1.5) {
        // 1: Deep Kelp Canopy Ribbon (emerald with sunlit amber ribs)
        col = mix(vec3(0.08, 0.16, 0.08), vec3(0.20, 0.28, 0.11), t);
        sssTint = vec3(0.34, 0.50, 0.18);
        rimSpec = 0.24;
      } else if (kind < 2.5) {
        // 2: Seagrass Meadows (lush emerald Posidonia ribbon)
        col = mix(vec3(0.09, 0.18, 0.09), vec3(0.19, 0.30, 0.14), t) * (0.85 + 0.3 * fract(seed * 7.1));
        sssTint = vec3(0.26, 0.44, 0.16);
        rimSpec = 0.16;
      } else if (kind < 3.5) {
        // 3: Vibrant Magenta-Crimson Rhodophyta Sea-Fan Carpet
        vec3 wine = mix(vec3(0.26, 0.04, 0.14), vec3(0.48, 0.08, 0.24), t);
        col = mix(wine, vec3(0.34, 0.09, 0.34), zoneTint * 0.50);
        sssTint = vec3(0.68, 0.16, 0.38);
        flu = 0.42;
        rimSpec = 0.24;
      } else if (kind < 4.5) {
        // 4: Iridescent Dictyota / Peacock-Fan Cyan-Violet Algae
        float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
        vec3 base = mix(vec3(0.10, 0.22, 0.20), vec3(0.22, 0.32, 0.25), t);
        vec3 irid = vec3(0.14, 0.42, 0.50);
        col = mix(base, irid, fres * 0.72);
        sssTint = vec3(0.28, 0.52, 0.48);
        rimSpec = 0.34;
      } else if (kind < 5.5) {
        // 5: Fluorescent Coral-Pink / Royal Violet Sea Plumes
        col = mix(vec3(0.36, 0.08, 0.22), vec3(0.54, 0.20, 0.44), t);
        sssTint = vec3(0.72, 0.24, 0.52);
        flu = 0.55;
        rimSpec = 0.28;
      } else if (kind < 6.5) {
        // 6: Golden-Amber Canyon Fern Fronds
        col = mix(vec3(0.24, 0.15, 0.06), vec3(0.42, 0.29, 0.09), t);
        sssTint = vec3(0.55, 0.40, 0.12);
        flu = 0.20;
        rimSpec = 0.22;
      } else {
        // 7: Hanging Emerald-Teal Overhang Vines
        col = mix(vec3(0.06, 0.14, 0.12), vec3(0.14, 0.28, 0.22), t);
        sssTint = vec3(0.22, 0.42, 0.34);
        rimSpec = 0.26;
      }

      // Central vein & leaf-twinkle micro-glint
      float vein = exp(-pow(edgeDist * 5.0, 2.0));
      col *= mix(1.05, 0.80, vein * 0.55);
      col *= vAo;

      float sh = shadow9(vWPos + N * 0.1);
      vec3 ca = causRGB(vWPos);
      vec3 sunIrr = sunE(vWPos);

      float ndl = max(dot(N, uSunDir), 0.0);
      float back = pow(max(dot(V, -uSunDir), 0.0), 3.0) * 0.85 + max(dot(-N, uSunDir), 0.0) * 0.55;
      vec3 direct = sunIrr * (col * ndl + sssTint * back) * sh * (0.25 + ca * 1.45);
      vec3 ambient = col * (amb(vWPos, N) + sideLight(vWPos, N)) * vAo;
      vec3 glow = col * flu * dot(direct + ambient, vec3(0.12, 0.50, 0.50));

      vec3 H = normalize(V + uSunDir);
      float spec = pow(max(dot(N, H), 0.0), 42.0) * rimSpec * sh;
      vec3 lit = direct + ambient + glow + sunIrr * spec;

      fragColor = vec4(fog(lit, vWPos), 1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fsColor,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  });
  return bindSharedUniforms(mat, sharedUniforms);
}

// ============================================================================
// Subtle Micro-Glints (Crisp Pinprick Sun Sparkles, zero lens blob bloat!)
// ============================================================================
function buildGlints(sharedUniforms, count, originArr) {
  const quadPos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const quadUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(quadUv, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = count;

  const inst = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const src = originArr[i % originArr.length];
    inst[i * 4] = src.x + rr(-1.6, 1.6);
    inst[i * 4 + 1] = src.y + rr(0.3, 4.5);
    inst[i * 4 + 2] = src.z + rr(-1.6, 1.6);
    inst[i * 4 + 3] = rr(0, 1);
  }
  geo.setAttribute('iGlint', new THREE.InstancedBufferAttribute(inst, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), 250);

  const vs = /* glsl */ `
    attribute vec4 iGlint;
    ${MEDIUM_GLSL}
    out vec2 vUv;
    out vec3 vWPos;
    out float vPulse;

    void main() {
      float ph = iGlint.w * 6.2831;
      vec3 center = iGlint.xyz + vec3(
        sin(uTime * 0.7 + ph) * 0.45,
        sin(uTime * 0.9 + ph * 1.4) * 0.35,
        cos(uTime * 0.65 + ph * 0.8) * 0.45
      );
      float ca = caus(center);
      float pulse = smoothstep(0.62, 0.98, sin(uTime * 2.8 + ph * 4.1) * 0.5 + 0.5) * (0.35 + 0.75 * ca);
      float size = (0.008 + 0.014 * iGlint.w) * pulse;
      vec3 wp = center + (uCamRight * position.x + uCamUp * position.y) * size;

      vUv = uv;
      vWPos = wp;
      vPulse = pulse;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec2 vUv;
    in vec3 vWPos;
    in float vPulse;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      float star = exp(-r2 * 7.5);
      float dCam = length(vWPos - uCamPos);
      float att = exp(-max(dCam - 6.0, 0.0) * 0.045) * smoothstep(2.0, 5.5, dCam);
      vec3 col = mix(vec3(0.45, 0.88, 0.96), vec3(0.95, 0.86, 0.60), 0.35) * star * vPulse * att * 0.45;
      fragColor = vec4(col, 1.0);
    }
  `;

  const mat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), sharedUniforms);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

// ============================================================================
// Hydrothermal / Coral Bubble Vents (vsBub / fsBub)
// ============================================================================
function buildBubbles(sharedUniforms, terrain) {
  const vents = [
    { x: 2, z: -12, rate: 1.0 },
    { x: -12, z: 5, rate: 0.9 },
    { x: 16, z: 9, rate: 0.95 },
    { x: 35, z: 22, rate: 1.1 }, // Near whale fluke
    { x: -39, z: -27, rate: 1.05 }, // Near sunken shipwreck
    { x: 5, z: 40, rate: 0.85 }, // Purple grotto
    { x: -29, z: 16, rate: 0.9 },
    { x: 30, z: -14, rate: 0.95 },
    { x: 61.5, z: 64.5, rate: 1.05 }, // Rising silver bubbles inside Blue Hole god rays
    { x: 71.0, z: -25.0, rate: 0.92 }, // Bubbles escaping WWII Fighter Plane cockpit
    { x: 6.0, z: 101.0, rate: 0.95 }, // Bubbles beyond Purple Grotto exit lagoon
  ];

  const perVent = 64;
  const total = vents.length * perVent;
  const quadPos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const quadUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(quadUv, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = total;

  const data = new Float32Array(total * 4);
  for (let vi = 0; vi < vents.length; vi++) {
    const v = vents[vi];
    const baseFloor = terrain.gy(v.x, v.z);
    for (let k = 0; k < perVent; k++) {
      const idx = (vi * perVent + k) * 4;
      data[idx] = v.x + rr(-1.1, 1.1);
      data[idx + 1] = baseFloor + 0.4;
      data[idx + 2] = v.z + rr(-1.1, 1.1);
      data[idx + 3] = (k / perVent) + rr(0, 0.02); // phase
    }
  }
  geo.setAttribute('iBub', new THREE.InstancedBufferAttribute(data, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), 250);

  const vs = /* glsl */ `
    attribute vec4 iBub;
    ${MEDIUM_GLSL}
    out vec2 vUv;
    out vec3 vWPos;
    out float vLife;

    void main() {
      float life = fract(iBub.w + uTime * (0.042 + 0.015 * fract(iBub.x * 13.7)));
      float maxRise = max(4.0, (uWaveHeight - 0.6) - iBub.y);
      float y = iBub.y + life * maxRise;
      float ph = iBub.w * 24.0 + uTime * 2.4;
      vec3 center = vec3(
        iBub.x + sin(ph) * (0.25 + life * 0.9),
        y,
        iBub.z + cos(ph * 0.87) * (0.25 + life * 0.9)
      );
      float radius = (0.045 + 0.08 * fract(iBub.z * 7.3)) * (0.7 + 0.6 * sin(life * 3.14159));
      vec3 wp = center + (uCamRight * position.x + uCamUp * position.y) * radius;

      vUv = uv;
      vWPos = wp;
      vLife = life;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec2 vUv;
    in vec3 vWPos;
    in float vLife;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;

      float rim = pow(r2, 1.8);
      float glint = pow(max(0.0, 1.0 - length(p - vec2(-0.35, 0.38)) * 2.8), 2.5);
      float alpha = (0.14 + 0.62 * rim + 0.85 * glint) * smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.88, 1.0, vLife));

      vec3 bCol = mix(vec3(0.32, 0.62, 0.72), vec3(0.92, 0.98, 1.0), glint + rim * 0.5) * (0.4 + 0.8 * sunE(vWPos));
      vec3 col = fog(bCol, vWPos);
      fragColor = vec4(col, alpha * 0.75);
    }
  `;

  const mat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
  }), sharedUniforms);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

// ============================================================================
// 6,000 Endless Camera-Wrapped Marine Snow Motes (vsSnow / fsSnow)
// ============================================================================
function buildMarineSnow(sharedUniforms, count = 6000) {
  const quadPos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const quadUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(quadUv, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = count;

  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = rr(0, 64);
    seeds[i * 4 + 1] = rr(0, 36);
    seeds[i * 4 + 2] = rr(0, 64);
    seeds[i * 4 + 3] = rr(0.25, 1.0);
  }
  geo.setAttribute('iSnow', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), 400);

  const vs = /* glsl */ `
    attribute vec4 iSnow;
    ${MEDIUM_GLSL}
    out vec2 vUv;
    out float vFade;
    out vec3 vWPos;

    void main() {
      vec3 box = vec3(64.0, 36.0, 64.0);
      vec3 drift = vec3(
        sin(uTime * 0.25 + iSnow.z) * 1.4 + uTime * 0.22,
        -uTime * (0.16 + 0.12 * iSnow.w),
        cos(uTime * 0.21 + iSnow.x) * 1.4
      );
      vec3 rel = mod(iSnow.xyz + drift - uCamPos + box * 0.5, box) - box * 0.5;
      vec3 center = uCamPos + rel;

      // Hide above water surface cleanly
      float subMask = 1.0 - smoothstep(uWaveHeight - 1.0, uWaveHeight - 0.1, center.y);
      float dist = length(rel);
      float boxFade = smoothstep(32.0, 16.0, max(abs(rel.x), abs(rel.z))) * smoothstep(18.0, 9.0, abs(rel.y)) * smoothstep(1.2, 3.5, dist);

      float size = (0.014 + 0.024 * iSnow.w) * subMask;
      vec3 wp = center + (uCamRight * position.x + uCamUp * position.y) * size;

      vUv = uv;
      vWPos = wp;
      vFade = boxFade * subMask * (0.45 + 0.55 * iSnow.w);
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec2 vUv;
    in float vFade;
    in vec3 vWPos;
    layout(location = 0) out vec4 fragColor;

    void main() {
      if (vFade < 0.01) discard;
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      float soft = exp(-r2 * 2.6);
      float ca = caus(vWPos);
      vec3 sCol = (vec3(0.45, 0.56, 0.58) * (0.45 + 0.75 * ca)) * (0.35 + 0.85 * sunE(vWPos));
      fragColor = vec4(fog(sCol, vWPos), soft * vFade * 0.42);
    }
  `;

  const mat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
  }), sharedUniforms);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

// ============================================================================
// World Ecology Compiler (Corals, Sponges, Kelp Pillars, Seagrass, Set Pieces)
// ============================================================================
export function compileWorldEcology(terrain, sharedUniforms, { isMobile = false } = {}) {
  rseed(202611);

  const group = new THREE.Group();
  const shadowGroup = new THREE.Group();

  // Build all 15 sculptural geometries (including WWII Fighter Plane Wreck & Monumental Giant Sea Fan)
  const geoms = {
    chunk0: meshChunk(0),
    chunk1: meshChunk(1),
    chunk2: meshChunk(2),
    kelpStipe: meshKelpStipe(),
    sponge0: meshLathe(0),
    sponge1: meshLathe(1),
    sponge2: meshLathe(2),
    staghorn: meshCoral(false),
    gorgonian: meshCoral(true),
    tubes: meshTubes(),
    fluke: meshFluke(),
    ship: meshShip(),
    anemone: meshAnemone(),
    fighter: meshFighterWreck(),
    giantFan: meshGiantFan(),
    rubble: meshCoralRubble(),
    clam: meshReefShell(),
  };

  const buckets = {
    chunk0: [],
    chunk1: [],
    chunk2: [],
    kelpStipe: [],
    sponge0: [],
    sponge1: [],
    sponge2: [],
    staghorn: [],
    gorgonian: [],
    tubes: [],
    fluke: [],
    ship: [],
    anemone: [],
    fighter: [],
    giantFan: [],
    rubble: [],
    clam: [],
  };

  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();
  const flyPts = [];
  const glintOrigins = [];

  function nearClearing(x, z, margin = 4.0) {
    for (let i = 0; i < CLEARS.length; i++) {
      const c = CLEARS[i];
      const d = c.ax !== undefined ? seg2(x, z, c.ax, c.az, c.bx, c.bz) : Math.hypot(x - c.x, z - c.z);
      if (d < c.r - margin) return true;
    }
    return false;
  }

  // 1. Place Hero Set Pieces: Stone Whale Fluke & Sunken Wooden Shipwreck (Ported from abyssal-garden world.js)
  {
    const fx = -5, fz = -4;
    const fy = terrain.gy(fx, fz);
    buckets.fluke.push({
      x: fx,
      y: fy - 0.6,
      z: fz,
      scale: 2.35,
      q: qMul(qFromAxisAngle(0, 1, 0, 1.2), qMul(qFromAxisAngle(0, 0, 1, 0.16), qFromAxisAngle(1, 0, 0, -0.3))),
      kind: 5,
      seed: 0.3,
      zoneTint: terrain.magAt(fx, fz),
      extra: 1.0,
    });
    flyPts.push(new THREE.Vector3(fx + 6.0, fy + 6.5, fz - 12.0));

    const sx = 59.5, sy = -23.0, sz = 6.0;
    buckets.ship.push({
      x: sx,
      y: sy,
      z: sz,
      scale: 1.65,
      q: qMul(qFromAxisAngle(0, 1, 0, -Math.PI * 0.5), qMul(qFromAxisAngle(0, 0, 1, -0.1), qFromAxisAngle(1, 0, 0, 0.32))),
      kind: 6,
      seed: 0.5,
      zoneTint: 0.0,
      extra: 1.0,
    });
    flyPts.push(new THREE.Vector3(49.7, -33.6, 29.0));

    // 1b. Hero WWII Fighter Plane Wreck perched on NE Sunlit Coral Shelf (71, gy, -25)
    const fwX = 71.0;
    const fwZ = -25.0;
    const fwY = terrain.gy(fwX, fwZ) + 0.52;
    const fwScale = 1.28;
    const fwQ = qMul(
      qFromAxisAngle(0, 1, 0, -2.18),
      qMul(qFromAxisAngle(0, 0, 1, 0.14), qFromAxisAngle(1, 0, 0, -0.14))
    );
    buckets.fighter.push({
      x: fwX,
      y: fwY,
      z: fwZ,
      scale: fwScale,
      q: fwQ,
      kind: 9,
      seed: 0.72,
      zoneTint: 0.0,
      extra: 1.0,
    });
    flyPts.push(new THREE.Vector3(fwX - 4.0, fwY + 3.2, fwZ + 6.0));
    glintOrigins.push(new THREE.Vector3(fwX, fwY + 1.5, fwZ));

    // Low-profile encrusting coral tufts hugging wing roots & reef crevices (matching Photo 1 proportions)
    const wingCorals = [
      { lx: -1.45, ly: -0.14, lz: 0.45, type: 'staghorn', s: 0.44 },
      { lx: -2.40, ly: -0.10, lz: 0.85, type: 'staghorn', s: 0.36 },
      { lx: 1.45, ly: -0.12, lz: 0.65, type: 'anemone', s: 0.38 },
      { lx: 2.35, ly: -0.08, lz: 0.35, type: 'gorgonian', s: 0.46 },
      { lx: -0.95, ly: -0.06, lz: 1.55, type: 'anemone', s: 0.42 },
    ];
    for (let wi = 0; wi < wingCorals.length; wi++) {
      const wc = wingCorals[wi];
      const [ox, oy, oz] = qApplyVec(fwQ, wc.lx * fwScale, wc.ly * fwScale, wc.lz * fwScale);
      const qLoc = qFromYToNormal(0.1, 0.98, 0.1, rr(0, Math.PI * 2));
      const item = {
        x: fwX + ox,
        y: fwY + oy - 0.05,
        z: fwZ + oz,
        scale: wc.s,
        q: qLoc,
        seed: (wi + 1) * 0.31,
        zoneTint: 0.35,
        extra: 1.0,
      };
      if (wc.type === 'sponge') buckets[`sponge${wi % 3}`].push({ ...item, kind: 1 });
      else if (wc.type === 'staghorn') buckets.staghorn.push({ ...item, kind: 2 });
      else if (wc.type === 'gorgonian') buckets.gorgonian.push({ ...item, kind: 3 });
      else if (wc.type === 'tubes') buckets.tubes.push({ ...item, kind: 4 });
      else buckets.anemone.push({ ...item, kind: 8 });
    }

    // 1c. Hero Giant Sea Fan Drop-Off Wall (Photo 4 silhouette: right cliff wall + monumental backlit fans jutting into left open canyon!)
    const wallProbes = [
      { y: -18.8, z: 18.8, s: 2.15, seed: 0.14, twist: 0.0, face: [-0.08, 0.32, -0.94] },
      { y: -23.6, z: 22.8, s: 1.85, seed: 0.28, twist: 0.12, face: [-0.14, 0.28, -0.95] },
      { y: -15.4, z: 24.5, s: 1.65, seed: 0.48, twist: -0.08, face: [-0.12, 0.36, -0.92] },
      { y: -26.8, z: 17.5, s: 1.55, seed: 0.72, twist: 0.16, face: [-0.10, 0.30, -0.94] },
    ];
    for (let pi = 0; pi < wallProbes.length; pi++) {
      const wpSpec = wallProbes[pi];
      let hit = false;
      for (let px = -14.0; px >= -34.0; px -= 0.7) {
        if (terrain.dw(px, wpSpec.y, wpSpec.z) >= -0.05) {
          tmpPos.set(px, wpSpec.y, wpSpec.z);
          terrain.snap(tmpPos, tmpNorm);
          if (terrain.dw(tmpPos.x + tmpNorm.x * 4.5, tmpPos.y, tmpPos.z + tmpNorm.z * 4.5) < -1.8) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      const dx = Math.max(0.65, tmpNorm.x);
      const dy = Math.max(-0.05, Math.min(0.28, tmpNorm.y * 0.25 + 0.12));
      const dz = tmpNorm.z * 0.45;
      const len = Math.hypot(dx, dy, dz) || 1;
      const odx = dx / len, ody = dy / len, odz = dz / len;
      buckets.giantFan.push({
        x: tmpPos.x - odx * 0.20,
        y: tmpPos.y - ody * 0.10,
        z: tmpPos.z - odz * 0.12,
        scale: wpSpec.s,
        q: qAlignFan(odx, ody, odz, wpSpec.twist, wpSpec.face),
        kind: 10,
        seed: wpSpec.seed,
        zoneTint: 0.4,
        extra: 1.0,
      });
      glintOrigins.push(new THREE.Vector3(tmpPos.x + odx * 2.2, tmpPos.y + 0.6, tmpPos.z + odz * 2.2));
    }

    // Hero Giant Sea Fans flanking Blue Hole entrance ledges & canyon drop-offs
    for (let fi = 0; fi < 36; fi++) {
      const nearBH = fi < 8;
      const vid = terrain.pickVertex((x, y, z, nx, ny) => {
        if (Math.abs(ny) > 0.42 || y < -35.5 || y > -10.5) return false;
        if (nearBH) return Math.hypot(x - 42, z - 52) < 16;
        return Math.abs(x) < 92 && Math.abs(z) < 92;
      });
      const fx = terrain.wp[vid * 3];
      const fy = terrain.wp[vid * 3 + 1];
      const fz = terrain.wp[vid * 3 + 2];
      const fnx = terrain.wn[vid * 3];
      const fny = terrain.wn[vid * 3 + 1];
      const fnz = terrain.wn[vid * 3 + 2];
      // Require clear deep drop-off water 4.5m in front of the wall so fan never hits opposite wall
      if (terrain.dw(fx + fnx * 4.5, fy, fz + fnz * 4.5) >= -2.0) continue;
      const scale = nearBH ? rr(1.35, 2.05) : rr(1.25, 2.15);
      const dy = Math.max(-0.12, Math.min(0.42, fny * 0.3 + 0.18));
      buckets.giantFan.push({
        x: fx - fnx * 0.14,
        y: fy - dy * 0.08,
        z: fz - fnz * 0.14,
        scale,
        q: qAlignFan(fnx, dy, fnz, rr(-0.35, 0.35)),
        kind: 10,
        seed: rnd(),
        zoneTint: Math.max(terrain.zoneP(fx, fz), terrain.magAt(fx, fz)),
        extra: 1.0,
      });
    }

    // Blue Hole luminous ray glints & sunlit floor rubble boulder highlights
    for (let gi = 0; gi < 20; gi++) {
      glintOrigins.push(new THREE.Vector3(
        61.5 + rr(-5.5, 5.5),
        rr(-39.0, -10.0),
        64.5 + rr(-5.5, 5.5)
      ));
    }
    flyPts.push(new THREE.Vector3(54.0, -35.0, 68.0));
  }

  // 2a. Cliff-Embedded Cleavage Boulders & abyssal-garden BOULD Formations
  for (let i = 0; i < 4200; i++) {
    const vid = terrain.pickVertex((x, y, z, nx, ny) => ny > 0.18 && ny < 0.82 && y > -44.5 && y < -4.5 && Math.abs(x) < 104 && Math.abs(z) < 104);
    const x = terrain.wp[vid * 3];
    const y = terrain.wp[vid * 3 + 1];
    const z = terrain.wp[vid * 3 + 2];
    const nx = terrain.wn[vid * 3];
    const ny = terrain.wn[vid * 3 + 1];
    const nz = terrain.wn[vid * 3 + 2];
    if (y < -40.5 && nearClearing(x, z, 8.0)) continue;
    if (Math.hypot(x - 71.0, z + 25.0) < 10.5 && y > -26.0) continue; // Keep Fighter Wreck wing bed clear
    if (Math.abs(x - 6.0) < 6.0 && z > 70.0 && z < 104.0 && y > -42.0 && y < -28.0) continue; // Keep Purple Grotto swim-through tunnel clear

    const k = i % 3;
    const scale = (i < 550 && ny > 0.38) ? rr(0.85, 2.05) : rr(0.32, 0.85);
    // Embed deeper into rock wall along inverse normal (abyssal-garden technique)
    buckets[`chunk${k}`].push({
      x: x - nx * scale * 0.34,
      y: y - ny * scale * 0.34,
      z: z - nz * scale * 0.34,
      scale,
      q: qFromYToNormal(nx, ny, nz, rr(0, Math.PI * 2)),
      kind: 0,
      seed: rnd(),
      zoneTint: Math.max(terrain.zoneP(x, z), terrain.magAt(x, z)),
      extra: 1.0,
    });
  }

  // 2b. Seafloor Cobbles & Pebbles (4,500 scattered along canyon floor edges & ledges)
  for (let i = 0; i < 4500; i++) {
    const vid = terrain.pickVertex((x, y, z, nx, ny) => ny > 0.65 && y < -9.0 && Math.abs(x) < 104 && Math.abs(z) < 104);
    const x = terrain.wp[vid * 3];
    const y = terrain.wp[vid * 3 + 1];
    const z = terrain.wp[vid * 3 + 2];
    const nx = terrain.wn[vid * 3];
    const ny = terrain.wn[vid * 3 + 1];
    const nz = terrain.wn[vid * 3 + 2];
    if (nearClearing(x, z, 8.5)) continue;

    const k = i % 3;
    const scale = i < 400 ? rr(0.55, 1.25) : rr(0.14, 0.45);
    buckets[`chunk${k}`].push({
      x: x + rr(-0.5, 0.5),
      y: y - scale * 0.30,
      z: z + rr(-0.5, 0.5),
      scale,
      q: qFromYToNormal(nx, ny, nz, rr(0, Math.PI * 2)),
      kind: 0,
      seed: rnd(),
      zoneTint: Math.max(terrain.zoneP(x, z), terrain.magAt(x, z)),
      extra: 1.0,
    });
  }

  // 3. Clustered Barrel Sponges (75 anchor clusters -> ~260 sponges on canyon shelves & ledges)
  for (let c = 0; c < 75; c++) {
    const isNearCenter = c < 30;
    const vid = terrain.pickVertex((x, y, z, nx, ny) => {
      if (ny < 0.58 || y < -41 || y > -10) return false;
      return isNearCenter ? (Math.abs(x) < 38 && Math.abs(z) < 42) : (Math.abs(x) < 92 && Math.abs(z) < 92);
    });
    const ax = terrain.wp[vid * 3];
    const ay = terrain.wp[vid * 3 + 1];
    const az = terrain.wp[vid * 3 + 2];
    if (nearClearing(ax, az, 4.5)) continue;

    const clusterN = Math.floor(rr(2, 5));
    for (let j = 0; j < clusterN; j++) {
      const ang = rr(0, Math.PI * 2);
      const rad = j === 0 ? 0 : rr(0.55, 1.85);
      tmpPos.set(ax + Math.cos(ang) * rad, ay + 0.6, az + Math.sin(ang) * rad);
      terrain.snap(tmpPos, tmpNorm);
      if (tmpNorm.y < 0.35 || nearClearing(tmpPos.x, tmpPos.z, 3.5) || Math.abs(terrain.dw(tmpPos.x, tmpPos.y, tmpPos.z)) > 0.35) continue;

      const variant = (c + j) % 3;
      const scale = rr(0.75, 1.95);
      buckets[`sponge${variant}`].push({
        x: tmpPos.x,
        y: tmpPos.y - 0.08,
        z: tmpPos.z,
        scale,
        q: qFromYToNormal(tmpNorm.x * 0.4, 0.9 + tmpNorm.y * 0.1, tmpNorm.z * 0.4, rr(0, Math.PI * 2)),
        kind: 1,
        seed: rnd(),
        zoneTint: terrain.magAt(tmpPos.x, tmpPos.z),
        extra: 1.0,
      });
      if ((c + j) % 5 === 0) glintOrigins.push(new THREE.Vector3(tmpPos.x, tmpPos.y + scale * 1.1, tmpPos.z));
    }
  }

  // 4. Clustered Multi-Species Coral Garden (~1,150 corals: Staghorn, Gorgonian Sea Fans, Organ-Pipe Tubes)
  for (let c = 0; c < 340; c++) {
    const isCentral = c < 150;
    const vid = terrain.pickVertex((x, y, z, nx, ny) => {
      if (y > -6.5 || ny < 0.12) return false;
      return isCentral ? (Math.abs(x) < 42 && Math.abs(z) < 48) : (Math.abs(x) < 96 && Math.abs(z) < 96);
    });
    const ax = terrain.wp[vid * 3];
    const ay = terrain.wp[vid * 3 + 1];
    const az = terrain.wp[vid * 3 + 2];
    if (nearClearing(ax, az, 4.5)) continue;

    const clusterN = Math.floor(rr(2, 5));
    for (let j = 0; j < clusterN; j++) {
      const ang = rr(0, Math.PI * 2);
      const rad = j === 0 ? 0 : rr(0.45, 1.65);
      tmpPos.set(ax + Math.cos(ang) * rad, ay + 0.35, az + Math.sin(ang) * rad);
      terrain.snap(tmpPos, tmpNorm);
      if (tmpNorm.y < 0.08 || nearClearing(tmpPos.x, tmpPos.z, 3.8) || Math.abs(terrain.dw(tmpPos.x, tmpPos.y, tmpPos.z)) > 0.35) continue;

      const mz = terrain.magAt(tmpPos.x, tmpPos.z);
      const pz = terrain.zoneP(tmpPos.x, tmpPos.z);
      const tint = Math.min(1, mz + pz * 0.8);

      if (tmpNorm.y < 0.65 || ((c + j) % 3 === 1 && tmpNorm.y < 0.88)) {
        const scale = rr(1.0, 2.4);
        buckets.gorgonian.push({
          x: tmpPos.x,
          y: tmpPos.y,
          z: tmpPos.z,
          scale,
          q: qFromYToNormal(tmpNorm.x * 0.55, Math.max(0.42, tmpNorm.y), tmpNorm.z * 0.55, rr(0, Math.PI * 2)),
          kind: 3,
          seed: rnd(),
          zoneTint: tint,
          extra: 1.0,
        });
      } else if ((c + j) % 2 === 0) {
        const scale = rr(0.90, 2.25);
        buckets.staghorn.push({
          x: tmpPos.x,
          y: tmpPos.y - 0.06,
          z: tmpPos.z,
          scale,
          q: qFromYToNormal(tmpNorm.x * 0.35, 0.92, tmpNorm.z * 0.35, rr(0, Math.PI * 2)),
          kind: 2,
          seed: rnd(),
          zoneTint: tint,
          extra: 1.0,
        });
        if ((c + j) % 6 === 0) glintOrigins.push(new THREE.Vector3(tmpPos.x, tmpPos.y + scale, tmpPos.z));
      } else {
        const scale = rr(0.85, 1.85);
        buckets.tubes.push({
          x: tmpPos.x,
          y: tmpPos.y - 0.05,
          z: tmpPos.z,
          scale,
          q: qFromYToNormal(tmpNorm.x * 0.3, 0.95, tmpNorm.z * 0.3, rr(0, Math.PI * 2)),
          kind: 4,
          seed: rnd(),
          zoneTint: tint,
          extra: 1.0,
        });
      }
    }
  }

  // Curated Hero Sponge & Coral Garden Terrace around (-11, gy, 18) for Vista 3
  const heroCorals = [
    { type: 'sponge', dx: -11.8, dz: 17.5, s: 1.85 },
    { type: 'sponge', dx: -9.8, dz: 16.0, s: 1.55 },
    { type: 'sponge', dx: -13.6, dz: 19.2, s: 2.05 },
    { type: 'sponge', dx: -10.5, dz: 19.8, s: 1.65 },
    { type: 'staghorn', dx: -11.0, dz: 18.8, s: 2.25 },
    { type: 'staghorn', dx: -13.0, dz: 15.8, s: 1.95 },
    { type: 'staghorn', dx: -8.6, dz: 17.6, s: 2.1 },
    { type: 'gorgonian', dx: -11.5, dz: 16.8, s: 2.25 },
    { type: 'gorgonian', dx: -14.4, dz: 17.8, s: 2.4 },
    { type: 'gorgonian', dx: -9.2, dz: 19.2, s: 2.0 },
    { type: 'tubes', dx: -10.0, dz: 18.2, s: 1.65 },
    { type: 'tubes', dx: -12.8, dz: 20.4, s: 1.6 },
  ];
  for (let i = 0; i < heroCorals.length; i++) {
    const h = heroCorals[i];
    const hy = terrain.gy(h.dx, h.dz);
    const norm = terrain.grad(h.dx, hy, h.dz);
    const q = qFromYToNormal(norm.x * 0.35, 0.92, norm.z * 0.35, rr(0, Math.PI * 2));
    if (h.type === 'sponge') {
      buckets[`sponge${i % 3}`].push({ x: h.dx, y: hy - 0.1, z: h.dz, scale: h.s, q, kind: 1, seed: (i + 1) * 0.21, zoneTint: 0.5, extra: 1.0 });
    } else if (h.type === 'staghorn') {
      buckets.staghorn.push({ x: h.dx, y: hy - 0.08, z: h.dz, scale: h.s, q, kind: 2, seed: (i + 1) * 0.19, zoneTint: 0.55, extra: 1.0 });
    } else if (h.type === 'gorgonian') {
      buckets.gorgonian.push({ x: h.dx, y: hy - 0.05, z: h.dz, scale: h.s, q, kind: 3, seed: (i + 1) * 0.27, zoneTint: 0.6, extra: 1.0 });
    } else {
      buckets.tubes.push({ x: h.dx, y: hy - 0.05, z: h.dz, scale: h.s, q, kind: 4, seed: (i + 1) * 0.33, zoneTint: 0.45, extra: 1.0 });
    }
    glintOrigins.push(new THREE.Vector3(h.dx, hy + h.s * 1.1, h.dz));
  }

  // 4b. Swaying Sea Anemone Colonies (~320 distributed + 14 curated hero colonies)
  for (let c = 0; c < 110; c++) {
    const isNear = c < 55;
    const vid = terrain.pickVertex((x, y, z, nx, ny) => {
      if (ny < 0.48 || y < -41.5 || y > -9.0) return false;
      return isNear ? (Math.abs(x) < 42 && Math.abs(z) < 44) : (Math.abs(x) < 92 && Math.abs(z) < 92);
    });
    const ax = terrain.wp[vid * 3];
    const ay = terrain.wp[vid * 3 + 1];
    const az = terrain.wp[vid * 3 + 2];
    if (nearClearing(ax, az, 4.0)) continue;

    const clusterN = Math.floor(rr(2, 5));
    for (let j = 0; j < clusterN; j++) {
      const ang = rr(0, Math.PI * 2);
      const rad = j === 0 ? 0 : rr(0.35, 1.35);
      tmpPos.set(ax + Math.cos(ang) * rad, ay + 0.4, az + Math.sin(ang) * rad);
      terrain.snap(tmpPos, tmpNorm);
      if (tmpNorm.y < 0.40 || nearClearing(tmpPos.x, tmpPos.z, 3.0) || Math.abs(terrain.dw(tmpPos.x, tmpPos.y, tmpPos.z)) > 0.35) continue;

      const scale = rr(0.85, 1.85);
      buckets.anemone.push({
        x: tmpPos.x,
        y: tmpPos.y - 0.04,
        z: tmpPos.z,
        scale,
        q: qFromYToNormal(tmpNorm.x * 0.45, Math.max(0.6, tmpNorm.y), tmpNorm.z * 0.45, rr(0, Math.PI * 2)),
        kind: 8,
        seed: rnd(),
        zoneTint: terrain.magAt(tmpPos.x, tmpPos.z),
        extra: 1.0,
      });
    }
  }

  const heroAnemones = [
    // Sponge & Anemone Terrace (Viewpoint 3)
    { x: -9.5, z: 16.4, s: 1.65, seed: 0.12 },
    { x: -10.8, z: 17.2, s: 1.85, seed: 0.48 },
    { x: -12.4, z: 16.5, s: 1.55, seed: 0.82 },
    { x: -8.9, z: 18.5, s: 1.45, seed: 0.22 },
    { x: -12.2, z: 18.8, s: 1.75, seed: 0.61 },
    // Canyon walls flanking Viewpoint 1 & 2 (Cathedral Arch & Canyon ledges)
    { x: -7.5, z: 6.5, s: 1.95, seed: 0.18 },
    { x: 8.2, z: 5.0, s: 2.05, seed: 0.54 },
    { x: -6.8, z: -4.5, s: 1.80, seed: 0.78 },
    { x: 7.4, z: -5.5, s: 1.85, seed: 0.28 },
    { x: -5.2, z: -12.0, s: 1.90, seed: 0.58 },
    { x: 5.5, z: -11.5, s: 1.75, seed: 0.90 },
    { x: -8.5, z: 12.0, s: 1.85, seed: 0.41 },
    { x: 7.2, z: 11.5, s: 1.80, seed: 0.74 },
    { x: -13.2, z: 15.2, s: 1.70, seed: 0.16 },
  ];
  for (let i = 0; i < heroAnemones.length; i++) {
    const ha = heroAnemones[i];
    const fl = terrain.floorsAt(ha.x, ha.z);
    // Prefer canyon wall shelf ledge if present, otherwise seabed floor — never snap blindly in mid-water!
    const chosen = fl[fl.length - 1];
    tmpPos.set(ha.x, chosen.y, ha.z);
    tmpNorm.copy(chosen.n);
    if (Math.abs(terrain.dw(tmpPos.x, tmpPos.y, tmpPos.z)) > 0.45) continue;
    buckets.anemone.push({
      x: tmpPos.x,
      y: tmpPos.y - 0.08,
      z: tmpPos.z,
      scale: ha.s,
      q: qFromYToNormal(tmpNorm.x * 0.4, Math.max(0.65, tmpNorm.y), tmpNorm.z * 0.4, rr(0, Math.PI * 2)),
      kind: 8,
      seed: ha.seed,
      zoneTint: 0.6,
      extra: 1.0,
    });
  }

  // 4c. High-Density Micro Coral Rubble Shards (~2,200) & Giant Fluted Tridacna Reef Clams (~72)
  for (let i = 0; i < 2200; i++) {
    const nearLandmark = i < 700;
    const vid = terrain.pickVertex((x, y, z, nx, ny) => {
      if (ny < 0.42 || y > -9.0) return false;
      if (nearLandmark) {
        return (
          (Math.abs(x) < 38 && Math.abs(z) < 42) ||
          Math.hypot(x - 71, z + 25) < 18 ||
          Math.hypot(x - 61.5, z - 64.5) < 22 ||
          Math.hypot(x - 6, z - 84) < 22
        );
      }
      return Math.abs(x) < 102 && Math.abs(z) < 102;
    });
    const rx = terrain.wp[vid * 3];
    const ry = terrain.wp[vid * 3 + 1];
    const rz = terrain.wp[vid * 3 + 2];
    const rnx = terrain.wn[vid * 3];
    const rny = terrain.wn[vid * 3 + 1];
    const rnz = terrain.wn[vid * 3 + 2];
    if (Math.hypot(rx - 71.0, rz + 25.0) < 7.2 && ry > -25.0) continue;
    if (Math.abs(rx - 6.0) < 5.5 && rz > 71.0 && rz < 101.0 && ry > -42.0 && ry < -29.0) continue;
    const scale = rr(0.35, 1.05);
    buckets.rubble.push({
      x: rx,
      y: ry - 0.04,
      z: rz,
      scale,
      q: qFromYToNormal(rnx, rny, rnz, rr(0, Math.PI * 2)),
      kind: 0,
      seed: rnd(),
      zoneTint: Math.max(terrain.zoneP(rx, rz), terrain.magAt(rx, rz)),
      extra: 1.0,
    });
  }

  for (let ci = 0; ci < 72; ci++) {
    const isNear = ci < 36;
    const vid = terrain.pickVertex((x, y, z, nx, ny) => {
      if (ny < 0.58 || y < -42.0 || y > -11.0) return false;
      return isNear ? (Math.abs(x) < 44 && Math.abs(z) < 46) : (Math.abs(x) < 92 && Math.abs(z) < 92);
    });
    const cx = terrain.wp[vid * 3];
    const cy = terrain.wp[vid * 3 + 1];
    const cz = terrain.wp[vid * 3 + 2];
    const cnx = terrain.wn[vid * 3];
    const cny = terrain.wn[vid * 3 + 1];
    const cnz = terrain.wn[vid * 3 + 2];
    if (nearClearing(cx, cz, 4.0) && ci >= 16) continue;
    if (Math.abs(terrain.dw(cx, cy, cz)) > 0.45) continue;
    const scale = rr(0.75, 1.55);
    buckets.clam.push({
      x: cx,
      y: cy - 0.06,
      z: cz,
      scale,
      q: qFromYToNormal(cnx * 0.45, Math.max(0.65, cny), cnz * 0.45, rr(0, Math.PI * 2)),
      kind: 11,
      seed: rnd(),
      zoneTint: terrain.magAt(cx, cz),
      extra: 1.0,
    });
    if (ci % 4 === 0) glintOrigins.push(new THREE.Vector3(cx, cy + 0.5, cz));
  }

  // ============================================================================
  // 5. Dense GPU-Instanced Kelp Cathedrals (Stipes + Fronds) & 8-Type Benthic Flora
  // ============================================================================
  const { VX, VY, VZ, OX, OY, OZ, SIZE_X, SIZE_Y, SIZE_Z } = {
    VX: 96, VY: 24, VZ: 96,
    OX: WORLD_BOUNDS.OX, OY: WORLD_BOUNDS.OY, OZ: WORLD_BOUNDS.OZ,
    SIZE_X: WORLD_BOUNDS.SIZE_X, SIZE_Y: WORLD_BOUNDS.SIZE_Y, SIZE_Z: WORLD_BOUNDS.SIZE_Z,
  };
  const kelpAbs = new Float32Array(VX * VY * VZ);

  function depositKelpAbsorption(wx, wy, wz, height, radius = 2.6, strength = 0.28) {
    const kMinY = Math.max(0, Math.floor(((wy - OY) / SIZE_Y) * VY));
    const kMaxY = Math.min(VY - 1, Math.floor(((wy + height - OY) / SIZE_Y) * VY));
    const kxC = Math.floor(((wx - OX) / SIZE_X) * VX);
    const kzC = Math.floor(((wz - OZ) / SIZE_Z) * VZ);
    const rCell = Math.ceil(radius / (SIZE_X / VX));
    for (let kz = Math.max(0, kzC - rCell); kz <= Math.min(VZ - 1, kzC + rCell); kz++) {
      for (let kx = Math.max(0, kxC - rCell); kx <= Math.min(VX - 1, kxC + rCell); kx++) {
        const d2 = (kx - kxC) * (kx - kxC) + (kz - kzC) * (kz - kzC);
        const fall = Math.exp(-d2 / (rCell * rCell + 0.5)) * strength;
        for (let ky = kMinY; ky <= kMaxY; ky++) {
          const idx = (kz * VY + ky) * VX + kx;
          kelpAbs[idx] = Math.min(1.0, kelpAbs[idx] + fall);
        }
      }
    }
  }

  // Tall Kelp Stipe Columns + Giant Fronds (~11,500 blades + twisted 3-strand stems)
  const tallBlades = [];
  const kelpGroves = [
    { x: -12, z: -5, r: 9, n: 22 },
    { x: 13, z: -7, r: 9, n: 22 },
    { x: -12, z: 11, r: 8, n: 18 },
    { x: 12, z: 11, r: 8, n: 18 },
    { x: -16, z: -20, r: 22, n: 40 },
    { x: 18, z: -24, r: 22, n: 38 },
    { x: -34, z: 26, r: 22, n: 34 },
    { x: 26, z: 38, r: 20, n: 30 },
    { x: -50, z: -4, r: 20, n: 28 },
    { x: 46, z: 2, r: 22, n: 30 },
  ];

  for (let gi = 0; gi < kelpGroves.length; gi++) {
    const g = kelpGroves[gi];
    for (let k = 0; k < g.n; k++) {
      const ang = rr(0, Math.PI * 2);
      const dist = Math.sqrt(rnd()) * g.r;
      const cx = g.x + Math.cos(ang) * dist;
      const cz = g.z + Math.sin(ang) * dist;
      if (Math.hypot(cx, cz) < 9.0 || Math.hypot(cx + 40, cz + 28) < 15.0 || Math.hypot(cx - 35, cz - 22) < 15.0 || Math.hypot(cx + 11, cz - 18) < 7.0 || Math.hypot(cx + 18, cz - 14) < 12.0 || Math.hypot(cx + 18, cz - 24) < 11.5 || Math.hypot(cx - 71, cz + 25) < 16.0 || Math.hypot(cx - 61.5, cz - 64.5) < 30.0 || (Math.abs(cx) < 12.0 && cz > -34.0 && cz < 28.0)) continue;

      const floorY = terrain.gy(cx, cz);
      if (floorY > -15) continue;

      const maxH = Math.min(27.0, (-floorY) * 0.85);
      const colH = rr(Math.max(8, maxH * 0.55), maxH);
      const fronds = Math.floor(rr(36, 56));
      depositKelpAbsorption(cx, floorY, cz, colH, 3.2, 0.34);

      // Root twisted 3-strand kelp stipe trunk right along the central axis
      buckets.kelpStipe.push({
        x: cx,
        y: floorY - 0.3,
        z: cz,
        scale: colH,
        q: qFromAxisAngle(0, 1, 0, rr(0, Math.PI * 2)),
        kind: 7,
        seed: rnd(),
        zoneTint: 0.0,
        extra: 1.0,
      });

      for (let f = 0; f < fronds; f++) {
        const yFrac = f / fronds;
        const wy = floorY + yFrac * colH;
        const spiralA = f * 2.39996 + gi * 1.1;
        const rOff = rr(0.12, 0.72) * (0.5 + 0.6 * yFrac);
        const bx = cx + Math.cos(spiralA) * rOff;
        const bz = cz + Math.sin(spiralA) * rOff;
        const fLen = rr(2.0, 4.4) * (0.6 + 0.5 * Math.sin(yFrac * Math.PI));
        const tilt = qMul(
          qFromAxisAngle(0, 1, 0, spiralA),
          qFromAxisAngle(1, 0, 0, rr(0.45, 1.05))
        );

        tallBlades.push({
          x: bx,
          y: wy,
          z: bz,
          scale: fLen,
          q: tilt,
          kind: f % 3 === 0 ? 1 : 0,
          seed: rnd(),
          zoneTint: 0.0,
          extra: rr(0.35, 0.95),
        });
      }

      if (k % 3 === 0) {
        glintOrigins.push(new THREE.Vector3(cx, floorY + colH * 0.72, cz));
      }
    }
  }

  // Build instanced solid meshes + shadow meshes AFTER kelpStipe & all props are populated
  const instSolidMat = createSolidMaterial(sharedUniforms, { instanced: true });
  const instDoubleSolidMat = createSolidMaterial(sharedUniforms, { instanced: true, doubleSide: true });
  const instShadowMat = createSolidShadowMaterial({ instanced: true, sharedUniforms });

  for (const key of Object.keys(geoms)) {
    const mat = key === 'giantFan' ? instDoubleSolidMat : instSolidMat;
    const batch = createInstancedBatch(geoms[key], buckets[key], mat, instShadowMat);
    if (batch) {
      group.add(batch.mesh);
      shadowGroup.add(batch.shadowMesh);
    }
  }

  // Dense Benthic Carpets across types 2..7 (~25,000 blades on canyon ledges, sand borders & overhangs!)
  const smallBlades = [];
  for (let i = 0; i < 3600; i++) {
    const isCentral = i < 1400;
    const vid = terrain.pickVertex((x, y, z, nx, ny) => {
      if (ny < 0.42 || y > -8.0) return false;
      return isCentral ? (Math.abs(x) < 42 && Math.abs(z) < 48) : (Math.abs(x) < 104 && Math.abs(z) < 104);
    });
    const bx = terrain.wp[vid * 3];
    const by = terrain.wp[vid * 3 + 1];
    const bz = terrain.wp[vid * 3 + 2];
    const nx = terrain.wn[vid * 3];
    const ny = terrain.wn[vid * 3 + 1];
    const nz = terrain.wn[vid * 3 + 2];
    if (Math.hypot(bx - 71.0, bz + 25.0) < 12.5 || Math.hypot(bx + 17.5, bz - 25.0) < 9.0 || (by < -39.5 && Math.abs(bx) < 9.2 && bz > -24.0 && bz < 10.0) || (by < -40.0 && nearClearing(bx, bz, 8.5) && (i % 12 !== 0))) continue;

    const mz = terrain.magAt(bx, bz);
    const pz = terrain.zoneP(bx, bz);
    const tint = Math.max(mz, pz);
    const patchN = Math.floor(rr(5, 9));

    for (let p = 0; p < patchN; p++) {
      const pa = rr(0, Math.PI * 2);
      const pr = rr(0.05, 0.85);
      const px = bx + Math.cos(pa) * pr;
      const pz_ = bz + Math.sin(pa) * pr;
      const py = by - 0.04;

      let kind = 2; // Seagrass default
      if (tint > 0.30 && rnd() < 0.72) kind = rnd() < 0.65 ? 3 : 5; // Magenta fans & fluorescent sea plumes!
      else if (ny < 0.76 && rnd() < 0.48) kind = 4; // Iridescent peacock fan
      else if (by > -34 && rnd() < 0.38) kind = 6; // Golden-amber canyon fern fronds

      const bladeH = kind === 2 ? rr(0.80, 2.2) : rr(0.45, 1.35);
      const pitch = rr(0.08, 0.45);
      const qBase = qFromYToNormal(nx * 0.4, 0.92, nz * 0.4, rr(0, Math.PI * 2));
      const qTilt = qMul(qBase, qFromAxisAngle(1, 0, 0, pitch));

      smallBlades.push({
        x: px,
        y: py,
        z: pz_,
        scale: bladeH,
        q: qTilt,
        kind,
        seed: rnd(),
        zoneTint: tint,
        extra: rr(0.25, 0.85),
      });
    }
  }

  // Hanging emerald-teal overhang vines under cliff ledges & arch ceilings (kind = 7)
  for (let i = 0; i < 650; i++) {
    const vid = terrain.pickVertex((x, y, z, nx, ny) => ny < -0.22 && y > -38 && y < -9 && Math.abs(x) < 92 && Math.abs(z) < 92);
    const bx = terrain.wp[vid * 3];
    const by = terrain.wp[vid * 3 + 1];
    const bz = terrain.wp[vid * 3 + 2];
    if (Math.hypot(bx - 62.0, bz - 64.0) < 30.0) continue; // Keep Blue Hole rocky ceiling & skylight rim silhouettes crisp!
    const patchN = Math.floor(rr(2, 5));
    for (let p = 0; p < patchN; p++) {
      smallBlades.push({
        x: bx + rr(-0.6, 0.6),
        y: by + 0.08,
        z: bz + rr(-0.6, 0.6),
        scale: rr(0.85, 2.6),
        q: qMul(qFromAxisAngle(1, 0, 0, Math.PI), qFromAxisAngle(0, 1, 0, rr(0, Math.PI * 2))),
        kind: 7,
        seed: rnd(),
        zoneTint: terrain.zoneP(bx, bz),
        extra: rr(0.4, 0.95),
      });
    }
  }

  // Upload kelp canopy occlusion into 3D volume texture & 2D zone texture!
  terrain.updateGroundAndVolumeMaps(kelpAbs);

  const leafMat = createLeafMaterial(sharedUniforms, { shadow: false });
  const leafShadowMat = createLeafMaterial(sharedUniforms, { shadow: true });

  const tallBladeGeo = buildBladeGeometry(12, 1.0);
  const tallBatch = createInstancedBatch(tallBladeGeo, tallBlades, leafMat, leafShadowMat);
  if (tallBatch) {
    group.add(tallBatch.mesh);
    shadowGroup.add(tallBatch.shadowMesh);
  }

  const smallBladeGeo = buildBladeGeometry(8, 0.90);
  const smallBatch = createInstancedBatch(smallBladeGeo, smallBlades, leafMat, leafShadowMat);
  if (smallBatch) {
    group.add(smallBatch.mesh);
    shadowGroup.add(smallBatch.shadowMesh);
  }

  // 6. Add Particle Atmosphere: Crisp Micro-Glints, Rising Vent Bubbles, Endless Marine Snow
  if (glintOrigins.length > 0) {
    group.add(buildGlints(sharedUniforms, 1400, glintOrigins));
  }
  group.add(buildBubbles(sharedUniforms, terrain));
  group.add(buildMarineSnow(sharedUniforms, isMobile ? 2200 : 5200));

  flyPts.unshift(
    new THREE.Vector3(0, -37.5, 22),
    new THREE.Vector3(1, -36.5, -1.5),
    new THREE.Vector3(-8, -37.2, 16.5),
    new THREE.Vector3(-28, -36.5, -22),
    new THREE.Vector3(24, -36.8, 28),
    new THREE.Vector3(0, 4.2, 26)
  );

  // Export up to 48 grounded Sea Anemone anchors (hero + canyon colonies) for symbiotic Clownfish AI
  const anemoneAnchors = [];
  const totalAnem = buckets.anemone.length;
  // Prioritize hero anemones (pushed last) plus well-spaced canyon colonies
  for (let i = totalAnem - 1; i >= 0 && anemoneAnchors.length < 48; i--) {
    const a = buckets.anemone[i];
    if (i < totalAnem - 14 && i % 4 !== 0) continue;
    anemoneAnchors.push({ x: a.x, y: a.y, z: a.z, scale: a.scale });
  }

  return {
    group,
    shadowGroup,
    flyPts,
    anemoneAnchors,
    stats: {
      tallBlades: tallBlades.length,
      smallBlades: smallBlades.length,
      coralsAndRocks: Object.values(buckets).reduce((s, a) => s + a.length, 0),
    },
  };
}
