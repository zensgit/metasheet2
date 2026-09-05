# 备料(stock-preparation)客户交付说明(2026-09-04)

> 读者:客户 IT + 我方现场实施。
> 值面纪律:本文**不含任何账号 / 密码 / token / 内部 IP**。测试 PLM 地址仅保留 `10.10.52.16`(客户已知悉的测试库),其余主机一律用占位符 `<部署主机>` / `<PLM主机>`。账号、密码全部由客户/实施在界面当场输入,本文不记录。
> 来源纪律:本文每一步均核对自 `222-deploy-window-runbook-20260901.md`(含文末"2026-09-03 r7 实际执行记录与订正"一节,**订正优先于正文**)、`222-rehearsal-full-run-20260904.md`、`222-rehearsal-day-checklist-20260903.md`、`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1`、`scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs`,以及 `plugins/plugin-integration-core/lib/http-routes.cjs`、`packages/core-backend/src/routes/{admin-users,permissions}.ts` 的路由定义。不确定处标"待核对",不猜测、不编造。

---

## 1. 交付物

| 交付物 | 说明 |
|---|---|
| 部署包(`.zip` + `.zip.sha256` + `SHA256SUMS`) | 由 CI workflow `multitable-onprem-package-build.yml` 打包(**不要用本地检出打包**,尤其 Windows 检出会在包校验的 provenance 步骤失败)。**本次交付**:`metasheet-multitable-onprem-v2.5.0-r8-20260904.zip`,SHA256 `1fe052fcc92be512f5d41081d156e7accaed359ac4c6584bde89f95a7838a922`,钉在 main `45cca21eec86f15a565e10745cb443d1bf308213`(CI run 33880564195);已于 2026-09-04 就地升级到 222 并复验通过。**包标签与 SHA256 由本次实施填写**:标签 `<PACKAGE_TAG>`,SHA256 `<PACKAGE_SHA256>`,对应源码提交 `<SOURCE_COMMIT>`。 |
| `deploy-bootstrap`(`.ps1` / `.bat`) | 与部署包同一次 CI run 的产物(本次为 `metasheet-multitable-onprem-v2.5.0-r8-20260904-deploy-bootstrap.ps1` / `.bat`,各带 `.sha256`),用于全新环境的引导安装;用法见 `.ps1` 文件头注释。**本次未在客户环境验证其具体用法,标记待核对**——已验证的路径是"已有 222 就地升级"(见 §2.1)。 |
| 就地升级脚本 `scripts/ops/multitable-onprem-package-upgrade-inplace.ps1` | **不在部署包内**,需从与部署包同一提交的仓库检出单独复制到部署主机;调用时必须显式传 `-RootDir`(默认值指向脚本自身所在目录,不是部署根目录)。 |
| 补字段脚本 `scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs` | 旧模板建的沙箱表缺新增模板字段时,用它增量补字段(只增不改不删,幂等)。 |
| 本说明文档 | `docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md` |

---

## 2. 部署 / 升级步骤

### 2.1 已有 222 类部署:就地升级(已验证路径)

**Step A ‒ 备份**(SSH 到部署主机后;交互式会话内 `$` 不用转义,一次性 `ssh host "..."` 单条命令要转义):

```powershell
$l = (pm2 env 0 | Select-String '^DATABASE_URL:').Line
$env:DATABASE_URL = $l -replace '^DATABASE_URL:\s*',''
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = "<部署根目录>\output\backups\upgrade-backup-$ts"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
& '<PostgreSQL bin 目录>\pg_dump.exe' $env:DATABASE_URL -Fc -f "$backupDir\pre-upgrade-db.dump"
```

- PATH 里若没有 `pg_dump`/`psql`,用完整路径(222 上是 `C:\Program Files\PostgreSQL\17\bin\pg_dump.exe`,本地环境路径以实际安装为准)。
- `postgresql-x64-17` 之类服务在服务列表里显示 Stopped 属正常(外部管理的实例仍在监听),不要去"启动"它——先用 `psql`/`pg_dump` 实测连通性再下结论。
- 记下 `$backupDir`;升级脚本自己会**另打印**一个 `BACKUP_PATH=...`(代码/插件/dist 备份),两个都要记进操作报告。

**Step B ‒ 执行原地升级脚本**(它已编排:校验包 → 停服 → 备份 → 替换 → F22 断言 → 迁移 → 重启 → 健康检查):

