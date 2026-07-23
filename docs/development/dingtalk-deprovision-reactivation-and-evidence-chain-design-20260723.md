# DingTalk Deprovision 恢复 + Preview/UI 证据链 — 实现级设计

- Date: 2026-07-23
- Status: **implementation design lock / Rev 4.2**
- Locked: 2026-07-23（owner 批准两篇一并升 lock）
- Scope: 打开 `DIRECTORY_DEPROVISION_ENABLED` 之前，把「权威 effect 账本 + prospective planner + 全写者 per-user 锁 + event 恢复（含 drift）」设计正确
- Baseline: **`origin/main @ 15a256fe2`**；相对 `ca625f14a` 本线相关代码 **scoped diff = 0**（membership + globally-clear 事实基线仍成立）
- Companion: `docs/development/dingtalk-directory-admission-activation-lifecycle-design-20260723.md` (implementation design lock / Rev 4.2)
- **design lock ≠ T1 GO：本次批准不授权启动 T1**（总序仍为 lock → T1 → T2 → T3 → D1…D7 → canary，另令开工）
- Related:
  - Roadmap §7.1 / Hardening §4.1 / Switch ledger #1
  - `packages/core-backend/src/directory/directory-sync.ts` — `applyDirectoryDeprovisionPolicies`, bind/`user_orgs`, sync lease
  - Generic admin `deprovision_ledger` — **不同域**，不是目录离岗权威源
  - Generic `admin-users` 状态 API — 可改 `is_active`，**必须**参与 supersede / 不得假恢复离岗图

---

## 0. Rev 演进摘要

### 0.1 Rev 1 → Rev 2（已吸收）

Prospective planner、三 effect、event 恢复意图、并发初稿、manual_review 默认、无邮箱不 skip。

### 0.2 Rev 2 → Rev 3（方向性 — 已关）

Prospective planner、三 effect 意图、event 恢复、全写者锁意图、manual_review 提前、baseline 诚实。

### 0.3 Rev 3 → Rev 4（实现级 — 本轮 LOCKED）

| # | 问题 | Rev 4 锁定 |
|---|------|------------|
| **P1** | event 可错配 run/account/user | §5.2 复合 FK + **link witness** + membership org NOT NULL + **typed boolean** before/after |
| **P2** | mutex / generation 仍二选一 | §5.4 + §7：**users FOR UPDATE**；**per-user generation**；非零 effect 才 +1；restore 严格相等 |
| **P2** | 普通 restore 默认可全图恢复 | §6.0 **双路径**：rehire 条件恢复 vs **强制恢复**（二次确认+审计） |

### 0.4 Rev 4 → Rev 4.1（已关）

强制 INSERT trigger 意图、immutability、零 effect 零写、account is_active inventory、baseline 15a256fe2。

### 0.5 Rev 4.1 → Rev 4.2（本轮 LOCKED）

| # | 问题 | Rev 4.2 锁定 |
|---|------|------------|
| **P1** | `event → directory_account_links` FK 卡死 unbind/rebind；partial unique 不能作 FK 目标 | §5.2：**删除** event→current-link FK；**保留** INSERT trigger 验当前 linked + 字段 immutability 固化历史；**不**采用 append-only link_versions（YAGNI，除非未来另票） |
| **P2** | §3 写 supersede **或** generation++ | §3 与 §5.4 统一为 **generation++ AND supersede** |

产品方向见 companion — **已赞成**。  
**Implementation design lock 已于 2026-07-23 批准。**  
序：lock → T1→T2→T3 → D1…D7 → canary。  
**design lock ≠ T1 GO — 本次不授权启动 T1。**

---

## 1. One-line goal

在 **不默认打开** `DIRECTORY_DEPROVISION_ENABLED` 的前提下，使：

