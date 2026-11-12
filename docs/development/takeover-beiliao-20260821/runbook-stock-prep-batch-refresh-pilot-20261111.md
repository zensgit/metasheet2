# 运行手册：备料分批刷新第 6 步——装机顺序、恢复、普查、修复窗口与回退（G10 手册，S6-8）

> **用途。** 这是分批刷新第一期上客户机的现场手册（plan §7 的 G10）：先装 main 基线包，再逐表准备，最后开启第一个试点；中间任何时候都可能要做恢复，或者要回退。设计见 `design-stock-prep-batch-refresh-step6-20261027.md`（**开头的 2026-11-09 改正节优先于正文**），决策见登记册 **R-91**（第 6 步）、**R-65**（批次标识）、R-54 / R-55（试点启用）、R-56 / R-57 / R-61 / R-63 / R-77（对所有项目生效的默认值）。
>
> **基线。** 下文所有 `path:line` 都在 `origin/main` **d47eab0ea**（#6870 合入）上亲读核过；lib 路径相对于 `plugins/plugin-integration-core/lib/`，迁移相对于 `packages/core-backend/migrations/`。已合入 main：S6-0 #6600、R-91 与设计 #6834、启用前修补批 #6836、S6-1 #6835（迁移 106）、S6-2 #6837（恢复，就绪 v4）、S6-3 #6840（恢复卡片）、S6-5 #6842（普查路由、残留确认，迁移 107，就绪 v5）、S6-9a #6844（G9 验收工具）、S6-6 #6843（修复工具，迁移 108）、#6870（就绪 v6：租户声明开关是启用试点的前提）。**还没合入**：S6-9（翻转 `CONTINUATION_SUPPORT_VERSION`）。依赖它的地方标了 **【待定 S6-9】**；它合入后要回到本手册改写，改之前不按这些段落执行。**2026-11-11 补充（owner 裁定，R-91 ㉘–㉜）：** §0 的闸门表、§1.6、§3 第 4–7 步与 §8 按裁定改写。**2026-11-12 补充（S6-8b）：** #6843 与 #6870 合入后，全手册的 `path:line` 重核到 d47eab0ea；§1 的迁移清单加上 108；§6 按合入的修复工具定稿；#6843 与 #6844 的待定标记已清掉。**2026-11-12 补充（S6-5b）：** 就绪升到 **v7**，新检查 `no_open_sheet_repair_run`：这张表有未结束的修复运行就启用不了（原来只靠 §3 第 5 步人工核）；普查遇到缺关键列的表答 `field_missing`，不再答 `complete`（R-91 ㉕ 的残留关掉）。§0、§1.1、§3 第 4–5 步、§5.2、§6.5 与 §8 的示例按此改写；这些段落里标了 **（S6-5b）** 的 `path:line` 按 S6-5b 的提交核过，其余仍按 d47eab0ea。
>
> **owner 闸门。** 本手册里每一次装包、改 `app.env`、逐表写入（批次标识装机、残留确认、修复、启用）、读客户数据（普查）、回退，都是 owner 动作，按 §0 的表逐项先批后做。没有批复的步骤一律不做。
>
> **values-free。** 本手册不含主机、地址、口令、令牌、账号名、真实项目号或图号。项目号写 `<项目号>`，后端地址写 `<后端地址>`，令牌文件写 `<令牌文件>`，表写 `<项目表 sheetId>`，工单写 `<工单号>`。替换后的值只记在私有记录里（§8）。

## 0. 一页看懂

| 顺序 | 动作 | 谁批 | 写不写生产 |
|---|---|---|---|
| 0 | 定下切包用的冻结提交（打标签），并决定**第一个 main 包带不带 S6-9**（见 §7.4：带了以后，回退底线就从「代码保证」降为「操作保证」） | owner（gate 4，G-B8）。**已裁（2026-11-11，R-91 ㉙ ㉚；2026-11-12 由 ㉝ 修订）：试点随基于 main 的客户包发布，分两步：先出 R 线维护版 R84（不带试点、没有迁移、没有新开关），再出第一个 main 包，即试点包，它带 S6-9。** 切包提交本身仍未定 | 否 |
| 1 | Q-B：同意在 102 / 103 / 104 的私有列里存业务值，并定保留期（102 头注释 `102_create_integration_stock_prep_continuation.sql:41-43`：**部署 102 之前**要批） | owner。**已裁（2026-11-11，R-91 ㉛）：批准，只存在客户自己的库里，随记录保留（按设计行从不删除）** | 否 |
| 2 | 接受对所有项目生效的行为变化（§2） | owner（G-B9） | 否 |
| 3 | 装机窗口：装 main 包（迁移随包一起跑）、核授权、换定时拉取脚本（§1） | owner（gate 4） | 是（迁移，只加表 / 加列） |
| 3a | **打开租户声明开关** `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`（§1.6）。这是**启用试点的前提**：开关关着时，就绪检查 `tenant_claim_required` 不通过，任何项目都启用不了试点（R-91 ㉘，方案 A）。打开之前先确认定时拉取用的令牌绑定了租户（按 §1.6 第 1 步记「是 / 否」和计数） | owner（装机时另批，不随第 3 步的批复） | 是（改 `app.env`、重启） |
| 4 | 逐表：批次标识装机（另一本手册）→ 普查（§5）→ 需要时客户回答 Q1 / Q3 → 残留确认或修复窗口 → 看就绪 → 启用（§3） | 装机 O-BI-1；普查 O6-3；残留确认 O6-5；修复 O6-6；启用 G-C12 | 装机、确认、修复、启用都写 |
| 5 | 恢复：哪天一次写入没正常结束，拉取人员在「拉取待确认」页核对并结束（§4）；证明不了时平台管理员按手册结束 | 拉取人员不用另批；按手册结束要工单（O6-7 定谁能做，**未裁**） | 是（插件库） |
| 6 | 回退：先跑停止条件（§7），全为 0 才回退 | owner | 是 |

**翻转 `CONTINUATION_SUPPORT_VERSION`（S6-9）不等「BOM 快照批次与差异」页（S6-4）。** owner 2026-11-10 把该页延到试点之后（O6-2，登记 R-91 ㉔）。翻转之前，任何项目都启用不了试点：就绪清单最后一项 `continuation_support_version` 要求 1，而 `stock-preparation-continuation-support.cjs:21` 仍是 0（`stock-preparation-pilot-readiness.cjs:136`、`:462-465`，S6-5b）。

**租户声明开关也是启用的前提（就绪 v6，R-91 ㉘）。** 开关关着时，`requireTableActionAccess` 的旧分支允许无租户的平台管理员指名一个租户、在它的表上试算并应用（`http-routes.cjs:1552-1578`）；开关打开后 `assertVerifiedTenantClaim`（`:1780`，读取器 `stockPreparationTenantClaimRequired`，`:1876-1878`）拒绝这种调用。所以就绪清单在 `continuation_support_version` 之前多了一项 `tenant_claim_required`，只在这个读取器答「真」时通过（`stock-preparation-pilot-readiness.cjs:431-434`；路由把读取结果交给它，`http-routes.cjs:5533`）。旧分支本身和非试点项目不变。

**这张表不能有未结束的修复运行（就绪 v7，S6-5b）。** 就绪清单在 `continuation_support_version` 之前又多了一项 `no_open_sheet_repair_run`：修复台账自己的读取（`stock-preparation-sheet-repair-store.cjs:270-280`，按表读、不分项目，读不出就抛错）答「这张表没有 `running` 的运行」才通过；台账没接线、108 没跑、读取出错，一律不通过（`stock-preparation-pilot-readiness.cjs:298-303`、`:459-461`；路由把台账交给它，`http-routes.cjs:5545`；S6-5b）。它不看修复开关：开关打开时留下的运行，关掉开关以后照样挡住启用。启用 POST 拿到表租约之后还会再读一次（`http-routes.cjs:12897-12913`，S6-5b），挡住就绪读过之后、租约之前才停下的运行。为什么要挡：项目一旦受治理，retire / restore 都拒，续关又只认全部写完的运行，留着的运行可能再也关不掉（§6.5）。

**仍由 owner 另裁、本手册不替 owner 选的事：** 第 0 步的切包提交（S6-9 随包已裁，R-91 ㉚）；第 3a 步在客户机上打开开关的时间；O6-7（现场谁可以按手册结束，默认 `stock-prep:admin`）；试点项目（不是第 10 项那个项目，不是双份表，在上限以内，第 1 批已拉、下一批还没拉）；指定 1–2 名拉取人员（G-A2）；现场事实（`specField`、客户包声明、第 ④ 步开关）。

## 1. 装机顺序（main 基线包，装在 R83 或 R84 上）

试点包可能装在 R83 上，也可能装在 R84 上（R-91 ㉝：R84 先出，是 R 线维护版）。R84 是 `onprem-r83` 加几处修复，没有迁移，也没有新开关：在 R84 的切包分支（0d9e0a526）上核过，它和 `onprem-r83` 之间两个迁移目录都没有改动。所以本节写「R83」的地方，现场装的是 R84 时照样成立，把 R83 读成 R84 即可：§1.1 的迁移清单不变；§1.2 用现场已装那个包的 `migrate.js --list`；§1.5 照样要换脚本（见那里）。

### 1.1 这个包比 R83 多跑哪些迁移

在 `onprem-r83` 与 main（d47eab0ea）之间比对迁移文件名（`packages/core-backend/migrations/` 与 `packages/core-backend/src/db/migrations/`）：R83 有、main 没有的名字是 **0 个**；main 多出 **18** 个：

迁移名 = 文件名去掉扩展名（SQL：`packages/core-backend/src/db/migration-provider.ts:243`；其余：`:169`）。

