/**
 * dsh-observer host tests.
 *
 * The moved graft tests asserted "the follower never gets a tape"; these assert the same rule from
 * the owner's side: the pointer only ever MOVES, a follower cannot chain, and the companion is
 * marked so the Client can recognise it without asking anyone.
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
  const renames = []
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'commands') {
        return { register: (definition) => commands.set(definition.name, definition) }
      }
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
          async rename(request) {
            renames.push(request)
            return { title: request.title, seq: renames.length }
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
  return { ctx, tools, listeners, commands, prompts, renames, bindingsPath }
}

test('observer: mounting writes nothing until a follower is created', () => {
  const { bindingsPath } = boot()
  assert.equal(existsSync(bindingsPath), false)
})

test('observer: NO agent/pre-step listener — the request pipeline is left alone', () => {
  const { listeners } = boot()
  assert.deepEqual(
    [...listeners.keys()],
    ['graft/session-transferred'],
    'only the transfer event is observed; nothing in the step path is intercepted',
  )
})

test('observer: summoning without a session is refused, never guessed', async () => {
  const { tools } = boot()
  const result = await tools.get('observer_create').execute({}, { agent: {} })
  assert.equal(result.ok, false)
  assert.match(result.text, /没有可绑定的主会话 id/u)
})

/**
 * v1.0.4 — THE ROLE IS AN ORDINARY MESSAGE, AND THE SESSION IS TITLED.
 *
 * Injecting through `agent/pre-step` put this plugin inside the agent loop's request construction
 * and produced an opaque upstream failure. The role now travels with `sessionController.prompt`
 * (the channel any message uses) and the companion's TITLE carries `[副脑]`, which is the marker
 * the Client reads from its own local snapshot to hide the summon chip.
 */
test('observer: a follower gets its pointer, a titled session, and an ordinary role message', async () => {
  const { tools, prompts, renames, bindingsPath } = boot()
  const created = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(created.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
  assert.ok(readFileSync(bindingsPath, 'utf8').includes('main-1'), 'the pointer is durable')

  assert.equal(renames.length, 1, 'the companion is renamed once')
  assert.equal(renames[0].sessionId, 'obs-1')
  assert.match(renames[0].title, /\[副脑\]/u, 'the title carries the marker the Client reads')

  assert.equal(prompts.length, 1, 'the role is delivered as one ordinary message')
  const text = prompts[0].content[0].text
  assert.match(text, /\[系统设定\]/u, 'it is framed as an ordinary system setting, not a step rewrite')
  assert.match(text, /副脑/u)
  assert.match(text, /main-1/u, 'and it names the session being observed')

  const again = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(again.ok, true)
  assert.match(again.text, /未重复创建/u)
  assert.equal(prompts.length, 1, 'a second summon does not re-send the role')
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
  assert.equal(moved.focus.sessionId, 'main-b', 'and a focus note is filed for the new main')
})

test('observer: focus is one-shot — ack consumes it exactly once', async () => {
  const { tools } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  const followed = debugFollowTransfer('main-1', 'main-2')
  assert.equal(followed.followed, true)
  const state = debugObserverState()
  assert.deepEqual(state.bindings, { 'main-2': 'obs-1' })
  assert.equal(state.focus.sessionId, 'main-2')

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
 * v1.0.3 — ONLY THE CLICK PATH'S COMMAND SURVIVES.
 *
 * `observer-state` / `observer-create` / `observer-consult` / `observer-focus-ack` were the
 * client-polling channel and are physically deleted: every command invocation prints a row into
 * the conversation, so while they existed a stale client could keep flooding the transcript. The
 * capability stays available to the MODEL as tools.
 */
test('observer: exactly one command remains, and the tools keep the capability', async () => {
  const { commands, tools, prompts, renames } = boot()
  assert.deepEqual([...commands.keys()], ['observer-bind'], 'only the click path command is registered')
  for (const name of ['observer_bind', 'observer_create', 'observer_consult', 'observer_status']) {
    assert.ok(tools.has(name), `${name} stays available as a tool`)
  }

  // The client-side plan: the Client creates the session, the Host only records the pointer.
  const bound = await commands.get('observer-bind').handler({ rawInput: 'main-bind obs-bind' })
  assert.equal(bound.kind, 'success')
  assert.deepEqual(debugObserverState().bindings, { 'main-bind': 'obs-bind' })
  assert.equal(renames[renames.length - 1].sessionId, 'obs-bind', 'the bound session is titled too')
  assert.equal(prompts[prompts.length - 1].sessionId, 'obs-bind', 'and receives its role message')
})
