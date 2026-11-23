# ScreenMagnify3

> Working directory: `E:\Claude\ScreenMagnify3`

## Project Overview

ScreenMagnify (`..\ScreenMagnify`) and ScreenMagnify2 (`..\ScreenMagnify2`) in one Electron app. Settings `mode` picks the behavior: 1 = drag a selection and magnify it in a result window (ScreenMagnify), 2 = a lens that follows the mouse over the frozen or live screen (ScreenMagnify2). UI text is Korean; code comments are English.

## Tech Stack

Plain HTML/CSS/JS, Electron, WebGL2, JS CPU resampler, `onnxruntime-node` in a worker thread. `node_modules` is a junction to `..\ScreenMagnify\node_modules`.

## Commands

```bash
npm start          # run (unset ELECTRON_RUN_AS_NODE first from the Claude shell)
npm run check      # node --check on every script
npm run dist       # release/ScreenMagnify3-<version>.zip
start.bat / stop.bat
```

Settings: `%APPDATA%\screenmagnify3`.

## Key decisions

- **Base is ScreenMagnify's UI.** Lens files from ScreenMagnify2 are added unchanged: `public/lens.html`, `js/lens.js`, `js/save-dialog.js`, `css/save.css`, `assets/ring-carbon.png`. Shared files (`methods.js`, `upscaler.js`, `cpu-scaler.js`, `ai-worker.js`) were identical apart from ScreenMagnify having newer fixes, so ScreenMagnify's copies are used.
- **One settings object** (`electron/main.js`, `applySettingsPatch`). `selection:start` branches on `settings.mode` (`startLens` for 2). Options of the other mode are greyed and disabled in `settings.js`; the Free shape button is disabled in mode 2 (a saved `free` runs as `rect` in the lens).
- **Hotkeys** (settings `hotkeyMode1/2`, `hotkeyRun1/2`, defaults Ctrl+1, Ctrl+2, Ctrl+W, Ctrl+Q; picked in settings via `public/js/hotkey.js`): all global while the main window is shown. A run key also switches `mode`. Duplicates are refused; the settings window suspends them while a key is typed (`hotkey:capture`).
- **Background colors per project:** ScreenMagnify black `#0b0c10`, ScreenMagnify2 dark blue `#08162e`, ScreenMagnify3 dark purple `#170b2e` (`--bg` / `--bg-soft` in `main.css`, `result.css`, `save.css`).
- **Image editor** (`public/js/editor.js` UI, `editor-core.js` pixel code testable in Node, `css/editor.css`; overlay `#editor-root` in `lens.html` and `result.html`). Arrow keys in the lens / viewer: Up/Down = previous/next method, Right = open the editor on a snapshot (`composePanel` / `lensSnapshot`), Left = close. While open, lens.js (`editing`) and result.js ignore wheel, arrows, pointer; Ctrl+S saves `SMEditor.exportCanvas()`. SAM = MobileSAM ONNX (`models/mobile_sam_image_encoder.onnx`, `sam_mask_decoder_single.onnx`) in `electron/sam-worker.js`, IPC `sam:encode` / `sam:decode`; the worker is never `terminate()`d on a timeout.
- Settings window height is `SETTINGS_HEIGHT` in `main.js` (title bar + 15 rows, rows are 32 px); re-measure when adding rows.
- Ctrl+Q / Ctrl+W are global shortcuts: do not run ScreenMagnify or ScreenMagnify2 at the same time.

## Memory Bank

At session start read `memory-bank/active-context.md`, then `memory-bank/STATE.md`.
