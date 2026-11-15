import * as THREE from 'three';

// ============================================================================
// Unified Water Optics System
// Combines:
// 1. threejs-water-optics/interactive-pool-volume:
//    GPU 2D Wave-Equation Heightfield (InteractiveWaterHeightfield) with
//    3D sphere/body volume displacement (volumeInSphere) + interactive pointer drops
//    + 5-tap normal & Laplacian curvature extraction.
// 2. threejs-spectral-ocean/submerged-snell-ocean & threejs-water-optics/photoreal-water:
//    3x3 Instanced Differential-Area Mesh Caustics (dFdx/dFdy oldArea/newArea)
//    with 3-channel Chromatic IOR Dispersion [1.3315, 1.3335, 1.3365].
// ============================================================================

const FULLSCREEN_VS = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class InteractiveWaterHeightfield {
  constructor(renderer, {
    resolution = 256,
    worldSize = 96.0,
    damping = 0.9962,
    waveSpeed = 1.45,
  } = {}) {
    this.renderer = renderer;
    this.resolution = resolution;
    this.worldSize = worldSize;
    this.center = new THREE.Vector2(0, 0);
    this._shiftUv = new THREE.Vector2(0, 0);

    const rtOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };

    this.targetA = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);
    this.targetB = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);
    this.normalTarget = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    // 1. Wave-equation step + texel-snapped camera shift + optional drop impulse
    // (Ported from photoreal-water.js pRipple + interactive-pool-volume stepMaterial)
    this.stepMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tInput: { value: null },
        uDelta: { value: new THREE.Vector2(1.0 / resolution, 1.0 / resolution) },
        uShift: { value: new THREE.Vector2(0, 0) },
        uDamping: { value: damping },
        uWaveSpeed: { value: waveSpeed },
        uDrops: {
          value: [
            new THREE.Vector4(0, 0, 0, 0),
            new THREE.Vector4(0, 0, 0, 0),
            new THREE.Vector4(0, 0, 0, 0),
            new THREE.Vector4(0, 0, 0, 0),
          ],
        },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */ `
        precision highp float;
        const float PI = 3.141592653589793;
        uniform sampler2D tInput;
        uniform vec2 uDelta;
        uniform vec2 uShift;
        uniform float uDamping;
        uniform float uWaveSpeed;
        uniform vec4 uDrops[4];
        in vec2 vUv;
        layout(location = 0) out vec4 fragColor;

        void main() {
          vec2 uv = vUv + uShift;
          vec4 info = texture(tInput, uv);
          vec2 dx = vec2(uDelta.x, 0.0);
          vec2 dy = vec2(0.0, uDelta.y);
          float avg = 0.25 * (
            texture(tInput, uv - dx).r +
            texture(tInput, uv + dx).r +
            texture(tInput, uv - dy).r +
            texture(tInput, uv + dy).r
          );
          float v = info.g + (avg - info.r) * uWaveSpeed;
          v *= uDamping;
          float h = info.r + v;
          h *= 0.9972;

          for (int i = 0; i < 4; i++) {
            vec4 drp = uDrops[i];
            if (abs(drp.w) > 1e-5) {
              float d = length(vUv - drp.xy);
              float r = max(drp.z, 1e-4);
              if (d < r) {
                float drop = 0.5 - cos((1.0 - d / r) * PI) * 0.5;
                h += drop * drp.w * 0.65;
                v += drop * drp.w * 0.35;
              }
            }
          }

          // Smooth border sponge fade so local wave field blends seamlessly into open ocean
          vec2 edgeVec = min(vUv, 1.0 - vUv);
          float edge = smoothstep(0.0, 0.08, min(edgeVec.x, edgeVec.y));
          h *= edge;
          v *= edge;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
            h = 0.0;
            v = 0.0;
          }
          fragColor = vec4(clamp(h, -2.0, 2.0), clamp(v, -1.0, 1.0), info.b, info.a);
        }
      `,
    });

    // 2. 3D Volume Displacement + Hydrodynamic Bow/Stroke Wake Pass
    // (Upgraded from interactive-pool-volume sphereMaterial for open-ocean 1:1 cetacean hydrodynamics)
    this.sphereMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tInput: { value: null },
        uOldCenter: { value: new THREE.Vector3() },
        uNewCenter: { value: new THREE.Vector3() },
        uRadius: { value: 0.05 },
        uDisplacementScale: { value: 1.0 },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tInput;
        uniform vec3 uOldCenter;
        uniform vec3 uNewCenter;
        uniform float uRadius;
        uniform float uDisplacementScale;
        in vec2 vUv;
        layout(location = 0) out vec4 fragColor;

        float volumeInSphere(vec3 center) {
          vec2 toCenter = (vUv * 2.0 - 1.0) - center.xz;
          float r = length(toCenter) / max(uRadius, 1e-4);
          if (r > 2.2) return 0.0;
          float surfOverlap = exp(-center.y * center.y * 0.42);
          float dy = exp(-pow(r * 1.18, 4.0));
          float ymin = min(0.0, center.y - dy);
          float ymax = min(max(0.0, center.y + dy), ymin + 2.0 * dy);
          return (ymax - ymin) * 0.48 * surfOverlap * uDisplacementScale;
        }

        void main() {
          vec4 info = texture(tInput, vUv);
          float h = info.r + volumeInSphere(uOldCenter) - volumeInSphere(uNewCenter);

          // Continuous hydrodynamic Kelvin bow ridge (+) and stern trough (-) + plunge stroke impulse
          vec2 off = (vUv * 2.0 - 1.0) - uNewCenter.xz;
          float rr = length(off) / max(uRadius, 1e-4);
          if (rr < 2.6) {
            float newOverlap = exp(-uNewCenter.y * uNewCenter.y * 0.42);
            vec2 moveVec = uNewCenter.xz - uOldCenter.xz;
            float moveLen = length(moveVec);
            if (moveLen > 1e-6 && rr > 1e-4) {
              vec2 moveDir = moveVec / moveLen;
              float bowSignal = dot(off / max(length(off), 1e-5), moveDir) * rr * exp(-rr * rr * 1.05);
              h += bowSignal * min(moveLen / max(uRadius, 1e-4), 0.25) * 1.65 * newOverlap * uDisplacementScale;
            }
            float vyDelta = clamp(uOldCenter.y - uNewCenter.y, -0.35, 0.35);
            h += vyDelta * exp(-rr * rr * 1.25) * 1.20 * newOverlap * uDisplacementScale;
          }

          info.r = clamp(h, -2.0, 2.0);
          fragColor = info;
        }
      `,
    });

    // 3. Normal & Laplacian Curvature Pass (combines interactive-pool-volume normalMaterial + photoreal-water pRipN)
    // Outputs: R = height, G = dh/dx, B = dh/dz, A = Laplacian curvature (d2h/dx2 + d2h/dz2)
    this.normalMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tInput: { value: null },
        uDelta: { value: new THREE.Vector2(1.0 / resolution, 1.0 / resolution) },
        uTexelMeters: { value: worldSize / resolution },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tInput;
        uniform vec2 uDelta;
        uniform float uTexelMeters;
        in vec2 vUv;
        layout(location = 0) out vec4 fragColor;

        void main() {
          float hC = texture(tInput, vUv).r;
          float hL = texture(tInput, vUv - vec2(uDelta.x, 0.0)).r;
          float hR = texture(tInput, vUv + vec2(uDelta.x, 0.0)).r;
          float hD = texture(tInput, vUv - vec2(0.0, uDelta.y)).r;
          float hU = texture(tInput, vUv + vec2(0.0, uDelta.y)).r;

          float dhdx = (hR - hL) / (2.0 * uTexelMeters);
          float dhdz = (hU - hD) / (2.0 * uTexelMeters);
          float lap = (hL + hR + hD + hU - 4.0 * hC) / (uTexelMeters * uTexelMeters);
          fragColor = vec4(hC, dhdx, dhdz, clamp(lap, -8.0, 8.0));
        }
      `,
    });

    this.dropQueue = [];
    this.prevWhaleHead = new THREE.Vector3(0, 10, 0);
    this.prevWhaleMother = new THREE.Vector3(0, 10, 0);
    this.prevWhaleFluke = new THREE.Vector3(0, 10, 0);
    this.prevWhaleCalfHead = new THREE.Vector3(0, 10, 0);
    this.prevWhaleCalf = new THREE.Vector3(0, 10, 0);
    this.prevWhaleCalfFluke = new THREE.Vector3(0, 10, 0);
    this.prevCam = new THREE.Vector3(0, 10, 0);
    this._initializedBodies = false;
    this._scratchOld = new THREE.Vector3();
    this._scratchNew = new THREE.Vector3();
    this._ambientTimer = 0;

    // Seed gentle initial ripples so sunlit refraction starts alive
    const seedDrops = [
      [-8.0, 6.0, 0.025, 0.08],
      [5.5, -4.2, 0.028, -0.07],
      [-2.5, -9.0, 0.024, 0.075],
      [9.0, 7.5, 0.030, -0.08],
      [1.2, 3.8, 0.022, 0.06],
    ];
    for (const [x, z, r, s] of seedDrops) {
      this.addWorldDrop(x, z, r, s);
    }
  }

  get texture() {
    return this.normalTarget.texture;
  }

  _swap() {
    const tmp = this.targetA;
    this.targetA = this.targetB;
    this.targetB = tmp;
  }

  _runPass(material, outTarget = null) {
    this.quad.material = material;
    material.uniforms.tInput.value = this.targetA.texture;
    const dst = outTarget || this.targetB;
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this.scene, this.camera);
    if (!outTarget) this._swap();
  }

  addWorldDrop(worldX, worldZ, radiusUv = 0.035, strength = 0.14) {
    const u = (worldX - this.center.x) / this.worldSize + 0.5;
    const v = (worldZ - this.center.y) / this.worldSize + 0.5;
    if (u < 0.04 || u > 0.96 || v < 0.04 || v > 0.96) return;
    if (this.dropQueue.length < 24) {
      this.dropQueue.push([u, v, radiusUv, strength]);
    }
  }

  moveWorldSphere(oldWorld, newWorld, radiusMeters, displacementScale = 1.0, waveHeight = 0.0) {
    const half = this.worldSize * 0.5;
    if (
      Math.abs(newWorld.x - this.center.x) > half * 0.92 ||
      Math.abs(newWorld.z - this.center.y) > half * 0.92
    ) {
      return;
    }
    const maxInteractDepth = radiusMeters * 2.8 + 1.5;
    if (
      oldWorld.y - waveHeight < -maxInteractDepth &&
      newWorld.y - waveHeight < -maxInteractDepth
    ) {
      return;
    }

    const invR = 1.0 / Math.max(radiusMeters, 0.5);
    this.sphereMaterial.uniforms.uOldCenter.value.set(
      (oldWorld.x - this.center.x) / half,
      (oldWorld.y - waveHeight) * invR,
      (oldWorld.z - this.center.y) / half
    );
    this.sphereMaterial.uniforms.uNewCenter.value.set(
      (newWorld.x - this.center.x) / half,
      (newWorld.y - waveHeight) * invR,
      (newWorld.z - this.center.y) / half
    );
    this.sphereMaterial.uniforms.uRadius.value = radiusMeters / half;
    this.sphereMaterial.uniforms.uDisplacementScale.value = displacementScale;
    this._runPass(this.sphereMaterial);
  }

  update(dt, cameraPos, whalePod) {
    const prevTarget = this.renderer.getRenderTarget();

    // 1. Keep ripple simulation centered near camera XZ, snapped to whole texels
    const texel = this.worldSize / this.resolution;
    const dxT = Math.round((cameraPos.x - this.center.x) / texel);
    const dzT = Math.round((cameraPos.z - this.center.y) / texel);
    if (Math.abs(dxT) > this.resolution * 0.5 || Math.abs(dzT) > this.resolution * 0.5) {
      this.center.set(Math.round(cameraPos.x / texel) * texel, Math.round(cameraPos.z / texel) * texel);
      this._shiftUv.set(0, 0);
    } else {
      this._shiftUv.set(dxT / this.resolution, dzT / this.resolution);
      this.center.x += dxT * texel;
      this.center.y += dzT * texel;
    }

    // 2. Displace water heightfield with multi-segment 3D cetacean hull (Head, Torso, Flukes) + Diver/Camera
    const ctrl = whalePod && whalePod.controller;
    const waveH = ctrl && ctrl.sharedUniforms ? ctrl.sharedUniforms.uWaveHeight.value : 0.0;
    if (ctrl) {
      if (!this._initializedBodies) {
        this.prevWhaleHead.copy(ctrl.mHeadPos);
        this.prevWhaleMother.copy(ctrl.mPos);
        this.prevWhaleFluke.copy(ctrl.mFlukePos);
        this.prevWhaleCalfHead.copy(ctrl.cHeadPos);
        this.prevWhaleCalf.copy(ctrl.cPos);
        this.prevWhaleCalfFluke.copy(ctrl.cFlukePos);
        this.prevCam.copy(cameraPos);
        this._initializedBodies = true;
      } else {
        this.moveWorldSphere(this.prevWhaleHead, ctrl.mHeadPos, 3.6, 1.85, waveH);
        this.moveWorldSphere(this.prevWhaleMother, ctrl.mPos, 4.4, 2.25, waveH);
        this.moveWorldSphere(this.prevWhaleFluke, ctrl.mFlukePos, 3.8, 2.40, waveH);
        this.moveWorldSphere(this.prevWhaleCalfHead, ctrl.cHeadPos, 2.0, 1.35, waveH);
        this.moveWorldSphere(this.prevWhaleCalf, ctrl.cPos, 2.4, 1.55, waveH);
        this.moveWorldSphere(this.prevWhaleCalfFluke, ctrl.cFlukePos, 2.1, 1.65, waveH);
        if (Math.abs(cameraPos.y - waveH) < 3.2) {
          this.moveWorldSphere(this.prevCam, cameraPos, 1.4, 0.55, waveH);
        }
        this.prevWhaleHead.copy(ctrl.mHeadPos);
        this.prevWhaleMother.copy(ctrl.mPos);
        this.prevWhaleFluke.copy(ctrl.mFlukePos);
        this.prevWhaleCalfHead.copy(ctrl.cHeadPos);
        this.prevWhaleCalf.copy(ctrl.cPos);
        this.prevWhaleCalfFluke.copy(ctrl.cFlukePos);
        this.prevCam.copy(cameraPos);
      }

      // Consume explicit whale breach / fluke-slap impulses emitted by WhalePodController
      while (ctrl.surfaceImpulses.length > 0) {
        const imp = ctrl.surfaceImpulses.pop();
        this.addWorldDrop(imp.x, imp.z, imp.radius / this.worldSize, imp.strength);
      }
    }

    // Periodic fluke wash rings when pod swims close beneath the free surface
    this._ambientTimer += dt;
    if (this._ambientTimer > 0.28 && ctrl) {
      this._ambientTimer = 0;
      if (ctrl.mFlukePos.y - waveH > -5.5) {
        this.addWorldDrop(ctrl.mFlukePos.x, ctrl.mFlukePos.z, 0.048, -0.18);
      }
      if (ctrl.mPos.y - waveH > -5.5) {
        this.addWorldDrop(ctrl.mHeadPos.x, ctrl.mHeadPos.z, 0.042, 0.14);
      }
    }

    // 3. Step 2D shallow-water wave equation 3x per frame with up to 4 parallel drop impulses
    const dropsUniform = this.stepMaterial.uniforms.uDrops.value;
    for (let s = 0; s < 3; s++) {
      this.stepMaterial.uniforms.uShift.value.set(
        s === 0 ? this._shiftUv.x : 0.0,
        s === 0 ? this._shiftUv.y : 0.0
      );
      for (let k = 0; k < 4; k++) {
        const drop = s === 0 ? this.dropQueue.shift() : null;
        if (drop) {
          dropsUniform[k].set(drop[0], drop[1], drop[2], drop[3]);
        } else {
          dropsUniform[k].set(0, 0, 0, 0);
        }
      }
      this._runPass(this.stepMaterial);
    }

    // 4. Compute slope normals & Laplacian curvature
    this._runPass(this.normalMaterial, this.normalTarget);
    this.renderer.setRenderTarget(prevTarget);
  }
}

