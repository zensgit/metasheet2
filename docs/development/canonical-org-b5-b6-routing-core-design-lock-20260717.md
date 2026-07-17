# B5/B6 Routing-Core Design Lock（草案，待 owner 审定）

Date: 2026-07-17 · Status: **DRAFT — 审定前 B5/B6 不开发**
Basis: #4215 §6/§7/§10.1（已 ratify-by-merge `66c7459a8`）+ B4 落地形态（#4419 `b94dcd644`）。
本文件不重新设计 §6 —— 只把 §6 的 owner ruling 固化为可实现、可 mutation 验证的锁，并暴露
四个需要 owner 拍板的开放问题。

## 0. B5 关闭的具体缺陷（现状实证）

`ApprovalDirectoryOrg.resolveApprovalRequesterOrgRelations`（`services/ApprovalDirectoryOrg.ts:197`）
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
  fallback_integration_id   uuid NULL          -- 见开放问题 Q2
  mode                      text NOT NULL      -- 见开放问题 Q3
  created_at / updated_at   timestamptz NOT NULL
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
- 迁移 replay 幂等（IF NOT EXISTS + pg_constraint 探针，钉 conname+conrelid+contype）。

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
  **只读**：不写策略、不写审计之外的任何行、任何锁；实现层面 preview handler 里没有 UPDATE/INSERT
  （审计除外——见开放问题 Q5，建议 preview 不审计，纯 GET）。
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

## 3. 开放问题（owner 拍板后本锁转 RATIFIED）

- **Q1 无策略语义**：推荐 = legacy 字节级保留（锁 2；零行为变化，策略显式 opt-in）。
  备选 = §6 字面「unset ⇒ fail-closed」——但那会在 B5 落地当天 break 所有现网审批路由，
  不符合 staged opt-in 谱系。请确认推荐项。
- **Q2 fallback 语义（v1）**：推荐 = **存列不启用**（v1 不自动 fallback：canonical 坏 ⇒ 响亮
  fail-closed；自动 fallback 会静默掩盖 canonical 故障）。列保留供后续 purpose 用。
- **Q3 `mode` 列语义**：§6 原文含 `mode`（`dingtalk`/`local`）。它与
  `canonical_integration_id → provider` 冗余。推荐 = **v1 去掉 mode 列**（单一真源 =
  canonical integration 的 provider；冗余状态会漂移）——此为对 §6 文本的唯一偏离，需 owner 点头；
  若 owner 要保留，则加 CHECK(mode = canonical integration 的 provider) 同步（三列 FK 模式）。
- **Q4 org 解析**：approval 路径今天只有 `local_user_id`，无 org 输入。推荐 = 由 requester 的
  linked accounts 推导其 integration 的 org 集：恰一个 org ⇒ 用之查策略；>1 org ⇒ fail-closed
  （operator-visible，多 org 用户的路由必须显式配置）；0 ⇒ 现状 `{}` 返回。
- **Q5 preview 是否审计**：推荐 = 纯 GET 不审计（只读、无副作用、可能高频）；PATCH 才审计。

### as-built 精化（实现期落定，随各 PR 附 gate 实证；owner 审定时一并裁）

- **Q4 精化**：多 org 用户仅在「≥1 个 linked org 有策略」时才 fail-closed；全部 org 均无策略 ⇒
  legacy 字节级不变（否则无策略世界会被多 org 用户破坏 Q1 的零行为变化）。单个受治理 org + 若干
  无策略 org ⇒ 跟随唯一策略（确定性，非猜测）。
- **preview 机制**：resolver 增加 `overrideCanonicalIntegrationId` 只读预览选项（undefined=正常
  probe；仅 preview 路由在校验 candidate 同 org+active 后传入；生产唯一调用点不传——gate 已全仓
  grep 实证）。两腿同一 resolver ⇒ preview 不会与生产解析漂移。
- **写点 409**：PATCH 指向非 active integration 直接 409（写时拒绝坏策略，优于 B5-b 之后逐单
  fail-closed）。
- **Q6（新，B7 接线）**：`sweepStaleDepartmentBindings` 幂等、确定，但**尚未接线**——post-sync
  hook vs admin 触发是 owner 裁决（未裁前不碰已硬化的 sync core）。

## 4. 实现切分（审定后）

- **B5-a**（迁移 + 表 + FK 链 + 真库 schema 测试；Opus）→ **B5-b**（resolver 策略解析 + fail-closed
  + legacy 回归 + mutation；Opus）→ **B5-c**（admin 路由 GET/PATCH/preview + 审计 + route 测试；
  Sonnet 可跑量，Opus gate）→ **B6**（等价矩阵 + 在途不变；Opus）。
- B5/B6 同碰 routing core，**串行**；每段照旧：真库测试 → mutation → 对抗 gate → exact-head CI →
  owner 复审落地。
