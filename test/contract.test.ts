import test from "node:test"
import assert from "node:assert/strict"
import { MAX_IMAGE_DIM, MSG, TEMP_FILES } from "../src/screenshot/capture"
import { DEFAULTS } from "../src/screenshot/settings"
import { MAX_DIM } from "../src/shot-editor"

test("both languages carry the same messages", () => {
  assert.deepEqual(Object.keys(MSG.en).sort(), Object.keys(MSG.zh).sort())
  for (const value of [...Object.values(MSG.en), ...Object.values(MSG.zh)]) assert.ok(value.length > 0)
})

test("documented defaults match the settings file contract", () => {
  assert.deepEqual(DEFAULTS, { hideWindow: true, sendMode: "edit", hotkey: "", language: "en" })
})

test("both copies of the image cap are the value the README promises", () => {
  // Two constants on purpose: the capture resizes to one and the editor caps its
  // export at the other. They must not drift apart.
  assert.equal(MAX_IMAGE_DIM, 1568)
  assert.equal(MAX_DIM, 1568)
})

test("temp file names are unique and share the prefix the prune step matches", () => {
  const names = Object.values(TEMP_FILES)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^screenshot-/)
})
