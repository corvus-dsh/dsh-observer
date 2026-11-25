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

/**
 * ── B4-B B6: `unverifiable` WAS ONE WORD FOR TWO DIFFERENT FACTS ──────────────────────────────
 *
 * It used to cover both of these, and both were `ok: true`:
 *
 *   (a) THIS HOST has no log reader at all        — a limitation of OURS
 *   (b) THIS SESSION's log could not be read      — `readLog` threw
 *
 * (b) is not a limitation of ours, and it is not a neutral state either: **it is the exact shape of
 * borrowing somebody else's confirmation.** Measured (probe, 2026-11-21): passing an id whose log
 * cannot be read produced `ok: true`, one created session and one ignition — with no victim that had
 * ever confirmed anything. A caller that can pick the id and cannot be contradicted by a failed read
 * does not need to attack the gate at all; it only needs to name a session the reader chokes on.
 *
 * The two facts also mean different things about the USER:
 *
 *   (a) "we cannot check" — the user may well have confirmed; we just have no way to see it.
 *   (b) "we could not read THIS log" — and `ask_user_question` in a foreign session means THAT
 *       session's user was asked. The plan being hatched now was never shown to them. Borrowing it
 *       would assert 「this plan was shown」 on evidence that belongs to a different plan.
 *
 * So they are separate evidence words, and BOTH are refused by default. The operator can restore
 * the old permissiveness with a CONFIG flag — never a tool argument. A model-facing
 * `--unverified-ok` would be `skipConfirmation` again: a permission slip only the model can sign,
 * about a conversation only the model is producing (see the v2.1.0 note below).
 */
export type ConfirmationEvidence = 'asked' | 'answered' | 'not-asked' | 'unavailable' | 'unreadable'

export type ConfirmationVerdict =
  /**
   * ── D4：唯一允许通过的证据是 `answered` ─────────────────────────────────────────────────────
   *
   * `asked` 不再是成功态。它保留在类型里，是因为**拒绝**要能说出「你问过，但没有答」——
   * 把「问过」与「答过」合并成同一个成功值，正是那道门被绕过的形状。
   */
  | { ok: true; evidence: 'answered'; askedAtSeq: number; answeredAtSeq: number; answerText: string; detail: string }
  /** (a) or (b), ADMITTED only because the operator turned the gate off for this host. */
  | { ok: true; evidence: 'unavailable' | 'unreadable'; askedAtSeq: null; detail: string; warning: string }
  | { ok: false; evidence: 'asked' | 'not-asked' | 'unavailable' | 'unreadable'; askedAtSeq: number | null; detail: string }

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
 * ── D4：问过 ≠ 得到答复 ────────────────────────────────────────────────────────────────────────
 *
 * `findAskEvidence` 只回答「有没有调用过 ask_user_question」。它证明的是**问题被提出了**，
 * 而门禁要的是**用户回答了什么**。两者之间有一个完整的失败面：
 *
 *   · 工具调用抛错 / 被宿主拒绝（`isError`）⇒ 用户根本没看到问题；
 *   · 用户**取消了**（DSH 的 ask 结果会带 cancelled/declined 一类标记）⇒ 没有答案；
 *   · 用户**答了，但答的是另一个选项**（不是「确认」）⇒ 答案存在，但不是同意；
 *   · 结果与调用**对不上**（`callId` 不同，或结果早于调用）⇒ 证据不属于这个问题。
 *
 * 这四例在旧实现里全部被当成 `evidence: 'asked'`、`ok: true` —— 也就是**把「问过」当成「同意过」**。
 *
 * 返回 `answered` 时同时带回 `answerText` 与 `answeredAtSeq`，让上层能说清「用户答了什么」，
 * 而不是只说「有人答过」。
 */
export interface AskAnswer {
  /** The seq of the `tool/call` that asked. */
  readonly askedAtSeq: number
  /** The seq of the `tool/result` that carries the answer. */
  readonly answeredAtSeq: number
  /** The answer as the host recorded it, trimmed. Empty string is a REFUSAL, not an answer. */
  readonly answerText: string
}

/** DSH 把「用户没答」表达成的几种形状（任一出现即视为没有答复）。 */
const NO_ANSWER_FLAGS = ['cancelled', 'canceled', 'declined', 'dismissed', 'timedOut', 'timeout']

