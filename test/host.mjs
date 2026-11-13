/**
 * Behaviour test for the Host half (lib/index.js, v3).
 *
 * The Host half imports only Node builtins, so it runs in plain Node with fakes:
 * a `connection.fetch.register` that captures the route spec, a `loader` whose
 * entries carry the engine's config, and a `profileContext` pointing at a temp
 * profile directory with its own patch file. That covers what v2 got wrong:
 *
 *   - the compaction entry is found through `loader.entries()` (any include layer)
 *   - a write reaches the entry (`entry.update`) and keeps the keys the panel does
 *     not own while dropping the exclusive retainTokens
 *   - a refusal is reported instead of saved, and the patch is never half-written
 *   - persistence is one marked row that is replaced, not duplicated, and is
 *     removed again when the values return to the shipped defaults
 *
 * Usage: node test/host.mjs
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const host = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

let passed = 0
const failures = []
function check(label, condition) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const workDir = await mkdtemp(path.join(tmpdir(), 'ccp-host-'))
const PATCH = path.join(workDir, 'cordis.patch.yml')
const DIAG = path.join(workDir, '.context-compression-panel.diag.json')

/** Files in the profile dir, for the "nothing extra left behind" checks. */
const listFiles = async () => readdir(workDir)

/**
 * Build a fake Host.
 * @param rows - `{id, name, config, active, fail}` entries the loader exposes.
 * @param options.patch - text to seed the profile patch with (`null` = no file).
 */
function makeHost(rows, options = {}) {
  const state = { spec: null, updates: [] }
  const entries = rows.map((row) => {
    const entry = {
      options: { id: row.id, name: row.name, config: row.config },
      fiber: row.active === false ? undefined : {},
      async update(next) {
        state.updates.push({ id: row.id, next })
        if (row.fail !== undefined) throw new Error(row.fail)
        entry.options = {
          ...entry.options,
          ...next,
          config: next.config === undefined ? entry.options.config : next.config,
        }
      },
    }
    return entry
  })
  const loader = { entries: () => entries }
  const profileContext = { dir: workDir, patchPath: PATCH }
  const connection = options.noRoute === true ? { fetch: {} } : {
    fetch: {
      register(spec) {
        state.spec = spec
        return () => {}
      },
    },
  }
  const services = { connection, loader, profileContext }
  const ctx = {
    inject(names, callback) {
      return callback({ get: (name) => services[name] })
    },
    effect(fn) {
      return fn()
    },
  }
  host.apply(ctx)
  return { state, entries, profileContext }
}

const call = async (state, body) => {
  const response = await state.spec.fetch({ json: async () => body })
  return { status: response.status, payload: await response.json() }
}

const patchText = async () => {
  try {
    return await readFile(PATCH, 'utf8')
  } catch {
    return ''
  }
}
const occurrences = (text, needle) => text.split(needle).length - 1

// --- the route registers -------------------------------------------------
{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  check('a route spec is registered', state.spec !== null)
  check('route path matches the client', state.spec !== null && state.spec.path === '/api/context-compression-panel/policy')
  check('route accepts POST', state.spec !== null && eq(state.spec.methods, ['POST']))
  check('route buffers the body', state.spec !== null && state.spec.requestBody === 'buffered')
  check('route has a fetch handler', state.spec !== null && typeof state.spec.fetch === 'function')
}

// --- read finds the engine entry -----------------------------------------
{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.65, retainRatio: 0.2 } }])
  const { status, payload } = await call(state, { action: 'read' })
  check('read answers 200', status === 200)
  check('read answers ok:true', payload.ok === true)
  check('read finds the entry through loader.entries()', payload.value.found === true)
  check('read reports the trigger as a percentage', payload.value.timing === 65)
  check('read reports the retained share as a percentage', payload.value.retain === 20)
  check('read reports the entry id', payload.value.entryId === 'compaction-basic')
}

