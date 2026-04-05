# DingTalk OAuth Launchd Scheduler Hardening Verification

日期：2026-04-04

## 范围

验证本机 `launchd` 的 `drill` / `summary` 已从“单纯 calendar trigger”升级为“calendar + interval fallback + once-per-day gate”。

## 实际执行

### 1. 语法检查

执行：

```bash
bash -n scripts/ops/dingtalk-oauth-schedule-window.sh
bash -n scripts/ops/install-dingtalk-oauth-launchd-schedule.sh
bash -n scripts/ops/print-dingtalk-oauth-launchd-schedule-status.sh
```

结果：

- 通过

### 2. 重装 launchd 任务

执行：

```bash
bash scripts/ops/install-dingtalk-oauth-launchd-schedule.sh
```

结果：

- 通过
- 输出包含：
  - `Window interval: 600s`
  - `Drill schedule: 20:00`
  - `Summary schedule: 20:05`

### 3. 窗口门禁模拟

使用临时 `index.jsonl` + mock runner 做 3 类验证：

- `drill` 在窗口已打开时执行
- `summary` 在当天无成功 `drill` 时跳过
- 写入当天成功 `drill` 记录后，`summary` 执行

实际结果：

```text
[dingtalk-oauth-schedule-window] mode=drill action=run reason=window-open
[dingtalk-oauth-schedule-window] mode=summary action=skip reason=waiting-for-drill
[dingtalk-oauth-schedule-window] mode=summary action=run reason=window-open
mock-run:drill
mock-run:summary
```

说明：

- `summary` 不会在当天 `drill` 之前抢跑
- 同一天只会进入一次真实执行路径

### 4. launchd 注册状态

执行：

```bash
launchctl print gui/$(id -u)/com.zensgit.metasheet.dingtalk-oauth-drill
launchctl print gui/$(id -u)/com.zensgit.metasheet.dingtalk-oauth-summary
```

实际结果：

- 两个 agent 都已切到：
  - `program = /bin/bash`
  - `arguments = .../scripts/ops/dingtalk-oauth-schedule-window.sh`
  - `run interval = 600 seconds`
  - `properties = runatload | inferred program`
  - 同时仍保留 `Hour / Minute` calendar descriptor

### 5. 自动恢复验证

执行：

```bash
bash scripts/ops/print-dingtalk-oauth-launchd-schedule-status.sh
```

实际结果已出现新的自动记录：

- `stability`
  - `2026-04-03T17:33:38Z`
  - `2026-04-03T19:33:55Z`
  - `2026-04-03T21:34:12Z`
  - `2026-04-03T23:34:33Z`
  - 均为 `healthy=true`
- 自动 `drill`
  - `2026-04-04T12:00:05Z`
  - `drillId=drill-1775304006`
  - `firingObserved=true`
  - `resolvedObserved=true`
- 自动 `summary`
  - `2026-04-04T12:05:05Z`
  - `latestDrillId=drill-1775304006`
  - `healthy=true`

说明：

- 这证明 `20:00 / 20:05` 的自动链已经恢复，不再只靠人工补跑

## 验证结论

本轮调度硬化成立：

- `drill` / `summary` 具备错过窗口后的自动补跑能力
- `summary` 会等待当天 `drill`
- 自动 `20:00 / 20:05` 轮次已重新观察到真实成功记录

