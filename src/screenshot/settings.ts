// Settings for this plugin. The path is part of the contract: it is the one the
// README documents, and moving it would silently reset every existing install.
//
// Node is fetched lazily: this module is part of the bundle the window evaluates,
// where a `node:*` import resolves to an inert proxy that swallows every call
// instead of throwing. Only the main process calls these functions, so nothing
// touches node at load time; the guard below covers a process that has no
// `require` at all, which the window does have (it just returns proxies).

export type ShotSettings = {
  hideWindow: boolean
  sendMode: "edit" | "direct"
  hotkey: string
  language: "en" | "zh"
}

export const DEFAULTS: ShotSettings = { hideWindow: true, sendMode: "edit", hotkey: "", language: "en" }

type NodeApis = {
  fs: typeof import("node:fs")
  os: typeof import("node:os")
  path: typeof import("node:path")
}

declare const require: ((id: string) => unknown) | undefined

let cached: NodeApis | null = null
function node(): NodeApis {
  if (cached) return cached
  const req = typeof require === "function" ? require : undefined
  if (!req) throw new Error("node api unavailable in this process")
  cached = {
    fs: req("node:fs") as NodeApis["fs"],
    os: req("node:os") as NodeApis["os"],
    path: req("node:path") as NodeApis["path"],
  }
  return cached
}

/**
 * The plugin's only persistent state. `language` is the single source of truth
 * for both halves: the window reads it through the Ipc settings calls, the main
 * process through lang() in capture.ts. A first run, or a file that cannot be
 * parsed, lands on the defaults.
 */
export function settingsPath(): string {
  const { os, path } = node()
  return path.join(os.homedir(), ".config", "opencode", "oc-screenshot-settings.json")
}

function normalize(raw: Partial<ShotSettings> | null | undefined): ShotSettings {
  const value = raw ?? {}
  return {
    hideWindow: value.hideWindow !== false,
    sendMode: value.sendMode === "direct" ? "direct" : "edit",
    hotkey: typeof value.hotkey === "string" ? value.hotkey : "",
    language: String(value.language ?? "").trim().toLowerCase() === "zh" ? "zh" : "en",
  }
}

export function readShotSettings(): ShotSettings {
  try {
    const text = node().fs.readFileSync(settingsPath(), "utf8").replace(/^\uFEFF/, "")
    return normalize(JSON.parse(text) as Partial<ShotSettings>)
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeShotSettings(patch: Partial<ShotSettings>): ShotSettings {
  const next = normalize({ ...readShotSettings(), ...patch })
  const { fs } = node()
  const target = settingsPath()
  // Write to a sibling and rename: a crash mid-write would otherwise leave half a
  // JSON file behind, and readShotSettings would quietly fall back to defaults,
  // losing the hotkey the user just bound.
  // Unique per writer: two windows writing settings at once would otherwise
  // rename each other's partial file.
  const temp = `${target}.${process.pid}-${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8")
  fs.renameSync(temp, target)
  return next
}
