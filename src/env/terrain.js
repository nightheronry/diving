import * as THREE from 'three';
import { WORLD_BOUNDS, MEDIUM_GLSL, FLORA_PHYSICS_GLSL } from './medium.js';
import {
  rseed,
  rnd,
  rr,
  vnoise,
  vnoise2,
  fbm,
  seg2,
  seg3,
  MESAS,
  ARCHES,
  HOLES,
  CLEARS,
  PURPLE,
  MAGENTA,
  zoneP,
  magAt,
  dens,
  sampleDwFromField,
  computeTerrainBuffers,
  bakeVolumeAndZoneBuffers,
} from './terrain-core.js';

export {
  rseed,
  rnd,
  rr,
  vnoise,
  vnoise2,
  fbm,
  seg2,
  seg3,
  MESAS,
  ARCHES,
  HOLES,
  CLEARS,
  PURPLE,
  MAGENTA,
  zoneP,
  magAt,
  dens,
};

// ============================================================================
// Hydrate Three.js Geometry, 3D Skylight Volume & Spatial Queries from Buffers
// ============================================================================
export function hydrateTerrainFromBuffers(bufs) {
  const { NY, VS, OY } = WORLD_BOUNDS;
  const {
    D,
    wp,
    wn,
    aoArr,
    indices,
    skirtPos,
    skirtNorm,
    skirtAo,
    skirtIdx,
    volData,
    zoneData,
  } = bufs;
  const nv = wp.length / 3;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(wp, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(wn, 3));
  geometry.setAttribute('aAo', new THREE.BufferAttribute(aoArr, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute('position', new THREE.BufferAttribute(skirtPos, 3));
  skirtGeometry.setAttribute('normal', new THREE.BufferAttribute(skirtNorm, 3));
  skirtGeometry.setAttribute('aAo', new THREE.BufferAttribute(skirtAo, 1));
  skirtGeometry.setIndex(new THREE.BufferAttribute(skirtIdx, 1));
  skirtGeometry.computeBoundingSphere();

  function dw(x, y, z) {
    return sampleDwFromField(D, x, y, z);
  }

  function grad(x, y, z, out) {
    const e = 0.65;
    const dx = dw(x + e, y, z) - dw(x - e, y, z);
    const dy = dw(x, y + e, z) - dw(x, y - e, z);
    const dz = dw(x, y, z + e) - dw(x, y, z - e);
    const l = Math.hypot(dx, dy, dz) || 1.0;
    const inv = -1.0 / l;
    if (out) {
      out.set(dx * inv, dy * inv, dz * inv);
      return out;
    }
    return new THREE.Vector3(dx * inv, dy * inv, dz * inv);
  }

  function floorsAt(x, z) {
    const floors = [];
    let prev = dw(x, OY, z);
    for (let iy = 1; iy < NY - 1; iy++) {
      const y = OY + iy * VS;
      const cur = dw(x, y, z);
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

  const _colN = new THREE.Vector3();
  function resolveCollision(pos, radius = 1.45) {
    pos.x = Math.max(-110, Math.min(110, pos.x));
    pos.z = Math.max(-110, Math.min(110, pos.z));
    pos.y = Math.max(-49, Math.min(28, pos.y));

    if (pos.y > -1.0) return;

    for (let it = 0; it < 2; it++) {
      const d = dw(pos.x, pos.y, pos.z);
      if (d > -radius) {
        grad(pos.x, pos.y, pos.z, _colN);
        const push = d + radius;
        pos.addScaledVector(_colN, push);
      }
    }
  }

  const VX = 96;
  const VY = 24;
  const VZ = 96;
  const volTex = new THREE.Data3DTexture(volData, VX, VY, VZ);
  volTex.format = THREE.RGBAFormat;
  volTex.type = THREE.UnsignedByteType;
  volTex.minFilter = THREE.LinearFilter;
  volTex.magFilter = THREE.LinearFilter;
  volTex.wrapS = THREE.ClampToEdgeWrapping;
  volTex.wrapT = THREE.ClampToEdgeWrapping;
  volTex.wrapR = THREE.ClampToEdgeWrapping;
  volTex.needsUpdate = true;

  const ZRES = 512;
  const zoneMapTex = new THREE.DataTexture(zoneData, ZRES, ZRES, THREE.RGBAFormat, THREE.UnsignedByteType);
  zoneMapTex.minFilter = THREE.LinearFilter;
  zoneMapTex.magFilter = THREE.LinearFilter;
  zoneMapTex.wrapS = THREE.ClampToEdgeWrapping;
  zoneMapTex.wrapT = THREE.ClampToEdgeWrapping;
  zoneMapTex.needsUpdate = true;

  function updateGroundAndVolumeMaps(kelpAbs) {
    bakeVolumeAndZoneBuffers(D, kelpAbs, volData, zoneData);
    volTex.needsUpdate = true;
    zoneMapTex.needsUpdate = true;
  }

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

export function buildTerrain(onProgress = null) {
  return hydrateTerrainFromBuffers(computeTerrainBuffers(onProgress));
}

// Asynchronous Web Worker Terrain Builder (non-blocking main thread + progress stream + zero-copy transfer)
export function buildTerrainAsync(onProgress = null) {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(buildTerrain(onProgress));
  }
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(buildTerrain(onProgress));
      return;
    }

    worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.pct, msg.label);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(hydrateTerrainFromBuffers(msg.bufs));
      } else if (msg.type === 'error') {
        worker.terminate();
        resolve(buildTerrain(onProgress));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(buildTerrain(onProgress));
    };
    worker.postMessage({ cmd: 'build' });
  });
}

