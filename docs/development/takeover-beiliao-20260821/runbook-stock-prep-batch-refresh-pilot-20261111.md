# 运行手册：备料分批刷新第 6 步——装机顺序、恢复、普查、修复窗口与回退（G10 手册，S6-8）

> **用途。** 这是分批刷新第一期上客户机的现场手册（plan §7 的 G10）：先装 main 基线包，再逐表准备，最后开启第一个试点；中间任何时候都可能要做恢复，或者要回退。设计见 `design-stock-prep-batch-refresh-step6-20261027.md`（**开头的 2026-11-09 改正节优先于正文**），决策见登记册 **R-91**（第 6 步）、**R-65**（批次标识）、R-54 / R-55（试点启用）、R-56 / R-57 / R-61 / R-63 / R-77（对所有项目生效的默认值）。
>
> **基线。** 下文所有 `path:line` 都在 `origin/main` **0232a25f2**（#6842 合入）上亲读核过；发布前 main 前进到 48aaac6b4（#6857：多一个平台迁移，`migrate.ts` 只改了帮助文字；本手册引用的其他文件都没动），§1.1 的迁移清单按它重算，引用的 `migrate.ts:129-130` 未变；lib 路径相对于 `plugins/plugin-integration-core/lib/`，迁移相对于 `packages/core-backend/migrations/`。已合入 main：S6-0 #6600、R-91 与设计 #6834、启用前修补批 #6836、S6-1 #6835（迁移 106）、S6-2 #6837（恢复，就绪 v4）、S6-3 #6840（恢复卡片）、S6-5 #6842（普查路由、残留确认，迁移 107，就绪 v5）。**还没合入**：S6-6 #6843（修复工具，迁移 108，仍在修正轮，行为可能变）、S6-9a #6844（G9 验收工具）、S6-9（翻转 `CONTINUATION_SUPPORT_VERSION`）。依赖这三项的地方都标了 **【待定 #6843】**、**【待定 #6844】** 或 **【待定 S6-9】**；它们合入后要回到本手册改写，改之前不按这些段落执行。
>
> **owner 闸门。** 本手册里每一次装包、改 `app.env`、逐表写入（批次标识装机、残留确认、修复、启用）、读客户数据（普查）、回退，都是 owner 动作，按 §0 的表逐项先批后做。没有批复的步骤一律不做。
>
> **values-free。** 本手册不含主机、地址、口令、令牌、账号名、真实项目号或图号。项目号写 `<项目号>`，后端地址写 `<后端地址>`，令牌文件写 `<令牌文件>`，表写 `<项目表 sheetId>`，工单写 `<工单号>`。替换后的值只记在私有记录里（§8）。

## 0. 一页看懂

| 顺序 | 动作 | 谁批 | 写不写生产 |
|---|---|---|---|
| 0 | 定下切包用的冻结提交（打标签），并决定**第一个 main 包带不带 S6-9**（见 §7.4：带了以后，回退底线就从「代码保证」降为「操作保证」） | owner（gate 4，G-B8）。**未裁** | 否 |
| 1 | Q-B：同意在 102 / 103 / 104 的私有列里存业务值，并定保留期（102 头注释 `102_create_integration_stock_prep_continuation.sql:41-43`：**部署 102 之前**要批） | owner。**未裁** | 否 |
| 2 | 接受对所有项目生效的行为变化（§2） | owner（G-B9） | 否 |
| 3 | 装机窗口：装 main 包（迁移随包一起跑）、核授权、换定时拉取脚本（§1） | owner（gate 4） | 是（迁移，只加表 / 加列） |
| 4 | 逐表：批次标识装机（另一本手册）→ 普查（§5）→ 需要时客户回答 Q1 / Q3 → 残留确认或修复窗口 → 看就绪 → 启用（§3） | 装机 O-BI-1；普查 O6-3；残留确认 O6-5；修复 O6-6；启用 G-C12 | 装机、确认、修复、启用都写 |
| 5 | 恢复：哪天一次写入没正常结束，拉取人员在「拉取待确认」页核对并结束（§4）；证明不了时平台管理员按手册结束 | 拉取人员不用另批；按手册结束要工单（O6-7 定谁能做，**未裁**） | 是（插件库） |
| 6 | 回退：先跑停止条件（§7），全为 0 才回退 | owner | 是 |

