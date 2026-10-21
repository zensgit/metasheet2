# R61 上机清单（打包点 `bf648922a`，已由 owner 决定；部署仍待 owner 放行）

> **决定：** owner 2026-09-29（约 03:45Z，开发机窗口）决定：R61 = main 原样打包，打包点是 main 上含 #6144 与 #6162 两支的 first-parent 提交；#6157、#6151 不进 R61，放下一版；任务线两条迁移随包执行，所以 C2 必做。出处：#6079 2026-09-29T03:53:39Z。其后 owner 约 06:33Z 同意 R61 带上 06:16Z 合入 main 的 #5866；#6162 于 07:04:00Z 合入，**打包提交 = `bf648922a50a5c9740c9538cb11f5ac6f37257d7`**（#6079 2026-09-29T07:08:05Z）。**打包之前先等开发机在 #6079 回帖 CI 结论**（同帖与 08:00:40Z）：结论已于 08:37:31Z 回帖；是否再等打包提交上被取消的 job 重跑，由 owner 决定（§1.0）。**部署本身仍由 owner 在旧机放行，本文不是放行。** 详见 §1。
> **执行者：** 旧机（运维机）。开发机连不上演示机，演示机现状全部来自 #6079 的回帖，按回帖时间戳（UTC）引用。
> **口径：** values-free。回帖只写布尔、计数、枚举、键名、用时；不写主机、地址、口令、令牌、客户名、项目号、单元格值。需要项目号、表 id 的地方用 `<项目号>`、`<表 id>` 或 psql 变量代入，不回显。
> **基线：** 文中 `path:line` 以打包提交 `bf648922a` 为准，另注明者除外；附录两节仍以决定之前的 `2888addb4` 为准。PR 状态与 #6079 评论为 2026-09-29 约 08:40Z 用 `gh` 读到的结果（#6079 共 37 条评论，最后一条是 2026-09-29T08:37:31Z）。§1.1、§1.2、§2.1、C8 的命令已在 `bf648922a` 上跑过，输出写在各节。
> **上机手册：** 仍是 `handoff-r59-two-machine-20260924.md` §2–§3（#6079 正文第 0 节要求每次上机前读）。本文只补 R61 特有的事项。

---

## 1. 打包点（owner 已决定）

### 1.0 决定

- **选项 A：main 原样打包。** 打包提交 = main 上含 #6144 与 #6162 两支的 first-parent 提交：`bf648922a50a5c9740c9538cb11f5ac6f37257d7`（#6162 的合入提交，first parent 是 `28a7342e6`；`git log -1 --format='%H %P' bf648922a`）。开发机已在 #6079 2026-09-29T07:08:05Z 回帖这个提交号。
- **先等 CI 结论：** 旧机只在开发机于 #6079 回帖 CI 结论之后才打包；在那之前可以准备，不要打包上机（#6079 2026-09-29T07:08:05Z、08:00:40Z）。为什么不是一句「打包提交上全绿」：
  - 分支保护的必跑检查有 13 项（`gh api repos/zensgit/metasheet2/branches/main/protection/required_status_checks`），其中只有 4 项会在合并到 main 的提交上运行：`test (20.x)`、`web-tests`、`stock-prep PowerShell 5.1 acceptance`、`observation-kit contract (read-only SQL census + runbook gating)`；其余 9 项只在 PR 上运行。打包提交上后三项已通过（`gh api repos/zensgit/metasheet2/commits/bf648922a50a5c9740c9538cb11f5ac6f37257d7/check-runs`）。
  - `test (20.x)` 在打包提交由合并触发的「Plugin System Tests」运行里于 2026-09-29T07:52:52Z 被**取消**，不是失败：07:52:33Z #5972 合入 main，`plugin-tests.yml` 的并发规则取消同一分支上还在跑的旧运行（`.github/workflows/plugin-tests.yml:23-25`）。同一运行里 `test (18.x)` 07:35:24Z 全部通过，含「Run attendance integration tests」；`test (20.x)` 停在这一步的运行中（#6079 2026-09-29T08:00:40Z）。
  - 所以开发机的 CI 结论写明两层：(a) 代码包含打包提交的 PR 上的运行，作为那 9 项在打包树上的结果（08:00:40Z 那帖列的是 #6166、#6160，两支都以 `bf648922a` 为祖先）；(b) 如果 owner 要等，再加上打包提交上被取消的 job 的重跑结果。要不要等 (b)，由 owner 决定。
  - **(a) 已回帖**（#6079 2026-09-29T08:37:31Z）：#6166 那一轮的 13 项必跑检查全部通过（本文按 `gh api repos/zensgit/metasheet2/commits/829d978779ee52918b6370d728aa1c6789902125/check-runs` 逐项对过：13 项都是 success；该 head 与打包提交相差 8 个文字文件，同帖）。同帖说明 #6160 上 `test (20.x)` 两次因同一个云课堂用例超时失败，判断为偶发。**(b) 在本文写到的 2026-09-29 约 08:40Z 还没有回帖**；等不等它，由 owner 决定。
- **#6144 在包里：** `3a85b9c97`，2026-09-29T05:04:03Z 合入，first parent 是 `f47054d88`。14 个文件（`git show --stat 3a85b9c97`），不带迁移（§2.2），不带开关（§4）。
- **#6162 在包里：** 2026-09-29T07:04:00Z 合入，就是打包提交本身（`gh pr view 6162`：MERGED，merge commit `bf648922a`，head `d75b471f2`）。按 PR head 原样合入：`git diff e48d3307b d75b471f2` 与 `git diff 28a7342e6 bf648922a` 的增删行逐字相同，11 个文件。它不带迁移（§2.3）。它带一处已知的提示语问题，owner 决定照样上、下一版改（§6.3）。
- **#5866 在包里：** 2026-09-29T06:16:03Z 合入 main（`28a7342e6`，不是本窗口合入的），在打包提交之前。owner 约 06:33Z 同意 R61 带上它（#6079 2026-09-29T07:08:05Z 的决定表）。它带 1 条迁移（§2.2 第 1 条）。
- **不进 R61：** #6157（升级脚本的缺口，C8）与 #6151（源就绪预检 409），以及 #6153、#6163、#6164、云课堂插件，见 §6.4。
- **迁移：** 5 条随包执行，其中两条是任务线的（§2.2）。所以 C2 必做（06:07:40Z 已通过）。
- **命令用哪个提交：** 本文每一条需要打包提交的命令，都在 `bf648922a50a5c9740c9538cb11f5ac6f37257d7` 上跑，不用 main 此刻的头。
- **打包工作流：** `.github/workflows/multitable-onprem-package-build.yml`，`workflow_dispatch`（`:41`），输入 `expected_sha`（`:63`）。工作流拿它与检出后 `git rev-parse HEAD` 的输出逐字比较，不一致就拒绝打包（`:122-131`），所以这里填 40 位完整提交号：`bf648922a50a5c9740c9538cb11f5ac6f37257d7`。**main 已经越过打包提交**（2026-09-29 约 08:30Z：`git log --first-parent --oneline bf648922a..origin/main` 列出 #5972 的 `88b6e1967`，07:52:33Z 合入）：在 main 上触发打包工作流，检出的是 main 的头，与 `expected_sha` 不一致，会被拒绝打包（`:122-131`）。所以要在指向 `bf648922a` 的 tag（或其它 ref）上触发。旧机的打包脚本按 tag 指定打包点（`R60_REF`/`R60_DISPATCH_REF`，#6079 2026-09-29T06:07:40Z）。
- **与已验证流程的偏差：** 切法、tag、`expected_sha` 都与 R60 相同（§1.2）。升级脚本也与 R60 相同：#6157 不进包，§1.2 的命令在 `bf648922a` 上无输出，C8 的 blob 核对在 `bf648922a` 上两值相同。需要注意的是包里的两条任务线迁移与 #5866 那条乱序执行的迁移（§2.2）。其中 `zzzz20260926120000_create_task_p0a_tables` 的头注释写着「Draft migration: do not apply from this PR」（`:2`），但只要在包里，migrate 就会执行它。它建表、建索引都不带 `IF NOT EXISTS`（`:57`、`:97`、`:113`、`:124`、`:140-161`），所以上机前必须做 §3 的 C2。
- **没有采用的做法：** 选项 B（用 `MIGRATION_EXCLUDE` 排除任务迁移）与选项 C（从 `b433ac814` 拉发布分支拣选）连同当时核过的事实移到文末附录。

### 1.1 R60 之后 main 的 first-parent 顺序

```bash
git fetch origin main --tags
git log --first-parent --reverse --format='%h %s' 583dfdf1a..bf648922a50a5c9740c9538cb11f5ac6f37257d7
```

下表就是这条命令的输出，共 26 条，从旧到新（`git log --first-parent --format=%h 583dfdf1a..bf648922a | wc -l` 为 26）。

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
| 18 | `68a703038` | #5974 | Web 必跑车道的令牌集合固定成已提交的清单文件；只改 CI 用的脚本与清单文件、测试、文档和 `.gitattributes` | 仅 CI 与测试 |
| 19 | `e48d3307b` | #6147 | 配置恢复里的有损类型回退要求对表有读：共享函数 `hasFullTableReadAccess` 先查 `canRead` | 修复，两个开关默认关，客户看不到（§6.2） |
| 20 | `4aa0385cd` | #6148 | 修 bridge-agent 只读契约测试 | 仅测试与文档 |
| 21 | `2888addb4` | #6141 | 用户提供的正则按模式长度与输入长度设上限（公式、字段校验、集成管道校验、公开表单） | 平台加固，超长输入才看得到（§6.2） |
| 22 | `2908aeb7d` | #6138 | 上机预检脚本 `scripts/ops/multitable-onprem-preflight.sh`：任何键重复声明都判失败，判定不带值；另改两个工作流里调用它的测试步骤与注释、一行 pin | 运维脚本，后端运行时不变（§6.2） |
| 23 | `f47054d88` | #6158 | staging 窗口 runner 的 `tasks_enabled` 输入与非管理员任务冒烟；只改一个工作流和 `scripts/ops/` 下五个文件 | 仅 staging 与 CI（§6.2） |
| 24 | `3a85b9c97` | #6144 | 装载失败的数据源由属主或平台管理员原地重存凭据；在这种源的 id 上新建改回 409 | 客户修复（§6.2） |
| 25 | `28a7342e6` | #5866 | 审批模板分组 A-3：按现有类别回填（预览、执行、回滚）的管理员接口 + 三张批次账本表；26 个文件（`git show --stat 28a7342e6`），1 条迁移，`apps/web` 下无文件 | 审批模板分组，owner 同意随 R61（§6.2） |
| 26 | `bf648922a` | #6162 | 已有的「记录删除时」规则停用后能在面板上重新启用；失败时面板按服务器状态显示；启用时卡片加一句提示 | 客户修复（#6155），带一处已知措辞问题（§6.2、§6.3） |

由此得出的事实：

- 打包提交就是第 26 条，上表 26 条都在包里。
- 任务线 #6062、#6092、#6123（第 7–9 条，含两条任务迁移）排在客户修复 #6136（第 10 条）之前；审批模板分组 #5878、#5927（第 11、16 条）排在 #6142、#6140、#6146（第 12、13、17 条）之前。沿 first-parent 切的点绕不开它们，所以它们都在包里（§5）。附录里的选项 C 就是为绕开它们而设的，没有采用。
- 第 18–24 条与第 26 条都不带新迁移，第 25 条（#5866）带 1 条：`git diff --name-status cd89c74dd 3a85b9c97 -- packages/core-backend/src/db/migrations packages/core-backend/migrations` 无输出；`git diff --name-status 3a85b9c97 bf648922a -- packages/core-backend/src/db/migrations packages/core-backend/migrations` 只有一行 `A …/zzzz20260919090000_create_approval_template_group_backfill_batches.ts`。

### 1.2 R59、R60 是怎么切的

- **R59** = main `05461c739`（`handoff-r59-two-machine-20260924.md:9`），CI 打包（同文 `:10`）。它在 main 的 first-parent 链上（`git log --first-parent --format=%h origin/main | grep ^05461c739` 有输出）。origin 上没有指向它的 tag：`git ls-remote --tags origin` 里既没有指向 `05461c739` 的，也没有名字含 `r59` 的；`onprem-` 开头的发布 tag 只有 `onprem-r60`。
- **R60** = main `583dfdf1a`，即 #6131 的合入提交，开发机在 #6079 2026-09-28T09:01:43Z 指定。origin 上 tag `onprem-r60` 指向它，它也在 first-parent 链上。旧机 2026-09-28T10:34:09Z 回帖：CI 打包按 `expected_sha` 复核，本地门禁全过。
- **打包工作流：** `.github/workflows/multitable-onprem-package-build.yml`，`workflow_dispatch`（`:41`），输入 `expected_sha`（`:63`）。检出的提交与它不一致就拒绝打包（`:122-131`）。
- **R60 之后没改过的东西：** 下面这条命令在打包提交上无输出（在 `3a85b9c97`、`2888addb4` 上也无输出）。也就是说，到打包提交为止，升级脚本、打包工作流、`docker/`、`ecosystem.config.cjs` 从 R60 起一字未动：
  ```bash
  git diff --stat 583dfdf1a bf648922a50a5c9740c9538cb11f5ac6f37257d7 -- scripts/ops/multitable-onprem-package-upgrade-inplace.ps1 \
    .github/workflows/multitable-onprem-package-build.yml docker ecosystem.config.cjs
  ```

