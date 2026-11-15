import * as THREE from 'three';

// ============================================================================
// Direct Port of threejs-procedural-materials/deformable-sand
// Source files ported:
// - source/config.ts
// - source/render/shaders.ts (grainAppearance, materialForGrain, environment,
//   microfacetDistribution, geometryAttenuation, reflectiveGlintAt,
//   shadeSurface, fragmentMobile, grainVertex, grainFragment)
// - source/render/lighting.ts (14-step raymarched visibility + 8-axis x 6-radius
//   horizon-angle ambient occlusion)
// - source/render/postprocess.ts (filmicGrade S-curve + solar starburst glints)
// - source/simulation/shaders.ts (mass-conserving tool excavation, rim escape
//   pile-up, and 8-neighbor angle-of-repose avalanche transport)
// ============================================================================

export const SAND_LIGHT_ANGLE = -0.8;
export const SAND_LIGHT_DIR = new THREE.Vector3(
  Math.cos(SAND_LIGHT_ANGLE),
  0.65,
  Math.sin(SAND_LIGHT_ANGLE)
).normalize();

export const DEFORMABLE_SAND_GLSL = /* glsl */ `
const vec3 SAND_LIGHT_DIRECTION = vec3(0.58319, 0.54410, -0.60336); // normalize(vec3(cos(-0.8), 0.65, sin(-0.8)))

vec2 sandHash2(vec2 position) {
  vec3 hashed = fract(vec3(position.xyx) * vec3(0.1031, 0.1030, 0.0973));
  hashed += dot(hashed, hashed.yzx + 33.33);
  return fract((hashed.xx + hashed.yz) * hashed.zy);
}

float sandHash1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 grainAxis(vec2 random) {
  float horizontal = random.x * 2.0 - 1.0;
  float verticalMagnitude = max(0.08, 1.0 - abs(horizontal));
  float vertical = (random.y >= 0.5) ? verticalMagnitude : -verticalMagnitude;
  return normalize(vec2(horizontal, vertical));
}

vec2 warpGrainCoordinate(vec2 coordinate) {
  float waveA = sin(dot(coordinate, vec2(0.071, 0.109)) + 1.37);
  float waveB = sin(dot(coordinate, vec2(-0.097, 0.063)) - 0.82);
  return coordinate + vec2(waveA, waveB) * 0.14;
}

struct GrainAppearance {
  vec2 offset;
  vec2 shapedOffset;
  vec2 axis;
  vec2 color;
  vec2 materialSeed;
  vec2 grainCell;
  float edge;
  float roundness;
};

GrainAppearance grainAppearance(vec2 coordinate) {
  vec2 warpedCoordinate = warpGrainCoordinate(coordinate);
  vec2 baseCell = floor(warpedCoordinate);
  float nearest = 100.0;
  float second = 100.0;
  vec2 grainOffset = vec2(0.0);
  vec2 shapedOffset = vec2(0.0);
  vec2 selectedAxis = vec2(1.0, 0.0);
  vec2 grainColor = vec2(0.5);
  vec2 selectedCell = vec2(0.0);

  for (int row = -1; row <= 1; row++) {
    for (int column = -1; column <= 1; column++) {
      vec2 cell = baseCell + vec2(float(column), float(row));
      vec2 random = sandHash2(cell);
      vec2 center = cell + (0.16 + 0.68 * random);
      vec2 offset = warpedCoordinate - center;
      vec2 axis = grainAxis(random);
      vec2 perpendicular = vec2(-axis.y, axis.x);
      float aspectSeed = fract(random.x * 5.37 + random.y * 7.91);
      float aspect = mix(0.78, 1.27, aspectSeed);
      vec2 local = vec2(dot(offset, axis) / aspect, dot(offset, perpendicular) * aspect);
      float distSq = dot(local, local);
      if (distSq < nearest) {
        second = nearest;
        nearest = distSq;
        grainOffset = offset;
        shapedOffset = local;
        selectedAxis = axis;
        grainColor = random;
        selectedCell = cell;
      } else {
        second = min(second, distSq);
      }
    }
  }

  float boundary = sqrt(second) - sqrt(nearest);
  vec2 materialSeed = sandHash2(selectedCell + vec2(87.17, 31.73));
  float rawRoundness = sqrt(max(0.0, 1.0 - min(nearest / 0.44, 1.0)));
  float angularity = mix(rawRoundness, smoothstep(0.04, 0.96, rawRoundness), materialSeed.y * 0.46);

  GrainAppearance ga;
  ga.offset = grainOffset;
  ga.shapedOffset = shapedOffset;
  ga.axis = selectedAxis;
  ga.color = grainColor;
  ga.materialSeed = materialSeed;
  ga.grainCell = selectedCell;
  ga.edge = smoothstep(0.014, 0.145, boundary);
  ga.roundness = angularity;
  return ga;
}

struct SandMaterial {
  vec3 albedo;
  float roughness;
  float translucency;
  float fresnelBase;
  float sparkleAffinity;
};

// Marine Carbonate / Coral-Reef & Mineral Quartz Grain Families
// Warm champagne-ivory carbonate grains mixed with olive-quartz, pale shell, and fine dark basaltic specks
SandMaterial materialForGrain(vec2 seed, float composition) {
  float family = fract(seed.x + (composition - 0.5) * 0.085);
  vec3 albedo = vec3(0.66, 0.59, 0.45);
  float roughness = 0.48;
  float translucency = 0.10;
  float fresnelBase = 0.042;
  float sparkleAffinity = 0.52;

  if (family < 0.36) {
    // Translucent champagne carbonate & quartz grains
    albedo = vec3(0.74, 0.67, 0.52);
    roughness = 0.36;
    translucency = 0.18;
    sparkleAffinity = 0.74;
  } else if (family < 0.66) {
    // Warm reef-limestone tan grains
    albedo = vec3(0.63, 0.55, 0.41);
    roughness = 0.46;
    translucency = 0.11;
    sparkleAffinity = 0.50;
  } else if (family < 0.82) {
    // Pale bleached coral & shell fragment grains
    albedo = vec3(0.80, 0.76, 0.65);
    roughness = 0.30;
    translucency = 0.22;
    sparkleAffinity = 0.66;
  } else if (family < 0.92) {
    // Ochre-olive silicate grains
    albedo = vec3(0.50, 0.44, 0.31);
    roughness = 0.56;
    translucency = 0.04;
    sparkleAffinity = 0.22;
  } else if (family < 0.972) {
    // Weathered shell / terracotta carbonate flecks
    albedo = vec3(0.42, 0.34, 0.24);
    roughness = 0.62;
    translucency = 0.02;
    sparkleAffinity = 0.12;
  } else {
    // Sparse fine volcanic basalt / magnetite mineral specks
    albedo = vec3(0.20, 0.20, 0.19);
    roughness = 0.68;
    translucency = 0.0;
    fresnelBase = 0.048;
    sparkleAffinity = 0.04;
  }

  float tint = (seed.y - 0.5) * 0.09;
  albedo *= vec3(1.0 + tint, 1.0 + tint * 0.60, 1.0 - tint * 0.35);
  roughness = clamp(roughness + (seed.y - 0.5) * 0.10, 0.24, 0.76);

  SandMaterial sm;
  sm.albedo = albedo;
  sm.roughness = roughness;
  sm.translucency = translucency;
  sm.fresnelBase = fresnelBase;
  sm.sparkleAffinity = sparkleAffinity;
  return sm;
}

// Underwater reef water-column light environment for sand reflections & hemisphere fill
vec3 sandEnvironment(vec3 direction, vec3 waterAmb) {
  float upward = max(direction.y, 0.0);
  vec3 waterZenith = max(waterAmb * 1.35, vec3(0.08, 0.36, 0.48));
  vec3 waterHorizon = max(waterAmb * 0.95, vec3(0.11, 0.32, 0.38));
  vec3 sky = mix(waterHorizon, waterZenith, pow(upward, 0.55));
  vec3 ground = mix(vec3(0.05, 0.12, 0.14), vec3(0.14, 0.24, 0.24), smoothstep(-1.0, 0.0, direction.y));
  return (direction.y >= 0.0) ? sky : ground;
}

float sandMicrofacetDistribution(float alphaSquared, float normalHalf) {
  float denominator = normalHalf * normalHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(3.141593 * denominator * denominator, 0.0001);
}

float sandGeometryAttenuation(float cosine, float viewCosine) {
  return cosine * viewCosine / max((cosine * 0.7 + 0.3) * (viewCosine * 0.7 + 0.3), 0.001);
}

// Exact port of reflectiveGlintAt from deformable-sand/source/render/shaders.ts lines 209-236
// Evaluated in grain-space so glint density & sub-pixel optical radius match deformable-sand at any camera distance
float reflectiveGlintInGrainSpace(
  vec2 grainCoord,
  vec3 normal,
  vec3 towardEye,
  vec3 light,
  float visibility,
  float footprintInGrains,
  float affinity
) {
  float cellSize = 11.16; // 0.0048 / 0.00043 in deformable-sand grain units
  vec2 cell = floor(grainCoord / cellSize);
  vec2 selector = sandHash2(cell + vec2(13.7, 41.3));
  if (selector.x <= 0.992) return 0.0;

  vec2 centerSeed = sandHash2(cell + vec2(73.1, 19.6));
  vec2 center = (cell + 0.12 + centerSeed * 0.76) * cellSize;
  float physicalRadius = mix(0.14, 0.33, selector.y);
  float opticalRadius = max(physicalRadius, footprintInGrains * 1.65);
  float centerDistance = length(grainCoord - center);
  if (centerDistance > opticalRadius) return 0.0;

  vec3 halfway = normalize(light + towardEye);
  float normalHalf = max(dot(normal, halfway), 0.02);
  float tangentHalf = length(cross(normal, halfway));
  float requiredSlope = tangentHalf / normalHalf;
  float slopeSigma = 0.48;
  float facetProbability = exp(-0.5 * requiredSlope * requiredSlope / (slopeSigma * slopeSigma));
  float activationProbability = clamp((0.55 + facetProbability * 0.36) * mix(0.72, 1.08, affinity), 0.0, 0.95);
  vec2 orientationSeed = sandHash2(cell + vec2(151.7, 223.9));
  if (orientationSeed.x > activationProbability) return 0.0;

  float footprint = 1.0 - smoothstep(0.18, 1.0, centerDistance / opticalRadius);
  float shadowed = smoothstep(0.06, 0.52, visibility);
  float intensity = mix(1.8, 3.0, orientationSeed.y) * mix(0.75, 1.15, affinity);
  return footprint * shadowed * intensity;
}

// Sample live GPU deformable sand bed state with seamless radial fade (zero square boundary edges):
// .r = height (m), .g = activity, .ba = transport velocity
vec4 sampleSandBed(vec2 worldXZ) {
  vec2 uv = (worldXZ - uSandCenter) / max(uSandSize, 1.0) + 0.5;
  float rDist = length(uv - 0.5);
  if (rDist >= 0.48) {
    return vec4(0.0);
  }
  float radialFade = 1.0 - smoothstep(0.28, 0.48, rDist);
  return textureLod(uSandBedTex, uv, 0.0) * radialFade;
}

// Sample live GPU BedLighting (14-step raymarched visibility + 8-axis horizon AO + height gradient):
// .r = visibility [0..1], .g = occlusion [0..1], .ba = (heightLeft - heightRight, heightBack - heightFront) / (2 * spacing)
vec4 sampleSandLighting(vec2 worldXZ) {
  vec2 uv = (worldXZ - uSandCenter) / max(uSandSize, 1.0) + 0.5;
  float rDist = length(uv - 0.5);
  if (rDist >= 0.48) {
    return vec4(1.0, 1.0, 0.0, 0.0);
  }
  float w = 1.0 - smoothstep(0.28, 0.48, rDist);
  vec4 raw = textureLod(uSandLightTex, uv, 0.0);
  return vec4(
    mix(1.0, raw.x, w),
    mix(1.0, raw.y, w),
    raw.z * w,
    raw.w * w
  );
}

// Exact filmicGrade S-curve & highlight/shadow split-tone from deformable-sand/source/render/postprocess.ts lines 54-72
vec3 sandFilmicGrade(vec3 color) {
  vec3 mapped = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3(0.0), vec3(1.0));
  float sourceLuma = max(dot(mapped, vec3(0.2126, 0.7152, 0.0722)), 0.0001);
  float contrastCurve = sourceLuma * sourceLuma * (3.0 - 2.0 * sourceLuma);
  float gradedLuma = mix(sourceLuma, contrastCurve, 0.26);
  vec3 graded = mapped * (gradedLuma / sourceLuma);

  vec3 gradedGray = vec3(dot(graded, vec3(0.2126, 0.7152, 0.0722)));
  graded = mix(gradedGray, graded, 0.96);

  float mood = smoothstep(0.12, 0.86, gradedLuma);
  vec3 shadowTone = vec3(0.965, 0.985, 1.025);
  vec3 highlightTone = vec3(1.035, 1.005, 0.955);
  graded *= mix(shadowTone, highlightTone, mood);
  return clamp(graded, vec3(0.0), vec3(1.0));
}

// Complete Deformable-Sand Surface Evaluation (ported from shadeSurface + fragmentMobile in shaders.ts)
// Uses screen-adaptive world-locked Voronoi octaves so every pixel resolves ~1.4-pixel individual sand grains
// exactly like http://127.0.0.1:4173/?example=threejs-procedural-materials%2Fdeformable-sand
vec3 shadeDeformableSand(
  vec3 worldPos,
  vec3 geoNormal,
  vec3 eyePos,
  float externalShadow,
  vec3 causticRGB,
  vec3 directSunIrr,
  vec3 waterAmbient,
  vec2 worldDx,
  vec2 worldDy,
  vec2 fragCoord,
  out vec3 outNormal
) {
  vec3 towardEye = normalize(eyePos - worldPos);
  // 2-step view-ray relief parallax offset so raised rims & excavated trenches have true 3D silhouette & depth!
  vec2 viewStep = (towardEye.xz / max(towardEye.y, 0.36)) * 0.65;
  float h0 = sampleSandBed(worldPos.xz).x;
  float h1 = sampleSandBed(worldPos.xz + viewStep * h0).x;
  vec2 position = worldPos.xz + viewStep * (0.5 * (h0 + h1));

  vec4 lightData = sampleSandLighting(position);
  vec4 sandBed = sampleSandBed(position);

  // Gentle oceanic current sandwave ripples (0.85m wavelength) outside sculpted strokes
  float ripPhase = position.x * 5.2 + sin(position.y * 2.1) * 1.15;
  float bgWaveX = cos(ripPhase) * 0.042;
  float bgWaveZ = sin(ripPhase * 0.45 + position.y * 3.4) * 0.018;
  float undisturbed = 1.0 - clamp(sandBed.y * 2.0 + abs(sandBed.x) * 3.5, 0.0, 1.0);

  // Pure 512x512 heightfield macroNormal (zero 1.25m Surface Nets polygon faceting!)
  vec3 macroNormal = normalize(
    vec3(
      lightData.z * 1.55 + bgWaveX * undisturbed,
      1.0,
      lightData.w * 1.55 + bgWaveZ * undisturbed
    )
  );

  // Isotropic world-space grain scale using max(dx, dy) + zero per-pixel TV-static jitter:
  // Eliminates coarse salt-and-pepper aliasing on oblique planes while resolving crisp ~1.8px mineral grains
  // identical to deformable-sand example-render.jpeg in foreground, fading cleanly into silky sand dunes afar!
  float distCam = length(eyePos - worldPos);
  float maxWorldSpan = max(length(worldDx), length(worldDy));
  float minWorldSpan = min(length(worldDx), length(worldDy));
  float pixelWorldSize = clamp(mix(minWorldSpan, maxWorldSpan, 0.62), 0.0003, 0.25);
  float targetGrainWorldSize = pixelWorldSize * 1.55;
  float octaveExp = log2(max(targetGrainWorldSize / 0.0018, 1.0));
  float oct0 = floor(octaveExp);
  float octBlend = smoothstep(0.18, 0.82, fract(octaveExp));
  float scale0 = 0.0018 * exp2(oct0);
  float scale1 = scale0 * 2.0;

  vec2 coord0 = position / scale0;
  vec2 coord1 = position / scale1 + vec2(37.1, 91.7);
  float footprint0 = pixelWorldSize / scale0;

  // Smooth distance & grazing-angle anti-aliasing: crisp mineral grains in [0..11m], silky sand ripples beyond
  float grazingFade = smoothstep(0.10, 0.34, max(towardEye.y, 0.0));
  float appearanceDetail = (1.0 - smoothstep(10.5, 25.0, distCam) * 0.82) * grazingFade;

  GrainAppearance g0 = grainAppearance(coord0);
  GrainAppearance g1 = grainAppearance(coord1);

  float grainEdge = mix(g0.edge, g1.edge, octBlend);
  float roundness = mix(g0.roundness, g1.roundness, octBlend);

  // Faithful subtle grain facets from deformable-sand/source/render/shaders.ts (restrained so grains stay golden-beige, not static noise)
  vec2 perp0 = vec2(-g0.axis.y, g0.axis.x);
  vec2 rad0 = g0.axis * g0.shapedOffset.x + perp0 * g0.shapedOffset.y;
  vec2 facet0 = rad0 * (0.24 + g0.roundness * 0.34) + (g0.materialSeed - 0.5) * 0.22;

  vec2 perp1 = vec2(-g1.axis.y, g1.axis.x);
  vec2 rad1 = g1.axis * g1.shapedOffset.x + perp1 * g1.shapedOffset.y;
  vec2 facet1 = rad1 * (0.24 + g1.roundness * 0.34) + (g1.materialSeed - 0.5) * 0.22;

  vec2 facet = mix(facet0, facet1, octBlend);
  vec3 normal = normalize(macroNormal + vec3(facet.x, 0.0, facet.y) * appearanceDetail);
  outNormal = normal;

  vec3 light = SAND_LIGHT_DIRECTION;
  vec3 halfway = normalize(light + towardEye);
  float cosine = max(0.0, dot(normal, light));
  float viewCosine = max(0.02, dot(normal, towardEye));

  // Primary shadow is the 14-step raymarched sand bed visibility (lightData.x), with soft kelp canopy dapple (~0.78..1.0)
  float shade = mix(0.76, 1.0, clamp(externalShadow, 0.0, 1.0));
  float visibility = lightData.x * shade;
  float occlusion = lightData.y;

  float comp0 = sandHash2(floor(g0.grainCell / 42.0) + vec2(41.0, 67.0)).x;
  float comp1 = sandHash2(floor(g1.grainCell / 42.0) + vec2(41.0, 67.0)).x;
  SandMaterial mat0 = materialForGrain(g0.materialSeed, comp0);
  SandMaterial mat1 = materialForGrain(g1.materialSeed, comp1);

  vec3 matAlbedo = mix(mat0.albedo, mat1.albedo, octBlend);
  float matRoughness = mix(mat0.roughness, mat1.roughness, octBlend);
  float matTranslucency = mix(mat0.translucency, mat1.translucency, octBlend);
  float matFresnelBase = mix(mat0.fresnelBase, mat1.fresnelBase, octBlend);
  float matSparkle = mix(mat0.sparkleAffinity, mat1.sparkleAffinity, octBlend);

  // Creamy mineral carbonate palette seamlessly harmonizing with underwater limestone & coral
  float microOcclusion = mix(1.0, mix(0.72, 1.0, grainEdge), appearanceDetail);
  vec3 grainAlbedo = matAlbedo * mix(0.76, 1.02, grainEdge);
  vec3 albedo = mix(vec3(0.65, 0.59, 0.46), grainAlbedo, appearanceDetail);

  // Subtle moisture darkening inside deep excavated trenches & warm catchlight on displaced rims
  float trenchDamp = clamp(-sandBed.x * 2.2, 0.0, 1.0);
  float rimLift = clamp(sandBed.x * 2.8, 0.0, 1.0);
  albedo *= mix(1.0, 0.80, trenchDamp);
  albedo *= mix(1.0, 1.08, rimLift);

  float roughness = mix(0.68, matRoughness, appearanceDetail);
  float alphaSquared = pow(roughness, 4.0);
  float normalHalf = max(0.0, dot(normal, halfway));
  float distribution = sandMicrofacetDistribution(alphaSquared, normalHalf);
  float fresnel = matFresnelBase + (1.0 - matFresnelBase) * pow(1.0 - max(0.0, dot(halfway, towardEye)), 5.0);
  float geometry = sandGeometryAttenuation(cosine, viewCosine);
  float specular = distribution * fresnel * geometry / max(4.0 * max(cosine, 0.02) * viewCosine, 0.001);
  float diffuse = cosine * (0.84 + 0.16 * (1.0 - viewCosine));

  // True Underwater Beer-Lambert Sun Irradiance + Shimmering Chromatic Caustics + Water Skylight Fill
  // Keeps every deformable-sand micro-grain, 14-step furrow shadow, and glint crisp inside unified abyssal lighting!
  vec3 softCaustics = causticRGB / (1.0 + causticRGB * 0.55);
  vec3 ambient = max(waterAmbient, vec3(0.06, 0.18, 0.24)) * (0.82 + 0.24 * macroNormal.y) * occlusion * microOcclusion;
  vec3 direct = directSunIrr * (0.48 + 1.35 * softCaustics) * visibility * microOcclusion;
  vec3 reflected = reflect(-towardEye, normal);
  vec3 environmentSpecular = sandEnvironment(reflected, waterAmbient) * fresnel * pow(1.0 - roughness, 2.0) * 0.28 * occlusion * mix(0.55, 1.0, shade);
  vec3 bodyTransmission = albedo * direct * matTranslucency * (0.022 + 0.055 * (1.0 - viewCosine)) * roundness * appearanceDetail;

  float glint0 = reflectiveGlintInGrainSpace(coord0, normal, towardEye, light, visibility, footprint0, matSparkle);
  float glint1 = reflectiveGlintInGrainSpace(coord1, normal, towardEye, light, visibility, footprint0 * 0.5, matSparkle);
  float reflectiveGlint = mix(glint0, glint1, octBlend) * appearanceDetail;

  vec3 radiance = albedo * (ambient + direct * diffuse) + direct * specular * cosine + environmentSpecular + bodyTransmission;

  // Interactive pointer ring on the sand bed (shaders.ts lines 287-289)
  if (uSandPointer.w > 0.01) {
    float ringDistance = abs(length(position - uSandPointer.xy) - uSandPointer.z);
    float ring = (1.0 - smoothstep(0.020, 0.065, ringDistance)) * uSandPointer.w;
    radiance *= 1.0 - 0.18 * ring;
  }

  // Sun-filtered wet mineral micro-sparkles tinted by attenuated underwater sunlight
  vec3 solarTint = clamp(directSunIrr * 1.15, vec3(0.28, 0.55, 0.62), vec3(1.15));
  radiance += solarTint * reflectiveGlint * 0.85;

  return radiance;
}
`;

