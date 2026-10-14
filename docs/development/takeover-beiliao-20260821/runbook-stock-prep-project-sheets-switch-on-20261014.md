# 运行手册：在演示机上打开「一个项目一张备料表」（G1 开关，ADR §8 第 6 步）

> 依据：ADR `adr-stock-prep-project-sheets-20261008.md` §8 第 6–9 步（以下简称 ADR）；决策登记 R-35（S1）、R-37（S3）、R-38（S4）、R-39（S5）。请求来源：#6079 评论 6162564175（旧机 2026-10-14「请开发机给出 G1 开启 runbook」）。
> **基线**：origin/main `0736c3af3`（`0736c3af32f4b967069e2fabdf21d5cfbfdb5a09`）。下文所有 `path:line` 都在这个提交上核过。演示机跑的是 R66（`e2345ab6b`，`r66-deploy-record-20261013.md:7`）；本手册引用的代码在这两个提交之间没有改动的前提**没有逐文件核对**，上机前按 §1 的只读结果为准。
> **开不开、什么时候开，由 owner 决定。** 本手册只列出 owner 要拍板的事（§0），不替 owner 选。在演示机上执行任何一步（含只读 SQL）都是 owner 动作，在旧机上执行。
> **values-free**：不含主机、地址、口令、令牌、账号名、真实项目号。项目号一律写 `<项目号>`；`<旧表 sheetId>`、`<安装根目录>`、`<令牌文件>`、`<后端直连地址>` 等占位符在执行时替换，替换后的值只记在私有记录里，不贴进 issue / PR。命令是 ASCII，可在 Windows PowerShell 5.1 下执行。

## 这个开关做什么、不做什么

