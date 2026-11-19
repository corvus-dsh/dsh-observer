/**
 * ── v246 (B4-0b-1 A3): the harvest gate must not spend its budget before it can spend it ────────
 *
 * The audit's C-3: `supervisor.ts:214` called `harvestGate(...)` first — and that function MUTATES
 * `harvests` / `lastHarvestAt` / `harvestedSignature` (monitor.ts:646-648) — and only then checked
 * `deps.tools` at `:216`. So a supervisor mounted before the tools service existed recorded "already
 * harvested" while mining NOTHING. Worse, the completion path refuses when
 * `harvestedSignature === todoSignature` (`monitor.ts:621`), so that exact board could never be mined
 * again — even after the service arrived. `harvests:1` in `observer_status` is then a lie with a
 * permanent cost.
 *
 * ── what this file pins ───────────────────────────────────────────────────────────────────────────
 *
 * ① no tools ⇒ `harvests` stays 0 and `harvestedSignature` is untouched;
 * ② the SAME completed board is still mineable once tools become available;
 * ③ a THROWING `memory_harvest` returns the quota too (the other failure path);
 * ④ the same for an `isError` result — "attempted" and "mined" are different words.
 *
 * Why the same supervisor instance can serve ① and ②: `deps` is held by reference and read at CALL
 * time, which is exactly what happens in production when a host service resolves late. The test
 * mutates that object to simulate it — no second implementation, no fake seam.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { monitorInternals, supervisorInternals } from '../index.js'

const { createSupervisor } = supervisorInternals

let seq = 0
const nextSeq = () => (seq += 1)

const toolCall = (name, callId, args) => ({ type: 'tool/call', seq: nextSeq(), data: { turn: 1, step: 1, callId, name, arguments: args } })
const toolResult = (callId) => ({
  type: 'tool/result',
  seq: nextSeq(),
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }], source: { callId } } },
})
const turnEnd = () => ({ type: 'turn/end', seq: nextSeq(), data: { turn: 1, reason: { kind: 'completed' } } })
const todoWrite = (callId, todos) => toolCall('todo_write', callId, JSON.stringify({ todos }))

/** One turn whose board is COMPLETE — the `harvest` action's precondition. */
async function completedTurn(supervisor, tag) {
  const id = `${tag}-todo`
  await supervisor.observe(todoWrite(id, [{ content: `只做一件事 ${tag}`, status: 'completed' }]))
  await supervisor.observe(toolResult(id))
  await supervisor.observe(turnEnd())
}

/**
 * The deps object is the SAME object the supervisor closes over (`createSupervisor` keeps the
 * reference and reads `deps.tools` at call time). Returning it is what makes "the service arrives
 * later" expressible without a second code path.
 */
function supervisorWith(partial) {
  const deps = {
    logger: { info: () => {}, warn: () => {} },
    idleMs: 60_000,
    setTimer: () => null,
    clearTimer: () => {},
    ...partial,
  }
  return { supervisor: createSupervisor('obs-harvest', 'main-harvest', deps), deps }
}

/** What `memory_harvest` looks like from the outside, per call, with the mined ids it reports. */
function harvestingTools(calls) {
  return {
    async execute(request) {
      calls.push({ name: request.name, arguments: request.arguments })
      return { value: { scanned: 3, harvested: [{ sessionId: 'main-harvest' }] } }
    },
  }
}

test('v246 ①: 没有 tools 时不许记「已提炼」—— harvests 不动，签名不动', async () => {
  const { supervisor } = supervisorWith({ controller: { async prompt() { return { accepted: true } } } })
  await completedTurn(supervisor, 'a')

  const state = supervisor.state()
  assert.equal(state.harvests, 0, `什么都没执行就不许记一次提炼，实测 ${state.harvests}`)
  assert.equal(state.harvestedSignature, '', '完成清单的签名不许被占掉 —— 它是「这份清单已提炼」的唯一凭据')
})

test('v246 ②: 之后 tools 到了，同一份完成清单必须仍可被提炼', async () => {
  const { supervisor, deps } = supervisorWith({ controller: { async prompt() { return { accepted: true } } } })
  await completedTurn(supervisor, 'same')

  assert.equal(supervisor.state().harvests, 0, '前提：第一次没有 tools，什么都没记')

  const calls = []
  deps.tools = harvestingTools(calls) // the service resolves late — the production case
  await completedTurn(supervisor, 'same')

  assert.equal(calls.length, 1, '同一份完成清单在 tools 到位后必须真的被提炼一次')
  assert.equal(calls[0].name, 'memory_harvest')
  assert.equal(supervisor.state().harvests, 1)
})

test('v246 ③: `memory_harvest` 抛错 ⇒ 配额归还，下一次仍可重试', async () => {
  const { supervisor, deps } = supervisorWith({
    controller: { async prompt() { return { accepted: true } } },
    tools: { async execute() { throw new Error('memory 崩了') } },
  })
  await completedTurn(supervisor, 'boom')

  const state = supervisor.state()
  assert.equal(state.harvests, 0, `抛错不许留下「已提炼」，实测 ${state.harvests}`)
  assert.equal(state.harvestedSignature, '', '签名必须归还，否则这份清单永远不再被看')

  const calls = []
  deps.tools = harvestingTools(calls)
  await completedTurn(supervisor, 'boom')
  assert.equal(calls.length, 1, '修好之后同一份清单必须还能被提炼')
})

test('v246 ④: `isError` 结果同样归还配额 —— 「试过」不是「提炼过」', async () => {
  const { supervisor, deps } = supervisorWith({
    controller: { async prompt() { return { accepted: true } } },
    tools: { async execute() { return { isError: true, error: { message: '账本不可读' } } } },
  })
  await completedTurn(supervisor, 'err')

  assert.equal(supervisor.state().harvests, 0)

  const calls = []
  deps.tools = harvestingTools(calls)
  await completedTurn(supervisor, 'err')
  assert.equal(calls.length, 1)
  assert.equal(supervisor.state().harvests, 1)
})