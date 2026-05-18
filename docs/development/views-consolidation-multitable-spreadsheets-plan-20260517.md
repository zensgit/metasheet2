# 多维表 / 电子表格 / Grid 三层整合方案

- **日期**：2026-05-17（产品方向决策于 2026-05-18 确认）
- **作者**：(by-discussion)
- **范围**：`apps/web/src/views/`、`apps/web/src/multitable/`、`packages/core-backend/src/routes/{spreadsheets,univer-meta,views,kanban}.ts`、`plugins/plugin-view-*`
- **约束**：受 [K3 PoC 阶段一锁定](./integration-erp-platform-roadmap-20260425.md) 约束（详见 §1）；本方案的 Phase A/B/C/E 属"内核打磨"；Phase D 缩减为"最小可用 1 PR"；Phase F 需 GATE PASS 后启动
- **状态**：
  - 产品方向已锁定（2026-05-18）
  - **Phase A 已完成**（merged via #1639 — `feat(multitable): complete views nav consolidation`；`resolveHomePath()` 已切到 `/multitable`）
  - **Phase H1 大部分已完成**（multitable 首页 home recents / favorites / search / template quickstart / default entry 已合到 main，详见 §11 已实现状态）
  - **Next executable phase: Phase B**（Grid 退役 + 配套清理，合并原 B + C1；详见 §3 Phase B）
  - Phase E（ViewManager / legacy views 选择性退役）必须独立 PR，**不可与 B 混合**（ViewManager 仍被多维表 contract test 守护，参 §0.2）
  - Phase D：**暂缓**。电子表格作为附属能力不在飞书对标主路径上；渲染器/license 启动前需做 package audit，不依赖本文档草案锁死
- **产品定位**：多维表为主产品，电子表格为附属能力，Grid 退役为兼容层（详见 §2 与 §11）

---

## TL;DR

仓库当前实际存在 **4 套"做表格"的栈**（不是 3 套），互相切割得不清晰，构成持续的认知负担：

1. **多维表**（Multitable）— `/api/multitable/*` + `apps/web/src/multitable/*`，6+ 视图共享 `MetaCellRenderer/MetaCellEditor`，M0–M5 已完成，是产品的活骨干
2. **电子表格**（Spreadsheets）— `/api/spreadsheets/*` + 服务端 A1 公式引擎，后端完整、前端只剩 CRUD 表单
3. **通用 Views 桥**（Generic Views Bridge）— `/api/views/:viewId/{config,data,state}` + `view-config-registry` + `ViewManager`，被 4 个顶层 legacy 视图（KanbanView/CalendarView/GalleryView/FormView）和 `plugin-view-calendar/gallery` 共用
4. **GridView**（`/grid`）— 自己手写 HTML 表格，写入 Spreadsheets 后端但用自己的客户端公式引擎，夹在中间没有归属

**终态（2026-05-18 决策）**：收敛到 **主产品 + 附属能力 + 兼容层** 三层结构：

- **主产品：多维表 Workbench**（默认入口）—— 解决业务数据管理。字段、记录、视图、表单、层级、甘特、自动化、权限、评论、公式字段、模板。用户心智："像飞书多维表一样管理业务对象"
- **附属能力：电子表格 Spreadsheets**（弱化，不抢主入口）—— 自由单元格 + A1 公式，用于财务测算、临时表、自由排版、公式工作簿。UI 仅做到"最小可用"；后续作为多维表的"关联能力"露出，**不与多维表并列竞争**
- **兼容层：Grid**（不作为产品）—— 仅保留 deep link 与历史数据迁移通道；最终目标是 route gate 后删除

**实现路径**：
- 多视图（Grid/Kanban/Calendar/Gallery/Form/Gantt/Hierarchy）作为"同一张表的视图"，不是独立产品 —— 删 4 个顶层 legacy 视图
- 多维表视图类型走插件机制（已有 `plugin-view-calendar/gallery` 脚手架，Phase F 扩展）
- 模板中心作为上手路径（项目 / CRM / 合同 / 巡检 / 招聘…），是飞书对标的关键
- 删除 GridView、ProfessionalGridView、EnhancedGridView、TestFormula、plugin-view-grid、4 个顶层 legacy 视图

**当前状态**：Phase A 已完成（#1639）、Phase H1 大部分已完成。
**下一步**：Phase B — Grid 退役合并 PR（`/grid` → `/multitable` redirect + 删 GridView + 删 Grid 耦合死代码）。约 1 天，零 K3 风险，能减少约 3500 行代码。后续 Phase C（≥ 7 天观察 + redirect 命中归零后；详见 §3 Phase C）删 `/grid` redirect 本身。

---

## 0. 当前状态盘点（基于 2026-05-17 仓库 grep）

### 0.1 各栈的真实大小与归属

| 栈 | 后端入口 | 前端入口 | 行数 | 状态 |
|---|---|---|---|---|
| 多维表 | `packages/core-backend/src/routes/univer-meta.ts:1` (7893 行) + `packages/core-backend/src/multitable/*.ts` | `apps/web/src/multitable/views/MultitableEmbedHost.vue` + `MultitableWorkbench.vue` | 7893+ 后端 / ~3000 前端视图 | **活跃** |
| 电子表格 | `packages/core-backend/src/routes/spreadsheets.ts:1` (515 行) + `packages/core-backend/src/formula/engine.ts:130` (1084 行) | `apps/web/src/views/SpreadsheetsView.vue` + `SpreadsheetDetailView.vue` | 后端完整 / 前端 ~CRUD | **半成品** |
| 通用 Views 桥 | `packages/core-backend/src/routes/views.ts:66` + `packages/core-backend/src/core/{view-config-registry,view-data-registry,default-view-data-provider}.ts` | `apps/web/src/services/ViewManager.ts` + `apps/web/src/views/{Kanban,Calendar,Gallery,Form}View.vue` (4696 行合计) | 中等 | **混合**（参 §0.2） |
| GridView | 复用 `/api/spreadsheets/*` | `apps/web/src/views/GridView.vue` (2455 行) | 中等 | **夹层** |

### 0.2 通用 Views 桥的微妙混合性

按 `docs/multitable-view-compat-matrix.md`：

- 多维表 6 个视图**全部**从 `/api/multitable/view` 取数据，**不**使用 `/api/views/:viewId/data`
- `/api/views/:viewId/config` 由 `plugin-view-calendar/gallery` 注册的 `ViewConfigProvider` 服务 —— 但服务的是"旧 Univer 层"，不是多维表
- `ViewManager.ts` 是个混合体：`loadViewConfig`/`createView`/`updateView`/`deleteView` 等方法走 `MultitableApiClient`；`loadViewData`/视图状态方法走 legacy `/api/views/:viewId/data` 桥
- `apps/web/tests/view-manager-multitable-contract.spec.ts` 测的就是 ViewManager 的多维表面（说明这部分仍在维护）

**结论**：通用 Views 桥不能整体删除，只能选择性退役 `loadViewData`/`/state` 部分 + 顶层 legacy 视图。`view-config-registry` 与 `plugin-view-calendar/gallery` **保留**，作为未来视图插件化的脚手架。

### 0.3 死代码核对（**2026-05-18 修正：基于 origin/main，不是旧分支**）

