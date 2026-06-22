# Data Factory FOS-0 — 通用 field-option-sync 能力 设计锁定(2026-06-21)

> 状态:**DESIGN-LOCK 草案(待 owner 评审)**。**docs-only**:不授权任何 runtime / UI / migration 改动。
> 上游:issue #3020(把 Data Factory 上 business-specific 的"stock-preparation option sync"泛化为通用 `field-option-sync`,stock-prep 变成一个 preset/模板,而非硬编码主操作)。
> 目的:把 #3020 的方向从"想法"细化为**可评审的通用合同 + 开放裁决项 + gated 分刀计划**,并把**现有 stock-prep option-sync 锚定为"first preset / 兼容锚"**——先有合同,再分刀泛化 runtime/UI。

## 0. 一句话

Data Factory 现在是跨 PLM / ERP / SQL / HTTP / MetaSheet staging 的通用集成面;一个以单一业务流程命名的主按钮("sync stock-preparation options")让它看起来是给单客户定制的。FOS 把它泛化为**通用"字段选项同步"能力**(把某个来源的选项集同步进 MetaSheet 表的单选/多选字段的 options),**stock-prep 退为第一个 preset**;**本刀只锁合同,不动 runtime/UI**。

## 1. 现状(锚:现有 stock-prep option-sync,#2253 C6)

`lib/stock-preparation-option-sync.cjs` 的 `syncStockPreparationOptions(input)`:

- **只写字段元数据**:经 `context.api.multitable.provisioning.patchObjectFieldProperty` patch 目标字段的 `.property.options[]`(+ `optionActionBindings`/`stockPreparation` 元数据);**不写业务行、不读 PLM、不碰 K3、不收浏览器 SQL/JS**。
- **own-sheet**:目标永远是 MetaSheet 自有的 canonical stock-prep 表(`template.objectId`),不经外部系统 adapter。**无外部写**。
- **admin-gated**:`requireAccess('admin')` + `permission==='admin'`;请求字段闭合 allowlist(`tenantId/workspaceId/projectId/optionSets/optionSources/configInfo`);禁可执行键、禁 secret-shaped 值、禁 placeholder。
- **values-free evidence**:`{ ok, target:{objectId,fieldCount}, evidence:{ fields:[{field,optionSource,optionCount,actionBindingCount}], skipped:[...] } }`——只 field id / source key / 计数 / skip 原因,**无选项值/标签/sheetId**。
- **per-option 规范器已通用**:`{ value(必填、安全、非 secret), label?, color?(#RRGGBB), enabled→disabled, order?, actionBindings?(仅 predefined 动作允许) }`。
- **业务特定的只剩三处**:目标对象 id(硬编码 stock-prep 主表)、字段↔sourceKey 映射(烤进模板)、动作 allowlist(仅 PLM stock-prep 动作)。

**今天已实现 vs 未实现**:

| 语义 | 现状 |
|---|---|
| value / label / color / order / enabled(→disabled)/ actionBindings | ✅ 已实现 |
| **syncMode**(append / replace / disable_missing) | ❌ 未实现——恒**全量 replace**(新 options 覆盖旧) |
| **conflictPolicy**(keep_existing / update_from_source / manual_confirm) | ❌ 未实现(option sync 是纯元数据 patch;模板上的 `conflictStrategy` 是 PLM **行**冲突,非选项) |
| **triggerMode**(manual / scheduled / after_source_refresh) | ❌ 仅 manual on-demand route |
| group / category 字段 | ❌ 无 |
| dry-run / preview / estimatedChanges(count-only) | ❌ 无,恒 live apply |

**结论**:现有实现是一个**简单、C6-安全、values-free、元数据-only 的全量 replace**;其规范器/校验已通用,**泛化工作主要是参数化"字段↔sourceKey 映射 + 目标对象" + 加一个可发现的 preset 目录**,而非重写安全逻辑。

## 2. 通用合同:`field-option-sync`(FOS)

