import { Plugin } from "@opencode/plugin/gui"
import { type CaptureResult, mountComposerShot, normHotkey } from "./composer"
import { MAX_IMAGE_DIM, MSG, TEMP_FILES, isWin11, isWindows, lang as shotLang, snipTool } from "./screenshot/capture"
import { type ShotSettings, readShotSettings, writeShotSettings } from "./screenshot/settings"
import { openShotEditor } from "./shot-editor"
import { Shot } from "./contract"
import editorScript from "../dist/editor-window.js?raw"

// electron is provided by the host and kept external by the plugin build, so the
// types are declared here rather than pulled in as a dependency.
type ElectronPushWindow = { webContents: { executeJavaScript: (code: string) => Promise<unknown> } }
type ElectronHotkeyApi = {
  globalShortcut: {
    register: (accelerator: string, handler: () => void) => boolean
    unregister: (accelerator: string) => void
    unregisterAll: () => void
  }
}
type SaveDialogOptions = { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }
type ElectronDialogApi = {
  dialog: {
    // Electron accepts either (options) or (window, options). The window form keeps
    // the dialog modal to the window it belongs to.
    showSaveDialog: (
      windowOrOptions: unknown,
      maybeOptions?: SaveDialogOptions,
    ) => Promise<{ canceled: boolean; filePath?: string }>
  }
}
declare const require: (id: string) => unknown

type NodeApis = {
  fs: typeof import("node:fs")
  os: typeof import("node:os")
  path: typeof import("node:path")
}

/**
 * Node is fetched on first use, never at module scope: this file is part of the
 * bundle the window evaluates, and a top-level `node:*` import there resolves to
 * an inert proxy whose calls fail quietly in the middle of a capture.
 */
let nodeCache: NodeApis | null = null
function node(): NodeApis {
  if (nodeCache) return nodeCache
  nodeCache = {
    fs: require("node:fs") as NodeApis["fs"],
    os: require("node:os") as NodeApis["os"],
    path: require("node:path") as NodeApis["path"],
  }
  return nodeCache
}

/** Absolute path of one of the plugin's files in the OS temp directory. */
function tempPath(name: string): string {
  const { os, path } = node()
  return path.join(os.tmpdir(), name)
}

/**
 * Directory for files this plugin executes: the compiled clipboard helper, the
 * key-state assembly, the PowerShell script and the editor page.
 *
 * They must not live in the shared temp directory. On a machine where another
 * local account can write to %TEMP%, a planted executable there runs with this
 * user's rights; the per-user application-data directory is not shared.
 */
