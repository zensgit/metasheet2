# DingTalk 目录准入与激活生命周期 — 设计（三动作拆分）

- Date: 2026-07-23
- Status: **implementation design lock / Rev 4.2**
- Locked: 2026-07-23（owner 批准，与 deprovision Rev 4.2 两篇一并升 lock）
- Scope: 本地化部署下「同步 ≠ 建档 ≠ 开通登录」；邮箱可空；手机/邮箱可同步但非钉钉身份主键
- Companion: `docs/development/dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md` (implementation design lock / Rev 4.2)
- Baseline: `origin/main @ 1bcfc86b8`（自 `ca625f14a` 对本线相关代码 **scoped diff = 0**；事实基线仍成立）
- **design lock ≠ T1 GO：本次批准不授权启动 T1**（总序 lock → T1 → T2 → T3 → D* → canary，另令开工）
- Related code:
  - `directory-sync.ts` — auto-admit、bind、`user_orgs` upsert
  - `auth/dingtalk-oauth.ts` — login gates
  - `auth/AuthService.ts` — identifier login
  - `services/AttendanceSetupReadinessAggregate.ts` / `AttendanceNotificationDeliveryWorker.ts` — 仅看 `users.is_active` + `user_orgs.is_active`
  - migrations: `zzzz20260119100000_create_users_table.ts` (`password_hash NOT NULL`), `zzzz20260418170000_allow_no_email_users_and_add_username.ts`

---

## 0. Owner 裁决（产品 — 已赞成）

| 动作 | 建议默认 | 说明 |
|------|----------|------|
| **A. 同步**钉钉组织与人员档案 | **自动** | `directory_*` 镜像 |
| **B. 创建本地用户** | 管理员开启后按部门范围自动建档 | **待激活**，不可登录、不可当业务成员 |
| **C. 开通登录** | 管理员临时密码激活，或 **专用** SSO activate 流程 | 首次本地密码强制改密 |

原则（锁定）：

1. 同步到人 ≠ 立即可登录 ≠ 进入通知/考勤/readiness 成员集。  
2. 邮箱可选联系信息；**禁止** placeholder 假邮箱。  
3. 有手机/邮箱则同步；**钉钉身份主键** = `provider + integration/corp + userid`；unionId/openId 补充。  
4. 范围外人员只保留目录档案。

---

## 1. Rev 演进

### 1.1 Rev 2 → Rev 3（方向性 — 已关）

| # | 锁定 |
|---|------|
| **P1-A** | 双轴；pending：`is_active=false`、无 active `user_orgs`、grant off |
| **P1-D** | 独立 `intent=activate`（Rev 4 补源有效性） |
| 密码列 | 保持 NOT NULL + 随机不可用 hash |
| 登录别名 | alias 表（Rev 4 改全局 UNIQUE） |

### 1.2 Rev 3 → Rev 4（实现级 — 本轮）

| # | 问题 | Rev 4 锁定 |
|---|------|------------|
| **P1** | `local_password_set` default false 只回填 activated → **存量密码登录全挂** | §3.1 回填与写路径 |
| **P1** | `UNIQUE(kind, value)` 无法挡住跨 kind 碰撞（login 无 kind） | §4.2 **`UNIQUE(normalized_value)` 全局** |
| **P1** | SSO activate 未要求 integration/account 仍有效 | §6.2 源有效性闭集 |
| — | 测试矩阵 | §10 正控 + mutation |

---

## 2. 双轴状态模型（P1-A — LOCKED）

### 2.1 两轴，禁止第三态叠床架屋

| 轴 | 列 | 闭集 | 含义 |
|----|-----|------|------|
| **激活轴** | `users.activation_status` | **`pending_activation` \| `activated` only** | 是否完成正式开通流程 |
| **可用轴** | `users.is_active` | `true` \| `false` | 安全/离岗/人工停用等「是否允许作为活跃主体」 |

**禁止** 再设 `activation_status=disabled`（与 `is_active` 重复）。  
历史/离岗「停用」只走 `is_active=false`（+ deprovision ledger effects）。

### 2.2 Pending 用户的强制不变量（create = Action B）

创建本地用户（auto 或 manual 默认）时 **同事务** 必须满足：

| 项 | Pending 值 |
|----|------------|
| `activation_status` | `pending_activation` |
| `users.is_active` | **`false`** |
| DingTalk grant | **false / 无 enabled 行** |
| `user_orgs` | **不插入**，或插入且 **`is_active=false`**（推荐：**不插入**，activate 时再 upsert active） |
| 目录 link | 可 `linked`（身份关联 ≠ 平台成员） |
| 密码 | 不可用 hash（§3）；**不**发放可用临时密码 |

