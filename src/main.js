import './style.css';
import * as THREE from 'three';
import {
  SUN_DIR,
  createSharedUniforms,
  MEDIUM_GLSL,
  createDetailTexture,
  createWaterCausticSystem,
} from './env/medium.js';
import {
  buildTerrain,
  createSolidMaterial,
  createSolidShadowMaterial,
} from './env/terrain.js';
import { DeformableSandSystem } from './env/deformable-sand.js';
import { compileWorldEcology } from './coral-system.js';
import { createSharkRig, createWhalePodRig, compileMarineLife } from './shark-system.js';
import { SpectralOceanSystem } from './ocean/ocean-system.js';
import {
  createAbyssalSurfaceMaterial,
  createAbyssalBackdropMaterial,
} from './ocean/stylized-ocean-material.js';
import {
  InteractiveWaterHeightfield,
  DifferentialCausticsPass,
} from './ocean/water-optics.js';
import { OceanAudioSystem } from './audio/ocean-audio.js';

// ============================================================================
// Renderer, Camera & Scene Boot
// ============================================================================
const container = document.getElementById('canvas-container');
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: 'high-performance',
});
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.autoClear = false;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const oceanScene = new THREE.Scene();
const shadowScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 650);
camera.rotation.order = 'YXZ';

const isCoarsePointer =
  window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(any-pointer: coarse)').matches;
const isMobileDevice =
  isCoarsePointer ||
  'ontouchstart' in window ||
  (navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) <= 1024);
if (isMobileDevice && document.body) {
  document.body.classList.add('has-touch');
}

const SHADOW_RES = isMobileDevice ? 1024 : 2048;
const shadowCam = new THREE.OrthographicCamera(-68, 68, 68, -68, 2.0, 220.0);

const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const passScene = new THREE.Scene();
const passQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
passQuad.frustumCulled = false;
passScene.add(passQuad);

// ============================================================================
// Shared Abyssal Medium, Terrain, Ecology, Shark, Marine Life & FFT Ocean
// ============================================================================
const sharedUniforms = createSharedUniforms();
sharedUniforms.uSunDir.value.copy(SUN_DIR);
sharedUniforms.uShadowSize.value = SHADOW_RES;
sharedUniforms.uDetailTex.value = createDetailTexture(renderer);

const waterCaustics = createWaterCausticSystem(renderer);
sharedUniforms.uWaterTex.value = waterCaustics.texture;

const terrain = buildTerrain();
sharedUniforms.uVolTex.value = terrain.volTex;
sharedUniforms.uZoneMapTex.value = terrain.zoneMapTex;

const deformableSand = new DeformableSandSystem(renderer, sharedUniforms, {
  resolution: isMobileDevice ? 256 : 512,
  worldSize: 44.0,
});
sharedUniforms.uSandBedTex.value = deformableSand.texture;
sharedUniforms.uSandLightTex.value = deformableSand.lightTexture;
sharedUniforms.uSandSize.value = deformableSand.worldSize;
scene.add(deformableSand.grainMesh);

const terrainMat = createSolidMaterial(sharedUniforms, { instanced: false });
const skirtMat = createSolidMaterial(sharedUniforms, { instanced: false, isSkirt: true });
const terrainShadowMat = createSolidShadowMaterial({ instanced: false, sharedUniforms });

const terrainMesh = new THREE.Mesh(terrain.geometry, terrainMat);
terrainMesh.frustumCulled = false;
scene.add(terrainMesh);

const skirtMesh = new THREE.Mesh(terrain.skirtGeometry, skirtMat);
skirtMesh.frustumCulled = false;
scene.add(skirtMesh);

const terrainShadowMesh = new THREE.Mesh(terrain.geometry, terrainShadowMat);
terrainShadowMesh.frustumCulled = false;
shadowScene.add(terrainShadowMesh);

const ecology = compileWorldEcology(terrain, sharedUniforms, { isMobile: isMobileDevice });
scene.add(ecology.group);
shadowScene.add(ecology.shadowGroup);

const sharkRig = createSharkRig(terrain, sharedUniforms);
scene.add(sharkRig.sharkMesh);
shadowScene.add(sharkRig.sharkShadowMesh);

const whalePod = createWhalePodRig(terrain, sharedUniforms);
scene.add(whalePod.motherMesh);
scene.add(whalePod.calfMesh);
oceanScene.add(whalePod.effectsMesh);
shadowScene.add(whalePod.motherShadowMesh);
shadowScene.add(whalePod.calfShadowMesh);

const marineLife = compileMarineLife(terrain, sharedUniforms);
scene.add(marineLife.group);
shadowScene.add(marineLife.shadowGroup);

// Seamless Sky & Underwater Abyss Sphere
const backdropMesh = new THREE.Mesh(
  new THREE.SphereGeometry(420, 48, 32),
  createAbyssalBackdropMaterial(sharedUniforms, MEDIUM_GLSL)
);
backdropMesh.frustumCulled = false;
scene.add(backdropMesh);

// GPU FFT Spectral Ocean Surface — Tuned for a calm, sunny tropical diving day (適合潛水的晴天)
const patchLengths = [180, 28, 6];
const oceanSystem = new SpectralOceanSystem(renderer, {
  resolution: isMobileDevice ? 128 : 256,
  patchLengths,
  boundaryFactor: 6,
  gravity: 9.81,
  depth: 500,
  amplitude: 0.18,
  choppiness: 0.52,
  foamRecovery: 0.85,
  seed: 7,
  local: {
    scale: 0.52,
    windSpeed: 3.6,
    directionDegrees: 42,
    fetchMeters: 45000,
    directionality: 0.82,
    swell: 0.35,
    peakEnhancement: 3.3,
    shortWaveFade: 0.015,
  },
  swell: {
    scale: 0.38,
    windSpeed: 1.8,
    directionDegrees: 68,
    fetchMeters: 160000,
    directionality: 0.92,
    swell: 0.95,
    peakEnhancement: 3.3,
    shortWaveFade: 0.01,
  },
});

const waterHeightfield = new InteractiveWaterHeightfield(renderer, {
  resolution: isMobileDevice ? 128 : 256,
  worldSize: 96.0,
  damping: 0.9962,
  waveSpeed: 1.45,
});
sharedUniforms.uRippleTex.value = waterHeightfield.texture;
sharedUniforms.uRippleSize.value = waterHeightfield.worldSize;

const differentialCaustics = new DifferentialCausticsPass(
  renderer,
  isMobileDevice ? 256 : 512,
  isMobileDevice ? 96 : 192
);
sharedUniforms.uCausticTex.value = differentialCaustics.texture;

