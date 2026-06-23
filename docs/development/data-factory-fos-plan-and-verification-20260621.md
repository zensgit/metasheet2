# Data Factory FOS(field-option-sync)— 设计与验证汇总(2026-06-21)

> 本文是 #3020「把 business-specific 的 stock-prep option-sync 泛化为通用 field-option-sync」这条线的**设计 + 验证**汇总(完成态交付物)。索引各刀文档,不替代它们。
> 红线继承:metadata-only(只 patch 字段选项元数据)/ own-sheet / admin-gated / **无外部写 / 无 K3 / 无生产写** / values-free evidence / 凭据不经 request。

## 0. 一页结论

- **FOS 全可自主构建段已落地**:FOS-0(设计锁)→ FOS-1(合同)→ FOS-2(runtime 泛化,stock-prep 零漂移)→ FOS-3(UI,dual-route 不破坏既有能力)→ FOS-2b-pre(host 只读 `getObjectField`)→ FOS-2b(sync-mode merge runtime,三锁:不删除 / 不静默写 / replace 零漂移)→ **FOS-4 prove-the-path**(2nd preset `disable_missing` + per-target readiness + **HTTP wire-test,P2 closed**)→ **FOS-4b-1/2 action dry-run**(contract + generic route dry-run path,**先不执行写**)。Data Factory 的选项同步从「同步备料选项」(business-specific)泛化为「同步字段选项」(generic + preset),**stock-prep 降为第一个 preset / 兼容锚**;`append`/`disable_missing`/`keep_existing`/`manual_confirm` runtime 已实现,并由 FOS-4 在 stock-prep 表上 **HTTP 解封 + wire-verified**(disable_missing 真实 route 只禁不删);action-binding 的 generic dry-run 路径已打通且 apply 仍关闭。
- **每刀**:独立 PR + adversarial review APPROVE + 经验非空洞证明(zero-drift / values-free / wire revert-proof)+ 真实 gate(后端 node 测试;前端 `vue-tsc -b`)。
- **剩余 gated(各带 gate,非自动构建)**:**FOS-4b-3-prod 首笔生产 apply**(写 prod canonical;sandbox apply gate 已 shipped,但生产写仍是独立 owner gate)、**真实业务域 preset**、**scheduled / after-source-refresh 触发**(demand-gated)。见 §6;**每项需先签的 scope decision 见 §7**(余下开发 = decision-gated,本轮不在 blanket 指令下盲开)。

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
| **FOS-4b-1(action contract)** | 动作注册表 `FOS_PREDEFINED_ACTIONS` + preset `permittedActionIds`(enum-strict ∈ 注册表)+ normalizer(注册表∩permitted、param 白名单、gating 注册表所有、禁动作体)。**LOCK-SAFE 零执行**(generic route 仍 fail-closed;未接执行;stock-prep 零漂移) | ✅ done | #3066(`7a602a013`) |
| **FOS-4b-2(action dry-run path)** | generic route `dryRun` 模式接受 actionId 引用 → 经 FOS-4b-1 注册表∩preset 校验 → values-free preview;**先不执行写**(preview 在 kernel 前 return → 零 patch / 零执行);非 dryRun + 动作 → fail-closed;pure-option 零漂移 | ✅ done(**owner ratified dry-run-only**)| #3072(`6f6ff921d`) |
| FOS-4b-3-impl(sandbox apply gate)| P0 fail-closed sandbox 闸,守住 small+large-BOM 两条 apply 路径;server config / env(`STOCK_PREP_SANDBOX_MODE`+allowlist)开关;prod canonical 始终拒 | ✅ shipped(sandbox-only;owner ratified A;adversarial review APPROVE,large-BOM bypass 已闭)| 本 PR |
| FOS-4b-3-prod(首笔生产 apply)| 解除 sandbox 限制、对 prod canonical 真实写 | 🔒 gated(独立 owner gate;**先过 sandbox validation runbook**,sandbox-first 证完后才提议)| `…fos-4b-3-sandbox-validation-runbook-20260623.md` |
| FOS-4b 真实业务域 preset | stock-prep 表以外 source/target,各带自己的 readiness binding | 🔒 gated(需 named target) | 设计锁 §7.2 |
| scheduled 触发 | scheduled / after_source_refresh | 🔒 gated(demand-gated,各带 gate + observability) | 设计锁 §11 |

## 2. 逐刀交付

