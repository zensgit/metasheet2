# 备料：一个项目一张备料表 —— 项目登记、自动新建拉取、总览表、删除与恢复（ADR 2026-10-08）

> **状态**：草稿。owner 2026-10-08（回复「同意」）批准按此方向起草；本稿本身**不是裁决**。
> **基线**：origin/main `9eee3a3cd`（`9eee3a3cd0e734f6a4abb972068f4f535eb08ebf`）。所有行号都用 `git show origin/main:<path>` 核过。
> **values-free**：不含主机、地址、口令、凭据、真实项目号、物料名；项目号一律写 `<项目号>`。
> **关联**：#5860/#5868（一表一项目守卫）、`customer-anomaly-triage-20260924.md` §1/§1b、`design-project-ownership-20260906.md`（未 ratify）、R-11、D1=B（`222-deploy-window-runbook-20260901.md` §0.6）。
> **来源**：客户反馈 2026-09-24 #1b 与 2026-10-08（《异常情况（20261008-多维表-改）》第 2、3 条及 owner 当日补充）。

**待 owner 拍板（每条附推荐默认）**

| # | 问题 | 推荐默认 |
|---|---|---|
| Q1 | 一线（`stock-prep:operate`）能否在拉取时自动新建本项目的备料表？这与 R-11 的口径冲突：一线档不开 provisioning（`http-routes.cjs:231-236`） | **能**，作为 R-33 记下的具名例外。限制：只能从「拉取」入口进；只能用冻结模板；objectId 和表 id 都由服务端派生；每个租户最多 200 张有效表；每次都写审计 |
| Q2 | 删除、恢复项目由谁做 | 删除和恢复都要 `stock-prep:admin`（或平台管理员）。一线只能「撤销新建」，即删掉自己建的、0 行、来源为 provisioned 的空表 |
| Q3 | 现有 `bom备料<项目号>` 表里混着多个项目的有效行，登记时怎么处理 | 登记前先清到只剩一个项目的有效行：按 0924 §1 (a)，把其他项目的行置为无效（可逆）。其他项目已填的人工列**不**搬进它们各自的新表 |
| Q4 | 「没拉过」时先建表还是先预览 | **先建空表，再试算预览**。用户取消就留下一张 0 行空表，状态「还没拉过」，可以「撤销新建」 |
| Q5 | 总览表的「只读」要多严 | 宿主层面只读：新增一个系统表类型 + 能力钳制。所有人（含管理员）只能看和导出，唯一的写入者是插件 |
| Q6 | 新项目表的写入授权从哪来？演示机上只有沙箱写入门，生产门没有配置加载器 | **继承部署已有的沙箱写入授权**，三个条件同时成立才放行：开关开着；objectId 来自本租户一条有效登记行；部署动作自己的 objectId 已在沙箱放行清单里 |

---

## 0. 为什么

**现状（main 上的事实）**

1. **目标表是部署级配置，不按项目区分。**
   - `action.target` 来自 env JSON，由 `stock-preparation-table-actions.cjs:190-200` 的 `normalizeTarget` 规整。
   - `getTableAction` 只覆盖 source（`:889-909`、`:919-929`）。export 路由的注释自己写着 "It does NOT pick the SHEET"（`http-routes.cjs:8983-8988`）。
   - `stock-preparation-source-binding.cjs` 只绑**数据源**（`:3-16`、`:52-53`），不绑目标表。
2. **#5860 强制一表一项目。**
   - `assertTargetSheetHoldsNoForeignActiveRows`（`table-actions.cjs:1059-1108`）发现别的项目的有效行就回 409 `TARGET_SHEET_FOREIGN_PROJECT`（`:1090-1100`）。
   - 它接在 dry-run（`:2009`）、apply（`:2516`）和大 BOM plan（`http-routes.cjs:6711`）上。
   - 所以同一租户拉第二个项目必然被拒。R62 上机记录：定时试拉仍然 409（`r62-deploy-record-20261007.md:14`）。
3. **托管表在界面上删不掉。**
   - `DELETE /sheets/:sheetId` 对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（`univer-meta.ts:16199-16200`）。
   - `canDeleteSheet` 置为 false（`:9358-9383`）。
   - 表回收站也把托管表排除在外（`:8349`）。