const abyssalOceanMat = createAbyssalSurfaceMaterial(sharedUniforms, MEDIUM_GLSL, patchLengths);
// Provide 1x1 white fallback while foam.webp loads
const foamFallback = new THREE.DataTexture(new Uint8Array([180, 180, 180, 255]), 1, 1);
foamFallback.needsUpdate = true;
abyssalOceanMat.uniforms.uFoamTexture.value = foamFallback;
new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}assets/stylized-above-below-ocean/foam.webp`, (tex) => {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  abyssalOceanMat.uniforms.uFoamTexture.value = tex;
});

const oceanSegs = isMobileDevice ? 200 : 512;
const oceanGeo = new THREE.PlaneGeometry(760, 760, oceanSegs, oceanSegs);
oceanGeo.rotateX(-Math.PI * 0.5);
const oceanMesh = new THREE.Mesh(oceanGeo, abyssalOceanMat);
oceanMesh.frustumCulled = false;
oceanMesh.renderOrder = -10;
oceanScene.add(oceanMesh);

// ============================================================================
// Multi-Pass Render Targets (Shadow 2048, Refract HDR, Scene HDR, Half-Res Rays, 4-Mip Bloom)
// ============================================================================
const shadowDepthTex = new THREE.DepthTexture(SHADOW_RES, SHADOW_RES);
shadowDepthTex.type = THREE.UnsignedIntType;
shadowDepthTex.minFilter = THREE.NearestFilter;
shadowDepthTex.magFilter = THREE.NearestFilter;

const shadowTarget = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  depthBuffer: true,
  depthTexture: shadowDepthTex,
});
sharedUniforms.uShadowTex.value = shadowDepthTex;

let renderW = 1;
let renderH = 1;
let refractTarget = null;
let sceneTarget = null;
let tRaysRaw = null;
let tRaysBlur = null;
const bloomDown = [];
const bloomUp = [];

const refractCopyMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  depthTest: true,
  depthFunc: THREE.AlwaysDepth,
  depthWrite: true,
  uniforms: {
    uSrcColor: { value: null },
    uSrcDepth: { value: null },
  },
  vertexShader: /* glsl */ `
    out vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uSrcColor;
    uniform sampler2D uSrcDepth;
    in vec2 vUv;
    layout(location = 0) out vec4 fragColor;
    void main() {
      fragColor = texture(uSrcColor, vUv);
      gl_FragDepth = texture(uSrcDepth, vUv).r;
    }
  `,
});

function createTargets(w, h) {
  if (refractTarget) refractTarget.dispose();
  if (sceneTarget) sceneTarget.dispose();
  if (tRaysRaw) tRaysRaw.dispose();
  if (tRaysBlur) tRaysBlur.dispose();
  for (const t of bloomDown) t.dispose();
  for (const t of bloomUp) t.dispose();
  bloomDown.length = 0;
  bloomUp.length = 0;

  renderW = Math.max(2, w);
  renderH = Math.max(2, h);

  const refractDepth = new THREE.DepthTexture(renderW, renderH);
  refractDepth.type = THREE.UnsignedIntType;
  refractDepth.minFilter = THREE.NearestFilter;
  refractDepth.magFilter = THREE.NearestFilter;

  refractTarget = new THREE.WebGLRenderTarget(renderW, renderH, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture: refractDepth,
  });
  sharedUniforms.uRefractTex.value = refractTarget.texture;
  sharedUniforms.uRefractDepth.value = refractDepth;

  const sceneDepth = new THREE.DepthTexture(renderW, renderH);
  sceneDepth.type = THREE.UnsignedIntType;
  sceneDepth.minFilter = THREE.NearestFilter;
  sceneDepth.magFilter = THREE.NearestFilter;

  sceneTarget = new THREE.WebGLRenderTarget(renderW, renderH, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture: sceneDepth,
  });

  const halfW = Math.max(2, Math.floor(renderW * 0.5));
  const halfH = Math.max(2, Math.floor(renderH * 0.5));
  tRaysRaw = new THREE.WebGLRenderTarget(halfW, halfH, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  tRaysBlur = new THREE.WebGLRenderTarget(halfW, halfH, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  let mw = halfW;
  let mh = halfH;
  for (let i = 0; i < 4; i++) {
    bloomDown.push(
      new THREE.WebGLRenderTarget(mw, mh, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      })
    );
    if (i < 3) {
      bloomUp.push(
        new THREE.WebGLRenderTarget(mw, mh, {
          type: THREE.HalfFloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
        })
      );
    }
    mw = Math.max(2, Math.floor(mw * 0.5));
    mh = Math.max(2, Math.floor(mh * 0.5));
  }
}

// ============================================================================
// Screen-Space Shader Passes (W_RAYS, W_RBLUR, W_BLIT, W_POST — GLSL3)
// ============================================================================
const PASS_VS = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// 1. Half-Resolution Volumetric Crepuscular God Rays (W_RAYS)
const raysUniforms = {
  ...sharedUniforms,
  uSceneDepth: { value: null },
  uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(31)) },
  uAspect: { value: 1.0 },
  uNear: { value: 0.25 },
  uFar: { value: 650.0 },
};

const raysMat = new THREE.ShaderMaterial({
  uniforms: raysUniforms,
  vertexShader: PASS_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    uniform sampler2D uSceneDepth;
    uniform float uTanHalfFov;
    uniform float uAspect;
    uniform float uNear;
    uniform float uFar;

    ${MEDIUM_GLSL}

    in vec2 vUv;
    layout(location = 0) out vec4 fragColor;

    float linearizeDepth(float d) {
      float zNdc = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - zNdc * (uFar - uNear));
    }

    void main() {
      // Fade cleanly to zero when camera emerges above wave surface
      float underwater = 1.0 - smoothstep(uWaveHeight - 0.15, uWaveHeight + 0.2, uCamPos.y);
      if (underwater < 0.005) {
        fragColor = vec4(0.0);
        return;
      }

      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 rayUnnorm = uCamFwd + uCamRight * (ndc.x * uTanHalfFov * uAspect) + uCamUp * (ndc.y * uTanHalfFov);
      vec3 rd = normalize(rayUnnorm);

      float rawD = texture(uSceneDepth, vUv).r;
      float tMax = 72.0;
      if (rawD < 0.9999) {
        float linZ = linearizeDepth(rawD);
        tMax = min(tMax, linZ / max(dot(rd, uCamFwd), 1e-4));
      }

      // Asymmetric forward-scattering Mie phase toward sun (clamped for smooth shaft core)
      float cosS = dot(rd, uSunDir);
      float g = 0.68;
      float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosS, 0.05), 1.5);
      float phase = 0.25 + 0.75 * min(hg * 0.28, 1.8);
      float bhCamDist = smoothstep(46.0, 24.0, length(uCamPos.xz - vec2(61.5, 64.5)));
      float rayPhase = mix(phase, max(phase, 0.48), bhCamDist);

      const int STEPS = ${isMobileDevice ? 14 : 28};
      float stepL = (tMax - 0.6) / float(STEPS);
      if (stepL <= 0.001) {
        fragColor = vec4(0.0);
        return;
      }

      float jitter = ign(gl_FragCoord.xy + vec2(fract(uTime * 13.7) * 89.0, fract(uTime * 7.3) * 61.0));
      vec3 accum = vec3(0.0);

      for (int i = 0; i < STEPS; i++) {
        float t = 0.6 + (float(i) + jitter) * stepL;
        vec3 wp = uCamPos + rd * t;
        if (wp.y > uWaveHeight) continue;

        float sh = shadow1(wp);
        if (sh > 0.01) {
          float bhHere = blueHoleFactor(wp);
          vec2 q = wp.xz - uSunDir.xz * (wp.y / max(uSunDir.y, 0.15));
          float ca1 = textureLod(uWaterTex, q / 24.0, 1.8).r;
          float ca2 = textureLod(uWaterTex, q.yx / 9.5 + 0.3, 1.2).r;
          float caFine = textureLod(uWaterTex, q / 4.8 - vec2(uTime * 0.015, 0.0), 0.8).r;
          float pat = smoothstep(0.30, 0.70, ca1) * smoothstep(0.15, 0.60, ca2);
          float bhStreaks = smoothstep(0.20, 0.84, caFine) * smoothstep(0.14, 0.72, ca1);
          vec4 vSample = vol(wp);
          float skyOpen = vSample.g * (0.40 + 0.60 * vSample.x);
          // Inside Blue Hole cavern, diagonal SUN_DIR shafts track true 3D skylight hole via shadow1(wp) + vSample.x
          float effOpen = mix(skyOpen, max(skyOpen, vSample.x * 0.88 + 0.12), bhHere);
          float nearFade = smoothstep(1.2, 5.0, t);
          float bhDepthFade = mix(1.0, smoothstep(-47.0, -14.0, wp.y) * 0.82 + 0.25, bhHere);
          vec3 beamPat = vec3(mix(0.08 + 2.65 * pat, 0.05 + 1.45 * bhStreaks + 0.55 * pat, bhHere));
          vec3 light = sunE(wp) * sh * beamPat * effOpen * nearFade * bhDepthFade * mix(1.0, 0.56, bhHere);
          vec3 ext = exp(-SIG * (t * 1.05));
          accum += light * ext * stepL;
        }
      }

      vec3 rayTint = mix(vec3(0.08, 0.34, 0.50), vec3(0.06, 0.30, 0.54), bhCamDist);
      vec3 col = accum * rayTint * rayPhase * 0.028 * underwater;
      fragColor = vec4(col, 1.0);
    }
  `,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
});
for (const k of Object.keys(sharedUniforms)) {
  raysMat.uniforms[k] = sharedUniforms[k];
}