- 备料 SQL 迁移 8 个：`100_create_integration_stock_prep_project_write_lock`（表写锁）、`101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable`（试点列与审计词表）、`102_create_integration_stock_prep_continuation`（沿用关系）、`103_create_integration_stock_prep_refresh_state`（刷新状态、待定、执行台账）、`104_create_integration_stock_prep_change_plan`（变更计划）、`106_extend_integration_stock_prep_refresh_execution_for_recovery`（执行 intent 日志与关闭形态）、`107_create_integration_stock_prep_component_ruling`（部件裁定 / 残留确认）、`108_create_integration_stock_prep_sheet_repair`（修复台账与一次性占用，S6-6 #6843）。`105` 两边逐字节相同，R83 已经跑过。
- 平台 Kysely 迁移 10 个：`zzzz20261022150000_add_meta_sheets_grid_export_closure`、`zzzz20261031120000_add_users_recycle_bin`、`zzzz20261101090000_create_directory_handovers`、`zzzz20261102150000_dingtalk_login_repairs`、`zzzz20261103120000_outbound_intent_attempt_lease_target_key`、`zzzz20261104150000_create_task_source_links`、`zzzz20261106120000_create_security_action_challenges`、`zzzz20261106130000_create_directory_integration_capabilities`、`zzzz20261107010000_deprovision_effect_provider`、`zzzz20261111093417_create_user_notification_endpoints_preferences`（#6857，2026-11-11 合入；切包提交更新时按实际再算一次）。

**全部随包一起跑，不能只装构建不跑迁移。** 106 头注释（`106_extend_integration_stock_prep_refresh_execution_for_recovery.sql:40-44`）：缺 106 时，**每个项目**的每次拉取和每次正式导出都答 503 `STOCK_PREP_REFRESH_STORE_FAILED`；104 同样（`104_create_integration_stock_prep_change_plan.sql:38-40`）。107 缺失时就绪清单的残留检查对每个项目都不通过（`107_create_integration_stock_prep_component_ruling.sql:37-39`）。108 缺失时，修复路由在开关打开后答 503、什么都不写（`108_create_integration_stock_prep_sheet_repair.sql:67-70`）；**而且**从 S6-5b 起，就绪 v7 的 `no_open_sheet_repair_run` 读不出修复台账，对每个项目都不通过，和 107 一样（S6-5b；108 头注释只写了修复路由，本 PR 没有改迁移文件）。所以这次升级**绝不用 `-RunMigrations 0`**（升级脚本默认 `'1'`，`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1:269`；为 `0` 时跳过迁移，`:2864-2878`）。

### 1.2 只读预检（窗口之前，结果只记计数）

**(1) 迁移清单。** 新包还没装，不在现场跑它的 `migrate.js`。窗口之前分两步核：

- 用**已安装的 R83** 的 `migrate.js`，带与升级脚本相同的环境（先导入 `docker/app.env`）：

  ```powershell
  node packages\core-backend\dist\src\db\migrate.js --list
  ```

  `--list` 只读（`packages/core-backend/src/db/migrate.ts:129`）。通过：Pending 为 0、Applied 等于 R83 自带的迁移数——说明现场库只跑过 R83 自带的迁移；R83 的名字全部在 main 里（§1.1），新包的迁移器不会报「missing」。
- 再用只读 SQL 核 §1.1 的 18 个名字**一个都还没跑**（Kysely 的默认记录表 `kysely_migration`，同 `r61-release-checklist-draft-20260928.md` 的做法）。名字已逐条填好，照抄即可；不要留占位符——留着占位符跑，它只答占位符那几行、不报错，是假通过。开发机预演跑过 17 个名字的版本（升级前全 `f`，升级后全 `t`）；加上 108 的这一版是本手册所写，未在库上执行过：

  ```sql
  BEGIN READ ONLY;
  SELECT n AS migration, EXISTS (SELECT 1 FROM kysely_migration k WHERE k.name = n) AS applied
    FROM unnest(ARRAY[
      '100_create_integration_stock_prep_project_write_lock',
      '101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable',
      '102_create_integration_stock_prep_continuation',
      '103_create_integration_stock_prep_refresh_state',
      '104_create_integration_stock_prep_change_plan',
      '106_extend_integration_stock_prep_refresh_execution_for_recovery',
      '107_create_integration_stock_prep_component_ruling',
      '108_create_integration_stock_prep_sheet_repair',
      'zzzz20261022150000_add_meta_sheets_grid_export_closure',
      'zzzz20261031120000_add_users_recycle_bin',
      'zzzz20261101090000_create_directory_handovers',
      'zzzz20261102150000_dingtalk_login_repairs',
      'zzzz20261103120000_outbound_intent_attempt_lease_target_key',
      'zzzz20261104150000_create_task_source_links',
      'zzzz20261106120000_create_security_action_challenges',
      'zzzz20261106130000_create_directory_integration_capabilities',
      'zzzz20261107010000_deprovision_effect_provider',
      'zzzz20261111093417_create_user_notification_endpoints_preferences'
    ]) AS n ORDER BY n;
  ROLLBACK;
  ```

通过：恰好 18 行，每行 `applied = f`。不通过：行数不是 18，有 `t`，或 R83 的 `--list` 不是 Pending 0——停下，回帖只列不匹配的名字，不要重跑、不要手工补迁移。

**(2) 备料计数（`psql -f`，只读角色，只记数字）**（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）。

```sql
SET default_transaction_read_only = on;
-- (b) 未归档的项目表登记行
SELECT count(*) AS registry_active FROM integration_stock_prep_project_target WHERE status = 'active';
-- (d) 部署 env 绑定的那张表是否被登记成某个项目的表（TD-27，R-56 ①）：期望 0
SELECT count(*) AS env_sheet_registered FROM integration_stock_prep_project_target WHERE sheet_id = '<环境目标表 sheetId>';
-- R-57 ①：装后再批准就会被拒、要重新计划的大 BOM 展开（#6559 的查数）
SELECT count(*) AS large_expansions_without_verdict FROM plugin_kv
 WHERE plugin = 'plugin-integration-core' AND key LIKE 'stock-preparation:large-bom:background:%'
   AND value ? 'planArtifact' AND NOT (value ? 'governanceVerdict');
-- R83 上还没结束的大 BOM 应用作业：装后一律续不上，要重新展开（§2 第 2 条）
SELECT count(*) AS open_large_apply_jobs FROM plugin_kv
 WHERE plugin = 'plugin-integration-core' AND key LIKE 'stock-preparation:large-bom:apply:%'
   AND value->>'status' NOT IN ('succeeded', 'partial', 'cancelled', 'expired');
```

`<环境目标表 sheetId>` 是部署配置 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`（或等价的 `INTEGRATION_CORE_TABLE_ACTIONS_JSON`，`packages/core-backend/src/plugin-runtime-config.ts:2-3`）里 `plm.stock-preparation.pull-bom.v1` 那条动作的 `target.sheetId`（必填，`stock-preparation-table-actions.cjs:257`）。从现场的 `app.env` 里读出来，只填进私有的 SQL 拷贝，不外贴。不要按 `object_id` 到 `plugin_multitable_object_registry` 里去找：那张表只在 `(project_id, object_id)` 上唯一（`packages/core-backend/src/db/migrations/zzzz20260408123000_create_plugin_multitable_object_registry.ts:30-31`），同一个 objectId 可能对应好几张表。

(c)（带试点标记的登记行）与 (e)（第 4 步各表的行数）装机前查不了：101 / 102 / 103 还没跑，列和表都不存在。它们放在 §1.4 装后核对里，期望都是 0。

**(3) 非备料基线（为 §7.3 留底）。** `app.env` 里 `AUTOMATION_CLASSB_OUTBOUND_ENABLED` 是不是开着（只记「是 / 否」）。代码只认进程环境里精确的 `true`（`packages/core-backend/src/multitable/automation-outbound-intent.ts:118-119`）；`app.env` 里那一行带引号或空格时，加载之后是不是 `true` 要看加载方式。所以这里放宽匹配（允许空格和引号，不分大小写），**计数不为 0 就记「是」**，宁可多记：

```powershell
@(Select-String -LiteralPath '<安装根目录>\docker\app.env' -Pattern '^\s*AUTOMATION_CLASSB_OUTBOUND_ENABLED\s*=\s*["'']?\s*true').Count
```

**(4) 停下来的条件**（任一成立就不开窗口）：(1) 不通过；(d) 不为 0（先由 owner 定怎么处理那张 env 表）；Q-B 或 G-B9 没批；切包提交没定。

### 1.3 维护窗口内

1. 停定时拉取任务，通知拉取人员窗口内不要拉。
2. 按交付说明 §2.1 的就地升级路径装包，`-RunMigrations 1`。升级脚本 `scripts/ops/multitable-onprem-package-upgrade-inplace.ps1` **不在包里**（打包清单 `REQUIRED_PATHS` 没有它，`scripts/ops/multitable-onprem-package-build.sh:47`；交付说明 §1 的交付物表）：从切包的**同一个提交**单独拷到现场，调用时**显式**传 `-RootDir <安装根目录>`——它的默认值是脚本所在目录往上两级（`multitable-onprem-package-upgrade-inplace.ps1:229`），不是安装根目录。
3. 升级脚本跑完、后端起来后做 §1.4。不通过就按 §7 回退，不要在现场改库或改代码。

### 1.4 装后核对

**(1) 迁移。** 再跑一次 `--list`，Pending 为 0。逐个确认 8 个备料迁移（100–104、106、107、108）：`node packages\core-backend\dist\src\db\migrate.js --confirm <名字>`，退出码 0 = 已执行、1 = 待执行、2 = 不认识（`migrate.ts:130`）。

**(2) 授权。** 插件的数据库助手建在宿主给的 `context.api.database` 之上（`db.cjs:194-200`），用的就是后端自己的数据库连接，所以用 `app.env` 里 `DATABASE_URL` 的那个角色连上去查（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）。迁移头注释写明要求的：105 四张表 SELECT / INSERT / UPDATE（`105_create_integration_stock_prep_pull_batch.sql:67`）；106 的 intent 表 SELECT / INSERT，执行台账与变更计划 SELECT / INSERT / UPDATE（`106_…:46-47`）；107 的裁定表 SELECT / INSERT / UPDATE（`107_…:41`）；108 的修复运行表 SELECT / INSERT / UPDATE，修复占用表 SELECT / INSERT（`108_…:72-73`）。100–104 的头注释没写授权，这里一并查三种权限。**只查不授**；有一格是 `f` 就停下报开发机。

```sql
SET default_transaction_read_only = on;
SELECT t AS table_name,
       has_table_privilege(current_user, t, 'SELECT') AS s,
       has_table_privilege(current_user, t, 'INSERT') AS i,
       has_table_privilege(current_user, t, 'UPDATE') AS u
  FROM unnest(ARRAY[
    'integration_stock_prep_project_write_lock',
    'integration_stock_prep_continuation',
    'integration_stock_prep_continuation_member',
    'integration_stock_prep_refresh_state',
    'integration_stock_prep_refresh_hold',
    'integration_stock_prep_refresh_execution',
    'integration_stock_prep_refresh_execution_intent',
    'integration_stock_prep_change_plan',
    'integration_stock_prep_reviewed_cell',
    'integration_stock_prep_pull_batch_settings',
    'integration_stock_prep_pull_batch_sheet',
    'integration_stock_prep_pull_batch',
    'integration_stock_prep_pull_batch_execution',
    'integration_stock_prep_component_ruling',
    'integration_stock_prep_sheet_repair_run',
    'integration_stock_prep_sheet_repair_claim'
  ]) AS t ORDER BY t;
