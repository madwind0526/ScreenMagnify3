// Click-to-record hotkey field. The result is an Electron accelerator such as "Control+Shift+W".
(function () {
  function keyOf(e) {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) return e.code;
    return null;
  }

  window.hotkeyLabel = (accelerator) => String(accelerator).replace('Control', 'Ctrl');

  // Esc cancels. At least Ctrl or Alt is required so a plain letter cannot be taken from every program.
  window.bindHotkey = function (input, onPick) {
    input.readOnly = true;
    let before = '';
    input.addEventListener('focus', () => {
      before = input.value;
      input.value = '키 입력...';
      input.classList.add('capturing');
      // The main process drops the global hotkeys while a new one is typed, or typing the old key would trigger it.
      window.api.settings.captureHotkey(true);
    });
    input.addEventListener('blur', () => {
      input.classList.remove('capturing');
      window.api.settings.captureHotkey(false);
      if (input.value === '키 입력...') input.value = before;
    });
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        input.blur();
        return;
      }
      const key = keyOf(e);
      if (!key || !(e.ctrlKey || e.altKey)) return;
      onPick([e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+'));
      input.blur();
    });
  };
})();