// 2. Depth-Aware 3x3 Cross Bilateral Ray Blur (W_RBLUR)
const raysBlurMat = new THREE.ShaderMaterial({
  uniforms: {
    uRaysTex: { value: null },
    uSceneDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
  },
  vertexShader: PASS_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uRaysTex;
    uniform sampler2D uSceneDepth;
    uniform vec2 uTexel;
    in vec2 vUv;
    layout(location = 0) out vec4 fragColor;

    void main() {
      float cd = texture(uSceneDepth, vUv).r;
      vec3 sum = vec3(0.0);
      float wSum = 0.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
          float nd = texture(uSceneDepth, uv).r;
          float dw = exp(-abs(nd - cd) * 180.0);
          float sp = (x == 0 && y == 0) ? 1.5 : (abs(x) + abs(y) == 1 ? 1.0 : 0.7);
          float w = dw * sp;
          sum += texture(uRaysTex, uv).rgb * w;
          wSum += w;
        }
      }
      fragColor = vec4(sum / max(wSum, 1e-4), 1.0);
    }
  `,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
});

// 3. Karis HDR Bloom Downsample & Tent Upsample (W_BLIT)
const bloomDownMat = new THREE.ShaderMaterial({
  uniforms: {
    uSrcTex: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uIsFirst: { value: 1.0 },
  },
  vertexShader: PASS_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uSrcTex;
    uniform vec2 uTexel;
    uniform float uIsFirst;
    in vec2 vUv;
    layout(location = 0) out vec4 fragColor;

    float luma(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    vec3 thresholdSample(vec3 c) {
      if (uIsFirst < 0.5) return c;
      float l = luma(c);
      float soft = smoothstep(0.95, 1.90, l) * max(l - 0.85, 0.0) / max(l, 1e-4);
      // Karis weight suppresses single-pixel glint fireflies
      float karis = 1.0 / (1.0 + l);
      return c * soft * karis;
    }

    void main() {
      vec3 c0 = thresholdSample(texture(uSrcTex, vUv).rgb);
      vec3 c1 = thresholdSample(texture(uSrcTex, vUv + vec2(-uTexel.x, -uTexel.y)).rgb);
      vec3 c2 = thresholdSample(texture(uSrcTex, vUv + vec2( uTexel.x, -uTexel.y)).rgb);
      vec3 c3 = thresholdSample(texture(uSrcTex, vUv + vec2(-uTexel.x,  uTexel.y)).rgb);
      vec3 c4 = thresholdSample(texture(uSrcTex, vUv + vec2( uTexel.x,  uTexel.y)).rgb);
      vec3 res = (c0 * 0.4 + (c1 + c2 + c3 + c4) * 0.15);
      fragColor = vec4(max(res, vec3(0.0)), 1.0);
    }
  `,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
});

