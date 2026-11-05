/**
 * dsh-observer — the companion session (副脑), as its own plugin.
 *
 * WHY IT IS A SEPARATE PLUGIN
 *
 * The follower used to live inside dsh-graft-slice, which meant the graft plugin knew about
 * observers, their storage and their UI. That is the coupling this package exists to remove:
 * graft now only announces `graft/session-transferred`, and this plugin decides what (if
 * anything) follows.
 *
 * THE ONE DESIGN RULE (from 副会话Observer-架构方案-v0.1.md §2)
 *
 * The observer is a FOLLOWER, not a second tape. It is never retired and never sliced; a
 * transfer only rewrites one pointer inside `observer-bindings.json`. That is what keeps the
 * pair free of the four deadlock cycles a "mutual graft" would introduce.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-observer'

/**
 * Version probe. Printed at IMPORT time so the Host log proves which copy is live — the
 * Client half is cached separately, and "did my build reach the app?" must be answerable
 * without guessing.
 */
export const VERSION = '1.0.3'
console.log(`[dsh-observer] host version ${VERSION}`)

/**
 * Hard dependencies: tools (the model-facing surface) and sessionController (creating and
 * prompting the follower session). Everything else is optional and probed with `ctx.get`.
 */
export const inject = ['tools', 'sessionController']

interface ObserverBindings {
  /** mainSessionId -> observerSessionId */
  bindings: Record<string, string>
  /** observerSessionId -> mainSessionId */
  reverse: Record<string, string>
  /**
   * A one-shot focus request, consumed by the Client (which owns `uiWorkspace`). The Host
   * cannot move a window, so it leaves a note and the UI acts on it exactly once.
   */
  focus: { sessionId: string; at: number } | null
  /**
   * v1.0.2 — THE MISSION IS HELD, NOT PUSHED.
   *
   * observerSessionId -> the role text that must be delivered as the companion's FIRST
   * `agent/pre-step` context. v1.0.1 sent it with `sessionController.prompt` the instant the
   * pointer was written, which put a `[副脑启动]` message into a session the user had not
   * spoken in yet — a companion cannot discuss requirements with nobody. Holding it here and
   * releasing it on the first real step keeps the new session a clean blank page.
   */
  missions: Record<string, string>
  /** Observers whose mission has already been delivered (so it is never repeated). */
  missionsSent: Record<string, true>
}

interface PluginContextLike {
  get?: (name: string) => any
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  on?: (event: string, listener: (...args: any[]) => any) => unknown
  tools?: { register: (definition: any) => unknown }
}

const EMPTY: ObserverBindings = { bindings: {}, reverse: {}, focus: null, missions: {}, missionsSent: {} }

let bindingsPath = ''
let state: ObserverBindings = { bindings: {}, reverse: {}, focus: null, missions: {}, missionsSent: {} }

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Atomic write: temp file + rename, so a reader never sees half a document. */
function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

const EMPTY_STATE = (): ObserverBindings => ({
  bindings: {},
  reverse: {},
  focus: null,
  missions: {},
  missionsSent: {},
})

function load(): void {
  // Start from empty on EVERY load: the module-level state must describe THIS file, and a
  // mount that reuses a previous process-level copy would leak bindings across profiles
  // (and across tests).
  state = EMPTY_STATE()
  try {
    const parsed = JSON.parse(readFileSync(bindingsPath, 'utf8'))
    if (!isRecord(parsed)) return
    const next = EMPTY_STATE()
    if (isRecord(parsed.bindings)) {
      for (const [main, observer] of Object.entries(parsed.bindings)) {
        if (typeof observer === 'string' && observer.length > 0) next.bindings[main] = observer
      }
    }
    if (isRecord(parsed.reverse)) {
      for (const [observer, main] of Object.entries(parsed.reverse)) {
        if (typeof main === 'string' && main.length > 0) next.reverse[observer] = main
      }
    }
    if (isRecord(parsed.focus) && typeof parsed.focus.sessionId === 'string') {
      next.focus = { sessionId: parsed.focus.sessionId, at: Number(parsed.focus.at) || 0 }
    }
    if (isRecord(parsed.missions)) {
      for (const [observer, text] of Object.entries(parsed.missions)) {
        if (typeof text === 'string' && text.length > 0) next.missions[observer] = text
      }
    }
    if (isRecord(parsed.missionsSent)) {
      for (const observer of Object.keys(parsed.missionsSent)) next.missionsSent[observer] = true
    }
    state = next
  } catch {
    // Absent (first run) or torn: start empty. A stale pointer is repairable; a crash is not.
  }
}

