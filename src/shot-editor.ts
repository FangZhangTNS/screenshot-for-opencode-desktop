// Annotation editor: two canvases, a tool bar, and export.
//
// The surface is two canvases (photo on base,
// annotations on over), eleven tools, destructive-erase semantics
// (destination-out on the annotation layer, the photo is never touched), the
// same JPEG export cap and the same labels as the rest of the plugin.
//
// It is mounted twice: normally into a dedicated modal window created by the
// main process (editor-window.ts), and as a full-page overlay when the host
// refuses to create one. Both mount the same DOM, so the only difference is the
// document it is appended to:
//  - the canvas is scaled to fit whatever it is mounted in; coordinates are
//    mapped back through the rect so drawing stays in image pixels.
//  - "Save" asks the main process for a path (dialog) instead of a plain
//    injected api.saveShotFile.
//
// Everything else — tool behaviour, defaults (width 3, font 20, mosaic 14),
// keyboard shortcuts, flash texts and the 1568 px / 0.9 export are fixed here.

export type EditorText = (key: string) => string

export type EditorOptions = {
  t: EditorText
  /**
   * True when the editor is mounted in a normal framed window: the caption band and
   * the frame offset only exist for the borderless overlay.
   */
  framed?: boolean
  /** Writes the PNG to disk; resolves "saved" | "cancelled" | "failed". */
  save: (dataUrl: string) => Promise<string>
  /** Puts the PNG on the system clipboard; the renderer clipboard API is denied here. */
  copy: (dataUrl: string) => Promise<boolean>
}

type Tool = "rect" | "ellipse" | "line" | "arrow" | "brush" | "mosaic" | "blur" | "marker" | "text" | "eraser" | "crop"

type Point = [number, number]

type Align = "left" | "center" | "right"

type Shape = {
  type: Tool
  pts?: Point[]
  x?: number
  y?: number
  w?: number
  h?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  color?: string
  width?: number
  size?: number
  text?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  font?: string
  align?: Align
  lineHeight?: number
  outline?: boolean
  background?: boolean
  /** Mosaic cells baked once at draw time: [x, y, averageColour]. */
  cells?: Array<[number, number, string]>
}

type TextStyle = {
  bold: boolean
  italic: boolean
  underline: boolean
  font: string
  align: Align
  lineHeight: number
  outline: boolean
  background: boolean
  color: string
  size: number
}

type Session = TextStyle & { x: number; y: number }

type Drawing = {
  tool: Tool
  start: { x: number; y: number }
  cur: { x: number; y: number }
  preview: Shape | null
  drawn: number
  pts: Point[] | null
}

const COLORS = ["#ff2d2d", "#ff7b00", "#ffcf00", "#22c55e", "#0b6bcb", "#8b5cf6", "#ec4899", "#ffffff", "#000000"]
// Export caps. The JPEG is what the model receives and is capped to MAX_DIM; the
// PNG written by Save and Copy keeps full resolution. MAX_DIM has to stay equal to
// MAX_IMAGE_DIM in screenshot/capture.ts, which caps the capture itself: this module takes no
// imports by design (the editor is a standalone bundle), so the two numbers are a
// documented pair rather than a shared symbol.
export const MAX_DIM = 1568
const MAX_SNAPSHOTS = 60
// Roughly 24 MB of serialized history; a single mosaic stroke can be 200 KB, so
// the count alone is not a bound.
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024
/** Height of the invisible native caption-button strip on Windows, in CSS px. */
const CAPTION_BAND = 32
// Canvas wants 0-1; the capture side hands Electron 0-100 for the same policy.
const EXPORT_JPEG_QUALITY = 0.9
// Default mosaic cell in image pixels: coarse enough to hide text, fine enough to
// keep the surrounding layout readable.
const MOSAIC_SIZE = 14
// Toolbar defaults, all user-adjustable: stroke width, text size, blur radius.
const DEFAULT_LINE_WIDTH = 3
const DEFAULT_FONT_SIZE = 20
const DEFAULT_BLUR_RADIUS = 8
/** Above this an "Open image" pick is not a screenshot; refuse before decoding. */
const MAX_OPEN_BYTES = 25 * 1024 * 1024
/** How long a footer button shows its result ("Saved") before reverting. */
const FLASH_MS = 1500
/** Hit-test slop in screen pixels, converted to image pixels per call. */
const HIT_SLOP = 8
/** Movement under this many screen pixels (both axes summed) is a click. */
const DRAG_THRESHOLD = 3
/**
 * How long a two-step confirmation stays armed, in milliseconds.
 *
 * Long enough to read the warning and act on it: a confirmation that expires while the
 * user is reading is worse than one that waits, and the hint stays on screen meanwhile.
 */
const CONFIRM_WINDOW_MS = 10000
/** A second press within this long is the Esc ladder, not a confirmation. */
const CONFIRM_COOLDOWN_MS = 900
/** Longest annotation text accepted, in characters. */
const MAX_TEXT_CHARS = 4000
/** Shortest on-screen edge a fitted image may shrink to. */
const MIN_VISIBLE_SHORT_EDGE = 40
/** ...but never magnify more than this, or a 2 px strip fills the screen. */
const MAX_FIT_UPSCALE = 4
/** Refuse images whose two canvases could not fit in memory. */
const MAX_OPEN_PIXELS = 24_000_000
/** Largest base64 export handed to the main process, in characters. */
const MAX_EXPORT_CHARS = 48 * 1024 * 1024
/** A crop narrower or shorter than this exports an empty canvas. */
const MIN_CROP_SIDE = 2
/** Marker circle: radius = max(minimum, font size × ratio). */
const MARKER_MIN_RADIUS = 12
const MARKER_RADIUS_RATIO = 0.9
/** Arrow head length = max(minimum, stroke width × ratio). */
const ARROW_HEAD_MIN_LENGTH = 10
const ARROW_HEAD_WIDTH_RATIO = 4
/** Space the frameless window's own controls occupy in the top-right corner. */
const WINDOW_CONTROLS_GUTTER = 140
// Fit-to-stage maths. X mirrors #stage's 12 px padding on both sides; Y keeps 12 px
// more so the image stays clear of the hint line at the top of the stage. The
// minimum keeps a tiny image from being scaled into nothing.
const STAGE_MIN_ROOM = 120
const STAGE_PAD_X = 24
const STAGE_PAD_Y = 36

// Family keys stay stable across runs; the CSS stacks are resolved at paint time.
const FONT_FAMILIES: Array<[string, string]> = [
  ["auto", 'system-ui,"Microsoft YaHei",sans-serif'],
  ["serif", 'Georgia,"Times New Roman","SimSun",serif'],
  ["mono", 'Consolas,"Courier New",monospace'],
  ["hand", '"Comic Sans MS","Segoe Script","KaiTi",cursive'],
]

function familyStack(key: string): string {
  const found = FONT_FAMILIES.find(([name]) => name === key)
  return (found ? found[1] : FONT_FAMILIES[0][1])
}

/** Pick black or white so an outline stays visible against the fill colour. */
function contrastFor(fill: string): string {
  const hex = fill.replace("#", "")
  if (hex.length !== 6) return "#000000"
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return "#000000"
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000000" : "#ffffff"
}

const STYLE = `
#oc-shot-editor{position:fixed;left:0;right:0;bottom:0;z-index:2147483003;background:#1e1e1e;color:#eee;
  font:14px system-ui,"Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column}
#oc-shot-editor [data-tip]{position:relative}
#oc-shot-editor [data-tip]:hover::after,#oc-shot-editor [data-tip]:focus-visible::after{
  content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 6px);
  transform:translateX(calc(-50% + var(--tip-shift,0px)));background:#101010;color:#fff;border:1px solid #555;border-radius:4px;
  padding:3px 8px;font-size:12px;font-weight:400;font-style:normal;text-decoration:none;letter-spacing:0;
  white-space:nowrap;pointer-events:none;z-index:30}
#oc-shot-editor [data-tip]:hover::before,#oc-shot-editor [data-tip]:focus-visible::before{
  content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);
  border:5px solid transparent;border-bottom-color:#555;pointer-events:none;z-index:30}
#oc-shot-editor #bar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;
  background:#2b2b2b;border-bottom:1px solid #444}
#oc-shot-editor #bar button{background:#3a3a3a;color:#eee;border:1px solid #555;border-radius:6px;
  min-width:30px;height:30px;padding:0 8px;box-sizing:border-box;cursor:pointer;font-size:15px;line-height:1}
#oc-shot-editor #bar label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#b9b9b9;white-space:nowrap}
#oc-shot-editor #bar button.active{background:#0b6bcb;border-color:#0b6bcb}
#oc-shot-editor #bar button:hover{background:#4a4a4a}
#oc-shot-editor #bar button.active:hover{background:#0b6bcb}
#oc-shot-editor #bar button:disabled{opacity:.45;cursor:default}
#oc-shot-editor #bar button:focus-visible{outline:2px solid #fff;outline-offset:1px}
#oc-shot-editor #foot button:focus-visible{outline:2px solid #fff;outline-offset:1px}
#oc-shot-editor #bar button.sw{width:24px;height:24px;min-width:24px;padding:0;border-radius:50%;
  border:1px solid #1e1e1e;background-clip:padding-box;box-sizing:border-box;cursor:pointer}
/* A white ring on a white swatch is invisible, so the selection is a dark gap plus
   a white ring, which reads on every colour. */
#oc-shot-editor #bar button.sw.active{box-shadow:0 0 0 1px #1e1e1e,0 0 0 3px #fff}
#oc-shot-editor #bar .sw:focus-visible{outline:2px solid #fff;outline-offset:1px}
#oc-shot-editor #colors{display:flex;gap:4px;align-items:center;flex:none}
#oc-shot-editor #stage{flex:1;min-height:0;position:relative;overflow:auto;display:flex;
  align-items:flex-start;justify-content:center;justify-content:safe center;padding:12px}
#oc-shot-editor #wrap{position:relative;flex:none;margin:auto}
#oc-shot-editor canvas{position:absolute;left:0;top:0;width:100%;height:100%}
#oc-shot-editor #base{z-index:1}
#oc-shot-editor #over{z-index:2;cursor:crosshair;touch-action:none}
#oc-shot-editor #over:focus-visible{outline:2px dashed #0b6bcb;outline-offset:-2px}
#oc-shot-editor #foot{flex:none;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:10px;
  background:#2b2b2b;border-top:1px solid #444}
#oc-shot-editor #foot button{padding:6px 18px;border-radius:6px;border:1px solid #555;background:#3a3a3a;
  color:#eee;cursor:pointer}
#oc-shot-editor #ok{background:#0b6bcb !important;border-color:#0b6bcb !important}
#oc-shot-editor #hint{position:absolute;top:12px;left:50%;transform:translateX(-50%);color:#bbb;z-index:5;
  background:rgba(20,20,20,.82);padding:4px 10px;border-radius:6px;pointer-events:none}
#oc-shot-editor #txtInput{position:absolute;z-index:3;display:none;background:transparent;
  border:0;padding:0;margin:0;box-sizing:border-box;outline:1px dashed #0b6bcb;outline-offset:0;
  color:inherit;font-family:inherit;resize:none;overflow:hidden}
`

