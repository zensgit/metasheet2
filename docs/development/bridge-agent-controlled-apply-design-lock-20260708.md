# Bridge Agent 受控 apply — DESIGN-LOCK(PROPOSED)— 2026-07-08

> **状态:PROPOSED,等 owner ratify。本文锁设计与阶梯,authorizes NO RUNTIME。**
> 上位锁:`bridge-agent-admin-page-design-lock-20260707.md`(BA-UI-0 RATIFIED)。
> 需求锚点:#3746(BA demand anchor,保持 OPEN)。owner 2026-07-08 定为收官后 4 条独立线的 **#1
> 优先**,并明确「**必须 design-lock 先行,不能直接做 runtime**」——本文即该先行设计层。

## 0. 定位与前置事实

BA-UI 只读线已全落 main(BA-UI-1 可观测 / BA-UI-2 探测 / BA-UI-3 配置校验+**变更建议清单** /
BA-UI-4 任务提示)。BA-UI-3 已能产出"新增只读对象/字段映射"的**变更建议/实施清单**(values-free),
但明确**由受控后端或运维脚本(现有 .ps1 / Scheduled Task)应用,前端不直写**(BA-UI-0 §1 原则1)。

底层事实(`bridge-agent-readonly-adapter.cjs`):Bridge Agent 天生 `operations:['read']`、
`readonly:true`、"never accepts SQL text or writes",`maxLimit<=500`。**apply 的对象是 Agent 的
只读暴露 config(它允许被只读访问的对象/字段 allowlist),不是任何业务数据写入。**

## 1. 三条原则(锁定)

1. **只扩只读暴露面,永不加写路径**:apply 的唯一可变更内容 = Agent 的只读对象/字段 allowlist
   (加一个只读对象、加一个字段映射)。**apply 后 Agent 仍 `readonly:true`**;任何把 Agent 变为可写、
   或触发 K3/ERP/PLM/生产写、或注入 SQL 的变更**不在本能力面**,fail-closed 拒绝。
2. **前端产建议、后端/受控通道落地**:前端(BA-UI-3)只 PRODUCE 变更建议;apply 走**后端受控通道**
   (owner/admin 审批 + 审计),或**运维脚本 handoff**(建议作为机读输入)。**前端永不直写本机 config、
   永不直连 Agent 写**(延续 BA-UI-0 边界)。
3. **凭据后端持有、apply 证据 values-free**:apply 路径零凭据处理(baseUrl/host/token 后端持有);
   apply 前后的证据/审计只含 coarse 状态/count/字段键名/布尔,绝不含业务值/host/凭据。

## 2. 受控 apply 的两种落地形态(设计层锁,runtime 各自 opt-in)

```text
形态 A(运维脚本 handoff,风险最低,建议 v1):
  BA-UI-3 变更建议 → 导出为机读实施清单(values-free,只含对象名/字段键名/操作枚举)→
  现场运维按既有 runbook 用受控 .ps1 应用到本机 Agent config → 重启/刷新 → BA-UI-1 观测确认生效。
  平台侧零写路径;apply 完全在运维手中;前端只出清单 + 事后观测。

形态 B(后端受控 apply,风险中,后续独立 opt-in):
  MetaSheet 后端提供一个**受控 config-apply 端点**:接收 values-free 变更建议 → owner/admin 审批门 →
  仅允许"加只读对象/加只读字段"的 allowlist 白名单操作(schema 校验 + 只读不变式断言)→
  经后端持有的凭据上下文写 Agent 的**只读 config**(非业务数据)→ 全程审计(values-free)。
  绝不做:改 Agent 为可写、删除对象、raw SQL、host-allowlist 放宽、凭据前端化。
```

## 3. 阶梯(各行单独 owner opt-in;本文 authorizes 无 runtime)

