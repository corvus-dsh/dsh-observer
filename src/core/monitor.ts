/**
 * MONITOR — the observer as a SITE SUPERVISOR (监理), v1.7.0.
 *
 * WHY THIS FILE EXISTS
 *
 * Up to v1.6.0 the observer hatched a main and then went to sleep: the pair existed, the main ran,
 * and nothing on the observer side ever looked at it again. The user's requirement was explicit —
 * 「副脑孵化主脑后，不能就此休眠，它需要充当监理」 — with two jobs:
 *
 *   1. FAILURE CORRECTION — if the main fails the SAME tool three times in a row, or closes five
 *      turns without moving its TODO list, the observer sends it a hint: look in the memory store,
 *      or change approach. It must not sit and watch a loop.
 *   2. IDLE MEMORY EXTRACTION — when the main finishes a node (or goes quiet), the observer quietly
 *      calls `memory_harvest` so this run's successes and traps enter the flywheel.
 *
 * WHY THE DECISIONS LIVE HERE AND NOT IN `index.ts`
 *
 * A supervisor that acts on every event is a spammer; one that acts on none is decoration. The
 * difference is a small state machine with hard limits (a streak length, a stall length, a cooldown,
 * a cap), and that machine has to be testable WITHOUT a host: no timers, no services, no logging.
 * So this module is PURE — `stepMonitor()` takes the state and one event and returns the actions it
 * decided on; the caller owns the clock, the timers and the delivery channel.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - It never appends to the main's log. Writing a step-scoped event into a RUNNING session means
 *     matching the session's open turn/step, and `{turn: 0, step: 0}` is not a legal pair — that
 *     mistake cost a whole release earlier (see `injectSetting` in index.ts). Delivery is the
 *     caller's job and goes through the Host's own steer channel.
 *   - It never edits the main's TODO list, and never claims progress on the main's behalf.
 *   - It does not decide WHICH skill to use; it points at the memory store, which is the thing that
 *     actually knows.
 */

/** How many consecutive failures of the SAME tool trigger the correction. */
export const FAILURE_STREAK_LIMIT = 3

/** How many closed turns without a TODO movement trigger the stall correction. */
export const STALL_TURNS_LIMIT = 5

/** Minimum wall-clock gap between two corrections for one main. */
export const NUDGE_COOLDOWN_MS = 5 * 60_000

/**
 * Minimum log-distance between two corrections.
 *
 * The wall clock alone is not enough: a resumed session can append a hundred events in a second,
 * and a hint per hundred events is still a hint per second of the model's life.
 */
export const NUDGE_MIN_SEQ_GAP = 12

/** Hard cap per main. Past this the observer has said its piece; nagging is not supervision. */
export const NUDGE_CAP = 4

/** The quiet window after which a main that stopped appending is treated as idle. */
export const IDLE_HARVEST_MS = 90_000

/** Minimum gap between two harvest attempts for one main. */
export const HARVEST_COOLDOWN_MS = 30 * 60_000

/** How many retired sessions one background harvest may mine. */
export const HARVEST_LIMIT = 3

/** Prefix on every correction, so the main (and the log reader) can tell it apart from a user turn. */
export const NUDGE_MARKER = '[dsh-observer 纠偏]'

/** Recognise `todo_write` under a namespace, exactly like graft does. */
const TODO_TOOL = /(?:^|[^a-z0-9])todo[_-]?write$/iu

export interface MonitorOptions {
  failureStreak: number
  stallTurns: number
  nudgeCooldownMs: number
  nudgeMinSeqGap: number
  nudgeCap: number
  harvestCooldownMs: number
  /** The clock. Injected so the pure tests do not depend on wall time. */
  now: () => number
}

export const DEFAULT_MONITOR_OPTIONS: MonitorOptions = {
  failureStreak: FAILURE_STREAK_LIMIT,
  stallTurns: STALL_TURNS_LIMIT,
  nudgeCooldownMs: NUDGE_COOLDOWN_MS,
  nudgeMinSeqGap: NUDGE_MIN_SEQ_GAP,
  nudgeCap: NUDGE_CAP,
  harvestCooldownMs: HARVEST_COOLDOWN_MS,
  now: () => Date.now(),
}

export interface FailureStreak {
  tool: string
  count: number
  firstSeq: number
  lastSeq: number
}

export interface TodoSnapshot {
  signature: string
  open: number
  total: number
}