```powershell
.\scripts\ops\multitable-onprem-package-upgrade-inplace.ps1 `
  -PackageArchive <path-to-package>.zip `
  -RootDir '<部署根目录>' `
  -Pm2AppName metasheet-backend
```

8 步(脚本全部打印到终端):① SHA-256 校验(不匹配直接拒绝)② 停 pm2 ③ 备份(打印 `BACKUP_PATH=`)④ 解包并逐文件替换(不用 `-Exclude`,这是既有 F22 教训的修复)⑤ 必存在文件断言 + 逐文件哈希核对 + node_modules 泄漏检查 ⑥ 从 `docker\app.env` 加载 env 后跑迁移(pm2 不会自动重读 env)⑦ `pm2 restart --update-env` + 轮询健康检查(默认 `http://127.0.0.1/api/health`,12 次 × 5 秒)⑧ 打印最终报告。

**健康检查**:

| 检查项 | 期望 |
|---|---|
| 脚本"final report" | `health: OK` |
| `pm2 list` | `metasheet-backend` 为 `online` |
| `Invoke-RestMethod http://127.0.0.1/api/health` | 正常返回 |
| 版本号 | `node -e "console.log(require('<部署根目录>/packages/core-backend/dist/src/version.js'))"` 对应这次打包的提交,不是升级前旧值(没变说明升级没真正生效) |

**失败处理**:脚本第 4-7 步之间任何异常,会**自动**停 pm2、打印"RESTORE REQUIRED"框(备份路径 + 每个被替换路径的精确恢复命令),照抄执行即可,不用自己回忆回退步骤。若尚未开始执行就失败(如 SHA-256 校验不过),说明包传输损坏,重新传一次,不要跳过校验。

**升级后必做**:①`BUILD_PROVENANCE.json` 不会被脚本自动刷新,需要手动从包根目录拷到部署根目录;②确认备料所在 base 能正常打开、四张受管表都能点开(零默认视图的表会拖累整个 base 打不开);③挑 1-2 张与备料无关的既有业务表(如考勤/审批)比对升级前后行数,必须一致,不一致立即停止并评估数据库级回滚。

### 2.2 全新安装(无既有部署)

**本节步骤待核对** ——本次核对的源文档只完整验证了"已有 222 就地升级"这条路径(§2.1);全新安装应使用 §1 交付物里的 `deploy-bootstrap`(`.ps1`/`.bat`),但其具体调用方式、前置依赖(如是否需要先建库、是否自带迁移)未在本次复核的源文档中找到逐步记录。建议实施前先联系我方工程师确认,或以 CI 产物里 `deploy-bootstrap` 脚本自身的帮助输出为准。全新安装完成后,§2.1 的"健康检查"标准同样适用,随后直接进入 §3(接入客户 PLM)。

---

## 3. 接入客户 PLM

**前提**:映射与读取计划**不用改**。读取链已核实与客户给的 SQL 逐跳一致:

```
PathExAttrInfo.FileCode(NodeType=2 项目节点) → PathInfo → OrderHeadInfo → OrderDetailInfo → PartLibraryInfo → BomHeadInfo → BomDetailsInfo
```

