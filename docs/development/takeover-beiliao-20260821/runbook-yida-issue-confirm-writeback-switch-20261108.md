# 宜搭发料确认日期回写：打开开关前的核对（Y9）

> **用途**：设计基线 v2.3 §7.3（D5 / D9 / D13 a）的「发料确认日期回写」在 #6812 接线后由开关 `INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED` 控制，默认关闭。本页只列打开这个开关之前必须核对的几条，以及打开之后的运行与告警说明；**打开开关会写客户生产备料表的「发料确认日期」列，属 O 层，由 owner 单独批准并亲自操作**。Claude 不设置、不建议代为设置、不远程操作这个开关。
> **values-free**：回报只写 True/False、行数与面板上显示的结果类别 / 错误码；不抄项目号、业务键、记录号或任何字段内容。
> **行号**：本页不带提交号的 `path:line` 都按 #6812 分支的提交 `b0fd874d2` 核对；带 `@<提交>` 的按该提交核对。`b0fd874d2` 之后改代码的提交（第 2f 步：一条单测、`index.ts` 的一段注释、integration-guard 名单各加一行；第 2f 步还加过一条计数 SQL，第 2g 步已把它移出本 PR、作为参考交给备料线）都不动本页不带提交号引用的那些行；合并前按当时的目标 commit 重新核对。

## 打开开关之前

