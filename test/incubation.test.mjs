/**
 * dsh-observer v1.2.0 — INCUBATION, AND THE BIDIRECTIONAL PAIR.
 *
 * THE ARCHITECTURE THESE CASES PIN
 *
 *   A blank session starts with NO ROLE. It clarifies requirements; when the agreed work is too big
 *   for one context window it calls `observer_spawn_main` and becomes the OBSERVER, while a NEW
 *   session receives the plan and becomes the MAIN.
 *
 * The plan must arrive as a `developer/message` — context, never a prompt — so the incubated main is
 * asleep until the user speaks. Placement comes from the calling session's own header, never a guess.
 * Either half can be grafted later; the pointer moves and nobody waits.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugFollowTransfer, debugObserverState } from '../index.js'

/** `cwd` may be omitted to force the refusal path; `create` may be made to throw. */
function boot({ cwd = 'D:/work/project', createThrows = false } = {}) {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const appends = []
  const renames = []
  const prompts = []
  const creates = []
  let n = 0
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      if (name === 'sessions') {
        return {
          get: (id) => ({
            header: cwd.length > 0 ? { cwd } : {},
            append: (type, data) => appends.push({ id, type, data }),
          }),
        }
      }
      if (name === 'sessionController') {
        return {
          async create(request) {
            if (createThrows) throw new Error('create refused')
            creates.push(request)
            n += 1
            return { sessionId: `session-main-${n}` }
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
  const bindingsPath = join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(ctx, { bindingsPath })
  return { tools, commands, listeners, appends, renames, prompts, creates, bindingsPath }
}

const spawnMain = (harness, observerSessionId, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId }, {})

test('spawn_main: the tool is registered with a mandatory plan', () => {
  const harness = boot()
  const definition = harness.tools.get('observer_spawn_main')
  assert.ok(definition !== undefined, 'observer_spawn_main is registered')
  assert.deepEqual(definition.parameters.required, ['plan'], 'a plan is mandatory bad input guard')
})

test('spawn_main: creates a MAIN in the consulting session\'s own workspace', async () => {
  const harness = boot({ cwd: 'D:/work/live2d' })
  const reply = await spawnMain(harness, 'session-blank', '## 计划\n1. 做 A\n2. 做 B')

  assert.equal(reply.ok, true)
  assert.equal(reply.sessionId, 'session-main-1')
  assert.equal(reply.mainSessionId, 'session-main-1', 'both names are answered')
  assert.equal(harness.creates.length, 1)
  assert.deepEqual(harness.creates[0], { cwd: 'D:/work/live2d' }, 'placement comes from the caller')
})

test('spawn_main: the plan is injected as CONTEXT, and the main is never prompted', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', '## 计划\n目标、约束、步骤、验证')

  assert.equal(harness.prompts.length, 0, 'no prompt: the incubated main must stay asleep')
  assert.equal(harness.appends.length, 1, 'the plan is written into the log')
  const append = harness.appends[0]
  assert.equal(append.id, 'session-main-1', 'into the NEW main')
  assert.equal(append.type, 'developer/message', 'context, not a turn')
  assert.equal(append.data.message.role, 'developer')
  assert.match(append.data.message.content[0].text, /目标、约束、步骤、验证/u, 'the plan text is verbatim')
})

test('spawn_main: the pair is recorded with ROLES, both ways', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan text')

  const state = debugObserverState()
  assert.equal(state.pairs['session-blank|session-main-1'].observerSessionId, 'session-blank')
  assert.equal(state.pairs['session-blank|session-main-1'].mainSessionId, 'session-main-1')
  assert.equal(state.pairs['session-blank|session-main-1'].origin, 'incubated')
  assert.equal(state.pairOf['session-blank'], 'session-blank|session-main-1', 'indexed from the observer side')
  assert.equal(state.pairOf['session-main-1'], 'session-blank|session-main-1', 'and from the main side')
  assert.equal(existsSync(harness.bindingsPath), true, 'and it is on disk')
})

test('spawn_main: both halves are titled so the sidebar distinguishes them', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan text')

  const titles = harness.renames.map((rename) => rename.title)
  assert.equal(titles.length, 2, 'one title per half')
  assert.ok(titles.some((title) => title.startsWith('[主脑]')), 'the new session is marked main')
  assert.ok(titles.some((title) => title.startsWith('[副脑]')), 'and the caller becomes the observer')
})

test('spawn_main: an empty plan is refused before anything is created', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'session-blank', '   ')

  assert.equal(reply.ok, false)
  assert.match(reply.text, /方案为空/u)
  assert.equal(harness.creates.length, 0, 'no session, no orphan')
})

