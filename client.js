/**
 * dsh-observer — the Client half. DELIBERATELY MINIMAL (v1.0.5).
 *
 * WHAT THIS FILE DOES, IN ORDER:
 *   1. prints a cache probe (first statement);
 *   2. registers one chip in three seats;
 *   3. on click: read the main session's cwd → `sessions.create` → `uiWorkspace.openSession` →
 *      ONE bind line whose success reply is EMPTY (so it renders no row).
 *   4. listens for `graft/session-transferred` and opens the new main session from the event.
 *
 * THE ONLY HOST CALL IN THIS FILE IS THE BIND LINE, AND IT EXISTS FOR ONE CLICK.
 * The chip keeps no view of the binding table: a companion is recognised from its own `[副脑]`
 * title in the local session snapshot, so there is no state read, no timer, no enumeration and no
 * waiting loop anywhere in this file.
 *
 * WHY `sessions.create` AND NOT `uiWorkspace.startSession`: `startSession()` returns void — it
 * opens a blank session but hands back no id. `sessions.create(opts)` returns
 * `Promise<SessionId>`, which is exactly what a caller needs in order to open and then bind.
 */

window.__OBSERVER_LOADED__ = '1.0.5'
console.log('%c[dsh-observer] FUCK CACHE 1.0.5 — minimal client loaded', 'color:#16a34a;font-weight:bold')

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

    /**
     * v1.0.4 — HOW THIS PAGE KNOWS IT IS LOOKING AT A COMPANION.
     *
     * Two sources, neither of which sends a request:
     *
     *   1. THE TITLE, read from the LOCAL session snapshot. The Host renames every companion to
     *      `[副脑] 跟随 …`, so the marker is durable session metadata rather than page state. The
     *      scan is deliberately structural (walk the summary's strings) because the field that
     *      holds a title is a projection the app owns, not this plugin.
     *   2. THE IN-MEMORY SET of ids created in this page. The rename lands slightly AFTER the
     *      jump, so for a moment the fresh companion has no title yet; the set covers exactly that
     *      window. It is deliberately NOT localStorage — a stale entry there could hide the button
     *      in a session that is not a companion at all.
     *
     * `summoning` is a MODULE-level latch rather than component state: three seats render this
     * chip, so a per-component `busy` flag still let the other two fire — that is the 无限多开 the
     * screenshots showed.
     */
    const companions = new Set()
    let summoning = false

    /** Every string reachable inside a value, so a title is found wherever the app keeps it. */
    const containsMarker = (value, depth = 0) => {
      if (depth > 3 || value === null || value === undefined) return false
      if (typeof value === 'string') return value.includes('[副脑]')
      if (Array.isArray(value)) return value.some((item) => containsMarker(item, depth + 1))
      if (typeof value === 'object') return Object.values(value).some((item) => containsMarker(item, depth + 1))
      return false
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

      /**
       * The local session snapshot — read synchronously, never requested.
       *
       * Used for two facts that are already in the client store: the main session's `cwd` (so a
       * companion lands in the same project instead of 未分组) and the companion marker in a
       * session's title (so the chip hides itself without asking the Host anything).
       */
      const snapshotOf = (sessionId) => {
        try {
          const sessions = get('sessions')
          const list = sessions && sessions.list
          const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
          return snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined
        } catch (error) {
          console.error('[dsh-observer] session snapshot read failed:', String((error && error.message) || error))
          return undefined
        }
      }

      const cwdOf = (sessionId) => {
        const summary = snapshotOf(sessionId)
        return summary && typeof summary.cwd === 'string' ? summary.cwd : ''
      }

      /** v1.0.4: the Host titles every companion `[副脑] 跟随 …`; that title is the marker. */
      const isCompanion = (sessionId) => {
        if (sessionId.length === 0) return false
        if (companions.has(sessionId)) return true
        const summary = snapshotOf(sessionId)
        return summary !== undefined && containsMarker(summary)
      }

      /** Create an ordinary session; `sessions.create` resolves to its `SessionId`. */
      const createSession = async (cwd) => {
        const sessions = get('sessions')
        if (!sessions || typeof sessions.create !== 'function') {
          return { ok: false, sessionId: '', text: 'sessions.create 不可用（inject 未生效）' }
        }
        try {
          const sessionId = await sessions.create(cwd.length > 0 ? { cwd } : {})
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
       * Write the pointer: ONE fire-and-forget line per click.
       *
       * It has to be a command. This host's Client service catalog exposes only
       * layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces — there is
       * no tool-execution service on the client half — and the reply is deliberately NOT read,
       * because the gateway's wrapping is what lost the session id in the first place.
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

      return { get, cwdOf, isCompanion, createSession, openSession, bind }
    }

    function ObserverChip({ sessionId, bridge }) {
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      /**
       * ONE click → create (in the main session's cwd) → open → bind.
       *
       * Open before binding so the user lands in the companion even if the bind fails; report
       * the failure in the chip instead of pretending the summon succeeded.
       *
       * `summoning` is the module latch, not `busy`: three seats share this component, so the
       * state flag alone still allowed the other seats to fire and produce several companions.
       */
      const summon = async () => {
        if (summoning) return
        summoning = true
        setBusy(true)
        setNote('')
        try {
          const cwd = bridge.cwdOf(sessionId)
          const created = await bridge.createSession(cwd)
          if (!created.ok) {
            setNote(`创建会话失败：${created.text}`)
            return
          }
          const observerSessionId = created.sessionId
          // Remember it BEFORE opening: the rename lands a moment after the jump, and the chip
          // inside the fresh companion must not appear in that gap.
          companions.add(observerSessionId)
          const opened = bridge.openSession(observerSessionId)
          const bound = await bridge.bind(sessionId, observerSessionId)
          if (!bound.ok) {
            console.error('[dsh-observer] bind failed:', bound.text)
            setNote(`副脑 ${observerSessionId} 已打开，但指针未写入：${bound.text}`)
            return
          }
          if (!opened) setNote(`副脑 ${observerSessionId} 已创建并绑定；请在左侧会话列表中选择它`)
        } finally {
          summoning = false
          setBusy(false)
        }
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
     * Renders nothing when there is no session id, and nothing inside a COMPANION.
     *
     * The first rule keeps an empty-id call (which produced `gateway/internal`) impossible. The
     * second is the no-nesting rule the Host also enforces: a companion that summons a companion
     * chains forever. It is answered from local data only — the session's own `[副脑]` title plus
     * the ids this page created — so no request is made and the transcript stays clean.
     */
    const makeEntry = (bridge) => (props) => {
      try {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        if (sessionId.length === 0) return null
        if (bridge.isCompanion(sessionId)) return null
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
       * `remote` + `remote.commands` (the single bind line per click).
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

        /**
         * v1.0.4 — FOCUS PULL, EVENT DRIVEN.
         *
         * A handoff announces `graft/session-transferred { sourceSessionId, newSessionId }`. When
         * that event reaches this half, open the new main session directly — no poll, no state
         * read, no lookup.
         *
         * HONEST LIMIT: this listener only fires if the harness bridges Host plugin events to the
         * Client. If it does not, the listener is inert and the user navigates by hand; nothing
         * else depends on it, and `ctx.on` is probed so a host without an event bus cannot break
         * registration.
         */
        try {
          if (typeof ctx.on === 'function') {
            ctx.on('graft/session-transferred', (payload) => {
              try {
                const newSessionId = typeof payload?.newSessionId === 'string' ? payload.newSessionId : ''
                if (newSessionId.length === 0) return
                bridge.openSession(newSessionId)
                console.log(`[dsh-observer] transfer seen; opened ${newSessionId}`)
              } catch (error) {
                console.error('[dsh-observer] transfer handler failed:', String((error && error.message) || error))
              }
            })
            console.log('[dsh-observer] listening for graft/session-transferred')
          }
        } catch (error) {
          console.error('[dsh-observer] could not subscribe to the transfer event:', String((error && error.message) || error))
        }
      },
      __makeEntryForTest: makeEntry,
      __makeBridgeForTest: makeBridge,
    }
  },
})