const bloomUpMat = new THREE.ShaderMaterial({
  uniforms: {
    uLowTex: { value: null },
    uBaseTex: { value: null },
    uTexel: { value: new THREE.Vector2() },
  },
  vertexShader: PASS_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uLowTex;
    uniform sampler2D uBaseTex;
    uniform vec2 uTexel;
    in vec2 vUv;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 tent =
        texture(uLowTex, vUv + vec2(-uTexel.x, -uTexel.y)).rgb * 1.0 +
        texture(uLowTex, vUv + vec2(      0.0, -uTexel.y)).rgb * 2.0 +
        texture(uLowTex, vUv + vec2( uTexel.x, -uTexel.y)).rgb * 1.0 +
        texture(uLowTex, vUv + vec2(-uTexel.x,       0.0)).rgb * 2.0 +
        texture(uLowTex, vUv).rgb * 4.0 +
        texture(uLowTex, vUv + vec2( uTexel.x,       0.0)).rgb * 2.0 +
        texture(uLowTex, vUv + vec2(-uTexel.x,  uTexel.y)).rgb * 1.0 +
        texture(uLowTex, vUv + vec2(      0.0,  uTexel.y)).rgb * 2.0 +
        texture(uLowTex, vUv + vec2( uTexel.x,  uTexel.y)).rgb * 1.0;
      vec3 base = texture(uBaseTex, vUv).rgb;
      fragColor = vec4(base + tent * (1.0 / 16.0) * 0.72, 1.0);
    }
  `,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
});

// 4. Final Composite Pass: Bilateral Ray Upsample + Bloom + Vignette + ACES + Gamma + IGN Dithering (W_POST)
const postUniforms = {
  ...sharedUniforms,
  uSceneTex: { value: null },
  uSceneDepth: { value: null },
  uRaysTex: { value: null },
  uBloomTex: { value: null },
  uRaysTexel: { value: new THREE.Vector2() },
};

const postMat = new THREE.ShaderMaterial({
  uniforms: postUniforms,
  vertexShader: PASS_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    uniform sampler2D uSceneTex;
    uniform sampler2D uSceneDepth;
    uniform sampler2D uRaysTex;
    uniform sampler2D uBloomTex;
    uniform vec2 uRaysTexel;

    ${MEDIUM_GLSL}

    in vec2 vUv;
    layout(location = 0) out vec4 fragColor;

    vec3 sampleRaysBilateral(vec2 uv) {
      float cd = texture(uSceneDepth, uv).r;
      vec3 sum = vec3(0.0);
      float wSum = 0.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 suv = uv + vec2(float(x), float(y)) * uRaysTexel * 0.75;
          float sd = texture(uSceneDepth, suv).r;
          float w = exp(-abs(sd - cd) * 220.0);
          sum += texture(uRaysTex, suv).rgb * w;
          wSum += w;
        }
      }
      return sum / max(wSum, 1e-4);
    }

    vec3 acesFilmic(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main() {
      float uwCam = 1.0 - smoothstep(uWaveHeight - 0.12, uWaveHeight + 0.12, uCamPos.y);

      // Direct un-blurred, un-warped scene sampling so 1.4-pixel sand grains (deformable-sand) remain 100% razor-sharp!
      vec3 hdr = texture(uSceneTex, vUv).rgb;
      float sceneDepth = texture(uSceneDepth, vUv).r;
      float farWeight = smoothstep(0.988, 0.9995, sceneDepth);

      vec3 rays = sampleRaysBilateral(vUv);
      vec3 bloom = texture(uBloomTex, vUv).rgb;

      // Apply volumetric god rays & bloom across open ocean AND dark cave interiors while preserving dynamic range
      float zNdc = sceneDepth * 2.0 - 1.0;
      float linZ = (sceneDepth >= 0.9999) ? 240.0 : (2.0 * 0.25 * 650.0) / (650.0 + 0.25 - zNdc * (650.0 - 0.25));
      float rayRangeWeight = smoothstep(2.5, 13.0, linZ);
      float bhCamPost = blueHoleFactor(uCamPos);
      float rayVis = mix(0.14 + 0.86 * farWeight, rayRangeWeight * 0.85, sat(bhCamPost * 0.95 + smoothstep(10.0, 28.0, linZ) * 0.45));
      hdr += rays * uwCam * rayVis + bloom * (0.045 + 0.075 * farWeight);

      // Soft photographic lens vignette (matching deformable-sand postprocess.ts)
      vec2 vc = vUv * 2.0 - 1.0;
      hdr *= 1.0 - 0.12 * dot(vc, vc);

      // Depth-adaptive exposure + ACES Filmic tone mapping (matching deformable-sand aces(c * 1.1))
      float ek = smoothstep(1.5, 26.0, max(0.0, uWaveHeight - uCamPos.y));
      float expo = mix(1.04, 1.12 * (0.86 + 0.14 * ek), uwCam);
      vec3 mapped = acesFilmic(hdr * expo);

      // Output gamma 1/2.2 + 2-tap IGN dithering
      vec3 srgb = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));
      float dither = (ign(gl_FragCoord.xy) - 0.5) * (1.2 / 255.0);
      fragColor = vec4(clamp(srgb + dither, 0.0, 1.0), 1.0);
    }
  `,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
});
for (const k of Object.keys(sharedUniforms)) {
  postMat.uniforms[k] = sharedUniforms[k];
}

// ============================================================================
// Resize Handling
// ============================================================================
let mobileRenderScale = 1.0;

function handleResize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const baseDpr = Math.min(window.devicePixelRatio || 1, isMobileDevice ? 1.25 : 2.0);
  const dpr = isMobileDevice ? Math.max(0.65, baseDpr * mobileRenderScale) : baseDpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, true);
  camera.aspect = w / h;
  // Phones held upright: widen the vertical FOV so the horizontal view isn't a narrow slit
  camera.fov = camera.aspect < 1.0 ? THREE.MathUtils.clamp(62 / Math.sqrt(camera.aspect), 62, 84) : 62;
  camera.updateProjectionMatrix();

  raysMat.uniforms.uAspect.value = camera.aspect;
  raysMat.uniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  createTargets(Math.max(2, Math.floor(w * dpr)), Math.max(2, Math.floor(h * dpr)));
}
window.addEventListener('resize', handleResize);
handleResize();

// ============================================================================
// Camera Navigation, Pointer Lock + Drag Fallback, 6 Curated Viewpoints
// ============================================================================
function buildLookPose(px, yOff, pz, tx, ty, tz, absoluteY = false) {
  const py = absoluteY ? yOff : terrain.gy(px, pz) + yOff;
  const p = new THREE.Vector3(px, py, pz);
  if (p.y < -1.0) terrain.resolveCollision(p, 1.6);
  const dx = tx - p.x;
  const dy = ty - p.y;
  const dz = tz - p.z;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return { pos: [p.x, p.y, p.z], yaw, pitch };
}

const fighterWreckY = terrain.gy(71.0, -25.0) + 0.52;

const VIEWPOINTS = [
  { name: 'Main Canyon & 1:1 Whales', ...buildLookPose(12.5, -18.5, 14.0, -5.0, -19.5, -10.5, true) },
  { name: 'Abyssal Canyon & Fluke', ...buildLookPose(0.8, 2.2, -11.5, -0.5, -45.2, -6.8) },
  { name: 'Sunken Shipwreck', ...buildLookPose(56.0, -20.5, 27.0, 58.8, -22.5, 6.0, true) },
  { name: 'Sponge Canyon', ...buildLookPose(-55.0, 2.2, -18.0, -60.0, -30.0, 8.0) },
  { name: 'Purple Grotto', ...buildLookPose(4.5, -36.8, 62.0, 6.0, -35.8, 94.0, true) },
  { name: 'Sunny Spectral Surface', ...buildLookPose(-14.5, 6.2, 23.0, 0.5, -0.5, -6.0, true) },
  { name: 'Blue Hole God Rays', ...buildLookPose(47.8, -39.2, 71.2, 62.5, -24.5, 62.0, true) },
  { name: 'WWII Fighter Wreck', ...buildLookPose(61.5, fighterWreckY + 4.8, -32.2, 71.0, fighterWreckY + 0.1, -25.0, true) },
  { name: 'Giant Sea Fan Drop-Off', ...buildLookPose(-18.6, -21.8, 12.0, -22.2, -18.0, 19.2, true) },
];

let yaw = VIEWPOINTS[0].yaw;
let pitch = VIEWPOINTS[0].pitch;
camera.position.set(...VIEWPOINTS[0].pos);
camera.rotation.set(pitch, yaw, 0, 'YXZ');

const keys = new Set();
let isDragging = false;
let isSculptingSand = false;
let lastMouseX = 0;
let lastMouseY = 0;
let activeVp = 0;
let flyBlend = null; // { startPos, endPos, startYaw, endYaw, startPitch, endPitch, t }

const vpButtons = Array.from(document.querySelectorAll('.vp-btn'));
const depthValEl = document.getElementById('depth-val');
const zoneValEl = document.getElementById('zone-val');
const audioBtnEl = document.getElementById('audio-btn');
const audioValEl = document.getElementById('audio-val');

