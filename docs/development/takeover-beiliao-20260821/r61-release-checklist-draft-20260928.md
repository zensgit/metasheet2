# R61 上机清单（草案，范围待 owner 确认）

> **状态：草案。** 打包点与范围由 owner 决定。§1 只列事实，不代 owner 推荐。owner 定下具体提交之后，§2 的迁移名单必须在那个提交上用命令重算，§5、§6 只看对应选项。
> **执行者：** 旧机（运维机）。开发机连不上演示机，演示机现状全部来自 #6079 的回帖，按回帖时间戳（UTC）引用。
> **口径：** values-free。回帖只写布尔、计数、枚举、键名、用时；不写主机、地址、口令、令牌、客户名、项目号、单元格值。需要项目号、表 id 的地方用 `<项目号>`、`<表 id>` 或 psql 变量代入，不回显。
> **基线：** 文中 `path:line` 以 origin/main `cd89c74dd`（#6146，2026-09-28T23:10:28Z 合入）为准，另注明者除外。PR 状态为 2026-09-29 约 00:30Z `gh pr view` 的结果。
> **上机手册：** 仍是 `handoff-r59-two-machine-20260924.md` §2–§3（#6079 正文第 0 节要求每次上机前读）。本文只补 R61 特有的事项。

---

## 1. 打包点选项（待 owner 决定）

### 1.1 决定性事实：R60 之后 main 的 first-parent 顺序

```bash
git fetch origin main --tags
git log --first-parent --reverse --format='%h %s' 583dfdf1a..origin/main
```

在 `cd89c74dd` 上共 17 条，从旧到新：

| # | 提交 | PR | 内容 | 类别 |
|---|---|---|---|---|
| 1 | `8a6746428` | #6116 | 复制数据表 S1 前端 | 客户需求（复制数据表） |
| 2 | `0185b00a5` | #6112 | 复制数据表 S1 后端（含 #6128 目标门）+ 2 条迁移 | 客户需求（复制数据表） |
| 3 | `14e52a6e5` | #6059 | 时间机器检查点校验脚本，只改 `packages/core-backend/scripts/verify-recovery-manual-checkpoint.mts` | 其它线，非运行时代码 |
| 4 | `d14bb9ce1` | #6134 | 测试夹具 | 仅测试 |
| 5 | `b433ac814` | #6135 | 复制数据表 R61 验收清单 | 文档 |
| 6 | `601990756` | #5845 | 任务线 M0 设计 | 文档（任务线） |
| 7 | `0d1da4929` | #6062 | 任务线 P0-A 表与咨询锁（草案）+ 2 条迁移 | 任务线 |
| 8 | `5e8f643a5` | #6092 | 任务线 `/tasks` 路由与导航入口（草案） | 任务线 |
| 9 | `bbb92dab7` | #6123 | 任务线 M3 纯函数 | 任务线 |
| 10 | `5ac5b3ed1` | #6136 | 复制数据表：去重账本不可用时拒绝（503） | 客户修复 |
| 11 | `5143aed65` | #5878 | 审批模板分组 A-4 | 审批模板分组 |
| 12 | `5e97c7116` | #6142 | 项目备料页「通知下一步」补发 `fromStepKey` | 客户修复 |
| 13 | `03202a1e9` | #6140 | 「通知下一步」先核目标表租户归属 | 客户修复 |
| 14 | `68578b56f` | #6139 | 字段类型转换第 2 刀：只读预览，开关默认关，无界面 | 客户需求线，界面无变化 |
| 15 | `33047ef94` | #6143 | #6142 的两条 409 分支测试 | 仅测试 |
| 16 | `6cddab3e5` | #5927 | 审批模板分组 A-5 | 审批模板分组 |
| 17 | `cd89c74dd` | #6146 | 项目备料页「通知下一步」：结果措辞、最后一步、欠发补发与确认队列一致 | 客户修复 |

由此得出的事实：

- 客户修复 #6136（第 10 条）排在任务线 #6062、#6092、#6123（第 7–9 条，含两条任务迁移）之后。#6142、#6140（第 12、13 条）排在审批模板分组 #5878（第 11 条）之后。所以**沿 first-parent 切的点只要带上 #6136，就一定带上任务线和它的两条迁移；只要带上 #6142 或 #6140，就一定带上 #5878。**
- 不带任务线和 #5878 的最后一个 first-parent 点是 `b433ac814`（第 5 条）。它有复制数据表 S1，但没有 #6136、#6142、#6140。
- #6146（第 17 条）排在 #5927（第 16 条）之后：沿 first-parent 切的点只要带上 #6146，就一定带上 #5927。切在 `33047ef94`（第 15 条）两者都不带；切在 `6cddab3e5` 带 #5927、不带 #6146。
- main 还会前进（在开 PR 见 §2.3、§6.3）。owner 定的应是一个具体提交号。

### 1.2 R59、R60 是怎么切的

- **R59** = main `05461c739`（`handoff-r59-two-machine-20260924.md:9`），CI 打包（同文 `:10`）。它在 main 的 first-parent 链上（`git log --first-parent --format=%h origin/main | grep ^05461c739` 有输出）。origin 上没有指向它的 tag：`git ls-remote --tags origin` 里既没有指向 `05461c739` 的，也没有名字含 `r59` 的；`onprem-` 开头的发布 tag 只有 `onprem-r60`。
- **R60** = main `583dfdf1a`，即 #6131 的合入提交，开发机在 #6079 2026-09-28T09:01:43Z 指定。origin 上 tag `onprem-r60` 指向它，它也在 first-parent 链上。旧机 2026-09-28T10:34:09Z 回帖：CI 打包按 `expected_sha` 复核，本地门禁全过。
- **打包工作流：** `.github/workflows/multitable-onprem-package-build.yml`，`workflow_dispatch`（`:41`），输入 `expected_sha`（`:63`）。检出的提交与它不一致就拒绝打包（`:122-131`）。
- **R60 之后没改过的东西：** 下面这条命令在 `cd89c74dd` 上无输出。也就是说，升级脚本、打包工作流、`docker/`、`ecosystem.config.cjs` 从 R60 起一字未动：
  ```bash
  git diff --stat 583dfdf1a origin/main -- scripts/ops/multitable-onprem-package-upgrade-inplace.ps1 \
    .github/workflows/multitable-onprem-package-build.yml docker ecosystem.config.cjs
  ```

### 1.3 选项 A：在 main 上选一个 first-parent 提交，原样打包

- **候选：** `cd89c74dd`（今天的头，含 #5927 与 #6146）、`6cddab3e5`（含 #5927，不含 #6146），或 `33047ef94`（两者都不含）。
- **迁移：** 4 条（§2.2）。
- **与已验证流程的偏差：** 切法、tag、`expected_sha`、升级脚本都与 R60 相同。需要注意的是包里带两条任务线迁移。其中 `zzzz20260926120000_create_task_p0a_tables` 的头注释写着「Draft migration: do not apply from this PR」（`:2`），但只要在包里，migrate 就会执行它。它建表、建索引都不带 `IF NOT EXISTS`（`:57`、`:97`、`:113`、`:124`、`:140-161`），所以上机前必须做 §3 的 C2。

### 1.4 选项 B：选项 A 的提交，但在 migrate 这一步用 `MIGRATION_EXCLUDE` 排除两条任务迁移

`MIGRATION_EXCLUDE` 在代码里的实际作用（`packages/core-backend/src/db/migration-provider.ts`）：

