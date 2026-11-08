# 运行手册：批次标识的逐表装机窗口（BI-6b / O-BI-1 / O-BI-8）

> **owner 闸门。** 本手册里每一次 `install` / `abort` 都是**生产写入**（owner 闸门 ②），要逐表先拿到 owner 对 O-BI-1 的书面批复，批复编号就是请求里的 `approvalRef`。翻开关 `STOCK_PREP_PULL_BATCH_ENABLED` 是 O-BI-7，另批。现场只读的 `dry_run` 按 C14.1 与现场探查（O-BI-9）用**同一份授权**，见 §2。没有批复的步骤一律不做。
>
> **values-free。** 本手册不含主机、地址、口令、令牌、账号名、真实项目号或图号。项目号写 `<项目号>`，令牌文件写 `<令牌文件>`，后端地址写 `<后端地址>`，租户写 `<租户 id>`。替换后的值只记在私有记录里。示例物料只用 S-01 / P-07 / X。
>
> **依据。** 设计定稿 design-final §7.3、§8、§9、§10、§12.4–§12.5、§18；决策登记 **R-65**（含协调方裁定 C2、C4、C6、C7、C10），以及 C13 / C14（2026-11-08 owner 裁决）。路由、请求字段、应答字段和退出码按 **BI-2（#6818）合入 main 时的样子**写（main `c058f8442`，是 #6818 末版 head `c8fc4287d` 的 squash，内容相同）。R83 R-line 要带同一套路由（不另改路由、字段或退出码）；R-line 自己的说明（若有）在 R83 分支上。R83 分支已带上 BI-2（#6818 的移植提交 `87e28d40a`，路由、字段和退出码不变）；装包前仍先核对包里有 `scripts/ops/stock-preparation-pull-batch-install.mjs`。已合入 main 的部分：纯模块 #6801、账本 #6808、两条车道与状态读 #6814、设置页 #6815、前端各行 #6817、装机路由与运维脚本 #6818、现场探查 #6803（手册 `runbook-stock-prep-pull-batch-site-probe-20261107.md`）。

> **R 线说明（R83，onprem-r82 之上；本仓 R 线分支专有）。** 客户装的是 R83。R83 **没有项目写入锁**（写入租约、持有者校验、宿主写入栅栏、代次推进都不在这条线上）。所以本手册里描述 main 的几处在 R83 上是这样的：
> - 装机没有 I1「取写入租约」和 I7「释放租约并推进代次」：应答里 `generationBumped` 恒为 `false`。其余保证照旧：I3 先把计划持久化（表进入 `installing`）再写第一个格子，只填空格，崩溃后用同一摘要续跑，从 I3 起所有拉取车道都拒（409 `STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS`），I3 之前已在跑的拉取由 I5 的重新扫描接住（`rows_after_plan`，再 dry_run 用 `extension.planDigest`）。
> - 409 `STOCK_PREP_PROJECT_WRITE_LOCKED` 在 R83 上不会出现；定时拉取遇到正在装机的表，是在试算看到 `pullBatch.reason = installing` 或写入被 409 `INSTALL_IN_PROGRESS` 拒时记 `skipped_pull_batch_installing`。
> - 因为没有租约，窗口内**暂停定时拉取并通知拉取人员不要拉**（§1 第 5 条、§5 第 1b 步）是硬要求，不只是兜底。原因有两个：
>   - I3 之前已在跑的拉取会新建行，由 I5 接住（`rows_after_plan`，见上条）；在 I5 之后、收尾之前落下的行，收尾时算作一行补缺行（状态 `history_gap`，之后用补缺把它标成「推定」，§7）。
>   - 拉取的更新 / 停用补丁会按它读到的旧数据整行改写，**可能把装机已写上的批次格子改回空**。I5 会把它算成 `rows_unlabelled`，原样再 install 即可补上。多维表的写入栅栏开关 `MULTITABLE_ENABLE_WRITER_FENCE`（默认关）打开时会把这种竞争串行化；是否改它是另一项 owner 决定，本手册不改它。
> - **中止（abort）只在确认没有拉取在跑、也没有安装请求还在执行时才做；客户端超时后用同一个摘要（digest）重跑 install，绝不 abort**（§6 最后一条，P2-9）。原因：没有租约，与还在写的 install 同时发生的 abort 会先放开 C7 设置锁，install 随后照样写上计划的标签，表停在 `pending`、带标签、锁已放开。批次号不会错，数据也不丢，但这张表的格式锁没了，之后改格式会造成新旧格式混用。
> - **包里没有两个运维脚本。** R83 安装包不带 `scripts/ops/stock-preparation-pull-batch-install.mjs` 和 `scripts/ops/stock-preparation-scheduled-pull.mjs`（文首「核对包里有该脚本」在 R83 上的结果就是没有）。从包里操作用 §4 的 `Invoke-RestMethod` 写法；要用 `node` 脚本，只能从打了标签的源码（`onprem-r83`）复制，**绝不从 main 复制**。主机上如果还有 R83 之前复制的定时拉取脚本，它会把 409 `INSTALL_IN_PROGRESS` 当成错误：没有危害（服务端已拒绝写入），但窗口内会显示一次失败的定时运行。

