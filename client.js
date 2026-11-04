/**
 * dsh-observer — the Client half: a turn-tail entry inside the CONVERSATION.
 *
 * Why the conversation and not a panel: a companion session belongs to the chat you are
 * having, not to a global console. `conversation.chat.turnTail` is the slot the UI already
 * renders after each completed turn, so the button sits exactly where the decision to
 * "call the second brain" is made.
 *
 * The Client cannot talk to the Host except through commands, and it cannot name a session
 * except through `remote.session.list()` — both are the patterns proven on the graft console
 * after four rounds of gateway rejections.
 */

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  inject: ['slots', 'remote', 'remote.commands', 'remote.session'],
  apply(ctx) {
    const React = require('react')
    const h = React.createElement

    /** One command call, with the envelope peeled off and errors surfaced honestly. */
    const callHost = async (line) => {
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
      const sessionId = await firstSessionId(remote)
      try {
        // The gateway resolves the id (`session/not-found`), so this must be a REAL one.
        const settled = await commands.execute(sessionId, line, [], undefined)
        const execution = unwrapExecution(settled)
        if (execution === undefined) return { ok: false, text: `无法识别的返回形状：${JSON.stringify(settled).slice(0, 200)}` }
        return { ok: execution.kind !== 'error', text: execution.text }
      } catch (error) {
        return { ok: false, text: String((error && error.message) || error) }
      }
    }

    /** `commands.execute` answers `{ kind, text }`; tolerate one level of wrapper. */
    const unwrapExecution = (value) => {
      const node = value && value.result !== undefined ? value.result : value
      if (node && typeof node.text === 'string') return { kind: typeof node.kind === 'string' ? node.kind : 'success', text: node.text }
      return undefined
    }

    /** A live session id, agent-free, from `remote.session.list()`. */
    const firstSessionId = async (remote) => {
      const namespace = remote && (remote.session || remote.sessionController)
      if (namespace && typeof namespace.list === 'function') {
        try {
          const reply = await namespace.list({}, undefined)
          const items = reply && Array.isArray(reply.items) ? reply.items : []
          for (const item of items) {
            const id = item && typeof item.sessionId === 'string' ? item.sessionId : ''
            if (id.length > 0) return id
          }
        } catch {
          // Fall through to the placeholder: the command reports `session/not-found`.
        }
      }
      return 'dsh-observer-ui'
    }

    const parseState = (text) => {
      try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    /** The turn-tail row: one button, and it says what it will do. */
    function TurnTail({ sessionId }) {
      const [bound, setBound] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [focusHandled] = React.useState({ id: '' })

      const refresh = async () => {
        const reply = await callHost('/observer-state')
        const state = reply.ok ? parseState(reply.text) : undefined
        if (state === undefined) return
        const bindings = state.bindings && typeof state.bindings === 'object' ? state.bindings : {}
        const main = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
        setBound(main.length > 0 && typeof bindings[main] === 'string' ? bindings[main] : '')
        /**
         * Focus pull: a transfer filed `focus.sessionId`, and this is where it is honoured.
         * Exactly once per request — the ack clears it on the Host.
         */
        if (state.focus && typeof state.focus.sessionId === 'string' && state.focus.sessionId !== focusHandled.id) {
          const ui = ctx.get ? ctx.get('uiWorkspace') : undefined
          if (ui && typeof ui.openSession === 'function') {
            ui.openSession({ kind: 'session', sessionId: state.focus.sessionId })
            focusHandled.id = state.focus.sessionId
          }
          void callHost('/observer-focus-ack')
        }
      }

      React.useEffect(() => {
        void refresh()
      }, [sessionId])

      const summon = async () => {
        setBusy(true)
        setError('')
        const target = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
        const reply = await callHost(`/observer-create${target.length > 0 ? ` ${target}` : ''}`)
        setBusy(false)
        if (!reply.ok) {
          setError(String(reply.text || '召唤失败'))
          return
        }
        await refresh()
        const state = await callHost('/observer-state')
        const parsed = state.ok ? parseState(state.text) : undefined
        const observerId = parsed && parsed.bindings && target.length > 0 ? parsed.bindings[target] : ''
        const ui = ctx.get ? ctx.get('uiWorkspace') : undefined
        if (typeof observerId === 'string' && observerId.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: observerId })
        }
      }

      const jump = () => {
        const ui = ctx.get ? ctx.get('uiWorkspace') : undefined
        if (ui && typeof ui.openSession === 'function' && bound.length > 0) {
          ui.openSession({ kind: 'session', sessionId: bound })
          return
        }
        setError('uiWorkspace.openSession 不可用：请在左侧会话列表里打开副脑会话')
      }

      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 2px', fontSize: '12px', opacity: 0.85 } }, [
        h(
          'button',
          {
            key: 'b',
            type: 'button',
            disabled: busy,
            title: bound === '' ? '为主会话召唤一个跟随它的副脑' : `已绑定 ${bound}`,
            style: {
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
              background: 'transparent',
              borderRadius: '999px',
              padding: '3px 10px',
              cursor: busy ? 'default' : 'pointer',
              font: 'inherit',
            },
            onClick: bound === '' ? summon : jump,
          },
          busy ? '🧠 召唤中…' : bound === '' ? '🧠 召唤副脑' : `🧠 切换至副脑 (${bound})`,
        ),
        error.length > 0 ? h('span', { key: 'e', style: { color: '#b91c1c' } }, error) : null,
      ])
    }

    ctx.slots.inject('conversation.chat.turnTail', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: 'observer-turntail',
          order: 60,
          label: () => '副脑',
        },
        (props) => {
          const sessionId =
            (props && typeof props.sessionId === 'string' && props.sessionId) ||
            (props && props.session && typeof props.session.sessionId === 'string' && props.session.sessionId) ||
            ''
          return h(TurnTail, { sessionId })
        },
      ),
    )
  },
})