---

## 2. 迁移清单

### 2.1 推导命令（在打包提交上跑，旧机仍按自己的 git 差分生成名单）

```bash
C=bf648922a50a5c9740c9538cb11f5ac6f37257d7
# 新增迁移，按执行顺序（名字排序）列出
git diff --name-only --diff-filter=A 583dfdf1a "$C" -- packages/core-backend/src/db/migrations packages/core-backend/migrations \
  | sed 's#.*/##' | grep -E '^[^_.].*\.(ts|sql)$' | sed -E 's/\.(ts|sql)$//' | LC_ALL=C sort
# 必须无输出：R60 之后被删除、改名或改动过的迁移文件
git diff --name-status --diff-filter=DRM 583dfdf1a "$C" -- packages/core-backend/src/db/migrations packages/core-backend/migrations
```

为什么这就是执行顺序：

- provider 读这两个目录。以 `_` 开头的名字（`migration-provider.ts:208`）、以 `.` 或 `_` 开头的文件、非 `.sql` 的 SQL 目录文件（`:239`）都跳过。
- `migrate.ts:32` 允许乱序历史（`allowUnorderedMigrations: true`）：名字排在已执行迁移之前的新迁移照样执行，不会因顺序报错。
- Kysely 版本是 0.28.8（`pnpm-lock.yaml:3222`）。它的 Migrator 把全部迁移名排序（`#resolveMigrations`：`Object.keys(...).sort()`），把历史表里没有的那些按这个顺序执行。
- 在 PostgreSQL 上，一次 migrate 的**全部**待执行迁移在同一个事务里跑（Migrator 的 `#runMigrations` 在适配器支持事务型 DDL 时包一层 `db.transaction()`，PostgresAdapter 对此返回 true）。任何一条失败，这一批都不生效。

### 2.2 在打包提交 `bf648922a` 上的输出（执行顺序）

§2.1 的两条命令在 `bf648922a50a5c9740c9538cb11f5ac6f37257d7` 上跑过：`--diff-filter=DRM` 那条无输出，新增的 5 条如下，顺序就是命令输出的顺序。与 `3a85b9c97` 相比多出的只有第 1 条（#5866）；#6144、#6162 不改迁移目录（§1.1 的事实第 3 条、§2.3）。

| # | 迁移名 | 建什么、改什么 |
|---|---|---|
| 1 | `zzzz20260919090000_create_approval_template_group_backfill_batches`（#5866） | 建表 `approval_template_group_backfill_batches`、`approval_template_group_backfill_batch_groups`、`approval_template_group_backfill_batch_links`，另建索引 `approval_template_group_backfill_batches_org_created_idx`，四句都带 `IF NOT EXISTS`（`:34`、`:55`、`:60`、`:84`）。两张明细表有外键指向批次表和 R60 已有的 `approval_template_groups`、`approval_template_group_links`（`:71-79`、`:97-112`）。不插数据。**乱序执行：** 它的名字排在演示机已执行的迁移之前：`583dfdf1a` 上两个迁移目录里名字排在它之后的迁移有 8 条（例如 `zzzz20260919120000_add_attachment_blob_purge_claim`），R60 上机后 `kysely_migration` 为 421 行（#6079 2026-09-28T10:37:13Z），与 `583dfdf1a` 上按 §2.1 同样过滤数出的迁移文件数相同（360 + 61），所以这 8 条应当都已执行（R60 按名核对过的只有它新增的 6 条）。`migrate.ts:32` 允许乱序，所以它照样作为待执行迁移、按名字排在这一批的第一个执行（§2.1）。**down()：** 见表后说明。 |
| 2 | `zzzz20260926120000_create_task_p0a_tables` | 建表 `tasks`、`task_assignees`、`task_followers`、`task_events`（`:57`、`:97`、`:113`、`:124`，带检查约束与外键），另建 8 个索引（`:140-161`）。不插数据（`:12`）。不带 `IF NOT EXISTS`。 |
| 3 | `zzzz20260926120100_add_task_permissions` | 若 `permissions` 表存在，插入 `tasks:read`、`tasks:write`、`tasks:admin`，`ON CONFLICT (code) DO NOTHING`；不写 `role_permissions`（`:1-3`、`:11-25`）。 |
| 4 | `zzzz20260927120500_add_meta_sheets_copy_provenance` | `meta_sheets` 加三列 `copied_from_sheet_id`、`copied_from_kind`、`copied_at`（可空，`IF NOT EXISTS`），并在约束不存在时加 CHECK `meta_sheets_copied_from_kind_check`（`:21-46`）。既有行保持 NULL。 |
| 5 | `zzzz20260927121000_add_multitable_install_ledger_intent_kind` | `meta_multitable_template_installs` 加列 `intent_kind text NOT NULL DEFAULT 'template-install'`（`IF NOT EXISTS`，`:25-28`）。复制数据表的去重账本依赖它和 R60 已有的 `zzzz20260919140000_create_multitable_template_install_ledger`（`copy-sheet-service.ts:106-114`）。该文件头注释 `:19-20` 仍写「fail-open」，已被 #6136 改为拒绝，以 §6.2 为准。 |

R60 上机后 `kysely_migration` 共 421 行（#6079 2026-09-28T10:37:13Z）。R61 预期新增 5 行，即 426 行：§2.1 的命令在 `bf648922a` 上列出的正是这 5 条。

**第 1 条的 down() 对 R61 回退意味着什么**（`zzzz20260919090000_…:156-199`；`packages/core-backend/src/db/migrate.ts:139-147` 的 `--help` 说明）：

- R61 的回退走的是升级脚本打印的 `RESTORE REQUIRED` 块：只把替换过的目录从备份拷回、再重启（升级脚本 `:1708-1752`）。升级脚本只以不带参数的 `node migrate.js` 执行迁移（`:1888-1892`；不带参数即 `--latest`，`migrate.ts:15-22`、`:128`），不调用 `--rollback` 或 `--reset`。所以按这条路回退代码时，任何迁移的 down() 都不会运行，这三张表（和另外 4 条迁移建的东西）留在库里。R60 的代码不读这三张表。
- 只有有人手工执行 `migrate.js --rollback` 或 `--reset`（后者还要 `ALLOW_DB_RESET=true`，`migrate.ts:112-116`）并且轮到这条迁移时，它的 down() 才会运行：三张表都没有行时直接删表；任何一张有行、且 `ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP` 不是精确的 `true` 时，抛 `ATG_BACKFILL_DOWN_BLOCKED`，三张表不动（`:172-183`）；`--reset` 是一个事务，这一步失败时更早的迁移也一条都不回退（`migrate.ts:145-147`）。设了 `=true` 时删表并打一行警告（`:187-192`），但删表不撤销回填已经建的分组和挂接（`:121-127`）。
- 表里有没有行，取决于有没有人调用过回填的「执行」接口。按 §6.2 的 #5866 行，未经 owner 同意不在客户服务器上调用它们，所以 R61 期间这三张表应当是空的，手工 down() 也不需要这个变量。
- 这个变量没有登记在开关清单里（§4、§8）。

**回退到 R60 文件之后的陷阱（运维注意）：**

- 升级在迁移成功之后才出错（第 7 步起后端及之后），或者上机后决定退回 R60：按 `RESTORE REQUIRED` 块把文件拷回 R60 之后，库里仍记着 R61 的 5 条迁移，而 R60 的包里没有这 5 个迁移文件。（迁移这一步本身失败时整批回滚、一条也不记，没有这个问题，§2.1。）
- 这时再用 R60 包里的 `migrate.js` 跑迁移会失败：Kysely 0.28.8（`pnpm-lock.yaml:3222`）在计算待执行迁移之前，先检查库里记过的每条迁移在文件里都找得到，找不到就抛 `corrupted migrations: previously executed migration … is missing`（kysely 0.28.8 已发布包 `dist/cjs/migration/migrator.js:437-440`、`:484-488`）。这项检查不受 `allowUnorderedMigrations` 影响，乱序开关只跳过顺序检查（同文件 `:441-443`）。
- 所以回退之后**不要**再用 R60 的包带着迁移步骤跑升级脚本：迁移那一步会失败，升级脚本停后端、打印恢复块（`:1972-1990`）。要么向前修复，再升级到 R61；要么在确实需要重跑 R60 包时关掉迁移步骤：升级脚本的参数是 `-RunMigrations 0`（声明 `:175`，判断 `:1881`，跳过时打印 `RunMigrations=0: skipped`，`:1895`；R60 的脚本是同一个 blob，C8）。
- 后端启动本身不跑迁移，所以拷回 R60 文件后直接重启后端，不会撞上这个检查：R60 的 `ecosystem.config.cjs:58` 起的是 `packages/core-backend/dist/src/index.js`；`583dfdf1a` 上整个 `packages/core-backend/src` 里只有 `db/migrate.ts` 构造 `Migrator`、调用 `migrateToLatest`（`git grep -ln "migrateToLatest\|new Migrator(" 583dfdf1a -- packages/core-backend/src` 只列出这一个文件），`index.ts` 里没有 `migrat` 字样。R60 代码在带着 R61 表结构的库上运行没有测过；R61 的 5 条迁移都只是加表、加可空列或带默认值的列、插权限行（§2.2）。

### 2.3 在开 PR 的迁移不再影响 R61

打包提交已固定为 `bf648922a`（§1.0），之后合入 main 的 PR 都不进 R61，所以在开 PR 带的迁移不改变 §2.2 的名单。上一版本节列过的 #5866 在打包点之前合入了 main（`28a7342e6`），它的迁移因此进了 R61（§2.2 第 1 条）；#6149、#6099 等其余在开 PR 的迁移，下一版再算。

#6162 不带迁移。合入前取它的头看过，合入后在打包提交上再看一次，都没有迁移文件：

```text
$ git fetch origin pull/6162/head      # FETCH_HEAD = d75b471f2
$ git diff --name-status origin/main...FETCH_HEAD -- packages/core-backend/src/db/migrations
（无输出）
$ git diff --name-status origin/main...FETCH_HEAD -- packages/core-backend/migrations
（无输出）
$ git diff --name-status 28a7342e6 bf648922a -- packages/core-backend/src/db/migrations packages/core-backend/migrations
（无输出）
```

### 2.4 规则：先迁移、按名逐条核对、再切代码

- 升级脚本本身就是这个顺序：第 6 步迁移（`multitable-onprem-package-upgrade-inplace.ps1:1878-1896`）在第 7 步起后端（`:1898-1907`）之前。迁移失败时错误抛进处理器，处理器停 pm2 并打印恢复块（`:1842-1852`、`:1972-1990`），新代码不会在没迁移的库上起来。
- 一次 migrate 的全部迁移在同一个事务里（§2.1）：要么都生效，要么一条都不生效。
- 跑完后**按名字**逐条核对，不按条数。名单来自 §2.1 的命令在 `bf648922a` 上的输出（5 条，§2.2）：
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
- **通过：** 每条 `applied = t`；行数 = 421 + 5 = 426。
- **不通过：** 不要重跑、不要手工补迁移，回帖列出 `applied = f` 的名字。
- **R60 的教训：** 开发机清单写的是 4 条（#6079 2026-09-28T09:01:43Z），旧机按名核对时 git 实际是 6 条，多出 `create_approval_template_groups` 和 `add_approval_product_permissions`（#6079 2026-09-28T10:34:09Z）。所以名单一律在打包提交上用命令现算。

---

## 3. 上机前只读检查

**结果：** 旧机已在 #6079 2026-09-29T06:07:40Z 回帖 C1–C7，全部通过（C4 的答案是「未配置」，这是有效答案）。各项的结果写在该项的第一行。**上机当天再跑 C1 与 C3**（#6079 2026-09-29T03:53:39Z、07:08:05Z）；其余各项不用重做（07:08:05Z）。C2b 是本版为 #5866 新增的只读检查，还没跑过，上机前跑。C8 是缺口说明与手工恢复，上机时备用。与 03:53:39Z 那一帖让旧机读的 `d8e6d5d55` 版相比，C1–C7 里旧机要跑的 PowerShell 与 SQL 一字未改。

每项只返回布尔、计数、枚举或键名。psql 一律 `-X -A -v ON_ERROR_STOP=1`，语句包在 `BEGIN READ ONLY; … ROLLBACK;` 里。按下面的顺序做。

### C1 后端此刻在运行（最先做）

- **结果（#6079 2026-09-29T06:07:40Z）：通过。** 计划任务 1 个、`Running`、`rpc.sock` 1、health 200。上机当天开始前再跑一次。
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

### C2 四张任务表与八个索引都不存在（必做）

