/**
 * ── observer 的模块登记门禁（从 dsh-graft-slice 的 `test/v145` 移植）─────────────────────────────
 *
 * 与母本的差别只有一处：母本把表放在 `ARCHITECTURE.md` 的 `### TD-1a` 一节，
 * observer 没有 ARCHITECTURE.md，所以独立成一个文件 `MODULE-REGISTRY.md`。
 *
 * ── 为什么双向 ──────────────────────────────────────────────────────────────────────────────────
 *
 * 只查「表里的文件是否存在」→ 新模块可以悄悄不进表（代码在长、图不动）；
 * 只查「磁盘上的文件是否进表」→ 表里可以留已删除模块的行。
 * 两个方向都查，才叫登记表。第三个方向：依赖列必须指向真实存在的模块。
 *
 * 表头写明分母算法：`endsWith('.ts')`。`src/core` 下没有 `.bak-cut`，
 * 但换成别的目录时要先确认这一点（见 dsh-graft-slice 的维护手册「覆盖率判据」）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REGISTRY = join(ROOT, 'MODULE-REGISTRY.md')
const COVERED_DIRS = ['src/core']

const ROW = /^\|\s*`((?:src\/)?[a-z0-9-]+\/[a-z0-9-]+\.ts)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/gmu

const readRows = () => {
  assert.ok(existsSync(REGISTRY), 'MODULE-REGISTRY.md must exist (it is the only authority on module coverage)')
  const text = readFileSync(REGISTRY, 'utf8')
  const rows = []
  for (const m of text.matchAll(ROW)) {
    rows.push({
      module: m[1].startsWith('src/') ? m[1] : `src/${m[1]}`,
      duty: m[2].trim(),
      exports: m[3].trim(),
      deps: m[4].trim(),
    })
  }
  return rows
}

const modulesOnDisk = () => {
  const out = []
  for (const dir of COVERED_DIRS) {
    for (const f of readdirSync(join(ROOT, dir))) {
      // 分母算法：endsWith('.ts')。`x.ts.bak-cut` 之类的证据文件不以 .ts 结尾，天然排除。
      if (f.endsWith('.ts')) out.push(`${dir}/${f}`)
    }
  }
  return out.sort()
}

test('registry: every module on disk is registered, and every registered module exists', () => {
  const rows = readRows()
  const onDisk = modulesOnDisk()
  const registered = new Set(rows.map((r) => r.module))

  const missing = onDisk.filter((m) => !registered.has(m))
  assert.deepEqual(missing, [], `${missing.length} module(s) under ${COVERED_DIRS.join(', ')} are NOT registered:\n  ${missing.join('\n  ')}`)

  const stale = [...registered].filter((m) => !existsSync(join(ROOT, m)))
  assert.deepEqual(stale, [], `the registry names ${stale.length} file(s) that do not exist:\n  ${stale.join('\n  ')}`)

  const duplicated = [...registered].filter((m) => rows.filter((r) => r.module === m).length > 1)
  assert.deepEqual(duplicated, [], `duplicated registry row(s): ${duplicated.join(', ')}`)
})

test('registry: every row is filled in, and its dependency column points at real modules', () => {
  const rows = readRows()
  assert.ok(rows.length > 0, 'the registry must have rows')

  for (const row of rows) {
    assert.ok(row.duty.length > 0, `${row.module}: the duty cell is empty`)
    assert.ok(row.duty.length <= 80, `${row.module}: the duty must be ONE sentence (<= 80 chars), got ${row.duty.length}`)
    assert.ok(row.exports.length > 0, `${row.module}: the exports cell is empty`)

    if (row.deps === '—' || row.deps === '-') continue
    for (const dep of row.deps.split(',').map((d) => d.trim().replace(/^`|`$/gu, '')).filter((d) => d.length > 0)) {
      const abs = join(ROOT, dep.startsWith('src/') ? dep : join('src', dep))
      assert.ok(existsSync(abs), `${row.module}: dependency column names "${dep}", which does not exist`)
    }
  }
})

test('registry: dependency direction stays acyclic when read from the registry alone', () => {
  const edges = new Map()
  for (const row of readRows()) {
    const deps = row.deps === '—' || row.deps === '-'
      ? []
      : row.deps.split(',').map((d) => d.trim().replace(/^`|`$/gu, '')).filter((d) => d.length > 0)
    edges.set(row.module, deps.map((d) => (d.startsWith('src/') ? d : `src/${d}`)))
  }

  const state = new Map()
  const cycles = []
  const visit = (node, path) => {
    if (state.get(node) === 'done') return
    if (state.get(node) === 'open') { cycles.push([...path, node].join(' -> ')); return }
    state.set(node, 'open')
    for (const next of edges.get(node) ?? []) visit(next, [...path, node])
    state.set(node, 'done')
  }
  for (const node of edges.keys()) visit(node, [])
  assert.deepEqual(cycles, [], `the registry's dependency column contains a cycle:\n  ${cycles.join('\n  ')}`)
})