// ============================================================================
// Pass 1: GPU Deformable Sand Bed Solver (Ported from simulation/shaders.ts)
// Mass-conserving trench evacuation + displaced side/front rims + 8-neighbor
// angle-of-repose avalanche relaxation
// ============================================================================
const DEFORMABLE_SAND_SIM_VS = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DEFORMABLE_SAND_SIM_FS = /* glsl */ `
precision highp float;

uniform sampler2D uPrevSand;
uniform vec2 uShiftUv;
uniform vec2 uCenter;
uniform float uWorldSize;
uniform float uTexelSize;
uniform float uTime;
uniform float uDt;
uniform float uInitialized;
uniform int uContactCount;
uniform vec4 uContactA[8]; // (startX, startZ, radius, pressure)
uniform vec4 uContactB[8]; // (endX, endZ, velX, velZ)

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Initial sand bed heightfield with pre-carved S-curve furrows & displaced rims (matching deformable-sand example-render.jpeg)
float strokeProfile(vec2 p, vec2 a, vec2 b, float radius, float depth, float rimHeight) {
  vec2 seg = b - a;
  float along = clamp(dot(p - a, seg) / max(dot(seg, seg), 1e-5), 0.0, 1.0);
  // Subtle organic curve along the stroke
  vec2 perp = normalize(vec2(-seg.y, seg.x));
  vec2 center = a + along * seg + perp * (sin(along * 3.14159265) * 0.38);
  float d = length(p - center) / radius;
  float env = max(0.0, 1.0 - d * d);
  float trench = -depth * env * env;
  float rim = rimHeight * exp(-pow((d - 1.22) / 0.34, 2.0));
  return trench + rim;
}

float initialBedHeight(vec2 worldXZ) {
  float microNoise = 0.004 * (hash12(floor(worldXZ * 12.0)) - 0.5);
  float subtleWave = 0.012 * sin(worldXZ.x * 1.4 + sin(worldXZ.y * 1.1)) * sin(worldXZ.y * 1.3);

  // Two sculptural, intersecting sand furrows & raised rims right in the foreground of Viewpoint 2
  float s1 = strokeProfile(worldXZ, vec2(-2.8, -6.6), vec2(2.6, -8.2), 0.54, 0.22, 0.135);
  float s2 = strokeProfile(worldXZ, vec2(-1.4, -9.3), vec2(2.1, -6.1), 0.46, 0.19, 0.120);

  return clamp(microNoise + subtleWave + s1 + s2, -0.34, 0.28);
}

void main() {
  vec2 worldXZ = uCenter + (vUv - 0.5) * uWorldSize;
  vec2 prevUv = vUv + uShiftUv;

  float height = 0.0;
  float activity = 0.0;
  vec2 velocity = vec2(0.0);

  bool inBounds = (
    uInitialized > 0.5 &&
    prevUv.x > uTexelSize && prevUv.x < 1.0 - uTexelSize &&
    prevUv.y > uTexelSize && prevUv.y < 1.0 - uTexelSize
  );

  if (!inBounds) {
    height = initialBedHeight(worldXZ);
  } else {
    vec4 center = texture(uPrevSand, prevUv);
    height = center.x;
    activity = center.y;
    velocity = center.zw;

    // 8-neighbor angle-of-repose avalanche relaxation (staticReposeSlope = 0.62, dynamicReposeSlope = 0.44 from config.ts)
    if (activity > 0.015) {
      vec2 offsets[8] = vec2[8](
        vec2(-uTexelSize, 0.0),
        vec2( uTexelSize, 0.0),
        vec2(0.0, -uTexelSize),
        vec2(0.0,  uTexelSize),
        vec2(-uTexelSize, -uTexelSize),
        vec2( uTexelSize, -uTexelSize),
        vec2(-uTexelSize,  uTexelSize),
        vec2( uTexelSize,  uTexelSize)
      );
      float spacing = uWorldSize * uTexelSize;
      float netFlux = 0.0;
      vec2 fluxVec = vec2(0.0);

      for (int axis = 0; axis < 8; axis++) {
        vec4 other = texture(uPrevSand, prevUv + offsets[axis]);
        float linkLen = (axis >= 4) ? 1.41421356 : 1.0;
        float weight = (axis >= 4) ? 0.04166 : 0.16667;
        float localAct = clamp(max(activity, other.y) * 4.0, 0.0, 1.0);
        float friction = mix(0.62, 0.44, localAct);
        float threshold = friction * spacing * linkLen;
        float diff = other.x - height;
        if (abs(diff) > threshold) {
          float excess = sign(diff) * (abs(diff) - threshold);
          float supercrit = smoothstep(spacing * 0.05, spacing * 0.20, abs(excess));
          float stepFlow = excess * weight * (0.28 + 0.35 * supercrit);
          netFlux += stepFlow;
          fluxVec += normalize(offsets[axis]) * stepFlow;
        }
      }
      height += netFlux;
      activity = max(activity * exp(-uDt * 3.5), abs(netFlux) * 8.0);
      velocity = mix(velocity * 0.85, fluxVec * 10.0, 0.35);
    } else {
      activity *= exp(-uDt * 3.5);
      velocity *= 0.85;
    }
  }

  // Tool Contact Excavation & Rim Escape Pile-Up (simulation/shaders.ts lines 44-170)
  for (int i = 0; i < 8; i++) {
    if (i >= uContactCount) break;
    vec4 cA = uContactA[i];
    vec4 cB = uContactB[i];
    vec2 seg = cB.xy - cA.xy;
    float segLenSq = max(dot(seg, seg), 1e-6);
    float along = clamp(dot(worldXZ - cA.xy, seg) / segLenSq, 0.0, 1.0);
    vec2 closest = cA.xy + along * seg;
    vec2 offset = worldXZ - closest;
    float radius = max(cA.z, 0.22);
    float dist = length(offset) / radius;

    if (dist < 1.85) {
      float pressure = cA.w;
      vec2 motion = cB.zw;
      float speed = length(motion);
      vec2 motionDir = (speed > 1e-4) ? (motion / speed) : normalize(seg + vec2(1e-4, 0.0));
      vec2 radialDir = (length(offset) > 1e-5) ? normalize(offset) : motionDir;

      // 1. Interior parabolic trench indentation
      float envelope = max(0.0, 1.0 - dist * dist);
      float coverage = envelope * envelope;
      float targetTrench = -0.24 * pressure * coverage;
      if (coverage > 0.01) {
        float dig = max(0.0, height - targetTrench) * (0.72 * coverage);
        height -= dig;
      }

      // 2. Displaced rim pile-up around stroke perimeter (escapeWeight in simulation/shaders.ts lines 149-158)
      float forward = max(0.0, dot(radialDir, motionDir));
      float sideways = 1.0 - abs(dot(radialDir, motionDir));
      float rimBand = exp(-pow((dist - 1.20) / 0.33, 2.0));
      float speedBoost = speed / (speed + 0.45);
      float rimDeposit = 0.095 * pressure * rimBand * (0.65 + 0.60 * sideways + 0.85 * forward * speedBoost);
      height += rimDeposit;

      float shell = 1.0 - smoothstep(0.85, 1.65, dist);
      activity = max(activity, shell * pressure);
      velocity = mix(velocity, motion * coverage, 0.45 * shell);
    }
  }

  height = clamp(height, -0.35, 0.30);
  fragColor = vec4(height, clamp(activity, 0.0, 1.0), velocity);
}
`;