1. **先给 owner 授予经角色的操作档位，再打开开关（不可颠倒）。** 回写在租约内对每一行重新核对 owner 的权限（D13 a）：只认**经角色授予**的 `stock-prep:admin`，或同时经角色授予 `stock-prep:operate` 与 `stock-prep:read`（`packages/core-backend/src/integration/yida-issue-confirm-writeback-authority.ts:51-54`）。直接写进 `user_permissions` 的授权、`role:admin`、`integration:admin` 都不算。
   **后果（写明）：开关打开而 owner 没有这一档位时，每一条已确认（acknowledged）的发送都会得到一条永久的 `permission_revoked` 留痕**（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:463`），留痕表只追加、不能改删。之后的运行读行时这一行已有留痕，就不再选它，所以这些行的日期一般不会再被回写；唯一的例外是下文「两次运行重叠」里写明的残余情形（至多一次首次补丁）。ACK 后运行自己留痕了这种结果时，服务器日志记一条 `YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN permission_revoked=1`（见下文「告警说明」），但已留痕的行不会因此再写。所以必须先授予档位、确认生效，再打开开关。
2. **目标清单只列正式的发料确认目标，永远不列测试副本。** `INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS` 只列正式发料确认表对应的宜搭目标；槽位 1（发料测试副本），以及 `INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS` 里的任何目标，都不能列进来（`scripts/ops/global-history-flag-manifest.mjs:114`）。原因：发往列进清单的测试副本的一次已绑定发送，会先把生产表这一行的「发料确认日期」写上；之后正式发送的确认到来时单元格已有值，按 D8 不覆盖（记 `kept_existing`），测试那一天就一直留在生产表上。正式目标只收已绑定来源的行（D20：`packages/core-backend/src/integration/yida-send-approval-service.ts:339-346`，审批时在 `:595`、准入时在 `:660` 检查），所以清单只列正式目标时，回写永远遇不到 `source_unbound`（见下文「告警说明」）。清单逐项解析：格式不对的一项被忽略，其余合格的目标照样回写；只有清单为空、或每一项都格式不对时，才不回写任何行（不是报错）（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:236-240`）。
   **没有 `source_unbound` 告警不说明清单干净**：已绑定发送到列进清单的测试副本，回写记 `written`，正式确认到来时记 `kept_existing`，ACK 后运行对两者都不记日志；打开前逐个核对清单里每个 target_ref 既不是槽位 1，也不在 `INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS` 里。这一条目前全靠人工核对，没有代码守卫：宿主在运行时已持有测试目标集合（`packages/core-backend/src/integration/yida-owner-runtime.ts:381`），只交给发送授权用，从不和回写清单比对；核心解析回写清单时也不排除测试目标（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:234-243`）。清单里出现槽位 1 或测试目标就 fail closed 拒绝运行的代码守卫是 owner 待裁项（登记册 R-96 ⑦）。
3. **项目备料表开关**：`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 也须为 `true`，否则每行只得到跳过 `project_sheets_disabled`，不写、不留痕、不告警，该开关打开后再次判定（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:32-35`）。
4. **只认原文 `true`**：小写、不加引号、不加空格；`TRUE`、`1`、` true` 都算关。
5. **开着存档持久化的部署：所装版本必须已含 #6925（`6d2681703`）。** 凡开着 `MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED` 的部署，所装版本必须已含 #6925：存档修订不计回写写入的机器列，只改 buildArchiveRevision，不改 buildRevision（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:1917`、`:1924`）。D1 已随 #6925 合入（本分支已合入含它的 main）。没有它，写入日期会改变存档修订，进而产生一个新批次。这一项、打开开关、填目标清单、是否定期补跑都是 owner 逐项先批后动的 O 层②事项。
6. **迁移 `zzzz20261117090000` 已执行**：`kysely_migration` 里有这一行，并且留痕表的结果约束 `integration_yida_issue_confirm_writeback_outcome_check` 列有 `written_inactive`（`packages/core-backend/src/db/migrations/zzzz20261117090000_add_integration_yida_issue_confirm_written_inactive.ts:38-42`）。缺这一迁移时，作废行上的日期照样写进去，但留痕 INSERT 被约束拒绝，运行只记 `AFTER_ACK_FAILED`；之后的补写看到单元格已有日期，记 `already_set`，`written_inactive` 的信号就无声丢了。
7. **通用写入方不会擦掉日期（登记册 R-96 ⑦，备料线 2026-11-17 裁定：两条都要）**：
   - 所装版本必须已含 D2（集成线「通用写入方剥离机器列」切片，不是宜搭问题里也叫 D2 的那一项；写本页时未入 main，入 main 之前开关不得打开，入 main 后补 PR 号与提交号）与 #6925；
   - 并且紧接着打开开关之前，跑两项只读、values-free 的计数，**两项都必须为 0**，任一不为 0 就停，不打开开关：
     - (1) 登记过的项目表上无来由的非空 `issueConfirmDate` 单元格数（无来由 = 既没有一条带日期、且 `target_ref` 在当时正式目标清单里的留痕（`written`、`already_set`、`written_inactive`）能解释它，也不是由一个有来由的前任行经 carry 搬来的；首次打开时没有留痕也没有 carry，等于全部非空单元格；SQL 与对应规则由备料线给出）。正式目标上同一天的 `already_set` 能解释该格：正式确认证实的正是这个日期，不管谁先写入；测试副本写入的不同日期，正式 ACK 记为 `kept_existing`，仍算无来由（备料线 2026-11-17 裁定）。非空按 D8 判断（缺失、null、空串为空）。
     - (2) 项目登记表里 `sheet_id` 与按租户和对象派生的 sheet id 不一致的行数（或站点探针的 `sheet_id_mismatch` 为 0，`scripts/ops/stock-prep-pull-batch-site-probe-20261107/01-site-probe.sql:279`）。
   - **过渡规则（备料线 2026-11-17 裁定，在备料线交付计数 (1) 的正式 SQL 之前）**：
     - **第一次打开**：计数 (1) 就是登记过的项目表上全部非空 `issueConfirmDate` 单元格数，用 D2 普查的计数 (a)（D2 随 PR 附的普查 census.md 的「(a) No machine date planted before D2」：一条只读 SQL，原样取自备料线对 D2 的复核结论），必须为 0。用 `-v ON_ERROR_STOP=1` 跑；报错或没有打印出数字，都不算 0。「回写还没开，这一列应当全空」只对第一次打开成立。
     - **关回之后再次打开：暂不允许（BLOCKED）**，直到备料线把计数 (1) 的正式只读 SQL 作为它自己的一项交付。原因：留痕表不存记录号，carry 从哪一条前任行搬来也没有逐行记录，所以「有来由」在现有数据上算不全；集成线写过的候选 SQL 已移出本 PR，作为参考交给备料线。在那之前，开关一旦关回就保持关闭。任何「关了再开」都算再次打开：包括把目标清单清空后再填回，以及回滚到 R85 之后再装含本 PR 的版本时这一行仍为 `true`。
   - **谁跑、何时跑**：这两项计数读客户现场库，是 owner 先批、再执行的只读步骤（O 层①）；由 owner 本人或 owner 指定的现场操作人在现场跑，Claude 不跑、不远程操作（与本页开头的开关说明一致）。时间是**紧接着打开开关之前**（第一次打开；再次打开按上面的过渡规则）；回报只写两个数字。任一不为 0 就停：不打开开关，把两个数字交回备料线与集成线。
   - 本条取代 D1–D3 复核终裁 §7.3 的二选一（「普查为 0，否则先装剥离」）：现在 D2 装上与两项计数为 0 **都要**。D2 装上之后，通用写入方配置的普查只作参考，不再是前置条件。
