# 宜搭投递台账：把发送进程死掉后停在 `dispatching` 的行收口为 `outcome_unknown(manual_recovery)`（DBA 手册，首发前置）

> **用途**：设计基线 v2.3 §3.2「现状缺口：崩溃后停在 `dispatching` 的行」与「建议首发之前补一份 `dispatching` 恢复手册」五条，附录 B.3a 四个勾选项。本手册就是那份手册：owner 逐次批准，DBA 在一个事务里把**一行**从 `dispatching` 改成 `outcome_unknown`，并写**一条** `manual_recovery` 审计。之后由人到宜搭核对，与其它结果不明的行一样处理。
> **基线**：所有 `path:line` 都在 main `c0ad1e3fa` 上核过。本手册用到的三张表的迁移（`090`、`091`、`095`）在 R81（`onprem-r81` = `1d7438c65`）与 main 之间逐字节相同（`git diff onprem-r81 c0ad1e3fa` 对这三个文件为空）。main 比 R81 多一个迁移 `zzzz20261105033000`，它只给审计 `reason` 加了第五个值 `receipt_unparsed`；`manual_recovery` 在 `090` 里就有（`packages/core-backend/migrations/090_create_integration_yida_delivery_ledger.sql:54-55`），所以本手册对 R81 与 main 同样成立。
> **与门 2 手册的关系**：`runbook-yida-prepared-ledger-cancel-20261104.md` 只处理 `prepared → not_sent`（`plugins/plugin-integration-core/lib/yida-delivery-store.cjs:318-331`）。本手册处理的 `dispatching` 行**可能已经出网**，不能照搬：结局只能是「结果不明」，不能是「确定没发」。
> **values-free**：不含主机、地址、口令、连接串、密钥或任何客户值。授权号、台账号、进程号、时间戳只出现在执行人自己的屏幕上，**不写进任何回报、issue 或 PR**。
> **本手册不做的事**：不释放业务键占位、不重发、不改授权记录、不碰宜搭；不改代码、开关或配置；不动 `claim_token`、`claim_actor_id` 与任何身份列。

## 1. 什么时候用

**全部满足**才用：

1. 一次「提交此授权一次」之后，持久记录状态停在 `dispatching`（面板「手动刷新持久记录（只读）」显示 `持久记录状态：dispatching。`，或第 6 节只读核对看到）。`dispatching` = 已认领、可能已经出网：认领在出网之前提交（`plugins/plugin-integration-core/lib/yida-delivery-runner.mjs:329`，出网从 `:343` 开始），认领令牌写进台账行（`yida-delivery-store.cjs:271-273`）。
2. **持有这一行的进程已经退出、不会恢复**，而且这是用**进程级事实**确认的（第 5 节）。理由：`acknowledged` 与 `outcome_unknown` 只能由 `finish()` 写，它要求行仍是 `dispatching`，并且要同时对上 actor 和令牌（`yida-delivery-store.cjs:296-312`，判断在 `:298-299`）；令牌的执行能力只在发送进程的内存里（`yida-delivery-runner.mjs:329-330`）。进程死了，就没有任何代码路径再对这一行调用 `finish()`，行永远停在 `dispatching`。反过来，进程还活着时它随时可能写回结果，这时不能动。
   - **不能凭超时**，也**不能凭页面一直在等**：运行器有计时上限，但「到点了」不等于「进程死了」。
3. owner 对**这一次**明确批准（第 2 节）。

**不适用**：`prepared` 用门 2 手册；`acknowledged`、`outcome_unknown`、`not_sent` 已是终态，不碰。台账触发器只允许 `prepared → dispatching | not_sent` 与 `dispatching → acknowledged | outcome_unknown`（`090_create_integration_yida_delivery_ledger.sql:91-94`），所以本手册写的 `dispatching → outcome_unknown` 不需要迁移。

**为什么要做**：不做也不会重发，只是这一行永远显示 `dispatching`，像「还在发」，它的业务键也一直被占着。收口为 `outcome_unknown` 之后，面板和只读查询都能读到「结果不明，需要人到宜搭核对」，与传输层自己判定的结果不明（`yida-delivery-runner.mjs:340` 也写 `manual_recovery`）是同一类，按同一流程处理。

## 2. 谁批、怎么批