test('spawn_main: no workspace available means NO session, with the reason', async () => {
  const harness = boot({ cwd: '' })
  const reply = await spawnMain(harness, 'session-blank', 'plan')

  assert.equal(reply.ok, false)
  assert.match(reply.text, /拿不到发起会话的工作目录/u)
  assert.equal(harness.creates.length, 0)
})

test('spawn_main: a throwing create is reported, never swallowed', async () => {
  const harness = boot({ createThrows: true })
  const reply = await spawnMain(harness, 'session-blank', 'plan')

  assert.equal(reply.ok, false)
  assert.match(reply.text, /创建主脑会话失败：create refused/u)
})

test('spawn_main: a session that is already a MAIN cannot hatch another main', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const again = await spawnMain(harness, 'session-main-1', 'another plan')

  assert.equal(again.ok, false)
  assert.match(again.text, /已经是主脑/u)
  assert.equal(harness.creates.length, 1, 'no second incubation')
})

/**
 * Either half can hit the watermark and be grafted. The pointer moves; the other half is untouched
 * and NOTHING waits — which is what keeps a mutual-graft deadlock impossible.
 */
test('transfer: when the MAIN is grafted, the observer follows it', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')

  const followed = debugFollowTransfer('session-main-1', 'session-main-1b')
  assert.equal(followed.followed, true)
  assert.equal(followed.role, 'main', 'the MAIN half moved')

  const state = debugObserverState()
  assert.equal(state.pairs['session-blank|session-main-1b'].mainSessionId, 'session-main-1b', 'the new main is the member')
  assert.equal(state.pairs['session-blank|session-main-1b'].observerSessionId, 'session-blank', 'the observer is unchanged')
  assert.equal(state.pairOf['session-main-1'], undefined, 'the stale id is no longer indexed')
  assert.equal(state.pairs['session-blank|session-main-1'], undefined, 'and the old row is gone')
})

test('transfer: when the OBSERVER is grafted, the main follows it', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')

  const followed = debugFollowTransfer('session-blank', 'session-blank-2')
  assert.equal(followed.followed, true)
  assert.equal(followed.role, 'observer', 'the OBSERVER half moved')

  const state = debugObserverState()
  assert.equal(state.pairs['session-blank-2|session-main-1'].observerSessionId, 'session-blank-2')
  assert.equal(state.pairs['session-blank-2|session-main-1'].mainSessionId, 'session-main-1', 'the main is unchanged')
  assert.equal(state.pairOf['session-blank'], undefined, 'the old observer id is gone from the index')
})

test('transfer: the focus note names the MAIN, whichever half moved', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')

  debugFollowTransfer('session-blank', 'session-blank-2') // observer moves
  assert.equal(debugObserverState().focus.sessionId, 'session-main-1', 'the user is sent to the main')

  debugFollowTransfer('session-main-1', 'session-main-1b') // main moves
  assert.equal(debugObserverState().focus.sessionId, 'session-main-1b', 'and follows the main')
})

test('transfer: an unrelated session is ignored, and the pair survives', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const before = JSON.stringify(debugObserverState().pairs)

  const followed = debugFollowTransfer('someone-else', 'somewhere-else')
  assert.equal(followed.followed, false)
  assert.equal(JSON.stringify(debugObserverState().pairs), before, 'nothing moved')
})

/**
 * v1.2.0 — ONE PAIR PER SESSION.
 *
 * `pairOf` is the index every role question goes through, so a session appearing in two pairs would
 * make "is this the observer?" ambiguous. `recordPair` overwrites the index for its own members,
 * and these cases prove the invariant holds through an incubation and a transfer.
 */
test('pairs: a session indexes exactly one pair, before and after a transfer', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')

  const check = (state) => {
    for (const [sessionId, key] of Object.entries(state.pairOf)) {
      assert.ok(state.pairs[key] !== undefined, `pairOf[${sessionId}] must point at a real row`)
      const pair = state.pairs[key]
      assert.ok(
        pair.observerSessionId === sessionId || pair.mainSessionId === sessionId,
        `${sessionId} must be a member of ${key}`,
      )
    }
    const seen = new Set()
    for (const [key, pair] of Object.entries(state.pairs)) {
      assert.ok(!seen.has(pair.observerSessionId), 'an observer belongs to one pair')
      assert.ok(!seen.has(pair.mainSessionId), 'a main belongs to one pair')
      seen.add(pair.observerSessionId)
      seen.add(pair.mainSessionId)
      assert.equal(state.pairOf[pair.observerSessionId], key)
      assert.equal(state.pairOf[pair.mainSessionId], key)
    }
  }

  check(debugObserverState())
  debugFollowTransfer('session-blank', 'session-blank-2')
  check(debugObserverState())
})