8. **有效列只有布尔值**：登记过的项目表上 `active` 不是布尔值的行数为 0，`active` 为 null 或缺失的行**也算在内**；或由备料线先修好这些行。备料线 census 的 `nonBooleanActiveCells`（`plugins/plugin-integration-core/lib/stock-preparation-sheet-census.cjs:175-176`）只数存在、不为 null、又不是布尔值的单元格，不数 null 和缺失，所以它为 0 并不证明有效列只有布尔值。原因见下文「写到了作废行」：`active` 不是布尔 `false` 的行都按有效行回写；其中不是布尔 `true` 的（null、缺失或别的值）在填报视图里看不到，回写却记 `written`、不记日志。
9. **要让 carry 搬日期，所装版本须含 #6928（`88f7e47c5`）**：没有它，`written_inactive` 的日期在产品里没有任何办法挪到后继行（见下文「写到了作废行」）。

## 打开之后

- **ACK 后运行**：回写在发送**返回结果之后**单独运行（D5 a）：发送结果不等它、也不反映它的结果。服务器日志只会因为它出现四条固定码（`AFTER_ACK_FAILED`、`DEFERRED`、`UNWRITTEN`、`WRITTEN_INACTIVE`），每条的含义和 owner 该做什么见下文「告警说明」。ACK 后运行对这一行只跑一次，不重试；**全树没有界面按钮或定时任务会调用补写入口**，要由 owner 手动发起（是否定期补跑见下文）。
- **补写入口**：`POST /api/integration/yida-owner-send/issue-confirm-writeback`（`packages/core-backend/src/routes/integration-yida-owner.ts:588`），写入的是确认审计那一天的本地日期，不是补写当天。补写入口自己的调用方看得到每一行的结果，所以它不记下文「告警说明」里的四条日志。
- **运行报告**（D3-1）：补写入口每次回答（回写开关开着时）都带 `report`：`counts` 固定四个计数 `written_inactive`、`row_absent`、`duplicate_key`、`kept_existing`（为 0 也列出），`writtenInactive` 列出这一页每个 `written_inactive` 行的台账 id 和那条作废行的记录 id（`recordId`，不透明 id，不含任何业务值）。报告由宿主按这一页的结果行重算（`packages/core-backend/src/integration/yida-owner-runtime.ts:142-149`），路由再按自己核过的结果行重算一次，并按数据核对运行时的报告：键是封闭的、逐个计数相等、记录 id 逐个相等，不看键的顺序（`packages/core-backend/src/routes/integration-yida-owner.ts:322-345`，核对在 `:358`）。报告只统计这一页；一遍的总数要把各页相加。报告的计数不看 recorded（另一次运行先留痕的行也计入）。
  - ACK 后运行的结果也带同一份报告，但它只在内存里，不落地；日志里只有 `WRITTEN_INACTIVE` 的条数和 `UNWRITTEN` 的结果码与条数，记录 id 不进日志。**`kept_existing` 在 ACK 后运行上从不记日志**：它的条数只有补写入口的调用方在报告里看得到，或在留痕表里按 `outcome = 'kept_existing'` 查。
- **扫一遍**：补写入口不带 `ledgerIds` 时，一次请求是「扫一遍」中的一页（至多 100 行）。
  - 一遍 = 第一次不带 `after`，之后把回答里的 `next` 原样作为 `after` 传回，直到 `next` 为 null 才算扫完（`next` 为 null 即这一遍已走完：游标之后没有本遍尚未取到的候选行，本遍报 retryable 或 `acknowledgement_missing` 的行仍未留痕；最后一页可能为空）。
  - 一直 retryable 或缺确认审计（`acknowledgement_missing`）的行不留痕，在这一遍里留在游标后面、不挡后面的行；它们在之后的某一遍从头（不带 `after`）开始时再试一次，或由 owner 按 `ledgerIds` 指名再试。
  - 一遍不是快照：游标走过之后才确认的行，要到下一遍从头开始才取到。
  - 定期补跑以「一遍」为单位；是否定期补跑、由谁跑、多久一次是 owner 事项（O 层②）。
  - （不含扫描修复的版本上，补写入口每个目标只取得到最早 2000 条已确认 CREATE 以内的行，不是完整补救；#6812 含扫描修复。）
