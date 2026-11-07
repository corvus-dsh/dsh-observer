/**
 * dsh-observer v1.6.0 — THE THREE-STAGE WORKFLOW, AS A TESTED CONTRACT.
 *
 * THE TWO INCIDENTS THESE CASES REPLACE, IN ORDER
 *
 *   1. A session received 「请先制定计划，然后孵化主脑来执行」, measured the task, decided it was
 *      small, wrote the code itself. The wording made an explicit order into one input of a
 *      judgement ("call it only when the work is too large").
 *   2. The fix for (1) said "a repeated instruction means call this tool NOW". The next acceptance
 *      run showed the session INVENT THE PLAN, hatch a main, ignite it, and start building — with
 *      the user never having seen the plan.
 *
 * (2) is the worse failure: an unapproved plan that RUNS is an unapproved plan at scale. So the
 * rule is a SEQUENCE with a gate, and the gate is enforced in code as well as in prose:
 *
 *     observer_spawn_main REQUIRES userConfirmed:true, AND the session log must show that
 *     ask_user_question was actually called.
 *
 * These cases pin the prose; `confirmation.test.mjs` pins the gate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, policyInternals } from '../index.js'
import { makeHost } from './harness.mjs'

const {
  OBSERVER_MISSION_TEXT,
  SPAWN_MAIN_DESCRIPTION,
  TRIGGER_SECTION_NAME,
  TRIGGER_SECTION_TEXT,
  permitsExecution,
} = policyInternals

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

/* ── 1. the three stages are named, in order ─────────────────────────────── */

test('description: the workflow is three named stages, in order', () => {
  const text = SPAWN_MAIN_DESCRIPTION
  const one = text.indexOf('1. RESEARCH & PLAN')
  const two = text.indexOf('2. ALIGN & CONFIRM')
  const three = text.indexOf('3. EXECUTE & INCUBATE')

  assert.ok(one >= 0, 'stage 1 must be present')
  assert.ok(two >= 0, 'stage 2 must be present')
  assert.ok(three >= 0, 'stage 3 must be present')
  assert.ok(one < two && two < three, 'and in that order')
})

test('description: stage 2 requires ask_user_question and an explicit reply', () => {
  assert.match(SPAWN_MAIN_DESCRIPTION, /ask_user_question/u)
  assert.match(SPAWN_MAIN_DESCRIPTION, /确认 \/ 同意 \/ 开始/u, 'the words that count are named')
  assert.match(SPAWN_MAIN_DESCRIPTION, /确认，开始执行/u, 'and the confirm option is spelled out')
})

test('description: stage 3 requires userConfirmed — the tool refuses without it', () => {
  assert.match(SPAWN_MAIN_DESCRIPTION, /userConfirmed: true/u)
})

/* ── 2. the hard prohibition ─────────────────────────────────────────────── */

test('description: hatching on your own initiative is PROHIBITED, in those words', () => {
  assert.match(SPAWN_MAIN_DESCRIPTION, /HARD PROHIBITION/iu)
  assert.match(SPAWN_MAIN_DESCRIPTION, /DO NOT CALL THIS TOOL ON YOUR OWN INITIATIVE/iu)
  assert.match(SPAWN_MAIN_DESCRIPTION, /probably agrees/iu, 'the rationalisation is named so it can be refused')
})

test('description: "hatch a main" is authorisation for the HANDOFF, not for a plan', () => {
  assert.match(
    SPAWN_MAIN_DESCRIPTION,
    /authorisation to hand off, NOT approval of a plan the user has never seen/iu,
  )
})

test('description: a repeated request is NOT approval', () => {
  assert.match(SPAWN_MAIN_DESCRIPTION, /A REPEATED REQUEST IS NOT APPROVAL EITHER/iu)
})

/* ── 3. the over-correction from v1.4.0 is GONE ─────────────────────────── */

test('description: the "call it now" over-correction has been removed', () => {
  // v1.4.0's exact phrase, which produced the unapproved hatch.
  assert.doesNotMatch(SPAWN_MAIN_DESCRIPTION, /call this tool now/iu)
  assert.doesNotMatch(SPAWN_MAIN_DESCRIPTION, /THE USER ASKED/u, 'the "order first" framing is gone')
})

test('description: a complex task means STOP AND ASK, not hatch', () => {
  assert.match(SPAWN_MAIN_DESCRIPTION, /IF THE TASK TURNS OUT COMPLEX[\s\S]*?STOP/u)
  assert.match(SPAWN_MAIN_DESCRIPTION, /never hatch on your own[\s\S]*?authority/iu)
})

