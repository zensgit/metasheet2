# 运行手册：在演示机上打开「一个项目一张备料表」（G1 开关，ADR §8 第 6 步）—— 含把现有 744 行表认领为项目 A

> 依据：ADR `adr-stock-prep-project-sheets-20261008.md` §8 第 6–9 步（以下简称 ADR）；决策登记 R-35（S1）、R-37（S3）、R-38（S4）、R-39（S5）。请求来源：#6079 评论 6162564175（旧机 2026-10-14「请开发机给出 G1 开启 runbook」）；owner 2026-10-14 裁决见 #6079 评论 6163355460：**按「一张备料表一个项目」走**，现有 744 行那张表**认领**为项目 A 的登记表、**不能重建**。
> **基线**：origin/main `ec8d97cc4`（`ec8d97cc481d3c6835a97c197a93cd00d10151e2`）。下文所有 `path:line` 都在这个提交上核过。演示机跑的是 R66（`e2345ab6b`，`r66-deploy-record-20261013.md:7`）；本手册引用的代码在这两个提交之间没有改动的前提**没有逐文件核对**，上机前按 §1 的只读结果为准。
> **开不开、什么时候开、怎么认领，由 owner 决定。** 本手册列出 owner 要拍板的事（§0），已有的 owner 裁决照录、未裁的不替 owner 选。在演示机上执行任何一步（含只读 SQL）都是 owner 动作，在旧机上执行。
> **values-free**：不含主机、地址、口令、令牌、账号名、真实项目号。项目号一律写 `<项目号>`（项目 A 的号写 `<项目号 A>`）；`<旧表 sheetId>`、`<旧表 objectId>`、`<安装根目录>`、`<令牌文件>`、`<后端直连地址>`、`<owner 用户 id>` 等占位符在执行时替换，替换后的值只记在私有记录里，不贴进 issue / PR。命令是 ASCII，可在 Windows PowerShell 5.1 下执行。

## 这个开关做什么、不做什么

- 开关是 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`（`plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs:63`），**只认精确的小写 `true`**（`:98-100`：`' true'`、`TRUE`、`1` 都算关），每个请求现读。登记在 `scripts/ops/global-history-flag-manifest.mjs:674`（`danger: 'high'`）。
- 开了之后：
  - 每条备料读写路由按项目号去登记表 `integration_stock_prep_project_target`（迁移 `packages/core-backend/migrations/087_create_integration_stock_prep_project_target.sql:1`）找这个项目的表，**只查登记表、没有回退**；没登记的项目一律 409 `STOCK_PREPARATION_PROJECT_ABSENT`，不再落到 env 里那张表（`stock-preparation-project-targets.cjs:202-233`）。
  - 拉取人员（`stock-prep:pull`，`plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs:91`、`:579-580`）可以在工作台「拉一个新项目」时为一个项目新建一张受管表并登记（`plugins/plugin-integration-core/lib/http-routes.cjs:9567`，下称「建表路由」）。
  - 建表后按 G1 角色清单 `MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`（`stock-preparation-project-targets.cjs:67`，读取 `:103-112`；登记 `global-history-flag-manifest.mjs:685`）给这些角色在新表上授 `spreadsheet:write`，在项目总览表上授 `spreadsheet:read`（`packages/core-backend/src/multitable/plugin-scope.ts:704-753`、`:757-812`）。
- **现有 744 行那张表（env 动作绑定的表，下称「A 的表」）登记为项目 A 的表**（owner 2026-10-14）：它不重建、不迁移、不删除，只在登记表里加一行指向它（§3.4）。这**推翻了 ADR Q3 与 §3.1**（「旧混表不要了：不登记、不迁移、不删除」，ADR 第 15 行、第 163-171 行），需要在决策登记册补一行（owner 2026-10-14）；本 PR 只写手册，不改登记册。
- **代码里没有「登记一张已有表」的路由**：登记表唯一的写入方是 `store.create`（`plugins/plugin-integration-core/lib/stock-preparation-project-target-store.cjs:362-407`），只被建表路由调用，而建表路由的请求体是空的、总是去建派生出来的 `plm_stock_preparation_sandbox_p_<摘要>` 对象；ADR §3.1 把 v1 的 register-bound 路由删掉了（`adr-stock-prep-project-sheets-20261008.md:171`）。所以认领只有两条路，见 D15。
- **不做**：不撤销任何已有授权；不开「成员与权限」页（那是另一个开关 `STOCK_PREP_MEMBERS_PAGE_ENABLED`，`packages/core-backend/src/services/stock-preparation-members.ts:143`、`:281-282`，见 D10）。
- **开过之后再关 ≠ 回到今天**：关掉后所有路由回到 env 那张表，一表一项目守卫会拒绝项目 A 以外的项目（ADR §8「从开切回关」；`global-history-flag-manifest.mjs:681`）。即「关开关 = 停用除 A 以外的拉取」。

## 0. owner 决策清单（每条回「是 / 否」；未回答的项不执行 §2 / §3.4）

已有的 owner 裁决（照录，不再问）：
- **R1**（2026-10-14，6163355460）按「一张备料表一个项目」走。
- **R2**（同上）现有 744 行表认领为项目 A 的登记表，不重建。
- **R3**（同上，旧机已执行）每日 06:00 试拉的项目清单已从项目 B 改为项目 A。

待 owner 回答：

- [ ] **D1** 在本次维护窗口打开 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`（方向见 R1，这里只问这一次执不执行）？ 是 / 否
- [ ] **D2** 接受「开过之后再关 = 停用除 A 以外的拉取，不是回到今天的行为」？ 是 / 否
- [ ] **D3** 任命拉取人员（`stock-prep_puller` 今天 0 成员，§1.3 核对）？ 是（任命谁记在私有记录） / 否（建表由平台管理员自己做）
- [ ] **D4a** G1 角色清单包含 `stock-prep_frontline`「操作人员」？ 是 / 否
- [ ] **D4b** G1 角色清单包含 `stock-prep_puller`？ 是 / 否
- [ ] **D4c** G1 角色清单包含 `stock-prep_admin`？ 是 / 否
- [ ] **D4d** G1 角色清单包含 `stock-prep_developer`？ 是 / 否
- [ ] **D5** 接受「表级 `spreadsheet:write` 同时打开这张项目表的字段和视图管理」（ADR §11.7；一线今天在 A 的表上就是这一级）？ 是 / 否
- [ ] **D15** 认领方式选 (a) 一次性 SQL 登记？ 是 / 否（否 = 选 (b)，见下）
  - **(a) 一次性 SQL 登记**（§3.4）：今天 R66 上就能做，不用新包。后果：
    - 没有审计行（`store.create` 之外写登记表，建表路由的 `project_target_create` 不会出现），改由私有记录代替；
    - G1 端口只接受 `_p_` 形状的对象，对 A 的表回 422 `STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET`（`plugin-scope.ts:719-726`）：G1 不会给 A 的表授权，A 的表继续靠现有的手工授权；
    - 对 A 再 POST 建表路由（重放）：清单非空时先补授权就 422（`http-routes.cjs:9596-9604`），清单为空、部署又装过客户包时（演示机就是，1.6）重装客户包 500 `STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID`（`stock-preparation-project-targets.cjs:519-526`；客户包只能重装到派生出来的 `_p_` 对象上，`stock-preparation-customer-pack.cjs:710-715`）；
    - 「成员与权限」页给自定义角色加项目表时，名单里含 A 就 422（`http-routes.cjs:10536-10543` 调同一个 G1 端口）；
    - 开关 + 登记行就能让 A 的拉取、看板、导出走 A 的表（§3.4 核对）。
  - **(b) 补一支「认领现有表」路由的小切片**（暂名 `adopt-legacy`），随 R67 包上机：路由内跑租户墙 + 字段存在探针 + 外项目有效行守卫，再经 `store.create` 登记、写审计 `legacy_sheet_adopted`（迁移扩审计动作）；并让成员页、建表重放、客户包修复对非 `_p_` 对象跳过 G1 与重装。后果：要开发、对抗验证、打包上机（时间以 R67 为准）；在它上机之前 A 不登记（开关开了的话 A 的拉取回 ABSENT，见 §4）；上机后有审计行，上面 (a) 的三处 422 / 500 由代码处理而不是靠人记住。