## 0. 一页看懂

| 顺序 | 动作 | 谁批 | 写不写生产 |
|---|---|---|---|
| 1 | 装 R83 包，开关**关**，owner 接受它作为回退底线 | O-BI-3 | 迁移 105（只加表） |
| 2 | 跑现场探查（BI-6a），可以加跑只读 `dry_run`（C14.1） | O-BI-9 | 否 |
| 3 | 首次批次规则：**已裁定为规则 A（按物料）**，见 owner 文本 O-BI-2 | O-BI-2 | 否 |
| 4 | 翻开关，**随即**设好租户默认值（C6） | O-BI-7 | 只写设置 |
| 5 | 逐表装机窗口：(a) 批复前只读 `dry_run` + 问客户历史拉取次数 → (b) 填写并发出 O-BI-1 → (c) 「同意」之后：补锁 → 停拉取、停自动化 → 窗口内重跑 `dry_run`（摘要必须等于批复里的）→ (d) `install` → 核对 → 恢复 | (a) C14.1 / O-BI-9；(c)(d) O-BI-1（每张表一份） | (a)(b) 否；(c)(d) 是 |
| 6 | 以后某张表出现补缺行时，走补缺（gap pass），同样是一个窗口 | O-BI-1 | 是 |

第 4 步（翻开关）之前没有任何表会被打标签（§7.3：开关翻之前一行都不盖）。从第 4 步起，**新建的项目表一诞生就带着两列**（design §9），所以即使一次装机都没做，§8 的回退底线也可能已经越过。

第 5 步里，补锁（`options/sync`）、暂停拉取、暂停自动化都是**写入**，由这张表刚拿到的 O-BI-1 覆盖，必须在「同意」之后做。它们不是开窗口的前提。

## 1. 前置条件与批复覆盖的写入

第 1–3 条是开窗口的前提，任何一条不成立，就不开窗口。第 4–6 条是这张表 O-BI-1 批复**覆盖的写入**：批复前只读出要做什么（§5 第 1 步的只读 dry_run 和探查），写进批复；拿到「同意」之后、窗口内 dry_run 之前才做（顺序见 §5）。