**推论：** 一切只检查 `users.is_active ∧ user_orgs.is_active` 的消费者（readiness、通知投递、成员枚举等）**默认排除 pending**，无需立刻理解 `activation_status`。  
`activation_status` 仍必须在 **所有登录/token 签发路径** 显式校验，防止将来有人把 pending 的 `is_active` 误点亮。

### 2.3 Activate（Action C）— 同事务写入

激活必须在 **单事务** 内完成目标状态（按模式）：

| 模式 | 事务内效果 |
|------|------------|
| **temp_password** | `activation_status=activated`；`is_active=true`；upsert **active** `user_orgs`（当前 org）；写可用 `password_hash`；`must_change_password=true`；grant 默认仍 false（除非 admin 勾选） |
| **sso_only / SSO activate intent** | 同上 membership + activated + is_active；**grant=true**（openId 规则允许时）；密码保持不可用 hash 或不变 |
| **禁止** | 先发 session 再改状态；或只改 `is_active` 不改 `activation_status` |

### 2.4 通用用户状态 API（LOCKED）

`admin-users`（及任何「点亮 is_active」的通用路径）：

- 若 `activation_status = pending_activation`：  
  - **拒绝** 将 `is_active` 设为 true，或  
  - 要求显式走 **directory activate** API（同一套 Action C），  
- **不得** 成为绕过正式激活的后门。  
- 对已 `activated` 用户的安全停用/启用保持现有语义，并必须 **supersede** 未恢复的 deprovision effects（见 deprovision Rev 4.2）。

### 2.5 登录 / token 守卫（T1 必达）

以下全部拒绝 pending 或 inactive（明确错误码）：

- 密码登录  
- 现有钉钉 OAuth **login**  
- 容器免登 login  
- refresh / API token 签发与校验（凡解析为用户会话处）

错误码建议：

- `ACCOUNT_PENDING_ACTIVATION`  
- `ACCOUNT_INACTIVE`  

---

## 3. 密码存储与 `local_password_set`（Rev 4 LOCKED）

`users.password_hash` 保持 **NOT NULL**（当前 schema）。  
新增：`local_password_set boolean NOT NULL`（语义：是否允许用密码哈希做本地密码登录）。

| 决策 | 选择 |
|------|------|
| Pending / SSO-only 新建 | **随机不可用 hash** + **`local_password_set=false`** |
| 改列允许 NULL | **不做** |
| 密码登录守卫 | `local_password_set=false` → 直接失败（不校验 hash） |
| activate(temp_password) | 写可用 hash + **`local_password_set=true`** + `must_change_password=true` |

### 3.1 存量回填与写路径（P1 — 必须，防全员锁死）

T1 迁移 **同时** 做：

| 对象 | 回填 / 写入 |
|------|-------------|
| **全部既有 `users` 行** | `activation_status = 'activated'` **且** `local_password_set = true` |
| 之后：register / 改密 / 管理员重置密码 / activate(temp_password) | 一律 **`local_password_set = true`** |
| 之后：Action B pending 创建、SSO-only 激活且未设本地密码 | **`local_password_set = false`** + 不可用 random hash |

**禁止** 只回填 `activation_status` 而留下 default `local_password_set=false`。

**正控测试（T1 必过）：** 迁移前存在密码用户 → 迁移后仍可密码登录。  
**Mutation：** 回填漏写 `local_password_set=true` → 该正控必须红。

---

## 4. 联系字段与登录别名（T2 · Rev 4）

### 4.1 镜像（directory_accounts）

| 字段 | 规则 |
|------|------|
| `mobile` | API 有则存；可重复 |
| `email` | 个人邮箱；可空 |
| **`org_email`** | **新增列**（非仅 raw）；从 `org_email`/`orgEmail` 规范化读入；可空 |
| raw JSON | 仍保留完整 source |

`users.email`（资料，非主键）：`org_email` 优先，否则 `email`，否则 NULL。

### 4.2 登录 alias 表（P1 — 全局唯一命名空间 LOCKED）

现网 `AuthService` 登录入口是 **无 kind 的 identifier**，同一字符串会并行匹配 email / username / mobile。  
因此 **`UNIQUE(kind, normalized_value)` 不够**：用户 A 的 username 与用户 B 的 email 规范化后相同，仍会双行并存，登录歧义。

**锁定（推荐方案，唯一采纳）：**

```text
user_login_aliases (
  id,
  user_id → users(id),
  kind CHECK IN ('email','mobile','username'),  -- 元数据/展示；不参与唯一
  normalized_value text NOT NULL,
  UNIQUE (normalized_value),   -- 登录命名空间全局唯一
  ...
)
```