// ============================================================================
// Differential-Area Chromatic Caustics Pass
// Ported from:
// - threejs-spectral-ocean/submerged-snell-ocean/source/caustics.ts
// - threejs-water-optics/photoreal-water/photoreal-water.js (3-channel IORs)
// - threejs-water-optics/interactive-pool-volume/water-volume-system.js
// ============================================================================
export const CAUSTIC_TILE_METERS = 28.0;
const CAUSTIC_GRID = 192;
const CAUSTIC_PROJECT_DEPTH = 18.0;
const CHROMATIC_IORS = [1.3315, 1.3335, 1.3365];

export class DifferentialCausticsPass {
  constructor(renderer, resolution = 512, grid = CAUSTIC_GRID) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(resolution, resolution, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uDispMap: { value: null },
        uDerivMap: { value: null },
        uSunDir: { value: new THREE.Vector3(0.32, 0.91, -0.26).normalize() },
        uTile: { value: CAUSTIC_TILE_METERS },
        uDepth: { value: CAUSTIC_PROJECT_DEPTH },
        uIor: { value: CHROMATIC_IORS[1] },
        uChannelMask: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uDispMap;
        uniform sampler2D uDerivMap;
        uniform vec3 uSunDir;
        uniform float uTile;
        uniform float uDepth;
        uniform float uIor;

        out vec2 vOld;
        out vec2 vNew;

        void main() {
          vec2 uv01 = position.xy * 0.5 + 0.5;
          vec2 worldXZ = uv01 * uTile;

          vec4 der = textureLod(uDerivMap, uv01, 0.0);
          vec4 disp = textureLod(uDispMap, uv01, 0.0);

          vec3 surfaceNormal = normalize(vec3(-der.x * 0.85, 1.0, -der.y * 0.85));
          float eta = 1.0 / uIor;
          vec3 flatRefract = refract(-uSunDir, vec3(0.0, 1.0, 0.0), eta);
          vec3 waveRefract = refract(-uSunDir, surfaceNormal, eta);

          vec2 flatShift = flatRefract.xz * (uDepth / max(abs(flatRefract.y), 0.1));
          vec2 oldPos = worldXZ + flatShift;
          vec2 newPos = worldXZ + disp.xz * 0.65 + waveRefract.xz * ((uDepth + disp.y * 0.65) / max(abs(waveRefract.y), 0.1));

          // Remove mean refraction drift so pattern stays tile-centered (submerged-snell-ocean & photoreal-water)
          vec2 centered = newPos - flatShift;

          vOld = oldPos;
          vNew = newPos;

          // 3x3 wrap instances so rays refracting across tile boundaries wrap seamlessly
          int iid = gl_InstanceID;
          float ix = float((iid % 3) - 1) * 2.0;
          float iy = float((iid / 3) - 1) * 2.0;
          vec2 ndc = (centered / uTile) * 2.0 - 1.0 + vec2(ix, iy);
          gl_Position = vec4(ndc, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uChannelMask;
        in vec2 vOld;
        in vec2 vNew;
        layout(location = 0) out vec4 fragColor;

        void main() {
          float oldArea = length(dFdx(vOld)) * length(dFdy(vOld));
          float newArea = max(length(dFdx(vNew)) * length(dFdy(vNew)), 1e-6);
          float intensity = min((oldArea / newArea) * 0.22, 4.5);
          fragColor = vec4(uChannelMask * intensity, 0.0);
        }
      `,
    });

    const gridGeo = new THREE.PlaneGeometry(2, 2, grid, grid);
    this.mesh = new THREE.InstancedMesh(gridGeo, this.material, 9);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get texture() {
    return this.target.texture;
  }

  update(oceanSystem, sunDir) {
    if (!oceanSystem || !oceanSystem.cascades || !oceanSystem.cascades[1]) return;
    const cascade1 = oceanSystem.cascades[1];
    this.material.uniforms.uDispMap.value = cascade1.displacement;
    this.material.uniforms.uDerivMap.value = cascade1.derivatives.texture;
    this.material.uniforms.uSunDir.value.copy(sunDir);

    const prevTarget = this.renderer.getRenderTarget();
    const prevColor = new THREE.Color();
    this.renderer.getClearColor(prevColor);
    const prevAlpha = this.renderer.getClearAlpha();

    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0.0);
    this.renderer.clear(true, false, false);

    // Render 3 chromatic dispersion passes (R, G, B at IOR 1.3315, 1.3335, 1.3365 from photoreal-water)
    for (let c = 0; c < 3; c++) {
      this.material.uniforms.uIor.value = CHROMATIC_IORS[c];
      this.material.uniforms.uChannelMask.value.set(
        c === 0 ? 1 : 0,
        c === 1 ? 1 : 0,
        c === 2 ? 1 : 0
      );
      this.renderer.render(this.scene, this.camera);
    }

    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevColor, prevAlpha);
  }
}