- **游标的拒绝**（被拒时回写端口什么都不读；核心层的拒绝在主机 owner 在线核验之后，路由与运行时入参层的拒绝在核验之前）：
  - 形状不对的游标（非规范编码、键或键序不对、版本不是 2（含 v1）、摘要格式不对、时间不对（含年份 0000）、id 不对）、或带当前清单摘要却指向不在清单里的目标的游标，得 400（`YIDA_OWNER_RUNTIME_INPUT`；与 `ledgerIds` 同传、字符或长度不对，在路由就得 `YIDA_OWNER_HTTP_INPUT`）。
  - 目标清单变了（增、删或调换顺序）之后，旧游标得 409 `YIDA_ISSUE_CONFIRM_CURSOR_STALE`（`packages/core-backend/src/routes/integration-yida-owner.ts:53`），意思是目标集合变了，要不带 `after` 从头重扫。自己的目标被移出清单的游标也属于清单变了，得 409，不是 400。
  - 摘要格式正确却不是当前清单摘要的游标一律得 409；规范编码、摘要为当前清单、目标在清单里的游标，即使时间或 id 改过也只移动起点（范围始终取自已认证的 owner 与开关，工作区固定为空）。
- **两次运行重叠**（例如 ACK 后运行与补写入口同时处理同一行；`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:80-95`）：
  - 在租约内判定的结果，留痕在释放租约之前写入；补丁之前在租约内按 ledger_id 再查一次留痕（`:680-682`）。
  - 读行之后才被另一次运行留痕、而本次运行在租约内判定要补丁的行，在补丁前复查时被拦下（跳过 `already_traced`，不补丁、不留痕）；判定为其它结果时照常返回该结果（recorded 为 false）。
  - 不受租约串行化的残余：不受当前所持租约覆盖的留痕写入（租约之前判定的结果，或租约已被接管的持有者写入的留痕）可能落在另一次运行的租约内复查与它自己的留痕写入之间；那一行得一次首次补丁，留痕却是先到的那个结果。详见核心头注。
  - 补丁成功而留痕写入失败时，这次运行整体失败（不报 written）；下一次持租约的运行看到单元格已有日期，记 `already_set`。进程在补丁和留痕之间被杀时，它的租约要等过期或被接管才释放，此前的补写都是可重试的 `STOCK_PREP_PROJECT_WRITE_LOCKED`。

## 写到了作废行（`written_inactive`，owner 裁定 D3-1）