> **修正背景**：先前版本基于"旧分支 grep"做的核对存在偏差。在 origin/main 上（#1639 已落地后）：
> - `appRoutes.ts:4,55-57` 仍 import GridView 并以 `component:` 形式挂在 `/grid`（仅加 `deprecated: true`，未改 redirect）
> - `apps/web/src/plugins/viewRegistry.ts:6,15,25` 注册 GridView
> - `apps/web/src/view-registry.ts:4` lazy import GridView
> - `apps/web/tests/grid-view-cell-version-wiring.spec.ts` 直接测 GridView
> - `apps/web/src/utils/formulaEngine.ts` 被 `GridView.vue:262` **和** `TestFormula.vue:55` 同时消费
> - `plugins/plugin-view-grid/` 无 `package.json` / `manifest.json`，PluginLoader 扫到时仅在日志吐 `Manifest validation failed for plugin-view-grid`（不阻断启动）

| 文件/目录 | origin/main 上的耦合 | 是否可独立删 | 处理归属 |
|---|---|---|---|
| `apps/web/src/views/ProfessionalGridView.vue` | 无 prod 引用 | ✅ 可独立删 | Phase B（同 PR） |
| `apps/web/src/views/EnhancedGridView.vue` | 无 prod 引用 | ✅ 可独立删 | Phase B（同 PR） |
| `apps/web/src/views/TestFormula.vue` | 未在路由；但 import `formulaEngine.ts` | ⚠️ 与 `formulaEngine.ts` 同步删 | Phase B（同 PR） |
| `apps/web/src/utils/formulaEngine.ts` | 被 GridView.vue + TestFormula.vue 消费 | ❌ 不可独立删 | Phase B（与 GridView 一起退役） |
| `apps/web/src/views/GridView.vue` | `/grid` route component + viewRegistry + view-registry + test | ❌ 必须 Grid 退役一并处理 | Phase B（合并原 C1） |
| `plugins/plugin-view-grid/**` | 无 workspace package；PluginLoader 仅日志告警 | ⚠️ 删时需确认日志不再吐错 | Phase B（同 PR） |
| `apps/web/src/types/x-data-spreadsheet.d.ts` | 仅 ProfessionalGridView 用 | ⚠️ 随 ProfessionalGridView 一起删 | Phase B（同 PR） |
| `apps/web/tests/grid-view-cell-version-wiring.spec.ts` | 测 GridView | ❌ 与 GridView 一起删/调整 | Phase B（同 PR） |

### 0.4 公式引擎碎片化

仓库当前同时存在 **4 个**公式引擎实现：

| 引擎 | 路径 | 作用域 | 状态 |
|---|---|---|---|
| 服务端 A1 公式 | `packages/core-backend/src/formula/engine.ts:130` | 电子表格 cells | 活 |
| 多维表字段公式 | `MultitableFormulaEngine` (在 `univer-meta.ts:172`) | 多维表 field formula | 活 |
| 前端 grid 客户端 | `plugins/plugin-view-grid/src/formulaEngine.ts` | 无人消费 | **死** |
| 前端 util 客户端 | `apps/web/src/utils/formulaEngine.ts` | 被 `GridView.vue:262` + `TestFormula.vue:55` 消费 | **随 Phase B 一并删除**（与 Grid 退役同 PR） |

Phase B 后变成 2 个；Phase F1 后变成 1 个公共包 + 2 个领域适配器。

---

## 1. K3 PoC 阶段一锁定合规性

**约束来源**：`/Users/chouhua/.claude/projects/.../memory/project_k3_poc_stage1_lock.md` + `docs/development/integration-erp-platform-roadmap-20260425.md`。

**全程不动**：
- `plugins/plugin-integration-core/**`
- `packages/core-backend/src/routes/integrations*.ts`
- `lib/adapters/k3-wise-*`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `/api/multitable/*` 路径/请求体/响应字段/状态码（**契约**不变，实现可重构）—— K3 数据工厂依赖多维表清洗管道

**每个 PR 必须包含**：

```markdown
## K3 PoC 阶段一锁定影响
- [ ] git diff --name-only 未命中 plugins/plugin-integration-core/
- [ ] git diff --name-only 未命中 lib/adapters/k3-wise-*
- [ ] git diff --name-only 未命中 packages/core-backend/src/routes/integrations*.ts
- [ ] /api/multitable/* 契约未变（路径 / 请求 / 响应 / 状态码）
- [ ] /api/spreadsheets/* 契约未变
```

**阶段映射**：

| Phase | 阶段一是否允许 | 理由 |
|---|---|---|
| A. 导航与产品语义校正 | ✅ 允许 | 纯打磨，仅前端 nav DOM |
| B. Grid 退役 + 配套清理（合并原 B + C1） | ✅ 允许 | 路由改 redirect、删 GridView 与 Grid 耦合死代码；不动 `/api/spreadsheets` 契约 |
| C. /grid redirect removal | ✅ 允许 | ≥ 7 天观察 + redirect 命中归零后删除 redirect 配置本身（详见 §3 Phase C） |
| D. 电子表格 UI 升级 | ⚠️ 判断题 | 路由 + 后端 + 公式引擎已 ship，UI 补全属打磨；但范围易越界（见 §3.4） |
| E. 删通用 Views 桥（选择性） | ✅ 允许 | 仅删 4 个 legacy 视图 + ViewManager 的 legacy 桥部分 |
| F. 公式引擎合并 / 多维表视图插件化 | ❌ **GATE PASS 后** | 触动多维表内核（`MultitableFormulaEngine`）+ 开 platform 化战线 |

---

## 2. 终态架构（北极星）

```
┌─────────────────────────────────────────────────────────────┐
│                          用户                                │
└──────┬───────────────────────────┬───────────────────┬──────┘
       │ (默认入口)                │ (工具/更多)        │ (兼容)
       ▼                           ▼                   ▼
┌──────────────────┐    ┌──────────────────┐  ┌──────────────┐
│ 主产品           │    │ 附属能力         │  │ 兼容层       │
│ 多维表 Workbench │    │ 电子表格         │  │ Grid         │
│                  │    │ Spreadsheets     │  │              │
│ /multitable      │    │                  │  │ /grid        │
│ /multitable/     │    │ /spreadsheets/   │  │              │
│   :sheetId/:viewId│    │   :id            │  │ (route gate) │
│                  │    │                  │  │              │
│ 心智:            │    │ 心智:            │  │ 心智: 无     │
│  业务对象管理    │    │  自由单元格      │  │  仅做兼容    │
│  行 × 字段 ×     │    │  A1 公式         │  │  跳转        │
│  多视图同源      │    │  公式工作簿      │  │              │
│                  │    │                  │  │              │
│ 包含:            │    │ 范围:            │  │ 行为:        │
│  - 首页(§3.5)    │    │  - 最小可用 UI   │  │  - 隐藏入口  │
│  - Workbench     │    │  - 财务/临时表   │  │  - localStor │
│  - 模板中心      │    │  - 不做协作      │  │    或列表跳转│
│  - Grid/Kanban/  │    │  - 不做导入导出  │  │  - 最终删除  │
│    Calendar/     │    │  - 不做图表      │  │              │
│    Gallery/Form/ │    │                  │  │              │
│    Gantt/        │    │ 连接点（Phase F3）│  │              │
│    Hierarchy     │    │  ← 多维表导出    │  │              │
│  作为同张表视图  │    │  ← 多维表引用    │  │              │
└────────┬─────────┘    └────────┬─────────┘  └──────┬───────┘
         │                       │                    │
         ▼                       ▼                    ▼
┌──────────────────┐    ┌──────────────────┐  ┌──────────────┐
│ /api/multitable/*│    │ /api/spreadsheets│  │ (复用左侧两  │
│                  │    │      /*          │  │  支柱的 API) │
│ meta_* 表        │    │ spreadsheets,    │  │              │
│                  │    │ sheets, cells,   │  │              │
│ MultitableFormula│    │ formulas,        │  │              │
│   Engine (字段)  │    │ cell_versions,   │  │              │
│                  │    │ named_ranges     │  │              │
│                  │    │                  │  │              │
│                  │    │ FormulaEngine    │  │              │
│                  │    │   (A1 单元格)    │  │              │
└──────────────────┘    └──────────────────┘  └──────────────┘

视图类型扩展（多维表内部）：view-config-registry + plugin-view-*
跨支柱（Phase F3, GATE 后）：单向只读引用，多维表 → 电子表格命名区域
```