```

intent 表和修复占用表（`integration_stock_prep_sheet_repair_claim`）只要求 `s`、`i` 为真，其余各表三列都要为真。

**(3) 装后计数**（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）（期望全是 0；不为 0 说明有人在装机前已经开过试点，停下）：

```sql
SET default_transaction_read_only = on;
SELECT count(*) AS pilot_marked FROM integration_stock_prep_project_target WHERE pilot_enabled_at IS NOT NULL;
SELECT (SELECT count(*) FROM integration_stock_prep_continuation)      AS continuation,
       (SELECT count(*) FROM integration_stock_prep_continuation_member) AS continuation_member,
       (SELECT count(*) FROM integration_stock_prep_refresh_state)      AS refresh_state,
       (SELECT count(*) FROM integration_stock_prep_refresh_hold)       AS refresh_hold,
       (SELECT count(*) FROM integration_stock_prep_refresh_execution)  AS refresh_execution,
       (SELECT count(*) FROM integration_stock_prep_change_plan)        AS change_plan,
       (SELECT count(*) FROM integration_stock_prep_component_ruling)   AS component_ruling;
```

写锁表（100）不在此列：**每个项目**的写入都会在它上面记一行，第一次拉取之后就不是 0，这是正常的。

### 1.5 换定时拉取脚本（窗口内，恢复定时任务之前）

R83 的包**不带** `scripts/ops/stock-preparation-scheduled-pull.mjs`：`onprem-r83` 的打包脚本 `multitable-onprem-package-build.sh` 里没有这个文件名。现场定时任务跑的是包外的一份拷贝（下面的 `<试拉脚本路径>`）。按 `onprem-r83` 的源码，这个脚本不认识 `suspended`、`review_pending`、`recovery_pending`（`git show onprem-r83:scripts/ops/stock-preparation-scheduled-pull.mjs` 里这三个词的计数为 0）。R84 是**第一个**带这个脚本的 R 线包（#6831 移植进 R 线），但它带的那份同样不认识这三个状态（R84 切包分支 0d9e0a526 上同一文件里三个词的计数也都是 0），所以装在 R83 或 R84 上，这一步都要做。main 包里带着新版（`scripts/ops/multitable-onprem-package-build.sh:117`）：受治理项目整次挂起记 `skipped_suspended`（`scripts/ops/stock-preparation-scheduled-pull.mjs:642-643`），变更待复核记 `skipped_review_pending`（`:658-659`），二者都不改退出码；上次写入未完成记 `error` / `STOCK_PREP_REFRESH_RECOVERY_PENDING`、`failed: true`（`:651-652`），**这是失败**，要有人去恢复（§4）。脚本只用 Node 内置模块（`:120`），环境变量和参数没变，原样替换任务执行的那份拷贝即可：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '<安装根目录>\scripts\ops\stock-preparation-scheduled-pull.mjs'
Copy-Item -LiteralPath '<试拉脚本路径>' -Destination ('<试拉脚本路径>' + '.pre-main-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath '<安装根目录>\scripts\ops\stock-preparation-scheduled-pull.mjs' -Destination '<试拉脚本路径>' -Force
Get-FileHash -Algorithm SHA256 -LiteralPath '<试拉脚本路径>'
@(Select-String -LiteralPath '<试拉脚本路径>' -SimpleMatch -Pattern 'skipped_review_pending').Count
```

两次 SHA-256 必须相同，计数应 ≥ 1。然后恢复定时任务，手动触发一次：还没有试点时，每个项目的结果应与升级前相同。

### 1.6 打开租户声明开关（启用试点的前提；装机时 owner 另批，R-91 ㉘）

开关打开后，令牌里没有租户声明的请求一律 403 `OPERATOR_SCOPE_TENANT_REQUIRED`（`http-routes.cjs:1780-1792`），而且覆盖整个集成插件，不只备料（交付说明 `customer-delivery-guide-20260904.md` §5-5）。**如果定时拉取用的令牌没有租户声明，开关一开它就停。** 所以顺序是：

1. **确认定时拉取的令牌绑定了租户（只记「是 / 否」和计数，不记令牌、账号、租户、路径）。** 决定「是」的是 (a) 和 (b) 两条，(c) 是第二道核对；三条都满足才记「是」：
   - **(a) 真正启动 node 的那一行没有 `--allow-tenantless`（只数次数，应为 0）。** 定时任务的「操作」指向的是 `.cmd` 包装脚本（交付说明 §3.2），参数写在包装脚本里，**不在任务自己的命令行上**——只看任务的命令行会漏掉它。所以先看任务的「操作」指向哪个文件，一路跟到运行 `node … stock-preparation-scheduled-pull.mjs` 的那一行（包装脚本再调别的脚本，就接着跟），任务自己的参数和那一行都要数：

     ```powershell
     @((Get-ScheduledTask -TaskName '<定时任务名>').Actions | Where-Object { ('' + $_.Execute + ' ' + $_.Arguments).Contains('--allow-tenantless') }).Count
     @(Select-String -LiteralPath '<包装脚本路径>' -SimpleMatch -Pattern '--allow-tenantless').Count
     ```

     两个计数都应为 0。命令报错（找不到任务或文件）时不要记 0，先改对任务名或路径再数。没有这个参数时，脚本每次运行都先解开令牌、只看有没有非空的 `tenantId` 声明，没有就拒绝运行、退出码 1、**标准输出一行都不写**（`scripts/ops/stock-preparation-scheduled-pull.mjs:43-48`、`:187`、`:787-797`）。
   - **(b) 手动触发的这一次确实跑到了项目（结果行至少 1 行）。** §1.5 换上新版脚本后，用 `Start-ScheduledTask` 手动触发一次（跑的就是任务本身那条链）。只看**这一次新增**的输出：触发前先记下日志的行数，或让包装脚本这一次写到一个新文件。标准输出里每个项目写一行含 `"projectNo"` 的结果（`:811`、`:821-838`），这一次新增的行里这样的行至少 1 行。被拒的那次运行没有任何结果行，所以它不可能在这一条上读成「是」；日志里昨天留下的结果行不算。
   - **(c) 同一次运行里两句提示都是 0（第二道核对）。** 这两句只写到**标准错误**，标准输出里永远是 0：`MS_TOKEN does not carry a tenantId claim`（拒绝运行，`:791`）和 `MS_TOKEN does not declare a tenantId claim`（带着 `--allow-tenantless` 放行时的警告，`:800`；真正让无租户令牌跑起来的就是这条路，它打的是这句，不是前一句）。所以先确认 node 那一行把标准错误也接进了日志（例如 `2>&1` 或 `2>` 到文件）；**没有接标准错误时，这两个 0 什么也证明不了，(c) 不算满足，记「否」**：先让 node 那一行把标准错误也接进日志（例如在行末加 `2>&1`），再从 (a) 查起。接了的话，两句都数，都应为 0。

   只看这些计数，不看退出码：退出码还会因别的原因不为 0（例如某个项目在等恢复，§1.5）。任一条不满足：先按交付说明 §5-5 第 2 步用 `--tenant-id` 重新换发令牌（`scripts/ops/attendance-window-runner-mint-token.mjs`），把 `--allow-tenantless` 从启动行删掉，换好再从 (a) 查起。**不要**为了让脚本跑通而加 `--allow-tenantless`。
