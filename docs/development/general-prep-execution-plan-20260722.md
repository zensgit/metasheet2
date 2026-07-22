# 通用备料系统 — 余下开发执行规划（Execution Plan）

**状态:PROPOSED(执行编排;全部刀受各自门控,G0 ratify 前零 arm)**
**分支:`claude/prep-p1a-substrate-proof-20260722`。所有 file:line 对照本分支真实代码核验(2026-07-22),非记忆、非旧基点。**

上游权威文档(本 MD 只编排,不重造设计):
- `general-prep-system-design-and-verification-20260722.md`(§3 接线 hook、§4 门控记账)
- `general-prep-system-development-plan-20260721.md`(rev-2 P0-P7+P-T3)
- `general-prep-remaining-work-to-a-live-customer-20260722.md`(W1-W4/C1-C2/G1-G4 量表)

尺度:**S**=1-2 天 · **M**=3-5 天 · **L**=1-2 周+。模型:sonnet=铺量实现 · opus=设计门+对抗审 · fable=编排/配置/中量实现。

---

## 1. 并行波次图

```
Wave 0(现在·G0 前·只出设计锁草稿/契约草稿,零代码 arm)
  D0-a W2 模板演进 rung 设计锁草稿      [opus]
  D0-b G1 emit seam 设计锁草稿          [opus]
  D0-c W4 route/body 契约草稿 + C1 runbook 演练清单 [fable]
  D0-d G2 P5 profile 设计草稿(D2 依赖段留桩)      [opus]
        │
        ▼  🔶 G0 owner ratify(非代码,解锁一切接线)
        │
Wave 1(G0 后·可并行)
  ┌─ W1  P1b 接线(S)          target-provisioning.cjs           [sonnet]
  ├─ W2  模板演进 rung(M)     provisioning.ts+index.ts+mvp/target-provisioning.cjs [opus门→sonnet]
  │        ⚠️ W1/W2 同碰 target-provisioning.cjs → W1 先落,W2 rebase
  ├─ W4a P4 消费者·模块段(M) confirm-writes.cjs + 真库测        [opus门→fable]
  ├─ G1d G1 设计门裁决(门)    (D0-b 草稿已备 ⇒ 即审)             [opus]
  ├─ G3a P0 生产激活(S)       owner 配置 + 受控验收(独立,零文件冲突) [owner+opus审]
  └─ C1a 部门协作·非投递段(S) 权限 profile/视图/done-state(runbook 执行) [fable]
        │
        ▼
Wave 2(前置解锁后)
  ┌─ W3  P3 接线(S)           templates.cjs:578 + suggestion 路由   [fable]   ← 硬依赖 W2
  ├─ W4b P4 route 段(併入W4)  http-routes.cjs                        [fable]  ← 与 W3 共享 http-routes.cjs,同一列车串行落
  ├─ G1  emit seam 实现(M-L)  index.ts persist wrapper + realdb      [sonnet实现+opus对抗] ← 需 G1d
  └─ G3b 投递 flag 决策(门)   AUTOMATION_DURABLE_DELIVERY_ENABLED 等 [🔶 owner]
        │
        ▼
  C1b 通知配方真投递验收(S)  ← 需 G3b(;refresh 驱动通知另需 G1)   [fable]
        │
        ▼
Wave 3(外部门/依赖)
  ┌─ G2  P5 图号 profile(M)   ← 硬依赖 D2(#4520 未合)+ 设计门     [opus门→sonnet]
  ├─ C2  工艺 gallery(M)      ← C1 模式复制                          [fable]
  └─ G4  P-T3 K3 写回(L)      ← 🔶 需求门;风险最高,最后            [opus门→专线]
```

### 1.1 共享文件冲突矩阵(并行前必读)

| 文件 | 触碰刀 | 处置 |
|---|---|---|
| `plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs` | **W1**(:287/:413 前插守卫)、**W2**(canonical fail-closed :370-383 旁加 repair 入口) | 同文件不同函数;**W1 先落(S 量级快),W2 rebase**;禁止双 PR 同时 armed |
| `plugins/plugin-integration-core/lib/stock-preparation-templates.cjs` | **W3**(:578 后加字段)、W1 可选项(FORBIDDEN_CONTENT_KEYS 提为顶层导出,:865-888 导出区) | W1 的 templates.cjs 编辑是可选便利(现走 `__internals` :887 已可用)——**建议 W1 放弃该可选项**,templates.cjs 留给 W3 独占 |
| `plugins/plugin-integration-core/lib/http-routes.cjs` | **W3**(suggestion 路由)、**W4b**(carry 路由;路由表 :107-:109 相邻区) | 同一路由表数组,必冲突——**W3/W4b 编成一列车串行落**(先到先落,后者 rebase) |
| `packages/core-backend/src/index.ts` | **W2**(provisioning API 面 :489-543)、**G1**(persist wrapper :1686-1734) | 不同区域,可并行开发;**合并时 G1 后落 rebase**(W2 更小更快) |
| `packages/core-backend/src/multitable/provisioning.ts` | W2 独占 | — |
| `plugins/plugin-integration-core/lib/stock-preparation-mvp-provisioning.cjs` | W2 独占 | — |
| `plugins/plugin-integration-core/lib/stock-preparation-confirm-writes.cjs` | W4a 独占 | — |
| `packages/core-backend/src/multitable/records.ts` | **谁都不碰**(G1 设计裁决,见 §4.2) | P1a 负例不变量守住 |