**翻转 `CONTINUATION_SUPPORT_VERSION`（S6-9）不等「BOM 快照批次与差异」页（S6-4）。** owner 2026-11-10 把该页延到试点之后（O6-2，登记 R-91 ㉔）。翻转之前，任何项目都启用不了试点：就绪清单最后一项 `continuation_support_version` 要求 1，而 `stock-preparation-continuation-support.cjs:21` 仍是 0（`stock-preparation-pilot-readiness.cjs:114`、`:417-419`）。

**仍由 owner 另裁、本手册不替 owner 选的事：** 第 0 步的切包提交和 S6-9 随包与否；Q-B；O6-7（现场谁可以按手册结束，默认 `stock-prep:admin`）；试点项目（不是第 10 项那个项目，不是双份表，在上限以内，第 1 批已拉、下一批还没拉）；指定 1–2 名拉取人员（G-A2）；现场事实（`specField`、客户包声明、第 ④ 步开关）。

## 1. 装机顺序（main 基线包，客户机现跑 R83）

### 1.1 这个包比 R83 多跑哪些迁移

在 `onprem-r83` 与 main（48aaac6b4）之间比对迁移文件名（`packages/core-backend/migrations/` 与 `packages/core-backend/src/db/migrations/`）：R83 有、main 没有的名字是 **0 个**；main 多出 17 个：

迁移名 = 文件名去掉扩展名（SQL：`packages/core-backend/src/db/migration-provider.ts:243`；其余：`:169`）。

- 备料 SQL 迁移 7 个：`100_create_integration_stock_prep_project_write_lock`（表写锁）、`101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable`（试点列与审计词表）、`102_create_integration_stock_prep_continuation`（沿用关系）、`103_create_integration_stock_prep_refresh_state`（刷新状态、待定、执行台账）、`104_create_integration_stock_prep_change_plan`（变更计划）、`106_extend_integration_stock_prep_refresh_execution_for_recovery`（执行 intent 日志与关闭形态）、`107_create_integration_stock_prep_component_ruling`（部件裁定 / 残留确认）。`105` 两边逐字节相同，R83 已经跑过。
- 平台 Kysely 迁移 10 个：`zzzz20261022150000_add_meta_sheets_grid_export_closure`、`zzzz20261031120000_add_users_recycle_bin`、`zzzz20261101090000_create_directory_handovers`、`zzzz20261102150000_dingtalk_login_repairs`、`zzzz20261103120000_outbound_intent_attempt_lease_target_key`、`zzzz20261104150000_create_task_source_links`、`zzzz20261106120000_create_security_action_challenges`、`zzzz20261106130000_create_directory_integration_capabilities`、`zzzz20261107010000_deprovision_effect_provider`、`zzzz20261111093417_create_user_notification_endpoints_preferences`（#6857，2026-11-11 合入；切包提交更新时按实际再算一次）。
- **【待定 #6843】** 迁移 `108`（修复台账与一次性占用）。切包提交里有 #6843 时才有它，到时把它加进清单。

**全部随包一起跑，不能只装构建不跑迁移。** 106 头注释（`106_extend_integration_stock_prep_refresh_execution_for_recovery.sql:40-44`）：缺 106 时，**每个项目**的每次拉取和每次正式导出都答 503 `STOCK_PREP_REFRESH_STORE_FAILED`；104 同样（`104_create_integration_stock_prep_change_plan.sql:38-40`）。107 缺失时就绪清单的残留检查对每个项目都不通过（`107_create_integration_stock_prep_component_ruling.sql:37-39`）。所以这次升级**绝不用 `-RunMigrations 0`**（升级脚本默认 `'1'`，`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1:269`；为 `0` 时跳过迁移，`:2864-2878`）。

### 1.2 只读预检（窗口之前，结果只记计数）

**(1) 迁移清单。** 新包还没装，不在现场跑它的 `migrate.js`。窗口之前分两步核：

- 用**已安装的 R83** 的 `migrate.js`，带与升级脚本相同的环境（先导入 `docker/app.env`）：

  ```powershell
  node packages\core-backend\dist\src\db\migrate.js --list
  ```

  `--list` 只读（`packages/core-backend/src/db/migrate.ts:129`）。通过：Pending 为 0、Applied 等于 R83 自带的迁移数——说明现场库只跑过 R83 自带的迁移；R83 的名字全部在 main 里（§1.1），新包的迁移器不会报「missing」。
