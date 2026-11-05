# 宜搭投递台账：把从未被认领的 `prepared` 行收口为 `not_sent`（DBA 手册，门 2）

> **用途**：#6315 正文「Gates before the send switch may be turned on」第 2 条要求：对从未被认领的 `prepared` 台账行有审计路径或 DBA 手册。本手册就是这本 DBA 手册（登记册 R-70 ②，owner 2026-11-04 裁定）。
> **基线**：所有 `path:line` 都在 main `b36f53c2f`（#6718 的合并提交）上核过。台账、审计、防重占位三张表的迁移与台账存储模块在 R79（`onprem-r79` = `7f04c54c2`）与 main 之间逐字节相同（`git diff 7f04c54c2 b36f53c2f` 对 `090` / `091` / `095` 迁移、`yida-delivery-store.cjs`、`yida-delivery-runner.mjs`、`yida-owner-send-port.mjs` 为空），所以本手册对客户测试机上的 R79 同样成立。
> **values-free**：不含主机、地址、口令、连接串、密钥或任何客户值。授权号、台账号等编号只会出现在执行人自己的屏幕上，**不写进任何回报、issue 或 PR**。
> **本手册不做的事**：不释放业务键占位、不重发、不改授权记录、不碰宜搭；不改代码、开关或配置。

## 1. 什么时候用

**全部满足**才用：

1. 一次「提交此授权一次」之后，持久记录状态停在 `prepared`（面板「手动刷新持久记录（只读）」显示 `持久记录状态：prepared。`，或本手册第 4 节的只读查询看到）。`prepared` = 已准入、**从未被认领**、什么都没发：认领（`prepared → dispatching`）发生在出网之前（`plugins/plugin-integration-core/lib/yida-delivery-runner.mjs:318`、`:323`），`prepared` 行的 `claim_token` / `claim_actor_id` 必为空（`packages/core-backend/migrations/090_create_integration_yida_delivery_ledger.sql:31-33`）。
2. 这条授权的到期时间已过**至少 5 分钟**（脚本按数据库时钟判断）。理由：同一授权一旦准入，再次提交只返回历史、不再签发执行许可（`packages/core-backend/src/integration/yida-send-approval-service.ts:424-428`、`:555-562`；`plugins/plugin-integration-core/lib/yida-owner-send-port.mjs:113-118`），所以这一行只可能被**当次**运行认领；当次运行在认领之前要再核一次授权未过期（`yida-send-approval-service.ts:565-590`，到期判断用数据库时钟 `:266-268`），且运行有自己的计时上限（默认 10 秒 `yida-delivery-runner.mjs:215`，端口允许的上限 60 秒 `:225`）。授权最长 15 分钟（`yida-send-approval-service.ts:14`；`packages/core-backend/migrations/095_create_integration_yida_send_approvals.sql:20-22`）。到期 5 分钟之后，这一行已不可能再被认领。
3. owner 对**这一次**明确批准（见第 2 节）。

**不适用**：`dispatching`、`acknowledged`、`outcome_unknown` 一律不碰——这三种状态可能已经出网，台账触发器也只允许 `prepared → dispatching | not_sent` 与 `dispatching → acknowledged | outcome_unknown`（`090_create_integration_yida_delivery_ledger.sql:91-94`）。`not_sent` 已是终态，无需处理。

**为什么要做**：不做也不会重发、不会出错，只是这一行永远停在 `prepared`，看上去像「还在途」。收口为 `not_sent` 后，面板与只读查询都能明确读到「确定什么都没发」。这也是代码里已有、但没有任何生产调用方的那条路径：`cancelPrepared()`（`plugins/plugin-integration-core/lib/yida-delivery-store.cjs:316-329`，审计事件 `cancel`）；在 `b36f53c2f` 上 `git grep cancelPrepared` 只命中该模块与测试文件。本手册的 SQL 与它做的是同一件事。

## 2. 谁批、怎么批

- **owner 逐次批准**（O 层：直接写客户机数据库）。一次批准只覆盖一条授权的一行，不能「以后都这样处理」。
- 批准时 owner 只需要看到：面板或只读查询给出的状态类别 `prepared`、授权已过期至少 5 分钟、第 4 节只读查询的计数。授权号由 owner 线下交给执行人（不进任何回报）。
- 执行人：持有该部署数据库连接的运维 / DBA。Claude 不执行本手册。

## 3. 先知道：占位不释放，不能重发

