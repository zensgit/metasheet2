# 批次标识装机前的现场只读探查包（2026-11-07，BI-6a / O-BI-9）

两半：

- `_preamble.sql` + `01-site-probe.sql`：**数据库那一半**，只含 `SELECT`，在一个 `REPEATABLE READ READ ONLY`
  快照里读，只用 CTE（不建临时表、视图、函数），不需要安装任何程序包。
- `02-site-env.ps1`：**主机那一半**（Windows PowerShell 5.1，ASCII），只读 `app.env` 与进程级环境变量，
  只打印计数和「是 / 否」。数据库看不到的三件事在这里：项目表开关是否恰为 `'true'`、表头语言是否解析为
  zh-CN、Node 进程的时区。

它回答 design-final §14 BI-6a 行（O-BI-9）列出的问题：每个项目用的是哪种表（登记的项目表 / env 绑定表 /
复制出来的表）、PLM 列锁、打开表时落在哪个视图、冻结列与个人列顺序、行的创建时间分布与「新增」痕迹覆盖、
人建的行（含右击复制）、人工补充行、锁定行、回收站行，以及指向这些表的自动化规则、webhook 与通用写入器。

> **生产执行状态：未执行。** 本包**从未在任何真实系统上跑过**。在客户机上运行属于读取客户数据（owner 闸门 ①），
> 须 owner 另行授权：目标库、只读身份、窗口、证据去向逐项由 owner 定。执行步骤见
> `docs/development/takeover-beiliao-20260821/runbook-stock-prep-pull-batch-site-probe-20261107.md`。
> 下文的验证全部在一次性合成 PostgreSQL 上、全假数据完成。

## 1. 唯一的执行方式