4. **首页项目卡 = 服务器目录 ∪ 本机 localStorage。**
   - 合并逻辑：`operatorHomeCards.ts:107-157`；本机存储：`operatorHomeMemory.ts:63,119-120,162-185`。
   - 目录的「拉取表」部分只扫这一张绑定表（`stock-preparation-operator-project-directory.cjs:463-486`），所以分不出项目，也给不出每个项目的行数。
   - `stock-preparation-pull-target-scan.cjs:54-60` 早就把「每租户独立目标表」点名为真正的修法。

**owner 需求（截至 2026-10-08）**

- 0924 #1b：托管表删不掉。
- 1008：
  - 能删除项目数据，并且可以恢复；
  - 拉取时，已拉过的项目给「直接打开 / 覆盖拉取」，没拉过的自动新建并拉取；
  - 能看到有多少个项目、每个项目还剩多少活；
  - 项目表里显示一共多少行。

**本 ADR 的决定**

一个业务项目对应一张受管备料表。由服务端登记表做「项目号 → 表」的唯一权威。每条读写路由都按项目号解析到这张表。全部新行为放在一个默认关闭的开关后面。

## 1. 登记表：业务项目 → 备料表

### 1.1 放在哪里

| 方案 | 唯一性 / 并发 | 插件能不能写 | 结论 |
|---|---|---|---|
| **新 SQL 表 `integration_stock_prep_project_target`**（先例：079 源绑定、084 交接游标） | 唯一索引仲裁并发；store 用 `insertOne` + 23505 捕获（`stock-preparation-handoff-store.cjs:52-55`） | 能：插件 db 只允许 `integration_*` 前缀（`db.cjs:25,51-60`） | **采用** |
| `meta_sheets` 上加一列 | 要改核心迁移和宿主 port；`meta_sheets` 本来就没有项目列（`http-routes.cjs:793-796`） | 不能：前缀门挡住了 | 否 |
| 复用 `integration_stock_prep_source_binding` | 唯一键是 (tenant, workspace, action)（`079…sql:55-56`），一个动作一行，语义是**源**指针；数据源删除守卫也在数它（`external-systems.cjs:83`） | 能，但会改语义 | 否 |
| 用 `stock-preparation-templates.cjs` 清单建一张多维表 | 记录层没有唯一约束，也没有事务；人能直接改；写入路由会变成依赖一张用户可见的表 | 能 | 否。登记表不用它，只把它用作 §5 的**总览投影** |

### 1.2 结构（migration `087`；migration `088` 扩审计动作）

```
integration_stock_prep_project_target
  id TEXT PK, tenant_id TEXT NOT NULL, project_no TEXT NOT NULL,   -- project_no 按 normalizeActionParameters 去首尾空白（table-actions.cjs:943）
  sheet_id TEXT NOT NULL, object_id TEXT NOT NULL,
  origin TEXT CHECK (origin IN ('provisioned','bound_legacy')),
  status TEXT CHECK (status IN ('active','deleted')),
  created_by, created_at, deleted_by, deleted_at, restored_by, restored_at, updated_at,
  last_pull_at, last_pull_outcome CHECK IN ('applied','previewed','refused'), last_pull_code TEXT,  -- 封闭错误码，不是值
  row_count INT, active_row_count INT, counts_bounded BOOL, missing_components_count INT, counts_at
UNIQUE (tenant_id, project_no);  UNIQUE (sheet_id);  CHECK (status='deleted') = (deleted_at IS NOT NULL)
```

- **没有 workspace 维度**，与 084 交接表同理（`stock-preparation-handoff-store.cjs:37-38`）。
- **`project_no` 是导航句柄**，和审计表的 `project_id`、084 表的 `project_no` 同一个口径（`handoff-store.cjs:27-31`）。
- **088 的写法**：照 086 的方式把审计动作全量重列（`086…sql`），新增 `project_target_register` / `_create` / `_delete` / `_restore` / `project_overview_refresh` 五个。一次性列全，免得 S4 再重列一次。
- **编号说明**：未 ratify 的归属草稿也写过 `087/088`（`design-project-ownership-20260906.md:451`）。哪个先合入就用哪个号。

### 1.3 现有绑定表的一次性登记

**新路由**：`POST /api/integration/stock-preparation/project-targets/register-bound`，请求体 `{projectNo, apply?, planDigest?}`。

