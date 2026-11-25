/**
 * dsh-observer v1.6.0 — THE CONFIRMATION GATE (`src/core/confirmation.ts`).
 *
 * Two acceptance runs failed in opposite directions, and BOTH times the only defence was a sentence:
 *
 *   v1.3.x — "call it only when the work is too large" → the session outvoted its user and did the
 *            work itself.
 *   v1.4.0 — "a repeated instruction means call it NOW" → the session invented a plan, hatched a
 *            main, ignited it, and started building. The user never saw the plan.
 *
 * The second is the worse one: an unapproved plan that RUNS is an unapproved plan at scale. So the
 * gate is code:
 *
 *   1. `observer_spawn_main` refuses without `userConfirmed: true` (or `skipConfirmation: true`);
 *   2. the calling session's log must show an `ask_user_question` call — a session that never asked
 *      cannot produce the evidence;
 *   3. when the log cannot be read, the outcome is UNVERIFIABLE, not "approved" — reported as a
 *      warning, and it does NOT brick the incubation (a missing capability of ours must not cost the
 *      user a session).
 *
 * These cases pin all three, including what must NOT be created when the gate refuses.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, confirmationInternals } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

const { ASK_TOOL_NAME, checkConfirmation, confirmationRefusal, findAskEvidence } = confirmationInternals

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

const spawn = (harness, extra = {}) =>
  harness.tools.get('observer_spawn_main').execute(
    { plan: '## 计划\n1. 做 A', observerSessionId: 'session-blank', ...extra },
    {},
  )

/* ── findAskEvidence ─────────────────────────────────────────────────────── */

test('evidence: it finds an ask_user_question tool call and reports its last seq', () => {
  const events = [
    { type: 'tool/call', seq: 3, data: { name: 'read' } },
    { type: 'tool/call', seq: 7, data: { name: ASK_TOOL_NAME } },
    { type: 'tool/call', seq: 9, data: { name: ASK_TOOL_NAME } },
  ]
  assert.equal(findAskEvidence(events), 9, 'the LAST ask is the one under discussion')
})

test('evidence: no ask call means null, and unrelated tools do not count', () => {
  assert.equal(findAskEvidence([]), null)
  assert.equal(findAskEvidence([{ type: 'tool/call', seq: 1, data: { name: 'grep' } }]), null)
  assert.equal(findAskEvidence([{ type: 'tool/result', seq: 1, data: { name: ASK_TOOL_NAME } }]), null, 'a result is not a call')
})

/* ── checkConfirmation, in isolation ─────────────────────────────────────── */

test('gate: no assertion at all is refused, without even reading the log', async () => {
  let read = 0
  const verdict = await checkConfirmation({
    claimed: false,
    sessionId: 's',
    readLog: async () => { read += 1; return { events: [] } },
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.evidence, 'not-asked')
  assert.match(verdict.detail, /没有声明 userConfirmed/u)
  assert.equal(read, 0, 'the log is not worth reading when the caller says nothing')
})

test('gate: asserted but never asked is REFUSED — this is the incident', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({ events: [{ type: 'tool/call', seq: 1, data: { name: 'read' } }] }),
  })
  assert.equal(verdict.ok, false, 'a claim without evidence is exactly what the incident looked like')
  assert.equal(verdict.evidence, 'not-asked')
  assert.match(verdict.detail, new RegExp(ASK_TOOL_NAME, 'u'))
})

test('gate: asserted AND ANSWERED is allowed, and the evidence is cited', async () => {
  /**
   * ── S10 / D4：这条用例的判据从 `asked` 改成了 `answered` ────────────────────────────────────────
   *
   * 旧版本只放一条 `tool/call` 就断言 `ok: true, evidence: 'asked'`，等于把「问过」当成「同意过」。
   * 现在必须同时有**答复**（按 callId 关联），并且证据里要能看到「答了什么」。
   *
   * 这不是放宽也不是收紧判据的写法，是**语义本身**改变了：门禁要的是答复，不是提问。
   * 追问 / 没答 / 报错 / 取消 / 换了选项，全部仍然拒绝（见下面新加的两条负向用例）。
   */
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 5, data: { callId: 'c1', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 6, data: { callId: 'c1', message: { toolCallId: 'c1', content: [{ type: 'text', text: '确认，开始执行' }] } } },
      ],
    }),
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.evidence, 'answered')
  assert.equal(verdict.askedAtSeq, 5)
  assert.equal(verdict.answeredAtSeq, 6)
  assert.match(verdict.answerText, /确认/u, '答复原文必须被引用，而不只是「有人答过」')
})