export interface MonitorState {
  /** callId → tool name, so a `tool/result` can be attributed to the call that caused it. */
  pending: Record<string, string>
  /** callId → the todo payload of a not-yet-settled `todo_write`. */
  pendingTodo: Record<string, TodoSnapshot>
  /** The current same-tool failure streak, or null when the last result was a success. */
  failure: FailureStreak | null
  /** Closed turns since the TODO list last MOVED (a rewrite with the same content is not a move). */
  stalledTurns: number
  lastTodoSeq: number
  todoSignature: string
  openTodos: number
  totalTodos: number
  turnsClosed: number
  events: number
  lastSeq: number
  nudges: number
  lastNudgeAt: number
  lastNudgeSeq: number
  /** The TODO signature already mined, so a finished board is not harvested twice. */
  harvestedSignature: string
  harvestedTurns: number
  /** A sliced main is mined exactly once; a repeated transfer event must not spend a second call. */
  harvestedReplacement: boolean
  harvests: number
  lastHarvestAt: number
}

export function createMonitorState(): MonitorState {
  return {
    pending: {},
    pendingTodo: {},
    failure: null,
    stalledTurns: 0,
    lastTodoSeq: 0,
    todoSignature: '',
    openTodos: 0,
    totalTodos: 0,
    turnsClosed: 0,
    events: 0,
    lastSeq: 0,
    nudges: 0,
    lastNudgeAt: 0,
    lastNudgeSeq: 0,
    harvestedSignature: '',
    harvestedTurns: 0,
    harvestedReplacement: false,
    harvests: 0,
    lastHarvestAt: 0,
  }
}

export type MonitorAction =
  | { kind: 'nudge'; trigger: 'failure' | 'stall'; text: string; detail: string; seq: number }
  | { kind: 'harvest'; reason: HarvestReason; detail: string }

/**
 * Parse a `todo_write` argument payload from every shape a log may carry.
 *
 * Mirrors graft's parser on purpose: a stringified payload, a bare array, or an object with
 * `todos`. An item is done when `completed`/`done` is true or `status` says so.
 */
export function todoItemsFromArguments(raw: unknown): Array<{ text: string; done: boolean }> | undefined {
  let payload: unknown = raw
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const list = Array.isArray(payload) ? payload : (payload as any).todos
  if (!Array.isArray(list)) return undefined
  const items: Array<{ text: string; done: boolean }> = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text.length > 0) items.push({ text, done: false })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const text = String((entry as any).content ?? (entry as any).text ?? (entry as any).title ?? '').trim()
    if (text.length === 0) continue
    const status = String((entry as any).status ?? '')
    const done =
      (entry as any).completed === true ||
      (entry as any).done === true ||
      status === 'completed' ||
      status === 'done'
    items.push({ text, done })
  }
  return items.length === 0 ? undefined : items
}

function snapshotOf(items: Array<{ text: string; done: boolean }>): TodoSnapshot {
  return {
    signature: items.map((item) => `${item.done ? 'x' : ' '} ${item.text}`).join('|'),
    open: items.filter((item) => !item.done).length,
    total: items.length,
  }
}

/** The hint a main receives when it is going in circles. */
export function failureNudgeText(tool: string, count: number): string {
  return [
    `${NUDGE_MARKER} 检测到连续 ${count} 次相同的工具失败（${tool}）。`,
    '建议：先用 `memory_search` 查一下前人的经验与已知的坑，或换一条替代方案；',
    '不要在同一处用同样的参数反复重试。若确认是环境问题，请把缺口明确写出来再继续。',
  ].join('\n')
}

/** The hint a main receives when its board has not moved. */
export function stallNudgeText(stalledTurns: number, todoSeq: number, openTodos: number): string {
  return [
    `${NUDGE_MARKER} 检测到连续 ${stalledTurns} 轮没有推进 TODO 清单` +
      `（清单最后一次移动在 seq=${todoSeq}，仍有 ${openTodos} 项未完成）。`,
    '建议：先如实更新一次 `todo_write`（完成了什么、卡在哪一项），再挑一个最小可验证的下一步；',
    '如果卡在同一处，用 `memory_search` 查经验，或换方案，而不是继续原样重试。',
  ].join('\n')
}

