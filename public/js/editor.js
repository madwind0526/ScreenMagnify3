// Image editor shown over the lens (mode 2) or the result viewer (mode 1). It works on a snapshot canvas and
// never touches the lens or the viewer underneath. Pixel work is in editor-core.js.
(function () {
  const Core = window.SMEditorCore;
  const MAX_SIDE = 2400;
  const MAX_PIXELS = 4e6;
  const COLORS = [
    '#000000', '#3a3a3a', '#808080', '#c8c8c8', '#ffffff', '#7a4a21',
    '#ff3b30', '#ff9500', '#ffcc00', '#a6e22e', '#34c759', '#00a896',
    '#00c7ff', '#5ac8fa', '#0a84ff', '#5856d6', '#af52de', '#ff2d92',
    '#ffb3c1', '#f4a261', '#808000', '#001f5b', '#800020', '#d4af37'
  ];
  const FILTERS = [
    { id: 'canny', label: 'Canny' },
    { id: 'bright', label: '밝기 선' },
    { id: 'sam', label: 'SAM' }
  ];

  let root = null;
  let ui = null; // element references
  let st = null; // state of the open session
  let raf = 0;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ---------- dial (port of the Knob of SongYUE2's post-process dialog) ----------
  function makeKnob({ label, min, max, step, value, color, onInput }) {
    const el = document.createElement('div');
    el.className = 'ed-knob';
    el.innerHTML = '<div class="ed-dial"><div class="ed-pointer"></div></div><span class="ed-knob-label"></span><input type="number" class="ed-knob-value">';
    const dial = el.querySelector('.ed-dial');
    const pointer = el.querySelector('.ed-pointer');
    const input = el.querySelector('input');
    el.querySelector('.ed-knob-label').textContent = label;
    if (color) dial.style.setProperty('--knob-color', color);
    input.min = min;
    input.max = max;
    input.step = step;
    const initial = value;
    let current = value;
    const snap = (v) => clamp(Math.round(v / step) * step, min, max);
    const fmt = (v) => String(Math.round(v * 1000) / 1000);
    function show(v) {
      current = v;
      const pct = (v - min) / (max - min);
      dial.style.setProperty('--pct', pct);
      pointer.style.transform = `rotate(${-135 + pct * 270}deg)`;
      if (document.activeElement !== input) input.value = fmt(v);
    }
    function change(v) {
      const next = snap(v);
      if (next === current) return;
      show(next);
      onInput(next);
    }
    let drag = null;
    dial.addEventListener('pointerdown', (e) => {
      dial.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, v: current };
    });
    dial.addEventListener('pointermove', (e) => {
      if (drag) change(drag.v + ((drag.y - e.clientY) / 150) * (max - min));
    });
    dial.addEventListener('pointerup', () => { drag = null; });
    dial.addEventListener('dblclick', () => change(initial));
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      change(current + (e.deltaY < 0 ? 1 : -1) * Math.max(step, (max - min) / 50));
    }, { passive: false });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) change(v);
      input.value = fmt(current);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    show(value);
    return { el, set: (v) => show(snap(v)), get: () => current };
  }

  // ---------- DOM ----------
  function build() {
    root = document.getElementById('editor-root');
    root.innerHTML = `
      <div class="ed-stage"><canvas class="ed-canvas"></canvas><div class="ed-hint">← 돋보기/뷰어로 돌아가기 · Ctrl+Z 되돌리기 · Ctrl+S 저장</div></div>
      <aside class="ed-panel">
        <h2 class="ed-title">Image Editor</h2>
        <div class="ed-rot">
          <button class="ed-btn ed-icon" id="ed-rot-l" title="왼쪽으로 1° 회전" aria-label="왼쪽으로 회전"><svg viewBox="0 0 24 24"><path d="M9 5 5 9l4 4"/><path d="M5 9h9a5 5 0 1 1-5 5"/></svg></button>
          <label class="ed-angle"><span>회전 각도</span><input type="number" id="ed-angle" min="-180" max="180" step="0.1" value="0"></label>
          <button class="ed-btn ed-icon" id="ed-rot-r" title="오른쪽으로 1° 회전" aria-label="오른쪽으로 회전"><svg viewBox="0 0 24 24"><path d="m15 5 4 4-4 4"/><path d="M19 9h-9a5 5 0 1 0 5 5"/></svg></button>
          <button class="ed-btn" id="ed-rot-auto" title="기울어진 줄을 찾아 수평으로 맞춥니다">자동</button>
        </div>
        <div class="ed-row ed-adjust" id="ed-adjust"></div>
        <div class="ed-row">
          <button class="ed-btn" id="ed-auto" title="밝기와 대비를 자동으로 맞춥니다">자동</button>
          <button class="ed-btn" id="ed-reset">리셋</button>
        </div>
        <div class="ed-row ed-tools">
          <button class="ed-btn ed-tool" data-tool="draw">선그리기</button>
          <button class="ed-btn ed-tool" data-tool="erase">지우개</button>
          <button class="ed-btn ed-tool" data-tool="fill">채우기</button>
        </div>
        <div class="ed-row ed-pen">
          <div id="ed-size"></div>
          <div class="ed-palette" id="ed-palette"></div>
        </div>
        <hr class="ed-sep">
        <h3 class="ed-sub">filter selection</h3>
        <div class="ed-row ed-filters" id="ed-filters"></div>
        <div class="ed-row ed-options" id="ed-options"></div>
        <div class="ed-status" id="ed-status"></div>
        <div class="ed-row ed-bottom">
          <div id="ed-opacity"></div>
          <div class="ed-col">
            <label class="ed-check"><input type="checkbox" id="ed-show" checked><span>필터 표시</span></label>
            <button class="ed-btn" id="ed-fill-regions" title="선으로 나뉜 영역을 같은 색으로 칠합니다">색 채우기</button>
          </div>
        </div>
      </aside>`;
    const q = (id) => root.querySelector(id);
    ui = {
      panel: q('.ed-panel'), stage: q('.ed-stage'), cv: q('.ed-canvas'), angle: q('#ed-angle'), adjust: q('#ed-adjust'), size: q('#ed-size'),
      palette: q('#ed-palette'), filters: q('#ed-filters'), options: q('#ed-options'), status: q('#ed-status'),
      opacity: q('#ed-opacity'), show: q('#ed-show'), fillBtn: q('#ed-fill-regions')
    };

    q('#ed-rot-l').addEventListener('click', () => setAngle(st.angle - 1));
    q('#ed-rot-r').addEventListener('click', () => setAngle(st.angle + 1));
    ui.angle.addEventListener('change', () => setAngle(Number(ui.angle.value) || 0));
    ui.angle.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.angle.blur(); });
    q('#ed-rot-auto').addEventListener('click', () => {
      setAngle(Core.detectSkew(st.rot.data, st.W, st.H));
    });

    const adjustDefs = [['Brightness', 'brightness', -100], ['Contrast', 'contrast', -100], ['Sharpness', 'sharpness', 0], ['Saturation', 'saturation', -100]];
    ui.adjustKnobs = {};
    for (const [label, key, min] of adjustDefs) {
      const knob = makeKnob({ label, min, max: 100, step: 1, value: 0, color: '#c79bea', onInput: (v) => { st.adj[key] = v; dirty(1); } });
      ui.adjustKnobs[key] = knob;
      ui.adjust.appendChild(knob.el);
    }
    q('#ed-auto').addEventListener('click', () => {
      const a = Core.autoAdjust(st.rot.data, st.W, st.H);
      st.adj.brightness = a.brightness;
      st.adj.contrast = a.contrast;
      syncAdjustKnobs();
      dirty(1);
    });
    q('#ed-reset').addEventListener('click', () => {
      Object.assign(st.adj, { brightness: 0, contrast: 0, sharpness: 0, saturation: 0 });
      syncAdjustKnobs();
      dirty(1);
    });

    root.querySelectorAll('.ed-tool').forEach((b) => b.addEventListener('click', () => {
      st.tool = st.tool === b.dataset.tool ? null : b.dataset.tool;
      syncTools();
    }));
    ui.sizeKnob = makeKnob({ label: '선 굵기', min: 1, max: 80, step: 1, value: 6, color: '#7fb8e0', onInput: (v) => { st.size = v; } });
    ui.size.appendChild(ui.sizeKnob.el);
    COLORS.forEach((color, i) => {
      const b = document.createElement('button');
      b.className = 'ed-swatch';
      b.style.background = color;
      b.title = color;
      b.addEventListener('click', () => { st.colorIndex = i; syncPalette(); });
      ui.palette.appendChild(b);
    });

    FILTERS.forEach((f) => {
      const b = document.createElement('button');
      b.className = 'ed-btn ed-filter';
      b.dataset.filter = f.id;
      b.textContent = f.label;
      b.addEventListener('click', () => toggleFilter(f.id));
      ui.filters.appendChild(b);
    });

    ui.opacityKnob = makeKnob({ label: '투명도', min: 0, max: 100, step: 1, value: 100, color: '#add7a5', onInput: (v) => { st.opacity = v; dirty(3); } });
    ui.opacity.appendChild(ui.opacityKnob.el);
    ui.show.addEventListener('change', () => { st.showFilter = ui.show.checked; dirty(3); });
    ui.fillBtn.addEventListener('click', () => {
      st.fillOn = !st.fillOn;
      syncFilterUi();
      dirty(2);
    });

    // Drawing.
    ui.cv.addEventListener('pointerdown', onPointerDown);
    ui.cv.addEventListener('pointermove', onPointerMove);
    ui.cv.addEventListener('pointerup', onPointerUp);
    ui.cv.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKey, true);
    new ResizeObserver(fit).observe(ui.stage);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- state helpers ----------
  const FILTER_OPTIONS = {
    canny: [
      { key: 'sigma', label: '블러', min: 0.5, max: 4, step: 0.1, value: 1.4 },
      { key: 'low', label: '낮은 임계값', min: 1, max: 100, step: 1, value: 12 },
      { key: 'high', label: '높은 임계값', min: 1, max: 100, step: 1, value: 32 }
    ],
    bright: [
      { key: 'diff', label: '밝기 차이', min: 1, max: 100, step: 1, value: 20 },
      { key: 'radius', label: '범위(px)', min: 1, max: 6, step: 1, value: 1 },
      { key: 'blur', label: '블러', min: 0, max: 3, step: 0.1, value: 0.8 }
    ],
    sam: [
      { key: 'grid', label: '점 개수', min: 4, max: 16, step: 1, value: 10 },
      { key: 'iou', label: '신뢰도', min: 0.5, max: 1, step: 0.01, value: 0.86 },
      { key: 'minArea', label: '최소 면적(%)', min: 0, max: 5, step: 0.1, value: 0.3 }
    ]
  };

  function syncAdjustKnobs() {
    for (const key of Object.keys(ui.adjustKnobs)) ui.adjustKnobs[key].set(st.adj[key]);
  }
  function syncTools() {
    root.querySelectorAll('.ed-tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === st.tool));
    ui.cv.style.cursor = st.tool ? 'crosshair' : 'default';
  }
  function syncPalette() {
    [...ui.palette.children].forEach((b, i) => b.classList.toggle('on', i === st.colorIndex));
  }
  function syncFilterUi() {
    root.querySelectorAll('.ed-filter').forEach((b) => b.classList.toggle('on', st.filters.includes(b.dataset.filter)));
    ui.fillBtn.classList.toggle('on', st.fillOn);
    const any = st.filters.length > 0;
    ui.fillBtn.disabled = !any;
    ui.show.disabled = !any;
    ui.opacity.classList.toggle('off', !any);
    ui.options.innerHTML = '';
    // Every selected filter gets its own row of option dials.
    for (const f of FILTERS.filter((item) => st.filters.includes(item.id))) {
      const head = document.createElement('div');
      head.className = 'ed-opt-title';
      head.textContent = f.label;
      ui.options.appendChild(head);
      for (const def of FILTER_OPTIONS[f.id]) {
        const knob = makeKnob({
          label: def.label, min: def.min, max: def.max, step: def.step, value: st.fopt[f.id][def.key], color: '#f2c94c',
          onInput: (v) => {
            st.fopt[f.id][def.key] = v;
            delete st.cache[f.id];
            if (f.id === 'sam' && def.key === 'grid') scheduleSamDecode();
            else dirty(2);
          }
        });
        ui.options.appendChild(knob.el);
      }
    }
    ui.status.textContent = '';
  }

  function setAngle(deg) {
    const a = Math.round(clamp(deg, -180, 180) * 10) / 10;
    st.angle = a;
    ui.angle.value = String(a);
    dirty(0);
    if (st.filters.includes('sam')) scheduleSamEncode();
  }

  // Filters can be combined: their lines are drawn together.
  function toggleFilter(id) {
    const at = st.filters.indexOf(id);
    if (at >= 0) st.filters.splice(at, 1);
    else {
      st.filters.push(id);
      st.showFilter = true;
      ui.show.checked = true;
    }
    if (!st.filters.length) st.fillOn = false;
    delete st.cache[id];
    st.lines = null;
    syncFilterUi();
    if (id === 'sam' && at < 0) scheduleSamEncode(0);
    dirty(2);
  }

  // ---------- pipeline ----------
  // level: 0 rotate, 1 adjust, 2 lines + fill, 3 compose
  function dirty(level) {
    st.level = Math.min(st.level, level);
    if (!raf) raf = requestAnimationFrame(run);
  }

  function run() {
    raf = 0;
    if (!st) return;
    const { W, H } = st;
    if (st.level <= 0) {
      const c = st.rctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, H);
      c.translate(W / 2, H / 2);
      c.rotate((st.angle * Math.PI) / 180);
      c.drawImage(st.S, -W / 2, -H / 2);
      st.rot = c.getImageData(0, 0, W, H);
    }
    if (st.level <= 1) {
      st.adjusted = Core.adjust(st.rot.data, W, H, st.adj);
      st.gray = null;
      st.cache = {};
    }
    if (st.level <= 2) {
      st.lines = computeLines();
      st.filled = st.fillOn && st.lines ? Core.regionFill(st.adjusted, W, H, st.lines) : null;
    }
    const pic = st.filled || st.adjusted;
    const lines = st.filters.length && st.showFilter ? st.lines : null;
    const data = lines ? Core.compose(pic, W, H, lines, st.opacity / 100) : pic;
    st.bctx.putImageData(new ImageData(data, W, H), 0, 0);
    st.level = 9;
    paint();
  }

  function filterLines(id) {
    const { W, H } = st;
    if (id === 'sam') {
      const o = st.fopt.sam;
      return st.samMasks ? Core.samLines(st.samMasks, st.samW, st.samH, W, H, { iou: o.iou, minArea: o.minArea / 100 }) : null;
    }
    if (!st.gray) st.gray = Core.lumaOf(st.adjusted, W, H);
    return id === 'canny' ? Core.canny(st.gray, W, H, st.fopt.canny) : Core.brightnessLines(st.gray, W, H, st.fopt.bright);
  }

  // Union of the lines of every selected filter (each one cached until its own options or the picture change).
  function computeLines() {
    let out = null;
    for (const id of st.filters) {
      if (!st.cache[id]) st.cache[id] = filterLines(id);
      const lines = st.cache[id];
      if (!lines) continue;
      if (!out) out = new Uint8Array(lines);
      else for (let i = 0; i < out.length; i += 1) if (lines[i]) out[i] = 1;
    }
    return out;
  }

  function paint() {
    st.cctx.clearRect(0, 0, st.W, st.H);
    st.cctx.drawImage(st.bc, 0, 0);
    st.cctx.drawImage(st.D, 0, 0);
  }

  // The canvas fills the stage keeping its aspect (letterboxed); pointer maths needs the same box.
  function fit() {
    if (!st) return;
    if (st.rect) {
      // Floating (lens): the picture keeps the size and place of the lens, the panel sits beside it.
      const r = st.rect;
      Object.assign(ui.cv.style, { position: 'absolute', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: st.round ? '50%' : '4px' });
      const pw = ui.panel.offsetWidth || 308;
      const gap = 30;
      let x = r.left + r.width + gap;
      if (x + pw > innerWidth - 8) x = r.left - gap - pw >= 8 ? r.left - gap - pw : Math.max(8, innerWidth - pw - 8);
      const y = clamp(r.top, 8, Math.max(8, innerHeight - ui.panel.offsetHeight - 8));
      Object.assign(ui.panel.style, { left: `${x}px`, top: `${y}px` });
      return;
    }
    for (const prop of ['position', 'left', 'top', 'borderRadius']) ui.cv.style[prop] = '';
    ui.panel.style.left = '';
    ui.panel.style.top = '';
    const box = ui.stage.getBoundingClientRect();
    const s = Math.min((box.width - 24) / st.W, (box.height - 24) / st.H);
    ui.cv.style.width = `${Math.max(1, Math.floor(st.W * s))}px`;
    ui.cv.style.height = `${Math.max(1, Math.floor(st.H * s))}px`;
  }

  // ---------- SAM ----------
  function setStatus(text) {
    ui.status.textContent = text || '';
  }

  function scheduleSamEncode(delay = 500) {
    st.samMasks = null;
    st.samToken += 1;
    clearTimeout(st.samTimer);
    st.samTimer = setTimeout(samEncode, delay);
  }

  function scheduleSamDecode() {
    clearTimeout(st.samDecodeTimer);
    st.samDecodeTimer = setTimeout(samDecode, 600);
  }

  async function samEncode() {
    if (!st || !st.filters.includes('sam')) return;
    const token = ++st.samToken;
    setStatus('SAM: 그림을 분석하는 중... (처음에는 모델을 읽느라 오래 걸립니다)');
    try {
      if (st.level <= 0 || !st.rot) run();
      const scale = 1024 / Math.max(st.W, st.H);
      const rw = Math.max(1, Math.round(st.W * scale));
      const rh = Math.max(1, Math.round(st.H * scale));
      const tmp = document.createElement('canvas');
      tmp.width = rw;
      tmp.height = rh;
      const t = tmp.getContext('2d');
      // Transparent corners (after a rotation or a round lens) become white for the model.
      t.fillStyle = '#fff';
      t.fillRect(0, 0, rw, rh);
      t.drawImage(st.rc, 0, 0, rw, rh);
      const data = t.getImageData(0, 0, rw, rh).data;
      const res = await window.api.sam.encode({ width: rw, height: rh, data: data.buffer });
      if (token !== st.samToken) return;
      if (!res || !res.ok) throw new Error((res && res.error) || 'SAM 분석 실패');
      await samDecode(token);
    } catch (error) {
      if (st && token === st.samToken) setStatus(`SAM 오류: ${error.message}`);
    }
  }

  async function samDecode(knownToken) {
    if (!st || !st.filters.includes('sam')) return;
    const token = knownToken || ++st.samToken;
    const grid = st.fopt.sam.grid;
    setStatus(`SAM: 영역을 찾는 중... (${grid * grid}점)`);
    try {
      const k = 512 / Math.max(st.W, st.H);
      const res = await window.api.sam.decode({ grid, outW: Math.max(16, Math.round(st.W * k)), outH: Math.max(16, Math.round(st.H * k)) });
      if (!st || token !== st.samToken) return;
      if (!res || !res.ok) throw new Error((res && res.error) || 'SAM 실패');
      delete st.cache.sam;
      st.samMasks = res.masks.map((m) => ({ ...m, data: new Uint8Array(m.data) }));
      st.samW = res.width;
      st.samH = res.height;
      setStatus(`SAM: 영역 ${st.samMasks.length}개`);
      dirty(2);
    } catch (error) {
      if (st && token === st.samToken) setStatus(`SAM 오류: ${error.message}`);
    }
  }

  // ---------- drawing ----------
  function toImage(e) {
    const r = ui.cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * st.W, y: ((e.clientY - r.top) / r.height) * st.H };
  }

  function pushUndo() {
    st.undo.push(st.dctx.getImageData(0, 0, st.W, st.H));
    if (st.undo.length > 8) st.undo.shift();
  }

  function onPointerDown(e) {
    if (!st.tool || e.button !== 0) return;
    const p = toImage(e);
    if (st.tool === 'fill') {
      pushUndo();
      const seen = st.cctx.getImageData(0, 0, st.W, st.H);
      const mask = Core.floodMask(seen.data, st.W, st.H, Math.floor(p.x), Math.floor(p.y), 40);
      const d = st.dctx.getImageData(0, 0, st.W, st.H);
      const hex = COLORS[st.colorIndex];
      const rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
      for (let i = 0; i < mask.length; i += 1) {
        if (!mask[i]) continue;
        d.data[i * 4] = rgb[0];
        d.data[i * 4 + 1] = rgb[1];
        d.data[i * 4 + 2] = rgb[2];
        d.data[i * 4 + 3] = 255;
      }
      st.dctx.putImageData(d, 0, 0);
      paint();
      return;
    }
    ui.cv.setPointerCapture(e.pointerId);
    pushUndo();
    st.stroke = p;
    const c = st.dctx;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = st.size;
    c.strokeStyle = COLORS[st.colorIndex];
    c.fillStyle = COLORS[st.colorIndex];
    c.globalCompositeOperation = st.tool === 'erase' ? 'destination-out' : 'source-over';
    c.beginPath();
    c.arc(p.x, p.y, st.size / 2, 0, Math.PI * 2);
    c.fill();
    paint();
  }

  function onPointerMove(e) {
    if (!st.stroke) return;
    const p = toImage(e);
    const c = st.dctx;
    c.beginPath();
    c.moveTo(st.stroke.x, st.stroke.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    st.stroke = p;
    paint();
  }

  function onPointerUp() {
    if (st) st.stroke = null;
  }

  function onKey(e) {
    if (!st) return;
    const typing = !!e.target && e.target.tagName === 'INPUT' && e.target.type === 'number';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      const prev = st.undo.pop();
      if (prev) {
        st.dctx.putImageData(prev, 0, 0);
        paint();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && !typing) {
      e.preventDefault();
      e.stopPropagation();
      api.close();
      return;
    }
    // The lens and the viewer must not see arrow keys, + - 0 or the wheel while editing (Ctrl+S and Esc still go on).
    if (['ArrowUp', 'ArrowDown', 'ArrowRight', '+', '-', '=', '_', '0'].includes(e.key) && !typing) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------- public ----------
  const api = {
    isOpen: false,
    // source: a canvas with the picture to edit; opts.onClose runs when the editor is left.
    // opts.rect (page coordinates) keeps the picture at that size and place with the panel beside it (lens); round = elliptic.
    open(source, opts) {
      if (!root) build();
      let W = source.width;
      let H = source.height;
      const k = Math.min(1, MAX_SIDE / Math.max(W, H), Math.sqrt(MAX_PIXELS / (W * H)));
      W = Math.max(1, Math.round(W * k));
      H = Math.max(1, Math.round(H * k));
      const make = () => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        return c;
      };
      const S = make();
      S.getContext('2d').drawImage(source, 0, 0, W, H);
      const rc = make();
      const bc = make();
      const D = make();
      ui.cv.width = W;
      ui.cv.height = H;
      st = {
        W, H, S, rc, bc, D, onClose: opts && opts.onClose, rect: opts && opts.rect, round: !!(opts && opts.round),
        rctx: rc.getContext('2d', { willReadFrequently: true }), bctx: bc.getContext('2d'), dctx: D.getContext('2d', { willReadFrequently: true }),
        cctx: ui.cv.getContext('2d', { willReadFrequently: true }),
        angle: 0, adj: { brightness: 0, contrast: 0, sharpness: 0, saturation: 0 },
        tool: null, size: 6, colorIndex: 6, undo: [], stroke: null,
        filters: [], cache: {}, fillOn: false, showFilter: true, opacity: 100,
        fopt: { canny: {}, bright: {}, sam: {} },
        rot: null, adjusted: null, gray: null, lines: null, filled: null, level: 0,
        samMasks: null, samW: 0, samH: 0, samToken: 0, samTimer: 0, samDecodeTimer: 0
      };
      for (const f of Object.keys(FILTER_OPTIONS)) for (const d of FILTER_OPTIONS[f]) st.fopt[f][d.key] = d.value;
      ui.angle.value = '0';
      ui.show.checked = true;
      ui.sizeKnob.set(6);
      ui.opacityKnob.set(100);
      syncAdjustKnobs();
      syncTools();
      syncPalette();
      syncFilterUi();
      root.classList.toggle('floating', !!st.rect);
      root.classList.add('open');
      api.isOpen = true;
      fit();
      run();
    },
    close() {
      if (!st) return;
      clearTimeout(st.samTimer);
      clearTimeout(st.samDecodeTimer);
      const done = st.onClose;
      st.samToken += 1;
      st = null;
      api.isOpen = false;
      root.classList.remove('open');
      if (done) done();
    },
    // The edited picture: result of the pipeline plus the drawing layer.
    exportCanvas() {
      if (!st) return null;
      const out = document.createElement('canvas');
      out.width = st.W;
      out.height = st.H;
      const c = out.getContext('2d');
      c.drawImage(st.bc, 0, 0);
      c.drawImage(st.D, 0, 0);
      return out;
    }
  };
  window.SMEditor = api;
})();
