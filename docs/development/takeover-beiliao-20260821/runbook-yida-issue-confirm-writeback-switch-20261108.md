# 宜搭发料确认日期回写：打开开关前的核对（Y9）

> **用途**：设计基线 v2.3 §7.3（D5 / D9 / D13 a）的「发料确认日期回写」在 #6812 接线后由开关 `INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED` 控制，默认关闭。本页只列打开这个开关之前必须核对的几条，以及打开之后的运行与告警说明；**打开开关会写客户生产备料表的「发料确认日期」列，属 O 层，由 owner 单独批准并亲自操作**。Claude 不设置、不建议代为设置、不远程操作这个开关。
> **values-free**：回报只写 True/False、行数与面板上显示的结果类别 / 错误码；不抄项目号、业务键、记录号或任何字段内容。
> **行号**：本页的 `path:line` 都按 #6812 分支头核对；合并前按当时的目标 commit 重新核对。

## 打开开关之前

1. **先给 owner 授予经角色的操作档位，再打开开关（不可颠倒）。** 回写在租约内对每一行重新核对 owner 的权限（D13 a）：只认**经角色授予**的 `stock-prep:admin`，或同时经角色授予 `stock-prep:operate` 与 `stock-prep:read`（`packages/core-backend/src/integration/yida-issue-confirm-writeback-authority.ts:51-54`）。直接写进 `user_permissions` 的授权、`role:admin`、`integration:admin` 都不算。
   **后果（写明）：开关打开而 owner 没有这一档位时，每一条已确认（acknowledged）的发送都会得到一条永久的 `permission_revoked` 留痕**（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:441`），留痕表只追加、不能改删。之后的运行读行时这一行已有留痕，就不再选它，所以这些行的日期一般不会再被回写；唯一的例外是下文「两次运行重叠」里写明的残余情形（至多一次首次补丁）。ACK 后运行遇到这种情形时，服务器日志记一条 `YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN permission_revoked=1`（见下文「告警说明」），但已留痕的行不会因此再写。所以必须先授予档位、确认生效，再打开开关。
2. **目标清单**：`INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS` 只列发料确认表对应的宜搭目标；空或格式不对 = 不回写任何行（不是报错）。
3. **项目备料表开关**：`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 也须为 `true`，否则每行只得到跳过 `project_sheets_disabled`，不写、不留痕、不告警，该开关打开后再次判定（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:32-35`）。
4. **只认原文 `true`**：小写、不加引号、不加空格；`TRUE`、`1`、` true` 都算关。
5. **开着存档持久化的部署另有前置**：凡开着 `MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED` 的部署，打开本开关之前，先由备料线让存档修订不计回写写入的机器列（只改 buildArchiveRevision，不改 buildRevision；备料线自己的切片 D1）。否则写入日期会改变存档修订，进而产生一个新批次。这一项、打开开关、填目标清单、是否定期补跑都是 owner 逐项先批后动的 O 层②事项。

## 打开之后

- **ACK 后运行**：回写在发送**返回结果之后**单独运行（D5 a）：发送结果不等它、也不反映它的结果。服务器日志只会因为它出现三条固定码（`AFTER_ACK_FAILED`、`DEFERRED`、`UNWRITTEN`），每条的含义和 owner 该做什么见下文「告警说明」。ACK 后运行对这一行只跑一次，不重试；**全树没有界面按钮或定时任务会调用补写入口**，要由 owner 手动发起（是否定期补跑见下文）。
- **补写入口**：`POST /api/integration/yida-owner-send/issue-confirm-writeback`（`packages/core-backend/src/routes/integration-yida-owner.ts:554`），写入的是确认审计那一天的本地日期，不是补写当天。补写入口自己的调用方看得到每一行的结果，所以它不记上面两条日志。
- **扫一遍**：补写入口不带 `ledgerIds` 时，一次请求是「扫一遍」中的一页（至多 100 行）。
  - 一遍 = 第一次不带 `after`，之后把回答里的 `next` 原样作为 `after` 传回，直到 `next` 为 null 才算扫完（`next` 为 null 必定已没有剩下的候选行；最后一页可能为空）。
  - 一直 retryable 或缺确认审计（`acknowledgement_missing`）的行不留痕，在这一遍里留在游标后面、不挡后面的行；它们只在之后的某一遍从头（不带 `after`）开始时才再试一次。
  - 一遍不是快照：游标走过之后才确认的行，要到下一遍从头开始才取到。
  - 定期补跑以「一遍」为单位；是否定期补跑、由谁跑、多久一次是 owner 事项（O 层②）。
  - （不含扫描修复的版本上，补写入口每个目标只取得到最早 2000 条已确认 CREATE 以内的行，不是完整补救；#6812 含扫描修复。）
- **游标的拒绝**（被拒时回写端口什么都不读，主机的 owner 在线核验已先跑过）：
  - 篡改的游标、或带当前清单摘要却指向不在清单里的目标的游标，得 400（`YIDA_OWNER_RUNTIME_INPUT`；与 `ledgerIds` 同传、字符或长度不对，在路由就得 `YIDA_OWNER_HTTP_INPUT`）。
  - 目标清单变了（增、删或调换顺序）之后，旧游标得 409 `YIDA_ISSUE_CONFIRM_CURSOR_STALE`（`packages/core-backend/src/routes/integration-yida-owner.ts:53`），意思是目标集合变了，要不带 `after` 从头重扫。自己的目标被移出清单的游标也属于清单变了，得 409，不是 400。
  - 格式正确、目标在当前清单里的游标只移动起点。
- **两次运行重叠**（例如 ACK 后运行与补写入口同时处理同一行；`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:79-94`）：
  - 在租约内判定的结果，留痕在释放租约之前写入；补丁之前在租约内按 ledger_id 再查一次留痕（`:652-654`）。
  - 读行之后才被另一次运行留痕、而本次运行在租约内判定要补丁的行，在补丁前复查时被拦下（跳过 `already_traced`，不补丁、不留痕）；判定为其它结果时照常返回该结果（recorded 为 false）。
  - 不受租约串行化的残余：不受当前所持租约覆盖的留痕写入（租约之前判定的结果，或租约已被接管的持有者写入的留痕）可能落在另一次运行的租约内复查与它自己的留痕写入之间；那一行得一次首次补丁，留痕却是先到的那个结果。详见核心头注。
  - 补丁成功而留痕写入失败时，这次运行整体失败（不报 written）；下一次持租约的运行看到单元格已有日期，记 `already_set`。进程在补丁和留痕之间被杀时，它的租约要等过期或被接管才释放，此前的补写都是可重试的 `STOCK_PREP_PROJECT_WRITE_LOCKED`。

## 告警说明（ACK 后运行的日志行）

ACK 后运行只会写下面三条固定码（`packages/core-backend/src/integration/yida-owner-runtime.ts:103`、`:109`、`:117`；判定在 `:478-489`）。日志行不含任何编号、项目号、业务键或字段内容；`UNWRITTEN` 只多带结果码与条数。补写入口（`POST /issue-confirm-writeback`）自己的调用方看得到每一行的结果，所以它不写这三条日志。

| 日志行 | 含义 | owner 怎么做 |
|---|---|---|
| `YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED` | 这次运行失败，或被关停（stop）打断。日期没写，也没留痕。有这一条时，同一次运行不再写另外两条。 | 等后端恢复正常后，做一遍补写（见上文「扫一遍」）；或用 `ledgerIds` 指名这一行再试。 |
| `YIDA_ISSUE_CONFIRM_WRITEBACK_DEFERRED` | 运行正常结束，但有一行是可重试（retryable）的。例如：表写租约正被别的写入方占着（`STOCK_PREP_PROJECT_WRITE_LOCKED`，任何用途：小通道、大任务分块、批次安装 `pull_batch_install`、恢复核对 `recovery_verify`、表修复 `sheet_repair` 等）；主机写栅拒绝；主机读写失败；运行中途回写开关被关（`SWITCH_OFF`，这一行也算可重试，同样记这一条）。日期没写，也没留痕，补写时会再判定。 | 等占着租约的写入方结束，然后做一遍补写；或用 `ledgerIds` 指名这一行再试。一遍里仍然 retryable 的行，只在之后的某一遍从头开始时再试。 |
| `YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN <结果码>=<条数> …` | 运行正常结束，有一行得到了不写日期的终态结果（见下文「终态结果」）。这一行已经留痕，**之后任何一遍补写都不会再选它**，日期会一直空着。多个结果码按核心词表的顺序列出，例如 `YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN row_absent=1`。 | 按结果码查原因（下表）。补写救不回这一行：留痕表只追加，不能改删。条件消除之后要不要、怎样补这一列，是 owner 的事项（登记册 R-96 ⑦）。 |

- `DEFERRED` 和 `UNWRITTEN` 可以出现在同一次运行里，`DEFERRED` 在前；每条每次运行至多一次。ACK 后运行只指名一行，所以实际上一次运行只会有其中一条。
- 跳过不记日志：项目备料表开关关着（`project_sheets_disabled`，D14）、`already_traced`、缺确认审计（`acknowledgement_missing`）。写入（`written`）、单元格已是这一天（`already_set`）、单元格已有别的值（`kept_existing`，D8：先到的确认为准、不覆盖）也不记日志。

**终态结果**（核心的 12 个留痕结果，`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:134-147`）。每个结果每行只记一次，都是终态：

- 写了或不用写，不记 `UNWRITTEN`：`written`、`already_set`、`kept_existing`。
- 不写日期、记 `UNWRITTEN` 的九个结果（运行时的封闭列表，`yida-owner-runtime.ts:121-122`）：
  - `row_absent`：项目备料表里没有这个业务键的行。
  - `duplicate_key`：同一业务键有两行或以上。
  - `project_mismatch`：这一行的项目号和发送时不一致。
  - `project_absent`：项目登记表里没有这个项目。
  - `project_archived`：项目已归档。
  - `sheet_mismatch`：项目登记的表已经不是发送时绑定的那张表。
  - `payload_unmapped`：发送内容里取不到业务键或项目号（映射没有直连项）。
  - `permission_revoked`：owner 在租约内复核时已没有经角色授予的操作档位（见上文第 1 条）。
  - `source_unbound`：粘贴文本草稿发出的行，没有绑定来源记录。按设计（SR5）它不回写，看到这一条通常只说明发送用的是粘贴草稿。
- 其中 `row_absent`、`sheet_mismatch`、`project_archived` 这类取决于当时条件的结果，在条件消除之后是否仍应视为终态，是 owner 待裁事项（登记册 R-96 ⑦）。在 owner 裁定之前，它们按终态处理。

## 与备料线其它写入方的关系（回写持有表写租约时）

回写按行持有项目备料表的表写租约（用途 `issue_confirm_writeback`），**不提升项目写代次**（登记册 R-96，方案 A）：不提升，就不会让已批准的大任务被 `newer_plan` 拒；小通道的试算令牌只有在回写真的改了本项目某一行时，套用才因既有行修订值不同得 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`。取租约不排队，被占即拒，所以别的写入方撞上回写的租约，同样按「失败后重试」处理：