- **读取：** 调用方没传 `excludedNames` 时读 `process.env.MIGRATION_EXCLUDE`，按逗号切分并去掉空白（`:267-272`）。每一项按「去目录、去 `.ts`/`.sql` 等扩展名」归一（`:167-178`），所以写迁移名或文件名都行。
- **效果：** `getMigrations()` 的最后一步把命中的名字**整条丢掉**（`:309-311`）。迁移表里不留任何历史标记，Kysely 根本看不到这两条。
- **谁读它：** 只有这个 provider。仓库里（测试与文档除外）只有 `migrate.ts:33` 构造它；`migrateToLatest` 的调用也只有 `migrate.ts:63`，后端启动时不跑迁移。
- **登记：** 没有登记在 `scripts/ops/global-history-flag-manifest.mjs`（`grep -n MIGRATION_EXCLUDE` 无结果）。provider 的注释说它是 CI 用的机制（`:36-39`），并明写 production 与 on-prem 的 `db:migrate` 这两种排除机制都不用（`:52-57`）。
- **怎么设：** 升级脚本第 6 步先把 `docker/app.env` 导入自身进程（`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1:1885`），再起子进程 `node migrate.js`（`:1892`），子进程继承这个进程的环境。所以只在执行升级脚本的那个 PowerShell 会话里设：
  ```powershell
  $env:MIGRATION_EXCLUDE = 'zzzz20260926120000_create_task_p0a_tables,zzzz20260926120100_add_task_permissions'
  ```
  不要写进 `app.env`。写进去之后，每次升级都会导入它（`Import-AppEnvFile`，`:1354-1394`），以后每次 migrate 都会排除这两条。
- **以后会怎样：** 这两条在迁移表里没有行。下一次不带该变量的 migrate 会把它们当作待执行，按名字顺序执行（`migrate.ts:32` 允许乱序历史；执行顺序见 §2.1）。那一次上机前要重做 C2。
- **界面上仍然看得到的：** 「任务」导航入口仍然出现（它是前端代码，只看 `tasks:read`，与迁移无关，见 §5）。`/api/tasks` 路由在 `TASKS_ENABLED` 未设时本来就不挂（`packages/core-backend/src/routes/tasks.ts:35-36`；返回 null 时 `packages/core-backend/src/index.ts:1879-1880` 不挂载）。三个 `tasks:*` 权限码不会写进 `permissions` 表；平台管理员不受影响（前端判定走管理员短路，`apps/web/src/composables/useAuth.ts:551-552`）。
- **迁移：** 2 条（复制数据表的两条）。
- **与已验证流程的偏差：** 用了一个未登记、按代码注释不用于 on-prem 的变量，而且只在一次会话里生效。按名核对（§2.4）时，预期名单是 2 条，而不是命令算出的 4 条。

### 1.5 选项 C：从 `b433ac814` 拉发布分支，拣选客户修复

- **例子（不是推荐）：** 在 `b433ac814` 上依次拣选 `5ac5b3ed1`（#6136）、`5e97c7116`（#6142）、`03202a1e9`（#6140）、`33047ef94`（#6143，仅测试），再拣 `cd89c74dd`（#6146）。#6139 可拣可不拣，界面都无变化。
- **可行性，只做了模拟：** `git merge-tree --write-tree` 逐条模拟这四次拣选，文本上都无冲突（不建分支、不动工作区）；在这四次的结果上再模拟拣选 `cd89c74dd`，同样无冲突。四次拣选后的树与 main `33047ef94` 相比，差别正好是被排除的六个提交（`601990756`、`0d1da4929`、`5e8f643a5`、`bbb92dab7`、`5143aed65`、`68578b56f`）改过的那 106 个文件，其中包括 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的一行。这棵树没有构建过，也没跑过 CI。
- **迁移：** 2 条（复制数据表的两条）。
- **与已验证流程的偏差：** R59、R60 都切在 main 的 first-parent 提交上（§1.2），选项 C 的包提交不在 main 上，main 的 CI 从没对这棵树整体跑过。打包工作流可以在任意 ref 上 `workflow_dispatch`，`expected_sha` 照样能钉住提交，但 tag 要打在发布分支的提交上。

### 1.6 对照

| 选项 | 迁移条数 | 客户会看到（详见 §5） | 与 R59/R60 做法的偏差 |
|---|---|---|---|
| A | 4 | 复制数据表；「通知下一步」修复（切在 `cd89c74dd` 时含 #6146）；「任务」入口（管理员、默认外壳）；审批「审批表单」页改动 | 无；需做 C2 |
| B | 2（两条任务迁移留待以后） | 与 A 相同，包括「任务」入口 | 未登记变量、只在一次会话里设；以后的某次 migrate 会补跑两条任务迁移 |
| C | 2 | 复制数据表；「通知下一步」修复（拣了 #6146 时含它）；没有「任务」入口，也没有审批页改动 | 包提交不在 main 上；整树未经 CI |

---

## 2. 迁移清单

### 2.1 推导命令（在选定的打包提交上跑，不要照抄本文的名单）

```bash
C=<选定的打包提交>
# 新增迁移，按执行顺序（名字排序）列出
git diff --name-only --diff-filter=A 583dfdf1a "$C" -- packages/core-backend/src/db/migrations packages/core-backend/migrations \
  | sed 's#.*/##' | grep -E '^[^_.].*\.(ts|sql)$' | sed -E 's/\.(ts|sql)$//' | LC_ALL=C sort
# 必须无输出：R60 之后被删除、改名或改动过的迁移文件
git diff --name-status --diff-filter=DRM 583dfdf1a "$C" -- packages/core-backend/src/db/migrations packages/core-backend/migrations
```

为什么这就是执行顺序：

- provider 读这两个目录。以 `_` 开头的名字（`migration-provider.ts:208`）、以 `.` 或 `_` 开头的文件、非 `.sql` 的 SQL 目录文件（`:239`）都跳过。
- `migrate.ts:32` 允许乱序历史。
- Kysely 版本是 0.28.8（`pnpm-lock.yaml:3222`）。它的 Migrator 把全部迁移名排序（`#resolveMigrations`：`Object.keys(...).sort()`），把历史表里没有的那些按这个顺序执行。
- 在 PostgreSQL 上，一次 migrate 的**全部**待执行迁移在同一个事务里跑（Migrator 的 `#runMigrations` 在适配器支持事务型 DDL 时包一层 `db.transaction()`，PostgresAdapter 对此返回 true）。任何一条失败，这一批都不生效。

### 2.2 在 `cd89c74dd` 上的输出（执行顺序）

`--diff-filter=DRM` 那条无输出。新增的 4 条：

| # | 迁移名 | 建什么、改什么 |
|---|---|---|
| 1 | `zzzz20260926120000_create_task_p0a_tables` | 建表 `tasks`、`task_assignees`、`task_followers`、`task_events`（`:57`、`:97`、`:113`、`:124`，带检查约束与外键），另建 8 个索引（`:140-161`）。不插数据（`:12`）。不带 `IF NOT EXISTS`。 |
| 2 | `zzzz20260926120100_add_task_permissions` | 若 `permissions` 表存在，插入 `tasks:read`、`tasks:write`、`tasks:admin`，`ON CONFLICT (code) DO NOTHING`；不写 `role_permissions`（`:1-3`、`:11-25`）。 |
| 3 | `zzzz20260927120500_add_meta_sheets_copy_provenance` | `meta_sheets` 加三列 `copied_from_sheet_id`、`copied_from_kind`、`copied_at`（可空，`IF NOT EXISTS`），并在约束不存在时加 CHECK `meta_sheets_copied_from_kind_check`（`:21-46`）。既有行保持 NULL。 |
| 4 | `zzzz20260927121000_add_multitable_install_ledger_intent_kind` | `meta_multitable_template_installs` 加列 `intent_kind text NOT NULL DEFAULT 'template-install'`（`IF NOT EXISTS`，`:25-28`）。复制数据表的去重账本依赖它和 R60 已有的 `zzzz20260919140000_create_multitable_template_install_ledger`（`copy-sheet-service.ts:106-114`）。该文件头注释 `:19-20` 仍写「fail-open」，已被 #6136 改为拒绝，以 §6.2 为准。 |

R60 上机后 `kysely_migration` 共 421 行（#6079 2026-09-28T10:37:13Z）。选项 A 预期新增 4 行，选项 B、C 预期新增 2 行。前提是打包点之前没有别的迁移合入。

### 2.3 在开 PR 若在打包点之前合入，会增加的迁移

检索命令（列出在开 PR 改动文件里、main 上还不存在的迁移文件）：

```bash
gh pr list --state open --limit 500 --json number,files \
  --jq '.[] | .number as $n | .files[] | select(.path | test("/migrations/")) | "\($n) \(.path)"' \
| while read n p; do git cat-file -e "origin/main:$p" 2>/dev/null || echo "$n $p"; done | sort -n
```

