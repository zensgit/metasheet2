# 权限管理命令：原子授权与服务端影响预览

日期：2026-11-17；状态：提议，供独立 ADR PR 评审。基线冻结于 `ba385e10a1c1a4cece6a37216a37c6e10c38b367`；合并前随目标 main 更新 SHA 并重新核验所有引用。本文只决定后续实现契约，不表示代码、测试、部署或生产写入已经完成；`DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED=false` 保持不变。新增操作和授权边界变更的 ADR 与功能代码分别提交 PR（`.github/PULL_REQUEST_TEMPLATE.md:62`）。

## 现状与边界

`permissions.ts:136,217,293,455` 分别提供直接 grant/revoke、legacy revoke、模板 apply；模板逐条写入，旧接口审计不构成原子证明。角色操作在 `admin-users.ts:4474,6168,6251`，委派与平台入口有各自的 actor、目标和范围规则。`role-assignment.ts:564,605` 是角色 ID/内容及写入边界，并不独自证明调用者身份、目标 audience 或整个命令的授权。`authorization-input-lock.ts:546` 已定义有序锁入口。`audit/audit.ts:45` 将 user actor 转数字并吞掉审计失败；现有 `audit_logs.user_id` 是 INTEGER（`db/migrations/zz20251231_create_audit_tables.ts:20`），不能证明 UUID/TEXT actor 的必需事务审计。

本 ADR 覆盖一个目标用户、一种来源动作：角色 assign/revoke、直接权限 grant/revoke、legacy 单 code revoke、模板授予，或独立 `admission.set`；可另附显式 admission 变更。仅调整或关闭准入不要求虚构一个角色动作，同样纳入预览、版本、回执与逐 namespace 授权。它不改 role 内容、独立管理 audience/group、批量目标或 account lifecycle；这些现存操作及其约束仍适用。历史 `users.permissions` 仅可移除明确存在的 code；不得根据 code 名称推断旧记录属于某角色或模板。

## 契约

三个端点均认证并执行当前主体的授权；拒绝越权信息泄露。payload 严格 schema，拒绝未知字段、重复 code/namespace、不支持的值和超限；标识为规范字符串。直接授予和模板例外必须提供 reason，trim 后 1–255 Unicode 字符，拒绝超限而非截断。普通角色、准入及撤销可选填原因，未填记录 `reason_origin=not_required`；不增加原提案没有要求的操作障碍。文本和标识不写应用日志/PR 证据。

```
POST /api/admin/authorization-operations/preview
{
  "targetUserId": "...",
  "action": { "kind": "role.assign" | "role.revoke", "roleId": "..." }
          | { "kind": "direct.grant" | "direct.revoke" | "legacy.revoke", "code": "..." }
          | { "kind": "template.apply", "templateId": "..." }
          | { "kind": "admission.set" },
  "admissionChanges": [{ "namespace": "...", "enabled": true | false }],
  "reason": "..."
}
200 { "expectedVersion": "opaque-v1:...", "impact": {
  "sourceChanges": [...], "admissionChanges": [...], "scopeCleanup": [...],
  "effectiveBefore": [...], "effectiveAfter": [...], "retainedOtherGrants": [...],
  "warnings": [...]
} }

POST /api/admin/authorization-operations
{ "clientOperationId": "UUID", "expectedVersion": "opaque-v1:...", "targetUserId": "...",
  "action": { ... }, "admissionChanges": [...], "reason": "..." }
200 { "status": "committed", "clientOperationId": "UUID", "receipt": { ... } }

GET /api/admin/authorization-operations/:clientOperationId
200 { "status": "committed", "clientOperationId": "UUID", "receipt": { ... } }
200 { "status": "unknown_or_pending", "clientOperationId": "UUID" }
```

