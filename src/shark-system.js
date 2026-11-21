import * as THREE from 'three';
import { MEDIUM_GLSL } from './env/medium.js';
import { bindSharedUniforms, rseed, rnd, rr } from './env/terrain.js';

// ============================================================================
// Shared Mikkelsen Surface-Gradient Bump Mapping (4K-Equivalent Analytic Relief)
// ============================================================================
const SURFACE_GRADIENT_BUMP_GLSL = `
  vec3 perturbNormalBump(vec3 surfPos, vec3 surfNorm, float heightVal, float bumpStrength) {
    vec3 dPosX = dFdx(surfPos);
    vec3 dPosY = dFdy(surfPos);
    vec3 r1 = cross(dPosY, surfNorm);
    vec3 r2 = cross(surfNorm, dPosX);
    float det = dot(dPosX, r1);
    if (abs(det) < 1e-6) return surfNorm;
    float dHdx = dFdx(heightVal);
    float dHdy = dFdy(heightVal);
    vec3 surfGrad = sign(det) * (dHdx * r1 + dHdy * r2) / max(abs(det), 1e-5);
    // Clamp extreme grazing-angle triangle-edge derivatives so zero black 1px speckles ever appear
    float gLen = length(surfGrad);
    if (gLen > 4.2) surfGrad *= 4.2 / gLen;
    return normalize(surfNorm - bumpStrength * surfGrad);
  }
`;

