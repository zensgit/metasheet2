# MetaSheet 对标飞书多维表格 — 完整开发验证报告

Date: 2026-04-14

## 总览

8 周路线图 + 生产化加固，全部完成。

| 阶段 | PR 数 | 新增测试 | 状态 |
|---|---|---|---|
| Week 1-2: 协作系统 | 6 | ~164 | ✅ |
| Week 3-5: 表单/验证/Token | 4 | 139 | ✅ |
| Week 6-7: 自动化/图表 | 3 | 159 | ✅ |
| Week 8: RC 收口 | 1 | 53 | ✅ |
| 生产化: PG 持久化 | 2 | 170 | ✅ |
| **合计** | **16 PR** | **~685** | |

---

## 一、Week 1-2: 协作语义统一 + 体验补完

### PR 列表

| PR | 标题 | Lane |
|---|---|---|
| #856 | `CommentUnreadSummary` 类型、`getUnreadSummary()`、JSDoc 统一 | contracts |
| #857 | 单查询 `getCommentPresenceSummary()`、作者自动已读 | runtime |
| #858 | 45 个评论集成测试 | integration |
| #859 | mention 键盘流、inbox badge、评论深链 | frontend |
| #860 | mention 候选 API、`markAllCommentsRead`、presence viewer 身份 | runtime |
| #861 | 35 个 UX 集成测试 | integration |

### 核心能力

**评论系统（15 个公共方法）：**
- `createComment` — 含 `@[Name](userId)` 自动解析、作者自动已读
- `getUnreadSummary` — 单查询返回 `{ unreadCount, mentionUnreadCount }`
- `getCommentPresenceSummary` — PostgreSQL `COUNT(*) FILTER` 单查询
- `getCommentPresenceSummaryWithViewers` — 含 Socket.IO 房间成员身份
- `listMentionCandidates` — name/email 子串搜索
- `markAllCommentsRead` — 批量 UPSERT
- `getInbox` — 含 navigation context (baseId, sheetId, viewId, recordId)
- 以及 getComments, updateComment, deleteComment, resolveComment, markCommentRead, getMentionSummary, markMentionsRead, getUnreadCount

**实时协作：**
- WebSocket 事件：`comment:created/updated/deleted/resolved`
- 广播范围：record room + sheet room + inbox room
- Presence：`getRoomMembers()` 从 Socket.IO 获取在线用户
- Webhook 事件：`multitable.comment.created`

**前端组件：**
- `MetaCommentComposer.vue` (304 行) — `@` mention 键盘流（Tab 确认、Escape 取消）
- `MetaCommentsDrawer.vue` (388 行) — 线程上下文、回复、已解决标记
- `MultitableCommentInboxView.vue` (188 行) — attention badge + 深链

**API 契约：**
```
GET  /api/comments/unread-count → { unreadCount, mentionUnreadCount, count }
GET  /api/multitable/:sheetId/mention-candidates?q=&limit=10
POST /api/multitable/:sheetId/comments/mark-all-read
GET  /api/multitable/:sheetId/comments/presence?includeViewers=true
```

---

## 二、Week 3: 公开表单分享

### PR 列表

| PR | 标题 |
|---|---|
| (baseline) | `fbc170f73` — token 模型、form-context、匿名提交 (Codex) |
| #862 | Rate limiter 中间件、提交审计、集成测试 |
| #867 | `MetaFormShareManager.vue` — 分享管理 UI |

### 核心能力

- **Token 校验**：`isPublicFormAccessAllowed(view, publicToken)` — token + 过期时间
- **最小权限**：`PUBLIC_FORM_CAPABILITIES` — 仅 `canCreateRecord: true`
- **Rate limiter**：提交 10次/15min，上下文 60次/15min，认证用户不限流
- **提交审计**：viewId + 截断 token + IP + recordId + timestamp

**API：**
```
GET  /api/multitable/form-context?publicToken=xxx
POST /api/multitable/views/:viewId/submit?publicToken=xxx
```

**前端：**
- `PublicMultitableFormView.vue` — 路由 `/multitable/public-form/:sheetId/:viewId`，`requiresAuth: false`
- `MetaFormShareManager.vue` — 启用/禁用、复制链接、重生成 token、过期设置、预览

---

## 三、Week 4: 字段验证规则

### PR 列表

| PR | 标题 |
|---|---|
| #864 | 验证引擎 — required/range/pattern/enum，81 个测试 |
| #867 | `MetaFieldValidationPanel.vue` — 验证配置 UI |

### 规则类型

| 规则 | 适用字段 |
|---|---|
| `required` | 所有 |
| `min` / `max` | number/currency |
| `minLength` / `maxLength` | text/array |
| `pattern` | text（预设：email/URL/phone） |
| `enum` | select（自动从 options 生成） |