`admissionChanges` 必须提供，空数组表示不显式改变 admission；不能由省略、角色或模板隐式推断勾选。保留既有角色 revoke 因无角色而禁用 admission 的副作用、清理委派 scope/group 规则，预览和实际执行均显示这些派生变更；显式变更与派生变更冲突时 400，不静默决定次序。考勤显式禁用必须保留持久 opt-out，而非删除行后被登录 backfill 重开（`admin-users.ts:5453`）；既有 admission 策略的兼容性在实现前逐项核对。单次模板按服务端当前定义展开为有序去重的有界 code 集合，包含来源与操作类型；限制最多 100 code、20 admission、reason 255 字符、请求 32 KiB，超限 400。模板 definition 缺失或不合法 fail closed；实际集合也绑定版本和审计。有效权限展示遵循当前 namespace admission 规则，分别列出 role/direct/legacy 来源、保留的其他来源及被 admission 遮蔽的 code；无法确定的历史归属标 `unknown`，不伪造因果。预览只读取，不产生 receipt、审计写或授权副作用；可返回精确有界数据，超出上限拒绝而非截断成误导预览。

`expectedVersion` 是服务端按稳定规范编码计算的版本化不透明摘要，绑定规范化完整请求（不含 clientOperationId/expectedVersion）及一致性快照：actor/target 账号状态，目标角色、直接及 legacy 来源与 admissions，相关角色内容和模板定义，actor 当前平台/委派权力和逐 namespace audience、group 成员、目录/部门及其活跃状态、影响判断所需配置与 flag，包括 exact-department flag。涉及的行集合及缺失状态也在 witness 中；使用稳定排序与明确 null，避免无序差异。预览使用一致性读快照；需要防幻读的集合由全部相应写路径参与相同锁/版本协议，无法证明的输入或外部不可事务化状态须 fail closed，不能只 hash 旧快照。摘要只用于检测变更，不是权限凭证。

提交在锁内重新读取、重新认证/授权并重算版本和影响，陈旧返回 409 `STALE_PREVIEW`，不写入，客户端重新预览并由用户再次确认。无效 schema 400；无权 403（按现有不泄露策略可统一 404）；目标不存在 404；last admin 冲突 409；锁竞争沿现有协议返回 409 `AUTHORIZATION_INPUT_BUSY`，数据库不可用 503，且无部分成功。成功后 receipt 给出实际来源、admission、scope cleanup、保留来源和结果版本；不得用预览当作成功结果。

## 幂等、恢复和事务

`clientOperationId` 必须为客户端生成的 UUID；唯一键 `(actor_id TEXT, client_operation_id UUID)`。对规范化的完整提交请求计算版本化 SHA-256 digest：actor、目标、动作、显式 admission、reason 和 expectedVersion；expectedVersion 本身绑定预览时的模板展开与完整 witness，receipt 同时保存该绑定与实际展开。不依赖客户端提供的 digest；重放比较使用原请求与已存绑定，不重新展开当前模板，否则模板变化会破坏同请求重放。一个 actor 同 key 同 payload 返回原 receipt；同 key 任一内容或目标不同 409 `IDEMPOTENCY_CONFLICT`。同 key 的不同主体独立，绝不返回其他主体 receipt。提交先在事务和锁保护下重新验证当前 actor 的身份与当前读取该 receipt/目标的权限，再检查 receipt 和 digest；已提交的相同请求直接返回 receipt，**先于**陈旧版本检查，否则响应丢失后的安全重放会错误失败。新操作才重算版本并执行；权限已撤销时不泄露 receipt，也不再次写入。

GET 仅按当前 actor 查询已提交 receipt 并重新检查当前读取权限；缺失行包括尚未提交、已回滚、根本不存在等情况，统一 `unknown_or_pending`，无后台提交、无保留/变更行，不声称未执行。GET 可能在并发 COMMIT 前看到 unknown；客户端保留该 UUID 与原始不可变 payload，展示结果未知，可人工再次查询；不得因 unknown 或刷新自动 POST。用户明确选择重试时只允许原 actor 和原 payload 同 key POST；刷新换主体不自动重试、不显示原主体结果。传输响应完全丢失时同样先 GET，无法证实之前不显示成功或失败。