- **结果（#6079 2026-09-29T06:07:40Z）：通过。** 12 个名字全部 `absent = t`，`task_migrations_recorded = 0`。
- **目的：** R61 带任务线的两条迁移（§1.0、§2.2）。`zzzz20260926120000_create_task_p0a_tables` 用不带 `IF NOT EXISTS` 的 `CREATE TABLE`、`CREATE INDEX`。只要同名关系已存在，migrate 就失败。整批迁移在同一个事务里回滚（§2.1），升级脚本进处理器、停后端、打印 `RESTORE REQUIRED`（`:1972-1990`），站点要等恢复。
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
- **不通过：** 不开始升级。回帖写出哪些名字 `absent = f`（这些是本文列出的固定名字，不是客户数据）以及计数。不要删任何对象，由开发机和 owner 另定办法（#6079 2026-09-29T03:53:39Z）。

### C2b 回填账本的三张表（#5866，本版新增，上机前跑）

- **为什么：** §2.2 第 1 条的四句建表、建索引都带 `IF NOT EXISTS`。同名的表已存在时，PostgreSQL 跳过那句 `CREATE TABLE`、只发一条提示，不检查已有的表长什么样。已有的表形状不对时，迁移**不一定**记为已执行，要看哪一句先碰到它：
  - 批次表 `approval_template_group_backfill_batches` 已存在：随后的 `CREATE INDEX IF NOT EXISTS … (org_id, created_at DESC)`（`:54-57`）在它缺这两列时报错。
  - 两张明细表新建时各带一个外键 `(batch_id, org_id) REFERENCES approval_template_group_backfill_batches (id, org_id)`（`:71-73`、`:97-99`）。PostgreSQL 要求被引用的列上有主键或唯一约束；已有的批次表若没有恰好在 `(id, org_id)` 上的唯一约束（迁移自己建表时是 `atgbb_org_id_uni`，`:45`），或缺这两列，建明细表那一句就报错。
  - 上面任何一句报错，整批 5 条迁移在同一个事务里回滚（§2.1），升级脚本停后端、打印 `RESTORE REQUIRED`（`:1972-1990`）。
  - 只有这几句都没报错时（例如三张表都已存在，三句 `CREATE TABLE` 连同外键全被跳过），迁移才记为已执行，这时表的形状没人核过，回填接口日后读写时才可能出错。
  - 表不存在、却有别的关系占用了名字 `atgbb_org_id_uni` 时，建批次表那一句报名字已存在而失败，结果同上。主键没有写名字，PostgreSQL 起的默认名（`<表名>_pkey`）被占用时会另起一个名字，不会让建表失败：这一点依据的是 PostgreSQL 公开的命名规则，没有在真库上跑过。所以下面不查 `_pkey`，C2 也不查。
  - 索引名 `approval_template_group_backfill_batches_org_created_idx` 被占用时，`IF NOT EXISTS` 只是静默跳过、不建这个索引，迁移不失败。它仍列在下面，出现时回帖。
- **语句**（名字取自该迁移 `:34`、`:45`、`:55`、`:60`、`:84`）：
  ```sql
  BEGIN READ ONLY;
  SELECT n AS relname, to_regclass(n) IS NULL AS absent
  FROM unnest(ARRAY[
    'approval_template_group_backfill_batches',
    'approval_template_group_backfill_batch_groups',
    'approval_template_group_backfill_batch_links',
    'approval_template_group_backfill_batches_org_created_idx',
    'atgbb_org_id_uni'
  ]) AS n ORDER BY n;
  SELECT count(*) AS backfill_migration_recorded FROM kysely_migration
   WHERE name = 'zzzz20260919090000_create_approval_template_group_backfill_batches';
  ROLLBACK;
  ```
- **通过：** 5 行全是 `absent = t`，`backfill_migration_recorded = 0`。
- **不通过：** 不开始升级，不要删任何对象。回帖写出哪些名字 `absent = f`（都是本文列出的固定名字）以及计数，由开发机和 owner 另定办法。

### C3 审计日志分区：上机当月与次月

- **结果（#6079 2026-09-29T06:07:40Z）：通过。** 当月 `t`、次月 `t`。上机当天再跑一次。
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

- **结果（#6079 2026-09-29T06:07:40Z）：未配置。** `handoff_key_lines=0`、`handoff_key_nonempty_lines=0`，机器级、用户级都没有。所以演示机上项目备料页没有「通知下一步」区块，§5 与 §6.2 里依赖它的行（#6142、#6143、#6140、#6146）在演示机上不适用。
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

- **结果（#6079 2026-09-29T06:07:40Z）：通过。** 按配置的目标表与操作员租户：`wall_passes_via_registry`、`registered_anywhere`、`bound_sheet_active`、`bound_sheet_is_derived_id` 都是 `t`，`distinct_owner_projects = 1`，pgcrypto 在。C4 未配置，所以这次只跑了取操作员租户的那一次，回答的是结转与导出一侧。
- **目的：** 结转与物料导出在 R60 已经过这道墙（导出那一路是 #6109 加的，在 R60 包内；PR #6140 正文：三条路由用同一道墙）。R61 起「通知下一步」也先过这道墙（#6140，MERGED，`03202a1e9`；`http-routes.cjs:828-856`）。墙放行有两种情况：绑定的表在归属登记表里登记在本租户名下；或者表 id 正是按本租户派生出的 id（`stock-preparation-target-provisioning.cjs:1205-1220`）。
- **已知的部分：** owner 会话调备料预检，得到 `carryTargetBinding.ownershipState = owned_by_this_project`、`carryWouldRefuseWith = null`（#6079 2026-09-29T01:26:41Z）。预检用的是按调用方身份得出的项目（`stock-preparation-preflight.cjs:448`、`:669`），所以结转与导出这一侧，对这个会话所属的租户已经有答案。下面的 SQL 仍要跑一次：「通知下一步」按交接链配置里的 `tenantId` 判，这个租户是否与上面那个相同，本文不知道。C4 为未配置时，只跑 `chain_tenant` 取操作员租户的那一次，用来复核上面的结果。
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
- **不通过时怎么办：** 回帖上面的布尔与计数。PR #6140 的修法是「重跑 sandbox target ensure」，这是写操作，先回帖，由开发机与 owner 决定，升级当天不自行做。
- **对升级的判定：不阻断升级。** 照常升级，回帖。理由：结转与导出的墙在 R60 已经上线，R61 不改它；「通知下一步」在这种部署上从每次 400 变成每次 409，处理函数先过墙（`http-routes.cjs:9484`），之后才写游标（`:9509` 的 `store.advance`），审计行与钉钉通知都在这之后。C5 不通过时，§6.2 的 #6142、#6140、#6146 三行按「C5 不通过」记录，不算回归失败。

### C6 加密存储普查（R60 第一次写入密钥之后）

- **结果（#6079 2026-09-29T06:07:40Z）：通过判据全部满足；唯一的遗留已在演示机上结清（06:22:13Z）。** 计数：`data_sources.password = 1`（重加密后的新密文，不作判据）、`directory_integrations.appSecret = 1`，其余各项 0，`integration_external_systems.v1 = 0`。日志前段 `Unsupported state or unable to authenticate data` 与 `Failed to decrypt credential` 各 1 行、成对，另两串 0；后段四串都是 0。那 1 行 `directory_integrations.appSecret` 是 R60 之前封存的值：用户管理页因它报 500，owner 同意后旧机用同样的办法就地重加密，不需重启，刷新后两个接口 200（#6079 2026-09-29T06:22:13Z）。旧机据此报告演示机上已知的换钥遗留清零。同帖立了 #6163、#6164，都不进 R61（§6.4）。
- **目的：** R60 之前 `app.env` 里没有 `ENCRYPTION_KEY`、`ENCRYPTION_SALT`，旧代码退回到仓库内置默认值；R60 第一次写入了新的密钥（#6079 2026-09-28T02:03:25Z、10:34:09Z）。R60 之前用 `enc:` 格式（`packages/core-backend/src/security/encrypted-secrets.ts:10`、`:204-205`、`:236-242`）封存的值，用新密钥解不开。
- **已知的部分：** PLM 连接原先就是这种情况（10:37:13Z）。2026-09-29 旧机在演示机上用内置默认密钥解出它的口令，用新密钥就地重新加密，只改这一个键；重启后日志是 `Loaded 1 data sources from database`、没有 skipped、解密失败 0（#6079 2026-09-29T01:26:41Z）。本项现在要回答的是：**其余**存储里，还有没有 R60 之前用默认密钥封存、至今没人用到过的值。
- **与 R61 的关系：** R61 不改加解密本身：`git diff --stat 583dfdf1a bf648922a -- packages/core-backend/src/security/encrypted-secrets.ts` 无输出。原来那条宽检索在 `2888addb4` 上无输出，在打包提交上有输出，与 `3a85b9c97` 上相同（订正上一版「R61 不改任何加解密代码」的说法）：
  ```text
  $ git diff --stat -G 'encrypted-secrets|ENCRYPTION_KEY|ENCRYPTION_SALT|decryptStoredSecretValue|encryptStoredSecretValue|isEncryptedSecretValue' 583dfdf1a bf648922a -- . ':!*.md' ':!docs'
   apps/web/tests/dataSourcesLoadFailedReseal.spec.ts |  296 +++++
   .../src/data-adapters/DataSourceManager.ts         |  504 +++++++-
   .../data-source-reseal-load-failed-realdb.test.ts  |  511 ++++++++
   .../unit/data-source-reseal-load-failed.test.ts    | 1340 ++++++++++++++++++++
   scripts/ops/multitable-onprem-preflight.sh         |  353 +++++-
   scripts/ops/multitable-onprem-preflight.test.mjs   | 1222 ++++++++++++++++++
   6 files changed, 4178 insertions(+), 48 deletions(-)
  ```
  命中的后端代码只有 `DataSourceManager.ts`（#6144）：数据源的凭据解不开时，记为可重封的装载失败；属主或平台管理员在界面上重新输入后，用当前密钥重新封存写回原行（`:1032` 经 `encryptCredentials`，`:500-510`）。其余存储的读写路径没有改。`multitable-onprem-preflight.sh`（#6138）是上机预检脚本，不在后端里运行（§6.2）。所以本项查的仍是 R60 留下的状态，不是 R61 带进来的。
- **范围**：`git grep -l encrypted-secrets bf648922a -- packages/core-backend/src plugins` 列出的每个存储，逐个看代码后得到：
  | 存储 | 位置 | 依据 |
  |---|---|---|
  | 数据源凭据 | `data_sources.config->'credentials'` 的 `password`、`apiKey`、`token` | `DataSourceManager.ts:30`、`:500-538` |
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
- **日志计数**：用 R60 复核时读过的同一份后端日志，从 R60 重启起算（切分方法同 #6079 2026-09-28T10:37:13Z 的 §4.6 日志检查），再以 2026-09-29 就地重加密之后那次重启（日志里出现 `Loaded 1 data sources` 的那次）为界分成**前段**和**后段**，分别报下面四个固定串在两段里各自的行数，不贴行内容：
  - `Unsupported state or unable to authenticate data`：Node 的 GCM 鉴权失败，10:37:13Z 回帖里见过；
  - `Failed to decrypt credential`（`DataSourceManager.ts:527-528`；R60 `583dfdf1a` 上是 `:402`，字串相同）；
  - `has unreadable credentials (decrypt failed)`（`dingtalk-group-destination-service.ts:70`）；
  - `Decryption failed:`（`ConfigService.ts:469`）。
- **为什么启动日志看不出来：** 启动时逐行解密的只有数据源管理器，解不开就记进「Loaded … (N skipped)」（`DataSourceManager.ts:445-489`；R60 上是 `:320-358`）；其余各处都是用到时才解密，所以 R60 启动日志里的「1 skipped」只说明数据源这一家。其余存储里用旧默认密钥封存的值，要等第一次被用到时才失败；其中审批卡片链接密钥解不开时直接当作未配置，不写日志（`approval-card-config.ts:76-79`、`:105-108`）。
- **通过：**
  - SQL：`data_sources.*` 三项不作判据。数据源在启动时逐条解密，重加密之后的启动日志已经说明全部装载成功（01:26:41Z）；经 `encrypted-secrets` 重新封存的值仍以 `enc:` 开头（`encrypted-secrets.ts:236-238`），会被计进 `data_sources.password`。其余各项计数都为 0。
  - 日志后段：四个串都为 0。
  - 日志前段：`has unreadable credentials (decrypt failed)` 与 `Decryption failed:` 为 0。前段里 `Unsupported state or unable to authenticate data` 与 `Failed to decrypt credential` 预期成对出现、行数相等：PLM 连接装载失败时，这两串出现在同一行（前段日志出自 R60 的代码：`583dfdf1a` 上 `DataSourceManager.ts:353` 打印错误，`:402` 把原错误信息接在后面；R61 上对应 `:478` 与 `:527-528`，字串没变），重加密之前每次后端启动各记一次。