owner 2026-11-17 裁定（登记册 R-96 ⑦ D3-1）：回写按业务键找到的那一行如果是**作废行**（`active` 为布尔 `false`：BOM 换键或表修复退役后留在原键下的前任行，新行换了键；填报视图按 `active` 过滤，看不到它），**仍然写入日期**，规则不变（D8：只写空单元格），留痕结果记 `written_inactive`（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:161`、判定 `:494`、留痕 `:699-701`）。按键查行从不按 `active` 过滤（`:669`）：后继行换了键，过滤只会把这种情形变成无声的 `row_absent`。把日期挪到后继行是备料线 carry 的事，回写不做。

- 只有「写入」会是 `written_inactive`：作废行单元格里已经是这一天，记 `already_set`；已有别的值，记 `kept_existing`，与有效行相同。补丁成功而留痕写入失败的作废行，下一次运行记的是 `already_set`，不再是 `written_inactive`，日志里也就没有这一条；要找它只能读表。
- **有效列不是布尔值的行**：只认布尔 `false` 为作废（备料线 census 同规则）；`active` 为 null、缺失或别的值的行，填报视图同样看不到（视图只显示 `active` 为 true 的行，`plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs:632`），回写却按有效行处理：记 `written`，不记任何日志。census 的 `nonBooleanActiveCells` 不数 null 和缺失的单元格。所以打开开关之前，这类行（null 与缺失也算）要为 0（「打开开关之前」第 8 条）。
- **谁能把日期挪到后继行**：只有管理员发起的 carry 确认，并且所装版本含 #6928（`88f7e47c5`，已在 main 上，本分支已合入）。carry 确认在同一个补丁里把前任行的日期复制到后继行**为空**的单元格；后继行已是这一天记已设，已有别的日期就保留，从不覆盖、也不因此拒绝（`plugins/plugin-integration-core/lib/stock-preparation-confirm-writes.cjs:1176-1205`）。
- **carry 只由管理员发起**：`carryPolicy` 是表动作的部署配置项（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:536`），全树除测试外没有任何地方配置它；没配就不做 carry 规划（`plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs:1767`），配了也只是提出建议，要经管理员确认才写入。规划只在新增后继行时看前任行（`:1767-1777`）。
- **只有日期的前任行永远不会被 carry**：carry 决定里的 `carryFields` 必须是非空的人工字段子集（`stock-preparation-confirm-writes.cjs:875-877`），发料确认日期是机器列，不在其中；规划时前任行只有日期，只报告 `machine_context_only`，不提出建议（`plugins/plugin-integration-core/lib/stock-preparation-carry-policy.cjs:302`、`:434`）。换键之后才到的 ACK 写日期时，前任行在新增后继行那一刻还没有日期，连这条报告都不会有。
- **carry 已确认之后才到的 ACK 要管理员重放**：carry 确认在前、发送的确认（ACK）在后时，日期写到作废的前任行（`written_inactive`），之后不会再有新的 carry 规划把它带过去；要管理员**重放**同一个 carry 确认。人工字段都已搬过、只剩日期要搬的重放，照样把日期写进后继行的空单元格，结果是 `carried`（`stock-preparation-confirm-writes.cjs:1226-1229`）。推断（没有测试）：后继行上已搬过的人工单元格之后又被人改过时，重放会得 409 `CONFIRM_CARRY_TARGET_ALREADY_SET`（`:1173`），日期也就搬不过去。
- **没有人能手填这一天**：发料确认日期是 `plm_system` 列，登记过的项目表上这些列带 `humanWriteLock`（`plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs:321-325`）。宿主对所有人只读，管理员也一样，没有覆盖（`packages/core-backend/src/multitable/human-write-lock.ts:1-3`、`:32`）；自动化同样被拒（`packages/core-backend/src/multitable/automation-executor.ts:3145`）。所以除了 carry 确认，产品里没有把这一天补到后继行的办法。PLM 删除留下的作废行没有后继行，日期只能留在那里。
- **日期挪走之后，前任行的留痕仍是 `written_inactive`**：留痕表只追加、不改；以后谁把日期挪到了后继行，留痕都不会变。判断日期现在在哪，**读表，不读留痕**。
- **回写会移动 `confirmationInputRevision`**：回写改了本项目的一行，人工确认待办的输入修订值就变了（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:2618`），待确认的候选项会换新 id（`plugins/plugin-integration-core/lib/stock-preparation-confirmation-decisions.cjs:677-690`）。这和改一次「备注」的效果一样，不是新问题。
- **先 carry、后继行再收到自己的 ACK**：carry 把日期带到后继行之后，后继行自己的发送确认到来时单元格已有值，回写按 D8 不覆盖，记 `kept_existing`（同一天则记 `already_set`）。这一情形 owner 还没裁（登记册 R-96 ⑦）：A 维持 D8「不覆盖」；B 在运行报告里计 `kept_existing` 的条数；C 覆盖。推荐 A+B。**本版按 A 处理（即现行 D8，不是新取舍），并在运行报告里给出 B 的计数**（见上文「运行报告」）；但 B 的计数只有补写入口的调用方和留痕表看得到，ACK 后运行（后继行自己的 ACK 正是走这条路）不记 `kept_existing` 的日志。若 owner 选 B，ACK 后这一条还要另加日志行或别的落地方式。C 没有实现。

## 告警说明（ACK 后运行的日志行）

ACK 后运行只会写下面四条固定码（`packages/core-backend/src/integration/yida-owner-runtime.ts:104`、`:110`、`:124`、`:138`；判定在 `:519-532`）。日志行不含任何编号、项目号、业务键或字段内容；`UNWRITTEN` 只多带结果码与条数，`WRITTEN_INACTIVE` 只多带条数。补写入口（`POST /issue-confirm-writeback`）自己的调用方看得到每一行的结果和运行报告，所以它不写这四条日志。

| 日志行 | 含义 | owner 怎么做 |
|---|---|---|
| `YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED` | 这次运行失败，或被关停（stop）打断。通常日期没写、也没留痕；但补丁已落地而留痕写入失败时，单元格里可能已有日期（见上文「两次运行重叠」），补写时再判定（有日期则记 `already_set`）。运行在留痕之后、退出检查点才被关停时，这一行已经留痕，可能是任何一种结果（含 `written_inactive` 和不写日期的终态结果）；补写不会再选它，日志里也不会再有别的码，要在留痕表里查这一行的结果。有这一条时，同一次运行不再写另外三条。 | 等后端恢复正常后，做一遍补写（见上文「扫一遍」）；或用 `ledgerIds` 指名这一行再试。已留痕的行补写不会再选，它的结果要在留痕表里查。 |
| `YIDA_ISSUE_CONFIRM_WRITEBACK_DEFERRED` | 运行正常结束，但有一行是可重试（retryable）的。例如：表写租约正被别的写入方占着（`STOCK_PREP_PROJECT_WRITE_LOCKED`，任何用途：小通道、大任务分块、批次安装 `pull_batch_install`、恢复核对 `recovery_verify`、表修复 `sheet_repair` 等）；主机写栅拒绝；主机读写失败；运行中途回写开关被关（`SWITCH_OFF`，这一行也算可重试，同样记这一条）。这一行没有留痕；通常日期也没写，但补丁已落地却没收到确认时（补丁调用报错）单元格里可能已有日期。补写时再判定：有日期则记 `already_set`，不会再补。 | 等占着租约的写入方结束，然后做一遍补写；或用 `ledgerIds` 指名这一行再试。一遍里仍然 retryable 的行，只在之后的某一遍从头开始时再试。 |
| `YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN <结果码>=<条数> …` | 运行正常结束，本次运行自己留痕了不写日期的终态结果（见下文「终态结果」）。这一行已经留痕，之后任何一遍补写都不会再选它，日期**通常会一直空着**。两个例外：补丁前复查早于这条留痕落地的另一次运行仍可能补一次（只限不受当前租约覆盖的留痕：租约外判定的结果，或租约已被接管的持有者写的留痕；见登记册 R-96 ④(9)）；本次运行判定了、却由另一次运行先留痕的行（recorded 为 false，那条留痕可能就是 `written`）不计入这一行。所以这一行只数本次运行自己的结果：恢复入口或另一次运行先留痕的终态结果，任何日志里都不会出现。多个结果码按核心词表的顺序列出，例如 `YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN row_absent=1`。 | 按结果码查原因（下表）；见到 `source_unbound` 先看下表那一条。补写救不回这一行：留痕表只追加，不能改删。条件消除之后要不要、怎样补这一列，是 owner 的事项（登记册 R-96 ⑦）。 |
| `YIDA_ISSUE_CONFIRM_WRITEBACK_WRITTEN_INACTIVE count=<条数>` | 运行正常结束，有一行得到 `written_inactive`：**日期已经写了**，但写在按业务键找到的作废行（前任行）上，客户的填报视图看不到（见上文「写到了作废行」）。这一行已留痕，之后的补写不会再选它。只带条数，不带记录号；它不是 `UNWRITTEN`（日期写了）。条数不看 recorded。 | 读表确认日期在哪一行。所装版本含 #6928、前任行有人工字段值时，carry 确认（carry 已确认在前则由管理员重放）会把日期带到后继行的空单元格。前任行只有日期、没有后继行，或没装 #6928 时，产品里没有补救办法，也没有人能手填：把这些行交给备料线。日志不带台账 id 和记录号，留痕表也不存记录号：要找这一行，在留痕表里查 `outcome = 'written_inactive'` 的行（得台账 id、`sheet_id` 和日期），再在那张表里按业务键找 `active` 为 false 的行；或用补写入口报告里的记录 id。ACK 后运行回答里的记录号不落地保存（已知局限，登记册 R-96 待办）。 |

- `DEFERRED`、`UNWRITTEN`、`WRITTEN_INACTIVE` 可以出现在同一次运行里，按这个顺序；每条每次运行至多一次。ACK 后运行只指名一行，所以实际上一次运行只会有其中一条。
- 跳过不记日志：项目备料表开关关着（`project_sheets_disabled`，D14）、`already_traced`、缺确认审计（`acknowledgement_missing`）。写入（`written`）、单元格已是这一天（`already_set`）、单元格已有别的值（`kept_existing`，D8：先到的确认为准、不覆盖）也不记日志。

**终态结果**（核心的 13 个留痕结果，`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:145-162`；第 13 个 `written_inactive` 由迁移 `zzzz20261117090000` 加进留痕表的检查约束）。每个结果每行只记一次，都是终态：

- 写了或不用写，不记 `UNWRITTEN`：`written`、`already_set`、`kept_existing`、`written_inactive`（写到了作废行，记 `WRITTEN_INACTIVE`，见上表）。
- 不写日期、记 `UNWRITTEN` 的九个结果（运行时的封闭列表，`yida-owner-runtime.ts:129-130`；只数本次运行自己留痕的行，`:158`）：
  - `row_absent`：项目备料表里没有这个业务键的行。
  - `duplicate_key`：同一业务键有两行或以上。
  - `project_mismatch`：这一行的项目号和发送时不一致。
  - `project_absent`：项目登记表里没有这个项目。
  - `project_archived`：项目已归档。
  - `sheet_mismatch`：项目登记的表已经不是发送时绑定的那张表。
  - `payload_unmapped`：发送内容里取不到业务键或项目号（映射没有直连项）。
  - `permission_revoked`：owner 在租约内复核时已没有经角色授予的操作档位（见上文第 1 条）。
  - `source_unbound`：没有绑定来源记录的行（粘贴文本草稿发出的行）。正式目标只收已绑定的行（D20），所以清单只列正式目标时它不会出现。**出现即说明有测试目标被列进了回写清单，立刻摘掉**（从 `INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS` 里去掉那个目标，见上文第 2 条）。
- 取决于当时条件的终态结果，在条件消除之后是否仍应视为终态，是 owner 待裁事项（登记册 R-96 ⑦）。完整清单：`row_absent`、`duplicate_key`、`project_absent`、`project_archived`、`project_mismatch`、`sheet_mismatch`、`permission_revoked`（不含 `payload_unmapped` 与 `source_unbound`）；实际最可能遇到的是 `permission_revoked`（见上文第 1 条）。在 owner 裁定之前，它们按终态处理（现状行为，不是新取舍）。

## 与备料线其它写入方的关系（回写持有表写租约时）

回写按行持有项目备料表的表写租约（用途 `issue_confirm_writeback`），**不提升项目写代次**（登记册 R-96，方案 A）：不提升，就不会让已批准的大任务被 `newer_plan` 拒；小通道的试算令牌只有在回写真的改了本项目某一行时，套用才因既有行修订值不同得 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`。取租约不排队，被占即拒，所以别的写入方撞上回写的租约，同样按「失败后重试」处理：