2. 按交付说明 §5-5 的前置顺序做完其余几步（`user_orgs` 每个账号恰好一条活跃行、全员重新登录）。
3. 在 `app.env` 里加一行 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`，重启后端；按 §5-5 第 4 步核两条（进程环境里能看到这一行；一个没有租户声明的旧令牌被拒 403 `OPERATOR_SCOPE_TENANT_REQUIRED`）。
4. 再手动触发一次定时拉取：每个项目的结果应与打开前相同。

**停止条件：只要有任何一个试点已启用，就不得删掉这一行。** 就绪检查只管「启用」这一下：启用之后，运行时没有任何检查因此拒绝，试点也不会因此被撤销（只有就绪的 GET 会重新列出 `tenant_claim_required`，§3 第 7 步；试点标记只能由 §3 的手册语句清掉）。删掉这一行，这张试点表上旧分支的路径就重新打开。交付说明 §5-5 的「回滚 = 删掉这一行」**只在没有试点启用时**适用；有试点时要回滚，先由 owner 裁定，按 §3「退出试点」处理每个试点之后才删。

## 2. 对所有项目生效的行为变化（不只试点项目）

这些是 T 层默认值，装了 main 包就对客户机上**每一个**备料项目生效，owner 在 G-B9 一次接受：

1. **表登记给别人就拒（R-56 ①，TD-27）。** 解析出的目标表已登记给同租户另一个项目，答 409 `STOCK_PREP_REFRESH_TARGET_RETARGETED`；登记给另一个租户，答 409 `STOCK_PREP_REFRESH_TENANT_MISMATCH`（`stock-preparation-refresh-governance.cjs:47-55`、`:240`）。项目表开关打开时，除了登记竞态，这碰不到；§1.2 (d) 为 0 时，开关关着也碰不到。
2. **大 BOM 要重新计划、旧作业要重新展开（R-57 ①）。** 批准一个大 BOM 计划，要求计划路由记下的治理裁决；没有就 409 `LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED`（`stock-preparation-large-bom-jobs.cjs:793-800`）——装机前计划好的展开都要重新计划才能批准（§1.2 的 `large_expansions_without_verdict`）。另外，R83 上批准、还没跑完的应用作业没有写锁绑定，main 上续跑每一块都被拒 `job_unbound`；办法是**新开一次展开**（展开 → 计划 → 批准 → 跑完），已落的行按幂等键重新规划为更新或跳过，不会重复新增（`:1554-1563`）。拉取人员会看到这一步，先告诉他们。
3. **步骤 4 的表读不出时，通用写入一起停（R-61 ①）。** 流水线多维表写入、C6 写入、ERP 回写在写任何表之前都先探测这张表是否受治理；探测读不出就 503 `STOCK_PREP_REFRESH_STORE_FAILED`，与备料无关的流水线也停（`stock-preparation-governed-sheet-probe.cjs:27-30`）。所以迁移一定要随包跑（§1.1）。
4. **带版本号写入（R-63 ①，按代码写的样子）。** 小车道的更新 / 停用带上锁内重算读到的记录版本，不论项目是否受治理。版本冲突时**只重读一次**：只是有人改了人工列（插件不写的列），就用新版本**再发一次**，照常写完；插件写的列变了、行被替换 / 不见 / 重复、或第二次还冲突，**整次停下**，409 `STOCK_PREP_CHANGE_PLAN_STALE`，带已写的部分计数，之后的行一行都不写（`stock-preparation-apply-writer.cjs:700-709`）。大车道分块与「新增撞上已有行」两处仍是旧的宿主调用（`:695-698`）。
5. **定时拉取多两种「跳过」（R-62 ②、R-77）**，见 §1.5。它们只出现在受治理项目上；试点开启之前不会出现。
6. **正式导出遇到写入占用就拒（#6566）。** 每个项目的正式导出先读一次表写锁：有租约，不论是活的还是中断后留下的，都 409 `STOCK_PREP_EXPORT_BLOCKED`、原因 `lease_in_flight`（`stock-preparation-export-gate.cjs:198`；未受治理项目只受这一条和前后两次锁读的约束，文件字节与审计不变，`:38-41`）。中断留下的占用，要等一次拉取人员档的试算、一次应用接管或一次观察把它清掉。
7. **交接链最后一跳要拿写锁（#6836 (d)，R-91 ㉑）。** 每一个交接终点一跳（未受治理项目也算）都要求写锁接线并读一次锁代次：未接线 501，读取失败拒绝；受治理项目因刷新状态被拒（`STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE`，409 / 503）时，写一行无值审计（门在 `http-routes.cjs:5315-5347`，拒绝时写审计行在 `:14743-14767`）。只有现场配了交接链才会碰到。
8. **写锁的时长。** 租约 120 秒（`stock-preparation-project-write-lock.cjs:132`），心跳 30 秒（`:133`），接管宽限再 120 秒（`:134`）；到期加宽限之前都算「活的」（`:486-493`）。所以一个挂死的写入方最多挡住这张表约 **4 分钟**，之后才能被接管。
9. **项目目录多三个计数（#6836 (c)，R-91 ㉑）。** 开关打开时，目录的登记行带上 `openRefreshHoldCount` / `pendingReviewCount` / `refreshBlocked`；每次回答多几次有界读取，只对受治理的行逐个咨询，治理没接线时这几个键不出现。
10. **平台侧（非备料）的新触发器。** `zzzz20261101090000` 在审批卡片投递表上加了插入触发器：某个集成处于已应用 / 已定稿的通讯录交接时，向它投递新卡片被拒（SQLSTATE 55000，`packages/core-backend/src/db/migrations/zzzz20261101090000_create_directory_handovers.ts:37-47`）；`zzzz20261102150000` 在钉钉登录身份和通讯录关联上加了触发器，存在已应用的登录修复时，改动被钉住的身份被拒（55000，`…/zzzz20261102150000_dingtalk_login_repairs.ts:36-47`、`:74-83`）。交接或修复出现之前它们什么都不拒，但会多拿行锁。回退到 R83 后这些触发器**仍然生效**（§7.3）。

## 3. 逐表准备与开启试点的顺序

一张试点表，严格按这个顺序走；每一步的批复不同，不能合并：

1. **批次标识装机先做（O-BI-1，每张表一份；开关 O-BI-7 另批）。** 按 `runbook-stock-prep-pull-batch-install-window-20261108.md` 做。做完后这张表在台账里是 `born_empty` 或 `backfilled`（`105_…:114-115`）。就绪清单里 `pull_batch_enabled` 要求开关打开，`pull_batch_history_resolved` 要求历史已解析（`stock-preparation-pilot-readiness.cjs:63-70`），所以没有装机就开不了试点。
2. **普查（O6-3，读客户数据）**，见 §5。看这张表有没有双份（D1：`twoCopyComponents`）或第 10 项那种残留（D2：`inactiveRootRemnantComponents`）。
3. **只有普查不干净时：**
   - 问客户（经 owner 转达；开发机从不直接联系客户）：Q1「这个部件现在还单独下单吗」，Q3「现在大家填的是哪一份」。
   - D2 残留：**只有在 owner 转达了客户对 Q1 的回答（不再单独下单）之后**，才记残留确认（O6-5，§5.3）。
   - D1 双份：走修复窗口（O6-6，§6）。retire 之后这个部件变成 D2 残留，还要按上一条在客户回答 Q1 之后记确认。
4. **看就绪。** `GET /api/integration/stock-preparation/projects/<项目号>/target/pilot`，`stock-prep:admin`（`http-routes.cjs:257`、`:12278-12279`）。回答是 `{ version, ready, checks: [{ id, ok }], failing: [id] }`（`stock-preparation-pilot-readiness.cjs:13`、`:491-497`），外加 `may.enable`。现在 `readiness.version` 是 **7**（`:135`，S6-5b），共 **29** 项（`:161-191`，S6-5b）：版本 3 加了批次标识六项，版本 4 加了 `change_plan_store_readable`、`execution_recovery_ready`，版本 5 加了 `no_unacknowledged_inactive_root_remnant`，版本 6 加了 `tenant_claim_required`（R-91 ㉘：租户声明开关打开才通过，§1.6），版本 7 加了 `no_open_sheet_repair_run`（这张表有未结束的修复运行就不通过，§0、§6.5），最后一项永远是 `continuation_support_version`。**在 S6-9 之前，`failing` 里至少有 `continuation_support_version`。** 只有它一项不通过，说明这张表已经准备好，等翻转。`failing` 里有 `tenant_claim_required`：开关没开（或没有生效），先做 §1.6，别的项不用查。`failing` 里有 `no_open_sheet_repair_run`：先按 §6.2 第 5 条查这张表的运行，按 §6.5 把它关掉；查出来是 0 而它仍不通过，是台账读不出（108、授权，§1.4），不是「没有运行」。switch-on 手册附录 B.1 写的「版本 2、18 项」已过时，按本节读。
5. **启用 【待定 S6-9】。** 翻转合入、新包装上之后，按 `runbook-stock-prep-project-sheets-switch-on-20261014.md` 附录 B.2（旧大作业处置）、B.3（启用与「答 500 ⇒ 再 POST」）做。B.2 / B.3 描述的路由与请求体（`{"confirmProjectNo": "<项目号>"}`，`stock-prep:admin`，`http-routes.cjs:258`、`:12793-12795`）在 d47eab0ea 上成立。启用前还要：租户声明开关已打开（§1.6，就绪里 `tenant_claim_required` 为真）、**这张表没有未结束的修复运行**（§6.5；从 S6-5b 起由就绪 v7 的 `no_open_sheet_repair_run` 强制，启用 POST 在租约内再读一次，§0；启用前仍按 §6.2 第 5 条查一遍，结果记进私有记录）、拉取人员已指定、R-91 的否决窗口已过（Q-B 已于 2026-11-11 批准，R-91 ㉛）。启用仍是逐表、owner 批准的一步（R-91 ㉚）。
6. **试点开启后的两条限制，要告诉拉取人员。** 试点项目每条大车道路由都答 409 `STOCK_PREP_PILOT_LARGE_LANE_REFUSED`；小车道试算撞到上限时答 `STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED`，**不会**转去大车道（`stock-preparation-pilot-gate.cjs:6-11`、`:33-34`）。所以超上限的项目不能做试点。试点表的通用网格导出被宿主关闭（附录 B.3）。
7. **试点启用之后，租户声明开关不得删（§1.6 的停止条件）。** 启用之后只有就绪的 GET（第 4 步那条路由）会重新评估就绪（`http-routes.cjs:12305-12318`；启用 POST 在 `:12816` 评估、在 `:12823` 按结果拒绝，启用之后不再走这一步），运行时没有任何检查因此拒绝：开关被删后，它的回答里 `pilot.enabled` 仍为 `true`，`readiness.failing` 里重新出现 `tenant_claim_required`。项目备料页在试点启用后**不再显示**不通过的检查项（`apps/web/src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue:2341`），所以要看就直接读这条 GET 的回答，或核 `app.env` 那一行还在。

**退出试点：** 没有路由。101 头注释给了 owner 批准的一条手册数据库语句（一次清三列，`101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable.sql:24-29`）：

```sql
UPDATE integration_stock_prep_project_target
   SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL
 WHERE tenant_id = $1 AND project_no = $2;