test('description: the escape hatch is words about CONFIRMATION, not about hatching', () => {
  assert.match(SPAWN_MAIN_DESCRIPTION, /不用确认/u)
  assert.match(SPAWN_MAIN_DESCRIPTION, /Only words about the CONFIRMATION STEP itself count/iu)
})

/* ── 4. the section says the same thing (durable channel) ───────────────── */

test('section: it states the three stages and forbids skipping stage 2', () => {
  assert.match(TRIGGER_SECTION_TEXT, /调研与规划/u)
  assert.match(TRIGGER_SECTION_TEXT, /对齐与确认/u)
  assert.match(TRIGGER_SECTION_TEXT, /执行与孵化/u)
  assert.match(TRIGGER_SECTION_TEXT, /不可跳过第 2 段/u)
  assert.match(TRIGGER_SECTION_TEXT, /绝不越权孵化/u)
})

test('section: it is registered as a rendered section', () => {
  const sections = []
  const host = makeHost()
  host.ctx.systemPrompt = {
    section: (definition) => sections.push(definition),
    getSectionOrder: () => 100,
  }
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, TRIGGER_SECTION_NAME)
  assert.equal(typeof sections[0].text, 'function')
  assert.equal(sections[0].text(), TRIGGER_SECTION_TEXT)
})

test('section: a host without systemPrompt.section still boots and keeps the description', () => {
  const harness = boot()
  assert.ok(harness.tools.has('observer_spawn_main'))
  assert.match(
    harness.tools.get('observer_spawn_main').description,
    /HARD PROHIBITION/u,
    'and its description still carries the prohibition',
  )
})

/* ── 5. observer is not the executor ────────────────────────────────────── */

test('mission text: the observer is told it is NOT the executor', () => {
  const text = OBSERVER_MISSION_TEXT('session-main-1')
  assert.match(text, /不是执行者/u)
  assert.match(text, /不要替主脑写/u)
  assert.match(text, /不要因为主脑做得慢就自己接管/u)
  assert.match(text, /session-main-1/u)
})

/**
 * v2.1.0: `permitsExecution` WAS DELETED, so its test is replaced by the fact that replaced it.
 *
 * The function was exported, tested, and never called by production code. The plugin subscribes to
 * `session/event` and `graft/session-transferred` — both NOTIFICATIONS, neither able to veto a tool
 * call — so there is nowhere to enforce "an observer must not execute". The rule survives as the
 * mission text asserted just above (`不是执行者`), which is a prompt-level expectation, not a gate.
 *
 * Keeping a test for a function nobody calls would have preserved the illusion of enforcement. This
 * test pins the honest state: the rule is documented, and there is no mechanism pretending otherwise.
 */
test('no execution guard is exported, because none is enforced', () => {
  assert.equal(
    typeof policyInternals.permitsExecution,
    'undefined',
    'a guard with no call site must not be exported — it reads as enforcement in a review',
  )
  /** The expectation still travels, as prose the model reads. */
  assert.match(policyInternals.OBSERVER_MISSION_TEXT('session-main-1'), /不是执行者/u)
})

/* ── 6. the tool schema carries the gate ────────────────────────────────── */

test('schema: userConfirmed exists, and skipConfirmation is GONE', () => {
  const harness = boot()
  const definition = harness.tools.get('observer_spawn_main')
  const props = definition.parameters.properties
  assert.ok('userConfirmed' in props, 'the gate must be a declared parameter')
  assert.match(props.userConfirmed.description, /ask_user_question/u)
  assert.match(props.userConfirmed.description, /REFUSED/u)
  /**
   * v2.1.0: `skipConfirmation` WAS REMOVED FROM THE SCHEMA TOO.
   *
   * Ignoring it in the handler would leave a model able to pass it and believe it worked — it would
   * get a silent grant of nothing and no error. Because the schema is `additionalProperties: false`,
   * removing the key makes the attempt a SCHEMA ERROR, which is loud and immediate.
   *
   * This test exists so it cannot come back by accident.
   */
  assert.equal('skipConfirmation' in props, false, 'the self-signed bypass must not be declared')
  assert.equal(
    definition.parameters.additionalProperties,
    false,
    'additionalProperties:false is what turns a stray skipConfirmation into a visible error',
  )
  assert.deepEqual(
    definition.parameters.required,
    ['plan'],
    'plan stays the only required field; the gate is enforced by the handler',
  )
})
