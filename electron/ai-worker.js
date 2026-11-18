const { parentPort, workerData } = require('worker_threads');

let ort = null;
let session = null;
let currentModel = null;
let currentDevice = null;
let provider = null;
let queue = Promise.resolve();

const BUCKETS = [64, 128, 192, 256, 384, 512, 768];

function loadOrt() {
  if (!ort) {
    ort = require('onnxruntime-node');
    try {
      ort.env.logLevel = 'error';
    } catch {
      // Ignore.
    }
  }
  return ort;
}

function modelPath(model) {
  const file = workerData.files[model] || workerData.files.realesrgan;
  return require('path').join(workerData.modelDir, file);
}

function bucketFor(maxSize) {
  for (const size of BUCKETS) {
    if (maxSize <= size) return size;
  }
  return BUCKETS[BUCKETS.length - 1];
}

async function ensureSession(model, device) {
  const targetModel = model || 'realesrgan';
  const targetDevice = device === 'gpu' ? 'gpu' : 'cpu';
  if (session && currentModel === targetModel && currentDevice === targetDevice) return;
  if (session) {
    try {
      await session.release();
    } catch {
      // Ignore.
    }
    session = null;
  }

  const runtime = loadOrt();
  const file = modelPath(targetModel);
  let next = null;
  let nextProvider = 'cpu';
  if (targetDevice === 'gpu') {
    try {
      next = await runtime.InferenceSession.create(file, {
        executionProviders: ['dml'],
        graphOptimizationLevel: 'all'
      });
      nextProvider = 'dml';
    } catch (error) {
      console.error('DML session failed, falling back to CPU:', error.message);
    }
  }
  if (!next) {
    next = await runtime.InferenceSession.create(file, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    });
  }

  session = next;
  currentModel = targetModel;
  currentDevice = targetDevice;
  provider = nextProvider;
  parentPort.postMessage({ type: 'provider', provider });
}

// One model pass on an input of at most 256 px per side (padded by edge replication to a fixed bucket).
function inferSingle(rgba, width, height) {
  const runtime = loadOrt();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const size = bucketFor(Math.max(width, height));
  const plane = size * size;
  const data = new Float32Array(plane * 3);

  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(height - 1, y);
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(width - 1, x);
      const sourceIndex = (sy * width + sx) * 4;
      const targetIndex = y * size + x;
      data[targetIndex] = rgba[sourceIndex] / 255;
      data[plane + targetIndex] = rgba[sourceIndex + 1] / 255;
      data[plane * 2 + targetIndex] = rgba[sourceIndex + 2] / 255;
    }
  }

  const input = new runtime.Tensor('float32', data, [1, 3, size, size]);
  return session.run({ [inputName]: input }).then((outputs) => {
    const output = outputs[outputName];
    const dims = output.dims;
    const outSize = dims[dims.length - 1];
    const outH = dims[dims.length - 2];
    const outPlane = outSize * outH;
    const source = output.data;

    const outW = width * 4;
    const outHeight = height * 4;
    const result = new Uint8ClampedArray(outW * outHeight * 4);

    for (let y = 0; y < outHeight; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const sourceIndex = y * outSize + x;
        const targetIndex = (y * outW + x) * 4;
        result[targetIndex] = Math.max(0, Math.min(255, Math.round(source[sourceIndex] * 255)));
        result[targetIndex + 1] = Math.max(0, Math.min(255, Math.round(source[outPlane + sourceIndex] * 255)));
        result[targetIndex + 2] = Math.max(0, Math.min(255, Math.round(source[outPlane * 2 + sourceIndex] * 255)));
        result[targetIndex + 3] = 255;
      }
    }

    return { data: result, width: outW, height: outHeight };
  });
}

const TILE_MAX = 256; // largest single pass
const TILE_CORE = 192; // pixels kept from each tile
const TILE_PAD = 32; // extra context around the core so tile seams do not show

// Full-resolution input (no shrinking): big inputs run as overlapping tiles and are stitched.
async function inferRgba(rgba, width, height) {
  if (Math.max(width, height) <= TILE_MAX) return inferSingle(rgba, width, height);
  const outW = width * 4;
  const outH = height * 4;
  const result = new Uint8ClampedArray(outW * outH * 4);
  for (let cy = 0; cy < height; cy += TILE_CORE) {
    for (let cx = 0; cx < width; cx += TILE_CORE) {
      const cw = Math.min(TILE_CORE, width - cx);
      const ch = Math.min(TILE_CORE, height - cy);
      const x0 = Math.max(0, cx - TILE_PAD);
      const y0 = Math.max(0, cy - TILE_PAD);
      const x1 = Math.min(width, cx + cw + TILE_PAD);
      const y1 = Math.min(height, cy + ch + TILE_PAD);
      const tw = x1 - x0;
      const th = y1 - y0;
      const tile = new Uint8ClampedArray(tw * th * 4);
      for (let y = 0; y < th; y += 1) {
        const from = ((y0 + y) * width + x0) * 4;
        tile.set(rgba.subarray(from, from + tw * 4), y * tw * 4);
      }
      const out = await inferSingle(tile, tw, th);
      for (let y = 0; y < ch * 4; y += 1) {
        const from = ((cy - y0) * 4 + y) * out.width * 4 + (cx - x0) * 4 * 4;
        const to = ((cy * 4 + y) * outW + cx * 4) * 4;
        result.set(out.data.subarray(from, from + cw * 4 * 4), to);
      }
    }
  }
  return { data: result, width: outW, height: outH };
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'init') {
    try {
      await ensureSession(message.model, message.device);
      parentPort.postMessage({ type: 'ready', id: message.id, provider });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        id: message.id,
        message: `AI 모델을 불러오지 못했습니다: ${error.message}`
      });
    }
    return;
  }

  if (message.type === 'infer') {
    try {
      await ensureSession(message.model, message.device);
      const bytes = message.data instanceof Uint8Array
        ? message.data
        : new Uint8Array(message.data);
      const output = await inferRgba(bytes, message.width, message.height);
      parentPort.postMessage({
        type: 'result',
        id: message.id,
        width: output.width,
        height: output.height,
        data: output.data.buffer,
        provider
      }, [output.data.buffer]);
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        id: message.id,
        message: error.message || 'AI 처리에 실패했습니다.'
      });
    }
  }
}

parentPort.on('message', (message) => {
  queue = queue.then(() => handle(message)).catch((error) => {
    parentPort.postMessage({ type: 'worker-error', message: error.message || 'AI 워커 오류' });
  });
});

process.on('uncaughtException', (error) => {
  parentPort.postMessage({ type: 'worker-error', message: error.message || 'AI 워커 오류' });
});

process.on('unhandledRejection', (error) => {
  const message = error && error.message ? error.message : 'AI 워커 오류';
  parentPort.postMessage({ type: 'worker-error', message });
});
