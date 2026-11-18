(function () {
  const $ = (id) => document.getElementById(id);

  function apply(next) {
    document.documentElement.dataset.theme = next.theme === 'light' ? 'light' : 'dark';
    $('set-top').checked = !!next.alwaysOnTop;
    $('set-freeze').checked = !!next.freeze;
    if (document.activeElement !== $('set-delay')) $('set-delay').value = next.delay;
    $('set-aimax').value = String(next.aiMaxSize);
    $('set-mode').addEventListener('change', (e) => save({ mode: Number(e.target.value) }));
  $('set-max').addEventListener('change', (e) => save({ lensMaxScale: clamped(e.target, 1, 5) }));
  $('set-size').addEventListener('change', (e) => save({ lensSize: clamped(e.target, 5, 40) }));
  $('set-style').addEventListener('change', (e) => save({ lensStyle: e.target.value }));
  $('set-panels').value = String(next.panelCount);
    $('set-method').value = next.method;
    $('set-device').value = next.aiDevice;
    SM.applyDevice($('set-method'), next.aiDevice);
    $('set-mode').value = String(next.mode);
    $('set-style').value = next.lensStyle;
    if (document.activeElement !== $('set-max')) $('set-max').value = next.lensMaxScale;
    if (document.activeElement !== $('set-size')) $('set-size').value = next.lensSize;
    // Options that belong to the other mode are greyed out and disabled.
    const lens = next.mode === 2;
    for (const id of ['set-panels']) $(id).disabled = lens;
    for (const id of ['set-size', 'set-max', 'set-style']) $(id).disabled = !lens;
    $('aimax-whole').textContent = lens ? '돋보기' : '선택영역';
  }

  const clamped = (el, min, max) => {
    const value = Math.max(min, Math.min(max, Math.round(Number(el.value) || min)));
    el.value = value;
    return value;
  };

  const save = (patch) => window.api.settings.set(patch).then(apply);

  $('set-device').addEventListener('change', (e) => save({ aiDevice: e.target.value }));
  $('btn-close').addEventListener('click', () => window.api.window.close());
  $('set-top').addEventListener('change', (e) => save({ alwaysOnTop: e.target.checked }));
  $('set-freeze').addEventListener('change', (e) => save({ freeze: e.target.checked }));
  $('set-delay').addEventListener('change', (e) => {
    const value = Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0)));
    e.target.value = value;
    save({ delay: value });
  });
  $('set-method').addEventListener('change', (e) => save({ method: e.target.value }));
  $('set-aimax').addEventListener('change', (e) => save({ aiMaxSize: Number(e.target.value) }));
  $('set-panels').addEventListener('change', (e) => save({ panelCount: Number(e.target.value) }));
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '1' || e.key === '2')) {
      e.preventDefault();
      save({ mode: Number(e.key) });
    }
    if (e.key === 'Escape') window.api.window.close();
  });

  window.api.settings.get().then((s) => {
    SM.fillSelect($('set-method'), s.method);
    apply(s);
  });
  window.api.onSettingsChanged(apply);
})();
