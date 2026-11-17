// The camera button, the caret menu with its four settings, and delivery through
// synthetic drop/paste events.
//
// This file runs as a GUI plugin inside the desktop renderer. Capture and the
// settings file live in the main process, so every call here crosses the typed
// Ipc contract in contract.ts. Labels come from the table below.
//
// The 2.2.x composer is a contenteditable div rather than the `prompt-input`
// element older builds exposed, so delivery resolves the editor through a
// selector chain instead of one selector.

import { DEFAULTS, type ShotSettings } from "./screenshot/settings"

export type ShotLanguage = "en" | "zh"
export type CaptureKind = "ok" | "cancelled" | "timeout" | "busy" | "failed"

export type CaptureResult = { base64: string | null; text: string; kind: CaptureKind }

export type ComposerApi = {
  region: () => Promise<CaptureResult>
  readSettings: () => Promise<ShotSettings>
  writeSettings: (patch: Partial<ShotSettings>) => Promise<ShotSettings>
  setHotkey: (accelerator: string) => Promise<boolean>
  /** Opens the editor with a data URL and returns the edited data URL, or null. */
  openEditor: (dataUrl: string, labels: Record<string, string>) => Promise<string | null>
  /** Used as the last resort when the input box refuses a capture. */
  copyImage: (dataUrl: string) => Promise<boolean>
}

