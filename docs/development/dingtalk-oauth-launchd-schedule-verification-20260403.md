# DingTalk OAuth Launchd Schedule Verification

日期：2026-04-03

## 范围

验证本机 launchd 定时调度已正确安装，并确认它能把 DingTalk OAuth stability / drill 结果落到本地日志。

推荐安装路径：

- `~/.codex/memories/metasheet2-onprem-schedule`

## 实际执行

### 1. 依赖检查

- `command -v pnpm`
- `command -v node`
- `command -v launchctl`

结果：均通过。

### 2. 安装前状态

- `~/Library/LaunchAgents` 中不存在既有 DingTalk OAuth schedule plist
- `~/.codex/memories/metasheet2-onprem-schedule` 初始不存在

### 3. 安装

执行：

```bash
pnpm ops:install-dingtalk-oauth-schedule
```

默认安装：

- stability: 每 `7200` 秒
- drill: 每天 `20:00`
- summary: 每天 `20:05`

实际结果：

- 生成 `~/Library/LaunchAgents/com.zensgit.metasheet.dingtalk-oauth-stability.plist`
- 生成 `~/Library/LaunchAgents/com.zensgit.metasheet.dingtalk-oauth-drill.plist`
- 生成 `~/Library/LaunchAgents/com.zensgit.metasheet.dingtalk-oauth-summary.plist`
- 日志根目录为 `~/Library/Logs/metasheet2/dingtalk-oauth`
- 本轮实际安装使用的持久 worktree：
  - `~/.codex/memories/metasheet2-onprem-schedule`

### 4. 状态检查

执行：

```bash
pnpm ops:print-dingtalk-oauth-schedule-status
```

预期：

- 两个 plist 存在
- 两个 launchd label 已加载
- `~/Library/Logs/metasheet2/dingtalk-oauth/index.jsonl` 出现新记录

实际结果：

- `stability_plist=present`
- `drill_plist=present`
- `summary_plist=present`
- `launchctl print gui/$(id -u)/com.zensgit.metasheet.dingtalk-oauth-stability`
  - `state = not running`
  - `runs = 1`
  - `last exit code = 0`
- `launchctl print gui/$(id -u)/com.zensgit.metasheet.dingtalk-oauth-drill`
  - `state = not running`
  - `runs = 0`
  - 已注册 `Hour=20 / Minute=0`
- `launchctl print gui/$(id -u)/com.zensgit.metasheet.dingtalk-oauth-summary`
  - `state = not running`
  - `runs = 0`
  - 已注册 `Hour=20 / Minute=5`
- `launchctl print gui/$(id -u)/com.zensgit.metasheet.dingtalk-oauth-stability`
  - 本轮实际安装后为 `state = running`
  - `runs = 1`
  - `last exit code = (never exited)`

说明：

- `stability` agent 安装时因 `RunAtLoad=true` 自动执行了一次，成功退出
- `drill` agent 处于等待今晚 `20:00` 触发状态
- `summary` agent 处于等待今晚 `20:05` 触发状态

### 5. 手工触发一次 stability 包装器

执行：

```bash
bash scripts/ops/dingtalk-oauth-schedule-run.sh stability
```

预期：

- 生成一条 `stability-*.log`
- `index.jsonl` 追加一条 `kind=stability`

实际结果：

- 手工执行生成：
  - `~/Library/Logs/metasheet2/dingtalk-oauth/runs/stability-20260403T010601Z.log`
- 安装器加载后再次自动执行生成：
  - `~/Library/Logs/metasheet2/dingtalk-oauth/runs/stability-20260403T010749Z.log`
- `index.jsonl` 中两条记录都为：
  - `exitCode=0`
  - `healthy=true`
- 后续从持久 worktree 重装 launchd 后，最新状态仍保持 `healthy=true`

### 6. 手工触发一次 summary 包装器

执行：

```bash
pnpm ops:dingtalk-oauth-schedule-summary
```

预期：

- 生成一条 `summary-*.log`
- 生成一组 `summaries/summary-*.json` 与 `summaries/summary-*.md`
- `index.jsonl` 追加一条 `kind=summary`

实际结果：

- 生成 `~/Library/Logs/metasheet2/dingtalk-oauth/runs/summary-*.log`
- 生成 `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/summary-*.json`
- 生成 `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/summary-*.md`
- `index.jsonl` 追加了 `kind=summary`
- 本轮实际验证的最新文件为：
  - `~/Library/Logs/metasheet2/dingtalk-oauth/runs/summary-20260403T011644Z.log`
  - `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/summary-20260403T011644Z.json`
  - `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/summary-20260403T011644Z.md`
- 记录里包含：
  - `latestStabilityCheckedAt`
  - `latestDrillCheckedAt`
  - `latestDrillId`
  - `healthy`
  - `firingObserved`
  - `resolvedObserved`
- 最新 summary 记录的实际值：
  - `latestStabilityCheckedAt=2026-04-03T01:07:49Z`
  - `latestDrillCheckedAt=2026-04-03T01:14:38Z`
  - `latestDrillId=drill-1775178878`
  - `healthy=true`
  - `firingObserved=true`
  - `resolvedObserved=true`

## 验证结论

这条本机定时观察链路已经生效：

- `stability` 已成功自动运行并落日志
- `drill` 已挂到今晚 `20:00`
- `summary` 已挂到今晚 `20:05`

后续我不能“主动在未来回复”，但脚本会按计划自己执行并记录，之后可以回来读取这些日志做汇总。
