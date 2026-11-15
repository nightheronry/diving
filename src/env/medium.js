import * as THREE from 'three';
import { DEFORMABLE_SAND_GLSL } from './deformable-sand.js';

// ============================================================================
// Shared Underwater Optical Medium ("Design Tokens")
// Ported from abyssal-garden's W_DETAIL, W_WATER, S_G, and S_B shaders
// ============================================================================

export const SUN_DIR = new THREE.Vector3(0.32, 0.91, -0.26).normalize();
export const AIR_SUN_DIR = new THREE.Vector3(-0.42, 0.44, -0.79).normalize();

export const WORLD_BOUNDS = {
  NX: 192,
  NY: 48,
  NZ: 192,
  VS: 1.25,
  OX: -120,
  OY: -52,
  OZ: -120,
  SIZE_X: 240,
  SIZE_Y: 60,
  SIZE_Z: 240,
};

export function createSharedUniforms() {
  return {
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
    uWaveHeight: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uAirSunDir: { value: AIR_SUN_DIR.clone() },
    uDetailTex: { value: null },
    uWaterTex: { value: null },
    uShadowTex: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowSize: { value: 2048.0 },
    uZoneMapTex: { value: null },
    uVolTex: { value: null },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uSwimPhase: { value: 0 },
    uWhalePhase: { value: 0 },
    uWhaleWake0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWhaleWake1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCausticTex: { value: null },
    uRippleTex: { value: null },
    uRippleCenter: { value: new THREE.Vector2(0, 0) },
    uRippleSize: { value: 96.0 },
    uRefractTex: { value: null },
    uRefractDepth: { value: null },
    uSandBedTex: { value: null },
    uSandLightTex: { value: null },
    uSandCenter: { value: new THREE.Vector2(0.0, -8.0) },
    uSandSize: { value: 32.0 },
    uSandPointer: { value: new THREE.Vector4(0, 0, 0.85, 0) },
    uInvProjMatrix: { value: new THREE.Matrix4() },
    uViewMatrix: { value: new THREE.Matrix4() },
    uProjMatrix: { value: new THREE.Matrix4() },
    uCameraWorldMatrix: { value: new THREE.Matrix4() },
  };
}