**真并行组(零文件交集)**:Wave 1 的 {W1, W4a, G1d, G3a, C1a} 完全无冲突;W2 与 W1 仅 target-provisioning.cjs 一处交集(顺序落解决)。

---

## 2. 每刀执行卡

### G0 — owner ratify(前置,非代码)
- **门**:🔶 owner 对可行性 rev-2 + 计划 rev-2 拍板。**不 ratify,以下全部不 arm。**
- **可提前**:Wave 0 四份草稿全部不依赖 G0(设计文档非 arm),备好可省 ratify 后 3-5 天。

### W1 — P1b ext_ 命名空间接线(S,sonnet)
- **入口门**:G0(+ §3 已记账的小门,机械接线)。
- **锚点**:
  - `plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs:214-216`(`missingLogicalFields`,现有单向 drift 检查)
  - 插入点:`:287`(inspect 路径 `buildCanonicalTargetBinding` 前)与 `:413`(ensure 路径同函数前)
  - 复用:`stock-preparation-extension-namespace.cjs:117` `assertExtensionFieldIdValid(fieldId, { templateFieldIds })`、`:81` `isTenantExtensionField`、`:36` `TENANT_EXTENSION_FIELD_ID_PREFIX`
- **改动**:target-provisioning.cjs 新增 `assertTenantExtensionFieldIdsValid(template, resolved)`:
  1. 对 `Object.keys(resolved)` 及未来 ensure 入参中的扩展字段描述符,凡 `isTenantExtensionField(id)` 为真 → `assertExtensionFieldIdValid(id, { templateFieldIds: templateFieldIds(template) })`(fail-closed);
  2. 反向守卫:断言**模板自身**无任何字段 id 落 `ext_` 前缀(两命名空间构造性不相交,防未来模板演进撞进租户区);
  3. 今日对现存表**惰性**(无 ext_ 字段 ⇒ 零行为变化)——这正是它能安全先落的原因。
- **验证**:hermetic 单测(纯函数,无 DB):合法 ext_ 通过 / 模板碰撞 reject / FORBIDDEN_CONTENT_KEYS reject / 模板含 ext_ 前缀 reject;+ 现有 target-provisioning 测试全绿证明惰性。**变异**:删 `:287` 或 `:413` 任一调用 → 新增的 wiring 测试红(两点接线各配一测,防"接一半")。
- **不做**:templates.cjs 顶层导出改造(留给 W3 独占该文件,见 §1.1)。

### W2 — 模板演进 rung(M,opus 设计门 → sonnet;**W3/G2 共享前置**)
- 深化机制方案见 **§3**(本卡只列执行面)。
- **入口门**:G0 + stock-prep 设计门(D0-a 草稿 → opus 裁决)。
- **锚点**:
  - fail-closed 现场:`stock-preparation-mvp-provisioning.cjs:213-216`(「never repairs in place」注释)、`:232-239`(`MVP_TARGET_SCHEMA_INCOMPLETE` throw,:235)、`stock-preparation-target-provisioning.cjs:370-383`(canonical/sandbox 同款 `TARGET_SCHEMA_INCOMPLETE`)
  - 核心原语缺口:`packages/core-backend/src/multitable/provisioning.ts:307-351` `ensureFields` 用 `ON CONFLICT (id) DO UPDATE`(:316-320)——**会覆写既有字段 name/type/property/order,故绝不可复用于修复**(会砸掉 option-sync 写入的选项与租户改名);`:509-540` `ensureObject`(物理 id = `stableMetaId('fld', …)` :531)
  - API 面:`index.ts:489-543`(provisioning surface:findObjectSheet :489 / resolveFieldIds :503 / ensureObject :506 / patchObjectFieldProperty :542)