const oceanAudio = new OceanAudioSystem();

function updateAudioBadge() {
  if (!audioValEl || !audioBtnEl) return;
  if (oceanAudio.muted) {
    audioValEl.textContent = '🔇 靜音 (M)';
    audioBtnEl.classList.add('muted');
  } else {
    const whaleTag = oceanAudio.whaleAudible ? ' · 🐋 鯨鳴' : '';
    audioValEl.textContent = `🔊 ${oceanAudio.currentZoneLabel}${whaleTag}`;
    audioBtnEl.classList.remove('muted');
  }
}

function unlockAudio() {
  oceanAudio.init();
  oceanAudio.resume();
  updateAudioBadge();
}

if (audioBtnEl) {
  audioBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    oceanAudio.toggleMute();
    updateAudioBadge();
  });
}
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('touchstart', unlockAudio, { passive: true });

function setViewpoint(index, instant = false) {
  const vp = VIEWPOINTS[Math.max(0, Math.min(VIEWPOINTS.length - 1, index))];
  activeVp = index;
  vpButtons.forEach((btn, idx) => btn.classList.toggle('active', idx === index));

  if (!instant) {
    if (index === 5) whalePod.controller.cueSurfaceEncounter();
    else if (index === 0) whalePod.controller.cueCanyonEncounter();
  }

  if (instant) {
    camera.position.set(vp.pos[0], vp.pos[1], vp.pos[2]);
    if (camera.position.y < -1.0) terrain.resolveCollision(camera.position, 1.55);
    yaw = vp.yaw;
    pitch = vp.pitch;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    flyBlend = null;
  } else {
    flyBlend = {
      startPos: camera.position.clone(),
      endPos: new THREE.Vector3(vp.pos[0], vp.pos[1], vp.pos[2]),
      startYaw: yaw,
      endYaw: vp.yaw,
      startPitch: pitch,
      endPitch: vp.pitch,
      t: 0,
    };
  }
}
setViewpoint(0, true);

vpButtons.forEach((btn, idx) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    unlockAudio();
    setViewpoint(idx, false);
  });
});

const _pointerRaycaster = new THREE.Raycaster();
const _pointerNdc = new THREE.Vector2();

function triggerWaterDropAtEvent(e, strength = 0.095) {
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (document.pointerLockElement === renderer.domElement) {
    _pointerNdc.set(0, 0);
  } else {
    _pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2.0 - 1.0,
      -((e.clientY - rect.top) / rect.height) * 2.0 + 1.0
    );
  }
  _pointerRaycaster.setFromCamera(_pointerNdc, camera);
  const dy = _pointerRaycaster.ray.direction.y;
  if (Math.abs(dy) > 0.015) {
    const t = (sharedUniforms.uWaveHeight.value - _pointerRaycaster.ray.origin.y) / dy;
    if (t > 0.2 && t < 48.0) {
      const hitX = _pointerRaycaster.ray.origin.x + _pointerRaycaster.ray.direction.x * t;
      const hitZ = _pointerRaycaster.ray.origin.z + _pointerRaycaster.ray.direction.z * t;
      waterHeightfield.addWorldDrop(hitX, hitZ, 0.032, strength);
    }
  }

  // Raycast against sandy seabed for interactive deformable sand sculpting (deformable-sand)
  const ro = _pointerRaycaster.ray.origin;
  const rd = _pointerRaycaster.ray.direction;
  let hitSand = false;
  if (rd.y < 0.15) {
    let prevT = 0.6;
    const maxT = 48.0;
    const steps = 32;
    const stepT = (maxT - prevT) / steps;
    for (let i = 1; i <= steps; i++) {
      const curT = 0.6 + i * stepT;
      const px = ro.x + rd.x * curT;
      const py = ro.y + rd.y * curT;
      const pz = ro.z + rd.z * curT;
      if (py < -1.5 && terrain.dw(px, py, pz) >= -0.14) {
        let a = prevT;
        let b = curT;
        for (let k = 0; k < 4; k++) {
          const mid = 0.5 * (a + b);
          if (terrain.dw(ro.x + rd.x * mid, ro.y + rd.y * mid, ro.z + rd.z * mid) >= 0.0) {
            b = mid;
          } else {
            a = mid;
          }
        }
        const hitT = 0.5 * (a + b);
        const hx = ro.x + rd.x * hitT;
        const hy = ro.y + rd.y * hitT;
        const hz = ro.z + rd.z * hitT;
        deformableSand.addPointerStroke(hx, hy, hz, 0.92, 0.96);
        if (hy < -30.0 && hitT < 28.0) hitSand = true;
        break;
      }
      prevT = curT;
    }
  }
  return hitSand;
}

container.addEventListener('mousedown', (e) => {
  isDragging = true;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  isSculptingSand = triggerWaterDropAtEvent(e, 0.11);
  // Only request pointer lock on desktop when dragging on open water/cliffs, so clicking/dragging on close sand or mobile preview works in-place
  if (
    !isMobileDevice &&
    !isSculptingSand &&
    document.pointerLockElement !== renderer.domElement &&
    renderer.domElement.requestPointerLock
  ) {
    try {
      const p = renderer.domElement.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }
});

window.addEventListener('mouseup', () => {
  isDragging = false;
  isSculptingSand = false;
});

window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    yaw -= e.movementX * 0.0022;
    pitch = Math.max(-1.42, Math.min(1.42, pitch - e.movementY * 0.0022));
    flyBlend = null;
    if ((frameCount & 3) === 0) triggerWaterDropAtEvent(e, 0.055);
  } else if (isDragging) {
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    if (isSculptingSand) {
      // Sculpt sand continuously along the cursor path without spinning the camera!
      triggerWaterDropAtEvent(e, 0.085);
    } else {
      yaw -= dx * 0.0038;
      pitch = Math.max(-1.42, Math.min(1.42, pitch - dy * 0.0038));
      flyBlend = null;
      triggerWaterDropAtEvent(e, 0.065);
    }
  }
});

// ============================================================================
// Touch Controls (On-Screen Virtual Joystick + abyssal-garden Scene Gestures):
//   left joystick     -> swim forward / back / strafe smoothly
//   right buttons     -> ascend / dive / boost sprint
//   scene touch (solo)-> hold to swim forward, slide to steer, 2nd finger = sprint
//   quick tap         -> ripple the surface / sculpt the sand at that spot
// ============================================================================
const uiContainerEl = document.getElementById('ui-container');
const touchReticleEl = document.getElementById('touch-reticle');
const touchRingEl = touchReticleEl ? touchReticleEl.querySelector('.touch-reticle-ring') : null;
const touchDotEl = touchReticleEl ? touchReticleEl.querySelector('.touch-reticle-dot') : null;

const mobileJoyEl = document.getElementById('mobile-joy');
const mobileJoyKnobEl = document.getElementById('mobile-joy-knob');
const btnBoostEl = document.getElementById('btn-boost');
const btnUpEl = document.getElementById('btn-up');
const btnDownEl = document.getElementById('btn-down');