// ============================================================================
// Shared GLSL ES 3.00 Library used by ALL scene shaders
// ============================================================================
export const MEDIUM_GLSL = /* glsl */ `
precision highp sampler3D;

uniform float uTime;
uniform vec3 uCamPos;
uniform float uWaveHeight;
uniform vec3 uSunDir;
uniform vec3 uAirSunDir;
uniform sampler2D uDetailTex;
uniform sampler2D uWaterTex;
uniform sampler2D uCausticTex;
uniform sampler2D uRippleTex;
uniform vec2 uRippleCenter;
uniform float uRippleSize;
uniform sampler2D uRefractTex;
uniform sampler2D uRefractDepth;
uniform sampler2D uSandBedTex;
uniform sampler2D uSandLightTex;
uniform vec2 uSandCenter;
uniform float uSandSize;
uniform vec4 uSandPointer;
uniform mat4 uInvProjMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uProjMatrix;
uniform mat4 uCameraWorldMatrix;
uniform sampler2D uShadowTex;
uniform mat4 uShadowMatrix;
uniform float uShadowSize;
uniform sampler2D uZoneMapTex;
uniform sampler3D uVolTex;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uSwimPhase;
uniform float uWhalePhase;
uniform vec4 uWhaleWake0;
uniform vec4 uWhaleWake1;

const vec3 SIG  = vec3(0.030, 0.0120, 0.0092);
const vec3 KD   = vec3(0.042, 0.0180, 0.0125);
const vec3 WCOL = vec3(0.16, 0.58, 0.90);
const vec3 KDZ  = vec3(0.024, 0.0160, 0.0120);
const vec3 PCOL = vec3(0.58, 0.66, 0.98);
const vec3 KDF  = vec3(0.032, 0.0330, 0.0300);
const vec3 SUNC = vec3(1.70, 1.60, 1.45);
const float TAU = 6.2831853;

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, vec3(0.0), vec3(1.0)); }
float ss(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float hs(float x) {
  return fract(sin(x * 127.1) * 43758.5453);
}

vec3 kd(float z) { return mix(KD, KDZ, z); }
vec3 sg(float z) { return mix(SIG, vec3(0.019, 0.013, 0.010), z); }

// uVolTex: .r = SDF openness (0.5 - d/12), .g = propagated skylight, .b = local cavity, .a = kelp canopy
vec4 vol(vec3 p) {
  vec3 uvw = clamp((p - vec3(-120.0, -52.0, -120.0)) / vec3(240.0, 60.0, 240.0), vec3(0.0), vec3(1.0));
  return textureLod(uVolTex, uvw, 0.0);
}

// uZoneMapTex: .r = magAt (magenta cover), .g = kelp canopy, .b = zoneP (purple grotto), .a = sand mask
vec4 zone(vec2 xz) {
  vec2 uv = clamp((xz - vec2(-120.0)) / 240.0, vec2(0.0), vec2(1.0));
  return textureLod(uZoneMapTex, uv, 0.0);
}

float zone(vec3 p) {
  return zone(p.xz).b;
}

vec3 fogIn(vec3 ro, vec3 rd, float d, float z, vec3 sun) {
  vec3 k = mix(KD, KDF, z);
  vec3 a = max(sg(z) - k * rd.y, vec3(0.004));
  vec3 I = (1.0 - exp(-a * d)) / a;
  float mu = max(dot(rd, sun), 0.0);
  float m2 = mu * mu;
  float roY = min(ro.y, 0.0);
  return mix(WCOL, PCOL, z) * sg(z) * exp(k * roY) * I * (0.76 + 0.22 * m2 * m2);
}

vec3 sunE(float y, float z) {
  return SUNC * exp(kd(z) * (min(y, 0.0) / max(uSunDir.y, 0.2))) * (0.50 + 0.50 * sat(-y / 30.0));
}

vec3 sunE(vec3 p) {
  return sunE(p.y, zone(p));
}

vec3 amb(vec3 p, vec3 n, float sky, float z) {
  float up = n.y * 0.5 + 0.5;
  return mix(vec3(0.22, 0.60, 0.80), vec3(0.34, 0.56, 0.82), z)
    * exp(kd(z) * min(p.y, 0.0) * 1.2)
    * (0.30 + 0.70 * sky)
    * (0.24 + 0.76 * up * up)
    * 1.30
    * (0.55 + 0.45 * sat(-p.y / 30.0))
    + vec3(0.003, 0.010, 0.016);
}

vec3 amb(vec3 p, vec3 n) {
  vec4 v = vol(p);
  return amb(p, n, v.g, zone(p));
}

vec3 sideLight(vec3 p, vec3 n, float open, float z) {
  return mix(WCOL, PCOL, z) * exp(kd(z) * min(p.y, 0.0)) * open * (1.0 - abs(n.y)) * 0.70;
}

vec3 sideLight(vec3 p, vec3 n) {
  vec4 v = vol(p);
  return sideLight(p, n, sat((v.r - 0.5) * 2.7), zone(p));
}

vec3 fog(vec3 c, vec3 wp, float z) {
  vec3 v = wp - uCamPos;
  float d = max(length(v), 1e-4);
  vec3 rd = v / d;

  // Underwater medium extinction & in-scattering (matches fsB background at d >= 230m)
  vec3 T = exp(-sg(z) * d) * ss(230.0, 185.0, d);
  float rayOpen = 0.58 + 0.42 * vol(uCamPos + rd * min(d, 150.0)).g;
  vec3 uwCol = c * T + fogIn(uCamPos, rd, min(d, 240.0), z * 0.25, uSunDir) * rayOpen;

  if (uCamPos.y > uWaveHeight - 0.15) {
    float camAirBlend = ss(uWaveHeight - 0.15, uWaveHeight + 0.15, uCamPos.y);
    // Downwelling leg attenuation for submerged surfaces captured into uRefractTex (submerged-snell-ocean line 736)
    float subDepth = max(0.0, uWaveHeight - wp.y);
    float subMask = ss(-0.08, 0.35, uWaveHeight - wp.y);
    vec3 subTrans = exp(-sg(z) * (subDepth * 0.85));
    vec3 subScatter = mix(vec3(0.024, 0.26, 0.38), vec3(0.006, 0.08, 0.18), ss(0.0, 22.0, subDepth));
    vec3 colThroughWater = mix(c, c * subTrans + subScatter * (1.0 - subTrans), subMask);

    float airFog = 1.0 - exp(-d * 0.0007);
    vec3 skyTint = vec3(0.18, 0.52, 0.86);
    vec3 airCol = mix(colThroughWater, skyTint, airFog * 0.55);
    return mix(uwCol, airCol, camAirBlend);
  }
  return uwCol;
}

vec3 fog(vec3 c, vec3 wp) {
  return fog(c, wp, zone(wp));
}

vec3 fin(vec3 rd) {
  vec3 p = uCamPos + rd * 240.0;
  return fog(vec3(0.0), p, zone(p));
}

vec2 cuv(vec3 p) {
  return p.xz - uSunDir.xz * (p.y / max(uSunDir.y, 0.15));
}

// 3-channel Chromatic Differential-Area Caustics + Interactive Ripple Laplacian Lensing
// (Combines submerged-snell-ocean caustics.ts, photoreal-water.js, and interactive-pool-volume)
vec3 causRGB(vec3 p, float d) {
  if (p.y > 0.2) return vec3(0.33);
  vec2 q = cuv(p);
  vec2 o = vec2(0.0042, 0.0026);
  vec3 a = vec3(
    texture(uWaterTex, q / 3.3 + o).r,
    texture(uWaterTex, q / 3.3).r,
    texture(uWaterTex, q / 3.3 - o).r
  );
  float b = texture(uWaterTex, q.yx / 6.9 + 0.37).r;
  vec3 diffCaus = texture(uCausticTex, q / 28.0).rgb;
  vec3 c = min((pow(a, vec3(2.15)) * 3.8 * (0.45 + b * 1.25) + diffCaus * 1.45), vec3(3.9));

  // First-order lensing from local interactive ripple curvature (photoreal-water.js line 469)
  vec2 ruv = (q - uRippleCenter) / max(uRippleSize, 1.0) + 0.5;
  if (ruv.x > 0.02 && ruv.x < 0.98 && ruv.y > 0.02 && ruv.y < 0.98) {
    float lap = texture(uRippleTex, ruv).a;
    float depthHere = clamp(-p.y, 0.0, 26.0);
    c *= clamp(1.0 / (1.0 + 0.065 * depthHere * lap), 0.65, 2.20);
  }

  // Pixel-footprint anti-moire fade (submerged-snell-ocean caustics.ts)
  float heightGap = max(abs(uCamPos.y - p.y), 0.6);
  float footprint = (d * d * 0.0012) / heightGap;
  float fade = clamp(ss(32.0, 96.0, d) + ss(0.12, 0.48, footprint) * 0.65, 0.0, 1.0);
  return mix(c, vec3(0.33), fade);
}

vec3 causRGB(vec3 p) {
  return causRGB(p, length(p - uCamPos));
}

float caus2(vec3 p, float d) {
  if (p.y > 0.2) return 0.33;
  vec2 q = cuv(p);
  float a = texture(uWaterTex, q / 4.1).r;
  float b = texture(uWaterTex, q.yx / 6.9 + 0.37).r;
  float diffG = texture(uCausticTex, q / 28.0).g;
  float c = min(pow(a, 1.4) * 2.1 * (0.45 + b * 1.25) + diffG * 0.95, 2.7);

  vec2 ruv = (q - uRippleCenter) / max(uRippleSize, 1.0) + 0.5;
  if (ruv.x > 0.02 && ruv.x < 0.98 && ruv.y > 0.02 && ruv.y < 0.98) {
    float lap = texture(uRippleTex, ruv).a;
    float depthHere = clamp(-p.y, 0.0, 26.0);
    c *= clamp(1.0 / (1.0 + 0.065 * depthHere * lap), 0.65, 2.20);
  }

  float heightGap = max(abs(uCamPos.y - p.y), 0.6);
  float footprint = (d * d * 0.0012) / heightGap;
  float fade = clamp(ss(32.0, 96.0, d) + ss(0.12, 0.48, footprint) * 0.65, 0.0, 1.0);
  return mix(c, 0.33, fade);
}

float caus(vec3 p) {
  return caus2(p, length(p - uCamPos));
}

vec3 shadowUV(vec3 p) {
  vec4 s = uShadowMatrix * vec4(p, 1.0);
  return (s.xyz / max(s.w, 1e-4)) * 0.5 + 0.5;
}

float shadow1(vec3 p) {
  vec3 s = shadowUV(p);
  if (s.x < 0.001 || s.x > 0.999 || s.y < 0.001 || s.y > 0.999 || s.z > 1.0 || s.z < 0.0) return 1.0;
  float d = textureLod(uShadowTex, s.xy, 0.0).r;
  return step(s.z - 0.0018, d);
}

float shadow4(vec3 p) {
  vec3 s = shadowUV(p);
  if (s.x < 0.002 || s.x > 0.998 || s.y < 0.002 || s.y > 0.998 || s.z > 1.0 || s.z < 0.0) return 1.0;
  float e = 1.8 / uShadowSize;
  float acc = 0.0;
  acc += step(s.z - 0.0018, textureLod(uShadowTex, s.xy + vec2(-e, -e), 0.0).r);
  acc += step(s.z - 0.0018, textureLod(uShadowTex, s.xy + vec2( e, -e), 0.0).r);
  acc += step(s.z - 0.0018, textureLod(uShadowTex, s.xy + vec2(-e,  e), 0.0).r);
  acc += step(s.z - 0.0018, textureLod(uShadowTex, s.xy + vec2( e,  e), 0.0).r);
  return acc * 0.25;
}

float shadow9(vec3 p) {
  vec3 s = shadowUV(p);
  if (s.x < 0.003 || s.x > 0.997 || s.y < 0.003 || s.y > 0.997 || s.z > 1.0 || s.z < 0.0) return 1.0;
  float e = 2.1 / uShadowSize;
  float acc = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float d = textureLod(uShadowTex, s.xy + vec2(float(x), float(y)) * e, 0.0).r;
      acc += step(s.z - 0.0018, d);
    }
  }
  return acc / 9.0;
}

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

struct TP {
  float h;
  float c;
  vec3 n;
};

// Unwrapped UVs preserve hardware screen-space derivatives across RepeatWrapping tiles!
TP tri(vec3 p, vec3 n, float s) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= max(w.x + w.y + w.z, 1e-4);
  vec4 x = texture(uDetailTex, p.zy * s);
  vec4 y = texture(uDetailTex, p.xz * s);
  vec4 z = texture(uDetailTex, p.xy * s);
  TP o;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  vec2 a = x.rg * 2.0 - 1.0;
  vec2 b = y.rg * 2.0 - 1.0;
  vec2 c = z.rg * 2.0 - 1.0;
  o.n = vec3(0.0, a.y, a.x) * w.x + vec3(b.x, 0.0, b.y) * w.y + vec3(c.x, c.y, 0.0) * w.z;
  return o;
}

TP tri(vec3 p, vec3 n) {
  TP t = tri(p, n, 0.22);
  t.n = normalize(n + t.n * 0.55);
  return t;
}

${DEFORMABLE_SAND_GLSL}
`;