### 设计决策

- 后端权威源，前端复用
- 非 fail-fast：返回全部错误
- 422 + `fieldErrors[]` 统一错误结构
- 接入 submit + records 两个入口

---

## 四、Week 5: API Token + Webhook V1

### PR 列表

| PR | 标题 |
|---|---|
| #863 | Token CRUD + Webhook HMAC + 投递队列，41 测试 |
| #867 | `MetaApiTokenManager.vue` — 双 Tab 管理 UI |

### API Token

- 格式：`mst_` + 32 hex，SHA-256 hash 存储
- Scope：`records:read/write`, `fields:read`, `comments:read/write`, `webhooks:manage`
- 操作：创建（明文仅一次）/ 轮换（事务）/ 撤销（软删除）/ 验证

### Webhook

- 事件：`record.created/updated/deleted`, `comment.created`
- 签名：HMAC-SHA256 (`X-Webhook-Signature`)
- 重试：指数退避 ×3，10 次失败熔断
- EventBus 桥接：不修改现有发布代码

### REST 端点（9 个）

```
GET/POST/DELETE /api/multitable/api-tokens
POST            /api/multitable/api-tokens/:id/rotate
GET/POST/PATCH/DELETE /api/multitable/webhooks
GET             /api/multitable/webhooks/:id/deliveries
```

---

## 五、Week 6: 高级自动化 V1

### PR 列表

| PR | 标题 |
|---|---|
| #866 | 触发器/条件/动作/调度器/执行日志，80 测试 |
| #868 | `MetaAutomationRuleEditor.vue` + `MetaAutomationLogViewer.vue` |

### 触发器（7 种）

`record.created/updated/deleted` · `field.value_changed` · `schedule.cron/interval` · `webhook.received`

### 条件引擎（10 种运算符）

`equals` · `not_equals` · `contains` · `not_contains` · `greater_than` · `less_than` · `is_empty` · `is_not_empty` · `in` · `not_in` + AND/OR 分组

### 动作（5 种）

`update_record` · `create_record` · `send_webhook`（3 次重试） · `send_notification` · `lock_record`

### 执行管线

```
触发事件 → 匹配规则 → 条件评估 → 顺序动作链（2-3 步，失败即停） → 日志记录
```

### 调度器

- interval：`setInterval` + register/unregister/destroy
- cron：简化解析（每 N 分钟 / 每小时 / 每天 / 每周一）

### REST 端点

```
GET/POST/PATCH/DELETE /api/multitable/:sheetId/automations
POST /api/multitable/:sheetId/automations/:id/test
GET  /api/multitable/:sheetId/automations/:id/logs
GET  /api/multitable/:sheetId/automations/:id/stats
```

---

## 六、Week 7: 图表 / Dashboard V1

### PR 列表

| PR | 标题 |
|---|---|
| #865 | 聚合服务 + dashboard 模型 + 11 端点，50 测试 |
| #868 | `MetaChartRenderer.vue` (SVG) + `MetaDashboardView.vue` (CSS Grid) |

### 图表类型

`bar`（柱状）· `line`（折线）· `pie`（饼图）· `number`（数字卡片）· `table`（表格）

### 聚合函数

`count` · `sum` · `avg` · `min` · `max` · `count_distinct`

### 数据源

- 分组：按字段值或日期（day/week/month/quarter/year）
- 过滤：equals/not_equals/contains/greater_than/less_than
- 排序：by label/value，asc/desc
- 限制：Top N

### Dashboard

- 网格面板布局 `{ x, y, w, h }`
- 多图表组合，small/medium/large 尺寸预设

### REST 端点（11 个）

```
GET/POST/GET/:id/PATCH/:id/DELETE/:id /api/multitable/:sheetId/charts
GET /api/multitable/:sheetId/charts/:id/data
GET/POST/GET/:id/PATCH/:id/DELETE/:id /api/multitable/:sheetId/dashboards
```

---

## 七、Week 8: RC 收口

### PR #869

| 交付物 | 说明 |
|---|---|
| `rc-regression.test.ts` | 53 个跨功能回归测试（7 个 section） |
| `scripts/rc-smoke.sh` | HTTP smoke 脚本 |
| `scripts/seed-demo-data.ts` | 演示数据播种器（Project Tracker） |
| `docs/release/feishu-gap-rc-release-notes-202605.md` | 发布说明 |
| `docs/development/next-phase-backlog-202605.md` | 下阶段 10 项 backlog |

---

## 八、生产化加固: PostgreSQL 持久化

### PR 列表

| PR | 标题 |
|---|---|
| #874 | 自动化日志 + 图表/Dashboard → PG，129 测试 |
| #875 | API Token + Webhook → PG，41 测试 |

