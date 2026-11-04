/**
 * dsh-observer — the Client half: a turn-tail entry inside the CONVERSATION.
 *
 * TWO HARD RULES, both learned the expensive way:
 *
 *   1. THE SESSION ID COMES FROM THE SLOT, NEVER FROM A GUESS.
 *      `conversation.chat.turnTail` is a `session`-scoped slot and `sessionId` is one of its
 *      STANDARD props (verified through the live Slot catalog: standardProps includes
 *      `sessionId: SessionId`). If it is missing, this component renders NOTHING — binding a
 *      companion to "the first id in the list" would attach it to somebody else's session.
 *
 *   2. A RENDER FAILURE MUST BE VISIBLE.
 *      An unloaded client module and a throwing component look identical from the outside:
 *      nothing appears. The console line at module load and the error chip below exist so
 *      those two causes can be told apart in ten seconds instead of four rounds.
 */

console.log('[dsh-observer] client loaded')

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  inject: ['slots', 'remote', 'remote.commands'],
  apply(ctx) {
    const React = require('react')
    const h = React.createElement

    /** Peel the command envelope: `{ kind, text }`, optionally wrapped in `result`. */
    const unwrapExecution = (value) => {
      const node = value && value.result !== undefined ? value.result : value
      if (node && typeof node.text === 'string') {
        return { kind: typeof node.kind === 'string' ? node.kind : 'success', text: node.text }
      }
      return undefined
    }

    /**
     * Call one Host command AS the session this turn belongs to.
     *
     * `agentId` must be a REAL session id: the gateway resolves it and answers
     * `session/not-found` for anything else. That is why this function takes the id instead
     * of looking one up.
     */
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
        const execution = unwrapExecution(settled)
        if (execution === undefined) {
          return { ok: false, text: `无法识别的返回形状：${JSON.stringify(settled).slice(0, 200)}` }
        }
        return { ok: execution.kind !== 'error', text: execution.text }
      } catch (error) {
        return { ok: false, text: String((error && error.message) || error) }
      }
    }

    const parseJson = (text) => {
      try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    const CHIP = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
      background: 'transparent',
      borderRadius: '999px',
      padding: '3px 10px',
      cursor: 'pointer',
      font: 'inherit',
    }

    /** One button, and it says exactly what it will do. */
    function TurnTail({ sessionId }) {
      const [bound, setBound] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const handled = React.useState({ id: '' })[0]

      const refresh = async () => {
        const reply = await callHost(sessionId, '/observer-state')
        if (!reply.ok) {
          setError(String(reply.text || '读取失败'))
          return
        }
        const state = parseJson(reply.text)
        if (state === undefined) return
        const bindings = state.bindings && typeof state.bindings === 'object' ? state.bindings : {}
        const observer = typeof bindings[sessionId] === 'string' ? bindings[sessionId] : ''
        setBound(observer)
        setError('')
        // One-shot focus: a transfer filed the new main session; follow it exactly once.
        if (state.focus && typeof state.focus.sessionId === 'string' && state.focus.sessionId !== handled.id) {
          const ui = ctx.get ? ctx.get('uiWorkspace') : undefined
          if (ui && typeof ui.openSession === 'function') {
            ui.openSession({ kind: 'session', sessionId: state.focus.sessionId })
            handled.id = state.focus.sessionId
          }
          void callHost(sessionId, '/observer-focus-ack')
        }
      }

      React.useEffect(() => {
        void refresh()
      }, [sessionId])

      const summon = async () => {
        setBusy(true)
        setError('')
        const reply = await callHost(sessionId, `/observer-create ${sessionId}`)
        setBusy(false)
        if (!reply.ok) {
          setError(String(reply.text || '召唤失败'))
          return
        }
        await refresh()
        const state = await callHost(sessionId, '/observer-state')
        const parsed = state.ok ? parseJson(state.text) : undefined
        const observerId = parsed && parsed.bindings && typeof parsed.bindings[sessionId] === 'string' ? parsed.bindings[sessionId] : ''
        const ui = ctx.get ? ctx.get('uiWorkspace') : undefined
        if (observerId.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: observerId })
        }
      }

      const jump = () => {
        const ui = ctx.get ? ctx.get('uiWorkspace') : undefined
        if (bound.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: bound })
          return
        }
        setError('uiWorkspace.openSession 不可用')
      }

      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 2px', fontSize: '12px', opacity: 0.85 } }, [
        h(
          'button',
          {
            key: 'b',
            type: 'button',
            disabled: busy,
            style: { ...CHIP, cursor: busy ? 'default' : 'pointer' },
            title: bound === '' ? `为主会话 ${sessionId} 召唤副脑` : `已绑定 ${bound}`,
            onClick: bound === '' ? summon : jump,
          },
          busy ? '🧠 召唤中…' : bound === '' ? '🧠 召唤副脑' : `🧠 切换至副脑 (${bound})`,
        ),
        error.length > 0 ? h('span', { key: 'e', style: { color: '#b91c1c' } }, error) : null,
      ])
    }

    /** A throwing child must leave a red chip, not a blank strip. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { message: '' }
      }

      static getDerivedStateFromError(error) {
        return { message: String((error && error.message) || error) }
      }

      render() {
        if (this.state.message.length > 0) {
          return h('span', { style: { color: '#b91c1c', fontSize: '12px' } }, `[Observer Error] ${this.state.message}`)
        }
        return this.props.children
      }
    }

    const Entry = (props) => {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      if (sessionId.length === 0) {
        // No id, no button. Guessing would bind the wrong session (see the header rule).
        console.warn('[dsh-observer] turnTail received no sessionId; props keys =', props ? Object.keys(props) : props)
        return null
      }
      return h(Boundary, null, h(TurnTail, { sessionId }))
    }

    ctx.slots.inject('conversation.chat.turnTail', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: 'observer-turntail',
          order: 60,
          label: () => '副脑',
        },
        Entry,
      ),
    )
  },
})
