# Week 1 协作语义任务单

Date: 2026-04-13

## 1. 目标

Week 1 只解决一件事：

把 multitable comment 协作链路先收成一套稳定语义，避免后续 `Week 2` 的交互补完继续踩在漂移的 contract 上。

本周不追求：

- 大改评论 UI 视觉
- 新增复杂协作功能
- 进入公开表单、token、automation 等后续主题

## 2. 本周统一约定

comments canonical 语义固定为：

- `containerId`
- `targetId`
- `targetFieldId`

兼容保留旧字段：

- `spreadsheetId`
- `rowId`
- `fieldId`

原则：

1. 后端输出同时带 canonical 和 legacy 字段
2. 前端消费优先吃 canonical，legacy 只作兼容 fallback
3. `Week 2` 起不再继续讨论字段命名

## 3. 角色分工

### Codex

负责：

- 前端消费层统一
- realtime / presence / inbox / drawer 的语义对齐
- 前端测试和最终整合

不负责：

- 发明新的后端 contract
- 在本周内大改评论视觉样式

### Claude

负责：

- `contracts/runtime`
- comments routes / service / integration tests
- API 输入输出兼容层
- 后端 PR 草案、验证文档

不负责：

- 前端交互手感和视觉打磨

### 你

负责：

- 范围拍板
- 决定 canonical 命名是否冻结
- 审核 PR 拆分是否干净

## 4. 分支与 worktree

建议本周只保留这 5 条：

- `codex/collab-semantics-baseline-202604`
- `codex/collab-semantics-contracts-202604`
- `codex/collab-semantics-runtime-202604`
- `codex/collab-semantics-frontend-202604`
- `codex/collab-semantics-integration-202604`

建议目录：

- `../metasheet2-collab-baseline`
- `../metasheet2-collab-contracts`
- `../metasheet2-collab-runtime`
- `../metasheet2-collab-frontend`
- `../metasheet2-collab-integration`

## 5. 文件 owner

### Claude owner

- `packages/core-backend/src/di/identifiers.ts`
- `packages/core-backend/src/routes/comments.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/tests/integration/comments.api.test.ts`

### Codex owner

- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/realtime/comments-realtime.ts`
- `apps/web/src/multitable/composables/useMultitableCommentInboxSummary.ts`
- `apps/web/src/multitable/composables/useMultitableCommentPresence.ts`
- `apps/web/src/multitable/composables/useMultitableCommentRealtime.ts`
- `apps/web/src/multitable/components/MetaCommentsDrawer.vue`
- `apps/web/src/views/MultitableCommentInboxView.vue`
- `apps/web/tests/multitable-client.spec.ts`
- `apps/web/tests/multitable-comment-inbox-view.spec.ts`
- `apps/web/tests/multitable-comment-inbox.spec.ts`
- `apps/web/tests/multitable-comment-presence.spec.ts`
- `apps/web/tests/multitable-comment-realtime.spec.ts`
- `apps/web/tests/multitable-comments-drawer.spec.ts`
- `apps/web/tests/multitable-mention-realtime.spec.ts`

### 共享边界

以下内容本周不要继续扩：

- `MetaCommentComposer.vue` 的视觉重做
- `MultitableWorkbench.vue` 的大范围布局调整
- 非 comments 领域的 multitable 模型

## 6. 第一批提交建议

### 提交 1：Claude

建议提交信息：

- `feat(comments): add canonical container/target aliases`

范围：

- routes 接受 canonical / legacy 双输入
- service 输出 canonical / legacy 双字段
- realtime payload 统一带 canonical 字段
- `comments.api` 集成测试覆盖兼容性

### 提交 2：Codex

建议提交信息：

- `feat(multitable): normalize comment canonical payload consumption`

范围：

- `client.ts` 提供统一 normalize 入口
- realtime / inbox summary / presence / drawer 走同一套 comment identity 语义
- inbox open 路径优先使用 canonical 字段
- 补前端定向测试

### 提交 3：Integration

建议提交信息：

- `test(multitable): cover comment canonical compatibility`

范围：

- 汇总前后端验证命令
- 如果需要，补最小验证文档

## 7. PR 拆分

### PR A: Backend Contract + Runtime

Owner：

- Claude

标题建议：

- `feat(comments): normalize canonical comment payloads`

PR 内容：

- canonical comment identity
- 双字段兼容输入输出
- realtime / summary / inbox 一致语义
- integration tests

### PR B: Frontend Comment Semantics Alignment

Owner：

- Codex

标题建议：

- `feat(multitable): align comment consumers to canonical payloads`

PR 内容：

- comment normalize helpers
- realtime / presence / inbox / drawer 统一消费层
- 定向前端测试

### PR C: Integration Notes

Owner：

- Claude 或 Codex

标题建议：

- `docs: record week1 comment semantics verification`

说明：

- 如果 PR A 和 PR B 的描述已经足够，可以不单独开 C

## 8. 验收命令

### 已跑过

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-comment-realtime.spec.ts tests/multitable-comment-inbox-view.spec.ts tests/multitable-comment-inbox.spec.ts --watch=false`
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-comment-presence.spec.ts tests/multitable-comments-drawer.spec.ts tests/multitable-mention-realtime.spec.ts --watch=false`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`

### 仍需补跑

- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/comments.api.test.ts --reporter=dot`

说明：

- 当前主工作区复跑该命令会因本地缺少数据库 `chouhua` 而失败
- 补齐本地测试库后需要重新执行一次，作为 Week 1 最后验收

## 9. 你需要拍板的点

1. canonical 命名是否就此冻结为 `containerId / targetId / targetFieldId`
2. Week 1 是否只合 protocol/consumption 收口，不混入视觉交互
3. `comments.api` 的本地数据库环境由谁补齐

## 10. 交接规则

1. Claude 完成 backend PR 草案后，不再继续扩前端体验
2. Codex 完成 frontend 消费层统一后，不再改后端 contract
3. Week 1 合完之前，不开 Week 2 的大交互分支

## 11. 当前直接动作

建议立刻执行：

1. 以本任务单为准冻结 Week 1 范围
2. 整理当前已改文件为 PR A 和 PR B
3. 补本地 backend integration 数据库
4. 跑完 `comments.api.test.ts`
5. 合并 Week 1 后再开 `Week 2: collab-ux`
