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

console.log('[dsh-observer] client loaded')

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  factory(require, styles, host) {
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
          const execution = unwrapExecution(settled)
          if (execution === undefined) {
            return { ok: false, text: `返回形状无法识别：${JSON.stringify(settled).slice(0, 160)}` }
          }
          return { ok: execution.kind !== 'error', text: execution.text }
        } catch (error) {
          return { ok: false, text: String((error && error.message) || error) }
        }
      }
      return { callHost }
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

    /** One button, and it says exactly what it will do. */
    function TurnTail({ sessionId, bridge }) {
      const [bound, setBound] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const handled = React.useState({ id: '' })[0]

      const refresh = async () => {
        const reply = await bridge.callHost(sessionId, '/observer-state')
        if (!reply.ok) {
          setError(String(reply.text || '读取失败'))
          return
        }
        const state = parseJson(reply.text)
        if (state === undefined) return
        const bindings = state.bindings && typeof state.bindings === 'object' ? state.bindings : {}
        setBound(typeof bindings[sessionId] === 'string' ? bindings[sessionId] : '')
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

      const summon = async () => {
        setBusy(true)
        setError('')
        const reply = await bridge.callHost(sessionId, `/observer-create ${sessionId}`)
        setBusy(false)
        if (!reply.ok) {
          setError(String(reply.text || '召唤失败'))
          return
        }
        await refresh()
        const state = await bridge.callHost(sessionId, '/observer-state')
        const parsed = state.ok ? parseJson(state.text) : undefined
        const observerId =
          parsed && parsed.bindings && typeof parsed.bindings[sessionId] === 'string' ? parsed.bindings[sessionId] : ''
        const ui = bridge.ui()
        if (observerId.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: observerId })
        }
      }

      const jump = () => {
        const ui = bridge.ui()
        if (bound.length > 0 && ui && typeof ui.openSession === 'function') {
          ui.openSession({ kind: 'session', sessionId: bound })
          return
        }
        setError('uiWorkspace.openSession 不可用')
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
              title: bound === '' ? `为主会话 ${sessionId} 召唤副脑` : `已绑定 ${bound}`,
              onClick: bound === '' ? summon : jump,
            },
            busy ? '🧠 召唤中…' : bound === '' ? '🧠 召唤副脑' : `🧠 切换至副脑 (${bound})`,
          ),
          error.length > 0 ? h('span', { key: 'e', style: { color: '#b91c1c' } }, error) : null,
        ],
      )
    }

    /**
     * Function-component error trap: a throwing render leaves a red chip, not a blank strip.
     * (No class component — the sandbox React throws on `React.Component` at module scope,
     * which kills registration before it happens.)
     */
    const makeEntry = (bridge) => (props) => {
      try {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        if (sessionId.length === 0) {
          console.warn('[dsh-observer] turnTail: no sessionId; prop keys =', props ? Object.keys(props) : props)
          return null
        }
        return h(TurnTail, { sessionId, bridge })
      } catch (error) {
        const message = String((error && error.message) || error)
        console.error('[dsh-observer] turnTail crashed:', message)
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
        try {
          ctx.slots.inject('conversation.chat.turnTail', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'observer-turntail',
                order: 60,
                label: () => '副脑',
              },
              makeEntry(bridge),
            ),
          )
          console.log('[dsh-observer] turnTail registered')
        } catch (error) {
          console.error('[dsh-observer] slot registration failed:', String((error && error.message) || error))
        }
      },
      __makeEntryForTest: makeEntry,
      __makeBridgeForTest: makeBridge,
    }
  },
})