| # | 步骤 | 动作 |
|---|---|---|
| 1 | 新建外接数据源(SQL Server 只读) | 顶部导航「**外接数据源**」页新建一个只读 SQL Server 连接,地址、账号、密码**由客户/实施在界面当场输入**,本文不记录、不留存。测试库地址为 `10.10.52.16`(生产库地址由客户提供,现场输入,不写入任何文档)。**具体菜单入口待核对**(本次复核的源文档未截图此界面,只核实了其后端约束,见下一步)。 |
| 2 | 外部系统绑定该连接 | 该连接对应的"外部系统"记录,`kind` 必须是 `data-source:sql-readonly`,且其 `connectionId` 必须非空并指向第 1 步新建的连接(#5452 起的约束)。若沿用一条历史遗留的外部系统记录(未打 `dataSourceOwnerId` 标记),source-preflight 会报 `CONNECTION_LEGACY_FALLBACK_DENIED`;修法:`GET /api/integration/external-systems/:id` 取出原样公开字段(`id`/`tenantId`/`name`/`kind`/`role`/`status`/`config`/`capabilities`),补上 `connectionId = config.dataSourceId` 后 `POST /api/integration/external-systems` 回写(需 admin token + `x-tenant-id` 请求头)。 |
| 3 | 源绑定切换 | `POST /api/integration/stock-preparation/source-binding`,body 只能带一个字段:<br>`{ "externalSystemId": "<第 2 步的外部系统 id>" }`<br>需要 `integration:admin` 权限。响应 `takesEffectWithoutRestart: true`,**不需要 `pm2 restart`**,立即生效。 |
| 4 | 验证绑定生效 | `GET /api/integration/stock-preparation/source-binding` 应读到新值;`GET /api/integration/stock-preparation/audit` 应能看到一条 `action: 'source_binding_set'` 的记录。 |
| 5 | 源预检 | `GET /api/integration/stock-preparation/source-preflight?externalSystemId=<同上>`。**对本客户的 PLM,预期就是 `verdict: 'no-go'` 且带一条 `bom_store_signals_conflict` —— 这不是故障,也不阻断拉取**,原因与处置见 §7 ⑤。其它拦截码(如 `source_unreachable`、`entry_table_missing`、`no_project_numbers`、`CONNECTION_LEGACY_FALLBACK_DENIED`)才是真问题,须逐条修掉。 |

**source-binding 请求体的窄接口纪律**:body 只接受 `externalSystemId` 一个键,不能带 `kind`/`readPlan`/`target` 等字段(400 `SOURCE_BINDING_REQUEST_INVALID`)——选源只能换"读哪个源",不能顺带改"怎么读"。绑定目标必须是**已存在、kind 落在只读集合**(`data-source:sql-readonly` / `bridge:legacy-sql-readonly`)的外部系统。

**源预检结果解读**:

| `checks.*` | 期望 |
|---|---|
| `reachability` | 能连上 |
| `projectData` | 项目号入口表非空,`NodeType=2` 采样行存在 |
| `bomData` | BOM 头 / 明细非空 |
| `topology` | 实测桥接与配置的读取计划一致(`matchesConfigured=true`) |
| `presetMatch` | 命中厂商字段字典 preset |
| `quantityField` | 数量槽位与配置一致 |

已知 blocker code(任一出现即 `no-go`):`source_unreachable`、`entry_table_missing`、`no_project_numbers`、`no_bom_rows`、`no_bom_bridge`、`bridge_ambiguous`、`topology_mismatch`。看到 `topology_mismatch` 或任何"无数据"类 blocker,**先停下核对配置,不要往下一步走**。

---

### 3.1 项目没有订单时:开启"项目目录子树"找根(r10 起)

客户测试 PLM 里大多数项目没有订单头,拉取结果为 0 行。r10 起可在拉取动作的 `source.readPlan` 里加一个可选块,让系统沿项目目录节点向下找挂在子目录上的 BOM 表头作为根件(根件数量按 1 计;有订单的项目仍以订单为准,重复的根只算一次):

```json
"maxReadCount": 30000,
"projectSubtree": {
  "pathInfo": { "parentIdField": "Parent_OBJ_ID" },
  "bomHead":  { "pathIdField": "path_id" },
  "maxSubtreeDepth": 1, "maxSubtreeNodes": 200, "maxSubtreeRoots": 200, "includeSelf": true
}
```

- `maxReadCount` 在启用该块时必填,否则后端拒绝整份动作配置;三个 `maxSubtree*` 有代码硬顶(深度 4、节点 2000、根 500)。
- 改完按 §7.1 的写法重载 env 再重启;试算证据里出现 `expansion.summary.subtree`(nodesVisited / rootsDiscovered / rootsExpanded)即生效。
- 222 实测(2026-09-06,项目 2-20231625):开启前 0 行,开启后 6 张表头全部发现、135 行展开、225 项因缺件挂起。详见 `222-w2-subtree-evidence-20260906.md`。
- 关闭方法:删掉该块并重启,行为与 r9 逐字节相同。

## 4. 数据前置(客户侧必做)

**测试库现状**(2026-09-03 现场核实):`10.10.52.16` 上的测试库只有 1 张订单,其明细指向的零件全部不在物料表(`PartLibraryInfo`)——这不是映射或配置问题,是测试库数据本身残缺:该库里另有几个零件挂着完整 BOM 树(例如某零件有 2 张 BOM 表头、118 行明细),但没有任何订单引用它们。因此**任何项目号在测试库上现状都走不完整链**,第 2 步(从 PLM 拉取)演不出效果。

客户在测试环境验证前,需二选一:

**(a)在测试库插入一张订单,指向已有 BOM 的零件**(推荐,风险最低,不涉及生产数据):

```sql
-- 项目 230920006 的节点 15014156;零件 600028853 有 2 个 BOM 表头、118 行明细
INSERT INTO DN_PDM_OrderHeadInfo (OBJ_ID, path_id) VALUES (<新订单ID>, 15014156);
INSERT INTO DN_PDM_OrderDetailInfo (order_id, part_id, quantity, sort_id) VALUES (<新订单ID>, 600028853, 1, 1);
```

**表头可能还有其它非空列,以客户实际表结构为准,上面两条 INSERT 只给出本方案必须的最小字段集。**

插入后对项目号 `230920006` 跑一次拉取(§6),预计能展开出该 BOM 下的行。**预告**:2026-09-03 对测试库的只读枚举显示,该零件的一张 BOM(bom_id 15013572)59 行明细里有 33 行的子件不在测试库物料表(其它有 BOM 的根零件也普遍缺 40–60%),拉取后这些行会被系统**挂起待人工确认**(`manual_confirm_required`),这是**设计行为,不是故障**——系统对拿不准的行选择停下来问人,不自己猜。具体挂起的子件笔数(任务书口径为"59 个子件里 33 个不在测试库物料表")**待核对**:本次复核的源文档中未找到这一具体计数的逐字出处,已核实的是同一零件"2 张 BOM 表头 / 118 行明细"这组数字(见 `222-deploy-window-runbook-20260901.md` 第 116 条)。

**(b)提供生产 PLM 只读账号**:凭据由客户/实施在界面当场输入,用后按客户内部安全策略轮换;本文及其他任何交付文档都不记录凭据。选这条需要客户明确同意接入生产库。

**无论选哪条**,第 3、4 步(多维表填报、导出)都在已有的备料行上验证,不依赖这次新拉的数据。

---

## 5. 账号与权限

> **2026-09-05 实测订正(重要,照旧文档做会让一线全部 403)**
>
> **①权限必须通过「角色」授予,直接授给个人无效。** 备料权限受「命名空间准入」约束,而准入过滤器判定一个用户是否"受控于 stock-prep 命名空间"时,**只看该用户的角色**(`user_roles` → `role_permissions`),不看直接授予个人的权限。所以只调 `POST /api/permissions/grant` 把 `stock-prep:operate`/`stock-prep:read` 授给某个人,权限确实入库、也确实被读出来,但随后被准入过滤器丢弃,该用户在所有备料接口上得到 403。**正确做法**:建一个备料角色、把两个权限码挂到角色上、再把用户指派到该角色,最后开启命名空间准入。三个权限码(`stock-prep:read`/`stock-prep:operate`/`stock-prep:admin`)由迁移预置为可授予项,但**故意不预绑任何角色**(设计要求"零自动",角色绑定必须是一次显式的运维动作)。
>
> ```sql
> -- 一次性:建角色并挂权限(角色名可自定)
> INSERT INTO roles (id, name) VALUES ('stock_prep_operator', '备料一线操作员') ON CONFLICT (id) DO NOTHING;
> INSERT INTO role_permissions (role_id, permission_code) VALUES
>   ('stock_prep_operator', 'stock-prep:operate'),
>   ('stock_prep_operator', 'stock-prep:read') ON CONFLICT DO NOTHING;
> -- 每个一线人员:指派角色
> INSERT INTO user_roles (user_id, role_id) VALUES ('<用户 id>', 'stock_prep_operator') ON CONFLICT DO NOTHING;
> ```
> 随后仍需开启命名空间准入(见 5-2)。核对方式:以该用户身份调 `GET /api/auth/me`,返回的 `permissions` 里必须能看到这两个码;看不到就是角色没挂上或准入没开。
>
> **②"从 PLM 拉取"只能由管理员执行,一线做不了。** 数据源的访问判定是**属主或平台管理员二选一**(`DataSourceManager.assertAccess`),存储里的作用域字段不参与判定;PLM 连接由管理员创建,因此一线人员调拉取会得到 `400 CONNECTION_CANONICAL_UNAVAILABLE`。这是刻意的按源属主鉴权设计,不是配置问题。
>
> **实测确定的可行运作模式(2026-09-05 在 222 上以真实非管理员账号逐条验证)**:
>
> | 环节 | 一线操作员 | 管理员 |
> |---|---|---|
> | 从 PLM 拉取(试算/写入) | ✗ 400 | ✓ |
> | 我的项目目录 | ✓ 200 | ✓ |
> | 项目看板 | ✓ 200 | ✓ |
> | 确认队列(查看) | ✓ 200 | ✓ |
> | 到多维表填报 | ✓ | ✓ |
> | 导出物料清单 | ✓ 200 | ✓ |
> | 交接链状态 / 通知下一步 | ✓ 200 | ✓ |
> | 建确认账本 / 重新扫描对账 / 切换数据源 | ✗ 403(正确拒绝) | ✓ |
>
> 即:**管理员负责"把 BOM 拉进来",一线负责其余全部环节**。请按这个分工安排人员与培训。

**5-1 两个权限码**(由平台管理员通过 `POST /api/permissions/grant` 授予,`stock-prep:operate` **不隐含** `stock-prep:read`,两个都要单独授予):

```
POST /api/permissions/grant
{ "userId": "<用户 id>", "permission": "stock-prep:read" }
```
```
POST /api/permissions/grant
{ "userId": "<用户 id>", "permission": "stock-prep:operate" }
```

需要请求方本身是管理员(`isAdmin` 校验),否则 403。

**5-2 命名空间准入**(少这一步,权限授了也会被过滤掉——fail-closed):

```
PATCH /api/admin/users/<用户 id>/namespaces/stock-prep/admission
{ "enabled": true }
```

**5-3 管理员与一线操作员各自能做的事**

| 角色 | 能做 | 不能做(留给 `integration:admin`) |
|---|---|---|
| 一线操作员(`stock-prep:operate` **且** `stock-prep:read`,已开命名空间准入) | 搜自己租户的项目、开项目备料页;跑拉取(试算/写入,含大 BOM 后台通道);确认队列的 `confirmation-decisions/reconcile`;在多维表填人工列;导出 Excel;"通知下一步"推进 | 落快照批次(`mvp-persist`);装表/装 pack/`sandbox-target/ensure`;选源(`source-binding`);跨租户读任何东西;生产写 canonical(本期任何角色都不能,见 §7④) |
| 平台管理员(`role:admin` / `integration:admin`) | 上述"不能做"里的全部;授权限、开命名空间准入 | — |

**5-4 项目备料页 tab 的落地行为**:登录后访问 `/stock-prep`(路由不带 tab 参数)。一线操作员账号自动落在"项目备料"tab;平台管理员账号自动落在"确认队列"tab,需手动点开"项目备料"。也可以直接带 `?projectNo=<项目号>` 深链到某个项目。

**5-5 租户声明硬门(feature flag,默认关)**

`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true` 打开后,备料的租户面路由**只认签名令牌里的租户声明**;令牌里没有租户声明、靠 `x-tenant-id` 请求头补出来的租户,一律 403(`OPERATOR_SCOPE_TENANT_REQUIRED` / `_CONTRADICTED` / `_MISMATCH`)。默认关闭,不开就是今天的行为,一个字节都不变。

**它解决什么**:登录中间件在令牌**没有**租户声明时,会把请求头 `x-tenant-id` 的值抄到 `user.tenantId` 上。于是所有拿 `user.tenantId` 判租户的地方,比较的其实是"请求头 vs 请求头"——调用方自己写的值。开了这个门,路由取到的租户就只可能来自验签后的令牌载荷。

**它不解决什么**:握有 JWT 签名密钥的人可以自己签一个带任意租户声明的令牌,这个门信它。这一层挡的是"请求头冒充租户",不是"密钥泄露"。

**开启前置(顺序不可换,少一步就是全员 403)**:

| # | 动作 | 校验方式 |
|---|---|---|
| 1 | 补 `user_orgs`:每个要用系统的账号,恰好 **1 条活跃行**(0 条不会回填、≥2 条也不会回填,两种情况签发出来的令牌都没有租户声明) | 逐账号查 `user_orgs`;签发链见 `AuthService.resolveSessionTenantId` |
| 2 | 运维/脚本令牌用 `--tenant-id` 重新换发(`scripts/ops/attendance-window-runner-mint-token.mjs`);订正 runbook 与彩排表里"靠 `x-tenant-id: default`"的说法 | 解开新令牌的 payload,里面必须有租户字段 |
| 3 | **全员重新登录**(旧令牌不会自己长出声明,重登才会) | 随便挑一个账号,`GET /api/auth/me` 之后拿它的令牌调一次备料读接口 |
| 4 | 最后才写入 env 并重载重启 | 用一个**没有**租户声明的旧令牌调备料接口,应当 403 `OPERATOR_SCOPE_TENANT_REQUIRED` |

**回滚**:删掉 env 里那一行 → 重载/重启。没有数据迁移、没有落库状态,回滚即刻恢复今天的行为。

**开了之后一线会看到什么**:如果某个账号的令牌仍然没有租户声明,页面上是一句专门写给它的话——「当前账号不属于任何一家工厂,所以看不到具体项目的数据。这不是故障,再试也一样 —— 请用您工厂的账号登录。」——**不要让人反复刷新**,重试不会变好,要么补 `user_orgs` 要么换账号重登。

---

## 6. 验收路径(客户自测)

一线操作员用自己账号登录 → `/stock-prep`(自动落在"项目备料"tab,也可用 `?projectNo=<项目号>` 深链)。

| # | 操作 | 期望 |
|---|---|---|
| 1 | 搜索框输项目号 → 点"打开这个项目" | 新项目出现空状态提示 + 下方"项目接入"面板 |
| 2 | 点"同步这个项目(可以重复点,不会重复写)" | 四行逐行翻成成功/跳过/失败:①试算:看看会写入什么 ②确认:拿不准的交给人 ③写入:BOM 落到多维表 ④批次存档:留一份这次的样子(**这一行对一线正常是"跳过"**,存档是管理员的动作,不是故障)。有需要人工确认的行时,顶部结论会写"还差一步:有几行需要您先拿个主意"——这也不是故障。 |
| 3 | 点"到多维表填写这个项目" → 在多维表里填人工列(材料类型、备料状态、需求日期、提前周期、自制/外购、领料节点、备料日期、毛坯长度、采购完成/回复日期、仓库完成/到货日期、备注等) | 记录更新成功;人工列由人填,系统的拉取/写入从不覆盖它们 |
| 4 | 点"导出物料清单(Excel)" | 直接下载 xlsx(下载即成功,无额外提示) |

**导出的 17 列表头(顺序固定)**:

1. 父组件图号 2. 父组件名称 3. 图号 4. 名称 5. 规格 6. 材料 7. 总数量 8. 备料情况 9. 需求日期 10. 领料节点 11. 备料日期 12. 毛坯长度 13. 自制/外购 14. 采购完成 15. 采购回复日期 16. 仓库完成 17. 实际到货日期

---

## 7. 已知问题与注意

| # | 问题 | 说明 |
|---|---|---|
| ① | HTTP 站点下载导出文件被 Chrome 标"未确认" | 站点若是 HTTP(非 HTTPS),浏览器会把导出的 xlsx 拦在下载栏并标"未确认",需点"保留"。演示/验收前先告知客户这个提示是正常的,或给部署主机配 HTTPS 以避免。 |
| ② | 旧模板建的表缺新字段 | 用旧模板(早期版本)建的沙箱备料表,遇到新版本模板新增字段时,`sandbox-target/ensure` 只解析已有字段、不补新增字段,会在写入子件行时报"未知字段"类错误。**用补字段脚本修**(`scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs`,先不带 `--execute` 看计划,确认无误后再加 `--execute`),**不要手工建列**(手工建的列 id 与系统生成的稳定 id 不一致,会导致写入器仍然找不到字段)。 |
| ③ | `x-tenant-id` 请求头在无租户声明 token 下可定租户 | 部分早期 token 不带租户声明时,系统会用请求头 `x-tenant-id` 来判定租户身份,理论上存在跨租户泄漏风险。系统性修复正在推进中。**单租户内网部署下该风险可控**(部署内只有一个租户,请求头无论传什么都落在同一个租户),但仍建议客户环境按最小暴露原则配置(不对外网开放管理类接口),交付时应向客户说明这一状态,不隐瞒。 |
| ④ | 钉钉待办、宜搭推送、"通知下一步"接力链的通知投递本期不交付 | "通知下一步"按钮本身若配置了接力链(可选功能)可以推进"轮到谁"的状态,但钉钉待办、宜搭消息推送、以及接力链更完整的通知下一环功能均**不在本期交付范围**,客户若需要这类集成需另行排期。若不配置接力链,"通知下一步"按钮直接不出现,不影响拉取/填报/导出主线。 |
| ⑤ | **源预检对本客户 PLM 必然报 `bom_store_signals_conflict`(no-go),但不阻断拉取** | 客户 PLM 里有**两套** BOM 存储:`DN_PDM_BomDetailsInfo`(约 1319 行)与 `DN_PDM_DesignBom`(约 2570 行)。预检对每套只抽样 200 行,两边都抽满,因此"哪套行数更多"这一信号**无法判定**;虽然"权威"和"列形状"两个信号都指向 `BomDetailsInfo`,预检仍按设计拒绝下结论,以免用抽样上限制造出虚假的一致。**2026-09-04 在 222 上对客户测试库实测**:不声明、声明 `declaredBridge=order-module` 两种情况都是 `no-go` 且拦截码不变;声明 `design-bom` 反而多一条 `declared_bridge_contradicts_measurement`。**当前没有"声明 BOM 存储"的入口可以消掉这条拦截。** 处置:①**照常继续**——同一时间实测的试算(dry-run)返回 HTTP 200 正常工作,预检是建议性报告而非拉取的闸门;②我方选用 `BomDetailsInfo` 是有依据的:客户旧备料系统的 mapper 只用 `BomHeadInfo`/`BomDetailsInfo`、从不引用 `DesignBom`,客户自己给出的 SQL 走法也走这一套;③若客户希望预检转 `go`,需要产品侧增加"声明权威 BOM 存储"的入口或提高抽样上限,已记录为待办。 |
| ⑥ | **切换源绑定后必须写两次,否则"重新扫描待确认的事"会报"找不到源项目"** | 切源接口按"租户+工作区+动作"三元组存储,而**确认队列的对账**这一步不接受请求参数、只从登录身份推出工作区(为空)。若只从界面切源(界面会带工作区参数),对账读不到该绑定,会**回退到部署默认源**并对客户项目报 404「找不到源项目」——拉取明明正常,对账却说项目不存在。**2026-09-04 在 222 上实测复现并确认。** 处置:切源时**用带工作区参数与不带工作区参数各调用一次** `POST /api/integration/stock-preparation/source-binding`,使两个作用域一致;切完用同样两种方式各 `GET` 一次核对,`effectiveExternalSystemId` 必须都是新值。产品侧修复(让绑定解析与对账使用一致的作用域)已列入下一波。 |
| ⑦ | **缺件行在确认队列里可见但当期无法确认,唯一解法是补源数据** | BOM 明细引用的零件不在物料表(`PartLibraryInfo`)时,这些行判为 `missing_component` 并挂起;跑一次对账后,它们会作为 `pending` 条目出现在确认队列里(多行同因会折叠成一条)。**但当期无法在界面上确认掉**:服务端的确认接口目前只实现了"同一键重复展开"这一种冲突的处理动作,对缺件类一律拒绝(409)。**已知缺陷:界面仍会对这些行显示"我来定…"按钮和三个下拉选项,操作员选任何一个都会失败,且错误提示会误导其更换选项——换哪个都一样。** 正确处置:**不要在队列里反复尝试**,去源端补齐缺失的零件(或修正其 `OBJ_ID`),补好后再拉取一次并对账,系统会自动关闭这些旧的挂起条目。前端按冲突类型收窄可选项/禁用按钮,已列入下一波。 |
| ⑧ | 源绑定的读回受工作区作用域影响 | 切换源绑定后复核时,`GET /api/integration/stock-preparation/source-binding` 请**带上与写入时相同的 `workspaceId` 查询参数**。若写入与读回所带的工作区参数不一致,读回可能显示 `persistedBinding: null`、`origin: "deploy_default"`,看起来像"绑定没生效",实际已写入。以界面操作为准时两侧一致,不受影响。 |

---

## 7.1 规模:能拉多少行

以下为代码与部署配置读出的确切数值,非估算。

| 项 | 数值 | 性质 |
|---|---|---|
| 单次拉取展开上限 | **10000 行**(222 已于 2026-09-04 由 5000 上调) | 部署配置项 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` 的 `maxRows`;代码默认值即 10000,无硬上限,可继续上调 |
| BOM 层数上限 | 20 层 | 同上,配置项 `maxDepth` |
| 单次拉取翻页上限 | 100 页 | **每次读表内部**的分页数,每次调用归零,不是总量;222 已显式写入配置 `maxPages:100` |
| 单次拉取总读次数上限 | **30000 次**(222 于 2026-09-05 写入) | 配置项 `maxReadCount`;**不设即无上限**——代码默认 undefined,预算检查直接跳过 |
| 单次拉取总耗时上限 | **600000 毫秒**(222 于 2026-09-05 写入) | 配置项 `maxElapsedMs`;同上,不设即无上限 |
| Excel 导出上限 | 20000 行 | 代码常量 |
| 超过 `maxRows` 时 | **不报错、不截断**,转入"大 BOM 分批"路径 | 界面有专门面板;后端按每批 100–1000 行写入 |

**必须如实告知的一点**:上限以内走的是本说明 §6 描述、且已实测验证的那条路径。**超过上限后的"大 BOM 分批"路径,代码与界面都具备,但我方尚未实测。**若客户单个项目展开后可能超过 10000 行,请在正式使用前告知我方,由我方先行验证该路径,或据实际规模继续上调 `maxRows`。

调整方法(需重启后端,约一分钟):改 `dockerpp.env` 中该 JSON 的对应键(`maxRows`/`maxReadCount`/`maxElapsedMs`),然后重启。**注意 `pm2 restart --update-env` 不会重读 `app.env`**,它只把当前 shell 的环境合并进去;直接 restart 进程仍带旧值(2026-09-05 实测踩坑)。正确做法是在**同一个 PowerShell 进程**里先装载再重启:

```powershell
Get-Content 'C:\metasheet\dockerpp.env' | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $kv = $_ -split '=', 2; [System.Environment]::SetEnvironmentVariable($kv[0], $kv[1], 'Process')
}
pm2 restart metasheet-backend --update-env
```

生效核对:`pm2 env 0` 里该 JSON 已含新值;再任跑一次试算,响应 `evidence.expansion.summary` 的 `maxRows`/`maxReadCount`/`maxElapsedMs` 即为当前生效值(未设的键不会出现)。

**新装部署请一开始就把这三个预算键写进配置**:不写等于对 PLM 的总读次数与总耗时没有任何刹车,唯一止损是 `maxRows`。

---

## 8. 回退

**优先(代码/插件级,覆盖绝大多数失败——构建坏、健康检查不过、文件丢失)**:升级脚本失败时会**自动**逐路径打印精确恢复命令,照抄执行即可:

```powershell
Remove-Item -LiteralPath <live-path> -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $BACKUP_PATH <rel-path>) -Destination <live-path> -Recurse -Force
pm2 restart metasheet-backend --update-env
```

**迁移可以留着不回滚**:本期迁移都是纯新增(建表、放宽某条 CHECK 约束的取值清单),单事务、失败即整体回滚,不残留半迁移状态,旧构建照常跑——代码级回滚**不需要动数据库**。

**顺手清理的配置**:`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 这份 env 允许清单**没有过期机制**,回退或窗口结束后需要人工从 `app.env` 里清理;接力链回退就是把对应的 env 路径键从 `app.env` 里拿掉后重启。**env 类回退同样要重启才生效,且必须按 §7.1 的写法先把 `app.env` 装进当前 shell 再 `pm2 restart --update-env`**,否则进程继续带着旧值。

