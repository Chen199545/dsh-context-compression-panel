/**
 * Add or remove this plugin from a dsh profile's package.json.
 *
 * Two edits are made, and BOTH matter:
 *   1. `dependencies` — so a pnpm pass resolves the package instead of pruning it
 *   2. `dsh.profile.bundles` — so the composition loads the plugin at startup
 * Removing only the dependency leaves the bundle entry behind, and the plugin
 * keeps loading after an uninstall.
 *
 * Usage: node tools/profile-edit.mjs add|remove <path to profile package.json>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-context-compression-panel'
const SPEC = 'file:../../plugins-src/dsh-context-compression-panel'

const mode = process.argv[2]
const target = process.argv[3]
if (mode !== 'add' && mode !== 'remove') {
  console.error('usage: node tools/profile-edit.mjs add|remove <profile package.json>')
  process.exit(2)
}
if (typeof target !== 'string' || target.length === 0) {
  console.error('missing profile package.json path')
  process.exit(2)
}
if (!fs.existsSync(target)) {
  console.error(`not found: ${target}`)
  process.exit(2)
}

const text = fs.readFileSync(target, 'utf8')
let doc
try {
  doc = JSON.parse(text)
} catch (error) {
  console.error(`refusing to touch a malformed package.json: ${error.message}`)
  process.exit(2)
}

doc.dependencies = doc.dependencies !== null && typeof doc.dependencies === 'object' ? doc.dependencies : {}
doc.dsh = doc.dsh !== null && typeof doc.dsh === 'object' ? doc.dsh : {}
doc.dsh.profile = doc.dsh.profile !== null && typeof doc.dsh.profile === 'object' ? doc.dsh.profile : {}
const bundles = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : []
doc.dsh.profile.bundles = bundles

if (mode === 'add') {
  doc.dependencies[NAME] = SPEC
  if (!bundles.includes(NAME)) bundles.push(NAME)
} else {
  delete doc.dependencies[NAME]
  doc.dsh.profile.bundles = bundles.filter((entry) => entry !== NAME)
}

const next = `${JSON.stringify(doc, null, 2)}\n`
if (next === text) {
  console.log(`${mode}: already in the desired state`)
} else {
  fs.writeFileSync(target, next, 'utf8')
  console.log(`${mode}: wrote ${target}`)
}