- **不通过：** 回帖各项计数。计数不为 0 不等于解不开：R60 之后写入的值是用新密钥封存的，也带 `enc:`。由开发机按存储逐一判断并给出处理办法，不要自行改库。
- **R61 起，数据源这一家的恢复办法：** 升级后若有数据源装载失败（启动日志出现「(N skipped)」），由该源的属主或平台管理员在界面上操作：数据源 → 无法装载 → 重新输入凭据，原 id 上重存（步骤与验收见 §6.2.1）。**#6079 早先贴出的「用原账号新建一个同 id 的数据源」R61 起回 409，不再可用**（`DataSourceManager.ts:647-649`；`routes/data-sources.ts:585-589`；#6079 2026-09-29T05:07:05Z）。其余存储没有这样的界面，仍按上一条回帖；通用的自检与重录路径由 #6164 跟踪，不进 R61。
- **对升级的判定：不阻断升级。** 照常升级，回帖计数。R61 不改 `encrypted-secrets.ts`（上面的检索），只要 `app.env` 里的密钥两行不变（C7），升级前后这些值能不能解开不会变；变的只是数据源解不开时有了界面上的重封办法。

### C7 `app.env` 重复键（卫生项）

- **结果（#6079 2026-09-29T06:07:40Z）：无重复。** 30 个键都是标识符形态，重复 0，非标识符行 0。旧机的两个回答见本节末尾。
- **定位：** 这是卫生项，不是已知的 R61 阻断项。按下面的检索（打包提交 `bf648922a`，输出与 `3a85b9c97` 上相同），仓库里没有任何 Windows 脚本调用 `multitable-onprem-preflight.sh`；工作流里提到它的两处都是 #6138 加的，一处是 Linux 上 CI 的测试步骤，一处是注释。其余调用它的是 Linux 与打包侧脚本：
  ```text
  $ git grep -n multitable-onprem-preflight bf648922a -- '*.ps1' '*.bat' '*.cmd'
  （无输出）
  $ git grep -n multitable-onprem-preflight bf648922a -- '.github/workflows/*.yml'
  .github/workflows/plugin-tests.yml:196       （`test` 作业，runs-on ubuntu-latest，:174-175；node --test 列表里的 scripts/ops/multitable-onprem-preflight.test.mjs）
  .github/workflows/stock-prep-staging-window-rehearsal.yml:127   （注释）
  $ git grep -l multitable-onprem-preflight bf648922a -- ':!docs' ':!*.md'
  .github/workflows/plugin-tests.yml
  .github/workflows/stock-prep-staging-window-rehearsal.yml
  scripts/ops/multitable-onprem-delivery-bundle.mjs
  scripts/ops/multitable-onprem-preflight.sh
  scripts/ops/multitable-onprem-preflight.test.mjs
  scripts/ops/multitable-onprem-release-gate.sh
  scripts/ops/multitable-pilot-handoff.mjs
  scripts/ops/multitable-pilot-handoff.test.mjs
  scripts/ops/multitable-pilot-release-bound.sh
  scripts/ops/multitable-pilot-release-bound.test.mjs
  ```
  第二条的两行输出是缩写，括号里是本文的说明。旧机的 wrapper 不在仓库里；旧机回答它**不调用**这个预检脚本（#6079 2026-09-29T06:07:40Z）。
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
- **处置规则**（以 #6079 2026-09-28T14:02:47Z 的订正版为底；13:52:05Z 的「保留第一次」已作废。本文订正了其中「删空值行，两种取值规则下都安全」一条，见下）。**先判密钥，再判其它键：**
  - 无输出：无重复，什么都不用做。
  - `ENCRYPTION_KEY` 或 `ENCRYPTION_SALT` 出现不止一行，**其中一行是空值也算**：哪一行都先别删，先回帖，只报「几行、其中空值几行、非空的几行值是否相同」，由开发机协助判定哪一对在用。已加密落库的值只能用当初加密它们的那对密钥解开。空值不等于没设：
    - 经 `ecosystem.config.cjs` 启动时，第一行若是空值，空串就进了进程环境，后面的行不再生效（`ecosystem.config.cjs:42-44`）。
    - `encrypted-secrets.ts` 在非 production 下把空值当作内置默认值（`:170-174`）；`NODE_ENV=production` 时空值算「未配置」（`:84-85`），直接拒绝加解密（`:132-150`）。
    - 四份 `docker/` 模板都带空的 `ENCRYPTION_KEY=`、`ENCRYPTION_SALT=` 行（`docker/app.env.multitable-onprem.template:21-22`、`docker/app.env.attendance-onprem.template:16-17`、`docker/app.env.example:19-20`、`docker/app.env.attendance-onprem.ready.env:20-21`）。在这样的文件末尾追加真值，就成了「空值在前、真值在后」。这时删掉空值行，经 `ecosystem.config.cjs` 启动的那条路径下次启动会从空值改用真值。
    - R60 的密钥预检报「无重复」（#6079 2026-09-28T10:34:09Z），演示机上预计不会命中这一条。
  - 其它键重复、各行值相同：删掉任意一行。
  - 其它键重复、其中一行值为空：先回帖键名，并说明空值行在前还是在后，不要自行删。删空值行不是「两种取值规则下都安全」，它会改变现在读到空值的那条启动路径：
    - 空值行在前：受影响的是经 `ecosystem.config.cjs` 启动的后端，它取第一次出现的行（`ecosystem.config.cjs:42`）。
    - 空值行在后：受影响的是升级脚本导入的环境，它取最后一次出现的行（升级脚本 `:1367-1391`）。PS 5.1 下 `Set-Item Env:X ''` 会把这个变量删掉（开发机 PS 5.1 实测），所以升级脚本起的 migrate 看不到这个键。
    - 演示机的后端实际经哪条路径读 `app.env` 没有核对（§8），所以两种位置都先回帖。
  - 其它键重复、非空值不同：先回帖键名，不要自行删。
- **旧机的回答（#6079 2026-09-29T06:07:40Z）：** ① R61 的 wrapper 不调用 `scripts/ops/multitable-onprem-preflight.sh`，它走 CI 打包加自带的门禁。② wrapper 自己的重复键检查只查三个键：`ENCRYPTION_KEY`、`ENCRYPTION_SALT`、`DATABASE_URL`，重复就退出、什么都不动。所以本项这次是单独跑的；旧机打算把全键重复普查加进 wrapper 的预检输出（只出键名与次数，不阻断）。

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
- **R61 不带修复：** #6157（2026-09-29 约 08:40Z 仍为 OPEN，draft）修这个缺口，只改升级脚本和它的测试：停服之后、第一次写入线上文件之前失败时，脚本把后端重新拉起，并打印 `UPGRADE NOT APPLIED`（该 PR 正文）。owner 决定它不进 R61（#6079 2026-09-29T03:53:39Z），所以 R61 上机时上面的手工恢复适用。
- **升级脚本从哪里取、按什么顺序：**
  1. **只从打包提交取**，不从 `git pull` 到 main 之后的工作区复制，因为 main 可能比打包提交新（#6157 以后合入 main，main 上的脚本就不再是 R60 那一份）：
     ```bash
     C=bf648922a50a5c9740c9538cb11f5ac6f37257d7
     git show "$C:scripts/ops/multitable-onprem-package-upgrade-inplace.ps1" > <本地副本>
     git hash-object --no-filters <本地副本>   # 必须等于下一行的输出
     git rev-parse "$C:scripts/ops/multitable-onprem-package-upgrade-inplace.ps1"
     ```
     在 bash 里执行：PowerShell 5.1 的 `>` 会把输出改写成 UTF-16，两行就对不上。开发机在打包提交上跑过这三条（在 bash 里），三个值相同，也等于 `583dfdf1a`（R60）上该文件的值：
     ```text
     $ git rev-parse bf648922a50a5c9740c9538cb11f5ac6f37257d7:scripts/ops/multitable-onprem-package-upgrade-inplace.ps1
     3aee13e2be4272e06e6c21fffd6c4991590b0c52
     $ git hash-object --no-filters <本地副本>      # 由上面的 git show 写出
     3aee13e2be4272e06e6c21fffd6c4991590b0c52
     $ git rev-parse 583dfdf1a:scripts/ops/multitable-onprem-package-upgrade-inplace.ps1
     3aee13e2be4272e06e6c21fffd6c4991590b0c52
     ```
     旧机取到的副本不是这个值，就停下回帖。
     包里没有这个脚本，没法拿包里的副本比对，只能对打包提交：`scripts/ops/multitable-onprem-package-build.sh` 的 `REQUIRED_PATHS`（`:37-186`）里没有它，`git grep -n upgrade-inplace bf648922a -- scripts/ops/multitable-onprem-package-build.sh` 无输出。
     为什么要同一个提交：脚本的 `MustExistManifest`、`BackupPaths`、`ReplaceDirs` 默认值（`:216-246`）是按包的目录结构写的。脚本与包出自不同提交时，这几份清单与包对不对得上，没人验证过。对不上的话，会在停服之后、替换进行中报错（第 4、5 步，`:1863-1867`），进 `RESTORE REQUIRED`。
  2. 用它替换旧机本地的升级脚本副本。
  3. 重跑本地门禁（R60 的门禁见 #6079 2026-09-28T10:34:09Z：字节、BOM、预检自测、sha256/gitSha）；传到演示机后，两端的 sha256 一致。
  4. 然后才上机。
  #6157 不进 R61：打包提交上是 R60 验证过的那一份脚本。#6157 在打包点之后合入 main 时，不要从 main 取新版用于 R61。

---

## 4. 开关

`git diff 583dfdf1a bf648922a -- scripts/ops/global-history-flag-manifest.mjs` 只有新增（41 行），没有改动。新增代码行里的 `env.X` 读取与这三项一致，只有 #5866 的一个迁移内变量例外，见表后：

| 键 | 清单位置 | 默认 | 打开之后会暴露什么 |
|---|---|---|---|
| `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` | `:62` | 关；只认精确的 `'true'`（`packages/core-backend/src/multitable/field-retype-convert.ts:26-28`） | 只读预览端点 `POST /fields/:fieldId/retype-preview` 可用（第 2 刀）。执行、撤销端点要等 #6149 合入才有；有了之后「执行」会改写一整列在用数据（清单标 danger=high）。没有界面。 |
| `MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS` | `:656` | 未设 = 2000；上限 50000（`copy-sheet-limits.ts:17-33`） | 不是开关，是同步复制的行数上限。调大会拉长一个同时持有源表行锁和全部参与表围栏的事务。 |
| `TASKS_ENABLED` | `:667` | 关；只认精确的 `'true'`（`routes/tasks.ts:35-36`） | 挂载 `/api/tasks` 路由，草案任务功能对持 `tasks:*` 的账号（含平台管理员）可达。 |

**R61 不改演示机上的任何开关。** 这三个键都不需要设，保持默认。本文凡提到这三个键的地方，都按「未设」写；要依赖某个开关打开才成立的行，会在那一行写明。

`2888addb4` 之后合入的五条（§1.1 第 22–26 条）不改开关清单：`git diff 2888addb4 bf648922a -- scripts/ops/global-history-flag-manifest.mjs` 无输出。其中：

- #6158 新增的 `TASKS_WINDOW_ENABLED`（`scripts/ops/attendance-staging-window-runner-remote.sh:124`）和工作流输入 `tasks_enabled` 只在 staging runner 里用：后端代码不读它（`git grep -n TASKS_WINDOW_ENABLED bf648922a -- packages/core-backend/src` 无输出），它也不进包（§6.2 的 #6158 行），不是演示机上的开关。它不在开关清单里（§8）。
- #6162 不加开关：`git diff 28a7342e6 bf648922a` 没有新增 `process.env` 或 `import.meta.env` 的读取。
- #5866 在非测试文件里只新增一处环境变量读取：迁移 `zzzz20260919090000_…` 的 down() 读 `ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP`，只认精确的 `'true'`（`:156`、`:173`）。它只在有人手工回滚这条迁移、且三张账本表里有行时起作用，运行中的后端不读它（§2.2 表后）。**它没有登记在开关清单里**：`git grep -n ALLOW_ bf648922a -- scripts/ops/global-history-flag-manifest.mjs` 无输出（同样以 `ALLOW_` 开头的 `ALLOW_DB_RESET` 也不在清单里）。本文只报告，不改清单（§8）。R61 上机不设它。

---

## 5. R61 之后客户会看到什么

打包提交含 §1.1 的全部 26 条。

- **复制数据表入口：**
  - 入口①：表侧栏「复制数据表」，只出现在当前选中的那张表的行上（`apps/web/src/multitable/components/MetaSheetViewRail.vue:114-120`）。
  - 入口②：「存为模板」弹窗里的「改为复制数据表（含数据）」（`apps/web/src/multitable/views/MultitableWorkbench.vue:192`）。
  - 两处都只在 `/context` 返回 `canCopySheet === true` 时出现。`canCopySheet` = 目标 Base 可写 **且** 对源表有全表读（`packages/core-backend/src/routes/univer-meta.ts:9259-9279`）。目标 Base 可写是指：平台管理员角色，或 `resolveBaseWritable`（Base 属主或持 Base 写权限码，`permission-service.ts:2019-2020`、`:2032-2059`）。审批投影与 e-learning 投影 Base 对谁都不可写（`:2041`）。
  - 复制出的表带徽标「快照副本」；源为托管表时再加「不随 PLM 刷新」（`meta-sheet-view-rail-labels.ts:32`、`:37`）。
  - 复制没有开关（§4）。
  - 以上是读代码得出的，没有实际运行（§8）。
