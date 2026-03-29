# Remote Git Slice Handoff Design

日期：2026-03-29

## 背景

远端 `142.171.239.56` 已经具备：

- 正式 baseline clone：`/home/mainuser/metasheet2-git-baseline`
- remote materialize
- remote promote

但还缺一层远端交付：

- 如何在远端 baseline clone 上把 promoted branch 打包成 handoff artifacts
- 如何把 `bundle + patches + manifest + README + summary` 拉回本地归档

## 目标

新增远端包装脚本：

- `scripts/ops/handoff-remote-git-slice.sh`

它需要：

1. 先 bootstrap 远端 baseline clone
2. 默认读取本地 remote promote report
3. 从中解析远端 promoted `sourceBranch`
4. 把 `git-slice-handoff.mjs + git-slices.mjs` 上传到远端临时目录
5. 在远端 baseline clone 中执行 handoff
6. 把 `report + artifacts` 回收回本地

## 非目标

- 不直接把 bundle 推送到远端 GitHub
- 不修改现网部署目录 `/home/mainuser/metasheet2`
- 不替代 remote promote

## 默认来源

默认读取：

- `output/remote-git-slice-promotions/<slice>/promoted/report.json`

从 report 中解析：

- `report.branchName`

这样 remote handoff 不需要人工再传一遍 source branch。

## 远端执行模型

远端包装脚本会：

1. 建立临时工作目录
2. 上传最小 payload
3. 在远端 baseline clone 中运行：
   - `node payload/scripts/ops/git-slice-handoff.mjs ...`
4. 打包 `report.json + artifacts`
5. scp 拉回本地

verify 模式不会删除远端 baseline clone，只会让 handoff 产物落在远端临时目录，再由 wrapper 回收。

## 本地回收输出

本地输出结构：

- `output/remote-git-slice-handoffs/<slice>/verify`
- `output/remote-git-slice-handoffs/<slice>/handoff`

每次运行至少包含：

- `report.json`
- `exit-code`
- `artifacts/manifest.json`
- `artifacts/README.md`
- `artifacts/commit-summary.md`
- `artifacts/<slice>.bundle`
- `artifacts/patches/*.patch`

## 预期收益

这一步完成后，远端 baseline clone 的链路会推进到：

1. bootstrap
2. materialize
3. promote
4. handoff

也就是远端正式 baseline clone 已经不仅能复现 clean branch，还能直接产出最终交接包。
