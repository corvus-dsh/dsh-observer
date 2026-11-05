/**
 * dsh-observer — the Client half. DELIBERATELY MINIMAL (v1.0.1).
 *
 * WHAT THIS FILE DOES, IN ORDER:
 *   1. prints a cache probe (first statement);
 *   2. registers one chip in three seats;
 *   3. on click: `sessions.create()` → `uiWorkspace.openSession(newId)` → `observer_bind(...)`.
 *
 * WHAT IT NO LONGER DOES — each removed because it caused a visible failure:
 *   - no `/observer-state` read of ANY kind. The three seats re-render constantly, and every
 *     command call prints a row into the conversation; that is the "ghost polling" in the
 *     transcript. The chip therefore cannot show "已绑定" — it only offers 召唤副脑.
 *   - no `/observer-create` command. The gateway wraps command replies unreliably (`{kind,text}`,
 *     `{result}`, `{ok,value:{commandId}}`, and a JSON string nested inside `text`), and the id
 *     was lost inside that wrapping while the session WAS created.
 *   - no session enumeration, no timers, no waiting loops.
 *
 * WHY `sessions.create` AND NOT `uiWorkspace.startSession`: `startSession()` returns void — it
 * opens a blank session but hands back no id. `sessions.create(opts)` returns
 * `Promise<SessionId>`, which is exactly what a caller needs in order to open and then bind.
 */

window.__OBSERVER_LOADED__ = '1.0.1'
console.log('%c[dsh-observer] FUCK CACHE 1.0.1 — minimal client loaded', 'color:#16a34a;font-weight:bold')

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  factory(require, styles, host) {
    const React = require('react')
    const h = React.createElement

    const CHIP = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
      background: 'transparent',
      borderRadius: '999px',
      padding: '3px 10px',
      font: 'inherit',
    }

    const makeBridge = (ctx) => {
      const get = (key) => {
        try {
          return ctx.get ? ctx.get(key) : undefined
        } catch (error) {
          console.error(`[dsh-observer] service ${key} unavailable:`, String((error && error.message) || error))
          return undefined
        }
      }

      /** Create an ordinary session; `sessions.create` resolves to its `SessionId`. */
      const createSession = async () => {
        const sessions = get('sessions')
        if (!sessions || typeof sessions.create !== 'function') {
          return { ok: false, sessionId: '', text: 'sessions.create 不可用（inject 未生效）' }
        }
        try {
          const sessionId = await sessions.create({})
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return { ok: false, sessionId: '', text: `sessions.create 返回了空 id：${JSON.stringify(sessionId)}` }
          }
          return { ok: true, sessionId, text: '' }
        } catch (error) {
          return { ok: false, sessionId: '', text: String((error && error.message) || error) }
        }
      }

      /** `openSession(target: SessionTarget)` — SessionTarget is a BARE id string. */
      const openSession = (id) => {
        const workspaceUi = get('uiWorkspace')
        if (!workspaceUi || typeof workspaceUi.openSession !== 'function') return false
        try {
          workspaceUi.openSession(id)
          return true
        } catch (error) {
          console.error('[dsh-observer] openSession failed:', String((error && error.message) || error))
          return false
        }
      }

      /**
       * Write the pointer.
       *
       * WHY A COMMAND AND NOT A TOOL: the Client service catalog of this host exposes only
       * layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces — there is
       * NO `tools` service on the client half, so `tools.execute` is not reachable from here.
       * The command channel IS reachable (the transcript rows prove `/observer-*` lines run), and
       * a pointer write is FIRE-AND-FORGET: we never read the reply, which is the layer that kept
       * losing the session id.
       */
      const bind = async (mainSessionId, observerSessionId) => {
        const remote = get('remote')
        const commands = remote && remote.commands
        if (!commands || typeof commands.execute !== 'function') {
          return { ok: false, text: 'remote.commands 不可用：指针未写入' }
        }
        try {
          await commands.execute(mainSessionId, `/observer-bind ${mainSessionId} ${observerSessionId}`, [], undefined)
          return { ok: true, text: '' }
        } catch (error) {
          return { ok: false, text: String((error && error.message) || error) }
        }
      }

      return { get, createSession, openSession, bind }
    }

    function ObserverChip({ sessionId, bridge }) {
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      /**
       * ONE click → create → open → bind.
       *
       * Open before binding so the user lands in the companion even if the bind fails; report
       * the failure in the chip instead of pretending the summon succeeded.
       */
      const summon = async () => {
        setBusy(true)
        setNote('')
        const created = await bridge.createSession()
        if (!created.ok) {
          setBusy(false)
          setNote(`创建会话失败：${created.text}`)
          return
        }
        const observerSessionId = created.sessionId
        const opened = bridge.openSession(observerSessionId)
        const bound = await bridge.bind(sessionId, observerSessionId)
        setBusy(false)
        if (!bound.ok) {
          console.error('[dsh-observer] bind failed:', bound.text)
          setNote(`副脑 ${observerSessionId} 已打开，但指针未写入：${bound.text}`)
          return
        }
        if (!opened) setNote(`副脑 ${observerSessionId} 已创建并绑定；请在左侧会话列表中选择它`)
      }

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
              title: `为主会话 ${sessionId} 召唤副脑`,
              onClick: summon,
            },
            busy ? '🧠 召唤中…' : '🧠 召唤副脑',
          ),
          note.length > 0 ? h('span', { key: 'n', style: { color: '#b91c1c' } }, note) : null,
        ],
      )
    }

    /**
     * Renders nothing without a session id: a seat with no id cannot create a BOUND companion
     * (there would be nothing to observe), and an empty-id call is what produced
     * `gateway/internal` before.
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
       * Service keys actually available on this Client half:
       * `slots` (register), `sessions` (create, returns the id), `uiWorkspace` (open),
       * `remote` + `remote.commands` (the fire-and-forget bind line).
       */
      inject: ['slots', 'sessions', 'uiWorkspace', 'remote', 'remote.commands'],
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
              ctx.slots.register({ name: seat.name, id: seat.id, order: seat.order, label: () => '副脑' }, makeEntry(bridge))
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
