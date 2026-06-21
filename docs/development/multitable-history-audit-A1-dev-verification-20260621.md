# History Field-Audit Permission — A1 开发与验证 MD

> 对应 /goal「根据计划并行开发，完成后给出开发及验证 MD」。
> **计划 = design-lock #2973（`2b6a4fd48`）的分阶段 TODO（A0✅→A1→A2→A3）。本次只做 A1**——这是设计锁明确的「first allowed runtime slice」，A2/A3 各为独立 opt-in。
> **A1 = grant 模型 + contract + 完整 LOCK-2 治理层 + 发证/撤证自审计 + resolver 接缝（返回 no-reveal，不接遮罩）。** A1 刻意**不**接任何 reveal 进历史遮罩——边界证明见 §4。

## 0. 为什么只做 A1（而非 A1+A2）

design-lock 把 A1（grant 合约，不接遮罩）与 A2（真正掀遮罩的 reveal 运行时）**显式分闸**：A2 是唯一危险的一刀（它让受限字段值可被读出），owner 两条消息前刚把它单列为独立 opt-in 以便单独审查。本 /goal 说「根据计划」——执行计划的分阶段，而非把闸合并。A1 已是完整可验证的交付（迁移 + 平台能力 + 发证/撤证路由 + 全 LOCK-2 层 + 自审计 + resolver 接缝），其验证 MD 正是围绕 LOCK-2 治理 goldens 写成。A2（reveal 运行时）是下一道闸，**未建**。

## 1. 交付物（A1，全部本 PR）

| 件 | 内容 |
|---|---|
| 迁移 | `meta_history_audit_grants`（mirror `field_permissions` 形态：subject_type user/role/member-group + base 作用域 + `expires_at` + `is_standing` + `reason`/`ticket` + soft-delete `revoked_at`）；**部分唯一索引**（每 base+subject 至多一条 active）；CHECK `is_standing OR expires_at IS NOT NULL`（D5：非 standing 必有限期） |
| 平台能力 | `multitable:history-field-audit:grant` —— **独立**能力码，**只**在发证/撤证路由检查，**绝不**并入任何 `SHEET_*` 能力集 |
| 服务 | `history-audit-grant-service.ts`：`issueHistoryAuditGrant`（LOCK-2a 自授拒绝 + D5 默认有限期 + 自审计）、`revokeHistoryAuditGrant`（soft-delete + 自审计）、`listHistoryAuditGrants`（仅 active）、`loadActiveHistoryAuditGrant`（A2 将读的 active+未过期查询）、`resolveHistoryFieldAuditReveal`（**接缝：A1 恒返回空集**） |
| 路由 | `POST/GET/DELETE /bases/:baseId/history-audit-grants[/:grantId]`，授权门=`requireHistoryAuditGrantAuthority`（**只认能力码，无 isAdminRole 旁路**）+ base/subject 存在校验（mirror field_permissions） |
| 自审计 | 发证/撤证直插 `operation_audit_logs`（`metadata`+`meta`，action `history_field_audit_grant.issue|.revoke`，存 actor/base/subject/reason/expiry/standing——**无任何记录字段值**） |
| goldens | `multitable-history-audit-grant-realdb.test.ts`（11 条，入 plugin-tests `test (20.x)` 白名单） |

## 2. 落地的 LOCK（L2 治理层）

- **L2 授权**：发证唯一钥匙 = 平台能力 `multitable:history-field-audit:grant`。base-admin（`multitable:admin`）、粗粒度 `admin` role **都不能**发证（**无 isAdminRole 旁路**——见 §4 mutation）。
- **L2a 禁自授**：user 给自己 user-id 发证 → 403 `SELF_GRANT`。
- **L2(d) 不可自扩**：grantee 不持有 `:grant` 能力 → 无法再发证/转授扩大自己范围（我落成「既不能自扩、也不能再转授」；owner 可收窄为允许平级转授）。
- **L2c 发证/撤证均写审计**：各写一条 `operation_audit_logs`。
- **D5 默认有限期**：无 `expires_at` 且非 standing → 套 90 天有限窗；standing 必须显式 `standing:true`，并在行 + 审计中标记。
- **L5（A1 范围）**：审计只存 grant scope，绝无字段值。

## 3. A1/A2 接缝（边界）

`resolveHistoryFieldAuditReveal()` 在 A1 **恒返回空集**，且**未**被 `buildHistoryAllowedFieldsBySheet` 或按记录历史的 allowed-set 调用。A2 才把它（按显式 reveal flag + 有效 grant）UNION 进遮罩。`history-projection.ts` 与 #2968 goldens 文件**零改动**。

## 4. 验证

- backend `tsc --noEmit`：**0 error**。
- **A1 LOCK-2 goldens：11/11 pass**（真库 `metasheet_test`）：base-admin 拒 / admin-role 拒（无旁路）/ 能力持有者可发 / 自授 403 / grantee 不可再发 / 默认有限期 / standing 显式+标记 / 发证审计（含 reason、无值）/ 撤证 soft-delete+审计+active 列表剔除+重复撤证 404 / resolver 返回 no-reveal。
- **边界证明：#2968 历史 goldens 仍 8/8 pass 且文件 byte-identical**——A1 对遮罩零改动（A1 停、A2 始的干净分界）。
- **Mutation check（最关键）**：在授权门临时加 `|| !access.isAdminRole`（admin 旁路）→「admin-role 拒」golden **失败**（`expected 201 to be 403`，admin 越过能力码发证成功）；还原后 11/11 绿 → 证明该 golden load-bearing，正是 L2 地雷的守卫。
- backend unit：**3745/3745 pass**（本地重跑，无回归；A1 只增集成 goldens，不增 unit）。

## 5. A1 已知边界 / 留给后续

- **role/group 自授**：A1 只硬拦 user 自授（issuer===subjectId）。issuer 给「自己所属的 role/group」发证（间接自授）未拦——需成员关系查询，属策略判断，连同 L2(d) 转授口径一并留给 owner 定。
- **能力分配 UI / 注册表**：`multitable:history-field-audit:grant` 作为自由能力码在路由侧 enforce；纳入权限目录/分配面板是 admin 面（A3 邻域）的事。
- **未建（独立 opt-in）**：**A2** reveal 运行时（接遮罩 + reveal-flag 门 + 每次 reveal 自审计 + 真库 goldens：holder-无-flag-仍遮、行级 deny 仍生效、L7 不进 restore/preview/PIT、过期/越权遮、mutation）；**A3** 审计流水只读面。

## 6. 下一道闸

**A2 = reveal 运行时（真正掀字段遮罩的一刀）。** 需 owner 显式开闸；开时一并定：(a) L2(d) 是否允许平级转授；(b) role/group 自授是否硬拦。A2 前不动遮罩。
