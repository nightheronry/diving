import * as THREE from "three";

export const stylizedOceanDebugModes = new Map([
  ["final", 0],
  ["above-surface", 0],
  ["underwater", 0],
  ["cascade-bands", 1],
  ["normals", 2],
  ["foam", 3],
  ["depth-fog", 4],
]);

const BASE_URL = (import.meta.env && import.meta.env.BASE_URL) || "./";

export const stylizedAboveBelowOceanAssetPaths = {
  foam: `${BASE_URL}assets/stylized-above-below-ocean/foam.webp`,
  sand: `${BASE_URL}assets/stylized-above-below-ocean/sand.webp`,
};

const stylizedSky = `
  float skyHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float skyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x),
      mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0)), u.x),
      u.y
    );
  }

  float skyFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += skyNoise(p) * a;
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  vec3 stylizedOceanSky(vec3 direction, vec3 sunDirection, vec3 sunColor) {
    vec3 viewDirection = normalize(direction);
    vec3 topColor = vec3(0.024, 0.255, 0.537);
    vec3 bottomColor = vec3(0.475, 0.722, 0.851);
    float height = max(viewDirection.y, 0.0);
    float opticalDepth = exp(-height * (8.0 - 1.2));
    vec3 skyColor = mix(topColor, bottomColor, opticalDepth);

    float sunDot = dot(viewDirection, normalize(sunDirection));
    float sunDisk = smoothstep(0.9999, 1.0, sunDot);
    float dynamicGlowSize = 0.999 - (6.0 * 0.002);
    float sunGlow = smoothstep(dynamicGlowSize, 1.0, sunDot);
    float dynamicDiskIntensity = 1.5 / (1.0 + (6.0 * 0.1));
    vec3 finalColor =
      skyColor +
      sunColor * sunGlow * 4.5 +
      sunColor * sunDisk * dynamicDiskIntensity;
    return clamp(finalColor, 0.0, 1.0);
  }
`;

const noiseFns = `
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rotate = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      value += valueNoise(p) * amplitude;
      p = rotate * p * 2.04;
      amplitude *= 0.5;
    }
    return value;
  }
`;

