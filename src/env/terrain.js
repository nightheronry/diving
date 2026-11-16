import * as THREE from 'three';
import { WORLD_BOUNDS, MEDIUM_GLSL } from './medium.js';

// ============================================================================
// Seeded PRNG & Procedural Noise (Zero-Allocation Fast Typed Helpers)
// ============================================================================
let _seed = 0x5f3759df;

export function rseed(s) {
  _seed = (s >>> 0) || 1;
}

export function rnd() {
  let t = (_seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rr(a, b) {
  return a + (b - a) * rnd();
}

function hash3(ix, iy, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function vnoise(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = n000 + (n100 - n000) * ux;
  const x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux;
  const x11 = n011 + (n111 - n011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

export function vnoise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const n00 = hash2(ix, iz);
  const n10 = hash2(ix + 1, iz);
  const n01 = hash2(ix, iz + 1);
  const n11 = hash2(ix + 1, iz + 1);
  const x0 = n00 + (n10 - n00) * ux;
  const x1 = n01 + (n11 - n01) * ux;
  return x0 + (x1 - x0) * uz;
}

export function fbm(x, y, z, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * freq, y * freq, z * freq);
    norm += amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

function fbm2(x, z, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise2(x * freq, z * freq);
    norm += amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum / norm;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function smax(a, b, k) {
  return -smin(-a, -b, k);
}

// Fast zero-allocation 3D Worley cellular noise (sharp crystalline/fractured rock blocks)
function wor(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  let m = 9.0;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = iz + dz;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = iy + dy;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263) + Math.imul(cz, 2147483647)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        const h2 = Math.imul(h ^ (h >>> 15), 2246822519);
        const ox = ((h >>> 0) / 4294967295) * 0.8 + 0.1 + dx - fx;
        const oy = (((h ^ h2) >>> 0) / 4294967295) * 0.8 + 0.1 + dy - fy;
        const oz = ((h2 >>> 0) / 4294967295) * 0.8 + 0.1 + dz - fz;
        const l2 = ox * ox + oy * oy + oz * oz;
        if (l2 < m) m = l2;
      }
    }
  }
  return Math.sqrt(m);
}

// 2D XZ capsule segment signed distance
export function seg2(px, pz, ax, az, bx, bz) {
  const pax = px - ax;
  const paz = pz - az;
  const bax = bx - ax;
  const baz = bz - az;
  const denom = bax * bax + baz * baz;
  const h = denom > 1e-6 ? Math.max(0, Math.min(1, (pax * bax + paz * baz) / denom)) : 0;
  const dx = pax - bax * h;
  const dz = paz - baz * h;
  return Math.hypot(dx, dz);
}

// 3D XYZ capsule segment signed distance
export function seg3(px, py, pz, ax, ay, az, bx, by, bz) {
  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const denom = bax * bax + bay * bay + baz * baz;
  const h = denom > 1e-4 ? Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / denom)) : 0;
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h);
}

// ============================================================================
// Reef Topography Constants & Geological Features (Direct Port from abyssal-garden world.js)
// ============================================================================
export const MESAS = [
  // West wall of the main canyon
  { ax: -37, az: -42, bx: -33, bz: -22, r: 9, top: -7, overhang: 3.5, waist: 2 },
  { ax: -29, az: -15, bx: -33, bz: 5, r: 12, top: -14, overhang: 3, waist: 2 },
  { ax: -36, az: 11, bx: -30, bz: 27, r: 9, top: -5, overhang: 4, waist: 2 },
  // East wall of the main canyon
  { ax: 30, az: -45, bx: 35, bz: -27, r: 9, top: -9, overhang: 4, waist: 2 },
  { ax: 37, az: -20, bx: 31, bz: -3, r: 11, top: -16, overhang: 3, waist: 2 },
  { ax: 32, az: 5, bx: 35, bz: 9, r: 7, top: -8, overhang: 4, waist: 2 },
  // Pillar with window
  { ax: 19, az: -15, bx: 19, bz: -15, r: 4.4, top: -6, overhang: 2, waist: 1.5 },
  // Mound in the kelp basin
  { ax: 6, az: -88, bx: 6, bz: -88, r: 10, top: -34, overhang: 0, waist: 0 },
  // Pillar reaching toward the surface
  { ax: 0, az: -102, bx: 0, bz: -102, r: 8, top: -2.6, overhang: 2, waist: 2 },
  // Ship supports mesa & sloped sunlit wall beside the wreck
  { ax: 44, az: 6, bx: 47, bz: -8, r: 7, top: -17, overhang: 3, waist: 1 },
  { ax: 33, az: 29, bx: 37, bz: 12, r: 9, top: -19, overhang: -6.5, waist: 0 },
  { ax: 74, az: 14, bx: 74, bz: 14, r: 8, top: -15, overhang: 3, waist: 1 },
  // Sponge canyon west wall
  { ax: -84, az: -34, bx: -80, bz: -12, r: 10, top: -7, overhang: 6, waist: 2 },
  { ax: -78, az: -6, bx: -83, bz: 12, r: 12, top: -13, overhang: 5, waist: 2 },
  { ax: -82, az: 18, bx: -79, bz: 32, r: 9, top: -8, overhang: 6, waist: 2 },
  // Grotto overhang cliff, coral rock & swim-through Purple Grotto arch ridge (with open lagoon beyond z=94)
  { ax: -17, az: 62, bx: -19, bz: 78, r: 10, top: -6, overhang: 9, waist: 3 },
  { ax: -21, az: 82, bx: -18, bz: 92, r: 10, top: -9, overhang: 8, waist: 3 },
  { ax: 22, az: 67, bx: 24, bz: 82, r: 7, top: -11, overhang: 6, waist: 2 },
  { ax: -18, az: 86, bx: 30, bz: 86, r: 8.5, top: -20, overhang: 3.5, waist: 2 },
];

export const ARCHES = [
  { x: -23, y: -9.5, z: -16, yaw: 0.3, majorR: 4.2, minorR: 1.4, ySquash: 1.2 },
  { x: 0, y: -45, z: -34, yaw: 1.57, majorR: 14.0, minorR: 2.7, ySquash: 1.2 },
  { x: -40, y: -45, z: 44, yaw: 1.57, majorR: 10.0, minorR: 2.2, ySquash: 1.3 },
];

export const HOLES = [
  { ax: 19, ay: -21, az: -23, r: 2.5, bx: 19, by: -21, bz: -7 },
];

export const CLEARS = [
  { ax: 0, az: -45, bx: 0, bz: 35, r: 22, soft: 10, x: 0, z: -5, floor: -45.5 },
  { ax: 0, az: -86, bx: 0, bz: -86, r: 46, soft: 12, x: 0, z: -86, floor: -45.5 },
  { ax: 42, az: 24, bx: 74, bz: 6, r: 22, soft: 10, x: 58, z: 15, floor: -45.5 },
  { ax: 72, az: -26, bx: 72, bz: -26, r: 26, soft: 10, x: 72, z: -26, floor: -45.5 },
  { ax: -60, az: -36, bx: -60, bz: 36, r: 13, soft: 8, x: -60, z: 0, floor: -45.5 },
  { ax: -60, az: 42, bx: -18, bz: 46, r: 12, soft: 8, x: -39, z: 44, floor: -45.5 },
  { ax: 4, az: 58, bx: 8, bz: 102, r: 24, soft: 10, x: 6, z: 80, floor: -45.5 },
  { ax: -36, az: 98, bx: 42, bz: 95, r: 15, soft: 8, x: 3, z: 97, floor: -45.5 },
  { ax: -34, az: -74, bx: -56, bz: -46, r: 11, soft: 8, x: -45, z: -60, floor: -45.5 },
  { ax: 24, az: 36, bx: 44, bz: 52, r: 11, soft: 8, x: 34, z: 44, floor: -45.5 },
];

export const PURPLE = { x: 6, z: 84, r: 44 };

export const MAGENTA = [
  { x: 14, z: 6, r: 13 },
  { x: -4, z: 20, r: 9 },
  { x: 6, z: 84, r: 30 },
  { x: -58, z: 8, r: 10 },
  { x: 50, z: 30, r: 12 },
  { x: 8, z: -70, r: 10 },
  { x: -12, z: -98, r: 9 },
  { x: -36, z: 44, r: 9 },
  { x: -46, z: -60, r: 9 },
  { x: 24, z: 42, r: 8 },
  { x: -56, z: 26, r: 9 },
  { x: -44, z: 38, r: 8 },
  { x: -10, z: 44, r: 8 },
  { x: 12, z: 24, r: 8 },
  { x: -50, z: -45, r: 8 },
];

