/**
 * dsh-observer — the Client half. ASSIST-ONLY (v1.1.0, Plan B).
 *
 * WHY THERE IS NO BUTTON ANY MORE
 *
 * Every UI-driven creation path failed for a structural reason, documented in
 * 副脑插件架构复盘与底层缺陷报告-2026-11-05.md:
 *
 *   D1 — a third-party Client half has NO plugin-owned Remote: it cannot ask THIS plugin to do
 *        anything. The only generic client→host channel is `commands.execute`.
 *   D2 — `commands.execute` is BROADCAST: every invocation renders a row in the conversation, and
 *        the reply is wrapped unpredictably. A button therefore cannot be silent, and cannot read
 *        the id it needs.
 *   D3 — session PLACEMENT (workspace/cwd) is only authoritatively known to the Host, and the
 *        Host does not know what the user intended. A client-side create lands in no workspace —
 *        the "选择工作区" empty draft.
 *
 * The companion is therefore summoned by the MODEL through the `observer_create` TOOL. A tool
 * result travels straight back to the model, so the id is readable — the exact property the
 * command channel lacks. The Host does the work: it resolves the main session's own cwd, creates
 * the companion there, titles it `[副脑] 跟随 …`, and writes the setting as a `developer/message`
 * (context, so the agent stays asleep).
 *
 * WHAT THIS FILE STILL DOES — one thing, and it does not create anything:
 *   it listens for `graft/session-transferred` and opens the new main session, so a handoff moves
 *   the window without the user hunting for the successor in the sidebar.
 *
 * HONEST LIMIT: that listener only fires if the harness bridges Host plugin events to the Client.
 * If it does not, this module is inert and navigation stays manual. Nothing else depends on it.
 */

window.__OBSERVER_LOADED__ = '1.1.0'
console.log('%c[dsh-observer] FUCK CACHE 1.1.0 — no button; the model summons, the host creates', 'color:#16a34a;font-weight:bold')

window.__ModuleLoader__.load({
  id: 'dsh-observer',
  factory(require, styles, host) {
    /**
     * Services used:
     *   `uiWorkspace.openSession`  — the jump after a transfer
     *   `slots`                    — still declared so the half mounts even with no seats
     *   `remote`                   — the namespace probe below
     *
     * `remote.session` and `remote.commands` are NOT needed any more: this file sends nothing and
     * renames nothing. Declaring a key that is unused is how the earlier `cannot get property
     * "remote.session" without inject` happened, so the list is kept honest instead.
     */
    return {
      inject: ['slots', 'uiWorkspace', 'remote'],

      apply(ctx) {
        const get = (key) => {
          try {
            return ctx.get ? ctx.get(key) : undefined
          } catch (error) {
            console.error(`[dsh-observer] service ${key} unavailable:`, String((error && error.message) || error))
            return undefined
          }
        }

        /** `openSession(target: SessionTarget)` — SessionTarget is a BARE id string. */
        const openSession = (id) => {
          const workspaceUi = get('uiWorkspace')
          if (!workspaceUi || typeof workspaceUi.openSession !== 'function') {
            console.error('[dsh-observer] uiWorkspace.openSession 不可用')
            return false
          }
          try {
            workspaceUi.openSession(id)
            return true
          } catch (error) {
            console.error('[dsh-observer] openSession failed:', String((error && error.message) || error))
            return false
          }
        }

        try {
          /**
           * FOCUS PULL, EVENT DRIVEN. A handoff announces `graft/session-transferred`; when that
           * reaches this half, open the new main session — no poll, no state read, no lookup.
           */
          if (typeof ctx.on === 'function') {
            ctx.on('graft/session-transferred', (payload) => {
              try {
                const newSessionId = typeof payload?.newSessionId === 'string' ? payload.newSessionId : ''
                if (newSessionId.length === 0) return
                openSession(newSessionId)
                console.log(`[dsh-observer] transfer seen; opened ${newSessionId}`)
              } catch (error) {
                console.error('[dsh-observer] transfer handler failed:', String((error && error.message) || error))
              }
            })
            console.log('[dsh-observer] listening for graft/session-transferred (no UI seats: Plan B)')
          }
        } catch (error) {
          console.error('[dsh-observer] could not subscribe to the transfer event:', String((error && error.message) || error))
        }
      },
    }
  },
})