- **定时拉取**（`scripts/ops/stock-preparation-scheduled-pull.mjs`）默认只试算（`:147`）。试算的预检或提升撞上回写租约得 `STOCK_PREP_PROJECT_WRITE_LOCKED`，这个项目记为失败，脚本退出码 1（`:607-615`、`:843`）；重试 = 下一次定时运行或人工重跑。回写的租约不会让项目算作 held：只有批次安装（`pull_batch_install`）持有者的撞锁才算 held（`plugins/plugin-integration-core/lib/integration-run-port.cjs:26`、`:53-56`；脚本 `scripts/ops/stock-preparation-scheduled-pull.mjs:494`）。
- **导出**（`plugins/plugin-integration-core/lib/stock-preparation-export-gate.cjs`）：
  - 导出开始时表上已有租约：非治理项目得 `STOCK_PREP_EXPORT_BLOCKED`（`lease_in_flight`，`:198`）；治理项目在 C1 按状态拒（执行中或失败待恢复，同为 `STOCK_PREP_EXPORT_BLOCKED`，`:190-196`；状态见 `stock-preparation-refresh-state.cjs:242-253`）。
  - G1 时有租约或纪元变化：`STOCK_PREP_EXPORT_STATE_CHANGED`（`stock-preparation-export-gate.cjs:225-232`）。
