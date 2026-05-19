# T2 多维表工作台中文化 — 开发计划

- **日期**：2026-05-19
- **范围**：`apps/web/src/multitable/views/MultitableWorkbench.vue` + 新增 `apps/web/src/multitable/utils/workbench-labels.ts`
- **方式**：轻量 locale label 模块（仿 `category-labels.ts`，用户已选定）
- **依赖**：无（H 系列已 merged）；不依赖部署
- **K3 PoC 阶段一锁定**：合规 —— 已发布 UI 的本地化属"内核打磨"，无新战线 / 无 integration-core / 无契约 / 无 migration
- **关联**：[H 系列收官锚点](./views-consolidation-multitable-spreadsheets-plan-20260517.md)

---

## 1. Summary

多维表当前 i18n 三段割裂（详见 [上一轮 scout]）：导航/首页/模板中心硬编码中文，**工作台 + Meta\* 组件硬编码英文**，全线不读 `useLocale`。T2 只做**工作台外壳**（`MultitableWorkbench.vue`）中文化，让它响应顶部 en/zh-CN 开关，与中文导航/首页一致，对标飞书界面一致性。

**不做** Meta\* 子组件（MetaGridTable/MetaRecordDrawer/MetaViewManager/Kanban/Form/...）—— 那是 T3，本 PR 明确不碰（见 §4 边界）。

---

## 2. label 模块设计

新增 `apps/web/src/multitable/utils/workbench-labels.ts`，仿 `category-labels.ts` 形态但 en/zh 双显式：

```ts
// Workbench UI string table. Single source for MultitableWorkbench.vue
// localization. EN + ZH both explicit (unlike category-labels where the
// data layer is English). Components read useLocale().isZh and call
// workbenchLabel(key, isZh). Interpolated strings take params.

// ⚠ 下方 key 联合为**示意骨架**。**完整、权威的 key 清单以 §3 全量字符串清单为准**
// （含 §3.0 conflict.* / presence.* / conflict.fieldFallback、§3.4 kbd.navigateCells、
// §3.6 card.*）。实现者必须照 §3 逐表建 key，勿仅照此示意抄（会漏 key）。
export type WorkbenchLabelKey =
  // §3.0 脚本 computed 外壳（插值见 helper 区）
  | 'conflict.fieldFallback'
  // §3.1 冲突横幅
  | 'conflict.title' | 'conflict.reload' | 'conflict.retry' | 'conflict.dismiss'
  // §3.2 工具栏
  | 'toolbar.commentInbox' | 'toolbar.fields' | 'toolbar.access' | 'toolbar.views'
  | 'toolbar.workflow' | 'toolbar.automations' | 'toolbar.templates'
  | 'toolbar.dashboard' | 'toolbar.shareForm' | 'toolbar.apiWebhooks'
  | 'toolbar.mentions'
  // §3.3 模板库 modal
  | 'tpl.title' | 'tpl.subtitle' | 'tpl.loading' | 'tpl.more'
  // §3.4 快捷键 modal（kbd.* 为说明文案，需译；<kbd> 物理键名不进表）
  | 'kbd.title' | 'kbd.navigateCells' | 'kbd.editCell' | 'kbd.cancelClose' | 'kbd.nextCell'
  | 'kbd.copy' | 'kbd.paste' | 'kbd.undo' | 'kbd.redo' | 'kbd.toggleHelp'
  // §3.5 静态 toast 子集（~17；动态/插值族见 §3.5 = T3）
  | 'toast.recordCreateBlocked' | 'toast.recordEditBlocked' | 'toast.recordDeleteBlocked'
  | 'toast.datesUpdated' | 'toast.hierarchyUpdated' | 'toast.recordDeleted'
  | 'toast.loadedLatest' | 'toast.changeReapplied' | 'toast.recordUpdated'
  | 'toast.formSubmitted' | 'toast.commentUpdated' | 'toast.commentAdded'
  | 'toast.commentResolved' | 'toast.commentDeleted' | 'toast.linkedRecordsUpdated'
  | 'toast.viewSettingsSaved'
  // §3.6 MetaTemplateCard 按钮（计数走插值 helper card.sheets/fields/views）
  | 'card.install' | 'card.installing'

// 插值 helper（非 key，单列）：conflict.message(field, version?) /
// presence.label(n) / presence.title(ids) / commentInboxTitle(n) /
// mentionsUnread(n) / mentionsRecords(n) / card.sheets(n) / card.fields(n) /
// card.views(n) —— 各含 §3 注明的 en 单复数 / 空态 / 0 分支 / 可选段。

const WORKBENCH_LABELS: Record<WorkbenchLabelKey, { en: string; zh: string }> = { /* §3 */ }

export function workbenchLabel(key: WorkbenchLabelKey, isZh: boolean): string {
  const entry = WORKBENCH_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// interpolated helpers
export function mentionsUnread(n: number, isZh: boolean): string  // "{n} unread" / "{n} 条未读"
export function mentionsRecords(n: number, isZh: boolean): string
export function commentInboxTitle(n: number, isZh: boolean): string
```