{
  // A row composed by the include layer can lose its bare id; the package name
  // still identifies it.
  const { state } = makeHost([{ id: 'include:compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.5 } }])
  const { payload } = await call(state, { action: 'read' })
  check('a name match is found too', payload.value.found === true)
  check('the name-matched entry is read', payload.value.timing === 50)
}

{
  const { state } = makeHost([
    { id: 'compaction-basic', name: 'x', config: {}, active: false },
    { id: 'compaction-basic', name: 'x', config: { thresholdRatio: 0.9 } },
  ])
  const { payload } = await call(state, { action: 'read' })
  check('the active entry wins over a disabled duplicate', payload.value.timing === 90)
}

// --- read falls back to the shipped defaults ------------------------------
{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  const { payload } = await call(state, { action: 'read' })
  check('a bare entry reads as the shipped 80/16', payload.value.timing === 80 && payload.value.retain === 16)
  check('a bare entry keeps auto on', payload.value.auto === true)
  check('a bare entry reports the default headroom', payload.value.headroomTokens === 65536)
}

{
  const { state } = makeHost([{ id: 'some-other-plugin', name: '@deepseek-ai/dsh-something', config: {} }])
  const { payload } = await call(state, { action: 'read' })
  check('no compaction entry reads as found:false', payload.value.found === false)
  check('no compaction entry still answers ok:true for a read', payload.ok === true)
}

// --- apply reaches the entry and keeps foreign keys ----------------------
{
  const { state } = makeHost([{
    id: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    config: { retainTokens: 2048, headroomTokens: 65536 },
  }])
  const { payload } = await call(state, { action: 'apply', policy: { auto: true, timing: 65, retain: 20 } })
  check('apply answers ok:true', payload.ok === true)
  check('apply reached the loader entry', state.updates.length === 1)
  check('apply wrote the trigger as a ratio', state.updates[0].next.config.thresholdRatio === 0.65)
  check('apply wrote the retained share as a ratio', state.updates[0].next.config.retainRatio === 0.2)
  check('apply wrote auto', state.updates[0].next.config.auto === true)
  check('apply dropped the exclusive retainTokens', Object.prototype.hasOwnProperty.call(state.updates[0].next.config, 'retainTokens') === false)
  check('apply left headroomTokens alone', state.updates[0].next.config.headroomTokens === 65536)
  check('apply reports the landed policy', payload.value.timing === 65 && payload.value.retain === 20)
  check('apply reports the persistence outcome', payload.value.persisted === 'written')
  const text = await patchText()
  check('apply persisted a marked row', text.includes('# dsh-context-compression-panel:begin'))
  check('apply closed the marked row', text.includes('# dsh-context-compression-panel:end'))
  check('apply persisted the compaction id', text.includes('- id: compaction-basic'))
  check('apply persisted the package name', text.includes('name: "@deepseek-ai/dsh-compaction-basic"'))
  check('apply persisted the trigger ratio', text.includes('thresholdRatio: 0.65'))
  check('apply persisted the retained share', text.includes('retainRatio: 0.2'))
}

// --- switching auto off --------------------------------------------------
{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  const { payload } = await call(state, { action: 'apply', policy: { auto: false, timing: 80, retain: 16 } })
  check('auto:false is written to the engine', state.updates[0].next.config.auto === false)
  check('auto:false is reported back', payload.value.auto === false)
  const text = await patchText()
  check('auto:false is persisted', text.includes('auto: false'))
}

// --- percentages are clamped --------------------------------------------
{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  await call(state, { action: 'apply', policy: { timing: 200, retain: 90 } })
  check('timing clamps to 95%', state.updates[0].next.config.thresholdRatio === 0.95)
  check('retain clamps to 50%', state.updates[0].next.config.retainRatio === 0.5)
}

{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  await call(state, { action: 'apply', policy: { timing: 2, retain: 1 } })
  check('timing clamps up to 10%', state.updates[0].next.config.thresholdRatio === 0.1)
  check('retain clamps up to 4%', state.updates[0].next.config.retainRatio === 0.04)
}

{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  await call(state, { action: 'apply', policy: { timing: 20, retain: 45 } })
  check('retain is pulled below the trigger', state.updates[0].next.config.retainRatio <= 0.19)
  check('a pulled retain stays above the floor', state.updates[0].next.config.retainRatio >= 0.04)
}

// --- an engine refusal is reported, not saved --------------------------
{
  await writeFile(PATCH, '[]\n', 'utf8')
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {}, fail: '保留比例不小于阈值比例' }])
  const { payload } = await call(state, { action: 'apply', policy: { auto: true, timing: 40, retain: 36 } })
  check('a refused write answers ok:false', payload.ok === false)
  check('the engine message is passed through', payload.error.message === '保留比例不小于阈值比例')
  check('the refusal is coded', payload.error.code === 'engine-refused')
  check('a refused write leaves the patch byte-identical', (await patchText()) === '[]\n')
  const diag = JSON.parse(await readFile(DIAG, 'utf8'))
  check('a refused write dumps diagnostics', diag.phase === 'apply-update')
  check('diagnostics keep the entry snapshot', Array.isArray(diag.snapshot.entries))
}

