/**
 * Real-file verification for the patch row the panel writes.
 *
 * A wrong patch row is the one mistake that can stop DSH from booting, so this
 * tool does not trust string matching: it drives the Host half against a *copy* of
 * a real profile patch, then parses the result with the engine's own YAML parser
 * (js-yaml, extracted from the DSH app.asar) to prove the file is still a valid
 * sequence, that our row sits where it should, and that every other row is untouched.
 *
 * Usage:
 *   node tools/verify-patch.mjs --patch "C:\Users\雨桐\.dsh\profiles\desktop\cordis.patch.yml" --yaml "<js-yaml.mjs>"
 *
 *   --patch  patch file to copy and mutate (default: ~/.dsh/profiles/desktop/cordis.patch.yml)
 *   --yaml   path to js-yaml's single-file ESM build (dist/js-yaml.mjs). Optional:
 *            without it the tool still checks structure but skips parser validation.
 *   --keep   leave the mutated copy on disk and print its path.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const flagOf = (name) => argv.includes(`--${name}`)

const patchArgument = argOf('patch', path.join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'))
const yamlArgument = argOf('yaml', '')

const loadYaml = async () => {
  if (yamlArgument === '') return null
  const module = await import(pathToFileURL(path.resolve(yamlArgument)).href)
  return typeof module.load === 'function' ? module.load : null
}

const loadHost = async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
}

let passed = 0
const failures = []
const check = (label, condition) => {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
}

const workDir = await mkdtemp(path.join(tmpdir(), 'ccp-verify-'))
const workPatch = path.join(workDir, 'cordis.patch.yml')

try {
  await copyFile(patchArgument, workPatch)
  const originalText = await readFile(patchArgument, 'utf8')
  const load = await loadYaml()
  const host = await loadHost()

  // The real file must already parse; if it does not, nothing below is meaningful.
  if (load !== null) {
    try {
      const rows = load(originalText)
      check('the real patch parses as a sequence', Array.isArray(rows))
      check('the real patch has rows', Array.isArray(rows) && rows.length > 0)
    } catch (error) {
      check(`the real patch parses as a sequence (${error.message})`, false)
    }
  } else {
    console.log('note: no --yaml given, parser validation skipped')
  }

  const state = { spec: null, updates: [] }
  const entry = {
    options: { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} },
    fiber: {},
    async update(next) {
      state.updates.push(next)
      entry.options = { ...entry.options, ...next, config: next.config }
    },
  }
  const services = {
    loader: { entries: () => [entry] },
    profileContext: { dir: workDir, patchPath: workPatch },
    connection: { fetch: { register(spec) { state.spec = spec; return () => {} } } },
  }
  host.apply({
    inject: (names, callback) => callback({ get: (name) => services[name] }),
    effect: (fn) => fn(),
  })

  const call = async (body) => {
    const response = await state.spec.fetch({ json: async () => body })
    return response.json()
  }

  // Write a non-default policy, then read the mutated copy back through the parser.
  const applied = await call({ action: 'apply', policy: { auto: true, timing: 65, retain: 20 } })
  check('apply succeeded on a copy of the real patch', applied.ok === true)
  check('apply reached the loader entry', state.updates.length === 1)

  const written = await readFile(workPatch, 'utf8')
  if (load !== null) {
    let rows = null
    try {
      rows = load(written)
    } catch (error) {
      check(`the mutated patch still parses (${error.message})`, false)
    }
    check('the mutated patch still parses as a sequence', Array.isArray(rows))
    const ours = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object' && row.id === 'compaction-basic') : []
    check('exactly one compaction row exists', ours.length === 1)
    check('the row carries the trigger ratio', ours.length === 1 && ours[0].config.thresholdRatio === 0.65)
    check('the row carries the retained share', ours.length === 1 && ours[0].config.retainRatio === 0.2)
    check('the row keeps auto', ours.length === 1 && ours[0].config.auto === true)
    const originalRows = load(originalText)
    check('every original row is still present', Array.isArray(rows) && originalRows.every((row) => {
      const match = rows.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.id === row.id)
      return match !== undefined && JSON.stringify(match) === JSON.stringify(row)
    }))
    check('only one row was added', Array.isArray(rows) && rows.length === originalRows.length + 1)
  }

  // Back to the shipped defaults: the row must disappear and nothing else may move.
  const cleared = await call({ action: 'apply', policy: { auto: true, timing: 80, retain: 16 } })
  check('restoring the defaults reported cleared', cleared.value.persisted === 'cleared')
  const after = await readFile(workPatch, 'utf8')
  if (load !== null) {
    const rows = load(after)
    const ours = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object' && row.id === 'compaction-basic') : []
    check('the compaction row is gone after the reset', ours.length === 0)
    const originalRows = load(originalText)
    check('the reset file equals the original rows', Array.isArray(rows) && rows.length === originalRows.length)
    check('the reset file keeps row content', JSON.stringify(rows) === JSON.stringify(originalRows))
  } else {
    check('the reset file dropped our marker', after.includes('# dsh-context-compression-panel:begin') === false)
  }

  console.log(`patch checked: ${patchArgument}`)
  if (flagOf('keep')) console.log(`mutated copy kept at: ${workPatch}`)
} catch (error) {
  failures.push(`unexpected failure: ${error.message}`)
} finally {
  if (!flagOf('keep')) await rm(workDir, { recursive: true, force: true })
}

if (failures.length === 0) {
  console.log(`ok - ${passed} checks passed`)
} else {
  console.error(`not ok - ${failures.length} failed, ${passed} passed`)
  for (const label of failures) console.error(`  - ${label}`)
  process.exitCode = 1
}