- 开关是 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`（`plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs:63`），**只认精确的小写 `true`**（`:98-100`：`' true'`、`TRUE`、`1` 都算关），每个请求现读。登记在 `scripts/ops/global-history-flag-manifest.mjs:674`（`danger: 'high'`）。
- 开了之后：
  - 每条备料读写路由按项目号去登记表 `integration_stock_prep_project_target`（迁移 `packages/core-backend/migrations/087_create_integration_stock_prep_project_target.sql:1`）找这个项目自己的表；没登记的项目一律 409 `STOCK_PREPARATION_PROJECT_ABSENT`，**不再**落到 env 里那张旧表（`stock-preparation-project-targets.cjs:187-229`）。
  - 拉取人员（`stock-prep:pull`，`plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs:91`、`:579-580`）可以在工作台「拉一个新项目」时为一个项目新建一张受管表并登记（`plugins/plugin-integration-core/lib/http-routes.cjs:9567`，下称「建表路由」）。
  - 建表后按 G1 角色清单 `MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`（`stock-preparation-project-targets.cjs:67`，读取 `:103-112`；登记 `global-history-flag-manifest.mjs:685`）给这些角色在新表上授 `spreadsheet:write`，在项目总览表上授 `spreadsheet:read`（`packages/core-backend/src/multitable/plugin-scope.ts:704-753`、`:757-812`）。
- **不做**：不动 env 里那张旧表（演示机上 744 行那张），不迁移、不登记、不删除（ADR Q3）；不撤销任何已有授权；不开「成员与权限」页（那是另一个开关 `STOCK_PREP_MEMBERS_PAGE_ENABLED`，`packages/core-backend/src/services/stock-preparation-members.ts:143`、`:281-282`，见 §0 D10）。
- **开过之后再关 ≠ 回到今天**：关掉后所有路由回到旧表，而旧表里装着项目 A 的有效行，一表一项目守卫会拒绝其它项目（ADR §8「从开切回关」；`global-history-flag-manifest.mjs:681`）。即「关开关 = 停用拉取」。

## 0. owner 决策清单（每条回「是 / 否」；全部回答之前不执行 §2）

- [ ] **D1** 在演示机上打开 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`？ 是 / 否
- [ ] **D2** 接受「开过之后再关 = 停用拉取，不是回到今天的行为」？ 是 / 否
- [ ] **D3** 任命拉取人员（`stock-prep_puller` 今天 0 成员，§1.3 核对）？ 是（任命谁记在私有记录） / 否（第一次拉取由平台管理员自己做）
- [ ] **D4a** G1 角色清单包含 `stock-prep_frontline`「操作人员」？ 是 / 否
- [ ] **D4b** G1 角色清单包含 `stock-prep_puller`？ 是 / 否
- [ ] **D4c** G1 角色清单包含 `stock-prep_admin`？ 是 / 否
- [ ] **D4d** G1 角色清单包含 `stock-prep_developer`？ 是 / 否
- [ ] **D5** 接受「表级 `spreadsheet:write` 同时打开这张项目表的字段和视图管理」（ADR §11.7；一线今天在旧表上就是这一级）？ 是 / 否
- [ ] **D6** 第一张项目表建项目 A（旧表里有 354 行有效行的那个）？ 是 / 否
- [ ] **D7** 第一张项目表建项目 B（每日试拉现在拉的那个，库里 0 行）？ 是 / 否
- [ ] **D8** 接受「旧表里人工填的列不会带进新表，新表第一次拉取后人工列是空的；自动化、提醒、自建视图都按表配置，不会自动带过去」，并由 owner 通知客户（ADR §8 第 9 步）？ 是 / 否
- [ ] **D9a** 撤销或降级 `stock-prep_frontline` 在旧表上的表级授权（ADR §8 第 5 步；R66 搬过去的那 1 行）？ 是 / 否
- [ ] **D9b** 暂停挂在旧表上的自动化（如果有）？ 是 / 否
- [ ] **D10** 同时打开「成员与权限」页（`STOCK_PREP_MEMBERS_PAGE_ENABLED`），并接受下面四条 S5b 锁行为？ 是 / 否
  - 成员页在写某个角色时，该角色的成员提交审批、审批写回（FWB）自动化、写记录关联会排队等它，最长约 20 秒；
  - 对同一角色约 20 个并发写可以占满默认 20 连接的连接池（评审实测：无关的 `SELECT 1` 等了约 5.3 秒）；
  - 插入型的授予人降级（授予人原来没有直授行、对其做较低级别的直授，或加入一个级别更低的成员组）不加锁，与一次进行中的项目表添加之间没有先后保证；
  - 等连接池连接没有上限，只有连接超时（默认 10 秒）兜底。
  （原文：`scripts/ops/global-history-flag-manifest.mjs:800`，结尾写明「OWNER ACCEPTANCE REQUIRED」。D10 选「否」时这四条都不发生：G1 建表路由本身不锁角色行，只锁表行，`packages/core-backend/src/services/stock-preparation-project-sheet-grants.ts:156-172`。）
- [ ] **D11** 给一线（操作人员）评论写权限 `comments:write`？ 是 / 否
  （R66 回归里一线会话的评论接口 403 是**开关开不开都存在**的现状，`r66-deploy-record-20261013.md:42`。评论接口只用全局码判权：读 `rbacGuard('comments','read')`，`packages/core-backend/src/routes/comments.ts:638`、`:658`；写 `rbacGuard('comments','write')`，`:758`。`comments` 不受命名空间准入控制，`packages/core-backend/src/rbac/namespace-admission.ts:17`。若选「是」，按 ADR §8 第 3 步方案 ① 的同一理由，这个平台码不能放进内置角色 `stock-prep_frontline`；放在哪个平台角色上由 owner 定。）
- [ ] **D12** 把每日试拉的项目清单改为项目 A（**开开关之前**，旧机诊断里的出路 1）？ 是 / 否
- [ ] **D13** 开开关之后，把每日试拉的项目清单改为已经建了项目表的项目？ 是 / 否
- [ ] **D14** 约定维护窗口（重启期间后端约半分钟不可用，§2.4）？ 是（时间记私有记录） / 否