function cooldownBlocks(state: MonitorState, options: MonitorOptions, seq: number): string {
  if (state.nudges >= options.nudgeCap) return `已达上限 ${options.nudgeCap} 次`
  const since = options.now() - state.lastNudgeAt
  if (state.nudges > 0 && since < options.nudgeCooldownMs) return `冷却中（${Math.round(since / 1000)}s < ${Math.round(options.nudgeCooldownMs / 1000)}s）`
  if (state.lastNudgeSeq > 0 && seq - state.lastNudgeSeq < options.nudgeMinSeqGap) {
    return `日志距离过近（${seq - state.lastNudgeSeq} < ${options.nudgeMinSeqGap} 个事件）`
  }
  return ''
}

/**
 * Fold ONE event into the state and answer what the supervisor decided.
 *
 * The event shapes are the host's own (`tool/call`, `tool/result`, `turn/end`, …); anything else is
 * counted and ignored, because a supervisor that reacts to every event shape is a supervisor that
 * reacts to none of them meaningfully.
 */
export function stepMonitor(
  state: MonitorState,
  event: any,
  options: MonitorOptions = DEFAULT_MONITOR_OPTIONS,
): MonitorAction[] {
  const actions: MonitorAction[] = []
  if (event === null || typeof event !== 'object') return actions

  const type = typeof event.type === 'string' ? event.type : ''
  const rawSeq = Number(event.seq)
  const seq = Number.isFinite(rawSeq) ? rawSeq : state.lastSeq
  state.events += 1
  if (Number.isFinite(seq) && seq > state.lastSeq) state.lastSeq = seq

  if (type === 'tool/call') {
    const callId = String(event.data?.callId ?? '')
    const name = String(event.data?.name ?? '')
    if (callId.length === 0 || name.length === 0) return actions
    state.pending[callId] = name
    if (TODO_TOOL.test(name)) {
      const items = todoItemsFromArguments(event.data?.arguments)
      if (items !== undefined) state.pendingTodo[callId] = snapshotOf(items)
    }
    return actions
  }

  if (type === 'tool/result') {
    const message = event.data?.message
    const callId = String(message?.source?.callId ?? message?.toolCallId ?? event.data?.callId ?? '')
    const tool = callId.length > 0 && state.pending[callId] !== undefined ? state.pending[callId] : ''
    if (callId.length > 0) delete state.pending[callId]
    const failed = message?.isError === true || event.data?.error !== undefined

    if (failed) {
      // A failed todo_write never changed the model's board, so its payload is dropped as well.
      if (callId.length > 0) delete state.pendingTodo[callId]
      const name = tool.length > 0 ? tool : '(unknown)'
      if (state.failure !== null && state.failure.tool === name) {
        state.failure.count += 1
        state.failure.lastSeq = seq
      } else {
        state.failure = { tool: name, count: 1, firstSeq: seq, lastSeq: seq }
      }
      if (state.failure.count >= options.failureStreak) {
        const blocked = cooldownBlocks(state, options, seq)
        if (blocked.length === 0) {
          const text = failureNudgeText(state.failure.tool, state.failure.count)
          actions.push({
            kind: 'nudge',
            trigger: 'failure',
            text,
            detail: `${state.failure.tool} 连续失败 ${state.failure.count} 次（seq ${state.failure.firstSeq}…${state.failure.lastSeq}）`,
            seq,
          })
          state.nudges += 1
          state.lastNudgeAt = options.now()
          state.lastNudgeSeq = seq
          state.failure = null
        }
      }
      return actions
    }

    // Any success ends the failure streak: the agent moved on.
    state.failure = null
    const settled = callId.length > 0 ? state.pendingTodo[callId] : undefined
    if (settled !== undefined) {
      delete state.pendingTodo[callId]
      const moved = settled.signature !== state.todoSignature
      state.todoSignature = settled.signature
      state.openTodos = settled.open
      state.totalTodos = settled.total
      state.lastTodoSeq = seq
      // Only a CHANGE is progress. Rewriting the same board is not moving.
      if (moved) state.stalledTurns = 0
    }
    return actions
  }

  if (type === 'turn/end') {
    state.turnsClosed += 1
    state.stalledTurns += 1

    const finished =
      state.totalTodos > 0 && state.openTodos === 0 && state.todoSignature.length > 0
    if (finished) {
      actions.push({
        kind: 'harvest',
        reason: 'completed',
        detail: `清单 ${state.totalTodos} 项全部完成（seq=${state.lastTodoSeq}）`,
      })
    } else if (state.lastTodoSeq > 0 && state.stalledTurns >= options.stallTurns) {
      const blocked = cooldownBlocks(state, options, seq)
      if (blocked.length === 0) {
        actions.push({
          kind: 'nudge',
          trigger: 'stall',
          text: stallNudgeText(state.stalledTurns, state.lastTodoSeq, state.openTodos),
          detail: `连续 ${state.stalledTurns} 轮未推进 TODO（最后移动 seq=${state.lastTodoSeq}）`,
          seq,
        })
        state.nudges += 1
        state.lastNudgeAt = options.now()
        state.lastNudgeSeq = seq
        state.stalledTurns = 0
      }
    }
    return actions
  }

  return actions
}

