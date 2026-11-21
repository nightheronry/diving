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

// 11. Sunken Wooden Shipwreck (Tilted Hull Ribs, Deck, Broken Mast & Bowsprit)
function meshShip() {
  const m = new ProcMesh();
  const stations = 16;
  const arcSegs = 12;
  const length = 11.5;
  const halfLen = length * 0.5;
  const rings = [];

  // Open curved hull shell (outer planks + thick gunwale rim + inner bilge)
  for (let i = 0; i <= stations; i++) {
    const u = i / stations; // 0 = stern, 1 = bow
    const z = (u - 0.5) * length;
    // Narrow to pointy prow at u=1, square transom taper at stern u=0
    const beam = Math.sin(Math.pow(u, 0.65) * Math.PI * 0.92) * 2.15 + 0.18;
    const sheer = Math.pow(Math.abs(u - 0.45) * 1.8, 2.0) * 0.75;
    const rocker = Math.pow(u - 0.5, 2.0) * 0.9;
    const ring = [];
    for (let j = 0; j <= arcSegs; j++) {
      const v = j / arcSegs; // 0 = port gunwale -> 0.5 = keel -> 1 = starboard gunwale
      const a = (v - 0.5) * Math.PI;
      const x = Math.sin(a) * beam;
      const y = -Math.cos(a) * 1.45 + rocker + Math.abs(Math.sin(a)) * sheer + 0.75;
      const ao = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(Math.abs(a)));
      ring.push(m.v(x, y, z, ao));
    }
    rings.push(ring);
  }

  // Thick double-sided outer/inner hull surface
  for (let i = 0; i < stations; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    for (let j = 0; j < arcSegs; j++) {
      m.quad(r0[j], r0[j + 1], r1[j + 1], r1[j]);
      m.quad(r0[j], r1[j], r1[j + 1], r0[j + 1]);
    }
  }

  // Exposed structural hull ribs & weathered deck beams
  for (let i = 2; i < stations - 1; i += 2) {
    const u = i / stations;
    const z = (u - 0.5) * length;
    const beam = Math.sin(Math.pow(u, 0.65) * Math.PI * 0.92) * 2.02;
    const sheer = Math.pow(Math.abs(u - 0.45) * 1.8, 2.0) * 0.72;
    const yDeck = 0.68 + sheer;
    // Skip every third beam for ruined open hull gap
    if (i === 8 || i === 10) continue;
    const beamPts = [
      new THREE.Vector3(-beam, yDeck, z),
      new THREE.Vector3(0, yDeck + 0.14, z),
      new THREE.Vector3(beam, yDeck, z),
    ];
    m.tube(beamPts, 5, 0.09, true, true, () => 0.72);
  }

  // Broken Foremast & Mainmast stumps + Bowsprit
  m.tube(
    [new THREE.Vector3(0, -0.35, -0.9), new THREE.Vector3(0.18, 4.1, -1.05)],
    9,
    (t) => 0.24 - t * 0.07,
    true,
    true,
    (t) => 0.65 + 0.35 * t
  );
  m.tube(
    [new THREE.Vector3(-0.9, 1.5, -1.05), new THREE.Vector3(1.15, 1.72, -1.02)],
    6,
    0.09,
    true,
    true,
    () => 0.85
  );
  // Bowsprit angling over prow
  m.tube(
    [new THREE.Vector3(0, 1.25, halfLen - 1.1), new THREE.Vector3(0, 2.45, halfLen + 2.8)],
    7,
    (t) => 0.16 - t * 0.09,
    true,
    true,
    () => 0.88
  );

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