D4a–D4d 都选「否」= 清单不写（G2：建表成功，但没有任何角色能打开这张表，平台管理员逐表在「权限」里手工授权，ADR §2；建表路由返回 `grant.skipped = 'no_roles_configured'`，`stock-preparation-project-targets.cjs:302`）。

**清单的硬约束（代码决定，不是 owner 选项）**：
- 只能写 `stock-prep` 命名空间里的角色 id：`stock-prep` 或 `stock-prep_<字母数字开头，[A-Za-z0-9_-]，至多 64 位>`（`packages/core-backend/src/multitable/stock-preparation-project-sheet-grant-contract.ts:42`、`:50`、`:78-108`）。**`approvals_operator` 不能写进去**：会得 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE`，整次授权一个都不写。一线成员同时持有 `stock-prep_frontline`，靠它就能打开项目表。
- 清单里每个角色都必须存在，缺一个就整次拒绝（404 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND`，`stock-preparation-project-sheet-grants.ts:158-172`）。
- 被拒时**表和登记行已经建好了**（授权在登记之后，`http-routes.cjs:9715`、`:9770`）：建表请求报错，但表在、登记行在、`project_target_create` 审计在，没有授权行。改好清单、重启后，对同一个项目号再 POST 一次建表路由即可补授权（返回 200，「重放」分支先补授权，`http-routes.cjs:9663-9687`；用例 `plugins/plugin-integration-core/__tests__/stock-preparation-project-target-routes.test.cjs:756-774`）。
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
| `STOCK_PREP_SANDBOX_MODE`、`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` | `app.env=1` | 项目表的 apply 走沙箱写入门的新分支，四个条件里有两个就是这两个键：`STOCK_PREP_SANDBOX_MODE` 恰为 `true`，且 env 动作自己的 `target.objectId` 在放行清单里（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:2502-2511`、`:2525-2539`）。不在就停：开了也只能预览不能写入 |
| `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` | 记下计数 | 见 1.6 |

### 1.2 登记表与项目表：今天应当全是 0

```
SELECT status, count(*) FROM integration_stock_prep_project_target GROUP BY status;
SELECT count(*) FILTER (WHERE starts_with(object_id, 'plm_stock_preparation_sandbox_p_')) AS project_sheets,
       count(*) FILTER (WHERE object_id = 'plm_stock_preparation_project_overview') AS overview_sheets
  FROM plugin_multitable_object_registry WHERE plugin_name = 'plugin-integration-core';
```

期望：第一条 0 行；第二条 `0 | 0`。项目表 objectId 前缀见 `plugins/plugin-integration-core/lib/stock-preparation-own-base.cjs:129-130`，总览表 objectId 见 `packages/core-backend/src/multitable/stock-preparation-overview-contract.ts:65`。不为 0 说明有人在别处开过开关，停下报 owner。

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

### 1.4 旧表：用守卫自己的判定数一遍（不改任何东西）

先找到 env 动作绑定的那张旧表：

```
SELECT o.sheet_id, o.object_id, (SELECT count(*) FROM meta_records m WHERE m.sheet_id = o.sheet_id) AS rows_total
  FROM plugin_multitable_object_registry o
 WHERE o.plugin_name = 'plugin-integration-core'
   AND starts_with(o.object_id, 'plm_stock_preparation_sandbox')
   AND NOT starts_with(o.object_id, 'plm_stock_preparation_sandbox_p_')
 ORDER BY rows_total DESC;
