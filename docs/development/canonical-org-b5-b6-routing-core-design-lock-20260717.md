# B5/B6 Routing-Core Design Lock（Q1–Q6 已裁决 — 锁定）

Date: 2026-07-17 · Last verified: 2026-07-21 · Status: **Q1–Q6 已由 owner 裁决（2026-07-17）— 锁定；
B5-a..B7 全栈已 as-landed 合并 origin/main（真实 merge SHA 见 §5）**
Basis: #4215 §6/§7/§10.1（已 ratify-by-merge `66c7459a8`）+ B4 落地形态（#4419 `b94dcd644`）。
本文件不重新设计 §6 —— 只把 §6 的 owner ruling 固化为可实现、可 mutation 验证的锁。§3 记录
owner 对 Q1–Q6 的最终裁决；§5 记录 as-landed 落地账（B5-a..B7 五张实现 PR + 本设计锁本身全部
已合并 main），并明示**仍被门控的部分**（T2-Gate 双 corp staging 实证未执行）。

## 0. B5 关闭的具体缺陷（现状实证）

`ApprovalDirectoryOrg.resolveApprovalRequesterOrgRelations`（`services/ApprovalDirectoryOrg.ts:201`）
选取申请人 directory account 的方式是跨**所有** integration 的
`ORDER BY a.updated_at DESC, a.id ASC LIMIT 1` —— 即「最近更新的 integration 赢」。
单 provider 时代无害；B1-B4 之后一个 org 可同时有 DingTalk 与 local integration，同一用户可在两边
都有 linked account，此时审批路由的解析源会随行更新时间**非确定地翻转**。这正是 §6 owner ruling
禁止的 guessing（"never array[0] / first linked account wins / latest active integration"）。

## 1. 设计锁（B5）

### 锁 1 — `org_directory_routing_policy` 表（schema，B4 同级严谨度）

```text
org_directory_routing_policy
  id                        uuid PK
  org_id                    text NOT NULL
  purpose                   text NOT NULL
  canonical_integration_id  uuid NOT NULL
  fallback_integration_id   uuid NULL          -- Q2 裁决：留列，v1 不启用（resolver 不读）
  created_at / updated_at   timestamptz NOT NULL
  -- Q3 裁决：无 mode 列（as-built 迁移 zzzz20260717110000 亦无）
```

- `UNIQUE (org_id, purpose)` —— 一 org 一 purpose 至多一条策略。
- `CHECK purpose IN ('approval_routing','permission_scope','attendance_expansion',
  'member_group_projection','automation_recipient_resolution')`（§6 闭集；扩 purpose = 新迁移）。
- **跨 org 策略 FK-impossible（B4 模式复用）**：`(canonical_integration_id, org_id)` →
  `directory_integrations (id, org_id)`（复用 B4 已加的 `uq_directory_integrations_id_org`）；
  fallback 若非 NULL 同样 `(fallback_integration_id, org_id)` → 同约束。策略永远指不到别的 org
  的 integration。参与 FK 的列 NOT NULL（fallback 例外，NULL = 无 fallback；MATCH SIMPLE 下
  fallback 为 NULL 即跳过该 FK —— 这里 NULL 语义正确，非绕过）。
- `ON DELETE` 明确：**两条 FK 均 RESTRICT**（as-built 修正：composite FK 的 `SET NULL` 会把全部
  引用列置 NULL——含 NOT NULL 的 `org_id`——PG14 无列级 `SET NULL (col)`；且 RESTRICT 本就是意图
  姿态：删除仍被策略引用的 integration 必须先改策略，策略沉默消失比响亮报错更危险。B5-a gate 实证
  CASCADE 变体会**静默删策略行**，已用 `confdeltype='r'` 双腿钉死 + fallback 行为测试）。
- 迁移 replay 幂等（as-built：单条原子 `CREATE TABLE IF NOT EXISTS`——表连同其内联约束要么整体
  存在要么整体不存在，无需 pg_constraint 探针；约束形状的钉在 schema 测试里：conname + 列数 +
  `confdeltype='r'` 双腿）。

### 锁 2 — resolver 优先级（默认不变量：无策略 = 字节级现状）

purpose=`approval_routing` 的解析顺序：

1. **策略存在** ⇒ 策略权威：申请人 account 选取**限定在** `canonical_integration_id` 内
   （`WHERE a.integration_id = policy.canonical…`），替代 `ORDER BY updated_at` 猜测。
   策略指向的 integration 缺失/`status<>'active'` ⇒ **fail-closed**：返回 operator-visible
   错误（审批路由报「routing policy 指向不可用 integration」），**不**静默回退到猜测。
2. **策略不存在** ⇒ **legacy 路径字节级不变**（今天的单 provider 行为原样保留）。
   B5 落地当天生产零行为变化 —— staged opt-in 谱系：策略行是显式开关。

「never array[0]」的精确含义：**多 integration 歧义只允许由策略消解**；任何代码路径不得以
数组位置、更新时间、创建时间当决策依据。

### 锁 3 — 只读切换预览（preview 无副作用）