- **大 BOM**：展开时记下的观察绑定取锁纪元，任何一次取租约（包括回写的）都使它过期。计划和批准时都得 409 `PLAN_SUPERSEDED` `expansion_stale`，需要重新展开（`plugins/plugin-integration-core/lib/stock-preparation-large-bom-jobs.cjs:1707-1710`、`plugins/plugin-integration-core/lib/http-routes.cjs:10227-10229`、`:10243-10244`）。
- **残留的租约**：回写进程被杀、或释放失败留下的租约，要等下一个写入方接管、提升或观察时才清掉（`plugins/plugin-integration-core/lib/stock-preparation-project-write-lock.cjs:596-615`、`:698-705`、`:981-1013`）。在那之前，导出一直被拒，治理项目一直显示「失败待恢复」。这**不受** 240 s（租约 TTL 120 s 加接管宽限 120 s，`:134`、`:136`）的限制：240 s 只决定别人何时可以接管，不会自动清掉租约。

## 不在回写范围内

- **备料线开关手册附录「备选：一次性 SQL 认领」登记的旧沙箱表**（`docs/development/takeover-beiliao-20260821/runbook-stock-prep-project-sheets-switch-on-20261014.md`；对象 id 不是 `plm_stock_preparation_sandbox_p_…` 形式的表）：回写对它们取不到字段映射（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:1394-1404`），核心把这个错误码按可重试处理（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:554-560`）：每一行都得可重试的 `TABLE_ACTION_FIELD_IDS_UNRESOLVED`，从不留痕；每次 ACK 之后都记一条 `DEFERRED`（它的处理「等占着租约的写入方结束」对这种行不适用），任何一遍补写都修不好它。所以这类表上不会有回写写入的日期。它们不在回写的服务范围内；要不要纳入是另一项裁定。

## 关回

按 main 的开关关闭规则（#6929：`plugins/plugin-integration-core/lib/http-routes.cjs:1878-1881@59876b3d6`、`scripts/ops/global-history-flag-manifest.mjs:958@59876b3d6`；步骤见 `customer-delivery-guide-20260904.md` §5-5）：

