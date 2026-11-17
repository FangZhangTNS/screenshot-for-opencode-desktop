# screenshot-for-opencode-desktop

Screenshot plugin for the OpenCode desktop app, packaged as a GUI plugin. It takes over what previously required patching `app.asar`: a camera button in the composer, a settings menu, a global hotkey, and a full annotation editor.

> **Third-party plugin, not affiliated with the OpenCode project.** This plugin relies on the desktop app's internal plugin host, not on a published API: the `./gui-experimental` bundle loader, the `GET /api/plugin/gui` route, the `Plugin.define` / `ctx.main` surface, `data-slot` DOM anchors, and the `session_message` table shape. The desktop app ships frequently and any of these can change without notice, which will break this plugin until it is updated.
>
> Developed and exercised end to end on OpenCode desktop **2.2.5** (Windows 10 19044). On **2.3.0** the host contract and the composer anchors are still present when the installed `app.asar` is checked, but that build has not had the full acceptance pass. Win11 and multi-monitor setups are unverified. There is no commitment to track upstream; issues may go unfixed.

| Desktop | Windows | Status |
|---|---|---|
| 2.2.5 | 10 19044 | Full acceptance pass |
| 2.3.0 | 10 19044 | Host contract and composer anchors checked against `app.asar`; no full pass |
| 2.2.x / 2.3.x | 11 | Shares the capture path with Win10; unverified |

## What this is for

This is not a general-purpose screenshot tool. It exists for one loop: a model edits a UI, cannot see the result, and the cheapest way to say what is wrong is a picture.

Two cases cover nearly every use:

- **Visual feedback while building UI.** The app renders something close but not right. Instead of describing the spacing, the colour or the alignment in words, capture the window, draw the correction on top of it, and send that. The annotation is part of the request, so the model reads "this box wider, that label centred" without a paragraph of prose.
- **A visible failure.** An error dialog, a broken layout, a console message. A picture of what you actually see carries more than a transcription of it.

The flow, end to end:

1. Press the camera button in the composer, or the global hotkey if one is bound. Every visible app window hides (on by default) and the system snipper opens.
2. Select a region. With **After capture: Edit before sending**, the annotation editor opens in a modal window of its own.
3. Annotate: arrows, boxes, numbered steps, text, and mosaic or blur over anything that should not leave the machine.
4. Confirm. The JPEG is placed in the composer input as an unsent attachment.
5. Add a sentence if the picture needs one, then send. The model receives the image with the rest of the message.

What this adds over "system snipper, then paste":

- The annotation step sits between capture and composer. The correction is drawn once and arrives with the request: no second editor, no re-copy.
- The image is placed in the composer, not copied for you. The system snipper hands the selection back through the clipboard, so the previous clipboard contents are replaced by the capture; the plugin neither reads nor clears them beforehand. If the composer refuses the image it is copied to the clipboard as a fallback, and the editor's Copy button writes there only when pressed.
- A global hotkey reaches capture without leaving the keyboard.
- Every image is capped at a 1568 px long edge (quality 90; the editor re-exports at 0.9), so a 4K screenshot costs a predictable number of tokens instead of a whole context window.

Use it when the picture is going into a prompt. If you only need an image on disk, the system snipper plus whatever editor you already have is enough, and this plugin is not in that path.

## Requirements

- Windows 10 or 11 (x64). Capture shells out to the platform snipper and to PowerShell, and Copy needs `System.Windows.Forms`. There is no fallback for macOS, Linux or ARM Windows: on any other platform the camera reports that the platform is unsupported instead of failing halfway.
- OpenCode desktop 2.x. The GUI half is only loaded by the desktop build; the terminal interface has no window to attach to, so the plugin does nothing there.
- Node.js 22.12 or newer to build. The toolchain (Vite 8) requires it.
- No npm runtime dependencies. `dist/index.js` is ESM and imports only `@opencode/plugin`; `dist/gui-experimental.cjs` is CommonJS and resolves whatever the desktop app provides.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Server half; exists only to give the plugin an id (`screenshot-for-opencode-desktop`) |
| `dist/index.js` | Server half build, the package `"."` export |
| `src/contract.ts` | `Ipc.define` contract `screenshot-for-opencode-desktop.shot` |
| `src/gui.tsx` | `Plugin.define` entry: window-side mount, main-process capture and providers |
| `src/composer.ts` | Camera button, settings menu, hotkey recorder, delivery |
| `src/shot-editor.ts` | Annotation editor (canvas, tools, export); mounted by both the window and the overlay |
| `src/editor-window.ts` | Entry for the editor window page, bundled separately |
| `src/screenshot/capture.ts` | Capture kernel |
| `src/screenshot/settings.ts` | Settings file read/write |
| `dist/gui-experimental.cjs` | Window build the host actually loads |
| `dist/editor-window.js` | Editor page bundle, inlined into the window build |
| `test/` | Node test files for the pure parts; bundled by esbuild before `node --test` |
| `.github/workflows/ci.yml` | Typecheck, tests and build on `windows-latest` |