```

它只清大车道拒绝和就绪状态；网格导出仍关着（重开是另一次 owner 批准的手册操作），已经写下的沿用关系、待定、执行**照样保护**这个项目（`:30-34`）。清了标记也不能回退到 R83（§7.4）。

## 4. 恢复（「拉取待确认」页的恢复卡片）

**什么时候出现。** 一次受治理的写入没有正常结束（进程没了、中途停止、写了一部分），项目就是「失败待恢复」：之后每次拉取都不写，正式导出暂停，定时拉取记 `STOCK_PREP_REFRESH_RECOVERY_PENDING`（§1.5）。恢复卡片只在页面的刷新状态是失败待恢复时才出现（`apps/web/src/components/integration/stockPreparation/StockPreparationRefreshRecoveryCard.vue:7-8`）。

**拉取人员怎么做（`stock-prep:pull`）。** 三条路由（`http-routes.cjs:382-389`）：执行列表 `GET …/projects/<项目号>/refresh/executions`；核对 / 结束 `POST …/refresh/executions/<执行 id>/recover`，请求体只能是 `{ confirmProjectNo, mode, verifyDigest?, pageCursor? }`（`:3163`；另外允许 `tenantId`，不要带，§5.1），`mode` 是 `verify` 或 `close`（`stock-preparation-execution-recovery.cjs:58`）。在卡片上：

1. 输入项目号，点「核对上次写入」（`StockPreparationRefreshRecoveryCard.vue:92`）。系统按表格现在的内容核对上次写进去了哪些行，**不写任何东西**。没能证明写入的行分页列出，每页最多 200 行（`stock-preparation-execution-recovery.cjs:57`）。
2. 核对能证明时，点「结束这次执行」（`:99`）。结束要回显上一次核对的摘要（`stock-preparation-execution-recovery.cjs:379`），在锁里重新判定每一项准入事实。
3. 结束之后**重新试算**，以新的试算为准（`apps/web/src/services/integration/stockPreparation/plainLanguage.ts` `STOCK_PREP_REFRESH_RECOVERED_NEXT`）。

**被拒时。** `STOCK_PREP_REFRESH_RECOVERY_STALE`、`STOCK_PREP_PULL_STATE_MOVED`、`STOCK_PREP_PROJECT_WRITE_LEASE_LOST`：什么都没改，重新核对。`STOCK_PREP_REFRESH_RECOVERY_BUSY`：别的操作占着一行，稍后再点。`STOCK_PREP_PROJECT_WRITE_LOCKED`：一次拉取或另一次核对正在写，稍后再点。`STOCK_PREP_REFRESH_EXECUTION_NOT_FOUND` / `…_NOT_UNFINISHED`：重新读取（`stock-preparation-continuation-store.cjs:241`、`:261-266`）。`STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE`：表格证明不了写进了哪些行（重复行、行不见了、行被替换、内容对不上等，`stock-preparation-execution-recovery.cjs:62`），**拉取人员不能结束**，交平台管理员。

**平台管理员按手册结束（结果未知；`stock-prep:admin`）。** 只在 UNPROVABLE、或核对一直做不下去时用。路由 `POST …/refresh/executions/<执行 id>/close-unverified`（`http-routes.cjs:389`、`:15173-15187`）。卡片上的「按手册结束（结果未知）」区块只对管理员显示：

1. 先开一张工单，工单号只能用字母、数字和 `. _ : -`，最多 64 个字符（`stock-preparation-execution-recovery.cjs:63`）。工单里写清为什么核对证明不了；**不写业务值**。
2. 输入项目号，点「检查表格」（`mode: inspect`）。
3. 填工单号，勾选「我知道这次结束不核对结果，结果记为「未知」」，点「按手册结束（结果未知）」（`mode: close`，回显检查摘要，`acknowledge: { resultUnknown: true }`，`:386-399`）。
4. 后果：结果记为「未知」，不算核对通过；变更计划要改的每一行都转为待复核，下次试算会重新挂起需要确认的行（`plainLanguage.ts` `STOCK_PREP_RECOVERY_UNVERIFIED_WARNING`）。之后照常重新试算。
5. 谁能在现场做这一步是 O6-7，owner **未裁**；裁定之前只由 owner 点名的管理员做，每次都有工单。

**卡片说「没有找到未完成的执行」时（'none' 状态）。** 页面仍显示「上次写入未完成」，但执行记录里没有未完成的执行：这是一次中断的写入还占着表的写入（结束已提交但释放失败，或崩溃的拉取没留下执行行）。卡片的原话（`plainLanguage.ts` `STOCK_PREP_RECOVERY_CARD_NONE`）：

> 先点上面的「重新读取」。如果本项目仍显示「上次写入未完成」,可能是一次中断的写入还占着这张表的写入:请到项目备料页重新试算一次,而且要是一次能应用的试算(结果可以应用,没有被挂起或拒绝)——这样的试算会清掉中断留下的占用;还是这样,请联系平台管理员。

列表还有下一页时，先点「更多执行记录」：未完成的执行可能在后面一页。

**恢复与批次标识装机。** 装机不读刷新治理，所以表正在装机（installing）时也可以核对 / 结束（改正节 B-9）；关闭不动批次台账的表行。开关关着时，卡片和报告里没有任何批次行（缺席，不是空）。

## 5. 普查与残留确认（`stock-prep:admin`，项目表开关打开时）

### 5.1 两种普查

四条路由都只认 `stock-prep:admin`，项目表开关关着时零 IO 答 404，租户取自令牌（`http-routes.cjs:304-324`）。令牌必须绑定本租户；不要在请求里另带别的租户 id（不一致就 403 `OPERATOR_SCOPE_TENANT_MISMATCH`，`stock-preparation-operator-scope.cjs:463-467`）。

- **全租户：** `GET /api/integration/stock-preparation/project-targets/census?limit=10&cursor=<上一页最后序号>`（`limit` 最多 10，`stock-preparation-remnant-acknowledgement.cjs:52-53`；下一页用回答里的 `nextCursor`）。每行有 `ordinal`、`objectId`（**私有**）、`registryStatus`、`governed`（`pilot` / `protected` / `none` / `unreadable`），以及 `status`。
- **一个项目：** `GET /api/integration/stock-preparation/projects/<项目号>/target/census`。多给出这个项目的 D2 部件，每个带**私有**句柄 `componentHandle` 和它当前有效的确认；还有 `acknowledgementsNotCurrentlyRemnant`（`stock-preparation-remnant-acknowledgement.cjs:258-293`）。

```powershell
$token = (Get-Content -Raw -LiteralPath '<令牌文件>').Trim()
$h = @{ authorization = "Bearer $token" }
Invoke-RestMethod -Method Get -Uri '<后端地址>/api/integration/stock-preparation/project-targets/census?limit=10' -Headers $h |
  ConvertTo-Json -Depth 8 > census-page1-private.json
