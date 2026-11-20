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

/**
 * ── v0.39 (B2-T4): THE GRAPH TRIGGER ────────────────────────────────────────────────────────────
 *
 * Recognise `memory_graph_update` under a namespace, for the same reason `TODO_TOOL` exists: the
 * host may present a plugin tool as `memory_graph_update` or `memory__memory_graph_update`, and an
 * exact `===` comparison silently misses the second spelling — the trigger would never fire for that
 * deployment, and nothing would say why.
 */
const GRAPH_TOOL = /(?:^|[^a-z0-9])memory[_-]?graph[_-]?update$/iu

/**
 * How many DISTINCT tools in the recent window count as "multi-step".
 *
 * Threshold discipline: this is a starting point, not a measurement — and it is reported as such.
 * The reasoning that produced it: a one-file edit uses one or two tools (read, then edit); a phase of
 * real work uses at least three (search/read, edit/write, a verification step). Below three, the
 * trigger would nag about single edits; the cost of being late is a stale graph, which TD-M17 already
 * records as the next problem to solve.
 */
export const GRAPH_DISTINCT_TOOLS_LIMIT = 3

export interface MonitorOptions {
  failureStreak: number
  stallTurns: number
  nudgeCooldownMs: number
  nudgeMinSeqGap: number
  nudgeCap: number
  harvestCooldownMs: number
  /** v0.39: distinct tools in the recent window that count as multi-step work. */
  graphDistinctTools: number
  /** The clock. Injected so the pure tests do not depend on wall time. */
  now: () => number
  /**
   * ── v1.4 (B4-0b-2 W2-2): ONE PLACE TO SAY "THE CLOCK MOVED" ─────────────────────────────────
   *
   * A backwards clock or a backwards `seq` used to FAIL CLOSED and say nothing: `since` went
   * negative, `since < cooldown` stayed true forever, and every correction was silently frozen. That
   * is the worst kind of dead supervisor — it looks calm, and calm is indistinguishable from "nothing
   * to say".
   *
   * Injected rather than imported, the same way `now` is: the decision stays pure, and the caller
   * keeps the logger. Defaulted to a no-op so no existing test has to change.
   */
  warn?: (message: string) => void
}

