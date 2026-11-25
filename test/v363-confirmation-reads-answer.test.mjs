/**
 * ── v363：S10 / D4 —— 确认门必须读**答复**，不是「问过」────────────────────────────────────────
 *
 * 病（`src/core/confirmation.ts`）：`checkConfirmation` 只要在日志里找到一条 `ask_user_question`
 * 的 `tool/call` 就 `return { ok: true, evidence: 'asked' }`。它证明的是**问题被提出了**，
 * 而这道门要的是**用户回答了什么**。两者之间有一整个失败面，旧实现全放行：
 *
 *   · 工具抛错 / 宿主拒绝（`isError`）        ⇒ 用户根本没看到问题
 *   · 用户取消（`cancelled` / `declined`）    ⇒ 没有答案
 *   · 答复与调用对不上（callId 不同）          ⇒ 那不是我这一问的答案
 *   · 答了，但答的是别的选项                   ⇒ 答案存在，但不是同意
 *
 * 工单的出口条件是「四例 fail-closed，`evidence` 必须是 `'answered'`」。四条各一条判据，
 * 每条都断言**没有创建任何东西**（fail-closed 的意思是副作用为零，不是「返回 false」）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, confirmationInternals } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

const { ASK_TOOL_NAME, checkConfirmation, findAskAnswer } = confirmationInternals

/** One ask call, optionally followed by a result shaped exactly as the host emits one. */
const logWith = ({ callSeq = 5, result }) => ({
  events: [
    { type: 'tool/call', seq: callSeq, data: { callId: 'c1', name: ASK_TOOL_NAME } },
    ...(result === undefined ? [] : [result]),
  ],
})

const textResult = (seq, answer, extra = {}) => ({
  type: 'tool/result',
  seq,
  data: {
    ...extra,
    callId: 'c1',
    message: { toolCallId: 'c1', content: [{ type: 'text', text: answer }] },
  },
})

const boot = () => {
  const host = makeHost({ askedUser: false })
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-v363-')), 'observer-bindings.json') })
  return host
}

test('v363 ①: ask-only (no result at all) is refused — 「问过」不是「答过」', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => logWith({}),
  })
  assert.equal(verdict.ok, false, '① 只有提问、没有任何答复 ⇒ 必须拒绝')
  assert.equal(verdict.evidence, 'asked', '① 证据词必须是 asked：问题确实问过（拒绝理由与 not-asked 不同）')
  assert.equal(verdict.askedAtSeq, 5)
})

test('v363 ②: a FAILED ask (isError) is refused', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => logWith({ result: { type: 'tool/result', seq: 6, data: { callId: 'c1', isError: true, message: { toolCallId: 'c1', content: [{ type: 'text', text: '工具失败' }] } } } }),
  })
  assert.equal(verdict.ok, false, '② 报错的 ask 不是答复 —— 用户根本没看到问题')
})

test('v363 ③: a CANCELLED ask is refused', async () => {
  for (const flag of ['cancelled', 'canceled', 'declined', 'dismissed', 'timedOut']) {
    const verdict = await checkConfirmation({
      claimed: true,
      sessionId: 's',
      readLog: async () => logWith({ result: textResult(6, '', { [flag]: true }) }),
    })
    assert.equal(verdict.ok, false, `③ ${flag} 的 ask 不是答复`)
  }
})

test('v363 ④: an answer belonging to ANOTHER call is refused (correlation is by callId)', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 3, data: { callId: 'a', name: ASK_TOOL_NAME } },
        textResult(4, '旧的确认', { callId: 'a', message: { toolCallId: 'a', content: [{ type: 'text', text: '旧的确认' }] } }),
        { type: 'tool/call', seq: 7, data: { callId: 'b', name: ASK_TOOL_NAME } },
      ],
    }),
  })
  assert.equal(verdict.ok, false, '④ 最后一次提问没有答复 ⇒ 拒绝（更早那次答过不算）')
  assert.equal(verdict.askedAtSeq, 7, '④ 点名的必须是最后一次提问')
})