所有命令采用一个数据库事务、同一个 client：R0 world → 正式登记的 actor+UUID 幂等锁 → 如适用 R1 platform-admin invariant → R2R 按 role ID 排序的共享角色行锁（含 actor/target 和变更/模板涉及的所有角色）→ R3 按 actor/target ID 排序的 admission 锁 → R5 按 ID 排序 users 行锁。幂等锁秩、命名域、复合 intent、plan/entry 获取顺序及 writer/consumer 注册必须进入 `authorization-input-lock` 正式协议本体，不能在已获取 R1/R5 的 wrapper 外拼接。任何额外身份/目录锁遵守 `authorization-input-lock.ts:60` 的完整等级；不允许先拿高等级后回拿低等级。涉及的角色/成员集合若在规划后改变，释放并重试完整计划或拒绝，不能锁后扩集合逆序加锁。与目录、group、role 内容等写者共享现有锁/版本协议，未接线前该路径不得宣称安全。

锁内用数据库实时重验 actor 激活/删除状态、目标可操作状态及权限；平台管理员以活数据库角色为准，委派管理员每个相关 namespace 必须分别满足该 namespace 的角色/权限、角色内容安全和目标 audience，不能把 A namespace 的授权与 B namespace 的 audience 求并集拼成权限。禁止借角色、admission、模板或间接影响自我扩权；保留现有 target 检查。平台 admin revoke 与账号变更竞争必须持 R1 并执行现有 last-sign-in-admin 判断（`admin-users.ts:6269,6360`）；同步 `users` legacy admin profile（`:3005,6207,6289`），角色撤销执行 `disableNamespaceAdmissionsWithoutRoles`、scope/group 清理（`role-assignment.ts:413`），而非只删除 membership。所有写入、清理、审计、receipt 任一失败均 rollback，成功仅在 COMMIT 后响应。

新增迁移建立 `authorization_operation_receipts`，至少含 TEXT actor、UUID key、digest/version、target、规范动作/结果、创建时间，以 actor+UUID 唯一；建立 `authorization_operation_audit`，TEXT actor、同一 key、reason、reason_origin、实际 before/after 和影响，外键关联 receipt，同事务强制插入，失败 abort。可保存必要审计内容，但日志与对外证据保持 values-free；权限控制、保留期与备份必须覆盖 receipt，存续期内不可清理导致 key 重用。历史普通 audit 可继续 best effort，不能代替本表。迁移 down 若存在 receipt/audit 必须拒绝，不做破坏性删除；先停新写、保留数据并另行批准迁移/回滚方案。禁止将已经提交的 receipt 以 TTL 删除后当新 key 执行。

扩展现有管理员变更记录与导出 feed，同时纳入原 `audit_logs`、遗漏的 `legacy-permission` 及新事务审计；保留 TEXT actor，不做 UUID→数字强制转换。按 `(created_at, source, id)` 稳定分页，同一次 operation 只显示一条事务事件；旧 best-effort 镜像若存在，按 operation ID 去重。筛选、导出和列表应用相同当前读权；委派者只见自己仍获授权的 namespace 与目标，裁剪其他 namespace 的 admission、group 和规则。兼容旧游标与旧历史，不能用新表有记录替代“界面能找到变更”。新管理 UI 必须使用新契约，不能为省略原因或回执绕回旧接口。

GET/replay 的授权依据已存 receipt 的实际 target、action 与 namespace，而非调用者重放 payload；重新验证当前身份与读取权后裁剪 DTO。自己撤掉管理权后可能无法读取回执，客户端明确显示无读权、结果尚未核实；不自动补发。COMMIT 被服务端明确拒绝（例如 deferred constraint）可确认回滚；COMMIT 发出后连接中断可能已成功，不得宣称回滚，应进入结果未知并用 GET 核实。

## 入口接线与兼容策略

