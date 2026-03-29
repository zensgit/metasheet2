# Remote Git Slice Deliver Design

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
- publish

但还缺真正把 landed branch 送到目标远端这一层。

## 目标

新增：

- `scripts/ops/deliver-remote-git-slice.sh`

职责：

1. bootstrap 远端 baseline clone
2. 上传 remote publish manifest
3. 在远端 baseline clone 中运行 `git-slice-deliver`
4. 回收：
   - `report.json`
   - `manifest.json`
   - `deliver-summary.md`
   - `README.md`
   - `deliver-commands.sh`
   - `remote-head.txt`
   - `request-pull-remote.txt`
   - `compare-url.txt`
   - `commit-summary.md`
5. 证明远端 baseline clone 也能独立完成 deliver

## 关键边界

### 1. 仍然只在 baseline clone 内执行

- baseline clone：`/home/mainuser/metasheet2-git-baseline`
- deploy dir：`/home/mainuser/metasheet2`

deliver 只进入 baseline clone，不进入 deploy dir。

### 2. verify 仍然不触碰真实 GitHub

远端 `--verify` 仍然只对临时 bare repo 做 push 验真。

### 3. 正式 deliver 允许真正推送目标 repo URL

远端正式 baseline clone 已经是 clean Git clone，因此它是更合格的远端交付源，而不是 deploy dir。

## CLI

- `pnpm verify:remote-git-slice-deliver:directory-migration-baseline`
- `pnpm ops:deliver-remote-git-slice:directory-migration-baseline`

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
10. deliver

也就是：远端正式 baseline clone 现在不仅能生成 publish packet，还能把 landed branch 真正交付到目标远端。