## How the host loads it (verified on 2.2.5, re-checked on 2.3.0)

The installed app contains a plugin host (`out/main/host-*.js`) that evaluates `./gui-experimental` through `Function("require","module","exports", code)`. It requires the default export to be a `Plugin.define` object with `setup` or `main`. The plugin manifest travels over HTTP: `GET /api/plugin` lists enabled plugins and their feature flags, `GET /api/plugin/gui?id=<plugin>` returns the prebuilt CommonJS bundle. A plugin without `features.gui` never reaches the window.

Two constraints follow. The server half must load first, because it provides the id and the feature flag. The window bundle must be a single prebuilt CJS whose top level never touches `process`, and never imports `node:*` at module scope. Measured behaviour on 2.2.5: `process` genuinely does not exist, while a `node:*` import resolves to an inert Proxy that swallows every property access instead of throwing. So a module-scope `node:fs` import does not fail loudly in the window; it silently returns nothing, and the feature just stops working. Anything that must touch the filesystem therefore has to be reached through a `require` inside the function body, which only runs in the main process.

A third constraint is easy to miss and produces a runtime error rather than a build error: **an `Ipc.define` id must be namespaced under the plugin's own id**. A window may only call Ipc whose first segment equals the id declared in `Plugin.define`. With a plugin id of `my-plugin`, `my-plugin.shot` resolves, while `shot` or `something.shot` fails at click time with `calls only its own main entry, not Ipc "..."`. Renaming a plugin therefore requires renaming every Ipc id in the same commit.

## Camera button and settings menu

The composer toolbar gets a camera button plus a caret next to it. The button runs one capture; the caret opens a settings menu with four rows:

- Hide window while capturing (checkbox, on by default)
- After capture: send straight to the composer / edit first (radio, latter by default)
- Hotkey: record and clear (text chord field; Esc exits recording, Backspace clears)
- Language: English / Chinese

The mount point first looks for older composer anchors (`prompt-variant-control` and friends). 2.2.x removed those selectors, so it falls back to `[data-slot="composer-actions"]`.

## Capture

Capture records the clipboard sequence number, launches the platform snipper (Win10 `SnippingTool.exe /clip`, Win11 `explorer.exe ms-screenclip:`), scales the clipboard image and encodes it as JPEG (longest edge 1568, quality 90), then restores the window.

The implementation is fully asynchronous because the blocking alternative freezes the main process: `spawnSync` plus a PowerShell clipboard read holds the process until the selector closes.

- While blocked the app does not respond, right-click and Esc are not delivered, and the window stays hidden until the polling budget runs out; a tool that never exits keeps it hidden until the timeout fires.
- Shelling out four times in a row at startup (clear, three verifications, sequence read) holds the snipper back until all of them finish; measured at 8.4 seconds on Windows 10.

The main process no longer blocks:

| Step | Approach |
|---|---|
| Start the helper | One long-lived process, started before hiding the window, loads the key/sequence C# class |
| Hide the windows | `hide()` on every app window, wait 120 ms, then launch the snipper; a second window left on screen would end up in the shot |
| Launch the snipper | `spawn` immediately, without waiting for the helper |
| Wait for the result | Main polls the result file and both process states every 60 ms; only stat/open. On Windows 11 it also runs one `tasklist` probe every 2.5 s to notice that the overlay closed |
| Read the image | The helper records the clipboard sequence as a baseline and writes the new image as PNG once the sequence changes; main reads the file and transcodes to JPEG |
| Esc cancel | Main temporarily registers `globalShortcut("Escape")`, kills the snipper on press |
| Right-click cancel | The helper polls `GetAsyncKeyState`, kills the snipper and exits with 11; a self-exit also counts as cancel |

The clipboard is never cleared. The helper takes 1.6 seconds to start, so clearing after the user has selected would wipe the fresh image. Comparing sequence numbers already prevents a stale image from being delivered as new.

