/**
 * dsh-observer host tests.
 *
 * The moved graft tests asserted "the follower never gets a tape"; these assert the same
 * rule from the owner's side: the pointer only ever MOVES, a follower cannot chain, and the
 * focus request is consumed exactly once.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugFollowTransfer, debugObserverState } from '../index.js'

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-'))
  const tools = new Map()
  const listeners = new Map()
  const commands = new Map()
  const prompts = []
  const ctx = {
    get(name) {
      if (name === 'commands') {
        return { register: (definition) => commands.set(definition.name, definition) }
      }
      if (name === 'sessionController') {
        return {
          async create() {
            return { sessionId: `obs-${prompts.length + 1}` }
          },
          async prompt(request) {
            prompts.push(request)
            return { accepted: true }
          },
        }
      }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
    on(event, listener) {
      listeners.set(event, listener)
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  const bindingsPath = join(root, 'observer-bindings.json')
  apply(ctx, { bindingsPath })
  return { ctx, tools, listeners, commands, prompts, bindingsPath }
}

test('observer: mounting writes nothing until a follower is created', () => {
  const { bindingsPath } = boot()
  assert.equal(existsSync(bindingsPath), false)
})

test('observer: summoning without a session is refused, never guessed', async () => {
  const { tools } = boot()
  const result = await tools.get('observer_create').execute({}, { agent: {} })
  assert.equal(result.ok, false)
  assert.match(result.text, /没有可绑定的主会话 id/u)
})

/**
 * v1.0.2 — THE MISSION IS STAGED, NOT PUSHED.
 *
 * v1.0.1 sent `[副脑启动]` with `sessionController.prompt` the moment the pointer was written,
 * so a companion opened on a message the user never wrote and could not answer. The mission is
 * now held in the bindings document and released by the companion's FIRST `agent/pre-step`.
 */