- **owner 逐次批准**（O 层：直接写客户机数据库）。一次批准只覆盖一条授权的一行，不能「以后都这样处理」。
- 批准时 owner 只需要看到：状态类别 `dispatching`、第 5 节的五行判读结果（只有 True/False 与计数）、第 6 节只读核对的计数。授权号由 owner 线下交给执行人（不进任何回报）。
- 执行人：持有该部署数据库连接、能登录后端所在机器的运维 / DBA。Claude 不执行本手册。

## 3. 先知道：不可逆、占位不释放、不能重发

- **不可逆**：`outcome_unknown` 是终态，触发器不允许它再变成任何状态（`090_create_integration_yida_delivery_ledger.sql:91-94`）；台账与审计都不能删除或截断（`:72`、`:113-137`）。执行之前确认第 1 节三条都满足。
- **只改状态**：脚本只 `SET status = 'outcome_unknown'`。触发器保证身份列不变（`:73-90`）、`dispatching` 之后 `claim_token` / `claim_actor_id` 不变（`:99-103`），`outcome_unknown` 的形状约束要求认领字段非空、回执字段为空（`:34-35`），`dispatching` 行本来就是这样。
- **占位不释放**：新建防重占位是按 `(tenant_id, workspace_id, target_ref, business_key_digest)` 建的部分唯一索引（`intent = 'create'`），与状态无关（`packages/core-backend/migrations/091_create_integration_yida_create_fence.sql:1-5`、`:45-47`）。收口之后这一行的业务键在这个目标上仍被占用，同一行不能再经 MetaSheet 新建。
- **不能重发**：本手册不提供重发路径。宜搭里可能已经有这条记录。要不要在宜搭补录，只能由 owner 在人工核对之后另行决定。

## 4. 备份

执行第 7 节之前做一次全库备份，与 `docker\app.env` 副本放在一起，记下目录（目录名不进回报）。做法同既有上机手册（`222-deploy-window-runbook-20260901.md` 第 1-2 步，`pg_dump … -Fc`），连接信息由执行人自备。

这份备份是**证据**，不是回退路径：台账只许追加（第 3 节），恢复整库会连带抹掉备份之后所有模块的新数据，只有 owner 能决定。

## 5. 进程级事实：确认持有进程已退出

后端是单实例 fork 进程（`ecosystem.config.cjs:57-61`：`metasheet-backend`、`instances: 1`、`exec_mode: 'fork'`），发送只在后端进程里发生。所以「持有进程已退出」可以用三条进程级事实确认：

- **P1** 后端端口上恰好一个监听进程，它就是**当前**后端进程，记下它的启动时间 S；
- **P2** 这一行的认领（审计 `claim` 行的 `created_at`）发生在 S **之前**；
- **P3** 比当前后端更早启动的 `node.exe` 只有 pm2 宿主进程（命令行含 `pm2-runtime` 或 `\pm2\lib\Daemon.js`，与 `handoff-r59-two-machine-20260924.md` 第 3 节第 5 步的认法相同），没有更早的、可能还活着的旧后端。

P1 + P3 说明 S 之前启动的后端进程都已不在；P2 说明认领这一行的是 S 之前的某个后端进程。合起来就是「持有进程已退出」，而且新进程不可能恢复它：令牌的执行能力只在原进程内存里。P2 由第 7 节脚本在锁行之后、写入之前**再判一次**，判不过就不写。

后端此刻是停着的：先按既有方法拉起（清单第 3.1 版「重启后端的方法」，`attendance-onprem-start-pm2.ps1`；托管机走计划任务，见 `runbook-stock-prep-project-sheets-switch-on-20261014.md` §2.4），确认 health 通过，再从这一节开始。拉起后端不会碰 `dispatching` 行：没有任何启动路径对它调用 `finish()`（§1 第 2 条）。

在**后端所在机器**的部署根目录，用 Windows PowerShell 5.1 运行（只读；只打印计数、True/False 和启动时间）：

```powershell
$port = 8900
$portLine = @(Select-String -Path .\docker\app.env -Pattern '^\s*PORT\s*=') | Select-Object -Last 1
if ($portLine) { $port = [int](($portLine.Line -split '=', 2)[1].Trim().Trim('"', "'")) }
$owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
'listenerProcesses=' + $owners.Count
if ($owners.Count -eq 1) {
  $backend = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owners[0])
  $older = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ProcessId -ne $backend.ProcessId -and $_.CreationDate -lt $backend.CreationDate })
  $olderHosts = @($older | Where-Object { $_.CommandLine -like '*pm2-runtime*' -or $_.CommandLine -like '*\pm2\lib\Daemon.js*' })
  'backendIsNode=' + ($backend.Name -eq 'node.exe') + ' olderNodeProcesses=' + $older.Count + ' olderPm2Hosts=' + $olderHosts.Count
  $started = $backend.CreationDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
  'backendStartedAt=' + $started
}
```

