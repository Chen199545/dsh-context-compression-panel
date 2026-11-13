/**
 * Zero-dependency behaviour test for dsh-context-compression-panel.
 *
 * Runs the browser half in Node with a stubbed module loader, React runtime,
 * DOM and fetch, then asserts on everything that can be checked without a
 * browser:
 *
 *   - the module registers under the expected loader id and returns its exports
 *     (a missing `return module.exports` silently yields an inert plugin)
 *   - `apply()` registers both slots, and survives a missing slot by recording
 *     the failure instead of throwing
 *   - the percentage bands clamp in both directions, and retain always stays
 *     below the trigger (the engine refuses the whole config otherwise)
 *   - the route call uses the documented URL/method/envelope, and a Host refusal
 *     surfaces its own message instead of being swallowed
 *
 * Usage: node test/smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let captured = null
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
  body: {},
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
}

const code = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function(code)()

if (captured === null) throw new Error('client.js never called window.__ModuleLoader__.load')
if (captured.id !== 'dsh-context-compression-panel') throw new Error(`unexpected module id: ${captured.id}`)

const jsxStub = (type, props, key) => ({ type, props, key })
const requireStub = (name) => {
  if (name === 'react') {
    return {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: (initial) => ({ current: initial === undefined ? null : initial }),
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      createElement: jsxStub,
    }
  }
  if (name === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub }
  if (name === 'react-dom') return { createPortal: (node) => ({ portal: node }) }
  throw new Error(`unexpected require("${name}") -- the plugin must stay dependency-free`)
}

const plugin = captured.factory(requireStub)

// --- assertion helpers -----------------------------------------------------
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

// --- module shape ---------------------------------------------------------
check('factory returns an exports object', plugin !== null && typeof plugin === 'object')
check('apply is a function', typeof plugin.apply === 'function')
check('inject declares slots only', eq(plugin.inject, ['slots']))

// --- a fake Host -----------------------------------------------------------
function makeCtx(declared) {
  const registrations = []
  const slots = {
    inject(name, callback) {
      if (!declared.includes(name)) throw new Error(`slot "${name}" is not declared`)
      return callback()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  }
  const ctx = {
    registrations,
    inject(services, callback) {
      return callback({ slots })
    },
    effect: () => {},
  }
  return ctx
}

// --- apply() with both slots declared ------------------------------------
{
  const ctx = makeCtx(['conversation.input.right', 'settings.general.item'])
  plugin.apply(ctx)

  const names = ctx.registrations.map((entry) => entry.spec.name)
  check('registers the composer chip', names.includes('conversation.input.right'))
  check('registers the settings row', names.includes('settings.general.item'))
  check('registrations carry no stale service props', ctx.registrations.every((entry) => entry.spec.inject === undefined))
  const chip = ctx.registrations.find((entry) => entry.spec.name === 'conversation.input.right')
  check('chip registration carries its id', chip !== undefined && chip.spec.id === 'context-compression-chip')
  check('chip component is a function', chip !== undefined && typeof chip.component === 'function')
  const row = ctx.registrations.find((entry) => entry.spec.name === 'settings.general.item')
  check('settings row carries its id', row !== undefined && row.spec.id === 'context-compression-row')
}

// --- apply() must not throw when no slot is declared ---------------------
{
  const ctx = makeCtx([])
  let threw = false
  try {
    plugin.apply(ctx)
  } catch {
    threw = true
  }
  check('apply survives missing slots', threw === false)
  check('apply records the failure instead of throwing', globalThis.__dshContextPanel.failures.length > 0)
}

// --- percentage policy ---------------------------------------------------
const diag = globalThis.__dshContextPanel
check('diagnostics object is published', diag !== undefined && typeof diag.normalizePolicy === 'function')
check('diagnostics name the Host route', diag.route === 'api/context-compression-panel/policy')
check('diagnostics publish the bands', eq(diag.bands, { timing: [10, 95], retain: [4, 50] }))

{
  const shipped = diag.normalizePolicy({ thresholdRatio: 0.8, retainRatio: 0.16, auto: true })
  check('shipped defaults read as 80% / 16%', shipped.timing === 80 && shipped.retain === 16)
  check('shipped defaults keep auto on', shipped.auto === true)

  const empty = diag.normalizePolicy(undefined)
  check('an absent value falls back to 80/16', empty.timing === 80 && empty.retain === 16)

  const off = diag.normalizePolicy({ auto: false, thresholdRatio: 0.8, retainRatio: 0.16 })
  check('auto:false survives normalisation', off.auto === false)

  const high = diag.normalizePolicy({ thresholdRatio: 2, retainRatio: 0.9 })
  check('timing clamps to 95%', high.timing === 95)
  check('retain clamps to 50%', high.retain === 50)

  const low = diag.normalizePolicy({ thresholdRatio: 0.01, retainRatio: 0 })
  check('timing clamps up to 10%', low.timing === 10)
  check('retain clamps up to 4%', low.retain === 4)
  check('a tiny threshold still keeps retain below it', low.retain <= low.timing - 1)
}

// --- an edit never leaves retain at or above the threshold ---------------
{
  const base = diag.normalizePolicy({ thresholdRatio: 0.8, retainRatio: 0.16 })
  const pulled = diag.withPolicy(base, { timing: 12 })
  check('lowering the threshold pulls retain down', pulled.timing === 12 && pulled.retain <= 11)
  check('lowered retain never drops below 4%', pulled.retain >= 4)

  const raised = diag.withPolicy(base, { retain: 46 })
  check('raising retain is allowed up to 50%', raised.retain === 46)
  check('the threshold is untouched by a retain edit', raised.timing === 80)

  const pushed = diag.withPolicy(base, { retain: 96 })
  check('retain clamps to 50%', pushed.retain === 50)

  const below = diag.withPolicy(base, { timing: 4 })
  check('a threshold below the band clamps to 10%', below.timing === 10)

  const toggled = diag.withPolicy(base, { auto: false })
  check('toggling auto keeps the numbers', toggled.auto === false && toggled.timing === 80 && toggled.retain === 16)
}

// --- captions tell the truth --------------------------------------------
check('off caption points at /compact', diag.captionOf({ auto: false, timing: 80, retain: 16 }).includes('/compact'))
check('active caption reports the timing', diag.captionOf({ auto: true, timing: 65, retain: 16 }).includes('65%'))
check('active caption reports the retained share', diag.captionOf({ auto: true, timing: 65, retain: 16 }).includes('16%'))

// --- colour ramp moves with the setting --------------------------------
{
  const late = diag.lookOfPolicy({ auto: true, timing: 10, retain: 4 })
  const early = diag.lookOfPolicy({ auto: true, timing: 95, retain: 20 })
  const offLook = diag.lookOfPolicy({ auto: false, timing: 80, retain: 16 })
  check(
    'every policy yields an accent colour',
    [late, early, offLook].every((look) => typeof look.accent === 'string' && look.accent.startsWith('rgb(')),
  )
  check('late and early accents differ', late.accent !== early.accent)
  check('off uses its own grey accent', offLook.accent !== early.accent)
}

// --- the Host route contract -------------------------------------------
{
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { thresholdRatio: 0.65, retainRatio: 0.2, auto: true } }) }
  }
  const value = await diag.callRoute({ action: 'apply', policy: { auto: true, timing: 65, retain: 20 } })
  check('route url is relative to the app root', calls.length === 1 && calls[0].url === 'api/context-compression-panel/policy')
  check('route is called with POST', calls[0].init.method === 'POST')
  check('route is called with a JSON body', eq(JSON.parse(calls[0].init.body), { action: 'apply', policy: { auto: true, timing: 65, retain: 20 } }))
  check('route returns the Host value', eq(value, { thresholdRatio: 0.65, retainRatio: 0.2, auto: true })
    || (value.thresholdRatio === 0.65 && value.retainRatio === 0.2))
}

{
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: { code: 'context-compression-panel', message: '保留比例不小于阈值比例' } }),
  })
  let message = null
  try {
    await diag.callRoute({ action: 'apply', policy: { auto: true, timing: 10, retain: 20 } })
  } catch (error) {
    message = error.message
  }
  check('an HTTP failure is raised, not swallowed', message !== null && message.includes('500'))
}

{
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: { message: '保留比例不小于阈值比例' } }),
  })
  let message = null
  try {
    await diag.callRoute({ action: 'apply', policy: { auto: true, timing: 10, retain: 20 } })
  } catch (error) {
    message = error.message
  }
  check('a Host refusal surfaces its own reason', message === '保留比例不小于阈值比例')
}

{
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  let message = null
  try {
    await diag.callRoute({ action: 'read' })
  } catch (error) {
    message = error.message
  }
  check('a transport failure is reported as such', message !== null && message.includes('连不上 Host 接口'))
}

// --- report -------------------------------------------------------------
if (failures.length === 0) {
  console.log(`ok - ${passed} checks passed`)
} else {
  console.error(`not ok - ${failures.length} failed, ${passed} passed`)
  for (const label of failures) console.error(`  - ${label}`)
  process.exitCode = 1
}