1. Forward 路径在 **同一事务** 写入 **可验证、可 drift-detect 的 effect ledger**（只记真实变更）。
2. Preview / Apply 共用 **prospective-aware** 只读 planner（Preview 候选可非零证明）。
3. 所有改变「link / account active / membership / grant / user active」的写者共享 **per-user 锁协议**（关闭 globally-clear TOCTOU）。
4. 恢复 API 按 **eventId + effect 行** 逆转，且仅当 **当前值仍等于 effect.after**（否则 409 DRIFT_CONFLICT）。
5. UI 展示开关 / plan / events；**不**把通用用户启停当成完整离岗恢复。

---

## 2. Access graph and policies（对齐 main@ca625f14a）

### 2.1 两层候选（已在主干）

```
directory transition set T (accounts → inactive this run)
        │
        ▼
plan(T as prospective):
  org-scoped candidacy  → 是否可动本 org 的 user_orgs
  globally-clear        → 排除 prospective 后，是否仍有 *任意* 活跃 linked 绑定
        │
        ├─ manual_review     → 不写访问图
        ├─ disable_grant_only
        │     membership (user_orgs) 按 org 规则停用
        │     grant 仅 globally-clear 时关闭
        └─ mark_inactive
              membership 同上
              grant + users.is_active 仅 globally-clear 时关闭
```

### 2.2 Effect 闭集（canonical）

| `effect_type` | 典型写 |
|---------------|--------|
| `membership_changed` | `user_orgs.is_active`（含 org_id） |
| `grant_changed` | `user_external_auth_grants.enabled`（provider=dingtalk） |
| `user_changed` | `users.is_active` |

**禁止** 用 `membershipDeactivationAttempted` 等“尝试位”作为恢复权威。Ledger 只在 `before ≠ after` 时插入 effect。

### 2.3 与 companion 激活轴（不冲突）

| Companion | Deprovision |
|-----------|-------------|
| `activation_status`: `pending_activation` \| `activated` only | 不引入第三激活态 |
| Pending: `is_active=false`、无 active `user_orgs`、grant off | 通常 **无** 可记 destructive effect；目录镜像仍可 inactive |
| Activate 同事务点亮 membership/user | 之后才进入完整离岗候选 |
| 恢复离岗 | **不是** pending→activated 通道；不设密码 |

---

## 3. Design principles（Rev 4.2）

1. **Ledger is authority for directory offboarding reverse** — 不是 auditLog，不是 run.stats sample。  
2. **Drift-safe reverse** — 只逆转「当前值仍 = after」的 effect；否则 409，不覆盖更新的管理意图。  
3. **Supersede on intervening writes** — 通用停用 / grant / membership / bind 等访问图写者必须 **同时**（**AND**，不可只做一腿）：  
   - 递增 `users.access_generation`，**并且**  
   - 将相关 open effects 标为 `superseded`（见 §5.4 helper）。  
4. **Historical witness ≠ live link row** — 创建时用 trigger 验证当前 linked；落库后 immutability 固化；**禁止** FK 到可变的 `directory_account_links` 当前行（避免卡 unbind/rebind）。  
5. **One planner, prospective-first** — Preview 与 Apply 同谓词。  
6. **One per-user mutex for all access-graph writers** — 不仅 deprovision。  
7. **Default-off env 不变**；新建 integration **manual_review** 提前落地。  
8. **Reactivation never resets password**；响应含 mobile/username；引导重置密码。  
9. **No-email first-class**（companion）。

---

## 4. Prospective planner（P1 Preview=0 — 保持）

```ts
planDirectoryDeprovision(client, {
  integrationId, orgId,
  prospectiveDeactivatedAccountIds, // Preview: 仍 is_active=true 的将消失 id
  syncedAccountCount,
  integrationDefaultPolicy,
}): DirectoryDeprovisionPlan  // READ-ONLY
```

Sibling / globally-clear SQL **必须**把整组 prospective 视为 inactive：

```sql
AND NOT (sibling.id = ANY($prospective::uuid[]))
```

