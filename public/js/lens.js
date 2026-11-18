(function () {
  const lens = document.getElementById('lens');
  const view = document.getElementById('view');
  const canvas = document.getElementById('zc');
  const canvas2d = document.getElementById('zc2');
  const ctx2d = canvas2d.getContext('2d');
  let aiData = null; // latest AI frame (RGBA), also used by the CPU drawing path
  const handle = document.getElementById('handle');
  const bg = document.getElementById('bg');
  const bgv = document.getElementById('bgv');
  // Frozen: `src` is the still picture. Live: `src` is the screen stream (no AI then, the filter is used).
  let live = false;
  let src = bg;
  const srcW = () => (live ? bgv.videoWidth : bg.naturalWidth);
  const aiLabel = document.getElementById('ai');
  const hintText = document.getElementById('hint').firstChild;
  const warnLabel = document.getElementById('warn');
  const MIN_SCALE = 0.5;
  // Magnification: displayed pixels per screen pixel, stepped exactly like the result window of ScreenMagnify.
  let mag = 3;
  let lastWheelAt = 0;
  let scale = 1;
  let maxScale = 2;
  let sizePct = 10; // start width of the lens, percent of the display width
  const badge = document.getElementById('badge');
  let badgeTimer = null;
  let cx = innerWidth / 2;
  let cy = innerHeight / 2;
  let baseW = 0;
  let baseH = 0;
  let round = false;
  let cfg = { method: 'bilinear', aiMaxSize: -1, aiDevice: 'cpu' };
  let upscaler = null;
  const crop = document.createElement('canvas');
  const cropCtx = crop.getContext('2d', { willReadFrequently: true });
  // The AI frame is valid only for the exact source rectangle it was computed for.
  let aiModel = null;
  let aiReady = false;
  let aiProvider = null;
  let aiBusy = false;
  let aiKey = '';
  let aiFrameKey = '';
  let aiTimer = null;
  let lastAiMs = 0;
  let tooBig = false;
  let hadPointer = false; // the pointer started on this display or has been over it
  let aiFailures = 0;
  let retryTimer = null;
  let liveLoopStarted = false;

  // Sizes of the cartoon frame follow the lens size (--u = shorter side).
  function positionHandle(lw, lh) {
    const u = Math.min(lw, lh);
    const t = Math.max(8, Math.min(22, u * 0.07));
    const hw = Math.max(16, Math.min(34, u * 0.1));
    lens.style.setProperty('--u', `${u}px`);
    lens.style.setProperty('--t', `${t}px`);
    lens.style.setProperty('--hw', `${hw}px`);
    handle.style.zIndex = '-1';
    if (round) {
      // Handle leaves the ring toward the lower left, as in the reference drawing.
      // Start inside the ring thickness so the ring covers the joint.
      const r = lw / 2 + t * 0.3;
      handle.style.height = `${Math.max(60, lw * 0.45)}px`;
      handle.style.left = `${lw / 2 - r * Math.SQRT1_2 - hw / 2}px`;
      handle.style.top = `${lh / 2 + r * Math.SQRT1_2}px`;
      handle.style.transform = 'rotate(45deg)';
    } else {
      // A rectangle gets a straight handle at the bottom centre.
      handle.style.height = `${Math.max(46, lh * 0.4)}px`;
      handle.style.left = `${lw / 2 - hw / 2}px`;
      handle.style.top = `${lh + t * 0.3}px`;
      handle.style.transform = 'none';
    }
  }

  function render() {
    const lw = baseW * scale;
    const lh = baseH * scale;
    lens.style.width = `${lw}px`;
    lens.style.height = `${lh}px`;
    lens.style.left = `${cx - lw / 2}px`;
    lens.style.top = `${cy - lh / 2}px`;
    positionHandle(lw, lh);
    if (lens.style.display !== 'none') draw();
  }

  function clampZoom(value) {
    return Math.round(Math.min(64, Math.max(0.5, value)) * 2) / 2;
  }

  // Same as ScreenMagnify: fine 0.5 steps at low magnification, progressively coarser steps at high magnification.
  function nextZoom(value, dir) {
    const edge = dir > 0 ? value : value - 0.001;
    const step = edge < 4 ? 0.5 : edge < 8 ? 1 : edge < 16 ? 2 : edge < 32 ? 4 : 8;
    return clampZoom(value + dir * step);
  }

  // Source rectangle (in picture pixels) that fills the lens interior at the current magnification.
  function sourceRect() {
    const k = srcW() / innerWidth;
    const dpr = window.devicePixelRatio || 1;
    const w = (view.clientWidth * dpr) / mag;
    const h = (view.clientHeight * dpr) / mag;
    return { x: Math.round(cx * k - w / 2), y: Math.round(cy * k - h / 2), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  // Largest region side the AI runs on: -1 = the whole lens region, 0 = table by model and device.
  function aiLimit() {
    if (cfg.aiMaxSize === -1) return Infinity;
    const gpu = cfg.aiDevice === 'gpu' && aiProvider !== 'cpu';
    return SM.aiLimit(cfg.method, gpu ? 'gpu' : 'cpu', cfg.aiMaxSize);
  }

  // With no side limit (-1) a huge region would still take minutes on the CPU (about 0.7 s per 192 px tile):
  // cap the area so the request cannot run into the 120 s timeout. An explicit px limit is the user's choice.
  function aiAreaBudget() {
    const gpu = cfg.aiDevice === 'gpu' && aiProvider !== 'cpu';
    return gpu ? 4000000 : 1000000;
  }

  function aiTooBig() {
    if (Math.max(crop.width, crop.height) > aiLimit()) return true;
    return cfg.aiMaxSize === -1 && crop.width * crop.height > aiAreaBudget();
  }

  function setLabel() {
    if (!SM.isAI(cfg.method)) aiLabel.textContent = '';
    else if (tooBig && cfg.aiMaxSize === -1) aiLabel.textContent = `AI 대기 · 영역이 너무 커서 Bilinear (약 ${Math.round(aiAreaBudget() / 10000)}만 화소 이하에서 동작)`;
    else if (tooBig) aiLabel.textContent = `AI 대기 · 영역이 커서 Bilinear (${aiLimit()}px 이하에서 동작)`;
    else if (aiLabel.textContent.startsWith('AI 대기')) aiLabel.textContent = '';
  }

  // AI methods stand in with bilinear while an AI frame is pending.
  const filterId = () => SM.glFor(cfg.method);

  // Same split as ScreenMagnify: device CPU draws with the JS resampler, device GPU with WebGL.
  const useGpu = () => cfg.aiDevice === 'gpu';

  function draw() {
    if (!srcW()) return;
    if (useGpu() && !upscaler) return;
    const dpr = window.devicePixelRatio || 1;
    const outW = Math.max(1, Math.round(view.clientWidth * dpr));
    const outH = Math.max(1, Math.round(view.clientHeight * dpr));
    const r = sourceRect();
    if (crop.width !== r.w || crop.height !== r.h) {
      crop.width = r.w;
      crop.height = r.h;
    }
    cropCtx.fillStyle = '#000';
    cropCtx.fillRect(0, 0, r.w, r.h);
    cropCtx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    aiKey = `${r.x}|${r.y}|${r.w}|${r.h}`;
    const aiFrame = SM.isAI(cfg.method) && aiReady && aiFrameKey === aiKey && aiData;
    canvas.style.display = useGpu() ? 'block' : 'none';
    canvas2d.style.display = useGpu() ? 'none' : 'block';
    if (useGpu()) {
      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
      }
      const rect = { x: 0, y: 0, w: outW, h: outH };
      if (aiFrame) {
        upscaler.drawAI(rect);
        return;
      }
      upscaler.method = filterId();
      upscaler.resize(outW, outH);
      upscaler.drawCrop(crop, rect);
    } else {
      if (canvas2d.width !== outW || canvas2d.height !== outH) {
        canvas2d.width = outW;
        canvas2d.height = outH;
      }
      let out;
      if (aiFrame) {
        // Shrinking the x4 result needs a wide kernel to stay clean; enlarging it keeps the soft bilinear look.
        out = SM.resample(aiData.data, aiData.w, aiData.h, outW, outH, outW < aiData.w ? 'lanczos3' : 'bilinear');
        ctx2d.putImageData(new ImageData(out, outW, outH), 0, 0);
        return;
      }
      const pixels = cropCtx.getImageData(0, 0, r.w, r.h).data;
      out = SM.resample(pixels, r.w, r.h, outW, outH, filterId());
      ctx2d.putImageData(new ImageData(out, outW, outH), 0, 0);
    }
    // The filter result stands in until the AI frame for this exact view is ready.
    scheduleAI();
  }

  function scheduleAI() {
    // A live screen is driven by liveAiLoop instead: every frame changes the picture.
    if (live || !SM.isAI(cfg.method) || !aiReady) return;
    const big = aiTooBig();
    if (big !== tooBig) {
      tooBig = big;
      setLabel();
    }
    clearTimeout(aiTimer); // a timer set for an earlier, smaller view must not fire on a big one
    if (big) return;
    aiTimer = setTimeout(runAI, Math.max(180, lastAiMs));
  }

  async function runAI(force) {
    if (aiBusy) {
      scheduleAI();
      return;
    }
    const key = aiKey;
    if (!force && aiFrameKey === key) return;
    // The view can have grown since this run was scheduled: check the size again before starting.
    if (aiTooBig()) {
      tooBig = true;
      setLabel();
      return;
    }
    aiBusy = true;
    if (!live) aiLabel.textContent = 'AI 처리 중';
    try {
      // Full resolution input (the worker tiles big regions); the model never sees a shrunken picture.
      const data = cropCtx.getImageData(0, 0, crop.width, crop.height).data;
      const started = Date.now();
      const result = await window.api.ai.infer({ width: crop.width, height: crop.height, data: data.buffer, model: aiModel });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'AI 처리 실패');
      lastAiMs = Date.now() - started;
      aiProvider = result.provider || aiProvider;
      aiData = { data: new Uint8ClampedArray(result.data), w: result.width, h: result.height };
      if (upscaler) upscaler.uploadAI(aiData.data, aiData.w, aiData.h);
      aiFrameKey = key;
      aiFailures = 0;
      if (!live) aiLabel.textContent = '';
    } catch (error) {
      failAI(error.message);
    } finally {
      aiBusy = false;
    }
    // The view may have moved while the model was running.
    if (aiReady) draw();
  }

  // Live screen: run the model back to back on the newest frame of the region under the lens.
  // The picture shown lags behind the screen by the time one pass takes; the AI frame is used only while the lens stays put.
  async function liveAiLoop() {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (;;) {
      if (!aiReady || lens.style.display === 'none' || !crop.width) {
        await sleep(150);
        continue;
      }
      const big = aiTooBig();
      if (big !== tooBig) {
        tooBig = big;
        setLabel();
      }
      if (big) {
        await sleep(150);
        continue;
      }
      await runAI(true);
    }
  }

  // An AI failure switches the AI off for the moment; reload the model a few times by itself, then wait for the R key.
  function failAI(message) {
    aiReady = false;
    aiFrameKey = '';
    clearTimeout(retryTimer);
    if (aiFailures < 3) {
      aiFailures += 1;
      aiLabel.textContent = `AI 오류: ${message} · 다시 시도합니다 (${aiFailures}/3)`;
      retryTimer = setTimeout(initAI, 2000 * aiFailures);
    } else {
      aiLabel.textContent = `AI 오류: ${message} · R 키로 다시 시도`;
    }
  }

  function initAI() {
    if (!SM.isAI(cfg.method)) return;
    aiModel = SM.modelOf(cfg.method);
    aiLabel.textContent = 'AI 준비 중 · 우선 Bilinear';
    window.api.ai.ensure(aiModel).then((result) => {
      if (!result || result.ok === false) throw new Error((result && result.error) || '모델 로드 실패');
      aiReady = true;
      aiProvider = result.provider || aiProvider;
      aiLabel.textContent = '';
      draw();
      if (live && !liveLoopStarted) {
        liveLoopStarted = true;
        liveAiLoop();
      }
    }).catch((error) => failAI(error.message));
  }

  window.api.lens.onInit(({ image, live: isLive, sourceId, physical, shape, sizePercent, lensMaxScale, lensStyle, cursor, method, aiMaxSize, aiDevice }) => {
    // Keep the page invisible until the picture is decoded; the main process shows the window on 'ready'.
    document.body.style.visibility = 'hidden';
    cfg = { method, aiMaxSize, aiDevice };
    live = isLive;
    document.body.className = lensStyle;
    // Circle is 1:1, rectangle is 4:3 (wider). Size is a percentage of the display width.
    round = shape === 'ellipse';
    // Never wider than half the display, whatever the multiple.
    sizePct = sizePercent;
    maxScale = Math.max(1, Math.min(lensMaxScale, 50 / sizePercent));
    baseW = Math.round((innerWidth * sizePercent) / 100);
    baseH = round ? baseW : Math.round((baseW * 3) / 4);
    view.style.borderRadius = round ? '50%' : '4px';
    document.getElementById('ring').style.borderRadius = round ? '50%' : '14px';
    // Start under the cursor so the pointer is already inside the lens.
    if (cursor) {
      cx = cursor.x;
      cy = cursor.y;
      hadPointer = true;
    } else {
      lens.style.display = 'none';
    }
    const start = () => {
      if (useGpu()) upscaler = new SM.Upscaler(canvas);
      document.body.style.visibility = 'visible';
      render();
      if (live) {
        hintText.textContent = '실시간 화면, Press ESC to continue';
        if (SM.isAI(cfg.method)) {
          warnLabel.textContent = '동영상(실시간 화면)에서 AI 모델로 확대하면 지연이 있을 수 있습니다';
          initAI();
        }
        // The picture keeps changing, so redraw continuously while the lens is shown.
        const tick = () => {
          requestAnimationFrame(tick);
          if (lens.style.display !== 'none' && !window.SMSave.isOpen) draw();
        };
        tick();
      } else {
        initAI();
      }
      requestAnimationFrame(() => window.api.lens.ready());
    };
    if (live) {
      src = bgv;
      bg.style.display = 'none';
      bgv.style.display = 'block';
      // Stream this display; the lens window itself is excluded from the capture by the main process.
      // Ask for the exact size first and fall back to whatever the capture backend gives (mixed DPI can refuse it).
      const request = (size) => navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30, ...size } }
      });
      request({ minWidth: physical.width, maxWidth: physical.width, minHeight: physical.height, maxHeight: physical.height })
        .catch(() => request({}))
        .then((stream) => {
          bgv.srcObject = stream;
          return bgv.play();
        })
        .then(start)
        .catch((error) => window.api.lens.fail(`실시간 화면을 가져오지 못했습니다: ${error.message}`));
    } else {
      const url = URL.createObjectURL(new Blob([image], { type: 'image/png' }));
      bg.src = url;
      bg.decode()
        .then(() => URL.revokeObjectURL(url))
        .then(start)
        .catch((error) => window.api.lens.fail(`화면 그림을 불러오지 못했습니다: ${error.message}`));
    }
  });

  // Shows the magnification (or lens size) inside the lens for a moment, in the style of ScreenMagnify's HUD.
  function showBadge(text) {
    badge.textContent = text;
    // 44 px like ScreenMagnify, but never more than about a quarter of the lens height (and it must fit the width).
    badge.style.fontSize = `${Math.max(12, Math.min(44, view.clientHeight * (round ? 0.2 : 0.26), (view.clientWidth * 0.7) / Math.max(4, text.length * 0.62)))}px`;
    // On a round lens the corner is cut off, so pull the plate in until it sits inside the circle.
    badge.style.right = round ? `${view.clientWidth * 0.17}px` : '10px';
    badge.style.bottom = round ? `${view.clientHeight * 0.17}px` : '8px';
    badge.classList.add('show');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.classList.remove('show'), 1600);
  }

  // The picture the lens shows right now, as a canvas: transparent outside a round lens (like ScreenMagnify's save).
  function lensSnapshot() {
    // A window that never saw the pointer has no meaningful lens position: another window answers instead.
    if (!hadPointer) return null;
    // Right after the start the lens can still be hidden (no pointer event yet); show it just for the picture.
    const wasHidden = lens.style.display === 'none';
    if (wasHidden) lens.style.display = 'block';
    draw(); // make sure the canvas holds the newest frame (a pointer event may not have been drawn yet)
    if (wasHidden) lens.style.display = 'none';
    const source = useGpu() ? canvas : canvas2d;
    if (!source.width || !source.height) return null;
    const out = document.createElement('canvas');
    out.width = source.width;
    out.height = source.height;
    const ctx = out.getContext('2d');
    if (round) {
      ctx.beginPath();
      ctx.ellipse(out.width / 2, out.height / 2, out.width / 2, out.height / 2, 0, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(source, 0, 0);
    return out;
  }
  window.SMSave.setProvider(lensSnapshot);

  // Pointer events can arrive faster than frames (120 Hz mice): draw at most once per frame.
  let rafPending = false;
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  // One lens window per display: only the display under the cursor shows the lens.
  document.documentElement.addEventListener('mouseleave', () => { if (!window.SMSave.isOpen) lens.style.display = 'none'; });
  document.documentElement.addEventListener('mouseenter', () => { window.focus(); });
  const channel = new BroadcastChannel('lens-state');
  channel.onmessage = (e) => {
    if (e.data.save) {
      // Another window got Ctrl+S but has no lens: the window the pointer is on saves (it also needs the keyboard focus).
      if (hadPointer && lens.style.display !== 'none' && !window.SMSave.isOpen) {
        window.focus();
        window.SMSave.open();
      }
      return;
    }
    mag = e.data.mag;
    scale = e.data.scale;
    requestRender();
  };
  window.addEventListener('pointermove', (e) => {
    if (window.SMSave.isOpen) return;
    hadPointer = true;
    lens.style.display = 'block';
    cx = e.clientX;
    cy = e.clientY;
    requestRender();
  });
  window.addEventListener('wheel', (e) => {
    if (window.SMSave.isOpen) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt < 24) return;
    lastWheelAt = now;
    const dir = e.deltaY < 0 ? 1 : -1;
    if (e.ctrlKey) {
      // Lens size: steps of 5 % of the display width, between half the start size and the maximum.
      const pct = sizePct * scale + dir * 5;
      scale = Math.max(MIN_SCALE, Math.min(maxScale, pct / sizePct));
    } else {
      mag = nextZoom(mag, dir);
    }
    showBadge(e.ctrlKey ? `화면 ${Math.round(sizePct * scale * 10) / 10}%` : `x${mag.toFixed(1)}`);
    channel.postMessage({ mag, scale });
    render();
  }, { passive: false });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (window.SMSave.isOpen) return;
    window.api.lens.close();
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (window.SMSave.isOpen) return;
      if (hadPointer) window.SMSave.open();
      else channel.postMessage({ save: true }); // the pointer is on another display
      return;
    }
    if (window.SMSave.isOpen) return; // typing in the dialog
    if (e.key === 'Escape') window.api.lens.close();
    // Retry the AI by hand after the automatic retries gave up.
    if ((e.key === 'r' || e.key === 'R') && SM.isAI(cfg.method) && !aiReady && !aiBusy) {
      aiFailures = 0;
      clearTimeout(retryTimer);
      initAI();
    }
  });

  // The AI worker reports crashes and exits; show them and reload the model.
  window.api.ai.onEvent((event) => {
    if (!event || !aiReady || !SM.isAI(cfg.method)) return;
    if (event.type === 'error') failAI(event.message || 'AI 오류');
    else if (event.type === 'provider' && !event.provider) failAI('AI 워커가 종료되었습니다');
  });
})();