const TEXT: Record<ShotLanguage, Record<string, string>> = {
  en: {
    shot: "Screenshot",
    shotSettings: "Screenshot settings",
    hideWindow: "Hide window while capturing",
    afterCapture: "After capture",
    modeDirect: "Send to input directly",
    modeEdit: "Edit before sending",
    hotkeyRow: "Hotkey",
    notSet: "Not set",
    pressKeys: "Press keys…",
    bind: "Bind",
    clear: "Clear",
    languageRow: "Language",
    toastInInput: "Screenshot placed in the input box, review before sending",
    toastCancelled: "Screenshot cancelled",
    toastFailed: "Screenshot failed",
    toastFailedDetail: "Screenshot failed: {0}",
    toastEmpty: "Screenshot failed: empty image",
    toastFileErr: "Screenshot failed: cannot build image",
    toastDeliverFail: "Could not place into input, try again",
    toastCopiedInstead: "The input box did not take the image, so it was copied to the clipboard instead",
    toastRecording: "Press the key combo now (Esc exits, Backspace clears)",
    toastBound: "Hotkey set to {0}",
    toastCleared: "Hotkey cleared",
    toastUnbindFail: "The shortcut could not be released; restart the app and try again",
    toastBusy: "Hotkey is already in use, try another one",
    toastHotkeyUnusable: "The saved hotkey could not be bound; pick another one",
    toastNeedMod: "Single letters need Ctrl/Alt/Shift",
    toastKeyBad: "This key cannot be used as a hotkey",
    toastNoWin: "Win-key combos are not supported",
    toastSaveFail: "Settings were not saved; the previous values are back",
    toastBusyShot: "A screenshot is already in progress…",
    toastTimeout: "Capture timed out with no image. If the overlay is still open, close it and retry.",
    edRect: "Rectangle",
    edEllipse: "Ellipse",
    edLine: "Line",
    edArrow: "Arrow",
    edBrush: "Brush",
    edMosaic: "Mosaic",
    edBlur: "Blur",
    edMosaicSize: "Cell",
    edBlurRadius: "Blur",
    edMarker: "Number",
    edCrop: "Crop",
    edMarkerSize: "Size",
    edText: "Text",
    edEraser: "Eraser",
    edWidth: "Width",
    edFont: "Font",
    edBold: "Bold",
    edItalic: "Italic",
    edUnderline: "Underline",
    edOutline: "Text outline (readable on busy backgrounds)",
    edBackground: "Text background block",
    edFontFamily: "Font family",
    edFontAuto: "Default",
    edFontSerif: "Serif",
    edFontMono: "Mono",
    edFontHand: "Handwriting",
    edAlignLeft: "Align left",
    edAlignCenter: "Align center",
    edAlignRight: "Align right",
    edLineHeight: "Line spacing",
    edUndo: "Undo",
    edRedo: "Redo",
    edOpen: "Open image",
    edSave: "Save",
    edCopy: "Copy",
    edCancel: "Cancel",
    edConfirm: "Confirm",
    edSaveFail: "Save failed",
    edExportFail: "Export failed, the image was not produced. Try again.",
    edCancelled: "Cancelled",
    edWaiting: "Waiting for the screenshot…",
    edLoadFail: "Image failed to load, try another one.",
    edDiscardAsk: "Opening another image discards the annotations. Continue?",
    edCancelAsk: "Discard this screenshot and its annotations?",
    edCloseAsk: "Press the close button again to discard the annotations.",
    edTooLarge: "Image is too large to edit; crop or resize it first.",
    edSaved: "Saved",
    edCopied: "Copied",
    edCopyFail: "Copy failed",
    edTitle: "Edit screenshot",
    edCancelShot: "Cancel capture",
    edEraserHint: "Eraser: removes annotations only (mosaic included), never the photo",
    edAriaTools: "Annotation tools",
    edAriaCanvas: "Screenshot canvas. A mouse is required to draw.",
    edAriaText: "Annotation text. Enter confirms, Escape cancels.",
  },
  zh: {
    shot: "截图",
    shotSettings: "截图设置",
    hideWindow: "截图时隐藏窗口",
    afterCapture: "截图后",
    modeDirect: "直接发送到输入框",
    modeEdit: "编辑后发送",
    hotkeyRow: "快捷键",
    notSet: "未设置",
    pressKeys: "请按键…",
    bind: "设置",
    clear: "清除",
    languageRow: "语言",
    toastInInput: "截图已放入输入框，确认后发送",
    toastCancelled: "已取消截图",
    toastFailed: "截图失败",
    toastFailedDetail: "截图失败：{0}",
    toastEmpty: "截图失败：图像为空",
    toastFileErr: "截图失败：无法构造图片",
    toastDeliverFail: "放入输入框失败，请重试",
    toastCopiedInstead: "输入框没有接收这张图，已改为复制到剪贴板",
    toastRecording: "请直接按下组合键（Esc 退出，退格清除）",
    toastBound: "快捷键已设为 {0}",
    toastCleared: "快捷键已清除",
    toastUnbindFail: "快捷键解除失败，请重启应用后重试",
    toastBusy: "快捷键被占用，换一个再试",
    toastHotkeyUnusable: "已保存的快捷键当前无法绑定，请重新设置",
    toastNeedMod: "单字母需配合 Ctrl/Alt/Shift",
    toastKeyBad: "该按键不支持做快捷键",
    toastNoWin: "不支持 Win 键组合",
    toastSaveFail: "设置未保存，已恢复为上次的值",
    toastBusyShot: "截图进行中…",
    toastTimeout: "截图超时，未收到图像。若截图界面仍开着请手动关闭后重试。",
    edRect: "矩形",
    edEllipse: "椭圆",
    edLine: "直线",
    edArrow: "箭头",
    edBrush: "画笔",
    edMosaic: "马赛克",
    edBlur: "模糊",
    edMosaicSize: "格子",
    edBlurRadius: "强度",
    edMarker: "序号",
    edCrop: "裁剪",
    edMarkerSize: "大小",
    edText: "文字",
    edEraser: "橡皮擦",
    edWidth: "粗细",
    edFont: "字号",
    edBold: "加粗",
    edItalic: "斜体",
    edUnderline: "下划线",
    edOutline: "文字描边（复杂背景上更清楚）",
    edBackground: "文字底色块",
    edFontFamily: "字体",
    edFontAuto: "默认",
    edFontSerif: "衬线",
    edFontMono: "等宽",
    edFontHand: "手写",
    edAlignLeft: "左对齐",
    edAlignCenter: "居中",
    edAlignRight: "右对齐",
    edLineHeight: "行距",
    edUndo: "撤销",
    edRedo: "重做",
    edOpen: "打开图片",
    edSave: "保存",
    edCopy: "复制",
    edCancel: "取消",
    edConfirm: "确认",
    edSaveFail: "保存失败",
    edExportFail: "导出失败，没有生成图片，请重试。",
    edCancelled: "已取消",
    edWaiting: "等待截图传入…",
    edLoadFail: "图片载入失败，换一张再试。",
    edDiscardAsk: "打开另一张图片会丢弃当前标注，继续吗？",
    edCancelAsk: "放弃这张截图和标注吗？",
    edCloseAsk: "再次点击关闭即放弃标注。",
    edTooLarge: "图片太大，无法编辑，请先裁剪或缩小。",
    edSaved: "已保存",
    edCopied: "已复制",
    edCopyFail: "复制失败",
    edTitle: "编辑截图",
    edCancelShot: "取消截图",
    edEraserHint: "橡皮擦：只擦除标注（含马赛克），不伤原图",
    edAriaTools: "标注工具",
    edAriaCanvas: "截图画布，需用鼠标绘制。",
    edAriaText: "标注文字，回车确认，Esc 取消。",
  },
}

// The language buttons are the one pair of labels that must not follow the active
// language: each shows its own language's name. Escapes keep this file free of
// non-ASCII text outside the zh table.
const LANG_LABELS: Record<ShotLanguage, string> = { en: "English", zh: "\u4e2d\u6587" }