- [ ] **D7** 项目 B 用建表路由新建自己的表（§3.5）？ 是 / 否
- [ ] **D8** 新建的项目表（B 及之后）一开始是空表，人工列为空；自动化、提醒、自建视图按表配置，不会从 A 的表带过去——由 owner 通知客户（ADR §8 第 9 步）？ 是 / 否（项目 A 不涉及：A 继续用原表，人工列原样在）
- [ ] **D10** 同时打开「成员与权限」页（`STOCK_PREP_MEMBERS_PAGE_ENABLED`），并接受下面四条 S5b 锁行为？ 是 / 否
  - 成员页在写某个角色时，该角色的成员提交审批、审批写回（FWB）自动化、写记录关联会排队等它，最长约 20 秒；
  - 对同一角色约 20 个并发写可以占满默认 20 连接的连接池（评审实测：无关的 `SELECT 1` 等了约 5.3 秒）；
  - 插入型的授予人降级（授予人原来没有直授行、对其做较低级别的直授，或加入一个级别更低的成员组）不加锁，与一次进行中的项目表添加之间没有先后保证；
  - 等连接池连接没有上限，只有连接超时（默认 10 秒）兜底。
  （原文：`scripts/ops/global-history-flag-manifest.mjs:800`，结尾写明「OWNER ACCEPTANCE REQUIRED」。D10 选「否」时这四条都不发生：G1 建表路由本身不锁角色行，只锁表行，`packages/core-backend/src/services/stock-preparation-project-sheet-grants.ts:156-172`。D15 选 (a) 时另见上面「名单里含 A 就 422」。）
- [ ] **D11** 给一线（操作人员）评论写权限 `comments:write`？ 是 / 否
  （R66 回归里一线会话的评论接口 403 是**开关开不开都存在**的现状，`r66-deploy-record-20261013.md:42`。评论接口只用全局码判权：读 `rbacGuard('comments','read')`，`packages/core-backend/src/routes/comments.ts:638`、`:658`；写 `rbacGuard('comments','write')`，`:758`。`comments` 不受命名空间准入控制，`packages/core-backend/src/rbac/namespace-admission.ts:17`。若选「是」，按 ADR §8 第 3 步方案 ① 的同一理由，这个平台码不能放进内置角色 `stock-prep_frontline`；放在哪个平台角色上由 owner 定。）
- [ ] **D13** 项目 B 建表之后，把每日试拉的项目清单改回多项目（A + 已建表的其它项目）？ 是 / 否
- [ ] **D14** 约定维护窗口（重启期间后端约半分钟不可用，§2.4）？ 是（时间记私有记录） / 否

**不再作为选项的两项**（原 D9a / D9b，ADR §8 第 5 步）：A 的表就是 env 那张表，撤销或降级 `stock-prep_frontline` 在它上面的表级授权、暂停挂在它上面的自动化，会切断项目 A 正在用的表。认领之后这两项**保留现状**；ADR §8 第 5 步不适用于 A 的表。

D4a–D4d 都选「否」= 清单不写（G2：新建的项目表没有任何角色能打开，平台管理员逐表在「权限」里手工授权，ADR §2；建表路由返回 `grant.skipped = 'no_roles_configured'`，`stock-preparation-project-targets.cjs:302`）。清单只影响**新建**的项目表（B 及之后）和总览表，不影响 A 的表。

