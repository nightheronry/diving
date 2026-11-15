import * as THREE from 'three';
import { MEDIUM_GLSL } from './env/medium.js';
import { bindSharedUniforms, rseed, rnd, rr } from './env/terrain.js';

// ============================================================================
// AAA-Grade Anatomical Shark Builder
// High-Res Sculpted Fusiform Body + Seamless Filleted Hydrofoil Fins +
// 5 Branchial Gill Arches + Recessed Nostril Nares + Jaws/Gingiva/Teeth +
// Supraorbital Brow Socket & Iris/Pupil + Pre-Caudal Lateral Keels
// ============================================================================
function buildAnatomicalSharkGeometry() {
  const pos = [];
  const spineCoord = []; // vec2(tAlongSpine, swimAmpWeight)
  const partId = []; // 0 = dermal skin, 1 = eye/iris, 2 = gill slit interior, 3 = enamel teeth, 4 = inner mouth/gingiva, 5 = thin fin trailing edge
  const idx = [];

  function pushV(x, y, z, t, sw, part = 0) {
    const id = pos.length / 3;
    pos.push(x, y, z);
    spineCoord.push(t, sw);
    partId.push(part);
    return id;
  }

  // ---- 1. High-Resolution Continuous Body Fusiform Loft (Nose at +Z = +3.25, Peduncle at -Z = -2.30) ----
  const nLen = 96;
  const nRad = 48;
  const bodyRings = [];

  function bodyRadius(t) {
    if (t < 0.035) {
      return Math.pow(Math.max(0.008, t / 0.035), 0.54) * 0.22;
    } else if (t < 0.31) {
      const u = (t - 0.035) / 0.275;
      return 0.22 + Math.sin(u * Math.PI * 0.5) * 0.45;
    } else if (t < 0.84) {
      const u = (t - 0.31) / 0.53;
      return 0.67 * (1.0 - Math.pow(u, 1.38) * 0.83);
    } else {
      const u = (t - 0.84) / 0.16;
      return Math.max(0.032, 0.114 * (1.0 - u * 0.72));
    }
  }

  for (let i = 0; i <= nLen; i++) {
    const t = i / nLen;
    const z = 3.25 - t * 5.55; // +3.25 (snout tip) -> -2.30 (caudal peduncle root)
    const baseR = bodyRadius(t);

    // Pre-caudal lateral keels along peduncle (t in [0.74..0.96])
    const pedFactor = Math.max(0, (t - 0.65) / 0.35);
    const keelBulge = t > 0.74 && t < 0.96 ? Math.sin(((t - 0.74) / 0.22) * Math.PI) * 0.065 : 0.0;
    const rx = baseR * (0.88 + 0.18 * Math.sin(t * Math.PI)) * (1.0 - 0.18 * pedFactor) + keelBulge;
    const ry = baseR * (1.14 - 0.24 * pedFactor);

    // Conical predatory rostrum overhang & powerful dorsal muscular hump over pectoral girdle
    const centerY = t < 0.14
      ? 0.02 - 0.05 * Math.pow(1.0 - t / 0.14, 1.8)
      : Math.sin(t * Math.PI) * 0.085 + (t > 0.22 && t < 0.48 ? Math.sin(((t - 0.22) / 0.26) * Math.PI) * 0.035 : 0.0);

    // Biomechanical carangiform wave envelope
    const sw = t < 0.20 ? 0.03 * (t / 0.20) : 0.03 + 0.97 * Math.pow((t - 0.20) / 0.80, 1.72);

    const ring = [];
    for (let s = 0; s < nRad; s++) {
      const a = (s / nRad) * Math.PI * 2; // 0 = dorsal (+Y), pi = belly (-Y)
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const absSa = Math.abs(sa);

      let x = sa * rx;
      let y = centerY + ca * ry;
      let pType = 0;

      // Flattened conical underside of snout (rostrum)
      if (t < 0.16 && ca < -0.15) {
        const flatW = (1.0 - t / 0.16) * Math.min(1.0, (-ca - 0.15) / 0.65);
        y = centerY + ca * ry * (1.0 - 0.32 * flatW);
      }

      // Supraorbital brow ridge & recessed eye socket at t ~ 0.095, ca ~ 0.18
      if (t > 0.065 && t < 0.130 && absSa > 0.72 && ca > -0.05 && ca < 0.48) {
        const dtEye = (t - 0.096) / 0.028;
        const daEye = (ca - 0.16) / 0.22;
        const rEye2 = dtEye * dtEye + daEye * daEye;
        if (rEye2 < 1.2) {
          const brow = daEye > 0.2 ? Math.exp(-rEye2 * 2.2) * 0.028 : -Math.exp(-rEye2 * 2.8) * 0.022;
          x += Math.sign(sa) * brow;
        }
      }

      // Nostril nares (nasal flaps) under rostrum at t ~ 0.048
      if (t > 0.038 && t < 0.060 && absSa > 0.35 && absSa < 0.72 && ca < -0.45) {
        y += 0.018;
        pType = 2;
      }

      // Broad flatten belly in chest/midsection with paired ventral muscular ridges
      if (ca < -0.1 && t > 0.14 && t < 0.72) {
        y = centerY + ca * ry * 0.84;
      }

      // Lateral line muscular myomere groove & epaxial/hypaxial muscle definition along flank
      if (t > 0.18 && t < 0.88 && absSa > 0.82 && Math.abs(ca - 0.08) < 0.28) {
        const latGroove = Math.exp(-Math.pow((ca - 0.08) / 0.08, 2.0)) * 0.012;
        const muscleBulge = Math.exp(-Math.pow((ca - 0.26) / 0.16, 2.0)) * 0.022;
        x += Math.sign(sa) * (muscleBulge - latGroove);
      }

      // Sharp lateral caudal keel ridge on peduncle (t in [0.76..0.96])
      if (t > 0.76 && t < 0.96 && absSa > 0.88 && Math.abs(ca) < 0.26) {
        const keelPinch = Math.pow(Math.max(0, 1.0 - Math.abs(ca) / 0.26), 2.0) * keelBulge * 0.85;
        x += Math.sign(sa) * keelPinch;
      }

      // Deep predatory crescent mouth cavity & upper/lower jaw arch (t in [0.065, 0.155])
      if (t > 0.062 && t < 0.155 && ca < -0.42) {
        const uMouth = (t - 0.062) / 0.093;
        const mw = Math.sin(uMouth * Math.PI) * Math.min(1.0, (-ca - 0.42) / 0.38);
        // Carve recessed oral cavity & labial furrow
        y += mw * 0.105;
        x *= 1.0 - mw * 0.11;
        pType = (uMouth > 0.18 && uMouth < 0.82 && ca < -0.62) ? 4 : 2;
      }

      // Five sculpted 3D branchial gill slits & overlapping gill septa (t in [0.20..0.305])
      if (t > 0.200 && t < 0.305 && absSa > 0.72 && ca > -0.46 && ca < 0.38) {
        const gillCoord = ((t - 0.200) / 0.105) * 5.0;
        const gillIdx = Math.floor(gillCoord);
        const gillFrac = gillCoord - gillIdx;
        const vertEnv = Math.sin(((ca + 0.46) / 0.84) * Math.PI);
        if (gillIdx >= 0 && gillIdx < 5 && vertEnv > 0.05) {
          // Fleshy anterior gill flap overlapping recessed dark branchial slit
          if (gillFrac > 0.58 && gillFrac < 0.88) {
            const depth = Math.sin(((gillFrac - 0.58) / 0.30) * Math.PI) * vertEnv;
            x *= 1.0 - 0.095 * depth;
            pType = 2;
          } else if (gillFrac <= 0.58) {
            const bulge = Math.sin((gillFrac / 0.58) * Math.PI) * vertEnv;
            x *= 1.0 + 0.022 * bulge;
          }
        }
      }

      ring.push(pushV(x, y, z, t, sw, pType));
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

  // Cap snout tip smoothly
  const noseTip = pushV(0, 0.015, 3.31, 0.0, 0.0, 0);
  const firstR = bodyRings[0];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(noseTip, firstR[ns], firstR[s]);
  }

  // ---- 1b. Upper & Lower Serrated Triangular Enamel Teeth Rows inside Jaw (partId = 3) ----
  const nTeeth = 14;
  for (let row = 0; row < 2; row++) {
    const isUpper = row === 0;
    for (let k = 0; k < nTeeth; k++) {
      const u = (k / (nTeeth - 1)) * 2.0 - 1.0; // -1 (left corner) -> +1 (right corner)
      const arc = 1.0 - u * u;
      const tz = (isUpper ? 2.86 : 2.79) - (1.0 - arc) * 0.34;
      const tx = u * (isUpper ? 0.24 : 0.21);
      const ty = (isUpper ? -0.19 : -0.26) + (1.0 - arc) * 0.04;
      const tSpine = (3.25 - tz) / 5.55;
      const sw = 0.03 * (tSpine / 0.20);
      const wT = 0.012 * (0.7 + 0.3 * arc);
      const hT = (isUpper ? -0.036 : 0.030) * (0.75 + 0.25 * arc);

      const b0 = pushV(tx - wT, ty, tz, tSpine, sw, 3);
      const b1 = pushV(tx + wT, ty, tz, tSpine, sw, 3);
      const b2 = pushV(tx, ty, tz - wT * 0.9, tSpine, sw, 3);
      const tip = pushV(tx, ty + hT, tz + 0.004, tSpine, sw, 3);
      idx.push(b0, b1, tip, b1, b2, tip, b2, b0, tip);
    }
  }

  // Helper to loft swept NACA hydrofoil fins with organic root fillets & thin trailing edge SSS tag
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
    steps = 16,
    segs = 18,
    tBase = 0.4,
    tTip = 0.45,
    curvePow = 0.88,
    hasNotch = false,
  }) {
    function buildSide(sign) {
      const rings = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps; // 0 = filleted root, 1 = fin tip
        // Falcate curved leading edge & concave trailing edge
        const leadCurve = Math.pow(u, 1.12);
        const trailCurve = Math.pow(u, 0.82);
        let zFront = rootFrontZ * (1 - leadCurve) + (rootFrontZ - sweepBack) * leadCurve;
        let zBack = rootBackZ * (1 - trailCurve) + (rootFrontZ - sweepBack - chordTip) * trailCurve;

        // Authentic subterminal notch near upper caudal fin tip (u in [0.76..0.90])
        if (hasNotch && u > 0.75 && u < 0.91) {
          const nw = Math.sin(((u - 0.75) / 0.16) * Math.PI);
          zBack += nw * 0.085;
        }

        const chord = Math.max(0.035, zFront - zBack);
        const px = sign * (rootPos[0] + tipOffset[0] * Math.pow(u, 0.94));
        const py = rootPos[1] + tipOffset[1] * Math.pow(u, curvePow);

        // Smooth anatomical root fillet flare for u < 0.22 so fin merges organically into body
        const fillet = u < 0.22 ? Math.pow(1.0 - u / 0.22, 2.0) * 1.45 : 0.0;
        const thick = (thickRoot * (1 - u) + thickTip * u) * (1.0 + fillet);
        const t = tBase + (tTip - tBase) * u;
        const sw = t < 0.20 ? 0.03 * (t / 0.20) : 0.03 + 0.97 * Math.pow((t - 0.20) / 0.80, 1.72);

        const ring = [];
        for (let j = 0; j < segs; j++) {
          const a = (j / segs) * Math.PI * 2;
          const uChord = Math.cos(a) * 0.5 + 0.5; // 0 = razor trailing edge, 1 = rounded leading edge
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
          const vy = py + (isVertical ? 0 : foilOff * (sign > 0 ? 1 : -1));
          // Tag trailing edge & outer fin tip (partId = 5) for translucent SSS & dark edge pigmentation
          const finEdgeTag = (uChord < 0.28 || u > 0.72) ? 5.0 : 0.0;
          ring.push(pushV(vx, vy, localZ, t, sw, finEdgeTag));
        }
        rings.push(ring);
      }

      for (let i = 0; i < steps; i++) {
        const r0 = rings[i];
        const r1 = rings[i + 1];
        for (let j = 0; j < segs; j++) {
          const nj = (j + 1) % segs;
          if (sign > 0) idx.push(r0[j], r0[nj], r1[nj], r0[j], r1[nj], r1[j]);
          else idx.push(r0[j], r1[nj], r0[nj], r0[j], r1[j], r1[nj]);
        }
      }
    }

    buildSide(1);
    if (mirrorX) buildSide(-1);
  }

  // ---- 2. First Dorsal Fin (Iconic tall falcate apex blade) ----
  addFin({
    rootFrontZ: 1.22,
    rootBackZ: 0.14,
    rootPos: [0, 0.44],
    tipOffset: [0, 0.96],
    sweepBack: 0.96,
    chordTip: 0.18,
    thickRoot: 0.115,
    thickTip: 0.012,
    mirrorX: false,
    steps: 18,
    segs: 20,
    tBase: 0.39,
    tTip: 0.49,
  });

  // ---- 3. Second Dorsal Fin & Anal Fin ----
  addFin({
    rootFrontZ: -0.96,
    rootBackZ: -1.38,
    rootPos: [0, 0.18],
    tipOffset: [0, 0.30],
    sweepBack: 0.36,
    chordTip: 0.08,
    thickRoot: 0.042,
    thickTip: 0.007,
    mirrorX: false,
    tBase: 0.78,
    tTip: 0.83,
  });

  addFin({
    rootFrontZ: -1.06,
    rootBackZ: -1.40,
    rootPos: [0, -0.15],
    tipOffset: [0, -0.25],
    sweepBack: 0.30,
    chordTip: 0.075,
    thickRoot: 0.038,
    thickTip: 0.007,
    mirrorX: false,
    tBase: 0.79,
    tTip: 0.84,
  });

  // ---- 4. Falcate Pectoral Wings (Broad swept hydrofoils) ----
  addFin({
    rootFrontZ: 1.58,
    rootBackZ: 0.76,
    rootPos: [0.36, -0.25],
    tipOffset: [1.42, -0.38],
    sweepBack: 1.18,
    chordTip: 0.14,
    thickRoot: 0.105,
    thickTip: 0.011,
    mirrorX: true,
    steps: 18,
    segs: 20,
    tBase: 0.31,
    tTip: 0.43,
  });

  // ---- 5. Pelvic Stabilizer Fins ----
  addFin({
    rootFrontZ: 0.06,
    rootBackZ: -0.36,
    rootPos: [0.22, -0.26],
    tipOffset: [0.38, -0.22],
    sweepBack: 0.36,
    chordTip: 0.075,
    thickRoot: 0.042,
    thickTip: 0.008,
    mirrorX: true,
    tBase: 0.58,
    tTip: 0.64,
  });

  // ---- 6. Asymmetric Crescent Caudal Tail Fin (Upper Lobe with Subterminal Notch + Lower Lobe) ----
  addFin({
    rootFrontZ: -2.08,
    rootBackZ: -2.48,
    rootPos: [0, 0.03],
    tipOffset: [0, 1.16],
    sweepBack: 0.98,
    chordTip: 0.13,
    thickRoot: 0.082,
    thickTip: 0.008,
    mirrorX: false,
    steps: 18,
    segs: 20,
    tBase: 0.94,
    tTip: 1.07,
    hasNotch: true,
  });

  addFin({
    rootFrontZ: -2.10,
    rootBackZ: -2.46,
    rootPos: [0, -0.02],
    tipOffset: [0, -0.84],
    sweepBack: 0.72,
    chordTip: 0.11,
    thickRoot: 0.075,
    thickTip: 0.008,
    mirrorX: false,
    steps: 16,
    segs: 18,
    tBase: 0.94,
    tTip: 1.04,
  });

  // ---- 7. Multi-Ring Glossy Ocular Eyes tucked under Supraorbital Brow ----
  const eyeGeo = new THREE.SphereGeometry(0.062, 16, 12);
  const eyePos = eyeGeo.getAttribute('position');
  const eyeIdx = eyeGeo.index;
  for (const side of [-1, 1]) {
    const baseV = pos.length / 3;
    const ex = side * 0.265;
    const ey = 0.068;
    const ez = 2.72;
    for (let i = 0; i < eyePos.count; i++) {
      pushV(
        ex + eyePos.getX(i) * 0.72,
        ey + eyePos.getY(i) * 0.96,
        ez + eyePos.getZ(i) * 1.06,
        0.095,
        0.015,
        1
      );
    }
    for (let i = 0; i < eyeIdx.count; i += 3) {
      idx.push(baseV + eyeIdx.getX(i), baseV + eyeIdx.getX(i + 1), baseV + eyeIdx.getX(i + 2));
    }
  }
  eyeGeo.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSpineCoord', new THREE.Float32BufferAttribute(spineCoord, 2));
  geo.setAttribute('aPartId', new THREE.Float32BufferAttribute(partId, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================================
// AAA Shark Materials (Arc-Length Spinal Kinematics + Dermal Denticle Anisotropic
// Velvet Sheen + Fin-Edge Subsurface Scattering + Multi-Zone Ocular Eye)
// ============================================================================
const SHARK_WAVE_GLSL = `
  vec3 sharkDeform(vec3 p, vec2 sc, float phase) {
    float t = sc.x;
    float w = sc.y;
    // Secondary hydrodynamic phase lag on outer fin tips
    float tipLag = max(0.0, abs(p.y) - 0.35) * 0.55 + max(0.0, abs(p.x) - 0.45) * 0.35;
    float kPhase = phase - t * 6.4 - tipLag;
    float wave = sin(kPhase);
    float dWaveDt = -6.4 * cos(kPhase);

    // Subtle counter-yaw of head/rostrum balancing tail thrust
    float headCounter = (1.0 - smoothstep(0.0, 0.25, t)) * sin(phase + 0.4) * 0.035;
    float latOffset = wave * 0.45 * w + headCounter;

    // Arc-length-preserving spinal tangent rotation in XZ plane
    float yawAng = clamp(dWaveDt * 0.075 * w, -0.52, 0.52);
    float cy = cos(yawAng);
    float sy = sin(yawAng);
    float rx = p.x * cy + p.z * sy * 0.08;
    p.x = rx + latOffset;

    // Subtle rhythmic gill-arch breathing expansion at t in [0.20..0.31]
    float gillBreath = exp(-pow((t - 0.25) / 0.045, 2.0)) * (0.5 + 0.5 * sin(phase * 0.65)) * 0.022;
    p.x += sign(p.x) * gillBreath * step(0.12, abs(p.x));

    // Slight torsional body roll & vertical heave on high tail beat
    p.y += sin(phase * 2.0 - t * 6.4) * 0.022 * w + p.x * wave * 0.06 * w;
    return p;
  }
`;

function createSharkMaterial(sharedUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    attribute float aPartId;

    ${MEDIUM_GLSL}
    ${SHARK_WAVE_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vLPos;
    out vec3 vLNorm;
    out vec2 vSpine;
    out float vPart;

    void main() {
      vec3 lp = sharkDeform(position, aSpineCoord, uSwimPhase);
      // Finite-difference Jacobian normal rotation along spine
      float t0 = max(0.0, aSpineCoord.x - 0.012);
      float t1 = min(1.08, aSpineCoord.x + 0.012);
      vec3 d0 = sharkDeform(position, vec2(t0, aSpineCoord.y), uSwimPhase);
      vec3 d1 = sharkDeform(position, vec2(t1, aSpineCoord.y), uSwimPhase);
      float slopeX = (d1.x - d0.x) * 3.6;
      vec3 ln = normalize(vec3(normal.x - normal.z * slopeX, normal.y, normal.z + normal.x * slopeX));

      vec4 wp = modelMatrix * vec4(lp, 1.0);
      vec3 wn = normalize(mat3(modelMatrix) * ln);

      vWPos = wp.xyz;
      vWNorm = wn;
      vLPos = position;
      vLNorm = normal;
      vSpine = aSpineCoord;
      vPart = aPartId;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vLPos;
    in vec3 vLNorm;
    in vec2 vSpine;
    in float vPart;

    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 gn = normalize(vWNorm);
      // Anisotropic dermal denticle (placoid scale) micro-relief elongated along body axis
      TP tpMacro = tri(vLPos * vec3(2.4, 2.4, 1.4), gn);
      TP tpDenticle = tri(vLPos * vec3(16.0, 16.0, 7.5), gn);
      float denticleRib = sin(vLPos.z * 95.0 + vLPos.y * 28.0 + tpDenticle.h * 2.5) * 0.08;
      vec3 N = normalize(gn + tpMacro.n * 0.24 + tpDenticle.n * 0.22 + vec3(0.0, denticleRib, denticleRib * 0.5));

      // AAA Pelagic Grey Reef / Great White Shark Countershading Palette
      vec3 dorsalCol = vec3(0.095, 0.135, 0.175); // Deep gunmetal slate-blue with subtle bronze undertone
      vec3 bronzeShift = vec3(0.155, 0.148, 0.135);
      vec3 flankCol = mix(vec3(0.18, 0.23, 0.27), bronzeShift, 0.38);
      vec3 bellyCol = vec3(0.68, 0.70, 0.69); // Crisp porcelain-white ventral countershading

      // Jagged, organic dorso-ventral countershading demarcation along the flank
      float jagged = (tpMacro.h - 0.5) * 0.11 + (tpDenticle.c - 0.5) * 0.045 + sin(vLPos.z * 3.6) * 0.035;
      float flankLine = vLPos.y + jagged;
      float bellyToFlank = smoothstep(-0.14, 0.02, flankLine);
      float flankToDorsal = smoothstep(0.02, 0.34, flankLine);
      // Dark boundary line right along the countershading border (classic Carcharhinid / Lamnid trait)
      float borderPin = exp(-pow((flankLine - 0.01) / 0.045, 2.0)) * 0.22;
      vec3 skinCol = mix(bellyCol, mix(flankCol, dorsalCol, flankToDorsal), bellyToFlank);
      skinCol *= (1.0 - borderPin);

      // Subtle vertical pelagic tiger/reef barring & dappled dermal mottling on upper flanks
      float barring = sin(vLPos.z * 7.2 + sin(vLPos.y * 5.0) * 1.4) * 0.5 + 0.5;
      float mottle = smoothstep(0.32, 0.76, tpMacro.c * 0.65 + barring * 0.35);
      skinCol *= mix(0.86, 1.10, mottle * flankToDorsal + (1.0 - flankToDorsal) * 0.5);

      // Healing predatory bite/reef scrape scars across snout & dorsal flanks
      float scarLine1 = exp(-pow((vLPos.y - 0.22 - (vLPos.z - 1.1) * 0.35) / 0.012, 2.0)) * smoothstep(0.6, 1.6, vLPos.z) * (1.0 - smoothstep(1.6, 2.2, vLPos.z));
      float scarLine2 = exp(-pow((vLPos.y - 0.14 + (vLPos.z - 1.4) * 0.42) / 0.010, 2.0)) * smoothstep(0.8, 1.8, vLPos.z) * (1.0 - smoothstep(1.8, 2.4, vLPos.z));
      float scarMask = clamp((scarLine1 + scarLine2) * smoothstep(0.55, 0.85, tpDenticle.h), 0.0, 1.0);
      skinCol = mix(skinCol, vec3(0.48, 0.52, 0.55), scarMask * 0.65);

      // Characteristic dusky/black trailing fin edges & tips (Carcharhinus amblyrhynchos signature!)
      float finTip = smoothstep(0.75, 1.48, abs(vLPos.x)) + smoothstep(0.52, 1.22, abs(vLPos.y));
      float trailingEdge = smoothstep(4.2, 4.9, vPart);
      float blackTipMask = clamp(finTip * 0.68 + trailingEdge * 0.45, 0.0, 0.88);
      skinCol = mix(skinCol, vec3(0.025, 0.032, 0.042), blackTipMask);

      // Ampullae of Lorenzini sensory pore speckles under snout
      if (vLPos.z > 2.35 && vLPos.y < 0.05) {
        float pore = smoothstep(0.78, 0.86, tpDenticle.c);
        skinCol = mix(skinCol, vec3(0.18, 0.19, 0.21), pore * 0.55);
      }

      float roughness = mix(0.36, 0.26, bellyToFlank);
      float specStr = 0.38;

      // Branchial gill slits & outer labial creases (partId ~ 2)
      float gillMask = smoothstep(1.5, 1.9, vPart) * (1.0 - smoothstep(2.4, 2.8, vPart));
      skinCol = mix(skinCol, vec3(0.045, 0.022, 0.028), gillMask * 0.90);
      specStr *= (1.0 - gillMask * 0.75);

      // Crimson-pink oral gingiva / gum tissue inside jaw (partId ~ 4)
      float gumMask = smoothstep(3.5, 3.9, vPart) * (1.0 - smoothstep(4.2, 4.6, vPart));
      skinCol = mix(skinCol, vec3(0.36, 0.09, 0.11), gumMask * 0.92);

      // Razor-sharp white enamel teeth (partId ~ 3)
      float toothMask = smoothstep(2.5, 2.9, vPart) * (1.0 - smoothstep(3.2, 3.6, vPart));
      skinCol = mix(skinCol, vec3(0.86, 0.85, 0.80), toothMask);
      roughness = mix(roughness, 0.12, toothMask);
      specStr = mix(specStr, 0.85, toothMask);

      // Multi-zone anatomical shark eye: dark scleral rim + bronze-slate iris + obsidian pupil (partId ~ 1)
      float eyeMask = 1.0 - smoothstep(0.0, 0.4, abs(vPart - 1.0));
      if (eyeMask > 0.01) {
        vec2 eyeRel = vec2((vLPos.z - 2.72) / 0.062, (vLPos.y - 0.068) / 0.058);
        float eyeR = length(eyeRel);
        float pupil = 1.0 - smoothstep(0.32, 0.46, eyeR);
        float iris = (1.0 - pupil) * (1.0 - smoothstep(0.72, 0.92, eyeR));
        vec3 irisCol = vec3(0.22, 0.20, 0.14) * (0.75 + 0.5 * tpDenticle.h);
        vec3 eyeCol = mix(vec3(0.02, 0.025, 0.03), irisCol, iris);
        eyeCol = mix(eyeCol, vec3(0.005, 0.007, 0.01), pupil);
        skinCol = mix(skinCol, eyeCol, eyeMask);
        roughness = mix(roughness, 0.05, eyeMask);
        specStr = mix(specStr, 1.35, eyeMask);
      }

      vec3 V = normalize(uCamPos - vWPos);
      vec3 L = uSunDir;
      vec3 H = normalize(V + L);
      float ndl = max(dot(N, L), 0.0);
      float ndv = max(dot(N, V), 0.02);
      float ndh = max(dot(N, H), 0.0);

      float sh = shadow9(vWPos);
      vec3 caRaw = causRGB(vWPos);
      vec3 ca = caRaw / (1.0 + caRaw * 0.45);
      vec3 sunIrr = sunE(vWPos);

      // 1. Direct Sun + Chromatic Caustics + Wrap Diffuse
      float wrapDiff = max(0.0, (dot(N, L) + 0.18) / 1.18);
      vec3 direct = sunIrr * wrapDiff * sh * (0.52 + 1.28 * ca);

      // 2. Upward Sandy Reef Bounce Light on Porcelain-White Ventral Belly
      vec3 bellyBounce = vec3(0.20, 0.24, 0.22) * max(-N.y, 0.0) * (1.2 - bellyToFlank * 0.55);
      vec3 ambient = amb(vWPos, N) + sideLight(vWPos, N) + bellyBounce;

      // 3. Dual-Lobe Specular: Anisotropic Dermal Denticle Velvet Sheen + Wet Mucous Coat GGX
      float alphaSq = pow(roughness, 4.0);
      float denom = ndh * ndh * (alphaSq - 1.0) + 1.0;
      float D_ggx = alphaSq / max(3.14159 * denom * denom, 1e-4);
      float fresnel = 0.028 + 0.972 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
      float wetSpec = D_ggx * fresnel * specStr * sh;
      float denticleSheen = pow(1.0 - ndv, 3.4) * (0.35 + 0.65 * ndl) * 0.18 * (1.0 - eyeMask);

      // 4. Translucent Fin-Edge Subsurface Scattering (SSS) when Backlit
      float finThin = clamp(trailingEdge * 0.85 + finTip * 0.55, 0.0, 1.0);
      float backLight = pow(clamp(dot(-V, L + N * 0.45), 0.0, 1.0), 2.8);
      vec3 sssCol = vec3(0.32, 0.52, 0.48) * sunIrr * backLight * finThin * (0.45 + 0.55 * sh) * 0.55;

      vec3 lit = skinCol * (direct + ambient)
        + sunIrr * (0.35 + ca * 0.95) * wetSpec
        + mix(WCOL, sunIrr, 0.5) * denticleSheen
        + sssCol;
      fragColor = vec4(fog(lit, vWPos), 1.0);
    }
  `;

  return bindSharedUniforms(
    new THREE.ShaderMaterial({
      uniforms: sharedUniforms,
      vertexShader: vs,
      fragmentShader: fs,
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
    }),
    sharedUniforms
  );
}

function createSharkShadowMaterial(sharedUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    uniform float uSwimPhase;
    ${SHARK_WAVE_GLSL}

    void main() {
      vec3 lp = sharkDeform(position, aSpineCoord, uSwimPhase);
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

  return bindSharedUniforms(
    new THREE.ShaderMaterial({
      uniforms: sharedUniforms,
      vertexShader: vs,
      fragmentShader: fs,
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1.5,
      polygonOffsetUnits: 1.5,
    }),
    sharedUniforms
  );
}

// ============================================================================
// Zero-Allocation Shark Spline Patrol Controller
// ============================================================================
export class SharkController {
  constructor(sharkMesh, sharkShadowMesh, terrain, sharedUniforms) {
    this.mesh = sharkMesh;
    this.shadowMesh = sharkShadowMesh;
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

    this.mesh.scale.setScalar(1.35);
    this.shadowMesh.scale.setScalar(1.35);
    this.mesh.position.copy(this.pos);
    this.shadowMesh.position.copy(this.pos);
    this.update(0.016);
  }

  update(dt) {
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
// ============================================================================
// Schooling Fish Geometry (Direct Port of abyssal-garden meshFish in world.js)
// ============================================================================
function buildFishGeometry() {
  const p = [];
  const idx = [];
  function v(x, y, z) {
    p.push(x, y, z);
    return p.length / 3 - 1;
  }
  function tri(a, b, c) {
    idx.push(a, b, c);
  }
  function quad(a, b, c, d) {
    idx.push(a, b, c, a, c, d);
  }

  const X = [0.5, 0.3, 0.05, -0.22, -0.34];
  const H = [0.01, 0.13, 0.17, 0.09, 0.035];
  const Wd = [0.01, 0.05, 0.065, 0.03, 0.012];
  const rings = [];
  for (let i = 0; i < 5; i++) {
    const r = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      r.push(v(X[i], Math.sin(a) * H[i], Math.cos(a) * Wd[i]));
    }
    rings.push(r);
  }
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      quad(rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]);
    }
  }
  const a = v(-0.33, 0, 0);
  const b = v(-0.56, 0.2, 0);
  const c = v(-0.47, 0, 0);
  const d = v(-0.56, -0.2, 0);
  tri(a, b, c);
  tri(a, c, d);

  // Area-weighted vertex normals (exact port of abyssal-garden Mesh.build)
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
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================================
// AAA-Grade 1:1 Colossal Mother & Calf Sperm Whales (Physeter macrocephalus — 抹香鯨母子)
// High-Res Sculpted Spermaceti Case & Junk + Asymmetric Left S-Blowhole +
// Deep Prune-Like Longitudinal Skin Corrugations + 12 Ventral Throat Grooves +
// Crenulated Dorsal Hump & 6 Knuckles + Articulated Narrow Lower Mandible with
// Alveolar Gum Sockets & 22 Pairs of Curved Conical Ivory Teeth +
// Hydroelastic Scalloped Flukes with Battle Nicks + Giant Squid Sucker-Ring Scars
// ============================================================================
function buildSpermWhaleGeometry() {
  const pos = [];
  const spineCoord = []; // vec2(tAlongSpine [0..1], waveAmpWeight [0..1])
  const partId = []; // 0 = cetacean hide, 1 = eye/iris, 2 = lower jaw / ivory lip, 3 = conical ivory teeth, 4 = palatal/alveolar gum, 5 = thin fluke/flipper edge
  const idx = [];

  function pushWV(x, y, z, t, sw, part = 0) {
    const id = pos.length / 3;
    pos.push(x, y, z);
    spineCoord.push(t, sw);
    partId.push(part);
    return id;
  }

  // Base length 10.0m along Z (+5.05 squared spermaceti prow -> -4.75 peduncle tail root)
  // Scaled by 2.65x for Mother (26.5m) and 1.32x for Calf (13.2m)
  const nLen = 112;
  const nRad = 56;
  const rings = [];

  function whaleEnvelope(t) {
    // Spermaceti massive squared head (t: 0..0.35), barrel ribcage torso (0.35..0.58), muscular laterally compressed tail stock (0.58..1.0)
    if (t < 0.032) {
      const u = t / 0.032;
      const blunt = Math.pow(Math.max(0.015, u), 0.31);
      return { rx: 0.54 * blunt, ry: 0.96 * blunt, cy: 0.16 * blunt, boxPow: 3.45 };
    } else if (t < 0.35) {
      const u = (t - 0.032) / 0.318;
      const rx = 0.54 + Math.sin(u * Math.PI * 0.5) * 0.44;
      const ry = 0.96 + Math.sin(u * Math.PI * 0.5) * 0.14;
      const boxPow = 3.45 - u * 1.15; // transitions from box-like spermaceti organ to rounded thorax
      return { rx, ry, cy: 0.16 - u * 0.10, boxPow };
    } else if (t < 0.58) {
      const u = (t - 0.35) / 0.23;
      const rx = 0.98 - u * 0.20;
      const ry = 1.10 - u * 0.16;
      return { rx, ry, cy: 0.06 - u * 0.04, boxPow: 2.30 - u * 0.30 };
    } else {
      const u = Math.min(1.0, Math.max(0.0, (t - 0.58) / 0.42));
      // Caudal peduncle becomes tall and laterally compressed (keel-like) tapering into fluke keel
      const rx = Math.max(0.048, 0.78 * Math.pow(Math.max(0.0, 1.0 - u), 1.48) + 0.042);
      const ry = Math.max(0.078, 0.94 * Math.pow(Math.max(0.0, 1.0 - u), 1.22) + 0.068);
      return { rx, ry, cy: 0.02 * (1.0 - u), boxPow: 1.95 };
    }
  }

  for (let i = 0; i <= nLen; i++) {
    const t = i / nLen;
    const z = 5.05 - t * 9.80; // +5.05 nose -> -4.75 peduncle fluke root
    const env = whaleEnvelope(t);

    // Authentic cetacean dorso-ventral vertical swimming wave envelope
    const sw = t < 0.34 ? 0.04 * (t / 0.34) : 0.04 + 0.96 * Math.pow(Math.max(0.0, (t - 0.34) / 0.66), 1.62);

    const ring = [];
    for (let s = 0; s < nRad; s++) {
      const a = (s / nRad) * Math.PI * 2; // 0 = dorsal (+Y), pi = belly (-Y)
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const absSa = Math.abs(sa);

      // Superellipse shape for tall slab-sided spermaceti forehead vs rounded torso
      const absPow = Math.max(1e-5, Math.pow(absSa, env.boxPow) + Math.pow(Math.abs(ca), env.boxPow));
      const lp = Math.pow(absPow, -1.0 / env.boxPow);
      let x = sa * lp * env.rx;
      let y = env.cy + ca * lp * env.ry;

      // Distinctive spermaceti "junk" & overhanging battering-ram prow profile (t < 0.28)
      if (t < 0.28 && ca > -0.35 && ca < 0.55) {
        const junkGroove = Math.exp(-Math.pow((ca - 0.12) / 0.16, 2.0)) * (1.0 - t / 0.28) * 0.032;
        x -= Math.sign(sa) * junkGroove;
      }

      // Spermaceti asymmetric left-anterior S-shaped blowhole mound & slit (~ x=-0.17, y~0.92, z=4.50)
      if (t > 0.018 && t < 0.105 && ca > 0.62) {
        const dzBlow = (z - 4.50) / 0.25;
        const sCurve = Math.sin(dzBlow * 2.2) * 0.045;
        const dxBlow = (x + 0.17 + sCurve) / 0.16;
        const blowR2 = dzBlow * dzBlow + dxBlow * dxBlow;
        if (blowR2 < 2.4) {
          const mound = Math.exp(-blowR2 * 2.0) * 0.095;
          const slit = Math.exp(-dxBlow * dxBlow * 18.0 - dzBlow * dzBlow * 2.5) * 0.052;
          y += mound - slit;
        }
      }

      // Sculpted supra-ocular temporal bulge & recessed eye socket at (x=±0.88, y=-0.30, z=2.04, t~0.305)
      if (t > 0.27 && t < 0.345 && absSa > 0.72 && ca < -0.10 && ca > -0.58) {
        const dtE = (t - 0.307) / 0.025;
        const daE = (ca + 0.32) / 0.16;
        const rE2 = dtE * dtE + daE * daE;
        if (rE2 < 1.6) {
          const socket = -Math.exp(-rE2 * 2.6) * 0.048 + Math.exp(-rE2 * 1.1) * 0.025;
          x += Math.sign(sa) * socket;
        }
      }

      // 12 deep longitudinal ventral throat grooves along t in [0.15..0.39]
      if (t > 0.15 && t < 0.39 && ca < -0.18) {
        const tEnv = Math.sin(((t - 0.15) / 0.24) * Math.PI);
        const aEnv = Math.min(1.0, Math.max(0.0, (-ca - 0.18) / 0.56));
        const groove = Math.sin(sa * Math.PI * 12.0) * 0.024 * tEnv * aEnv;
        y -= Math.abs(groove);
      }

      // Authentic "Prune-Like" Corrugated Longitudinal Skin Folds along Posterior 2/3 of Body (t in [0.33..0.88])
      if (t > 0.33 && t < 0.88 && ca > -0.55) {
        const foldEnv = Math.sin(((t - 0.33) / 0.55) * Math.PI);
        const w1 = Math.sin(a * 18.0 + Math.sin(t * 28.0) * 1.6) * 0.022;
        const w2 = Math.cos(a * 31.0 - t * 42.0) * 0.012;
        const w3 = Math.sin(t * 105.0 + a * 6.0) * 0.011;
        const corr = (w1 + w2 + w3) * foldEnv;
        x += sa * corr;
        y += ca * corr;
      }

      // Signature Crenulated Dorsal Hump (~t=0.61) + 6 Smooth Rounded Dorsal Knuckles + Peduncle Keel
      if (ca > 0.80) {
        const ridgeW = Math.pow(Math.max(0.0, (ca - 0.80) / 0.20), 1.45);
        const hump = Math.exp(-Math.pow((t - 0.605) / 0.048, 2.0)) * 0.34;
        const knk = t > 0.65 && t < 0.89
          ? Math.pow(Math.max(0, Math.sin(((t - 0.65) / 0.24) * Math.PI * 6.0)), 1.6) * 0.056 * Math.sin(((t - 0.65) / 0.24) * Math.PI)
          : 0.0;
        const keel = t > 0.86 ? Math.sin(((t - 0.86) / 0.14) * Math.PI) * 0.055 : 0.0;
        y += (hump + knk + keel) * ridgeW;
      }

      // Ventral post-anal keel along caudal peduncle (t in [0.68..0.95])
      if (ca < -0.82 && t > 0.68 && t < 0.95) {
        const vKeelW = Math.pow(Math.max(0.0, (-ca - 0.82) / 0.18), 1.5);
        const vKeel = Math.sin(((t - 0.68) / 0.27) * Math.PI) * 0.12;
        y -= vKeel * vKeelW;
      }

      // Deeply recessed palatal vault beneath spermaceti rostrum with upper tooth-socket pits
      let pType = 0;
      if (t > 0.028 && t < 0.305 && ca < -0.54) {
        const uPal = (t - 0.028) / 0.277;
        const mouthInset = Math.sin(uPal * Math.PI) * 0.26 * Math.min(1.0, (-ca - 0.54) / 0.32);
        y += mouthInset;
        pType = (-ca > 0.76 && uPal > 0.08 && uPal < 0.88) ? 4 : 2;
      }

      ring.push(pushWV(x, y, z, t, sw, pType));
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

  // Cap squared spermaceti prow cleanly
  const prowTip = pushWV(0, 0.16, 5.11, 0.0, 0.0, 0);
  const firstR = rings[0];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(prowTip, firstR[ns], firstR[s]);
  }

  // Taper and weld rear caudal peduncle cleanly inside the central fluke keel
  const pedTip = pushWV(0, 0.0, -4.88, 1.0, 1.0, 0);
  const lastR = rings[rings.length - 1];
  for (let s = 0; s < nRad; s++) {
    const ns = (s + 1) % nRad;
    idx.push(pedTip, lastR[s], lastR[ns]);
  }

  // ---- Articulated Narrow Underslung Lower Jaw (Mandible with Ivory Lip Rim & Alveolar Ridge) ----
  const jawSegs = 28;
  const jawRad = 20;
  const jawRings = [];
  for (let i = 0; i <= jawSegs; i++) {
    const u = i / jawSegs; // 0 = rounded symphyseal chin tip (+4.68), 1 = gular hinge into throat (+1.95)
    const z = 4.68 - u * 2.73;
    const t = 0.032 + u * 0.273;
    // Narrow rod-like anterior symphysis flaring Y-like at rear condyles
    const jx = 0.095 + Math.pow(u, 1.48) * 0.39;
    const jy = 0.125 + u * 0.19;
    const cy = -0.69 - Math.sin(u * Math.PI * 0.48) * 0.11;
    const sw = 0.04 * (t / 0.34);
    const ring = [];
    for (let s = 0; s < jawRad; s++) {
      const a = (s / jawRad) * Math.PI * 2;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      // U-shaped oral trough on dorsal (+ca) face of mandible
      const oralGroove = ca > 0.35 && Math.abs(sa) < 0.65 ? -0.038 * Math.cos((sa / 0.65) * Math.PI * 0.5) : 0.0;
      const vy = cy + ca * jy + oralGroove;
      const pTag = (ca > 0.55 && u < 0.86) ? 4 : 2;
      ring.push(pushWV(sa * jx, vy, z, t, sw, pTag));
    }
    jawRings.push(ring);
  }
  for (let i = 0; i < jawSegs; i++) {
    for (let s = 0; s < jawRad; s++) {
      const ns = (s + 1) % jawRad;
      idx.push(jawRings[i][s], jawRings[i][ns], jawRings[i + 1][ns], jawRings[i][s], jawRings[i + 1][ns], jawRings[i + 1][s]);
    }
  }
  const jawTip = pushWV(0, -0.67, 4.74, 0.028, 0.0, 2);
  for (let s = 0; s < jawRad; s++) {
    const ns = (s + 1) % jawRad;
    idx.push(jawTip, jawRings[0][ns], jawRings[0][s]);
  }

  // ---- 22 Pairs of Curved Conical Ivory Teeth set in Alveolar Gum Collars (partId = 3 & 4) ----
  const toothPairs = 22;
  const toothSides = 8;
  const toothRings = 3;
  for (let k = 0; k < toothPairs; k++) {
    const u = 0.045 + (k / (toothPairs - 1)) * 0.82;
    const tz = 4.68 - u * 2.73;
    const tt = 0.032 + u * 0.273;
    const jx = 0.095 + Math.pow(Math.max(0.0, u), 1.48) * 0.39;
    const jy = 0.125 + u * 0.19;
    const cy = -0.69 - Math.sin(u * Math.PI * 0.48) * 0.11;
    const sw = 0.04 * (tt / 0.34);
    const toothScale = 0.68 + 0.44 * Math.sin(u * Math.PI);
    const tR = 0.023 * toothScale;
    const tH = 0.082 * toothScale;

    for (const side of [-1, 1]) {
      const bx = side * jx * 0.74;
      const by = cy + jy * 0.78;
      const tLevels = [];
      for (let r = 0; r < toothRings; r++) {
        const v = r / toothRings;
        const rad = tR * (1.0 - v * 0.58) * (r === 0 ? 1.18 : 1.0);
        const hookIn = -side * Math.pow(v, 1.6) * 0.016;
        const hookBack = -Math.pow(v, 1.5) * 0.012;
        const yLv = by - 0.012 + v * tH * 0.76;
        const pTag = r === 0 ? 4 : 3; // Gum collar at base, ivory dentine/enamel above
        const ring = [];
        for (let s = 0; s < toothSides; s++) {
          const a = (s / toothSides) * Math.PI * 2;
          ring.push(pushWV(bx + hookIn + Math.cos(a) * rad, yLv, tz + hookBack + Math.sin(a) * rad, tt, sw, pTag));
        }
        tLevels.push(ring);
      }
      const tipId = pushWV(bx - side * 0.020, by + tH, tz - 0.016, tt, sw, 3);
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

  // ---- Filleted Paddle Pectoral Flippers with Phalangeal Ridges (t = 0.37) ----
  for (const side of [-1, 1]) {
    const fRows = 14;
    const fCols = 14;
    const topGrid = [];
    const botGrid = [];
    for (let ir = 0; ir <= fRows; ir++) {
      const u = ir / fRows; // 0 = filleted shoulder root, 1 = rounded paddle tip
      const span = side * (0.64 + u * 0.96);
      const chord = 0.60 * (1.0 - 0.36 * u * u) * (u > 0.80 ? Math.cos(((u - 0.80) / 0.20) * Math.PI * 0.5) : 1.0);
      const zC = 1.40 - u * 0.44;
      const yC = -0.35 - u * 0.30;
      const fillet = u < 0.22 ? Math.pow(1.0 - u / 0.22, 2.0) * 0.85 : 0.0;
      const thick = (0.115 * (1.0 - u * 0.84) + 0.010) * (1.0 + fillet);
      const rTop = [];
      const rBot = [];
      for (let ic = 0; ic <= fCols; ic++) {
        const v = ic / fCols; // 0 = trailing, 1 = leading
        const z = zC + (v - 0.5) * chord;
        const prof = Math.sin(v * Math.PI);
        const digitRidge = Math.sin(v * Math.PI * 4.0) * 0.008 * u * (1.0 - u);
        rTop.push(pushWV(span, yC + thick * prof + digitRidge, z, 0.37 + u * 0.03, 0.06, 0));
        rBot.push(pushWV(span, yC - thick * prof * 0.78, z, 0.37 + u * 0.03, 0.06, 0));
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
  }

  // ---- Continuous Closed Double-Lobe Horizontal Tail Flukes with Median V-Notch & Tapered Tips ----
  {
    const spanSegs = 64; // u in [-1 .. +1], continuous across x = 0 centerline (zero gap)
    const cols = 18;
    const tGrid = [];
    const bGrid = [];
    for (let ir = 0; ir <= spanSegs; ir++) {
      const u = (ir / spanSegs) * 2.0 - 1.0; // -1 left tip -> 0 centerline -> +1 right tip
      const au = Math.abs(u);
      const x = u * 1.48; // ~7.8m full fluke span at 2.65x Mother scale
      // Smooth elliptical crescent tip taper to zero chord & thickness at outer tips (au = 1.0)
      const tipMask = Math.pow(Math.max(0.0, 1.0 - au * au), 0.72);
      const leadZ = -4.18 - Math.pow(au, 1.38) * 0.85;
      // Clean median cetacean V-notch + gentle organic undulating edge + subtle right nick
      const notchIn = 0.22 * Math.exp(-Math.pow(au / 0.055, 2.0));
      const gentleWave = Math.sin(au * Math.PI * 2.0) * 0.014 * Math.sin(au * Math.PI);
      const battleNick = (u > 0.54 && u < 0.65)
        ? Math.sin(((u - 0.54) / 0.11) * Math.PI) * 0.048
        : 0.0;
      const rawTrailZ = -5.04 + notchIn + gentleWave + battleNick - Math.pow(au, 1.45) * 0.12;
      const chord = Math.max(0.0, leadZ - rawTrailZ) * tipMask;
      const trailZ = leadZ - chord;
      const rootFillet = Math.exp(-Math.pow(au / 0.11, 2.0)) * 0.105;
      const thick = (0.088 * (1.0 - au * 0.68) + rootFillet) * tipMask;
      const rTop = [];
      const rBot = [];
      for (let ic = 0; ic <= cols; ic++) {
        const v = ic / cols; // 0 = trailing edge, 1 = leading edge
        const z = trailZ + v * chord;
        const naca = Math.sin(Math.pow(v, 0.75) * Math.PI);
        const t = 0.935 + (1.0 - v) * 0.065;
        rTop.push(pushWV(x, thick * naca, z, t, 1.0, 0));
        rBot.push(pushWV(x, -thick * naca, z, t, 1.0, 0));
      }
      tGrid.push(rTop);
      bGrid.push(rBot);
    }
    for (let ir = 0; ir < spanSegs; ir++) {
      for (let ic = 0; ic < cols; ic++) {
        // Uniform CCW outward normals: +Y on tGrid, -Y on bGrid across entire span
        idx.push(tGrid[ir][ic], tGrid[ir][ic + 1], tGrid[ir + 1][ic + 1], tGrid[ir][ic], tGrid[ir + 1][ic + 1], tGrid[ir + 1][ic]);
        idx.push(bGrid[ir][ic], bGrid[ir + 1][ic + 1], bGrid[ir][ic + 1], bGrid[ir][ic], bGrid[ir + 1][ic], bGrid[ir + 1][ic + 1]);
      }
    }
  }

  // ---- Glossy Cetacean Eyes Tucked Inside Temporal Eye Sockets ----
  const eyeGeo = new THREE.SphereGeometry(0.082, 16, 12);
  const eyePos = eyeGeo.getAttribute('position');
  const eyeIdx = eyeGeo.index;
  for (const side of [-1, 1]) {
    const baseV = pos.length / 3;
    const ex = side * 0.895;
    const ey = -0.31;
    const ez = 2.04;
    for (let i = 0; i < eyePos.count; i++) {
      pushWV(ex + eyePos.getX(i) * 0.65, ey + eyePos.getY(i), ez + eyePos.getZ(i) * 1.15, 0.305, 0.04, 1);
    }
    for (let i = 0; i < eyeIdx.count; i += 3) {
      idx.push(baseV + eyeIdx.getX(i), baseV + eyeIdx.getX(i + 1), baseV + eyeIdx.getX(i + 2));
    }
  }
  eyeGeo.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSpineCoord', new THREE.Float32BufferAttribute(spineCoord, 2));
  geo.setAttribute('aPartId', new THREE.Float32BufferAttribute(partId, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const WHALE_WAVE_GLSL = `
  vec3 whaleDeform(vec3 p, vec2 sc, vec4 st) {
    float t = sc.x;
    float w = sc.y;

    // 1. Subtle echolocation click-train jaw articulation on lower mandible & teeth (z > 2.0, y < -0.46)
    if (t < 0.31 && p.y < -0.46 && abs(p.x) < 0.46) {
      float jawArm = max(0.0, p.z - 2.05);
      float clickOpen = (0.35 + 0.65 * pow(0.5 + 0.5 * sin(st.x * 0.72), 2.0)) * 0.045;
      p.y -= jawArm * clickOpen;
    }

    // 2. Smooth spanwise flex lag across the broad 7.7m tail flukes (constant along chord for clean hydrofoil cam)
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
    return p;
  }
`;

function createWhaleMaterial(sharedUniforms, whaleUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    attribute float aPartId;

    uniform vec4 uWhaleState;

    ${MEDIUM_GLSL}
    ${WHALE_WAVE_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vLPos;
    out vec3 vLNorm;
    out vec2 vSpine;
    out float vPart;

    void main() {
      vec3 lp = whaleDeform(position, aSpineCoord, uWhaleState);

      // Unclamped centered finite-difference Jacobian transpose normal transform
      float t0 = aSpineCoord.x - 0.012;
      float t1 = aSpineCoord.x + 0.012;
      float dz = -(t1 - t0) * 9.80;
      vec3 d0 = whaleDeform(position, vec2(t0, aSpineCoord.y), uWhaleState);
      vec3 d1 = whaleDeform(position, vec2(t1, aSpineCoord.y), uWhaleState);
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
      vPart = aPartId;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    ${MEDIUM_GLSL}

    in vec3 vWPos;
    in vec3 vWNorm;
    in vec3 vLPos;
    in vec3 vLNorm;
    in vec2 vSpine;
    in float vPart;

    layout(location = 0) out vec4 fragColor;

    // Procedural Giant Squid (Architeuthis) Sucker-Ring Scars & Parallel Tooth/Beak Rakes
    // Returns vec2(scarBrightness [0..1], normalBump [-1..1])
    vec2 squidScarsAndRakes(vec3 lp, float spineT) {
      float headWeight = 1.0 - smoothstep(0.18, 0.52, spineT);
      if (headWeight <= 0.01) return vec2(0.0);

      vec2 uv = vec2(lp.z * 2.8, atan(lp.x, lp.y + 0.1) * 3.2);
      // 1. Circular serrated Giant Squid sucker ring scars across spermaceti prow
      vec2 cell = floor(uv * 2.4);
      vec2 f = fract(uv * 2.4) - 0.5;
      float h = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
      float suckerMask = 0.0;
      if (h > 0.56) {
        vec2 offset = vec2(fract(h * 13.7) - 0.5, fract(h * 29.3) - 0.5) * 0.42;
        float rad = mix(0.16, 0.34, fract(h * 7.1));
        float d = length(f - offset);
        float ring = exp(-pow((d - rad) / 0.042, 2.0));
        suckerMask = ring * step(0.56, h);
      }

      // 2. Intersecting parallel linear rake scars (squid tentacle hooks & conspecific tooth rakes)
      float rake1 = exp(-pow(sin(uv.x * 6.5 + uv.y * 4.2 + sin(uv.x * 1.7) * 0.8), 2.0) * 95.0)
        * smoothstep(0.45, 0.85, sin(uv.x * 1.1 - uv.y * 0.9));
      float rake2 = exp(-pow(sin(uv.x * 5.2 - uv.y * 5.8 + cos(uv.y * 1.9) * 0.7), 2.0) * 110.0)
        * smoothstep(0.50, 0.88, cos(uv.x * 0.8 + uv.y * 1.3));
      float rake3 = exp(-pow(sin(uv.x * 9.0 + uv.y * 2.1), 2.0) * 120.0)
        * smoothstep(0.60, 0.92, sin(uv.x * 1.9 + 1.2));

      float totalScar = clamp((suckerMask * 0.85 + (rake1 + rake2 + rake3) * 0.75) * headWeight, 0.0, 1.0);
      float bump = (suckerMask - (rake1 + rake2) * 0.6) * headWeight;
      return vec2(totalScar, bump);
    }

    void main() {
      vec3 gn = normalize(vWNorm);
      // Multi-scale cetacean skin detail: macro prune-like corrugations + medium weathered dermis + fine epidermal pores
      TP tp = tri(vLPos * 1.8, gn);
      TP fine = tri(vLPos * 6.2, gn);
      TP micro = tri(vLPos * 19.0, gn);

      float isPec = smoothstep(0.65, 1.35, abs(vLPos.x)) * (1.0 - smoothstep(0.55, 0.90, vSpine.x));
      float isFluke = smoothstep(0.935, 0.975, vSpine.x);
      float finEdgeMask = clamp(max(isPec, isFluke) * smoothstep(0.20, 0.75, abs(vLPos.x) * 0.45 + (1.0 - abs(vLNorm.y)) * 0.55), 0.0, 1.0);
      float flukeBladeMask = clamp(max(isPec * 0.65, smoothstep(0.91, 0.96, vSpine.x)), 0.0, 1.0);
      float bumpScale = mix(1.0, 0.28, flukeBladeMask);

      // Authentic longitudinal "prune-like" skin corrugations along posterior 2/3 of whale body
      float corrMask = smoothstep(0.28, 0.45, vSpine.x) * (1.0 - smoothstep(0.84, 0.93, vSpine.x));
      float wrinkleWave = (sin(vLPos.y * 16.0 + tp.h * 4.2) * 0.65 + cos(vLPos.z * 9.5 + fine.h * 3.5) * 0.35) * corrMask;
      vec2 scarData = squidScarsAndRakes(vLPos, vSpine.x);

      vec3 N = normalize(
        gn +
        (tp.n * 0.22 + fine.n * 0.16 + micro.n * 0.09) * bumpScale +
        vec3(0.0, wrinkleWave * 0.16 + scarData.y * 0.10, wrinkleWave * 0.10 - scarData.y * 0.10)
      );

      // AAA Physeter macrocephalus Rich Pelagic Slate-Charcoal Hide Palette
      vec3 backCol = vec3(0.042, 0.052, 0.068); // Deep weathered dark slate-charcoal dorsal hide
      vec3 plumWarm = vec3(0.088, 0.082, 0.098); // Subtle warm brownish-plum undertone in sunlight
      vec3 flankCol = mix(vec3(0.072, 0.086, 0.108), plumWarm, 0.38);
      vec3 bellyBase = vec3(0.145, 0.162, 0.185);
      // Characteristic piebald white/grey umbilical & throat splash patch on ventral belly
      float piebald = smoothstep(0.46, 0.72, tp.c * 0.65 + fine.c * 0.35) * smoothstep(0.18, 0.65, vSpine.x) * (1.0 - smoothstep(0.65, 0.85, vSpine.x));
      vec3 bellyCol = mix(bellyBase, vec3(0.36, 0.38, 0.41), piebald * 0.82);

      float vGrad = smoothstep(-0.68, 0.42, vLPos.y + (tp.h - 0.5) * 0.16);
      vec3 skinCol = mix(bellyCol, mix(flankCol, backCol, smoothstep(0.15, 0.65, vLPos.y)), vGrad);

      // Sloughed epidermis mottling & weathered dorsal hump callosity patches
      float slough = smoothstep(0.32, 0.78, tp.c * 0.6 + fine.h * 0.4);
      skinCol *= mix(0.84, 1.14, slough);
      float humpCallus = exp(-pow((vSpine.x - 0.605) / 0.055, 2.0)) * smoothstep(0.65, 0.92, vLNorm.y) * smoothstep(0.48, 0.72, fine.c);
      skinCol = mix(skinCol, vec3(0.24, 0.25, 0.27), humpCallus * 0.60);

      // Stamp pale Giant Squid sucker rings & linear tooth rake battle scars across spermaceti head & jaws
      float headMottle = (1.0 - smoothstep(0.24, 0.44, vSpine.x)) * smoothstep(0.58, 0.78, fine.c);
      float totalScarMask = clamp(scarData.x + headMottle * 0.32, 0.0, 1.0);
      skinCol = mix(skinCol, vec3(0.34, 0.36, 0.40), totalScarMask * 0.75);

      // Signature white/ivory lower jaw lip margin & palatal skin (partId ~ 2)
      float jawMask = smoothstep(1.5, 1.9, vPart) * (1.0 - smoothstep(2.4, 2.7, vPart));
      float lipEdge = smoothstep(-0.78, -0.52, vLPos.y) * smoothstep(0.06, 0.22, abs(vLPos.x));
      skinCol = mix(skinCol, vec3(0.46, 0.47, 0.45), jawMask * (0.38 + 0.58 * lipEdge));

      // Pinkish-ivory alveolar gum sockets & palatal vault inside mouth (partId ~ 4)
      float gumMask = smoothstep(3.5, 3.9, vPart) * (1.0 - smoothstep(4.2, 4.6, vPart));
      skinCol = mix(skinCol, vec3(0.40, 0.24, 0.25), gumMask * 0.88);

      // Curved conical ivory teeth with dark cementum root transition (partId ~ 3)
      float toothMask = smoothstep(2.55, 2.95, vPart) * (1.0 - smoothstep(3.2, 3.6, vPart));
      vec3 ivoryCol = mix(vec3(0.58, 0.52, 0.42), vec3(0.84, 0.80, 0.72), smoothstep(-0.62, -0.54, vLPos.y));
      skinCol = mix(skinCol, ivoryCol, toothMask);

      // Glossy cetacean eye with warm chestnut-brown iris ring & dark pupil (partId ~ 1)
      float eyeMask = 1.0 - smoothstep(0.0, 0.4, abs(vPart - 1.0));
      if (eyeMask > 0.01) {
        vec2 eyeRel = vec2((vLPos.z - 2.04) / 0.085, (vLPos.y + 0.31) / 0.075);
        float eyeR = length(eyeRel);
        float pupil = 1.0 - smoothstep(0.36, 0.52, eyeR);
        float iris = (1.0 - pupil) * (1.0 - smoothstep(0.74, 0.94, eyeR));
        vec3 eyeCol = mix(vec3(0.02, 0.025, 0.03), vec3(0.18, 0.12, 0.08), iris);
        eyeCol = mix(eyeCol, vec3(0.005, 0.007, 0.01), pupil);
        skinCol = mix(skinCol, eyeCol, eyeMask);
      }

      // Micro-cavity self-occlusion inside deep longitudinal skin folds & throat grooves
      float creaseAO = mix(0.68, 1.06, smoothstep(0.25, 0.75, tp.h * 0.6 + fine.h * 0.4));
      skinCol *= creaseAO;

      float roughness = mix(0.36, 0.08, max(eyeMask, toothMask * 0.65));
      float specStr = mix(0.30, 1.10, max(eyeMask, toothMask * 0.55));

      vec3 V = normalize(uCamPos - vWPos);
      float ndv = max(dot(N, V), 0.02);
      float sh = shadow9(vWPos);

      // ---- 1. Underwater Physically Based Lighting, Subsurface Scattering & Soft-Knee Chromatic Caustics ----
      vec3 caRaw = causRGB(vWPos);
      vec3 ca = caRaw / (1.0 + caRaw * 0.85);
      vec3 sunIrr = sunE(vWPos);
      float ndl = max(dot(N, uSunDir), 0.0);
      float wrapNdl = max(0.0, (dot(N, uSunDir) + 0.18) / 1.18);
      vec3 directUW = sunIrr * wrapNdl * sh * (0.42 + ca * 0.85);
      vec3 bellyBounce = vec3(0.12, 0.18, 0.20) * max(-N.y, 0.0);
      vec3 ambientUW = amb(vWPos, N) + sideLight(vWPos, N) + bellyBounce;

      // Dual-lobe wet cetacean specular: disciplined oily dermis sheen + crisp seawater film GGX coat
      vec3 H_uw = normalize(V + uSunDir);
      float ndh_uw = max(dot(N, H_uw), 0.0);
      float alphaSq = pow(roughness, 4.0);
      float denom = ndh_uw * ndh_uw * (alphaSq - 1.0) + 1.0;
      float D_ggx = alphaSq / max(3.14159 * denom * denom, 1e-4);
      float fresnelUW = 0.025 + 0.975 * pow(1.0 - max(dot(H_uw, V), 0.0), 5.0);
      float broadSheen = pow(ndh_uw, 24.0) * 0.10 + pow(1.0 - ndv, 4.2) * 0.11;
      float specUW = (D_ggx * fresnelUW * specStr + broadSheen) * sh;

      // Cetacean Dermal & Fluke-Edge Subsurface Scattering (SSS)
      float backLight = pow(clamp(dot(-V, uSunDir + N * 0.42), 0.0, 1.0), 2.8);
      float terminatorSSS = smoothstep(-0.22, 0.15, dot(N, uSunDir)) * (1.0 - smoothstep(0.15, 0.52, dot(N, uSunDir)));
      vec3 sssUW = sunIrr * (
        vec3(0.24, 0.42, 0.45) * backLight * (0.20 + 0.65 * finEdgeMask) * 0.42 +
        vec3(0.20, 0.11, 0.10) * terminatorSSS * 0.16
      ) * (0.35 + 0.65 * sh);

      vec3 uwRawLit = skinCol * (directUW + ambientUW) + sunIrr * (0.22 + ca * 0.65) * specUW + sssUW;

      // ---- 2. Above-Water Sunny Daytime Lighting & Glistening Wet Seawater Film ----
      float airNdl = max(dot(N, uAirSunDir), 0.0);
      vec3 airSunCol = vec3(1.26, 1.18, 1.00);
      vec3 skyHemi = mix(vec3(0.18, 0.30, 0.42), vec3(0.48, 0.70, 0.96), clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
      vec3 H_air = normalize(V + uAirSunDir);
      float wetSpecPow = mix(72.0, 180.0, eyeMask);
      float wetSpecStr = mix(0.75, 1.25, eyeMask);
      float specAir = pow(max(dot(N, H_air), 0.0), wetSpecPow) * wetSpecStr;
      float skyFres = pow(1.0 - ndv, 3.2) * 0.42;
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
  return mat;
}

function createWhaleShadowMaterial(sharedUniforms, whaleUniforms) {
  const vs = /* glsl */ `
    attribute vec2 aSpineCoord;
    uniform vec4 uWhaleState;
    ${WHALE_WAVE_GLSL}
    void main() {
      vec3 lp = whaleDeform(position, aSpineCoord, uWhaleState);
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
        // Feathered sunlit whale blowhole mist / sea spray puff
        float ang = atan(vQuad.y, vQuad.x);
        float wisp = 0.80 + 0.20 * sin(ang * 4.0 + seed + tNorm * 3.0) * cos(ang * 3.0 - seed * 0.7);
        float soft = pow(max(0.0, 1.0 - r / wisp), 1.65);
        float core = exp(-r * r * 3.2);
        vec3 V = normalize(vWPos - uCamPos);
        float fwdSun = pow(max(dot(V, uAirSunDir), 0.0), 4.0);
        vec3 mistCol = mix(vec3(0.76, 0.89, 0.97), vec3(1.02, 0.99, 0.94), 0.55 + 0.45 * fwdSun + 0.2 * core);
        float subCull = smoothstep(uWaveHeight - 0.18, uWaveHeight + 0.12, vWPos.y);
        float a = (soft * 0.42 + core * 0.18) * alphaLife * (0.35 + 0.65 * subCull);
        if (a < 0.01) discard;
        vec3 finalMist = uCamPos.y < uWaveHeight - 0.02 ? fog(mistCol, vWPos) : mistCol;
        fragColor = vec4(finalMist, clamp(a, 0.0, 0.72));
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

  update(dt) {
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
  const motherUniforms = { uWhaleState: { value: new THREE.Vector4(0, 0, 0, 1.0) } };
  const calfUniforms = { uWhaleState: { value: new THREE.Vector4(0, 0, 0, 1.0) } };

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
  const sharkMat = createSharkMaterial(sharedUniforms);
  const sharkShadowMat = createSharkShadowMaterial(sharedUniforms);

  const sharkMesh = new THREE.Mesh(sharkGeo, sharkMat);
  sharkMesh.frustumCulled = false;

  const sharkShadowMesh = new THREE.Mesh(sharkGeo, sharkShadowMat);
  sharkShadowMesh.frustumCulled = false;

  const controller = new SharkController(sharkMesh, sharkShadowMesh, terrain, sharedUniforms);

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

export function compileMarineLife(terrain, sharedUniforms) {
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

  // ---- 2. 4,240 Schooling Reef Fish (Direct Port of abyssal-garden SCH, vsFish & fsFish) ----
  const fishBaseGeo = buildFishGeometry();
  const fishGeo = new THREE.InstancedBufferGeometry();
  fishGeo.index = fishBaseGeo.index;
  fishGeo.attributes.position = fishBaseGeo.attributes.position;
  fishGeo.attributes.normal = fishBaseGeo.attributes.normal;

  rseed(14);
  const SCH = [
    [-2, -36, -10, 15, 520, 0.3, 1, 0.945],
    [8, -30, -70, 22, 420, 0.32, -1],
    [48, -30, 14, 18, 360, 0.3, 1],
    [-58, -30, -8, 11, 420, 0.28, -1, 0.3],
    [8, -36, 84, 16, 320, 0.28, 1],
    [-90, -28, -70, 25, 300, 0.3, 1],
    [95, -30, 70, 25, 300, 0.3, -1],
    [0, -22, 20, 30, 380, 0.34, -1],
    [-30, -30, -100, 18, 300, 0.3, 1],
    [16, -36, 30, 12, 300, 0.3, 1],
    [-48, -34, -58, 12, 300, 0.3, -1],
    [-45, -35, 38, 14, 320, 0.3, 1],
  ];

  const totalFish = SCH.reduce((s, a) => s + a[4], 0);
  fishGeo.instanceCount = totalFish;

  const fCenter = new Float32Array(totalFish * 4); // cx, cy, cz, R
  const fMeta = new Float32Array(totalFish * 4); // seed, angVel, size, schoolPhase

  let fi = 0;
  for (let si = 0; si < SCH.length; si++) {
    const s = SCH[si];
    const ss = s[7] === undefined ? rnd() : s[7];
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
      fi++;
    }
  }

  fishGeo.setAttribute('iFCenter', new THREE.InstancedBufferAttribute(fCenter, 4));
  fishGeo.setAttribute('iFMeta', new THREE.InstancedBufferAttribute(fMeta, 4));
  fishGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -25, 0), 260);

  const fishVs = /* glsl */ `
    attribute vec4 iFCenter;
    attribute vec4 iFMeta;
    ${MEDIUM_GLSL}

    out vec3 vWPos;
    out vec3 vWNorm;
    out vec3 vOrigPos;
    flat out float vSeed;
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
      vec3 l = position * iFMeta.z * (0.75 + 0.5 * h.z);
      l.z += sin(t * 9.0 + s * 50.0 + l.x * 5.0) * 0.22 * (0.25 * iFMeta.z - l.x);
      vec3 w = P + off + T * l.x + Up * l.y + S * l.z;

      vWPos = w;
      vWNorm = normalize(T * normal.x + Up * normal.y + S * normal.z);
      vOrigPos = position;
      vSeed = s;
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
    in float vShadow;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 n = normalize(vWNorm);
      if (!gl_FrontFacing) n = -n;
      vec3 L = uSunDir;
      vec3 V = normalize(uCamPos - vWPos);
      vec4 vv = vol(vWPos);

      // Direct port of abyssal-garden fsFish (cerulean-silver countershading + 14% golden-yellow morphs)
      vec3 alb = mix(vec3(0.50, 0.68, 0.80), vec3(0.10, 0.22, 0.40), ss(-0.05, 0.20, vOrigPos.y));
      alb = mix(alb, vec3(0.95, 0.80, 0.30), step(0.86, fract(vSeed * 7.7)) * 0.6);

      vec3 E = sunE(vWPos) * vShadow;
      vec3 c = alb * (E * (0.25 + 0.75 * sat(dot(n, L))) + amb(vWPos, n) * 1.3);
      c += E * pow(sat(dot(n, normalize(V + L))), 24.0) * 1.6 + vec3(0.3, 0.6, 0.7) * pow(1.0 - sat(dot(n, V)), 3.0) * 0.25 * vv.g;
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

  const nSeabirds = 48;
  const seabirdMesh = buildSeabirds(sharedUniforms, nSeabirds);
  group.add(seabirdMesh);

  return {
    group,
    shadowGroup,
    stats: { mantas: nMantas, fish: totalFish, seabirds: nSeabirds },
  };
}