Workbench 侧接入：

```ts
import { useLocale } from '../../composables/useLocale'
import { workbenchLabel as wb /* + helpers */ } from '../utils/workbench-labels'
const { isZh } = useLocale()
// 模板内：{{ wb('toolbar.fields', isZh) }}
// 脚本内 toast：showSuccess(wb('toast.recordDeleted', isZh.value))
```

`isZh` 是 computed，模板/脚本读它天然响应顶部语言开关，无需额外订阅。

---

## 3. 全量字符串清单（en → zh，按位置）

### 3.0 脚本 computed 外壳文案（评审补：之前漏进清单，实为工作台可见）

这些在脚本里是 `computed`，模板 `{{ }}` 直接渲染，**是工作台外壳可见文案，必须本地化**：

| key（helper） | 源（行） | en | zh |
|---|---|---|---|
| `conflict.message(field, version?)` | `conflictMessage` L891 | `{field} changed elsewhere.[ Latest version is {v}.] Reload the row or retry your edit.` | `{field} 已在别处被修改。[ 最新版本为 {v}。] 请重新加载该行或重试你的修改。` |
| `conflict.fieldFallback` | `conflictFieldName` L886 | `cell` | `单元格` |
| `presence.label(n)` | `sheetPresenceLabel` L879 | `{n} active collaborator` / `{n} active collaborators` | `{n} 位活跃协作者` |
| `presence.title(ids)` | `sheetPresenceTitle` L882 | `Active now: {ids}` / `No active collaborators` | `当前在线：{ids}` / `无活跃协作者` |

实现：把这 4 个 computed 改为读 `isZh` 后用 helper 拼装（`conflict.message` / `presence.label` / `presence.title` 是插值 helper，`conflict.fieldFallback` 是普通 key）。

> **实现陷阱（评审提示）**：上表 `conflict.message` 里的 `[ … ]` 是 **optional 段标记，不是字面方括号**——`version` 为数字时插入「 Latest version is {v}.」/「 最新版本为 {v}。」，否则该段整体省略。**输出里绝不能出现 `[` `]` 字符**。`presence.title` 的 `{ids}` 若是 user id（非姓名），id 本身不翻译，仅译外层模板。

### 3.1 冲突横幅（L4-13）

| key | en | zh |
|---|---|---|
| conflict.title | Update conflict | 更新冲突 |
| conflict.reload | Reload latest | 重新加载最新 |
| conflict.retry | Retry change | 重试本次修改 |
| conflict.dismiss | Dismiss | 忽略 |

### 3.2 工具栏（L26-62）

| key | en | zh |
|---|---|---|
| toolbar.mentions | Mentions | 提及 |
| (interp) mentionsUnread | {n} unread | {n} 条未读 |
| (interp) mentionsRecords | {n} records | {n} 条记录 |
| (interp) commentInboxTitle | {n} comment updates need attention | {n} 条评论待处理 |
| toolbar.commentInbox | Comment Inbox | 评论收件箱 |
| toolbar.fields | Fields | 字段 |
| toolbar.access | Access | 权限 |
| toolbar.views | Views | 视图 |
| toolbar.workflow | Workflow | 工作流 |
| toolbar.automations | Automations | 自动化 |
| toolbar.templates | Templates | 模板 |
| toolbar.dashboard | Dashboard | 仪表盘 |
| toolbar.shareForm | Share Form | 分享表单 |
| toolbar.apiWebhooks | API & Webhooks | API 与 Webhook |

