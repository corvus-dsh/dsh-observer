/**
 * dsh-observer — the Client half: turn-tail / composer / sidebar entry.
 *
 * LOADER CONTRACT (the shape that actually works on this host):
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-observer',
 *       factory(require, styles, host) { ...; return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * The id is the PLAIN package name. v0.1.14 renamed it to `dsh-observer-v14` and pointed
 * `exports['./client']` at a versioned copy; the next start died with
 * `desktop welcome: Web authentication failed`, so the id and the specifier are stable again.
 * Cache invalidation belongs to the package version, never to renaming this module.
 *
 * NO POLLING. Every command call prints a row into the conversation, so a poll loop floods the
 * transcript in this host. The chip makes exactly ONE command call per click and reads the
 * binding table once on mount. There is no timer in this file, and no session enumeration.
 */

console.log('[dsh-observer] client 0.1.15 loaded (click-only, no polling)')

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  factory(require, styles, host) {
    const React = require('react')
    const h = React.createElement

    /**
     * Normalise a gateway command reply into `{ ok, text }`.
     *
     * Observed shapes:
     *   1. `{ kind: 'success'|'error', text }`   — a command that produces a display line;
     *   2. `{ result: … }`                       — the same, wrapped once;
     *   3. `{ ok: true, value: { commandId } }`  — an ASYNC accept: the command was queued and
     *      its output will not come back here. Treated as accepted, never as a failure.
     */
    const normaliseReply = (value) => {
      const node = value && value.result !== undefined ? value.result : value
      if (node === null || node === undefined) return undefined
      if (typeof node.text === 'string') return { ok: node.kind !== 'error', text: node.text }
      if (typeof node === 'object') return { ok: node.ok !== false && node.kind !== 'error', text: JSON.stringify(node) }
      return undefined
    }

    /** Call one Host command AS the given session — the gateway resolves that id. */
    const makeBridge = (ctx) => {
      const callHost = async (agentId, line) => {
        const remote = (() => {
          try {
            return ctx.get ? ctx.get('remote') : undefined
          } catch {
            return undefined
          }
        })()
        const commands = remote && remote.commands
        if (!commands || typeof commands.execute !== 'function') {
          return { ok: false, text: 'remote.commands 不可用（inject 未生效）' }
        }
        try {
          const settled = await commands.execute(agentId, line, [], undefined)
          const execution = normaliseReply(settled)
          if (execution === undefined) return { ok: false, text: `返回形状无法识别：${JSON.stringify(settled).slice(0, 120)}` }
          return execution
        } catch (error) {
          return { ok: false, text: String((error && error.message) || error) }
        }
      }
      const ui = () => {
        try {
          return ctx.get ? ctx.get('uiWorkspace') : undefined
        } catch (error) {
          /**
           * v0.1.16 — THE REASON A RETURNED ID DID NOT OPEN A WINDOW.
           *
           * `uiWorkspace` was NOT in this plugin's `inject` array, so the Cordis property guard
           * threw `cannot get property "uiWorkspace" without inject`; the old catch swallowed it,
           * `ui()` answered undefined, and the chip fell through to "请稍后在列表中选择" while
           * holding a perfectly good session id. It is in `inject` now (see the plugin object),
           * and this logs instead of hiding the cause.
           */
          console.error('[dsh-observer] uiWorkspace unavailable:', String((error && error.message) || error))
          return undefined
        }
      }
      return { callHost, ui }
    }

    const parseJson = (text) => {
      try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    /** Sessions whose state has already been read in this page load (see readOnce). */
    const readSessions = new Set()

    /** A JSON error blob becomes one sentence; the detail goes to the console. */
    const friendly = (text, fallback) => {
      const raw = String(text || '')
      if (raw.trim().startsWith('{')) {
        console.error('[dsh-observer] host failure:', raw)
        try {
          const parsed = JSON.parse(raw)
          const code = parsed && parsed.error && parsed.error.code ? String(parsed.error.code) : ''
          return `${fallback}（${code || '宿主异常'}）— 点击重试`
        } catch {
          return `${fallback} — 点击重试`
        }
      }
      return raw.length > 0 ? raw : fallback
    }

    const CHIP = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
      background: 'transparent',
      borderRadius: '999px',
      padding: '3px 10px',
      font: 'inherit',
    }

    /** One button, and it says exactly what it will do. */
    function ObserverChip({ sessionId, bridge }) {
      const [bound, setBound] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [isObserver, setIsObserver] = React.useState(false)
      const handled = React.useState({ id: '' })[0]

      /**
       * ONE read per session per page load — not per mount.
       *
       * Three seats render this chip (turn-tail, composer, sidebar), and every re-render used to
       * fire its own `/observer-state`: that is the "ghost polling" the transcript showed, dozens
       * of rows with no timer in the code. A shared Set makes it exactly one row per session,
       * for the label and the nesting rule, and never again.
       */
      const readOnce = async () => {
        if (sessionId.length === 0) return
        const reply = await bridge.callHost(sessionId, '/observer-state')
        if (!reply.ok) {
          setError(friendly(reply.text, '读取副脑状态失败'))
          return
        }
        const state = parseJson(reply.text)
        if (state === undefined) return
        const bindings = state.bindings && typeof state.bindings === 'object' ? state.bindings : {}
        const reverse = state.reverse && typeof state.reverse === 'object' ? state.reverse : {}
        setBound(typeof bindings[sessionId] === 'string' ? bindings[sessionId] : '')
        setIsObserver(typeof reverse[sessionId] === 'string')
        setError('')
        // One-shot focus filed by a transfer: honour it once, then never again.
        if (state.focus && typeof state.focus.sessionId === 'string' && state.focus.sessionId !== handled.id) {
          open(state.focus.sessionId)
          handled.id = state.focus.sessionId
          void bridge.callHost(sessionId, '/observer-focus-ack')
        }
      }

      React.useEffect(() => {
        if (sessionId.length === 0) return
        if (readSessions.has(sessionId)) return
        readSessions.add(sessionId)
        void readOnce()
      }, [sessionId])

      /**
       * Open a session in the window. `uiWorkspace.openSession` takes the SessionTarget object
       * `{ kind: 'session', sessionId }`; the string form is kept as a fallback for a host that
       * resolves a bare id, so a single signature change cannot silently eat the jump.
       */
      const open = (id) => {
        if (id.length === 0) return false
        const workspaceUi = bridge.ui()
        if (!workspaceUi || typeof workspaceUi.openSession !== 'function') {
          setError('uiWorkspace.openSession 不可用（inject 未生效）')
          return false
        }
        try {
          workspaceUi.openSession({ kind: 'session', sessionId: id })
          return true
        } catch (error) {
          try {
            workspaceUi.openSession(id)
            return true
          } catch (fallbackError) {
            console.error('[dsh-observer] openSession failed:', String((fallbackError && fallbackError.message) || fallbackError))
            setError(`无法打开会话 ${id}`)
            return false
          }
        }
      }

      /**
       * ONE call, then report. The Host may answer with the id, or with an async accept whose
       * output never returns; either way the UI stops here. No polling, no session listing, no
       * watching the binding table — the worst case is a message that says where to look.
       */
      const act = async () => {
        setBusy(true)
        setError('')
        const line = sessionId.length === 0 ? '/observer-consult' : `/observer-create ${sessionId}`
        const reply = await bridge.callHost(sessionId, line)
        setBusy(false)
        const parsed = reply.ok ? parseJson(reply.text) : undefined
        const observerId = parsed && typeof parsed.observerSessionId === 'string' ? parsed.observerSessionId : ''
        if (observerId.length > 0) {
          setBound(observerId)
          if (open(observerId)) return
        }
        if (!reply.ok) {
          setError(friendly((parsed && parsed.text) || reply.text, '副脑召唤失败'))
          return
        }
        setError('已提交，正在创建副脑；若界面未自动切换，请稍后在左侧会话列表中选择新会话。')
      }

      const jump = () => {
        if (bound.length > 0 && open(bound)) return
        setError('uiWorkspace.openSession 不可用')
      }

      /** A companion must not summon a companion: no chip at all in that session. */
      if (isObserver) return null

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 2px', fontSize: '12px', opacity: 0.85 } },
        [
          h(
            'button',
            {
              key: 'b',
              type: 'button',
              disabled: busy,
              style: { ...CHIP, cursor: busy ? 'default' : 'pointer' },
              title:
                bound !== ''
                  ? `已绑定 ${bound}`
                  : sessionId.length === 0
                    ? '在空白会话里先与副脑磋商需求'
                    : `为主会话 ${sessionId} 召唤副脑`,
              onClick: bound !== '' ? jump : act,
            },
            busy
              ? '🧠 处理中…'
              : bound !== ''
                ? `🧠 切换至副脑 (${bound})`
                : sessionId.length === 0
                  ? '🧠 副脑磋商'
                  : '🧠 召唤副脑',
          ),
          error.length > 0 ? h('span', { key: 'e', style: { color: '#b91c1c' } }, error) : null,
        ],
      )
    }

    /**
     * Function-component error trap: a throwing render leaves a red chip, not a blank strip.
     *
     * v0.1.16: NO SEAT RENDERS WITHOUT A SESSION ID. A root-scoped seat (sidebar) has no
     * `sessionId` prop, so the chip used to send `/observer-consult` with an EMPTY agent id —
     * and the gateway answered `{"ok":false,"error":{"code":"gateway/internal"}}` before the
     * handler ever ran. Rendering nothing there is honest; the composer and turn-tail seats do
     * carry an id, so the feature stays reachable in every real conversation.
     */
    const makeEntry = (bridge) => (props) => {
      try {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        if (sessionId.length === 0) return null
        return h(ObserverChip, { sessionId, bridge })
      } catch (error) {
        const message = String((error && error.message) || error)
        console.error('[dsh-observer] entry crashed:', message)
        return h('span', { style: { color: '#b91c1c', fontSize: '12px' } }, `[Observer Error] ${message}`)
      }
    }

    return {
      /**
       * Service keys, not package names — the Cordis guard reads this array.
       *
       * `uiWorkspace` belongs here: without it `ctx.get('uiWorkspace')` throws, the catch
       * swallowed the message, and a freshly created companion id was never opened (the chip
       * said "请稍后在列表中选择" while the id was already in hand).
       */
      inject: ['slots', 'remote', 'remote.commands', 'uiWorkspace'],
      apply(ctx) {
        const bridge = makeBridge(ctx)
        const seats = [
          { name: 'conversation.chat.turnTail', id: 'observer-turntail', order: 60 },
          { name: 'conversation.input.left', id: 'observer-composer', order: 60 },
          { name: 'sidebar.footer.action', id: 'observer-sidebar', order: 60 },
        ]
        for (const seat of seats) {
          try {
            ctx.slots.inject(seat.name, () => {
              ctx.slots.register(
                { name: seat.name, id: seat.id, order: seat.order, label: () => '副脑' },
                makeEntry(bridge),
              )
              return () => {}
            })
          } catch (error) {
            console.error(`[dsh-observer] ${seat.name} registration failed:`, String((error && error.message) || error))
          }
        }
        console.log('[dsh-observer] client seats registered (turntail, composer, sidebar)')
      },
      __makeEntryForTest: makeEntry,
      __makeBridgeForTest: makeBridge,
    }
  },
})