- 再用只读 SQL 核 §1.1 的 17 个名字**一个都还没跑**（Kysely 的默认记录表 `kysely_migration`，同 `r61-release-checklist-draft-20260928.md` 的做法；本手册所写，未在库上执行过）：

  ```sql
  BEGIN READ ONLY;
  SELECT n AS migration, EXISTS (SELECT 1 FROM kysely_migration k WHERE k.name = n) AS applied
    FROM unnest(ARRAY[
      '<§1.1 的第 1 个名字>',
      '<§1.1 的第 2 个名字>'
      -- ……17 个逐条列出（有 #6843 时 18 个）
    ]) AS n ORDER BY n;
  ROLLBACK;
  ```

通过：每条 `applied = f`。不通过：有 `t`，或 R83 的 `--list` 不是 Pending 0——停下，回帖只列不匹配的名字，不要重跑、不要手工补迁移。

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

(c)（带试点标记的登记行）与 (e)（第 4 步各表的行数）装机前查不了：101 / 102 / 103 还没跑，列和表都不存在。它们放在 §1.4 装后核对里，期望都是 0。

**(3) 非备料基线（为 §7.3 留底）。** `app.env` 里 `AUTOMATION_CLASSB_OUTBOUND_ENABLED` 是否精确为 `true`（只记「是 / 否」）：

```powershell
@(Select-String -LiteralPath '<安装根目录>\docker\app.env' -Pattern '^AUTOMATION_CLASSB_OUTBOUND_ENABLED=true$').Count
```

**(4) 停下来的条件**（任一成立就不开窗口）：(1) 不通过；(d) 不为 0（先由 owner 定怎么处理那张 env 表）；Q-B 或 G-B9 没批；切包提交没定。

### 1.3 维护窗口内

1. 停定时拉取任务，通知拉取人员窗口内不要拉。
2. 按交付说明 §2.1 的就地升级路径装包，`-RunMigrations 1`。
3. 升级脚本跑完、后端起来后做 §1.4。不通过就按 §7 回退，不要在现场改库或改代码。

### 1.4 装后核对

**(1) 迁移。** 再跑一次 `--list`，Pending 为 0。逐个确认 7 个备料迁移：`node packages\core-backend\dist\src\db\migrate.js --confirm <名字>`，退出码 0 = 已执行、1 = 待执行、2 = 不认识（`migrate.ts:130`）。

**(2) 授权。** 插件的数据库助手建在宿主给的 `context.api.database` 之上（`db.cjs:194-200`），用的就是后端自己的数据库连接，所以用 `app.env` 里 `DATABASE_URL` 的那个角色连上去查（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）。迁移头注释写明要求的：105 四张表 SELECT / INSERT / UPDATE（`105_create_integration_stock_prep_pull_batch.sql:67`）；106 的 intent 表 SELECT / INSERT，执行台账与变更计划 SELECT / INSERT / UPDATE（`106_…:46-47`）；107 的裁定表 SELECT / INSERT / UPDATE（`107_…:41`）。100–104 的头注释没写授权，这里一并查三种权限。**只查不授**；有一格是 `f` 就停下报开发机。

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
    'integration_stock_prep_component_ruling'
  ]) AS t ORDER BY t;
```

intent 表只要求 `s`、`i` 为真，其余各表三列都要为真。

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

R83 包里的 `scripts/ops/stock-preparation-scheduled-pull.mjs` 不认识 `suspended`、`review_pending`、`recovery_pending`（`git show onprem-r83:scripts/ops/stock-preparation-scheduled-pull.mjs` 里这三个词的计数为 0）。main 包里带着新版（`scripts/ops/multitable-onprem-package-build.sh:117`）：受治理项目整次挂起记 `skipped_suspended`（`scripts/ops/stock-preparation-scheduled-pull.mjs:642-643`），变更待复核记 `skipped_review_pending`（`:658-659`），二者都不改退出码；上次写入未完成记 `error` / `STOCK_PREP_REFRESH_RECOVERY_PENDING`、`failed: true`（`:651-652`），**这是失败**，要有人去恢复（§4）。脚本只用 Node 内置模块（`:120`），环境变量和参数没变，原样替换任务执行的那份拷贝即可：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '<安装根目录>\scripts\ops\stock-preparation-scheduled-pull.mjs'
Copy-Item -LiteralPath '<试拉脚本路径>' -Destination ('<试拉脚本路径>' + '.pre-main-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath '<安装根目录>\scripts\ops\stock-preparation-scheduled-pull.mjs' -Destination '<试拉脚本路径>' -Force
Get-FileHash -Algorithm SHA256 -LiteralPath '<试拉脚本路径>'
@(Select-String -LiteralPath '<试拉脚本路径>' -SimpleMatch -Pattern 'skipped_review_pending').Count
```

两次 SHA-256 必须相同，计数应 ≥ 1。然后恢复定时任务，手动触发一次：还没有试点时，每个项目的结果应与升级前相同。