```

`rows_total` 约 744 的那一行就是（旧机 10-14 诊断：744 行）。再核对它确实是 env 动作的目标：`@(Select-String -LiteralPath $envFile -SimpleMatch -Pattern '<旧表 sheetId>').Count` 应 ≥ 1（只看计数）。

下面这段把守卫 `assertTargetSheetHoldsNoForeignActiveRows`（`stock-preparation-table-actions.cjs:1144-1193`）的判定搬成 SQL：「有效」照 `stockPreparationRowIsActive`（`:1127-1142`）——空 / null / 缺 = 否；布尔照原值；数字非 0 = 是；字符串去首尾空白、转小写后为 `''`、`false`、`0`、`no`、`n` 之一 = 否，其余 = 是；对象 / 数组 = 是。「同一项目」照原值严格相等（不去空白）。字段 id 用宿主的派生规则 `fld_` + sha1(`<staging 项目>:<objectId>:<逻辑字段>`) 前 24 位现算（`packages/core-backend/src/multitable/provisioning.ts:207-225`；需要 `pgcrypto`，迁移 `zzzz20260404153000_repair_meta_core_schema.ts:5` 已建）。

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

期望 `1 | 1`。不是 `1 | 1` 就**停**：说明这张表的字段 id 不是按派生规则来的（env 里显式写了别的映射），下面的计数不可信，报开发机。

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

`<项目号>` 分别代入项目 A、项目 B 各跑一次。`foreign_active_rows` 就是守卫对「把这个项目拉进旧表」会数出来的数：大于 0 = 409 `TARGET_SHEET_FOREIGN_PROJECT`。旧机 10-14 的诊断是：A 的有效行 354、另一个项目的失效行 390、B 0 行——所以 A 的 `foreign_active_rows` 应为 0，B 的应为 354。不想代入项目号时，保留上面的 `WITH f AS (...), t AS (...)` 两段，把末尾的 `SELECT … FROM t;` 换成下面这条，只给按项目排序的行数（不含项目号）：

```
SELECT row_number() OVER (ORDER BY count(*) DESC) AS project_rank, count(*) AS active_rows
  FROM t WHERE is_active GROUP BY p ORDER BY 1;
```

**记下基线**（§3.5 用来证明旧表没被动过）：

```
SELECT count(*) AS rows_total, max(updated_at) AS last_row_update FROM meta_records WHERE sheet_id = '<旧表 sheetId>';
```

已知差异（不影响结论）：守卫用 JS 的 `trim()` 去空白，SQL 的 `\s` 不含不换行空格等少见空白；缺项目号的有效行在守卫里算作一个「项目」，SQL 里单列在 `active_rows_without_project`。这段 SQL 在开发机一次性库上与守卫本身对拍过（同一组 19 行样本，守卫与 SQL 的有效行、外项目行数一致）。

### 1.5 旧表上的授权（D9a 的依据）

```
SELECT subject_type, CASE WHEN subject_type = 'role' THEN subject_id ELSE '(user)' END AS subject, perm_code, count(*)
  FROM spreadsheet_permissions WHERE sheet_id = '<旧表 sheetId>'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

预计有 `role | stock-prep_frontline | spreadsheet:write | 1`（R66 搬过来的那行，`r66-deploy-record-20261013.md:30`）。用户主体只打印 `(user)`，不出用户 id。

### 1.6 客户包：建表时会把它重装到新表上

建表路由在建表**之前**先检查客户包能不能装（`http-routes.cjs:9692-9698`；`stock-preparation-project-targets.cjs:328-342`）。两种已知会拒绝的情形要先排除：

```
SELECT pack_id, pack_version, status, starts_with(object_id, 'plm_stock_preparation_sandbox_p_') AS on_project_sheet
  FROM integration_stock_prep_pack_installs ORDER BY 4, 1;
```

旧机诊断里有 1 行指向旧表的对象（迁移 `076_create_integration_stock_prep_pack_installs.sql:49`）。若有，再看包目录文件（`app.env` 键 `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` 指向的文件，`packages/core-backend/src/plugin-runtime-config.ts:6`、`:118-120`），只看计数：

```
@(Select-String -LiteralPath '<包目录文件>' -SimpleMatch -Pattern 'stock-prep-operator').Count
@(Select-String -LiteralPath '<包目录文件>' -SimpleMatch -Pattern 'fieldWritePolicies').Count
```

