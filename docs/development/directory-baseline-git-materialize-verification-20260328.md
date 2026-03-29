# Directory Baseline Git Materialize Verification

日期：2026-03-28

## 变更范围

- `scripts/ops/git-slice-materialize.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/directory-baseline-git-materialize-design-20260328.md`
- `docs/development/directory-baseline-git-materialize-verification-20260328.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/verification-index.md`

## 本地验证

### 1. CLI 基础可用性

命令：

```bash
node scripts/ops/git-slice-materialize.mjs --list-slices
node scripts/ops/git-slice-materialize.mjs --slice directory-migration-baseline --list-groups
pnpm print:git-slice-materialize:directory-migration-baseline:groups
```

结果：

- 全部通过
- `directory-migration-baseline` 当前有 `5` 个 commit groups
- 根脚本入口已正确接通 `package.json`

### 2. 首轮 verify 暴露的边界

初次执行：

```bash
node scripts/ops/git-slice-materialize.mjs \
  --slice directory-migration-baseline \
  --verify \
  --output-dir output/git-slice-materializations/verify-directory-migration-baseline \
  --json
```

先后暴露出两类真实问题：

1. `migration-baseline-docs` 组里新增的 verification MD 还没落盘  
   - 已补 `docs/development/directory-baseline-git-materialize-verification-20260328.md`
   - 并把脚本错误收口成结构化 `MISSING_GROUP_FILES`
2. 两个 materialize 并行启动时，`git worktree add -b` 会因为 `.git/config` 锁产生半成功状态  
   - 已改成：
     - `git worktree add --detach`
     - 子 worktree 内 `git switch -c <branch> --no-track`
   - 自动 branch 名已改为：
     - `timestamp + pid + random suffix`
   - `git worktree add` 还补了有限重试

这些问题都已修复后重跑通过。

### 3. verify 模式正式通过

命令：

```bash
pnpm verify:git-slice-materialize:directory-migration-baseline
```

结果：

- 通过
- base ref：`origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- base SHA：`86d709e0247125d91753e85caaa07e0db892091d`
- verify 临时 branch：
  - `materialized/directory-migration-baseline-2026-03-28-144416197z-65018-61447b`
- 生成 `5` 个 commit
- verify 结束后：
  - `worktreeRemoved=true`
  - `branchDeleted=true`
  - `tempParentRemoved=true`
- 输出 manifest：
  - `output/git-slice-materializations/verify-directory-migration-baseline/manifest.json`

### 4. 持久化 materialize 正式通过

命令：

```bash
pnpm materialize:git-slice:directory-migration-baseline
```

结果：

- 通过
- 持久化 branch：
  - `materialized/directory-migration-baseline-2026-03-28-144430263z-66094-4d8df6`
- branch HEAD：
  - `11433874accf18398b949831b4594b1b5ab45168`
- 生成 `5` 个 commit，对应分组：
  - `efe81a440b794d1b50614c78b14f613193bd9e6d`
  - `be0f3ac60e5a24c2ae366df31e931121028b0273`
  - `dd4c9c492fe1303fb06d56b0627d36a9396f39c0`
  - `23069ff3b4dbb9635c07d7c48125c748373bbb6c`
  - `11433874accf18398b949831b4594b1b5ab45168`
- 输出目录：
  - `output/git-slice-materializations/directory-migration-baseline`
- 关键产物：
  - `manifest.json`
  - `01-core-backend-migration-cli.patch`
  - `02-directory-iam-migrations.patch`
  - `03-ops-baseline-tooling.patch`
  - `04-migration-audit-tests.patch`
  - `05-migration-baseline-docs.patch`
- materialize 结束后：
  - `worktreeRemoved=true`
  - `branchDeleted=false`
  - `tempParentRemoved=true`

### 5. 并行 verify 复核

命令：

```bash
node scripts/ops/git-slice-materialize.mjs \
  --slice directory-migration-baseline \
  --verify \
  --output-dir output/git-slice-materializations/parallel-a \
  --json

node scripts/ops/git-slice-materialize.mjs \
  --slice directory-migration-baseline \
  --verify \
  --output-dir output/git-slice-materializations/parallel-b \
  --json
```

执行方式：

- 两条命令并行启动

结果：

- 两条都通过
- branch A：
  - `materialized/directory-migration-baseline-2026-03-28-144342791z-63416-274c19`
- branch B：
  - `materialized/directory-migration-baseline-2026-03-28-144342790z-63415-3ebacd`
- 两条并行 verify 最终都得到相同 commit 序列与同一 `head`：
  - `e916029dd78bc895e743380cb6337e069ac83b4e`
- 两条并行 verify 都完成自动清理：
  - `worktreeRemoved=true`
  - `branchDeleted=true`

这说明当前实现已经能承受同仓库下的并行物化验证，而不会再因 branch name 冲突或 `git worktree add -b` 的 config 锁副作用直接失败。

### 6. 后置状态复核

命令：

```bash
git rev-parse materialized/directory-migration-baseline-2026-03-28-144430263z-66094-4d8df6
git worktree list --porcelain | rg "git-slice-materialize|/var/folders/.*/git-slice-materialize" -n
git status --short --branch | head -n 1
```

结果：

- 持久化 branch 可解析到：
  - `11433874accf18398b949831b4594b1b5ab45168`
- `git worktree list` 中没有残留的 `git-slice-materialize` 临时 worktree
- 当前主工作树分支状态仍然是：
  - `ahead 3 / behind 4`

说明 materialize 工具确实把真实提交链物化到了旁路 branch，而没有污染当前 dirty 主工作树。

## 结论

这轮验证说明 `git-slice-materialize` 已经从“设计设想”推进成可直接复用的正式收口工具：

1. 能基于 upstream 安全创建临时 worktree
2. 能把 `directory-migration-baseline` 按 `5` 个 commit groups 物化成真实提交序列
3. 能导出 patch / manifest / branch / commit 证据
4. verify 模式会自动清理 worktree 和 branch
5. 在并行执行下也已通过真实复核
6. 当前主工作树仍未被污染

截至本轮，`directory-migration-baseline` 已经具备：

- 分析
- 同步风险判断
- bundle/patch 导出
- alternate-index apply 预演
- 临时 worktree 真实提交物化

这已经把 Git baseline 工具链推进到了“可安全生成正式提交序列”的层级。 