- **改动**:①核心加 additive-only 原语 `ensureMissingObjectFields`(§3.2);②plugin 侧 mvp-provisioning.cjs / target-provisioning.cjs 加显式 `repair` 动作(§3.3);③`:232` fail-closed throw **原样保留**。
- **验证**:realdb(建表→模板加列→ensure 仍 422→repair→ensure 绿 + 既有字段 property 逐键不变对账);**变异电池**:①把 DO NOTHING 改 DO UPDATE → 红;②repair 允许非 plm_system/ext_ 列 → 红;③删 `:232-239` throw(ensure 静默变 repair)→ 红。
- **量级**:M(核心原语 S + plugin 接线 S + realdb/变异 S)。

### W3 — P3 接线(S,fable;**硬依赖 W2**)
- **入口门**:G0 + W2 落地(否则改模板 ⇒ 已装表全变 incomplete、ensure 422 炸线,审阅 P2-2)。
- **锚点**:
  - `stock-preparation-templates.cjs:578`(`field('lastPlmConflictSummary', …, 'plm_system')`,plm_system 区末尾)后插:`field('suggestedDemandDate', 'Suggested Demand Date', 'date', 'plm_system')`;**不**入 `REQUIRED_SYSTEM_FIELDS`(:16)/`HUMAN_PRESERVED_FIELD_IDS`(:28)——非必填、非 human。
  - 算子:`stock-preparation-suggestion-operators.cjs:400` `SUGGESTED_DEMAND_DATE_FIELD_ID` / `:412` `computeDemandDateCascade` / `:413` `crossProjectPrefillCandidates`(已建已审,零改动)
  - 路由:`http-routes.cjs:66-109` stock-prep 路由块加两条(形制照 `:107` `material-mappings/confirm`):
    `['POST','/api/integration/stock-preparation/suggestions/demand-date-cascade','stockPreparationSuggestionDemandDateCascade']`、
    `['POST','/api/integration/stock-preparation/suggestions/cross-project-prefill','stockPreparationSuggestionCrossProjectPrefill']`;handler 形制照 `:4314` `stockPreparationMaterialMappingConfirm`(requireAccess('admin') → 闭合 body 白名单 → 模块调用 → values-free audit)。
- **改动序**:先对既有租户表跑 W2 repair 加 `suggestedDemandDate` 列 → 路由只写该 plm_system 建议列(复用算子 `__internals.assertSuggestionTargetIsSystemOwned` 的目标约束);human `demandDate` 只能走既有 K2 确认,本刀不动。
- **验证**:hermetic(算子已有 7 组)+ 路由层测试(body 白名单闭合、admin 门、写目标列断言);realdb 一条:级联建议落 `suggestedDemandDate`、`demandDate` 逐字节不动。**变异**:把写目标换成 `demandDate` → 红。
- **冲突**:http-routes.cjs 与 W4b 编队串行(§1.1)。

### W4 — P4 消费者 applyCarryViaConfirm(M,opus 门 → fable;W4a 模块段可 Wave 1 并行,W4b 路由段随 W3 列车)
- **入口门**:G0 + stock-prep 门(P4 语义已 opus 锁定+变异电池 RED,本刀是其 arm)。
- **锚点**:
  - 宿主:`stock-preparation-confirm-writes.cjs`(K2 先例齐备:`:119` `assertAdminPermission` / `:182` `resolveScopedTarget` / `:239` `findByKeyField` / `:399-404` `confirmMaterialMapping` 的「confirmedBy=路由身份、confirmedAt=模块盖章、body 两者皆不可携带」纪律,http-routes.cjs:4313 注释)
  - 决策形状:`stock-preparation-carry-policy.cjs:431` `__internals.assertCarryViaConfirmShape`、`:417` `CARRY_WRITE_VIA`(writeVia:'k2_confirm')
  - 不许动:`stock-preparation-apply-writer.cjs:505` `unsupported_decision` throw(好 fail-closed,carry 决策**永不**进 apply-writer)+ `:187` `assertNoHumanFields` 墙原样
  - human 白名单:`stock-preparation-templates.cjs:28` `HUMAN_PRESERVED_FIELD_IDS`