- 第一条应为 0。不为 0：包的列写权策略还指名 R66 已删掉的旧角色，建表会被 422 `CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN` 拒绝（`plugins/plugin-integration-core/lib/stock-preparation-customer-pack-installer.cjs:594`、`:976-990`），这时什么都还没建。改包文件是配置改动，由 owner 定，本手册不处理。
- 第二条大于 0：包管列写权，建表的那次登录必须带已验证的租户声明，否则 403 `STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED`（`stock-preparation-project-targets.cjs:345-365`），同样在建表之前拒绝。

### 1.7 每日试拉（§4 的依据）

```
Get-ScheduledTask | Where-Object { $_.TaskName -like '*stock-prep*' } | Select-Object TaskPath, TaskName, State
@((Get-ScheduledTask -TaskName 'metasheet-stock-prep-scheduled-dry-run').Actions | Where-Object { $_.Arguments -like '*--apply*' }).Count
```

第二条期望 0（只试算；`--apply` 必须显式写，`scripts/ops/stock-preparation-scheduled-pull.mjs:148`）。项目清单在它的 env 文件 `MS_PROJECT_NOS` 里（`:75`），只读看列了哪几个项目，不贴值。今天它能拿到 409 `TARGET_SHEET_FOREIGN_PROJECT`，说明它的账号已经过了拉取门（409 发生在门之后），开开关不需要换账号（ADR §8 第 4 步在演示机上已不是待办）。

### 1.8 停下来的条件（任一成立就不进 §2）

1.1 三个新键任一已存在；沙箱两个键缺；1.2 不为 0；1.3 少角色或 D4 选了不存在 / 不在命名空间的角色；1.4 字段核对不是 `1 | 1`；1.6 第一条不为 0；§0 有未回答的项。

## 2. 写 `app.env` 并重启（维护窗口内，D1 = 是之后）

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
| `GET /api/integration/stock-preparation/project-targets` | OPERATE | 200，0 条 |
| `GET /api/integration/stock-preparation/projects/:projectNo/target` | OPERATE | 200，`status: 'absent'`；拉取人员 `may.create = true`，其他人 false（`:9510`、`:9538-9542`） |
| `POST …/projects/:projectNo/target` | PULL | 建表（201 新建 / 200 已登记，`:9803`），见 3.4 |
| `POST …/target/archive`、`POST …/target/restore` | PULL | 归档 / 恢复（S4），本手册不用 |
| `GET` / `PATCH …/target/project-fields` | OPERATE | 项目级列（S3） |
| `POST /api/integration/stock-preparation/project-overview/refresh` | OPERATE | 总览刷新（S3） |
| `POST /api/integration/stock-preparation/project-overview/ensure` | PULL | 建总览（S3；第一次建项目表时也会顺带建，`:9774`） |
| `GET /api/integration/stock-preparation/preflight` | READ | 多出 `checks.projectSheets`：`enabled: true`、`grantRoleCount` = D4 选中的个数、`registeredCount: 0`（`plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs:496-512`；开关关时没有这个键） |
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

开前跑一次（期望 `list 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED` 等），开后再跑一次。`list` 仍是 404 就是开关没进进程：回 §2.3 / §2.4，不要反复重启。

### 3.2 界面（管理员会话 + 一线测试账号会话，刷新页面）

- 备料工作台**首页**多出「每个项目一张备料表 / 已经有 0 个项目建了表」一块（`apps/web/src/components/integration/stockPreparation/StockPreparationOperatorHome.vue:69-79`；只有 `project-targets` 回 200 时才渲染）。
- **项目总览不是一个页签**，是这一块里的按钮：拉取人员在总览还没建时看到「建立项目总览」，建好后看到「刷新项目总览」「打开项目总览」（`StockPreparationOperatorHome.vue:82-130`）。
- 首页原来的「打开备料多维表」按钮**消失**：开关开时目录不再解析旧表（`http-routes.cjs:11054-11069`；按钮 `StockPreparationOperatorHome.vue:47-66` 只在有 `fillTarget` 时出现）。只靠旧表扫描出来的项目卡片（如项目 A）也随之不再出现，直到为它建了项目表。旧表本身还在多维表左侧列表里，有授权的人照样能打开。
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