> `Open comment inbox`（title 无 badge 时）→ `打开评论收件箱`，并入 commentInboxTitle helper 的 0 分支。

### 3.3 模板库 modal（L64-92）

| key | en | zh |
|---|---|---|
| tpl.title | Template Library | 模板库 |
| tpl.subtitle | Start a new base from a built-in workspace pattern. | 从内置工作区模板新建一个 Base |
| tpl.loading | Loading templates... | 正在加载模板... |
| tpl.more | More templates → | 更多模板 → |

> 注：footer 当前**硬编码中文** `更多模板 →`，是英文工作台里的孤立中文。T2 用 `tpl.more` 统一为双语（消除这处不一致）。`templateLibraryError` 是脚本动态串，**不在 T2**（错误文案本地化属更深层，单列）。

### 3.4 键盘快捷键 modal（L302-314）

| key | en | zh |
|---|---|---|
| kbd.title | Keyboard Shortcuts | 键盘快捷键 |
| kbd.navigateCells | Navigate cells | 导航单元格 |
| kbd.editCell | Edit cell | 编辑单元格 |
| kbd.cancelClose | Cancel edit / close | 取消编辑 / 关闭 |
| kbd.nextCell | Next cell | 下一个单元格 |
| kbd.copy | Copy cell value | 复制单元格值 |
| kbd.paste | Paste into cell | 粘贴到单元格 |
| kbd.undo | Undo | 撤销 |
| kbd.redo | Redo | 重做 |
| kbd.toggleHelp | Toggle this help | 切换此帮助 |

> `<kbd>Enter/Escape/Tab/Ctrl+C…</kbd>` 是按键名，**不翻译**（保持物理键名）。

### 3.5 脚本 toast（showSuccess/showError：静态子集 ~17 进 T2 + 动态族列 T3）

| key | en | zh |
|---|---|---|
| toast.recordCreateBlocked | Record creation is not allowed in this view. | 当前视图不允许创建记录。 |
| toast.recordEditBlocked | Record editing is not allowed for this row. | 该行不允许编辑记录。 |
| toast.recordDeleteBlocked | Record deletion is not allowed for this row. | 该行不允许删除记录。 |
| toast.datesUpdated | Dates updated | 日期已更新 |
| toast.hierarchyUpdated | Hierarchy updated | 层级已更新 |
| toast.recordDeleted | Record deleted | 记录已删除 |
| toast.loadedLatest | Loaded the latest row state | 已加载最新行状态 |
| toast.changeReapplied | Change reapplied | 修改已重新应用 |
| toast.recordUpdated | Record updated | 记录已更新 |
| toast.formSubmitted | Form submitted | 表单已提交 |
| toast.commentUpdated | Comment updated | 评论已更新 |
| toast.commentAdded | Comment added | 评论已添加 |
| toast.commentResolved | Comment resolved | 评论已解决 |
| toast.commentDeleted | Comment deleted | 评论已删除 |

**实测：`grep -cE "showSuccess\(|showError\("` = 70 个，远多于初稿的 ~15。** T2 **只做上表的静态非插值子集**（约 17 个：3 个 not-allowed 阻断 + datesUpdated/hierarchyUpdated/recordDeleted/loadedLatest/changeReapplied/recordUpdated/formSubmitted/4 个 comment* + linkedRecordsUpdated + viewSettingsSaved）。

**明确转 T3 边界（本 PR 不做，verification 必列）**：

- 动态插值：`Installed ${result.template.name}`、`${n} record(s) imported/skipped/failed/deleted`、`Record not found: ${recordId}`
- 权限/host-context 文案：`* requires multitable write access.`、`Host multitable context change …`
- `Failed to …` 后端错误 fallback 系列
- `Import cancelled` 及 import/bulk-edit 计数族

**验收口径改为**：静态 toast 全覆盖；动态/后端/插值错误文案列入 T3。verification MD **必须附** `grep -nE "showSuccess\(|showError\(" MultitableWorkbench.vue` 全量输出，逐条标 `[T2-done]` / `[T3-deferred]`，证明无静态漏译、动态项是有意识 defer 而非遗漏。

---

### 3.6 MetaTemplateCard（评审补：纳入 T2，避免模板库 modal 中英混杂）