## 2. 对所有项目生效的行为变化（不只试点项目）

这些是 T 层默认值，装了 main 包就对客户机上**每一个**备料项目生效，owner 在 G-B9 一次接受：

1. **表登记给别人就拒（R-56 ①，TD-27）。** 解析出的目标表已登记给同租户另一个项目，答 409 `STOCK_PREP_REFRESH_TARGET_RETARGETED`；登记给另一个租户，答 409 `STOCK_PREP_REFRESH_TENANT_MISMATCH`（`stock-preparation-refresh-governance.cjs:47-55`、`:240`）。项目表开关打开时，除了登记竞态，这碰不到；§1.2 (d) 为 0 时，开关关着也碰不到。
2. **大 BOM 要重新计划、旧作业要重新展开（R-57 ①）。** 批准一个大 BOM 计划，要求计划路由记下的治理裁决；没有就 409 `LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED`（`stock-preparation-large-bom-jobs.cjs:793-800`）——装机前计划好的展开都要重新计划才能批准（§1.2 的 `large_expansions_without_verdict`）。另外，R83 上批准、还没跑完的应用作业没有写锁绑定，main 上续跑每一块都被拒 `job_unbound`；办法是**新开一次展开**（展开 → 计划 → 批准 → 跑完），已落的行按幂等键重新规划为更新或跳过，不会重复新增（`:1554-1563`）。拉取人员会看到这一步，先告诉他们。
3. **步骤 4 的表读不出时，通用写入一起停（R-61 ①）。** 流水线多维表写入、C6 写入、ERP 回写在写任何表之前都先探测这张表是否受治理；探测读不出就 503 `STOCK_PREP_REFRESH_STORE_FAILED`，与备料无关的流水线也停（`stock-preparation-governed-sheet-probe.cjs:27-30`）。所以迁移一定要随包跑（§1.1）。
4. **带版本号写入（R-63 ①，按代码写的样子）。** 小车道的更新 / 停用带上锁内重算读到的记录版本，不论项目是否受治理。版本冲突时**只重读一次**：只是有人改了人工列（插件不写的列），就用新版本**再发一次**，照常写完；插件写的列变了、行被替换 / 不见 / 重复、或第二次还冲突，**整次停下**，409 `STOCK_PREP_CHANGE_PLAN_STALE`，带已写的部分计数，之后的行一行都不写（`stock-preparation-apply-writer.cjs:700-709`）。大车道分块与「新增撞上已有行」两处仍是旧的宿主调用（`:695-698`）。
5. **定时拉取多两种「跳过」（R-62 ②、R-77）**，见 §1.5。它们只出现在受治理项目上；试点开启之前不会出现。
6. **正式导出遇到写入占用就拒（#6566）。** 每个项目的正式导出先读一次表写锁：有租约，不论是活的还是中断后留下的，都 409 `STOCK_PREP_EXPORT_BLOCKED`、原因 `lease_in_flight`（`stock-preparation-export-gate.cjs:198`；未受治理项目只受这一条和前后两次锁读的约束，文件字节与审计不变，`:38-41`）。中断留下的占用，要等一次拉取人员档的试算、一次应用接管或一次观察把它清掉。
7. **交接链最后一跳要拿写锁（#6836 (d)，R-91 ㉑）。** 每一个交接终点一跳（未受治理项目也算）都要求写锁接线并读一次锁代次：未接线 501，读取失败拒绝；受治理项目因刷新状态被拒（`STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE`，409 / 503）时，写一行无值审计（`http-routes.cjs:5271-5300`）。只有现场配了交接链才会碰到。
8. **写锁的时长。** 租约 120 秒（`stock-preparation-project-write-lock.cjs:132`），心跳 30 秒（`:133`），接管宽限再 120 秒（`:134`）；到期加宽限之前都算「活的」（`:480-487`）。所以一个挂死的写入方最多挡住这张表约 **4 分钟**，之后才能被接管。
9. **项目目录多三个计数（#6836 (c)，R-91 ㉑）。** 开关打开时，目录的登记行带上 `openRefreshHoldCount` / `pendingReviewCount` / `refreshBlocked`；每次回答多几次有界读取，只对受治理的行逐个咨询，治理没接线时这几个键不出现。
10. **平台侧（非备料）的新触发器。** `zzzz20261101090000` 在审批卡片投递表上加了插入触发器：某个集成处于已应用 / 已定稿的通讯录交接时，向它投递新卡片被拒（SQLSTATE 55000，`packages/core-backend/src/db/migrations/zzzz20261101090000_create_directory_handovers.ts:37-47`）；`zzzz20261102150000` 在钉钉登录身份和通讯录关联上加了触发器，存在已应用的登录修复时，改动被钉住的身份被拒（55000，`…/zzzz20261102150000_dingtalk_login_repairs.ts:36-47`、`:74-83`）。交接或修复出现之前它们什么都不拒，但会多拿行锁。回退到 R83 后这些触发器**仍然生效**（§7.3）。

