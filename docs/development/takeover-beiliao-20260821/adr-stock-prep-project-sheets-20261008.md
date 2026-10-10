# 备料：一个项目一张备料表 —— 项目登记、拉取人员建表、总览表、归档与恢复、应用内角色（ADR 2026-10-08）

> **状态**：草稿 v2（已并入 owner 2026-10-08 裁决）。owner 2026-10-08 先回复「同意」批准按此方向起草，随后批准按其裁决修订并新增 §11。标「按建议默认，owner 可否决」的三项不是 owner 逐条裁决。
> **基线**：origin/main `9eee3a3cd`（`9eee3a3cd0e734f6a4abb972068f4f535eb08ebf`）。所有行号都用 `git show origin/main:<path>` 核过。v2 修订当天本机 `git fetch` 不通，本机 origin/main 仍是 `9eee3a3cd`，基线不变；合并前若 main 已前进，按章程 rebase 后重核行号。
> **values-free**：不含主机、地址、口令、凭据、真实项目号、物料名；项目号一律写 `<项目号>`。
> **关联**：#5860/#5868（一表一项目守卫）、`customer-anomaly-triage-20260924.md` §1/§1b、`design-project-ownership-20260906.md`（未 ratify）、R-11、D1=B（`222-deploy-window-runbook-20260901.md` §0.6）、附录 `adr-stock-prep-project-sheets-20261008-addendum-a-d.md`（A–D 的代码依据，下文写「附录 A.3」等）。
> **来源**：客户反馈 2026-09-24 #1b 与 2026-10-08（《异常情况（20261008-多维表-改）》第 2、3 条及 owner 当日补充）；owner 2026-10-08 裁决。

**裁决记录（owner 2026-10-08）**

| # | 问题 | 裁决 | 落在哪里 |
|---|---|---|---|
| Q1 | 谁能拉取、新建项目表 | 只有「拉取人员」：新码 `stock-prep:pull`，须同时持有 `operate`+`read`；`stock-prep:admin` 和平台管理员的短路不变。一线不能拉取，推翻 `workbench-access.cjs:227` 的旧裁决 | §2、§4、§10 S0、§11 |
| Q2 | 删除与恢复 | 归档代替删除，不软删也不硬删；归档 / 恢复归拉取人员 | §1.2、§6、§10 S4 |
| Q3 | 旧混表 `bom备料<项目号>` | 「不要了」：不登记、不迁移、不删除。env `action.target` 仍须保留，代码只读它的值；删掉 register-bound 和 `…_ROWS_IN_BOUND_SHEET`；首页「打开备料多维表」按钮和目录扫描改读登记行；开关开时 conflict-policies 缺 `projectNo` 回 400；关开关 = 停用拉取 | §3、§3.1、§8 |
| Q4 | 没拉过时先建表还是先预览 | 先建空表再预览；「撤销新建」删掉，用归档代替 | §4 |
| Q5 | 总览 | 宿主级只读 + O1（每行深链到该项目的「待填写」视图）+ O2(a)（负责人 / 备注 / 计划完成存登记表、经插件路由修改、投影到总览）；新增「采购未完成 / 仓库未完成」两列和「截至 hh:mm」；不做 O3 | §1.2、§2、§5、§9 |
| Q6 | 新项目表的写入授权 | 继承部署已有的沙箱放行 | §3「写入门」 |
| Q7 | 新项目表的表级授权（附录 A.6） | G1：窄宿主 port，建表时给服务端配置的角色授 `spreadsheet:write`；只对插件自有项目表、只写 role 主体、只增不删、写审计 | §2、§10 S1 |
| §11 | 应用内角色与委托管理 | 批准：四个内置角色（迁移播种为模板）+ 主管理员委托管理 + 自定义角色，分两步落地 | §11、§10 S0/S5 |

**按建议默认，owner 可否决**（未经逐条裁决；照章程 24h 内可否决）

| # | 默认 | 落在哪里 |
|---|---|---|
| (i) | 一线保留确认「等您拿主意」和交接推进，另保留导出、看板、项目查询。确认和交接在 `/stock-prep` 工作台、不在多维表；字面的「一线只在多维表里填写」会把它们也拿走，而被扣住的行不裁决就不会写入（附录 A.4） | §11.3 |
| (ii) | 归档的表仍出现在多维表左侧的表列表里，对有授权的人可见。v1 接受，作为已知代价 | §6 |
| (iii) | Q8：项目查询里旧的「归档过」来源改名「平台登记」，让新的生命周期独占「已归档」 | §5、§10 S2 |

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
  - 能删除项目数据，并且可以恢复（→ Q2：归档代替删除）；
  - 拉取时，已拉过的项目给「直接打开 / 覆盖拉取」，没拉过的自动新建并拉取；
  - 能看到有多少个项目、每个项目还剩多少活；
  - 项目表里显示一共多少行；
  - 一线只填写，拉取由专人做（→ Q1）；备料作为应用自己管角色和成员（→ §11）。

**本 ADR 的决定**

一个业务项目对应一张受管备料表。由服务端登记表做「项目号 → 表」的唯一权威。每条读写路由都按项目号解析到这张表。只有拉取人员能拉取和建表；旧混表不登记；删除由归档代替。全部新行为放在一个默认关闭的开关后面，唯一的例外是 S0 的拉取门（§8）。

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
  status TEXT CHECK (status IN ('active','archived')),
  created_by, created_at, archived_by, archived_at, restored_by, restored_at, updated_at,
  responsible_label TEXT, note TEXT, planned_finish_on DATE, project_fields_updated_by, project_fields_updated_at,  -- O2(a)
  last_pull_at, last_pull_outcome CHECK IN ('applied','previewed','refused'), last_pull_code TEXT,  -- 封闭错误码，不是值
  row_count INT, active_row_count INT, counts_bounded BOOL, missing_components_count INT,
  procurement_open_count INT, warehouse_open_count INT, counts_at