```text
BA-APPLY-0 ✅ 本 design-lock(采纳 BA-UI-0 §2.1 安全边界为硬锁)
BA-APPLY-1 🔒 形态 A:变更建议 → 机读实施清单导出(values-free);运维受控应用。门:owner opt-in
BA-APPLY-2a ⬜ 后端审批门 + 审计 + values-free 清单暂存(零 Agent 改动;in-lock,已开发)
BA-APPLY-2b ⛔ 后端写 Agent config 端点 —— WONTFIX by design(见 §7;需 owner ratify 扩安全模型才复活)
BA-APPLY-3 🔒 apply 后自动复探测确认(复用 BA-UI-2 probe 证明生效)。门:BA-APPLY-1/2
```

## 4. 硬锁 / 非目标

- **只读不变式**:apply 后 Agent `readonly:true` 恒成立;任何变可写/写业务数据的路径 = 拒绝。
- 无 K3/ERP/PLM Save-Submit-Audit、无生产写、无 delete-object、无 raw SQL、无 host-allowlist 放宽、
  无凭据前端化/前端直连 Agent 写、无自由编排。
- 每个 runtime rung 单独 opt-in;本文 authorizes NO RUNTIME。
- 采纳 BA-UI-0 §2.1 安全边界与 §验收标准逐条为本线硬锁。

## 5. 验证方案(runtime slice 将来构建时必证)

```text
形态 A:实施清单 values-free(sentinel:植入 host/凭据/业务值 → 清单/导出零泄漏);
        清单机读格式只含对象名/字段键名/操作枚举(exact-registered,无自由文本);零平台写路径。
形态 B:后端 apply 端点只接受"加只读对象/加只读字段"白名单操作(mutation:改 Agent 为可写 → 拒绝);
        只读不变式断言(apply 后 readonly:true,mutation 翻假 → 测试红);审批门(未审批 → 拒绝);
        审计 values-free;凭据零前端;fail-closed on 非白名单操作。
每 slice:主循环质量闸 + mutation 逐守卫 + 双 Node + values-free sentinel 纯层+DOM。
```

## 6. 边界(本锁零开门)

BA-apply 各 rung 待 owner opt-in;写业务数据/生产写/递归/K3-Save 全冻结;#3746 保持 OPEN 作 demand
anchor。本文只锁设计与阶梯,不实现、不授权任何 runtime。

## 7. Disposition — 形态 B (2b) = WONTFIX by design(owner 定 2026-07-08)

**本线终态锁定,形态 B「后端写 Agent 只读 config」不实现(WONTFIX by design,非缺功能)。**

**理由(安全模型层面,非实现成本)**:
- Bridge Agent 的核心安全价值就是 **never writes**。它贴近客户现场环境与生产库;给它加 config-write
  端点,本质是在客户机器上新增**高爆炸半径入口**——该端点一旦有 auth 绕过/路径穿越/allowlist 注入,
  爆炸半径是客户的生产数据库。
- `add_readonly_object` 名字是 readonly,实际效果是**扩大数据暴露面**;allowlist/config 是安全边界,
  **不适合自动 API 化**。
- 加只读对象是**低频高后果**操作;保留运维手工执行那一步,正是**人类在这个控制点的把关**——刻意保留,
  不是缺失。

**本线终态形态(全程 Agent 恒 readonly:true)**:
```text
看得见   BA-UI-1/2   只读观测 + values-free 探测
查得清   BA-UI-3     配置校验 + 变更建议
可导出   BA-APPLY-1  变更建议 → 机读实施清单(#3894)
审批暂存 BA-APPLY-2a 后端审批门 + 审计 + values-free 清单暂存(零 Agent 改动)
运维落地 handoff     人工按 runbook 执行只读 allowlist/config 变更 ← 人类把关点(刻意保留)
自动确认 BA-APPLY-3  系统自动复探测确认生效(只读,不写配置/不 start-stop/不碰凭据/不改 raw config)
```

**2b 撤除**:BA-APPLY-2b(给 .ps1 加 config-apply 端点)从阶梯移除,标 WONTFIX-by-design。若未来现场
强需求全自动,须 owner **显式 ratify 扩 Agent 安全模型 + 本锁修订**,不在本线范围。
