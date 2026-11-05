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

test('gate: asserted AND asked is allowed, and the evidence is cited', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => ({ events: [{ type: 'tool/call', seq: 5, data: { name: ASK_TOOL_NAME } }] }),
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.evidence, 'asked')
  assert.equal(verdict.askedAtSeq, 5)
})

test('gate: an unreadable log is UNVERIFIABLE — allowed, but reported', async () => {
  const verdict = await checkConfirmation({
    claimed: true,
    sessionId: 's',
    readLog: async () => { throw new Error('sessionQuery unavailable') },
  })
  assert.equal(verdict.ok, true, 'a capability of OURS must not cost the user their session')
  assert.equal(verdict.evidence, 'unverifiable')
  assert.match(verdict.warning, /未能核实/u)
})

test('gate: no reader at all is unverifiable too', async () => {
  const verdict = await checkConfirmation({ claimed: true, sessionId: 's', readLog: undefined })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.evidence, 'unverifiable')
})

test('gate: the user-authorised skip is allowed and flagged', async () => {
  const verdict = await checkConfirmation({ claimed: false, skipped: true, sessionId: 's' })
  assert.equal(verdict.ok, true)
  assert.match(verdict.warning, /用户显式要求跳过/u)
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

test('tool: asserted AND asked goes through, and the receipt cites the evidence', async () => {
  const harness = boot({ askedUser: true })
  const reply = await spawn(harness, { userConfirmed: true })

  assert.equal(reply.ok, true, reply.text)
  assert.equal(reply.confirmation.evidence, 'asked')
  assert.match(reply.text, /需求对齐：已核实/u)
  assert.equal(tapeOf(harness.persistence, reply.sessionId).length, 8)
})

test('tool: the user-authorised skip works and is reported as such', async () => {
  const harness = boot({ askedUser: false })
  const reply = await spawn(harness, { skipConfirmation: true })

  assert.equal(reply.ok, true, reply.text)
  assert.equal(reply.confirmation.evidence, 'unverifiable')
  assert.match(reply.text, /未核实/u)
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
  const verdict = await checkConfirmation({ claimed: true, sessionId: 's', skip: true, skipped: true })
  assert.equal(confirmationRefusal(verdict), '')
})