端口取 `docker\app.env` 里的 `PORT`，没有这一行时用 8900，与升级脚本同一约定（`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1:2335-2353`；后端缺省值 `packages/core-backend/src/config.ts:65`）。

判读（任何一条不符：停，只把这几行的 True/False 与计数报 owner，不执行第 7 节）：

- `listenerProcesses=1`。是 0：后端没在跑，按上面先拉起。大于 1：停。
- `backendIsNode=True`。
- `olderNodeProcesses` 等于 `olderPm2Hosts`。不相等说明有一个比当前后端更早的 `node.exe` 不是 pm2 宿主，它可能是还活着的旧后端：停。owner 判断它与 MetaSheet 无关时，必须由执行人在本机看过它的命令行后另行批准，命令行不进回报。
- `backendStartedAt=` 后面的值（S，UTC）留在同一个窗口里，第 6、7 节原样传给 psql，不抄进回报。

**时钟**：S 来自后端机器的系统时钟，认领时间来自数据库时钟。第 6、7 节同时传入后端机器的「现在」（`host_now`），脚本要求两台时钟相差小于 2 秒，并且只在「认领时间 + 2 秒 < S」时才认为认领早于 S。数据库与后端在同一台机器上时这一条自然成立。

## 6. 只读核对（执行前、执行后各跑一次）

保存为 `yida-dispatching-check.sql`（纯 ASCII；只输出状态类别、True/False 与计数。与仓库里 `docs/development/takeover-beiliao-20260821/runbook-yida-dispatching-recovery-20261106-check.sql` 逐字节相同）：

```sql
\set ON_ERROR_STOP on
\pset footer off
\if :{?backend_started_at}
\else
\echo DISPATCHING_CHECK=STOP missing_backend_started_at
\quit
\endif
\if :{?host_now}
\else
\echo DISPATCHING_CHECK=STOP missing_host_now
\quit
\endif
BEGIN READ ONLY;
SELECT 'clock' AS kind,
       abs(extract(epoch FROM clock_timestamp() - :'host_now'::timestamptz)) < 2 AS skew_ok,
       :'backend_started_at'::timestamptz <= clock_timestamp() + interval '2 seconds' AS start_not_future;
SELECT 'ledger' AS kind, status, count(*) AS n
  FROM integration_yida_delivery_ledger GROUP BY status ORDER BY status;
SELECT 'audit' AS kind, event, status, coalesce(reason, '-') AS reason, count(*) AS n
  FROM integration_yida_delivery_audit GROUP BY event, status, reason ORDER BY event, status, reason;
SELECT 'dispatching' AS kind,
       count(*) FILTER (WHERE c.n = 1
         AND c.claimed_at + interval '2 seconds' < :'backend_started_at'::timestamptz) AS claimed_before_start,
       count(*) FILTER (WHERE c.n = 1
         AND NOT (c.claimed_at + interval '2 seconds' < :'backend_started_at'::timestamptz)) AS claimed_after_start,
       count(*) FILTER (WHERE c.n <> 1) AS claim_audit_not_single,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM integration_yida_send_admissions a WHERE a.ledger_id = l.id)) AS without_admission
  FROM integration_yida_delivery_ledger l
  CROSS JOIN LATERAL (
    SELECT count(*) AS n, min(x.created_at) AS claimed_at
      FROM integration_yida_delivery_audit x
     WHERE x.ledger_id = l.id AND x.event = 'claim'
  ) c
 WHERE l.status = 'dispatching';
ROLLBACK;
```

在第 5 节的同一个 PowerShell 窗口里运行（连接参数用该部署后端所连的同一个库，连接信息由执行人自备，不写进回报；PATH 里没有 `psql` 时用 PostgreSQL 安装目录下 `bin` 里的完整路径）：

```powershell
$hostNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
psql -X -q -A -v "backend_started_at=$started" -v "host_now=$hostNow" -f yida-dispatching-check.sql
```

判读：

