# T2 多维表工作台中文化 — 验证报告

- **日期**：2026-05-19
- **配套**：[multitable-workbench-i18n-t2-development-20260519.md](./multitable-workbench-i18n-t2-development-20260519.md)
- **分支**：`frontend/multitable-workbench-i18n-20260519`

---

## 1. 实现摘要

| 文件 | 改动 |
|---|---|
| `apps/web/src/multitable/utils/workbench-labels.ts` | **新增** ~200 行：`WorkbenchLabelKey` 联合（47 静态 key）+ EN/ZH 表 + `workbenchLabel` + 9 个插值 helper（conflictMessage / presenceLabel / presenceTitle / commentInboxTitle / mentionsUnread / mentionsRecords / cardSheets / cardFields / cardViews） |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | import `useLocale` + label 模块；§3.0 四个 computed 改 helper；模板 ~25 处字面量 → `wb()` / helper；脚本 17 处静态 toast → `wb(key, isZh.value)`；footer `更多模板 →` → `wb('tpl.more', isZh)` |
| `apps/web/src/multitable/components/MetaTemplateCard.vue` | import `useLocale`；计数行 3 串 → cardSheets/Fields/Views；按钮 → `card.install`/`card.installing`；categoryDisplay 传 locale |
| `apps/web/tests/multitable-workbench-i18n.spec.ts` | **新增**：label 模块单测（key 完整性 + en≠zh + 9 helper） |
| `apps/web/tests/multitable-home-view.spec.ts` | beforeEach `setLocale('zh-CN')` + afterEach 复位（MetaTemplateCard 转 locale 感知后的回归处理） |
| `apps/web/tests/multitable-template-center-view.spec.ts` | 同上 |

---

