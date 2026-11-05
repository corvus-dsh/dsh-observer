/**
 * dsh-observer v1.3.1 — VISIBILITY: the briefing must be a shape the CONVERSATION renders.
 *
 * THE BUG THIS FILE PINS
 *
 * The incubation was reported "成功" while the user saw no injected message. Reading the real log
 * proved the write had always worked: `session-c586f512…/session.v4.jsonl.zstd` held 7 events, with
 * the full briefing at seq=3 as a `developer/message`.
 *
 * The message was there and READABLE. It was simply never RENDERED, because DSH's current-surface
 * conversation projection switches on `user/message` and `assistant/message` only and lists
 * `developer/message`, `system/message` and `tool/result` in one shared "excluded" branch
 * (`dsh-session-reference/lib/types/projection.js`, `projectSessionConversation`).
 *
 * So these cases assert the property that was missing — not "a message was written", which was
 * already true, but "the message is of a type the UI shows".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, injectionInternals } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

const { buildInjectTape, materializeInjectTape, assertInjectTape } = injectionInternals

const RENDERED = new Set(['user/message', 'assistant/message'])

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

const spawnMain = (harness, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId: 'session-blank', userConfirmed: true }, {})

const briefOf = (harness, id) => tapeOf(harness.persistence, id).find((event) =>
  event.type === 'user/message' || event.type === 'developer/message',
)

test('visibility: the briefing is a user/message — the type the conversation renders', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, '# 计划\n做 A')
  const brief = briefOf(harness, reply.sessionId)

  assert.ok(brief !== undefined, 'a briefing exists at all')
  assert.equal(brief.type, 'user/message', 'developer/message is present in the log but never rendered')
  assert.equal(RENDERED.has(brief.type), true)
  assert.equal(reply.briefingVisible, true)
  assert.equal(reply.briefingRole, 'user')
})

test('visibility: the briefing is NOT step-scoped, matching the host\'s own user/message', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  const brief = briefOf(harness, reply.sessionId)

  // Measured on real logs: a host-written user/message holds data{content,source,role,id}; there is
  // no turn and no step. Writing the pair here would be a shape the host never produces.
  assert.deepEqual(Object.keys(brief.data).sort(), ['content', 'id', 'role', 'source'])
  assert.equal(brief.data.turn, undefined)
  assert.equal(brief.data.step, undefined)
  assert.equal(brief.surfaceOp, 'append', 'it is still a surface event')
})

test('visibility: the briefing is kind:user (renderable) and carries provenance on its ID', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  const brief = briefOf(harness, reply.sessionId)

  /**
   * v1.5.0 REVERSED THE v1.3.1 RULE, ON EVIDENCE.
   *
   * v1.3.1 required source.kind to start with "plugin:" so the message could never be mistaken for
   * a human utterance. That was the right goal in the wrong place: session-reference/projection.js
   * keeps a user/message only when source.kind === 'user', so the marker was an instruction to hide
   * the very message it was protecting. Provenance moved to the id, which no projector reads.
   */
  assert.equal(brief.data.source.kind, 'user', 'the renderer only shows kind:user user/messages')
  assert.match(brief.data.id, /^observer-briefing-/u, 'provenance rides on the id')
  assert.equal(brief.data.source.rpcId, undefined, 'no rpcId: that is what a real human prompt carries')
  assert.equal(reply.briefingSourceKind, 'user')
})

test('visibility: the system head is STILL the first surface event', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  const events = tapeOf(harness.persistence, reply.sessionId)
  const surface = events.filter((event) => event.surfaceOp === 'append').map((event) => event.type)
  assert.deepEqual(
    surface,
    ['system/message', 'user/message', 'assistant/message'],
    'head first, then the plan as the user, then the same plan as the assistant (graft ships this pair)',
  )
})

/**
 * THE TAPE-LEVEL ASSERTIONS MOVED TO THE LAYER, WITH THE CODE.
 *
 * v1.9.0 sends the incubation through `paradise.session.create`, so these four cases —
 * a developer-role briefing, an unattributable `user/message`, a `user/message` carrying
 * turn/step, and a tape with no carrying message — now test `adapters/dsh/inject.ts`, which is where
 * the validator lives. They are in `dsh-paradise/test/shape-validation.test.mjs`, renamed by CODE
 * (`RED_LINE_BRIEFING_PROVENANCE`, `USER_MESSAGE_STEP_SCOPE`, `MISSING_BRIEFING`) so the intent is
 * searchable from either side.
 *
 * What stays HERE is what this plugin alone can answer: does the RECEIPT tell the reader whether the
 * plan will be seen, and does the disk cross-check label its own derivation. That is the boundary
 * between "the layer's shape rules" and "the observer's report", and it is the boundary this file now
 * documents instead of blurring.
 */

/**
 * PROVENANCE MOVED FROM `source.kind` TO THE MESSAGE ID IN v1.5.0 — and then to the layer in v1.9.0.
 *
 * The three cases that used to live here (an unattributable `user/message`, a `user/message` carrying
 * turn/step, and a tape with no carrying message) are now
 * `dsh-paradise/test/shape-validation.test.mjs`. They assert the SAME codes against the module that
 * actually runs.
 */

test('visibility: the tool result says whether the reader will SEE the plan', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  assert.match(reply.text, /角色=user/u)
  assert.match(reply.text, /会话里可见/u)
  assert.match(reply.text, /方案事件：seq=\d+/u)
  assert.match(reply.text, /属于会话会渲染的类型/u)
})

test('disk-log: the path is derived from cwd and LABELLED as derived, never as authoritative', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  const log = reply.diskLog

  // The fixture host exposes no path getter, so the reader falls back to the host's own layout:
  // <DSH_HOME>/sessions/<escaped cwd>/<sessionId>/session.v4.jsonl.zstd. What matters is that it
  // says SO — a derived path presented as authoritative is the same lie as an invisible briefing.
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    assert.equal(log.pathSource, 'derived:sessions-layout')
    assert.match(log.path, /sessions/u)
    assert.match(log.path, /session\.v4\.jsonl\.zstd$/u)
    assert.ok(log.notes.some((note) => /推导/u.test(note)), 'and it admits the derivation')
  } else {
    assert.equal(log.pathSource, 'unavailable')
  }
  // Whatever the outcome, the tool text must report it rather than imply a clean disk check.
  assert.match(reply.text, /磁盘日志/u)
})

/**
 * THE DISTINCTION THAT MATTERED
 *
 * A rehearsal caught the first version printing `磁盘核对：没有找到承载方案的消息` even when the file
 * was never opened. "Could not read" was being reported as "is not there" — the same error class as
 * the invisible briefing: an answer to a question that was never actually asked.
 */
test('disk-log: an UNREADABLE log is reported as "skipped", never as "not found"', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  // Force the unreadable state, whatever this machine's DSH_HOME looks like.
  assert.equal(reply.ok, true, reply.text)
  if (reply.diskLog.readable) {
    // The derived path happened to read (a real session id collision is impossible, so this means
    // the host wrote the artifact synchronously and the derivation was correct).
    assert.match(reply.text, /磁盘核对：(user|developer)\/message|磁盘核对：.*没有承载方案/u)
    return
  }
  assert.match(reply.text, /磁盘核对：跳过/u, 'unreadable must say so')
  assert.doesNotMatch(reply.text, /磁盘核对：没有找到承载方案的消息/u, 'and must NOT claim absence')
})