`gh` 每个 PR 最多返回 100 个文件。#4482、#4525 碰到这个上限，已用 `gh api --paginate repos/zensgit/metasheet2/pulls/<n>/files` 补查，没有多出新的迁移。2026-09-29 约 00:30Z 的结果（与 2026-09-28 约 21:50Z 那次相同）：

| PR | 状态 | 会新增的迁移 |
|---|---|---|
| #6149 | OPEN，draft | `zzzz20260928150000_relax_field_value_tombstone_reason_for_retype_convert`（改 `meta_field_value_tombstones` 的 reason CHECK）、`zzzz20260928150100_create_meta_field_retype_conversions`（新表加两个索引）、`zzzz20260928150200_backfill_approval_projection_system_kind`（对 `meta_sheets` 做 UPDATE） |
| #6099 | OPEN | `zzzz20260926140000_sealed_export_binding_live_external_system_fk` |
| #5933 | OPEN | `zzzz20260920150000_backfill_sql_readonly_legacy_connection_id` |
| #5650 | OPEN | `zzzz20260912120000_add_data_source_sharing_permissions` |
| #5611 | OPEN | `zzzz20260910120000_add_integration_permissions` |
| #6051、#6063 | OPEN，draft | `zzzz20260924180000_attendance_roster_org_gate_job_reason` |
| #5866 | OPEN，draft | `zzzz20260918090000_create_approval_template_groups`、`zzzz20260919090000_create_approval_template_group_backfill_batches`（main 上已有 `zzzz20260918090100_create_approval_template_groups`，R60 已执行） |
| #5703 | OPEN，draft | `zzzz20260914120000_create_approval_form_drafts` |
| #5412 | OPEN，draft | `zzzz20260901100000_create_elearning_offline_training`、`zzzz20260901150000_create_elearning_offline_registration` |
| #5395 | OPEN，draft | `zzzz20260831120000_create_elearning_onboarding` |
| #5346 | OPEN，draft | `zzzz20260830110000_add_automation_retry_evidence_marker` |
| #4477、#4482 | OPEN，draft | `zzzz20260719200000_create_approval_node_decision_values`、`zzzz20260719210000_add_write_approval_form_values_automation_action`、`zzzz20260719220000_create_fwb_confirmations`、`zzzz20260719230000_fwb_decision_values_cascade` |
| #4439、#4482 | #4439 OPEN；#4482 OPEN，draft | `zzzz20260717120000_add_approval_template_version_restore` |

### 2.4 规则：先迁移、按名逐条核对、再切代码

- 升级脚本本身就是这个顺序：第 6 步迁移（`multitable-onprem-package-upgrade-inplace.ps1:1878-1896`）在第 7 步起后端（`:1898-1907`）之前。迁移失败时错误抛进处理器，处理器停 pm2 并打印恢复块（`:1842-1852`、`:1972-1990`），新代码不会在没迁移的库上起来。
- 一次 migrate 的全部迁移在同一个事务里（§2.1）：要么都生效，要么一条都不生效。
- 跑完后**按名字**逐条核对，不按条数。名单来自 §2.1 的命令；选项 B 要减去被排除的两条：
  ```sql
  -- psql -X -A -v ON_ERROR_STOP=1
  BEGIN READ ONLY;
  SELECT n AS migration, EXISTS (SELECT 1 FROM kysely_migration k WHERE k.name = n) AS applied
  FROM unnest(ARRAY[
    '<§2.1 命令输出的第 1 条>',
    '<§2.1 命令输出的第 2 条>'
    -- ……逐条列出
  ]) AS n ORDER BY n;
  SELECT count(*) AS kysely_migration_rows FROM kysely_migration;
  ROLLBACK;
  ```
  也可以用 `node packages/core-backend/dist/src/db/migrate.js --confirm <名字>`（`migrate.ts:85-103`：退出码 0 已执行、1 待执行、2 不认识），但要带与升级脚本相同的环境。
- **通过：** 每条 `applied = t`；行数 = 421 + 新增条数。
- **不通过：** 不要重跑、不要手工补迁移，回帖列出 `applied = f` 的名字。
- **R60 的教训：** 开发机清单写的是 4 条（#6079 2026-09-28T09:01:43Z），旧机按名核对时 git 实际是 6 条，多出 `create_approval_template_groups` 和 `add_approval_product_permissions`（#6079 2026-09-28T10:34:09Z）。所以名单一律在打包提交上用命令现算。

---

## 3. 上机前只读检查

每项只返回布尔、计数、枚举或键名。psql 一律 `-X -A -v ON_ERROR_STOP=1`，语句包在 `BEGIN READ ONLY; … ROLLBACK;` 里。按下面的顺序做。

### C1 后端此刻在运行（最先做）

- **目的：** 升级脚本第 2 步会停后端。后端本来就没在运行时，停止这一步可能在会话里拉起一个默认 home 的 pm2 守护进程（#6079 2026-09-28T08:24:49Z）。另外，停服之后、变更窗口之前出错没人接住（见 C8）。
- **命令（PowerShell 5.1，只读）：** 这里不用 `pm2 list`：没有守护进程时，它会在本会话里拉起一个空守护进程（`handoff-r59-two-machine-20260924.md:50`）。
  ```powershell
  @(Get-ScheduledTask -TaskName 'MetaSheet-PM2' -ErrorAction SilentlyContinue | Where-Object TaskName -eq 'MetaSheet-PM2').Count
  (Get-ScheduledTask -TaskName 'MetaSheet-PM2').State
  @([System.IO.Directory]::GetFiles('\\.\pipe\', 'rpc.sock')).Count
  (Invoke-WebRequest -UseBasicParsing '<后端直连 health 地址>').StatusCode
  ```
  第三行按名字查 pm2 的命名管道：不枚举整个管道命名空间，不连接任何东西。写法同升级脚本的 `Test-Pm2DaemonPipePresent`（`:617-651`）。
- **通过：** `1`、`Running`、`1`、`200`。
- **不通过：** 停下，不升级。先查后端为什么没在运行（`handoff-r59-two-machine-20260924.md:50`），回帖四个值。

### C2 四张任务表与八个索引都不存在（仅当包里有任务迁移，即选项 A）

- **目的：** `zzzz20260926120000_create_task_p0a_tables` 用不带 `IF NOT EXISTS` 的 `CREATE TABLE`、`CREATE INDEX`。只要同名关系已存在，migrate 就失败。整批迁移在同一个事务里回滚（§2.1），升级脚本进处理器、停后端、打印 `RESTORE REQUIRED`（`:1972-1990`），站点要等恢复。
- **语句**（12 个名字取自该迁移 `:57`、`:97`、`:113`、`:124`、`:140-161`；`to_regclass` 按 `search_path` 解析，与迁移里不带 schema 的 `CREATE` 同口径）：
  ```sql
  BEGIN READ ONLY;
  SELECT n AS relname, to_regclass(n) IS NULL AS absent
  FROM unnest(ARRAY[
    'tasks', 'task_assignees', 'task_followers', 'task_events',
    'idx_tska_user', 'idx_tskf_user', 'idx_tsk_org_status', 'idx_tsk_creator',
    'idx_tsk_parent', 'idx_tsk_due', 'idx_tsk_due_date', 'idx_tske_task_time'
  ]) AS n ORDER BY n;
  SELECT count(*) AS task_migrations_recorded FROM kysely_migration
   WHERE name IN ('zzzz20260926120000_create_task_p0a_tables', 'zzzz20260926120100_add_task_permissions');
  ROLLBACK;
  ```
- **通过：** 12 行全是 `absent = t`，`task_migrations_recorded = 0`。
- **不通过：** 不开始升级。回帖写出哪些名字 `absent = f`（这些是本文列出的固定名字，不是客户数据）以及计数。不要删任何对象，由开发机和 owner 改选 §1 的选项或另定办法。

### C3 审计日志分区：上机当月与次月