// ============================================================================
// Startup GPU-Baked Tileable Detail Texture (1024x1024)
// Ported from W_DETAIL in abyssal-garden/source/src/shaders.js
// ============================================================================
const FS_QUAD_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DETAIL_FRAG = /* glsl */ `
layout(location = 0) out vec4 fragColor;

float ss(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float h31(vec3 p) {
  vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 h33(vec3 p) {
  vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}
float hp(vec2 p, float per) {
  return h31(vec3(p - per * floor(p / per), per));
}
float tn(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hp(i, per), hp(i + vec2(1.0, 0.0), per), u.x),
    mix(hp(i + vec2(0.0, 1.0), per), hp(i + vec2(1.0, 1.0), per), u.x),
    u.y
  );
}
float tf(vec2 uv, float per, int n) {
  float a = 0.5;
  float s = 0.0;
  float pr = per;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    s += a * tn(uv * pr + float(i) * 7.3, pr);
    pr *= 2.0;
    a *= 0.5;
  }
  return s / (1.0 - 2.0 * a);
}
vec3 tw(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 d = vec2(9.0);
  float id = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = i + o;
      vec2 cw = c - per * floor(c / per);
      vec3 hh = h33(vec3(cw, per));
      vec2 r = o + hh.xy - f;
      float l = dot(r, r);
      if (l < d.x) {
        d.y = d.x;
        d.x = l;
        id = hh.z;
      } else if (l < d.y) {
        d.y = l;
      }
    }
  }
  return vec3(sqrt(d), id);
}
float H(vec2 uv) {
  vec2 wq = uv + 0.11 * (vec2(tf(uv, 3.0, 4), tf(uv + 0.5, 3.0, 4)) - 0.5);
  float f = tf(wq, 3.0, 8);
  float r1 = 1.0 - abs(tf(wq + 1.7, 5.0, 6) * 2.0 - 1.0);
  float cr = min(abs(tf(wq + 4.1, 4.0, 5) * 2.0 - 1.0) * 7.0, 1.0);
  float cr2 = min(abs(tf(wq.yx + 2.3, 9.0, 4) * 2.0 - 1.0) * 9.0, 1.0);
  vec3 pt = tw(wq * 29.0, 29.0);
  float pit = (1.0 - ss(0.0, 0.34, pt.x)) * step(0.62, pt.z);
  return f * 0.50 + r1 * r1 * 0.24 + cr * cr2 * 0.26 - pit * 0.07;
}
void main() {
  vec2 uv = gl_FragCoord.xy / 1024.0;
  float e = 1.0 / 1024.0;
  float h = H(uv);
  float gx = H(uv + vec2(e, 0.0)) - H(uv - vec2(e, 0.0));
  float gy = H(uv + vec2(0.0, e)) - H(uv - vec2(0.0, e));
  vec2 s = clamp(vec2(gx, gy) * 1024.0 * 0.5 * 0.075, vec2(-1.0), vec2(1.0));
  fragColor = vec4(-s * 0.5 + 0.5, h, tf(uv + 3.7, 3.0, 5));
}
`;