/**
 * Persist the binding table. Returns false when the file could NOT be written.
 *
 * v0.1.8 P0: this used to swallow the error, which is how a reply of `{ok:true}` reached the
 * UI while `observer-bindings.json` had not been touched. A caller must be able to tell the
 * difference between "stored" and "only in memory", so the failure is reported upward.
 */
function save(): { ok: boolean; path: string; error?: string } {
  try {
    mkdirSync(dirname(bindingsPath), { recursive: true })
    writeAtomic(bindingsPath, state)
    return { ok: true, path: bindingsPath }
  } catch (error) {
    return { ok: false, path: bindingsPath, error: String((error as any)?.message ?? error) }
  }
}

function observerOf(mainSessionId: string): string {
  const observer = state.bindings[mainSessionId]
  return typeof observer === 'string' ? observer : ''
}

function mainOfObserver(observerSessionId: string): string {
  const main = state.reverse[observerSessionId]
  return typeof main === 'string' ? main : ''
}

/**
 * Follow a transfer: rewrite the pointer inside this plugin, and leave a focus note.
 *
 * This is the WHOLE cross-plugin coupling: a listener on an event name. It never calls into
 * graft, never blocks it, and a profile without graft simply never receives the event.
 */
function followTransfer(sourceSessionId: string, newSessionId: string): { followed: boolean; observerSessionId: string } {
  const observer = observerOf(sourceSessionId)
  if (observer.length === 0) return { followed: false, observerSessionId: '' }
  delete state.bindings[sourceSessionId]
  state.bindings[newSessionId] = observer
  state.reverse[observer] = newSessionId
  state.focus = { sessionId: newSessionId, at: Date.now() }
  save()
  return { followed: true, observerSessionId: observer }
}

function takeFocus(): { sessionId: string; at: number } | null {
  const focus = state.focus
  if (focus === null) return null
  state.focus = null
  save()
  return focus
}