## 2. 测试结果（实测）

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit                                              → clean
pnpm --filter @metasheet/web build                                                              → ✓ 6.20s
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-i18n.spec.ts            → 8/8 pass
pnpm --filter @metasheet/web exec vitest run tests/multitable-template-center-view.spec.ts      → 9/9 pass
pnpm --filter @metasheet/web exec vitest run tests/platform-shell-nav.spec.ts                   → 5/5 pass
pnpm --filter @metasheet/web exec vitest run tests/multitable-home-view.spec.ts                 → 7 fail（见 §3 baseline）
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-view.spec.ts            → 53 fail（见 §3 baseline）
git diff --check                                                                                → clean
```

## 3. baseline 诚实声明（home-view / workbench-view 失败非 T2 回归）

`multitable-home-view.spec.ts`（7 fail）与 `multitable-workbench-view.spec.ts`（53 fail）的失败**全部**是 `localStorage.removeItem is not a function`（spec afterEach 在本 jsdom env 的既有问题），与本会话 Phase B/B3/H2 记录的同一 baseline。

**已用 stash 法在 clean origin/main 复核**：

```
git stash (T2 改动) → 在 origin/main 原状跑 multitable-workbench-view.spec.ts
→ 同样 53 failed (53)  ← 与带 T2 改动结果逐字一致
```

证明：workbench-view 53/53 是**预存 env baseline**，非 T2 引入。T2 对测试账本**净新增失败 = 0**；新增 8（label spec）全绿。

> MetaTemplateCard 转 locale 感知**确曾**让 home/template-center 的中文断言短暂回归（jsdom 默认 `en`）。已在两 spec 加 `beforeEach setLocale('zh-CN')` 修复——修复后 MetaTemplateCard 中文断言（`1 个 Sheet · 0 个字段 · 2 个视图` / `使用模板`）全部通过；template-center 9/9 全绿，home-view 仅剩与 MetaTemplateCard 无关的 localStorage afterEach baseline。

## 4. 静态 toast 全覆盖证明（MD §3.5 强制项）

`grep -nE "showSuccess\(|showError\(" MultitableWorkbench.vue` 全量分类：

### [T2-done] 17 个 → `wb('toast.*', isZh.value)`

`changeReapplied` `commentAdded` `commentDeleted` `commentResolved` `commentUpdated` `datesUpdated` `formSubmitted` `hierarchyUpdated` `linkedRecordsUpdated` `loadedLatest` `recordCreateBlocked` `recordDeleteBlocked` `recordDeleted` `recordEditBlocked` `recordUpdated`(×2 站点) `viewSettingsSaved`

### [T3-deferred] 15 个（动态/插值/权限/host-context，**非遗漏，MD §3.5 已明列**）

| 行 | 内容 | 归类 |
|---|---|---|
| 1757 | `Sheet creation requires multitable write access.` | 权限 |
| 2040/2042 | `Host multitable context change …` ×2 | host-context |
| 2097 | `Base creation requires multitable write access.` | 权限 |
| 2122/2133 | `Template installation requires multitable write access.` ×2 | 权限 |
| 2154 | `` `Installed ${result.template.name}` `` | 动态插值 |
| 2239/2245/2247/2249/2253 | `` `${n} record(s) imported/failed/skipped` `` ×5 | 动态插值 |
| 2261 | `Import cancelled` | import 族 |
| 2470 | `` `${n} record(s) deleted` `` | 动态插值 |
| 2568 | `` `Record not found: ${recordId}` `` | 动态插值 |

**结论**：每个 T2 静态 toast 已转 `wb()`；每个 T3-deferred 项确为动态/插值/权限/host-context（与 MD §3.5 预测逐条吻合），无任何静态字符串被遗漏。

## 5. T2 已知局限（须随 PR 显式声明，非 bug）

1. **Meta\* 子组件仍英文**：工作台外壳已中文，但点开表格（MetaGridTable）/记录抽屉（MetaRecordDrawer）/字段·视图·权限管理面板（MetaViewManager 等）**仍英文** —— T3。
2. **`templateLibraryError` 仍英文**：打开模板库若加载失败，错误文案为英文（脚本动态错误，T3）。这是打开模板库最易见的错误态之一，**显式声明**。
3. **15 个动态/插值 toast 仍英文**：`Installed X`、`N 条已导入`、`Record not found: id`、权限/host-context 提示等 —— T3。

均为 T2 预期边界，已在 dev MD §4 锚定。

## 6. K3 PoC 阶段一锁定合规

| 检查 | 状态 |
|---|---|
| plugin-integration-core / k3-wise / Data Factory | ❌ 不碰 |
| `/api/multitable/*` 等任何契约 | ❌ 不碰（纯前端文案 + 一个新前端 util） |
| DB migration / schema | ❌ 零 |
| 新产品面 / 平台化 / vue-i18n 框架 | ❌ 否（轻量 label 模块，本地化已发布 UI = 内核打磨） |

`git diff --name-only origin/main..HEAD` 仅含：dev MD + 本 verification MD + workbench-labels.ts + MultitableWorkbench.vue + MetaTemplateCard.vue + 3 个 spec。

## 7. 结论

T2 实现与（评审三轮修订后的）dev MD 完全一致：工作台外壳 + §3.0 computed + 17 静态 toast + MetaTemplateCard + footer 全部中文化，预期响应顶部 en/zh-CN 开关。label 模块 8/8 单测绿，typecheck/build 绿，回归零净新增。T3 边界（Meta\* / templateLibraryError / 动态 toast）明确锚定。

> **测试覆盖（更新 2026-05-19）**：T2 合并时 Workbench 本体双语 render 无自动化断言（`multitable-workbench-view.spec.ts` 受 jsdom localStorage baseline 阻塞，53/53）。**该 baseline 已由后续 PR `web-test-jsdom-localstorage-baseline-fix-20260519` 根因修复**（全局 setupFile in-memory Storage polyfill；全套件失败 217→16、零回归、`comm -13` 空），并在 `multitable-workbench-view.spec.ts` 补了真实 Workbench locale render 断言（zh-CN 断言「字段/权限/视图/评论收件箱/仪表盘/API 与 Webhook」、en 断言对应英文，复用既有重 mock，55/55 绿）。因此 T2 §7 的"无自动化 render"残留风险**已消除**——保留此说明以记录历史与交叉引用。

**待执行**：本地 commit → 停 push 前（沿用本会话节奏）→ 用户 review → push → CI → admin-merge。

---

## 8. 变更日志

- 2026-05-19 验证报告（zensgit + claude-opus-4-7 协作）