- **改动**:confirm-writes.cjs 新增 `applyCarryViaConfirm({ context, permission, recordsApi, provisioning, targetProjectId, decision, confirmedBy })`:
  1. `assertAdminPermission(permission)`(:119 复用,先于一切读写);
  2. `assertCarryViaConfirmShape(decision)`(形状不对 fail-closed);
  3. 断言 `decision.carryFields ⊆ HUMAN_PRESERVED_FIELD_IDS`(templates.cjs:28)且 `decision.writeVia === 'k2_confirm'`;
  4. 按 `sourceIdempotencyKey` 读源行(须 `active === false`,与 carry-policy 前置一致)、按 `idempotencyKey` 读目标行(`findByKeyField` :239);
  5. 对 carryFields 做服务代人 UPDATE(recordsApi patch),模块盖章 `carriedBy/carriedAt`,body 不可携带;
  6. 幂等:目标行该 human 字段已非空 ⇒ 闭合 reason reject(绝不静默覆盖,与 P4 冻结语义一致)。
  路由(W4b):http-routes.cjs 路由表 `:109` 旁加 `['POST','/api/integration/stock-preparation/carry/confirm','stockPreparationCarryConfirm']`。
- **验证**:realdb(值真落 + **零 automation outbox 事件**——与 P1a 负例一致的边界断言)+ hermetic 幂等/形状 reject;**变异**:①删 assertCarryViaConfirmShape 调用 → 红;②carryFields 越出 HUMAN_PRESERVED 白名单放行 → 红;③已有值被覆盖 → 红。
- **模型**:opus 审接线设计一轮 → fable 实现 → opus 对抗审(触碰 human 写路径,按 model-split 政策必须对抗)。

### C1 — 部门协作配置包执行(S-M,fable;C1a 可 Wave 1,C1b 需 G3b)
- **入口门**:G0。**真投递段(C1b)另需 G3b。**
- **锚点**:runbook 即 `general-prep-dept-collaboration-config-pack-20260722.md`(手工配置 runbook,诚实无导入原语);字段权限 substrate 已由 P1a 正例2 实证(`stock-prep-substrate-p1a-realdb.test.ts:84`)。
- **改动**:零产品代码。按 runbook 对试点租户执行:字段权限 profile(采购只改 procurementReply、仓库只改 warehouseConfirmation,引 templates.cjs:28 真白名单)+ 部门过滤视图 + personal-view + done-state 字段 + 通知配方(**仅人工编辑+日程触发**;refresh 驱动通知显式列为 G1 后续,不谎称已有)。
- **验证**:每步截图/读回证据(值域 values-free);权限矩阵用两个真部门账号各验一正一反(能改己列、不能改他列)。

### C2 — 工艺 gallery 包执行(M,fable;C1 模式复制)
- **入口门**:C1 模式跑通。
- **锚点**:runbook 即 `general-prep-production-engineering-gallery-pack-20260722.md`;复用排序 = `suggestion-operators.cjs:413` `crossProjectPrefillCandidates`(rankBy:'field_presence')。
- **改动**:零产品代码。工段/工序/工艺 = 普通非冻结租户表 + link/lookup/automation 级联;30 字段工艺词表属实施方配置,不进冻结模板。
- **验证**:级联自动填一条端到端 + 最全方案排序在真数据上一次对账。

### G1 — refresh 通知 emit seam(M-L,opus 设计门 → sonnet 实现 + opus 对抗)
- 深化机制方案见 **§4**。**入口门**:G0 + 设计门(D0-b 草稿 → Wave 1 裁决 G1d)。
- **量级拆分**:设计门 S + 核心实现 S-M + realdb/变异 S + 对抗审 S。