The helper needs a C# class for key state and the clipboard sequence. `Add-Type -MemberDefinition` recompiles that fragment on every call (about a second), so the helper instead compiles it once with `csc.exe` into `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-keys.dll` and loads it with `Add-Type -Path` (about 4 ms). If `csc.exe` is missing or blocked, it falls back to `Add-Type -MemberDefinition`.

Measured on a Windows 10 19044 VM: snipper appears in 142-210 ms, Esc cancel in 66-98 ms, window restored 244 ms after closing the snipper, `Responding=True` throughout, and `visibilityState` hidden then visible.

Right-click cancel is slower than Esc because the helper's PowerShell start costs about 1.6 seconds; the `Add-Type` cache removes compilation, not process startup.

## Annotation editor

The editor runs in its own `BrowserWindow`, a modal child of the app window. If the host refuses to create one, or the page fails to load, the same surface falls back to a full-page overlay inside the app window:

- Two canvases: `base` holds the screenshot, `over` holds annotations, composited on export.
- Eleven tools: rectangle, ellipse, line, arrow, brush, mosaic, blur, number marker, text, eraser, crop. The arrow head is a filled triangle with length `max(10, width*4)`; mosaic samples the average colour of `base` per cell and paints it on `over`; blur repaints the region under a rectangle through `ctx.filter`; a marker draws a filled circle with a contrasting digit and restarts at 1 when the tool is re-entered; crop only affects export, the annotation coordinate space stays in original-image pixels.
- The eraser uses `destination-out`, so it removes annotations only (mosaic included) and never the photo.
- Toolbar: tools, a nine-colour palette, width 1-12, mosaic cell 4-40, blur radius 2-24, font size 12-72, bold/italic/underline/outline/background, four font families, left/centre/right alignment, line spacing 0.8-2.5, undo, redo. Defaults: width 3, font 20, cell 14, blur 8.
- Text: every shape snapshots its own style (weight, slant, underline, family, alignment, spacing, outline, background), so changing the toolbar never restyles existing text. The outline colour is picked automatically for contrast; the underline is drawn by hand from `measureText` because canvas has no `text-decoration`.
- Object editing: any annotation can be selected by clicking it (rectangle and ellipse by border distance, line and arrow by segment distance, brush by point distance, text by bounding box, marker by radius, blur by rectangle interior), dragged, and removed with Delete/Backspace; a dashed box marks the selection.
- Undo uses a snapshot stack: creating, dragging and editing text are each one step, and a drag without movement records nothing.
- Property visibility follows the active tool: line tools show width, mosaic shows cell size, blur shows radius, text shows the full typography row, marker shows its size.
- Shortcuts: `1`-`9` and `0` pick tools, `C` picks crop (the eleventh), `Ctrl+Z` undo, `Ctrl+Y` / `Ctrl+Shift+Z` redo, `Ctrl+S` save, `Ctrl+C` copy, `Delete`/`Backspace` remove the selection, `Enter` confirm, `Esc` unwind (stroke -> text edit -> selection -> crop -> close).
- Footer: open image, save, copy, cancel, confirm. Save writes a full-resolution PNG through the main-process dialog - up to 1568 px for a capture, or the opened image's own size; copy writes the same PNG to the system clipboard through the main-process writer (an image written by the renderer here never reaches the system clipboard); confirm exports JPEG, longest edge 1568, quality 0.9, only for the model.

Export always paints a chrome-free overlay: the selection box and the crop mask are hidden before the image is composited, so neither ends up in the saved or copied file.

The overlay scales the canvas to the available space and maps pointer coordinates back through `getBoundingClientRect`, so drawing and export both work in original image pixels.

## Delivery

Delivery uses no private syntax: wrap the JPEG in a `File`, dispatch `DragEvent("drop")` with it in a `DataTransfer`, and if nothing called `preventDefault`, dispatch a `ClipboardEvent("paste")` instead. If both are refused the image is copied to the clipboard instead; if that also fails, delivery is reported as failed. Otherwise the image lands in the composer unsent for the user to confirm.

The event target is resolved in order: `[data-component="prompt-input"]`, then `[data-slot="composer-content"] [contenteditable="true"]`, then any `contenteditable`. The 2.2.x composer is a contenteditable div, so the original selector no longer exists.

## Global hotkey

