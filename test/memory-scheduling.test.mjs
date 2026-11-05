/**
 * dsh-observer v1.2.1 — MEMORY SCHEDULING AT INCUBATION.
 *
 * An incubated main should not start from zero experience. Before the plan is handed over, the
 * observer asks `dsh-memory` (through the ordinary `tools.execute` registry — no private API) what
 * it already knows about this kind of work, and packs the answer into the same developer message.
 *
 * These cases pin the three properties that matter:
 *   * the arsenal is APPENDED to the plan, never a replacement for it;
 *   * a profile WITHOUT dsh-memory still incubates (absence is not failure);
 *   * a memory call that throws never costs the user their main session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState } from '../index.js'

/**
 * `memory` controls what the fake `tools.execute` answers:
 *   undefined        — the tool is not registered at all (no dsh-memory in the profile)
 *   { hint }         — a successful search
 *   { error }        — the tool answers with an error result
 *   'throw'          — the registry itself throws
 */
function boot(memory) {
  const tools = new Map()
  const appends = []
  const memoryCalls = []
  let n = 0
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: () => {} }
      if (name === 'sessions') {
        return { get: (id) => ({ header: { cwd: 'D:/work/project' }, append: (type, data) => appends.push({ id, type, data }) }) }
      }
      if (name === 'tools') {
        return {
          register: (definition) => tools.set(definition.name, definition),
          execute: async (request) => {
            memoryCalls.push(request)
            if (memory === 'throw') throw new Error('UNKNOWN_TOOL: memory_search')
            if (memory === undefined) throw new Error('UNKNOWN_TOOL: memory_search')
            if (memory.error !== undefined) return { isError: true, error: { message: memory.error }, content: [] }
            return { isError: false, value: { hint: memory.hint }, content: [] }
          },
        }
      }
      if (name === 'sessionController') {
        return {
          async create() {
            n += 1
            return { sessionId: `session-main-${n}` }
          },
          async rename(request) {
            return { title: request.title, seq: 1 }
          },
        }
      }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  apply(ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return { tools, appends, memoryCalls }
}

const spawnMain = (harness, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId: 'session-blank' }, {})

test('memory: the arsenal is appended to the plan in ONE developer message', async () => {
  const harness = boot({ hint: '### skill: 冷 tape 物化\n- 先物化再写入\n- 坑：不能在 SessionStore 外 append' })
  const reply = await spawnMain(harness, '## 计划\n1. 切片\n2. 验证')

  assert.equal(reply.ok, true)
  assert.equal(harness.appends.length, 1, 'still exactly one context message')
  const text = harness.appends[0].data.message.content[0].text
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

/**
 * THE ABSENCE CASE. A profile without dsh-memory answers `UNKNOWN_TOOL`. That is not a failure of
 * the incubation — it means nothing was remembered, and the main must still be born.
 */
test('memory: a profile without dsh-memory still incubates', async () => {
  const harness = boot(undefined)
  const reply = await spawnMain(harness, '## 计划\n做点什么')

  assert.equal(reply.ok, true, 'the incubation succeeded')
  assert.equal(harness.appends.length, 1)
  const text = harness.appends[0].data.message.content[0].text
  assert.match(text, /## 计划/u, 'the plan is there')
  assert.equal(text.includes('[记忆调度]'), false, 'but no empty arsenal section is fabricated')
})

test('memory: an error result is treated as "nothing remembered"', async () => {
  const harness = boot({ error: 'no skills matched' })
  const reply = await spawnMain(harness, '## 计划')

  assert.equal(reply.ok, true)
  const text = harness.appends[0].data.message.content[0].text
  assert.equal(text.includes('[记忆调度]'), false, 'no section for an empty answer')
})

test('memory: an empty hint adds nothing', async () => {
  const harness = boot({ hint: '   ' })
  const reply = await spawnMain(harness, '## 计划')

  assert.equal(reply.ok, true)
  const text = harness.appends[0].data.message.content[0].text
  assert.equal(text.includes('[记忆调度]'), false)
})

test('memory: the pair is still recorded when the arsenal is missing', async () => {
  const harness = boot(undefined)
  await spawnMain(harness, '## 计划')
  const state = debugObserverState()
  assert.equal(state.pairs['session-blank|session-main-1'].origin, 'incubated', 'the pair exists regardless')
})
