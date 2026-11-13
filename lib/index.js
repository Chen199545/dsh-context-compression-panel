/**
 * dsh-context-compression-panel - Host half (v3).
 *
 * Two things learned the hard way on DSH Desktop 0.2.2-rc.1:
 *
 *  1. `@deepseek-ai/dsh-compaction-basic` declares no volatile config fields, so
 *     the settings service serves no namespace for it. Writing through settings
 *     is impossible by design.
 *  2. `configEditor.edit()` refused this entry. Its `entries()` only returns rows
 *     owned by the root profile include with a unique id, and `edit()` re-checks
 *     that set, so the base-bundle compaction entry fell outside it: reads came
 *     back "not found", writes threw, and the card snapped back to the shipped
 *     80% / 16% on every release.
 *
 * This half drives the Loader directly, which is what DSH itself does when the
 * profile patch changes:
 *
 *   - live apply: `entry.update({ config })` on the compaction entry found in
 *     `loader.entries()`, whatever layer it came from. The Loader re-validates
 *     the config against the plugin's own schema and restarts that plugin, so an
 *     invalid value is rejected with the engine's own message.
 *   - persistence: the same values are written into the active profile patch as a
 *     marked row (`- id: compaction-basic` + config, between BEGIN/END comments).
 *     A root patch row overrides a bundle row by id - this profile already does
 *     exactly that for `ui-settings` and `usage-stats` - so a restart keeps the
 *     setting, and the engine applies it itself instead of trusting a replay.
 *     Setting the values back to the shipped defaults removes the row again,
 *     leaving no residue in the user's file.
 *
 * Browser half calls this over one POST route:
 *
 *   POST /api/context-compression-panel/policy
 *   { action: 'read' }                                   -> { ok, value }
 *   { action: 'apply', policy: { auto, timing, retain } } -> { ok, value }
 *
 * Percentages are the wire format (trigger 10-95, retained share 4-50).
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROUTE = '/api/context-compression-panel/policy'
const TARGET_ID = 'compaction-basic'
const TARGET_NAME = 'dsh-compaction-basic'
const LOG = '[dsh-context-compression-panel]'

const BEGIN = '# dsh-context-compression-panel:begin'
const END = '# dsh-context-compression-panel:end'
const DIAG_FILE = '.context-compression-panel.diag.json'

/** Percent bands, mirroring the client. */
const TIMING_MIN = 10
const TIMING_MAX = 95
const RETAIN_MIN = 4
const RETAIN_MAX = 50
const MIN_GAP = 1

const DEFAULT_RATIOS = { thresholdRatio: 0.8, retainRatio: 0.16 }
const DEFAULT_AUTO = true

export const name = 'dsh-context-compression-panel'

export const inject = []

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const messageOf = (error) => String(error && error.message ? error.message : error)

const log = (phase, error) => {
  try {
    console.error(`${LOG} ${phase}: ${messageOf(error)}`)
  } catch {}
}

const serviceOf = (scope, service) => {
  if (scope === null || scope === undefined) return undefined
  if (typeof scope.get === 'function') return scope.get(service)
  return scope[service]
}

const dirOf = (profileContext) => {
  try {
    return String(profileContext?.dir ?? '')
  } catch {
    return ''
  }
}

