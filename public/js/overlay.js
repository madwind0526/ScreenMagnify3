(function () {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const dimCanvas = document.createElement('canvas');
  const dimCtx = dimCanvas.getContext('2d');
  const guide = document.getElementById('guide');
  const guideShape = document.getElementById('guide-shape');
  const guideText = document.getElementById('guide-text');

  const SHAPE_LABEL = {
    rect: '사각형',
    ellipse: '원형',
    free: '자유'
  };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let shape = 'rect';
  let freezeImage = null;
  let dragging = false;
  let sent = false;
  let pointerId = null;
  let startPoint = null;
  let currentPoint = null;
  let rawPoint = null;
  let shiftHeld = false;
  let points = [];

  function clampPoint(point) {
    return {
      x: Math.max(0, Math.min(width, point.x)),
      y: Math.max(0, Math.min(height, point.y))
    };
  }

  // Holding Shift while dragging a rectangle or ellipse locks the aspect ratio to 1:1.
  function constrain(point) {
    if (!shiftHeld || shape === 'free' || !startPoint) return point;
    const dx = point.x - startPoint.x;
    const dy = point.y - startPoint.y;
    const signX = dx < 0 ? -1 : 1;
    const signY = dy < 0 ? -1 : 1;
    const room = Math.min(signX > 0 ? width - startPoint.x : startPoint.x, signY > 0 ? height - startPoint.y : startPoint.y);
    const size = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), room);
    return { x: startPoint.x + signX * size, y: startPoint.y + signY * size };
  }

  function boundsOf() {
    if (shape === 'free') {
      if (!points.length) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (!startPoint || !currentPoint) return null;
    const x = Math.min(startPoint.x, currentPoint.x);
    const y = Math.min(startPoint.y, currentPoint.y);
    return {
      x,
      y,
      w: Math.abs(currentPoint.x - startPoint.x),
      h: Math.abs(currentPoint.y - startPoint.y)
    };
  }

  function tracePath(target, rect) {
    target.beginPath();
    if (!rect) return;
    if (shape === 'ellipse') {
      target.ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2, 0, 0, Math.PI * 2);
      return;
    }
    if (shape === 'free') {
      if (!points.length) return;
      target.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        target.lineTo(points[index].x, points[index].y);
      }
      target.closePath();
      return;
    }
    target.rect(rect.x, rect.y, rect.w, rect.h);
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    dimCanvas.width = canvas.width;
    dimCanvas.height = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dimCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function drawDim(rect) {
    dimCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dimCtx.globalCompositeOperation = 'source-over';
    dimCtx.clearRect(0, 0, width, height);
    dimCtx.fillStyle = 'rgba(0, 0, 0, 0.56)';
    dimCtx.fillRect(0, 0, width, height);
    if (rect && rect.w > 0 && rect.h > 0) {
      dimCtx.globalCompositeOperation = 'destination-out';
      tracePath(dimCtx, rect);
      dimCtx.fillStyle = '#000';
      dimCtx.fill();
      dimCtx.globalCompositeOperation = 'source-over';
    }
  }

  function drawSizeChip(rect) {
    if (!rect || rect.w < 4 || rect.h < 4) return;
    const label = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    ctx.save();
    ctx.font = '600 12px "Segoe UI", "Malgun Gothic", sans-serif';
    const textWidth = ctx.measureText(label).width;
    const chipW = textWidth + 18;
    const chipH = 24;
    let x = rect.x + rect.w - chipW - 8;
    if (x < 4) x = rect.x + 8;
    let y = rect.y + rect.h + 8;
    if (y + chipH > height - 4) y = rect.y - chipH - 8;
    if (y < 4) y = Math.min(height - chipH - 4, rect.y + 8);
    ctx.fillStyle = 'rgba(15, 17, 24, 0.88)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, chipW, chipH, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#eef1f8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + chipW / 2, y + chipH / 2 + 0.5);
    ctx.restore();
  }

  function drawOutline(rect) {
    if (!rect) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 10;
    tracePath(ctx, rect);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    tracePath(ctx, rect);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (freezeImage) {
      ctx.drawImage(freezeImage, 0, 0, width, height);
    }

    const rect = boundsOf();
    drawDim(rect);
    ctx.drawImage(dimCanvas, 0, 0, width, height);

    if (rect && rect.w > 0 && rect.h > 0) {
      drawOutline(rect);
      drawSizeChip(rect);
    }
  }

  function begin(event) {
    if (sent || event.button !== 0) return;
    const point = clampPoint({ x: event.clientX, y: event.clientY });
    dragging = true;
    pointerId = event.pointerId;
    startPoint = point;
    currentPoint = point;
    rawPoint = point;
    shiftHeld = event.shiftKey;
    points = shape === 'free' ? [point] : [];
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Ignore.
    }
    guide.classList.add('dragging');
    draw();
  }

  let drawQueued = false;

  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function move(event) {
    if (!dragging || sent) return;
    const point = clampPoint({ x: event.clientX, y: event.clientY });
    rawPoint = point;
    shiftHeld = event.shiftKey;
    currentPoint = constrain(point);
    if (shape === 'free') {
      const last = points[points.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1.6) {
        points.push(point);
      }
    }
    scheduleDraw();
  }

  function finish() {
    if (!dragging || sent) return;
    dragging = false;
    if (pointerId !== null) {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {
        // Ignore.
      }
      pointerId = null;
    }
    guide.classList.remove('dragging');

    const rect = boundsOf();
    if (!rect || rect.w < 4 || rect.h < 4) {
      startPoint = null;
      currentPoint = null;
      points = [];
      draw();
      return;
    }

    if (shape === 'free') {
      if (points.length < 3) {
        startPoint = null;
        currentPoint = null;
        points = [];
        draw();
        return;
      }
      const payloadPoints = points.map((point) => ({
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100
      }));
      sent = true;
      guide.classList.add('dragging');
      window.api.overlay.select({
        rect: {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          w: Math.round(rect.w * 100) / 100,
          h: Math.round(rect.h * 100) / 100
        },
        polygon: payloadPoints
      });
      return;
    }

    sent = true;
    guide.classList.add('dragging');
    window.api.overlay.select({
      rect: {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.w * 100) / 100,
        h: Math.round(rect.h * 100) / 100
      },
      polygon: null
    });
  }

  function onInit(payload) {
    if (!payload) return;
    shape = payload.shape || 'rect';
    guideShape.textContent = SHAPE_LABEL[shape] || '선택';
    if (shape === 'free') {
      guideText.textContent = '마우스를 드래그하여 자유롭게 그리세요';
    } else if (shape === 'ellipse') {
      guideText.textContent = '드래그하여 원형으로 확대할 영역을 선택하세요';
    } else {
      guideText.textContent = '드래그하여 확대할 영역을 선택하세요';
    }

    if (payload.freeze) {
      const image = new Image();
      image.onload = () => {
        freezeImage = image;
        draw();
      };
      image.src = payload.freeze;
    }

    resize();
  }

  window.api.overlay.onInit(onInit);

  window.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') begin(event);
  });

  window.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') move(event);
  });

  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) finish();
  });

  window.addEventListener('pointercancel', () => {
    if (dragging) {
      dragging = false;
      startPoint = null;
      currentPoint = null;
      points = [];
      guide.classList.remove('dragging');
      draw();
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('blur', () => {
    if (dragging) {
      dragging = false;
      startPoint = null;
      currentPoint = null;
      points = [];
      guide.classList.remove('dragging');
      draw();
    }
  });

  window.addEventListener('contextmenu', (event) => event.preventDefault());
  function onShiftChange(event) {
    if (event.key !== 'Shift' || !dragging || !rawPoint) return;
    shiftHeld = event.type === 'keydown';
    currentPoint = constrain(rawPoint);
    draw();
  }

  window.addEventListener('keyup', onShiftChange);
  window.addEventListener('keydown', (event) => {
    onShiftChange(event);
    if (event.key === 'Escape') {
      event.preventDefault();
      window.api.overlay.cancel();
    }
  });

  resize();
})();