- `clock|t|t`：两台时钟相差小于 2 秒，S 不在未来。有一个 `f`：停，报 owner（多半是时区或时钟问题），不执行第 7 节。
- `ledger|dispatching|N`：停在 `dispatching` 的行数。
- `dispatching|A|B|C|D`：A = 认领早于 S 的 `dispatching` 行数（候选），B = 认领不早于 S 的行数（**可能属于当前进程，不能动**），C = 认领审计不是恰好一条的行数，D = 没有准入记录的行数。C、D 必须是 0：不是 0 就停，报 owner。准入在同一事务里先写 `prepared` 台账行、再写准入记录（`packages/core-backend/src/integration/yida-send-approval-service.ts:421-458`；准入表 `ledger_id` 唯一，`packages/core-backend/migrations/095_create_integration_yida_send_approvals.sql:37-45`），所以每一行都应有准入记录。A 是 0：没有可收口的行，不执行第 7 节。

## 7. 收口（单事务；owner 批准后执行一次）

保存为 `yida-dispatching-recover.sql`（纯 ASCII；与仓库里 `docs/development/takeover-beiliao-20260821/runbook-yida-dispatching-recovery-20261106-recover.sql` 逐字节相同）：

```sql
\set ON_ERROR_STOP on
\pset footer off
\if :{?grant_id}
\else
\echo DISPATCHING_RECOVERY=STOP missing_grant_id
\quit
\endif
\if :{?backend_started_at}
\else
\echo DISPATCHING_RECOVERY=STOP missing_backend_started_at
\quit
\endif
\if :{?host_now}
\else
\echo DISPATCHING_RECOVERY=STOP missing_host_now
\quit
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
WITH locked AS (
  SELECT l.id, l.status
    FROM integration_yida_send_admissions a
    JOIN integration_yida_delivery_ledger l ON l.id = a.ledger_id
   WHERE a.grant_id = :'grant_id'
     FOR UPDATE OF l
)
SELECT count(*) = 1 AS one_row,
       min(id) AS ledger_id,
       coalesce(bool_and(status = 'dispatching'), false) AS still_dispatching
  FROM locked \gset
\if :one_row
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP no_single_row
\quit
\endif
\if :still_dispatching
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP status_not_dispatching
\quit
\endif
SELECT abs(extract(epoch FROM clock_timestamp() - :'host_now'::timestamptz)) < 2
         AS clock_skew_ok,
       :'backend_started_at'::timestamptz <= clock_timestamp() + interval '2 seconds'
         AS start_not_future,
       count(*) = 1
         AND coalesce(bool_and(c.created_at + interval '2 seconds'
                               < :'backend_started_at'::timestamptz), false)
         AS claimed_before_backend_start
  FROM integration_yida_delivery_audit c
 WHERE c.ledger_id = :'ledger_id'
   AND c.event = 'claim'
   AND c.status = 'dispatching' \gset
\if :clock_skew_ok
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP clock_skew
\quit
\endif
\if :start_not_future
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP backend_start_in_future
\quit
\endif
\if :claimed_before_backend_start
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP claim_not_before_backend_start
\quit
\endif
UPDATE integration_yida_delivery_ledger
   SET status = 'outcome_unknown'
 WHERE id = :'ledger_id' AND status = 'dispatching';
INSERT INTO integration_yida_delivery_audit (id, ledger_id, event, status, reason)
VALUES (gen_random_uuid()::text, :'ledger_id', 'unknown', 'outcome_unknown', 'manual_recovery');
SELECT (SELECT count(*) FROM integration_yida_delivery_ledger
         WHERE id = :'ledger_id' AND status = 'outcome_unknown') = 1
   AND (SELECT count(*) FROM integration_yida_delivery_audit
         WHERE ledger_id = :'ledger_id' AND event = 'unknown') = 1
   AND (SELECT count(*) FROM integration_yida_delivery_audit
         WHERE ledger_id = :'ledger_id' AND event = 'unknown'
           AND status = 'outcome_unknown' AND reason = 'manual_recovery') = 1
   AS verified \gset
\if :verified
COMMIT;
\echo DISPATCHING_RECOVERY=DONE status=outcome_unknown reason=manual_recovery
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=ROLLED_BACK verify_failed
\endif
```

在同一个窗口里运行（先重新取一次「现在」）：

```powershell
$hostNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
psql -X -q -A -v "grant_id=<owner 交来的授权号>" -v "backend_started_at=$started" -v "host_now=$hostNow" -f yida-dispatching-recover.sql
```