const patchPathOf = (profileContext) => {
  try {
    return String(profileContext?.patchPath ?? '')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Locating and reading the engine's compaction entry.
// ---------------------------------------------------------------------------

/** All Loader entries, whatever include layer they came from. */
function loaderEntries(loader) {
  try {
    return [...loader.entries()]
  } catch (error) {
    log('entries', error)
    return []
  }
}

const looksLikeTarget = (options) => {
  if (options === undefined || options === null) return false
  const id = typeof options.id === 'string' ? options.id : ''
  const name = typeof options.name === 'string' ? options.name : ''
  return id.split(':').pop() === TARGET_ID || name === `@deepseek-ai/${TARGET_NAME}` || name.endsWith(`/${TARGET_NAME}`)
}

function findEntry(loader) {
  const rows = loaderEntries(loader)
  const candidates = rows.filter((entry) => entry !== null && entry !== undefined && looksLikeTarget(entry.options))
  // Prefer the one that actually runs; a disabled duplicate is the last resort.
  return candidates.find((entry) => entry.fiber !== undefined) ?? candidates[0] ?? null
}

/** Compact description of everything that matters when a write is refused. */
function snapshot(loader, profileContext) {
  const entries = loaderEntries(loader).map((entry) => ({
    id: entry.options === undefined ? '' : entry.options.id,
    name: entry.options === undefined ? '' : entry.options.name,
    parent: entry.parent && entry.parent.tree && entry.parent.tree.ctx.fiber && entry.parent.tree.ctx.fiber.entry
      ? entry.parent.tree.ctx.fiber.entry.options.id
      : '',
    active: entry.fiber !== undefined,
    config: entry.options === undefined || entry.options.config === null || typeof entry.options.config !== 'object'
      ? null
      : entry.options.config,
  }))
  return {
    at: new Date().toISOString(),
    patchPath: patchPathOf(profileContext),
    total: entries.length,
    entries: entries.slice(0, 400),
    compaction: entries.filter((entry) => looksLikeTarget({ id: entry.id, name: entry.name })),
  }
}

/** The entry's own config, which the include layer already composed for it. */
function entryConfig(entry) {
  const raw = entry === null || entry.options === undefined ? undefined : entry.options.config
  return raw !== null && typeof raw === 'object' ? raw : {}
}

function policyFrom(config) {
  const thresholdRatio = isNumber(config.thresholdRatio) ? config.thresholdRatio : DEFAULT_RATIOS.thresholdRatio
  const retainRatio = isNumber(config.retainRatio) ? config.retainRatio : DEFAULT_RATIOS.retainRatio
  const timing = Math.round(clamp(thresholdRatio * 100, TIMING_MIN, TIMING_MAX))
  const retain = Math.round(clamp(retainRatio * 100, RETAIN_MIN, RETAIN_MAX))
  return {
    auto: config.auto !== false,
    timing,
    retain,
    thresholdRatio,
    retainRatio,
    retainTokens: isNumber(config.retainTokens) ? config.retainTokens : null,
    headroomTokens: isNumber(config.headroomTokens) ? config.headroomTokens : 65536,
  }
}

/** Clamp an incoming percentage policy into a band the engine will accept. */
function sanitizePolicy(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const auto = source.auto !== false
  const timing = Math.round(clamp(isNumber(source.timing) ? source.timing : 80, TIMING_MIN, TIMING_MAX))
  const ceiling = Math.max(RETAIN_MIN, Math.min(RETAIN_MAX, timing - MIN_GAP))
  const retain = Math.round(clamp(isNumber(source.retain) ? source.retain : 16, RETAIN_MIN, ceiling))
  return { auto, timing, retain, thresholdRatio: timing / 100, retainRatio: retain / 100 }
}

/** Engine config from the current one plus the panel's policy. */
function nextConfig(config, policy) {
  const next = {
    ...config,
    auto: policy.auto,
    thresholdRatio: policy.thresholdRatio,
    retainRatio: policy.retainRatio,
  }
  // `retainTokens` is mutually exclusive with `retainRatio`; leaving both set
  // makes the engine refuse the whole config.
  if (Object.prototype.hasOwnProperty.call(next, 'retainTokens')) delete next.retainTokens
  return next
}

const isAtDefaults = (policy) => policy.auto === DEFAULT_AUTO
  && policy.thresholdRatio === DEFAULT_RATIOS.thresholdRatio
  && policy.retainRatio === DEFAULT_RATIOS.retainRatio

// ---------------------------------------------------------------------------
// Persistence: one marked row in the active profile patch.
// ---------------------------------------------------------------------------

const blockFor = (policy) => [
  BEGIN,
  '# 由 dsh-context-compression-panel 维护：删掉这一段即恢复引擎默认值',
  `- id: ${TARGET_ID}`,
  `  name: "@deepseek-ai/${TARGET_NAME}"`,
  '  config:',
  `    auto: ${policy.auto ? 'true' : 'false'}`,
  `    thresholdRatio: ${policy.thresholdRatio}`,
  `    retainRatio: ${policy.retainRatio}`,
  END,
  '',
].join('\n')

/** Remove a previously written block, leaving the rest of the file untouched. */
function stripBlock(text) {
  const begin = text.indexOf(BEGIN)
  if (begin < 0) return text
  const end = text.indexOf(END, begin)
  if (end < 0) return text.slice(0, begin)
  const tail = text.slice(end + END.length)
  return text.slice(0, begin) + (tail.startsWith('\r\n') ? tail.slice(2) : tail.startsWith('\n') ? tail.slice(1) : tail)
}

/**
 * Write (or clear) the marked row in the profile patch.
 * @returns 'written' | 'cleared' | 'skipped'
 */
async function persistPolicy(profileContext, policy) {
  const file = patchPathOf(profileContext)
  if (file === '') return 'skipped'

  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const cleaned = stripBlock(text)
  const outcome = isAtDefaults(policy) ? 'cleared' : 'written'
  let next
  if (isAtDefaults(policy)) {
    next = cleaned.trim() === '' ? '[]\n' : cleaned
  } else {
    const prefix = cleaned.trim() === '' ? '' : cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`
    next = `${prefix}${blockFor(policy)}`
  }
  if (next === text) return outcome

  // Same-volume temp + rename keeps a crash from leaving half a patch behind.
  const temp = `${file}.panel.tmp`
  await writeFile(temp, next, { mode: 0o600 })
  await rename(temp, file)
  return outcome
}

// ---------------------------------------------------------------------------
// Diagnostics: one small file, so a failure can be diagnosed from outside DSH.
// ---------------------------------------------------------------------------

async function dumpDiagnostics(profileContext, payload) {
  const dir = dirOf(profileContext)
  if (dir === '') return
  try {
    await writeFile(join(dir, DIAG_FILE), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    log('diagnostics', error)
  }
}

// ---------------------------------------------------------------------------
// Route.
// ---------------------------------------------------------------------------

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
})

export function apply(ctx) {
  ctx.inject(['connection', 'loader', 'profileContext'], (scope) => {
    const connection = serviceOf(scope, 'connection')
    const loader = serviceOf(scope, 'loader')
    const profileContext = serviceOf(scope, 'profileContext')
    if (connection === undefined || loader === undefined) {
      log('services', new Error('connection 或 loader 不可用，面板无法写入'))
      return
    }
    const register = connection.fetch !== null && connection.fetch !== undefined
      && typeof connection.fetch.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (register === undefined) {
      log('route', new Error('connection.fetch.register 不存在，无法注册面板路由'))
      return
    }

    /** Last failure worth showing in the card, or null. */
    let lastResult = null

    const read = () => {
      const entry = findEntry(loader)
      return {
        ...policyFrom(entryConfig(entry)),
        found: entry !== null,
        entryId: entry === null || entry.options === undefined ? null : entry.options.id,
        error: lastResult,
      }
    }

    const applyPolicy = async (policy) => {
      const entry = findEntry(loader)
      if (entry === null) {
        const reason = `Loader 里找不到 ${TARGET_ID} 条目，未写入`
        lastResult = reason
        log('apply', new Error(reason))
        await dumpDiagnostics(profileContext, { phase: 'apply-missing-entry', snapshot: snapshot(loader, profileContext), policy })
        return { ok: false, reason, code: 'missing-entry' }
      }
      const before = entryConfig(entry)
      try {
        // Live: the Loader validates this against the plugin's own schema and
        // restarts the engine with it. Invalid values throw here.
        await entry.update({ config: nextConfig(before, policy) })
      } catch (error) {
        const reason = messageOf(error)
        lastResult = reason
        log('apply', error)
        await dumpDiagnostics(profileContext, {
          phase: 'apply-update',
          reason,
          before,
          policy,
          snapshot: snapshot(loader, profileContext),
        })
        return { ok: false, reason, code: 'engine-refused' }
      }
      return { ok: true }
    }

    const handler = async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {}
      const action = body !== null && typeof body === 'object' ? body.action : undefined

      if (action !== 'apply') return json({ ok: true, value: read() })

      const requested = sanitizePolicy(body.policy)
      const outcome = await applyPolicy(requested)
      if (!outcome.ok) {
        return json({ ok: false, error: { code: outcome.code, message: outcome.reason }, value: read() })
      }

      let persisted = 'skipped'
      let persistError = null
      try {
        persisted = await persistPolicy(profileContext, requested)
      } catch (error) {
        persistError = messageOf(error)
        log('persist', error)
      }

      lastResult = persistError === null ? null : `已生效，但写入 profile patch 失败：${persistError}`
      if (persistError !== null) {
        await dumpDiagnostics(profileContext, {
          phase: 'persist',
          reason: persistError,
          policy: requested,
          snapshot: snapshot(loader, profileContext),
        })
      }
      return json({ ok: true, value: { ...read(), persisted, error: lastResult } })
    }

    ctx.effect(() => register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handler,
    }), 'dsh-context-compression-panel: policy route')

    // One snapshot per boot, so a panel that cannot write can still be diagnosed
    // from outside DSH: it lists every loader entry with its id, name, parent and
    // live config.
    dumpDiagnostics(profileContext, {
      phase: 'boot',
      patchPath: patchPathOf(profileContext),
      snapshot: snapshot(loader, profileContext),
      target: read(),
    })
  })
}