## 3. 逐表准备与开启试点的顺序

一张试点表，严格按这个顺序走；每一步的批复不同，不能合并：

1. **批次标识装机先做（O-BI-1，每张表一份；开关 O-BI-7 另批）。** 按 `runbook-stock-prep-pull-batch-install-window-20261108.md` 做。做完后这张表在台账里是 `born_empty` 或 `backfilled`（`105_…:114-115`）。就绪清单里 `pull_batch_enabled` 要求开关打开，`pull_batch_history_resolved` 要求历史已解析（`stock-preparation-pilot-readiness.cjs:62-69`），所以没有装机就开不了试点。
2. **普查（O6-3，读客户数据）**，见 §5。看这张表有没有双份（D1：`twoCopyComponents`）或第 10 项那种残留（D2：`inactiveRootRemnantComponents`）。
3. **只有普查不干净时：**
   - 问客户（经 owner 转达；开发机从不直接联系客户）：Q1「这个部件现在还单独下单吗」，Q3「现在大家填的是哪一份」。
   - D2 残留：**只有在 owner 转达了客户对 Q1 的回答（不再单独下单）之后**，才记残留确认（O6-5，§5.3）。
   - D1 双份：走修复窗口（O6-6，§6）**【待定 #6843】**。
4. **看就绪。** `GET /api/integration/stock-preparation/projects/<项目号>/target/pilot`，`stock-prep:admin`（`http-routes.cjs:257`、`:11998-11999`）。回答是 `{ version, ready, checks: [{ id, ok }], failing: [id] }`（`stock-preparation-pilot-readiness.cjs:13`、`:472-478`），外加 `may.enable`。现在 `readiness.version` 是 **5**（`:113`），共 **27** 项（`:139-165`）：版本 3 加了批次标识六项，版本 4 加了 `change_plan_store_readable`、`execution_recovery_ready`，版本 5 加了 `no_unacknowledged_inactive_root_remnant`，最后一项永远是 `continuation_support_version`。**在 S6-9 之前，`failing` 里至少有 `continuation_support_version`。** 只有它一项不通过，说明这张表已经准备好，等翻转。switch-on 手册附录 B.1 写的「版本 2、18 项」已过时，按本节读。
5. **启用 【待定 S6-9】。** 翻转合入、新包装上之后，按 `runbook-stock-prep-project-sheets-switch-on-20261014.md` 附录 B.2（旧大作业处置）、B.3（启用与「答 500 ⇒ 再 POST」）做。B.2 / B.3 描述的路由与请求体（`{"confirmProjectNo": "<项目号>"}`，`stock-prep:admin`，`http-routes.cjs:258`、`:12471-12473`）在 0232a25f2 上仍成立。启用前还要：Q-B 已批、拉取人员已指定、R-91 的否决窗口已过。
6. **试点开启后的两条限制，要告诉拉取人员。** 试点项目每条大车道路由都答 409 `STOCK_PREP_PILOT_LARGE_LANE_REFUSED`；小车道试算撞到上限时答 `STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED`，**不会**转去大车道（`stock-preparation-pilot-gate.cjs:6-11`、`:33-34`）。所以超上限的项目不能做试点。试点表的通用网格导出被宿主关闭（附录 B.3）。

**退出试点：** 没有路由。101 头注释给了 owner 批准的一条手册数据库语句（一次清三列，`101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable.sql:24-29`）：

```sql
UPDATE integration_stock_prep_project_target
   SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL
 WHERE tenant_id = $1 AND project_no = $2;
```

它只清大车道拒绝和就绪状态；网格导出仍关着（重开是另一次 owner 批准的手册操作），已经写下的沿用关系、待定、执行**照样保护**这个项目（`:30-34`）。清了标记也不能回退到 R83（§7.4）。

## 4. 恢复（「拉取待确认」页的恢复卡片）