let joyTouchId = null; // numeric Touch.identifier or 'mouse'
let joyX = 0;
let joyY = 0;
let mobileBoost = false;
let mobileUp = false;
let mobileDown = false;

let touchId = -1;
let touchCount = 0;
let touchX0 = 0;
let touchY0 = 0;
let touchX = 0;
let touchY = 0;
let touchStartTime = 0;
let touchTravel = 0;

function markTouchUIActive() {
  if (document.body && !document.body.classList.contains('has-touch')) {
    document.body.classList.add('has-touch');
  }
  if (uiContainerEl) uiContainerEl.classList.add('touch-started');
}

function updateJoyVisual(px = 0, py = 0, active = false) {
  if (mobileJoyEl) mobileJoyEl.classList.toggle('active', active);
  if (mobileJoyKnobEl) {
    mobileJoyKnobEl.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  }
}

function applyJoyClientPos(clientX, clientY) {
  if (!mobileJoyEl) return;
  const rect = mobileJoyEl.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  const maxR = Math.max(24, rect.width * 0.34);
  const dx = clientX - cx;
  const dy = clientY - cy;
  const dist = Math.hypot(dx, dy);
  const clamped = dist > maxR ? maxR / dist : 1.0;
  const px = dx * clamped;
  const py = dy * clamped;
  joyX = px / maxR;
  joyY = -py / maxR; // up on screen = +forward
  flyBlend = null;
  updateJoyVisual(px, py, true);
}

if (mobileJoyEl) {
  const onJoyTouch = (e) => {
    if (!e.touches) return;
    e.preventDefault();
    e.stopPropagation();
    unlockAudio();
    markTouchUIActive();
    let activeTouch = null;
    if (joyTouchId !== null && typeof joyTouchId === 'number') {
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === joyTouchId) activeTouch = e.touches[i];
      }
    }
    if (!activeTouch && e.targetTouches.length > 0) {
      activeTouch = e.targetTouches[0];
      joyTouchId = activeTouch.identifier;
    }
    if (activeTouch) {
      applyJoyClientPos(activeTouch.clientX, activeTouch.clientY);
    } else {
      joyTouchId = null;
      joyX = 0;
      joyY = 0;
      updateJoyVisual(0, 0, false);
    }
  };
  for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    mobileJoyEl.addEventListener(n, onJoyTouch, { passive: false });
  }
  mobileJoyEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    joyTouchId = 'mouse';
    mobileJoyEl.setPointerCapture?.(e.pointerId);
    applyJoyClientPos(e.clientX, e.clientY);
  });
  mobileJoyEl.addEventListener('pointermove', (e) => {
    if (joyTouchId === 'mouse') applyJoyClientPos(e.clientX, e.clientY);
  });
  const endJoyMouse = () => {
    if (joyTouchId === 'mouse') {
      joyTouchId = null;
      joyX = 0;
      joyY = 0;
      updateJoyVisual(0, 0, false);
    }
  };
  mobileJoyEl.addEventListener('pointerup', endJoyMouse);
  mobileJoyEl.addEventListener('pointercancel', endJoyMouse);
}

function bindHoldButton(el, onChange) {
  if (!el) return;
  const setPressed = (down) => {
    el.classList.toggle('active', down);
    onChange(down);
  };
  const onTouch = (e) => {
    if (!e.touches) return;
    e.preventDefault();
    e.stopPropagation();
    unlockAudio();
    markTouchUIActive();
    setPressed(e.targetTouches.length > 0);
  };
  for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    el.addEventListener(n, onTouch, { passive: false });
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    setPressed(true);
  });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave']) {
    el.addEventListener(n, (e) => {
      if (e.pointerType !== 'touch') setPressed(false);
    });
  }
}

bindHoldButton(btnBoostEl, (v) => { mobileBoost = v; });
bindHoldButton(btnUpEl, (v) => { mobileUp = v; });
bindHoldButton(btnDownEl, (v) => { mobileDown = v; });

function updateTouchReticle() {
  if (!touchReticleEl) return;
  if (touchId < 0 || joyTouchId !== null) {
    touchReticleEl.classList.remove('active', 'sprint');
    return;
  }
  touchReticleEl.classList.add('active');
  touchReticleEl.classList.toggle('sprint', touchCount > 1 || mobileBoost);
  if (touchRingEl) {
    touchRingEl.style.transform = `translate3d(${touchX0}px, ${touchY0}px, 0)`;
  }
  if (touchDotEl) {
    const dx = touchX - touchX0;
    const dy = touchY - touchY0;
    const dist = Math.hypot(dx, dy);
    const cap = 42;
    const s = dist > cap ? cap / dist : 1.0;
    touchDotEl.style.transform = `translate3d(${touchX0 + dx * s}px, ${touchY0 + dy * s}px, 0)`;
  }
}

function resetTouch() {
  touchId = -1;
  touchCount = 0;
  joyTouchId = null;
  joyX = 0;
  joyY = 0;
  mobileBoost = false;
  mobileUp = false;
  mobileDown = false;
  updateJoyVisual(0, 0, false);
  btnBoostEl?.classList.remove('active');
  btnUpEl?.classList.remove('active');
  btnDownEl?.classList.remove('active');
  updateTouchReticle();
}

function handleTouch(e) {
  if (!e.touches) return; // ignore non-TouchEvent synthetic events
  e.preventDefault();
  unlockAudio();
  markTouchUIActive();
  const list = e.targetTouches || e.touches;
  touchCount = list.length;
  let f = null;
  let first = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === touchId) f = list[i];
  }
  if (!f) {
    // Lifting a single short, still touch taps water/sand at that spot
    if (touchId >= 0 && e.type === 'touchend' && list.length === 0) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const ct = e.changedTouches[i];
        if (ct.identifier === touchId && performance.now() - touchStartTime < 240 && touchTravel < 14) {
          triggerWaterDropAtEvent(ct, 0.11);
        }
      }
    }
    touchId = -1;
    if (list.length) {
      f = list[0];
      touchId = f.identifier;
      first = true;
    }
  }
  if (f) {
    const x = f.clientX;
    const y = f.clientY;
    if (first) {
      touchX0 = x;
      touchY0 = y;
      touchStartTime = performance.now();
      touchTravel = 0;
      flyBlend = null;
    } else {
      const s = 2.8 / Math.max(1, Math.min(window.innerWidth, window.innerHeight));
      const dx = x - touchX;
      const dy = y - touchY;
      yaw -= dx * s;
      pitch = Math.max(-1.42, Math.min(1.42, pitch - dy * s));
      touchTravel += Math.abs(dx) + Math.abs(dy);
    }
    touchX = x;
    touchY = y;
  }
  updateTouchReticle();
}

for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
  container.addEventListener(n, handleTouch, { passive: false });
}

window.addEventListener('blur', () => {
  resetTouch();
  keys.clear();
});

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  unlockAudio();
  if (e.code === 'KeyM') {
    oceanAudio.toggleMute();
    updateAudioBadge();
  }
  if (e.code === 'KeyH') {
    document.getElementById('ui-container').classList.toggle('hud-hidden');
  }
  if (e.code >= 'Digit1' && e.code <= 'Digit9') {
    const idx = Number(e.code.slice(5)) - 1;
    setViewpoint(idx, false);
  }
});