// How long a toast or a result flash stays on screen before it disappears.
const TOAST_MS = 3500
// The composer re-renders on its own; this poll only covers a remount that drops
// the button without a childList mutation the observer would see.
const MOUNT_POLL_MS = 2000
// Windows delivers the tail of a recorded chord right after the binding exists;
// ignoring pushes for this window keeps the new hotkey from firing on itself.
const HOTKEY_SETTLE_MS = 1500

const BTN_ID = "oc-screenshot-btn"
const CARET_ID = "oc-shot-caret"
const MENU_ID = "oc-shot-menu"
const TOAST_ID = "oc-screenshot-toast"
const VARIANT_SEL = '[data-component="prompt-variant-control"]'
const ANCHORS = [
  VARIANT_SEL,
  '[data-component="prompt-model-control"]',
  '[data-action="prompt-model-variant"]',
  '[data-action="prompt-model"]',
]
// 2.2.x dropped every selector above; the toolbar row is the surviving anchor.
const FALLBACK_ANCHOR = '[data-slot="composer-actions"]'
const PROMPT_INPUT = '[data-component="prompt-input"]'

// Deliberate: A-Z, 0-9 and F1-F24 only. Space/Enter/Tab/arrows are rejected by
// design (global footguns). A chord also needs Ctrl or Alt unless the key is a
// function key: Shift+A is how an uppercase A is typed, so binding it would take
// that key away from every application.
export function normHotkey(value: string): string {
  try {
    const text = String(value == null ? "" : value).trim()
    if (!text) return ""
    const mods: string[] = []
    let key = ""
    for (const raw of text.split("+")) {
      const part = raw.trim()
      if (!part) continue
      const lower = part.toLowerCase()
      if (lower === "ctrl" || lower === "control") {
        if (!mods.includes("Ctrl")) mods.push("Ctrl")
      } else if (lower === "alt") {
        if (!mods.includes("Alt")) mods.push("Alt")
      } else if (lower === "shift") {
        if (!mods.includes("Shift")) mods.push("Shift")
      } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) key = "F" + parseInt(part.slice(1), 10)
      else if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase()
      else return ""
    }
    const order: Record<string, number> = { Ctrl: 0, Alt: 1, Shift: 2 }
    mods.sort((a, b) => order[a] - order[b])
    if (!key) return ""
    const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
    if (!functionKey && !mods.includes("Ctrl") && !mods.includes("Alt")) return ""
    if (mods.length === 1 && mods[0] === "Ctrl" && ["C", "X", "V", "A", "Z", "W", "S"].includes(key)) return ""
    if (mods.length === 1 && mods[0] === "Alt" && key === "F4") return ""
    return mods.concat([key]).join("+")
  } catch {
    return ""
  }
}

function normLanguage(value: unknown): ShotLanguage {
  try {
    return String(value == null ? "" : value).trim().toLowerCase() === "zh" ? "zh" : "en"
  } catch {
    return "en"
  }
}

function normSendMode(value: unknown): ShotSettings["sendMode"] {
  try {
    return String(value == null ? "" : value).trim().toLowerCase() === "direct" ? "direct" : "edit"
  } catch {
    return "edit"
  }
}

function toast(message: string): void {
  const old = document.getElementById(TOAST_ID)
  if (old) old.remove()
  const node = document.createElement("div")
  node.id = TOAST_ID
  node.setAttribute("role", "status")
  node.setAttribute("aria-live", "polite")
  node.textContent = message
  node.style.cssText =
    "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);" +
    "background:#1f2937;color:#f9fafb;font-size:13px;padding:8px 16px;" +
    "border-radius:8px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
    "pointer-events:none;max-width:80vw;"
  document.body.appendChild(node)
  setTimeout(() => node.remove(), TOAST_MS)
}

/** Fills `{0}` in a label so no message depends on a trailing space. */
function fill(template: string, value: string): string {
  // A function replacement, not a string: an error message containing "$&" or
  // "$`" would otherwise be read as a replacement pattern.
  return template.replace("{0}", () => value)
}

function toBytes(base64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

/**
 * Resolves the prompt box. The documented selector first, then the 2.2.x
 * contenteditable inside the composer, then any contenteditable at all.
 */
function promptBox(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(PROMPT_INPUT) ??
    document.querySelector<HTMLElement>('[data-slot="composer-content"] [contenteditable="true"]') ??
    document.querySelector<HTMLElement>('[contenteditable="true"]')
  )
}

