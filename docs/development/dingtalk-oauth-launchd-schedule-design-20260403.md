# DingTalk OAuth Launchd Schedule Design

日期：2026-04-03

## 目标

把 DingTalk OAuth on-prem 稳定观察从“人工触发”升级成“本机定时执行并落日志”，但不依赖 Codex Desktop 常驻，也不污染用户当前工作分支。

## 范围

新增三类资产：

- 定时运行包装器：`scripts/ops/dingtalk-oauth-schedule-run.sh`
- launchd 安装器：`scripts/ops/install-dingtalk-oauth-launchd-schedule.sh`
- launchd 状态查看：`scripts/ops/print-dingtalk-oauth-launchd-schedule-status.sh`

并为 `package.json` 增加对应入口。

## 调度策略

### 被动检查

- 任务：`stability`
- 命令：`scripts/ops/dingtalk-oauth-stability-check.sh`
- 默认频率：每 `7200` 秒一次
- `RunAtLoad=true`

理由：

- 不刷 Slack
- 可以更快发现容器缺失、webhook 配置漂移或 Alertmanager notify error

### 正式 drill

- 任务：`drill`
- 命令：`JSON_OUTPUT=true scripts/ops/dingtalk-onprem-alert-drill.sh`
- 默认时间：每天 `20:00`

理由：

- 保持告警链真实演练
- 避免把频道刷成高噪声

## 记录策略

不自动改仓库文档，不自动提交。

运行结果统一落到：

- `~/Library/Logs/metasheet2/dingtalk-oauth/runs/*.log`
- `~/Library/Logs/metasheet2/dingtalk-oauth/index.jsonl`

这样做的原因：

- 不污染当前 checkout
- 不会让仓库因为定时任务长期处于 dirty 状态
- 后续需要时可以再从日志回填到正式文档

## 与当前分支隔离

安装时使用独立 worktree 路径，不依赖用户当前正在开发的分支。

这保证：

- 即使主仓库 checkout 到别的分支且工作树 dirty，定时任务仍可运行
- on-prem 观察逻辑固定在 `codex/dingtalk-onprem-rollout-20260330` 这条运维分支上

## 非目标

- 不让 Codex Desktop“自己在未来主动回复”
- 不自动提交每日观察结果到 Git
- 不替代正式人工判断 Slack 频道噪声与误报
