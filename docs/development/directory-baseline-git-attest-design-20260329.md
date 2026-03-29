# Directory Baseline Git Attest Design

日期：2026-03-29

## 背景

`git-slice-replay` 已经证明：

- 本地 handoff 产物可以在 fresh Git repo 中独立重放
- 远端 baseline clone 导出的 handoff 产物也可以独立重放

但还缺最后一层更强的证明：

- 本地链路和远端链路虽然 commit SHA 可能不同，是否在 commit group 语义上等价

## 目标

新增 `git-slice-attest`：

1. 读取 4 份 manifest：
   - local handoff
   - local replay
   - remote handoff
   - remote replay
2. 校验四者：
   - `baseRef` 一致
   - `baseSha` 一致
   - group 数量 / 顺序 / `id` / `message` 一致
   - `patchFileName` 布局一致
3. 为每个 group 解析对应 patch
4. 为每个 group 计算 4 组归一化证据：
   - `patchId`
   - `numstatDigest`
   - `summaryDigest`
   - `pathSetDigest`
5. 输出 attestation report、README、summary

## 为什么不用 commit SHA 或 bundle SHA 做等价判断

本地和远端的 `promote / replay` 都会在不同 Git clone 中重新形成 clean 提交链，因此：

- commit message 应一致
- diff 语义应一致
- 但 commit SHA 不一定一致

`bundleSha256` 也不能当跨环境等价证据，因为：

- 本地 handoff bundle 和 remote handoff bundle 都包含不同 clone 中重新生成的对象
- pack 内容与对象排列天然允许不同

因此 attestation 的主度量不是 commit SHA / bundle SHA，而是：

- `patch-id --stable`
- 归一化 `numstatDigest`
- 归一化 `summaryDigest`
- 归一化 `pathSetDigest`

## 归一化规则

### 1. patch identity

对每个 patch 执行：

```bash
git patch-id --stable < patch-file
```

取第一列作为 `patchId`。

### 2. numstat digest

对每个 patch 执行：

```bash
git apply --numstat - < patch-file
```

按行归一化、排序、拼接后做 SHA-256。

### 3. summary digest

对每个 patch 执行：

```bash
git apply --summary - < patch-file
```

按行归一化、排序、拼接后做 SHA-256。

### 4. path-set digest

从 patch 文本里的：

```text
diff --git a/... b/...
```

提取 path set，去重、排序后做 SHA-256。

### 5. layout identity

对每个 group 要求：

- `order` 一致
- `id` 一致
- `message` 一致
- `patchFileName` 一致

### 6. base identity

对整条链要求：

- `baseRef` 一致
- `baseSha` 一致
- `commitCount` 一致

## 输出

### report.json

包含：

- 4 份输入 manifest 的路径
- 归一化后的 group 明细
- 每组：
  - 4 个 `patchId`
  - 4 个 `numstatDigest`
  - 4 个 `summaryDigest`
  - 4 个 `pathSetDigest`
  - 本地 roundtrip 等价性
  - 远端 roundtrip 等价性
  - 跨环境等价性
- 顶层 `verifyPassed`

### README.md

给人工快速查看：

- attestation 是什么
- 哪些差异是预期差异
- 每组是否在 4 类证据上都等价

### attestation-summary.md

给自动化 / 交接快速贴结论：

- invariants
- group 级结论

## CLI

脚本：

- `scripts/ops/git-slice-attest.mjs`

入口：

- `pnpm verify:git-slice-attest:directory-migration-baseline`
- `pnpm print:git-slice-attest:directory-migration-baseline`
- `pnpm print:git-slice-attest:directory-migration-baseline:groups`
- `pnpm attest:git-slice:directory-migration-baseline`

## 非目标

- 不 push 到 GitHub
- 不修改现网部署目录
- 不要求本地和远端 commit SHA 完全相同
- 不把 bundle SHA 当跨环境等价证明

## 预期收益

工具链进一步推进为：

1. report
2. sync-plan
3. bundle
4. apply
5. materialize
6. promote
7. handoff
8. replay
9. attest

也就是从“本地和远端都能跑通”，推进到“本地与远端已经被机器证明是语义等价的”。
