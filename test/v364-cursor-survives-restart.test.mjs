/**
 * ── v364：S11 / OBS-02 —— 事件游标必须活过重启 ───────────────────────────────────────────────────
 *
 * 病（`monitor.ts` 的 `hydrateMonitorState`）：它恢复 `nudges` / `lastNudgeAt` / `lastNudgeSeq` /
 * `stalledTurns`，**不恢复** `lastTodoSeq` / `everUsedTodo`。老注释给的理由是：
 *
 *     NOT restored on purpose: failure / pending / toolsThisTurn / blocked.
 *     Those describe events in a LOG, and a log that restarted at seq 0 cannot be resumed…
 *
 * 那条理由对**进程内连击**成立（连着失败几次，新进程无从续接），但对**游标**不成立 ——
 * 日志不会因为进程重启而回到 seq 0。丢失它们的后果是 `everUsedTodo` 回到 false，于是
 * 「这个主脑从没建过看板」这条 stale 触发在一个**已经建过板**的主脑上重新成立：
 * 观察者会继续说「你还没有板」。**告警内容与事实相反，且没有任何错误码。**
 *
 * 判据：
 *   ① `hydrateMonitorState` 恢复两个游标（喂进去 → 值相等）
 *   ② 台账**存得下**它们（`upsertRecord` 的 quota 必须带上）：只恢复不写 ⇒ 恢复出来的永远是 0
 *   ③ 旧台账（没有这两个字段）读成 0 / false，而不是整条记录被丢掉
 *   ④ 重启后游标与 `stalledTurns` 接着走，而不是从 0 重新开始
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { monitorInternals } = await import('../index.js')
const { createMonitorState, hydrateMonitorState } = monitorInternals

const monitorSource = readFileSync(join(ROOT, 'src', 'core', 'monitor.ts'), 'utf8')
const ledgerSource = readFileSync(join(ROOT, 'src', 'core', 'long-term-ledger.ts'), 'utf8')
const supervisorSource = readFileSync(join(ROOT, 'src', 'core', 'supervisor.ts'), 'utf8')

test('v364 ①: hydrate restores the event CURSORS, not only the nudge budget', () => {
  const state = createMonitorState()
  assert.equal(state.lastTodoSeq, 0, '① 前置：新状态从 0 开始')
  assert.equal(state.everUsedTodo, false, '① 前置：新状态从 false 开始')

  hydrateMonitorState(state, {
    nudges: 2,
    lastNudgeAt: 111,
    lastNudgeSeq: 222,
    stalledTurns: 3,
    harvestedReplacement: true,
    lastTodoSeq: 4242,
    everUsedTodo: true,
  })

  assert.equal(state.lastTodoSeq, 4242, '① lastTodoSeq 必须被恢复 —— 否则「板动过没有」在重启后归零')
  assert.equal(state.everUsedTodo, true, '① everUsedTodo 必须被恢复 —— 否则「还没建板」的告警会重新成立')
  assert.equal(state.nudges, 2, '① 既有字段不受影响')
  assert.equal(state.stalledTurns, 3, '① 既有字段不受影响')
  assert.equal(state.harvestedReplacement, true, '① 既有字段不受影响')
})

test('v364 ②: the ledger STORES the cursors — hydrate can only restore what was written', () => {
  /**
   * 「只恢复不写」是这条修复最容易做错的地方：`hydrateMonitorState` 加上两个字段之后，如果写台账
   * 的那一侧没带它们，恢复出来的永远是 0 —— 而 0 的含义正是「板从没动过」，于是同一个缺陷换个
   * 地方复发。判据因此读**两侧的源码**，两边都要在。
   */
  assert.ok(monitorSource.includes('state.lastTodoSeq = number(seed.lastTodoSeq)'),
    '② hydrate 必须写回 lastTodoSeq')
  assert.ok(monitorSource.includes('state.everUsedTodo = seed.everUsedTodo === true'),
    '② hydrate 必须写回 everUsedTodo')
  assert.ok(supervisorSource.includes('lastTodoSeq: state.lastTodoSeq'),
    '② 写台账的 quota 必须带上 lastTodoSeq')
  assert.ok(supervisorSource.includes('everUsedTodo: state.everUsedTodo'),
    '② 写台账的 quota 必须带上 everUsedTodo')
})

test('v364 ③: an OLD ledger row (no cursor fields) reads as 0 / false, and the row SURVIVES', () => {
  /**
   * 向后兼容：v1.3 的台账里没有这两个字段。「这条记录早于该字段」必须是 0 / false，**不是一条坏行**
   * —— 坏行会被丢弃，而丢弃会连带丢掉这条记录唯一的用途（链上的一环）。
   */
  assert.ok(/lastTodoSeq:[^\n]*Number\.isFinite\(Number\(entry\.lastTodoSeq\)\)/u.test(ledgerSource),
    '③ 读取必须对旧行宽容（Number.isFinite 守卫 → 0）')
  assert.ok(/everUsedTodo: entry\.everUsedTodo === true/u.test(ledgerSource),
    '③ everUsedTodo 读取必须是 `=== true`（缺失即 false，不抛、不丢行）')

  /** The interface must DECLARE them, or `stripTypeScriptTypes` lets the write through while the field vanishes. */
  assert.ok(/lastTodoSeq: number/u.test(ledgerSource), '③ MainRecord 必须声明 lastTodoSeq')
  assert.ok(/everUsedTodo: boolean/u.test(ledgerSource), '③ MainRecord 必须声明 everUsedTodo')
})

test('v364 ④: after a restart the stall counter CONTINUES instead of restarting', () => {
  const before = createMonitorState()
  before.stalledTurns = 3
  before.lastTodoSeq = 900
  before.everUsedTodo = true

  /** A restart = a brand-new state object hydrated from what the ledger kept. */
  const after = createMonitorState()
  hydrateMonitorState(after, {
    stalledTurns: before.stalledTurns,
    lastTodoSeq: before.lastTodoSeq,
    everUsedTodo: before.everUsedTodo,
  })
  assert.equal(after.stalledTurns, 3, '④ 重启后 stalledTurns 必须接着数，而不是回到 0')
  assert.equal(after.lastTodoSeq, 900, '④ 游标必须接着指')
  assert.equal(after.everUsedTodo, true, '④ 「建过板」这个事实必须活过重启')
})