const textOfAskResult = (data: any): string => {
  /**
   * ── 真实形状是 block 数组，不是字符串 ──────────────────────────────────────────────────────────
   *
   * 探针实测（`_scratch/probe-d4-answer.mjs`）：DSH 的 `tool/result` 把正文放在
   * `message.content = [{ type: 'text', text: '…' }]`。第一版只认字符串、`{answer}` 对象和字符串数组，
   * 于是**每一种真实形状都被读成空串** —— 而那会被判成「没有答复」，门禁永远拒绝。
   * 一个永远拒绝的门禁不会漏放任何人，但它同样不会放行任何人：那是另一种失效。
   */
  const textOfContent = (content: any): string => {
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'string') return block
          if (block !== null && typeof block === 'object' && typeof block.text === 'string') return block.text
          return ''
        })
        .filter((piece) => piece.trim().length > 0)
        .join(' ')
        .trim()
    }
    return ''
  }

  const candidates = [data?.answers, data?.answer, data?.text, data?.message?.content, data?.content]
  for (const candidate of candidates) {
    const fromContent = textOfContent(candidate)
    if (fromContent.length > 0) return fromContent
    /** `answers` may be an object keyed by question. */
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const joined = Object.values(candidate)
        .map((value: any) => textOfContent(value) || (typeof value?.answer === 'string' ? value.answer.trim() : ''))
        .filter((item) => item.length > 0)
        .join(' ')
      if (joined.trim().length > 0) return joined.trim()
    }
  }
  return ''
}

/**
 * Find the ANSWER to the last `ask_user_question` call.
 *
 * `null` means: no call, or the call has no usable answer. The two are different observations and the
 * caller reports them with different words — but both refuse, because 「问过没答」 is not 「同意」.
 */
export function findAskAnswer(events: readonly any[]): AskAnswer | null {
  /** The callId of the LAST ask call. Correlating by callId is what makes the answer ITS answer. */
  let askCallId = ''
  let askedAtSeq = -1
  const callIdsBySeq = new Map<number, string>()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    if (event.data?.name !== ASK_TOOL_NAME) continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq)) continue
    const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
    callIdsBySeq.set(seq, callId)
    if (seq >= askedAtSeq) {
      askedAtSeq = seq
      askCallId = callId
    }
  }
  if (askedAtSeq < 0) return null

  /**
   * The result: matched by `callId` when both sides carry one. When the host does not publish callIds
   * the only available correlation is position — result AFTER the call — and that is used as a
   * fallback **only then**, because positional matching is exactly what breaks when two asks run
   * concurrently.
   */
  let best: { seq: number; answerText: string } | null = null
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq) || seq <= askedAtSeq) continue
    const data = event.data ?? {}
    const message = data.message ?? {}
    const resultCallId = String(data.callId ?? message.toolCallId ?? message.source?.callId ?? '')
    if (askCallId.length > 0 && resultCallId.length > 0 && resultCallId !== askCallId) continue

    /** A refused / cancelled call is NOT an answer, whatever text rides along. */
    if (data.isError === true || message.isError === true) return null
    if (NO_ANSWER_FLAGS.some((flag) => data[flag] === true || message[flag] === true || data?.status === flag)) return null

    const answerText = textOfAskResult({ ...data, message })
    if (answerText.length === 0) return null
    if (best === null || seq < best.seq) best = { seq, answerText }
  }
  if (best === null) return null
  return { askedAtSeq, answeredAtSeq: best.seq, answerText: best.answerText }
}

/**
 * Decide whether the incubation may proceed.
 *
 * @param options.claimed   what the caller asserted (`userConfirmed: true`)
 * @param options.readLog   reads the CALLING session's log; undefined when unavailable
 * @param options.sessionId the calling session, for the evidence lookup
 *
 * ── v2.1.0: `skipConfirmation` WAS REMOVED, AND THAT IS THE POINT ────────────────────────────
 *
 * It used to accept a boolean that returned `ok: true` outright, bypassing every other check. The
 * claim it encoded was "the user said to skip confirmation" — a statement the MODEL makes about a
 * conversation the model is also producing. There is no fact to verify, no log to read, no approval
 * to compare against: it was a self-signed permission slip.
 *
 * That is precisely the bypass this module exists to close. A tool whose job is "prove the user was
 * asked" cannot also accept "trust me, they said not to ask".
 *
 * The parameter is gone from the tool SCHEMA too, not merely ignored here: the schema declares
 * `additionalProperties: false`, so a model that passes it now gets a schema rejection instead of a
 * silent grant.
 */