**什么时候出现。** 一次受治理的写入没有正常结束（进程没了、中途停止、写了一部分），项目就是「失败待恢复」：之后每次拉取都不写，正式导出暂停，定时拉取记 `STOCK_PREP_REFRESH_RECOVERY_PENDING`（§1.5）。恢复卡片只在页面的刷新状态是失败待恢复时才出现（`apps/web/src/components/integration/stockPreparation/StockPreparationRefreshRecoveryCard.vue:7-8`）。

**拉取人员怎么做（`stock-prep:pull`）。** 三条路由（`http-routes.cjs:364-370`）：执行列表 `GET …/projects/<项目号>/refresh/executions`；核对 / 结束 `POST …/refresh/executions/<执行 id>/recover`，请求体只能是 `{ confirmProjectNo, mode, verifyDigest?, pageCursor? }`（`:3132`），`mode` 是 `verify` 或 `close`（`stock-preparation-execution-recovery.cjs:58`）。在卡片上：

1. 输入项目号，点「核对上次写入」（`StockPreparationRefreshRecoveryCard.vue:92`）。系统按表格现在的内容核对上次写进去了哪些行，**不写任何东西**。没能证明写入的行分页列出，每页最多 200 行（`stock-preparation-execution-recovery.cjs:57`）。
2. 核对能证明时，点「结束这次执行」（`:99`）。结束要回显上一次核对的摘要（`stock-preparation-execution-recovery.cjs:379`），在锁里重新判定每一项准入事实。
3. 结束之后**重新试算**，以新的试算为准（`apps/web/src/services/integration/stockPreparation/plainLanguage.ts` `STOCK_PREP_REFRESH_RECOVERED_NEXT`）。

**被拒时。** `STOCK_PREP_REFRESH_RECOVERY_STALE`、`STOCK_PREP_PULL_STATE_MOVED`、`STOCK_PREP_PROJECT_WRITE_LEASE_LOST`：什么都没改，重新核对。`STOCK_PREP_REFRESH_RECOVERY_BUSY`：别的操作占着一行，稍后再点。`STOCK_PREP_PROJECT_WRITE_LOCKED`：一次拉取或另一次核对正在写，稍后再点。`STOCK_PREP_REFRESH_EXECUTION_NOT_FOUND` / `…_NOT_UNFINISHED`：重新读取（`stock-preparation-continuation-store.cjs:241`、`:261-266`）。`STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE`：表格证明不了写进了哪些行（重复行、行不见了、行被替换、内容对不上等，`stock-preparation-execution-recovery.cjs:62`），**拉取人员不能结束**，交平台管理员。

**平台管理员按手册结束（结果未知；`stock-prep:admin`）。** 只在 UNPROVABLE、或核对一直做不下去时用。路由 `POST …/refresh/executions/<执行 id>/close-unverified`（`http-routes.cjs:370`、`:14851-14865`）。卡片上的「按手册结束（结果未知）」区块只对管理员显示：

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

四条路由都只认 `stock-prep:admin`，项目表开关关着时零 IO 答 404，租户取自令牌（`http-routes.cjs:304-324`）。令牌必须绑定本租户；不要在请求里另带别的租户 id（不一致就 403 `OPERATOR_SCOPE_TENANT_MISMATCH`，`stock-preparation-operator-scope.cjs:453-457`）。

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

- **`status: incomplete` 不是 0。** 这一行没有任何计数，原因是封闭词之一：`target_unresolved`、`sheet_mismatch`、`tenant_wall`、`rows_unreadable`、`rows_too_large`、`pack_unreadable`（`stock-preparation-remnant-acknowledgement.cjs:62-69`）。把它当「没查到」，查明原因后重跑，不能当干净。一个项目的普查读不出客户包列时答 503 `STOCK_PREP_SHEET_CENSUS_PACK_UNREADABLE`（`:58`）。
- **已接受的残留（R-91 ㉕）：表上缺了关键列，普查仍可能答 `complete`，读起来像干净。** 原因是路由不像 R 线包那样检查列是否存在（封闭词里没有 `field_missing`）。修好之前，**一行 `complete` 只有在同一项目的就绪回答里 `target_fields_present` 也为真时才可信**（§3 第 4 步的 GET）。`target_fields_present` 为假的表本来也启用不了。
- 确认数读成 `null`（`rulingsReadable: false`）：裁定表读不出，先查 107 与授权（§1.4）。

### 5.3 残留确认（只在客户回答 Q1 之后）

只有 owner 转达了客户对 Q1 的回答（这个部件已不再单独下单，H0），才记确认（O6-5）。路由 `POST /api/integration/stock-preparation/projects/<项目号>/target/remnant-acknowledgements`，请求体固定（`http-routes.cjs:313-317`、`:3138`）：