export function createStylizedOceanSurfaceMaterial(cascades, {
  patchLengths,
  sunDirection = new THREE.Vector3(-0.14, 0.13, -0.98).normalize(),
  sunColor = new THREE.Color(0xffdf70),
  waterDeep = new THREE.Color(0x15a5ec),
  waterShallow = new THREE.Color(0x59cdff),
  fogColor = new THREE.Color(0x52b9e5),
  foamTexture = null,
} = {}) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      displacement0: { value: cascades[0].displacement },
      displacement1: { value: cascades[1].displacement },
      displacement2: { value: cascades[2].displacement },
      derivatives0: { value: cascades[0].derivatives.texture },
      derivatives1: { value: cascades[1].derivatives.texture },
      derivatives2: { value: cascades[2].derivatives.texture },
      patchLengths: { value: new THREE.Vector3(...patchLengths) },
      uTime: { value: 0 },
      uSunDirection: { value: sunDirection },
      uSunColor: { value: sunColor.clone() },
      uWaterDeep: { value: waterDeep.clone() },
      uWaterShallow: { value: waterShallow.clone() },
      uWaterSSS: { value: new THREE.Color(0x3b72ba) },
      uFoamColor: { value: new THREE.Color(0xffffff) },
      uFoamTexture: { value: foamTexture },
      uFogColor: { value: fogColor.clone() },
      uColorMinHeight: { value: -4.5 },
      uColorMaxHeight: { value: 1.5 },
      uSpecularPower: { value: 250.0 },
      uSpecularMin: { value: 0.9 },
      uSpecularMax: { value: 0.99 },
      uSpecularIntensity: { value: 4.7 },
      uFadeStart: { value: 500.0 },
      uFadeEnd: { value: 3500.0 },
      uSssPower: { value: 4.7 },
      uSssScale: { value: 2.0 },
      uSssMinHeight: { value: -0.2 },
      uSssMaxHeight: { value: 1.0 },
      uFoamThreshold: { value: 0.4 },
      uFoamScale: { value: 7.0 },
      uFoamSpeed: { value: new THREE.Vector2(0.2, 0.2) },
      uFoamDistortion: { value: 1.4 },
      uFoamEdgeSoftness: { value: 0.8 },
      uFoamPower: { value: 0.5 },
      uFresnelSmoothness: { value: 0.5 },
      uFogDensity: { value: 0.0005 },
      uDebugMode: { value: 0 },
    },
    vertexShader: `
      precision highp float;

      uniform sampler2D displacement0;
      uniform sampler2D displacement1;
      uniform sampler2D displacement2;
      uniform vec3 patchLengths;

      varying vec2 vOceanXZ;
      varying vec3 vWorldPosition;
      varying float vHeight;
      varying float vJacobian;

      vec4 sampleDisplacement(sampler2D map, vec2 xz, float lengthScale) {
        return texture2D(map, fract(xz / lengthScale));
      }

      void main() {
        vec4 baseWorld = modelMatrix * vec4(position, 1.0);
        vOceanXZ = baseWorld.xz;
        vec4 d0 = sampleDisplacement(displacement0, vOceanXZ, patchLengths.x);
        vec4 d1 = sampleDisplacement(displacement1, vOceanXZ, patchLengths.y);
        vec4 d2 = sampleDisplacement(displacement2, vOceanXZ, patchLengths.z);
        vec3 displacement = d0.xyz + d1.xyz * 0.56 + d2.xyz * 0.28;
        displacement.xz *= 1.5;
        vec3 world = baseWorld.xyz + displacement;
        vWorldPosition = world;
        vHeight = displacement.y;
        vJacobian = min(d0.a, d1.a);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform sampler2D displacement0;
      uniform sampler2D displacement1;
      uniform sampler2D displacement2;
      uniform sampler2D derivatives0;
      uniform sampler2D derivatives1;
      uniform sampler2D derivatives2;
      uniform vec3 patchLengths;
      uniform float uTime;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform vec3 uWaterDeep;
      uniform vec3 uWaterShallow;
      uniform vec3 uWaterSSS;
      uniform vec3 uFoamColor;
      uniform sampler2D uFoamTexture;
      uniform vec3 uFogColor;
      uniform float uColorMinHeight;
      uniform float uColorMaxHeight;
      uniform float uSpecularPower;
      uniform float uSpecularMin;
      uniform float uSpecularMax;
      uniform float uSpecularIntensity;
      uniform float uFadeStart;
      uniform float uFadeEnd;
      uniform float uSssPower;
      uniform float uSssScale;
      uniform float uSssMinHeight;
      uniform float uSssMaxHeight;
      uniform float uFoamThreshold;
      uniform float uFoamScale;
      uniform vec2 uFoamSpeed;
      uniform float uFoamDistortion;
      uniform float uFoamEdgeSoftness;
      uniform float uFoamPower;
      uniform float uFresnelSmoothness;
      uniform float uFogDensity;
      uniform int uDebugMode;

      varying vec2 vOceanXZ;
      varying vec3 vWorldPosition;
      varying float vHeight;
      varying float vJacobian;

      ${stylizedSky}
      ${noiseFns}

      vec4 sampleDerivatives(sampler2D map, vec2 xz, float lengthScale) {
        return texture2D(map, fract(xz / lengthScale));
      }

      vec4 sampleDisplacement(sampler2D map, vec2 xz, float lengthScale) {
        return texture2D(map, fract(xz / lengthScale));
      }

      float fresnelTerm(vec3 viewDirection, vec3 normal) {
        float dotVN = clamp(dot(viewDirection, normal), 0.0, 1.0);
        return 0.02 + 0.98 * pow(1.0 - dotVN, 5.0);
      }

      void main() {
        vec4 der0 = sampleDerivatives(derivatives0, vOceanXZ, patchLengths.x);
        vec4 der1 = sampleDerivatives(derivatives1, vOceanXZ, patchLengths.y);
        vec4 der2 = sampleDerivatives(derivatives2, vOceanXZ, patchLengths.z);
        vec4 derivative = der0 + der1 * 0.56 + der2 * 0.28;
        vec3 normal = normalize(vec3(
          -derivative.x / max(0.18, 1.0 + derivative.z),
          1.0,
          -derivative.y / max(0.18, 1.0 + derivative.w)
        ));
        if (!gl_FrontFacing) normal = -normal;

        vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
        vec3 lightDirection = normalize(uSunDirection);
        float dist = length(cameraPosition - vWorldPosition);
        float aaFade = smoothstep(uFadeStart, uFadeEnd, dist);
        normal = normalize(mix(normal, vec3(0.0, gl_FrontFacing ? 1.0 : -1.0, 0.0), aaFade));
        float dynamicSpecular = mix(uSpecularIntensity, 0.0, aaFade);

        if (uDebugMode == 1) {
          vec4 d0 = sampleDisplacement(displacement0, vOceanXZ, patchLengths.x);
          vec4 d1 = sampleDisplacement(displacement1, vOceanXZ, patchLengths.y);
          vec4 d2 = sampleDisplacement(displacement2, vOceanXZ, patchLengths.z);
          gl_FragColor = vec4(pow(clamp(vec3(abs(d0.y), abs(d1.y) * 2.0, abs(d2.y) * 4.0), 0.0, 1.0), vec3(0.55)), 1.0);
          return;
        }
        if (uDebugMode == 2) {
          gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
          return;
        }

        float heightMask = smoothstep(uColorMinHeight, uColorMaxHeight, vHeight);
        vec3 baseWater = mix(uWaterDeep, uWaterShallow, heightMask);

        vec3 distortedLight = normalize(-lightDirection + normal * 0.4);
        float sssAlignment = max(dot(viewDirection, distortedLight), 0.0);
        float sss = pow(sssAlignment, uSssPower) * uSssScale;
        sss *= smoothstep(uSssMinHeight, uSssMaxHeight, vHeight);
        vec3 waterInside = baseWater + uWaterSSS * sss;

        vec3 fresnelNormal = normalize(mix(normal, vec3(0.0, normal.y > 0.0 ? 1.0 : -1.0, 0.0), uFresnelSmoothness));
        vec3 reflectionVector = reflect(-viewDirection, fresnelNormal);
        vec3 reflection = stylizedOceanSky(normalize(reflectionVector), lightDirection, uSunColor);
        float fresnel = fresnelTerm(viewDirection, fresnelNormal);

        vec3 halfVector = normalize(lightDirection + viewDirection);
        float specularTerm = pow(max(dot(halfVector, normal), 0.0), uSpecularPower);
        float sunPath = smoothstep(uSpecularMin, uSpecularMax, specularTerm);
        vec3 directSpecular = uSunColor * sunPath * dynamicSpecular;

        vec3 color = mix(waterInside, reflection + directSpecular, fresnel);

        vec2 foamUv = vOceanXZ / patchLengths.x;
        vec2 foamUv1 = foamUv * uFoamScale;
        foamUv1 += uTime * (uFoamSpeed * 0.05);
        vec2 foamUv2 = foamUv * (uFoamScale * 1.2);
        foamUv2 += uTime * (-uFoamSpeed * 0.07);
        float foamNoise =
          texture2D(uFoamTexture, foamUv1).r *
          texture2D(uFoamTexture, foamUv2).r;
        float turbulence = max(0.0, (uFoamThreshold - vJacobian) * 10.0);
        turbulence *= uFoamPower * 10.0;
        float foamCoverage =
          smoothstep(uFoamThreshold, uFoamThreshold + uFoamEdgeSoftness, turbulence);
        float foamMask =
          foamCoverage * pow(foamNoise, 1.0 / max(uFoamDistortion, 0.001));
        foamMask = clamp(foamMask * 2.4, 0.0, 1.0);
        if (uDebugMode == 3) {
          gl_FragColor = vec4(vec3(foamMask), 1.0);
          return;
        }
        color = mix(color, uFoamColor, foamMask);

        float fogFactor = clamp(1.0 - exp(-pow(dist * uFogDensity, 2.0)), 0.0, 1.0);
        float sunDot = dot(-viewDirection, lightDirection);
        vec3 dynamicFog = uFogColor +
          uSunColor * smoothstep(0.999, 1.0, sunDot) * 1.5 +
          uSunColor * smoothstep(0.985, 1.0, sunDot) * 0.35;
        color = mix(color, dynamicFog, fogFactor);
        // Output linear HDR so post-process ACES tone mapping & bloom handle dynamic range cleanly
        gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
      }
    `,
  });
}

