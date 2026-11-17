// Directory entry. OpenCode loads plugins listed in opencode.json by resolving
// the package's "." export, but a plain directory walk also finds this file, so
// both paths reach the same server half.
// The extension is explicit: Node's ESM resolver does not guess one, and a
// plain directory walk imports this file with Node.
export { default } from "./src/index.ts"
