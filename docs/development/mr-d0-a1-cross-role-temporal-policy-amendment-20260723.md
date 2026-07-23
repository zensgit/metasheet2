# MR-D0-A1 — 物料对账 charter 时序语义修订（crossRoleTemporalPolicy 选型裁决稿）

**日期**：2026-07-23　**状态**：**PROPOSED（owner 裁决文档）**
**修订对象**：`stock-preparation-v2-material-master-reconciliation-charter-20260719.md`（RATIFIED）§2.2 跨侧时序语义在 GIP-D0 词表下的**命名与可选升级**。
**边界**：本修订不改 #4437 验收路线、不解锁 D2/runtime；选项 A 下对已完成的 D1 实现**零变更**。

---

## 1. 背景与现行语义

Charter §2.2（RATIFIED，原文）：「两侧各自时点一致后，**跨侧时间偏移是产品语义而非缺陷**：V1 比较的是『两份各自一致、读窗口相近但不同时』的快照，run 记录双侧读窗口证据，不假装存在跨系统全局事务。」

GIP-D0 §5 引入平台级冻结词表（本修订不重复定义，引用之）：

```
crossRoleTemporalPolicy:
  DISCLOSE_ONLY | MAX_CAPTURE_GAP | COMMON_EFFECTIVE_CUT | COORDINATED_SNAPSHOT(保留)
```

**定名纪律（吸收 owner P1）**：该维度是**时序政策**，不是"跨角色一致性"——
- `MAX_CAPTURE_GAP` 只证明**采集时间接近**（freshness SLO），**不**证明两系统处于同一业务时点，**不**消除"更新恰发生在两次读之间"的伪差异；
- 任何选项都**不假装存在全局事务**（`COORDINATED_SNAPSHOT` 仅保留枚举位，v1 不设）。

## 2. 选项 A（默认）：维持 `DISCLOSE_ONLY`

- **语义零变更**：charter §2.2 现行行为在 GIP 词表下的命名即 `DISCLOSE_ONLY`；
- D1 已实现的「run 记录双侧读窗口证据」即本政策的证据要求；
- 伪差异的解释责任在消费侧（对账报告披露双侧读窗口，用户据此判读）；
- 实施成本：**0**。

## 3. 选项 B：升级 `COMMON_EFFECTIVE_CUT`

**语义**：两侧各自证明其快照**受同一业务截止点约束**（例：双方都只取"生效日期 ≤ T"且该谓词在各自快照内可证），从而把"读窗口不同时"从误差项中剔除——**这仍不是全局事务**，只是把比较基准从"采集时刻"换成"业务截止点"。

**升级需新定义（实现前置）**：
1. 每侧的**业务截止键**（源侧必须存在可信的生效/变更时间列，且列语义经 owner 批准入 binding）；
2. **证明形状**：截止谓词在该侧 `sourceConsistencyProof` 快照内可证（谓词下推 + 快照内验证）；
3. 失败词表新增（如 `EFFECTIVE_CUT_UNPROVABLE`，fail-closed）；
4. 两侧能力前置：任一侧无可信业务时间列 ⇒ 该场景实例只能 `DISCLOSE_ONLY`（preflight 判定，不静默）。

**成本/风险**：需改 D1 读取面与证据面（新守卫 + 词表 + 测试电池）；依赖源侧业务时间列的**可信度**（新的信任面，需逐源评估）。

## 4. 可叠加项：`MAX_CAPTURE_GAP`（与 A/B 正交）

作为 **freshness SLO** 附加：全部源角色读窗口须落在 T 内，超窗 fail-closed（专用码）。evidence 显式标注其为 **SLO 而非一致性证明**。适用动机：控制披露窗口的宽度上限，改善对账报告可判读性。T 由场景冻结，binding 不可放宽。

## 5. 裁决请求（owner 单选 + 可选叠加）

| 项 | 选择 |
|---|---|
| 主政策 | ☐ A：维持 `DISCLOSE_ONLY`（默认，零变更）　☐ B：升级 `COMMON_EFFECTIVE_CUT`（按 §3 前置排期） |
| 叠加 | ☐ 增加 `MAX_CAPTURE_GAP` SLO（T=场景冻结值）　☐ 不加 |

裁决落定后：A ⇒ charter 加一行命名映射注记即毕；B ⇒ 开独立实现票（不并入 W2/W3 任何在飞刀）。
