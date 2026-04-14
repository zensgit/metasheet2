# MetaSheet 协作语义统一 Week 1 + Week 2 开发验证文档

Date: 2026-04-14

## 1. 目标回顾

| 周次 | 主题 | 状态 |
|---|---|---|
| Week 1 | 协作语义统一 — contracts/runtime/integration | ✅ 全部合并到 main |
| Week 2 | 协作体验补完 — runtime/frontend/integration | ✅ frontend 已合并；runtime/integration 进行中 |

---

## 2. Week 1 交付内容

### 2.1 contracts lane (PR #856)

**文件变更：**
- `packages/core-backend/src/di/identifiers.ts`
  - 新增 `CommentUnreadSummary` 类型：`{ unreadCount: number, mentionUnreadCount: number }`
  - `ICommentService` 接口新增 `getUnreadSummary(userId: string): Promise<CommentUnreadSummary>`
  - 所有 comment 接口添加 JSDoc（双命名约定 `spreadsheetId`/`containerId`，`rowId`/`targetId`）
  - 废弃字段标注 `@deprecated`
- `packages/core-backend/src/routes/comments.ts`
  - `GET /api/comments/unread-count` 响应新增 `unreadCount` + `mentionUnreadCount`
  - 保留向后兼容字段 `count`（= `unreadCount`）
- `packages/core-backend/src/services/CommentService.ts`
  - 实现 `getUnreadSummary()` 单次 SQL 查询（COUNT(*) FILTER）
- `packages/core-backend/tests/unit/comment-contracts.test.ts`（216 行）

**验收：**
```bash
pnpm --filter @metasheet/core-backend test:unit
# comment-contracts.test.ts 全部通过
```

### 2.2 runtime lane (PR #857)

**文件变更：**
- `packages/core-backend/src/services/CommentService.ts`
  - `getCommentPresenceSummary()`: 双查询 → 单查询（PostgreSQL `COUNT(*) FILTER (WHERE ...)`）
  - `createComment()`: 创建后立即 `markCommentRead(id, authorId)` — 作者不会看到自己的评论为未读
  - `deleteComment()`: 验证 `comment:deleted` + `comment:activity` 双事件广播（无需改动）
- `packages/core-backend/tests/unit/comment-service.test.ts`（34 个测试用例）

**验收：**
```bash
pnpm --filter @metasheet/core-backend test:unit
# comment-service.test.ts 34/34 通过
```

### 2.3 integration lane (PR #858)

**文件变更：**
- `packages/core-backend/tests/integration/comment-flow.test.ts`（45 个测试）
  - Section 1: 完整生命周期（create/update/delete + 所有广播事件）
  - Section 2: 未读语义（getUnreadCount, getUnreadSummary, 作者自动已读，幂等性）
  - Section 3: mention 合约（@[Name](userId) 解析，多 mention，去重，显式数组优先级，mentionUnreadCount 拆分）
  - Section 4: 向后兼容（count 别名）
  - Section 5: Inbox（mentioned 标志，作者排除，unread 标志）
  - Section 6: 错误边界（权限、冲突、NotFound）
- `packages/core-backend/vitest.comment-flow.config.ts`
- `docs/development/collab-w1-integration-smoke-20260413.md`

**验收：**
```bash
cd packages/core-backend && npx vitest run --config vitest.comment-flow.config.ts
# 45/45 通过
```

---

## 3. Week 2 交付内容

### 3.1 frontend lane (PR #859) ✅ 已合并

**文件变更：**

| 文件 | 变更 |
|---|---|
| `apps/web/src/multitable/components/MetaCommentComposer.vue` | `@` mention 键盘流：方向键导航候选列表，Enter 确认，Escape 取消不丢内容 |
| `apps/web/src/multitable/components/MetaCommentsDrawer.vue` | 线程上下文头部展示父评论摘要；深度限制嵌套 |
| `apps/web/src/views/MultitableCommentInboxView.vue` | 未读 + mention 计数的 attention badge；点击深链到 record+field |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | `openCommentDrawer(recordId, fieldId)` — 滚动到 record 并打开抽屉 |
| `apps/web/tests/multitable-comment-composer.spec.ts` | mention 键盘流测试 |
| `apps/web/tests/multitable-comments-drawer.spec.ts` | 线程上下文测试 |
| `apps/web/tests/multitable-comment-inbox-view.spec.ts` | inbox attention badge 和深链测试 |
| `apps/web/tests/multitable-workbench-view.spec.ts` | 工作台深链集成测试 |

**验收：**
```bash
pnpm --filter @metasheet/web exec vitest run \
  apps/web/tests/multitable-comment-composer.spec.ts \
  apps/web/tests/multitable-comments-drawer.spec.ts \
  apps/web/tests/multitable-comment-inbox-view.spec.ts \
  apps/web/tests/multitable-workbench-view.spec.ts \
  --watch=false
```

### 3.2 runtime lane (PR #860) ✅ 已合并

补齐前端 UX 依赖的后端接口：

| 接口 | 说明 |
|---|---|
| `GET /api/multitable/:spreadsheetId/mention-candidates?q=&limit=10` | mention 自动补全候选人搜索 |
| `POST /api/multitable/:spreadsheetId/comments/mark-all-read` | 批量标记已读 |
| `GET /api/multitable/:spreadsheetId/comments/presence?includeViewers=true` | presence 响应包含查看者身份 |