UNIQUE (tenant_id, project_no);  UNIQUE (sheet_id);  CHECK ((status='archived') = (archived_at IS NOT NULL))
```

- **没有 `origin` 列**：旧混表不登记（Q3），每条登记行都是插件新建的表。
- **没有 workspace 维度**，与 084 交接表同理（`stock-preparation-handoff-store.cjs:37-38`）。
- **`project_no` 是导航句柄**，和审计表的 `project_id`、084 表的 `project_no` 同一个口径（`handoff-store.cjs:27-31`）。
- **项目级列（O2(a)）**：`responsible_label` 是自由文本、不是用户 id，**不**作授权依据（§9）；审计只记改了哪一列，不记值。
- **088 的写法**：照 086 的方式把审计动作全量重列（`086…sql`），新增 `project_target_create` / `_archive` / `_restore` / `_grant`、`project_fields_update`、`project_overview_refresh` 六个。一次性列全，免得 S3 / S4 再重列一次。
- **编号说明**：未 ratify 的归属草稿也写过 `087/088`（`design-project-ownership-20260906.md:451`）。哪个先合入就用哪个号。

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
- **「待填写」视图（O1）**：建表时再建一张视图，条件是有效行且（采购完成不为真或仓库完成不为真），两个布尔列见 `templates.cjs:840,842`。用 `ensureView`（`plugin-scope.ts:526`），照填写视图的先例（`target-provisioning.cjs:647-689`）。总览每行深链到它。
- **放在哪个 base**：和确认账本同一个 base。
  - 做法：把项目表族加为账本的**单向**锚定伙伴（改 `stock-preparation-own-base.cjs:165-169`；配对定义在 `:118-121`）。现有围栏照旧生效：只接受 `base_legacy` 或插件系统 base，其余 409（`:38-52`）。
  - 没有账本时，按 #5702 派生自己的 base（`:242-250`）。
- **客户包（customer pack）**：如果部署给 env 里的旧 objectId 装过包（ledger 076 按 `(tenant, project_id, object_id, pack_id)` 建键，`076…sql:19-20`），新建时要把同一个包重装到新 objectId 上：ext_ 列、选项集、角色视图、列写权。安装器按 `pack.targetObjectId` 工作（`customer-pack-installer.cjs:267-670`）。
  - **原因**：`ensureObject` 建不出 ext_ 列（`target-provisioning.cjs:735-741`）。不重装的话，第一次 dry-run 就会被 `assertTargetFieldsExist` 回 422（`table-actions.cjs:713-785`）。
- **登记表存什么**：只存 `sheet_id` 和 `object_id`。字段映射每次请求时用 `provisioning.resolveFieldIds` 现算；这个调用只做计算、不查库（见 `target-provisioning.cjs:368-372` 的说明）。
- **谁能建（Q1）**：拉取人员。新路由 `POST …/projects/:projectNo/target`，门 `requireAccess(req, STOCK_PREP_PULL)`（S0 新增的档；层级见 `workbench-access.cjs:399-408`）。
  - 这是 R-11「stock-prep 档不开 provisioning」（`http-routes.cjs:231-236`；admin 码的描述也写着 no provisioning，`workbench-access.cjs:85`）的具名例外，记入 R-35。限制：只能从「拉取」入口进；只能用冻结模板；objectId 和表 id 都由服务端派生；每个租户最多 200 条登记行（含已归档，§6）；每次都写审计。
  - 模块里 `permission:'admin'` 的检查（`target-provisioning.cjs:151-160`）是服务端能力常量，由路由传入，与调用人层级无关。
  - 请求体是空的封闭白名单，不接受 base、名字、字段。
- **建表后授权（Q7 = G1）**：今天插件的 provisioning 端口没有任何授权动词（`plugin-scope.ts:347-565`），看板路由也写明插件「没有用户感知的 ACL 接缝」（`http-routes.cjs:9790-9794`）。不补的话，拉取人员建表成功，一线点「打开」得到 403（附录 A.6）。新增一个窄宿主 port，先例是 `services/stock-preparation-field-permissions.ts:1-42`：
  - 先 `assertPluginOwnsSheet`；objectId 必须匹配项目表的正则（§3「写入门」）；
  - 主体只能是 role。角色清单来自服务端配置，每个 id 还必须满足 `roleIdMatchesNamespace(id, 'stock-prep')`（`namespace-admission.ts:110-115`），不存在的角色拒绝；
  - 权限级别写死 `spreadsheet:write`。不能给 read：表上一出现授权行就切到交集模式，给 read 会让一线录不了值（frontline plan `:95`）；
  - 只增不删（`ON CONFLICT DO NOTHING`）；写审计 `project_target_grant`（记角色 id 和表 id）；
  - 配置建议：新 env 登记进 flag manifest，缺省为空 = 不授权，退回 G2（管理员在「权限」里逐表手工授，`univer-meta.ts:9797-9816`）；演示机配成 §11.3 的内置角色。
  - 已知代价：表级 `spreadsheet:write` 同时打开这张表的字段和视图管理（`permission-service.ts:1547-1566`，经 `:1798` 生效）。今天演示机一线在旧表上持有的正是这一级（frontline plan `:66-70`），所以不是新敞口；见 §11.7。

## 3. 路由按项目号解析

**统一接缝**：`getTableAction(input)` 新增 `projectNo` 参数，在 `applyPersistedSourceBinding`（`table-actions.cjs:889-909`）之后叠加 `applyProjectTarget`。解析逻辑：

| 登记行状态 | 写路由 | 读路由 |
|---|---|---|
| active | 返回 `{sheetId, objectId, keyField:'idempotencyKey', fieldIdMap}` | 同左 |
| archived | 409 `STOCK_PREPARATION_PROJECT_ARCHIVED`（不改账本，不发钉钉） | 照常解析到这张表，只读可用（§6） |
| 不存在 | 409 `…_ABSENT` | 走该路由原有的「找不到」分支，不新增存在性探测口 |

**防止漏传**：开关开着时，`http-routes.cjs` 里每个 `getTableAction(` 调用都必须带 `projectNo`，或者显式带 `targetPurpose:'readiness'`；只取 source 的 4 个调用点（`:5023,7093,8526,8621`）显式带 `targetPurpose:'source'`，否则守卫会变红，或被迫错用 `readiness`。加一条源码扫描守卫钉住这一点（形制照 `stock-preparation-tenant-scoped-write-guard.test.cjs:330,444`）。这样漏改一个调用点就会在 CI 上变红。

| 路由 | 今天取目标的位置 | 开关开后怎么解析项目 |
|---|---|---|
| dry-run | `http-routes.cjs:6105` | `body.parameters.projectNo` |
| apply | `:6496` | 同上；另见下面的门 |
| reconcile | `:6263` | 同上 |
| mvp-persist | `:6382` | 同上 |
| 大 BOM expansion-start | `:6566` | 同上；目标进入 `job.actionSnapshot` |
| 大 BOM plan / apply-start / apply-run | `:6698`、`:6788`、`:6868` | 用快照（逐字节相同）；apply-run 另外复查登记行，已归档就 409 |
| conflict-policies 增删查 | `:6930/6940/6952`；策略按 target 建键（`conflict-policies.cjs:72-94`） | 新增 `?projectNo=`。开关开时缺省回 400 `STOCK_PREPARATION_PROJECT_NO_REQUIRED`，不再走旧表；开关关时照旧 |
| 结转 carry/confirm | `:8175`，墙 `:8196-8203` | 从 `decision.idempotencyKey` 解析项目号，与 `confirm-writes.cjs:1055-1077` 用同一套解析；已归档就 409 |
| 导出 prep-lines/export | `:8989-9021` | query 里的 `projectNo`；已归档照常 |
| 一线目录 | `:9138-9157` | 改为按登记行枚举，见 §5；并集扫描和 `fillTarget`（`operator-project-directory.cjs:468-486,512`）不再读 env 表 |
| 首页「打开备料多维表」 | `StockPreparationOperatorHome.vue:49-66`（数据是上一行的 `fillTarget`） | 不再指向旧表，改为每张卡片按项目深链 |
| 看板 projects/:projectNo/board | `:9828-9847` | 路径里的项目号；填写视图句柄要用登记行的 objectId（`pull-target-scan.cjs:76,402-410` 目前写死 canonical） |
| 交接 advance | `:9546-9580` | 请求体里的项目号；已归档就 409 |
| 交接 status | `:9221`（不取目标） | 不变 |
| source-preflight | `:7093`（只读数据源） | 不变，带 `targetPurpose:'source'` |
| 部署预检 | `:6975-6999` | 新增 values-free 小节：开关状态、登记行数量（含已归档） |
| 定时试拉 | `scripts/ops/stock-preparation-scheduled-pull.mjs`（默认只试算，`:25-29`；`--apply` 见 `:148-149`） | 服务端不需要改；脚本把 `…_ABSENT` 和 `…_ARCHIVED` 归为「跳过」（`:156-157`），不当失败。它**绝不**建表 |
| 实时桥 | `git grep -c realtime plugins/plugin-integration-core/lib` = 0 | 不存在，不涉及 |

### 3.1 旧混表（Q3：不要了）

- **不登记、不迁移、不删除**。界面上本来也删不掉（`univer-meta.ts:16199-16200`）。它还是关开关后唯一的回退目标（§8）。
- **env 里仍然不能删的部分**（三处都只读值，不读旧表内容，所以旧表原样放着即可）：
  - 动作 JSON 必须仍带 `target.sheetId`：`normalizeTarget` 要求它（`table-actions.cjs:190-200`，具体在 `:195`），而且在构造注册表时就规整（`:884-885`、`:475`）。缺了它整个动作回 422 `TABLE_ACTION_CONFIG_INVALID`，`source`（`:474`）一起失效，受影响的有 source-preflight、数据源绑定、集成总览（`http-routes.cjs:7093,8526,8621,5023`）。
  - 写入门的第 4 条读 env 里的 `target.objectId`（§3「写入门」）。
  - 客户包重装要知道旧 objectId 装过哪个包（§2）。
- **开关开时必须切离旧表的读点**：目录并集扫描和首页按钮（上表两行）；看板的 boundTarget（`http-routes.cjs:9826-9836`）、导出（`:8990`）、交接推进的探针（`:9547`）、结转（`:8175`）按上表解析；conflict-policies 缺 `projectNo` 回 400。
- **删掉的设计**：v1 的 register-bound 路由（一次性登记旧表）和 `…_ROWS_IN_BOUND_SHEET`（旧表里还有某项目的有效行就拒绝为它建新表）。后者会让「不要了」的旧表继续挡新项目。
- **运维动作**（§8）：撤销一线在旧表上的授权、暂停挂在旧表上的自动化、告诉客户旧表里已填的人工列不会带进新表。

**租户墙**

- `assertStockPreparationTargetBelongsToTenant`（`http-routes.cjs:829-857`）和它现有的三套措辞（`:863-879`）**逐字节不动**，只是现在作用在解析出来的这张项目表上。
- 项目表由 `ensureObject` 认领进对象注册表（`sheet-delete-guard.ts:15-21`），判定为 OWNED。
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

**开关关闭时逐字节不变的部分**：`getTableAction` 的输出、所有现有路由的响应和审计、三套墙、写入门、目录响应（新增键只在开关开时出现）。**例外**：S0 的拉取门不跟开关走（§8、R-33）。

**另一个后果**：#5860 的守卫保留不动。每张表只装一个项目，它就不会再挡新项目；它仍然负责挡旧混表和误绑，所以关开关后旧表上的拉取会被它拒绝（§8）。

## 4. 拉取交互（首页「拉一个新项目」和「项目接入」面板）

**API**：`GET /api/integration/stock-preparation/projects/:projectNo/target`

- 门和租户推导与看板相同（`http-routes.cjs:9797` + scope），即 OPERATE，一线也能读状态。
- 开关关着时回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`，不做任何 IO。

```
{ status: 'absent'|'active'|'archived', sheetId, viewId, todoViewId, rowCount, activeRowCount, rowCountBounded,
  lastPulledAt, lastPullOutcome, archivedAt, may: { create, archive, restore } }
```

- `may` 的三项都按 PULL 档计算（S0）；没有拉取权的人三项全为 false。
- 行数用 `readPullTargetRowFacts` 在这张项目表里数（`pull-target-scan.cjs:622-635`）。超过上限时 `rowCountBounded=true`，界面显示「超过 N 行」。
- `sheetId` / `viewId` / `todoViewId` 是深链句柄，和看板今天返回的一样。

**交互流程**

| 状态 | 按钮 | 步骤 |
|---|---|---|
| absent | 有拉取权：「新建备料表并拉取」；没有：「这个项目还没建表，请联系拉取人员」 | 确认框「将为 <项目号> 新建一张备料表」→ `POST …/target`（201 新建 / 200 已存在；随后 G1 授权）→ dry-run → 预览「将写入 N 行」→ 确认 → apply → 结果行显示总行数。取消的话保留 0 行空表，状态「还没拉过」（Q4）；不需要的空表由拉取人员归档，**没有**「撤销新建」 |
| active | 「直接打开」（OPERATE 都有）/「覆盖拉取」（只有拉取权） | 打开：用 `sheetId` / `viewId` 深链进填写视图。覆盖拉取：确认框「表里现在共 N 行（有效 M 行）。重新拉取只更新从 PLM 来的列，您填的列保留，PLM 已删掉的行会标成无效」→ 走现有的 dry-run/apply |
| archived | 「打开」（行上标「已归档」）/「恢复并重新拉取」（只有拉取权） | `POST …/target/restore` → 进入覆盖拉取流程。没有拉取权的人看到「请联系拉取人员恢复」。**不会**新建第二张表：表 id 是确定性派生的，归档又不动表本身 |

**「覆盖拉取」的真实语义**：它就是现有的幂等重拉。PLM 带来的列会更新，人填的列保留，PLM 已删掉的行按 `mark_inactive` 标为无效（`table-actions.cjs:1012-1016`）。**它不会清表**。文案必须照实写，不能写「覆盖」。

**文案**（`plainLanguage.ts`）

- 新增 `STOCK_PREP_PROJECT_TARGET_PLAIN`，覆盖：三种状态；新建 / 覆盖拉取 / 归档 / 恢复的确认语；「请联系拉取人员」；行数句式。
- `STOCK_PREP_ERROR_PLAIN`（`:583`）补这些错误码：`…_ABSENT`、`…_ARCHIVED`、`…_LIMIT`、`…_PROJECT_NO_REQUIRED`、`…_SHEETS_DISABLED`、`TABLE_ACTION_TARGET_TENANT_*`。
- `projectSync.ts:517` 的错误码分流同步补上。
- 看板的空状态不能指向用户没有的按钮（`StockPreparationProjectBoardView.vue:786-788`）：没有拉取权的人显示「请联系拉取人员」。
- 改掉过时的说法：首页 `StockPreparationOperatorHome.vue:62-65`「请按项目号在备料表里找到您的项目」，以及 `:245` 的提示。开关开时改为「每个项目一张备料表」。

## 5. 项目总览表（Q5：宿主级只读 + O1 + O2(a)）

**这张表是什么**：插件托管的多维表。

- objectId 为 `plm_stock_preparation_project_overview`，每个租户的 staging 项目一张，键是 `projectNo`，模板放在 `templates.cjs`。
- 字段类型只能用 string / number / boolean / date / select（`templates.cjs:11`），所以表里**结构上不可能**放进明细行。单测断言字段 id ⊆ 下表这一组聚合列。
- 要加进翻译登记表（`table-actions.cjs:1132-1149`）。加入只意味着能做字段翻译，不意味着任何授权。

| 列 | 来源 |
|---|---|
| 项目号 | 登记行 |
| 备料表 | 深链：`sheetId` + 「待填写」视图 id（O1，§2） |
| 负责人 / 备注 / 计划完成 | 登记行的项目级列（O2(a)），只能经下面的插件路由修改 |
| 物料行数 / 有效行数 | 登记行的 `row_count` / `active_row_count`（apply 后写入；溢出时带「超过」） |
| 采购未完成 / 仓库未完成 | 有效行里 `procurementDone` / `warehouseDone` 不为真的行数（`templates.cjs:840,842`）。不用「备料状态」：它的选项来自客户配置（`templates.cjs:775-778`） |
| 等您拿主意 | PENDING 计数，`pendingDecisionCountsByProjectNo`（`operator-project-directory.cjs:246`），读账本 `plm_stock_preparation_confirmation_decision`（`templates.cjs:979-983`） |
| 卡住了 | 登记行的 `missing_components_count`：最近一次 dry-run/apply 里不重复的 `missing_child_bom` 数（`table-actions.cjs:123`），和看板算的是同一个数（`StockPreparationProjectBoardView.vue:770-775`） |
| 最近拉取 | `last_pull_at` + `last_pull_outcome` / `last_pull_code`。今天 apply 不写运行日志（086 的动作清单里没有 apply） |
| 状态 | 服务端版的 `stockPrepPosture`（`projectPosture.ts:115-140`）：等您拿主意 / 卡住了 / 可以导出 / 还没拉过，再加「已归档」，且「已归档」优先。和首页四个筛选（`operatorHomeCards.ts:32,178-191`）是同一谓词，配一份跨语言对照测试（先例：web 测试清单里的 `*-vocab-mirror`） |
| 截至 | `counts_at`，界面显示「截至 hh:mm」。没有行编辑事件（附录 B.3），行数和两列未完成数只在下面列的时刻有界重算 |

**为什么「卡住了」不用 Integration Exceptions**：那张 staging 表按 `pipelineId/runId` 建键，没有项目号（`staging-installer.cjs:82-96`）；`git grep integration_exceptions plugins/plugin-integration-core/lib` 也只命中安装器本身，备料没有任何代码写它。

**一线的编辑只发生在项目表里**：项目表是唯一的数据源，总览上的数字是投影，所以没有「同步」这一步。不做 O3（跨项目「待处理行」表双向写回）：没有行事件触发点、会多出一个并发写入者、撞上一表一项目守卫、绕过表级授权和写校验（附录 B.4）。

**项目级列（O2(a)）**：`PATCH …/projects/:projectNo/target/project-fields`，请求体是封闭白名单 `{responsibleLabel?, note?, plannedFinishOn?}`（带长度上限）；门 OPERATE（附录 B.4）；已归档回 409；写审计 `project_fields_update`，只记改了哪一列。在项目查询或首页卡片上编辑，投影到总览只读。这些列**不**同步到物料行。

**谁更新、什么时候更新**

- 插件在这些时刻对单个项目行做 upsert：建表、归档、恢复、项目级列修改；dry-run 结束；apply 结束；confirm / reconcile 结束。
- `POST …/project-overview/refresh`（OPERATE 档）按上限重算所有行，含两列未完成数。
- 06:00 的定时试拉会顺带刷新它点到的项目。
- **不新增后台定时器**。总览写失败绝不让主动作失败：登记表才是权威，总览可以手动刷新来自愈。

**只读（Q5）**

- `system-sheet-predicate.ts:68-72` 新增 `stock_prep_overview` 类型，建表时由宿主盖章（`system_kind` 只由内部 provisioning 写，`:62-67`）。效果：
  - 不能删（`sheet-delete-guard.ts:110`）；
  - 排除在历史连续性检查之外（`:84-91`）；
  - 列表里仍然可见（`:44-60`）。
- 能力钳制参照 `restrictApprovalProjectionCapabilities`（`approval-projection-constants.ts:95-121`），但只留 `canRead` / `canExport`，对所有人生效，含管理员。
- 两张视图：默认「进行中」（状态 ≠ 已归档）和「已归档」。一个网格视图画不出「主列表 + 下方分区」。

**首页与项目查询**

- 开关开着时，一线目录按登记行枚举，再并上「平台登记」项目（旧的 `mvp` 来源）。每行带真实的 `pendingDecisionCount`、`missingComponentsCount`、`pulledRowCount`，所以卡片姿态不再需要 `progressUnknown`（`projectPosture.ts:59-65`）。
- 首页：卡片主列表排除已归档，下方一个折叠区「已归档（N）」。
- 项目查询：行上加「已归档」标签，另加独立开关「含已归档」，默认打开。不要加进状态键：项目查询的状态键就是首页那组（`projectQuery.ts:50`），改了会连带改首页的筛选按钮。
- localStorage 只作补充和「最近开过」提示。「从列表移除」仍然只在本机生效（`operatorHomeMemory.ts:162-185`），不受影响。
- **Q8 改名（默认 (iii)）**：「归档过 / Archived」出现在 `StockPreparationProjectQueryView.vue:512,562-563`、`projectQuery.ts:40,57`、首页提示 `StockPreparationOperatorHome.vue:245`、`plainLanguage.ts:1226`，界面词改为「平台登记」；代码里的 `mvp` 标识不动，新状态在代码里叫 `archived`。

## 6. 归档与恢复（Q2：归档代替删除）

**路由**：`POST …/projects/:projectNo/target/archive`，请求体 `{confirmProjectNo}`，必须和路径里的项目号一致；`POST …/target/restore`。门都是 PULL（含 `stock-prep:admin` 和平台管理员）。

**归档做什么**

- 登记行改为 `archived`，写 `archived_by/at`；写审计 `project_target_archive`，`project_id = projectNo`（与导出同口径，`http-routes.cjs:9025-9028`）。
- **表本身不动**：不软删、不动授权、不改名。账本、交接游标、明细行原样保留。
- 所以不需要新的宿主 port，v1 里「软删的旧行仍占着表 id，`ensureSheet` 会抛错」（`provisioning.ts:481-500`）的冲突也不存在。
- 总览行显示「已归档」，移到「已归档」视图。
- 不能用软删实现：表一旦软删，宿主所有按表的路径都拒绝（`univer-meta.ts:16255-16258`），一线就看不到归档的表了。

**恢复做什么**：登记行改回 `active`，写 `restored_by/at` 和审计 `project_target_restore`，再进入覆盖拉取流程。

**200 张上限**：按登记行总数算（含已归档），因为归档的表仍然是活表。

**归档后各路由的行为**

| 路由 | 归档后 |
|---|---|
| 建表、dry-run、apply、大 BOM、reconcile、mvp-persist | 409 `STOCK_PREPARATION_PROJECT_ARCHIVED`；GET target 返回 `status:'archived'` 和 `may.restore` |
| confirm 裁决、交接推进、项目级列修改 | 同一个 409（不改账本，不发钉钉） |
| 看板、导出、交接状态、录入值回读 | 照常可用（只读） |
| 定时试拉 | 当作「跳过」，和 ABSENT 一样 |
| 多维表网格 | **不受影响**：宿主不知道「归档」，原来能写的人仍然能写。要让网格只读就得撤销或降级授权，v1 不做 |

**一线能不能看到归档的表**：归档不动授权，原来谁能读这张表，归档后照样能读。列表层面目录本来就按租户划界（`operator-project-directory.cjs:34-39`），一线在项目查询里能看到本租户所有归档项目的号和名；能不能打开由表级授权决定（`http-routes.cjs:9790-9794`）。`created_by` 只是记录的事实，不用来授权（§9）。

**已知代价（默认 (ii)，owner 可否决）**：归档的表仍出现在多维表左侧的表列表里，对有授权的人可见；0924 #1b 说的「删不掉」在多维表那一侧不会消失。宿主没有「隐藏表」开关：`meta_sheets` 只有 `deleted_at`（`db/types.ts:628-636`），列表里会隐藏的只有 People 目录表（`system-sheet-predicate.ts:55-60`）。要真正消失只能软删（和「一线可看归档表」矛盾），或给宿主加隐藏标记（新的宿主改动，§9 不做）。

**保留期**：永不删除，没有清理任务。表回收站照旧不显示托管表（`univer-meta.ts:8349`）。

**两个按钮的文案要区分**：「从列表移除（只在这台电脑上，不删数据）」和「归档项目（拉取人员操作，可以恢复）」。

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
  - 登记到 `scripts/ops/global-history-flag-manifest.mjs`：`type: 'boolean'`、`danger: 'high'`（会建表，也会改变写入去向）。写法参照 relabel 条目 `:662-672`。G1 的角色清单（§2）同样登记。
  - 所有后端进程必须取同一个值。
- **开关关着**：§3 列的内容逐字节不变；新路由一律回 DISABLED（v1 的 register-bound 例外已删除）。
- **拉取门不跟开关走（S0）**：升级即生效，一线马上失去拉取。这和「开关关着时逐字节不变」不一致，是有意的：owner 2026-10-08 裁决推翻了 `workbench-access.cjs:227` 的旧裁决，记入 R-33。
- **从开切回关**（附录 D.3）：所有路由回到 env 旧表。旧表混着多个项目，#5860 守卫会对其余项目回 409（`table-actions.cjs:1090-1100`）。所以**关开关 = 停用拉取**，不是回到旧行为。项目表和数据都在，但首页看不到它们；重新打开就恢复原样。
- **迁移**：S0 播种 `stock-prep:pull`；四个内置角色模板（零成员）**实际由 S5a 播种**（`zzzz20261010124500_seed_stock_prep_role_templates`，R-39；S0 落地时只播种了码，本行原写「S0 播种 … 和四个内置角色模板」，2026-10-10 订正）；087 建登记表、088 扩审计动作。S3 的宿主改动不需要迁移（`system_kind` 列已经有了）；S4 没有宿主改动。
- **版本安排**
  - R63：S0 + S1，开关关闭，迁移随包执行。S0 一升级就生效。
  - R64：S2 + S4（S4 也可以并入 S1 或 S2），是否开开关由 owner 决定。
  - S3：R64 或 R65。S5（§11 第一步）：R63 或 R64。
  - owner 2026-10-10：R64 = S3 + S5a（内置角色播种迁移 + 旧一线角色搬迁脚本），S5b（「成员与权限」页与写口）就绪则一并进 R64。
- **演示机操作员的步骤**
  1. **角色不能在升级前建，升级前只定名单**（2026-10-10 订正：原写「升级前先建「备料拉取人员」/「备料主管理员」角色」，做不到）。`stock-prep:pull` 码随 S0 迁移才进目录，迁移前在角色管理里加这个码会被 400 拒（`roles.ts:381-393`）；内置角色随 S5a 迁移出现。所以落实为：
     - **R63**（S0 已在包里）：迁移跑完后，在「角色管理」手工建 id 为 `stock-prep_puller` 的角色（`stock-prep:read` + `operate` + `pull`），任命拉取人员并「开通插件使用」。R63 上机清单（私有记录）就是这么写的：角色在迁移之后建，id **恰为** `stock-prep_puller`（不是别的写法），所以 R64 的 S5a 迁移会采纳它，而不是另建一个。
     - **R64**（S5a）：迁移播种四个内置角色（零成员）。`stock-prep_puller` 已存在则**原样采纳**（不改名、不改码、不动成员；迁移日志只记 id，以及它的码集是否与模板一致——是 / 否，缺几个、多几个，不列码名）；其余三个新建；某个内置显示名已被别的角色占用时，新建的那个显示名带「（内置）」后缀。某个内置 id 在 `roles` 里不存在、却残留着该 id 的 `user_roles` 或 `role_permissions` 行（被删角色留下的；Kysely 建的库这两列对 `roles` 没有外键）时，**跳过这个模板**（不建、不绑码），日志只记 id 和两个计数，残留行原样保留——上机后看迁移日志里有没有 `NOT created`，有就由现场先处理残留行，再在角色管理里按同一 id 手工建。迁移跑完、对一线放开之前完成主管理员任命和「开通插件使用」，并给主管理员配好委托范围（§11.1）。
  2. 备份，升级，迁移，开关保持关闭。
  3. 按第 1 步的名单任命；旧一线角色 `stock-prep-operator` 迁到 `stock-prep_frontline`（§11.2）。用 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs`，**必须在 S5a 迁移之后**（`stock-prep_frontline` 不存在时脚本拒绝，退出码 2），**并且必须在第 6 步把 `stock-prep_frontline` 写进 G1 角色清单 `MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS` 之前**（G1 会给清单里的角色写项目表授权行，目标角色一旦有了旧角色没有的表级授权，脚本的「凭空多得」检查就会拒绝）；**在任何服务器上运行都是 owner 动作**：
     - **`--apply` 之前先手工核对**：① S5a 迁移日志里有没有 `NOT created`（某个内置 id 残留成员行或码行而被跳过）、`code set equals the template: no`（被采纳的同 id 角色码集与模板不同），有就先由现场处理（处理残留行后按同一 id 手工建 / 在角色管理里核对码），迁移不替现场决定；② 在审批设计器里查有没有审批模板按 id（或显示名）把旧角色写成审批人或抄送对象——脚本不读也不改审批模板，搬完后从这些模板发起的新审批仍会指派 / 抄送给已没有成员的旧角色，要先在设计器里改指向；
     - 先不带参数跑一次 dry-run：只读事务，只打印计数和 `--apply` 会得出的判定，不写任何东西；
     - 再 `--apply`：成员（`user_roles`）和以该角色为主体的表级授权行（`spreadsheet_permissions` 中 `subject_type = 'role'` 的行）在一个事务里搬到 `stock-prep_frontline`，可重跑（第二次什么都不写）；
     - 旧角色已空后，可另加 `--delete-empty-old-role` 删除旧角色（只删它自己的码和角色行）。搬完后在同一事务里重读，只有旧角色已没有成员、没有任何 role 主体授权行（`spreadsheet_permissions` 及视图 / 字段 / 记录权限、历史审计授权）、没有在途或任何状态的角色审批席位、没有角色抄送记录、也没有指名它的待接受邀请（`user_invites` 的 pending 行）时才删；仍有待接受邀请或审批席位 / 抄送记录时，在任何写入之前就拒绝删除，dry-run 打印这些数；
     - 脚本会拒绝（退出码 2，不写）的情形，就是下面这几条，没有别的（比较的是两个角色，不是每个成员经其它角色得到的有效权限，所以可能拒绝一个其实无害的搬迁）：
       - `stock-prep_frontline` 不存在；
       - 旧角色持有新角色没有的码且仍有成员（成员会**失去**它们）；
       - 旧角色仍有成员，且有按角色指派给旧角色的审批席位（**任何状态**，`approval_assignments` 中 `assignment_type = 'role'`）或抄送给旧角色的记录（`approval_records` 中 `action = 'cc'`、`metadata->>'targetType' = 'role'`），按角色 id 或去空白后的显示名匹配：审批实例的可读性对席位不看 `is_active`、也认角色抄送（`approval-instance-readability.ts` 的 `canReadApprovalInstance`，列表侧 `ApprovalBridgeService.ts` 同口径），成员搬走就**失去**这些历史审批的读权限，而脚本不搬席位也不搬抄送（修复轮 2 新增，dry-run 打印两个计数）；
       - 新角色持有旧角色没有的码、role 主体授权行（表级按「同表且同级别」比较；视图 / 字段 / 记录权限、历史审计授权）、指派给新角色的在途审批、任何状态的角色审批席位或角色抄送记录（经新角色 id / 显示名可达、经旧角色不可达），而旧角色里有还不在新角色的成员要搬（他们会**凭空多得**这些；刚播种的 `stock-prep_frontline` 全为 0，dry-run 一律打印这几项计数）；
       - 旧角色是视图 / 字段 / 记录权限或历史审计授权的主体（按角色 id）；
       - 有指派给旧角色的在途审批（按角色 id）；
       - `stock-prep_frontline` 已有旧角色以外的成员而又有表级授权要搬；
       - 带 `--delete-empty-old-role` 时：仍有指名旧角色的待接受邀请，或仍有指名旧角色的审批席位 / 抄送记录（它们搬不走；以后有人按同一 id 或显示名重建角色，就会读到这些审批）；
     - **脚本不检查、也不改**：审批模板里对旧角色的引用（见上面 `--apply` 之前的核对）；指名旧角色的待接受邀请（不改指向；成员关系本身是建用户时写的 `user_roles` 行，照常搬走；邀请只挡 `--delete-empty-old-role`）；上面没列到的任何按角色 id 或名字引用角色的表或配置（脚本只读上面列出的表）；
     - **R64 上机的 owner 决策点：旧角色上的平台码只有方案 ① 一条路**。演示机旧角色 `stock-prep-operator` 预计持有三个手工加的平台码 `approvals:read`、`approvals:write`、`multitable:submit-approval`（frontline plan 记录），所以 dry-run 会报「会失去」、`--apply` 会拒绝。**① 唯一受支持的做法**：在角色管理里新建一个单独的平台角色持有这三个码，授给同一批成员，再从旧角色去掉这三个码，然后再跑脚本——内置角色里保持没有平台码。**② 给 `stock-prep_frontline` 补上这三个码：不可接受。** 委托任命只校验角色 id 的前缀（`admin-users.ts:3160-3168` 的 `roleIdMatchesNamespaces`，写入口 `role-assignment.ts:168-171` 同口径，都不看角色带了哪些码），而 `approvals`、`multitable` 两个资源不受命名空间准入控制（`namespace-admission.ts:11-25` 的 `NON_NAMESPACED_PERMISSION_RESOURCES`）；`stock-prep_frontline` 一旦带上这三个码，`stock-prep_admin` 的委托管理员就能经任命它把审批写权限发给任何人，违反 §11.3「主管理员不能做：平台码」。脚本的拒绝提示也只指向 ①。只从旧角色去掉三个码（不建单独角色）则一线失去记录送审，须 owner 明确接受；
     - 检查与搬迁之间，别的会话并发任命 / 改角色 / 加授权有一个很小的时间窗（任命不锁角色行），所以 `--apply` 在维护窗口里跑、期间不动角色和审批。
  4. **定时试拉换账号**：脚本只调 dry-run 和 apply（`scheduled-pull.mjs:368-374`），用的如果是一线账号，升级后会 403；换成拉取人员账号。走 legacy `integration:read` / `integration:write` 的账号不受影响（`workbench-access.cjs:272,278`）。
  5. **撤销一线在旧表上的授权**，或降为只读（`univer-meta.ts:9797`），免得一线继续往一张没人读的表里填；暂停挂在旧表上的自动化（0924 §1）。
  6. 在 `app.env` 写入开关和 G1 角色清单，重启。`stock-prep_frontline` 进 G1 角色清单必须在第 3 步的搬迁脚本跑完（`--apply` 退出码 0）之后。
  7. 拉取人员把每个项目建一次表；建表前定时试拉会把它们当 ABSENT 跳过。
  8. 只读核对：GET target 的行数要和表格 All Records 一致。
  9. 通知客户：自动化、提醒、自建视图都是按表配置的，新项目表不会自动带过去；旧表里已填的人工列不会带进新表，新表第一次拉取后人工列是空的。

## 9. 不在本 ADR 范围内

- 按人划分项目归属：`design-project-ownership-20260906`。登记行里的 `created_by` 只是事实，不用来授权。将来如果采用认领制（C），登记行就是认领的载体，新建路由就是守门点。这与该稿「守门点 ⊇ 认领点」的结论一致。
- K3 相关的任何事。
- 硬删除；也不做软删（归档代替，§6）。
- 生产写入门的配置加载器。
- 把旧混表里的人工列迁走。
- 复制自动化和视图。
- workspace 维度。
- O3 双向同步：总览或跨项目表的编辑写回项目表（附录 B.4）。
- 宿主「隐藏表」标记（§6 已知代价）。
- 行级数据范围（§11.4 第二步之后，跟归属稿走）。

## 10. 切片

| 切片 | 改动文件 | 测试 | 模型 / 验证 | 登记册 |
|---|---|---|---|---|
| **S0** 拉取人员码 + 内置角色模板 | `workbench-access.cjs`：新增 `STOCK_PREP_PULL`，加入 CODES（`:75`）和 DESCRIPTORS（`:78-86`）；`satisfiesStockPrepAccess`（`:399-408`）加 PULL 分支（pull+operate+read 同时持有，`:402-403` 的短路不变）；`operatorMayRunStockPrepPull` 的 `:440` 改 PULL。`http-routes.cjs:1150` 是唯一调用点，11 个子路由一起移过去，legacy 门不变。web 镜像 `workbenchAccess.ts`（`canRunStockPrepProjectSync` `:476-479`、看板空状态）。迁移：照 `zzzz20260830100000_add_stock_prep_permissions.ts` 播种码，照 e-learning 角色模板迁移播种四个内置角色（字面 id，§11.2）。**落地订正（2026-10-10）**：S0 只播种了码；四个内置角色移到 S5a（见 S5 行），因为 R63 先在现场手建 `stock-prep_puller`，播种迁移必须能与之共存 | operator-pull-gate 套件（`workbench-access.cjs:257`）、两侧权限矩阵（F-01 字节一致 `:489-491`，F-09/F-10 `:603-604`）；迁移测试（随 S5a）：四个 id 都匹配 `stock-prep_` 前缀、只有主管理员以 `_admin` 结尾、零成员、有成员时 down 拒绝；变异：去掉 PULL 分支里任一码，一线重新能拉，测试必须红 | 保障类：opus 实现，Fable/opus 对抗验证 | **R-33**：新增 `stock-prep:pull` 与四个内置角色模板；一线失去拉取，推翻 `workbench-access.cjs:227` 的旧裁决；不跟开关走，可随 R63 独立发布；内置角色由迁移播种（零成员，R-11「零持有者」仍成立），推翻附录 A.5「不用迁移写角色」（角色模板部分实际随 S5a 落地，记入 R-39） |
| **S1** 登记 + 建表 + 路由解析 + 开关 + G1 | migrations 087/088；新增 `stock-preparation-project-target-store.cjs`、`stock-preparation-project-targets.cjs`；改 `table-actions.cjs`（叠加解析、写入门）、`target-provisioning.cjs`（待填写视图）、`own-base.cjs`、`http-routes.cjs`、`preflight.cjs`、`index.cjs`、scheduled-pull 脚本、flag manifest、`scripts/test-chain.txt`；宿主 `plugin-scope.ts` 加 G1 授权 port；admin 码描述去掉 no provisioning（照 `zzzz20260927120000` 的 compare-and-set，`workbench-access.cjs:81-85`） | 单测用内存假库（`stock-preparation-handoff.test.cjs:164` 的 `makeMemoryDb`）：23505 并发、开关关时逐字节快照、写入门四个条件逐个缺失、各路由的墙与 409、`getTableAction` 源码守卫（含 `targetPurpose:'source'`）、conflict-policies 缺 `projectNo` 回 400；同步改 `tenant-scoped-write-guard` 的固定清单（`:330,444`）、`operator-pull-gate` 的固定清单、`audit-migration`（最高号迁移生效）。真库：放进已接线的 `stock-prep-w2-scoped-repair-realdb.test.ts`（`plugin-tests.yml:1419`）——两个项目两张表、都已认领；G1 只写 role 主体、非 `stock-prep_` 角色被拒、重复调用不新增行、一线能打开新表 | 保障类：opus 实现，Fable/opus 对抗验证 | **R-35**：一项目一表登记 + 开关 + 拉取人员建表作为 R-11 的具名例外 + G1 授权 port（Q1 / Q6 / Q7） |
| **S2** 一线交互 | `OperatorHome.vue`、`ProjectBoardView.vue`、`ProjectSyncPanel.vue`、`ProjectQueryView.vue`；新增 `projectTarget.ts`；改 `plainLanguage.ts`、`operatorHomeCards.ts`、`projectSync.ts`、`projectQuery.ts`（「平台登记」改名） | web spec。注意：`StockPreparationOperatorHome`、`ProjectBoard`、`ProjectSync` 三个 spec **目前不在**必跑清单里（`integration-guard-run-web-specs.sh:152-167`），要按「过滤词唯一」的规则加进去 | sonnet 实现，opus 复核 | **R-36**：先建后预览、无「撤销新建」、覆盖拉取 = 幂等重拉、行数提示、「平台登记」改名（Q4 / Q8） |
| **S3** 总览表 | 总览模板、新增 `stock-preparation-project-overview.cjs`、refresh 路由、项目级列路由与表单及各处挂点；宿主：`system-sheet-predicate.ts`、provisioning 盖章选项、能力钳制 | 单测：投影（含两列未完成数和「截至」）、姿态对照、项目级列白名单与审计不含值；web 对照 spec；真库：非管理员写被拒、插件写成功 | 保障类：opus，Fable 验证 | **R-37**：总览宿主级只读 + O1 + O2(a)，不做 O3（Q5） |
| **S4** 归档与恢复 | 插件内：archive / restore 路由、登记行状态、各路由的 409；**不改宿主** | 单测：各层级（一线 403；拉取人员、admin、平台管理员通过）、`confirmProjectNo` 不符被拒、§6 路由表逐行、200 上限含已归档；真库：归档后网格仍可读写、恢复后拉取可用 | 保障类：opus，Fable 验证 | **R-38**：归档代替删除、永不删除、归档 / 恢复归拉取人员（Q2）；归档表侧栏可见（默认 (ii)） |
| **S5** 应用内角色与委托管理（§11 第一步），分 S5a / S5b | **S5a**（R64）：迁移 `zzzz20261010124500_seed_stock_prep_role_templates`（四个内置角色，字面 id，零成员；同 id 已存在则原样采纳、不改名不改码不动成员；同 id 不存在却残留无主的 `user_roles` / `role_permissions` 行则跳过该模板、不绑码（修复轮 1）；显示名已被别的角色占用则新建的那个带「（内置）」；新建的 id 记入 `stock_prep_role_template_seeds`，down 只动这些）+ 运维脚本 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs`（§11.2-1、§8 第 3 步）。**S5b**：工作台「成员与权限」页与导航项（`workbench-access.cjs:531-537` 的 deploy 组）及前端镜像；宿主：自定义角色的窄写口；任命 / 准入复用 `admin-users.ts` 的委托路由 | **S5a**：迁移单测（假库）、运维脚本 node:test（假 pg 客户端，计入 `EXPECTED_OPS_TESTS_COUNT`）、真库用例接在已接线的 `elearning-role-templates.db.test.ts`。**S5b**：三条不变式各有一条「去掉就红」的测试；平台码出现在请求体里一律 400；生成的 id 不会以 `_admin` 结尾；每次变更都有审计 | 保障类：opus，Fable 对抗验证 | **R-39**：S5a 先立本行，S5b 修订同一行；§11 模型（主管理员委托管理、自定义角色 = 码子集 × 项目表范围、三条不变式、分两步） |

**另外一处**：导出租户墙的真库文件 `stock-preparation-prep-line-export-tenant-wall-realdb.test.ts` 存在，但没有接进任何 workflow（`.github` 里 0 处引用）。建议 S1 把它一起接上，因为墙现在作用在项目表上了。

## 11. 应用内角色与委托管理

owner 2026-10-08 批准：备料作为一个应用，自带角色和成员管理，由应用自己的主管理员在工作台里管，不再每次找平台管理员进「角色管理」。本节写模型和已核实的现状；实现按 §10 S0 / S5。

### 11.1 今天已有、必须复用的东西

| 已有能力 | 位置 | 对本节的意义 |
|---|---|---|
| 角色 id 以 `_admin` 结尾 = 去掉后缀那个命名空间的委托管理员 | `rbac/namespace-admission.ts:102-108`；路由侧 `routes/admin-users.ts:983-989`、`:1804-1835` | `stock-prep_admin` 就是 `stock-prep` 的委托管理员 |
| 委托管理员只能任命 id 为 `<命名空间>` 或 `<命名空间>_…` 的角色 | `roleIdMatchesNamespace`（`namespace-admission.ts:110-115`）；任命路由的判定 `admin-users.ts:3160-3162`；可选角色清单 `:1006-1010`；写入边界 `rbac/role-assignment.ts:168-172` | 新角色 id 必须是 `stock-prep_<x>` |
| `stock-prep` 是准入受控命名空间：持码之外还要「开通插件使用」才生效 | 不在 `NON_NAMESPACED_PERMISSION_RESOURCES`（`namespace-admission.ts:11-38`，判定 `:133-137`，过滤 `:356-377`）；种码迁移的说明 `zzzz20260830100000_add_stock_prep_permissions.ts:24-27` | 任命一个成员 = 授角色 + 开准入两步 |
| 委托开准入 | `PATCH /api/admin/role-delegation/users/:userId/namespaces/:namespace/admission`（`admin-users.ts:3065-3141`，审计 `:3112-3126`）；界面上的「开通插件使用」（`UserManagementView.vue:568`、`RoleDelegationView.vue:132`） | 应用页复用，不另造 |
| 委托任命角色 | `POST /api/admin/role-delegation/users/:userId/roles/assign`（及 `unassign`，`admin-users.ts:3143-3221`，审计 `:3207-3221`） | 同上 |
| 委托管理员必须先有部门或成员组范围 | 否则 403 `ROLE_DELEGATION_SCOPE_REQUIRED`（`admin-users.ts:3093-3095`、`:3170-3172`）；目标用户还要在范围内（`:3096-3101`、`:3173-3179`） | 平台管理员要先给主管理员配一次范围 |
| 角色模板迁移先例（e-learning） | `zzzz20260826140000_add_elearning_role_templates.ts:36-40`（三档模板）、`:71-104`（id / 名冲突即失败）、`:130-147`（有成员时拒绝 down） | 照它的形制播种四个内置角色；**一处不照搬**（S5a）：id 冲突时它让升级失败，S5a 改为原样采纳已存在的同 id 角色，并用 `stock_prep_role_template_seeds` 记下自己新建的 id，供 down 区分 |
| 窄宿主 port 先例 | `services/stock-preparation-field-permissions.ts:1-42`：只写列写权，结构上不能产生读限制 | G1 和 11.4 的写口照这个口径收窄 |
| 建角色、改角色权限今天要平台级 `roles:write` | `routes/roles.ts:496`、`:588`；目录外的码回 400（`:381-393`） | 委托管理员今天建不了角色，自定义角色要一条新写口（11.4） |

### 11.2 命名陷阱（S0 / S5a 落实）

1. 演示机现有的一线角色 id 是 `stock-prep-operator`（连字符，frontline plan `:16`）。它不匹配 `stock-prep_` 前缀，委托管理员在可选清单里看不到它、任命路由也会拒（`admin-users.ts:1009`、`:3160`）。**任务**：迁成 `stock-prep_frontline`——新角色由 S5a 播种（原写 S0，2026-10-10 订正），演示机上用 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs` 把成员和表级授权行搬过去，旧角色清空后经单独的 `--delete-empty-old-role` 删除；备选是在应用页里给旧 id 一个只读别名。默认走迁移，写进 §8 第 3 步。
2. **不能直接用 e-learning 的 `buildPluginRoleId`**：它把非字母数字一律换成 `_`（`rbac/plugin-role-template.ts:21-37`），`stock-prep` 会变成 `stock_prep_<kind>`，同样不匹配。四个内置角色的 id 写成字面量。（e-learning 自己的角色前缀 `plugin-elearning` 和码的命名空间 `elearning` 也不一致：`…add_elearning_role_templates.ts:17-18`。）
3. **只有主管理员的 id 能以 `_admin` 结尾**。`deriveDelegatedAdminNamespace` 只看后缀（`namespace-admission.ts:105-106`）：如果数据管理员叫 `stock-prep_data_admin`，持有者会被当成命名空间 `stock-prep_data` 的委托管理员（这个名字对 `isNamespaceAdmissionControlledResource` 为真，`:133-137`），能进委托页；只要有人给这个命名空间配了范围，就能把 `stock-prep_data_*` 角色授给别人。自定义角色的 id 由服务端生成，同样禁止 `_admin` 结尾。

### 11.3 四个内置角色（S5a 迁移播种为模板，零成员；原写 S0）

| 角色（id） | 权限码 | 能做 | 不能做 |
|---|---|---|---|
| 备料主管理员 `stock-prep_admin` | `stock-prep:admin`（短路包含 pull / operate / read，`workbench-access.cjs:402-403`） | `stock-prep` 的委托管理员：任命其他角色的成员、开关成员的插件准入、建自定义角色、看本应用的审计；拉取人员能做的它都能做 | 数据源凭据、平台开关、平台角色、平台码 |
| 数据管理员（= 拉取人员）`stock-prep_puller` | `stock-prep:pull` + `operate` + `read` | 拉取、新建项目表、归档 / 恢复、导出、给项目表授权（11.5）、清理（把不要的空表归档） | 任命成员、建角色 |
| 开发成员 `stock-prep_developer` | `stock-prep:read` + 应用 base 上各表的表级 `spreadsheet:write` | 改应用 base 里表的字段、视图、填写视图：表级写授权会打开这两项能力（`permission-service.ts:1547-1566`，经 `:1798` 生效） | 拉取、归档；自动化和新建表见 11.7 |
| 一线填写 `stock-prep_frontline` | `read` + `operate` + 项目表的表级 `spreadsheet:write`（G1） | 填写、确认「等您拿主意」、导出、交接推进、看板、项目查询（默认 (i)） | 拉取、建表、归档 |

- 开发成员**不发**全局 `multitable:manage-schema`：表上没有任何授权行时，全局码不受表级收窄（`permission-service.ts:1478-1485`），而多维表没有租户边界（frontline plan `:86-93`），等于给了整个实例里所有无授权行的表的结构权。这是把裁决里的「manage-schema 一族」落到表级授权上，只收紧不放宽。
- 模板播种零成员，所以 R-11「新 scope 零持有者、按角色显式授予」仍成立；推翻的是附录 A.5「不要用迁移写角色」，记入 R-33；播种实际随 S5a 落地，记入 R-39。

### 11.4 自定义角色

- 主管理员在「成员与权限」页新建，服务端生成 id `stock-prep_c_<随机短串>`。
- 一个自定义角色 = 权限码子集 × 数据范围：
  - 码：只能从 `stock-prep` 的四个码里选；多维表一侧只以表级授权出现，不发全局码（理由同 11.3）。
  - 数据范围：第一步 = 哪些项目表；第二步 = 视图 / 字段；行级范围留给 `design-project-ownership-20260906`。
- **三条不变式**（每条都要有「去掉就红」的测试）：
  1. 授出的不超过授予人自己的上限：码集合 ⊆ 授予人当前有效的码，表范围 ⊆ 授予人能读的项目表。
  2. 平台码永不出现：可选清单在服务端写死，请求体里出现 `stock-prep:*` 以外的码一律 400；`multitable:*`、`workflow:*`、`roles:*`、`integration:*`、`*:*` 都不在。
  3. 每次建 / 改角色、任命 / 撤销、开 / 关准入都写审计；复用 `admin-users.ts:3112-3126`、`:3207-3221` 的形状，新写口照写。
- **写口**：今天建角色只有 `roles:write`（`roles.ts:496`），委托管理员没有。新增一条宿主窄写口：只建 / 改 `stock-prep_` 前缀、非 `_admin` 结尾的角色；码集合受上面三条约束；内置四个角色在页面上只读。

### 11.5 项目表的授权怎么接上角色

- 建表时：G1（§2）给服务端配置的角色授 `spreadsheet:write`。演示机建议配四个内置角色（主管理员若不是平台管理员，也要有表级授权才能打开网格）。
- 自定义角色的「哪些项目表」：数据管理员或主管理员在页面上勾选，走同一个 G1 port，同样只对插件自有项目表、只写 role 主体。

### 11.6 「成员与权限」页

- 在 `/stock-prep` 工作台里，不是平台的「角色管理」页。新导航项放进 `deploy` 组（`workbench-access.cjs:531-537`），门用 WORKBENCH_ADMIN（`:566`）；前端镜像同步（F-01 / F-09）。
- 内容：四个内置角色和自定义角色及其成员；任命 / 撤销，同时开准入（现有委托准入路由，或在同一事务里用 `deriveGrantNamespaces` + `grantNamespaceAdmissions`，`namespace-admission.ts:160-177`、`:390-420`）；自定义角色编辑；本应用审计（只读）。
- 不出现：数据源凭据、平台开关、平台角色。

### 11.7 未决与已知代价

- **一线的表级写也能改结构**：G1 给的 `spreadsheet:write` 同时打开该项目表的字段和视图管理（§2）。所以第一步里「一线填写」和「开发成员」在单张项目表上的差别只在工作台的码上，不在多维表一侧。把一线收窄到「只填记录」，要宿主新增一个授权级别，或等第二步的字段范围。
- **开发成员的自动化和新建表**：自动化要全局 `workflow:*` 码（`multitable/access.ts:126-131`），表级授权不会打开它（`permission-service.ts:1556-1565` 里没有这一项）；在 base 里新建表要全局 `multitable:write` 或 base 属主（`univer-meta.ts:16432-16453`）。两者都没有边界，第一步不给，由平台管理员代办，或 owner 另定。
- **「模板」权限**：没有找到独立的能力码，门未核。
- **数据范围只能加不能减**：G1 只增不删、只有 write 一级。从自定义角色上拿掉一张项目表，或给只读角色，第一步只能走 G2 手工处理；是否给 port 加「删」和 read 级，由 owner 定。
- **主管理员能再任命主管理员**：现有委托路由不拦 `stock-prep_admin` 本身（它匹配自己的命名空间，`admin-users.ts:3160`）。裁决只说任命其他角色；页面不提供这一项，路由层要不要也拦由 owner 定。

### 11.8 两步

| 步 | 版本 | 内容 |
|---|---|---|
| 第一步 | R63 / R64 | 四个内置角色（S5a）+ 主管理员委托管理 + 「成员与权限」页 + 自定义角色（码子集 + 项目表范围）（S5） |
| 第二步 | 之后 | 视图 / 字段范围；行级范围跟归属稿走 |
