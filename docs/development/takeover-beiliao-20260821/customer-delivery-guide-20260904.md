# 备料(stock-preparation)客户交付说明(2026-09-04)

> 读者:客户 IT + 我方现场实施。
> 值面纪律:本文**不含任何账号 / 密码 / token / 内部 IP**。测试 PLM 地址仅保留 `10.10.52.16`(客户已知悉的测试库),其余主机一律用占位符 `<部署主机>` / `<PLM主机>`。账号、密码全部由客户/实施在界面当场输入,本文不记录。
> 来源纪律:本文每一步均核对自 `222-deploy-window-runbook-20260901.md`(含文末"2026-09-03 r7 实际执行记录与订正"一节,**订正优先于正文**)、`222-rehearsal-full-run-20260904.md`、`222-rehearsal-day-checklist-20260903.md`、`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1`、`scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs`,以及 `plugins/plugin-integration-core/lib/http-routes.cjs`、`packages/core-backend/src/routes/{admin-users,permissions}.ts` 的路由定义。不确定处标"待核对",不猜测、不编造。

---

## v2(2026-09-06)变更摘要

本次更新基于 48 小时自主开发窗口(W2–W4)在 222 上的实证与随后的对抗审查、r11 部署,新增/订正以下六项。逐条详情见文中对应小节,这里只列摘要,不重复正文。