1. **R83 已装，开关是关的，owner 已接受它为回退底线。** `app.env` 里没有 `STOCK_PREP_PULL_BATCH_ENABLED` 这一行（探查 `SITE_ENV key=STOCK_PREP_PULL_BATCH_ENABLED app_env_lines=0`）。装包时 `RunMigrations 1`，迁移 105 已跑。回退底线见 §8。
2. **现场探查已跑完，结果已读过。** `probe.log` 最后一行 `PROBE_RESULT … status=complete`，`site-env.log` 最后一行 `SITE_ENV_RESULT status=complete keys=5`。按探查手册 §4 做出一份逐表的装机前置清单，内容包括：补锁、视图、列位置、暂停清单、历史拉取次数的两种口径。客户反映的那个项目必须是 `kind=project`。如果它只在 env 表或复制表上，就停下来，先让 owner 决定。
3. **项目表开关是精确的 `true`**（`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`）。否则装机路由一律 404。
4. **PLM 列补锁（批复后做）。** 探查显示 `plm_lock=none` 或 `partial`，或者 dry_run 的 `plmLock.unmarked > 0` / `plmLock.missing > 0` 时，装机会被拒（409 `STOCK_PREP_PULL_BATCH_PLM_LOCK_REQUIRED`）。补锁走已有的修复路由：`POST /api/integration/stock-preparation/options/sync`，请求体 `{"projectNo": "<项目号>"}`（修复腿会给这张表的 `plm_system` 列标上人工只读）。它和装机写在**同一份** O-BI-1 批复里，拿到「同意」之后才调用。后果要写进批复：补锁以后，这张表普通的「新建记录」入口被隐藏（R70 行为）；大家改用「+ 新增人工补充行」加行，前提是这张表的「允许人工补充行」是允许，默认就是允许（R-68）。窗口里用 `GET /api/integration/stock-preparation/projects/<项目号>/target/manual-rows` 核对这个开关：`policy` 是 `allowed`（`policySource` 为 `default` 或 `set`）。如果是 `disabled`，批复里要写明补锁后这张表不能再加行。`plmLock.missing > 0`（表上缺模板 PLM 列）要先补列，补列不是这个路由的事，要先停下报开发机。
5. **暂停定时拉取，告诉拉取人员窗口内不要拉（批复后做）。** 暂停每日计划任务（`scripts/ops/stock-preparation-scheduled-pull.mjs` 所在的那条任务），并在群里通知拉取人员。BI-2 之后，定时拉取遇到正在装机的表，会记成 `skipped_pull_batch_installing`（不算失败）。这只是兜底，不能代替暂停。
6. **批量回填前的暂停清单。** 探查报出的 `automation_rules>0`、`webhooks_active>0`、`writer_pipelines_active>0`，以及按建行来源统计的 `_automation>0` / `_public_form>0`，逐条列出来写进批复，拿到「同意」之后、窗口内 dry_run 之前暂停，窗口结束后恢复（设计 §8.9）。回填走插件记录路径，本身不触发订阅者。暂停是为了防止窗口内有别的写入方在这张表上建行。

## 2. 现场只读 dry_run 的授权口径（C14.1）

- owner 批准现场探查（O-BI-9）时，同一份授权**也覆盖**装机路由的 `dry_run`。它只读，应答只有计数、封闭词、ISO 时间和标签（序号 + 服务器日期），按序号标识项目，不带项目号（P2-6）。
- 前提是 R83 已装好：路由和运维脚本都是随 R83 才有的。所以「翻开关之前的 dry_run」是指**装好 R83 之后、翻开关之前**。
- 开关关着时，dry_run 只读宿主数据，**不碰账本**：用内置默认值（`settings.source: 'built_in'`），`provisional: true`，`refusals` 里有 `disabled`。这时的计数、布局、PLM 锁状态都可以拿来读，**但它给的 `planDigest` 不能拿去装机**：计划摘要随捕获的设置（规则、格式）和行的覆盖时刻变化，翻开关、设租户默认值、表上多一行都会让它变。装机用的摘要必须在窗口里、翻开关并设好默认值之后，**重新** dry_run 得到。
- `install` / `abort` 不在这份授权内，每张表每一次都要 O-BI-1。

## 3. 翻开关与设租户默认值（O-BI-7 之后立刻做，C6）

