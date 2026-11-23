// Pixel processing of the image editor (no DOM, so it can be tested in Node). All images are RGBA Uint8ClampedArray.
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function lumaOf(rgba, w, h) {
    const out = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    return out;
  }

  // Brightness / contrast / saturation are -100..100, sharpness is 0..100 (unsharp mask with a 3x3 box blur).
  function adjust(src, w, h, p) {
    const out = new Uint8ClampedArray(src);
    const b = (p.brightness || 0) * 2.55;
    const c = (100 + (p.contrast || 0)) / 100;
    const s = (100 + (p.saturation || 0)) / 100;
    if (b || c !== 1 || s !== 1) {
      for (let i = 0; i < out.length; i += 4) {
        let r = out[i];
        let g = out[i + 1];
        let bl = out[i + 2];
        if (s !== 1) {
          const l = 0.299 * r + 0.587 * g + 0.114 * bl;
          r = l + (r - l) * s;
          g = l + (g - l) * s;
          bl = l + (bl - l) * s;
        }
        out[i] = (r - 128) * c + 128 + b;
        out[i + 1] = (g - 128) * c + 128 + b;
        out[i + 2] = (bl - 128) * c + 128 + b;
      }
    }
    const amount = ((p.sharpness || 0) / 100) * 2;
    if (amount > 0) {
      const base = new Uint8ClampedArray(out);
      for (let y = 0; y < h; y += 1) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(h - 1, y + 1);
        for (let x = 0; x < w; x += 1) {
          const x0 = Math.max(0, x - 1);
          const x1 = Math.min(w - 1, x + 1);
          const n = (y1 - y0 + 1) * (x1 - x0 + 1);
          const o = (y * w + x) * 4;
          for (let k = 0; k < 3; k += 1) {
            let sum = 0;
            for (let yy = y0; yy <= y1; yy += 1) for (let xx = x0; xx <= x1; xx += 1) sum += base[(yy * w + xx) * 4 + k];
            out[o + k] = base[o + k] + amount * (base[o + k] - sum / n);
          }
        }
      }
    }
    return out;
  }

  // Stretch the 1 %..99 % luma range to 0..255: returns the brightness and contrast that do it.
  function autoAdjust(rgba, w, h) {
    const hist = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < w * h; i += 1) {
      if (rgba[i * 4 + 3] < 128) continue;
      hist[Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])] += 1;
      total += 1;
    }
    if (!total) return { brightness: 0, contrast: 0 };
    const at = (q) => {
      let sum = 0;
      for (let v = 0; v < 256; v += 1) {
        sum += hist[v];
        if (sum >= total * q) return v;
      }
      return 255;
    };
    const lo = at(0.01);
    const hi = at(0.99);
    if (hi - lo < 8) return { brightness: 0, contrast: 0 };
    const factor = 255 / (hi - lo);
    const mid = (lo + hi) / 2;
    return {
      contrast: Math.round(clamp((factor - 1) * 100, -100, 100)),
      brightness: Math.round(clamp((128 - ((mid - 128) * factor + 128)) / 2.55, -100, 100))
    };
  }

  // Angle (degrees, clockwise positive) to rotate by so that text lines / edges become horizontal.
  // Projection profile: the angle where the dark pixels pile up into the fewest rows wins.
  function detectSkew(rgba, w, h) {
    const k = Math.max(1, Math.ceil(Math.max(w, h) / 400));
    const sw = Math.floor(w / k);
    const sh = Math.floor(h / k);
    const gray = new Float32Array(sw * sh);
    let mean = 0;
    let n = 0;
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const p = (y * k * w + x * k) * 4;
        if (rgba[p + 3] < 128) {
          gray[y * sw + x] = -1;
          continue;
        }
        const v = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
        gray[y * sw + x] = v;
        mean += v;
        n += 1;
      }
    }
    if (!n) return 0;
    mean /= n;
    const pts = [];
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const v = gray[y * sw + x];
        if (v >= 0 && v < mean - 25) pts.push(x - sw / 2, y - sh / 2);
      }
    }
    if (pts.length < 40) return 0;
    const bins = Math.ceil(Math.hypot(sw, sh)) + 2;
    const score = (deg) => {
      const rad = (deg * Math.PI) / 180;
      const sin = Math.sin(rad);
      const cos = Math.cos(rad);
      const hist = new Float64Array(bins);
      for (let i = 0; i < pts.length; i += 2) hist[Math.round(pts[i] * sin + pts[i + 1] * cos + bins / 2)] += 1;
      let s = 0;
      for (let i = 0; i < bins; i += 1) s += hist[i] * hist[i];
      return s;
    };
    let best = 0;
    let bestScore = -1;
    for (let deg = -15; deg <= 15; deg += 0.5) {
      const s = score(deg);
      if (s > bestScore) {
        bestScore = s;
        best = deg;
      }
    }
    const center = best;
    for (let deg = center - 0.5; deg <= center + 0.5; deg += 0.1) {
      const s = score(deg);
      if (s > bestScore) {
        bestScore = s;
        best = deg;
      }
    }
    return Math.round(best * 10) / 10;
  }

  function gaussian(gray, w, h, sigma) {
    const src = Float32Array.from(gray);
    if (sigma < 0.3) return src;
    const r = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i += 1) {
      kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
      sum += kernel[i + r];
    }
    for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let acc = 0;
        for (let i = -r; i <= r; i += 1) acc += kernel[i + r] * src[y * w + clamp(x + i, 0, w - 1)];
        tmp[y * w + x] = acc;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let acc = 0;
        for (let i = -r; i <= r; i += 1) acc += kernel[i + r] * tmp[clamp(y + i, 0, h - 1) * w + x];
        out[y * w + x] = acc;
      }
    }
    return out;
  }

  // Canny: gaussian blur, Sobel, non-maximum suppression, hysteresis. Thresholds are brightness levels per pixel (a sharp black/white edge is about 255).
  function canny(gray, w, h, opt) {
    const g = gaussian(gray, w, h, opt.sigma);
    const mag = new Float32Array(w * h);
    const dir = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
        const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
        // Sobel sums 4 pixel weights per side, so /4 gives brightness levels per pixel (0..255 for a black-white step).
        mag[i] = Math.hypot(gx, gy) / 4;
        const a = (Math.atan2(gy, gx) * 180) / Math.PI;
        const d = a < 0 ? a + 180 : a;
        dir[i] = d < 22.5 || d >= 157.5 ? 0 : d < 67.5 ? 1 : d < 112.5 ? 2 : 3;
      }
    }
    const lo = Math.min(opt.low, opt.high);
    const hi = Math.max(opt.low, opt.high);
    const state = new Uint8Array(w * h); // 0 none, 1 weak, 2 strong
    const stack = [];
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const m = mag[i];
        if (m < lo) continue;
        let a;
        let b;
        const d = dir[i];
        if (d === 0) { a = mag[i - 1]; b = mag[i + 1]; }
        else if (d === 1) { a = mag[i - w - 1]; b = mag[i + w + 1]; }
        else if (d === 2) { a = mag[i - w]; b = mag[i + w]; }
        else { a = mag[i - w + 1]; b = mag[i + w - 1]; }
        if (m <= a || m < b) continue;
        if (m >= hi) {
          state[i] = 2;
          stack.push(i);
        } else {
          state[i] = 1;
        }
      }
    }
    const out = new Uint8Array(w * h);
    while (stack.length) {
      const i = stack.pop();
      if (out[i]) continue;
      out[i] = 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = i + dy * w + dx;
          if (j >= 0 && j < w * h && state[j] === 1 && !out[j]) stack.push(j);
        }
      }
    }
    return out;
  }

  // A pixel is a line when it is darker than some neighbour at `radius` px by at least `diff` levels.
  function brightnessLines(gray, w, h, opt) {
    const g = gaussian(gray, w, h, opt.blur || 0);
    const r = Math.max(1, Math.round(opt.radius));
    const out = new Uint8Array(w * h);
    const off = [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const v = g[y * w + x];
        for (const [dx, dy] of off) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (g[yy * w + xx] - v >= opt.diff) {
            out[y * w + x] = 1;
            break;
          }
        }
      }
    }
    return out;
  }

  // Connected areas of non-line pixels (4-neighbours). Returns { labels, count }; line pixels are -1.
  function labelRegions(lines, w, h) {
    const labels = new Int32Array(w * h).fill(-2);
    for (let i = 0; i < labels.length; i += 1) if (lines[i]) labels[i] = -1;
    let count = 0;
    const stack = [];
    for (let s = 0; s < labels.length; s += 1) {
      if (labels[s] !== -2) continue;
      labels[s] = count;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        if (x > 0 && labels[i - 1] === -2) { labels[i - 1] = count; stack.push(i - 1); }
        if (x < w - 1 && labels[i + 1] === -2) { labels[i + 1] = count; stack.push(i + 1); }
        if (i >= w && labels[i - w] === -2) { labels[i - w] = count; stack.push(i - w); }
        if (i < w * (h - 1) && labels[i + w] === -2) { labels[i + w] = count; stack.push(i + w); }
      }
      count += 1;
    }
    return { labels, count };
  }

  // Every area bounded by the lines gets its mean colour; the line pixels take the colour of a neighbouring area.
  function regionFill(rgba, w, h, lines) {
    const { labels, count } = labelRegions(lines, w, h);
    const sum = new Float64Array(count * 4);
    const num = new Uint32Array(count);
    for (let i = 0; i < labels.length; i += 1) {
      const l = labels[i];
      if (l < 0) continue;
      sum[l * 4] += rgba[i * 4];
      sum[l * 4 + 1] += rgba[i * 4 + 1];
      sum[l * 4 + 2] += rgba[i * 4 + 2];
      sum[l * 4 + 3] += rgba[i * 4 + 3];
      num[l] += 1;
    }
    const out = new Uint8ClampedArray(rgba);
    for (let i = 0; i < labels.length; i += 1) {
      let l = labels[i];
      if (l < 0) {
        l = -1;
        const x = i % w;
        if (x > 0 && labels[i - 1] >= 0) l = labels[i - 1];
        else if (x < w - 1 && labels[i + 1] >= 0) l = labels[i + 1];
        else if (i >= w && labels[i - w] >= 0) l = labels[i - w];
        else if (i < w * (h - 1) && labels[i + w] >= 0) l = labels[i + w];
        if (l < 0) continue;
      }
      out[i * 4] = sum[l * 4] / num[l];
      out[i * 4 + 1] = sum[l * 4 + 1] / num[l];
      out[i * 4 + 2] = sum[l * 4 + 2] / num[l];
      out[i * 4 + 3] = sum[l * 4 + 3] / num[l];
    }
    return out;
  }

  // Paint-bucket mask: the pixels connected to (x, y) whose colour is within `tol` of the seed (max channel difference).
  function floodMask(rgba, w, h, x, y, tol) {
    const mask = new Uint8Array(w * h);
    if (x < 0 || y < 0 || x >= w || y >= h) return mask;
    const s = (y * w + x) * 4;
    const sr = rgba[s];
    const sg = rgba[s + 1];
    const sb = rgba[s + 2];
    const sa = rgba[s + 3];
    const near = (i) => Math.max(Math.abs(rgba[i * 4] - sr), Math.abs(rgba[i * 4 + 1] - sg), Math.abs(rgba[i * 4 + 2] - sb), Math.abs(rgba[i * 4 + 3] - sa)) <= tol;
    const stack = [y * w + x];
    mask[y * w + x] = 1;
    while (stack.length) {
      const i = stack.pop();
      const px = i % w;
      const tryPush = (j) => {
        if (!mask[j] && near(j)) {
          mask[j] = 1;
          stack.push(j);
        }
      };
      if (px > 0) tryPush(i - 1);
      if (px < w - 1) tryPush(i + 1);
      if (i >= w) tryPush(i - w);
      if (i < w * (h - 1)) tryPush(i + w);
    }
    // One pixel of growth covers the anti-aliased rim next to a line.
    const grown = new Uint8Array(mask);
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i]) continue;
      const px = i % w;
      if (px > 0) grown[i - 1] = 1;
      if (px < w - 1) grown[i + 1] = 1;
      if (i >= w) grown[i - w] = 1;
      if (i < w * (h - 1)) grown[i + w] = 1;
    }
    return grown;
  }

  // SAM masks (binary, mw x mh) -> boundary lines at tw x th. Larger masks are painted first so small ones stay visible.
  function samLines(masks, mw, mh, tw, th, opt) {
    const keep = masks
      .filter((m) => m.iou >= opt.iou && m.stability >= 0.85 && m.area >= opt.minArea * mw * mh)
      .sort((a, b) => b.area - a.area);
    const label = new Int32Array(mw * mh);
    keep.forEach((m, k) => {
      const d = m.data;
      for (let i = 0; i < d.length; i += 1) if (d[i]) label[i] = k + 1;
    });
    const big = new Int32Array(tw * th);
    for (let y = 0; y < th; y += 1) {
      const sy = Math.min(mh - 1, Math.floor((y * mh) / th));
      for (let x = 0; x < tw; x += 1) big[y * tw + x] = label[sy * mw + Math.min(mw - 1, Math.floor((x * mw) / tw))];
    }
    const out = new Uint8Array(tw * th);
    for (let y = 0; y < th; y += 1) {
      for (let x = 0; x < tw; x += 1) {
        const i = y * tw + x;
        if ((x < tw - 1 && big[i] !== big[i + 1]) || (y < th - 1 && big[i] !== big[i + tw])) out[i] = 1;
      }
    }
    return out;
  }

  // Final picture: `pic` (RGBA) under the lines. opacity 0..1: 0 = white paper with the lines only, 1 = the picture itself.
  function compose(pic, w, h, lines, opacity) {
    const out = new Uint8ClampedArray(pic.length);
    for (let i = 0; i < w * h; i += 1) {
      const p = i * 4;
      if (lines && lines[i]) {
        out[p] = 20;
        out[p + 1] = 20;
        out[p + 2] = 20;
        out[p + 3] = 255;
        continue;
      }
      if (!lines) {
        out[p] = pic[p];
        out[p + 1] = pic[p + 1];
        out[p + 2] = pic[p + 2];
        out[p + 3] = pic[p + 3];
        continue;
      }
      const a = (pic[p + 3] / 255) * opacity;
      const alpha = a + (1 - opacity);
      out[p] = alpha ? (pic[p] * a + 255 * (1 - opacity)) / alpha : 255;
      out[p + 1] = alpha ? (pic[p + 1] * a + 255 * (1 - opacity)) / alpha : 255;
      out[p + 2] = alpha ? (pic[p + 2] * a + 255 * (1 - opacity)) / alpha : 255;
      out[p + 3] = alpha * 255;
    }
    return out;
  }

  root.SMEditorCore = { lumaOf, adjust, autoAdjust, detectSkew, canny, brightnessLines, labelRegions, regionFill, floodMask, samLines, compose };
})(typeof window !== 'undefined' ? window : globalThis);
