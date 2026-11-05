/**
 * observer-inject — the PHYSICAL path that gives an incubated MAIN session its briefing.
 *
 * WHY THIS FILE EXISTS (v1.3.0)
 *
 * `observer_spawn_main` used to create the main through `sessionController.create()` and then
 * write the plan with `sessions.get(newId).append(...)`. Two things went wrong in production,
 * both measured on the live desktop:
 *
 *   1. PLACEMENT WAS NOT INHERITED. The create request carried whatever the caller passed, and
 *      when that was empty the session landed in no workspace at all — the "选择工作区" orphan.
 *
 *   2. THE WRITE WAS REJECTED. A `developer/message` is step-scoped: DSH validates
 *      `data.turn`/`data.step` against the OPEN pair on the log. A freshly created session has
 *      NO open turn (`turn === null`), so every write was refused, the `catch` degraded it to a
 *      message, and the incubated main ended up with metadata events and no plan.
 *
 * THE FIX IS TO STOP USING THE LIVE-STORE WRITER, exactly as dsh-graft-slice does. The session
 * is prepared detached (`sessions.prepare`), the tape is built and validated IN MEMORY, and the
 * only writer is `sessionPersistence.create()` + `handle.append()` + `handle.flush()`. The target
 * stays COLD until the user opens it, which is also what makes a later `agents.resume()` legal.
 *
 * WHAT TRAVELS, AND IN WHAT ORDER
 *
 *   turn/start (1)
 *   step/start (1,1)
 *   system/message   surfaceOp:'append'  ← the FIRST SURFACE NODE (a protected head)
 *   developer/message surfaceOp:'append'  ← the plan + the memory arsenal, inside the open step
 *   session/title                          ← log-only; the sidebar name for a cold session
 *   step/end (1,1)
 *   turn/end (1, completed)                ← CLOSED, so the main opens asleep
 *   permission/preset · sandbox/mode · approval/policy · model/selection   ← log-only knobs
 *
 * ONE DELIBERATE DEVIATION FROM THE BRIEF, WITH THE REASON
 *
 * The brief asks for the `system/message` to be the FIRST EVENT. It is the first SURFACE NODE,
 * but it cannot be the first EVENT, and this is not a preference:
 *
 *   - `system/message` carries `{ turn, step }` and is a step-scoped message. DSH rejects a
 *     message whose turn/step do not match the OPEN pair (`requireStep`), and the cold reader
 *     applies the same rule when the session is loaded. Written before `turn/start`, the log has
 *     `turn === null` and the write is refused with the same class of error that broke v1.2.2.
 *   - The real host does it in this order too. Measured on
 *     `dsh-graft-slice/test/fixtures/real-session.v4.jsonl.zstd`: `turn/start` at seq 4,
 *     `step/start` at seq 6, `system/message` at seq 7 — the system node is the first event that
 *     carries `surfaceOp`, not the first event in the file.
 *   - dsh-graft-slice — the code this file is copied from — does the same:
 *     `buildInjectionEvents()` pushes `turn/start`, `step/start`, then the system head, with the
 *     comment "v4 restore requires the first surface node to be a protected system head".
 *
 * So "protected first surface head" is satisfied by this order, and violated by the literal one.
 * A test in `test/cold-inject.test.mjs` pins exactly that: the first event WITH `surfaceOp` is the
 * system node, and `turn/start` precedes it.
 */

import { randomUUID } from 'node:crypto'

/* ── shapes (erased by the build; kept for readers and for the tests) ───────── */

interface InjectEvent {
  type: string
  seq: number
  time: number
  data: Record<string, any>
  surfaceOp?: 'append'
}

interface TapeSeed {
  type: string
  data: Record<string, any>
  surface: boolean
}

interface InjectContext {
  get?: (name: string) => any
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  emit?: (event: string, payload: unknown) => unknown
}

export interface InjectRequest {
  /** The consulting session: the CWD DONOR. Never guessed, never defaulted. */
  sourceSessionId: string
  /** The briefing text: the agreed plan, plus whatever dsh-memory returned for it. */
  text: string
  /** Sidebar title written INTO the tape, so a COLD session is still named. */
  title: string
  /** Resolved by `resolveInheritedCwd` in the caller; re-validated here. */
  cwd: string
  cwdSource?: string
  /** Tests only: pin the id instead of allocating one. */
  sessionId?: string
  createdAt?: number
  /**
   * v1.3.1: `user` (default — RENDERED in the conversation) or `developer` (context-only, and
   * therefore invisible to the reader on this host). The default is `user` because an incubation
   * whose plan cannot be seen is indistinguishable from one whose plan was never written.
   */
  briefingRole?: 'user' | 'developer'
}

export interface InjectResult {
  sessionId: string
  cwd: string
  cwdSource: string
  appended: number
  verified: boolean
  workspaceAttached: boolean
  types: string[]
  warnings: string[]
  /** v1.3.1: the role the briefing actually landed as, plus whether the host will render it. */
  briefingRole: 'user' | 'developer'
  briefingVisible: boolean
  /** What the cold read found for the briefing event — the evidence, not a claim about it. */
  briefingEventSeq: number | null
  briefingSourceKind: string
}

export interface RollbackResult {
  removed: boolean
  marked: boolean
  notes: string[]
}

/**
 * A typed failure. `stage` is what the caller shows the model: "which of the eight steps broke"
 * is the difference between a report and a guess.
 *
 * The CODE is prefixed to the message on purpose. A log line reading
 * `[STEP_OUTSIDE_TURN] developer/message 的 turn/step 与打开的 1/1 不一致` can be grepped, quoted
 * in a bug report and asserted in a test; a Chinese sentence alone cannot. The stack is preserved
 * by the Error base class, so nothing is lost by adding the prefix.
 */
export class InjectError extends Error {
  code: string
  stage: string

  constructor(code: string, stage: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'InjectError'
    this.code = code
    this.stage = stage
  }
}

/**
 * The message-id prefix that marks a message as OURS.
 *
 * v1.5.0 moved provenance OFF the surface and ONTO the id, because those are two different
 * audiences:
 *
 *   - `source.kind` is read by RENDERERS and CONTEXT BUILDERS. `session-reference/projection.js`
 *     keeps a `user/message` only when `source.kind === 'user'` (unless it is a compaction
 *     checkpoint), so a plugin: kind there means "do not display this" — the opposite of what the
 *     marker was for. That is what made the plan invisible on screen while the model still read it.
 *   - the message `id` is read by US, and by any plugin that wants to know who authored a message.
 *     It is not consulted by the projector, so it costs nothing visually.
 *
 * The rule that the marker existed to enforce is enforced elsewhere now, and more strictly:
 * graft's `isHumanAuthored()` requires `source.kind === 'user'` AND a real `rpcId` on the message
 * source (see `isHumanAuthored` in dsh-graft-slice), and a briefing we write carries no `rpcId`.
 */
export const OBSERVER_BRIEFING_ID_PREFIX = 'observer-briefing-'

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message'])

function asRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve a host service.
 *
 * BOTH forms are real on this host: `ctx.get('sessions')` is what the client-side half uses, while
 * an entry that declares a service in `inject` also gets it as a direct property (`ctx.sessions`) —
 * which is what dsh-graft-slice relies on for `ctx.sessions.prepare`. Accepting either means the
 * plugin works under both wirings instead of depending on which one a given build populates.
 *
 * `method` makes the choice SEMANTIC rather than positional: several services expose different
 * faces through the two accessors (the tool registry's direct property may carry only `register`,
 * while `get('tools')` is where `execute` lives). Preferring the accessor that actually has the
 * method is what stops a "service is present but useless" half-failure, which is indistinguishable
 * from a missing service in a log.
 */
export function resolveService(ctx: any, name: string, method?: string): any {
  const candidates: any[] = []
  try {
    const direct = ctx?.[name]
    if (direct !== undefined && direct !== null) candidates.push(direct)
  } catch {
    // A property getter that throws is simply not a candidate.
  }
  try {
    const viaGet = ctx?.get?.(name)
    if (viaGet !== undefined && viaGet !== null) candidates.push(viaGet)
  } catch {
    // Same for `get`.
  }
  if (candidates.length === 0) return undefined
  if (method === undefined) return candidates[0]
  return candidates.find((candidate) => typeof candidate?.[method] === 'function')
}

/** Windows drive, UNC, or POSIX absolute. A relative cwd is a bug, not a path. */
export function isAbsoluteCwd(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/**
 * The distinguishable tail of a session id, for a human-readable label.
 *
 * Host ids look like `session-697a0c0a-7048-4b72-…`: the first eight characters are the SAME for
 * every session, so `slice(0, 8)` yields the constant `session-` and every incubated main would
 * carry an identical, meaningless sidebar title. The stem is stripped first, and the fallback is
 * the tail, which is where the entropy actually is.
 */
export function shortSessionTag(sessionId: string, length = 8): string {
  const stemless = String(sessionId ?? '').replace(/^session-/u, '')
  const head = stemless.slice(0, length)
  return head.length > 0 ? head : String(sessionId ?? '').slice(-length)
}

/** The sidebar title a cold main carries. `{main}` is replaced with its own id tag. */
export function resolveMainTitle(template: string, sessionId: string): string {
  const tag = shortSessionTag(sessionId)
  const base = typeof template === 'string' ? template.trim() : ''
  if (base.length === 0) return `[主脑] ${tag}`
  return base.includes('{main}') ? base.split('{main}').join(tag) : `${base} · ${tag}`
}

/* ── 1. PLACEMENT: the exact cwd of the source session, or refuse ──────────── */

/**
 * Resolve the working directory of `sessionId` — the session being hatched FROM.
 *
 * Order matters and mirrors the host's own answer:
 *   1. the LIVE session header (`session.header.cwd`) — immutable creation metadata;
 *   2. `session.cwd` — what a live session exposes directly;
 *   3. `workingDirectory.get(session)` — the service that owns the EFFECTIVE directory, including
 *      a later `cd`, so it is consulted before the durable copy;
 *   4. `sessionQuery.readSession(id).session.cwd` — the durable header, for a session that is not
 *      live in this process.
 *
 * An empty or relative result REFUSES. The caller must not create anything without a placement:
 * an orphan session is worse than an error, because it looks like success in the sidebar.
 */
export function resolveInheritedCwd(
  ctx: InjectContext,
  sessionId: string,
): { cwd: string; source: string; attempts: string[] } {
  const attempts: string[] = []
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id.length === 0) {
    throw new InjectError('CWD_UNAVAILABLE', 'resolve-cwd', '没有发起会话 id，无法确定工作目录')
  }

  const accept = (value: unknown, source: string): { cwd: string; source: string; attempts: string[] } | undefined => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      attempts.push(`${source}=<empty>`)
      return undefined
    }
    const trimmed = value.trim()
    if (!isAbsoluteCwd(trimmed)) {
      attempts.push(`${source}=${JSON.stringify(trimmed)}<not-absolute>`)
      return undefined
    }
    return { cwd: trimmed, source, attempts }
  }

  const sessions = resolveService(ctx, 'sessions', 'get')
  const live = asRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(id) : undefined

  if (live !== undefined && live !== null) {
    const fromHeader = accept((live as any)?.header?.cwd, 'sessions.get().header.cwd')
    if (fromHeader !== undefined) return fromHeader
    const fromSession = accept((live as any)?.cwd, 'sessions.get().cwd')
    if (fromSession !== undefined) return fromSession
    const workingDirectory = resolveService(ctx, 'workingDirectory', 'get')
    if (asRecord(workingDirectory) && typeof workingDirectory.get === 'function') {
      let value: unknown
      try {
        value = workingDirectory.get(live)
      } catch (error) {
        attempts.push(`workingDirectory.get=<threw ${String((error as any)?.message ?? error)}>`)
        value = undefined
      }
      const fromService = accept(value, 'workingDirectory.get')
      if (fromService !== undefined) return fromService
    }
  } else {
    attempts.push('sessions.get=<not live>')
  }

  const query = resolveService(ctx, 'sessionQuery', 'readSession')
  if (asRecord(query) && typeof query.readSession === 'function') {
    // readSession is async on the host; this helper stays synchronous by only accepting an
    // already-resolved durable header. Callers that need the async fallback use
    // `resolveInheritedCwdAsync` below.
    attempts.push('sessionQuery.readSession=<async, see resolveInheritedCwdAsync>')
  }

  throw new InjectError(
    'CWD_UNAVAILABLE',
    'resolve-cwd',
    `拿不到发起会话 ${id} 的工作目录，拒绝创建没有归属的主脑（已尝试：${attempts.join(' · ')}）`,
  )
}

/** The async variant: same order, plus the durable header through `sessionQuery.readSession`. */
export async function resolveInheritedCwdAsync(
  ctx: InjectContext,
  sessionId: string,
): Promise<{ cwd: string; source: string; attempts: string[] }> {
  try {
    return resolveInheritedCwd(ctx, sessionId)
  } catch (error) {
    if (!(error instanceof InjectError)) throw error
    const attempts = [error.message]
    const query = resolveService(ctx, 'sessionQuery', 'readSession')
    if (asRecord(query) && typeof query.readSession === 'function') {
      try {
        const snapshot = await query.readSession(sessionId)
        const value = asRecord(snapshot) ? (snapshot as any).session?.cwd : undefined
        if (typeof value === 'string' && value.trim().length > 0 && isAbsoluteCwd(value.trim())) {
          return { cwd: value.trim(), source: 'sessionQuery.readSession().session.cwd', attempts }
        }
        attempts.push(`sessionQuery.readSession().session.cwd=${JSON.stringify(value ?? null)}<unusable>`)
      } catch (readError) {
        attempts.push(`sessionQuery.readSession=<threw ${String((readError as any)?.message ?? readError)}>`)
      }
    } else {
      attempts.push('sessionQuery=<unavailable>')
    }
    throw new InjectError(
      'CWD_UNAVAILABLE',
      'resolve-cwd',
      `拿不到发起会话 ${sessionId} 的工作目录，拒绝创建没有归属的主脑（已尝试：${attempts.join(' · ')}）`,
    )
  }
}