window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
});

// ============================================================================
// Preallocated Frame Scratch Objects (Zero Per-Frame GC Allocations!)
// ============================================================================
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _shadowFocus = new THREE.Vector3();
const _clock = new THREE.Clock();

let frameCount = 0;

function updateCameraAndUniforms(dt, elapsed) {
  if (flyBlend) {
    flyBlend.t = Math.min(1.0, flyBlend.t + dt * 1.45);
    const s = flyBlend.t * flyBlend.t * (3.0 - 2.0 * flyBlend.t);
    camera.position.lerpVectors(flyBlend.startPos, flyBlend.endPos, s);
    if (camera.position.y < -1.0) terrain.resolveCollision(camera.position, 1.55);
    yaw = flyBlend.startYaw + (flyBlend.endYaw - flyBlend.startYaw) * s;
    pitch = flyBlend.startPitch + (flyBlend.endPitch - flyBlend.startPitch) * s;
    _velocity.set(0, 0, 0);
    if (flyBlend.t >= 1.0) flyBlend = null;
  } else {
    // Arrow key look support alongside mouse look
    if (keys.has('ArrowLeft')) yaw += dt * 1.45;
    if (keys.has('ArrowRight')) yaw -= dt * 1.45;
    if (keys.has('ArrowUp')) pitch = Math.min(1.42, pitch + dt * 1.15);
    if (keys.has('ArrowDown')) pitch = Math.max(-1.42, pitch - dt * 1.15);

    // Solo-finger touch joystick: a finger held past a tiny deadzone from its landing point keeps turning
    if (touchId >= 0 && joyTouchId === null) {
      const rawDx = touchX - touchX0;
      const rawDy = touchY - touchY0;
      const dist = Math.hypot(rawDx, rawDy);
      const deadzone = 10.0;
      if (dist > deadzone) {
        const span = Math.max(44, Math.min(window.innerWidth, window.innerHeight) * 0.18);
        const norm = Math.min(1.0, (dist - deadzone) / span) / dist;
        const jx = rawDx * norm;
        const jy = rawDy * norm;
        yaw -= jx * 1.65 * dt;
        pitch = Math.max(-1.42, Math.min(1.42, pitch - jy * 1.15 * dt));
      }
    }

    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();

    _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();

    _moveDir.set(0, 0, 0);
    if (keys.has('KeyW')) _moveDir.add(_camFwd);
    if (keys.has('KeyS')) _moveDir.sub(_camFwd);
    if (keys.has('KeyD')) _moveDir.add(_camRight);
    if (keys.has('KeyA')) _moveDir.sub(_camRight);
    if (keys.has('Space') || keys.has('KeyE')) _moveDir.y += 1.0;
    if (keys.has('ShiftLeft') || keys.has('KeyQ')) _moveDir.y -= 1.0;

    const hasJoy = joyTouchId !== null && (Math.abs(joyX) > 0.04 || Math.abs(joyY) > 0.04);
    if (hasJoy) {
      _moveDir.addScaledVector(_camFwd, joyY);
      _moveDir.addScaledVector(_camRight, joyX);
    } else if (touchId >= 0) {
      // Solo scene touch (abyssal-garden feel): hold to swim forward along gaze
      _moveDir.add(_camFwd);
    }
    if (mobileUp) _moveDir.y += 1.0;
    if (mobileDown) _moveDir.y -= 1.0;

    if (_moveDir.lengthSq() > 1e-4) _moveDir.normalize();
    // Touch: scale smoothly by joystick magnitude / 1-finger cruise, and sprint when boosting or 2 fingers
    const joyMag = hasJoy ? Math.min(1.0, Math.hypot(joyX, joyY)) : 0.85;
    if (hasJoy || touchId >= 0 || mobileUp || mobileDown) {
      _moveDir.multiplyScalar(mobileBoost || touchCount > 1 ? 2.2 : joyMag);
    }
    const swimSpeed = camera.position.y > 0.0 ? 15.0 : 11.5;
    const damp = 1.0 - Math.exp(-6.5 * dt);
    _velocity.lerp(_moveDir.multiplyScalar(swimSpeed), damp);
    camera.position.addScaledVector(_velocity, dt);
    terrain.resolveCollision(camera.position, 1.45);
  }

  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.updateMatrixWorld();

  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

  // Keep sky backdrop & tiled ocean surface centered smoothly around camera
  backdropMesh.position.copy(camera.position);
  oceanMesh.position.set(
    Math.round(camera.position.x / 16.0) * 16.0,
    0.0,
    Math.round(camera.position.z / 16.0) * 16.0
  );

  // Update shared uniform live values
  sharedUniforms.uTime.value = elapsed;
  sharedUniforms.uCamPos.value.copy(camera.position);
  sharedUniforms.uCamRight.value.copy(_camRight);
  sharedUniforms.uCamUp.value.copy(_camUp);
  sharedUniforms.uCamFwd.value.copy(_camFwd);
  sharedUniforms.uInvProjMatrix.value.copy(camera.projectionMatrixInverse);
  sharedUniforms.uViewMatrix.value.copy(camera.matrixWorldInverse);
  sharedUniforms.uProjMatrix.value.copy(camera.projectionMatrix);
  sharedUniforms.uCameraWorldMatrix.value.copy(camera.matrixWorld);
  sharedUniforms.uRippleCenter.value.copy(waterHeightfield.center);
  sharedUniforms.uRippleTex.value = waterHeightfield.texture;
  sharedUniforms.uCausticTex.value = differentialCaustics.texture;
  sharedUniforms.uSandBedTex.value = deformableSand.texture;
  sharedUniforms.uSandLightTex.value = deformableSand.lightTexture;
  sharedUniforms.uSandCenter.value.copy(deformableSand.center);
  sharedUniforms.uSandPointer.value.copy(deformableSand.pointerRing);

  // Sync directional orthographic sun shadow frustum around camera focus
  const texelSize = 136.0 / SHADOW_RES;
  _shadowFocus.set(
    Math.round(camera.position.x / texelSize) * texelSize,
    -24.0,
    Math.round(camera.position.z / texelSize) * texelSize
  );
  shadowCam.position.copy(_shadowFocus).addScaledVector(SUN_DIR, 95.0);
  shadowCam.lookAt(_shadowFocus);
  shadowCam.updateMatrixWorld();
  sharedUniforms.uShadowMatrix.value.multiplyMatrices(
    shadowCam.projectionMatrix,
    shadowCam.matrixWorldInverse
  );

  // Bind FFT wave cascade textures directly onto abyssalOceanMat
  abyssalOceanMat.uniforms.displacement0.value = oceanSystem.cascades[0].displacement;
  abyssalOceanMat.uniforms.displacement1.value = oceanSystem.cascades[1].displacement;
  abyssalOceanMat.uniforms.displacement2.value = oceanSystem.cascades[2].displacement;
  abyssalOceanMat.uniforms.derivatives0.value = oceanSystem.cascades[0].derivatives.texture;
  abyssalOceanMat.uniforms.derivatives1.value = oceanSystem.cascades[1].derivatives.texture;
  abyssalOceanMat.uniforms.derivatives2.value = oceanSystem.cascades[2].derivatives.texture;

  // Step spatial & 3-zone crossfading ocean audio system
  oceanAudio.update(camera.position, _camRight, sharedUniforms.uWaveHeight.value, whalePod);

  if (frameCount % 8 === 0) {
    const p = camera.position;
    if (depthValEl) {
      depthValEl.textContent = p.y >= 0 ? `+${p.y.toFixed(1)} m (Air)` : `${(-p.y).toFixed(1)} m`;
    }
    if (zoneValEl) {
      let zName = 'Open Coral Reef';
      if (p.y >= 0) zName = 'Ocean Surface';
      else if (Math.hypot(p.x - 61.5, p.z - 64.5) < 28) zName = 'Blue Hole 藍洞';
      else if (Math.hypot(p.x - 71.0, p.z + 25.0) < 24) zName = 'Fighter Wreck 戰機殘骸';
      else if (Math.hypot(p.x + 22.0, p.z - 20.0) < 16 && p.y > -32 && p.y < -12) zName = 'Giant Sea Fan Wall 大海扇';
      else if (Math.hypot(p.x + 5, p.z + 4) < 16) zName = 'Whale Fluke Bay';
      else if (Math.hypot(p.x - 59.5, p.z - 6.0) < 20) zName = 'Shipwreck Cove';
      else if (Math.hypot(p.x - 6, p.z - 84) < 28) zName = 'Purple Grotto';
      else if (Math.hypot(p.x + 60, p.z) < 22) zName = 'Sponge Canyon';
      else if (Math.hypot(p.x - 1, p.z + 14) < 14) zName = 'Cathedral Arch';
      else if (Math.abs(p.x) < 16 && Math.abs(p.z) < 24) zName = 'Coral Canyon';
      zoneValEl.textContent = zName;
    }
    updateAudioBadge();
  }
}

