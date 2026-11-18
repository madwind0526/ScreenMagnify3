// Save dialog of ScreenMagnify, reused for the lens: Ctrl+S saves what the lens shows as a PNG.
// The functions below are copied from ScreenMagnify's result.js; only the picture source and the open/closed hand-over differ.
(function () {
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let toastTimer = null;
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
  // The picture being saved (a canvas) and the function that makes it; set by lens.js.
  let snapshot = null;
  let provider = () => null;

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3400);
  }

  // Tell the main process: while the dialog is open Esc closes the dialog, not the lens.
  function setModalOpen(open) {
    window.SMSave.isOpen = open;
    window.api.lens.modal(open);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
    if (!snapshot) {
      img.removeAttribute('src');
      return;
    }
    try {
      const out = snapshot;
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
    // Take the picture first: the live lens keeps changing while the dialog is open.
    snapshot = provider();
    if (!snapshot) {
      toast('저장할 화면이 아직 없습니다.', true);
      return;
    }
    setModalOpen(true);
    $('save-modal').classList.remove('hidden');
    updateSavePreview();
    $('save-name').value = defaultFileName();
    saveState.selected = '';
    await loadPresets();

    const settings = await window.api.settings.get();
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
    snapshot = null;
    setModalOpen(false);
  }

  async function confirmSave() {
    if (saveState.saving) return;
    if (!saveState.dir) {
      toast('저장할 폴더를 선택하세요.', true);
      return;
    }
    if (!snapshot) return;
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
      const blob = await canvasBlob(snapshot);
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
    const saveOpen = !$('save-modal').classList.contains('hidden');
    if (event.key === 'Escape' && saveOpen) {
      event.preventDefault();
      closeSaveDialog();
    }
  });
  // Esc pressed without keyboard focus arrives through the main process.
  window.api.lens.onEscape(() => {
    if (!$('save-modal').classList.contains('hidden')) closeSaveDialog();
  });

  window.SMSave = {
    isOpen: false,
    open: openSaveDialog,
    toast,
    setProvider: (fn) => { provider = fn; },
    capture: () => provider()
  };
})();
