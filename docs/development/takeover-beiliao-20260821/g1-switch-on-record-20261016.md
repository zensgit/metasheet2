# G1「一个项目一张备料表」开启记录（2026-10-14 / 10-15 / 10-16，旧机/运维机）

> values-free：不含主机地址、口令、令牌、账号名；项目只写「项目 A / 项目 B」，计数照实。承接 `r66-deploy-record-20261013.md`；运行手册 `runbook-stock-prep-project-sheets-switch-on-20261014.md`（#6397）。各步原帖见 #6079（2026-10-14 至 10-16）。

## 0. 为什么开、开之前的诊断

- 每日试拉 10-08 起失败有两层：① 客户 PLM 拒绝只读登录（10-14 14:26 owner 在界面重存凭据后恢复）；② 一表一项目守卫（#5860，R63 起）：动作绑定的 744 行旧表里有 354 行项目 A 的有效行，每日任务拉项目 B 被 409 `TARGET_SHEET_FOREIGN_PROJECT`。不是故障，是设计。
- owner 10-14 定：按「一个项目一张备料表」走；旧 744 行表**留作只读参照、不登记、不删**（与 10-08 裁决 Q3 一致）；项目 A 也新建表重拉（D15 方案②）——代码里没有「认领现有表」的路径，旧表人工列只有 3 行审批状态有值，几乎无损。
- 5 张 0 行遗留表软删（可从回收站恢复）；「BOM Cleanse」是数据工厂 staging 源对象，保留。

## 1. owner 决策（runbook §0，10-14「按建议」）

D1 开；D2 接受「再关 = 停用 A 以外的拉取」；D3 不任命拉取人员（平台管理员建表）；D4 清单 = `stock-prep_frontline` + `stock-prep_puller` + `stock-prep_admin`（`stock-prep_developer` 否；`approvals_operator` 不能进清单）；D5 接受表级写同时开字段 / 视图管理；D15 是；D7 是；D8a 是 / D8b 否；D9a、D9b 暂留；D10 否；D11 否；D13 是；D14 当时即开。「上」同时覆盖向两张新建项目表写入。

## 2. 服务器侧（2026-10-14 17:32–17:34 演示机时间）

- **放行前终审**：最高档审阅 2 BLOCKER + 3 MUST-FIX 全部改完再上——重启可能「假成功」（加管道 / online 门禁、`--update-env` 失败判定、T0 后必须见 `Plugin loaded: plugin-integration-core`）；计划任务路径不等任务离开 Running；失败时保留维护标志；门禁补全 §1.3 / §1.6；psql 出错显式返回。
- 门禁：三个新键都不存在；沙箱写入门两键在且指向部署原有目标；登记表与项目表 0；五个角色在、旧角色 0；客户包目录无旧角色、无 `fieldWritePolicies`；试拉任务无 `--apply`。
- §2.0 每日试拉脚本换为 `onprem-r66` 版（blob 与手册所记一致、服务器端 SHA-256 一致），开关关着时手动触发 result 0、行为不变。
- §2.1 备份 `pre-g1-20261014-173246.dump`（3.29 MB，`pg_restore -l` 可读）与 `app.env` 备份。
- §2.2 追加 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED=true` 与 `MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS=stock-prep_frontline,stock-prep_puller,stock-prep_admin`；成员页开关不写。
- §2.4 重启走 `--update-env` 路径（与 10-12 云课堂开关同路；只加键不删键，手册对该路径的两条顾虑不适用；已请开发机订正手册 §2.4 那句「云课堂用的是计划任务路径」），30 s 健康；启动行：数据源 1、两个插件加载、错误日志 0 行、加密存储探针 0 无法解密；旧表 744 行不变。

## 3. 建表与写入（2026-10-15，owner 管理员会话）

| 步 | 结果 |
|---|---|
| §3.1 探针 | 项目登记列表 200（0 条）；A、B `absent`、可建；`preflight.projectSheets.enabled=true`、清单 3、登记 0；成员页仍 404 |
| 06:00 试拉（新脚本） | A 记 `skipped_project_sheet_absent`，result 0 |
| 建 A 表 | 201：授权 3/3、客户包 21 列装上、待填写视图、**总览表同时建成**（授读 3/3） |
| A dry-run | 新增 652、跳过 0（与预期一致） |
| A apply（首次） | **全部失败**：652 × `select_option_not_found`——新项目表「最近刷新决定」列没有选项（合约选项集只由 option-sync 写，且其路由固定写模板默认对象，写不到项目表）；登记行仍记 `applied`（缺陷） |
| owner 选「1」 | A、B 表该列经字段编辑接口补上合约 5 个选项（add / update / skip / inactive / manual_confirm），保留原元数据 |
| A apply | 成功，写入 652 |
| 建 B 表 → dry-run → apply | 201 → 新增 211、无需人工确认 → 写入 211 |
| 总览刷新 | 2 个项目、行数与两表一致；总览表系统盖章只读 |
| 授权核对 | 两张项目表上三角色各一行表级写；总览表三角色各一行读；无 `approvals_operator`、无 `_developer` |
| 旧表 | 744 行、最后修改时间不变、未登记 |
| 每日试拉 | 项目清单改为 A、B |

## 4. 「拉取变慢」的诊断与临时措施

- 现象：写入后，界面上 A 的 dry-run 经 nginx 60 s 504、每日试拉 A 120 s 超时；B 时快时慢（6–59 s）。
- 初判「随已有行数线性变慢」**不成立**（已在 #6079 撤回）：静态核读整条 dry-run 路径没有逐行 IO；实测 dry-run 期间后端 CPU ≈ 2 秒、本机数据库会话全部 idle，后端到 PLM 的 SQL Server 只有 1 条连接，逐次串行读（A 1,414 次、B 460 次），每次往返随客户 PLM 负载在约 15–130 ms 之间变化。10-16 08:10 同一个 A（已有 652 行）只要 18 s，比空表时还快。
- 临时措施（owner「按建议执行」，10-16）：每日试拉 env 加 `MS_TIMEOUT_MS=600000`（备份已留），手动触发 result 0：A 18 s、跳过 652；B 6 s、跳过 211——两表与 PLM 完全一致。
- 界面上 PLM 慢的时段仍会 504，需 R67 修。

## 5. 交给 R67（owner 定一次打包，#6079 2026-10-16）

1. 建项目表时写入模板合约选项集，并给已建项目表修补入口（对演示机 A、B 应为幂等无变化）。
2. apply 失败时登记行记失败与错误码，不记 `applied`。
3. PLM 展开读批量或有界并发。
4. 界面 dry-run 走后台任务，避开 nginx 60 s。
5. runbook 给出大 BOM 项目的 `MS_TIMEOUT_MS` 建议值。

同包还有目录同步三支（#6420 钉钉开通 openId 路径、#6421 目录配置改选择器、#6422 同步邮箱回退企业邮箱）。

## 6. 回退口径

按 runbook §5：用 §2.1 的 `app.env` 备份覆盖或把开关改 `false`，同路径重启。回退后登记行、项目表及数据、总览表、授权都保留（只增不删）；拉取回落到旧表，拉 A 以外的项目会被一表一项目守卫拒绝。不删任何表、不跑迁移 087 / 088 的 `down()`。

## 7. 脚本与台账

运维机 `metasheet-ops/releases/g1/`（上机脚本 `g1-switch-on.ps1`、预检、CPU / 等待采样、超时调整脚本、台账 `LEDGER.md`）；`metasheet-ops/releases/r66/tools/`（试拉项目改指脚本）。
