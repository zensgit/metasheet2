# 运行手册：在演示机上打开「一个项目一张备料表」（G1 开关，ADR §8 第 6 步）—— 方案②：项目 A 也新建项目表并重拉

> 依据：ADR `adr-stock-prep-project-sheets-20261008.md` §8 第 6–9 步（以下简称 ADR）；决策登记 R-35（S1）、R-37（S3）、R-38（S4）、R-39（S5）。请求来源：#6079 评论 6162564175（旧机 2026-10-14「请开发机给出 G1 开启 runbook」）。项目 A 的处理方式见 #6079 评论 6163355460（owner 2026-10-14）、6163619046 / 6163627800（旧机核出的代码事实与演示机现状）、6163639415（开发机同意方案②）。
> **基线**：origin/main `ec8d97cc4`（`ec8d97cc481d3c6835a97c197a93cd00d10151e2`）。下文所有 `path:line` 都在这个提交上核过。演示机跑的是 R66（tag `onprem-r66` = `e2345ab6b`，`r66-deploy-record-20261013.md:7`）；`git diff --stat onprem-r66 ec8d97cc4` 在本手册引用的后端、脚本、迁移目录里**没有差异**（前端只差 `StockPreparationProjectSyncPanel.vue`，本手册不引它），所以行号对演示机同样成立。
> **开不开、什么时候开、项目 A 怎么处理，由 owner 决定。** §0 照录已有的 owner 裁决；未裁的项不替 owner 选，只在协调方给过建议的两项（D15、D9）写明「建议」。在演示机上执行任何一步（含只读 SQL）都是 owner 动作，在旧机上执行。
> **values-free**：不含主机、地址、口令、令牌、账号名、真实项目号。项目号一律写 `<项目号>`（需要区分时写 `<项目号 A>`、`<项目号 B>`）；`<旧表 sheetId>`、`<安装根目录>`、`<令牌文件>`、`<后端直连地址>` 等占位符在执行时替换，替换后的值只记在私有记录里，不贴进 issue / PR。命令是 ASCII，可在 Windows PowerShell 5.1 下执行。

## 这个开关做什么、不做什么

- 开关是 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`（`plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs:63`），**只认精确的小写 `true`**（`:97-100`：`' true'`、`TRUE`、`1` 都算关）。代码每次调用都读 `process.env`，但 `process.env` 只在进程启动时从 `app.env` 载入（`ecosystem.config.cjs:25-52`），所以**改了 `app.env` 必须按 §2.4 重启**。登记在 `scripts/ops/global-history-flag-manifest.mjs:674`（`danger: 'high'`）。
- 开了之后：
  - 每条备料读写路由按项目号去登记表 `integration_stock_prep_project_target`（迁移 `packages/core-backend/migrations/087_create_integration_stock_prep_project_target.sql:1`）找这个项目的表，**只查登记表、不回落到 env 里绑定的那张表**；没登记的项目一律 409 `STOCK_PREPARATION_PROJECT_ABSENT`（`stock-preparation-project-targets.cjs:202-233`）。所以「项目 A 继续用旧表」和「开 G1」不能同时成立（旧机 6163619046）。
  - 拉取人员（`stock-prep:pull`，`plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs:91`、`:579-580`）在工作台「拉一个新项目」时为一个项目新建一张受管表并登记（`plugins/plugin-integration-core/lib/http-routes.cjs:9567`，下称「建表路由」）。
  - 建表后按 G1 角色清单 `MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`（`stock-preparation-project-targets.cjs:67`，读取 `:103-112`；登记 `global-history-flag-manifest.mjs:685`）给这些角色在新表上授 `spreadsheet:write`，在项目总览表上授 `spreadsheet:read`（`packages/core-backend/src/multitable/plugin-scope.ts:704-753`、`:757-812`）。
- **项目 A（方案②，D15 建议答案）**：A 也经建表路由新建一张项目表，从 PLM 重拉；env 里绑定的 744 行旧表留作**只读参照**，不登记、不迁移、不删除——即 ADR Q3 / §3.1 的原裁决（ADR 第 15 行、第 163-171 行）**照旧成立**。旧机只读核过旧表：六个人工列里只有「审批状态」3 行有值，其余全空；自动化只有 1 条测试规则（6163619046）。这 3 个值由人工补录或忽略（D8b）。
- **代码里没有「登记一张已有表」的路由**：登记表唯一的写入方是 `store.create`（`plugins/plugin-integration-core/lib/stock-preparation-project-target-store.cjs:362-407`），只被建表路由调用；ADR §3.1 有意删掉了 v1 的 register-bound 路由（`adr-stock-prep-project-sheets-20261008.md:171`）。owner 坚持保留旧表数据时的绕行办法见**附录「备选：一次性 SQL 认领」**。
- **不做**：不删任何表；不撤销任何已有授权（D9）；不开「成员与权限」页（那是另一个开关 `STOCK_PREP_MEMBERS_PAGE_ENABLED`，`packages/core-backend/src/services/stock-preparation-members.ts:143`、`:281-282`，见 D10）。
- **开过之后再关 ≠ 回到今天**：见 §5。

## 0. owner 决策清单（每条回「是 / 否」；未回答的项不执行 §2）

已有的 owner 裁决（照录，不再问）：
- **R1**（2026-10-14，6163355460）按「一张备料表一个项目」走。
- **R3**（同上，旧机已执行）每日 06:00 试拉的项目清单已从项目 B 改为项目 A。

项目 A 的处理方式（说明，不是裁决）：owner 10-14 帖原话是把 744 行表「认领」为 A 的登记表、不重建；旧机随后核出旧表人工数据几乎为空，建议改走方案②（A 也新建表重拉，旧表只读参照），开发机同意（6163639415）。**这个改变要 owner 在 D15 确认。**

待 owner 回答：

- [ ] **D1** 在本次维护窗口打开 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`？ 是 / 否
- [ ] **D2** 接受「开过之后再关 = 停用除 A 以外的拉取，且 A 又写回旧表」（§5）？ 是 / 否
- [ ] **D3** 任命拉取人员（`stock-prep_puller` 今天 0 成员，§1.3 核对）？ 是（任命谁记在私有记录） / 否（建表由平台管理员自己做）
- [ ] **D4a** G1 角色清单包含 `stock-prep_frontline`「操作人员」？ 是 / 否
- [ ] **D4b** G1 角色清单包含 `stock-prep_puller`？ 是 / 否
- [ ] **D4c** G1 角色清单包含 `stock-prep_admin`？ 是 / 否
- [ ] **D4d** G1 角色清单包含 `stock-prep_developer`？ 是 / 否
- [ ] **D5** 接受「表级 `spreadsheet:write` 同时打开这张项目表的字段和视图管理」（ADR §11.7；一线今天在旧表上就是这一级）？ 是 / 否
- [ ] **D15** 项目 A 走方案②——经建表路由新建项目表、从 PLM 重拉，旧 744 行表留作只读参照、不删（§3.4）？ 是 / 否 —— **建议：是**
  - 选「否」= 方案①：一次性 SQL 把旧表登记为 A 的表（**附录**）。只在 owner 坚持保留旧表数据时考虑；后果：没有审计行；G1 端口只接受 `_p_` 形状的对象，对旧表回 422（`plugin-scope.ts:719-726`），G1 永远不会给它授权；对 A 再调建表路由会 422 / 500；成员页加 A 会 422。认领路由不再开发（6163639415）。
- [ ] **D7** 项目 B 用建表路由新建自己的表（§3.5）？ 是 / 否
- [ ] **D8a** 新建的项目表一开始是空表，人工列为空；自动化、提醒、自建视图按表配置，不会从旧表带过去——由 owner 通知客户（ADR §8 第 9 步）？ 是 / 否
- [ ] **D8b** A 的新表上，旧表那 3 行「审批状态」由人工补录？ 是（补） / 否（忽略）
- [ ] **D9a** 暂时保留 `stock-prep_frontline` 在旧表上的表级授权（ADR §8 第 5 步原写「撤销或降为只读」）？ 是 / 否 —— **建议：是（暂留）**。旧表现在是参照，授权以后随时可以在「权限」里撤或降为只读（`packages/core-backend/src/routes/univer-meta.ts:9859`）。
- [ ] **D9b** 暂时保留旧表上那 1 条测试自动化（不暂停）？ 是 / 否 —— **建议：是（暂留）**，理由同上。
- [ ] **D10** 同时打开「成员与权限」页（`STOCK_PREP_MEMBERS_PAGE_ENABLED`），并接受下面四条 S5b 锁行为？ 是 / 否
  - 成员页在写某个角色时，该角色的成员提交审批、审批写回（FWB）自动化、写记录关联会排队等它，最长约 20 秒；
  - 对同一角色约 20 个并发写可以占满默认 20 连接的连接池（评审实测：无关的 `SELECT 1` 等了约 5.3 秒）；
  - 插入型的授予人降级（授予人原来没有直授行、对其做较低级别的直授，或加入一个级别更低的成员组）不加锁，与一次进行中的项目表添加之间没有先后保证；
  - 等连接池连接没有上限，只有连接超时（默认 10 秒）兜底。
  （原文：`scripts/ops/global-history-flag-manifest.mjs:800`，结尾写明「OWNER ACCEPTANCE REQUIRED」。D10 选「否」时这四条都不发生：G1 建表路由本身不锁角色行，只锁表行，`packages/core-backend/src/services/stock-preparation-project-sheet-grants.ts:156-172`。）
