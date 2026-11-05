/**
 * dsh-observer v1.3.0 — MEMORY SCHEDULING AT INCUBATION.
 *
 * An incubated main should not start from zero experience. Before the plan is handed over, the
 * observer asks `dsh-memory` (through the ordinary `tools.execute` registry — no private API) what
 * it already knows about this kind of work, and packs the answer into the same developer message.
 *
 * These cases pin the three properties that matter:
 *   * the arsenal is APPENDED to the plan, never a replacement for it;
 *   * a profile WITHOUT dsh-memory still incubates (absence is not failure);
 *   * a memory call that throws never costs the user their main session.
 *
 * v1.3.0: the message is now read out of the COLD TAPE (`persistence.create` + append) instead of
 * a live `sessions.get(id).append`, because the live path could not accept a step-scoped message.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

/** The brief message of a tape, whether it is payload-at-root (user) or wrapped (developer). */
const payloadOf = (event) => event.data.message ?? event.data

function boot(memory, options = {}) {
  const host = makeHost({ memory, ...options })
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

const spawnMain = (harness, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId: 'session-blank', userConfirmed: true }, {})

/** The briefing message of the one cold tape this call wrote. */
function briefingOf(harness) {
  const created = harness.persistence.createCalls
  assert.equal(created.length, 1, 'exactly one incubated main')
  const events = tapeOf(harness.persistence, created[0].header.id)
  const messages = events.filter((event) => event.type === 'user/message' || event.type === 'developer/message')
  assert.equal(messages.length, 1, 'exactly one briefing message in the tape')
  return payloadOf(messages[0])
}

/** The briefing's TEXT. */
function briefingTextOf(harness) {
  return briefingOf(harness).content[0].text
}

test('memory: the arsenal is appended to the plan in ONE developer message', async () => {
  const harness = boot({ hint: '### skill: 冷 tape 物化\n- 先物化再写入\n- 坑：不能在 SessionStore 外 append' })
  const reply = await spawnMain(harness, '## 计划\n1. 切片\n2. 验证')

  assert.equal(reply.ok, true, reply.text)
  const text = briefingTextOf(harness)
  assert.match(text, /## 计划/u, 'the plan is present and first')
  assert.match(text, /冷 tape 物化/u, 'the skill text is present')
  assert.match(text, /\[记忆调度\]/u, 'and it is labelled so the model knows where it came from')
  assert.match(text, /以实际代码为准/u, 'with the caveat that stale advice loses to the code')

  const planAt = text.indexOf('## 计划')
  const arsenalAt = text.indexOf('冷 tape 物化')
  assert.ok(planAt < arsenalAt, 'the plan comes before the arsenal')
})

test('memory: the query comes from the plan, and the workspace from the caller', async () => {
  const harness = boot({ hint: 'some skill' })
  await spawnMain(harness, '重构 token 水位与压缩阈值')

  assert.equal(harness.memoryCalls.length, 1, 'one lookup per incubation')
  const request = harness.memoryCalls[0]
  assert.equal(request.name, 'memory_search', 'through the ordinary tool registry')
  assert.match(request.arguments.query, /token 水位/u, 'the plan is the query')
  assert.equal(request.arguments.semantic, false, 'lexical mode: no LLM round trip inside a create')
  assert.equal(request.arguments.workspace, 'D:/work/project', 'the caller\'s own workspace scopes the search')
})

test('memory: the lookup runs BEFORE the tape is written, so the plan carries the arsenal', async () => {
  const harness = boot({ hint: 'a remembered trap' })
  await spawnMain(harness, '## 计划')
  assert.equal(harness.memoryCalls.length, 1, 'memory was consulted')
  assert.match(briefingTextOf(harness), /a remembered trap/u, 'and its answer is inside the persisted tape')
})

/**
 * THE ABSENCE CASE. A profile without dsh-memory answers `UNKNOWN_TOOL`. That is not a failure of
 * the incubation — it means nothing was remembered, and the main must still be born.
 */
test('memory: a profile without dsh-memory still incubates', async () => {
  const harness = boot(undefined)
  const reply = await spawnMain(harness, '## 计划\n做点什么')

  assert.equal(reply.ok, true, reply.text)
  const text = briefingTextOf(harness)
  assert.match(text, /## 计划/u, 'the plan is there')
  assert.equal(text.includes('[记忆调度]'), false, 'but no empty arsenal section is fabricated')
})

test('memory: an error result is treated as "nothing remembered"', async () => {
  const harness = boot({ error: 'no skills matched' })
  const reply = await spawnMain(harness, '## 计划')

  assert.equal(reply.ok, true, reply.text)
  assert.equal(briefingTextOf(harness).includes('[记忆调度]'), false, 'no section for an empty answer')
})

test('memory: an empty hint adds nothing', async () => {
  const harness = boot({ hint: '   ' })
  const reply = await spawnMain(harness, '## 计划')

  assert.equal(reply.ok, true, reply.text)
  assert.equal(briefingTextOf(harness).includes('[记忆调度]'), false)
})

test('memory: the pair is still recorded when the arsenal is missing', async () => {
  const harness = boot(undefined)
  const reply = await spawnMain(harness, '## 计划')
  const state = debugObserverState()
  const pair = state.pairs[state.pairOf['session-blank']]
  assert.equal(pair.mainSessionId, reply.sessionId)
  assert.equal(pair.origin, 'incubated', 'the pair exists regardless')
})