export const DEFAULT_MONITOR_OPTIONS: MonitorOptions = {
  failureStreak: FAILURE_STREAK_LIMIT,
  stallTurns: STALL_TURNS_LIMIT,
  nudgeCooldownMs: NUDGE_COOLDOWN_MS,
  nudgeMinSeqGap: NUDGE_MIN_SEQ_GAP,
  nudgeCap: NUDGE_CAP,
  harvestCooldownMs: HARVEST_COOLDOWN_MS,
  graphDistinctTools: GRAPH_DISTINCT_TOOLS_LIMIT,
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
  /**
   * v1.4 (W2-3): results that arrived WITHOUT a `callId`, so the observer could not say which tool
   * produced them. Counted, never used as a streak: sameness cannot be established from them.
   */
  unattributedResults: number
  /** Closed turns since the TODO list last MOVED (a rewrite with the same content is not a move). */
  stalledTurns: number
  lastTodoSeq: number
  /**
   * ── AUDIT F6/F7: WAS THE BOARD EVER BUILT? ───────────────────────────────────────────────────
   *
   * WHY THIS IS A FIELD AND NOT `lastTodoSeq > 0`. The stall trigger used to require
   * `lastTodoSeq > 0`, so a main that never called `todo_write` could never be corrected — measured:
   * eight closed turns, no board, `nudges = 0`. Meanwhile a main that DID build a board and then
   * stalled was corrected. That is a reverse incentive: the supervisor was blind to exactly the
   * disordered main it exists to watch.
   *
   * The condition was `lastTodoSeq > 0` because the code had no other way to ask "has it ever
   * moved". Deriving a SEMANTIC fact from a counter's zero-ness is a side effect, not a model: it
   * conflates "never built a board" with "built one but it has not moved", and those need different
   * words to the model.
   *
   * So the fact gets its own field, set once, and never cleared. `totalTodos > 0` also implies it,
   * but only AFTER a settle; this is set the moment a `todo_write` is SEEN, which is the honest
   * answer to "did the main ever try".
   */
  everUsedTodo: boolean
  /**
   * ── v0.39 (B2-T4): HAS THIS MAIN EVER BUILT A TASK GRAPH? ─────────────────────────────────────
   *
   * `everUsedTodo` is about the TODO board; this is about the PLAN. They are different artefacts and
   * different absences: a main can keep a perfect TODO list and never build a graph, and the
   * supervisor had no way to notice — `memory_graph_update` appeared ZERO times in this repository
   * before this release.
   *
   * Set the moment the call is SEEN (not when it settles), for the same reason `everUsedTodo` is: the
   * question is "did it ever try", and a call that failed still answers yes.
   */
  sawGraphTool: boolean
  /**
   * The tool names seen in the turn that is currently open. Flushed into `recentTurnTools` at
   * `turn/end`, which is where the multi-step evidence is evaluated.
   */
  toolsThisTurn: string[]
  /** Per-turn tool sets for the recent window, newest last, capped at `stallTurns`. */
  recentTurnTools: string[][]
  /**
   * ── ONCE PER MAIN, ON PURPOSE ────────────────────────────────────────────────────────────────
   *
   * "There is no graph" is a STATE, not an event. Correcting it every time the window fills is the
   * nagging this module exists to avoid — and a main that has already been told once and chose not to
   * build one is making a decision, not missing a hint.
   */
  graphNudged: boolean
  todoSignature: string
  openTodos: number
  totalTodos: number
  turnsClosed: number
  events: number
  lastSeq: number
  nudges: number
  lastNudgeAt: number
  lastNudgeSeq: number
  /**
   * ── v1.4 (W2-2): WHAT THE CLOCK DID, IN PLAIN WORDS ─────────────────────────────────────────
   *
   * Set when a backwards clock or a backwards `seq` was DETECTED and corrected. Empty means "the
   * timeline was monotonically sane". It lives in the state (not only in a log line) so
   * `observer_status` can show it: a correction that can only be seen by tailing a log is a
   * correction nobody sees.
   */
  clockRewind: string
  /** The TODO signature already mined, so a finished board is not harvested twice. */
  harvestedSignature: string
  harvestedTurns: number
  /** A sliced main is mined exactly once; a repeated transfer event must not spend a second call. */
  harvestedReplacement: boolean
  harvests: number
  lastHarvestAt: number
  /**
   * ── v0.41 (B4-0b-1 A1): WHY EACH TRIGGER LAST STAYED SILENT ────────────────────────────────────
   *
   * "0 nudges" used to read the same whether the trigger was unneeded, cooled down, out of budget,
   * or broken. `observer_status` reported `graph.nudged:false` next to `distinctToolsRecent:3` — a
   * combination that reads "it does not need one" while actually meaning "it cannot send one".
   * The rule that refused is recorded here, per trigger, so a reader can tell the two apart.
   *
   * Values are the four words the audit asked for: `cap` / `cooldown` / `seq` / `fired`.
   */
  blocked: { failure: NudgeBlockCode | ''; stall: NudgeBlockCode | ''; graph: NudgeBlockCode | '' }
}

export function createMonitorState(): MonitorState {
  return {
    pending: {},
    pendingTodo: {},
    failure: null,
    unattributedResults: 0,
    stalledTurns: 0,
    lastTodoSeq: 0,
    everUsedTodo: false,
    sawGraphTool: false,
    toolsThisTurn: [],
    recentTurnTools: [],
    graphNudged: false,
    todoSignature: '',
    openTodos: 0,
    totalTodos: 0,
    turnsClosed: 0,
    events: 0,
    lastSeq: 0,
    nudges: 0,
    lastNudgeAt: 0,
    lastNudgeSeq: 0,
    clockRewind: '',
    harvestedSignature: '',
    harvestedTurns: 0,
    harvestedReplacement: false,
    harvests: 0,
    lastHarvestAt: 0,
    blocked: { failure: '', stall: '', graph: '' },
  }
}

