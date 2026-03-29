# Remote Git Slice Publish Design

日期：2026-03-29

## 背景

远端 baseline clone 已经能完成：

- materialize
- promote
- handoff
- replay
- attest
- submit
- land

但还缺最后一层：把 remote landed branch 变成正式 publish packet，并把交付产物拉回本地。

## 目标

新增：

- `scripts/ops/publish-remote-git-slice.sh`

职责：

1. bootstrap 远端 baseline clone
2. 上传 remote land manifest
3. 在远端 baseline clone 中运行 `git-slice-publish`
4. 回收：
   - `report.json`
   - `manifest.json`
   - `publish-summary.md`
   - `README.md`
   - `publish-commands.sh`
   - `commit-summary.md`
   - `request-pull.txt`
   - `request-pull-warning.txt`
   - `publish.bundle`
   - `bundle-verify.txt`
5. 证明远端 baseline clone 也能产出 publish packet

## 关键边界

### 1. 仍然只在 baseline clone 内执行

- baseline clone：`/home/mainuser/metasheet2-git-baseline`
- deploy dir：`/home/mainuser/metasheet2`

publish 只进入 baseline clone，不进入 deploy dir。

### 2. remote publish 证明的是可交付，不是已 push GitHub

远端 `request-pull` 也可能因为 landed branch 尚未 push GitHub 而退化到本地 fallback preview。

这不是失败，而是当前阶段的真实状态，必须通过：

- `requestPullRemoteReady`
- `requestPullMode`
- `requestPullWarning`

显式输出。

## CLI

- `pnpm verify:remote-git-slice-publish:directory-migration-baseline`
- `pnpm ops:publish-remote-git-slice:directory-migration-baseline`

## 预期收益

远端链路推进为：

1. bootstrap
2. materialize
3. promote
4. handoff
5. replay
6. attest
7. submit
8. land
9. publish

也就是：远端正式 baseline clone 现在不仅能 landed，还能直接形成正式交付包。
