/**
 * ── v245 (B4-0b-1 A2): `observer_bind` must write the PAIR row, not just the legacy maps ─────────
 *
 * The audit's C-2: `src/index.ts:1188` called `store().bindLegacy(...)` and saved. Everything that
 * ACTS on a binding reads `pairs/`:
 *
 *   · `debugFollowTransfer` answers `followed:false` when `pairOf()` misses (index.ts:414);
 *   · restart reconstruction iterates `store().pairs()` (index.ts:622).
 *
 * So the tool replied `ok:true`, `observer_status` showed the binding (it reads the legacy maps), and
 * the pair was invisible to the transfer path and to the reboot path. A receipt that says "bound"
 * while the mechanism that acts on the binding cannot see it is the same class of lie as a gate that
 * prints a promise it does not enforce.
 *
 * ── what this file pins ───────────────────────────────────────────────────────────────────────────
 *
 * ① the pair table has exactly one row after `observer_bind`;
 * ② the legacy maps are still written — as the DERIVED view `recordPair` produces, not as a second write;
 * ③ a transfer of the main is FOLLOWED (that is what the row is for);
 * ④ a fresh `apply()` over the same file rebuilds a supervisor for that main (restart);
 * ⑤ the receipt says `pairRecorded:true` — and the degraded path says `false` with `ok:false`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugFollowTransfer, debugObserverState } from '../index.js'

function boot(bindingsPath) {
  const tools = new Map()
  const listeners = new Map()
  const renames = []
  const appends = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => ({
            header: { cwd: 'D:/test/project' },
            append: (type, data, options) => appends.push({ id, type, data, options }),
          }),
        }
      }
      if (name === 'sessionController') {
        return {
          async create() { return { sessionId: 'obs-created' } },
          async prompt() { return { accepted: true } },
          async rename(request) {
            renames.push(request)
            return { title: request.title, seq: renames.length }
          },
        }
      }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
    on(event, listener) { listeners.set(event, listener) },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  apply(ctx, { bindingsPath })
  return { ctx, tools, listeners, renames, appends }
}

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-v245-')), 'observer-bindings.json')
}

test('v245 ①: `observer_bind` 之后配对表恰有一行，且旧式映射是派生视图', async () => {
  const bindingsPath = freshPath()
  const { tools } = boot(bindingsPath)
  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-a', observerSessionId: 'obs-a' })

  assert.equal(bound.ok, true)
  assert.equal(bound.pairRecorded, true, '回执必须说明「配对表写成了」，而不是只说 ok')

  const file = JSON.parse(readFileSync(bindingsPath, 'utf8'))
  const pairs = Object.values(file.pairs ?? {})
  assert.equal(pairs.length, 1, `配对表必须恰有一行，实测 ${pairs.length}`)
  assert.equal(pairs[0].observerSessionId, 'obs-a')
  assert.equal(pairs[0].mainSessionId, 'main-a')
  assert.equal(pairs[0].origin, 'summoned')

  /** The legacy maps are a VIEW of the same fact — kept for older readers, not a second truth. */
  assert.deepEqual(file.bindings, { 'main-a': 'obs-a' })
  assert.deepEqual(file.reverse, { 'obs-a': 'main-a' })
})

test('v245 ②: 配对行真的被「跟随切片」那条路径用到（followed:true）', async () => {
  const { tools } = boot(freshPath())
  await tools.get('observer_bind').execute({ mainSessionId: 'main-b', observerSessionId: 'obs-b' })

  const followed = debugFollowTransfer('main-b', 'main-b-2')
  assert.equal(followed.followed, true,
    '这一对必须能跟随转移 —— 旧版只写 legacy，这里有 pair 才能答 true')
  assert.equal(followed.role, 'main', '被切走的是主脑那一半')
  assert.equal(followed.observerSessionId, 'obs-b', '副脑 id 必须能回指到那一行')
})

test('v245 ③: 重启（同一份绑定文件再 apply）之后，监理为这个主脑重建', async () => {
  const bindingsPath = freshPath()
  const first = boot(bindingsPath)
  await first.tools.get('observer_bind').execute({ mainSessionId: 'main-c', observerSessionId: 'obs-c' })

  /** A restart is a new `apply()` over the SAME file — that is what `resetBindingStore` re-loads. */
  const rebooted = boot(bindingsPath)
  const status = await rebooted.tools.get('observer_status').execute({})
  assert.ok(
    Object.keys(status.supervisors ?? {}).includes('main-c'),
    `重启后必须从 pairs 重建监理；实测 ${JSON.stringify(status.supervisors)}`,
  )
  assert.deepEqual(debugObserverState().bindings, { 'main-c': 'obs-c' }, '重启后绑定仍在')
})

test('v245 ④: 退化路径（两次写都失败）如实回 ok:false，且内存不留脏绑定', async () => {
  /**
   * Force BOTH writes to fail by making the bindings path a DIRECTORY: `writeAtomic` cannot rename a
   * temp file onto it. `recordPair` therefore fails AND the legacy fallback fails.
   *
   * v8.x B12 (P0): the old assertion here was 「旧式视图已写入」 — and it PASSED, because the code
   * said so. It was not true in this scenario: neither write landed, yet the legacy maps were left in
   * memory, so `observer_status` showed a binding that the file did not have. The sentence and the
   * memory were both lying in the same direction, which is why the test could not see it. Now the
   * assertion is on the STATE, not on the wording: after a double write failure there must be no
   * binding in memory to disagree with the disk.
   */
  const root = mkdtempSync(join(tmpdir(), 'dsh-v245-bad-'))
  const bindingsPath = join(root, 'as-a-directory')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(bindingsPath)

  const { tools } = boot(bindingsPath)
  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-d', observerSessionId: 'obs-d' })
  assert.equal(bound.ok, false, '配对表写不成时必须说 false')
  assert.equal(bound.pairRecorded, false)
  assert.match(String(bound.text), /也没写成/u, `回执必须说清两次写都没落地；实测：${bound.text}`)
  assert.deepEqual(
    debugObserverState().bindings,
    {},
    '写失败不得留下内存绑定：面板看得见、磁盘没有，是同一事实的两半在互相矛盾',
  )
  assert.deepEqual(debugObserverState().reverse, {}, '反向映射也必须回滚')
})