1. owner 批准 O-BI-7 之后，在 `app.env` 里追加 `STOCK_PREP_PULL_BATCH_ENABLED=true` 一行，然后重启。只认精确的小写 `true`，每次请求都读。备份、追加、核对、重启的做法照「项目表开关」手册 `runbook-stock-prep-project-sheets-switch-on-20261014.md` §2.1–§2.4（加键走「导入 `app.env` + `pm2 restart --update-env`」）。
2. **重启后立刻**打开「数据来源与体检」页的「批次标识设置」，设好租户默认值，**然后才**恢复定时拉取。设置页和三个设置路由只在批次标识开关与项目表开关都是精确的 `true` 时才存在，否则 404 `STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED`，页面上也看不到。
   - 四项设置：首次批次判定（按物料 / 按位置）、批次格式（第N批（日期） / 第N批）、打开表时的默认视图（改成备料填写视图 / 保持现场现在的默认视图）、两列位置（最左 / 最右）。O-BI-2 已定规则 A，所以「首次批次判定」保持**按物料**。
   - 原因：开关翻开以后**新建的项目表一诞生就就绪**（design §9），并在诞生时捕获当时的租户默认值。重启和设默认值之间这段空档里诞生的表，捕获的是内置默认值（即 10-27 设计）。表上有了标签以后，规则和格式就锁死了。
   - 租户默认的列位置**永远不能豁免** `…_PLACEMENT_REQUIRED`：冻结列会失效的表，装机时必须逐表明确选择位置（§5 第 4 步）。
3. 核对：`GET /api/integration/stock-preparation/pull-batch/settings` 回 200。保存过的租户默认值，`source` 是 `tenant`，并带版本号。如果 owner 决定完全沿用 10-27 设计，没有改任何一项，那么 `source: 'built_in'` 也成立，值是一样的。核对四项的值与批复一致就行。

## 4. 调用方式（PowerShell 5.1，令牌不回显）

运维脚本是 `scripts/ops/stock-preparation-pull-batch-install.mjs`（BI-2，#6818）。环境变量：`MS_API`（后端地址）、`MS_TOKEN`（**绑定到本租户**的管理员令牌，不带租户声明的令牌会被拒）、`MS_TENANT_ID`。项目清单文件每行一个项目号，`#` 开头的行和空行忽略。输出每个项目一行 JSON，用**输入序号**标识，不带项目号，可以原样外贴。

```powershell
$env:MS_API = '<后端地址>'
$env:MS_TENANT_ID = '<租户 id>'
$env:MS_TOKEN = (Get-Content -Raw -LiteralPath '<令牌文件>').Trim()
node scripts/ops/stock-preparation-pull-batch-install.mjs --projects-file '<项目清单文件>' > dryrun.jsonl
Remove-Item Env:\MS_TOKEN
Get-Content dryrun.jsonl
```

脚本外贴的那一行只有一组白名单键：`mode run K planDigest refusals resolved reason count remaining written skipped historyStatus provisional`，另外还有 `confirmCountInferred` 和 `extension`。要看完整的 dry_run 应答（分簇、分类计数、布局、PLM 锁、设置、`requires`），就直接 POST 同一路由。完整应答也是 values-free 的（P2-6），但只进私有记录，对外只按序号摘要：

```powershell
$body = '{"mode":"dry_run","confirmProjectNo":"<项目号>"}'
Invoke-RestMethod -Method Post -Uri "$env:MS_API/api/integration/stock-preparation/projects/<项目号>/target/pull-batch?tenantId=$env:MS_TENANT_ID" `
  -Headers @{ authorization = "Bearer $env:MS_TOKEN"; 'x-tenant-id' = $env:MS_TENANT_ID } -ContentType 'application/json' -Body $body |
  ConvertTo-Json -Depth 8 > dryrun-full-private.json