export function createStylizedSeaFloorMaterial({
  sandTexture = null,
  sandColor = new THREE.Color(0xffffff),
  waterDeep = new THREE.Color(0x15a5ec),
  waterShallow = new THREE.Color(0x59cdff),
  maxDepth = 171,
  textureScale = 100,
  causticIntensity = 0.9,
  causticSpeed = 0.1,
  causticScale = 0.01,
  proximityNear = 15,
  proximityFar = 300,
  minWaterTint = 0.53,
} = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSandTexture: { value: sandTexture },
      uSandColor: { value: sandColor.clone() },
      uWaterDeep: { value: waterDeep.clone() },
      uWaterShallow: { value: waterShallow.clone() },
      uMaxDepth: { value: maxDepth },
      uTextureScale: { value: textureScale },
      uCausticIntensity: { value: causticIntensity },
      uCausticSpeed: { value: causticSpeed },
      uCausticScale: { value: causticScale },
      uProximityNear: { value: proximityNear },
      uProximityFar: { value: proximityFar },
      uMinWaterTint: { value: minWaterTint },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec2 vUv;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uTime;
      uniform sampler2D uSandTexture;
      uniform vec3 uSandColor;
      uniform vec3 uWaterDeep;
      uniform vec3 uWaterShallow;
      uniform float uMaxDepth;
      uniform float uTextureScale;
      uniform float uCausticIntensity;
      uniform float uCausticSpeed;
      uniform float uCausticScale;
      uniform float uProximityNear;
      uniform float uProximityFar;
      uniform float uMinWaterTint;
      varying vec3 vWorldPosition;
      varying vec2 vUv;

      vec2 hash(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }

      float voronoiSeamless(vec2 x, float period) {
        vec2 n = floor(x);
        vec2 f = fract(x);
        float minDist = 8.0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 b = vec2(float(i), float(j));
            vec2 wrapped = mod(n + b, period);
            vec2 r = b - f + hash(wrapped);
            r += 0.3 * sin(uTime * 2.0 + hash(wrapped) * 6.2831);
            minDist = min(minDist, dot(r, r));
          }
        }
        return minDist;
      }

      float generatedCaustics(vec2 uv) {
        float p1 = 4.0;
        float c1 = voronoiSeamless(uv * p1 + vec2(uTime * 0.1, uTime * 0.05), p1);
        float p2 = 5.0;
        float c2 = voronoiSeamless(uv * p2 - vec2(uTime * 0.05, uTime * 0.08), p2);
        float p3 = 7.0;
        float c3 = voronoiSeamless(uv * p3 + vec2(-uTime * 0.07, uTime * 0.1), p3);
        return clamp(pow((c1 + c2 + c3) * 0.6, 2.5) * 3.5, 0.0, 1.0);
      }

      void main() {
        vec3 baseSand = texture2D(uSandTexture, vUv * uTextureScale).rgb * uSandColor;

        float depth = max(0.0, -vWorldPosition.y);
        float verticalAttenuation = exp(-depth / (uMaxDepth * 0.5));
        vec3 ambientWater = mix(uWaterDeep, uWaterShallow, verticalAttenuation);
        float cameraDist = length(cameraPosition - vWorldPosition);
        float proximity = smoothstep(uProximityNear, uProximityFar, cameraDist);
        proximity = mix(uMinWaterTint, 1.0, pow(proximity, 3.0));
        vec3 color = mix(baseSand, baseSand * ambientWater, proximity);

        vec2 causticUv = vWorldPosition.xz * uCausticScale +
          uTime * uCausticSpeed * vec2(1.0, 0.5);
        float c1 = generatedCaustics(causticUv);
        float c2 = generatedCaustics(mat2(0.795, -0.606, 0.606, 0.795) *
          (causticUv * 0.618 - uTime * uCausticSpeed * 0.3));
        vec3 causticTint = mix(vec3(1.0), uWaterShallow, 0.2);
        color += causticTint * c1 * c2 * 2.5 * uCausticIntensity * verticalAttenuation;

        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

export function createStylizedUnderwaterCompositeMaterial({
  sceneColor = null,
  sceneDepth = null,
  displacement = null,
  patchLength = 250,
  scale = 1,
  fogColor = new THREE.Color(0x52b9e5),
  waterClarity = 120,
} = {}) {
  return new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSceneColor: { value: sceneColor },
      uSceneDepth: { value: sceneDepth },
      uDisplacement: { value: displacement },
      uPatchLength: { value: patchLength },
      uScale: { value: scale },
      uFogColor: { value: fogColor.clone() },
      uWaterClarity: { value: waterClarity },
      uCameraPosition: { value: new THREE.Vector3() },
      uCameraNear: { value: 0.1 },
      uCameraFar: { value: 1000 },
      uTime: { value: 0 },
      uDebugMode: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform sampler2D uSceneColor;
      uniform sampler2D uSceneDepth;
      uniform sampler2D uDisplacement;
      uniform float uPatchLength;
      uniform float uScale;
      uniform vec3 uFogColor;
      uniform float uWaterClarity;
      uniform vec3 uCameraPosition;
      uniform float uCameraNear;
      uniform float uCameraFar;
      uniform float uTime;
      uniform int uDebugMode;
      varying vec2 vUv;

      #include <packing>

      void main() {
        vec4 inputColor = texture2D(uSceneColor, vUv);
        vec2 waveUv = fract(uCameraPosition.xz / uPatchLength);
        float waveHeight = texture2D(uDisplacement, waveUv).y * uScale;
        bool underwater = uCameraPosition.y <= waveHeight;
        if (!underwater) {
          gl_FragColor = inputColor;
          return;
        }

        float depth = texture2D(uSceneDepth, vUv).x;
        float viewZ = -perspectiveDepthToViewZ(depth, uCameraNear, uCameraFar);
        if (depth >= 0.9999) viewZ = 10000.0;
        float fog = clamp(1.0 - exp(-viewZ / uWaterClarity), 0.0, 1.0);
        vec3 color = mix(inputColor.rgb, uFogColor, fog);

        if (uDebugMode == 4) {
          gl_FragColor = vec4(vec3(fog), 1.0);
          return;
        }

        gl_FragColor = vec4(color, inputColor.a);
      }
    `,
  });
}

export function createStylizedOceanSkyMaterial({
  sunDirection = new THREE.Vector3(-0.14, 0.13, -0.98).normalize(),
  sunColor = new THREE.Color(0xffdf70),
} = {}) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDirection: { value: sunDirection },
      uSunColor: { value: sunColor.clone() },
    },
    vertexShader: `
      varying vec3 vDirection;

      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      varying vec3 vDirection;

      ${stylizedSky}

      void main() {
        vec3 color = stylizedOceanSky(normalize(vDirection), normalize(uSunDirection), uSunColor);
        // Output linear HDR so post-process ACES handles tone mapping consistently
        gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
      }
    `,
  });
}

export function updateStylizedOceanMaterials({
  oceanMaterial,
  seafloorMaterial,
  compositeMaterial,
  cascades,
  elapsed,
  camera,
  debugMode = "final",
}) {
  const debugValue = stylizedOceanDebugModes.get(debugMode) ?? 0;
  oceanMaterial.uniforms.displacement0.value = cascades[0].displacement;
  oceanMaterial.uniforms.displacement1.value = cascades[1].displacement;
  oceanMaterial.uniforms.displacement2.value = cascades[2].displacement;
  oceanMaterial.uniforms.derivatives0.value = cascades[0].derivatives.texture;
  oceanMaterial.uniforms.derivatives1.value = cascades[1].derivatives.texture;
  oceanMaterial.uniforms.derivatives2.value = cascades[2].derivatives.texture;
  oceanMaterial.uniforms.uTime.value = elapsed;
  oceanMaterial.uniforms.uDebugMode.value = debugValue;

  if (seafloorMaterial) seafloorMaterial.uniforms.uTime.value = elapsed;
  if (compositeMaterial) {
    compositeMaterial.uniforms.uDisplacement.value = cascades[0].displacement;
    compositeMaterial.uniforms.uTime.value = elapsed;
    compositeMaterial.uniforms.uDebugMode.value = debugValue;
    if (camera) {
      compositeMaterial.uniforms.uCameraPosition.value.copy(camera.position);
      compositeMaterial.uniforms.uCameraNear.value = camera.near;
      compositeMaterial.uniforms.uCameraFar.value = camera.far;
    }
  }
}

// ============================================================================
// AAA Spectral Cascade Ocean Surface & Sky Backdrop (GLSL3 + FFT Cascades)
// Ported from spectral-cascade-ocean (above water) + abyssal-garden W_SURF (underwater)
// ============================================================================
function smoothStep01(value) {
  return value * value * (3 - 2 * value);
}

function createRandomField(size, seed) {
  const values = new Float32Array(size * size);
  let state = seed >>> 0;
  for (let index = 0; index < values.length; index += 1) {
    state = Math.imul(1664525, state) + 1013904223;
    values[index] = (state >>> 0) / 4294967296;
  }
  return values;
}

function samplePeriodic(field, size, u, v, frequency) {
  const x = u * frequency;
  const y = v * frequency;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothStep01(x - x0);
  const ty = smoothStep01(y - y0);
  const sample = (ix, iy) => {
    const wrappedX = ((ix % frequency) + frequency) % frequency;
    const wrappedY = ((iy % frequency) + frequency) % frequency;
    return field[wrappedY * size + wrappedX];
  };
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(sample(x0, y0), sample(x0 + 1, y0), tx),
    THREE.MathUtils.lerp(sample(x0, y0 + 1), sample(x0 + 1, y0 + 1), tx),
    ty
  );
}

function periodicFbm(field, size, u, v) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 4;
  for (let octave = 0; octave < 4; octave += 1) {
    value += samplePeriodic(field, size, u, v, frequency) * amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / 0.9375;
}

export function createOceanDetailTexture(size = 512, seed = 0x1f2e3d4c) {
  const field = createRandomField(size, seed);
  const data = new Uint8Array(size * size * 4);
  const pixel = 1 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const height = periodicFbm(field, size, u, v);
      const dx =
        periodicFbm(field, size, u + pixel, v) -
        periodicFbm(field, size, u - pixel, v);
      const dy =
        periodicFbm(field, size, u, v + pixel) -
        periodicFbm(field, size, u, v - pixel);
      const fine = periodicFbm(field, size, (u * 2) % 1, (v * 2) % 1);
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(THREE.MathUtils.clamp(0.5 - dx * 1.5, 0, 1) * 255);
      data[offset + 1] = Math.round(THREE.MathUtils.clamp(0.5 - dy * 1.5, 0, 1) * 255);
      data[offset + 2] = Math.round(height * 255);
      data[offset + 3] = Math.round(fine * 255);
    }
  }

  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const SUNNY_SKY_GLSL = /* glsl */ `
  float skyHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float skyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = skyHash(i);
    float b = skyHash(i + vec2(1.0, 0.0));
    float c = skyHash(i + vec2(0.0, 1.0));
    float d = skyHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float skyFbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
    for (int i = 0; i < 4; i++) {
      s += a * skyNoise(p);
      p = rot * p * 2.04 + vec2(17.1, 31.3);
      a *= 0.5;
    }
    return s;
  }
  vec3 coastalSkyRadiance(vec3 direction) {
    // Linear-space tropical sunny sky colors (postMat applies ACES + 1/2.2 sRGB gamma)
    vec3 horizonColor = vec3(0.18, 0.52, 0.86);
    vec3 midSkyColor  = vec3(0.045, 0.24, 0.68);
    vec3 zenithColor  = vec3(0.012, 0.09, 0.42);
    vec3 sunColor     = vec3(1.00, 0.92, 0.76);
    float h = max(direction.y, 0.0);
    vec3 gradient = mix(horizonColor, midSkyColor, smoothstep(0.0, 0.18, h));
    gradient = mix(gradient, zenithColor, smoothstep(0.16, 0.65, h));

    float sunAlignment = max(dot(direction, uAirSunDir), 0.0);
    vec3 disc = sunColor * smoothstep(0.9992, 0.9999, sunAlignment) * 12.0;
    vec3 innerGlow = sunColor * pow(sunAlignment, 64.0) * 0.65;
    vec3 halo = vec3(0.95, 0.82, 0.62) * pow(sunAlignment, 8.0) * 0.14;
    vec3 sky = gradient + disc + innerGlow + halo;

    if (direction.y > 0.04) {
      vec2 cloudUv = direction.xz / (direction.y + 0.22) * 0.85 + vec2(uTime * 0.003, uTime * 0.0015);
      float c1 = skyFbm(cloudUv * 1.15);
      float c2 = skyFbm(cloudUv * 2.4 + vec2(3.7, -1.9));
      float wisps = smoothstep(0.66, 0.88, c1 * 0.72 + c2 * 0.28) * smoothstep(0.04, 0.26, direction.y);
      vec3 cloudCol = mix(vec3(0.62, 0.76, 0.92), sunColor * 0.85, 0.40 + 0.40 * pow(sunAlignment, 3.0));
      sky = mix(sky, cloudCol, wisps * 0.22);
    }
    return sky;
  }
`;

export function createAbyssalSurfaceMaterial(sharedUniforms, mediumGlsl, patchLengths = [180, 28, 6]) {
  const extraUniforms = {
    displacement0: { value: null },
    displacement1: { value: null },
    displacement2: { value: null },
    derivatives0: { value: null },
    derivatives1: { value: null },
    derivatives2: { value: null },
    uPatchLengths: { value: new THREE.Vector3(patchLengths[0], patchLengths[1], patchLengths[2]) },
    uFoamTexture: { value: null },
    detailTexture: { value: createOceanDetailTexture(512) },
  };

  const vs = /* glsl */ `
    precision highp float;
    uniform sampler2D displacement0;
    uniform sampler2D displacement1;
    uniform sampler2D displacement2;
    uniform vec3 uPatchLengths;

    ${mediumGlsl}

    out vec3 vWPos;
    out vec2 vBaseXZ;
    out vec2 vWakeSlope;
    out float vWhaleFoam;
    out float vHeight;
    out float vFoamHist;
    out vec4 vClipPos;

    const float PIXEL_ANGLE = 0.001;

    vec4 sampleDisplacement(sampler2D map, vec2 xz, float lengthScale) {
      return texture(map, fract(xz / lengthScale));
    }

    void addWake(vec2 xz, vec4 wk, inout float dy, inout vec2 slope, inout float wf) {
      if (wk.w <= 0.01) return;
      vec2 dvec = xz - wk.xz;
      float d = length(dvec);
      if (d > 52.0) return;
      vec2 rdir = d > 0.05 ? dvec / d : vec2(1.0, 0.0);
      float env = exp(-d * 0.068) * wk.w;
      float ring = sin(d * 1.15 - uTime * 3.8);
      float dRing = cos(d * 1.15 - uTime * 3.8) * 1.15;
      dy += env * ring * 0.34;
      slope += rdir * (env * dRing * 0.34);
      wf += exp(-d * 0.11) * smoothstep(0.12, 0.85, 0.5 + 0.5 * sin(d * 1.45 - uTime * 4.4)) * wk.w;
    }

    void main() {
      vec3 baseW = (modelMatrix * vec4(position, 1.0)).xyz;
      vec2 oceanPos = baseW.xz;

      // Pixel-footprint Spectral LOD on vertex displacement (submerged-snell-ocean/source/ocean-material.ts)
      float vertexDist = length(uCamPos - baseW);
      float vertexGap = max(abs(uCamPos.y - uWaveHeight), 0.5);
      float vertexFootprint = (vertexDist * vertexDist * PIXEL_ANGLE) / vertexGap;
      float farEdgeKeep = 1.0 - smoothstep(185.0, 235.0, vertexDist);

      float keep0 = (1.0 - smoothstep(2.5, 5.5, vertexFootprint)) * farEdgeKeep;
      float keep1 = (1.0 - smoothstep(0.35, 1.2, vertexFootprint)) * farEdgeKeep;
      float keep2 = (1.0 - smoothstep(0.10, 0.40, vertexFootprint)) * farEdgeKeep;

      vec4 d0 = sampleDisplacement(displacement0, oceanPos, uPatchLengths.x);
      vec4 d1 = sampleDisplacement(displacement1, oceanPos, uPatchLengths.y);
      vec4 d2 = sampleDisplacement(displacement2, oceanPos, uPatchLengths.z);

      vec3 displacement = d0.xyz * keep0 + d1.xyz * keep1 + d2.xyz * keep2;

      // Live GPU 2D Wave-Equation Heightfield displacement (interactive-pool-volume + Gerstner crest pinch)
      vec2 ruv = (oceanPos - uRippleCenter) / max(uRippleSize, 1.0) + 0.5;
      if (ruv.x > 0.02 && ruv.x < 0.98 && ruv.y > 0.02 && ruv.y < 0.98) {
        vec2 rEdge = min(ruv, 1.0 - ruv);
        float rMask = smoothstep(0.02, 0.10, min(rEdge.x, rEdge.y));
        vec4 rSam = textureLod(uRippleTex, ruv, 0.0);
        displacement.y += rSam.r * 1.05 * rMask * keep1;
        displacement.xz -= clamp(rSam.gb, vec2(-1.2), vec2(1.2)) * 0.24 * rMask * keep1;
      }

      float wakeDy = 0.0;
      vec2 wakeSlope = vec2(0.0);
      float whaleFoam = 0.0;
      addWake(oceanPos, uWhaleWake0, wakeDy, wakeSlope, whaleFoam);
      addWake(oceanPos, uWhaleWake1, wakeDy, wakeSlope, whaleFoam);

      displacement.y += uWaveHeight + wakeDy * farEdgeKeep;

      vec3 wp = baseW + displacement;
      vWPos = wp;
      vBaseXZ = oceanPos;
      vWakeSlope = wakeSlope * farEdgeKeep;
      vWhaleFoam = whaleFoam * farEdgeKeep;
      vHeight = displacement.y - uWaveHeight;
      vFoamHist = min(d0.w > 0.001 ? d0.w : 1.0, d1.w > 0.001 ? d1.w : 1.0);
      vClipPos = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      gl_Position = vClipPos;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    uniform sampler2D displacement0;
    uniform sampler2D displacement1;
    uniform sampler2D displacement2;
    uniform sampler2D derivatives0;
    uniform sampler2D derivatives1;
    uniform sampler2D derivatives2;
    uniform vec3 uPatchLengths;
    uniform sampler2D detailTexture;

    ${mediumGlsl}
    ${SUNNY_SKY_GLSL}

    in vec3 vWPos;
    in vec2 vBaseXZ;
    in vec2 vWakeSlope;
    in float vWhaleFoam;
    in float vHeight;
    in float vFoamHist;
    in vec4 vClipPos;

    layout(location = 0) out vec4 fragColor;

    const float AIR_IOR = 1.0;
    const float WATER_IOR = 1.3335;
    const float PIXEL_ANGLE = 0.001;
    const float PI = 3.14159265359;

    // Beer-Lambert absorption + scattering coefficients (photoreal-water.js & submerged-snell-ocean)
    const vec3 SIG_A = vec3(0.24, 0.048, 0.036);
    const vec3 SIG_S = vec3(0.022, 0.048, 0.064);
    const vec3 SIG_T = SIG_A + SIG_S;
    const vec3 AQUATIC_AMBIENT_DOWN = vec3(0.010, 0.085, 0.165);
    const vec3 AQUATIC_AMBIENT_UP   = vec3(0.065, 0.310, 0.390);
    const vec3 SSS_TINT             = vec3(0.035, 0.240, 0.280);

    // Cubic B-spline filtering in 4 bilinear taps (photoreal-water.js line 349): C2 smooth wave slopes
    vec4 texBS(sampler2D t, vec2 uv) {
      vec2 ts = vec2(textureSize(t, 0));
      vec2 p = fract(uv) * ts - 0.5;
      vec2 f = fract(p);
      p = floor(p);
      vec2 f2 = f * f;
      vec2 f3 = f2 * f;
      vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
      vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
      vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
      vec2 w3 = f3 / 6.0;
      vec2 g0 = w0 + w1;
      vec2 g1 = w2 + w3;
      vec2 h0 = (w1 / g0 - 0.5 + p) / ts;
      vec2 h1 = (w3 / g1 + 1.5 + p) / ts;
      return (texture(t, vec2(h0.x, h0.y)) * g0.x + texture(t, vec2(h1.x, h0.y)) * g1.x) * g0.y
           + (texture(t, vec2(h0.x, h1.y)) * g0.x + texture(t, vec2(h1.x, h1.y)) * g1.x) * g1.y;
    }

    // Exact unpolarised dielectric Fresnel with fwidth-filtered critical angle (submerged-snell-ocean)
    // Returns vec3(fresnelReflectance, canTransmitMask, cosTransmitted)
    vec3 dielectricFresnel(float cosIncident, float etaI, float etaT) {
      float ci = clamp(cosIncident, 0.0, 1.0);
      float etaRatio = etaI / etaT;
      float sinTransmitted2 = etaRatio * etaRatio * (1.0 - ci * ci);
      float criticalWidth = clamp(fwidth(sinTransmitted2) * 1.5, 0.001, 0.05);
      float canTransmit = 1.0 - smoothstep(1.0 - criticalWidth, 1.0 + criticalWidth, sinTransmitted2);
      float cosTransmitted = sqrt(max(0.0, 1.0 - sinTransmitted2));
      float rs = (etaI * ci - etaT * cosTransmitted) / max(etaI * ci + etaT * cosTransmitted, 1e-4);
      float rp = (etaT * ci - etaI * cosTransmitted) / max(etaT * ci + etaI * cosTransmitted, 1e-4);
      return vec3(0.5 * (rs * rs + rp * rp), canTransmit, cosTransmitted);
    }

    vec3 reconstructWorldPos(vec2 uv, float depth01) {
      vec4 ndc = vec4(uv * 2.0 - 1.0, depth01 * 2.0 - 1.0, 1.0);
      vec4 viewPos = uInvProjMatrix * ndc;
      viewPos /= max(viewPos.w, 1e-5);
      return (uCameraWorldMatrix * viewPos).xyz;
    }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 screenUv = clamp((vClipPos.xy / max(vClipPos.w, 1e-4)) * 0.5 + 0.5, vec2(0.001), vec2(0.999));

      // Pixel-footprint Spectral LOD (submerged-snell-ocean/source/ocean-material.ts lines 285-295)
      vec3 toCam = uCamPos - vWPos;
      float distCam = max(length(toCam), 1e-4);
      vec3 viewDir = toCam / distCam;
      vec3 incident = -viewDir;

      float heightGap = max(abs(uCamPos.y - vWPos.y), 0.5);
      float pixelFootprint = (distCam * distCam * PIXEL_ANGLE) / heightGap;
      float farEdgeKeep = 1.0 - smoothstep(190.0, 235.0, distCam);

      float keep0Above = (1.0 - smoothstep(2.5, 5.5, pixelFootprint)) * farEdgeKeep;
      float keep1 = (1.0 - smoothstep(0.35, 1.2, pixelFootprint)) * farEdgeKeep;
      float keep2 = (1.0 - smoothstep(0.10, 0.40, pixelFootprint)) * farEdgeKeep;
      float distanceFade = smoothstep(5.0, 16.0, pixelFootprint);

      // Cubic B-spline filtered cascade derivatives (photoreal-water.js)
      vec4 dr0 = texBS(derivatives0, vBaseXZ / uPatchLengths.x) * farEdgeKeep;
      vec4 dr1 = texBS(derivatives1, vBaseXZ / uPatchLengths.y) * keep1;
      vec4 dr2 = texBS(derivatives2, vBaseXZ / uPatchLengths.z) * keep2;

      // 5-step iterative coordinate refinement on interactive wave heightfield (interactive-pool-volume lines 814-821)
      vec2 ripSlope = vec2(0.0);
      float ripCurv = 0.0;
      vec2 ruv = (vBaseXZ - uRippleCenter) / max(uRippleSize, 1.0) + 0.5;
      if (ruv.x > 0.02 && ruv.x < 0.98 && ruv.y > 0.02 && ruv.y < 0.98) {
        vec2 coord = ruv;
        vec4 rInfo = texture(uRippleTex, coord);
        for (int i = 0; i < 5; i++) {
          coord = clamp(coord + rInfo.gb * 0.0042, 0.02, 0.98);
          rInfo = texture(uRippleTex, coord);
        }
        vec2 rEdge = min(ruv, 1.0 - ruv);
        float rMask = smoothstep(0.02, 0.10, min(rEdge.x, rEdge.y));
        ripSlope = clamp(rInfo.gb, vec2(-1.45), vec2(1.45)) * 1.15 * rMask * keep1;
        ripCurv = clamp(-rInfo.a * 0.35 + length(ripSlope) * 0.85, 0.0, 1.5) * rMask * keep1;
      }

      // Fold-aware wave normal (submerged-snell-ocean lines 323-338)
      vec4 totalDer = dr0 + dr1 + dr2;
      vec2 baseSlope = vec2(
        totalDer.x / max(0.18, 1.0 + totalDer.z),
        totalDer.y / max(0.18, 1.0 + totalDer.w)
      ) + vWakeSlope + ripSlope;
      vec3 upNormal = normalize(vec3(-baseSlope.x, 1.0, -baseSlope.y));

      float uwCam = 1.0 - smoothstep(uWaveHeight - 0.14, uWaveHeight + 0.14, uCamPos.y);

      // ---- 1. UNDERWATER VIEW: True Snell's Window + Upwelling TIR + Abyssal Medium ----
      // (Combines submerged-snell-ocean/source/ocean-material.ts & interactive-pool-volume)
      vec3 underCol = vec3(0.0);
      if (uwCam > 0.001) {
        float fl = ss(230.0, 55.0, distCam);
        vec2 sCaus = (
          texture(uWaterTex, vWPos.xz / 13.0).ba * 0.65 +
          texture(uWaterTex, vWPos.zx / 4.7 + 0.2).ba * 0.45 +
          baseSlope * 0.85
        ) * fl;
        vec3 nUw = normalize(vec3(-sCaus.x * 0.82, -1.0, -sCaus.y * 0.82));

        // Exact dielectric Fresnel for water -> air (submerged-snell-ocean line 447)
        float belowNoV = max(dot(viewDir, nUw), 0.001);
        vec3 belowFresnel = dielectricFresnel(belowNoV, WATER_IOR, AIR_IOR);
        float interfaceFresnel = belowFresnel.x;
        float insideWindow = belowFresnel.y;
        float cosTransmitted = belowFresnel.z;
        float interfaceTransmission = insideWindow * (1.0 - interfaceFresnel);

        vec3 belowRefracted = refract(incident, nUw, WATER_IOR / AIR_IOR);
        belowRefracted.y = max(belowRefracted.y, 0.01);
        vec3 skyThrough = coastalSkyRadiance(normalize(belowRefracted)) * 1.15;

        // Forward-refracted above-water silhouettes (seabirds, breaching whale fluke/spout) through Snell's window
        vec2 snellUv = clamp(screenUv + nUw.xz * 0.045 * insideWindow, vec2(0.002), vec2(0.998));
        float snellDepth = texture(uRefractDepth, snellUv).r;
        if (snellDepth < 0.9999) {
          vec3 snellWorld = reconstructWorldPos(snellUv, snellDepth);
          if (snellWorld.y > vWPos.y + 0.18) {
            vec3 airObjCol = texture(uRefractTex, snellUv).rgb;
            float airMix = smoothstep(0.18, 0.55, snellWorld.y - vWPos.y);
            skyThrough = mix(skyThrough, airObjCol, airMix * 0.88);
          }
        }

        // Energy-conserving angular-stretch-broadened solar window glint (submerged-snell-ocean lines 858-873)
        float snellStretch = max(1.0, (WATER_IOR / AIR_IOR) * belowNoV / max(cosTransmitted, 0.04));
        float normalTilt = max(length(dFdx(nUw)), length(dFdy(nUw)));
        float transmittedSpread = (snellStretch - 1.0) * normalTilt * 0.5;
        float glintExp = clamp(1.0 / (1.0 / 650.0 + transmittedSpread * transmittedSpread), 16.0, 650.0);
        float sd = max(dot(normalize(belowRefracted), uSunDir), 0.0);
        vec3 windowGlint = vec3(1.0, 0.95, 0.85) * (
          pow(sd, glintExp) * (glintExp * (14.0 / 650.0)) +
          pow(sd, 48.0) * 1.15
        );

        vec3 transmittedScene = skyThrough + windowGlint;

        // Outside the critical angle (~48.6 deg): Total Internal Reflection (TIR) of upwelling water light
        float z = zone(vWPos);
        vec3 R = reflect(incident, nUw);
        vec3 crestLight = normalize(-uSunDir + nUw * 0.4);
        float crestScatter = pow(max(dot(viewDir, crestLight), 0.0), 4.5) * smoothstep(-0.15, 0.65, vHeight);
        vec3 tirBody = fogIn(vWPos, R, 240.0, z * 0.25, uSunDir) * 0.96 + SSS_TINT * crestScatter * 0.38;

        vec3 c = mix(tirBody, transmittedScene, interfaceTransmission);
        underCol = fog(c, vWPos, z);
      }

      // ---- 2. ABOVE-WATER VIEW: Photoreal Refracted Underwater Volume + Spectral Ocean ----
      // (Combines photoreal-water.js, submerged-snell-ocean, and interactive-pool-volume)
      vec3 aboveCol = vec3(0.0);
      if (uwCam < 0.999) {
        vec4 aboveDer = dr0 * keep0Above + dr1 + dr2;
        vec2 aboveSlope = vec2(
          aboveDer.x / max(0.18, 1.0 + aboveDer.z),
          aboveDer.y / max(0.18, 1.0 + aboveDer.w)
        ) + vWakeSlope + ripSlope;
        vec3 aboveNormal = normalize(vec3(-aboveSlope.x, 1.0, -aboveSlope.y));

        // Two advected capillary bands gated by pixel footprint (submerged-snell-ocean lines 366-393)
        vec2 detailA = texture(detailTexture, vBaseXZ * 0.065 + vec2(uTime * 0.008, uTime * 0.005)).rg * 2.0 - 1.0;
        vec2 detailB = texture(detailTexture, vBaseXZ * 0.19 + vec2(-uTime * 0.012, uTime * 0.009)).rg * 2.0 - 1.0;
        float detailKeepA = (1.0 - smoothstep(0.025, 0.14, pixelFootprint)) * farEdgeKeep;
        float detailKeepB = (1.0 - smoothstep(0.008, 0.045, pixelFootprint)) * farEdgeKeep;
        vec2 capSlope = detailA * detailKeepA + detailB * detailKeepB * 0.45;
        aboveNormal = normalize(mix(
          aboveNormal + vec3(capSlope.x, 0.0, capSlope.y) * 0.055,
          vec3(0.0, 1.0, 0.0),
          distanceFade
        ));

        float aboveNoV = max(dot(aboveNormal, viewDir), 0.002);
        vec3 aboveFresnelRes = dielectricFresnel(aboveNoV, AIR_IOR, WATER_IOR);
        float F = aboveFresnelRes.x;

        // 2a. Reflected Sky & Horizon Radiance
        vec3 reflectedDir = reflect(incident, aboveNormal);
        reflectedDir.y = max(abs(reflectedDir.y), 0.015);
        vec3 reflection = coastalSkyRadiance(normalize(reflectedDir));

        // 2b. Refracted Underwater Scene Radiance with Beer-Lambert Extinction & Henyey-Greenstein Scattering
        // (photoreal-water.js lines 435-496 + submerged-snell-ocean lines 654-783)
        vec3 tr = refract(incident, aboveNormal, AIR_IOR / WATER_IOR);
        vec2 refrOffset = aboveNormal.xz * (-0.042 / max(1.0 + distCam * 0.032, 1.0)) * (1.0 - distanceFade);
        vec2 refrUv = clamp(screenUv + refrOffset, vec2(0.002), vec2(0.998));
        float refrDepth = texture(uRefractDepth, refrUv).r;
        vec3 refrWorld = reconstructWorldPos(refrUv, refrDepth);

        // Guard against sampling above-water objects (e.g. breaching whale fluke) across the waterline
        if (refrWorld.y > vWPos.y + 0.06) {
          refrUv = screenUv;
          refrDepth = texture(uRefractDepth, refrUv).r;
          refrWorld = reconstructWorldPos(refrUv, refrDepth);
        }

        vec3 sceneUnder = texture(uRefractTex, refrUv).rgb;
        float hasBottom = step(refrDepth, 0.9995);
        float waterPath = hasBottom > 0.5 ? clamp(length(refrWorld - vWPos), 0.25, 140.0) : 85.0;
        float depthHere = hasBottom > 0.5 ? clamp(vWPos.y - refrWorld.y, 0.2, 52.0) : 45.0;

        // Beer-Lambert RGB transmittance & Henyey-Greenstein forward scattering (photoreal-water.js lines 477-482)
        vec3 Tv = exp(-SIG_T * (waterPath * 0.12));
        vec3 sunT = refract(-uAirSunDir, vec3(0.0, 1.0, 0.0), AIR_IOR / WATER_IOR);
        float Ts = 1.0 - dielectricFresnel(max(uAirSunDir.y, 0.05), AIR_IOR, WATER_IOR).x;
        float cosS = dot(sunT, -tr);
        const float hgG = 0.78;
        float ph = (1.0 - hgG * hgG) / (4.0 * PI * pow(max(1.0 + hgG * hgG - 2.0 * hgG * cosS, 0.05), 1.5));

        float transmittedUpness = smoothstep(-0.55, 0.65, tr.y);
        float heightMask = smoothstep(-0.35, 0.35, vHeight * keep0Above);
        vec3 aquaticInscatter = mix(AQUATIC_AMBIENT_DOWN, AQUATIC_AMBIENT_UP, transmittedUpness)
          * (1.0 + heightMask * 0.45)
          + vec3(0.04, 0.28, 0.38) * (Ts * exp(-SIG_T * (depthHere * 0.08)) * (ph + 0.06) * 1.6);

        // Subsurface crest scatter (submerged-snell-ocean lines 582-593)
        float noL = max(dot(aboveNormal, uAirSunDir), 0.0);
        vec3 aboveCrestLight = normalize(-uAirSunDir + aboveNormal * 0.4);
        float aboveCrestScatter = pow(max(dot(viewDir, aboveCrestLight), 0.0), 4.5) * smoothstep(-0.08, 0.32, vHeight);
        float forwardScatter = pow(max(dot(viewDir, -uAirSunDir), 0.0), 4.0) * smoothstep(-0.10, 0.28, vHeight) * (1.0 - F) * 0.35;
        vec3 surfaceScatter = SSS_TINT * (aboveCrestScatter + forwardScatter) * (0.5 + 0.5 * noL);

        vec3 under = sceneUnder * Tv + aquaticInscatter * (1.0 - Tv) + surfaceScatter;

        // 3-layer sunlit suspended water-column specks seen through clear surface (photoreal-water.js lines 484-495)
        if (distCam < 48.0) {
          float speckKeep = 1.0 - smoothstep(22.0, 48.0, distCam);
          for (int k = 0; k < 3; k++) {
            float dz = 0.25 + 0.42 * float(k);
            float tt = dz / max(-tr.y, 0.08);
            vec2 q = (vWPos.xz + tr.xz * tt) * 24.0 + vec2(uTime * (0.04 + 0.02 * float(k)), uTime * 0.015) + float(k) * 17.0;
            vec2 id = floor(q);
            vec2 f = fract(q) - 0.5;
            float r = hash12(id + float(k) * 13.1);
            vec2 of = vec2(hash12(id + 3.1), hash12(id + 7.7)) - 0.5;
            float fw = fwidth(q.x) + fwidth(q.y);
            float dotP = smoothstep(0.11 + fw, 0.0, length(f - of * 0.6)) * step(0.986, r) * step(tt, waterPath);
            float fade = exp(-SIG_T.g * tt * 1.4) * smoothstep(1.2, 0.25, fw);
            under += dotP * fade * vec3(0.85, 0.96, 0.98) * Ts * 0.065 * speckKeep;
          }
        }

        // 2c. Slope-Variance-Widened Beckmann + Smith-GGX Solar Glints (photoreal-water.js lines 426-433 & submerged-snell-ocean lines 788-815)
        float slopeVar = dot(capSlope, capSlope) * 0.015 + pixelFootprint * 0.002;
        float a2 = clamp(0.0018 + 0.85 * slopeVar, 0.0018, 0.045);
        vec3 h = normalize(viewDir + uAirSunDir);
        float nh = max(dot(aboveNormal, h), 0.0);
        float nl = max(dot(aboveNormal, uAirSunDir), 0.0);
        float c2 = max(nh * nh, 1e-4);
        float tan2 = (1.0 - c2) / c2;
        float D = exp(-tan2 / a2) / (PI * a2 * c2 * c2);
        float Vis = 0.5 / (nl * sqrt(aboveNoV * aboveNoV * (1.0 - a2) + a2) + aboveNoV * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-5);
        float Fh = dielectricFresnel(max(dot(h, viewDir), 0.0), AIR_IOR, WATER_IOR).x;
        vec3 sunGlint = vec3(1.0, 0.94, 0.80) * min(D * Vis * Fh * nl, 16.0) * 1.45 * (1.0 - distanceFade);

        vec3 water = mix(under, reflection, F) + sunGlint;

        // 2d. Jacobian + Whale Wake + Ripple Foam
        float j0 = (1.0 + dr0.z) * (1.0 + dr0.w);
        float j1 = (1.0 + dr1.z) * (1.0 + dr1.w);
        float hist = min(vFoamHist, min(j0, j1));
        float foamRaw = clamp((0.20 - hist) * 2.2, 0.0, 1.0) * 0.35 + vWhaleFoam * 0.95 + ripCurv * 0.95;
        float foamCoverage = smoothstep(0.20, 0.88, foamRaw) * (1.0 - distanceFade);

        float bubbleA = texture(detailTexture, vBaseXZ * 0.45 + vec2(uTime * 0.02, uTime * 0.015)).b;
        float bubbleB = texture(detailTexture, vBaseXZ * 1.6 + vec2(-uTime * 0.035, uTime * 0.025)).a;
        float bubble = clamp(bubbleA * 0.7 + bubbleB * 0.5 + 0.2, 0.0, 1.0);
        float foamLight = 0.65 + 0.45 * nl;
        vec3 shadedFoam = vec3(0.84, 0.91, 0.96) * bubble * foamLight;
        vec3 color = mix(water, shadedFoam, foamCoverage);

        // Distant marine aerosol haze matching linear horizon sky (photoreal-water.js lines 500-504)
        float fogFactor = 1.0 - exp(-0.0018 * 0.0018 * distCam * distCam);
        vec3 fogColor = vec3(0.18, 0.52, 0.86);
        aboveCol = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));
      }

      fragColor = vec4(mix(aboveCol, underCol, uwCam), 1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sharedUniforms, ...extraUniforms },
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
  });
  for (const k of Object.keys(sharedUniforms)) {
    mat.uniforms[k] = sharedUniforms[k];
  }
  return mat;
}

export function createAbyssalBackdropMaterial(sharedUniforms, mediumGlsl) {
  const vs = /* glsl */ `
    ${mediumGlsl}
    out vec3 vDir;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDir = normalize(position);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fs = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    ${mediumGlsl}
    ${SUNNY_SKY_GLSL}
    in vec3 vDir;
    layout(location = 0) out vec4 fragColor;

    void main() {
      vec3 rd = normalize(vDir);
      float uwCam = 1.0 - smoothstep(uWaveHeight - 0.14, uWaveHeight + 0.14, uCamPos.y);
      vec3 uwBg = fin(rd);
      vec3 airBg = rd.y >= -0.01
        ? coastalSkyRadiance(rd)
        : mix(coastalSkyRadiance(normalize(vec3(rd.x, 0.01, rd.z))), vec3(0.016, 0.185, 0.365), smoothstep(-0.01, -0.18, rd.y));
      fragColor = vec4(mix(airBg, uwBg, uwCam), 1.0);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    vertexShader: vs,
    fragmentShader: fs,
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
  });
  for (const k of Object.keys(sharedUniforms)) {
    mat.uniforms[k] = sharedUniforms[k];
  }
  return mat;
}
