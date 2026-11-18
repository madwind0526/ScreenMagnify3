(function () {
  const methods = [
    {
      id: 'nearest',
      label: '없음',
      group: '기본',
      gl: 'nearest',
      desc: '가장 가까운 픽셀을 그대로 확대합니다.'
    },
    {
      id: 'bilinear',
      label: 'Bilinear',
      group: '기본',
      gl: 'bilinear',
      desc: '빠르고 부드러운 양선형 보간입니다.'
    },
    {
      id: 'bicubic-catmull',
      label: 'Bicubic',
      group: '고품질',
      gl: 'bicubic-catmull',
      desc: '선명한 4x4 3차 보간입니다.'
    },
    {
      id: 'lanczos3',
      label: 'Lanczos3',
      group: '고품질',
      gl: 'lanczos3',
      desc: '선명도와 부드러움의 균형이 좋습니다.'
    },
    {
      id: 'nis',
      gpuOnly: true,
      fallback: 'lanczos3',
      label: 'NIS',
      sub: '(NVIDIA Image Scaling)',
      group: '업스케일러',
      gl: 'nis',
      desc: '6탭 스케일링과 방향성 샤프닝입니다.'
    },
    {
      id: 'nomos-span',
      label: '4xNomosUni SPAN',
      group: 'AI',
      gl: null,
      ai: true,
      model: 'nomos-span',
      desc: '아주 작고 빠른 AI 초해상도입니다.'
    },
    {
      id: 'realesrgan',
      label: 'Real-ESRGAN-x4v3',
      group: 'AI',
      gl: null,
      ai: true,
      model: 'realesrgan',
      desc: '글씨와 그림에 모두 좋은 AI 초해상도입니다. CPU에서도 빠릅니다.'
    },
    {
      id: 'realesrgan-x4plus',
      gpuOnly: true, // far too slow on the CPU (about 4 s for 256 px)
      fallback: 'realesrgan',
      label: 'Real-ESRGAN x4plus',
      group: 'AI',
      gl: null,
      ai: true,
      model: 'realesrgan-x4plus',
      desc: '그림에 좋은 고화질 AI입니다. 글씨는 깨질 수 있고 CPU에서는 느립니다.'
    }
  ];

  function byId(id) {
    return methods.find((method) => method.id === id) || methods[0];
  }

  function glFor(id) {
    const method = byId(id);
    return method.ai ? 'bilinear' : method.gl;
  }

  // Largest region (px per side) the AI runs on, from tile timings (a few seconds per view at most).
  // Bigger regions are shown with the filter instead. The CPU numbers also apply to a GPU fallback.
  const AI_LIMITS = {
    'nomos-span': { cpu: 1024, gpu: 1280 },
    realesrgan: { cpu: 640, gpu: 1280 },
    'realesrgan-x4plus': { cpu: 256, gpu: 512 }
  };

  // Largest AI input in pixels, whatever the per-side limit says: the x4 output is 16x that (2.5 M px -> about 150 MiB).
  // Keep in sync with AI_MAX_INPUT_PIXELS in electron/main.js.
  const AI_MAX_PIXELS = 2.5e6;

  // `override` (settings, px) wins over the table when it is above 0.
  function aiLimit(id, device, override) {
    if (override > 0) return override;
    const entry = AI_LIMITS[modelOf(id)] || { cpu: 256, gpu: 256 };
    return device === 'gpu' ? entry.gpu : entry.cpu;
  }

  function isAI(id) {
    return !!byId(id).ai;
  }

  function modelOf(id) {
    return byId(id).model || null;
  }

  function fillSelect(select, selectedId) {
    select.innerHTML = '';
    for (const method of methods) {
      const option = document.createElement('option');
      option.value = method.id;
      renderOption(option, method, false);
      select.appendChild(option);
    }
    select.value = methods.some((method) => method.id === selectedId) ? selectedId : methods[0].id;
  }

  // GPU-only methods (NIS) are disabled in the list while the device is CPU.
  // Option content: label plus small notes (full name, GPU-only), styled via the customizable select.
  function renderOption(option, method, off) {
    option.textContent = method.label;
    for (const note of [method.sub, off ? '(GPU 전용)' : '']) {
      if (!note) continue;
      const small = document.createElement('small');
      small.textContent = note;
      option.append(' ', small);
    }
  }

  function applyDevice(select, device) {
    for (const option of select.options) {
      const method = byId(option.value);
      const off = !!method.gpuOnly && device !== 'gpu';
      option.disabled = off;
      renderOption(option, method, off);
    }
  }

  function defaultMethodFor(index, primary, device) {
    const safePrimary = methods.some((method) => method.id === primary) ? primary : 'realesrgan';
    if (index === 0) return safePrimary;
    // Other panels compare against different, non-AI methods.
    return ['lanczos3', 'nis', 'bicubic-catmull', 'bilinear'].filter((id) => id !== safePrimary && (device === 'gpu' || !byId(id).gpuOnly))[index - 1];
  }

  window.SM = {
    methods,
    byId,
    glFor,
    isAI,
    aiLimit,
    AI_MAX_PIXELS,
    modelOf,
    fillSelect,
    applyDevice,
    defaultMethodFor
  };
})();