```json
{ "confirmProjectNo": "<项目号>", "componentHandle": "<一个项目普查里列出的句柄>", "basis": "head_not_ordered", "runbookRef": "<工单号>", "acknowledge": { "customerAnswered": true } }
```

服务端在一次新的读取上重新证明这个句柄**现在**是 D2 残留，不是就 409 `STOCK_PREP_REMNANT_NOT_PRESENT`、什么都不写（`stock-preparation-remnant-acknowledgement.cjs:207-212`）；是就在一个事务里写确认行（迁移 107）和审计 `exception_resolve` / `remnant_acknowledged`。确认**不是**计划的输入：确认错了也是安全一侧——第一次受治理计算若仍读到这个部件的订单头，项目会挂起 `dropped_order_head_unresolved`，直到有裁定或退出试点（设计 §6.3）。

### 5.4 撤销

`POST …/remnant-acknowledgements/<确认 id>/revoke`，请求体 `{ "confirmProjectNo": "<项目号>", "runbookRef": "<工单号>" }`（`http-routes.cjs:318-319`、`:3139`）。撤销自带工单号。**下面三种情况都要撤销：**

1. 一个项目普查的 `acknowledgementsNotCurrentlyRemnant` 里列出的每一条（部件已经不是残留：修过了，或旧根行又被拉活）。
2. **一条确认会比它当初对应的形状活得久**：旧根行被拉活、之后又被停用，重新形成的残留仍被**原来那条**确认豁免，没有新的客户回答。所以只要这个部件的形状变过（出现在第 1 种列表里过），就撤销，需要时按新的 Q1 回答重新确认。
3. 每次修复窗口做完 retire 或 restore 之后，重跑这个项目的普查，按第 1 条撤销 **【待定 #6843】**。

撤销按写入查找项目表，归档项目上的确认要先恢复项目才能撤销（409 `STOCK_PREPARATION_PROJECT_ARCHIVED`，`stock-preparation-project-targets.cjs:233`）。

## 6. 双份表修复窗口 【待定 #6843：只是提纲，不要照做】

修复工具（S6-6）还在修正轮，路由、码和行为都可能变。合入后按合入的代码重写本节，并把它的登记文本补进 R-91。现在只定下这些**不会变的**窗口规矩：

1. **开关。** 真实运行要求默认关闭的开关 `MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED`，只认精确的 `true`（R-91 ⑯）。窗口开始时打开，结束时关掉；按 #6843 当前草稿，开关关着时整组修复路由（含预览和补填报告）都是 404，所以给客户准备 Q3 的补填报告也要开开关 **【待定 #6843】**。
2. **一个摘要一份批复。** 先预览，拿到预览摘要（planDigest）；owner 对**这个摘要**批复，批复编号就是 approvalRef；执行时回显摘要。摘要变了（表上有人改了行）就要新的批复。同一份批复只能用一次。
3. **整个窗口暂停这个项目的拉取**（定时任务 + 通知拉取人员），从 retire 一直停到 restore 或裁定完成；同时数一下这张表上的自动化规则和 webhook，窗口内暂停。
4. **修复窗口与批次标识装机窗口从不交错**（改正节 B-10）。注意：设计 B-10 说「装机在租约内的摘要核对随后会拒绝」，这只在装机的 dry_run 与第一次装机之间成立；对已在装机中的表**不成立**——`continue` / `resume_aborted` 直接用持久化的计划（`stock-preparation-pull-batch-install.cjs:624-629`、`:647-648`），只比对请求摘要和这份计划的摘要（`:788-792`），从不重算。S6-6 复核第 1 轮的探针显示：在规则 `predecessor_suffix` 下，同一部件的副本会落成不同的「首次批次」，而且标签永不改写；规则 `material` 下标签不受影响（本手册只读了代码路径，没有复跑探针）。所以下一条预检是硬前提。
5. **每个修复窗口之前，先查这张表的批次台账行**（105，已在 main 上，可以现在照做；语句（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍））：

   ```sql
   SET default_transaction_read_only = on;
   SELECT history_status, (history_plan IS NOT NULL) AS plan_kept
     FROM integration_stock_prep_pull_batch_sheet
    WHERE sheet_id = '<项目表 sheetId>' AND project_no = '<项目号>';
   ```

   - `history_status = 'installing'`：停。先把装机做完（或按装机手册 §6 中止），再开修复窗口。
   - `history_status = 'pending'` 且 `plan_kept = t`：停。这是一次中止后留着计划的首装，再跑会按旧计划续上（`:627-629`）。先把装机做完。
   - `born_empty` / `backfilled`，或者没有行（这张表从没开始装机）：可以开。§3 的顺序是先装机，所以正常应是前者。
