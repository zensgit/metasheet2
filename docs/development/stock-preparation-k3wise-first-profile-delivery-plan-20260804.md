# 备料 + K3 WISE 首套 Profile 交付计划(唯一权威)

> **本文自今日起是本线唯一真源**:状态、验收证据、阶段闸门只在这里维护。取代本轮四份分段勘察
> scratchpad(P1-profile-catalog / P2-read-clean / P3-save-only / P4-package-acceptance)。
> 四份勘察稿中被复核**杀掉**的结论已从本文剔除,不得从 scratchpad 重新引入。
>
> **基线**:勘察基线 `origin/main = 7da5d9e55b0f7c9b0a6ca471d38c3aa0115037ab`;复核时 main 已前进到
> `2a2a5eee4f00abceff94ed6360e8c051708e35f7`。二者在六个被勘察根目录
> (`plugins/plugin-integration-core`、`apps/web`、`scripts/ops`、`.github/workflows`、
> `packages/core-backend/migrations`、`docs/operations`)上 `git diff --stat` **为空**;全部增量为 3 个
> 考勤 `.md`。因此本文所有 file:line 在 `2a2a5eee4f` 上逐字成立。
> **本文中的任何 SHA 都未被授权为 M1 出包输入**;`expected_sha` 必须在派发时重新解析并重新核验。
>
> **main 必需检查 = 9 项**(live API 读取):`contracts (strict)`、`contracts (dashboard)`、`pr-validate`、
> `test (20.x)`、`contracts (openapi)`、`web-tests`、`stock-prep PowerShell 5.1 acceptance`、
> `attendance-web-guard`、`integration-guard`。**`integration-guard` 是必需检查** —— 记忆中"不在必需列表"
> 的旧笔记已作废。

---

## 1. 目标与边界