- **目的：** `audit_logs` 按月分区，分区名为 `audit_logs_YYYY_MM`（`packages/core-backend/src/audit/AuditRepository.ts:635-636`）。后端只在插入失败之后补建**当月**分区（调用点 `:310`，实现 `:581-602`，按 SQLSTATE 判定，`:208`）。主动建当月与次月分区的钩子默认关闭，只有 `AUDIT_LOG_PARTITION_ENSURE` 为 `startup` 或 `daily` 时才开（`audit-partition-schedule.ts:9-15`）。R60 复核时 2026-09、2026-10 两个分区都在（#6079 2026-09-28T10:37:13Z）。
- **语句**（上机当天跑；`CURRENT_DATE` 取数据库服务器日期，与后端同口径）：
  ```sql
  BEGIN READ ONLY;
  SELECT
    to_regclass('audit_logs_' || to_char(date_trunc('month', CURRENT_DATE), 'YYYY_MM')) IS NOT NULL AS current_month_present,
    to_regclass('audit_logs_' || to_char(date_trunc('month', CURRENT_DATE) + interval '1 month', 'YYYY_MM')) IS NOT NULL AS next_month_present;
  ROLLBACK;
  ```
- **通过：** `t`、`t`。
- **不通过：** 不开始升级。回帖写出缺哪一个，并报 `app.env` 里有没有 `AUDIT_LOG_PARTITION_ENSURE` 这个键（只报有或无）。建分区是 DDL 写入，由开发机与 owner 决定怎么做。

### C4 演示机是否配置了交接链（「通知下一步」）

- **目的：** 交接链只有在环境变量 `INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH` 非空、且指向一个可读文件时才存在（`packages/core-backend/src/plugin-runtime-config.ts:9`、`:69-70`、`:176-188`）。没配时，状态读取回 `configured: false`（`plugins/plugin-integration-core/lib/http-routes.cjs:9185-9190`）；项目备料页收到这个应答就不渲染交接区块，也就没有「通知下一步」按钮（`apps/web/src/services/integration/stockPreparation/projectBoard.ts:169-171`，视图 `StockPreparationProjectBoardView.vue:347`）。§6 里「通知下一步」的回归行只在已配置时才适用。
- **命令一（只报键是否存在）：**
  ```powershell
  $k = 'INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH'
  $hits = @(Get-Content -LiteralPath '<app.env 路径>' -Encoding UTF8 | Where-Object { $_.Trim() -match ('^' + $k + '\s*=') })
  'handoff_key_lines=' + $hits.Count
  'handoff_key_nonempty_lines=' + @($hits | Where-Object { ($_.Trim() -split '=', 2)[1].Trim().Length -gt 0 }).Count
  'machine_env_present=' + [bool][Environment]::GetEnvironmentVariable($k, 'Machine')
  'user_env_present=' + [bool][Environment]::GetEnvironmentVariable($k, 'User')
  ```
- **命令二（可选，owner 以管理员登录，在浏览器 Network 面板看）：** `GET /api/integration/stock-preparation/handoff?projectNo=<项目号>`（路由 `http-routes.cjs:207`，处理函数 `:9138`），只报响应里的 `configured`（布尔）。不要借用定时试拉的服务令牌（#6079 2026-09-28T02:03:25Z）。
- **结果怎么用：** 两种结果都是有效答案，回帖即可。`handoff_key_nonempty_lines = 0` 且机器级、用户级都没有 = 未配置；此时 R61 前后项目备料页都没有「通知下一步」，C5 只对结转与导出有意义。

### C5 目标表归属（「通知下一步」、结转、物料导出）

- **目的：** 结转与物料导出在 R60 已经过这道墙（导出那一路是 #6109 加的，在 R60 包内；PR #6140 正文：三条路由用同一道墙）。R61 起「通知下一步」也先过这道墙（#6140，MERGED，`03202a1e9`；`http-routes.cjs:828-856`）。墙放行有两种情况：绑定的表在归属登记表里登记在本租户名下；或者表 id 正是按本租户派生出的 id（`stock-preparation-target-provisioning.cjs:1205-1220`）。
- **语句**：下面的主体直接取自已合入 PR #6140 正文「上机说明」一节，最后一行派生 id 核对是本文按 `http-routes.cjs:849-852` 与 `packages/core-backend/src/multitable/provisioning.ts:191-201` 补上的。变量值在旧机本地从部署配置里读：`sheet_id` 与 `object_id` 取拉取动作 `plm.stock-preparation.pull-bom.v1` 的 `target.sheetId` 与 `target.objectId`（表动作 JSON 所在的环境变量见 `plugin-runtime-config.ts:2-3`）；`tenant` 对「通知下一步」取交接链配置文件里的 `tenantId`，对结转与导出取操作员所属租户。值只经 `-v` 传入，不回帖。
  ```sql
  -- psql -X -q -A -v sheet_id=... -v chain_tenant=... -v object_id=... -f check.sql
  BEGIN READ ONLY;
  SELECT
    EXISTS (SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = :'sheet_id' AND project_id = :'chain_tenant' || ':integration-core') AS wall_passes_via_registry,
    EXISTS (SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = :'sheet_id')                                                         AS registered_anywhere,
    (SELECT count(DISTINCT project_id) FROM plugin_multitable_object_registry WHERE sheet_id = :'sheet_id')                                       AS distinct_owner_projects,
    EXISTS (SELECT 1 FROM meta_sheets WHERE id = :'sheet_id' AND deleted_at IS NULL)                                                              AS bound_sheet_active;
  -- 本文补充：派生 id 核对（需要 pgcrypto；先 SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'，1 = 有）
  SELECT :'sheet_id' = 'sheet_' || left(encode(digest(:'chain_tenant' || ':integration-core:' || :'object_id', 'sha1'), 'hex'), 24) AS bound_sheet_is_derived_id;
  ROLLBACK;
  ```
- **通过：** `wall_passes_via_registry = t`，或者 `bound_sheet_is_derived_id = t`；另外 `bound_sheet_active = t`。
- **不通过时，R61 之后客户会看到：**
  - 当前处理人点「通知下一步」，得到 409 `STOCK_PREPARATION_HANDOFF_TARGET_TENANT_MISMATCH`，页面显示「这台系统绑定的备料主表不属于您的工厂,为保护数据没有通知下一步;交接没有发生,备料数据也没有变化。」；或者得到 `STOCK_PREPARATION_HANDOFF_TARGET_OWNER_UNKNOWN`，显示「系统没法确认这台系统绑定的备料主表属于哪家工厂……」（`apps/web/src/services/integration/stockPreparation/plainLanguage.ts:717-728`）。
  - 结转与导出照 R60 同样被拒。
  - 「看看还缺什么」预检报 `STOCK_PREP_CARRY_TARGET_NOT_OWNED`，并多出 `detail.handoffRouteCode`（`stock-preparation-preflight.cjs:699-704`）。
  - 这等于把 R60 上「每次都 400」的按钮换成「每次都 409、换一句话」。
- **不通过时怎么办：** 回帖上面的布尔与计数。PR #6140 的修法是「重跑 sandbox target ensure」，这是写操作，先回帖，由开发机与 owner 决定。

### C6 加密存储普查（R60 第一次写入密钥之后）