// --- the persisted row is replaced, not duplicated --------------------
{
  await writeFile(PATCH, '- id: better-sidebar\n  config:\n    open: true\n', 'utf8')
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  await call(state, { action: 'apply', policy: { auto: true, timing: 70, retain: 10 } })
  await call(state, { action: 'apply', policy: { auto: true, timing: 60, retain: 12 } })
  const text = await patchText()
  check('the marked row appears exactly once', occurrences(text, '# dsh-context-compression-panel:begin') === 1)
  check('the last write wins', text.includes('thresholdRatio: 0.6'))
  check('an earlier write is gone', text.includes('thresholdRatio: 0.7') === false)
  check('foreign rows are preserved', text.includes('- id: better-sidebar'))
  check('foreign config is preserved', text.includes('open: true'))
}

// --- resetting to defaults leaves no residue -------------------------
{
  await writeFile(PATCH, '- id: better-sidebar\n  config:\n    open: true\n', 'utf8')
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  await call(state, { action: 'apply', policy: { auto: true, timing: 70, retain: 10 } })
  const { payload } = await call(state, { action: 'apply', policy: { auto: true, timing: 80, retain: 16 } })
  check('restoring the defaults reports cleared', payload.value.persisted === 'cleared')
  const text = await patchText()
  check('restoring the defaults clears the marked row', text.includes('# dsh-context-compression-panel:begin') === false)
  check('the user file survives the reset', text.includes('- id: better-sidebar'))
}

{
  // A patch that held nothing but our row must stay a valid sequence.
  await writeFile(PATCH, '[]\n', 'utf8')
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }])
  await call(state, { action: 'apply', policy: { auto: true, timing: 70, retain: 10 } })
  await call(state, { action: 'apply', policy: { auto: true, timing: 60, retain: 12 } })
  await call(state, { action: 'apply', policy: { auto: true, timing: 80, retain: 16 } })
  check('an emptied patch stays a valid sequence', (await patchText()).trim() === '[]')
}

// --- a missing entry refuses the write ---------------------------------
{
  await writeFile(PATCH, '[]\n', 'utf8')
  const { state } = makeHost([])
  const { payload } = await call(state, { action: 'apply', policy: { auto: true, timing: 80, retain: 16 } })
  check('a missing entry refuses the write', payload.ok === false)
  check('the refusal names the entry', String(payload.error.message).includes('compaction-basic'))
  check('the refusal is coded as missing', payload.error.code === 'missing-entry')
  check('no update was attempted', state.updates.length === 0)
  check('a missing entry leaves the patch alone', (await patchText()) === '[]\n')
}

// --- a runtime without the route API degrades quietly ----------------
{
  const { state } = makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} }], { noRoute: true })
  check('a runtime without fetch.register registers nothing', state.spec === null)
}

// --- boot leaves a snapshot and writes no patch ---------------------
{
  await rm(PATCH, { force: true })
  await makeHost([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.75 } }])
  await sleep(100)
  const diag = JSON.parse(await readFile(DIAG, 'utf8'))
  check('boot writes a diagnostics snapshot', diag.phase === 'boot')
  check('diagnostics name the patch file', diag.patchPath === PATCH)
  check('diagnostics record the live target policy', diag.target.timing === 75)
  check('diagnostics list the engine entries', Array.isArray(diag.snapshot.entries) && diag.snapshot.entries.length >= 1)
  check('diagnostics flag the compaction entry', diag.snapshot.compaction.length === 1)
  check('boot writes no patch on its own', (await patchText()) === '')
}

// --- nothing extra is left in the profile dir -----------------------
{
  const files = await listFiles()
  check('no temp patch file is left behind', files.some((name) => name.endsWith('.tmp')) === false)
  check('only the patch and the diagnostic file exist', files.every((name) => name === 'cordis.patch.yml' || name === '.context-compression-panel.diag.json'))
}

// --- cleanup ---------------------------------------------------------
await rm(workDir, { recursive: true, force: true })

if (failures.length === 0) {
  console.log(`ok - ${passed} checks passed`)
} else {
  console.error(`not ok - ${failures.length} failed, ${passed} passed`)
  for (const label of failures) console.error(`  - ${label}`)
  process.exitCode = 1
}