**清单的硬约束（代码决定，不是 owner 选项）**：
- 只能写 `stock-prep` 命名空间里的角色 id：`stock-prep` 或 `stock-prep_<字母数字开头，[A-Za-z0-9_-]，至多 64 位>`（`packages/core-backend/src/multitable/stock-preparation-project-sheet-grant-contract.ts:42`、`:50`、`:78-108`）。**`approvals_operator` 不能写进去**：会得 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE`，整次授权一个都不写。一线成员同时持有 `stock-prep_frontline`，靠它就能打开项目表。
- 清单里每个角色都必须存在，缺一个就整次拒绝（404 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND`，`stock-preparation-project-sheet-grants.ts:158-172`）。
- 被拒时**表和登记行已经建好了**（授权在登记之后，`http-routes.cjs:9715`、`:9770`）：建表请求报错，但表在、登记行在、`project_target_create` 审计在，没有授权行。改好清单、重启后，对同一个项目号再 POST 一次建表路由即可补授权（返回 200，「重放」分支先补授权，`http-routes.cjs:9663-9687`；用例 `plugins/plugin-integration-core/__tests__/stock-preparation-project-target-routes.test.cjs:756-774`）。**这条只适用于新建的 `_p_` 表，不适用于 A**（见 D15 (a)）。
- 写法：英文逗号分隔，前后空格会被去掉，重复的去重（`stock-preparation-project-targets.cjs:103-112`）。不要加引号。
- 只增不删：以后从清单里去掉某个角色，**不会**撤销已经授出去的行（`stock-preparation-project-sheet-grants.ts:187-192` 只有一条 `ON CONFLICT DO NOTHING` 插入）。

## 1. 只读预检（开开关之前）

在旧机上执行，结果只记计数与「是 / 否」。SQL 用旧机上机记录里一直在用的执行方式（psql 完整路径、连接串从 `app.env` 读、不回显）；多行 SQL 存成 **ASCII** 文件再 `-f` 执行（Notepad 另存时选 ANSI，或 `Set-Content -Encoding ASCII`；不要存成带 BOM 的 UTF-8，psql 会把 BOM 当语法错误）。每个文件首尾包一层只读事务：

```
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
-- (the SQL of the section goes here)
ROLLBACK;
```

### 1.1 `app.env` 与进程环境：三个新键都不存在，沙箱写入门的两个键都在

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
| `STOCK_PREP_SANDBOX_MODE`、`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` | `app.env=1` | 写入门：新建的 `_p_` 表走项目表分支，要求 `STOCK_PREP_SANDBOX_MODE` 恰为 `true` 且 env 动作自己的 `target.objectId` 在放行清单里（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:2502-2511`、`:2525-2539`）；A 的表不是 `_p_` 形状，走原来的分支，要求它自己的 objectId 在放行清单里（`:2513-2519`）。不在就停：开了也只能预览不能写入 |
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

### 1.4 A 的表：找到它，并用守卫自己的判定数一遍

先找到 env 动作绑定的那张表：

```
SELECT o.sheet_id, o.object_id, o.project_id LIKE '%:integration-core' AS staging_project_shape,
       (SELECT count(*) FROM meta_records m WHERE m.sheet_id = o.sheet_id) AS rows_total
  FROM plugin_multitable_object_registry o
 WHERE o.plugin_name = 'plugin-integration-core'
   AND starts_with(o.object_id, 'plm_stock_preparation_sandbox')
   AND NOT starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_')
 ORDER BY rows_total DESC;
```

`rows_total` 约 744 的那一行就是（旧机 10-14 诊断：744 行）。记下它的 `sheet_id`（= `<旧表 sheetId>`）和 `object_id`（= `<旧表 objectId>`）。再核对它确实是 env 动作的目标：`@(Select-String -LiteralPath $envFile -SimpleMatch -Pattern '<旧表 sheetId>').Count` 应 ≥ 1（只看计数）。

下面这段把守卫 `assertTargetSheetHoldsNoForeignActiveRows`（`stock-preparation-table-actions.cjs:1144-1193`）的判定搬成 SQL：「有效」照 `stockPreparationRowIsActive`（`:1127-1142`）——空 / null / 缺 = 否；布尔照原值；数字非 0 = 是；字符串去首尾空白、转小写后为 `''`、`false`、`0`、`no`、`n` 之一 = 否，其余 = 是；对象 / 数组 = 是。失效行直接跳过（`:1167`），「同一项目」照原值严格相等（`:1168`，不去空白）。字段 id 用宿主的派生规则 `fld_` + sha1(`<staging 项目>:<objectId>:<逻辑字段>`) 前 24 位现算（`packages/core-backend/src/multitable/provisioning.ts:207-225`；需要 `pgcrypto`，迁移 `zzzz20260404153000_repair_meta_core_schema.ts:5` 已建）。

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

期望 `1 | 1`。不是 `1 | 1` 就**停**：说明这张表的字段 id 不是按派生规则来的（env 里显式写了别的映射），下面的计数不可信，而且开关开后按登记行现算的字段映射也会对不上（§3.4 预检 ④），报开发机。

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
       count(*) FILTER (WHERE is_active AND p = to_jsonb('<项目号>'::text)) AS active_rows_of_this_project,
       count(*) FILTER (WHERE is_active AND p IS DISTINCT FROM to_jsonb('<项目号>'::text)) AS foreign_active_rows
  FROM t;
```

`<项目号>` 代入 `<项目号 A>` 跑一次（认领的前提，§3.4 预检 ①）；想看项目 B 时再代入 B。`foreign_active_rows` 就是守卫对「把这个项目拉进这张表」会数出来的数：大于 0 = 409 `TARGET_SHEET_FOREIGN_PROJECT`。旧机 10-14 的诊断是：A 的有效行 354、另一个项目的失效行 390、B 0 行——所以 A 的 `active_rows_of_this_project` 应为 354、`foreign_active_rows` 应为 0（390 行失效行不计，不挡 A）；B 的 `foreign_active_rows` 应为 354。`<项目号 A>` 必须与表里存的值**逐字一致**（`active_rows_of_this_project` = 354 就说明一致），§3.4 的登记行用同一个值。不想代入项目号时，保留上面的 `WITH f AS (...), t AS (...)` 两段，把末尾的 `SELECT … FROM t;` 换成下面这条，只给按项目排序的行数（不含项目号）：

```
SELECT row_number() OVER (ORDER BY count(*) DESC) AS project_rank, count(*) AS active_rows
  FROM t WHERE is_active GROUP BY p ORDER BY 1;
```

**记下基线**（§3.6 用）：