- **目的：** R60 之前 `app.env` 里没有 `ENCRYPTION_KEY`、`ENCRYPTION_SALT`，旧代码退回到仓库内置默认值；R60 第一次写入了新的密钥（#6079 2026-09-28T02:03:25Z、10:34:09Z）。凡是 R60 之前用 `enc:` 格式（`packages/core-backend/src/security/encrypted-secrets.ts:10`、`:204-205`、`:236-242`）封存的值，现在都解不开。PLM 连接已知是这种情况（10:37:13Z）。
- **范围**：`git grep -l encrypted-secrets origin/main -- packages/core-backend/src plugins` 列出的每个存储，逐个看代码后得到：
  | 存储 | 位置 | 依据 |
  |---|---|---|
  | 数据源凭据 | `data_sources.config->'credentials'` 的 `password`、`apiKey`、`token` | `DataSourceManager.ts:25`、`:374-405` |
  | 钉钉目录集成 | `directory_integrations.config` 的 `appSecret`、`workNotificationAgentId`（旧名 `agentId`） | `directory/directory-sync.ts:1800-1806`、`:2436-2440`；`integrations/dingtalk/work-notification-settings.ts:114-118`、`:373-384`；`services/elearning-notification-dingtalk.ts:112-115` 读同一处 |
  | 审批卡片链接密钥 | `directory_integrations.config` 的 `approvalCardLinkSecret` | `integrations/dingtalk/approval-card-config.ts:66-80`、`:210-226` |
  | 钉钉群机器人 | `dingtalk_group_destinations.webhook_url`、`secret` | `multitable/dingtalk-group-destinations.ts:1-31` |
  | 外部系统凭据（经插件运行时安全服务） | `integration_external_systems.credentials_encrypted`：新写入为 `enc:`，旧格式为 `v1:` | `security/plugin-runtime-security-service.ts:190-198`；注入点 `index.ts:3327`；`plugins/plugin-integration-core/lib/credential-store.cjs:20-22`、`:149-176`；`lib/external-systems.cjs:363-420` |
  | 考勤集成 | `attendance_integrations.config` 的 `appSecret` | `plugins/plugin-attendance/index.cjs:6088`、`:6106-6160`、`:6219-6226` |
  | 系统配置 | `system_configs` 中 `is_encrypted` 为真的行 | `services/ConfigService.ts:407-415`、`:474-478` |

  以下几项不在本普查里：`integrations/dingtalk/todo-operator-config.ts` 明文存储（`:4-7`）；`plugins/plugin-integration-core/SPIKE_NOTES.md` 是文档；`plugin/PluginConfigManager.ts` 用它自己的密钥（`:117-128`、`:814-831`），不经过 `encrypted-secrets`。
- **语句（只出计数）：**
  ```sql
  BEGIN READ ONLY;
  SELECT 'data_sources.password' AS stored_value, count(*) AS enc_count FROM data_sources WHERE is_active AND deleted_at IS NULL AND config->'credentials'->>'password' LIKE 'enc:%'
  UNION ALL SELECT 'data_sources.apiKey', count(*) FROM data_sources WHERE is_active AND deleted_at IS NULL AND config->'credentials'->>'apiKey' LIKE 'enc:%'
  UNION ALL SELECT 'data_sources.token', count(*) FROM data_sources WHERE is_active AND deleted_at IS NULL AND config->'credentials'->>'token' LIKE 'enc:%'
  UNION ALL SELECT 'directory_integrations.appSecret', count(*) FROM directory_integrations WHERE config->>'appSecret' LIKE 'enc:%'
  UNION ALL SELECT 'directory_integrations.workNotificationAgentId', count(*) FROM directory_integrations WHERE config->>'workNotificationAgentId' LIKE 'enc:%'
  UNION ALL SELECT 'directory_integrations.agentId', count(*) FROM directory_integrations WHERE config->>'agentId' LIKE 'enc:%'
  UNION ALL SELECT 'directory_integrations.approvalCardLinkSecret', count(*) FROM directory_integrations WHERE config->>'approvalCardLinkSecret' LIKE 'enc:%'
  UNION ALL SELECT 'dingtalk_group_destinations.webhook_url', count(*) FROM dingtalk_group_destinations WHERE webhook_url LIKE 'enc:%'
  UNION ALL SELECT 'dingtalk_group_destinations.secret', count(*) FROM dingtalk_group_destinations WHERE secret LIKE 'enc:%'
  UNION ALL SELECT 'integration_external_systems.enc', count(*) FROM integration_external_systems WHERE credentials_encrypted LIKE 'enc:%'
  UNION ALL SELECT 'integration_external_systems.v1', count(*) FROM integration_external_systems WHERE credentials_encrypted LIKE 'v1:%'
  UNION ALL SELECT 'attendance_integrations.appSecret', count(*) FROM attendance_integrations WHERE config->>'appSecret' LIKE 'enc:%'
  UNION ALL SELECT 'system_configs.is_encrypted', count(*) FROM system_configs WHERE is_encrypted;
  ROLLBACK;
  ```
  `v1:` 用的是另一把密钥 `INTEGRATION_ENCRYPTION_KEY`（`credential-store.cjs:32`、`:62-78`），不受 R60 写入 `ENCRYPTION_KEY` 的影响。有 `v1:` 行时，另报 `app.env` 里有没有这个键（只报有或无）。
- **日志计数**：用 R60 复核时读过的同一份后端日志，只数 R60 重启之后的部分（切分方法同 #6079 2026-09-28T10:37:13Z 的 §4.6 日志检查），分别报下面四个固定串各自的行数，不贴行内容：
  - `Unsupported state or unable to authenticate data`：Node 的 GCM 鉴权失败，10:37:13Z 回帖里见过；
  - `Failed to decrypt credential`（`DataSourceManager.ts:402`）；
  - `has unreadable credentials (decrypt failed)`（`dingtalk-group-destination-service.ts:70`）；
  - `Decryption failed:`（`ConfigService.ts:469`）。
- **为什么启动日志看不出来：** 启动时逐行解密的只有数据源管理器，解不开就记进「Loaded … (N skipped)」（`DataSourceManager.ts:320-358`）；其余各处都是用到时才解密，所以 R60 启动日志里的「1 skipped」只说明数据源这一家。其余存储里用旧默认密钥封存的值，要等第一次被用到时才失败；其中审批卡片链接密钥解不开时直接当作未配置，不写日志（`approval-card-config.ts:76-79`、`:105-108`）。
- **通过：** 除 `data_sources.password` 外（R60 启动日志「Loaded 0 … (1 skipped)」，即只有 1 条在用的数据源且解不开，10:37:13Z），其余计数都为 0。日志里 `has unreadable credentials (decrypt failed)` 与 `Decryption failed:` 为 0；`Unsupported state or unable to authenticate data` 的行数等于 `Failed to decrypt credential` 的行数。数据源装载失败时，这两串出现在同一行（`DataSourceManager.ts:353` 打印错误，`:402` 把原错误信息接在后面），每次后端启动各记一次。
- **不通过：** 回帖各项计数。计数不为 0 不等于解不开：R60 之后写入的值是用新密钥封存的，也带 `enc:`。由开发机按存储逐一判断并给出处理办法，不要自行改库。

### C7 `app.env` 重复键（卫生项）

- **定位：** 这是卫生项，不是已知的 R61 阻断项。按下面的检索，仓库里没有任何 Windows 脚本或工作流调用 `multitable-onprem-preflight.sh`，调用它的只有 Linux 与打包侧脚本：
  ```text
  $ git grep -n multitable-onprem-preflight origin/main -- '*.ps1' '*.bat' '*.cmd' '.github/workflows/*.yml'
  （无输出）
  $ git grep -l multitable-onprem-preflight origin/main -- ':!docs' ':!*.md'
  scripts/ops/multitable-onprem-delivery-bundle.mjs
  scripts/ops/multitable-onprem-preflight.sh
  scripts/ops/multitable-onprem-release-gate.sh
  scripts/ops/multitable-pilot-handoff.mjs
  scripts/ops/multitable-pilot-handoff.test.mjs
  scripts/ops/multitable-pilot-release-bound.sh
  scripts/ops/multitable-pilot-release-bound.test.mjs
  ```
  旧机的 wrapper 不在仓库里，它是否调用这个预检脚本，本文不知道（§7）。