/**
 * ── D4 的负向半：问过但**没有答复**必须拒绝 ──────────────────────────────────────────────────────
 *
 * 这两条是新加的，而且它们的形状就是旧实现放过的那个洞：
 *
 *   ① 只有 `tool/call`（用户没答 / 界面没回）⇒ `ok: false, evidence: 'asked'`
 *   ② 结果带 `isError` 或 `cancelled`（工具失败 / 用户取消）⇒ 同样拒绝
 *
 * 第二条尤其值得单列：一个**报错的** ask 看起来仍然有 `tool/call` 记录，旧实现数到它就算通过。
 */
test('gate: asked WITHOUT an answer is REFUSED — asking is not agreeing', async () => {
  const askedOnly = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({ events: [{ type: 'tool/call', seq: 5, data: { callId: 'c1', name: ASK_TOOL_NAME } }] }),
  })
  assert.equal(askedOnly.ok, false, '问过但没答 ⇒ 必须拒绝')
  assert.equal(askedOnly.evidence, 'asked', '证据词必须是 asked（不是 not-asked）：问题确实问过')
  assert.equal(askedOnly.askedAtSeq, 5, '仍然要点名问在哪一条')
  assert.match(askedOnly.detail, /没有找到可用的答复/u)
})

test('gate: a FAILED or CANCELLED ask result is not an answer', async () => {
  const failed = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 5, data: { callId: 'c1', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 6, data: { callId: 'c1', isError: true, message: { content: [{ type: 'text', text: 'tool failed' }] } } },
      ],
    }),
  })
  assert.equal(failed.ok, false, '工具报错的 ask 不是答复')

  const cancelled = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 5, data: { callId: 'c1', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 6, data: { callId: 'c1', cancelled: true, message: { content: [{ type: 'text', text: '' }] } } },
      ],
    }),
  })
  assert.equal(cancelled.ok, false, '用户取消的 ask 不是答复')
})

test('gate: an answer to a DIFFERENT call is not this question\'s answer', async () => {
  /**
   * 按 callId 关联的意义：两次 ask 并存时，位置匹配会把 A 的答复算给 B。
   * 这里 B 没有答复，只有 A 的 —— 必须拒绝。
   */
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 3, data: { callId: 'a', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 4, data: { callId: 'a', message: { toolCallId: 'a', content: [{ type: 'text', text: '旧的确认' }] } } },
        { type: 'tool/call', seq: 7, data: { callId: 'b', name: ASK_TOOL_NAME } },
      ],
    }),
  })
  assert.equal(verdict.ok, false, '最后一次 ask 没有答复 ⇒ 拒绝，即使更早那次答过')
  assert.equal(verdict.askedAtSeq, 7, '点名的必须是**最后一次**提问')
})

/**
 * B4-B B6 — THE TWO "UNVERIFIABLE" CASES USED TO BE `ok: true`, AND BOTH ARE NOW REFUSED.
 *
 * This is a deliberate behaviour change, so the old case is not deleted — it is SPLIT, so the
 * difference between 「our host cannot read logs」 and 「this id's log could not be read」 stays
 * visible instead of collapsing back into one word:
 *
 *   (a) no reader at all  → `unavailable`, refused by DEFAULT, admitted by `allowUnverified`
 *   (b) the read threw    → `unreadable`,  refused by DEFAULT, admitted by `allowUnverified`
 *
 * WHY (b) HAD TO CHANGE: measured, passing an id whose log throws produced `ok: true`, one created
 * session and one ignition. An unreadable id and a FOREIGN id are the same observation, so a gate
 * that admits the first cannot exclude the second — it was borrowable without a victim, only a typo.
 */
test('gate: no reader at all is UNAVAILABLE — refused by default, admitted only by operator config', async () => {
  const refused = await checkConfirmation({ claimed: true, sessionId: 's', readLog: undefined })
  assert.equal(refused.ok, false, '「cannot check」 must not be reported as 「checked and fine」')
  assert.equal(refused.evidence, 'unavailable')
  assert.match(refused.detail, /无法读取会话日志/u)

  const admitted = await checkConfirmation({ claimed: true, sessionId: 's', readLog: undefined, allowUnverified: true })
  assert.equal(admitted.ok, true, 'the operator can restore the old permissiveness — see allowUnverified')
  assert.equal(admitted.evidence, 'unavailable')
  assert.match(admitted.warning, /allowUnverified/u)
})

test('gate: an unreadable log is UNREADABLE — and it is NOT the same fact as (a)', async () => {
  const readLog = async () => {
    throw new Error('sessionQuery unavailable')
  }
  const refused = await checkConfirmation({ claimed: true, sessionId: 's', readLog })
  assert.equal(refused.ok, false, 'a failed read is the borrowable shape — it must not pass')
  assert.equal(refused.evidence, 'unreadable')

  const admitted = await checkConfirmation({ claimed: true, sessionId: 's', readLog, allowUnverified: true })
  assert.equal(admitted.ok, true)
  assert.equal(admitted.evidence, 'unreadable', 'still reported as its own word, not folded into (a)')
  assert.match(admitted.warning, /allowUnverified/u)
})