```
SELECT count(*) AS rows_total, max(updated_at) AS last_row_update FROM meta_records WHERE sheet_id = '<旧表 sheetId>';
```

已知差异（不影响结论）：守卫用 JS 的 `trim()` 去空白，SQL 的 `\s` 不含不换行空格等少见空白；缺项目号的有效行在守卫里算作一个「项目」，SQL 里单列在 `active_rows_without_project`。这段 SQL 在开发机一次性库上与守卫本身对拍过（同一组 19 行样本，守卫与 SQL 的有效行、外项目行数一致）。

### 1.5 A 的表上的授权（认领后继续靠它们）

```
SELECT subject_type, CASE WHEN subject_type = 'role' THEN subject_id ELSE '(user)' END AS subject, perm_code, count(*)
  FROM spreadsheet_permissions WHERE sheet_id = '<旧表 sheetId>'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

预计有 `role | stock-prep_frontline | spreadsheet:write | 1`（R66 搬过来的那行，`r66-deploy-record-20261013.md:30`）。用户主体只打印 `(user)`，不出用户 id。记下结果：D15 选 (a) 时 G1 不会给 A 的表授权，谁能打开 A 的表就由这些行决定；**不要撤**。

### 1.6 客户包：建 B 的表时会把它重装到新表上

建表路由在建表**之前**先检查客户包能不能装（`http-routes.cjs:9692-9698`；`stock-preparation-project-targets.cjs:328-342`）。两种已知会拒绝的情形要先排除：

```
SELECT pack_id, pack_version, status, starts_with(object_id, 'plm_stock_preparation_sandbox_p_') AS on_project_sheet
  FROM integration_stock_prep_pack_installs ORDER BY 4, 1;
```

旧机诊断里有 1 行指向 A 的表的对象（迁移 `076_create_integration_stock_prep_pack_installs.sql:49`；这张表没有 sheet_id 列，G1 也不拿它判断「哪张表是 A 的」）。若有，再看包目录文件（`app.env` 键 `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` 指向的文件，`packages/core-backend/src/plugin-runtime-config.ts:6`、`:118-120`），只看计数：

```
@(Select-String -LiteralPath '<包目录文件>' -SimpleMatch -Pattern 'stock-prep-operator').Count
@(Select-String -LiteralPath '<包目录文件>' -SimpleMatch -Pattern 'fieldWritePolicies').Count
```

- 第一条应为 0。不为 0：包的列写权策略还指名 R66 已删掉的旧角色，建 B 的表会被 422 `CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN` 拒绝（`plugins/plugin-integration-core/lib/stock-preparation-customer-pack-installer.cjs:594`、`:976-990`），这时什么都还没建。改包文件是配置改动，由 owner 定，本手册不处理。
- 第二条大于 0：包管列写权，建表的那次登录必须带已验证的租户声明，否则 403 `STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED`（`stock-preparation-project-targets.cjs:345-365`），同样在建表之前拒绝。
- 这两条只关 B 及之后；A 的表上的客户包早已装好，认领不重装。

### 1.7 每日试拉（§4 的依据）

```
Get-ScheduledTask | Where-Object { $_.TaskName -like '*stock-prep*' } | Select-Object TaskPath, TaskName, State
@((Get-ScheduledTask -TaskName 'metasheet-stock-prep-scheduled-dry-run').Actions | Where-Object { $_.Arguments -like '*--apply*' }).Count
```

第二条期望 0（只试算；`--apply` 必须显式写，`scripts/ops/stock-preparation-scheduled-pull.mjs:148`）。项目清单在它的 env 文件 `MS_PROJECT_NOS` 里（`:75`），10-14 起是项目 A（R3），不贴值。它今天能拿到 200 / 409，说明它的账号已经过了拉取门，开开关不需要换账号（ADR §8 第 4 步在演示机上已不是待办）。

### 1.8 停下来的条件（任一成立就不进 §2）

1.1 三个新键任一已存在；沙箱两个键缺；1.2 不为 0；1.3 少角色或 D4 选了不存在 / 不在命名空间的角色；1.4 字段核对不是 `1 | 1`；1.6 第一条不为 0（只挡 B，A 的认领可照做）；§0 有未回答的项。

## 2. 写 `app.env` 并重启（维护窗口内，D1 = 是之后）

D15 选 (a) 时，建议先做 §3.4 的认领（开关关着时登记行不被读取，先登记无副作用），再开开关；这样 A 从开关生效的那一刻起就解析到自己的表，不会出现一段 ABSENT。

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

### 2.4 重启：走计划任务，不要只用 `pm2 restart`

演示机后端由计划任务 `MetaSheet-PM2` → pm2-runtime 托管（`handoff-r59-two-machine-20260924.md:22`）。改了 `app.env` 之后按 `stock-prep-root-selection-config.md:30` 的顺序重启：在 `PM2_HOME` 指向 `.pm2-runtime` 的会话里停应用 → 确认 pm2 命名管道上已没有守护进程（还在就先 `pm2 kill` 再查）→ `Start-ScheduledTask -TaskName 'MetaSheet-PM2' -TaskPath '<任务所在文件夹>'` → 查 health。先 kill 再起任务的原因见 `handoff-r59-two-machine-20260924.md:39`，起来后核对后端挂在 pm2-runtime 下见同文 `:52`。旧机开云课堂 7 个开关时用的就是这条路（`r66-deploy-record-20261013.md:15`「云课堂 7 个开关在」）。

**不要**只跑 `pm2 restart metasheet-backend --update-env`：它把**执行命令的会话**的环境合并进去，不重读 `app.env`（`222-rehearsal-full-run-20260904.md:200`），而且不会撤掉已从 `app.env` 删掉的键（`design-large-bom-worker-20260906.md:350`）。

**是否真的生效，以 §3.1 的接口状态为准**，不以 `app.env` 内容为准；也**不要**为了看环境去跑 `pm2 env`——pm2-runtime 不在守护模式下时，会话里的 pm2 命令会另起一个空守护进程（`handoff-r59-two-machine-20260924.md:50`）。

## 3. 开后核对

### 3.1 哪些接口从 404 变成 200

开关关着时，下列路由在**权限门之后、任何 IO 之前**回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`（`http-routes.cjs:4788-4792`；路由表 `:217-257`；每个处理函数都是「先 `requireAccess`、再 `requireProjectSheetsEnabled()`」，`:9476-9478`、`:9567-9569`、`:9824-9826`、`:9857-9859`、`:9887-9889`、`:9955-9957`、`:9975-9977`、`:10031-10033`、`:10127-10129`）。开了之后：

