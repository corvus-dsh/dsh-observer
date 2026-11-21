/**
 * ── v304 (B4-B B0b)：每个注册工具的 `execute` 返回值都必须是**无损 JSON** ────────────────────────
 *
 * ── 这条门禁的来历 ───────────────────────────────────────────────────────────────────────────────
 *
 * graft 的 `graft_prepare` 曾返回一个**自有 `undefined` 键**。`JSON.stringify` 会丢掉它，所以本地所有
 * 检查都通过；但宿主校验的是**无损 JSON**，`undefined` 不可无损表示 ⇒ 整个返回值被拒 ⇒ 主流程无法
 * 调用。发现它的是**用户截图**。
 *
 * 四仓所有 tool 的返回值走同一个宿主校验，而没有本地门禁在测它。逐条事后修就是「修一处，等下一张
 * 截图」。所以这里是机械版：每个注册工具用最小合法参数调一次，逐节点扫描，越界就点名「工具名 + 路径」。
 *
 * ── 判据（四条，两条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 每个注册工具的返回值（**含拒绝回执**）都是无损 JSON
 *   ② **分母**：实际调用数 = 注册数，新工具必须登记进表
 *   ③ 负向：扫描器能红并点名路径
 *   ④ 负向：合法值不许误报
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { makeHost } from './harness.mjs'

/** The host's rule. Returns PATHS, so a failure names where instead of saying 「invalid」. */
function losslessProblems(value, path = '$', seen = new Set()) {
  if (value === undefined) return [`${path} = undefined`]
  if (value === null) return []
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? [] : [`${path} = ${String(value)}（非有限数）`]
  if (type === 'string' || type === 'boolean' || type === 'bigint') return []
  if (type === 'function') return [`${path} = function`]
  if (type === 'symbol') return [`${path} = symbol`]
  if (seen.has(value)) return [`${path} = 循环引用`]
  seen.add(value)
  const problems = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${path}[${index}]`, seen)))
  } else {
    for (const key of Object.keys(value)) {
      problems.push(...losslessProblems(value[key], `${path}.${key}`, seen))
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      problems.push(`${path}.${String(symbol)} = symbol 键`)
    }
  }
  seen.delete(value)
  return problems
}

function makeEnv() {
  const host = makeHost({ askedUser: false })
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'obs-b0b-')), 'observer-bindings.json') })
  return host
}

/**
 * EVERY REGISTERED TOOL, with the smallest arguments that reach its handler.
 *
 * The refusals matter as much as the successes here: `observer_spawn_main` without `userConfirmed`
 * returns a REFUSAL RECEIPT, and that receipt goes through the same host validation as a success. A tool
 * whose success path is legal and whose refusal path is not still breaks the model's flow.
 */
const CALLS = {
  observer_bind: { args: () => ({}) },
  observer_create: { args: () => ({}) },
  observer_consult: { args: () => ({}) },
  observer_spawn_main: { args: () => ({ plan: '## 计划\n1. 一件事' }) },
  observer_status: { args: () => ({}) },
}

test('v304 ①: 每个注册工具的返回值都是无损 JSON', async () => {
  const host = makeEnv()
  const names = [...host.tools.keys()]
  assert.ok(names.length > 0, '没有注册任何工具 —— 分母为 0，这条测试什么也没证明')

  const failures = []
  let exercised = 0

  for (const name of names) {
    const spec = CALLS[name]
    assert.ok(
      typeof spec === 'object' && spec !== null && typeof spec.args === 'function',
      `${name} 在 CALLS 表里没有条目。新工具必须在这里登记最小合法参数，否则这条门禁会漏掉它。`,
    )
    let value
    try {
      value = await host.tools.get(name).execute(spec.args(), { agent: { id: 'session-b0b' } })
    } catch (error) {
      failures.push(`${name} 抛出异常（没有返回值可查）：${String(error?.message ?? error)}`)
      continue
    }
    exercised += 1
    const problems = losslessProblems(value)
    if (problems.length > 0) failures.push(`${name} ⇒ ${problems.join('; ')}`)
  }

  // ② THE DENOMINATOR, carrying the failure list — a count alone hides its own cause.
  assert.equal(
    exercised,
    names.length,
    `只实际调用了 ${exercised}/${names.length} 个工具。异常：\n${failures.join('\n') || '(无)'}`,
  )
  assert.deepEqual(failures, [], `以下工具的返回值不是无损 JSON：\n${failures.join('\n')}`)
})

test('v304 ③: 负向 —— 扫描器能红，且点名 JSON 路径', () => {
  assert.deepEqual(losslessProblems({ ok: true, handover: undefined }), ['$.handover = undefined'])
  assert.deepEqual(losslessProblems({ ok: true, nested: { a: undefined } }), ['$.nested.a = undefined'])
  assert.deepEqual(losslessProblems([1, undefined]), ['$[1] = undefined'])
  assert.deepEqual(losslessProblems({ ok: true, n: NaN }), ['$.n = NaN（非有限数）'])
})

test('v304 ④: 负向 —— 合法值不许误报', () => {
  assert.deepEqual(losslessProblems({ ok: true, a: null, b: 0, c: false, d: '', e: [], f: {} }), [])
  assert.deepEqual(losslessProblems([]), [])
  const shared = { x: 1 }
  assert.deepEqual(losslessProblems({ a: shared, b: shared }), [])
})