/* ── 2. THE TAPE ──────────────────────────────────────────────────────────── */

const MIGRATION_SYSTEM_PROMPT = [
  'You are a coding agent continuing a session that was planned elsewhere. Follow the standing developer message: it holds the agreed plan and the known traps.',
  'Tool output from the planning session is summarised as pointers; when you need the actual output behind one of those seq numbers, ask for it instead of guessing. NEVER fabricate a tool result.',
].join('\n\n')

/** The workspace boundary, stated as a red line. The path is the resolved header cwd. */
export function injectWorkspaceRedline(cwd: string): string {
  const root = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : '(工作目录未记录)'
  return [
    `【红线警告】你的工作目录严格限定为 ${root}。严禁执行任何针对 C 盘、AppData 或全局根目录的搜索（如 rg /）。如果遇到找不到文件的情况，请只在当前目录下用 ls 或 dir 查找。`,
    '同一路径被拒绝或找不到之后，不要换写法重试、不要向外层目录扩散搜索、不要凭目录列表猜测文件内容；请把结论和缺口报告给用户。',
  ].join('\n')
}

/**
 * Build the tape as PLAIN EVENT DATA, before anything is written.
 *
 * Every message carries `surfaceOp: 'append'`; every lifecycle event carries neither surface
 * field. That is the shape both the host's writer and the cold reader agree on (see
 * dsh-graft-slice `materializeTape`).
 *
 * ── v1.3.1: THE BRIEFING IS A `user/message`, BECAUSE `developer/message` IS INVISIBLE ──
 *
 * MEASURED, not assumed. Real log of an incubated main
 * (`…/session-c586f512…/session.v4.jsonl.zstd`, 3 zstd frames, 7 events) held the briefing at
 * seq=3 with its full text — and the user reported "没有看到注入消息", correctly. The write had
 * always worked; the RENDER did not.
 *
 * Two independent pieces of evidence say a `developer/message` never reaches the conversation:
 *
 *   1. `dsh-session-reference/lib/types/projection.js` `projectSessionConversation()` — the
 *      current-surface projection — switches on `user/message` and `assistant/message` only, and
 *      lists `developer/message`, `system/message`, `tool/result` in the SAME `break` branch:
 *      "project current user/assistant conversation while excluding tools, reasoning, and
 *      injected context". A developer message is, by definition, injected context.
 *   2. dsh-graft-slice's own README, from an earlier incident: "`assistant/message` 是 DSH 会渲染的
 *      surface；早先尝试的 `developer/message` 在桌面端不可见." They moved their handoff card to a
 *      rendered surface for exactly this reason.
 *
 * `user/message` is the right visible channel, not `assistant/message`, because the briefing is
 * something the session must ACT ON rather than something it said. And a plugin-authored
 * `user/message` is a shape this host already accepts: real graft targets contain 3 and 17 of them
 * with `source.kind: 'plugin:graft-replay'` (measured in `auto-graft-mw21oowu-e7kcmk` and
 * `auto-graft-mw1jox7o-gs23bp`).
 *
 * The `plugin:observer-briefing` source kind is load-bearing, not decoration: graft's
 * `isHumanAuthored()` treats ONLY `source.kind === 'user'` as a human utterance, so a marked
 * message is never mistaken for something the user typed — that is what keeps a later graft from
 * re-injecting this briefing as if it were the human's instruction.
 */