- `GET /api/admin/directory/routing-policy`（读全 org 策略 + 各 purpose 当前生效源——策略值或
  "legacy-default"）。
- `GET /api/admin/directory/routing-policy/:purpose/preview?candidate=<integrationId>`：
  对**受影响面**（v1 = approval_routing 一个 purpose；报告面覆盖 §6 五 purpose 的骨架）计算
  before/after：现行解析源 vs 候选解析源下的申请人 dept/title/manager 差异样本。
  **只读**：不写策略、不写任何行、不取任何锁；实现层面 preview handler 里没有 UPDATE/INSERT。
  （Q5 裁决：preview 为纯 GET，**不审计**——as-built handler 即如此。）
- `PATCH /api/admin/directory/routing-policy/:purpose`：唯一写点。admin-only；values-free 审计
  `directory.routing_policy.set`（resourceId=`${orgId}:${purpose}`，meta 只含 orgId/purpose/
  integrationId —— 不回显 config）。

### 锁 4 — 测试/mutation 义务（真库）

- 策略权威：设置策略后，双 integration 双 linked-account 用户解析自 canonical（非 latest-updated）。
- fail-closed：策略指向 inactive/缺失 integration ⇒ 显式错误（非静默回退）——正控腿 = 同策略
  指向 active integration 时解析成功。
- 无策略回归：策略行不存在 ⇒ 现有 ApprovalDirectoryOrg 全部既有测试原样绿（字节级 legacy）。
- 跨 org 策略 FK-impossible：raw INSERT 异 org integration ⇒ 23503 按约束名（B4 的 B 测试模式）。
- preview 只读：preview 调用前后 `org_directory_routing_policy` 与 directory 表无行变化。
- **mutation**：删「策略存在⇒限定 integration」谓词 ⇒ 策略权威测试红；删 fail-closed 分支 ⇒
  fail-closed 测试红（回退到猜测被抓）；删 org-FK ⇒ 跨 org 测试红。

## 2. 设计锁（B6 — 审批路由 local/DingTalk 真库等价证明）

- **种子等价矩阵**：同 org 下 local 与 DingTalk 各造等价组织（同名部门树、同 title、同 manager
  关系——local 走 `is_manager`，DingTalk 走 `raw.leader_in_dept`）。断言
  `resolveApprovalRequesterOrgRelations` 在两种 canonical 策略下产出**相同**的
  requester dept/title/manager（B3 双源 precedence 的端到端复证）。
- **在途不变**：策略切换前创建的审批实例保留 baked routing snapshot（不重解析）；只有**新**实例
  跟随新策略。历史实例零改写。真库测试构造：切换前实例 → 切换 → 断言 snapshot 原样 + 新实例
  走新源。
- **首个消费者且仅此一个**：B6 只迁 approval_routing；permission/attendance/member-group/
  automation 四 purpose 留在 legacy（§10.2+），每个未来单独走「策略 + 等价证明」。
- mutation：删 baked-snapshot 保护 ⇒ 在途不变测试红；删等价断言的任一源腿 ⇒ 对应矩阵红。

## 3. Q1–Q6 owner 裁决（2026-07-17，最终）

- **Q1 无策略语义**：**已裁 = legacy 字节级保留**（零行为变化，策略显式 opt-in）。
- **Q2 fallback**：**已裁 = 保留列，v1 不启用**（canonical 坏 ⇒ 响亮 fail-closed，不自动 fallback）。
- **Q3 `mode` 列**：**已裁 = 不设冗余 mode**（canonical integration 的 provider 即唯一真源）。
- **Q4 org 解析**：**已裁 = 0 个受治理 org ⇒ legacy；恰 1 个 ⇒ 用该策略；>1 个 ⇒ fail-close**
  （受治理 = requester 有 linked account 的 org 中存在 approval_routing 策略行）。
- **Q5 preview**：**已裁 = 只读 GET 不审计**；PATCH 才审计。
- **Q6 B7 sweep 接线**：**已裁 = 成功同步提交后自动 sweep，按 `remoteIntegrationId` 收窄；
  sweep 失败不得误报同步失败（不传染 sync 结果，值无关地记录），同时提供管理端重试入口**。

### 裁决对实现的增量要求（本轮 CHANGES 已列）

- **#4430 P1**：policy 配置错误在调用点被吞 ⇒ orgRelations 空 ⇒ 四种 org assignee source
  （direct_manager / dept_head / continuous_managers / manager_at_level）解析为空 ⇒
  emptyAssigneePolicy=auto-approve 时**审批被自动通过（fail-open）**。修法 = create 时对
  **四源 + department/title 属性**全部 fail-close：policy 配置错 ⇒ 422
  `APPROVAL_ROUTING_POLICY_MISCONFIGURED`；transient 读故障 ⇒ 503；两者均须证明
  **零实例、零 assignment 落库**。
- **#4431**：PATCH 仅接受有消费者的 purpose（v1 = `approval_routing`；其余四 purpose 拒绝——
  无消费者的策略行是死配置）；**canonical=local 需启用保护**（default-OFF 显式开关，parity
  能力未获准前不得指向 local）。