| 路由 | 门 | 开后期望 |
|---|---|---|
| `GET /api/integration/stock-preparation/project-targets` | OPERATE | 200；D15 (a) 已认领时 1 条（A），否则 0 条 |
| `GET /api/integration/stock-preparation/projects/:projectNo/target` | OPERATE | 200；A 已认领时 `status: 'active'`、`sheetId` = A 的表，未登记的项目 `status: 'absent'`；拉取人员 `may.*` 按 PULL 算（`:9510`、`:9538-9542`） |
| `POST …/projects/:projectNo/target` | PULL | 建表（201 新建 / 200 已登记，`:9803`），只用于 B 及之后（§3.5）；**对 A 不要调** |
| `POST …/target/archive`、`POST …/target/restore` | PULL | 归档 / 恢复（S4），本手册不用 |
| `GET` / `PATCH …/target/project-fields` | OPERATE | 项目级列（S3） |
| `POST /api/integration/stock-preparation/project-overview/refresh` | OPERATE | 总览刷新（S3） |
| `POST /api/integration/stock-preparation/project-overview/ensure` | PULL | 建总览（S3；第一次用建表路由建项目表时也会顺带建，`:9774`；只认领 A、还没建 B 时，由拉取人员在首页点「建立项目总览」） |
| `GET /api/integration/stock-preparation/preflight` | READ | 多出 `checks.projectSheets`：`enabled: true`、`grantRoleCount` = D4 选中的个数、`registeredCount` = 登记行数（A 已认领时 1）（`plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs:496-512`；开关关时没有这个键） |
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

`<项目号>` 代入 `<项目号 A>`。开前跑一次（期望 `list 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED` 等），开后再跑一次（A 已认领时 `target 200 active`）。`list` 仍是 404 就是开关没进进程：回 §2.3 / §2.4，不要反复重启。

### 3.2 界面（管理员会话 + 一线测试账号会话，刷新页面）

- 备料工作台**首页**多出「每个项目一张备料表 / 已经有 N 个项目建了表」一块（`apps/web/src/components/integration/stockPreparation/StockPreparationOperatorHome.vue:69-79`；只有 `project-targets` 回 200 时才渲染）。
- **项目总览不是一个页签**，是这一块里的按钮：拉取人员在总览还没建时看到「建立项目总览」，建好后看到「刷新项目总览」「打开项目总览」（`StockPreparationOperatorHome.vue:82-130`）。
- 首页原来的「打开备料多维表」按钮**消失**：开关开时目录不再按 env 解析表（`http-routes.cjs:11054-11069`；按钮 `StockPreparationOperatorHome.vue:47-66` 只在有 `fillTarget` 时出现）。项目卡片改由登记行列出（`:11071-11083`）：**A 的卡片在登记行存在后回来**；没有登记行时它会从首页消失。
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

### 3.4 认领：把 A 的表登记为项目 A 的表（D15 = (a) 时；(b) 时按 R67 新路由的手册做，本节不用）

认领就是在登记表里加一行：`tenant_id` + `<项目号 A>` → A 的表的 `sheet_id` 与它**真实的** `object_id`。开关开后，`resolveProjectTargetForAction` 只读这一行（`stock-preparation-project-targets.cjs:202-233`），再按 `(<租户>:integration-core, 登记行的 objectId)` 现算字段映射（`:167-184`）；所以 `object_id` 必须是 `plugin_multitable_object_registry` 里这张表的那个值，**不能**写成 `_p_` 形状的派生 id。

**预检**（只读，开关开不开都可以做）：

① 守卫：1.4 的计数 SQL 代入 `<项目号 A>`，`foreign_active_rows = 0`、`active_rows_of_this_project` = 354（逐字一致的证明）。

② 登记表里既没有 A、也没有这张表：

```
SELECT count(*) FILTER (WHERE project_no = '<项目号 A>') AS rows_for_project_a,
       count(*) FILTER (WHERE sheet_id = '<旧表 sheetId>') AS rows_for_old_sheet
  FROM integration_stock_prep_project_target;
```

期望 `0 | 0`。不是就停：登记表对 `(tenant_id, project_no)` 和 `sheet_id` 各有唯一索引（`087_create_integration_stock_prep_project_target.sql:95-100`），重复插入会报错，而且说明有人已经登记过。

③ 对象注册行的形状与写入门：

```
SELECT o.plugin_name,
       o.project_id LIKE '%:integration-core' AS staging_project_shape,
       starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_') AS is_p_shape,
       o.sheet_id = 'sheet_' || left(encode(digest(o.project_id || ':' || o.object_id, 'sha1'), 'hex'), 24) AS sheet_id_is_derived
  FROM plugin_multitable_object_registry o WHERE o.sheet_id = '<旧表 sheetId>';
```

期望 `plugin-integration-core | t | f | t`（表 id 的派生规则见 `provisioning.ts:215-217`）。再确认它的 objectId 在写入门放行清单里（A 的表走写入门的原分支，`stock-preparation-table-actions.cjs:2513-2519`），只打印计数：

```
$line = (Select-String -LiteralPath $envFile -Pattern '^\s*STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS\s*=' | Select-Object -First 1).Line
@($line.Substring($line.IndexOf('=') + 1).Trim().Trim('"').Trim("'").Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -eq '<旧表 objectId>' }).Count
```

期望 1。

④ 现算的字段 id 在这张表上都存在（模板 33 列 + 客户包的 `ext_` 列）。开关开后路由用的是按登记行现算的映射，不再是 env 里写死的映射；任何一列对不上，dry-run 会被字段存在探针挡下（`stock-preparation-table-actions.cjs:729`，调用 `:2046`、`:2635`），但最好在登记前就知道：

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