export function zoneP(x, z) {
  return smoothstep(44.0, 26.0, Math.hypot(x - PURPLE.x, z - PURPLE.z));
}

export function magAt(x, z) {
  let m = smoothstep(0.54, 0.66, fbm(x * 0.03, 7.0, z * 0.03, 3)) * 0.9;
  for (let i = 0; i < MAGENTA.length; i++) {
    const p = MAGENTA[i];
    const w = smoothstep(p.r, p.r * 0.45, Math.hypot(x - p.x, z - p.z));
    if (w > m) m = w;
  }
  return m * smoothstep(0.3, 0.55, fbm(x * 0.17, 1.0, z * 0.17, 2) + m * 0.25);
}

// Analytical SDF density: positive = solid rock, negative = open water (Direct Port of abyssal-garden W_DENS)
export function dens(x, y, z) {
  const wx = fbm(x * 0.04 + 11.0, y * 0.04 + 11.0, z * 0.04 + 11.0, 3) - 0.5;
  const wy = fbm(x * 0.04 + 47.0, y * 0.04 + 47.0, z * 0.04 + 47.0, 3) - 0.5;
  const wz = fbm(x * 0.04 + 83.0, y * 0.04 + 83.0, z * 0.04 + 83.0, 3) - 0.5;
  const qx = x + wx * 15.0;
  const qy = y + wy * 6.0;
  const qz = z + wz * 15.0;

  let clr = 0.0;
  for (let i = 0; i < CLEARS.length; i++) {
    const c = CLEARS[i];
    const cw = 1.0 - smoothstep(0.0, c.soft, seg2(qx, qz, c.ax, c.az, c.bx, c.bz) - c.r);
    if (cw > clr) clr = cw;
  }

  // Smooth undulating sandbar megaripple dunes in sandy canyon channels; rugged relief outside
  const duneWave =
    0.42 * Math.sin(qx * 0.15 + qz * 0.08 + Math.sin(qz * 0.07) * 1.4) +
    0.18 * Math.cos(qx * 0.27 - qz * 0.19);
  const g0 =
    -45.5 +
    7.0 * (fbm(qx * 0.011, qz * 0.011, 3.0, 4) - 0.5) * (1.0 - 0.52 * clr) +
    1.6 * (fbm(qx * 0.07, qz * 0.07, 9.0, 3) - 0.5) * (1.0 - 0.88 * clr) +
    duneWave * clr;
  const tn = 3.0 * (fbm(qx * 0.09, qz * 0.09, 2.0, 3) - 0.5);

  let dm = -1000.0;
  let de = 1000.0;
  for (let i = 0; i < MESAS.length; i++) {
    const m = MESAS[i];
    const yr = Math.max(0.0, Math.min(1.3, (y - g0) / (m.top - g0)));
    let e = seg2(qx, qz, m.ax, m.az, m.bx, m.bz) - m.r;
    const oneMinusYr = 1.0 - yr;
    e -=
      m.overhang * smoothstep(0.3, 0.92, yr) +
      3.0 * oneMinusYr * oneMinusYr -
      m.waist * smoothstep(0.0, 0.5, yr) * (1.0 - smoothstep(0.5, 1.0, yr));
    dm = smax(dm, smin(-e, m.top + tn - y, 3.0), 2.5);
    if (e < de) de = e;
  }

  const n = fbm(qx * 0.0125, qz * 0.0125, 1.7, 4);
  const plat = smoothstep(0.5, 0.565, n) * (1.0 - clr);
  const th = g0 + plat * (26.0 + 17.0 * fbm(qx * 0.03, qz * 0.03, 5.0, 2));

  let d = smax(g0 + 4.5 * smoothstep(10.0, 0.0, de) - y, dm, 3.0);
  d = smax(d, (th - y) * 0.7, 3.0);

  // Fighter Plane Wreck Sunlit Coral Reef Terrace Ridge (Northeast NE quadrant ~ 71, -25)
  const fwX = x + wx * 4.5;
  const fwZ = z + wz * 4.5;
  const fwRidge = seg2(fwX, fwZ, 64.5, -18.0, 77.5, -31.5);
  if (fwRidge < 22.0) {
    const fwSlope = -22.8 - 17.5 * smoothstep(5.5, 19.0, fwRidge) - (fwZ + 25.0) * 0.16;
    d = smax(d, smin(17.5 - fwRidge, fwSlope - y, 3.2), 2.5);
  }

  // Southeast Blue Hole Cathedral Dome, Jagged Skylight Chimney & Swim-Through Arches (61.5, y, 64.5)
  const bhOuterCheck = Math.hypot(x - 61.5, z - 64.5);
  if (bhOuterCheck < 35.0) {
    const bhX = x + wx * 3.8;
    const bhY = y + wy * 2.4;
    const bhZ = z + wz * 3.8;
    const bhR = Math.hypot(bhX - 61.5, bhZ - 64.5);

    const bhOuterR = 27.5 - Math.max(0.0, bhY + 42.0) * 0.13;
    const bhDomeTop = -2.6 - 2.6 * smoothstep(13.0, 26.5, bhR) + (fbm(bhX * 0.08, bhZ * 0.08, 6.0, 2) - 0.5) * 2.0;
    const bhMassif = smin(bhOuterR - bhR, bhDomeTop - y, 3.0);
    d = smax(d, bhMassif, 2.2);

    // Interior vaulted chamber
    const cavR = 16.5 - 3.6 * smoothstep(-35.0, -13.0, bhY) + 1.1 * Math.sin(bhY * 0.24);
    const cavCeil = -9.6 - 0.028 * bhR * bhR;
    const cavFloor = -44.2 + 1.3 * (fbm(bhX * 0.09, bhZ * 0.09, 4.0, 2) - 0.5);
    let bhCarve = smax(bhR - cavR, bhY - cavCeil, 2.6);
    bhCarve = smax(bhCarve, cavFloor - y, 1.8);

    // Asymmetric rocky keyhole skylight chimney aligned closely with SUN_DIR (0.32, 0.91, -0.26)
    const skyH1 = seg3(bhX, bhY, bhZ, 61.8, -26.0, 64.2, 70.8, 0.5, 56.8) - 5.2;
    const skyH2 = seg3(bhX, bhY, bhZ, 58.0, -21.0, 66.5, 64.2, 0.5, 61.0) - 3.8;
    bhCarve = smin(bhCarve, Math.min(skyH1, skyH2), 1.8);

    // Lower West swim-in cavern portal, upper NW luminous blue side window, & SE reef arch exit
    const winSwimIn = seg3(bhX, bhY, bhZ, 51.0, -34.0, 58.0, 34.0, -33.0, 48.0) - 5.6;
    const winUpper = seg3(bhX, bhY, bhZ, 53.5, -18.5, 55.5, 38.0, -17.5, 44.5) - 4.3;
    const winSE = seg3(bhX, bhY, bhZ, 72.0, -31.0, 69.0, 88.0, -31.0, 74.0) - 4.6;
    bhCarve = smin(bhCarve, Math.min(winSwimIn, Math.min(winUpper, winSE)), 1.8);

    d = smin(d, bhCarve, 1.8);
  }

  // Vertical ring arches (torus SDF)
  for (let i = 0; i < ARCHES.length; i++) {
    const a = ARCHES[i];
    const rx = x + wx * 3.0 - a.x;
    const ry = (y + wy * 3.0 - a.y) / a.ySquash;
    const rz = z + wz * 3.0 - a.z;
    const cs = Math.cos(a.yaw);
    const sn = Math.sin(a.yaw);
    const u = cs * rx + sn * rz;
    const v = -sn * rx + cs * rz;
    const ringDist = Math.hypot(Math.hypot(u, ry) - a.majorR, v);
    d = smax(d, a.minorR - ringDist, 1.5);
  }

  // Carved Purple Grotto wide swim-through cavern arch (craggy walls & flat sandy floor, open out to outer lagoon z=96..108)
  if (z > 64.0 && z < 110.0 && Math.abs(x - 6.0) < 16.0) {
    const pgHd = seg3(x + wx * 2.4, y + wy * 1.8, z + wz * 2.4, 6.0, -37.0, 71.0, 6.0, -35.0, 102.0) - 6.8;
    // Keep sandy bed under tunnel intact while carving wide craggy cavern walls & vaulted roof
    d = smin(d, smax(pgHd, g0 + 0.6 - y, 1.8), 2.0);
  }

  // 2-octave 3D Worley cellular cliff fractures + sedimentary strata steps (suppressed on flat sandy floors; active on arches/ceilings)
  if (Math.abs(d) < 7.0) {
    const hg = y - g0;
    const archRock = smoothstep(5.5, 11.0, hg) * 0.62;
    const rk = smoothstep(0.95, 5.2, hg) * Math.max(1.0 - clr * 0.92, archRock);
    const w1 = wor(x * 0.17 + wx * 2.0, y * 0.17 + wy * 2.0, z * 0.17 + wz * 2.0);
    const w2 = wor(x * 0.41 + 7.0, y * 0.41 + 7.0, z * 0.41 + 7.0);
    const fn = fbm(x * 0.3, y * 0.3, z * 0.3, 3) - 0.5;
    d += rk * ((0.5 - w1) * 3.4 + (0.5 - w2) * 1.3 + fn * 2.2);
    const sp = y * 0.21 + wy * 2.2;
    const sf = sp - Math.floor(sp);
    d += rk * 2.2 * (Math.abs(sf - 0.5) - 0.25);
  }

  // Carved 3D capsule tunnels & windows
  for (let i = 0; i < HOLES.length; i++) {
    const h = HOLES[i];
    const hd = seg3(x + wx * 2.0, y + wy * 2.0, z + wz * 2.0, h.ax, h.ay, h.az, h.bx, h.by, h.bz) - h.r;
    d = smin(d, hd, 2.0);
  }

  return Math.min(d, 3.0 - y);
}