- **门**：`requireAccess(req, STOCK_PREP_ADMIN)`。
- **租户**：用 `resolveOperatorValueScope`（`stock-preparation-operator-scope.cjs:384`）。这条路径在无租户声明的演示机形态下也能用（`http-routes.cjs:9564-9566`）。**不用** `resolveVerifiedClaimTenantId`，它在无声明部署上直接回 403（`:1283-1291`）。
- **开关关闭时也可用**：它只写登记表，而开关关着时没有任何代码读登记表。这样可以先登记、后开开关。

**试算**（零写入），返回：

- 对 env `action.target` 跑现有租户墙的判定（`decideCarryTargetOwnership`，`target-provisioning.cjs:1205-1219`）；
- 存活证明（`pull-target-scan.cjs:212-225`）；
- 各项目号的有效行计数。暴露的是本租户自己的号，暴露层级与一线目录相同（`http-routes.cjs:192-199`）；
- `foreignActiveRowCount`；
- 这个表或这个项目号是否已登记；
- `planDigest`。

**执行**，必须同时满足三条：

- `planDigest` 与试算一致（先例：relabel，`http-routes.cjs:118-123`）；
- 表里没有其他项目的有效行（Q3）；
- 表和项目号都还没登记。

执行写入一行：`origin='bound_legacy'`，`sheet_id` / `object_id` 原样取 env 里的 `action.target`，再写一条审计 `project_target_register`。

**结果**：名为 `bom备料<项目号>` 的那张表成为该项目的登记行，表名不动。

## 2. 每个项目怎么建表

- **objectId**：`plm_stock_preparation_sandbox_p_<sha256(tenantId + ':' + projectNo) 前 24 位>`。
  - 原始项目号不进标识、不进拒绝详情：租户墙的拒绝会带 objectId（`http-routes.cjs:816,856`）。
  - 这串摘要**不是**保密手段。看得到它的人本来就知道自己查的是哪个项目号。
  - 它落在沙箱命名空间里，`assertSandboxObjectId` 和预检的过滤会接受（`target-provisioning.cjs:99-103,119-149`）。
  - 表 id 和字段 id 由宿主从 (staging 项目, objectId) 派生（`provisioning.ts:199-209`），所以「一个项目一张表」在结构上就成立。
- **复用现有建表逻辑**：`ensureStockPreparationCanonicalTarget`（`target-provisioning.cjs:497-526`）→ `ensureStockPreparationTarget`（`:718-871`）。传入的 template 由 `stockPreparationTemplateForObject({objectId, label:'Stock prep <项目号>', labelZh:'备料-<项目号>'})`（`:207-224`）生成。
  - 建表分支会自动带上默认视图（`:809-815`）和「备料填写视图」（`ensureStockPreparationFillView`，`:647-689`，调用点 `:834-841`）。
  - 表名语言跟 `MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE` 走（`templates.cjs:35-37`）。
  - 项目号必须通过 `assertSafeSchemaString`（`templates.cjs:211-217`）。
- **放在哪个 base**：和确认账本同一个 base。
  - 做法：把项目表族加为账本的**单向**锚定伙伴（改 `stock-preparation-own-base.cjs:165-169`；配对定义在 `:118-121`）。现有围栏照旧生效：只接受 `base_legacy` 或插件系统 base，其余 409（`:38-52`）。
  - 没有账本时，按 #5702 派生自己的 base（`:242-250`）。
- **客户包（customer pack）**：如果部署给绑定 objectId 装过包（ledger 076 按 `(tenant, project_id, object_id, pack_id)` 建键，`076…sql:19-20`），新建时要把同一个包重装到新 objectId 上：ext_ 列、选项集、角色视图、列写权。安装器按 `pack.targetObjectId` 工作（`customer-pack-installer.cjs:267-670`）。
  - **原因**：`ensureObject` 建不出 ext_ 列（`target-provisioning.cjs:735-741`）。不重装的话，第一次 dry-run 就会被 `assertTargetFieldsExist` 回 422（`table-actions.cjs:713-785`）。
- **登记表存什么**：只存 `sheet_id` 和 `object_id`。
  - provisioned 行：字段映射每次请求时用 `provisioning.resolveFieldIds` 现算。这个调用只做计算、不查库（见 `target-provisioning.cjs:368-372` 的说明）。
  - bound_legacy 行：原样使用 env 里的 `target.fieldIdMap`，与今天逐字节相同。
