# DingTalk OAuth Launchd Schedule

日期：2026-04-03

## 目标

在本机 macOS 上为 DingTalk OAuth on-prem 观察链安装定时任务：

- 每 2 小时跑一次 stability check
- 每天 20:00 跑一次正式 drill
- 每天 20:05 生成一条 summary 快照

## 安装

在用于 on-prem 观察的 worktree 中执行：

```bash
pnpm ops:install-dingtalk-oauth-schedule
```

推荐使用持久 worktree：

- `~/.codex/memories/metasheet2-onprem-schedule`

默认安装后会生成：

- `~/Library/LaunchAgents/com.zensgit.metasheet.dingtalk-oauth-stability.plist`
- `~/Library/LaunchAgents/com.zensgit.metasheet.dingtalk-oauth-drill.plist`
- `~/Library/LaunchAgents/com.zensgit.metasheet.dingtalk-oauth-summary.plist`

日志目录：

- `~/Library/Logs/metasheet2/dingtalk-oauth/`

## 查看状态

```bash
pnpm ops:print-dingtalk-oauth-schedule-status
```

## 日志

单次运行日志：

- `~/Library/Logs/metasheet2/dingtalk-oauth/runs/stability-*.log`
- `~/Library/Logs/metasheet2/dingtalk-oauth/runs/drill-*.log`
- `~/Library/Logs/metasheet2/dingtalk-oauth/runs/summary-*.log`

索引：

- `~/Library/Logs/metasheet2/dingtalk-oauth/index.jsonl`

汇总快照：

- `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/summary-*.json`
- `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/summary-*.md`

## 调整时间

安装前可通过环境变量覆盖：

```bash
STABILITY_INTERVAL_SECONDS=3600 \
DRILL_HOUR=22 \
DRILL_MINUTE=30 \
SUMMARY_HOUR=22 \
SUMMARY_MINUTE=35 \
pnpm ops:install-dingtalk-oauth-schedule
```

## 说明

这套调度只负责“自动执行并落日志”。我之后仍需要你再次唤起，才能读取这些日志并给出人工总结。
