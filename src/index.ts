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
export const VERSION = '1.1.0'
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
   * A one-shot focus request, left by a transfer.
   *
   * v1.0.4 NOTE: with every client state read removed, nothing consumes this any more. It is kept
   * because it is one durable fact about a handoff (and `observer_status` can still read it), not
   * because something currently acts on it.
   */
  focus: { sessionId: string; at: number } | null
}

interface PluginContextLike {
  get?: (name: string) => any
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  on?: (event: string, listener: (...args: any[]) => any) => unknown
  tools?: { register: (definition: any) => unknown }
}

const EMPTY: ObserverBindings = { bindings: {}, reverse: {}, focus: null }

let bindingsPath = ''
let state: ObserverBindings = { bindings: {}, reverse: {}, focus: null }

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Atomic write: temp file + rename, so a reader never sees half a document. */
function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

const EMPTY_STATE = (): ObserverBindings => ({ bindings: {}, reverse: {}, focus: null })

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
    // `missions` / `missionsSent` from 1.0.2–1.0.3 are deliberately NOT read: the staged-injection
    // design is gone, and a legacy key must not resurrect it.
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
   * v1.0.6 — THE BINDING IS DERIVED FROM THE TITLE, NOT REQUESTED THROUGH A COMMAND.
   *
   * `commands.execute` is BROADCAST: the host renders every command invocation as a row in the
   * conversation, whatever the handler returns. The user saw it for `observer-state`,
   * `observer-create` and finally `observer-bind` — an empty reply removes the TEXT but not the
   * ROW. So the command channel is abandoned entirely for binding.
   *
   * Instead the Client renames the companion through a plain Remote call
   * (`remote.session.rename`, which is not a command and prints nothing):
   *
   *     [副脑] 跟随 <full main session id>
   *
   * The host then reads its OWN event feed. `session/event` fires post-commit for every appended
   * event, so a `session/title` carrying the marker is the moment to write the pointer and inject
   * the setting. Nothing is polled, nothing is broadcast, and the title doubles as the marker the
   * Client uses to hide the summon chip.
   */
  const COMPANION_TITLE = /^\[副脑\]\s*跟随\s+(\S+)/u

  ctx.on?.('session/event', (...args: any[]) => {
    try {
      // `session/event` is scoped: (session, event). Read defensively so a shape change cannot
      // throw inside a post-commit feed.
      const event = args.length >= 2 ? args[1] : args[0]
      if (!isRecord(event)) return
      /**
       * v1.0.7 — PROVE THE FEED IS ALIVE.
       *
       * The whole event-derived binding rests on this listener actually receiving events. A silent
       * listener makes a broken binding indistinguishable from a broken client, so every title
       * that arrives is logged with its text and both candidate session ids. If the user renames a
       * companion and this line never appears, the feed is the problem — not the parser.
       */
      if (event.type === 'session/title') {
        const seenTitle = typeof event.data?.title === 'string' ? event.data.title : ''
        ctx.logger?.info?.(
          `[dsh-observer] 宿主捕获到 title 事件: ${JSON.stringify(seenTitle)} ` +
            `(scope.id=${JSON.stringify(args[0]?.id ?? args[0]?.sessionId ?? null)} ` +
            `data.sessionId=${JSON.stringify(event.data?.sessionId ?? null)})`,
        )
      }
      if (event.type !== 'session/title') return
      const title = typeof event.data?.title === 'string' ? event.data.title : ''
      const matched = COMPANION_TITLE.exec(title)
      if (matched === null) return
      const mainSessionId = matched[1]
      const observerSessionId =
        typeof event.data?.sessionId === 'string'
          ? event.data.sessionId
          : typeof args[0]?.id === 'string'
            ? args[0].id
            : typeof args[0]?.sessionId === 'string'
              ? args[0].sessionId
              : ''
      if (observerSessionId.length === 0 || mainSessionId === observerSessionId) {
        ctx.logger?.warn?.(
          `[dsh-observer] 副脑标题已到手但拿不到观察者 sessionId（main=${mainSessionId}）；` +
            '绑定与设定注入被跳过',
        )
        return
      }
      // Already bound to the same pair: a repeated title event must not re-inject the setting.
      if (observerOf(mainSessionId) === observerSessionId) return

      state.bindings[mainSessionId] = observerSessionId
      state.reverse[observerSessionId] = mainSessionId
      const written = save()
      if (!written.ok) {
        ctx.logger?.warn?.(`[dsh-observer] title-derived bind failed to persist: ${written.error}`)
        return
      }
      ctx.logger?.info?.(`[dsh-observer] bound ${mainSessionId} -> ${observerSessionId} from its title`)
      void injectSetting(observerSessionId, missionText(mainSessionId)).then((injected) => {
        ctx.logger?.info?.(
          injected.ok
            ? `[dsh-observer] setting injected via ${injected.via}`
            : `[dsh-observer] setting injection FAILED: ${injected.detail}`,
        )
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-observer] title-derived bind failed: ${String((error as any)?.message ?? error)}`)
    }
  })

  /**
   * THE transfer event. Grafted plugins announce, this one listens; nothing is imported in either
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
        ? missionText(mainSessionId)
        : '[系统设定] 你是一个前置需求分析副脑（尚未绑定任何主会话）。' +
          '职责：帮用户理清需求、指出遗漏与风险，必要时给出 2~3 个方案对比。' +
          '确认方案后，请输出一段可直接粘贴到主会话的最终 Prompt，并在末尾提示用户「复制到主会话开始执行」。'

    /**
     * v1.0.5 — WRITE THE SETTING PHYSICALLY, AND TITLE THE SESSION.
     *
     * The role is appended as a `developer/message` (context, never a turn), so the companion
     * opens as a quiet blank page; the TITLE carries `[副脑]` so the Client can hide the summon
     * chip by reading its own local session snapshot — no RPC, no page storage.
     */
    const marked = await markCompanion(mainSessionId, observerSessionId, mission)
    if (!marked.injected || !marked.renamed) {
      ctx.logger?.warn?.(`[dsh-observer] companion setup incomplete: ${marked.detail}`)
    }

    return {
      ok: true,
      observerSessionId,
      text:
        mode === 'bind'
          ? `已召唤副脑 ${observerSessionId}，绑定到 ${mainSessionId}。` +
            (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : '')
          : `已开启前置磋商副脑 ${observerSessionId}（未绑定主会话）。` +
            (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : ''),
    }
  }

  /**
   * WRITE THE SETTING INTO THE LOG — PHYSICALLY, WITHOUT STARTING A TURN.
   *
   * v1.0.5 — WHY `prompt` WAS WRONG.
   *
   * v1.0.4 sent the role with `sessionController.prompt`, which is a USER PROMPT: the companion
   * opened already running (and burned quota doing it). A companion must open as a quiet blank
   * page carrying its background, waiting for the human.
   *
   * The mechanism is the one dsh-graft-slice already uses for its live notices: append a
   * `developer/message` event. A developer message is CONTEXT, not a prompt — it never admits a
   * turn, and DSH renders it as a system-level note rather than as something the user wrote.
   *
   * Two channels, in order:
   *   1. `sessions.get(id).append(...)` when the session is LIVE (our case: the Client created it
   *      through `sessions.create`, so it is in the live store);
   *   2. `sessionPersistence.open(id)` + `handle.append(...)` + flush/close for a session that is
   *      durable but not live. This is the store-owned writer, the same one that produced
   *      `cannot append outside a SessionStore` when we tried to append to a PREPARED session.
   *
   * `turn: 0, step: 0` matches the shape dsh-graft-slice uses for a notice appended outside any
   * turn, and `role: 'developer'` is what makes it context instead of conversation.
   */
  const injectSetting = async (
    observerSessionId: string,
    text: string,
  ): Promise<{ ok: boolean; via: string; detail: string }> => {
    const message = {
      id: `observer-setting-${observerSessionId}`,
      role: 'developer',
      content: [{ type: 'text', text }],
    }

    try {
      const sessions = ctx.get?.('sessions')
      const live = isRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(observerSessionId) : undefined
      if (live !== undefined && typeof (live as any).append === 'function') {
        ;(live as any).append('developer/message', { turn: 0, step: 0, message })
        return { ok: true, via: 'live', detail: '' }
      }
    } catch (error) {
      // Fall through to the persistence channel before reporting a failure.
      ctx.logger?.warn?.(`[dsh-observer] live setting append failed: ${String((error as any)?.message ?? error)}`)
    }

    try {
      const persistence = ctx.get?.('sessionPersistence')
      if (isRecord(persistence) && typeof persistence.open === 'function') {
        const handle = await persistence.open(observerSessionId)
        if (handle !== undefined && typeof handle.append === 'function') {
          await handle.append([{ type: 'developer/message', time: Date.now(), data: { turn: 0, step: 0, message } }])
          if (typeof handle.flush === 'function') await handle.flush()
          if (typeof handle.close === 'function') await handle.close()
          return { ok: true, via: 'persistence', detail: '' }
        }
        return { ok: false, via: '', detail: 'sessionPersistence.open 没有返回可写的 handle' }
      }
      return { ok: false, via: '', detail: 'sessionPersistence 不可用，且该会话不在 live store 中' }
    } catch (error) {
      return { ok: false, via: '', detail: String((error as any)?.message ?? error) }
    }
  }

  /**
   * TITLE THE COMPANION, and write its setting into the log.
   *
   * The title is the marker the Client reads from its own snapshot to hide the summon chip, so a
   * failed rename is reported rather than hidden.
   */
  const markCompanion = async (
    mainSessionId: string,
    observerSessionId: string,
    setting: string,
  ): Promise<{ renamed: boolean; injected: boolean; detail: string }> => {
    const controller = ctx.get?.('sessionController')
    let renamed = false
    const problems: string[] = []

    if (isRecord(controller) && typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId: observerSessionId, title: `[副脑] 跟随 ${mainSessionId.slice(0, 12)}…` })
        renamed = true
      } catch (error) {
        problems.push(`重命名失败：${String((error as any)?.message ?? error)}`)
      }
    } else {
      problems.push('sessionController.rename 不可用')
    }

    const injected = await injectSetting(observerSessionId, setting)
    if (!injected.ok) problems.push(`设定写入失败（${injected.detail}）`)

    return { renamed, injected: injected.ok, detail: problems.join('；') }
  }

  /**
   * The role text. `[系统设定]` is the header a developer message carries so the model reads it as
   * standing context rather than as an instruction the user typed.
   */
  const missionText = (mainSessionId: string): string =>
    `[系统设定] 你是会话 ${mainSessionId} 的副脑（观察者 / 跟随者）。` +
    '职责：读主会话日志、澄清需求、以确认卡形式提出方案；不直接改代码。' +
    '主会话转生后你会收到新的绑定目标，身份不变。'

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
     * v1.0.4: send the role as an ordinary message and title the session `[副脑] …`. The title is
     * what hides the summon chip inside the companion, read by the Client from its local snapshot.
     */
    const marked = await markCompanion(mainSessionId, observerSessionId, missionText(mainSessionId))
    if (!marked.injected || !marked.renamed) {
      ctx.logger?.warn?.(`[dsh-observer] companion setup incomplete: ${marked.detail}`)
    }
    return {
      ok: true,
      observerSessionId,
      text:
        `已绑定 ${mainSessionId} → ${observerSessionId}。` +
        (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : ''),
    }
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
   * v1.0.9 — THE HOST CREATES THE COMPANION. THIS IS THE ONE COMMAND, AND IT IS ON PURPOSE.
   *
   * The Client's `sessions.create` cannot place a session in a workspace on this build (the local
   * summary carries no `cwd`, so the create went out bare and the UI fell into the
   * "选择工作区" empty draft). The Host can do it properly because it can read the MAIN session's own
   * header — the authoritative `cwd` — and hand it to its own create call.
   *
   * A command is the only generic client→host channel this Host offers a third-party client half,
   * and `commands.execute` IS broadcast: this costs ONE row per summon, which the user explicitly
   * accepted. Everything else about the companion (placement, title, setting, pointer) happens on
   * the Host; the Client only asks and then opens the id it is given.
   */
  const resolveMainCwd = (mainSessionId: string): { cwd: string; source: string } => {
    try {
      const sessions = ctx.get?.('sessions')
      const live = isRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(mainSessionId) : undefined
      const candidates: Array<[string, unknown]> = [
        ['session.header.cwd', (live as any)?.header?.cwd],
        ['session.cwd', (live as any)?.cwd],
      ]
      for (const [source, value] of candidates) {
        if (typeof value === 'string' && value.length > 0) return { cwd: value, source }
      }
      // The working-directory service is the owner of a Session's effective directory.
      const workingDirectory = ctx.get?.('workingDirectory')
      if (isRecord(workingDirectory) && typeof workingDirectory.get === 'function' && live !== undefined) {
        const path = workingDirectory.get(live as any)
        if (typeof path === 'string' && path.length > 0) return { cwd: path, source: 'workingDirectory.get' }
      }
      return { cwd: '', source: 'unavailable' }
    } catch (error) {
      return { cwd: '', source: `error: ${String((error as any)?.message ?? error)}` }
    }
  }

  const spawnCompanion = async (
    mainSessionId: string,
  ): Promise<{ ok: boolean; sessionId: string; text: string }> => {
    if (mainSessionId.length === 0) {
      return { ok: false, sessionId: '', text: '没有可绑定的主会话 id' }
    }
    if (mainOfObserver(mainSessionId).length > 0) {
      return { ok: false, sessionId: '', text: '这是一个副脑会话：它不能再召唤副脑' }
    }
    const existing = observerOf(mainSessionId)
    if (existing.length > 0) {
      return { ok: true, sessionId: existing, text: `该会话已有副脑 ${existing}` }
    }

    const located = resolveMainCwd(mainSessionId)
    ctx.logger?.info?.(`[dsh-observer] main cwd for ${mainSessionId}: ${JSON.stringify(located.cwd)} (${located.source})`)
    if (located.cwd.length === 0) {
      return { ok: false, sessionId: '', text: `拿不到主会话的工作目录（${located.source}），拒绝创建没有归属的会话` }
    }

    const controller = ctx.get?.('sessionController')
    if (!isRecord(controller) || typeof controller.create !== 'function') {
      return { ok: false, sessionId: '', text: 'sessionController.create 不可用' }
    }

    let observerSessionId = ''
    try {
      const created = await controller.create({ cwd: located.cwd })
      observerSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
    } catch (error) {
      return { ok: false, sessionId: '', text: `创建副脑会话失败：${String((error as any)?.message ?? error)}` }
    }
    if (observerSessionId.length === 0) {
      return { ok: false, sessionId: '', text: 'sessionController.create 返回了空 id' }
    }

    state.bindings[mainSessionId] = observerSessionId
    state.reverse[observerSessionId] = mainSessionId
    const written = save()
    if (!written.ok) {
      delete state.bindings[mainSessionId]
      delete state.reverse[observerSessionId]
      return { ok: false, sessionId: observerSessionId, text: `绑定表写入失败：${written.error}` }
    }

    const marked = await markCompanion(mainSessionId, observerSessionId, missionText(mainSessionId))
    return {
      ok: true,
      sessionId: observerSessionId,
      text:
        `已创建副脑 ${observerSessionId}（cwd=${located.cwd}）` +
        (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : ''),
    }
  }

  const commands = ctx.get?.('commands')
  if (isRecord(commands) && typeof commands.register === 'function') {
    commands.register({
      name: 'observer-spawn',
      description: '由宿主创建副脑：/observer-spawn <mainSessionId>',
      handler: async (invocation: any) => {
        try {
          const raw =
            invocation?.rawInput ?? invocation?.line ?? invocation?.args?.rawInput ?? invocation?.text ?? ''
          const mainSessionId = String(raw).replace(/^\/\S+\s*/u, '').trim()
          const result = await spawnCompanion(mainSessionId)
          /**
           * Success answers with the BARE ID (the client uses it to open the session); a failure
           * answers with the REASON. Returning the id unconditionally — which the first version
           * did — threw every error message away and left the client with an empty string and no
           * way to say what went wrong.
           */
          return {
            kind: result.ok ? ('success' as const) : ('error' as const),
            text: result.ok ? result.sessionId : result.text,
          }
        } catch (error) {
          const detail = String((error as any)?.message ?? error)
          ctx.logger?.warn?.(`[dsh-observer] observer-spawn threw: ${detail}`)
          return { kind: 'error' as const, text: `副脑创建失败：${detail}` }
        }
      },
    })
    ctx.logger?.info?.('[dsh-observer] one command registered: observer-spawn (host-side creation)')
  }

  ctx.tools?.register({
    name: 'observer_create',
    description:
      'Summon a companion observer (副脑) for the CURRENT session. The Host resolves the session\'s own ' +
      'working directory, creates the companion THERE, gives it a [系统设定] background, titles it ' +
      '[副脑] … and records the follower pointer. Returns the new session id so the caller can open it. ' +
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
          sessionId: { type: 'string' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /**
     * v1.1.0 — PLAN B: THE TOOL IS THE ENTRY POINT.
     *
     * The UI chip is gone (the gateway makes every command broadcast, so a button could never be
     * silent and a client-side create could never place the session). The MODEL calls this tool
     * instead: a tool result travels straight back to the model, so the new id is readable — which
     * is exactly the property the command channel lacks.
     *
     * `spawnCompanion` does the real work: resolve the main session's own cwd, create the companion
     * there, title it, write the setting as a `developer/message` (context, so the agent stays
     * asleep) and record the pointer. The id is answered under BOTH `sessionId` and
     * `observerSessionId` so either name is usable by the caller.
     */
    execute: async (args: { mainSessionId?: unknown }, exec: any) => {
      const explicit = typeof args?.mainSessionId === 'string' ? args.mainSessionId.trim() : ''
      const mainSessionId = explicit.length > 0 ? explicit : typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      const spawned = await spawnCompanion(mainSessionId)
      return {
        ok: spawned.ok,
        sessionId: spawned.sessionId,
        observerSessionId: spawned.sessionId,
        text: spawned.text,
      }
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
