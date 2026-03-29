# Directory Baseline Git Sync Plan Verification

日期：2026-03-28

## 变更范围

- `package.json`
- `scripts/ops/git-slices.mjs`
- `scripts/ops/git-slice-report.mjs`
- `scripts/ops/git-slice-sync-plan.mjs`
- `docs/development/directory-baseline-git-sync-plan-design-20260328.md`
- `docs/development/directory-baseline-git-sync-plan-verification-20260328.md`

## 本地验证

### 1. 共享 slice 与切片报告

命令：

```bash
node scripts/ops/git-slice-report.mjs --list-slices
node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --stage-command
pnpm verify:git-slice:directory-migration-baseline
```

结果：

- 通过
- 当前切片统计为：
  - `files=33`
  - `trackedChanged=4`
  - `untracked=29`
  - `missing=0`

### 2. sync-plan 正常路径

命令：

```bash
node scripts/ops/git-slice-sync-plan.mjs --list-slices
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --json
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --stage-command
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --upstream origin/codex/attendance-pr396-pr399-delivery-md-20260310 --json
```

结果：

- 通过
- 当前核心输出：
  - `mergeBase=473e7b4e89ce1df85d39dc2429b552554430e8f9`
  - `divergence.localOnlyCount=3`
  - `divergence.upstreamOnlyCount=4`
  - `sliceFilesCount=33`
  - `localDirtyPaths=33`
  - `upstreamBehindPaths=[]`
  - `overlapPaths=[]`
  - `stageReadiness.safeToStage=true`
  - `syncReadiness.githubSyncReady=false`
- 显式指定 `--upstream origin/codex/attendance-pr396-pr399-delivery-md-20260310` 时输出与默认 upstream 一致

### 3. sync-plan 风险判定

当前 `upstream behind` 里，真实触及切片路径的提交数为 `0`。

结论：

- migration 基线切片本身与当前 upstream 落后提交无路径重叠
- 这组文件适合先独立收口
- 真实 rebase 风险在切片之外
- 但当前分支仍然 `behind 4`，所以还不能宣称“代码已同步到 GitHub”

### 4. sync-plan verify

命令：

```bash
pnpm verify:git-slice-sync:directory-migration-baseline
```

结果：

- 预期返回非零
- 原因不是切片重叠，而是 `syncReadiness.githubSyncReady=false`
- 当前具体阻塞是：当前分支仍然 `behind 4`
- 这符合新设计：`verify` 用来表明“当前还不能宣称同步完毕”，而不是阻止先收切片

### 5. 非 Git 目录友好失败

命令：

```bash
cd /tmp/metasheet-nongit-check
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-baseline-report.mjs --json
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --json
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --json
```

结果：

- 三者都返回结构化：
  - `error=NOT_A_GIT_REPOSITORY`
  - `message=Current working directory is not a Git working tree.`
- 退出码：`2`
- 不再输出 Node stack trace

### 6. patch 导出

命令：

```bash
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --patch-file output/git-slices/directory-migration-baseline.patch --json
```

结果：

- 通过
- 返回 `patch.path`
- 返回 `patch.bytes`
- 当前 patch 非空，可作为切片交接或归档证据

### 7. NO_UPSTREAM 边界

命令：

```bash
tmpdir=$(mktemp -d /tmp/git-sync-no-upstream-XXXXXX)
cd "$tmpdir"
git init -b main
git config user.name codex
git config user.email codex@example.com
echo '{"name":"tmp"}' > package.json
git add package.json
git commit -m 'init'
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --json
```

结果：

- 返回结构化：
  - `error=NO_UPSTREAM`
  - `message=Current branch does not have an upstream tracking branch.`
- 退出码：`1`

### 8. overlap 高风险边界

命令：

```bash
# 临时 bare remote + producer + consumer
# producer 向 origin/main 推送 package.json 修改
# consumer fetch 后保持本地 package.json 未提交修改
node /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --verify --json
```

结果：

- 返回：
  - `divergence.upstreamOnlyCount=1`
  - `upstreamBehindPaths=["package.json"]`
  - `overlapPaths=["package.json"]`
  - `stageReadiness.safeToStage=false`
  - `syncReadiness.githubSyncReady=false`
- `--verify` 退出码：`1`
- 这证明脚本不仅能识别“behind 但无重叠”，也能识别“behind 且路径真重叠”的更高风险场景

## 远端验证

目标环境：`mainuser@142.171.239.56`

### 9. 宿主机用户态 Node 运行时

结果：

- `node -> /home/mainuser/.local/bin/node`
- `pnpm -> /home/mainuser/.local/bin/pnpm`
- `node -v -> v20.20.2`
- `pnpm -v -> 10.33.0`

### 10. 宿主机 Git 脚本行为

命令：

```bash
cd /home/mainuser/metasheet2
node scripts/ops/git-baseline-report.mjs --json
node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --json
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --json
```

结果：

- 三者均返回结构化 `NOT_A_GIT_REPOSITORY`
- 这说明宿主机上的限制已经从“没有 Node 运行时”收口成“目录不是 Git clone”

## 结论

本轮已把 Git 基线收口从“切片统计”推进到“切片与 upstream 的真实同步计划”：

1. 有共享 slice 定义
2. 有正式的 sync-plan 脚本
3. 能明确证明 migration 切片与当前 upstream behind 提交无路径重叠
4. 能明确区分“可先独立 stage”与“尚未同步 GitHub”
5. 能把 `--upstream`、`NO_UPSTREAM`、overlap 风险、stage command、patch 导出和非 Git 目录友好失败一起输出成正式验证结果