export function createDetailTexture(renderer) {
  const rt = new THREE.WebGLRenderTarget(1024, 1024, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    vertexShader: FS_QUAD_VERT,
    fragmentShader: DETAIL_FRAG,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  scene.add(quad);

  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);

  quad.geometry.dispose();
  mat.dispose();
  return rt.texture;
}

// ============================================================================
// Animated Caustics & High-Freq Water Slope Texture (512x512, per frame)
// Ported from W_WATER in abyssal-garden/source/src/shaders.js
// ============================================================================
const WATER_CAUSTIC_FRAG = /* glsl */ `
layout(location = 0) out vec4 fragColor;
uniform float uTime;

float causPattern(vec2 uv, float t) {
  vec2 p = uv * 6.2831853;
  vec2 i = p;
  float c = 0.0;
  for (int n = 1; n <= 5; n++) {
    float tt = t * (1.0 - 3.5 / float(n));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    float s = sin(i.x + tt);
    float k = cos(i.y + tt);
    c += abs(s * k) / (1.25 * sqrt(s * s + k * k) + 1e-4);
  }
  c = 1.17 - pow(c / 5.0, 1.4);
  return pow(abs(c), 8.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / 512.0;
  float t = uTime;
  float c = causPattern(uv, t * 0.45 + 23.0);
  vec2 wu = uv + 0.02 * vec2(sin(6.2831853 * (uv.y * 2.0 + 0.1 * t)), cos(6.2831853 * (uv.x * 3.0 - 0.07 * t)));

  vec2 s = vec2(0.0);
  vec3 WK[10];
  WK[0] = vec3( 1.0,  2.0, 1.00);
  WK[1] = vec3(-2.0,  1.0, 0.90);
  WK[2] = vec3( 3.0,  1.0, 0.60);
  WK[3] = vec3( 1.0, -4.0, 0.50);
  WK[4] = vec3( 4.0,  3.0, 0.40);
  WK[5] = vec3(-3.0,  5.0, 0.32);
  WK[6] = vec3( 6.0, -2.0, 0.28);
  WK[7] = vec3( 5.0,  7.0, 0.20);
  WK[8] = vec3(-8.0,  3.0, 0.18);
  WK[9] = vec3( 2.0, 11.0, 0.14);

  for (int i = 0; i < 10; i++) {
    vec3 k = WK[i];
    float sgn = ((i & 1) == 0) ? 1.0 : -1.0;
    s += k.xy * k.z * cos(dot(k.xy, wu) * 6.2831853 + t * (0.5 + 0.35 * sqrt(length(k.xy))) * sgn + float(i) * 1.7);
  }
  fragColor = vec4(c, c, s.x * 0.085, s.y * 0.085);
}
`;

export function createWaterCausticSystem(renderer) {
  const rt = new THREE.WebGLRenderTarget(512, 512, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: FS_QUAD_VERT,
    fragmentShader: WATER_CAUSTIC_FRAG,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.Camera();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

  return {
    texture: rt.texture,
    update(elapsed) {
      mat.uniforms.uTime.value = elapsed;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
    },
  };
}
