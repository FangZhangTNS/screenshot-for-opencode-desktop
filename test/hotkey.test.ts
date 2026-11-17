import test from "node:test"
import assert from "node:assert/strict"
import { normHotkey } from "../src/composer"

test("keeps a bare function key", () => {
  assert.equal(normHotkey("f12"), "F12")
})

test("rejects a bare letter or digit", () => {
  assert.equal(normHotkey("a"), "")
  assert.equal(normHotkey("1"), "")
})

test("rejects Shift on its own, which would take uppercase typing away", () => {
  assert.equal(normHotkey("shift+a"), "")
  assert.equal(normHotkey("Shift+F5"), "Shift+F5")
})

test("accepts digits and refuses punctuation the accelerator grammar cannot name", () => {
  assert.equal(normHotkey("ctrl+shift+1"), "Ctrl+Shift+1")
  assert.equal(normHotkey("ctrl+!"), "")
  assert.equal(normHotkey("ctrl+shift+<"), "")
})

test("normalizes modifier names and order", () => {
  assert.equal(normHotkey("control+alt+p"), "Ctrl+Alt+P")
  assert.equal(normHotkey("shift+ctrl+a"), "Ctrl+Shift+A")
})

test("drops duplicate modifiers", () => {
  assert.equal(normHotkey("ctrl+control+k"), "Ctrl+K")
})

test("refuses combinations the app or the OS already owns", () => {
  for (const key of ["c", "x", "v", "a", "z", "w", "s"]) assert.equal(normHotkey(`ctrl+${key}`), "")
  assert.equal(normHotkey("alt+f4"), "")
})

test("allows an owned letter once another modifier is added", () => {
  assert.equal(normHotkey("ctrl+shift+s"), "Ctrl+Shift+S")
  assert.equal(normHotkey("ctrl+alt+c"), "Ctrl+Alt+C")
})

test("rejects keys outside the supported set", () => {
  assert.equal(normHotkey("ctrl+delete"), "")
  assert.equal(normHotkey("f0"), "")
  assert.equal(normHotkey("f25"), "")
  assert.equal(normHotkey("ctrl+space"), "")
})

test("treats empty and blank input as unset", () => {
  assert.equal(normHotkey(""), "")
  assert.equal(normHotkey("   "), "")
  assert.equal(normHotkey(undefined as unknown as string), "")
})

test("is idempotent", () => {
  for (const value of ["ctrl+shift+s", "f9", "alt+shift+p"]) {
    assert.equal(normHotkey(normHotkey(value)), normHotkey(value))
  }
})