/**
 * ── v1.4 (B4-0b-2 W2-1): A SUPERVISOR THAT RESTARTED HAS NOT BEEN CORRECTING LESS ──────────────
 *
 * `createMonitorState()` starts at zero, and the whole budget lives in that object. So a Host restart
 * (or a plugin reload — this file is re-imported) handed every main a FRESH cap of four: the observer
 * could nag the same session four more times, four more after that, and the file that records "this
 * main needed these corrections" was the only thing that remembered.
 *
 * The seed comes from the long-term ledger, which is already the observer's memory of mains. This
 * function is deliberately structural (`{...}` rather than importing `MainRecord`) so `monitor.ts`
 * keeps no dependency on the ledger module: the caller owns the IO, the decision module owns the
 * decision.
 *
 * NOT restored on purpose: `failure`, `pending`, `toolsThisTurn`, `blocked`. Those describe events in
 * a LOG, and a log that restarted at seq 0 cannot be resumed by a stale in-flight streak.
 */
export function hydrateMonitorState(
  state: MonitorState,
  seed: {
    nudges?: number
    lastNudgeAt?: number
    lastNudgeSeq?: number
    stalledTurns?: number
    harvestedReplacement?: boolean
  },
): void {
  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  state.nudges = number(seed.nudges)
  state.lastNudgeAt = number(seed.lastNudgeAt)
  state.lastNudgeSeq = number(seed.lastNudgeSeq)
  state.stalledTurns = number(seed.stalledTurns)
  state.harvestedReplacement = seed.harvestedReplacement === true
}

/**
 * ── v1.4 (W2-2): A BACKWARDS TIMELINE IS A FACT TO CORRECT, NOT A REASON TO GO QUIET ────────────
 *
 * Measured shape: `since = now - lastNudgeAt` went NEGATIVE when the wall clock stepped back (a VM
 * resume, a manual clock change, NTP correcting a fast clock). `since < cooldown` is then true for
 * as long as the clock stays behind — so no correction can EVER fire, and the reason is invisible
 * because a blocked trigger is silent by design.
 *
 * Same shape for `seq`: after a compaction the main's log can restart below `lastNudgeSeq`, and
 * `seq - lastNudgeSeq < gap` then holds forever.
 *
 * ── WHY `lastNudgeAt` IS SET TO "COOLDOWN ALREADY ELAPSED", NOT TO `now` ────────────────────────
 *
 * The obvious repair — "reset `lastNudgeAt = now`" — does not work, and the reason is worth writing
 * down: `since` becomes 0, and the very next check reads 0 as "just nudged", which is the SAME
 * freeze one line later. Anchoring the cooldown at `now - cooldownMs` states what is actually true
 * at this moment: the previous correction is not recent, because the clock that timed it is gone.
 * The criterion ("must fire, and say so") is what governs; the letter of "= now" would fail it.
 */
export function normaliseTimeline(state: MonitorState, seq: number, options: MonitorOptions): void {
  const now = options.now()
  const notes: string[] = []
  if (state.lastNudgeAt > 0 && now < state.lastNudgeAt) {
    const behindMs = state.lastNudgeAt - now
    state.lastNudgeAt = now - options.nudgeCooldownMs
    notes.push(
      `时钟倒退 ${Math.round(behindMs / 1000)}s（上次纠偏记在 ${state.lastNudgeAt + options.nudgeCooldownMs}，` +
        `现在 ${now}）：冷却按「已过」处理，否则 since<0 会让纠偏永久静默`,
    )
  }
  if (state.lastNudgeSeq > 0 && seq < state.lastNudgeSeq) {
    notes.push(`日志 seq 回退（${seq} < ${state.lastNudgeSeq}，会话被压缩或重建）：距离规则重置`)
    /** `0` DISABLES the seq rule (the guard is `lastNudgeSeq > 0`), which is the point of a reset. */
    state.lastNudgeSeq = 0
  }
  if (notes.length === 0) return
  state.clockRewind = notes.join('；')
  options.warn?.(`[dsh-observer] 时间线已被纠正：${state.clockRewind}`)
}