// ============================================================================
// GTA-6-Grade Anatomical Apex Shark Builder (Carcharodon / Pelagic Reef Shark)
// High-Res Sculpted Fusiform Body (136x60) + Auto-Outward-Wound Watertight
// NACA-0012 Hydrofoil Fins + 5 Sculpted Branchial Gill Arches + Recessed Nares +
// Parabolic Jaw Cavity with 36 Serrated Enamel Teeth + Sculpted Orbital Eyes +
// 2 Symbiotic Remora Suckerfish (Zero Shared-Vertex Material Bleed!)
// ============================================================================
function buildAnatomicalSharkGeometry() {
  const pos = [];
  const spineCoord = []; // vec2(tAlongSpine, swimAmpWeight)
  // Clean continuous weights: x = finEdgeThin, y = gillRecess, z = mouthCavity, w = hardPartId (disconnected meshes only: 0=skin, 1=eye, 2=teeth, 3=remora)
  const matWeights = [];
  const idx = [];

  function pushV(x, y, z, t, sw, finEdge = 0, gill = 0, mouth = 0, hardId = 0) {
    const id = pos.length / 3;
    pos.push(x, y, z);
    spineCoord.push(t, sw);
    matWeights.push(finEdge, gill, mouth, hardId);
    return id;
  }

  // Ensures any closed lofted appendage (fins, remoras) has 100% outward-pointing CCW normals
  function ensureOutwardWinding(startIdxOffset) {
    let signedVol6 = 0;
    let cx = 0, cy = 0, cz = 0;
    let vCount = 0;
    for (let k = startIdxOffset; k < idx.length; k += 3) {
      const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
      cx += pos[i0] + pos[i1] + pos[i2];
      cy += pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1];
      cz += pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2];
      vCount += 3;
    }
    if (vCount === 0) return;
    cx /= vCount; cy /= vCount; cz /= vCount;
    for (let k = startIdxOffset; k < idx.length; k += 3) {
      const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
      const ax = pos[i0] - cx, ay = pos[i0 + 1] - cy, az = pos[i0 + 2] - cz;
      const bx = pos[i1] - cx, by = pos[i1 + 1] - cy, bz = pos[i1 + 2] - cz;
      const dx = pos[i2] - cx, dy = pos[i2 + 1] - cy, dz = pos[i2 + 2] - cz;
      // Triple product a · (b x d)
      signedVol6 += ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx);
    }
    if (signedVol6 < 0) {
      for (let k = startIdxOffset; k < idx.length; k += 3) {
        const tmp = idx[k + 1];
        idx[k + 1] = idx[k + 2];
        idx[k + 2] = tmp;
      }
    }
  }

  // ---- 1. High-Resolution Continuous Body Fusiform Loft (Nose +3.28 -> Peduncle -2.32) ----
  const nLen = 136;
  const nRad = 60;
  const bodyRings = [];

  function bodyRadius(t) {
    if (t < 0.036) {
      return Math.pow(Math.max(0.007, t / 0.036), 0.56) * 0.225;
    } else if (t < 0.31) {
      const u = (t - 0.036) / 0.274;
      return 0.225 + Math.sin(u * Math.PI * 0.5) * 0.475;
    } else if (t < 0.84) {
      const u = (t - 0.31) / 0.53;
      return 0.70 * (1.0 - Math.pow(u, 1.35) * 0.835);
    } else {
      const u = (t - 0.84) / 0.16;
      return Math.max(0.030, 0.116 * (1.0 - u * 0.74));
    }
  }

  for (let i = 0; i <= nLen; i++) {
    const t = i / nLen;
    const z = 3.28 - t * 5.60; // +3.28 (snout tip) -> -2.32 (caudal peduncle root)
    const baseR = bodyRadius(t);

    // Pre-caudal lateral keels along peduncle (t in [0.74..0.97])
    const pedFactor = Math.max(0, (t - 0.64) / 0.36);
    const keelBulge = t > 0.74 && t < 0.97 ? Math.sin(((t - 0.74) / 0.23) * Math.PI) * 0.078 : 0.0;
    const rx = baseR * (0.90 + 0.18 * Math.sin(t * Math.PI)) * (1.0 - 0.20 * pedFactor) + keelBulge;
    const ry = baseR * (1.16 - 0.24 * pedFactor);

    // Conical predatory snout overhang + powerful Great White dorsal epaxial shoulder bulk
    const centerY = t < 0.145
      ? 0.025 - 0.055 * Math.pow(1.0 - t / 0.145, 1.75)
      : Math.sin(t * Math.PI) * 0.088 + (t > 0.20 && t < 0.50 ? Math.sin(((t - 0.20) / 0.30) * Math.PI) * 0.052 : 0.0);

    // Biomechanical carangiform wave envelope
    const sw = t < 0.19 ? 0.028 * (t / 0.19) : 0.028 + 0.972 * Math.pow((t - 0.19) / 0.81, 1.70);

    const ring = [];
    for (let s = 0; s < nRad; s++) {
      const a = (s / nRad) * Math.PI * 2; // 0 = dorsal (+Y), pi = belly (-Y)
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const absSa = Math.abs(sa);

      let x = sa * rx;
      let y = centerY + ca * ry;
      let gillW = 0.0;
      let mouthW = 0.0;

      // Flattened aerodynamic underside of conical snout (rostrum)
      if (t < 0.165 && ca < -0.14) {
        const flatW = (1.0 - t / 0.165) * Math.min(1.0, (-ca - 0.14) / 0.65);
        y = centerY + ca * ry * (1.0 - 0.34 * flatW);
      }

      // Sculpted supraorbital brow ridge & recessed dark eye socket at t ~ 0.095, ca ~ 0.16
      if (t > 0.062 && t < 0.132 && absSa > 0.70 && ca > -0.06 && ca < 0.48) {
        const dtEye = (t - 0.095) / 0.027;
        const daEye = (ca - 0.15) / 0.21;
        const rEye2 = dtEye * dtEye + daEye * daEye;
        if (rEye2 < 1.35) {
          const brow = daEye > 0.18 ? Math.exp(-rEye2 * 2.2) * 0.032 : -Math.exp(-rEye2 * 3.0) * 0.028;
          x += Math.sign(sa) * brow;
        }
      }

      // Recessed nostril nares (nasal flaps) under rostrum at t ~ 0.048
      if (t > 0.038 && t < 0.060 && absSa > 0.34 && absSa < 0.70 && ca < -0.44) {
        const nEnv = Math.sin(((t - 0.038) / 0.022) * Math.PI) * Math.sin(((absSa - 0.34) / 0.36) * Math.PI);
        y += 0.022 * nEnv;
        gillW = Math.max(gillW, nEnv * 0.85);
      }

      // Broad hydrodynamic belly in chest/midsection
      if (ca < -0.10 && t > 0.14 && t < 0.72) {
        y = centerY + ca * ry * 0.84;
      }

      // Lateral line muscular myomere groove & epaxial/hypaxial muscle definition along flank
      if (t > 0.17 && t < 0.89 && absSa > 0.80 && Math.abs(ca - 0.08) < 0.32) {
        const latGroove = Math.exp(-Math.pow((ca - 0.08) / 0.075, 2.0)) * 0.015;
        const muscleBulge = Math.exp(-Math.pow((ca - 0.28) / 0.17, 2.0)) * 0.028;
        const lowerBulge = Math.exp(-Math.pow((ca + 0.12) / 0.16, 2.0)) * 0.014;
        x += Math.sign(sa) * (muscleBulge + lowerBulge - latGroove);
      }

      // Sharp horizontal lateral caudal keel ridge on peduncle (t in [0.75..0.97])
      if (t > 0.75 && t < 0.97 && absSa > 0.86 && Math.abs(ca) < 0.25) {
        const keelPinch = Math.pow(Math.max(0, 1.0 - Math.abs(ca) / 0.25), 2.2) * keelBulge * 0.92;
        x += Math.sign(sa) * keelPinch;
      }

      // Deep predatory parabolic mouth cavity & labial jaw folds (t in [0.062, 0.160])
      if (t > 0.060 && t < 0.160 && ca < -0.40) {
        const uMouth = (t - 0.060) / 0.100;
        const mw = Math.sin(uMouth * Math.PI) * Math.min(1.0, (-ca - 0.40) / 0.36);
        y += mw * 0.125;
        x *= 1.0 - mw * 0.10;
        mouthW = Math.min(1.0, mw * 1.35);
      }

      // Five sculpted 3D branchial gill slits & overlapping muscular gill arches (t in [0.195..0.305])
      if (t > 0.195 && t < 0.305 && absSa > 0.70 && ca > -0.46 && ca < 0.38) {
        // Gentle posterior sweep of each curved gill slit from top to bottom
        const tCurved = t - (ca + 0.04) * 0.008;
        const gillCoord = ((tCurved - 0.195) / 0.110) * 5.0;
        const gillIdx = Math.floor(gillCoord);
        const gillFrac = gillCoord - gillIdx;
        const vertEnv = Math.sin(Math.max(0, Math.min(1, (ca + 0.46) / 0.84)) * Math.PI);
        if (gillIdx >= 0 && gillIdx < 5 && vertEnv > 0.04) {
          if (gillFrac > 0.56 && gillFrac < 0.88) {
            const depth = Math.sin(((gillFrac - 0.56) / 0.32) * Math.PI) * vertEnv;
            x *= 1.0 - 0.088 * depth;
            gillW = Math.max(gillW, depth);
          } else if (gillFrac <= 0.56) {
            const bulge = Math.sin((gillFrac / 0.56) * Math.PI) * vertEnv;
            x *= 1.0 + 0.024 * bulge;
          }
        }
      }

      ring.push(pushV(x, y, z, t, sw, 0.0, gillW, mouthW, 0));
    }
    bodyRings.push(ring);
  }

  for (let i = 0; i < nLen; i++) {
    const r0 = bodyRings[i];
    const r1 = bodyRings[i + 1];
    for (let s = 0; s < nRad; s++) {
      const ns = (s + 1) % nRad;
      idx.push(r0[s], r0[ns], r1[ns], r0[s], r1[ns], r1[s]);
    }
  }

  // Cap snout tip & caudal peduncle cleanly
  const noseTip = pushV(0, 0.020, 3.34, 0.0, 0.0, 0, 0, 0, 0);
  const firstR = bodyRings[0];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(noseTip, firstR[ns], firstR[s]);
  }
  const tailCap = pushV(0, 0.0, -2.38, 1.0, 1.0, 0, 0, 0, 0);
  const lastR = bodyRings[bodyRings.length - 1];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(tailCap, lastR[s], lastR[ns]);
  }

  // ---- 1b. 36 Serrated Triangular Great White Enamel Teeth (Disconnected hardId = 2) ----
  const nTeeth = 18;
  for (let row = 0; row < 2; row++) {
    const isUpper = row === 0;
    for (let k = 0; k < nTeeth; k++) {
      const u = (k / (nTeeth - 1)) * 2.0 - 1.0;
      const arc = 1.0 - u * u;
      const tz = (isUpper ? 2.88 : 2.81) - (1.0 - arc) * 0.36;
      const tx = u * (isUpper ? 0.255 : 0.22);
      const ty = (isUpper ? -0.185 : -0.268) + (1.0 - arc) * 0.045;
      const tSpine = (3.28 - tz) / 5.60;
      const sw = 0.028 * (tSpine / 0.19);
      const wT = 0.0135 * (0.68 + 0.34 * arc);
      const hT = (isUpper ? -0.042 : 0.034) * (0.72 + 0.30 * arc);
      const toothStart = idx.length;
      const b0 = pushV(tx - wT, ty, tz + 0.004, tSpine, sw, 0, 0, 0, 2);
      const b1 = pushV(tx + wT, ty, tz + 0.004, tSpine, sw, 0, 0, 0, 2);
      const b2 = pushV(tx, ty, tz - wT * 0.95, tSpine, sw, 0, 0, 0, 2);
      const tip = pushV(tx, ty + hT, tz - 0.006, tSpine, sw, 0, 0, 0, 2);
      idx.push(b0, b1, tip, b1, b2, tip, b2, b0, tip, b0, b2, b1);
      ensureOutwardWinding(toothStart);
    }
  }

  // Helper to loft watertight, capped, auto-outward-wound swept NACA-0012 hydrofoil fins
  function addFin({
    rootFrontZ,
    rootBackZ,
    rootPos,
    tipOffset,
    sweepBack,
    chordTip,
    thickRoot,
    thickTip,
    mirrorX = false,
    steps = 20,
    segs = 22,
    tBase = 0.4,
    tTip = 0.45,
    curvePow = 0.88,
    hasNotch = false,
    dorsalWear = false,
    camberY = 0.0,
  }) {
    function buildSide(sign) {
      const startIdx = idx.length;
      const rings = [];
      let tipX = 0, tipY = 0, tipZ = 0, tipT = tTip, tipSw = 0;

      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const leadCurve = Math.pow(u, 1.15);
        const trailCurve = Math.pow(u, 0.80);
        let zFront = rootFrontZ * (1 - leadCurve) + (rootFrontZ - sweepBack) * leadCurve;
        let zBack = rootBackZ * (1 - trailCurve) + (rootFrontZ - sweepBack - chordTip) * trailCurve;

        // Subterminal notch near upper caudal fin tip
        if (hasNotch && u > 0.74 && u < 0.90) {
          const nw = Math.sin(((u - 0.74) / 0.16) * Math.PI);
          zBack += nw * 0.095;
        }
        // Authentic healed battle nick on 1st dorsal fin trailing edge
        if (dorsalWear && u > 0.44 && u < 0.56) {
          const nw = Math.sin(((u - 0.44) / 0.12) * Math.PI);
          zBack += nw * 0.048;
        }

        const chord = Math.max(0.025, zFront - zBack);
        const px = sign * (rootPos[0] + tipOffset[0] * Math.pow(u, 0.94));
        const py = rootPos[1] + tipOffset[1] * Math.pow(u, curvePow) + Math.sin(u * Math.PI) * camberY;

        // Organic anatomical root fillet flare so fin blends cleanly into shark torso
        const fillet = u < 0.24 ? Math.pow(1.0 - u / 0.24, 2.0) * 1.55 : 0.0;
        const tipTaper = u > 0.88 ? Math.cos(((u - 0.88) / 0.12) * Math.PI * 0.48) : 1.0;
        const thick = (thickRoot * (1 - u) + thickTip * u) * (1.0 + fillet) * tipTaper;
        const t = tBase + (tTip - tBase) * u;
        const sw = t < 0.19 ? 0.028 * (t / 0.19) : 0.028 + 0.972 * Math.pow((t - 0.19) / 0.81, 1.70);

        tipX = px; tipY = py; tipZ = 0.5 * (zFront + zBack); tipT = t; tipSw = sw;

        const ring = [];
        for (let j = 0; j < segs; j++) {
          const a = (j / segs) * Math.PI * 2;
          const uChord = Math.cos(a) * 0.5 + 0.5; // 0 = trailing edge, 1 = leading edge
          const naca =
            5.0 *
            (0.2969 * Math.sqrt(Math.max(1e-4, uChord)) -
              0.126 * uChord -
              0.3516 * uChord * uChord +
              0.2843 * Math.pow(uChord, 3) -
              0.1015 * Math.pow(uChord, 4));
          const sideSign = Math.sin(a) >= 0 ? 1 : -1;
          const foilOff = sideSign * naca * thick;

          const localZ = zBack + uChord * chord;
          const isVertical = Math.abs(tipOffset[1]) > Math.abs(tipOffset[0]);
          const vx = px + (isVertical ? foilOff : 0);
          const vy = py + (isVertical ? 0 : foilOff);
          // Smooth continuous thin-edge weight [0..1] for SSS & dusky fin margins (NEVER jumps to hardPartId!)
          const trailFade = Math.max(0.0, 1.0 - uChord / 0.34);
          const tipFade = Math.max(0.0, (u - 0.62) / 0.38);
          const finEdgeW = Math.min(1.0, Math.max(trailFade * 0.92, tipFade * 0.85));
          ring.push(pushV(vx, vy, localZ, t, sw, finEdgeW, 0.0, 0.0, 0));
        }
        rings.push(ring);
      }

      for (let i = 0; i < steps; i++) {
        const r0 = rings[i];
        const r1 = rings[i + 1];
        for (let j = 0; j < segs; j++) {
          const nj = (j + 1) % segs;
          idx.push(r0[j], r0[nj], r1[nj], r0[j], r1[nj], r1[j]);
        }
      }

      // Close fin tip cleanly so fin is 100% watertight manifold
      const tipCenter = pushV(tipX, tipY, tipZ, tipT, tipSw, 1.0, 0.0, 0.0, 0);
      const endR = rings[steps];
      for (let j = 0; j < segs; j++) {
        const nj = (j + 1) % segs;
        idx.push(tipCenter, endR[j], endR[nj]);
      }

      // Close root cap inside torso so signed volume check is exact
      const rootCenter = pushV(sign * rootPos[0], rootPos[1], 0.5 * (rootFrontZ + rootBackZ), tBase, 0.05, 0.0, 0.0, 0.0, 0);
      const startR = rings[0];
      for (let j = 0; j < segs; j++) {
        const nj = (j + 1) % segs;
        idx.push(rootCenter, startR[nj], startR[j]);
      }

      ensureOutwardWinding(startIdx);
    }

    buildSide(1);
    if (mirrorX) buildSide(-1);
  }

  // ---- 2. First Dorsal Fin (Iconic tall falcate apex blade with subtle healed battle nick) ----
  addFin({
    rootFrontZ: 1.24,
    rootBackZ: 0.12,
    rootPos: [0, 0.44],
    tipOffset: [0, 1.02],
    sweepBack: 0.96,
    chordTip: 0.16,
    thickRoot: 0.125,
    thickTip: 0.011,
    mirrorX: false,
    steps: 22,
    segs: 24,
    tBase: 0.39,
    tTip: 0.49,
    dorsalWear: true,
  });

  // ---- 3. Second Dorsal Fin & Anal Fin ----
  addFin({
    rootFrontZ: -0.96,
    rootBackZ: -1.38,
    rootPos: [0, 0.18],
    tipOffset: [0, 0.31],
    sweepBack: 0.36,
    chordTip: 0.075,
    thickRoot: 0.044,
    thickTip: 0.007,
    mirrorX: false,
    steps: 14,
    segs: 16,
    tBase: 0.78,
    tTip: 0.83,
  });

  addFin({
    rootFrontZ: -1.06,
    rootBackZ: -1.40,
    rootPos: [0, -0.15],
    tipOffset: [0, -0.26],
    sweepBack: 0.30,
    chordTip: 0.07,
    thickRoot: 0.040,
    thickTip: 0.007,
    mirrorX: false,
    steps: 14,
    segs: 16,
    tBase: 0.79,
    tTip: 0.84,
  });

  // ---- 4. Broad Swept Pectoral Hydrofoil Wings (Guaranteed Outward CCW Normals!) ----
  addFin({
    rootFrontZ: 1.62,
    rootBackZ: 0.74,
    rootPos: [0.34, -0.25],
    tipOffset: [1.48, -0.36],
    sweepBack: 1.22,
    chordTip: 0.13,
    thickRoot: 0.112,
    thickTip: 0.010,
    mirrorX: true,
    steps: 22,
    segs: 24,
    tBase: 0.31,
    tTip: 0.43,
    camberY: 0.045,
  });

  // ---- 5. Pelvic Stabilizer Fins ----
  addFin({
    rootFrontZ: 0.08,
    rootBackZ: -0.36,
    rootPos: [0.21, -0.26],
    tipOffset: [0.40, -0.22],
    sweepBack: 0.36,
    chordTip: 0.07,
    thickRoot: 0.044,
    thickTip: 0.008,
    mirrorX: true,
    steps: 14,
    segs: 16,
    tBase: 0.58,
    tTip: 0.64,
  });

  // ---- 6. Asymmetric Lunate Crescent Caudal Tail Fin ----
  addFin({
    rootFrontZ: -2.06,
    rootBackZ: -2.48,
    rootPos: [0, 0.03],
    tipOffset: [0, 1.22],
    sweepBack: 0.98,
    chordTip: 0.12,
    thickRoot: 0.086,
    thickTip: 0.008,
    mirrorX: false,
    steps: 22,
    segs: 22,
    tBase: 0.94,
    tTip: 1.07,
    hasNotch: true,
  });

  addFin({
    rootFrontZ: -2.08,
    rootBackZ: -2.46,
    rootPos: [0, -0.02],
    tipOffset: [0, -0.88],
    sweepBack: 0.72,
    chordTip: 0.10,
    thickRoot: 0.078,
    thickTip: 0.008,
    mirrorX: false,
    steps: 18,
    segs: 20,
    tBase: 0.94,
    tTip: 1.04,
  });

  // ---- 7. Multi-Ring Glossy Obsidian Eyes tucked inside Brow Sockets (Disconnected hardId = 1) ----
  const eyeGeo = new THREE.SphereGeometry(0.064, 18, 14);
  const eyePos = eyeGeo.getAttribute('position');
  const eyeIdx = eyeGeo.index;
  for (const side of [-1, 1]) {
    const baseV = pos.length / 3;
    const ex = side * 0.272;
    const ey = 0.072;
    const ez = 2.75;
    for (let i = 0; i < eyePos.count; i++) {
      pushV(
        ex + eyePos.getX(i) * 0.72,
        ey + eyePos.getY(i) * 0.96,
        ez + eyePos.getZ(i) * 1.08,
        0.095,
        0.014,
        0, 0, 0, 1
      );
    }
    for (let i = 0; i < eyeIdx.count; i += 3) {
      idx.push(baseV + eyeIdx.getX(i), baseV + eyeIdx.getX(i + 1), baseV + eyeIdx.getX(i + 2));
    }
  }
  eyeGeo.dispose();

  // ---- 8. Two Symbiotic Remora Suckerfish Escorts swimming below Shark Pectoral & Flank (hardId = 3) ----
  const remoraSpecs = [
    { ox: 0.56, oy: -0.46, oz: 0.62, scale: 0.58 },
    { ox: -0.48, oy: -0.42, oz: -0.18, scale: 0.46 },
  ];
  for (const rm of remoraSpecs) {
    const rStart = idx.length;
    const rLen = 14;
    const rRad = 10;
    const rRings = [];
    for (let i = 0; i <= rLen; i++) {
      const u = i / rLen; // 0 = head (+z), 1 = tail (-z)
      const rz = rm.oz + (0.55 - u * 1.15) * rm.scale;
      const rad = Math.sin(Math.pow(u, 0.72) * Math.PI) * 0.085 * rm.scale + 0.008 * rm.scale;
      const tS = Math.max(0.05, Math.min(0.95, (3.28 - rz) / 5.60));
      const sw = 0.028 + 0.972 * Math.pow(Math.max(0, (tS - 0.19) / 0.81), 1.70);
      const ring = [];
      for (let j = 0; j < rRad; j++) {
        const a = (j / rRad) * Math.PI * 2;
        ring.push(pushV(
          rm.ox + Math.sin(a) * rad * 0.85,
          rm.oy + Math.cos(a) * rad * 0.68,
          rz,
          tS, sw, 0, 0, 0, 3
        ));
      }
      rRings.push(ring);
    }
    for (let i = 0; i < rLen; i++) {
      for (let j = 0; j < rRad; j++) {
        const nj = (j + 1) % rRad;
        idx.push(rRings[i][j], rRings[i][nj], rRings[i + 1][nj], rRings[i][j], rRings[i + 1][nj], rRings[i + 1][j]);
      }
    }
    // Remora forked tail fin
    const tz0 = rm.oz - 0.58 * rm.scale;
    const tz1 = rm.oz - 0.82 * rm.scale;
    const tTail = Math.max(0.1, Math.min(0.95, (3.28 - tz1) / 5.60));
    const swT = 0.028 + 0.972 * Math.pow(Math.max(0, (tTail - 0.19) / 0.81), 1.70);
    const tc = pushV(rm.ox, rm.oy, tz0, tTail, swT, 0, 0, 0, 3);
    const tt = pushV(rm.ox, rm.oy + 0.11 * rm.scale, tz1, tTail, swT, 0, 0, 0, 3);
    const tb = pushV(rm.ox, rm.oy - 0.10 * rm.scale, tz1, tTail, swT, 0, 0, 0, 3);
    const tn = pushV(rm.ox, rm.oy, tz0 - 0.14 * rm.scale, tTail, swT, 0, 0, 0, 3);
    idx.push(tc, tt, tn, tc, tn, tb, tc, tn, tt, tc, tb, tn);
    ensureOutwardWinding(rStart);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSpineCoord', new THREE.Float32BufferAttribute(spineCoord, 2));
  geo.setAttribute('aMatWeights', new THREE.Float32BufferAttribute(matWeights, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================================
// GTA-6-Grade Apex Shark Materials & Kinematics
// Arc-Length Carangiform Wave + Breathing Gill Flare & Jaw Gape + Curious Look-At +
// Mikkelsen Surface-Gradient Bump (Dermal Denticles + Pixel-Sharp 5 Gill Slits +
// Dynamic Myomere Muscle Ripples + Dual-Lobe Wet GGX + Chromatic Caustics + SSS)
// ============================================================================
const SHARK_WAVE_GLSL = `
  vec3 sharkDeform(vec3 p, vec2 sc, float phase, vec2 look) {
    float t = sc.x;
    float w = sc.y;
    // Secondary hydrodynamic phase lag on outer fin tips
    float tipLag = max(0.0, abs(p.y) - 0.35) * 0.52 + max(0.0, abs(p.x) - 0.45) * 0.34;
    float kPhase = phase - t * 6.4 - tipLag;
    float wave = sin(kPhase);
    float dWaveDt = -6.4 * cos(kPhase);

    // Subtle counter-yaw of head/rostrum balancing tail thrust
    float headCounter = (1.0 - smoothstep(0.0, 0.25, t)) * sin(phase + 0.4) * 0.032;
    float latOffset = wave * 0.44 * w + headCounter;

    // Arc-length-preserving spinal tangent rotation in XZ plane
    float yawAng = clamp(dWaveDt * 0.072 * w, -0.50, 0.50);
    float cy = cos(yawAng);
    float sy = sin(yawAng);
    float rx = p.x * cy + p.z * sy * 0.08;
    p.x = rx + latOffset;

    // Rhythmic branchial gill-arch pumping & subtle lower-jaw breathing gape
    float breath = 0.5 + 0.5 * sin(phase * 0.58);
    float gillBreath = exp(-pow((t - 0.25) / 0.048, 2.0)) * breath * 0.028;
    p.x += sign(p.x) * gillBreath * step(0.14, abs(p.x));
    if (t > 0.065 && t < 0.16 && p.y < -0.17) {
      float jawEnv = sin(clamp((t - 0.065) / 0.095, 0.0, 1.0) * 3.14159);
      p.y -= jawEnv * (0.012 + 0.022 * breath);
    }

    // Curious diver-aware subtle head glance (anterior head t < 0.28)
    float headFlex = smoothstep(0.28, 0.02, t);
    float headArm = headFlex * headFlex;
    p.x += look.x * headArm * 0.42;
    p.y += look.y * headArm * 0.26;

    // Slight torsional body roll & vertical heave on strong tail beat
    p.y += sin(phase * 2.0 - t * 6.4) * 0.020 * w + p.x * wave * 0.055 * w;
    return p;
  }
`;

function createSharkMaterial(sharedUniforms, sharkUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    attribute vec4 aMatWeights;

    uniform vec2 uSharkLook;

    ${MEDIUM_GLSL}
    ${SHARK_WAVE_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vLPos;
    out vec3 vLNorm;
    out vec2 vSpine;
    out vec4 vMatW;

    void main() {
      vec3 lp = sharkDeform(position, aSpineCoord, uSwimPhase, uSharkLook);
      // Finite-difference Jacobian normal rotation along spine
      float t0 = max(0.0, aSpineCoord.x - 0.012);
      float t1 = min(1.08, aSpineCoord.x + 0.012);
      vec3 d0 = sharkDeform(position, vec2(t0, aSpineCoord.y), uSwimPhase, uSharkLook);
      vec3 d1 = sharkDeform(position, vec2(t1, aSpineCoord.y), uSwimPhase, uSharkLook);
      float slopeX = (d1.x - d0.x) * 3.6;
      float slopeY = (d1.y - d0.y) * 2.2;
      vec3 ln = normalize(vec3(
        normal.x - normal.z * slopeX,
        normal.y - normal.z * slopeY,
        normal.z + normal.x * slopeX + normal.y * slopeY
      ));

      vec4 wp = modelMatrix * vec4(lp, 1.0);
      vec3 wn = normalize(mat3(modelMatrix) * ln);

      vWPos = wp.xyz;
      vWNorm = wn;
      vLPos = position;
      vLNorm = normal;
      vSpine = aSpineCoord;
      vMatW = aMatWeights;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}
    ${SURFACE_GRADIENT_BUMP_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vLPos;
    in vec3 vLNorm;
    in vec2 vSpine;
    in vec4 vMatW;

    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 gn = normalize(vWNorm);
      float finEdgeW = vMatW.x;
      float gillVertW = vMatW.y;
      float mouthW = vMatW.z;
      float hardId = vMatW.w;

      // Disconnected sub-mesh masks (zero interpolation bleed onto skin!)
      float eyeMask = step(0.5, hardId) * step(hardId, 1.5);
      float toothMask = step(1.5, hardId) * step(hardId, 2.5);
      float remoraMask = step(2.5, hardId);
      float skinOnly = 1.0 - clamp(eyeMask + toothMask + remoraMask, 0.0, 1.0);

      // Multi-scale triplanar organic dermis + diamond dermal denticle (placoid scale) micro-texture
      TP tpMacro = tri(vLPos * vec3(2.2, 2.2, 1.3), gn);
      TP tpMed = tri(vLPos * vec3(8.5, 8.5, 5.0), gn);
      TP tpDent = tri(vLPos * vec3(24.0, 24.0, 14.0), gn);

      // Anisotropic diamond placoid micro-scales aligned with hydrodynamic flow
      float dentDiamond = sin(vLPos.z * 138.0 + vLPos.y * 62.0) * cos(vLPos.z * 138.0 - vLPos.y * 62.0);
      float dentHeight = dentDiamond * 0.25 + (tpDent.h - 0.5) * 0.55 + (tpMed.h - 0.5) * 0.45;

      // Dynamic myomere muscle flex bands rippling along the flanks with the swimming S-wave
      float flexWave = sin(uSwimPhase - vSpine.x * 6.4);
      float flankEnv = smoothstep(0.24, 0.42, vSpine.x) * (1.0 - smoothstep(0.78, 0.93, vSpine.x))
        * smoothstep(0.35, 0.82, abs(vLNorm.x)) * (1.0 - finEdgeW);
      float myomere = sin(vLPos.z * 22.0 + abs(vLPos.y) * 9.0) * (0.35 + 0.65 * abs(flexWave)) * flankEnv;

      // Sub-pixel crisp 5-Slit Branchial Gill Clefts (matches sculpted geometry + razor-sharp FS SDF)
      float gillSlitSDF = 0.0;
      float gillArchBump = 0.0;
      if (skinOnly > 0.5 && vSpine.x > 0.188 && vSpine.x < 0.312 && abs(vLNorm.x) > 0.48 && vLPos.y > -0.34 && vLPos.y < 0.28) {
        float yNorm = (vLPos.y + 0.03) / 0.30;
        float vEnv = clamp(1.0 - yNorm * yNorm, 0.0, 1.0);
        float tCurve = vSpine.x - yNorm * 0.0085;
        float gCoord = ((tCurve - 0.195) / 0.110) * 5.0;
        if (gCoord >= 0.0 && gCoord < 5.0) {
          float gFrac = fract(gCoord);
          float breathFlare = 0.045 + 0.025 * (0.5 + 0.5 * sin(uSwimPhase * 0.58));
          // Deep recessed dark slit at gFrac ~ 0.72, fleshy overlapping gill flap ahead of it
          gillSlitSDF = exp(-pow((gFrac - 0.72) / breathFlare, 2.0)) * smoothstep(0.05, 0.28, vEnv);
          gillArchBump = sin(clamp(gFrac / 0.62, 0.0, 1.0) * 3.14159) * smoothstep(0.05, 0.35, vEnv) - gillSlitSDF * 2.2;
        }
      }
      float gillCleft = clamp(max(gillSlitSDF, gillVertW * 0.65), 0.0, 1.0) * skinOnly;

      // Healed predatory hunt & reef scrape scars across snout, brow, and dorsal shoulder
      float scar1 = exp(-pow((vLPos.y - 0.21 - (vLPos.z - 1.15) * 0.34) / 0.011, 2.0))
        * smoothstep(0.55, 1.35, vLPos.z) * (1.0 - smoothstep(1.55, 2.15, vLPos.z));
      float scar2 = exp(-pow((vLPos.y - 0.13 + (vLPos.z - 1.55) * 0.44) / 0.009, 2.0))
        * smoothstep(0.95, 1.75, vLPos.z) * (1.0 - smoothstep(1.95, 2.55, vLPos.z));
      float scar3 = exp(-pow((vLPos.y - 0.32 - (vLPos.z - 0.35) * 0.26) / 0.013, 2.0))
        * smoothstep(-0.2, 0.4, vLPos.z) * (1.0 - smoothstep(0.55, 0.95, vLPos.z));
      float scarMask = clamp((scar1 + scar2 + scar3) * smoothstep(0.32, 0.75, tpMed.h), 0.0, 1.0) * skinOnly;

      // Combine analytic surface-gradient micro-relief heightfield
      float reliefH = (dentHeight * 0.22 + myomere * 0.32 + gillArchBump * 0.75 - scarMask * 0.45) * skinOnly;
      vec3 N = perturbNormalBump(vWPos, gn, reliefH, 0.018);
      N = normalize(N + (tpMacro.n * 0.14 + tpDent.n * 0.08) * skinOnly);

      // ---- Rich Photorealistic Great White / Pelagic Shark Countershading ----
      vec3 dorsalDeep = vec3(0.058, 0.088, 0.122);  // Deep gunmetal pelagic slate-indigo
      vec3 dorsalBronze = vec3(0.115, 0.118, 0.112); // Subtle warm metallic bronze undertone
      vec3 flankCol = mix(vec3(0.145, 0.188, 0.225), dorsalBronze, 0.42);
      vec3 bellyCol = vec3(0.68, 0.70, 0.69);        // Natural warm porcelain-ivory ventral belly

      // Organic dappled irregular countershading border along lower flank & jaw
      float jagged = (tpMacro.h - 0.5) * 0.13 + (tpMed.c - 0.5) * 0.065 + sin(vLPos.z * 3.4) * 0.04;
      float flankLine = vLPos.y + jagged;
      float bellyToFlank = smoothstep(-0.15, 0.03, flankLine);
      float flankToDorsal = smoothstep(0.04, 0.38, flankLine);
      // Characteristic darker smudge/shadow band right along countershading seam
      float borderShade = exp(-pow((flankLine - 0.02) / 0.055, 2.0)) * 0.18;
      vec3 skinCol = mix(bellyCol, mix(flankCol, dorsalDeep, flankToDorsal), bellyToFlank);
      skinCol *= (1.0 - borderShade);

      // Subtle dappled pelagic dorsal mottling & faint lateral line canal
      float mottle = smoothstep(0.28, 0.78, tpMacro.c * 0.62 + tpMed.c * 0.38);
      skinCol *= mix(0.86, 1.12, mottle * flankToDorsal + (1.0 - flankToDorsal) * 0.5);
      float latLine = exp(-pow((vLPos.y - 0.07 - sin(vLPos.z * 0.8) * 0.03) / 0.012, 2.0)) * flankEnv;
      skinCol *= (1.0 - latLine * 0.16);

      // True Pelagic / Great White Fin Pigmentation:
      // 1) Pectoral & Pelvic Fins: Deep gunmetal dorsal upper face (vLNorm.y > 0), pale porcelain underside with dark tip blotch!
      float isLateralFin = smoothstep(0.36, 0.58, abs(vLPos.x)) * (1.0 - smoothstep(0.76, 0.88, vSpine.x)) * skinOnly;
      float pecTopMask = isLateralFin * smoothstep(-0.12, 0.14, vLNorm.y);
      float pecBotMask = isLateralFin * smoothstep(0.08, -0.18, vLNorm.y);
      vec3 pecDorsalCol = mix(flankCol, dorsalDeep, 0.65) * mix(0.90, 1.08, mottle);
      skinCol = mix(skinCol, pecDorsalCol, pecTopMask);
      // Classic Great White underside: pale belly white transitioning to charcoal-black ventral wingtip
      float pecTipDark = smoothstep(1.08, 1.58, abs(vLPos.x));
      vec3 pecVentralCol = mix(vec3(0.60, 0.63, 0.63), vec3(0.032, 0.042, 0.055), pecTipDark * 0.92);
      skinCol = mix(skinCol, pecVentralCol, pecBotMask);

      // 2) Caudal Tail Fin (BOTH upper & lower lunate lobes + anal fin): Gunmetal slate-grey, never stark white!
      float isTailFin = smoothstep(0.84, 0.92, vSpine.x) * skinOnly;
      float tailSpan = smoothstep(0.18, 0.92, abs(vLPos.y));
      vec3 tailCol = mix(flankCol, dorsalDeep, 0.52 + 0.32 * tailSpan) * mix(0.88, 1.10, mottle);
      skinCol = mix(skinCol, tailCol, isTailFin);

      // 3) Authentic dusky charcoal-black fin tips & thin trailing margins across all fins
      float finDist = smoothstep(0.92, 1.68, abs(vLPos.x)) + smoothstep(0.68, 1.36, abs(vLPos.y));
      float darkFinMask = clamp(finEdgeW * 0.48 + finDist * 0.36, 0.0, 0.80) * skinOnly;
      skinCol = mix(skinCol, vec3(0.028, 0.036, 0.046), darkFinMask);

      // Healed pale silver-grey hunting scars
      skinCol = mix(skinCol, vec3(0.44, 0.48, 0.51), scarMask * 0.62);

      // Ampullae of Lorenzini dark electroreceptor sensory pores across snout underside
      if (skinOnly > 0.5 && vLPos.z > 2.35 && vLPos.y < 0.08) {
        float poreGrid = smoothstep(0.74, 0.85, tpDent.c);
        float snoutEnv = smoothstep(2.35, 2.75, vLPos.z) * smoothstep(0.08, -0.08, vLPos.y);
        skinCol = mix(skinCol, vec3(0.11, 0.13, 0.15), poreGrid * snoutEnv * 0.70);
      }

      // Deep dark crimson-burgundy branchial gill cleft interior & AO around overlapping gill rims
      vec3 gillInterior = vec3(0.065, 0.018, 0.024);
      skinCol = mix(skinCol, gillInterior, gillCleft * 0.94);

      // Oral cavity & fleshy crimson-pink gingiva inside parabolic jaws
      float gumMask = smoothstep(0.25, 0.85, mouthW) * skinOnly;
      skinCol = mix(skinCol, vec3(0.32, 0.075, 0.095), gumMask * 0.92);

      // Default dermal roughness & wet coat strength
      float roughness = mix(0.32, 0.22, bellyToFlank);
      float specStr = 0.48;
      specStr *= (1.0 - gillCleft * 0.85) * (1.0 - gumMask * 0.4);

      // Symbiotic Remora Suckerfish coloration (dark slate-brown with pale silver lateral stripe)
      if (remoraMask > 0.5) {
        float rStripe = smoothstep(0.015, 0.045, abs(vLNorm.y));
        skinCol = mix(vec3(0.38, 0.42, 0.45), vec3(0.09, 0.11, 0.13), rStripe);
        roughness = 0.26;
        specStr = 0.55;
      }

      // Razor-sharp serrated white enamel Great White teeth (disconnected hardId = 2)
      if (toothMask > 0.5) {
        skinCol = mix(vec3(0.76, 0.72, 0.65), vec3(0.92, 0.90, 0.85), smoothstep(-0.24, -0.19, vLPos.y));
        roughness = 0.10;
        specStr = 1.05;
      }

      // Glossy Obsidian Apex Shark Eye with subtle steel-blue/amber iris ring & wet cornea catchlight (hardId = 1)
      if (eyeMask > 0.5) {
        vec2 eyeRel = vec2((vLPos.z - 2.75) / 0.064, (vLPos.y - 0.072) / 0.060);
        float eyeR = length(eyeRel);
        float pupil = 1.0 - smoothstep(0.42, 0.58, eyeR);
        float iris = (1.0 - pupil) * (1.0 - smoothstep(0.78, 0.95, eyeR));
        vec3 irisCol = vec3(0.14, 0.18, 0.20) * (0.75 + 0.5 * tpDent.h);
        skinCol = mix(vec3(0.015, 0.020, 0.025), irisCol, iris);
        skinCol = mix(skinCol, vec3(0.004, 0.005, 0.008), pupil);
        roughness = 0.04;
        specStr = 1.65;
      }

      // Subtle micro-cavity AO inside gill arches, eye brow socket, and oral recess
      float browAO = 1.0 - 0.28 * exp(-pow((vLPos.z - 2.75) / 0.13, 2.0) - pow((vLPos.y - 0.07) / 0.11, 2.0)) * skinOnly;
      skinCol *= browAO * (1.0 - 0.24 * gillCleft);

      // ---- Dual-Lobe Underwater PBR Lighting + Chromatic Caustics + Backlit Fin SSS ----
      vec3 V = normalize(uCamPos - vWPos);
      vec3 L = uSunDir;
      vec3 H = normalize(V + L);
      float ndl = max(dot(N, L), 0.0);
      float ndv = max(dot(N, V), 0.02);
      float ndh = max(dot(N, H), 0.0);

      float sh = shadow9(vWPos);
      vec3 caRaw = causRGB(vWPos);
      vec3 ca = caRaw / (1.0 + caRaw * 0.42);
      vec3 sunIrr = sunE(vWPos);

      // 1. Wrap Diffuse + Sharp Chromatic Underwater Caustics
      float wrapDiff = max(0.0, (dot(N, L) + 0.16) / 1.16);
      vec3 direct = sunIrr * wrapDiff * sh * (0.56 + 1.38 * ca);

      // 2. Warm Sandy-Reef Upward Bounce Light illuminating the White Belly
      vec3 bellyBounce = vec3(0.24, 0.28, 0.26) * max(-N.y, 0.0) * (1.25 - bellyToFlank * 0.58);
      vec3 ambient = amb(vWPos, N) + sideLight(vWPos, N) + bellyBounce;

      // 3. Dual-Lobe GGX: Satin Metallic Dermal Denticles + Mirror-Wet Seawater Clearcoat
      float alphaSq = pow(roughness, 4.0);
      float denom = ndh * ndh * (alphaSq - 1.0) + 1.0;
      float D_ggx = alphaSq / max(3.14159 * denom * denom, 1e-4);
      float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
      float wetSpec = D_ggx * fresnel * specStr * sh;
      // Tight clearcoat film glint + velvet anisotropic denticle rim sheen
      float coatGlint = pow(ndh, 96.0) * 0.34 * sh * (1.0 - gillCleft);
      float denticleSheen = pow(1.0 - ndv, 3.2) * (0.30 + 0.70 * ndl) * 0.22 * (1.0 - eyeMask) * (1.0 - gillCleft);

      // 4. Translucent Thin Fin-Edge Subsurface Scattering (SSS) when Backlit
      float finThin = clamp(finEdgeW * 0.90 + finDist * 0.35, 0.0, 1.0) * skinOnly;
      float backLight = pow(clamp(dot(-V, L + N * 0.42), 0.0, 1.0), 2.6);
      vec3 sssCol = vec3(0.30, 0.54, 0.50) * sunIrr * backLight * finThin * (0.45 + 0.55 * sh) * 0.58;

      vec3 lit = skinCol * (direct + ambient)
        + sunIrr * (0.38 + ca * 1.05) * (wetSpec + coatGlint)
        + mix(WCOL, sunIrr, 0.52) * denticleSheen
        + sssCol;
      fragColor = vec4(fog(lit, vWPos), 1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sharedUniforms, ...sharkUniforms },
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
  });
  bindSharedUniforms(mat, sharedUniforms);
  mat.uniforms.uSharkLook = sharkUniforms.uSharkLook;
  return mat;
}

function createSharkShadowMaterial(sharedUniforms, sharkUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    uniform float uSwimPhase;
    uniform vec2 uSharkLook;
    ${SHARK_WAVE_GLSL}

    void main() {
      vec3 lp = sharkDeform(position, aSpineCoord, uSwimPhase, uSharkLook);
      vec4 wp = modelMatrix * vec4(lp, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    layout(location = 0) out vec4 fragColor;
    void main() {
      fragColor = vec4(1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sharedUniforms, ...sharkUniforms },
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 1.5,
  });
  bindSharedUniforms(mat, sharedUniforms);
  mat.uniforms.uSharkLook = sharkUniforms.uSharkLook;
  return mat;
}

// ============================================================================
// Zero-Allocation Shark Spline Patrol Controller (with Curious Diver Look-At)
// ============================================================================
export class SharkController {
  constructor(sharkMesh, sharkShadowMesh, sharkUniforms, terrain, sharedUniforms) {
    this.mesh = sharkMesh;
    this.shadowMesh = sharkShadowMesh;
    this.sharkUniforms = sharkUniforms;
    this.terrain = terrain;
    this.sharedUniforms = sharedUniforms;

    // Closed Catmull-Rom reef patrol loop cruising through arches and open basin
    this.curve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(1, -24.5, 16), // Central canyon view
        new THREE.Vector3(1.5, -24.0, -14), // Glides right under Cathedral Arch!
        new THREE.Vector3(-14, -22.5, -30), // Northern kelp rim
        new THREE.Vector3(-36, -27.5, -15), // Swoops above Sunken Shipwreck
        new THREE.Vector3(-29, -26.5, 16), // Through Western Swim Arch
        new THREE.Vector3(-6, -29.0, 32), // Grazing near Purple Grotto
        new THREE.Vector3(31, -27.5, 22), // Circles Whale Fluke Monument
        new THREE.Vector3(30, -23.5, -2), // Passing Eastern Gate
      ],
      true,
      'centripetal',
      0.5
    );

    this.u = 0.028;
    this.speed = 0.018; // ~55s serene full circuit
    this.pos = new THREE.Vector3(1.3, -24.1, 4.5);
    this.nextPos = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.prevFwd = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.worldUp = new THREE.Vector3(0, 1, 0);
    this.rotMat = new THREE.Matrix4();
    this.colGrad = new THREE.Vector3();
    this.bankSmooth = 0;

    this.mesh.scale.setScalar(1.38);
    this.shadowMesh.scale.setScalar(1.38);
    this.mesh.position.copy(this.pos);
    this.shadowMesh.position.copy(this.pos);
    this.update(0.016);
  }

  update(dt, camPos = null) {
    const safeDt = Math.min(dt, 0.05);
    this.u = (this.u + safeDt * this.speed) % 1.0;
    const lookAhead = (this.u + 0.008) % 1.0;

    this.curve.getPointAt(this.u, this.pos);
    this.curve.getPointAt(lookAhead, this.nextPos);

    // Subtle terrain clearance safeguard
    const clearance = this.terrain.dw(this.pos.x, this.pos.y, this.pos.z);
    if (clearance > -2.4) {
      this.terrain.grad(this.pos.x, this.pos.y, this.pos.z, this.colGrad);
      this.pos.addScaledVector(this.colGrad, clearance + 2.4);
    }

    this.prevFwd.copy(this.fwd);
    this.fwd.subVectors(this.nextPos, this.pos);
    const len = this.fwd.length();
    if (len > 1e-4) this.fwd.divideScalar(len);

    // Natural centrifugal roll banking into turns
    this.right.crossVectors(this.worldUp, this.fwd).normalize();
    const turnRate = (this.fwd.x * this.prevFwd.z - this.fwd.z * this.prevFwd.x) / Math.max(safeDt, 0.005);
    const targetBank = Math.max(-0.42, Math.min(0.42, turnRate * 1.15));
    this.bankSmooth += (targetBank - this.bankSmooth) * Math.min(1, safeDt * 4.0);

    // Construct +Z forward orientation basis (since snout is along +Z)
    this.right.crossVectors(this.worldUp, this.fwd).normalize();
    this.up.crossVectors(this.fwd, this.right).normalize();

    // Apply roll around forward axis cleanly without allocating
    const c = Math.cos(this.bankSmooth);
    const s = Math.sin(this.bankSmooth);
    const rx = this.right.x * c + this.up.x * s;
    const ry = this.right.y * c + this.up.y * s;
    const rz = this.right.z * c + this.up.z * s;
    const ux = this.up.x * c - this.right.x * s;
    const uy = this.up.y * c - this.right.y * s;
    const uz = this.up.z * c - this.right.z * s;
    this.right.set(rx, ry, rz);
    this.up.set(ux, uy, uz);

    this.rotMat.makeBasis(this.right, this.up, this.fwd);
    this.mesh.quaternion.setFromRotationMatrix(this.rotMat);
    this.mesh.position.copy(this.pos);

    this.shadowMesh.quaternion.copy(this.mesh.quaternion);
    this.shadowMesh.position.copy(this.pos);

    // Curious diver-aware subtle head glance when gliding within 22m
    let lookX = 0.0;
    let lookY = 0.0;
    if (camPos) {
      const dx = camPos.x - this.pos.x;
      const dy = camPos.y - this.pos.y;
      const dz = camPos.z - this.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1.2 && dist < 22.0) {
        const invD = 1.0 / dist;
        const nx = dx * invD, ny = dy * invD, nz = dz * invD;
        const fwdDot = nx * this.fwd.x + ny * this.fwd.y + nz * this.fwd.z;
        if (fwdDot > -0.3) {
          const prox = Math.max(0.0, Math.min(1.0, (22.0 - dist) / 14.0));
          const rightDot = nx * this.right.x + ny * this.right.y + nz * this.right.z;
          const upDot = nx * this.up.x + ny * this.up.y + nz * this.up.z;
          lookX = Math.max(-0.24, Math.min(0.24, rightDot * 0.34)) * prox;
          lookY = Math.max(-0.15, Math.min(0.15, upDot * 0.22)) * prox;
        }
      }
    }
    const lookAlpha = 1.0 - Math.exp(-safeDt * 3.0);
    this.sharkUniforms.uSharkLook.value.x += (lookX - this.sharkUniforms.uSharkLook.value.x) * lookAlpha;
    this.sharkUniforms.uSharkLook.value.y += (lookY - this.sharkUniforms.uSharkLook.value.y) * lookAlpha;

    // Sync carangiform tail beat speed to swimming effort
    this.sharedUniforms.uSwimPhase.value += safeDt * (4.6 + Math.abs(this.bankSmooth) * 2.2);
  }
}

// ============================================================================
// Gliding Manta Rays + 3,000 Schooling Reef Fish (GLSL3 Instanced)
// ============================================================================
function buildMantaGeometry() {
  const pos = [];
  const norm = [];
  const uv = [];
  const idx = [];

  // Grid loft across wingspan x in [-1..1] (wingspan ~ 4.4m) and chord z in [-0.7..1.0]
  const nx = 24;
  const nz = 12;

  for (let side of [-1, 1]) {
    // Upper and lower wing surfaces stitched at edges
    for (let ix = 0; ix <= nx; ix++) {
      const u = ix / nx; // 0 = left wingtip, 0.5 = body centerline, 1 = right wingtip
      const ax = Math.abs(u - 0.5) * 2.0; // 0 center -> 1 tip
      const wx = (u - 0.5) * 4.6;
      // Triangular swept wingtip envelope
      const zFront = 0.72 * (1.0 - Math.pow(ax, 1.15)) + 0.12 - ax * 0.42;
      const zBack = -0.68 * (1.0 - ax * 0.92) - ax * 0.35;
      const thick = (0.14 * Math.pow(1.0 - ax, 1.6)) + 0.008;

      for (let iz = 0; iz <= nz; iz++) {
        const v = iz / nz; // 0 = trailing, 1 = leading
        const wz = zBack + (zFront - zBack) * v;
        const prof = Math.sin(v * Math.PI);
        const wy = side * thick * prof + (ax < 0.16 ? side * 0.04 * prof : 0);
        // Subtle cephalic lobes protruding beside mouth
        const zHorn = (ax > 0.09 && ax < 0.22 && v > 0.85) ? 0.24 : 0;

        pos.push(wx, wy, wz + zHorn);
        norm.push(0, side, 0);
        uv.push(u, v);
      }
    }
  }

  const ringV = nz + 1;
  const sideStride = (nx + 1) * ringV;
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      // Bottom surface (-1)
      const a0 = ix * ringV + iz;
      const b0 = (ix + 1) * ringV + iz;
      const c0 = (ix + 1) * ringV + (iz + 1);
      const d0 = ix * ringV + (iz + 1);
      idx.push(a0, c0, b0, a0, d0, c0);

      // Top surface (+1)
      const a1 = sideStride + a0;
      const b1 = sideStride + b0;
      const c1 = sideStride + c0;
      const d1 = sideStride + d0;
      idx.push(a1, b1, c1, a1, c1, d1);
    }
  }

  // Slender trailing whip tail extending back along -Z
  const tailBase = pos.length / 3;
  const tailSegs = 8;
  const tailSides = 6;
  for (let i = 0; i <= tailSegs; i++) {
    const t = i / tailSegs;
    const z = -0.58 - t * 2.1;
    const r = 0.036 * (1.0 - t * 0.88);
    for (let s = 0; s < tailSides; s++) {
      const a = (s / tailSides) * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
      norm.push(Math.cos(a), Math.sin(a), 0);
      uv.push(0.5, 0.0);
    }
  }
  for (let i = 0; i < tailSegs; i++) {
    for (let s = 0; s < tailSides; s++) {
      const ns = (s + 1) % tailSides;
      const a = tailBase + i * tailSides + s;
      const b = tailBase + i * tailSides + ns;
      const c = tailBase + (i + 1) * tailSides + ns;
      const d = tailBase + (i + 1) * tailSides + s;
      idx.push(a, c, b, a, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================================
// GTA-6-Grade Anatomical Tropical Reef Fish Geometry (Instanced 4,240+ Fish)
// Smooth 12x12 Fusiform Body + Gill Operculum Contour + Swept Dorsal Fin +
// Paired Flared Pectoral Wings + Anal/Pelvic Fins + Forked Crescent Caudal Tail +
// Disconnected 3D Glossy Eyes (aFishPart: 0=body, 1=fins, 2=tail, 3=eye)
// ============================================================================
function buildFishGeometry() {
  const p = [];
  const fPart = []; // 0=body scales, 1=translucent fins, 2=forked caudal tail, 3=disconnected glossy eye
  const idx = [];

  function v(x, y, z, part = 0) {
    p.push(x, y, z);
    fPart.push(part);
    return p.length / 3 - 1;
  }
  function tri(a, b, c) {
    idx.push(a, b, c);
  }
  function quad(a, b, c, d) {
    idx.push(a, b, c, a, c, d);
  }

  // 1. High-Res Sculpted Fusiform Body (+X nose = +0.52 -> -X peduncle = -0.36)
  const X = [0.52, 0.44, 0.34, 0.22, 0.10, -0.02, -0.14, -0.24, -0.32, -0.37];
  const H = [0.008, 0.088, 0.145, 0.178, 0.184, 0.168, 0.132, 0.086, 0.048, 0.032];
  const W = [0.008, 0.038, 0.062, 0.072, 0.070, 0.060, 0.044, 0.028, 0.016, 0.011];
  const nSeg = 12;
  const rings = [];

  for (let i = 0; i < X.length; i++) {
    const r = [];
    // Slight gill operculum flare around i=2..3
    const gillFlare = i === 2 ? 1.07 : i === 3 ? 1.03 : 1.0;
    for (let k = 0; k < nSeg; k++) {
      const a = (k / nSeg) * Math.PI * 2;
      const sy = Math.sin(a);
      const cz = Math.cos(a);
      // Slightly fuller dorsal profile than ventral belly
      const yOff = sy > 0 ? sy * H[i] * 1.04 : sy * H[i] * 0.94;
      const zOff = cz * W[i] * gillFlare * (1.0 - 0.12 * Math.abs(sy));
      r.push(v(X[i], yOff, zOff, 0));
    }
    rings.push(r);
  }
  for (let i = 0; i < X.length - 1; i++) {
    for (let k = 0; k < nSeg; k++) {
      const k2 = (k + 1) % nSeg;
      quad(rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]);
    }
  }
  // Cap nose tip & peduncle cleanly
  const noseV = v(0.54, 0.0, 0.0, 0);
  for (let k = 0; k < nSeg; k++) {
    const k2 = (k + 1) % nSeg;
    tri(noseV, rings[0][k], rings[0][k2]);
  }

  // 2. Continuous Swept Dorsal Fin along Upper Ridge (part = 1)
  const dRoots = [
    [0.24, 0.174], [0.10, 0.184], [-0.04, 0.162], [-0.18, 0.114], [-0.28, 0.064],
  ];
  const dTips = [
    [0.14, 0.275], [-0.02, 0.295], [-0.16, 0.255], [-0.28, 0.195], [-0.36, 0.115],
  ];
  const dR = dRoots.map(([x, y]) => v(x, y, 0.0, 1));
  const dT = dTips.map(([x, y]) => v(x, y, 0.0, 1));
  for (let i = 0; i < dR.length - 1; i++) {
    quad(dR[i], dR[i + 1], dT[i + 1], dT[i]);
  }

  // 3. Anal Fin & Pelvic Ventral Fins (part = 1)
  const a0 = v(-0.08, -0.140, 0.0, 1);
  const a1 = v(-0.20, -0.095, 0.0, 1);
  const a2 = v(-0.30, -0.052, 0.0, 1);
  const at0 = v(-0.16, -0.225, 0.0, 1);
  const at1 = v(-0.28, -0.205, 0.0, 1);
  const at2 = v(-0.36, -0.118, 0.0, 1);
  quad(a0, at0, at1, a1);
  quad(a1, at1, at2, a2);

  // Paired Flared Pectoral Wings & Pelvic Fins on Left (+Z) & Right (-Z) Flanks (part = 1)
  for (const side of [-1, 1]) {
    // Swept pectoral fin blade
    const pRootF = v(0.24, -0.025, side * 0.066, 1);
    const pRootB = v(0.14, -0.055, side * 0.064, 1);
    const pMid = v(0.06, -0.040, side * 0.195, 1);
    const pTip = v(-0.04, -0.085, side * 0.225, 1);
    const pTrail = v(-0.02, -0.115, side * 0.135, 1);
    quad(pRootF, pRootB, pTrail, pMid);
    tri(pMid, pTrail, pTip);

    // Small pelvic fin
    const v0 = v(0.14, -0.155, side * 0.022, 1);
    const v1 = v(0.04, -0.155, side * 0.020, 1);
    const vt = v(-0.04, -0.225, side * 0.058, 1);
    tri(v0, v1, vt);
  }

  // 4. Sculpted Deeply Forked Crescent Caudal Tail Fin (part = 2)
  const tBaseTop = v(-0.35, 0.032, 0.0, 2);
  const tBaseMid = v(-0.36, 0.0, 0.0, 2);
  const tBaseBot = v(-0.35, -0.032, 0.0, 2);
  const tMidTop = v(-0.50, 0.145, 0.0, 2);
  const tTipTop = v(-0.66, 0.245, 0.0, 2);
  const tNotch = v(-0.48, 0.0, 0.0, 2);
  const tMidBot = v(-0.50, -0.145, 0.0, 2);
  const tTipBot = v(-0.66, -0.245, 0.0, 2);
  const tInnerTop = v(-0.56, 0.115, 0.0, 2);
  const tInnerBot = v(-0.56, -0.115, 0.0, 2);
  // Upper lobe
  quad(tBaseTop, tMidTop, tInnerTop, tBaseMid);
  tri(tMidTop, tTipTop, tInnerTop);
  tri(tBaseMid, tInnerTop, tNotch);
  // Lower lobe
  quad(tBaseMid, tInnerBot, tMidBot, tBaseBot);
  tri(tMidBot, tInnerBot, tTipBot);
  tri(tBaseMid, tNotch, tInnerBot);

  // 5. Two Disconnected Glossy 3D Eyes on Head Sides (part = 3)
  for (const side of [-1, 1]) {
    const ex = 0.355, ey = 0.038, ez = side * 0.054, er = 0.028;
    const eCenter = v(ex, ey, ez + side * er * 0.55, 3);
    const eRing = [];
    const eSides = 8;
    for (let s = 0; s < eSides; s++) {
      const a = (s / eSides) * Math.PI * 2;
      eRing.push(v(ex + Math.cos(a) * er, ey + Math.sin(a) * er, ez, 3));
    }
    for (let s = 0; s < eSides; s++) {
      const ns = (s + 1) % eSides;
      if (side > 0) tri(eCenter, eRing[s], eRing[ns]);
      else tri(eCenter, eRing[ns], eRing[s]);
    }
  }

  // Area-weighted vertex normals
  const n = p.length / 3;
  const N = new Float32Array(n * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3;
    const ib = idx[t + 1] * 3;
    const ic = idx[t + 2] * 3;
    const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2];
    const vx = p[ic] - p[ia], vy = p[ic + 1] - p[ia + 1], vz = p[ic + 2] - p[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const k of [ia, ib, ic]) {
      N[k] += nx;
      N[k + 1] += ny;
      N[k + 2] += nz;
    }
  }
  for (let k = 0; k < n; k++) {
    const k3 = k * 3;
    const l = Math.hypot(N[k3], N[k3 + 1], N[k3 + 2]) || 1;
    N[k3] /= l;
    N[k3 + 1] /= l;
    N[k3 + 2] /= l;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('aFishPart', new THREE.Float32BufferAttribute(fPart, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================================
// GTA-6-Grade 1:1 Colossal Mother & Calf Sperm Whales (Physeter macrocephalus — 抹香鯨母子)
// High-Res Organic Sculpt (144x68) + Rounded Spermaceti Case & Junk + Left S-Blowhole +
// Deep Prune-Skin Longitudinal Corrugations + 14 Ventral Throat Pleats +
// Dorsal Hump & 7 Knuckles + Smoothly Blended Underslung Lower Mandible with
// 24 Pairs of Curved Conical Ivory Teeth + 3D Encrusting Volcano Barnacle Clusters +
// Watertight Auto-Outward-Wound Flippers & Flukes (Zero Shared-Vertex Material Bleed!)
// ============================================================================
function buildSpermWhaleGeometry() {
  const pos = [];
  const spineCoord = []; // vec2(tAlongSpine [0..1], waveAmpWeight [0..1])
  // Continuous weights: x = finEdgeThin, y = lipIvory, z = mouthCavity, w = hardId (disconnected: 0=hide, 1=eye, 2=teeth, 3=barnacles)
  const matWeights = [];
  const idx = [];

  function pushWV(x, y, z, t, sw, finEdge = 0, lipIvory = 0, mouthCav = 0, hardId = 0) {
    const id = pos.length / 3;
    pos.push(x, y, z);
    spineCoord.push(t, sw);
    matWeights.push(finEdge, lipIvory, mouthCav, hardId);
    return id;
  }

  function ensureWhaleOutward(startIdx) {
    let vol6 = 0;
    let cx = 0, cy = 0, cz = 0, cnt = 0;
    for (let k = startIdx; k < idx.length; k += 3) {
      const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
      cx += pos[i0] + pos[i1] + pos[i2];
      cy += pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1];
      cz += pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2];
      cnt += 3;
    }
    if (!cnt) return;
    cx /= cnt; cy /= cnt; cz /= cnt;
    for (let k = startIdx; k < idx.length; k += 3) {
      const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
      const ax = pos[i0] - cx, ay = pos[i0 + 1] - cy, az = pos[i0 + 2] - cz;
      const bx = pos[i1] - cx, by = pos[i1 + 1] - cy, bz = pos[i1 + 2] - cz;
      const dx = pos[i2] - cx, dy = pos[i2 + 1] - cy, dz = pos[i2 + 2] - cz;
      vol6 += ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx);
    }
    if (vol6 < 0) {
      for (let k = startIdx; k < idx.length; k += 3) {
        const tmp = idx[k + 1];
        idx[k + 1] = idx[k + 2];
        idx[k + 2] = tmp;
      }
    }
  }

  // Base length 10.0m along Z (+5.06 organic spermaceti prow -> -4.76 peduncle tail root)
  // Scaled by 2.65x for Mother (26.5m) and 1.32x for Calf (13.2m)
  const nLen = 144;
  const nRad = 68;
  const rings = [];

  function whaleEnvelope(t) {
    // Organic rounded-blunt spermaceti head (t: 0..0.35), barrel ribcage torso (0.35..0.58), laterally compressed muscular tail stock (0.58..1.0)
    if (t < 0.042) {
      const u = t / 0.042;
      const blunt = Math.pow(Math.max(0.012, u), 0.36);
      return { rx: 0.52 * blunt, ry: 0.94 * blunt, cy: 0.16 * blunt, boxPow: 2.90 };
    } else if (t < 0.35) {
      const u = (t - 0.042) / 0.308;
      const rx = 0.52 + Math.sin(u * Math.PI * 0.5) * 0.46;
      const ry = 0.94 + Math.sin(u * Math.PI * 0.5) * 0.17;
      const boxPow = 2.90 - u * 0.82; // Organic slab-sided forehead -> rounded barrel chest (no shoebox corners!)
      return { rx, ry, cy: 0.16 - u * 0.10, boxPow };
    } else if (t < 0.58) {
      const u = (t - 0.35) / 0.23;
      const rx = 0.98 - u * 0.20;
      const ry = 1.11 - u * 0.16;
      return { rx, ry, cy: 0.06 - u * 0.04, boxPow: 2.08 - u * 0.10 };
    } else {
      const u = Math.min(1.0, Math.max(0.0, (t - 0.58) / 0.42));
      const rx = Math.max(0.046, 0.78 * Math.pow(Math.max(0.0, 1.0 - u), 1.48) + 0.040);
      const ry = Math.max(0.076, 0.95 * Math.pow(Math.max(0.0, 1.0 - u), 1.22) + 0.066);
      return { rx, ry, cy: 0.02 * (1.0 - u), boxPow: 1.95 };
    }
  }

  for (let i = 0; i <= nLen; i++) {
    const t = i / nLen;
    const z = 5.06 - t * 9.82;
    const env = whaleEnvelope(t);

    // Authentic cetacean dorso-ventral vertical swimming wave envelope
    const sw = t < 0.34 ? 0.04 * (t / 0.34) : 0.04 + 0.96 * Math.pow(Math.max(0.0, (t - 0.34) / 0.66), 1.62);

    const ring = [];
    for (let s = 0; s < nRad; s++) {
      const a = (s / nRad) * Math.PI * 2; // 0 = dorsal (+Y), pi = belly (-Y)
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const absSa = Math.abs(sa);

      // Organic superellipse cross-section
      const absPow = Math.max(1e-5, Math.pow(absSa, env.boxPow) + Math.pow(Math.abs(ca), env.boxPow));
      const lp = Math.pow(absPow, -1.0 / env.boxPow);
      let x = sa * lp * env.rx;
      let y = env.cy + ca * lp * env.ry;

      // Subtle lateral narrowing toward the ventral jaw side of the spermaceti head (real Physeter wedge!)
      if (t < 0.34 && ca < 0.0) {
        const ventTaper = (1.0 - t / 0.34) * (-ca) * 0.24;
        x *= (1.0 - ventTaper);
      }

      // Distinctive spermaceti "junk" & upper "case" organic longitudinal crease (t < 0.28)
      if (t < 0.28 && ca > -0.35 && ca < 0.55) {
        const junkGroove = Math.exp(-Math.pow((ca - 0.12) / 0.17, 2.0)) * (1.0 - t / 0.28) * 0.036;
        x -= Math.sign(sa) * junkGroove;
      }

      // Asymmetric left-anterior S-shaped blowhole mound & sphincter slit (~ x=-0.17, y~0.94, z=4.50)
      if (t > 0.016 && t < 0.110 && ca > 0.60) {
        const dzBlow = (z - 4.50) / 0.24;
        const sCurve = Math.sin(dzBlow * 2.2) * 0.048;
        const dxBlow = (x + 0.17 + sCurve) / 0.15;
        const blowR2 = dzBlow * dzBlow + dxBlow * dxBlow;
        if (blowR2 < 2.5) {
          const mound = Math.exp(-blowR2 * 2.1) * 0.105;
          const slit = Math.exp(-dxBlow * dxBlow * 20.0 - dzBlow * dzBlow * 2.6) * 0.064;
          y += mound - slit;
        }
      }

      // Sculpted supra-ocular temporal bulge & recessed dark orbital eye socket (x=±0.87, y=-0.30, z=2.04, t~0.307)
      if (t > 0.268 && t < 0.348 && absSa > 0.70 && ca < -0.08 && ca > -0.58) {
        const dtE = (t - 0.307) / 0.026;
        const daE = (ca + 0.32) / 0.16;
        const rE2 = dtE * dtE + daE * daE;
        if (rE2 < 1.8) {
          const socket = -Math.exp(-rE2 * 2.8) * 0.056 + Math.exp(-rE2 * 1.15) * 0.030;
          x += Math.sign(sa) * socket;
        }
      }

      // 14 deep longitudinal ventral throat pleats along t in [0.15..0.40]
      if (t > 0.15 && t < 0.40 && ca < -0.16) {
        const tEnv = Math.sin(((t - 0.15) / 0.25) * Math.PI);
        const aEnv = Math.min(1.0, Math.max(0.0, (-ca - 0.16) / 0.56));
        const groove = Math.sin(sa * Math.PI * 14.0) * 0.028 * tEnv * aEnv;
        y -= Math.abs(groove);
      }

      // Organic "Prune-Skin" Corrugated Longitudinal Skin Folds along Posterior Flanks (faded cleanly over fleshy dorsal hump!)
      if (t > 0.32 && t < 0.89 && ca > -0.58) {
        const foldEnv = Math.sin(((t - 0.32) / 0.57) * Math.PI);
        const humpClear = 1.0 - Math.exp(-Math.pow((t - 0.605) / 0.065, 2.0)) * Math.max(0.0, (ca - 0.55) / 0.45);
        const w1 = Math.sin(a * 16.0 + Math.sin(t * 22.0 + a * 2.0) * 2.2) * 0.012;
        const w2 = Math.cos(a * 27.0 - t * 34.0 + Math.sin(a * 5.0)) * 0.007;
        const w3 = Math.sin(t * 78.0 + a * 5.0) * 0.006;
        const corr = (w1 + w2 + w3) * foldEnv * humpClear;
        x += sa * corr;
        y += ca * corr;
      }

      // Signature Crenulated Dorsal Hump (~t=0.605) + 7 Smooth Rounded Dorsal Knuckles + Peduncle Keel
      if (ca > 0.78) {
        const ridgeW = Math.pow(Math.max(0.0, (ca - 0.78) / 0.22), 1.42);
        const hump = Math.exp(-Math.pow((t - 0.605) / 0.048, 2.0)) * 0.36;
        const knk = t > 0.65 && t < 0.90
          ? Math.pow(Math.max(0, Math.sin(((t - 0.65) / 0.25) * Math.PI * 7.0)), 1.55) * 0.062 * Math.sin(((t - 0.65) / 0.25) * Math.PI)
          : 0.0;
        const keel = t > 0.86 ? Math.sin(((t - 0.86) / 0.14) * Math.PI) * 0.058 : 0.0;
        y += (hump + knk + keel) * ridgeW;
      }

      // Ventral post-anal keel along caudal peduncle (t in [0.68..0.95])
      if (ca < -0.80 && t > 0.68 && t < 0.95) {
        const vKeelW = Math.pow(Math.max(0.0, (-ca - 0.80) / 0.20), 1.5);
        const vKeel = Math.sin(((t - 0.68) / 0.27) * Math.PI) * 0.13;
        y -= vKeel * vKeelW;
      }

      // Smoothly carved recessed palatal vault beneath spermaceti rostrum (continuous weights — ZERO rectangular seam!)
      let lipW = 0.0;
      let mouthW = 0.0;
      if (t > 0.032 && t < 0.305 && ca < -0.58) {
        const uPal = (t - 0.032) / 0.273;
        const envPal = Math.sin(uPal * Math.PI);
        const angPal = Math.min(1.0, Math.max(0.0, (-ca - 0.58) / 0.36));
        const smoothAng = angPal * angPal * (3.0 - 2.0 * angPal);
        const mouthInset = envPal * smoothAng * 0.25;
        y += mouthInset;
        mouthW = envPal * Math.pow(smoothAng, 1.35);
        // Soft natural pale rim right along the organic lip contour
        lipW = envPal * Math.sin(smoothAng * Math.PI) * 0.65;
      }

      ring.push(pushWV(x, y, z, t, sw, 0.0, lipW, mouthW, 0));
    }
    rings.push(ring);
  }

  for (let i = 0; i < nLen; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    for (let s = 0; s < nRad; s++) {
      const ns = (s + 1) % nRad;
      idx.push(r0[s], r0[ns], r1[ns], r0[s], r1[ns], r1[s]);
    }
  }

  // Cap rounded spermaceti prow cleanly
  const prowTip = pushWV(0, 0.16, 5.13, 0.0, 0.0, 0, 0, 0, 0);
  const firstR = rings[0];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(prowTip, firstR[ns], firstR[s]);
  }

  // Taper and weld rear caudal peduncle cleanly inside the central fluke keel
  const pedTip = pushWV(0, 0.0, -4.90, 1.0, 1.0, 0, 0, 0, 0);
  const lastR = rings[rings.length - 1];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(pedTip, lastR[s], lastR[ns]);
  }

  // ---- Articulated Narrow Underslung Lower Jaw (Mandible with Smooth White Lip Margin & Oral Trough) ----
  const jawSegs = 32;
  const jawRad = 24;
  const jawRings = [];
  for (let i = 0; i <= jawSegs; i++) {
    const u = i / jawSegs; // 0 = rounded symphyseal chin tip (+4.66), 1 = gular hinge into throat (+1.92)
    const z = 4.66 - u * 2.74;
    const t = 0.036 + u * 0.274;
    // Narrow rod-like anterior symphysis flaring organically into throat condyles
    const jx = 0.088 + Math.pow(u, 1.52) * 0.38;
    const jy = 0.118 + u * 0.185;
    const cy = -0.68 - Math.sin(u * Math.PI * 0.48) * 0.105;
    const sw = 0.04 * (t / 0.34);
    const ring = [];
    for (let s = 0; s < jawRad; s++) {
      const a = (s / jawRad) * Math.PI * 2;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const oralGroove = ca > 0.32 && Math.abs(sa) < 0.68 ? -0.040 * Math.cos((sa / 0.68) * Math.PI * 0.5) : 0.0;
      const vy = cy + ca * jy + oralGroove;
      // Smooth continuous lip ivory gradient along upper/side jaw margin + oral cavity inside trough
      const lipW = Math.max(0.0, Math.min(1.0, (ca + 0.35) * 1.15)) * (1.0 - Math.pow(u, 2.2) * 0.72);
      const mouthW = ca > 0.45 && u < 0.88 ? Math.min(1.0, (ca - 0.45) / 0.45) : 0.0;
      ring.push(pushWV(sa * jx, vy, z, t, sw, 0.0, lipW, mouthW, 0));
    }
    jawRings.push(ring);
  }
  for (let i = 0; i < jawSegs; i++) {
    for (let s = 0; s < jawRad; s++) {
      const ns = (s + 1) % jawRad;
      idx.push(jawRings[i][s], jawRings[i][ns], jawRings[i + 1][ns], jawRings[i][s], jawRings[i + 1][ns], jawRings[i + 1][s]);
    }
  }
  const jawTip = pushWV(0, -0.66, 4.72, 0.032, 0.0, 0, 0.75, 0, 0);
  for (let s = 0; s < jawRad; s++) {
    const ns = (s + 1) % jawRad;
    idx.push(jawTip, jawRings[0][ns], jawRings[0][s]);
  }

  // ---- 24 Pairs of Curved Conical Ivory Teeth (Disconnected hardId = 2) ----
  const toothPairs = 24;
  const toothSides = 8;
  const toothRings = 3;
  for (let k = 0; k < toothPairs; k++) {
    const u = 0.045 + (k / (toothPairs - 1)) * 0.82;
    const tz = 4.66 - u * 2.74;
    const tt = 0.036 + u * 0.274;
    const jx = 0.088 + Math.pow(Math.max(0.0, u), 1.52) * 0.38;
    const jy = 0.118 + u * 0.185;
    const cy = -0.68 - Math.sin(u * Math.PI * 0.48) * 0.105;
    const sw = 0.04 * (tt / 0.34);
    const toothScale = 0.68 + 0.44 * Math.sin(u * Math.PI);
    const tR = 0.022 * toothScale;
    const tH = 0.084 * toothScale;

    for (const side of [-1, 1]) {
      const bx = side * jx * 0.74;
      const by = cy + jy * 0.78;
      const tLevels = [];
      for (let r = 0; r < toothRings; r++) {
        const v = r / toothRings;
        const rad = tR * (1.0 - v * 0.58) * (r === 0 ? 1.15 : 1.0);
        const hookIn = -side * Math.pow(v, 1.6) * 0.016;
        const hookBack = -Math.pow(v, 1.5) * 0.012;
        const yLv = by - 0.012 + v * tH * 0.78;
        const ring = [];
        for (let s = 0; s < toothSides; s++) {
          const a = (s / toothSides) * Math.PI * 2;
          ring.push(pushWV(bx + hookIn + Math.cos(a) * rad, yLv, tz + hookBack + Math.sin(a) * rad, tt, sw, v, 0, 0, 2));
        }
        tLevels.push(ring);
      }
      const tipId = pushWV(bx - side * 0.020, by + tH, tz - 0.016, tt, sw, 1.0, 0, 0, 2);
      for (let r = 0; r < toothRings - 1; r++) {
        for (let s = 0; s < toothSides; s++) {
          const ns = (s + 1) % toothSides;
          idx.push(tLevels[r][s], tLevels[r][ns], tLevels[r + 1][ns], tLevels[r][s], tLevels[r + 1][ns], tLevels[r + 1][s]);
        }
      }
      const topR = tLevels[toothRings - 1];
      for (let s = 0; s < toothSides; s++) {
        const ns = (s + 1) % toothSides;
        idx.push(topR[s], topR[ns], tipId);
      }
    }
  }

  // ---- Watertight Filleted Paddle Pectoral Flippers with Phalangeal Ridges (Auto-Outward-Wound!) ----
  for (const side of [-1, 1]) {
    const pecStart = idx.length;
    const fRows = 18;
    const fCols = 16;
    const topGrid = [];
    const botGrid = [];
    for (let ir = 0; ir <= fRows; ir++) {
      const u = ir / fRows;
      const span = side * (0.62 + u * 0.98);
      const chord = 0.62 * (1.0 - 0.34 * u * u) * (u > 0.78 ? Math.cos(((u - 0.78) / 0.22) * Math.PI * 0.49) : 1.0);
      const zC = 1.42 - u * 0.46;
      const yC = -0.34 - u * 0.32 + Math.sin(u * Math.PI) * 0.05;
      const fillet = u < 0.24 ? Math.pow(1.0 - u / 0.24, 2.0) * 0.92 : 0.0;
      const tipTaper = u > 0.86 ? Math.cos(((u - 0.86) / 0.14) * Math.PI * 0.49) : 1.0;
      const thick = (0.118 * (1.0 - u * 0.82) + 0.010) * (1.0 + fillet) * tipTaper;
      const rTop = [];
      const rBot = [];
      for (let ic = 0; ic <= fCols; ic++) {
        const v = ic / fCols; // 0 = trailing, 1 = leading
        const z = zC + (v - 0.5) * chord;
        const prof = Math.sin(v * Math.PI);
        const digitRidge = Math.sin(v * Math.PI * 4.0) * 0.009 * u * (1.0 - u);
        const edgeThin = Math.min(1.0, Math.max(1.0 - v / 0.30, (u - 0.68) / 0.32));
        rTop.push(pushWV(span, yC + thick * prof + digitRidge, z, 0.37 + u * 0.03, 0.06, Math.max(0, edgeThin), 0, 0, 0));
        rBot.push(pushWV(span, yC - thick * prof * 0.80, z, 0.37 + u * 0.03, 0.06, Math.max(0, edgeThin), 0, 0, 0));
      }
      topGrid.push(rTop);
      botGrid.push(rBot);
    }
    for (let ir = 0; ir < fRows; ir++) {
      for (let ic = 0; ic < fCols; ic++) {
        if (side > 0) {
          idx.push(topGrid[ir][ic], topGrid[ir][ic + 1], topGrid[ir + 1][ic + 1], topGrid[ir][ic], topGrid[ir + 1][ic + 1], topGrid[ir + 1][ic]);
          idx.push(botGrid[ir][ic], botGrid[ir + 1][ic + 1], botGrid[ir][ic + 1], botGrid[ir][ic], botGrid[ir + 1][ic], botGrid[ir + 1][ic + 1]);
        } else {
          idx.push(topGrid[ir][ic], topGrid[ir + 1][ic + 1], topGrid[ir][ic + 1], topGrid[ir][ic], topGrid[ir + 1][ic], topGrid[ir + 1][ic + 1]);
          idx.push(botGrid[ir][ic], botGrid[ir][ic + 1], botGrid[ir + 1][ic + 1], botGrid[ir][ic], botGrid[ir + 1][ic + 1], botGrid[ir + 1][ic]);
        }
      }
    }
    ensureWhaleOutward(pecStart);
  }

  // ---- Continuous Closed Double-Lobe Horizontal Tail Flukes (80 span segs, V-Notch & Battle Nick) ----
  {
    const flukeStart = idx.length;
    const spanSegs = 80;
    const cols = 20;
    const tGrid = [];
    const bGrid = [];
    for (let ir = 0; ir <= spanSegs; ir++) {
      const u = (ir / spanSegs) * 2.0 - 1.0;
      const au = Math.abs(u);
      const x = u * 1.50; // ~7.95m full colossal fluke span at 2.65x Mother scale
      const tipMask = Math.pow(Math.max(0.0, 1.0 - au * au), 0.72);
      const leadZ = -4.18 - Math.pow(au, 1.38) * 0.86;
      const notchIn = 0.24 * Math.exp(-Math.pow(au / 0.052, 2.0));
      const gentleWave = Math.sin(au * Math.PI * 2.0) * 0.016 * Math.sin(au * Math.PI);
      const battleNick = (u > 0.54 && u < 0.65)
        ? Math.sin(((u - 0.54) / 0.11) * Math.PI) * 0.054
        : 0.0;
      const rawTrailZ = -5.06 + notchIn + gentleWave + battleNick - Math.pow(au, 1.45) * 0.12;
      const chord = Math.max(0.0, leadZ - rawTrailZ) * tipMask;
      const trailZ = leadZ - chord;
      const rootFillet = Math.exp(-Math.pow(au / 0.11, 2.0)) * 0.112;
      const thick = (0.090 * (1.0 - au * 0.68) + rootFillet) * tipMask;
      const rTop = [];
      const rBot = [];
      for (let ic = 0; ic <= cols; ic++) {
        const v = ic / cols; // 0 = trailing edge, 1 = leading edge
        const z = trailZ + v * chord;
        const naca = Math.sin(Math.pow(v, 0.75) * Math.PI);
        const t = 0.935 + (1.0 - v) * 0.065;
        const edgeThin = Math.min(1.0, Math.max(1.0 - v / 0.34, (au - 0.68) / 0.32));
        rTop.push(pushWV(x, thick * naca, z, t, 1.0, Math.max(0, edgeThin), 0, 0, 0));
        rBot.push(pushWV(x, -thick * naca, z, t, 1.0, Math.max(0, edgeThin), 0, 0, 0));
      }
      tGrid.push(rTop);
      bGrid.push(rBot);
    }
    for (let ir = 0; ir < spanSegs; ir++) {
      for (let ic = 0; ic < cols; ic++) {
        idx.push(tGrid[ir][ic], tGrid[ir][ic + 1], tGrid[ir + 1][ic + 1], tGrid[ir][ic], tGrid[ir + 1][ic + 1], tGrid[ir + 1][ic]);
        idx.push(bGrid[ir][ic], bGrid[ir + 1][ic + 1], bGrid[ir][ic + 1], bGrid[ir][ic], bGrid[ir + 1][ic], bGrid[ir + 1][ic + 1]);
      }
    }
    ensureWhaleOutward(flukeStart);
  }

  // ---- Glossy Cetacean Eyes tucked deeply inside Temporal Orbital Sockets (Disconnected hardId = 1) ----
  const eyeGeo = new THREE.SphereGeometry(0.084, 18, 14);
  const eyePos = eyeGeo.getAttribute('position');
  const eyeIdx = eyeGeo.index;
  for (const side of [-1, 1]) {
    const baseV = pos.length / 3;
    const ex = side * 0.875;
    const ey = -0.31;
    const ez = 2.04;
    for (let i = 0; i < eyePos.count; i++) {
      pushWV(ex + eyePos.getX(i) * 0.66, ey + eyePos.getY(i), ez + eyePos.getZ(i) * 1.15, 0.305, 0.04, 0, 0, 0, 1);
    }
    for (let i = 0; i < eyeIdx.count; i += 3) {
      idx.push(baseV + eyeIdx.getX(i), baseV + eyeIdx.getX(i + 1), baseV + eyeIdx.getX(i + 2));
    }
  }
  eyeGeo.dispose();

  // ---- 3D Encrusting Whale Barnacle Clusters (Coronula volcano shells, Disconnected hardId = 3) ----
  const barnacleSpots = [
    // Lower chin & jaw tip clusters
    [0.04, -0.77, 4.58, 0.036, 0, -1, 0.25, 0.045, 0.005],
    [-0.05, -0.78, 4.46, 0.032, -0.2, -0.95, 0.15, 0.058, 0.007],
    [0.08, -0.79, 4.22, 0.034, 0.25, -0.92, 0.1, 0.082, 0.010],
    [-0.10, -0.80, 3.92, 0.030, -0.3, -0.92, 0.0, 0.112, 0.014],
    [0.14, -0.82, 3.55, 0.036, 0.35, -0.90, 0.0, 0.150, 0.018],
    // Forehead / spermaceti prow scars & callosities
    [0.48, 0.62, 4.55, 0.042, 0.72, 0.55, 0.42, 0.050, 0.006],
    [0.54, 0.52, 4.42, 0.030, 0.78, 0.45, 0.38, 0.062, 0.008],
    [-0.50, 0.44, 4.48, 0.040, -0.78, 0.40, 0.42, 0.058, 0.007],
    [-0.56, 0.36, 4.30, 0.028, -0.82, 0.32, 0.35, 0.075, 0.009],
    // Pectoral leading edge barnacles (both flippers)
    [1.12, -0.45, 1.44, 0.038, 0.25, 0.45, 0.85, 0.38, 0.06],
    [1.24, -0.50, 1.38, 0.030, 0.28, 0.40, 0.86, 0.39, 0.06],
    [-1.15, -0.46, 1.42, 0.036, -0.25, 0.45, 0.85, 0.38, 0.06],
    [-1.30, -0.53, 1.32, 0.028, -0.28, 0.42, 0.84, 0.39, 0.06],
    // Dorsal hump & knuckle crest barnacles
    [0.06, 1.24, -0.86, 0.040, 0.15, 0.98, 0.0, 0.605, 0.26],
    [-0.08, 1.20, -0.96, 0.032, -0.20, 0.96, 0.0, 0.615, 0.28],
    // Tail fluke leading edge barnacles
    [1.06, 0.03, -4.64, 0.036, 0.2, 0.6, 0.75, 0.95, 1.0],
    [-1.12, 0.03, -4.68, 0.034, -0.2, 0.6, 0.75, 0.95, 1.0],
  ];
  for (const bs of barnacleSpots) {
    const [bx, by, bz, r, nx, ny, nz, bt, bsw] = bs;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / nl, uy = ny / nl, uz = nz / nl;
    // Build tangent basis around outward normal u
    const refX = Math.abs(uy) < 0.9 ? 0 : 1;
    const refY = Math.abs(uy) < 0.9 ? 1 : 0;
    let tx = refY * uz - 0 * uy;
    let ty = 0 * ux - refX * uz;
    let tz = refX * uy - refY * ux;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const vx = uy * tz - uz * ty;
    const vy = uz * tx - ux * tz;
    const vz = ux * ty - uy * tx;

    const bStart = idx.length;
    const sides = 7;
    const h = r * 0.72;
    const baseR = [];
    const topR = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rib = 1.0 + 0.14 * Math.cos(a * 6.0);
      const rb = r * rib;
      const rt = r * 0.44 * rib;
      baseR.push(pushWV(
        bx + (tx * ca + vx * sa) * rb - ux * h * 0.25,
        by + (ty * ca + vy * sa) * rb - uy * h * 0.25,
        bz + (tz * ca + vz * sa) * rb - uz * h * 0.25,
        bt, bsw, 0.0, 0, 0, 3
      ));
      topR.push(pushWV(
        bx + (tx * ca + vx * sa) * rt + ux * h,
        by + (ty * ca + vy * sa) * rt + uy * h,
        bz + (tz * ca + vz * sa) * rt + uz * h,
        bt, bsw, 1.0, 0, 0, 3
      ));
    }
    const crater = pushWV(bx + ux * h * 0.42, by + uy * h * 0.42, bz + uz * h * 0.42, bt, bsw, 0.0, 0, 0, 3);
    for (let s = 0; s < sides; s++) {
      const ns = (s + 1) % sides;
      idx.push(baseR[s], baseR[ns], topR[ns], baseR[s], topR[ns], topR[s]);
      idx.push(topR[s], topR[ns], crater);
    }
    ensureWhaleOutward(bStart);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSpineCoord', new THREE.Float32BufferAttribute(spineCoord, 2));
  geo.setAttribute('aMatWeights', new THREE.Float32BufferAttribute(matWeights, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const WHALE_WAVE_GLSL = `
  vec3 whaleDeform(vec3 p, vec2 sc, vec4 st, vec2 look) {
    float t = sc.x;
    float w = sc.y;

    // 1. Subtle echolocation click-train jaw articulation on lower mandible & teeth (z > 2.0, y < -0.46)
    if (t < 0.31 && p.y < -0.46 && abs(p.x) < 0.46) {
      float jawArm = max(0.0, p.z - 2.05);
      float clickOpen = (0.35 + 0.65 * pow(0.5 + 0.5 * sin(st.x * 0.72), 2.0)) * 0.045;
      p.y -= jawArm * clickOpen;
    }

    // 2. Smooth spanwise flex lag across the broad 7.9m tail flukes
    float spanLag = pow(max(0.0, abs(p.x) - 0.22), 1.25) * 0.095 * smoothstep(0.55, 0.91, t);
    float kPhase = st.x - t * 4.6 - spanLag;
    float wave = sin(kPhase);
    float dWaveDt = -4.6 * cos(kPhase);

    // 3. Breathing / sounding dive spinal arch anchored near thoracic center
    float arch = (t - 0.38) * (t - 0.38) - 0.14;
    float dArchDt = 2.0 * (t - 0.38);

    // 4. Arc-length-preserving spinal pitch rotation so cross-sections stay perpendicular to curved spine
    float pitchAngle = clamp((dWaveDt * 0.048 * w * st.w) + (st.y * dArchDt * 0.24), -0.42, 0.42);
    float cp = cos(pitchAngle);
    float sp = sin(pitchAngle);
    float localY = p.y;
    p.y = localY * cp;
    p.z += -localY * sp * 0.32 + cos(kPhase) * 0.035 * w * st.w;

    // Apply vertical fluke stroke + spinal arch displacement
    p.y += wave * 0.64 * w * st.w - sin(st.x) * 0.04 * (1.0 - w) * st.w - st.y * arch * 2.4;

    // 5. Lateral turning curve & caudal bank twist along posterior body & tail
    float turnCurve = st.z * pow(max(0.0, t - 0.35), 2.0);
    p.x += turnCurve * 1.85;
    p.y += p.x * st.z * w * 0.14;

    // 6. Curious head look-at bend toward nearby diver (anterior rostrum t < 0.38)
    float headBend = smoothstep(0.38, 0.02, t);
    float headArm = headBend * headBend;
    p.x += look.x * headArm * 1.45;
    p.y += look.y * headArm * 0.95;
    return p;
  }
`;

function createWhaleMaterial(sharedUniforms, whaleUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    attribute vec4 aMatWeights;

    uniform vec4 uWhaleState;
    uniform vec2 uWhaleLook;

    ${MEDIUM_GLSL}
    ${WHALE_WAVE_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vLPos;
    out vec3 vLNorm;
    out vec2 vSpine;
    out vec4 vMatW;

    void main() {
      vec3 lp = whaleDeform(position, aSpineCoord, uWhaleState, uWhaleLook);

      // Unclamped centered finite-difference Jacobian transpose normal transform
      float t0 = aSpineCoord.x - 0.012;
      float t1 = aSpineCoord.x + 0.012;
      float dz = -(t1 - t0) * 9.82;
      vec3 d0 = whaleDeform(position, vec2(t0, aSpineCoord.y), uWhaleState, uWhaleLook);
      vec3 d1 = whaleDeform(position, vec2(t1, aSpineCoord.y), uWhaleState, uWhaleLook);
      vec3 dDdz = (d1 - d0) / dz;
      vec3 ln = normalize(vec3(
        normal.x,
        normal.y,
        (-dDdz.x * normal.x - dDdz.y * normal.y + normal.z) / max(0.35, 1.0 + dDdz.z)
      ));

      vec4 wp = modelMatrix * vec4(lp, 1.0);
      vec3 wn = normalize(mat3(modelMatrix) * ln);

      vWPos = wp.xyz;
      vWNorm = wn;
      vLPos = position;
      vLNorm = normal;
      vSpine = aSpineCoord;
      vMatW = aMatWeights;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    uniform vec4 uWhaleState;
    uniform float uWhaleAge; // 1.0 = weathered veteran Mother, 0.28 = sleeker younger Calf

    ${MEDIUM_GLSL}
    ${SURFACE_GRADIENT_BUMP_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vLPos;
    in vec3 vLNorm;
    in vec2 vSpine;
    in vec4 vMatW;

    layout(location = 0) out vec4 fragColor;

    // Multi-Scale Giant Squid (Architeuthis) Sucker-Ring Crater Scars & Parallel Rake Slashes
    // Returns vec3(scarAlbedo [0..1], craterHeight [-1..1], rakeAO [0..1])
    vec3 squidScarsAndRakes(vec3 lp, float spineT, float age) {
      float headWeight = (1.0 - smoothstep(0.22, 0.62, spineT)) * (0.35 + 0.65 * age);
      if (headWeight <= 0.01) return vec3(0.0);

      vec2 uv = vec2(lp.z * 2.5, atan(lp.x, lp.y + 0.12) * 3.0);

      // 1. Two octaves of circular serrated Giant Squid sucker-ring imprints (raised scar rim + recessed pit!)
      float suckerVis = 0.0;
      float suckerH = 0.0;
      for (int oct = 0; oct < 2; oct++) {
        float sc = oct == 0 ? 2.1 : 3.6;
        vec2 p = uv * sc + vec2(float(oct) * 11.3, float(oct) * 5.7);
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float h = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        if (h > 0.50) {
          vec2 offset = vec2(fract(h * 13.7) - 0.5, fract(h * 29.3) - 0.5) * 0.40;
          float rad = mix(0.15, 0.33, fract(h * 7.1));
          float d = length(f - offset);
          float rim = exp(-pow((d - rad) / 0.042, 2.0));
          float pit = exp(-pow(d / max(rad * 0.65, 0.05), 2.0));
          float w = (oct == 0 ? 0.92 : 0.68);
          suckerVis += rim * w;
          suckerH += (rim * 0.85 - pit * 0.45) * w;
        }
      }

      // 2. Intersecting parallel linear rake scars (squid hooks & bull whale tooth rakes)
      float r1 = exp(-pow(sin(uv.x * 5.8 + uv.y * 4.4 + sin(uv.x * 1.6) * 0.9), 2.0) * 110.0)
        * smoothstep(0.38, 0.82, sin(uv.x * 0.95 - uv.y * 0.85));
      float r2 = exp(-pow(sin(uv.x * 4.9 - uv.y * 5.6 + cos(uv.y * 1.8) * 0.8), 2.0) * 125.0)
        * smoothstep(0.45, 0.86, cos(uv.x * 0.78 + uv.y * 1.25));
      float r3 = exp(-pow(sin(uv.x * 8.6 + uv.y * 2.2), 2.0) * 145.0)
        * smoothstep(0.55, 0.90, sin(uv.x * 1.85 + 1.1));
      // Long sweeping healed forehead slash across Mother's prow
      float heroSlash = exp(-pow((lp.y - 0.36 + (lp.z - 3.6) * 0.34) / 0.022, 2.0))
        * smoothstep(2.4, 3.2, lp.z) * (1.0 - smoothstep(4.2, 4.9, lp.z)) * age;

      float rakes = clamp((r1 + r2 + r3) * 0.75 + heroSlash * 1.15, 0.0, 1.3);
      float totalScar = clamp((suckerVis * 0.85 + rakes * 0.82) * headWeight, 0.0, 1.0);
      float heightOut = (suckerH * 0.75 - rakes * 0.68) * headWeight;
      float aoOut = clamp(rakes * 0.45 * headWeight, 0.0, 0.55);
      return vec3(totalScar, heightOut, aoOut);
    }

    void main() {
      vec3 gn = normalize(vWNorm);
      float finEdgeW = vMatW.x;
      float lipIvoryW = vMatW.y;
      float mouthCavW = vMatW.z;
      float hardId = vMatW.w;

      // Disconnected sub-mesh masks (ZERO shared-vertex interpolation artifacts!)
      float eyeMask = step(0.5, hardId) * step(hardId, 1.5);
      float toothMask = step(1.5, hardId) * step(hardId, 2.5);
      float barnacleMask = step(2.5, hardId);
      float hideOnly = 1.0 - clamp(eyeMask + toothMask + barnacleMask, 0.0, 1.0);

      // Multi-scale organic cetacean hide triplanar sampling
      TP tpMacro = tri(vLPos * 1.45, gn);
      TP tpMed = tri(vLPos * 5.2, gn);
      TP tpMicro = tri(vLPos * 18.5, gn);

      float isPec = smoothstep(0.62, 1.35, abs(vLPos.x)) * (1.0 - smoothstep(0.52, 0.88, vSpine.x));
      float isFluke = smoothstep(0.925, 0.975, vSpine.x);
      float flukeBladeMask = clamp(max(isPec * 0.65, isFluke), 0.0, 1.0);
      float bumpWeight = mix(1.0, 0.34, flukeBladeMask) * hideOnly;

      // ---- Iconic Organic "Prune-Skin" Corrugated Wrinkles (Domain-Warped, Faded over Smooth Dorsal Hump!) ----
      float humpSmooth = 1.0 - exp(-pow((vSpine.x - 0.605) / 0.068, 2.0)) * smoothstep(0.45, 0.85, vLNorm.y);
      float corrMask = smoothstep(0.24, 0.44, vSpine.x) * (1.0 - smoothstep(0.85, 0.94, vSpine.x)) * humpSmooth;
      float flexCompress = 1.0 + abs(uWhaleState.y) * 0.50 + 0.18 * abs(sin(uWhaleState.x - vSpine.x * 4.6));
      float angleCoord = atan(vLPos.x, vLPos.y + 0.05);
      // Domain-warped organic meandering leather folds (breaks up synthetic parallel stripes!)
      float warp = tpMacro.h * 6.8 + tpMed.c * 3.2;
      float fold1 = sin(angleCoord * 17.0 + vLPos.z * 2.8 + warp);
      float fold2 = cos(angleCoord * 29.0 - vLPos.z * 5.4 + tpMed.h * 5.2);
      float fold3 = sin(vLPos.z * 13.5 + angleCoord * 8.0 + tpMacro.c * 4.5);
      float pruneRidge = (pow(0.5 + 0.5 * fold1, 0.72) * 0.50 + pow(0.5 + 0.5 * fold2, 0.78) * 0.30 + (0.5 + 0.5 * fold3) * 0.20);
      float pruneTrough = 1.0 - smoothstep(0.16, 0.52, pruneRidge);
      float pruneHeight = (pruneRidge - 0.5) * corrMask * flexCompress * (0.58 + 0.42 * uWhaleAge);

      // Peeling sloughing epidermis patches (distinct stepped papery edge on older Mother Whale)
      float sloughRaw = tpMacro.c * 0.62 + tpMed.h * 0.38;
      float sloughPatch = smoothstep(0.58, 0.65, sloughRaw) * (0.35 + 0.65 * uWhaleAge) * hideOnly;
      float sloughEdge = smoothstep(0.56, 0.61, sloughRaw) * (1.0 - smoothstep(0.62, 0.67, sloughRaw));

      // Giant Squid battle scars & sucker-ring craters
      vec3 scarData = squidScarsAndRakes(vLPos, vSpine.x, uWhaleAge);

      // Compute true 4K-equivalent Mikkelsen surface-gradient micro-normal relief in world space!
      float totalHeight = (
        pruneHeight * 0.92 +
        (tpMacro.h - 0.5) * 0.52 +
        (tpMed.h - 0.5) * 0.34 +
        (tpMicro.h - 0.5) * 0.16 +
        scarData.y * 0.95 -
        sloughPatch * 0.20
      ) * bumpWeight;
      // Add calcified radial ribbing bump on 3D barnacles
      if (barnacleMask > 0.5) {
        totalHeight = tpMicro.h * 0.8 + tpMed.h * 0.6;
      }
      vec3 N = perturbNormalBump(vWPos, gn, totalHeight, mix(0.026, 0.014, flukeBladeMask));
      N = normalize(N + (tpMacro.n * 0.14 + tpMicro.n * 0.08) * bumpWeight);

      // ---- Rich Photorealistic Physeter macrocephalus Pelagic Hide Palette ----
      vec3 dorsalObsidian = vec3(0.032, 0.040, 0.054); // Deep wet obsidian-slate dorsal hide
      vec3 weatheredBronze = vec3(0.078, 0.068, 0.072); // Subtle warm brownish-charcoal melanin undertone
      vec3 flankSlate = mix(vec3(0.058, 0.070, 0.088), weatheredBronze, 0.42);
      vec3 bellyBase = vec3(0.115, 0.132, 0.152);

      // Characteristic piebald pale-grey umbilical & throat splash patch on ventral belly
      float piebald = smoothstep(0.46, 0.74, tpMacro.c * 0.65 + tpMed.c * 0.35)
        * smoothstep(0.18, 0.65, vSpine.x) * (1.0 - smoothstep(0.66, 0.86, vSpine.x));
      vec3 bellyCol = mix(bellyBase, vec3(0.32, 0.34, 0.37), piebald * 0.80);

      float vGrad = smoothstep(-0.68, 0.44, vLPos.y + (tpMacro.h - 0.5) * 0.18);
      vec3 skinCol = mix(bellyCol, mix(flankSlate, dorsalObsidian, smoothstep(0.12, 0.65, vLPos.y)), vGrad);

      // Slight age melanin shift: younger Calf is sleeker & richer slate-charcoal, older Mother has more weathered patina
      skinCol *= mix(0.86, 1.04, uWhaleAge);

      // Peeling sloughing epidermis patches (paler dusty slate-silver with crisp thin peel rim)
      vec3 sloughCol = skinCol * 1.48 + vec3(0.045, 0.048, 0.052);
      skinCol = mix(skinCol, sloughCol, sloughPatch * 0.55);
      skinCol = mix(skinCol, vec3(0.34, 0.36, 0.38), sloughEdge * 0.32 * uWhaleAge * hideOnly);

      // Weathered dorsal hump & knuckle crest callosities
      float humpCallus = exp(-pow((vSpine.x - 0.605) / 0.058, 2.0)) * smoothstep(0.62, 0.90, vLNorm.y) * smoothstep(0.44, 0.72, tpMed.c);
      skinCol = mix(skinCol, vec3(0.22, 0.23, 0.25), humpCallus * 0.62 * (0.4 + 0.6 * uWhaleAge));

      // Pale-silver Giant Squid sucker-ring scars & linear tooth rake battle slashes across forehead & cheeks
      float headMottle = (1.0 - smoothstep(0.22, 0.44, vSpine.x)) * smoothstep(0.56, 0.78, tpMed.c) * uWhaleAge;
      float totalScarMask = clamp(scarData.x + headMottle * 0.28, 0.0, 1.0) * hideOnly;
      vec3 scarCol = mix(vec3(0.30, 0.33, 0.37), vec3(0.46, 0.48, 0.51), scarData.x);
      skinCol = mix(skinCol, scarCol, totalScarMask * 0.78);

      // Smooth organic pale-ivory lower jaw lip margin (NO rectangular box seam!)
      float organicLip = lipIvoryW * (0.55 + 0.45 * tpMed.h) * hideOnly;
      skinCol = mix(skinCol, vec3(0.40, 0.42, 0.42), organicLip * 0.76);

      // Recessed dark fleshy palatal vault & pinkish-mauve gum sockets inside jaw
      float gumMask = smoothstep(0.18, 0.85, mouthCavW) * hideOnly;
      skinCol = mix(skinCol, vec3(0.26, 0.14, 0.16), gumMask * 0.88);

      // Deep micro-cavity AO inside prune-skin wrinkle troughs, throat grooves, rake scars & eye socket
      float eyeSocketAO = 1.0 - 0.42 * exp(-pow((vLPos.z - 2.04) / 0.24, 2.0) - pow((vLPos.y + 0.31) / 0.18, 2.0)) * hideOnly;
      float wrinkleAO = 1.0 - pruneTrough * corrMask * 0.36 * (0.55 + 0.45 * uWhaleAge);
      float baseAO = mix(0.72, 1.06, smoothstep(0.22, 0.78, tpMacro.h * 0.58 + tpMed.h * 0.42));
      skinCol *= wrinkleAO * baseAO * eyeSocketAO * (1.0 - scarData.z * 0.35);

      float roughness = mix(0.34, 0.48, sloughPatch * 0.65);
      float specStr = mix(0.42, 0.22, sloughPatch * 0.65);

      // ---- 3D Encrusting Calcified Whale Barnacles (Disconnected hardId = 3) ----
      if (barnacleMask > 0.5) {
        vec3 shellCol = mix(vec3(0.56, 0.55, 0.48), vec3(0.76, 0.74, 0.66), finEdgeW);
        // Dark volcano aperture crater & greenish algae base rim
        shellCol = mix(vec3(0.18, 0.21, 0.16), shellCol, smoothstep(0.05, 0.35, finEdgeW));
        skinCol = shellCol * (0.82 + 0.32 * tpMicro.h);
        roughness = 0.62;
        specStr = 0.18;
      }

      // ---- Curved Conical Ivory Teeth (Disconnected hardId = 2) ----
      if (toothMask > 0.5) {
        skinCol = mix(vec3(0.48, 0.42, 0.33), vec3(0.86, 0.82, 0.74), smoothstep(0.12, 0.85, finEdgeW));
        roughness = 0.14;
        specStr = 0.95;
      }

      // ---- Lifelike Glossy Cetacean Eye with Chestnut-Mahogany Iris & Crisp Catchlight (Disconnected hardId = 1) ----
      if (eyeMask > 0.5) {
        vec2 eyeRel = vec2((vLPos.z - 2.04) / 0.088, (vLPos.y + 0.31) / 0.078);
        float eyeR = length(eyeRel);
        float pupil = 1.0 - smoothstep(0.36, 0.52, eyeR);
        float iris = (1.0 - pupil) * (1.0 - smoothstep(0.74, 0.95, eyeR));
        vec3 eyeCol = mix(vec3(0.015, 0.020, 0.025), vec3(0.20, 0.12, 0.07), iris);
        eyeCol = mix(eyeCol, vec3(0.004, 0.005, 0.008), pupil);
        skinCol = eyeCol;
        roughness = 0.04;
        specStr = 1.65;
      }

      vec3 V = normalize(uCamPos - vWPos);
      float ndv = max(dot(N, V), 0.02);
      float sh = shadow9(vWPos);

      // ---- 1. Underwater Dual-Lobe PBR Lighting, Chromatic Caustics & Cetacean Dermal SSS ----
      vec3 caRaw = causRGB(vWPos);
      vec3 ca = caRaw / (1.0 + caRaw * 0.72);
      vec3 sunIrr = sunE(vWPos);
      float wrapNdl = max(0.0, (dot(N, uSunDir) + 0.16) / 1.16);
      vec3 directUW = sunIrr * wrapNdl * sh * (0.48 + ca * 1.05);
      vec3 bellyBounce = vec3(0.14, 0.21, 0.23) * max(-N.y, 0.0);
      vec3 ambientUW = amb(vWPos, N) + sideLight(vWPos, N) + bellyBounce;

      // Dual-lobe wet cetacean specular: oily dermal satin + tight mirror seawater clearcoat
      vec3 H_uw = normalize(V + uSunDir);
      float ndh_uw = max(dot(N, H_uw), 0.0);
      float alphaSq = pow(roughness, 4.0);
      float denom = ndh_uw * ndh_uw * (alphaSq - 1.0) + 1.0;
      float D_ggx = alphaSq / max(3.14159 * denom * denom, 1e-4);
      float fresnelUW = 0.028 + 0.972 * pow(1.0 - max(dot(H_uw, V), 0.0), 5.0);
      float coatGlint = pow(ndh_uw, 84.0) * 0.26 * (1.0 - barnacleMask) * (1.0 - sloughPatch * 0.6);
      float rimSheen = pow(1.0 - ndv, 3.8) * 0.14 * (1.0 - barnacleMask);
      float specUW = (D_ggx * fresnelUW * specStr + coatGlint + rimSheen) * sh;

      // Cetacean Dermal & Thin Fluke-Edge Subsurface Scattering (SSS)
      float backLight = pow(clamp(dot(-V, uSunDir + N * 0.40), 0.0, 1.0), 2.6);
      float terminatorSSS = smoothstep(-0.22, 0.14, dot(N, uSunDir)) * (1.0 - smoothstep(0.14, 0.50, dot(N, uSunDir)));
      vec3 sssUW = sunIrr * (
        vec3(0.22, 0.44, 0.48) * backLight * (0.18 + 0.72 * finEdgeW) * 0.46 +
        vec3(0.22, 0.10, 0.09) * terminatorSSS * 0.18
      ) * (0.35 + 0.65 * sh) * hideOnly;

      vec3 uwRawLit = skinCol * (directUW + ambientUW) + sunIrr * (0.28 + ca * 0.78) * specUW + sssUW;

      // ---- 2. Above-Water Sunny Daytime Lighting & Glistening Wet Seawater Film ----
      float airNdl = max(dot(N, uAirSunDir), 0.0);
      vec3 airSunCol = vec3(1.26, 1.18, 1.00);
      vec3 skyHemi = mix(vec3(0.18, 0.30, 0.42), vec3(0.48, 0.70, 0.96), clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
      vec3 H_air = normalize(V + uAirSunDir);
      float wetSpecPow = mix(82.0, 220.0, eyeMask);
      float wetSpecStr = mix(0.88, 1.45, eyeMask) * (1.0 - barnacleMask * 0.7);
      float specAir = pow(max(dot(N, H_air), 0.0), wetSpecPow) * wetSpecStr;
      float skyFres = pow(1.0 - ndv, 3.0) * 0.46 * (1.0 - barnacleMask * 0.6);
      vec3 airBase = skinCol * (airSunCol * airNdl * 0.98 + skyHemi * 0.58)
        + airSunCol * specAir
        + vec3(0.48, 0.72, 0.96) * skyFres;
      float distAir = length(uCamPos - vWPos);
      vec3 airLit = mix(airBase, vec3(0.56, 0.75, 0.92), 1.0 - exp(-distAir * 0.0032));

      float airMask = smoothstep(uWaveHeight - 0.25, uWaveHeight + 0.15, vWPos.y);
      float camInAir = smoothstep(uWaveHeight - 0.02, uWaveHeight + 0.08, uCamPos.y);
      vec3 underOrThruWater = fog(mix(uwRawLit, airBase, airMask), vWPos);
      vec3 finalCol = mix(underOrThruWater, mix(underOrThruWater, airLit, airMask), camInAir);

      fragColor = vec4(finalCol, 1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sharedUniforms, ...whaleUniforms },
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
  });
  bindSharedUniforms(mat, sharedUniforms);
  mat.uniforms.uWhaleState = whaleUniforms.uWhaleState;
  mat.uniforms.uWhaleLook = whaleUniforms.uWhaleLook;
  mat.uniforms.uWhaleAge = whaleUniforms.uWhaleAge;
  return mat;
}

function createWhaleShadowMaterial(sharedUniforms, whaleUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    uniform vec4 uWhaleState;
    uniform vec2 uWhaleLook;
    ${WHALE_WAVE_GLSL}
    void main() {
      vec3 lp = whaleDeform(position, aSpineCoord, uWhaleState, uWhaleLook);
      vec4 wp = modelMatrix * vec4(lp, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;
  const fs = /* glsl */ `
    precision highp float;
    layout(location = 0) out vec4 fragColor;
    void main() { fragColor = vec4(1.0); }
  `;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sharedUniforms, ...whaleUniforms },
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 1.5,
  });
  bindSharedUniforms(mat, sharedUniforms);
  mat.uniforms.uWhaleState = whaleUniforms.uWhaleState;
  mat.uniforms.uWhaleLook = whaleUniforms.uWhaleLook;
  return mat;
}

function buildWhaleSpoutAndBubbles(sharedUniforms, maxParticles = 960) {
  const quad = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;

  const posSize = new Float32Array(maxParticles * 4);
  const meta = new Float32Array(maxParticles * 4);
  const posSizeAttr = new THREE.InstancedBufferAttribute(posSize, 4);
  posSizeAttr.setUsage(THREE.DynamicDrawUsage);
  const metaAttr = new THREE.InstancedBufferAttribute(meta, 4);
  metaAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPosSize', posSizeAttr);
  geo.setAttribute('iMeta', metaAttr);
  geo.instanceCount = 0;

  const velX = new Float32Array(maxParticles);
  const velY = new Float32Array(maxParticles);
  const velZ = new Float32Array(maxParticles);
  const age = new Float32Array(maxParticles);
  const life = new Float32Array(maxParticles);
  const initSize = new Float32Array(maxParticles);
  const growth = new Float32Array(maxParticles);
  const pType = new Float32Array(maxParticles);
  const pSeed = new Float32Array(maxParticles);
  let activeCount = 0;
  let ringCursor = 0;

  // Deterministic LCG for zero-allocation particle jitter
  let rng = 133791;
  const nextRand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 4294967296;
  };

  function spawn(px, py, pz, vx, vy, vz, size, grow, ttl, type) {
    let idxSlot = -1;
    if (activeCount < maxParticles) {
      idxSlot = activeCount++;
    } else {
      idxSlot = ringCursor;
      ringCursor = (ringCursor + 1) % maxParticles;
    }
    const o4 = idxSlot * 4;
    posSize[o4] = px;
    posSize[o4 + 1] = py;
    posSize[o4 + 2] = pz;
    posSize[o4 + 3] = size;
    meta[o4] = 1.0;
    meta[o4 + 1] = type;
    meta[o4 + 2] = nextRand() * 6.283;
    meta[o4 + 3] = 0.0;

    velX[idxSlot] = vx;
    velY[idxSlot] = vy;
    velZ[idxSlot] = vz;
    age[idxSlot] = 0.0;
    life[idxSlot] = ttl;
    initSize[idxSlot] = size;
    growth[idxSlot] = grow;
    pType[idxSlot] = type;
    pSeed[idxSlot] = meta[o4 + 2];
  }

  function update(dt, waveH) {
    let i = 0;
    while (i < activeCount) {
      age[i] += dt;
      if (age[i] >= life[i]) {
        const last = activeCount - 1;
        if (i !== last) {
          const i4 = i * 4;
          const l4 = last * 4;
          posSize[i4] = posSize[l4];
          posSize[i4 + 1] = posSize[l4 + 1];
          posSize[i4 + 2] = posSize[l4 + 2];
          posSize[i4 + 3] = posSize[l4 + 3];
          meta[i4] = meta[l4];
          meta[i4 + 1] = meta[l4 + 1];
          meta[i4 + 2] = meta[l4 + 2];
          meta[i4 + 3] = meta[l4 + 3];
          velX[i] = velX[last];
          velY[i] = velY[last];
          velZ[i] = velZ[last];
          age[i] = age[last];
          life[i] = life[last];
          initSize[i] = initSize[last];
          growth[i] = growth[last];
          pType[i] = pType[last];
          pSeed[i] = pSeed[last];
        }
        activeCount--;
        continue;
      }

      const tNorm = age[i] / life[i];
      const o4 = i * 4;
      const type = pType[i];
      if (type < 0.5) {
        // Blowhole mist / surface splash droplet in sunny coastal breeze
        const drag = Math.exp(-2.1 * dt);
        velX[i] = velX[i] * drag + 0.45 * dt;
        velZ[i] = velZ[i] * drag - 0.35 * dt;
        velY[i] = velY[i] * Math.exp(-1.55 * dt) - 1.35 * dt;
      } else {
        // Buoyant underwater vortex bubbles swirling toward surface
        const sway = Math.sin(age[i] * 5.2 + pSeed[i]) * 0.85;
        const dragW = Math.exp(-2.8 * dt);
        velX[i] = velX[i] * dragW + sway * 0.25 * dt;
        velZ[i] = velZ[i] * dragW + Math.cos(age[i] * 4.4 + pSeed[i]) * 0.25 * dt;
        velY[i] = Math.min(2.4, velY[i] + 2.2 * dt);
      }

      posSize[o4] += velX[i] * dt;
      posSize[o4 + 1] += velY[i] * dt;
      posSize[o4 + 2] += velZ[i] * dt;
      posSize[o4 + 3] = initSize[i] * (1.0 + tNorm * growth[i]);

      if (type >= 0.5 && posSize[o4 + 1] > waveH - 0.04) {
        age[i] = life[i]; // Bubble pops cleanly at ocean surface
      }

      const fadeIn = Math.min(1.0, tNorm * 6.5);
      const fadeOut = 1.0 - tNorm * tNorm;
      meta[o4] = fadeIn * fadeOut;
      meta[o4 + 3] = tNorm;
      i++;
    }

    geo.instanceCount = activeCount;
    posSizeAttr.needsUpdate = true;
    metaAttr.needsUpdate = true;
  }

  const vs = /* glsl */ `
    attribute vec4 iPosSize;
    attribute vec4 iMeta;

    ${MEDIUM_GLSL}

    out vec2 vQuad;
    out vec4 vMeta;
    out vec3 vWPos;

    void main() {
      vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 wp = iPosSize.xyz + (right * position.x + up * position.y) * iPosSize.w;

      vQuad = position.xy;
      vMeta = iMeta;
      vWPos = wp;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}

    in vec2 vQuad;
    in vec4 vMeta;
    in vec3 vWPos;

    layout(location = 0) out vec4 fragColor;

    void main() {
      float r = length(vQuad);
      if (r > 1.0) discard;

      float alphaLife = vMeta.x;
      float pType = vMeta.y;
      float seed = vMeta.z;
      float tNorm = vMeta.w;

      if (pType < 0.5) {
        // Turbulent wispy wind-sheared whale blowhole sea-spray plume (no cotton-ball circles!)
        float ang = atan(vQuad.y, vQuad.x);
        vec2 qRot = vec2(
          vQuad.x * cos(seed) - vQuad.y * sin(seed),
          vQuad.x * sin(seed) + vQuad.y * cos(seed)
        );
        float w1 = sin(qRot.x * 5.2 + seed + tNorm * 2.5) * cos(qRot.y * 4.8 - seed * 1.3);
        float w2 = sin((qRot.x + qRot.y) * 9.5 - seed * 2.1 + tNorm * 4.0);
        float w3 = cos(ang * 5.0 + seed * 1.7) * 0.18 + sin(ang * 3.0 - seed) * 0.14;
        float turb = 0.58 + 0.24 * w1 + 0.18 * w2;
        float rDistort = r / max(0.35, 0.86 + w3 + w1 * 0.16);
        float soft = pow(max(0.0, 1.0 - rDistort), 2.15) * clamp(turb * 1.35, 0.18, 1.0);
        float fineSpray = smoothstep(0.62, 0.92, 0.5 + 0.5 * sin(qRot.x * 22.0 + seed) * cos(qRot.y * 24.0 - seed)) * (1.0 - r);
        vec3 V = normalize(vWPos - uCamPos);
        float fwdSun = pow(max(dot(V, uAirSunDir), 0.0), 4.0);
        vec3 mistCol = mix(vec3(0.76, 0.89, 0.97), vec3(1.02, 0.99, 0.94), 0.55 + 0.45 * fwdSun + 0.2 * fineSpray);
        float subCull = smoothstep(uWaveHeight - 0.18, uWaveHeight + 0.12, vWPos.y);
        float a = (soft * 0.34 + fineSpray * 0.16) * alphaLife * (0.35 + 0.65 * subCull);
        if (a < 0.01) discard;
        vec3 finalMist = uCamPos.y < uWaveHeight - 0.02 ? fog(mistCol, vWPos) : mistCol;
        fragColor = vec4(finalMist, clamp(a, 0.0, 0.52));
      } else {
        // Glistening underwater vortex bubble
        float rim = smoothstep(0.42, 0.84, r) * (1.0 - smoothstep(0.86, 1.0, r));
        float glint = exp(-dot(vQuad - vec2(-0.32, 0.36), vQuad - vec2(-0.32, 0.36)) * 26.0);
        vec3 bCol = mix(vec3(0.28, 0.72, 0.86), vec3(0.92, 0.98, 1.0), clamp(rim * 0.65 + glint, 0.0, 1.0));
        float a = (rim * 0.46 + glint * 0.72 + (1.0 - r * r) * 0.08) * alphaLife;
        if (a < 0.01) discard;
        fragColor = vec4(fog(bCol, vWPos), clamp(a, 0.0, 0.80));
      }
    }
  `;

  const mat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), sharedUniforms);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;

  return { mesh, spawn, update, nextRand };
}

export class WhalePodController {
  constructor(motherMesh, motherShadowMesh, motherUniforms, calfMesh, calfShadowMesh, calfUniforms, spoutSystem, terrain, sharedUniforms) {
    this.motherMesh = motherMesh;
    this.motherShadowMesh = motherShadowMesh;
    this.motherUniforms = motherUniforms;
    this.calfMesh = calfMesh;
    this.calfShadowMesh = calfShadowMesh;
    this.calfUniforms = calfUniforms;
    this.spoutSystem = spoutSystem;
    this.terrain = terrain;
    this.sharedUniforms = sharedUniforms;

    // Horizontal pelagic cruise loop along the open main canyon & sunlit surface
    this.curve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-3.0, 0, 8.0),
        new THREE.Vector3(-6.0, 0, -14.0),
        new THREE.Vector3(-12.0, 0, -42.0),
        new THREE.Vector3(4.0, 0, -56.0),
        new THREE.Vector3(14.0, 0, -34.0),
        new THREE.Vector3(8.0, 0, -6.0),
        new THREE.Vector3(11.0, 0, 22.0),
        new THREE.Vector3(-2.0, 0, 36.0),
        new THREE.Vector3(-11.0, 0, 24.0),
      ],
      true,
      'centripetal',
      0.5
    );

    this.mU = 0.062;
    this.mTime = 19.6; // Starts in deep canyon glide right in front of Viewpoint 1 (~18m depth), then ascends to surface spout
    this.cTime = 17.6; // Calf glides alongside mother in the sunlit canyon, then surfaces & spouts
    this.mStroke = 0.0;
    this.cStroke = 1.4;
    this.mSpoutCooldown = 0.0;
    this.cSpoutCooldown = 0.0;
    this.mBubbleCooldown = 0.0;
    this.cBubbleCooldown = 0.0;

    // Preallocated scratch math objects & world-space physics joints (zero per-frame allocations)
    this.mPos = new THREE.Vector3();
    this.mHeadPos = new THREE.Vector3();
    this.mFlukePos = new THREE.Vector3();
    this.mCurvePt = new THREE.Vector3();
    this.mCurveNext = new THREE.Vector3();
    this.mHoriz = new THREE.Vector3(0, 0, -1);
    this.mHorizNext = new THREE.Vector3(0, 0, -1);
    this.cTargetPos = new THREE.Vector3();
    this.cPos = new THREE.Vector3();
    this.cHeadPos = new THREE.Vector3();
    this.cFlukePos = new THREE.Vector3();
    this.cPrevPos = new THREE.Vector3();
    this.cVelDir = new THREE.Vector3(0, 0, -1);
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.upHint = new THREE.Vector3(0, 1, 0);
    this.rotMat = new THREE.Matrix4();
    this.colGrad = new THREE.Vector3();
    this._blowLocal = new THREE.Vector3(-0.16, 0.94, 4.45);
    this._blowDirLocal = new THREE.Vector3(-0.34, 0.88, 0.33).normalize();
    this._headJointLocal = new THREE.Vector3(0.0, 0.24, 3.65);
    this._flukeLocal = new THREE.Vector3(0.0, 0.0, -4.65);
    this._wPos = new THREE.Vector3();
    this._wDir = new THREE.Vector3();
    this._lastCalfYaw = 0.0;
    this._calfSteerInit = false;
    this._jointsInit = false;
    this._prevMHeadY = 0;
    this._prevMFlukeY = 0;
    this._prevCHeadY = 0;
    this._prevCFlukeY = 0;
    this._splashCooldown = 0.0;
    this.surfaceImpulses = [];

    this.motherScale = 2.65; // True 1:1 Colossal Sperm Whale (~26.5m length, 7.7m fluke span)
    this.calfScale = 1.32;   // True 1:1 Sperm Whale Calf (~13.2m length)
    this.motherMesh.scale.setScalar(this.motherScale);
    this.motherShadowMesh.scale.setScalar(this.motherScale);
    this.calfMesh.scale.setScalar(this.calfScale);
    this.calfShadowMesh.scale.setScalar(this.calfScale);

    // Pre-warm brief spout/swim state so Frame 0 renders actively mid-spout & awake
    for (let i = 0; i < 12; i++) this.update(0.03);
    this.surfaceImpulses.length = 0;
  }

  cueSurfaceEncounter() {
    const waveH = this.sharedUniforms.uWaveHeight.value;
    if (this.mPos.y > waveH - 5.2) return;
    this.mU = 0.06;
    this.mTime = 12.2; // Active surface cruise, blow spout & approaching fluke-up lunge
    this.cTime = 10.1;
    this._calfSteerInit = false;
    this._jointsInit = false;
    for (let i = 0; i < 8; i++) this.update(0.03);
  }

  cueCanyonEncounter() {
    const waveH = this.sharedUniforms.uWaveHeight.value;
    if (this.mPos.y < waveH - 8.5) return;
    this.mU = 0.062;
    this.mTime = 19.6;
    this.cTime = 17.6;
    this._calfSteerInit = false;
    this._jointsInit = false;
    for (let i = 0; i < 8; i++) this.update(0.03);
  }

  _evalSurfaceDiveProfile(cycleTime, period, maxDiveDepth, baseSurfDepth, stateOut) {
    // Phases (normalized to Mother 26s cycle):
    // 0.00..0.52: Surface cruising & rolling breacher logging (dorsal prow & flukes slice waveH)
    // 0.52..0.75: Fluke-up sounding dive (pitch down, spine hump arch, flukes lift into air -> slap & descend)
    // 0.75..0.88: Deep canyon glide
    // 0.88..1.00: Buoyant ascent & surface breach
    const p = (cycleTime % period) / period;
    const smooth = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };

    const downStart = smooth(0.51, 0.58, p);
    const flattenBottom = smooth(0.70, 0.78, p);
    const upStart = smooth(0.87, 0.93, p);
    const levelTop = smooth(0.95, 1.00, p);

    let pitch = 0.0;
    let arch = 0.0;
    let flukeAmp = 0.85;
    let depth = 0.0;
    let spouting = false;

    if (p < 0.52) {
      const breathWave = Math.sin(cycleTime * 1.25);
      pitch = 0.11 * breathWave;
      arch = -0.18 * Math.max(0, breathWave);
      flukeAmp = 0.88 + 0.24 * Math.sin(cycleTime * 0.85);
      depth = baseSurfDepth + 0.55 * breathWave;
      const b1 = Math.abs(p - 0.10) < 0.026;
      const b2 = Math.abs(p - 0.28) < 0.026;
      const b3 = Math.abs(p - 0.46) < 0.028;
      spouting = b1 || b2 || b3;
    } else if (p < 0.75) {
      const plungeU = smooth(0.52, 0.75, p);
      pitch = -0.92 * downStart * (1.0 - flattenBottom * 0.88);
      arch = 0.78 * Math.sin(plungeU * Math.PI);
      flukeAmp = 1.05 + 0.65 * Math.sin(plungeU * Math.PI);
      depth = baseSurfDepth - maxDiveDepth * Math.pow(plungeU, 1.28);
    } else if (p < 0.88) {
      const glideU = (p - 0.75) / 0.13;
      pitch = -0.06 * (1.0 - glideU);
      arch = 0.04 * Math.sin(glideU * Math.PI);
      flukeAmp = 1.05;
      depth = baseSurfDepth - maxDiveDepth * (1.0 - 0.12 * glideU);
    } else {
      const ascU = smooth(0.88, 1.0, p);
      pitch = 0.48 * upStart * (1.0 - levelTop);
      arch = -0.24 * Math.sin(ascU * Math.PI);
      flukeAmp = 1.25 - 0.35 * levelTop;
      depth = baseSurfDepth - maxDiveDepth * 0.88 * (1.0 - ascU);
    }

    stateOut.pitch = pitch;
    stateOut.arch = arch;
    stateOut.flukeAmp = flukeAmp;
    stateOut.depth = depth;
    stateOut.spouting = spouting;
    stateOut.isDiving = p >= 0.52 && p < 0.74;
  }

  _emitSpout(mesh, scale, strength) {
    this._wPos.copy(this._blowLocal).multiplyScalar(scale).applyQuaternion(mesh.quaternion).add(mesh.position);
    this._wDir.copy(this._blowDirLocal).applyQuaternion(mesh.quaternion).normalize();
    const waveH = this.sharedUniforms.uWaveHeight.value;
    if (this._wPos.y < waveH - 0.85 * scale) return;
    const baseY = Math.max(this._wPos.y, waveH + 0.05);

    const nPuffs = 5;
    for (let i = 0; i < nPuffs; i++) {
      const r1 = this.spoutSystem.nextRand() - 0.5;
      const r2 = this.spoutSystem.nextRand() - 0.5;
      const r3 = this.spoutSystem.nextRand();
      const spd = (6.8 + r3 * 5.6) * strength;
      this.spoutSystem.spawn(
        this._wPos.x + r1 * 0.32 * strength,
        baseY + r3 * 0.25,
        this._wPos.z + r2 * 0.32 * strength,
        this._wDir.x * spd + r1 * 1.8,
        this._wDir.y * spd + (0.9 + r3 * 1.1),
        this._wDir.z * spd + r2 * 1.8,
        (0.42 + r3 * 0.36) * strength,
        4.2 + r3 * 2.5,
        1.65 + r3 * 1.05,
        0.0
      );
    }
  }

  _emitFlukeVortexAndSplash(mesh, scale, phase, flukeAmp) {
    // Account for vertical fluke stroke offset so vortex bubbles match animated tail tip!
    const waveY = Math.sin(phase - 4.6) * 0.62 * flukeAmp;
    this._wPos.set(
      (this.spoutSystem.nextRand() - 0.5) * 1.3,
      waveY,
      -4.78
    ).multiplyScalar(scale).applyQuaternion(mesh.quaternion).add(mesh.position);

    const waveH = this.sharedUniforms.uWaveHeight.value;
    if (Math.abs(this._wPos.y - waveH) < 1.15) {
      // Surface fluke slap / breach droplets
      for (let i = 0; i < 3; i++) {
        const rx = (this.spoutSystem.nextRand() - 0.5) * 2.8;
        const rz = (this.spoutSystem.nextRand() - 0.5) * 2.8;
        const ry = 2.0 + this.spoutSystem.nextRand() * 2.5;
        this.spoutSystem.spawn(
          this._wPos.x + rx * 0.35,
          waveH + 0.12,
          this._wPos.z + rz * 0.35,
          rx, ry, rz,
          0.22 * scale, 2.4, 0.95 + this.spoutSystem.nextRand() * 0.5, 0.0
        );
      }
    }
    if (this._wPos.y < waveH - 0.15) {
      // Underwater buoyant dive vortex bubbles trailing flukes
      for (let i = 0; i < 2; i++) {
        const rx = (this.spoutSystem.nextRand() - 0.5) * 1.1 * scale;
        const ry = (this.spoutSystem.nextRand() - 0.5) * 0.4;
        const rz = (this.spoutSystem.nextRand() - 0.5) * 1.1 * scale;
        this.spoutSystem.spawn(
          this._wPos.x + rx,
          this._wPos.y + ry,
          this._wPos.z + rz,
          (this.spoutSystem.nextRand() - 0.5) * 0.9,
          0.3 + this.spoutSystem.nextRand() * 0.6,
          (this.spoutSystem.nextRand() - 0.5) * 0.9,
          0.07 + this.spoutSystem.nextRand() * 0.09,
          0.65,
          2.6 + this.spoutSystem.nextRand() * 1.6,
          1.0
        );
      }
    }
  }

  _buildBasisMatrix(fwd, roll) {
    this.right.crossVectors(this.upHint.set(0, 1, 0), fwd);
    if (this.right.lengthSq() < 1e-5) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(fwd, this.right).normalize();
    if (Math.abs(roll) > 1e-4) {
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      const rx = this.right.x; const ry = this.right.y; const rz = this.right.z;
      const ux = this.up.x;    const uy = this.up.y;    const uz = this.up.z;
      this.right.set(rx * cr + ux * sr, ry * cr + uy * sr, rz * cr + uz * sr);
      this.up.set(ux * cr - rx * sr, uy * cr - ry * sr, uz * cr - rz * sr);
    }
    this.rotMat.makeBasis(this.right, this.up, fwd);
  }

  _spawnSurfaceSplash(pos, velY, radiusMeters, dropletCount) {
    const waveH = this.sharedUniforms.uWaveHeight.value;
    if (this.surfaceImpulses.length < 8) {
      // Negative downward plunge creates deep cavity followed by steep crest ring!
      const strength = Math.max(-0.55, Math.min(0.55, -velY * 0.11));
      this.surfaceImpulses.push({ x: pos.x, z: pos.z, radius: radiusMeters, strength });
    }
    const baseY = Math.max(pos.y, waveH + 0.08);
    for (let i = 0; i < dropletCount; i++) {
      const ang = this.spoutSystem.nextRand() * Math.PI * 2;
      const spdH = 1.8 + this.spoutSystem.nextRand() * 4.2;
      const vy = 2.8 + Math.abs(velY) * 0.85 + this.spoutSystem.nextRand() * 3.2;
      this.spoutSystem.spawn(
        pos.x + Math.cos(ang) * (0.4 + this.spoutSystem.nextRand() * 1.4),
        baseY + this.spoutSystem.nextRand() * 0.3,
        pos.z + Math.sin(ang) * (0.4 + this.spoutSystem.nextRand() * 1.4),
        Math.cos(ang) * spdH,
        vy,
        Math.sin(ang) * spdH,
        0.24 + this.spoutSystem.nextRand() * 0.34,
        2.0,
        0.85 + this.spoutSystem.nextRand() * 0.65,
        0.0
      );
    }
  }

  _updateWorldJoints(safeDt, mState, cState, waveH) {
    // Evaluate exact deformed local Y for head (t=0.14) and fluke blade (t=0.96, w=1.0)
    const mFlukeWaveY = Math.sin(this.mStroke - 0.96 * 4.6) * 0.64 * mState.flukeAmp - mState.arch * ((0.96 - 0.38) * (0.96 - 0.38) - 0.14) * 2.4;
    const cFlukeWaveY = Math.sin(this.cStroke - 0.96 * 4.6) * 0.64 * cState.flukeAmp - cState.arch * ((0.96 - 0.38) * (0.96 - 0.38) - 0.14) * 2.4;

    this.mHeadPos.copy(this._headJointLocal).multiplyScalar(this.motherScale).applyQuaternion(this.motherMesh.quaternion).add(this.motherMesh.position);
    this.mFlukePos.set(0.0, mFlukeWaveY, -4.65).multiplyScalar(this.motherScale).applyQuaternion(this.motherMesh.quaternion).add(this.motherMesh.position);
    this.cHeadPos.copy(this._headJointLocal).multiplyScalar(this.calfScale).applyQuaternion(this.calfMesh.quaternion).add(this.calfMesh.position);
    this.cFlukePos.set(0.0, cFlukeWaveY, -4.65).multiplyScalar(this.calfScale).applyQuaternion(this.calfMesh.quaternion).add(this.calfMesh.position);

    if (!this._jointsInit) {
      this._prevMHeadY = this.mHeadPos.y;
      this._prevMFlukeY = this.mFlukePos.y;
      this._prevCHeadY = this.cHeadPos.y;
      this._prevCFlukeY = this.cFlukePos.y;
      this._jointsInit = true;
      return;
    }

    const invDt = 1.0 / Math.max(safeDt, 0.004);
    const mHeadVy = (this.mHeadPos.y - this._prevMHeadY) * invDt;
    const mFlukeVy = (this.mFlukePos.y - this._prevMFlukeY) * invDt;
    const cFlukeVy = (this.cFlukePos.y - this._prevCFlukeY) * invDt;

    this._splashCooldown -= safeDt;
    if (this._splashCooldown <= 0.0) {
      if (Math.abs(this.mFlukePos.y - waveH) < 2.2 && Math.abs(mFlukeVy) > 1.2) {
        this._spawnSurfaceSplash(this.mFlukePos, mFlukeVy, 5.2, 6);
        this._splashCooldown = 0.10;
      } else if (Math.abs(this.mHeadPos.y - waveH) < 2.4 && Math.abs(mHeadVy) > 0.75) {
        this._spawnSurfaceSplash(this.mHeadPos, mHeadVy, 4.8, 4);
        this._splashCooldown = 0.14;
      } else if (Math.abs(this.cFlukePos.y - waveH) < 1.5 && Math.abs(cFlukeVy) > 1.0) {
        this._spawnSurfaceSplash(this.cFlukePos, cFlukeVy, 3.0, 4);
        this._splashCooldown = 0.12;
      }
    }

    this._prevMHeadY = this.mHeadPos.y;
    this._prevMFlukeY = this.mFlukePos.y;
    this._prevCHeadY = this.cHeadPos.y;
    this._prevCFlukeY = this.cFlukePos.y;
  }

  update(dt, camPos = null) {
    const safeDt = Math.min(dt, 0.05);
    this.mTime += safeDt;
    this.cTime += safeDt;

    // 1. Mother Sperm Whale autonomous speed & cycle (slower while logging/spouting, faster while diving)
    const mState = this._mState || (this._mState = { pitch: 0, arch: 0, flukeAmp: 0.85, depth: -1.52, spouting: false, isDiving: false });
    this._evalSurfaceDiveProfile(this.mTime, 26.0, 18.0, -1.52, mState);
    const mCurveSpeed = mState.isDiving ? 0.0155 : 0.0115;
    this.mU = (this.mU + safeDt * mCurveSpeed) % 1.0;

    this.curve.getPointAt(this.mU, this.mCurvePt);
    this.curve.getPointAt((this.mU + 0.014) % 1.0, this.mCurveNext);
    this.mHoriz.subVectors(this.mCurveNext, this.mCurvePt).setY(0).normalize();

    this.curve.getPointAt((this.mU + 0.032) % 1.0, this.mCurveNext);
    this.mHorizNext.subVectors(this.mCurveNext, this.mCurvePt).setY(0).normalize();
    const mYawRate = (this.mHoriz.x * this.mHorizNext.z - this.mHoriz.z * this.mHorizNext.x);

    const waveH = this.sharedUniforms.uWaveHeight.value;
    this.mPos.set(this.mCurvePt.x, waveH + mState.depth, this.mCurvePt.z);

    // Terrain collision guard (never push surfacing whales upward into air)
    const mClear = this.terrain.dw(this.mPos.x, this.mPos.y, this.mPos.z);
    if (mClear > -4.8) {
      this.terrain.grad(this.mPos.x, this.mPos.y, this.mPos.z, this.colGrad);
      const push = mClear + 4.8;
      this.mPos.x += this.colGrad.x * push;
      this.mPos.z += this.colGrad.z * push;
      this.mPos.y = Math.min(waveH - 1.2, this.mPos.y + this.colGrad.y * push);
    }

    const cpM = Math.cos(mState.pitch);
    this.fwd.set(this.mHoriz.x * cpM, Math.sin(mState.pitch), this.mHoriz.z * cpM).normalize();
    this._buildBasisMatrix(this.fwd, mYawRate * 0.55);

    this.motherMesh.quaternion.setFromRotationMatrix(this.rotMat);
    this.motherMesh.position.copy(this.mPos);
    this.motherShadowMesh.quaternion.copy(this.motherMesh.quaternion);
    this.motherShadowMesh.position.copy(this.mPos);

    this.mStroke += safeDt * (1.85 + mState.flukeAmp * 1.20);
    this.motherUniforms.uWhaleState.value.set(
      this.mStroke,
      mState.arch,
      Math.max(-0.45, Math.min(0.45, mYawRate * 1.8)),
      mState.flukeAmp
    );

    // Mother Whale curiosity look-at toward nearby diver (within 32m, ahead or beside head)
    let targetLookX = 0.0;
    let targetLookY = 0.0;
    if (camPos) {
      const dx = camPos.x - this.mPos.x;
      const dy = camPos.y - this.mPos.y;
      const dz = camPos.z - this.mPos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1.5 && dist < 32.0) {
        const invD = 1.0 / dist;
        const nx = dx * invD;
        const ny = dy * invD;
        const nz = dz * invD;
        const fwdDot = nx * this.fwd.x + ny * this.fwd.y + nz * this.fwd.z;
        if (fwdDot > -0.35) {
          const prox = Math.max(0.0, Math.min(1.0, (32.0 - dist) / 22.0));
          const rightDot = nx * this.right.x + ny * this.right.y + nz * this.right.z;
          const upDot = nx * this.up.x + ny * this.up.y + nz * this.up.z;
          targetLookX = Math.max(-0.28, Math.min(0.28, rightDot * 0.42)) * prox;
          targetLookY = Math.max(-0.18, Math.min(0.18, upDot * 0.30)) * prox;
        }
      }
    }
    const lookAlpha = 1.0 - Math.exp(-safeDt * 2.2);
    this.motherUniforms.uWhaleLook.value.x += (targetLookX - this.motherUniforms.uWhaleLook.value.x) * lookAlpha;
    this.motherUniforms.uWhaleLook.value.y += (targetLookY - this.motherUniforms.uWhaleLook.value.y) * lookAlpha;

    // 2. Calf Sperm Whale: Independent 23.5s Cycle + Bonded Pod Cohesion Steering
    const cState = this._cState || (this._cState = { pitch: 0, arch: 0, flukeAmp: 0.85, depth: -0.92, spouting: false, isDiving: false });
    this._evalSurfaceDiveProfile(this.cTime, 23.5, 11.8, -0.92, cState);

    const sideWeave = 6.2 + Math.sin(this.cTime * 0.42) * 2.2;
    const foreLag = -2.2 + Math.cos(this.cTime * 0.29) * 3.2;
    const calfYawOffset = Math.sin(this.cTime * 0.51) * 0.14;

    // Right perpendicular in XZ to Mother's heading
    const mRightX = -this.mHoriz.z;
    const mRightZ = this.mHoriz.x;
    this.cTargetPos.set(
      this.mCurvePt.x + mRightX * sideWeave + this.mHoriz.x * foreLag,
      waveH + cState.depth,
      this.mCurvePt.z + mRightZ * sideWeave + this.mHoriz.z * foreLag
    );

    const cClear = this.terrain.dw(this.cTargetPos.x, this.cTargetPos.y, this.cTargetPos.z);
    if (cClear > -3.2) {
      this.terrain.grad(this.cTargetPos.x, this.cTargetPos.y, this.cTargetPos.z, this.colGrad);
      const pushC = cClear + 3.2;
      this.cTargetPos.x += this.colGrad.x * pushC;
      this.cTargetPos.z += this.colGrad.z * pushC;
      this.cTargetPos.y = Math.min(waveH - 0.85, this.cTargetPos.y + this.colGrad.y * pushC);
    }

    if (!this._calfSteerInit) {
      this.cPos.copy(this.cTargetPos);
      this.cPrevPos.copy(this.cTargetPos).addScaledVector(this.mHoriz, -0.1);
      this._calfSteerInit = true;
    } else {
      this.cPrevPos.copy(this.cPos);
      const followAlpha = 1.0 - Math.exp(-safeDt * 1.85);
      this.cPos.lerp(this.cTargetPos, followAlpha);
    }

    // Calf horizontal heading derives from its own velocity + subtle playful wander
    const dxC = this.cPos.x - this.cPrevPos.x;
    const dzC = this.cPos.z - this.cPrevPos.z;
    if (dxC * dxC + dzC * dzC > 1e-6) {
      this.cVelDir.set(dxC, 0, dzC).normalize();
      this.cVelDir.lerp(this.mHoriz, 0.28).normalize();
    } else {
      this.cVelDir.copy(this.mHoriz);
    }

    // Apply Calf's subtle playful heading offset & own dive pitch
    const cy = Math.cos(calfYawOffset);
    const sy = Math.sin(calfYawOffset);
    const chx = this.cVelDir.x * cy - this.cVelDir.z * sy;
    const chz = this.cVelDir.x * sy + this.cVelDir.z * cy;
    const cpC = Math.cos(cState.pitch);
    this.fwd.set(chx * cpC, Math.sin(cState.pitch), chz * cpC).normalize();

    const cYawRate = chx * this.mHoriz.z - chz * this.mHoriz.x;
    const cYawDelta = cYawRate - this._lastCalfYaw;
    this._lastCalfYaw = cYawRate;
    this._buildBasisMatrix(this.fwd, cYawRate * 0.45 + cYawDelta * 1.2);

    this.calfMesh.quaternion.setFromRotationMatrix(this.rotMat);
    this.calfMesh.position.copy(this.cPos);
    this.calfShadowMesh.quaternion.copy(this.calfMesh.quaternion);
    this.calfShadowMesh.position.copy(this.cPos);

    this.cStroke += safeDt * (2.65 + cState.flukeAmp * 1.55);
    this.calfUniforms.uWhaleState.value.set(
      this.cStroke,
      cState.arch,
      Math.max(-0.5, Math.min(0.5, cYawRate * 2.2)),
      cState.flukeAmp
    );

    // 3. Expose Real Multi-Section World Joints & Drive Ocean Surface Wakes (uWhaleWake0, uWhaleWake1)
    this._updateWorldJoints(safeDt, mState, cState, waveH);
    const mSurfProx = Math.max(0, 1.0 - Math.max(0, Math.abs(this.mPos.y - waveH) - 1.8) / 4.2);
    const cSurfProx = Math.max(0, 1.0 - Math.max(0, Math.abs(this.cPos.y - waveH) - 1.4) / 3.4);
    this.sharedUniforms.uWhaleWake0.value.set(this.mFlukePos.x, 0, this.mFlukePos.z, mSurfProx);
    this.sharedUniforms.uWhaleWake1.value.set(this.cFlukePos.x, 0, this.cFlukePos.z, cSurfProx * 0.75);
    this.sharedUniforms.uWhalePhase.value = this.mStroke;

    // 4. Emit Blowhole Spouts & Fluke Dive Vortex Bubbles
    this.mSpoutCooldown -= safeDt;
    if (mState.spouting && this.mSpoutCooldown <= 0) {
      this._emitSpout(this.motherMesh, this.motherScale, 1.05);
      this.mSpoutCooldown = 0.055;
    }
    this.cSpoutCooldown -= safeDt;
    if (cState.spouting && this.cSpoutCooldown <= 0) {
      this._emitSpout(this.calfMesh, this.calfScale, 0.72);
      this.cSpoutCooldown = 0.065;
    }

    this.mBubbleCooldown -= safeDt;
    if (this.mBubbleCooldown <= 0) {
      this._emitFlukeVortexAndSplash(this.motherMesh, this.motherScale, this.mStroke, mState.flukeAmp);
      this.mBubbleCooldown = mState.isDiving ? 0.055 : 0.14;
    }
    this.cBubbleCooldown -= safeDt;
    if (this.cBubbleCooldown <= 0) {
      this._emitFlukeVortexAndSplash(this.calfMesh, this.calfScale, this.cStroke, cState.flukeAmp);
      this.cBubbleCooldown = cState.isDiving ? 0.065 : 0.16;
    }

    this.spoutSystem.update(safeDt, waveH);
  }
}

