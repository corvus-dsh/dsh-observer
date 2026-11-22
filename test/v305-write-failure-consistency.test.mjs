/**
 * ── v305 / B4-B B12 (P0): 写失败不得让内存抢在磁盘前面 ──────────────────────────────────────────────
 *
 * 用户原话（派工单 §十四 B12）：**「写失败不得留下内存绑定；`takeFocus` 的 `save()` 返回值必须检查，
 * 写失败要报告（读回磁盘验证：内存清零后磁盘不能仍有焦点）；`ackFocus` 需要会话归属；负向：确实属于本
 * 会话的焦点能被正确消费。」**
 *
 * 三处缺陷，形状是同一个：**一个「已经完成」的内存状态，磁盘上并没有发生。**
 *
 *   ① `bindPair`：`recordPair` 失败 ⇒ 写内存 + `save()`，`save()` 也失败时**内存绑定留着**，
 *      回执说 `ok:false` 而面板仍看得见 —— 面板与磁盘对同一件事说两句话。
 *   ② `takeFocus`：`state.focus = null; save()` —— **返回值被丢弃**。写被拒时内存清零、磁盘仍有焦点，
 *      而下一次任何 `save()` 会把那行并回来（`mergeForeignRows`），于是「已消费」的一次性焦点复活。
 *   ③ `ackFocus`：任意会话调用即消费全局一次性焦点，没有归属检查。
 *
 * ③/④ 的判据在 `observer.test.mjs` 里（focus 是 one-shot 的那两条）；本文件钉 ①②，两者都用**真实的
 * 写失败**注入：路径是目录、或文件在加载后被第三方改成不可解析，不是 mock 掉 store。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState } from '../index.js'

function boot(bindingsPath) {
  const tools = new Map()
  const listeners = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => ({
            header: { cwd: 'D:/test/project' },
            append: () => {},
          }),
        }
      }
      if (name === 'sessionController') {
        return {
          async create() { return { sessionId: 'obs-created' } },
          async prompt() { return { accepted: true } },
          async rename(request) { return { title: request.title, seq: 1 } },
        }
      }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
    on(event, listener) { listeners.set(event, listener) },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  apply(ctx, { bindingsPath })
  return { ctx, tools, listeners }
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-v305-'))
}

test('v305 B12 ②: a REFUSED focus write is reported and does NOT clear the focus memory', async () => {
  const dir = freshDir()
  const bindingsPath = join(dir, 'bindings.json')
  /**
   * A VALID table first, so `load()` accepts it and the store is writable in principle. The failure is
   * then injected AFTER loading — a third party replacing the file with something unparsable. That is
   * a real refusal inside `save()` («拒绝覆盖»), not a mock of the store.
   */
  writeFileSync(
    bindingsPath,
    JSON.stringify({ bindings: {}, reverse: {}, focus: { sessionId: 'main-x', at: 1700000000000 }, pairs: {}, pairOf: {} }),
    'utf8',
  )
  const { tools } = boot(bindingsPath)
  assert.equal(debugObserverState().focus.sessionId, 'main-x', 'fixture: the focus is loaded')

  writeFileSync(bindingsPath, 'not json at all', 'utf8')

  const status = tools.get('observer_status')
  const receipt = await status.execute({ ackFocus: true }, { agent: { id: 'main-x' } })

  assert.equal(receipt.focusConsumed, undefined,
    'a refused write must NOT be reported as consumed — the old receipt was keyed on the ARGUMENT')
  assert.match(String(receipt.focusRefusal), /^FOCUS_WRITE_FAILED/u,
    `the refusal must be named; got: ${String(receipt.focusRefusal)}`)

  // ② MEMORY AGREES WITH DISK: the focus was never actually removed, so it is still there.
  assert.equal(debugObserverState().focus?.sessionId, 'main-x',
    'the focus must be restored in memory: a discarded save() result is how 「已消费」 became a lie')

  // And the receipt still shows it pending, so the UI keeps the request instead of losing it.
  assert.equal(receipt.focus?.sessionId, 'main-x', 'the receipt must report the focus as still pending')
})

test('v305 B12 ②b (negative half): with a healthy store the SAME call consumes the focus', async () => {
  /**
   * Without this, ② is satisfied by 「never consume anything」.
   */
  const dir = freshDir()
  const bindingsPath = join(dir, 'bindings.json')
  writeFileSync(
    bindingsPath,
    JSON.stringify({ bindings: {}, reverse: {}, focus: { sessionId: 'main-y', at: 1700000000000 }, pairs: {}, pairOf: {} }),
    'utf8',
  )
  const { tools } = boot(bindingsPath)

  const receipt = await tools.get('observer_status').execute({ ackFocus: true }, { agent: { id: 'main-y' } })
  assert.equal(receipt.focusConsumed, true)
  assert.equal(debugObserverState().focus, null, 'the healthy path really clears it')
})

test('v305 B12 ①: a bind whose BOTH writes fail leaves no binding in memory', async () => {
  const dir = freshDir()
  const bindingsPath = join(dir, 'as-a-directory')
  mkdirSync(bindingsPath)
  const { tools } = boot(bindingsPath)

  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-z', observerSessionId: 'obs-z' })
  assert.equal(bound.ok, false)
  assert.equal(bound.pairRecorded, false)
  assert.deepEqual(debugObserverState().bindings, {}, 'no memory binding may outlive a failed write')
  assert.deepEqual(debugObserverState().reverse, {})
})

test('v305 B12 ①b (negative half): a HEALTHY bind really does record it', async () => {
  const dir = freshDir()
  const { tools } = boot(join(dir, 'bindings.json'))
  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-w', observerSessionId: 'obs-w' })
  assert.equal(bound.ok, true)
  assert.equal(bound.pairRecorded, true)
  assert.deepEqual(debugObserverState().bindings, { 'main-w': 'obs-w' },
    'the rollback must be conditional on the failure — a blanket rollback would break every bind')
})