// ============================================================================
// GLSL3 Solid Terrain & Prop Shader Materials (W_SOLID 4-Octave PBR Multi-Triplanar)
// ============================================================================
export function bindSharedUniforms(material, sharedUniforms) {
  material.uniforms = sharedUniforms;
  return material;
}

const SOLID_SWAY_GLSL = /* glsl */ `
  void applyFloraAndAnemoneSway(float kind, vec4 posScale, vec4 quat, vec4 meta, float time, inout vec3 lp, inout vec3 ln) {
    float physFlex = 0.0;
    // Delicate current sway for gorgonian sea fans (kind == 3)
    if (kind > 2.5 && kind < 3.5) {
      float h = clamp(lp.y * 0.25, 0.0, 1.0);
      float swayX = sin(time * 1.45 + posScale.x * 0.37 + posScale.z * 0.41 + lp.y * 0.6) * 0.14 * h * h;
      float swayZ = cos(time * 1.15 + posScale.z * 0.31) * 0.08 * h * h;
      lp.x += swayX;
      lp.z += swayZ;
      physFlex = h * h * 0.38;
    } else if (kind > 6.5 && kind < 7.5) {
      // Twisted Giant Kelp Stipe Columns (kind == 7): gentle ambient surge + full swim-wake & megafauna bending
      float h = smoothstep(0.05, 0.94, lp.y);
      lp.x += sin(time * 0.95 + posScale.x * 0.16 + lp.y * 2.4) * 0.025 * h;
      lp.z += cos(time * 0.85 + posScale.z * 0.18 + lp.y * 2.1) * 0.022 * h;
      physFlex = h * 0.92;
    } else if (kind > 7.5 && kind < 8.5) {
      // Sea Anemone (kind == 8): pedal column anchored while crown tentacles sway with waves & brush physics
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
      physFlex = flex * 0.42;
    } else if (kind > 9.5 && kind < 10.5) {
      // Giant Gorgonian Sea Fan (kind == 10): broad flexible fan undulates gently in cross-wall surge + vortex flex
      float h = clamp(length(lp.xy) * 0.45, 0.0, 1.0);
      float surge = sin(time * 0.95 + posScale.x * 0.25 + posScale.z * 0.28 + lp.x * 0.7);
      float ripple = cos(time * 1.45 + lp.y * 0.8 + posScale.y * 0.4);
      lp.z += (surge * 0.095 + ripple * 0.032) * h * h;
      physFlex = h * h * 0.34;
    }

    if (physFlex > 0.002) {
      vec3 worldRest = posScale.xyz + qrot(quat, lp * posScale.w);
      vec3 wDisp = evalFloraPhysicsDisp(worldRest, posScale.xyz, physFlex);
      float dLen = length(wDisp);
      if (dLen > 0.001) {
        float maxD = length(lp * posScale.w) * 0.85 + 0.35;
        wDisp *= (maxD / (dLen + maxD));
        vec4 invQ = vec4(-quat.xyz, quat.w);
        vec3 localDisp = qrot(invQ, wDisp / max(posScale.w, 0.05));
        float restL = length(lp);
        lp += localDisp;
        if (restL > 0.05 && length(lp) > restL) {
          lp = normalize(lp) * restL;
        }
        ln = normalize(ln + localDisp * 0.45);
      }
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

    float thW = th + warp * (0.35 + 0.65 * outRadNorm);
    float v1 = smoothstep(0.84, 0.98, abs(sin(thW * 7.5 + sin(r * 2.2 + s) * 0.28)));
    float v2 = smoothstep(0.82, 0.97, abs(sin(thW * 18.0 + wTex1 * 1.4)));
    float v3 = smoothstep(0.80, 0.96, abs(sin(thW * 42.0 - r * 2.5 + wTex2 * 1.8)));
    float radVein = max(v1, max(v2 * 0.90, v3 * 0.80));

    float cross1 = smoothstep(0.80, 0.96, abs(sin(r * 26.0 + thW * 3.0 + (wTex2 - 0.5) * 2.4)));
    float cross2 = smoothstep(0.82, 0.97, abs(sin(r * 46.0 - fp.x * 18.0 + (wTex1 - 0.5) * 3.2)));
    float filigree = max(radVein, max(cross1 * 0.82, cross2 * 0.72));

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
      applyFloraAndAnemoneSway(kind, iPosScale, iQuat, iMeta, uTime, lp, ln);
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
      bool isRockLike = kind < 0.5;
      float ts = 1.0;

      // Uniform control-flow triplanar PBR detail octaves + screen derivatives prior to alpha cutout
      TP A = tri(vOp, on, 0.10 * ts);
      TP B = tri(vOp, on, 0.43 * ts);
      TP C = tri(vOp, on, 1.90 * ts);
      TP F = tri(vOp, on, 6.70 * ts);
      vec2 sandDx = dFdx(vWPos.xz);
      vec2 sandDy = dFdy(vWPos.xz);
      float fk = isRockLike ? ss(18.0, 1.5, dist) : ss(12.0, 1.5, dist) * 0.45;

      float fanRadNorm = 0.0;
      float fanVeinMask = 1.0;
      if (kind > 9.5 && kind < 10.5) {
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
      float metallic = 0.0;
      vec3 alb = vec3(0.0);
      vec3 emi = vec3(0.0);
      float vao = vAo;
      float flu = 0.0;
      float flt = ss(0.70, 0.92, gn.y);
      ${isSkirt ? 'flt = 1.0;' : ''}
      float sandMask = 0.0;
      vec3 sandFacetNormal = gn;

      if (isRockLike) {
        // ---- High-Relief Layered Abyssal Rock + Micro-Barnacle Crust + Wet Basalt Roughness Contrast ----
        float st = vOp.y * 0.55 + A.h * 1.6 + big * 5.0 + big2 * 3.0;
        float bed = hs(floor(st));
        float sf = fract(st);

        alb = mix(vec3(0.11, 0.12, 0.13), vec3(0.33, 0.30, 0.25), sat(A.c * 1.5 - 0.25));
        alb = mix(alb, mix(vec3(0.26, 0.19, 0.10), vec3(0.20, 0.22, 0.14), bed), ss(0.42, 0.66, big) * 0.70);
        alb *= mix(0.72, 1.15, bed) * (1.0 - 0.48 * ss(0.14, 0.0, sf) * (1.0 - abs(on.y)));

        // Rust-red & ochre crustose coralline encrustations + pale calcified barnacle micro-colonies
        float enc = ss(0.46, 0.60, big2 * 0.6 + B.c * 0.5) * ss(0.30, 0.60, hgt);
        alb = mix(alb, mix(vec3(0.34, 0.07, 0.10), vec3(0.40, 0.25, 0.07), ss(0.45, 0.60, A.c)) * (0.5 + 0.8 * B.h), enc * 0.75);
        float barnacle = ss(0.64, 0.78, F.h * 0.65 + C.c * 0.5) * ss(0.42, 0.72, B.c) * fk;
        alb = mix(alb, vec3(0.54, 0.54, 0.50) * (0.65 + 0.55 * F.h), max(ss(0.60, 0.70, B.c * 0.6 + C.c * 0.5) * 0.48, barnacle * 0.72));

        // Velvety coralline olive algae on upward rock shelves
        float alg = ss(-0.1, 0.6, gn.y) * ss(0.30, 0.52, B.c * 0.55 + big * 0.5);
        alb = mix(alb, vec3(0.035, 0.14, 0.07), alg * 0.80);

        // Crevice micro-cavity darkening + wet mineral sheen contrast
        float crevice = mix(0.72, 1.0, ss(0.16, 0.54, hgt));
        alb *= (0.24 + 1.28 * hgt) * crevice * mix(1.0, 0.58 + 0.82 * F.h, fk);
        sgro = -ss(0.16, 0.0, sf) * (1.0 - abs(on.y)) * 1.35;
        gloss = mix(0.07, 0.34, ss(0.48, 0.78, A.h * 0.7 + C.h * 0.3) * (1.0 - alg * 0.72) * (1.0 - barnacle * 0.6));
        bump = 1.78;

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
          alb = mix(alb, alb * vec3(0.90, 0.82, 1.28) + vec3(0.02, 0.005, 0.04), vMeta.z * 0.35);
          vao = 0.55 + 0.45 * vAo;
        }
      } else if (kind < 1.5) {
        // 1: Barrel Sponges
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
        // 5: Monumental Stone Whale Fluke
        alb = mix(vec3(0.42, 0.47, 0.48), vec3(0.10, 0.13, 0.15), ss(0.40, 0.62, sk.a * 0.6 + sk2.b * 0.5)) * (0.75 + 0.3 * B.h);
        alb = mix(alb, vec3(0.60, 0.64, 0.62), ss(0.62, 0.75, sk2.a) * 0.5);
        gloss = 0.90;
        bump = 0.30;
        vao = 0.65 + 0.35 * vAo;
      } else if (kind < 6.5) {
        // 6: Sunken Wooden Shipwreck (PBR split oak strakes, iron nail rust stains, emerald moss & barnacle collars)
        alb = mix(vec3(0.11, 0.072, 0.042), vec3(0.35, 0.23, 0.13), Wd.b) * (0.56 + 0.54 * B.h);
        float pk = fract(atan(vOp.z, 2.0 - vOp.y) * 7.0);
        float plankGroove = 1.0 - ss(0.0, 0.12, min(pk, 1.0 - pk));
        alb *= (1.0 - 0.62 * plankGroove);
        // Iron bolt rust bleeding vertically from plank joints
        float boltDot = ss(0.25, 0.04, abs(fract(vLocalPos.z * 1.8) - 0.5)) * ss(0.22, 0.05, min(pk, 1.0 - pk));
        alb = mix(alb, vec3(0.26, 0.11, 0.05), boltDot * 0.75);
        // Velvety marine moss & pale calcified barnacle colonies
        float moss = ss(0.46, 0.68, A.c * 0.65 + big * 0.45) * (0.45 + 0.55 * ss(-0.1, 0.6, gn.y));
        alb = mix(alb, vec3(0.06, 0.21, 0.14) * (0.65 + 0.55 * C.h), moss * 0.68);
        float barn = ss(0.66, 0.80, F.h * 0.6 + C.c * 0.55) * ss(0.48, 0.72, B.c);
        alb = mix(alb, vec3(0.56, 0.55, 0.49), barn * 0.65);
        sgro = -plankGroove * 0.85;
        gloss = mix(0.14, 0.42, ss(0.48, 0.78, B.h) * (1.0 - moss * 0.65));
        bump = 0.88;
        vao = 0.60 + 0.40 * vAo;
      } else if (kind < 7.5) {
        // 7: Twisted Giant Kelp Stipe Columns
        alb = mix(vec3(0.11, 0.15, 0.06), vec3(0.22, 0.23, 0.08), B.h) * (0.75 + 0.35 * C.h);
        gloss = 0.22;
        bump = 0.95;
        flu = 0.18;
      } else if (kind < 8.5) {
        // 8: Swaying Sea Anemones
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
        // 9: Sunken WWII Fighter Plane Wreck (PBR peeling paint, bare metallic aluminum, rust streaks & barnacles)
        vec3 paintCol = mix(vec3(0.13, 0.19, 0.20), vec3(0.33, 0.38, 0.37), sat(A.c * 1.4 - 0.15));
        float gxSeam = abs(fract(vLocalPos.x * 1.15) - 0.5);
        float gzSeam = abs(fract(vLocalPos.z * 1.35) - 0.5);
        float panelSeam = 1.0 - ss(0.0, 0.036, min(gxSeam, gzSeam));
        float rvX = abs(fract(vLocalPos.x * 18.0) - 0.5);
        float rvZ = abs(fract(vLocalPos.z * 18.0) - 0.5);
        float rivet = (1.0 - ss(0.05, 0.14, length(vec2(rvX, rvZ)))) * ss(0.09, 0.01, min(gxSeam, gzSeam));

        // Peeling paint exposing brushed saltwater-oxidized metallic duralumin skin
        float bareMetal = ss(0.56, 0.74, A.c * 0.55 + B.h * 0.55) * ss(0.55, 0.92, vAo);
        vec3 baseMetal = mix(paintCol * (0.76 + 0.36 * B.h), vec3(0.58, 0.65, 0.64) * (0.82 + 0.30 * C.h), bareMetal * 0.75);
        alb = baseMetal * (1.0 - panelSeam * 0.52) + vec3(0.10, 0.12, 0.12) * rivet;

        // Gravity-aligned iron rust streaks dripping from engine cowling & panel seams
        float rustStreak = ss(0.52, 0.78, sin(vLocalPos.x * 11.0 + A.c * 6.0) * 0.5 + 0.5) * ss(0.18, 0.01, min(gxSeam, gzSeam));
        float engineRust = max(ss(3.10, 4.45, vLocalPos.z), rustStreak * 0.70);
        alb = mix(alb, vec3(0.24, 0.13, 0.08) * (0.68 + 0.55 * B.h), engineRust * 0.68);

        // Calcareous marine algae & white barnacle crust along upward wings & fuselage
        float encrust = ss(-0.05, 0.68, gn.y) * ss(0.42, 0.66, big * 0.55 + B.c * 0.55);
        alb = mix(alb, vec3(0.14, 0.26, 0.20) * (0.65 + 0.6 * C.h), encrust * 0.62);
        float barn = ss(0.65, 0.80, F.h * 0.62 + C.c * 0.52) * ss(0.46, 0.74, B.c) * ss(-0.1, 0.5, gn.y);
        alb = mix(alb, vec3(0.58, 0.58, 0.53), barn * 0.70);

        sgro = -panelSeam * 0.78;
        metallic = bareMetal * (1.0 - encrust * 0.8) * (1.0 - engineRust * 0.7) * 0.75;
        gloss = mix(0.24, 0.72, bareMetal * (1.0 - encrust * 0.75)) * (1.0 - barn * 0.6);
        bump = mix(0.48, 0.95, barn + encrust * 0.5);
        vao = 0.52 + 0.48 * vAo;
      } else if (kind < 10.5) {
        // 10: Giant Gorgonian Sea Fan
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
      } else {
        // 11: Giant Fluted Tridacna Reef Clams (calcified ivory fluted shell + electric iridescent velvet mantle lip)
        float isMantle = ss(0.68, 0.82, vAo);
        float morph = fract(vMeta.y * 6.17);
        vec3 shellCol = mix(vec3(0.52, 0.50, 0.44), vec3(0.26, 0.28, 0.24), ss(0.35, 0.68, B.c)) * (0.65 + 0.55 * C.h);
        vec3 mantleBase = morph < 0.5 ? vec3(0.04, 0.26, 0.56) : vec3(0.18, 0.08, 0.44);
        vec3 mantleRim  = morph < 0.5 ? vec3(0.16, 0.88, 0.96) : vec3(0.56, 0.36, 0.98);
        float spot = ss(0.48, 0.72, F.h * 0.7 + C.c * 0.5);
        vec3 mantleCol = mix(mantleBase, mantleRim, spot);
        alb = mix(shellCol, mantleCol, isMantle);
        emi = mantleCol * isMantle * 0.06;
        flu = isMantle * 0.90;
        gloss = mix(0.18, 0.55, isMantle);
        bump = mix(1.15, 0.35, isMantle);
        vao = mix(0.55 + 0.45 * vAo, 0.92, isMantle);
      }

      vec3 rockN = normalize(qrot(
        vQuat,
        normalize(on + (A.n * 0.85 + B.n * 0.65 + C.n * 0.45 * ss(60.0, 12.0, dist) + F.n * 0.58 * fk) * bump + vec3(0.8, sgro, 0.35))
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
      vec3 amLit = (amb(vWPos, N, sky, z) + sideLight(vWPos, N, sideOpen, z)) * ao;
      vec3 dl = E * ndl * (0.10 + mix(vec3(0.33), ca, ss(0.10, 0.45, dot(gn, L))) * 2.5);
      vec3 c = alb * (1.0 - metallic * 0.45) * (dl + amLit) + emi + alb * flu * dot(dl + amLit, vec3(0.1, 0.5, 0.5));
      if (kind > 9.5 && kind < 10.5) {
        float backSun = pow(sat(dot(-V, L) * 0.55 + 0.45), 2.2);
        float transWeight = (1.0 - (1.0 - ss(0.44, 0.56, vAo)) * 0.72);
        c += alb * (E * (0.12 + 0.38 * backSun) + vec3(0.14, 0.28, 0.34) * sky * 0.22) * transWeight;
      }

      vec3 H = normalize(V + L);
      vec3 specTint = mix(vec3(1.0), alb * 1.4, metallic);
      vec3 rockSpecCol = E * (0.25 + ca) * specTint * pow(sat(dot(N, H)), mix(12.0, 82.0, gloss)) * gloss * ndl * (1.8 + metallic * 1.4);
      vec3 rockEnvCol = (amb(vWPos, reflect(-V, N), sky, z) + sideLight(vWPos, reflect(-V, N), sideOpen, z)) * ao * specTint * (0.08 + gloss) * (0.6 + metallic * 0.75) * pow(1.0 - sat(dot(N, V)), 2.5);
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
    uniform vec3 uCamPos;

    vec3 qrot(vec4 q, vec3 v) {
      return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
    }

    ${instanced ? `
    ${FLORA_PHYSICS_GLSL}
    ${SOLID_SWAY_GLSL}
    ` : ''}

    void main() {
      vec3 lp = position;
      vec3 dummyN = vec3(0.0, 1.0, 0.0);
      vec3 wp;
      ${instanced ? `
      float kind = floor(iMeta.x + 0.5);
      applyFloraAndAnemoneSway(kind, iPosScale, iQuat, iMeta, uTime, lp, dummyN);
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
      if (kind > 9.5 && kind < 10.5) {
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