export function createWhalePodRig(terrain, sharedUniforms) {
  const whaleGeo = buildSpermWhaleGeometry();
  const motherUniforms = {
    uWhaleState: { value: new THREE.Vector4(0, 0, 0, 1.0) },
    uWhaleLook: { value: new THREE.Vector2(0, 0) },
    uWhaleAge: { value: 1.0 },
  };
  const calfUniforms = {
    uWhaleState: { value: new THREE.Vector4(0, 0, 0, 1.0) },
    uWhaleLook: { value: new THREE.Vector2(0, 0) },
    uWhaleAge: { value: 0.28 },
  };

  const motherMat = createWhaleMaterial(sharedUniforms, motherUniforms);
  const motherShadowMat = createWhaleShadowMaterial(sharedUniforms, motherUniforms);
  const calfMat = createWhaleMaterial(sharedUniforms, calfUniforms);
  const calfShadowMat = createWhaleShadowMaterial(sharedUniforms, calfUniforms);

  const motherMesh = new THREE.Mesh(whaleGeo, motherMat);
  motherMesh.frustumCulled = false;
  const motherShadowMesh = new THREE.Mesh(whaleGeo, motherShadowMat);
  motherShadowMesh.frustumCulled = false;

  const calfMesh = new THREE.Mesh(whaleGeo, calfMat);
  calfMesh.frustumCulled = false;
  const calfShadowMesh = new THREE.Mesh(whaleGeo, calfShadowMat);
  calfShadowMesh.frustumCulled = false;

  const spoutSystem = buildWhaleSpoutAndBubbles(sharedUniforms, 960);

  const controller = new WhalePodController(
    motherMesh,
    motherShadowMesh,
    motherUniforms,
    calfMesh,
    calfShadowMesh,
    calfUniforms,
    spoutSystem,
    terrain,
    sharedUniforms
  );

  return {
    motherMesh,
    motherShadowMesh,
    calfMesh,
    calfShadowMesh,
    effectsMesh: spoutSystem.mesh,
    controller,
  };
}