/**
 * May this main be harvested NOW?
 *
 * Three refusals, each with its own reason: the cooldown (a harvest is an LLM extraction, not a
 * cheap read), "nothing has closed yet" for the idle path, and "this exact board was already
 * mined" for the completion path. A refusal is REPORTED by the caller, never swallowed — a silent
 * skip is indistinguishable from a broken supervisor.
 */
/**
 * Why a harvest is being attempted.
 *
 * `completed` — the TODO board reached all-done: a node is finished.
 * `idle`      — the main stopped appending for the quiet window.
 * `replaced`  — the main was SLICED (transferred). This one is the important case and the reason
 *               `memory_harvest` is worth calling at all: harvest mines the handoff ledger's
 *               retired/transferred sessions, and a sliced main IS in that ledger. A live main is
 *               not, which is why the `completed`/`idle` paths usually come back empty-handed.
 */
export type HarvestReason = 'completed' | 'idle' | 'replaced'

export function harvestGate(
  state: MonitorState,
  reason: HarvestReason,
  options: MonitorOptions = DEFAULT_MONITOR_OPTIONS,
  now: number = options.now(),
): { ok: boolean; detail: string } {
  /**
   * ORDER OF THE REFUSALS MATTERS.
   *
   * "This exact board was already mined" is a fact about the WORK, and it is checked before the
   * cooldown — which is a fact about the CLOCK. Reporting "冷却中" for a board that will never be
   * mined again sends a reader looking for a timer that is not the problem.
   */
  if (reason === 'completed' && state.todoSignature.length > 0 && state.harvestedSignature === state.todoSignature) {
    return { ok: false, detail: '这一份完成清单已经提炼过' }
  }
  if (reason === 'idle' && state.turnsClosed === 0) {
    return { ok: false, detail: '这个主脑还没有关闭过任何回合' }
  }
  /**
   * `replaced` bypasses the cooldown ON PURPOSE, once.
   *
   * A slice is a one-time event: the source is retired exactly now, and if this attempt is skipped
   * because a node-completion harvest ran four minutes ago, that episode is never mined — the
   * ledger entry ages out of `harvestLimit` and the flywheel loses it. The double-spend risk is
   * covered instead by `harvestedReplacement`, which makes a repeated transfer event a no-op.
   */
  if (reason === 'replaced') {
    if (state.harvestedReplacement) return { ok: false, detail: '这次切片已经被提炼过' }
    state.harvestedReplacement = true
    state.harvests += 1
    state.lastHarvestAt = now
    return { ok: true, detail: `reason=replaced turns=${state.turnsClosed}` }
  }
  if (state.harvests > 0 && now - state.lastHarvestAt < options.harvestCooldownMs) {
    const left = Math.round((options.harvestCooldownMs - (now - state.lastHarvestAt)) / 1000)
    return { ok: false, detail: `冷却中（还要 ${left}s）` }
  }
  state.harvests += 1
  state.lastHarvestAt = now
  state.harvestedSignature = state.todoSignature
  state.harvestedTurns = state.turnsClosed
  return {
    ok: true,
    detail: `reason=${reason} turns=${state.turnsClosed} todos=${state.totalTodos - state.openTodos}/${state.totalTodos}`,
  }
}

/** A read-only view for `observer_status`: what the supervisor currently believes. */
export function describeMonitorState(state: MonitorState): Record<string, unknown> {
  return {
    events: state.events,
    turnsClosed: state.turnsClosed,
    failureStreak:
      state.failure === null ? null : { tool: state.failure.tool, count: state.failure.count },
    stalledTurns: state.stalledTurns,
    todo: { total: state.totalTodos, open: state.openTodos, lastSeq: state.lastTodoSeq },
    nudges: state.nudges,
    lastNudgeAt: state.lastNudgeAt === 0 ? null : state.lastNudgeAt,
    harvests: state.harvests,
    lastHarvestAt: state.lastHarvestAt === 0 ? null : state.lastHarvestAt,
    /** True once a slice of this main has been mined. */
    harvestedReplacement: state.harvestedReplacement,
  }
}