export async function checkConfirmation(options: {
  claimed: boolean
  readLog?: (sessionId: string) => Promise<any>
  sessionId: string
  /**
   * B4-B B6: the OPERATOR's escape hatch, and it defaults to OFF.
   *
   * Who the id belongs to cannot always be established (`exec.agent.id` is missing on some hosts),
   * and a host with no log service cannot verify anything. Refusing both forever would brick those
   * hosts. So the permissive answer stays reachable — through CONFIG, which the person running the
   * plugin controls, never through a tool argument, which the model controls.
   */
  allowUnverified?: boolean
}): Promise<ConfirmationVerdict> {
  const { claimed, readLog, sessionId } = options
  const allowUnverified = options.allowUnverified === true

  // 1. The explicit assertion. Without it, nothing else matters — do not even read the log.
  if (claimed !== true) {
    return {
      ok: false,
      evidence: 'not-asked',
      askedAtSeq: null,
      detail: '调用方没有声明 userConfirmed: true',
    }
  }

  /**
   * 2. (a) THE HOST HAS NO READER.
   *
   * Refusing this by default is a real cost: a host that simply cannot expose `sessionQuery` loses
   * incubation until its operator says otherwise. That is the trade B6 makes on purpose — the
   * alternative was to keep treating "cannot check" as "checked and fine", which is how the gate
   * came to be borrowable. `allowUnverified` is where that cost is paid, by the person who can
   * actually judge it.
   */
  if (typeof readLog !== 'function') {
    const detail = '本宿主无法读取会话日志，无法核实是否调用过 ask_user_question'
    if (allowUnverified) {
      return {
        ok: true,
        evidence: 'unavailable',
        askedAtSeq: null,
        detail,
        warning: '未能核实确认证据（sessionQuery 不可用），按宿主配置 allowUnverified 放行；请确保用户确实已确认',
      }
    }
    return { ok: false, evidence: 'unavailable', askedAtSeq: null, detail }
  }

  /**
   * 3. (b) THE READ ITSELF FAILED.
   *
   * THIS is the borrowable shape, and it is a refusal for a reason that has nothing to do with
   * politeness: an unreadable id and a foreign id are the same observation. A gate that admits the
   * first cannot exclude the second, so it does not gate anything.
   */
  let snapshot: any
  try {
    snapshot = await readLog(sessionId)
  } catch (error) {
    const detail = `读取会话日志失败：${String((error as any)?.message ?? error)}`
    if (allowUnverified) {
      return {
        ok: true,
        evidence: 'unreadable',
        askedAtSeq: null,
        detail,
        warning: '未能核实确认证据（日志读取失败），按宿主配置 allowUnverified 放行；请确保用户确实已确认',
      }
    }
    return { ok: false, evidence: 'unreadable', askedAtSeq: null, detail }
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
  /**
   * ── D4：问过之后，必须还有答复 ────────────────────────────────────────────────────────────────
   *
   * 这一跳是这次修复的全部。旧实现在这里直接 `return { ok: true, evidence: 'asked' }` ——
   * 于是「调用过 ask 但工具抛错」「用户取消」「用户选了别的选项」「结果与调用对不上」四种情形
   * 全部通过。**问过不是同意过。**
   */
  const answer = findAskAnswer(events)
  if (answer === null) {
    return {
      ok: false,
      evidence: 'asked',
      askedAtSeq,
      detail:
        `本会话在 seq=${askedAtSeq} 调用过 ${ASK_TOOL_NAME}，但**没有找到可用的答复**：` +
        '工具报错 / 用户取消 / 结果与调用对不上 / 答复为空 —— 这几种都不会让门禁通过。' +
        '请重新提出确认，并等待用户真正作出选择。',
    }
  }
  return {
    ok: true,
    evidence: 'answered',
    askedAtSeq: answer.askedAtSeq,
    answeredAtSeq: answer.answeredAtSeq,
    answerText: answer.answerText,
    detail:
      `已核实：seq=${answer.askedAtSeq} 提问，seq=${answer.answeredAtSeq} 得到答复「${answer.answerText}」`,
  }
}

/**
 * B4-B B6 — IS THIS ID THE CALLER'S OWN SESSION?
 *
 * The gate's evidence is read from the log of whatever session the caller NAMES. `ask_user_question`
 * proves 「that session's user was asked about that session's plan」 — which is only the same fact as
 * 「THIS plan was approved」 when the two ids are the same.
 *
 * `exec.agent.id` is the only identity this layer is handed, so it decides when it is present. When
 * it is absent the question is unanswerable; `caller` describes that honestly rather than guessing,
 * and the caller of this function decides what an unanswerable question is worth (see the tool
 * handler — it refuses by default).
 *
 * WHY NOT COMPARE AGAINST THE PAIR TABLE: a first incubation has no pair yet, so "no binding" would
 * be read as "not yours" and every legitimate first hatch would be refused. Identity, not bookkeeping.
 */
export function checkOwnership(options: {
  claimedId: string
  callerId: string
}):
  | { ok: true; attributed: true; reason: ''; detail: string }
  | { ok: true; attributed: false; reason: ''; detail: string }
  | { ok: false; attributed: false; reason: 'foreign'; detail: string } {
  const claimedId = typeof options.claimedId === 'string' ? options.claimedId.trim() : ''
  const callerId = typeof options.callerId === 'string' ? options.callerId.trim() : ''
  /**
   * ── TWO ADMITTED OUTCOMES, AND WHY THEY ARE NOT THE SAME ─────────────────────────────────────
   *
   * `attributed: true` — the host named the caller and it MATCHES. The evidence belongs to the
   * session that is hatching, so the gate's conclusion stands on its own.
   *
   * `attributed: false` — the host named NOBODY (`exec.agent.id` absent). Ownership is UNANSWERABLE
   * here, not "probably fine". It is admitted as a NAMED STATE: the receipt carries
   * `ownership: 'unattributed'` and the success text says so, so a reader is never told
   * 「已核实归属」 when nothing was checked. Refusing instead would brick incubation on every host
   * that does not populate the field — trading one silent lie for one silent outage, and the
   * dispatch forbids both.
   *
   * `ok: false` — the host named the caller and it DISAGREES. That is the only case where a FACT
   * contradicts the claim, so it is the only case that refuses. The old behaviour had no such case
   * at all: any id could be named.
   */
  if (callerId.length === 0) {
    return {
      ok: true,
      attributed: false,
      reason: '',
      detail:
        '本宿主没有把调用方身份交给工具（exec.agent.id 缺失），无法确认这个会话 id 属于调用方；' +
        '已按未核实归属放行，并在回执里点名。',
    }
  }
  if (claimedId.length === 0) {
    return { ok: false, attributed: false, reason: 'foreign', detail: '没有可核对的会话 id' }
  }
  if (claimedId !== callerId) {
    return {
      ok: false,
      attributed: false,
      reason: 'foreign',
      detail:
        `调用方是 ${callerId}，但要求的发起会话是 ${claimedId}。` +
        '确认证据只能来自发起孵化那个会话自己的日志 —— 别人的会话里问过的问题，不是本项目方案被批准过。',
    }
  }
  return { ok: true, attributed: true, reason: '', detail: `该会话 id 就是调用方（${callerId}）` }
}

/**
 * The refusal body for a failed confirmation check.
 *
 * Kept next to the check so the two cannot drift: the text names the exact missing fact the code
 * looked for, which is what makes the refusal actionable rather than a wall.
 */
export function confirmationRefusal(verdict: ConfirmationVerdict): string {
  if (verdict.ok) return ''
  /**
   * B4-B B6 — THE ADVICE HAS TO MATCH THE MISSING FACT.
   *
   * 「没有 ask_user_question 记录」 and 「日志读不到」 are different situations and a caller that gets
   * the wrong advice retries forever: told to "go and ask the user", a session whose log is merely
   * unreadable will ask again, get the same unreadable result, and loop. So `unavailable` / `unreadable`
   * get their own paragraph that says what is actually wrong — ours, or the id's.
   */
  if (verdict.evidence === 'unavailable' || verdict.evidence === 'unreadable') {
    const why =
      verdict.evidence === 'unavailable'
        ? '这个宿主没有可用的会话日志读取能力（sessionQuery 不可用）。'
        : '这个会话的日志读不到 —— 注意：点名一个读不到的会话，和点名别人的会话，在本层是同一个观测。'
    return [
      '拒绝孵化：用户确认环节无法核实。',
      '',
      `核实结果：${verdict.detail}`,
      '',
      why,
      '',
      '这不再是「放行并告警」：不核实就孵化一个**自动开跑**的主脑，等于把「用户看过这份方案」当成推定事实。',
      '',
      '现在应当：',
      '',
      `1. 确认你用的是**自己这个会话**的 id（\`observerSessionId\` 默认就是当前会话，不要指向别的会话）；`,
      '2. 如果只是想在本会话里孵化，去掉 `observerSessionId` 参数即可；',
      '3. 如果确实是宿主的日志能力缺失，这是运维决定：由插件配置 `allowUnverifiedConfirmation: true` 放行，',
      '   **不要**为了通过检查而试图把这个开关当参数传 —— 它不是工具参数，传了会被 schema 拒绝。',
    ].join('\n')
  }
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
