# Data Factory FOS(field-option-sync)— 设计与验证汇总(2026-06-21)

> 本文是 #3020「把 business-specific 的 stock-prep option-sync 泛化为通用 field-option-sync」这条线的**设计 + 验证**汇总(完成态交付物)。索引各刀文档,不替代它们。
> 红线继承:metadata-only(只 patch 字段选项元数据)/ own-sheet / admin-gated / **无外部写 / 无 K3 / 无生产写** / values-free evidence / 凭据不经 request。

## 0. 一页结论

- **FOS 全可自主构建段已落地**:FOS-0(设计锁)→ FOS-1(合同)→ FOS-2(runtime 泛化,stock-prep 零漂移)→ FOS-3(UI,dual-route 不破坏既有能力)→ FOS-2b-pre(host 只读 `getObjectField`)→ FOS-2b(sync-mode merge runtime,三锁:不删除 / 不静默写 / replace 零漂移)。Data Factory 的选项同步从「同步备料选项」(business-specific)泛化为「同步字段选项」(generic + preset),**stock-prep 降为第一个 preset / 兼容锚**;`append`/`disable_missing`/`keep_existing`/`manual_confirm` runtime 已实现(经 HTTP 待 FOS-4 非默认 preset 解封)。
- **每刀**:独立 PR + adversarial review APPROVE + 经验非空洞证明(zero-drift / values-free)+ 真实 gate(后端 node 测试;前端 `vue-tsc -b`)。
- **剩余 gated(各带 gate,非自动构建)**:**FOS-4**(额外 preset 编写 + action-binding 泛化)、**scheduled / after-source-refresh 触发**(demand-gated)。见 §6。

## 1. 状态阶梯

| 刀 | 内容 | 状态 | 锚点(SHA = squash) |
|---|---|---|---|
| **FOS-0** | 通用 field-option-sync 设计锁(合同 + stock-prep=first preset + preset 目录形态 + §7 裁决 + 分刀) | ✅ done | #3021(`c5ceb6d8b`)+ reconcile #3024(`5fd7c2b8d`) |
| **FOS-1** | field-option-sync 合同 + values-free preset 目录(stock-prep 第一条),lock-safe(不接 runtime) | ✅ done | #3030(`fabfebe8c`) |
| **FOS-2** | runtime 泛化:通用 `syncFieldOptions` kernel + stock-prep 瘦包装(**字节级零漂移**)+ generic route `POST /api/integration/field-options/sync` + stock-prep route 兼容别名 | ✅ done | #3032(`e01af925a`) |
| **FOS-3** | UI:panel→`字段选项同步`、button→`同步字段选项`、preset picker;**dual-route**(纯选项→generic / actionBindings·legacy-alias→stock-prep route)不破坏既有能力 | ✅ done | #3037(`b9d375622`) |
| **FOS-2b-pre** | host 只读 `getObjectField`(读字段当前 property/options;SELECT-only,absent→null)——sync-mode merge 的前置(既有 ensureObject 读会 UPSERT 覆盖 options) | ✅ done | #3040(`a47114c02`) |
| **FOS-2b** | sync-mode merge runtime:`append`/`disable_missing`(只禁不删)/`conflictPolicy`(keep_existing/manual_confirm);**replace+update_from_source = FOS-2 fast path 零漂移**;锁:不删除 / 不静默写 / replace 零漂移 | ✅ done | #3046(`4af6bb6fa`) |
| FOS-4 | 额外 preset 编写 + action-binding 泛化(首个引入 stock-prep 以外 source/target 配置;**令 FOS-2b 新模式 HTTP 可达**) | 🔒 gated(opt-in;own review + negative controls + 新模式 wire-test) | 设计锁 §11 |
| scheduled 触发 | scheduled / after_source_refresh | 🔒 gated(demand-gated,各带 gate + observability) | 设计锁 §11 |

## 2. 逐刀交付