期望两行，每行 `expected = present`：`template | 33 | 33`；`ext` 的个数等于 env 动作 JSON 里 `extensionFieldIds` 的个数（r7 记录是 21 个，`222-deploy-window-runbook-20260901.md:112`）。33 个逻辑字段就是主模板的字段（`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs:661` 起）。**到机器上核**：`meta_fields` 的 `id` / `sheet_id` 两列名（这里照 `zzzz20260404153000_repair_meta_core_schema.ts:8-18` 写）、客户包台账 `installed_fields_json` 里每项的 `fieldId` / `extension` 两个键名（照迁移 076 第 61 行的注释写），以及 env 动作 JSON 里 `extensionFieldIds` 的实际个数（只数个数，不贴内容）。`present < expected` 就停，报开发机。

⑤ 视图句柄（只读，不挡认领）：

```
SELECT (SELECT count(*) FROM meta_views v WHERE v.sheet_id = o.sheet_id
          AND v.id = 'view_' || left(encode(digest(o.project_id || ':' || o.object_id || ':prep-fill', 'sha1'), 'hex'), 24)) AS fill_view,
       (SELECT count(*) FROM meta_views v WHERE v.sheet_id = o.sheet_id
          AND v.id = 'view_' || left(encode(digest(o.project_id || ':' || o.object_id || ':prep-todo', 'sha1'), 'hex'), 24)) AS todo_view
  FROM plugin_multitable_object_registry o WHERE o.sheet_id = '<旧表 sheetId>';
```

GET target 与卡片的深链按这两个派生 id 给出（`stock-preparation-project-targets.cjs:582-591`；`prep-fill` / `prep-todo` 见 `stock-preparation-templates.cjs:870`、`stock-preparation-target-provisioning.cjs:708`；`meta_views` 列见 `zzz20251231_create_meta_schema.ts:30-34`）。`todo_view` 预计是 0（「待填写」视图只在建表路由建表时建）：这时总览上 A 那一行的「待填写」深链指向一个不存在的视图，具体表现没有核对过，记入私有记录。

**登记**（写库，owner 动作；建议在开开关之前做）：

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
- 其余列（行数、最近拉取等）留空，由后续 dry-run / apply / 总览刷新写入（ADR §5）。
- **审计**：这一行不经 `store.create`，没有审计行（`project_target_create` 不会出现）。在私有记录里记下：执行时间、执行人、`<项目号 A>`、`<旧表 sheetId>`、`<旧表 objectId>`、新行的 `id`、①–⑤ 的结果；#6079 上只贴 values-free 摘要（「项目 A 已按 D15 (a) 认领，登记行 1、预检计数 …」）。

**核对**（开关开后）：

```
SELECT status, count(*) AS registered FROM integration_stock_prep_project_target GROUP BY status;
SELECT count(*) AS old_sheet_registered FROM integration_stock_prep_project_target WHERE sheet_id = '<旧表 sheetId>';
```

期望 `active | 1`（还没建 B 时）与 `old_sheet_registered = 1`。再看：
- §3.1 探针 `target 200 active`；首页出现 A 的卡片，打开后落在 A 的表上（与开关开前看到的是同一张表）。
- 管理员会话对 A 手工做一次 dry-run：结果应与旧机 10-14 那次同口径（add / update / skip 计数相近，`status=ready`）——这说明路由经登记行解析到了 A 的表、租户墙（`http-routes.cjs:4844-4850`，dry-run 调用 `:7009`）和字段存在探针都通过。apply 是不是做、什么时候做仍由 owner 定（旧机 10-14 帖：生产写入等 owner）。
- A 的表上的授权与 1.5 的结果一致（没有新增 G1 行）。

**对 A 的三个「不要」**（D15 = (a) 时一直有效，直到 (b) 那样的代码上机）：
1. **不要**对 A 点「新建备料表」、也不要对 A 再 POST 建表路由：清单非空时 422 `STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET`，清单为空时 500 `STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID`（见 D15 (a)）。界面上 A 的状态是 active，正常只会给「直接打开 / 覆盖拉取」，覆盖拉取走 dry-run / apply，不经建表路由。
2. **不要**在「成员与权限」页把 A 加给自定义角色（422，同一个 G1 端口）。要给某个角色 A 的表的权限，由管理员在多维表「权限」里手工授（G2）。
3. **保留** A 的表上现有的手工授权（1.5 的那些行），也不暂停挂在它上面的自动化——它们就是项目 A 的工作表的授权和自动化。

### 3.5 项目 B 及之后：「拉一个新项目 → 新建备料表并拉取」（D7 = 是时）

拉取人员操作：首页「拉一个新项目」→ 输入 `<项目号>` → 项目备料页的项目接入面板「从PLM拉取数据」→ 确认框「将为这个项目号新建一张备料表」→「新建备料表并拉取」（文案 `apps/web/src/services/integration/stockPreparation/plainLanguage.ts:2325`、`:2343`、`:2348`）→ 预览「将写入 N 行」→ 确认写入。取消预览时保留一张 0 行的空表，状态「还没拉过」（ADR §4，没有「撤销新建」）。

建表路由按这个顺序做（`http-routes.cjs:9567-9804`）：门 → 开关 → 空请求体 → 租户 → 审计词表探针（迁移 088）→ 读登记行 → 客户包计划与预检 → 200 张上限（含已归档与认领的 A，`:9700-9703`；`stock-preparation-project-targets.cjs:71`）→ 建表（冻结模板、objectId 与表 id 服务端派生，`stock-preparation-project-targets.cjs:244-289`）→ 装客户包 → 写登记行（`:9715`）→ 审计 `project_target_create`（`:9726-9738`）→ G1 授权（`:9770`）→ 审计 `project_target_grant` → 顺带建总览并给清单角色授读（尽力而为，失败不影响建表，`:9774`、`:4569-4580`）。

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