export type MonitorAction =
  | { kind: 'nudge'; trigger: 'failure' | 'stall' | 'graph'; text: string; detail: string; seq: number }
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

/**
 * ── AUDIT F6/F7: THE SENTENCE FOR A MAIN THAT NEVER BUILT A BOARD ───────────────────────────────
 *
 * A DIFFERENT complaint, because it is a different situation. `stallNudgeText` says "you have not
 * MOVED your list" and cites `seq`/`openTodos`; for a main that never wrote a list those numbers are
 * meaningless, and telling it "your list has not moved" would be simply false — there is no list to
 * be behind on.
 *
 * What is actually wrong in that case is an absence of any visible progress at all. So the ask is to
 * START one, and it stays an ask rather than an accusation: a single-turn task legitimately needs no
 * board, which is why this only fires after `stalledTurns`, never immediately.
 */
export function stallWithoutBoardText(stalledTurns: number): string {
  return [
    `${NUDGE_MARKER} 已连续 ${stalledTurns} 轮没有任何可见的进度记录（这段会话里还没有建立过 TODO 板）。`,
    '如果你在做多步任务，请用一次 `todo_write` 说明：已经完成了什么、当前卡在哪一项、下一步是什么；',
    '如果任务本来就只需一两步，用一句结论说明现状即可 —— 这里要的是「可见的进度」，不是形式。',
    '如果卡在同一处，用 `memory_search` 查经验，或换方案，而不是继续原样重试。',
  ].join('\n')
}

/**
 * ── v0.39 (B2-T4): THE SENTENCE FOR A MAIN THAT NEVER BUILT A GRAPH ─────────────────────────────
 *
 * A THIRD complaint, because it is a third situation. `stallNudgeText` is about a board that stopped
 * moving; `stallWithoutBoardText` is about having no board at all. This one is about doing real
 * multi-step work and never writing the plan down — the work is visible, the PLAN is not, and
 * "where am I in the plan" is exactly what a sliced successor will need.
 *
 * It cites the measurements it was decided on (turns, distinct tool kinds) rather than asserting a
 * feeling: `已连续 N 轮用了 M 种工具` is checkable by the reader, and a main that believes it was not
 * multi-step can say so.
 */
export function graphNudgeText(turns: number, distinctTools: number): string {
  return [
    `${NUDGE_MARKER} 已连续 ${turns} 轮在做多步工作（用过 ${distinctTools} 种工具），但这段会话从未建立任务图。`,
    '建议先调用 `memory_graph_update`（op:bootstrap 可从零建整张计划），',
    '之后每完成一个节点更新状态；跨切片的「我在哪」与 observer 的进度判断都依赖它。',
  ].join('\n')
}

/**
 * ── v0.39 (B2-T4): DECIDE AND RECORD THE GRAPH NUDGE ────────────────────────────────────────────
 *
 * Split out of `stepMonitor` so the three conditions read as three conditions, and so the "already
 * spoke / already built one" guards are one early return instead of a nested if. Returns whether it
 * fired — the stall branch uses that to yield for one step rather than talk over it.
 */