**边界规则（不变量）**：

1. **主入口属于多维表**。`resolveHomePath()` 默认进多维表首页（§3.5），不是电子表格
2. **业务数据管理（PLM / 考勤 / 订单 / 外勤 / 巡检 / CRM…）→ 多维表**；以"模板"为上手路径（§3.5）
3. **自由公式工作表（财务测算 / 临时表 / 公式工作簿）→ 电子表格**；放在"工具 / 更多"或多维表内的"导出/引用"，不与多维表并列
4. **多视图（Grid/Kanban/Calendar/Gallery/Form/Gantt/Hierarchy）属于多维表的视图维度**，不是独立产品。任何顶层 `/kanban`、`/calendar`、`/gallery`、`/form` 路由都应在 Phase E 退役
5. **Grid 不是产品**。`/grid` 仅做兼容跳转，不再新增功能，最终删除（Phase C）
6. **唯一允许的跨支柱**：Phase F3（GATE PASS 后）引入"电子表格 ← 多维表命名区域引用"——单向只读

---

## 3. 七阶段执行表

### Phase A — 导航与产品语义校正 — **已完成（2026-05-18，#1639）**

- **状态**：✅ merged via [#1639](https://github.com/zensgit/metasheet2/pull/1639) `feat(multitable): complete views nav consolidation`
- **实际改动**：
  - 顶层 nav 移除 `/grid /kanban /calendar /gallery /form` 五条
  - legacy 路由保留但加 `deprecated` metadata
  - 多维表升为默认入口
  - 配套验证文档落地：
    - `docs/development/views-consolidation-nav-positioning-development-20260518.md`
    - `docs/development/views-consolidation-nav-positioning-verification-20260518.md`
- **目标**：让用户在导航上看见"两支柱"，不再误以为 Grid/Kanban/Calendar/Gallery/Form 是 5 个独立产品
- **PR 数**：1
- **体量**：XS（实际 245 行，含验证文档）
- **风险**：极低
- **阶段一**：允许

**改动**：

1. `apps/web/src/App.vue:20-25`：删除 5 条 `<router-link>`（`/grid`、`/kanban`、`/calendar`、`/gallery`、`/form`），替换为一条"多维表"入口（指向 `/multitable/...` 默认 sheet）；`/spreadsheets` **不**升为顶层 nav 入口，保留 `/spreadsheets` 路由作为附属能力（从工具/更多或 `/spreadsheets` 直接 URL 进入）
2. `apps/web/src/router/appRoutes.ts:54-82`：5 个 legacy 路由保留 component 不变，仅在 `meta` 加 `deprecated: true`（不做 redirect 以免破坏 deep link）
3. `apps/web/src/stores/featureFlags.ts` 的 `resolveHomePath()` 默认值已改为 `/multitable`（在 #1639 中完成）
4. 加 i18n key：`navLabels.multitable` / `navLabels.spreadsheets`（中英双语）

**验证**：

- `pnpm --filter @metasheet/web build`
- `apps/web/tests/platform-shell-nav.spec.ts` —— 同步更新（该文件 L30/L31/L116/L117 引用 `/grid`，是 mock 数据）
- 手测：登录后 nav 上只看到"多维表 / 电子表格 / 审批 / 考勤 / 工作流 / ..."

**回退**：单 PR revert。

---

### Phase B — Grid 退役 + 配套清理（**2026-05-18 合并原 B + C1**）

- **目标**：单 PR 完成 Grid 退役（route redirect + 删 GridView.vue + 全部 Grid 耦合死代码）。保留 `/spreadsheets/*` 与后端契约不动
- **PR 数**：1
- **体量**：M（~3500 行删除 + 5 行 redirect 配置）
- **风险**：低（明确不动 spreadsheets 后端 / 不动 ViewManager 桥）
- **阶段一**：允许

> **为什么合并原 B + C1**（2026-05-18 修正）：先前文档把"死代码清理（B）"与"`/grid` redirect（C1）"分开，但 origin/main 上 GridView.vue 仍是 `/grid` 的 component route，且 `utils/formulaEngine.ts` 同时被 GridView 与 TestFormula 消费；`plugins/plugin-view-grid/` 也被 PluginLoader 扫描。这些不是"孤立死代码"，必须与 `/grid` 退役一起处理才安全。

#### 范围（同 PR 内全做）

**路由层**：

```ts
// apps/web/src/router/appRoutes.ts
- import GridView from '../views/GridView.vue'    // 删
- { path: '/grid', name: 'grid', component: GridView, meta: { ... } }
+ { path: '/grid', redirect: '/multitable', meta: { deprecated: true, retireBy: '2026-06-30' } }
```

**视图注册**：

- `apps/web/src/plugins/viewRegistry.ts:6,15,25` —— 移除 GridView import 与注册
- `apps/web/src/view-registry.ts:4` —— 移除 lazy import 条目

**删除的文件**：

| 文件 | 处理 |
|---|---|
| `apps/web/src/views/GridView.vue` | 删除（不再被路由引用） |
| `apps/web/src/views/ProfessionalGridView.vue` | 删除（无 prod 引用） |
| `apps/web/src/views/EnhancedGridView.vue` | 删除（无 prod 引用） |
| `apps/web/src/views/TestFormula.vue` | 删除（仅在 lint 列表 + 唯一另一个 formulaEngine.ts 消费者） |
| `apps/web/src/utils/formulaEngine.ts` | 删除（前两个消费者已删除） |
| `apps/web/src/types/x-data-spreadsheet.d.ts` | 删除（仅 ProfessionalGridView 用） |
| `plugins/plugin-view-grid/**` | 删除整目录（无 workspace package / 无 manifest） |
| `apps/web/tests/grid-view-cell-version-wiring.spec.ts` | 删除（测的是 GridView） |

**附带改动**：

- `apps/web/package.json` lint 命令去掉 `TestFormula.vue`
- `pnpm-lock.yaml` 重生成（移除 plugin-view-grid workspace 解析）
- `apps/web/package.json` 移除 `x-data-spreadsheet` 依赖（Phase D 启动前重新评估渲染器）
- 验证 `packages/core-backend/backend-startup.log` 不再吐 `Manifest validation failed for plugin-view-grid`

#### 不在范围（避免越界）

| 不做的事 | 原因 / 推到哪 |
|---|---|
| 删 `/grid` route 本身（仅留 redirect） | 留作兼容跳转 1-2 版本，避免内部书签/旧文档 404 → Phase C |
| 删 ViewManager / legacy CalendarView/GalleryView/FormView | 仍被多维表 contract test 守护 → Phase E（独立 PR） |
| 删 `/api/views` / `/api/kanban` 后端 | 与 ViewManager 一同处理 → Phase E2 |
| 改 `/api/spreadsheets/*` 契约 | 保持不动；与 Phase D 决策解耦 |

#### 验证

- 全量构建：`pnpm -r build`
- 类型 / lint：`pnpm --filter @metasheet/web typecheck` + ESLint
- 测试：`pnpm --filter @metasheet/web test`（确认 `grid-view-cell-version-wiring.spec.ts` 已删除，无遗留 import 错误）
- 后端：`pnpm --filter @metasheet/core-backend test`（不应受影响）
- 启动日志：本地启 backend，确认无 `Manifest validation failed for plugin-view-grid` 输出
- E2E：
  - 访问 `/grid` → 立即 redirect `/multitable`
  - 访问 `/spreadsheets` 与 `/spreadsheets/:id` 仍正常
  - 既有 "Grid Workspace" spreadsheet 数据仍能从 `/spreadsheets` 列表打开
- 契约：`/api/spreadsheets/*` 行为不变；`packages/core-backend/tests/integration/spreadsheet-integration.test.ts` 全过

**回退**：单 PR revert。无 DB 改动、无后端契约改动；最坏情况是恢复 GridView 但路由仍指向 redirect —— 需要再发一个补丁回退路由。

---

### Phase C — 删除 `/grid` 路由（数据驱动观察后）

- **目标**：Phase B 上线 ≥ 7 天 + redirect 命中归零（或无内部失效报告）→ 删除 `/grid` redirect 配置本身
- **PR 数**：1
- **体量**：XS（删除 1 行路由配置）
- **风险**：极低
- **阶段一**：允许

> **2026-05-18 (5) 调整**：原 30 天观察期为保守默认值。本项目无大规模生产用户群（K3 PoC 外无外部用户），且 Phase A (#1639) 已将 `/grid` 从 nav 移除，新用户无暴露面。观察窗口由 30 天缩短为 **≥ 7 天 + 数据/质量信号双轨**。`retireBy: '2026-06-30'` meta 保持不变作为硬上限。

#### 触发条件（任一满足即可启动）

- **A. 数据信号**：Phase B 已 merged **≥ 7 天**，且反向代理 access log 显示 `/grid` 命中 = 0 连续 5 天
- **B. 质量信号**：Phase B 已 merged **≥ 10 天**，且无内部 docs / wiki / Issues / Slack 报告 `/grid` 失效
- **C. 硬上限**：不晚于 `meta.retireBy = 2026-06-30`（不管 A / B 是否满足）

#### 改动

- 删除 `apps/web/src/router/appRoutes.ts` 的 `/grid` redirect 项
- 触发 catch-all `not-found` 路由（已存在）
- 检查 `apps/web/src/utils/spreadsheetCellVersions.ts` —— 确认只剩 SpreadsheetDetailView 使用（如有遗留可一并清）

**回退**：单 PR revert（恢复 redirect 一行）。

---

### Phase D — 电子表格最小可用 UI — **暂缓（2026-05-18）**

- **状态**：⏸ **暂缓**。电子表格作为附属能力不在飞书对标主路径上；与多维表 H2/H3、E1/E2、F 系列相比优先级最低
- **解锁条件**：(a) 用户对"电子表格能用"有明确诉求 或 (b) 多维表 → 电子表格连接点（Phase F3）开始落地需要前置
- **启动前必须做的 audit**：
  - `npm view handsontable license` + 读最新 EULA，确认 BSD CE 版仍存在（2019 年起许可证有调整）
  - 对比 x-data-spreadsheet 最近活跃度（commits / issues / 安全公告）
  - 评估是否直接跳到 Univer（apps/web-react 已有实验）
- **目标**：让 `SpreadsheetDetailView.vue` 从 "CRUD 表单"变成"能用"，作为附属能力存在 —— **不追求 Excel 替代**
- **PR 数**：1
- **体量**：S（1–2 天）
- **风险**：低（明确不做协作 / 图表 / 导入导出）
- **阶段一**：允许（内核打磨已发布功能；范围明确不越界）

> **2026-05-18 缩减决策**：电子表格定位为"附属能力"，不是主推产品。Phase D 只做"最小可用"，**不**做协作 / 图表 / 数据透视 / 导入导出 / 命名区域 UI。原"判断题"在 §6 决策 1 已答"否"。
>
> **2026-05-18 进一步暂缓**：暂缓启动；待解锁条件满足时再做 package/license audit + 重启。当前 `SpreadsheetDetailView` 保留 CRUD 表单 UI；建议在该页加一行 "（实验性 / 完整 UI 尚未实现）" 提示。

#### 范围（仅这些）

- 引入 **handsontable** BSD CE 版（推荐）或复用现有 `x-data-spreadsheet`
- 重写 `apps/web/src/views/SpreadsheetDetailView.vue`：
  - 顶栏：sheet tabs + 保存状态 + 公式栏
  - 主体：渲染当前 sheet（行列编辑）
  - 编辑：单元格 onChange → dirty batch → 5s/失焦 → `PUT /api/spreadsheets/:id/sheets/:sheetId/cells`
  - 公式：`=` 开头 → 当 formula 字段提交；后端 `FormulaEngine` 算结果回写
  - 版本冲突：复用 `apps/web/src/utils/spreadsheetCellVersions.ts` 的 `expectedVersion`
- 不动后端，仅消耗已有 API
- **入口降级**：导航不放在第一层（参 §3.5 / §11），从"工具 / 更多"或 `/spreadsheets` 列表页进入

#### 明确不做（防止越界）

| 不做项 | 推到哪 |
|---|---|
| 协作 / WebSocket / Yjs 同步 | Phase F（GATE 后评估） |
| 条件格式 UI | 不在规划内 |
| 图表 / 数据透视 | 不在规划内 |
| 命名区域 UI | Phase F |
| 复杂剪贴板 / 撤销栈 | 不在规划内 |
| Excel 导入导出（.xlsx） | 不在规划内（除非有强诉求） |
| Univer 集成 | Phase F；`apps/web-react` 实验保持隔离 |

#### 渲染器选型（已简化）

| 方案 | License | 包大小 | 决策 |
|---|---|---|---|
| **handsontable CE** | BSD | ~300KB | **推荐** —— API 稳定 / Vue 包装现成 |
| x-data-spreadsheet | MIT | ~150KB | 备选 —— 已在依赖里，但维护不活跃 |
| Univer | Apache | ~3MB | 推迟到 Phase F 评估 |
| Luckysheet | MIT | ~1.5MB | 否决 —— 维护停滞 |

#### 验证

- 新建 `apps/web/tests/spreadsheet-detail-ui.spec.ts`：渲染、编辑、保存、公式计算
- 后端契约不变，`spreadsheet-integration.test.ts` 不应改动
- 烟雾测试：从多维表的"导出到电子表格"连接点（Phase F3 预留）可以正常落地

---

### Phase H — 多维表首页 + 模板中心（新增，2026-05-18）

- **目标**：补齐主产品的两个"上手路径"——首页（最近 / 收藏 / 搜索 / 新建）+ 模板中心（行业模板）
- **PR 数**：3（H1 首页 + H2 模板中心 UI + H3 模板内容）
- **体量**：M
- **风险**：中（属于"扩展主产品"，需仔细划清和 platform 化的边界）
- **阶段一**：允许（属多维表内核打磨延续；详见下方边界声明）

> **为什么放在 Phase D 与 Phase E 之间**：电子表格 UI 升级（Phase D）和顶层 legacy 退役（Phase E）属于"清旧"；Phase H（多维表首页 + 模板中心）属于"立新"。两者顺序无依赖，可并行，但建议立新晚于清旧 ——避免新功能依附在被退役的入口上。

#### 阶段一合规边界（关键）

| 允许做 | 不可做（=platform 化，留给阶段三） |
|---|---|
| 用户级"最近打开"（localStorage 或 user_prefs 表） | 组织级 / 租户级模板发布、审核、订阅 |
| 用户级"收藏"（单个布尔列 + per-user） | 模板市场（marketplace） |
| 模板内容（PM / CRM / 合同 / 巡检 / 招聘 …）作为种子数据 | 模板计费、版本管理、依赖图 |
| 全文搜索 base / sheet / view 名称（DB LIKE 即可） | 跨租户搜索、向量搜索、AI 推荐 |
| 路由 `/multitable`（首页）+ `/multitable/templates`（模板中心） | 多租户隔离、SaaS 化路由 |

#### H1 — 多维表首页

新建 `/multitable`（无参）路由 → `MultitableHomeView.vue`：

- 最近打开：调用新 API `GET /api/multitable/recent`（user 维度，最近 N 条 sheet+view 访问）
  - 后端落 `multitable_user_visits(user_id, sheet_id, view_id, visited_at)` 表 —— 一张轻表 + 触发器在 view 访问时写入
- 收藏：调用新 API `GET /api/multitable/favorites` / `POST` / `DELETE`
  - 后端落 `multitable_user_favorites(user_id, target_type[base|sheet|view], target_id, created_at)`
- 模板入口：跳 `/multitable/templates`
- 新建 base：复用现有 `POST /api/multitable/bases`
- 搜索：复用 `MetaBasePicker` 的搜索能力或新写一个全局搜索 UI
- 主 CTA："新建多维表"（创建 base + 第一个 sheet + 第一个 grid view）

**先决**：
- `resolveHomePath()` 默认值改为 `/multitable`
- 新 DB 迁移 + Kysely 类型更新

#### H2 — 模板中心 UI

新建 `/multitable/templates` 路由 → `MultitableTemplateCenterView.vue`：

- 复用现有 `GET /api/multitable/templates` API
- 分类导航：项目管理 / CRM / 合同管理 / 巡检 / 招聘 / 通用（与 H3 模板内容对齐）
- 模板卡片：图标 + 名称 + 描述 + sheet/field 数量
- 安装按钮：`POST /api/multitable/templates/:id/install`
- 复用 `MultitableWorkbench.vue` 已有的 `mt-template-library` 模态作为底层组件

#### H3 — 模板内容（行业模板种子）

写实际模板到后端 seed：

| 类别 | 模板 | 字段数 | sheet 数 |
|---|---|---|---|
| 项目管理 | 任务追踪、Sprint 看板、里程碑 | 8–12 | 1–2 |
| CRM | 客户、商机、联系记录 | 10–15 | 2–3 |
| 合同管理 | 合同清单、付款节点、续约提醒 | 8–10 | 2 |
| 巡检 | 巡检任务、问题清单、整改记录 | 10–12 | 2–3 |
| 招聘 | 候选人、面试记录、Offer 跟进 | 12–15 | 2–3 |
| 通用 | 简单清单、知识库、问卷 | 5–8 | 1 |

**先决**：
- 模板格式参考 `packages/core-backend/src/multitable/provisioning.ts`（已有 install 流程）
- 模板存放：JSON seed 文件，部署时通过 `pnpm migrate` 或独立 seed 命令安装到 `multitable_templates` 表

#### 验证

- H1 / H2：UI E2E（playwright）覆盖首页加载、模板浏览、模板安装、收藏新增删除
- H3：每个模板手测安装一次，确认字段类型、视图类型、记录种子数据正确

**回退**：每个 PR 独立 revert；H3 模板数据可 SQL DELETE 回滚。

---

### Phase E — 通用 Views 桥选择性退役

- **目标**：删 4 个顶层 legacy 视图 + ViewManager 中的 legacy 桥部分；保留 `view-config-registry` + plugin-view-calendar/gallery（多维表视图插件化的脚手架）
- **PR 数**：2（E1 + E2）
- **体量**：M
- **风险**：中（registry 公开 export，可能被 K3 流程外的 plugin 使用）
- **阶段一**：允许

> **产品级解释（2026-05-18）**：多视图（Grid/Kanban/Calendar/Gallery/Form/Gantt/Hierarchy）属于"同一张表的视图维度"，不是 7 个独立产品。当前仓库里同时存在两套 Kanban / Calendar / Gallery / Form 实现（顶层 `views/KanbanView.vue` vs 多维表 `MetaKanbanView.vue`），这是产品认知污染。Phase E 是把这个污染产品级地清掉，不只是"清死代码"。

> **修正**（vs 草拟版）：早先以为可以整体删 `routes/views.ts`，但 `ViewManager` 实际是混合体，其多维表面被 `apps/web/tests/view-manager-multitable-contract.spec.ts` 测试守护。所以策略调整为**选择性退役**。

#### PR E1 — 删 4 个 legacy 视图 + `apps/web/src/services/ViewManager.ts`

- 删 `apps/web/src/views/{Kanban,Calendar,Gallery,Form}View.vue`（4696 行）
- 删 `apps/web/src/services/ViewManager.ts` —— 但**先**：
  - `grep -rn "from.*services/ViewManager" apps/` 确认消费者
  - 把 ViewManager 中"走多维表"的方法（`createView`/`updateView`/`deleteView`/`getTableViews` 等）改名为 `MultitableViewService` 并迁到 `apps/web/src/multitable/services/`，让现有的 `view-manager-multitable-contract.spec.ts` 继续守护
  - 删除"走 legacy 桥"的方法（`loadViewData`/视图状态方法）
- `appRoutes.ts` 删 `/kanban`、`/calendar`、`/gallery`、`/form` 路由

#### PR E2 — 删 legacy 后端桥

- 删 `packages/core-backend/src/routes/kanban.ts`（仅 `KanbanView.vue:93` 一处 hardcoded fetch 使用）
- 改 `packages/core-backend/src/routes/views.ts` —— **保留** `/:viewId/config` 路由（plugin-view-calendar/gallery 仍注册 provider），**删除** `/:viewId/data` 和 `/:viewId/state` 路由
- `packages/core-backend/src/index.ts:970` 删 `app.use('/api/kanban', kanbanRouter())`
- **保留** `view-config-registry.ts` / `view-data-registry.ts` —— 作为内部插件机制
- **保留** `plugins/plugin-view-calendar/` / `plugins/plugin-view-gallery/`

**先决条件**：

- `grep -rn "/api/kanban\|/api/views/.*data\|/api/views/.*state" apps/ packages/ plugins/` 确认无其他消费者
- `grep -rn "getViewConfigRegistry\|getViewDataRegistry" plugins/` 确认 plugin 注册路径不被破坏

**回退**：E2 单 PR revert；E1 影响面较大，建议在 E1 merge 后冒烟 7 天再上 E2。

---

### Phase F — 公式引擎合并 & 多维表视图插件化（GATE PASS 后）

- **GATE 解锁条件**：K3 PoC GATE PASS（或用户明确"打破阶段一约束"）
- **触动范围**：多维表内核（`MultitableFormulaEngine`）；platform 化

#### F1 — 公式引擎抽公共包

- 新建 `packages/formula-core`：把 `packages/core-backend/src/formula/engine.ts` 的 parser、AST、function library、dep-graph、topological sort 抽出来
- `MultitableFormulaEngine` 改为 `formula-core` + 多维表字段引用适配层
- 电子表格 `FormulaEngine` 改为 `formula-core` + A1 引用解析层
- 单测：snapshot 测试守护两边的现有行为

#### F2 — 多维表视图类型插件化

- 把 `MetaGridTable` / `MetaFormView` / `MetaKanbanView` / `MetaGalleryView` / `MetaCalendarView` / `MetaTimelineView` 抽到独立 `plugins/plugin-view-*-multitable`（与现有 `plugin-view-calendar/gallery` 合并）
- `MultitableWorkbench.vue` 不再硬 import，而是从插件 registry 拉视图组件
- 这一步是阶段三 platform-化 的前置；落地后第三方开发者可以做新视图

#### F3 — 电子表格 ↔ 多维表 跨支柱桥

- 在 `cells` 表加 `external_ref` 字段：`{type:"multitable", sheetId, fieldId, queryConfig}`
- 单元格公式支持 `=MULTITABLE("sheetId", "field_x", filter)` 引用多维表数据
- 单向只读，避免反向同步噩梦

#### F4 — 渲染器统一

- 取决于 Phase D 选了哪个，删另一个
- 若选 Univer，则把 `apps/web-react` 实验代码合并进 `apps/web` 或转 Vue 包装

---

## 4. PR 拆分与命名

按 [`feedback_branch_convention`](../../../../.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/memory/feedback_branch_convention.md)：

| Phase | 分支 | Lane | 体量 | 依赖 | 状态 |
|---|---|---|---|---|---|
| A | `frontend/views-nav-rename-20260517` | frontend | XS | — | ✅ **已完成** via #1639 |
| B | `frontend/grid-retirement-20260519` | frontend | M | A | ⏭ **next executable**（合并原 B + C1 = `/grid` redirect + 删 GridView + 删 Grid 耦合死代码） |
| C | `frontend/grid-route-removal-20260527` | frontend | XS | B + ≥ 7 天观察 + 命中归零 | 待启动（删 `/grid` redirect 本身；硬上限 2026-06-30） |
| D | `frontend/spreadsheet-detail-*-20260521` | frontend | S | (无强依赖) | ⏸ **暂缓**；启动前 license audit |
| H1 | `frontend/multitable-home-20260522` | frontend | M | A | ✅ **大部分已完成**（home recents/favorites/search/template quickstart 已 merged，待核对清单见 §11） |
| H2 | `frontend/multitable-template-center-20260524` | frontend | M | H1 | 部分启动（workbench template quickstart 已合，独立 `/multitable/templates` 路由待启动） |
| H3 | `contracts/multitable-industry-templates-20260526` | contracts | S | H2 | 待启动 |
| E1 | `runtime/legacy-views-frontend-removal-20260601` | runtime | M | (H1 稳定后 / 与 B 独立) | 待启动 |
| E2 | `runtime/legacy-views-backend-bridge-removal-20260615` | runtime | M | E1 + 7 天观察 | 待启动 |
| F1-F4 | `contracts/formula-core-extraction-*` | contracts | L | **GATE PASS** | ❌ blocked |

**执行顺序（2026-05-18 (3) 修订 — Phase B 合并）**：

```
[A] ✅ #1639 完成 (nav 重命名)
└─ [H1] ✅ 大部分完成 (multitable home recents/favorites/search/template quickstart)
   ├─ B ⏭ next: Grid 退役 + 配套清理 (合并 redirect + 删 GridView + 删 Grid 耦合死代码)
   │  └─ C (删 /grid redirect 本身, ≥ 7 天后 + 命中归零)
   ├─ H2: 模板中心独立路由 + UI
   │  └─ H3: 行业模板内容种子
   ├─ E1 (legacy 视图前端退役) ← 独立 PR，不可与 B 合并
   │  └─ E2 (legacy 视图后端退役, 7 天后)
   ├─ D ⏸ 暂缓 (电子表格最小可用; license audit 后再启动)
   └─ [GATE PASS]
      └─ F1-F4 (公式核心 + 插件化 + 跨支柱桥)
```

---

## 5. 全局不变量

每个 PR 必须满足：

1. `/api/multitable/*` 契约稳定（路径 / 请求体 / 响应字段 / 状态码）
2. `/api/spreadsheets/*` 契约稳定
3. `meta_*` 表 zero migration（直到 Phase F3）
4. `spreadsheets/sheets/cells/formulas/cell_versions/named_ranges` 表 zero migration（直到 Phase F3）
5. K3 PoC 路径冻结（`plugin-integration-core` / `lib/adapters/k3-wise-*` / Integration Workbench / IntegrationK3WiseSetupView 不动）
6. 审批 / 工作流 / PLM / 考勤 入口不动

---

## 6. 决策点

> **2026-05-18 状态**：决策 1 / 2 已锁定；决策 3 待定。

### 决策 1：电子表格是否作为长期支柱投资？

- **决策（2026-05-18）：否**
- **理由**：用户对标飞书的核心期待是"多维表 + 多视图 + 自动化 + 权限 + 模板"，不是 Excel 替代品。电子表格定位为附属能力，Phase D 仅做最小可用，不投入持续开发。
- **影响**：
  - Phase D 缩减为 1 PR / 1–2 天
  - `/spreadsheets` 路由保留但导航降级（"工具 / 更多"）
  - 后续在多维表里以"导出 / 引用"形式露出，不并列作为产品

### 决策 2：Phase D 的渲染器选型 — **暂缓决定，启动前实地 audit**

- **2026-05-18 修订**：本文档草案不锁死渲染器。Phase D 启动前必须做 package/license audit：
  - `npm view handsontable license` + 读最新 EULA（2019 起 handsontable 许可有变更）
  - `npm view x-data-spreadsheet` 最近发布 / commit 活跃度
  - 评估 Univer（已在 apps/web-react 有实验，但 Vue 包装不成熟）
- **倾向**：handsontable CE 若仍为 BSD/MIT 则首选；否则 x-data-spreadsheet；若两者都不合适再评估 Univer
- **底线**：不引入需商业 license 的方案

### 决策 3：apps/web-react 实验代码归宿 — **待定**

候选方案：

- 移到 `references/`（保留 Univer 探索作为参考）
- 同步删除（认定为死代码）
- 维持现状（不推荐 —— 持续认知负担）

**建议在 Phase B 启动前回答**。当前推荐"移到 `references/`"，与 `references/univer/` 现有目录一致。

---

## 7. 风险登记

| 风险 | 触发场景 | 缓解 |
|---|---|---|
| 老用户 `/grid` deep link 失效 | C1 后内部书签 / 测试链接 / 旧文档链接打开 `/grid` | C1 redirect 到 `/multitable`，0 个 404；历史 Grid Workspace 数据仍在 `spreadsheets` 表，可从 `/spreadsheets` 列表手动找回 |
| 渲染器许可证陷阱（含 handsontable 2019 变更） | Phase D 启动时基于过时假设选 license-不兼容方案 | Phase D 启动前实地 `npm view ... license` + 读最新 EULA，不依赖本文档草案锁死（§6 决策 2） |
| `view-config-registry` 被未发现的消费者使用 | E2 后 plugin 注册失败 | E2 前 grep 全仓 + plugin 目录三遍确认；保留 registry，仅删 routes 中的 data/state |
| Phase D 越界开新战线 | UI 升级范围失控（协作、Yjs、命名区域） | 明确"最小可用"清单（§3.4），每周 review；超出即停 |
| `plugin-view-grid` 被某个动态 import 引用 | B 后 runtime 404 | B 前 `grep -r "plugin-view-grid"` 三遍 + 跑全量构建 |
| `apps/web-react` 漂移 | 无人维护成僵尸 | B 阶段同步处理（决策 3） |
| ViewManager 测试守护失效 | E1 删 ViewManager 时破坏 multitable-contract.spec.ts | E1 先拆出 `MultitableViewService`，让测试迁移完成再删 |

---

## 8. 推荐首步（2026-05-18 修订）

**已完成**：
- ✅ Phase A（#1639 nav 收敛 + `resolveHomePath()` 默认 `/multitable`）
- ✅ Phase H1 主要元素（home recents/favorites/search/template quickstart/默认入口）

**下一步可启动**（无需新决策）：

- **Phase B**（1 天）—— Grid 退役合并 PR：
  - `/grid` 改为 redirect 到 `/multitable`（5 行配置）
  - 删 GridView.vue + 移除 appRoutes / viewRegistry / view-registry 三处 import
  - 删 `utils/formulaEngine.ts` + `TestFormula.vue`（唯一另一消费者）
  - 删 ProfessionalGridView.vue / EnhancedGridView.vue / `x-data-spreadsheet.d.ts`
  - 删 `plugins/plugin-view-grid/**`（先确认 PluginLoader 日志不再吐错）
  - 删 `grid-view-cell-version-wiring.spec.ts`
  - 保留 `/spreadsheets/*` 与后端契约
- **Phase C**（≥ 7 天后，XS）：删 `/grid` redirect 本身

**B 之后**：
- C 在 B 上线后 ≥ 7 天 + redirect 命中归零（或 ≥ 10 天 + 无失效报告）时启动；硬上限 2026-06-30
- H2 / H3 可与 B 并行（模板中心独立路由 + 行业模板内容）
- E1 / E2 必须**独立 PR**（不可混进 B）；ViewManager 仍被多维表 contract test 守护，需选择性退役

**暂缓**：
- Phase D（电子表格最小可用 UI）—— 等明确需求 + license audit 后再启动
- Phase F* —— 等 K3 PoC GATE PASS

**Phase D 启动前必填**：
- `npm view handsontable license` + 读最新 EULA
- 与 x-data-spreadsheet / Univer 对比
- 用户对"电子表格能用"的诉求强度评估

---

## 9. 附录：关键文件与行号引用

### 9.1 多维表

- 后端骨干：`packages/core-backend/src/routes/univer-meta.ts:1`
- 拆分服务：`packages/core-backend/src/multitable/{provisioning,loaders,access,record-service,query-service,permission-service,automation-service}.ts`
- 字段公式引擎：`packages/core-backend/src/routes/univer-meta.ts:172` (`new MultitableFormulaEngine()`)
- 前端入口：`apps/web/src/router/appRoutes.ts:114` (`buildMultitableRoute`)
- Workbench：`apps/web/src/multitable/views/MultitableWorkbench.vue`
- 视图组件：`apps/web/src/multitable/components/Meta{GridTable,FormView,KanbanView,GalleryView,CalendarView,TimelineView}.vue`
- 共享渲染：`apps/web/src/multitable/components/cells/{MetaCellRenderer,MetaCellEditor}.vue`
- 视图一致性矩阵：`docs/multitable-view-compat-matrix.md`

### 9.2 电子表格

- 后端路由：`packages/core-backend/src/routes/spreadsheets.ts:1`
- A1 公式引擎：`packages/core-backend/src/formula/engine.ts:130`
- 迁移：`packages/core-backend/migrations/034_create_spreadsheets.sql`、`036_create_spreadsheet_permissions.sql`
- 数据模型文档：`docs/SPREADSHEET_DATA_MODEL.md`
- 前端入口：`apps/web/src/views/SpreadsheetsView.vue` / `SpreadsheetDetailView.vue`
- 单元格版本机制：`apps/web/src/utils/spreadsheetCellVersions.ts`
- 集成测试：`packages/core-backend/tests/integration/spreadsheet-integration.test.ts`

### 9.3 通用 Views 桥

- 后端路由：`packages/core-backend/src/routes/views.ts:66`
- 注册中心：`packages/core-backend/src/core/{view-config-registry,view-data-registry,default-view-data-provider}.ts`
- 前端服务：`apps/web/src/services/ViewManager.ts`
- 守护测试：`apps/web/tests/view-manager-multitable-contract.spec.ts`
- 顶层 legacy 视图：`apps/web/src/views/{Kanban,Calendar,Gallery,Form}View.vue`

### 9.4 GridView

- 前端：`apps/web/src/views/GridView.vue:1`
- 创建 Grid Workspace 逻辑：`apps/web/src/views/GridView.vue:731-756`
- 死代码：`plugins/plugin-view-grid/`、`apps/web/src/views/{Professional,Enhanced}GridView.vue`、`apps/web/src/views/TestFormula.vue`、`apps/web/src/utils/formulaEngine.ts`
- 开发报告：`docs/grid-view-development-report.md`

### 9.5 K3 PoC 锁定相关

- 路线图：`docs/development/integration-erp-platform-roadmap-20260425.md`
- 集成核心插件：`plugins/plugin-integration-core/`
- K3 适配器：`lib/adapters/k3-wise-*`
- Integration Workbench：`apps/web/src/views/IntegrationWorkbenchView.vue`
- K3 WISE 设置：`apps/web/src/views/IntegrationK3WiseSetupView.vue`

---

## 10. 变更日志

- **2026-05-17** 初稿（zensgit + claude-opus-4-7 协作）
- **2026-05-18 (1)** 产品方向锁定：
  - 多维表为主产品，电子表格为附属能力，Grid 退役为兼容层（§2 重写）
  - 决策 1 / 2 锁定（§6）
  - Phase C 改为"先隐藏 → 后跳转 → 最后删"三段式（§3 Phase C）
  - Phase D 缩减为"最小可用 1 PR"（§3 Phase D）
  - 新增 Phase H：多维表首页 + 模板中心 + 行业模板内容（§3）
  - 新增 §11：产品结构（5 个组件）
- **2026-05-18 (2)** 现状校准与简化：
  - Phase A 标记已完成（#1639 merged）
  - Phase H1 标记大部分已完成（home recents/favorites/search/template quickstart 已合）
  - Phase C1 简化为 5 行 redirect 到 `/multitable`（取消 localStorage / API 查询逻辑）
  - Phase D 进一步暂缓（不在飞书对标主路径上）
  - 决策 2（渲染器选型）改为"启动前实地 audit"，不在文档草案锁死 license
  - §4 PR 表加状态列，更新执行顺序图
- **2026-05-18 (4)** Phase B 合并 via #1642（CI 16/16 pass）。
- **2026-05-18 (5)** Phase C 观察窗口从 30 天缩短为 "≥ 7 天 + redirect 命中归零（或 ≥ 10 天 + 无失效报告）"。理由：本项目无大规模生产用户群，#1639 已将 `/grid` 从 nav 移除，新用户无暴露面；30 天为保守默认，对本场景过度保守。`meta.retireBy = 2026-06-30` 保持不变作为硬上限。
- **2026-05-18 (3)** 基于 origin/main 实测的修正：
  - 验证文档路径修正：`views-consolidation-nav-positioning-*`（不是 `multitable-consolidation-*`）
  - §0.3 死代码核对重做：发现 GridView 仍是 `/grid` component route、被 viewRegistry / view-registry / test / formulaEngine 多处耦合；`formulaEngine.ts` 同时被 TestFormula 消费；`plugin-view-grid` 在 PluginLoader 扫描路径里（虽然 manifest 验证失败）
  - **Phase B + 原 Phase C1 合并**为单 PR "Grid 退役 + 配套清理"
  - 原 Phase C2 简化为 Phase C（仅删 `/grid` redirect 本身）
  - 强调 Phase E（ViewManager / legacy views）必须独立 PR，不可与 B 混合
  - 移除"resolveHomePath() 暂保留"说明（#1639 已改为 `/multitable`）

---

## 11. 产品结构（5 个组件，2026-05-18 锁定）

> 此章节是产品定位的最终表达，所有后续工程动作必须服务此结构。

### 11.1 多维表首页（主入口） — **大部分已实现（待清单核对）**

| 元素 | 状态 | 关联提交 |
|---|---|---|
| 最近打开的 base / sheet | ✅ 已实现 | `2082bb58 #1633 add home recents and favorites` |
| 收藏 | ✅ 已实现 | `2082bb58 #1633` 同上 |
| 模板入口 | ✅ 已实现（quickstart 形式，独立路由待 H2） | `ab4ef5b1 add home template quickstart` |
| 新建 base | ⚠️ 待核对 | — |
| 搜索 base / sheet / view 名称 | ✅ 已实现 | `f81710b6 add home base search` |
| 默认入口（`resolveHomePath()`） | ✅ 已切换 | `b53168ce make multitable the default table entry` |

**路由**：`/multitable`（无参数）
**实现**：Phase H1 大部分已合到 main；Phase B 启动前建议做 §3 Phase H 前的"现状清单核对"，把"待核对 / 待补"项明确化

### 11.2 多维表 Workbench（主体）

| 区域 | 描述 |
|---|---|
| 左侧 | Base / Sheet / View 导航树（`MetaBasePicker` + `MetaViewTabBar`） |
| 顶部 | 当前 sheet 名 + 视图切换 + 筛选 + 排序 + 权限 + 分享 |
| 主区 | Grid / Kanban / Calendar / Gallery / Form / Gantt / Hierarchy —— **作为同一张表的视图维度**，不是独立产品 |
| 右侧 / 抽屉 | 记录详情（`MetaRecordDrawer`）+ 评论（`MetaCommentsDrawer`）+ 自动化运行历史 |

**路由**：`/multitable/:sheetId/:viewId`
**实现**：现状已基本完成；Phase E 退役顶层 legacy 视图后认知更清晰

### 11.3 模板中心

| 类别 | 模板举例 |
|---|---|
| 项目管理 | 任务追踪、Sprint 看板、里程碑 |
| CRM | 客户、商机、联系记录 |
| 合同管理 | 合同清单、付款节点、续约提醒 |
| 巡检 | 巡检任务、问题清单、整改记录 |
| 招聘 | 候选人、面试记录、Offer 跟进 |
| 通用 | 简单清单、知识库、问卷 |
| 待接入 | 考勤 / 审批相关模板（与现有 attendance / approval 模块联动，GATE 后评估） |

**路由**：`/multitable/templates`
**实现**：Phase H2 + H3
**重要性**：飞书对标里的关键上手路径，**比堆视图更重要**

### 11.4 电子表格入口（弱化）

| 维度 | 设计 |
|---|---|
| 主导航位置 | **不放在第一层**；放在"工具 / 更多"或个人设置入口 |
| 与多维表的关系 | 提供"导出到电子表格 / 从电子表格引用 / 公式工作簿"连接点；不并列竞争 |
| UI 完成度 | 最小可用（Phase D）；不投入持续开发 |
| 用户心智 | "财务测算 / 临时表 / 自由排版" 的补充能力，不是 Excel 替代品 |

**路由**：`/spreadsheets`（列表） + `/spreadsheets/:id`（详情）保留
**实现**：Phase D（最小可用） + Phase F3（跨支柱连接点，GATE 后）

### 11.5 Grid 退役策略

| 阶段 | 状态 | 对应 Phase |
|---|---|---|
| 阶段 ① 隐藏入口 | ✅ 已完成（顶部 nav 移除 / `resolveHomePath` 改 `/multitable`） | Phase A（#1639） |
| 阶段 ② 兼容跳转 + 删实现 | `/grid` → `/multitable` redirect；同 PR 删除 GridView 与 Grid 耦合死代码 | Phase B（合并原 B + C1） |
| 阶段 ③ 删 route 本身 | 删除 `/grid` redirect 配置（≥ 7 天观察 + redirect 命中归零 / 无失效报告；硬上限 2026-06-30） | Phase C |

**心智**：Grid 不是产品，仅为历史用户的 deep link 兼容存在；最终消失。

### 11.6 产品判断（最终表达）

> **主推多维表**。Spreadsheets 可以保留，但不作为当前阶段的主要卖点。
>
> 用户对标飞书的核心期待是**"多维表 + 多视图 + 自动化 + 权限 + 模板"**，不是传统 Excel 替代品。
>
> —— 摘自 2026-05-18 产品方向讨论