function renderPass(material, target) {
  passQuad.material = material;
  renderer.setRenderTarget(target);
  renderer.clear(true, true, false);
  renderer.render(passScene, passCamera);
}

// ============================================================================
// Main Frame Loop
// ============================================================================
let mobileFrameSum = 0;
let mobileFrameSamples = 0;
let mobileScaleSteps = 0;

function animate() {
  requestAnimationFrame(animate);

  const rawDt = _clock.getDelta();
  const dt = Math.min(rawDt, 0.08);
  const elapsed = _clock.elapsedTime;
  frameCount++;

  if (isMobileDevice && frameCount > 20 && mobileScaleSteps < 2) {
    mobileFrameSum += rawDt;
    mobileFrameSamples++;
    if (mobileFrameSamples >= 45) {
      const avgDt = mobileFrameSum / mobileFrameSamples;
      mobileFrameSum = 0;
      mobileFrameSamples = 0;
      if (avgDt > 0.038) {
        mobileScaleSteps++;
        mobileRenderScale = mobileScaleSteps === 1 ? 0.8 : 0.65;
        handleResize();
      }
    }
  }

  // 1. Step wave spectra, interactive 2D wave heightfield, differential-area chromatic caustics, shark & whale pod
  oceanSystem.update(elapsed, dt);
  waterCaustics.update(elapsed);
  sharkRig.controller.update(dt);
  whalePod.controller.update(dt);
  waterHeightfield.update(dt, camera.position, whalePod);
  deformableSand.update(dt, elapsed, camera.position, terrain, sharkRig, whalePod);
  differentialCaustics.update(oceanSystem, SUN_DIR);
  updateCameraAndUniforms(dt, elapsed);

  // 2. Render Shadow Depth Map (2048x2048)
  renderer.setRenderTarget(shadowTarget);
  renderer.clear(true, true, false);
  renderer.render(shadowScene, shadowCam);

  // 3. Render Opaque Underwater/Above-Water Scene into Refraction Target (for Snell & Water Refraction)
  renderer.setRenderTarget(refractTarget);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);

  // 4. Copy Refraction Target (Color + Depth) into Main Scene Target & Render Spectral Ocean Surface + Spray
  refractCopyMat.uniforms.uSrcColor.value = refractTarget.texture;
  refractCopyMat.uniforms.uSrcDepth.value = refractTarget.depthTexture;
  renderPass(refractCopyMat, sceneTarget);
  renderer.render(oceanScene, camera);

  // 4. Half-Res Volumetric God Rays + Depth-Aware Bilateral Blur
  raysMat.uniforms.uSceneDepth.value = sceneTarget.depthTexture;
  renderPass(raysMat, tRaysRaw);

  raysBlurMat.uniforms.uRaysTex.value = tRaysRaw.texture;
  raysBlurMat.uniforms.uSceneDepth.value = sceneTarget.depthTexture;
  raysBlurMat.uniforms.uTexel.value.set(1.0 / tRaysRaw.width, 1.0 / tRaysRaw.height);
  renderPass(raysBlurMat, tRaysBlur);

  // 5. 4-Mip Karis HDR Bloom Downsample -> Tent Upsample
  let srcTex = sceneTarget.texture;
  let srcW = renderW;
  let srcH = renderH;
  for (let i = 0; i < bloomDown.length; i++) {
    bloomDownMat.uniforms.uSrcTex.value = srcTex;
    bloomDownMat.uniforms.uTexel.value.set(1.0 / srcW, 1.0 / srcH);
    bloomDownMat.uniforms.uIsFirst.value = i === 0 ? 1.0 : 0.0;
    renderPass(bloomDownMat, bloomDown[i]);
    srcTex = bloomDown[i].texture;
    srcW = bloomDown[i].width;
    srcH = bloomDown[i].height;
  }

  let lowTex = bloomDown[bloomDown.length - 1].texture;
  for (let i = bloomUp.length - 1; i >= 0; i--) {
    const baseTarget = bloomDown[i];
    bloomUpMat.uniforms.uLowTex.value = lowTex;
    bloomUpMat.uniforms.uBaseTex.value = baseTarget.texture;
    bloomUpMat.uniforms.uTexel.value.set(1.0 / baseTarget.width, 1.0 / baseTarget.height);
    renderPass(bloomUpMat, bloomUp[i]);
    lowTex = bloomUp[i].texture;
  }

  // 6. Final ACES + Gamma + IGN Dithering Composite to Screen
  postMat.uniforms.uSceneTex.value = sceneTarget.texture;
  postMat.uniforms.uSceneDepth.value = sceneTarget.depthTexture;
  postMat.uniforms.uRaysTex.value = tRaysBlur.texture;
  postMat.uniforms.uBloomTex.value = bloomUp[0].texture;
  postMat.uniforms.uRaysTexel.value.set(1.0 / tRaysBlur.width, 1.0 / tRaysBlur.height);
  renderPass(postMat, null);
}

animate();
