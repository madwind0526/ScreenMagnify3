(function () {
  const $ = (id) => document.getElementById(id);
  const panelsWrap = $('panels');
  const methodSelect = $('method-select');
  const zoomValue = $('zoom-value');
  const hud = $('hud');
  const toastEl = $('toast');
  const captureStatus = $('capture-status');
  const captureStatusText = $('capture-status-text');
  const errorCard = $('error-card');
  const errorText = $('error-text');
  const modelInfo = $('model-info');
  const aiBadge = $('ai-badge');
  const aiBadgeText = $('ai-badge-text');

  const EMPTY = { x: 0, y: 0, w: 0, h: 0 };

  let settings = null;
  let selection = null;
  let sourceId = null;
  let stillBytes = null; // PNG of the whole display from the main process (no mouse cursor)
  let displaySize = null;

  let video = null;
  let stream = null;
  let capturing = false;
  let ready = false;

  let scaleX = 1;
  let scaleY = 1;
  let base = { ...EMPTY };
  let zoom = 1;
  let center = { x: 0, y: 0 };

  let panels = [];
  let active = 0;
  let viewVersion = 0;
  let panDrag = null;
  let lastWheelAt = 0;
  let hudTimer = null;
  let toastTimer = null;

  let aiReady = false;
  let aiProvider = null;
  let aiError = null;
  let aiLoaded = null;
  let aiBusy = false;
  let aiPendingPanel = -1;
  let lastAiAt = 0;
  let aiTooBig = false; // the visible region exceeds the AI input limit, so the AI is skipped
  let lastAiMs = 0; // duration of the last inference: the next one waits at least that long
  let aiInferErrorShown = false;
  let aiTimer = null;

  const aiCanvas = document.createElement('canvas');
  const aiCtx = aiCanvas.getContext('2d', { willReadFrequently: true });
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  let cropKey = '';

  const saveState = {
    dir: '',
    parent: null,
    presets: [],
    entries: [],
    loading: false,
    saving: false,
    token: 0,
    selected: ''
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function cue(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function useGpu() {
    return !!settings && settings.aiDevice === 'gpu';
  }

  // GPU: WebGL canvas (created lazily). CPU: separate 2D canvas drawn with JS resampling.
  function applyPanelDevice(panel) {
    const gpu = useGpu();
    if (gpu && !panel.upscaler) {
      panel.upscaler = new SM.Upscaler(panel.canvasGl);
      // After a GL context restore: the textures are empty, so upload the AI frame again and redraw.
      panel.upscaler.onRestore = () => {
        if (panel.aiData) panel.upscaler.uploadAI(panel.aiData.data, panel.aiData.w, panel.aiData.h);
        panel.lastKey = null;
      };
      panel.upscaler.onShaderError = (key) => toast(`${key.toUpperCase()} 셰이더를 만들지 못해 단순 확대로 표시합니다.`, true);
    }
    panel.canvas = gpu ? panel.canvasGl : panel.canvasCpu;
    panel.canvasGl.style.display = gpu ? 'block' : 'none';
    panel.canvasCpu.style.display = gpu ? 'none' : 'block';
    if (gpu) panel.upscaler.setMethod(SM.glFor(panel.method));
    panel.lastKey = null;
    resizePanel(panel);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3400);
  }

  function formatZoom(value) {
    return `x${value.toFixed(1)}`;
  }

  // `zoom` is relative to the selection filling the panel (1 = fit). The shown magnification is what the user
  // sees: displayed physical pixels per original screen pixel = fit factor x zoom.
  function fitFactor() {
    const panel = panels[active] || panels[0];
    if (!panel || !base.w) return 1;
    const content = contentRectCss(panel);
    return content.w > 0 ? (content.w * (window.devicePixelRatio || 1)) / base.w : 1;
  }

  function magnification() {
    return zoom * fitFactor();
  }

  function updateZoomUI() {
    const text = formatZoom(magnification());
    zoomValue.textContent = text;
    hud.textContent = text;
  }

  function showHud() {
    hud.classList.add('show');
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('show'), 1600);
  }

  function setCaptureStatus(text, visible) {
    if (text) captureStatusText.textContent = text;
    captureStatus.classList.toggle('hidden', !visible);
  }

  function showError(message) {
    ready = false;
    setCaptureStatus('', false);
    errorText.textContent = message || '다른 화면을 선택하거나 다시 시도하세요.';
    errorCard.classList.remove('hidden');
  }

  function hideError() {
    errorCard.classList.add('hidden');
  }

  // The selection aspect ratio is always preserved (letterboxed) so panels never distort.
  function contentRectFor(width, height) {
    if (!width || !height || !base.w || !base.h) {
      return { x: 0, y: 0, w: Math.max(1, width || 1), h: Math.max(1, height || 1) };
    }
    const aspect = base.w / base.h;
    let w = width;
    let h = height;
    if (width / height > aspect) {
      h = height;
      w = height * aspect;
    } else {
      w = width;
      h = width / aspect;
    }
    return {
      x: (width - w) / 2,
      y: (height - h) / 2,
      w,
      h
    };
  }

  function contentRectCss(panel) {
    const rect = panel.canvas.getBoundingClientRect();
    return contentRectFor(rect.width, rect.height);
  }

  function contentRectBacking(panel) {
    return contentRectFor(panel.canvas.width, panel.canvas.height);
  }

  function getView() {
    if (!video || !video.videoWidth) return { ...EMPTY };
    const cw = Math.max(1, base.w / zoom);
    const ch = Math.max(1, base.h / zoom);
    // Zoomed out past the image: keep it centered; otherwise stay inside the image.
    center.x = cw >= video.videoWidth ? video.videoWidth / 2 : clamp(center.x, cw / 2, video.videoWidth - cw / 2);
    center.y = ch >= video.videoHeight ? video.videoHeight / 2 : clamp(center.y, ch / 2, video.videoHeight - ch / 2);
    return {
      x: center.x - cw / 2,
      y: center.y - ch / 2,
      w: cw,
      h: ch
    };
  }

  // Part of the view that lies on the image (the rest is shown black when zoomed out).
  function visibleOf(view) {
    const x0 = Math.max(0, view.x);
    const y0 = Math.max(0, view.y);
    const x1 = Math.min(video.videoWidth, view.x + view.w);
    const y1 = Math.min(video.videoHeight, view.y + view.h);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  function sameView(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < 0.75 &&
      Math.abs(a.y - b.y) < 0.75 &&
      Math.abs(a.w - b.w) < 0.75 &&
      Math.abs(a.h - b.h) < 0.75;
  }

  function markViewChanged() {
    viewVersion += 1;
    for (const panel of panels) {
      panel.aiView = null;
      panel.aiFrame = false;
    }
  }

  function clampZoom(value) {
    return Math.round(clamp(value, 0.5, 64) * 2) / 2;
  }

  // Fine 0.5 steps at low zoom, progressively coarser steps at high zoom.
  function nextZoom(value, dir) {
    const edge = dir > 0 ? value : value - 0.001;
    const step = edge < 4 ? 0.5 : edge < 8 ? 1 : edge < 16 ? 2 : edge < 32 ? 4 : 8;
    return clampZoom(value + dir * step);
  }

  // `value` is a magnification (x0.5 to x64); the internal zoom is that divided by the fit factor.
  function setZoom(value) {
    const next = clampZoom(value) / fitFactor();
    if (Math.abs(next - zoom) < 1e-9) return;
    zoom = next;
    getView();
    markViewChanged();
    updateZoomUI();
    showHud();
  }

  function setActive(index) {
    if (!panels.length) return;
    active = clamp(index, 0, panels.length - 1);
    panels.forEach((panel, panelIndex) => {
      panel.el.classList.toggle('active', panelIndex === active);
    });
    methodSelect.value = panels[active].method;
    updateAIStatuses();
    if (SM.isAI(panels[active].method)) ensureAI();
  }

  const aiModels = {};

  // Input limit of the active panel's model on the device that really runs it.
  function activeAiLimit() {
    const gpu = settings && settings.aiDevice === 'gpu' && aiProvider !== 'cpu';
    const max = settings && settings.aiMaxSize;
    // -1: always process the whole selection (the captured picture is exactly the selection).
    if (max === -1 && video) return Math.max(video.videoWidth, video.videoHeight);
    return SM.aiLimit(panels[active] ? panels[active].method : settings.method, gpu ? 'gpu' : 'cpu', max);
  }

  // Shows the active method's model name, size and whether it runs on GPU or CPU.
  function updateModelInfo() {
    const panel = panels[active];
    if (!panel) return;
    const info = SM.byId(panel.method);
    let text;
    if (!SM.isAI(panel.method)) {
      text = `${info.label} · ${useGpu() ? 'GPU (WebGL2)' : 'CPU'}`;
    } else {
      const aiModel = aiModels[SM.modelOf(panel.method)];
      const size = aiModel && aiModel.size ? ` · ${(aiModel.size / 1048576).toFixed(aiModel.size < 10485760 ? 1 : 0)} MB` : '';
      let run = 'CPU 사용';
      if (aiError) run = '오류';
      else if (aiReady) run = aiProvider === 'cpu' ? (settings && settings.aiDevice === 'gpu' ? 'CPU 사용 (GPU 불가)' : 'CPU 사용') : 'GPU 사용 (DirectML)';
      text = `${aiModel ? aiModel.name : info.label}${size} · ${run}`;
    }
    modelInfo.textContent = text;
    modelInfo.title = text;
  }

  function updateAIStatuses() {
    updateModelInfo();
    const anyAI = panels.some((panel) => SM.isAI(panel.method));
    aiBadge.classList.toggle('hidden', !anyAI);
    aiBadge.classList.remove('ready', 'busy', 'slow', 'error');
    if (anyAI) {
      if (aiError) {
        aiBadge.classList.add('error');
        aiBadgeText.textContent = 'AI 오류';
      } else if (!aiReady) {
        aiBadge.classList.add('busy');
        aiBadgeText.textContent = 'AI 준비 중';
      } else if (aiBusy) {
        aiBadge.classList.add('busy');
        aiBadgeText.textContent = 'AI 처리 중';
      } else if (aiProvider === 'cpu') {
        aiBadge.classList.add('slow');
        aiBadgeText.textContent = 'AI · CPU (느림)';
      } else {
        aiBadge.classList.add('ready');
        aiBadgeText.textContent = 'AI · GPU';
      }
    }

    panels.forEach((panel, index) => {
      const isAI = SM.isAI(panel.method);
      panel.status.classList.toggle('hidden', !isAI);
      if (!isAI) return;
      panel.status.classList.remove('busy', 'error');
      if (aiError) {
        panel.status.classList.add('error');
        panel.statusText.textContent = 'AI 오류 · Bilinear';
        return;
      }
      if (!aiReady) {
        panel.status.classList.add('busy');
        panel.statusText.textContent = 'AI 준비 중 · Bilinear';
        return;
      }
      if (index !== active) {
        panel.statusText.textContent = 'AI 대기';
        return;
      }
      if (aiBusy && aiPendingPanel === index) {
        panel.status.classList.add('busy');
        panel.statusText.textContent = 'AI 처리 중';
        return;
      }
      panel.statusText.textContent = aiTooBig ? `AI 대기 · 영역이 커서 Bilinear (${Math.min(activeAiLimit(), Math.floor(Math.sqrt(SM.AI_MAX_PIXELS)))}px 이하에서 동작)` : (aiProvider === 'cpu' ? 'AI · CPU' : 'AI · GPU');
    });
  }

  function applyPanelMethod(panel, method) {
    let info = SM.byId(method);
    if (info.gpuOnly && !useGpu()) info = SM.byId(info.fallback || 'lanczos3');
    panel.method = info.id;
    panel.label.textContent = info.label;
    panel.head.title = info.desc || info.label;
    if (panel.upscaler) panel.upscaler.setMethod(SM.glFor(info.id));
    panel.aiFrame = false;
    panel.aiView = null;
    if (SM.isAI(info.id)) ensureAI();
    updateAIStatuses();
  }

  function resizePanel(panel) {
    const rect = panel.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    // The CPU path pays per pixel, so it renders at a lower density than WebGL.
    const dpr = Math.min(window.devicePixelRatio || 1, useGpu() ? 2 : 1.25);
    const backingW = Math.max(1, Math.round(width * dpr));
    const backingH = Math.max(1, Math.round(height * dpr));
    if (panel.canvas.width !== backingW || panel.canvas.height !== backingH) {
      panel.canvas.width = backingW;
      panel.canvas.height = backingH;
    }
    updateZoomUI();
  }

  function createPanelElement(index, method) {
    const el = document.createElement('div');
    el.className = 'panel';
    el.dataset.index = String(index);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'canvas-wrap';
    const canvasGl = document.createElement('canvas');
    const canvasCpu = document.createElement('canvas');
    canvasWrap.append(canvasGl, canvasCpu);

    const head = document.createElement('div');
    head.className = 'panel-head';
    const indexEl = document.createElement('span');
    indexEl.className = 'index';
    indexEl.textContent = String(index + 1);
    const label = document.createElement('span');
    label.className = 'method-name';
    head.append(indexEl, label);

    const status = document.createElement('div');
    status.className = 'panel-status hidden';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const statusText = document.createElement('span');
    status.append(dot, statusText);

    el.append(canvasWrap, head, status);
    panelsWrap.appendChild(el);

    return { el, canvasWrap, canvas: canvasCpu, canvasGl, canvasCpu, head, label, status, statusText };
  }

  function setupPanels() {
    clearPanels();
    const count = clamp(Number(settings.panelCount) || 1, 1, 3);
    panelsWrap.className = `panels count-${count}`;
    panels = [];

    for (let index = 0; index < count; index += 1) {
      const method = SM.defaultMethodFor(index, settings.method, settings.aiDevice);
      const parts = createPanelElement(index, method);
      const panel = {
        ...parts,
        index,
        method,
        upscaler: null,
        aiData: null,
        aiFrame: false,
        aiView: null,
        aiW: 0,
        aiH: 0,
        ro: null
      };

      panel.boundPointerDown = (event) => onPanelPointerDown(event, panel);
      panel.boundPointerMove = (event) => onPanelPointerMove(event, panel);
      panel.boundPointerUp = (event) => onPanelPointerUp(event, panel);
      panel.boundWheel = (event) => onPanelWheel(event, panel);
      panel.boundDoubleClick = () => resetView();

      parts.el.addEventListener('pointerdown', panel.boundPointerDown);
      parts.el.addEventListener('pointermove', panel.boundPointerMove);
      parts.el.addEventListener('pointerup', panel.boundPointerUp);
      parts.el.addEventListener('pointercancel', panel.boundPointerUp);
      parts.el.addEventListener('wheel', panel.boundWheel, { passive: false });
      parts.el.addEventListener('dblclick', panel.boundDoubleClick);

      applyPanelMethod(panel, method);
      applyPanelDevice(panel);
      panels.push(panel);

      const observer = new ResizeObserver(() => resizePanel(panel));
      observer.observe(parts.canvasWrap);
      panel.ro = observer;
      resizePanel(panel);
    }

    setActive(0);
  }

  function clearPanels() {
    for (const panel of panels) {
      try {
        panel.ro && panel.ro.disconnect();
      } catch {
        // Ignore.
      }
      try {
        panel.upscaler && panel.upscaler.dispose();
      } catch {
        // Ignore.
      }
      panel.el.remove();
    }
    panels = [];
    active = 0;
  }

  function onPanelPointerDown(event, panel) {
    if (event.button !== 0) return;
    setActive(panel.index);
    panDrag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY
    };
    try {
      panel.el.setPointerCapture(event.pointerId);
    } catch {
      // Ignore.
    }
    panel.el.classList.add('dragging');
  }

  function onPanelPointerMove(event, panel) {
    if (!panDrag || panDrag.id !== event.pointerId || !ready) return;
    const dx = event.clientX - panDrag.x;
    const dy = event.clientY - panDrag.y;
    if (!dx && !dy) return;
    const content = contentRectCss(panel);
    const view = getView();
    if (content.w <= 0 || content.h <= 0 || !view.w) return;
    center.x -= dx * (view.w / content.w);
    center.y -= dy * (view.h / content.h);
    getView();
    markViewChanged();
    panDrag.x = event.clientX;
    panDrag.y = event.clientY;
  }

  function onPanelPointerUp(event, panel) {
    if (!panDrag || panDrag.id !== event.pointerId) return;
    try {
      panel.el.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore.
    }
    panDrag = null;
    panel.el.classList.remove('dragging');
  }

  function onPanelWheel(event, panel) {
    if (!ready) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt < 24) return;
    lastWheelAt = now;

    const direction = event.deltaY < 0 ? 1 : -1;
    const next = nextZoom(magnification(), direction) / fitFactor();
    if (Math.abs(next - zoom) < 1e-9) return;

    const rect = panel.canvas.getBoundingClientRect();
    const content = contentRectCss(panel);
    const u = cue((event.clientX - rect.left - content.x) / content.w);
    const v = cue((event.clientY - rect.top - content.y) / content.h);
    const view = getView();
    const sourceX = view.x + u * view.w;
    const sourceY = view.y + v * view.h;

    zoom = next;
    const cw = Math.max(1, base.w / zoom);
    const ch = Math.max(1, base.h / zoom);
    center.x = sourceX - (u - 0.5) * cw;
    center.y = sourceY - (v - 0.5) * ch;
    getView();
    markViewChanged();
    updateZoomUI();
    showHud();
  }

  function resetView() {
    if (!ready) return;
    zoom = 1;
    center = {
      x: base.x + base.w / 2,
      y: base.y + base.h / 2
    };
    getView();
    markViewChanged();
    updateZoomUI();
    showHud();
  }

  // Destination of the visible image part inside the content rect (smaller than it when zoomed out).
  function destRectFor(panel, view, vis) {
    const rect = contentRectBacking(panel);
    return {
      x: Math.round(rect.x + ((vis.x - view.x) / view.w) * rect.w),
      y: Math.round(rect.y + ((vis.y - view.y) / view.h) * rect.h),
      w: Math.max(1, Math.round((vis.w / view.w) * rect.w)),
      h: Math.max(1, Math.round((vis.h / view.h) * rect.h))
    };
  }

  function prepareCrop(view) {
    if (!video || !view.w || !view.h) return null;
    const x = Math.max(0, Math.min(video.videoWidth - 1, Math.round(view.x)));
    const y = Math.max(0, Math.min(video.videoHeight - 1, Math.round(view.y)));
    const w = Math.max(1, Math.min(Math.round(view.w), video.videoWidth - x));
    const h = Math.max(1, Math.min(Math.round(view.h), video.videoHeight - y));
    const key = `${x}:${y}:${w}:${h}:${video.currentTime}`;
    if (key === cropKey && cropCanvas.width === w && cropCanvas.height === h) {
      return cropCanvas;
    }
    if (cropCanvas.width !== w || cropCanvas.height !== h) {
      cropCanvas.width = w;
      cropCanvas.height = h;
    }
    cropCtx.imageSmoothingEnabled = false;
    cropCtx.clearRect(0, 0, w, h);
    cropCtx.drawImage(video, x, y, w, h, 0, 0, w, h);
    cropKey = key;
    return cropCanvas;
  }

  function render() {
    requestAnimationFrame(render);
    if (!ready || !video || video.readyState < 2) return;
    const view = getView();
    const vis = visibleOf(view);
    const crop = prepareCrop(vis);
    if (!crop) return;
    for (const panel of panels) {
      const viewRect = destRectFor(panel, view, vis);
      const useAI = panel.index === active &&
        SM.isAI(panel.method) &&
        panel.aiFrame &&
        sameView(panel.aiView, view);
      // The image is a still, so redraw only when the view, size, method or AI frame changed.
      const key = `${view.x}|${view.y}|${view.w}|${view.h}|${viewRect.x}|${viewRect.y}|${viewRect.w}|${viewRect.h}|${panel.canvas.width}x${panel.canvas.height}|${panel.method}|${useAI}|${panel.aiStamp || 0}|${useGpu()}`;
      if (key === panel.lastKey) continue;
      // A lost WebGL context draws nothing: wait, the restore handler clears lastKey.
      if (useGpu() && panel.upscaler.lost) continue;
      panel.lastKey = key;
      if (useGpu()) {
        if (useAI) panel.upscaler.drawAI(viewRect);
        else panel.upscaler.drawCrop(crop, viewRect);
      } else if (useAI && panel.aiData) {
        // Shrinking the x4 result needs a wide kernel to stay clean; enlarging it keeps the soft bilinear look.
        drawCpu(panel, panel.aiData, viewRect, viewRect.w < panel.aiData.w ? 'lanczos3' : 'bilinear');
      } else {
        drawCpu(panel, cropData(crop), viewRect, panel.method);
      }
    }
  }

  let cropDataKey = '';
  let cropDataCache = null;

  function cropData(crop) {
    const key = `${cropKey}|${crop.width}x${crop.height}`;
    if (key !== cropDataKey) {
      const image = cropCtx.getImageData(0, 0, crop.width, crop.height);
      cropDataCache = { data: image.data, w: image.width, h: image.height };
      cropDataKey = key;
    }
    return cropDataCache;
  }

  function drawCpu(panel, src, rect, method) {
    const ctx = panel.ctxCpu || (panel.ctxCpu = panel.canvasCpu.getContext('2d', { willReadFrequently: true }));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, panel.canvasCpu.width, panel.canvasCpu.height);
    const out = SM.resample(src.data, src.w, src.h, rect.w, rect.h, method);
    ctx.putImageData(new ImageData(out, rect.w, rect.h), rect.x, rect.y);
  }

  function stopCapture() {
    capturing = false;
    ready = false;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore.
        }
      }
      stream = null;
    }
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch {
        // Ignore.
      }
      video.remove();
      video = null;
    }
  }

  function waitForVideoReady(target) {
    return new Promise((resolve, reject) => {
      let done = false;
      const started = performance.now();
      const finish = (ok, error) => {
        if (done) return;
        done = true;
        if (ok) resolve();
        else reject(error);
      };
      const check = () => {
        if (done) return;
        if (target.videoWidth > 0 && target.videoHeight > 0) {
          finish(true);
          return;
        }
        if (performance.now() - started > 10000) {
          finish(false, new Error('화면 영상이 준비되지 않았습니다. 다시 시도하세요.'));
          return;
        }
        setTimeout(check, 60);
      };
      target.addEventListener('loadeddata', check);
      target.addEventListener('error', () => finish(false, new Error('화면 영상을 읽을 수 없습니다.')));
      check();
    });
  }

  // Decodes the screenshot; videoWidth/videoHeight let the crop code treat it like a video frame.
  async function loadStill(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      image.videoWidth = image.naturalWidth;
      image.videoHeight = image.naturalHeight;
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function openStream() {
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      try {
        return await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 5, max: 5 } },
          audio: false
        });
      } catch (error) {
        if (!sourceId) throw error;
      }
    }
    if (!navigator.mediaDevices || !sourceId) {
      throw new Error('화면 캡처 장치를 사용할 수 없습니다.');
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: String(sourceId),
          maxFrameRate: 30
        }
      }
    });
  }

  async function startCapture() {
    if (!selection || !displaySize) return;
    hideError();
    stopCapture();
    clearPanels();
    cropKey = '';
    setCaptureStatus('화면을 캡처하는 중...', true);
    updateZoomUI();

    try {
      // A screenshot from the main process has no mouse cursor; a display stream always embeds the cursor.
      const still = stillBytes ? await loadStill(stillBytes).catch(() => null) : null;
      const media = still ? null : await openStream();
      if (!still && !media) throw new Error('화면 스트림을 만들지 못했습니다.');
      stream = media;
      capturing = true;

      const target = still || document.createElement('video');
      if (!still) {
        target.muted = true;
        target.autoplay = true;
        target.playsInline = true;
        target.style.position = 'fixed';
        target.style.left = '-2px';
        target.style.top = '-2px';
        target.style.width = '1px';
        target.style.height = '1px';
        target.style.opacity = '0';
        target.style.pointerEvents = 'none';
        target.srcObject = media;
        document.body.appendChild(target);
        video = target;

        target.play().catch(() => {});
        await waitForVideoReady(target);
        if (!capturing) throw new Error('화면 캡처가 중단되었습니다.');

        // Wait for a real frame, keep it as a still image, then stop the live capture.
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          if (target.requestVideoFrameCallback) {
            target.requestVideoFrameCallback(() => {
              clearTimeout(timer);
              resolve();
            });
          }
        });
      }
      // Keep only the selected region (and its shape) so nothing outside the selection is reachable.
      const disp = selection.display;
      displaySize = disp.size;
      scaleX = target.videoWidth / Math.max(1, disp.size.width);
      scaleY = target.videoHeight / Math.max(1, disp.size.height);
      const sx = clamp(Math.round(selection.rect.x * scaleX), 0, target.videoWidth - 1);
      const sy = clamp(Math.round(selection.rect.y * scaleY), 0, target.videoHeight - 1);
      const sw = clamp(Math.round(selection.rect.w * scaleX), 1, target.videoWidth - sx);
      const sh = clamp(Math.round(selection.rect.h * scaleY), 1, target.videoHeight - sy);
      const snap = document.createElement('canvas');
      snap.width = sw;
      snap.height = sh;
      const snapCtx = snap.getContext('2d');
      snapCtx.beginPath();
      if (selection.shape === 'ellipse') {
        snapCtx.ellipse(sw / 2, sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      } else if (selection.shape === 'free' && Array.isArray(selection.polygon) && selection.polygon.length >= 3) {
        selection.polygon.forEach((point, index) => {
          const x = cue(point.x) * sw;
          const y = cue(point.y) * sh;
          if (index === 0) snapCtx.moveTo(x, y);
          else snapCtx.lineTo(x, y);
        });
        snapCtx.closePath();
      } else {
        snapCtx.rect(0, 0, sw, sh);
      }
      snapCtx.clip();
      snapCtx.drawImage(target, sx, sy, sw, sh, 0, 0, sw, sh);
      // Mimic the video fields the rest of the code reads.
      snap.videoWidth = sw;
      snap.videoHeight = sh;
      snap.readyState = 4;
      snap.currentTime = 0;
      if (media) {
        for (const track of media.getTracks()) track.stop();
        target.pause();
        target.srcObject = null;
        target.remove();
      }
      stream = null;
      video = snap;

      base = { x: 0, y: 0, w: sw, h: sh };
      if (base.w < 2 || base.h < 2) {
        throw new Error('선택 영역이 너무 작습니다.');
      }

      zoom = 1;
      center = { x: base.x + base.w / 2, y: base.y + base.h / 2 };
      getView();
      markViewChanged();
      setupPanels();
      ready = true;
      setCaptureStatus('', false);
      updateZoomUI();
      showHud();

      if (panels.some((panel) => SM.isAI(panel.method))) ensureAI();

      if (!aiTimer) {
        aiTimer = setInterval(aiTick, 100);
      }
    } catch (error) {
      stopCapture();
      clearPanels();
      showError(error.message || '화면을 캡처하지 못했습니다.');
    }
  }

  // Loads the model of the active AI panel; switching between AI models reloads the session.
  function ensureAI() {
    const key = SM.modelOf(panels[active] ? panels[active].method : settings.method);
    if (!key || aiError || aiLoaded === key) return;
    aiLoaded = key;
    aiReady = false;
    if (!aiModels[key]) window.api.ai.info(key).then((value) => { aiModels[key] = value; updateModelInfo(); }).catch(() => {});
    updateAIStatuses();
    window.api.ai.ensure(key)
      .then((result) => {
        if (!result || result.ok === false) {
          throw new Error((result && result.error) || 'AI 모델을 불러오지 못했습니다.');
        }
        if (aiLoaded !== key) return;
        aiReady = true;
        aiProvider = result.provider || aiProvider || 'dml';
        aiError = null;
        lastAiAt = 0;
        updateAIStatuses();
      })
      .catch((error) => {
        // A newer request for another model owns the state now.
        if (aiLoaded !== key) return;
        aiReady = false;
        aiLoaded = null; // lets a later retry (badge click) reload the model
        aiError = error.message || 'AI 모델을 불러오지 못했습니다.';
        updateAIStatuses();
        toast(`${aiError} Bilinear로 표시합니다.`, true);
      });
  }

  function captureAICrop(view) {
    const crop = prepareCrop(visibleOf(view));
    if (!crop) throw new Error('AI 입력 이미지를 만들 수 없습니다.');
    const maxDim = activeAiLimit();
    const scale = Math.min(1, maxDim / Math.max(crop.width, crop.height));
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    if (aiCanvas.width !== width || aiCanvas.height !== height) {
      aiCanvas.width = width;
      aiCanvas.height = height;
    }
    aiCtx.imageSmoothingEnabled = true;
    aiCtx.imageSmoothingQuality = 'high';
    aiCtx.clearRect(0, 0, width, height);
    aiCtx.drawImage(crop, 0, 0, crop.width, crop.height, 0, 0, width, height);
    const image = aiCtx.getImageData(0, 0, width, height);
    return { width, height, data: image.data };
  }

  async function aiTick() {
    if (!ready || aiBusy || aiError || !video || video.readyState < 2) return;
    const panel = panels[active];
    if (!panel || !SM.isAI(panel.method)) return;
    // Also when the worker exited (aiReady false, aiLoaded cleared): load the model again without a badge click.
    if (aiLoaded !== SM.modelOf(panel.method)) {
      ensureAI();
      return;
    }
    if (!aiReady) return;

    // The model input is capped per model and device (SM.aiLimit). A larger region would be shrunk first, which loses detail
    // (worse than the plain picture at x1.0), so show the filter result instead.
    const vis = visibleOf(getView());
    const tooBig = Math.max(vis.w, vis.h) > activeAiLimit() || vis.w * vis.h > SM.AI_MAX_PIXELS;
    if (tooBig !== aiTooBig) {
      aiTooBig = tooBig;
      updateAIStatuses();
    }
    if (tooBig) return;

    const now = Date.now();
    const interval = Math.max(250, lastAiMs);
    if (now - lastAiAt < interval) return;

    const view = getView();
    if (view.w < 6 || view.h < 6) return;
    // Still image: infer once per view instead of continuously.
    if (panel.aiFrame && sameView(panel.aiView, view)) return;

    lastAiAt = now;
    aiBusy = true;
    aiPendingPanel = panel.index;
    const version = viewVersion;
    const requestView = { ...view };
    // The model this request runs on; a result from a model that is no longer selected must not be shown.
    const requestModel = SM.modelOf(panel.method);
    updateAIStatuses();

    try {
      const input = captureAICrop(requestView);
      const startedAt = Date.now();
      const result = await window.api.ai.infer({
        width: input.width,
        height: input.height,
        data: input.data.buffer,
        model: requestModel
      });
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || 'AI 처리에 실패했습니다.');
      }
      lastAiMs = Date.now() - startedAt;
      if (version !== viewVersion || !panels[panel.index] || SM.modelOf(panels[panel.index].method) !== requestModel) {
        return;
      }
      const target = panels[panel.index];
      const aiBytes = new Uint8ClampedArray(result.data);
      target.aiData = { data: aiBytes, w: result.width, h: result.height };
      if (target.upscaler) target.upscaler.uploadAI(aiBytes, result.width, result.height);
      target.aiW = result.width;
      target.aiH = result.height;
      target.aiView = requestView;
      target.aiFrame = true;
      target.aiStamp = (target.aiStamp || 0) + 1;
      aiProvider = result.provider || aiProvider;
      aiInferErrorShown = false;
    } catch (error) {
      if (!aiInferErrorShown) {
        aiInferErrorShown = true;
        toast(`AI 처리 오류: ${error.message || '알 수 없는 오류'}`, true);
      }
    } finally {
      if (aiPendingPanel === panel.index) aiPendingPanel = -1;
      aiBusy = false;
      updateAIStatuses();
    }
  }

  // Everything outside the selected shape (and outside the image when zoomed out) becomes transparent.
  function composePanel(panel) {
    // While the editor is open, saving means the edited picture.
    if (window.SMEditor && window.SMEditor.isOpen) return window.SMEditor.exportCanvas();
    const out = document.createElement('canvas');
    out.width = panel.canvas.width;
    out.height = panel.canvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return out;
    ctx.drawImage(panel.canvas, 0, 0);
    const view = getView();
    const vis = visibleOf(view);
    const dest = destRectFor(panel, view, vis);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(video, vis.x, vis.y, vis.w, vis.h, dest.x, dest.y, dest.w, dest.h);
    return out;
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG 이미지를 만들지 못했습니다.'));
      }, 'image/png');
    });
  }

  function defaultFileName() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `ScreenMagnify3_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function baseName(target) {
    if (!target) return '';
    const parts = String(target).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || target;
  }

  function updateSavePreview() {
    const img = $('save-preview');
    const panel = panels[active];
    if (!panel || !ready) {
      img.removeAttribute('src');
      return;
    }
    try {
      const out = composePanel(panel);
      const width = 208;
      const height = Math.max(1, Math.round(out.height * (width / out.width)));
      const thumb = document.createElement('canvas');
      thumb.width = width;
      thumb.height = height;
      const ctx = thumb.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(out, 0, 0, width, height);
      img.src = thumb.toDataURL('image/png');
    } catch {
      img.removeAttribute('src');
    }
  }

  async function loadPresets() {
    try {
      const presets = await window.api.fs.presets();
      saveState.presets = Array.isArray(presets) ? presets : [];
    } catch {
      saveState.presets = [];
    }
    renderPresets();
  }

  function renderPresets() {
    const host = $('save-presets');
    host.innerHTML = '';
    for (const preset of saveState.presets) {
      const button = document.createElement('button');
      button.className = `preset-button${preset.path === saveState.dir ? ' active' : ''}`;
      button.title = preset.path;
      button.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-15z"></path></svg><span>${escapeHtml(preset.label)}</span>`;
      button.addEventListener('click', () => loadDir(preset.path));
      host.appendChild(button);
    }
  }

  function folderIcon() {
    return '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-15z"></path></svg>';
  }

  function fileIcon() {
    return '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2"></rect><path d="M8 15.5l2.6-3 2.1 2.4 1.8-2 2.5 2.6"></path><circle cx="9" cy="8.4" r="1.2"></circle></svg>';
  }

  function renderList() {
    const host = $('save-list');
    host.innerHTML = '';
    if (saveState.loading) {
      host.innerHTML = '<div class="list-note">폴더를 읽는 중...</div>';
      return;
    }
    const frag = document.createDocumentFragment();

    if (saveState.parent) {
      const row = document.createElement('div');
      row.className = 'file-row folder';
      row.innerHTML = `${folderIcon()}<span class="file-name">상위 폴더</span><span class="file-hint">..</span>`;
      row.addEventListener('dblclick', () => loadDir(saveState.parent));
      row.addEventListener('click', () => {
        saveState.selected = saveState.parent;
        markSelectedRow();
      });
      row.dataset.path = saveState.parent;
      frag.appendChild(row);
    }

    const entries = saveState.entries.slice(0, 600);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `file-row ${entry.type}`;
      row.dataset.path = entry.path;
      row.innerHTML = `${entry.type === 'dir' ? folderIcon() : fileIcon()}<span class="file-name">${escapeHtml(entry.name)}</span>${entry.type === 'file' ? '<span class="file-hint">이름 사용</span>' : ''}`;
      row.addEventListener('click', () => {
        saveState.selected = entry.path;
        markSelectedRow();
      });
      row.addEventListener('dblclick', () => {
        if (entry.type === 'dir') {
          loadDir(entry.path);
        } else {
          $('save-name').value = entry.name.replace(/\.png$/i, '');
          $('save-name').focus();
          $('save-name').select();
        }
      });
      frag.appendChild(row);
    }

    if (!frag.childNodes.length) {
      host.innerHTML = '<div class="list-note">표시할 항목이 없습니다.</div>';
      return;
    }

    host.appendChild(frag);
    if (saveState.entries.length > 600) {
      const note = document.createElement('div');
      note.className = 'list-note';
      note.textContent = '항목이 많아 600개까지만 표시합니다.';
      host.appendChild(note);
    }
  }

  function markSelectedRow() {
    document.querySelectorAll('#save-list .file-row').forEach((row) => {
      row.style.background = row.dataset.path === saveState.selected ? 'var(--panel-hover)' : '';
    });
  }

  async function loadDir(dir) {
    if (!dir) return false;
    const token = ++saveState.token;
    saveState.loading = true;
    renderList();
    try {
      const result = await window.api.fs.listDir(dir);
      if (token !== saveState.token) return false;
      if (!result || !result.ok) {
        saveState.loading = false;
        renderList();
        toast((result && result.error) || '폴더를 읽을 수 없습니다.', true);
        return false;
      }
      saveState.dir = result.dir;
      saveState.parent = result.parent;
      saveState.entries = Array.isArray(result.entries) ? result.entries : [];
      saveState.loading = false;
      saveState.selected = '';
      $('save-path').value = result.dir;
      renderPresets();
      renderList();
      return true;
    } catch (error) {
      if (token !== saveState.token) return false;
      saveState.loading = false;
      renderList();
      toast(error.message || '폴더를 읽을 수 없습니다.', true);
      return false;
    }
  }

  async function openSaveDialog() {
    if (!ready || !panels.length) {
      toast('먼저 화면을 캡처해야 저장할 수 있습니다.', true);
      return;
    }
    $('save-modal').classList.remove('hidden');
    updateSavePreview();
    $('save-name').value = defaultFileName();
    saveState.selected = '';
    await loadPresets();

    const last = settings && settings.lastSaveDir;
    let loaded = false;
    if (last) loaded = await loadDir(last);
    if (!loaded) {
      const fallback = saveState.presets.find((preset) => preset.id === 'pictures') ||
        saveState.presets.find((preset) => preset.id === 'downloads') ||
        saveState.presets[0];
      if (fallback) await loadDir(fallback.path);
    }
    setTimeout(() => {
      $('save-name').focus();
      $('save-name').select();
    }, 60);
  }

  function closeSaveDialog() {
    $('save-modal').classList.add('hidden');
    $('new-folder-row').classList.add('hidden');
  }

  async function confirmSave() {
    if (saveState.saving) return;
    if (!saveState.dir) {
      toast('저장할 폴더를 선택하세요.', true);
      return;
    }
    const panel = panels[active];
    if (!panel) return;
    const name = $('save-name').value.trim();
    if (!name) {
      toast('파일 이름을 입력하세요.', true);
      $('save-name').focus();
      return;
    }

    saveState.saving = true;
    const button = $('save-confirm');
    button.disabled = true;
    button.textContent = '저장 중...';
    try {
      const out = composePanel(panel);
      const blob = await canvasBlob(out);
      const buffer = await blob.arrayBuffer();
      const result = await window.api.fs.savePng({
        dir: saveState.dir,
        name,
        buffer
      });
      if (!result || !result.ok) {
        throw new Error((result && result.error) || '파일을 저장하지 못했습니다.');
      }
      toast(`저장했습니다: ${result.path}`);
      closeSaveDialog();
    } catch (error) {
      toast(error.message || '파일을 저장하지 못했습니다.', true);
    } finally {
      saveState.saving = false;
      button.disabled = false;
      button.textContent = '저장';
    }
  }

  function bindStaticEvents() {
    $('btn-min').addEventListener('click', () => window.api.window.minimize());
    $('btn-max').addEventListener('click', () => window.api.window.maximize());
    $('btn-close').addEventListener('click', () => window.api.window.close());

    $('btn-theme').addEventListener('click', () => {
      if (!settings) return;
      window.api.settings.set({ theme: settings.theme === 'light' ? 'dark' : 'light' });
    });

    aiBadge.addEventListener('click', () => {
      const next = settings && settings.aiDevice === 'gpu' ? 'cpu' : 'gpu';
      aiProvider = next === 'cpu' ? 'cpu' : 'dml';
      aiError = null;
      markViewChanged();
      updateAIStatuses();
      window.api.settings.set({ aiDevice: next });
    });

    $('btn-save').addEventListener('click', openSaveDialog);
    $('zoom-out').addEventListener('click', () => setZoom(nextZoom(magnification(), -1)));
    $('zoom-in').addEventListener('click', () => setZoom(nextZoom(magnification(), 1)));
    $('zoom-reset').addEventListener('click', resetView);
    $('btn-retry').addEventListener('click', () => {
      hideError();
      startCapture();
    });

    methodSelect.addEventListener('change', () => {
      const panel = panels[active];
      if (!panel) return;
      applyPanelMethod(panel, methodSelect.value);
    });

    $('save-close').addEventListener('click', closeSaveDialog);
    $('save-cancel').addEventListener('click', closeSaveDialog);
    $('save-confirm').addEventListener('click', confirmSave);
    $('save-modal').addEventListener('mousedown', (event) => {
      if (event.target === $('save-modal')) closeSaveDialog();
    });

    $('save-up').addEventListener('click', () => {
      if (saveState.parent) loadDir(saveState.parent);
    });
    $('save-go').addEventListener('click', () => loadDir($('save-path').value.trim()));
    $('save-path').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadDir($('save-path').value.trim());
      }
    });

    $('save-new-folder').addEventListener('click', () => {
      const row = $('new-folder-row');
      row.classList.toggle('hidden');
      if (!row.classList.contains('hidden')) {
        $('new-folder-name').value = '';
        $('new-folder-name').focus();
      }
    });
    $('new-folder-cancel').addEventListener('click', () => {
      $('new-folder-row').classList.add('hidden');
    });
    $('new-folder-create').addEventListener('click', async () => {
      const name = $('new-folder-name').value.trim();
      if (!name) return;
      if (!saveState.dir) {
        toast('먼저 저장할 폴더를 선택하세요.', true);
        return;
      }
      try {
        const result = await window.api.fs.mkdir(saveState.dir, name);
        if (!result || !result.ok) {
          throw new Error((result && result.error) || '폴더를 만들지 못했습니다.');
        }
        $('new-folder-row').classList.add('hidden');
        await loadDir(result.path);
      } catch (error) {
        toast(error.message || '폴더를 만들지 못했습니다.', true);
      }
    });
    $('new-folder-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        $('new-folder-create').click();
      }
    });

    $('save-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirmSave();
      }
    });

    window.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
      const saveOpen = !$('save-modal').classList.contains('hidden');

      if (event.key === 'Escape') {
        if (saveOpen) {
          event.preventDefault();
          closeSaveDialog();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!saveOpen) openSaveDialog();
        return;
      }

      if (typing || saveOpen || (window.SMEditor && window.SMEditor.isOpen)) return;

      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom(nextZoom(magnification(), 1));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom(nextZoom(magnification(), -1));
      } else if (event.key === '0') {
        event.preventDefault();
        resetView();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        // Previous / next method for the active panel (GPU-only ones are skipped while the device is CPU).
        event.preventDefault();
        const panel = panels[active];
        if (!ready || !panel) return;
        const list = SM.methods.filter((m) => !(m.gpuOnly && !useGpu()));
        const at = list.findIndex((m) => m.id === panel.method);
        const next = list[clamp(at + (event.key === 'ArrowUp' ? -1 : 1), 0, list.length - 1)];
        if (next && next.id !== panel.method) applyPanelMethod(panel, next.id);
        methodSelect.value = panel.method;
        toast(SM.byId(panel.method).label);
      } else if (event.key === 'ArrowRight') {
        // Edit what the active panel shows now; the viewer underneath stays as it is.
        event.preventDefault();
        if (ready && panels[active]) window.SMEditor.open(composePanel(panels[active]));
      }
    });

    window.api.onSettingsChanged((next) => {
      if (!next) return;
      const prevDevice = settings && settings.aiDevice;
      const prevMax = settings && settings.aiMaxSize;
      settings = next;
      if (prevMax !== next.aiMaxSize) markViewChanged(); // recompute with the new limit
      applyTheme(next.theme);
      SM.applyDevice(methodSelect, next.aiDevice);
      if (prevDevice !== next.aiDevice) {
        // Switch every panel live: NIS falls back to Lanczos3 on CPU.
        for (const panel of panels) {
          applyPanelMethod(panel, panel.method);
          applyPanelDevice(panel);
        }
        if (panels[active]) methodSelect.value = panels[active].method;
        markViewChanged();
        updateAIStatuses();
      }
    });

    window.api.ai.onEvent((event) => {
      if (!event) return;
      if (event.type === 'provider') {
        aiProvider = event.provider;
        if (event.provider) {
          aiReady = true;
          aiError = null;
        } else {
          aiReady = false;
          aiLoaded = null; // the worker exited: load the model again on the next use
        }
        updateAIStatuses();
      } else if (event.type === 'error') {
        aiReady = false;
        aiError = event.message || 'AI 오류';
        updateAIStatuses();
      }
    });
  }

  window.api.result.onInit(async (payload) => {
    if (!payload || !payload.selection) return;
    settings = payload.settings || {
      panelCount: 1,
      method: 'realesrgan',
      theme: 'dark',
      customPaths: []
    };
    selection = payload.selection;
    sourceId = payload.sourceId;
    stillBytes = payload.still || null;
    displaySize = selection.display.size;
    applyTheme(settings.theme);
    SM.fillSelect(methodSelect, settings.method);
    SM.applyDevice(methodSelect, settings.aiDevice);
    await startCapture();
  });

  bindStaticEvents();
  updateZoomUI();
  requestAnimationFrame(render);
})();