期望：
- 登记表 `active | 2`（A 认领 + B），`applied` 按实际写入的项目数。
- 审计（表 `integration_stock_prep_audit`，迁移 `066_create_integration_stock_prep_audit.sql:18`，动作由 `088_extend_stock_prep_audit_project_target_actions.sql:32-48` 放开）：`project_target_create | sheet_created | 1`（只有 B；A 的认领没有审计行）；装了客户包时另有 `project_target_create | customer_pack_installed | 1`（`http-routes.cjs:9740-9767`）；D4 非全否时 `project_target_grant | granted | 1` 和 `project_target_grant | overview_read_granted | 1`；第一次建总览时 `project_overview_refresh | sheet_created | 1`。审计只记计数，不记角色 id（`:9605-9615`）。
- 授权：每个 D4 选中的角色在 B 的 `project_sheet` 上一行 `spreadsheet:write`、在 `overview` 上一行 `spreadsheet:read`；没有别的角色、没有 `approvals_operator`；A 的表不在这个查询里（它不是 `_p_` 对象）。
- `old_sheet_registered = 1`（D15 (a)；只能是 A 那一行）。
- 一线测试账号刷新后能从卡片打开 B 的表并录入人工列；`GET …/projects/<项目号>/target` 的 `rowCount` 与网格 All Records 视图的行数一致（ADR §8 第 8 步；工具栏行数是当前视图的数，不是全表）。

### 3.6 A 的表：只装 A 的有效行

认领之后，对 A 的拉取（apply）**会**写这张表，所以 1.4 的行数基线只用来对照 A 自己的变化，不再是「没被动过」的证明。要核的是**没有别的项目写进来**：重跑 1.4 的计数 SQL 代入 `<项目号 A>`，`foreign_active_rows` 仍为 0；项目 B 及之后各自在自己的 `_p_` 表里（§3.5 的 `old_sheet_registered` 仍为 1）。表里那 390 行第三个项目的失效行不受影响、也不挡 A（守卫跳过失效行，`stock-preparation-table-actions.cjs:1167`）。**不要删除这张表**：界面删除对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（`packages/core-backend/src/multitable/sheet-delete-guard.ts:50`、`:131`），也不要用 SQL 删。

### 3.7 出错时（照码判断，不要在现场改代码或改库）

| 现象 | 含义 | 处理 |
|---|---|---|
| 对 A：422 `STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET` 或 500 `STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID` | 有人对 A 调了建表路由或在成员页加了 A（§3.4 的「不要」） | 什么都没改（授权与重装在任何写入之前被拒）。不要重试 |
| 对 A：409 `STOCK_PREPARATION_PROJECT_ABSENT` | A 还没认领（或登记行的项目号与请求的不逐字一致） | 回 §3.4；D15 = (b) 时这是 R67 之前的预期状态 |
| 对 A 的 dry-run：422 字段不存在 / `TABLE_ACTION_TARGET_TENANT_*` | 现算的字段映射或租户对不上（§3.4 预检 ④ / ③ 没过却登记了） | 停，报开发机；不要改登记行 |
| 404 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND` / 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE` / 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_ID_INVALID` | 建 B 时清单写错，**B 的表和登记行已建好**，没有授权 | 改清单（§0 硬约束）→ §2.4 重启 → 对 B 再 POST 一次建表路由（200 重放补授权） |
| 403 `STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED` | 客户包管列写权，这次登录没有已验证的租户声明（1.6） | 什么都没建。换一个带租户声明的登录再做 |
| 422 `CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN` | 包目录里的列写权策略指名了不存在的角色（1.6） | 什么都没建。报 owner |
| 409 `STOCK_PREPARATION_PROJECT_TARGET_LIMIT` | 本租户已有 200 张（含已归档与认领） | 出现就停 |
| 403 `STOCK_PREP_APPLY_SANDBOX_ONLY` | 写入门没放行（1.1 沙箱两个键；A 另见 §3.4 预检 ③） | 只能预览；报 owner |
| 写入时 409 `TARGET_SHEET_FOREIGN_PROJECT` | 不应出现：A 的表只有 A 的有效行，B 的表只有 B | 停，报开发机 |
| 客户包装到一半宿主写失败 | B 的表已建但未登记（每个项目号至多一张，派生 id） | 重试同一个按钮，复用同一张表（`http-routes.cjs:9558-9566` 注释） |

## 4. 每日试拉（06:00，`metasheet-stock-prep-scheduled-dry-run`）

- **现在**（开关关）：清单 10-14 已改为项目 A（R3）。试拉的目标是 env 那张表 = A 的表；表里只有 A 的有效行（另 390 行第三个项目的失效行不计，`stock-preparation-table-actions.cjs:1167`），守卫通过，result=0、`skipped_dry_run_only`（旧机 10-14 帖）。
- **开开关之后、A 已认领**：A 的试拉经登记行解析到同一张表，结果与现在同口径。
- **开开关之后、A 未认领**（D15 = (b) 且 R67 未上机）：A 回 409 `STOCK_PREPARATION_PROJECT_ABSENT`，脚本把它当「跳过」（`skipped_project_sheet_absent`），**不算失败、不改退出码**（`scripts/ops/stock-preparation-scheduled-pull.mjs:523-536`）——result=0 但其实没拉。这段时间 result=0 不说明拉到了数据，要看日志里 A 的 `action`。
- 脚本绝不建表。项目 B 建了表之后（§3.5），D13 = 是时再把清单改回多项目；B 的试拉打到 B 自己的 `_p_` 表上。
- 定时任务的令牌必须是绑定租户的服务账号（`stock-preparation-scheduled-pull.mjs:32`）。登记行按租户查，所以登记 A 时用的租户（§3.4 从对象注册行取）与这个服务账号必须是同一租户；开开关后第一次 06:00 试拉若 A 是 `skipped_project_sheet_absent`，就是租户或项目号不一致，停下报开发机（本手册没有在演示机上核对过这一点）。

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
2. 按 §2.4 重启（同样走计划任务；不要只用 `pm2 restart --update-env`，它撤不掉删掉的键）。
3. 跑 §3.1 的探针：`list` 回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`，`preflight` 里没有 `projectSheets`。
4. 回退之后**留下的东西**（什么都不删）：登记行（含 A 的认领行）、项目表及其数据、总览表、已授出的表级授权、审计行。开关关时登记行不被读取，A 照旧经 env 解析到同一张表。G1 只增不删，所以有授权的人仍能在多维表网格里打开、编辑 B 等项目表。重新打开开关即恢复原样（ADR §8）。
5. 回退之后的行为：所有路由回到 env 那张表（= A 的表）；拉 A 以外的任何项目都会被一表一项目守卫 409；每日试拉（清单是 A）不受影响；首页「打开备料多维表」按钮回来。
6. **不要**：删任何表（托管表本来也删不掉）、`DELETE` 登记表或授权行、跑迁移 087 / 088 的 `down()`、回退安装包。撤销 A 的认领行本身不在本手册范围，需要时由 owner 另定。