- 新建的防重占位是台账上按 `(tenant_id, workspace_id, target_ref, business_key_digest)` 建的部分唯一索引（`intent = 'create'`），**与状态无关**：`packages/core-backend/migrations/091_create_integration_yida_create_fence.sql:45-47`；迁移头注释写明「包括 `not_sent` 在内的每个状态都保留占位」（`:1-5`）。R-50 ⑥ 同一结论。
- 所以收口之后，这一行的业务键在**这个目标**上仍然被占用：同一行不能再经 MetaSheet 新建，换新草稿也不行（新草稿只换 `operation_id`，业务键不变，索引照样拒绝）。要在宜搭里补这条记录，只能由 owner 另行决定（例如在宜搭界面人工录入）；本手册不提供任何重发路径。
- #6718 带来的变化：台账行与占位都带授权所属的目标（`target_ref`），占位的键不变；多目标开关 `INTEGRATION_YIDA_MULTI_TARGET_ENABLED` 按 R-70 ③ 保持关闭，所以客户机上只有一个目标。#6718 的迁移 `zzzz20261103130000_add_integration_yida_multi_target_slots.ts` 只改目标槽、加登记表，**没有**改台账、审计表或占位索引（该文件全文不出现这三个对象）；main 上触及这三个对象的迁移仍只有 `090`、`091` 与引用台账的 `095`。

## 4. 只读核对（执行前、执行后各跑一次）

保存为 `yida-ledger-status-classes.sql`（纯 ASCII；只输出状态类别与计数）：

```sql
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT 'ledger' AS kind, status, count(*) AS n
  FROM integration_yida_delivery_ledger GROUP BY status ORDER BY status;
SELECT 'audit' AS kind, event, status, count(*) AS n
  FROM integration_yida_delivery_audit GROUP BY event, status ORDER BY event, status;
SELECT 'prepared_without_admission' AS kind, count(*) AS n
  FROM integration_yida_delivery_ledger l
 WHERE l.status = 'prepared'
   AND NOT EXISTS (SELECT 1 FROM integration_yida_send_admissions a WHERE a.ledger_id = l.id);
SELECT 'prepared_expired_5min' AS kind, count(*) AS n
  FROM integration_yida_send_approvals g
  JOIN integration_yida_send_admissions a ON a.grant_id = g.grant_id
  JOIN integration_yida_delivery_ledger l ON l.id = a.ledger_id
 WHERE l.status = 'prepared'
   AND g.expires_at_ms + 300000 < floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
ROLLBACK;
```

运行：`psql -X -q -A -f yida-ledger-status-classes.sql`，连接参数用该部署后端所连的同一个库（连接信息由执行人自备，不写进回报）。PATH 里没有 `psql` 时用 PostgreSQL 安装目录下 `bin` 里的完整路径。

判读：

- `prepared_without_admission` 必须是 `0`。准入在同一事务里先写 `prepared` 台账行、再写准入记录（`yida-send-approval-service.ts:421-458`；准入表 `095_create_integration_yida_send_approvals.sql:37-45`，`ledger_id` 唯一 `:40`），所以 `prepared` 行都应有准入记录。不是 0：停，报 owner，不执行第 5 节。
- `prepared_expired_5min` 是第 1 节条件 1、2 都满足的行数。是 0：没有可收口的行（或还没到 5 分钟），不执行第 5 节。

## 5. 收口（单事务；owner 批准后执行一次）

保存为 `yida-cancel-prepared.sql`（纯 ASCII）：

```sql
\set ON_ERROR_STOP on
\if :{?grant_id}
\else
\echo CANCEL_PREPARED=STOP missing_grant_id
\quit
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
WITH locked AS (
  SELECT l.id
    FROM integration_yida_send_approvals g
    JOIN integration_yida_send_admissions a ON a.grant_id = g.grant_id
    JOIN integration_yida_delivery_ledger l ON l.id = a.ledger_id
   WHERE g.grant_id = :'grant_id'
     AND l.status = 'prepared'
     AND l.intent = 'create'
     AND l.claim_token IS NULL
     AND l.claim_actor_id IS NULL
     AND g.expires_at_ms + 300000 < floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
     FOR UPDATE OF l
)
SELECT count(*) = 1 AS one_row, min(id) AS ledger_id FROM locked \gset
\if :one_row
UPDATE integration_yida_delivery_ledger
   SET status = 'not_sent'
 WHERE id = :'ledger_id' AND status = 'prepared';
INSERT INTO integration_yida_delivery_audit (id, ledger_id, event, status, reason)
VALUES (gen_random_uuid()::text, :'ledger_id', 'cancel', 'not_sent', NULL);
SELECT (SELECT count(*) FROM integration_yida_delivery_ledger
         WHERE id = :'ledger_id' AND status = 'not_sent') = 1
   AND (SELECT count(*) FROM integration_yida_delivery_audit
         WHERE ledger_id = :'ledger_id' AND event = 'cancel' AND status = 'not_sent') = 1
   AS verified \gset
\if :verified
COMMIT;
\echo CANCEL_PREPARED=DONE status=not_sent
\else
ROLLBACK;
\echo CANCEL_PREPARED=ROLLED_BACK verify_failed
\endif
\else
ROLLBACK;
\echo CANCEL_PREPARED=STOP no_single_eligible_row
\endif
```

运行：`psql -X -q -A -v grant_id=<owner 交来的授权号> -f yida-cancel-prepared.sql`（同上连接参数）。需要 psql 10 及以上（`\if`）与 PostgreSQL 13 及以上（内置 `gen_random_uuid()`）。