Apply 在 directory transition 之后调用时，prospective = 本轮 `RETURNING id`；与 Preview 谓词一致。

**Positive control test:** 将消失的 linked 账号 → Preview `candidateCount ≥ 1`；去掉 prospective 排除 → 变 0 且测试红。

Writer：`applyDirectoryDeprovisionPlan` 仅在 `enabled=true` 时写访问图 + ledger；`enabled=false` 零写。

---

## 5. Effect ledger（Rev 4 — 证据链闭合 LOCKED）

### 5.1 为何 Rev 2/3 草图仍不够

- 无 `(run_id, integration_id)` 复合 FK → run 可属错误 integration。  
- `local_user_id` 仅引用 `users` → 可与 account A 拼出无关 user B。  
- 自由 JSON before/after → 任意 blob 成恢复指令。  
- membership `org_id` 可空 → 无法锚定组织成员 effect。  
- 恢复盲写 before 覆盖后续安全停用（drift/generation 必须严格）。

### 5.2 表结构意图（Rev 4.2 — DB 权威；历史 witness 不绑 live link）

**Prerequisite unique keys**（迁移必须先有，否则复合 FK 无法建）：

- `directory_accounts (id, integration_id) UNIQUE`
- `directory_integrations (id, org_id) UNIQUE`
- `directory_sync_runs (id, integration_id) UNIQUE`

**明确不做（P1 — LOCKED）：**

- **`FOREIGN KEY (directory_account_id, local_user_id) → directory_account_links`** — 当前 unbind 会把同一 link 行的 `local_user_id` 置 NULL（`unbindDirectoryAccount`）；历史 event 若 FK 到 **可变的 current link**，会 **永久拒绝合法 unbind/rebind**。
- 以 `partial UNIQUE WHERE link_status='linked'` 作为 FK 目标 — **PostgreSQL 不允许** partial unique 作为 FK 参照。
- 默认不引入 append-only `directory_account_link_versions`（方案 B；仅未来另票）。

**锁定方案 A：** 无 event→current-link FK；创建时 **mandatory BEFORE INSERT trigger** 验证 **当时** linked；写入 account/user/witness 字段；**immutability** 固化历史；之后 link 可变，旧 event 不受影响。

```sql
directory_deprovision_events (
  id uuid PRIMARY KEY,
  event_origin text NOT NULL,
  integration_id uuid NOT NULL,
  org_id text NOT NULL,
  run_id uuid NULL,           -- NULL only if event_origin <> 'sync'
  directory_account_id uuid NOT NULL,
  local_user_id text NOT NULL REFERENCES users(id),
  -- Historical snapshot only (NOT a live FK to links):
  link_witness_account_id uuid NOT NULL,
  link_witness_local_user_id text NOT NULL,
  policy text NOT NULL,
  globally_clear boolean NOT NULL,
  status text NOT NULL,
  access_generation_at_apply bigint NOT NULL,
  triggered_by text NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  resolve_note text,
  restore_mode text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (event_origin IN ('sync','admin_manual')),
  CHECK (
    (event_origin = 'sync' AND run_id IS NOT NULL)
    OR (event_origin = 'admin_manual' AND run_id IS NULL)
  ),
  CHECK (policy IN ('manual_review','disable_grant_only','mark_inactive')),
  CHECK (status IN ('applied','fully_resolved','superseded')),
  CHECK (link_witness_account_id = directory_account_id),
  CHECK (link_witness_local_user_id = local_user_id),
  CHECK (restore_mode IS NULL OR restore_mode IN ('rehire','admin_force')),

  FOREIGN KEY (directory_account_id, integration_id)
    REFERENCES directory_accounts (id, integration_id),
  FOREIGN KEY (integration_id, org_id)
    REFERENCES directory_integrations (id, org_id),
  FOREIGN KEY (run_id, integration_id)
    REFERENCES directory_sync_runs (id, integration_id)
  -- intentionally NO FK to directory_account_links
);

directory_deprovision_event_effects (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES directory_deprovision_events(id) ON DELETE CASCADE,
  effect_type text NOT NULL,
  org_id text NULL,
  before_active boolean NOT NULL,
  after_active boolean NOT NULL,
  status text NOT NULL,
  access_generation_at_apply bigint NOT NULL,
  reversed_at timestamptz,
  reversed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CHECK (effect_type IN ('membership_changed','grant_changed','user_changed')),
  CHECK (status IN ('applied','reversed','superseded')),
  CHECK (
    (effect_type = 'membership_changed' AND org_id IS NOT NULL)
    OR (effect_type IN ('grant_changed','user_changed') AND org_id IS NULL)
  ),
  UNIQUE (event_id, effect_type)
);
```