**最后手段(数据库级,慎用)**:只在"迁移本身跑成功了,但之后发现数据被破坏"这种场景使用,**必须先经 owner/客户方确认**——若该部署上同时运行其他业务模块(如考勤、审批),`pg_restore --clean` 类操作会把备份时间点之后**所有模块**的新数据一并抹掉:

```powershell
pg_restore --clean --if-exists -d $env:DATABASE_URL "$backupDir\pre-upgrade-db.dump"
```

---

## 待核对条目汇总

初稿标了 4 条,2026-09-04 晚复核后只剩 1 条:

1. **§1 / §2.2:`deploy-bootstrap`(`.ps1`/`.bat`)全新安装的具体调用方式与前置依赖** —— 本次只实跑并验证了"已有部署就地升级"(§2.1,222 上 r8 已按此升级并复验通过);全新安装路径未在任何环境实跑,交付前若客户是全新装机,须先在一台干净机器上把 §2.2 走一遍再交。

已补实的三条:§1 的包标签/SHA256/钉住提交(r8-20260904,见 §1 表);§3 步骤 1 的界面入口(顶部导航「外接数据源」);§4 的 59/33 计数出处(2026-09-03 对测试库的只读枚举,记录在 `222-rehearsal-full-run-20260904.md` §1 与 memory)。

历史记录(初稿原文,已处理):
1. §1:部署包的具体包标签与 SHA256(占位 `<PACKAGE_TAG>` / `<PACKAGE_SHA256>`),由本次实施填写。
2. §1 / §2.2:`deploy-bootstrap`(`.ps1`/`.bat`)全新安装的具体调用方式与前置依赖,本次复核的源文档未记录逐步流程。
3. §3 步骤 1:新建外接数据源的具体界面菜单入口,本次复核的源文档未截图/记录此界面,只核实了其后端约束。
4. §4:任务书口径"该 BOM 的 59 个子件里 33 个不在测试库物料表"这一具体计数,本次复核的源文档中未找到逐字出处(已核实的是同一零件"2 张 BOM 表头 / 118 行明细"这组数字)。
