# DingTalk Directory Recommended Bindings Development

## Goal

继续把 `pending_binding` review queue 从“人工输入绑定”推进到“安全推荐候选人 + 一键确认推荐 + 批量确认推荐”。

本轮约束：

- 只做精确匹配推荐，不引入姓名或模糊匹配。
- 只在唯一候选且无已知冲突时给推荐。
- 复用现有 `/api/admin/directory/accounts/batch-bind`，不新增绑定提交接口。

## Implementation

### Backend

- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:319) 新增 `DirectoryBindingRecommendation` 和 `DirectoryBindingRecommendationReason`。
- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:615) 增加 `loadDirectoryReviewRecommendations(...)`。
- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1785) 的 `listDirectoryReviewItems(...)` 中为 `pending_binding` 生成推荐候选，并把结果附带到 `recommendations` 字段。

推荐规则：

- 仅使用精确邮箱匹配、精确手机号匹配。
- 若同一目录成员落到多个不同本地用户，则不推荐。
- 若候选用户已 linked 到别的 DingTalk 目录账号，则不推荐。
- 若候选用户已有不匹配当前目录成员的 DingTalk 外部身份，则不推荐。
- 若已有 `pending` 链接且与唯一精确候选一致，则在推荐原因中带上 `pending_link`。

### Frontend

- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:179) 增加顶部“批量确认推荐”入口。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:267) 为每条 `pending_binding` 展示推荐候选卡片和推荐原因。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:312) 增加单条“确认推荐”。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1135) 增加推荐采用与文案映射逻辑。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1563) 增加单条/批量推荐确认提交流程。

交互结果：

- 管理员可直接看到“邮箱精确匹配 / 手机号精确匹配 / 已存在待确认匹配”。
- 可单条确认推荐绑定。
- 可多选后批量确认推荐绑定。
- 原有手工输入、本地搜索、快速绑定仍保留，继续作为兜底路径。

## Tests

新增/更新测试：

- 后端推荐逻辑：
  - [packages/core-backend/tests/unit/directory-sync-review-items.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-review-items.test.ts:21)
  - [packages/core-backend/tests/unit/directory-sync-review-items.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-review-items.test.ts:100)
- 前端目录页推荐确认：
  - [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:682)
  - [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:978)

## Verification

通过：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-review-items.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-scheduler.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

`Claude Code CLI` 只读交叉检查：

- 命令通过 `python3 + claude -p` 非交互执行。
- CLI 确认：
  - `DirectoryManagementView.vue` 已包含“推荐候选 / 确认推荐 / 批量确认推荐”。
  - `directory-sync.ts` 的 review items 已包含 `recommendations` 字段。

未通过但与本轮无关：

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

现有报错仍集中在既有文件：

- `src/db/types.ts`
- `src/middleware/api-token-auth.ts`
- 若干 `src/multitable/*`
- `src/routes/comments.ts`
- `src/routes/dashboard.ts`
- `src/routes/univer-meta.ts`

本轮未引入新的 `directory-sync.ts` 或 `DirectoryManagementView.vue` 全量类型错误。
