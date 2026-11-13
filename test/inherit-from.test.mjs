/**
 * ── 孵化时传给 adapter 的 `create` 入参必须是可断言的（用户 2026-11-13 点名）─────────────
 *
 * 背景：`src/index.ts` 的孵化路径**一直**在传 `inheritFrom: observerSessionId`，
 * 但 `SessionAdapterLike.create` 的入参类型里没有声明这个字段 —— 于是
 *   ① `tsc` 报 2353「对象字面量只能指定已知属性」（类型欠账）；
 *   ② **没有任何测试断言它真的被传**。`test/cold-inject.test.mjs` 里只有一行注释提到过它。
 *
 * ② 比 ① 严重：类型欠账会让编译报错，而「没人断言」意味着这个字段可以在某次重构里
 * 被静默删掉，测试全绿，然后新会话在**不同的 provider/model/preset/policy** 下跑 ——
 * 正是那条注释自己说的「cost or permission surprise」。
 *
 * 所以本文件断言的是**行为**：观察者孵化主脑时，传给 adapter 的 create 入参里
 * `inheritFrom` 必须等于发起孵化的那个会话 id。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, injectionInternals } from '../index.js'
import { makeHost } from './harness.mjs'

const { ensureWriteAdapter, setWriteAdapterProvider } = injectionInternals

/** 一个只记录调用、从不真正落盘的 adapter。它的存在就是为了让「传了什么」可断言。 */
const makeRecorder = () => {
  const createCalls = []
  const session = {
    name: 'recorder',
    capabilities: {
      create: true,
      trigger: true,
      injectIntoIdle: true,
      injectIntoRunning: true,
      readLog: true,
      subscribe: false,
      verifyDeletion: false,
      unavailable: [],
    },
    async create(input) {
      createCalls.push(input)
      return {
        ok: true,
        stage: 'created',
        warnings: [],
        session: { id: `session-hatched-${createCalls.length}`, cwd: String(input?.cwd ?? '') },
      }
    },
  }
  return { session, createCalls }
}

const bootWithRecorder = () => {
  const recorder = makeRecorder()
  setWriteAdapterProvider(() => ({ ok: true, reason: '', session: recorder.session, layerName: 'recorder' }))
  const host = makeHost({})
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return { host, recorder }
}

test('incubation: the adapter receives inheritFrom = the observer session id', async () => {
  const { host, recorder } = bootWithRecorder()
  try {
    const observerSessionId = 'session-blank'
    const reply = await host.tools.get('observer_spawn_main').execute(
      { plan: '## 计划\n做点事。', observerSessionId, userConfirmed: true },
      {},
    )
    assert.equal(reply.ok, true, `incubation failed: ${reply.text ?? ''}`)
    assert.equal(recorder.createCalls.length, 1, 'exactly one create call')

    const call = recorder.createCalls[0]
    assert.ok(
      Object.prototype.hasOwnProperty.call(call, 'inheritFrom'),
      'the create input MUST carry inheritFrom — without it the main runs under a different policy than the session that hatched it',
    )
    assert.equal(call.inheritFrom, observerSessionId, 'inheritFrom must name the OBSERVER session, not something else')

    // 顺带钉住另外两个一起传的字段：cwd（必需）与 items（计划正文）
    assert.equal(typeof call.cwd, 'string')
    assert.ok(call.cwd.length > 0, 'cwd must be resolved, not empty')
    assert.ok(Array.isArray(call.items) && call.items.length > 0, 'the plan must arrive as items, not as the title')
    assert.ok(
      call.items.some((item) => String(item?.text ?? '').includes('做点事')),
      'the plan text must be present in the items that are injected',
    )
  } finally {
    setWriteAdapterProvider(undefined)
  }
})

test('incubation: inheritFrom follows the caller, not a hardcoded id', async () => {
  // 换个 observer id 再来一次：如果实现里写死了某个常量，这条会红。
  const { host, recorder } = bootWithRecorder()
  try {
    const observerSessionId = 'session-blank-2'
    const reply = await host.tools.get('observer_spawn_main').execute(
      { plan: '## 计划\n第二件事。', observerSessionId, userConfirmed: true },
      {},
    )
    assert.equal(reply.ok, true, `incubation failed: ${reply.text ?? ''}`)
    assert.equal(recorder.createCalls[0]?.inheritFrom, observerSessionId)
  } finally {
    setWriteAdapterProvider(undefined)
  }
})

test('the recorder is actually the adapter in use (otherwise the assertions above prove nothing)', async () => {
  /**
   * 分母守卫：如果 `setWriteAdapterProvider` 没生效，`ensureWriteAdapter` 会返回**别的** adapter，
   * 那么上面两条测试断言的 `createCalls` 永远是空数组 —— `length === 1` 会红，这条则守住「provider 真的接上了」。
   */
  const recorder = makeRecorder()
  setWriteAdapterProvider(() => ({ ok: true, reason: '', session: recorder.session, layerName: 'recorder' }))
  try {
    const resolved = await ensureWriteAdapter({})
    assert.equal(resolved.ok, true)
    assert.equal(resolved.session, recorder.session, 'ensureWriteAdapter must return the provider installed by the test')
  } finally {
    setWriteAdapterProvider(undefined)
  }
})