/** Drop first, then paste; whichever the app prevents counts as delivered. */
function deliver(file: File): "drop" | "paste" | "" {
  let editor: HTMLElement | null = null
  try {
    editor = promptBox()
    if (!editor || !editor.isConnected) return ""
  } catch {
    return ""
  }
  try {
    const data = new DataTransfer()
    data.items.add(file)
    // Dispatch on the editor, not on document: a document-level event never
    // travels through the React root, so its delegated handler would not fire.
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data })
    editor.dispatchEvent(drop)
    if (drop.defaultPrevented) return "drop"
  } catch {
    // fall through to paste
  }
  try {
    const data = new DataTransfer()
    data.items.add(file)
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
    ;(editor ?? document).dispatchEvent(paste)
    return paste.defaultPrevented ? "paste" : ""
  } catch {
    return ""
  }
}

const CAMERA_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
  '<circle cx="12" cy="13" r="4"/></svg>'
const CARET_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 9l6 6 6-6"/></svg>'

function btnCss(): string {
  return (
    "display:inline-flex;align-items:center;justify-content:center;" +
    "width:28px;height:28px;border-radius:8px;background:transparent;border:none;" +
    "cursor:pointer;color:inherit;opacity:.7;flex:none;padding:0;"
  )
}

function placeAfter(reference: Element, element: Element): void {
  try {
    reference.parentElement?.insertBefore(element, reference.nextSibling)
  } catch {
    // A detached anchor simply means the next mount pass retries.
  }
}

