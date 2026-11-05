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

test('observer: a follower gets its pointer and a mission prompt', async () => {
  const { tools, prompts, bindingsPath } = boot()
  const created = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(created.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
  assert.equal(prompts.length, 1, 'the follower is told its role exactly once')
  assert.match(prompts[0].content[0].text, /副脑启动/u)

  const again = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(again.ok, true)
  assert.match(again.text, /未重复创建/u)
  assert.equal(prompts.length, 1, 'a second summon does not spawn a second session')
  assert.ok(readFileSync(bindingsPath, 'utf8').includes('obs-1'))
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
test('observer_bind: writes the pointer, verifies it on disk, and sends the mission', async () => {
  const { tools, prompts, bindingsPath } = boot()
  const bind = tools.get('observer_bind')
  assert.ok(bind !== undefined, 'observer_bind is registered')

  const result = await bind.execute({ mainSessionId: 'main-9', observerSessionId: 'obs-9' })
  assert.equal(result.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-9': 'obs-9' })
  assert.equal(debugObserverState().reverse['obs-9'], 'main-9')
  assert.match(readFileSync(bindingsPath, 'utf8'), /main-9/u, 'the pointer reached the file')
  const mission = prompts[prompts.length - 1]
  assert.match(mission.content[0].text, /副脑启动/u, 'the companion is told its role')
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
test('observer: the three UI commands are registered and the create one works', async () => {
  const { commands, prompts } = boot()
  for (const name of ['observer-state', 'observer-create', 'observer-focus-ack']) {
    assert.ok(commands.has(name), `${name} is registered`)
  }

  const created = await commands.get('observer-create').handler({ rawInput: 'main-cmd', agent: { id: 'main-cmd' } })
  assert.equal(created.kind, 'success')
  assert.match(created.text, /已召唤副脑 obs-1/u)
  assert.equal(prompts.length, 1)

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
})