`MetaTemplateCard.vue` 当前**硬编码中文**（L16-18 `个 Sheet · 个字段 · 个视图`、L26 `创建中.../使用模板`），未用 `useLocale`。它被工作台模板库 modal 渲染——与 footer `更多模板 →` 同理：英文工作台里的孤立中文。**纳入 T2**（小改、低风险），且因它同时被首页/模板中心（已中文页）复用，双语化是全局净改进。

| key | en | zh |
|---|---|---|
| card.sheets(n) | {n} sheet / {n} sheets | {n} 个 Sheet |
| card.fields(n) | {n} field / {n} fields | {n} 个字段 |
| card.views(n) | {n} view / {n} views | {n} 个视图 |
| card.install | Use template | 使用模板 |
| card.installing | Installing... | 创建中... |

实现：`MetaTemplateCard.vue` import `useLocale`，5 处串改 helper；计数行 en 用单复数 helper。它有独立组件测试面（home/template-center spec 已覆盖渲染），改后跑相关 spec 回归。

## 4. 范围边界（明确写清）

| 在 T2 | 不在 T2（= T3 或单列） |
|---|---|
| `MultitableWorkbench.vue` 模板可见 chrome（冲突横幅 / 工具栏 / 模板库 modal 标题&状态 / 快捷键 modal） | 子组件 Meta\*（GridTable/RecordDrawer/ViewManager/Kanban/Form/Calendar/Gallery/Timeline…）—— 表体/抽屉/管理面板**保持英文** |
| §3.0 脚本 computed 外壳文案（conflict.message / presence.label / presence.title / conflict.fieldFallback） | `templateLibraryError` 脚本动态错误文案（**T2 不译；最易在打开模板库时被看到，PR body + verification 必须显式声明此英文残留**） |
| Workbench 脚本**静态非插值** toast（§3.5 ~17 个） | §3.5 动态/插值/权限/host-context/Failed-to/import 计数族 toast（→ T3） |
| `MetaTemplateCard.vue` 计数行 + 按钮双语（§3.6） | App.vue / 其它非多维表页（不碰） |
| 统一 footer `更多模板 →` 为双语 | 引入 vue-i18n 框架（明确不做） |
| 新增 `workbench-labels.ts` + 测试 | — |

**T2 已知局限（须在 PR/verification 写明）**：①工作台外壳中文，但点开表格/记录抽屉/视图·字段·权限管理面板**仍英文**（Meta\* 未本地化，T3）；②`templateLibraryError` 模板库加载失败文案**仍英文**；③动态/插值 toast（"Installed X"、"N 条已导入"、"Record not found: id" 等）**仍英文**（T3）。均为 T2 预期边界，非 bug。

---

## 5. 改动文件清单

| 文件 | 改动 |
|---|---|
| `apps/web/src/multitable/utils/workbench-labels.ts` | **新增** ~160 行：key 联合类型 + EN/ZH 表 + `workbenchLabel` + 插值 helper（presence.label 含 en 单复数、presence.title 含空态、conflict.message 含可选 version、commentInboxTitle 含 0 分支、card.sheets/fields/views 计数） |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | import `useLocale` + `workbench-labels`；模板 ~25 处 + §3.0 的 4 个 computed 改读 isZh；脚本静态 toast ~17 处 → `wb(key, isZh.value)`；footer 统一 |
| `apps/web/src/multitable/components/MetaTemplateCard.vue` | import `useLocale`；§3.6 的 5 处串改 helper（计数行 + 按钮） |
| `apps/web/tests/multitable-workbench-i18n.spec.ts` | **新增**：`workbench-labels` 模块单测（key 完整性 + en≠zh + 9 个插值 helper） |
| `apps/web/tests/multitable-home-view.spec.ts` + `multitable-template-center-view.spec.ts`（既有） | 加 `beforeEach setLocale('zh-CN')` + afterEach 复位——MetaTemplateCard 转 locale 感知后，这两 spec 的中文断言需显式 locale（jsdom 默认 'en'） |

> **`multitable-workbench-view.spec.ts`（T2 合并时不改，后续 PR 已补真断言）**：T2 合并时该 spec 受 jsdom `localStorage` baseline 阻塞（53/53），故当时不加 render 断言。**该 baseline 已由后续 PR `web-test-jsdom-localstorage-baseline-fix-20260519` 根因修复**（全局 setupFile polyfill），并在该 spec 内**已补真实 Workbench locale render 断言**（复用既有重 mock，zh-CN/en 各一例，55/55 绿）。本节保留以记录 T2 合并时点的口径与交叉引用；Workbench 本体双语 render 现**有**自动化覆盖。

