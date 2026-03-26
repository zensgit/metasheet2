# PLM Workbench Approval History Route Unification Design

## 背景

仓库里曾同时存在两条 `GET /api/approvals/:id/history`：

- [approvals.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/approvals.ts)
- [approval-history.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/approval-history.ts)

应用启动时先挂 `approvalsRouter()`，再挂 `approvalHistoryRouter()`。

## 问题

旧的 `approvals.ts` 历史路由会先命中：

- 返回扁平 `{ data, total }`
- 不支持 `page / pageSize`
- 与后续 canonical approval-history handler 的 envelope 不一致

同时 `approval-history.ts` 自己也缺认证保护，导致“真实 live handler”和“期望 canonical handler”都不干净。

## 设计决策

- live route 只能保留一个 canonical handler
- canonical handler 统一放在 `approval-history.ts`
- 输出统一为 paginated envelope：
  - `ok`
  - `data.items`
  - `data.page`
  - `data.pageSize`
  - `data.total`
- 挂载顺序必须通过 app-level test 锁住
- 现有前端 consumer 同步对齐到 paginated envelope；如历史 mock 仍返回扁平数组，则前端兼容 fallback

## 实现

- 从 [approvals.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/approvals.ts) 删除重复的 history route
- 给 [approval-history.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/approval-history.ts) 接入 `authenticate`
- 新增 app-mounted 回归 [approval-history-routing.test.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/tests/unit/approval-history-routing.test.ts)，直接按真实 mounted 顺序挂 `approvalsRouter()` + `approvalHistoryRouter()`
- 调整 [ApprovalInboxView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/ApprovalInboxView.vue) 消费 `payload.data.items`

## 预期结果

- `/api/approvals/:id/history?page=2&pageSize=1` 总是走 canonical paginated handler
- 未认证请求被 401 拦下
- `PlmProductView` 和 `ApprovalInboxView` 对同一条 route 使用一致 envelope
