# DingTalk Directory Recommendation Explainability

## Goal

继续把目录 review queue 做成可运营、可解释的管理员工作台。

本轮目标：

- 不只告诉管理员哪些 `pending_binding` 可以推荐确认。
- 还要明确告诉管理员为什么某个成员没有进入推荐流。
- 保持现有推荐规则不变，不引入模糊匹配。

## Implementation

### Backend

- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:355) 为 `DirectoryReviewItemSummary` 增加 `recommendationStatus`。
- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:625) 增加 `buildRecommendationStatus(...)`，统一生成可解释状态和文案。
- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:801) 到 [directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:862) 的推荐判定里，为以下情况返回明确状态：
  - `recommended`
  - `no_exact_match`
  - `ambiguous_exact_match`
  - `pending_link_conflict`
  - `linked_user_conflict`
  - `external_identity_conflict`

说明：

- 推荐规则本身没有变化，仍然只用唯一精确邮箱/手机号匹配。
- 这轮增加的是“解释层”，不是新的匹配算法。

### Frontend

- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:272) 为 `pending_binding` 增加“推荐判断”文案展示：
  - `推荐判断：{{ item.recommendationStatus.message }}`
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:786) 补齐 `recommendationStatus` 前端类型。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1466) 对 review item 的 API payload 做前端归一化，避免缺字段时页面报错。

现在管理员可以直接看到：

- `已命中唯一精确候选，可直接确认推荐绑定。`
- `未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。`
- `现有待确认匹配与精确候选不一致，请人工复核。`

## Tests

新增/更新：

- 后端：
  - [packages/core-backend/tests/unit/directory-sync-review-items.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-review-items.test.ts:183)
  - [packages/core-backend/tests/unit/directory-sync-review-items.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-review-items.test.ts:233)
- 前端：
  - [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1167)

覆盖内容：

- 推荐项会返回 `recommended` 状态。
- 无唯一精确候选时会返回 `no_exact_match`。
- 待确认绑定与精确候选不一致时会返回 `pending_link_conflict`。
- 页面在 `可推荐处理 / 需人工处理` 视图下都能展示对应的解释文案。

## Verification

通过：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-review-items.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-scheduler.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

`Claude Code CLI` 只读核对通过：

- `pending_binding` review item 已附带 `recommendationStatus`
- `DirectoryManagementView.vue` 已展示“推荐判断”文案

未通过但与本轮无关：

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

当前仍是仓库既有问题，集中在：

- `src/db/types.ts`
- `src/middleware/api-token-auth.ts`
- 若干 `src/multitable/*`
- `src/routes/comments.ts`
- `src/routes/dashboard.ts`
- `src/routes/univer-meta.ts`
