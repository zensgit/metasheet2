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
- **实现现状订正（owner P2）**：D1 是 **schema-only、latent**（"no routes, no sheet provisioning, no env reads, no runtime, no migrations"——D1 文档 :7-8）——**D1 模板已含 per-role 时间字段，但尚无 runtime 生产证据**；「run 记录双侧读窗口证据」是 charter 对未来 runtime（D3a+）的要求，届时落地；
- 伪差异的解释责任在消费侧（对账报告披露双侧读窗口，用户据此判读）；
- 实施成本：**0**（本政策不改变 D1 的 schema-only 边界）。

## 3. 选项 B：升级 `COMMON_EFFECTIVE_CUT`（证明合同——owner P1 硬化后）

**语义**：两侧各自证明其快照**受同一业务截止点 T 约束**——**这仍不是全局事务**，只是把比较基准从"采集时刻"换成"业务截止点"。

**关键否定（P1）**：对普通 current-state 表做 `effective/changed time <= T` 过滤**不能**重建 AS OF T——某行在 T 后被更新，旧值已丢失；过滤只会**漏掉该行**，不会还原 T 时刻状态。谓词下推 ≠ 时点重建。

**B 至少只能接受以下四种机制之一（每侧独立满足）**：
1. 数据库**原生 temporal / AS OF T**；
2. **绑定 T 的不可变 snapshot/export**；
3. **完整有效期历史模型**：`[validFrom, validTo)` + 删除语义 + 覆盖证明；
4. 可从**不可变事件日志**确定性折叠到 T。

**T 的产生纪律**：T 必须由**场景冻结的服务器策略**产生并写入 **run pin**——不得由单次请求自由 steering。

**失败语义**：任一角色不满足四机制 ⇒ **拒绝 B 的 binding 激活**（fail-closed，如 `EFFECTIVE_CUT_UNPROVABLE`）；改用 A 必须**显式创建并审批新 binding**——**不得自动回退**。

**实施前置（owner P2）**：B 需要 **D1 合同 amendment + D3a runtime/证据实现**（D1 当前 schema-only，无读取 runtime 可改）；依赖源侧时点机制的可信度（新的信任面，逐源评估）。

## 4. 可叠加项：`MAX_CAPTURE_GAP`（与 A/B 正交）

作为 **freshness SLO** 附加：全部源角色读窗口须落在 T_gap 内，超窗 fail-closed（专用码）。evidence 显式标注其为 **SLO 而非一致性证明**。T_gap 由场景冻结，binding 不可放宽。

## 5. 复审建议记录（拟定默认——**非 owner ratification**）

**复审建议（reviewer recommendation，2026-07-23；P3 订正：上轮为审阅建议，非 owner 明确 ratify）**：
- **拟定默认：A（维持 `DISCLOSE_ONLY`）**；
- **暂不叠加 `MAX_CAPTURE_GAP`**；
- **B 保留为待补证明合同的未来选项**（前置 = §3 四机制 + D1 amendment + D3a runtime）。

**owner decision 待 owner 明确发出 ratify 后方可记录**。届时落地：charter 加一行命名映射注记（`DISCLOSE_ONLY` = §2.2 现行语义）即毕。

## 6. ratify 解锁范围订正（owner P2，联动 GIP-D0）

GIP-D0 ratify **仅解锁**：profile schema、合规 harness、只读 qualification spike——**每个具体 profile 仍独立过自己的门**，v1 清单中的五个 profile 不因 ratify 一次性解锁。