本轮交付 `stock_preparation.v1` + 数据库读 + K3 WISE API 读/清洗/**仅 Save**:单客户、手动触发、K3 物料
Material **Save-only**、单次 1–3 行,链路为 **数据库/K3 读 → 备料清洗 → dry-run → 人工审批 → K3 Material
Save(≤3 行)→ GetDetail 读回核验**。B4 本轮**产出**(而非等待外部提供)一份经审批的 K3 WISE 读源绑定,
带固定 profileId、configVersion、数据子集与行上限。M1 出包从**当前合格 main** 构建,**不复用旧的 RC-A
冻结包**,并分别记录 serviceRuntimeSha、profileVersion、mappingVersion、manifest SHA-256、client helper SHA。

**本轮 OFF(不实现、不接线、不出现在验收面)**:Submit / Audit;BOM 写入;定时任务;批量自动写;MES;
PLM/ERP/CRM/SRM 泛化。

**明确不再是阻塞项**:MES;完整规模腿(#4739 已合,见 §2);RC-A 三选一重新出包的老议题。#4695 保持
CLOSED、不重开;实体机执行经"取代指令"移交 #4628(权威归属见 §3.4 与 §5)。

---

## 2. 当前状态(P0)

owner 的 P0 = "同步/评审/合并 #4744;标记 #4736 superseded"。机械核验后的实况:

| 项 | 实况 | 证据 |
|---|---|---|
| #4739 规模腿 | **MERGED** | `431d25699` `test(stock-prep): S6-A scale leg — verified to the declared 24999 bound, both sides, with a measured slope (R9) (#4739)`;两侧验到声明的 24999 上界,实测斜率 3.457 ms/行,全量 POST 86.8s |
| #4744 | **同步已完成、业务补丁已证逐字节相同、pin 一致、CI 已跑;但 merge 未落** | `gh pr view 4744` → `state=OPEN, mergeCommit=null`;`git log origin/main --grep='(#4744)'` **空** @ `2a2a5eee4f` |
| #4736 | 标题已带 `[SUPERSEDED]` 前缀,**issue/PR 状态仍为 OPEN** | `gh pr view 4736` → `state=OPEN`,title `[SUPERSEDED] test(stock-prep): R5 prep-line route coverage …` |
| #4723 duplicate-key 策略 422 | 已落 main | `4784d8fb8a5b90f4b239031d6d5211543aa60592` |
| #4741 operator preflight | 已落 main | `d76f6993a6268330d109fa4295bfad025f1d7a99`;§3.4 指出它**未进包** |
| 迁移 074 / 075 | 已落 main | `packages/core-backend/migrations/074_repair_sealed_export_runtime_authority_privileges.sql`、`075_grant_sealed_export_runtime_authority_row_lock.sql`;§3.4 指出它们**零 provenance 覆盖** |
| 其余本轮落地 | Date 投影生产修复;S6-A walk;R6 自执行负控;R8 接线两套从未跑过的生产门套件;PG15/16/17 校验;074/075 的 PG16+17 矩阵;三处 runbook 修订(含 #4743) | — |

**结论**:P0 的"同步/评审"完成,**"合并"未完成**。任何堆在 #4744 之上的工作都堆在未合并基线上(风险见
§3.2/§3.3)。这不是重议 owner 的框架,是"被触发≠被验证"的硬规则:状态表不得记录一次没有发生的合并。

**已知遗留产品缺陷(仍然成立)**:原始错误在任何地方都没有被记录(run `30894855040`)。
**已知 harness 缺陷**:规模腿的 tenant 必须由既有链路预热。

---

## 3. 阶段

### 3.1 P1 —— 唯一的服务端 K3 API Profile Catalog

#### 已有

- **事实上的服务端目录** `K3_WISE_DOCUMENT_TEMPLATES`(`k3wise.material.v1` / `k3wise.bom.v1`)与
  `K3_WISE_MATERIAL_PROFILES` —— `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs:91-167`
  (模板)、`:177-234`(`MATERIAL_CUSTOMER_PROFILE_ID` + 客户 profile)、`:345-357`(导出)。端点字面量
  `:99` Material/Save、`:100` GetDetail、`:102` Submit、`:103` Audit、`:143/:144/:145` BOM 三件。
  **接线:WIRED + GATED**。运行时唯一 require 边:`k3-wise-webapi-adapter.cjs:27`;适配器注册
  `index.cjs:32`;`__tests__/k3-wise-adapters.test.cjs` **在** `plugins/plugin-integration-core/package.json:9`
  的显式 `&&` 链内,由 `.github/workflows/integration-guard.yml:477-480` 执行(必需检查)。
- **前端自带的第二份 K3 声明** —— `apps/web/src/services/integration/k3WiseSetup.ts:327-460`(模板副本)、
  `:964-981`(8 个端点默认值,含 materialSubmitPath `:976` / materialAuditPath `:977`)、
  `:1935-1990` `buildK3WiseSetupPayloads`、`:2239-2242` POST `/api/integration/external-systems`。
  **接线:运行时 WIRED,但零必需检查覆盖**。`apps/web/tests/k3WiseSetup.spec.ts` 既不在
  `scripts/ops/integration-guard-run-web-specs.sh:14`,也被 `apps/web/scripts/run-required-web-tests.sh:12-15`
  明确列入 19 个隔离红档;源文件不在 `scripts/ops/integration-guard-guarded-paths.mjs:30-143`(95 条,只有
  View `:66` 与其 spec `:100`)。`web-tests` 跑的是策展清单(`web-tests.yml:38` job,`:77` 调该脚本),不是全量
  vitest —— 该通道救不了这个文件。
- **导入图证明两份清单各自维护(接线:N/A —— 结构性发现)** —— `k3WiseSetup.ts:1-2` 的完整 import 只有 `apiFetch` 与
  `isIntegrationScopedProjectId`,与服务端插件零边。14 个非测试文件带 `/K3API/` 端点字面量,其间只有
  **两条** require 边:`k3-wise-webapi-adapter.cjs:27 → k3-wise-document-templates.cjs`,
  `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs:33 → adapter`。
- **第三份声明** `K3_WISE_MATERIAL_ACTIONS`(冻结数组起 `connector-action-contracts.cjs:244`,字面量
  `:252`/`:265`)。**接线:LATENT 未接线** —— 头部 `:3` 自述 latent,全树唯一 requirer 是它自己的测试
  `__tests__/connector-action-contracts.test.cjs:17`。它的套件**在**门控链内 ⇒ 这是**死路径的覆盖**,不是
  运行时覆盖。
- **第四份声明** read-smoke 预设 `lib/read-smoke.cjs:29`(Material/GetDetail)、`:50`(Material/GetList)、
  `:89`(BOM/GetDetail)。**接线:运行时 WIRED**(`http-routes.cjs:169`、`read-source-probe-contract.cjs:10`、
  `read-source-probe-runtime.cjs:22`、`read-source-read-runtime.cjs:42`),但其**同名套件
  `read-smoke.test.cjs` / `read-smoke-contract.test.cjs` 不在 `package.json:9` 链内、不在任何 workflow 内**
  —— 只被链内其他套件顺带触达,不能记为该目录点的覆盖。
- **FE 读源配置面(另一套、与上面不相交)** —— `apps/web/src/services/integration/readSourceConfigs.ts:241`
  `readPath: ''`、`:265` `isCoarseSafeRelativeReadPath`(只查语法)、`:286-288` 唯一的 readPath 校验;目录值仅以
  HTML placeholder 出现(`IntegrationReadSourceConfigPanel.vue:94`、`IntegrationReadSourceWizard.vue:69`)。
  **接线:WIRED + GATED**(guarded-paths `:32`、`:37-38`;spec 在 web-specs `:14`)。**服务端同样只查语法**:
  `lib/read-source-config.cjs:186` `isSafeRelativeReadPath` → `READ_SOURCE_ENDPOINT_NOT_RELATIVE`;
  `ALLOWED_CONFIG_KEYS:66-77` 白名单的是**键名**不是端点值 ⇒ 两个平面都**没有端点词表**,拼错的端点通过校验。
- **第二份前端目录**(P1 爆炸半径内,勘察一度遗漏)—— `apps/web/src/services/integration/readSourceTemplateCatalog.ts:148-212`
  `INTEGRATION_TEMPLATE_CATALOG`,含 `k3-wise-webapi-single-record`(`:149-154`)与
  `k3-wise-sqlserver-list-page`(`:155-160`),由真实 `readSourceModePresets` 派生。**接线:WIRED + GATED**
  (在 web-specs `:14`)。另有服务端模板面 `lib/http-routes.cjs:126-134`(`GET /api/integration/templates/references`,
  `listReferenceIntegrationTemplates` `:219`)。
- **离线 fixture mock 自带路由表** `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs:99-158`
  (8 条:Login/Health/Material 三件/BOM 三件,**无 GetDetail / GetList**)。**接线:WIRED 但未门控** ——
  `verify:integration-k3wise:poc`(根 `package.json:104`)只在 `plugin-tests.yml:55-56` job `k3wise-offline-poc`
  (检查名 `K3 WISE offline PoC`)里跑,不在 9 项必需检查内。
- **可复用形状 #1(注册表)** `lib/gip-connector-kind-registry.cjs:3-35` —— first-party 闭集、条目只能在构造时以
  固定数组传入、返回冻结、无任何名字的 add/register 动词、未知 kind fail-closed。**接线:未接线**(以 require
  图机械确认:`index.cjs` 与 `lib/http-routes.cjs` 对 `gip-` 的 grep 均为 0 命中;其头部注释关于"无调用者"的
  自述与代码不符,不可采信注释),但**其一致性测试是机械的且已门控**:
  `__tests__/gip-connector-kind-registry.test.cjs:59-63` 以 `assert.deepEqual(Object.keys(...).sort(), ['resolve','size'])`
  钉死键集,`:502` 同法钉 `__internals` ⇒ 以任何名字加回 mutator 都会红。
- **可复用形状 #2(合同注册表)** `lib/gip-canonical-object-contract-registry.cjs` —— 构造期唯一、
  contractId+version 只增、未注册 fail-closed(`:125`/`:557`),冻结单例只暴露 `lookup()/size()`(`:31`、`:533-535`),
  出厂为**空集**(`:570`)。**接线:未接线**(同上 require 图)。
- **可复用形状 #3(FE/BE 漂移的承重件)** `apps/web/tests/composition-vocab-mirror.spec.ts:17-21`
  以 `createRequire` 直接 require 服务端冻结导出("The server exports the frozen array directly — require,
  never text-parse"),`:26-32` 断集合相等 + 计数钉死(同尺寸替换也会红)。
  **接线:WIRED + GATED**(guarded-paths `:68`,且是 web-specs `:14` 的第一个 token)⇒ 这是仓内已在必需检查里
  跑的、现成绿的机制。
- **默认写姿态(已核;接线:WIRED + GATED —— 在 `package.json:9` 链内经 e2e 与适配器套件覆盖)**
  `k3-wise-webapi-adapter.cjs:346-351` `resolveAutoFlag` 返回 `configExplicit === true`
  ⇒ autoSubmit/autoAudit **未设即 false**;FE 默认亦 false(`k3WiseSetup.ts:973-974`),live-PoC 校验拒绝 true
  (`:1088-1089`)。**丢掉 profile 只是解除硬锁并让 Submit/Audit 端点回到可设,并不自动开启自动提交** ——
  按此措辞记录,不要写得比代码更吓人。

#### 缺口(人天 / 模型)

按 owner 的 P1 定义(catalog + fail-closed 钉死 + FE mirror)裁剪;勘察稿里的 profile 可选面、
catalog 化 readPath、fixture GetDetail 三项**已重贴到 P2/P3**,不在 P1 计。

| # | 缺口 | 人天 | 模型 |
|---|---|---|---|
| P1-0 | 把 5 个孤儿套件手工追加进 `plugins/plugin-integration-core/package.json:9` 的 `&&` 链:`k3-save-body-composer.parity.test.cjs`、`k3-wise-material-presets.test.cjs`、`k3-df-t1-target-payload-preview.test.cjs`、`read-smoke.test.cjs`、`read-smoke-contract.test.cjs`(机械对账:磁盘 161 个测试文件 vs 链内 149 个)。**排第一**:唯一断言客户 profile 省略 FBaseUnitID 的套件(`k3-save-body-composer.parity.test.cjs:185-191`,自带负控注释 `:184`)今天在任何通道都不跑 —— P3 依赖的形状零强制保护。 | 0.25 | opus |
| P1-1 | 建**一个**服务端 catalog 模块 `createK3ApiCatalog(entries)`:构造期固定数组、返回冻结、只读查询、任何名字的 add/register 一律不存在;每对象拥有端点集(save/read/readMethod/submit/audit)、bodyKey/keyField/keyParam、字段 schema(含客户 profile)、`lifecycle` 标记;未注册 ⇒ `K3_ENDPOINT_UNREGISTERED` / `K3_OBJECT_CONTRACT_UNREGISTERED`。**导出两件**:(i) 冻结的**条目数组** `K3_API_CATALOG_ENTRIES`(P1-3 mirror 与 P1-2 内容 pin 的靶子 —— 没有它,mirror 只能去 text-parse,正是 `composition-vocab-mirror.spec.ts:19` 明令禁止的),(ii) 冻结的只读注册表(P1-2 键集 pin 的靶子)。**本轮只收敛运行时平面**:`k3-wise-document-templates.cjs` + `read-smoke.cjs` 端点字面量;`connector-action-contracts.cjs` 保持 latent 不动;ops/CI 平面(`integration-composition-postdeploy-smoke.mjs:40,:44`、`integration-issue1542-seed-workbench-systems.mjs:389,:390`、`integration-k3wise-live-poc-preflight.mjs:529`、`integration-read-selfservice-postdeploy-smoke.mjs:61`、适配器默认值 `:1430-1431`)**下一片再收**,以免破坏 P4 依赖的 smoke 证据。 | 0.75 | sonnet |
| P1-2 | catalog 的 fail-closed 钉死套件:键集精确断言 + 未注册路径的**正控**(注册项能查到、未注册项确实抛哨兵而不是静默默认);追加进 `package.json:9`。 | 0.5 | opus |
| P1-3 | FE mirror 绊线 + 通道接线:FE spec `createRequire` 服务端冻结导出,断端点集合、profile 字段集合、计数三项相等;并 (b) 把 `k3WiseSetup` token 加入 `scripts/ops/integration-guard-run-web-specs.sh:14`(**承重**:插件侧改动已能触发该 web-spec 步),(a) 把 `k3WiseSetup.ts` 与其 spec 加入 `GUARDED_PATH_ENTRIES`(只补 FE-only 改动),(c) 解隔离 `k3WiseSetup.spec.ts` —— **成本已实测**:62 passed / 1 failed,唯一红档是 `spec:512-524` 两条**源码文本**断言(断 `src/main.ts` 含 `to.meta?.permissions` / `auth.hasPermission(permission)`),而 `main.ts:125` 记录该决策已迁入纯策略模块、`appRoutes.ts:277-280` 仍带 `permissions: ['integration:write']` ⇒ 行为完好,改两条字符串断言即可。 | 0.5 | opus |

**P1 合计 2.0 人天**(owner 预算 1–2,取上界)。

#### 验收判据(机械)

1. 键集 pin 打在**只读注册表对象**上:`Object.keys(<冻结注册表>).sort()` 与精确键集 `deepEqual`
   (先例:`gip-connector-kind-registry.test.cjs:59-63` 钉 `['resolve','size']`,`:502` 钉 `__internals`)。
   内容 pin 打在**冻结条目数组** `K3_API_CATALOG_ENTRIES` 上(集合 + 计数)。
   **变异探针**:以任意名字(`add`/`register`/`set`/`upsert`/`define`)在注册表上挂一个 mutator ⇒ 该套件必须变红。
2. 未注册端点/对象:`assert.throws(..., /K3_ENDPOINT_UNREGISTERED/)`;**正控**:已注册项返回非空对象且
   `lifecycle === 'save-only'`。删掉抛出语句 ⇒ 必须变红(逐项 neuter,不允许两道门互相掩护)。
3. FE mirror:服务端数组删掉 1 个端点 ⇒ FE spec 红;把 1 个端点换成同名不同值 ⇒ 红;总数不变但成员互换 ⇒ 计数钉
   与集合钉分别必须各自可单独触发。
4. FBaseUnitID 负控:把 `FBaseUnitID` 加回客户 profile schema ⇒ `k3-save-body-composer.parity.test.cjs` 红
   (该文件 `:184` 已写明这一负控)。
5. **通道证据(所有阶段通用)**:引用 `integration-guard` 的 **run id** 并附**执行日志中出现新套件文件名的那一行**。
   `integration-guard.yml:479` 步骤带 `if: steps.changes.outputs.relevant == 'true'`(PR 侧范围由
   `scripts/ops/integration-guard-classify.mjs` 决定)⇒ 存在"绿但一个 K3 测试都没跑"的合法状态,只贴 check 绿无效。

#### 风险

- 服务端默认模板(`k3-wise-document-templates.cjs:107-125`,17 字段)与 FE 副本(`k3WiseSetup.ts:337-353`,17 字段)
  **当前集合相等**,零单侧成员。漂移是**结构上可能且完全无断言**,不是"已经不一致" —— 不得写成已在打架。
- 真正**当下不一致**的是客户 profile vs FE:profile-only 15 个(FDefaultLoc、FDSManagerID、FErpClsID、
  FInspectionLevel、FOrderTrategy、FOtherChkMde、FPlanPrice、FPlanTrategy、FProChkMde、FSOChkMde、FStkChkMde、
  FUnitID、FUseState、FWthDrwChkMde、FWWChkMde),FE-only 5 个(FBaseUnitID、FBatChangeEconomy、FCheckCycle、
  FKanBanCapability、FStdBatchQty)。**FBaseUnitID 是关键**:`k3-wise-document-templates.cjs:201-204` 记录默认投影它
  "导致 M1 dry-run 交叉核对不一致并促成 Save 失败",移除后单条 Save 才通过;FE 至今仍投影它
  (含 gate 映射 `k3WiseSetup.ts:1431` `uom → FBaseUnitID`)。这是 P3 的直接隐患。
- Save-only 绕过是**潜伏**而非现网回归:全仓扫描确认无任何产品代码写 `objects.material.profile`(只有测试、
  一段 runbook JSON 片段 `docs/operations/integration-k3wise-df-t1-preview-evidence-runbook-20260527.md:150`、
  出包 provenance 标记 `multitable-onprem-package-build.sh:495` / `-verify.sh:334`)。它**只在 P2/P3 让 profile 变得
  可选时才会触发** —— 因此 lifecycle 归属必须在发布 profile 选择面**之前**修好,否则 P3 会发一个能悄悄解锁
  Submit/Audit 的 UI(FE 整份 config 覆写:`k3WiseSetup.ts:1935-1990`,服务端 `external-systems.cjs:268`
  `if (input.config === undefined) updateRow.config = existing.config` ⇒ 传了就整体替换)。
- `package.json:9` 是一条约 150 个套件的显式 `&&` 链,且 `pnpm --filter plugin-integration-core test` 在全仓只出现
  在 `integration-guard.yml:480` **一处**。新 `.cjs` 不手工追加 ⇒ 任何通道都不跑,文件存在什么都不证明。

---

### 3.2 P2 —— DB/K3 读 → 清洗 → diff 预览

#### 已有

- **`material.v1` / `bom.v1` 不是 canonical 读形状(接线:N/A —— 命名纠正)** —— 同名物是**写侧** K3 Save-body 模板 `k3wise.material.v1` /
  `k3wise.bom.v1`(BE `k3-wise-document-templates.cjs:93,:137`;FE `k3WiseSetup.ts:329,:406`;第三种拼法
  `apps/web/tests/IntegrationWorkbenchView.spec.ts:3129`)。任何写成"把读映射进 material.v1"的计划都是在把读
  映射进一个 Save-body 形状。
- **canonical 对象词表出厂为空且 fail-closed** —— `lib/gip-canonical-object-contract-registry.cjs:570` 空数组构造、
  `:533-535` 只暴露 `lookup()/size()`、`:125`/`:557` `CANONICAL_OBJECT_CONTRACT_UNREGISTERED`。**接线:LATENT**
  (`index.cjs` / `http-routes.cjs` 对 `gip-` 零 require 命中;其唯一消费者 `gip-approved-binding-resolver.cjs` 自身
  也 latent)。读源侧 `object` 只按有界标识符校验:`lib/read-source-config.cjs:180`
  `READ_SOURCE_OBJECT_INVALID`,谓词 `:84-86`,键在 `ALLOWED_CONFIG_KEYS:67`。
- **仓内唯一 canonical-object-version 字面量**是 `stock-preparation-bom.v1`
  (`lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs:17`),**无物料对应物**。
  `stock_preparation.v1` 仅出现在设计文档 `gip-d0-…-20260723.md:233` —— **无仓内代码引用**。
  **接线:S6-A 默认 OFF** —— 路由仅当 `services.stockPreparationSqlServerRuntime` 存在才追加
  (`http-routes.cjs:5003-5006`),服务仅当 `loadStockPreparationRuntimeConfig().enabled` 才构建(`index.cjs:293-304`)。
- **读源配置面**:4 模式冻结 `read-source-config.cjs:26`、`:47-52` 模式必填、`:58` 写形状键拒绝、`:60-63` 内联凭据
  拒绝、`:66-77` 闭合键白名单、`:98-118` SSRF 相对路径守卫。**接线:WIRED + GATED**(store `index.cjs:241,:346`;
  路由 `http-routes.cjs:21-27`;模块测试 + 路由测试均在链内)。
- **读运行时** `lib/read-source-read-runtime.cjs:45`(行上限 1000)、`:46`(页上限 10)、`:62-63`(raw / adapter_records
  双行平面)、`:210-234`、`:255-265`;路由 `http-routes.cjs:27` → handler `:2842`。**WIRED + GATED**。
- **K3 物料 list 读端到端已通** —— `read-source-probe-runtime.cjs:149-152` 设 `readMode='list'` + `maxListLimit`,
  `:173-179` 设 `k3ReadMode:'list'` + 内部 Symbol 标记 + 有界 `listPageIndex`;适配器闸门
  `k3-wise-webapi-adapter.cjs:628-633`(无 Symbol ⇒ `K3_WISE_READ_LIST_ROUTE_UNSUPPORTED`)、`:634-639`
  (对象 readMode 非 list ⇒ `K3_WISE_READ_LIST_NOT_CONFIGURED`);边界 `:53`(10 行/页)、`:56`(页 1..10);
  调用点 `:1693-1694`。**WIRED + GATED**(`__tests__/read-source-read-runtime.test.cjs:235-322`)。
- **组合面(两跳)** `read-source-composition-config.cjs:10-11` `MAX_STEPS === MIN_STEPS === 2`,
  runtime `:18` "NO recursion";store `index.cjs:246`;路由 `http-routes.cjs:28-34`。**WIRED + GATED**。
- **BL1 by-material BOM 清单合同** `lib/read-source-bom-list-by-material-contract.cjs:33-67`,
  `runtimeValidated: true` `:66`,BL3 真机来源 `:29-32`(release `multitable-onprem-bom-list-bl3-20260706-1e18f85d5`)。
  **接线:WIRED + GATED** —— 经同一条已审批读源路由可达,合同与运行时两套套件均在 `package.json:9` 链内。
- **读 → 备料入库** `lib/stock-preparation-readonly-source-run.cjs:14`(取 adapter_records 平面)、`:23-24`
  (K3 WebAPI 10 行/页 × 10 页)、`:41-42`(pagination:none 必须 fail-closed)、`:54-75`、`:82-87`(ERP 源种类四项)。
  路由 `http-routes.cjs:81`(plm-bom)、`:82`(erp-materials)。**WIRED + GATED,含路由级测试**
  (`__tests__/http-routes.test.cjs:7284-7564`,覆盖匿名、无权限、缺 configId、steering 拒绝、项目作用域)。
- **ERP 物料落库** `lib/stock-preparation-erp-material-sync-persist.cjs:41-46`(**upsert 缓存**,无版本快照、
  无批次、无 diff)、`:47` 专属 run type;路由 `http-routes.cjs:86`。
  **接线:WIRED + GATED,含路由级测试** `http-routes.test.cjs:4171`。
- **清洗 —— 重复展开键冲突面**:6 策略冻结词表 `stock-preparation-conflict-planner.cjs:51-58`,已实现集
  **由行为派生**`:434-449`;`CONFLICT_POLICY_NOT_IMPLEMENTED` `conflict-policies.cjs:32` → 422 `:130`;
  路由 `http-routes.cjs:63-65`。**接线:WIRED + GATED,含路由级测试** `http-routes.test.cjs:5121-5311`
  (7 处 invoke)。#4723 已落 `4784d8fb8`。
- **清洗 —— 物料映射 / 单位换算**:`stock-preparation-material-match.cjs:12-43`、
  `stock-preparation-unit-rule-match.cjs:12-34`、confirm 面 `stock-preparation-confirm-writes.cjs:321-360`;
  路由 `http-routes.cjs:99-110`。**接线:WIRED + GATED,含路由级测试** `http-routes.test.cjs:8542-8639`
  (单位换算 confirm/retire 在 `:8545-8546`)。FE 两个 confirm 视图在必需
  `web-tests`(`run-required-web-tests.sh:140`)与 integration-guard spec 清单内;FE 路由为单条 `/stock-prep`
  → `StockPreparationWorkspace.vue`(`appRoutes.ts:282-291`)。
- **diff 预览面(BOM 形状)** `lib/stock-preparation-snapshot-diff.cjs:5-11`(5 类)/`:13-26`(12 变更类型)/`:28-31`;
  values-free 读端点路由 `http-routes.cjs:92`、`:93`、`:96`,handler `:4179-4198`(含 501 分支 `:4186`)。
  **接线:运行时 WIRED;模块级 GATED,路由级零覆盖**(`snapshot-batches` / `diff/rows` 在
  `http-routes.test.cjs` 均 0 命中)。
- **同步计划/落库** `lib/stock-preparation-sync-run-plan.cjs:5`(输入是已产出的 PLM BOM 展开)、`:18`
  (**头部明确排除 K3/ERP/SQL 与任何实时 I/O**)、`:43` `RUN_TYPE_PLM_SYNC='plm_sync'`;路由 `http-routes.cjs:75`
  / `:78`。**接线:运行时 WIRED;模块级 GATED,路由级零覆盖**;这两条路由**被**
  `scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs`
  与 `stock-preparation-prep-line-extended-smoke.mjs` 触达,但其 workflow 为 dispatch-only 或窄 paths ⇒
  **"被跑到,但没被门控"**。
- **已存在的物料对账冻结合同(重要,勘察一度遗漏)** `lib/material-reconciliation-templates.cjs` ——
  9 模板双源物料主数据对账,manifest `material.reconciliation.v1` `:19`;配套 `material-reconciliation-row-digest.cjs`。
  **接线:LATENT by construction**(`:6-13` 自述不建表、不读数、不写行、不暴露路由)且默认 OFF
  (`MULTITABLE_MATERIAL_RECONCILIATION_ENABLED` `:22-23`);**其测试在门控链内**。
- **生产 apply 策略已接线(纠正)** —— `lib/stock-preparation-production-policy.cjs` 头部注释说"未接线"是**过期注释**;
  `lib/stock-preparation-table-actions.cjs:38-40` require、`:857-858` 自述为两个写入口的**唯一 apply 闸门**、
  `:867-868`、`:871-879`、`:880` 返回 `production`、`:889-892` plan 后 `maxCleanRows` 上界;调用点 `:900` 与
  `http-routes.cjs:3682-3684`(import `:241,:248`,另见 `:3526`)。**默认姿态**:仅从服务端配置键
  `stockPrepApplyProduction` 读取(`table-actions.cjs:846-855`,注释明确拒绝任何 env 开关),缺省 ⇒ 落到
  `assertStockPrepApplySandboxAllowed` `:883` ⇒ **默认休眠但已接线**。**注意:它治理的是内部多维表 canonical
  apply,不是 K3 Material Save**,P3 不得把外部写指向这道门。

#### 缺口(人天 / 模型)

| # | 缺口 | 人天 | 模型 |
|---|---|---|---|
| P2-D | **owner 裁决,不计人天**:(a) canonical 命名分叉 —— 要么按已批的 γ 裁决在 `CANONICAL_OBJECT_CONTRACT_REGISTRY` 注册真实 first-party 合同,要么明确宣布"归一化 intake 形状即合同"并**停止使用 `material.v1` 这个名字**;(b) 物料对账既有冻结合同 `material.reconciliation.v1` 与"新建物料 diff 平面"的关系 —— 复用 / 并存 / 择一。 | — | — |
| P2-1 | **产出 B4 绑定物**:在 `readSourceTemplateCatalog.ts:148-212` 既有目录上**扩展**(不要从零造)出 K3 WISE 物料 `list_page` 条目,并经既有生命周期保存 + 审批出一份带**固定 profileId / configVersion / 数据子集 / 行上限**的读源配置。运行时已支持(见上),缺的是**被治理的绑定物**。 | 0.5 | sonnet |
| P2-2 | **首版预览 = 行级清洗/映射候选预览,不建物料快照批次平面**。今天最接近的治理预览面被 PLM 完整批次硬耦合:`stock-preparation-confirm-writes.cjs:345` 先调 `resolveCompleteBatchLines` 才读 `erp_material_master`(`:349`),生成器把 `plmBomLines` 当必填(`:354`),`resolveCompleteBatchLines:275-315` 要求存在批次 + run 行 + 非空行,否则 409 `CONFIRM_BATCH_INCOMPLETE`(`:294,:298`)/ 404(`:314`)。本轮做法:为"只有 K3/DB 读、无 PLM 批次"的首版提供一条不经过该前置的 values-free 预览路径(读入行 × `erp_material_master` 现值 × 清洗结果)。 | 0.75 | sonnet |
| P2-3 | readPath 从自由文本改为**目录绑定选择**:读源必须绑定到已注册的 catalog 条目(这也正是 B4 能钉住 profileId/configVersion/子集/行上限的前提)。依赖 P1-1。 | 0.5 | sonnet |

**P2 合计 1.75 人天**(owner 预算 1–2)。
**本轮外**:物料快照批次表 + 物料 differ + 物料变更类型(新平面);5 条路由级覆盖补齐(snapshot-batches、
`.../diff`、`.../diff/rows`、`mvp/sync/plan`、`mvp/sync/persist`)。

#### 验收判据(机械)

1. B4 绑定物:`GET` 该读源配置返回 `status='approved'`,且 JSON 中 `profileId`、`configVersion`、`object`、
   `rowCap` 四个键**值逐字**等于台账登记值;把 `rowCap` 改成 4 ⇒ 审批态失效/需重新审批(断言其为 configVersion 的
   一部分,而不是可就地改的字段)。
2. 一次真实 `POST /api/integration/read-source-configs/:id/read`,断言:返回行数 ≤ 声明 rowCap;
   `listPageIndex` 越界(0 或 11)⇒ 明确报错而非静默截断;移除 Symbol 标记 ⇒
   `K3_WISE_READ_LIST_ROUTE_UNSUPPORTED`(正控:带标记时返回行)。
3. P2-2 预览:在**不存在任何 PLM BOM 快照批次**的库态下调用预览端点 ⇒ HTTP 200 且返回非空清洗结果;
   同一调用在旧路径上 ⇒ 409 `CONFIRM_BATCH_INCOMPLETE`(两条断言必须都在同一套件里,证明确实绕开了该前置)。
4. P2-3:向 readPath 提交一个语法合法但**未注册**的端点(如 `/K3API/Material/GetNothing`)⇒ 保存被拒并给出
   目录哨兵错误码;正控:提交已注册端点保存成功。今天这条会通过(`read-source-config.cjs:186` 只查语法)。
5. 所有断言的通道证据按 §3.1 判据 5 处理。

#### 风险

- **#4744 未合并**:任何堆在其上的 P2 工作堆在未合并基线上(§2)。
- S6-A 默认 OFF ⇒ P2/P4 的任何验收跑必须**断言自己实际跑在哪个 flag 态下**,不得把 S6-A 能力当默认可用。
- K3 WebAPI 读在备料喂给侧是硬边界 10 行/页 × 10 页 = **100 行天花板**,来自适配器而非配置旋钮;对 1–3 行边界
  绰绰有余,但"读整本物料目录"的野心会撞墙。
- **无仓内证据**表明经审批的 K3 读源配置曾对真实客户硬件跑过**物料清单**;仓内记录的真机证明是 by-material
  BOM 清单(BL3)。
- 路由级覆盖薄的是**具体那 5 条**(见上),不要写成"路由覆盖系统性薄" —— source-run / conflict-policies /
  mapping / unit / read-source-configs 都有路由级测试。

---

### 3.3 P3 —— K3 Material 仅 Save:dry-run、审批、幂等、1–3 行写、读回

#### 已有

- **K3 WISE 出站 Material Save(仓内唯一真实 K3 写)** —— `k3-wise-webapi-adapter.cjs:1982` `upsert`、`:2009`
  逐行循环、`:2013` POST `savePath`;适配器注册 `index.cjs:253`。**接线:WIRED 且 LIVE**
  (`pipeline-runner.cjs:643` → `POST /api/integration/pipelines/:id/run`,路由 `http-routes.cjs:48` → handler `:3266-3274`)。
  **门控测试存在且真跑**:`__tests__/e2e-plm-k3wise-writeback.test.cjs` 在 `package.json:9` 链内,使用真实工厂
  (只 mock `fetchImpl`),断言 2 次 `/K3API/Material/Save`(`:340`)、Save body **精确 deepEqual**(`:342-347`)、
  无 Submit/Audit(`:348-349`)、1 条死信 `K3_MATERIAL_INVALID`(`:351-354`)。
- **⚠ 唯一闸门是一个布尔(接线:WIRED 且 LIVE —— 这就是当前生产姿态)** —— `pipeline-runner.cjs:642`
  `if (!dryRun && cleanRecords.length > 0)`,取值于 `:523`。
  **无 feature flag、无 env 开关、无出站白名单**(全仓 grep `EXTERNAL_WRITE_ENABLED|allowExternalWrite|writeEnabled|externalWriteEnabled`
  **零命中**)。传输是裸全局 fetch(`:1423`,`requestJson:1453-1481`),URL 纪律只有 http/https
  (`normalizeBaseUrl:73-86`)与相对路径断言(`assertRelativePath:88-100`),**无 host 白名单**。
  路由切分本身是干净的:`publicRunInput`(`http-routes.cjs:681-710`)只白名单 5 个键、`scopedInput`(`:557-563`)
  只额外加 tenant/workspace ⇒ 调用方**无法**把 `dryRun` 送进 runner;`/dry-run`(`:49` → `:3276-3285`)硬写
  `dryRun: true`(`:3283`)。但两者**同一 `write` 权限**,且 `/run` 不收 `confirm` 键(对比
  `VALID_TABLE_ACTION_APPLY_BODY_KEYS:713` 与 `VALID_C6_WRITE_APPLY_BODY_KEYS:719` 都有 `confirm`)。
- **不要把仓内 `externalWrite=false` 纪律当作本条链路的覆盖(接线:N/A —— 反例警示;对本链路而言是"未接线")**:
  那些常量全在
  `lib/sealed-export/contracts.cjs:218`、`lib/sealed-export/stock-preparation-runtime-core.cjs:532,:543`
  这一平面,`pipeline-runner` 与 K3 适配器**都不读它们**。
- **dry-run 预览构造出与真写完全一致的 Save body(接线:WIRED + GATED —— 路由 `http-routes.cjs:49` → `:3276-3285`,
  e2e 套件 `:396-401` 在链内断言 rowsWritten=0 / 零 Save / token 脱敏)** —— `previewUpsert:1656-1684`(适配器侧脱敏
  `<redacted>` `:1674`,runner 侧再脱敏成 `[redacted]` `:502-507` 经 `payload-redaction.cjs:197`);
  预览与真写共用同一 `objects` 闭包(`:1428`)⇒ **body 一致由构造保证**。
  **但元数据不一致**:`previewUpsert:1664-1665` 用裸 `resolveAutoFlag` 计算 autoSubmit/autoAudit,
  **没有**应用真写在 `:2000-2001` 施加的 save-only 覆盖 ⇒ 在 save-only profile 下预览可能显示 true 而真写强制 false。
  预览是 P3 的审批面,这条必须修。
- **Save-only 硬锁** —— `k3-wise-document-templates.cjs:177`(profile id)、`:187` `lifecycle:'save-only'`、
  `:189-193`(readPath GetDetail / readMethod POST / bodyKey Data / keyField FNumber / keyParam Number);
  适配器 `:385-408`(R-OPTIN,空/未知 profile fail-closed `:393-403`)、`:420-424` **merge 之后**剥离
  submitPath/auditPath 并重钉 lifecycle、`:1994-2002` 强制 auto flags 为 false 并记 `autoFlagsRefused`。
  **接线:WIRED 但仅 opt-in**,由 `config.objects.material.profile` 命名触发。
- **占位符 fail-closed(接线:WIRED —— 在 Save 路径上;检测与预览共用同一实现)** `k3-save-body-composer.cjs:88`
  (哨兵正则)、`:93-112`;适配器 `:471-487` 在 HTTP 之前抛 `K3_WISE_PRESET_PLACEHOLDER_UNFILLED`(`:483`)。
  但**证明"预览 == 真写"的那套 parity 套件今天不跑**(见 P1-0)。
- **投影不漏字段(接线:WIRED + GATED —— e2e 精确 deepEqual `:342-347` 在链内)**
  `k3-save-body-composer.cjs:52-68`;旁路仅 `passThroughBody===true`(`:53`)或无命名 schema
  (`:56-57`),无任何 K3 模板设置前者 ⇒ 休眠而非不可能。
- **C6 dry-run→token→apply 机制真实且在跑,且 target kind 是 profile 参数而非焊死(纠正;接线:WIRED + GATED ——
  路由 `http-routes.cjs:50-51`,`external-write-dry-run.test.cjs` 与 multitable 目标适配器套件均在链内)** ——
  `external-write-dry-run.cjs:244-252` 注释明写默认 SQL、opt-in 目标自带 `input.targetWriteProfile`,
  `resolveTargetWriteProfile:250-252`,`normalizeTargetConfig(system, profile):254-260` 以 profile 比 kind;
  **第二套非 SQL profile 已经在生产路由里跑**:`lib/adapters/metasheet-multitable-target-adapter.cjs:450-478`
  `MULTITABLE_WRITE_PROFILE`,`http-routes.cjs:231` import,`:1044-1063` 服务端按 target kind 选择(`:1054`),
  且其测试在链内。机制:mint `:129-138`、单次消费 + 409(`:140-180`,`:148/:160/:164/:175`)、
  `canApply:648`、仅 canApply 才发 token `:686-696`、apply 需用户 `:778-781`、apply 重算并在版本漂移时 409
  `C6_WRITE_DRY_RUN_TOKEN_MISMATCH`(`:793-801`);FE 闸门 `IntegrationWorkbenchView.vue:1536-1543`
  (含 `auth.hasPermission('integration:write')` `:1541`)。
  **残留(需 owner 裁,不排期)**:现有两套 profile 都在认证**非外部写**姿态(SQL `:225` 要求
  `c6WriteTarget && genericQueryDisabled`;multitable `:469-477` 要求 `externalWrite !== false` 否则抛),
  且 `normalizeTargetConfig:262-265` 仍要求 SQL 形状的 dataSourceId/object、写原语是注入的 `dataSourceWrites`
  (`:200-203`)。**K3 profile 将是第一个认证真实出站外部写为安全的 profile** —— 该结论要 owner 裁,理由是这一条,
  不是"C6 焊死了"。
- **W1/W2 写目标自助面** `write-target-config.cjs:12`(operations 含 `save_only`)、`:17-20` 拒绝原始写形状键、
  `:83-85` `sandboxSystemId !== systemId`;store `:16-20` 状态机、`:321-323` `approve()`;
  dry-run runtime `:26-30`(canApply/tokenIssued 按设计不可达)、`:121-138`;迁移 `064_…sql`。
  **接线:未接线** —— `http-routes.cjs` 与 `index.cjs` 对 `write-target|writeTarget` **零命中**;四套测试在链内。
  它是"人工审批"最接近的现成生命周期,但 `sandboxSystemId !== systemId` 与"单客户单 K3 实例"首版会冲突。
- **幂等 key 已算但不承重(接线:WIRED 但不承重 —— 计算与打戳在运行时,去重语义无任何调用点)** ——
  `lib/idempotency.cjs:44-56` 归一化、`:58-61` 计算(`idem_${sha256}` `:60`);
  runner `:444` 计算、`:471/:479` 打戳、`:646` 作为 keyFields 传入;适配器 `extractRecordKey:455-469` **只用来给行
  贴标签**;另见 `:178/:190` 错误匹配、`:672` 死信键、`:683/:717` provenance rowId。
  **写前无任何账本查询**。runner 自述后果,逐字:`pipeline-runner.cjs:857-858`
  "the caller would see 500 and retry, causing a duplicate ERP write."
- **既有的、无需新代码的写禁用机制(纠正"没有任何机制";接线:WIRED,默认 ON)**:`ensureOperation:444-453` 在
  `objectConfig.operations` 不含 `upsert` 时抛 `UnsupportedAdapterOperationError`,且
  `k3-wise-document-templates.cjs:273-289` 在该情形下**整体剥离 savePath**(`:280`,注释 `:277`)。默认为 ON
  (`operations:['upsert']` 见 `:98,:142,:184`)⇒ P3 可以直接把 `operations` 钉进被审批的绑定,而不是造新 flag。
- **两个 Submit 开关,且请求侧优先级更高(接线:两条都 WIRED 且可达运行时;链内无任一断言钉死其优先级)**:
  `pipeline.options.target.autoSubmit`(runner `:80-83` →
  `contracts.cjs:123` → 适配器 `:1998`,`resolveAutoFlag:347-348` 只要请求显式就采用请求值)**压过**
  `config.autoSubmit`。只堵 config 那个 = 堵了弱的那道门。
- **活动态闸门(真实存在;接线:WIRED —— `/run` 之上除 dryRun 布尔外唯一的真实安全属性)**
  `pipeline-runner.cjs:303`、`:319-320`;`allowInactive` 不在 `publicRunInput` 也不在
  replay handler 的显式 4 键对象内 ⇒ 两个写路由都设不了。
- **第二个实时写入口(接线:WIRED 且 LIVE,无预览/无 token)** `POST /api/integration/dead-letters/:id/replay`
  (路由 `http-routes.cjs:140`,
  handler `:4978-4991`)→ `pipeline-runner.cjs:846-854` 无 dryRun 直接实时 Save。天然只 1 行(单条死信载荷),
  在 1–3 行边界内,但**无预览、无 token、无上限校验**。
- **读回原语已在包内 profile 中**(降低 P3/P4 范围):`k3-wise-document-templates.cjs:189-193` 已带
  readPath `/K3API/Material/GetDetail`、readMethod POST、bodyKey Data、keyField FNumber、keyParam Number;
  读侧实现 `k3-wise-webapi-adapter.cjs:903` `extractMaterialDetailRecord`、`:915` `buildReadBody`。
  **接线:写后从未调用** —— 结果全部来自 Save 响应(`:2100-2111`);`writeErpFeedback:344-375`(调用点 `:725`)
  写回的是 MetaSheet,不是 K3。
- **离线 fixture 无 GetDetail/GetList(接线:WIRED 但未门控 —— 见 §3.1,只在非必需 job `K3 WISE offline PoC` 内跑)**
  ⇒ P3 的读回目前没有共享离线靶子。

#### 缺口(人天 / 模型)

| # | 缺口 | 人天 | 模型 |
|---|---|---|---|
| P3-1 | **在代码里**强制 1–3 行边界:服务端在实时写路径上拒绝,而不是靠运营配置。`sampleLimit` **不可复用**(`:594`、`:607` 两处都被 `dryRun &&` 守住,对实时写零作用);默认实时天花板 1000 行/页 × 100 页 = 100,000 行,可经 `pipeline.options` 提到 10000 × 10000(`:25-28`);`options` 是自由 JSONB,由**同一个 `write` 权限**经 `POST /api/integration/pipelines`(`http-routes.cjs:3185-3192`,`...body` `:3190`)设定 ⇒ 能设上限的人就是能拆上限的人。 | 0.5 | opus |
| P3-2 | **把 dry-run 绑到 apply**:K3 dry-run 铸一枚单次、TTL 有界、键为 (pipelineId, tenant, user, plan revision) 的 token;实时写必须携带;派发前重算 plan 并比对 revision。复用 `external-write-dry-run.cjs:129-180` 的 mint/consume 与 `:793-801` 的 revision 栅栏。**本轮的"幂等"由此提供 run 级语义**(见判据 3)。 | 0.75 | opus |
| P3-3 | **Save 后 GetDetail 读回**:端点、reader、keyField/keyParam 都已在 profile 内(见上),缺的是接线 + 证据形状;同时给离线 fixture mock 补 `Material/GetDetail`(与 `GetList`),由 catalog 驱动。 | 0.5 | sonnet |
| P3-4 | **绑定并断言 Save-only 姿态**:被审批的绑定钉 `config.objects.material.profile = 'material-k3wise-customer-profile-v1'` 与 `operations:['upsert']`;派发前 fail-closed 断言解析出的对象 `lifecycle === 'save-only'`;修 `previewUpsert:1664-1665` 使预览元数据与真写的 save-only 覆盖(`:2000-2001`)一致。 | 0.25 | opus |

**P3 合计 2.0 人天**(owner 预算 1–2,取上界)。
**本轮外(硬化,不排期)**:行级幂等账本;K3 作用域的出站 host 白名单 + 默认 OFF 姿态 flag;死信 replay 这道
第二写入口的关闭或显式接受;C6 profile 路线(待 owner 裁)。

#### 验收判据(机械)

1. **行上限**:对一个含 4 条 clean 记录的 pipeline `POST /run` ⇒ HTTP 4xx + 具名错误码,`rowsWritten === 0`,
   且 harness 记录到 `savePath` 的 fetch 调用数 **=== 0**。**变异探针**:把上限常量从 3 改成 4 ⇒ 该断言必须变红。
2. **dry-run→apply 绑定**:不带 token 的 `POST /run` ⇒ 拒绝;用过一次的 token 再 POST ⇒ 409;
   dry-run 之后修改源行再 apply ⇒ 409(revision 漂移)。三条分别 neuter(分别去掉 token 校验 / 单次消费 /
   revision 重算)必须各自单独变红 —— 不允许三道门互相掩护。
3. **幂等(本轮范围)**:run 级重放由单次消费 409 挡住(判据 2)。**残留必须写进验收记录**:行级账本本轮不做,
   循环中途失败(3 行写到第 2 行)不会被去重,依据 `pipeline-runner.cjs:857-858` 的自述;
   **中途失败的恢复动作是 GetDetail 读回 + 人工对账,不是重试**。
4. **Save-only**:在被审批绑定下断言 `lifecycle === 'save-only'`、请求中 `pipeline.options.target.autoSubmit = true`
   时真写仍强制 `autoSubmit === false && autoAudit === false` 且记录 `autoFlagsRefused`(**必须打这条高优先级的门**,
   只打 `config.autoSubmit` 不算);断言整轮 fetch 调用里 `/K3API/Material/Submit` 与 `/K3API/Material/Audit`
   命中数 **=== 0**;预览元数据在 save-only 下 `autoSubmit === false && autoAudit === false`。
   变异探针:删掉 `:420-424` 的剥离 ⇒ 红;删掉 `:2000-2001` 的覆盖 ⇒ 红;删掉预览侧覆盖 ⇒ 红。
5. **读回**:每写一行即以 `keyField=FNumber` 调 GetDetail,断言返回记录的 FNumber 与写入键逐字相等;
   任一行读不到 ⇒ 具名 `failedStage=READ_BACK` 且整轮判 FAIL。正控:对一个确实不存在的编号读回 ⇒ 报错而非静默 PASS。
6. **FBaseUnitID**:实测 Save body 的字段集合与客户 profile 的 27 字段集合逐字相等,且**不含 FBaseUnitID**
   (负控见 §3.1 判据 4)。
7. 通道证据按 §3.1 判据 5。

#### 风险

- 一个标识符之差:`/run` 与 `/dry-run` 同权限、同 body 形状,**中间只有 `pipeline-runner.cjs:642` 一个布尔**。
  误 POST 立即对客户 K3 实时写。
- `#4744` 未合并;P3 若在其上叠加,基线未落。
- FE 的 K3 设置面会整份覆写 `config`(`k3WiseSetup.ts:1935-1990` → `external-systems.cjs:268`)⇒ 在 P3 发布
  profile 选择面之前,lifecycle 的归属必须先归 catalog(P1-1),否则一次 UI 重存就能悄悄丢掉 Save-only 锁。
- 死信 replay 是无预览、无 token 的第二写入口;即使在 1–3 行边界内,也**必须列进验收证据**,否则它是未审计写通道。
- C6 复用不是配置改动:见上面的"残留",这是 owner 裁决项,不排期、不写成"改个参数"。
- W1/W2 的 `sandboxSystemId !== systemId` 与单客户单实例首版冲突 —— 若要把它当审批面挂上去,先上报 owner,
  不要私自放宽该校验。

---

### 3.4 P4 —— 从当前 main 出包、provenance、实体机验收

#### 已有

- **出包脚本** `scripts/ops/multitable-onprem-package-build.sh`:显式逐文件白名单 `REQUIRED_PATHS:37-182`
  (备料四项在 `:88-91`)、`write_build_provenance():467`(JSON `:501-523`,`gitCommit` `:507`)、
  `PACKAGE-METADATA`(`includedRuntimeRoots` 声明在 `:451`)、每包 `.sha256` 与 `SHA256SUMS`
  (`CHECKSUM_FILE:33`)。**接线:WIRED 但 dispatch-only** —— `.github/workflows/multitable-onprem-package-build.yml:3-4`
  只有 `workflow_dispatch`;`expected_sha` 守卫 `:26/:44/:50`;tgz+zip 双验 `:101/:104`;
  `:132` 明写外部 sidecar **不是信任根**("an old archive cannot be laundered by a fresh sidecar")。
- **校验脚本** `scripts/ops/multitable-onprem-package-verify.sh`:**18 个** `verify_*`(定义
  `:53,210,218,234,279,311,325,354,372,410,443,590,761,806,819,844,857,870`),**全部有调用点**
  (`:917,:946,:960,:961,:1106-1118,:1121`);`required=()` `:963-1096` 共 **132 条**。
  **接线:WIRED 但只在 dispatch-only 通道执行**(build workflow `:101/:104` 与运维手工执行);
  其唯一聚焦测试 `multitable-onprem-package-verify.provenance.test.sh` 是孤儿(见 P4-1)。
  `verify_build_provenance:311-323` 要求文件存在、schema 字符串精确、`gitCommit` 为真 40-hex(拒绝 `unknown` 与短 SHA)、
  含 `builtAt`;`verify_integration_fix_markers:325-352` 双向交叉核对 #1912 标记(三条不同失败信息)。
  **注意**:#4628 里"五项校验 / 128 条"的说法是过期的时点表述。
- **sealed-export pin 校验器** `lib/sealed-export/sealed-export-package-provenance.cjs`:
  `PACKAGE_PROVENANCE_VERSION:29`、`PINNED_MIGRATIONS:58-116`(**068–073,闭集**,由 `verifyPinnedMigrations:455-484`
  精确比对 id 集)、模块/外部/运行时/证据 pin 集、两个入口 `:596-620` / `:622-659`、再生成助手
  `computePackageProvenancePinSet:663-707`;`frozenManifestDigest:341-343`。
  **接线:双通道** —— 出包校验时由 `verify.sh:410-441`(调用点 `:1115`)执行;单测
  `__tests__/sealed-export-package-provenance.test.cjs` **在** `package.json:9` 链内 ⇒ 触及该插件的 PR 走**必需**
  `integration-guard`。**复核已实际执行**(对干净的 origin/main 快照跑两个入口):双双 `verified: true`,
  `frozenManifestDigest = 85bbef680b767d22780c2112499bc79db5b165b12b6fd3d450dfdea6c217e7bc`,与 pins 向量的
  `shasum -a 256` 逐字节相同。
- **S6-A 验收 runner** `scripts/ops/stock-preparation-s6a-onprem-acceptance.ps1`:参数 `:23-24`、
  summary schema v2 `:34-53`(含 `serviceRuntimeSha` / `packageSha256` / `machineBindingDigest` / `operationBindingDigest`)、
  形状门 `:262-263`、`Get-S6BuildProvenanceSha:106-122`、交叉核对 `:284-291`(不符 ⇒ `PROVENANCE_INVALID`)、
  绑定摘要 `:296-303`、运行不变量 `:208`/`:217`(`externalWrite` 必须为 false)。
  **接线:已进包 + 内容被校验(仅字符串在场)**;其 PowerShell 5.1 测试跑在**必需检查**
  `stock-prep PowerShell 5.1 acceptance`(`plugin-tests.yml:111-112` job,步骤 `:131-136` 同时跑 MVP 与 S6-A 两套)。
  **从未在实体机上跑完一次验收**。
- **三 pin 外部验证向量 + 一字节负控** `.github/workflows/stock-prep-s6a-postgres17-validation.yml`:
  字节 pin `:72-79`、跑校验器 `:91`、`gitCommit == serviceRuntimeSha` `:94-103`、frozenManifestDigest pin `:105-119`、
  一字节变异负控 `:121-157`。**接线:dispatch-only(`:24-25`)且绑在旧冻结包上** —— pin 值
  `:33` `metasheet-multitable-onprem-v2.5.0-s6a-a45a2fe3f-20260731.zip`、`:35` `0b80d927…`、`:36` `a45a2fe3f…`、
  `:37` `b5f40b3c9d…`;`b5f40b3c9d… ≠ 85bbef68…` ⇒ **按现状它无法验证 M1 包**。机制可复用,**值必须换**。
- **K3 Save-only 预设已在包内(接线:已进包 + 运行时 WIRED;但 provenance 只以布尔标记出现)**
  `k3-wise-document-templates.cjs:3`(`K3_WISE_DOCUMENT_TEMPLATE_VERSION='2026.05.v1'`)、
  `:177`、`:185`(注释)、`:188` savePath、`:189-193` **读回四件套**、`:232-234` 注册表。
  **provenance 只以布尔标记出现**:`BUILD_PROVENANCE.fixMarkers.issue1912.embedded` 由**已暂存**的适配器计算
  (`build.sh:495-500`),`verify.sh:338-351` 双向核对标记与 fail-closed 字符串
  `Unknown K3 WISE material profile`。**profile id 与模板版本号本身没有被作为"值"记录在任何 provenance 里**。
- **owner 要求的五个字段现状 = 2 有归宿 / 3 缺失(接线:N/A —— 字段盘点)**:`serviceRuntimeSha` 在包内叫 `gitCommit`
  (`build.sh:507`,`verify.sh:319-321` 断言),并作为具名字段出现在**验收 summary** 与 workflow env pin;
  manifest SHA-256 以 `frozenManifestDigest` 存在,但它摘的是 **pins 向量**,不是整包(整包摘要由 build 以
  `.sha256`/`SHA256SUMS` 产出,**但没有进 BUILD_PROVENANCE.json** ⇒ 不能自证);
  `profileVersion`(全仓词边界 grep 仅命中一个测试文件)、`mappingVersion`(五处命中全是
  `const mappingVersion = optionalString(mapping.plmVersion)` 的局部变量)、`clientHelperSha`(仅两份 docs 散文,
  `scripts/`、`plugins/`、`packages/`、`.github/` **零命中**)—— **三者在任何可执行产物里都不存在**。

#### 缺口(人天 / 模型)

| # | 缺口 | 人天 | 模型 |
|---|---|---|---|
| P4-1 | 把 `scripts/ops/stock-preparation-s6a-operator-preflight.mjs`(#4741 `d76f6993a`)加进 `REQUIRED_PATHS` + `required[]` + `PINNED_RUNTIME_FILES` 并重生成 pins 向量;`scripts/ops` 是**逐文件**白名单,从当前 main 出包会发出一份"指向不存在文件"的 runbook(runbook `:191` 引用它,build/verify/pins 三处 grep 均 0 命中);同时修正或注明 `includedRuntimeRoots`(`build.sh:451`)含 `scripts/ops` 的表述。顺带把两个孤儿包合同套件(`multitable-onprem-package-verify.provenance.test.sh`、`multitable-onprem-package-verify-k3-helper-contract.test.mjs`)接进一条会跑的通道(对照:`multitable-onprem-package-no-node-modules.test.mjs` 跑在 `plugin-tests.yml:82`)。 | 0.5 | sonnet |
| P4-2 | 迁移 074 / 075 的 provenance 与包内容覆盖:`PINNED_MIGRATIONS` 是止于 073 的**闭集**且 id 集被精确比对;两文件随目录整体进包却**零 pin、零 `required[]` 条目**,而 runbook 已要求运维执行它们并证明授权落地(`docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md:73,:107-136`)。 | 0.5 | opus |
| P4-3 | 五字段落到**一个**结构:在 `BUILD_PROVENANCE.json` 增量加 `profileVersion`、`mappingVersion`、`clientHelperSha`(整包 SHA-256 是否同时纳入由本项一并定),每个字段配 (a) 形状断言(40-hex / 64-hex / 非空版本串)、(b) 与其所描述产物的交叉核对、(c) 值错时必然失败的负控。**依赖 P1**:`profileVersion` / `mappingVersion` 的取值真源是 P1 的服务端 catalog,P4-3 不能与 P1 并行。 | 0.5 | opus |
| P4-4 | 从**合格 main** 出 M1 包并重钉验证:以 `expected_sha = 当次重新解析的合格 main SHA` 派发 build workflow,采集 gitCommit / 整包 SHA-256 / frozenManifestDigest,更新 `stock-prep-s6a-postgres17-validation.yml:33-37` 四个 env pin(或新增 M1 兄弟 workflow),使一字节负控跑在**新字节**上。 | 0.5 | opus |
| P4-5 | 起草 #4628 的**取代指令**(交付物就是这份指令本身),至少必须写明七点,因为 #4628 现有正文逐条与之相反:①**台账权威归属** —— 现状是**三本**同时在世(见 §5),指令必须明确哪一本是权威、其余两本作何处置;②**产物** —— 用从合格 main 新建的 M1 包取代"artifact 8616890535 / digest `sha256:13c7aaa36a…` / serviceRuntimeSha `7bf2bd7a1f8…` / release tag `stock-prep-onprem-m0a-rc-a-20260725-7bf2bd7a1` / no rebuild",并让"冻结后不得重建"重新绑定到新字节;③**公布五个 pin**:serviceRuntimeSha、packageSha256、packageProvenanceManifestDigest(= frozenManifestDigest)、profileVersion、mappingVersion,外加**单独记录**的 clientHelperSha(反混淆规则见 `docs/development/database-system-integration-line-design-and-verification-20260724.md:83`);④**写边界**:把 "Keep externalWrite=false throughout" 改为 K3 Material 仅 Save、≤3 行、Submit/Audit OFF、BOM 写 OFF、无批量/定时写;⑤**完整性闸门**:"仅当 preflight 证明 SHORT_PAGE 才进 flag-ON 窗口"正是产生 `SHORT_PAGE_SOURCE_UNAVAILABLE` 阻塞的那一条,指令必须说明 Save 腿是否改由行上限充当闸门,否则阻塞原样复发;⑥**阶段枚举**:现有 failedStage 集合(NONE\|ARTIFACT_VERIFY\|DEPLOY\|FLAG_OFF_HEALTH\|DATABASE_READ\|APPROVED_CONFIG_PREFLIGHT\|FLAG_ON_WINDOW\|RESTORE)没有 CLEANING / DRY_RUN / APPROVAL / K3_SAVE / READ_BACK,需补齐并配对 PASS/FAIL 行(dryRunDiffPreview、manualApproval、applyTokenConsumedOnce、rowsWritten≤3、getDetailReadBack);⑦**绑定**:验收 summary schema 冻结在 `stock-preparation/sqlserver-sealed-snapshot/acceptance/v2`(runner `:35`,且被 `verify.sh:394` 钉住字符串),Save 腿需要 v3 或一个兄弟 runner。 | 0.25 | opus |

**P4 合计 2.25 人天**(owner 预算 1–2,**超 0.25–0.5 天**)。若必须压回 2.0:把 P4-1 的孤儿套件接线拆出本轮。

#### 验收判据(机械)

1. **P4-1**:从产物里解出 `scripts/ops/stock-preparation-s6a-operator-preflight.mjs` 并断言其 sha256 等于 pins 向量
   登记值;负控:删掉包内该文件 ⇒ `verify.sh` 必须失败并给出具名信息(不是静默通过)。
2. **P4-2**:`PINNED_MIGRATIONS` 的 id 集扩到含 074、075,`verifyPinnedMigrations` 精确比对通过;
   负控:改动 `075_…sql` 一个字节 ⇒ 校验失败;再负控:把 075 从 pin 集删掉 ⇒ **同样**失败(证明是闭集比对
   而不是"存在即可")。
3. **P4-3**:每个新字段三件套齐 —— 形状断言 + 与所述产物的交叉核对 + 负控。
   **不许只加字段不加值断言**:现有 `verify.sh:392` 只要求 `externalPlmK3ErpWrite` 这个 **token 在场**、
   `:400` 只要求字面量 `ExpectedServiceRuntimeSha` 在场,**都不检查值** —— 这一类假绿不得复制。
4. **P4-4**:记录 build workflow 的 **run id**、`expected_sha`、产出的 `gitCommit`、整包 sha256、frozenManifestDigest;
   随后 pg17 验证 workflow 的 run 必须包含**一字节变异负控失败**的那一段日志(证明负控真的会红)。
5. **实体机验收(单次窗口)**:一份 summary,含 `serviceRuntimeSha` / `packageSha256` /
   `packageProvenanceManifestDigest` / `profileVersion` / `mappingVersion` 五个 pin 与**单独**的 `clientHelperSha`;
   `rowsWritten ≤ 3`;`getDetailReadBack = PASS` 且逐行 FNumber 相等;
   Submit/Audit 调用计数 = 0;`failedStage` 取自扩充后的枚举。

#### 风险

- **禁止复用旧字节**:#4628 授权的产物与 pg17 workflow 钉的 S6-A 冻结包**都早于**迁移 074/075、Date 投影生产修复、
  #4723 的 422、#4739 的规模腿。四个 pin 值与"no rebuild / 使用原始已验证字节"条款必须被取代,不能顺延。
- **可以复用的是机制**:build + 18 项校验器 + BUILD_PROVENANCE 交叉核对、sealed-export pin 校验器与其再生成助手、
  三 pin + 一字节负控范式、runner 内 `gitCommit == 公布 serviceRuntimeSha` 的交叉核对、机器/操作绑定摘要构造、
  runbook 的"下载 → 校验 SHA256 → 跑包内校验器 → 核 gitCommit → 核 frozenManifestDigest → 一字节负控 →
  任一不符即终止上报"序列、#1912 预设本身。这些都不需要重建,需要的是**新值 + 三个新字段**。
- **校验器的通病是"字符串在场"而非"值正确"**(证据见判据 3)。新增字段若不配值断言与负控,等于原地复制同一类假绿。
- **通道**:sealed-export provenance 单测与 PS5.1 验收**都在必需检查内**;但 **build workflow 与 pg17 验证 workflow
  都是 dispatch-only**,两个包合同套件被任何 workflow / package.json 引用为零 ⇒ 放在后者里的断言"通过"是因为
  没跑。
- **"从当前 main 新出的包一定能端到端过 verify"目前只是预测**:pin 一致性已由实跑两个 provenance 入口证实
  (`verified: true`),但 132 条 `required[]` 依赖 `apps/web/dist`、`packages/core-backend/dist`、
  `packages/openapi/dist-sdk` 这些只有真出包后才存在的产物。要用一次派发确认,不得当既成事实。
- 合格 main SHA 是移动靶,必须在派发时重新解析并重新核验;本文任何 SHA 都不是授权的出包输入。

---

## 4. 模型分配依据(本线实证得出的规则,不是通用政策)

- **opus = 判据类产物与全部对抗门**。凡交付物是**判据**(断言、pin、负控、fail-closed 哨兵、取代指令、
  provenance 字段的值语义)而非**实现**的,一律 opus。本线的经验事实:四次审出的缺陷里,大多数不是坏代码,
  而是**过强声明** —— "两个套件都在门控链里"(其中一个从未跑过)、"C6 焊死在 SQL 目标上"(kind 是 profile 参数)、
  "生产 apply 策略未接线"(注释过期,实际是两个写入口的唯一闸门)、"没有路由级测试"(有 7 处调用)。
  判定这类声明真伪的成本远高于写实现,所以判据归 opus。
- **sonnet = 对着已写好的验收清单做机械落地**。前提是判据先由 opus 定死(具体断言、具体 token、具体负控),
  sonnet 只做"把 A 收敛到 B、把 X 加进白名单、把 fixture 补两条路由"这类形状确定的搬运。P1-1、P2-1/2/3、
  P3-3、P4-1 都是这个形状。
- **fable = 文档,且任务形状必须先固定**(SHA、pin 值、计数由机器生成后再交给它写)。
  **本轮无 fable 形状的工作**:唯一被前序勘察标成 fable 的项(解隔离 `k3WiseSetup.spec.ts`)经实测是两条
  源码文本断言的代码修复(62 passed / 1 failed),不是文档,已重新归入 P1-3(opus)。等 P4-4 产出真实 pin 值
  之后,验收记录的成文可以交 fable。

---

## 5. 唯一状态表(就地维护,取代四份 scratchpad)

| 阶段 / 台账 | 状态 | 证据(逐字,可 grep / 可点开) |
|---|---|---|
| 基线 | 有效 | 勘察基线 `7da5d9e55b0f`;复核 main `2a2a5eee4f`;六个被勘察根目录 diff 为空 |
| P0 同步/评审 #4744 | 完成 | 业务补丁逐字节相同、pin 一致、CI 已跑 |
| P0 合并 #4744 | **MERGED** | `94d03fab5` @ origin/main(2026-08-04 复核) |
| P0 #4736 标记 superseded | 标题已标,**状态仍 OPEN** | `gh pr view 4736` → OPEN,title 带 `[SUPERSEDED]` |
| #4739 规模腿 | MERGED | `431d25699`;24999 双侧、斜率 3.457 ms/行、全量 POST 86.8s |
| #4723 duplicate-key 422 | MERGED | `4784d8fb8` |
| #4741 operator preflight | MERGED,**未进包** | `d76f6993a`;build/verify/pins 三处 grep 0 命中;runbook `:191` 引用 |
| 迁移 074/075 | 已落 main,**零 provenance 覆盖** | `PINNED_MIGRATIONS:58-116` 止于 073;pins 向量 074/075 零命中 |
| P1 catalog | **步骤 1 MERGED**(镜像 tripwire);步骤 2 待 owner 裁 | `b6a39366a` (#4750);步骤 2 建议不做,理由见 #4750 |
| P1 五个孤儿套件 | 未接线 | 磁盘 161 vs 链内 149;`k3-save-body-composer.parity` / `k3-wise-material-presets` / `k3-df-t1-target-payload-preview` / `read-smoke` / `read-smoke-contract` |
| P1 FE K3 面通道 | **已覆盖**(roster + `on.push.paths` 双侧) | #4750;CI 日志实证 `ok 4 - POSTURE: …` 于 integration-guard |
| P2 读腿 | **已建且已门控** | 配置面 + 运行时 + list 闸门 + 备料 intake,均在 `package.json:9` → 必需 `integration-guard` |
| P2 清洗腿 | 已建且已门控,但治理预览面被 PLM 完整批次硬耦合 | `confirm-writes.cjs:345,:349,:354`;`resolveCompleteBatchLines:275-315` |
| P2 物料 diff 预览面 | **不存在** | `sync-run-plan.cjs:18` 明确排除 K3/ERP/SQL;`erp_material_master` 是 upsert 缓存(`erp-material-sync-persist.cjs:41-46`) |
| P2 K3→intake 映射 | **产品早已完整**;#4751 造的平行件已撤回 | 见附录 B.9/B.10。intake 别名表本就认 `FNumber/FItemID/FName/FModel`;撤回件 `6a38ac06e` (#4755) |
| P2 canonical 命名 | **待 owner 裁** | 注册表出厂为空 `:570`;`stock_preparation.v1` 仅见设计文档 `gip-d0-…:233` |
| P2 物料对账冻结合同 | 已存在、LATENT、默认 OFF | `material-reconciliation-templates.cjs:6-13,:19,:22-23`;测试在门控链内 |
| P3 K3 Save | **已建、已接线、LIVE** | 适配器 `:1982/:2009/:2013`;`index.cjs:253`;e2e 套件在链内 |
| P3 实时写闸门 | 仅一个布尔 | `pipeline-runner.cjs:642`;无 flag、无 env、无 host 白名单(grep 零命中) |
| P3 行上限 | **不存在** | `sampleLimit` 被 `dryRun &&` 守住(`:594,:607`);默认 1000×100 |
| P3 dry-run→apply 绑定 | **在 C6 路径上已存在且内容绑定;K3 走的 pipeline 路径上不存在** | 见附录 B.1–B.3。C6 token 绑 `rowFingerprints`(`buildRevision:652` / apply 比对 `:799`);K3 侧姿态由 #4753 钉死(`bed3af38a`) |
| P3 行级幂等账本 | **不存在,本轮外** | key 只用于贴标签(`:455-469`);`pipeline-runner.cjs:857-858` 自述重复写 |
| P3 GetDetail 读回 | 客户端字段**已补**(#4752 `1c78a4632`);**写后调用仍未接** | `materialReadPath` 四声明点齐全;Save 响应仍是唯一结果来源 `:2100-2111` |
| P3 Save-only 锁 | 已建,**opt-in**;预览元数据不一致 | `:385-408,:420-424,:1994-2002`;`previewUpsert:1664-1665` 缺 save-only 覆盖 |
| P3 死信 replay | 第二实时写入口 | 路由 `http-routes.cjs:140` → handler `:4978-4991` → runner `:846-854` |
| P4 出包/校验机制 | 已建;build 与 pg17 验证均 **dispatch-only** | build wf `:3-4`;pg17 wf `:24-25` |
| P4 sealed-export pin | **与当前 main 一致(实跑证实)** | 两入口 `verified: true`;`frozenManifestDigest = 85bbef68…` |
| P4 pg17 pin | **过期,绑旧包** | `:33/:35/:36/:37`,`b5f40b3c9d… ≠ 85bbef68…` |
| P4 五字段 | 2 有归宿 / 3 缺失 | 有:`gitCommit`(`build.sh:507`)、`frozenManifestDigest`;缺:`profileVersion`、`mappingVersion`、`clientHelperSha`(可执行产物零命中) |
| P4 两个包合同套件 | 孤儿 | 任何 workflow / package.json 均零引用 |
| 台账 #4437 | OPEN,labels `validation`,`blocked:on-config-owner` | `gh issue view 4437` |
| 台账 #4628 | OPEN,labels `blocked:on-devops`,`validation`;其最新状态评论已把当前切片交给 #4693(`packageAvailableForEntityMachine=NO` / `deployment=NOT_AUTHORIZED` / `flagOnWindow=NOT_AUTHORIZED`) | `gh issue view 4628` |
| 台账 #4693 | OPEN,无 label | `gh issue view 4693` |
| 台账 #4695 | CLOSED,**不重开** | `gh issue view 4695` |
| 阶段依赖边 | **P4-3 依赖 P1**(profileVersion / mappingVersion 的真源是 P1 catalog)⇒ 四阶段不是四条并行车道 | — |
| 人天合计 | P1 2.0 + P2 1.75 + P3 2.0 + P4 2.25 ≈ **8.0**,踩在 owner 5–8 的上沿;要压回中位,先砍 P2-3、P4-1 的孤儿套件接线 | — |

---

## 6. 验证纪律(本线付过学费的,逐条一行)

- **跑一次胜过读十遍**。本轮 pin 一致性是靠实跑两个 provenance 入口(`verified: true`)确认的,不是靠抽样比对摘要。
- **单变量排除**。一次只动一个量;"改了三处然后绿了"不构成任一处的证据。
- **每个守卫配一个会改变行为的 mutation**。断言若在守卫被删掉后依然绿,它测的是别的东西。
- **守卫分别 neuter**。多道 fail-closed 门会互相掩护;必须逐门(且逐 token)单独失效,取得排他失败证。
- **「没能看」不能读成「看了没有」**。空 grep 先怀疑路径/语法/基线;声称已 rebase 要给出真实基点。
- **绿不代表测到了东西**。死代码的测试也会绿(`connector-action-contracts.cjs` 即是:套件在门控链内,
  运行时不可达);条件步骤会绿而不执行(`integration-guard.yml:479`),所以证据要贴 run id **加**执行日志行。
- **声明面越小越好**。不承重的声明**删掉**,不是加限定词;本轮被杀的结论多数是"过强声明"而非坏代码。
- **空读先怀疑读法**。本地工作树不是 main:引用一律经 `git show <sha>:<path>`,行号是该 blob 的行号。
---

## 附录 A — P1/P2 开工后的实测修正(2026-08-04,写在计划正文之后,不改正文)

> 计划正文是勘察产物;本附录是**开工后跑出来的**修正。两者冲突时以本附录为准,并标注理由。

### A.1 `material.v1` / `bom.v1` 是 K3 **模板 id**,不是备料侧规范形状

计划正文把它们写成待建的规范形状。**实测:仓内 `material.v1` / `materialV1` / `MATERIAL_V1` 只出现在
`adapters/k3-wise-document-templates.cjs`,即 K3 模板 id(`k3wise.material.v1`)。**

而备料 sealed-snapshot decoder 的 16 字段闭集是 **BOM 形状**
(`bomLevel` / `childDrawingNo` / `parentDrawingNo` / `designQty` / `designUnit` / `sourceBomId` …,
`stock-preparation-sealed-snapshot-decoder.cjs:18-35`)—— **它不是物料主数据的入口**。

⇒ **K3 物料读的接点不是 sealed-export decoder**,而是:

```
POST /api/integration/stock-preparation/mvp/source-runs/erp-materials   (http-routes.cjs:82)
POST /api/integration/stock-preparation/mvp/erp-materials/sync          (http-routes.cjs:86)
     → persistStockPreparationErpMaterialSync(stock-preparation-erp-material-sync-persist.cjs:345)
       入参 { context, permission, recordsApi, provisioning, targetProjectId, syncRunId, erpMaterials }
       admin fail-closed 在任何 provisioning/records 访问之前(:352)
       ERP 物料主数据是**租户级缓存**,非按 PLM 项目分域
```

**后果**:P2 的工作量比正文假设的小 —— 不是"建规范形状",是"把 K3 读的产出喂进 `erpMaterials`"。
其下游(`material-mappings/candidates` → `/candidates/sync` → `/confirm` → `prep-lines` → `generation/run`)
已在 T4 既有链的 ALWAYS 名册内、已被跑过。

### A.2 K3 mock 链今天就端到端跑通,且首版边界是它的既有不变量

`node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` 实跑通过:

```
step 5a  K3 testConnection ok
step 6   K3 Save-only 写 2 条,0 Submit,0 Audit      ← 首版边界,既有不变量
step 6b  BOM Save-only 1 条(v1 Data 模板字段)
step 7a  SQL 只读探针从 t_ICItem 返回 1 行
step 7b  中间表 upsert 1 行
step 7c  安全护栏拒绝对 t_ICItem(K3 核心表)的 INSERT
step 8-9 证据编译器 PASS,0 issues
```

⇒ **P3 的"Save-only、Submit/Audit 关闭"不是待建约束,是已被断言的不变量**;
"不得直写 K3 核心表"同样已有护栏。该 demo 自己标注 `mock pass ≠ customer live pass`,不得据此声称客户可用。

**P2/P3 剩余的真实缺口据此收窄为三件**:
1. **GetDetail 回读核验** —— P1 已记为 KNOWN GAP(服务端有 `readPath`,前端表单无对应字段);
2. **人工审批闸** —— dry-run 与 apply 之间;
3. **把 K3 读产出接进 `erpMaterials`**(A.1 的接点)。

> **不因此调低正文的人天估计。** 本轮实测反复证明:首次跑通的东西没有一次是一遍过的
> (规模腿从"从未工作"到"验到上界"用了十三次 dispatch)。编码量小 ≠ 首次跑通快。

---

## 附录 B — P3 实测:人工审批闸已存在,但不在 K3 那条路上(2026-08-04)

> 与附录 A 同性质:**开工后跑出来的**修正,与正文冲突时以本附录为准。
> 结论全部来自读代码,逐条带 `file:line`,可复核。

### B.1 我本要造的东西已经有了 —— 而且比我会写的强

`plugins/plugin-integration-core/lib/external-write-dry-run.cjs`

| 性质 | 证据 |
|---|---|
| apply 必须带 token | `:1026` 无 token ⇒ 400 `C6_WRITE_DRY_RUN_TOKEN_REQUIRED` |
| 单次消费 | `:150` consume / get+delete;`:146` `CONSUMING_TOKEN_KEYS` 防并发双消费 ⇒ 409 |
| 30 分钟 TTL | `:13`;过期 ⇒ 409 |
| 绑范围 | `:167` pipeline + tenant + workspace + **dryRunUser** + ownerPrincipal 任一不符 ⇒ 409 |
| **绑内容** | `:799` apply 重算 plan 比对 `revision`;`buildRevision`(`:652`)哈希含 **`rowFingerprints`**、`counts`、`completeSourceRead`、`writableFields`、`keyFields`、`fieldMappings` |

**含义**:dry-run 与 apply 之间源数据变了 ⇒ 指纹变 ⇒ revision 变 ⇒ 409。
这是**内容绑定**的批准,不是"再点一次确认"。**正文把「人工审批闸」列为待建,是错的。**

### B.2 但它不覆盖 K3

模块自己写着(`:246`):

> an opt-in target (S1b-2 multitable, **S2 K3**) supplies its own profile

已接线的只有 `data-source:sql-write-gated`(`:18`)与 `metasheet:multitable`
(`http-routes.cjs:1054`)。**K3 的 profile 属于 S2,不属于本轮。**

### B.3 K3 走的另一条路上,"批准"目前等价于一个布尔

```
pipeline-runner.cjs:642   if (!dryRun && cleanRecords.length > 0) {
pipeline-runner.cjs:643     await context.targetAdapter.upsert({ … })
```

- `pipeline-runner.cjs:335` `createAdapter(targetSystem, { role:'target' })`
- `contracts.cjs:222-236` —— registry **完全不读 `role`**
- `http-routes.cjs:3266` `pipelinesRun`:仅 `requireAccess(req,'write')`,不要 token
- `http-routes.cjs:3276` `pipelinesDryRun`:强制 `dryRun:true`,**不发 token**

⇒ 两端点之间零绑定。**先 dry-run 再 run,与直接 run,服务端无法区分。**

**可达性是实测的,不是推断的**(四项):

| 核实 | 结果 |
|---|---|
| adapter metadata | `roles: ['target']` —— K3 就是被声明的写目标 |
| registry 按 role 拦? | 不拦(`contracts.cjs:222`) |
| pipelinesCreate target kind 白名单? | 无 |
| material 默认 operations | `['upsert']`(`k3-wise-document-templates.cjs:98`) |

不是理论可达,是**默认形态**。

### B.4 这不是漏洞

两条路都要 `write` 访问权。**不是权限绕过**,是**两阶段确认在这条路上不存在**。
按本仓纪律,这类事实属于计划文档,不属于安全披露面。

### B.5 已有的硬锁 —— 这条是好的,别动

`k3-wise-webapi-adapter.cjs:420` 规范化时**删掉** `submitPath`/`auditPath`,并在 merge **之后**
钉 `lifecycle='save-only'`(operator overlay 覆盖不掉);`:2000` `autoSubmit = saveOnly ? false : requested`。

⇒ owner 首版边界里的「Submit/Audit 关闭」是**运行期不变量**,不是配置约定。
已有覆盖:`k3-wise-adapters.test.cjs:1635`。本轮**不重复造**。

### B.6 本轮做了什么(#4753)

按三选一里的 **C**:不改写路径行为,把**姿态钉死**。

- 正控:两个已接线 profile 各自**接受**自己的 kind(用与姿态断言完全相同的调用形状)
- 姿态:两者都**拒绝** `erp:k3-wise-webapi`,且拒绝必须带 422 / `C6_WRITE_TARGET_REQUIRED` /
  `expectedKind`+`actualKind` —— 证明是因 **kind** 被拒,而非系统形状不合法
- mutation:把 `K3_CONNECTOR_KIND` 换成已覆盖的 kind(模拟「K3 拿到了 profile」)⇒ **2 条红**

**未做 A/B**(注册 connector profile / 让 `gated` 承重):两者都是写路径上的产品行为变更,
当前约束为"不得外部写、不得 arming"。**由 owner 裁。**

### B.7 对正文的修正

| 正文 | 改为 |
|---|---|
| P3「人工审批闸」= 待建 | **已建**(C6 路径,内容绑定);K3 的 profile 属 S2 |
| P3 剩余三件 | 剩 **两** 件:GetDetail 回读接线(客户端字段已由 #4752 补)、把 K3 读产出接进 `erpMaterials` |

### B.8 勘误:B.7 的「剩两件」说法过宽(自查)

B.7 把 P3 剩余写成两件,并暗示 demo 接线(#4754)覆盖了其中的「把 K3 读产出接进 `erpMaterials`」。
**不成立。** 两者范围不同:

| | #4754 实际做的 | 仍未做的 |
|---|---|---|
| 读 | demo 内 **mock SQL 通道**读出的一行 | 产品路径上的 K3 `GetDetail` 读 |
| 落 | 映射到 intake **形状**并断言(含否定对照) | 落库到 `erpMaterials` |

#4754 的价值真实且不与单测重复(单测喂手写字面量,它喂上一步真读出来的行,
读的输出形状与映射输入契约一旦漂移即红),但它**不能**用来划掉产品侧接线。

**P3 剩余(修正后):**

1. **产品路径 K3 `GetDetail` 读 → `erpMaterials` 落库** —— 未开始;
2. ~~人工审批闸~~ —— 见 B.1:**已存在**(C6 路径);K3 侧姿态已由 #4753 钉死,
   是否给 K3 注册 profile(方案 A/B)**待 owner 裁**。

**一条纪律**:本轮两次把"更窄的东西"说成"点名的那件事"(这次;以及正文把已存在的审批闸列为待建)。
两次都是**声明问题不是代码问题** —— 交付前对每条"这实现了 X"逐条问"X 的原文是什么,我做的是不是它"。

### B.9 二次勘误:B.8 也错了 —— 产品路径不但存在,而且早于 P2 就完整

B.8 把「产品路径 K3 `GetDetail` 读 → `erpMaterials` 落库」写成**未开始**。**实测证伪。**

`stock-preparation-readonly-source-run.cjs` 把 `erp:k3-wise-webapi` 列为受支持源 kind(:72/:83/:90),
读出的行经 fieldMap → `intake.erpMaterials`(:782)→ `assertIntakeReady` 形状校验(:783,
不符即 422 `SOURCE_RUN_REQUIRED_SHAPE_MISSING`)→ `http-routes.cjs:4079` 在 flag 下直接喂落库。

更关键:`stock-preparation-readonly-intake.cjs:232-247` 的别名表**本来就认 K3 原始列名**
(`FNumber`/`FItemID`/`FName`/`FModel`)。把一行原始 K3 数据直接喂进去:

```
rowErrors: 0
{ erpMaterialCode:"MAT-EXISTING", erpMaterialInternalId:"1001",
  erpMaterialName:"Existing material", erpSpec:"SPEC-A", … }
```

**⇒ 这条链在 P2 动工之前就是完整的。**

### B.10 因此 #4751 是缺陷,已撤回(#4755)

我加的映射不是"补上缺失的一环",是**对已完成工作另造的更窄同类物**,而且身份派生冲突:

| 同一行经过 | `erpMaterialId` |
|---|---|
| #4751 映射 | `k3:1001` |
| 产品 intake | `stockprep_erp_material_6f377ca0768a9e0d` |

`erpMaterialId` 是落库的 **key field**(`…erp-material-sync-persist.cjs:98`)⇒ 一个物料两个键 ⇒ **落两行**。
零产品调用方,故未造成实际损坏;但**接线是计划里的下一步**,接上即断幂等。

产品那个派生还更好:**按 source system 命名空间隔离**,两个 ERP 都编号 1001 也不撞;`k3:${id}` 没有这个性质。

**#4754 需返工**(它调用了被移除的模块),已解除 arming。替代做法是把原始行直接喂 intake ——
比原来更强,因为那才是真实路径。

### B.11 这一轮我在同一件事上错了三次,记下形态

1. 把**已存在**的人工审批闸写成待建(B.1 修正);
2. 把 demo 接线说成产品接线(B.8 修正);
3. 把**早已完整**的产品路径写成未开始,并据此造了个冲突的平行件(B.9/B.10 修正)。

三次都不是代码写坏,是**没先去被测目标里查它是否已经做了这件事**。
第三次的模块头注释里我自己写着「the only thing genuinely missing between the two is this mapping」——
**文档在论证"我不是冗余的"这件事本身,就是该去查的信号**,不是可以跳过检查的理由。

**纪律**:动手实现任何"补上缺失的一环"之前,先把一条**真实输入**喂给下游,看它是不是已经能吃。
一次实验的成本远低于一个平行实现,更远低于一个冲突的键。

---

## 附录 C — P4 前置盘点:五项 provenance 里只有两项今天可记(2026-08-04)

> owner 要求「serviceRuntimeSha、profileVersion、mappingVersion、manifest SHA256、client helper SHA **分别**记录」。
> 逐项在仓里核实,**其中三项不是"去某处取值"那么简单**。趁四票收尾先盘,免得 P4 开工才发现。

| 字段 | 现状 | 证据 |
|---|---|---|
| `serviceRuntimeSha` | ✅ **已记录** | `scripts/ops/stock-preparation-s6a-onprem-acceptance.ps1` |
| manifest SHA256 | ✅ **已记录**,名为 `packageSha256` | 同上 |
| `profileVersion` | ❌ **全仓 0 处** | `grep -rl profileVersion scripts/ .github/workflows/ lib/` = 0 文件 |
| `mappingVersion` | ⚠️ **名字存在,含义完全不同** | 仅见 `stock-preparation-mvp-generation.cjs:151/169`,那里是 `mapping.plmVersion` —— **PLM BOM 的版本比对**,不是包 provenance。**照字面取值会记录错的东西。** |
| client helper SHA | ⚠️ **无该名字;实体是三个 helper 脚本的 digest** | `build-stock-preparation-rca-window-sidecar.mjs` 钉的是 `stock-preparation-mvp-postdeploy-smoke.mjs`、`stock-preparation-prep-line-extended-smoke.mjs`、`stock-preparation-rca-window-pm2-sample.mjs`。新包要记的是这三者在新 HEAD 上的 digest,**不是一个 SHA 而是三个**。 |

### C.1 因此 P4 不是"跑一下现成工具"

出包工具本身是现成的(`multitable-onprem-package-build.sh`、
`stock-preparation-s6a-onprem-acceptance.ps1`、`stock-prep-s6a-postgres17-validation.yml`),
但**五项分记里有三项需要先定义清楚**:

1. **`profileVersion` 指什么?** 候选:sealed-export profile 的 `profileId`+版本、
   K3 document template 的 `k3wise.material.v1`、或 read-source profile。**三者都存在且不同**,
   记错一个就是虚假 provenance。
2. **`mappingVersion` 在 #4751 撤回后指什么?** 原设想是那个映射模块的版本;它已撤回,
   而真实映射是 intake 的别名表 —— 那是运行时代码的一部分,**其"版本"就是 `serviceRuntimeSha`**。
   若确认如此,这一项应当**合并进 runtime sha 而不是另立一个字段**(否则是同一事实的两个记录点,
   会漂移)。
3. **client helper SHA 是三个不是一个** —— 分记时要三行,合成一个会掩盖单个 helper 的变化,
   而那正是 RC-A sidecar tripwire 当初要防的。

### C.2 建议

**P4 开工前先答 C.1 的三问**(纯定义,不需编码)。否则出的包会带一份
「字段齐了但有两项指向错误对象」的 provenance —— 那比缺字段更糟,因为它看起来是完整的。

**不建议**由我单方面把 `mappingVersion` 定义掉:它是**合同面**的字段,
本轮已经在"另造更窄同类物"上栽过一次(B.10),不重复。

### C.3 注记:C 的一半是重新推导了 §5 已记的东西

写完附录 C 才回读 §5,发现「五字段 2 有归宿 / 3 缺失」**正文状态表里早就有**,
连缺的三项名字都一样(`profileVersion` / `mappingVersion` / `clientHelperSha`)。
§5 还多给了一条我没独立得出的信息:

> 阶段依赖边:**P4-3 依赖 P1**(`profileVersion` / `mappingVersion` 的真源是 P1 catalog)

**所以 C 的净增量只有两条**(它们确实是新的,§5 没有):

1. `mappingVersion` **不只是"缺失",是名字被占用** —— `stock-preparation-mvp-generation.cjs:151/169`
   里的同名字段指 PLM BOM 版本比对。照字面去仓里取值会**记录一个错的东西**,
   这比"缺失"危险,因为它会成功。
2. client helper SHA **是三个不是一个** —— sidecar 钉的是三个 helper 脚本,合成一个会掩盖单个变化。

**这是本轮同一形态的第四次**(见 B.11):动手之前没先查现有材料里是否已有答案。
前三次查的对象是代码,这次是**我自己两小时前写的文档**。
纪律补一条:**回读自己的台账,和查代码同等优先** —— 台账存在的意义就是不必重推。