// Hover label. The native title attribute waits about a second; a data attribute
// plus the CSS rule above shows it immediately.
function setTip(el: HTMLElement, text: string): void {
  el.dataset.tip = text
  el.setAttribute("aria-label", text)
  // The tip is centred under its button, so a button near the window edge loses
  // part of it. Shift it back inside when that would happen.
  el.addEventListener("mouseenter", () => {
    const rect = el.getBoundingClientRect()
    const overflow = Math.max(0, 52 - (rect.left + rect.width / 2))
    if (overflow > 0) el.style.setProperty("--tip-shift", `${overflow}px`)
    else el.style.removeProperty("--tip-shift")
  })
}

const TOOL_KEYS: Array<[Tool, string, string]> = [
  ["rect", "edRect", "▭"],
  ["ellipse", "edEllipse", "◯"],
  ["line", "edLine", "/"],
  ["arrow", "edArrow", "↗"],
  ["brush", "edBrush", "✎"],
  ["mosaic", "edMosaic", "▦"],
  ["blur", "edBlur", "◍"],
  ["marker", "edMarker", "①"],
  ["text", "edText", "T"],
  ["eraser", "edEraser", "⌫"],
  ["crop", "edCrop", "⬚"],
]

function stampName(): string {
  const pad = (n: number) => (n < 10 ? "0" : "") + n
  const d = new Date()
  return (
    "screenshot-" +
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    ".jpg"
  )
}

/**
 * Opens the annotation surface for `file` and resolves with the confirmed JPEG,
 * or null when the user cancels. The overlay is removed before resolving.
 */