| 规则 | 说明 |
|------|------|
| 登录查询 | **只查 alias**：`normalized_value = normalizeLoginIdentifier(raw)`；0 命中 fail；1 命中该 user；**禁止**回退 `users` 上 email/username/mobile 的 OR 三列查询 |
| 目录镜像 | 仍可保留重复手机号；**不自动**占 alias |
| 占用时机 | activate / admin 明确 claim 时 INSERT；冲突 → 审核 |
| username | 创建时 claim 一条全局唯一 username alias |
| **存量迁移** | 见 T2a：只迁全局唯一归属值；碰撞进报告/审核 |
| 备选（不采用） | 登录 API 强制 kind — **不做** |

### 4.3 `normalizeLoginIdentifier()`（P2 — LOCKED）

**单一实现**，claim / 迁移 / 登录查询 **只能**调用它（禁止各路径私有 trim/lower）。

| 输入形态 | 规范化（锁定意图；实现单测钉死） |
|----------|----------------------------------|
| 含 `@` 且像邮箱 | `trim` → Unicode NFKC → **整个字符串 lower-case** |
| 否则若像手机（允许前导 +、空格、横线） | 去空白与 `-()` → 若以 `+` 开头保留国家码数字串；大陆 11 位 `1…` 规范为 `+86`+11 位（规则写入单测） |
| 否则 | 视为 username：`trim` → NFKC → **lower-case**（username 大小写不敏感登录） |

同一 `normalized_value` 全局唯一 ⇒ **同一登录输入**在三种形态下也不得映射到不同用户。  
若邮箱 local-part 与某 username 规范化后碰撞，迁移进审核，不静默覆盖。

### 4.4 T2 切片防锁死（P2 — LOCKED）

| 子票 | 工作 | 切换门 |
|------|------|--------|
| **T2a** | 建 `user_login_aliases`；回填唯一归属值；**生成碰撞报告**（不切换读路径） | 读路径仍可用旧逻辑 **仅在 T2a** |
| **T2b** | 确认 **至少一个 `is_active` platform admin** 拥有可用 alias（可密码登录）后，**原子切换** Auth 只读 alias；部署后 **永久禁止** 回退 OR 三列 | 门未过 → **不切换** |

覆盖规则：admin 本地编辑可 lock；同步只更新 mirror；users 资料字段仅在「仍等于上次同步值」时跟随。

---

## 5. 三动作流程（修订后）

```
[A] Sync (auto)
    → directory_* only
    → no users, no user_orgs, no grants

[B] Create local user (scoped auto / manual)
    → users: pending_activation, is_active=false, unusable password, local_password_set=false
    → directory_account_links linked
    → NO active user_orgs, NO enabled grant
    → optional: queue "待激活"

[C] Activate
    → admin batch temp password  OR  OAuth intent=activate
    → same tx: activated + is_active + active user_orgs + password/grant per mode
    → audit (values-free for secrets)
```

---

## 6. SSO 激活（P1-D — LOCKED，反死锁）

### 6.1 为什么普通 OAuth login 不行

现状（main）：OAuth 在发 session 前拒绝 **inactive 用户** 与 **disabled grant**。  
Pending 设计为 `is_active=false` + grant false → **无法**用「先登录再激活」完成证明。

### 6.2 `intent=activate` 专用流程（Rev 4 源有效性 LOCKED）

| 步骤 | 规则 |
|------|------|
| Launch | `/api/auth/dingtalk/launch?intent=activate&...` 与 login **分离** state 命名空间 |
| State | 绑定：intent、**非权威** hint（directoryAccountId/userId 可选）、corp、nonce、TTL；共享 store 规则与 login 一致 |
| Callback 权威解析 | 仅以 **钉钉换码结果** + DB 当前行为准；**state 中的 user/account hint 不得单独授权** |
| **源有效性闭集（全部满足才可激活）** | ① `provider = dingtalk` ② **integration `status=active`**（及 org 一致）③ **directory_account `is_active=true`** ④ link `link_status=linked` 且 **local_user_id 指向该 pending 用户** ⑤ 换码身份与 account 的 corp/userid（及可用的 openId/unionId）**一致** ⑥ 用户 `activation_status=pending_activation` |
| 禁止 | email/mobile 自动匹配建绑；unmatched JIT；激活其他用户；**已停用 integration / 已 inactive 的目录账号** 完成激活 |
| 原子性 | **发 session 之前** 同事务：再校验闭集 → activate(sso) → grant（openId 规则）→ 再 JWT |
| 失败 | 任一条件失败 → 4xx，不创建用户、不改 pending |

Admin 仍可在无 SSO 时用 T3 批量表格激活（同样不得对 inactive 目录源静默开通，除非独立强制流程 — 见 deprovision 强制恢复语义，不混用）。

---

## 7. API 票（仍不实施，仅锁定边界）