一个 FOS 任务让 admin/implementer 配置(合同字段,锚定 §1 真实实现 + #3020):

```text
capability            = field-option-sync
sourceSystem          = PLM | ERP | SQL | HTTP | MetaSheet-staging        # 选项值的来源
sourceObjectOrTable   = config / object / table / view                    # 来源对象
valueField            = 选项 id/code/value（必填）
labelField            = 选项显示名（可选）
groupField            = category/domain（可选；现状未实现 → FOS-2+）
targetTable           = MetaSheet 表
targetField           = single-select | multi-select 字段
syncMode              = replace（现状/默认） | append | disable_missing     # 后两者 = 新 runtime（FOS-2）
conflictPolicy        = update_from_source（现状/默认） | keep_existing | manual_confirm   # FOS-2
triggerMode           = manual（现状/默认） | scheduled | after_source_refresh             # FOS-2/调度刀
perOption             = { value, label?, color?(#RRGGBB), enabled, order?, actionBindings?(allowlist) }   # 现状已通用
evidence              = values-free（field id / source key / 计数 / skip 原因;无值/标签/sheetId）
```

**安全不变式(从 §1 继承,FOS 任意 preset 必守)**:元数据-only(只 patch 字段 options/元数据)、own-sheet(不经外部 adapter)、admin-gated、请求闭合 allowlist、禁可执行键/secret-shaped/placeholder、values-free evidence、凭据只经后端 context(**绝不从 request**)。**任何只 patch 字段元数据的 FOS preset 天然 C6-安全**。

## 3. stock-prep = first preset / 兼容锚

stock-prep option-sync 映进通用合同(不动其行为):

```text
preset                = stock-preparation option sync（第一个 preset）
sourceSystem          = operator config（configInfo / optionSets）+ 内置 contract 默认集
targetTable/Field     = canonical stock-prep 主表 / materialType·blankType·prepStatus 等单选字段
syncMode              = replace（现状)
conflictPolicy        = update_from_source（现状：全量覆盖)
triggerMode           = manual（现状)
perOption + actions   = 现有规范器 + PLM stock-prep 动作 allowlist
```

**兼容锚原则**:FOS-1/FOS-2 泛化时,**现有 `syncStockPreparationOptions` 行为与 route 必须零漂移**(既有 `stock-preparation-option-sync.test.cjs` 原样绿 = 硬验收);stock-prep 经"通用 FOS 内核 + stock-prep preset 参数"复现,而非另起。这与 S1b(SQL 路径零漂移)同纪律。

## 4. preset 模型(复用 S3-3 reference-catalog 形态,与 S3 pipeline 解耦)

FOS 是**正交于 S3 pipeline** 的能力(S3 = source→target **行**映射 pipeline;FOS = 表存在后往**字段**灌选项元数据)。但**发现/选取流**可复用 S3-3 的 values-free 目录形态:

- **FOS preset 目录** = 冻结、values-free 常量(同 `reference-integration-templates.cjs`:`assert...ValuesFree` + 深拷贝 + 只读 GET 发现),每条 = `{ fosRefId, name, description, targetKind/targetObjectRef, fosConfig:{ optionFields:[{fieldId,sourceKey,type}], defaultOptionSets?, allowedActionIds?, syncMode } }`,**无凭据/sheetId/行值**。
- **opt-in**:operator GET 目录 → 选一个 preset → 经(FOS-2 的)通用 sync route 运行;**不默认 auto-seed/auto-run**。stock-prep = 目录里第一个。
- **不复用 S3 `integration_templates` 表**作存储(那是 pipeline 定义);FOS preset 先用 reference-catalog 常量形态(轻、无 migration);若后续需持久化自定义 preset,再单独裁决(开放裁决项 §5)。

## 5. 开放裁决项(owner 先签,FOS-1 才能机械执行)

1. **preset 存储**:reference-catalog 常量(轻、无 migration、opt-in)= 推荐起点;持久化自定义 preset(新表 / 扩 `integration_templates`)= 后续单独裁决。**裁决:起点用常量目录?**
2. **syncMode 默认 + 新模式语义**:默认 `replace`(现状,兼容)。`append`(只加不删)/ `disable_missing`(源中没有的 option 置 disabled 而非删)= 新 runtime(FOS-2);**`disable_missing` 永不物理删 option**(保留历史/人工加项)。**裁决:默认 replace + 新模式仅 FOS-2?**
3. **conflictPolicy(针对选项,非行)**:re-sync 是否保留**人工新增**的 option?`update_from_source`(现状全量覆盖)/ `keep_existing`(保留人工项)/ `manual_confirm`。**裁决:默认 update_from_source;keep_existing/manual = FOS-2?**
4. **triggerMode**:manual(现状)。scheduled / after_source_refresh = 调度刀(FOS-2+,各带自己的 gate)。**裁决:FOS-0/1 仅 manual?**
5. **route 命名**:新增通用 `POST /api/integration/field-options/sync`(+ 保留旧 `…/stock-preparation/options/sync` 为兼容别名/转通用内核),还是就地泛化旧 route?**裁决:新增通用 route + 旧 route 兼容转发?**

## 6. Gated 分刀(每刀独立 opt-in + 独立 PR + 审阅;**本刀仅 FOS-0**)

> 前置:本设计锁经 owner 签字(§5 裁决项)。每刀后续单独开。

- 🔒 **FOS-0(本刀,docs-only)**:本设计锁——通用合同 + stock-prep 锚 + preset 目录形态 + 裁决项 + 分刀计划。**无 runtime/UI/migration**。
- 🔒 **FOS-1(contract,lock-safe)**:把通用 FOS 合同抽成 `field-option-sync-contract.cjs`(normalizer + values-free 校验,enum-strict:sourceSystem/syncMode/conflictPolicy/triggerMode)+ FOS preset 目录常量(stock-prep 为第一条),**不接 runtime**;现有 stock-prep 行为零漂移。
- 🔒 **FOS-2(runtime 泛化)**:现有 `syncStockPreparationOptions` 重构为"通用 FOS 内核(参数化 targetObject + 字段↔sourceKey 映射 + action allowlist)+ stock-prep preset",新增通用 route;**SQL/own-sheet 路径零漂移**(既有测试原样绿);新 syncMode/conflictPolicy 各自带测试。
- 🔒 **FOS-3(UI)**:主按钮改 `Sync options / Refresh field options`,business 措辞移入 preset 名;preset picker + 运行前 values-free 摘要(source/target/mode/estimatedChanges count-only)。
- 🔒 **FOS-调度**(可选,demand-gated):scheduled / after_source_refresh trigger。

## 7. 红线 / 边界(本刀 + 继承)

```text
docsOnly=true        noRuntimeChange=true   noUiChange=true   noMigration=true
metadataOnly=true    ownSheetOnly=true      noExternalWrite=true
adminGated=true      credentialsFromRequest=false   valuesFreeEvidence=true
noRawSql=true        noK3Save/Submit/Audit/BomWrite=true
productionWrite=false   batchWrite=false
```

- FOS 任意 preset 只 patch **字段元数据**(options/绑定),**不写业务行、不经外部系统**;实际外部/sandbox 写(若未来某 preset 需要)走 C6 + profile,**另刀另门**。
- 首笔真实生产外部写 = 独立 owner 授权,与 FOS 无关。

## 8. 验收(#3020 + 本锁)

```text
fieldOptionSyncCapabilityExists=true                 # 合同 §2
stockPreparationOptionSyncRepresentedAsPreset=true   # §3 + §4 目录第一条
dataFactoryDoesNotExposeOnlyBusinessSpecificOptionSync=true   # FOS-3 UI(后续刀)
usersCanConfigureSourceObjectAndTargetField=true     # 合同 §2(runtime=FOS-2)
usersCanChooseAppendReplaceDisableMissing=true       # syncMode(runtime=FOS-2)
usersCanChooseConflictPolicy=true                    # conflictPolicy(runtime=FOS-2)
manualRunDoesNotRequireCodeChange=true               # preset 目录 + 通用 route(FOS-2)
valuesFreeEvidence=true                              # 继承现状
stockPrepZeroDrift=true                              # 兼容锚:既有 test 原样绿(FOS-2 硬验收)
```

> 本刀(FOS-0)只交付**合同 + 计划**;`usersCan…` / UI 验收项落在 FOS-2/FOS-3,各自 gated。
