# Directory Baseline Git Promote Verification

日期：2026-03-28

## 变更范围

- `scripts/ops/git-slice-promote.mjs`
- `scripts/ops/promote-remote-git-slice.sh`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/directory-baseline-git-promote-design-20260328.md`
- `docs/development/directory-baseline-git-promote-verification-20260328.md`
- `docs/development/remote-git-slice-promote-design-20260328.md`
- `docs/development/remote-git-slice-promote-verification-20260328.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/verification-index.md`

## 本地验证

### 1. CLI 可用性

命令：

```bash
node scripts/ops/git-slice-promote.mjs --list-slices
node scripts/ops/git-slice-promote.mjs --slice directory-migration-baseline --list-groups
pnpm print:git-slice-promote:directory-migration-baseline:groups
```

结果：

- 全部通过
- `directory-migration-baseline` 当前为 `5` 个 commit groups

### 2. 首次 promote 暴露的真实边界

首次执行 promote 时，输入仍指向旧的 materialized branch：

- `materialized/directory-migration-baseline-2026-03-28-144430263z-66094-4d8df6`

它会导致新的 promote 脚本和 promote 文档不出现在 promote 结果里。  
这不是 promote 逻辑错误，而是来源 branch 过旧。

因此先补跑：

```bash
pnpm materialize:git-slice:directory-migration-baseline
```

刷新后的 materialized source：

- branch：`materialized/directory-migration-baseline-2026-03-28-160150838z-48927-d77986`
- head：`81836feda9c1bf1b9816d2650700d1615fef1967`
- `sliceFilesCount=45`

并且当前 `ops-baseline-tooling` 组已经包含：

- `scripts/ops/git-slice-promote.mjs`
- `scripts/ops/promote-remote-git-slice.sh`

当前 `migration-baseline-docs` 组已经包含：

- `docs/development/directory-baseline-git-promote-design-20260328.md`
- `docs/development/directory-baseline-git-promote-verification-20260328.md`
- `docs/development/remote-git-slice-promote-design-20260328.md`
- `docs/development/remote-git-slice-promote-verification-20260328.md`

### 3. verify promote

命令：

```bash
pnpm verify:git-slice-promote:directory-migration-baseline
```

结果：

- 通过
- 来源 manifest：
  - `output/git-slice-materializations/directory-migration-baseline/manifest.json`
- 自动解析 source branch：
  - `materialized/directory-migration-baseline-2026-03-28-160150838z-48927-d77986`
- verify branch：
  - `promoted/directory-migration-baseline-2026-03-28-160224004z-49997-e3aa8c`
- verify head：
  - `1c782b017659d1a95d4a23eff0d64161f400be8a`
- 5 个 promoted commits：
  - `fe96d6ae0b910612da253a04a9d8004b8fcc91e5`
  - `f6c015a3526f6de7b9a4676d13f8cb4e8f2518b0`
  - `a4d1b1b2ecc9a449f58a33e2f87bf0f2b7db82d6`
  - `ad68b6e19c5b496cd99bfbb092c4ed1e957efeb9`
  - `1c782b017659d1a95d4a23eff0d64161f400be8a`
- `verifyPassed=true`
- cleanup：
  - `worktreeRemoved=true`
  - `branchDeleted=true`
  - `tempParentRemoved=true`
- verify manifest：
  - `output/git-slice-promotions/verify-directory-migration-baseline/manifest.json`

### 4. 持久化 promote

命令：

```bash
pnpm promote:git-slice:directory-migration-baseline
```

结果：

- 通过
- 持久化 promoted branch：
  - `promoted/directory-migration-baseline-2026-03-28-160224004z-49985-090859`
- head：
  - `1c782b017659d1a95d4a23eff0d64161f400be8a`
- 输出目录：
  - `output/git-slice-promotions/directory-migration-baseline`
- 关键产物：
  - `manifest.json`
  - `01-core-backend-migration-cli.patch`
  - `02-directory-iam-migrations.patch`
  - `03-ops-baseline-tooling.patch`
  - `04-migration-audit-tests.patch`
  - `05-migration-baseline-docs.patch`
- `groups[].sourceCommitSha -> groups[].promotedCommitSha` 映射已落盘

### 5. 后置状态复核

命令：

```bash
git rev-parse promoted/directory-migration-baseline-2026-03-28-160224004z-49985-090859
git worktree list --porcelain | rg "git-slice-promote|/var/folders/.*/git-slice-promote" -n
```

结果：

- branch 解析到：
  - `1c782b017659d1a95d4a23eff0d64161f400be8a`
- 没有残留的 `git-slice-promote` 临时 worktree

## 结论

这轮验证说明 promote 已经从“设计设想”推进成正式工具：

1. 能基于 materialized branch 或 manifest 做 clean replay
2. 能把 `sourceCommitSha -> promotedCommitSha` 的映射固定成正式输出
3. 能导出 promote manifest 和 per-group patch
4. `verify` 模式会自动清理 branch 和 worktree
5. 不会污染当前 dirty 主工作树

## 实际执行命令

```bash
node scripts/ops/git-slice-promote.mjs --list-slices
node scripts/ops/git-slice-promote.mjs --slice directory-migration-baseline --list-groups
pnpm print:git-slice-promote:directory-migration-baseline:groups
pnpm materialize:git-slice:directory-migration-baseline
pnpm verify:git-slice-promote:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
git rev-parse promoted/directory-migration-baseline-2026-03-28-160224004z-49985-090859
git worktree list --porcelain | rg "git-slice-promote|/var/folders/.*/git-slice-promote" -n
```