// ============================================================================
// Surface Nets Isosurface Extractor
// ============================================================================
const CUBE_EDGES = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const CORNER_OFF = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

export function buildTerrain() {
  rseed(133742);
  const { NX, NY, NZ, VS, OX, OY, OZ, SIZE_X, SIZE_Y, SIZE_Z } = WORLD_BOUNDS;
  const gridN = NX * NY * NZ;
  const D = new Float32Array(gridN);

  // 1. Sample 3D scalar field D
  for (let iz = 0; iz < NZ; iz++) {
    const z = OZ + iz * VS;
    for (let iy = 0; iy < NY; iy++) {
      const y = OY + iy * VS;
      const baseIdx = (iz * NY + iy) * NX;
      for (let ix = 0; ix < NX; ix++) {
        const x = OX + ix * VS;
        let val;
        if (iy === 0) {
          val = 8.0; // Solid bedrock bottom boundary
        } else if (iy >= NY - 2) {
          val = -8.0; // Open water/sky top boundary
        } else {
          val = dens(x, y, z);
          // Clamp vertical columns near domain XZ edges down to sandy abyss floor
          const edgeM = Math.min(ix, NX - 1 - ix, iz, NZ - 1 - iz);
          if (edgeM < 3) {
            const abyssFloor = -46.2 - y;
            const w = edgeM / 3.0;
            val = abyssFloor * (1.0 - w) + val * w;
          }
          // Ensure nothing pierces above y = -1.8 so underwater & surface wave crest stay unobstructed
          if (y > -2.0) {
            val = Math.min(val, -2.0 - y);
          }
        }
        D[baseIdx + ix] = val;
      }
    }
  }

  // 1b. Connected-Bedrock Flood Fill: purge isolated floating Worley rock specks in mid-water
  const visited = new Uint8Array(gridN);
  const queue = new Int32Array(gridN);
  let qHead = 0;
  let qTail = 0;
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      const idx = iz * NX * NY + ix; // iy = 0 bedrock
      if (D[idx] > 0) {
        visited[idx] = 1;
        queue[qTail++] = idx;
      }
    }
  }
  const strideY = NX;
  const strideZ_ff = NX * NY;
  while (qHead < qTail) {
    const cur = queue[qHead++];
    const ix = cur % NX;
    const rem = (cur - ix) / NX;
    const iy = rem % NY;
    const iz = (rem - iy) / NY;
    if (ix > 0) { const n = cur - 1; if (D[n] > 0 && !visited[n]) { visited[n] = 1; queue[qTail++] = n; } }
    if (ix < NX - 1) { const n = cur + 1; if (D[n] > 0 && !visited[n]) { visited[n] = 1; queue[qTail++] = n; } }
    if (iy > 0) { const n = cur - strideY; if (D[n] > 0 && !visited[n]) { visited[n] = 1; queue[qTail++] = n; } }
    if (iy < NY - 1) { const n = cur + strideY; if (D[n] > 0 && !visited[n]) { visited[n] = 1; queue[qTail++] = n; } }
    if (iz > 0) { const n = cur - strideZ_ff; if (D[n] > 0 && !visited[n]) { visited[n] = 1; queue[qTail++] = n; } }
    if (iz < NZ - 1) { const n = cur + strideZ_ff; if (D[n] > 0 && !visited[n]) { visited[n] = 1; queue[qTail++] = n; } }
  }
  for (let i = 0; i < gridN; i++) {
    if (D[i] > 0 && !visited[i]) {
      D[i] = -1.5;
    }
  }

  // Fast trilinear sampler on D (positive = solid, negative = open water)
  function dw(x, y, z) {
    const gx = (x - OX) / VS;
    const gy_f = (y - OY) / VS;
    const gz = (z - OZ) / VS;
    const ix = Math.max(0, Math.min(NX - 2, Math.floor(gx)));
    const iy = Math.max(0, Math.min(NY - 2, Math.floor(gy_f)));
    const iz = Math.max(0, Math.min(NZ - 2, Math.floor(gz)));
    const fx = Math.max(0, Math.min(1, gx - ix));
    const fy = Math.max(0, Math.min(1, gy_f - iy));
    const fz = Math.max(0, Math.min(1, gz - iz));

    const i000 = (iz * NY + iy) * NX + ix;
    const i100 = i000 + 1;
    const i010 = i000 + NX;
    const i110 = i010 + 1;
    const strideZ = NX * NY;
    const i001 = i000 + strideZ;
    const i101 = i100 + strideZ;
    const i011 = i010 + strideZ;
    const i111 = i110 + strideZ;

    const x00 = D[i000] + (D[i100] - D[i000]) * fx;
    const x10 = D[i010] + (D[i110] - D[i010]) * fx;
    const x01 = D[i001] + (D[i101] - D[i001]) * fx;
    const x11 = D[i011] + (D[i111] - D[i011]) * fx;

    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }

  // Outward water normal (-normalize(grad(dw)))
  function grad(x, y, z, out) {
    const e = 0.65;
    const dx = dw(x + e, y, z) - dw(x - e, y, z);
    const dy = dw(x, y + e, z) - dw(x, y - e, z);
    const dz = dw(x, y, z + e) - dw(x, y, z - e);
    const l = Math.hypot(dx, dy, dz) || 1.0;
    const inv = -1.0 / l; // negate so normal points INTO open water (toward smaller dw)
    if (out) {
      out.set(dx * inv, dy * inv, dz * inv);
      return out;
    }
    return new THREE.Vector3(dx * inv, dy * inv, dz * inv);
  }

  // 2. Surface Nets Extraction
  const cellVert = new Int32Array(gridN).fill(-1);
  const vPos = [];
  const vNorm = [];
  const vAo = [];
  const corners = new Float32Array(8);
  const strideZ = NX * NY;

  for (let iz = 0; iz < NZ - 1; iz++) {
    for (let iy = 0; iy < NY - 1; iy++) {
      for (let ix = 0; ix < NX - 1; ix++) {
        const i000 = (iz * NY + iy) * NX + ix;
        corners[0] = D[i000];
        corners[1] = D[i000 + 1];
        corners[2] = D[i000 + NX];
        corners[3] = D[i000 + NX + 1];
        corners[4] = D[i000 + strideZ];
        corners[5] = D[i000 + strideZ + 1];
        corners[6] = D[i000 + strideZ + NX];
        corners[7] = D[i000 + strideZ + NX + 1];

        let mask = 0;
        for (let c = 0; c < 8; c++) {
          if (corners[c] > 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = CUBE_EDGES[e][0];
          const b = CUBE_EDGES[e][1];
          const va = corners[a];
          const vb = corners[b];
          if ((va > 0) === (vb > 0)) continue;
          const t = va / (va - vb);
          const ca = CORNER_OFF[a];
          const cb = CORNER_OFF[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          cnt++;
        }

        const wx = OX + (ix + sx / cnt) * VS;
        const wy = OY + (iy + sy / cnt) * VS;
        const wz = OZ + (iz + sz / cnt) * VS;

        // Analytical outward water normal
        const e = 0.7;
        const gdx = dw(wx + e, wy, wz) - dw(wx - e, wy, wz);
        const gdy = dw(wx, wy + e, wz) - dw(wx, wy - e, wz);
        const gdz = dw(wx, wy, wz + e) - dw(wx, wy, wz - e);
        const gl = Math.hypot(gdx, gdy, gdz) || 1.0;
        const nx_ = -gdx / gl;
        const ny_ = -gdy / gl;
        const nz_ = -gdz / gl;

        // Multi-radius volumetric AO along normal
        const a1 = dw(wx + nx_ * 1.4, wy + ny_ * 1.4, wz + nz_ * 1.4);
        const a2 = dw(wx + nx_ * 3.4, wy + ny_ * 3.4, wz + nz_ * 3.4);
        const a3 = dw(wx, wy + 4.5, wz); // overhead rock occlusion check
        const aoRaw =
          smoothstep(-2.0, 1.5, -a1) * 0.45 +
          smoothstep(-3.0, 2.5, -a2) * 0.35 +
          smoothstep(-2.0, 3.0, -a3) * 0.2;
        const ao = Math.max(0.22, Math.min(1.0, 0.25 + 0.75 * aoRaw));

        const vid = vPos.length / 3;
        cellVert[i000] = vid;
        vPos.push(wx, wy, wz);
        vNorm.push(nx_, ny_, nz_);
        vAo.push(ao);
      }
    }
  }

  // Emit quads on sign-changing interior grid edges with guaranteed normal-aligned winding
  const indices = [];
  function pushTri(a, b, c) {
    const ax = vPos[a * 3], ay = vPos[a * 3 + 1], az = vPos[a * 3 + 2];
    const bx = vPos[b * 3], by = vPos[b * 3 + 1], bz = vPos[b * 3 + 2];
    const cx = vPos[c * 3], cy = vPos[c * 3 + 1], cz = vPos[c * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    const nnx = vNorm[a * 3] + vNorm[b * 3] + vNorm[c * 3];
    const nny = vNorm[a * 3 + 1] + vNorm[b * 3 + 1] + vNorm[c * 3 + 1];
    const nnz = vNorm[a * 3 + 2] + vNorm[b * 3 + 2] + vNorm[c * 3 + 2];
    if (fx * nnx + fy * nny + fz * nnz >= 0) {
      indices.push(a, b, c);
    } else {
      indices.push(a, c, b);
    }
  }

  for (let iz = 1; iz < NZ - 1; iz++) {
    for (let iy = 1; iy < NY - 1; iy++) {
      for (let ix = 1; ix < NX - 1; ix++) {
        const idx = (iz * NY + iy) * NX + ix;
        const d0 = D[idx] > 0;

        // X-aligned edge -> quad across (y, z) neighbor cells
        if (ix < NX - 2) {
          const d1 = D[idx + 1] > 0;
          if (d0 !== d1) {
            const c0 = cellVert[idx];
            const c1 = cellVert[idx - NX];
            const c2 = cellVert[idx - NX - strideZ];
            const c3 = cellVert[idx - strideZ];
            if (c0 >= 0 && c1 >= 0 && c2 >= 0 && c3 >= 0) {
              pushTri(c0, c1, c2);
              pushTri(c0, c2, c3);
            }
          }
        }

        // Y-aligned edge -> quad across (x, z) neighbor cells
        if (iy < NY - 2) {
          const d1 = D[idx + NX] > 0;
          if (d0 !== d1) {
            const c0 = cellVert[idx];
            const c1 = cellVert[idx - 1];
            const c2 = cellVert[idx - 1 - strideZ];
            const c3 = cellVert[idx - strideZ];
            if (c0 >= 0 && c1 >= 0 && c2 >= 0 && c3 >= 0) {
              pushTri(c0, c1, c2);
              pushTri(c0, c2, c3);
            }
          }
        }

        // Z-aligned edge -> quad across (x, y) neighbor cells
        if (iz < NZ - 2) {
          const d1 = D[idx + strideZ] > 0;
          if (d0 !== d1) {
            const c0 = cellVert[idx];
            const c1 = cellVert[idx - 1];
            const c2 = cellVert[idx - 1 - NX];
            const c3 = cellVert[idx - NX];
            if (c0 >= 0 && c1 >= 0 && c2 >= 0 && c3 >= 0) {
              pushTri(c0, c1, c2);
              pushTri(c0, c2, c3);
            }
          }
        }
      }
    }
  }

  const nv = vPos.length / 3;
  const wp = new Float32Array(vPos);
  const wn = new Float32Array(vNorm);
  const aoArr = new Float32Array(vAo);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(wp, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(wn, 3));
  geometry.setAttribute('aAo', new THREE.BufferAttribute(aoArr, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  // Outer sandy abyss skirt from 112m out to 360m so horizon blends seamlessly into deep fog
  const skirtPos = [];
  const skirtNorm = [];
  const skirtAo = [];
  const skirtIdx = [];
  const segs = 96;
  const rings = [110, 155, 220, 340];
  for (let r = 0; r < rings.length; r++) {
    const rad = rings[r];
    const yDrop = -46.2 - r * r * 1.4;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      skirtPos.push(Math.cos(a) * rad, yDrop, Math.sin(a) * rad);
      skirtNorm.push(0, 1, 0);
      skirtAo.push(0.82 - r * 0.08);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const ns = (s + 1) % segs;
      const a = r * segs + s;
      const b = r * segs + ns;
      const c = (r + 1) * segs + s;
      const d_ = (r + 1) * segs + ns;
      skirtIdx.push(a, c, b, b, c, d_);
    }
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3));
  skirtGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(skirtNorm, 3));
  skirtGeometry.setAttribute('aAo', new THREE.Float32BufferAttribute(skirtAo, 1));
  skirtGeometry.setIndex(skirtIdx);
  skirtGeometry.computeBoundingSphere();

  // ============================================================================
  // Spatial Queries & Surface Snapping
  // ============================================================================
  function floorsAt(x, z) {
    const gx = Math.max(0, Math.min(NX - 2, Math.floor((x - OX) / VS)));
    const gz = Math.max(0, Math.min(NZ - 2, Math.floor((z - OZ) / VS)));
    const floors = [];
    let prev = dw(x, OY, z);
    for (let iy = 1; iy < NY - 1; iy++) {
      const y = OY + iy * VS;
      const cur = dw(x, y, z);
      // Crossing from solid below (prev > 0) to water above (cur <= 0)
      if (prev > 0 && cur <= 0) {
        const t = prev / (prev - cur);
        const yHit = y - VS + t * VS;
        const n = grad(x, yHit, z);
        if (n.y > 0.28) {
          floors.push({ y: yHit, ny: n.y, n });
        }
      }
      prev = cur;
    }
    if (floors.length === 0) {
      floors.push({ y: -45.5, ny: 1.0, n: new THREE.Vector3(0, 1, 0) });
    }
    return floors;
  }

  function gy(x, z) {
    const fl = floorsAt(x, z);
    return fl[0].y;
  }

  const _tmpG = new THREE.Vector3();
  function snap(pos, outNorm) {
    for (let it = 0; it < 4; it++) {
      const val = dw(pos.x, pos.y, pos.z);
      if (Math.abs(val) < 0.04) break;
      grad(pos.x, pos.y, pos.z, _tmpG);
      // Outward water normal points toward smaller dw, so moving by val * _tmpG zeroes dw
      const step = Math.max(-2.5, Math.min(2.5, val * 0.85));
      pos.addScaledVector(_tmpG, step);
    }
    if (outNorm) {
      grad(pos.x, pos.y, pos.z, outNorm);
    }
    return pos;
  }

  function pickVertex(filterFn) {
    for (let tries = 0; tries < 64; tries++) {
      const i = Math.floor(rnd() * nv);
      const x = wp[i * 3];
      const y = wp[i * 3 + 1];
      const z = wp[i * 3 + 2];
      const nx_ = wn[i * 3];
      const ny_ = wn[i * 3 + 1];
      const nz_ = wn[i * 3 + 2];
      if (!filterFn || filterFn(x, y, z, nx_, ny_, nz_, i)) {
        return i;
      }
    }
    return Math.floor(rnd() * nv);
  }

  // Smooth collision solver: zero per-frame allocations
  const _colN = new THREE.Vector3();
  function resolveCollision(pos, radius = 1.45) {
    // Clamp lateral world bounds inside playable reef arena
    pos.x = Math.max(-110, Math.min(110, pos.x));
    pos.z = Math.max(-110, Math.min(110, pos.z));
    pos.y = Math.max(-49, Math.min(28, pos.y));

    if (pos.y > -1.0) return; // Above surface transition

    for (let it = 0; it < 2; it++) {
      const d = dw(pos.x, pos.y, pos.z);
      if (d > -radius) {
        grad(pos.x, pos.y, pos.z, _colN);
        const push = d + radius;
        pos.addScaledVector(_colN, push);
      }
    }
  }

  // ============================================================================
  // 3D Skylight / Canopy Volume (96x24x96) & 2D Zone Map (512x512)
  // ============================================================================
  const VX = 96;
  const VY = 24;
  const VZ = 96;
  const volData = new Uint8Array(VX * VY * VZ * 4);
  const volTex = new THREE.Data3DTexture(volData, VX, VY, VZ);
  volTex.format = THREE.RGBAFormat;
  volTex.type = THREE.UnsignedByteType;
  volTex.minFilter = THREE.LinearFilter;
  volTex.magFilter = THREE.LinearFilter;
  volTex.wrapS = THREE.ClampToEdgeWrapping;
  volTex.wrapT = THREE.ClampToEdgeWrapping;
  volTex.wrapR = THREE.ClampToEdgeWrapping;

  const ZRES = 512;
  const zoneData = new Uint8Array(ZRES * ZRES * 4);
  const zoneMapTex = new THREE.DataTexture(zoneData, ZRES, ZRES, THREE.RGBAFormat, THREE.UnsignedByteType);
  zoneMapTex.minFilter = THREE.LinearFilter;
  zoneMapTex.magFilter = THREE.LinearFilter;
  zoneMapTex.wrapS = THREE.ClampToEdgeWrapping;
  zoneMapTex.wrapT = THREE.ClampToEdgeWrapping;

  let Lp = new Float32Array(VX * VZ).fill(1);
  let Ln = new Float32Array(VX * VZ);
  const tmpBlur = new Float32Array(VX * VZ);

  function updateGroundAndVolumeMaps(kelpAbs) {
    // Top-down skylight propagation (abyssal-garden algorithm):
    // R = SDF openness clamp(0.5 - d/12, 0, 1), G = propagated skylight, B = local openness, A = kelpOcc
    Lp.fill(1);
    for (let iy = VY - 1; iy >= 0; iy--) {
      const wy = OY + ((iy + 0.5) / VY) * SIZE_Y;
      // 3x3 separable blur horizontally across XZ skylight plane
      for (let iz = 0; iz < VZ; iz++) {
        for (let ix = 0; ix < VX; ix++) {
          const i = iz * VX + ix;
          const xm = ix > 0 ? i - 1 : i;
          const xp = ix < VX - 1 ? i + 1 : i;
          tmpBlur[i] = (Lp[xm] + 2.0 * Lp[i] + Lp[xp]) * 0.25;
        }
      }
      for (let iz = 0; iz < VZ; iz++) {
        const wz = OZ + ((iz + 0.5) / VZ) * SIZE_Z;
        for (let ix = 0; ix < VX; ix++) {
          const wx = OX + ((ix + 0.5) / VX) * SIZE_X;
          const i = iz * VX + ix;
          const zm = iz > 0 ? i - VX : i;
          const zp = iz < VZ - 1 ? i + VX : i;
          const b = (tmpBlur[zm] + 2.0 * tmpBlur[i] + tmpBlur[zp]) * 0.25;

          const baseIdx = (iz * VY + iy) * VX + ix;
          const p4 = baseIdx * 4;
          const d = dw(wx, wy, wz);
          const kelpOcc = kelpAbs ? Math.max(0.0, Math.min(1.0, kelpAbs[baseIdx])) : 0.0;

          const l = b * Math.max(0.0, Math.min(1.0, 0.5 - d / 1.5)) * (1.0 - Math.min(kelpOcc, 0.5));
          Ln[i] = l;

          const sdfOpen = Math.max(0.0, Math.min(1.0, 0.5 - d / 12.0));
          const cavOpen = Math.max(0.0, Math.min(1.0, 0.5 - d / 4.0));
          volData[p4] = Math.round(sdfOpen * 255);
          volData[p4 + 1] = Math.round(Math.min(1.0, b) * 255);
          volData[p4 + 2] = Math.round(cavOpen * 255);
          volData[p4 + 3] = Math.round(kelpOcc * 255);
        }
      }
      const swap = Lp;
      Lp = Ln;
      Ln = swap;
    }
    volTex.needsUpdate = true;

    // 2D Zone Map: R = magAt, G = kelpSum, B = zoneP, A = sandNoiseMask
    for (let j = 0; j < ZRES; j++) {
      const wz = OZ + ((j + 0.5) / ZRES) * SIZE_Z;
      for (let i = 0; i < ZRES; i++) {
        const wx = OX + ((i + 0.5) / ZRES) * SIZE_X;
        const p4 = (j * ZRES + i) * 4;
        const mZone = magAt(wx, wz);
        const pZone = zoneP(wx, wz);
        let clr = 0.0;
        for (let cIdx = 0; cIdx < CLEARS.length; cIdx++) {
          const c = CLEARS[cIdx];
          const cw = 1.0 - smoothstep(0.0, c.soft * 1.25, seg2(wx, wz, c.ax, c.az, c.bx, c.bz) - c.r);
          if (cw > clr) clr = cw;
        }
        const noiseSand = smoothstep(0.28, 0.56, fbm2(wx * 0.04 + 1.1, wz * 0.04 - 0.7, 3));
        const bhSand = 1.0 - smoothstep(10.0, 18.0, Math.hypot(wx - 61.5, wz - 64.5));
        const sandMask = Math.max(clr * 0.95, Math.max(bhSand * 0.92, noiseSand));

        let kSum = 0;
        if (kelpAbs) {
          const kx = Math.max(0, Math.min(VX - 1, Math.floor(((wx - OX) / SIZE_X) * VX)));
          const kz = Math.max(0, Math.min(VZ - 1, Math.floor(((wz - OZ) / SIZE_Z) * VZ)));
          for (let ky = 4; ky < VY - 2; ky++) {
            kSum = Math.max(kSum, kelpAbs[(kz * VY + ky) * VX + kx]);
          }
        }

        zoneData[p4] = Math.round(mZone * 255);
        zoneData[p4 + 1] = Math.round(Math.max(0, Math.min(1, kSum)) * 255);
        zoneData[p4 + 2] = Math.round(pZone * 255);
        zoneData[p4 + 3] = Math.round(sandMask * 255);
      }
    }
    zoneMapTex.needsUpdate = true;
  }

  // Initial bake without kelp canopy (updated again once kelp forest compiles in Step 3)
  updateGroundAndVolumeMaps(null);

  return {
    geometry,
    skirtGeometry,
    D,
    wp,
    wn,
    nv,
    dw,
    grad,
    floorsAt,
    gy,
    snap,
    pickVertex,
    resolveCollision,
    zoneP,
    magAt,
    volTex,
    zoneMapTex,
    updateGroundAndVolumeMaps,
  };
}

// ============================================================================
// GLSL3 Solid Terrain & Prop Shader Materials (W_SOLID 4-Octave Multi-Triplanar)
// ============================================================================
export function bindSharedUniforms(material, sharedUniforms) {
  material.uniforms = sharedUniforms;
  return material;
}

const SOLID_SWAY_GLSL = /* glsl */ `
  void applyFloraAndAnemoneSway(float kind, vec3 posScale, vec4 meta, float time, inout vec3 lp, inout vec3 ln) {
    // Delicate current sway for gorgonian sea fans (kind == 3)
    if (kind > 2.5 && kind < 3.5) {
      float h = clamp(lp.y * 0.25, 0.0, 1.0);
      float swayX = sin(time * 1.45 + posScale.x * 0.37 + posScale.z * 0.41 + lp.y * 0.6) * 0.14 * h * h;
      float swayZ = cos(time * 1.15 + posScale.z * 0.31) * 0.08 * h * h;
      lp.x += swayX;
      lp.z += swayZ;
    } else if (kind > 7.5 && kind < 8.5) {
      // Sea Anemone (kind == 8): pedal column anchored while crown tentacles sway with waves & writhe organically
      float flex = smoothstep(0.18, 0.95, lp.y);
      float ang = atan(lp.z, lp.x);
      float surgePh = time * 1.45 + posScale.x * 0.22 + posScale.z * 0.19;
      float writhePh = time * 2.7 + ang * 3.0 - lp.y * 5.0 + meta.y * 17.0;
      float dx = (sin(surgePh) * 0.26 + cos(writhePh) * 0.12) * flex;
      float dz = (cos(surgePh * 0.85 + 0.7) * 0.22 + sin(writhePh) * 0.12) * flex;
      float dy = sin(time * 2.1 + lp.y * 3.5 + meta.y * 13.0) * 0.045 * flex;
      lp.x += dx;
      lp.z += dz;
      lp.y += dy;
      ln = normalize(ln + vec3(dx * 0.65, 0.15 * flex, dz * 0.65));
    } else if (kind > 9.5) {
      // Giant Gorgonian Sea Fan (kind == 10): broad flexible fan undulates gently in cross-wall surge
      float h = clamp(length(lp.xy) * 0.45, 0.0, 1.0);
      float surge = sin(time * 0.95 + posScale.x * 0.25 + posScale.z * 0.28 + lp.x * 0.7);
      float ripple = cos(time * 1.45 + lp.y * 0.8 + posScale.y * 0.4);
      lp.z += (surge * 0.095 + ripple * 0.032) * h * h;
    }
  }
`;

// Shared Giant Sea Fan lacy cutout alpha test used by both solid & shadow passes
const GIANT_FAN_LACE_GLSL = /* glsl */ `
  bool giantFanLaceKeep(vec3 lp, float ao, float seedVal, out float outRadNorm, out float outVeinMask) {
    vec2 fp = lp.xy - vec2(0.0, 0.10);
    float r = length(fp);
    float th = atan(fp.x, fp.y);
    float s = seedVal * 19.3;
    float reniform = 1.72 * (0.64 + 0.36 * cos(clamp(th * 0.72, -1.65, 1.65)));
    float rim = reniform * (1.0 + 0.08 * sin(th * 5.0 + s) + 0.048 * cos(th * 11.0 - s * 1.7) + 0.028 * sin(th * 21.0 + s * 2.9));
    outRadNorm = clamp(r / max(rim, 0.25), 0.0, 1.0);
    if (ao < 0.52) {
      // 3D woody structural ribs & basal holdfast stay completely solid
      outVeinMask = 1.0;
      return true;
    }
    if (r > rim || abs(th) > 2.12) {
      outVeinMask = 0.0;
      return false;
    }
    float wTex1 = textureLod(uDetailTex, fp * 0.55 + vec2(seedVal), 0.0).b;
    float wTex2 = textureLod(uDetailTex, fp * 1.45 - vec2(0.3, seedVal * 2.7), 0.0).a;
    float warp = (wTex1 - 0.5) * 0.20 + (wTex2 - 0.5) * 0.08;

    // Sharp dichotomous radial filigree ribs (peaks = narrow 1-2cm coral veins)
    float thW = th + warp * (0.35 + 0.65 * outRadNorm);
    float v1 = smoothstep(0.84, 0.98, abs(sin(thW * 7.5 + sin(r * 2.2 + s) * 0.28)));
    float v2 = smoothstep(0.82, 0.97, abs(sin(thW * 18.0 + wTex1 * 1.4)));
    float v3 = smoothstep(0.80, 0.96, abs(sin(thW * 42.0 - r * 2.5 + wTex2 * 1.8)));
    float radVein = max(v1, max(v2 * 0.90, v3 * 0.80));

    // Delicate transverse & anastomosing cellular cross-meshwork (smooth procedural sine + soft fbm, zero blocky pixels)
    float cross1 = smoothstep(0.80, 0.96, abs(sin(r * 26.0 + thW * 3.0 + (wTex2 - 0.5) * 2.4)));
    float cross2 = smoothstep(0.82, 0.97, abs(sin(r * 46.0 - fp.x * 18.0 + (wTex1 - 0.5) * 3.2)));
    float filigree = max(radVein, max(cross1 * 0.82, cross2 * 0.72));

    // Organic lacy filigree margin taper so outer tips dissolve into airy net
    float marginFade = 1.0 - smoothstep(0.86, 1.0, outRadNorm) * 0.35;
    filigree *= marginFade;
    float poreThresh = mix(0.36, 0.56, pow(outRadNorm, 0.75));
    outVeinMask = clamp((filigree - poreThresh) / (1.0 - poreThresh), 0.0, 1.0);
    return filigree >= poreThresh;
  }
`;

export function createSolidMaterial(sharedUniforms, { instanced = false, isSkirt = false, doubleSide = false } = {}) {
  const vs = /* glsl */ `
    attribute float aAo;
    ${instanced ? `
    attribute vec4 iPosScale;
    attribute vec4 iQuat;
    attribute vec4 iMeta;
    ` : ''}

    ${MEDIUM_GLSL}
    ${SOLID_SWAY_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vOp;
    out vec3 vOn;
    out vec3 vLocalPos;
    out float vAo;
    out vec4 vMeta;
    flat out vec4 vQuat;

    void main() {
      vec3 lp = position;
      vec3 ln = normal;
      vec3 wp;
      vec3 wn;

      ${instanced ? `
      float kind = floor(iMeta.x + 0.5);
      applyFloraAndAnemoneSway(kind, iPosScale.xyz, iMeta, uTime, lp, ln);
      wp = iPosScale.xyz + qrot(iQuat, lp * iPosScale.w);
      wn = normalize(qrot(iQuat, ln));
      vOp = lp * iPosScale.w + iMeta.y * 37.0;
      vOn = ln;
      vMeta = iMeta;
      vQuat = iQuat;
      ` : `
      wp = (modelMatrix * vec4(lp, 1.0)).xyz;
      wn = normalize(mat3(modelMatrix) * ln);
      vec4 gmVert = zone(wp.xz);
      float fltVert = ${isSkirt ? '1.0' : 'ss(0.54, 0.84, wn.y)'};
      float sandVertWeight = (1.0 - sat(gmVert.r * 1.15)) * max(fltVert * gmVert.a, fltVert * ss(-33.0, -41.5, wp.y));
      vec4 sandBedVert = sampleSandBed(wp.xz);
      wp.y += sandBedVert.x * sandVertWeight * 1.35;
      wn = normalize(wn + vec3(sandBedVert.z, 0.0, sandBedVert.w) * (sandVertWeight * 1.25));
      vOp = wp;
      vOn = wn;
      vMeta = vec4(-1.0, 0.0, 0.0, 1.0);
      vQuat = vec4(0.0, 0.0, 0.0, 1.0);
      `}

      vWPos = wp;
      vWNorm = wn;
      vLocalPos = lp;
      vAo = aAo;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}
    ${GIANT_FAN_LACE_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vOp;
    in vec3 vOn;
    in vec3 vLocalPos;
    in float vAo;
    in vec4 vMeta;
    flat in vec4 vQuat;

    layout(location = 0) out vec4 fragColor;

    void main() {
      float faceFlip = gl_FrontFacing ? 1.0 : -1.0;
      vec3 on = normalize(vOn) * faceFlip;
      vec3 gn = normalize(vWNorm) * faceFlip;
      float dist = length(uCamPos - vWPos);

      float kind = vMeta.x < -0.5 ? -1.0 : floor(vMeta.x + 0.5);
      bool isRockLike = kind < 0.5; // terrain (-1) or rock chunks/boulders (0)
      float ts = kind > 4.5 ? 1.0 : 1.0;

      // Keep all derivative-dependent lookups in uniform control flow prior to alpha cutout
      TP A = tri(vOp, on, 0.10 * ts);
      TP B = tri(vOp, on, 0.43 * ts);
      TP C = tri(vOp, on, 1.90 * ts);
      TP F = tri(vOp, on, 6.70 * ts);
      vec2 sandDx = dFdx(vWPos.xz);
      vec2 sandDy = dFdy(vWPos.xz);
      float fk = isRockLike ? ss(12.0, 1.5, dist) : 0.0;

      float fanRadNorm = 0.0;
      float fanVeinMask = 1.0;
      if (kind > 9.5) {
        if (!giantFanLaceKeep(vLocalPos, vAo, vMeta.y, fanRadNorm, fanVeinMask)) discard;
      }

      vec4 Wd = texture(uDetailTex, vec2(vOp.x * 0.06, (vOp.y + vOp.z) * 0.7));
      float big = texture(uDetailTex, vOp.xz * 0.013 + vOp.y * 0.021).a;
      float big2 = texture(uDetailTex, vOp.zx * 0.031 + vOp.y * 0.043 + 0.37).a;
      vec4 sk = texture(uDetailTex, vec2((vOp.x + vOp.z) * 0.33, vOp.y * 0.035));
      vec4 sk2 = texture(uDetailTex, vec2((vOp.x - vOp.z) * 1.1, vOp.y * 0.11));

      vec4 gm = texture(uZoneMapTex, clamp((vWPos.xz - vec2(-120.0)) / 240.0, vec2(0.0), vec2(1.0)));
      vec3 ca = causRGB(vWPos, dist);
      float hgt = A.h * 0.5 + B.h * 0.35 + C.h * 0.15;

      float sgro = 0.0;
      float bump = 1.65;
      float gloss = 0.10;
      vec3 alb = vec3(0.0);
      vec3 emi = vec3(0.0);
      float vao = vAo;
      float flu = 0.0;
      float flt = ss(0.70, 0.92, gn.y);
      ${isSkirt ? 'flt = 1.0;' : ''}
      float sandMask = 0.0;
      vec3 sandFacetNormal = gn;

      if (isRockLike) {
        // ---- Layered Abyssal Rock + Crustose Encrustation + Deformable Procedural Sand & Magenta Floor Cover ----
        float st = vOp.y * 0.55 + A.h * 1.6 + big * 5.0 + big2 * 3.0;
        float bed = hs(floor(st));
        float sf = fract(st);

        alb = mix(vec3(0.11, 0.12, 0.13), vec3(0.33, 0.30, 0.25), sat(A.c * 1.5 - 0.25));
        alb = mix(alb, mix(vec3(0.26, 0.19, 0.10), vec3(0.20, 0.22, 0.14), bed), ss(0.42, 0.66, big) * 0.70);
        alb *= mix(0.72, 1.15, bed) * (1.0 - 0.45 * ss(0.12, 0.0, sf) * (1.0 - abs(on.y)));

        // Rust-red & ochre crustose coralline encrustations + pale calcareous patches
        float enc = ss(0.46, 0.60, big2 * 0.6 + B.c * 0.5) * ss(0.30, 0.60, hgt);
        alb = mix(alb, mix(vec3(0.34, 0.07, 0.10), vec3(0.40, 0.25, 0.07), ss(0.45, 0.60, A.c)) * (0.5 + 0.8 * B.h), enc * 0.75);
        alb = mix(alb, vec3(0.50, 0.50, 0.46) * (0.5 + 0.7 * C.h), ss(0.60, 0.70, B.c * 0.6 + C.c * 0.5) * 0.5);

        // Velvety coralline olive algae on upward rock shelves
        float alg = ss(-0.1, 0.6, gn.y) * ss(0.30, 0.52, B.c * 0.55 + big * 0.5);
        alb = mix(alb, vec3(0.035, 0.14, 0.07), alg * 0.80);
        alb *= (0.24 + 1.28 * hgt) * mix(1.0, 0.62 + 0.76 * F.h, fk);
        sgro = -ss(0.14, 0.0, sf) * (1.0 - abs(on.y)) * 1.20;

        if (kind < -0.5) {
          float seabedDepthMask = ${isSkirt ? '1.0' : 'ss(-37.2, -40.8, vWPos.y)'};
          float fltSand = ${isSkirt ? '1.0' : 'ss(0.50, 0.78, gn.y)'};
          float rawSand = ${isSkirt ? '0.99' : 'fltSand * seabedDepthMask * mix(0.72, 1.0, gm.a)'};
          float mgRaw = ${isSkirt ? '0.0' : 'flt * sat(gm.r * 1.4 - 0.50 + (B.c - 0.5) * 1.5) * ss(0.42, 0.68, A.h)'};
          sandMask = clamp(rawSand * (1.0 - mgRaw * 0.15), 0.0, 1.0);
          float mg = mgRaw * (1.0 - sandMask * 0.92);

          alb = mix(alb, vec3(0.22, 0.025, 0.13) * (0.40 + 0.90 * B.h), mg * 0.82);
          flu = mg * 0.35;
          alb = mix(alb, alb * vec3(0.85, 0.80, 1.40) + vec3(0.015, 0.0, 0.05), gm.b * (0.80 - 0.75 * sandMask));
        } else {
          // Cliff boulder / pebble subtle zone tint
          alb = mix(alb, alb * vec3(0.90, 0.82, 1.28) + vec3(0.02, 0.005, 0.04), vMeta.z * 0.35);
          vao = 0.55 + 0.45 * vAo;
        }
      } else if (kind < 1.5) {
        // 1: Barrel Sponges (warm terracotta / burnt orange / ochre / magenta)
        float hue = fract(vMeta.y * 7.31);
        alb = mix(vec3(0.60, 0.17, 0.08), vec3(0.64, 0.35, 0.10), fract(hue * 3.0));
        if (hue > 0.75) alb = vec3(0.44, 0.18, 0.42);
        alb = mix(alb, vec3(0.55, 0.14, 0.38), vMeta.z * 0.45);
        alb *= (0.45 + 0.75 * B.h) * (0.7 + 0.3 * C.h);
        vao = vAo * vAo;
        gloss = 0.20;
        bump = 1.40;
        flu = 0.55;
      } else if (kind < 4.5) {
        // 2, 3, 4: Branching Staghorn Coral, Gorgonian Sea Fans & Tube Coral Clusters
        float hue = fract(vMeta.y * 5.73);
        alb = mix(vec3(0.80, 0.08, 0.10), vec3(0.90, 0.22, 0.40), fract(hue * 4.0));
        if (hue > 0.70) alb = vec3(0.88, 0.42, 0.10);
        if (hue > 0.90) alb = vec3(0.55, 0.22, 0.75);
        if (kind > 3.5 && hue < 0.35) alb = vec3(0.18, 0.48, 0.44);
        alb *= (0.40 + 0.80 * B.h) * (0.50 + 0.90 * vAo * vAo);
        alb = mix(alb, vec3(1.0, 0.75, 0.60), ss(0.80, 1.0, vAo) * 0.35);
        emi = alb * 0.015;
        flu = 0.75;
        gloss = 0.25;
        bump = 1.50;
      } else if (kind < 5.5) {
        // 5: Monumental Stone Whale Fluke (smooth pale limestone with dark veins)
        alb = mix(vec3(0.42, 0.47, 0.48), vec3(0.10, 0.13, 0.15), ss(0.40, 0.62, sk.a * 0.6 + sk2.b * 0.5)) * (0.75 + 0.3 * B.h);
        alb = mix(alb, vec3(0.60, 0.64, 0.62), ss(0.62, 0.75, sk2.a) * 0.5);
        gloss = 0.90;
        bump = 0.30;
        vao = 0.65 + 0.35 * vAo;
      } else if (kind < 6.5) {
        // 6: Sunken Wooden Shipwreck (waterlogged oak planks + verdigris patina)
        alb = mix(vec3(0.13, 0.085, 0.05), vec3(0.36, 0.25, 0.14), Wd.b) * (0.60 + 0.50 * B.h);
        float pk = fract(atan(vOp.z, 2.0 - vOp.y) * 7.0);
        alb *= 0.35 + 0.65 * ss(0.0, 0.12, min(pk, 1.0 - pk));
        alb = mix(alb, vec3(0.08, 0.22, 0.16), ss(0.50, 0.70, A.c) * 0.60);
        gloss = 0.20;
        bump = 0.70;
        vao = 0.65 + 0.35 * vAo;
      } else if (kind < 7.5) {
        // 7: Twisted Giant Kelp Stipe Columns
        alb = mix(vec3(0.11, 0.15, 0.06), vec3(0.22, 0.23, 0.08), B.h) * (0.75 + 0.35 * C.h);
        gloss = 0.22;
        bump = 0.95;
        flu = 0.18;
      } else if (kind < 8.5) {
        // 8: Swaying Sea Anemones (Rose Bubble-Tip, Electric Turquoise, Golden-Coral)
        float morph = fract(vMeta.y * 3.7);
        float tipMask = smoothstep(0.58, 0.98, vAo);
        vec3 baseCol = vec3(0.32, 0.12, 0.24);
        vec3 tipCol  = vec3(0.96, 0.28, 0.68);
        if (morph > 0.33 && morph <= 0.66) {
          baseCol = vec3(0.08, 0.32, 0.30);
          tipCol  = vec3(0.36, 0.92, 0.85);
        } else if (morph > 0.66) {
          baseCol = vec3(0.42, 0.16, 0.10);
          tipCol  = vec3(0.98, 0.72, 0.28);
        }
        alb = mix(baseCol, tipCol, tipMask) * (0.75 + 0.35 * B.h);
        emi = mix(baseCol, tipCol, tipMask * 1.15) * (0.02 + 0.04 * tipMask);
        gloss = 0.45;
        bump = 0.45;
        flu = 0.92;
        vao = 0.45 + 0.55 * vAo;
      } else if (kind < 9.5) {
        // 9: Sunken WWII Fighter Plane Wreck (weathered duralumin panels, rivets, muted Pacific slate & coral encrustation)
        vec3 paintCol = mix(vec3(0.14, 0.20, 0.21), vec3(0.35, 0.40, 0.39), sat(A.c * 1.4 - 0.15));
        float gxSeam = abs(fract(vLocalPos.x * 1.15) - 0.5);
        float gzSeam = abs(fract(vLocalPos.z * 1.35) - 0.5);
        float panelSeam = 1.0 - ss(0.0, 0.036, min(gxSeam, gzSeam));
        // Subtle rivet dots along sheet panel edges
        float rvX = abs(fract(vLocalPos.x * 18.0) - 0.5);
        float rvZ = abs(fract(vLocalPos.z * 18.0) - 0.5);
        float rivet = (1.0 - ss(0.05, 0.14, length(vec2(rvX, rvZ)))) * ss(0.09, 0.01, min(gxSeam, gzSeam));
        alb = paintCol * (0.78 + 0.36 * B.h) * (1.0 - panelSeam * 0.46) + vec3(0.08, 0.10, 0.10) * rivet;
        // Exposed pale aluminum abrasion along wing leading edges & spars
        float edgeWear = ss(0.42, 0.72, C.h * 0.6 + A.h * 0.5) * ss(0.70, 0.95, vAo);
        alb = mix(alb, vec3(0.62, 0.68, 0.66), edgeWear * 0.35);
        // Calcareous marine algae & silt accumulation on upward-facing skins
        float encrust = ss(-0.05, 0.68, gn.y) * ss(0.42, 0.66, big * 0.55 + B.c * 0.55);
        alb = mix(alb, vec3(0.16, 0.28, 0.22) * (0.65 + 0.6 * C.h), encrust * 0.65);
        // Dark corroded iron soot around engine cowling & cockpit interior
        float engineRust = ss(3.15, 4.45, vLocalPos.z);
        alb = mix(alb, vec3(0.22, 0.15, 0.11) * (0.7 + 0.5 * B.h), engineRust * 0.62);
        sgro = -panelSeam * 0.65;
        gloss = 0.36;
        bump = 0.42;
        vao = 0.55 + 0.45 * vAo;
      } else {
        // 10: Giant Gorgonian Sea Fan (branching mahogany core ribs + lacy backlit olive/gold/crimson meshwork)
        float morph = fract(vMeta.y * 5.3);
        vec3 ribCol = vec3(0.12, 0.08, 0.05);
        vec3 webCol = vec3(0.24, 0.23, 0.13);
        vec3 edgeCol = vec3(0.36, 0.34, 0.21);
        if (morph > 0.66 && morph <= 0.86) {
          ribCol = vec3(0.18, 0.05, 0.04);
          webCol = vec3(0.40, 0.10, 0.07);
          edgeCol = vec3(0.56, 0.22, 0.13);
        } else if (morph > 0.86) {
          ribCol = vec3(0.14, 0.04, 0.11);
          webCol = vec3(0.34, 0.09, 0.26);
          edgeCol = vec3(0.50, 0.21, 0.42);
        }
        float isSkel = 1.0 - ss(0.44, 0.56, vAo);
        vec3 laceTint = mix(webCol, edgeCol, fanRadNorm * 0.65 + (1.0 - fanVeinMask) * 0.25);
        alb = mix(laceTint, ribCol, isSkel * 0.90) * (0.68 + 0.48 * C.h);
        flu = 0.26;
        gloss = 0.18;
        bump = 0.65;
        vao = mix(0.92, 0.65, isSkel);
      }

      vec3 rockN = normalize(qrot(
        vQuat,
        normalize(on + (A.n * 0.85 + B.n * 0.65 + C.n * 0.45 * ss(60.0, 12.0, dist) + F.n * 0.5 * fk) * bump + vec3(0.8, sgro, 0.35))
      ));

      vec3 L = uSunDir;
      vec3 V = normalize(uCamPos - vWPos);

      ${isSkirt ? `
      float ao = 0.78 * ss(0.12, 0.60, hgt);
      float sky = 0.72;
      float sideOpen = 0.65;
      float sh = 1.0;
      ` : `
      vec4 v1 = vol(vWPos + gn * 1.5);
      vec4 v2 = vol(vWPos + gn * 4.5);
      float baseHgtAo = mix(ss(0.12, 0.60, hgt), 0.90, sandMask);
      float ao = (sat((v1.r - 0.5) * 8.0) * 0.55 + sat((v2.r - 0.5) * 2.7) * 0.45) * vao * baseHgtAo;
      ao = max(ao, 0.06);
      float sky = v1.g;
      float sideOpen = sat((v2.r - 0.5) * 2.7);
      float sh = shadow9(vWPos + gn * 0.35);
      `}

      float z = zone(vWPos);
      vec3 E = sunE(vWPos.y, z) * sh;
      vec3 am = (amb(vWPos, rockN, sky, z) + sideLight(vWPos, rockN, sideOpen, z)) * ao;

      vec3 sandTotal = vec3(0.0);
      if (sandMask > 0.01) {
        sandTotal = shadeDeformableSand(vWPos, gn, uCamPos, sh * (0.45 + 0.55 * sky), ca, E, am, sandDx, sandDy, gl_FragCoord.xy, sandFacetNormal);
      }

      float sandNormWeight = smoothstep(0.04, 0.68, sandMask);
      vec3 N = (sandMask > 0.01) ? normalize(mix(rockN, sandFacetNormal, sandNormWeight)) : rockN;

      float ndl = sat(dot(N, L));
      float ndv = max(0.02, dot(N, V));

      vec3 amLit = (amb(vWPos, N, sky, z) + sideLight(vWPos, N, sideOpen, z)) * ao;
      vec3 dl = E * ndl * (0.10 + mix(vec3(0.33), ca, ss(0.10, 0.45, dot(gn, L))) * 2.5);
      vec3 c = alb * (dl + amLit) + emi + alb * flu * dot(dl + amLit, vec3(0.1, 0.5, 0.5));
      if (kind > 9.5) {
        // Backlit translucent stained-glass glow through lacy Giant Sea Fan
        float backSun = pow(sat(dot(-V, L) * 0.55 + 0.45), 2.2);
        float transWeight = (1.0 - (1.0 - ss(0.44, 0.56, vAo)) * 0.72);
        c += alb * (E * (0.12 + 0.38 * backSun) + vec3(0.14, 0.28, 0.34) * sky * 0.22) * transWeight;
      }

      vec3 H = normalize(V + L);
      vec3 rockSpecCol = E * (0.25 + ca) * pow(sat(dot(N, H)), mix(10.0, 70.0, gloss)) * gloss * ndl * 1.8;
      vec3 rockEnvCol = (amb(vWPos, reflect(-V, N), sky, z) + sideLight(vWPos, reflect(-V, N), sideOpen, z)) * ao * (0.08 + gloss) * 0.6 * pow(1.0 - sat(dot(N, V)), 2.5);
      vec3 rockFinal = fog(c + rockSpecCol + rockEnvCol, vWPos, z);

      if (sandMask > 0.01) {
        vec3 sandFinal = fog(sandTotal, vWPos, z);
        fragColor = vec4(mix(rockFinal, sandFinal, smoothstep(0.02, 0.78, sandMask)), 1.0);
      } else {
        fragColor = vec4(rockFinal, 1.0);
      }
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  return bindSharedUniforms(mat, sharedUniforms);
}

export function createSolidShadowMaterial({ instanced = false, sharedUniforms } = {}) {
  const vs = /* glsl */ `
    ${instanced ? `
    attribute float aAo;
    attribute vec4 iPosScale;
    attribute vec4 iQuat;
    attribute vec4 iMeta;
    out vec3 vLocalPos;
    out float vAo;
    out vec4 vMeta;
    ` : ''}
    uniform float uTime;

    ${SOLID_SWAY_GLSL}

    vec3 qrot(vec4 q, vec3 v) {
      return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
    }

    void main() {
      vec3 lp = position;
      vec3 dummyN = vec3(0.0, 1.0, 0.0);
      vec3 wp;
      ${instanced ? `
      float kind = floor(iMeta.x + 0.5);
      applyFloraAndAnemoneSway(kind, iPosScale.xyz, iMeta, uTime, lp, dummyN);
      wp = iPosScale.xyz + qrot(iQuat, lp * iPosScale.w);
      vLocalPos = lp;
      vAo = aAo;
      vMeta = iMeta;
      ` : `
      wp = (modelMatrix * vec4(lp, 1.0)).xyz;
      `}
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    ${instanced ? `
    uniform sampler2D uDetailTex;
    in vec3 vLocalPos;
    in float vAo;
    in vec4 vMeta;
    ${GIANT_FAN_LACE_GLSL}
    ` : ''}
    layout(location = 0) out vec4 fragColor;
    void main() {
      ${instanced ? `
      float kind = floor(vMeta.x + 0.5);
      if (kind > 9.5) {
        float rN;
        float vM;
        if (!giantFanLaceKeep(vLocalPos, vAo, vMeta.y, rN, vM)) discard;
      }
      ` : ''}
      fragColor = vec4(1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    uniforms: sharedUniforms,
    side: THREE.DoubleSide,
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 2.0,
    polygonOffsetUnits: 2.0,
  });
  return sharedUniforms ? bindSharedUniforms(mat, sharedUniforms) : mat;
}