Registered in the main process with `globalShortcut`. On press it runs one region capture and pushes the result to the window that asked, over the contract's event channel (`Ipc.define` `events`, emitted from main); the window half re-dispatches it as `CustomEvent("screenshot:hotkey")` and the composer applies the send mode and delivers.

Key rules: the key is one character or F1-F24; a bare key must be F1-F24, so a letter or digit needs Ctrl/Alt/Shift; `Ctrl+C/X/V/A/Z/W/S` and `Alt+F4` are refused; Win-key combinations are unsupported.

## Settings file

Path: `~/.config/opencode/oc-screenshot-settings.json`. Default values:

```json
{ "hideWindow": true, "sendMode": "edit", "hotkey": "", "language": "en" }
```

The UI language defaults to `en`. The settings menu switches it to `zh`, and the value is stored here: this file is the only place the language lives, so the window and the main process cannot disagree.

## Files it writes

| Path | What it is |
|---|---|
| `~/.config/opencode/oc-screenshot-settings.json` | The four settings; the only state that survives a restart |
| `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-clip-<hash>.exe` | Resident clipboard reader, compiled from a fixed C# source by `csc.exe` on first use |
| `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-clip-<hash>.json` | Size and SHA-256 of that binary; a mismatch rebuilds it |
| `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-keys.dll` | Key-state and clipboard-sequence class used by the capture helper |
| `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-keys-<pid>.cs` and `.dll` | The same class, compiled by the helper itself when `csc.exe` is available |
| `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-helper-<run>.ps1` | Capture helper script for one run |
| `%LOCALAPPDATA%\screenshot-for-opencode-desktop\screenshot-editor-<run>.html` and `-preload.js` | Editor page, deleted when the window closes |
| `%TEMP%\screenshot-image-<run>.png` | The capture while it is read, deleted afterwards |
| `%TEMP%\screenshot-tool-<run>.pid` | Launcher process id; the helper reads it to tell whether the selector still exists |
| `%TEMP%\screenshot-helper-<run>.ready` | Written by the helper when it has to take the clipboard base itself, so the selector can start |
| `%TEMP%\screenshot-copy-<timestamp>.png` | The image handed to the clipboard writer, deleted after the write |
| `%TEMP%\screenshot-capture.log` | One line per capture stage: the only trail for a capture that never returns |
| `%TEMP%\screenshot-helper.log` | Helper-side notes, three lines per capture |

The logs contain absolute paths, so strip the user name before pasting one into an issue.

## Privacy and security

- No network access and no telemetry. The plugin has no HTTP client and no update check; the only `fetch` in the bundle decodes a `data:` URL. An image leaves the machine only when the user sends the message that carries it.
- The selection travels through the system clipboard, so the snipper replaces whatever was there. The plugin does not read the previous contents and does not clear the clipboard afterwards.
- `powershell.exe` runs the capture helper with `-ExecutionPolicy Bypass -File`, and the clipboard writer as a short `-Command` script. `csc.exe` compiles one small C# class into `%LOCALAPPDATA%`; its source is a string in `src/gui.tsx`, and the compiled file is checked by size and SHA-256 before reuse. Security software may flag that helper: the paths are listed above so it can be inspected or excluded.
- A global hotkey stays registered while the plugin is loaded and is released when the plugin unloads. `Escape` is registered only for the duration of a capture.
- Nothing is redacted automatically. Mosaic and blur are manual tools, and a screenshot is whatever is on screen; treat a capture as sensitive until it has been looked at.

## Troubleshooting

The UI reports these; the text follows the Language setting.

| Message | Cause | What to do |
|---|---|---|
| `Screenshots need Windows` | The plugin is loaded on another platform | Nothing; capture is Windows-only |
| `Could not start the screenshot tool` | Snipping Tool is missing, or the Windows 11 `ms-screenclip:` protocol is not registered | Install Snipping Tool, then retry |
| `The capture helper exited with an error` | PowerShell is blocked by policy or by security software | Allow `powershell.exe` for your user, then check `%TEMP%\screenshot-helper.log` |
| `The capture came back empty` | The selection was empty or nothing reached the clipboard | Select a larger area and retry |
| `The capture was too large to read` | The PNG exceeded 40 MB | Select a smaller area |
| `The screenshot file could not be read` | The file was held or damaged (a virus scanner is the usual cause) | Retry; exclude `%TEMP%\screenshot-image-*.png` if it repeats |
| `Capture timed out with no image` | Nothing was selected for 60 seconds | Retry |
| `Another capture is already running` | A capture is running, or the editor window is open | Finish or close the editor first |
| `The saved hotkey could not be bound` | Another program holds the combination | Record a different one in the settings menu |
| `Hotkey is already in use` | Same cause, during recording | Record a different one |
| `The input box did not take the image` | The composer refused the drop and the paste events | The image was copied to the clipboard instead; paste it |
| `Settings were not saved` | The settings file is not writable | Check permissions on `~/.config/opencode` |
| `Image is too large to edit` | The picked image exceeds 24 megapixels or 25 MB, or the full-resolution export would exceed the size cap | Crop or resize it first |

