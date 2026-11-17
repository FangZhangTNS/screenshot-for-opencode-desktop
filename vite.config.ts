import { gui } from "@opencode/plugin/gui/vite"
import { defineConfig } from "vite"

// Builds ./dist/gui-experimental.cjs, the file the desktop app loads for the
// window and main halves. `vite build --watch` rebuilds it on every save and the
// app reloads the plugin in place.
export default defineConfig({
  plugins: [gui()],
})
