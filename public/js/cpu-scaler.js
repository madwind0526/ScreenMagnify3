(function () {
  // CPU resampling used when the device is set to CPU (no WebGL). Separable kernels, centre-aligned.
  const KERNELS = {
    bilinear: { r: 1, f: (x) => (x < 1 ? 1 - x : 0) },
    'bicubic-catmull': {
      r: 2,
      f: (x) => (x < 1 ? (1.5 * x - 2.5) * x * x + 1 : x < 2 ? ((-0.5 * x + 2.5) * x - 4) * x + 2 : 0)
    },
    lanczos3: {
      r: 3,
      f: (x) => {
        if (x < 1e-6) return 1;
        if (x >= 3) return 0;
        const px = Math.PI * x;
        return (Math.sin(px) / px) * (Math.sin(px / 3) / (px / 3));
      }
    }
  };

  // Weights depend only on sizes and method, so panning (same sizes) reuses them.
  const weightCache = new Map();

  function cachedWeights(srcLen, dstLen, method, kernel) {
    const key = `${method}|${srcLen}|${dstLen}`;
    let entry = weightCache.get(key);
    if (!entry) {
      entry = buildWeights(srcLen, dstLen, kernel);
      if (weightCache.size >= 16) weightCache.delete(weightCache.keys().next().value);
      weightCache.set(key, entry);
    }
    return entry;
  }

  let scratch = new Float32Array(0);

  // For each destination index: first source index, tap count and normalized weights.
  function buildWeights(srcLen, dstLen, kernel) {
    const scale = srcLen / dstLen;
    const filterScale = Math.max(1, scale); // widen the kernel when shrinking
    const support = kernel.r * filterScale;
    const stride = Math.ceil(support * 2) + 2;
    const lo = new Int32Array(dstLen);
    const count = new Int32Array(dstLen);
    const weights = new Float32Array(dstLen * stride);
    for (let d = 0; d < dstLen; d += 1) {
      const center = (d + 0.5) * scale - 0.5;
      const first = Math.max(0, Math.ceil(center - support));
      const last = Math.min(srcLen - 1, Math.floor(center + support));
      let sum = 0;
      for (let i = first; i <= last; i += 1) {
        const w = kernel.f(Math.abs(i - center) / filterScale);
        weights[d * stride + (i - first)] = w;
        sum += w;
      }
      lo[d] = first;
      count[d] = Math.max(1, last - first + 1);
      if (sum > 1e-6) {
        for (let t = 0; t < count[d]; t += 1) weights[d * stride + t] /= sum;
      } else {
        weights[d * stride] = 1;
      }
    }
    return { lo, count, weights, stride };
  }

  function nearest(src, sw, sh, dw, dh) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y += 1) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (let x = 0; x < dw; x += 1) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
        const si = (sy * sw + sx) * 4;
        const di = (y * dw + x) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = src[si + 3];
      }
    }
    return out;
  }

  // src: RGBA bytes (sw x sh). Returns RGBA bytes (dw x dh).
  function resample(src, sw, sh, dw, dh, method) {
    if (method === 'nearest') return nearest(src, sw, sh, dw, dh);
    const kernel = KERNELS[method] || KERNELS.bilinear;
    const wx = cachedWeights(sw, dw, method, kernel);
    const wy = cachedWeights(sh, dh, method, kernel);

    if (scratch.length < dw * sh * 4) scratch = new Float32Array(dw * sh * 4);
    const tmp = scratch;
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const base = x * wx.stride;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let t = 0, n = wx.count[x]; t < n; t += 1) {
          const w = wx.weights[base + t];
          const si = (y * sw + wx.lo[x] + t) * 4;
          r += w * src[si];
          g += w * src[si + 1];
          b += w * src[si + 2];
          a += w * src[si + 3];
        }
        const ti = (y * dw + x) * 4;
        tmp[ti] = r;
        tmp[ti + 1] = g;
        tmp[ti + 2] = b;
        tmp[ti + 3] = a;
      }
    }

    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y += 1) {
      const base = y * wy.stride;
      const first = wy.lo[y];
      const n = wy.count[y];
      for (let x = 0; x < dw; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let t = 0; t < n; t += 1) {
          const w = wy.weights[base + t];
          const ti = ((first + t) * dw + x) * 4;
          r += w * tmp[ti];
          g += w * tmp[ti + 1];
          b += w * tmp[ti + 2];
          a += w * tmp[ti + 3];
        }
        const oi = (y * dw + x) * 4;
        out[oi] = r;
        out[oi + 1] = g;
        out[oi + 2] = b;
        out[oi + 3] = a;
      }
    }
    return out;
  }

  window.SM = window.SM || {};
  window.SM.resample = resample;
})();
