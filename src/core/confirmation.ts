/**
 * CONFIRMATION — the gate between "a plan exists" and "a plan may be handed to a session that
 * starts working on its own".
 *
 * WHY THIS IS CODE AND NOT ONLY PROSE (v1.6.0)
 *
 * Two acceptance runs failed in OPPOSITE directions, both times because the rule was only words:
 *
 *   v1.3.x: "call it only when the work is too large" → the session measured the task, disagreed
 *           with the user, did the work itself.
 *   v1.4.0: "a repeated instruction means call it NOW" → the session invented a plan, hatched a
 *           main, ignited it, and started building. The user never saw the plan.
 *
 * The second failure is the worse one: an unapproved plan that RUNS is an unapproved plan at scale.
 * A tool description is a probability; the fix has to include something the model cannot talk itself
 * out of. So `observer_spawn_main` now requires an explicit `userConfirmed: true` AND this module
 * looks for EVIDENCE — an `ask_user_question` call in the calling session's own log.
 *
 * WHAT THIS GATE IS AND IS NOT
 *
 *  - It IS a check on a fact: "did this session ask the user a question through the tool that
 *    records one". A model that never asked cannot produce the evidence.
 *  - It is NOT proof that the user said yes. The answer arrives as a tool result, and checking its
 *    text would be parsing prose to guess consent. The honest claim is:
 *    "the question was asked"; the confirmation itself remains the model's assertion + the user's
 *    visible answer in the transcript.
 *  - It does NOT brick a host that cannot read logs. Unverifiable is reported as unverified and
 *    allowed, because refusing on a missing capability would cost the user a session for a
 *    limitation of ours.
 */

/** The built-in tool whose call IS the evidence that the user was asked. */
export const ASK_TOOL_NAME = 'ask_user_question'

export type ConfirmationVerdict =
  | { ok: true; evidence: 'asked'; askedAtSeq: number; detail: string }
  | { ok: true; evidence: 'unverifiable'; askedAtSeq: null; detail: string; warning: string }
  | { ok: false; evidence: 'not-asked'; askedAtSeq: null; detail: string }

/**
 * Find the LAST `ask_user_question` call in a session log.
 *
 * The last one, not the first: a session may have asked something unrelated earlier, and the plan
 * under discussion is the one most recently aligned. Position is returned so a report can point at
 * it instead of asserting "we checked".
 */
export function findAskEvidence(events: readonly any[]): number | null {
  let at: number | null = null
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const name = typeof event.data?.name === 'string' ? event.data.name : ''
    if (name !== ASK_TOOL_NAME) continue
    const seq = Number(event.seq)
    if (Number.isFinite(seq)) at = seq
  }
  return at
}

/**
 * Decide whether the incubation may proceed.
 *
 * @param options.claimed   what the caller asserted (`userConfirmed: true`)
 * @param options.skipped   the caller passed `skipConfirmation: true` (user said "just hatch")
 * @param options.readLog   reads the CALLING session's log; undefined when unavailable
 */
export async function checkConfirmation(options: {
  claimed: boolean
  skipped?: boolean
  readLog?: (sessionId: string) => Promise<any>
  sessionId: string
}): Promise<ConfirmationVerdict> {
  const { claimed, skipped, readLog, sessionId } = options

  // 1. The explicit assertion. Without it, nothing else matters — do not even read the log.
  if (claimed !== true && skipped !== true) {
    return {
      ok: false,
      evidence: 'not-asked',
      askedAtSeq: null,
      detail: '调用方没有声明 userConfirmed: true',
    }
  }

  // 2. The escape hatch the USER can authorise: 「不用确认，直接孵化」.
  if (skipped === true) {
    return {
      ok: true,
      evidence: 'unverifiable',
      askedAtSeq: null,
      detail: '调用方声明用户已明确要求跳过确认（skipConfirmation）',
      warning: '用户显式要求跳过确认环节；请确认这是用户原话，而不是你的推断',
    }
  }

  // 3. The evidence check.
  if (typeof readLog !== 'function') {
    return {
      ok: true,
      evidence: 'unverifiable',
      askedAtSeq: null,
      detail: '本宿主无法读取会话日志，无法核实是否调用过 ask_user_question',
      warning: '未能核实确认证据（sessionQuery 不可用），请确保用户确实已确认',
    }
  }

  let snapshot: any
  try {
    snapshot = await readLog(sessionId)
  } catch (error) {
    return {
      ok: true,
      evidence: 'unverifiable',
      askedAtSeq: null,
      detail: `读取会话日志失败：${String((error as any)?.message ?? error)}`,
      warning: '未能核实确认证据（日志读取失败），请确保用户确实已确认',
    }
  }

  const events: any[] = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events) ? snapshot.events : []
  const askedAtSeq = findAskEvidence(events)
  if (askedAtSeq === null) {
    return {
      ok: false,
      evidence: 'not-asked',
      askedAtSeq: null,
      detail:
        `本会话日志里没有 ${ASK_TOOL_NAME} 的调用记录（共 ${events.length} 个事件）。` +
        '也就是说，你还没有把计划展示给用户并请他确认。',
    }
  }
  return {
    ok: true,
    evidence: 'asked',
    askedAtSeq,
    detail: `已核实：本会话在 seq=${askedAtSeq} 调用过 ${ASK_TOOL_NAME}`,
  }
}

/**
 * The refusal body for a failed confirmation check.
 *
 * Kept next to the check so the two cannot drift: the text names the exact missing fact the code
 * looked for, which is what makes the refusal actionable rather than a wall.
 */
export function confirmationRefusal(verdict: ConfirmationVerdict): string {
  if (verdict.ok) return ''
  return [
    '拒绝孵化：用户确认环节没有完成。',
    '',
    `核实结果：${verdict.detail}`,
    '',
    '这个工具会创建一个**自动开跑**的主脑，所以计划必须先被用户看到并同意。现在应当：',
    '',
    '1. 把计划**完整**写出来（目标、步骤、验证），不要只说「我打算这么做」；',
    `2. 调用 \`${ASK_TOOL_NAME}\` 请用户确认，选项至少包含「确认，开始执行」与「需要调整」；`,
    '3. 等用户明确回复「确认 / 同意 / 开始 / 可以」后，再调用本工具并传 `userConfirmed: true`。',
    '',
    '如果用户还在讨论计划，就继续讨论。**不要**为了通过这个检查而伪造 `userConfirmed`。',
  ].join('\n')
}
