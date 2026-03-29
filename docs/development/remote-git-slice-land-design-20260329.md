# Remote Git Slice Land Design

日期：2026-03-29

## 背景

远端 baseline clone 已能完成：

- materialize
- promote
- handoff
- replay
- attest
- submit

但还缺最后一层：把远端 `submit` 结果真正落成一条 remote landed branch。

## 目标

新增：

- `scripts/ops/land-remote-git-slice.sh`

职责：

1. bootstrap 远端 baseline clone
2. 上传 remote submit manifest
3. 在远端 baseline clone 中运行 `git-slice-land`
4. 回收 landed report 与 artifacts
5. 证明远端 baseline clone 也能独立产出 clean landed branch

## 关键边界

### 1. 仍然只在 baseline clone 内执行

- baseline clone：`/home/mainuser/metasheet2-git-baseline`
- deploy dir：`/home/mainuser/metasheet2`

`land` 只进入 baseline clone，不进入 deploy dir。

### 2. remote land 的目标不是发布现网

它证明的是：

- 远端正式 Git baseline clone 已能生成 landed branch
- landed branch 本身是 clean 的 Git 收口候选分支

并不是直接替代部署流程。

## CLI

- `pnpm verify:remote-git-slice-land:directory-migration-baseline`
- `pnpm ops:land-remote-git-slice:directory-migration-baseline`

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

也就是：远端现在不仅能证明语义等价，还能把这条 slice 真正落成 clean landed branch。 
