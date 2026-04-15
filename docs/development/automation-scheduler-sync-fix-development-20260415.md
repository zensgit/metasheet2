# Automation Scheduler Sync Fix Development

日期：2026-04-15

## 背景

在审阅 Claude 的 Phase 1 收口说明时，我核到了一个真实风险：

- `#878` 已合并且 checks 全绿，基本可以接受
- `#879` 虽已合并，但不是“全绿完成”
  - `test (18.x)` 失败
  - `test (20.x)` 被取消
  - 失败集中在 `tests/unit/multitable-automation-service.test.ts`

进一步读代码后确认，`#879` 还有一个更关键的运行时洞：

- `packages/core-backend/src/routes/univer-meta.ts`
  的 automation CRUD 仍然直接写 `kyselyDb`
- 没有走 `AutomationService.createRule/updateRule/deleteRule`
- 因此不会触发：
  - `registerSchedule()`
  - `unregisterSchedule()`

结果是：
- 新建/更新定时规则后，调度器不会立即生效
- 删除定时规则后，旧 schedule 仍可能继续跑到服务重启

## 本轮修复

### 1. 给 AutomationService 增加共享实例接线

文件：
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/index.ts`

新增：
- `setAutomationServiceInstance()`
- `getAutomationServiceInstance()`

接线：
- 服务启动后把真实 `AutomationService` 实例注册成共享实例
- 服务 shutdown 时清空共享实例

### 2. 让 univer-meta automation CRUD 改走 AutomationService

文件：
- `packages/core-backend/src/routes/univer-meta.ts`

改动：
- `GET /sheets/:sheetId/automations` → `automationService.listRules()`
- `POST /sheets/:sheetId/automations` → `automationService.createRule()`
- `PATCH /sheets/:sheetId/automations/:ruleId` → `automationService.updateRule()`
- `DELETE /sheets/:sheetId/automations/:ruleId` → `automationService.deleteRule()`

效果：
- 调度型规则的 register/unregister 语义重新跟 CRUD 对齐
- 如果 automation service 处于 degraded/unavailable，路由显式返回 `503 SERVICE_UNAVAILABLE`

### 3. 修复 #879 打断的旧单测

文件：
- `packages/core-backend/tests/unit/multitable-automation-service.test.ts`

原因：
- 这组旧测试仍用“raw query fn = db”的旧构造方式
- `#879` 后 `AutomationService` 需要 `Kysely db + queryFn`

处理：
- 补了最小 `Kysely-like` mock
- 保留原有 queryFn 断言，用于 action 执行语义验证
- 修正递归 guard 场景里误传空规则集的测试输入

## 对 Claude Phase 1 说法的审阅结论

我认可的部分：
- `#878` 限流器 → Redis store 的方向和合并状态基本成立
- platform shell wave1 已在 `main`
- 钉钉身份层已合入 `main`

我不认可直接照抄的部分：
- “Phase 1 全部完成” 这个说法过满
- `#879` 不能写成“91 tests + 完成”然后直接略过 CI 失败
- 至少应该补一句：
  - 已合并，但当时带着 `multitable-automation-service` 回归失败
  - 本轮 follow-up 专门补 scheduler sync 和这组保护网

## 当前分支

- worktree: `/tmp/metasheet2-automation-scheduler-fix`
- branch: `codex/automation-scheduler-sync-fix-20260415`