功能 PR 必须列出并逐项覆盖：`UserManagementView.vue:4496`、`RoleMembersPanel.vue:415`、`RoleDelegationView.vue:1632`、`PermissionManagementView.vue:905,1003`；备料成员 `services/integration/stockPreparation/members.ts:246`，考勤 `AttendanceView.vue:22517` 和 `attendance/useAttendanceAdminProvisioning.ts:495`，以及服务端 `permissions.ts:136,217,293,455`、`admin-users.ts:4474,6168,6251`、`attendance-admin.ts:1272,1352,1485,1551`。还需盘点 `server.js:296,313` 静态旧实现、脚本和所有 API 消费者，以及创建用户、目录同步、admission 单独接口等邻接写者；它们不因 UI 改线而自动受新命令保障。

兼容期旧路由保持请求/响应与各自授权策略，适配到同一事务执行核心及同等级锁、实际效果、强制 TEXT actor 审计；旧例外请求没 reason 记录 `reason_origin=legacy_unprovided`、reason NULL，不要求旧静态 JS 增加字段；显式提供的 reason 做同样边界校验并标 `provided`。若无法为某旧路径做到同样事务/鉴权，必须在交付清单明确未覆盖并阻断该路径的上线宣称，不能仅隐藏按钮。旧路由没有客户端 key/preview 的协议语义，不虚称具有安全重放或 server-preview；新例外 API reason 必填不等于全系统 mandatory reason。批量考勤不在单目标契约内，须保留独立原子批量，不以多次单目标提交冒充。

### 调用者策略矩阵

| 动作 | 实时平台身份 | 委派身份 |
| --- | --- | --- |
| role / admission | 保留 admin-users 的有效 raw-or-RBAC 平台身份策略 | 每项 namespace 独立权力与 audience 校验 |
| direct / template / legacy | 有效数据库 RBAC admin membership；raw-only 不足 | 拒绝 |
| 组合动作 | 每一项所需策略求交，逐项成立 | 不得借另一 namespace 的范围通过 |
| receipt / preview | 当前身份、原 actor 绑定与目标读取权；不得单独信任 claim | 与原操作逐项策略一致，不能查询其他 actor 回执 |

## 验收：必须实现并执行

- 每种 source/action、模板多 code、空/显式 admission、role revoke 自动 admission 与 scope/group 清理、考勤 opt-out、legacy admin 同步及 unknown 旧来源；对比服务端预览与实际事务结果，保留其他 grant 的有效性与 admission 遮蔽。
- 实际数据库并发测试：A 的角色权力与 B 的 audience 拼接拒绝；actor 失权、目标失效、目录/group/flag、role 内容、模板及 admission 在预览后变化均拒绝或 409；scope 幻读和角色并发编辑覆盖所有相关写者；self-widening 拒绝。两个最后管理员并发撤销/停用，至少一名仍可登录；锁顺序和超时无死锁/部分提交。
- 第二个 code 写失败、scope cleanup 失败、必需审计插入失败、receipt 插入失败、服务端明确拒绝 COMMIT：所有授权、副作用、审计、receipt 均回滚；另测 COMMIT 成功但响应丢失，经 GET 恢复而不重复提交。故障注入证明断言可检测移除事务/审计/权限检查的变异。
- 响应完全丢失、COMMIT 前 GET 与 COMMIT 后 GET、同 key 同 payload 重放先于 stale 检查、同 key 不同 target/reason/action 409、并发同 key、刷新后不同主体、权限撤销后读取 receipt；GET 不写且 unknown 不触发自动 POST。
- 新旧入口端到端逐条验证授权与兼容：旧请求无 reason 可用并留下 `legacy-unprovided`，新模板缺 reason 被拒；直接 grant/revoke、模板、角色、委派、备料及考勤的绕行清单均有可执行测试和未覆盖项。迁移回滚遇到已有 receipt 拒绝，审计 actor UUID 原样保存。

验收以真实数据库事务和请求链的测试证据为准；本文不声称这些测试已经通过。

