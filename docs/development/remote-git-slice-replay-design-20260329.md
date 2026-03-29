# Remote Git Slice Replay Design

日期：2026-03-29

## 背景

远端 baseline clone 目前已经能做：

- materialize
- promote
- handoff

但还没有证明远端能直接消费 handoff 产物并重放出同一条提交链。

## 目标

新增远端包装脚本：

- `scripts/ops/replay-remote-git-slice.sh`

职责：

1. bootstrap 远端 baseline clone
2. 默认读取本地 remote handoff manifest
3. 把 handoff artifacts + replay 脚本上传到远端临时目录
4. 在远端 baseline clone 旁路 fresh repo 中执行 replay
5. 拉回 `report + artifacts`

## 非目标

- 不修改现网部署目录
- 不替代 remote handoff
- 不在远端 replay 阶段创建 PR 或 push

## 默认来源

默认读取：

- `output/remote-git-slice-handoffs/<slice>/handoff/artifacts/manifest.json`

并把整个 handoff artifacts 目录上传到远端，保证 replay 用的是同一批交付物，而不是远端另行生成的副本。

manifest 中的：

- `bundleFileName`
- `bundleRefName`

也会一并保留并传递到远端 replay，避免远端重新猜 bundle 名称或 ref 名称。

## 稳定性要求

远端 replay 不是只校验 `bundle` 能否 fetch，还要校验：

- `replayedHead == sourceHead`
- replay 后重新导出的 patch SHA 与 handoff 完全一致

为避免不同 Git 环境下 `index` 行缩写宽度不同导致的 patch SHA 漂移，replay 依赖 handoff / replay 两侧统一使用：

- `git format-patch --full-index --binary --abbrev=40`

## 预期收益

远端 baseline clone 链路推进成：

1. bootstrap
2. materialize
3. promote
4. handoff
5. replay

也就是远端不只是能生产交接包，还能证明交接包能被独立消费。
