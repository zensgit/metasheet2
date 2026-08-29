REVIEW-BASE: 3f30d8eb4

# 222 迁移数据阻塞:r6 执行 NO-GO 记录(2026-08-29)

> 来源:Codex r6 执行前复核(带 222 只读预检数据)。**裁定接受**:精确 SHA 制品 PASS;当前 222 执行 r6 **NO-GO**;dormant+合成为代码层条件 GO;B2a 武装与真实 PLM 只读 NO-GO(T-1 未取得,本就未到);production Apply / K3 写回照旧关闭。values-free。

## 阻塞事实

222 库只读预检:**7 个活跃组织、59 个活跃但零有效组织成员关系的用户**。迁移 `zzzz20260823050000_provision_zero_membership_active_users.ts`(单组织前提自断言,fail-loud)将按设计拒绝——**这不是迁移的 bug,是它的职责**;runbook §1 的"org 数 ≠1 → 停"门同时命中。不可用 RunMigrations=0 绕过:077/078 是本轮功能必需结构,且绕过=带着未验前提上生产路径。

## 处置归属

- 该迁移属**考勤/审批车道(B 机)**;222 的 7 org / 59 用户是其存量数据现实。
- 需要的决策(owner + B 机):①222 的租户模型是"单 default 租户"还是既成多组织?②59 个零成员活跃用户如何 provisioning(归入哪个 org / 停用 / 逐个裁)?③若多组织为既成事实,单组织前提迁移是否需要改写其前提(那是 B 机车道的变更,备料车道不代改)。
- **备料车道立场**:r6 制品与 runbook 就绪不变;数据裁决落地后按 runbook 原步骤执行,无需备料侧代码变更。

## 同复核其余五条的处置(备料车道)

- finding 2(runner 丢弃 stanza→armed floors 失效)/ 3(lookupProjection 第二表越 objectScope)/ 4(跨插件绕 C6 写生命周期):**确认为真缺口**,修复支 `sec/runner-closure-rwave` 已开(R-wave,一支 PR 对三条,含 finding 6 的 replay/claim 语义查证)。
- finding 5(lease 非写 fencing):确认但**属已披露天花板**(W-4 文内明言 bounded-abort、≤1 cadence 窗口可竞态);收紧已并入在途 O1-A(续租节奏 25→1);结构性修复(账本存储级唯一)列为 owner 方向问题。confirm 与 reconcile 竞态由 readback 指纹绑定保 fail-safe(陈旧确认永不误放行)。
- finding 6(T-1/R-08/generation/大 BOM 契约):T-1 为外部制品(代码只能校验形状,取得属客户侧)、R-08 owner-gated、行级 generation deferred-with-reason、`artifactReplayLimit` 非零已在配置层定码拒绝——均为已登记边界;replay 运行时面随 R-wave 查证。
