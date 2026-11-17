// Shared helpers for the capture path.
//
// Node APIs are fetched lazily: this module is bundled into one file that the
// window also evaluates, and `process` does not exist there. A module-scope
// `node:*` import would not throw either, it resolves to an inert proxy that
// silently swallows every access. Only the main-process entry calls these
// helpers, so nothing touches node at load time.
import { readShotSettings } from "./settings"

type NodeApis = {
  fs: typeof import("node:fs")
  os: typeof import("node:os")
  path: typeof import("node:path")
}

declare const require: ((id: string) => unknown) | undefined

let cached: NodeApis | null = null
function node(): NodeApis {
  if (cached) return cached
  // The host evaluates this bundle with a CommonJS require in scope; the window
  // half never calls node(), so the missing global there is harmless.
  const req = typeof require === "function" ? require : undefined
  if (!req) throw new Error("node api unavailable in this process")
  cached = {
    fs: req("node:fs") as NodeApis["fs"],
    os: req("node:os") as NodeApis["os"],
    path: req("node:path") as NodeApis["path"],
  }
  return cached
}

// Longest edge of the image handed to the model, in pixels. Capture resizes to it
// and the editor caps its export at the same number (MAX_DIM there).
export const MAX_IMAGE_DIM = 1568

// Every file this plugin writes to the OS temp directory carries this prefix, so
// a leftover from a killed run is recognisable at a glance and cannot collide
// with another program's scratch files. The names are shared with the PowerShell
// helper script, which is generated from these constants rather than repeating
// the literals.
const TEMP_PREFIX = "screenshot-"
export const TEMP_FILES = {
  captureLog: TEMP_PREFIX + "capture.log",
  helperLog: TEMP_PREFIX + "helper.log",
  image: TEMP_PREFIX + "image.png",
  helper: TEMP_PREFIX + "helper.ps1",
  toolPid: TEMP_PREFIX + "tool.pid",
  /** Written by the helper once it holds the clipboard base number. */
  helperReady: TEMP_PREFIX + "helper.ready",
  keysDll: TEMP_PREFIX + "keys.dll",
  /** Per-process csc input/output: `<stem>-<pid>.cs` and `<stem>-<pid>.dll`. */
  keysStem: TEMP_PREFIX + "keys",
  /** Clipboard temp PNG: `<stem>-<timestamp>.png`. */
  copyStem: TEMP_PREFIX + "copy",
} as const

// Win11 moved SnippingTool out of System32; resolve via PATH when the legacy path is gone.
export function snipToolWin10(): string {
  const root = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SystemRoot
  // SystemRoot is always set on Windows; the literal only covers a stripped
  // environment where the variable is missing.
  return `${root || "C:\\Windows"}\\System32\\SnippingTool.exe`
}

// Windows 11 build number. Above this the classic `SnippingTool.exe /clip` entry
// point is gone and the `ms-screenclip:` protocol takes over.
const WIN11_MIN_BUILD = 22000

// Status lines plus the settings labels the window cannot own. The text is only
// ever shown to the user: the window tells outcomes apart by the `kind` field of
// the capture packet, never by comparing these strings, so the wording is free to
// change without touching the window half.
export const MSG = {
  en: {
    regionOk: "Region screenshot captured.",
    cancelled: "The user cancelled the capture (no region selected). If the capture bar is still open, close it by hand.",
    timedOut: "Capture timed out with no image. If the capture overlay is still open, close it by hand and retry.",
    unsupported: "Screenshots need Windows: capture drives the system snipping tool and PowerShell, which this platform does not provide.",
    helperFailed: "The capture helper exited with an error. Check that PowerShell is allowed to run on this machine.",
    emptyImage: "The capture came back empty. Try selecting a wider area.",
    captureTooLarge: "The capture was too large to read. Try a smaller area.",
    captureUnreadable: "The screenshot file could not be read (a virus scanner may hold it). Try again.",
    toolMissing: "Could not start the screenshot tool. Check that Snipping Tool is installed.",
    saveTitle: "Save screenshot",
    editorTitle: "Edit screenshot",
    busy: "Another capture is already running.",
  },
  zh: {
    regionOk: "框选截图已捕获。",
    cancelled: "用户取消了截图（未框选任何区域）。若截图条仍在，请手动关闭。",
    timedOut: "截图超时，未收到图像。若截图界面仍开着请手动关闭后重试。",
    unsupported: "截图仅支持 Windows：采集依赖系统截图工具与 PowerShell，当前平台不提供。",
    helperFailed: "截图辅助进程异常退出，请检查本机是否允许运行 PowerShell。",
    emptyImage: "截图结果为空，请重新框选一块更宽的区域。",
    captureTooLarge: "截图文件过大，读取失败，请框选更小的区域。",
    captureUnreadable: "截图文件读取失败（可能被杀毒软件占用），请重试。",
    toolMissing: "无法启动系统截图工具，请检查是否已安装“截图工具”。",
    saveTitle: "保存截图",
    editorTitle: "编辑截图",
    busy: "已有一次截图正在进行。",
  },
}

/** Active UI language. One settings file drives both halves; English is the default. */
export function lang(): "en" | "zh" {
  try {
    return readShotSettings().language
  } catch {
    return "en"
  }
}

export function isWin11(): boolean {
  try {
    const rel = node().os.release() // "10.0.22631"
    const build = parseInt(rel.split(".")[2] || "0", 10)
    return build >= WIN11_MIN_BUILD
  } catch {
    return false
  }
}

/**
 * Capture shells out to SnippingTool, explorer.exe and PowerShell, and the
 * clipboard writer needs System.Windows.Forms. There is no non-Windows path, so
 * callers must check this first and fail with `MSG[lang()].unsupported` instead
 * of letting a missing binary surface as a spawn error the user cannot act on.
 */
export function isWindows(): boolean {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform
  return platform === "win32"
}

export function snipTool(): string {
  try {
    const legacy = snipToolWin10()
    if (node().fs.existsSync(legacy)) return legacy
  } catch {}
  return "SnippingTool.exe" // PATH lookup (required on Win11)
}
