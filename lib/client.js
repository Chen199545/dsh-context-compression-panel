/**
 * dsh-context-compression-panel - browser half (v3).
 *
 * A small card in the composer: two exact percentage fields (when to compress /
 * how much to keep) and one auto-compression switch. No rail, no fake control -
 * the two fields are the control.
 *
 * Writes go to the Host half over one route:
 *
 *   POST api/context-compression-panel/policy
 *   { action: 'read' }                                   -> { ok, value }
 *   { action: 'apply', policy: { auto, timing, retain } } -> { ok, value }
 *
 * A refusal comes back as `{ ok:false, error }` and is shown in the card, so a
 * rejected value can never look like a saved one.
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-compression-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { createPortal } = require('react-dom')

    const LOG = '[dsh-context-compression-panel]'

    /** The Host half's route (relative to the app root, like DSH's own panels). */
    const ROUTE = 'api/context-compression-panel/policy'

    const COMPOSER_SLOT = 'conversation.input.right'
    const SETTINGS_SLOT = 'settings.general.item'
    const DIAG_KEY = '__dshContextPanel'

    /** Percentage bands. 10-95% for the trigger; 4-50% for verbatim retention, the
     *  band the engine's own 16% default sits in. */
    const TIMING_MIN = 10
    const TIMING_MAX = 95
    const RETAIN_MIN = 4
    const RETAIN_MAX = 50
    /** Retain must stay at least this many points below the trigger. */
    const MIN_GAP = 1

    const DEFAULT_POLICY = { auto: true, timing: 80, retain: 16 }

    /** Typing pause before a field is written; long enough to not rewrite the
     *  profile patch on every keystroke, short enough to feel immediate. */
    const COMMIT_DELAY = 700

    // ---------------------------------------------------------------------
    // Failure ledger: a silent error looks exactly like "it never worked".
    // ---------------------------------------------------------------------
    const failures = []
    function record(phase, error) {
      const entry = { phase, message: String(error && error.message ? error.message : error), at: new Date().toISOString() }
      failures.push(entry)
      if (failures.length > 20) failures.shift()
      try {
        console.error(`${LOG} ${phase} failed`, error)
      } catch {}
      return entry
    }

    // ---------------------------------------------------------------------
    // Pure policy helpers (also exported for the smoke test and the console).
    // ---------------------------------------------------------------------
    const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)
    const clamp01 = (value) => clamp(value, 0, 1)
    const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
    const messageOf = (error) => String(error && error.message ? error.message : error)

    /**
     * Turn a raw Host value into the panel's percentage policy, clamped so the
     * engine cannot reject it: retain always sits below the trigger.
     * @param raw - `{auto, thresholdRatio, retainRatio}` as the Host reports it.
     * @returns {{auto: boolean, timing: number, retain: number}} in percent.
     */
    function normalizePolicy(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const auto = source.auto !== false
      const rawTiming = isNumber(source.thresholdRatio) ? source.thresholdRatio * 100 : DEFAULT_POLICY.timing
      const timing = Math.round(clamp(rawTiming, TIMING_MIN, TIMING_MAX))
      const rawRetain = isNumber(source.retainRatio) ? source.retainRatio * 100 : DEFAULT_POLICY.retain
      const ceiling = Math.max(RETAIN_MIN, Math.min(RETAIN_MAX, timing - MIN_GAP))
      const retain = Math.round(clamp(rawRetain, RETAIN_MIN, ceiling))
      return { auto, timing, retain }
    }

    /**
     * Coalesce a partial change onto a policy, keeping retain below the trigger
     * when the trigger moves down past the retained share.
     * @param policy - current percentage policy.
     * @param patch - fields to override (`{auto?, timing?, retain?}`).
     * @returns a new, always-valid percentage policy.
     */
    function withPolicy(policy, patch) {
      const next = {
        auto: patch.auto === undefined ? policy.auto : patch.auto !== false,
        timing: isNumber(patch.timing) ? Math.round(clamp(patch.timing, TIMING_MIN, TIMING_MAX)) : policy.timing,
        retain: isNumber(patch.retain) ? Math.round(clamp(patch.retain, RETAIN_MIN, RETAIN_MAX)) : policy.retain,
      }
      if (next.retain > next.timing - MIN_GAP) next.retain = Math.max(RETAIN_MIN, next.timing - MIN_GAP)
      return next
    }

    /** One-line plain-language caption for the live policy. */
    function captionOf(policy, busy) {
      if (busy === true) return '写入中…'
      if (policy.auto === false) return '自动压缩已关闭 · 只在你输入 /compact 时压缩一次'
      return `上下文用掉 ${policy.timing}% 时压缩，压缩后逐字保留最近 ${policy.retain}%`
    }

    // ---------------------------------------------------------------------
    // Colour ramp across the trigger band: cool blue when it compresses late,
    // amber when it compresses early.
    // ---------------------------------------------------------------------
    const STOPS = [
      { at: 0, to: [59, 130, 246] },
      { at: 0.5, to: [168, 85, 247] },
      { at: 1, to: [249, 115, 22] },
    ]
    const OFF_ACCENT = 'rgb(148, 163, 184)'
    const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t))
    const rgbOf = (channels) => `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`

    /** Accent colour at a fractional position across the trigger band. */
    function lookOf(t) {
      const p = clamp01(t)
      let index = 0
      while (index < STOPS.length - 2 && p > STOPS[index + 1].at) index += 1
      const low = STOPS[index]
      const high = STOPS[index + 1]
      const span = high.at - low.at
      const local = span <= 0 ? 0 : clamp01((p - low.at) / span)
      const tint = mix(low.to, high.to, local)
      return { accent: rgbOf(tint), tint }
    }

    const lookOfPolicy = (policy) => (policy.auto === false
      ? { accent: OFF_ACCENT, tint: [148, 163, 184] }
      : lookOf((policy.timing - TIMING_MIN) / (TIMING_MAX - TIMING_MIN)))

    // ---------------------------------------------------------------------
    // Styles.
    // ---------------------------------------------------------------------
    const CSS = `
.ccp-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:999px;border:1px solid var(--ccp-chipBorder,rgba(15,23,42,.12));background:var(--ccp-chipBg,rgba(255,255,255,.72));color:var(--ccp-text,#1f2430);font:inherit;font-size:12px;line-height:1;cursor:pointer;flex:none;transition:background .15s,border-color .15s}
.ccp-chip:hover{background:var(--ccp-chipHover,rgba(255,255,255,.95))}
.ccp-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ccp-focus,rgba(77,107,254,.55))}
.ccp-chipDot{width:7px;height:7px;border-radius:50%;flex:none}
.ccp-chipName{font-weight:500;letter-spacing:.2px}
.ccp-chipValue{font-weight:600;font-variant-numeric:tabular-nums}
.ccp-card{position:fixed;z-index:2147483000;width:320px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:12px 16px 14px;border-radius:16px;border:1px solid var(--ccp-border,rgba(15,23,42,.1));background:var(--ccp-surface,#fff);color:var(--ccp-text,#1f2430);box-shadow:0 20px 50px rgba(15,23,42,.2);font-family:inherit;font-size:13px;line-height:1.4;-webkit-font-smoothing:antialiased}
.ccp-head{position:relative;display:flex;justify-content:center;align-items:center;min-height:30px}
.ccp-title{font-size:24px;font-weight:600;line-height:28px;letter-spacing:.3px;font-variant-numeric:tabular-nums}
.ccp-refresh{position:absolute;right:-6px;top:0;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:9px;background:transparent;color:var(--ccp-muted,#8b8d99);cursor:pointer}
.ccp-refresh:hover{background:var(--ccp-hover,rgba(15,23,42,.06));color:var(--ccp-text,#1f2430)}
.ccp-refresh:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ccp-focus,rgba(77,107,254,.55))}
.ccp-refresh[data-spin=true] svg{animation:ccp-spin .55s ease}
@keyframes ccp-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.ccp-sub{text-align:center;font-size:12px;color:var(--ccp-muted,#8b8d99)}
.ccp-subLink{cursor:pointer}
.ccp-inputs{display:flex;gap:12px;margin-top:16px}
.ccp-field{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:5px}
.ccp-fieldLabel{font-size:11px;color:var(--ccp-muted,#8b8d99)}
.ccp-inputWrap{position:relative;display:flex;align-items:center}
.ccp-input{box-sizing:border-box;width:100%;height:32px;padding:0 24px 0 10px;border-radius:9px;border:1px solid var(--ccp-border,rgba(15,23,42,.12));background:var(--ccp-fieldBg,rgba(15,23,42,.04));color:inherit;font:inherit;font-size:13px;font-variant-numeric:tabular-nums}
.ccp-input:hover{border-color:var(--ccp-borderHover,rgba(15,23,42,.2))}
.ccp-input:focus{outline:none;border-color:var(--ccp-accent,#4d6bfe);box-shadow:0 0 0 3px var(--ccp-focus,rgba(77,107,254,.14))}
.ccp-unit{position:absolute;right:9px;font-size:11px;color:var(--ccp-muted,#8b8d99);pointer-events:none}
.ccp-auto{display:flex;align-items:center;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px solid var(--ccp-border,rgba(15,23,42,.1))}
.ccp-autoText{display:flex;flex-direction:column;gap:2px}
.ccp-autoTitle{font-size:12px}
.ccp-autoHint{font-size:10px;color:var(--ccp-muted,#8b8d99)}
.ccp-switch{position:relative;flex:none;width:38px;height:22px;border-radius:999px;border:0;padding:0;cursor:pointer;background:rgba(127,127,127,.28);transition:background .16s}
.ccp-switch[data-on=true]{background:var(--ccp-accent,#4d6bfe)}
.ccp-switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ccp-focus,rgba(77,107,254,.55))}
.ccp-switch i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .16s;box-shadow:0 1px 3px rgba(15,23,42,.3)}
.ccp-switch[data-on=true] i{transform:translateX(16px)}
.ccp-caption{margin-top:10px;text-align:center;font-size:10.5px;line-height:15px;color:var(--ccp-muted,#8b8d99)}
.ccp-warn{margin-top:8px;padding:6px 8px;border-radius:8px;background:var(--ccp-warnBg,rgba(255,176,32,.14));color:var(--ccp-warnText,#8a5300);font-size:11px;line-height:15px;word-break:break-word}
.ccp-setting{display:flex;align-items:center;gap:12px;padding:12px 0;min-width:0}
.ccp-settingText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.ccp-settingTitle{font-size:13px;line-height:20px}
.ccp-settingHint{font-size:11px;line-height:16px;opacity:.72}
.ccp-settingFields{flex:none;display:flex;align-items:center;gap:6px}
.ccp-mini{width:56px;height:26px;padding:0 6px;border-radius:7px;border:1px solid var(--ccp-border,rgba(15,23,42,.12));background:transparent;color:inherit;font:inherit;font-size:12px}
.ccp-mini:focus{outline:none;border-color:var(--ccp-accent,#4d6bfe)}
body[data-ds-dark-theme] .ccp-card{--ccp-surface:#1e1f24;--ccp-border:rgba(255,255,255,.09);--ccp-borderHover:rgba(255,255,255,.2);--ccp-text:#e7e8ee;--ccp-muted:#8b8d99;--ccp-accent:#7b93ff;--ccp-hover:rgba(255,255,255,.08);--ccp-focus:rgba(123,147,255,.35);--ccp-fieldBg:rgba(255,255,255,.06);--ccp-warnBg:rgba(255,176,32,.16);--ccp-warnText:#ffce7a}
body[data-ds-dark-theme] .ccp-chip{--ccp-chipBorder:rgba(255,255,255,.1);--ccp-chipBg:rgba(255,255,255,.06);--ccp-chipHover:rgba(255,255,255,.12);--ccp-text:#e7e8ee;--ccp-focus:rgba(123,147,255,.6)}
`
    const TAG_ID = 'dsh-context-compression-panel/styles.css'
    const installStyles = () => {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-context-compression-panel'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    installStyles()

    /** Refresh glyph, drawn rather than imported (no icon dependency). */
    const RefreshIcon = () => jsxs('svg', {
      width: 17,
      height: 17,
      viewBox: '0 0 20 20',
      fill: 'none',
      children: [
        jsx('path', {
          d: 'M16.4 8.6A6.6 6.6 0 1 1 14 4.2',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }, 'arc'),
        jsx('path', {
          d: 'M16.9 3.4v3.6h-3.6',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }, 'head'),
      ],
    })

    // ---------------------------------------------------------------------
    // Transport.
    // ---------------------------------------------------------------------
    /**
     * Call the Host route.
     * @param body - `{action: 'read'}` or `{action: 'apply', policy}`.
     * @returns the value the Host reports after the call.
     * @throws when the route is missing or the Host refuses the write.
     */
    async function callRoute(body) {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        throw new Error(`连不上 Host 接口（${messageOf(error)}）`)
      }
      if (response.status === 404) throw new Error('Host 半没有注册路由（完全退出 DSH 再打开试试）')
      if (!response.ok) throw new Error(`Host 接口返回 HTTP ${response.status}`)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error('Host 接口返回的不是 JSON')
      }
      if (payload === null || payload.ok !== true) {
        const reason = payload !== null && payload.error !== null && typeof payload.error === 'object'
          ? payload.error.message
          : undefined
        throw new Error(reason === undefined ? 'Host 接口拒绝了这次请求' : String(reason))
      }
      return payload.value
    }

    /**
     * Shared policy view: reads the Host's policy, paints edits optimistically,
     * then keeps whatever the Host actually applied.
     * @param active - bump to re-read (mount, panel open, refresh).
     */
    function usePolicy(active) {
      const [state, setState] = react.useState({
        status: 'loading',
        policy: DEFAULT_POLICY,
        error: null,
        busy: false,
        source: null,
      })

      const read = react.useCallback(async () => {
        try {
          const value = await callRoute({ action: 'read' })
          setState({
            status: 'ready',
            policy: normalizePolicy(value),
            error: value !== null && typeof value === 'object' && typeof value.error === 'string' ? value.error : null,
            busy: false,
            source: value,
          })
        } catch (error) {
          record('read', error)
          setState((previous) => ({ ...previous, status: 'error', error: messageOf(error), busy: false }))
        }
      }, [])

      react.useEffect(() => {
        read()
      }, [read, active])

      const commit = react.useCallback((nextPolicy, label) => {
        setState((previous) => ({ ...previous, policy: nextPolicy, busy: true, error: null }))
        callRoute({ action: 'apply', policy: { auto: nextPolicy.auto, timing: nextPolicy.timing, retain: nextPolicy.retain } })
          .then((value) => {
            setState({
              status: 'ready',
              policy: normalizePolicy(value),
              error: value !== null && typeof value === 'object' && typeof value.error === 'string' ? value.error : null,
              busy: false,
              source: value,
            })
          })
          .catch((error) => {
            record('apply', error)
            setState((previous) => ({
              ...previous,
              busy: false,
              error: `${label === undefined ? '写入' : `${label}未生效`}：${messageOf(error)}`,
            }))
            read()
          })
      }, [read])

      return {
        ...state,
        read,
        setError: (message) => setState((previous) => ({ ...previous, error: message })),
        apply: (patch, label) => commit(withPolicy(state.policy, patch), label),
      }
    }

    // ---------------------------------------------------------------------
    // A number field: mirrors the saved value, never fights typing, and writes
    // once typing pauses (or on Enter / blur).
    // ---------------------------------------------------------------------
    function NumberField(props) {
      const { label, value, min, max, suffix, disabled, onCommit } = props
      const [text, setText] = react.useState(String(value))
      const focused = react.useRef(false)
      const timer = react.useRef(null)
      const pending = react.useRef(null)

      const clearTimer = () => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }

      react.useEffect(() => {
        if (!focused.current) setText(String(value))
      }, [value])

      react.useEffect(() => clearTimer, [])

      const parse = (raw) => {
        const parsed = Number.parseFloat(raw)
        return Number.isFinite(parsed) ? Math.round(clamp(parsed, min, max)) : null
      }

      const flush = () => {
        clearTimer()
        const next = parse(text)
        if (next === null) {
          setText(String(value))
          pending.current = null
          return
        }
        setText(String(next))
        pending.current = null
        if (Math.abs(next - value) >= 0.5) onCommit(next)
      }

      return jsxs('label', {
        className: 'ccp-field',
        children: [
          jsx('span', { className: 'ccp-fieldLabel', children: label }, 'label'),
          jsxs('div', {
            className: 'ccp-inputWrap',
            children: [
              jsx('input', {
                className: 'ccp-input',
                type: 'text',
                inputMode: 'numeric',
                value: text,
                disabled: disabled === true,
                'aria-label': label,
                onChange: (event) => {
                  const raw = event.target.value
                  setText(raw)
                  const next = parse(raw)
                  pending.current = next
                  clearTimer()
                  if (next === null) return
                  // Write after the typing pause, once the number is complete.
                  timer.current = setTimeout(() => {
                    timer.current = null
                    const settled = pending.current
                    pending.current = null
                    if (settled !== null && Math.abs(settled - value) >= 0.5) onCommit(settled)
                  }, COMMIT_DELAY)
                },
                onFocus: () => { focused.current = true },
                onBlur: () => {
                  focused.current = false
                  flush()
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  event.currentTarget.blur()
                },
              }, 'input'),
              jsx('span', { className: 'ccp-unit', children: suffix }, 'unit'),
            ],
          }, 'wrap'),
        ],
      })
    }

    /** Portal anchor id: unique per seat, so two chips cannot steal each other's
     *  outside-click exemption. */
    let seatSeq = 0

    // ---------------------------------------------------------------------
    // The card.
    // ---------------------------------------------------------------------
    function PolicyCard(props) {
      const { box, anchorId, onClose } = props
      const [active, setActive] = react.useState(0)
      const [spin, setSpin] = react.useState(false)
      const policy = usePolicy(active)
      const cardRef = react.useRef(null)

      const live = policy.policy
      const look = lookOfPolicy(live)
      // Nothing is editable until the Host has said what the engine runs.
      const disabled = policy.status !== 'ready'

      react.useEffect(() => {
        const onDown = (event) => {
          if (cardRef.current !== null && cardRef.current.contains(event.target)) return
          const seat = document.getElementById(anchorId)
          if (seat !== null && seat.contains(event.target)) return
          onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [anchorId, onClose])

      const subText = policy.status === 'error'
        ? '未接上 Host 接口 · 点此看原因'
        : policy.status === 'loading'
          ? '读取中…'
          : live.auto === false
            ? '自动压缩关闭 · 手动 /compact'
            : `压缩时机 · 逐字保留 ${live.retain}%`

      return jsx('div', {
        ref: cardRef,
        className: 'ccp-card',
        style: { right: `${box.right}px`, bottom: `${box.bottom}px` },
        children: jsxs('div', {
          children: [
            jsxs('div', {
              className: 'ccp-head',
              children: [
                jsx('span', {
                  className: 'ccp-title',
                  style: { color: look.accent },
                  children: live.auto === false ? '关闭' : `${live.timing}%`,
                }, 'title'),
                jsx('button', {
                  type: 'button',
                  className: 'ccp-refresh',
                  title: '重新读取引擎实际配置',
                  'data-spin': spin,
                  onClick: () => {
                    setSpin(true)
                    policy.read()
                    setActive((n) => n + 1)
                    setTimeout(() => setSpin(false), 560)
                  },
                  children: jsx(RefreshIcon, {}, 'icon'),
                }, 'refresh'),
              ],
            }, 'head'),
            jsx('div', {
              className: 'ccp-sub' + (policy.status === 'error' ? ' ccp-subLink' : ''),
              children: subText,
              onClick: () => {
                if (policy.status !== 'error') return
                policy.setError(failures.length === 0
                  ? '没有记录到具体原因，先点右上角刷新重试'
                  : `最近一次错误：${failures[failures.length - 1].message}`)
              },
            }, 'sub'),
            jsxs('div', {
              className: 'ccp-inputs',
              children: [
                jsx(NumberField, {
                  label: '触发阈值',
                  value: live.timing,
                  min: TIMING_MIN,
                  max: TIMING_MAX,
                  suffix: '%',
                  disabled,
                  onCommit: (next) => policy.apply({ timing: next }, '触发阈值'),
                }, 'threshold'),
                jsx(NumberField, {
                  label: '保留比例',
                  value: live.retain,
                  min: RETAIN_MIN,
                  max: RETAIN_MAX,
                  suffix: '%',
                  disabled,
                  onCommit: (next) => policy.apply({ retain: next }, '保留比例'),
                }, 'retain'),
              ],
            }, 'inputs'),
            jsxs('div', {
              className: 'ccp-auto',
              children: [
                jsxs('div', {
                  className: 'ccp-autoText',
                  children: [
                    jsx('span', { className: 'ccp-autoTitle', children: '自动压缩' }, 'title'),
                    jsx('span', {
                      className: 'ccp-autoHint',
                      children: live.auto === false ? '关闭后只在 /compact 时压缩' : '到阈值自动压缩一次',
                    }, 'hint'),
                  ],
                }, 'text'),
                jsx('button', {
                  type: 'button',
                  className: 'ccp-switch',
                  'data-on': live.auto !== false,
                  role: 'switch',
                  'aria-checked': live.auto !== false,
                  'aria-label': '自动压缩',
                  disabled,
                  onClick: () => policy.apply({ auto: live.auto === false }, '自动压缩'),
                  children: jsx('i', {}, 'knob'),
                }, 'switch'),
              ],
            }, 'auto'),
            jsx('div', { className: 'ccp-caption', children: captionOf(live, policy.busy) }, 'caption'),
            policy.error !== null
              ? jsx('div', { className: 'ccp-warn', children: policy.error }, 'warn')
              : null,
          ],
        }),
      })
    }

    // ---------------------------------------------------------------------
    // The composer seat: a chip that opens the card.
    // ---------------------------------------------------------------------
    function Seat() {
      const anchorIdRef = react.useRef(null)
      if (anchorIdRef.current === null) {
        seatSeq += 1
        anchorIdRef.current = `dsh-ccp-anchor-${seatSeq}`
      }
      const anchorId = anchorIdRef.current
      const [open, setOpen] = react.useState(false)
      const [box, setBox] = react.useState(null)
      const rootRef = react.useRef(null)
      const policy = usePolicy(0)
      const live = policy.policy
      const look = lookOfPolicy(live)
      const readPolicy = policy.read

      // The Host replays the saved policy at boot; a chip that mounted before that
      // finished would show the engine defaults until someone hit refresh.
      react.useEffect(() => {
        const timer = setTimeout(readPolicy, 2000)
        return () => clearTimeout(timer)
      }, [readPolicy])

      const openCard = react.useCallback(() => {
        const node = rootRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        const right = Math.max(12, Math.round(window.innerWidth - rect.right - 2))
        const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8))
        setBox({ right, bottom })
        setOpen(true)
        readPolicy()
      }, [readPolicy])

      const closeCard = react.useCallback(() => {
        setOpen(false)
        readPolicy()
      }, [readPolicy])

      return jsxs('div', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsxs('button', {
            type: 'button',
            id: anchorId,
            className: 'ccp-chip',
            title: `上下文压缩：触发 ${live.timing}% · 保留 ${live.retain}% · 点击调整`,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            ref: rootRef,
            onClick: () => (open ? closeCard() : openCard()),
            children: [
              jsx('span', {
                className: 'ccp-chipDot',
                style: { background: look.accent },
              }, 'dot'),
              jsx('span', { className: 'ccp-chipName', children: '压缩' }, 'name'),
              jsx('span', {
                className: 'ccp-chipValue',
                style: { color: look.accent },
                children: live.auto === false ? '关' : `${live.timing}%`,
              }, 'value'),
            ],
          }, 'chip'),
          open && box !== null && typeof document !== 'undefined'
            ? createPortal(jsx(PolicyCard, { box, anchorId, onClose: closeCard }, 'card'), document.body)
            : null,
        ],
      }, 'seat')
    }

    // ---------------------------------------------------------------------
    // Settings → General row: same policy, two compact fields.
    // ---------------------------------------------------------------------
    function SettingsRow() {
      const policy = usePolicy(0)
      const live = policy.policy
      const disabled = policy.status !== 'ready'
      const hint = policy.error !== null ? policy.error : captionOf(live, policy.busy)

      return jsxs('div', {
        className: 'ccp-setting',
        children: [
          jsxs('div', {
            className: 'ccp-settingText',
            children: [
              jsx('span', { className: 'ccp-settingTitle', children: '上下文压缩' }, 'title'),
              jsx('span', { className: 'ccp-settingHint', children: hint }, 'hint'),
            ],
          }, 'text'),
          jsxs('div', {
            className: 'ccp-settingFields',
            children: [
              jsx('input', {
                className: 'ccp-mini',
                type: 'text',
                inputMode: 'numeric',
                'aria-label': '触发阈值 %',
                title: '触发阈值 %',
                value: String(live.timing),
                disabled,
                onBlur: (event) => {
                  const parsed = Number.parseFloat(event.target.value)
                  if (Number.isFinite(parsed)) policy.apply({ timing: parsed }, '触发阈值')
                },
              }, 'timing'),
              jsx('input', {
                className: 'ccp-mini',
                type: 'text',
                inputMode: 'numeric',
                'aria-label': '保留比例 %',
                title: '保留比例 %',
                value: String(live.retain),
                disabled,
                onBlur: (event) => {
                  const parsed = Number.parseFloat(event.target.value)
                  if (Number.isFinite(parsed)) policy.apply({ retain: parsed }, '保留比例')
                },
              }, 'retain'),
            ],
          }, 'fields'),
        ],
      })
    }

    // ---------------------------------------------------------------------
    // apply(): register the composer chip, then the settings row when that slot
    // exists. Each half fails independently.
    // ---------------------------------------------------------------------
    function apply(ctx) {
      try {
        ctx.inject(['slots'], (scope) => {
          try {
            scope.slots.inject(COMPOSER_SLOT, () => scope.slots.register(
              { name: COMPOSER_SLOT, id: 'context-compression-chip', order: 6 },
              Seat,
            ))
          } catch (error) {
            record('composer-seat', error)
          }

          try {
            scope.slots.inject(SETTINGS_SLOT, () => scope.slots.register(
              { name: SETTINGS_SLOT, id: 'context-compression-row', order: 14 },
              SettingsRow,
            ))
          } catch (error) {
            record('settings-row', error)
          }
        })
      } catch (error) {
        record('apply', error)
      }

      try {
        globalThis[DIAG_KEY] = {
          version: '3.0.0',
          route: ROUTE,
          bands: { timing: [TIMING_MIN, TIMING_MAX], retain: [RETAIN_MIN, RETAIN_MAX] },
          normalizePolicy,
          withPolicy,
          captionOf,
          lookOfPolicy,
          callRoute,
          failures,
        }
      } catch {}
    }

    /** Slots the chip needs; the Host route is plain HTTP, so nothing else. */
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