```

退出码：`0` 成功；`1` HTTP 失败或被拒；`2` 用法错误；`3` install 有应答但没有收尾（计划之后又有新行，或还有行是空的），要再跑一次。

## 5. 逐表顺序（一张表一个窗口）

### 第 1 步　批复前的只读 dry_run（开关已开、默认值已设；还没补锁、没停拉取）

`{"mode":"dry_run","confirmProjectNo":"<项目号>"}`。可选 `gapMinutes`（1–1440，默认 30）。用了就记下这个值 G，后面每一次 dry_run 和 install 都带同一个 G。

- 它只读，属于 C14.1 / O-BI-9 的授权（§2），不需要 O-BI-1。
- 这时补锁还没做，`plmLock.unmarked` / `missing` 就是批复里要写的数，`refusals` 里出现 `plm_lock_required` 是正常的。
- 用它的计数、布局、`requires`、`planDigest` 和第 3 步客户报的次数，填好 O-BI-1，交给 owner。

### 第 1b 步　「同意」之后：补锁、暂停，再跑一次窗口内 dry_run

1. 补锁（§1 第 4 条，`POST …/options/sync`）。
2. 暂停定时拉取，通知拉取人员；暂停 §1 第 6 条列出的自动化规则、webhook 和管道。
3. 再跑一次 dry_run，带同一个 G。这时必须 `plmLock.unmarked = 0`、`missing = 0`，`refusals` 里除了 `placement_required` 以外什么都没有。
4. 它的 `planDigest` 必须**等于批复里的那个**。不相等（批复后又有人拉了、改了设置等），就不装：看清变了什么，按新的 dry_run 重新填 O-BI-1，重新批复。

### 第 2 步　读应答（只按序号与计数说话；第 1 步和第 1b 步都照这张表读）

| 字段 | 含义 | 要做的 |
|---|---|---|
| `switchOn` / `provisional` | 开关是否开着；`provisional: true` 表示开关关着，这只是参考 | 窗口内必须是 `true` / `false` |
| `run` | `first_install`（首次装机）/ `continue`（上次没跑完，接着跑已持久化的计划）/ `resume_aborted`（中止过、表上已有该计划的标签）/ `gap_pass`（补缺）/ `noop`（已就绪，没事做） | `noop` 就不必装 |
| `plan.K` | 计划推定出的历史拉取次数（簇数） | 第 3 步拿它和客户报的次数对 |
| `plan.clusters[]` | 每簇的 `k`、`evidence`（`plan_time`：有「新增」戳，精确；`created_at`：靠建行时间推定）、`label`（如 `第1批（推定，YYYY-MM-DD）`）、`rows` / `active` / `inactive`、`startAt` / `endAt` | 读簇数和每簇行数，日期只看是哪一天 |
| `plan.degenerate` | 建行时间退化，无法按时间推定 | 为真时只能用锚点，K 对不上就只能选 `unknown` 模式 |
| `plan.unplacedRows` / `interleavedRows` / `exceptionCount` | 放不进簇的行 / 并发拉取交错的行 / 例外数 | 写进批复 |
| `plan.joins` / `interleavedGapRows` | 仅补缺：并入在用批次的行 / 并不进去、本次记「历史批次未知」的行 | 写进批复 |
| `classes` | `machine`（机器行）、`labelled`（两格都有值）、`half`（一格有值）、`blank`、`unplaced`、`locked`（锁定行，跳过）、`manual` / `manualBlank`（人工补充行 / 其中两格还空的）、`person`（人建的行：新建记录、导入、右击复制，**不打标签、不当证据**）、`nonPlugin`（无创建人但不是插件行：自动化、公开表单等，C4，**不打标签**）、`unboundPrefix`、`unaddressable` | `person`、`nonPlugin`、`locked` 的计数写进批复 |
| `layout` | `firstView`（今天打开表落在哪个视图）、`viewsWithFrozenColumns`、`viewsLosingFrozen`（放最左会失去冻结列的视图数）、`personalOrderOverrides`（用个人列序的配置数）、`trashedRecordCount` | `viewsLosingFrozen > 0` 时批复里要选位置 |
| `columns` | 两列是否已在（`pullBatch` / `firstPullBatch`）、`locked`、`placementApplied` | 首装时一般都是假 |
| `views` | `fill` / `todo` 是否存在；`rewrite` 列出要重写的插件视图，`resetsConfig: true` 表示那个视图的其它配置会被重置 | 有 `rewrite` 时写进批复 |
| `plmLock` | `fieldCount`、`marked`、`unmarked`、`missing`、`readBeforeWrite` | 第 1 步：数字写进批复；第 1b 步：必须是 `unmarked = 0`、`missing = 0` |
| `settings` | 这张表将采用的规则、格式、语言、落地视图、位置，以及来源（`captured` 已捕获 / `tenant` 租户默认 / `built_in` 内置）；规则为按位置时 `notes` 带 `rule_f_today_active_state`（C10） | 规则应为 `material`（O-BI-2） |
| `requires` | 装机要带的东西：`planDigest`、`confirmHistoricalBatchCount.inferred`（= K）/ `unknownMin`（0）、`historyMode`（续跑时是已持久化的那个模式）、`placement`（`required` / `optional` / `fixed`）、`landing`（`optional` / `fixed`） | 照它填请求 |
| `fixedPoints` | `matching`（已有值且与计划一致）、`conflicting`（与计划冲突）、`toWrite`、`manualToWrite` | `conflicting > 0` 就停下报开发机 |
| `refusals` | 封闭词：`disabled`、`band_unavailable`、`plm_lock_required`、`placement_required`、`config_locked`、`plan_conflict`、`layout_unavailable`、`landing_unavailable`、`extension_degenerate`、`nothing_to_install` | 除了要在请求里补上的 `placement_required`，其余任何一个都不装 |
| `planDigest` / `extension` | 计划摘要；`extension` 表示续跑时计划之后又有新行，它给出扩展后的 K 与摘要 | 装机时原样带上（续跑带 `extension.planDigest`） |

### 第 3 步　问客户这张表历史上拉过几次（attested count，在发 O-BI-1 之前）

这一步和第 1 步一起，在批复**之前**做：次数和模式要写进 O-BI-1。

- 要问的是：「这个项目的备料表，过去一共拉取过几次、每次都新增了行？」答的人是客户或 owner 本人。**谁答的、什么时候答的记在私有记录里**，对外只写「已核实，等于 K」或「不等于 K」。
- 对照：dry_run 的 `plan.K`，以及探查的 `add_stamp_clusters` / `created_at_gap_clusters`。
- 等于 K：用 `historyMode: 'inferred'`（默认），`confirmHistoricalBatchCount = K`。
- 不等于 K：在**第一笔写入之前**处理。可以换一个 `gapMinutes` 重新 dry_run（只有按时间间隔切的地方会动，锚点不会拆开），对上了就用新的摘要，并把新的 G 记下来，第 1b 步和第 4 步都带这个 G。对不上就改用 `historyMode: 'unknown'`：每一条被覆盖的机器行两格都写「历史批次未知」，不写推定批次，第一个实时批次是 `第{客户报的次数+1}批`。
- `plan.degenerate` 为真时，只有 K 恰好等于客户报的次数才能用 `inferred`，否则只能用 `unknown`。

### 第 4 步　装机（带齐全部确认项）

请求体（封闭键，多一个键就是 400 `STOCK_PREP_PULL_BATCH_INSTALL_REQUEST_INVALID`）：

```json
{ "mode": "install", "confirmProjectNo": "<项目号>", "approvalRef": "<O-BI-1 批复编号>",
  "planDigest": "<dry_run 给的 64 位十六进制>", "confirmHistoricalBatchCount": 0,
  "historyMode": "inferred", "placement": "left", "landing": "promote_prep_fill", "gapMinutes": 60 }
