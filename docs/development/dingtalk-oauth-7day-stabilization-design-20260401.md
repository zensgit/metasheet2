# DingTalk OAuth 7-Day Stabilization Design

日期：2026-04-01

## 目标

把当前已完成的 DingTalk OAuth、Redis state、Alertmanager 和 Slack 通知链，从“已部署”推进到“已进入稳定观察窗口”。

## 方案

### 1. 固定日检入口

新增：

- `scripts/ops/dingtalk-oauth-stability-check.sh`

职责：

- 汇总 backend health
- 汇总当前外部 webhook 配置状态
- 汇总 DingTalk OAuth metrics 样本
- 汇总 Alertmanager 最近窗口内的错误计数
- 汇总 bridge `/notify` 与 resolved 事件计数

### 2. 固定观察模板

新增：

- `docs/deployment/dingtalk-oauth-7day-stabilization-checklist-20260401.md`

这份模板把 7 天窗口内每日必做动作固定为：

- 机器侧日检
- 正式 drill
- Slack 频道人工核对
- 第二操作者演练

### 3. 建立 Day 0 基线

新增：

- `docs/deployment/dingtalk-oauth-7day-stabilization-day0-20260401.md`

把当前已通过的 Day 0 状态记录下来，后续 Day 1 到 Day 6 只需沿同一结构追加。

## 非目标

- 不引入新的监控平台
- 不在本轮增加新的告警规则
- 不把 Slack 人工核对自动化成 CI 门禁