- [ ] **D11** 给一线（操作人员）评论写权限 `comments:write`？ 是 / 否
  （R66 回归里一线会话的评论接口 403 是**开关开不开都存在**的现状，`r66-deploy-record-20261013.md:42`。评论接口只用全局码判权：读 `rbacGuard('comments','read')`，`packages/core-backend/src/routes/comments.ts:638`、`:658`；写 `rbacGuard('comments','write')`，`:758`。`comments` 不受命名空间准入控制，`packages/core-backend/src/rbac/namespace-admission.ts:17`。若选「是」，按 ADR §8 第 3 步方案 ① 的同一理由，这个平台码不能放进内置角色 `stock-prep_frontline`；放在哪个平台角色上由 owner 定。）
- [ ] **D13** 项目 B 登记之后，把每日试拉的项目清单改回多项目（A + B + 之后建表的项目）？ 是 / 否
- [ ] **D14** 约定维护窗口（重启期间后端约半分钟不可用，§2.4）？ 是（时间记私有记录） / 否

D4a–D4d 都选「否」= 清单不写（G2：新建的项目表没有任何角色能打开，平台管理员逐表在「权限」里手工授权，ADR §2；建表路由返回 `grant.skipped = 'no_roles_configured'`，`stock-preparation-project-targets.cjs:302`）。

**清单的硬约束（代码决定，不是 owner 选项）**：
- 只收 `stock-prep` 命名空间里的角色 id：`stock-prep` 或 `stock-prep_<字母数字开头，[A-Za-z0-9_-]，至多 64 位>`（`packages/core-backend/src/multitable/stock-preparation-project-sheet-grant-contract.ts:42`、`:50`、`:78-108`）。**不排除 `_admin` 后缀**：`stock-prep_admin` 可以进清单。**`approvals_operator` 不能写进去**：会得 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE`，整次授权一个都不写。一线成员同时持有 `stock-prep_frontline`，靠它就能打开项目表。
- 清单里每个角色都必须存在，缺一个就整批拒绝（404 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND`，`stock-preparation-project-sheet-grants.ts:158-172`）。
- 授权级别写死 `spreadsheet:write`，只增不删：唯一的写语句是 `ON CONFLICT DO NOTHING` 插入（`stock-preparation-project-sheet-grants.ts:187-195`）；以后从清单里去掉某个角色，**不会**撤销已经授出去的行。
- **先登记、后授权**：授权被拒时，表和登记行已经建好、`project_target_create` 审计已写，只是没有授权行（`http-routes.cjs:9715`、`:9770`）。改好清单、按 §2.4 重启后，对同一个项目号再 POST 一次建表路由即可补授权（返回 200，「重放」分支先补授权，`http-routes.cjs:9596-9616`、`:9663-9687`；用例 `plugins/plugin-integration-core/__tests__/stock-preparation-project-target-routes.test.cjs:756-774`）。
- 写法：英文逗号分隔，前后空格会被去掉，重复的去重（`stock-preparation-project-targets.cjs:103-112`）。不要加引号。

## 1. 只读预检（开开关之前）

在旧机上执行，结果只记计数与「是 / 否」。SQL 用旧机上机记录里一直在用的执行方式（psql 完整路径、连接串从 `app.env` 读、不回显）；多行 SQL 存成 **ASCII** 文件再 `-f` 执行（Notepad 另存时选 ANSI，或 `Set-Content -Encoding ASCII`；不要存成带 BOM 的 UTF-8，psql 会把 BOM 当语法错误）。每个文件首尾包一层只读事务：

```
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
-- (the SQL of the section goes here)
ROLLBACK;
```

### 1.1 `app.env` 与进程环境：三个新键都不存在，沙箱写入门的两个键都在

旧机 10-14 已只读核过（6163627800）：三个新键都未设；`STOCK_PREP_SANDBOX_MODE` 为精确 `true`；`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 恰为部署原有目标的 objectId。上机当天再跑一次：

```
$envFile = '<安装根目录>\docker\app.env'
foreach ($k in 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED','MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS','STOCK_PREP_MEMBERS_PAGE_ENABLED','STOCK_PREP_SANDBOX_MODE','STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS','INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH') {
  $n = @(Select-String -LiteralPath $envFile -Pattern ('^\s*' + [regex]::Escape($k) + '\s*=')).Count
  $m = [bool][Environment]::GetEnvironmentVariable($k, 'Machine')
  $u = [bool][Environment]::GetEnvironmentVariable($k, 'User')
  '{0} app.env={1} machine={2} user={3}' -f $k, $n, $m, $u
}
```

只打印计数和布尔值；以 `#` 开头的注释行不计。文件开头若有 BOM，`Select-String` 读取时自己会去掉（开发机 PS 5.1 实测），第一行的键照样计入。期望：

| 键 | 期望 | 不符时 |
|---|---|---|
| `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`、`MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`、`STOCK_PREP_MEMBERS_PAGE_ENABLED` | `app.env=0 machine=False user=False` | **停**，报 owner。原因：后端经 `ecosystem.config.cjs` 读 `app.env` 时同一个键取**第一次**出现的那行，且不覆盖进程里已有的同名变量（`ecosystem.config.cjs:42`）；升级脚本导入时取最后一次（`stock-prep-root-selection-config.md:30` 的说明）。文件里已有一行时再在末尾追加，两种读法会得出不同结果 |
| `STOCK_PREP_SANDBOX_MODE`、`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` | `app.env=1` | 新建的项目表（A、B）写入时走写入门的项目表分支，四个条件同时成立才放行：开关开；objectId 是登记行里那个、且是 `_p_` 项目表形状；`STOCK_PREP_SANDBOX_MODE` 恰为 `true`；部署 env 动作**原有**目标的 objectId 在 `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 里（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:2502-2511`，策略读取 `:2525-2539`）。缺一个就停：开了也只能预览不能写入 |
| `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` | 记下计数 | 见 1.6 |

### 1.2 登记表与项目表：今天应当全是 0

```
SELECT status, count(*) FROM integration_stock_prep_project_target GROUP BY status;
SELECT count(*) FILTER (WHERE starts_with(object_id, 'plm_stock_preparation_sandbox_p_')) AS project_sheets,
       count(*) FILTER (WHERE object_id = 'plm_stock_preparation_project_overview') AS overview_sheets
  FROM plugin_multitable_object_registry WHERE plugin_name = 'plugin-integration-core';
```

期望：第一条 0 行；第二条 `0 | 0`。项目表 objectId 前缀见 `plugins/plugin-integration-core/lib/stock-preparation-own-base.cjs:129-130`，总览表 objectId 见 `packages/core-backend/src/multitable/stock-preparation-overview-contract.ts:65`。不为 0 说明有人在别处开过开关或登记过，停下报 owner。

### 1.3 角色：五个角色在，拉取人员 0 成员

```
SELECT r.id,
       (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id) AS members,
       (SELECT string_agg(rp.permission_code, ',' ORDER BY rp.permission_code) FROM role_permissions rp WHERE rp.role_id = r.id) AS codes,
       EXISTS (SELECT 1 FROM stock_prep_role_template_seeds s WHERE s.role_id = r.id) AS seeded_by_migration
  FROM roles r
 WHERE r.id IN ('stock-prep_admin', 'stock-prep_puller', 'stock-prep_developer', 'stock-prep_frontline', 'approvals_operator')
 ORDER BY r.id;
SELECT count(*) AS legacy_operator_role FROM roles WHERE id = 'stock-prep-operator';
```

期望（模板码见 `packages/core-backend/src/db/migrations/zzzz20261010124500_seed_stock_prep_role_templates.ts:90-111`，账本表 `:198`）：5 行；`stock-prep_admin` = `stock-prep:admin`；`stock-prep_puller` = `stock-prep:operate,stock-prep:pull,stock-prep:read`，**members = 0**（D3）；`stock-prep_developer` = `stock-prep:read`；`stock-prep_frontline` = `stock-prep:operate,stock-prep:read`；`approvals_operator` 3 个码；`legacy_operator_role = 0`（R66 已删，`r66-deploy-record-20261013.md:31`）。D4 选中的角色必须都在这 5 行里且不是 `approvals_operator`。`seeded_by_migration` 只是记录（R63 手建后被采纳的 `stock-prep_puller` 为 false 属正常）。

### 1.4 旧表（只读参照）：找到它，记下基线

```
SELECT o.sheet_id, o.object_id, (SELECT count(*) FROM meta_records m WHERE m.sheet_id = o.sheet_id) AS rows_total
  FROM plugin_multitable_object_registry o
 WHERE o.plugin_name = 'plugin-integration-core'
   AND starts_with(o.object_id, 'plm_stock_preparation_sandbox')
   AND NOT starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_')
 ORDER BY rows_total DESC;
```

`rows_total` 约 744 的那一行就是（旧机 10-14 诊断：744 行）。记下它的 `sheet_id`（= `<旧表 sheetId>`）。再核对它确实是 env 动作的目标：`@(Select-String -LiteralPath $envFile -SimpleMatch -Pattern '<旧表 sheetId>').Count` 应 ≥ 1（只看计数）。

**记下基线**（§3.6 用来证明旧表没被动过）：

```
SELECT count(*) AS rows_total, max(updated_at) AS last_row_update FROM meta_records WHERE sheet_id = '<旧表 sheetId>';
```

### 1.5 旧表上的授权（D9a 的依据）