6. **备份与恢复。** 每次 retire 都先存备份；restore 是另一份配方、另一次预览、另一份批复，按行**当前**的版本写。
7. **跑完一半停住的修复。** 按 #6843 当前草稿，一次已全部写完但收尾失败的修复会停在 `running`：预览关不掉它，也没有下一次 retire 可做，只有 restore 那一次能动它（等于撤销修复）。项目一旦受治理，两种配方都开不了，工具里没有办法关掉这样的运行。合入前要给出一条 owner 批准的关闭办法 **【待定 #6843】**。
8. 做完后：重跑普查，按 §5.4 撤销，看就绪。

## 7. 停止条件与回退

### 7.1 先分清「回退到哪个构建」

- **回退到 R83（现场实际的旧构建，R 线，还不认识第 4 步）。** 设计 §7.5：**只要库里有任何第 4 步的行，就禁止回 R 线构建**；102 头注释：不认识沿用关系的构建，下次刷新受治理项目时会新增一份副本、再把旧行停用（`102_…:31-36`）。试点开启之前，第 4 步的行只为受治理项目写（`stock-preparation-refresh-lanes.cjs:418`；受治理 = 试点或已有行，`stock-preparation-refresh-state.cjs:223`），而试点在 S6-9 之前开不了，所以这时各表都是 0，可以回退。
- **回退到更早的 main 包（以后有了第二个 main 包时）。** 用下面 7.2 的全部阻断查询，外加迁移 106 那一条。

### 7.2 备料停止条件（只读，全部为 0 才回退）

102、104、106、107 的语句照抄迁移头注释；103 的两条是按头注释的文字写成的（本手册所写，未在库上执行过；第一次用时先在开发机的一次性库上跑一遍）。

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
```

- 106 那条不为 0：对每个这样的项目做一次干净的试算并结算，再查（R-91 ⑳：只计 `verified_closed` 的旧写法会漏掉排在透明关闭之后的未结算 `succeeded` 主体）。
- 回退到 R83 时，再加一条：§1.4 (3) 那组里除 `component_ruling`（107，只供参考：R83 不读它，残留确认可以在启用之前就记下）以外的各表行数**全部为 0**，带试点标记的登记行为 0。
- **【待定 #6843】** 108 合入后加一条：`running` 状态的修复运行为 0（设计 §7.5）。
- **【待定 #6844 / S6-9】** S6-9 的 G9 在冻结候选上做 U07 回退演练（旧构建 + `RunMigrations 0`，库里带着未完成执行、透明关闭、已确认计划等产物）；演练没过之前，本节只是读代码得出的条件，不是演练过的。

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
[S6-8] 2026-11-xx 装机窗口：Pending 17 → 0；--confirm 100/101/102/103/104/106/107 全为 0；授权 14 表全真；装后计数全 0
[S6-8] 普查 第 1 页：序号 1 complete D1=0 D2=0；序号 2 incomplete reason=pack_unreadable；序号 3 complete D1=0 D2=1 governed=none
[S6-8] 序号 3 就绪 v5：failing=[continuation_support_version]
```

**只能进私有记录**：项目号、序号与项目 / objectId 的对照、`componentHandle`（它是业务值的摘要，可被反推）、执行 id、完整的普查 / 核对应答文件、待处理页里的部件编码和名称、主机、地址、令牌、数据源 id、批复原文里的任何业务值。

## 待定标记清单（合入后回到本手册改写）

| 标记 | 位置 | 合入后要做的 |
|---|---|---|
| 【待定 #6843】 | §1.1 迁移 108；§3 第 3 步 D1 修复；§5.4 第 3 条；§6 全节；§7.2 的 108 停止条件 | 按合入代码写修复窗口的路由、请求体、码与开关行为；补 108 的停止条件查询；把 #6843 的登记文本补进 R-91 |
| 【待定 #6844 / S6-9】 | §7.2 U07 演练 | 用 G9 工具在冻结候选上跑 U07 演练，结果写进本手册 |
| 【待定 S6-9】 | §0 启用；§3 第 5 步 | 翻转合入后，重核附录 B.2 / B.3 并写正向一腿的实际回答 |
| owner 未裁 | §0（切包提交与是否带 S6-9、Q-B、O6-7、试点项目、拉取人员） | 裁定后记进登记册，再执行对应步骤 |