export function openShotEditor(file: File, options: EditorOptions): Promise<File | null> {
  // A second overlay would stack two full-screen layers, two key handlers and two
  // mouseup listeners; the hotkey can fire while the first one is still open.
  if (document.querySelector('[data-screenshot-editor="1"]')) return Promise.resolve(null)
  const T = options.t
  // Remember where focus was: the editor is modal for whatever it is mounted in, so
  // keystrokes must not leak past it, and focus should return where it was.
  const previousFocus = document.activeElement as HTMLElement | null

  return new Promise((resolve) => {
    const style = document.createElement("style")
    style.textContent = STYLE
    document.head.appendChild(style)

    const root = document.createElement("div")
    root.id = "oc-shot-editor"
    root.setAttribute("data-screenshot-editor", "1")
    root.setAttribute("role", "dialog")
    root.setAttribute("aria-modal", "true")
    root.setAttribute("aria-label", T("edTitle"))

    const bar = document.createElement("div")
    bar.id = "bar"
    bar.setAttribute("role", "toolbar")
    bar.setAttribute("aria-label", T("edAriaTools"))

    // A mouseup lost outside the window leaves a half-drawn stroke and blocks the
    // footer buttons; clicking the toolbar is a safe place to drop it.
    bar.addEventListener("mousedown", () => {
      if (drawing) {
        drawing = null
        render()
      }
    })

    const stage = document.createElement("div")
    stage.id = "stage"
    const hint = document.createElement("div")
    hint.id = "hint"
    hint.setAttribute("role", "status")
    hint.setAttribute("aria-live", "polite")
    hint.textContent = T("edWaiting")
    const wrap = document.createElement("div")
    wrap.id = "wrap"
    const base = document.createElement("canvas")
    base.id = "base"
    const over = document.createElement("canvas")
    over.id = "over"
    over.tabIndex = 0
    over.setAttribute("role", "application")
    over.setAttribute("aria-label", T("edAriaCanvas"))
    const txtInput = document.createElement("textarea")
    txtInput.id = "txtInput"
    txtInput.rows = 1
    // A pasted transcript would freeze the layout on every keystroke.
    txtInput.maxLength = MAX_TEXT_CHARS
    txtInput.setAttribute("aria-label", T("edAriaText"))
    wrap.append(base, over, txtInput)
    stage.append(hint, wrap)

    const foot = document.createElement("div")
    foot.id = "foot"

    const fileInput = document.createElement("input")
    fileInput.type = "file"
    fileInput.id = "file"
    fileInput.accept = "image/png,image/jpeg,image/webp"
    fileInput.style.display = "none"

    root.append(bar, stage, foot, fileInput)
    document.body.appendChild(root)

    // The window frame (title bar with minimise/close) is drawn by the OS above
    // all DOM content, so the overlay starts below it instead of covering it.
    // When the window has no frame geometry to measure, the history buttons are
    // kept away from the right edge further down instead.
    const frameTop = options.framed ? 0 : Math.max(0, window.outerHeight - window.innerHeight)
    // Always set top. Leaving it unset on a frameless window turned the overlay
    // into a shrink-to-fit box, and the canvas fit maths collapsed with it.
    root.style.top = `${frameTop}px`
    // Windows keeps the caption buttons clickable even when the host paints its own
    // title bar, and they occupy the top-right corner of the window. A frameless
    // window still reports a few pixels of frame, so the overlay can start inside
    // that strip: the toolbar's right-hand controls would then minimise, maximise or
    // close the window instead of applying a style. Padding, not a taller bar, keeps
    // the bar's background continuous.
    const captionInset = options.framed ? 0 : Math.max(0, CAPTION_BAND - frameTop)
    if (captionInset > 0) bar.style.paddingTop = `${captionInset + 8}px`
    try {
      over.focus()
    } catch {}

    // Mosaic reads pixels back from this context every frame; without the hint
    // Chromium keeps the surface GPU-side and each getImageData syncs.
    const baseContext = base.getContext("2d", { willReadFrequently: true })
    const overContext = over.getContext("2d")
    if (!baseContext || !overContext) {
      // The overlay is already in the DOM and has no close handler yet; leaving it
      // would block the whole UI with no way to dismiss it. close() cannot be used
      // here: it reads state that is declared further down.
      root.remove()
      style.remove()
      resolve(null)
      return
    }
    const bctx: CanvasRenderingContext2D = baseContext
    const octx: CanvasRenderingContext2D = overContext

    let tool: Tool = "rect"
    let color = COLORS[0]
    let lineWidth = DEFAULT_LINE_WIDTH
    let fontSize = DEFAULT_FONT_SIZE
    // Text decoration applies to newly created text shapes; each shape keeps its
    // own copy so toggling the buttons later does not restyle existing text.
    const textStyle: Omit<TextStyle, "color" | "size"> = {
      bold: false,
      italic: false,
      underline: false,
      font: "auto",
      align: "left",
      lineHeight: 1.3,
      outline: false,
      background: false,
    }
    let mosaicCell = MOSAIC_SIZE
    let blurRadius = DEFAULT_BLUR_RADIUS
    // Step numbers restart when the marker tool is re-entered, matching the
    // "one explanation, numbered steps" workflow they exist for.
    let markerCounter = 1
    // Crop is applied at export time only: the annotation coordinate system stays
    // in original-image pixels, so existing shapes never need to move.
    let cropRect: { x: number; y: number; w: number; h: number } | null = null
    // While exporting we paint a chrome-free overlay: the selection box and the
    // crop mask live on the same canvas as the annotations, so without this they
    // end up baked into the saved/copied image.
    let exporting = false
    const shapes: Shape[] = []
    let drawing: Drawing | null = null
    let textSession: Session | null = null
    /** The committed shape open for editing right now; skipped while drawing. */
    let hiddenShape: Shape | null = null
    // Scratch surface for blur: the photo plus the annotations already drawn under it.
    let blurSource: HTMLCanvasElement | null = null
    let dragShape: { shape: Shape; orig: Shape; startX: number; startY: number; moved: boolean } | null = null
    // Shape being re-edited; null means this session creates a new one. A reference
    // instead of an index, because history rebuilds replace every shape object.
    let editingShape: Shape | null = null
    let selected: Shape | null = null
    let imgW = 0
    let imgH = 0
    let finished = false
    let objectUrl = ""

    // ---- toolbar -----------------------------------------------------------

    const toolButtons: HTMLButtonElement[] = []
    for (const [name, key, glyph] of TOOL_KEYS) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.tool = name
      button.textContent = glyph
      const ordinal = toolButtons.length + 1
      const shortcut = ordinal <= 9 ? ` (${ordinal})` : ordinal === 10 ? " (0)" : " (C)"
      setTip(button, `${T(key)}${shortcut}`)
      button.setAttribute("aria-label", `${T(key)}${shortcut}`)
      if (name === tool) {
        button.classList.add("active")
        button.setAttribute("aria-pressed", "true")
      } else {
        button.setAttribute("aria-pressed", "false")
      }
      if (name === "eraser") setTip(button, `${T("edEraserHint")} (0)`)
      // Select on pointerdown, not only on click. A click needs the pointerup to
      // land on the same element, and one report had the eleventh tool never
      // responding while its neighbours worked; pressing is the narrower contract.
      // The click listener stays for keyboard activation, where detail is 0.
      let pressedByPointer = false
      const select = () => {
        disarm()
        commitText()
        if (name === "marker" && tool !== "marker") markerCounter = 1
        tool = name
        for (const each of toolButtons) {
          each.classList.remove("active")
          each.setAttribute("aria-pressed", "false")
        }
        button.classList.add("active")
        button.setAttribute("aria-pressed", "true")
        syncContext()
      }
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return
        pressedByPointer = true
        select()
      })
      button.addEventListener("click", (event) => {
        const fromPointer = pressedByPointer
        pressedByPointer = false
        // A pointer press already selected; a keyboard press reports detail 0 and
        // never fires pointerdown.
        if (fromPointer && event.detail !== 0) return
        select()
      })
      toolButtons.push(button)
      bar.appendChild(button)
    }

    const colorBox = document.createElement("span")
    colorBox.id = "colors"
    COLORS.forEach((value, index) => {
      const swatch = document.createElement("button")
      swatch.type = "button"
      swatch.className = "sw" + (index === 0 ? " active" : "")
      swatch.style.background = value
      setTip(swatch, value)
      swatch.dataset.color = value
      swatch.setAttribute("aria-label", value)
      swatch.setAttribute("aria-pressed", index === 0 ? "true" : "false")
      swatch.addEventListener("click", () => {
        color = value
        for (const each of Array.from(colorBox.querySelectorAll(".sw"))) {
          each.classList.remove("active")
          each.setAttribute("aria-pressed", "false")
        }
        swatch.classList.add("active")
        swatch.setAttribute("aria-pressed", "true")
        if (applyStyle({ color: value })) snapshot()
        refocusText()
      })
      colorBox.appendChild(swatch)
    })
    bar.appendChild(colorBox)

    const widthLabel = document.createElement("label")
    const widthText = document.createElement("span")
    widthText.textContent = T("edWidth")
    const widthInput = document.createElement("input")
    widthInput.id = "lw"
    widthInput.type = "range"
    widthInput.min = "1"
    widthInput.max = "12"
    widthInput.value = String(lineWidth)
    widthInput.style.cssText = "width:80px;vertical-align:middle"
    widthInput.addEventListener("input", () => {
      lineWidth = parseInt(widthInput.value, 10) || DEFAULT_LINE_WIDTH
    })
    widthLabel.append(widthText, document.createTextNode(" "), widthInput)
    bar.appendChild(widthLabel)

    // Mosaic cell size: 14 px is too coarse on a small shot and too fine on a 4K
    // one, so it has to be adjustable per capture.
    const cellLabel = document.createElement("label")
    const cellText = document.createElement("span")
    cellText.textContent = T("edMosaicSize")
    const cellInput = document.createElement("input")
    cellInput.id = "ms"
    cellInput.type = "range"
    cellInput.min = "4"
    cellInput.max = "40"
    cellInput.value = String(mosaicCell)
    cellInput.style.cssText = "width:64px;vertical-align:middle"
    cellInput.addEventListener("input", () => {
      mosaicCell = Math.max(4, Math.min(40, parseInt(cellInput.value, 10) || MOSAIC_SIZE))
    })
    cellLabel.append(cellText, document.createTextNode(" "), cellInput)
    bar.appendChild(cellLabel)

    const blurLabel = document.createElement("label")
    const blurText = document.createElement("span")
    blurText.textContent = T("edBlurRadius")
    const blurInput = document.createElement("input")
    blurInput.id = "br"
    blurInput.type = "range"
    blurInput.min = "2"
    blurInput.max = "24"
    blurInput.value = String(blurRadius)
    blurInput.style.cssText = "width:64px;vertical-align:middle"
    blurInput.addEventListener("input", () => {
      blurRadius = Math.max(2, Math.min(24, parseInt(blurInput.value, 10) || DEFAULT_BLUR_RADIUS))
    })
    blurLabel.append(blurText, document.createTextNode(" "), blurInput)
    bar.appendChild(blurLabel)

    const fontLabel = document.createElement("label")
    const fontText = document.createElement("span")
    fontText.textContent = T("edFont")
    const fontInput = document.createElement("input")
    fontInput.id = "fs"
    fontInput.type = "number"
    fontInput.min = "12"
    fontInput.max = "72"
    fontInput.value = String(fontSize)
    fontInput.style.cssText = "width:52px"
    fontInput.addEventListener("input", () => {
      fontSize = Math.max(12, Math.min(72, parseInt(fontInput.value, 10) || DEFAULT_FONT_SIZE))
      applyStyle({ size: fontSize })
    })
    fontInput.addEventListener("change", () => {
      if (selected && selected.type === "text") snapshot()
    })
    fontLabel.append(fontText, document.createTextNode(" "), fontInput)
    bar.appendChild(fontLabel)

    // Text style toggles. Every toggle mirrors into textStyle, which is snapshotted
    // onto each new text shape, so flipping a button never restyles existing text.
    type BoolKey = "bold" | "italic" | "underline" | "outline" | "background"
    const STYLE_KEYS: Array<[BoolKey, string, string, string]> = [
      ["bold", "B", "edBold", "font-weight:700"],
      ["italic", "I", "edItalic", "font-style:italic"],
      ["underline", "U", "edUnderline", "text-decoration:underline"],
      ["outline", "O", "edOutline", "text-shadow:0 0 1px #000,0 0 1px #000,0 0 1px #000"],
      ["background", "▣", "edBackground", ""],
    ]
    const styleGroup = document.createElement("span")
    styleGroup.style.cssText = "display:flex;gap:6px;flex:none"
    bar.appendChild(styleGroup)
    const styleButtons: HTMLButtonElement[] = []
    for (const [key, label, textKey, preview] of STYLE_KEYS) {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = label
      setTip(button, T(textKey))
      button.setAttribute("aria-label", T(textKey))
      button.setAttribute("aria-pressed", textStyle[key] ? "true" : "false")
      button.dataset.style = key
      button.style.cssText = preview ? preview : ""
      if (textStyle[key]) button.classList.add("active")
      button.addEventListener("click", () => {
        // No commitText() here: the live text box must stay open so the change
        // lands on what the user is typing.
        const next = !textStyle[key]
        textStyle[key] = next
        button.classList.toggle("active", next)
        button.setAttribute("aria-pressed", next ? "true" : "false")
        if (applyStyle({ [key]: next } as Partial<Shape>)) snapshot()
        refocusText()
      })
      styleButtons.push(button)
      styleGroup.appendChild(button)
    }

    // Font family
    const familySelect = document.createElement("select")
    familySelect.id = "ff"
    setTip(familySelect, T("edFontFamily"))
    familySelect.setAttribute("aria-label", T("edFontFamily"))
    familySelect.style.cssText =
      "background:#3a3a3a;color:#eee;border:1px solid #555;border-radius:6px;padding:4px 6px;max-width:140px"
    for (const key of ["auto", "serif", "mono", "hand"]) {
      const option = document.createElement("option")
      option.value = key
      option.textContent = T("edFont" + key.charAt(0).toUpperCase() + key.slice(1))
      familySelect.appendChild(option)
    }
    familySelect.value = textStyle.font
    familySelect.addEventListener("change", () => {
      textStyle.font = familySelect.value
      if (applyStyle({ font: textStyle.font })) snapshot()
      refocusText()
    })
    bar.appendChild(familySelect)

    // Alignment
    const ALIGN_KEYS: Array<[Align, string, string]> = [
      ["left", "L", "edAlignLeft"],
      ["center", "C", "edAlignCenter"],
      ["right", "R", "edAlignRight"],
    ]
    const alignGroup = document.createElement("span")
    alignGroup.style.cssText = "display:flex;gap:6px;flex:none"
    bar.appendChild(alignGroup)
    const alignButtons: HTMLButtonElement[] = []
    for (const [value, label, textKey] of ALIGN_KEYS) {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = label
      setTip(button, T(textKey))
      button.setAttribute("aria-label", T(textKey))
      button.dataset.align = value
      button.style.cssText = "min-width:30px"
      const isActive = textStyle.align === value
      button.classList.toggle("active", isActive)
      button.setAttribute("aria-pressed", isActive ? "true" : "false")
      button.addEventListener("click", () => {
        textStyle.align = value
        for (const each of alignButtons) {
          each.classList.remove("active")
          each.setAttribute("aria-pressed", "false")
        }
        button.classList.add("active")
        button.setAttribute("aria-pressed", "true")
        if (applyStyle({ align: value })) snapshot()
        refocusText()
      })
      alignButtons.push(button)
      alignGroup.appendChild(button)
    }

    // Line spacing
    const lineLabel = document.createElement("label")
    const lineText = document.createElement("span")
    lineText.textContent = T("edLineHeight")
    const lineInput = document.createElement("input")
    lineInput.id = "lh"
    lineInput.type = "number"
    lineInput.min = "0.8"
    lineInput.max = "2.5"
    lineInput.step = "0.1"
    lineInput.value = String(textStyle.lineHeight)
    lineInput.style.cssText = "width:58px"
    lineInput.addEventListener("input", () => {
      const next = parseFloat(lineInput.value)
      if (Number.isNaN(next)) return
      textStyle.lineHeight = Math.max(0.8, Math.min(2.5, next))
      applyStyle({ lineHeight: textStyle.lineHeight })
    })
    lineInput.addEventListener("change", () => {
      if (selected && selected.type === "text") snapshot()
    })
    lineLabel.append(lineText, document.createTextNode(" "), lineInput)
    bar.appendChild(lineLabel)

    /** Re-apply the session style to the inline textarea (image px -> CSS px). */
    function refreshTextBox(): void {
      if (!textSession) return
      const rect = over.getBoundingClientRect()
      const sx = rect.width > 0 ? rect.width / over.width : 1
      const sy = rect.height > 0 ? rect.height / over.height : 1
      // Exact size, no legibility floor: the box exists to show what will be
      // committed, and a floor makes the text shrink the moment the user confirms.
      const fontPx = textSession.size * sy
      txtInput.style.fontSize = fontPx + "px"
      txtInput.style.fontFamily = familyStack(textSession.font)
      txtInput.style.fontWeight = textSession.bold ? "700" : "400"
      txtInput.style.fontStyle = textSession.italic ? "italic" : "normal"
      txtInput.style.textDecoration = textSession.underline ? "underline" : "none"
      txtInput.style.color = textSession.color
      txtInput.style.lineHeight = String(textSession.lineHeight)
      txtInput.style.textAlign = textSession.align
      // Shift+Enter adds lines; rows=1 plus overflow:hidden would hide them.
      txtInput.style.whiteSpace = "pre"
      // A textarea defaults to about 20 columns; without an explicit width a long
      // line scrolls out of sight while it is being typed.
      const layout = layoutText({ ...textSession, text: txtInput.value } as Shape)
      const width = Math.min(over.width, Math.max(layout.width, textSession.size)) * sx + 2
      txtInput.style.width = `${Math.ceil(width)}px`
      txtInput.style.height = "auto"
      txtInput.style.height = `${txtInput.scrollHeight}px`
      // Canvas draws with textBaseline "top" at the shape's y, while a CSS line box
      // puts half the leading above the glyphs; without this the text jumps when the
      // box closes.
      const leading = (textSession.lineHeight - 1) * fontPx
      const anchorX =
        textSession.align === "center" ? -layout.width / 2 : textSession.align === "right" ? -layout.width : 0
      txtInput.style.left = `${(textSession.x + anchorX) * sx}px`
      txtInput.style.top = `${textSession.y * sy - leading / 2}px`
    }

    /**
     * Apply a style change everywhere it must land: the live text box the user is
     * typing in, and the selected committed shape. Returns true when a committed
     * shape changed, which is the case that deserves an undo step.
     */
    function applyStyle(patch: Partial<Shape>): boolean {
      if (textSession) {
        Object.assign(textSession, patch)
        refreshTextBox()
      }
      if (selected && selected.type === "text") {
        Object.assign(selected, patch)
        render()
        return true
      }
      return false
    }

    /** Push the selected text's own style back into the toolbar controls. */
    function syncControlsFromText(shape: Shape): void {
      const style = styleOf(shape)
      // Write the shape's style back into the defaults too: otherwise the toolbar
      // shows bold/serif/centre while new text still uses the old defaults.
      textStyle.bold = style.bold
      textStyle.italic = style.italic
      textStyle.underline = style.underline
      textStyle.outline = style.outline
      textStyle.background = style.background
      textStyle.font = style.font
      textStyle.align = style.align
      textStyle.lineHeight = style.lineHeight
      fontSize = style.size
      fontInput.value = String(style.size)
      familySelect.value = style.font
      lineInput.value = String(style.lineHeight)
      color = style.color
      for (const each of Array.from(colorBox.querySelectorAll<HTMLElement>(".sw"))) {
        const active = each.dataset.color === style.color
        each.classList.toggle("active", active)
        each.setAttribute("aria-pressed", active ? "true" : "false")
      }
      for (const each of styleButtons) {
        const key = each.dataset.style as BoolKey | undefined
        const on = key ? style[key] : false
        each.classList.toggle("active", on)
        each.setAttribute("aria-pressed", on ? "true" : "false")
      }
      for (const each of alignButtons) {
        const active = each.dataset.align === style.align
        each.classList.toggle("active", active)
        each.setAttribute("aria-pressed", active ? "true" : "false")
      }
    }

    // Only the properties that actually affect the active tool stay on the bar.
    // Before this, 20+ controls were visible at once and most of them did nothing.
    function syncContext(): void {
      const lineTools: Tool[] = ["rect", "ellipse", "line", "arrow", "brush", "eraser"]
      widthLabel.style.display = lineTools.includes(tool) ? "" : "none"
      cellLabel.style.display = tool === "mosaic" ? "" : "none"
      blurLabel.style.display = tool === "blur" ? "" : "none"
      const isText = tool === "text"
      // Markers size their circle from the font size, so the same field stays
      // visible there and is relabelled instead of leaving the tool with no
      // adjustable property at all.
      const showSize = isText || tool === "marker"
      fontLabel.style.display = showSize ? "" : "none"
      fontText.textContent = tool === "marker" ? T("edMarkerSize") : T("edFont")
      familySelect.style.display = isText ? "" : "none"
      lineLabel.style.display = isText ? "" : "none"
      for (const each of styleButtons) each.style.display = isText ? "" : "none"
      for (const each of alignButtons) each.style.display = isText ? "" : "none"
      // Mosaic, blur, eraser and crop never read the colour, so the palette only
      // eats 270 px in tools that ignore it.
      const usesColor = tool !== "mosaic" && tool !== "blur" && tool !== "eraser" && tool !== "crop"
      colorBox.style.display = usesColor ? "" : "none"
      // The bar may have gained or lost a row, which changes the room the picture
      // has; without this the bottom of the image is clipped until a window resize.
      fit()
    }

    const undoButton = document.createElement("button")
    undoButton.type = "button"
    undoButton.id = "undo"
    undoButton.textContent = T("edUndo")
    undoButton.disabled = true
    undoButton.addEventListener("click", undo)
    bar.appendChild(undoButton)

    const redoButton = document.createElement("button")
    redoButton.type = "button"
    redoButton.id = "redo"
    redoButton.textContent = T("edRedo")
    redoButton.disabled = true
    redoButton.addEventListener("click", redo)
    bar.appendChild(redoButton)

    // Group the history buttons so the auto margin cannot split them across the
    // wrap boundary of the flex bar.
    const historyGroup = document.createElement("span")
    historyGroup.style.cssText = "margin-left:auto;display:flex;gap:6px;flex:none"
    historyGroup.append(undoButton, redoButton)
    bar.appendChild(historyGroup)
    // Frameless window: the OS draws no title bar to measure, so keep the group
    // clear of the window controls in the corner.
    if (!options.framed && frameTop <= 0) historyGroup.style.marginRight = `${WINDOW_CONTROLS_GUTTER}px`

    syncContext()

    // ---- footer ------------------------------------------------------------

    const openButton = document.createElement("button")
    openButton.type = "button"
    openButton.id = "openFile"
    openButton.textContent = T("edOpen")
    openButton.style.marginRight = "auto"
    openButton.addEventListener("click", () => {
      // load() resets the shapes and the undo stack, so this is not recoverable.
      if (!hasWork()) {
        fileInput.click()
        return
      }
      confirmThen("open", "edDiscardAsk", () => fileInput.click())
    })

    const saveButton = document.createElement("button")
    saveButton.type = "button"
    saveButton.id = "save"
    saveButton.textContent = T("edSave")

    const copyButton = document.createElement("button")
    copyButton.type = "button"
    copyButton.id = "copy"
    copyButton.textContent = T("edCopy")

    const cancelButton = document.createElement("button")
    cancelButton.type = "button"
    cancelButton.id = "cancel"
    cancelButton.textContent = T("edCancel")
    // The window's own close button is right above the overlay; naming the keyboard
    // way out keeps users from leaving the app instead of the editor.
    setTip(cancelButton, T("edCancelShot") + " (Esc)")
    cancelButton.addEventListener("click", () => requestCancel(false))

    const okButton = document.createElement("button")
    okButton.type = "button"
    okButton.id = "ok"
    okButton.textContent = T("edConfirm")
    setTip(okButton, T("edConfirm") + " (Enter)")
    okButton.addEventListener("click", () => done(true))

    foot.append(openButton, saveButton, copyButton, cancelButton, okButton)

    // ---- state helpers -----------------------------------------------------

    // Undo works on full snapshots rather than per-shape deltas: dragging a shape
    // and editing text in place must each be one undoable step, which a delta stack
    // cannot express without instrumenting every mutation site.
    type SnapshotState = { shapes: Shape[]; crop: { x: number; y: number; w: number; h: number } | null }
    let snapshots: string[] = [JSON.stringify({ shapes: [], crop: null } as SnapshotState)]
    let snapshotBytes = snapshots[0].length
    let snapIndex = 0

    function syncUndoRedo(): void {
      const canUndo = snapIndex > 0
      const canRedo = snapIndex < snapshots.length - 1
      undoButton.disabled = !canUndo
      undoButton.setAttribute("aria-disabled", canUndo ? "false" : "true")
      redoButton.disabled = !canRedo
      redoButton.setAttribute("aria-disabled", canRedo ? "false" : "true")
    }

    /** Record the current shapes as a new history step. */
    function snapshot(): void {
      // Dropping the redo tail also drops its bytes.
      for (let index = snapIndex + 1; index < snapshots.length; index += 1) snapshotBytes -= snapshots[index].length
      snapshots = snapshots.slice(0, snapIndex + 1)
      const entry = JSON.stringify({ shapes, crop: cropRect } as SnapshotState)
      snapshots.push(entry)
      snapshotBytes += entry.length
      snapIndex = snapshots.length - 1
      // Cap by bytes too: a mosaic stroke carries a colour per point, so sixty
      // copies of a few large strokes reach hundreds of megabytes.
      while (snapshots.length > MAX_SNAPSHOTS || (snapshotBytes > MAX_SNAPSHOT_BYTES && snapshots.length > 1)) {
        const dropped = snapshots.shift() ?? ""
        snapshotBytes -= dropped.length
        snapIndex -= 1
      }
      syncUndoRedo()
    }

    function applySnapshot(): void {
      const parsed = JSON.parse(snapshots[snapIndex]) as SnapshotState
      shapes.length = 0
      for (const shape of parsed.shapes) shapes.push(shape)
      cropRect = parsed.crop
      selected = null
      // The rebuilt array holds fresh objects; a drag started before the undo
      // would keep mutating an orphan that is no longer rendered.
      dragShape = null
      render()
      syncUndoRedo()
    }

    function pushShape(shape: Shape): void {
      shapes.push(shape)
      render()
      snapshot()
    }

    function undo(): void {
      commitText()
      if (drawing) return
      if (snapIndex <= 0) return
      snapIndex -= 1
      applySnapshot()
    }

    function redo(): void {
      commitText()
      if (drawing) return
      if (snapIndex >= snapshots.length - 1) return
      snapIndex += 1
      applySnapshot()
    }

    // window.confirm is not guaranteed to be available in this host: an embedded
    // overlay may have dialogs disabled, where confirm() returns false forever and
    // the cancel button would stop working. The confirmation is done in the page:
    // the first press warns, a second press of the same control goes through.
    let armed: { kind: string; run: () => void; timer: number; at: number; token: number } | null = null
    /** Timer for the window-close question; declared here so disarm can clear it. */
    let closeTimer = 0
    /** The hint generation the close question belongs to. */
    let closeArmedToken = 0
    /** When the window-close question was last asked; cleared with the other hints. */
    let closeArmedAt = 0
    /** Who owns the current hint: a confirmation, or a message that must persist. */
    let hintOwner: "note" | "arm" = "note"
    /** Bumped on every hint so a stale timer cannot clear a newer one. */
    let hintToken = 0
    function disarm(): void {
      if (armed) {
        clearTimeout(armed.timer)
        armed = null
      }
      clearTimeout(closeTimer)
      closeArmedAt = 0
      // Only the confirmation's own message is ours to remove.
      if (hintOwner === "arm") clearHint()
    }
    function clearHint(token?: number): void {
      // A timer that belongs to a replaced message leaves the new one alone.
      if (token !== undefined && token !== hintToken) return
      hint.textContent = ""
      hint.style.display = "none"
      hintOwner = "note"
    }
    function confirmThen(kind: string, key: string, run: () => void, cooldown = 0): void {
      if (armed?.kind === kind && armed.token === hintToken) {
        // The Esc ladder unwinds one layer per press; a fast second press must not
        // read as "yes, discard". A second press of a button is deliberate, so it is
        // not subject to the cooldown.
        if (cooldown > 0 && Date.now() - armed.at < cooldown) return
        const action = armed.run
        clearTimeout(armed.timer)
        armed = null
        if (hintOwner === "arm") clearHint()
        action()
        return
      }
      disarm()
      setHint(T(key), "arm")
      const token = hintToken
      armed = {
        kind,
        at: Date.now(),
        run,
        token,
        timer: window.setTimeout(() => {
          armed = null
          clearHint(token)
        }, CONFIRM_WINDOW_MS),
      }
    }

    /** Keeps the caret in the text box when a toolbar control is clicked. */
    function refocusText(): void {
      if (!textSession) return
      try {
        txtInput.focus()
      } catch {}
    }

    function setHint(text: string, owner: "note" | "arm" = "note"): void {
      hintOwner = owner
      hintToken += 1
      hint.textContent = text
      // load() hides the hint once an image is ready; without restoring the
      // display here, later failures would be reported into a hidden node.
      hint.style.display = ""
    }

    // One timer per element so overlapping flashes cannot capture "Saved" as the
    // label to restore and leave the button stuck showing it forever.
    const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

    function flash(element: HTMLElement, text: string): void {
      if (!element.dataset.label) element.dataset.label = element.textContent ?? ""
      const pending = flashTimers.get(element)
      if (pending !== undefined) clearTimeout(pending)
      element.textContent = text
      flashTimers.set(
        element,
        setTimeout(() => {
          element.textContent = element.dataset.label ?? ""
          flashTimers.delete(element)
        }, FLASH_MS),
      )
    }

    // ---- drawing -----------------------------------------------------------

    function strokeStyle(shape: Shape): void {
      if (!octx) return
      octx.strokeStyle = shape.color ?? color
      octx.lineWidth = shape.width ?? lineWidth
      octx.lineCap = "round"
      octx.lineJoin = "round"
    }

    // The two barbs sit ±0.42 rad (about ±24°) off the shaft axis: wide enough to
    // read as an arrow at a glance, narrow enough not to look like a spike.
    function drawArrowHead(x: number, y: number, angle: number, size: number, fill: string): void {
      if (!octx) return
      octx.fillStyle = fill
      octx.beginPath()
      octx.moveTo(x, y)
      octx.lineTo(x - size * Math.cos(angle - 0.42), y - size * Math.sin(angle - 0.42))
      octx.lineTo(x - size * Math.cos(angle + 0.42), y - size * Math.sin(angle + 0.42))
      octx.closePath()
      octx.fill()
    }

    /** Average colour of the photo under one mosaic cell, or null off-canvas. */
    function mosaicAverage(x: number, y: number, size: number): string | null {
      const half = Math.floor(size / 2)
      try {
        const sx = Math.max(0, x - half)
        const sy = Math.max(0, y - half)
        const w = Math.min(size, base.width - sx)
        const h = Math.min(size, base.height - sy)
        if (w <= 0 || h <= 0) return null
        const data = bctx.getImageData(sx, sy, w, h)
        let r = 0
        let g = 0
        let b = 0
        const n = data.data.length / 4
        for (let i = 0; i < data.data.length; i += 4) {
          r += data.data[i]
          g += data.data[i + 1]
          b += data.data[i + 2]
        }
        return `rgb(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0})`
      } catch {
        return null
      }
    }

    /**
     * Sample every cell once, when the stroke ends. Redrawing afterwards (drag,
     * select, undo) replays the cached colours instead of re-reading 4K pixels
     * for every point on every frame.
     */
    function bakeMosaic(shape: Shape): void {
      if (shape.type !== "mosaic" || !shape.pts) return
      const size = shape.size ?? mosaicCell
      const cells: Array<[number, number, string]> = []
      for (const [x, y] of shape.pts) {
        const colour = mosaicAverage(x, y, size)
        if (colour) cells.push([x, y, colour])
      }
      shape.cells = cells
    }

    /** Averages the photo under the square, then paints the flat block on the annotation layer. */
    function drawMosaicPoint(x: number, y: number, size: number): void {
      if (!octx) return
      const colour = mosaicAverage(x, y, size)
      if (!colour) return
      const half = Math.floor(size / 2)
      octx.fillStyle = colour
      octx.fillRect(x - half, y - half, size, size)
    }

    /** Resolved style for a shape: its own values win, textStyle fills the gaps. */
    function styleOf(shape?: Shape): TextStyle {
      return {
        color: shape?.color ?? color,
        size: shape?.size ?? fontSize,
        bold: shape?.bold ?? textStyle.bold,
        italic: shape?.italic ?? textStyle.italic,
        underline: shape?.underline ?? textStyle.underline,
        font: shape?.font ?? textStyle.font,
        align: shape?.align ?? textStyle.align,
        lineHeight: shape?.lineHeight ?? textStyle.lineHeight,
        outline: shape?.outline ?? textStyle.outline,
        background: shape?.background ?? textStyle.background,
      }
    }

    type TextLayout = {
      lines: string[]
      widths: number[]
      width: number
      height: number
      size: number
      lineHeight: number
      align: Align
    }

    function layoutText(shape: Shape): TextLayout {
      const style = styleOf(shape)
      // Canvas font shorthand order: style, variant, weight, stretch, size, family.
      octx.font = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${style.size}px ${familyStack(style.font)}`
      const lines = String(shape.text ?? "").split("\n")
      const lineHeight = Math.max(1, Math.round(style.size * style.lineHeight))
      const widths = lines.map((line) => octx.measureText(line).width)
      // Math.max(...widths) throws once the array is large enough to blow the
      // argument limit, and a paste can make it that large.
      let widest = 0
      for (const value of widths) if (value > widest) widest = value
      return {
        lines,
        widths,
        width: widest,
        height: lines.length * lineHeight,
        size: style.size,
        lineHeight,
        align: style.align,
      }
    }

    /** Left edge of the text block for the current alignment. */
    function textLeft(shape: Shape, layout: TextLayout): number {
      const anchor = shape.x ?? 0
      if (layout.align === "center") return anchor - layout.width / 2
      if (layout.align === "right") return anchor - layout.width
      return anchor
    }

    function drawTextShape(shape: Shape): void {
      const style = styleOf(shape)
      const layout = layoutText(shape)
      const left = textLeft(shape, layout)
      const top = shape.y ?? 0

      if (style.background) {
        // A block 0.2 × font size around the text: enough to separate it from the
        // photo without turning into a panel.
        const pad = Math.round(layout.size * 0.2)
        octx.fillStyle = "rgba(0,0,0,0.55)"
        octx.fillRect(left - pad, top - pad, layout.width + pad * 2, layout.height + pad)
      }

      octx.fillStyle = style.color
      octx.textBaseline = "top"
      octx.textAlign = "left"
      // Canvas has no text-decoration, so the underline is measured off the font
      // size: 1/12 down from the baseline box, 1/14 thick, never sub-pixel.
      const underlineOffset = Math.max(1, Math.round(layout.size / 12))
      const underlineThickness = Math.max(1, Math.round(layout.size / 14))

      for (let index = 0; index < layout.lines.length; index += 1) {
        const line = layout.lines[index]
        const lineY = top + index * layout.lineHeight
        // Align each line inside the block. Drawing every line from the block's
        // left edge would make centred and right-aligned text look left-aligned.
        const slack = layout.width - layout.widths[index]
        const lineX =
          left + (layout.align === "center" ? slack / 2 : layout.align === "right" ? slack : 0)
        if (style.outline) {
          octx.strokeStyle = contrastFor(style.color)
          // An eighth of the font size, floor 2: thick enough to separate the fill
          // from a busy background, thin enough to keep the letter shapes.
          octx.lineWidth = Math.max(2, Math.round(layout.size / 8))
          octx.lineJoin = "round"
          octx.strokeText(line, lineX, lineY)
        }
        octx.fillText(line, lineX, lineY)
        if (style.underline) {
          octx.fillRect(lineX, lineY + layout.size + underlineOffset, layout.widths[index], underlineThickness)
        }
      }
    }

    function textBounds(shape: Shape): { x: number; y: number; w: number; h: number } {
      const layout = layoutText(shape)
      return { x: textLeft(shape, layout), y: shape.y ?? 0, w: layout.width, h: layout.height }
    }

    /** Axis-aligned bounds of any shape, used for selection and dragging. */
    function shapeBounds(shape: Shape): { x: number; y: number; w: number; h: number } {
      if (shape.type === "text") return textBounds(shape)
      if (shape.type === "rect" || shape.type === "ellipse" || shape.type === "blur") {
        return { x: shape.x ?? 0, y: shape.y ?? 0, w: shape.w ?? 0, h: shape.h ?? 0 }
      }
      if (shape.type === "marker") {
        const radius = shape.size ?? 16
        return { x: (shape.x ?? 0) - radius, y: (shape.y ?? 0) - radius, w: radius * 2, h: radius * 2 }
      }
      if (shape.type === "line" || shape.type === "arrow") {
        const x1 = shape.x1 ?? 0
        const y1 = shape.y1 ?? 0
        const x2 = shape.x2 ?? 0
        const y2 = shape.y2 ?? 0
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
      }
      const pts = shape.pts ?? []
      if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [px, py] of pts) {
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }

    function pointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
      const dx = x2 - x1
      const dy = y2 - y1
      const len2 = dx * dx + dy * dy
      if (len2 === 0) return Math.hypot(px - x1, py - y1)
      let t = ((px - x1) * dx + (py - y1) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
    }

    /** Pixels of image space per screen pixel, so hit slop and chrome stay constant on screen. */
    function imageScale(): number {
      const rect = over.getBoundingClientRect()
      return rect.width > 0 ? over.width / rect.width : 1
    }

    /** Topmost shape under the point, for selecting, dragging and double-click editing. */
    function hitShape(point: { x: number; y: number }): Shape | null {
      // imageScale() is image-px per screen-px, so a constant screen slop must be
      // multiplied: at 3.2x downscale, 8 screen px is 25.6 image px.
      const tolerance = HIT_SLOP * imageScale()
      for (let index = shapes.length - 1; index >= 0; index -= 1) {
        const shape = shapes[index]
        const stroke = shape.width ?? lineWidth
        const reach = tolerance + stroke / 2
        if (shape.type === "text") {
          const box = textBounds(shape)
          if (
            point.x >= box.x - tolerance &&
            point.x <= box.x + box.w + tolerance &&
            point.y >= box.y - tolerance &&
            point.y <= box.y + box.h + tolerance
          ) {
            return shape
          }
          continue
        }
        if (shape.type === "marker") {
          const radius = (shape.size ?? 16) + tolerance
          if (Math.hypot(point.x - (shape.x ?? 0), point.y - (shape.y ?? 0)) <= radius) return shape
          continue
        }
        if (shape.type === "blur") {
          const box = shapeBounds(shape)
          if (
            point.x >= box.x &&
            point.x <= box.x + box.w &&
            point.y >= box.y &&
            point.y <= box.y + box.h
          ) {
            return shape
          }
          continue
        }
        if (shape.type === "rect") {
          const x = shape.x ?? 0
          const y = shape.y ?? 0
          const w = shape.w ?? 0
          const h = shape.h ?? 0
          const nearVertical =
            Math.abs(point.x - x) <= reach || Math.abs(point.x - (x + w)) <= reach
          const nearHorizontal =
            Math.abs(point.y - y) <= reach || Math.abs(point.y - (y + h)) <= reach
          const withinX = point.x >= x - tolerance && point.x <= x + w + tolerance
          const withinY = point.y >= y - tolerance && point.y <= y + h + tolerance
          if ((nearVertical && withinY) || (nearHorizontal && withinX)) return shape
          continue
        }
        if (shape.type === "ellipse") {
          const cx = (shape.x ?? 0) + (shape.w ?? 0) / 2
          const cy = (shape.y ?? 0) + (shape.h ?? 0) / 2
          const rx = Math.abs(shape.w ?? 0) / 2 || 1
          const ry = Math.abs(shape.h ?? 0) / 2 || 1
          // Approximate distance to the curve: |f| / |grad f| with
          // f = (dx/rx)² + (dy/ry)² − 1. Scaling by min(rx, ry) instead would
          // inflate the tolerance along the long axis of a flat ellipse.
          const dx = point.x - cx
          const dy = point.y - cy
          const f = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) - 1
          const gx = (2 * dx) / (rx * rx)
          const gy = (2 * dy) / (ry * ry)
          const grad = Math.hypot(gx, gy)
          const ring = grad > 1e-6 ? Math.abs(f) / grad : Math.abs(Math.hypot(dx, dy) - Math.min(rx, ry))
          if (ring <= reach) return shape
          continue
        }
        if (shape.type === "line" || shape.type === "arrow") {
          const distance = pointToSegment(
            point.x,
            point.y,
            shape.x1 ?? 0,
            shape.y1 ?? 0,
            shape.x2 ?? 0,
            shape.y2 ?? 0,
          )
          if (distance <= reach) return shape
          continue
        }
        const pts = shape.pts ?? []
        const brushReach = shape.type === "eraser" ? stroke * 1.5 + tolerance : stroke + tolerance
        for (const [px, py] of pts) {
          if (Math.hypot(point.x - px, point.y - py) <= brushReach) return shape
        }
      }
      return null
    }

    /** Move a shape by a delta measured from its state when the drag started. */
    function applyDelta(shape: Shape, orig: Shape, dx: number, dy: number): void {
      if (
        orig.type === "rect" ||
        orig.type === "ellipse" ||
        orig.type === "blur" ||
        orig.type === "marker" ||
        orig.type === "text"
      ) {
        shape.x = (orig.x ?? 0) + dx
        shape.y = (orig.y ?? 0) + dy
        return
      }
      if (orig.type === "line" || orig.type === "arrow") {
        shape.x1 = (orig.x1 ?? 0) + dx
        shape.y1 = (orig.y1 ?? 0) + dy
        shape.x2 = (orig.x2 ?? 0) + dx
        shape.y2 = (orig.y2 ?? 0) + dy
        return
      }
      // Freehand shapes store absolute points, and a mosaic also carries the
      // colours baked for them: both have to move together or the blocks stay at
      // the old position while the selection box follows the pointer.
      shape.pts = (orig.pts ?? []).map(([px, py]) => [px + dx, py + dy] as Point)
      if (orig.cells) {
        shape.cells = orig.cells.map(([cx, cy, colour]) => [cx + dx, cy + dy, colour] as [number, number, string])
      }
    }

    function drawSelection(shape: Shape): void {
      const box = shapeBounds(shape)
      // 4 image px of air between the shape and its dashed box.
      const pad = 4
      octx.save()
      octx.strokeStyle = "#0b6bcb"
      // One image px per screen px, floored at 1: a hairline on a downscaled shot.
      octx.lineWidth = Math.max(1, imageScale())
      octx.setLineDash([4, 3])
      octx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2)
      octx.restore()
    }

    function drawShape(shape: Shape): void {
      if (!octx) return
      if (shape.type === "brush") {
        const pts = shape.pts ?? []
        strokeStyle(shape)
        if (pts.length === 1) {
          octx.fillStyle = shape.color ?? color
          octx.beginPath()
          octx.arc(pts[0][0], pts[0][1], (shape.width ?? lineWidth) / 2, 0, Math.PI * 2)
          octx.fill()
          return
        }
        octx.beginPath()
        pts.forEach(([x, y], index) => {
          if (index === 0) octx.moveTo(x, y)
          else octx.lineTo(x, y)
        })
        octx.stroke()
      } else if (shape.type === "eraser") {
        const pts = shape.pts ?? []
        octx.save()
        octx.globalCompositeOperation = "destination-out"
        if (pts.length === 1) {
          octx.beginPath()
          octx.arc(pts[0][0], pts[0][1], ((shape.width ?? lineWidth) * 3) / 2, 0, Math.PI * 2)
          octx.fill()
          octx.restore()
          return
        }
        octx.lineWidth = (shape.width ?? lineWidth) * 3
        octx.lineCap = "round"
        octx.lineJoin = "round"
        octx.beginPath()
        pts.forEach(([x, y], index) => {
          if (index === 0) octx.moveTo(x, y)
          else octx.lineTo(x, y)
        })
        octx.stroke()
        octx.restore()
      } else if (shape.type === "mosaic") {
        const size = shape.size ?? mosaicCell
        const half = Math.floor(size / 2)
        if (shape.cells) {
          for (const [x, y, colour] of shape.cells) {
            octx.fillStyle = colour
            octx.fillRect(x - half, y - half, size, size)
          }
        } else {
          for (const [x, y] of shape.pts ?? []) drawMosaicPoint(x, y, size)
        }
      } else if (shape.type === "blur") {
        const x = shape.x ?? 0
        const y = shape.y ?? 0
        const w = shape.w ?? 0
        const h = shape.h ?? 0
        if (w < 1 || h < 1) return
        const radius = Math.max(1, shape.size ?? blurRadius)
        // A CSS blur bleeds about three radii past its edge, so the sampled
        // neighbourhood is padded by that much before clipping to the rectangle.
        const pad = radius * 3
        octx.save()
        octx.beginPath()
        octx.rect(x, y, w, h)
        octx.clip()
        // Only repaint the neighbourhood: blurring the whole 4K bitmap for a small
        // patch costs ~50-100 ms per frame during a drag.
        const sx = Math.max(0, x - pad)
        const sy = Math.max(0, y - pad)
        const sw = Math.min(base.width - sx, w + pad * 2)
        const sh = Math.min(base.height - sy, h + pad * 2)
        if (sw > 0 && sh > 0) {
          // Sample what is actually underneath, not the untouched photo: a mosaic
          // drawn earlier must not reappear through a blur placed on top of it.
          if (!blurSource) blurSource = document.createElement("canvas")
          if (blurSource.width < sw || blurSource.height < sh) {
            blurSource.width = Math.max(blurSource.width, sw)
            blurSource.height = Math.max(blurSource.height, sh)
          }
          const source = blurSource.getContext("2d")
          if (source) {
            source.clearRect(0, 0, sw, sh)
            source.drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh)
            source.drawImage(over, sx, sy, sw, sh, 0, 0, sw, sh)
            octx.filter = `blur(${radius}px)`
            octx.drawImage(blurSource, 0, 0, sw, sh, sx, sy, sw, sh)
            octx.filter = "none"
          }
        }
        octx.restore()
      } else if (shape.type === "crop") {
        octx.save()
        octx.strokeStyle = "#0b6bcb"
        octx.lineWidth = Math.max(1, imageScale())
        octx.setLineDash([5, 4])
        octx.strokeRect(shape.x ?? 0, shape.y ?? 0, shape.w ?? 0, shape.h ?? 0)
        octx.restore()
      } else if (shape.type === "marker") {
        const cx = shape.x ?? 0
        const cy = shape.y ?? 0
        const radius = shape.size ?? 16
        const fill = shape.color ?? color
        octx.save()
        octx.fillStyle = fill
        octx.beginPath()
        octx.arc(cx, cy, radius, 0, Math.PI * 2)
        octx.fill()
        octx.fillStyle = contrastFor(fill)
        // 1.15 × radius keeps the digit inside the circle at every size.
        octx.font = `bold ${Math.round(radius * 1.15)}px system-ui,"Microsoft YaHei",sans-serif`
        octx.textAlign = "center"
        octx.textBaseline = "middle"
        octx.fillText(String(shape.text ?? ""), cx, cy)
        octx.restore()
      } else if (shape.type === "rect") {
        strokeStyle(shape)
        octx.strokeRect(shape.x ?? 0, shape.y ?? 0, shape.w ?? 0, shape.h ?? 0)
      } else if (shape.type === "ellipse") {
        strokeStyle(shape)
        octx.beginPath()
        octx.ellipse(
          (shape.x ?? 0) + (shape.w ?? 0) / 2,
          (shape.y ?? 0) + (shape.h ?? 0) / 2,
          Math.abs(shape.w ?? 0) / 2,
          Math.abs(shape.h ?? 0) / 2,
          0,
          0,
          Math.PI * 2,
        )
        octx.stroke()
      } else if (shape.type === "line") {
        strokeStyle(shape)
        octx.beginPath()
        octx.moveTo(shape.x1 ?? 0, shape.y1 ?? 0)
        octx.lineTo(shape.x2 ?? 0, shape.y2 ?? 0)
        octx.stroke()
      } else if (shape.type === "arrow") {
        strokeStyle(shape)
        const angle = Math.atan2((shape.y2 ?? 0) - (shape.y1 ?? 0), (shape.x2 ?? 0) - (shape.x1 ?? 0))
        octx.beginPath()
        octx.moveTo(shape.x1 ?? 0, shape.y1 ?? 0)
        octx.lineTo(shape.x2 ?? 0, shape.y2 ?? 0)
        octx.stroke()
        drawArrowHead(
          shape.x2 ?? 0,
          shape.y2 ?? 0,
          angle,
          Math.max(ARROW_HEAD_MIN_LENGTH, (shape.width ?? lineWidth) * ARROW_HEAD_WIDTH_RATIO),
          shape.color ?? color,
        )
      } else if (shape.type === "text") {
        drawTextShape(shape)
      }
    }

    function drawCropOverlay(): void {
      if (!cropRect || exporting) return
      const { x, y, w, h } = cropRect
      octx.save()
      octx.fillStyle = "rgba(0,0,0,0.35)"
      if (y > 0) octx.fillRect(0, 0, over.width, y)
      if (y + h < over.height) octx.fillRect(0, y + h, over.width, over.height - y - h)
      if (x > 0) octx.fillRect(0, y, x, h)
      if (x + w < over.width) octx.fillRect(x + w, y, over.width - x - w, h)
      octx.strokeStyle = "#0b6bcb"
      octx.lineWidth = Math.max(1, imageScale())
      octx.setLineDash([5, 4])
      octx.strokeRect(x, y, w, h)
      octx.restore()
    }

    function render(): void {
      octx.clearRect(0, 0, over.width, over.height)
      for (const shape of shapes) {
        if (shape === hiddenShape) continue
        drawShape(shape)
      }
      if (drawing && drawing.preview) drawShape(drawing.preview)
      drawCropOverlay()
      if (selected) drawSelection(selected)
    }

    function position(event: MouseEvent): { x: number; y: number } {
      const rect = over.getBoundingClientRect()
      const sx = rect.width > 0 ? over.width / rect.width : 1
      const sy = rect.height > 0 ? over.height / rect.height : 1
      // Clamp: a pointer on the very edge can round to width/height, which leaves a
      // one-pixel transparent strip after the crop.
      return {
        x: Math.min(over.width, Math.max(0, Math.round((event.clientX - rect.left) * sx))),
        y: Math.min(over.height, Math.max(0, Math.round((event.clientY - rect.top) * sy))),
      }
    }

    function buildShape(kind: Tool, a: { x: number; y: number }, b: { x: number; y: number }): Shape {
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      if (kind === "rect") return { type: "rect", x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), color, width: lineWidth }
      if (kind === "crop")
        return { type: "crop", x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
      if (kind === "blur")
        return { type: "blur", x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), size: blurRadius }
      if (kind === "ellipse")
        return { type: "ellipse", x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), color, width: lineWidth }
      if (kind === "line") return { type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, width: lineWidth }
      return { type: "arrow", x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, width: lineWidth }
    }

    /** Freehand tools paint only the new segment so a long drag stays cheap. */
    function drawStrokeDelta(state: Drawing): void {
      const pts = state.pts ?? []
      const from = state.drawn || 0
      if (pts.length <= from) return
      if (state.tool === "brush" || state.tool === "eraser") {
        const slice = pts.slice(Math.max(0, from - 1))
        const segment: Shape = { type: state.tool, pts: slice, color, width: lineWidth }
        if (slice.length === 1) segment.pts = [slice[0], [slice[0][0] + 0.5, slice[0][1]]]
        drawShape(segment)
      } else if (state.tool === "mosaic") {
        drawShape({ type: "mosaic", pts: pts.slice(from), size: mosaicCell })
      }
      state.drawn = pts.length
    }

    // ---- text --------------------------------------------------------------

    function startText(point: { x: number; y: number }, existing?: Shape): void {
      commitText()
      const style = styleOf(existing)
      const rect = over.getBoundingClientRect()
      const sx = rect.width / over.width
      const sy = rect.height / over.height
      txtInput.style.display = "block"
      txtInput.style.left = point.x * sx + "px"
      txtInput.style.top = point.y * sy + "px"
      txtInput.value = existing?.text ?? ""
      // The shape stays in the list so a cancelled edit restores it, but drawing it
      // under a transparent textarea would show every glyph twice.
      hiddenShape = existing ?? null
      // Without a repaint the old glyphs stay on the canvas under the textarea and
      // every character appears twice.
      render()
      textSession = { ...style, x: point.x, y: point.y }
      // One code path for the textarea styling, so a toolbar change while typing
      // and the initial open always look the same.
      refreshTextBox()
      setTimeout(() => txtInput.focus(), 0)
    }

    function commitText(): void {
      if (!textSession) return
      // maxLength does not stop a paste in every browser path, so clamp again.
      const value = txtInput.value.slice(0, MAX_TEXT_CHARS)
      txtInput.style.display = "none"
      txtInput.value = ""
      hiddenShape = null
      const session = textSession
      textSession = null
      const editAt = editingShape ? shapes.indexOf(editingShape) : -1
      editingShape = null
      try {
        over.focus()
      } catch {
        // focus is best effort
      }
      if (!value || !value.trim()) {
        // Empty edit: an existing shape was never removed, so repaint and keep it.
        render()
        return
      }
      const shape: Shape = {
        type: "text",
        x: session.x,
        y: session.y,
        text: value,
        color: session.color,
        size: session.size,
        bold: session.bold,
        italic: session.italic,
        underline: session.underline,
        font: session.font,
        align: session.align,
        lineHeight: session.lineHeight,
        outline: session.outline,
        background: session.background,
      }
      if (editAt >= 0 && editAt < shapes.length) {
        shapes[editAt] = shape
        render()
        snapshot()
      } else {
        pushShape(shape)
      }
    }

    txtInput.addEventListener("keydown", (event) => {
      if (event.isComposing) return
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        commitText()
      }
      if (event.key === "Escape") {
        textSession = null
        editingShape = null
        hiddenShape = null
        txtInput.style.display = "none"
        txtInput.value = ""
        render()
      }
      event.stopPropagation()
    })
    // Without this the box only matches its first character: width and height
    // would stay frozen while the user keeps typing.
    txtInput.addEventListener("input", () => refreshTextBox())

    // ---- mouse -------------------------------------------------------------

    over.addEventListener("mousedown", (event) => {
      disarm()
      if (!imgW || finished) return
      if (event.button !== 0) return
      commitText()
      const point = position(event)

      // Clicking an existing annotation selects it and starts a drag, whatever
      // tool is active; clicking empty space clears the selection.
      // Eraser and crop exist to act on top of existing annotations, so the hit
      // test must not swallow them. Alt forces a new shape for every other tool.
      const bypassHit = tool === "eraser" || tool === "crop" || event.altKey
      const hit = bypassHit ? null : hitShape(point)
      if (hit) {
        selected = hit
        // Show the selected text's own style in the toolbar so the controls act
        // on what the user is looking at, not on the defaults for new text.
        if (hit.type === "text") syncControlsFromText(hit)
        dragShape = {
          shape: hit,
          orig: JSON.parse(JSON.stringify(hit)) as Shape,
          startX: point.x,
          startY: point.y,
          moved: false,
        }
        render()
        return
      }
      if (selected) {
        selected = null
        render()
      }

      if (tool === "text") {
        startText(point)
        return
      }
      if (tool === "marker") {
        const radius = Math.max(MARKER_MIN_RADIUS, Math.round(fontSize * MARKER_RADIUS_RATIO))
        pushShape({
          type: "marker",
          x: point.x,
          y: point.y,
          text: String(markerCounter),
          color,
          size: radius,
        })
        markerCounter += 1
        return
      }
      drawing = {
        tool,
        start: point,
        cur: point,
        preview: null,
        drawn: 0,
        pts: tool === "brush" || tool === "mosaic" || tool === "eraser" ? [[point.x, point.y]] : null,
      }
    })

    // Double-click a text block to reopen it with its own styling and content.
    // The shape stays in the list until the edit commits, so cancelling with Esc
    // restores the original instead of deleting it.
    over.addEventListener("dblclick", (event) => {
      if (!imgW || finished) return
      const point = position(event)
      const hit = hitShape(point)
      if (!hit || hit.type !== "text") return
      selected = null
      editingShape = hit
      startText({ x: hit.x ?? 0, y: hit.y ?? 0 }, hit)
    })

    over.addEventListener("mousemove", (event) => {
      if (dragShape) {
        // A mouseup lost outside the window would otherwise leave the shape glued
        // to the pointer until the next click.
        if (event.buttons === 0) {
          // The mouseup landed outside the window.
          finishDrag()
          return
        }
        const point = position(event)
        const dx = point.x - dragShape.startX
        const dy = point.y - dragShape.startY
        // The same threshold a new shape uses. Without it, a click that only selects
        // an existing shape nudges it by the pointer jitter (several image pixels on
        // a downscaled view) and records an undo step that just moves it back.
        if (!dragShape.moved) {
          if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD * imageScale()) return
          dragShape.moved = true
        }
        applyDelta(dragShape.shape, dragShape.orig, dx, dy)
        render()
        return
      }
      if (!drawing) return
      if (event.buttons === 0) {
        drawing = null
        render()
        return
      }
      const point = position(event)
      drawing.cur = point
      const state = drawing
      if (state.pts) {
        const last = state.pts[state.pts.length - 1]
        // Sample spacing: half a mosaic cell so blocks stay contiguous, 2 px for
        // freehand so the stroke follows the pointer without flooding the array.
        const stride = state.tool === "mosaic" ? mosaicCell / 2 : 2
        if (Math.abs(point.x - last[0]) + Math.abs(point.y - last[1]) >= stride) state.pts.push([point.x, point.y])
        state.preview = null
        drawStrokeDelta(state)
      } else {
        state.preview = buildShape(state.tool, state.start, point)
        render()
      }
    })

    // Registered once, below; the listener is removed in close().
    window.addEventListener("mouseup", onMouseUp)

    // ---- image loading -----------------------------------------------------

    /** Scales the canvas to the room it has; called on load and on every resize. */
    function fit(): void {
      if (!imgW || !imgH) return
      const roomX = Math.max(STAGE_MIN_ROOM, stage.clientWidth - STAGE_PAD_X)
      const roomY = Math.max(STAGE_MIN_ROOM, stage.clientHeight - STAGE_PAD_Y)
      // A very long strip would otherwise be a few pixels tall and impossible to
      // draw on; the stage scrolls, so letting it overflow is fine. The cap keeps a
      // 1 px strip from being blown up to the full window.
      const floor = Math.min(MAX_FIT_UPSCALE, MIN_VISIBLE_SHORT_EDGE / Math.min(imgW, imgH))
      const scale = Math.max(floor, Math.min(1, roomX / imgW, roomY / imgH))
      wrap.style.width = imgW * scale + "px"
      wrap.style.height = imgH * scale + "px"
      // The text box is positioned in screen pixels derived from the canvas rect;
      // a resize changes that factor, so an open box has to be repositioned or it
      // no longer sits on the glyphs it is editing.
      if (textSession) refreshTextBox()
    }

    window.addEventListener("resize", fit)

    function load(source: string, done?: (ok: boolean) => void): void {
      textSession = null
      hiddenShape = null
      editingShape = null
      // Drop the scratch surface: it kept the largest picture ever blurred alive.
      blurSource = null
      disarm()
      txtInput.style.display = "none"
      txtInput.value = ""
      drawing = null
      finished = false
      // Decode into a scratch image first: a file that fails to decode must leave
      // the current picture and its annotations usable.
      const image = new Image()
      image.onload = () => {
        const pixels = image.naturalWidth * image.naturalHeight
        if (!image.naturalWidth || !image.naturalHeight) {
          setHint(T("edLoadFail"))
          if (done) done(false)
          return
        }
        if (pixels > MAX_OPEN_PIXELS) {
          // Each canvas costs four bytes per pixel; a 20000x20000 png is 1.6 GB each.
          setHint(T("edTooLarge"))
          if (done) done(false)
          return
        }
        imgW = image.naturalWidth
        imgH = image.naturalHeight
        base.width = imgW
        base.height = imgH
        over.width = imgW
        over.height = imgH
        // Pointer maths divides by the rect, so drawing still lands on image pixels.
        fit()
        bctx.clearRect(0, 0, imgW, imgH)
        bctx.drawImage(image, 0, 0)
        shapes.length = 0
        snapshots = [JSON.stringify({ shapes: [], crop: null } as SnapshotState)]
        snapshotBytes = snapshots[0].length
        snapIndex = 0
        selected = null
        // Every per-image state must reset here, otherwise the previous shot's
        // crop rectangle silently clips the new image.
        cropRect = null
        editingShape = null
        dragShape = null
        markerCounter = 1
        render()
        syncUndoRedo()
        hint.style.display = "none"
        if (done) done(true)
      }
      image.onerror = () => {
        // Keep the picture that is already on screen usable: zeroing the size here
        // would disable every button while the old image stays visible.
        hint.style.display = ""
        setHint(T("edLoadFail"))
        if (done) done(false)
      }
      image.src = source
    }

    function hasWork(): boolean {
      // Text that was typed but not committed is still thrown away with the window.
      return shapes.length > 0 || cropRect !== null || (textSession !== null && txtInput.value.trim() !== "")
    }

    function requestCancel(viaKey: boolean): void {
      // The annotations cannot be recovered afterwards: the history is per picture
      // and the window is about to close.
      if (!hasWork()) {
        done(false)
        return
      }
      confirmThen("cancel", "edCancelAsk", () => done(false), viaKey ? CONFIRM_COOLDOWN_MS : 0)
    }

    fileInput.addEventListener("change", () => {
      const picked = fileInput.files && fileInput.files[0]
      if (!picked) return
      if (picked.size > MAX_OPEN_BYTES) {
        setHint(T("edTooLarge"))
        fileInput.value = ""
        return
      }
      const reader = new FileReader()
      reader.onload = () => load(String(reader.result))
      reader.onerror = () => setHint(T("edLoadFail"))
      reader.readAsDataURL(picked)
      fileInput.value = ""
    })

    // ---- export ------------------------------------------------------------

    /** Hide the selection box and crop mask, repaint, and hand back a restore fn. */
    function beginCleanExport(): () => void {
      const keepSelected = selected
      if (!keepSelected && !cropRect) return () => {}
      selected = null
      exporting = true
      render()
      return () => {
        exporting = false
        selected = keepSelected
        render()
      }
    }

    function exportJpeg(): string {
      const restore = beginCleanExport()
      try {
        const srcX = cropRect ? cropRect.x : 0
        const srcY = cropRect ? cropRect.y : 0
        const srcW = cropRect ? Math.max(1, cropRect.w) : imgW
        const srcH = cropRect ? Math.max(1, cropRect.h) : imgH
        let w = srcW
        let h = srcH
        if (w > MAX_DIM || h > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / w, MAX_DIM / h)
          // A 4000x1 strip rounds the short edge to zero, and drawImage with a
          // zero-height target paints nothing: the export would be a black frame.
          w = Math.max(1, Math.round(w * ratio))
          h = Math.max(1, Math.round(h * ratio))
        }
        const out = document.createElement("canvas")
        out.width = w
        out.height = h
        const context = out.getContext("2d")
        if (!context) return ""
        // JPEG has no alpha: a transparent pixel would come out black.
        context.fillStyle = "#ffffff"
        context.fillRect(0, 0, w, h)
        context.imageSmoothingQuality = "high"
        context.drawImage(base, srcX, srcY, srcW, srcH, 0, 0, w, h)
        context.drawImage(over, srcX, srcY, srcW, srcH, 0, 0, w, h)
        return out.toDataURL("image/jpeg", EXPORT_JPEG_QUALITY)
      } finally {
        restore()
      }
    }

    function exportFull(): string {
      const restore = beginCleanExport()
      try {
        const srcX = cropRect ? cropRect.x : 0
        const srcY = cropRect ? cropRect.y : 0
        const srcW = cropRect ? Math.max(1, cropRect.w) : imgW
        const srcH = cropRect ? Math.max(1, cropRect.h) : imgH
        const out = document.createElement("canvas")
        out.width = srcW
        out.height = srcH
        const context = out.getContext("2d")
        if (!context) return ""
        context.imageSmoothingQuality = "high"
        context.drawImage(base, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)
        context.drawImage(over, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)
        const url = out.toDataURL("image/png")
        // An image opened at the size limit can produce tens of megabytes here, and
        // the value crosses Ipc twice. Refuse instead of freezing the window.
        return url.length > MAX_EXPORT_CHARS ? "" : url
      } finally {
        restore()
      }
    }

    function close(): void {
      if (armed) clearTimeout(armed.timer)
      armed = null
      clearTimeout(closeTimer)
      ;(window as unknown as { __shotCanClose?: () => boolean }).__shotCanClose = undefined
      window.removeEventListener("resize", fit)
      try {
        previousFocus?.focus?.()
      } catch {}
      document.removeEventListener("keydown", onKey, true)
      window.removeEventListener("mouseup", onMouseUp)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      root.remove()
      style.remove()
    }

    function done(confirmed: boolean): void {
      if (finished) return
      if (confirmed && !imgW) return
      // A stroke in progress is painted straight onto the annotation layer, so
      // exporting now would bake a half-finished line into the result. Dropping it
      // is the same recovery the toolbar offers.
      if (confirmed && drawing) {
        drawing = null
        render()
      }
      commitText()
      if (!confirmed) {
        close()
        resolve(null)
        return
      }
      // A failed export is not a cancel: keep the editor open so the annotations
      // are not thrown away, and say what happened.
      let dataUrl = ""
      try {
        dataUrl = exportJpeg()
      } catch {
        setHint(T("edExportFail"))
        return
      }
      if (!dataUrl) {
        setHint(T("edExportFail"))
        return
      }
      // Marking the editor finished before the export meant a throw from
      // toDataURL left every button (Cancel included) a no-op.
      finished = true
      const binary = atob(dataUrl.split(",")[1] || "")
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      close()
      resolve(new File([bytes], stampName(), { type: "image/jpeg" }))
    }

    let saving = false
    saveButton.addEventListener("click", () => {
      if (!imgW || saving) return
      saving = true
      let dataUrl = ""
      try {
        // The mouseup can land outside the window, leaving a stroke half drawn and
        // every footer button looking dead. Dropping the stroke is what the toolbar
        // does in the same situation.
        if (drawing) {
          drawing = null
          render()
        }
        commitText()
        dataUrl = exportFull()
      } catch {
        // A throw here would leave the guard set and the button dead for the rest
        // of the session.
        saving = false
        flash(saveButton, T("edSaveFail"))
        return
      }
      if (!dataUrl) {
        saving = false
        // Empty here means the export was refused for size, not that writing failed.
        flash(saveButton, T("edTooLarge"))
        return
      }
      void Promise.resolve()
        .then(() => options.save(dataUrl))
        .then((state) => {
          // A dismissed dialog is not a failure; only a real write error is.
          if (state === "saved") flash(saveButton, T("edSaved"))
          else if (state === "cancelled") flash(saveButton, T("edCancelled"))
          else flash(saveButton, T("edSaveFail"))
        })
        .catch(() => {
          // Last resort: a plain download link.
          const fallback = exportFull()
          if (!fallback) {
            flash(saveButton, T("edSaveFail"))
            return
          }
          const link = document.createElement("a")
          link.href = fallback
          link.download = stampName().replace(/\.jpg$/, ".png")
          document.body.appendChild(link)
          link.click()
          link.remove()
          // The download link may or may not produce a file; claiming "Saved"
          // without knowing is worse than saying it failed.
          flash(saveButton, T("edSaveFail"))
        })
        .finally(() => {
          saving = false
        })
    })

    let copying = false
    copyButton.addEventListener("click", () => {
      if (!imgW || copying) return
      copying = true
      let dataUrl = ""
      try {
        if (drawing) {
          drawing = null
          render()
        }
        commitText()
        // Single source of truth: exportFull() already applies the crop rectangle
        // and paints a chrome-free overlay, so copy and save can never drift apart.
        // The renderer clipboard API is verified broken in this host (see
        // contract.ts and gui.tsx), so the main-process writer is the only path.
        dataUrl = exportFull()
      } catch {
        copying = false
        flash(copyButton, T("edCopyFail"))
        return
      }
      if (!dataUrl) {
        copying = false
        flash(copyButton, T("edTooLarge"))
        return
      }
      void Promise.resolve()
        .then(() => options.copy(dataUrl))
        .then((ok) => flash(copyButton, ok ? T("edCopied") : T("edCopyFail")))
        .catch(() => flash(copyButton, T("edCopyFail")))
        // Without this the guard stayed on, so copy worked once per editor.
        .finally(() => {
          copying = false
        })
    })

    // Asked by the main process when the window's own close button is used. It has
    // to answer synchronously, so this is the one place window.confirm is used; if
    // the host refuses dialogs, allow the close rather than trap the user.
    ;(window as unknown as { __shotCanClose?: () => boolean }).__shotCanClose = () => {
      if (!hasWork()) return true
      // The main process asks once per close attempt, so a second attempt within the
      // window counts as the confirmation. This avoids window.confirm, which a host
      // with dialogs disabled answers with false forever.
      // The question only stands while its own message is on screen: a note that
      // replaced it means this press should ask again, not discard.
      if (
        closeArmedAt &&
        closeArmedToken === hintToken &&
        Date.now() - closeArmedAt < CONFIRM_WINDOW_MS
      ) {
        closeArmedAt = 0
        clearTimeout(closeTimer)
        if (hintOwner === "arm") clearHint()
        return true
      }
      closeArmedAt = Date.now()
      setHint(T("edCloseAsk"), "arm")
      const token = hintToken
      closeArmedToken = token
      clearTimeout(closeTimer)
      closeTimer = window.setTimeout(() => {
        closeArmedAt = 0
        clearHint(token)
      }, CONFIRM_WINDOW_MS)
      return false
    }

    // ---- keyboard ----------------------------------------------------------

    function onKey(event: KeyboardEvent): void {
      if (event.isComposing) return
      if (event.key === "Escape") {
        if (drawing) {
          drawing = null
          render()
          return
        }
        if (textSession) {
          textSession = null
          editingShape = null
          hiddenShape = null
          txtInput.style.display = "none"
          txtInput.value = ""
          render()
          return
        }
        if (selected) {
          selected = null
          render()
          return
        }
        if (cropRect) {
          cropRect = null
          render()
          // The click path snapshots when it clears a crop; without the same step
          // here, undo would bring back the crop the user just cancelled.
          snapshot()
          return
        }
        requestCancel(true)
        return
      }
      // The overlay declares itself modal, so Tab has to cycle inside it: focus
      // escaping to the composer behind the overlay would let a keystroke land in
      // a conversation the user cannot see.
      if (event.key === "Tab") {
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ).filter((node) => !(node as HTMLButtonElement).disabled && node.offsetParent !== null)
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (!root.contains(active)) {
          event.preventDefault()
          first.focus()
          return
        }
        if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
          return
        }
        if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
          return
        }
      }
      // While the inline text box has focus, editing keys belong to the textarea.
      // Once focus moves away the shortcuts must work again, even though the box
      // stays open for live styling.
      if (textSession && document.activeElement === txtInput) return

      // Digit shortcuts pick a tool. Use event.code so the physical key still
      // works while an IME is active (key becomes "Process" in that state).
      const focus = event.target as HTMLElement | null
      // A slider keeps focus after a drag but never takes typed input, so it must
      // not swallow the shortcuts.
      const fieldType = (focus as HTMLInputElement | null)?.type ?? ""
      const inField =
        !!focus &&
        (focus.tagName === "SELECT" || focus.tagName === "TEXTAREA" ||
          (focus.tagName === "INPUT" && fieldType !== "range"))
      const digit = /^Digit([0-9])$/.exec(event.code)
      if (!inField && !event.ctrlKey && !event.metaKey && !event.altKey && digit) {
        const index = digit[1] === "0" ? 9 : Number(digit[1]) - 1
        if (index >= 0 && index < toolButtons.length) {
          event.preventDefault()
          event.stopPropagation()
          toolButtons[index].click()
          return
        }
      }
      // The eleventh tool is past the last digit, so it gets a letter: without one
      // it is the only tool a keyboard user cannot reach.
      if (!inField && !event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyC") {
        const cropButton = toolButtons[toolButtons.length - 1]
        if (cropButton?.dataset.tool === "crop") {
          event.preventDefault()
          event.stopPropagation()
          cropButton.click()
          return
        }
      }
      if (!inField && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault()
        event.stopPropagation()
        saveButton.click()
        return
      }
      if (!inField && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault()
        event.stopPropagation()
        copyButton.click()
        return
      }
      if (
        !inField &&
        (event.key === "Delete" || event.key === "Backspace") &&
        selected &&
        !textSession
      ) {
        event.preventDefault()
        const index = shapes.indexOf(selected)
        if (index >= 0) {
          shapes.splice(index, 1)
          selected = null
          render()
          snapshot()
        }
        return
      }
      if (!inField && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault()
        undo()
        return
      }
      if (
        !inField &&
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))
      ) {
        event.preventDefault()
        redo()
        return
      }
      const target = event.target as HTMLElement | null
      const inFormField =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          (target.closest && target.closest("button") !== null))
      if (event.key === "Enter" && !textSession && !inFormField) {
        event.preventDefault()
        done(true)
      }
    }

    /** Ends a drag, resampling anything whose pixels depend on its position. */
    function finishDrag(): void {
      if (!dragShape) return
      const { moved, shape } = dragShape
      dragShape = null
      if (!moved) return
      // A mosaic carries the average colours it sampled where it was drawn; after a
      // drag those cells no longer match what is under them. Rebaking changes pixels,
      // so the frame on screen is stale until the next paint.
      if (shape.type === "mosaic") {
        bakeMosaic(shape)
        render()
      }
      snapshot()
    }

    function onMouseUp(event: MouseEvent): void {
      if (dragShape) {
        finishDrag()
        return
      }
      if (!drawing) return
      if (event && typeof event.button === "number" && event.button !== 0) return
      const state = drawing
      drawing = null
      if (state.pts) {
        const shape: Shape = { type: state.tool, pts: state.pts, color, width: lineWidth }
        if (state.tool === "mosaic") {
          shape.size = mosaicCell
          bakeMosaic(shape)
        }
        pushShape(shape)
      } else if (!state.preview && state.tool === "crop" && cropRect) {
        // A stationary click never runs mousemove, so no preview exists to compare
        // against; it is still the click that clears an existing crop.
        cropRect = null
        render()
        snapshot()
        return
      } else if (state.preview) {
        // The threshold is a feel, not a measurement: compare in screen pixels by
        // scaling it the same way pointer coordinates are scaled.
        const slop = DRAG_THRESHOLD * imageScale()
        if (Math.abs(state.cur.x - state.start.x) + Math.abs(state.cur.y - state.start.y) < slop) {
          // A click without dragging clears an existing crop.
          if (state.tool === "crop" && cropRect) {
            cropRect = null
            render()
            snapshot()
            return
          }
          render()
          return
        }
        if (state.tool === "crop") {
          const cw = state.preview.w ?? 0
          const ch = state.preview.h ?? 0
          // A zero-height crop produces a 0-pixel canvas, whose toDataURL returns
          // "data:," and yields an empty file downstream.
          // A 1 px wide image can never reach MIN_CROP_SIDE; take what it has.
          const minSide = Math.min(MIN_CROP_SIDE, imgW, imgH)
          if (cw >= minSide && ch >= minSide) {
            cropRect = {
              x: state.preview.x ?? 0,
              y: state.preview.y ?? 0,
              w: cw,
              h: ch,
            }
            render()
            // A crop is a step the user expects to undo on its own.
            snapshot()
            return
          }
          render()
          return
        }
        pushShape(state.preview)
      } else render()
    }

    document.addEventListener("keydown", onKey, true)

    objectUrl = URL.createObjectURL(file)
    load(objectUrl)
  })
}
