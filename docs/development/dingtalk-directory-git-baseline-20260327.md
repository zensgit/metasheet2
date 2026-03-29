# DingTalk Directory Git Baseline Status

日期：2026-03-27  
更新：2026-03-29

## 当前事实

本地执行：

```bash
git status --short --branch
node scripts/ops/git-baseline-report.mjs --json
```

结果显示：

- 当前分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- 相对远端：`ahead 3, behind 4`
- 当前工作树：`dirty`
- 基线脚本统计：`changedFileCount=370`、`modifiedTrackedCount=91`、`untrackedCount=279`

补充复核：

- 已重新执行 `git fetch origin --prune`
- upstream 仍是 `origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- 本地 `HEAD` 仍是 `df2c43560110d4d0ad3d5582ad878f5386bae3c1`

这意味着：

- 当前代码不能宣称“已同步到 GitHub”
- 当前现网部署也不能宣称“服务器就是 Git 基线”

## 风险判断

### 1. 不能把服务器目录当源码基线

服务器目录已经承载多轮现网修补和部署动作，不能作为：

- 合并基线
- 发布基线
- 回滚基线

### 2. 不能把当前本地工作树直接当可提交主线

当前工作树同时混有：

- 钉钉目录与 IAM 相关改动
- attendance / plugin / workflow / openapi / docs 等大量其他改动
- 多个未跟踪文件和历史遗留文件

这会导致：

- 难以准确切分提交
- 难以证明“哪些改动真的构成现网版本”
- 后续再做多维表或其他大改时容易覆盖现网能力

## 本轮建议基线策略

### 建议 1

先把“目录同步 + 钉钉登录 + 服务端模板中心 + 告警 + migration 基线修复”单独整理成可追溯提交序列。

本轮已新增切片文档：

- `docs/development/directory-migration-baseline-git-slice-20260328.md`

用于把 migration 基线修复从当前 `370` 个 dirty 变更中单独切出来。
现在该切片还继续推进到了：

- bundle commit groups
- safe apply 预演
- staged patch 与 apply manifest
- 临时 worktree materialize
- 正式 branch / commit / manifest / patch 物化
- 远端 baseline clone materialize
- promoted branch clean replay
- handoff bundle / patch series / README / commit summary
- replay fresh-repo 消费与 patch 一致性校验
- remote replay fresh-repo 消费与 patch 一致性校验
- attest 多因子语义等价证明
- remote attest 多因子语义等价证明
- submit 最终交接包（land 输入）
- remote submit 最终交接包（remote land 输入）
- land clean push-candidate 分支
- remote land clean push-candidate 分支
- publish 交付包（bundle / request-pull / commands / summary）
- remote publish 交付包（remote publish bundle / request-pull / commands / summary）

### 建议 2

对 `142.171.239.56` 的现网版本，额外保存：

- 部署时间
- 镜像/静态资源版本
- 关键验证命令
- 对应文档路径

补充状态：

- `packages/core-backend` 宿主机 ownership 已修成 `mainuser:mainuser`
- 关键 migration / audit / 文档文件已同步回宿主机源码目录
- `mainuser@142.171.239.56` 已恢复为可用 SSH 公钥登录
- 宿主机非交互 `node / pnpm / corepack` 已恢复
- 远端旁路正式 Git 基线目录已建立：
  - `/home/mainuser/metasheet2-git-baseline`
  - 当前分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
  - 当前 `HEAD`：`86d709e0247125d91753e85caaa07e0db892091d`
  - `dirty=false`
- 现网部署目录 `/home/mainuser/metasheet2` 仍然不是 Git 仓库
- 但这仍然不等于 GitHub 已同步，只是把现网宿主机从“旧源码副本”修回“关键路径一致”

### 建议 3

在真正合并到 GitHub 前，不要把“现网正在跑”和“GitHub 已同步”混为一谈。

## 本轮新增抓手

为了让后续 GitHub 收口和远端迁移修复不再只靠人工记忆，本轮额外补了：

- `packages/core-backend` 的 `db:list`
- `packages/core-backend` 的 `db:audit`
- 根脚本 `verify:git-baseline`
- `scripts/ops/git-baseline-report.mjs`
- `scripts/ops/git-slice-report.mjs`
- `scripts/ops/git-slice-sync-plan.mjs`
- `scripts/ops/git-slice-bundle.mjs`
- `scripts/ops/git-slice-apply.mjs`
- `scripts/ops/git-slice-materialize.mjs`
- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/git-slice-replay.mjs`
- `scripts/ops/git-slice-attest.mjs`
- `scripts/ops/git-slice-submit.mjs`
- `scripts/ops/git-slice-land.mjs`
- `scripts/ops/git-slice-promote.mjs`
- `scripts/ops/materialize-remote-git-slice.sh`
- `scripts/ops/promote-remote-git-slice.sh`
- `scripts/ops/handoff-remote-git-slice.sh`
- `scripts/ops/replay-remote-git-slice.sh`
- `scripts/ops/attest-remote-git-slice.sh`
- `scripts/ops/submit-remote-git-slice.sh`
- `scripts/ops/land-remote-git-slice.sh`
- 根脚本 `verify:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-sync:directory-migration-baseline`
- 根脚本 `export:git-slice:directory-migration-baseline:patch`
- 根脚本 `verify:git-slice-bundle:directory-migration-baseline`
- 根脚本 `print:git-slice-bundle:directory-migration-baseline:stage`
- 根脚本 `export:git-slice-bundle:directory-migration-baseline`
- 根脚本 `verify:git-slice-apply:directory-migration-baseline`
- 根脚本 `print:git-slice-apply:directory-migration-baseline:groups`
- 根脚本 `export:git-slice-apply:directory-migration-baseline`
- 根脚本 `verify:git-slice-materialize:directory-migration-baseline`
- 根脚本 `print:git-slice-materialize:directory-migration-baseline:groups`
- 根脚本 `materialize:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-handoff:directory-migration-baseline`
- 根脚本 `handoff:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-replay:directory-migration-baseline`
- 根脚本 `replay:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-attest:directory-migration-baseline`
- 根脚本 `attest:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-submit:directory-migration-baseline`
- 根脚本 `submit:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-land:directory-migration-baseline`
- 根脚本 `land:git-slice:directory-migration-baseline`
- 根脚本 `verify:git-slice-publish:directory-migration-baseline`
- 根脚本 `publish:git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-materialize:directory-migration-baseline`
- 根脚本 `ops:materialize-remote-git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-handoff:directory-migration-baseline`
- 根脚本 `ops:handoff-remote-git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-replay:directory-migration-baseline`
- 根脚本 `ops:replay-remote-git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-attest:directory-migration-baseline`
- 根脚本 `ops:attest-remote-git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-submit:directory-migration-baseline`
- 根脚本 `ops:submit-remote-git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-land:directory-migration-baseline`
- 根脚本 `ops:land-remote-git-slice:directory-migration-baseline`
- 根脚本 `verify:remote-git-slice-publish:directory-migration-baseline`
- 根脚本 `ops:publish-remote-git-slice:directory-migration-baseline`
- `scripts/ops/install-user-node-runtime.sh`
- 目录/IAM migration 审计与缺表检查