// ============================================================================
// Pass 2: GPU Bed Horizon Lighting & 8-Direction Ambient Occlusion
// Direct Port of deformable-sand/source/render/lighting.ts (lines 19-57)
// Outputs vec4(visibility, occlusion, dHdx, dHdz)
// ============================================================================
const DEFORMABLE_SAND_LIGHT_FS = /* glsl */ `
precision highp float;

uniform sampler2D uSandTex;
uniform float uWorldSize;
uniform float uTexelSize;
uniform vec3 uLightDir;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

float sampleHeightUv(vec2 uv) {
  return texture(uSandTex, clamp(uv, vec2(0.001), vec2(0.999))).x;
}

void main() {
  float spacing = uWorldSize * uTexelSize;
  float height = sampleHeightUv(vUv);

  float hLeft  = sampleHeightUv(vUv - vec2(uTexelSize, 0.0));
  float hRight = sampleHeightUv(vUv + vec2(uTexelSize, 0.0));
  float hBack  = sampleHeightUv(vUv - vec2(0.0, uTexelSize));
  float hFront = sampleHeightUv(vUv + vec2(0.0, uTexelSize));

  vec2 gradient = vec2(hRight - hLeft, hFront - hBack) / (2.0 * spacing);
  vec3 light = normalize(uLightDir);

  // 14-step directional raymarched self-shadowing (lighting.ts lines 29-36)
  float visibility = 1.0;
  for (int sampleIndex = 1; sampleIndex <= 14; sampleIndex++) {
    float fi = float(sampleIndex);
    float dist = spacing * (0.65 * fi + 0.18 * fi * fi);
    vec2 probeUv = vUv + (light.xz * dist) / uWorldSize;
    if (probeUv.x < 0.0 || probeUv.x > 1.0 || probeUv.y < 0.0 || probeUv.y > 1.0) break;
    float blocker = sampleHeightUv(probeUv) - height - light.y * dist * 0.36;
    visibility = min(
      visibility,
      1.0 - smoothstep(-0.004 - dist * 0.012, 0.010 + dist * 0.032, blocker)
    );
  }

  // 8-direction x 6-radius horizon-angle ambient occlusion (lighting.ts lines 37-56)
  vec2 directions[8] = vec2[8](
    vec2( 1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0,  1.0), vec2(0.0, -1.0),
    vec2( 0.70710678,  0.70710678), vec2(-0.70710678, -0.70710678),
    vec2( 0.70710678, -0.70710678), vec2(-0.70710678,  0.70710678)
  );
  float radii[6] = float[6](1.0, 2.0, 3.5, 6.0, 10.0, 16.0);
  float obscured = 0.0;
  for (int axis = 0; axis < 8; axis++) {
    vec2 dir = directions[axis];
    float tangentAngle = atan(dot(gradient * 1.35, dir));
    float horizon = 0.0;
    for (int s = 0; s < 6; s++) {
      float r = radii[s];
      float dist = r * spacing;
      vec2 probeUv = vUv + dir * (r * uTexelSize);
      float hProbe = sampleHeightUv(probeUv);
      float angle = atan(((hProbe - height) * 1.35 - 0.002) / dist);
      horizon = max(horizon, angle - tangentAngle);
    }
    float blocked = sin(min(horizon, 1.57079633));
    obscured += blocked * blocked;
  }
  float occlusion = clamp(1.0 - obscured / 8.0, 0.0, 1.0);

  // Store (hLeft - hRight)/(2*spacing) and (hBack - hFront)/(2*spacing) in .zw for macroNormal
  fragColor = vec4(visibility, occlusion, -gradient.x, -gradient.y);
}
`;