- **止损关回**（发现写错的日期、清单列错或缺陷）：立刻关，**不扫**（备料线 2026-11-17 裁定）。
- **有序关回**：关之前先补写扫完一遍（`next` 为 null，见上文「扫一遍」）；这一遍是对客户生产表的写入，属 O 层②，要 owner 先批。依据是推断：补丁已落地、留痕没写的单元格（见上文「两次运行重叠」），在开关关着时补不出留痕，因为开关关着时补写入口走通用 404（`packages/core-backend/src/routes/integration-yida-owner.ts:583-587`），核心也什么都不做（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:707`）。
- **不要直接删掉开关这一行**：pm2 会在运行中的进程里保留已删除的键，开关仍然开着。把这一行改成 `INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED=false`，用 `scripts/ops/attendance-onprem-start-pm2.ps1` 重启，在 `pm2 env` 里核对这个键已是 `false`，并核对一个可观察的效果：补写入口回答通用 404 `NOT_FOUND`（开关关着时路由不进入回写，`packages/core-backend/src/routes/integration-yida-owner.ts:583-587`，通用 404 在 `:644`；单测 `packages/core-backend/tests/unit/yida-issue-confirm-writeback-wiring.test.ts:53-55` 钉住）。只看 404 不够：不带这条路由的版本也回同样的 404，所以要和 `pm2 env` 的核对一起看。都成立之后，才可以删掉这一行。
- **要清空目标清单**，写成 `INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS=" "`（引号里一个空格；解析器把它当作空清单，`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:236`），不要写成空的 `INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS=`：PS 5.1 把空的 `KEY=` 当作删掉了这一行，pm2 会继续用旧清单。同样用启动脚本重启，并在 `pm2 env` 里核对。
- 已写入的日期与留痕保持不变。**关回之后暂不能再打开**：再次打开要等备料线交付计数 (1) 的正式 SQL（「打开开关之前」第 7 条的过渡规则）；交付之后，每一次重新打开之前都按第 7 条跑两项计数。

## 回滚到 R85（`220bd80ab`）

- **回滚前先按「关回」把开关改成 `false`**，并在 `pm2 env` 里核对：回滚不动 app.env，这一行会原样带过去。回滚之后如果再装含本 PR 的版本、这一行仍是 `true`，视同再次打开，按「打开开关之前」第 7 条的过渡规则挡住（BLOCKED）。
- **回滚必须用 `-RunMigrations 0`**（不跑 migrate，也不跑 down）。库历史里有旧包没有的迁移时，旧包的 migrate 报 `corrupted migrations: previously executed migration … is missing`、exit 1：集成线 2026-11-17 的 D21 本地验收实测过（库里有 Y5a 的 D21 `zzzz20261106110500`，不含它的代码跑 migrate 即如此）。推断（同一检查，未对 R85 实测）：Y9 线的两个迁移（`zzzz20261106093100` 已在 main 上，`zzzz20261117090000` 由本 PR 加入）都不在 R85 里，R85 开着迁移安装同样会在迁移这一步失败。
- 回滚到 R85 后，`written_inactive` 留痕行原样保留。R85 **因不存在而关闭**，**不是**返回 UNAVAILABLE：R85 没有任何代码读这张留痕表（留痕表的迁移也不在 R85 里）；回写也未接线：插件绑定只有两个成员（`plugins/plugin-integration-core/lib/yida-owner-runtime-factory.mjs:92@220bd80ab`），路由没有这条路径，请求走通用 404 `NOT_FOUND`（`packages/core-backend/src/routes/integration-yida-owner.ts:431@220bd80ab`）。所以不会据此发送或判定任何东西（逐项核对记录在集成线证据 rollback-fail-closed.md，只读 `220bd80ab` 的树）。
- **R85 没有 #6925**：R85 的存档修订不去掉机器列（`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:1895-1916@220bd80ab`；本分支去掉了，`:1917`）。所以回滚到 R85 之后，凡开着 `MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED` 的部署，每张已经有回写日期（`written` 或 `written_inactive`）的表，在 R85 下一次存档时批次会重新取键一次（与「打开开关之前」第 5 条同一机制）。这是推断，没有实测。
- 回滚前用只读计数记下 `outcome IN ('written', 'written_inactive')` 的行数（按结果分别记），以及这些行按 `sheet_id` 去重后的表数，即会重新取键的表数（只记数字）。`written_inactive` 的日期仍在作废行上，R85 不会移动它们（R85 既没有 #6928 的 carry，也没有 #6925）。
- 跑 down 的回滚会被拒：存在 `written_inactive` 行时，迁移 `zzzz20261117090000` 的 down() 先以 55000 `YIDA_ISSUE_CONFIRM_WRITEBACK_WRITTEN_INACTIVE_ROWS_PRESENT` 拒绝，什么都不改（`packages/core-backend/src/db/migrations/zzzz20261117090000_add_integration_yida_issue_confirm_written_inactive.ts:31`、`:56`）。