#### 5.2.1 Mandatory DB enforcement（Rev 4.2）

| 机制 | 要求 |
|------|------|
| **BEFORE INSERT ON events** | 在 **已持有对应 `users` 行锁的同一事务** 内校验：**当时** 存在 linked 行（`link_status='linked'` 且 account/user 匹配）；account ∈ integration；integration.org_id 匹配；sync 时 run 存在且同 integration。失败 → **拒绝 INSERT**。 |
| **BEFORE INSERT ON effects** | `membership_changed` ⇒ `NEW.org_id = parent event.org_id`，否则拒绝。 |
| **Immutability** | events：INSERT 后禁止改身份字段（含 `directory_account_id`, `local_user_id`, `link_witness_*`, policy, globally_clear, generation, event_origin, run_id, org_id, integration_id, triggered_by）。仅允许 resolve 列。effects：INSERT 后禁止改 type/org/before_active/after_active/generation；仅 status/reversed_*。 |
| **禁止** | event→**current** `directory_account_links` FK；partial unique 作 FK 目标；仅靠 witness=自身 CHECK 充当“当时已 linked”（CHECK 只防自相矛盾，**trigger 才验 live link**）。 |

**Mutation / 集成必过：**

1. raw INSERT account/user 错配、membership org 错配、sync 无 run、INSERT 后篡改 witness → **DB 拒绝**。  
2. **生命周期：** 产生 deprovision event →（可选 supersede）→ **unbind 成功** → **rebind 成功**；旧 event 的 `directory_account_id` / `local_user_id` / `link_witness_*` **保持不变**。

### 5.3 Forward write 规则（Rev 4.1 — 零 effect 零写）

同事务、**先** `SELECT id FROM users WHERE id=$1 FOR UPDATE`：

1. 锁内 revalidate org candidacy / globally-clear；读取各层 **current** active 布尔值。  
2. **计算** 将写入的 effect 集（planned ≠ no-op）。  
3. **若 effect 集为空**（含 `manual_review`、或全部 before==after）：**零写返回** — **不** generation++、**不** INSERT event、**不** INSERT effect。  
4. **若非空**：  
   a. generation++ → `G'`  
   b. 应用状态写  
   c. INSERT event（`event_origin='sync'`, `run_id NOT NULL`）+ effects（`access_generation_at_apply=G'`）  
5. Trigger 再做 link/org/run 权威校验（双保险）。

Post-commit：`auditLog` best-effort + `invalidateUserPerms` — **非**权威。

**测试钉死：** 零 effect 候选 → `users.access_generation`、event 表、effect 表 **全不变**。

### 5.4 Access generation / supersede（保持 Rev 4 唯一裁定 + 4.1 序）

| 项 | 锁定 |
|----|------|
| 粒度 | **per-user** `users.access_generation` |
| Mutex | **仅** `users` 行 `FOR UPDATE` |
| Forward | **仅当 effect 集非空** 才 generation++，并保存 `G'` |
| 其他访问图写者 | **必须同时** generation++ **AND** supersede open effects（不可只做一腿） |
| Restore | `status=applied` AND current==after_active AND generation **相等**；否则 409 DRIFT |
| 成功 reverse 后 | effects reversed；event fully_resolved；generation++ |

