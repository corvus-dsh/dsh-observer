/**
 * ── v248 (B4-0b-1 C-6): the observer panel's contract — including the limit it documents ────────
 *
 * This panel is deliberately tiny: it has NO buttons (the structural reasons D1–D3 are written at the
 * top of the file), it listens for `graft/session-transferred`, and it opens the new main session.
 *
 * Two things are worth checking mechanically:
 *
 *   ① THE ABSENCE IS DECLARED, NOT ACCIDENTAL. "No buttons" is a decision with a recorded reason; a
 *      future edit that adds a button without deleting that comment (or vice versa) should be visible.
 *   ② "WHY DID IT NOT JUMP" IS ANSWERABLE. This half can be inert for two very different reasons:
 *      the HARNESS does not bridge Host plugin events to the Client (the documented limit), or the
 *      LISTENER never registered. From the outside both look like "nothing happened", so the panel now
 *      publishes `__OBSERVER_LOADED__` (it mounted), `__OBSERVER_LISTENING__` (it subscribed) and
 *      `__OBSERVER_TRANSFERS__` (how many events ARRIVED — 0 with listening true means the bridge is
 *      the gap, not this plugin).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('v248 ①: client.js 语法可自动检查；无按钮是「声明过的」，不是漏了', () => {
  const checked = spawnSync(process.execPath, ['--check', join(ROOT, 'client.js')], { encoding: 'utf8' })
  assert.equal(checked.status, 0, `node --check 失败：\n${checked.stderr}`)

  assert.match(client, /WHY THERE IS NO BUTTON/u, '「为什么没有按钮」必须写在文件里 —— 结构原因不能只存在于某人的记忆里')
  assert.equal(
    [...client.matchAll(/h\('button'/gu)].length,
    0,
    '这个面板没有任何 UI 座位（Plan B）；出现按钮意味着结构结论被推翻，那时必须同时改写上面那段理由',
  )
})

test('v248 ②: 「为什么没跳」可观测 —— 载入/订阅/到达三个读数分开', () => {
  /** Mounted at all. */
  assert.match(client, /window\.__OBSERVER_LOADED__\s*=/u, '必须能回答「这个半边有没有挂上」')
  /** Subscribed to the event. */
  assert.match(client, /window\.__OBSERVER_LISTENING__\s*=/u, '必须能回答「订阅成功了吗」')
  /** Events that actually ARRIVED. */
  assert.match(client, /window\.__OBSERVER_TRANSFERS__\s*=/u, '必须能回答「收到过几条转移事件」')
  /**
   * The three readouts must be distinguishable in the ONLY way that matters: listening=true with
   * transfers=0 is the documented harness gap, and the code must say so where a human will look.
   */
  assert.match(client, /ctx\.on\('graft\/session-transferred'/u, '监听的事件名必须与 graft 发出的一致')
  assert.match(client, /harness 是否把 Host 插件事件桥接到 Client/u, '订阅失败时要把「桥接」这条说清楚，而不是只说失败')
})

test('v248 ③: 事件名与语义与 Host 侧一致（口径不许各说各的）', () => {
  assert.ok(client.includes('graft/session-transferred'), '事件名必须逐字一致')
  assert.match(client, /newSessionId/u, '必须读 Host 发的那个字段名，猜一个别名会在改名时静默失效')
  /** A jump needs a real id: an empty payload is skipped, never opened. */
  assert.match(client, /newSessionId\.length\s*===\s*0/u, '空 id 必须被跳过（打开一个不存在的会话比不跳更糟）')
})