# 运行手册：批次标识装机前的现场只读探查（BI-6a / O-BI-9）

> **owner 闸门 ①（真实客户数据）。** 在客户机上运行本探查就是读取客户数据，**必须先有 owner 的书面授权**（O-BI-9），
> 授权里写明：目标库、只读身份（只有 `GRANT SELECT` 的角色）、执行窗口、`app.env` 的读取人、证据去向（私有记录在哪）。
> 没有授权就不跑；授权只覆盖本手册列出的两个文件，不覆盖任何写操作。开发机**从未**在任何客户系统上跑过本包。
>
> **values-free**：本手册不含主机、地址、口令、令牌、账号名或真实项目号。`<安装根目录>`、`<只读连接串>`、
> `<env 项目 id>`、`<env objectId>` 等占位符在执行时替换，替换后的值只记在私有记录里。
>
> 依据：设计定稿 design-final §14（BI-6a 行）、§7.3（上机顺序：先读探查结果，再翻开关）、§8（装机步骤与历史回填）、
> §10.1–§10.3（落地视图与列位置）、§18 O-BI-9。包与字段定义：`scripts/ops/stock-prep-pull-batch-site-probe-20261107/README.md`。

## 1. 它在装机流程里的位置

§7.3 的顺序是：装上带批次标识的 R 线包（开关关）→ **读本探查结果**、并回答首次批次规则（O-BI-2）→ owner 翻
`STOCK_PREP_PULL_BATCH_ENABLED`（O-BI-7）→ 逐表装机窗口（O-BI-1）。本探查只读、不改任何东西，可以在装新包**之前**
跑（今天的 R 线上就能跑），也应在每个装机窗口开始前对那张表再跑一次。

## 2. 执行（旧机惯例：PowerShell 5.1，psql 完整路径，连接串不回显）

1. 把 `scripts/ops/stock-prep-pull-batch-site-probe-20261107/` 整个目录按原样拷到客户机（UTF-8 无 BOM；
   `01-site-probe.sql` 与 `02-site-env.ps1` 是纯 ASCII，**不要**用记事本另存，免得加 BOM）。
2. 数据库那一半（只读角色）：

   ```powershell
   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
   $env:PGAPPNAME = 'stock-prep-pull-batch-site-probe-20261107'
   $env:PGCLIENTENCODING = 'UTF8'
   & '<psql 完整路径>' '<只读连接串>' -X -q -v schema=public -f 01-site-probe.sql *> probe.log
   Select-String -Path probe.log -Pattern '^PROBE_'
   ```

   客户反映的那个项目若可能还在 env 绑定的旧表上，再加两个参数跑一次（两个值从 `app.env` 里
   `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` 的目标 `objectId` 与运行时项目 id 私下读出，**不要**贴出）：
   `-v env_project_id=<env 项目 id> -v env_object_id=<env objectId>`。