```

- **dry_run 用了 `gapMinutes` 时，install 必须带同一个 `gapMinutes`**（脚本 `--gap-minutes`）。首装和补缺时，install 会按请求里的 `gapMinutes` 重新算计划，不带就按默认 30 算；`gapMinutes` 在摘要里，算出来的摘要就和 dry_run 的不一样，结果是 409 `…_PLAN_CHANGED`。dry_run 没带 `gapMinutes` 时，install 也不带（上例的 60 只是示意）。

- `approvalRef` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$`。**不能有 `/` 和 `#`**：引用 #6079 的评论写成 `6079:<评论 id>`，不能写 `6079#<评论 id>`。登记行写成 `R-65`，逐表批复写成 `O-BI-1.S-01` 这种形式。
- `placement`：dry_run 的 `requires.placement` 是 `required` 时必须给，`left` 表示接受 n 个视图失去冻结列，`right` 表示放到最后一列之后。已应用过的位置不能改（409 `…_CONFIG_LOCKED`）。
- `landing`：不给时用租户默认值。已应用过的不能改。
- 用脚本时：`--install --ordinal <n> --approval-ref <ref> --plan-digest <hex> --confirm-count <int> [--history-mode inferred|unknown] [--placement left|right] [--landing promote_prep_fill|keep_current] [--gap-minutes <int>]`。应答是 `write_budget`（每次请求最多写 2000 行）时，脚本会自动用同一摘要再 POST，最多 200 次。
- **续跑**（`continue`）时必须带**同一个** `historyMode`（dry_run 的 `requires.historyMode`），换模式会被拒。