---

## 6. Restore 资格与 API（Rev 4 产品裁决 LOCKED）

### 6.0 双路径（禁止「源仍离岗却默认全图恢复」）

| 路径 | 端点 | 允许条件 | 语义 |
|------|------|----------|------|
| **A. Rehire** | `POST .../deprovision-events/:eventId/reactivate` | drift 通过 **且** 同一 account **当前 active** **且** link 仍指向同一 user **且** integration active | 逆转无 drift 的 applied effects |
| **B. Admin force** | `POST .../deprovision-events/:eventId/force-reactivate` | `confirm: true` + 足够长 note + 平台 admin；**仍受 drift/generation** | 允许目录源仍 inactive；audit `restore_mode=admin_force` |

路径 A 在 account 仍 inactive → **403/409 `DIRECTORY_DEPROVISION_SOURCE_STILL_INACTIVE`**，不得默默全图恢复。

### 6.1 API

```http
GET  /api/admin/directory/integrations/:id/deprovision-events?status=applied
POST /api/admin/directory/deprovision-events/:eventId/reactivate
     { "note": "..." }
POST /api/admin/directory/deprovision-events/:eventId/force-reactivate
     { "note": "...", "confirm": true }
```

### 6.2 事务协议

```
BEGIN
  SELECT users FOR UPDATE
  lock event FOR UPDATE
  Path A: assert account active + link + integration active
  Path B: assert confirm + note
  assert generation equality with event/effects
  for each applied effect:
    if current_active != after_active OR gen mismatch OR superseded → 409 DRIFT
    set layer to before_active; effect := reversed
  event := fully_resolved; restore_mode := rehire|admin_force
  access_generation++
COMMIT
invalidateUserPerms; auditLog best-effort
```

### 6.3 响应

```ts
{
  eventId,
  restoreMode: 'rehire' | 'admin_force',
  localUser: { id, email, username, mobile, isActive, activationStatus },
  effectsReversed: Array<'membership_changed'|'grant_changed'|'user_changed'>,
  passwordUnchanged: true,
  passwordResetHint: string
}
```

UI：open events；A/B 分按钮；force 二次确认。

---

## 7. Canonical per-user mutex（Rev 4 — 唯一裁定）

### 7.1 问题

bind/unbind/rehire 等改变 globally-clear，不能只锁 deprovision 路径。

### 7.2 协议（无二选一）

| 规则 | 锁定 |
|------|------|
| **唯一 mutex** | `SELECT id FROM users WHERE id=$1 FOR UPDATE` |
| **不用** advisory lock 作为主协议 | 避免双轨 |
| **范围** | link、user_orgs、grant、is_active、deprovision plan/ledger、activate、admin 启停 |
| **批量** | userId **排序** 后依次加锁，防 ABBA |
| **纯 mirror** | 无 user 时可不锁；touch 用户图则必须 |

### 7.3 写者清单（实现 inventory · Rev 4.1）

**必须挂同一 `users FOR UPDATE` 的写者（非穷尽则 D0 补全并测试挂钩）：**

| 写者 | 为何 |
|------|------|
| deprovision apply / rehire restore / force restore | 访问图 + ledger |
| bind / unbind / batch 变体 | 改 link ⇒ globally-clear |
| admit / activate | membership/grant/user |
| admin-users is_active / grant | supersede + generation |
| active `user_orgs` upsert | membership |
| **同步对 linked 用户的 `directory_accounts.is_active` transition**（本轮 deactivate / 再出现 reactivate mirror） | **直接改变 globally-clear 输入** |

#### D0 协议补充（P2 — LOCKED）

对「目录账号活性迁移且该 account 已 linked」：

