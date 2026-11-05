/**
 * IGNITION — make the incubated main start working, instead of waiting to be clicked.
 *
 * WHY THIS FILE EXISTS (v1.5.0)
 *
 * A main session was hatched, carried a complete plan, and sat there. The user's complaint after
 * the acceptance run was exact: 「既然主脑是副脑拉起的，就应该自动跑」.
 *
 * The channel is the Host's own: `sessionController.prompt(request, signal)` — what the Web
 * composer calls. It admits ONE prompt and, critically, RESUMES a cold session from persistence,
 * which is the only way a detached artifact can become a running agent.
 *
 * PORTED FROM dsh-graft-slice, DELIBERATELY, INCLUDING ITS SCARS. That implementation carries three
 * hard-won lessons which are cheap to copy and expensive to rediscover:
 *
 *   1. THE SIGNAL IS A REQUIRED ARGUMENT. In 0.2.2-rc.1 `prompt(request, signal)` touches
 *      `signal.throwIfAborted()` on its first line; passing `undefined` killed every ignition before
 *      the prompt was admitted, and the only symptom was one audit line. The signal is built for
 *      every channel, and its abort doubles as the timeout.
 *   2. IDEMPOTENCE IS NOT OPTIONAL. A prompt that was admitted but not yet visible in the log must
 *      not be admitted twice: a queued duplicate reads to the target as the same instruction given
 *      twice. `alreadyIgnited()` reads the target's own log for the marker before acting.
 *   3. AN UNREADABLE LOG IS "UNKNOWN", NOT "ALREADY DONE". Treating a failed read as success is how
 *      a target stayed permanently inert while the audit said `ok`. Unknown is reported as failure.
 *
 * THE MARKER. Every ignition prompt starts with `IGNITION_MARKER`. It is how a retry recognises its
 * own previous admission, and how a later reader knows the session was started by a plugin rather
 * than a human.
 */

/** Prefix of every ignition prompt. A retry looks for exactly this in the target's log. */
export const IGNITION_MARKER = '[dsh-observer 点火]'

/** How long the Host is given to admit the prompt before the attempt is abandoned. */
export const IGNITION_TIMEOUT_MS = 20_000

export interface IgnitionResult {
  /** A channel was available and a call was made. */
  attempted: boolean
  ok: boolean
  channel?: string
  promptChars?: number
  reason?: string
  /** The target's own log already carried our marker. */
  alreadyIgnited?: true
}

/** What the main is told at the instant it wakes up. */
export const DEFAULT_IGNITION_PROMPT = [
  `${IGNITION_MARKER} 你刚刚被孵化出来，正在接手一项已经确认过的工作。`,
  '你的第一条上下文里就是完整方案（用户已确认的执行计划），它就是你这次的任务书。',
  '请直接按方案开始执行：先做方案里的第一步，不要复述方案，不要重新调研已经写清的环境事实，',
  '也不要问「你要我做什么」。',
  '如果你发现方案里缺少必要信息，先做能做的部分，再把缺口明确列出来。',
].join('\n')

/** Is this text our own ignition, rather than something a human typed? */
export function isIgnitionText(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(IGNITION_MARKER)
}

/**
 * The deadline: an AbortSignal that also doubles as the timeout.
 *
 * `release()` clears the timer on the success path. The rejected `expired` promise is pre-caught so
 * that losing the race does not surface as an unhandled rejection.
 */
export function ignitionDeadline(timeoutMs: number = IGNITION_TIMEOUT_MS): {
  signal: AbortSignal
  release: () => void
  expired: Promise<never>
} {
  const controller = new AbortController()
  let rejectExpired: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => {
    rejectExpired = reject
  })
  const timer = setTimeout(() => {
    const error = new Error(`timeout after ${timeoutMs}ms`)
    controller.abort(error)
    rejectExpired(error)
  }, timeoutMs)
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  expired.catch(() => {})
  return { signal: controller.signal, release: () => clearTimeout(timer), expired }
}

/**
 * Explain WHY the prompt died, in the one line a report keeps.
 *
 * A bare `AbortError` hides the interesting distinction: the Host aborted because the session was
 * busy (retryable) versus our own deadline expiring (a fact about us, not about the target).
 */
export function describePromptFailure(error: unknown, signal: AbortSignal): string {
  const message = String((error as any)?.message ?? error)
  if (signal?.aborted === true) {
    const reason = (signal as any).reason
    const why = typeof reason === 'string' ? reason : String((reason as any)?.message ?? 'deadline')
    return `${message} (aborted: ${why})`
  }
  return message
}

/** Messages that mean "this session does not exist", as opposed to "the read failed". */
const SESSION_MISSING = /not[- ]?found|no such session|SESSION_NOT_FOUND|未知会话/iu