export class DeformableSandSystem {
  constructor(renderer, sharedUniforms, { resolution = 512, worldSize = 32.0 } = {}) {
    this.renderer = renderer;
    this.sharedUniforms = sharedUniforms;
    this.resolution = resolution;
    this.worldSize = worldSize;
    this.center = new THREE.Vector2(0.0, -8.5);
    this.initialized = false;

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

    this.rtA = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);
    this.rtLight = new THREE.WebGLRenderTarget(resolution, resolution, rtOpts);

    this.contactA = Array.from({ length: 8 }, () => new THREE.Vector4());
    this.contactB = Array.from({ length: 8 }, () => new THREE.Vector4());
    this.pointerRing = new THREE.Vector4(0, 0, 0.55, 0);

    this.simMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrevSand: { value: null },
        uShiftUv: { value: new THREE.Vector2(0, 0) },
        uCenter: { value: this.center.clone() },
        uWorldSize: { value: worldSize },
        uTexelSize: { value: 1.0 / resolution },
        uTime: { value: 0 },
        uDt: { value: 0.016 },
        uInitialized: { value: 0.0 },
        uContactCount: { value: 0 },
        uContactA: { value: this.contactA },
        uContactB: { value: this.contactB },
      },
      vertexShader: DEFORMABLE_SAND_SIM_VS,
      fragmentShader: DEFORMABLE_SAND_SIM_FS,
    });

    this.lightMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSandTex: { value: null },
        uWorldSize: { value: worldSize },
        uTexelSize: { value: 1.0 / resolution },
        uLightDir: { value: SAND_LIGHT_DIR.clone() },
      },
      vertexShader: DEFORMABLE_SAND_SIM_VS,
      fragmentShader: DEFORMABLE_SAND_LIGHT_FS,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.pointerStrokes = [];
    this.lastPointerHit = null;
    this.lastPointerTime = -10.0;
    this.lastDiverPos = new THREE.Vector2();
    this.hasLastDiver = false;
    this.lastSharkPos = new THREE.Vector2();
    this.hasLastShark = false;

    this._initSaltatingGrains(sharedUniforms);
  }

  get texture() {
    return this.rtA.texture;
  }

  get lightTexture() {
    return this.rtLight.texture;
  }

  // Port of grainVertex / grainFragment from deformable-sand/source/render/shaders.ts (lines 350-415)
  _initSaltatingGrains(sharedUniforms) {
    this.maxGrains = 2048;
    this.grainCursor = 0;

    const baseGeo = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = baseGeo.index;
    geo.attributes.position = baseGeo.attributes.position;
    geo.attributes.uv = baseGeo.attributes.uv;
    geo.instanceCount = this.maxGrains;

    this.grainPosArray = new Float32Array(this.maxGrains * 4);
    this.grainVelArray = new Float32Array(this.maxGrains * 4);
    this.grainFloorY = new Float32Array(this.maxGrains);

    this.grainPosAttr = new THREE.InstancedBufferAttribute(this.grainPosArray, 4);
    this.grainPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.grainVelAttr = new THREE.InstancedBufferAttribute(this.grainVelArray, 4);
    this.grainVelAttr.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('iGrainPos', this.grainPosAttr);
    geo.setAttribute('iGrainVel', this.grainVelAttr);

    const vs = /* glsl */ `
      attribute vec4 iGrainPos;
      attribute vec4 iGrainVel;

      uniform vec3 uCamPos;
      uniform vec3 uCamRight;
      uniform vec3 uCamUp;
      uniform vec3 uCamFwd;

      out vec2 vLocal;
      out float vTint;
      out float vTrailRatio;
      out vec2 vAxis;
      out vec3 vWPos;
      out float vActive;

      void main() {
        float physicalRadius = iGrainPos.w;
        if (physicalRadius <= 0.0001) {
          vActive = 0.0;
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vActive = 1.0;

        vec3 rel = iGrainPos.xyz - uCamPos;
        float camDepth = max(dot(rel, uCamFwd), 0.1);
        float worldPerPixel = 0.0012 * camDepth;
        float renderRadius = max(physicalRadius, worldPerPixel * 0.85);

        vec2 camVel = vec2(dot(iGrainVel.xyz, uCamRight), dot(iGrainVel.xyz, uCamUp));
        float projSpeed = length(camVel);
        vec2 axis = (projSpeed > 1e-4) ? (camVel / projSpeed) : vec2(1.0, 0.0);
        vec2 side = vec2(-axis.y, axis.x);

        float shutter = 0.016;
        float halfTrail = min(projSpeed * shutter * 0.5, renderRadius * 3.0);
        float extent = renderRadius + halfTrail;

        vec2 corner = position.xy;
        vec2 camOffset = axis * (corner.x * extent) + side * (corner.y * renderRadius);
        vec3 wp = iGrainPos.xyz + uCamRight * camOffset.x + uCamUp * camOffset.y;

        vLocal = vec2(corner.x * extent / max(renderRadius, 1e-6), corner.y);
        vTint = iGrainVel.w;
        vTrailRatio = halfTrail / max(renderRadius, 1e-6);
        vAxis = axis;
        vWPos = wp;

        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `;

    const fs = /* glsl */ `
      precision highp float;

      uniform vec3 uCamPos;
      uniform vec3 uCamRight;
      uniform vec3 uCamUp;
      uniform vec3 uCamFwd;

      in vec2 vLocal;
      in float vTint;
      in float vTrailRatio;
      in vec2 vAxis;
      in vec3 vWPos;
      in float vActive;

      layout(location = 0) out vec4 fragColor;

      void main() {
        if (vActive < 0.5) discard;
        float excess = max(abs(vLocal.x) - vTrailRatio, 0.0);
        vec2 local = vec2(sign(vLocal.x) * excess, vLocal.y);
        float squared = dot(local, local);
        if (squared > 1.0) discard;

        float sphereDepth = sqrt(max(0.0, 1.0 - squared));
        vec3 axisWorld = uCamRight * vAxis.x + uCamUp * vAxis.y;
        vec3 sideWorld = uCamRight * (-vAxis.y) + uCamUp * vAxis.x;
        vec3 normal = normalize(axisWorld * local.x + sideWorld * local.y - uCamFwd * sphereDepth);

        vec3 light = vec3(0.58319, 0.54410, -0.60336);
        vec3 towardEye = normalize(uCamPos - vWPos);
        vec3 halfway = normalize(light + towardEye);
        float diffuse = max(0.0, dot(normal, light));
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(halfway, towardEye)), 5.0);
        float sparkle = pow(max(0.0, dot(normal, halfway)), 36.0) * fresnel;

        vec3 albedo = mix(vec3(0.44, 0.40, 0.31), vec3(0.76, 0.71, 0.57), vTint);
        vec3 uwSun = vec3(0.24, 0.68, 0.80);
        vec3 uwAmb = vec3(0.06, 0.22, 0.30);
        vec3 col = albedo * (uwAmb + uwSun * (0.35 + 1.35 * diffuse)) + vec3(0.45, 0.80, 0.86) * sparkle * 0.45;
        float profile = 1.0 - smoothstep(0.32, 1.0, squared);
        float alpha = min(0.92, profile * 0.88);
        fragColor = vec4(col, alpha);
      }
    `;

    this.grainMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uCamPos: sharedUniforms.uCamPos,
        uCamRight: sharedUniforms.uCamRight,
        uCamUp: sharedUniforms.uCamUp,
        uCamFwd: sharedUniforms.uCamFwd,
      },
      vertexShader: vs,
      fragmentShader: fs,
    });

    this.grainMesh = new THREE.Mesh(geo, this.grainMat);
    this.grainMesh.frustumCulled = false;
    this.grainMesh.renderOrder = 4;
  }

  spawnSaltatingGrains(worldX, worldY, worldZ, vx, vz, count = 28, radius = 0.55) {
    for (let i = 0; i < count; i++) {
      const idx = this.grainCursor;
      this.grainCursor = (this.grainCursor + 1) % this.maxGrains;
      const i4 = idx * 4;

      const ang = Math.random() * Math.PI * 2.0;
      const r = Math.sqrt(Math.random()) * radius * 0.85;
      const gx = worldX + Math.cos(ang) * r;
      const gz = worldZ + Math.sin(ang) * r;
      const gy = worldY + 0.02 + Math.random() * 0.05;

      this.grainPosArray[i4] = gx;
      this.grainPosArray[i4 + 1] = gy;
      this.grainPosArray[i4 + 2] = gz;
      this.grainPosArray[i4 + 3] = 0.008 + Math.random() * 0.010;

      const spreadX = (Math.random() - 0.5) * 1.4;
      const spreadZ = (Math.random() - 0.5) * 1.4;
      this.grainVelArray[i4] = vx * 0.45 + spreadX;
      this.grainVelArray[i4 + 1] = 0.55 + Math.random() * 1.15;
      this.grainVelArray[i4 + 2] = vz * 0.45 + spreadZ;
      this.grainVelArray[i4 + 3] = Math.random();

      this.grainFloorY[idx] = worldY;
    }
    this.grainPosAttr.needsUpdate = true;
    this.grainVelAttr.needsUpdate = true;
  }

  addPointerStroke(worldX, worldY, worldZ, radius = 0.52, pressure = 0.92) {
    const now = performance.now() * 0.001;
    let startX = worldX;
    let startZ = worldZ;
    let vx = 0.0;
    let vz = 0.0;

    if (this.lastPointerHit && now - this.lastPointerTime < 0.28) {
      const dt = Math.max(0.008, now - this.lastPointerTime);
      startX = this.lastPointerHit.x;
      startZ = this.lastPointerHit.z;
      vx = (worldX - startX) / dt;
      vz = (worldZ - startZ) / dt;
    } else {
      vx = 0.4;
      vz = 0.4;
    }

    this.lastPointerHit = { x: worldX, z: worldZ };
    this.lastPointerTime = now;
    this.pointerRing.set(worldX, worldZ, radius, 1.0);

    this.pointerStrokes.push({
      startX,
      startZ,
      endX: worldX,
      endZ: worldZ,
      radius,
      pressure,
      vx: Math.max(-8.0, Math.min(8.0, vx * 0.18)),
      vz: Math.max(-8.0, Math.min(8.0, vz * 0.18)),
    });
    if (this.pointerStrokes.length > 6) {
      this.pointerStrokes.shift();
    }

    this.spawnSaltatingGrains(worldX, worldY, worldZ, vx * 0.14, vz * 0.14, 32, radius);
  }

  update(dt, elapsed, cameraPos, terrain, sharkRig, whalePod) {
    const step = this.worldSize / this.resolution;
    if (!this.initialized) {
      this.center.set(
        Math.round(cameraPos.x / step) * step,
        Math.round(cameraPos.z / step) * step
      );
    }

    const targetX = Math.round(cameraPos.x / step) * step;
    const targetZ = Math.round(cameraPos.z / step) * step;
    const dx = targetX - this.center.x;
    const dz = targetZ - this.center.y;
    this.center.set(targetX, targetZ);

    this.pointerRing.w = Math.max(0.0, this.pointerRing.w - dt * 1.8);

    let cIdx = 0;
    while (this.pointerStrokes.length > 0 && cIdx < 5) {
      const s = this.pointerStrokes.shift();
      this.contactA[cIdx].set(s.startX, s.startZ, s.radius, s.pressure);
      this.contactB[cIdx].set(s.endX, s.endZ, s.vx, s.vz);
      cIdx++;
    }

    // Diver / Camera proximity contact when swimming near the sandy seabed
    if (terrain && cIdx < 8) {
      const floorY = terrain.gy(cameraPos.x, cameraPos.z);
      const clearance = cameraPos.y - floorY;
      if (clearance > -0.5 && clearance < 3.8) {
        const prox = 1.0 - Math.max(0.0, clearance) / 3.8;
        const sx = this.hasLastDiver ? this.lastDiverPos.x : cameraPos.x;
        const sz = this.hasLastDiver ? this.lastDiverPos.y : cameraPos.z;
        const vx = (cameraPos.x - sx) / Math.max(dt, 0.008);
        const vz = (cameraPos.z - sz) / Math.max(dt, 0.008);
        if (Math.hypot(vx, vz) > 0.15) {
          this.contactA[cIdx].set(sx, sz, 0.58, prox * 0.85);
          this.contactB[cIdx].set(cameraPos.x, cameraPos.z, vx * 0.16, vz * 0.16);
          cIdx++;
          if (Math.random() < 0.45) {
            this.spawnSaltatingGrains(cameraPos.x, floorY, cameraPos.z, vx * 0.12, vz * 0.12, 8, 0.55);
          }
        }
      }
      this.lastDiverPos.set(cameraPos.x, cameraPos.z);
      this.hasLastDiver = true;
    }

    // Patrol Shark proximity sand wake
    if (terrain && sharkRig && sharkRig.sharkMesh && cIdx < 8) {
      const sp = sharkRig.sharkMesh.position;
      const floorY = terrain.gy(sp.x, sp.z);
      const clearance = sp.y - floorY;
      if (clearance > -0.5 && clearance < 4.5) {
        const prox = 1.0 - Math.max(0.0, clearance) / 4.5;
        const sx = this.hasLastShark ? this.lastSharkPos.x : sp.x;
        const sz = this.hasLastShark ? this.lastSharkPos.y : sp.z;
        const vx = (sp.x - sx) / Math.max(dt, 0.008);
        const vz = (sp.z - sz) / Math.max(dt, 0.008);
        this.contactA[cIdx].set(sx, sz, 0.68, prox * 0.78);
        this.contactB[cIdx].set(sp.x, sp.z, vx * 0.15, vz * 0.15);
        cIdx++;
      }
      this.lastSharkPos.set(sp.x, sp.z);
      this.hasLastShark = true;
    }

    // Pass 1: Step mass-conserving sand heightfield & rim pile-up
    this.quad.material = this.simMat;
    this.simMat.uniforms.uPrevSand.value = this.rtA.texture;
    this.simMat.uniforms.uShiftUv.value.set(dx / this.worldSize, dz / this.worldSize);
    this.simMat.uniforms.uCenter.value.copy(this.center);
    this.simMat.uniforms.uTime.value = elapsed;
    this.simMat.uniforms.uDt.value = dt;
    this.simMat.uniforms.uContactCount.value = cIdx;
    this.simMat.uniforms.uInitialized.value = this.initialized ? 1.0 : 0.0;

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.render(this.scene, this.camera);

    const tmp = this.rtA;
    this.rtA = this.rtB;
    this.rtB = tmp;
    this.initialized = true;

    // Pass 2: Compute 14-step raymarched visibility & 8-axis horizon ambient occlusion (lighting.ts)
    this.quad.material = this.lightMat;
    this.lightMat.uniforms.uSandTex.value = this.rtA.texture;
    this.renderer.setRenderTarget(this.rtLight);
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(prevTarget);

    // Step saltating sand grains physics
    let dirtyGrains = false;
    const drag = Math.exp(-dt * 2.2);
    for (let i = 0; i < this.maxGrains; i++) {
      const i4 = i * 4;
      const rad = this.grainPosArray[i4 + 3];
      if (rad <= 0.0001) continue;
      dirtyGrains = true;

      this.grainVelArray[i4] *= drag;
      this.grainVelArray[i4 + 1] = this.grainVelArray[i4 + 1] * drag - 3.4 * dt;
      this.grainVelArray[i4 + 2] *= drag;

      this.grainPosArray[i4] += this.grainVelArray[i4] * dt;
      this.grainPosArray[i4 + 1] += this.grainVelArray[i4 + 1] * dt;
      this.grainPosArray[i4 + 2] += this.grainVelArray[i4 + 2] * dt;

      if (this.grainPosArray[i4 + 1] <= this.grainFloorY[i] + 0.008) {
        this.grainPosArray[i4 + 3] = 0.0;
      }
    }
    if (dirtyGrains) {
      this.grainPosAttr.needsUpdate = true;
      this.grainVelAttr.needsUpdate = true;
    }
  }
}