/**
 * v2.1.0: THE "USER-AUTHORISED SKIP" IS GONE, AND THIS TEST PINS ITS ABSENCE.
 *
 * The old case asserted that `skipped: true` produced `ok: true` with a warning. It could not be
 * otherwise: the parameter was a claim ONLY the model could make, about a conversation only the
 * model was producing, with no artifact to check. A tool whose purpose is "prove the user was asked"
 * cannot also accept "trust me, they said not to ask" — that is the bypass, not an escape from it.
 *
 * The parameter is removed from the signature AND the schema, so this test asserts the refusal that
 * now happens instead. If someone reintroduces the hatch, this fails.
 */
test('gate: there is no way to skip the confirmation — the claim alone is refused', async () => {
  const verdict = await checkConfirmation({ claimed: false, sessionId: 's' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.evidence, 'not-asked')
  assert.match(verdict.detail, /userConfirmed/u)
})

/* ── through the tool: refusals must leave nothing behind ────────────────── */

test('tool: without userConfirmed the incubation is refused and creates NOTHING', async () => {
  const harness = boot()
  const reply = await spawn(harness, {})

  assert.equal(reply.ok, false)
  assert.match(reply.text, /拒绝孵化/u)
  assert.match(reply.text, /userConfirmed/u)
  assert.equal(harness.persistence.createCalls.length, 0, 'no session was reserved')
  assert.equal(harness.sessions.prepareCalls.length, 0, 'and nothing was even prepared')
  assert.equal(harness.prompts.length, 0, 'nothing was ignited')
})

test('tool: asserted but never asked is refused, and says which fact was missing', async () => {
  const harness = boot({ askedUser: false })
  const reply = await spawn(harness, { userConfirmed: true })

  assert.equal(reply.ok, false)
  assert.match(reply.text, /没有 ask_user_question 的调用记录/u, 'it names the missing evidence')
  assert.equal(harness.persistence.createCalls.length, 0)
})

test('tool: asserted AND ANSWERED goes through, and the receipt cites the answer', async () => {
  const harness = boot({ askedUser: true })
  const reply = await spawn(harness, { userConfirmed: true })

  assert.equal(reply.ok, true, reply.text)
  assert.equal(reply.confirmation.evidence, 'answered',
    'S10/D4：成功态是 answered（问过**且**得到答复），不再是 asked')
  /**
   * ⚠️ 这一条跑在**没有 `exec.agent.id`** 的主机上，所以回执只能说「证据存在 … 但归属未核实」。
   *
   * 我第一版写的是 `/需求对齐：已核实/`，实测拿到的是「证据存在 … 归属未核实」——
   * 那正是 B4-B B6 想要的行为（证据与归属是两个独立事实），错的是我的期望。
   * 「已核实」只属于 `attributed` 那条用例（下面自有它自己的断言）。
   */
  assert.match(reply.text, /需求对齐：证据存在/u)
  assert.match(reply.text, /得到答复/u, '回执必须引用答复，而不只是「存在证据」')
  assert.match(reply.text, /seq=1 得到答复/u, '而且必须点名答复在哪一条')
  assert.equal(tapeOf(harness.persistence, reply.sessionId).length, 8)
})

/**
 * B4-B B6 — the ownership label, on the paths that can and cannot prove it.
 *
 * The tool's identity witness is `exec.agent.id`. `spawn()` above passes `{}`, so the host "named
 * nobody" — the case that must stay runnable but must stop reading as verified.
 */
test('tool: an id the host cannot attribute is reported UNATTRIBUTED, not quietly verified', async () => {
  const harness = boot({ askedUser: true })
  const reply = await spawn(harness, { userConfirmed: true })

  assert.equal(reply.ok, true, 'an unattributable host must not lose the feature outright')
  assert.equal(reply.confirmation.ownership, 'unattributed', 'the receipt says what was NOT proven')
  assert.match(reply.text, /归属核验：未核实/u)
  assert.match(reply.text, /归属未核实/u, 'and the evidence line refuses to say 已核实 on its own')
})

test('tool: a MATCHING exec.agent.id is attributed, and the receipt says so', async () => {
  const harness = boot({ askedUser: true })
  const reply = await harness.tools.get('observer_spawn_main').execute(
    { plan: '## 计划\n1. 做 A', observerSessionId: 'session-blank', userConfirmed: true },
    { agent: { id: 'session-blank' } },
  )

  assert.equal(reply.ok, true, reply.text)
  assert.equal(reply.confirmation.ownership, 'attributed')
  assert.match(reply.text, /归属核验：已核实/u)
  assert.match(reply.text, /需求对齐：已核实/u)
})

/**
 * THE INCIDENT THIS FIXES, END TO END: the caller names a DIFFERENT session and borrows its evidence.
 *
 * `session-blank` is the one the harness stamps with an `ask_user_question` call. A caller whose own
 * id is `session-other` must not be able to reach it — and must create nothing by trying.
 */
test('tool: naming another session is REFUSED, and creates nothing', async () => {
  const harness = boot({ askedUser: true })
  // The victim must have a resolvable cwd, otherwise the test would pass on CWD_REQUIRED instead.
  harness.sessions.live.set('session-victim', { id: 'session-victim', header: { cwd: '/tmp/victim' } })

  const reply = await harness.tools.get('observer_spawn_main').execute(
    { plan: '## 计划\n1. 做 A', observerSessionId: 'session-victim', userConfirmed: true },
    { agent: { id: 'session-other' } },
  )

  assert.equal(reply.ok, false, 'a foreign id must not borrow another session\'s confirmation')
  assert.match(reply.text, /这个会话 id 不属于调用方/u)
  assert.match(reply.text, /session-victim/u, 'the refusal names the id that did not belong')
  assert.match(reply.text, /session-other/u, 'and the caller it belonged to instead')
  assert.equal(harness.persistence.createCalls.length, 0, 'nothing was created')
  assert.equal(harness.prompts.length, 0, 'nothing was ignited')
})

/**
 * v2.1.0: passing `skipConfirmation` now creates NOTHING.
 *
 * The old case asserted the skip worked. Now the handler ignores the key and the gate refuses —
 * which is the behaviour an operator needs: an attempt to bypass must leave no session, no prepared
 * id, no ignition behind. A refusal that still reserved a session would be a bypass with extra steps.
 */
test('tool: a stray skipConfirmation creates nothing and is refused', async () => {
  const harness = boot({ askedUser: false })
  const reply = await spawn(harness, { skipConfirmation: true })

  assert.equal(reply.ok, false, 'the removed hatch must not grant anything')
  assert.match(reply.text, /拒绝孵化/u)
  assert.equal(harness.persistence.createCalls.length, 0, 'nothing was reserved')
  assert.equal(harness.sessions.prepareCalls.length, 0, 'nothing was prepared')
  assert.equal(harness.prompts.length, 0, 'nothing was ignited')
})

test('tool: `userConfirmed: false` is not an assertion', async () => {
  const harness = boot()
  const reply = await spawn(harness, { userConfirmed: false })
  assert.equal(reply.ok, false)
  assert.equal(harness.persistence.createCalls.length, 0)
})

/* ── the refusal text sends the model back to stage 2 ───────────────────── */

test('refusal: it instructs the model to go and ASK, and forbids forging the flag', async () => {
  const verdict = await checkConfirmation({ claimed: false, sessionId: 's' })
  const text = confirmationRefusal(verdict)

  assert.match(text, /拒绝孵化/u)
  assert.match(text, new RegExp(ASK_TOOL_NAME, 'u'), 'it names the tool to call')
  assert.match(text, /不要.*伪造 `userConfirmed`/u, 'and it forbids flipping the flag to pass the check')
})

test('refusal: an allowed verdict produces no text', async () => {
  /** v2.1.0: `skip`/`skipped` are gone; S10/D4: the allowed verdict is `answered`, not `asked`. */
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 1, data: { callId: 'c1', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 2, data: { callId: 'c1', message: { toolCallId: 'c1', content: [{ type: 'text', text: '确认' }] } } },
      ],
    }),
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.evidence, 'answered')
  assert.equal(confirmationRefusal(verdict), '')
})

/**
 * B4-B B6 — THE ADVICE MUST MATCH THE MISSING FACT.
 *
 * A refusal that says 「go and ask the user」 to a session whose LOG was merely unreadable sends it
 * round the loop: ask again, hit the same unreadable read, be refused again. So the two evidence
 * words get their own paragraph, which names the actual problem and the real escape hatch (config,
 * never an argument).
 */
test('refusal: unreadable / unavailable get their own advice, not 「go ask the user」', async () => {
  const unreadable = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => {
      throw new Error('boom')
    },
  })
  const text = confirmationRefusal(unreadable)
  assert.match(text, /用户确认环节无法核实/u)
  assert.match(text, /读不到/u)
  assert.match(text, /allowUnverifiedConfirmation/u, 'the real escape hatch is named')
  assert.doesNotMatch(text, /调用 `ask_user_question` 请用户确认/u, 'asking again would loop forever')

  const unavailable = await checkConfirmation({ claimed: true, sessionId: 's', readLog: undefined })
  assert.match(confirmationRefusal(unavailable), /没有可用的会话日志读取能力/u)
})