**预期验收：**
```bash
pnpm --filter @metasheet/core-backend test:unit
```

### 3.3 integration lane (PR #861) ✅ 已合并

**文件变更：**
- `packages/core-backend/tests/integration/collab-ux-flow.test.ts`（35 个测试）
  - Section 1: mention 候选 API（8 测试 — 查询匹配、空值、limit、结果结构）
  - Section 2: mark-all-read（7 测试 — 批量标记、幂等性、用户隔离、作者自动已读）
  - Section 3: presence viewer 身份（6 测试 — 纯计数 vs 含 viewers、空态、rowId 过滤）
  - Section 4: 完整 UX 流程（9 测试 — @mention 通知 → inbox → deep-link → mark-all-read）
  - Section 5: 向后兼容（5 测试 — count 别名、mention 解析格式）
- `packages/core-backend/vitest.collab-ux-flow.config.ts`
- `docs/development/collab-w2-integration-smoke-20260413.md`（35 项手动 smoke 清单）

**验收：**
```bash
cd packages/core-backend && npx vitest run --config vitest.collab-ux-flow.config.ts
# 35/35 通过
```

---

## 4. 手动 Smoke 验证清单

### 4.1 评论创建与未读

- [ ] 用户 A 在记录上创建评论
- [ ] 用户 B（非作者）刷新页面，工作台行级评论图标显示未读角标
- [ ] 用户 A 刷新页面，不显示未读角标（作者自动已读）
- [ ] `GET /api/comments/unread-count` 返回 `{ unreadCount, mentionUnreadCount, count }` 三个字段

### 4.2 Mention 流程

- [ ] 在评论框输入 `@`，触发候选人下拉
- [ ] 方向键上下可选中不同候选人
- [ ] Enter 确认插入 `@[Name](userId)` 格式
- [ ] Escape 关闭候选列表，输入内容保留
- [ ] 被 @mention 的用户收件箱出现该评论，`mentioned=true`
- [ ] `GET /api/comments/unread-count` 的 `mentionUnreadCount` 增加 1

### 4.3 Inbox 深链

- [ ] 收件箱评论卡片上的未读 + mention 计数徽章正确显示
- [ ] 点击收件箱评论 → 路由跳转到对应多维表
- [ ] 对应记录自动滚动到视图内
- [ ] 评论抽屉自动打开并定位到对应字段评论

### 4.4 Mark All Read

- [ ] 收件箱顶部"全部标记已读"按钮调用 `POST .../mark-all-read`
- [ ] 调用后 `unreadCount` 降为 0
- [ ] 再次调用返回 count=0（幂等）

### 4.5 Presence

- [ ] 两个用户同时打开同一张表
- [ ] `GET .../comments/presence?includeViewers=true` 返回 `viewers` 数组包含两个用户
- [ ] 一个用户离开后，viewers 数组缩减

### 4.6 删除评论广播

- [ ] 用户 A 删除评论 → 其他在线用户的评论列表实时移除该评论
- [ ] 收件箱中相关 activity 变为 `kind: 'deleted'`

---

## 5. API 契约速查

### `GET /api/comments/unread-count`
```json
{
  "unreadCount": 3,
  "mentionUnreadCount": 1,
  "count": 3
}
```

### `GET /api/multitable/:spreadsheetId/mention-candidates?q=john&limit=10`
```json
{
  "items": [
    { "userId": "usr_abc", "displayName": "John Doe", "avatarUrl": "..." }
  ]
}
```

### `POST /api/multitable/:spreadsheetId/comments/mark-all-read`
```json
// Request body
{ "userId": "usr_xyz" }

// Response
{ "markedCount": 5 }
```

### `GET /api/multitable/:spreadsheetId/comments/presence?includeViewers=true`
```json
{
  "items": [
    {
      "rowId": "row_1",
      "unresolvedCount": 3,
      "fieldCounts": { "fld_name": 2 },
      "mentionedCount": 1,
      "mentionedFieldCounts": { "fld_name": 1 }
    }
  ],
  "viewers": [
    { "userId": "usr_a", "displayName": "Alice" },
    { "userId": "usr_b", "displayName": "Bob" }
  ]
}
```

---

## 6. 未完成事项（Week 2 收尾）

- [x] PR #860 (runtime) 已合并 ✅
- [x] PR #861 (integration) 已合并 ✅
- [ ] 前端组件视觉走查（Week 2 frontend 已合并，需人工 browser 验证）
- [ ] Presence viewer 识别已实现 `CollabService.getRoomMembers()` — 从 Socket.IO 房间取真实成员

---

## 7. 合并顺序与 PR 汇总

| PR | 标题 | 状态 |
|---|---|---|
| #846 | fix(attendance): zero-state viewport polish | ✅ 已合并 |
| #856 | feat(comments): contracts — unread/mention split | ✅ 已合并 |
| #857 | feat(comments): runtime — single-query presence, auto-read | ✅ 已合并 |
| #858 | test(comments): Week-1 integration 45 tests | ✅ 已合并 |
| #859 | feat(multitable): Week-2 frontend — mention UX, inbox badge, deep-link | ✅ 已合并 |
| #860 | feat(comments): Week-2 runtime — mention candidates, mark-all-read, presence identity | ✅ 已合并 |
| #861 | test(comments): Week-2 integration 35 tests — mention, mark-all-read, presence, full flow | ✅ 已合并 |