```
SELECT subject_type, CASE WHEN subject_type = 'role' THEN subject_id ELSE '(user)' END AS subject, perm_code, count(*)
  FROM spreadsheet_permissions WHERE sheet_id = '<旧表 sheetId>'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

预计有 `role | stock-prep_frontline | spreadsheet:write | 1`（R66 搬过来的那行，`r66-deploy-record-20261013.md:30`）。用户主体只打印 `(user)`，不出用户 id。

### 1.6 客户包：建 A、B 的表时会把它重装到新表上

建表路由在建表**之前**先按部署原有目标的安装台账算出要重装哪些客户包，并做预检（`http-routes.cjs:9624-9698`）。三种已知会拒绝的情形，都在建表之前、什么都还没建：

- 部署声明的 `ext_` 列没有任何已装客户包能覆盖：409 `STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE`（`stock-preparation-project-targets.cjs:401-405`）；
- 客户包含列写权规则，而这次登录的令牌没有已验证的租户声明：403 `STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED`（`stock-preparation-project-targets.cjs:345-365`）；
- 客户包的列写权规则指名了不存在的角色：422 `CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN`（`plugins/plugin-integration-core/lib/stock-preparation-customer-pack-installer.cjs:594`、`:976-990`）。

```
SELECT pack_id, pack_version, status, starts_with(object_id, 'plm_stock_preparation_sandbox_p_') AS on_project_sheet
  FROM integration_stock_prep_pack_installs ORDER BY 4, 1;