需要 psql 10 及以上（`\if`）与 PostgreSQL 13 及以上（内置 `gen_random_uuid()`）。

脚本做的事，逐项对应代码与约束：

- **缺输入就停**：没有授权号、S 或「现在」时输出 `STOP missing_…`，什么都不连、不改。
- **先锁行，再重查状态**：一个事务里按授权号经准入记录找到台账行，`FOR UPDATE` 锁住，与存储模块 `finish()` 的锁法相同（`yida-delivery-store.cjs:230-234`、`:297`）。如果发送进程的 ACK 正在提交，脚本在这里等它提交完，读到的是提交之后的状态；不是恰好一行输出 `STOP no_single_row`，状态已经不是 `dispatching`（例如 ACK 先提交了）输出 `STOP status_not_dispatching`。两种都回滚，什么都不改。
- **锁住之后再判进程级事实**：两台时钟相差不到 2 秒（否则 `STOP clock_skew`），S 不在未来（否则 `STOP backend_start_in_future`），这一行恰有一条认领审计且认领时间 + 2 秒早于 S（否则 `STOP claim_not_before_backend_start`）。认领审计的时间是认领事务写入时的数据库时间（`yida-delivery-store.cjs:276`，列缺省 `NOW()`，`090_create_integration_yida_delivery_ledger.sql:56`）。
- **只改状态**：`UPDATE … SET status = 'outcome_unknown' WHERE id = … AND status = 'dispatching'`，与 `finish()` 的未知分支写的是同一个状态（`yida-delivery-store.cjs:301-305`）。身份列、`claim_token`、`claim_actor_id` 一个都不写，触发器也不允许改（第 3 节）。
- **同一事务写一条审计**：`event = 'unknown'`、`status = 'outcome_unknown'`、`reason = 'manual_recovery'`，这是审计表形状约束允许的组合（`090_create_integration_yida_delivery_ledger.sql:52-63`，`unknown` 一行在 `:61`），与存储模块写的形状相同（`yida-delivery-store.cjs:175-180`、`:310`）。
- **提交前核对**：这一行是 `outcome_unknown`，这一行恰有一条 `unknown` 审计，且它就是 `manual_recovery`。三条都成立才 `COMMIT` 并输出 `DISPATCHING_RECOVERY=DONE status=outcome_unknown reason=manual_recovery`；否则 `ROLLBACK` 并输出 `ROLLED_BACK verify_failed`。
- **中途断开 = 什么都没发生**：所有写入在同一个事务里，psql 报错（`ON_ERROR_STOP`）或连接中断时整体回滚，行仍是 `dispatching`、审计不变。锁等待最多 5 秒（`lock_timeout`），单条语句最多 30 秒。
- 不碰授权、准入、授权审计三张表（只读其中的准入记录），不碰占位索引。

**之后迟到的结果写不进来**：即使原进程其实还活着、事后才想写回结果，`finish()` 锁行后看到的不是 `dispatching`，按 `YIDA_DELIVERY_STATE` 拒绝（`yida-delivery-store.cjs:298`），行保持 `outcome_unknown`。这是纵深防御，不是可以跳过第 5 节的理由：那种情况下宜搭里有记录，而台账只写着「结果不明」。

**禁止**：不得 `DELETE` / `TRUNCATE` 台账或审计表；不得用 `session_replication_role`、`ALTER TABLE … DISABLE TRIGGER` 等任何方式绕过触发器；不得手写别的状态转换（例如直接改成 `acknowledged` 或 `not_sent`）；不得改 `claim_token`、`claim_actor_id`；不得释放占位；不得为了「让它能重发」做任何事。

## 8. 执行后核对

1. 最后一行必须是 `DISPATCHING_RECOVERY=DONE status=outcome_unknown reason=manual_recovery`。是 `STOP …` 或 `ROLLED_BACK …`，或者 psql 报错退出：什么都没改，报 owner，**不要改脚本重试**。
2. 再跑第 6 节只读核对：`ledger` 的 `dispatching` 少 1、`outcome_unknown` 多 1；`audit` 的 `unknown|outcome_unknown|manual_recovery` 多 1；其余计数不变；`dispatching` 一行的 C、D 仍是 0。
3. 若面板上还留着这条授权：点「手动刷新持久记录（只读）」，应显示 `持久记录状态：outcome_unknown。`（观察接口按状态如实返回：`yida-send-approval-service.ts:463-490`）。面板已重置时以第 2 步为准。
4. 之后按结果不明处理（首发手册 `runbook-yida-first-send-20261104.md` S3 第 14 步）：owner 在宜搭界面按业务键人工核对，只记「有 / 无 / 多」。对同一行**不要**再批准或提交：占位仍在（第 3 节）。