- **#4434**：「在途不变」须证明**真 pending instance + 真 assignment** 跨策略翻转不变
  （终态 auto-approved 实例的不变是平凡命题）。
- **#4436**：sweep 补 remote integration 的 **status/provider 两条 SQL 守卫**；补 binding
  管理入口（列表/重试）；实现 Q6 hook。

## 4. 实现切分（as-built 实际）

- B5-a（迁移+表+FK 链+schema 测试）→ B5-b（resolver）→ B5-c（admin 路由）→ B6（等价证明）→
  B7（suggest-only 对账）——全部串行、全部由主循环（Opus 级）实现并配独立对抗 gate
  （计划原文写 B5-c 可 Sonnet 跑量，实际因 routing-core 敏感统一主循环实现——as-built 修正）。
- 每段：真库测试 → mutation → 对抗 gate → CI → owner 复审落地。
  **CI 事实修正（owner 抓）**：base≠main 的 PR 只触发 pr-validate，**不构成 required CI
  全绿**；落地时逐张 retarget→rebase→重放 mutation→全套 required CI→owner 复审。
  本栈五张实现 PR 均已按该顺序逐张落地 main（as-landed 账见 §5）。

## 5. As-landed 落地账（2026-07-19 全部合并 main；2026-07-21 复核）

**本表只记 `origin/main` 上的真实 merge SHA。** 早前版本曾登记若干 PR 的中间 head，那些 head
**不是 main 的祖先**、已被下面的 merge commit 取代，故一律删除——不得据以开分支或推断落地形态。

| 票 | PR | Merge SHA（main 祖先） | 状态 |
|---|---|---|---|
| 设计锁本体 | #4425 | `d9f56a8c2` | ✅ 已合并 main（本文件随该 PR 落地） |
| B5-a schema | #4429 | `81aff8203` | ✅ 已合并 main；迁移 `zzzz20260717110000` 已在库（**勿再新建同表迁移**） |
| B5-b resolver | #4430 | `05dcd5282` | ✅ 已合并 main；§3 的 P1 fail-open 修闭随该 PR 落地 |
| B5-c routes | #4431 | `5e55b549d` | ✅ 已合并 main；unsupported-purpose、canonical=local 默认关闭保护、env 严格解析均在库 |
| B6 等价 | #4434 | `50cbfcfea` | ✅ 已合并 main；真 pending instance + assignment 的在途不变证明在库 |
| B7 对账 | #4436 | `b004c5797` | ✅ 已合并 main；两条 SQL 守卫、binding 管理入口、Q6 hook、heal 方向守卫在库 |

Canonical Org 开发侧收官证据（合并后 main 上的 fresh migration + replay、18 文件/227 真库测试、
typecheck、CI wiring 守卫、mutation 来源）见 `canonical-org-mvp-done-gate-20260719.md`；
逐步 merge SHA 台账见 `canonical-org-mvp-progress-ledger-20260716.md`。

### 5.1 Transfer 现状与仍被门控的部分（勿读成「Transfer 已过 T2」）

- **已合并 main（工程实现，非验收）**：T1 `b9b354a38`（#4458）、T2 `85ef8b7ab`（#4464）、
  T2-Gate 收官 `2b4324650`（#4465）、goal-round as-landed 收账 `622f09544`（#4466）。
  T1 **不再冻结**——冻结叙述已由这些落地取代。
- **仍未执行（owner/ops `_TBD_`，不可模拟）**：**T2-Gate 的真实两 DingTalk corp staging 实证**。
  CI 里的碰撞机制证明**不等于** collision CONFIRMED/DISPROVED。协议见
  `canonical-org-t2-gate-two-corp-staging-runbook-20260717.md` §4。
- **T2.5 仍为条件分支**：collision **CONFIRMED** ⇒ 必须先实现并落地 tenant-scoped key migration
  （`(provider, tenant_key, external_key)`）才能进 T3（仅有裁决不解锁）；owner 接受的
  **DISPROVED** ⇒ 可跳过 T2.5 解锁 T3；**INCONCLUSIVE** ⇒ T3/T4/T5 继续冻结。
- **T3 / T4 / T5 仍冻结**，等待上述 staging 裁决被 owner 接受。
- 完整 Transfer 收账与解锁纪律见
  `canonical-org-transfer-goal-round-design-and-verification-20260717.md`。

### 5.2 本文规范条款对 as-built 代码的复核（2026-07-21）

对 main 逐条核对，全部 PASS，本轮未改动任何规范条款：无 `mode` 列、
`UNIQUE (org_id, purpose)`（`orp_org_purpose_uniq`）、五值 `purpose` CHECK（`orp_purpose_chk`）、
两条 FK 均 `ON DELETE RESTRICT`（`orp_canonical_int_org_fk` / `orp_fallback_int_org_fk`）——
均见 `packages/core-backend/src/db/migrations/zzzz20260717110000_create_org_directory_routing_policy.ts`；
preview 为纯 GET **不审计**、canonical=local 走默认关闭的
`DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED` 严格开关——均见
`packages/core-backend/src/routes/admin-directory-routing-policy.ts`。