装机的内部顺序（design §8.2，BI-2 实现）：I0 读取并检查，不写 → I1 取写入租约 → I2 加两列、补锁、补插件视图、提升落地视图 → I3 **先把计划持久化（Txn A）再写第一个格子**，从这一刻起所有拉取车道都拒（409 `STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS`）→ I4 只填空格 → I5 重新扫描 → I6 收尾（Txn B）→ I7 释放租约并推进代次。R 线（R83）没有 I1 和 I7（无写入租约、不推进代次，见文首 R 线说明）。

应答：

| 应答 | 意思 | 做什么 |
|---|---|---|
| `resolved: true` | 收尾了，`historyStatus` 是 `backfilled` 或 `born_empty` | 去第 5 步 |
| `reason: 'write_budget'` + `remaining` | 这次写满额度了 | 同一请求再 POST（脚本自动做） |
| `reason: 'rows_after_plan'` + `count` | 计划之后又有新行（窗口内有人拉了） | 重新 dry_run，用 `extension.planDigest`（K 变了就重新确认次数）再 install |
| `reason: 'rows_unlabelled'` + `count` | 还有没写上的空格（被人同时编辑；R83 上也可能是拉取的补丁把已写的格子改回空，见文首 R 线说明） | 原样再 install |
| 409 `…_PLAN_CHANGED` | 摘要和当前计划不一致 | 先查 install 是否带了和 dry_run 同一个 `gapMinutes`；否则重新 dry_run，看清变了什么，必要时重新批复 |
| 409 `…_HISTORY_COUNT_MISMATCH` | 次数和 K 对不上 | 回第 3 步 |
| 409 `…_PLAN_CONFLICT` | 已有标签与计划不一致 | 停，报开发机 |
| 409 `…_PLACEMENT_REQUIRED` / `…_PLM_LOCK_REQUIRED` | 见第 2 步 | 补上后再来 |
| 409 `STOCK_PREP_PROJECT_WRITE_LOCKED` | 有别的写入者持有这张表（main；R83 上不会出现） | 等它结束 |

### 第 5 步　核对

1. 状态路由 `GET /api/integration/stock-preparation/projects/<项目号>/target/pull-batch`：`ready: true`，`ledger.historyStatus` 为 `backfilled`（或 `born_empty`），`columns.pullBatch` 与 `columns.firstPullBatch` 都为真，`columns.locked = 2`，`views.bandHiddenIn` 为空，`rows.gap = 0`。`reasons` 里只允许出现参考项：`landing_not_fill`（选了保持现状时）、`person_rows_present`、`locked_rows_present`。
2. 项目备料页那一行：「最近拉取批次：第N批（日期） · 共 K 批」，或者「批次标识已启用，还没有拉取批次……」。如果显示「安装中，暂停拉取」或「暂停：有 n 行未登记批次」，就还没完。
3. 首个视图：在多维表左栏点开这张表，落地就是**备料填写视图**（`landing` 为保持现状时不变），只显示有效行，两列都看得见；「全部记录」能看到全部行。按序号外贴：「序号 n：ready=true，K=…，firstView=fill」。

### 第 6 步　恢复拉取

恢复定时拉取任务，通知拉取人员可以拉了，恢复 §1 第 6 条暂停的规则和管道。下一次有新增物料的拉取会记为：`inferred` 模式 `第{K+1}批`；`unknown` 模式 `第{客户确认的次数+1}批`，与 K 无关（不写推定账本行，`history_batch_count` 等于确认次数，design §8.5）；补缺之后接在 `base + 确认次数` 之后。窗口到状态路由答 `ready: true` 或执行了 `abort` 时关闭（design §12.5）。

## 6. 中止（abort）与 C7 锁的释放

