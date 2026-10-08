# 通用备料线 — W3 消费 & G1 emit-seam 设计锁（未实现，待 owner ratify）

**日期**：2026-07-22　**状态**：**DESIGN-LOCK（提案）——零代码、未 arm**。
**前置门（硬）**：两者的**实现**都须先满足 ①owner 侧对 post-round-5 的 **W2/P2-3 落 APPROVE**（当前最后一条 owner 裁决是 round-5 HOLD；本仓两个 APPROVE 是我自建的独立审，非 owner 门）；②本设计锁被 owner ratify。**在此之前不写实现代码**——W3 会改动全表依赖的**冻结模板**、G1 触碰**写路径 side-effect**，都不在"泛指令可自动执行"范围内。

> 本文只锁**契约**（触发/形状/幂等/权限/apply 语义），不含实现。实现落地时按 [[general-prep-line-final-state-and-model-plan]] §3 的模型与序：W3=sonnet5、G1=opus4.8，各自 unarmed 建 + 推送前独立对抗审（[[feedback_adversarial_review_before_pushing_core_cross_package]]）。

---

## 1. W3 — demand-date 建议列消费（`suggestedDemandDate`）

**现状**：`computeDemandDateCascade`（P3 算子，已建）指向 plm_system 列 `suggestedDemandDate`，声明 `applyMode='k2_confirm_required'`；但**该列不在模板**（模板仅 `demandDate`/`leadTimeDays`，均 human_preserved），且算子**无消费方**。

### 1.1 三步契约（execution-plan §3.5 的"模板加列→repair→接线"落到具体形状）

1. **模板加列（v-bump）**：`STOCK_PREPARATION_MAIN_TABLE_TEMPLATE` 增 `field('suggestedDemandDate','Suggested Demand Date','date','plm_system')`；`version` v1→v1.1；**既有表经 W2 repair 装列**（这是 W2 repair 的首个真实消费者；repair 已证 additive/原子/既有列不变）。
2. **计算触发（锁定：显式、非隐式）**：**admin-gated 显式动作** `POST /api/integration/stock-preparation/suggestions/demand-date`（flag-gated，默认 OFF）——**不**在 refresh/apply/sync 隐式跑（避免把建议塞进承重写路径）。入参=batch 标识；跑 `computeDemandDateCascade` over 该 batch 的行。
3. **写回（锁定：K2-confirm-required、plm_system-only、never human）**：算子输出是**建议 payload**，不直接落格。写建议列走 **K2 二次确认**（同 P4 carry 的 K2 签名纪律）；写目标**仅** `suggestedDemandDate`（plm_system），经 `assertSuggestionTargetIsSystemOwned` 守卫；**绝不**触碰 `demandDate` 等 human_preserved（ownership wall `assertNoHumanFields`）。

### 1.2 不变量（实现须带承重测试）
- **values-free evidence**：只发 suggestionFieldId + 计数 + applyMode，不发行值/物理 id。
- **幂等**：同 batch 重跑 → 同建议（算子纯函数已保证）；写回按 record_id 去重。
- **fail-closed**：目标列若被误标 human_preserved ⇒ `SUGGESTION_TARGET_NOT_SYSTEM_OWNED`（守卫已在）；K2 签名缺失 ⇒ 拒写。
- **arm 纪律**：flag 默认 OFF；写回默认 K2-required；模板 v-bump 与 repair 覆盖测试同 PR。

### 1.3 实现难度 & 模型
**sonnet5**（机制全备：W2 repair 装列 + P3 算子 + K2-confirm 先例）；主要工作=模板列 + 显式动作路由 + K2-confirm 写回消费者 + 全量 count 断言随模板 v-bump 更新。**测试 churn 面**：模板字段数+1 波及 templateFieldCounts / 描述符 / realdb 全模板断言——须一并更新。

---

## 2. G1 — 批次刷新 → 通知部门（emit-seam）

**现状**（P1a 实证）：9 表是真 multitable，但**插件写路径（refresh/apply/sync/confirm）不发自动化事件**——只网格路由层发。"批次刷新→通知部门"需**新 emit seam**。

### 2.1 契约（锁定：opt-in、env-gated、values-free、私有审计）
1. **seam 位置**：在 batch refresh 完成的**成功提交之后**（after-commit）发一个 domain 事件 `stock_preparation.batch_refreshed`——不在事务内发（避免把外发耦进 DB 事务；参照 durable-delivery 线纪律）。
2. **channel 注册**：通知 channel **仅当对应 env 存在时注册**（[[feedback_channel_env_gating]]），默认 **OFF**；不硬编码收件人（收件人来自受治理配置，非事件内嵌）。
3. **事件形状（values-free）**：`{ batchRef, refreshedAt, changedCount, department? }`——**不**含物理 id / 行值 / project id 值；department 来自 batch 的受治理归属，非调用方传入。
4. **幂等/去重**：按 `batchRef + refreshedAt`（或 delivery event_id）去重，重放不重复通知（参照 webhook `webhook-service` delivery event_id 纪律）。
5. **send-trigger 审计**：send 清单**私有**（[[project_send_trigger_audit_doctrine_20260711]]）——不公开列举触发点；egress 走既有 egress-guard（[[project_webhook_egress_guard_wiring]]）。

### 2.2 不变量（实现须带承重测试）
- **env-gated 正控**：无 env ⇒ channel 不注册 ⇒ 零外发（正控测试：断言"不发生"须配 env-on 的正控）。
- **after-commit-only**：失败/回滚的 refresh **不**发事件（构造回滚用例证明）。
- **no-leak**：事件体逐字段 values-free 断言。

### 2.3 实现难度 & 模型
**opus4.8**（跨写路径 side-effect + after-commit 时序 + 幂等/去重 + egress 合规 + 需对抗验证）；**先出本 seam 设计被 ratify，再 unarmed 建，推送前独立对抗审**——写路径 side-effect 是本线最敏感面。

---

## 3. 边界与下一步（owner 决策点）

- 本文**零代码、零 arm**；两项实现都 **gated on**：owner 对 W2/P2-3 落 APPROVE + 本设计锁 ratify。
- 其余线上项非设计可解：**P0**=flag-flip（owner config）；**P5**=依赖 D2 #4520 未合；**P7**=待 D 线第二 scenario 需求源；**P-T3**=外部 K3 写 + 凭据/合规 + 需求门。
- **建议序**（解门后）：W3（sonnet5）与 P0（sonnet5 配置）可并；G1（opus4.8）独立对抗审后并入；P5/P7/P-T3 待各自外部门。