1. **子树桥接(§3.1,已有,本次核对无遗漏)**:项目没有订单时,靠"项目目录子树"找根件的机制与 222 实测数字(6 张表头 / 135 行展开 / 225 项挂起)已在 §3.1,本次复核未发现需要订正之处。
2. **每日 06:00 只试算计划任务(新增 §3.2)**:此前本文未记录这条计划任务,本次补上——账号策略、令牌租户声明要求、日志 values-free、退出码、以及用 `Start-ScheduledTask` 触发验证的方法。
3. **缺件清单(§6.2,已有,本次核对无遗漏)**:试算卡在 `manual_confirm_required` 时怎么拿到缺件清单、怎么处理,已在 §6.2。
4. **租户声明硬门(§5-5,已有)**:补一句总纲——**运维 mint 令牌必须带 `--tenant-id`,UI 账号需要恰好一条活跃 `user_orgs` 记录**,否则签发出的令牌不带租户声明,flag 打开后会被相关路由 403。详细前置顺序见 §5-5 表格。
5. **源绑定 workspace 回退(新增 §3.3,W3b)**:无 workspace 参数的调用方(典型如定时任务)在租户下若恰好存在一条非 null 绑定,现在会回退取用该绑定;存在 ≥2 条候选时拒绝(fail-closed),精确匹配优先,带 workspace 提示但未命中时不回退。
6. **拉取委派修复(#5505)**:§5-② 已按此修复改写——一线操作员、定时任务服务账号能否拉取 PLM 数据,取决于外接源上有没有服务端归属戳,不再是"一线一律不能拉取"。**222 现状(截至本文核对时)是两条外接源都还没有归属戳,一线拉取仍会 400**,需要绑定者重新保存一次绑定补写(修法见现场连接测试 runbook §1.1)。PR 正文(`gh pr view 5505`)记录了完整根因(读身份委派顺序错误 + canonical 绑定结构上不可能带戳)与裁定;**注意契约变更**——"canonical 绑定不保留归属戳"是此前的既有不变式,#5505 有意将其反转为"canonical 绑定在校验通过后由服务端写入归属戳",不是缺陷修复的副作用。

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

### 3.2 每日定时拉取(只试算,不写入)

W2 起 222 上注册了一个每日 **06:00** 的 Windows 计划任务 `metasheet-stock-prep-scheduled-dry-run`,只做 **dry-run(试算)**,不带 `--apply`,不写沙箱表——发现"有变化"由人工看日志/看板决定要不要真正点一次同步。

**账号策略**:计划任务本身在 Windows 任务计划程序里以 `SYSTEM` 身份运行(操作系统层面),但它调用的备料接口用的是一个**应用层 bearer 令牌**,该令牌属于哪个账号是关键:
- **设计意图是专用服务账号**(`svc-stockprep-scheduler`,`role=admin`,登录禁用哨兵 hash,`user_orgs` 恰一条 `default`)——已在 222 建好,但截至本文核对时**尚未启用**,原因见下条。
- **当前实际使用绑定者本人的管理员令牌**:W2 执行期间发现拉取的读身份委派机制(`resolveTableActionReadPrincipal` 委派给外接系统 `config.dataSourceOwnerId`)对 canonical 绑定从未生效,专用服务账号不是绑定者本人,调用一律 `400 CONNECTION_CANONICAL_UNAVAILABLE`;临时改签给绑定者 admin 的令牌后计划任务才跑通。**#5505 已修复委派机制本身**(见 v2 摘要第 6 条与 §5-②),但 222 上的外接源目前还没有归属戳,修复生效前还需绑定者重新保存一次绑定——因此"计划任务切回专用服务账号"是否已具备条件,需要在归属戳补齐后重新验证,已记入 `48h-autonomous-run-record-20260906.md` 的待拍板清单。
- **令牌须带租户声明**:不论用哪个账号,签发令牌都必须用 `--tenant-id`(`scripts/ops/attendance-window-runner-mint-token.mjs`),否则打开 §5-5 的租户声明硬门后计划任务会被 403。222 上验证过的令牌 claims 含 `tenantId`(与脚本读取的 `MS_TENANT_ID` 一致),到期时间写入文件供轮换参考。

**日志与退出码**:
- 脚本日志 **values-free**——不打印令牌、不打印任何凭据,只打印结构化结果(状态码、`rowsExpanded`/`add`/`manual_confirm` 等计数)。
- 包装脚本(`.cmd`)首次生成时因路径被自动换行拆成多行,执行报 `exit 255` 且不留日志;改成路径不换行的字面单行写法后恢复正常。
- 进程正常退出应为 `exit 0`;此前存在一个与本任务无关的通用问题——Node 进程退出时偶发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`(表现为 `exit 0xC0000409`),根因是用了 `process.exit` 而未清理定时器句柄,已在 #5493 修复(改用 `AbortController` 清理、补真实子进程验证退出码)。**升级到含 #5493 的构建之后再核对这条计划任务**,若仍看到该断言退出码,说明构建版本不对,不是配置问题。

**验证方式(不等到第二天 06:00)**:用 `Start-ScheduledTask` 手动触发一次,而不是靠"调个接口通不通"来验:
```powershell
Start-ScheduledTask -TaskName 'metasheet-stock-prep-scheduled-dry-run'
```
核对两件事:①`(Get-ScheduledTaskInfo -TaskName 'metasheet-stock-prep-scheduled-dry-run').LastTaskResult` 必须是 `0`;②脚本日志新增的那几行必须是 values-free 的试算结果(如 `200 manual_confirm_required`、`add`/`manual_confirm` 计数、`summary failed 0`),不是错误堆栈。222 上按此方法验证通过:`LastTaskResult=0`,日志新增两行,试算 200、`add 135 / manual_confirm 225`、`summary failed 0`。

### 3.3 源绑定切换后,定时任务/无工作区参数的调用能不能读到同一条绑定(W3b)

§7 已知问题 ⑥ 描述的"切源必须写两次"问题(界面切源带工作区参数,对账/定时任务这类不带参数的调用方推出 `workspace=null`,两边读不到同一条绑定)有了修复方向 B:

- **回退规则**:调用方**没有带工作区提示**(`workspace=null`,典型场景是定时任务、对账)时,若该租户下**恰好存在一条**非 null 的源绑定,系统回退取用这一条;若存在 **≥2 条**候选,拒绝回退(fail-closed,不猜);带工作区提示且精确命中的绑定优先于回退结果;带工作区提示但**未命中**任何绑定时,不触发回退(保住既有测试的边界)。
- **对下游的影响**:同一次回退命中时,外接系统查找也会以回退命中的 `matchedWorkspaceId` 作为 hint,不需要额外配置。
- **222 落地(2026-09-06)**:清理了历史遗留的 `workspace_id IS NULL` 那条绑定(备份表 `integration_stock_prep_source_binding_bak_20260906-030732`),现在只剩一条 `default` 作用域绑定指向客户 PLM(`104e9bad`)。管理员带工作区提示试算:200(135 行 / 6 张表头 / 6 个根)。定时任务(无工作区提示)靠单候选回退命中同一条绑定:200(`add 135 / manual_confirm 225`,`summary failed 0`)。W3b 的判据(只写一处、两边都读到同一条绑定)在 222 上已满足。
- 根因(为什么会有两套推导)记为 owner 决策项:Web 端把"租户"当"工作区"来推导绑定作用域,是设计遗留,不是这次改动引入的新问题。

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
> **②"从 PLM 拉取"能不能由一线执行,取决于外接源上有没有服务端归属戳。** 数据源的访问判定是**属主或平台管理员二选一**(`DataSourceManager.assertAccess`),存储里的作用域字段不参与判定;PLM 连接由管理员创建。为此拉取这一个动作(`plm.stock-preparation.pull-bom.v1`,冻结 id,等值比较)设计了**读身份委派**:读以外接源上服务端写入的**绑定者**身份进行,请求者身份不变、也无法指定委派对象。
>
> **委派成立的两个前提(缺一即 `400 CONNECTION_CANONICAL_UNAVAILABLE`)**:
>
> 1. **部署包含 2026-09-06 的委派修复。** 在此之前,委派在 `data-source:sql-readonly` 的**两种绑定形态上都从未生效**:读身份是在外接源加载**之后**才算的,而加载内部已经用请求者身份去解析连接并失败了。所以修复前的实测结论"一线一律 400"是准确的。
> 2. **该外接源携带服务端归属戳(`config.dataSourceOwnerId`)。** 新建绑定、或绑定者重新提交一次 `connectionId` 的更新,服务端会在校验通过后自动写入(值来自被主机校验为连接属主的那个已认证身份,客户端无法伪造、也无法指定)。**cutover 之后创建的既有 canonical 行没有这个戳**,需要绑定者重新保存一次绑定来补写。
>
> **222 现状(2026-09-06)**:两条 `data-source:sql-readonly` 外接源(客户 PLM、合成源)都是 canonical 绑定且**无归属戳**,因此**一线拉取仍然 400**,直到绑定者(admin `8100a911`)重新保存一次绑定。源就绪预检会把这件事作为 blocker `pull_principal_delegation_unavailable` 明确报出来(带 `bindingShape`,不含任何连接 id / 属主 id),修法见现场连接测试 runbook §1.1。
>
> **实测确定的可行运作模式(2026-09-05 在 222 上以真实非管理员账号逐条验证;拉取一行按 2026-09-06 的机制订正)**:
>
> | 环节 | 一线操作员 | 管理员 |
> |---|---|---|
> | 从 PLM 拉取(试算/写入) | 有归属戳 ✓;无归属戳 ✗ 400(222 现状) | ✓ |
> | 我的项目目录 | ✓ 200 | ✓ |
> | 项目看板 | ✓ 200 | ✓ |
> | 确认队列(查看) | ✓ 200 | ✓ |
> | 到多维表填报 | ✓ | ✓ |
> | 导出物料清单 | ✓ 200 | ✓ |
> | 交接链状态 / 通知下一步 | ✓ 200 | ✓ |
> | 建确认账本 / 重新扫描对账 / 切换数据源 | ✗ 403(正确拒绝) | ✓ |
>
> 即:**归属戳补齐之前,管理员负责"把 BOM 拉进来",一线负责其余全部环节**;补齐之后,拉取也归一线,分工里只剩"建确认账本 / 重新扫描对账 / 切换数据源"留给管理员。请按当前所处的状态安排人员与培训,不要照着"一线自助拉取"直接培训一个还没补戳的部署。

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

`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true` 打开后,令牌里没有租户声明、靠 `x-tenant-id` 请求头补出来的租户,一律 403(`OPERATOR_SCOPE_TENANT_REQUIRED` / `_CONTRADICTED` / `_MISMATCH`)。默认关闭。

**覆盖面比"备料"大,这一点必须说清楚**:门装在 integration 插件的三个共享入口上(`requireTableActionAccess` 的 legacy 分支、`resolveTenantId`、`resolveAuthUserTenantId`),所以它覆盖的是**整个 integration 插件面**——备料的四十多条路由,以及同样走这三个入口的外接系统、数据源、模板、管道等路由,都一并要求租户声明。222 上只跑备料线,这个范围可接受;**跑了其它 integration 能力的通用部署应当保持 flag 关闭**,否则那些路由也会对无声明令牌 403。

**关闭时是今天的行为**,逐字节相同 —— **一处例外**:确认写接口(`confirmation-decisions/confirm`)在同一次改动里换成了与其读半边一致的 operator-scope(要求宿主为"账号属于该工厂"背书),这是**无条件**的修复,关 flag 也不回到旧行为;它比旧行为更严,不会放宽任何人。

**它解决什么**:登录中间件在令牌**没有**租户声明时,会把请求头 `x-tenant-id` 的值抄到 `user.tenantId` 上。于是所有拿 `user.tenantId` 判租户的地方,比较的其实是"请求头 vs 请求头"——调用方自己写的值。开了这个门,路由取到的租户**只可能来自验签后的令牌载荷,或来自宿主已证明该主体所属的租户**(operator-scope 的成员校验)——两者都不是请求头。后一种是设计上的:已经走 operator-scope 的那几条路由(值面读、结转确认、交接、确认写)对"没有声明但有自己的租户、且宿主背书"的账号本来就放行,这个 flag 不改变它。

**它不解决什么**:握有 JWT 签名密钥的人可以自己签一个带任意租户声明的令牌,这个门信它。这一层挡的是"请求头冒充租户",不是"密钥泄露"。

**开启前置(顺序不可换,少一步就是全员 403)**:

| # | 动作 | 校验方式 |
|---|---|---|
| 1 | 补 `user_orgs`:每个要用系统的账号,恰好 **1 条活跃行**(0 条不会回填、≥2 条也不会回填,两种情况签发出来的令牌都没有租户声明) | 逐账号查 `user_orgs`;签发链见 `AuthService.resolveSessionTenantId` |
| 2 | 运维/脚本令牌用 `--tenant-id` 重新换发(`scripts/ops/attendance-window-runner-mint-token.mjs`);订正 runbook 与彩排表里"靠 `x-tenant-id: default`"的说法 | 解开新令牌的 payload,里面必须有租户字段 |
| 3 | **全员重新登录**(旧令牌不会自己长出声明,重登才会) | 抽查:把重登后拿到的令牌 payload 解开(JWT 中段 base64),里面必须有非空租户字段。**不要用"调个接口通不通"来验**——flag 还没开的时候,有声明和没声明的令牌都会通,那是一次空校验 |
| 4 | 最后才写入 env 并重载重启 | 两条都要:①`pm2 env 0` 里看到 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`;②用一个**没有**租户声明的旧令牌打 `GET /api/integration/stock-preparation/confirmation-decisions/readiness`,得到 403 `OPERATOR_SCOPE_TENANT_REQUIRED` |

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

### 6.2 缺件清单:项目卡在 manual_confirm_required 时怎么办

① **为什么整个项目一行都写不进去**:BOM 展开时,只要有一行子件在物料表(`PartLibraryInfo`)里找不到对应零件,这一条就判为"缺件"(`missing_component`),规划器把它标成需要人工确认。试算的结论因此不是"这几行进不去、其他行照写"——**是整个项目这次一行都不写**,顶部结论显示"还差一步:有几行需要您先拿个主意"(即 `manual_confirm_required`)。这不是故障,是系统按设计"宁可整批不写,也不做半成的导入"。

② **怎么拿到缺件清单**:点"同步这个项目"/"从PLM拉取数据"跑完试算后,如果这次试算命中了缺件,"这次试算:…"那一句下面会多出一个可展开的"缺件"区块,默认是展开的。里面按零件号列出每个缺件:它挂在哪个父件下、在哪张 BOM、第几层、探测到几次;同一个零件缺在多个父件下时,父件那一列会带"(+N 处)"角标。**客户端最多保留 200 种缺件**,超过时只显示前 200 种并提示实际共有多少种;"导出 CSV"导出的也是这同样的 200 种,**不是全量**——把这一批补完后再同步一次,下一次试算会露出还没处理的那部分。区块自带"复制"(整段以制表符分隔,可直接粘进 Excel 表格;比屏幕上多两列——涉及父件数与完整路径)和"导出 CSV"(文件名 `missing-components-项目号-日期.csv`)两个按钮。

③ **拿到清单之后做什么**:按"零件号"去 PLM/ERP 的物料库里把这些零件补建出来,或者修正现有物料记录上对不上的编号;清单里"次数"高、父件角标数多的零件优先处理——这些零件卡住的行更多。

④ **补完之后怎么办**:回到这个页面,对同一个项目号再点一次"同步"/"拉取",不需要做任何别的操作——重新试算会自动看到源端刚补好的零件,原来卡住的行如果确实补齐了,这次就不会再判成缺件,需要人工确认的行数应该往下降,直到清空为止。如果清单还是超过 200 种,重复这个过程:每一轮补完当前显示的这批,下一轮试算会露出下一批。

⑤ **谁能看到清单里的零件号**:清单里的零件号是这个项目所在租户的真实业务数据,门槛比"看试算结果"更高一层——要同时满足①有备料的**操作**权限(不是只读)②这个账号绑定在**自己的租户**下。只有"只读"权限的人能看到试算跑没跑、跑到第几步,但看不到缺件区块里的零件号——这是刻意的设计,不是遗漏(呼应 §5 的权限模型:操作权限之外还要过租户这一关)。不满足②(比如没绑定租户的平台管理员账号硬要看)会在页面上看到一行提示"当前账号看不到缺件清单",而不是静默地什么都不显示——这行提示只在"确实被拒绝"时出现,和"这次试算根本没有缺件"是两回事。

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

**必须如实告知的一点(2026-09-06 更新为实测结论,不再是"未实测")**:上限以内走的是本说明 §6 描述、且已实测验证的那条路径。**超过上限后的"大 BOM 分批"路径,2026-09-05 在 222 上首次实测走不通;修复(#5501)落地并升级到 r11 后,2026-09-06 用同一个 13151 行合成项目复测,走通了完整链路(试算 → 后台展开 → 规划 → 分批写入)。**

- **首次实测(2026-09-05,修复前)**:试算返回 `large_bom_bounded`(`rowsExpanded=10000`、`readCount=20502`、`errorTypes=[max_rows_exceeded]`)→ 创建后台展开作业 → run 返回 `status=failed`、`errorTypes=[max_rows_exceeded]`、`authoritative=false`,`budgets={maxRows:10000, maxPages:100, maxReadCount:30000, maxElapsedMs:600000, maxDepth:20, maxArtifactChunks:1}` → plan 必然 422 `LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE`。
- **根因**:后台展开作业当时复用了交互试算的**同一套上限**。进入这条路径的唯一方式就是超过交互上限,后台再撞同一个数字,于是任何大到需要这条路径的项目都必然在这条路径里失败——按构造不可能成功。
- **修法**(#5501):后台展开作业改用自己的一套独立上限,交互试算行为**不变**。
- **复测通过(2026-09-06,r11,合成 13151 行项目)**:交互试算 `large_bom_bounded`(10000 行封顶,`readCount=20502`,`canApply=false`)→ 后台展开作业 `completed`(`rowsExpanded=13151`、`readCount=26959`、`frontierRemaining=0`,预算 `maxRows=200000`/`maxPages=1000`/`maxReadCount=600000`/`maxElapsedMs=3600000`,`errorTypes` 为空)→ 规划 `valid`(`add=13151`、`existingRows=0`、`manual_confirm=0`)→ 分批写入作业 `succeeded`:132 批 × 100,`created=13151`、`failed=0`,`hitGuardLimit=false`。用时:试算 6.7s、展开 8.5s、规划 2.3s、写入循环 453.6s(≈3.4s/批,主要是 HTTP 往返 + 每批落库),驱动脚本总耗时 472.8s。
- **唯一的坑,必须提前check**:动作配置里的 `projectSubtree` 块(§3.1)是**为客户 PLM 的列名写的**(`pathInfo.parentIdField=Parent_OBJ_ID`、`bomHead.pathIdField=path_id`)。如果切到的源(例如验证用的合成源)**没有这两列**,订单展开完成后一进入子树阶段,第一次读 `bomHead` 就会 SQL 报错,整份后台作业判 `status=failed`、`errorTypes=[read_failed]`(**不是规模类错误**),`authoritative=false`,plan 同样 422——现象和"规模超限"很像,但根因完全不同,不能按 §7.1 的预算表去调。2026-09-05 首次实测大 BOM 时就踩了这个坑(合成源当时缺这两列),交互试算的 10000 行上限在进入子树阶段之前就已经 `large_bom_bounded` 早退,所以这个坑此前从未暴露。**接手排查时先看是不是切换到了缺这两列的源**,不要先怀疑预算配置。
- **诊断缺口(#5507,截至本文核对时对抗核验已判可合,仅剩注释措辞未收尾)**:此前作业证据把 `readDiagnostics` 砍成布尔值、失败对象与错误码不落库也不打日志,任何 `read_failed` 都无法事后诊断,只能翻 PG 服务端日志(见新增的"运维排障"一节)。#5507 合入后,`GET` 作业记录会带上 `evidence.readFailures` / `errorDetails`(至多 20 条,**只含对象名、错误码、原因类**,永不含原始 `message`,保持 values-free)。

### 后台上限:缺省推导公式与 222 现行值

不写配置时,**后台上限 = 交互上限 × 倍数,再钳到代码硬顶**:

| 键 | 倍数 | 硬顶 | 222 现行交互值 | 推导出的后台值 |
|---|---|---|---|---|
| `maxRows` | ×20 | 1000000 | 10000 | **200000** |
| `maxPages` | ×10 | 100000 | 100 | **1000** |
| `maxReadCount` | ×20 | 5000000 | 30000 | **600000** |
| `maxElapsedMs` | ×6 | 21600000(6 小时) | 600000 | **3600000**(1 小时) |

`maxRows`/`maxPages` 交互侧不写时按代码默认(10000/100)作基数;`maxReadCount`/`maxElapsedMs` 交互侧不写即**无上限**,后台继承这一点(作业记录里显示为 `null`,不是 0),要设界就写进下面的 `largeBom` 块。`pageLimit`/`maxDepth` 后台仍用交互值——页大小与 BOM 树深度不是规模预算。

需要另行指定时,在动作配置里加可选的 `largeBom` 块(仅这四个键,值必须是正整数,超硬顶直接拒绝配置):

```json
{ "largeBom": { "maxRows": 200000, "maxPages": 1000, "maxReadCount": 600000, "maxElapsedMs": 3600000 } }
```

> **注意**:`largeBom` 里的值**允许低于**交互值——那会让后台比试算**更严**(试算能出 10000 行,后台却只让出 5000 行,于是这条路径照样失败)。这是允许的配置,但请知情:除非有意为之,`largeBom` 的每个值都应当 ≥ 对应的交互值。

### 怎么核对配置真的生效

`largeBom` 块**只影响后台展开作业**,交互试算的证据里看不到它——所以不能靠试算来核对。正确做法:对一个会超上限的项目**创建并运行一次后台展开作业**,然后看作业记录的 `budgets`,四个键 `maxRows`/`maxPages`/`maxReadCount`/`maxElapsedMs` 是否等于上表(或你写的显式值)。作业 run 之后返回体里就有 `budgets`,`GET .../large-bom/expansion-jobs/{jobId}` 也能读到;`budgets` 在作业**开始读源之前**就写好,所以即使这次 run 失败,它显示的也是本次真正生效的那组数字。

若客户单个项目展开后可能超过 10000 行,请在正式使用前告知我方,由我方按上述配置先行验证该路径,或据实际规模继续上调 `maxRows`。

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

## 9. 运维排障

**9.1 PG 服务端日志:位置与编码**

222 的 PostgreSQL 17 服务端日志在 `C:\Program Files\PostgreSQL\17\data\log\`。**应用连接用的数据库账号没有 `SHOW data_directory` 权限**(不是应用账号该有的权限),这个路径要靠运维直接在机器上确认,不能指望从应用侧的连接查出来。

日志文件在中文 locale 下是 **GBK 编码**,直接用 `Get-Content` 按默认编码读会出现乱码,正确做法:

```powershell
[IO.File]::ReadAllLines('C:\Program Files\PostgreSQL\17\data\log\<当天日志文件名>', [Text.Encoding]::GetEncoding(936))
```

排查任何"作业莫名其妙失败""SQL 报错但接口只给了一个笼统错误码"的场景,先按上面的方法把当天日志翻出来,搜时间戳附近的条目——2026-09-06 W3c 复测时,后台展开作业失败的真正原因(合成源缺 `path_id`/`Parent_OBJ_ID` 两列,见 §7.1)就是靠这条日志里一条"字段 \"path_id\" 不存在"的中文报错定位的,应用层的作业记录当时只给了一个 `read_failed` 的类型码。

**9.2 `audit_logs` 按月分区:自愈在中文 locale 下会失效**

`audit_logs` 表按月分区(`audit_logs_YYYY_MM`),数据库里有一个 `create_audit_partition()` 函数负责建**下个月**的分区,应用代码里还有一段自愈逻辑(`AuditRepository.ensureCurrentMonthPartition`)——写入时如果撞上"当月分区不存在",会自动尝试建当月分区再重试一次。

**这个自愈逻辑在中文 locale 的部署上从未真正触发过**:它靠一段英文正则(`/no partition of relation "audit_logs" found/i`)匹配 PostgreSQL 抛出的错误信息来判断"是不是缺分区这个原因",但中文 locale 下 PostgreSQL 返回的是中文报错文案,英文正则永远不命中,于是每一条本该触发自愈的写入都直接失败退出,不会自动建分区。**产品修复 PR #5506**:改成按 PostgreSQL 的 SQLSTATE(`23514`)识别"缺分区"这类错误,不再依赖报错文案的语言,中英文正则作为兜底(截至本文核对时状态为 OPEN,9 例测试绿)。

另外,`create_audit_partition()` 这个函数**目前没有任何调用者**——不在应用启动流程里,也没有接到每日调度上,纯手工才会被执行到;是否要把它接到启动检查或每日调度,记入 `48h-autonomous-run-record-20260906.md` 的待拍板清单。

**手工补分区的 SQL**(在自愈没接好、或需要提前把未来月份的分区建出来时用,`FOR VALUES FROM`/`TO` 按需改成对应月份的第一天):

```sql
CREATE TABLE IF NOT EXISTS audit_logs_2026_09 PARTITION OF audit_logs FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_10 PARTITION OF audit_logs FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
```

**已在 222 上实证有效**(2026-09-06):手工建好 2026_09/2026_10 两个分区后,重跑一次会写 `audit_logs` 的操作(两次 RBAC 授权 + 命名空间准入),`audit_logs_2026_09` 从 0 行变成 3 行,PG 服务端日志从此再没有新的 `audit_logs` 相关报错;补分区之前的两个时间点(当天 03:06:59 / 03:18:10)各有 3 条报错,与同一类授权写入一一对应。

**运维建议**:不论 #5506 合入与否,建议**每月检查一次下一个月的分区是否已存在**(`SELECT to_regclass('audit_logs_<下月 YYYY_MM>')` 不为空即已存在),提前手工建好,不要等到写入失败才发现——尤其在自愈逻辑修复上线前,这是唯一的保险手段。

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
