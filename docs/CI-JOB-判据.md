# CI 判据：怎么数 job（可复算）

> 起因：2026-11-13 我在报告里写了「observer 仓没有双 Node 矩阵，只有单 job」。
> **这是错的** —— `ci.yml` 第 18–19 行写着 `node: [22.x, 24.x]`。
> 我当时的依据只是 run 对象里的 `jobs_url` 字段存在，**没有去取它指向的内容**。
> 本文把「怎么数」写成可以复算的步骤，避免下次再看错。

## 一、可复算判据（三步，缺一不可）

### 步骤 1：确认矩阵定义在源文件里

```powershell
Select-String -Path .github/workflows/ci.yml -Pattern 'matrix' -Context 0,3
```

**要看到的形状**（observer 实测）：

```
13: jobs:
14:   build-and-test:
15:     runs-on: ubuntu-latest
16:     strategy:
17:       fail-fast: false
18:       matrix:
19:         node: [22.x, 24.x]
```

`matrix.node` 有 N 个取值 ⇒ 这个 workflow **应当**产生 N 个 `build-and-test` job。
**但"应当"不是"实际"**：`fail-fast: false` 才保证一个挂了另一个还会跑；
若矩阵写错（例如 key 不匹配），实际 job 数可能为 1。所以必须走步骤 2。

### 步骤 2：从 runs API 取 jobs，看 `total_count` 与每个 job 的 `name`

```powershell
# 先拿到 run id
$runs = Invoke-RestMethod "https://api.github.com/repos/corvus-dsh/dsh-observer/actions/runs?head_sha=<sha>"
$runId = $runs.workflow_runs[0].id

# 再取这个 run 的 jobs —— 注意：runs 列表里的 jobs_url 只是"地址"，不是内容
$jobs = Invoke-RestMethod "https://api.github.com/repos/corvus-dsh/dsh-observer/actions/runs/$runId/jobs"
$jobs.total_count
$jobs.jobs | Select-Object name, conclusion
```

**判据**：

- `total_count` == 矩阵取值个数（observer 应为 **2**）；
- 每个 job 的 `name` 形如 `build-and-test (<node 版本>)`；
- 每个 job 的 `conclusion` 都是 `success`；
- **`failure` 的计数 = 0**（用 `$jobs.jobs | Where-Object conclusion -ne 'success' | Measure-Object`）。

### 步骤 3：写结论时把这两个数一起写出来

不要只写「CI 绿」。要写 **`total_count` + 每个 job 的 name/conclusion**：

```
run 43375811610 (c0d9eaf) → total_count 2
  build-and-test (24.x) : success
  build-and-test (22.x) : success
  non-success: 0
```

## 二、两个 run 的实测（2026-11-13）

| run | sha | `total_count` | jobs | 非 success |
|---|---|---|---|---|
| 43375811610 | `c0d9eaf` | **2** | `build-and-test (24.x)` success · `build-and-test (22.x)` success | **0** |
| 43375302429 | `6dbd928` | **2** | `build-and-test (22.x)` success · `build-and-test (24.x)` success | **0** |

## 三、我上次错在哪（机制层面）

- 我看了 runs 列表里每个 run 的 `jobs_url` 字段**存在**，就据此判断「只有一个 job」。
  `jobs_url` 是一个**地址**，它的存在与 job 数量无关 —— 每个 run 都有这个字段。
- 正确做法是**取它指向的内容**（步骤 2），看 `total_count`。
- 这属于本项目反复记录的那一族：**用"字段存在"当"内容正确"**。
  同族的旧例：用「文件存在」当「安装成功」、用「跑过了」当「通过了」、用「0 条失败」当「测过了」。

## 四、一句话判据（写进任何报告时用这一句）

> **「双 Node 绿」= `ci.yml` 的 `matrix.node` 有 2 个取值，且该 sha 的 `/jobs` 返回 `total_count: 2`、
> 两个 job 名分别带 `(22.x)` 与 `(24.x)`、`conclusion` 全为 `success`、非 success 计数为 0。**
> 只看到 `jobs_url` 字段不算证据。
