/**
 * ── v247 (B4-0b-1 A4): the binding table must not erase what another process wrote ──────────────
 *
 * Two failures, one cause: `state` is loaded ONCE and `save()` writes the whole document.
 *
 *   · `:154` loads only at mount, `:227` writes the full snapshot ⇒ window B's `recordPair` erases
 *     window A's row. Both receipts say `ok:true`. Two windows on one profile is a SUPPORTED
 *     deployment, so "both peers believe they succeeded" is the normal outcome of the defect.
 *   · `:212-214` catches a torn/unreadable file and starts EMPTY, so the next `save()` writes `{}`
 *     over a file that was only, say, missing a brace. One unreadable moment becomes permanent loss.
 *
 * The fix has two halves, each with its own refusal-rule:
 *   ① before writing, compare the file's TEXT with what this store last read or wrote; if it
 *      changed, read it, merge its rows in, then write (never erase);
 *   ② ENOENT (first run) may write an empty table; anything else is READ-ONLY for the process, the
 *      original left byte-identical, and `observer_status.bindingStore.readOnly` says why.
 *
 * ── why the REAL entry point ─────────────────────────────────────────────────────────────────────
 *
 * These tests boot the plugin (`apply`) and drive `observer_bind` / `observer_status`. The "other
 * process" is simulated by writing the file directly between two tool calls — which is exactly what
 * the other window does to this one, byte for byte. A test that called `createBindingStore` twice
 * would prove the store can merge, not that the plugin reaches that path.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

function boot(bindingsPath) {
  const tools = new Map()
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
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  apply(ctx, { bindingsPath })
  return { ctx, tools }
}

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-v247-')), 'observer-bindings.json')
}

const tableOf = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** What the OTHER window writes: a complete, valid document with one pair in it. */
function foreignTable(observerSessionId, mainSessionId) {
  const key = [observerSessionId, mainSessionId].sort().join('|')
  return {
    bindings: { [mainSessionId]: observerSessionId },
    reverse: { [observerSessionId]: mainSessionId },
    focus: null,
    pairs: { [key]: { observerSessionId, mainSessionId, at: 1, origin: 'summoned' } },
    pairOf: { [observerSessionId]: key, [mainSessionId]: key },
  }
}

test('v247 ①: 另一个窗口先写了，本窗口的 observer_bind 必须合并不覆盖', async () => {
  const path = freshPath()
  const { tools } = boot(path)

  /** The other window's write lands between our load and our bind. */
  writeFileSync(path, JSON.stringify(foreignTable('obs-b', 'main-b'), null, 2), 'utf8')

  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-a', observerSessionId: 'obs-a' })
  assert.equal(bound.ok, true, '配对写成本身必须成功')

  const table = tableOf(path)
  const mains = Object.values(table.pairs).map((row) => row.mainSessionId).sort()
  assert.deepEqual(mains, ['main-a', 'main-b'], `两行都必须在，实测 ${JSON.stringify(mains)}`)
  assert.deepEqual(table.bindings, { 'main-a': 'obs-a', 'main-b': 'obs-b' })

  const status = await tools.get('observer_status').execute({})
  assert.equal(status.bindingStore.mergedOnLastSave, 1, '合并这件事必须被报出来，不许静默')
  assert.equal(status.bindingStore.readOnly, '')
})

test('v247 ②: 坏文件 ⇒ 只读，save 不写它，字节不变，且 observer_status 说出原因', async () => {
  const path = freshPath()
  const broken = '{ "bindings": { "main-a": "obs-a" '
  writeFileSync(path, broken, 'utf8')

  const { tools } = boot(path)
  const status = await tools.get('observer_status').execute({})
  assert.match(String(status.bindingStore.readOnly), /./u, '必须说出为什么只读，不许沉默')
  assert.match(String(status.bindingStore.readOnly), /JSON|Unexpected|EOF|position|end of/u,
    `原因要能指向「解析失败」，实测 ${status.bindingStore.readOnly}`)

  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-x', observerSessionId: 'obs-x' })
  assert.equal(bound.ok, false, '只读模式下绑定必须如实失败，不许回 ok:true')
  assert.match(String(bound.text), /绑定表写入失败/u)
  assert.equal(readFileSync(path, 'utf8'), broken, '原文件必须逐字节保持原样')
})

test('v247 ③: 加载之后被另一个进程写坏 ⇒ 拒绝覆盖（那个文件是证据）', async () => {
  const path = freshPath()
  const { tools } = boot(path) // 文件不存在 ⇒ 可写的空表

  writeFileSync(path, 'not json at all', 'utf8')

  const bound = await tools.get('observer_bind').execute({ mainSessionId: 'main-y', observerSessionId: 'obs-y' })
  assert.equal(bound.ok, false)
  assert.match(String(bound.text), /拒绝覆盖/u)
  assert.equal(readFileSync(path, 'utf8'), 'not json at all')
})

test('v247 ④: 合并不许把「本次主动拆掉的配对」捞回来（v1.2.3 不变式）', async () => {
  const path = freshPath()
  const { tools } = boot(path)

  /** Pair main-x with obs-old (the normal way). */
  await tools.get('observer_bind').execute({ mainSessionId: 'main-x', observerSessionId: 'obs-old' })

  /** Now the other window adds an unrelated pair, which makes our snapshot stale. */
  const stale = tableOf(path)
  const foreign = foreignTable('obs-y', 'main-y')
  writeFileSync(
    path,
    JSON.stringify({ ...stale, bindings: { ...stale.bindings, ...foreign.bindings }, reverse: { ...stale.reverse, ...foreign.reverse }, pairs: { ...stale.pairs, ...foreign.pairs }, pairOf: { ...stale.pairOf, ...foreign.pairOf } }, null, 2),
    'utf8',
  )

  /** Re-pair main-x with obs-new: the old row must be dissolved, not merged back. */
  const rebound = await tools.get('observer_bind').execute({ mainSessionId: 'main-x', observerSessionId: 'obs-new' })
  assert.equal(rebound.ok, true)

  const pairs = Object.values(tableOf(path).pairs)
  const forX = pairs.filter((row) => row.mainSessionId === 'main-x')
  assert.equal(forX.length, 1, `一个主脑只能属于一个配对，实测 ${JSON.stringify(pairs)}`)
  assert.equal(forX[0].observerSessionId, 'obs-new')
  assert.ok(pairs.some((row) => row.mainSessionId === 'main-y'), '别人那一行不许被顺手删掉')
})