export function createSharkRig(terrain, sharedUniforms) {
  const sharkGeo = buildAnatomicalSharkGeometry();
  const sharkUniforms = {
    uSharkLook: { value: new THREE.Vector2(0, 0) },
  };
  const sharkMat = createSharkMaterial(sharedUniforms, sharkUniforms);
  const sharkShadowMat = createSharkShadowMaterial(sharedUniforms, sharkUniforms);

  const sharkMesh = new THREE.Mesh(sharkGeo, sharkMat);
  sharkMesh.frustumCulled = false;

  const sharkShadowMesh = new THREE.Mesh(sharkGeo, sharkShadowMat);
  sharkShadowMesh.frustumCulled = false;

  const controller = new SharkController(sharkMesh, sharkShadowMesh, sharkUniforms, terrain, sharedUniforms);

  return {
    sharkMesh,
    sharkShadowMesh,
    controller,
  };
}

function buildSeabirdGeometry() {
  const pos = [];
  const uv = [];
  const birdMeta = []; // vec3(wingSpanNorm [0..1], partId [0=plumage,1=darkTip,2=beak], chordU)
  const idx = [];

  function pushBV(x, y, z, u, v, wingW, part = 0) {
    const id = pos.length / 3;
    pos.push(x, y, z);
    uv.push(u, v);
    birdMeta.push(wingW, part, u);
    return id;
  }

  // Streamlined gull body + fanned tail (+0.42 head -> -0.46 tail)
  const bLen = 12;
  const bRad = 10;
  const rings = [];
  for (let i = 0; i <= bLen; i++) {
    const t = i / bLen;
    const z = 0.42 - t * 0.88;
    let rx, ry, cy;
    if (t < 0.20) {
      const u = t / 0.20;
      const b = Math.pow(Math.max(0.02, u), 0.55);
      rx = 0.068 * b;
      ry = 0.062 * b;
      cy = 0.032 - (1.0 - b) * 0.015;
    } else if (t < 0.72) {
      const u = (t - 0.20) / 0.52;
      const w = Math.sin(u * Math.PI * 0.82);
      rx = 0.068 + w * 0.036;
      ry = 0.062 + w * 0.030;
      cy = 0.032 * (1.0 - u);
    } else {
      // Flattened wedge tail fan
      const u = (t - 0.72) / 0.28;
      rx = 0.058 + u * 0.092;
      ry = Math.max(0.010, 0.050 * (1.0 - u * 0.82));
      cy = 0.005 * (1.0 - u);
    }
    const ring = [];
    const part = t > 0.85 ? 1 : 0;
    for (let s = 0; s < bRad; s++) {
      const a = (s / bRad) * Math.PI * 2;
      ring.push(pushBV(Math.sin(a) * rx, cy + Math.cos(a) * ry, z, t, s / bRad, 0.0, part));
    }
    rings.push(ring);
  }
  for (let i = 0; i < bLen; i++) {
    for (let s = 0; s < bRad; s++) {
      const ns = (s + 1) % bRad;
      idx.push(rings[i][s], rings[i][ns], rings[i + 1][ns], rings[i][s], rings[i + 1][ns], rings[i + 1][s]);
    }
  }
  const headTip = pushBV(0, 0.028, 0.44, 0, 0.5, 0, 0);
  for (let s = 0; s < bRad; s++) {
    const ns = (s + 1) % bRad;
    idx.push(headTip, rings[0][ns], rings[0][s]);
  }
  const tailCap = pushBV(0, 0.0, -0.47, 1, 0.5, 0, 1);
  for (let s = 0; s < bRad; s++) {
    const ns = (s + 1) % bRad;
    idx.push(tailCap, rings[bLen][s], rings[bLen][ns]);
  }

  // Sharp golden-amber gull beak (+0.42 -> +0.58)
  const beakR = [];
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2 + Math.PI * 0.25;
    beakR.push(pushBV(Math.sin(a) * 0.024, 0.028 + Math.cos(a) * 0.022, 0.42, 0.05, s / 4, 0, 2));
  }
  const beakTip = pushBV(0, 0.014, 0.58, 0.0, 0.5, 0, 2);
  for (let s = 0; s < 4; s++) {
    const ns = (s + 1) % 4;
    idx.push(beakTip, beakR[ns], beakR[s]);
  }

  // Swept Gull/Albatross Cambered Wings (spanning x = +/-0.72m)
  for (const side of [-1, 1]) {
    const rows = 10;
    const cols = 6;
    const tGrid = [];
    const bGrid = [];
    for (let ir = 0; ir <= rows; ir++) {
      const u = ir / rows;
      const x = side * (0.04 + u * 0.68);
      // Gull wrist sweeps forward to u=0.40 then tapers smoothly back to pointed primary tips
      const zCenter = u < 0.40 ? 0.10 + (u / 0.40) * 0.09 : 0.19 - ((u - 0.40) / 0.60) * 0.34;
      const chord = 0.24 * (1.0 - Math.pow(Math.max(0.0, u), 1.45) * 0.76);
      const gullLift = Math.sin(u * Math.PI * 0.85) * 0.055;
      const thick = 0.024 * (1.0 - u * 0.85) + 0.004;
      const rTop = [];
      const rBot = [];
      for (let ic = 0; ic <= cols; ic++) {
        const v = ic / cols;
        const z = zCenter + (0.5 - v) * chord;
        const prof = Math.sin(v * Math.PI);
        const isDark = u > 0.62 ? 1.0 : 0.0;
        rTop.push(pushBV(x, 0.03 + gullLift + thick * prof, z, u, v, u, isDark));
        rBot.push(pushBV(x, 0.03 + gullLift - thick * prof * 0.45, z, u, v, u, isDark));
      }
      tGrid.push(rTop);
      bGrid.push(rBot);
    }
    for (let ir = 0; ir < rows; ir++) {
      for (let ic = 0; ic < cols; ic++) {
        if (side > 0) {
          idx.push(tGrid[ir][ic], tGrid[ir + 1][ic + 1], tGrid[ir][ic + 1], tGrid[ir][ic], tGrid[ir + 1][ic], tGrid[ir + 1][ic + 1]);
          idx.push(bGrid[ir][ic], bGrid[ir][ic + 1], bGrid[ir + 1][ic + 1], bGrid[ir][ic], bGrid[ir + 1][ic + 1], bGrid[ir + 1][ic]);
        } else {
          idx.push(tGrid[ir][ic], tGrid[ir][ic + 1], tGrid[ir + 1][ic + 1], tGrid[ir][ic], tGrid[ir + 1][ic + 1], tGrid[ir + 1][ic]);
          idx.push(bGrid[ir][ic], bGrid[ir + 1][ic + 1], bGrid[ir][ic + 1], bGrid[ir][ic], bGrid[ir + 1][ic], bGrid[ir + 1][ic + 1]);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aBirdMeta', new THREE.Float32BufferAttribute(birdMeta, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function buildSeabirds(sharedUniforms, nBirds = 48) {
  rseed(91873);
  const baseGeo = buildSeabirdGeometry();
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = baseGeo.index;
  instGeo.attributes.position = baseGeo.attributes.position;
  instGeo.attributes.normal = baseGeo.attributes.normal;
  instGeo.attributes.uv = baseGeo.attributes.uv;
  instGeo.attributes.aBirdMeta = baseGeo.attributes.aBirdMeta;
  instGeo.instanceCount = nBirds;

  const orbitArr = new Float32Array(nBirds * 4);
  const flightArr = new Float32Array(nBirds * 4);
  const styleArr = new Float32Array(nBirds * 4);

  for (let i = 0; i < nBirds; i++) {
    const cx = rr(-18, 18);
    const cz = rr(-18, 14);
    const rx = rr(12, 44);
    const rz = rr(12, 42);
    orbitArr[i * 4] = cx;
    orbitArr[i * 4 + 1] = cz;
    orbitArr[i * 4 + 2] = rx;
    orbitArr[i * 4 + 3] = rz;

    const dir = rnd() > 0.45 ? 1.0 : -1.0;
    const angSpd = dir * rr(0.11, 0.25);
    const baseAlt = i < 20 ? rr(6.5, 13.5) : rr(13.5, 25.5); // Low wave-skimmers + high soarers
    flightArr[i * 4] = rr(0, Math.PI * 2);
    flightArr[i * 4 + 1] = angSpd;
    flightArr[i * 4 + 2] = baseAlt;
    flightArr[i * 4 + 3] = rr(4.8, 7.6);

    styleArr[i * 4] = rr(0.90, 1.48);
    styleArr[i * 4 + 1] = rnd();
    styleArr[i * 4 + 2] = rr(0.8, 2.4);
    styleArr[i * 4 + 3] = rr(0.0, 1.0);
  }

  instGeo.setAttribute('iOrbit', new THREE.InstancedBufferAttribute(orbitArr, 4));
  instGeo.setAttribute('iFlight', new THREE.InstancedBufferAttribute(flightArr, 4));
  instGeo.setAttribute('iBirdStyle', new THREE.InstancedBufferAttribute(styleArr, 4));

  const birdVs = /* glsl */ `
    attribute vec3 aBirdMeta;
    attribute vec4 iOrbit;
    attribute vec4 iFlight;
    attribute vec4 iBirdStyle;

    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out float vWing;
    out float vPart;

    vec3 birdOrbitPos(float t, vec4 orb, vec4 flt, vec4 sty) {
      float ang = flt.x + t * flt.y;
      float x = orb.x + cos(ang) * orb.z;
      float z = orb.y + sin(ang) * orb.w;
      float y = flt.z + sin(ang * 2.0 + sty.y * 6.283) * sty.z;
      return vec3(x, y, z);
    }

    void main() {
      float t = uTime;
      vec3 p0 = birdOrbitPos(t, iOrbit, iFlight, iBirdStyle);
      vec3 pNext = birdOrbitPos(t + 0.08, iOrbit, iFlight, iBirdStyle);
      vec3 pPrev = birdOrbitPos(t - 0.08, iOrbit, iFlight, iBirdStyle);

      vec3 fwd = normalize(pNext - pPrev);
      vec3 horiz0 = normalize(vec3(pNext.x - p0.x, 0.0, pNext.z - p0.z));
      vec3 horiz1 = normalize(vec3(p0.x - pPrev.x, 0.0, p0.z - pPrev.z));
      float yawRate = (horiz0.x * horiz1.z - horiz0.z * horiz1.x);
      float bank = clamp(yawRate * 14.0, -0.52, 0.52);

      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
      vec3 up = normalize(cross(fwd, right));
      float cb = cos(bank);
      float sb = sin(bank);
      vec3 rBank = right * cb + up * sb;
      vec3 uBank = up * cb - right * sb;

      // Alternate between crisp wingbeats & locked dihedral soaring glides
      float glideCycle = sin(t * 0.42 + iBirdStyle.y * 6.283 + iBirdStyle.w * 3.14);
      float flapEnv = smoothstep(-0.18, 0.42, glideCycle);
      float flapPh = t * iFlight.w + iBirdStyle.y * 6.283;
      float w = aBirdMeta.x;
      float beat = (sin(flapPh - w * 2.15) * 0.34 + 0.04) * flapEnv + 0.065 * (1.0 - flapEnv);

      vec3 lp = position;
      lp.y += beat * w;
      vec3 ln = normalize(normal + vec3(-sign(position.x) * beat * 0.65, 0.0, 0.0) * w);

      float s = iBirdStyle.x;
      vec3 wp = p0 + (rBank * lp.x + uBank * lp.y + fwd * lp.z) * s;
      vec3 wn = normalize(rBank * ln.x + uBank * ln.y + fwd * ln.z);

      vWPos = wp;
      vWNorm = wn;
      vWing = w;
      vPart = aBirdMeta.y;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const birdFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in float vWing;
    in float vPart;

    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 N = normalize(vWNorm);
      vec3 V = normalize(uCamPos - vWPos);

      // Pearl-white underbelly, cool silver-grey upper mantle, dark primary tips, amber beak
      vec3 underWhite = vec3(0.95, 0.96, 0.98);
      vec3 backGrey = vec3(0.62, 0.69, 0.77);
      vec3 col = mix(underWhite, backGrey, smoothstep(-0.1, 0.65, N.y) * 0.85);
      float tipMask = smoothstep(0.65, 1.05, vPart) * (1.0 - smoothstep(1.4, 1.8, vPart));
      col = mix(col, vec3(0.11, 0.13, 0.16), tipMask);
      float beakMask = smoothstep(1.6, 2.0, vPart);
      col = mix(col, vec3(0.95, 0.68, 0.16), beakMask);

      float ndl = max(dot(N, uAirSunDir), 0.0);
      float wingSSS = vWing * pow(max(dot(V, -uAirSunDir), 0.0), 3.0) * 0.48;
      vec3 sunIrr = vec3(1.25, 1.18, 1.02);
      vec3 skyAmb = vec3(0.36, 0.56, 0.84) * (0.45 + 0.55 * clamp(N.y, 0.0, 1.0));
      vec3 oceanBounce = vec3(0.12, 0.30, 0.48) * max(-N.y, 0.0);
      vec3 lit = col * (sunIrr * (ndl + wingSSS) + skyAmb + oceanBounce);

      // Atmospheric coastal haze into sunny sky blue
      float dAir = length(uCamPos - vWPos);
      vec3 skyHaze = vec3(0.56, 0.76, 0.94);
      lit = mix(lit, skyHaze, 1.0 - exp(-dAir * 0.0028));

      // Viewed from underwater through Snell window -> water column attenuation
      if (uCamPos.y < uWaveHeight - 0.04) {
        lit = fog(lit, vWPos);
      }

      fragColor = vec4(lit, 1.0);
    }
  `;

  const mat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: birdVs,
    fragmentShader: birdFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  }), sharedUniforms);

  const mesh = new THREE.Mesh(instGeo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ============================================================================
// GTA-6-Grade Anatomical Green Sea Turtle (Chelonia mydas)
// High-Res Heart-Shaped Carapace (36x36) with Flared Scalloped Marginal Rim +
// Sculpted Scute Cushions & Vertebral Keel + Sculpted Plastron +
// Reptilian Cranium with Hooked Horny Beak, Nostrils & Wrinkled Neck +
// Watertight Auto-Outward-Wound Hydrofoil Fore-Flippers (with Anterior Scale Ridge & Claw Nub) +
// Steering Hind Flippers + Disconnected Glossy Reptilian Eyes + 3D Turtle Barnacles (Chelonibia)
// ============================================================================
function buildSeaTurtleGeometry() {
  const pos = [];
  // Continuous weights: x = edgeThin/rim, y = plastronMask, z = headNeckMask, w = partGroup (0=shell, 1=head, 2=leftFlip, 3=rightFlip, 4=hind/tail, 5=eye, 6=barnacle)
  const matW = [];
  const idx = [];

  function pushTV(x, y, z, edge = 0, plast = 0, neck = 0, grp = 0) {
    const id = pos.length / 3;
    pos.push(x, y, z);
    matW.push(edge, plast, neck, grp);
    return id;
  }

  function ensureTurtleOutward(startIdx) {
    let vol6 = 0;
    let cx = 0, cy = 0, cz = 0, cnt = 0;
    for (let k = startIdx; k < idx.length; k += 3) {
      const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
      cx += pos[i0] + pos[i1] + pos[i2];
      cy += pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1];
      cz += pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2];
      cnt += 3;
    }
    if (!cnt) return;
    cx /= cnt; cy /= cnt; cz /= cnt;
    for (let k = startIdx; k < idx.length; k += 3) {
      const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
      const ax = pos[i0] - cx, ay = pos[i0 + 1] - cy, az = pos[i0 + 2] - cz;
      const bx = pos[i1] - cx, by = pos[i1 + 1] - cy, bz = pos[i1 + 2] - cz;
      const dx = pos[i2] - cx, dy = pos[i2 + 1] - cy, dz = pos[i2 + 2] - cz;
      vol6 += ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx);
    }
    if (vol6 < 0) {
      for (let k = startIdx; k < idx.length; k += 3) {
        const tmp = idx[k + 1];
        idx[k + 1] = idx[k + 2];
        idx[k + 2] = tmp;
      }
    }
  }

  // ---- 1. Sculpted Heart-Shaped Carapace (with Flared Scalloped Rim & Scute Cushions) + Plastron ----
  {
    const shellStart = idx.length;
    const nU = 34;
    const nV = 36;
    const shellRings = [];
    for (let i = 0; i <= nU; i++) {
      const u = i / nU; // 0 = pointed rear pygal tip (-0.94) -> 1 = broad anterior nuchal notch (+0.84)
      const z = -0.94 + u * 1.78;
      // Classic Chelonia mydas heart-shaped taper (broad across mid-anterior shoulders, tapered posteriorly)
      const wBase = Math.sin(Math.pow(u, 0.72) * Math.PI);
      const rx = 0.67 * Math.pow(Math.max(0.014, wBase), 0.76);
      const domeH = 0.31 * Math.pow(Math.max(0.01, Math.sin(u * Math.PI)), 0.70);
      // Subtle scalloped marginal rim wave along lateral shell skirt
      const marginalScallop = 1.0 + 0.018 * Math.sin(u * Math.PI * 11.0) * Math.sin(u * Math.PI);

      const ring = [];
      for (let j = 0; j < nV; j++) {
        const a = (j / nV) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Flared overhanging marginal skirt right around equator (sa near 0)
        const rimFlare = Math.exp(-Math.pow((sa - 0.05) / 0.16, 2.0)) * 0.055 * Math.sin(u * Math.PI);
        let x = ca * (rx * marginalScallop + rimFlare);
        let y;
        let plastW = 0.0;
        let edgeW = Math.exp(-Math.pow((sa - 0.04) / 0.18, 2.0));

        if (sa >= 0) {
          // Domed carapace + subtle vertebral keel + 5 vertebral & 4 costal pillow cushions
          const keel = Math.exp(-Math.pow(ca / 0.22, 2.0)) * 0.022 * Math.sin(u * Math.PI);
          const vScute = Math.sin(u * Math.PI * 5.0) * 0.008 * Math.exp(-Math.pow(ca / 0.32, 2.0));
          const cScute = Math.sin(u * Math.PI * 4.0 + 0.4) * 0.007 * Math.exp(-Math.pow((Math.abs(ca) - 0.56) / 0.24, 2.0));
          y = Math.pow(sa, 0.78) * domeH + 0.018 + (keel + vScute + cScute) * Math.sin(u * Math.PI);
        } else {
          // Flattened plastron belly inset slightly inside the marginal carapace overhang
          const inset = 1.0 - Math.min(1.0, -sa * 1.4) * 0.11;
          x *= inset;
          y = sa * 0.115 - 0.025;
          plastW = Math.min(1.0, Math.max(0.0, (-sa - 0.06) / 0.28));
        }
        ring.push(pushTV(x, y, z, edgeW, plastW, 0, 0));
      }
      shellRings.push(ring);
    }
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        const jn = (j + 1) % nV;
        idx.push(shellRings[i][j], shellRings[i][jn], shellRings[i + 1][jn], shellRings[i][j], shellRings[i + 1][jn], shellRings[i + 1][j]);
      }
    }
    // Cap rear & front shell tips cleanly
    const rearTip = pushTV(0, 0.0, -0.96, 1.0, 0.0, 0, 0);
    const frontTip = pushTV(0, 0.02, 0.86, 1.0, 0.0, 0, 0);
    for (let j = 0; j < nV; j++) {
      const jn = (j + 1) % nV;
      idx.push(rearTip, shellRings[0][jn], shellRings[0][j]);
      idx.push(frontTip, shellRings[nU][j], shellRings[nU][jn]);
    }
    ensureTurtleOutward(shellStart);
  }

  // ---- 2. Sculpted Reptilian Head, Wrinkled Neck Collar, Brow Eyelids & Hooked Beak (grp = 1) ----
  {
    const headStart = idx.length;
    const hSegs = 20;
    const hSpecs = [
      { z: 0.56, y: 0.015, rx: 0.165, ry: 0.125, neck: 1.0, wrinkle: 0.012 },
      { z: 0.68, y: 0.028, rx: 0.148, ry: 0.112, neck: 0.9, wrinkle: -0.010 },
      { z: 0.79, y: 0.042, rx: 0.138, ry: 0.106, neck: 0.7, wrinkle: 0.011 },
      { z: 0.89, y: 0.056, rx: 0.146, ry: 0.118, neck: 0.35, wrinkle: 0.0 },
      { z: 1.00, y: 0.068, rx: 0.162, ry: 0.132, neck: 0.0, wrinkle: 0.0 }, // broad temporal skull
      { z: 1.11, y: 0.066, rx: 0.148, ry: 0.122, neck: 0.0, wrinkle: 0.0 }, // orbital brow
      { z: 1.21, y: 0.048, rx: 0.112, ry: 0.095, neck: 0.0, wrinkle: 0.0 }, // snout taper
      { z: 1.29, y: 0.026, rx: 0.064, ry: 0.058, neck: 0.0, wrinkle: 0.0 }, // horny beak tip
      { z: 1.33, y: 0.012, rx: 0.016, ry: 0.016, neck: 0.0, wrinkle: 0.0 },
    ];
    const hRings = [];
    for (let hi = 0; hi < hSpecs.length; hi++) {
      const hs = hSpecs[hi];
      const ring = [];
      for (let j = 0; j < hSegs; j++) {
        const a = (j / hSegs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        let rx = hs.rx + hs.wrinkle;
        let ry = hs.ry + hs.wrinkle * 0.7;
        let x = ca * rx;
        let y = hs.y + sa * ry;
        // Subtle raised brow ridge & recessed orbital pocket at hi == 5
        if (hi === 5 && Math.abs(ca) > 0.65 && sa > -0.15 && sa < 0.65) {
          const brow = sa > 0.25 ? 0.014 : -0.014;
          x += Math.sign(ca) * brow;
        }
        // Subtle jaw beak line indentation along ventral snout
        if (hi >= 5 && hi <= 7 && sa < -0.15 && sa > -0.45) {
          x *= 0.94;
        }
        const plastW = sa < -0.35 ? Math.min(1.0, (-sa - 0.35) / 0.5) : 0.0;
        ring.push(pushTV(x, y, hs.z, 0.0, plastW, hs.neck, 1));
      }
      hRings.push(ring);
    }
    for (let i = 0; i < hRings.length - 1; i++) {
      for (let j = 0; j < hSegs; j++) {
        const jn = (j + 1) % hSegs;
        idx.push(hRings[i][j], hRings[i][jn], hRings[i + 1][jn], hRings[i][j], hRings[i + 1][jn], hRings[i + 1][j]);
      }
    }
    const snoutCap = pushTV(0, 0.008, 1.345, 0, 0, 0, 1);
    const neckCap = pushTV(0, 0.015, 0.54, 0, 0, 1, 1);
    for (let j = 0; j < hSegs; j++) {
      const jn = (j + 1) % hSegs;
      idx.push(snoutCap, hRings[hRings.length - 1][j], hRings[hRings.length - 1][jn]);
      idx.push(neckCap, hRings[0][jn], hRings[0][j]);
    }
    ensureTurtleOutward(headStart);
  }

  // ---- 3. Glossy Amber-Obsidian Reptilian Eyes in Orbital Sockets (Disconnected grp = 5) ----
  const eyeGeo = new THREE.SphereGeometry(0.036, 14, 10);
  const ePos = eyeGeo.getAttribute('position');
  const eIdx = eyeGeo.index;
  for (const side of [-1, 1]) {
    const baseV = pos.length / 3;
    const ex = side * 0.128, ey = 0.088, ez = 1.115;
    for (let i = 0; i < ePos.count; i++) {
      pushTV(ex + ePos.getX(i) * 0.72, ey + ePos.getY(i) * 0.92, ez + ePos.getZ(i) * 1.05, 0, 0, 0, 5);
    }
    for (let i = 0; i < eIdx.count; i += 3) {
      idx.push(baseV + eIdx.getX(i), baseV + eIdx.getX(i + 1), baseV + eIdx.getX(i + 2));
    }
  }
  eyeGeo.dispose();

  // ---- 4. Watertight Swept Hydrofoil Fore-Flippers (with Anterior Keratin Scale Ridge & Claw Nub) ----
  for (const side of [-1, 1]) {
    const flipStart = idx.length;
    const fSegs = 18;
    const fSec = 18;
    const fRings = [];
    const grpId = side < 0 ? 2 : 3;
    let tipX = 0, tipY = 0, tipZ = 0;

    for (let i = 0; i <= fSegs; i++) {
      const t = i / fSegs; // 0 = muscular shoulder -> 1 = tapered crescent tip
      const sx = side * (0.40 + t * 1.04);
      const sweepZ = 0.48 - Math.pow(t, 1.38) * 0.62 + Math.sin(t * Math.PI) * 0.16;
      const droopY = -0.02 - t * 0.055 + Math.sin(t * Math.PI) * 0.045;
      const chord = (0.33 * Math.sin(Math.pow(t, 0.56) * Math.PI * 0.92) + 0.045) * (1.0 - t * 0.34);
      const tipTaper = t > 0.86 ? Math.cos(((t - 0.86) / 0.14) * Math.PI * 0.48) : 1.0;
      const thick = (0.052 * (1.0 - t * 0.76) + 0.009) * tipTaper;
      // Signature single sea-turtle anterior keratin claw nub around t ~ 0.34
      const clawBump = Math.exp(-Math.pow((t - 0.34) / 0.045, 2.0)) * 0.032;

      tipX = sx; tipY = droopY; tipZ = sweepZ;
      const ring = [];
      for (let j = 0; j < fSec; j++) {
        const a = (j / fSec) * Math.PI * 2;
        const uChord = Math.cos(a) * 0.5 + 0.5; // 0 = thin scalloped trailing edge, 1 = thick scaled leading edge
        const naca = Math.sin(Math.pow(uChord, 0.65) * Math.PI);
        const sideSign = Math.sin(a) >= 0 ? 1 : -1;
        const cz = (uChord - 0.5) * 2.0 * chord + (uChord > 0.88 ? clawBump : 0.0);
        const cy = sideSign * naca * thick;
        const edgeThin = Math.min(1.0, Math.max(1.0 - uChord / 0.32, (t - 0.72) / 0.28));
        const plastW = sideSign < 0 ? 0.85 : 0.0;
        ring.push(pushTV(sx, droopY + cy, sweepZ + cz, Math.max(0, edgeThin), plastW, 0, grpId));
      }
      fRings.push(ring);
    }
    for (let i = 0; i < fSegs; i++) {
      for (let j = 0; j < fSec; j++) {
        const jn = (j + 1) % fSec;
        idx.push(fRings[i][j], fRings[i][jn], fRings[i + 1][jn], fRings[i][j], fRings[i + 1][jn], fRings[i + 1][j]);
      }
    }
    // Cap wingtip & shoulder root
    const tCap = pushTV(tipX, tipY, tipZ, 1.0, 0.0, 0, grpId);
    const rCap = pushTV(side * 0.38, -0.02, 0.46, 0.0, 0.0, 0, grpId);
    for (let j = 0; j < fSec; j++) {
      const jn = (j + 1) % fSec;
      idx.push(tCap, fRings[fSegs][j], fRings[fSegs][jn]);
      idx.push(rCap, fRings[0][jn], fRings[0][j]);
    }
    ensureTurtleOutward(flipStart);
  }

  // ---- 5. Watertight Steering Hind Flippers & Short Conical Tail (grp = 4) ----
  for (const side of [-1, 1]) {
    const hStart = idx.length;
    const rSegs = 10;
    const rSec = 12;
    const rRings = [];
    for (let i = 0; i <= rSegs; i++) {
      const t = i / rSegs;
      const sx = side * (0.24 + t * 0.34);
      const sz = -0.68 - t * 0.56;
      const sy = -0.03 - t * 0.025;
      const halfW = (0.155 * Math.sin(Math.pow(t, 0.62) * Math.PI * 0.88) + 0.032);
      const thick = (0.028 * (1.0 - t * 0.68) + 0.006) * (t > 0.86 ? 0.5 : 1.0);
      const ring = [];
      for (let j = 0; j < rSec; j++) {
        const a = (j / rSec) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const edgeThin = Math.max(0.0, (t - 0.65) / 0.35);
        ring.push(pushTV(sx + ca * halfW * 0.58, sy + sa * thick, sz + ca * halfW * 0.42, edgeThin, sa < -0.2 ? 0.8 : 0.0, 0, 4));
      }
      rRings.push(ring);
    }
    for (let i = 0; i < rSegs; i++) {
      for (let j = 0; j < rSec; j++) {
        const jn = (j + 1) % rSec;
        idx.push(rRings[i][j], rRings[i][jn], rRings[i + 1][jn], rRings[i][j], rRings[i + 1][jn], rRings[i + 1][j]);
      }
    }
    const hTip = pushTV(side * 0.58, -0.055, -1.25, 1.0, 0.0, 0, 4);
    const hRoot = pushTV(side * 0.24, -0.03, -0.68, 0.0, 0.0, 0, 4);
    for (let j = 0; j < rSec; j++) {
      const jn = (j + 1) % rSec;
      idx.push(hTip, rRings[rSegs][j], rRings[rSegs][jn]);
      idx.push(hRoot, rRings[0][jn], rRings[0][j]);
    }
    ensureTurtleOutward(hStart);
  }

  // ---- 6. 5 Miniature Epibiont Turtle Barnacles (Chelonibia testudinaria) on Rear Carapace (grp = 6) ----
  const tBarnacles = [
    [0.16, 0.255, -0.34, 0.044],
    [-0.22, 0.232, -0.44, 0.038],
    [0.08, 0.228, -0.54, 0.032],
    [-0.14, 0.285, -0.14, 0.030],
    [0.28, 0.195, -0.46, 0.028],
  ];
  for (const [bx, by, bz, br] of tBarnacles) {
    const bStart = idx.length;
    const sides = 7;
    const h = br * 0.45;
    const bRing = [], tRing = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const rib = 1.0 + 0.12 * Math.cos(a * 6.0);
      bRing.push(pushTV(bx + Math.cos(a) * br * rib, by - 0.01, bz + Math.sin(a) * br * rib, 0.0, 0, 0, 6));
      tRing.push(pushTV(bx + Math.cos(a) * br * 0.42 * rib, by + h, bz + Math.sin(a) * br * 0.42 * rib, 1.0, 0, 0, 6));
    }
    const ctr = pushTV(bx, by + h * 0.5, bz, 0.0, 0, 0, 6);
    for (let s = 0; s < sides; s++) {
      const ns = (s + 1) % sides;
      idx.push(bRing[s], bRing[ns], tRing[ns], bRing[s], tRing[ns], tRing[s]);
      idx.push(tRing[s], tRing[ns], ctr);
    }
    ensureTurtleOutward(bStart);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aTMatW', new THREE.Float32BufferAttribute(matW, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildJellyfishGeometry() {
  // Procedural Translucent Moon Jellyfish (Aurelia): scalloped dome bell + 4 ruffled oral arms + 12 tentacles
  const pos = [];
  const norm = [];
  const jMeta = []; // x = part (0=bell, 1=oral arm, 2=tentacle), y = radial/vertical parameter 0..1, z = angle
  const idx = [];

  // 1. Scalloped Dome Bell (part = 0)
  const rRings = 12;
  const rSegs = 28;
  const bellBase = 0;
  for (let i = 0; i <= rRings; i++) {
    const u = i / rRings; // 0 = apex -> 1 = rim
    const theta = u * Math.PI * 0.56;
    const rad = Math.sin(theta) * 0.44;
    const y = Math.cos(theta) * 0.28;
    for (let j = 0; j < rSegs; j++) {
      const a = (j / rSegs) * Math.PI * 2;
      const scallop = 1.0 + 0.055 * Math.cos(a * 8.0) * Math.pow(u, 2.0);
      const x = Math.cos(a) * rad * scallop;
      const z = Math.sin(a) * rad * scallop;
      const yScallop = y - 0.025 * Math.cos(a * 8.0) * Math.pow(u, 2.5);
      pos.push(x, yScallop, z);
      norm.push(Math.cos(a) * Math.sin(theta), Math.cos(theta), Math.sin(a) * Math.sin(theta));
      jMeta.push(0.0, u, a);
    }
  }
  for (let i = 0; i < rRings; i++) {
    for (let j = 0; j < rSegs; j++) {
      const jn = (j + 1) % rSegs;
      const a = bellBase + i * rSegs + j;
      const b = bellBase + i * rSegs + jn;
      const c = bellBase + (i + 1) * rSegs + j;
      const d = bellBase + (i + 1) * rSegs + jn;
      idx.push(a, c, b, b, c, d);
    }
  }

  // 2. 4 Ruffled Oral Arms hanging inside bell (part = 1)
  const armSegs = 12;
  for (let k = 0; k < 4; k++) {
    const ang = (k / 4) * Math.PI * 2 + 0.35;
    const cx = Math.cos(ang);
    const cz = Math.sin(ang);
    const tx = -cz;
    const tz = cx;
    const aBase = pos.length / 3;
    for (let i = 0; i <= armSegs; i++) {
      const v = i / armSegs;
      const y = 0.09 - v * 0.92;
      const radial = 0.075 + v * 0.06 + Math.sin(v * 7.5 + k) * 0.028;
      const w = (0.068 * (1.0 - v * 0.68)) * (1.0 + 0.25 * Math.sin(v * 14.0));
      const mx = cx * radial;
      const mz = cz * radial;
      pos.push(mx - tx * w, y, mz - tz * w);
      norm.push(cx, 0.1, cz);
      jMeta.push(1.0, v, ang);

      pos.push(mx + tx * w, y, mz + tz * w);
      norm.push(cx, 0.1, cz);
      jMeta.push(1.0, v, ang);
    }
    for (let i = 0; i < armSegs; i++) {
      const p0 = aBase + i * 2;
      idx.push(p0, p0 + 2, p0 + 1, p0 + 1, p0 + 2, p0 + 3);
    }
  }

  // 3. 12 Trailing Marginal Tentacles from bell rim (part = 2)
  const tenSegs = 12;
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    const cx = Math.cos(ang);
    const cz = Math.sin(ang);
    const tx = -cz;
    const tz = cx;
    const tBase = pos.length / 3;
    const len = 1.05 + (k % 3) * 0.24;
    for (let i = 0; i <= tenSegs; i++) {
      const v = i / tenSegs;
      const y = -0.02 - v * len;
      const r = 0.41 * (1.0 - v * 0.25);
      const w = 0.011 * (1.0 - v * 0.65);
      const mx = cx * r;
      const mz = cz * r;
      pos.push(mx - tx * w, y, mz - tz * w);
      norm.push(cx, 0.0, cz);
      jMeta.push(2.0, v, ang);

      pos.push(mx + tx * w, y, mz + tz * w);
      norm.push(cx, 0.0, cz);
      jMeta.push(2.0, v, ang);
    }
    for (let i = 0; i < tenSegs; i++) {
      const p0 = tBase + i * 2;
      idx.push(p0, p0 + 2, p0 + 1, p0 + 1, p0 + 2, p0 + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('aJMeta', new THREE.Float32BufferAttribute(jMeta, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildGardenEelGeometry() {
  // Procedural Spotted Garden Eel (Heteroconger hassi): slender curved vertical tube emerging from sand burrow
  const pos = [];
  const norm = [];
  const eelT = []; // 0 = sand burrow root -> 1 = curved snout head
  const idx = [];
  const rings = 14;
  const segs = 8;
  const totalH = 0.88;

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    // Slight natural S-curve neck posture facing into current (+Z)
    const y = t * totalH - 0.08; // embed root slightly into sand
    const zCurve = Math.pow(t, 1.8) * 0.14 + Math.sin(t * Math.PI) * 0.03;
    const rad = t > 0.92
      ? 0.018 * (1.0 - (t - 0.92) / 0.08 * 0.72)
      : (0.023 - t * 0.0045);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      pos.push(ca * rad, y, zCurve + sa * rad);
      norm.push(ca, 0.08, sa);
      eelT.push(t);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const jn = (j + 1) % segs;
      const a = i * segs + j;
      const b = i * segs + jn;
      const c = (i + 1) * segs + j;
      const d = (i + 1) * segs + jn;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('aEelT', new THREE.Float32BufferAttribute(eelT, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function compileMarineLife(terrain, sharedUniforms, anemoneAnchors = []) {
  rseed(88421);
  const group = new THREE.Group();
  const shadowGroup = new THREE.Group();

  // ---- 1. 6 Gliding Giant Manta Rays ----
  const mantaBaseGeo = buildMantaGeometry();
  const mantaGeo = new THREE.InstancedBufferGeometry();
  mantaGeo.index = mantaBaseGeo.index;
  mantaGeo.attributes.position = mantaBaseGeo.attributes.position;
  mantaGeo.attributes.normal = mantaBaseGeo.attributes.normal;
  mantaGeo.attributes.uv = mantaBaseGeo.attributes.uv;

  const mantaSpecs = [
    { cx: 18, cy: -16, cz: 10, rx: 28, rz: 24, speed: 0.14, scale: 1.15, ph: 0.0 },
    { cx: -12, cy: -13, cz: -14, rx: 32, rz: 26, speed: 0.12, scale: 1.05, ph: 1.4 },
    { cx: 34, cy: -22, cz: 22, rx: 20, rz: 18, speed: 0.16, scale: 1.25, ph: 2.8 },
    { cx: -32, cy: -19, cz: -22, rx: 24, rz: 22, speed: 0.13, scale: 0.95, ph: 4.1 },
    { cx: 0, cy: -11, cz: 2, rx: 42, rz: 36, speed: 0.095, scale: 1.32, ph: 5.2 },
    { cx: 6, cy: -21, cz: 36, rx: 22, rz: 18, speed: 0.15, scale: 1.0, ph: 0.9 },
  ];
  const nMantas = mantaSpecs.length;
  mantaGeo.instanceCount = nMantas;

  const mOrbit = new Float32Array(nMantas * 4);
  const mParams = new Float32Array(nMantas * 4);
  for (let i = 0; i < nMantas; i++) {
    const m = mantaSpecs[i];
    mOrbit[i * 4] = m.cx;
    mOrbit[i * 4 + 1] = m.cy;
    mOrbit[i * 4 + 2] = m.cz;
    mOrbit[i * 4 + 3] = m.scale;
    mParams[i * 4] = m.rx;
    mParams[i * 4 + 1] = m.rz;
    mParams[i * 4 + 2] = m.speed;
    mParams[i * 4 + 3] = m.ph;
  }
  mantaGeo.setAttribute('iOrbit', new THREE.InstancedBufferAttribute(mOrbit, 4));
  mantaGeo.setAttribute('iParams', new THREE.InstancedBufferAttribute(mParams, 4));
  mantaGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -18, 0), 250);

  const mantaVs = /* glsl */ `
    attribute vec4 iOrbit;
    attribute vec4 iParams;
    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vLPos;

    mat3 mantaBasis(float t, vec4 orb, vec4 par) {
      float ang = t * par.z + par.w;
      vec3 fwd = normalize(vec3(-sin(ang) * par.x, 0.08 * cos(ang * 2.0), cos(ang) * par.y));
      vec3 up = vec3(0.0, 1.0, 0.0);
      vec3 right = normalize(cross(up, fwd));
      up = cross(fwd, right);
      // Bank inward toward orbit center
      float bank = 0.24;
      vec3 rB = right * cos(bank) + up * sin(bank);
      vec3 uB = up * cos(bank) - right * sin(bank);
      return mat3(rB, uB, fwd);
    }

    void main() {
      float ang = uTime * iParams.z + iParams.w;
      vec3 center = vec3(
        iOrbit.x + cos(ang) * iParams.x,
        iOrbit.y + sin(ang * 2.0 + iParams.w) * 2.4,
        iOrbit.z + sin(ang) * iParams.y
      );

      vec3 lp = position * iOrbit.w;
      float span = abs(position.x) / 2.3;
      // Majestic sweeping underwater wingbeat from shoulder to tip
      float flap = sin(uTime * 1.65 + iParams.w * 2.0 - span * 1.4) * pow(span, 1.25) * 0.85 * iOrbit.w;
      lp.y += flap;
      // Whip tail undulates trailing behind
      if (position.z < -0.6) {
        float tailT = clamp((-0.6 - position.z) / 2.1, 0.0, 1.0);
        lp.y += sin(uTime * 2.4 + iParams.w - tailT * 2.6) * 0.22 * tailT;
      }

      mat3 basis = mantaBasis(uTime, iOrbit, iParams);
      vec3 wp = center + basis * lp;
      vec3 wn = normalize(basis * normal);

      vWPos = wp;
      vWNorm = wn;
      vLPos = position;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const mantaFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vLPos;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 N = normalize(vWNorm);
      // Dorsal deep midnight navy-indigo vs creamy pale chevron underside
      float isTop = smoothstep(-0.02, 0.04, N.y);
      float chevron = smoothstep(0.55, 1.35, abs(vLPos.x)) * smoothstep(0.45, -0.35, vLPos.z);
      vec3 dorsal = mix(vec3(0.06, 0.08, 0.11), vec3(0.24, 0.27, 0.30), chevron * 0.45);
      vec3 belly = vec3(0.48, 0.49, 0.48);
      vec3 col = mix(belly, dorsal, isTop);

      float sh = shadow9(vWPos);
      float ca = caus(vWPos);
      vec3 sunIrr = sunE(vWPos);
      float ndl = max(dot(N, uSunDir), 0.0);

      vec3 V = normalize(uCamPos - vWPos);
      vec3 H = normalize(V + uSunDir);
      float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.22 * sh;

      vec3 lit = col * (sunIrr * ndl * sh * (0.65 + 1.45 * ca) + amb(vWPos, N) + sideLight(vWPos, N)) + sunIrr * spec;
      fragColor = vec4(fog(lit, vWPos), 1.0);
    }
  `;

  const mantaShadowFs = /* glsl */ `
    precision highp float;
    layout(location = 0) out vec4 fragColor;
    void main() { fragColor = vec4(1.0); }
  `;

  const mantaMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: mantaVs,
    fragmentShader: mantaFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  }), sharedUniforms);

  const mantaShadowMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: mantaVs,
    fragmentShader: mantaShadowFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    colorWrite: false,
  }), sharedUniforms);

  const mantaMesh = new THREE.Mesh(mantaGeo, mantaMat);
  mantaMesh.frustumCulled = false;
  const mantaShadowMesh = new THREE.Mesh(mantaGeo, mantaShadowMat);
  mantaShadowMesh.frustumCulled = false;

  group.add(mantaMesh);
  shadowGroup.add(mantaShadowMesh);

  // ---- 2. 4,240 GTA-6-Grade Multi-Species Iridescent Schooling Reef Fish ----
  const fishBaseGeo = buildFishGeometry();
  const fishGeo = new THREE.InstancedBufferGeometry();
  fishGeo.index = fishBaseGeo.index;
  fishGeo.attributes.position = fishBaseGeo.attributes.position;
  fishGeo.attributes.normal = fishBaseGeo.attributes.normal;
  fishGeo.attributes.aFishPart = fishBaseGeo.attributes.aFishPart;

  rseed(14);
  const SCH = [
    [-2, -34, -10, 14, 480, 0.36, 1, 0.945, 0],  // Main Canyon Floor: Blue-Green Reef Chromis & Fusiliers
    [4, -20.5, -1, 10.5, 360, 0.38, -1, 0.32, 1], // Main Canyon Hero Mid-Water: Sunset Coral Anthias (Vista 1!)
    [58.5, -22.0, 9.5, 9.5, 380, 0.38, 1, 0.18, 2], // Shipwreck Cove Hero: Golden Blue-Striped Snappers orbiting Galleon (Vista 3!)
    [-56, -34, -4, 10, 420, 0.36, -1, 0.3, 1],   // Sponge Canyon: Sunset Coral Anthias
    [8, -35, 84, 15, 320, 0.36, 1, 0.62, 3],     // Purple Grotto Outer Lagoon: Regal Blue Tangs
    [-90, -28, -70, 25, 300, 0.36, 1, 0.25, 4],  // Outer Reef: Mirror-Chrome Baitball Jacks
    [95, -30, 70, 25, 300, 0.36, -1, 0.78, 0],   // Blue-Green Fusiliers
    [0, -18.5, 6, 18, 380, 0.40, -1, 0.68, 4],   // Upper Canyon Sunlit Baitball: Mirror-Chrome Jacks (Vista 1!)
    [-30, -30, -100, 18, 300, 0.36, 1, 0.18, 1], // Sunset Anthias
    [16, -35, 30, 12, 300, 0.36, 1, 0.85, 3],    // Regal Blue Tangs
    [-48, -34, -58, 12, 300, 0.36, -1, 0.33, 2], // Blue-Striped Snappers
    [-19, -20.5, 19, 10, 320, 0.36, 1, 0.45, 2], // Giant Sea Fan Wall: Golden Blue-Striped Snappers (Vista 9!)
  ];

  const totalFish = SCH.reduce((s, a) => s + a[4], 0);
  fishGeo.instanceCount = totalFish;

  const fCenter = new Float32Array(totalFish * 4); // cx, cy, cz, R
  const fMeta = new Float32Array(totalFish * 4); // seed, angVel, size, schoolPhase
  const fSpecies = new Float32Array(totalFish); // 0=Chromis/Fusilier, 1=Coral Anthias, 2=Blue-Striped Snapper, 3=Regal Blue Tang, 4=Chrome Jack

  let fi = 0;
  for (let si = 0; si < SCH.length; si++) {
    const s = SCH[si];
    const ss = s[7] === undefined ? rnd() : s[7];
    const spId = s[8] === undefined ? (si % 5) : s[8];
    for (let i = 0; i < s[4]; i++) {
      const i4 = fi * 4;
      fCenter[i4] = s[0];
      fCenter[i4 + 1] = s[1];
      fCenter[i4 + 2] = s[2];
      fCenter[i4 + 3] = s[3];

      fMeta[i4] = rnd();
      fMeta[i4 + 1] = (s[6] * 1.9) / s[3];
      fMeta[i4 + 2] = s[5];
      fMeta[i4 + 3] = ss;
      fSpecies[fi] = spId;
      fi++;
    }
  }

  fishGeo.setAttribute('iFCenter', new THREE.InstancedBufferAttribute(fCenter, 4));
  fishGeo.setAttribute('iFMeta', new THREE.InstancedBufferAttribute(fMeta, 4));
  fishGeo.setAttribute('iFSpecies', new THREE.InstancedBufferAttribute(fSpecies, 1));
  fishGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -25, 0), 260);

  const fishVs = /* glsl */ `
    attribute float aFishPart;
    attribute vec4 iFCenter;
    attribute vec4 iFMeta;
    attribute float iFSpecies;
    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vOrigPos;
    flat out float vSeed;
    flat out float vSpecies;
    out float vFishPart;
    out float vShadow;

    float hsFish(float p) {
      float x = fract(p * 0.1031);
      x *= x + 33.33;
      return fract(2.0 * x * x);
    }

    void main() {
      float s = iFMeta.x;
      vec3 h = vec3(hsFish(s), hsFish(s + 0.37), hsFish(s + 0.71));
      float R = iFCenter.w;
      float t = uTime;
      float ta = t * iFMeta.y + iFMeta.w * 6.3 + (h.x - 0.5) * (26.0 / R);
      float ph = iFMeta.w * 17.0;
      vec3 P = iFCenter.xyz + vec3(R * cos(ta), 2.2 * sin(3.0 * ta + ph), R * 0.6 * sin(ta));
      vec3 T = normalize(vec3(-R * sin(ta), 6.6 * cos(3.0 * ta + ph), R * 0.6 * cos(ta))) * sign(iFMeta.y);
      vec3 S = normalize(cross(vec3(0.0, 1.0, 0.0), T));
      vec3 Up = cross(T, S);
      vec3 off = S * ((h.y - 0.5) * 5.0 + sin(t * 0.6 + s * 40.0) * 0.5) + Up * ((h.z - 0.5) * 3.2 + cos(t * 0.5 + s * 31.0) * 0.4);
      vec3 baseP = P + off;

      // Reactive School Evasion AI: scatter, bank, and burst speed around Diver, Patrol Shark & Sperm Whales
      vec3 evade = vec3(0.0);
      float panic = 0.0;
      float swimSpd = min(length(uSwimmerVel), 9.0);

      vec3 dCam = baseP - uCamPos;
      float camLen = length(dCam);
      float camRad = 7.8 + swimSpd * 0.42;
      if (camLen < camRad) {
        float f = smoothstep(camRad, 1.2, camLen);
        float f2 = f * f;
        vec3 away = camLen > 0.05 ? (dCam / camLen) : vec3(0.0, 0.4, 0.9);
        vec3 swirl = normalize(away + (h - 0.5) * 0.55);
        evade += swirl * (f2 * (4.4 + swimSpd * 0.25));
        panic = max(panic, f);
      }

      if (uSharkWake.w > 0.1) {
        vec3 dSh = baseP - uSharkWake.xyz;
        float shLen = length(dSh);
        if (shLen < 10.5) {
          float f = smoothstep(10.5, 1.8, shLen);
          evade += (dSh / max(shLen, 0.1)) * (f * f * 5.8);
          panic = max(panic, f * 1.1);
        }
      }

      if (uWhaleBody0.w > 0.1) {
        vec3 dW0 = baseP - uWhaleBody0.xyz;
        float w0Len = length(dW0);
        if (w0Len < 15.0) {
          float f = smoothstep(15.0, 3.2, w0Len);
          evade += (dW0 / max(w0Len, 0.1)) * (f * f * 6.8);
          panic = max(panic, f);
        }
      }
      if (uWhaleBody1.w > 0.1) {
        vec3 dW1 = baseP - uWhaleBody1.xyz;
        float w1Len = length(dW1);
        if (w1Len < 10.5) {
          float f = smoothstep(10.5, 2.2, w1Len);
          evade += (dW1 / max(w1Len, 0.1)) * (f * f * 4.8);
          panic = max(panic, f * 0.9);
        }
      }

      if (panic > 0.005) {
        baseP += evade;
        baseP.y = min(baseP.y, -1.6);
        vec3 escDir = normalize(evade + T * 0.45);
        T = normalize(mix(T, escDir, clamp(panic * 0.82, 0.0, 0.85)));
        S = normalize(cross(vec3(0.0, 1.0, 0.0), T) + vec3(1e-4));
        Up = cross(T, S);
        float bank = clamp(dot(evade, S) * 0.18, -0.65, 0.65) * panic;
        float cb = cos(bank);
        float sb = sin(bank);
        vec3 sRot = S * cb + Up * sb;
        Up = Up * cb - S * sb;
        S = sRot;
      }

      vec3 l = position * iFMeta.z * (0.75 + 0.5 * h.z);
      float tailFreq = 9.0 + panic * 11.5;
      float tailAmp = 0.22 + panic * 0.16;
      // Smooth carangiform tail bend + agile pectoral fin flutter
      float bendWeight = max(0.0, 0.28 * iFMeta.z - l.x);
      l.z += sin(t * tailFreq + s * 50.0 + l.x * 5.2) * tailAmp * bendWeight;
      if (aFishPart > 0.5 && aFishPart < 1.5 && abs(position.z) > 0.07) {
        l.x += sin(t * (tailFreq * 1.35) + s * 28.0) * 0.032 * iFMeta.z * abs(position.z);
      }

      vec3 w = baseP + T * l.x + Up * l.y + S * l.z;

      vWPos = w;
      vWNorm = normalize(T * normal.x + Up * normal.y + S * normal.z);
      vOrigPos = position;
      vSeed = s;
      vSpecies = iFSpecies;
      vFishPart = aFishPart;
      vShadow = shadow1(w);
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    }
  `;

  const fishFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vOrigPos;
    flat in float vSeed;
    flat in float vSpecies;
    in float vFishPart;
    in float vShadow;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 n = normalize(vWNorm);
      if (!gl_FrontFacing) n = -n;
      vec3 L = uSunDir;
      vec3 V = normalize(uCamPos - vWPos);
      vec4 vv = vol(vWPos);

      float isEye = step(2.5, vFishPart);
      float isTail = step(1.5, vFishPart) * step(vFishPart, 2.5);
      float isFin = step(0.5, vFishPart) * step(vFishPart, 2.5);

      // Overlapping cycloid fish-scale metallic diamond micro-grid
      float scU = vOrigPos.x * 46.0;
      float scV = vOrigPos.y * 54.0 + floor(scU) * 0.5;
      float scaleCell = sin(scU * 3.14159) * sin(scV * 3.14159);
      float scaleGlint = smoothstep(0.15, 0.85, scaleCell * 0.5 + 0.5);
      // Subtle curved gill operculum crease line on head flank
      float gillCrease = exp(-pow((vOrigPos.x - 0.25 + vOrigPos.y * vOrigPos.y * 2.2) / 0.016, 2.0)) * (1.0 - isFin) * (1.0 - isEye);

      vec3 alb;
      vec3 finCol;
      float specBoost = 0.68;

      if (vSpecies < 0.5) {
        // 0: Iridescent Blue-Green Reef Chromis & Fusiliers (deep cerulean-turquoise back -> silver belly -> golden tail)
        vec3 dorsal = vec3(0.03, 0.24, 0.46);
        vec3 belly = vec3(0.42, 0.56, 0.64);
        alb = mix(belly, dorsal, ss(-0.06, 0.14, vOrigPos.y));
        float goldStripe = exp(-pow((vOrigPos.y - 0.055) / 0.032, 2.0));
        alb = mix(alb, vec3(0.84, 0.58, 0.06), goldStripe * 0.82);
        finCol = mix(vec3(0.12, 0.46, 0.62), vec3(0.88, 0.62, 0.08), isTail * 0.82);
      } else if (vSpecies < 1.5) {
        // 1: Radiant Sunset Coral Anthias (deep vibrant tangerine-coral -> magenta flank -> crimson-gold fins)
        vec3 dorsal = vec3(0.82, 0.18, 0.04);
        vec3 belly = vec3(0.88, 0.44, 0.22);
        alb = mix(belly, dorsal, ss(-0.08, 0.14, vOrigPos.y));
        alb = mix(alb, vec3(0.68, 0.10, 0.34), ss(-0.14, 0.02, vOrigPos.y) * (1.0 - ss(0.04, 0.12, vOrigPos.y)) * 0.65);
        finCol = mix(vec3(0.85, 0.34, 0.06), vec3(0.76, 0.12, 0.36), isTail * 0.68);
        specBoost = 0.62;
      } else if (vSpecies < 2.5) {
        // 2: Blue-Striped Golden Reef Snappers (Lutjanus kasmira — rich saffron gold + 4 crisp electric-blue stripes!)
        alb = mix(vec3(0.62, 0.56, 0.32), vec3(0.86, 0.58, 0.03), ss(-0.10, 0.07, vOrigPos.y));
        float stripes = smoothstep(0.54, 0.82, sin(vOrigPos.y * 88.0 - vOrigPos.x * 4.5));
        alb = mix(alb, vec3(0.06, 0.42, 0.86), stripes * ss(-0.06, 0.02, vOrigPos.y) * 0.92);
        finCol = vec3(0.84, 0.60, 0.05);
      } else if (vSpecies < 3.5) {
        // 3: Regal Blue Tang (Paracanthurus hepatus — deep royal cobalt blue + jet-black saddle + canary-yellow tail!)
        alb = vec3(0.03, 0.15, 0.62);
        float saddle = smoothstep(0.06, -0.02, abs(vOrigPos.y - 0.06)) * smoothstep(0.22, 0.05, vOrigPos.x) * smoothstep(-0.34, -0.18, vOrigPos.x);
        alb = mix(alb, vec3(0.02, 0.025, 0.04), saddle * 0.94);
        finCol = mix(vec3(0.02, 0.10, 0.46), vec3(0.90, 0.70, 0.04), isTail);
      } else {
        // 4: Mirror-Chrome Silver Baitball Jacks (deep steel-blue back -> gleaming silver-platinum flanks!)
        alb = mix(vec3(0.46, 0.56, 0.64), vec3(0.08, 0.18, 0.30), ss(-0.02, 0.16, vOrigPos.y));
        finCol = vec3(0.32, 0.44, 0.52);
        specBoost = 1.35;
      }

      // Fin rays & translucent dorsal/pectoral/tail fin shading
      float finRays = 0.74 + 0.26 * sin(vOrigPos.y * 85.0 + vOrigPos.x * 60.0);
      alb = mix(alb * (0.86 + 0.22 * scaleGlint) * (1.0 - gillCrease * 0.52), finCol * finRays, isFin);

      // Glossy Fish Eye: golden-silver iris ring + crisp jet-black pupil
      if (isEye > 0.5) {
        float eyeD = length(vec2(vOrigPos.x - 0.355, vOrigPos.y - 0.038)) / 0.028;
        float pupil = 1.0 - smoothstep(0.42, 0.60, eyeD);
        alb = mix(vec3(0.76, 0.64, 0.28), vec3(0.01, 0.012, 0.016), pupil);
        specBoost = 1.65;
      }

      vec3 E = sunE(vWPos) * vShadow;
      float ca = caus(vWPos);
      float ndl = sat(dot(n, L));
      vec3 H = normalize(V + L);
      float spec = pow(sat(dot(n, H)), mix(30.0, 64.0, scaleGlint)) * specBoost * (0.55 + 0.75 * scaleGlint);
      // Translucent fin-edge backlit glow + iridescent scale Fresnel flash (calibrated for ACES — zero white blowout!)
      float rim = pow(1.0 - sat(dot(n, V)), 3.0);
      float backLight = pow(sat(dot(-V, L + n * 0.35)), 2.8);
      vec3 finSSS = finCol * E * backLight * isFin * 0.42;
      vec3 direct = E * (0.20 + 0.72 * ndl) * (0.62 + 0.58 * ca);
      vec3 ambCol = amb(vWPos, n) * 0.92 + sideLight(vWPos, n) * 0.70;
      vec3 fluor = alb * dot(direct + ambCol, vec3(0.08, 0.38, 0.42)) * (1.0 - isEye) * 0.16;

      vec3 c = alb * (direct + ambCol) + fluor;
      c += E * spec + mix(vec3(0.24, 0.62, 0.78), alb, 0.55) * rim * 0.24 * vv.g + finSSS;
      fragColor = vec4(fog(c, vWPos), 1.0);
    }
  `;

  const fishMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: fishVs,
    fragmentShader: fishFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  }), sharedUniforms);

  const fishMesh = new THREE.Mesh(fishGeo, fishMat);
  fishMesh.frustumCulled = false;
  group.add(fishMesh);

  // ---- 3. Symbiotic Clownfish (Amphiprion ocellaris) orbiting grounded Sea Anemones ----
  rseed(40411);
  const anchors = anemoneAnchors && anemoneAnchors.length > 0
    ? anemoneAnchors
    : [
        [-4.5, terrain.gy(-4.5, -14.0), -14.0, 0.72],
        [10.2, terrain.gy(10.2, -11.5), -11.5, 0.78],
        [-14.5, terrain.gy(-14.5, -3.5), -3.5, 0.80],
        [4.5, terrain.gy(4.5, -31.0), -31.0, 0.75],
        [-2.0, terrain.gy(-2.0, -56.0), -56.0, 0.72],
      ];
  const clownRecords = [];
  for (let ai = 0; ai < anchors.length && clownRecords.length < 116; ai++) {
    const a = anchors[ai];
    const perColony = ai < 10 ? 3 : 2;
    for (let k = 0; k < perColony && clownRecords.length < 116; k++) {
      const sz = 0.24 + rnd() * 0.11;
      const rad = (0.42 + rnd() * 0.44) * Math.max(0.7, a[3] || 0.85);
      const speed = (1.15 + rnd() * 0.85) * (k % 2 === 0 ? 1 : -1);
      const hOff = 0.46 + rnd() * 0.48;
      clownRecords.push([a[0], a[1], a[2], rad, rnd(), speed, sz, hOff]);
    }
  }
  const nClownfish = clownRecords.length;
  const clownGeo = new THREE.InstancedBufferGeometry();
  clownGeo.index = fishBaseGeo.index;
  clownGeo.attributes.position = fishBaseGeo.attributes.position;
  clownGeo.attributes.normal = fishBaseGeo.attributes.normal;
  clownGeo.attributes.aFishPart = fishBaseGeo.attributes.aFishPart;
  clownGeo.instanceCount = nClownfish;

  const cAnchorArr = new Float32Array(nClownfish * 4);
  const cMetaArr = new Float32Array(nClownfish * 4);
  for (let i = 0; i < nClownfish; i++) {
    const r = clownRecords[i];
    const i4 = i * 4;
    cAnchorArr[i4] = r[0];
    cAnchorArr[i4 + 1] = r[1];
    cAnchorArr[i4 + 2] = r[2];
    cAnchorArr[i4 + 3] = r[3];
    cMetaArr[i4] = r[4];
    cMetaArr[i4 + 1] = r[5];
    cMetaArr[i4 + 2] = r[6];
    cMetaArr[i4 + 3] = r[7];
  }
  clownGeo.setAttribute('iCAnchor', new THREE.InstancedBufferAttribute(cAnchorArr, 4));
  clownGeo.setAttribute('iCMeta', new THREE.InstancedBufferAttribute(cMetaArr, 4));
  clownGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -25, 0), 220);

  const clownVs = /* glsl */ `
    attribute float aFishPart;
    attribute vec4 iCAnchor;
    attribute vec4 iCMeta;
    ${MEDIUM_GLSL}
    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vOrigPos;
    out float vFishPart;
    out float vShadow;

    void main() {
      float s = iCMeta.x;
      float spd = iCMeta.y;
      float sz = iCMeta.z;
      float baseH = iCMeta.w;
      float t = uTime;

      float camDist = distance(iCAnchor.xyz, uCamPos);
      float shelter = 1.0 - smoothstep(1.6, 5.2, camDist);

      float ph = s * 6.28318 + t * spd * (1.0 + shelter * 0.75);
      float orbitR = iCAnchor.w * mix(1.0, 0.34, shelter);
      float curH = mix(baseH + 0.16 * sin(t * 2.1 + s * 19.0), 0.16 + 0.08 * sin(t * 5.0 + s * 12.0), shelter);

      vec3 off = vec3(
        cos(ph) * orbitR,
        curH,
        sin(ph * 1.0 + 0.45 * sin(ph * 2.0)) * orbitR * 0.85
      );
      vec3 dOff = vec3(
        -sin(ph) * orbitR * spd,
        0.16 * cos(t * 2.1 + s * 19.0) * 2.1 * (1.0 - shelter),
        cos(ph + 0.45 * sin(ph * 2.0)) * (1.0 + 0.9 * cos(ph * 2.0)) * orbitR * 0.85 * spd
      );
      vec3 T = normalize(dOff + vec3(1e-4, 0.0, 0.0));
      vec3 S = normalize(cross(vec3(0.0, 1.0, 0.0), T) + vec3(1e-4));
      vec3 Up = cross(T, S);

      vec3 l = position * sz;
      float wigFreq = 13.5 + shelter * 8.0;
      l.z += sin(t * wigFreq + s * 40.0 + l.x * 6.5) * 0.28 * max(0.0, 0.28 * sz - l.x);
      vec3 w = iCAnchor.xyz + off + T * l.x + Up * l.y + S * l.z;

      vWPos = w;
      vWNorm = normalize(T * normal.x + Up * normal.y + S * normal.z);
      vOrigPos = position;
      vFishPart = aFishPart;
      vShadow = shadow1(w);
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    }
  `;

  const clownFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vOrigPos;
    in float vFishPart;
    in float vShadow;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 n = normalize(vWNorm);
      if (!gl_FrontFacing) n = -n;
      vec3 L = uSunDir;
      vec3 V = normalize(uCamPos - vWPos);

      float isEye = step(2.5, vFishPart);
      float isFin = step(0.5, vFishPart) * step(vFishPart, 2.5);

      float x = vOrigPos.x;
      float bHead = smoothstep(0.17, 0.20, x) * (1.0 - smoothstep(0.28, 0.31, x));
      float bMid  = smoothstep(-0.13, -0.09, x) * (1.0 - smoothstep(0.03, 0.07, x));
      float bTail = smoothstep(-0.37, -0.34, x) * (1.0 - smoothstep(-0.27, -0.24, x));
      float whiteBand = clamp(bHead + bMid + bTail, 0.0, 1.0) * (1.0 - isFin);

      float eHead = smoothstep(0.14, 0.18, x) * (1.0 - smoothstep(0.30, 0.34, x));
      float eMid  = smoothstep(-0.16, -0.11, x) * (1.0 - smoothstep(0.05, 0.10, x));
      float eTail = smoothstep(-0.40, -0.36, x) * (1.0 - smoothstep(-0.25, -0.21, x));
      float blackEdge = clamp((eHead + eMid + eTail) - whiteBand, 0.0, 1.0) * (1.0 - isFin);

      vec3 orange = mix(vec3(0.95, 0.34, 0.04), vec3(0.99, 0.50, 0.07), smoothstep(-0.12, 0.14, vOrigPos.y));
      vec3 alb = mix(orange, vec3(0.04, 0.04, 0.05), blackEdge * 0.94);
      alb = mix(alb, vec3(0.95, 0.97, 0.99), whiteBand);

      // Iconic black-trimmed translucent orange clownfish fins
      if (isFin > 0.5) {
        float edgeTrim = smoothstep(0.18, 0.26, abs(vOrigPos.y)) + smoothstep(0.16, 0.22, abs(vOrigPos.z)) + smoothstep(-0.54, -0.64, vOrigPos.x);
        alb = mix(orange * 1.05, vec3(0.03, 0.03, 0.04), clamp(edgeTrim, 0.0, 0.92));
      }
      if (isEye > 0.5) {
        float eyeD = length(vec2(vOrigPos.x - 0.355, vOrigPos.y - 0.038)) / 0.028;
        alb = mix(vec3(0.92, 0.56, 0.12), vec3(0.015, 0.02, 0.025), 1.0 - smoothstep(0.44, 0.62, eyeD));
      }

      vec3 E = sunE(vWPos) * vShadow;
      float ca = caus(vWPos);
      vec3 c = alb * (E * (0.30 + 0.78 * sat(dot(n, L))) * (0.75 + 0.75 * ca) + amb(vWPos, n) * 1.35 + sideLight(vWPos, n));
      c += E * pow(sat(dot(n, normalize(V + L))), 32.0) * mix(0.72, 2.2, isEye);
      fragColor = vec4(fog(c, vWPos), 1.0);
    }
  `;

  const clownMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: clownVs,
    fragmentShader: clownFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  }), sharedUniforms);
  const clownMesh = new THREE.Mesh(clownGeo, clownMat);
  clownMesh.frustumCulled = false;
  group.add(clownMesh);

  // ---- 4. 4 GTA-6-Grade Gliding Green Sea Turtles (Chelonia mydas) ----
  const turtleBaseGeo = buildSeaTurtleGeometry();
  const turtleGeo = new THREE.InstancedBufferGeometry();
  turtleGeo.index = turtleBaseGeo.index;
  turtleGeo.attributes.position = turtleBaseGeo.attributes.position;
  turtleGeo.attributes.normal = turtleBaseGeo.attributes.normal;
  turtleGeo.attributes.aTMatW = turtleBaseGeo.attributes.aTMatW;

  const turtleSpecs = [
    // Main Coral Canyon cruiser (visible in Vista 1)
    { cx: -2.0, cy: -17.5, cz: -4.0, rx: 14.0, rz: 15.0, speed: 0.115, scale: 1.22, ph: 0.4 },
    // Giant Sea Fan Wall glider (visible in Vista 9)
    { cx: -14.0, cy: -18.5, cz: 18.0, rx: 12.0, rz: 12.0, speed: 0.105, scale: 1.12, ph: 2.2 },
    // WWII Fighter Wreck Reef patroller (visible in Vista 8)
    { cx: 69.0, cy: -24.0, cz: -24.0, rx: 14.0, rz: 12.0, speed: 0.12, scale: 1.15, ph: 4.1 },
    // Sunken Galleon Shipwreck Cove cruiser (visible in Vista 3)
    { cx: 56.0, cy: -18.5, cz: 11.0, rx: 14.0, rz: 13.0, speed: 0.10, scale: 1.14, ph: 5.3 },
  ];
  const nTurtles = turtleSpecs.length;
  turtleGeo.instanceCount = nTurtles;

  const tOrbit = new Float32Array(nTurtles * 4);
  const tParams = new Float32Array(nTurtles * 4);
  for (let i = 0; i < nTurtles; i++) {
    const s = turtleSpecs[i];
    tOrbit.set([s.cx, s.cy, s.cz, s.rx], i * 4);
    tParams.set([s.rz, s.speed, s.scale, s.ph], i * 4);
  }
  turtleGeo.setAttribute('iTOrbit', new THREE.InstancedBufferAttribute(tOrbit, 4));
  turtleGeo.setAttribute('iTParams', new THREE.InstancedBufferAttribute(tParams, 4));
  turtleGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -18, 0), 220);

  const turtleVs = /* glsl */ `
    attribute vec4 aTMatW;
    attribute vec4 iTOrbit;
    attribute vec4 iTParams;
    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vLPos;
    out vec3 vLNorm;
    out vec4 vTMatW;

    vec3 turtlePosAt(float t, vec4 orb, vec4 prm) {
      float a = t * prm.y + prm.w;
      float x = orb.x + cos(a) * orb.w;
      float z = orb.z + sin(a) * prm.x + 2.6 * sin(2.0 * a) * 0.25;
      float y = orb.y + sin(a * 1.5 + prm.w) * 2.2;
      return vec3(x, y, z);
    }

    void main() {
      vec3 p0 = turtlePosAt(uTime, iTOrbit, iTParams);
      vec3 p1 = turtlePosAt(uTime + 0.08, iTOrbit, iTParams);
      vec3 p2 = turtlePosAt(uTime + 0.22, iTOrbit, iTParams);
      vec3 fwd = normalize(p1 - p0);
      vec3 fwd2 = normalize(p2 - p1);
      vec3 latAcc = fwd2 - fwd;
      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
      vec3 up = normalize(cross(fwd, right));
      float bank = clamp(dot(latAcc, right) * 5.2, -0.35, 0.35);
      float cb = cos(bank);
      float sb = sin(bank);
      vec3 rBank = right * cb + up * sb;
      vec3 uBank = up * cb - right * sb;
      mat3 basis = mat3(rBank, uBank, fwd);

      vec3 lp = position;
      vec3 ln = normal;
      float grp = aTMatW.w;
      float strokePh = uTime * 1.85 + iTParams.w * 2.3;
      // Asymmetric graceful sea-turtle flight: strong power downstroke + serene glide recovery
      float flap = sin(strokePh) + 0.24 * sin(strokePh * 2.0 - 0.65);
      float sweep = cos(strokePh);

      if (grp > 1.5 && grp < 3.5) {
        // Hydrofoil Fore-Flippers: figure-8 underwater rowing stroke with aeroelastic wingtip flex lag
        float side = grp < 2.5 ? -1.0 : 1.0;
        float span = max(0.0, abs(lp.x) - 0.38);
        float tipFlex = pow(span, 1.45);
        float lagFlap = sin(strokePh - span * 0.65) + 0.24 * sin((strokePh - span * 0.65) * 2.0 - 0.65);
        float pitchTwist = sweep * 0.34 * min(1.0, span * 1.25);
        float dy = lagFlap * 0.54 * span - cos(strokePh) * 0.08 * tipFlex;
        float dz = sweep * 0.28 * span;
        lp.y += dy + (lp.z - 0.34) * pitchTwist * 0.48;
        lp.z += dz;
        lp.x -= side * abs(lagFlap) * 0.11 * span;
        ln = normalize(ln + vec3(-side * lagFlap * 0.36 * span, 0.0, -sweep * 0.22));
      } else if (grp > 3.5 && grp < 4.5) {
        // Rear Steering Hind Flippers: delicate hydroplane trim
        lp.y += sin(strokePh - 1.25) * 0.055 * max(0.0, -lp.z - 0.66);
      } else if ((grp > 0.5 && grp < 1.5) || (grp > 4.5 && grp < 5.5)) {
        // Head, Neck & Glossy Eyes: gentle breathing lift + curious slight glance toward nearby diver
        float neck = smoothstep(0.60, 1.26, lp.z);
        vec3 toCam = uCamPos - p0;
        float camD = length(toCam);
        float lookStr = smoothstep(14.0, 3.0, camD) * smoothstep(-0.2, 0.4, dot(normalize(toCam + vec3(1e-4)), fwd));
        float yawLook = clamp(dot(normalize(toCam + vec3(1e-4)), rBank) * 0.22, -0.18, 0.18) * lookStr;
        float pitchLook = clamp(dot(normalize(toCam + vec3(1e-4)), uBank) * 0.14, -0.10, 0.10) * lookStr;
        lp.x += yawLook * neck * 0.36;
        lp.y += (sin(strokePh * 0.5) * 0.042 + pitchLook * 0.28) * neck;
      }

      // Subtle body heave synchronized with flipper power stroke
      lp.y -= flap * 0.052;
      lp *= iTParams.z;

      vec3 wp = p0 + basis * lp;
      vec3 wn = normalize(basis * ln);

      vWPos = wp;
      vWNorm = wn;
      vLPos = position;
      vLNorm = normal;
      vTMatW = aTMatW;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const turtleFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    ${SURFACE_GRADIENT_BUMP_GLSL}
    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vLPos;
    in vec3 vLNorm;
    in vec4 vTMatW;
    layout(location = 0) out vec4 fragColor;

    // Compact 2D Voronoi returning vec3(distToCenter, edgeDist, cellId)
    vec3 turtleVoronoi(vec2 p) {
      vec2 n = floor(p);
      vec2 f = fract(p);
      float md1 = 8.0;
      float md2 = 8.0;
      float id = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 h = vec2(dot(n + g, vec2(127.1, 311.7)), dot(n + g, vec2(269.5, 183.3)));
          vec2 o = 0.5 + 0.34 * sin(h * 1.15);
          vec2 r = g + o - f;
          float d = dot(r, r);
          if (d < md1) { md2 = md1; md1 = d; id = fract(sin(dot(n + g, vec2(41.3, 289.1))) * 43758.5); }
          else if (d < md2) { md2 = d; }
        }
      }
      return vec3(sqrt(md1), sqrt(md2) - sqrt(md1), id);
    }

    void main() {
      vec3 gn = normalize(vWNorm);
      if (!gl_FrontFacing) gn = -gn;

      float edgeThin = vTMatW.x;
      float plastW = vTMatW.y;
      float neckW = vTMatW.z;
      float grp = vTMatW.w;

      float isEye = step(4.5, grp) * step(grp, 5.5);
      float isBarnacle = step(5.5, grp);
      float isShell = step(grp, 0.5);
      float isSkin = step(0.5, grp) * step(grp, 4.5);

      TP tpMed = tri(vLPos * 8.0, gn);
      TP tpFine = tri(vLPos * 24.0, gn);

      vec3 alb = vec3(0.3);
      float reliefH = 0.0;
      float roughness = 0.28;
      float specStr = 0.52;
      float sssMask = 0.0;

      if (isShell > 0.5) {
        // ---- Carapace: Glossy Keratin Hexagonal Scutes with Sunburst Rays, Growth Rings & Emerald Algae Seams ----
        vec3 sc = turtleVoronoi(vLPos.xz * vec2(4.1, 3.5));
        float seamGroove = 1.0 - smoothstep(0.015, 0.095, sc.y);
        float centerGlow = smoothstep(0.52, 0.04, sc.x);
        // Radiating amber-chestnut sunburst keratin rays inside each individual scute plate!
        float rayAng = atan(vLPos.x * 1.4, vLPos.z + 0.1) + sc.z * 6.283;
        float sunburst = pow(0.5 + 0.5 * sin(rayAng * 14.0 + tpMed.h * 3.8), 1.4) * smoothstep(0.55, 0.08, sc.x);
        float growthRing = 0.5 + 0.5 * sin(sc.x * 38.0 + tpFine.h * 2.0);

        vec3 oliveBase = vec3(0.17, 0.24, 0.11);
        vec3 chestnut = vec3(0.38, 0.21, 0.08);
        vec3 goldenAmber = vec3(0.62, 0.44, 0.15);
        vec3 darkSeam = vec3(0.06, 0.05, 0.03);

        vec3 carCol = mix(oliveBase, chestnut, sc.z * 0.55 + centerGlow * 0.45);
        carCol = mix(carCol, goldenAmber, sunburst * 0.68 + growthRing * 0.14);
        // Pale warm golden-ochre marginal skirt scutes around outer rim of carapace
        float rimBand = smoothstep(0.52, 0.88, edgeThin);
        carCol = mix(carCol, vec3(0.58, 0.48, 0.26) * (0.82 + 0.30 * tpMed.h), rimBand * 0.52);
        // Deep shadowed keratin scute suture grooves + subtle emerald algae biofilm in rear crevices
        carCol = mix(carCol, darkSeam, seamGroove * 0.82);
        float rearAlgae = smoothstep(-0.1, -0.75, vLPos.z) * smoothstep(0.42, 0.76, tpMed.c) * (0.35 + 0.65 * seamGroove);
        carCol = mix(carCol, vec3(0.07, 0.22, 0.11), rearAlgae * 0.58);

        // ---- Plastron Underside: Warm Golden-Cream Belly Plates with Symmetrical Sutures ----
        float plMidSeam = exp(-pow(vLPos.x / 0.025, 2.0));
        float plCross = exp(-pow(sin(vLPos.z * 7.5) / 0.12, 2.0));
        float plSeam = clamp(max(plMidSeam, plCross * 0.7), 0.0, 1.0);
        vec3 plCol = mix(vec3(0.64, 0.58, 0.39), vec3(0.46, 0.40, 0.25), tpMed.h * 0.45 + plSeam * 0.55);

        alb = mix(carCol, plCol, plastW);
        reliefH = mix(
          (1.0 - seamGroove * 1.45) * 0.65 + growthRing * 0.16 + (tpFine.h - 0.5) * 0.18,
          -plSeam * 0.8 + (tpFine.h - 0.5) * 0.22,
          plastW
        );
        roughness = mix(0.20, 0.36, max(plastW, rearAlgae * 0.8));
        specStr = mix(0.68, 0.26, max(plastW, rearAlgae * 0.8));
      } else if (isSkin > 0.5) {
        // ---- Head, Wrinkled Neck & Flippers: 3D Polygonal Reptilian Keratin Scales! ----
        float scaleFreq = grp < 1.5 ? 16.5 : 13.5;
        vec3 sc = turtleVoronoi(vLPos.xz * scaleFreq + vec2(vLPos.y * 11.0, -vLPos.y * 9.0));
        float scaleCenter = smoothstep(0.06, 0.22, sc.y);
        float scalePillow = smoothstep(0.0, 0.26, sc.y);
        // Thick wrinkled leathery neck folds
        float neckWrinkle = sin(vLPos.z * 68.0 + tpMed.h * 4.5) * neckW;

        vec3 creaseOchre = vec3(0.54, 0.50, 0.33);
        vec3 darkScale = mix(vec3(0.11, 0.14, 0.08), vec3(0.24, 0.20, 0.10), sc.z);
        vec3 dorsalSkin = mix(creaseOchre, darkScale, scaleCenter * 0.90);
        // Paler creamy-ochre ventral underside of neck & flippers
        vec3 ventralSkin = mix(vec3(0.58, 0.54, 0.38), vec3(0.32, 0.31, 0.20), scaleCenter * 0.38);
        alb = mix(dorsalSkin, ventralSkin, plastW * 0.85);

        // Dark recessed nostril nares & hooked horny beak edge on snout tip
        if (grp < 1.5) {
          float nostrilD = length(vec3(abs(vLPos.x) - 0.024, vLPos.y - 0.048, vLPos.z - 1.28));
          alb = mix(alb, vec3(0.03, 0.035, 0.03), 1.0 - smoothstep(0.008, 0.016, nostrilD));
          float beakEdge = smoothstep(1.16, 1.32, vLPos.z) * smoothstep(0.04, -0.02, vLPos.y);
          alb = mix(alb, vec3(0.36, 0.31, 0.20), beakEdge * 0.65);
          // Subtle dark eyelid fold shadow around eyes
          float eyeAO = 1.0 - 0.42 * exp(-pow((abs(vLPos.x) - 0.128) / 0.055, 2.0) - pow((vLPos.y - 0.088) / 0.048, 2.0) - pow((vLPos.z - 1.115) / 0.060, 2.0));
          alb *= eyeAO;
        }

        reliefH = scalePillow * 0.95 + neckWrinkle * 0.55 + (tpFine.h - 0.5) * 0.22;
        roughness = mix(0.28, 0.38, plastW);
        specStr = 0.42;
        sssMask = edgeThin * 0.85;
      } else if (isBarnacle > 0.5) {
        // ---- Epibiont Turtle Barnacles (Chelonibia): Pale Calcified Star-Ribbed Volcanoes ----
        alb = mix(vec3(0.26, 0.28, 0.22), vec3(0.74, 0.72, 0.65), smoothstep(0.08, 0.65, edgeThin)) * (0.85 + 0.28 * tpFine.h);
        reliefH = tpFine.h * 0.85 + tpMed.h * 0.5;
        roughness = 0.62;
        specStr = 0.18;
      } else if (isEye > 0.5) {
        // ---- Lifelike Glossy Amber-Obsidian Sea Turtle Eye ----
        vec2 eRel = vec2((vLPos.z - 1.115) / 0.036, (vLPos.y - 0.088) / 0.034);
        float eR = length(eRel);
        float pupil = 1.0 - smoothstep(0.42, 0.58, eR);
        float iris = (1.0 - pupil) * (1.0 - smoothstep(0.75, 0.96, eR));
        alb = mix(vec3(0.02, 0.025, 0.02), vec3(0.32, 0.22, 0.09), iris);
        alb = mix(alb, vec3(0.004, 0.005, 0.007), pupil);
        roughness = 0.04;
        specStr = 1.75;
      }

      // True 4K-equivalent Mikkelsen surface-gradient micro-relief normal perturbation
      vec3 N = (isEye > 0.5) ? gn : perturbNormalBump(vWPos, gn, reliefH, isShell > 0.5 ? 0.016 : 0.014);

      float sh = shadow9(vWPos);
      vec3 caRaw = causRGB(vWPos);
      vec3 ca = caRaw / (1.0 + caRaw * 0.45);
      vec3 sunIrr = sunE(vWPos);
      vec3 V = normalize(uCamPos - vWPos);
      vec3 H = normalize(V + uSunDir);
      float ndl = max(dot(N, uSunDir), 0.0);
      float ndh = max(dot(N, H), 0.0);
      float wrapNdl = max(0.0, (dot(N, uSunDir) + 0.15) / 1.15);

      // Dual-lobe wet keratin/scale GGX specular + mirror clearcoat glint
      float alphaSq = pow(roughness, 4.0);
      float denom = ndh * ndh * (alphaSq - 1.0) + 1.0;
      float D_ggx = alphaSq / max(3.14159 * denom * denom, 1e-4);
      float fres = 0.03 + 0.97 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
      float wetSpec = (D_ggx * fres * specStr + pow(ndh, 90.0) * 0.26 * (1.0 - isBarnacle)) * sh;

      // Sandy reef bounce light illuminating the golden plastron & flipper undersides + thin flipper SSS
      vec3 bellyBounce = vec3(0.22, 0.26, 0.22) * max(-N.y, 0.0) * (0.6 + 0.6 * plastW);
      float backLight = pow(clamp(dot(-V, uSunDir + N * 0.4), 0.0, 1.0), 2.5);
      vec3 sss = vec3(0.36, 0.48, 0.26) * sunIrr * backLight * sssMask * (0.45 + 0.55 * sh) * 0.55;

      vec3 lit = alb * (sunIrr * wrapNdl * sh * (0.58 + 1.32 * ca) + amb(vWPos, N) * 1.12 + sideLight(vWPos, N) + bellyBounce)
        + sunIrr * (0.35 + ca * 0.95) * wetSpec
        + sss;
      fragColor = vec4(fog(lit, vWPos), 1.0);
    }
  `;

  const turtleShadowFs = /* glsl */ `
    precision highp float;
    layout(location = 0) out vec4 fragColor;
    void main() { fragColor = vec4(1.0); }
  `;

  const turtleMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: turtleVs,
    fragmentShader: turtleFs,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
  }), sharedUniforms);
  const turtleShadowMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: turtleVs,
    fragmentShader: turtleShadowFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    colorWrite: false,
  }), sharedUniforms);

  const turtleMesh = new THREE.Mesh(turtleGeo, turtleMat);
  turtleMesh.frustumCulled = false;
  const turtleShadowMesh = new THREE.Mesh(turtleGeo, turtleShadowMat);
  turtleShadowMesh.frustumCulled = false;
  group.add(turtleMesh);
  shadowGroup.add(turtleShadowMesh);

  // ---- 5. 22 Bioluminescent Translucent Moon Jellyfish (Aurelia) ----
  const jellyBaseGeo = buildJellyfishGeometry();
  const jellyGeo = new THREE.InstancedBufferGeometry();
  jellyGeo.index = jellyBaseGeo.index;
  jellyGeo.attributes.position = jellyBaseGeo.attributes.position;
  jellyGeo.attributes.normal = jellyBaseGeo.attributes.normal;
  jellyGeo.attributes.aJMeta = jellyBaseGeo.attributes.aJMeta;

  rseed(77209);
  const jellyClusters = [
    // Purple Grotto arch & twilight chamber (Vista 5)
    { cx: 6.0, cy: -34.2, cz: 78.0, rx: 8.5, ry: 3.2, rz: 12.0, n: 9 },
    // Blue Hole luminous shaft chamber (Vista 7)
    { cx: 59.0, cy: -28.5, cz: 64.0, rx: 8.5, ry: 5.5, rz: 8.5, n: 7 },
    // Sponge Canyon deep mystic drift (Vista 4)
    { cx: -58.0, cy: -28.5, cz: -4.0, rx: 10.5, ry: 4.8, rz: 13.0, n: 6 },
  ];
  const jellyPosList = [];
  for (const cl of jellyClusters) {
    for (let k = 0; k < cl.n; k++) {
      let placed = false;
      for (let t = 0; t < 16; t++) {
        const x = cl.cx + (rnd() - 0.5) * 2 * cl.rx;
        const y = cl.cy + (rnd() - 0.5) * 2 * cl.ry;
        const z = cl.cz + (rnd() - 0.5) * 2 * cl.rz;
        if (terrain.dw(x, y, z) < -2.6 && y < -4.5) {
          jellyPosList.push([x, y, z, 0.72 + rnd() * 0.62, rnd() * 6.283, 1.35 + rnd() * 0.65, rnd()]);
          placed = true;
          break;
        }
      }
      if (!placed) {
        jellyPosList.push([cl.cx, cl.cy, cl.cz, 0.9, rnd() * 6.283, 1.6, rnd()]);
      }
    }
  }
  const nJellies = jellyPosList.length;
  jellyGeo.instanceCount = nJellies;
  const jPosArr = new Float32Array(nJellies * 4);
  const jMetaArr = new Float32Array(nJellies * 4);
  for (let i = 0; i < nJellies; i++) {
    const jp = jellyPosList[i];
    jPosArr.set([jp[0], jp[1], jp[2], jp[3]], i * 4);
    jMetaArr.set([jp[4], jp[5], jp[6], i / Math.max(1, nJellies)], i * 4);
  }
  jellyGeo.setAttribute('iJPos', new THREE.InstancedBufferAttribute(jPosArr, 4));
  jellyGeo.setAttribute('iJMeta', new THREE.InstancedBufferAttribute(jMetaArr, 4));
  jellyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), 220);

  const jellyVs = /* glsl */ `
    attribute vec3 aJMeta; // x=part(0 bell, 1 oral, 2 tentacle), y=u(0..1), z=ang
    attribute vec4 iJPos;  // xyz=anchor, w=scale
    attribute vec4 iJMeta; // x=phase, y=freq, z=hueSeed, w=idxNorm
    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vJMeta;
    out float vHue;
    out float vPulse;

    void main() {
      float ph = uTime * iJMeta.y + iJMeta.x;
      float sc = iJPos.w;
      float part = aJMeta.x;
      float u = aJMeta.y;
      float ang = aJMeta.z;

      // Gentle buoyant drift + pulsing jet heave
      vec3 drift = vec3(
        sin(uTime * 0.22 + iJMeta.x * 2.1) * 1.45,
        sin(uTime * 0.34 + iJMeta.x) * 0.95 + 0.22 * sin(ph - 0.8),
        cos(uTime * 0.19 + iJMeta.x * 1.7) * 1.45
      );
      vec3 center = iJPos.xyz + drift;

      vec3 lp = position;
      float pulse = sin(ph);
      if (part < 0.5) {
        // Bell radial contraction wave propagating from apex -> scalloped rim
        float wave = sin(ph - u * 1.65);
        float expand = 1.0 + wave * 0.20 * pow(u, 1.15);
        lp.xz *= expand;
        lp.y *= 1.0 - wave * 0.14 * (1.0 - u * 0.4);
      } else {
        // Oral arms & trailing marginal tentacles: trailing sinusoidal fluid sway + diver wake push
        float lag = part < 1.5 ? 1.8 : 2.6;
        float swayAmp = (part < 1.5 ? 0.08 : 0.16) * pow(u, 1.25);
        lp.x += sin(ph * 0.85 - u * lag + ang) * swayAmp;
        lp.z += cos(ph * 0.78 - u * lag + ang * 1.3) * swayAmp;
        lp.xz *= 1.0 + sin(ph - 1.5) * 0.14 * (1.0 - u * 0.6);
      }

      // Gentle tilt along horizontal drift velocity
      float tiltX = cos(uTime * 0.22 + iJMeta.x * 2.1) * 0.16;
      float tiltZ = -sin(uTime * 0.19 + iJMeta.x * 1.7) * 0.16;
      lp.xz += vec2(tiltX, tiltZ) * lp.y;

      vec3 wp = center + lp * sc;

      // Subtle diver wake drift when swimming past jellyfish
      vec3 toJ = wp - uCamPos;
      float dCam = length(toJ);
      if (dCam < 5.5 && part > 0.5) {
        float wPush = smoothstep(5.5, 0.8, dCam) * u;
        wp += (normalize(toJ + vec3(1e-4)) * 0.45 + uSwimmerVel * 0.14) * wPush;
      }

      vWPos = wp;
      vWNorm = normalize(normal);
      vJMeta = aJMeta;
      vHue = iJMeta.z;
      vPulse = 0.5 + 0.5 * pulse;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const jellyFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vJMeta;
    in float vHue;
    in float vPulse;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 N = normalize(vWNorm);
      if (!gl_FrontFacing) N = -N;
      vec3 V = normalize(uCamPos - vWPos);
      float fres = pow(1.0 - abs(dot(N, V)), 2.0);
      float part = vJMeta.x;
      float u = vJMeta.y;
      float ang = vJMeta.z;

      // Bioluminescent cyan-aqua, amethyst-violet, and rose-magenta palette
      vec3 cAqua = vec3(0.24, 0.88, 1.00);
      vec3 cViol = vec3(0.72, 0.34, 1.00);
      vec3 cRose = vec3(1.00, 0.38, 0.78);
      vec3 baseCol = mix(mix(cAqua, cViol, smoothstep(0.0, 0.6, vHue)), cRose, smoothstep(0.55, 1.0, vHue));

      float glow = 0.0;
      vec3 col = baseCol;
      if (part < 0.5) {
        // Translucent bell: glowing Fresnel rim + 4-leaf clover gonad rings near apex
        float gonad = exp(-pow((u - 0.34) * 7.5, 2.0)) * (0.45 + 0.55 * pow(0.5 + 0.5 * cos(ang * 4.0), 2.0));
        float rimGlow = smoothstep(0.62, 1.0, u) * 0.75;
        float pulseFlash = 0.78 + 0.35 * vPulse;
        col = mix(baseCol, vec3(1.0, 0.78, 0.94), gonad * 0.75);
        glow = (0.14 + fres * 0.88 + rimGlow * 0.55 + gonad * 0.78) * pulseFlash;
      } else if (part < 1.5) {
        // Ruffled oral arms: warm luminous core fading gently toward tips
        col = mix(baseCol * 1.15, vec3(1.0, 0.62, 0.88), 0.42);
        glow = (0.42 + 0.38 * fres) * (1.0 - u * 0.65);
      } else {
        // Delicate trailing marginal tentacles
        col = mix(baseCol, vec3(0.82, 0.95, 1.0), 0.35);
        glow = 0.36 * (1.0 - u * 0.78);
      }

      // Attenuate cleanly with underwater distance fog so distant jellies dissolve naturally
      float dist = length(vWPos - uCamPos);
      float atten = exp(-dist * 0.028) * smoothstep(95.0, 18.0, dist);
      vec3 outCol = col * glow * atten * 0.78;
      fragColor = vec4(outCol, clamp(glow * atten * 0.85, 0.0, 0.92));
    }
  `;

  const jellyMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: jellyVs,
    fragmentShader: jellyFs,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }), sharedUniforms);
  const jellyMesh = new THREE.Mesh(jellyGeo, jellyMat);
  jellyMesh.frustumCulled = false;
  jellyMesh.renderOrder = 14;
  group.add(jellyMesh);

  // ---- 6. ~115 Shy Spotted Garden Eels (Heteroconger hassi) with Burrow Retraction ----
  const eelBaseGeo = buildGardenEelGeometry();
  const eelGeo = new THREE.InstancedBufferGeometry();
  eelGeo.index = eelBaseGeo.index;
  eelGeo.attributes.position = eelBaseGeo.attributes.position;
  eelGeo.attributes.normal = eelBaseGeo.attributes.normal;
  eelGeo.attributes.aEelT = eelBaseGeo.attributes.aEelT;

  rseed(91537);
  const eelColonies = [
    { cx: 2.0, cz: -6.0, r: 9.5, n: 34 },     // Main Coral Canyon sandy floor (Vista 1 & 2)
    { cx: 54.0, cz: 18.0, r: 8.5, n: 28 },    // Shipwreck Cove sunlit sand (Vista 3)
    { cx: 6.0, cz: 70.0, r: 7.0, n: 26 },     // Purple Grotto sunlit sand approach (Vista 5)
    { cx: 62.5, cz: -30.5, r: 8.5, n: 28 },   // Fighter Wreck sandy apron (Vista 8)
  ];
  const eelPosList = [];
  const eGrad = new THREE.Vector3();
  for (const col of eelColonies) {
    let count = 0;
    for (let tries = 0; tries < col.n * 10 && count < col.n; tries++) {
      const ang = rnd() * Math.PI * 2;
      const rad = Math.sqrt(rnd()) * col.r;
      const x = col.cx + Math.cos(ang) * rad;
      const z = col.cz + Math.sin(ang) * rad;
      // Keep Fighter Wreck fuselage/wing bed clear
      if (Math.hypot(x - 71.0, z + 25.0) < 9.2) continue;
      const y = terrain.gy(x, z);
      if (y > -12.0 || y < -46.5) continue;
      if (Math.abs(terrain.dw(x, y, z)) > 0.35) continue;
      terrain.grad(x, y, z, eGrad);
      // Only colonize open sandy seafloor (upward normal > 0.72)
      if (eGrad.y < 0.72) continue;
      eelPosList.push([x, y - 0.03, z, 0.82 + rnd() * 0.38, rnd() * 6.283, rnd()]);
      count++;
    }
  }
  const nGardenEels = eelPosList.length;
  eelGeo.instanceCount = nGardenEels;
  const ePosArr = new Float32Array(nGardenEels * 4);
  const eMetaArr = new Float32Array(nGardenEels * 4);
  for (let i = 0; i < nGardenEels; i++) {
    const ep = eelPosList[i];
    ePosArr.set([ep[0], ep[1], ep[2], ep[3]], i * 4);
    eMetaArr.set([ep[4], ep[5], 0.0, 0.0], i * 4);
  }
  eelGeo.setAttribute('iEelPos', new THREE.InstancedBufferAttribute(ePosArr, 4));
  eelGeo.setAttribute('iEelMeta', new THREE.InstancedBufferAttribute(eMetaArr, 4));
  eelGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -30, 0), 220);

  const eelVs = /* glsl */ `
    attribute float aEelT;
    attribute vec4 iEelPos;  // xyz=sand burrow root, w=scale
    attribute vec4 iEelMeta; // x=yaw/phase, y=seed
    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out float vEelT;
    out float vLocalY;
    flat out float vSeed;

    void main() {
      vec3 root = iEelPos.xyz;
      float sc = iEelPos.w;
      float ph = iEelMeta.x;
      float seed = iEelMeta.y;

      // Shy proximity trigger: smoothly retract down into sand burrow when Diver, Shark, or Whale nears
      float dMin = distance(root, uCamPos);
      if (uSharkWake.w > 0.1) dMin = min(dMin, distance(root, uSharkWake.xyz) * 0.85);
      if (uWhaleBody0.w > 0.1) dMin = min(dMin, distance(root, uWhaleBody0.xyz) * 0.72);
      float emerge = smoothstep(2.5, 7.6, dMin);

      // Current-facing orientation + gentle S-curve plankton-feeding sway
      float yaw = 0.55 + (seed - 0.5) * 0.65;
      float cy = cos(yaw);
      float sy = sin(yaw);

      vec3 lp = position * sc;
      float flex = aEelT * aEelT;
      float swayX = sin(uTime * 1.45 + ph + aEelT * 2.4) * 0.085 * flex * emerge;
      float swayZ = cos(uTime * 1.15 + ph * 1.3 + aEelT * 2.1) * 0.065 * flex * emerge;
      // Subtle plankton-pecking head nod when safely emerged
      float peck = sin(uTime * 2.4 + seed * 37.0) * 0.025 * smoothstep(0.65, 1.0, aEelT) * emerge;
      lp.x += swayX;
      lp.z += swayZ + peck;

      // Retract vertically down into sand burrow (up to 0.82m below floor)
      float burrowDrop = (1.0 - emerge) * (0.82 * sc);
      lp.y -= burrowDrop;

      vec3 rotP = vec3(lp.x * cy - lp.z * sy, lp.y, lp.x * sy + lp.z * cy);
      vec3 rotN = normalize(vec3(normal.x * cy - normal.z * sy, normal.y, normal.x * sy + normal.z * cy));
      vec3 wp = root + rotP;

      vWPos = wp;
      vWNorm = rotN;
      vEelT = aEelT;
      vLocalY = lp.y;
      vSeed = seed;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }
  `;

  const eelFs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${MEDIUM_GLSL}
    in vec3 vWPos;
    in vec3 vWNorm;
    in float vEelT;
    in float vLocalY;
    flat in float vSeed;
    layout(location = 0) out vec4 fragColor;

    float eelNoise3(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float n = dot(i, vec3(1.0, 57.0, 113.0));
      return mix(
        mix(mix(fract(sin(n) * 43758.5), fract(sin(n + 1.0) * 43758.5), f.x),
            mix(fract(sin(n + 57.0) * 43758.5), fract(sin(n + 58.0) * 43758.5), f.x), f.y),
        mix(mix(fract(sin(n + 113.0) * 43758.5), fract(sin(n + 114.0) * 43758.5), f.x),
            mix(fract(sin(n + 170.0) * 43758.5), fract(sin(n + 171.0) * 43758.5), f.x), f.y),
        f.z
      );
    }

    void main() {
      // Clip cleanly at the sand burrow entrance so retracted eel segments vanish below sand
      if (vLocalY < -0.02) discard;

      vec3 N = normalize(vWNorm);
      if (!gl_FrontFacing) N = -N;
      vec3 V = normalize(uCamPos - vWPos);

      // Spotted Garden Eel (Heteroconger hassi): ivory-silver body speckled with dark slate dots & 2 larger blotches
      float speck = smoothstep(0.56, 0.72, eelNoise3(vec3(vWPos.xz * 26.0, vEelT * 34.0 + vSeed * 19.0)));
      float blotch1 = exp(-pow((vEelT - 0.52) * 18.0, 2.0));
      float blotch2 = exp(-pow((vEelT - 0.78) * 20.0, 2.0));
      vec3 alb = mix(vec3(0.76, 0.75, 0.69), vec3(0.14, 0.15, 0.16), speck * 0.78);
      alb = mix(alb, vec3(0.06, 0.06, 0.07), clamp((blotch1 + blotch2) * 0.85, 0.0, 0.88));
      // Subtle dark eye ring near tip
      float eyeBand = smoothstep(0.91, 0.96, vEelT) * (1.0 - smoothstep(0.96, 0.99, vEelT));
      alb = mix(alb, vec3(0.03, 0.035, 0.04), eyeBand * 0.65);

      float sh = shadow1(vWPos);
      float ca = caus(vWPos);
      vec3 E = sunE(vWPos) * sh;
      vec3 lit = alb * (E * (0.28 + 0.75 * sat(dot(N, uSunDir))) * (0.72 + 0.95 * ca) + amb(vWPos, N) * 1.2 + sideLight(vWPos, N));
      lit += E * pow(sat(dot(N, normalize(V + uSunDir))), 24.0) * 0.25;
      fragColor = vec4(fog(lit, vWPos), 1.0);
    }
  `;

  const eelMat = bindSharedUniforms(new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: eelVs,
    fragmentShader: eelFs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  }), sharedUniforms);
  const eelMesh = new THREE.Mesh(eelGeo, eelMat);
  eelMesh.frustumCulled = false;
  group.add(eelMesh);

  const nSeabirds = 48;
  const seabirdMesh = buildSeabirds(sharedUniforms, nSeabirds);
  group.add(seabirdMesh);

  return {
    group,
    shadowGroup,
    stats: {
      mantas: nMantas,
      fish: totalFish,
      clownfish: nClownfish,
      turtles: nTurtles,
      jellyfish: nJellies,
      gardenEels: nGardenEels,
      seabirds: nSeabirds,
    },
  };
}