- 请求：`{"mode":"abort","confirmProjectNo":"<项目号>","approvalRef":"<批复编号>"}`，或用脚本 `--abort --ordinal <n> --approval-ref <ref>`。要开关开着，要 O-BI-1 批复。
- 效果：`installing` → `pending`（首装）或 → 原来的已收尾状态（补缺）。计划保留，标为已中止。之后拉取恢复：首装中止的表照常拉、不盖批次；补缺中止的表按补缺规则处理。
- **只能中止正在 `installing` 的表**，否则 409 `not_installing`。**已经写上标签的补缺不能中止**（409 `plan_labels_on_sheet`），只能把它跑完。
- **C7：设置锁什么时候放开。** 设置锁（`settings_locked_at`）只在一种情况下清除：中止的是**首次装机**，而且表上没有任何一行带着这份已持久化计划的标签，项目也没有在用批次。应答 `settingsReleased: true` 就是这种情况，之后可以改这张表的规则 / 格式，下一次 dry_run 也可以换一份计划（比如换一个 G）。表上已经有该计划的标签时，锁保留（`settingsReleased: false`），下一次 dry_run 是 `resume_aborted`，只能把同一份计划继续跑完或扩展（永久性规则：已经落到表上的计划只能扩展，不能替换）。
- R 线没有写入租约：只在**确认没有拉取在跑、也没有安装请求还在执行**时才中止；客户端超时后用同一个摘要重跑 install，绝不 abort（P2-9，原因见文首 R 线说明）。

## 7. 补缺（gap pass）

- **什么时候需要。** 开关关过一段时间，或者某些拉取没盖上批次，表上就会有「补缺行」（机器行、两格都空）。这时拉取车道暂停盖批次：状态路由 `reasons` 有 `history_gap`，项目备料页显示「批次标识暂停：有 n 行未登记批次，请联系管理员补登记」。拉取照常进行，只是新增的行不记批次。
- **怎么做。** 和首装用同一个路由、同一套闸门、同一个窗口流程（§1 第 4–6 条、§5）。dry_run 的 `run` 是 `gap_pass`，计划只覆盖补缺行，编号从 `max(已有批次号, 历史次数)` 往后接。
- **精确并入。** 补缺行如果和某个带实时标签 L 的行有**完全相同的计划时刻**，就算同一次执行，本次直接写 L（不带「推定」）。数量见 `plan.joins`。
- 其余补缺行按 §8.3 聚簇。第 3 步要问的是**补缺这段时间里**拉了几次。装完以后，历史次数变为 `base + 确认次数`，下一个实时批次号接在补缺之后。
- 比在用的最新批次更早、又并不进去的补缺行，本次记「历史批次未知」，计数见 `plan.interleavedGapRows`。
- 补缺写上标签以后不能中止（§6）。

## 8. 回退底线（design §12.4）

- **一旦任何一张表有了这两列，R 线就只能向前修复。** 绝不能回退到不带剥离逻辑的构建：旧构建会把两列当普通列算进存档修订，第一次「批次存档」就会写出一批内容完全相同的重复批次（#6475 第 2 轮那一类问题）。
- **在任何一张表装上两列之前**，可以回退：用旧构建 + `-RunMigrations 0`。迁移 105 只加表，旧代码可以直接跑在迁移后的库上。不要带着迁移步骤重跑旧包。
- 所以要按 §0 的顺序：R83 开关关着装上，owner 接受它作为底线，然后才翻开关、才装机。
- 万一必须回退：整个窗口内 `MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED` 保持关闭，并把预期会出现的重复批次登记进决策册。
- 关开关不等于回退：开关关了以后，账本零 IO，两列和已写的标签都还在，新行留空，等以后补缺。宿主仍会给人工补充行写「人工补充」（C10）。

## 9. 外贴与私有记录

- 可以外贴（#6079 / PR / issue）：脚本输出的 JSON 行（按序号）、状态路由的 `ready` / `reasons` / 计数、「序号 n 的次数已核实等于 K」。
- 只能进私有记录：项目号、序号与项目的对照、完整 dry_run 应答文件、报次数的人、令牌与地址、批复原文里的任何业务值。
