/**
 * SUPERVISOR — the host-facing half of the monitor, v1.7.0.
 *
 * `monitor.ts` decides WHAT to do (pure, no clock, no services). This file does it: it watches the
 * main's post-commit feed, delivers a correction through the Host's own steer channel, and calls
 * `memory_harvest` when a node completes or the main goes quiet.
 *
 * THREE THINGS THIS FILE REFUSES TO DO, EACH FOR A MEASURED REASON
 *
 *   1. IT NEVER APPENDS TO THE MAIN'S LOG. `developer/message` is step-scoped: the host validates
 *      `data.turn`/`data.step` against the pair that is OPEN on that session, and a supervisor has
 *      no way to know it (and `{turn: 0, step: 0}` is not just wrong, it is the exact mistake that
 *      cost a release earlier — see `injectSetting` in index.ts). So delivery goes through
 *      `sessionController.prompt(..., { mode: 'steer' })`: the Host admits it into the RUNNING turn
 *      and the pair is the Host's problem, not ours.
 *   2. IT NEVER CLAIMS A HARVEST MINED THIS MAIN WHEN IT DID NOT. `memory_harvest` mines the handoff
 *      ledger's RETIRED sessions. A live main is not retired, so a harvest started while it runs
 *      legitimately finds nothing of it. The report therefore says WHICH sessions were mined and
 *      whether ours was among them; a "ok" that hid that distinction would be exactly the kind of
 *      false success this project keeps rooting out.
 *   3. IT NEVER THROWS INTO THE POST-COMMIT FEED. Every entry point is wrapped: a supervisor that
 *      can break the event bus is worse than no supervisor.
 */

import {
  DEFAULT_MONITOR_OPTIONS,
  HARVEST_LIMIT,
  IDLE_HARVEST_MS,
  type HarvestReason,
  type MonitorAction,
  type MonitorOptions,
  type MonitorState,
  createMonitorState,
  describeMonitorState,
  harvestGate,
  stepMonitor,
} from './monitor.js'
import { ignitionDeadline, describePromptFailure } from './ignition.js'

/**
 * How long a main must be SILENT before the idle harvest is attempted.
 *
 * ── P1-4 (audit 2026-11-08): THIS WAS A SECOND COPY OF THE SAME NUMBER ────────────────────────
 *
 * It used to be its own literal `90_000`, and `harvest()` passed a bare `limit: 3` — while
 * `monitor.ts` declared `IDLE_HARVEST_MS = 90_000` and `HARVEST_LIMIT = 3` for the same two
 * decisions. Two copies of one constant is not a style problem: the first measurable behaviour of
 * this pair was that `monitor.ts` was flagged as carrying dead exports, precisely BECAUSE the
 * supervisor never read them. Whoever tuned one would have silently left the other behind, and the
 * suite would stay green because nothing compared them.
 *
 * It is now ALIASED, not re-declared, so it stays exported (the package entry re-exports it and
 * tests may import it) while there is exactly one number behind it.
 */
export const DEFAULT_SUPERVISOR_IDLE_MS = IDLE_HARVEST_MS

/** The mission text an observer carries once it has hatched a main. Lives here so it cannot drift. */
export const SUPERVISOR_DUTY_TEXT = [
  '你现在**不是执行者**，你是这个主脑的**监理**。',
  '',
  '主脑干活时你要做三件事（都由插件在后台完成，你不需要手动轮询）：',
  '1. 失败纠偏：它连续 3 次同一个工具失败，或连续 5 轮没有推进 TODO 时，系统会自动给它发一条纠偏提示；',
  '2. 记忆提炼：它完成节点或安静下来之后，系统会自动调用 memory_harvest 把这一轮的经验收进记忆库；',
  '3. 只读判断：用户问你「它做得怎么样」时，你可以用 observer_status 读出监理状态再回答。',
].join('\n')

export interface SupervisorReport {
  ok: boolean
  channel?: string
  detail: string
}

export interface HarvestOutcome {
  attempted: boolean
  ok: boolean
  /** Sessions the harvest actually mined, as reported by dsh-memory. */
  mined: string[]
  /** Whether OUR main was among them (it usually is not while it is still live). */
  minedOurMain: boolean
  detail: string
}

export interface Supervisor {
  /** The pair this supervisor watches: observer on one side, main on the other. */
  readonly observerSessionId: string
  readonly mainSessionId: string
  /** Fold one post-commit event of the MAIN into the state and act on its decision. */
  observe(event: any): Promise<void>
  /** The main has been quiet for the idle window: harvest if the gate allows it. */
  onIdle(): Promise<void>
  /**
   * The main was SLICED (retired and replaced by a new id). Mine it before the supervision moves
   * on — a retired main is exactly what `memory_harvest` exists to read.
   */
  onReplaced(): Promise<void>
  /** Read-only view for `observer_status`. */
  describe(): Record<string, unknown>
  /** Test seam: the raw state. */
  state(): MonitorState
  /** Test seam: cancel the idle timer. */
  dispose(): void
}