### 6 张新 PostgreSQL 表

| 表 | 说明 |
|---|---|
| `multitable_automation_executions` | 执行日志（支持 30 天自动清理） |
| `multitable_charts` | 图表配置（JSONB: data_source, display） |
| `multitable_dashboards` | Dashboard 面板布局（JSONB: panels） |
| `multitable_api_tokens` | Token hash + scope（UNIQUE index on hash） |
| `multitable_webhooks` | Webhook 配置（partial index WHERE active） |
| `multitable_webhook_deliveries` | 投递历史（FK CASCADE，partial index WHERE pending） |

### 关键改进

- 5 个服务全部从内存迁移到 PostgreSQL
- 所有方法 async/await
- `rotateToken()` 使用 DB 事务
- `getStats()` 使用 PG 聚合查询 (`COUNT FILTER + AVG`)
- `cleanup(30天)` 自动清理过期日志
- 删除 webhook 级联清理投递历史
- 删除图表自动清理 dashboard 面板引用

---

## 九、前端组件总览

| 组件 | 行数 | 功能 |
|---|---|---|
| `MetaCommentComposer.vue` | 304 | @ mention 键盘流 |
| `MetaCommentsDrawer.vue` | 388 | 评论线程 + 回复 |
| `MultitableCommentInboxView.vue` | 188 | 收件箱 + 深链 |
| `PublicMultitableFormView.vue` | 200 | 公开表单（匿名） |
| `MetaFormShareManager.vue` | — | 分享管理（启用/链接/过期） |
| `MetaFieldValidationPanel.vue` | — | 字段验证配置 |
| `MetaApiTokenManager.vue` | — | Token + Webhook 双 Tab 管理 |
| `MetaAutomationRuleEditor.vue` | — | 自动化规则编辑器 |
| `MetaAutomationLogViewer.vue` | — | 执行日志查看器 |
| `MetaChartRenderer.vue` | — | SVG/HTML 图表渲染 |
| `MetaDashboardView.vue` | — | Dashboard 面板布局 |

API Client 扩展：**40+ 个新方法**

---

## 十、全量验收命令

```bash
# 后端全量
cd packages/core-backend && npx vitest run --watch=false

# RC 回归（53 个跨功能测试）
npx vitest run tests/integration/rc-regression.test.ts --watch=false

# 前端全量
cd apps/web && npx vitest run --watch=false

# Smoke（需运行中服务器）
./scripts/rc-smoke.sh http://localhost:3000

# 演示数据
npx tsx scripts/seed-demo-data.ts http://localhost:3000
```

---

## 十一、手动 Smoke 验证清单

### 评论系统
- [ ] 创建评论 → 其他用户实时收到
- [ ] 输入 `@` → 候选列表 → 键盘选择 → 确认
- [ ] 被 @ 的用户收件箱出现该评论
- [ ] 点击收件箱评论 → 深链到记录
- [ ] "全部标记已读" → 未读计数归零

### 公开表单
- [ ] 访问公开链接 → 表单可提交
- [ ] 提交 10 次 → 第 11 次 429
- [ ] 过期链接 → 403
- [ ] 重新生成 token → 旧链接失效

### 字段验证
- [ ] 必填字段提交空值 → 422
- [ ] 数值超出范围 → 422
- [ ] 正则不匹配 → 422
- [ ] 多个错误同时返回

### API Token
- [ ] 创建 token → 明文仅显示一次
- [ ] Bearer 认证访问 API → 成功
- [ ] 撤销后 → 401
- [ ] 轮换 → 旧失效新可用

### Webhook
- [ ] 创建 webhook → 事件触发投递
- [ ] 检查 HMAC 签名正确
- [ ] 目标不可达 → 重试 → 10 次后禁用

### 自动化
- [ ] 创建规则 → 触发条件满足 → 动作执行
- [ ] 条件不满足 → 跳过
- [ ] 多步动作 → 顺序执行
- [ ] 查看执行日志和统计

### 图表 / Dashboard
- [ ] 创建柱状图 → 数据正确
- [ ] 创建 dashboard → 添加多个面板
- [ ] 切换图表类型 → 渲染正确

---

## 十二、下一阶段 Backlog

| 优先级 | 项目 | 工作量 |
|---|---|---|
| P0 | CRDT/OT 实时协同编辑 | XL |
| P0 | DB 持久化收尾（自动化规则、限流器 → Redis） | S |
| P1 | 复杂 DAG 自动化设计器 | L |
| P1 | 高级 BI 分析 | L |
| P1 | 移动端优化 | M |
| P2 | 模板市场 | L |
| P2 | 批量导入导出增强 | M |
| P2 | 审计日志 UI | S |
| P3 | 自定义字段类型（插件） | L |
| P3 | 多语言支持 | M |