- **项目备料页「通知下一步」：**
  - C4 未配置：R61 前后都没有这个按钮。**演示机就是这种情况**（C4，#6079 2026-09-29T06:07:40Z），下面三条在演示机上不适用，留给配置了交接链的部署。
  - 已配置、C5 通过：当前处理人按下后请求第一次能到达服务器。R60 上是每按必 400，见 PR #6142 正文。
  - 已配置、C5 不通过：见 C5 的拒绝文案。
  - #6146（`cd89c74dd`）修了三类看板缺陷：消息没发出去却说已交接、最后一步按不了、欠发的群通知补发不了（回归见 §6.2）。
- **结转、物料导出：** 墙在 R60 已经上线（#6109）。R61 只在预检里多给一个 `detail.handoffRouteCode`。
- **字段类型转换：** 无变化（开关关、无界面）。
- **数据源页「无法装载」分组（#6144）：** 只有存在装载失败的源、且当前账号是它的属主或平台管理员时才出现（§6.2.1）。演示机上预期不出现。
- **自动化面板（#6162）：** 触发器为记录删除、动作要改这条记录的已有规则，停用之后能在面板上重新启用；这类规则启用时，卡片下多一句提示（§6.2）。这句提示对动作为「修改记录」「锁定记录」的规则不准确，是已知问题（§6.3）。
- **审批模板分组的按类别回填（#5866）：** 只有后端管理员接口，没有界面（`apps/web` 下无文件，`git grep -n approval-template-groups/backfill bf648922a -- apps/web/src` 无输出），客户在页面上看不到变化（§6.2）。
- **「源就绪预检」的「现在检查」：** 与 R60 相同（#6151 不进 R61，§6.4）。
- **超长的正则输入**会被新拒绝（#6141，§6.2），一般数据看不到变化。
- **「任务」导航入口：**
  - 在默认导航外壳里，有 `tasks:read` 的账号会看到「任务」入口和待办角标（`apps/web/src/App.vue:53-62`、`:199-202`）。平台管理员总是满足（`useAuth.ts:551-552`）。普通账号只要没有被授予该权限码就看不到，迁移不写 `role_permissions`（`zzzz20260926120100_add_task_permissions.ts:1-3`）。
  - `TASKS_ENABLED` 未设时：角标显示「!」（`apps/web/src/tasks/TasksTodoBadge.vue:41`；读取非 2xx 即判为不可用，`useTasksBadge.ts:9`）；页面显示「任务功能未启用或当前服务不支持」（`apps/web/src/views/tasks/TasksView.vue:189-192`；上下文读取 404 即判为不可用，`tasksContext.ts:50`）。
  - 考勤专注外壳与 PLM 工作台外壳里没有这个入口（`App.vue:8`、`:11-39`）。演示机用哪种外壳由产品模式决定（`apps/web/src/stores/featureFlags.ts:494-500`），本文不知道，列为 §7 的问题。
- **审批「审批表单」页**（`/approval-templates`，`apps/web/src/router/appRoutes.ts:406-409`，只要求登录）：#5878 与 #5927 改了该页的模板分组界面（`TemplateCenterView.vue`、`TemplateGroupSections.vue`、`ApprovalTemplateGroupsPanel.vue`）和 `routes/approvals.ts` 的接口。#5927 另外改了 `SessionOrgSwitcher.vue`（只被审批模板分组面板使用），并在 `authPrincipal.ts` 里新增导出。具体控件是什么、谁能看到，本文没有逐项核对（§8）。

---

## 6. 上机后验收与回归

### 6.1 复制数据表 S1 验收

按 `copy-sheet-r61-acceptance-checklist.md` 执行，回帖格式见该文 §7。复制演示时源表保持 ≤ 2000 行；复制同一张表或其关联表期间不要手动触发 PLM 刷新（该文 §5）。

**需 owner 放行**（下面每一步都在演示机上建表、写数据或删表。源是客户的备料主表时，复制出的新表里就是客户整张表的数据）：

- 该文 §2（`:42`）：复制「55 列备料主表」（含数据），在演示机上新建一张装着客户整表数据的表。§5（`:96`）的计时用的也是这一次复制。
- 该文 §3（`:75`）：对复制出的表再复制一次（二代复制），又是一份整表拷贝。
- 该文 §4 第 3 项（`:85`）：复制进行中改动源表的一条记录。源表是客户的备料主表（`:29`、`:42`），这是对客户演示数据的写入。
- 该文 §4 第 4 项（`:86`）：快速连续点两次「复制」，预期再建出一张表。
- 该文 §6（`:104`）：在演示机上删除复制出来的表。
- 该文 §1 要三个测试身份（`:29`），§2.2 还要一个受限账号和一个 write-own 账号（`:58-59`）。这些身份在演示机上是否已经存在不知道，新建账号或授权也是服务器写入。
- #6079 正文「不做」：不在未经批准的情况下写客户演示表的数据。

**替代做法（不改、不复制客户数据）：** 在测试 Base 里新建一张临时的非托管表，放若干行，用它当源：§4 第 3 项（复制期间编辑这张临时表的一条记录，预期 409 `COPY_SOURCE_CHANGED` 并整体回滚）、§4 第 4 项、§6 的删表都改用它和它的副本。§2、§3 里只有源是托管表才有意义的几项（「不随 PLM 刷新」徽标 `:55`、PLM 刷新不碰新表 `:73`、二代副本仍带该徽标 `:75`）换不了源，只能等 owner 放行，否则回帖记「未做」。三个身份的问题仍需 owner 决定：用已有账号，还是新建。

### 6.2 R60 之后已合入 main 的提交：每条一行回归

打包提交含 §1.1 的 26 条，下表每行都适用于这个包；标明「演示机上不适用」的行，是因为演示机缺它的前提（C4 未配置）。依赖开关的行写明了开关；R61 不设任何开关（§4），这些行按开关关着写。