```bash
export PGAPPNAME=stock-prep-pull-batch-site-probe-20261107
export PGCLIENTENCODING=UTF8
psql "$READONLY_DATABASE_URL" -X -q -v schema=public -f 01-site-probe.sql > probe.log 2>&1
grep -h '^PROBE_' probe.log
```

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PGAPPNAME = 'stock-prep-pull-batch-site-probe-20261107'
$env:PGCLIENTENCODING = 'UTF8'
psql $env:READONLY_DATABASE_URL -X -q -v schema=public -f 01-site-probe.sql *> probe.log
Select-String -Path probe.log -Pattern '^PROBE_'
powershell -NoProfile -ExecutionPolicy Bypass -File 02-site-env.ps1 -EnvFile '<安装根目录>\docker\app.env' > site-env.log
```

可选变量（全部只作输入，**任何一个都不会出现在默认输出里**）：

| 变量 | 作用 |
|---|---|
| `-v schema=<schema>` | 固定 `search_path` |
| `-v tenant=<tenant id>` | 只看这一个租户的登记行（不传 = 全部）；序号随之重排 |
| `-v env_project_id=<project id> -v env_object_id=<object id>` | 同时探查 env 绑定的那张表（两者都取自 env 表动作 JSON 的目标，私下读取） |
| `-v env_sheet_id=<sheet id>` | 可选交叉核对：与推导出的 env 表 id 不一致就判该表不完整 |
| `-v expected_tz=<IANA 时区>` | 时区比对的期望值，默认 `Asia/Shanghai` |
| `-v emit_private_map=1` | **私有输出**：另打印 `PROBE_PRIVATE` 行（序号 → objectId / env 项目号 / 复制表 id），只进私有记录 |

前置条件：只读角色（`GRANT SELECT`）；psql ≥ 10；服务器编码 UTF8；pgcrypto 的 `digest()` 可调用。
前言固定 `default_transaction_read_only=on`、`statement_timeout=120s`、`lock_timeout=5s`、
`idle_in_transaction_session_timeout=30s`。不要设置 `PGTZ`（否则读到的是客户端时区）。

## 2. 输出与完成态

```
PROBE_SITE server_encoding_utf8=yes expected_tz_known=yes db_timezone_is_expected=… db_utc_offset_is_expected=… registry_rows=… webhooks_active_total=… webhooks_active_unbound=… writer_systems_total=… env_input=given|absent tenant_filter=off|on
PROBE_PROJECT kind=project ordinal=1 registry_status=active object_shape=derived status=complete plm_lock=… … add_stamps_after_create=…
PROBE_PROJECT kind=project ordinal=2 registry_status=archived object_shape=adopted status=incomplete reason=sheet_id_mismatch
PROBE_ENV_SHEET status=complete in_registry=no projects=… rows_without_project=… plm_lock=… …
PROBE_PROJECT kind=env ordinal=1 status=complete row_count=… …
PROBE_COPY ordinal=1 source_kind=project source_ordinal=1 depth=1 deleted=no row_count=… person_rows=… locked_rows=… locked_fields=… view_count=… automation_rules=… webhooks_active=…
PROBE_RESULT file=01-site-probe.sql status=complete targets=… complete=… incomplete=0 copies=… env=absent|complete|incomplete
```

- `PROBE_RESULT` 永远是最后一行。`status=incomplete reason=target_checks_failed` = 至少一张表自检失败（那几行没有
  数字，其余行可用）；`reason=server_encoding_not_utf8 | pgcrypto_digest_missing | schema_missing missing=<表.列,…>`
  = 整体没跑（`missing=` 只列表名和列名，不含值）。**没有 `PROBE_RESULT` 行 = 中途夭折，按不完整处理，绝不
  解读为「没有可报的」。**
- 每张表的自检：`sheet_id_mismatch`（推导的表 id ≠ 登记 / 给定的表 id）、`sheet_missing`（表不存在或已软删）、
  `field_missing`（没有推导出的 `projectNo` 字段）。

## 3. 每个字段的定义

项目 = 这张表上 `projectNo` 单元格等于项目号的行（与项目作用域读取同一个等值过滤）。「有创建人」= `created_by`
按 JS `trim()` 去空白后非空。

| 字段 | 定义 |
|---|---|
| `object_shape` | `derived`：objectId 符合项目表形状 `plm_stock_preparation_sandbox_p_<24 位十六进制>`；`adopted`：其它（按 runbook 认领的旧沙箱表） |
| `plm_lock` / `plm_cols_locked` / `_unlocked` / `_missing` | 模板全部 `plm_system` 列（20 列，插件测试钉死与模板一致）中：带 `humanWriteLock = 'plm_system'` 的、在表上但没锁的、表上没有的。`all` = 20 列都在且都锁；`none` = 一列都没锁 |
| `labels` | 「有效」列的列名：`zh`（有效）/ `en`（Active）/ `other`（被改过名）/ `missing`。即建表那一刻的表头语言 |
| `view_count` / `first_view` / `views_at_first` | 视图数；按上下文路由的排序（`created_at ASC`，没有次序键）排在第一的视图：`default`（全部记录）/ `prep-fill` / `prep-todo` / `other` / `none`；若最早时间上有多个视图则为 `tie`，`views_at_first` 给出并列个数 |
| `plugin_views` | `prep-fill` / `prep-todo` 两个插件视图在表上的个数 |
| `views_with_frozen` | `config.frozenLeftColumnIds` 是非空字符串数组的视图数（是否真冻结还取决于列序左前缀，装机 dry-run 会再算） |
| `personal_order_overrides` | 这张表的视图上 `fieldOrder` 非空的个人配置数 |
| `automation_rules` / `_enabled` / `_elsewhere` | 挂在这张表上的规则数 / 其中启用的；其它表上、配置里写到这张表 id 的规则数 |
| `webhooks_active` | 绑定到这张表、启用中的 webhook 数。站点行另给全部启用数与未绑定数（未绑定的收不到事件） |
| `writer_systems` / `writer_pipelines` / `_active` | `kind = 'metasheet:multitable'`、`config.objects.*.sheetId` 指向这张表的外部系统数；以它们为目标的管道数 / 其中 `active` 的 |
| `copies` | 这张表被「复制数据表」复制出来的表数（含复制的复制） |
| `sheet_rows_all_projects` | 表上全部在册行（不论项目） |
| `row_count` / `active_row_count` | 本项目的行 / 其中有效（只有 JSON 布尔 `false` 算失效） |
| `machine_rows` | 无创建人且不是人工补充行（插件写入不带创建人） |
| `person_rows` / `person_rows_with_key` | 有创建人且不是人工补充行（新建记录、导入、右击复制）/ 其中带非空唯一键的（右击复制会带走 PLM 唯一键） |
| `manual_rows` | 唯一键是以 `manual:v1:` 开头的字符串 |
| `locked_rows` | `meta_records.locked` 为真 |
| `trashed_rows` | 回收站里这张表、`projectNo` 等于本项目的行 |
| `created_span_days` / `created_days` | 最早与最晚 `created_at` 相差的整天数 / 不同的日历日个数（按数据库会话时区） |
| `created_at_gap_clusters` | 机器行按 `created_at` 排序后，间隔超过 30 分钟（设计默认 G）的断点数 + 1；无机器行为 0 |
| `stamped_rows` | 「最近刷新决定」非空的行 |
| `add_stamp_rows` / `add_stamp_iso_rows` | 决定为 `add` 的行 / 其中「最近刷新时间」是合法 ISO-8601 时刻（日期真实存在）的 |
| `add_stamp_clusters` | 上述合法时刻的不同原文个数 = 产生过行的拉取执行数的下界（F24′） |
| `add_stamps_after_create` | 计划时刻晚于建行时间 5 秒以上的 `add` 行（设计 §8.3 第 2 步的「createdAt 退化」信号） |

复制表的字段与视图 id 在复制时全部重新生成（`copy-sheet-remap.ts`），推导 id 对它不成立，所以 `PROBE_COPY`
只给表级计数（`locked_fields` = 带 `plm_system` 锁的列数；复制会去掉锁，正常为 0）。

## 4. 去值与时区的取舍

- 默认输出只有序号、封闭词表和整数。没有项目号、objectId、表 / 字段 / 视图 id、租户、名称、URL、单元格值或时间戳。
- **时区只报「是 / 否」**：`db_timezone_is_expected`（会话 `TimeZone` 设置名是否等于期望值）与
  `db_utc_offset_is_expected`（当前 UTC 偏移是否与期望时区相同；期望时区未知则 `unknown`）。理由：装机决策只需要
  知道「批次日期按哪天算」是否与客户一致；而一个单站点部署的时区名（尤其不是默认值时）会缩小站点所在地，属于
  可识别信息。答「否」时，由 owner 在私有记录里看实际值。语言同理（`labels` 只给 `zh / en / other`）。
- objectId 是项目号的摘要，可被暴力还原；env 项目号就是值。所以 `PROBE_PRIVATE` 行只在 `-v emit_private_map=1`
  时打印，只进私有记录，绝不进 #6079、issue 或 PR 正文。私有对照与探查在同一个快照、同一条查询里，序号一致。

## 5. 为什么 R 线上能直接跑

包读的每一个（表, 列）都在 P1 里先查 `information_schema`；缺任何一个就输出
`PROBE_RESULT … reason=schema_missing missing=…` 并退出，不报错。这些表列在 `onprem-r74`、`onprem-r81`、
`onprem-r82`（`a7f23ec17`）和 main 上都存在（逐个对过创建它们的迁移；插件测试 SP-02 在 main 上钉住）：

| 读的对象 | 来源 |
|---|---|
| `integration_stock_prep_project_target` | 迁移 087 |
| `meta_sheets` / `meta_fields` / `meta_views` / `meta_records` | 多维表核心迁移；`meta_views.config` 自 `zzzz20260321124000`；`meta_records.created_by` 自 `zzzz20260406093000`；`locked` 自 `zzzz20260612140000`；`copied_from_sheet_id` / `copied_at` 自 `zzzz20260927120500` |
| `meta_view_personal_configs` | `zzzz20260705150000` |
| `meta_records_trash` | `zzzz20260617120000` |
| `automation_rules` | `zzzz20260413120000` / `zzzz20260414100000` |
| `multitable_webhooks`（含 `sheet_id`） | `zzzz20260414100002` / `zzzz20261019100000` |
| `integration_external_systems` / `integration_pipelines` | 迁移 057 |
| `pg_timezone_names`、`information_schema.columns` | PostgreSQL 系统视图 |

表 / 字段 / 视图 id 的推导（`provisioning.ts` `stableMetaId`）、模板 `plm_system` 列表、视图逻辑 id、`'add'`
决定值在 R82 与 main 上一致。

## 6. 已知局限

- 只看**登记过的**项目表和（给了参数时）env 表；没登记、也不是 env 表的旧表只能经由「复制」关系出现。
- `views_with_frozen` 只看冻结列表非空，不算列序左前缀；`personal_order_overrides` 不区分用户是否还在。
- `automation_rules_elsewhere` 是按表 id 文本出现做的近似（配置里出现这张表的 id 就算）。
- 主机那一半读不到 pm2 启动时 shell 里临时设置的变量，只看 `app.env` 与 Machine / User 级环境变量；
  `MULTITABLE_BUSINESS_TIMEZONE` 是非法时区 id 时后端会回落到 `Asia/Shanghai`，脚本会答「否」（偏保守）。

## 7. 验证（只连一次性合成库）

- 插件封闭测试 `plugins/plugin-integration-core/__tests__/stock-preparation-pull-batch-site-probe.test.cjs`
  （SP-01..SP-06）：前言与单一只读快照；无写语句、无持久对象、无 psql 文件 / shell 元命令、SQL 与 ps1 都是 ASCII；
  只读封闭表清单；每个必需（表, 列）都由其创建迁移声明；`plm_system` 列表、视图逻辑 id、`'add'`、锁属性、
  列名、`frozenLeftColumnIds`、`fieldOrder`、项目表 objectId 形状、通用写入器目标形状都钉到产品代码；id 推导
  与 JS 空白字符集；默认输出只拼接封闭列；时刻只在严格 ISO 且日期存在时才转换；主机脚本只打印计数与是 / 否、
  解析规则与 `ecosystem.config.cjs` 一致。
- 真库用例 BI-PROBE-RD-01 / -02（挂在已接线的 stock-prep 真库宿主
  `stock-preparation-p4-repair-once-realdb.test.ts` 下，不改工作流）：用真实开表流程建合成项目表与 env 表，由 CI
  机器自带的 `psql` 真跑本包，逐字段核对每个数；默认输出不含哨兵项目号 / objectId / 表 id / 租户；env 表 id
  不符与登记表 id 不符各输出一行 `incomplete`、不给数字。

本地复现（只连一次性合成库）：

```bash
DATABASE_URL=postgresql://<user>@127.0.0.1:5432/<scratch db> METASHEET_REAL_DB_TEST_STEP=1 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/stock-preparation-p4-repair-once-realdb.test.ts -t BI-PROBE
```

本包没有 `scripts/ops/__tests__` 子测试（`EXPECTED_OPS_TESTS_COUNT` 不变），也没有列进
`ops-sql-pack-verify.yml`。

## 8. 文件清单

```
scripts/ops/stock-prep-pull-batch-site-probe-20261107/
├── _preamble.sql     （共享执行契约，与 6d-1a 普查包同一份）
├── 01-site-probe.sql （数据库那一半）
├── 02-site-env.ps1   （主机那一半）
└── README.md         （本文件）
```
