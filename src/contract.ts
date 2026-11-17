import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

// The capture bridge. `region` returns the JPEG packet and nothing else; the
// window decides whether the editor runs before delivery, so one capture serves
// both send modes without a second round trip.
export const Shot = Ipc.define({
  // The host only lets a window call Ipc whose id belongs to its own plugin, so
  // the first segment must equal the plugin id declared in src/index.ts.
  id: "screenshot-for-opencode-desktop.shot",
  methods: {
    region: { output: Schema.String },
    // Global hotkey, bound from the settings menu.
    setHotkey: { input: Schema.String, output: Schema.Boolean },
    // The settings file, read and written in main.
    readSettings: { output: Schema.String },
    writeSettings: { input: Schema.String, output: Schema.String },
    // Editor "Save": asks for a path in main, writes the PNG there.
    // Returns "saved" | "cancelled" | "failed". Used by the editor window's bridge
    // and by the overlay fallback.
    saveImage: { input: Schema.String, output: Schema.String },
    // Payload is JSON { dataUrl, labels }; the reply is JSON { kind, dataUrl? }.
    openEditor: { input: Schema.String, output: Schema.String },
    /** Armed only by the overlay fallback, which lives inside the app window. */
    setEditorOpen: { input: Schema.Boolean, output: Schema.Boolean },
    // Editor "Copy": the renderer clipboard API is denied in this window, so the
    // main process puts the PNG on the system clipboard.
    copyImage: { input: Schema.String, output: Schema.Boolean },
  },
  events: {
    // JSON capture packet pushed to the window that asked for it.
    hotkey: Schema.String,
    // Another window wrote the settings file; the payload is unused.
    settings: Schema.String,
  },
})