3. 主机那一半（只读 `app.env` 与环境变量）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File 02-site-env.ps1 -EnvFile '<安装根目录>\docker\app.env' > site-env.log
   Get-Content site-env.log
   ```

4. 只有当 owner 需要把序号对回具体项目时，才另跑一次 `-v emit_private_map=1`，输出**只进私有记录**。

不要设置 `PGTZ`；不要用有写权限的账号；不要另加事务开关（包自己开只读事务）。

## 3. 完成态

- `probe.log` 最后一行必须是 `PROBE_RESULT … status=complete`；`site-env.log` 最后一行必须是
  `SITE_ENV_RESULT status=complete keys=5`。
- `status=incomplete` 时看 `reason=`（README §2）；**没有 `PROBE_RESULT` 行 = 中途夭折，按不完整处理，绝不当作
  「没有可报的」。** 不完整就不进入装机讨论。

## 4. 每一行对装机决策意味着什么

先用 `kind` 找到客户反映的那个项目（序号由 owner 用私有对照确认），再按下表读：

| 读到的 | 意味着 | 装机前要做的 |
|---|---|---|
| 项目只出现在 `kind=env`，或只出现在 `PROBE_COPY` | 该项目不在项目表上（F34 的 env 表 / 复制表两种原因） | 停：批次标识只装项目表。先由 owner 决定迁到项目表（建表路由）还是维持现状 |
| `kind=project … object_shape=adopted` | 认领来的旧沙箱表 | 照常可装，但 dry-run 要逐项核对 |
| `SITE_ENV key=MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED … effective_exact_true=no` | 项目表开关不是精确的 `true`，装机路由会 404 | 停：先按项目表开关手册处理 |
| `app_env_lines` 大于 1 | 同一个键写了多行，后端取第一行、升级脚本取最后一行 | 先把重复行清掉（另一个窗口） |
| `plm_lock=none` 或 `partial`（`plm_cols_unlocked>0`） | PLM 列没锁全，这张表今天还能看到「新建记录」（F34） | 装机第 I0 步会 409；同一窗口里先走修复路由补锁（O-BI-1 第 1 条：补锁后这张表失去「新建记录」，直到人工补充行随 main 包到来） |
| `plm_cols_missing>0` | 表上缺模板 PLM 列 | 先走表修复补列，再谈装机 |
| `first_view=default`（或 `other` / `tie`） | 今天点开表落在「全部记录」等视图 | 装机会把「备料填写视图」提到第一（O-BI-1 第 3 条，§10.5 原文要写进批复）；`tie` 说明当前顺序本身不确定 |
| `plugin_views<2` | 缺 `prep-fill` / `prep-todo` | 装机 I2 会补建，dry-run 会列出 |
| `views_with_frozen>0` | 有视图设了冻结列 | 左侧插入可能让冻结失效：装机要显式选 `placement`（left / right，§10.3） |
| `personal_order_overrides>0` | 有人用了个人列顺序 | 这些人会在自己列序的末尾看到两列（§10.3，计数写进批复） |
| `person_rows>0`、`person_rows_with_key>0` | 有人建的行；带唯一键的多半是右击复制 | 这些行**不打标签**、不当证据（§8.4 person 类），计数写进批复 |
| `manual_rows>0` | 人工补充行 | 两列显示「人工补充」（main 包之后） |
| `locked_rows>0` | 锁定行 | 跳过并计数（G12） |
| `trashed_rows>0` | 回收站里有本项目的行 | 默认不算「出现过」（O-BI-10） |
| `add_stamp_clusters` 与 `created_at_gap_clusters` | 两种口径下的历史拉取次数 | 与客户 / owner 自己记得的拉取次数对照（§8.5 `confirmHistoricalBatchCount`）；对不上就选别的 G 或 `unknown` 模式 |
| `add_stamp_rows` 远小于 `machine_rows` | 「新增」痕迹覆盖低（老行被后续拉取改写了痕迹） | 历史批次更多靠 `created_at` 推定，标签带「推定」 |
| `add_stamps_after_create>0` 或 `created_span_days=0` 而 `add_stamp_clusters>1` | createdAt 退化（§8.3 第 2 步） | 只能用锚点或 `unknown` 模式 |
| `automation_rules>0`、`automation_rules_elsewhere>0`、`webhooks_active>0` | 批量回填前要暂停的清单（§8.9） | 装机窗口开始前逐条暂停，窗口后恢复 |
| `writer_systems>0` / `writer_pipelines_active>0` | 有通用写入器指向这张表 | 装机窗口内停掉这些管道；受治理后写入器会被拒（PR-6） |
| `copies>0` | 这张表被复制过 | 复制表不受批次标识管理；告知客户以项目表为准 |
| `labels=en` 或 `SITE_ENV … resolves_zh_cn=no` | 表头不是中文 | 两列的列名语言随之（O-BI-5）；需要中文时先由 owner 决定改 `app.env` |
| `db_timezone_is_expected=no` / `db_utc_offset_is_expected=no`、`os_time_zone is_expected=no`、`TZ … set=yes is_expected=no` | 数据库或 Node 进程的时区不是客户的 | 批次日期「按服务器当天」会差一天：先由 owner 看私有值再定（O-BI-5） |
| `SITE_ENV key=STOCK_PREP_PULL_BATCH_ENABLED app_env_lines>0` | 开关键已经写进去了 | 停：O-BI-7 之前不应存在 |

## 5. 分享结果（values-free）

- 可以贴进 #6079 / issue / PR 的：`probe.log` 与 `site-env.log` 里以 `PROBE_`（`PROBE_PRIVATE` 除外）和
  `SITE_ENV` 开头的行，原样。它们只含序号、封闭词表和整数。
- 只能进私有记录的：`PROBE_PRIVATE` 行、连接串、`app.env` 路径、env 项目 id / objectId、owner 对序号的解读
  （「序号 1 是客户反映的那个项目」可以说，项目号不能写）。
- 贴之前用 `Select-String -Path probe.log -Pattern 'PROBE_PRIVATE'` 确认没有混进私有行。

## 6. 跑完之后

把两份日志的公开部分贴给开发机；开发机按 §4 出一份逐表的装机前置清单（补锁、视图、位置、暂停清单、历史拉取次数），
连同 dry-run 一起交 owner 做 O-BI-1 批复。本探查不改任何数据，没有回滚步骤。
