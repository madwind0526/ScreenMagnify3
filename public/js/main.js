(function () {
  const $ = (id) => document.getElementById(id);
  let current = null;
  let busy = false;
  let toastTimer = null;
  let countdownTimer = null;
  const runButton = $('btn-run');
  $('build-info').textContent = `${window.api.version} by madwind`;

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function apply(next) {
    current = next;
    const label = (key) => next[key].replace('Control', 'Ctrl');
    runButton.title = `실행 (Ctrl+Enter, 모드 1: ${label('hotkeyRun1')}, 모드 2: ${label('hotkeyRun2')})`;
    document.documentElement.dataset.theme = next.theme === 'light' ? 'light' : 'dark';
    // The lens has no free shape: in mode 2 it is disabled and rect shows as selected.
    const lens = next.mode === 2;
    const shown = lens && next.shape === 'free' ? 'rect' : next.shape;
    document.querySelectorAll('.shape').forEach((button) => {
      button.classList.toggle('active', button.dataset.shape === shown);
      if (button.dataset.shape === 'free') button.disabled = lens;
    });
  }

  function setBusy(value) {
    busy = value;
    runButton.disabled = value;
    if (!value) {
      clearInterval(countdownTimer);
      $('countdown').textContent = '';
    }
  }

  async function run() {
    if (busy || !current) return;
    setBusy(true);
    let remaining = current.delay;
    if (remaining > 0) {
      $('countdown').textContent = remaining;
      countdownTimer = setInterval(() => {
        remaining -= 1;
        $('countdown').textContent = remaining > 0 ? remaining : '';
      }, 1000);
    }
    try {
      // Pass the shape string itself; preload wraps it into { shape }.
      const result = await window.api.selection.start(current.shape);
      if (!result || !result.ok) setBusy(false);
    } catch (error) {
      setBusy(false);
      toast(error.message || '실행하지 못했습니다.');
    }
  }

  const save = (patch) => window.api.settings.set(patch).then(apply);

  runButton.addEventListener('click', run);
  document.querySelectorAll('.shape').forEach((button) => {
    button.addEventListener('click', () => save({ shape: button.dataset.shape }));
  });
  $('btn-settings').addEventListener('click', () => window.api.settings.toggleWindow());
  $('btn-theme').addEventListener('click', () => save({ theme: current.theme === 'light' ? 'dark' : 'light' }));
  $('btn-min').addEventListener('click', () => window.api.window.minimize());
  $('btn-close').addEventListener('click', () => window.api.window.close());
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  window.api.onHotkeyRun(run);
  window.api.selection.onDone(() => setBusy(false));
  window.api.selection.onError((message) => {
    setBusy(false);
    toast(message);
  });
  window.api.onSettingsChanged(apply);
  window.api.settings.get().then(apply);
})();
