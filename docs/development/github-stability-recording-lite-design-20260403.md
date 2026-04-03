# GitHub Stability Recording Lite Design

日期：2026-04-03

## 目标

为 DingTalk OAuth on-prem 观察链补一条 GitHub Actions 留档入口，但不接管现有本机 `launchd` 自动化，也不额外触发 Slack drill。

## 范围

新增一条 workflow：

- `.github/workflows/dingtalk-oauth-stability-recording-lite.yml`

并补齐 workflow 索引与验证入口说明。

## 设计原则

### 只做被动记录

这条 workflow 只执行：

- `JSON_OUTPUT=true bash scripts/ops/dingtalk-oauth-stability-check.sh`

不执行：

- `pnpm ops:onprem-alert-drill`

原因：

- GitHub 不重复刷 `#metasheet-alerts`
- 正式告警 drill 仍由本机 `launchd` 在每天 `20:00` 执行

### 不依赖 `pnpm install`

稳定检查脚本本身只依赖：

- `bash`
- `python3`
- `ssh`
- 仓库内现有 `scripts/ops/*.sh`

因此 workflow 只需要：

- checkout
- 还原 deploy SSH key
- 调现有脚本

这样可以把跑时、失败面和外部依赖压到最小。

### 失败时也保留证据

workflow 结构分三层：

1. `continue-on-error` 运行 stability check
2. `always()` 生成 markdown summary 并上传 artifact
3. 最后单独 gate：
   - `stability_rc != 0` 时失败
   - `healthy != true` 时失败

这样即使 SSH/远端出问题，也仍然能在 GitHub Actions 里看到 artifact 和 log tail。

## 产物

workflow 运行后会上传：

- `output/github/dingtalk-oauth-stability/stability.json`
- `output/github/dingtalk-oauth-stability/stability.log`
- `output/github/dingtalk-oauth-stability/summary.md`

artifact retention 设为 `14` 天。

## 触发策略

- `schedule`: `15 */2 * * *`
- `workflow_dispatch`

选择每两小时一次，是为了：

- 与本机 `launchd` 的高频 stability 节奏一致
- 但不把 GitHub 当作主执行面

注意：

- GitHub 的 `schedule` 和 `workflow_dispatch` 都要求 workflow 文件存在于默认分支
- 所以这条 workflow 在 feature branch 上提交后，结构已经就绪，但真正开始自动执行仍依赖后续合入默认分支

## Secrets

复用现有远端 deploy secrets：

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY_B64`

## 非目标

- 不把 GitHub 变成主 drill 执行器
- 不直接写 GitHub Issue/PR 评论
- 不替代本机 `launchd` summary 快照
