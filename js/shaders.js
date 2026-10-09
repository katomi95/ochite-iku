// 共通の GLSL 断片。色はすべて「画面に出す値（sRGB相当）」として直接扱う。
// 空・霧・ハッシュをすべてのマテリアルで共有し、霧の色＝その方向の空の色にすることで
// 遠くのビルや奈落の底が空に溶け込み、終わりが見えないようにしている。

export const COMMON_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform float uFogDensity;
uniform float uTime;

// 夕暮れ（ブルーアワー）の空。e = 視線の上下成分。
vec3 skyColor(vec3 d) {
  float e = d.y;
  vec3 zen = vec3(0.14, 0.20, 0.42);
  vec3 mid = vec3(0.34, 0.44, 0.72);
  vec3 hor = vec3(0.96, 0.68, 0.57);
  vec3 low = vec3(0.50, 0.45, 0.66);
  vec3 aby = vec3(0.24, 0.23, 0.40);
  vec3 c;
  if (e >= 0.0) {
    c = mix(hor, mid, smoothstep(0.0, 0.22, e));
    c = mix(c, zen, smoothstep(0.22, 0.9, e));
  } else {
    c = mix(hor, low, smoothstep(0.0, -0.18, e));
    c = mix(c, aby, smoothstep(-0.18, -0.85, e));
    // 奈落の底にはうっすら街明かりのような暖色
    c += vec3(0.10, 0.05, 0.03) * smoothstep(-0.6, -1.0, e);
  }
  float s = max(dot(d, uSunDir), 0.0);
  c += vec3(1.0, 0.58, 0.32) * (pow(s, 6.0) * 0.28 + pow(s, 64.0) * 0.55) * smoothstep(-0.25, 0.05, e);
  return c;
}

float fogAmount(vec3 wp) {
  float d = length(wp - cameraPosition);
  return 1.0 - exp(-d * uFogDensity);
}

// 整数ハッシュ（sin を使わないので大きな値でも安定）。入力は正の値にしてから渡す。
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(vec3 p) {
  return vec3(pcg3d(uvec3(floor(max(p, 0.0))))) * (1.0 / 4294967295.0);
}

vec3 hue2rgb(float h) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return k;
}

float boxMask(vec2 f, vec2 lo, vec2 hi, vec2 w) {
  vec2 a = smoothstep(lo - w, lo + w, f) * (1.0 - smoothstep(hi - w, hi + w, f));
  return a.x * a.y;
}
`;
