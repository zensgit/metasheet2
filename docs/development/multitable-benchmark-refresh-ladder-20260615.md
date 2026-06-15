# 多维表对标飞书 — 差距阶梯刷新(post-cross-base-arc)— 2026-06-15

> Status: **REFRESH(`multitable-benchmark-refresh-ladder-20260611.md` 的后继刷新)**
> 方法:对 `origin/main@c2c59994c` 逐项 **代码落地核验**(非文档标记——本仓两次 stale-marker 翻车 #2177/C5-2,故所有"已闭合"判定均带 file:line / PR 锚点)。2 并行核验员(① 旧阶梯 19 项真实状态 + 开放 PR triage;② deferred 账本 + 飞书前沿候选),1 综合按总纲四原则(measurement→optimization · enterprise-baseline→differentiation · foundations→advanced · stability→risk)重排。
> 配套:benchmark-surpass goal(owner 2026-06-11 set)+ cross-base 完成收口 `multitable-crossbase-program-completion-20260614.md`。

## 0. 核心结论:2026-06-11 阶梯已基本耗尽

自上次阶梯(grounded @ `932b350df` / #2506)以来 main 落了 **114 个提交**。19 项阶梯**几乎整条烧穿**,包括压轴的 XL cross-base。这不是一次"重排",而是一次"换前沿"——旧阶梯里只剩 2 项门控 carry-over,下一弧必须从新的飞书差距里挑。

### 0.1 已闭合(代码核验为真,非文档标记)

| 旧 rank | 项 | 落地 PR | 代码锚点 |
|---|---|---|---|
| 1 | 计划账本 + 分支卫生 | #2506 | 阶梯文档本身 |
| 2 | 质量打磨批 | #2509 / #2524 | — |
| 3(部分) | S5a 性能 harness | #2497 | `scripts/ops/multitable-perf-baseline.mjs`(S5b 首跑仍 ops 门,见 §1) |
| 5 | webhook 出站管道接线 | #2511 | bridge + retry tick |
| 6 | webhook retry 策略 + send_webhook 加固 | #2512 | — |
| 7 | view-config api 回归网修复 + CI 接线 | #2513 | **稳定债 CLOSED** |
| 8 | lock_record 存储契约 + 重新暴露 | #2514 / #2554 | `MetaAutomationRuleEditor.vue:1267-1270,2694` |
| 9 | AI 用量台账留存/aging | #2519 | leader-lock scheduler |
| 10 | S4 limitSingleRecord 翻转语义(FE) | #2525 | FE 仅 `MetaFieldManager.vue`;后端守卫仍开放,见 §1 |
| 11 | M4 公式 AI 辅助 | #2518 / #2520 | NL→formula suggest,**已发布非 deferred** |
| 12 | scatter x/y 二维聚合 | #2516 | — |
| 13 | 小 parity 批(评论/进度/person chip/附件缩略图) | #2517 | — |
| 15 | 规则型 UI 深度(条件格式 + 字段条件可见) | 条件格式早于阶梯(5/14)+ #2605 | `MetaGridTable.vue:595/604/665`、`field-visibility-rule.ts` |
| 16 | 日历事件拖拽 | #2581 | lock/mask/version-aware |
| 17(基底) | 富文本 longText render+editor | #2598 / #2614 | XSS-safe;in-cell @mention 仍开放,见 §1 |
| 19 | **Cross-base 链接/自动化(战略 XL)** | #2510→#2574/#2576→#2582/#2584/#2585→#2586/#2588→#2611/#2613/#2615/#2618/#2620 | 整条 Phase A/B/C,收口文档 `multitable-crossbase-program-completion-20260614.md` |

额外(不在旧阶梯但已落):双向镜像链接 MVP(#2595)、export 列选择后端 param(#2591,**仅后端**见 §2)、QR 字段(#2593)、cross-base 写配额护栏(#2587)。

### 0.2 旧阶梯仅剩的 carry-over(2 项,均门控)

- **rank 4 §8-4 生产 SMTP 真实发送验收** — 代码完整(`email-transport-readiness.ts`)+ smoke harness 在;**仅缺 ops 凭据**(`MULTITABLE_EMAIL_SMTP_*` + 双确认 env),无代码工作量。**ops 门**。
- **rank 14 C1 模板 PM 包** — 引擎 + 9 个分类模板 + dry-run 详情已在 main(#2503;route `univer-meta.ts:4567` + `MultitableTemplateDetailView.vue`);缺的是**行业内容深度**。**PM/SME 内容门**。(开放 PR #2499 = #2503 的 78-behind 近重复,仅 2 个 ahead-commit 增量内容,需 rebase 或 fold-in,低优。)

## 1. 旧阶梯遗留 + 即刻可做(无 ops/内容门)

1. **rank 10 后端守卫** — `limitSingleRecord` true→false 翻转在 field PATCH 路径**无 view 重校验**(`univer-meta.ts:4339` 明文记为 accepted residual);#2525 只补了 FE。代码修复 = **开放 PR #2523**(98 behind,需 rebase)。
2. **rank 17 in-cell @mention** — longText 编辑器(`MetaRichLongTextEditor.vue`,321 行)工具栏只有 bold/italic/list/link,**零 @mention 触发**;现有 `MetaMentionPopover` 是评论收件箱级,非格内。未开始。
3. **#2623 AI 配额 overshoot 修复** — `ai-usage-ledger.ts` estimate-aware admission,近 main(2 behind),真 bug fix,可直接 triage/merge。

## 2. 两处"文档 ≠ 代码"(勿信文档)

1. **export 列/行选择(#2591)** — 收口文档称已发;**代码现实**:#2591 只给 `GET .../export-xlsx` 加了后端 `fieldIds` query param,且 commit 自述"行(recordIds)与 FE 列选择器是 deferred follow-up,grid 导出按钮 client-side 构建 xlsx 不走此 route"。canonical FE 导出(`MultitableWorkbench.vue:2538-2596`)导出全部可见字段 + 全部行,**绕过掩码 route**。→ **PARTIAL**,用户面 + 行选择仍开放(见 A2)。
2. **"AI 字段"** — 无 `'ai'` field type(`types.ts:6-33`);AI 是 text 字段上的 `aiShortcut`(summarize/classify/extract/translate)**仅手动触发**,auto-trigger 明确出 M0 章程。scoping AI rings 时注意。

## 3. 下一弧候选(重排后的新阶梯)

### A 组 — baseline parity 缺口(飞书 table-stakes)

| # | 候选 | 代码状态 | 量级 | 门 |
|---|---|---|---|---|
| A1 | **网格虚拟化(行 windowing)** — 主文档 §3 Gap 1 头号企业规模阻塞;`MetaGridTable.vue` 仅分页 + `content-visibility:auto`,无窗口化依赖。测量前置(S5a #2497)已清。 | ABSENT | **L** | owner opt-in;先跑 S5b 50k/100k staging 基线(ops 门)锚预算 |
| A2 | **FE 导出列/行选择器 + 把 grid 导出接到掩码 route** — 收尾半成的 #2591 | PARTIAL | S–M | 无(lock-safe) |
| A3 | **内联链接记录展开(expand-to-edit)** — 现仅 count/chips + picker modal;cross-base 后更显眼 | ABSENT | L | 设计锁(展开 vs 真嵌套) |
| A4 | **表单逻辑深度**(required-if / 多页 / URL prefill / 提交后跳转) — #2605 仅 show/hide | PARTIAL | M | 设计锁(复用可见性规则词汇) |
| A5 | **条件格式样式深度**(data bar / 色阶 / 图标集) — 现仅纯底色+文字色(`types.ts:102-106`) | PARTIAL | M | 轻设计锁 |

### B 组 — 差异化 / 超越

| # | 候选 | 代码状态 | 量级 | 门 |
|---|---|---|---|---|
| B1 | **按钮 / 动作字段** — 行级触发 automation/开 URL;action backbone(update/create/delete/webhook/lock)已成熟,边际成本低 | ABSENT(无 `'button'` type) | M | 设计锁(可调用范围) |
| B2 | **AI 字段后续 rings**(auto-trigger + generate/translate-table/sentiment/tag;NL→filter) — 主文档 §3 Gap 3 头号差异化;M0-M4 基底已成 | PARTIAL | L/ring | 每 ring 独立 opt-in;auto-trigger 需章程解锁 |
| B3 | **原生同步/外部源表**(按计划镜像外部 DB/API/另一 base) — 有 data-factory + data-sources CRUD,但无 multitable 原生 syncedTable | PARTIAL/ABSENT | XL | owner opt-in + 设计锁(K3/集成边界) |
| B4 | **仪表盘非图表组件**(KPI 数字卡 / 仪表盘级筛选 / 联动) — 现 `MetaDashboardView.vue` 仅 chart panel | ABSENT | M–L | 轻设计锁 |
| B5 | **longText in-content @mention / 图片 / 表格** — sanitizer 在,编辑器无 mention/image/table | PARTIAL | L | 设计锁(与 mention 基建联合) |
| B6 | **评论 emoji 反应 + 通知 digest/中心** — 现仅 threaded 评论 + mention 收件箱 | ABSENT | M | 无重门(additive) |
| B7 | **行级条件权限规则引擎** — 主文档 §3 Gap 7 企业必备;现 `record_permissions` 为静态授权,无规则引擎;cross-base 已加 base-perm 原语 | PARTIAL | L | owner opt-in(安全敏感,走对抗式评审 lane) |

### C 组 — 稳定债

| # | 候选 | 代码状态 | 量级 | 门 |
|---|---|---|---|---|
| C1 | 生产 SMTP 真实发送验收(carry rank 4) | harness 在,验收未做 | S(多为 ops) | ops 凭据门 |
| C2 | 模板 PM/SME 内容包(carry rank 14) | 机制在,行业内容无 | M | PM/SME 内容门(并行 lane) |
| C3 | person-field mock 测试隔离债(收口文档 §6,CI-excluded) | 已知债 | S | 无 |
| C4 | 移动 / 响应式 / PWA — 主文档 §7-B,§3 标记"无需求" | ABSENT | XL | deferred(无具名需求,仅在有用例时进) |

## 4. 已退役/明确不做(核验,勿再列为候选)

view-config 回归网(#2513 闭)· M4 公式 AI 辅助(#2520 发)· scatter(#2516)· 日历拖拽(#2581)· webhook 出站+retry(#2511/#2512)· lock_record 重暴露(#2514)· AI 台账留存(#2519)· parity 批(#2517)· 字段条件可见(#2605);旧 §3 已杀集:PWA(低)· kanban swimlane · 全嵌套 sub-record(XL/弱需求)· location 地图选择器(provider 依赖)· duration 字段(无具名需求)· 双向镜像写回(#2595 已发 derived-reverse MVP,完整写回折进设计空间)· AI auto-trigger ring(M0 章程划出)· FOL-3/4/5/6/8/9(各自 gate)· FOL-7 Yjs 重算(需求门)。

## 5. 推荐排序(按总纲四原则)

- **首发(门已清 / 高杠杆 / 小):** A2(lock-safe,收尾 #2591)· C3(债卫生)· #2623(AI 配额 bug,近 main)· #2523 rebase(rank 10 后端守卫)。均 S。
- **测量锚 → 头号 baseline:** S5b 50k/100k staging 基线(ops 门)→ **A1 网格虚拟化**(测量前置已满足后的标杆 L 缺口)。
- **baseline parity:** A4(表单深度)· A5(条件格式深度)· A3(链接记录展开)。
- **差异化:** B1(按钮字段——给定成熟 action backbone,最便宜的超越)→ B4(仪表盘组件)→ B5/B6(longText mention / 评论反应)→ B2(AI rings,逐 ring opt-in)→ B7(行级规则权限,安全 lane)→ B3(原生同步表,XL/owner 门)。
- **战略 XL 槽**(cross-base 已发,空出):B3 或 B7,二者均 owner 门 + 设计锁先行。

## 6. 开放 PR triage(2026-06-15)

| PR | 分类 | 处置 |
|---|---|---|
| #2523 hierarchy parent downgrade guard | in-flight / rank-10 后端修复 | rebase(98 behind)后落 |
| #2623 AI quota overshoot fix | in-flight / 真 bug,近 main | triage/merge |
| #2499 template dry-run detail | stale / 近重复 #2503 | rebase 或 fold-in,低优 |
| #2484 AI provider readiness gate | in-flight 但极 stale(129 behind,856+) | 决策是否仍要(M1b scope)+ 重 rebase |
| #2522 / #2495 AI docs reconcile | noise / stale(已被 #2521 收口超越) | 关闭或合 |
| #2508 ladder format polish | noise / 已被本刷新文档取代 | 关闭 |

## 7. 落地

rank-1 = 本文档。后续按 goal 纪律:gate-free 项走标准管线;owner/PM/ops 门项到点请示。本刷新取代 #2508 对 06-11 阶梯的格式打磨(旧阶梯已耗尽,polish 无意义)。