- **FOS-0 设计锁(#3021 + reconcile #3024)**:通用合同(sourceKind / sourceObjectOrTable / value+label+group 字段 / targetTable / targetField / syncMode / conflictPolicy / triggerMode),锚定现有 stock-prep 真实实现;stock-prep = first preset + zero-drift 兼容锚;preset 目录复用 S3-3 reference-catalog values-free 形态(与 S3 pipeline 解耦);§7 owner 裁决;FOS-1→4 分刀。#3022(我并行误开的重复)已 closed,价值折回 #3021 via #3024。
- **FOS-1 合同(#3030)**:`field-option-sync-contract.cjs` — enum-strict normalizer(sourceKind/syncMode/conflictPolicy/triggerMode/targetFieldType;targetKind 锁 `metasheet:field-options`)+ values-free preset 目录(FORBIDDEN keys + secret-shaped 拒绝,经验非空洞)。**lock-safe:不被任何 runtime import**;stock-prep 路径零触碰。
- **FOS-2 runtime(#3032)**:`field-option-sync-runtime.cjs` 通用 kernel(loop/skip/patch/error-if-none;caller 供 `buildPropertyPatch`);`syncStockPreparationOptions` 重构为瘦包装,patch body + evidence **字节级不变**。generic route admin-gated + 闭合 allowlist + preset 解析(未知 presetId 422)+ source-key 校验 + actionBindings fail-closed + generic `fieldOptionSync` 元数据(非 `stockPreparation`)。**修一个 build 暴露的真 blocker**:FOS-1 preset.targetTable `stock_preparation_main`→`plm_stock_preparation_main`(须等于模板 objectId;host 把 objectId hash 成 sheetId)+ generic route 加 readiness gate(stock-prep preset 复用 canonical readiness;无 readiness binding 的 preset fail-closed)。
- **FOS-3 UI(#3037)**:generic panel + preset picker(默认 `备料选项同步 / Stock Preparation`);**dual-route 不破坏既有能力**——纯 `{optionSets}`→generic route(带 presetId);带 `actionBindings`/`actions` **或** legacy alias keys(`optionSources`/`configInfo`)→既有 stock-prep route(body 字节级不变,options+actions 能力保留)。所选路径在 DOM 显示(`field-options-sync-path`)——**非静默**;actionBindings 检测器是后端 reject 条件的**超集**。UI 文案移除 generic action-binding 承诺(动作绑定 = stock-prep 兼容路径;泛化待 FOS-4)。
- **FOS-2b-pre 只读 read API(#3040)**:host `getObjectField`(provisioning.ts SELECT-only,absent→null,无写/无 merge)+ interface + index.ts read-only 装配 + plugin-scope 同 patch 的 project/object scope 包装。前置原因:唯一既有“读”路径 `ensureObject` 是 UPSERT(`ON CONFLICT DO UPDATE SET property = EXCLUDED.property`),用来读会**抹掉 options**。
- **FOS-2b sync-mode merge runtime(#3046)**:kernel `mergeFieldOptions` + `syncFieldOptions` 加 `syncMode`/`conflictPolicy`/`readCurrentOptions`/`held`。`append`=并集(不删);`disable_missing`=源 + 源中没有的当前项**置 disabled 不删**;`conflictPolicy` overlap:`keep_existing` 保留当前(人工)字段、`update_from_source` 取源;`manual_confirm`=**不写**,返回 values-free `held`(wouldAdd/Update/Disable 计数)。**`replace`+`update_from_source` = FOS-2 fast path(不读不 merge)→ stock-prep 字节级零漂移**;非默认模式缺 `readCurrentOptions` → fail-closed。generic route 传 preset.syncMode/conflictPolicy + getObjectField-backed reader。新模式 runtime kernel-tested;经 HTTP 的解封 + wire-test 见 FOS-4。
- **FOS-4 prove-the-path(#3050)**:catalog 加 2nd reference preset `preset.stock-preparation.disable-missing.v1`(同 stock-prep 表,仅 `syncMode=disable_missing`);route readiness gate 改 **per-TARGET**(`preset.targetTable === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`)——两 preset 皆覆盖,异表 preset 仍 fail-closed;**HTTP wire-test** 驱动 disable_missing preset 走**真实** getObjectField closure(**revert-proof**:置空 getObjectField → 测试 fail),断言 route 真走 getObjectField / disable_missing 只禁不删(`bar` 留 disabled)/ values-free。**P2 closed**;action-binding 泛化延后 FOS-4b。
- **FOS-4b-1/2 action dry-run(#3066/#3072)**:#3066 落 action registry + `permittedActionIds` 合同层(零执行);#3072 在 generic route 的 `dryRun` 模式接入 actionId 引用,通过注册表∩preset 校验后返回 values-free preview。**先不执行写**:dry-run 在 kernel 前 return → 零 patch / 零执行;非 dryRun + 动作 → fail-closed;pure-option 路径零漂移。apply 仍是 FOS-4b-3 独立安全门。

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
| FOS-4b-1/2 #3066/#3072 | action registry + permittedActionIds 合同层 zero-execution;generic route dry-run path **只 preview 不 patch / 不执行**(kernel 前 return),非 dryRun + 动作 fail-closed,apply gated,pure-option 零漂移,values-free preview,no-bypass negative controls + 复审 APPROVE |

## 5. §7 owner 裁决(本轮采用的 v1 默认)

preset 存储 = 冻结目录常量(无 migration);syncMode 默认 = `replace`(零漂移);`disable_missing` = 只禁不物理删(**FOS-2b 已实现 runtime**);conflictPolicy 默认 = `update_from_source`;triggerMode = `manual`;route = 新增 generic route + 保留 stock-prep route 兼容。enums 的 append/disable_missing、keep_existing/manual_confirm **runtime 已在 FOS-2b 实现**(kernel + route 装配),并由 **FOS-4 在 stock-prep 表上 HTTP 解封 + wire-verified**(2nd preset `disable_missing`);其他表的 preset 仍 fail-closed(FOS-4b);scheduled/after_source_refresh 仍待后续刀。

## 6. 剩余 gated 项

| 项 | gate | 备注 |
|---|---|---|
| **FOS-4b-3-impl(sandbox apply gate)** | owner ratified A(2026-06-22)+ own review + adversarial review APPROVE | ✅ shipped:P0 fail-closed sandbox 闸守住 **small + large-BOM 两条** apply 路径(large-BOM checkpoint apply bypass 在 route 写入前已闭);server config / env(`STOCK_PREP_SANDBOX_MODE`+allowlist)开关;**objectId 省略 = 视作 prod canonical = 拒**;values-free。**这不是 production apply 解锁**——只是把 sandbox-only gate 补到所有真实写入口。首笔生产 apply(写 prod canonical)= FOS-4b-3-prod 独立 owner gate(仍关闭)。 |
| **FOS-4b 真实业务域 preset** | opt-in + named target | stock-prep 表以外 source/target 仍需 owner 点名真实表/字段 + readiness binding。 |
| **scheduled / after_source_refresh 触发** | demand-gated(各带 gate + observability) | 当前仅 manual |
| append / keep_existing / manual_confirm 的 HTTP wire-test | 随用到这些模式的 preset(FOS-4b) | FOS-2b runtime + kernel 三锁 tested;FOS-4 已 wire-test `disable_missing`;其余模式 wire-test 待有 preset 实际使用它们 |

## 7. 余下开发 = decision-gated(每项需先签 scope,本轮不盲开)

「完成余下的开发」的诚实结论:**可自主构建段已闭合**(§1);余下三项各缺一个 owner decision/input。blanket /goal ≠ 单项 scoped opt-in——尤其 action apply 涉安全模型,设计锁要求其 own review + negative controls。本轮不在 blanket 指令下盲开。各项需先签的点:

### 7.1 FOS-4b action-binding 泛化 — ✅ FOS-4b-1 contract + ✅ FOS-4b-2 dry-run(owner ratified);apply 待 ratify
**FOS-4b-1(contract,#3066 `7a602a013`)+ FOS-4b-2(action dry-run path,#3072 `6f6ff921d`,owner ratified dry-run-only)已合并**:注册表 + `permittedActionIds` + normalizer(完备 negative controls)+ generic route `dryRun` 模式校验动作引用并 values-free preview。**先不执行写**:dryRun 在 kernel 前 return → 零 patch / 零执行;非 dryRun + 动作 → fail-closed(apply 未开);pure-option 零漂移;复审 APPROVE(no-write / apply-gated / no-bypass / values-free 经验证)。**output-allowlist 为承重控制**。**FOS-4b-3(action apply = 真实执行)= 安全门,待 owner ratify("先不执行写"本轮明确);本轮未开。**
设计锁:`data-factory-fos-4b-action-binding-generalization-design-lock-20260622.md` —— committed 安全模型:
- **三层最小权限**:**全局冻结动作注册表**(generalize `PREDEFINED_OPTION_ACTIONS`,own-review 改)拥有动作定义 + 门控(`requiresDryRun`/`requiredPermission`/`allowedParameterBindings`);**preset 声明 permitted SUBSET**(`permittedActionIds`,不能定义新行为);**request 只引用 actionId + 受限参数**(绝不传动作体)。
- **精确保留 FOS-3 不变式**:generic 路径无任意动作执行;dual-route 收窄(允许的动作走 generic 经门控,其余仍 legacy/fail-closed,非静默)。
- **起步 dry-run-only**(§3a),apply 作独立子刀;注册表 = plugin 常量(§3b)。
- 完备 negative controls(未注册/未许可/超参/动作体/未 dry-run/权限不足 → fail-closed)+ stock-prep 零漂移。
→ **分刀**:FOS-4b-1(contract,lock-safe)**✅ done(#3066 `7a602a013`)**;FOS-4b-2(generic route dry-run runtime)**✅ done(#3072 `6f6ff921d`,owner ratified dry-run-only)**;FOS-4b-3-impl(sandbox apply gate)**✅ shipped**(owner ratified A;design-lock `…fos-4b-3-action-apply-design-lock-20260622.md` + correction `…design-lock-correction-20260622.md`):P0 fail-closed sandbox 闸守住 small+large-BOM 两条真实写入口(large-BOM checkpoint apply bypass 在 route 写入前已闭,adversarial review 发现并修复→复审 APPROVE);env/config 开关;objectId 省略=prod canonical=拒;values-free。**非 production apply 解锁**;首笔生产 apply = FOS-4b-3-prod 独立 owner gate(仍关闭);UI 后续。

### 7.2 真实业务域 preset — 需一个 named target
prove-the-path(FOS-4)已证明 catalog 承载多 preset + per-target readiness 可工作。真实域 preset(material category / supplier class / warehouse / unit …)各需:一个**真实且已 provision 的 target**(表 + select 字段,不能凭空造)+ 该 target 的 readiness binding(per-target,机制已有)。
→ 需 owner **点名一个真实字段/表**;之后即作为 catalog 常量加(轻量,复用现框架)。

### 7.3 scheduled / after_source_refresh — demand-gated
当前仅 manual。调度需 scheduler + observability(各带自己的 gate)。无具名 demand 盲建 scheduler = over-build。
→ 需 owner 给一个**具名调度 demand**(哪个 preset、何种触发、可观测要求),再开。

### 7.4 append / keep_existing / manual_confirm 的 wire-test
route 仅从冻结 catalog 解析 preset(`resolveFieldOptionSyncPreset` 无注入 seam);为这些模式加 catalog 项 = 污染 picker(FOS-4 刻意回避的 product-surface 扩张)。kernel 三锁已覆盖这些模式 + route 路径已由 `disable_missing` wire-test 证明。→ 随 FOS-4b 真实 preset 用到这些模式时一并 wire-test。

## 8. 整线集成验证(merged on main @ `287a9b525`,2026-06-22)

全 8 刀合并后**整线重跑**(非逐刀声明,而是 merged 代码上的集成 re-run):

```text
plugin-integration-core 全套 : 32 文件,EXIT=0(含 field-option-sync-contract / -runtime[FOS-2b 三锁] /
                               stock-preparation-option-sync / http-routes[FOS-4 wire-test] / adapter-contracts / pipelines …)
empirical 非空洞               : 断 kernel patchObjectFieldProperty → stock-prep 测试 fail + http-routes(含 FOS-4
                               wire-test)fail → 还原即绿(zero-drift + wire-test 皆非空洞)
host(FOS-2b-pre)             : core-backend tsc PASS + multitable-provisioning / plugin-scope 16 passed
FE(FOS-3)                    : vue-tsc -b PASS + IntegrationWorkbenchView spec 42 passed
boundary                      : REQUIRED_ADAPTER_METHODS 未改(0) / FOS 链零 migration(0) /
                               getObjectField 无 UPDATE·INSERT·DELETE(read-only)
```

结论:**contract → runtime → UI → sync-mode → prove-the-path 整线在 merged main 上集成绿 + 不变式经验非空洞**。其后 FOS-4b-1/2 又分别以自身 CI + 复审补齐 action contract / dry-run path。余下全部 decision-gated(§7;FOS-4b 安全模型见其设计锁 §8 终态)。

---

_校验脚注(更新 2026-06-22):FOS-0..3 + FOS-2b-pre + FOS-2b + FOS-4 全合并——#3021/#3024/#3030/#3032/#3037/#3040(`a47114c02`)/#3046(`4af6bb6fa`)/#3050(`1d6e05299`)。重复 #3022 已 closed(价值折回 #3024)。每刀红线:metadata-only / own-sheet / admin / 无外部写 / 无 K3 / 无生产写 / values-free 均守;stock-prep replace 零漂移经验非空洞(断 kernel patch → stock-prep fail);FOS-2b 三锁(不删除 / 不静默写 / replace 零漂移)经验证;FOS-2b-pre getObjectField read-only;**FOS-4 P2 closed**(HTTP wire-test 走真实 getObjectField,revert-proof;disable_missing 真实 route 只禁不删);**FOS-4b-1 action contract #3066(`7a602a013`)+ FOS-4b-2 action dry-run path #3072(`6f6ff921d`,owner ratified dry-run-only)已合并**(注册表+permittedActionIds+normalizer 完备 negative controls;dryRun 校验动作引用 + values-free preview,**先不执行写**:preview 在 kernel 前 return → 零 patch / 零执行;非 dryRun + 动作 fail-closed;pure-option 零漂移;复审 APPROVE);FE gate = 真实 `vue-tsc -b`。剩余 gated:**FOS-4b-3 action apply(真实执行,待 ratify apply)**、FOS-4b 真实域 preset(需 named target)、scheduled 触发(需 named demand)——各缺仅 owner 能给的决策/输入。_