额外收口：

- `scripts/ops/git-baseline-report.mjs`、`scripts/ops/git-slice-report.mjs` 和 `scripts/ops/git-slice-sync-plan.mjs` 现在在非 Git 目录会返回结构化 `NOT_A_GIT_REPOSITORY`，不再直接抛 Node stack trace
- `git-slice-sync-plan` 现在能明确区分：
  - 当前切片可否先独立 stage
  - 当前分支是否仍然不能宣称“已同步 GitHub”
- `git-slice-bundle` 现在能明确输出：
  - 当前 slice 的正式 commit groups
  - 每组 stage command
  - 每组 patch 和 manifest 导出
- `git-slice-apply` 现在能明确输出：
  - 每个 commit group 的 alternate-index stage 预演
  - 危险的 current-index 写入门禁
  - staged patch 与 apply manifest
  - 缺失文件时的结构化 `MISSING_GROUP_FILES`
- `git-slice-materialize` 现在能明确输出：
  - 基于 upstream 的临时 worktree 真实提交链
  - `verify` 模式的 branch/worktree 自动清理
  - 持久化 materialize branch 的 commit 序列
  - 并行 verify 下的稳定 branch 命名与锁竞争收口
- `git-slice-promote` 现在能明确输出：
  - 以 materialized branch 或 manifest 为来源的 clean replay
  - `sourceCommitSha -> promotedCommitSha` 的正式映射
  - 本地 promote verify / 正式 promote 的 manifest 与 patch
  - 后续 Git 提交交接更接近最终 PR 形态的 clean branch