- **为什么重复键仍然值得查：** 不同启动路径对重复键取值不一致。后端经 `ecosystem.config.cjs` 读 `app.env` 时取**第一次**出现的那行，而且不覆盖进程里已有的同名变量（`ecosystem.config.cjs:42`）。升级脚本的 `Import-AppEnvFile` 逐行覆盖，所以取**最后一次**（`:1367-1391`），随后 `pm2 restart --update-env`。R60 实际走的是计划任务回退拉起（#6079 2026-09-28T10:34:09Z）。
- **命令（PowerShell 5.1，只出键名与次数）：** 这是 #6079 2026-09-28T13:52:05Z 那段脚本，本文加了一道过滤：只打印全大写、形如环境变量名的键，其余只计数。原因是一行被折开的密文可能以 `=` 结尾，原脚本会把它的前半段当成键名打印出来（开发机用合成文件复现过）。
  ```powershell
  $lines = Get-Content -LiteralPath '<app.env 路径>' -Encoding UTF8
  $keys = @(foreach ($l in $lines) { $t = $l.Trim(); if ($t -eq '' -or $t.StartsWith('#')) { continue }; $i = $t.IndexOf('='); if ($i -le 0) { continue }; $t.Substring(0, $i).Trim() })
  $ident = @($keys | Where-Object { $_ -cmatch '^[A-Z][A-Z0-9_]*$' })
  'non_identifier_lines=' + ($keys.Count - $ident.Count)
  $ident | Group-Object | Where-Object Count -gt 1 | Select-Object Name, Count
  ```
  打出来的键名若不认识，先不要照抄进回帖，改报「不认识的键名 N 个」。全大写的折行密文仍可能漏过这道过滤。
- **处置规则**（照抄 #6079 2026-09-28T14:02:47Z 的订正版；13:52:05Z 的「保留第一次」已作废）：
  - 无输出：无重复，什么都不用做。
  - 某键重复、其中一行值为空：删掉**空值**那一行（两种取值规则下都安全）。
  - 某键重复、各行值相同：删掉任意一行。
  - `ENCRYPTION_KEY` 或 `ENCRYPTION_SALT` 出现两行且值不同：**两行都先别删**，先回帖（只报「两行、值不同」），由开发机协助判定哪一对在用。已加密落库的值只能用当初加密它们的那对密钥解开。
  - 其它键重复且值不同：先回帖键名，不要自行删。
- **给旧机的两个问题：** R61 的 wrapper 调不调用 `scripts/ops/multitable-onprem-preflight.sh`？wrapper 自己的重复键检查覆盖所有键，还是只查密钥键？如果覆盖所有键，这次普查在 R60 上机时实际上已经做过。

### C8 升级脚本「停服之后、变更窗口之前」的缺口：说明与手工恢复

- **缺口（`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1`）：**
  - 第 2 步先挂维护标志（`:1826`），探一次网关（`:1834`），然后停后端（`:1836`）。第 3 步备份（`:1839`）。
  - 直到第 4 步才进入内层 `try`（`:1853`）。唯一会「停 pm2 + 打印 RESTORE 块」的处理器是这个内层 `try` 的 `catch`（`:1972-1990`）。
  - 所以 `:1836` 之后、`:1853` 之前（也就是备份这一步）一旦抛错，只会走外层 `finally`（`:1992-1998`）：删掉维护标志，再把错误抛出去。后端已经停了，没人重启它，也不打印恢复块。
  - 这时还没替换任何文件，也没跑迁移，现网代码与库结构都还是 R60。
- **手工恢复**（与 `handoff-r59-two-machine-20260924.md` §2「向前修复」同一条路，`:29-31`、`:41`）：
  1. 确认升级脚本已经退出。
  2. 查管道（C1 第三行）。仍为 `1`：在设了 `$env:PM2_HOME` 的会话里 `pm2 kill`，再查，直到为 `0`（为什么先 kill，见同文 `:39`）。
  3. `Start-ScheduledTask -TaskName 'MetaSheet-PM2' -TaskPath '<任务所在文件夹>'`。
  4. C1 第四行 health 应为 `200`。
  5. 维护标志正常情况下已被 `finally` 删掉。只有升级进程被杀、`finally` 没跑到时，才手工删 `<部署根目录>\output\maintenance.flag`（默认位置见 `:164-172`）。
  6. 回帖，查清备份失败的原因后再重试。
- **修复计划：** 开发机已排期修这个缺口，截至本文还没开 PR（在开 PR 里改到 `scripts/ops/` 上机脚本的只有 #6138，改的是预检脚本）。**如果该修复在打包点之前合入**，R61 跑的就不再是 R60 验证过的那份脚本：旧机必须用新版替换本地那份升级脚本副本，重跑本地门禁（R60 的门禁见 #6079 2026-09-28T10:34:09Z：字节、BOM、预检自测、sha256/gitSha），然后才能上机。

---

## 4. 开关

`git diff 583dfdf1a origin/main -- scripts/ops/global-history-flag-manifest.mjs` 只有新增，没有改动。另外扫了新增代码行里的 `env.X` 读取，结果与这三项一致，没有未登记的：

| 键 | 清单位置 | 默认 | 打开之后会暴露什么 |
|---|---|---|---|
| `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` | `:62` | 关；只认精确的 `'true'`（`packages/core-backend/src/multitable/field-retype-convert.ts:26-28`） | 只读预览端点 `POST /fields/:fieldId/retype-preview` 可用（第 2 刀）。执行、撤销端点要等 #6149 合入才有；有了之后「执行」会改写一整列在用数据（清单标 danger=high）。没有界面。 |
| `MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS` | `:656` | 未设 = 2000；上限 50000（`copy-sheet-limits.ts:17-33`） | 不是开关，是同步复制的行数上限。调大会拉长一个同时持有源表行锁和全部参与表围栏的事务。 |
| `TASKS_ENABLED` | `:667` | 关；只认精确的 `'true'`（`routes/tasks.ts:35-36`） | 挂载 `/api/tasks` 路由，草案任务功能对持 `tasks:*` 的账号（含平台管理员）可达。选项 B 下任务表不存在，打开就会出错。 |

**R61 不改演示机上的任何开关。** 这三个键都不需要设，保持默认。

---

## 5. R61 之后客户会看到什么（按选项）

**A、B、C 都有：**

- **复制数据表入口：**
  - 入口①：表侧栏「复制数据表」，只出现在当前选中的那张表的行上（`apps/web/src/multitable/components/MetaSheetViewRail.vue:114-120`）。
  - 入口②：「存为模板」弹窗里的「改为复制数据表（含数据）」（`apps/web/src/multitable/views/MultitableWorkbench.vue:192`）。
  - 两处都只在 `/context` 返回 `canCopySheet === true` 时出现。`canCopySheet` = 目标 Base 可写 **且** 对源表有全表读（`packages/core-backend/src/routes/univer-meta.ts:9250-9268`）。目标 Base 可写是指：平台管理员角色，或 `resolveBaseWritable`（Base 属主或持 Base 写权限码，`permission-service.ts:2019-2020`、`:2032-2059`）。审批投影与 e-learning 投影 Base 对谁都不可写（`:2041`）。
  - 复制出的表带徽标「快照副本」；源为托管表时再加「不随 PLM 刷新」（`meta-sheet-view-rail-labels.ts:32`、`:37`）。
  - 复制没有开关（§4）。
  - 以上是读代码得出的，没有实际运行（§8）。
- **项目备料页「通知下一步」：**
  - C4 未配置：R61 前后都没有这个按钮。
  - 已配置、C5 通过：当前处理人按下后请求第一次能到达服务器。R60 上是每按必 400，见 PR #6142 正文。
  - 已配置、C5 不通过：见 C5 的拒绝文案。
  - #6146（`cd89c74dd`）修了三类看板缺陷：消息没发出去却说已交接、最后一步按不了、欠发的群通知补发不了（回归见 §6.2）。打包点不含 `cd89c74dd` 时，这三类缺陷仍在。
- **结转、物料导出：** 墙在 R60 已经上线（#6109）。R61 只在预检里多给一个 `detail.handoffRouteCode`。
- **字段类型转换：** 无变化（开关关、无界面）。

**只有 A、B 有：**

- **「任务」导航入口：**
  - 在默认导航外壳里，有 `tasks:read` 的账号会看到「任务」入口和待办角标（`apps/web/src/App.vue:53-62`、`:199-202`）。平台管理员总是满足（`useAuth.ts:551-552`）。普通账号只要没有被授予该权限码就看不到，迁移不写 `role_permissions`（`zzzz20260926120100_add_task_permissions.ts:1-3`）。
  - `TASKS_ENABLED` 未设时：角标显示「!」（`apps/web/src/tasks/TasksTodoBadge.vue:41`；读取非 2xx 即判为不可用，`useTasksBadge.ts:9`）；页面显示「任务功能未启用或当前服务不支持」（`apps/web/src/views/tasks/TasksView.vue:189-192`；上下文读取 404 即判为不可用，`tasksContext.ts:50`）。
  - 考勤专注外壳与 PLM 工作台外壳里没有这个入口（`App.vue:8`、`:11-39`）。演示机用哪种外壳由产品模式决定（`apps/web/src/stores/featureFlags.ts:494-500`），本文不知道，列为 §7 的问题。
  - 选项 B 下这个入口同样存在（前端与迁移无关）。
