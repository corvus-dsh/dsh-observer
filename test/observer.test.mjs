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
  const appends = []
  const renames = []
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'commands') {
        return { register: (definition) => commands.set(definition.name, definition) }
      }
      if (name === 'sessions') {
        return {
          get: (id) => ({
            append: (type, data) => {
              appends.push({ id, type, data })
            },
          }),
        }
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
  return { ctx, tools, listeners, commands, prompts, appends, renames, bindingsPath }
}

test('observer: mounting writes nothing until a follower is created', () => {
  const { bindingsPath } = boot()
  assert.equal(existsSync(bindingsPath), false)
})

test('observer: the step path is never intercepted, and the title feed is observed', () => {
  const { listeners } = boot()
  assert.equal(listeners.has('agent/pre-step'), false, 'nothing in the step path is intercepted')
  assert.equal(listeners.has('session/event'), true, 'the post-commit feed is how a binding arrives')
  assert.equal(listeners.has('graft/session-transferred'), true, 'and transfers are still followed')
})

/**
 * v1.0.6 — THE BINDING ARRIVES THROUGH THE EVENT FEED.
 *
 * The Client renames its new session to `[副脑] 跟随 <main id>` through a PLAIN Remote call
 * (`remote.session.rename`), which is not a command and therefore prints no row. The Host reads
 * its own `session/event` feed, parses the title, writes the pointer and injects the setting.
 */
test('observer: a [副脑] title binds the pair and injects the setting', async () => {
  const { listeners, appends } = boot()
  const onEvent = listeners.get('session/event')

  onEvent({ id: 'obs-title' }, { type: 'session/title', data: { title: '[副脑] 跟随 main-title' } })

  assert.deepEqual(debugObserverState().bindings, { 'main-title': 'obs-title' })
  assert.equal(debugObserverState().reverse['obs-title'], 'main-title')
  assert.equal(appends.length, 1, 'the setting is written once')
  assert.equal(appends[0].type, 'developer/message')
  assert.match(appends[0].data.message.content[0].text, /main-title/u)
})

test('observer: an unrelated or repeated title changes nothing', async () => {
  const { listeners, appends } = boot()
  const onEvent = listeners.get('session/event')

  onEvent({ id: 'some-session' }, { type: 'session/title', data: { title: '普通标题' } })
  assert.deepEqual(debugObserverState().bindings, {}, 'a normal retitle is not a binding')
  assert.equal(appends.length, 0)

  onEvent({ id: 'obs-title' }, { type: 'session/title', data: { title: '[副脑] 跟随 main-title' } })
  onEvent({ id: 'obs-title' }, { type: 'session/title', data: { title: '[副脑] 跟随 main-title' } })
  assert.equal(appends.length, 1, 'a repeated title event must not inject the setting twice')
})

test('observer: summoning without a session is refused, never guessed', async () => {
  const { tools } = boot()
  const result = await tools.get('observer_create').execute({}, { agent: {} })
  assert.equal(result.ok, false)
  assert.match(result.text, /没有可绑定的主会话 id/u)
})

/**
 * v1.0.5 — THE SETTING IS WRITTEN INTO THE LOG, NOT PROMPTED INTO THE AGENT.
 *
 * v1.0.4 delivered the role with `sessionController.prompt`, which ADMITS A TURN: the companion
 * opened already running and burned quota doing it. `developer/message` is CONTEXT — it never
 * starts the agent loop — so the companion opens as a quiet blank page carrying its background.
 * The tests therefore assert on the physical append and on `prompts` staying EMPTY.
 */
test('observer: a follower gets its pointer, a title, and a PHYSICALLY written setting', async () => {
  const { tools, prompts, appends, renames, bindingsPath } = boot()
  const created = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(created.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
  assert.ok(readFileSync(bindingsPath, 'utf8').includes('main-1'), 'the pointer is durable')

  assert.equal(renames.length, 1, 'the companion is renamed once')
  assert.equal(renames[0].sessionId, 'obs-1')
  assert.match(renames[0].title, /\[副脑\]/u, 'the title carries the marker the Client reads')

  assert.equal(prompts.length, 0, 'NO prompt: the agent loop must not be started by a summon')
  assert.equal(appends.length, 1, 'the setting is written into the log instead')
  assert.equal(appends[0].id, 'obs-1')
  assert.equal(appends[0].type, 'developer/message', 'a developer message is context, not a turn')
  assert.equal(appends[0].data.message.role, 'developer')
  const text = appends[0].data.message.content[0].text
  assert.match(text, /\[系统设定\]/u, 'the setting is framed as standing context')
  assert.match(text, /main-1/u, 'and it names the session being observed')

  const again = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(again.ok, true)
  assert.match(again.text, /未重复创建/u)
  assert.equal(appends.length, 1, 'a second summon does not write the setting twice')
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
 * v1.0.9 — EXACTLY ONE COMMAND, AND IT IS THE SPAWN REQUEST.
 *
 * Every command invocation is rendered as a row in the conversation no matter what the handler
 * returns, so broadcast commands stay at the minimum: the one generic client→host channel this Host
 * offers a third-party half is used for exactly one thing — "create the companion for this session".
 * Bookkeeping (bind, status, consult) stays on TOOLS, which the model calls.
 */
test('observer: one command (spawn), and the tools keep the rest', async () => {
  const { commands, tools, prompts, appends, renames } = boot()
  assert.deepEqual([...commands.keys()], ['observer-spawn'], 'only the spawn request is broadcast')
  for (const name of ['observer_bind', 'observer_create', 'observer_consult', 'observer_status']) {
    assert.ok(tools.has(name), `${name} stays available as a tool`)
  }

  // The model-facing path still writes the pointer AND titles the session.
  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-tool', observerSessionId: 'obs-tool' })
  assert.equal(bound.ok, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-tool': 'obs-tool' })
  assert.equal(renames[renames.length - 1].sessionId, 'obs-tool')
  assert.equal(appends[appends.length - 1].id, 'obs-tool', 'the setting is written physically')
  assert.equal(prompts.length, 0, 'no prompt anywhere in the bind path')
})
