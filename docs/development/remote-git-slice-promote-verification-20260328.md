# Remote Git Slice Promote Verification

日期：2026-03-28

## 变更范围

- `scripts/ops/promote-remote-git-slice.sh`
- `scripts/ops/git-slice-promote.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/remote-git-slice-promote-design-20260328.md`
- `docs/development/remote-git-slice-promote-verification-20260328.md`
- `docs/development/directory-baseline-git-promote-design-20260328.md`
- `docs/development/directory-baseline-git-promote-verification-20260328.md`

## 远端验证

### 1. 先刷新 remote materialized source

命令：

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
```

结果：

- 通过
- 默认输出目录：
  - `output/remote-git-slice-materializations/directory-migration-baseline/materialized`
- 新的 remote materialized source branch：
  - `materialized/directory-migration-baseline-2026-03-28-160258265z-203447-13ecef`
- source head：
  - `1aefaecf72fa5e155e72b625a546214439629de4`

### 2. 首次 package 入口暴露的真实边界

初次 remote promote 暴露了两个真实问题：

1. wrapper 默认还在读旧的：
   - `materialized-direct/report.json`
2. 两条 remote promote 并行触发 bootstrap 时，远端会短暂撞上：
   - `could not lock config file .git/config: File exists`

本轮已修复：

- 默认来源优先切到：
  - `output/remote-git-slice-materializations/<slice>/materialized/report.json`
- 新路径缺失时兼容回退旧的 `materialized-direct/report.json`
- 在 `promote-remote-git-slice.sh` 内为 bootstrap 补了有限重试

### 3. 直接 verify

命令：

```bash
pnpm verify:remote-git-slice-promote:directory-migration-baseline
```

结果：

- 通过
- `remoteTransportExitCode=0`
- `remoteCommandExitCode=0`
- `verifyPassed=true`
- 默认来源 report：
  - `output/remote-git-slice-materializations/directory-migration-baseline/materialized/report.json`
- verify 使用的 source branch：
  - `materialized/directory-migration-baseline-2026-03-28-160258265z-203447-13ecef`
- verify promoted branch：
  - `promoted/directory-migration-baseline-2026-03-28-160539223z-205152-3b7bdd`
- verify head：
  - `02f409072e0bc48b8dc0c8c5903444d5560dafe1`
- cleanup：
  - `worktreeRemoved=true`
  - `branchDeleted=true`
  - `tempParentRemoved=true`
- 本地回收输出：
  - `output/remote-git-slice-promotions/directory-migration-baseline/verify`

### 4. 直接正式 promote

命令：

```bash
pnpm ops:promote-remote-git-slice:directory-migration-baseline
```

结果：

- 通过
- 正式 promoted branch：
  - `promoted/directory-migration-baseline-2026-03-28-160609265z-205703-8f8bdf`
- report head：
  - `cdfcb1937decb4118baa90f3c933bd3b4b428741`
- `remotePromotedBranchHeadConfirmed`：
  - `cdfcb1937decb4118baa90f3c933bd3b4b428741`
- 本地回收输出：
  - `output/remote-git-slice-promotions/directory-migration-baseline/promoted`
- `ops-baseline-tooling` 组已经包含：
  - `scripts/ops/git-slice-promote.mjs`
  - `scripts/ops/promote-remote-git-slice.sh`
- docs 组已经包含：
  - `docs/development/directory-baseline-git-promote-design-20260328.md`
  - `docs/development/directory-baseline-git-promote-verification-20260328.md`
  - `docs/development/remote-git-slice-promote-design-20260328.md`
  - `docs/development/remote-git-slice-promote-verification-20260328.md`

### 5. 远端宿主机复核

命令：

```bash
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  mainuser@142.171.239.56 \
  'cd /home/mainuser/metasheet2-git-baseline && printf "head=%s\n" "$(git rev-parse HEAD)" && printf "status=%s\n" "$(git status --porcelain | wc -l | tr -d " ")" && printf "branch_exists=%s\n" "$(git rev-parse promoted/directory-migration-baseline-2026-03-28-160609265z-205703-8f8bdf)"'
```

结果：

- `head=86d709e0247125d91753e85caaa07e0db892091d`
- `status=0`
- `branch_exists=cdfcb1937decb4118baa90f3c933bd3b4b428741`

说明：

- 远端 baseline 主工作树仍然 clean
- 正式 promoted branch 已存在
- promoted branch 没有污染 baseline 主工作树

## 结论

这轮验证后，远端 baseline clone 的收口链路已经从：

- bootstrap
- materialize

推进到：

- bootstrap
- materialize
- promote

并且默认来源、锁竞争、产物回收三层都已经补齐。 