export function buildInjectTape(input: {
  sessionId: string
  cwd: string
  text: string
  title: string
  runtimeIntent?: Record<string, Record<string, any>>
  /** `user` (visible in the conversation) or `developer` (context-only, invisible). */
  briefingRole?: 'user' | 'developer'
}): TapeSeed[] {
  const turn = 1
  const step = 1
  const { sessionId, cwd, text, title } = input
  const role = input.briefingRole === 'developer' ? 'developer' : 'user'
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new InjectError('EMPTY_BRIEFING', 'build-tape', '注入内容为空：主脑不能在没有方案的情况下诞生')
  }
  if (!isAbsoluteCwd(cwd)) {
    throw new InjectError('CWD_INVALID', 'build-tape', `cwd ${JSON.stringify(cwd)} 不是绝对路径`)
  }

  /**
   * The visible briefing carries NO `turn`/`step`: a `user/message` is not step-scoped in the host's
   * own data (measured on real logs — `data{content,source,role,id}` and nothing else). Passing the
   * pair here would be a shape the host never writes, and the whole point of this file is that the
   * shape comes from the host.
   */
  const briefingMessage: Record<string, any> =
    role === 'user'
      ? {
          id: `${OBSERVER_BRIEFING_ID_PREFIX}${sessionId}`,
          role: 'user',
          content: [{ type: 'text', text }],
          // `kind: 'user'` is what the RENDERER requires in order to show this message. Provenance
          // lives on the id (above) and is reported back in the receipt, not encoded here.
          source: { kind: 'user' },
        }
      : {
          id: `${OBSERVER_BRIEFING_ID_PREFIX}${sessionId}`,
          role: 'developer',
          content: [{ type: 'text', text }],
          source: { kind: 'system-prompt' },
        }

  /**
   * v1.5.0 — A SECOND, RENDERED SURFACE NODE (`assistant/message`), COPIED FROM graft.
   *
   * The evidence is a live acceptance run, not a theory: the incubated main's THINKING showed the
   * plan (`The user asked: "帮我梳理…先制定计划，然后孵化主脑来写基础脚手脚架"`) while the UI showed
   * nothing until the model answered. So the plan reached the MODEL and did not reach the SCREEN.
   *
   * Two things had to change together:
   *
   *   1. The source kind. `session-reference/projection.js` drops a `user/message` whose
   *      `source.kind !== 'user'` unless it is a compaction checkpoint — so my own
   *      `plugin:observer-briefing` marker made the message invisible to any surface reader that
   *      uses that projection. Exactly a self-inflicted wound, and the same mistake in a different
   *      place: the marker was the right instinct (never be mistaken for a human) applied at the
   *      wrong layer (the SURFACE, where it means "do not show this").
   *
   *   2. The event type. dsh-graft-slice renders its handoff card as an `assistant/message`, with a
   *      measured note in its README: "`assistant/message` 是 DSH 会渲染的 surface；早先尝试的
   *      `developer/message` 在桌面端不可见". Its goal text travels as a `user/message` AND its
   *      card travels as an `assistant/message` — the pair is what makes a handoff both legible
   *      and visible.
   *
   * So the tape now carries BOTH:
   *
   *     user/message       source.kind: 'user'   ← the plan, in the user's voice, RENDERED
   *     assistant/message  stream: []            ← the same plan as the assistant's own note, RENDERED
   *
   * `stream: []` is mandatory (a synthetic message has no model stream, and a copied one would
   * make content and stream disagree); `source.kind` must be producer-owned and NOT `plugin` —
   * the host's validator refuses a bare `plugin` kind on an assistant message.
   *
   * The honest cost, stated rather than hidden: the plan appears twice in the transcript, once as
   * the user and once as the assistant. That is the price of being visible in a host whose renderer
   * and model-context paths disagree about which roles are speech.
   */
  const assistantEcho: TapeSeed = {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        id: `${OBSERVER_BRIEFING_ID_PREFIX}echo-${sessionId}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        // A producer-owned model source. `plugin` is refused by the host's validator.
        source: { kind: 'model', provider: 'dsh-observer', model: 'briefing-echo' },
      },
      stream: [],
    },
    surface: true,
  }

  const seeds: TapeSeed[] = [
    { type: 'turn/start', data: { turn }, surface: false },
    { type: 'step/start', data: { turn, step }, surface: false },
    {
      type: 'system/message',
      data: {
        turn,
        step,
        message: {
          id: `observer-${sessionId}-system`,
          role: 'system',
          content: [{ type: 'text', text: [MIGRATION_SYSTEM_PROMPT, injectWorkspaceRedline(cwd)].join('\n\n') }],
          // The host replaces surface node 0 with its own rendered prompt on the first live
          // step; `system-prompt` is the only source kind a system message may carry.
          source: { kind: 'system-prompt' },
        },
      },
      surface: true,
    },
    {
      type: role === 'user' ? 'user/message' : 'developer/message',
      data: role === 'user' ? briefingMessage : { turn, step, message: briefingMessage },
      surface: true,
    },
    ...(role === 'user' ? [assistantEcho] : []),
    {
      type: 'session/title',
      data: {
        // `{main}` is substituted with the MAIN's own id tag by `resolveMainTitle`, so the label
        // identifies this session rather than the one that hatched it.
        title: resolveMainTitle(title, sessionId),
        // The host's own rule: an EMPTY reference list requires `source.kind: 'user'`. A tape
        // has no human message for a title to cite, so empty + 'user' is the only legal shape.
        messageSeqs: [],
        source: { kind: 'user' },
      },
      surface: false,
    },
    { type: 'step/end', data: { turn, step }, surface: false },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, surface: false },
  ]

  // Runtime knobs LAST, after the closed turn — exactly where DSH writes them, and log-only so
  // they can never affect the protected surface head.
  const intent = input.runtimeIntent ?? {}
  for (const [type, data] of [
    ['permission/preset', intent.permission],
    ['sandbox/mode', intent.sandbox],
    ['approval/policy', intent.approval],
    ['model/selection', intent.model],
  ] as Array<[string, Record<string, any> | undefined]>) {
    if (data === undefined) continue
    seeds.push({ type, data, surface: false })
  }
  return seeds
}

/** Materialise the tape: contiguous seq from 0, monotonic time, surface intent only on messages. */
export function materializeInjectTape(seeds: readonly TapeSeed[], createdAt: number): InjectEvent[] {
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new InjectError('EMPTY_TAPE', 'materialize', '注入 tape 为空')
  }
  return seeds.map((seed, index) => {
    const base: InjectEvent = {
      type: seed.type,
      seq: index,
      time: createdAt + index,
      data: seed.data,
    }
    if (seed.surface) {
      if (!SURFACE_TYPES.has(seed.type)) {
        throw new InjectError('SURFACE_TYPE', 'materialize', `${seed.type} 不能作为 surface 事件写出`)
      }
      base.surfaceOp = 'append'
    }
    return base
  })
}

/**
 * Pre-write validation. This runs BEFORE `persistence.create`, so a shape mistake costs nothing:
 * no id is reserved, no artifact exists, no cleanup is needed.
 *
 * `briefingRole` decides WHICH contract applies, because they are genuinely different trades:
 * a visible briefing must be a renderable `user/message` plus its `assistant/message` echo, while
 * a context-only briefing is a step-scoped `developer/message` that nothing renders. Validating
 * one against the other's rules is how a fix becomes the next bug.
 */
export function assertInjectTape(
  events: readonly InjectEvent[],
  options: { cwd: string; sessionId: string; expectedText: string; briefingRole?: 'user' | 'developer' },
): void {
  const { cwd, sessionId, expectedText } = options
  const briefingRoleForValidation: 'user' | 'developer' = options.briefingRole === 'developer' ? 'developer' : 'user'
  if (!isAbsoluteCwd(cwd)) {
    throw new InjectError('CWD_INVALID', 'validate', `cwd ${JSON.stringify(cwd)} 不是绝对路径`)
  }
  if (events.length < 5) {
    throw new InjectError('TAPE_TOO_SHORT', 'validate', `tape 只有 ${events.length} 个事件，缺少完整骨架`)
  }
  for (const [index, event] of events.entries()) {
    if (Number(event.seq) !== index) {
      throw new InjectError('SEQ_GAP', 'validate', `事件 ${index} 的 seq 是 ${String(event.seq)}`)
    }
    if (SURFACE_TYPES.has(event.type)) {
      if (event.surfaceOp !== 'append') {
        throw new InjectError('RED_LINE_SURFACE', 'validate', `${event.type} 必须带 surfaceOp: 'append'`)
      }
    } else if (event.surfaceOp !== undefined) {
      throw new InjectError('RED_LINE_SURFACE', 'validate', `${event.type} 不得带 surfaceOp`)
    }
    if (event.type === 'tool/result') {
      throw new InjectError('RED_LINE_TOOL_RESULT', 'validate', 'tape 里不能有独立的 tool/result')
    }
  }

  // The lifecycle machine. A message outside an open step is exactly the write the host refuses;
  // catching it here is what turns "worked on my machine" into a red test.
  let turn: number | null = null
  let step: number | null = null
  const surfaces: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        if (turn !== null) throw new InjectError('SKELETON', 'validate', `turn ${turn} 仍然打开时又写了 turn/start`)
        if (event.data?.turn !== 1) throw new InjectError('SKELETON', 'validate', `turn/start 的 turn 必须是 1，实际 ${String(event.data?.turn)}`)
        turn = 1
        step = null
        break
      }
      case 'step/start': {
        if (turn === null) throw new InjectError('SKELETON', 'validate', 'step/start 之前没有 turn/start')
        if (step !== null) throw new InjectError('SKELETON', 'validate', `step ${step} 仍然打开时又写了 step/start`)
        if (event.data?.turn !== turn || event.data?.step !== 1) {
          throw new InjectError('SKELETON', 'validate', `step/start 的 turn/step 必须是 ${turn}/1`)
        }
        step = 1
        break
      }
      case 'step/end': {
        if (step === null || event.data?.step !== step) throw new InjectError('SKELETON', 'validate', 'step/end 与打开的 step 不匹配')
        step = null
        break
      }
      case 'turn/end': {
        if (turn === null || step !== null) throw new InjectError('SKELETON', 'validate', 'turn/end 之前 step 仍然打开')
        if (event.data?.turn !== turn) throw new InjectError('SKELETON', 'validate', 'turn/end 的 turn 与打开的不一致')
        if (event.data?.reason?.kind !== 'completed') {
          throw new InjectError('SKELETON', 'validate', "turn/end 的 reason.kind 必须是 'completed'，主脑必须休眠着出生")
        }
        turn = null
        break
      }
      default: {
        if (SURFACE_TYPES.has(event.type)) {
          surfaces.push(event.type)
          /**
           * STEP-SCOPED vs FREE. On this host a `user/message` carries NO `turn`/`step` (measured:
           * real logs hold `data{content,source,role,id}` and nothing else), while
           * `system/message` / `developer/message` / `assistant/message` do and are validated
           * against the OPEN pair. Enforcing the pair on a user message would reject the very
           * shape the host itself writes; skipping it on a developer message would let the
           * historical bug through. So the rule follows the event type, not a blanket rule.
           */
          const stepScoped = event.type !== 'user/message'
          if (stepScoped) {
            if (turn === null || step === null) {
              throw new InjectError(
                'STEP_OUTSIDE_TURN',
                'validate',
                `${event.type} 写在了没有打开的 turn/step 之外 —— 这就是宿主拒绝的那类写入`,
              )
            }
            if (event.data?.turn !== turn || event.data?.step !== step) {
              throw new InjectError('STEP_OUTSIDE_TURN', 'validate', `${event.type} 的 turn/step 与打开的 ${turn}/${step} 不一致`)
            }
          } else if (event.data?.turn !== undefined || event.data?.step !== undefined) {
            throw new InjectError(
              'USER_MESSAGE_STEP_SCOPE',
              'validate',
              'user/message 不能携带 turn/step：宿主自己的 user/message 从不带这两个字段',
            )
          }
        }
        break
      }
    }
  }
  if (turn !== null || step !== null) {
    throw new InjectError('SKELETON_OPEN', 'validate', 'tape 结束时骨架仍未闭合')
  }
  if (surfaces[0] !== 'system/message') {
    throw new InjectError('RED_LINE_SYSTEM_HEAD', 'validate', '第一个 surface 事件必须是 system/message（受保护的 surface head）')
  }

  /**
   * THE BRIEFING: found by ROLE, not by event type.
   *
   * v1.3.1 made the briefing a `user/message` because a `developer/message` never renders. The
   * validation therefore asks "is there exactly one message carrying this exact text, and is its
   * role one of the two we accept" instead of "is there a developer/message" — otherwise the fix
   * for the invisible message would have failed its own guard.
   */
  const briefingIndex = events.findIndex(
    (event) => event.type === 'user/message' || event.type === 'developer/message',
  )
  if (briefingIndex < 0) {
    throw new InjectError('MISSING_BRIEFING', 'validate', 'tape 里没有承载方案的 user/message 或 developer/message')
  }
  const briefing = events[briefingIndex]
  const briefingMessage = briefing.data?.message ?? briefing.data
  if (briefingMessage?.role !== 'user' && briefingMessage?.role !== 'developer') {
    throw new InjectError('RED_LINE_BRIEFING_ROLE', 'validate', `承载方案的消息 role 是 ${String(briefingMessage?.role)}，应为 user 或 developer`)
  }
  const briefingText = briefingMessage?.content?.[0]?.text
  if (typeof briefingText !== 'string' || briefingText !== expectedText) {
    throw new InjectError('BRIEFING_MISMATCH', 'validate', '承载方案的消息内容与传入的方案不一致')
  }

  /**
   * A VISIBLE briefing must be attributable to US — but through the ID, not the source kind.
   *
   * v1.3.1 required `source.kind: 'plugin:…'` here. That requirement is what made the plan
   * invisible: `session-reference/projection.js` keeps a `user/message` only when
   * `source.kind === 'user'`, so the marker told every surface reader "do not show this". The
   * requirement was right about the GOAL (never be mistaken for a human) and wrong about the
   * PLACE (the surface is where visibility is decided).
   *
   * Provenance now rides on the message id, which no projector consults, and the human/plugin
   * distinction is enforced where it matters: `source.kind` is exactly `'user'` (so the renderer
   * shows it) while the id says `observer-briefing-…` (so WE know), and a briefing carries no
   * `rpcId` — the field that marks a real human prompt.
   */
  if (briefing.type === 'user/message') {
    const kind = briefingMessage?.source?.kind
    if (kind !== 'user') {
      throw new InjectError(
        'RED_LINE_BRIEFING_SOURCE',
        'validate',
        `可见的 user/message 的 source.kind 必须是 'user'（实际 ${JSON.stringify(kind)}）—— ` +
          '投影器只渲染 kind=user 的 user/message，其它值等于主动隐藏它',
      )
    }
    if (briefingMessage?.role !== 'user') {
      throw new InjectError('RED_LINE_BRIEFING_ROLE', 'validate', 'user/message 的 message.role 必须是 user')
    }
    if (typeof briefingMessage?.id !== 'string' || !briefingMessage.id.startsWith(OBSERVER_BRIEFING_ID_PREFIX)) {
      throw new InjectError(
        'RED_LINE_BRIEFING_PROVENANCE',
        'validate',
        `可见的 user/message 的 id 必须带 ${OBSERVER_BRIEFING_ID_PREFIX} 前缀（实际 ${JSON.stringify(briefingMessage?.id)}），` +
          '否则无法把这条消息与我们自己写的区分开',
      )
    }
    if (briefingMessage?.source?.rpcId !== undefined) {
      // An rpcId is what marks a message as a real human prompt; ours must never carry one.
      throw new InjectError(
        'RED_LINE_BRIEFING_PROVENANCE',
        'validate',
        '我们写的 user/message 不能带 rpcId —— 那是真人 prompt 的标记',
      )
    }
  }

  /**
   * The RENDERED ECHO: when the briefing is visible, an `assistant/message` must carry the same
   * text. This is the pair graft ships (goal as user, card as assistant), and it is the half that
   * makes a cold session's opening turn legible in the transcript before the model replies.
   */
  if (briefingRoleForValidation === 'user') {
    const echo = events.find((event) => event.type === 'assistant/message')
    if (echo === undefined) {
      throw new InjectError(
        'MISSING_ECHO',
        'validate',
        '可见方案缺少 assistant/message 回显：宿主会渲染它，缺了就等于只在模型侧可见',
      )
    }
    const echoMessage = echo.data?.message
    if (echoMessage?.role !== 'assistant') {
      throw new InjectError('RED_LINE_ECHO_ROLE', 'validate', 'assistant/message 的 role 必须是 assistant')
    }
    if (!Array.isArray(echo.data?.stream) || echo.data.stream.length !== 0) {
      throw new InjectError('RED_LINE_ECHO_STREAM', 'validate', 'assistant/message 的 stream 必须是 []')
    }
    const echoKind = echoMessage?.source?.kind
    if (typeof echoKind !== 'string' || echoKind.length === 0 || echoKind === 'plugin') {
      throw new InjectError(
        'RED_LINE_ECHO_SOURCE',
        'validate',
        `assistant/message 的 source.kind 必须是 producer-owned 且不是 'plugin'（实际 ${JSON.stringify(echoKind)}）`,
      )
    }
    if (echoMessage?.content?.[0]?.text !== expectedText) {
      throw new InjectError('ECHO_MISMATCH', 'validate', 'assistant/message 回显的文本与方案不一致')
    }
  }

  const titleEvent = events.find((event) => event.type === 'session/title')
  if (titleEvent !== undefined) {
    if (typeof titleEvent.data?.title !== 'string' || titleEvent.data.title.length === 0) {
      throw new InjectError('RED_LINE_TITLE', 'validate', 'session/title 的标题为空')
    }
    const refs = Array.isArray(titleEvent.data?.messageSeqs) ? titleEvent.data.messageSeqs : []
    const kind = titleEvent.data?.source?.kind
    if ((refs.length === 0) !== (kind === 'user')) {
      throw new InjectError('RED_LINE_TITLE_SOURCE', 'validate', "session/title 空引用必须配 source.kind: 'user'")
    }
  }
  /**
   * The SYSTEM HEAD is still checked, and it is checked after the briefing; the two are separate
   * concerns and a failure in one must not hide the other.
   */
  const system = events.find((event) => event.type === 'system/message')
  const systemMessage = system?.data?.message
  if (systemMessage?.role !== 'system' || systemMessage?.source?.kind !== 'system-prompt') {
    throw new InjectError('RED_LINE_SYSTEM_ROLE', 'validate', 'system/message 的 role/source 不合法')
  }
  if (!Array.isArray(systemMessage?.content) || systemMessage.content.length === 0) {
    throw new InjectError('RED_LINE_SYSTEM_CONTENT', 'validate', 'system/message 的内容为空')
  }

  if (sessionId.length === 0) throw new InjectError('MISSING_ID', 'validate', '缺少会话 id')
}

/* ── 3. THE WRITE ─────────────────────────────────────────────────────────── */

/** Copy the source's durable knobs, so the incubated main resumes under the same policy. */
async function readSourceRuntime(
  ctx: InjectContext,
  sourceSessionId: string,
): Promise<{ agentPreset?: string; runtimeIntent: Record<string, Record<string, any>>; warnings: string[] }> {
  const out: { agentPreset?: string; runtimeIntent: Record<string, Record<string, any>>; warnings: string[] } = {
    runtimeIntent: {},
    warnings: [],
  }
  const query = resolveService(ctx, 'sessionQuery', 'readSession')
  if (!asRecord(query) || typeof query.readSession !== 'function') {
    out.warnings.push('sessionQuery 不可用：未继承运行时常量（provider/model/preset）')
    return out
  }
  let snapshot: any
  try {
    snapshot = await query.readSession(sourceSessionId)
  } catch (error) {
    out.warnings.push(`读发起会话日志失败，未继承运行时常量：${String((error as any)?.message ?? error)}`)
    return out
  }
  const events: any[] = asRecord(snapshot) && Array.isArray(snapshot.events) ? snapshot.events : []
  let preset = typeof snapshot?.session?.agentPreset === 'string' ? String(snapshot.session.agentPreset) : ''
  for (const event of events) {
    if (!asRecord(event)) continue
    if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      preset = String(event.data.agentPreset)
      continue
    }
    if (event.type === 'model/selection' && typeof event.data?.provider === 'string' && typeof event.data?.model === 'string') {
      out.runtimeIntent.model = {
        provider: event.data.provider,
        model: event.data.model,
        ...(typeof event.data.reasoningEffort === 'string' ? { reasoningEffort: event.data.reasoningEffort } : {}),
      }
      continue
    }
    if (event.type === 'permission/preset' && typeof event.data?.preset === 'string') {
      out.runtimeIntent.permission = { preset: event.data.preset }
      continue
    }
    if (event.type === 'sandbox/mode' && typeof event.data?.mode === 'string') {
      out.runtimeIntent.sandbox = { mode: event.data.mode }
      continue
    }
    if (event.type === 'approval/policy' && typeof event.data?.policy === 'string') {
      out.runtimeIntent.approval = { policy: event.data.policy }
      continue
    }
  }
  if (preset.length > 0) out.agentPreset = preset
  return out
}

/**
 * Create a COLD main session and write the whole tape through the store-owned writer.
 *
 * Order is defensive on purpose: everything that can fail without leaving a trace runs first
 * (cwd, source read, tape build, tape validation, persistence probe), so `persistence.create`
 * is the first operation that reserves an id — and if anything after it fails, the rollback in
 * `catch` runs before the original error escapes.
 */
export async function injectColdSession(ctx: InjectContext, request: InjectRequest): Promise<InjectResult> {
  const warnings: string[] = []
  const sourceSessionId = typeof request?.sourceSessionId === 'string' ? request.sourceSessionId.trim() : ''
  if (sourceSessionId.length === 0) {
    throw new InjectError('MISSING_SOURCE', 'arguments', '缺少发起会话 id')
  }
  const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : ''
  if (cwd.length === 0 || !isAbsoluteCwd(cwd)) {
    // Requirement 1.2, literally: no cwd means no session. Never create an orphan.
    throw new InjectError(
      'CWD_REQUIRED',
      'resolve-cwd',
      `拒绝创建没有归属的主脑：发起会话 ${sourceSessionId} 的 cwd 为空或不是绝对路径（${JSON.stringify(request.cwd)}）`,
    )
  }

  const sessions = resolveService(ctx, 'sessions', 'get')
  if (!asRecord(sessions) || typeof sessions.prepare !== 'function') {
    throw new InjectError('SESSIONS_UNAVAILABLE', 'prepare', 'ctx.sessions.prepare 不可用：宿主不允许准备零继承会话')
  }
  const persistence = resolveService(ctx, 'sessionPersistence', 'create')
  if (!asRecord(persistence) || typeof persistence.create !== 'function') {
    throw new InjectError(
      'PERSISTENCE_REQUIRED',
      'persistence.create',
      'ctx.sessionPersistence.create 不可用：没有持久化句柄就无法写出冷主脑（live append 会撞 SessionStore）',
    )
  }

  const source = await readSourceRuntime(ctx, sourceSessionId)
  warnings.push(...source.warnings)

  const sessionId = typeof request.sessionId === 'string' && request.sessionId.trim().length > 0
    ? request.sessionId.trim()
    : `session-${randomUUID()}`

  // Preflight: never overwrite a live identity.
  if (typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
    throw new InjectError('SESSION_EXISTS', 'preflight', `会话 ${sessionId} 已在 live store 中`)
  }
  if (typeof persistence.stat === 'function') {
    const existing = await persistence.stat(sessionId)
    if (existing !== undefined && existing !== null) {
      throw new InjectError('SESSION_EXISTS', 'preflight', `会话 ${sessionId} 已存在于持久层`)
    }
  }

  const prepared = sessions.prepare(sessionId, {
    meta: { cwd, ...(source.agentPreset === undefined ? {} : { agentPreset: source.agentPreset }) },
  })
  if (!asRecord(prepared) || !asRecord(prepared.header)) {
    throw new InjectError('PREPARE_FAILED', 'prepare', 'sessions.prepare 没有返回可用的 header')
  }
  // Requirement 1.2 again, on the artifact: the prepared header must carry the EXACT source cwd.
  if (prepared.header.cwd !== cwd) {
    throw new InjectError(
      'CWD_MISMATCH',
      'prepare',
      `prepared header 的 cwd ${JSON.stringify(prepared.header.cwd)} 不是发起会话的 cwd ${JSON.stringify(cwd)}`,
    )
  }
  if ((prepared.header as any).isSeeded !== false) {
    throw new InjectError('SEEDED_HEADER', 'prepare', '主脑必须是未播种的顶层会话（isSeeded !== false）')
  }
  const lineage = prepared.header as any
  if (lineage.parentSession !== undefined || lineage.parentSessionId !== undefined || lineage.lineage !== undefined) {
    throw new InjectError('LINEAGE_NOT_EMPTY', 'prepare', '主脑不能带 lineage（那是 subagent/fork 的形状）')
  }

  const briefingRole: 'user' | 'developer' = request.briefingRole === 'developer' ? 'developer' : 'user'
  const seeds = buildInjectTape({
    sessionId,
    cwd,
    text: request.text,
    title: request.title,
    runtimeIntent: source.runtimeIntent,
    briefingRole,
  })
  const headerCreatedAt = Number(prepared.header.createdAt)
  const createdAt = Number.isFinite(headerCreatedAt) && headerCreatedAt > 0
    ? headerCreatedAt
    : (Number.isFinite(Number(request.createdAt)) ? Number(request.createdAt) : Date.now())
  const events = materializeInjectTape(seeds, createdAt)
  assertInjectTape(events, { cwd, sessionId, expectedText: request.text, briefingRole })
  const types = events.map((event) => event.type)

  let created = false
  let stage = 'persistence.create'
  try {
    const handle = await persistence.create(prepared.header, { inheritedEventCount: 0 })
    created = true
    stage = 'handle'
    if (!asRecord(handle) || typeof handle.append !== 'function') {
      throw new InjectError('HANDLE_INVALID', 'persistence.create', 'persistence.create 没有返回可写的 handle')
    }
    stage = 'append'
    await handle.append(events)
    stage = 'flush'
    if (typeof handle.flush !== 'function') {
      throw new InjectError('HANDLE_INVALID', 'flush', 'handle 没有 flush：写出的 tape 无法保证落盘')
    }
    await handle.flush()
    stage = 'close'
    if (typeof handle.close === 'function') await handle.close()

    /**
     * THE COLD-READ CHECK IS NOT JUST "SAME COUNT": the briefing must be findable, in the role we
     * asked for, carrying our source marker. "I wrote a developer/message that the reader cannot
     * see" passed every earlier check in this file — the only test that catches it is one that
     * looks for the message the way a READER would.
     */
    stage = 'cold-read'
    let verified = false
    let briefingEventSeq: number | null = null
    let briefingSourceKind = ''
    let coldEventsForReport: any[] = []
    const query = resolveService(ctx, 'sessionQuery', 'readSession')
    if (asRecord(query) && typeof query.readSession === 'function') {
      const cold = await query.readSession(sessionId)
      const coldEvents: any[] = asRecord(cold) && Array.isArray(cold.events) ? cold.events : []
      coldEventsForReport = coldEvents
      if (Number(cold?.inheritedEventCount ?? 0) !== 0) {
        throw new InjectError('COLD_READ_MISMATCH', 'cold-read', `冷读 inheritedEventCount 是 ${String(cold?.inheritedEventCount)}，应为 0`)
      }
      if (cold?.session?.cwd !== cwd) {
        throw new InjectError(
          'COLD_READ_MISMATCH',
          'cold-read',
          `冷读 cwd ${JSON.stringify(cold?.session?.cwd)} 不是 ${JSON.stringify(cwd)}`,
        )
      }
      if (coldEvents.length !== events.length) {
        throw new InjectError(
          'COLD_READ_MISMATCH',
          'cold-read',
          `冷读事件数 ${coldEvents.length} 与写入数 ${events.length} 不一致`,
        )
      }
      for (const [index, event] of coldEvents.entries()) {
        if (Number(event?.seq) !== index || event?.type !== types[index]) {
          throw new InjectError(
            'COLD_READ_MISMATCH',
            'cold-read',
            `冷读事件 ${index} 是 ${String(event?.type)}，期望 ${String(types[index])}`,
          )
        }
      }
      const briefingEvent = coldEvents.find(
        (event) => event?.type === 'user/message' || event?.type === 'developer/message',
      )
      if (briefingEvent === undefined) {
        throw new InjectError('BRIEFING_NOT_FOUND', 'cold-read', '冷读日志里找不到承载方案的消息')
      }
      briefingEventSeq = Number(briefingEvent.seq)
      briefingSourceKind = String((briefingEvent.data?.message ?? briefingEvent.data)?.source?.kind ?? '')
      const briefingPayload = briefingEvent.data?.message ?? briefingEvent.data
      const briefingText = briefingPayload?.content?.[0]?.text
      if (briefingText !== request.text) {
        throw new InjectError('BRIEFING_MISMATCH', 'cold-read', '冷读回来的方案文本与写入的不一致')
      }
      if (briefingRole === 'user') {
        // Provenance is on the ID now (see OBSERVER_BRIEFING_ID_PREFIX): the source kind must be
        // exactly 'user' so the renderer shows it, so provenance cannot live there.
        if (briefingSourceKind !== 'user') {
          throw new InjectError(
            'BRIEFING_NOT_RENDERABLE',
            'cold-read',
            `冷读回来的 user/message 的 source.kind 是 ${JSON.stringify(briefingSourceKind)}，` +
              '不是 user —— 投影器会丢弃它，等于方案不可见',
          )
        }
        if (typeof briefingPayload?.id !== 'string' || !briefingPayload.id.startsWith(OBSERVER_BRIEFING_ID_PREFIX)) {
          throw new InjectError(
            'BRIEFING_NOT_MARKED',
            'cold-read',
            `冷读回来的 user/message 的 id 没有 ${OBSERVER_BRIEFING_ID_PREFIX} 前缀（实际 ${JSON.stringify(briefingPayload?.id)}）`,
          )
        }
      }
      /**
       * THE WHOLE TAPE IS RE-VALIDATED, not just counted.
       *
       * v1.3.0 compared `count`, `seq` and `type` — which catches a truncated or reordered log and
       * MISSES every shape defect: a lost `surfaceOp`, a skeleton event that grew one, a briefing
       * that came back as a different role, a title whose refs no longer match its source. graft
       * re-runs its full `assertColdLog` on the cold read for exactly this reason (and has caught
       * real host regressions with it), so the same rule applies here: the reader's copy must pass
       * the SAME validator the writer's copy passed. Anything the validator finds is a persistence
       * round-trip defect, which is the only class of failure this check can even see.
       */
      assertInjectTape(coldEvents as InjectEvent[], { cwd, sessionId, expectedText: request.text, briefingRole })
      verified = true
    } else {
      warnings.push('sessionQuery 不可用：写入未经冷读校验')
    }

    // Placement in the sidebar: the same registry call the host uses. Best effort, reported.
    let workspaceAttached = false
    const registry = resolveService(ctx, 'workspaceRegistry', 'resolveByPath')
    if (asRecord(registry) && typeof registry.resolveByPath === 'function') {
      try {
        let workspace = await registry.resolveByPath(cwd)
        if (workspace === undefined && typeof registry.create === 'function') {
          workspace = await registry.create(cwd)
        }
        if (asRecord(workspace) && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(sessionId)
          workspaceAttached = true
        }
      } catch (error) {
        warnings.push(`工作区分组失败：${String((error as any)?.message ?? error)}`)
      }
    }

    // A COLD session is invisible to the Web UI until it is announced: the client learns about
    // sessions exclusively from `api-session/added`. Same payload shape the host's own
    // summarizeCold produces.
    try {
      if (typeof ctx.emit === 'function') {
        ctx.emit('api-session/added', {
          sessionId,
          updatedAt: createdAt,
          agentAvailable: false,
          formatStatus: 'current',
          running: false,
          blank: false,
          cwd,
        })
      }
    } catch (error) {
      warnings.push(`客户端通告失败：${String((error as any)?.message ?? error)}`)
    }

    return {
      sessionId,
      cwd,
      cwdSource: typeof request.cwdSource === 'string' ? request.cwdSource : 'caller',
      appended: events.length,
      verified,
      workspaceAttached,
      types,
      warnings,
      briefingRole,
      briefingVisible: briefingRole === 'user',
      briefingEventSeq,
      briefingSourceKind,
    }
  } catch (error) {
    /**
     * Attribute the failure to the STEP it happened in, and keep the original error as the cause.
     *
     * A `flush` that throws a bare `disk full` must not surface as `[INJECT_FAILED] inject`: the
     * stage is the first thing whoever reads the report needs. An InjectError already knows its
     * stage; anything else is wrapped HERE, where the stage variable is still in scope, with the
     * original message and stack appended rather than replaced.
     */
    const original = error instanceof InjectError
      ? error
      : new InjectError(
          'INJECT_FAILED',
          stage,
          `${String((error as any)?.message ?? error)}\n--- original stack ---\n${
            typeof (error as any)?.stack === 'string' ? (error as any).stack : '(no stack)'
          }`,
        )
    if (created) {
      const rolled = await rollbackInjectedSession(ctx, sessionId, String((original as any)?.message ?? original))
      warnings.push(
        rolled.removed
          ? `已回滚并删除空主脑 ${sessionId}（${rolled.notes.join(', ')}）`
          : `已尝试回滚 ${sessionId}，但宿主没有删除接口（${rolled.notes.join(', ') || '无可用方法'}）`,
      )
      ;(original as any).rollback = rolled
    }
    ;(original as any).warnings = warnings
    // The ORIGINAL error keeps its stack; the caller reports it verbatim.
    throw original
  }
}/**
 * Is the artifact really gone? The point of asking is that "the method returned" and "the session
 * is removed" are different facts, and reporting the first as the second is how a phantom session
 * survives a rollback that claimed to succeed.
 */
async function artifactIsGone(persistence: any, sessionId: string): Promise<boolean | undefined> {
  try {
    if (asRecord(persistence) && typeof persistence.stat === 'function') {
      const stat = await persistence.stat(sessionId)
      return stat === undefined || stat === null
    }
  } catch {
    // A stat that throws cannot answer the question.
  }
  return undefined
}

/**
 * Remove a half-built main. The host exposes no `delete` on SessionPersistence, so cleanup is
 * layered and honest: whatever refuses to go is reported, never silently swallowed.
 *
 * `removed` is EARNED, not assumed: it is set only when the artifact is verifiably absent
 * afterwards (`stat` answers "not there", or the store's own `read` finds nothing). A method that
 * exists and resolves while the session is still on disk is recorded as `no-op`, which is exactly
 * the case that used to be reported as a successful delete.
 */
export async function rollbackInjectedSession(
  ctx: InjectContext,
  sessionId: string,
  reason: string,
): Promise<RollbackResult> {
  const notes: string[] = []
  let removed = false
  let marked = false
  const persistence = (() => {
    try {
      return resolveService(ctx, 'sessionPersistence', 'create')
    } catch {
      return undefined
    }
  })()
  const sessions = (() => {
    try {
      return resolveService(ctx, 'sessions', 'get')
    } catch {
      return undefined
    }
  })()

  const before = await artifactIsGone(persistence, sessionId)
  if (before === true) {
    // Nothing existed to remove. Saying "removed" here would claim work that never happened;
    // the caller still learns the outcome, which is that no phantom is left behind.
    notes.push('artifact absent before rollback: nothing to remove')
    try {
      ctx.logger?.warn?.(`[dsh-observer] rollback ${sessionId}: ${reason} (nothing to remove; ${notes.join(', ')})`)
    } catch {
      // Logging must never replace the primary failure.
    }
    return { removed: false, marked: false, notes }
  } else {
    for (const method of ['discardPrepared', 'discard', 'forget']) {
      if (!asRecord(persistence) || typeof (persistence as any)[method] !== 'function') continue
      try {
        await (persistence as any)[method](sessionId)
        notes.push(`persistence.${method}`)
      } catch (error) {
        notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
      }
      break
    }
    for (const method of ['remove', 'delete']) {
      if (!asRecord(persistence) || typeof (persistence as any)[method] !== 'function') continue
      try {
        await (persistence as any)[method](sessionId)
        notes.push(`persistence.${method}`)
      } catch (error) {
        notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
      }
      break
    }
    if (asRecord(sessions) && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
      for (const method of ['remove', 'delete', 'dispose']) {
        if (typeof (sessions as any)[method] !== 'function') continue
        try {
          await (sessions as any)[method](sessionId)
          notes.push(`sessions.${method}`)
        } catch (error) {
          notes.push(`sessions.${method} failed: ${String((error as any)?.message ?? error)}`)
        }
        break
      }
    }
    const after = await artifactIsGone(persistence, sessionId)
    if (after === true) {
      removed = true
    } else if (after === undefined) {
      // No stat to ask: the strongest honest claim is "a removal API ran".
      removed = notes.some((note) => /^persistence\.(discardPrepared|discard|forget|remove|delete)$/u.test(note))
      if (removed) notes.push('removal unverifiable: no persistence.stat on this host')
    } else {
      notes.push('artifact still present after every removal attempt')
    }
  }

  // If it cannot be deleted, it must not look usable. A title survives a reload; an unmarked
  // empty session becomes "the main that hatched but never got a plan".
  if (!removed && asRecord(persistence) && typeof (persistence as any).open === 'function') {
    try {
      const handle = await (persistence as any).open(sessionId)
      if (asRecord(handle) && typeof handle.append === 'function') {
        await handle.append([
          {
            // seq is what the store hands out next; a log-only title is legal at any position,
            // and this artifact is being abandoned, so the exact number does not matter — only
            // that the mark lands.
            type: 'session/title',
            seq: 0,
            time: Date.now(),
            data: {
              title: `[孵化失败] ${sessionId}`,
              messageSeqs: [],
              source: { kind: 'user' },
            },
          },
        ])
        if (typeof handle.flush === 'function') await handle.flush()
        if (typeof handle.close === 'function') await handle.close()
        marked = true
        notes.push('marked [孵化失败]')
      }
    } catch (error) {
      notes.push(`mark failed: ${String((error as any)?.message ?? error)}`)
    }
  }
  try {
    ctx.logger?.warn?.(
      `[dsh-observer] rollback ${sessionId}: ${reason} (removed=${String(removed)}, marked=${String(marked)}; ${notes.join(', ') || 'no api'})`,
    )
  } catch {
    // Logging must never replace the primary failure.
  }
  return { removed, marked, notes }
}
