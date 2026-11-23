// MobileSAM in a worker thread: one image encoding, then automatic masks from a grid of point prompts.
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

let ort = null;
let encoder = null;
let decoder = null;
let embeddings = null; // tensor of the last encoded image
let inputSize = null; // { w, h } of the encoded image (long side 1024)
let queue = Promise.resolve();

async function sessions() {
  if (!ort) {
    ort = require('onnxruntime-node');
    try {
      ort.env.logLevel = 'error';
    } catch {
      // Ignore.
    }
  }
  if (!encoder) {
    encoder = await ort.InferenceSession.create(path.join(workerData.modelDir, workerData.encoder), { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    decoder = await ort.InferenceSession.create(path.join(workerData.modelDir, workerData.decoder), { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
  }
}

// rgba: the picture resized so that its long side is 1024.
async function encode(message) {
  await sessions();
  const { width, height } = message;
  const rgba = new Uint8Array(message.data);
  const input = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1) {
    input[j++] = rgba[i * 4];
    input[j++] = rgba[i * 4 + 1];
    input[j++] = rgba[i * 4 + 2];
  }
  const out = await encoder.run({ input_image: new ort.Tensor('float32', input, [height, width, 3]) });
  embeddings = out.image_embeddings;
  inputSize = { w: width, h: height };
  return { type: 'encoded' };
}

// n x n grid of single point prompts. Masks come back binary at outW x outH, near duplicates removed.
async function decodeGrid(message) {
  await sessions();
  if (!embeddings) throw new Error('이미지가 아직 분석되지 않았습니다.');
  const { grid, outW, outH } = message;
  const masks = [];
  const size = outW * outH;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const px = ((gx + 0.5) / grid) * inputSize.w;
      const py = ((gy + 0.5) / grid) * inputSize.h;
      const out = await decoder.run({
        image_embeddings: embeddings,
        point_coords: new ort.Tensor('float32', new Float32Array([px, py, 0, 0]), [1, 2, 2]),
        point_labels: new ort.Tensor('float32', new Float32Array([1, -1]), [1, 2]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor('float32', new Float32Array([outH, outW]), [2])
      });
      const logits = out.masks.data;
      const iou = out.iou_predictions.data[0];
      const bin = new Uint8Array(size);
      let area = 0;
      let inner = 0;
      let outer = 0;
      for (let i = 0; i < size; i += 1) {
        const v = logits[i];
        if (v > 0) {
          bin[i] = 1;
          area += 1;
        }
        if (v > 1) inner += 1;
        if (v > -1) outer += 1;
      }
      if (area < size * 0.0005 || area > size * 0.95) continue;
      const stability = outer ? inner / outer : 0;
      // Drop a mask that overlaps an already kept one almost completely (keep the better score).
      let dup = -1;
      for (let k = 0; k < masks.length; k += 1) {
        const other = masks[k];
        let both = 0;
        for (let i = 0; i < size; i += 1) if (bin[i] && other.data[i]) both += 1;
        if (both / (area + other.area - both) > 0.9) {
          dup = k;
          break;
        }
      }
      const entry = { data: bin, iou, stability, area };
      if (dup < 0) masks.push(entry);
      else if (iou > masks[dup].iou) masks[dup] = entry;
    }
  }
  return { type: 'decoded', width: outW, height: outH, masks };
}

parentPort.on('message', (message) => {
  queue = queue.then(async () => {
    try {
      const result = message.type === 'encode' ? await encode(message) : await decodeGrid(message);
      const transfer = result.masks ? result.masks.map((m) => m.data.buffer) : [];
      parentPort.postMessage({ ...result, id: message.id }, transfer);
    } catch (error) {
      parentPort.postMessage({ type: 'error', id: message.id, message: error.message });
    }
  });
});
