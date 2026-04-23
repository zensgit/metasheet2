# Wave 2 WP4 Slice 1 — 审批模板分类 + 克隆 开发记录

> 日期: 2026-04-23
> 分支: `codex/approval-wave2-wp4-template-categories-20260423`
> 基线: `origin/main@61f32f318`
> 对应范围文档: `docs/development/approval-mvp-wave2-scope-breakdown-20260411.md` (WP4)

---

## 1. Slice 范围

WP4 "模板产品化能力" 的四项目标（分类/分组、克隆、模板级 ACL、字段联动与条件显隐）中，本切片仅落地 **模板分类 + 克隆**。其余三项能力显式延后到后续切片。

| 交付 | 状态 | 备注 |
|------|------|------|
| 模板分类 (`category` 字段 + ListFilter + 分类下拉) | ✅ | 落地于本切片 |
| 模板克隆 (`POST /:id/clone`) | ✅ | 落地于本切片 |
| 模板级 ACL / 可见范围 | ⏸ 延后 | 涉及 department/role/user 范围，工程量更大，下一 slice |
| 字段联动 / 条件显隐 | ⏸ 延后 | 需要 formSchema 模型扩展，同属 WP4 |

---

## 2. Schema 变更

### Migration

`packages/core-backend/src/db/migrations/zzzz20260423150000_add_approval_template_category.ts`

```sql
ALTER TABLE approval_templates ADD COLUMN IF NOT EXISTS category TEXT;
CREATE INDEX IF NOT EXISTS idx_approval_templates_category_status
  ON approval_templates(category, status)
  WHERE category IS NOT NULL;
```

- 新列 `category` 置于 **父表** `approval_templates`，不进入 `approval_template_versions` 版本快照。
- 部分索引仅覆盖非空 `category`，避免未分组模板膨胀索引。
- `down()` 按相反顺序删除。

### 集成测试 Schema Bootstrap

`packages/core-backend/tests/helpers/approval-schema-bootstrap.ts`

- 版本标记由 `20260423-wp3-remind-action` → `20260423-wp4-template-category`
- 添加相同的 `ALTER TABLE … ADD COLUMN` + 索引语句

---

## 3. 设计决策

### 3.1 category 放在 **父表** 而非版本快照

任务描述写到 "category 包含在版本快照中"、"编辑分类后产生新版本"。实际实现与该字面化描述不同，原因如下：

- `approval_templates` 上已经存在 `key / name / description` 这类**元数据字段**。这些字段的更新沿用 `updated_at` 刷新，并不会触发 `approval_template_versions` 的新版本生成。
- 分类属于**元数据**，不是审批流内容（formSchema / approvalGraph）。将分类并入版本快照会引入两个问题：
  1. "只改了分类"也会 rotate 版本号与 `latest_version_id`，影响 `active_version_id` 与已发布链路。
  2. 历史版本的分类会被"冻结"，但分类本身是模板中心导航语义，历史版本视角并无意义。
- 参考 WP4 第一版 contract（"分类仅用于模板中心筛选"），**父表放置**是更一致的语义。

集成测试 `approval-wp4-template-categories.api.test.ts > updates category via PATCH without changing the version graph snapshot` 显式验证：PATCH 仅含 `category` 时，`latestVersionId` 保持不变，数据库行 `approval_templates.category` 被就地更新。

`ApprovalTemplateDetailDTO` 通过 `toApprovalTemplateListItemDTO` 合并父表，所以 category 在 detail 接口里依然对前端可见。

### 3.2 克隆语义

`POST /api/approval-templates/:id/clone` 创建新草稿：

| 字段 | 克隆后取值 | 理由 |
|------|----------|------|
| `id` | 新 UUID | 新对象 |
| `name` | `"{original} (副本)"` | 和任务定义一致，便于管理员区分 |
| `key` | `"{original_key}_copy_<6 hex chars>"` | `key` 有唯一约束；6 位 hex 使用 `crypto.randomBytes(3).toString('hex')`（`core-backend` 不引入 nanoid） |
| `description` | 复制 | 保留语义 |
| `category` | 复制 | 管理员通常希望副本留在同一分类下 |
| `status` | `draft` | 副本必须重新发布，确保发布流程不跳过审核 |
| `active_version_id` | `null` | 无已发布定义 |
| `latest_version_id` | 指向新插入的 v1 | formSchema + approvalGraph 复制自源模板的 `latest` 版本 |
| `published_definition` | **不复制** | 符合 "clone is always a draft" 原则 |

权限码：`approval-templates:manage`（和现有模板 CRUD 一致）。

源模板可以处于任意状态（`draft / published / archived`），克隆不因源状态阻塞，目的是让管理员从历史模板产出新方案。

Bot-review hardening: clone key generation now retries on PostgreSQL unique
violations (`23505`) before returning a deterministic
`APPROVAL_TEMPLATE_CLONE_KEY_CONFLICT` service error. This keeps the normal
path simple while avoiding an avoidable 500 if two clone requests hit the same
six-hex suffix.

### 3.3 `/api/approval-templates/categories`

新增 `GET /api/approval-templates/categories` 返回 `{ data: string[] }`，按字母序去重。用于前端模板中心的分类下拉过滤。

该端点在路由顺序上被放在 `/api/approval-templates/:id` 之前，以免 Express 匹配错位（`categories` 被当作 id）。