1. 由 account → 解析 `local_user_id`（若无 link 则无需 user 锁，只改 mirror）。  
2. **先** `SELECT users FOR UPDATE`。  
3. **再** 重读 link + account 当前行，确认仍指向同一 user。  
4. 再 `UPDATE directory_accounts.is_active`。  
5. bind 路径：在同一 user 锁下确认 **account 当前 active** 才允许建立/保持 linked（避免绑到正在离岗 transition 的账号而不串行化）。

**竞态测试：** account deactivate/reactivate ∥ bind；account deactivate ∥ deprovision plan/apply — 双连接 barrier。

### 7.4 globally-clear

在同一 `users FOR UPDATE` 事务内重读 sibling/global（含 **最新** directory_accounts.is_active）后再写 grant/user。

---

## 8. Preview 类型（保持并扩展 effect 计数）

```ts
wouldDeprovision: {
  candidateCount, manualReviewCount,
  wouldMembershipChangeCount,
  wouldGrantChangeCount,
  wouldUserChangeCount,
  abortedReason,
  sampledPeople: [{ ..., policy, globallyClear, plannedEffects }],
  truncated
}
deprovisionEnabled, deprovisionMaxBatch, integrationDefaultPolicy
```

---

## 9. UI 证据链（摘要）

- 全局 banner：env 开关 + MAX_BATCH + 文案「策略≠已执行」  
- Preview：plan + abort  
- Run：stats + 链到 events  
- Restore：open events；**rehire vs force 分按钮**；drift/源仍离岗 展示明确错误  
- 策略三选项；**创建默认 manual_review**  
- 恢复后：密码未改 + 链重置密码  

---

## 10. 实现顺序（P2 修正 — LOCKED）

**禁止** Rev 2 的「Step 2/3 颠倒 / manual_review 放 PR-7」。

| 序 | 工作 | 说明 |
|----|------|------|
| D0 | Writer inventory（**含 directory_accounts.is_active**）+ 锁点；对照 main@15a256fe2 | 码前必做 |
| **D1** | **manual_review 创建默认**（code + DB default，**不回填**） | 安全默认提前 |
| **D2** | **只读 `planDirectoryDeprovision` + prospective 排除**；Preview 接线；正控测试 | 先 planner |
| **D3** | Ledger schema + **强制 trigger/immutability** + generation/supersede helpers | 权威源 |
| **D4** | Writer：**先算 effect 集；零 effect 零写**；非零才 gen++/ledger | 后 writer |
| **D5** | 全写者挂 mutex + supersede hooks；双连接 barrier | P1-C |
| **D6** | Event restore + DRIFT_CONFLICT 测试 | |
| **D7** | UI flags / plan / events / restore | |
| — | **永不**在本序列内默认打开 `DIRECTORY_DEPROVISION_ENABLED` | |

与 companion 总序：

```
Design lock (admission Rev 4.2 + deprovision Rev 4.2)
  → T1 → T2 → T3
  → D1…D7
  → 才讨论 deprovision canary
```

---

## 11. 测试矩阵（exit，lock 后 · Rev 4 增补）

| 类 | 必过 |
|----|------|
| Preview 非零正控 | prospective 排除 load-bearing mutation |
| Preview 只读 | 无 users/grants/user_orgs/ledger 写 |
| Apply≈Plan | 同 pull 同锁语义 |
| 三 effect typed | 各 boolean effect 独立 mutation |
| **证据链 raw INSERT** | account/user 错配、membership org≠event、sync 无 run、篡改 witness → **trigger/约束拒绝** |
| **event 后 unbind/rebind** | 有历史 event → supersede（若需）→ unbind 成功 → rebind 成功；旧 event witness **不变** |
| **零 effect** | manual_review / 无实际变更 → generation、event、effect **全不变** |
| **account 活性竞态** | deactivate∥bind、deactivate∥deprovision 双连接 |
| Drift | 离岗后 admin 停用 → restore 409；generation 变化 → 409 |
| Supersede | admin is_active → open effects superseded + generation++ |
| **Rehire 资格** | account 仍 inactive → 普通 reactivate **拒绝** |
| **Rehire 正** | account 再 active + linked 同 user → 可 reverse 无 drift effects |
| **Force** | 源仍 inactive 时仅 force-reactivate + confirm；audit restore_mode |
| 锁 | bind∥deprovision 双连接；仅 users FOR UPDATE |
| 批量锁序 | 相反 user 序 batch 不死锁 |
| Pending | 不造假可恢复 effect |
| 密码 | restore 不改 password_hash |
| 默认 | 新 integration `manual_review`；旧行不变 |

