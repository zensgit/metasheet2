# H2 多维表模板中心 + H3 行业模板种子 — 开发计划

- **日期**：2026-05-18
- **范围**：`apps/web/src/views/`、`apps/web/src/multitable/components/`、`apps/web/src/multitable/composables/`、`apps/web/src/router/`、`packages/core-backend/src/multitable/template-library.ts`（H3 阶段）
- **依赖**：Phase A (#1639) ✅、Phase H1 ✅、Phase B (#1642) ✅、Phase C 窗口文档 (#1646) ✅
- **K3 PoC 阶段一锁定**：合规（详见 §6）
- **关联**：[Views Consolidation Integration Plan §3 Phase H](./views-consolidation-multitable-spreadsheets-plan-20260517.md)、[Integration ERP Platform Roadmap](./integration-erp-platform-roadmap-20260425.md)

---

## 1. Summary

目标：继续主推多维表，补齐飞书对标里的"模板中心"上手路径。

**Scout 结论（详见 §10 附录）**：

- H1 已实现模板 quickstart、Base 列表、收藏/最近打开、搜索、install 后跳转
- 前端已有 `multitableClient.listTemplates()` 与 `installTemplate()`
- 后端已有 `GET /api/multitable/templates` 与 `POST /api/multitable/templates/:id/install`
- 现有 3 个模板（`project-tracker` / `sales-crm` / `issue-tracker`）来自静态库 `packages/core-backend/src/multitable/template-library.ts`，**非 DB 表**
- 因此 **H2 范围缩小**为"独立模板中心页面"；**H3 紧随**做静态模板库扩充，**不**加 DB migration

**分支策略**（普通 branch，不开 worktree）：

```bash
git fetch origin main
git switch -c frontend/multitable-template-center-20260518 origin/main
```

---

## 2. Key Changes

### 2.1 H2 PR — 模板中心路由与页面

#### 新增入口

- 新 route：`/multitable/templates`
- 新 route name：`AppRouteNames.MULTITABLE_TEMPLATES = 'multitable-templates'`
- 新页面：`MultitableTemplateCenterView.vue`
- `MultitableHomeView.vue` 的"模板快速开始"标题区加"查看全部模板 →"入口

#### 页面能力

- 调用现有 `GET /api/multitable/templates`
- 展示模板卡片：名称、描述、分类、icon/color、sheet 数、field 数、view 数
- **分类筛选**：`全部 / Project management / Sales / Engineering / ...`，分类**从返回数据动态聚合**（不 hard-code 分类列表，保证 H3 加新分类时无需改 H2）
- **搜索**：按 template `name` / `description` / `category` **三字段**匹配（客户端 filter，无后端调用）
- **明确支持的状态**：空状态 / 加载状态 / 错误状态 / 安装中状态
- 点击"使用模板"调用现有 `POST /api/multitable/templates/:id/install`
- install 成功后跳转到新建 base 的默认 sheet/view：

```ts
router.push({
  name: AppRouteNames.MULTITABLE,
  params: { sheetId: target.sheet.id, viewId: target.view.id },
  query: { baseId: result.base.id },
})
```

#### 复用策略

- **不**新增后端 API
- **不**改 `/api/multitable/templates` response shape
- 抽 `useTemplateInstall` composable，**仅供 Home + Template Center 复用**——Workbench 安装走自己的 lifecycle，**不在复用范围**（详见 §3.5）
- **不**做权限 / 租户新模型，沿用现有 `rbacGuard('multitable', 'read|write')`

#### Workbench modal 改动（最小化）

`MultitableWorkbench.vue` 的 template library modal：

- ✅ 卡片渲染改用 `<MetaTemplateCard>`（统一展示组件）
- ✅ Modal 底部加"更多模板 →"链接，跳 `/multitable/templates`
- ❌ **`onInstallTemplate` 函数与 install lifecycle 完全不动**——保持 `confirmDiscardContextChanges → workbench.client.installTemplate → workbench.syncExternalContext → showSuccess` 链路

理由：Workbench 安装依赖当前 base/sheet/view context，与 Home/Center 的"直接 push 到新 base"是不同 lifecycle，强行抽通用 composable 会把 H2 扩大为 Workbench 行为重构。

### 2.2 H3 PR — 行业模板种子扩充

不与 H2 同 PR；H2 design MD 同步 outline H3。

#### 范围

- 在 `packages/core-backend/src/multitable/template-library.ts` 数组追加 **5 个**新模板对象
- **纯数据 PR**，无新代码逻辑
- 不加 DB 表 / migration

#### 5 个新模板（与目标 6 类对齐）

| 模板 ID | Category (data layer) | 中文 UI 标签 | Sheets |
|---|---|---|---|
| `contract-management` | `Contract` | 合同管理 | Contracts + Payments |
| `field-inspection` | `Inspection` | 巡检 | Tasks + Issues + Remediation |
| `recruitment` | `Recruitment` | 招聘 | Candidates + Interviews + Offers |
| `meeting-minutes` | `Operations` | 会议纪要 | Meetings + Action items |
| `simple-list` | `General` | 通用清单 | List |

**质量门（每个模板必须满足）**：

- ≥ 5 字段，≤ 8 字段（覆盖业务核心，不堆砌）
- ≥ 2 views，其中**必有 1 个 grid**，**必有 1 个业务视图**（kanban / calendar / timeline / gantt / hierarchy 中合适者）
- 每个字段有 `description`
- 视图配置完整（kanban 必须指定 `groupByFieldId`，calendar 必须指定 `dateFieldId`，等等）

#### Category 命名口径（关键约束）

| 现有模板 | Category（保持不变） | 中文 UI 标签 |
|---|---|---|
| `project-tracker` | `Project management` | 项目管理 |
| `sales-crm` | `Sales` | CRM |
| `issue-tracker` | `Engineering` | 工程 |

**H3 不重命名现有 category**。`sales-crm` 保持 `Sales`，**不**改成 `CRM`。理由：

1. 改 category 字符串 = 动既有 hard-coded TS 数据 = 扩 H3 scope 到"数据迁移"
2. 任何对现有 category 名做 assert 的测试会破
3. UI 翻译层（前端中文显示"CRM"）即可满足语义，**无需动数据**

**架构**：底层 `template.category` 字符串全部保持英文（H2 + H3 一致），前端在 `MetaTemplateCard` 或 view 内部用翻译映射表显示中文标签。翻译表的位置由 H2 实现时决定（可能放 `apps/web/src/multitable/utils/category-labels.ts` 或就 inline 在 view 里）。

#### H3 不改前端页面逻辑

H2 页面的分类聚合是**从返回数据动态读取**，新加的 category 字符串会自动出现在 H2 的分类 tab 列表中。H3 PR 仅动后端 + 测试 expected ids，前端零代码改动。

---

## 3. 实现细节（H2）

### 3.1 新增文件

| 文件 | 体量 | 说明 |
|---|---|---|
| `apps/web/src/views/MultitableTemplateCenterView.vue` | ~200 行 | 新页面：hero + 分类导航 tab + 搜索框 + template grid + 状态分支 |
| `apps/web/src/multitable/components/MetaTemplateCard.vue` | ~80 行 | **纯展示组件**：props `{ template: MetaTemplate, installing: boolean }`，emit `install`。**不**在组件内 import `useRouter` / `multitableClient`，业务副作用全在父组件 |
| `apps/web/src/multitable/composables/useTemplateInstall.ts` | ~50 行 | 共享 install composable（详见 §3.5）—— 仅 Home + Template Center 复用 |
| `apps/web/src/multitable/utils/category-labels.ts` | ~15 行 | category 英文 → 中文标签映射表（fallback 显示原值） |
| `apps/web/tests/multitable-template-center-view.spec.ts` | ~120 行 | 页面完整行为测试 |
| `apps/web/tests/multitable-home-view.spec.ts` 增量 | ~30 行 | **仅**补 "查看全部模板" 入口链接断言；**不**重测 install 流程 |

### 3.2 修改文件

| 文件 | 改动 |
|---|---|
| `apps/web/src/router/appRoutes.ts` | 加 `/multitable/templates` 路由项（component lazy import） |
| `apps/web/src/router/types.ts` | **三处同步补齐**：(1) `AppRouteNames.MULTITABLE_TEMPLATES`；(2) `ROUTE_PATHS.MULTITABLE_TEMPLATES`；(3) `AppRouteParams['multitable-templates']: Record<string, never>` —— 与现有 typing 风格一致 |
| `apps/web/src/views/MultitableHomeView.vue` | 模板 section 标题旁加 "查看全部模板 →" 链接；卡片渲染改用 `<MetaTemplateCard>`；安装逻辑改走 `useTemplateInstall` composable |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | **仅最小改动**：modal 卡片改用 `<MetaTemplateCard>` + 加 footer link；`onInstallTemplate` 完全不动 |

### 3.3 不动文件

- `apps/web/src/multitable/api/client.ts` —— `listTemplates()` / `installTemplate()` 不变
- `packages/core-backend/src/routes/univer-meta.ts` —— 后端 routes 不动
- `packages/core-backend/src/multitable/template-library.ts` —— H2 不动（H3 才会动）
- migrations / DB schema —— 零改动
- K3 / integration-core / `/api/multitable/*` 契约 —— 零改动

### 3.4 路由配置

```ts
// apps/web/src/router/types.ts 新增
MULTITABLE_TEMPLATES: 'multitable-templates'
ROUTE_PATHS.MULTITABLE_TEMPLATES: '/multitable/templates'

// AppRouteParams 加
'multitable-templates': Record<string, never>

// apps/web/src/router/appRoutes.ts 新增（放在 MULTITABLE_HOME 之后）
{
  path: ROUTE_PATHS.MULTITABLE_TEMPLATES,
  name: AppRouteNames.MULTITABLE_TEMPLATES,
  component: () => import('../views/MultitableTemplateCenterView.vue'),
  meta: { title: 'Templates', titleZh: '模板中心', requiresAuth: true }
}
```

### 3.5 useTemplateInstall composable

```ts
// apps/web/src/multitable/composables/useTemplateInstall.ts
//
// 仅用于 router.push-style install（Home + Template Center）。
// Workbench 的 install lifecycle 不通过此 composable。
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { multitableClient } from '../api/client'
import type { MetaTemplate } from '../types'
import { AppRouteNames } from '../../router/types'

export function useTemplateInstall() {
  const router = useRouter()
  const installingTemplateId = ref<string | null>(null)
  const errorMessage = ref('')

  async function installAndOpen(template: MetaTemplate, opts?: { baseName?: string }) {
    if (installingTemplateId.value) return
    installingTemplateId.value = template.id
    errorMessage.value = ''
    try {
      const result = await multitableClient.installTemplate(template.id, {
        baseName: opts?.baseName ?? `${template.name} Base`,
      })
      const sheet = result.sheets[0]
      const view = result.views.find((v) => v.sheetId === sheet?.id) ?? result.views[0]
      if (!sheet || !view) {
        errorMessage.value = '模板已创建，但默认视图尚未就绪。请刷新后重试。'
        return { installed: result.base, openTarget: null }
      }
      await router.push({
        name: AppRouteNames.MULTITABLE,
        params: { sheetId: sheet.id, viewId: view.id },
        query: { baseId: result.base.id },
      })
      return { installed: result.base, openTarget: { sheet, view } }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '模板创建失败'
      return null
    } finally {
      installingTemplateId.value = null
    }
  }

  return { installingTemplateId, errorMessage, installAndOpen }
}
```

---

## 4. Deliverables

### 4.1 H2 PR 交付

- `docs/development/multitable-template-center-h2-development-20260518.md` **（本文档）**
- `docs/development/multitable-template-center-h2-verification-20260518.md`（实现完成后产出）
- `/multitable/templates` 页面 + 路由
- Home 页面 "查看全部模板" 入口
- `MultitableWorkbench.vue` modal 内的卡片统一 + footer link
- Frontend 目标测试（§5.1 列表）

### 4.2 H3 PR 交付

- `docs/development/multitable-industry-templates-h3-development-20260518.md`（H3 开始时产出）
- `docs/development/multitable-industry-templates-h3-verification-20260518.md`（实现完成后产出）
- `template-library.ts` 5 个新模板扩充
- 后端模板库 unit test + API integration test expected ids 更新

---

## 5. Test Plan

### 5.1 H2 targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-template-center-view.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-home-view.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/platform-shell-nav.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check origin/main..HEAD
```

### 5.2 H2 Acceptance Scenarios

- `/multitable/templates` loads templates from existing API
- Category filter narrows visible cards
- Search filters by name / description / category
- API load failure shows retryable error state
- Empty state appears when no templates returned
- "Installing..." state shows on clicked card during install
- Install success navigates directly to `/multitable/:sheetId/:viewId?baseId=...`
- Install failure shows error and does **not** navigate
- Home "查看全部模板" navigates to `/multitable/templates`
- Workbench modal "更多模板 →" navigates to `/multitable/templates`
- Existing Home install + Workbench install flows **unchanged** (no regression)

### 5.3 H3 targeted tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-template-library.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/multitable-context.api.test.ts
git diff --check origin/main..HEAD
```

### 5.4 H3 Acceptance Scenarios

- `listMultitableTemplates()` includes the new 5 template ids
- Each new template installs successfully
- Installed template creates expected sheets / fields / views
- Each template has ≥ 5 fields, ≤ 8 fields, ≥ 2 views (≥ 1 grid + ≥ 1 business view)
- Existing `project-tracker` / `sales-crm` / `issue-tracker` behavior remains **unchanged**
- No existing test fails (category strings, ids, fields all preserved for the 3 originals)

---

## 6. K3 PoC 阶段一锁定合规

| 检查项 | 状态 |
|---|---|
| `plugins/plugin-integration-core/**` 触动 | ❌ 不动 |
| `lib/adapters/k3-wise-*` 触动 | ❌ 不动 |
| `packages/core-backend/src/routes/integrations*.ts` 触动 | ❌ 不动 |
| `IntegrationWorkbenchView.vue` / `IntegrationK3WiseSetupView.vue` 触动 | ❌ 不动 |
| `/api/multitable/*` 契约改动 | ❌ 路径 / 请求体 / 响应字段 / 状态码全部不变 |
| `/api/spreadsheets/*` 契约改动 | ❌ 不动 |
| 数据库 migration | ❌ 零新增 |
| 触发"平台化"红线（workspace shell / 租户隔离 / marketplace） | ❌ 用户级体验 + hard-coded 模板，不涉及平台化 |

按 [Integration ERP Platform Roadmap (2026-04-25)](./integration-erp-platform-roadmap-20260425.md) 的阶段一锁定条款：

- 阶段一明确"不开新战线、不投入平台化代码"，但允许"内核打磨"已发布功能
- H1 → H2 → H3 是多维表内核（已 ship 的 home + template 能力）的延续打磨，非新产品面
- 用户级收藏 / 用户级最近打开 已在 H1 落地（属于"内核打磨"允许范围）
- 组织级模板发布 / 模板市场 / 计费 = 平台化 = 阶段三 = 本设计**不**触及

---

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| `MetaTemplateCard` 抽取破坏 Home view 现有渲染 | 低 | 抽取前 snapshot 测试 Home view；抽取后 DOM 结构 diff 比对 |
| `useTemplateInstall` 替换两处时漏一处 | 低 | grep `installTemplateAndOpen` 全仓确认；分多 commit 替换（先 Home 后 Center） |
| 路由 `/multitable/templates` 与现有 `/multitable/:sheetId/:viewId` 冲突 | 极低 | 字面量路由优先于参数路由（Vue Router 4 默认顺序）；platform-shell-nav.spec.ts 增加保护断言 |
| H3 新模板 install 后字段类型 / 视图类型不匹配 | 低 | 每个 H3 模板手测安装一次；参考已 production-proven 的 `project-tracker` 结构 |
| 分类 tab 数量增长（H3 后 7+ 类）UI 溢出 | 极低 | tab 横向滚动 / wrap；CSS `overflow-x: auto` |
| category 翻译表 fallback 失败 | 极低 | 未命中翻译时直接显示原英文字符串，永不失败 |

---

## 8. Assumptions

- 使用普通 branch，不开 worktree
- H2 不加后端 API、DB 表、migration、OpenAPI 契约
- H3 沿用静态模板库（`template-library.ts`），因当前 codebase **无** `multitable_templates` DB 表使用
- Spreadsheets 仍为附属能力，**不**在 H2/H3 范围
- Phase C `/grid` route removal 等已文档化的观察窗口（见 #1646），**不**与 H2/H3 捆绑
- K3 / `plugin-integration-core` / Data Factory 路径全程不动
- 现有 3 个模板的 `id` / `category` / 结构字段全部保持不变（H3 acceptance scenarios 守护）

---

## 9. 推荐执行顺序

1. **审本 development MD**（你现在做的）
2. 审过 → 起 H2 实现 commits（按 §3.1 / §3.2 文件清单）
3. H2 实现完 → 写 verification MD（`multitable-template-center-h2-verification-20260518.md`）
4. H2 PR 走 CI + self-review → admin-merge
5. H2 merge 后立即起 H3 分支（独立 PR）
6. H3 写 H3-development MD → 实现 → 写 H3-verification MD → CI + self-review → merge

---

## 10. 附录：Scout 报告原文

### 10.1 H1 已 ship 的 surface（`MultitableHomeView.vue`）

| 元素 | 现状 |
|---|---|
| Hero + 创建新 Base 表单 + 创建并打开 | ✅ |
| Base 列表 + 搜索 + 收藏 + 最近打开 | ✅ |
| **模板快速开始** section（template grid + install + redirect 全流程） | ✅ |
| `installTemplateAndOpen()` | ✅ POST install → 用返回的 base/sheet/view `router.push` |

### 10.2 Workbench template library（`MultitableWorkbench.vue:64-91`）

- ✅ 顶部 "📁 Templates" 按钮 + modal + grid + install + redirect
- ❌ 无分类导航 / 搜索（**不在 H2 修复范围**，仅 swap card + 加 footer link）

### 10.3 后端 API（全部就绪）

| 路由 | 文件位置 |
|---|---|
| `GET /api/multitable/templates` | `packages/core-backend/src/routes/univer-meta.ts:3163` |
| `POST /api/multitable/templates/:templateId/install` | `packages/core-backend/src/routes/univer-meta.ts:3167` |
| `listMultitableTemplates()` 静态数据源 | `packages/core-backend/src/multitable/template-library.ts:229` |

### 10.4 现有 3 个模板

| ID | Category | Sheets | 测试用途 |
|---|---|---|---|
| `project-tracker` | `Project management` | 1 (Tasks) | H3 acceptance "existing behavior unchanged" 基准 |
| `sales-crm` | `Sales` | 1 (Deals) | 同上；**不**重命名 category 为 CRM |
| `issue-tracker` | `Engineering` | 1 (Issues) | 同上 |

### 10.5 路由与 DB

- ❌ `/multitable/templates` 路由**不存在**（H2 新增）
- migration `042d_plugins_and_templates.sql` 仅创建 `plugin_manifests` / `plugin_dependencies`，**多维表模板不走数据库**

---

## 11. 变更日志

- **2026-05-18 (1)** 初稿 `multitable-template-center-design-20260518.md`
- **2026-05-18 (2)** 评审修订 8 处（Workbench 不抽 composable、memory 路径替换、H3 category 不重命名、AppRouteParams 补 typing、MetaTemplateCard 纯展示、测试 spec 拆分、Workbench 最小改动、验证命令格式）
- **2026-05-18 (3)** 融合 zensgit 的开发计划版本，重命名为 `multitable-template-center-h2-development-20260518.md`：
  - 顶层结构对齐 repo PR 模板风格（Summary / Key Changes / Deliverables / Test Plan / Assumptions）
  - 命名对齐 repo `*-development-*.md` / `*-verification-*.md` 惯例
  - H3 模板数 4 → 5（加 `meeting-minutes`），并加质量门（≥5 字段 ≤8、≥2 views 含 grid + 业务视图）
  - 搜索字段从 name/description 扩展到 name/description/category 三字段
  - 状态分支明确列出（空 / 加载 / 错误 / 安装中）
  - 新增 `apps/web/src/multitable/utils/category-labels.ts` 翻译映射文件，解决"CRM 显示语义 vs Sales 数据稳定"的矛盾
  - 加 Assumptions section
  - Acceptance scenarios 改为 bullet list（便于 PR description 复用）
  - 验证命令统一为 `pnpm --filter @metasheet/web exec vitest run ... --watch=false` 格式