If a capture fails and nothing in this table explains it, `%TEMP%\screenshot-capture.log` records the stage that was reached and the process ids involved.

## Install

```powershell
# The path matters: the plugin list entry is relative to this directory.
cd $HOME\.config\opencode\plugins
git clone https://github.com/FangZhangTNS/screenshot-for-opencode-desktop.git
cd screenshot-for-opencode-desktop
# Installs devDependencies, then builds dist/ through the prepare script.
npm install
```

The package is not published to npm (`private` is set); the repository is the distribution. `dist/` is not committed, so a fresh clone has to build once, which `npm install` does.

Then register it in `~/.config/opencode/opencode.json`:

```json
{ "plugins": ["./plugins/screenshot-for-opencode-desktop"] }
```

Restart the desktop app. A camera button plus a caret appears next to the composer controls; the caret opens the settings menu. If the button does not appear, check that `dist/gui-experimental.cjs` exists (the host loads that file, not the sources) and that the plugin id in `dist/index.js` matches the directory you registered.

`npm run watch` rebuilds only the window bundle on save; the host reloads it in place. Run `npm run build:server` after changing `src/index.ts`, and `npm run build:editor` after changing the editor sources.

The terminal interface reads `cli.json` and has no window, so this plugin does nothing there.

## Build

```powershell
npm run build:editor   # editor page, esbuild -> dist/editor-window.js
npm run build:server   # server half, esbuild -> dist/index.js
npm run build:gui      # window half, vite -> dist/gui-experimental.cjs (runs build:editor first)
npm run build          # all three, in order
npm run typecheck      # tsc --noEmit
npm test               # bundles test/*.test.ts with esbuild, runs node --test
```

`npm test` covers the pure parts: hotkey normalization, the en/zh capture message key sets, the documented settings defaults, and both copies of the 1568 px image cap. Anything that needs a window, a clipboard or a snipper is not covered; those paths are checked by hand on a VM.

`npm run watch` compiles the editor page once, then watches only the window bundle; it does not rebuild `dist/index.js`. After changing `src/shot-editor.ts` or `src/editor-window.ts`, run `npm run build:editor` (the running watcher then rebuilds the window bundle, which inlines that file). After changing `src/index.ts`, run `npm run build:server`.

`vite-plugin-solid` is listed in `devDependencies` here, but `@opencode/plugin/gui/vite` imports it without declaring it as its own dependency, so a setup that resolves only the host package fails to build. Installing this package's devDependencies covers it.

## Known limits

- The clipboard is shared state. Sequence numbers prevent a stale image from being delivered as new, but another program writing the clipboard at the same moment will hand over its image.
- Right-click cancel depends on a temporary PowerShell helper that takes about 1.6 seconds to start, so a right-click in the first second or two may be missed. Esc is caught by the main process and has no such delay.
- The editor opens as a modal child window: closing it closes the editor, never the app. The in-page overlay appears only when the host refuses a window or the editor page fails to load.
- Copy depends on PowerShell and `System.Windows.Forms`, so it is Windows-only.
- The Win11 `ms-screenclip:` branch shares the same logic but has only been exercised on Win10.
- The composer has an attachment cap (silently ignored from the sixth image on); delivery still reports success.
- Annotation text does not wrap: one line is drawn at its full measured width, so a line wider than the image is clipped at the right edge, in the editor and in the export.
- Within a multi-window app, the editor opens on the window the capture came from, and a hotkey press uses the last window that had focus. While the in-page overlay is open, the close guard refuses to close any app window: an overlay is a fallback for a host that refuses the editor window, and that path is not exercised per window.
- The hotkey is registered once for the whole app, so every window shares one combination.

## Contributing

Issues and pull requests in English are welcome. A useful report names the desktop version, the Windows build, and the last lines of `%TEMP%\screenshot-capture.log` with the user name stripped out. CI runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on `windows-latest`.

## License

MIT. See `LICENSE`.