export function apply(ctx: PluginContextLike, config: Record<string, unknown> = {}): void {
  const configured = typeof config.bindingsPath === 'string' ? config.bindingsPath : ''
  bindingsPath = configured.length > 0 ? configured : join(process.env.DSH_PROFILE_DIR ?? process.cwd(), 'data', 'dsh-observer', 'observer-bindings.json')
  load()

  /**
   * THE event. Grafted plugins announce, this one listens; nothing is imported in either
   * direction. Registered defensively: a host without the event bus must not fail to mount.
   */
  ctx.on?.('graft/session-transferred', (payload: any) => {
    try {
      const source = typeof payload?.sourceSessionId === 'string' ? payload.sourceSessionId : ''
      const target = typeof payload?.newSessionId === 'string' ? payload.newSessionId : ''
      if (source.length === 0 || target.length === 0) return
      const result = followTransfer(source, target)
      if (result.followed) {
        ctx.logger?.info?.(`[dsh-observer] ${result.observerSessionId} now follows ${target}`)
      }
    } catch (error) {
      // A listener must never break the transfer that triggered it.
      ctx.logger?.warn?.(`[dsh-observer] follow failed: ${String((error as any)?.message ?? error)}`)
    }
  })

  /**
   * Create a companion session.
   *
   * `mode: 'bind'`    — a follower for `mainSessionId`; the pointer is written and VERIFIED.
   * `mode: 'consult'` — a pre-discussion companion with NO binding (the blank-page case: there
   *                     is no session yet, so binding it to nothing is the honest answer).
   *
   * v0.1.8 P0 — NO FALSE SUCCESS. Every early return is `ok:false` with a reason, and after
   * writing the pointer the file is re-read: if the binding is not on disk, the reply says so
   * instead of claiming victory. That is exactly the bug the UI surfaced as
   * `回执 {"ok":true}，但绑定表里没有该会话的副脑`.
   */
  const createObserver = async (
    mainSessionId: string,
    mode: 'bind' | 'consult',
  ): Promise<{ ok: boolean; observerSessionId: string; text: string }> => {
    if (mode === 'bind') {
      if (mainSessionId.length === 0) {
        return { ok: false, observerSessionId: '', text: '没有可绑定的主会话 id：请在会话里执行，或传入 mainSessionId。' }
      }
      if (mainOfObserver(mainSessionId).length > 0) {
        return { ok: false, observerSessionId: '', text: '这是一个副脑会话：它跟随主会话，不能再给它召唤副脑。' }
      }
      const existing = observerOf(mainSessionId)
      if (existing.length > 0) {
        return { ok: true, observerSessionId: existing, text: `该会话已有副脑：${existing}（未重复创建）。` }
      }
    }

    const controller = ctx.get?.('sessionController')
    if (!isRecord(controller) || typeof controller.create !== 'function') {
      return { ok: false, observerSessionId: '', text: 'sessionController.create 不可用：当前宿主不支持创建会话。' }
    }

    let observerSessionId = ''
    try {
      const created = await controller.create({})
      observerSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (observerSessionId.length === 0) {
        return { ok: false, observerSessionId: '', text: `会话创建返回了空 id：${JSON.stringify(created)}` }
      }
    } catch (error) {
      return { ok: false, observerSessionId: '', text: `创建副脑会话失败：${String((error as any)?.message ?? error)}` }
    }

    if (mode === 'bind') {
      state.bindings[mainSessionId] = observerSessionId
      state.reverse[observerSessionId] = mainSessionId
      const written = save()
      if (!written.ok) {
        delete state.bindings[mainSessionId]
        delete state.reverse[observerSessionId]
        return {
          ok: false,
          observerSessionId,
          text: `副脑会话已创建（${observerSessionId}），但绑定表写入失败：${written.error}（路径 ${written.path}）`,
        }
      }
      // Verify against DISK, not against the in-memory copy the write came from.
      load()
      if (observerOf(mainSessionId) !== observerSessionId) {
        return {
          ok: false,
          observerSessionId,
          text: `绑定表回读校验失败：${written.path} 中没有 ${mainSessionId} → ${observerSessionId}`,
        }
      }
    }

    const mission =
      mode === 'bind'
        ? `[副脑启动] 你被绑定为会话 ${mainSessionId} 的观察者（跟随者）。` +
          '职责：读主会话日志、澄清需求、以确认卡形式提出方案；不直接改代码。' +
          '主会话转生后你会收到新的绑定目标，身份不变。'
        : '[副脑启动] 你是一个前置需求分析副脑（尚未绑定任何主会话）。' +
          '职责：帮用户理清需求、指出遗漏与风险，必要时给出 2~3 个方案对比。' +
          '确认方案后，请输出一段可直接粘贴到主会话的最终 Prompt，并在末尾提示用户「复制到主会话开始执行」。'

    /**
     * v1.0.2 — STAGE, DO NOT PUSH.
     *
     * v1.0.1 called `sessionController.prompt` here, so the companion opened on a `[副脑启动]`
     * message the user never wrote and could not answer — there was nothing to discuss yet. The
     * mission is now stored and released by this session's FIRST `agent/pre-step` (see the
     * listener below), which keeps the new companion a clean blank page until the user speaks.
     */
    stageMission(observerSessionId, mission)

    return {
      ok: true,
      observerSessionId,
      text:
        mode === 'bind'
          ? `已召唤副脑 ${observerSessionId}，绑定到 ${mainSessionId}。`
          : `已开启前置磋商副脑 ${observerSessionId}（未绑定主会话）。`,
    }
  }

  /**
   * Hold the mission for a companion until its first real step.
   *
   * Storing it in the same document as the pointer means one durable fact: a companion either
   * has a pending mission or it does not, and a restart cannot deliver it twice.
   */
  function stageMission(observerSessionId: string, mission: string): void {
    state.missions[observerSessionId] = mission
    delete state.missionsSent[observerSessionId]
    save()
  }

  /**
   * Release the mission as the companion's first `agent/pre-step` context, exactly once.
   *
   * WHY THIS CHANNEL: writing a log event would collide with the agent loop's step numbering
   * (the same reason dsh-graft-slice injects through `messages`), and `messages` only shapes the
   * upcoming request — it does not fabricate a turn the user never started.
   */
  /**
   * RESOLVE THE STEP'S AGENT.
   *
   * `payload.agent.id` is the SessionId (the Event contract says `Agent = { id: SessionId }`).
   * The `agents.currentInitiator()` fallback is the same one dsh-graft-slice carries, because a
   * payload without an agent must not silently skip the injection.
   */
  const agentIdOf = (payload: any): string => {
    const direct = payload?.agent?.id
    if (typeof direct === 'string' && direct.length > 0) return direct
    try {
      const agents = ctx.get?.('agents')
      const current = isRecord(agents) && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
      const fallback = isRecord(current) ? current.id : undefined
      return typeof fallback === 'string' ? fallback : ''
    } catch {
      return ''
    }
  }

  const PRE_STEP_EVENT = 'agent/pre-step'
  ctx.on?.(PRE_STEP_EVENT, async (payload: any, next: any) => {
    const decision = await next()
    try {
      /**
       * THE REAL CONTRACT, and the reason the first attempt proved nothing:
       *
       *   PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
       *
       * The earlier version spread `decision` and appended to `decision.messages`, which happens
       * to work when `kind: 'enter'` is already present — but its UNIT TEST mocked `{ messages: [] }`,
       * a shape the host never produces. The guard and the injection are now written against the
       * documented shape, so a decision without `kind: 'enter'` is passed through untouched rather
       * than decorated into something the loop may drop.
       */
      if (!isRecord(decision)) return decision
      if (decision.kind === 'reject') return decision
      if (decision.kind !== 'enter') {
        ctx.logger?.warn?.(`[dsh-observer] unexpected pre-step decision kind: ${JSON.stringify(decision.kind)}`)
        return decision
      }

      const agentId = agentIdOf(payload)
      if (agentId.length === 0) return decision
      const mission = state.missions[agentId]
      if (mission === undefined || state.missionsSent[agentId] === true) return decision

      // Mark first, inject second: a double release is worse than a lost one, and the write is
      // what makes "exactly once" durable across a restart.
      state.missionsSent[agentId] = true
      save()
      ctx.logger?.info?.(`[dsh-observer] releasing the mission for ${agentId}`)

      const base = Array.isArray(decision.messages) ? decision.messages : []
      return {
        kind: 'enter' as const,
        ...(decision.startsRequestSeries === true ? { startsRequestSeries: true as const } : {}),
        messages: [
          ...base,
          {
            id: `observer-mission-${agentId}` as any,
            // Pre-step messages are projected as user/message; the explicit header is what a
            // pre-step listener can legitimately deliver (matching dsh-graft-slice).
            role: 'user' as const,
            content: [{ type: 'text', text: mission }],
          },
        ],
      }
    } catch (error) {
      // A listener must never break the step it observes.
      ctx.logger?.warn?.(`[dsh-observer] mission release failed: ${String((error as any)?.message ?? error)}`)
      return decision
    }
  })

  /**
   * v1.0.1 — BIND-ONLY ENTRY (the "B plan" for the client).
   *
   * The Client now CREATES the session itself (`sessions.create`, the only client API that
   * returns `Promise<SessionId>` — `uiWorkspace.startSession` returns void). This entry only
   * records the pointer and sends the mission, so it takes both ids as arguments and creates
   * nothing. Kept as a TOOL rather than a command because the command channel's reply wrapping
   * is unreliable in this host.
   */
  const bindExisting = async (
    mainSessionId: string,
    observerSessionId: string,
  ): Promise<{ ok: boolean; observerSessionId: string; text: string }> => {
    if (mainSessionId.length === 0 || observerSessionId.length === 0) {
      return { ok: false, observerSessionId: '', text: '缺少 mainSessionId 或 observerSessionId。' }
    }
    if (mainOfObserver(mainSessionId).length > 0) {
      return { ok: false, observerSessionId: '', text: '这是一个副脑会话：它不能再绑定副脑。' }
    }
    const existing = observerOf(mainSessionId)
    if (existing.length > 0 && existing !== observerSessionId) {
      delete state.reverse[existing]
    }
    state.bindings[mainSessionId] = observerSessionId
    state.reverse[observerSessionId] = mainSessionId
    const written = save()
    if (!written.ok) {
      delete state.bindings[mainSessionId]
      delete state.reverse[observerSessionId]
      return { ok: false, observerSessionId, text: `绑定表写入失败：${written.error}（路径 ${written.path}）` }
    }
    load()
    if (observerOf(mainSessionId) !== observerSessionId) {
      return { ok: false, observerSessionId, text: `回读校验失败：${written.path} 中没有该绑定` }
    }
    /**
     * v1.0.2: stage the mission instead of pushing it. The companion opens as a clean blank
     * page and receives its role the moment the user actually speaks in it.
     */
    stageMission(
      observerSessionId,
      `[副脑启动] 你被绑定为会话 ${mainSessionId} 的观察者（跟随者）。` +
        '职责：读主会话日志、澄清需求、以确认卡形式提出方案；不直接改代码。' +
        '主会话转生后你会收到新的绑定目标，身份不变。',
    )
    return { ok: true, observerSessionId, text: `已绑定 ${mainSessionId} → ${observerSessionId}。` }
  }

  ctx.tools?.register({
    name: 'observer_bind',
    description:
      'Record a follower pointer for an ALREADY-CREATED session and send it the mission. Pair of the ' +
      'Client-side create: the Client owns `sessions.create`, this owns the durable pointer.',
    parameters: {
      type: 'object',
      properties: {
        mainSessionId: { type: 'string', description: 'Session being observed.' },
        observerSessionId: { type: 'string', description: 'The session that will follow it.' },
      },
      required: ['mainSessionId', 'observerSessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args: { mainSessionId?: unknown; observerSessionId?: unknown }) => {
      const main = typeof args?.mainSessionId === 'string' ? args.mainSessionId.trim() : ''
      const observer = typeof args?.observerSessionId === 'string' ? args.observerSessionId.trim() : ''
      return bindExisting(main, observer)
    },
  })

  /**
   * v0.1 CLIENT CHANNEL: the UI reaches the Host only through commands (tools need an
   * agent). Three of them, all session-independent, so a turn-tail button in ANY session
   * can call them — including one that is not the session being observed.
   */
  /**
   * Parse the command line. The gateway has handed this handler different shapes across
   * builds (`rawInput`, `line`, `args.rawInput`), so all of them are read defensively — the
   * alternative is a silent "no session id" that looks like a broken button.
   */
  const commandArg = (invocation: any): string => {
    const raw =
      invocation?.rawInput ??
      invocation?.line ??
      invocation?.args?.rawInput ??
      invocation?.args?.line ??
      invocation?.text ??
      ''
    return String(raw).replace(/^\/\S+\s*/u, '').trim()
  }
  const commandAgent = (invocation: any): string => {
    const id = invocation?.agent?.id ?? invocation?.agentId ?? invocation?.args?.agentId ?? ''
    return typeof id === 'string' ? id : ''
  }

  const commands = ctx.get?.('commands')
  if (isRecord(commands) && typeof commands.register === 'function') {
    /**
     * v1.0.1 — BIND FOR A SESSION THE CLIENT ALREADY CREATED.
     *
     * The Client creates the session itself (`sessions.create` is the only client API that
     * returns an id) and jumps to it, then fires this line. The reply is NOT read by the client:
     * the gateway's wrapping has swallowed the id twice, and a pointer write does not need a
     * return value. The args are `[mainSessionId, observerSessionId]` in `rawInput`.
     */
    commands.register({
      name: 'observer-bind',
      description: '把已创建的会话登记为副脑：/observer-bind <mainSessionId> <observerSessionId>',
      handler: async (invocation: any) => {
        try {
          const parts = commandArg(invocation).split(/\s+/u).filter(Boolean)
          const result = await bindExisting(parts[0] ?? '', parts[1] ?? '')
          return {
            kind: result.ok ? ('success' as const) : ('error' as const),
            text: JSON.stringify({ ok: result.ok, observerSessionId: result.observerSessionId, text: result.text }),
          }
        } catch (error) {
          const detail = String((error as any)?.message ?? error)
          ctx.logger?.warn?.(`[dsh-observer] observer-bind threw: ${detail}`)
          return { kind: 'error' as const, text: JSON.stringify({ ok: false, text: `绑定失败：${detail}` }) }
        }
      },
    })
    /**
     * v1.0.3 — THE OTHER FOUR COMMANDS ARE GONE, AND THAT IS THE POINT.
     *
     * `observer-state`, `observer-create`, `observer-consult` and `observer-focus-ack` existed
     * only for the client polling that has been removed. Every command invocation prints a
     * `observer-state: {…}` row into the conversation, so as long as these were registered a
     * stale client could keep flooding the transcript. They are physically deleted; the
     * equivalent capability stays available to the MODEL as tools (`observer_status`,
     * `observer_create`, `observer_consult`), which is where it belongs.
     *
     * `observer-bind` remains because the Client's click path fires it.
     */
  }

  ctx.tools?.register({
    name: 'observer_create',
    description:
      'Summon a companion observer for a session: creates an ordinary session and records the follower pointer. ' +
      'The observer is never retired and never sliced — a transfer only rewrites its pointer.',
    parameters: {
      type: 'object',
      properties: { mainSessionId: { type: 'string', description: 'Session to observe. Default: the calling session.' } },
      additionalProperties: false,
    },
    /**
     * v0.1.3 P0 — an explicit OUTPUT contract is mandatory on 0.2.2; without it the whole
     * entry fails to activate (and takes the Web boot with it).
     */
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args: { mainSessionId?: unknown }, exec: any) => {
      const explicit = typeof args?.mainSessionId === 'string' ? args.mainSessionId.trim() : ''
      const mainSessionId = explicit.length > 0 ? explicit : typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      return createObserver(mainSessionId, 'bind')
    },
  })

  /**
   * The blank-page entry: a companion to THINK WITH before there is anything to bind to.
   * Deliberately not a follower — it has no main session yet, and pretending otherwise would
   * be the same class of lie as the `{ok:true}` receipt.
   */
  ctx.tools?.register({
    name: 'observer_consult',
    description:
      'Open a pre-discussion companion (前置需求磋商副脑) that is NOT bound to any session: it clarifies ' +
      'requirements and, once agreed, emits a final Prompt to paste into the main session.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => createObserver('', 'consult'),
  })

  ctx.tools?.register({
    name: 'observer_status',
    description:
      'Read the follower pointer (who observes whom) plus any pending focus request. Read-only. ' +
      'ackFocus consumes that one-shot request so the UI can say "I have moved the window".',
    parameters: {
      type: 'object',
      properties: { ackFocus: { type: 'boolean', description: 'Consume the pending focus request.' } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          bindings: { type: 'object' },
          reverse: { type: 'object' },
          // Nullable on purpose: "no pending focus" is a real, normal state. The Loader's
          // schema subset has NO `anyOf` — using it fails activation with
          // "unsupported JSON schema … anyOf is not a supported keyword" and the entry dies
          // (the whole plugin half never mounts). `oneOf` IS supported.
          focus: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          focusConsumed: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args: { ackFocus?: unknown }) => {
      const pending = state.focus
      if (args?.ackFocus === true) takeFocus()
      return {
        ok: true,
        bindings: { ...state.bindings },
        reverse: { ...state.reverse },
        focus: pending === null ? null : { ...pending },
        ...(args?.ackFocus === true ? { focusConsumed: true } : {}),
      }
    },
  })
}

/** Test seam: the in-process state, so a test can assert without touching disk. */
export function debugObserverState(): ObserverBindings {
  return JSON.parse(JSON.stringify(state))
}

/** Test seam: follow a transfer without an event bus. */
export function debugFollowTransfer(sourceSessionId: string, newSessionId: string): { followed: boolean; observerSessionId: string } {
  return followTransfer(sourceSessionId, newSessionId)
}

export { EMPTY }

/**
 * v0.1.3: `manifest.json` names `activate`, and the Loader looks for it. Exporting the alias
 * is what turns "导入失败" into a successful import — the entry loader checks this name
 * before it ever calls the function.
 */
export const activate = apply
