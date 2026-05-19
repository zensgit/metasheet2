# H3 行业模板种子扩充 — 开发计划

- **日期**：2026-05-18
- **范围**（5 文件）：`packages/core-backend/src/multitable/template-library.ts`、`packages/core-backend/tests/unit/multitable-template-library.test.ts`、`packages/core-backend/tests/integration/multitable-context.api.test.ts`、本 development MD、配套 verification MD
- **依赖**：Phase H2 (#1651) ✅ merged — 模板中心页面已能动态展示任意 category 的模板
- **K3 PoC 阶段一锁定**：合规（纯静态 TS 数据 + 测试；无 API / migration / schema）
- **关联**：[H2 development plan §2.2 / §6](./multitable-template-center-h2-development-20260518.md)

---

## 1. Summary

H2 已把模板中心做成独立路由 + 动态分类聚合。H3 是最小增量：在静态模板库 `template-library.ts` 追加 5 个行业模板，让模板中心从 3 个扩到 8 个，直接增强"对标飞书"的上手价值。

**Scout 结论**：

- 模板库是静态 TS 数组 `TEMPLATE_LIBRARY`（`template-library.ts:88`），**非 DB 表**
- 现有 3 个模板（`project-tracker` / `sales-crm` / `issue-tracker`）**全部单 sheet / 6 字段 / 3 视图（1 grid + 2 业务视图）**
- 字段类型 union（`contracts.ts:1`）：string / number / boolean / date / dateTime / formula / select / multiSelect / link / lookup / rollup / attachment / barcode / location / longText
- 视图类型：grid / kanban（需 `groupByFieldId`）/ calendar（需 `dateFieldId` + `titleFieldId`）/ timeline（需 `dateFieldId` + `titleFieldId`）/ gantt / hierarchy
- 单测 `multitable-template-library.test.ts:174` 是**精确 id 数组等值断言**，加模板会破，必须同步更新

---

## 2. Key Changes

### 2.1 单 sheet 设计决策（偏离 H2 §6.2 outline，附理由）

H2 dev MD §6.2 把新模板 outline 成 multi-sheet（如 contract-management = Contracts + Payments）。**H3 改为单 sheet**，理由：

1. 现有 3 个模板**全部单 sheet**，是 production-proven 的形态
2. multi-sheet 在类型上支持，但 **`installs a template` 测试只覆盖单 sheet**，多 sheet provisioning 是未测试领域
3. H3 目标是"最小增量、纯数据、低风险"，单 sheet 完全满足质量门（5-8 字段 + ≥2 视图含 grid + 业务视图）
4. 多 sheet 的跨表关系（link/lookup/rollup）属于更大设计，不应塞进"种子扩充"PR

若未来需要多 sheet 模板，单列一个设计（含 provisioning 多 sheet 测试覆盖），不在 H3。

### 2.2 5 个新模板（单 sheet，英文 category 与现有风格对齐）

> Category 命名锁定（承 H2 round-2 评审）：data-layer 用英文字符串；中文 UI 标签由 `apps/web/src/multitable/utils/category-labels.ts` 翻译（H2 已落地，已含 Contract/Inspection/Recruitment/Operations/General 映射）。

#### ① contract-management

| 属性 | 值 |
|---|---|
| id | `contract-management` |
| name | `Contract Management` |
| category | `Contract` |
| icon | `contract` · color `#7c3aed` |
| sheet | `contracts` / "Contracts" / "Contract lifecycle tracking" |

| 字段 id | name | type | order | options |
|---|---|---|---|---|
| name | Contract Name | string | 0 | — |
| party | Counterparty | string | 1 | — |
| amount | Amount | number | 2 | — |
| status | Status | select | 3 | Draft / In review / Signed / Active / Expired / Terminated |
| signedAt | Signed Date | date | 4 | — |
| expiresAt | Expiry Date | date | 5 | — |
| owner | Owner | string | 6 | — |
| notes | Notes | longText | 7 | — |

| view id | name | type | config |
|---|---|---|---|
| grid | All Contracts | grid | — |
| byStatus | By Status | kanban | groupByFieldId: `status` |
| expiry | Expiry Calendar | calendar | dateFieldId: `expiresAt`, titleFieldId: `name` |

#### ② field-inspection

| 属性 | 值 |
|---|---|
| id | `field-inspection` |
| name | `Field Inspection` |
| category | `Inspection` |
| icon | `inspection` · color `#ea580c` |
| sheet | `inspections` / "Inspections" / "Site inspection and remediation tracking" |

| 字段 id | name | type | order | options |
|---|---|---|---|---|
| site | Site | string | 0 | — |
| inspector | Inspector | string | 1 | — |
| inspectedAt | Inspected Date | date | 2 | — |
| finding | Finding | longText | 3 | — |
| severity | Severity | select | 4 | Critical / Major / Minor / Observation |
| status | Status | select | 5 | Open / In remediation / Verified / Closed |
| dueDate | Remediation Due | date | 6 | — |

| view id | name | type | config |
|---|---|---|---|
| grid | All Inspections | grid | — |
| bySeverity | By Severity | kanban | groupByFieldId: `severity` |
| due | Remediation Timeline | timeline | dateFieldId: `dueDate`, titleFieldId: `site` |

#### ③ recruitment

| 属性 | 值 |
|---|---|
| id | `recruitment` |
| name | `Recruitment Pipeline` |
| category | `Recruitment` |
| icon | `recruit` · color `#0891b2` |
| sheet | `candidates` / "Candidates" / "Hiring pipeline tracking" |

| 字段 id | name | type | order | options |
|---|---|---|---|---|
| candidate | Candidate | string | 0 | — |
| role | Role | string | 1 | — |
| stage | Stage | select | 2 | Applied / Screening / Interview / Offer / Hired / Rejected |
| recruiter | Recruiter | string | 3 | — |
| appliedAt | Applied Date | date | 4 | — |
| nextStep | Next Step | longText | 5 | — |
| rating | Rating | select | 6 | Strong hire / Hire / Hold / No |

| view id | name | type | config |
|---|---|---|---|
| grid | All Candidates | grid | — |
| pipeline | Pipeline | kanban | groupByFieldId: `stage` |
| applied | Applied Calendar | calendar | dateFieldId: `appliedAt`, titleFieldId: `candidate` |

#### ④ meeting-minutes

| 属性 | 值 |
|---|---|
| id | `meeting-minutes` |
| name | `Meeting Minutes` |
| category | `Operations` |
| icon | `notes` · color `#475569` |
| sheet | `meetings` / "Meetings" / "Meeting records and action items" |

| 字段 id | name | type | order | options |
|---|---|---|---|---|
| topic | Topic | string | 0 | — |
| meetingDate | Meeting Date | date | 1 | — |
| attendees | Attendees | longText | 2 | — |
| decisions | Decisions | longText | 3 | — |
| actionItem | Action Item | string | 4 | — |
| assignee | Assignee | string | 5 | — |
| status | Status | select | 6 | Open / In progress / Done |
| dueDate | Action Due | date | 7 | — |

| view id | name | type | config |
|---|---|---|---|
| grid | All Meetings | grid | — |
| byStatus | Action Board | kanban | groupByFieldId: `status` |
| dueCal | Action Calendar | calendar | dateFieldId: `dueDate`, titleFieldId: `actionItem` |

#### ⑤ asset-inventory

> 评审替换 `simple-list`：simple-list 过泛、像空白表增强版；asset-inventory 更贴近真实业务，对标飞书价值更高。

| 属性 | 值 |
|---|---|
| id | `asset-inventory` |
| name | `Asset Inventory` |
| category | `Operations` |
| icon | `asset` · color `#0d9488` |
| sheet | `assets` / "Assets" / "Equipment and asset register" |

| 字段 id | name | type | order | options |
|---|---|---|---|---|
| asset | Asset | string | 0 | — |
| category | Category | select | 1 | IT / Office / Vehicle / Machinery / Other |
| serialNumber | Serial Number | string | 2 | — |
| location | Location | string | 3 | — |
| owner | Owner | string | 4 | — |
| status | Status | select | 5 | In use / In storage / Under repair / Retired |
| purchaseDate | Purchase Date | date | 6 | — |
| notes | Notes | longText | 7 | — |

| view id | name | type | config |
|---|---|---|---|
| grid | All Assets | grid | — |
| byStatus | By Status | kanban | groupByFieldId: `status` |
| purchase | Purchase Calendar | calendar | dateFieldId: `purchaseDate`, titleFieldId: `asset` |

> 注：`Operations` category 此时被 `meeting-minutes` 与 `asset-inventory` 共用。模板中心按 category 聚合，一个分类多模板是预期行为（飞书同理）。

### 2.3 质量门核对

| 模板 | 字段数 | 视图数 | grid? | 业务视图? | ✅ |
|---|---|---|---|---|---|
| contract-management | 8 | 3 | ✓ | kanban + calendar | ✅ |
| field-inspection | 7 | 3 | ✓ | kanban + timeline | ✅ |
| recruitment | 7 | 3 | ✓ | kanban + calendar | ✅ |
| meeting-minutes | 8 | 3 | ✓ | kanban + calendar | ✅ |
| asset-inventory | 8 | 3 | ✓ | kanban + calendar | ✅ |

全部满足"5-8 字段 + ≥2 视图（含 1 grid + ≥1 业务视图）"。**§5.2 的模板质量 harness 会以参数化测试机械校验此表，不再靠肉眼。**

---

## 3. 改动文件清单

### 3.1 修改文件

| 文件 | 改动 |
|---|---|
| `packages/core-backend/src/multitable/template-library.ts` | `TEMPLATE_LIBRARY` 数组末尾追加 5 个模板对象（接在 `issue-tracker` 之后，保持现有 3 个顺序与内容不变） |
| `packages/core-backend/tests/unit/multitable-template-library.test.ts` | (a) L174 精确 id 数组断言 3→8；(b) **新增模板质量 harness**（参数化遍历全部 8 个模板，§5.2）；(c) **参数化 install 测试覆盖全部 5 个新模板**（不是"至少 1 个"） |
| `packages/core-backend/tests/integration/multitable-context.api.test.ts` | **必改**：L557 catalog test 的精确 id 数组断言 3→8（实测确认在 `lists the built-in multitable template catalog`）。install API integration 只补 1 个新模板（contract-management）作关键路径冒烟，**不**在 integration 层重复 5 个全量 install |

> **Finding 1 处理**：integration test 不是"如有一并跑"——已实测确认 `multitable-context.api.test.ts:557` 有精确 3-id 断言，不更新 PR 必红。它是 H3 的**必改文件 + 必跑测试**。

### 3.2 不动文件

- 任何前端文件（H2 模板中心已动态聚合分类，新增 category 自动出现）
- `category-labels.ts`（H2 已含全部 5 个新 category 的中文映射）
- 后端路由 `univer-meta.ts`（API 不变）
- migrations / DB schema（零改动）
- K3 / integration-core / `/api/spreadsheets/*`（零改动）

---

## 4. Deliverables

- `docs/development/multitable-industry-templates-h3-development-20260518.md`（**本文档**）
- `docs/development/multitable-industry-templates-h3-verification-20260518.md`（实现完成后产出）
- `template-library.ts` +5 模板（contract-management / field-inspection / recruitment / meeting-minutes / asset-inventory）
- `multitable-template-library.test.ts`：id 断言 3→8 + 模板质量 harness（§5.2）+ 5 模板参数化 install
- `multitable-context.api.test.ts`：catalog id 断言 3→8 + 1 个新模板 install 冒烟

---

## 5. Test Plan

### 5.1 H3 targeted tests（两个都必跑）

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-template-library.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/multitable-context.api.test.ts --watch=false
git diff --check origin/main..HEAD
```

integration test 已实测确认有精确 id 断言（L557），**必须更新并运行**——不是"先 grep 确认"。

### 5.2 模板质量 harness（参数化，遍历全部 8 个模板）

新增一个 `describe('template library quality contract')`，对 `listMultitableTemplates()` 返回的**每个**模板逐项机械校验（不再靠肉眼查字段/视图引用）：

| 断言 | 规则 |
|---|---|
| template id 唯一 | 8 个 id 无重复 |
| scope 内 id 唯一 | 每个模板：sheet id 唯一、field id 在 sheet 内唯一、view id 在 sheet 内唯一 |
| 单 sheet | `template.sheets.length === 1` |
| 字段数 | `5 ≤ fields.length ≤ 8` |
| 视图数 + grid | `views.length ≥ 2` 且至少一个 `type === 'grid'` |
| select/multiSelect options | 这类字段 `options` 必须存在且非空 |
| kanban 引用 | `view.groupByFieldId` 必须是该 sheet 真实 field id |
| calendar/timeline 引用 | `view.dateFieldId`（必填）+ `view.titleFieldId`（若有）必须是真实 field id |
| field order | 连续且从 0 开始（`[0,1,2,...,n-1]`） |

并对**5 个新增模板逐个**（参数化 `it.each`）`installMultitableTemplate()` 成功，断言：sheet=1、fields 数量/名称/type/options 正确、views=3、kanban 生成 `group_info`、calendar/timeline 生成 `config.dateFieldId`（含 titleFieldId）。

> 价值：以后再加模板，质量门自动守护，无需人工 review 字段/视图引用是否对得上。这是 H3"顺手补质量 harness"的核心产出，长期价值 > 5 条静态数据本身。

### 5.3 H3 Acceptance Scenarios

- `listMultitableTemplates()` 返回 8 个模板，新增 5 个 id 全部出现（unit + integration catalog 双断言）
- 现有 `project-tracker` / `sales-crm` / `issue-tracker` 的 id / category / 字段 / 视图**完全不变**（L180 `fields[0].name === 'Task'` 仍成立）
- 质量 harness 对全部 8 个模板通过（§5.2 全表）
- 5 个新模板逐个 install 成功（unit 层参数化全覆盖）
- contract-management install 在 integration API 层关键路径冒烟通过
- base id 冲突仍正确抛 `MultitableTemplateConflictError`；未知 templateId 仍正确抛 `MultitableTemplateNotFoundError`

### 5.3 手测（可选，部署后）

- 模板中心 `/multitable/templates` 新增 5 卡片显示，分类 tab 出现 Contract/Inspection/Recruitment/Operations/General（中文标签 合同管理/巡检/招聘/运营/通用）
- 任选一个新模板 install → 跳到新 base 默认视图，字段/视图与设计一致

---

## 6. K3 PoC 阶段一锁定合规

| 检查项 | 状态 |
|---|---|
| `plugins/plugin-integration-core/**` | ❌ 不动 |
| `lib/adapters/k3-wise-*` | ❌ 不动 |
| `/api/multitable/*` 契约 | ❌ 不动（仅静态数据扩充，response shape 不变） |
| `/api/spreadsheets/*` | ❌ 不动 |
| DB migration / schema | ❌ 零新增 |
| 平台化红线（组织级模板发布 / marketplace / 计费） | ❌ 不触及；仍是 hard-coded 内置库 |

按 [Integration ERP Platform Roadmap](./integration-erp-platform-roadmap-20260425.md) 阶段一锁定：H3 是多维表内核（已 ship 的模板能力）的延续打磨，纯静态数据，非新产品面。

---

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 精确 id 数组断言遗漏更新 | 中 | §3.1 明确列为必改；§5.2 acceptance 第 1 条守护 |
| 新模板字段类型拼写错误（如 `longtext` vs `longText`） | 低 | 严格对照 `contracts.ts:1` union；TS 编译会捕获非法字面量 |
| kanban view 漏 `groupByFieldId` / calendar 漏 `dateFieldId` | 低 | 对照现有 3 模板的 view config 形态；§5.2 install 测试验证 group_info/config |
| 现有 3 模板被无意改动 | 中 | 只在数组**末尾追加**；§5.3 第 2 条 + L180 既有断言 + 质量 harness 守护 |
| integration API test 精确 id 断言遗漏 | 中 | **已实测确认**存在（L557）；§3.1 列为必改必跑，不再"先 grep" |
| 新模板字段/视图引用错配（如 kanban groupBy 指向不存在 field） | 中 | §5.2 质量 harness 机械校验全部引用；这是引入 harness 的主要动机 |
| 多 sheet 期待落空（H2 outline 写的是 multi-sheet） | 低 | §2.1 已记录偏离 + 理由；单 sheet 满足质量门 |

---

## 8. PR 拆分

```
分支: contracts/multitable-industry-templates-20260518
Lane: contracts（数据 seed）
体量: XS（1 数据文件 + 1 测试文件）
依赖: H2 (#1651) 已 merged
预计 PR 数: 1
```

---

## 9. 推荐执行顺序

1. **审本 development MD**（你现在做的）—— 重点确认 5 个模板的字段/视图设计 + 单 sheet 决策
2. 审过 → 实现：追加 5 模板 + 更新测试
3. 跑 §5.1 验证
4. 写 verification MD（`multitable-industry-templates-h3-verification-20260518.md`）
5. 本地 commit + 停在 push 前（沿用本会话节奏）
6. 你 review → push → CI → admin-merge

---

## 10. 变更日志

- **2026-05-18 (1)** 初稿（zensgit + claude-opus-4-7 协作）
- **2026-05-18 (2)** 评审修订（3 findings + 3 改进）：
  - **Finding 1**：`multitable-context.api.test.ts:557` 实测确认有精确 3-id 断言 → 纳入 §3.1 必改文件 + §5.1 必跑测试（不再"如有一并跑/先 grep"）
  - **Finding 2**：install 测试从"至少 1 个"升级为 §5.2 参数化覆盖全部 5 个新模板
  - **Finding 3**：§5.1 删除"先 grep 确认"措辞，改为明确更新并运行
  - **改进 1**：`simple-list` → `asset-inventory`（更贴近真实业务，category `Operations`，与 meeting-minutes 共用该分类）
  - **改进 2**：新增 §5.2 模板质量 harness（参数化遍历 8 个模板，机械校验 id 唯一性 / 单 sheet / 5-8 字段 / ≥2 视图含 grid / select options 非空 / view 引用真实 field / order 连续）—— H3 核心长期价值
  - **改进 3**：integration 层只补 1 个 install 冒烟（contract-management），5 个全量 install 放 unit 层（更快更稳）