- **审批「审批表单」页**（`/approval-templates`，`apps/web/src/router/appRoutes.ts:406-409`，只要求登录）：#5878 改了该页的模板分组界面（`TemplateCenterView.vue`、`TemplateGroupSections.vue`、`ApprovalTemplateGroupsPanel.vue`）和 `routes/approvals.ts` 的接口；切在 `6cddab3e5` 或之后（含 `cd89c74dd`）时还包括 #5927。#5927 另外改了 `SessionOrgSwitcher.vue`（只被审批模板分组面板使用），并在 `authPrincipal.ts` 里新增导出。具体控件是什么、谁能看到，本文没有逐项核对（§8）。

**只有 C 没有：** 上面两项。

---

## 6. 上机后验收与回归

### 6.1 复制数据表 S1 验收

按 `copy-sheet-r61-acceptance-checklist.md` 执行，回帖格式见该文 §7。复制演示时源表保持 ≤ 2000 行；复制同一张表或其关联表期间不要手动触发 PLM 刷新（该文 §5）。

**需 owner 放行：**

- 该文 §4 第 3 项（`:85`）要在复制进行中改动源表的一条记录，而它的源表是客户的备料主表（`:29`、`:42`），这是对客户演示数据的写入。
- 该文 §1 要三个测试身份（`:29`），§2.2 还要一个受限账号和一个 write-own 账号（`:58-59`）。这些身份在演示机上是否已经存在不知道，新建账号或授权也是服务器写入。
- #6079 正文「不做」：不在未经批准的情况下写客户演示表的数据。

**替代做法（不需要改客户数据）：** §4 第 3 项改用一张临时表当源：在测试 Base 里新建一张非托管表，放若干行，复制它，复制期间编辑这张临时表的一条记录，预期 409 `COPY_SOURCE_CHANGED` 并整体回滚。其余步骤不变。这样不改客户的备料主表。三个身份的问题仍需 owner 决定：用已有账号，还是新建。

### 6.2 R60 之后已合入、客户能看到的修复：每条一行回归

每行只在打包点含该提交时适用（先后顺序见 §1.1）。

| PR（`gh` 现状） | 回归 |
|---|---|
| #6116、#6112（MERGED；`8a6746428`、`0185b00a5`） | 见 §6.1。 |
| #6136（MERGED 2026-09-28T14:27:17Z，`5ac5b3ed1`） | 迁移按名核对通过后，复制（含数据）应成功。若提示「复制暂不可用：服务器需要先完成数据库升级，请联系管理员。」（503 `COPY_TEMPORARILY_UNAVAILABLE`，`meta-copy-sheet-labels.ts:160-163`；`copy-sheet-service.ts:1189-1190`、`:1234-1237`），说明账本迁移没生效；此时零写入，回到 §2.4。 |
| #6142（MERGED 2026-09-28T16:37:34Z，`5e97c7116`）+ #6143（MERGED 2026-09-28T17:50:06Z，`33047ef94`，仅测试） | 前提是 C4 已配置、C5 通过。当前处理人在项目备料页按「通知下一步」，不再回 400 `STOCK_PREPARATION_HANDOFF_REQUEST_INVALID`，页面给出一句结果。服务器回 409 `STOCK_PREPARATION_HANDOFF_STEP_MISMATCH` 时，页面重读「轮到谁」并显示该拒绝的专门说明，不显示通用的「过一会儿再点一次」（#6143 钉住的两条分支）。回帖：状态码 + 是否显示了结果句（布尔）。 |
| #6140（MERGED 2026-09-28T16:51:44Z，`03202a1e9`） | 正确配置的部署行为不变。C5 不通过的部署上，「通知下一步」回 409（`…_TARGET_TENANT_MISMATCH` 或 `…_TARGET_OWNER_UNKNOWN`；宿主缺端口时回 501 `…_PROVISIONING_UNAVAILABLE`），页面显示专门说明，不邀请重试（`plainLanguage.ts:717-734`）。回帖：实际拒绝码与 C5 的布尔是否一致。 |
| #6146（MERGED 2026-09-28T23:10:28Z，`cd89c74dd`） | 前提同 #6142 行（C4 已配置、C5 通过）。① 当前处理人持有最后一步时，按钮是「通知仓库和采购」，可以按，「下一步」条里的按钮同词（`apps/web/src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue:1053-1067`，词取自 `apps/web/src/services/integration/stockPreparation/operatorNextStep.ts:54-57`，「下一步」条经视图 `:1101` 与 `operatorNextStep.ts:135-140` 用同一个词）。② 交接成功但群消息没发出去时，页面说「已经交给下一步了,但群里的消息没有发出去 —— 请您自己跟下一位说一声。」，并说明交接本身已成功、不用再点；只发出去一部分群时，说「……有一个群没发出去 —— 请您自己跟对方说一声。」（`plainLanguage.ts:1886-1897`）。③ 欠着上一跳群通知的人，可以在看板上按「通知下一步(补发上一步的群消息)」补发（`StockPreparationProjectBoardView.vue:1061-1064`；谁能按与确认队列同一规则，`confirmationQueue.ts:621-627`）。另：项目选择器里本机记住的项目写作「这台电脑最近开过的项目」（`StockPreparationProjectBoardView.vue:130`）。回帖：①②③ 各自是否符合（布尔）。 |
| #6139（MERGED 2026-09-28T17:47:15Z，`68578b56f`） | 客户看不到任何变化（开关默认关、无界面）。字段设置里把文本改成单选，仍是原来的 400 `FIELD_RETYPE_NOT_LOSSLESS`（`scripts/ops/global-history-flag-manifest.mjs:61-79` 该条目所述）。不需要回归。 |
| 仅选项 A、B：#6062、#6092、#6123、#5878，以及切在 `6cddab3e5` 或之后时的 #5927 | 不是客户修复，但会被看到：「任务」入口与「!」角标（§5）；「审批表单」页改动。回帖：演示机外壳（枚举）、管理员账号是否看到「任务」入口（布尔）。 |

### 6.3 合入后才适用（只在该 PR 进了打包提交时适用）

| PR（`gh` 现状） | 适用时的上机动作或回归 |
|---|---|
| #6151（OPEN，draft；带两项待 owner 确认的决定，核验中） | 「数据来源与体检」的「检查这个源」不再对所有人回 409，改为只从已验证令牌的租户声明取租户：带声明且能读该源的账号得到报告，令牌不带租户声明的账号得到 403 `TENANT_CLAIM_REQUIRED`（该 PR 正文的主体表与「上机说明」）。先看 §7 的「普通账号登录令牌是否带租户声明」。 |
| #6144（OPEN） | 数据源页出现「无法装载」分组。属主或平台管理员在「重新输入凭据」里原地重封，属主、租户、作用域、连接、选项都不变，无需重启。之后 #6079 2026-09-28T12:51:17Z 的「新建同 id 覆盖原行」绕行会回 409，不要再用（见该 PR 正文「上机说明」）。前提：客户 DBA 已轮换 PLM 只读口令（owner 口径，#6079 2026-09-28T02:03:25Z 第 3 步），新口令只由属主在界面输入。 |
| #6138（OPEN，draft） | 只改 `scripts/ops/multitable-onprem-preflight.sh`：任何重复键都判 FAIL。只有旧机 R61 wrapper 调用这个脚本时才相关（C7）。 |
| #6145（OPEN，draft） | 开关不是精确的 `'true'` 时零变化（见该 PR 正文）。不需要回归。 |
| #6149（OPEN，draft） | 端点在开关后面，也没有界面；但它带 3 条迁移（§2.3），迁移不受开关控制，其中 `…150200_backfill_approval_projection_system_kind` 对 `meta_sheets` 做 UPDATE。按 §2.4 按名核对。 |
| #6147（OPEN，draft） | 两个配置恢复开关默认关，无可见变化。它改的是共享函数 `hasFullTableReadAccess`，复制入口的 `canCopySheet` 也调用它（`univer-meta.ts:9261`）：对不能读该表的账号只会更早返回 false。 |

