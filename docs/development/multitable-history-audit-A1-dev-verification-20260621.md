# History Field-Audit Permission — A1 开发与验证 MD

> 对应 /goal「根据计划并行开发，完成后给出开发及验证 MD」。
> **计划 = design-lock #2973（`2b6a4fd48`）的分阶段 TODO（A0✅→A1→A2→A3）。本次只做 A1**——这是设计锁明确的「first allowed runtime slice」，A2/A3 各为独立 opt-in。
> **A1 = grant 模型 + contract + LOCK-2 治理层 + 发证/撤证自审计 + resolver 接缝（返回 no-reveal，不接遮罩）。** A1 刻意**不**接任何 reveal 进历史遮罩——边界证明见 §4。
>
> **更正（复审硬化）**：初版自称「**完整** LOCK-2」不准确，已删。自授（self-grant）的**不可变**闭合在 reveal-time（A2，`granted_by !== revealer`，granted_by 永不变）；A1 的 issue-time 成员校验只是 fast-fail **guardrail**（成员关系可变，拦不住「先发证、后入组」）。owner 复审又发现发证/撤证与审计**非原子**（审计失败会留下「有授权无审计」）。本轮硬化 PR 已修：①事务原子化（审计失败→回滚 grant/revoke）；②issue-time role/group 自授 guardrail。goldens 11→16。

## 0. 为什么（当时）只做 A1

design-lock 把 A1（grant 合约，不接遮罩）与 A2（真正掀遮罩的 reveal 运行时）**显式分闸**：A2 是唯一危险的一刀（它让受限字段值可被读出），owner 两条消息前刚把它单列为独立 opt-in 以便单独审查。本 /goal 说「根据计划」——执行计划的分阶段，而非把闸合并。A1 已是完整可验证的交付（迁移 + 平台能力 + 发证/撤证路由 + 全 LOCK-2 层 + 自审计 + resolver 接缝），其验证 MD 正是围绕 LOCK-2 治理 goldens 写成。A2（reveal 运行时）是下一道闸，**未建**。

## 1. 交付物（A1，全部本 PR）

| 件 | 内容 |
|---|---|
| 迁移 | `meta_history_audit_grants`（mirror `field_permissions` 形态：subject_type user/role/member-group + base 作用域 + `expires_at` + `is_standing` + `reason`/`ticket` + soft-delete `revoked_at`）；**部分唯一索引**（每 base+subject 至多一条 active）；CHECK `is_standing OR expires_at IS NOT NULL`（D5：非 standing 必有限期） |
| 平台能力 | `multitable:history-field-audit:grant` —— **独立**能力码，**只**在发证/撤证路由检查，**绝不**并入任何 `SHEET_*` 能力集 |
| 服务 | `history-audit-grant-service.ts`：`issueHistoryAuditGrant`（LOCK-2a 自授拒绝 + D5 默认有限期 + 自审计）、`revokeHistoryAuditGrant`（soft-delete + 自审计）、`listHistoryAuditGrants`（仅 active）、`loadActiveHistoryAuditGrant`（A2 将读的 active+未过期查询）、`resolveHistoryFieldAuditReveal`（**接缝：A1 恒返回空集**） |
| 路由 | `POST/GET/DELETE /bases/:baseId/history-audit-grants[/:grantId]`，授权门=`requireHistoryAuditGrantAuthority`（**只认能力码，无 isAdminRole 旁路**）+ base/subject 存在校验（mirror field_permissions） |
| 自审计 | 发证/撤证直插 `operation_audit_logs`（`metadata`+`meta`，action `history_field_audit_grant.issue|.revoke`，存 actor/base/subject/reason/expiry/standing——**无任何记录字段值**） |
| goldens | `multitable-history-audit-grant-realdb.test.ts`（**16 条**，入 plugin-tests `test (20.x)` 白名单） |

## 2. 落地的 LOCK（L2 治理层）