| PR（`gh` 现状） | 回归 |
|---|---|
| #6116、#6112（MERGED；`8a6746428`、`0185b00a5`） | 见 §6.1。 |
| #6136（MERGED 2026-09-28T14:27:17Z，`5ac5b3ed1`） | 迁移按名核对通过后，复制（含数据）应成功。若提示「复制暂不可用：服务器需要先完成数据库升级，请联系管理员。」（503 `COPY_TEMPORARILY_UNAVAILABLE`，`meta-copy-sheet-labels.ts:160-163`；`copy-sheet-service.ts:1190-1191`、`:1235-1238`），说明账本迁移没生效；此时零写入，回到 §2.4。 |
| #6142（MERGED 2026-09-28T16:37:34Z，`5e97c7116`）+ #6143（MERGED 2026-09-28T17:50:06Z，`33047ef94`，仅测试） | **演示机上不适用：** C4 未配置（#6079 2026-09-29T06:07:40Z），项目备料页没有「通知下一步」区块。以下只对配置了交接链的部署适用。前提是 C4 已配置、C5 通过。当前处理人在项目备料页按「通知下一步」，不再回 400 `STOCK_PREPARATION_HANDOFF_REQUEST_INVALID`，页面给出一句结果。服务器回 409 `STOCK_PREPARATION_HANDOFF_STEP_MISMATCH` 时，页面重读「轮到谁」并显示该拒绝的专门说明，不显示通用的「过一会儿再点一次」（#6143 钉住的两条分支）。回帖：状态码 + 是否显示了结果句（布尔）。 |
| #6140（MERGED 2026-09-28T16:51:44Z，`03202a1e9`） | **演示机上不适用：** C4 未配置（#6079 2026-09-29T06:07:40Z），项目备料页没有「通知下一步」区块。以下只对配置了交接链的部署适用。正确配置的部署行为不变。C5 不通过的部署上，「通知下一步」回 409（`…_TARGET_TENANT_MISMATCH` 或 `…_TARGET_OWNER_UNKNOWN`；宿主缺端口时回 501 `…_PROVISIONING_UNAVAILABLE`），页面显示专门说明，不邀请重试（`plainLanguage.ts:717-734`）。回帖：实际拒绝码与 C5 的布尔是否一致。 |
| #6146（MERGED 2026-09-28T23:10:28Z，`cd89c74dd`） | **演示机上不适用：** C4 未配置（#6079 2026-09-29T06:07:40Z），项目备料页没有「通知下一步」区块。以下只对配置了交接链的部署适用。前提同 #6142 行（C4 已配置、C5 通过）。① 当前处理人持有最后一步时，按钮是「通知仓库和采购」，可以按，「下一步」条里的按钮同词（`apps/web/src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue:1053-1067`，词取自 `apps/web/src/services/integration/stockPreparation/operatorNextStep.ts:54-57`，「下一步」条经视图 `:1101` 与 `operatorNextStep.ts:135-140` 用同一个词）。② 交接成功但群消息没发出去时，页面说「已经交给下一步了,但群里的消息没有发出去 —— 请您自己跟下一位说一声。」，并说明交接本身已成功、不用再点；只发出去一部分群时，说「……有一个群没发出去 —— 请您自己跟对方说一声。」（`plainLanguage.ts:1886-1897`）。③ 欠着上一跳群通知的人，可以在看板上按「通知下一步(补发上一步的群消息)」补发（`StockPreparationProjectBoardView.vue:1061-1064`；谁能按与确认队列同一规则，`confirmationQueue.ts:621-627`）。另：项目选择器里本机记住的项目写作「这台电脑最近开过的项目」（`StockPreparationProjectBoardView.vue:130`）。回帖：①②③ 各自是否符合（布尔）。 |
| #6139（MERGED 2026-09-28T17:47:15Z，`68578b56f`） | 客户看不到任何变化（开关默认关、无界面）。字段设置里把文本改成单选，仍是原来的 400 `FIELD_RETYPE_NOT_LOSSLESS`（`scripts/ops/global-history-flag-manifest.mjs:61-79` 该条目所述）。不需要回归。 |
| #6147（MERGED 2026-09-29T02:05:57Z，`e48d3307b`） | 客户看不到变化，不需要回归。两条配置恢复路由在 `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT` 与 `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY` 后面，两个开关都默认关（该 PR 正文）。它改的是共享函数 `hasFullTableReadAccess`，先查 `canRead`（`univer-meta.ts:7465`）；复制入口的 `canCopySheet` 也调用它（`:9272`）。按该 PR 正文的调用点表（第 10 行），这个调用点在调用之前已经要求能读该表，所以复制入口的可见人群不变。 |
| #6141（MERGED 2026-09-29T02:18:18Z，`2888addb4`） | 一般数据看不到变化，不需要专门回归。新的拒绝只针对超长输入（`docs/development/input-regex-redos-route-ii-design-20260925.md` §9.1）：字段规则里有 `pattern`、没有 `maxLength` 时，写入超过 10000 字符的值被拒；超过 4000 字符的正则（公式参数、校验规则、管道映射）被拒；`REGEXMATCH`、`REGEXEXTRACT`、`REGEXREPLACE` 对超限输入返回 `#ERROR!`，`SUBSTITUTE` 让整条公式变成 `#ERROR!`。上机后客户若报这几类错误，先对照这里。 |
| #6062、#6092、#6123、#5878、#5927（MERGED；任务线与审批模板分组，§1.1 第 7–9、11、16 条） | 不是客户修复，但会被看到：「任务」入口与「!」角标（§5；这是 `TASKS_ENABLED` 未设时的样子）；「审批表单」页改动。回帖：演示机外壳（枚举）、管理员账号是否看到「任务」入口（布尔）。 |
| #6138（MERGED 2026-09-29T03:27:31Z，`2908aeb7d`） | 客户看不到，后端运行时不变，不需要回归。它改上机预检脚本 `scripts/ops/multitable-onprem-preflight.sh` 与它的测试，另把这个测试文件加进 CI 已有的一步 `node --test`（`.github/workflows/plugin-tests.yml:196`）、改一段工作流注释和一行 pin（`git show --stat 2908aeb7d`）。这个脚本不进包：`scripts/ops/multitable-onprem-package-build.sh` 的 `REQUIRED_PATHS`（`:37-186`）里既没有它，也没有它的上级目录（包只复制这份清单，`:590-592`）。旧机只有在自己的 wrapper 调用这个 bash 脚本时才会注意到变化；旧机回答 wrapper 不调用它（C7 末尾，#6079 2026-09-29T06:07:40Z），所以 R61 上机时注意不到。脚本本身的行为：`app.env` 里任何键声明不止一次都判失败，报文以 `DUPLICATE_ENV_KEY:` 开头，只列键名、次数和行号，不带值（`:724-816`，报文 `:814`）；看起来可能是值的一部分的键名印成 `<key withheld>`（`:623`、`:811-813`）；以 UTF-16 保存或含 NUL 字节的 `app.env` 判失败 `ENV_FILE is not UTF-8 text`（`:823-831`）；打不开的 `app.env` 判失败 `ENV_FILE is not readable`（`:880`）。修复建议里，`ENCRYPTION_KEY` / `ENCRYPTION_SALT` 两个非空值不同时哪一行都先别删（`:789-790`、`:199`），与 C7 一致；但它说「空值行挨着非空行时可以删」（`:198`），C7 对这种情况更保守（先回帖），以 C7 为准（§8）。无需回帖。 |
| #6158（MERGED 2026-09-29T03:56:28Z，`f47054d88`） | 客户看不到，不需要回归。六个文件（`git show --stat f47054d88`）：`.github/workflows/attendance-staging-window-runner.yml`、`scripts/ops/attendance-staging-window-runner-remote.sh`、`scripts/ops/attendance-window-runner-pipeline.lib.sh`、`scripts/ops/attendance-window-runner-pipeline.test.mjs`、`scripts/ops/staging-tasks-smoke.mjs`、`scripts/ops/staging-tasks-smoke.test.mjs`。都不进包：包只按 `scripts/ops/multitable-onprem-package-build.sh` 的 `REQUIRED_PATHS`（`:37-186`）逐项复制（`:590-592` 调 `copy_path`，`:229-241`），这份清单是一个个文件和少数目录，没有 `scripts/ops` 整个目录，也没有这六个路径或它们的上级目录。`PACKAGE-METADATA.json` 的 `includedRuntimeRoots` 里写着 `scripts/ops`（`:466`），那只是写进元数据的文字，不决定复制什么。演示机上没有东西运行它们：工作流只能手动触发（`workflow_dispatch`，`attendance-staging-window-runner.yml:71-72`），头注释写明只对 staging，找不到 staging 的 compose 文件就失败（`:67-69`）。 |
| #6144（MERGED 2026-09-29T05:04:03Z，`3a85b9c97`） | 见下面 6.2.1。演示机上预期没有「无法装载」分组，四步里只能验第 4 步（#6079 2026-09-29T06:07:40Z）。 |
| #5866（MERGED 2026-09-29T06:16:03Z，`28a7342e6`；owner 约 06:33Z 同意随 R61） | 客户在页面上看不到变化：没有界面（§5）。新增四个管理员接口：`GET /api/approval-template-groups/backfill/preview`、`POST …/backfill/execute`、`POST …/backfill/batches/:batchId/rollback`、`GET …/backfill/batches`（`packages/core-backend/src/routes/approvals.ts:2083`、`:2104`、`:2129-2133`、`:2159`），都先过 `authenticate` 再过 `approvalTemplateAdminGuard`（`:225`）：平台管理员直接放行，其余账号须持有 `approval-templates:manage` 或 `approvals:admin-templates` 之一（`rbacGuardAny`，`packages/core-backend/src/rbac/rbac.ts:119-131`）。**不写库就能核的：** 迁移后三张表都在，迁移已记录（在 §2.4 按名核对之外再跑一次，只出布尔和计数）：`BEGIN READ ONLY; SELECT to_regclass('approval_template_group_backfill_batches') IS NOT NULL AS batches_present, to_regclass('approval_template_group_backfill_batch_groups') IS NOT NULL AS batch_groups_present, to_regclass('approval_template_group_backfill_batch_links') IS NOT NULL AS batch_links_present, (SELECT count(*) FROM kysely_migration WHERE name = 'zzzz20260919090000_create_approval_template_group_backfill_batches') AS recorded; ROLLBACK;`，预期三个 `t`、`recorded = 1`。表里行数预期为 0（没人调用过「执行」接口）：`SELECT (SELECT count(*) FROM approval_template_group_backfill_batches) + (SELECT count(*) FROM approval_template_group_backfill_batch_groups) + (SELECT count(*) FROM approval_template_group_backfill_batch_links) AS backfill_rows;`（同样包在只读事务里）。**不要调用：** 这四个接口里「执行」会在客户服务器上建分组、挂接模板，「回滚」会撤销该批次写的挂接、归档该批次建的空分组（迁移头注释 `:16-18`）；「预览」只读，但读的是客户的审批模板。未经 owner 同意，这四个接口都不在客户服务器上调用。回帖：三个布尔、`recorded`、`backfill_rows`。 |
| #6162（MERGED 2026-09-29T07:04:00Z，`bf648922a`，即打包提交；修 issue #6155；按 PR head `d75b471f2` 原样合入，§1.0） | **需 owner 放行：** 停用再启用是对演示机自动化配置的两次写入，停用期间这条规则不触发。**对象：** issue #6155 所说的那条已有规则（触发器「记录删除时」，动作删除触发的那条记录）；R60 上它在面板停用后，重新启用被拒 400 `DELETED_TRIGGER_SELF_MUTATION`，旧机改用 SQL 恢复为启用（#6079 2026-09-29T00:37:05Z：「改为 SQL 按 id 把 `enabled` 恢复为 true（原状）」），所以它现在应是开着的。**谁能做：** 读规则列表与改规则的两条路由都先要 `canManageAutomation`，否则 403（`packages/core-backend/src/routes/univer-meta.ts:20794`、`:20802`；PATCH `:20860`、`:20871`）；它的基础判定是管理员角色，或持 `workflow:all`、`workflow:write`、`workflow:create`、`workflow:execute` 之一（`packages/core-backend/src/multitable/access.ts:126-131`）。**先不写库就能看的：** 规则开着时提示就会显示（`MetaAutomationManager.vue:2217-2220`），所以打开面板就能核对「已启用」与提示，不用点任何东西；这一步回帖一个布尔（提示是否出现）。下面两次点击（停用、再启用）仍需 owner 放行。**点什么：** 打开该表的「自动化」面板（标题 `meta-automation-labels.ts:1083`，`MetaAutomationManager.vue:11`），点这条规则卡片上的勾选框一次（文案「已启用」变「已停用」），再点一次。**应当：** 两次都成功，文案回到「已启用」（勾选框 `MetaAutomationManager.vue:723-731`，文案 `meta-automation-labels.ts:1103-1104`）；卡片的规则描述下出现提示「此规则在记录删除时运行，而它的动作需要这条记录，所以每次运行都会被跳过。如非预期，请改用其他动作，或换一个触发条件。」（`MetaAutomationManager.vue:736-743`，文案 `meta-automation-labels.ts:1108-1111`）；刷新面板后仍是「已启用」。对这条规则（动作是删除记录），提示说的是对的；对动作是「修改记录」「锁定记录」的同类规则，这句提示不准确，是已知问题（§6.3）。依据：面板的勾选只发 `{ enabled }`（`useMultitableAutomations.ts:83-90`）；后端对不带任何形状字段的 PATCH 不再做记录删除自改检查（`automation-service.ts:2084-2090`，条件里去掉了 `input.enabled === true`）；路由测试 `packages/core-backend/tests/unit/automation-deleted-trigger-reenable-route.test.ts:160-179` 走的正是「开着 → 停用 200 → 启用 200，库里的标志回到 true，只写了 `enabled` 和 `updated_at`」。**仍须被拒：** `enabled: true` 与形状字段（触发器类型、动作类型、动作配置、动作列表、执行方式）一起发，仍回 400 `DELETED_TRIGGER_SELF_MUTATION`，标志不变（同一测试文件 `:181-195`）；新建这个形状仍回 400（`:197-212`）；报文是「记录删除时触发记录已不存在，不能再修改/删除/锁定它」（`automation-service.ts:157`）。在规则编辑器里把规则改成这个形状再保存，也属于带形状字段的请求。这几项要写库，只在 owner 放行时做，不做就回帖「未做」。**失败时：** 面板重新读取规则，勾选框与文案按服务器存的状态显示，服务器的那句话留在面板的提示里（`useMultitableAutomations.ts:75-89`）。以上行号在 `bf648922a` 上与 `d75b471f2` 上相同（这 11 个文件在两个提交之间无差别）。回帖：两次点击是否都成功、刷新后是否「已启用」、提示是否出现（各一个布尔）。 |

#### 6.2.1 #6144：装载失败的数据源原地重存凭据

- **R61 起的恢复办法**（#6079 2026-09-29T05:07:05Z，取代同帖早先贴出的「用原账号新建一个同 id 的数据源」）：数据源 → 无法装载 → 重新输入凭据。凭据在原 id 上重存，属主、租户、工作区、作用域、连接、选项都不变（`packages/core-backend/src/data-adapters/DataSourceManager.ts:889-899` 的约定），一般不用重启。
- **谁能做：** 该数据源的属主，或平台管理员。代码依据：重封的权限判定 `DataSourceManager.ts:847-857`，「无法装载」列表的可见性 `:868-880`，路由先做这一步判定 `packages/core-backend/src/routes/data-sources.ts:815-824`。路由本身还要 `rbacGuard('data_sources', 'write')`（`:788`）；页面在「数据工厂」下，前端路由要 `integration:write`（`apps/web/src/router/appRoutes.ts:303-306`）。
- **页面在哪里：** 旧地址 `/data-sources` 转到 `/integrations/workbench#int-sec-connection`（`appRoutes.ts:208-211`），「外接数据源（物理连接与凭据）」一节（`apps/web/src/components/integration/IntegrationConnectionSection.vue:42-47`）。其中「无法装载」分组在 `apps/web/src/components/data-sources/DataSourcesPanel.vue:241-247`，「重新输入凭据」按钮在 `:270-276`，只对凭据解不开的源出现（`apps/web/src/data-sources/loadFailedCopy.ts:16-18`）。
- **R61 起不要再用：** 在装载失败的源的 id 上新建，回 409 `CONFLICT`（`DataSourceManager.ts:647-649`，`routes/data-sources.ts:585-589`）。R60 的新建只查已装载的源（`583dfdf1a` 上 `DataSourceManager.ts:481`）。
- **演示机上的预期：** R60 启动时唯一被跳过的 PLM 连接已在 2026-09-29 就地重加密，重启后 `Loaded 1 data sources`、没有 skipped（#6079 01:26:41Z）。所以上机后预期没有「无法装载」分组。旧机确认演示机上前三步不会出现（没有可重录的源），第 4 步仍可验（#6079 2026-09-29T06:07:40Z）。PLM 只读口令 owner 已决定不轮换（01:56:03Z）。
- **有装载失败的源时的验收**（四步取自 #6079 2026-09-29T05:07:05Z，逐条对过 `3a85b9c97` 上的代码，这些文件到 `bf648922a` 没有再改）：
  1. 重启后的后端日志里，该源仍被跳过装载，凭据重存之前都会这样（`DataSourceManager.ts:477-479` 记下失败，`:484` 打印「(N skipped)」）。
  2. 属主登录后，数据源页出现「无法装载」分组，该源显示「凭据无法解密，请重新输入」（`loadFailedCopy.ts:7-9`）。
  3. 重新输入凭据后，该源回到正常列表，不用重启（`DataSourceManager.ts:900-905`：按运行时路径装载并清掉失败记录）。例外：被 SQL 写武装、又没有在装载阶段钉住的源，凭据会保存，但要重启后才生效，界面提示「凭据已保存，但该数据源需要重启服务后才会生效。」（`loadFailedCopy.ts:21-22`，`apps/web/src/stores/dataSources.ts:121`）。之后手动触发一次试拉，预期不再报连接不可用：这半句只来自该评论，本文没有对代码核对。
  4. 非属主、非平台管理员的账号看不到「无法装载」分组（`DataSourceManager.ts:868-880`），对该 id 的请求仍是 404（`routes/data-sources.ts:783-786` 的注释，`:815-819`）。
- **回帖：** 分组是否出现（布尔）；出现时的条数，四步各自是否符合（布尔）。

### 6.3 已知问题（随 R61 上机，下一版改）

- **#6162 的新提示对部分规则不准确**（owner 约 06:57Z 决定照样上、提早发版，#6079 2026-09-29T07:08:05Z 的「已知问题」）：规则卡片上的提示说「每次运行都会被跳过」（`meta-automation-labels.ts:1108-1111`）。这只在动作是「删除记录」时成立：删除找不到触发的那条记录，这一步记为 `skipped`（`packages/core-backend/src/multitable/automation-executor.ts:3620-3625`）。动作是「修改记录」时，这一步记为成功，输出带 `noop: true`，什么也没改（`:3353-3361`）；动作是「锁定记录」时，同表的 `UPDATE` 改到 0 行，这一步同样记为成功（`:5720-5725`、`:5762-5766`）。提示对这两种动作的说法不对，但它们实际也不改动任何表格数据。（「锁定记录」这一步的事务里仍可能写内部记账行：运行时开关打开、且有真事务时，先写一条动作认领记录，`automation-executor.ts:5711`、`:3688-3690`、`:3702-3718`；运行日志也照常记这一步。）只是措辞问题，不影响规则能否重新启用。措辞修正下一版单独一个 PR。
- **换钥之前封存的其它存储：** 演示机上已知的一处已结清（C6）；通用的自检与重录路径是 #6164，不进 R61（§6.4）。

### 6.4 R61 不带（owner 2026-09-29 决定，#6079 2026-09-29T03:53:39Z、07:08:05Z）