D3 = 否时由平台管理员做第一次拉取（平台管理员直接满足所有档，`stock-preparation-workbench-access.cjs:572`）；注意 1.6 第二条大于 0 时，这次登录要带租户声明。

### 3.4 第一次「拉一个新项目 → 新建备料表并拉取」（D6 / D7 选中的项目）

拉取人员操作：首页「拉一个新项目」→ 输入 `<项目号>` → 项目备料页的项目接入面板「从PLM拉取数据」→ 确认框「将为这个项目号新建一张备料表」→「新建备料表并拉取」（文案 `apps/web/src/services/integration/stockPreparation/plainLanguage.ts:2325`、`:2343`、`:2348`）→ 预览「将写入 N 行」→ 确认写入。取消预览时保留一张 0 行的空表，状态「还没拉过」（ADR §4，没有「撤销新建」）。

建表路由按这个顺序做（`http-routes.cjs:9567-9804`）：门 → 开关 → 空请求体 → 租户 → 审计词表探针（迁移 088）→ 读登记行 → 客户包计划与预检 → 200 张上限（含已归档，`:9700-9703`；`stock-preparation-project-targets.cjs:71`）→ 建表（冻结模板、objectId 与表 id 服务端派生，`stock-preparation-project-targets.cjs:244-289`）→ 装客户包 → 写登记行（`:9715`）→ 审计 `project_target_create`（`:9726-9738`）→ G1 授权（`:9770`）→ 审计 `project_target_grant` → 顺带建总览并给清单角色授读（尽力而为，失败不影响建表，`:9774`、`:4569-4580`）。

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
- 登记表 `active | 1 | 1`（只预览未写入时 `applied = 0`）。
- 审计（表 `integration_stock_prep_audit`，迁移 `066_create_integration_stock_prep_audit.sql:18`，动作由 `088_extend_stock_prep_audit_project_target_actions.sql:32-48` 放开）：`project_target_create | sheet_created | 1`；装了客户包时另有 `project_target_create | customer_pack_installed | 1`（`http-routes.cjs:9740-9767`）；D4 非全否时 `project_target_grant | granted | 1` 和 `project_target_grant | overview_read_granted | 1`；`project_overview_refresh | sheet_created | 1`（第一次建总览）。审计只记计数，不记角色 id（`:9605-9615`）。
- 授权：每个 D4 选中的角色在 `project_sheet` 上一行 `spreadsheet:write`、在 `overview` 上一行 `spreadsheet:read`；没有别的角色、没有 `approvals_operator`。
- `old_sheet_registered = 0`。
- 一线测试账号刷新后能从卡片打开这张项目表并录入人工列；`GET …/projects/<项目号>/target` 的 `rowCount` 与网格 All Records 视图的行数一致（ADR §8 第 8 步；工具栏行数是当前视图的数，不是全表）。

### 3.5 旧表没被动过

重跑 1.4 的基线 SQL：`rows_total` 不变；`last_row_update` 不变（若有人在网格里手工改了旧表，这一项会变——那是人改的，不是开关改的；D9a 决定是否收掉一线在旧表上的写权）。**不要删除旧表**：界面删除对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（`packages/core-backend/src/multitable/sheet-delete-guard.ts:50`、`:131`），也不要用 SQL 删；旧机 10-14 也建议不删（客户包安装行、审计引用都指向它，关开关后它是唯一的回退目标）。

### 3.6 出错时（照码判断，不要在现场改代码或改库）

