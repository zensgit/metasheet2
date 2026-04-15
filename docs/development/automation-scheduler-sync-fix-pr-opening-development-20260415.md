# Automation Scheduler Sync Fix PR Opening

日期：2026-04-15

## 目标

把 `codex/automation-scheduler-sync-fix-20260415` 从本地 follow-up 修复正式开成可审 PR，并把对 Claude Phase 1 结论的审阅结果落库。

## 背景结论

对 Claude 的 `Phase 1 closure` 说法，我的判断是：

- `#878` 基本成立，Redis store 可插拔方向没有明显问题
- `#879` 的“已完成”表述过满
  - PR 已合并
  - 但合并当时并不是全绿
  - `test (18.x)` 失败
  - `test (20.x)` 被取消

更关键的是，`#879` 留下了一个运行时洞：

- `packages/core-backend/src/routes/univer-meta.ts`
  的 automation CRUD 直接写 `kyselyDb`
- 没有走 `AutomationService.createRule/updateRule/deleteRule`
- 所以不会触发 scheduler 的 `register/unregister`

这意味着：

- 新建或更新 `schedule.cron` / `schedule.interval` 规则后，不会立即进内存调度器
- 删除 schedule 规则后，旧任务可能继续跑到服务重启

## 本轮动作

### 1. 复核 fix 分支状态

- branch: `codex/automation-scheduler-sync-fix-20260415`
- head: `b79cc3f2e`
- 远端分支已存在且已同步

### 2. 复核 Claude Code CLI

在本 worktree 下执行：

```bash
claude auth status
claude -p "Return exactly: CLAUDE_CLI_OK"
claude -p "Review the automation scheduler sync fix on the current branch. Reply with exactly NO_BLOCKERS or one short blocker sentence."
```

结果：

- 当前 worktree 已登录
- CLI 可执行
- 窄范围 review 返回 `NO_BLOCKERS`

### 3. 创建正式 PR

已创建：

- PR `#880`
- 标题：`fix(multitable): sync automation scheduler on CRUD`

PR body 明确说明了：

- 这是一条 `#879` 的 follow-up
- 目标是恢复 scheduler 与 CRUD 的一致性
- 同时修复被 `#879` 打断的 `multitable-automation-service` 单测保护网

## 当前结论

这条 follow-up 现在已经从“本地修补”变成“可 review 的正式 PR”。  
对外表述上，最准确的说法不是“Claude 总结错了”，而是：

- Claude 的 Phase 1 总体方向可参考
- 但 `#879` 的收口质量被高估了
- `#880` 是必须补的一条 correctness fix
