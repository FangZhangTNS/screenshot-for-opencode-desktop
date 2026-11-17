// Entry for the standalone editor window.
//
// It is bundled on its own (esbuild, IIFE) and inlined into the page the main
// process loads into a modal window, so it must stay self-contained: only the
// editor module plus the bridge the preload exposes.

import { openShotEditor } from "./shot-editor"

type Payload = { dataUrl: string; labels: Record<string, string> }

type Bridge = {
  save: (dataUrl: string) => Promise<string>
  copy: (dataUrl: string) => Promise<boolean>
}

declare global {
  interface Window {
    /** Called by the main process once the page is loaded; resolves with a data URL. */
    __shotRun?: (payload: Payload) => Promise<string | null>
    /** Asked before the window closes; the editor installs it once mounted. */
    __shotCanClose?: () => boolean
    shotBridge?: Bridge
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

window.__shotRun = async ({ dataUrl, labels }) => {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const file = new File([blob], "screenshot.jpg", { type: blob.type || "image/jpeg" })
  // A missing bridge is a broken window, not a successful save: rejecting lets the
  // editor take its own fallback (a download link) instead of claiming it worked.
  const bridge = window.shotBridge
  const edited = await openShotEditor(file, {
    t: (key) => labels[key] ?? key,
    // This window has a native frame, so the canvas must not reserve a caption band.
    framed: true,
    save: (value) => (bridge ? bridge.save(value) : Promise.reject(new Error("no bridge"))),
    copy: (value) => (bridge ? bridge.copy(value) : Promise.reject(new Error("no bridge"))),
  })
  if (!edited) return null
  const bytes = new Uint8Array(await edited.arrayBuffer())
  return `data:${edited.type || "image/jpeg"};base64,${toBase64(bytes)}`
}