function maybeGraphNudge(state: MonitorState, options: MonitorOptions, seq: number, actions: MonitorAction[]): boolean {
  /** ② already has a graph, or this trigger has already spoken: nothing to do, forever. */
  if (state.sawGraphTool === true || state.graphNudged === true) return false
  /** Not enough log to call it "多步" yet — the window needs `stallTurns` turns in it. */
  if (state.turnsClosed < options.stallTurns) return false
  /** ① multi-step evidence: DISTINCT kinds, because one tool called forty times is one kind. */
  const distinct = new Set(state.recentTurnTools.flat()).size
  if (distinct < options.graphDistinctTools) return false
  /** ③ the shared limits — not a second set of constants. This trigger holds the reserved slot. */
  const blocked = cooldownBlocks(state, options, seq, 'graph')
  if (blocked !== undefined) {
    noteBlock(state, 'graph', blocked.code)
    return false
  }
  noteBlock(state, 'graph', undefined)
  actions.push({
    kind: 'nudge',
    trigger: 'graph',
    text: graphNudgeText(state.turnsClosed, distinct),
    detail: `连续 ${state.turnsClosed} 轮、${distinct} 种工具，但从未建立任务图`,
    seq,
  })
  state.nudges += 1
  state.lastNudgeAt = options.now()
  state.lastNudgeSeq = seq
  state.graphNudged = true
  return true
}

/** The four words `blocked` speaks. `fired` is what a trigger that DID speak reads. */
export type NudgeBlockCode = 'cap' | 'cooldown' | 'seq'

/**
 * ── v0.41 (B4-0b-1 A1): THE GRAPH TRIGGER KEEPS ONE SLOT OF THE SHARED BUDGET ─────────────────────
 *
 * The audit's C-1: a main that collected four failure corrections was then permanently unable to
 * receive the graph correction, because `nudgeCap` is shared and the graph trigger is the LAST thing
 * the supervisor would ever say. `observer_status` meanwhile reported `graph.nudged:false` —
 * indistinguishable from "this main does not need a graph".
 *
 * WHY A RESERVED SLOT AND NOT A SEPARATE COUNTER. The cap exists to bound NAGGING, and the graph
 * trigger is already once-per-main (`graphNudged`), so its own bound is tighter than any cap. What it
 * needs is not a second budget but a guarantee that another trigger cannot spend the LAST slot. So:
 * every other trigger may use `cap - 1`; the graph trigger may use the full `cap`. The total number of
 * nudges a main can ever receive is unchanged (it is still `cap`) — only the last slot is spoken for.
 *
 * Returns the RULE that refused, not a string to be pattern-matched by callers: the caller needs the
 * code to record it, and the sentence for the log.
 */
function cooldownBlocks(
  state: MonitorState,
  options: MonitorOptions,
  seq: number,
  reserveFor?: 'graph',
): { code: NudgeBlockCode; detail: string } | undefined {
  const effectiveCap = reserveFor === 'graph' ? options.nudgeCap : Math.max(0, options.nudgeCap - 1)
  if (state.nudges >= effectiveCap) {
    return {
      code: 'cap',
      detail:
        reserveFor === 'graph'
          ? `已达上限 ${options.nudgeCap} 次`
          : `已达上限 ${effectiveCap} 次（第 ${options.nudgeCap} 个名额留给「从未建图」，它每主脑只发一次）`,
    }
  }
  const since = options.now() - state.lastNudgeAt
  if (state.nudges > 0 && since < options.nudgeCooldownMs) {
    return { code: 'cooldown', detail: `冷却中（${Math.round(since / 1000)}s < ${Math.round(options.nudgeCooldownMs / 1000)}s）` }
  }
  if (state.lastNudgeSeq > 0 && seq - state.lastNudgeSeq < options.nudgeMinSeqGap) {
    return { code: 'seq', detail: `日志距离过近（${seq - state.lastNudgeSeq} < ${options.nudgeMinSeqGap} 个事件）` }
  }
  return undefined
}