- **定时拉取**（`scripts/ops/stock-preparation-scheduled-pull.mjs`）默认只试算（`:147`）。试算的预检或提升撞上回写租约得 `STOCK_PREP_PROJECT_WRITE_LOCKED`，这个项目记为失败，脚本退出码 1（`:607-615`、`:843`）；重试 = 下一次定时运行或人工重跑。
- **导出**（`plugins/plugin-integration-core/lib/stock-preparation-export-gate.cjs`）：
  - 导出开始时表上已有租约：非治理项目得 `STOCK_PREP_EXPORT_BLOCKED`（`lease_in_flight`，`:198`）；治理项目在 C1 按状态拒（执行中或失败待恢复，同为 `STOCK_PREP_EXPORT_BLOCKED`，`:190-196`；状态见 `stock-preparation-refresh-state.cjs:242-253`）。
  - G1 时有租约或纪元变化：`STOCK_PREP_EXPORT_STATE_CHANGED`（`:225-232`）。
- **大 BOM**：展开时记下的观察绑定取锁纪元，任何一次取租约（包括回写的）都使它过期。计划和批准时都得 409 `PLAN_SUPERSEDED` `expansion_stale`，需要重新展开（`plugins/plugin-integration-core/lib/stock-preparation-large-bom-jobs.cjs:1707-1710`、`plugins/plugin-integration-core/lib/http-routes.cjs:10216-10218`、`:10232-10233`）。
- **残留的租约**：回写进程被杀、或释放失败留下的租约，要等下一个写入方接管、提升或观察时才清掉（`plugins/plugin-integration-core/lib/stock-preparation-project-write-lock.cjs:594-613`、`:696-703`、`:979-1011`）。在那之前，导出一直被拒，治理项目一直显示「失败待恢复」。这**不受** 240 s（租约 TTL 120 s 加接管宽限 120 s，`:132`、`:134`）的限制：240 s 只决定别人何时可以接管，不会自动清掉租约。

## 关回

- 把开关改回 `false` 并重启后端；已写入的日期与留痕保持不变。