### T1 — 生命周期

- migration: `activation_status`, `local_password_set`  
- 既有用户：**`activated` + `local_password_set=true`**（`is_active` 保持原值）  
- 写路径：§3.1  
- create 路径改 pending 不变量  
- **停止** admission 对 pending 写 active `user_orgs`  
- 全登录/token 守卫  
- 通用 is_active API 拒绝对 pending 点亮  
- 测试：存量密码登录正控 + 回填 mutation  

### T2 — org_email / mobile / alias

- client `org_email` 列  
- alias 表 **`UNIQUE(normalized_value)`**  
- 存量碰撞：只迁唯一值；冲突进审核；查询 fail-closed  
- 登录改为只查 alias（无 kind）

### T3 — 激活与凭据

- batch-activate（temp password / sso_only）  
- OAuth intent=activate  
- 凭据一次性展示 + values-free 审计  
- 禁止同步响应作为唯一密码通道  

---

## 8. 与 deprovision 的接口（摘要）

| 用户 | Deprovision |
|------|-------------|
| `pending_activation` | 默认可只停 directory 镜像；**避免**制造「假离岗 effect」；若从未 active membership，通常无 membership/grant/user effect 可记 |
| `activated` + 离岗 | 完整 plan/ledger（deprovision Rev 4.2） |
| 恢复 | 仅 event + drift 检查；**不是**激活 pending 的通道 |

规范细节在 deprovision Rev 4.2。

---

## 9. 程序顺序（LOCKED）

```
Implementation design lock（两篇 Rev 4.2，2026-07-23 已批准）
  → T1 生命周期 + 守卫 + 回填          ← 需另行授权 GO
  → T2 org_email/mobile/alias（T2a → T2b）
  → T3 批量激活 + SSO intent=activate
  → Deprovision D1…D7
  → 最后才讨论 DIRECTORY_DEPROVISION_ENABLED canary
```

**当前：design lock 已批准；T1 未授权，禁止启动。**

---

## 10. 测试（lock 后实施用 · Rev 4 增补）

| 类 | 断言 |
|----|------|
| Pending 不泄漏 | readiness/通知/成员查询不含 pending；无 active `user_orgs` |
| 登录 | 密码/OAuth login/token 拒 pending |
| Admin 旁路 | 通用 is_active=true 对 pending → 4xx |
| **存量密码正控** | 迁移前密码用户 → 迁移后仍可密码登录 |
| **回填 mutation** | 漏填 `local_password_set=true` → 正控红 |
| 写路径 | 改密/重置后 `local_password_set=true`；pending 保持 false |
| Alias 全局唯一 | 无法插入第二用户占用同一 `normalized_value`（跨 kind） |
| normalize 共享 | claim/迁移/登录 三路径同一函数；分叉 mutation 红 |
| Alias 迁移 T2a | 碰撞报告完整；未切换前旧登录仍可用 |
| T2b 防锁死 | 无可用 admin alias 时拒绝切换；切换后禁止 OR 回退 |
| 登录查询 | 切换后只查 alias；未知 → 失败 |
| SSO 源有效 | inactive integration / inactive account / 断链 / corp 不符 → 不可 activate |
| SSO hint | 伪造 state hint 指向其他 user → 拒绝 |
| SSO 正 | active integration + active account + linked pending + 身份一致 → session 前激活 |
| 无邮箱 | 可建 pending；activate 后 username alias 登录 |
| 回填 activated | 存量 `activation_status=activated`，`is_active` 不变 |

---

## 11. Non-goals

- 在未获 T1 GO 前启动 T1（**design lock ≠ T1 GO**）  
- 把 email 当必填  
- 用 `UNIQUE(kind, value)` 或手机号单列 UNIQUE 代替全局 alias  
- 普通 OAuth login 顺带激活  

---

## 12. Changelog

| Date | Rev | Change |
|------|-----|--------|
| 2026-07-23 | 1 | 初稿：三动作、pending、org_email |
| 2026-07-23 | 2 | pending + is_active 等中间稿 |
| 2026-07-23 | 3 | 双轴、pending 不变量、intent=activate 初稿 |
| 2026-07-23 | 4 | `local_password_set` 存量 true；alias 全局 UNIQUE；SSO 源有效性；仍 draft |
| 2026-07-23 | 4.1 | `normalizeLoginIdentifier` + T2a/T2b；baseline 1bcfc86b8；仍 draft |
| 2026-07-23 | 4.2 | 版本对齐 deprovision 4.2（本文件无新 P1）；draft |
| 2026-07-23 | 4.2-lock | owner 批准与 deprovision 4.2 两篇一并升 **implementation design lock**；承重合同见 companion §14；**T1 未授权** |