// 13. Sunken WWII Monoplane Fighter Wreck (Radial Engine Cowl, Open Cockpit, Bent Propeller, Torn Wing Cutouts & Spars)
function meshFighterWreck() {
  const m = new ProcMesh();

  // A. Radial-engine fuselage from tailpost (z = -5.1) to engine cowling (z = +4.5)
  const fStations = [
    { z: -5.1, rx: 0.14, ry: 0.28, y0: 0.14, cockpit: false },
    { z: -3.8, rx: 0.34, ry: 0.44, y0: 0.10, cockpit: false },
    { z: -2.1, rx: 0.54, ry: 0.62, y0: 0.04, cockpit: false },
    { z: -0.5, rx: 0.68, ry: 0.72, y0: 0.00, cockpit: true },
    { z: 0.45, rx: 0.72, ry: 0.74, y0: 0.00, cockpit: true },
    { z: 1.45, rx: 0.73, ry: 0.74, y0: 0.00, cockpit: false },
    { z: 3.10, rx: 0.74, ry: 0.74, y0: 0.00, cockpit: false },
    { z: 4.15, rx: 0.70, ry: 0.70, y0: 0.00, cockpit: false },
    { z: 4.55, rx: 0.58, ry: 0.58, y0: 0.00, cockpit: false },
    { z: 4.35, rx: 0.42, ry: 0.42, y0: 0.00, cockpit: false },
    { z: 3.70, rx: 0.38, ry: 0.38, y0: 0.00, cockpit: false },
  ];
  const fArcs = 16;
  const fRings = [];
  for (let i = 0; i < fStations.length; i++) {
    const st = fStations[i];
    const ring = [];
    for (let s = 0; s < fArcs; s++) {
      const a = (s / fArcs) * Math.PI * 2;
      let vx = Math.sin(a) * st.rx;
      let vy = Math.cos(a) * st.ry + st.y0;
      let ao = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos(a));
      if (st.cockpit && Math.cos(a) > 0.56) {
        vy = st.y0 - 0.18 + Math.cos(a) * 0.15;
        vx *= 0.85;
        ao = 0.24;
      }
      if (i >= 9) ao = 0.25;
      ring.push(m.v(vx, vy, st.z, ao));
    }
    fRings.push(ring);
  }
  for (let i = 0; i < fRings.length - 1; i++) {
    const r0 = fRings[i];
    const r1 = fRings[i + 1];
    for (let s = 0; s < fArcs; s++) {
      const ns = (s + 1) % fArcs;
      m.quad(r0[s], r1[s], r1[ns], r0[ns]);
    }
  }
  const tailCap = m.v(0, 0.14, -5.15, 0.65);
  for (let s = 0; s < fArcs; s++) {
    const ns = (s + 1) % fArcs;
    m.tri(tailCap, fRings[0][ns], fRings[0][s]);
  }
  const cowlCap = m.v(0, 0.0, 3.65, 0.20);
  const lastRing = fRings[fRings.length - 1];
  for (let s = 0; s < fArcs; s++) {
    const ns = (s + 1) % fArcs;
    m.tri(cowlCap, lastRing[s], lastRing[ns]);
  }

  // Open Cockpit Canopy Arch Frames & Spine Brace
  const hoops = [1.35, 0.65, -0.35];
  for (let hi = 0; hi < hoops.length; hi++) {
    const hz = hoops[hi];
    const hRad = hi === 1 ? 0.42 : 0.36;
    const hY = hi === 0 ? 0.58 : 0.60;
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const th = -Math.PI * 0.48 + (k / 6) * Math.PI * 0.96;
      pts.push(new THREE.Vector3(Math.sin(th) * hRad, hY + Math.cos(th) * hRad * 1.15, hz));
    }
    m.tube(pts, 5, 0.042, true, true, () => 0.72);
  }
  m.tube([new THREE.Vector3(0, 0.92, 1.28), new THREE.Vector3(0, 0.95, -0.35)], 5, 0.036, true, true, () => 0.75);

  // B. Nose Spinner Dome & 3-Blade Bent Radial Propeller
  m.tube(
    [new THREE.Vector3(0, 0, 3.85), new THREE.Vector3(0, 0, 4.65), new THREE.Vector3(0, 0, 4.98)],
    10,
    (t) => (t < 0.75 ? 0.24 : 0.24 * (1.0 - (t - 0.75) * 3.6)),
    false,
    true,
    (t) => 0.65 + 0.35 * t
  );
  for (let b = 0; b < 3; b++) {
    const ang = b * (Math.PI * 2 / 3) + 0.35;
    const dx = Math.sin(ang);
    const dy = Math.cos(ang);
    const isBent = b === 1;
    const bladePts = isBent
      ? [
          new THREE.Vector3(dx * 0.14, dy * 0.14, 4.72),
          new THREE.Vector3(dx * 0.68, dy * 0.65, 4.55),
          new THREE.Vector3(dx * 1.05, dy * 0.88, 4.18),
          new THREE.Vector3(dx * 1.24, dy * 0.92, 3.82),
        ]
      : [
          new THREE.Vector3(dx * 0.14, dy * 0.14, 4.72),
          new THREE.Vector3(dx * 0.75, dy * 0.75, 4.74),
          new THREE.Vector3(dx * 1.48, dy * 1.48, 4.71),
        ];
    m.tube(bladePts, 5, (t) => 0.105 * (1.0 - t * 0.62) + 0.025, true, true, (t) => 0.62 + 0.38 * t);
  }

  // C. Tapered Low-Wing Monoplane Main Wings with Torn Corrosion Bays & Internal Spars/Ribs
  function buildWingSide(sideSign) {
    const nSpan = 14;
    const spanLen = 5.45;
    const dihedral = 0.085;
    const rootX = sideSign * 0.56;
    const openBays = sideSign < 0 ? new Set([3, 4, 5, 9, 10]) : new Set([4, 5, 10]);

    function wingSection(u) {
      const absX = Math.abs(rootX) + u * spanLen;
      const x = sideSign * absX;
      const yBase = -0.24 + u * spanLen * dihedral;
      const zLE = 1.65 - u * 0.52 - Math.pow(u, 3.0) * 0.35;
      const chord = 2.38 * (1.0 - 0.56 * u) - Math.pow(u, 4.0) * 0.25;
      const thick = 0.22 * (1.0 - 0.68 * u);
      return { x, yBase, zLE, chord, thick };
    }

    const chordProfiles = [0.0, 0.24, 0.55, 0.84, 1.0, 0.84, 0.55, 0.24];
    const chordYs = [0.0, 0.52, 0.48, 0.26, 0.0, -0.22, -0.34, -0.30];

    const wRings = [];
    for (let i = 0; i <= nSpan; i++) {
      const u = i / nSpan;
      const ws = wingSection(u);
      const ring = [];
      for (let k = 0; k < 8; k++) {
        const z = ws.zLE - chordProfiles[k] * ws.chord;
        const y = ws.yBase + chordYs[k] * ws.thick;
        const ao = k <= 4 ? 0.72 + 0.28 * (1.0 - Math.abs(k - 2) * 0.25) : 0.45;
        ring.push(m.v(ws.x, y, z, ao));
      }
      wRings.push(ring);
    }

    for (let i = 0; i < nSpan; i++) {
      const r0 = wRings[i];
      const r1 = wRings[i + 1];
      const isCutBay = openBays.has(i);
      for (let k = 0; k < 8; k++) {
        if (isCutBay && (k === 1 || k === 2)) continue;
        const nk = (k + 1) % 8;
        if (sideSign > 0) m.quad(r0[k], r1[k], r1[nk], r0[nk]);
        else m.quad(r0[k], r0[nk], r1[nk], r1[k]);
      }
    }

    for (const sparFrac of [0.34, 0.66]) {
      const sPts = [];
      for (let i = 1; i <= nSpan - 1; i++) {
        const ws = wingSection(i / nSpan);
        sPts.push(new THREE.Vector3(ws.x, ws.yBase + 0.03, ws.zLE - ws.chord * sparFrac));
      }
      m.tube(sPts, 4, (t) => 0.048 * (1.0 - t * 0.45), true, true, () => 0.45);
    }
    openBays.forEach((bi) => {
      const ws = wingSection((bi + 0.5) / nSpan);
      const zFore = ws.zLE - ws.chord * 0.24;
      const zAft = ws.zLE - ws.chord * 0.82;
      m.tube(
        [new THREE.Vector3(ws.x, ws.yBase + 0.04, zFore), new THREE.Vector3(ws.x, ws.yBase + 0.02, zAft)],
        4,
        0.036,
        true,
        true,
        () => 0.55
      );
    });

    const wsTip = wingSection(1.0);
    const tipCenter = m.v(wsTip.x + sideSign * 0.14, wsTip.yBase, wsTip.zLE - wsTip.chord * 0.48, 0.80);
    const tipRing = wRings[nSpan];
    for (let k = 0; k < 8; k++) {
      const nk = (k + 1) % 8;
      if (sideSign > 0) m.tri(tipCenter, tipRing[nk], tipRing[k]);
      else m.tri(tipCenter, tipRing[k], tipRing[nk]);
    }

    const aStart = wingSection(0.45);
    const aEnd = wingSection(0.88);
    m.tube(
      [
        new THREE.Vector3(aStart.x, aStart.yBase - 0.14, aStart.zLE - aStart.chord * 1.08),
        new THREE.Vector3(aEnd.x, aEnd.yBase - 0.10, aEnd.zLE - aEnd.chord * 1.08),
      ],
      4,
      (t) => 0.095 * (1.0 - t * 0.3),
      true,
      true,
      () => 0.65
    );
  }
  buildWingSide(-1);
  buildWingSide(1);

  // D. Empennage: Vertical Fin / Rudder + Horizontal Stabilizers
  const vFinPts = [
    [0.0, 0.15, -3.55],
    [0.0, 1.05, -4.15],
    [0.0, 1.85, -4.65],
  ];
  m.tube(vFinPts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), 4, (t) => 0.24 * (1.0 - t * 0.65), true, true, () => 0.72);
  m.tube(
    [new THREE.Vector3(-2.05, 0.16, -4.55), new THREE.Vector3(0, 0.18, -4.10), new THREE.Vector3(2.05, 0.16, -4.55)],
    4,
    (t) => 0.26 - Math.abs(t - 0.5) * 0.34,
    true,
    true,
    () => 0.72
  );

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