---

## 7. 旧机侧状态未知的事项

2026-09-29 约 00:25Z 查 #6079：共 24 条评论，最后一条是 2026-09-28T14:02:47Z。之后旧机没有回帖，下列状态都没有更新。

| 事项 | 怎样算结清 |
|---|---|
| PLM 连接「新建同 id」绕行前的只读预检（12:51:17Z） | 旧机回帖预检的布尔、枚举、键名。先绕行还是等 R61（#6144）由 owner 定；#6144 进 R61 的话，绕行在 R61 后回 409。 |
| 客户 DBA 是否已轮换 PLM 只读口令 | owner 确认。 |
| 混表清理 2b（11:56:06Z 已定：保留与表名后缀一致的项目，另一项目的行置为无效） | 旧机回帖计数与状态词。执行前先只读计数该表上启用的自动化规则，按触发类型分组：`SELECT trigger_type, count(*) FROM automation_rules WHERE sheet_id = :'sid' AND enabled IS TRUE GROUP BY 1 ORDER BY 1;`（列名见 `zzzz20260413120000_create_automation_rules.ts:27-33`）。回帖还要写明走的是界面还是 SQL：行修订由应用写（`multitable/record-history-service.ts`），`meta_records` 上没有写修订的触发器，所以直接 SQL `UPDATE` 不会留下 06:39:16Z 回滚说明所依赖的行修订。 |
| BOM 层级 0 根选择规则的客户预设是否已配 | 旧机只报拉取动作 `plm.stock-preparation.pull-bom.v1` 的配置里有没有 `rootSelection` 块（布尔）。客户对该规则尚未确认（`customer-anomaly-triage-20260918.md:9`「规则待确认」）；在演示机加配置并重启由 owner 定，重启方式见 `stock-prep-root-selection-config.md`。 |
| R60 之后客户反馈各项修复的界面逐项回归 | 旧机或 owner 逐项回帖通过或不通过。 |
| 确认账本表头改中文（2c） | owner 在旧机亲自执行后回帖计数。 |
| R60 收口：定时试拉 200 ready、非属主操作员 dry-run 通过 | PLM 连接恢复后，旧机回帖四项结果（12:51:17Z「绕行后的核对」）。 |
| 备料预检 `checks.carryTargetBinding.ownershipState` | owner 以管理员登录后在浏览器读（10:37:13Z 只定位了端点，没有调用）。现在还决定 C5 与 §6.2 的 #6142 行。 |
| R60 wrapper 细节：pm2 命令解析到的路径、日志首段 `pm2 home:` 那一行、是否传了 `-Pm2Home` | 旧机在 R61 预检笔记里补上（10:34:09Z 回帖里没有）。 |
| `app.env` 重复键普查（13:52:05Z 请求） | 旧机回帖 C7 的输出，并回答 C7 末尾的两个问题。 |
| 演示机是否配置了交接链 | C4。 |
| 加密存储普查 | C6。 |
| 演示机的产品模式（决定「任务」入口出不出现） | 旧机报一个枚举（默认、考勤专注、PLM 工作台）。 |
| 复制验收要用的测试身份是否存在 | 旧机报三个身份各自是否存在（布尔）。新建需要 owner 放行（§6.1）。 |
| 上机当月是十月时的次月审计分区 | C3。R60 时 2026-09、2026-10 两个分区都在（10:37:13Z）。 |
| 普通账号的登录令牌是否带租户声明 `tenantId` | 旧机回报一个布尔。登录时只有两种情况会写入这项声明：账号恰好有一条启用的 `user_orgs` 成员关系，或登录时点名了一个自己所属的组织（`packages/core-backend/src/auth/AuthService.ts:309`、`:359-360`、`:387-421`）。所以不看任何令牌，用库里的计数就能判断：`SELECT CASE WHEN n = 0 THEN '0' WHEN n = 1 THEN '1' ELSE '2+' END AS active_memberships, count(*) AS active_users FROM (SELECT (SELECT count(*) FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active) AS n FROM users u WHERE u.is_active) t GROUP BY 1 ORDER BY 1;`（只读事务，只出计数）。「0」或「2+」的账号，按上面的规则登录令牌不带这项声明。#6151 若进包，这些账号在「检查这个源」上得到 403 `TENANT_CLAIM_REQUIRED`。PR #6140 正文把「无租户声明」称为演示机形态，但没有给出处。任何令牌都不贴出来。 |

---

## 8. 本文未证实的说法

- **Kysely 的排序与单事务：** 读的是公开发布的 kysely 0.28.8 源码（`dist/cjs/migration/migrator.js`、`dist/cjs/dialect/postgres/postgres-adapter.js`），版本取自 `pnpm-lock.yaml:3222`。演示机包里实际装的版本没有核对。
- **421 → 425（或 423）：** 421 来自 #6079 2026-09-28T10:37:13Z。终值取决于打包点、是否排除任务迁移，以及打包前有没有别的迁移合入。
- **复制入口谁能看到：** 读了门控代码（`univer-meta.ts:9250-9268`、`permission-service.ts:2032-2059`），没有实际运行。
- **「任务」入口只在默认外壳出现：** 读了 `App.vue`。演示机用哪种外壳不知道。
- **审批「审批表单」页的改动：** 只确认了改动文件，没有核对具体控件和可见人群。
- **G14 真库用例：** #6112 正文说当年的红是测试夹具问题，已拆成 G14a、G14b。main `68578b56f` 的 Plugin System Tests 里，test (20.x)「Run multitable real-DB integration」这一步成功，宿主文件 `multitable-conditional-rule-enforce-realdb.test.ts` 32 例通过。CI 该步只输出到文件级，没有逐例核对 G14a、G14b 的名字。
- **选项 C 的可行性：** 只做了文本合并模拟。没有构建，没有跑 CI，也没有算出发布分支上 `s6a-package-provenance-pins.json` 是否自洽。
- **pm2 在演示机上的行为**（pm2-runtime 无在线应用约 8–11 秒自退、命名管道对所有 home 通用）：来自 `handoff-r59-two-machine-20260924.md:34`、`:39` 在开发机上的实测。该文自己写明演示机上的 pm2 版本没有核对。
- **C6 的推断**（「R60 之前封存的 `enc:` 值现在都解不开」）：来自 #6079 2026-09-28T02:03:25Z 对密钥历史的叙述，加上 `encrypted-secrets.ts` 的代码，没有按存储逐条实测。计数只是可能受影响的值的上限。
- **C6 的日志切分方法与日志文件位置：** 沿用旧机 R60 复核的做法。pm2-runtime 主机上后端日志是否写到 `ecosystem.config.cjs:71-72` 配置的文件，没有核对。
- **根选择订正里「演示机不用 `pm2 restart`」：** 依据是交接文档对托管方式的描述。在运行中的 pm2-runtime 上执行 `pm2 restart --update-env` 能否读到 `app.env` 的改动，没有核对，订正也不依赖这一点。
- **#6146 的三条回归：** 读的是 `cd89c74dd` 上的界面代码与该 PR 正文，没有在浏览器里看过。
- **#6144 会进 R61：** `gh` 显示它是 OPEN。合入前的核验是否已经完成，本文没有核对，不能当作事实。

---

## 参考

- 上机手册：`handoff-r59-two-machine-20260924.md` §2–§3。
- 复制数据表验收：`copy-sheet-r61-acceptance-checklist.md`。
- 上机沟通：issue #6079（本文引用的评论：2026-09-28T02:03:25Z、06:39:16Z、08:24:49Z、09:01:43Z、10:34:09Z、10:37:13Z、11:56:06Z、12:51:17Z、13:52:05Z、14:02:47Z）。
- 决策登记：`decision-register.md` R-18、R-19、R-20。
