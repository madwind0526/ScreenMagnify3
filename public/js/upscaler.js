(function () {
  const VERTEX_SOURCE = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = vec2(aUv.x, 1.0 - aUv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec2 uOutSize;
uniform vec4 uViewport;
`;

  const PASS_SOURCE = HEADER + `
void main() {
  outColor = texture(uTex, vUv);
}`;

  const KERNEL_BODY = `
vec3 sampleTex(vec2 p) {
  vec2 uv = (clamp(p, vec2(-0.5), uTexSize - vec2(0.5)) + vec2(0.5)) / uTexSize;
  return texture(uTex, uv).rgb;
}

WEIGHT_FUNCTION

void main() {
  vec2 pos = vUv * uTexSize - vec2(0.5);
  vec2 base = floor(pos);
  vec2 f = pos - base;
  vec3 color = vec3(0.0);
  float total = 0.0;
  for (int j = OFFSET_MIN; j <= OFFSET_MAX; j++) {
    for (int i = OFFSET_MIN; i <= OFFSET_MAX; i++) {
      float wx = weight(f.x - float(i));
      float wy = weight(f.y - float(j));
      float w = wx * wy;
      color += sampleTex(base + vec2(float(i), float(j))) * w;
      total += w;
    }
  }
  outColor = vec4(color / max(total, 1e-5), 1.0);
}`;

  const NIS_SOURCE = HEADER + `
uniform sampler2D uCoefScale;
uniform sampler2D uCoefUsm;

const float kDetectRatio = 2.0 * 1127.0 / 1024.0;
const float kDetectThres = 64.0 / 1024.0;
const float kMinContrastRatio = 2.0;
const float kMaxContrastRatio = 10.0;
const float kRatioNorm = 1.0 / (kMaxContrastRatio - kMinContrastRatio);
const float kSharpStartY = 0.45;
const float kSharpEndY = 0.9;
const float kSharpScaleY = 1.0 / (kSharpEndY - kSharpStartY);
const float kSharpStrengthMin = 0.1;
const float kSharpStrengthMax = 0.8125;
const float kSharpLimitMin = 0.1;
const float kSharpLimitMax = 0.35;
const float kSharpStrengthScale = kSharpStrengthMax - kSharpStrengthMin;
const float kSharpLimitScale = kSharpLimitMax - kSharpLimitMin;
const float kEps = 1.0 / 255.0;
const float kLumaR = 0.299;
const float kLumaG = 0.587;
const float kLumaB = 0.114;

float gP[36];
float gScalerX[6];
float gScalerY[6];
float gUsmX[6];
float gUsmY[6];

float lumaAt(ivec2 p) {
  ivec2 size = ivec2(uTexSize);
  p = clamp(p, ivec2(0), size - ivec2(1));
  vec3 c = texelFetch(uTex, p, 0).rgb;
  return dot(c, vec3(kLumaR, kLumaG, kLumaB));
}

vec4 edgeMap(int oi, int oj) {
  float p00 = gP[(oi + 0) * 6 + (oj + 0)];
  float p01 = gP[(oi + 0) * 6 + (oj + 1)];
  float p02 = gP[(oi + 0) * 6 + (oj + 2)];
  float p10 = gP[(oi + 1) * 6 + (oj + 0)];
  float p12 = gP[(oi + 1) * 6 + (oj + 2)];
  float p20 = gP[(oi + 2) * 6 + (oj + 0)];
  float p21 = gP[(oi + 2) * 6 + (oj + 1)];
  float p22 = gP[(oi + 2) * 6 + (oj + 2)];

  float g0 = abs(p00 + p01 + p02 - p20 - p21 - p22);
  float g45 = abs(p10 + p00 + p01 - p21 - p22 - p12);
  float g90 = abs(p00 + p10 + p20 - p02 - p12 - p22);
  float g135 = abs(p10 + p20 + p21 - p01 - p02 - p12);

  float g0_90_max = max(g0, g90);
  float g0_90_min = min(g0, g90);
  float g45_135_max = max(g45, g135);
  float g45_135_min = min(g45, g135);

  if (g0_90_max + g45_135_max == 0.0) return vec4(0.0);

  float e0_90 = min(g0_90_max / (g0_90_max + g45_135_max), 1.0);
  float e45_135 = 1.0 - e0_90;

  bool c0_90 = (g0_90_max > (g0_90_min * kDetectRatio)) && (g0_90_max > kDetectThres) && (g0_90_max > g45_135_min);
  bool c45_135 = (g45_135_max > (g45_135_min * kDetectRatio)) && (g45_135_max > kDetectThres) && (g45_135_max > g0_90_min);
  bool cg0_90 = g0_90_max == g0;
  bool cg45_135 = g45_135_max == g45;

  float f0_90 = (c0_90 && c45_135) ? e0_90 : 1.0;
  float f45_135 = (c0_90 && c45_135) ? e45_135 : 1.0;

  float weight0 = (c0_90 && cg0_90) ? f0_90 : 0.0;
  float weight90 = (c0_90 && !cg0_90) ? f0_90 : 0.0;
  float weight45 = (c45_135 && cg45_135) ? f45_135 : 0.0;
  float weight135 = (c45_135 && !cg45_135) ? f45_135 : 0.0;

  return vec4(weight0, weight90, weight45, weight135);
}

float calcLTI(float p0, float p1, float p2, float p3, float p4, float p5, int phaseIndex) {
  bool selector = phaseIndex <= 32;
  float sel = selector ? p0 : p3;
  float aMin = min(min(p1, p2), sel);
  float aMax = max(max(p1, p2), sel);
  sel = selector ? p2 : p5;
  float bMin = min(min(p3, p4), sel);
  float bMax = max(max(p3, p4), sel);

  float aCont = aMax - aMin;
  float bCont = bMax - bMin;
  float contRatio = max(aCont, bCont) / (min(aCont, bCont) + kEps);
  return (1.0 - clamp((contRatio - kMinContrastRatio) * kRatioNorm, 0.0, 1.0));
}

float evalPoly6Raw(in float pxl[6], int phaseInt, in float cs[6], in float cu[6]) {
  float y = 0.0;
  float yUsm = 0.0;
  for (int i = 0; i < 6; i++) {
    y += cs[i] * pxl[i];
    yUsm += cu[i] * pxl[i];
  }

  float yScale = 1.0 - clamp((y - kSharpStartY) * kSharpScaleY, 0.0, 1.0);
  float ySharpness = yScale * kSharpStrengthScale + kSharpStrengthMin;
  yUsm *= ySharpness;
  float limit = (yScale * kSharpLimitScale + kSharpLimitMin) * y;
  yUsm = min(limit, max(-limit, yUsm));
  yUsm *= calcLTI(pxl[0], pxl[1], pxl[2], pxl[3], pxl[4], pxl[5], phaseInt);
  return y + yUsm;
}

float evalPoly6Bank(in float pxl[6], int phaseInt, int axis) {
  float y = 0.0;
  float yUsm = 0.0;
  for (int i = 0; i < 6; i++) {
    float cs = axis == 0 ? gScalerY[i] : gScalerX[i];
    float cu = axis == 0 ? gUsmY[i] : gUsmX[i];
    y += cs * pxl[i];
    yUsm += cu * pxl[i];
  }

  float yScale = 1.0 - clamp((y - kSharpStartY) * kSharpScaleY, 0.0, 1.0);
  float ySharpness = yScale * kSharpStrengthScale + kSharpStrengthMin;
  yUsm *= ySharpness;
  float limit = (yScale * kSharpLimitScale + kSharpLimitMin) * y;
  yUsm = min(limit, max(-limit, yUsm));
  yUsm *= calcLTI(pxl[0], pxl[1], pxl[2], pxl[3], pxl[4], pxl[5], phaseInt);
  return y + yUsm;
}

float evalPoly6Dynamic(in float pxl[6], int phaseInt) {
  vec4 s0 = texelFetch(uCoefScale, ivec2(0, phaseInt), 0);
  vec4 s1 = texelFetch(uCoefScale, ivec2(1, phaseInt), 0);
  vec4 u0 = texelFetch(uCoefUsm, ivec2(0, phaseInt), 0);
  vec4 u1 = texelFetch(uCoefUsm, ivec2(1, phaseInt), 0);
  float cs[6] = float[6](s0.x, s0.y, s0.z, s0.w, s1.x, s1.y);
  float cu[6] = float[6](u0.x, u0.y, u0.z, u0.w, u1.x, u1.y);
  return evalPoly6Raw(pxl, phaseInt, cs, cu);
}

float filterNormal(int fxInt, int fyInt) {
  float acc = 0.0;
  for (int j = 0; j < 6; j++) {
    float vAcc = 0.0;
    for (int i = 0; i < 6; i++) {
      vAcc += gP[i * 6 + j] * gScalerY[i];
    }
    acc += vAcc * gScalerX[j];
  }
  return acc;
}

float addDirFilters(float fx, float fy, int fxInt, int fyInt, vec4 w) {
  float f = 0.0;

  if (w.x > 0.0) {
    float interp0[6];
    for (int i = 0; i < 6; i++) {
      interp0[i] = mix(gP[i * 6 + 2], gP[i * 6 + 3], fx);
    }
    f += evalPoly6Bank(interp0, fyInt, 0) * w.x;
  }

  if (w.y > 0.0) {
    float interp90[6];
    for (int i = 0; i < 6; i++) {
      interp90[i] = mix(gP[2 * 6 + i], gP[3 * 6 + i], fy);
    }
    f += evalPoly6Bank(interp90, fxInt, 1) * w.y;
  }

  if (w.z > 0.0) {
    float b45 = 0.5 + 0.5 * (fx - fy);
    float temp45[7];
    temp45[1] = mix(gP[2 * 6 + 1], gP[1 * 6 + 2], b45);
    temp45[3] = mix(gP[3 * 6 + 2], gP[2 * 6 + 3], b45);
    temp45[5] = mix(gP[4 * 6 + 3], gP[3 * 6 + 4], b45);
    b45 -= 0.5;
    float a = b45 >= 0.0 ? gP[0 * 6 + 2] : gP[2 * 6 + 0];
    float b = b45 >= 0.0 ? gP[1 * 6 + 3] : gP[3 * 6 + 1];
    float c = b45 >= 0.0 ? gP[2 * 6 + 4] : gP[4 * 6 + 2];
    float d = b45 >= 0.0 ? gP[3 * 6 + 5] : gP[5 * 6 + 3];
    temp45[0] = mix(gP[1 * 6 + 1], a, abs(b45));
    temp45[2] = mix(gP[2 * 6 + 2], b, abs(b45));
    temp45[4] = mix(gP[3 * 6 + 3], c, abs(b45));
    temp45[6] = mix(gP[4 * 6 + 4], d, abs(b45));

    float p45 = fx + fy;
    float interp45[6];
    if (p45 >= 1.0) {
      for (int i = 0; i < 6; i++) interp45[i] = temp45[i + 1];
      p45 -= 1.0;
    } else {
      for (int i = 0; i < 6; i++) interp45[i] = temp45[i];
    }
    int phase = clamp(int(p45 * 64.0), 0, 63);
    f += evalPoly6Dynamic(interp45, phase) * w.z;
  }

  if (w.w > 0.0) {
    float b135 = 0.5 * (fx + fy);
    float temp135[7];
    temp135[1] = mix(gP[3 * 6 + 1], gP[4 * 6 + 2], b135);
    temp135[3] = mix(gP[2 * 6 + 2], gP[3 * 6 + 3], b135);
    temp135[5] = mix(gP[1 * 6 + 3], gP[2 * 6 + 4], b135);
    b135 -= 0.5;
    float a = b135 >= 0.0 ? gP[5 * 6 + 2] : gP[3 * 6 + 0];
    float b = b135 >= 0.0 ? gP[4 * 6 + 3] : gP[2 * 6 + 1];
    float c = b135 >= 0.0 ? gP[3 * 6 + 4] : gP[1 * 6 + 2];
    float d = b135 >= 0.0 ? gP[2 * 6 + 5] : gP[0 * 6 + 3];
    temp135[0] = mix(gP[4 * 6 + 1], a, abs(b135));
    temp135[2] = mix(gP[3 * 6 + 2], b, abs(b135));
    temp135[4] = mix(gP[2 * 6 + 3], c, abs(b135));
    temp135[6] = mix(gP[1 * 6 + 4], d, abs(b135));

    float p135 = 1.0 + (fx - fy);
    float interp135[6];
    if (p135 >= 1.0) {
      for (int i = 0; i < 6; i++) interp135[i] = temp135[i + 1];
      p135 -= 1.0;
    } else {
      for (int i = 0; i < 6; i++) interp135[i] = temp135[i];
    }
    int phase = clamp(int(p135 * 64.0), 0, 63);
    f += evalPoly6Dynamic(interp135, phase) * w.w;
  }

  return f;
}

void main() {
  float scaleX = uTexSize.x / uOutSize.x;
  float scaleY = uTexSize.y / uOutSize.y;
  vec2 frag = gl_FragCoord.xy - uViewport.xy;
  float srcX = frag.x * scaleX - 0.5;
  float srcY = (uOutSize.y - frag.y) * scaleY - 0.5;

  ivec2 base = ivec2(floor(srcX), floor(srcY));
  float fx = srcX - floor(srcX);
  float fy = srcY - floor(srcY);
  int fxInt = clamp(int(fx * 64.0), 0, 63);
  int fyInt = clamp(int(fy * 64.0), 0, 63);

  for (int i = 0; i < 6; i++) {
    for (int j = 0; j < 6; j++) {
      gP[i * 6 + j] = lumaAt(base + ivec2(j - 2, i - 2));
    }
  }

  vec4 sx0 = texelFetch(uCoefScale, ivec2(0, fxInt), 0);
  vec4 sx1 = texelFetch(uCoefScale, ivec2(1, fxInt), 0);
  vec4 ux0 = texelFetch(uCoefUsm, ivec2(0, fxInt), 0);
  vec4 ux1 = texelFetch(uCoefUsm, ivec2(1, fxInt), 0);
  gScalerX[0] = sx0.x; gScalerX[1] = sx0.y; gScalerX[2] = sx0.z; gScalerX[3] = sx0.w; gScalerX[4] = sx1.x; gScalerX[5] = sx1.y;
  gUsmX[0] = ux0.x; gUsmX[1] = ux0.y; gUsmX[2] = ux0.z; gUsmX[3] = ux0.w; gUsmX[4] = ux1.x; gUsmX[5] = ux1.y;

  vec4 sy0 = texelFetch(uCoefScale, ivec2(0, fyInt), 0);
  vec4 sy1 = texelFetch(uCoefScale, ivec2(1, fyInt), 0);
  vec4 uy0 = texelFetch(uCoefUsm, ivec2(0, fyInt), 0);
  vec4 uy1 = texelFetch(uCoefUsm, ivec2(1, fyInt), 0);
  gScalerY[0] = sy0.x; gScalerY[1] = sy0.y; gScalerY[2] = sy0.z; gScalerY[3] = sy0.w; gScalerY[4] = sy1.x; gScalerY[5] = sy1.y;
  gUsmY[0] = uy0.x; gUsmY[1] = uy0.y; gUsmY[2] = uy0.z; gUsmY[3] = uy0.w; gUsmY[4] = uy1.x; gUsmY[5] = uy1.y;

  vec4 e00 = edgeMap(1, 1);
  vec4 e01 = edgeMap(1, 2);
  vec4 e10 = edgeMap(2, 1);
  vec4 e11 = edgeMap(2, 2);
  vec4 w = mix(mix(e00, e01, fx), mix(e10, e11, fx), fy);

  float baseWeight = 1.0 - w.x - w.y - w.z - w.w;
  float opY = filterNormal(fxInt, fyInt) * baseWeight;
  opY += addDirFilters(fx, fy, fxInt, fyInt, w);

  vec4 op = texture(uTex, vec2((srcX + 0.5) / uTexSize.x, (srcY + 0.5) / uTexSize.y));
  float corr = opY - dot(op.rgb, vec3(kLumaR, kLumaG, kLumaB));
  outColor = vec4(clamp(op.rgb + corr, 0.0, 1.0), 1.0);
}`;

  const KERNELS = {
    'bicubic-catmull': {
      weight: `
float weight(float x) {
  x = abs(x);
  if (x < 1.0) return (1.5 * x - 2.5) * x * x + 1.0;
  if (x < 2.0) return ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0;
  return 0.0;
}`,
      min: -1,
      max: 2
    },
    'bicubic-bspline': {
      weight: `
float weight(float x) {
  x = abs(x);
  if (x < 1.0) return (3.0 * x * x * x - 6.0 * x * x + 4.0) / 6.0;
  if (x < 2.0) return pow(2.0 - x, 3.0) / 6.0;
  return 0.0;
}`,
      min: -1,
      max: 2
    },
    'bicubic-mitchell': {
      weight: `
float weight(float x) {
  x = abs(x);
  const float B = 1.0 / 3.0;
  const float C = 1.0 / 3.0;
  if (x < 1.0) {
    return ((12.0 - 9.0 * B - 6.0 * C) * x * x * x + (-18.0 + 12.0 * B + 6.0 * C) * x * x + (6.0 - 2.0 * B)) / 6.0;
  }
  if (x < 2.0) {
    return ((-B - 6.0 * C) * x * x * x + (6.0 * B + 30.0 * C) * x * x + (-12.0 * B - 48.0 * C) * x + (8.0 * B + 24.0 * C)) / 6.0;
  }
  return 0.0;
}`,
      min: -1,
      max: 2
    },
    lanczos2: { radius: 2 },
    lanczos3: { radius: 3 },
    lanczos4: { radius: 4 }
  };

  function lanczosKernel(radius) {
    return {
      weight: `
float weight(float x) {
  x = abs(x);
  if (x < 1e-5) return 1.0;
  if (x >= ${radius}.0) return 0.0;
  float px = 3.14159265358979 * x;
  return (sin(px) / px) * (sin(px / ${radius}.0) / (px / ${radius}.0));
}`,
      min: -(radius - 1),
      max: radius
    };
  }

  class Upscaler {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance'
      });
      this.method = 'bilinear';
      this.programs = new Map();
      this.texW = 0;
      this.texH = 0;
      this.aiW = 0;
      this.aiH = 0;
      this.ctx2d = null;

      if (!this.gl) {
        this.ctx2d = canvas.getContext('2d');
        return;
      }

      // A GPU reset or driver update loses every GL object: rebuild them when the browser restores the context.
      this.lost = false;
      this.onRestore = null; // set by the owner: it has to draw again and re-upload the AI frame
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.lost = true;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.initGL();
        this.lost = false;
        if (this.onRestore) this.onRestore();
      });
      this.initGL();
    }

    initGL() {
      const gl = this.gl;
      this.programs = new Map();
      this.texW = 0;
      this.texH = 0;
      this.aiW = 0;
      this.aiH = 0;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);

      this.positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        1, 1
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      this.uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

      gl.bindVertexArray(null);

      this.cropTexture = this.createTexture();
      this.aiTexture = this.createTexture();
      this.coefScaleTexture = this.createCoefTexture(window.NIS_COEF_SCALE);
      this.coefUsmTexture = this.createCoefTexture(window.NIS_COEF_USM);
    }

    createTexture() {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    }

    createCoefTexture(values) {
      const gl = this.gl;
      const data = new Float32Array(2 * 64 * 4);
      if (Array.isArray(values)) {
        for (let phase = 0; phase < 64; phase += 1) {
          const offset = phase * 6;
          const first = (phase * 2) * 4;
          const second = (phase * 2 + 1) * 4;
          data[first] = values[offset] || 0;
          data[first + 1] = values[offset + 1] || 0;
          data[first + 2] = values[offset + 2] || 0;
          data[first + 3] = values[offset + 3] || 0;
          data[second] = values[offset + 4] || 0;
          data[second + 1] = values[offset + 5] || 0;
        }
      }
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 64, 0, gl.RGBA, gl.FLOAT, data);
      return texture;
    }

    compile(source, type) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(log || 'Shader compile failed');
      }
      return shader;
    }

    createProgram(fragmentSource) {
      const gl = this.gl;
      const vertex = this.compile(VERTEX_SOURCE, gl.VERTEX_SHADER);
      const fragment = this.compile(fragmentSource, gl.FRAGMENT_SHADER);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.bindAttribLocation(program, 0, 'aPos');
      gl.bindAttribLocation(program, 1, 'aUv');
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(log || 'Program link failed');
      }
      return {
        program,
        uniforms: {
          uTex: gl.getUniformLocation(program, 'uTex'),
          uTexSize: gl.getUniformLocation(program, 'uTexSize'),
          uOutSize: gl.getUniformLocation(program, 'uOutSize'),
          uViewport: gl.getUniformLocation(program, 'uViewport'),
          uCoefScale: gl.getUniformLocation(program, 'uCoefScale'),
          uCoefUsm: gl.getUniformLocation(program, 'uCoefUsm')
        }
      };
    }

    getProgram(key) {
      if (this.programs.has(key)) return this.programs.get(key);
      let source = PASS_SOURCE;
      if (KERNELS[key]) {
        const kernel = KERNELS[key].radius ? lanczosKernel(KERNELS[key].radius) : KERNELS[key];
        source = HEADER + KERNEL_BODY
          .replace('WEIGHT_FUNCTION', kernel.weight)
          .replace(/OFFSET_MIN/g, String(kernel.min))
          .replace(/OFFSET_MAX/g, String(kernel.max));
      } else if (key === 'nis') {
        source = NIS_SOURCE;
      }

      let entry;
      try {
        entry = this.createProgram(source);
      } catch (error) {
        console.error('Shader error:', key, error);
        entry = this.createProgram(PASS_SOURCE);
        if (this.onShaderError) this.onShaderError(key);
      }
      this.programs.set(key, entry);
      return entry;
    }

    setMethod(method) {
      this.method = method || 'bilinear';
    }

    resize(width, height) {
      if (!this.gl) return;
      this.gl.viewport(0, 0, width, height);
    }

    uploadCrop(source) {
      const gl = this.gl;
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.cropTexture);
      if (this.texW !== width || this.texH !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this.texW = width;
        this.texH = height;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
      return { width, height };
    }

    setFilter(texture, filter) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    }

    uploadAI(data, width, height) {
      if (!this.gl) {
        this.uploadAI2d(data, width, height);
        return;
      }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.aiTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      // The x4 output is usually shown smaller than 4x: mipmaps keep the shrink smooth (plain LINEAR skips pixels).
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.aiW = width;
      this.aiH = height;
    }

    clearAI() {
      this.aiW = 0;
      this.aiH = 0;
    }

    viewportRect(viewRect) {
      return {
        x: viewRect.x,
        y: this.canvas.height - viewRect.y - viewRect.h,
        w: viewRect.w,
        h: viewRect.h
      };
    }

    bindCommon(entry, texW, texH, viewRect) {
      const gl = this.gl;
      const vp = this.viewportRect(viewRect);
      gl.viewport(vp.x, vp.y, vp.w, vp.h);
      const u = entry.uniforms;
      gl.uniform2f(u.uTexSize, texW, texH);
      gl.uniform2f(u.uOutSize, viewRect.w, viewRect.h);
      gl.uniform4f(u.uViewport, vp.x, vp.y, vp.w, vp.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    drawCrop(source, viewRect) {
      if (!this.gl) {
        this.drawCrop2d(source, viewRect);
        return;
      }
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const size = this.uploadCrop(source);
      gl.bindVertexArray(this.vao);

      let key = this.method;
      if (key === 'nearest' || key === 'bilinear') key = 'pass';
      const entry = this.getProgram(key);
      gl.useProgram(entry.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.cropTexture);
      const filter = (this.method === 'bilinear' || this.method === 'nis')
        ? gl.LINEAR
        : gl.NEAREST;
      this.setFilter(this.cropTexture, filter);
      gl.uniform1i(entry.uniforms.uTex, 0);

      if (this.method === 'nis') {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.coefScaleTexture);
        gl.uniform1i(entry.uniforms.uCoefScale, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.coefUsmTexture);
        gl.uniform1i(entry.uniforms.uCoefUsm, 2);
        gl.activeTexture(gl.TEXTURE0);
      }

      this.bindCommon(entry, size.width, size.height, viewRect);
      gl.bindVertexArray(null);
    }

    drawAI(viewRect) {
      if (!this.gl) {
        if (this.aiCanvas2d) {
          const ctx = this.ctx2d;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(this.aiCanvas2d, viewRect.x, viewRect.y, viewRect.w, viewRect.h);
        }
        return;
      }
      if (!this.aiW || !this.aiH) return;
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const entry = this.getProgram('pass');
      gl.bindVertexArray(this.vao);
      gl.useProgram(entry.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.aiTexture);
      gl.uniform1i(entry.uniforms.uTex, 0);
      this.bindCommon(entry, this.aiW, this.aiH, viewRect);
      gl.bindVertexArray(null);
    }

    drawCrop2d(source, viewRect) {
      const ctx = this.ctx2d;
      if (!ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.imageSmoothingEnabled = this.method !== 'nearest';
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, viewRect.x, viewRect.y, viewRect.w, viewRect.h);
    }

    uploadAI2d(data, width, height) {
      if (!this.aiCanvas2d) this.aiCanvas2d = document.createElement('canvas');
      this.aiCanvas2d.width = width;
      this.aiCanvas2d.height = height;
      const ctx = this.aiCanvas2d.getContext('2d');
      const image = new ImageData(new Uint8ClampedArray(data), width, height);
      ctx.putImageData(image, 0, 0);
      this.aiW = width;
      this.aiH = height;
    }

    dispose() {
      if (!this.gl) return;
      try {
        const lose = this.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch {
        // Ignore.
      }
    }
  }

  window.SM = window.SM || {};
  window.SM.Upscaler = Upscaler;
})();
