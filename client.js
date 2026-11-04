/**
 * dsh-observer — the Client half: a turn-tail entry inside the CONVERSATION.
 *
 * THREE RULES, each from a real failure:
 *
 *   1. NO CLASS COMPONENTS. The client sandbox hands back a MINIMAL React (createElement plus
 *      a couple of hooks — the sibling panel plugins say so in their own comments). Touching
 *      `React.Component` at module scope throws while the module is being evaluated, and an
 *      evaluated-and-crashed module registers nothing: the slot stays empty and the console
 *      shows only a load error. Everything here is a plain function component.
 *
 *   2. THE SESSION ID COMES FROM THE SLOT. `conversation.chat.turnTail` is session-scoped and
 *      `sessionId` is a STANDARD prop (verified against the live Slot catalog). If it is
 *      missing this renders NOTHING — binding a companion to "the first id in the list" would
 *      attach it to somebody else's session.
 *
 *   3. EVERY STAGE ANNOUNCES ITSELF. "Nothing appeared" is the worst symptom to debug, so the
 *      module logs on load, on registration, and (loudly) when it refuses to render.
 */

console.log('[dsh-observer] client loaded')

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  inject: ['slots', 'remote', 'remote.commands'],
  apply(ctx) {
    const React = require('react')
    const h = React.createElement

    const unwrapExecution = (value) => {
      const node = value && value.result !== undefined ? value.result : value
      if (node && typeof node.text === 'string') {
        return { kind: typeof node.kind === 'string' ? node.kind : 'success', text: node.text }
      }
      return undefined
    }

    /** Call one Host command AS the given session — the gateway resolves that id. */
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
        if (execution === undefined) return { ok: false, text: `返回形状无法识别：${JSON.stringify(settled).slice(0, 160)}` }
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
      font: 'inherit',
    }

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
        setBound(typeof bindings[sessionId] === 'string' ? bindings[sessionId] : '')
        setError('')
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

    /**
     * Function-component error trap: a throwing render must leave a red chip, not a blank
     * strip. (No class component: see rule 1 at the top of this file.)
     */
    const Entry = (props) => {
      try {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        if (sessionId.length === 0) {
          console.warn('[dsh-observer] turnTail: no sessionId; prop keys =', props ? Object.keys(props) : props)
          return null
        }
        return h(TurnTail, { sessionId })
      } catch (error) {
        const message = String((error && error.message) || error)
        console.error('[dsh-observer] turnTail crashed:', message)
        return h('span', { style: { color: '#b91c1c', fontSize: '12px' } }, `[Observer Error] ${message}`)
      }
    }

    try {
      ctx.slots.inject('conversation.chat.turnTail', () => {
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'observer-turntail',
            order: 60,
            label: () => '副脑',
          },
          Entry,
        )
        console.log('[dsh-observer] turnTail registered')
        return () => {}
      })
    } catch (error) {
      console.error('[dsh-observer] slot registration failed:', String((error && error.message) || error))
    }
  },
})