/**
 * Has the target already been ignited by us?
 *
 * Read the target's OWN log for the marker. This is the only check that covers the window between
 * "prompt accepted" and "prompt visible in the log", and it is why a retry can be safe.
 *
 * Returns `true` only on positive evidence. A missing session is `false` (it was certainly never
 * ignited — the resume inside `prompt` is what creates the live agent). Any OTHER read failure is
 * thrown, because "unknown" reported as "already done" is how a target stays inert forever.
 */
export async function alreadyIgnited(ctx: any, targetSessionId: string, readSession: any): Promise<boolean> {
  if (typeof readSession !== 'function') return false
  let snapshot: any
  try {
    snapshot = await readSession(targetSessionId)
  } catch (error) {
    const message = String((error as any)?.message ?? error)
    if (SESSION_MISSING.test(message)) return false
    throw new Error(`cannot read target log: ${message}`)
  }
  const events: any[] = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events) ? snapshot.events : []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const payload = event.data?.message ?? event.data
    if (isIgnitionText(payload?.content?.[0]?.text)) return true
  }
  return false
}

export interface IgniteOptions {
  /** Already-resolved services; the caller owns the resolution policy. */
  controller?: any
  remote?: any
  /** A reader for the target log, used for the idempotence check. */
  readSession?: (sessionId: string) => Promise<any>
  /** Skip the log check (tests, or a caller that just created the session). */
  skipIdempotence?: boolean
  /** Ignore the default prompt and use this text (the marker is prepended when missing). */
  prompt?: string
  mode?: 'queue' | 'steer'
  timeoutMs?: number
}

/**
 * Admit ONE ignition prompt, through the first channel that works.
 *
 * Channels are tried in order and REPORTED: `sessionController.prompt` is the Host service (what
 * the composer uses); `remote.session.prompt` is the same operation through the generated Remote
 * namespace, for a composition where only that face is mounted. No channel means the capability is
 * absent — reported as such, never as a silent no-op.
 */
export async function igniteSession(
  targetSessionId: string,
  options: IgniteOptions = {},
): Promise<IgnitionResult> {
  const prompt = (() => {
    const custom = typeof options.prompt === 'string' ? options.prompt.trim() : ''
    if (custom.length === 0) return DEFAULT_IGNITION_PROMPT
    return custom.startsWith(IGNITION_MARKER) ? custom : `${IGNITION_MARKER} ${custom}`
  })()

  if (options.skipIdempotence !== true && typeof options.readSession === 'function') {
    try {
      if (await alreadyIgnited(null, targetSessionId, options.readSession)) {
        return { attempted: false, ok: true, alreadyIgnited: true, promptChars: prompt.length }
      }
    } catch (error) {
      // UNKNOWN is a failure, so the caller can retry rather than believe a lie.
      return {
        attempted: false,
        ok: false,
        reason: String((error as any)?.message ?? error),
        promptChars: prompt.length,
      }
    }
  }

  const request = (): Record<string, unknown> => ({
    requestId: `observer-ignite-${targetSessionId}-${Date.now().toString(36)}`,
    sessionId: targetSessionId,
    mode: options.mode === 'steer' ? 'steer' : 'queue',
    content: [{ type: 'text', text: prompt }],
  })

  const channels: Array<[string, (signal: AbortSignal) => Promise<unknown>]> = []
  if (options.controller !== undefined && typeof options.controller.prompt === 'function') {
    // The signal is the REQUIRED second argument; passing undefined killed every v0.31 ignition.
    channels.push(['sessionController.prompt', (signal) => options.controller.prompt(request(), signal)])
  }
  const remoteSession = options.remote?.session
  if (remoteSession !== undefined && typeof remoteSession.prompt === 'function') {
    channels.push(['remote.session.prompt', (signal) => remoteSession.prompt(request(), signal)])
  }
  if (channels.length === 0) {
    return {
      attempted: false,
      ok: false,
      reason: 'no ignition channel: ctx.sessionController.prompt is not mounted',
      promptChars: prompt.length,
    }
  }

  const failures: string[] = []
  const { signal, release, expired } = ignitionDeadline(options.timeoutMs ?? IGNITION_TIMEOUT_MS)
  try {
    for (const [label, run] of channels) {
      try {
        const settled = await Promise.race([run(signal), expired])
        // A reply that explicitly says `accepted: false` is a refusal, not an admission.
        const accepted = settled !== null && typeof settled === 'object' ? (settled as any).accepted !== false : true
        if (accepted) return { attempted: true, ok: true, channel: label, promptChars: prompt.length }
        failures.push(`${label}: prompt was not accepted`)
      } catch (error) {
        failures.push(`${label}: ${describePromptFailure(error, signal)}`)
      }
    }
  } finally {
    release()
  }
  return { attempted: true, ok: false, reason: failures.join(' | '), promptChars: prompt.length }
}