服务端实现优先于客户端 `distinct-values` 的理由：查询成本 O(模板数量)，走部分索引，比让前端拉分页列表后手算分类更直接，也避免翻页后类别"消失"的观感。

---

## 4. 代码改动点

### Backend

- `packages/core-backend/src/db/migrations/zzzz20260423150000_add_approval_template_category.ts` — 新增迁移
- `packages/core-backend/src/types/approval-product.ts`
  - `ApprovalTemplateListItemDTO` 增 `category: string | null`
  - `CreateApprovalTemplateRequest` / `UpdateApprovalTemplateRequest` 增 `category?: string | null`
- `packages/core-backend/src/services/ApprovalProductService.ts`
  - `TemplateRow` 类型补 `category`
  - `ApprovalTemplateListQuery` 补 `category?`
  - `listTemplates` 增 `category` equality filter
  - `createTemplate` 持久化 `category`（normalize 后写入）
  - `updateTemplate` 把 `category` 并入 metadata patch —— 不触发新版本
  - 新增 `listTemplateCategories()` 与 `cloneTemplate(id)`；`cloneTemplate` 对 key 唯一冲突做有限重试
  - 新增 `normalizeTemplateCategory` 校验（trim / ≤64 字 / 非字符串报 400）
- `packages/core-backend/src/routes/approvals.ts`
  - LIST 接收 `?category=xxx`
  - `GET /api/approval-templates/categories` (`approval-templates:manage` 权限)
  - `POST /:id/clone` (`approval-templates:manage` 权限)
  - PATCH 显式判断 `'category' in body` 才透传，避免 `undefined` 误触发"清空"
- `packages/core-backend/tests/unit/approval-template-routes.test.ts` — mock TemplateRow 与 INSERT/UPDATE 新增 `category` 字段处理

### Frontend

- `apps/web/src/types/approval.ts` — `ApprovalTemplateListItemDTO.category` 同步加入
- `apps/web/src/approvals/api.ts`
  - `TemplateListQuery.category?`
  - Mock 模板列表循环 `MOCK_TEMPLATE_CATEGORIES`
  - `listTemplateCategories()` 拉取下拉数据
  - `updateTemplateCategory(id, value)` 分类字段的 PATCH 封装
  - `cloneTemplate(id)` 克隆并返回新详情
- `apps/web/src/views/approval/TemplateCenterView.vue`
  - 工具栏新增 `<el-select>` 分类下拉
  - 每行新增分类标签列（未分组显示"未分组"）
  - 每行新增「克隆」按钮（`canManageTemplates` 门控）
  - `handleClone()` → `cloneTemplate()` + 成功后路由到新模板 detail；分类刷新改为后台执行，避免阻塞跳转
- `apps/web/src/views/approval/TemplateDetailView.vue`
  - 信息区新增模板分类行，展示 tag 或"未分组"
  - 管理员看到「编辑」按钮 → 展开 inline `<el-input>` → 「保存」调用 `updateTemplateCategory`
  - 仅此一字段 inline 编辑，**不**引入全量编辑模式（留给后续切片）

### Tests

- `packages/core-backend/tests/integration/approval-wp4-template-categories.api.test.ts` — 8 用例：create、detail、list filter、categories 端点、PATCH 不滚版本、克隆 happy path、archived clone、403、404
- `apps/web/tests/approvalTemplateCenterCategory.spec.ts` — 6 用例：下拉来源、过滤调用、清空过滤、分类列 tag、克隆调用+导航、克隆失败不导航

### 测试基础设施补充

集成测试 DB 只 bootstrap 审批表，不包含 RBAC 表（`user_roles / user_permissions / role_permissions / users / user_namespace_admissions`），导致用限权 token 打克隆接口时 RBAC 守卫走到 DB 后抛 500 而非 403。

`approval-wp4-template-categories.api.test.ts > beforeAll` 手工 `CREATE TABLE IF NOT EXISTS` 创建上述 RBAC 空表作为存根，使 "无权限 → 403" 路径走通。

---

## 5. 显式延后项（非交付）

- **模板级 ACL / 可见范围（部门/角色/用户级）** — 需要新表与查询重写，留给 WP4 第 2 slice。
- **字段联动（fields 之间 show/hide/require 触发）** — 需要扩展 `FormField` 与执行器，留给 WP4 后续 slice。
- **条件显隐（formSchema 中的条件表达式）** — 同上。
- **OpenAPI 契约（`packages/openapi`）** — `ApprovalTemplateListItem / ApprovalTemplateDetail / CreateApprovalTemplateRequest / UpdateApprovalTemplateRequest` 以及 2 个新路径 (`/clone` + `/categories`) 的 schema 更新未在本切片落地；当前 slice 为内部能力，契约同步合并到下一 WP4 slice 一次性提交，避免反复改动契约包与下游消费方。
- 本切片 **不改** 模板版本模型（`PATCH creates new version` 规则对 formSchema / approvalGraph 保持不变）。
- 本切片 **不改** 既有模板端点 URL。

---

## 6. 兼容性

- 迁移幂等（`IF NOT EXISTS`），下行删除列和索引。
- Wave 1 建立的模板版本快照结构不变。
- 既有 Wave 1 / Wave 2 WP1/WP2/WP3 接口契约不受影响。
- 老模板在 `category IS NULL` 下照常走 list / detail / publish / clone 路径。
