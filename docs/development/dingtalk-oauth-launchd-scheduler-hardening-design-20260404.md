# DingTalk OAuth Launchd Scheduler Hardening Design

日期：2026-04-04

## 背景

现有本机调度链路中：

- `stability` 使用 `StartInterval=7200`，自动执行正常
- `drill` / `summary` 仅依赖 `StartCalendarInterval`

实际观察表明，`drill` / `summary` 没有稳定在预定时间后自动补跑；一旦机器在定时点睡眠、错过窗口或 launchd 未在精确时刻触发，就只能依赖人工补跑。

## 目标

把 `drill` / `summary` 从“精确时刻触发”改成“精确时刻优先 + 错过后补跑”，并保证：

- 每天最多执行一次
- `summary` 必须等待当天 `drill` 成功后再执行
- 保留现有日志与 `index.jsonl` 结构
- 不把轮询噪声写进索引

## 方案

新增：

- `scripts/ops/dingtalk-oauth-schedule-window.sh`

核心策略：

1. `drill` / `summary` LaunchAgent 同时配置：
   - `StartCalendarInterval`
   - `StartInterval=600`
   - `RunAtLoad=true`
2. LaunchAgent 不直接调用 `schedule-run.sh`，而是先调用 `schedule-window.sh`
3. `schedule-window.sh` 读取：
   - 当前本地时间
   - `index.jsonl` 中当天是否已经有成功的 `drill` / `summary`
4. 判定规则：
   - 未到窗口：`skip`
   - 当天已成功执行过同类任务：`skip`
   - `summary` 在当天 `drill` 尚未成功前：`skip`
   - 其他情况：执行真实 `schedule-run.sh`

## 为什么这样做

相对只保留 `StartCalendarInterval`：

- 即使错过 `20:00 / 20:05`，下一个 `StartInterval` 周期也能自动补跑
- 机器重启或重新安装后，`RunAtLoad=true` 可在窗口已打开时立即补一次
- 由于“是否今天已经成功跑过”由 `index.jsonl` 反查，手工补跑与自动补跑不会互相打架

## 非目标

- 不把 `drill` 频率提高到多次/天
- 不改变 Slack 告警内容
- 不改变 GitHub lite recording