```

旧机诊断里有 1 行指向旧表的对象（迁移 `076_create_integration_stock_prep_pack_installs.sql:49`）。若有，再看包目录文件（`app.env` 键 `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` 指向的文件，`packages/core-backend/src/plugin-runtime-config.ts:6`、`:118-120`），只看计数：

```
@(Select-String -LiteralPath '<包目录文件>' -SimpleMatch -Pattern 'stock-prep-operator').Count
@(Select-String -LiteralPath '<包目录文件>' -SimpleMatch -Pattern 'fieldWritePolicies').Count
```

第一条应为 0（不为 0 = R66 已删的旧角色还被包指名，会 422，改包文件由 owner 定）。第二条大于 0 = 建表那次登录要带租户声明，否则 403。

### 1.7 每日试拉：任务与脚本版本（§2.0、§4 的依据）

```
Get-ScheduledTask | Where-Object { $_.TaskName -like '*stock-prep*' } | Select-Object TaskPath, TaskName, State
(Get-ScheduledTask -TaskName 'metasheet-stock-prep-scheduled-dry-run').Actions | Select-Object Execute, Arguments, WorkingDirectory
@((Get-ScheduledTask -TaskName 'metasheet-stock-prep-scheduled-dry-run').Actions | Where-Object { $_.Arguments -like '*--apply*' }).Count
```

第二条给出任务执行的脚本路径（只记在私有记录里，`<试拉脚本路径>`）；第三条期望 0（只试算；`--apply` 必须显式写，`scripts/ops/stock-preparation-scheduled-pull.mjs:148`）。项目清单在它的 env 文件 `MS_PROJECT_NOS` 里（`:75`），10-14 起是项目 A（R3），不贴值。

再看演示机上那份脚本有没有「登记表缺行 = 跳过」的分支：

```
@(Select-String -LiteralPath '<试拉脚本路径>' -SimpleMatch -Pattern 'skipped_project_sheet_absent').Count
```

旧机 10-14 核过：演示机装的是 R10 时期的拷贝，计数为 0（6163627800）。仓库现版（#6282 起）把 409 `STOCK_PREPARATION_PROJECT_ABSENT` / `…_ARCHIVED` 当作「跳过」、不改退出码（`scripts/ops/stock-preparation-scheduled-pull.mjs:523-536`）；旧拷贝会把它当失败。**计数为 0 就必须在开开关之前做 §2.0。**

### 1.8 停下来的条件（任一成立就不进 §2）

1.1 三个新键任一已存在；沙箱两个键缺；1.2 不为 0；1.3 少角色或 D4 选了不存在 / 不在命名空间的角色；1.6 第一条不为 0；§0 有未回答的项。

## 2. 换试拉脚本、写 `app.env`、重启（维护窗口内，D1 = 是之后）

### 2.0 先把每日试拉脚本换成 `onprem-r66` 的版本（开开关之前）

脚本只依赖 Node 内置模块（`scripts/ops/stock-preparation-scheduled-pull.mjs:120`），环境变量（`MS_API` / `MS_TOKEN` / `MS_PROJECT_NOS` …）和参数自 #5493 以来没变，所以原样替换同一路径即可，任务与 env 文件都不用改。取法与 R66 两个运维脚本相同（`runbook-operator-merge-20261012.md:21-39`：Git Bash 或 PowerShell 7.4+，用 `git archive`，不要 shell 重定向）：

```
git -c core.autocrlf=false archive --format=tar onprem-r66 scripts/ops/stock-preparation-scheduled-pull.mjs | tar -x -C <空目录>
git hash-object --no-filters <空目录>/scripts/ops/stock-preparation-scheduled-pull.mjs
git rev-parse onprem-r66:scripts/ops/stock-preparation-scheduled-pull.mjs
```

后两条输出必须相同（`onprem-r66` 上这个文件的 blob 是 `21d97b38eae1abf7750a276125a5dc0527739a7d`）。再算 SHA-256 记入台账；拷到服务器后用 `Get-FileHash -Algorithm SHA256` 逐字比对。服务器上：

```
Copy-Item -LiteralPath '<试拉脚本路径>' -Destination ('<试拉脚本路径>' + '.pre-r66-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath '<拷贝路径>' -Destination '<试拉脚本路径>' -Force
@(Select-String -LiteralPath '<试拉脚本路径>' -SimpleMatch -Pattern 'skipped_project_sheet_absent').Count
Start-ScheduledTask -TaskName 'metasheet-stock-prep-scheduled-dry-run'
```

计数应 ≥ 1。开关还关着时手动触发一次：任务 result 应仍为 0，日志里 A 那一行与 10-14 相同（`dryRunHttpStatus 200 … action skipped_dry_run_only`），说明换脚本没有改变今天的行为。

### 2.1 备份

照旧机惯例先做一次 `pg_dump -Fc` 备份，再备份 `app.env`：

```
$envFile = '<安装根目录>\docker\app.env'
Copy-Item -LiteralPath $envFile -Destination ($envFile + '.pre-g1-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
```

### 2.2 追加两行

`<G1 角色清单>` 换成 D4 选中的角色 id，英文逗号分隔，例如三个都选时写成 `stock-prep_frontline,stock-prep_puller,stock-prep_admin`（只是格式示例，不是建议）。D4 全选「否」时**不写第二行**。

```
$lines = "`r`nMULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED=true`r`nMULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS=<G1 角色清单>`r`n"
[System.IO.File]::AppendAllText($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
```

D10 = 是时，把 `` `r`nSTOCK_PREP_MEMBERS_PAGE_ENABLED=true `` 拼在同一个字符串末尾（同样只认小写 `true`，`stock-preparation-members.ts:281-282`）。

为什么这样写：
- 开头的 `` `r`n `` 保证原文件末尾没有换行时，新键不会粘到最后一行上（多出一个空行无害，解析器跳过空行，`ecosystem.config.cjs:29-31`）。开发机 PS 5.1 实测：原文件末尾无换行时，去掉开头的 `` `r`n ``、或改用 `Add-Content`，开关那一行都会粘到上一行末尾，2.3 的计数变成 0。
- **不要**用 `Out-File`、`Set-Content -Encoding UTF8` 或 `>` 重写整个文件：PS 5.1 下它们会写 BOM 或 UTF-16。`AppendAllText` 追加模式不写 BOM，内容是纯 ASCII。CRLF 与 LF 混用不影响解析（按 `\r?\n` 切行，`ecosystem.config.cjs:29`）。
- 值不要加引号、不要有空格；不要写 `True` / `TRUE`。

### 2.3 追加后核对

```
foreach ($k in 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED','MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS','STOCK_PREP_MEMBERS_PAGE_ENABLED') {
  '{0} {1}' -f $k, @(Select-String -LiteralPath $envFile -Pattern ('^\s*' + [regex]::Escape($k) + '\s*=')).Count
}
Get-Content -LiteralPath $envFile -Tail 3
```

前两个键各恰为 1（D4 全否时第二个为 0），第三个 D10 = 是时为 1、否则 0；末尾几行就是刚追加的内容（`true` 和角色 id 都不是秘密）。

### 2.4 重启：加键走「导入 `app.env` + `pm2 restart --update-env`」，删键走计划任务

演示机后端由计划任务 `MetaSheet-PM2` → pm2-runtime 托管，`PM2_HOME` 是 pm2-runtime 的运行目录 `.pm2-runtime`（`handoff-r59-two-machine-20260924.md:22`；本手册引用的 `runbook-operator-merge-20261012.md` §0.6 讲的是怎么执行与落日志，不含 pm2 home，别在那里找）。

**加键（本手册开关：§2.2 追加的键）**：10-12 云课堂开关与 10-14 G1 开关都是这样重启的——先把 `app.env` 导入**当前进程**的环境，再在 `PM2_HOME` 指向 `.pm2-runtime` 的会话里跑 `pm2 restart metasheet-backend --update-env`。`--update-env` 合并的是执行命令的会话的环境（不重读 `app.env`，`222-rehearsal-full-run-20260904.md:200`），所以「先导入」这一步不能省。每一步带门：

1. 重启前：pm2 命名管道 `\\.\pipe\rpc.sock` 存在，且 `pm2 list` 里 `metasheet-backend` 是 `online`；不满足就停，不要在管道上没有守护进程时硬跑 `restart`（会另起一个空守护进程，`handoff-r59-two-machine-20260924.md:39`）。
2. 跑 `pm2 restart … --update-env`，**检查退出码**，非 0 就停。
3. 记下重启时刻 T0；T0 之后后端日志里必须出现 `Plugin loaded: plugin-integration-core`，否则按没起来处理。
4. 失败时**维护标志保持开着**，不要自行放行；报开发机。

**删键**：`--update-env` 不会撤掉已从 `app.env` 删掉的键（`design-large-bom-worker-20260906.md:350`），进程环境里旧值还在。所以 §5 回退（字节级还原会让追加的键消失）必须走计划任务：在 `PM2_HOME` 指向 `.pm2-runtime` 的会话里停应用 → 等 `MetaSheet-PM2` 任务离开 `Running` 状态（`Get-ScheduledTask … | Select-Object State`）→ 确认 pm2 命名管道上已没有守护进程（任务停掉后还在的是多余的 `node …\pm2\lib\Daemon.js` 进程：**不要 `pm2 kill`**——Windows 上管道名是整机共用的，`pm2 kill` 会打到占着管道的任何守护进程；用 `Get-CimInstance Win32_Process` 按 CommandLine 过滤出它，再按 pid `Stop-Process -Id`，做法见 `runbook-backend-log-rotation-20261012.md` §3.8；为什么会冒出这样的多余进程见 `handoff-r59-two-machine-20260924.md:39`）→ `Start-ScheduledTask -TaskName 'MetaSheet-PM2' -TaskPath '<任务所在文件夹>'` → 确认进程已重新拉起（后端进程的父进程是 pm2-runtime，不是 `Daemon.js`，`handoff-r59-two-machine-20260924.md:52`）→ 查 health。

**是否真的生效，以 §3.1 的接口状态为准**，不以 `app.env` 内容为准；也**不要**为了看环境去跑 `pm2 env`——pm2-runtime 不在守护模式下时，会话里的 pm2 命令会另起一个空守护进程（`handoff-r59-two-machine-20260924.md:50`）。

## 3. 开后核对

### 3.1 哪些接口从 404 变成 200

开关关着时，下列路由在**权限门之后、任何 IO 之前**回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`（`http-routes.cjs:4788-4792`；路由表 `:217-257`；每个处理函数都是「先 `requireAccess`、再 `requireProjectSheetsEnabled()`」，`:9476-9478`、`:9567-9569`、`:9824-9826`、`:9857-9859`、`:9887-9889`、`:9955-9957`、`:9975-9977`、`:10031-10033`、`:10127-10129`）。开了之后：

| 路由 | 门 | 开后期望 |
|---|---|---|
| `GET /api/integration/stock-preparation/project-targets` | OPERATE | 200，建表前 0 条 |
| `GET /api/integration/stock-preparation/projects/:projectNo/target` | OPERATE | 200，建表前 `status: 'absent'`；拉取人员 `may.create = true`，其他人 false（`:9510`、`:9538-9542`） |
| `POST …/projects/:projectNo/target` | PULL | 建表（201 新建 / 200 已登记，`:9803`），见 3.4 / 3.5 |
| `POST …/target/archive`、`POST …/target/restore` | PULL | 归档 / 恢复（S4），本手册不用 |
| `GET` / `PATCH …/target/project-fields` | OPERATE | 项目级列（S3） |
| `POST /api/integration/stock-preparation/project-overview/refresh` | OPERATE | 总览刷新；**从不建表**，总览不存在时 409 `STOCK_PREPARATION_PROJECT_OVERVIEW_ABSENT`（`plugins/plugin-integration-core/lib/stock-preparation-project-overview.cjs:30-32`、`:113`） |
| `POST /api/integration/stock-preparation/project-overview/ensure` | PULL | 建总览并给清单角色授读（`http-routes.cjs:4521-4562`、`stock-preparation-project-overview.cjs:408-430`）；建表路由已顺带建过时什么都不新建 |
| `GET /api/integration/stock-preparation/preflight` | READ | 多出 `checks.projectSheets`：`enabled: true`、`grantRoleCount` = D4 选中的个数、`registeredCount` = 登记行数（`plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs:496-512`；开关关时没有这个键） |
| `GET /api/integration/stock-preparation/members` 等四条成员路由 | WORKBENCH_ADMIN | D10 = 否：仍是 404 `STOCK_PREP_MEMBERS_PAGE_DISABLED`（`:4716-4720`）；D10 = 是：200 |

用旧机现成的带令牌只读探针（令牌从文件读、不回显），只打印状态码和错误码：

```
$base = '<后端直连地址>'
$h = @{ Authorization = 'Bearer ' + (Get-Content -Raw -LiteralPath '<令牌文件>').Trim() }
$probes = [ordered]@{ list = '/api/integration/stock-preparation/project-targets'; target = '/api/integration/stock-preparation/projects/<项目号>/target'; preflight = '/api/integration/stock-preparation/preflight'; members = '/api/integration/stock-preparation/members' }
foreach ($name in $probes.Keys) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Headers $h -Uri ($base + $probes[$name])
    $extra = ''
    if ($name -eq 'preflight') { $extra = (($r.Content | ConvertFrom-Json).data.checks.projectSheets | ConvertTo-Json -Compress) }
    if ($name -eq 'target') { $extra = ($r.Content | ConvertFrom-Json).data.status }
    '{0} {1} {2}' -f $name, $r.StatusCode, $extra
  } catch {
    $resp = $_.Exception.Response
    $status = 0; $code = ''
    if ($resp) {
      $status = [int]$resp.StatusCode
      try {
        $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
        if ($body) { $code = ($body | ConvertFrom-Json).error.code }
      } catch {}
    }
    '{0} {1} {2}' -f $name, $status, $code
  }
}
```

开前跑一次（期望 `list 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED` 等），开后再跑一次（`list 200`、`target 200 absent`）。`list` 仍是 404 就是开关没进进程：回 §2.3 / §2.4，不要反复重启。

### 3.2 界面（管理员会话 + 一线测试账号会话，刷新页面）

- 备料工作台**首页**多出「每个项目一张备料表 / 已经有 N 个项目建了表」一块（`apps/web/src/components/integration/stockPreparation/StockPreparationOperatorHome.vue:69-79`；只有 `project-targets` 回 200 时才渲染）。
- **项目总览不是一个页签**，是这一块里的按钮：拉取人员在总览还没建时看到「建立项目总览」，建好后看到「刷新项目总览」「打开项目总览」（`StockPreparationOperatorHome.vue:82-130`）。
- 首页原来的「打开备料多维表」按钮**消失**：开关开时目录不再按 env 解析表（`http-routes.cjs:11054-11069`；按钮 `StockPreparationOperatorHome.vue:47-66` 只在有 `fillTarget` 时出现）。项目卡片改由登记行列出（`http-routes.cjs:11071-11083`）：**A 的卡片在 A 的新表建好、登记之前会从首页消失**，建好后回来、指向新表。旧表还在多维表左侧列表里，有授权的人照样能打开（参照用）。
- 「成员与权限」导航项只在 D10 = 是、且登录者是平台管理员或已开通准入的备料主管理员时出现（`apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue:401-406`、`:517-524`）。D10 = 否时没有它，是正常的。
- 一线账号进项目备料页、输入一个还没建表的项目号：显示「表还没建好」类提示，不报错（看板把 `STOCK_PREPARATION_PROJECT_ABSENT` 当成未建表，`http-routes.cjs:11766-11782`）。

### 3.3 任命拉取人员（D3 = 是时）

两步，缺一不可（ADR §11.1）：在「角色管理 / 用户管理」里给这个人 `stock-prep_puller`；再给他「开通插件使用」（`apps/web/src/views/UserManagementView.vue:667`）——`stock-prep` 是准入受控命名空间（不在 `namespace-admission.ts:11-38` 的豁免清单里），只有角色没有准入，码不生效。核对：

```
SELECT count(*) AS puller_members, count(*) FILTER (WHERE a.enabled) AS puller_admitted
  FROM user_roles ur
  LEFT JOIN user_namespace_admissions a ON a.user_id = ur.user_id AND a.namespace = 'stock-prep'
 WHERE ur.role_id = 'stock-prep_puller';
```

两个数相等且 ≥ 1。权限缓存最长 60 秒（`packages/core-backend/src/rbac/service.ts:13`），等一分钟后让他**刷新页面**，首页卡片标题应变成「拉一个新项目」（`StockPreparationOperatorHome.vue:160`；没有拉取权时显示「打开一个项目」）。

D3 = 否时由平台管理员建表（平台管理员直接满足所有档，`stock-preparation-workbench-access.cjs:572`）；注意 1.6 第二条大于 0 时，这次登录要带租户声明。

### 3.4 项目 A：经建表路由新建项目表并重拉（D15 = 是）

拉取人员操作：首页「拉一个新项目」→ 输入 `<项目号 A>` → 项目备料页的项目接入面板「从PLM拉取数据」→ 确认框「将为这个项目号新建一张备料表」→「新建备料表并拉取」（文案 `apps/web/src/services/integration/stockPreparation/plainLanguage.ts:2325`、`:2343`、`:2348`）→ 预览「将写入 N 行」→ 确认写入（apply 什么时候做由 owner 定；旧机 10-14 帖：写入等 owner）。取消预览时保留一张 0 行的空表，状态「还没拉过」（ADR §4，没有「撤销新建」）。`<项目号 A>` 要与旧表里存的项目号**逐字一致**（PLM 读取和守卫都按原值相等比较）。

建表路由的约束与顺序（`http-routes.cjs:9567-9804`）：
- 请求体必须是空对象 `{}`，不收 `sheetId` 等任何键（空白名单 `VALID_EMPTY_REQUEST_KEYS`，`http-routes.cjs:1863`，校验 `:9571`）；objectId 与表 id 都由服务端派生（`stock-preparation-project-targets.cjs:244-289`）。所以这条路由**只能新建**派生的 `_p_` 表，不能指向旧表。
- 门 → 开关 → 空请求体 → 租户 → 审计词表探针（迁移 088）→ 读登记行 → 客户包计划与预检（`:9624-9698`，见 1.6）→ 200 张上限（含已归档，`:9700-9703`；`stock-preparation-project-targets.cjs:71`）→ 建表 → 装客户包 → 写登记行（`:9715`）→ 审计 `project_target_create`（`:9726-9738`）→ G1 授权（`:9770`）→ 审计 `project_target_grant` → 顺带建总览并给清单角色授读（**尽力而为**：失败只记日志、不影响建表，结果在响应的 `overview.code`，`:9774`、`:9802`、`:4569-4580`）。
- 响应 `overview.ensured = false` 时：拉取人员在首页点「建立项目总览」（即 `…/project-overview/ensure`，PULL）补建；`refresh` 不会建（见 3.1）。

建完、写入之后只读核对（`<开关打开时刻>` 写成 `'2026-10-14 15:00:00+08'` 这样的 ASCII 时间）：

```
SELECT status, count(*) AS registered, count(*) FILTER (WHERE last_pull_outcome = 'applied') AS applied
  FROM integration_stock_prep_project_target GROUP BY status;
SELECT action, mode, count(*) FROM integration_stock_prep_audit
 WHERE action IN ('project_target_create', 'project_target_grant', 'project_overview_refresh')
   AND created_at > '<开关打开时刻>'
 GROUP BY 1, 2 ORDER BY 1, 2;
SELECT CASE WHEN o.object_id = 'plm_stock_preparation_project_overview' THEN 'overview' ELSE 'project_sheet' END AS sheet_kind,
       p.subject_id, p.perm_code
  FROM spreadsheet_permissions p JOIN plugin_multitable_object_registry o ON o.sheet_id = p.sheet_id
 WHERE p.subject_type = 'role'
   AND (starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_') OR o.object_id = 'plm_stock_preparation_project_overview')
 ORDER BY 1, 2;
SELECT count(*) AS old_sheet_registered FROM integration_stock_prep_project_target WHERE sheet_id = '<旧表 sheetId>';
```

期望（只建了 A 时）：
- 登记表 `active | 1 | 1`（只预览未写入时 `applied = 0`）。
- 审计（表 `integration_stock_prep_audit`，迁移 `066_create_integration_stock_prep_audit.sql:18`，动作由 `088_extend_stock_prep_audit_project_target_actions.sql:32-48` 放开）：`project_target_create | sheet_created | 1`；装了客户包时另有 `project_target_create | customer_pack_installed | 1`（`http-routes.cjs:9740-9767`）；D4 非全否时 `project_target_grant | granted | 1` 和 `project_target_grant | overview_read_granted | 1`；第一次建总览时 `project_overview_refresh | sheet_created | 1`。审计只记计数，不记角色 id（`:9605-9615`）。
- 授权：每个 D4 选中的角色在 A 的 `project_sheet` 上一行 `spreadsheet:write`、在 `overview` 上一行 `spreadsheet:read`；没有别的角色、没有 `approvals_operator`。
- `old_sheet_registered = 0`（旧表不登记）。
- **dry-run 的数**：新表是空的，所以 A 的第一次 dry-run 应是「新增 652、跳过 0」（PLM 侧 652 行）。旧机 10-14 那次的「354 跳过 + 298 新增」是对着旧表算的（旧表已有 354 行），不适用于新表。写入后表里 652 行有效行，人工列为空（D8a）；3 行「审批状态」按 D8b 处理。
- 一线测试账号刷新后能从卡片打开 A 的新表并录入人工列；`GET …/projects/<项目号 A>/target` 的 `rowCount` 与网格 All Records 视图的行数一致（ADR §8 第 8 步；工具栏行数是当前视图的数，不是全表）。

### 3.5 项目 B 及之后：同一流程（D7 = 是）

与 3.4 完全相同，项目号换成 `<项目号 B>`。B 的 apply 同样经写入门的项目表分支（1.1 的四个条件；演示机两键都在，6163627800）。核对 SQL 同上，期望：登记表 `active | 2`；`project_target_create | sheet_created | 2`；每个 D4 角色在两张 `project_sheet` 上各一行 `spreadsheet:write`；总览只有一张，`overview_read_granted` 只在第一次出现（之后是 `overview_read_already_granted` 或不再出现）；`old_sheet_registered = 0`。

### 3.6 旧表没被动过（只读参照）

重跑 1.4 的基线 SQL：`rows_total` 不变；`last_row_update` 不变（若有人在网格里手工改了旧表，这一项会变——那是人改的，不是开关改的；D9a 决定什么时候收掉一线在旧表上的写权）。开关开着时没有任何路由解析到旧表：A、B 都按登记行走自己的表，`old_sheet_registered = 0`。**不要删除旧表**（ADR Q3）：界面删除对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（`packages/core-backend/src/multitable/sheet-delete-guard.ts:50`、`:131`），也不要用 SQL 删；它还是关开关后唯一的回退目标（§5）。

### 3.7 出错时（照码判断，不要在现场改代码或改库）

| 现象 | 含义 | 处理 |
|---|---|---|
| 404 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND` / 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE` / 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_ID_INVALID` | 清单写错，**表和登记行已建好**，没有授权 | 改清单（§0 硬约束）→ §2.4 重启 → 对同一项目号再 POST 一次建表路由（200 重放补授权） |
| 409 `STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE` | 声明的 `ext_` 列没有客户包能覆盖（1.6） | 什么都没建。报开发机 |
| 403 `STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED` | 客户包管列写权，这次登录没有已验证的租户声明（1.6） | 什么都没建。换一个带租户声明的登录再做 |
| 422 `CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN` | 包目录里的列写权策略指名了不存在的角色（1.6） | 什么都没建。报 owner |
| 400 `STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID` | 请求体不是空对象，或项目号形状不对 | 只用界面按钮建表；手工调用时请求体写 `{}` |
| 409 `STOCK_PREPARATION_PROJECT_TARGET_LIMIT` | 本租户已有 200 张（含已归档） | 出现就停 |
| 403 `STOCK_PREP_APPLY_SANDBOX_ONLY` | 写入门没放行（1.1 的四个条件） | 只能预览；报 owner |
| 写入时 409 `TARGET_SHEET_FOREIGN_PROJECT` | 不应出现：新表里只有这个项目 | 停，报开发机 |
| 客户包装到一半宿主写失败 | 已建表但未登记（每个项目号至多一张，派生 id） | 重试同一个按钮，复用同一张表（`http-routes.cjs:9558-9566` 注释） |

## 4. 每日试拉（06:00，`metasheet-stock-prep-scheduled-dry-run`）

- **现在**（开关关）：清单 10-14 已改为项目 A（R3），试拉的目标是旧表，result=0、`skipped_dry_run_only`（旧机 10-14 帖）。
- **开开关之后、A 的新表建好之前**：A 回 409 `STOCK_PREPARATION_PROJECT_ABSENT`。换过脚本（§2.0）时记为「跳过」（`skipped_project_sheet_absent`），**不算失败、不改退出码**（`scripts/ops/stock-preparation-scheduled-pull.mjs:523-536`）；没换就会被当成失败。这段时间 result=0 不说明拉到了数据，要看日志里 A 的 `action`。
- **A 的新表建好之后**：A 的试拉打到 A 的新表上；写入之前每次都报「新增 652」，写入之后回到「跳过」为主。
- **清单保持只有 A，直到 B 登记**；之后按 D13 改回多项目。脚本绝不建表。
- 定时任务的令牌必须是绑定租户的服务账号（`stock-preparation-scheduled-pull.mjs:32`）。登记行按租户查，建表的拉取人员与这个服务账号必须在同一租户；A 建表后的第一次 06:00 试拉若仍是 `skipped_project_sheet_absent`，就是租户或项目号不一致，停下报开发机（本手册没有在演示机上核对过这一点）。

### 4.1 大 BOM 项目的超时：`MS_TIMEOUT_MS` 建议值（R67 前的临时口径）

试拉脚本对每个项目发一次 dry-run，单次 HTTP 超时由 `MS_TIMEOUT_MS` 决定（默认 `120000`，`scripts/ops/stock-preparation-scheduled-pull.mjs` 的 `readConfig`），整轮预算由 `MS_TOTAL_TIMEOUT_MS` 决定（默认 `1800000`，超过后不再开始下一个项目）。

- **为什么会超时**：dry-run 对客户 PLM **逐次串行**读（演示机实测：项目 A 每次 1,414 次读、项目 B 460 次），每次往返随客户 PLM 负载在约 15–130 ms 之间变化。同一个已有 652 行的项目，PLM 快时 18 s、慢时超过 120 s；与目标表已有行数无关（`g1-switch-on-record-20261016.md` §4）。
- **怎么取值**：单次超时 ≥ 读次数 × 130 ms 再留一倍余量。读次数看该项目任一次 dry-run 响应的 `evidence.expansion.readCount`，或试拉日志里 `durationMs` 的历史最大值。
  - 读次数 ≤ 500：保持默认 `120000`。
  - 读次数 500–2,000（演示机项目 A 属此档）：`600000`（10 分钟）。演示机 2026-10-16 起即用此值。
  - 读次数 > 2,000：`900000`，并同时检查 `MS_TOTAL_TIMEOUT_MS` ≥ 各项目单次超时之和；大于此规模的项目应走大 BOM 后台车道。
- **怎么改**：只在试拉任务的 env 文件里增加或修改 `MS_TIMEOUT_MS=<毫秒>` 这一行（先备份；不要回显同文件里的令牌），然后手动触发一次任务，核对日志里每个项目 `dryRunHttpStatus 200` 且 summary `failed 0`。
- **界面不受此值影响**：界面 dry-run 经 nginx，60 s 即 504。PLM 慢的时段里，大 BOM 项目在界面上重新拉取仍可能 504，待 R67 的「PLM 读批量 / 并发」与「界面 dry-run 走后台任务」两项上机后解决。


## 5. 回退

1. 改 `app.env`。两种做法任选其一：
   - 开开关之后 `app.env` 没有别的改动时：用 2.1 的备份原样覆盖回去（字节级还原）。先核对差异只有追加的那几行：`@(Compare-Object (Get-Content -LiteralPath '<备份文件>') (Get-Content -LiteralPath $envFile)).Count` 应等于追加的行数（2–4，含可能多出的一个空行），只看计数。
   - 否则就地把开关改成 `false`（只认 `true`，`false` 即关；保留原编码）：

     ```
     $bytes = [System.IO.File]::ReadAllBytes($envFile)
     $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
     $text = [System.IO.File]::ReadAllText($envFile)
     $old = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED=true'
     ([regex]::Matches($text, [regex]::Escape($old))).Count
     ```

     计数恰为 1 才继续（不是 1 就停）：

     ```
     $text = $text.Replace($old, 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED=false')
     [System.IO.File]::WriteAllText($envFile, $text, (New-Object System.Text.UTF8Encoding($bom)))
     ```

     角色清单那一行可以留着：开关关时建表路由 404，清单不会被读。D10 = 是时成员页开关同样改成 `false`。
2. 按 §2.4 的「删键」路径重启（走计划任务，不用 `pm2 restart --update-env`：字节级还原会让追加的键从 `app.env` 消失，`--update-env` 撤不掉进程里已有的旧值；就地改 `false` 的做法键还在，为统一也走计划任务）。
3. 跑 §3.1 的探针：`list` 回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`，`preflight` 里没有 `projectSheets`。
4. 回退之后**留下的东西**（只增不删，什么都不删）：登记行、A / B 的项目表及其数据、总览表、已授出的表级授权、审计行。G1 只增不删，所以有授权的人仍能在多维表网格里打开、编辑这些项目表。重新打开开关即恢复原样（ADR §8）。
5. 回退之后的行为：查找回落到部署 env 的目标，也就是旧表。拉 A 会再写进旧表（旧表不再只是参照）；拉 B 等其它项目会被一表一项目守卫 409 `TARGET_SHEET_FOREIGN_PROJECT`（旧表里有 A 的有效行）——即「关开关 = 停用拉取」（ADR §8；`global-history-flag-manifest.mjs:681`）。首页「打开备料多维表」按钮回来、指向旧表。§2.0 换过的试拉脚本不用换回（开关关时它的行为与旧拷贝一致）。
6. **不要**：删任何表（托管表本来也删不掉）、`DELETE` 登记表或授权行、跑迁移 087 / 088 的 `down()`、回退安装包。

## 6. 已知限制（开之前 owner 应知道）

- **S5b 锁行为**只在 D10 = 是时存在，四条见 D10。
- **权限变化最长 60 秒生效**（`rbac/service.ts:13`）：任命、开通准入、改角色之后等一分钟再让对方刷新页面；页面早已打开的会话要刷新才看到新按钮。
- **G1 只增不删、只有写一级**：从清单去掉角色不会收回已授的行；想让某张项目表对某个角色只读或收回，只能由管理员在「权限」里手工处理（ADR §11.7）。
- **表级写同时打开字段与视图管理**（ADR §11.7，D5）。
- **归档的表仍在多维表左侧列表里**，对有授权的人可见，网格照样可写（ADR §6 默认 (ii)）。旧表同样留在列表里。
- **总览的数字不是实时的**：只在建表、拉取、确认、手动刷新等时刻重算，界面显示「截至 hh:mm」（ADR §5）。
- **新建的项目表从空表开始**；自动化、提醒、自建视图按表配置，不会从旧表带过去（D8a）。
- **R-35 记录的四条已知限制**（`decision-register.md:44`）：(a) 建表后的审计追加在事务之外，追加失败不重放；(b) 200 张上限在路由侧先计数后建表，建表与登记之间无锁（登记侧在事务内加租户锁复核）；(c) G1 的真库用例自行重建宿主事务；(d) 迁移 087 的约束只在假件和真库竞争用例上验证过。
- **建表路由里的授权等表行锁时没有超时上限**：只有成员页调用时才设 5 秒 `lock_timeout`（`stock-preparation-project-sheet-grants.ts:146-151`）；建表路由不设，由语句超时兜底。正常操作下不会撞上。

## 7. 代码与 ADR / 其它文档的出入（照实写，供 owner 与 Codex 评审）

1. **没有认领路由**：登记一张已有表在代码里没有入口——`store.create`（`stock-preparation-project-target-store.cjs:362-407`）只被建表路由调用，建表路由的请求体是空白名单、总是建派生的 `_p_` 对象；ADR §3.1 有意删掉了 v1 的 register-bound 路由（`adr-stock-prep-project-sheets-20261008.md:171`）。这与 ADR 一致；与 owner 10-14 帖里「认领」的说法不一致，方案②按 ADR 走，owner 在 D15 确认。
2. **读路由遇到未登记项目**：ADR §3 的表写「读路由走该路由原有的『找不到』分支」；代码对读也回 409 `STOCK_PREPARATION_PROJECT_ABSENT`（`stock-preparation-project-targets.cjs:187-229` 注释写明这是有意偏离，R-35 第 (3) 条已记）。看板把它渲染成「表还没建好」。
3. **G1 审计记什么**：ADR §2 写 `project_target_grant`「记角色 id 和表 id」；代码只记表 id（`subjectId`）和三个计数，不记角色 id（`http-routes.cjs:9605-9615`）。
4. **G1 清单同时决定总览的读权限**：ADR §2 / §11.5 只说给项目表授写；代码还用同一份清单给项目总览表授 `spreadsheet:read`（`plugin-scope.ts:757-812`，`http-routes.cjs:4544-4560`）。
5. **「成员与权限」页另有开关**：ADR §11.6 只写门是 WORKBENCH_ADMIN，§8 第 6 步只写本开关和清单；代码里这一页要另一个默认关的开关 `STOCK_PREP_MEMBERS_PAGE_ENABLED`，且打开它须 owner 接受 S5b 锁行为（`global-history-flag-manifest.mjs:793-800`）。打开 G1 开关**不会**出现这一页。
6. **项目总览不是工作台页签**：是首页「每个项目一张备料表」那一块里的三个按钮（`StockPreparationOperatorHome.vue:82-130`）。
7. **flag manifest 的说明过时**：`global-history-flag-manifest.mjs:681` 写开关关时「the three project-sheet routes」回 404；现在是 9 条（`http-routes.cjs:217-257`，S1 / S4 五条加 S3 四条）。同一条写「read PER REQUEST (no restart)」：对进程环境成立，但演示机靠 `app.env` 进环境，改了必须按 §2.4 重启。
8. **附录 A.5**（`adr-stock-prep-project-sheets-20261008-addendum-a-d.md:60-65`）原三条——升级前先建「备料拉取人员」角色、「不要用迁移写角色」、「一线角色不用改」——都已不成立，同节 2026-10-10 订正（`:66`）已写明；读附录时以订正为准。
9. **ADR §8 第 5 步**写「撤销一线在旧表上的授权、暂停旧表自动化」；本手册把它改成 D9a / D9b 的决策，建议暂留（旧表是参照）。
10. **旧机诊断里「删表路由对托管表无守卫」**与当前代码不符：`sheet-delete-guard.ts:50`、`:131` 对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（ADR §0 第 3 条同此；旧机 10-14 第二帖也写「走 `DELETE …`（有守卫）」）。无论如何本手册不删任何表。

## 附录　备选：一次性 SQL 认领（仅 D15 = 否时）

只在 owner 坚持保留旧表数据、不走方案②时用。它在 `store.create` 之外直接写登记表，把旧表登记为项目 A 的表。**与 §3.4 二选一，不能两样都做**：A 一旦经建表路由登记，`(tenant_id, project_no)` 唯一索引会让这里的插入报错（`087_create_integration_stock_prep_project_target.sql:95-100`）。

**原理**：开关开后，`resolveProjectTargetForAction` 只读登记行（`stock-preparation-project-targets.cjs:202-233`），再按 `(<租户>:integration-core, 登记行的 objectId)` 现算字段映射（`:167-184`）；所以 `object_id` 必须是 `plugin_multitable_object_registry` 里这张表的那个值，**不能**写成 `_p_` 形状的派生 id。旧表不是 `_p_` 形状，写入走写入门的原分支，要求它自己的 objectId 在放行清单里（`stock-preparation-table-actions.cjs:2513-2519`）。

**后果**（不会被代码兜住，要靠人记住）：没有审计行；G1 端口对非 `_p_` 对象回 422 `STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET`（`plugin-scope.ts:719-726`），G1 不会给旧表授权；对 A 再 POST 建表路由，清单非空时先补授权就 422（`http-routes.cjs:9596-9604`），清单为空、部署又装过客户包时重装客户包 500 `STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID`（`stock-preparation-project-targets.cjs:519-526`；客户包只能重装到派生的 `_p_` 对象上，`stock-preparation-customer-pack.cjs:710-715`）；成员页给自定义角色加 A 会 422（`http-routes.cjs:10536-10543` 调同一个 G1 端口）。

**预检**（只读）：

① 守卫：把 `assertTargetSheetHoldsNoForeignActiveRows`（`stock-preparation-table-actions.cjs:1144-1193`）的判定搬成 SQL。「有效」照 `stockPreparationRowIsActive`（`:1127-1142`），失效行跳过（`:1167`），「同一项目」按原值严格相等（`:1168`）；字段 id 按宿主派生规则 `fld_` + sha1(`<staging 项目>:<objectId>:<逻辑字段>`) 前 24 位现算（`packages/core-backend/src/multitable/provisioning.ts:207-225`；需要 `pgcrypto`，迁移 `zzzz20260404153000_repair_meta_core_schema.ts:5` 已建）。先核字段：

```
WITH f AS (
  SELECT o.sheet_id,
         'fld_' || left(encode(digest(o.project_id || ':' || o.object_id || ':projectNo', 'sha1'), 'hex'), 24) AS pf,
         'fld_' || left(encode(digest(o.project_id || ':' || o.object_id || ':active', 'sha1'), 'hex'), 24) AS af
    FROM plugin_multitable_object_registry o WHERE o.sheet_id = '<旧表 sheetId>'
)
SELECT (SELECT count(*) FROM meta_fields mf WHERE mf.sheet_id = f.sheet_id AND mf.id = f.pf) AS project_field,
       (SELECT count(*) FROM meta_fields mf WHERE mf.sheet_id = f.sheet_id AND mf.id = f.af) AS active_field
  FROM f;
```

期望 `1 | 1`，否则停。再数：

```
WITH f AS (
  SELECT o.sheet_id,
         'fld_' || left(encode(digest(o.project_id || ':' || o.object_id || ':projectNo', 'sha1'), 'hex'), 24) AS pf,
         'fld_' || left(encode(digest(o.project_id || ':' || o.object_id || ':active', 'sha1'), 'hex'), 24) AS af
    FROM plugin_multitable_object_registry o WHERE o.sheet_id = '<旧表 sheetId>'
), t AS (
  SELECT m.data -> f.pf AS p,
         CASE
           WHEN m.data -> f.af IS NULL OR jsonb_typeof(m.data -> f.af) = 'null' THEN false
           WHEN jsonb_typeof(m.data -> f.af) = 'boolean' THEN (m.data ->> f.af)::boolean
           WHEN jsonb_typeof(m.data -> f.af) = 'number' THEN (m.data ->> f.af)::numeric <> 0
           WHEN jsonb_typeof(m.data -> f.af) = 'string'
             THEN lower(regexp_replace(m.data ->> f.af, '^\s+|\s+$', '', 'g')) NOT IN ('', 'false', '0', 'no', 'n')
           ELSE true
         END AS is_active
    FROM meta_records m JOIN f ON m.sheet_id = f.sheet_id
)
SELECT count(*) AS rows_total,
       count(*) FILTER (WHERE is_active) AS rows_active,
       count(DISTINCT p) FILTER (WHERE is_active) AS active_projects,
       count(*) FILTER (WHERE is_active AND p IS NULL) AS active_rows_without_project,
       count(*) FILTER (WHERE is_active AND p = to_jsonb('<项目号 A>'::text)) AS active_rows_of_this_project,
       count(*) FILTER (WHERE is_active AND p IS DISTINCT FROM to_jsonb('<项目号 A>'::text)) AS foreign_active_rows
  FROM t;
```

期望 `foreign_active_rows = 0`、`active_rows_of_this_project` = 354（旧机 10-14：A 的有效行 354、第三个项目的失效行 390 不计）。已知差异：守卫用 JS 的 `trim()`，SQL 的 `\s` 不含不换行空格等少见空白；缺项目号的有效行在守卫里算一个「项目」，SQL 单列。这段 SQL 在开发机一次性库上与守卫本身对拍过（同一组 19 行样本一致）。

② 登记表里既没有 A、也没有这张表：

```
SELECT count(*) FILTER (WHERE project_no = '<项目号 A>') AS rows_for_project_a,
       count(*) FILTER (WHERE sheet_id = '<旧表 sheetId>') AS rows_for_old_sheet
  FROM integration_stock_prep_project_target;
```

期望 `0 | 0`，否则停。

③ 对象注册行的形状与写入门：

```
SELECT o.plugin_name,
       o.project_id LIKE '%:integration-core' AS staging_project_shape,
       starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_') AS is_p_shape,
       o.sheet_id = 'sheet_' || left(encode(digest(o.project_id || ':' || o.object_id, 'sha1'), 'hex'), 24) AS sheet_id_is_derived
  FROM plugin_multitable_object_registry o WHERE o.sheet_id = '<旧表 sheetId>';
```

期望 `plugin-integration-core | t | f | t`（表 id 的派生规则见 `provisioning.ts:215-217`）。再确认它的 objectId（`<旧表 objectId>`）在放行清单里，只打印计数，期望 1：

```
$line = (Select-String -LiteralPath $envFile -Pattern '^\s*STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS\s*=' | Select-Object -First 1).Line
@($line.Substring($line.IndexOf('=') + 1).Trim().Trim('"').Trim("'").Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -eq '<旧表 objectId>' }).Count
```

④ 现算的字段 id 在这张表上都存在（模板 33 列 + 客户包的 `ext_` 列；任何一列对不上，dry-run 会被字段存在探针挡下，`stock-preparation-table-actions.cjs:729`，调用 `:2046`、`:2635`）：

```
WITH o AS (
  SELECT sheet_id, project_id, object_id FROM plugin_multitable_object_registry WHERE sheet_id = '<旧表 sheetId>'
), ids(logical, kind) AS (
  SELECT unnest(string_to_array('projectNo,idempotencyKey,componentSourceId,parentSourceId,parentComponentCode,parentComponentName,path,depth,componentCode,componentName,componentSpec,material,sourceVersion,rawQuantity,totalQuantity,active,lastPlmRefreshRunId,lastPlmRefreshAt,lastPlmRefreshDecision,lastPlmConflictSummary,materialType,blankType,stockPreparationStatus,demandDate,leadTimeDays,notes,procurementReply,warehouseConfirmation,makeOrBuy,procurementDone,procurementReplyDate,warehouseDone,actualArrivalDate', ',')), 'template'
  UNION
  SELECT e ->> 'fieldId', 'ext'
    FROM integration_stock_prep_pack_installs i
    JOIN o ON i.object_id = o.object_id
    CROSS JOIN LATERAL jsonb_array_elements(i.installed_fields_json) e
   WHERE i.status IN ('installed', 'partial') AND (e ->> 'extension') = 'true'
)
SELECT ids.kind, count(*) AS expected,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM meta_fields mf
          WHERE mf.sheet_id = o.sheet_id
            AND mf.id = 'fld_' || left(encode(digest(o.project_id || ':' || o.object_id || ':' || ids.logical, 'sha1'), 'hex'), 24))) AS present
  FROM ids CROSS JOIN o GROUP BY ids.kind ORDER BY ids.kind;
```

期望两行，每行 `expected = present`：`template | 33 | 33`；`ext` 的个数等于 env 动作 JSON 里 `extensionFieldIds` 的个数（r7 记录是 21 个，`222-deploy-window-runbook-20260901.md:112`）。33 个逻辑字段就是主模板的字段（`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs:661` 起）。**到机器上核**：`meta_fields` 的 `id` / `sheet_id` 两列名（照 `zzzz20260404153000_repair_meta_core_schema.ts:8-18` 写）、客户包台账 `installed_fields_json` 里每项的 `fieldId` / `extension` 两个键名（照迁移 076 第 61 行的注释写），以及 env 动作 JSON 里 `extensionFieldIds` 的实际个数（只数个数，不贴内容）。`present < expected` 就停。

⑤ 视图句柄（只读，不挡认领）：

```
SELECT (SELECT count(*) FROM meta_views v WHERE v.sheet_id = o.sheet_id
          AND v.id = 'view_' || left(encode(digest(o.project_id || ':' || o.object_id || ':prep-fill', 'sha1'), 'hex'), 24)) AS fill_view,
       (SELECT count(*) FROM meta_views v WHERE v.sheet_id = o.sheet_id
          AND v.id = 'view_' || left(encode(digest(o.project_id || ':' || o.object_id || ':prep-todo', 'sha1'), 'hex'), 24)) AS todo_view
  FROM plugin_multitable_object_registry o WHERE o.sheet_id = '<旧表 sheetId>';
```

GET target 与卡片的深链按这两个派生 id 给出（`stock-preparation-project-targets.cjs:582-591`；`prep-fill` / `prep-todo` 见 `stock-preparation-templates.cjs:870`、`stock-preparation-target-provisioning.cjs:708`；`meta_views` 列见 `zzz20251231_create_meta_schema.ts:30-34`）。`todo_view` 预计是 0：总览上 A 那一行的「待填写」深链会指向一个不存在的视图，具体表现没有核对过。

**登记**（写库，owner 动作；建议在开开关之前做，开关关着时登记行不被读取）：

```
\set ON_ERROR_STOP on
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status, created_by)
  SELECT gen_random_uuid()::text,
         left(o.project_id, length(o.project_id) - length(':integration-core')),
         '<项目号 A>', o.sheet_id, o.object_id, 'active', '<owner 用户 id>'
    FROM plugin_multitable_object_registry o
   WHERE o.sheet_id = '<旧表 sheetId>'
     AND o.plugin_name = 'plugin-integration-core'
     AND o.project_id LIKE '%:integration-core'
     AND NOT starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 registry row, got %', n;
  END IF;
END $$;
```

- `tenant_id` 从对象注册行的 staging 项目 `<租户>:integration-core` 取前缀（路由里的 staging 项目就是这样拼的，`http-routes.cjs:1596-1599`），不手打。
- 不写 `ON CONFLICT`：重复登记必须报错（唯一索引），不能静默跳过。插入行数不是 1 时整段回滚、什么都不写。
- **审计**：这一行不经 `store.create`，没有审计行。在私有记录里记下：执行时间、执行人、`<项目号 A>`、`<旧表 sheetId>`、`<旧表 objectId>`、新行的 `id`、①–⑤ 的结果；#6079 上只贴 values-free 摘要。

**核对**（开关开后）：`SELECT count(*) FROM integration_stock_prep_project_target WHERE sheet_id = '<旧表 sheetId>'` = 1；§3.1 探针 `target 200 active`；首页出现 A 的卡片、打开后落在旧表上；管理员对 A 手工 dry-run 与旧机 10-14 那次同口径（354 跳过 + 298 新增，`status=ready`），说明经登记行解析到了旧表、租户墙（`http-routes.cjs:4844-4850`，dry-run 调用 `:7009`）与字段存在探针都通过；旧表上的授权与 1.5 一致（没有新增 G1 行）。

**对 A 的三个「不要」**（只要这条认领行在就一直有效）：
1. **不要**对 A 点「新建备料表」、也不要对 A 再 POST 建表路由（422 / 500，见上「后果」）。界面上 A 是 active，正常只给「直接打开 / 覆盖拉取」，覆盖拉取走 dry-run / apply，不经建表路由。
2. **不要**在「成员与权限」页把 A 加给自定义角色（422）。要给某个角色旧表的权限，由管理员在多维表「权限」里手工授（G2）。
3. **保留**旧表上现有的手工授权（1.5 的那些行）与自动化——这时它们就是项目 A 工作表的授权和自动化（D9 不适用）。

## 附录 B　试点启用：启用前的旧大作业处置、启用答 500 时重新提交（备料分批拉取第一期，2026-10-24）

> **不是 G1 开关的步骤**，基线也不是上文的 `ec8d97cc4`：本附录随「启用前加固」PR（步骤 4 设计 §23.4 F-3 / F-4 / F-5）进入 main，只引路由、函数名与检查 id，不引行号。启用试点是 owner 动作（R-54）；在步骤 4 的 PR-2 / PR-3 / PR-6 与第 6 步上线之前，真实部署上的就绪清单必然不通过（D-22），本附录先写好，届时照做。
> **values-free**：项目号写 `<项目号>`，表写 `<项目表 sheetId>`，作业写 `<作业键>`；替换后的值只记在私有记录里。

### B.1 先看就绪（GET `/api/integration/stock-preparation/projects/<项目号>/target/pilot`）

- 回答只有检查 id 和真假；`readiness.version` 现为 **2**（18 项：版本 1 的 15 项不变，新增下表三项，只会多拒、不会少拒）。`may.enable` 为真才去 B.3。
- 版本 2 新增的三项：

| 检查 id | 不通过的意思 | 处置 |
|---|---|---|
| `no_two_copy_component` | 同一组件在这张表上**既是有效顶层行**（父件为空）**又是有效子行**（历史留下的双份）。「有效」按沿用关系核心的读法：`active` 不等于 `false` 都算（空格子、文字格子也算） | 不在启用流程里修：走第 6 步修复（O-6）后再看 |
| `no_open_large_job` | 有指向这张表、还没结束的大 BOM 检查点作业，或作业库读不出来 | 见 B.2 |
| `pack_columns_installed` | 动作配置里声明的 `ext_` 列没有全部装到这张项目表上（安装台账里没有、或台账有而表上没有）；或者什么都没声明、也没有声明「不适用」 | 装客户包 / 补列；部署确实没有客户包时，插件配置写 `stockPreparationPilot.customerPack: 'not_applicable'`——只有在动作不声明 `ext_` 列、台账里这张表也没有任何已装包列时才算通过。改配置由 owner 定 |

### B.2 旧作业处置（`no_open_large_job` 为假时）

**为什么拦**：启用后大车道对试点项目一律 409 `STOCK_PREP_PILOT_LARGE_LANE_REFUSED`（启用前已批准的作业也一样，每块在租约内再查一次），而检查点应用作业**没有取消接口**。一个跨过启用、只落了一半的大作业既不能续跑、也不能关闭。所以这张表上还有没结束的作业时不许启用；启用路由在自己的租约里会再扫一次（扫描与 bump 之间刚跑过一块的作业也拦得住）。

**「没结束」**：状态不是 `succeeded` / `partial` / `cancelled` / `expired`——`queued`、`paused`、`failed`（围栏中断，可续跑）、`running`（跑到一半进程没了）以及任何不认识的状态都算；按作业里存的目标表认，不分租户与工作区。作业库列不出键、读不出值，或某个作业值读不出目标表，都算不通过。

**处置顺序**（全部在启用**之前**做）：

1. 在大 BOM 面板把这张表上每个 `queued` / `paused` / `failed` 的作业**续跑到结束**（反复「运行下一块」直到 `succeeded` 或 `partial`）。`failed` 的从断点续跑。**存的状态是 `running` 的作业不要续跑**：分块执行函数 `runLargeBomCheckpointApplyJobChunk` 对存为 `running` 的作业一律拒 409 `LARGE_BOM_APPLY_RUN_IN_PROGRESS`，进程没了之后永远续不上——直接走第 2 步里 owner 批准的 `cancelled` 改状态（模板的状态条件已含 `running`），不必先跑新作业。
2. 续跑被拒 409 `PLAN_SUPERSEDED`（`newer_plan` / `job_unbound`）的旧作业已经不能再跑：先对同一项目**重新展开 → 规划 → 批准 → 跑完**一个新作业（旧作业已落的行按幂等键重新规划为更新 / 跳过，不会重复新增）。之后旧作业仍是未结束状态，就绪依然不过——这一步只能由 **owner 批准一次手册数据库操作**，把那一个旧作业的状态改为 `cancelled`：
   - 先只读找出作业（确认没有在途租约：GET 的 `write_lock_free` 为真）：
     ```sql
     SELECT key, value->>'status' AS status
       FROM plugin_kv
      WHERE plugin = 'plugin-integration-core'
        AND key LIKE 'stock-preparation:large-bom:apply:%'
        AND value->'target'->>'sheetId' = '<项目表 sheetId>'
        AND value->>'status' NOT IN ('succeeded', 'partial', 'cancelled', 'expired');
     ```
   - 再逐个改（只改这一个键的 `status`，不删键、不动其它字段；改动行数必须是 1）：
     ```sql
     UPDATE plugin_kv
        SET value = jsonb_set(value, '{status}', '"cancelled"'), updated_at = now()
      WHERE plugin = 'plugin-integration-core'
        AND key = '<作业键>'
        AND value->'target'->>'sheetId' = '<项目表 sheetId>'
        AND value->>'status' IN ('queued', 'paused', 'failed', 'running');
     ```
   - 私有记录里记：执行时间、执行人、`<作业键>`、改前状态；#6079 上只贴 values-free 摘要（几个作业、改前各是什么状态）。
3. 读不出目标表的作业值（查询里 `value->'target'` 为空，或值不是对象），以及上面 SELECT 查到、但状态不在 `queued` / `paused` / `failed` / `running` 之内的作业（不认识的状态，UPDATE 不会改它）：**不要**手工改，报开发机。
4. 处置完 GET 再看一次，`no_open_large_job` 为真再去 B.3。

### B.3 启用（POST 同一路径，请求体 `{"confirmProjectNo": "<项目号>"}`）与「答 500 ⇒ 重新 POST」

- 顺序：就绪全过 → 推进计划代次（`pilot_enable`）→ 在写入租约里再扫一次未结束的大作业 → **宿主盖章**（这张表的通用网格导出关闭）→ **一个事务**里写登记行的试点标记**和**审计行 `project_pilot_enable`。
- **答 500**：盖章之后、标记事务提交之前出了错（进程崩溃、审计写失败、数据库断开）。这时表**已关闭网格导出、但还不是试点**：登记行的三列为空、**没有**审计行（标记和审计行同生共死，不会出现「是试点却没有审计行」）。这个中间态下通用网格导出被拒（403 `MULTITABLE_GRID_EXPORT_CLOSED`），大车道照常（还不是试点）。
- **唯一例外：500 的信息是 `the pilot mark landed without its in-transaction audit row`（码 `AUDIT_STORE_UNAVAILABLE`，试点启用路由 `stockPreparationProjectPilotEnable` 在标记之后发现审计钩子没被调用时抛出）**。这时试点**已经启用**、审计行为 **0 条**；再 POST 只会回答 `alreadyEnabled: true`，永远补不上审计行。这只在接线缺陷时出现（登记表的 store 与路由不是同一构建）。**不要再 POST**：停下，报开发机。
- **处置：原样再 POST 一次**。先 GET 确认 `pilot.enabled` 为假、就绪全过；再 POST。回答 200、`enabled: true`、`exportClosure.alreadyClosed: true`；审计里**恰好一条** `project_pilot_enable`（`detail.exportClosureAlreadyClosed` 为真）。
- 已经是试点时再 POST：回答 `alreadyEnabled: true`，只补宿主盖章，不写第二条审计。
- 再 POST 被就绪拒（409 `STOCK_PREP_PILOT_NOT_READY`）：按 `failing` 里的 id 处置后再 POST；这期间表保持「关导出、非试点」。
- 每次 POST 都推进计划代次：之前做的小车道预览要重做（`PLAN_SUPERSEDED`）。在租约里因 `no_open_large_job` 被拒（409 `STOCK_PREP_PILOT_NOT_READY`）的那次 POST 也已推进代次，拉取人员手上未执行的预览同样要重跑；只有在推进之前就被就绪清单拒掉的 POST 不推进。
- **不要**：手工改登记表的试点三列来「补完」启用（那样没有审计行）；不要重开网格导出（R-53 ②）。