Remove-Variable token
```

每次读都写一行无值审计 `project_board_read` / `sheet_census_read`（`stock-preparation-remnant-acknowledgement.cjs:40-50`）。

计数键（`stock-preparation-sheet-census.cjs:70-81`）：`rowCount`、`activeRowCount`、`twoCopyComponents`（D1）、`inactiveRootRemnantComponents`（D2）、`duplicateKeyGroups`、`keylessRowsWithoutCreator`、`keylessRowsWithCreator`、`nonBooleanActiveCells`、`inactiveRowsWithHumanCells`、`nestedCopiesWithHumanCells`。另有 `acknowledgedComponents`、`rulingComponents`、`unacknowledgedRemnantComponents`。

客户机还在 R83、没有这些路由时，用只读 psql 包 `scripts/ops/stock-prep-sheet-census-20261027/`（S6-0），做法见包内 `README.md`；它只覆盖模板人工列，客户包 `ext_` 人工列要等 main 包上的路由。

### 5.2 怎么读

- **`status: incomplete` 不是 0。** 这一行没有任何计数，原因是封闭词之一：`target_unresolved`、`sheet_mismatch`、`tenant_wall`、`rows_unreadable`、`rows_too_large`、`pack_unreadable`、`field_missing`（`stock-preparation-remnant-acknowledgement.cjs:66-75`，S6-5b）。把它当「没查到」，查明原因后重跑，不能当干净。一个项目的普查读不出客户包列时答 503 `STOCK_PREP_SHEET_CENSUS_PACK_UNREADABLE`（`:58`）。
- **缺关键列（S6-5b，关掉 R-91 ㉕ 的残留）。** 普查要读的五个关键列是 `projectNo`、`idempotencyKey`、`componentSourceId`、`parentSourceId`、`active`（`stock-preparation-sheet-census.cjs:74`，和 R 线包 `01-sheet-census.sql` 的 `required` 列表一致，插件测试钉住两边相等）。路由在租户墙之后、读行之前，用宿主**从数据库**查列是否存在（`http-routes.cjs:5586-5601`，S6-5b）：缺了任何一列，全租户那一行答 `incomplete` / `field_missing`、没有计数（`:5669-5677`）；单项目答 409 `STOCK_PREP_SHEET_CENSUS_FIELD_MISSING`（`details.missing` 是缺了几列，不写列名），不记审计行（`:12466-12477`）。宿主答不出（不是数据库的回答，或读取出错）时不算「缺」也不算「在」：全租户那一行答 `rows_unreadable`，单项目答 503 `STOCK_PREP_SHEET_CENSUS_FIELDS_UNREADABLE`。所以现在**一行 `complete` 本身就可信**，不用再去对 `target_fields_present`。缺列的表按 owner 批准的手册步骤补回列之后再普查；补列不是本手册的步骤。
- 确认数读成 `null`（`rulingsReadable: false`）：裁定表读不出，先查 107 与授权（§1.4）。

### 5.3 残留确认（只在客户回答 Q1 之后）

只有 owner 转达了客户对 Q1 的回答（这个部件已不再单独下单，H0），才记确认（O6-5）。路由 `POST /api/integration/stock-preparation/projects/<项目号>/target/remnant-acknowledgements`，请求体固定（`http-routes.cjs:313-317`、`:3169`）：

```json
{ "confirmProjectNo": "<项目号>", "componentHandle": "<一个项目普查里列出的句柄>", "basis": "head_not_ordered", "runbookRef": "<工单号>", "acknowledge": { "customerAnswered": true } }
```

服务端在一次新的读取上重新证明这个句柄**现在**是 D2 残留，不是就 409 `STOCK_PREP_REMNANT_NOT_PRESENT`、什么都不写（`stock-preparation-remnant-acknowledgement.cjs:207-212`）；是就在一个事务里写确认行（迁移 107）和审计 `exception_resolve` / `remnant_acknowledged`。确认**不是**计划的输入：确认错了也是安全一侧——第一次受治理计算若仍读到这个部件的订单头，项目会挂起 `dropped_order_head_unresolved`，直到有裁定或退出试点（设计 §6.3）。

### 5.4 撤销

`POST …/remnant-acknowledgements/<确认 id>/revoke`，请求体 `{ "confirmProjectNo": "<项目号>", "runbookRef": "<工单号>" }`（`http-routes.cjs:318-319`、`:3170`）。撤销自带工单号。**下面三种情况都要撤销：**

1. 一个项目普查的 `acknowledgementsNotCurrentlyRemnant` 里列出的每一条（部件已经不是残留：修过了，或旧根行又被拉活）。
2. **一条确认会比它当初对应的形状活得久**：旧根行被拉活、之后又被停用，重新形成的残留仍被**原来那条**确认豁免，没有新的客户回答。所以只要这个部件的形状变过（出现在第 1 种列表里过），就撤销，需要时按新的 Q1 回答重新确认。
3. 每次修复窗口做完 retire 或 restore 之后，重跑这个项目的普查：retire 把 D1 部件变成停用根残留（D2），restore 把它变回 D1。按第 1 条撤销已经对不上的确认；retire 之后的 D2 要在客户回答 Q1 之后按 §5.3 记确认，就绪才会通过（S9D-11 在真实库上走过 retire → 确认 → 一次干净的受治理拉取）。

撤销按写入查找项目表，归档项目上的确认要先恢复项目才能撤销（409 `STOCK_PREPARATION_PROJECT_ARCHIVED`，`stock-preparation-project-targets.cjs:233`）。

## 6. 双份表修复窗口（O6-6，gate ②，逐表 owner 批准）

修复工具 S6-6（#6843，迁移 108）已合入 main。它把双份表（D1）里旧的根子树停用（retire），也能按那次运行的备份恢复（restore）。它只写四个机器格：有效（`active`，写成布尔值）和三个 RUN 标记（运行 id、决定、冲突摘要）；人工列和批次两列从不写（`stock-preparation-sheet-repair.cjs:4-12`、`:47-49`）。每一次真实运行都是 owner 动作：开关打开、一个预览摘要一份批复、这个项目的拉取暂停（`108_create_integration_stock_prep_sheet_repair.sql:8-10`）。

### 6.1 路由与开关

- 三条路由都只认 `stock-prep:admin`（`http-routes.cjs:325-343`、`:12735-12768`）：
  - `POST …/projects/<项目号>/target/sheet-repair`：预览、执行和续关。请求体是封闭的 `{ mode, recipe, confirmProjectNo, componentHandle?, runId?, planDigest?, approvalRef? }`，多一个键就 400（`stock-preparation-sheet-repair.cjs:99`、`:398`）。`mode` 是 `preview` 或 `execute`。`recipe` 是 `retire_superseded_root_subtree`（停用旧根子树）、`restore_retired_rows`（按一次 retire 运行的备份恢复）或 `verify_and_close_run`（核对并关闭一次停住的运行），见 `:88-95`。
  - `GET …/target/sheet-repair/fills-report`：哪些旧行和副本行填了人工格、两边是否相同。只有句柄、布尔和计数，给客户回答 Q3 用。
  - `GET …/target/sheet-repair/runs`：这张表最近 50 次运行（更多时回答带 `truncated: true`），无值，不含备份（`stock-preparation-sheet-repair-store.cjs:75`、`:287-292`）。restore 和续关要用的运行 id 从这里取。
- 开关 `MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED` 只认精确的 `true`：不去空格，也不认大写（`stock-preparation-sheet-repair.cjs:83-85`）。它或项目表开关不是 `true` 时，三条路由（预览、补填报告、运行列表都算）一律 404、零 IO（`http-routes.cjs:6854-6859`）。所以给客户准备 Q3 的补填报告，也要先开开关。
- **开关按部署生效。** 开着时，这个部署上**每一个**项目的表都能被修复。窗口开始时在 `app.env` 里加这一行、重启；窗口结束时删掉、重启。
- 开关开着而 108 没跑：修复路由答 503 `STOCK_PREP_SHEET_REPAIR_STORE_FAILED`，什么都不写（`108_…:67-70`）。
- `approvalRef` 只记录、不核验：服务端不查它是不是 owner 真批过。批复原文和编号的对照只进私有记录（§8）。

### 6.2 开窗之前（每张表、每个窗口）

1. **owner 批这张表的窗口（O6-6）。** 修复备份会把每个计划行的三个标记格按读到的原样存进 108 的运行表（只限插件自己写入方的那几种形式；没有任何路由回答它，R-91 ㉞ (d)）。这算不算 Q-B 的范围，随第一张表的修复批复一起交 owner 裁定（R-91 ㊱）。
2. **暂停这个项目的拉取**（定时任务 + 通知拉取人员），从 retire 一直停到 restore 或裁定完成（设计 O6-6）。同时数一下这张表上的自动化规则和 webhook，窗口内暂停。工具看不到定时任务：表写租约挡得住同时进行的拉取、恢复和装机，但按 #6843 的说明，大 BOM 分块没有版本栅栏，已批准的大作业只靠暂停挡住。暂停期间如果定时拉取还碰到修复占着这张表，它记的是**失败**：`error` / `STOCK_PREP_PROJECT_WRITE_LOCKED`、`failed: true`；只有批次标识装机占着表时才记跳过（`scripts/ops/stock-preparation-scheduled-pull.mjs:596-615`）。这是有意的：说明暂停没做到，要有人去看。owner 2026-11-12 撤回了把它改成「held」的切片（R-91 ㊲）。
3. **修复窗口与批次标识装机窗口从不交错**（改正节 B-10）。注意：设计 B-10 说「装机在租约内的摘要核对随后会拒绝」，这只在装机的 dry_run 与第一次装机之间成立；对已在装机中的表**不成立**——`continue` / `resume_aborted` 直接用持久化的计划（`stock-preparation-pull-batch-install.cjs:624-629`、`:647-648`），只比对请求摘要和这份计划的摘要（`:788-792`），从不重算。S6-6 复核第 1 轮的探针显示：在规则 `predecessor_suffix` 下，同一部件的副本会落成不同的「首次批次」，而且标签永不改写；规则 `material` 下标签不受影响（本手册只读了代码路径，没有复跑探针）。
4. **先查这张表的批次台账行。** 工具自己也会拒：每次预览和执行都读这一行，不管批次开关开没开（`http-routes.cjs:6977` 读，`stock-preparation-sheet-repair.cjs:332` 判定）；`installing`，或 `pending` 而还留着计划或设置锁，答 409 `STOCK_PREP_SHEET_REPAIR_INSTALL_IN_PROGRESS`；台账没接线或读不出答 503。窗口之前仍要先跑这条只读查询，好提前知道要不要先做装机。它读的是客户库，按 §0 第 4 行的批复做（语句本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）：

   ```sql
   SET default_transaction_read_only = on;
   SELECT history_status, (history_plan IS NOT NULL) AS plan_kept
     FROM integration_stock_prep_pull_batch_sheet
    WHERE sheet_id = '<项目表 sheetId>' AND project_no = '<项目号>';
   ```

   - `history_status = 'installing'`：停。先把装机做完（或按装机手册 §6 中止），再开修复窗口。
   - `history_status = 'pending'` 且 `plan_kept = t`：停。这是一次中止后留着计划的首装，再跑可能按旧计划续上（`stock-preparation-pull-batch-install.cjs:627-629`）。先把装机做完。
   - `history_status = 'pending'` 且 `plan_kept = f`：这张表还没装机。按 §3 先做批次标识装机，再开修复窗口。（和上一条不同：没有留着的计划，下一次装机按首装重新出计划（`stock-preparation-pull-batch-install.cjs:624-629`）。）
   - `born_empty` / `backfilled`，或者没有行（这张表从没开始装机）：可以开。§3 的顺序是先装机，所以正常应是前者。
5. **这张表上没有未结束的修复运行。** 查运行列表，或者用只读语句（本手册所写，未在库上执行过）：

   ```sql
   SET default_transaction_read_only = on;
   SELECT count(*) AS open_repair_runs FROM integration_stock_prep_sheet_repair_run
    WHERE sheet_id = '<项目表 sheetId>' AND status = 'running';
   ```

   不为 0：先按 §6.5 把它关掉，再开始新的修复。每次预览的回答里也有 `openRun`。

### 6.3 一次运行：预览 → owner 批复 → 执行

1. **预览**（只读，不拿租约，不写表；记一行无值审计）：`{ "mode": "preview", "recipe": "retire_superseded_root_subtree", "confirmProjectNo": "<项目号>", "componentHandle": "<一个项目普查里列出的句柄>" }`。不带 `componentHandle` 时答这张表上双份部件的列表（最多 200 个，`stock-preparation-sheet-repair.cjs:177`、`:764-765`）。一个部件的回答有 `eligible`、`refusals`、`counts`、`planDigest`、`sequence`、`openRun`（`:1136-1155`）。
2. **两个计数必须为 0。** `counts.notMachineShaped`（有标记格不是插件自己写入方的形式）和 `counts.copyRowsNotBooleanActive`（留下的嵌套副本里，有效不是布尔 `true`；字符串 `'true'` 和数字 `1` 也算）。不为 0 时执行会答 409 `STOCK_PREP_SHEET_REPAIR_NOT_APPLICABLE`，带着 `row_not_machine_shaped` 或 `copy_row_active_not_boolean`。工具里没有覆盖办法（R-91 ㉟），停下报 owner。
3. **owner 对这个 `planDigest` 批复**，批复编号就是 `approvalRef`。一个摘要一份批复，只能用一次：数据库里有一次性占用，同一个摘要再执行答 409 `STOCK_PREP_SHEET_REPAIR_ALREADY_CONSUMED`（`108_…:23-28`）。
4. **执行**：`{ "mode": "execute", "recipe": "retire_superseded_root_subtree", "confirmProjectNo": "<项目号>", "componentHandle": "<句柄>", "planDigest": "<预览摘要>", "approvalRef": "<批复编号>" }`。服务端拿 `sheet_repair` 写租约，在租约内重算预览；摘要不同就 409 `STOCK_PREP_SHEET_REPAIR_PLAN_CHANGED`，什么都不开始。摘要相同才占用批复、先存备份、再逐行写：最深的行先写，根最后（`stock-preparation-sheet-repair.cjs:31-52`）。
5. **批复一次只批一个。** 每开始一次运行（包括一行都没写的），运行序号就前进，这个项目表上其他所有还没执行的预览摘要随之作废（R-91 ㉞ (e)；`108_…:29-30`）。所以不要一次预览几个部件再一起批：做完一个，再预览下一个，再批。
6. **被拒时。**
   - `STOCK_PREP_SHEET_REPAIR_INSTALL_IN_PROGRESS`：先把批次标识装机做完（§6.2 第 4 条）。
   - `STOCK_PREP_SHEET_REPAIR_NOT_APPLICABLE`：看 `reasons`（封闭词，`stock-preparation-sheet-repair.cjs:101-127`）。条件不成立，什么都没写；需要时重新预览。
   - `STOCK_PREP_SHEET_REPAIR_PLAN_CHANGED`：表上有行变了。重新预览，新摘要要新批复。
   - `STOCK_PREP_SHEET_REPAIR_ALREADY_CONSUMED`：这份批复已经用过。重新预览、重新批。
   - `STOCK_PREP_SHEET_REPAIR_STOPPED`：有一行没能按计划写（行变了、被锁、不见了，或宿主拒绝），运行就此停下，从不盲目重试；回答里有 `written` 和 `partial`。重新预览，剩下的要新摘要、新批复。
   - `STOCK_PREP_PROJECT_WRITE_LOCKED`：别的写入方占着表。拉取应该已经暂停，先查清是谁。
   - `STOCK_PREP_SHEET_REPAIR_RUN_OPEN`：同一个租约里还有一次没结束的运行，这是缺陷，报开发机。

### 6.4 恢复（restore）

- `{ "mode": "preview", "recipe": "restore_retired_rows", "confirmProjectNo": "<项目号>", "runId": "<retire 运行的 id>" }`，运行 id 从运行列表取。restore 是另一份配方：有自己的预览、自己的摘要、自己的批复和一次性占用，然后照 §6.3 第 3–4 步执行。
- 它按**现在**的表来计划：备份里的一行，只有仍是 `active === false`、仍带着**那次** retire 运行的标记，才按它**当前**的版本写回；已经重新启用、标记被改过或不见了的行分原因计数，不写（`stock-preparation-sheet-repair.cjs:10-12`）。一次 retire 加上它的 restore，表上存的每一行逐字节回到原样，版本号多 2。
- 一行都没写过的 retire 运行没有东西可恢复（`nothing_to_restore`）；restore 运行本身不能再被恢复（`run_not_retire`）。

### 6.5 停在 `running` 的运行

一次运行从开始到它自己的收尾都是 `running`。收尾没跑成（租约被接管，或收尾事务失败），它就一直停在 `running`：预览关不掉它，也没有时钟会关掉它。每张表最多一次未结束的运行（`108_…:22`）。按情况选一条路（`108_…:80-98`）：

1. **计划的行全写完了**：用续关 `verify_and_close_run`。
   - 预览 `{ "mode": "preview", "recipe": "verify_and_close_run", "confirmProjectNo": "<项目号>", "runId": "<运行 id>" }`，回答 `{ eligible, refusals, counts, governed, planDigest }`。owner 批**这个**摘要；执行时回显摘要，带它自己的 `approvalRef`。
   - 执行在表租约内、先断言持有者，按运行自己的备份核对每个计划行；**不写任何表行**，把运行记为 `completed` 并记下 `close_approval_ref`，然后推进代次（`stock-preparation-sheet-repair.cjs:13-17`、`:1288-1330`）。
   - 被拒：`rows_not_in_target_state`（带 `notWritten` / `moved` / `missing` 计数，运行仍然开着）、`run_not_open`、`run_not_found`、`backup_unreadable`；`STOCK_PREP_SHEET_REPAIR_PLAN_CHANGED`；`STOCK_PREP_PROJECT_WRITE_LOCKED`。
2. **一行都没写**：照原配方再做一次——同一个部件的 retire，或同一个源 retire 运行的 restore——新的预览、新的摘要、新的批复。它开始时会把那次未结束的运行记为 `stopped / abandoned`。
3. **retire 写了一部分**：先重新预览这个部件的 retire。工具的 STOPPED 提示就是「重新预览，剩下的要新摘要、新批复」（`stock-preparation-sheet-repair.cjs:1500`）；预览 `eligible` 时，照 §6.3 批复、执行，它开始时把那次运行关成 `stopped / abandoned`。本手册没有在真实库上核过这种情况下预览一定 `eligible`。预览不 `eligible` 时，restore 这次运行（等于撤销），它开始时同样把未结束的运行关掉。别的做法先问 owner。

**先关掉，再开始别的修复。** 这张表上下一次执行开始时，会把任何未结束的运行（包括已经全部写完的）记为 `stopped / abandoned`（`stock-preparation-sheet-repair.cjs:45-46`）。全部写完的运行应该走第 1 条正常关闭。

**试点启用之前不得留着未结束的修复运行。** 项目一旦受治理，retire 和 restore 都拒（`project_governed`），只剩续关。续关也拒时——有计划行不在目标状态：没写、写了一部分，或之后被受治理的拉取改过——工具里没有办法关掉它，只能走 owner 批准的手册步骤（`108_…:94-98`）。从 S6-5b 起这一条由就绪 v7 的 `no_open_sheet_repair_run` 强制（§0）：有未结束的运行，启用答 409 `STOCK_PREP_PILOT_NOT_READY` 并列出这一项，什么都不做。它只管启用这一下，所以窗口的规矩不变：§3 第 5 步启用之前仍按 §6.2 第 5 条查一遍为 0；试点启用之后不开修复窗口（retire / restore 都拒 `project_governed`）。

### 6.6 执行或续关答 `generationBumped: false` 时

**这次执行或续关本身已经做完。** 回答是成功的（`status: completed`），运行台账里也记下了。`false` 只说明放开租约之后的**代次推进没落地**：推进是尽力而为，失败不会让这次操作失败（`stock-preparation-sheet-repair.cjs:1318-1330`、`:1511-1524`）。推进落不了地，按代码有两种情况：放开租约之后马上有别的写入方拿到了这张表（有活着的租约时推进一律拒绝，`stock-preparation-project-write-lock.cjs:693-694`），或者锁表一时读写失败。回答里不说是哪一种；只有后端日志里那一行警告带着码（`stock-preparation-sheet-repair.cjs:1326`、`:1520`）。

**STOPPED 也按这一节处理。** 一次执行在尝试过写入之后被拒——`STOCK_PREP_SHEET_REPAIR_STOPPED`，或收尾时的租约 / 栅栏拒绝——推进照样在放开租约之后尝试，但拒绝的回答里**没有** `generationBumped` 这个键（拒绝在返回之前抛出，`stock-preparation-sheet-repair.cjs:1466-1524`）。所以这时推进有没有落地是未知的：除第 1 条外（STOPPED 之后按 §6.3 重新预览是正常的），下面几步照做。

**后果（按代码）。** 写入之前的令牌检查只比对代次令牌（`stock-preparation-project-write-lock.cjs:386-408`，两条车道写入之前都调用）；拿租约、接管租约都不换代次令牌。所以代次没推进时，**修复之前出的试算令牌和大 BOM 批准，在这一道检查上仍然有效**，而修复本来要靠这次推进作废它们。它们之后会不会被别的检查拒掉，本手册没有从代码里核到，不要指望。

**接下来安全的做法：**

1. **不要重做。** 同一个摘要再执行答 409 `STOCK_PREP_SHEET_REPAIR_ALREADY_CONSUMED`，已经关掉的运行再续关答 `run_not_open`；也没有单独推进代次的路由。用运行列表核对：这次运行是 `completed`，续关的还带 `closeApprovalRef`。
2. **看日志里的码。** `STOCK_PREP_PROJECT_WRITE_LOCKED`：拉取暂停期间有别的写入方拿到了表，暂停没做到。先查清是谁（定时任务、拉取人员、自动化），停住它，再往下做。`STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED` 等别的码：锁表出了问题，报开发机。
3. **旧计划一律作废处理。** 修复之前出的试算不去应用；修复之前批准、还没跑完的大 BOM 作业不续跑，之后重新展开。
4. **恢复拉取时，第一步是拉取人员一次能应用的试算。** 能应用的试算会推进代次，作废这张表此前的所有计划（`http-routes.cjs:9105-9110`）；这就补上了没落地的那次推进。在它之前不应用任何东西。

### 6.7 做完之后

1. 重跑这个项目的普查（§5），按 §5.4 第 3 条处理确认。
2. 看就绪（§3 第 4 步）。
3. §6.2 第 5 条为 0（没有未结束的运行）。
4. 删掉修复开关的那一行、重启。窗口里如果有哪一次回答 `generationBumped: false`，或者有过 STOPPED 这类写过之后的拒绝（§6.6），恢复定时任务和自动化之前，先按 §6.6 第 4 条做一次能应用的试算。

## 7. 停止条件与回退

### 7.1 先分清「回退到哪个构建」

- **回退到 R83（现场实际的旧构建，R 线，还不认识第 4 步）。** 设计 §7.5：**只要库里有任何第 4 步的行，就禁止回 R 线构建**；102 头注释：不认识沿用关系的构建，下次刷新受治理项目时会新增一份副本、再把旧行停用（`102_…:31-36`）。试点开启之前，第 4 步的行只为受治理项目写（`stock-preparation-refresh-lanes.cjs:418`；受治理 = 试点或已有行，`stock-preparation-refresh-state.cjs:223`），而试点在 S6-9 之前开不了，所以这时各表都是 0，可以回退。
- **回退到更早的 main 包（以后有了第二个 main 包时）。** 用下面 7.2 的全部阻断查询，外加迁移 106 那一条。

### 7.2 备料停止条件（只读，全部为 0 才回退）

102、104、106、107、108 的语句照抄迁移头注释；103 的两条是按头注释的文字写成的（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）。

```sql
SET default_transaction_read_only = on;
-- 102：仍在认领的沿用关系（102_…:35）
SELECT count(*) FROM integration_stock_prep_continuation WHERE claim_active;
-- 103：打开的待定、未完成的执行（103_…:33-34 的文字，这里写成语句）
SELECT count(*) FROM integration_stock_prep_refresh_hold WHERE status = 'open';
SELECT count(*) FROM integration_stock_prep_refresh_execution WHERE status IN ('running', 'partial', 'failed', 'aborted');
-- 104：已确认 / 已写入待复核的变更计划（104_…:45）
SELECT count(*) FROM integration_stock_prep_change_plan WHERE status IN ('confirmed', 'written');
-- 106（U07）：最新结算主体没被 settled_execution_id 指名的受治理项目（106_…:55-60，原样照抄）
SELECT count(*) FROM integration_stock_prep_refresh_state s
 WHERE EXISTS (SELECT 1 FROM integration_stock_prep_refresh_execution e
                WHERE e.sheet_id = s.sheet_id AND e.project_no = s.project_no AND e.settlement_subject
                  AND e.status IN ('succeeded', 'verified_closed') AND e.id IS DISTINCT FROM s.settled_execution_id
                  AND e.started_at = (SELECT max(e2.started_at) FROM integration_stock_prep_refresh_execution e2
                                       WHERE e2.sheet_id = s.sheet_id AND e2.project_no = s.project_no AND e2.settlement_subject));
