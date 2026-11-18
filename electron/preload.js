const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  version: require('../package.json').version,
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    toggleWindow: () => ipcRenderer.send('settings:toggleWindow')
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },
  onHotkeyRun: (callback) => on('hotkey:run', callback),
  selection: {
    start: (shape) => ipcRenderer.invoke('selection:start', { shape }),
    cancel: () => ipcRenderer.send('selection:cancel'),
    onStarting: (callback) => on('selection:starting', callback),
    onCountdown: (callback) => on('selection:countdown', callback),
    onDone: (callback) => on('selection:done', callback),
    onError: (callback) => on('lens:error', callback)
  },
  lens: {
    onInit: (callback) => on('lens:init', callback),
    ready: () => ipcRenderer.send('lens:ready'),
    modal: (open) => ipcRenderer.send('lens:modal', !!open),
    onEscape: (callback) => on('lens:escape', callback),
    fail: (message) => ipcRenderer.send('lens:fail', String(message)),
    close: () => ipcRenderer.send('lens:close')
  },
  overlay: {
    onInit: (callback) => on('overlay:init', callback),
    select: (payload) => ipcRenderer.send('overlay:select', payload),
    cancel: () => ipcRenderer.send('overlay:cancel')
  },
  result: {
    onInit: (callback) => on('result:init', callback)
  },
  fs: {
    presets: () => ipcRenderer.invoke('fs:presets'),
    listDir: (dir) => ipcRenderer.invoke('fs:listDir', { dir }),
    mkdir: (dir, name) => ipcRenderer.invoke('fs:mkdir', { dir, name }),
    savePng: (payload) => ipcRenderer.invoke('fs:savePng', payload)
  },
  shell: {
    reveal: (target) => ipcRenderer.invoke('shell:reveal', target)
  },
  ai: {
    info: (model) => ipcRenderer.invoke('ai:info', { model }),
    ensure: (model) => ipcRenderer.invoke('ai:ensure', { model }),
    infer: (payload) => ipcRenderer.invoke('ai:infer', payload),
    onEvent: (callback) => on('ai:event', callback)
  },
  onSettingsChanged: (callback) => on('settings:changed', callback)
});