- `git-slice-handoff` 现在能明确输出：
  - 以 promote manifest 为来源的最终交接包
  - `bundle + patch series + README + commit summary`
  - full-slice source 与 group-source 的显式边界校验
  - 本地 handoff verify / 正式 handoff 的固定归档目录
- `git-slice-replay` 现在能明确输出：
  - 以 handoff manifest 为来源的 fresh-repo 重放结果
  - `replayedHead == sourceHead` 的显式校验
  - regenerated patch 与 handoff patch 的 SHA 一致性校验
  - 本地 replay verify / 正式 replay 的固定归档目录
- `materialize-remote-git-slice` 现在能明确输出：
  - 远端 baseline clone 上的 verify / materialize 结果
  - 本地回收的 `report + manifest + patch`
  - 远端 materialized branch 的存在性确认
  - 远端 baseline 主工作树仍 clean 的边界验证
- `promote-remote-git-slice` 现在能明确输出：
  - 远端 baseline clone 上的 verify / promote 结果
  - 默认从 remote materialize report 自动解析 `sourceBranch`
  - 远端 promoted branch 的存在性确认
  - 本地回收的 remote promote `report + manifest + patch`
- `handoff-remote-git-slice` 现在能明确输出：
  - 默认从 remote promote report 自动解析 `sourceBranch`
  - 远端 baseline clone 上的 verify / handoff 结果
  - 本地回收的 remote handoff `report + bundle + patches + README + summary`
- `replay-remote-git-slice` 现在能明确输出：
  - 默认从 remote handoff report 自动解析 manifest / bundle / ref
  - 远端 baseline clone 旁路 fresh repo 上的 verify / replay 结果
  - 本地回收的 remote replay `report + regenerated patches + README + replay summary`
- `mainuser@142.171.239.56` 已补齐用户态 `node / pnpm / corepack`
- `scripts/ops/bootstrap-remote-git-baseline.sh`
- `scripts/ops/verify-remote-git-baseline.sh`
- 根脚本 `ops:bootstrap-remote-git-baseline`
- 根脚本 `verify:remote-git-baseline`

这不会直接把当前工作树变成 GitHub 基线，但能先把“现网和本地到底差在哪里”变成正式输出。

## 本轮关联交付

与本基线状态直接相关的能力包括：

- 钉钉目录同步
- 钉钉扫码登录绑定
- 未开户登录待审核
- attendance 模式管理员目录入口
- 组合式离职策略
- 批量失败处理与模板中心
- 服务端模板中心、治理报表、计划同步告警

## 结论

截至 2026-03-29：

- 当前代码库不是 GitHub 已同步状态
- 当前服务器的现网部署目录不是 Git 基线
- 当前远端宿主机已经有旁路正式 Git 基线目录，但 GitHub 基线仍未收口
- 当前 Git 工具链已经推进到：
  - report
  - sync plan
  - bundle
  - apply
  - materialize
  - promote
  - handoff
  - replay
  - attest
  - submit
  - remote materialize
  - remote promote
  - remote handoff
  - remote replay
  - remote attest
  - remote submit
  - land
  - remote land
  - publish
  - remote publish
- 本轮已把这一事实文档化，后续应按功能域拆分成明确分支和提交序列，再做 GitHub 收口
