# 222 彩排日执行单 —— 备料四步(2026-09-03)

> 本单每一处 `{{填}}`/`{{待核}}` 都是刻意留白,要在彩排当天现场填/核,不是文档缺陷。
> 它压缩自 `docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md` 这份完整 runbook,细节以 runbook 为准。

> 依据 `docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md`(下称 Runbook,**以 #5459 分支版本为准**,它订正了 Step 0-7)。本单只讲**彩排当天**;窗口前的 #5416/#5402 合并、DesignBom 拓扑审阅、打包仍照 Runbook Step 0-1~0-5。
> **值域纪律**:不写凭据 / 真实主机名 / IP,一律 `<222-HOST>` / `<PLM-HOST>`。PLM 源用 222 上**已配好**的那个 external system,不在本单里重配、不写账密。
> **不在本次范围**:**#5455(字段权限 reconcile + 回填)未合入本次发布 —— 跳过 Runbook 的 3-3a 回填步骤**;钉钉个人待办、宜搭均不做(owner 2026-09-02 裁决)。
> **落点裁决 D1=B**:行落在**沙箱表**(`plm_stock_preparation_sandbox*`);对 canonical 主表 `plm_stock_preparation_main` 的 apply 被无条件 403 拒绝,这是预期,不是故障。

---

## 0. 版本与前置

**版本行**:`b9b5a947f`(package r7-20260903-b9b5a947f)= `origin/main` 在 **#5459**(`fix/stock-prep-carry-target-binding`)与 **#5460**(`feat/stock-prep-project-board`)合入之后。#5442(`feat/stock-prep-notify-next`)已于 `2026-09-03T00:11:49Z` 合入。上机前记一次:

```bash
git fetch origin && git rev-parse origin/main
```

**备份**(222 上,SSH 交互式会话内;一次性 `ssh host "..."` 要把 `$` 转义。Runbook Step 1-1/1-2):

> r7 订正:一次性远程执行遇引号问题时改用 `powershell -NoProfile -EncodedCommand <脚本 UTF-16LE base64>`;222 上 PATH 无 `pg_dump`/`psql`,用 `C:\Program Files\PostgreSQL\17\bin\pg_dump.exe`(Postgres 17 本地 5432,`postgresql-x64-17` 服务显示 Stopped 属正常,不要启动它)。

```powershell
$l = (pm2 env 0 | Select-String '^DATABASE_URL:').Line
$env:DATABASE_URL = $l -replace '^DATABASE_URL:\s*',''
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = "C:\metasheet\output\backups\upgrade-backup-$ts"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
pg_dump $env:DATABASE_URL -Fc -f "$backupDir\pre-upgrade-db.dump"
```

记下 `$backupDir`;升级脚本会**另打印**一个 `BACKUP_PATH=...`(代码/插件/dist 备份),两个都要记进操作报告。

**谁做什么**

| 角色 | 干什么 |
|---|---|
| 我方工程师 | §1 部署、§2 绑定、§6 回退 |
| 平台管理员(`role:admin` / `integration:admin`) | §3 授权限+命名空间准入;`mvp-persist`;`confirmation-decisions/reconcile` |
| 客户一线操作员(`stock-prep:operate` **且** `stock-prep:read`) | §4 四步 |

> r7 订正:§2/§3 的 admin API 调用用的 token 由宿主内 `scripts/ops/attendance-window-runner-mint-token.mjs`(复制到 `packages/core-backend/scripts/` 下再跑,`--find-admin` 找已存在的 admin,`--mint --user-id <id> --roles admin --expires-in 3600 --tenant-id default`,用完删掉)现签,不碰密码;**用 `--tenant-id default` 签发后令牌自带 tenant claim**,`x-tenant-id` 头可以继续带但不再是租户来源;flag 开启后不带 tenant claim 的令牌会被 403。
| owner | 全程在场 —— 半生产机,考勤/审批是真实在跑的业务数据 |

**客户必须提前给的三件事**

1. **第 2 步(拉取)的数据源 —— owner 必须在彩排日之前二选一,不能当天再定。**
   实测(2026-09-01,`plm-source-schema-exattr-dictionary.md`):222 上已配好那个地址的**客户测试 PLM 是「结构骨架、业务值空」**——`DN_Bom_View` / `DN_BomHead_View` 的 `project_code` **全 NULL**、`DrawingType`(图号)NULL、名称是无意义 GUID、Material/Specification 为空;BOM 行本身是有的(`BomHeadInfo`=143 / `DesignBom`=**2570** / `BomDetailsInfo`=1319)。**照现状拉,拉出来的是一堆空值,第 2 步演不成。**
   - **(a) 客户在测试 PLM 里填一个真实项目** —— 至少一个,含 project_code + BOM 树 + 图号 + 材料 + 数量。**推荐**,风险最低。
   - **(b) 222 改读生产 PLM,用只读账号** —— 只读拉取;凭据**由客户当场自己输入**,用后轮换;本单及任何文档都不记凭据。选这条要 owner 明确点头(生产库)。
   → 选定:`{{填:(a) 或 (b)}}`;项目号:`{{填:客户填好的项目号}}`
   **无论选哪条,第 3、4 步都在客户已有的备料行上彩排** —— 它们不依赖这次新拉的数据。
   **另:字典四问已于 8/30 从客户旧备料系统代码解出,代码已按此实现**(项目号 = `DN_PDM_PathExAttrInfo.FileCode`(NodeType=2 项目节点)、规格型号 = 该节点上上级目录名、数量 = `Bom_ExAttr1`、BOM 以 `BomHeadInfo/BomDetailsInfo` 为准并按 `bom_able` 过滤、零件身份 = 图号 `IdentityNo`),客户只需一句「按旧系统口径」确认。**注意:测试库没有 `bom_able` 列且业务值全空(测试库 ≠ 生产库 schema)**,所以第②步在测试库上不可靠——只读读生产 PLM 是更稳的路(选项 b)。
   **第②步数据现状(2026-09-03 现场核实,详见 Runbook 订正记录第 12–14 条)**:测试库里**只有 1 张订单**(`obj_id` `15011146`,挂在项目 `1-20232045` 节点 `15010980` 下,7 行明细),但这 7 行明细的 `part_id` **全部不在 `PartLibraryInfo`**(零件库残缺,不是映射或配置错误)——dry-run 逐跳走到最后一跳(`PartLibraryInfo`)时正确展开为 0 行、报 `missing_component`/`manual_confirm_required`。库里另有几个零件挂着完整 BOM 树(如 `600028853`:118 行明细),但没有任何订单引用它们。**选 (a) 要在测试库里演出效果,不能只插一张订单,还要让订单明细的 `part_id` 指向一个已有 BOM 树的零件**(例如把新订单挂到项目 `230920006`/节点 `15014156`,明细指向 `600028853`),否则依然展开 0 行;选 (b) 改读生产库不受此限。
2. **一个一线操作员账号**,在**本部署的租户内**,持 `stock-prep:operate` **和** `stock-prep:read`(operate **不隐含** read),且已开 `stock-prep` 命名空间准入(§3)。→ `{{填:操作员 userId}}`
3. **是否接钉钉群**。接 → 须给「中间每跳的群 destination id」「终点仓库群 / 采购群 id」「各步经办人 userId」;不接 → 整步跳过,页面上不出现「通知下一步」按钮,其余三步不受影响。

---

## 1. 部署

**1-1 传包 + 原地升级**(不要用手工步骤替代脚本 —— 手工正是 F22 的成因):

```powershell
.\scripts\ops\multitable-onprem-package-upgrade-inplace.ps1 `
  -PackageArchive <path-to-package>.zip `
  -RootDir 'C:\metasheet' `
  -Pm2AppName metasheet-backend
```

> r7 订正:该脚本**不在**发布包里,需从同一提交的仓库检出单独复制过去;默认 `RootDir` 是 `$PSScriptRoot\..\..`,不显式传 `-RootDir 'C:\metasheet'` 会指错目录。

脚本 8 步自带:SHA-256 校验 → 停 pm2 → 备份(打印 `BACKUP_PATH=`)→ 逐文件替换 → F22 断言+逐文件哈希 → **跑迁移** → `pm2 restart --update-env` + 健康轮询 → 最终报告。

**验证**:最终报告 `health: OK`;`pm2 list` 里 `metasheet-backend` 为 `online`;`Invoke-RestMethod http://127.0.0.1/api/health` 正常;版本号已变(`node -e "console.log(require('C:/metasheet/packages/core-backend/dist/src/version.js'))"`)—— 没变说明升级没真的生效。

**1-2 迁移**(脚本第 6 步已跑;若要单独重跑:`pnpm -C packages/core-backend db:migrate`,列表用 `db:list`)。本次相对旧构建**新增**这几支:

| 文件 | 来自 | 作用 |
|---|---|---|
| `packages/core-backend/migrations/084_create_integration_stock_prep_handoff.sql` | #5442 | 接力游标表 |
| `packages/core-backend/migrations/085_extend_stock_prep_audit_handoff_action.sql` | #5442 | 审计词表 + `handoff_advance` |
| `packages/core-backend/migrations/086_extend_stock_prep_audit_project_board_read_action.sql` **{{待核}}** | #5460 | 审计词表 + `project_board_read` |

⚠ **086 这个号是必须核的一件事,不是格式问题** —— 见脚注 [1]。#5460 分支头上这支文件今天仍叫 **`083_`**;而 084/085 已在 main 上。这些迁移是「DROP 整条 CHECK 约束、再按完整清单 ADD 回去」的形状,按**文件名顺序**执行,所以 083 → 084 → 085 跑完,**最后落地的是 085 的清单,里面没有 `project_board_read`** —— 一线点开项目备料页的第一下,审计写入就会被约束拒绝。owner 已裁决「迁移改 086」,但分支上还没改。**别信文件名,信下面这条查询。**

**1-3 审计 CHECK 词表验证查询**(222 上,迁移跑完后必做):

```powershell
psql $env:DATABASE_URL -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'integration_stock_prep_audit_action_check';"
```

**期望**:返回的 `CHECK (action = ANY (ARRAY[...]))` 里**同时**含 `'project_board_read'` **和** `'handoff_advance'`,以及既有的 `'prep_line_export'`、`'project_directory_read'`、`'source_binding_set'` 等。

**缺 `project_board_read` → 停,不要往 §4 走**:项目备料页每次打开都会 500。修法是补一支 `086_`(或更高号)迁移,把**完整并集**清单一次写回,而不是删掉 085。缺 `handoff_advance` → 「通知下一步」的推进会 503 `STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE`(报错体的 `details.migration` 直接告诉你该跑哪支)。

**1-4 升级后抽查**(Runbook Step 3-4 / 3-5):打开备料所在 base,确认四张受管表都能点开(F20:零视图的表会拖累**整个 base** 打不开);挑 1-2 张考勤/审批表比对升级前后 `count(*)`,**必须一致** —— 变了立刻停,走 §6 并通知 owner。

---

## 2. 绑定(沙箱落点)

> **顺序是 env 优先,不能反过来。** 这些键在**插件激活时**读一次(`resolvePluginRuntimeConfig`,`packages/core-backend/src/index.ts:2882` 是唯一调用点),**HTTP 接口改不了它们**。而 §2-3 预检的 7 个 blocker 里**有 4 个只能靠改 env + 重启来消**(见下表 ✅ 那几行)——env 没配就去跑 ensure / 预检,只会拿到一份必然失败的清单。
> **当天顺序:①写 env → ②`pm2 restart --update-env` → ③ensure → ④贴绑定 → ⑤预检循环 → ⑥dry-run 手工复核。**

**2-1 env**(`docker\app.env` 或它指向的文件;改完**必须** `pm2 restart --update-env`,pm2 不会自动重读 env):

| env 键 | 干什么 | 不配的后果 | 消 blocker? |
|---|---|---|---|
| `STOCK_PREP_SANDBOX_MODE=true` | 打开沙箱写行授权 | apply 403 `reason: sandbox_disabled` | ✅ `SANDBOX_MODE_NOT_ENABLED` |
| `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=` | 沙箱目标允许清单(逗号分隔) | apply 403 `reason: target_not_allowlisted` | ✅ `SANDBOX_ALLOWLIST_MISSING_TARGET` |
| `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH=` | pack 目录文件路径 | 没有 `ext_` 列 | ✅ `CUSTOMER_PACK_NOT_CONFIGURED` |
| `INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH=` | 源列 → `ext_` 值映射 | `ext_` 列有壳无值 | ✅ `EXT_FIELD_MAPPING_NOT_CONFIGURED` |
| `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON=` | **action 绑定(写哪张表)** | **预检不查!见 §2-4** | ❌ 预检完全不覆盖 |
| `INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH=` | 接力链(可选,§3-4) | 按钮不出现 | ❌(可选功能) |

前四行的键名以 `plugin-runtime-config.ts` 与 `stock-preparation-preflight.cjs:87-92` 为准(仓库有测试断言两处不许漂移)。另三个 blocker(`CONFIRMATION_LEDGER_NOT_READY` / `PACK_TARGET_MISSING` / `PACK_TARGET_INCOMPLETE`)是**HTTP 能修**的,照 `fix.run` 调接口即可,不用重启。

照抄进 `app.env` 的最小两行:

```
STOCK_PREP_SANDBOX_MODE=true
STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS={{填:本窗口沙箱 objectId}}
```

objectId 必须匹配 `/^plm_stock_preparation_sandbox(?:$|[_-])/`(`stock-preparation-target-provisioning.cjs:82`),例如 `plm_stock_preparation_sandbox_222`。

**2-2 生成绑定 —— 只有这一条路,别手改**:

```
POST /api/integration/stock-preparation/sandbox-target/ensure
{ "objectId": "<同上 objectId>", "label": "<表名>" }
```

响应 `data.targetBinding` 形如 `{ sheetId, objectId, keyField, fieldIdMap }`。把它**整段**贴进 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`:

```json
{ "plm.stock-preparation.pull-bom.v1": { "target": "<把 data.targetBinding 整段贴在这里>" } }
```

> r7 订正:若装了 customer pack,**不要真的"整段"覆盖**——ensure 只返回 33 个 TEMPLATE 字段(20 个 `plm_system` + 13 个人工列),不带 pack 的 21 个 `ext_` 列,直接整段贴会静默丢掉 `ext_` 映射。正确做法是**合并**:ensure 的映射 + 旧配置里的 `ext_*` 条目(同一张 sheet/objectId,旧物理列 id 依然有效),动手前先备份 `app.env`。

**`objectId` 改了,`sheetId` 必须一起重算,不能留用既有那个。** 沙箱门(`assertStockPrepApplySandboxAllowed`)**只读 objectId**,而 apply 写哪张表、导出读哪张表**只看 `target.sheetId`** —— 两者互相独立。「objectId 换成沙箱、sheetId 留正式表那个」会让门放行、行却写进**正式主表**,正是 D1=B 要避免的那件事。`fieldIdMap` 同理(列 id = `fld_+sha1(projectId:objectId:fieldId)`,objectId 一变整张表的列 id 全变),且**必须是完整一整份(含 13 个人工列)**。

**若装了 customer pack —— 这里有个静默陷阱,必须显式核。** pack 配置里的 `targetObjectId` **必须写出来**,且与上面两处是**同一个字符串**(三处 diff,不要肉眼扫)。**漏写这个键不会报错,它会静默默认成 canonical**:`normalizePackTargetObjectId` 在值为 `undefined`/`null` 时直接返回 `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`(`stock-preparation-customer-pack.cjs:269-272`)。而**预检对此故意不报 blocker** —— 代码原话:「a canonical-declaring pack raises no allowlist blocker」(`stock-preparation-preflight.cjs`),因为 canonical 在沙箱路径上结构性不可写,提示你去把它加进允许清单是「行不通的建议」。**净效果:预检 `ready: true`,apply 当场 403 `reason: prod_canonical`。** 所以要人眼确认这个键**存在且是沙箱值**,别等预检替你说话。(写了值则必须落在沙箱命名空间,否则 pack 在**插件激活时**就报 `PACK_TARGET_OBJECT_ID_INVALID` —— 只有「压根没写」这一种情况会静默滑向 canonical。这也订正了 Runbook Step 0-7 第 3 条「本来就只允许沙箱命名空间」的说法:**只在键存在时成立**,脚注 [9]。)

**2-3 预检循环,直到 `ready: true`**:

```
GET /api/integration/stock-preparation/preflight
```

响应键:`ready` / `blockers[]` / `checks` / `posture`。按每条 `blockers[].fix.run` **照抄执行**,不要自己另起 objectId 或猜 env 名。可能出现的 blocker code:

`STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY` · `STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED` · `STOCK_PREP_PACK_TARGET_MISSING` · `STOCK_PREP_PACK_TARGET_INCOMPLETE` · `STOCK_PREP_EXT_FIELD_MAPPING_NOT_CONFIGURED` · `STOCK_PREP_SANDBOX_MODE_NOT_ENABLED` · `STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET` · **`STOCK_PREP_CARRY_TARGET_NOT_OWNED`** · **`STOCK_PREP_CARRY_TARGET_HUMAN_FIELDS_UNBOUND`**

后两条是 #5459 新加的,**Runbook Step 3-3 的旧表格里没有,以代码为准**(脚注 [2])。`NOT_OWNED` = 绑定的表不属于本部署的项目,结转每次点都被拒,修法就是重跑 2-2 的 ensure;`HUMAN_FIELDS_UNBOUND` = 人工列没绑全。

`posture.carryTargetBinding.state` 为 `not_derived` **不是故障、不拦任何操作**,它只提示绑定两半指向不同的表;结转允不允许看 `checks.carryTargetBinding.ownershipState`。

**2-4 冒烟(工程师做一次,别让一线撞雷)—— 这一步不能省,它是 action 绑定唯一的验证手段**

`INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` **完全不在预检的覆盖范围内**(预检只经 `resolveBoundActionTarget` 取一下已解析的 target 做结转归属判断,从不验证这份配置能不能真的跑通)。**所以「预检 `ready: true`」不等于「拉取能用」** —— 绑定的源 `dataSourceId` 悬空、外部系统失活、源 kind 不匹配,预检一概不知道,要到 dry-run 才炸成 **422**(`TABLE_ACTION_SOURCE_INVALID`;或 `PipelineRunner`/`DataSourceUnavailable` 类配置错误映射成 422,`http-routes.cjs:821,842-845,3948`)。**必须手工跑一次:**

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run
{ "parameters": { "projectNo": "<项目号>" } }
```

**验收标准:HTTP 200,且顶层 `status` 落在那五个值里的任意一个 —— 只要不是 422 就算这一关过了。**收到 422 → action 绑定或它指的源有问题,回 §2-2,**不要让一线去撞**。

顶层 `status` 的**全部**取值就五个:`not_found` | `large_bom_bounded` | `ready` | `manual_confirm_required` | `failed`。**没有 `expanded`** —— `expanded` 只出现在嵌套的 `evidence.expansion.status` 里。首次拉取预期落在 `ready` 或 `manual_confirm_required`(后者**正常**,表示有行要人工确认),两者都 `canApply: true` 且 `dryRunToken` 非空。行数看 `evidence.expansion.rowsExpanded`(顶层没有这个字段),应是真实量级、**不是 0**。

若要管理员先落一份快照(可选;它写的是内部 9 表快照,**不经过 action.target**):

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/mvp-persist
{ "parameters": { "projectNo": "<项目号>" } }
```

**请求体只接受 `parameters` 这一个键**(`VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS = new Set(['parameters'])`,`http-routes.cjs:1137`)。多带 `confirm` / `dryRunToken` → 400 `TABLE_ACTION_REQUEST_INVALID`。`confirm.dryRunToken` 是 **`/apply`** 路由的字段,两条路由不通用。(#5456 订正)

---

## 3. 账号与权限

**3-1 授予两个权限码**(平台管理员;`stock-prep:operate` **不隐含** `stock-prep:read`,两个都要):`stock-prep:read` + `stock-prep:operate`。这三个码由迁移 `packages/core-backend/src/db/migrations/zzzz20260830100000_add_stock_prep_permissions.ts` 建为 `permissions` 行,**但故意不绑任何角色**(R-11「零自动」),必须显式授予。

**3-2 开命名空间准入** —— 少这一步,权限授了也会被过滤掉(fail-closed):

```
PATCH /api/admin/users/{{填:操作员 userId}}/namespaces/stock-prep/admission
{ "enabled": true }
```

**3-3 一线能做 / 不能做**

| 能 | 不能(留 `integration:admin`) |
|---|---|
| 搜自己租户的项目、开项目备料页 | `mvp-persist`(落快照批次) |
| 跑 `dry-run` + `apply`(含大 BOM 有界通道 8 条路由,含 `cancel`) | 装表 / 装 pack / `sandbox-target/ensure` |
| `confirmation-decisions/reconcile` | 选源 `source-binding`(要 `integration:admin`) |

> r7 订正:#5452(统一 SQL 连接绑定,2026-09-03 已合入main)之后,`data-source:sql-readonly` 外部系统要求 `integration_external_systems.connection_id` 非空,r6 时代未打 `dataSourceOwnerId` 标记的行(如 `Customer PLM readonly` `104e9bad`、`Synthetic PLM readonly` `7130b124`)会在 source-preflight 报 `CONNECTION_LEGACY_FALLBACK_DENIED`。修法:`GET /api/integration/external-systems/:id` 取原样公开字段,加上 `connectionId = config.dataSourceId` 后 `POST /api/integration/external-systems` 回写(admin token + `x-tenant-id`)。
| 在多维表里填人工列 | 生产写 canonical(本次谁都不能,加载器缺失) |
| 「通知下一步」推进、导出 Excel(17 列) | 跨租户读任何东西 |

一线跑拉取时,**源读以服务端记录的绑定所有者身份执行**(默认只读 SQL 源按严格所有者相等授权,一线永远不是绑定人);审计同时记 `actor`(一线)与 `principal`(绑定所有者)。这只对 `plm.stock-preparation.pull-bom.v1` 这一个冻结 actionId 生效。

**3-4 接力链(可选;不接就整步不配)**

> ⚠ **只有两种合法状态,中间态是坑:要么配齐,要么彻底不配。**
> - **配齐** = 配置文件有 `tenantId` **且** 宿主侧真的接了一个可用的钉钉通知器(notifier)+ 群目的地。
> - **不配** = 连 `INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH` 都不写,页面上按钮直接不出现。
>
> **绝不要配一条「有链但没通知器」的链。** 这种部署上,每一跳的群消息都欠着发不出去,于是:①「**通知下一步(补发上一步的群消息)**」这条补发横幅**永远挂着不消失**;②更糟的是**同一个人连着担任两步时,他永远推不动**——前端 `advanceHandoff` 里写死了「补发优先于前进」(`const fromStepKey = handoffResendableStepKey.value ?? handoff.value.currentStepKey`,`StockPreparationConfirmationQueueView.vue:869-870`,注释原话:「the resend wins when both are possible」),所以他每点一次都是在补发自己上一跳那条**永远发不出去**的消息,而不是把活交给下一步。
> 依据:PR #5442 第四轮复核发现,**修复 PR 尚未合入** —— 本次发布带着这个坑,只能靠配置纪律绕开。
> (注:「声明了步骤但一个目的地都不声明」是**合法**的仅追踪轮次的用法,此时每次推进返回 `notifyOutcome: 'no_destination'`;它与「宿主没接通知器」在**线上取值上无法区分**,所以本单一律要求二选一,不走这条中间路。`handoff.cjs:392` 那句注释写的 `'not_configured'` 是**过时的**,闭合词表里没有这个值,实际取值是 `no_destination`(同文件 538-562)。)

`docker\app.env` 加一行,指向一个**不进仓库**的 JSON:

```
INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH=D:\metasheet\config\stock-preparation-handoff.json
```

```json
{
  "tenantId": "{{填:本部署租户 id,与其他备料配置同一个}}",
  "steps": [
    { "key": "prep_entry",   "handlerUserIds": ["{{填}}"] },
    { "key": "process",      "handlerUserIds": ["{{填}}"] },
    { "key": "final_review", "handlerUserIds": ["{{填}}"] }
  ],
  "notify":   { "groupDestinationId": "{{填:中间每跳的钉钉群 id}}" },
  "terminal": { "groupDestinationIds": ["{{填:仓库群}}", "{{填:采购群}}"] }
}
```

**`tenantId` 是必填的**:钉钉目的地 id 是部署级配置,宿主只能证明「这目的地归管理员管」,证不了「它属于正在被播报的那个租户」;而无租户声明的 token 会让 `x-tenant-id` **请求头**决定租户身份 —— 不填就会把别的租户的项目号播进这个群。多步链必须 `notify` 与 `terminal` **同时**配齐,只配一半直接报错。

**验证**:重启后 `GET /api/integration/stock-preparation/handoff?projectNo=<项目号>` 返回 `configured:true` 且 `stepCount` 等于配的步数。500 `STOCK_PREPARATION_HANDOFF_CONFIG_INVALID` → 报错体的 `details.field` 就是写错的那个键。配不对就**把这个 env 拿掉重启**,回到「没有这个功能」的状态,别占用彩排时间。

---

## 4. 四步彩排脚本(一线自己点,我方不代劳)

一线用自己的账号登录 → `/stock-prep` → **自动落在「项目备料」tab**(管理员会落在「确认队列」,得手动点这个 tab)。也可直接给 `/stock-prep?projectNo={{填:项目号}}`。

> ⚠ **对台词前先看这条**:空状态里那句提示写的是「用下面的**从PLM拉取数据**」,但屏幕上**没有这个名字的按钮**。真正要点的按钮在「**项目接入**」标题下,写的是「**同步这个项目(可以重复点,不会重复写)**」。彩排时按**屏幕上的字**指挥,别按提示里的字(脚注 [7])。

| # | 一线怎么做 | 屏幕上应该出现什么 |
|---|---|---|
| **1** | 搜索框(占位符「**项目号或名称**」,可按号码或名称)输入 `{{填:项目号}}` → 点「**打开这个项目**」(或直接回车) | 按钮变「正在打开…」。新项目 → 出现空状态:「**这个项目号在您这里还没有数据。**可以直接用下面的「从PLM拉取数据」把它拉进来。」**同时**下方出现「项目接入」面板。<br>注:此时**没有错误横幅** —— 404 的横幅被刻意抑制,只显示空状态。若看到「这个项目号在您这里还没有数据,**而拉取数据不是您能做的一步**」→ 权限没给全,回 §3。 |
| **2** | 在「项目接入」面板点「**同步这个项目(可以重复点,不会重复写)**」 | 按钮变「正在同步…」,下面四行**逐行**从「待运行」翻成 成功/跳过/失败:①试算:看看会写入什么 ②确认:拿不准的交给人 ③写入:BOM 落到多维表 ④批次存档:留一份这次的样子。<br>**第 ④ 行对一线正常是「跳过」**:「数据已经写进去了;**留存这一批快照不归您做**」——`mvp-persist` 是管理员的动作,这不是故障。<br>顶部一句结论:「**导入完成 —— 这个项目的 BOM 已经在多维表里了。**」(或「已经是最新的」/「写入了一部分」/「还差一步:有几行需要您先拿个主意」——**「held」不是错**)。<br>之后状态条刷新出「拉取状态:已拉进来,N 行可以用」。 |
| **2′** | **BOM 太大时**(试算行跳过、写着「这个项目的 BOM 太大,没法当场展开 / 系统已经转去后台通道处理,下面能看到进度 —— 不用重新点同步,也不用联系我们」) | 面板下方自动挂出后台通道,**全自动、没有任何按钮**(不用点开始/轮询/写入;「取消」= 离开页面)。阶段文字依次:排队中 → 正在后台展开 BOM… → 展开完成,正在核对差异 → 正在把展开出来的数据写进多维表… → **BOM 已经写进多维表**,并出现「到多维表看数据」。<br>若停在「有几行系统拿不准,需要人工确认」→ 大 BOM 暂不能在面板内确认,**到此为止什么都没写入**,记录下来找我方。 |
| **3** | 点「**到多维表填写这个项目**」→ 填人工列,含 **`自制/外购`** | 提示原文:「打开的是备料主表。表里是这台系统上**所有项目**的行,请按项目号找您这一个 —— 目前还不能只显示一个项目。」按项目号自己找行。<br>若按钮写的是「**打开多维表**」(而不是「到多维表填写这个项目」)→ 备料主表还没建好,只会打开多维表首页,回 §2 让管理员建表。<br>人工列由人填,`apply` 从不写它们。填完回项目备料页。 |
| **4a** | (可选)点「**通知下一步**」 | **没配接力链 → 这个按钮根本不出现**(是 `v-if`,不是灰的、不是报错),且状态条「轮到谁」写「这台系统没有设置流转顺序」。<br>配了且轮到本人 → 「**已经交给下一步,并且通知到了。**」按钮灰显时把鼠标停上去会说明原因:「已经是最后一步了」/「现在不是轮到您,所以不用您来通知」。 |
| **4b** | 点「**导出物料清单(Excel)**」 | 直接下载 xlsx,**没有成功提示**(下载即成功)。**17 列、顺序固定**:父组件图号 · 父组件名称 · 图号 · 名称 · 规格 · 材料 · 总数量 · 备料情况 · 需求日期 · 领料节点 · 备料日期 · 毛胚长度 · **自制/外购** · 采购完成 · 采购回复日期 · 仓库完成 · 实际到货日期。<br>若提示「这个项目号下没有有效的物料行,已下载一份仅含表头的空白模板」→ 行没落进绑定的那张表,回 §2 核 `sheetId`。 |

**唯一一条要提前打招呼的边界 —— 项目**没有名字**。** 标题栏只显示项目号,不显示项目名;归档那行会写:「**管理员还没有为这个项目留存快照 —— 这不影响您上面的数据,只影响「差异对比」。**」原因:项目名和快照计数都来自 `mvp-persist` 写的内部快照表,那是**平台管理员**的动作,一线自助拉取不经过它。这是如实显示「还没人存档」,**不是**「还没拉过」——「拉取状态」那行是按**绑定表里的真实行数**判定的,它会照常显示「已拉进来,N 行可以用」。想让名字出现,让管理员先跑一次 §2-4 的 `mvp-persist`。

**对应的 API 体(工程师复核 / 一线卡住时代跑用 —— 两条路由的 body 形状不通用,混用直接 400)**

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/apply
{
  "parameters": { "projectNo": "<项目号>" },
  "confirm": { "dryRunToken": "<最近一次 dry-run 的 token>", "acceptManualConfirmHold": true }
}
```
token **只能放在 `confirm.dryRunToken` 里**(`http-routes.cjs:5123` 逐字取 `body.confirm.dryRunToken`);放到顶层 → body 白名单 `VALID_TABLE_ACTION_APPLY_BODY_KEYS = new Set(['parameters','confirm'])`(同文件 1138)判为 unsupported field → **400 `TABLE_ACTION_REQUEST_INVALID`**。这批若还有重复 key 分组被解决过,再加 `acceptDuplicateResolution: true`,否则 409。

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/mvp-persist
{ "parameters": { "projectNo": "<项目号>" } }
```
**只收 `parameters` 这一个键**(`VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS = new Set(['parameters'])`,同文件 1137)。带 `confirm` 或 `dryRunToken` → **400**。它不消费 token,而是在服务端**重跑一遍只读计划**,写的是内部 9 表快照,**不经过 `action.target`**。此路由仍是 `integration:admin`。

**收工验收**:打开 §2 配置的那张**沙箱表**,项目 `{{填:项目号}}` 有行;抽一行看四个字段都是真实值 —— 项目号、图号(来自 `IdentityNo`)、材料(非空非 GUID)、数量(来自 `Bom_ExAttr` 族第 1 槽,不是 0 也不是 NULL 转出来的怪值)。
**canonical 主表 `plm_stock_preparation_main` 保持原状是预期结果,不是故障。** 不允许为了让验收好看手工插行。

---

## 5. 卡住时看哪里

页面**会把错误码原样显示**在一句中文下面(`<code>` 小字),所以让一线**念出那个码**,再对下表。注意:多数码**没有**专属中文,落到通用句 ——「没能读到这个项目的情况,请稍后再试一次。什么都没有改动。」(读)或「这一步没有保存成功,数据没有变化。」(写)。**通用句不代表没问题,以码为准。**

| 一线念出的码 / 现象 | 意思 | 怎么办 |
|---|---|---|
| `OPERATOR_SCOPE_TENANT_REQUIRED` | token 不带租户声明(多 org 用户 / 服务 token),值面路由拒绝按请求头定租户。**页面只显示通用句 + 这个码** | 让账号只属于**一个**活跃 org 后重新登录;**不要**靠 `x-tenant-id` 头绕过。管理员页也可能出现该码,修法是用带 `--tenant-id` 的令牌(见 `attendance-window-runner-mint-token.mjs`) |
| 空状态「这个项目号在您这里还没有数据。」**且无横幅** | 就是 404 `STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND`,横幅被刻意抑制 | 项目号打错、**或**本租户不拥有绑定表 —— 两者响应逐字节相同(故意不做存在性预言机)。先核号码,再核 §2 的绑定是不是本租户 ensure 出来的 |
| 空状态多一句「**而拉取数据不是您能做的一步**」 | 账号缺 `stock-prep:operate`,或命名空间准入没开 | 回 §3-1 / §3-2 |
| **打开页面就 500** | 审计 CHECK 缺 `project_board_read` | 跑 §1-3 那条查询;缺就补 086 迁移。**这是本次最可能踩的雷**,且**不会**降级成友好的 503(脚注 [1]) |
| 503 `STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE` | 数据库还不接受某个审计动作(目前只有接力链路由带这道友好守卫) | 报错体 `details.migration` 直接写了该跑哪支迁移,跑它 |
| 403 `STOCK_PREP_APPLY_SANDBOX_ONLY` | 看 `reason`:`prod_canonical` = action 绑定还是 canonical;`sandbox_disabled` = env 没读到 `STOCK_PREP_SANDBOX_MODE=true`(`--update-env` 过没?);`target_not_allowlisted` = 三处 objectId 不一致 | 回 §2 |
| `CONFIRM_CARRY_TARGET_TENANT_MISMATCH` / `_NOT_OWNED` / `_HUMAN_FIELDS_UNBOUND` / `_NOT_PROVISIONED` / `_OWNER_UNKNOWN` / `_FIELDS_UNRESOLVED` / `_INVALID` | 结转目标表不属于本部署项目,或人工列没绑全 | **修法都是重跑 §2-2 的 ensure**,再把返回的 `targetBinding` 整段贴回去 |
| `TARGET_SCHEMA_INCOMPLETE` | 表在,但 `ext_` 列没装齐 | 照预检 `fix.run` 装列;装列和写行是**两道独立授权** |
| 页面显示「**当前账号没有做这件事的权限。**」 | 服务端回的是 `FORBIDDEN`(大 BOM 通道里最常见) | 多半 `stock-prep:read` 没给全或准入没开 → §3;大 BOM 八条路由已随 #5460 开到一线层,还 403 就是权限没配对 |
| 403 `LARGE_BOM_JOB_ACTOR_MISMATCH`(只在「技术详情(排障用)」里能看到) | 大 BOM 任务属于另一个人 | 用**建任务的那个账号**继续,别换人接手 |
| 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH` | token 过期,或内容在 dry-run 之后变了 | 重跑 dry-run 拿新 token |
| 400 `TABLE_ACTION_REQUEST_INVALID` | body 多带了字段 | `mvp-persist` 只收 `parameters`;`apply` 收 `parameters` + `confirm` |

**不是故障的三种现象,先别报障**:①第 ④ 步「批次存档」跳过(`mvp-persist` 归管理员);②结论写「还差一步:有几行需要您先拿个主意」(held —— 系统拿不准时停下来问人,不自己猜);③大 BOM 转后台通道。

**日志**:`pm2 logs metasheet-backend --lines 200`(应用名来自升级脚本 `-Pm2AppName` 默认值)。租户拒绝的**真实原因只写服务端日志**,HTTP 响应故意含糊 —— 排查跨租户类报错必须看日志。日志文件的确切落盘路径 **{{待核}}**(仓库文档未记)。另注:**后台自动刷新失败是静默的**(代码里 `catch {}`,注释写明「A BACKGROUND re-read that fails says nothing」),屏幕上的数字会停在旧值不报错 —— 数字不动时手动重开一次项目。

---

## 6. 回退

**优先:代码/插件级**(覆盖绝大多数失败 —— 构建坏、健康检查不过、F22 类文件丢失)。升级脚本失败时会**自动逐路径打印**精确恢复命令,照抄即可,不用自己拼:

```powershell
Remove-Item -LiteralPath <live-path> -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $BACKUP_PATH <rel-path>) -Destination <live-path> -Recurse -Force
pm2 restart metasheet-backend --update-env
```

**迁移可以留着不回滚**:084 / 085 / 086 都是**纯新增**(建表、放宽一条 CHECK 的取值清单),单事务、失败即整体回滚,不残留半迁移状态,旧构建照常跑。所以代码级回滚**不需要动数据库**。

**顺手清掉的配置**:`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 这份 env 允许清单**没有过期机制**,窗口结束后需人工清理;接力链回退就是把 `INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH` 从 `app.env` 里拿掉重启。**注意 env 类回退同样要 `pm2 restart --update-env` 才生效**(§2 的 env-first 同理)。

**#5455 不在本次发布内**:所以本部署**没有 3-3a 回填这一步**,也**不会出现 `LEGACY_UNATTRIBUTED` 相关行为**(字段权限 reconcile 尚未上线,既有字段级权限行不被对账、也不被重新标记归属)。回退时无需考虑它。

**最后手段:数据库级** —— 只在「迁移跑成功了但之后发现数据被破坏」时用,**必须先经 owner 确认**:这是半生产机,`pg_restore --clean` 会把快照之后**所有模块**(不只备料)的新数据一并抹掉。

```powershell
pg_restore --clean --if-exists -d $env:DATABASE_URL "$backupDir\pre-upgrade-db.dump"
```

---

### 脚注:Runbook 与代码不一致之处(以代码为准)

**[1] 迁移号 083 vs 086 —— 本单最重要的一条。** #5460 分支头(`origin/feat/stock-prep-project-board`)上的文件今天仍是 `083_extend_stock_prep_audit_project_board_read_action.sql`,而 `origin/main` 已有 `084_` / `085_`(#5442)。这三支都是「DROP 整条 `integration_stock_prep_audit_action_check`,再按**完整清单**ADD 回去」的形状,`migrate.ts` 按文件名顺序执行(`allowUnorderedMigrations: true`),所以 083 跑在 085 之前,**最终落地的是 085 的清单 —— 其中没有 `project_board_read`**。仓库自己的护栏测试(`__tests__/stock-preparation-audit-migration.test.cjs`,拿**最高号**迁移与 store 常量做双向集合相等)会在合并后变红,owner 也已裁决「迁移改 086」,但**分支上尚未改**。本单按 `086_` 写,标 {{待核}},并把 §1-3 那条 `pg_constraint` 查询作为真正的裁判。另注:项目看板路由**没有**接 `requireStockPreparationAuditVocabulary` 那道 503 友好守卫(该机制随 #5442 进 main,而 #5460 的 http-routes 基线早于它),所以词表缺失时表现为**裸 500**,不是 503 —— 合并后是否补上 **{{待核}}**。

**[2] Runbook Step 3-3 的 blocker 表不全。** 它列了 7 个 code,#5459 的 `stock-preparation-preflight.cjs` 实际发 9 个,多出 `STOCK_PREP_CARRY_TARGET_NOT_OWNED` 与 `STOCK_PREP_CARRY_TARGET_HUMAN_FIELDS_UNBOUND`。§2-3 已按代码补齐。

**[3] 错误码名字。** Runbook 与口头讨论里的 `PROJECT_BOARD_NOT_FOUND`,代码里的完整值是 **`STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND`**(`stock-preparation-project-board.cjs:195`)。

**[4] Runbook 没有「项目备料页」这一节。** #5460 **完全没有改** Runbook(`git diff` 对其 merge-base 为空),所以 Runbook 的 Step 6/7 仍写成「管理员用 curl 跑 dry-run + apply」。§4 的四步是**一线在页面上自己点**的等价流程,依据是 #5460 的路由与门(`requireAccess(req, STOCK_PREP_OPERATE)` + 一线拉取门拆分),不是 Runbook。两者都真,彩排走 §4。

**[5] `main` 上的 Runbook Step 0-7 仍是错的。** 它写「`sheetId`:既有值,不变」——照做会顶着沙箱的名把行写进正式主表。#5459 已订正为「调 ensure、整段贴 `targetBinding`」。**#5459 合入前不要照 main 版本操作**;§2-2 用的是订正后的写法。

**[6] 未覆盖项。** #5455(字段权限 reconcile + 回填,Runbook 的 3-3a)不在本次发布内,已整步略去 —— 后果是既有表上的字段级权限行不会被本次对账,人工列的可写性以当前部署现状为准。

**[7] 「从PLM拉取数据」这个按钮不存在。** 这个词只出现在**空状态的提示句里**(以及代码注释和一条测试断言),屏幕上真正可点的按钮在「项目接入」面板里,写的是「**同步这个项目(可以重复点,不会重复写)**」(`StockPreparationProjectSyncPanel.vue`)。彩排指挥词必须用后者,否则一线会在页面上找一个不存在的按钮。同类小差:任务书里的「导出」实际是「**导出物料清单(Excel)**」;「到多维表填写」实际是「**到多维表填写这个项目**」,备料主表没建好时降级成「**打开多维表**」(只能跳首页)。另:深链**不带项目过滤**,落在整张备料主表上,页面自己也承认「目前还不能只显示一个项目」——§4 第 3 步已按此写。


**[8] 前端文件路径与任务书给的不同**(核实后的真实路径,供后续查证):Vue 组件在 `apps/web/src/components/integration/stockPreparation/`(**不是** `views/`),`.ts` 模块在 `apps/web/src/services/integration/stockPreparation/`(**不是** `views/`)。「项目备料」tab 的路由是 `/stock-prep`,**没有 tab 参数**;一线自动落在这个 tab,平台管理员落在「确认队列」需手动点。可用 `?projectNo=<项目号>` 直接开到某个项目。

**[9] pack 目标:Runbook 说反了一半。** Runbook Step 0-7 第 3 条写 pack 的 `targetObjectId`「本来就只允许沙箱命名空间……不需要为 D1=B 额外改」。**只在这个键存在时成立。** 键**缺席**时 `normalizePackTargetObjectId` 静默返回 canonical(`stock-preparation-customer-pack.cjs:269-272`),而预检对 canonical-declaring 的 pack **故意不报 blocker**,于是「预检全绿 + apply 403」。§2-2 已按代码补成「必须显式写出且人眼核对」。另:本单未能在仓库里定位到「随附的两份示例 pack」文件(`plugins/plugin-integration-core` 下只有 `fixtures/` 的 SQL,无 pack JSON),**该说法本身 {{待核}}**;但上面这条默认值机制已逐行核实,无论示例 pack 存不存在都成立。