## 6. 已知限制（开之前 owner 应知道）

- **D15 (a) 的认领行没有审计、G1 不认它**：见 D15 与 §3.4 的「不要」。总览上 A 那一行的「待填写」深链可能指向不存在的视图（§3.4 预检 ⑤）。
- **S5b 锁行为**只在 D10 = 是时存在，四条见 D10。
- **权限变化最长 60 秒生效**（`rbac/service.ts:13`）：任命、开通准入、改角色之后等一分钟再让对方刷新页面；页面早已打开的会话要刷新才看到新按钮。
- **G1 只增不删、只有写一级**：从清单去掉角色不会收回已授的行；想让某张项目表对某个角色只读或收回，只能由管理员在「权限」里手工处理（ADR §11.7）。
- **表级写同时打开字段与视图管理**（ADR §11.7，D5）。
- **归档的表仍在多维表左侧列表里**，对有授权的人可见，网格照样可写（ADR §6 默认 (ii)）。
- **总览的数字不是实时的**：只在建表、拉取、确认、手动刷新等时刻重算，界面显示「截至 hh:mm」（ADR §5）。
- **新建的项目表从空表开始**；自动化、提醒、自建视图按表配置，不会从 A 的表带过去（D8）。
- **R-35 记录的四条已知限制**（`decision-register.md:44`）：(a) 建表后的审计追加在事务之外，追加失败不重放；(b) 200 张上限在路由侧先计数后建表，建表与登记之间无锁（登记侧在事务内加租户锁复核）；(c) G1 的真库用例自行重建宿主事务；(d) 迁移 087 的约束只在假件和真库竞争用例上验证过。
- **建表路由里的授权等表行锁时没有超时上限**：只有成员页调用时才设 5 秒 `lock_timeout`（`stock-preparation-project-sheet-grants.ts:146-151`）；建表路由不设，由语句超时兜底。正常操作下不会撞上。

## 7. 代码与 ADR / 其它文档的出入（照实写，供 owner 与 Codex 评审）

1. **没有认领路由**：登记一张已有表在代码里没有入口——`store.create`（`stock-preparation-project-target-store.cjs:362-407`）只被建表路由调用，建表路由总是建派生的 `_p_` 对象；ADR §3.1 有意删掉了 v1 的 register-bound 路由（`adr-stock-prep-project-sheets-20261008.md:171`）。owner 2026-10-14 要求认领现有表，与 ADR Q3 / §3.1 相反；D15 (a) 绕过代码直接写登记表，(b) 是补回一支路由。登记表（迁移 087）对 `sheet_id` / `object_id` 没有外键也没有形状检查，所以 (a) 的 INSERT 在库层面可行。
2. **读路由遇到未登记项目**：ADR §3 的表写「读路由走该路由原有的『找不到』分支」；代码对读也回 409 `STOCK_PREPARATION_PROJECT_ABSENT`（`stock-preparation-project-targets.cjs:187-229` 注释写明这是有意偏离，R-35 第 (3) 条已记）。看板把它渲染成「表还没建好」。
3. **G1 审计记什么**：ADR §2 写 `project_target_grant`「记角色 id 和表 id」；代码只记表 id（`subjectId`）和三个计数，不记角色 id（`http-routes.cjs:9605-9615`）。
4. **G1 清单同时决定总览的读权限**：ADR §2 / §11.5 只说给项目表授写；代码还用同一份清单给项目总览表授 `spreadsheet:read`（`plugin-scope.ts:757-812`，`http-routes.cjs:4544-4560`）。
5. **「成员与权限」页另有开关**：ADR §11.6 只写门是 WORKBENCH_ADMIN，§8 第 6 步只写本开关和清单；代码里这一页要另一个默认关的开关 `STOCK_PREP_MEMBERS_PAGE_ENABLED`，且打开它须 owner 接受 S5b 锁行为（`global-history-flag-manifest.mjs:793-800`）。打开 G1 开关**不会**出现这一页。
6. **项目总览不是工作台页签**：是首页「每个项目一张备料表」那一块里的三个按钮（`StockPreparationOperatorHome.vue:82-130`）。
7. **flag manifest 的说明过时**：`global-history-flag-manifest.mjs:681` 写开关关时「the three project-sheet routes」回 404；现在是 9 条（`http-routes.cjs:217-257`，S1 / S4 五条加 S3 四条）。同一条写「read PER REQUEST (no restart)」：对进程环境成立，但演示机靠 `app.env` 进环境，改了必须按 §2.4 重启。
8. **附录 A.5**（`adr-stock-prep-project-sheets-20261008-addendum-a-d.md:60-65`）原三条——升级前先建「备料拉取人员」角色、「不要用迁移写角色」、「一线角色不用改」——都已不成立，同节 2026-10-10 订正（`:66`）已写明；读附录时以订正为准。
9. **ADR §8 第 5 步**（撤销一线在旧表上的授权、暂停旧表自动化）在认领 A 之后不适用于 A 的表（§0「不再作为选项的两项」）。
10. **旧机诊断里「删表路由对托管表无守卫」**与当前代码不符：`sheet-delete-guard.ts:50`、`:131` 对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（ADR §0 第 3 条同此；旧机 10-14 第二帖也写「走 `DELETE …`（有守卫）」）。无论如何本手册不删任何表。
