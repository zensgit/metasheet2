# ACP-1B 清洗提案 Apply 路由决策包

状态：**RATIFIED — IMPLEMENTATION AUTHORIZED / DRAFT-HOLD**

Owner 已在本任务直接批准 `RATIFY ACP-1B OD-ATC-12A(a)`，选择下述 A，合同内容不变。
后续协调窗口允许必要的 current-main 同步、已批准的 DB/schema/anchor/W4 dual-CAS
开发、隔离合成数据库验证与清理、ordinary push 和新 Draft/HOLD PR；窗口截至
2026-09-08T15:10:31Z。该授权不包括 Ready、merge、启用或部署。

日期：2026-09-07（Asia/Taipei）  
前置：已 ratified 的 `OD-ATC-11R(a)` durable server-owned anchor ledger。

## 已验证的边界

现有 `POST /api/attendance/anomaly-result-edits` 不是 ACP-1B 的安全入口：
它接受客户端 `recordId`、`targetStatus`、`reason`、`evidence`、指标覆盖、
idempotency key 和 calculation identity。即使其最终经过 W4 `manual_edit`，也不满足
ACP-1B 的要求：客户端不能选择 canonical record、目标状态、原因、考勤指标或计算版本。

因此，不能通过修改前端参数或在客户端隐藏字段来复用该 route。

## 请求的 owner 决定

请选择一个选项：

| 选项 | 决定 | 后果 |
| --- | --- | --- |
| **A（推荐）** | 明确授权一个 ACP-1B 专属、record-scoped 的 approve-and-apply route。 | 可完成受控回写闭环；route 只接受 `expectedVersion`。 |
| B | 复用通用 anomaly-result-edits route。 | 拒绝：客户端可供应 ACP 禁止的 canonical/business 输入。 |
| C | 不提供 apply route。 | 只能交付单向投影和提案字段，不能完成用户请求的受控回写闭环。 |

建议的明确回复：

> RATIFY ACP-1B OD-ATC-12A(a)

## 选项 A 的闭合契约

新增的受保护入口只能是：

```text
POST /api/attendance/report-records/:recordId/cleaning-apply
body: { expectedVersion: positive integer }
```

客户端不得发送组织、员工、日期、canonical record、状态、原因、打卡、请假、出差、
加班、指标、calculation identity、operation identity 或证据。服务端必须：

1. 要求 active same-org `attendance:admin`、既有结果编辑 policy 和 literal-true ACP policy；
2. 从 projection record、durable anchor、DB-fresh canonical record 和 posture-selected calculation
   重新推导所有输入；
3. 仅接受 `cleaning_requested === true` 与有界 normalized `cleaning_reason`；目标固定为 `normal`；
4. 在既有 W4 `manual_edit` operation boundary 内保持既定 advisory/target lock 顺序、proposal
   version 与 calculation identity/version CAS；
5. 强制 `notifyAffectedEmployee: false`，不创建 ACP lifecycle、projection 或 external outbox；
6. canonical commit 后仅以 CAS 清除 `cleaning_requested`、`cleaning_reason`。cleanup 冲突返回
   `applied_pending_cleanup`，不得重复 canonical edit；
7. 对 anchor、sheet/field/row access、source digest、calculation、membership 或 CAS 的任一不一致
   返回 values-free failure，且在 canonical commit 前零写入。

## 审批后的最小验证

- real PostgreSQL、`RBAC_BYPASS=false`：valid current/latest-completed paths 各一次 W4 edit；
- 两个 canonical anomalies 的 identity/fingerprint/calculation tampering 均零写；
- permission/sheet/field/row revoke、duplicate row key、legacy row、anchor rebind、proposal and
  calculation races 均 fail closed；
- cleanup replay exactly-once，notification/external fan-out/ACP lifecycle outbox 均为零；
- Node 18/20 repeated focused tests、typecheck、web tests、migration replay/down/reapply、residue zero。

本包不授权 Ready、merge、flag enablement、dispatch、deployment、staging、production 或真实客户数据。