- **谁能建**：见 Q1。新路由 `POST …/projects/:projectNo/target`，门与看板相同（`requireAccess(STOCK_PREP_OPERATE)`，`http-routes.cjs:9797`；层级关系 `workbench-access.cjs:399-408`）。
  - 模块里 `permission:'admin'` 的检查（`target-provisioning.cjs:151-160`）是服务端能力常量，由路由传入，与调用人层级无关。
  - 请求体是空的封闭白名单，不接受 base、名字、字段。

## 3. 路由按项目号解析

**统一接缝**：`getTableAction(input)` 新增 `projectNo` 参数，在 `applyPersistedSourceBinding`（`table-actions.cjs:889-909`）之后叠加 `applyProjectTarget`。解析逻辑：

| 登记行状态 | 写路由 | 读路由 |
|---|---|---|
| active | 返回 `{sheetId, objectId, keyField:'idempotencyKey', fieldIdMap}` | 同左 |
| deleted | 409 `STOCK_PREPARATION_PROJECT_TARGET_DELETED` | 走该路由原有的「找不到」分支，不新增存在性探测口 |
| 不存在 | 409 `…_ABSENT` | 同上 |

**防止漏传**：开关开着时，`http-routes.cjs` 里每个 `getTableAction(` 调用都必须带 `projectNo`，或者显式带 `targetPurpose:'readiness'`。加一条源码扫描守卫钉住这一点（形制照 `stock-preparation-tenant-scoped-write-guard.test.cjs:330,444`）。这样漏改一个调用点就会在 CI 上变红。

| 路由 | 今天取目标的位置 | 开关开后怎么解析项目 |
|---|---|---|
| dry-run | `http-routes.cjs:6105` | `body.parameters.projectNo` |
| apply | `:6496` | 同上；另见下面的门 |
| reconcile | `:6263` | 同上 |
| mvp-persist | `:6382` | 同上 |
| 大 BOM expansion-start | `:6566` | 同上；目标进入 `job.actionSnapshot` |
| 大 BOM plan / apply-start / apply-run | `:6698`、`:6788`、`:6868` | 用快照（逐字节相同）；apply-run 另外复查登记行，已删除就 409 |
| conflict-policies 增删查 | `:6930/6940/6952`；策略按 target 建键（`conflict-policies.cjs:72-94`） | 新增 `?projectNo=`。缺省时用旧的绑定表 |
| 结转 carry/confirm | `:8175`，墙 `:8196-8203` | 从 `decision.idempotencyKey` 解析项目号，与 `confirm-writes.cjs:1055-1077` 用同一套解析 |
| 导出 prep-lines/export | `:8989-9021` | query 里的 `projectNo` |
| 一线目录 | `:9138-9157` | 改为按登记行枚举，见 §5 |
| 看板 projects/:projectNo/board | `:9828-9847` | 路径里的项目号；填写视图句柄要用登记行的 objectId（`pull-target-scan.cjs:76,402-410` 目前写死 canonical） |
| 交接 advance | `:9546-9580` | 请求体里的项目号 |
| 交接 status | `:9221`（不取目标） | 不变 |
| source-preflight | `:7093`（只读数据源） | 不变 |
| 部署预检 | `:6975-6999` | 新增 values-free 小节：开关状态、已登记数量、旧表是否已登记 |
| 定时试拉 | `scripts/ops/stock-preparation-scheduled-pull.mjs`（默认只试算，`:25-29`；`--apply` 见 `:148-149`） | 服务端不需要改；脚本把 `…_ABSENT` 归为「跳过」（`:156-157`），不当失败。它**绝不**建表 |
| 实时桥 | `git grep -c realtime plugins/plugin-integration-core/lib` = 0 | 不存在，不涉及 |

**租户墙**

- `assertStockPreparationTargetBelongsToTenant`（`http-routes.cjs:829-857`）和它现有的三套措辞（`:863-879`）**逐字节不动**，只是现在作用在解析出来的这张项目表上。
- provisioned 表由 `ensureObject` 认领进对象注册表（`sheet-delete-guard.ts:15-21`），判定为 OWNED。bound_legacy 表的判定和今天一样。
- 开关开着时，dry-run / apply / reconcile / mvp-persist / expansion-start / conflict-policies 这些今天不跑墙的路由也要跑墙，用新增的 `tableAction` 措辞（`TABLE_ACTION_TARGET_TENANT_MISMATCH` / `_OWNER_UNKNOWN`）。原因：开关打开后，目标表由租户决定。
- 项目表 objectId 的派生 id 与表 id 一致，所以字段存在探针（`table-actions.cjs:753-758`）和存活证明（`pull-target-scan.cjs:215-222`）都能真正生效。它们比旧的 D1=B 形态更严：D1=B 下的绑定表会跳过字段探针。
- 新增的写面不比今天宽：今天所有租户共写一张部署级表（`pull-target-scan.cjs:48-60`）。legacy `integration:*` 档在无声明部署上用 header 带租户，这是已有问题（`http-routes.cjs:1106-1116`），本 ADR 不改；开启 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 时会一起收紧。