export function mountComposerShot(api: ComposerApi): () => void {
  let settings: ShotSettings = { ...DEFAULTS }
  let recording = false
  let busy = false
  let ignoreHotkeyUntil = 0
  // The accelerator this mount already asked main to bind. A toolbar re-render
  // recreates the button and runs the restore again; without this, a hotkey that
  // another program holds toasts its failure on every re-render.
  let restoredHotkey = ""

  let editing = false
  const lang = () => (settings.language === "zh" ? "zh" : "en")
  const T = (key: string): string => TEXT[lang()][key] ?? TEXT.en[key] ?? key
  const hotkeyLabel = () => (settings.hotkey ? settings.hotkey : T("notSet"))

  function applySettings(raw: Partial<ShotSettings> | null | undefined): void {
    if (!raw) return
    settings = {
      hideWindow: raw.hideWindow === undefined ? settings.hideWindow : !(raw.hideWindow === false),
      sendMode: normSendMode(raw.sendMode),
      hotkey: normHotkey(raw.hotkey ?? ""),
      language: normLanguage(raw.language),
    }
  }

  function applyStaticTexts(): void {
    const button = document.getElementById(BTN_ID)
    if (button) {
      button.title = T("shot")
      button.setAttribute("aria-label", T("shot"))
    }
    const caret = document.getElementById(CARET_ID)
    if (caret) {
      caret.title = T("shotSettings")
      caret.setAttribute("aria-label", T("shotSettings"))
    }
  }

  function closeMenu(): void {
    const menu = document.getElementById(MENU_ID)
    // The menu takes focus when it opens, so closing it has to hand focus back
    // or the next Tab restarts from the top of the page.
    const hadFocus = !!menu && menu.contains(document.activeElement)
    menu?.remove()
    if (outsideTimer !== null) {
      window.clearTimeout(outsideTimer)
      outsideTimer = null
    }
    if (outsideHandler) document.removeEventListener("mousedown", outsideHandler)
    outsideHandler = null
    recording = false
    if (hadFocus) document.getElementById(CARET_ID)?.focus()
  }

  function paintLanguageButtons(menu: HTMLElement): void {
    const on = "flex:1;border:none;color:#fff;border-radius:6px;padding:5px 0;cursor:pointer;background:#0b6bcb;"
    const off = "flex:1;background:transparent;border:1px solid #4b5563;color:#e5e7eb;border-radius:6px;padding:5px 0;cursor:pointer;"
    const en = menu.querySelector<HTMLElement>('[data-lang="en"]')
    const zh = menu.querySelector<HTMLElement>('[data-lang="zh"]')
    const isZh = lang() === "zh"
    if (en) {
      en.style.cssText = isZh ? off : on
      en.setAttribute("aria-pressed", isZh ? "false" : "true")
    }
    if (zh) {
      zh.style.cssText = isZh ? on : off
      zh.setAttribute("aria-pressed", isZh ? "true" : "false")
    }
  }

  function renderMenu(): void {
    const menu = document.getElementById(MENU_ID)
    if (!menu) return
    // The accessible name is set once at creation; a language switch has to
    // rewrite it with the rest of the labels.
    menu.setAttribute("aria-label", T("shotSettings"))
    const hotkey = menu.querySelector<HTMLElement>("[data-hk]")
    if (hotkey) hotkey.textContent = recording ? T("pressKeys") : hotkeyLabel()
    const checkbox = menu.querySelector<HTMLInputElement>("[data-hide]")
    if (checkbox) checkbox.checked = !!settings.hideWindow
    const direct = menu.querySelector<HTMLInputElement>('[data-mode="direct"]')
    const edit = menu.querySelector<HTMLInputElement>('[data-mode="edit"]')
    if (direct) direct.checked = settings.sendMode === "direct"
    if (edit) edit.checked = settings.sendMode !== "direct"
    paintLanguageButtons(menu)
    const labels: Array<[string, string]> = [
      ["[data-t-hide]", "hideWindow"],
      ["[data-t-after]", "afterCapture"],
      ["[data-t-direct]", "modeDirect"],
      ["[data-t-edit]", "modeEdit"],
      ["[data-t-hk]", "hotkeyRow"],
      ["[data-bind]", "bind"],
      ["[data-clear]", "clear"],
      ["[data-t-langrow]", "languageRow"],
    ]
    for (const [selector, key] of labels) {
      const node = menu.querySelector<HTMLElement>(selector)
      if (node) node.textContent = T(key)
    }
    const hotkeyField = menu.querySelector<HTMLElement>("[data-hk]")
    if (hotkeyField) hotkeyField.title = T("toastRecording")
  }

  let outsideHandler: ((event: MouseEvent) => void) | null = null
  let outsideTimer: number | null = null

  /**
   * Applies the change locally at once and resolves with what the main process
   * actually stored, so callers that act on the result (the hotkey recorder) run
   * after the write instead of racing it.
   */
  function saveSettings(patch: Partial<ShotSettings>): Promise<{ ok: boolean; settings: ShotSettings }> {
    const before = settings
    const optimistic: ShotSettings = { ...settings, ...patch }
    applySettings(optimistic)
    applyStaticTexts()
    renderMenu()
    return api
      .writeSettings(patch)
      .then((saved) => {
        applySettings(saved)
        applyStaticTexts()
        renderMenu()
        return { ok: true, settings: saved }
      })
      .catch(() => {
        toast(T("toastSaveFail"))
        return api
          .readSettings()
          .then((saved) => {
            applySettings(saved)
            applyStaticTexts()
            renderMenu()
            return { ok: false, settings: saved }
          })
          .catch(() => {
            // Both directions failed: put back what was on screen before the change,
            // or the settings on screen claim something that is not on disk.
            applySettings(before)
            applyStaticTexts()
            renderMenu()
            return { ok: false, settings: before }
          })
      })
  }

  function deliverShot(base64: string): void {
    const bytes = toBytes(base64)
    if (!bytes || !bytes.length) {
      toast(T("toastEmpty"))
      return
    }
    let file: File
    try {
      file = new File([bytes], "screenshot.jpg", { type: "image/jpeg" })
    } catch {
      toast(T("toastFileErr"))
      return
    }
    const how = deliver(file)
    if (how) {
      toast(T("toastInInput"))
      return
    }
    // The image already exists; losing it means the user repeats the whole capture.
    void api
      .copyImage(`data:image/jpeg;base64,${base64}`)
      .then((ok) => toast(ok ? T("toastCopiedInstead") : T("toastDeliverFail")))
      .catch(() => toast(T("toastDeliverFail")))
  }

  async function runShot(button: HTMLButtonElement): Promise<void> {
    if (button.disabled || busy) {
      if (busy) toast(T("toastBusyShot"))
      return
    }
    closeMenu()
    busy = true
    button.disabled = true
    button.style.opacity = "0.4"
    try {
      const result = await api.region()
      if (!result.base64) {
        if (result.kind === "busy") toast(T("toastBusyShot"))
        else if (result.kind === "timeout") toast(T("toastTimeout"))
        else if (result.kind === "cancelled") toast(T("toastCancelled"))
        // A failure carries the reason from main (unsupported platform, spawn
        // error); without it the toast would only say "failed".
        else toast(result.text ? fill(T("toastFailedDetail"), result.text) : T("toastFailed"))
        return
      }
      let base64 = result.base64
      if (settings.sendMode === "edit") {
        const bytes = toBytes(base64)
        if (!bytes || !bytes.length) {
          toast(T("toastEmpty"))
          return
        }
        const edited = await api.openEditor(`data:image/jpeg;base64,${base64}`, TEXT[lang()])
        if (!edited) {
          toast(T("toastCancelled"))
          return
        }
        base64 = String(edited).split(",")[1] ?? ""
      }
      deliverShot(base64)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast(fill(T("toastFailedDetail"), detail))
    } finally {
      busy = false
      button.disabled = false
      button.style.opacity = ""
    }
  }

  function toggleMenu(caret: HTMLButtonElement): void {
    if (document.getElementById(MENU_ID)) {
      closeMenu()
      return
    }
    const menu = document.createElement("div")
    menu.id = MENU_ID
    menu.setAttribute("role", "dialog")
    menu.setAttribute("aria-label", T("shotSettings"))
    const rect = caret.getBoundingClientRect()
    menu.style.cssText =
      "position:fixed;z-index:99999;background:#1f2937;color:#f9fafb;font-size:13px;" +
      "border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.45);" +
      // border-box: the width below is the outer size, which is what the 320 px
      // reservation in the placement maths assumes.
      "box-sizing:border-box;min-width:250px;max-width:310px;"
    // The panel is 250-310 px wide (min/max-width below). Reserve 320 px on the
    // right so the whole panel stays inside the window, 8 px on the left.
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 320, rect.right - 250)) + "px"
    menu.style.top = rect.bottom + 6 + "px"
    menu.innerHTML =
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 0;">' +
      '<input type="checkbox" data-hide' +
      (settings.hideWindow ? " checked" : "") +
      "><span data-t-hide>" +
      T("hideWindow") +
      "</span></label>" +
      '<div style="border-top:1px solid #374151;margin:6px 0"></div>' +
      '<div data-t-after style="color:#9ca3af;font-size:12px;margin-bottom:4px">' +
      T("afterCapture") +
      "</div>" +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 0;">' +
      '<input type="radio" name="oc-shot-mode" data-mode="direct"' +
      (settings.sendMode === "direct" ? " checked" : "") +
      '><span data-t-direct>' +
      T("modeDirect") +
      "</span></label>" +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 0;">' +
      '<input type="radio" name="oc-shot-mode" data-mode="edit"' +
      (settings.sendMode !== "direct" ? " checked" : "") +
      '><span data-t-edit>' +
      T("modeEdit") +
      "</span></label>" +
      '<div style="border-top:1px solid #374151;margin:6px 0"></div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span data-t-hk style="color:#9ca3af;font-size:12px">' +
      T("hotkeyRow") +
      "</span>" +
      '<span data-hk style="flex:1;background:#111827;border-radius:6px;padding:4px 8px;text-align:center">' +
      hotkeyLabel() +
      "</span></div>" +
      '<div style="display:flex;gap:8px;margin-top:8px;">' +
      '<button data-bind style="flex:1;background:#0b6bcb;border:none;color:#fff;border-radius:6px;padding:5px 0;cursor:pointer">' +
      T("bind") +
      "</button>" +
      '<button data-clear style="flex:1;background:transparent;border:1px solid #4b5563;color:#e5e7eb;border-radius:6px;padding:5px 0;cursor:pointer">' +
      T("clear") +
      "</button></div>" +
      '<div style="border-top:1px solid #374151;margin:6px 0"></div>' +
      '<div data-t-langrow style="color:#9ca3af;font-size:12px;margin-bottom:4px">' +
      T("languageRow") +
      "</div>" +
      '<div style="display:flex;gap:8px;">' +
      '<button data-lang="en" style="flex:1;border-radius:6px;padding:5px 0;cursor:pointer">' +
      LANG_LABELS.en +
      "</button>" +
      '<button data-lang="zh" style="flex:1;border-radius:6px;padding:5px 0;cursor:pointer">' +
      LANG_LABELS.zh +
      "</button></div>"
    document.body.appendChild(menu)
    const height = menu.offsetHeight || 0
    if (rect.bottom + 6 + height > window.innerHeight) menu.style.top = Math.max(8, rect.top - height - 6) + "px"
    paintLanguageButtons(menu)
    menu.querySelector<HTMLElement>("input, button")?.focus()
    // Escape closes the menu; while the recorder is armed it owns that key.
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || recording) return
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    })

    menu.querySelector("[data-hide]")?.addEventListener("change", (event) => {
      void saveSettings({ hideWindow: (event.target as HTMLInputElement).checked })
    })
    for (const node of Array.from(menu.querySelectorAll<HTMLInputElement>("[data-mode]"))) {
      node.addEventListener("change", () => {
        if (node.checked) void saveSettings({ sendMode: node.dataset.mode === "direct" ? "direct" : "edit" })
      })
    }
    menu.querySelector("[data-bind]")?.addEventListener("click", () => {
      recording = true
      renderMenu()
      toast(T("toastRecording"))
    })
    menu.querySelector("[data-clear]")?.addEventListener("click", () => {
      recording = false
      void saveSettings({ hotkey: "" }).then(({ ok }) => {
        // The failure is already reported; unbinding anyway would leave the app
        // without the key while the file still holds it for the next start.
        if (!ok) return
        void api
          .setHotkey("")
          .then((bound) => toast(bound ? T("toastCleared") : T("toastUnbindFail")))
          .catch(() => toast(T("toastUnbindFail")))
      })
    })
    for (const node of Array.from(menu.querySelectorAll<HTMLElement>("[data-lang]"))) {
      node.addEventListener("click", () => {
        const value: ShotLanguage = node.dataset.lang === "zh" ? "zh" : "en"
        void saveSettings({ language: value })
      })
    }

    outsideTimer = window.setTimeout(() => {
      outsideTimer = null
      outsideHandler = (event: MouseEvent) => {
        const current = document.getElementById(MENU_ID)
        const trigger = document.getElementById(CARET_ID)
        const target = event.target as Node | null
        if (current && target && !current.contains(target) && !(trigger && trigger.contains(target))) closeMenu()
      }
      document.addEventListener("mousedown", outsideHandler)
    }, 0)
  }

  function onRecordingKey(event: KeyboardEvent): void {
    if (!recording) return
    if (!document.getElementById(MENU_ID)) {
      recording = false
      return
    }
    if (event.isComposing) return
    event.stopPropagation()
    if (event.key === "Tab") {
      recording = false
      renderMenu()
      return
    }
    if (event.metaKey) {
      toast(T("toastNoWin"))
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      recording = false
      renderMenu()
      return
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault()
      recording = false
      renderMenu()
      void saveSettings({ hotkey: "" }).then(({ ok }) => {
        if (!ok) return
        void api
          .setHotkey("")
          .then((bound) => toast(bound ? T("toastCleared") : T("toastUnbindFail")))
          .catch(() => toast(T("toastUnbindFail")))
      })
      return
    }
    const mods: string[] = []
    if (event.ctrlKey) mods.push("Ctrl")
    if (event.altKey) mods.push("Alt")
    if (event.shiftKey) mods.push("Shift")
    const raw = event.key
    if (["Control", "Alt", "Shift", "Meta"].includes(raw)) return
    event.preventDefault()
    const key = /^[a-z0-9]$/i.test(raw)
      ? raw.toUpperCase()
      : /^F([1-9]|1[0-9]|2[0-4])$/i.test(raw)
        ? "F" + parseInt(raw.slice(1), 10)
        : ""
    if (!key) {
      toast(T("toastKeyBad"))
      return
    }
    // A function key may stand alone; anything else needs Ctrl or Alt, or the
    // binding would swallow ordinary typing (Shift+A is how an uppercase A is typed).
    if (!/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && !mods.includes("Ctrl") && !mods.includes("Alt")) {
      toast(T("toastNeedMod"))
      return
    }
    const combo = normHotkey(mods.concat([key]).join("+"))
    if (!combo) {
      toast(T("toastKeyBad"))
      return
    }
    recording = false
    const previous = settings.hotkey
    void saveSettings({ hotkey: combo })
      .then(async ({ ok: stored }) => {
      // Nothing was written, so nothing should be bound.
      if (!stored) return
      const ok = await api.setHotkey(combo)
      if (!ok) {
        const back = await saveSettings({ hotkey: previous })
        const rebound = await api.setHotkey(previous)
        // Say so when the rollback itself failed: the file and the system binding
        // would otherwise disagree with the menu.
        toast(back.ok && rebound ? T("toastBusy") : T("toastSaveFail"))
        renderMenu()
        return
      }
        ignoreHotkeyUntil = Date.now() + HOTKEY_SETTLE_MS
        toast(fill(T("toastBound"), combo))
        renderMenu()
      })
      .catch(() => toast(T("toastSaveFail")))
  }

  // ---- mount -------------------------------------------------------------

  function attach(): void {
    if (document.getElementById(BTN_ID)) return
    let anchor: Element | null = null
    let fallback = false
    for (const selector of ANCHORS) {
      anchor = document.querySelector(selector)
      if (anchor) break
    }
    if (!anchor) {
      anchor = document.querySelector(FALLBACK_ANCHOR)
      fallback = true
    }
    if (!anchor || !anchor.parentElement) return

    const button = document.createElement("button")
    button.id = BTN_ID
    button.type = "button"
    button.title = T("shot")
    button.setAttribute("aria-label", T("shot"))
    button.innerHTML = CAMERA_SVG
    button.style.cssText = btnCss()
    button.addEventListener("mouseenter", () => {
      button.style.opacity = "1"
      button.style.background = "rgba(127,127,127,.15)"
    })
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) {
        button.style.opacity = ".7"
        button.style.background = "transparent"
      }
    })
    button.addEventListener("click", () => void runShot(button))

    const caret = document.createElement("button")
    caret.id = CARET_ID
    caret.type = "button"
    caret.title = T("shotSettings")
    caret.setAttribute("aria-label", T("shotSettings"))
    caret.innerHTML = CARET_SVG
    caret.style.cssText = btnCss() + "width:20px;"
    caret.addEventListener("click", (event) => {
      event.stopPropagation()
      toggleMenu(caret)
    })

    if (fallback) {
      // Insert at the start of the action cluster: the cluster sits at the end of
      // the composer, so the pair lands next to the other composer controls.
      anchor.insertBefore(caret, anchor.firstChild)
      anchor.insertBefore(button, caret)
    } else {
      placeAfter(anchor, button)
      placeAfter(button, caret)
    }

    void api
      .readSettings()
      .then((saved) => {
        applySettings(saved)
        applyStaticTexts()
        // settings.hotkey is the normalised value; the file may hold anything and
        // main would register it verbatim.
        if (settings.hotkey && settings.hotkey !== restoredHotkey) {
          restoredHotkey = settings.hotkey
          void api
            .setHotkey(settings.hotkey)
            .then((ok) => {
              if (!ok) toast(T("toastHotkeyUnusable"))
            })
            .catch(() => {})
        }
      })
      .catch(() => {})
  }

  const observer = new MutationObserver(() => attach())
  const timer = window.setInterval(attach, MOUNT_POLL_MS)
  const onKey = (event: KeyboardEvent) => onRecordingKey(event)
  document.addEventListener("keydown", onKey, true)

  // Main pushes the hotkey capture through a DOM event; a plugin window has no
  // ipcRenderer to listen on.
  const onHotkey = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail
    if (!detail) return
    if (ignoreHotkeyUntil && Date.now() < ignoreHotkeyUntil) return
    // The editor is already open on a capture this window started; a second
    // overlay would sit on top of it.
    if (busy) {
      toast(T("toastBusyShot"))
      return
    }
    closeMenu()
    try {
      const payload = JSON.parse(detail) as { base64: string | null; kind?: string; text?: string }
      if (payload.base64) {
        if (settings.sendMode === "edit") {
          void openEditorThenDeliver(payload.base64).catch(() => toast(T("toastDeliverFail")))
        } else {
          deliverShot(payload.base64)
        }
      } else if (payload.kind === "busy") {
        toast(T("toastBusyShot"))
      } else if (payload.kind === "timeout") {
        toast(T("toastTimeout"))
      } else if (payload.kind === "cancelled") {
        toast(T("toastCancelled"))
      } else if (payload.text) {
        toast(fill(T("toastFailedDetail"), payload.text))
      }
    } catch {
      // A malformed push is dropped; the next capture retries.
    }
  }
  window.addEventListener("screenshot:hotkey", onHotkey)

  // Another window wrote the settings; the menu, the labels and the send mode are
  // per-window copies, so they have to be re-read instead of going stale.
  let settingsToken = 0
  const onSettings = () => {
    // Two quick writes produce two reads; only the last one may win.
    const token = ++settingsToken
    void api
      .readSettings()
      .then((saved) => {
        if (token !== settingsToken) return
        applySettings(saved)
        applyStaticTexts()
        renderMenu()
      })
      .catch(() => {})
  }
  window.addEventListener("screenshot:settings", onSettings)

  async function openEditorThenDeliver(base64: string): Promise<void> {
    // The editor is modal for this window: a second hotkey press would open a
    // second overlay, or (with the single-overlay guard in the editor) look like a
    // cancelled capture. Report it as busy instead.
    if (editing) {
      toast(T("toastBusyShot"))
      return
    }
    editing = true
    try {
      await deliverThroughEditor(base64)
    } finally {
      editing = false
    }
  }

  async function deliverThroughEditor(base64: string): Promise<void> {
    const bytes = toBytes(base64)
    if (!bytes) {
      toast(T("toastEmpty"))
      return
    }
    const edited = await api.openEditor(`data:image/jpeg;base64,${base64}`, TEXT[lang()])
    if (!edited) {
      toast(T("toastCancelled"))
      return
    }
    deliverShot(String(edited).split(",")[1] ?? "")
  }

  attach()
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    window.clearInterval(timer)
    document.removeEventListener("keydown", onKey, true)
    window.removeEventListener("screenshot:hotkey", onHotkey)
    window.removeEventListener("screenshot:settings", onSettings)
    // closeMenu, not remove: the outside-click listener sits on document and would
    // otherwise outlive the plugin.
    closeMenu()
    document.getElementById(BTN_ID)?.remove()
    document.getElementById(CARET_ID)?.remove()
  }
}