---

## 12. 正确表述

| 避免 | 使用 |
|------|------|
| main 上可能还没有 membership | **main@ca625f14a 已有** org membership + globally-clear |
| 没有产品恢复路径 | 没有 **按离岗事件、drift-safe 完整恢复访问图** 的路径 |
| 恢复 = 点亮 is_active | 恢复 = 逆转 **仍等于 after** 的 ledger effects |
| 无邮箱 skip | companion：无邮箱可建档；凭据交付另解 |

---

## 13. Non-goals

- 现在开 T1 或 deprovision 实现  
- 默认 `DIRECTORY_DEPROVISION_ENABLED=true`  
- 用 auditLog / run.stats 当恢复权威  
- 自动 rehire 恢复  
- 恢复时分配密码  

---

## 14. Definition of lock（owner 清单 · Rev 4.2 — **已批准**）

升 **implementation design lock** 的确认项（2026-07-23 owner 全部勾选）：

- [x] Companion Rev 4.2：密码回填（`local_password_set` 存量 true）；alias 全局 UNIQUE + `normalizeLoginIdentifier` + T2a/T2b 防锁死；SSO 源有效性闭集  
- [x] 本文 Rev 4.2 承重合同：  
  - 历史 witness = **强制 INSERT trigger**（验当时 linked）+ **immutability**；**不** FK 到可变 current `directory_account_links`  
  - event 后 supersede / unbind / rebind 可继续；历史证据不变（测试矩阵必过）  
  - 旁路写者 **generation++ AND supersede**（不可只做一腿）  
  - 零 effect 零写；`directory_accounts.is_active` 入 writer inventory + 竞态  
  - rehire vs force-reactivate 双路径  
- [x] baseline 锚点 `15a256fe2`（相对 `ca625f14a` 本线 scoped diff = 0）  
- [x] 总序：lock → T1→T2→T3 → D1…D7 → canary  
- [x] **design lock ≠ T1 GO** — 本次批准 **不授权** 启动 T1  

NIT（升 lock 时已落实）：本节标题与清单中的「本文」版本号统一为 **Rev 4.2**（不再写 draft→lock / Rev 4 / Rev 4.1）。

实现阶段必须跑 §11；文档 delta 轮次可不跑测试。

---

## 15. Changelog

| Date | Rev | Change |
|------|-----|--------|
| 2026-07-23 | 1 | 初稿（已撤回 lock） |
| 2026-07-23 | 2 | planner/三 effect/event 初稿 |
| 2026-07-23 | 3 | baseline 诚实；ledger/DRIFT 意图；mutex 意图 |
| 2026-07-23 | 4 | 复合 FK；witness 意图；generation/mutex；rehire vs force；仍 draft |
| 2026-07-23 | 4.1 | 强制 trigger/immutability；零 effect 零写；account is_active inventory；仍 draft |
| 2026-07-23 | 4.2 | **删除** event→current-link FK；历史 witness=trigger@INSERT+immutability；supersede **AND** gen++；unbind/rebind 测试；draft |
| 2026-07-23 | 4.2-lock | owner 批准两篇一并升 **implementation design lock**；§14 改为已批准清单（Rev 4.2）；NIT 落实；**T1 未授权** |