| PR 或 issue（`gh` 现状，约 08:40Z） | 为什么不带、R61 上是什么样子 |
|---|---|
| #6151（OPEN，draft） | 修「源就绪预检」的 409：只从已验证令牌的租户声明取租户，带声明且能读该源的账号得到报告（该 PR 正文）。owner 决定放下一版，打包点记录之前不合入 main。所以 R61 上「源就绪预检」的「现在检查」（`apps/web/src/components/integration/stockPreparation/StockPreparationOpsPanel.vue:73-92`）与 R60 相同：路由那一段与这个面板从 R60 起没有改过（`git diff --stat 583dfdf1a bf648922a -- apps/web/src/components/integration/stockPreparation/StockPreparationOpsPanel.vue` 无输出；`git diff 583dfdf1a bf648922a -- plugins/plugin-integration-core/lib/http-routes.cjs | grep '^@@'` 列出的改动块在 R60 的第 527、814–875、9449、10443 行附近，都不在那段 409 `SOURCE_PREFLIGHT_NO_SOURCE` 附近：R60 上是 `:7030`，`bf648922a` 上是 `:7041-7046`）。下一版的条件②已由旧机的 Q1–Q4 回答（#6079 2026-09-29T06:07:40Z，§7）。 |
| #6153（OPEN，draft） | 按 owner 裁决不合（#6079 2026-09-29T02:27:53Z）：保持草稿，独有的测试并入 #6151 后关闭。它修的是同一个 409，01:34:20Z 回帖里「随 R61 上机」的说法已被这次裁决取代。 |
| #6157（OPEN，draft） | 修升级脚本「停服之后、替换之前」的缺口。owner 决定放下一版，打包点记录之前不合入 main。R61 上机照 C8 的手工恢复，升级脚本只从打包提交取（C8）。 |
| issue #6163（OPEN） | 用户管理页的两个接口在 500 时把底层错误原文回给页面（旧机 06:22:13Z 立项）。演示机上触发它的那一行已就地重加密（C6），所以 R61 上预期看不到；代码层的修正随后一版。 |
| issue #6164（OPEN） | 换钥之后「用到时才解密」的存储会逐个失败：需要全存储 `enc:` 可解性自检与数据源之外的通用重录路径（旧机 06:22:13Z 立项）。随后一版。 |
| 云课堂插件 | 不进 R61，随后一版（#6079 2026-09-29T07:08:05Z 的决定表；决策登记 R-26）。 |

### 6.5 打包点之后合入 main 的 PR

打包提交已固定为 `bf648922a`。之后合入 main 的 PR 都不进 R61，这里不再列回归。例如 #5972（2026-09-29T07:52:33Z 合入，`88b6e1967`，改 CI 工作流、测试、文档和一行 pin）。#6145、#6149 仍在开，合入后同样不进 R61。

---

## 7. 旧机侧状态未知的事项

2026-09-29 约 08:40Z 查 #6079：共 37 条评论，最后一条是 2026-09-29T08:37:31Z。2026-09-28T14:02:47Z 之后的十三条（2026-09-29T00:37:05Z、01:26:41Z、01:34:20Z、01:49:32Z、01:56:03Z、02:27:53Z、03:53:39Z、05:07:05Z、06:07:40Z、06:22:13Z、07:08:05Z、08:00:40Z、08:37:31Z）结清或改写了下表的几行。其中 03:53:39Z 是开发机转述的 owner 打包点决定；05:07:05Z 是另一开发窗口关于 #6144 的更正（§6.2.1）；06:07:40Z 是旧机的 Q1–Q4 与 C1–C7 回帖；06:22:13Z 是旧机关于用户管理页 500 的回帖（C6）；07:08:05Z 是开发机记录的打包点；08:00:40Z 与 08:37:31Z 是开发机关于打包提交 CI 的说明与结论（§1.0）。已结清的行留在表里、注明出处，方便对照。

| 事项 | 怎样算结清 |
|---|---|
| PLM 连接「新建同 id」绕行前的只读预检（12:51:17Z） | **已结清，不再需要。** 没有走「新建同 id」，旧机在演示机上就地重新加密了这条连接的口令（#6079 2026-09-29T01:26:41Z）。**R61 起**这条绕行本身也走不通：在装载失败的源的 id 上新建回 409（`DataSourceManager.ts:647-649`，`routes/data-sources.ts:585-589`）。R61 起的恢复办法是属主或平台管理员在 数据源 → 无法装载 → 重新输入凭据 原地重存（#6079 2026-09-29T05:07:05Z；§6.2.1）。 |
| 客户 DBA 是否已轮换 PLM 只读口令 | **已结清。** owner 2026-09-29 裁决不轮换，已接受风险（01:56:03Z）。 |
| 混表清理 2b（11:56:06Z 已定：保留与表名后缀一致的项目，另一项目的行置为无效） | **已结清。** 2026-09-29 已执行，走的是 SQL（00:37:05Z）。按本文原先的说明，直接 SQL 不留行修订（行修订由应用写，`multitable/record-history-service.ts`）；回滚靠同帖所说演示机上保存的 id 清单与回滚脚本。执行中停用又恢复的自动化规则，在界面上重新启用会被拒，已另立 issue #6155（01:49:32Z）；修它的 #6162 已合入，就是打包提交，上机后的回归见 §6.2（该规则现在应是开着的）。 |
| BOM 层级 0 根选择规则的客户预设是否已配 | 旧机只报拉取动作 `plm.stock-preparation.pull-bom.v1` 的配置里有没有 `rootSelection` 块（布尔）。客户对该规则尚未确认（`customer-anomaly-triage-20260918.md:9`「规则待确认」）；在演示机加配置并重启由 owner 定，重启方式见 `stock-prep-root-selection-config.md`。 |
| R60 之后客户反馈各项修复的界面逐项回归 | 旧机或 owner 逐项回帖通过或不通过。 |
| 确认账本表头改中文（2c） | owner 在旧机亲自执行后回帖计数。 |
| R60 收口：定时试拉 200 ready、非属主操作员 dry-run 通过 | **大部分已结清**（01:26:41Z）：PLM 连接已恢复，启动日志 `Loaded 1 data sources`、没有 skipped；定时试拉不再报 `CONNECTION_CANONICAL_UNAVAILABLE`，改报 409 `TARGET_SHEET_FOREIGN_PROJECT`（同帖：它拉的项目号不在该表里，守卫按设计拒绝），所以只要它还拉这个项目号，就不会是 200 ready；owner 会话对保留项目的试算回 200、`manual_confirm_required`。**还缺一项**：12:51:17Z「绕行后的核对」第 2 项要的是**非属主操作员**的试算，01:26:41Z 用的是 owner 会话。旧机回帖一个布尔。 |
| 备料预检 `checks.carryTargetBinding.ownershipState` | **已结清**（01:26:41Z）：`owned_by_this_project`，`carryWouldRefuseWith = null`，`ready true`，`blockerCount 0`。结转与导出一侧因此已有答案；「通知下一步」一侧仍看 C5。 |
| R60 wrapper 细节：pm2 命令解析到的路径、日志首段 `pm2 home:` 那一行、是否传了 `-Pm2Home` | 旧机在 R61 预检笔记里补上（10:34:09Z 回帖里没有）。原先这一行还问「经 WMI 起升级子进程时，环境变量怎么传进去」，那一问只决定选项 B 能不能用；owner 没有选 B（§1.0），这一问不再需要。 |
| 旧机对 C1–C7 的回帖 | **已结清**（06:07:40Z）：全部通过，C4 为未配置（§3）。上机当天再跑 C1、C3。 |
| `app.env` 重复键普查（13:52:05Z 请求，03:53:39Z 再请） | **已结清**（06:07:40Z）：无重复；C7 末尾的两个问题已回答（wrapper 不调用预检脚本，它自己的重复键检查只查三个键）。 |
| 演示机是否配置了交接链 | **已结清**（06:07:40Z）：未配置（C4）。「通知下一步」的回归行在演示机上不适用（§6.2）。 |
| 加密存储普查 | **已结清**（06:07:40Z、06:22:13Z）：判据全部满足；唯一的遗留（1 行钉钉目录集成的 `appSecret`）已在演示机上就地重加密（C6）。 |
| 演示机的产品模式（决定「任务」入口出不出现） | 旧机报一个枚举（默认、考勤专注、PLM 工作台）。 |
| 复制验收要用的测试身份是否存在 | 旧机报三个身份各自是否存在（布尔）。新建需要 owner 放行（§6.1）。 |
| 上机当月与次月的审计分区 | C3。06:07:40Z 当月、次月都在；上机当天再跑一次，上机若在十月，次月是 2026-11。 |
| 普通账号的登录令牌是否带租户声明 `tenantId`（Q1–Q4） | **已回答**（06:07:40Z）：有生效成员关系的组织 1 个；活跃账号按生效成员关系数 0 / 1 / 2+ 为 0 / 3 / 0，即每个活跃账号恰好 1 条，按 `packages/core-backend/src/auth/AuthService.ts:309`、`:359-360`、`:387-421` 的规则登录即带租户声明。它不决定 R61，只是下一版带 #6151 的条件②（§6.4）。 |

---

## 8. 本文未证实的说法

- **Kysely 的排序与单事务：** 读的是公开发布的 kysely 0.28.8 源码（`dist/cjs/migration/migrator.js`、`dist/cjs/dialect/postgres/postgres-adapter.js`），版本取自 `pnpm-lock.yaml:3222`。演示机包里实际装的版本没有核对。
- **421 → 426：** 421 来自 #6079 2026-09-28T10:37:13Z；5 条来自 §2.1 的命令在 `bf648922a` 上的输出。演示机上实际新增几行，要等上机后按 §2.4 按名核对。
- **复制入口谁能看到：** 读了门控代码（`univer-meta.ts:9259-9279`、`permission-service.ts:2032-2059`），没有实际运行。#6147 之后可见人群不变，依据是该 PR 正文的调用点分析，本文没有另外核对。
- **「任务」入口只在默认外壳出现：** 读了 `App.vue`。演示机用哪种外壳不知道。
- **审批「审批表单」页的改动：** 只确认了改动文件，没有核对具体控件和可见人群。
- **G14 真库用例：** #6112 正文说当年的红是测试夹具问题，已拆成 G14a、G14b。main `68578b56f` 的 Plugin System Tests 里，test (20.x)「Run multitable real-DB integration」这一步成功，宿主文件 `multitable-conditional-rule-enforce-realdb.test.ts` 32 例通过。CI 该步只输出到文件级，没有逐例核对 G14a、G14b 的名字。
- **pm2 在演示机上的行为**（pm2-runtime 无在线应用约 8–11 秒自退、命名管道对所有 home 通用）：来自 `handoff-r59-two-machine-20260924.md:34`、`:39` 在开发机上的实测。该文自己写明演示机上的 pm2 版本没有核对。
- **C6 的推断**（「R60 之前封存的 `enc:` 值用新密钥解不开」）：来自 #6079 2026-09-28T02:03:25Z 对密钥历史的叙述，加上 `encrypted-secrets.ts` 的代码。PLM 连接这一条已被实际证实：先是解不开，就地重加密后能装载（01:26:41Z）。其余存储没有逐条实测，计数只是可能受影响的值的上限。
- **C6 的日志切分方法与日志文件位置：** 沿用旧机 R60 复核的做法。pm2-runtime 主机上后端日志是否写到 `ecosystem.config.cjs:71-72` 配置的文件，没有核对。
- **演示机上后端的环境从哪里来：** 计划任务起的是 `start-pm2-runtime-persistent.bat`，再由它起 pm2-runtime（`handoff-r59-two-machine-20260924.md:22`）。这个 .bat 不在仓库里：`git grep -l 'MetaSheet-PM2\|pm2-runtime' bf648922a -- scripts ':!*.md'` 只列出升级脚本、它的测试，以及 #6138 之后的 `scripts/ops/multitable-onprem-preflight.sh`（只在一行注释里提到 pm2-runtime，`:706`），没有这个 .bat。它是否用 `ecosystem.config.cjs` 启动（从而「同一个键取第一次出现的那行」），要看这个 .bat 才能定。C7 与 `stock-prep-root-selection-config.md` 都受这一点影响。
- **根选择订正里「改了 `app.env` 之后不能只用 `pm2 restart`」：** 依据是升级脚本 `:1360-1362` 的注释（单纯 restart 时 pm2 不能可靠地重读环境），没有在演示机上核对。01:26:41Z 那次 `pm2 restart`（`PM2_HOME` 指向 `.pm2-runtime`）让后端 33 秒恢复，说明在运行中的 pm2-runtime 上 restart 能把后端拉起来；那次没有改 `app.env`，回答不了重读环境的问题。
- **#6146 的三条回归：** 读的是 `cd89c74dd` 上的界面代码与该 PR 正文，没有在浏览器里看过。
- **打包提交上的 CI：** 本文写到 2026-09-29 约 08:40Z 为止的状态（§1.0）：开发机的 CI 结论已在 #6079 08:37:31Z 回帖，其中 #6166 的 13 项必跑检查本文逐项对过；打包提交上被取消的 `test (20.x)` 的重跑还没有结果。#6160 上那个超时用例是否偶发，本文没有另外核对。以开发机在 #6079 的回帖为准。
- **#6162 的回归行（§6.2）：** 按 diff、测试与该 PR 正文写，没有在浏览器里看过。合入提交与 PR head 在这 11 个文件上逐字相同（§1.0），所以按 head 写的行号不变。
- **#6144 验收第 3 步的后半句**（重存后手动试拉「不再报连接不可用」）：只来自 #6079 2026-09-29T05:07:05Z，本文只核到重存后按运行时路径装载（`DataSourceManager.ts:900-905`），没有核对试拉那一路。
- **属主能不能自己打开数据源页：** 页面的前端路由要 `integration:write`（`appRoutes.ts:303-306`）。演示机上各数据源属主的账号有没有这个权限码，没有核对；平台管理员在前端路由守卫里是否不受这一条限制，本文没有读守卫代码去核对。后端重存凭据的权限只看属主或平台管理员（§6.2.1），另加 `rbacGuard('data_sources', 'write')`。
- **#6144 界面：** 读的是 `3a85b9c97` 上的组件代码（到 `bf648922a` 没有再改），没有在浏览器里看过。
- **回退到 R60 文件之后：** R60 代码在带着 R61 5 条迁移的库上运行，没有测过；「后端启动不跑迁移」读的是 `583dfdf1a` 上的代码（§2.2 表后），没有在演示机上核对。kysely 的缺失迁移检查读的是 0.28.8 已发布包的 `migrator.js`，没有实际触发过。
- **#6162 谁能做：** 只读到基础判定 `access.ts:126-131`；按表的权限会不会再收窄 `canManageAutomation`，本文没有逐项读。
- **C2b 里 PostgreSQL 的行为：** 默认主键名被占用时另起名字、`IF NOT EXISTS` 只跳过不检查形状、外键要求被引用列上有唯一约束，这三点依据的是 PostgreSQL 公开的规则，没有在真库上建表核对。上一版把三个 `_pkey` 名字列进 C2b、说它们被占用会让建表失败，是错的，本版已删。
- **#5866 的乱序执行（§2.2 第 1 条）：** 依据是 `migrate.ts:32` 与 kysely 0.28.8 的源码（见本节第一条），以及 421 行与迁移文件数相等这一点；R60 上机时只按名核对过它新增的 6 条，名字排在 #5866 那条之后的 8 条是否都已执行，是由行数相等推出来的。
- **#5866 的回填接口：** 读了路由与守卫（`approvals.ts:225`、`:2083-2159`），没有调用过，也不应在客户服务器上调用（§6.2）。
- **#6162 已知问题的运行结果（§6.3）：** 读的是 `automation-executor.ts` 三个动作的返回值，没有在库里跑过这三种规则。
- **开关清单外的两个变量**（本文只报告，不改清单）：#6158 的 `TASKS_WINDOW_ENABLED` 是 staging runner 的变量，不在 `scripts/ops/global-history-flag-manifest.mjs` 里；#5866 的 `ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP` 是迁移 down() 读的变量，也不在清单里（清单里没有任何 `ALLOW_` 开头的键，§4）。它们算不算「新增 env 开关必须登记」的范围，由负责清单的人定。
- **#6138 的修复建议比 C7 宽：** 预检脚本说「空值行挨着非空行时可以删」（`scripts/ops/multitable-onprem-preflight.sh:198`），C7 对这种情况要求先回帖。以 C7 为准。旧机的 wrapper 不调用这个脚本（06:07:40Z），所以这次上机碰不到。

