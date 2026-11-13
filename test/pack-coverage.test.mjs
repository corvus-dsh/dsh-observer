/**
 * ── observer 的打包门禁（从 dsh-graft-slice 的 `test/v146` 移植）──────────────────────────────────
 *
 * 守什么：`package.json` 的每个指针（`main` / `types` / `dsh.bundle.patch` / `exports` 的每个目标）
 * 都必须真的在 tarball 里；`exports` 的 glob 必须至少命中一个包里文件；没有开发物泄漏。
 *
 * 为什么单列：`build`/`preflight` 查的是产物内容，没有任何东西查「包里到底有没有那个文件」。
 * 一个指向未打包文件的字段，在仓库里看不出异常 —— 只有装上去的人才会撞到。
 *
 * `npm pack --dry-run --json` 不需要网络。npm 不可用时按 RESOURCE 规则跳过（不是通过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')}$`, 'u')

/**
 * npm 入口解析。两次实测的坑：`execFileSync('npm')` 在 Windows 上 ENOENT（npm 是 `npm.cmd`，
 * PATHEXT 不解析）；改 `npm.cmd` 后 EINVAL（Node 20+ 禁无 shell spawn `.cmd`）。
 * 优先 `npm_execpath`；否则 Windows 上开 `shell`。
 */
const npmInvocation = () => {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.endsWith('.js') && existsSync(execpath)) {
    return { cmd: process.execPath, args: [execpath], shell: false }
  }
  return process.platform === 'win32'
    ? { cmd: 'npm', args: [], shell: true }
    : { cmd: 'npm', args: [], shell: false }
}

const packedFiles = (t) => {
  const { cmd, args, shell } = npmInvocation()
  try {
    const out = execFileSync(cmd, [...args, 'pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell,
    })
    return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1))[0].files.map((f) => f.path)
  } catch (error) {
    t.skip(`npm pack --dry-run unavailable (${String(error.message).slice(0, 80)}) — RESOURCE condition, not a pass`)
    return undefined
  }
}

test('pack: every pointer in package.json resolves to a file that is actually packed', (t) => {
  const packed = packedFiles(t)
  if (packed === undefined) return
  const set = new Set(packed)

  const pointers = []
  if (typeof pkg.main === 'string') pointers.push({ field: 'main', target: pkg.main.replace(/^\.\//u, '') })
  if (typeof pkg.types === 'string') pointers.push({ field: 'types', target: pkg.types.replace(/^\.\//u, '') })
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch === 'string') pointers.push({ field: 'dsh.bundle.patch', target: patch.replace(/^\.\//u, '') })

  const dangling = pointers.filter((p) => !set.has(p.target))
  assert.deepEqual(dangling, [], `package.json points at files that are NOT in the tarball:\n  ${dangling.map((d) => `${d.field} -> ${d.target}`).join('\n  ')}`)

  const badExports = []
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const targets = typeof value === 'string' ? [value] : Object.values(value).filter((v) => typeof v === 'string')
    for (const target of targets) {
      const clean = target.replace(/^\.\//u, '')
      if (clean.includes('*')) {
        const re = globToRegExp(clean)
        if (!packed.some((f) => re.test(f))) badExports.push(`${key} -> ${clean} (glob matches nothing)`)
      } else if (!set.has(clean)) {
        badExports.push(`${key} -> ${clean} (not packed)`)
      }
    }
  }
  assert.deepEqual(badExports, [], `exports contains dangling pointers:\n  ${badExports.join('\n  ')}`)
})

test('pack: no development files leaked into the tarball', (t) => {
  const packed = packedFiles(t)
  if (packed === undefined) return
  const forbidden = ['test/', 'scripts/', 'src/', '_scratch/', '.github/']
  const leaked = packed.filter((p) => forbidden.some((bad) => p.startsWith(bad)))
  assert.deepEqual(leaked, [], `development files leaked into the tarball:\n  ${leaked.join('\n  ')}`)
  assert.ok(packed.includes('package.json'), 'package.json must be packed')
  assert.ok(packed.includes('index.js'), 'the entry point must be packed')
})
