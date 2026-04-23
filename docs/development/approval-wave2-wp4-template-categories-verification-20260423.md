# Wave 2 WP4 Slice 1 — 审批模板分类 + 克隆 验证记录

> 日期: 2026-04-23
> 分支: `codex/approval-wave2-wp4-template-categories-20260423`
> 对应开发文档: `docs/development/approval-wave2-wp4-template-categories-development-20260423.md`

---

## 1. 静态检查

### TypeScript — core-backend

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

结果: 通过（无输出）

### TypeScript — web

```
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

结果: 通过（无输出）

---

## 2. 后端测试

### 单元测试

```
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-template-routes.test.ts --reporter=dot
```

结果: **4 passed / 4**（现有用例补 mock 中 `category` 字段后仍全过）

### 集成测试（WP4 + 回归）

```
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp4-template-categories.api.test.ts \
  tests/integration/approval-pack1a-lifecycle.api.test.ts \
  tests/integration/approval-wp1-any-mode.api.test.ts \
  --reporter=dot
```

结果: **12 passed / 12**

- `approval-wp4-template-categories.api.test.ts` — 8 / 8
  - stores category on create and surfaces it in detail
  - filters the template list by `?category=xxx`
  - `/api/approval-templates/categories` returns distinct non-null categories
  - PATCH category does NOT rotate `latestVersionId`
  - clone produces `(副本)` name, `_copy_<6hex>` key, same category, draft-only, no publishedDefinition
  - clone of an archived source still succeeds (clone is not gated on status)
  - clone without `approval-templates:manage` → 403
  - clone of unknown id → 404 `APPROVAL_TEMPLATE_NOT_FOUND`
- `approval-pack1a-lifecycle.api.test.ts` — 3 / 3（回归通过）
- `approval-wp1-any-mode.api.test.ts` — 1 / 1（回归通过）

> 注：为让 "无权限 → 403" 路径在 RBAC 表未 bootstrap 的集成 DB 上也能工作，`approval-wp4-template-categories.api.test.ts` 在 `beforeAll` 里 `CREATE TABLE IF NOT EXISTS` 了 `user_roles / user_permissions / role_permissions / users / user_namespace_admissions` 空存根。其他 suite 继续通过 `*:*` fast-path，不受影响。

---

## 3. 前端测试

### WP4 分类 + 克隆 Spec

```
pnpm --filter @metasheet/web exec vitest run \
  tests/approvalTemplateCenterCategory.spec.ts --reporter=dot
```

结果: **6 passed / 6**

- populates the category dropdown from `listTemplateCategories()`
- passes `category` to `loadTemplates` when the filter changes
- clears the category filter when selection goes back to empty
- renders a category tag per row
- clicking 克隆 calls `cloneTemplate` + routes to `/approval-templates/<new-id>`
- does not route when `cloneTemplate` rejects

### 相关 Approval 回归

```
pnpm --filter @metasheet/web exec vitest run \
  tests/approval-e2e-lifecycle.spec.ts \
  tests/approval-e2e-permissions.spec.ts \
  tests/approval-inbox-auth-guard.spec.ts \
  tests/approvalCenterRemindBadge.spec.ts \
  tests/approvalCenterSourceFilter.spec.ts \
  --reporter=dot
```

结果: **91 passed / 91**

> `tests/approval-center.spec.ts` 存在预先失败（`localStorage is not a function`），与本切片无关 —— 在 `git stash` 到 baseline 后同样失败，属于测试环境既有问题。

---

## 4. 手工核对点

- [x] Migration 迁移文件命名为 `zzzz20260423150000_add_approval_template_category.ts`，与现有迁移编号递增一致。
- [x] Bootstrap helper 版本标记同步更新为 `20260423-wp4-template-category`。
- [x] `approval_templates.category` 列允许 NULL，默认不设非空约束。
- [x] 部分索引 `idx_approval_templates_category_status` 仅覆盖非空 category。
- [x] 克隆产物 `key` 匹配正则 `^{original_key}_copy_[0-9a-f]{6}$`。
- [x] 克隆产物 `status === 'draft'`，`activeVersionId === null`，无 `approval_published_definitions` 记录。
- [x] PATCH 仅含 `category` 时版本不滚动（`latestVersionId` 前后一致）。
- [x] 模板中心分类下拉 + 分类列 tag + 克隆按钮渲染；`TemplateDetailView` 行内编辑器只覆盖分类一个字段。
- [x] 明确延后：模板级 ACL、字段联动、条件显隐。

---

## 5. 检查清单

| 验收点 | 结果 |
|--------|------|
| TS 静态检查（core-backend + web） | ✅ |
| 后端单元测试 | ✅ 4/4 |
| 后端集成测试 — WP4 | ✅ 8/8 |
| 后端集成测试 — Wave 1 回归 | ✅ 4/4 |
| 前端 WP4 spec | ✅ 6/6 |
| 前端既有审批 spec 回归 | ✅ 91/91 |
| 文档交付（development + verification） | ✅ |