**写入门（Q6）**

- `assertStockPrepApplySandboxAllowed`（`table-actions.cjs:2384-2400`）加**一条**只增不减的分支，形参是服务端持有的 `registeredProjectObjectId`。四个条件同时成立才放行：
  - 开关开着；
  - `objectId` 等于路由刚从登记行解析出来的那个值，并且匹配 `^plm_stock_preparation_sandbox_p_[0-9a-f]{24}$`；
  - `policy.enabled === true`；
  - 部署 env 动作自己的 `target.objectId` 在 `allowedTargetObjectIds` 里。
- 生产分支（`:2441-2456`）不变。它在部署上本来就打不开：`plugin-runtime-config.ts` 里 `stockPrepApplyProduction` 出现 0 次，runbook `:82` 也有说明。

**开关关闭时逐字节不变的部分**：`getTableAction` 的输出、所有现有路由的响应和审计、三套墙、写入门、目录响应（新增键只在开关开时出现）。

**另一个后果**：#5860 的守卫保留不动。每张表只装一个项目，它就不会再挡新项目；它仍然负责挡「旧混合表」和误绑。

## 4. 拉取交互（首页「拉一个新项目」和「项目接入」面板）

**API**：`GET /api/integration/stock-preparation/projects/:projectNo/target`

- 门和租户推导与看板相同（`http-routes.cjs:9797` + scope）。
- 开关关着时回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`，不做任何 IO。

```
{ status: 'absent'|'active'|'deleted', sheetId, viewId, rowCount, activeRowCount, rowCountBounded,
  lastPulledAt, lastPullOutcome, deletedAt, may: { create, delete, restore, undoCreate } }