| 现象 | 含义 | 处理 |
|---|---|---|
| 404 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND` / 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE` / 422 `STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_ID_INVALID` | 清单写错，**表和登记行已建好**，没有授权 | 改清单（§0 硬约束）→ §2.4 重启 → 对同一项目号再 POST 一次建表路由（200 重放补授权） |
| 403 `STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED` | 客户包管列写权，这次登录没有已验证的租户声明（1.6） | 什么都没建。换一个带租户声明的登录再做 |
| 422 `CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN` | 包目录里的列写权策略指名了不存在的角色（1.6） | 什么都没建。报 owner |
| 409 `STOCK_PREPARATION_PROJECT_TARGET_LIMIT` | 本租户已有 200 张（含已归档） | 不会在第一次出现；出现就停 |
| 403 `STOCK_PREP_APPLY_SANDBOX_ONLY` | 写入门没放行（1.1 沙箱两个键） | 只能预览；报 owner |
| 写入时 409 `TARGET_SHEET_FOREIGN_PROJECT` | 不应出现：新表里只有这个项目 | 停，报开发机 |
| 客户包装到一半宿主写失败 | 已建表但未登记（每个项目号至多一张，派生 id） | 重试同一个按钮，复用同一张表（`http-routes.cjs:9558-9566` 注释） |

## 4. 每日试拉（06:00，`metasheet-stock-prep-scheduled-dry-run`）

- **今天**（开关关）：试拉的目标是旧表；项目清单里是项目 B；守卫数出 354 行项目 A 的有效行 → 409 `TARGET_SHEET_FOREIGN_PROJECT`，每天 result=1。这是 ADR §0 的设计，不是故障（旧机诊断）。
- **开开关之前**，D12 = 是：把清单改成项目 A，试拉会过守卫，06:00 任务重新变成有意义的连通性与守卫验证。D12 = 否：保持 result=1，直到 owner 另定。
- **开开关之后**：每个还没建表的项目都被脚本当作「跳过」（`skipped_project_sheet_absent`），**不算失败、不改退出码**（`scripts/ops/stock-preparation-scheduled-pull.mjs:523-536`）。所以开后第一天起 result 会变成 0——**result=0 不再说明拉到了数据**，要看日志里每个项目的 `action`。脚本绝不建表。
- 某个项目建了表之后，它的试拉打到这张项目表上，表里只有它自己，守卫自然通过。D13 = 是时把清单改成已建表的项目。
- 定时任务的令牌必须是绑定租户的服务账号（`stock-preparation-scheduled-pull.mjs:32`）。项目表按租户登记，所以建表的拉取人员与这个服务账号必须在同一租户；第一次建表后的那次 06:00 试拉若仍是 `skipped_project_sheet_absent`，就是租户不一致，停下报开发机（本手册没有在演示机上核对过这一点）。

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
4. 回退之后**留下的东西**（什么都不删）：登记行、项目表及其数据、总览表、已授出的表级授权、审计行。G1 只增不删，所以有授权的人仍能在多维表网格里打开、编辑项目表；归档也不改授权。重新打开开关即恢复原样（ADR §8）。
5. 回退之后的行为：所有路由回到旧表；拉项目 A 以外的任何项目都会被一表一项目守卫 409（「关开关 = 停用拉取」）；每日试拉回到今天的结果；首页「打开备料多维表」按钮回来。
6. **不要**：删任何表（托管表本来也删不掉）、`DELETE` 登记表或授权行、跑迁移 087 / 088 的 `down()`、回退安装包。

## 6. 已知限制（开之前 owner 应知道）