export interface SupervisorDeps {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  /** `sessionController` — only `prompt` is used. */
  controller?: any
  /** `tools` — only `execute` is used, for `memory_harvest`. */
  tools?: any
  options?: Partial<MonitorOptions>
  /** Idle window in ms. Tests set it small; production uses the default. */
  idleMs?: number
  /** The scheduler. Injected so a test can drive the idle path without waiting. */
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (handle: any) => void
}

/**
 * Build a supervisor for one pair.
 *
 * The factory takes resolved services rather than the whole ctx, so the wiring decision (which
 * service, resolved how) stays in `index.ts` where the other `resolveService` calls live.
 */
export function createSupervisor(
  observerSessionId: string,
  mainSessionId: string,
  deps: SupervisorDeps = {},
): Supervisor {
  const options: MonitorOptions = { ...DEFAULT_MONITOR_OPTIONS, ...(deps.options ?? {}) }
  const state = createMonitorState()
  const idleMs = typeof deps.idleMs === 'number' && deps.idleMs > 0 ? deps.idleMs : DEFAULT_SUPERVISOR_IDLE_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as any))
  let idleTimer: any = null
  let disposed = false
  /** Nudges/harvests already applied, so a duplicate feed delivery cannot double-act. */
  let busy = false

  const log = (message: string): void => deps.logger?.info?.(message)
  const warn = (message: string): void => deps.logger?.warn?.(message)

  const armIdle = (): void => {
    if (disposed) return
    if (idleTimer !== null) clearTimer(idleTimer)
    idleTimer = setTimer(() => {
      idleTimer = null
      void supervisor.onIdle()
    }, idleMs)
    // A pending idle check must never keep the Host process alive.
    if (idleTimer !== null && typeof idleTimer?.unref === 'function') idleTimer.unref()
  }

  /**
   * Deliver ONE correction to the running main.
   *
   * `steer` first: it lands in the turn that is open RIGHT NOW, which is the whole point of a
   * correction. `queue` is the fallback for a session that is between turns — a hint that arrives
   * at the start of the next turn is still better than one that never arrives.
   */
  const deliver = async (action: Extract<MonitorAction, { kind: 'nudge' }>): Promise<SupervisorReport> => {
    const request = (mode: 'steer' | 'queue'): Record<string, unknown> => ({
      requestId: `observer-nudge-${mainSessionId}-${action.seq}-${mode}`,
      sessionId: mainSessionId,
      mode,
      content: [{ type: 'text', text: action.text }],
    })
    if (deps.controller === undefined || typeof deps.controller.prompt !== 'function') {
      return { ok: false, detail: '没有可用的投递通道（sessionController.prompt 未挂载）' }
    }
    const failures: string[] = []
    for (const mode of ['steer', 'queue'] as const) {
      const { signal, release, expired } = ignitionDeadline(15_000)
      try {
        const settled = await Promise.race([deps.controller.prompt(request(mode), signal), expired])
        const accepted =
          settled !== null && typeof settled === 'object' ? (settled as any).accepted !== false : true
        if (accepted) return { ok: true, channel: `sessionController.prompt(${mode})`, detail: action.detail }
        failures.push(`${mode}: 未被接受`)
      } catch (error) {
        failures.push(`${mode}: ${describePromptFailure(error, signal)}`)
      } finally {
        release()
      }
    }
    return { ok: false, detail: failures.join(' | ') }
  }

  /**
   * Ask dsh-memory to mine what has been retired.
   *
   * WHY THE RESULT IS READ THIS CAREFULLY: `memory_harvest` reports `scanned` / `harvested[]` per
   * retired session. If our main is not retired, it cannot be in that list — and saying "记忆已提炼"
   * in that case would be a lie that costs the user their flywheel silently. So the outcome names
   * what actually happened, including "not yet".
   */
  const harvest = async (reason: HarvestReason): Promise<HarvestOutcome> => {
    const gate = harvestGate(state, reason, options)
    if (!gate.ok) return { attempted: false, ok: false, mined: [], minedOurMain: false, detail: gate.detail }
    if (deps.tools === undefined || typeof deps.tools.execute !== 'function') {
      return { attempted: false, ok: false, mined: [], minedOurMain: false, detail: 'tools.execute 不可用' }
    }
    try {
      const result = await deps.tools.execute({
        callId: `observer-harvest-${mainSessionId}-${Date.now()}`,
        name: 'memory_harvest',
        arguments: { limit: HARVEST_LIMIT },
        signal: new AbortController().signal,
      })
      if (result === null || typeof result !== 'object' || result.isError === true) {
        const why =
          result !== null && typeof result === 'object' && result.error !== undefined
            ? String(result.error?.message ?? result.error)
            : 'memory_harvest 返回错误'
        return { attempted: true, ok: false, mined: [], minedOurMain: false, detail: why }
      }
      const value = result.value ?? {}
      const harvested: any[] = Array.isArray(value.harvested) ? value.harvested : []
      const mined = harvested
        .map((entry) => (typeof entry?.sessionId === 'string' ? entry.sessionId : ''))
        .filter((id) => id.length > 0)
      const minedOurMain = mined.includes(mainSessionId)
      const scanned = Number(value.scanned ?? 0)
      return {
        attempted: true,
        ok: true,
        mined,
        minedOurMain,
        detail: minedOurMain
          ? `已提炼主脑 ${mainSessionId}（扫描 ${scanned} 个已退休会话）`
          : reason === 'replaced'
            ? `扫描 ${scanned} 个已退休会话，本次没有主脑 ${mainSessionId} —— 切片记录可能还没落进` +
              `交接账本，下一轮提炼会再取一次`
            : `扫描 ${scanned} 个已退休会话，本次没有主脑 ${mainSessionId} —— 它还活着，` +
              `它的这一轮会在被切片（退休）后自动进入提炼队列`,
      }
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        mined: [],
        minedOurMain: false,
        detail: String((error as any)?.message ?? error),
      }
    }
  }

  const applyActions = async (actions: MonitorAction[]): Promise<void> => {
    for (const action of actions) {
      if (action.kind === 'nudge') {
        const report = await deliver(action)
        if (report.ok) {
          log(
            `[dsh-observer] 纠偏已投递给主脑 ${mainSessionId}（${action.trigger}，via ${report.channel}）：` +
              `${action.detail}`,
          )
        } else {
          // A correction that could not be delivered is a FACT, and it is reported — the
          // alternative (silence) makes a broken supervisor look like a calm one.
          warn(`[dsh-observer] 纠偏投递失败（主脑 ${mainSessionId}，${action.trigger}）：${report.detail}`)
        }
        continue
      }
      const outcome = await harvest(action.reason)
      if (outcome.ok) {
        log(`[dsh-observer] 后台提炼：${outcome.detail}`)
      } else {
        warn(`[dsh-observer] 后台提炼未执行（${action.reason}）：${outcome.detail}`)
      }
    }
  }

  const supervisor: Supervisor = {
    observerSessionId,
    mainSessionId,
    async observe(event: any): Promise<void> {
      if (disposed) return
      try {
        const actions = stepMonitor(state, event, options)
        // Every event that reaches us proves the main is alive, so the quiet clock restarts.
        armIdle()
        if (actions.length === 0) return
        if (busy) {
          // Two decisions in one batch would mean two prompt admissions in the same instant. The
          // state machine already spaces them by seq; this guard covers a slow first delivery.
          warn(`[dsh-observer] 监理正在处理上一批动作，本批 ${actions.length} 个动作已跳过`)
          return
        }
        busy = true
        try {
          await applyActions(actions)
        } finally {
          busy = false
        }
      } catch (error) {
        warn(
          `[dsh-observer] 监理处理主脑 ${mainSessionId} 的事件失败：${String((error as any)?.message ?? error)}`,
        )
      }
    },
    async onIdle(): Promise<void> {
      if (disposed) return
      try {
        const outcome = await harvest('idle')
        if (outcome.ok) log(`[dsh-observer] 主脑 ${mainSessionId} 空闲，后台提炼：${outcome.detail}`)
        else log(`[dsh-observer] 主脑 ${mainSessionId} 空闲，未提炼：${outcome.detail}`)
      } catch (error) {
        warn(`[dsh-observer] 空闲提炼失败：${String((error as any)?.message ?? error)}`)
      }
    },
    /**
     * The main was sliced. Mine it NOW, before the caller swaps the supervision to the new id.
     *
     * WHY THIS RUNS BEFORE THE SWAP: the harvest has to name the OLD id — that is the retired
     * session the ledger knows about. After `dispose()` the supervisor is inert, and after the pair
     * is rewritten the old id is the "previous main", which is precisely the thing that must be
     * mined.
     *
     * It is awaited by the caller (the transfer listener) but never throws: a failed harvest must
     * not stop the pointer from moving, or the pair would keep steering at a retired session.
     */
    async onReplaced(): Promise<void> {
      if (disposed) return
      try {
        const outcome = await harvest('replaced')
        if (outcome.ok) log(`[dsh-observer] 主脑 ${mainSessionId} 被切片，后台提炼：${outcome.detail}`)
        else warn(`[dsh-observer] 主脑 ${mainSessionId} 被切片，未提炼：${outcome.detail}`)
      } catch (error) {
        warn(`[dsh-observer] 切片后提炼失败：${String((error as any)?.message ?? error)}`)
      }
    },
    describe(): Record<string, unknown> {
      return {
        observerSessionId,
        mainSessionId,
        ...describeMonitorState(state),
      }
    },
    state(): MonitorState {
      return state
    },
    dispose(): void {
      disposed = true
      if (idleTimer !== null) {
        clearTimer(idleTimer)
        idleTimer = null
      }
    },
  }
  armIdle()
  return supervisor
}
