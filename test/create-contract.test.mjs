/**
 * dsh-observer — the CREATE/STAGE contract, asserted through the TOOLS.
 *
 * v1.0.3 moved this file off the command surface: `observer-create` and `observer-consult` are
 * deleted (every command invocation printed a row into the conversation, which is the ghost
 * polling the user kept seeing). The same logic is reachable as `observer_create` /
 * `observer_consult` / `observer_bind`, and that is what these cases exercise.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState } from '../index.js'

function boot(bindingsPath) {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const prompts = []
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      if (name === 'sessionController') {
        return {
          async create() {
            created += 1
            return { sessionId: `obs-${created}` }
          },
          async prompt(request) {
            prompts.push(request)
            return { accepted: true }
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
    on(event, listener) {
      listeners.set(event, listener)
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  const path = bindingsPath ?? join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(ctx, { bindingsPath: path })
  return { tools, commands, listeners, prompts, path }
}

/** The documented pre-step decision: `{ kind: 'reject' } | { kind: 'enter'; messages }`. */
const enter = (messages = []) => async () => ({ kind: 'enter', messages })

test('observer_create: answers with the observer session id and binds it', async () => {
  const { tools } = boot()
  const created = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(created.ok, true)
  assert.equal(created.observerSessionId, 'obs-1')
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
})

test('observer_create: the binding is on DISK, not just in memory', async () => {
  const { tools, path } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-2' } })
  assert.ok(existsSync(path), 'observer-bindings.json was written')
  assert.match(readFileSync(path, 'utf8'), /main-2/u)
})

test('observer_create: a refused bind is ok:false and names the reason', async () => {
  const { tools } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-3' } })
  // The companion cannot be given a companion of its own.
  const chained = await tools.get('observer_create').execute({}, { agent: { id: 'obs-1' } })
  assert.equal(chained.ok, false)
  assert.match(chained.text, /副脑会话/u)
})

test('observer_create: an unwritable bindings path is reported, never claimed as success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-'))
  const blocker = join(root, 'blocked')
  writeFileSync(blocker, 'not a directory', 'utf8')
  // <file>/observer-bindings.json cannot be created: mkdir fails.
  const { tools } = boot(join(blocker, 'observer-bindings.json'))
  const reply = await tools.get('observer_create').execute({}, { agent: { id: 'main-x' } })
  assert.equal(reply.ok, false, 'a failed write must not look like a successful summon')
  assert.match(reply.text, /绑定表写入失败/u)
})

test('observer_consult: a companion with NO pointer and a STAGED pre-discussion mission', async () => {
  const { tools, prompts, listeners } = boot()
  const reply = await tools.get('observer_consult').execute({})
  assert.equal(reply.ok, true)
  assert.equal(reply.observerSessionId, 'obs-1')
  assert.deepEqual(debugObserverState().bindings, {}, 'a consultation companion is not bound to anything')
  assert.equal(prompts.length, 0, 'nothing is pushed — the consultation opens blank')

  const decision = await listeners.get('agent/pre-step')({ agent: { id: 'obs-1' } }, enter())
  assert.equal(decision.messages.length, 1, 'and it still receives its role on the first step')
  assert.match(decision.messages[0].content[0].text, /前置需求分析副脑/u)
  assert.match(decision.messages[0].content[0].text, /最终 Prompt/u)
})

/**
 * v1.0.3 — THE END-TO-END CASE THE USER ASKED FOR.
 *
 * A companion created and bound, then the user types their FIRST message in it: pre-step fires,
 * and the decision that leaves the listener must (a) still be `kind: 'enter'` — the shape the loop
 * accepts — and (b) carry the `[副脑启动]` mission. The earlier suite mocked `{ messages: [] }`,
 * a shape the host never produces, so it certified nothing.
 */
test('end to end: the companion\'s first user message carries the mission into the step', async () => {
  const { tools, listeners } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-e2e' } })

  // The user's first message in the companion is what triggers this step.
  const firstUserMessage = { id: 'user-msg-1', role: 'user', content: [{ type: 'text', text: '帮我看下主会话在做什么' }] }
  const decision = await listeners.get('agent/pre-step')(
    { agent: { id: 'obs-1' }, messages: [firstUserMessage], turn: 1, step: 1 },
    enter([firstUserMessage]),
  )

  assert.equal(decision.kind, 'enter', 'the loop only accepts an `enter` decision')
  assert.equal(decision.messages.length, 2, 'the user message is preserved and the mission is appended')
  assert.equal(decision.messages[0].id, 'user-msg-1', 'the user message is never replaced')
  const mission = decision.messages[1]
  assert.equal(mission.role, 'user', 'pre-step messages travel as user messages')
  assert.match(mission.content[0].text, /\[副脑启动\]/u, 'the mission text is present')
  assert.match(mission.content[0].text, /观察者/u, 'and it says what the companion is')

  // Second step: no repetition.
  const second = await listeners.get('agent/pre-step')(
    { agent: { id: 'obs-1' }, messages: [firstUserMessage], turn: 1, step: 2 },
    enter([firstUserMessage]),
  )
  assert.deepEqual(second.messages, [firstUserMessage], 'the mission is delivered exactly once')
})

test('pre-step: a decision that is not `enter` is passed through untouched', async () => {
  const { tools, listeners } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-reject' } })
  const preStep = listeners.get('agent/pre-step')

  const rejected = await preStep({ agent: { id: 'obs-1' } }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' }, 'a rejection is never decorated')

  const unknown = await preStep({ agent: { id: 'obs-1' } }, async () => ({ something: 'else' }))
  assert.deepEqual(unknown, { something: 'else' }, 'an unrecognised decision is not rewritten into a guess')
})

test('pre-step: the agents.currentInitiator fallback resolves a payload without an agent', async () => {
  const listeners = new Map()
  const ctx = {
    get(name) {
      if (name === 'agents') return { currentInitiator: () => ({ id: 'obs-fallback' }) }
      if (name === 'commands') return { register: () => {} }
      return undefined
    },
    logger: { info() {}, warn() {} },
    on(event, listener) {
      listeners.set(event, listener)
    },
    tools: { register: () => {} },
  }
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(ctx, { bindingsPath: path })

  // Stage a mission directly for the id the fallback will supply.
  await listeners.get('agent/pre-step') // touch, to be explicit that it is registered
  const tools = new Map()
  const ctx2WithTools = { ...ctx, tools: { register: (d) => tools.set(d.name, d) } }
  apply(ctx2WithTools, { bindingsPath: path })
  await tools
    .get('observer_bind')
    .execute({ mainSessionId: 'main-fallback', observerSessionId: 'obs-fallback' })

  const decision = await listeners.get('agent/pre-step')({ agent: {} }, enter())
  assert.equal(decision.messages.length, 1, 'the fallback id receives the mission')
  assert.match(decision.messages[0].content[0].text, /\[副脑启动\]/u)
})