### G2 — P5 图号 profile(M,opus 门 → sonnet;**硬依赖 D2 #4520 + W2**)
- **入口门**:设计门 + D2(#4520,现 PROPOSED 未合)落地;注解列走 W2 repair 加列(plm_system,永不发身份)。
- **现在能做**:D0-d 设计草稿(图号语法 = 版本化+审批+ReDoS-checked 有界分类规则;D2 依赖段留桩)。**不建载体、不排实现期**,D2 合入后再开工。

### G3a — P0 生产激活(S,owner 决策 + opus 审验收)
- **入口门**:🔶 owner 配置决策。**接线已完成**(#3199),非代码刀。
- **锚点**:`stock-preparation-table-actions.cjs:847-851`(policy 只源于 owner 显式设 `context.config.stockPrepApplyProduction`)、`:863` `assertStockPrepApplyAllowed`(单门双入口:显式 canonical objectId + route + actionId 三重匹配,任一失败硬 reject 绝不降级 sandbox)、`:888-893` `assertProductionCleanRowsWithinBound`(maxCleanRows 后置界)、`:899` 调用点。
- **执行**:owner 设 policy(authorizedTargetObjectId='plm_stock_preparation_main'、allowedRoute、allowedActionId、maxCleanRows、expiry)→ 一轮受控验收(±各一:授权 apply 过、目标错/route 错/超界拒)→ 验收 MD。
- **零文件冲突**,Wave 1 即可与一切并行。

### G3b — 投递 flag 决策(门,🔶 owner)
- **锚点**:`automation-durable-delivery.ts:20-21` `AUTOMATION_DURABLE_DELIVERY_ENABLED`(默认 OFF)及 P2 durable-delivery 线四 flag(env-gated,server-config-only)。
- **执行**:owner 按 P2 线的既定序开启;C1b 通知真投递与 G1 durable 段都以此为前置。**本线不代 owner 开 flag。**

### G4 — P-T3 K3 写回(L,🔶 需求门;**风险最高,最后**)
- **入口门**:需求门(具名用例)+ T3 external-write 线设计门。现锁 dry-run/Save-only。
- **范围**:egress/审计/幂等/values-free 全线,循 send-trigger 审计纪律与 T3a/T3b design-lock 先例(`stock-preparation-t3a-erp-source-autopersist-design-lock-20260714.md` 等)。
- **现在能做**:什么都不做(连设计草稿也等具名用例——需求门在先,防无主设计)。

---

## 3. W2 深化:模板演进 rung 机制方案

### 3.1 问题精确化(对照真代码)

fail-closed 现场有**两处同构**:
- `stock-preparation-mvp-provisioning.cjs:232-239`:`ensureMvpTemplate` 对 `present && !ready` 抛 `MVP_TARGET_SCHEMA_INCOMPLETE`(422);注释 `:213-216` 明言 "never repairs a legacy/business table in place"。
- `stock-preparation-target-provisioning.cjs:370-383`:canonical/sandbox `ensureStockPreparationTarget` 对 `${modePrefix}_incomplete` 抛 `TARGET_SCHEMA_INCOMPLETE`。

**为什么今天不能"就地修"**:唯一的字段写原语 `provisioning.ts:307-351` `ensureFields` 是 `INSERT … ON CONFLICT (id) DO UPDATE SET name/type/property/order`——对**已存在**的字段行它会整行覆写。已装表上至少两类状态会被砸:①option-sync(`patchObjectFieldProperty` :353,mvp options/sync 路由)写进 property 的选项集;②租户对字段的改名/排序。所以「incomplete ⇒ 重跑 ensureObject」这条看似最短的路是**错误的**,fail-closed 是对的——缺的不是勇气,是一个 additive-only 原语。

### 3.2 核心机制:additive-only 原语 `ensureMissingObjectFields`

**新函数,`provisioning.ts`(与 `ensureFields` :307 并列)**:

```
ensureMissingObjectFields({ query, projectId, objectId, fields })
  → { addedFieldIds: string[], skippedExistingFieldIds: string[] }
```

1. 物理 id 同 `ensureObject`:`stableMetaId('fld', projectId, objectId, field.id)`(:531 同式);
2. 写语句为 **`INSERT … ON CONFLICT (id) DO NOTHING`**(与 `createView` :484 的 DO NOTHING 先例同构)——既有行**构造性不可触碰**,不是靠约定;
3. 逐字段以 `rowCount` 区分 added/skipped,返回值域 values-free(只有字段 id 与计数);
4. **无 UPDATE、无 DELETE 语句存在于函数体**——「只加不改不删」由语句集合本身保证,变异测试钉死(§3.4)。

**暴露**:`index.ts:489-543` provisioning surface 加一条 `ensureMissingObjectFields`(与 `:542` `patchObjectFieldProperty` 并列);plugin 侧经 `getProvisioningApi` 取用(mvp-provisioning.cjs:309 的 accessor 模式,方法存在性 fail-closed)。

### 3.3 治理守卫(plugin 侧 repair 动作)

`mvp-provisioning.cjs` 新增 `repairStockPreparationMvpTargets`(canonical 同构地落 target-provisioning.cjs),**显式动作,绝不并入 ensure**:

1. **入口门**:`assertAdminPermission`(mvp-provisioning 既有);
2. **只修模板缺列**:待加集合 = `missingLogicalFields(template, resolved)`(target-provisioning.cjs:214)——**修复集是模板与现表的差集,不接受调用方自由列**;调用方无法借 repair 塞任意字段;
3. **命名空间正控**:每个待加字段必须满足 `ownership === 'plm_system'` **或** `assertExtensionFieldIdValid(id, { templateFieldIds })`(extension-namespace.cjs:117)通过——**`human_preserved` 新列被显式 reject**(闭合 reason `REPAIR_HUMAN_FIELD_FORBIDDEN`):human 白名单(templates.cjs:28)是 apply-writer `assertNoHumanFields`(apply-writer.cjs:187)与 carry-policy 的承重词表,扩它是独立设计门,不许从 repair 后门进;
4. **既有列不可变更式核查**:repair 前后各跑一次 DB-backed 的 `readObjectFieldsContent`(逐既有字段读 `name/type/property` 内容快照,非 compute-only 的 `resolveFieldIds`),经 `assertNoExistingFieldMutated` 对账,任何漂移 ⇒ 抛 `REPAIR_MUTATED_EXISTING_FIELD`(fail-closed;这是对 DO NOTHING 的**运行时正控**,不只信 SQL);
5. **fail-closed 原点不动**:`:232-239` 与 `:370-383` 的 throw **一字不改**——ensure 永远不静默修;repair 是**另一个动词**、另一条 admin 路由(`['POST','/api/integration/stock-preparation/mvp/repair','stockPreparationMvpRepair']`,http-routes.cjs :73 `mvp/ensure` 旁),证据模式 `mvp_repaired`;
6. **模板版本纪律**:模板加列必须同 PR 内含 repair 覆盖测试;模板 `version` 走语义化 minor(v1 → v1.1 记入 evidence),repair evidence 带 `templateVersion` + `addedFieldCount`(values-free 计数,非字段清单)。

### 3.4 验证方式

- **realdb 主线**(挂 plugin-tests.yml 白名单,同 :479 先例):provision v1 → 断言 ready → 模拟模板加列(注入含新 plm_system 列的 template)→ `ensure` 仍 422 `MVP_TARGET_SCHEMA_INCOMPLETE`(fail-closed 未被绕过)→ `repair` → `ensure` 绿 + 新列可写 + **既有列 property 逐键 deep-equal**(先塞一个 option-sync 风格 property 再修,证明没被砸);
- **变异电池**(commit 后跑、跑后还原):①`DO NOTHING`→`DO UPDATE` ⇒ 快照对账测试红;②放行 `human_preserved` ⇒ 红;③删 ensure 的 `:232-239` throw ⇒ 「ensure 不得静默修复」测试红;④repair 接受调用方自由字段列 ⇒ 差集测试红。

### 3.5 W3/G2 消费口径

W3 的 `suggestedDemandDate`、G2 的注解列,一律走「模板加列(plm_system)→ repair 已装表 → 接线」三步;两刀自身不再触碰 provisioning 机制。

---

## 4. G1 深化:插件写路径 automation 事件 seam

### 4.1 现状边界(P1a 负例钉死的事实)

- 插件 SDK `records.ts:598-679` `createRecord`(与 `:491-596` `patchRecord`)全函数**零** `enqueueRecordEventIfDurable` 调用(grep 全文件零命中);事件只在网格/服务层发:`record-service.ts:768`(created)、`:1556`(updated)——两处都在**同一源事务内** enqueue,payload 由 `withAutomationEventId`(automation-event-dedup.ts:10)盖 `_eventId`。
- 双相契约(automation-producer-emit.ts:12-19):**相1** `enqueueRecordEventIfDurable`(:44)在源 txn 内,flag ON ⇒ 同事务 outbox(xid probe 拒非事务句柄);**相2** `emitRecordEventIfLegacy`(:63)在 commit 后,flag OFF ⇒ legacy bus,flag ON ⇒ 压制(REPLACE 不双投)。
- 插件备料持久化的**唯一**事务边界:`index.ts:1686-1735` `runStockPreparationPersistUnitOfWork`——validate(:1690)→ `poolManager.get().transaction`(:1691)→ 四表 ownsSheet 核查(:1704-1709)→ 锁序(:1710,`stock-preparation-persist-unit-of-work.ts:76-96`)→ 交给 operation 的 API **只有** `{queryRecords, createRecord, patchRecord}`(:1712-1732)。调用方:`stock-preparation-sync-run-persist.cjs:613`、`stock-preparation-sync-run-repair-once.cjs:402`。
- 负例测试:`packages/core-backend/tests/integration/stock-prep-substrate-p1a-realdb.test.ts:121`(durable ON 时插件 createRecord 零 outbox)。

### 4.2 设计裁决:**复用 producer-emit,批锚点记录事件;不动 records.ts,不开新事件族**

三个候选,取 C:

| 候选 | 判定 |
|---|---|
| **A. records.ts createRecord/patchRecord 直接加 enqueue** | **拒**。爆炸半径 = 全体插件的每次写(不止备料);大 BOM persist 数千行 ⇒ 数千 outbox 事件 + automation 风暴;且一举翻掉 P1a 负例这个全局不变量。 |
| **B. 新事件族 `stockprep.batch.persisted` + 新 trigger type** | **拒(本期)**。要穿 `VALID_TRIGGER_TYPES`(automation-service.ts:101-110)、规则校验、durable dispatcher kind 表(automation-durable-consumer-handlers.ts:79-95)、FE 规则编辑器——面大周期长,而语义上并不比 C 多表达什么。 |
| **C. persist unit-of-work 内,对「批锚点记录」(batch 表该批次行)发一条既有族 `multitable.record.created/updated` 事件** | **取**。批次刷新的通知语义天然是批级;batch 表(objectId `plm_stock_preparation_bom_snapshot_batch`,templates.cjs:620)每批恰有一行,事件基数 O(1);规则侧零新概念——部门在 batch 表上建 `record.updated` 触发 + 条件(watched fields 走既有条件机制)即得「批次刷新→通知」。 |

### 4.3 机制(改哪个函数、加什么守卫、测什么)

**改动点唯一:`index.ts:1712-1732` 的 operation API 加第 4 个方法**(records.ts 零触碰):

```
emitBatchAnchorEvent({ sheetId, recordId, action })   // action ∈ {'created','updated'}
```

wrapper 内实现(在 `runStockPreparationPersistUnitOfWork` 的 txn 闭包中):

1. **守卫1(锚点收窄)**:`sheetId === input.batch.sheetId` 否则抛(闭合 reason `BATCH_ANCHOR_SHEET_MISMATCH`)——事件**只能**挂在批次表,lines/project/run 表一概不许(基数与语义双重钉死);
2. **守卫2(至多一次)**:每个 unit-of-work 调用内第二次调用即抛(`BATCH_ANCHOR_EVENT_ALREADY_EMITTED`)——O(1) 基数由构造保证,非约定;
3. **payload(values-free by construction)**:`withAutomationEventId({ sheetId, recordId, data: <白名单投影>, actorId: null })`——形状对齐 `record-service.ts:1415-1420`(`{sheetId, recordId, data, actorId}`);`data` 只从批次行投影**闭合白名单**(batch 模板的 plm_system 审计列:运行 id、决策摘要、计数),白名单为模块级冻结常量;`actorId: null` 循 records.ts OD-3(插件道无 actor,**绝不编造 system actor**;下游 `handleEvent` 对 null actor 的容忍在测试中显式验证,不默认);
4. **相1(事务内)**:`enqueueRecordEventIfDurable(asProducerTrx(txQuery), 'multitable.record.' + action, payload)`——与本批全部行写**同事务**,xid probe 天然成立;persist 后半程任何 throw ⇒ 连事件一起回滚(无幽灵通知);
5. **相2(commit 后)**:txn 闭包把已 emit 描述符收集返回,`runStockPreparationPersistUnitOfWork` 在 `transaction(...)` resolve 后对每个描述符跑 `emitRecordEventIfLegacy(this.eventBus, …)`(同一封闭方法内 `index.ts:1743` 已取 `const eventBus = this.eventBus`;automation-service.ts:915-925 已订阅这四族)——flag OFF 走 legacy、flag ON 压制,**REPLACE 契约原样继承**,不发明第三种投递;
6. **plugin 侧消费**:`sync-run-persist.cjs`(:613 调用点内)在批次行 create/patch 完成后调用一次 `emitBatchAnchorEvent`;`repair-once`(:402)同构。**opt-in 显式**:不调用则行为与今天逐字节一致——P1a 负例(裸 createRecord 零事件)**继续为真,测试不改**。

### 4.4 验证方式

- **realdb 三向边界**(扩 P1a 同 harness):
  (a) 裸插件 `createRecord` 依旧零 outbox(P1a :121 不变量存续);
  (b) durable ON + persist 调 `emitBatchAnchorEvent` ⇒ outbox **恰一行**、event_type 正确、payload 只含白名单键;同一 unit-of-work 内注入 emit 后 throw ⇒ outbox 零行(同事务回滚证明);
  (c) durable OFF ⇒ commit 后 legacy bus 收到恰一次(spy),outbox 零行。
- **变异电池**:①删守卫1(任意表可发)→ 红;②删守卫2(可发两次)→ 红;③payload 白名单放开(塞 human 字段值)→ 红;④相2 忘记压制判断(flag ON 双投)→ REPLACE 测试红。
- **对抗审(opus)**:重点打「批锚点行不存在时 emit 什么」「repair-once 与 sync-persist 双调用路径的至多一次语义」「与 durable dispatcher 的 `automation-record-trigger`(consumer-handlers.ts:95)兑付一致性」。

### 4.5 明确不做

新 trigger type、per-line 事件、records.ts 通用 emit、通知模板内容(那是 C1 配置层)、投递 flag 开启(G3b owner)。

---

## 5. 关键路径与里程碑

### 5.1 最小可信完整客户(内部闭环,不写回 K3)

刀序(→ 串行,∥ 并行):

```
G0 → [ W1 ∥ W2 ∥ W4a ∥ G1d ∥ G3a ∥ C1a ] → [ W3 ∥ W4b ∥ G1impl ] → G3b → C1b → 验收
```

- **关键链**(决定 wall-clock):`G0 → G1d(设计门,S)→ G1impl(M)→ G3b(owner 决策)→ C1b(S)` ——G1 是最长代码链;W 系四刀全部躲在它的影子里并行完成。
- **次关键链**:`G0 → W2(M)→ W3(S)+W4b`。
- **累计量级**:W1(S)+W2(M)+W3(S)+W4(M)+C1(S-M)+G1(M-L)+G3a(S) ≈ **15-25 人日**;并行后 wall-clock ≈ **2-3 周**(卡点在 G1 设计门裁决速度与 G3b owner 决策,非代码量)。
- **里程碑兑付**:此路径完成 = design MD §5 的 M2+M3(P5 除外)+M5a + G1 seam,即「拉 BOM→备料网格→部门协作→物料匹配→异常→日期级联→跨批继承→批次通知→生成备料行」全闭环。

### 5.2 完整参考系统对标

```
上式 + [ G2(M,等 D2 #4520 落)∥ C2(M) ] + G4(L,需求门)
```

- **累计再加 ≈ 3-5 周**,且 G4 的需求门与 T3 external-write 设计门都在 owner/客户手里——G4 是唯一 L 级纯代码刀,**独立列车,绝不与 W/C/G1 混编**。
- G2 的排期完全被 D2(#4520)外生决定:D2 不合,G2 只保留 D0-d 设计草稿,零实现投入。

---

## 6. 风险与顺序建议

### 6.1 风险排序(高→低)

1. **G4**(真外部写,ERP 侧不可回滚)——需求门+设计门双闸,最后做,独立对抗审;
2. **G1**(触自动化投递机骨;错误 seam = 双投或事件风暴)——已用「批锚点+至多一次+REPLACE 继承」三重收窄,残余风险在双相契约与 dispatcher 兑付,靠 §4.4 变异电池 + opus 对抗压住;
3. **W2**(改承重 provisioning;错一步 = 砸已装租户表)——DO NOTHING 构造性保证 + 运行时快照对账双保险,风险已从「机制」压到「实现笔误」;
4. **W4**(human 字段写路径;静默覆盖是本线红线)——幂等 reject + 白名单 ⊆ 断言 + 变异;
5. **W1/W3**(小接线,惰性/单列)、**C1/C2/G3a**(配置与验收,可回退)——低。

### 6.2 顺序建议

- **现在(G0 前)就做 Wave 0 四草稿**:W2 rung 设计锁(D0-a)与 G1 seam 设计锁(D0-b)是仅有的两个设计门,草稿备好则 ratify 当天即可裁决进 Wave 1——**省下的正是关键链头部的 3-5 天**。W4 契约与 C1 演练清单(D0-c)、G2 草稿(D0-d)同理。设计文档非 arm,不越「pre-ratify 不 arm」纪律。
- **G0 后第一批**:W1 先落(最小、惰性、给 target-provisioning.cjs 让出基线)→ W2 紧随 rebase;W4a、G3a、C1a 同日并行开;G1d 当日裁决。
- **别做的顺序错误**:①W3 抢跑 W2(ensure 422 炸线);②W3/W4b 双 PR 同时 armed(http-routes.cjs 路由表必冲突,循 armed-claims 线内纪律编列车);③把 G1 做成 records.ts 通用 emit(翻掉 P1a 全局不变量);④替 owner 开 G3b flag 或代拍 G0/G4 门。
- **单点最高杠杆**:**W2**。它是 W3/G2 双刀共享前置、又是全线唯一改核心 provisioning 的刀——W2 的设计锁质量直接决定 Wave 2 能否一次过门。

---

## 7. 门控台账(本计划自身的记账)

| 决策点 | 归属 | 阻塞 |
|---|---|---|
| 🔶 G0 ratify | owner | 一切接线刀 |
| 🔶 W2/G1 设计门裁决 | opus 门(owner 可复核) | W3/G2 // G1impl |
| 🔶 G3a policy 配置 | owner | canonical apply go-live |
| 🔶 G3b 四投递 flag | owner | C1b 真投递、G1 durable 段 |
| 🔶 G2 载体 | D2 #4520 合入 | G2 实现 |
| 🔶 G4 需求门 | owner+具名用例 | ERP 写回 go-live |