const RUNTIME_DIR_NAME = "screenshot-for-opencode-desktop"
function runtimeDir(): string {
  const { fs, os, path } = node()
  const base = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOCALAPPDATA
  const dir = path.join(base || os.tmpdir(), RUNTIME_DIR_NAME)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

function runtimePath(name: string): string {
  const { path } = node()
  return path.join(runtimeDir(), name)
}

/** Runtime path with this process' id in it, for files two runs must not share. */
function instanceRuntimePath(name: string): string {
  const dot = name.lastIndexOf(".")
  return runtimePath(dot > 0 ? `${name.slice(0, dot)}-${RUN_ID}${name.slice(dot)}` : `${name}-${RUN_ID}`)
}

type NativeImageLike = {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: (size: { width: number; height: number }) => NativeImageLike
  toJPEG: (quality: number) => Buffer
}
type ElectronClipboardApi = {
  nativeImage: { createFromBuffer: (buffer: Buffer) => NativeImageLike }
}

// Quality 90: the editor re-encodes what it is handed, so the first pass
// UI text, small enough that a 4K capture does not spend the context window on one
// image. Electron's toJPEG takes 0-100; the editor exports at 0.9 on canvas.
const CAPTURE_JPEG_QUALITY = 90
// A selector left open this long means the user walked away, and the app window
// stays hidden until capture gives up, so the budget stays short.
const REGION_TIMEOUT_MS = 60000
// Main polls the result file and both process states this often. Only stat/open
// work happens here, so the main process never blocks.
const POLL_MS = 60
// The helper watches the cancel keys for the same budget as main; neither side
// may outlive the other or a cancel would be missed.
const HELPER_WATCH_MS = REGION_TIMEOUT_MS
// Shortest pause between window.hide() and the snipper that keeps the app out of
// the shot in practice.
const HIDE_DELAY_MS = 120
// Fallback path only: when the clipboard helper cannot be built, the PowerShell
// helper has to record the sequence number itself and the selector waits for it.
// Six seconds covers a cold start including the csc compile.
const HELPER_READY_TIMEOUT_MS = 6000
// Last look after the budget expires: the write can land inside the poll gap.
const READY_FINAL_CHECK_MS = 250
// The snipper copies before it exits, so a finished selection needs a short grace
// window before that exit is read as a cancel.
const SELECTION_GRACE_TRIES = 10
const SELECTION_GRACE_MS = 50
// Win11: the overlay's process exit precedes the clipboard write, and a large
// selection can take a couple of seconds to encode.
const SELECTION_GRACE_WIN11_TRIES = 60
// PowerShell boot alone costs about 1.6 s, so the clipboard writer needs room.
const COPY_TIMEOUT_MS = 15000
// After a timeout kill, the file handle closes a moment later; deleting the PNG
// before that fails and leaves it behind.
const COPY_KILL_GRACE_MS = 2000
// A compiled helper prints the clipboard sequence number in milliseconds; asking
// PowerShell costs a shell boot the selector must not wait for.
const CLIP_EXE_TIMEOUT_MS = 4000
// How long a failed compile is left alone before it is attempted again.
const CLIP_EXE_RETRY_MS = 60_000
// One retry after a reload lost the race for the shortcut.
const REBIND_RETRY_MS = 600
// The resident reader answers in single-digit milliseconds; this bound only catches
// a wedged one before the gated path takes over. It is wide enough for the first
// read, whose JIT cost once pushed the very first capture onto the slow gate.
const CLIP_READ_TIMEOUT_MS = 1200
// How often the Win11 branch checks whether the snip overlay still exists.
const OVERLAY_PROBE_MS = 2500
// Before the overlay has been seen the first seconds matter: a quick cancel or a
// broken protocol handler should not leave the app hidden.
const OVERLAY_FIRST_PROBE_MS = 800
// How long the selector may take to appear, counted from the first authoritative
// "no such process" answer rather than from spawn. The check runs on probe ticks, so
// the effective limit is this plus one probe interval.
const OVERLAY_START_TIMEOUT_MS = 9000
// A capture png is a region of the screen at native resolution; anything past
// this is not something the helper wrote.
const MAX_CAPTURE_BYTES = 40 * 1024 * 1024
// Base64 of the image handed to the editor window.
const MAX_EDITOR_PAYLOAD = 40 * 1024 * 1024
// How long the page may take to answer the close question before the attempt is
// abandoned (the window stays open and its annotations stay alive).
const CLOSE_CONFIRM_TIMEOUT_MS = 20000
// A page that never finishes loading must not leave an invisible window behind.
const EDITOR_LOAD_TIMEOUT_MS = 15000
function powershellPath(): string {
  const root = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SystemRoot
  const absolute = `${root || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  try {
    if (node().fs.existsSync(absolute)) return absolute
  } catch {}
  return "powershell.exe"
}
const POWERSHELL = powershellPath()
// Win10 exposes the snipper as `SnippingTool.exe /clip`; Win11 dropped that entry
// point and only answers the `ms-screenclip:` protocol, which explorer owns.
const SNIP_ARG_WIN10 = "/clip"
const LAUNCHER_WIN11 = "explorer.exe"
const SNIP_PROTOCOL_WIN11 = "ms-screenclip:"

/**
 * True while a Win11 snip overlay process exists, null when the machine could not
 * be asked.
 *
 * One unfiltered tasklist answers for both builds: the overlay runs inside the
 * Snipping Tool app and its image name differs between releases. The "nothing
 * matched" sentence is localised, so absence of the image name is the signal and
 * only a failed tasklist is unknown.
 */
async function snipperRunning(): Promise<boolean | null> {
  const child = require("node:child_process") as typeof import("node:child_process")
  return await new Promise<boolean | null>((resolve) => {
    let output = ""
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let child_: ReturnType<typeof child.spawn> | null = null
    const finish = (value: boolean | null) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      const proc = child.spawn("tasklist", ["/NH"], { windowsHide: true })
      child_ = proc
      proc.stdout?.on("data", (chunk: Buffer) => {
        if (output.length < 4_000_000) output += chunk.toString("utf8")
      })
      proc.on("error", () => finish(null))
      proc.on("close", (code) => {
        if (code !== 0) return finish(null)
        const lower = output.toLowerCase()
        finish(lower.includes("screensketch") || lower.includes("snippingtool"))
      })
    } catch {
      finish(null)
    }
    timer = setTimeout(() => {
      // A tasklist that never answers would otherwise accumulate one process per
      // probe for the whole capture.
      try {
        child_?.kill()
      } catch {}
      finish(null)
    }, 1500)
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Trims a log line and drops anything that looks like an embedded image payload. */
function redactLog(text: string): string {
  return String(text)
    .replace(/data:[^,;]{0,40};base64,[A-Za-z0-9+/=]+/g, "data:<redacted>")
    .replace(/[A-Za-z0-9+/=]{200,}/g, "<blob>")
    .slice(0, 200)
}

/** Reads a capture file, refusing anything oversized or not a PNG. */
function readCaptureBuffer(path: string): Buffer | "too-large" | null {
  try {
    const { fs } = node()
    const size = fs.statSync(path).size
    if (size <= 0) return null
    if (size > MAX_CAPTURE_BYTES) return "too-large"
    const buffer = fs.readFileSync(path)
    // 89 50 4E 47 0D 0A 1A 0A
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
      return null
    }
    return buffer
  } catch {
    return null
  }
}

function logCapture(kind: string, bytes: number, ms: number, text: string): void {
  // One line per capture stage: a local trail is the equivalent of a beacon
  // trail, and it is the only way to see a capture that never returns.
  try {
    const line = `${new Date().toISOString()} kind=${kind} bytes=${bytes} ms=${ms} text=${redactLog(text)}\n`
    node().fs.appendFileSync(tempPath(TEMP_FILES.captureLog), line, "utf8")
  } catch {}
}

function logCopyFailure(error: unknown): void {
  try {
    const line = `${new Date().toISOString()} kind=copy-fail text=${redactLog(String(error))}\n`
    node().fs.appendFileSync(tempPath(TEMP_FILES.captureLog), line, "utf8")
  } catch {}
}

/** JPEG the image, capped at a 1568 px long edge and quality 90. */
function encodeShot(image: NativeImageLike): string {
  const size = image.getSize()
  if (size.width <= MAX_IMAGE_DIM && size.height <= MAX_IMAGE_DIM) {
    return image.toJPEG(CAPTURE_JPEG_QUALITY).toString("base64")
  }
  const ratio = Math.min(MAX_IMAGE_DIM / size.width, MAX_IMAGE_DIM / size.height)
  // A 4000x1 strip rounds the short edge to zero and Electron returns an empty
  // image for a zero dimension.
  return image
    .resize({
      width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio)),
    })
    .toJPEG(CAPTURE_JPEG_QUALITY)
    .toString("base64")
}

/**
 * Region capture.
 *
 * Blocking here is not an option: spawnSync plus a PowerShell clipboard read
 * parks the whole main process until the selector closes, so the app stops
 * responding, a right-click cannot be answered, and the window stays hidden for
 * the full poll budget. This host's electron clipboard exposes `clear`/`has` but
 * no `readImage`, so the capture runs as: read the clipboard sequence number with a
 * compiled helper, launch the selector, and run one PowerShell helper that spills
 * the first new image to a file. The main process only polls stat/open work in a
 * 60 ms loop, so it never blocks. When the compiled helper is unavailable the
 * sequence number is taken by PowerShell instead and the selector waits for it.
 */
/** One capture at a time: two helpers would race over the same temp files. */
let capturing = false
/** Restores the window this instance hid, so a teardown can put it back. */
let restoreHiddenWindow: (() => void) | null = null
let registeredHotkey = ""
/** The window a capture started from; the editor opens on it. */
let lastCaptureWindow: CaptureWindow | null = null
/** True while the app is quitting, so window guards stand aside. */
let appQuitting = false
/**
 * Set by this instance's cleanup. A reload leaves the outgoing capture loop alive,
 * and it must stop instead of racing the instance that replaced it.
 */
let instanceClosed = false

/**
 * Files this main process owns. Another instance, or a plugin reload while a
 * capture is still running, must not share them: the new run deletes the image
 * file before the old one has read it.
 */
const RUN_ID = (() => {
  // A plugin reload keeps the pid, so the pid alone would let an old and a new
  // instance share temp files: the old capture would delete the new capture's png.
  const scope = globalThis as { __ocShotRunSeq?: number }
  scope.__ocShotRunSeq = (scope.__ocShotRunSeq ?? 0) + 1
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid ?? 0
  return `${pid}-${scope.__ocShotRunSeq}`
})()
function instancePath(name: string): string {
  const dot = name.lastIndexOf(".")
  return tempPath(dot > 0 ? `${name.slice(0, dot)}-${RUN_ID}${name.slice(dot)}` : `${name}-${RUN_ID}`)
}

type LiveWindow = {
  hide: () => void
  show: () => void
  focus: () => void
  getBounds?: () => { x: number; y: number; width: number; height: number }
  isMinimized?: () => boolean
  isVisible?: () => boolean
  isDestroyed?: () => boolean
  restore?: () => void
}
type CaptureWindow = LiveWindow | null

/**
 * The clipboard sequence number has to be read before the selector exists, and the
 * read has to be fast: PowerShell needs 0.6-3 s to boot, which would otherwise be
 * dead time between the click and the crosshair. This compiles once into the temp
 * directory (csc is already used for the key-state class) and prints the number.
 */
const CLIP_EXE_SOURCE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class OcShotClip {",
  '  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();',
  "  // One process, one answer per line: starting .NET costs 40-330 ms, which would",
  "  // otherwise sit between the click and the crosshair on every capture.",
  "  public static int Main() {",
  "    string line;",
  "    while ((line = Console.ReadLine()) != null) {",
  "      Console.WriteLine(GetClipboardSequenceNumber());",
  "    }",
  "    return 0;",
  "  }",
  "}",
].join("\r\n")

/**
 * The cache key is the source, not a hand-written version: a leftover binary from
 * an older build would otherwise keep running silently after the code changed.
 */
function hashOf(input: string): string {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) hash = (hash * 31 + input.charCodeAt(index)) | 0
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const CLIP_EXE_STEM = `screenshot-clip-${hashOf(CLIP_EXE_SOURCE)}`
let clipExeReady = false
// A failed compile is retried later: a virus scanner holding the file for a second
// must not send every capture down the slow path until the app restarts.
let clipExeRetryAt = 0
let clipExeBuild: Promise<boolean> | null = null

function clipExePath(): string {
  return runtimePath(`${CLIP_EXE_STEM}.exe`)
}

function clipExeSidecar(): string {
  return runtimePath(`${CLIP_EXE_STEM}.json`)
}

/**
 * Records the hash of a freshly built helper, so a replaced file is noticed.
 *
 * It takes the bytes this process just compiled rather than reading the target: a
 * rename that failed because the old file was locked must not certify that old
 * file. This does not stop anyone who can write the directory (they can rewrite the
 * sidecar too); it stops a half-written, quarantined or stale binary from running.
 */
function writeClipExeSidecar(bytes: Buffer): void {
  try {
    const digest = (require("node:crypto") as typeof import("node:crypto")).createHash("sha256").update(bytes).digest("hex")
    node().fs.writeFileSync(clipExeSidecar(), JSON.stringify({ size: bytes.length, sha256: digest }), "utf8")
  } catch {}
}

function clipExeIntact(): boolean {
  try {
    const recorded = JSON.parse(node().fs.readFileSync(clipExeSidecar(), "utf8")) as { size?: number; sha256?: string }
    const bytes = node().fs.readFileSync(clipExePath())
    if (!recorded?.sha256 || recorded.size !== bytes.length) return false
    const digest = (require("node:crypto") as typeof import("node:crypto")).createHash("sha256").update(bytes).digest("hex")
    return digest === recorded.sha256
  } catch {
    return false
  }
}

/**
 * Deletes leftovers from earlier runs in the runtime directory: one helper script
 * per start, editor pages that outlived their window, half-written key assemblies.
 * Anything newer than a day is left alone, so a second instance is never affected.
 */
function pruneRuntimeDir(): void {
  try {
    const { fs } = node()
    const keep = new Set([
      `${CLIP_EXE_STEM}.exe`,
      `${CLIP_EXE_STEM}.json`,
      // This run's helper script is written once and then reused: pruning it between
      // the write and the spawn would break every capture until the app restarts.
      `screenshot-helper-${RUN_ID}.ps1`,
    ])
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(runtimeDir())) {
      if (keep.has(name)) continue
      if (!/^screenshot-(helper|editor|keys|clip)-/.test(name)) continue
      const file = runtimePath(name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch {}
    }
  } catch {}
}

/**
 * Deletes this plugin's data files that a killed run left in the shared temp
 * directory: a full-resolution capture is the one thing that must not linger.
 * Logs are kept, and anything newer than a day belongs to a live instance.
 */
function pruneTempDir(): void {
  try {
    const { fs } = node()
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(tempPath(""))) {
      if (!/^screenshot-(image|copy|helper|tool|keys)-/.test(name)) continue
      if (/\.log$/i.test(name)) continue
      const file = tempPath(name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch {}
    }
  } catch {}
}

/** Deletes the copies older builds kept in the shared temp directory. */
function dropLegacyTempArtefacts(): void {
  try {
    const { fs } = node()
    for (const name of fs.readdirSync(tempPath(""))) {
      // Historical executable artefacts only. This version keeps its executable
      // files in the per-user application data directory, but its helper log and
      // its ready gate still live here under the same prefix.
      const legacy =
        (name.startsWith("screenshot-clip") || name.startsWith("screenshot-keys")) &&
        /\.(exe|dll|cs)$/i.test(name)
      if (!legacy) continue
      try {
        fs.unlinkSync(tempPath(name))
      } catch {}
    }
  } catch {}
}

function ensureClipExe(): Promise<boolean> {
  if (clipExeReady) return Promise.resolve(true)
  if (Date.now() < clipExeRetryAt) return Promise.resolve(false)
  // Two callers (plugin start, first capture) must not compile into each other's
  // files; they also must not delete the .cs while the other one is reading it.
  if (clipExeBuild) return clipExeBuild
  clipExeBuild = buildClipExe().finally(() => {
    clipExeBuild = null
  })
  return clipExeBuild
}

async function buildClipExe(): Promise<boolean> {
  // Independent of the branch below: an upgrade may find its own binary missing
  // while the previous version's executable leftovers are still in the shared
  // directory, and that is exactly the run that should clear them.
  dropLegacyTempArtefacts()
  pruneTempDir()
  pruneRuntimeDir()
  if (node().fs.existsSync(clipExePath()) && clipExeIntact()) {
    clipExeReady = true
    return true
  }
  // Missing or replaced: rebuild rather than run whatever is there.
  try {
    node().fs.unlinkSync(clipExePath())
  } catch {}
  const child = require("node:child_process") as typeof import("node:child_process")
  const csPath = runtimePath(`${CLIP_EXE_STEM}-${RUN_ID}.cs`)
  const exePath = runtimePath(`${CLIP_EXE_STEM}-${RUN_ID}.exe`)
  const windir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.WINDIR
  const csc = `${windir || "C:\\Windows"}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`
  try {
    node().fs.writeFileSync(csPath, CLIP_EXE_SOURCE, "ascii")
    await new Promise<void>((resolve, reject) => {
      const proc = child.spawn(csc, ["/nologo", "/target:exe", `/out:${exePath}`, csPath], {
        windowsHide: true,
        stdio: "ignore",
      })
      // Without this a wedged csc would leave the promise pending forever: no
      // reader, no error line, and every capture silently falls back to the gate.
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        reject(new Error("csc timed out"))
      }, CLIP_EXE_TIMEOUT_MS)
      proc.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      proc.on("close", (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`csc exit ${code}`))
      })
    })
    const built = node().fs.readFileSync(exePath)
    try {
      node().fs.renameSync(exePath, clipExePath())
    } catch (error) {
      // Another instance may have published the same binary first, and a running
      // image cannot be replaced on Windows. Either way the target must be the
      // binary this process compiled, or it is not ours to run.
      if (!node().fs.existsSync(clipExePath())) throw error
      const crypto = require("node:crypto") as typeof import("node:crypto")
      const currentDigest = crypto.createHash("sha256").update(node().fs.readFileSync(clipExePath())).digest("hex")
      const builtDigest = crypto.createHash("sha256").update(built).digest("hex")
      if (currentDigest !== builtDigest) throw new Error("the helper at the target is not the one just built")
    }
    clipExeReady = true
    writeClipExeSidecar(built)
  } catch (error) {
    // Fall back to the gated path; a machine without csc still captures.
    logCapture("clip-exe", 0, 0, String(error))
    clipExeRetryAt = Date.now() + CLIP_EXE_RETRY_MS
    return false
  } finally {
    try {
      node().fs.unlinkSync(csPath)
    } catch {}
    try {
      if (node().fs.existsSync(exePath)) node().fs.unlinkSync(exePath)
    } catch {}
  }
  return true
}

type ClipReader = {
  proc: ReturnType<typeof import("node:child_process").spawn>
  waiters: Array<(value: number | null) => void>
  buffer: string
}

let clipReader: ClipReader | null = null

function startClipReader(): ClipReader | null {
  if (clipReader) return clipReader
  if (!node().fs.existsSync(clipExePath())) return null
  const child = require("node:child_process") as typeof import("node:child_process")
  let proc: ReturnType<typeof child.spawn>
  try {
    proc = child.spawn(clipExePath(), [], { windowsHide: true })
  } catch {
    return null
  }
  const reader: ClipReader = { proc, waiters: [], buffer: "" }
  // A dead reader must not leave callers hanging; the next capture restarts it.
  const drain = () => {
    for (const waiter of reader.waiters.splice(0)) waiter(null)
    if (clipReader === reader) clipReader = null
  }
  proc.stdout?.on("data", (chunk: Buffer) => {
    reader.buffer += chunk.toString("utf8")
    let index = reader.buffer.indexOf("\n")
    while (index >= 0) {
      const line = reader.buffer.slice(0, index).trim()
      reader.buffer = reader.buffer.slice(index + 1)
      const value = Number.parseInt(line, 10)
      const waiter = reader.waiters.shift()
      if (waiter) waiter(Number.isFinite(value) ? value : null)
      index = reader.buffer.indexOf("\n")
    }
  })
  // A write to a helper that died between the close event and this line surfaces
  // here, not on `proc`: an unhandled stream error would throw in the main process.
  proc.stdin?.on("error", drain)
  proc.on("error", drain)
  proc.on("close", drain)
  clipReader = reader
  return reader
}

function stopClipReader(): void {
  const reader = clipReader
  clipReader = null
  if (!reader) return
  for (const waiter of reader.waiters.splice(0)) waiter(null)
  try {
    reader.proc.kill()
  } catch {}
}

/** Clipboard sequence number, or null when the helper is unavailable. */
async function clipboardSequence(): Promise<number | null> {
  // The helper is compiled in the background at start-up; a capture in the first
  // second would otherwise fall back to the slow gate.
  if (!clipExeReady) await ensureClipExe()
  const reader = startClipReader()
  if (!reader) return null
  return await new Promise<number | null>((resolve) => {
    let settled = false
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      // Alive but silent (suspended, blocked on a redirected TEMP): replace it, or
      // every capture pays the timeout before falling back to the gate.
      finish(null)
      stopClipReader()
    }, CLIP_READ_TIMEOUT_MS)
    reader.waiters.push(finish)
    try {
      reader.proc.stdin?.write("s\n")
    } catch {
      // Drop the waiter, not only settle it: a settled entry left in the queue
      // would swallow the next real answer and cost that request its timeout.
      const index = reader.waiters.indexOf(finish)
      if (index >= 0) reader.waiters.splice(index, 1)
      finish(null)
    }
  })
}

async function captureRegion(target?: CaptureWindow): Promise<CaptureResult> {
  // A capture started while the editor is up only hides the window and drops its
  // result: the editor is checked here, so every entry point is covered. The
  // overlay reports its state through editorOpen.
  if (overlayOpen || (editorWindowRef && !editorWindowRef.isDestroyed())) {
    return { base64: null, text: MSG[shotLang()].busy, kind: "busy" }
  }
  if (capturing) {
    return { base64: null, text: MSG[shotLang()].busy, kind: "busy" }
  }
  const messages = MSG[shotLang()]
  const started = Date.now()
  const settings = readShotSettings()
  // Nothing above this line can leave a capture half-open: `capturing` is set only
  // after the platform check, so a click on macOS cannot leave the plugin
  // reporting "already running" for the rest of the session.
  if (!isWindows()) {
    logCapture("unsupported", 0, 0, messages.unsupported)
    return { base64: null, text: messages.unsupported, kind: "failed" }
  }
  const electron = require("electron") as ElectronClipboardApi
  const child = require("node:child_process") as typeof import("node:child_process")
  const hotkeys = require("electron") as ElectronHotkeyApi

  const imagePath = instancePath(TEMP_FILES.image)
  const helperPath = instanceRuntimePath(TEMP_FILES.helper)
  const keysDllPath = runtimePath(TEMP_FILES.keysDll)
  const keysStemPath = runtimePath(TEMP_FILES.keysStem)
  const toolPidPath = instancePath(TEMP_FILES.toolPid)
  const readyPath = instancePath(TEMP_FILES.helperReady)

  let window: CaptureWindow = null
  let hide = false
  // Every window this capture hid, with the state it had, so all of them come back:
  // hiding only the focused one leaves the others on screen, inside the selection the
  // user draws around the app window.
  const hiddenWindows: Array<{ window: LiveWindow; wasVisible: boolean }> = []
  let helper: ReturnType<typeof child.spawn> | null = null
  let tool: ReturnType<typeof child.spawn> | null = null
  let escaped = false
  let escapeBound = false
  // A spawn failure is not a cancel: a machine without SnippingTool, or one whose
  // policy blocks PowerShell, must not be reported as "you cancelled the capture".
  let spawnError: Error | null = null
  let whichSpawnFailed: "helper" | "tool" | null = null
  // The window is hidden for the duration of the selector. Every transition is
  // logged: an app that stays hidden is otherwise indistinguishable from one that
  // was closed, and this path has no other trace.
  const setWindowVisible = (target: CaptureWindow, visible: boolean, why: string) => {
    if (!target) return
    try {
      if (visible) {
        // A minimised window stays minimised through show(); the result toast would
        // be invisible and the hotkey would look broken.
        if (target.isMinimized?.()) target.restore?.()
        target.show()
        target.focus()
      } else {
        target.hide()
      }
      logCapture("window", 0, 0, `${visible ? "show" : "hide"} ok ${why}`)
    } catch (error) {
      logCapture("window", 0, 0, `${visible ? "show" : "hide"} failed ${why}: ${String(error)}`)
      if (!visible) return
      // The captured wrapper can be stale; the live list is the second chance.
      try {
        const live = windowsRef.current?.()
        if (live) {
          live.show()
          live.focus()
          logCapture("window", 0, 0, "show retry ok")
        }
      } catch (retryError) {
        logCapture("window", 0, 0, `show retry failed: ${String(retryError)}`)
      }
    }
  }
  const stop = (proc: ReturnType<typeof child.spawn> | null) => {
    try {
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill()
    } catch {}
  }

  capturing = true
  try {
    window = target ?? windowsRef.current?.() ?? null
    // Remembered so the editor opens on the window the capture came from, even if the
    // focus moved while the image was encoded.
    lastCaptureWindow = window
    hide = settings.hideWindow && !!window

    // Esc cancels through the app itself. The helper below also watches for it, but
    // a PowerShell process needs about 1.6 s to boot, and a global shortcut answers
    // on the next tick.
    try {
      escapeBound = hotkeys.globalShortcut.register("Escape", () => {
        escaped = true
      })
      // The registration is process-wide and keyed by accelerator: record which
      // instance owns it, or a reload's outgoing capture unbinds the new one's Esc.
      if (escapeBound) (globalThis as { __ocShotEscOwner?: string }).__ocShotEscOwner = RUN_ID
    } catch {}

    for (const path of [imagePath, `${imagePath}.part`, readyPath, toolPidPath]) {
      try {
        node().fs.unlinkSync(path)
      } catch {}
    }

    // The helper drains the stale key state, watches the cancel keys, and publishes
    // the first image whose sequence number differs from the base. It starts before
    // the window hides, so its PowerShell boot overlaps the delay.
    // Everything except the temp paths is static, so the script is only rewritten
    // when it actually changed.
    const helperScript = [
      // The key-state class and the sequence number need nothing from WinForms, and
      // loading WinForms plus Drawing costs a second on a slow machine. Taking the
      // base first is what lets the selector start early.
      `$dll = '${keysDllPath.replace(/'/g, "''")}'`,
      "if (-not (Test-Path -LiteralPath $dll)) {",
      "  try {",
      `    $cs = '${keysStemPath.replace(/'/g, "''")}-' + $PID + '.cs'`,
      `    $tmp = '${keysStemPath.replace(/'/g, "''")}-' + $PID + '.dll'`,
      "    $csc = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'",
      "    @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public class OcShotKeys {",
      "  [DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);",
      "  [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();",
      "}",
      "'@ | Set-Content -LiteralPath $cs -Encoding ASCII",
      "    & $csc /nologo /target:library /out:$tmp $cs | Out-Null",
      "    Remove-Item -LiteralPath $cs -Force -ErrorAction SilentlyContinue",
      "    Move-Item -LiteralPath $tmp -Destination $dll -Force",
      "  } catch {}",
      "}",
      "try { Add-Type -Path $dll -ErrorAction Stop } catch {",
      "  Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey); [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();' -Name OcShotKeys",
      "}",
      // Without the type the whole loop is a no-op that ends with exit 0, which
      // reads as a user cancel. Fail loudly instead.
      "if (-not ('OcShotKeys' -as [type])) { exit 13 }",
      // Virtual-key codes the helper watches for: 0x02 is VK_RBUTTON, 0x1B is
      // VK_ESCAPE.
      "$RB = 0x02; $ESC = 0x1B",
      // The low bit of GetAsyncKeyState means "pressed since the last query" and it
      // survives across processes: a right-click or Esc anywhere before the capture
      // would make the first loop iteration look like a cancel. Reading both keys
      // once throws that history away.
      "[void][OcShotKeys]::GetAsyncKeyState($RB)",
      "[void][OcShotKeys]::GetAsyncKeyState($ESC)",
      // No clipboard clear: a clear that lands after a fast selection would destroy
      // the very image it is waiting for. Comparing sequence numbers ignores stale
      // content just as well. The number is normally passed in: the main process can
      // read it in milliseconds, before this shell has even started.
      "$base = if ($args.Count -ge 1) { [uint32]$args[0] } else { [OcShotKeys]::GetClipboardSequenceNumber() }",
      `$dbg = '${tempPath(TEMP_FILES.helperLog).replace(/'/g, "''")}'`,
      "function Note([string]$m) { try { Add-Content -LiteralPath $dbg -Value ((Get-Date -Format 'HH:mm:ss.fff') + ' ' + $m) } catch {} }",
      "Note ('boot base=' + $base)",
      // Fallback only: when the main process could not read the number itself it
      // waits for this file before launching the selector.
      `$ready = '${readyPath.replace(/'/g, "''")}'`,
      "if ($args.Count -lt 1) { try { Set-Content -LiteralPath $ready -Value $base -Encoding ASCII } catch {} }",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$path = '${imagePath.replace(/'/g, "''")}'`,
      // The image is written to a sibling and renamed: GDI+ keeps the target file
      // readable while Save runs, so a poll would otherwise decode a half PNG.
      "$part = $path + '.part'",
      "function Save-Shot($img) {",
      "  $flat = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
      "  $g = [System.Drawing.Graphics]::FromImage($flat)",
      "  $g.Clear([System.Drawing.Color]::White)",
      "  $g.DrawImage($img, 0, 0, $img.Width, $img.Height)",
      "  $g.Dispose()",
      "  $img.Dispose()",
      "  $flat.Save($part, [System.Drawing.Imaging.ImageFormat]::Png)",
      "  $flat.Dispose()",
      "  Move-Item -LiteralPath $part -Destination $path -Force",
      "  exit 12",
      "}",
      // The instance path, not the shared name: the main process writes this
      // run's selector pid there, and reading another run's pid makes the helper
      // believe the selector already exited.
      `$pidFile = '${toolPidPath.replace(/'/g, "''")}'`,
      "$toolAlive = $false",
      "try { $tp = [int](Get-Content -LiteralPath $pidFile -Raw); if ($tp -gt 0) { $toolAlive = [bool](Get-Process -Id $tp -ErrorAction SilentlyContinue) } } catch {}",
      "Note ('tool pid=' + $tp + ' alive=' + $toolAlive)",
      "$t0 = [Environment]::TickCount",
      "$start = Get-Date",
      // The selector may have closed before this process finished booting; then
      // whatever sits on the clipboard is the result.
      "if (-not $toolAlive) {",
      "  try {",
      "    if (([OcShotKeys]::GetClipboardSequenceNumber()) -ne $base) {",
      "      $early = [System.Windows.Forms.Clipboard]::GetImage()",
      "      if ($early) { Save-Shot $early }",
      "    }",
      "  } catch {}",
      "}",
      "$t0 = [Environment]::TickCount",
      "$start = Get-Date",
      `while (((Get-Date) - $start).TotalMilliseconds -lt ${HELPER_WATCH_MS}) {`,
      // 0x8001: GetAsyncKeyState's "down now" bit OR'd with its "pressed since
      // the last call" bit, so a fast click is not missed between polls.
      "  if (((([OcShotKeys]::GetAsyncKeyState($RB) -band 0x8001) -ne 0) -or (([OcShotKeys]::GetAsyncKeyState($ESC) -band 0x8001) -ne 0))) {",
      // Kill exactly the selector we launched: the old StartTime filter compared
      // against the helper's own boot, which is always later, so it never matched.
      "    try {",
      "      $k = [int](Get-Content -LiteralPath $pidFile -Raw)",
      "      if ($k -gt 0) {",
      "        $p = Get-Process -Id $k -ErrorAction SilentlyContinue",
      "        if ($p -and @('SnippingTool', 'ScreenSketch') -contains $p.ProcessName) { Stop-Process -Id $k -Force }",
      "      }",
      "    } catch {}",
      "    exit 11",
      "  }",
      "  if (([OcShotKeys]::GetClipboardSequenceNumber()) -ne $base) {",
      "    $now = [OcShotKeys]::GetClipboardSequenceNumber()",
      // Clipboard history, password managers and IME toolbars hold the clipboard for a
      // moment right after it changes. A read that throws leaves $base alone, so the
      // next poll 60 ms later tries again; only a definite "this is not an image"
      // consumes the number, because nothing would ever be read from it.
      "    $noImage = $false",
      "    try {",
      "      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {",
      "        $img = [System.Windows.Forms.Clipboard]::GetImage()",
      "        if ($img) { Note ('saving seq=' + $now); Save-Shot $img }",
      "      } else { $noImage = $true }",
      "    } catch { Note ('read-error ' + $_.Exception.Message) }",
      "    if ($noImage) { $base = $now }",
      "  }",
      `  Start-Sleep -Milliseconds ${POLL_MS}`,
      "}",
      "exit 0",
    ].join("\r\n")
    let stale = true
    try {
      const current = node().fs.existsSync(helperPath)
        ? node().fs.readFileSync(helperPath, "utf8").replace(/^\uFEFF/, "")
        : null
      stale = current !== helperScript
    } catch {}
    // Windows PowerShell 5.1 decodes a BOM-less script with the ANSI code page,
    // which mangles any non-ASCII path in it.
    if (stale) node().fs.writeFileSync(helperPath, `\uFEFF${helperScript}`, "utf8")
    // Read the base before the selector exists: the selector must not wait for
    // it, because PowerShell cannot report it fast enough. The compiled helper
    // answers in milliseconds, so the crosshair appears at once.
    const base = await clipboardSequence()
    helper = child.spawn(
      POWERSHELL,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperPath,
        ...(base === null ? [] : [String(base)]),
      ],
      { windowsHide: true, stdio: "ignore" },
    )
    helper.on("error", (error) => {
      spawnError = spawnError ?? error
      whichSpawnFailed = whichSpawnFailed ?? "helper"
    })

    if (base === null) {
      // Fallback: the helper has to take the number itself, so hold the selector
      // until it says it has one, or a fast selection would be missed.
      const readyBy = Date.now() + HELPER_READY_TIMEOUT_MS
      const helperAlive = () => !!helper && helper.exitCode === null && helper.signalCode === null
      while (Date.now() < readyBy && helperAlive() && !spawnError && !node().fs.existsSync(readyPath)) {
        await sleep(POLL_MS)
      }
      if (!helperAlive() && !node().fs.existsSync(readyPath)) {
        // It died before it could record the clipboard: nothing will ever be read.
        logCapture("failed", 0, Date.now() - started, "helper exited before it was ready")
        return { base64: null, text: messages.helperFailed, kind: "failed" }
      }
      // The poll interval can end the loop a few milliseconds before the helper
      // writes the file; one last look avoids calling a healthy helper slow.
      if (!spawnError && !node().fs.existsSync(readyPath)) await sleep(READY_FINAL_CHECK_MS)
      if (!spawnError && !node().fs.existsSync(readyPath)) {
        // Fail open: a slow helper should not turn into a plugin that refuses to
        // capture, and this line is the only way to see that the run was at risk.
        logCapture("helper-slow", 0, Date.now() - started, "helper did not signal ready; launching the selector anyway")
      }
    }

    if (instanceClosed) {
      return { base64: null, text: messages.cancelled, kind: "cancelled" }
    }
    if (hide) {
      const list = windowsRef.all?.() ?? []
      // The fallback matters when the host reports no windows even though one is
      // focused; an empty array is not the same as no list at all.
      const targets = list.length ? list : window ? [window] : []
      // Registered before the loop, not after it: a window wrapper that throws on
      // isVisible() would otherwise leave every window hidden earlier in the loop
      // with nothing to bring them back.
      restoreHiddenWindow = () => {
        for (const entry of hiddenWindows) {
          // A window the user had hidden stays hidden.
          if (!entry.wasVisible) continue
          try {
            entry.window.show()
            logCapture("window", 0, 0, `show ok pid=${RUN_ID}`)
          } catch (error) {
            logCapture("window", 0, 0, `show failed pid=${RUN_ID}: ${String(error)}`)
            // The wrapper can go stale while the capture runs; a live one may work.
            try {
              const fallback = windowsRef.current?.()
              fallback?.show()
              logCapture("window", 0, 0, "show ok fallback")
            } catch {}
          }
        }
        // Leave the user on the window the capture started from, if it was on screen.
        const own = hiddenWindows.find((entry) => entry.window === window)
        if (own && own.wasVisible) {
          try {
            window?.focus?.()
          } catch {}
        }
      }
      for (const each of targets) {
        if (!each) continue
        // A minimised window cannot appear in the shot and needs no hiding.
        if (each.isMinimized?.()) continue
        hiddenWindows.push({ window: each, wasVisible: each.isVisible?.() ?? true })
        setWindowVisible(each, false, `pid=${RUN_ID}`)
      }
      if (instanceClosed) {
        // The instance was torn down while the clipboard was being read.
        restoreHiddenWindow()
        restoreHiddenWindow = null
        return { base64: null, text: messages.cancelled, kind: "cancelled" }
      }
      // The selector has to draw after the window is gone, or the app ends up in
      // the shot.
      await sleep(HIDE_DELAY_MS)
    }

    const win11 = isWin11()
    tool = child.spawn(
      win11 ? LAUNCHER_WIN11 : snipTool(),
      win11 ? [SNIP_PROTOCOL_WIN11] : [SNIP_ARG_WIN10],
      { windowsHide: win11, stdio: "ignore" },
    )
    tool.on("error", (error) => {
      spawnError = spawnError ?? error
      whichSpawnFailed = "tool"
    })
    const spawned = Date.now() - started
    // Without this line a capture that never produced an image leaves no trace of
    // the selector even having started.
    logCapture("spawned", 0, spawned, `selector process started, base=${base === null ? "gated" : base}`)
    // The helper reads this to tell "no selector any more" from "not started yet".
    try {
      node().fs.writeFileSync(toolPidPath, String(tool.pid ?? 0), "utf8")
    } catch {}

    // The user's budget starts when the selector appears, not when the click
    // landed: the helper boot and the clipboard read would otherwise come out of
    // the time they have to select.
    let seenOverlay = false
    let overlayGone = false
    let lastOverlayProbe = 0
    let missingSince = 0
    let missingProbes = 0
    let decodeFailures = 0
    const deadline = Date.now() + REGION_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (instanceClosed) {
        logCapture("cancelled", 0, Date.now() - started, "instance torn down")
        return { base64: null, text: messages.cancelled, kind: "cancelled" }
      }
      if (spawnError) {
        logCapture("failed", 0, Date.now() - started, String(spawnError))
        return {
          base64: null,
          text: whichSpawnFailed === "tool" ? messages.toolMissing : messages.helperFailed,
          kind: "failed",
        }
      }
      if (escaped) {
        stop(tool)
        logCapture("cancelled", 0, Date.now() - started, `${messages.cancelled} escape=${Date.now() - started}ms`)
        return { base64: null, text: messages.cancelled, kind: "cancelled" }
      }
      if (node().fs.existsSync(imagePath)) {
        const read = readCaptureBuffer(imagePath)
        if (!read || read === "too-large") {
          try {
            node().fs.unlinkSync(imagePath)
          } catch {}
          logCapture("failed", 0, Date.now() - started, `capture file unusable: ${read === "too-large" ? "too large" : "not a png"}`)
          return {
            base64: null,
            text: read === "too-large" ? messages.captureTooLarge : messages.captureUnreadable,
            kind: "failed",
          }
        }
        const buffer = read as Buffer
        const image = electron.nativeImage.createFromBuffer(buffer)
        if (!image.isEmpty()) {
          const base64 = encodeShot(image)
          if (!base64) {
            logCapture("failed", 0, Date.now() - started, "capture encoded to an empty image")
            return { base64: null, text: messages.emptyImage, kind: "failed" }
          }
          // The PNG is only a hand-off buffer; leaving it behind keeps a full
          // resolution copy of the last screenshot in the temp directory.
          try {
            node().fs.unlinkSync(imagePath)
          } catch {}
          logCapture("ok", base64.length, Date.now() - started, `${messages.regionOk} selector=${spawned}ms`)
          return { base64, text: messages.regionOk, kind: "ok" }
        }
        // The helper publishes through a rename, so a readable file is complete.
        // An undecodable one means the file is damaged: give up after a few tries
        // instead of reading it again on every poll.
        decodeFailures += 1
        if (decodeFailures >= 3) {
          try {
            node().fs.unlinkSync(imagePath)
          } catch {}
          logCapture("failed", 0, Date.now() - started, "capture png did not decode")
          return { base64: null, text: messages.emptyImage, kind: "failed" }
        }
        await sleep(POLL_MS)
        continue
      }
      const helperDone = helper.exitCode !== null || helper.signalCode !== null
      // On Win11 the launcher is `explorer.exe ms-screenclip:`, which exits as soon
      // as the overlay is handed off. Treating that as "selector closed" aborts the
      // capture while the overlay is still on screen, so only the Win10 snipper
      // counts as a liveness signal.
      // On Win11 the launcher is `explorer.exe ms-screenclip:`, which exits as
      // soon as the overlay is handed off, so the child process says nothing.
      // Watch the overlay itself: once it has been seen and is then gone, the
      // user closed it.
      const probeGap = seenOverlay ? OVERLAY_PROBE_MS : OVERLAY_FIRST_PROBE_MS
      if (win11 && !overlayGone && Date.now() - lastOverlayProbe > probeGap) {
        lastOverlayProbe = Date.now()
        const running = await snipperRunning()
        if (running === true) {
          seenOverlay = true
          missingSince = 0
          missingProbes = 0
        } else if (running === false) {
          if (seenOverlay) {
            overlayGone = true
          } else {
            // The protocol handler can fail silently, but only an authoritative
            // "no such process" counts: a probe that timed out or was blocked says
            // nothing, and the budget starts at the first answer rather than at
            // spawn, which would include the app's own cold start.
            missingProbes += 1
            if (!missingSince) missingSince = Date.now()
            if (missingProbes >= 2 && Date.now() - missingSince > OVERLAY_START_TIMEOUT_MS) {
              // The launcher has exited and no overlay process was ever seen. Most
              // often the user closed it again; a broken handler is the rarer case, and
              // "cancelled" is the safer of the two to report.
              logCapture("cancelled", 0, Date.now() - started, "selector never appeared")
              return { base64: null, text: messages.cancelled, kind: "cancelled" }
            }
          }
        }
        // null: could not look, leave the state alone
      }
      const toolDone = win11 ? overlayGone : tool.exitCode !== null || tool.signalCode !== null
      if (toolDone && !node().fs.existsSync(imagePath)) {
        // The selector copies before it exits, and the helper may still be writing;
        // a short grace keeps a finished selection from being read as a cancel.
        // The overlay process disappearing says nothing about the clipboard: a large
        // selection is still being encoded and written.
        const tries = win11 ? SELECTION_GRACE_WIN11_TRIES : SELECTION_GRACE_TRIES
        for (let wait = 0; wait < tries && !node().fs.existsSync(imagePath); wait += 1) {
          await sleep(SELECTION_GRACE_MS)
        }
      }
      if (node().fs.existsSync(imagePath)) continue
      if (helperDone || toolDone) {
        const helperCode = helper.exitCode
        // 0 = watch expired, 11 = cancel key, 12 = image written. Anything else -
        // including a signal kill by a virus scanner or the task manager - is the
        // helper failing, not the user cancelling.
        const killed = helper.signalCode !== null
        if (killed || (helperCode !== null && helperCode !== 0 && helperCode !== 11 && helperCode !== 12)) {
          const detail = killed ? String(helper.signalCode) : String(helperCode)
          logCapture("failed", 0, Date.now() - started, `${messages.helperFailed} helper=${detail}`)
          return { base64: null, text: `${messages.helperFailed} (${detail})`, kind: "failed" }
        }
        logCapture(
          "cancelled",
          0,
          Date.now() - started,
          `${messages.cancelled} helper=${helper.exitCode ?? helper.signalCode} tool=${tool.exitCode ?? tool.signalCode}`,
        )
        return { base64: null, text: messages.cancelled, kind: "cancelled" }
      }
      await sleep(POLL_MS)
    }
    logCapture("timeout", 0, Date.now() - started, messages.timedOut)
    return { base64: null, text: messages.timedOut, kind: "timeout" }
  } catch (error) {
    logCapture("failed", 0, Date.now() - started, String(error))
    return { base64: null, text: String(error), kind: "failed" }
  } finally {
    capturing = false
    stop(tool)
    stop(helper)
    // The delete after a successful encode can lose the race with the helper
    // closing its handle; by now that process is gone, so retry once.
    for (const path of [imagePath, `${imagePath}.part`, readyPath, toolPidPath]) {
      try {
        if (node().fs.existsSync(path)) node().fs.unlinkSync(path)
      } catch {}
    }
    if (escapeBound) {
      const scope = globalThis as { __ocShotEscOwner?: string }
      if (scope.__ocShotEscOwner === RUN_ID) {
        try {
          hotkeys.globalShortcut.unregister("Escape")
        } catch {}
        scope.__ocShotEscOwner = undefined
      }
    }
    // Restoring the window of a torn-down instance would cover the new instance's
    // selector; its cleanup restores it instead.
    const restore = restoreHiddenWindow
    restoreHiddenWindow = null
    if (hide && !instanceClosed) {
      try {
        restore?.()
      } catch {}
    }
  }
}