-- 107：有效的确认 / 裁定（107_…:45；只供参考，不阻断）
SELECT kind, count(*) FROM integration_stock_prep_component_ruling WHERE status = 'active' GROUP BY kind;
-- 108：未结束的修复运行（108_…:75-78，原样照抄）
SELECT count(*) FROM integration_stock_prep_sheet_repair_run WHERE status = 'running';
```

- 106 那条不为 0：对每个这样的项目做一次干净的试算并结算，再查（R-91 ⑳：只计 `verified_closed` 的旧写法会漏掉排在透明关闭之后的未结算 `succeeded` 主体）。
- 回退到 R83 时，再加一条：§1.4 (3) 那组里除 `component_ruling`（107，只供参考：R83 不读它，残留确认可以在启用之前就记下）以外的各表行数**全部为 0**，带试点标记的登记行为 0。
- 108 那条不为 0：按 §6.5 先把每一次未结束的修复运行关掉，再查。这一条对回退到任何更早的构建都适用（108 头注释：回退之前不得有未结束的运行）；已经停用的行留在表上，旧构建把它们当普通的停用行读。
- **【待定 S6-9】** G9 工具已随 #6844 合入（`scripts/ops/stock-prep-g9-frozen-candidate.mjs`，`--old-build-drill` 打印 U07 旧构建一半的做法）。U07 回退演练要在 S6-9 的冻结候选上做（旧构建 + `RunMigrations 0`，库里带着未完成执行、透明关闭、已确认计划等产物；「留着一次未结束的修复运行」那一项还挂在 G9 矩阵的待定项 `G9-S66-U07` 上）。演练没过之前，本节只是读代码得出的条件，不是演练过的。

### 7.3 非备料停止条件（读代码得出，没有实际执行过；下面的查询（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍））

1. **外发开关。** `AUTOMATION_CLASSB_OUTBOUND_ENABLED` 精确为 `true` 时（`packages/core-backend/src/multitable/automation-outbound-intent.ts:118-119`）不能回 R83：`zzzz20261103120000` 把唯一索引改成 4 列（`…/zzzz20261103120000_outbound_intent_attempt_lease_target_key.ts:55-58`），而 R83 的认领语句写的是 3 列 `ON CONFLICT`（`git show onprem-r83:packages/core-backend/src/multitable/automation-outbound-intent.ts` 第 103 行），每次外发认领都会失败。要求：开关不是 `true`（§1.2 (3) 的计数为 0）。
2. **通讯录交接。** 要求 0 行：`SELECT count(*) FROM directory_handovers WHERE state IN ('applied', 'finalized');`（状态词见 `…/zzzz20261101090000_create_directory_handovers.ts:9`）。不为 0 时，回 R83 后向相关集成投递审批卡片会被触发器拒（55000），而 R83 代码不处理这种拒绝。
3. **钉钉登录修复。** 要求 0 行：`SELECT count(*) FROM dingtalk_login_repairs WHERE state = 'applied';`（`…/zzzz20261102150000_dingtalk_login_repairs.ts:6`、`:25`）。不为 0 时，回 R83 后改动被钉住的身份或关联会被拒（55000）。
4. **数据源令牌要重填的清单。** main 把 `bearerToken` 列为加密字段（`packages/core-backend/src/data-adapters/DataSourceManager.ts:33`），R83 不列（同文件 R83 版第 31 行），回 R83 后这类令牌会以密文交给适配器。回退前数一下、把数据源 id 记进私有记录，回退后逐个重填：
   ```sql
   SELECT count(*) FROM data_sources WHERE deleted_at IS NULL AND config->'credentials'->>'bearerToken' LIKE 'enc:%';
   ```

另外两条只需知会：回收站里的账号在 R83 下显示成普通停用账号，管理员可能误启用（`SELECT count(*) FROM users WHERE deleted_at IS NOT NULL;`，`…/zzzz20261031120000_add_users_recycle_bin.ts:18`）；批次标识开关打开时，两个构建共用 105 的台账，跨构建的兼容**没有核过**——开关打开期间要回退，先在开发机演练。

### 7.4 怎么回退，什么时候不能再回退

- **做法：** 停定时拉取；用旧构建的包重装，**`-RunMigrations 0`**；不跑任何迁移的 `down()`。SQL 迁移只有 up（`102_…:30`）；旧构建在 102 / 103 已记录的库上**不能再跑 `db:migrate`**（迁移器会报「previously executed migration … is missing」，`102_…:37-39`）。表和行都留着。回退后把定时拉取脚本换回 `.pre-main-*` 那份。
- **不能再回退到 R83 的时刻：** 库里出现第一行第 4 步数据——也就是第一个试点开启并拉过一次之后。从此只能向前修复。清掉试点标记（§3）也不改变这一点：已写下的行仍在保护那个项目。
- **回退底线是不是「代码保证」，看包里带不带 S6-9。** 包里不带 S6-9：`CONTINUATION_SUPPORT_VERSION` 是 0，试点根本开不了，第 4 步各表必然为空，这是代码保证。包里带了 S6-9：只是操作保证——前提是没人点「开启试点」。所以第 0 步 owner 的裁定决定了 §7.1 第一条在多大程度上靠得住。
- **一张表装上批次两列之后**，回退的目标构建必须带批次标识（R83 带；更早的 R 线包不带，见装机手册 §8）。

## 8. 外贴与私有记录

**可以外贴**（#6079 / PR / issue）：

- 迁移清单的个数（Applied / Pending），`--confirm` 的退出码；
- §1.2、§1.4、§7.2、§7.3 各查询的**数字**；授权表的真假格（只有表名和真假）；
- 普查：按本帖**序号**列计数和 `status` / `reason` / `governed`；
- 就绪：`version`、`ready`、`failing` 里的检查 id；
- 恢复：执行状态、结果词（`landed` / `nothing_landed` / `mixed` / `unprovable`）、拒绝码与原因词、计数；
- 工单号（它本身就是无值的句柄）。

格式示例：

```
[S6-8] 2026-11-xx 装机窗口：Pending 18 → 0；--confirm 100/101/102/103/104/106/107/108 全为 0；授权 16 表全真；装后计数全 0
[S6-8] 普查 第 1 页：序号 1 complete D1=0 D2=0；序号 2 incomplete reason=pack_unreadable；序号 3 complete D1=0 D2=1 governed=none
[S6-8] 序号 3 就绪 v7：failing=[continuation_support_version]
[S6-8] 序号 4 就绪 v7：failing=[no_open_sheet_repair_run, continuation_support_version]；未结束修复运行 1（§6.2 第 5 条）
[S6-8] 普查 第 1 页：序号 5 incomplete reason=field_missing
[S6-8] 租户声明开关（§1.6）：定时拉取令牌绑定租户 = 是；(a) --allow-tenantless 计数 任务 0 / 包装脚本启动行 0；(b) 本次手动触发结果行 2；(c) 标准错误已接入，does not carry 0 / does not declare 0；开关已加、旧令牌 403
```

**只能进私有记录**：项目号、序号与项目 / objectId 的对照、`componentHandle`（它是业务值的摘要，可被反推）、执行 id、完整的普查 / 核对应答文件、待处理页里的部件编码和名称、主机、地址、令牌、数据源 id、批复原文里的任何业务值。

## 待定标记清单（合入后回到本手册改写）

| 标记 | 位置 | 合入后要做的 |
|---|---|---|
| 【待定 S6-9】 | §0 启用；§3 第 5 步；§7.2 U07 演练 | 翻转合入后，重核附录 B.2 / B.3 并写正向一腿的实际回答；用 G9 工具在冻结候选上跑 U07 演练，结果写进本手册 |
| owner 未裁 | §0（切包提交、第 3a 步打开开关的时间、O6-7、试点项目、拉取人员；S6-9 随包与 Q-B 已于 2026-11-11 裁定，R-91 ㉚ ㉛）；§6.2 第 1 条（修复备份算不算 Q-B，R-91 ㊱） | 裁定后记进登记册，再执行对应步骤 |
