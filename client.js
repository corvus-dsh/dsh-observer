/**
 * dsh-observer — the Client half: a turn-tail entry inside the CONVERSATION.
 *
 * THE LOADER CONTRACT (this was the bug that made the button invisible three times over):
 *
 *     window.__ModuleLoader__.load({
 *       id: '<package name>',
 *       factory(require, styles, host) { ...; return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * A module that instead calls `load({ id, inject, apply })` — no factory — is accepted and
 * then registers NOTHING: the host never receives a plugin object. Both sibling plugins
 * (dsh-graft-slice, dsh-memory) use the factory form, which is why their panels appear.
 *
 * Two more rules carried over from those plugins:
 *   - `inject` lists SERVICE keys ('slots', 'remote', 'remote.commands'), not package names;
 *     the Cordis property guard reads exactly that array;
 *   - the sandbox React is minimal, so no class components and no exotic hooks.
 */

console.log('[dsh-observer] client version 0.1.9 · seats: turnTail+composer+sidebar · consult=yes')

window.__ModuleLoader__.load({
  /**
   * v0.1.14 — THE MODULE ID CARRIES A VERSION SUFFIX ON PURPOSE.
   *
   * `__ModuleLoader__` caches a module per id, so a file change alone can keep serving the
   * old half across restarts (observed: three rounds of "the new client is not active" while
   * the file on disk clearly was). Bumping the id forces the loader to treat this as a NEW
   * module; the file path is versioned too (client-v14.js), so a HTTP-level cache keyed on the
   * specifier cannot serve the previous copy either.
   */
  id: 'dsh-observer-v14',
  factory(require, styles, host) {
    const React = require('react')
    const h = React.createElement

    /**
     * Normalise whatever the gateway hands back into `{ ok, text, accepted }`.
     *
     * FOUR shapes have been observed live, so all four are accepted:
     *   1. `{ kind: 'success'|'error', text }`  — a command that returns a display line;
     *   2. `{ result: <one of the above> }`     — the same, wrapped once by the gateway;
     *   3. a plain object `{ ok: true }`        — a receipt with nothing in it;
     *   4. `{ ok: true, value: { commandId } }` — AN ASYNCHRONOUS ACCEPT: the command was
     *      QUEUED, not run. Its output never comes back here, so the caller must poll the
     *      state instead of treating the empty receipt as a failure. This shape is why the
     *      button reported "未激活" while the binding was in fact being written.
     */
    const normaliseReply = (value) => {
      const node = value && value.result !== undefined ? value.result : value
      if (node === null || node === undefined) return undefined
      if (typeof node.text === 'string') {
        return { ok: node.kind !== 'error', text: node.text, accepted: false }
      }
      if (typeof node === 'object') {
        const commandId = node.value && typeof node.value.commandId === 'string' ? node.value.commandId : ''
        const accepted = commandId.length > 0 || (node.ok === true && node.value !== undefined)
        return {
          ok: node.ok !== false && node.kind !== 'error',
          text: JSON.stringify(node),
          accepted,
        }
      }
      return undefined
    }

    /** Call one Host command AS the given session — the gateway resolves that id. */
    const makeBridge = (ctx) => {
      /** Every visible session id, for "which one is NEW?" after an async create. */
      const sessionIds = async () => {
        try {
          const remote = ctx.get ? ctx.get('remote') : undefined
          const namespace = remote && (remote.session || remote.sessionController)
          if (!namespace || typeof namespace.list !== 'function') return []
          const reply = await namespace.list({}, undefined)
          const items = reply && Array.isArray(reply.items) ? reply.items : []
          return items.map((item) => (item && typeof item.sessionId === 'string' ? item.sessionId : '')).filter(Boolean)
        } catch {
          return []
        }
      }
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
          if (execution === undefined) {
            return { ok: false, text: `返回形状无法识别：${JSON.stringify(settled).slice(0, 160)}` }
          }
          return execution
        } catch (error) {
          return { ok: false, text: String((error && error.message) || error) }
        }
      }
      return { callHost, sessionIds }
    }

    /**
     * Poll `check` until it yields a non-empty value, or give up.
     *
     * Needed because the gateway QUEUES a command and returns `{ok:true, value:{commandId}}`:
     * the write happens after the promise resolves, so a single read right after the call
     * races the Host and loses.
     */
    const poll = async (check, { attempts = 20, delayMs = 400 } = {}) => {
      for (let index = 0; index < attempts; index += 1) {
        const value = await check()
        if (typeof value === 'string' && value.length > 0) return value
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return ''
    }

    const parseJson = (text) => {
      try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Human-readable failure text.
     *
     * A Host error arrives as a JSON blob (`{"ok":false,"error":{"code":"gateway/internal"…}}`)
     * and the chip used to render it verbatim — a wall of JSON where a sentence belongs. The
     * full detail goes to the console; the UI says what the user can act on.
     */
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
    function TurnTail({ sessionId, bridge }) {
      const [bound, setBound] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      /** True when THIS session is somebody's companion: it must not summon one of its own. */
      const [isObserver, setIsObserver] = React.useState(false)
      const handled = React.useState({ id: '' })[0]

      const refresh = async () => {
        // A consultation companion has no main session to ask about.
        if (sessionId.length === 0) return
        // Every command call lands in the transcript as a row, so a poll that runs often is
        // visible pollution. One read per mount/action, and never while the tab is hidden.
        if (typeof document !== 'undefined' && document.hidden === true) return
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
        // One-shot focus: a transfer filed the new main session; follow it exactly once.
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
        void refresh()
      }, [sessionId])

      /** Open the session the Host just created, whichever mode produced it. */
      const openNew = (observerId) => {
        const ui = bridge.ui()
        if (observerId.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: observerId })
        }
      }

      const consult = async () => {
        setBusy(true)
        setError('')
        const before = await bridge.sessionIds()
        const reply = await bridge.callHost(sessionId, '/observer-consult')
        const parsed = reply.ok ? parseJson(reply.text) : undefined
        let observerId = parsed && typeof parsed.observerSessionId === 'string' ? parsed.observerSessionId : ''
        if (observerId.length === 0) {
          // Queued command: the session appears a moment later. A NEW id is the one we caused.
          observerId = await poll(async () => {
            const now = await bridge.sessionIds()
            const fresh = now.filter((id) => before.indexOf(id) < 0)
            return fresh.length > 0 ? fresh[0] : ''
          })
        }
        setBusy(false)
        if (observerId.length === 0) {
          setError(friendly((parsed && parsed.text) || reply.text, '开启磋商副脑失败'))
          return
        }
        openNew(observerId)
      }

      const summon = async () => {
        setBusy(true)
        setError('')
        const before = await bridge.sessionIds()
        let reply = await bridge.callHost(sessionId, `/observer-create ${sessionId}`)
        let receipt = reply.ok ? parseJson(reply.text) : undefined
        let observerId = receipt && typeof receipt.observerSessionId === 'string' ? receipt.observerSessionId : ''

        /**
         * QUEUED COMMAND: the gateway answers `{ok:true, value:{commandId}}` and runs the
         * command afterwards, so the id has to be WAITED for. The wait uses the SILENT channel
         * only (`remote.session.list`) — every command call would print a `observer-state: …`
         * row into the transcript, and twenty of those is what the user saw as chat pollution.
         * One authoritative state read happens after the wait, not twenty times during it.
         */
        if (observerId.length === 0) {
          observerId = await poll(async () => {
            const now = await bridge.sessionIds()
            const fresh = now.filter((id) => before.indexOf(id) < 0)
            return fresh.length > 0 ? fresh[0] : ''
          })
        }
        setBusy(false)
        if (!reply.ok && observerId.length === 0) {
          setError(friendly((receipt && receipt.text) || reply.text, '召唤失败'))
          return
        }
        if (observerId.length === 0) {
          /**
           * PLAN B — the Host half can be INACTIVE (a failed entry registers no commands at
           * all, and the gateway then answers a generic receipt). In that case still give the
           * user a conversation to talk in: `startSession` is a CLIENT service and needs no
           * Host command. No pointer is written and no mission is sent, so the message says so
           * instead of pretending a companion was created.
           */
          const ui = bridge.ui()
          if (ui && typeof ui.startSession === 'function') {
            try {
              ui.startSession()
              setError(
                `宿主侧副脑插件未激活（命令无回执 id：${String(reply.text).slice(0, 40)}）。已为你打开一个新会话；` +
                  '插件恢复后即可正常召唤。',
              )
              return
            } catch {
              // Fall through to the plain report below.
            }
          }
          setError(
            String(
              (receipt && receipt.text) ||
                `召唤回执 ${String(reply.text).slice(0, 80)}，但绑定表里没有该会话的副脑（宿主侧插件可能未激活）`,
            ),
          )
          return
        }
        setBound(observerId)
        openNew(observerId)
      }

      const jump = () => {
        const ui = bridge.ui()
        if (bound.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: bound })
          return
        }
        setError('uiWorkspace.openSession 不可用')
      }

      /**
       * NO NESTING. A session that is somebody's companion gets NO chip at all: a companion
       * that summons a companion can be chained forever, and the whole design says the pair is
       * exactly two. The Host refuses it too (`副脑会话…不能再给它召唤副脑`); this is the UI half
       * of the same rule, so the button never even appears there.
       */
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
                bound === ''
                  ? sessionId.length === 0
                    ? '在空白会话里先与副脑磋商需求'
                    : `为主会话 ${sessionId} 召唤副脑`
                  : `已绑定 ${bound}`,
              onClick: bound !== '' ? jump : sessionId.length === 0 ? consult : summon,
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
     * (No class component — the sandbox React throws on `React.Component` at module scope,
     * which kills registration before it happens.)
     *
     * `allowConsult` is for the ROOT-scoped seats (composer / sidebar): they can render with no
     * Session at all (the blank page), and there the chip is a pre-discussion companion rather
     * than a follower. The turn-tail seat keeps the strict rule and renders nothing without an
     * id, because binding a companion to a guessed session is what we must never do.
     */
    const makeEntry =
      (bridge, { allowConsult = false } = {}) =>
      (props) => {
        try {
          const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
          if (sessionId.length === 0 && !allowConsult) {
            console.warn('[dsh-observer] turnTail: no sessionId; prop keys =', props ? Object.keys(props) : props)
            return null
          }
          return h(TurnTail, { sessionId, bridge })
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
        bridge.ui = () => {
          try {
            return ctx.get ? ctx.get('uiWorkspace') : undefined
          } catch {
            return undefined
          }
        }
        /**
         * THREE SEATS, one component.
         *
         * `conversation.chat.turnTail`   — after a completed turn (session scope, needs an id).
         * `conversation.input.left`      — compact control in the composer tool row.
         * `sidebar.footer.action`        — ROOT scope, so it exists on the blank page too, where
         *                                  there is no Session to bind and the chip becomes
         *                                  「🧠 副脑磋商」 (pre-discussion, no pointer).
         */
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
            console.log(`[dsh-observer] registered ${seat.name}`)
          } catch (error) {
            // One missing seat must not cost the others: report and continue.
            console.error(`[dsh-observer] ${seat.name} registration failed:`, String((error && error.message) || error))
          }
        }
      },
      __makeEntryForTest: makeEntry,
      __makeBridgeForTest: makeBridge,
    }
  },
})