// Set by main(); lets capture() hide the windows without threading ctx everywhere.
const windowsRef: {
  current: (() => CaptureWindow) | null
  /** Every window, so a capture can hide the whole app and not just the focused one. */
  all: (() => CaptureWindow[]) | null
} = { current: null, all: null }


const EDITOR_PAGE_STEM = "screenshot-editor"
/** True while the in-page overlay editor is mounted. */
let overlayOpen = false
/** The open editor window, if any: a capture must not start on top of it. */
type EditorWindowRef = {
  isDestroyed: () => boolean
  focus?: () => void
  flashFrame?: (flag: boolean) => void
}
let editorWindowRef: EditorWindowRef | null =
  (globalThis as { __ocShotEditorWindow?: EditorWindowRef }).__ocShotEditorWindow ?? null

type EditorPayload = { dataUrl: string; labels: Record<string, string> }
type EditorReply = { kind: "done" | "cancelled" | "fallback"; dataUrl?: string }
type EditorHandlers = {
  /** `owner` is the editor window, so its dialog sits on the right window. */
  save: (dataUrl: string, owner?: unknown) => Promise<string>
  copy: (dataUrl: string) => Promise<boolean>
}

/** Writes the page and its preload; the preload carries the per-run Ipc channels. */
function writeEditorAssets(
  saveChannel: string,
  copyChannel: string,
  title: string,
): { page: string; preload: string } {
  // Per run, like every other file this process owns: two windows must not share a
  // page whose preload carries another run's channel names. Leftovers from a killed
  // run are removed on the next start.
  try {
    const { fs } = node()
    // Only files from an older run: another instance may be loading its own page
    // right now.
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const name of fs.readdirSync(runtimeDir())) {
      if (!name.startsWith(EDITOR_PAGE_STEM) || !(name.endsWith(".html") || name.endsWith(".js"))) continue
      const path = runtimePath(name)
      try {
        if (fs.statSync(path).mtimeMs < cutoff) fs.unlinkSync(path)
      } catch {}
    }
  } catch {}
  const tag = `${RUN_ID}-${Date.now()}`
  const page = runtimePath(`${EDITOR_PAGE_STEM}-${tag}.html`)
  const preload = runtimePath(`${EDITOR_PAGE_STEM}-${tag}-preload.js`)
  // The bundle is inlined: a file:// page cannot import a sibling module, and the
  // editor has to keep contextIsolation on.
  const script = String(editorScript).replace(/<\/script/gi, "<\\/script")
  const html = [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><title>${title.replace(/[<&>]/g, "")}</title>`,
    "<style>html,body{margin:0;height:100%;background:#1e1e1e;overflow:hidden}</style></head>",
    `<body><script>${script}</script></body></html>`,
  ].join("\n")
  node().fs.writeFileSync(page, html, "utf8")
  node().fs.writeFileSync(
    preload,
    [
      'const { contextBridge, ipcRenderer } = require("electron")',
      "contextBridge.exposeInMainWorld('shotBridge', {",
      `  save: (dataUrl) => ipcRenderer.invoke(${JSON.stringify(saveChannel)}, dataUrl),`,
      `  copy: (dataUrl) => ipcRenderer.invoke(${JSON.stringify(copyChannel)}, dataUrl),`,
      "})",
    ].join("\n"),
    "utf8",
  )
  return { page, preload }
}

/**
 * Runs the annotation editor in its own modal window.
 *
 * A child window keeps the app window out of it: closing the editor cannot quit
 * the app, and the chat stays where it was. When the host refuses to create a
 * window the caller falls back to the in-page overlay.
 */
async function runEditorWindow(
  payload: EditorPayload,
  handlers: EditorHandlers,
  callerWindow?: LiveWindow,
): Promise<EditorReply> {
  let electron: {
    BrowserWindow?: new (options: Record<string, unknown>) => ElectronEditorWindow
    ipcMain?: {
      handle: (channel: string, fn: (event: { sender?: unknown }, value: string) => unknown) => void
      removeHandler: (channel: string) => void
    }
    screen?: {
      getPrimaryDisplay: () => {
        workAreaSize: { width: number; height: number }
        workArea?: { x: number; y: number; width: number; height: number }
      }
      getDisplayMatching?: (bounds: {
        x: number
        y: number
        width: number
        height: number
      }) => {
        workAreaSize: { width: number; height: number }
        workArea?: { x: number; y: number; width: number; height: number }
      }
    }
  }
  try {
    electron = require("electron") as typeof electron
  } catch {
    return { kind: "fallback" }
  }
  const WindowCtor = electron.BrowserWindow
  const ipc = electron.ipcMain
  if (!WindowCtor || !ipc) return { kind: "fallback" }

  const stamp = (require("node:crypto") as typeof import("node:crypto")).randomUUID()
  const saveChannel = `screenshot-editor-save-${stamp}`
  const copyChannel = `screenshot-editor-copy-${stamp}`
  let assets: { page: string; preload: string }
  try {
    assets = writeEditorAssets(saveChannel, copyChannel, MSG[shotLang()].editorTitle)
  } catch (error) {
    logCapture("editor", 0, 0, `assets failed: ${String(error)}`)
    return { kind: "fallback" }
  }

  // Only this window may use these channels; another renderer in the app must not
  // be able to drive a save dialog or the clipboard through them.
  const fromEditor = (event: { sender?: unknown }) => event?.sender === window.webContents
  ipc.handle(saveChannel, (event, value) => (fromEditor(event) ? handlers.save(String(value), window) : "failed"))
  ipc.handle(copyChannel, (event, value) => (fromEditor(event) ? handlers.copy(String(value)) : false))

  const alive = (candidate?: LiveWindow | null): candidate is LiveWindow =>
    !!candidate && !(candidate.isDestroyed?.() ?? false)
  const parent = alive(callerWindow)
    ? callerWindow
    : alive(lastCaptureWindow)
      ? lastCaptureWindow
      : windowsRef.current?.() ?? null
  // Follow the window the editor belongs to: on a two-screen desk the primary
  // display is often not where the app is.
  let bounds: { x: number; y: number; width: number; height: number } | undefined
  try {
    bounds = parent?.getBounds?.()
  } catch {
    // A window can close between being resolved and being measured.
  }
  const display =
    (bounds ? electron.screen?.getDisplayMatching?.(bounds) : undefined) ??
    electron.screen?.getPrimaryDisplay?.()
  const work = display?.workAreaSize ?? electron.screen?.getPrimaryDisplay?.().workAreaSize ?? { width: 1280, height: 800 }
  const workArea = display?.workArea
  // The lower bounds exist to keep the editor usable, but a work area smaller than
  // them wins: otherwise the footer sits behind the taskbar.
  const width = Math.max(Math.min(760, work.width), Math.min(Math.round(work.width * 0.92), 1600))
  const height = Math.max(Math.min(520, work.height), Math.min(Math.round(work.height * 0.92), 1000))

  let window: ElectronEditorWindow
  try {
    window = new WindowCtor({
      width,
      height,
      // Without a position the OS decides, and on a two-screen desk that is often the
      // primary display while the app, and the screenshot, are on the other one.
      ...(workArea
        ? {
            x: Math.round(workArea.x + (workArea.width - width) / 2),
            y: Math.round(workArea.y + (workArea.height - height) / 2),
          }
        : {}),
      // Never below a size that can still show the toolbar and a pixel of canvas.
      minWidth: Math.max(360, Math.min(720, work.width)),
      minHeight: Math.max(300, Math.min(480, work.height)),
      backgroundColor: "#1e1e1e",
      autoHideMenuBar: true,
      show: false,
      title: MSG[shotLang()].editorTitle,
      parent: parent ?? undefined,
      modal: !!parent,
      webPreferences: {
        preload: assets.preload,
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed preloads did not reach did-finish-load on the test machine, so
        // the window keeps contextIsolation without the sandbox.
        sandbox: false,
      },
    })
    // The app installs a native menu for every window; Alt would drop it down here
    // and its Reload item would tear the page down mid-edit.
    try {
      window.setMenu?.(null)
    } catch {}
  } catch (error) {
    logCapture("editor", 0, 0, `window failed: ${String(error)}`)
    ipc.removeHandler(saveChannel)
    ipc.removeHandler(copyChannel)
    for (const path of [assets.page, assets.preload]) {
      try {
        node().fs.unlinkSync(path)
      } catch {}
    }
    return { kind: "fallback" }
  }

  editorWindowRef = window
  ;(globalThis as { __ocShotEditorWindow?: unknown }).__ocShotEditorWindow = window
  let reply: EditorReply = { kind: "cancelled" }
  try {
    reply = await new Promise<EditorReply>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (value: EditorReply) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      // A page that never loads would leave an invisible window and a stuck capture;
      // the overlay is the fallback that still lets the user finish.
      timer = setTimeout(() => {
        logCapture("editor", 0, 0, "window did not load in time")
        finish({ kind: "fallback" })
      }, EDITOR_LOAD_TIMEOUT_MS)
      window.on("closed", () => finish({ kind: "cancelled" }))
      // The title bar's close button bypassed the editor's own confirmation, so the
      // most common way to abandon a shot threw the annotations away without asking.
      let allowClose = false
      let closeTimeouts = 0
      window.on("close", (event) => {
        // Quitting the app must not be held up by the editor's question.
        if (allowClose || appQuitting) return
        event?.preventDefault?.()
        let answered = false
        const settle = (ok: boolean) => {
          if (answered) return
          answered = true
          if (!ok) return
          allowClose = true
          try {
            window.destroy()
          } catch {}
        }
        // The page answers after its own confirmation, so this only needs to catch a
        // renderer that stopped responding; a hung one is destroyed by the
        // unresponsive handler, and destroying on a slow answer would lose the work.
        const guard = setTimeout(() => {
          closeTimeouts += 1
          logCapture("editor", 0, 0, `close confirmation timed out (${closeTimeouts})`)
          if (closeTimeouts >= 2) {
            // The page is not answering; let the user out rather than trap the window.
            settle(true)
            return
          }
          try {
            window.show()
            window.focus()
          } catch {}
          settle(false)
        }, CLOSE_CONFIRM_TIMEOUT_MS)
        void window.webContents
          .executeJavaScript("typeof window.__shotCanClose === 'function' ? window.__shotCanClose() : true")
          .then((ok) => {
            clearTimeout(guard)
            closeTimeouts = 0
            settle(ok !== false)
          })
          .catch(() => {
            clearTimeout(guard)
            settle(true)
          })
      })
      // A crashed or hung renderer never settles the page promise; without this the
      // editor slot stays taken and every later capture reports "busy".
      for (const event of ["render-process-gone", "unresponsive"]) {
        try {
          window.webContents.on(event, () => {
            logCapture("editor", 0, 0, `${event}: giving up on the window`)
            finish({ kind: "fallback" })
          })
        } catch {}
      }
      window.webContents.once("did-finish-load", () => {
        // The page is up: the load deadline no longer applies, and the user is free
        // to spend minutes in the editor.
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        logCapture("editor", 0, 0, "page loaded")
        const code = `window.__shotRun(JSON.parse(${JSON.stringify(JSON.stringify(payload))}))`
        Promise.resolve()
          .then(() => window.webContents.executeJavaScript(code))
          .then((result: unknown) => finish(result ? { kind: "done", dataUrl: String(result) } : { kind: "cancelled" }))
          .catch((error: unknown) => {
            // The page never became usable; the overlay still gets the user an editor.
            logCapture("editor", 0, 0, `run failed: ${String(error)}`)
            finish({ kind: "fallback" })
          })
      })
      // ready-to-show may never fire for a window that stays hidden; make sure the
      // user can see (and therefore close) the editor either way.
      window.webContents.once("did-finish-load", () => {
        try {
          if (!window.isVisible()) {
            // Same reason as ready-to-show: a minimised owner hides its modal child.
            if (parent?.isMinimized?.()) parent.restore?.()
            window.show()
            window.focus()
          }
        } catch {}
      })
      window.once("ready-to-show", () => {
        try {
          // A minimised owner hides its modal child, and the user would have no
          // window to close.
          if (parent?.isMinimized?.()) parent.restore?.()
          window.show()
          window.focus()
        } catch {}
      })
      window.loadFile(assets.page).catch((error: unknown) => {
        logCapture("editor", 0, 0, `load failed: ${String(error)}`)
        finish({ kind: "fallback" })
      })
    })
  } finally {
    if (editorWindowRef === window) {
      editorWindowRef = null
      ;(globalThis as { __ocShotEditorWindow?: unknown }).__ocShotEditorWindow = null
    }
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch {}
    ipc.removeHandler(saveChannel)
    ipc.removeHandler(copyChannel)
    for (const path of [assets.page, assets.preload]) {
      try {
        node().fs.unlinkSync(path)
      } catch {}
    }
  }
  logCapture("editor", 0, 0, `closed kind=${reply.kind}`)
  return reply
}

type ElectronEditorWindow = {
  on: (event: string, handler: (event?: { preventDefault?: () => void }) => void) => void
  once: (event: string, handler: () => void) => void
  show: () => void
  focus: () => void
  destroy: () => void
  isDestroyed: () => boolean
  setMenu?: (menu: null) => void
  loadFile: (path: string) => Promise<void>
  isVisible: () => boolean
  webContents: {
    once: (event: string, handler: () => void) => void
    on: (event: string, handler: () => void) => void
    executeJavaScript: (code: string) => Promise<unknown>
  }
}

// Window half: the composer camera button and the annotation editor.
// The main half below supplies capture, settings and the clipboard writer.
export default Plugin.define({
  setup(ctx) {
    // A renderer reload takes the in-page overlay with it, so main's overlay and
    // close-guard latches must be cleared here: the `finally` that normally clears
    // them belongs to the page that just went away.
    void ctx.main(Shot).setEditorOpen(false).catch(() => false)
    // Camera button and caret menu in the composer.
    const stopComposer = mountComposerShot({
      region: () => ctx.main(Shot).region().then((raw) => JSON.parse(raw) as CaptureResult),
      readSettings: () => ctx.main(Shot).readSettings().then((raw) => JSON.parse(raw) as ShotSettings),
      writeSettings: (patch) =>
        ctx.main(Shot).writeSettings(JSON.stringify(patch)).then((raw) => JSON.parse(raw) as ShotSettings),
      setHotkey: (accelerator) => ctx.main(Shot).setHotkey(accelerator),
      copyImage: (dataUrl) => ctx.main(Shot).copyImage(dataUrl),
      // The editor runs in its own modal window, created by the main process. If the
      // host refuses to create one, the in-page overlay takes over so the feature
      // still works.
      openEditor: async (dataUrl, labels) => {
        // The overlay guard is process-wide; a second overlay would be refused by
        // the editor itself, after this call had already armed and disarmed it.
        if (document.querySelector('[data-screenshot-editor="1"]')) return null
        let reply: { kind: string; dataUrl?: string } | null = null
        try {
          reply = JSON.parse(
            await ctx.main(Shot).openEditor(JSON.stringify({ dataUrl, labels })),
          ) as { kind: string; dataUrl?: string }
        } catch (error) {
          // A reloaded window can reach a main process that still runs an older
          // build without this method. The overlay works against both, so fall
          // through to it instead of failing the capture. Nothing is logged here:
          // this half has no node, and logCapture would silently do nothing.
          void error
        }
        if (reply?.kind === "done") return reply.dataUrl ?? null
        if (reply && reply.kind !== "fallback") return null
        await ctx.main(Shot).setEditorOpen(true)
        try {
          const blob = await (await fetch(dataUrl)).blob()
          const file = new File([blob], "screenshot.jpg", { type: "image/jpeg" })
          const edited = await openShotEditor(file, {
            t: (key) => labels[key] ?? key,
            save: (value) => ctx.main(Shot).saveImage(value),
            copy: (value) => ctx.main(Shot).copyImage(value),
          })
          if (!edited) return null
          const bytes = new Uint8Array(await edited.arrayBuffer())
          let binary = ""
          for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
          return `data:image/jpeg;base64,${btoa(binary)}`
        } finally {
          void ctx.main(Shot).setEditorOpen(false).catch(() => false)
        }
      },
    })

    // Main pushes capture results and settings changes over the host's typed event
    // channel: an executeJavaScript push is lost silently when the page is loading or
    // the renderer is busy.
    const offHotkey = ctx.main(Shot).on("hotkey", (detail) => {
      window.dispatchEvent(new CustomEvent("screenshot:hotkey", { detail }))
    })
    const offSettings = ctx.main(Shot).on("settings", () => {
      window.dispatchEvent(new CustomEvent("screenshot:settings"))
    })

    return () => {
      offHotkey()
      offSettings()
      stopComposer()
    }
  },

  main(ctx) {
    windowsRef.current = () => {
      // focused() is already "the window that had focus last"; list order is the only
      // fallback when no window has ever had focus.
      const window = ctx.windows.focused() ?? ctx.windows.list()[0]
      return window ?? null
    }
    windowsRef.all = () => ctx.windows.list() as unknown as CaptureWindow[]
    // Set once the contract is provided; a hotkey bound before that has nothing to
    // push to.
    let shotIpc: { emit: (name: "hotkey" | "settings", data: string, window?: number) => void } | null = null
    // Only the overlay fallback lives inside the app window, where its close button
    // sits right above the editor. While that overlay is up, the close is refused.
    let editorOpen = false
    let quitting = false
    const electronApp = require("electron") as {
      app?: {
        on?: (event: string, handler: () => void) => void
        removeListener?: (event: string, handler: () => void) => void
      }
      BrowserWindow?: new (options: Record<string, unknown>) => { on: (event: string, fn: unknown) => void }
    }
    const onBeforeQuit = () => {
      // Only the quit in progress may bypass the guard: if the host cancels it,
      // the next window close must still be refused.
      quitting = true
      appQuitting = true
      setTimeout(() => {
        quitting = false
        // The host may cancel the quit; the guards must protect again afterwards. The
        // windows close on their own schedule, so this cannot be a 0 ms timer.
        appQuitting = false
      }, 1000)
    }
    try {
      electronApp.app?.on?.("before-quit", onBeforeQuit)
    } catch {}
    const windowListeners: Array<{
      target: { removeListener?: (event: string, handler: unknown) => void }
      event: string
      handler: unknown
    }> = []
    const guardWindow = (window: unknown) => {
      const target = window as {
        on?: (event: string, handler: (event: { preventDefault: () => void }) => void) => void
        removeListener?: (event: string, handler: unknown) => void
      }
      const onClose = (event: { preventDefault: () => void }) => {
        if (!editorOpen || quitting) return
        event.preventDefault()
        logCapture("window", 0, 0, "close refused: editor open")
      }
      target.on?.("close", onClose)
      if (target.removeListener) windowListeners.push({ target, event: "close", handler: onClose })
    }
    for (const window of ctx.windows.list()) guardWindow(window)
    ctx.windows.on("open", (window) => guardWindow(window))
    ctx.windows.on("close", (window) => {
      const index = windowListeners.findIndex((entry) => (entry.target as unknown) === (window as unknown))
      if (index >= 0) {
        try {
          windowListeners[index].target.removeListener?.(windowListeners[index].event, windowListeners[index].handler)
        } catch {}
        windowListeners.splice(index, 1)
      }
    })
    // The shortcut is process-wide. Without this, a reload leaves the old module's
    // callback bound and the new code never runs.
    /**
     * Binds the capture shortcut, with the real handler.
     *
     * The only place a shortcut is registered: the start-up restore and the window
     * half's setHotkey() both come through here. Registering a placeholder at start
     * up instead left the key bound to nothing, because the later call saw the same
     * accelerator already recorded and returned without replacing the callback.
     */
    function bindHotkey(accelerator: string): boolean {
      const electron = require("electron") as ElectronHotkeyApi
      if (!accelerator) return clearHotkey()
      if (accelerator === registeredHotkey) return true
      let ok = false
      try {
          ok = electron.globalShortcut.register(accelerator, () => {
            // A plugin window has no ipcRenderer, so the capture is pushed in as a
            // DOM event instead of an IPC message.
            void (async () => {
              // Resolve the window now, not after the capture: by then the focus may
              // have moved to another conversation and the shot would land there.
              const target = ctx.windows.focused() ?? ctx.windows.list()[0]
              // A second capture on top of an open editor only produces a hidden
              // window and a dropped result. The editor lives in its own window now,
              // so ask main, and keep the DOM probe for the overlay fallback.
              if (editorWindowRef && !editorWindowRef.isDestroyed()) {
                // The editor is a modal child, so a toast on the parent would be drawn
                // behind it and the key would look broken. Point at the editor instead.
                try {
                  editorWindowRef.focus?.()
                  editorWindowRef.flashFrame?.(true)
                } catch {}
                return
              }
              if (target) {
                try {
                  const busy = await (target as unknown as ElectronPushWindow).webContents.executeJavaScript(
                    "!!document.querySelector('[data-screenshot-editor]')",
                  )
                  if (busy) return
                } catch {}
              }
              try {
                const result = await captureRegion(target as unknown as CaptureWindow)
                // Push failures too: without this the hotkey path reports nothing at
                // all and the user cannot tell a cancel from a broken capture.
                // Only the window the capture came from: broadcasting put the same
                // capture into every open conversation.
                if (target) {
                  const id = (target as { id?: number }).id
                  const payload = JSON.stringify({ base64: result.base64, kind: result.kind, text: result.text })
                  if (typeof id === "number") {
                    try {
                      if (!shotIpc) logCapture("hotkey", 0, 0, "no provider: result dropped")
                      else shotIpc.emit("hotkey", payload, id)
                    } catch (error) {
                      logCapture("hotkey", 0, 0, `emit failed: ${String(error)}`)
                    }
                  } else {
                    // Without an id the host would broadcast the capture to every window.
                    logCapture("hotkey", 0, 0, "target has no window id: result dropped")
                  }
                } else {
                  logCapture("hotkey", 0, 0, "no window to push the result to")
                }
              } catch {}
            })()
          })
      } catch (error) {
        // register() throws on a malformed accelerator instead of returning false.
        logCapture("hotkey", 0, 0, String(error))
        ok = false
      }
      // Only drop the previous binding once the new one is in place: a failed
      // register must not leave the user with no shortcut at all.
      if (ok) {
        const previous = registeredHotkey
        registeredHotkey = accelerator
        // The registration is process-wide: remember which instance owns it, so a
        // reload's cleanup cannot unbind the shortcut the new instance just took.
        ;(globalThis as { __ocShotHotkeyOwner?: string }).__ocShotHotkeyOwner = RUN_ID
        if (previous && previous !== accelerator) electron.globalShortcut.unregister(previous)
      }
      return ok
    }

    function clearHotkey(): boolean {
      const electron = require("electron") as ElectronHotkeyApi
      const scope = globalThis as { __ocShotHotkeyOwner?: string }
      try {
        // unregisterAll() would also drop the host's own shortcuts and other
        // plugins'. Only the accelerator this plugin bound is ours to remove.
        if (registeredHotkey) electron.globalShortcut.unregister(registeredHotkey)
        // Only drop the owner flag when this instance owns it: after a reload that
        // lost the race for the key, the flag names the instance that still holds
        // it, and clearing it here would make that instance's cleanup skip the
        // unregister, leaving the key bound with no settings entry.
        if (scope.__ocShotHotkeyOwner === RUN_ID) scope.__ocShotHotkeyOwner = undefined
        registeredHotkey = ""
        return true
      } catch (error) {
        logCapture("hotkey", 0, 0, String(error))
        return false
      }
    }

    ctx.onCleanup(() => {
      // A newer instance may already own the shortcut; unbinding it here would
      // leave the key registered with no callback.
      const ownsHotkey = (globalThis as { __ocShotHotkeyOwner?: string }).__ocShotHotkeyOwner === RUN_ID
      if (ownsHotkey) {
        try {
          if (registeredHotkey) (require("electron") as ElectronHotkeyApi).globalShortcut.unregister(registeredHotkey)
        } catch {}
        ;(globalThis as { __ocShotHotkeyOwner?: string }).__ocShotHotkeyOwner = undefined
      }
      registeredHotkey = ""
      instanceClosed = true
      capturing = false
      // A reload while the overlay is open would otherwise leave the app unclosable.
      editorOpen = false
      overlayOpen = false
      // A capture that was running when this instance went away hid the window and
      // will not restore it; leaving it hidden strands the app with no window.
      const restore = restoreHiddenWindow
      restoreHiddenWindow = null
      try {
        restore?.()
      } catch {}
      stopClipReader()
      // A reload would otherwise add one more handler per instance.
      try {
        electronApp.app?.removeListener?.("before-quit", onBeforeQuit)
      } catch {}
      for (const entry of windowListeners) {
        try {
          entry.target.removeListener?.(entry.event, entry.handler)
        } catch {}
      }
      windowListeners.length = 0
    })
    // Do not outlive the app: the reader is a child process, and Windows does not
    // necessarily take it down with the parent.
    const scope = globalThis as { __ocShotExitHook?: boolean; __ocShotStopClip?: () => void }
    scope.__ocShotStopClip = stopClipReader
    if (!scope.__ocShotExitHook) {
      scope.__ocShotExitHook = true
      const host = (globalThis as { process?: { once?: (event: string, fn: () => void) => void } }).process
      host?.once?.("exit", () => (globalThis as { __ocShotStopClip?: () => void }).__ocShotStopClip?.())
    }
    // Compile the clipboard reader now, so the first capture does not pay for it.
    // A reload of the main process loses the binding the window half installed, so
    // it is restored here through the same binder. Registering a placeholder
    // callback instead left the key bound to nothing: the window half's later
    // setHotkey() saw the same accelerator already recorded and returned early.
    try {
      const saved = normHotkey(readShotSettings().hotkey)
      if (saved && !bindHotkey(saved)) {
        // A reload can bring this instance up before the previous one releases the
        // accelerator; registering over a binding this process still holds fails,
        // and the outgoing instance is about to free it.
        setTimeout(() => {
          if (!instanceClosed) bindHotkey(saved)
        }, REBIND_RETRY_MS)
      }
    } catch {}
    void ensureClipExe()
      .then((ok) => {
        // Start the reader now so the first capture does not pay for the process.
        // Skipped after teardown: a reader spawned here would be owned by the dead
        // module instance and outlive the plugin until the app exits.
        if (ok && !instanceClosed) startClipReader()
      })
      .catch(() => {})
  // Both bodies are used by the Ipc methods and by the editor window's bridge.
  const writeClipboard = async (dataUrl: string): Promise<boolean> => {
      const base64 = String(dataUrl).split(",")[1] ?? ""
      if (!base64) return false
      // Same hard stop as capture: the clipboard writer needs
      // System.Windows.Forms, so spawn would only produce an unreadable error.
      if (!isWindows()) {
        logCopyFailure("unsupported platform")
        return false
      }
      // The host's electron clipboard accepts write() but the image never reaches
      // the system clipboard, so the copy goes through PowerShell — the same
      // route the capture kernel uses to read it back.
      const file = tempPath(`${TEMP_FILES.copyStem}-${Date.now()}.png`)
      try {
        node().fs.writeFileSync(file, Buffer.from(base64, "base64"))
        const child = require("node:child_process") as typeof import("node:child_process")
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms",
          "Add-Type -AssemblyName System.Drawing",
          // Single quotes are the one character a PowerShell string literal cares
          // about; a user name like O'Brien would otherwise break the script.
          `$img = [System.Drawing.Image]::FromFile('${file.replace(/'/g, "''")}')`,
          "[System.Windows.Forms.Clipboard]::SetImage($img)",
          "$img.Dispose()",
        ].join("; ")
        // spawn, not spawnSync: the synchronous call parks the whole main process
        // for one PowerShell cold start, up to COPY_TIMEOUT_MS.
        return await new Promise<boolean>((resolve) => {
          const proc = child.spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
            windowsHide: true,
            stdio: "ignore",
          })
          let settled = false
          const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearTimeout(hard)
            resolve(ok)
          }
          const timer = setTimeout(() => {
            try {
              proc.kill()
            } catch {}
            // Resolve on close, not here: the caller deletes the PNG and a live
            // handle makes that fail on Windows.
          }, COPY_TIMEOUT_MS)
          const hard = setTimeout(() => finish(false), COPY_TIMEOUT_MS + COPY_KILL_GRACE_MS + 1000)
          proc.on("error", (error) => {
            logCopyFailure(error)
            finish(false)
          })
          proc.on("close", (code) => {
            // A non-zero exit is the only trace of a clipboard held by another
            // app; without this line the user just sees "copy failed".
            if (code !== 0) logCopyFailure(`powershell exit ${code}`)
            finish((code ?? 1) === 0)
          })
        })
      } catch (error) {
        logCopyFailure(error)
        return false
      } finally {
        // The PNG exists only so PowerShell can hand it to the clipboard; leaving
        // it behind piles up one multi-megabyte file per copy.
        try {
          node().fs.unlinkSync(file)
        } catch {}
      }
    }
  const savePng = async (dataUrl: string, owner?: unknown): Promise<string> => {
      const electron = require("electron") as ElectronDialogApi
      const base64 = String(dataUrl).split(",")[1] ?? ""
      // Validate before the dialog: asking for a path and only then failing is
      // worse than failing outright.
      if (!base64) return "failed"
      const now = new Date()
      const pad = (value: number) => String(value).padStart(2, "0")
      // Local time, not UTC: a user reading the filename should see the clock
      // on their own taskbar.
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      const options: SaveDialogOptions = {
        title: MSG[shotLang()].saveTitle,
        defaultPath: `screenshot-${stamp}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      }
      // Pass the window when there is one so the dialog is modal to it; fall back
      // to the ownerless form if the host's window is not a real BrowserWindow.
      const target = (owner as unknown) ?? windowsRef.current?.() ?? null
      let result: { canceled: boolean; filePath?: string }
      try {
        result = target
          ? await electron.dialog.showSaveDialog(target as unknown, options)
          : await electron.dialog.showSaveDialog(options)
      } catch {
        result = await electron.dialog.showSaveDialog(options)
      }
      if (result.canceled || !result.filePath) return "cancelled"
      try {
        node().fs.writeFileSync(result.filePath, Buffer.from(base64, "base64"))
        return "saved"
      } catch (error) {
        logCopyFailure(error)
        return "failed"
      }
    }
  const runEditor = async (payload: string, caller?: { window?: number }) => {
    // One editor per process: the hotkey is not the only way in, and a second
    // window would stack two overlays on the same capture flow.
    if (editorWindowRef && !editorWindowRef.isDestroyed()) return JSON.stringify({ kind: "cancelled" })
    // The capture that produced this image may have finished just as another one
    // started; a modal editor over a live selector hides the app and eats the shot.
    if (capturing) {
      logCapture("editor", 0, 0, "refused: a capture is running")
      return JSON.stringify({ kind: "cancelled" })
    }
    let parsed: EditorPayload
    try {
      parsed = JSON.parse(payload) as EditorPayload
    } catch {
      logCapture("editor", 0, 0, "payload is not JSON")
      return JSON.stringify({ kind: "cancelled" })
    }
    // A malformed payload is a bug in this plugin, not an old main process: say
    // cancelled instead of silently swapping in the overlay.
    if (typeof parsed?.dataUrl !== "string" || !parsed.dataUrl || !parsed.labels) {
      logCapture("editor", 0, 0, "payload is missing dataUrl or labels")
      return JSON.stringify({ kind: "cancelled" })
    }
    // The page turns this into a fetch(): only images, only from a data URL, and
    // only up to a size that cannot exhaust memory.
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(parsed.dataUrl)) {
      logCapture("editor", 0, 0, "payload is not an image data URL")
      return JSON.stringify({ kind: "cancelled" })
    }
    if (parsed.dataUrl.length > MAX_EDITOR_PAYLOAD) {
      logCapture("editor", 0, 0, `payload too large: ${parsed.dataUrl.length}`)
      return JSON.stringify({ kind: "cancelled" })
    }
    return JSON.stringify(
      await runEditorWindow(
        parsed,
        {
          save: (dataUrl, owner) => savePng(dataUrl, owner as unknown),
          copy: (dataUrl) => writeClipboard(dataUrl),
        },
        // The calling window owns the editor: the host passes its id, and that is the
        // window the dialog and the modal belong to.
        typeof caller?.window === "number" ? (ctx.windows.get(caller.window) as unknown as LiveWindow | undefined) : undefined,
      ),
    )
  }

    shotIpc = ctx.provide(Shot, {
      region: async () => JSON.stringify(await captureRegion()),
      setHotkey: (accelerator: string) => {
        // The window half normalises too, but the settings file can hold anything
        // and a global shortcut is taken from the whole system: gate it here as
        // well, or a hand-edited file could bind Ctrl+C.
        return bindHotkey(normHotkey(accelerator))
      },
      copyImage: writeClipboard,
      saveImage: (dataUrl: string, caller?: { window?: number }) =>
        // The host passes the calling window's id; a window is a more useful parent for
        // the save dialog than the caller object itself.
        savePng(dataUrl, typeof caller?.window === "number" ? ctx.windows.get(caller.window) : undefined),
      openEditor: runEditor,
      setEditorOpen: (open: boolean) => {
        editorOpen = open
        overlayOpen = open
        return true
      },
      readSettings: () => JSON.stringify(readShotSettings()),
      writeSettings: (patch: string) => {
        const next = writeShotSettings(JSON.parse(patch) as Partial<ReturnType<typeof readShotSettings>>)
        // Each window keeps its own copy for the menu and the send mode.
        try {
          shotIpc?.emit("settings", "")
        } catch {}
        return JSON.stringify(next)
      },
    })
  },
})
