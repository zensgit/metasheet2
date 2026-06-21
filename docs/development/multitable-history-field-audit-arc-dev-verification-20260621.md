# History Field-Audit Permission — A1→A3 arc 开发与验证 MD

> 对应 /goal「请根据计划完成余下所有的开发。可并行开发，完成后给出开发及验证 MD」。
> **计划 = design-lock #2973（`2b6a4fd48`）的分阶段 TODO（A0✅→A1→A2→A3）。本 MD 覆盖整条 arc 余下全部开发并已全部落 `main`。**
> 这是一个**独立的、受治理的 break-glass**：admin 单凭身份永不解锁字段历史；解锁靠独立授予，且**授予与每次使用都被审计**。

## 0. 分阶段交付（全部 MERGED / landing）

| 阶段 | 内容 | PR / SHA |
|---|---|---|
| **A1** | grant 模型 + 平台能力 + 发证/撤证路由 + resolver 接缝（不接遮罩） | #2976 `09564b78c` |
| **A1 硬化** | 复审修两 P1：发证/撤证+审计**事务原子化**；issue-time role/group 自授 guardrail + 更正「完整 LOCK-2」过度声称 | #2979 `7e75ec7c3` |
| **A2** | **reveal 运行时**（真正掀字段遮罩的一刀）+ audit-before-disclosure | #2981 `472a1c745` |
| **A3** | 审计流水只读面（who-granted / who-revealed，gated on 同一能力） | 本 PR |

## 1. 落地的 LOCK（L1–L8，逐条有真库 golden 或结构性保证）

- **L1 独立授予**：唯一能掀历史字段遮罩的是 `meta_history_audit_grants` 中的有效 grant；`admin`/`multitable:admin`/行级 admin-bypass 都不附带。无 grant → 完全等于 #2968 遮罩（边界 8/8 byte-identical）。
- **L2 授权 + 职责分离 + 发证审计 + 不可自扩**：发证唯一钥匙 = 平台能力 `multitable:history-field-audit:grant`（**只**在发证/撤证/审计面检查，**绝不**并入任何 `SHEET_*` 集；**无 isAdminRole 旁路**，mutation-checked）。issuer≠grantee：user 直接自授（issue-time 拒）+ role/group 间接自授（issue-time guardrail）+ **reveal-time `granted_by <> revealer`（不可变闭合，subsumes 全部自授路径，mutation-checked）**。grantee 不持能力→不能再发证自扩。发证/撤证与 grant mutation **同一事务**（审计失败→回滚，mutation-checked）。
- **L3 fail-closed / inert**：无 grant / 能力关 / 任何解析边缘 → 遮罩，绝不泄。过期 grant → 不解（golden）。
- **L4 只掀字段轴，不掀行轴，只读**：reveal 只在 actor 本就能行读的记录上掀字段；**行级 deny 在 reveal 下仍生效**（golden）；不授任何写。
- **L5 reveal 自审计 + 审计不存值 + audit-before-disclosure**：每次 reveal 先写一条 `operation_audit_logs`（actor/base/scope/reason，**无值**）**再**披露；**审计失败→降级为遮罩响应**（never unaudited reveal，mutation-checked）。发证审计同样只存 scope。
- **L6 双面同一 resolver**：全局历史（events/detail via `buildHistoryAllowedFieldsBySheet`）与按记录历史（per-record route）走同一 reveal 链；两面 parity（golden）。
- **L7 reveal 不进任何写/恢复路径（by construction）**：`loadRevealedFieldIds`（掀遮罩的函数）仅被 3 条读路由可达，grep 证实无 write/restore/preview/PIT 调用方。
- **L8 reveal 必带 reason 并写审计**：`?reveal=1` 无 `reason` → 400（三面 golden）；`ticket` 可选。
- **D6 公式 taint 不被 reveal 掀**（已 TRACE + **真库 golden**）：reveal 只掀本表 `field_permissions` scope，`maskStoredRecordFieldIds` 仍无条件执行；`resolveTaintedFormulaFieldIds` 的「外表字段是否被拒」经 `resolveForeignFieldReadability` **独立**解析（不取自被 reveal 拓宽的候选集），故跨表物化公式值在 reveal 下仍被 taint 丢弃。专项 golden `...reveal-taint-realdb`（跨表 lookup→formula→taint）：control 证非空过（不被拒者见公式值）+ baseline 证 taint 正常遮 + **reveal 下仍遮**。
- **D5 默认有限期**：无 expiry 且非 standing → 90 天有限窗；standing 必须显式 + 标记（goldens）。

## 2. 验证

- backend `tsc --noEmit`：**0 error**。
- **真库历史 goldens：46/46 pass**（`metasheet_test`；含后补的 D6 taint golden ×4）：
  - `multitable-history-events-realdb`（#2968 边界）**8/8 byte-identical**（reveal 默认关 → 行为不变，A1/A2 接缝与 boundary 证明）；
  - `multitable-history-audit-grant-realdb`（A1+硬化）**15**：能力门 / 无 admin 旁路 / user+role+group 自授拒 / 默认有限期 / standing / 发证撤证审计 / **原子回滚（issue+revoke）** / 重复→409；
  - `multitable-history-audit-reveal-realdb`（A2）**13**：默认遮 / 持证无 flag 遮 / reveal 成功（id+值+计数）/ reason→400 / **自授拒** / 过期拒 / **行级 deny 仍生效** / hidden 不掀 / reveal 审计（无值）/ **审计失败→降级遮** / per-record parity / 无 admin 旁路；
  - `multitable-history-audit-log-realdb`（A3）**6**：能力门（非能力 + admin role 均拒）/ base 作用域 / **无值** / kind 过滤；
  - `multitable-history-audit-reveal-taint-realdb`（D6 后补）**4**：control（不被拒者见公式值，非空过）/ taint baseline（被拒者正常遮）/ **D6 reveal 下仍遮**。
- **Mutation checks（4，全部 load-bearing）**：① 授权门加 isAdminRole 旁路 → admin-role golden 失败；② 发证改回非事务 → 原子回滚 golden 失败；③ 去掉 `granted_by <> $2` → 自授 golden 失败；④ 去掉 audit-degrade → 未审计 reveal golden 失败。
- backend unit：**3756/3756 pass**（本地重跑，无回归；arc 只增集成 goldens，不增 unit）。
- 无 FE 改动；迁移仅 A1 一张表。

## 3. 显式设计选择（命名，非隐藏）

- **审计失败降级为遮罩 200**：安全（无未审计泄露），但审计者不被告知 reveal 被抑制——刻意取舍（可改 503，留作 owner 决定）。
- **reason 走 query string**：是 actor 自己的理由、非敏感；合规面用 header 更干净——记为可选 follow-up。
- ~~专门的 formula-taint reveal golden~~：**已补**（`...reveal-taint-realdb`，4 条，含 control 防空过）——D6 现有真库 golden，非仅结构性。
- **role/group 间接自授的 issue-time guardrail 是 fast-fail**（成员关系可变）；**不可变闭合是 reveal-time `granted_by`**——两者并存，文档不再称 issue-time「完整」。

## 4. 后续（gated，未建）

- 强制 `ticket`；sheet/字段集级 grant 作用域；graduated metadata-only tier（D7 defer）；reveal 也掀 taint（D6，需独立决定）；上述 §3 三个 follow-up。
- L2(d) 是否允许平级转授：现状锁为「grantee 不能再发证/转授」，owner 可放宽。