- **FOS-0 设计锁(#3021 + reconcile #3024)**:通用合同(sourceKind / sourceObjectOrTable / value+label+group 字段 / targetTable / targetField / syncMode / conflictPolicy / triggerMode),锚定现有 stock-prep 真实实现;stock-prep = first preset + zero-drift 兼容锚;preset 目录复用 S3-3 reference-catalog values-free 形态(与 S3 pipeline 解耦);§7 owner 裁决;FOS-1→4 分刀。#3022(我并行误开的重复)已 closed,价值折回 #3021 via #3024。
- **FOS-1 合同(#3030)**:`field-option-sync-contract.cjs` — enum-strict normalizer(sourceKind/syncMode/conflictPolicy/triggerMode/targetFieldType;targetKind 锁 `metasheet:field-options`)+ values-free preset 目录(FORBIDDEN keys + secret-shaped 拒绝,经验非空洞)。**lock-safe:不被任何 runtime import**;stock-prep 路径零触碰。
- **FOS-2 runtime(#3032)**:`field-option-sync-runtime.cjs` 通用 kernel(loop/skip/patch/error-if-none;caller 供 `buildPropertyPatch`);`syncStockPreparationOptions` 重构为瘦包装,patch body + evidence **字节级不变**。generic route admin-gated + 闭合 allowlist + preset 解析(未知 presetId 422)+ source-key 校验 + actionBindings fail-closed + generic `fieldOptionSync` 元数据(非 `stockPreparation`)。**修一个 build 暴露的真 blocker**:FOS-1 preset.targetTable `stock_preparation_main`→`plm_stock_preparation_main`(须等于模板 objectId;host 把 objectId hash 成 sheetId)+ generic route 加 readiness gate(stock-prep preset 复用 canonical readiness;无 readiness binding 的 preset fail-closed)。
- **FOS-3 UI(#3037)**:generic panel + preset picker(默认 `备料选项同步 / Stock Preparation`);**dual-route 不破坏既有能力**——纯 `{optionSets}`→generic route(带 presetId);带 `actionBindings`/`actions` **或** legacy alias keys(`optionSources`/`configInfo`)→既有 stock-prep route(body 字节级不变,options+actions 能力保留)。所选路径在 DOM 显示(`field-options-sync-path`)——**非静默**;actionBindings 检测器是后端 reject 条件的**超集**。UI 文案移除 generic action-binding 承诺(动作绑定 = stock-prep 兼容路径;泛化待 FOS-4)。
- **FOS-2b-pre 只读 read API(#3040)**:host `getObjectField`(provisioning.ts SELECT-only,absent→null,无写/无 merge)+ interface + index.ts read-only 装配 + plugin-scope 同 patch 的 project/object scope 包装。前置原因:唯一既有“读”路径 `ensureObject` 是 UPSERT(`ON CONFLICT DO UPDATE SET property = EXCLUDED.property`),用来读会**抹掉 options**。
- **FOS-2b sync-mode merge runtime(#3046)**:kernel `mergeFieldOptions` + `syncFieldOptions` 加 `syncMode`/`conflictPolicy`/`readCurrentOptions`/`held`。`append`=并集(不删);`disable_missing`=源 + 源中没有的当前项**置 disabled 不删**;`conflictPolicy` overlap:`keep_existing` 保留当前(人工)字段、`update_from_source` 取源;`manual_confirm`=**不写**,返回 values-free `held`(wouldAdd/Update/Disable 计数)。**`replace`+`update_from_source` = FOS-2 fast path(不读不 merge)→ stock-prep 字节级零漂移**;非默认模式缺 `readCurrentOptions` → fail-closed。generic route 传 preset.syncMode/conflictPolicy + getObjectField-backed reader。新模式当前 **HTTP-dormant**(目录仅默认 preset;非默认 preset 抛 `PRESET_NO_READINESS` 直到 FOS-4)→ kernel-tested,wire-test 留 FOS-4(P2)。

## 3. 红线 / 不变式(逐刀守)

- **metadata-only**:只经 provisioning patch 字段 `.property.options` / 元数据;**不写业务行、不经外部系统、不碰 K3、不写生产**。
- **own-sheet**;**admin-gated**(FE + 后端);**凭据不经 request**;请求闭合 allowlist;禁可执行键 / secret-shaped / placeholder。
- **values-free evidence + DOM**:只 field id / source key / 计数 / 路径备注;无选项值 / 源行 / sheetId / 凭据。
- **stock-prep 零漂移**(FOS-2):既有 `stock-preparation-option-sync.test.cjs` 原样绿 = 硬验收;经验非空洞(打断 kernel patch → stock-prep 测试 fail)。
- **不静默破坏既有能力**(FOS-3):actionBindings / legacy-alias 走 legacy route,路径 DOM 可见。
- FOS-1 合同 lock-safe(不接 runtime);targetKind 锁 `metasheet:field-options`。

## 4. 验证汇总

| 刀 | 证据 |
|---|---|
| FOS-1 #3030 | enum-strict(逐 enum 拒绝)+ values-free 非空洞(conn-string + forbidden key 拒)+ catalog deep-copy + lock-safe(grep 无 runtime import)+ 复审 APPROVE |
| FOS-2 #3032 | stock-prep 字节级零漂移(瘦包装 + 结构锁 + **revert-proof**:断 kernel → stock-prep 测试 fail)+ objectId=模板 objectId + readiness gate before patch + generic route safety(admin/allowlist/enum/values-free/actions-fail-closed)+ metadata-only + 复审 APPROVE |
| FOS-3 #3037 | dual-route 不静默破坏(超集检测器 + 路径 DOM 可见 + legacy body 不变)+ spec 断言路由(纯→generic+presetId / actionBindings→legacy / alias→legacy / values-free)+ **真实 FE gate `vue-tsc -b` PASS** + spec 42/42 + 复审 APPROVE |
| FOS-2b-pre #3040 | read-only SELECT-only + absent→null(非空洞:fake-query SELECT 分支只 filter 不改 store)+ 同 patch 的 scope 包装 + host `tsc` PASS + provisioning/plugin-scope 测试 + 复审 APPROVE |
| FOS-2b #3046 | **3 锁经验证**:不删除(disable_missing 留 disabled)/ 不静默写(manual_confirm 0 patch + values-free held)/ replace 零漂移(默认 fast path 不读 + 原样 patch;**revert-proof 非空洞**)+ keep_existing/update_from_source overlap + fail-closed guard + 复审 APPROVE。**P2(coverage,非锁)**:非默认 route 路径(getObjectField-backed closure)当前 HTTP-dormant,wire-test 留 FOS-4 |

## 5. §7 owner 裁决(本轮采用的 v1 默认)

preset 存储 = 冻结目录常量(无 migration);syncMode 默认 = `replace`(零漂移);`disable_missing` = 只禁不物理删(**FOS-2b 已实现 runtime**);conflictPolicy 默认 = `update_from_source`;triggerMode = `manual`;route = 新增 generic route + 保留 stock-prep route 兼容。enums 的 append/disable_missing、keep_existing/manual_confirm **runtime 已在 FOS-2b 实现**(kernel + route 装配),当前经 HTTP **dormant**——目录仅默认 preset,非默认模式 HTTP 可达需 FOS-4 非默认 preset;scheduled/after_source_refresh 仍待后续刀。

## 6. 剩余 gated 项

| 项 | gate | 备注 |
|---|---|---|
| **FOS-4(额外 preset 编写 + action-binding 泛化)** | opt-in + own review + negative controls | 首个引入 stock-prep 以外的 source/target 配置;preset 须带自己的 readiness binding;action-binding 泛化(当前 generic route fail-closed,UI 走 legacy)在此或专门 preset-action-binding slice |
| **scheduled / after_source_refresh 触发** | demand-gated(各带 gate + observability) | 当前仅 manual |
| **append / disable_missing / keep_existing / manual_confirm 新模式** | runtime **已在 FOS-2b 实现** + kernel 三锁 tested;**HTTP 可达 = FOS-4**(非默认 preset)+ 新模式 wire-test(P2) | kernel 三锁齐全(不删除 / 不静默写 / replace 零漂移);经 HTTP 当前仅默认 `replace`+`update_from_source` 可达,其余 dormant |

---

_校验脚注(更新 2026-06-22):FOS-0..3 + FOS-2b-pre + FOS-2b 全合并——#3021/#3024/#3030/#3032/#3037/#3040(`a47114c02`)/#3046(`4af6bb6fa`)。重复 #3022 已 closed(价值折回 #3024)。每刀红线:metadata-only / own-sheet / admin / 无外部写 / 无 K3 / 无生产写 / values-free 均守;stock-prep replace 零漂移经验非空洞(断 kernel patch → stock-prep fail);FOS-2b 三锁(不删除 / 不静默写 / replace 零漂移)经验证;FOS-2b-pre getObjectField read-only;FE gate = 真实 `vue-tsc -b`。剩余 gated:FOS-4(额外 preset + action-binding 泛化 + 令新模式 HTTP 可达 + 其 wire-test)、scheduled 触发。_