test('observer: a follower gets its pointer, and the mission is STAGED (not pushed)', async () => {
  const { tools, prompts, bindingsPath } = boot()
  const created = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(created.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
  assert.equal(prompts.length, 0, 'nothing is pushed into the companion — it must open blank')
  assert.ok(readFileSync(bindingsPath, 'utf8').includes('副脑启动'), 'the mission is held in the document')

  const again = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(again.ok, true)
  assert.match(again.text, /未重复创建/u)
})

test('observer: the first real step releases the mission exactly once', async () => {
  const { tools, listeners, prompts } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  const preStep = listeners.get('agent/pre-step')
  assert.ok(preStep !== undefined, 'the pre-step listener is registered at mount')

  const first = await preStep({ agent: { id: 'obs-1' } }, async () => ({ messages: [] }))
  assert.equal(first.messages.length, 1, 'the companion receives its role on the first step')
  assert.match(first.messages[0].content[0].text, /副脑启动/u)

  const second = await preStep({ agent: { id: 'obs-1' } }, async () => ({ messages: [] }))
  assert.equal(second.messages.length, 0, 'and never again')
  assert.equal(prompts.length, 0, 'this channel never pushes a turn of its own')
})

test('observer: an unrelated session receives nothing', async () => {
  const { listeners } = boot()
  const preStep = listeners.get('agent/pre-step')
  const decision = await preStep({ agent: { id: 'someone-else' } }, async () => ({ messages: [] }))
  assert.deepEqual(decision.messages, [])
})

test('observer: a rejected step is passed through untouched', async () => {
  const { tools, listeners } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  const preStep = listeners.get('agent/pre-step')
  const rejected = await preStep({ agent: { id: 'obs-1' } }, async () => ({ kind: 'reject' }))
  assert.equal(rejected.kind, 'reject', 'a rejection is never decorated with a mission')
})

test('observer: a follower cannot be given a follower of its own', async () => {
  const { tools } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  const chained = await tools.get('observer_create').execute({}, { agent: { id: 'obs-1' } })
  assert.equal(chained.ok, false)
  assert.match(chained.text, /副脑会话/u)
})

test('observer: the transfer listener MOVES the pointer and leaves the follower id intact', async () => {
  const { tools, listeners } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-a' } })
  const follow = listeners.get('graft/session-transferred')
  assert.ok(follow !== undefined, 'the listener is registered at mount')

  follow({ sourceSessionId: 'main-a', newSessionId: 'main-b', at: Date.now() })
  const moved = debugObserverState()
  assert.deepEqual(moved.bindings, { 'main-b': 'obs-1' }, 'the pointer moved, the follower id is unchanged')
  assert.equal(moved.reverse['obs-1'], 'main-b')
  assert.equal(moved.focus.sessionId, 'main-b', 'and the UI is asked to follow once')
})

test('observer: focus is one-shot — ack consumes it exactly once', async () => {
  const { tools } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  // Follow a transfer directly (the event bus is not present in this process).
  const followed = debugFollowTransfer('main-1', 'main-2')
  assert.equal(followed.followed, true)
  const state = debugObserverState()
  assert.deepEqual(state.bindings, { 'main-2': 'obs-1' }, 'the pointer moved to the new main')
  assert.equal(state.reverse['obs-1'], 'main-2', 'and the reverse index agrees')
  assert.equal(state.focus.sessionId, 'main-2', 'a focus request was filed for the new main')

  const status = tools.get('observer_status')
  const first = await status.execute({ ackFocus: true })
  assert.equal(first.focusConsumed, true)
  const second = await status.execute({ ackFocus: true })
  assert.equal(second.focus, null, 'a second ack finds nothing — safe on a remount')
})

test('observer: an unknown transfer changes nothing', () => {
  const { listeners } = boot()
  listeners.get('graft/session-transferred')({ sourceSessionId: 'nobody', newSessionId: 'x' })
  assert.deepEqual(debugObserverState().bindings, {})
})

/**
 * v1.0.1 — THE BIND-ONLY ENTRY, AND THE CLIENT'S PLAN B.
 *
 * The Client now creates the session with `sessions.create` (the only client API returning an
 * id) and opens it; the Host only records the pointer and sends the mission. These tests pin the
 * pair: `observer_bind` writes and VERIFIES the pointer, and it refuses the two dishonest cases
 * (missing ids, a companion binding a companion).
 */
test('observer_bind: writes the pointer, verifies it on disk, and STAGES the mission', async () => {
  const { tools, prompts, bindingsPath, listeners } = boot()
  const bind = tools.get('observer_bind')
  assert.ok(bind !== undefined, 'observer_bind is registered')

  const result = await bind.execute({ mainSessionId: 'main-9', observerSessionId: 'obs-9' })
  assert.equal(result.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-9': 'obs-9' })
  assert.equal(debugObserverState().reverse['obs-9'], 'main-9')
  const document = readFileSync(bindingsPath, 'utf8')
  assert.match(document, /main-9/u, 'the pointer reached the file')
  assert.match(document, /副脑启动/u, 'and so did the staged mission (one durable fact)')
  assert.equal(prompts.length, 0, 'nothing is pushed: the companion must open blank')

  const preStep = listeners.get('agent/pre-step')
  const decision = await preStep({ agent: { id: 'obs-9' } }, async () => ({ messages: [] }))
  assert.equal(decision.messages.length, 1, 'the role arrives on the first real step')
  assert.match(decision.messages[0].content[0].text, /副脑启动/u)
})

test('observer_bind: refuses missing ids and a companion that would bind another', async () => {
  const { tools } = boot()
  const bind = tools.get('observer_bind')

  const missing = await bind.execute({ mainSessionId: 'main-9', observerSessionId: '' })
  assert.equal(missing.ok, false)
  assert.match(missing.text, /缺少/u)

  await bind.execute({ mainSessionId: 'main-9', observerSessionId: 'obs-9' })
  // obs-9 is now a follower; it must not be used as a MAIN session.
  const chained = await bind.execute({ mainSessionId: 'obs-9', observerSessionId: 'obs-10' })
  assert.equal(chained.ok, false)
  assert.match(chained.text, /副脑会话/u)
})
test('observer: the five UI commands are registered, and create stages instead of pushing', async () => {
  const { commands, prompts, tools, listeners } = boot()
  for (const name of ['observer-bind', 'observer-state', 'observer-create', 'observer-consult', 'observer-focus-ack']) {
    assert.ok(commands.has(name), `${name} is registered`)
  }

  const created = await commands.get('observer-create').handler({ rawInput: 'main-cmd', agent: { id: 'main-cmd' } })
  assert.equal(created.kind, 'success')
  assert.match(created.text, /已召唤副脑 obs-1/u)
  assert.equal(prompts.length, 0, 'the command does not push a turn into the new companion')

  const state = JSON.parse((await commands.get('observer-state').handler({})).text)
  assert.deepEqual(state.bindings, { 'main-cmd': 'obs-1' })

  // A transfer moves the pointer; the command surface reports the new target.
  const follow = debugFollowTransfer('main-cmd', 'main-cmd-2')
  assert.equal(follow.followed, true)
  const after = JSON.parse((await commands.get('observer-state').handler({})).text)
  assert.deepEqual(after.bindings, { 'main-cmd-2': 'obs-1' })
  assert.equal(after.focus.sessionId, 'main-cmd-2')

  const acked = await commands.get('observer-focus-ack').handler({})
  assert.equal(acked.kind, 'success')
  const cleared = JSON.parse((await commands.get('observer-state').handler({})).text)
  assert.equal(cleared.focus, null)

  // The client-side plan: the Client creates the session, the Host only records the pointer.
  const bound = await commands.get('observer-bind').handler({ rawInput: 'main-bind obs-bind' })
  assert.equal(bound.kind, 'success')
  assert.ok(tools.get('observer_bind') !== undefined, 'the same logic is reachable as a tool')
  const mission = await listeners.get('agent/pre-step')({ agent: { id: 'obs-bind' } }, async () => ({ messages: [] }))
  assert.equal(mission.messages.length, 1, 'the bound companion gets its role on its first step')
})
