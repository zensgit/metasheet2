# Data Factory FOS(field-option-sync)— 设计与验证汇总(2026-06-21)

> 本文是 #3020「把 business-specific 的 stock-prep option-sync 泛化为通用 field-option-sync」这条线的**设计 + 验证**汇总(完成态交付物)。索引各刀文档,不替代它们。
> 红线继承:metadata-only(只 patch 字段选项元数据)/ own-sheet / admin-gated / **无外部写 / 无 K3 / 无生产写** / values-free evidence / 凭据不经 request。

## 0. 一页结论

- **FOS 全可自主构建段已落地**:FOS-0(设计锁)→ FOS-1(合同)→ FOS-2(runtime 泛化,stock-prep 零漂移)→ FOS-3(UI,dual-route 不破坏既有能力)→ FOS-2b-pre(host 只读 `getObjectField`)→ FOS-2b(sync-mode merge runtime,三锁:不删除 / 不静默写 / replace 零漂移)→ **FOS-4 prove-the-path**(2nd preset `disable_missing` + per-target readiness + **HTTP wire-test,P2 closed**)。Data Factory 的选项同步从「同步备料选项」(business-specific)泛化为「同步字段选项」(generic + preset),**stock-prep 降为第一个 preset / 兼容锚**;`append`/`disable_missing`/`keep_existing`/`manual_confirm` runtime 已实现,并由 FOS-4 在 stock-prep 表上 **HTTP 解封 + wire-verified**(disable_missing 真实 route 只禁不删)。
- **每刀**:独立 PR + adversarial review APPROVE + 经验非空洞证明(zero-drift / values-free / wire revert-proof)+ 真实 gate(后端 node 测试;前端 `vue-tsc -b`)。
- **剩余 gated(各带 gate,非自动构建)**:**FOS-4b**(action-binding 泛化 + 真实业务域 preset)、**scheduled / after-source-refresh 触发**(demand-gated)。见 §6;**每项需先签的 scope decision 见 §7**(余下开发 = decision-gated,本轮不在 blanket 指令下盲开)。

## 1. 状态阶梯

| 刀 | 内容 | 状态 | 锚点(SHA = squash) |
|---|---|---|---|
| **FOS-0** | 通用 field-option-sync 设计锁(合同 + stock-prep=first preset + preset 目录形态 + §7 裁决 + 分刀) | ✅ done | #3021(`c5ceb6d8b`)+ reconcile #3024(`5fd7c2b8d`) |
| **FOS-1** | field-option-sync 合同 + values-free preset 目录(stock-prep 第一条),lock-safe(不接 runtime) | ✅ done | #3030(`fabfebe8c`) |
| **FOS-2** | runtime 泛化:通用 `syncFieldOptions` kernel + stock-prep 瘦包装(**字节级零漂移**)+ generic route `POST /api/integration/field-options/sync` + stock-prep route 兼容别名 | ✅ done | #3032(`e01af925a`) |
| **FOS-3** | UI:panel→`字段选项同步`、button→`同步字段选项`、preset picker;**dual-route**(纯选项→generic / actionBindings·legacy-alias→stock-prep route)不破坏既有能力 | ✅ done | #3037(`b9d375622`) |
| **FOS-2b-pre** | host 只读 `getObjectField`(读字段当前 property/options;SELECT-only,absent→null)——sync-mode merge 的前置(既有 ensureObject 读会 UPSERT 覆盖 options) | ✅ done | #3040(`a47114c02`) |
| **FOS-2b** | sync-mode merge runtime:`append`/`disable_missing`(只禁不删)/`conflictPolicy`(keep_existing/manual_confirm);**replace+update_from_source = FOS-2 fast path 零漂移**;锁:不删除 / 不静默写 / replace 零漂移 | ✅ done | #3046(`4af6bb6fa`) |
| **FOS-4(prove-the-path)** | 2nd reference preset(`disable_missing`,同 stock-prep 表)+ readiness 改 **per-TARGET** + **HTTP wire-test**;证明 catalog 承载 2nd preset / readiness binding / route 真走 getObjectField / disable_missing 只禁不删 / **P2 closed**(新模式经 stock-prep 表 HTTP 解封 + wire-verified) | ✅ done | #3050(`1d6e05299`) |
| FOS-4b | action-binding 泛化 + 真实业务域 preset(stock-prep 表以外 source/target,各带自己的 readiness binding) | 🔒 gated(opt-in;own review + negative controls) | 设计锁 §11 |
| scheduled 触发 | scheduled / after_source_refresh | 🔒 gated(demand-gated,各带 gate + observability) | 设计锁 §11 |

## 2. 逐刀交付