- **L2 授权**：发证唯一钥匙 = 平台能力 `multitable:history-field-audit:grant`。base-admin（`multitable:admin`）、粗粒度 `admin` role **都不能**发证（**无 isAdminRole 旁路**——见 §4 mutation）。
- **L2a 禁自授（issue-time guardrail）**：user 给自己 user-id 发证 → 403；给「自己所属的 role/member-group」发证 → 403。**注意**：这是 fast-fail guardrail，非闭合（成员关系可变）；不可变闭合在 A2 reveal-time（`granted_by !== revealer`）。
- **L2(d) 不可自扩**：grantee 不持有 `:grant` 能力 → 无法再发证/转授扩大自己范围（我落成「既不能自扩、也不能再转授」；owner 可收窄为允许平级转授）。
- **L2c 发证/撤证均写审计 + 原子**：各写一条 `operation_audit_logs`，且与 grant mutation 在**同一事务**（`pool.transaction`）——审计失败则整体回滚，绝无「有授权无审计」。
- **23505 穿透事务**：重复 active grant 的唯一索引冲突在事务内触发 → 回滚 → `409 GRANT_EXISTS`，不破坏既有 grant。
- **D5 默认有限期**：无 `expires_at` 且非 standing → 套 90 天有限窗；standing 必须显式 `standing:true`，并在行 + 审计中标记。
- **L5（A1 范围）**：审计只存 grant scope，绝无字段值。

## 3. A1/A2 接缝（边界）

`resolveHistoryFieldAuditReveal()` 在 A1 **恒返回空集**，且**未**被 `buildHistoryAllowedFieldsBySheet` 或按记录历史的 allowed-set 调用。A2 才把它（按显式 reveal flag + 有效 grant）UNION 进遮罩。`history-projection.ts` 与 #2968 goldens 文件**零改动**。

## 4. 验证

- backend `tsc --noEmit`：**0 error**。
- **A1 LOCK-2 goldens：16/16 pass**（真库 `metasheet_test`）：base-admin 拒 / admin-role 拒（无旁路）/ 能力持有者可发 / user 自授 403 / **role 自授 403 / member-group 自授 403（guardrail）** / grantee 不可再发 / 默认有限期 / standing 显式+标记 / 发证审计（含 reason、无值）/ 撤证 soft-delete+审计+active 剔除+重复撤证 404 / **发证审计失败→grant 回滚 / 撤证审计失败→revoke 回滚 / 重复 active→409 且首条不破** / resolver 返回 no-reveal。
- **边界证明：#2968 历史 goldens 仍 8/8 pass 且文件 byte-identical**——A1 对遮罩零改动（A1 停、A2 始的干净分界）。
- **Mutation check ①（授权门）**：临时加 `|| !access.isAdminRole`（admin 旁路）→「admin-role 拒」golden **失败**（`201` vs 期望 `403`）→ 证明「无 admin 旁路」守卫 load-bearing。
- **Mutation check ②（原子性）**：把发证路由临时改回非事务 `pool.query` → 「发证审计失败→grant 回滚」golden **失败**（grant 残留 `1` vs 期望 `0`）→ 证明原子性守卫 load-bearing。两次还原后 16/16 绿。
- backend unit：**3745/3745 pass**（本地重跑，无回归；A1 只增集成 goldens，不增 unit）。

## 5. A1 已知边界 / 留给后续

- **role/group 自授**：已补 issue-time guardrail（issuer 给自己所属 role/member-group 发证 → 403），但这是 fast-fail，**非闭合**（成员关系可变：先发证、后入组仍可绕）。**不可变闭合 = A2 reveal-time `granted_by !== revealer`**，A1 阶段自授无实际效果（无 reveal）。残余风险：两个发证人互授（合谋）——接受，且全程审计。
- **能力分配 UI / 注册表**：`multitable:history-field-audit:grant` 作为自由能力码在路由侧 enforce；纳入权限目录/分配面板是 admin 面（A3 邻域）的事。
- **未建（独立 opt-in）**：**A2** reveal 运行时（接遮罩 + reveal-flag 门 + 每次 reveal 自审计 + 真库 goldens：holder-无-flag-仍遮、行级 deny 仍生效、L7 不进 restore/preview/PIT、过期/越权遮、mutation）；**A3** 审计流水只读面。

## 6. 下一道闸

**A2 = reveal 运行时（真正掀字段遮罩的一刀）。** 需 owner 显式开闸；开时一并定：(a) L2(d) 是否允许平级转授；(b) role/group 自授是否硬拦。A2 前不动遮罩。
