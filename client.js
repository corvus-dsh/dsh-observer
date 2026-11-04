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
 * binding table once on mount. It never uses setInterval and never calls remote.session.list().
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
        } catch {
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

      /** ONE read on mount: the label and the nesting rule need it. Never on a timer. */
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
          const ui = bridge.ui()
          if (ui && typeof ui.openSession === 'function') {
            ui.openSession({ kind: 'session', sessionId: state.focus.sessionId })
            handled.id = state.focus.sessionId
          }
          void bridge.callHost(sessionId, '/observer-focus-ack')
        }
      }

      React.useEffect(() => {
        void readOnce()
      }, [sessionId])

      const open = (id) => {
        const ui = bridge.ui()
        if (id.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: id })
          return true
        }
        return false
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

    /** Function-component error trap: a throwing render leaves a red chip, not a blank strip. */
    const makeEntry =
      (bridge, { allowConsult = false } = {}) =>
      (props) => {
        try {
          const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
          if (sessionId.length === 0 && !allowConsult) return null
          return h(ObserverChip, { sessionId, bridge })
        } catch (error) {
          const message = String((error && error.message) || error)
          console.error('[dsh-observer] entry crashed:', message)
          return h('span', { style: { color: '#b91c1c', fontSize: '12px' } }, `[Observer Error] ${message}`)
        }
      }

    return {
      /** Service keys, not package names — the Cordis guard reads this array. */
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        const bridge = makeBridge(ctx)
        const seats = [
          { name: 'conversation.chat.turnTail', id: 'observer-turntail', order: 60, allowConsult: false },
          { name: 'conversation.input.left', id: 'observer-composer', order: 60, allowConsult: true },
          { name: 'sidebar.footer.action', id: 'observer-sidebar', order: 60, allowConsult: true },
        ]
        for (const seat of seats) {
          try {
            ctx.slots.inject(seat.name, () => {
              ctx.slots.register(
                { name: seat.name, id: seat.id, order: seat.order, label: () => '副脑' },
                makeEntry(bridge, { allowConsult: seat.allowConsult }),
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