- **FOS-0 设计锁(#3021 + reconcile #3024)**:通用合同(sourceKind / sourceObjectOrTable / value+label+group 字段 / targetTable / targetField / syncMode / conflictPolicy / triggerMode),锚定现有 stock-prep 真实实现;stock-prep = first preset + zero-drift 兼容锚;preset 目录复用 S3-3 reference-catalog values-free 形态(与 S3 pipeline 解耦);§7 owner 裁决;FOS-1→4 分刀。#3022(我并行误开的重复)已 closed,价值折回 #3021 via #3024。
- **FOS-1 合同(#3030)**:`field-option-sync-contract.cjs` — enum-strict normalizer(sourceKind/syncMode/conflictPolicy/triggerMode/targetFieldType;targetKind 锁 `metasheet:field-options`)+ values-free preset 目录(FORBIDDEN keys + secret-shaped 拒绝,经验非空洞)。**lock-safe:不被任何 runtime import**;stock-prep 路径零触碰。
- **FOS-2 runtime(#3032)**:`field-option-sync-runtime.cjs` 通用 kernel(loop/skip/patch/error-if-none;caller 供 `buildPropertyPatch`);`syncStockPreparationOptions` 重构为瘦包装,patch body + evidence **字节级不变**。generic route admin-gated + 闭合 allowlist + preset 解析(未知 presetId 422)+ source-key 校验 + actionBindings fail-closed + generic `fieldOptionSync` 元数据(非 `stockPreparation`)。**修一个 build 暴露的真 blocker**:FOS-1 preset.targetTable `stock_preparation_main`→`plm_stock_preparation_main`(须等于模板 objectId;host 把 objectId hash 成 sheetId)+ generic route 加 readiness gate(stock-prep preset 复用 canonical readiness;无 readiness binding 的 preset fail-closed)。
- **FOS-3 UI(#3037)**:generic panel + preset picker(默认 `备料选项同步 / Stock Preparation`);**dual-route 不破坏既有能力**——纯 `{optionSets}`→generic route(带 presetId);带 `actionBindings`/`actions` **或** legacy alias keys(`optionSources`/`configInfo`)→既有 stock-prep route(body 字节级不变,options+actions 能力保留)。所选路径在 DOM 显示(`field-options-sync-path`)——**非静默**;actionBindings 检测器是后端 reject 条件的**超集**。UI 文案移除 generic action-binding 承诺(动作绑定 = stock-prep 兼容路径;泛化待 FOS-4)。
- **FOS-2b-pre 只读 read API(#3040)**:host `getObjectField`(provisioning.ts SELECT-only,absent→null,无写/无 merge)+ interface + index.ts read-only 装配 + plugin-scope 同 patch 的 project/object scope 包装。前置原因:唯一既有“读”路径 `ensureObject` 是 UPSERT(`ON CONFLICT DO UPDATE SET property = EXCLUDED.property`),用来读会**抹掉 options**。
- **FOS-2b sync-mode merge runtime(#3046)**:kernel `mergeFieldOptions` + `syncFieldOptions` 加 `syncMode`/`conflictPolicy`/`readCurrentOptions`/`held`。`append`=并集(不删);`disable_missing`=源 + 源中没有的当前项**置 disabled 不删**;`conflictPolicy` overlap:`keep_existing` 保留当前(人工)字段、`update_from_source` 取源;`manual_confirm`=**不写**,返回 values-free `held`(wouldAdd/Update/Disable 计数)。**`replace`+`update_from_source` = FOS-2 fast path(不读不 merge)→ stock-prep 字节级零漂移**;非默认模式缺 `readCurrentOptions` → fail-closed。generic route 传 preset.syncMode/conflictPolicy + getObjectField-backed reader。新模式 runtime kernel-tested;经 HTTP 的解封 + wire-test 见 FOS-4。
- **FOS-4 prove-the-path(#3050)**:catalog 加 2nd reference preset `preset.stock-preparation.disable-missing.v1`(同 stock-prep 表,仅 `syncMode=disable_missing`);route readiness gate 改 **per-TARGET**(`preset.targetTable === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`)——两 preset 皆覆盖,异表 preset 仍 fail-closed;**HTTP wire-test** 驱动 disable_missing preset 走**真实** getObjectField closure(**revert-proof**:置空 getObjectField → 测试 fail),断言 route 真走 getObjectField / disable_missing 只禁不删(`bar` 留 disabled)/ values-free。**P2 closed**;action-binding 泛化延后 FOS-4b。

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
| FOS-2b #3046 | **3 锁经验证**:不删除(disable_missing 留 disabled)/ 不静默写(manual_confirm 0 patch + values-free held)/ replace 零漂移(默认 fast path 不读 + 原样 patch;**revert-proof 非空洞**)+ keep_existing/update_from_source overlap + fail-closed guard + 复审 APPROVE。(P2 coverage 由 FOS-4 closed,见下) |
| FOS-4 #3050 | **P2 closed**:HTTP wire-test 驱动 disable_missing preset 走**真实** getObjectField closure(**revert-proof**:置空 getObjectField → 测试 fail)+ disable_missing 真实 route 只禁不删(`bar` 留 disabled)+ per-TARGET readiness(异表 fail-closed)+ 2nd preset values-free + stock-prep v1 仍 preset[0] + 无 scope creep(action-bindings 仍 fail-closed)+ 复审 APPROVE |

## 5. §7 owner 裁决(本轮采用的 v1 默认)

preset 存储 = 冻结目录常量(无 migration);syncMode 默认 = `replace`(零漂移);`disable_missing` = 只禁不物理删(**FOS-2b 已实现 runtime**);conflictPolicy 默认 = `update_from_source`;triggerMode = `manual`;route = 新增 generic route + 保留 stock-prep route 兼容。enums 的 append/disable_missing、keep_existing/manual_confirm **runtime 已在 FOS-2b 实现**(kernel + route 装配),并由 **FOS-4 在 stock-prep 表上 HTTP 解封 + wire-verified**(2nd preset `disable_missing`);其他表的 preset 仍 fail-closed(FOS-4b);scheduled/after_source_refresh 仍待后续刀。

## 6. 剩余 gated 项

| 项 | gate | 备注 |
|---|---|---|
| **FOS-4b(action-binding 泛化 + 真实业务域 preset)** | opt-in + own review + negative controls | 首个引入 stock-prep 表**以外**的 source/target 配置;preset 须带自己的 readiness binding;action-binding 泛化(当前 generic route fail-closed,UI 走 legacy)= 专门 slice。(FOS-4 prove-the-path 已 closed P2 + 解封 stock-prep 表新模式) |
| **scheduled / after_source_refresh 触发** | demand-gated(各带 gate + observability) | 当前仅 manual |
| append / keep_existing / manual_confirm 的 HTTP wire-test | 随用到这些模式的 preset(FOS-4b) | FOS-2b runtime + kernel 三锁 tested;FOS-4 已 wire-test `disable_missing`;其余模式 wire-test 待有 preset 实际使用它们 |

## 7. 余下开发 = decision-gated(每项需先签 scope,本轮不盲开)

「完成余下的开发」的诚实结论:**可自主构建段已闭合**(§1);余下三项各缺一个 owner decision。blanket /goal ≠ 单项 scoped opt-in——尤其 action-binding 涉安全模型,设计锁要求其各自 own review + negative controls。本轮不在 blanket 指令下盲开。各项需先签的点:

### 7.1 FOS-4b action-binding 泛化 — 需 scope + 安全模型
当前 generic route 对带 `actionBindings` 的请求 **fail-closed**(`FIELD_OPTION_SYNC_ACTIONS_NOT_SUPPORTED`,http-routes.cjs);动作绑定只走 stock-prep 兼容路径(FOS-3 dual-route 正是为把动作执行挡在 generic 路径外)。泛化前先定:
- **allowlist 归属**:动作 allowlist 是 per-preset 声明还是全局?非 stock-prep preset 能绑哪些 predefined 动作?
- **安全模型**:非 stock-prep preset 执行动作的 dry-run / 权限 / 审计;
- **negative controls**:非 allowlist 动作仍 fail-closed;浏览器仍不能传任意动作体。
→ 建议先单独 design-lock 一个 preset-action-binding 安全模型,再开 impl slice。

### 7.2 真实业务域 preset — 需一个 named target
prove-the-path(FOS-4)已证明 catalog 承载多 preset + per-target readiness 可工作。真实域 preset(material category / supplier class / warehouse / unit …)各需:一个**真实且已 provision 的 target**(表 + select 字段,不能凭空造)+ 该 target 的 readiness binding(per-target,机制已有)。
→ 需 owner **点名一个真实字段/表**;之后即作为 catalog 常量加(轻量,复用现框架)。

### 7.3 scheduled / after_source_refresh — demand-gated
当前仅 manual。调度需 scheduler + observability(各带自己的 gate)。无具名 demand 盲建 scheduler = over-build。
→ 需 owner 给一个**具名调度 demand**(哪个 preset、何种触发、可观测要求),再开。

### 7.4 append / keep_existing / manual_confirm 的 wire-test
route 仅从冻结 catalog 解析 preset(`resolveFieldOptionSyncPreset` 无注入 seam);为这些模式加 catalog 项 = 污染 picker(FOS-4 刻意回避的 product-surface 扩张)。kernel 三锁已覆盖这些模式 + route 路径已由 `disable_missing` wire-test 证明。→ 随 FOS-4b 真实 preset 用到这些模式时一并 wire-test。

---

_校验脚注(更新 2026-06-22):FOS-0..3 + FOS-2b-pre + FOS-2b + FOS-4 全合并——#3021/#3024/#3030/#3032/#3037/#3040(`a47114c02`)/#3046(`4af6bb6fa`)/#3050(`1d6e05299`)。重复 #3022 已 closed(价值折回 #3024)。每刀红线:metadata-only / own-sheet / admin / 无外部写 / 无 K3 / 无生产写 / values-free 均守;stock-prep replace 零漂移经验非空洞(断 kernel patch → stock-prep fail);FOS-2b 三锁(不删除 / 不静默写 / replace 零漂移)经验证;FOS-2b-pre getObjectField read-only;**FOS-4 P2 closed**(HTTP wire-test 走真实 getObjectField,revert-proof;disable_missing 真实 route 只禁不删);FE gate = 真实 `vue-tsc -b`。剩余 gated:FOS-4b(真实域 preset + action-binding 泛化)、scheduled 触发。_