脚本做的事，逐项对应代码与约束：

- 只认**这条授权**准入的那一行，且必须仍是 `prepared`、`create`、未认领、授权已过期 5 分钟；行锁 `FOR UPDATE`，与存储模块 `cancelPrepared()` 的 `selectOneForUpdate` 相同（`yida-delivery-store.cjs:228-232`、`:316-321`）。不是恰好一行：回滚、输出 `CANCEL_PREPARED=STOP no_single_eligible_row`，什么都不改。
- `UPDATE … SET status = 'not_sent' WHERE id = … AND status = 'prepared'`：与 `cancelPrepared()` 的条件一致（`yida-delivery-store.cjs:322-324`）。台账触发器允许这一转换并自动刷新 `updated_at`（`090_create_integration_yida_delivery_ledger.sql:91-94`、`:104`）；`not_sent` 的形状约束要求认领字段与回执字段全空（`:31-33`），`prepared` 行本来就是空的。
- 同一事务插入审计行：`event = 'cancel'`、`status = 'not_sent'`、`reason` 为空，这是审计表形状约束唯一允许的取消组合（`090_create_integration_yida_delivery_ledger.sql:52-54`、`:62`）；审计主键是不带默认值的文本（`:50`），存储模块用随机 UUID（`yida-delivery-store.cjs:173-178`），脚本用 `gen_random_uuid()::text`，效果相同。
- 提交前核对「这一行是 `not_sent`」且「恰有一条 `cancel` 审计」，两条都成立才 `COMMIT`，否则 `ROLLBACK` 并输出 `CANCEL_PREPARED=ROLLED_BACK verify_failed`。
- 不碰授权、准入、授权审计三张表（它们只许 INSERT，`095_create_integration_yida_send_approvals.sql:56-90`；授权审计事件只有 `approve` / `revoke` / `admit`，`:50`）。不碰占位索引。

**禁止**：不得 `DELETE` / `TRUNCATE` 台账或审计表（触发器拒绝，`090_create_integration_yida_delivery_ledger.sql:72`、`:113-137`）；不得用 `session_replication_role`、`ALTER TABLE … DISABLE TRIGGER` 等任何方式绕过触发器；不得手写别的状态转换；不得把 `not_sent` 改回 `prepared`（触发器拒绝：`YIDA_DELIVERY_TRANSITION`）。

## 6. 执行后核对

1. 最后一行必须是 `CANCEL_PREPARED=DONE status=not_sent`。是 `STOP` 或 `ROLLED_BACK`：什么都没改，报 owner，不要改脚本重试。
2. 再跑第 4 节只读查询：`ledger` 的 `prepared` 少 1、`not_sent` 多 1；`audit` 的 `cancel | not_sent` 多 1；其余计数不变；`prepared_without_admission` 仍是 0。
3. 若面板上还留着这条授权：点「手动刷新持久记录（只读）」，应显示 `持久记录状态：not_sent。`（观察接口按 `not_sent` 正常返回：`yida-send-approval-service.ts:463-490`）。面板已重置、授权号已不在页面上时，以第 2 步为准。
4. 对同一行**不要**再批准或提交：占位仍在（第 3 节），新的准入会被拒绝。

## 7. 回报什么（values-free）

只报：

- 执行前、执行后第 4 节的计数（状态类别 + 数字）；
- 第 5 节最后一行（`CANCEL_PREPARED=DONE status=not_sent`，或 `STOP` / `ROLLED_BACK` 及其固定原因词）；
- 第 6 节第 3 步的面板状态类别（若做了）；
- owner 批准的日期。

不报：授权号、台账号、草稿号、rowKey、业务键、连接信息、任何字段内容。

## 附：本手册怎么核的

- 第 4、5 节两段 SQL 在一次性 PostgreSQL 14 库上实跑：按 main `b36f53c2f` 原样执行 `090`、`091` 两个迁移，`integration_yida_send_approvals` / `integration_yida_send_admissions` 用同名同类型列的最小桩表（只用到 `grant_id`、`expires_at_ms`、`ledger_id`），全部合成数据。结果：缺授权号 ⇒ `STOP missing_grant_id`；到期不足 5 分钟、`dispatching` 行、不存在的授权 ⇒ 各自 `STOP no_single_eligible_row` 且计数不变；合格行 ⇒ `DONE`，`prepared` −1、`not_sent` +1、`cancel` 审计 +1；同一授权再跑 ⇒ `STOP`；收口后对同一业务键再插入新建行 ⇒ 被 `uniq_integration_yida_delivery_create_business` 拒绝（占位未释放）；把 `not_sent` 改回 `prepared` ⇒ `YIDA_DELIVERY_TRANSITION`。
- 回滚分支见过红：把提交前核对改成「恰有两条 `cancel` 审计」后，合格行输出 `ROLLED_BACK verify_failed`，计数与执行前完全相同；改回后恢复 `DONE`。
- 没有在客户机或任何真实库上运行。