/** Record a refusal so `observer_status` can say WHICH rule kept a trigger quiet. */
function noteBlock(state: MonitorState, trigger: 'failure' | 'stall' | 'graph', code: NudgeBlockCode | undefined): void {
  state.blocked[trigger] = code ?? ''
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
  /**
   * BEFORE any trigger is judged. A timeline that is about to be compared against must be sane
   * first — otherwise every rule that follows is answered by a clock the callers cannot see.
   */
  normaliseTimeline(state, seq, options)

  if (type === 'tool/call') {
    const callId = String(event.data?.callId ?? '')
    const name = String(event.data?.name ?? '')
    if (callId.length === 0 || name.length === 0) return actions
    state.pending[callId] = name
    /**
     * v0.39: the two facts the graph trigger needs, recorded when the CALL is seen.
     *
     * `sawGraphTool` is "did it ever try" — a failed call still answers yes, and waiting for a settle
     * would leave the trigger blind to exactly the main whose graph calls never came back.
     * `toolsThisTurn` is the multi-step evidence, deduplicated per turn: calling one tool forty times
     * is one kind of tool, not forty.
     */
    if (GRAPH_TOOL.test(name)) state.sawGraphTool = true
    if (!state.toolsThisTurn.includes(name)) state.toolsThisTurn.push(name)
    if (TODO_TOOL.test(name)) {
      /**
       * AUDIT F6/F7: RECORD THE ATTEMPT, not just the payload.
       *
       * Set HERE — when the call is SEEN — rather than after it settles, because the question the
       * stall trigger has to answer is "did this main ever try to show its plan", and a call that
       * failed still answers yes. Waiting for a settle would also keep the `lastTodoSeq > 0` blind
       * spot for any main whose `todo_write` results never came back.
       */
      state.everUsedTodo = true
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
      /**
       * ── v1.4 (W2-3): A RESULT WITH NO `callId` DOES NOT ENTER THE STREAK ────────────────────────
       *
       * Measured shape: `tool` was `''` whenever the result carried no `callId`, so every such failure
       * was filed under the SAME name, `'(unknown)'`. Four DIFFERENT tools failing once each — which is
       * four unrelated problems — produced a four-long "(unknown) streak" and a correction telling the
       * main it had retried the same tool repeatedly. That sentence was false, and it was false in the
       * direction that makes a supervisor look stupid: the main had done nothing repeatedly.
       *
       * The streak's whole meaning is SAMENESS, and sameness is exactly what an unattributed result
       * cannot establish. So it is counted separately and never compared. `unattributedResults` is
       * shown in `observer_status`, because "results the observer could not attribute" is a fact the
       * reader of a calm-looking report deserves to see.
       */
      if (callId.length === 0) {
        state.unattributedResults += 1
        return actions
      }
      const name = tool.length > 0 ? tool : '(unknown)'
      if (state.failure !== null && state.failure.tool === name) {
        state.failure.count += 1
        state.failure.lastSeq = seq
      } else {
        state.failure = { tool: name, count: 1, firstSeq: seq, lastSeq: seq }
      }
      if (state.failure.count >= options.failureStreak) {
        const blocked = cooldownBlocks(state, options, seq)
        if (blocked === undefined) {
          noteBlock(state, 'failure', undefined)
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
        } else {
          noteBlock(state, 'failure', blocked.code)
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
    /**
     * v0.39: close the turn's tool window. The completed turn joins the evidence, and the list is
     * capped at `stallTurns` so the window really is "the recent window" rather than "everything that
     * ever happened" — a main that used four tools in its first turn and has been writing one file per
     * turn since would otherwise still look multi-step ten turns later.
     */
    if (state.toolsThisTurn.length > 0) state.recentTurnTools.push(state.toolsThisTurn)
    state.toolsThisTurn = []
    while (state.recentTurnTools.length > options.stallTurns) state.recentTurnTools.shift()

    const finished =
      state.totalTodos > 0 && state.openTodos === 0 && state.todoSignature.length > 0
    /**
     * ── v0.39 (B2-T4): THE GRAPH TRIGGER, EVALUATED FIRST ────────────────────────────────────────
     *
     * THREE CONDITIONS, ALL REQUIRED — and they are three INDEPENDENT guards, not one rule written
     * twice. Deleting any single one must turn exactly one test red:
     *
     *   ① MULTI-STEP EVIDENCE — at least `graphDistinctTools` distinct tool kinds across the recent
     *      window. Without it, a one-file edit gets nagged about a plan it does not need.
     *   ② NEVER BUILT A GRAPH — the whole log holds no `memory_graph_update` call. Deliberately
     *      "never", not "not recently": "built one and stopped updating it" is TD-M17's problem, and
     *      merging the two would make this trigger fire forever after a single stale week.
     *   ③ THE SHARED LIMITS — cooldown, seq gap, cap, plus once-per-main for THIS trigger.
     *
     * ── WHY IT OUTRANKS THE STALL BRANCH, AND WHY THAT ORDER IS NOT ARBITRARY ───────────────────
     *
     * Measured while writing this: the trigger was unreachable. A main with no TODO board trips the
     * stall branch at `stallTurns`, which RESETS `stalledTurns`; the graph check then saw a nudge had
     * just gone out and deferred. Five turns later the same thing happened again. The most common
     * case for this trigger — a main that works in many steps and never writes anything down — was
     * starved by the symptom it was meant to diagnose.
     *
     * So the ORDER is the fix: the graph complaint is the more specific one (it names the plan and a
     * tool), it is once-per-main, so pre-empting the stall sentence costs at most one turn, after
     * which the stall branch resumes normally.
     */
    const graphFired = maybeGraphNudge(state, options, seq, actions)
    if (finished) {
      actions.push({
        kind: 'harvest',
        reason: 'completed',
        detail: `清单 ${state.totalTodos} 项全部完成（seq=${state.lastTodoSeq}）`,
      })
    } else if (!graphFired && state.stalledTurns >= options.stallTurns) {
      /**
       * ── AUDIT F6: THE STALL TRIGGER USED TO REQUIRE A BOARD, SO AN ORDERLESS MAIN WAS NEVER SEEN ──
       *
       * WHAT WAS WRONG. The condition was:
       *
       *     state.lastTodoSeq > 0 && state.stalledTurns >= options.stallTurns
       *     ^^^^^^^^^^^^^^^^^^^^^^^ excludes every main that never called todo_write
       *
       * Measured: a main that ran eight turns, never built a board and never reported progress
       * received ZERO corrections (`stalledTurns=8 nudges=0`), while a main that built a board and
       * then stopped moving was corrected. The supervisor was blind to precisely the disordered case
       * it exists to catch — a reverse incentive that teaches a main that ignoring the board is safer
       * than maintaining it.
       *
       * WHY THE CONDITION WAS THERE, and why it is now a separate word rather than a removed guard:
       * a main on a single-turn task legitimately needs no board, so "no TODO" alone is not
       * evidence of being lost. What distinguishes lost from legitimately board-free is STALL —
       * `stalledTurns` — which is already required. So the gate becomes: stall is the evidence,
       * and `everUsedTodo` only chooses WHICH SENTENCE to say.
       *
       * THE TWO SENTENCES ARE DIFFERENT ON PURPOSE (audit F7):
       *   never built  -> "show your progress" — an invitation to begin, because there is no board
       *                   to be behind on, and claiming there is one would be a lie.
       *   built, stalled -> the existing nudge that names the seq and the open count, because that
       *                   main can be told exactly where it stopped.
       */
      const blocked = cooldownBlocks(state, options, seq)
      if (blocked === undefined) {
        noteBlock(state, 'stall', undefined)
        const neverBuilt = state.everUsedTodo !== true
        actions.push({
          kind: 'nudge',
          trigger: 'stall',
          text: neverBuilt
            ? stallWithoutBoardText(state.stalledTurns)
            : stallNudgeText(state.stalledTurns, state.lastTodoSeq, state.openTodos),
          detail: neverBuilt
            ? `连续 ${state.stalledTurns} 轮没有任何进度记录（从未建立 TODO 板）`
            : `连续 ${state.stalledTurns} 轮未推进 TODO（最后移动 seq=${state.lastTodoSeq}）`,
          seq,
        })
        state.nudges += 1
        state.lastNudgeAt = options.now()
        state.lastNudgeSeq = seq
        state.stalledTurns = 0
      } else {
        noteBlock(state, 'stall', blocked.code)
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
export function describeMonitorState(
  state: MonitorState,
  options: MonitorOptions = DEFAULT_MONITOR_OPTIONS,
): Record<string, unknown> {
  return {
    events: state.events,
    turnsClosed: state.turnsClosed,
    failureStreak:
      state.failure === null ? null : { tool: state.failure.tool, count: state.failure.count },
    stalledTurns: state.stalledTurns,
    todo: { total: state.totalTodos, open: state.openTodos, lastSeq: state.lastTodoSeq },
    /**
     * ── v0.39 (B2-T4): THE GRAPH TRIGGER'S OWN READOUT ──────────────────────────────────────────
     *
     * Without this an operator cannot tell a trigger that is DORMANT from one that is BROKEN: "0
     * graph nudges" looks identical whether the main built a graph, or the guard never fired because
     * its condition can never be met. Naming all four facts makes the answer readable.
     */
    graph: {
      /** True once the main has called `memory_graph_update` at least once. */
      sawTool: state.sawGraphTool,
      /** True once this trigger has spoken for this main — it speaks once. */
      nudged: state.graphNudged,
      /** Distinct tool kinds across the recent window: the multi-step evidence, as measured. */
      distinctToolsRecent: new Set(state.recentTurnTools.flat()).size,
      /** Turns currently in the evidence window (bounded by `stallTurns`). */
      windowTurns: state.recentTurnTools.length,
      /**
       * ── v0.41 (B4-0b-1 A1): THE FIFTH FACT ──────────────────────────────────────────────────
       *
       * `fired` (it spoke) / `cap` (the shared budget was spent) / `cooldown` / `seq` (too close to
       * the previous nudge) / `null` (nothing refused it: the conditions simply are not met). Without
       * this, `nudged:false` next to `distinctToolsRecent:3` reads "not needed" when the truth was
       * "could not be sent" — the C-1 report that produced this batch was exactly that misreading.
       */
      blockedBy: state.graphNudged ? 'fired' : state.blocked.graph === '' ? null : state.blocked.graph,
    },
    /**
     * The same refusals for the other two triggers. `nudgeCap` is SHARED (the last slot is reserved
     * for the graph trigger), so `failure`/`stall` can hit `cap` while the budget still has a slot
     * left — that asymmetry is now visible instead of looking like a dead trigger.
     */
    blocked: {
      /** The shared budget, so a reader can compare it against `nudges` without guessing. */
      cap: options.nudgeCap,
      failure: state.blocked.failure === '' ? null : state.blocked.failure,
      stall: state.blocked.stall === '' ? null : state.blocked.stall,
    },
    nudges: state.nudges,
    lastNudgeAt: state.lastNudgeAt === 0 ? null : state.lastNudgeAt,
    clockRewind: state.clockRewind,
    /** v1.4 (W2-3): 「无法归因的结果」也是要看的 —— 它意味着这个监理在这条日志上瞎了一块。 */
    unattributedResults: state.unattributedResults,
    harvests: state.harvests,
    lastHarvestAt: state.lastHarvestAt === 0 ? null : state.lastHarvestAt,
    /** True once a slice of this main has been mined. */
    harvestedReplacement: state.harvestedReplacement,
  }
}