## 9. 回报什么（values-free）

只报：

- 第 5 节的判读行（`listenerProcesses`、`backendIsNode`、`olderNodeProcesses`、`olderPm2Hosts` 的值），**不报** `backendStartedAt`；
- 执行前、执行后第 6 节的计数与 `clock` 行的 `t` / `f`；
- 第 7 节最后一行（`DONE`，或 `STOP` / `ROLLED_BACK` 及其固定原因词）；
- 第 8 节第 3 步的面板状态类别（若做了），第 4 步宜搭核对的「有 / 无 / 多」；
- owner 批准的日期。

不报：授权号、台账号、进程号、时间戳、草稿号、rowKey、业务键、连接信息、命令行、任何字段内容。

## 附：本手册怎么核的

- 第 6、7 节两段 SQL 就是仓库里的两个 `.sql` 文件；`packages/core-backend/tests/integration/stock-preparation-yida-write-ledger-realdb.test.ts` 的「Y1 dispatching recovery runbook」一组用例先核对本手册里的两段与文件逐字节相同，再用真的 `psql` 客户端执行这两个文件，对象是一次性 PostgreSQL 14 库里每个用例自己的 schema：按 main 原样执行 `090`、`zzzz20261105033000`、`091`，台账行由生产存储模块 `prepare()` / `claim()` 写出；准入表用同名同类型列的最小桩表（只用到 `grant_id`、`ledger_id`）；全部合成数据。CI 的 runtime-db 作业在锁协议真库步骤里跑这个文件（`.github/workflows/plugin-tests.yml`）。
- 三个验收用例（§3.2 第 4 条）：
  - **ACK 先提交**：ACK 事务写完状态与审计、停在 `COMMIT` 之前；脚本被这一行的锁挡住（数据库里观察到锁等待）；ACK 提交后脚本输出 `STOP status_not_dispatching`，行是 `acknowledged`，审计只有 `prepare`、`claim`、`acknowledgement`。
  - **恢复先提交**：另一个会话锁住审计表，让脚本停在写审计这一句（已锁行、已改状态）；这时原持有者迟到的 ACK 被脚本的行锁挡住；放开之后脚本输出 `DONE`，迟到的 ACK 与之后的 `markUnknown` 都按 `YIDA_DELIVERY_STATE` 被拒；除 `status`、`updated_at` 外整行不变（含 `claim_token`、`claim_actor_id`），审计恰好多一条 `unknown | outcome_unknown | manual_recovery`；同一业务键再 `prepare()` 被占位拒绝；同一授权再跑输出 `STOP status_not_dispatching`。
  - **事务中断**：同样停在写审计这一句，然后用 `pg_terminate_backend` 断开脚本的会话；psql 非 0 退出，行仍是 `dispatching`，台账与审计逐行与执行前相同；之后重跑正常 `DONE`。
- 另有一个拒绝用例：缺授权号 / S / 「现在」、不存在的授权、S 早于认领、S 在未来、时钟相差过大、`prepared` 行，各自输出固定的 `STOP` 原因词，台账与审计不变。
- 见过红（每次改完都按 sha256 还原）：去掉 `FOR UPDATE OF l` 或去掉状态重查，ACK 先提交用例变红（脚本没有在锁后读到 `acknowledged`，输出变成 `ROLLED_BACK verify_failed`）；去掉 `BEGIN;`，事务中断用例变红（状态改动已经单独提交，行变成 `outcome_unknown` 却没有审计）；多写一条审计，恢复先提交用例变红（提交前核对不通过，输出 `ROLLED_BACK verify_failed`）。
- 第 5 节那段 PowerShell 在开发机的 Windows PowerShell 5.1 上对合成进程实跑过（一个监听合成端口的 `node.exe`，和一个更早启动、路径为 `…\pm2\lib\Daemon.js` 的合成宿主进程）：`listenerProcesses=1`、`olderPm2Hosts=1`，`backendStartedAt` 与 `Get-Process` 的 `StartTime` 一致；停掉监听进程后 `listenerProcesses=0`。客户机上 pm2 宿主进程的命令行形态没有核对过。
- 没有在客户机或任何真实库上运行。
