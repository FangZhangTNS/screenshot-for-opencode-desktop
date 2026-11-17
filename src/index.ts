import { Plugin } from "@opencode/plugin"

// Server half of the plugin. It exists to give the plugin its id: the desktop
// app reads the GUI half from ./gui-experimental and assigns this plugin's id to
// it. No server-side behaviour is needed.
export default Plugin.define({
  id: "screenshot-for-opencode-desktop",
  async setup() {
    return
  },
})