不动：后端 / 契约 / migration / 其它 Meta\* 组件 / 其它视图 / `multitable-workbench-view.spec.ts`。

不动：后端 / 契约 / migration / 其它 Meta\* 组件 / 其它视图。

---

## 6. Test Plan

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-i18n.spec.ts --watch=false       # label 模块（核心覆盖）
pnpm --filter @metasheet/web exec vitest run tests/multitable-home-view.spec.ts --watch=false           # MetaTemplateCard 回归
pnpm --filter @metasheet/web exec vitest run tests/multitable-template-center-view.spec.ts --watch=false # MetaTemplateCard 回归
pnpm --filter @metasheet/web exec vitest run tests/platform-shell-nav.spec.ts --watch=false             # 回归：locale 开关未破
git diff --check origin/main..HEAD
```

Acceptance：

- `workbench-labels`：每 key en/zh 非空且不相等；`workbenchLabel(k,true)`→zh、`(k,false)`→en；插值 helper（presence.label en 单复数、presence.title 空态、conflict.message 可选 version、commentInboxTitle 0 分支、card.* 计数）代入正确。`<kbd>` 物理键名不翻译、不进表
- Workbench 本体（zh-CN/en 渲染）：T2 合并时无自动化断言（workbench-view baseline 阻塞）；**后续 baseline-fix PR 已补真实 render 断言**（`multitable-workbench-view.spec.ts` zh-CN 断言「字段/权限/视图/评论收件箱/仪表盘/API 与 Webhook」、en 对应英文，55/55 绿）。Workflow/Automations 因默认 `canManageAutomation=false` 不在默认断言（可选增强）。当时口径下另由 label spec + `vue-tsc`（key 合法性）+ build + 人工 diff 兜底
- MetaTemplateCard（精确口径）：**zh-CN（默认）下 Home/TemplateCenter 必须保持**「`{n} 个 Sheet` / `{n} 个字段` / `{n} 个视图` / `使用模板` / `创建中...`」——既有 home-view / template-center-view spec 文案断言零回归；**en 下显示**「`{n} sheet(s)` / `{n} field(s)` / `{n} view(s)` / `Use template` / `Installing...`」（计数 en 走单复数）
- **静态 toast 全覆盖证明**：verification MD 附 `grep -nE "showSuccess\(|showError\(" MultitableWorkbench.vue` 全量，逐条标 `[T2-done]`/`[T3-deferred]`
- `git diff --check` clean；diff 仅 §5 所列文件

---

## 7. K3 PoC 阶段一锁定合规

| 检查 | 状态 |
|---|---|
| plugin-integration-core / k3-wise / Data Factory | ❌ 不碰 |
| `/api/multitable/*` 等任何契约 | ❌ 不碰（纯前端文案） |
| DB migration / schema | ❌ 零 |
| 新产品面 / 平台化 | ❌ 否（本地化已发布 UI = 内核打磨） |
| vue-i18n 等框架级改动 | ❌ 不做（仅轻量 label 模块） |

---

## 8. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 漏译（某字面量未替换） | 中 | §3 清单逐条核对；组件测试抽样两语言关键串；实现后 `grep` 残留英文 chrome |
| 脚本 toast 含动态拼接，套 `wb()` 破坏插值 | 中 | §3.5 注明：纯静态先做，含动态片段的转 helper 或记 T2 边界转 T3 |
| `sheetPresenceLabel`/`sheetPresenceTitle`/`conflictMessage` 是脚本 computed，可能含英文 | 中 | 实现时 grep 这些 computed 定义；含英文则并入 label 模块，否则记录为既有（多为后端/纯数据）不在 T2 |
| 改 25+ 处字面量引入语法错误 | 低 | 分段改 + 每段后 `vue-tsc --noEmit`；组件测试守护渲染 |
| footer 既有中文被测试断言依赖 | 低 | 改前 grep `更多模板` 在 tests/ 的引用；H2 测试断的是 router-link 存在性非文案，安全 |

---

## 9. PR 拆分

```
分支: frontend/multitable-workbench-i18n-20260519   (已建，off origin/main)
Lane: frontend
体量: S–M（1 新模块 + 1 视图改 + 1 测试）
预计 PR: 1
```

---

## 10. 推荐执行顺序

1. **审本 MD**（你现在做的）—— 重点确认 §3 译文措辞 + §4 边界（Meta\* 不在 T2）
2. 审过 → 建 `workbench-labels.ts`（全 key + 译文）
3. Workbench 接入（模板段 → 脚本 toast 段，每段后 typecheck）
4. 写组件 + 模块测试
5. 跑 §6 验证 → 写 verification MD
6. 本地 commit + 停 push 前（沿用本会话节奏）→ 你 review → push → CI → admin-merge

---

## 11. 变更日志

- **2026-05-19 (1)** 初稿（zensgit + claude-opus-4-7 协作）
- **2026-05-19 (2)** 评审修订（3 Must + 3 Should）：
  - **Must1**：补 §3.0 脚本 computed 外壳文案——`conflictMessage`(L891)/`conflictFieldName`(L886 'cell' fallback)/`sheetPresenceLabel`(L879)/`sheetPresenceTitle`(L882)；§3.4 补 `kbd.navigateCells`(L306 漏的首行)
  - **Must2**：MetaTemplateCard 纳入 T2（§3.6）——modal 内孤立中文计数/按钮，与 footer 同理；它也被 home/template-center 复用，双语化全局净改进
  - **Must3**：§3.5 修正——实测 `showSuccess/showError` = **70** 个（非 ~15）；T2 只做静态非插值子集（~17），动态/插值/权限/host-context/Failed-to/import 计数族明列 T3；验收改为"静态全覆盖 + verification 附全量 grep 分类 [T2-done]/[T3-deferred]"
  - **Should1**：测试改为复用 `multitable-workbench-view.spec.ts` 既有重 mock 范式 + home/template-center spec 回归，不新挂载
  - **Should2**：实现 review 须盯——`wb` 模板内 computed 自动 unwrap、脚本内统一 `isZh.value`
  - **Should3**：`templateLibraryError` 不译，PR body + verification + §4 边界**显式声明**英文残留（打开模板库最易见的错误态之一）
- **2026-05-19 (3)** 实现前最后 3 个文档一致性修订：
  - §2 key 联合补全（presence/conflict/card/kbd.navigateCells 分组）+ 顶部加"示意骨架，完整以 §3 为准 + 插值 helper 单列"声明，防实现者照旧 §2 漏 key
  - §3.5 标题从"~15 个"改为"静态子集 ~17 进 T2 + 动态族列 T3"，消除标题/正文矛盾
  - §6 acceptance MetaTemplateCard 精确化：zh-CN（默认）Home/TemplateCenter 必保「个 Sheet/个字段/个视图/使用模板/创建中...」零回归，en 显示 sheet(s)/field(s)/view(s)/Use template/Installing...
  - §3.0 加实现陷阱：`conflict.message` 的 `[ ]` 是 optional 段标记非字面方括号，输出禁现 `[`/`]`；`presence.title` ids 若为 user id 不译 id 本身
  - 译文/边界经评审确认：presence.*/conflict.message/card.sheets(保留 "Sheet" 不改"个表") 措辞接受；T3 边界（templateLibraryError/动态 toast/Meta\*）确认
- **2026-05-19 (4)** 实现后评审 P1/P2 修正（验证声称诚实化）：
  - §5：删除"`multitable-workbench-view.spec.ts` 加 locale 断言"行（该 spec 既有 localStorage baseline 53/53，往里加断言无意义）；改为诚实口径——Workbench 本体 render **无**自动化断言，正确性由 label spec + vue-tsc(key 合法性) + build + 人工 diff 审阅保证
  - §6：移除 workbench-view spec 命令 + "Workbench zh-CN/en 渲染断言"验收项，改为诚实表述
  - verification §7 加"测试覆盖诚实声明"段（P2）：Workbench 双语 render 未新增自动化，附原因 + 未来 baseline 修复后应补真实断言
  - 实际改动 spec 仅 2 个（home-view/template-center 的 setLocale 回归处理）+ 1 新增（workbench-i18n label spec）