---

## 参考

- 上机手册：`handoff-r59-two-machine-20260924.md` §2–§3。
- 复制数据表验收：`copy-sheet-r61-acceptance-checklist.md`。
- 上机沟通：issue #6079（2026-09-29 约 08:40Z 共 37 条评论；本文引用的评论：2026-09-28T02:03:25Z、06:39:16Z、08:24:49Z、09:01:43Z、10:34:09Z、10:37:13Z、11:56:06Z、12:51:17Z、13:52:05Z、14:02:47Z；2026-09-29T00:37:05Z、01:26:41Z、01:34:20Z、01:49:32Z、01:56:03Z、02:27:53Z、03:53:39Z（owner 打包点决定，请旧机现在跑 C1–C7）、05:07:05Z（#6144 合入后的恢复办法更正）、06:07:40Z（旧机的 Q1–Q4 与 C1–C7 结果）、06:22:13Z（用户管理页 500 与就地重加密，立 #6163、#6164）、07:08:05Z（打包点 `bf648922a`）、08:00:40Z（打包提交上 `test (20.x)` 被并发规则取消；13 项必跑检查里 4 项在合并后运行）、08:37:31Z（CI 结论：#6166 上 13 项必跑检查全部通过；重跑待回））。
- 决策登记：`decision-register.md` R-18、R-19、R-20；R-24（R61 打包点）、R-25（合并前免重跑 CI 的范围）、R-26（云课堂试用）。

---

## 附录：未采用的选项

下面两节是 owner 决定之前（2026-09-29 约 03:10Z）的事实核对，保留备查。其中的 `path:line` 以 `2888addb4` 为准，不再随 main 更新；「§2.4」「C2」等指本文正文。

### 附录 B：选项 B，在 migrate 这一步用 `MIGRATION_EXCLUDE` 排除两条任务迁移

**为什么没采用：** 排除变量传不进经 WMI 起的升级进程。R60 的 wrapper 经 WMI 在 ssh 会话外起升级子进程，会话里设的 `$env:MIGRATION_EXCLUDE` 到不了它（下文「怎么设」）；要用就得改 wrapper，并先在演示机上证明变量传到了。owner 选了原样打包（§1.0）。

`MIGRATION_EXCLUDE` 在代码里的实际作用（`packages/core-backend/src/db/migration-provider.ts`）：

- **读取：** 调用方没传 `excludedNames` 时读 `process.env.MIGRATION_EXCLUDE`，按逗号切分并去掉空白（`:267-272`）。每一项按「去目录、去 `.ts`/`.sql` 等扩展名」归一（`:167-178`），所以写迁移名或文件名都行。
- **效果：** `getMigrations()` 的最后一步把命中的名字**整条丢掉**（`:309-311`）。迁移表里不留任何历史标记，Kysely 根本看不到这两条。
- **谁读它：** 只有这个 provider。仓库里（测试与文档除外）只有 `migrate.ts:33` 构造它；`migrateToLatest` 的调用也只有 `migrate.ts:63`，后端启动时不跑迁移。
- **登记：** 没有登记在 `scripts/ops/global-history-flag-manifest.mjs`（`grep -n MIGRATION_EXCLUDE` 无结果）。provider 的注释说它是 CI 用的机制（`:36-39`），并明写 production 与 on-prem 的 `db:migrate` 这两种排除机制都不用（`:52-57`）。
- **怎么设（先看 wrapper 怎么起升级脚本）：** 升级脚本第 6 步先把 `docker/app.env` 导入自身进程（`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1:1885`），再起子进程 `node migrate.js`（`:1892`）。子进程继承的是**升级脚本那个进程**的环境，所以变量必须出现在升级脚本进程里。
  - R60 的 wrapper（rev 3）不在 ssh 会话里直接跑升级脚本：「升级子进程经 WMI 在 ssh 会话外运行」，教训 ①「远端子进程一律 WMI 启动 + 哨兵文件轮询」（#6079 2026-09-28T10:34:09Z）。经 WMI 创建的进程由 WMI 服务一侧创建，父进程不是 ssh 会话，拿不到 ssh 会话里用 `$env:` 设的变量。这一条依据的是 Windows 的进程创建方式，没有在演示机上核对（见本附录末尾）。wrapper 不在仓库里，本文没见过它怎么拼命令。
  - 所以**在 ssh 会话里 `$env:MIGRATION_EXCLUDE = …` 不起作用**。变量要放进 wrapper 交给 WMI 的那条命令里，在调用升级脚本之前设置；或者由 wrapper 显式给出新进程的环境。具体写法由旧机按 wrapper 的实际写法改，本文不给现成命令。要设的值是：
    ```text
    MIGRATION_EXCLUDE=zzzz20260926120000_create_task_p0a_tables,zzzz20260926120100_add_task_permissions
    ```
  - **上机前先证明变量传得到：** 用与升级脚本**完全相同**的起法（同一个 WMI 调用、同样的设变量方式），只把调用升级脚本的那一段换成只报布尔的 `[bool]$env:MIGRATION_EXCLUDE`，结果写进哨兵文件。报 `True` 才继续；报 `False` 就停下回帖，不要升级。
  - 不要写进 `app.env`。写进去之后，每次升级都会导入它（`Import-AppEnvFile`，`:1354-1394`），以后每次 migrate 都会排除这两条。
- **上机后的证据（选项 B 必须回帖）：** migrate 为每条执行成功的迁移打印一行 `migration "<名字>" was executed successfully`（`packages/core-backend/src/db/migrate.ts:41-47`），这些行出现在升级脚本的输出里，也就是 wrapper 收集输出的地方。选项 B 下这样的行必须**恰好两行**，名字正是复制数据表那两条（§2.2 第 3、4 条）。只要出现任务迁移的名字，就说明排除没有生效，回帖。§2.4 按名核对时，两条任务迁移应为 `applied = f`，行数 = 421 + 2。
- **C2 照做：** 排除没传到时，两条任务迁移照样会跑。所以只要包里有任务迁移，不管打不打算排除，都要先过 C2。
- **以后会怎样：** 这两条在迁移表里没有行。下一次不带该变量的 migrate 会把它们当作待执行，按名字顺序执行（`migrate.ts:32` 允许乱序历史；执行顺序见 §2.1）。那一次上机前要重做 C2。
- **界面上仍然看得到的：** 「任务」导航入口仍然出现（它是前端代码，只看 `tasks:read`，与迁移无关，见 §5）。`/api/tasks` 路由在 `TASKS_ENABLED` 未设时本来就不挂（`packages/core-backend/src/routes/tasks.ts:35-36`；返回 null 时 `packages/core-backend/src/index.ts:1879-1880` 不挂载）。三个 `tasks:*` 权限码不会写进 `permissions` 表；平台管理员不受影响（前端判定走管理员短路，`apps/web/src/composables/useAuth.ts:551-552`）。
- **迁移：** 2 条（复制数据表的两条）。
- **与已验证流程的偏差：** 用了一个未登记、按代码注释不用于 on-prem 的变量。它只对这一次升级进程生效，而且要改 wrapper，才能传进经 WMI 起的升级进程（上面「怎么设」）。按名核对（§2.4）时，预期名单是 2 条，而不是命令算出的 4 条。仍要做 C2。
- **`--confirm` 对被排除的迁移：** 环境里带着 `MIGRATION_EXCLUDE` 时，provider 把这两条整条丢掉（`migration-provider.ts:309-311`），`--confirm` 对它们报 2，而不是 1，所以只能用 §2.4 的 SQL 核对。

### 附录 C：选项 C，从 `b433ac814` 拉发布分支，拣选客户修复

**为什么没采用：** owner 没有选它；这条拣选链只在文本上模拟过，从没建成分支，也没跑过 CI。

- **例子（不是推荐）：** 在 `b433ac814` 上依次拣选 `5ac5b3ed1`（#6136）、`5e97c7116`（#6142）、`03202a1e9`（#6140）、`33047ef94`（#6143，仅测试），再拣 `cd89c74dd`（#6146）、`e48d3307b`（#6147）。#6139 可拣可不拣，界面都无变化。
- **可行性，只做了模拟：** `git merge-tree --write-tree` 逐条模拟这四次拣选，文本上都无冲突（不建分支、不动工作区）；在这四次的结果上再依次模拟拣选 `cd89c74dd`、`e48d3307b`，同样无冲突（2026-09-29 重做了整条链）。`2888addb4`（#6141）没有模拟：它改的 `apps/web/scripts/run-required-web-tests.tokens` 是 #5974 新建的文件，不拣 #5974 时这棵树里没有这个文件。四次拣选后的树与 main `33047ef94` 相比，差别正好是被排除的六个提交（`601990756`、`0d1da4929`、`5e8f643a5`、`bbb92dab7`、`5143aed65`、`68578b56f`）改过的那 106 个文件，其中包括 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的一行。这棵树没有构建过，也没跑过 CI。
- **迁移：** 2 条（复制数据表的两条）。
- **与已验证流程的偏差：** R59、R60 都切在 main 的 first-parent 提交上（§1.2），选项 C 的包提交不在 main 上，main 的 CI 从没对这棵树整体跑过。打包工作流可以在任意 ref 上 `workflow_dispatch`，`expected_sha` 照样能钉住提交，但 tag 要打在发布分支的提交上。

### 附录中未证实的说法

- **选项 B 的变量传不进经 WMI 起的进程：** 依据是 Windows 的进程创建方式（经 WMI 创建的进程由 WMI 服务一侧创建，不继承调用方会话里设的变量），加上 #6079 2026-09-28T10:34:09Z 对 wrapper 的描述。wrapper 不在仓库里，本文没见过它怎么拼命令，也没在演示机上试过。附录 B 的布尔探针能直接回答。
- **选项 C 的可行性：** 只做了文本合并模拟。没有构建，没有跑 CI，也没有算出发布分支上 `s6a-package-provenance-pins.json` 是否自洽。