- **S5b 锁行为**只在 D10 = 是时存在，四条见 D10。
- **权限变化最长 60 秒生效**（`rbac/service.ts:13`）：任命、开通准入、改角色之后等一分钟再让对方刷新页面；页面早已打开的会话要刷新才看到新按钮。
- **G1 只增不删、只有写一级**：从清单去掉角色不会收回已授的行；想让某张项目表对某个角色只读或收回，只能由管理员在「权限」里手工处理（ADR §11.7）。
- **表级写同时打开字段与视图管理**（ADR §11.7，D5）。
- **归档的表仍在多维表左侧列表里**，对有授权的人可见，网格照样可写（ADR §6 默认 (ii)）。
- **总览的数字不是实时的**：只在建表、拉取、确认、手动刷新等时刻重算，界面显示「截至 hh:mm」（ADR §5）。
- **旧表的人工列不带进新表**；自动化、提醒、自建视图按表配置，不会带过去（D8）。
- **R-35 记录的四条已知限制**（`decision-register.md:44`）：(a) 建表后的审计追加在事务之外，追加失败不重放；(b) 200 张上限在路由侧先计数后建表，建表与登记之间无锁（登记侧在事务内加租户锁复核）；(c) G1 的真库用例自行重建宿主事务；(d) 迁移 087 的约束只在假件和真库竞争用例上验证过。
- **建表路由里的授权等表行锁时没有超时上限**：只有成员页调用时才设 5 秒 `lock_timeout`（`stock-preparation-project-sheet-grants.ts:146-151`）；建表路由不设，由语句超时兜底。正常操作下不会撞上。

## 7. 代码与 ADR / 其它文档的出入（照实写，供 owner 与 Codex 评审）

1. **读路由遇到未登记项目**：ADR §3 的表写「读路由走该路由原有的『找不到』分支」；代码对读也回 409 `STOCK_PREPARATION_PROJECT_ABSENT`（`stock-preparation-project-targets.cjs:187-229` 注释写明这是有意偏离，R-35 第 (3) 条已记）。看板把它渲染成「表还没建好」。
2. **G1 审计记什么**：ADR §2 写 `project_target_grant`「记角色 id 和表 id」；代码只记表 id（`subjectId`）和三个计数，不记角色 id（`http-routes.cjs:9605-9615`）。
3. **G1 清单同时决定总览的读权限**：ADR §2 / §11.5 只说给项目表授写；代码还用同一份清单给项目总览表授 `spreadsheet:read`（`plugin-scope.ts:757-812`，`http-routes.cjs:4544-4560`）。
4. **「成员与权限」页另有开关**：ADR §11.6 只写门是 WORKBENCH_ADMIN，§8 第 6 步只写本开关和清单；代码里这一页要另一个默认关的开关 `STOCK_PREP_MEMBERS_PAGE_ENABLED`，且打开它须 owner 接受 S5b 锁行为（`global-history-flag-manifest.mjs:793-800`）。打开 G1 开关**不会**出现这一页。
5. **项目总览不是工作台页签**：是首页「每个项目一张备料表」那一块里的三个按钮（`StockPreparationOperatorHome.vue:82-130`）。
6. **flag manifest 的说明过时**：`global-history-flag-manifest.mjs:681` 写开关关时「the three project-sheet routes」回 404；现在是 9 条（`http-routes.cjs:217-257`，S1 / S4 五条加 S3 四条）。同一条写「read PER REQUEST (no restart)」：对进程环境成立，但演示机靠 `app.env` 进环境，改了必须按 §2.4 重启。
7. **附录 A.5**（`adr-stock-prep-project-sheets-20261008-addendum-a-d.md:60-65`）原三条——升级前先建「备料拉取人员」角色、「不要用迁移写角色」、「一线角色不用改」——都已不成立，同节 2026-10-10 订正（`:66`）已写明；读附录时以订正为准。
8. **旧机诊断里「删表路由对托管表无守卫」**与当前代码不符：`sheet-delete-guard.ts:50`、`:131` 对插件托管表回 409 `SHEET_PLUGIN_MANAGED`（ADR §0 第 3 条同此）。演示机上的 R66 是否包含这道守卫没有在演示机上核对；无论如何本手册不删任何表。