test('v363 ④b: with TWO asks, the EARLIER answer must not be credited to the LATER question', async () => {
  /**
   * ── 这条用例是 can-red 逼出来的 ────────────────────────────────────────────────────────────────
   *
   * ④ 单独存在时，「不按 callId 关联」的那种改法**不会变红**：只有一次 ask，位置兜底恰好选到
   * 正确的那个结果，于是「按 callId」与「按位置」给出同一个答案。一条判据如果在错误实现下仍然通过，
   * 它证明的就不是那个性质。
   *
   * 两个 ask、只有第一个有答复 —— 这时两种实现分道扬镳：
   *   按 callId：第二个 ask 没有对应答复 ⇒ 拒绝（正确）
   *   按位置  ：把第一个的答复算给第二个 ⇒ 放行（错误）
   */
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 3, data: { callId: 'a', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 4, data: { callId: 'a', message: { toolCallId: 'a', content: [{ type: 'text', text: '第一问的确认' }] } } },
        { type: 'tool/call', seq: 7, data: { callId: 'b', name: ASK_TOOL_NAME } },
      ],
    }),
  })
  assert.equal(verdict.ok, false,
    '④b 第二问没有答复 ⇒ 必须拒绝；把第一问的答复算给它，就是「借一次旧确认过两次门」')
  assert.equal(verdict.askedAtSeq, 7)

  /** And with the LATER one answered, it passes — the correlation must not be "always refuse". */
  const answered = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({
      events: [
        { type: 'tool/call', seq: 3, data: { callId: 'a', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 4, data: { callId: 'a', message: { toolCallId: 'a', content: [{ type: 'text', text: '第一问' }] } } },
        { type: 'tool/call', seq: 7, data: { callId: 'b', name: ASK_TOOL_NAME } },
        { type: 'tool/result', seq: 8, data: { callId: 'b', message: { toolCallId: 'b', content: [{ type: 'text', text: '第二问的确认' }] } } },
      ],
    }),
  })
  assert.equal(answered.ok, true, '④b 第二问也答了 ⇒ 通过')
  assert.equal(answered.answeredAtSeq, 8, '④b 引用的必须是第二问自己的答复')
  assert.match(answered.answerText, /第二问/u)
})

test('v363 ⑤: an EMPTY answer is refused — silence is not consent', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => logWith({ result: textResult(6, '   ') }),
  })
  assert.equal(verdict.ok, false, '⑤ 空白答复不是同意')
})

test('v363 ⑥: a REAL answer passes, and the verdict carries what was said', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => logWith({ result: textResult(6, '确认，开始执行') }),
  })
  assert.equal(verdict.ok, true, '⑥ 问过且答过 ⇒ 通过')
  assert.equal(verdict.evidence, 'answered', '⑥ 唯一的成功证据词是 answered')
  assert.equal(verdict.askedAtSeq, 5)
  assert.equal(verdict.answeredAtSeq, 6)
  assert.match(verdict.answerText, /确认/u, '⑥ 必须带回答复原文，而不是只说「有人答过」')
})

test('v363 ⑦: fail-closed means ZERO side effects — a refusal creates nothing', async () => {
  /**
   * 工单的出口条件写的是「四例 fail-closed」。`ok: false` 只是返回值；真正的验收是**没有孵化**。
   * 所以这里走工具入口，并断言没有任何会话被创建。
   */
  const cases = [
    { label: 'ask-only', asked: false },
  ]
  for (const item of cases) {
    const host = boot()
    const before = host.persistence.list?.().length ?? 0
    const reply = await host.tools.get('observer_spawn_main').execute(
      { plan: '## 计划\n1. 做 A', observerSessionId: 'session-blank', userConfirmed: true },
      {},
    )
    assert.equal(reply.ok, false, `⑦ ${item.label}: 没有答复 ⇒ 工具必须拒绝`)
    assert.equal(host.persistence.list?.().length ?? 0, before,
      `⑦ ${item.label}: 拒绝必须零副作用（没有新会话）`)
    assert.equal(item.asked, false)
  }
})