```

- 行数用 `readPullTargetRowFacts` 在这张项目表里数（`pull-target-scan.cjs:622-635`）。超过上限时 `rowCountBounded=true`，界面显示「超过 N 行」。
- `sheetId` / `viewId` 是深链句柄，和看板今天返回的一样。

**交互流程**

| 状态 | 按钮 | 步骤 |
|---|---|---|
| absent | 「新建备料表并拉取」 | 确认框「将为 <项目号> 新建一张备料表」→ `POST …/target`（201 新建 / 200 已存在）→ dry-run → 预览「将写入 N 行」→ 确认 → apply → 结果行显示总行数。取消的话保留空表（Q4） |
| active | 「直接打开」/「覆盖拉取」 | 打开：用 `sheetId` / `viewId` 深链进填写视图。覆盖拉取：确认框「表里现在共 N 行（有效 M 行）。重新拉取只更新从 PLM 来的列，您填的列保留，PLM 已删掉的行会标成无效」→ 走现有的 dry-run/apply |
| deleted | 「恢复并重新拉取」（需要恢复权限，Q2） | `POST …/target/restore` → 进入覆盖拉取流程。没有权限的人看到「请联系管理员恢复」。**不会**新建第二张表：表 id 是确定性派生的，被软删的旧行仍占着这个 id，`ensureSheet` 会抛错（`provisioning.ts:481-500`） |

**「覆盖拉取」的真实语义**：它就是现有的幂等重拉。PLM 带来的列会更新，人填的列保留，PLM 已删掉的行按 `mark_inactive` 标为无效（`table-actions.cjs:1012-1016`）。**它不会清表**。文案必须照实写，不能写「覆盖」。

**文案**（`plainLanguage.ts`）

- 新增 `STOCK_PREP_PROJECT_TARGET_PLAIN`，覆盖：三种状态；新建 / 覆盖拉取 / 恢复 / 撤销新建的确认语；行数句式。
- `STOCK_PREP_ERROR_PLAIN`（`:583`）补这些错误码：`…_ABSENT`、`…_DELETED`、`…_LIMIT`、`…_ROWS_IN_BOUND_SHEET`、`…_SHEETS_DISABLED`、`TABLE_ACTION_TARGET_TENANT_*`。
- `projectSync.ts:517` 的错误码分流同步补上。
- 改掉过时的说法：首页 `StockPreparationOperatorHome.vue:62-65`「请按项目号在备料表里找到您的项目」，以及 `:245` 的提示。开关开时改为「每个项目一张备料表」。

**防止数据分家**：只要项目 X 还有**有效**行留在一张没有登记给 X 的表里（只可能是那张 env 旧表），新建 X 就回 409 `…_ROWS_IN_BOUND_SHEET`。检查方式是按项目号的有界读，与 `readExistingStockPreparationRows` 相同（`table-actions.cjs:983-1007`）。

## 5. 项目总览表

**这张表是什么**：插件托管的多维表。

- objectId 为 `plm_stock_preparation_project_overview`，每个租户的 staging 项目一张，键是 `projectNo`，模板放在 `templates.cjs`。
- 字段类型只能用 string / number / boolean / date / select（`templates.cjs:11`），所以表里**结构上不可能**放进明细行。单测断言字段 id ⊆ 下表这一组聚合列。
- 要加进翻译登记表（`table-actions.cjs:1132-1149`）。加入只意味着能做字段翻译，不意味着任何授权。

| 列 | 来源 |
|---|---|
| 项目号 | 登记行 |
| 备料表 | 深链路径（`sheetId` + 填写视图 id） |
| 物料行数 / 有效行数 | 登记行的 `row_count` / `active_row_count`（apply 后写入；溢出时带「超过」） |
| 等您拿主意 | PENDING 计数，`pendingDecisionCountsByProjectNo`（`operator-project-directory.cjs:246`），读账本 `plm_stock_preparation_confirmation_decision`（`templates.cjs:979-983`） |
| 卡住了 | 登记行的 `missing_components_count`：最近一次 dry-run/apply 里不重复的 `missing_child_bom` 数（`table-actions.cjs:123`），和看板算的是同一个数（`StockPreparationProjectBoardView.vue:770-775`） |
| 最近拉取 | `last_pull_at` + `last_pull_outcome` / `last_pull_code`。今天 apply 不写运行日志（086 的动作清单里没有 apply） |
| 状态 | 服务端版的 `stockPrepPosture`（`projectPosture.ts:115-140`）：等您拿主意 / 卡住了 / 可以导出 / 还没拉过，再加「已删除」。和首页四个筛选（`operatorHomeCards.ts:32,178-191`）是同一谓词，配一份跨语言对照测试（先例：web 测试清单里的 `*-vocab-mirror`） |
| 同步时间 | 写入时间 |

**为什么「卡住了」不用 Integration Exceptions**：那张 staging 表按 `pipelineId/runId` 建键，没有项目号（`staging-installer.cjs:82-96`）；`git grep integration_exceptions plugins/plugin-integration-core/lib` 也只命中安装器本身，备料没有任何代码写它。

**谁更新、什么时候更新**

- 插件在这些时刻对单个项目行做 upsert：建表、登记、删除、恢复；dry-run 结束；apply 结束；confirm / reconcile 结束。
- `POST …/project-overview/refresh`（operate 档）按上限重算所有行。
- 06:00 的定时试拉会顺带刷新它点到的项目。
- **不新增后台定时器**。总览写失败绝不让主动作失败：登记表才是权威，总览可以手动刷新来自愈。

**只读（Q5）**

- `system-sheet-predicate.ts:68-72` 新增 `stock_prep_overview` 类型，建表时由宿主盖章（`system_kind` 只由内部 provisioning 写，`:62-67`）。效果：
  - 不能删（`sheet-delete-guard.ts:110`）；
  - 排除在历史连续性检查之外（`:84-91`）；
  - 列表里仍然可见（`:44-60`）。
- 能力钳制参照 `restrictApprovalProjectionCapabilities`（`approval-projection-constants.ts:95-121`），但只留 `canRead` / `canExport`，对所有人生效，含管理员。
- 默认视图过滤掉「已删除」。

**首页切换**

- 开关开着时，一线目录按登记行枚举，再并上归档项目。每行带真实的 `pendingDecisionCount`、`missingComponentsCount`、`pulledRowCount`，所以卡片姿态不再需要 `progressUnknown`（`projectPosture.ts:59-65`）。
- localStorage 只作补充和「最近开过」提示。「从列表移除」仍然只在本机生效（`operatorHomeMemory.ts:162-185`），不受影响。

## 6. 删除与恢复

**路由**：`POST …/projects/:projectNo/target/delete`，请求体 `{confirmProjectNo}`，必须和路径里的项目号一致；`POST …/target/restore`。

- **门**：Q2 的默认。一线的「撤销新建」只在三个条件同时成立时可用：`created_by` 等于本人、行数为 0、来源为 provisioned。
- **旧表不能删**：`origin='bound_legacy'` 的表回 409 `PROJECT_TARGET_LEGACY_BOUND`。它仍然是 env 目标表，删了以后一旦关开关就会坏。

**宿主缺两个口**

- 插件作用域的 provisioning 现在**没有**删除 / 恢复方法（`plugin-scope.ts:298-620` 只到 `deleteRecord`）。
- 插件 db 也写不了 `meta_sheets`（`db.cjs:25`）。
- 宿主的 `DELETE /sheets` 拒绝托管表；`POST /sheets/:id/restore` 走的是表结构权限（`univer-meta.ts:16259-16260`），备料管理员不一定有。

所以要补最小的一对 port：`softDeleteObjectSheet` / `restoreObjectSheet({projectId, objectId})`。

- 先 `assertPluginOwnsSheet`，表 id 由派生得出。
- SQL 和副作用与现有路由完全相同：删除 `UPDATE … SET deleted_at = now()` 并加链接围栏（`:16201-16213`）；恢复 `fenceWriterEntry` + `deleted_at = NULL`（`:16264-16280`）。
- 只认插件自己的表，不新增别的权力。

**删除的效果**

- 表被软删。宿主对软删表的所有按表路径都拒绝（`univer-meta.ts:16255-16258`），所以还在跑的 apply 会失败关闭。插件写路径也必须拒绝，S4 用真库用例证明。
- 登记行改为 deleted，写 `deleted_by/at`。
- 总览行显示「已删除」，默认隐藏。
- 写审计 `project_target_delete`，`project_id = projectNo`（与导出同口径，`http-routes.cjs:9025-9028`）。
- 账本、交接游标、明细行**原样保留**。
- 登记行的意图和表的存活状态不一致时，GET 如实报告，**不**静默修复。

**恢复的效果**：登记行改回 active，写 `restored_by/at`，写审计，再进入覆盖拉取流程。

**保留期**：本 ADR 里永不硬删，没有清理任务。表回收站照旧不显示托管表（`univer-meta.ts:8349`），恢复只能走这里。

**两个按钮的文案要区分**：「从列表移除（只在这台电脑上，不删数据）」和「删除项目（管理员操作，可以恢复）」。

## 7. 行数提示

- **现在有的**
  - 看板「表里有多少行」：`StockPreparationProjectBoardView.vue:192-195`，文字在 `:884-898`。
  - 表格工具栏「N 行」：`MetaToolbar.vue:187`，取的是 `grid.page.value.total`（`MultitableWorkbench.vue:251`），文字来自 `meta-core-labels.ts:326-329`。它显示的是**当前视图**过滤后的数量；填写视图只显示有效行（`target-provisioning.cjs:628-631`），所以和 All Records 的数不一样。这正是「共多少行」让人困惑的原因。
- **要加的**
  - 首页卡片：「共 N 行（有效 M 行）」，数据来自目录行；
  - 总览的两列；
  - 「项目接入」结果行：接在 `StockPreparationProjectSyncPanel.vue:662` 那句后面，加「表里现在共 N 行」；
  - 覆盖拉取的确认框。
  - 工具栏不改，tooltip 补一句「这是当前视图的行数」（`plainLanguage.ts:1194`）。

## 8. 开关、迁移与上线

- **开关**：`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`。
  - 只认精确字符串 `'true'`：不去空格，不忽略大小写；每次请求时读取。
  - 登记到 `scripts/ops/global-history-flag-manifest.mjs`：`type: 'boolean'`、`danger: 'high'`（会建表，也会改变写入去向）。写法参照 relabel 条目 `:662-672`。
  - 所有后端进程必须取同一个值。
- **开关关着**：§3 列的内容逐字节不变；新路由回 DISABLED，唯一的例外是 register-bound。
- **从开切回关**：路由回到 env 那张表；项目表和数据都在，但首页看不到它们。重新打开就恢复原样。
- **迁移**：087 建表、088 扩审计动作。S3 / S4 的宿主改动不需要迁移（`system_kind` 列已经有了）。
- **版本安排**
  - R63：只带 S1，开关关闭，迁移随包执行。
  - R64：带 S2 + S4，是否开开关由 owner 决定。
  - S3：R64 或 R65。
- **演示机操作员的步骤**
  1. 备份，升级，迁移，开关保持关闭；
  2. owner 定下 Q3 后清理旧混合表（暂停「记录删除时」类自动化，0924 §1）；
  3. 以 `stock-prep:admin` 身份跑 register-bound 的试算，核对结果，再执行；
  4. 在 `app.env` 写入开关，重启；
  5. 只读核对：GET target 的行数要和表格 All Records 一致；
  6. 通知客户：自动化、提醒、自建视图都是按表配置的，新项目表不会自动带过去。

## 9. 不在本 ADR 范围内

- 按人划分项目归属：`design-project-ownership-20260906`。登记行里的 `created_by` 只是事实，不用来授权。将来如果采用认领制（C），登记行就是认领的载体，新建路由就是守门点。这与该稿「守门点 ⊇ 认领点」的结论一致。
- K3 相关的任何事。
- 硬删除。
- 生产写入门的配置加载器。
- 把旧混合表里其他项目的人工列迁走。
- 复制自动化和视图。
- workspace 维度。

## 10. 切片

| 切片 | 改动文件 | 测试 | 模型 / 验证 | 登记册 |
|---|---|---|---|---|
| **S1** 登记 + 建表 + 路由解析 + 开关 | migrations 087/088；新增 `stock-preparation-project-target-store.cjs`、`stock-preparation-project-targets.cjs`；改 `table-actions.cjs`（叠加解析、写入门）、`target-provisioning.cjs`、`own-base.cjs`、`http-routes.cjs`、`preflight.cjs`、`index.cjs`、scheduled-pull 脚本、flag manifest、`scripts/test-chain.txt` | 单测用内存假库（`stock-preparation-handoff.test.cjs:164` 的 `makeMemoryDb`）：23505 并发、开关关时逐字节快照、写入门四个条件逐个缺失、各路由的墙与 409、`getTableAction` 源码守卫；同步改 `tenant-scoped-write-guard` 的固定清单（`:330,444`）、`operator-pull-gate` 的固定清单、`audit-migration`（最高号迁移生效）。真库：放进已接线的 `stock-prep-w2-scoped-repair-realdb.test.ts`（`plugin-tests.yml:1419`）——两个项目两张表、都已认领、软删后 ensure 抛错 | 保障类：opus 实现，Fable/opus 对抗验证 | **R-33**：一项目一表登记 + 开关 + 一线建表作为 R-11 的例外（Q1 / Q6） |
| **S2** 一线交互 | `OperatorHome.vue`、`ProjectBoardView.vue`、`ProjectSyncPanel.vue`；新增 `projectTarget.ts`；改 `plainLanguage.ts`、`operatorHomeCards.ts`、`projectSync.ts` | web spec。注意：`StockPreparationOperatorHome`、`ProjectBoard`、`ProjectSync` 三个 spec **目前不在**必跑清单里（`integration-guard-run-web-specs.sh:152-167`），要按「过滤词唯一」的规则加进去 | sonnet 实现，opus 复核 | **R-34**：先建后预览、覆盖拉取 = 幂等重拉、行数提示（Q4） |
| **S3** 总览表 | 总览模板、新增 `stock-preparation-project-overview.cjs`、refresh 路由及各处挂点；宿主：`system-sheet-predicate.ts`、provisioning 盖章选项、能力钳制 | 单测：投影、姿态对照；web 对照 spec；真库：非管理员写被拒、插件写成功 | 保障类：opus，Fable 验证 | **R-35**：总览宿主级只读（Q5） |
| **S4** 删除与恢复 | 宿主 `plugin-scope.ts` + `provisioning.ts` 两个 port；插件的 delete / restore 路由 | 真库：删除后看板 / 导出 / apply / 插件写都被拒，恢复后可用，回收站仍不显示；单测：各层级、旧表不可删、撤销新建的条件 | 保障类：opus，Fable 验证 | **R-36**：删改权限、永久保留、旧表不可删（Q2） |

**另外一处**：导出租户墙的真库文件 `stock-preparation-prep-line-export-tenant-wall-realdb.test.ts` 存在，但没有接进任何 workflow（`.github` 里 0 处引用）。建议 S1 把它一起接上，因为墙现在作用在项目表上了。
