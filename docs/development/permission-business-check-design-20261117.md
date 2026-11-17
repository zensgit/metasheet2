# ADR：业务权限判定与多维表上下文检查

- 状态：提议；代码证据冻结于 `ba385e10a1c1a4cece6a37216a37c6e10c38b367`，合并目标基线变化后重新核对行号和差分测试。
- 范围：权限管理剩余 P1（业务 single / any / all 判定一致）及 P2（多维表只读上下文检查）。仅合成数据和本地测试；`DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED=false`，不接生产和真实数据。命令、写入、审计及影响分析由独立命令 ADR 定义，本文不授权实现或部署。

## 决策与现状

1. 保留现有 `POST /api/permissions/check`：JWT `authenticate`，请求 `{ permission, userId? }`；省略目标为本人，查询他人需调用者 DB `isAdmin`，结果 `{ userId, permission, allowed }`。它调用 `userHasPermission`，并保留既有缺表降级、错误和 HTTP 行为（`packages/core-backend/src/routes/permissions.ts:94`）。这是 **RBAC service 预检**，不改成业务路由检查；调用者迁移到新版本由 UI 显式选择。`userHasPermission` 的 direct / role 查询是精确 code，只有 legacy `users.permissions` 支持资源和全局 wildcard，且先检查目标 code 的 namespace admission（`packages/core-backend/src/rbac/service.ts:50`）。
2. 新增版本化只读业务判定 `POST /api/permissions/v2/business-check`；以服务端注册的 route policy 为单位，返回该 guard 层快照。提取可注入查询执行器的共享判定实现，使**实际业务 guard 与检查器**消费同一 policy；不复制另一套匹配器。逐条注册 route + HTTP method、精确有序 code 列表、mode、认证方式和 guard 层边界，变更注册必须由真实路由差分测试保护；没有可证明覆盖的 policy 返回 `unknown`。响应只是该层结果，不承诺完整 handler 返回 200：handler 还可能有 admission、资源、业务状态等检查。
3. App Center 可见性是另一套代数：`resource:admin` 可涵盖其他动作，`write` 可涵盖 `read`（`packages/core-backend/src/auth/permission-match.ts:43`）。不将其代数接入业务 guard 或把入口可见性等同业务授权。

## P1：合约与 guard 一致性

请求示例（仅表示形状，`policyId` 必须对应实现时注册的真实路由）：

```json
{
  "subject": { "kind": "self" },
  "policyId": "registered-route-policy-id",
  "mode": "any",
  "permissions": ["example:read", "example:write"],
  "resource": { "kind": "sheet", "baseId": "base-id", "sheetId": "sheet-id" }
}
```

`subject` 也可为 `{ "kind": "target", "userId": "user-id" }`；`resource` 可省略，P1 不把资源存在与否当成 code 授权。`mode` 为 `single | any | all`；single 恰好一个 code，any/all 保留注册表中原始顺序及空数组。客户端提供的 mode 和 codes 必须与服务端 `policyId` 的精确登记一致（包括顺序和重复项），不同则 400；字符串、数量、长度均有上限，拒绝无效 code。没有可注册的动态 policy 时用 `unknown`，不能让客户端自选匹配器制造授权结论。

```json
{
  "policyId": "registered-route-policy-id",
  "mode": "any",
  "result": "allow",
  "layers": [{ "layer": "business_guard", "result": "allow" }],
  "evaluatedAt": "2026-11-17T00:00:00Z",
  "semantics": "guard_snapshot"
}
```

`result` 和每层 `result` 为 `allow | deny | unknown`；`layers` 使用固定、有序的公开层名，省略内部 grant、用户状态细节、资源值和规则。认证失败 401，调用者不具备检查他人的权限 403，格式错误 400；未注册、不支持、目标不可用、缺表、超时和不可判定统一为不泄露存在性的 `unknown`（无需区分缺失与禁止）；DB 故障可用统一 503 且不包含对象详情，绝不映射 allow。响应不作为后续提交的授权凭证，实际请求必须重新执行 guard 和业务检查。

共享实现须逐 profile 保持原来的**分支及短路顺序**，不能把 all 实现为逐项调用 single：

- `requestHasPermission`：先 request admin，再 resolved permissions（含 `*:*` / `resource:*`）与每个目标 code 的 admission，再受 `RBAC_TOKEN_TRUST` 控制的 token claims 与 admission，再 DB `isAdmin`，最后 `userHasPermission`（`packages/core-backend/src/rbac/rbac.ts:52`）。任何被访问的 lookup 出错按原 guard 失败，已短路则不执行后续 lookup。
- `rbacGuardAny`：request admin；依序扫描 resolved，再扫描受信 token permissions，然后 DB admin，最后逐 code 调 `userHasPermission`，首个命中停止（`packages/core-backend/src/rbac/rbac.ts:124`）。即使空数组，DB admin 仍可通过，否则拒绝。
- `rbacGuardAll`：request admin；完整 resolved 分支、完整 token 分支、DB admin、最后 `listUserPermissions` 的 `permissionCodes.every(code => userPerms.includes(code))`，此 fallback 是精确包含，不能逐项 wildcard 匹配，也不能混合不同分支凑齐（`packages/core-backend/src/rbac/rbac.ts:192`）。空数组对有身份的请求在 resolved 分支通过。不得为了统一而改变这些语义或扩大业务 guard。

本人 JWT 检查使用与实际路由同一 JWT 认证后 request 上下文和同一 policy，不能仅凭 DB 重建后声称同一 JWT 结果。新接口首先严格核实调用者身份、凭证及用户存在、未删除/清除、`is_active=true`、已激活；状态解析按 `packages/core-backend/src/auth/user-activation.ts:73`，缺失或非法 fail closed。API token 仅在具体 policy 和端点明确登记支持时接受：验证 token、创建者身份及有效状态、scope、base/sheet 限制，与对应业务路由的 token gate 相同；不支持时拒绝，不能把 token 当 JWT 或越权推断。跨用户查询只允许 JWT 且经独立的当前平台管理授权，检查调用者和目标不相互替代。

目标用户严格通过事务内 DB 构造：校验存在、未删除/清除、active 和 activated，读取 role、直接及继承权限、legacy 和 admission；不调用有开发回退的 `AuthService` 查人（`packages/core-backend/src/auth/AuthService.ts:593`），不伪造任意 token claims。通配符命中时 admission 必须针对**被请求的具体 namespace/code**，不能仅对 `*:*` 做过滤后推导通行。目标是 DB 身份模拟而不是该用户未来任意 JWT；若某分支取决于无法重建的 token claims、tenant 或凭证 scope，返回 `unknown`，不能声称与其实际 token 同一。

调用者策略逐项明确：本人检查需有效当前认证；v2 代查、直接例外、模板与历史撤权要求有效数据库 RBAC admin membership，raw-only `users.role=admin` 不足；既有 admin-users 的 role/admission 管理保留其 raw-or-RBAC 平台身份与独立委派策略，不用检查器统一收窄或扩大。组合写动作由独立命令 ADR 逐项求交。本检查结果、任意 claim 均不能替代写事务中的实时 authority。测试须用 raw-only actor 在 v2 代查和 direct 写入口得到 403，并保留旧角色/准入管理的正对照。

现有 `packages/core-backend/tests/integration/permission-lifecycle-realdb.test.ts:805` 特意展示 admission 后 `stock-prep:*` 的预检和 RBAC probe 可通过，而真实 business 仍为 403；保留此差异和断言，不靠删除或改预期达成绿色。实施时记录实际 endpoint、各层含义，并对同一 JWT 发真实 HTTP 请求逐层差分。

## P2：只读上下文

在上述请求中加入资源时，只有登记支持的多维表 policy 才增加上下文层；仅登记经过真实路由验证的动作与字段/视图/记录能力。另允许 `resource-policy`，不要求虚构静态 code：真实多维表读取路由可以仅凭 sheet grant 通过，没有静态 RBAC 层时省略 `business_guard`，不使用假 `all: []` 或捏造 `multitable:read`。最小实际支持表读取、视图读取、字段可见性和指定记录读取对应的现有路由；在注册表逐一列 HTTP method、路径及完整必要层。聚合规则为：任一必要层明确 deny 则 deny；无 deny 但任一必要层 unknown 则 unknown；所有必要层均 allow 才允许。组织权限页面只提供检查及经过授权的深链；资源 ACL 编辑继续在多维表工作台。业务写 guard 未覆盖或仍需额外领域判断的动作显示 `unknown`，不以 capability 布尔值代替写入许可。

验收必须包含没有全局 code、仅有 sheet grant 的目标：真实读取与检查器均允许；删除表、跨表字段或记录则拒绝或不可判定。未获调用者可见性的对象和不存在对象返回整份同形响应。任意 code 仍可用 v1 预检，但 UI 标明“预检，缺少业务上下文”；v2 unknown 不得自动回退 v1 并显示允许。现有生命周期用例的三条真实证据分别为旧 `/api/permissions/check` allow、测试 read-probe 200 和真实业务 preflight 403（`permission-lifecycle-realdb.test.ts:817-826`），不能混为同一层。

对 caller 和 target 分别构建自己的 access（包括各自 member-group、role、tenant）；首先独立检查 caller 对该资源的可见性，再计算目标，任何不存在、跨边界、caller 不可见或不可用都统一 `unknown`，响应不得成为数据存在性探针。只暴露稳定层 `business_guard`、`resource_visibility`、`resource_context` 的 allow/deny/unknown，不暴露记录值、条件规则、原始 grants、成员列表或内部错误。对已授权检查的可见资源，目标明确被拒绝才可返回 deny；无法安全确定则 unknown。

在同一受限只读 `REPEATABLE READ` 事务内做严格 schema 前置检查、设置本地 statement timeout、数量/时间预算并绑定所有查询；错误或超时回滚且 unknown，不能吞错变 allow。`loadSheetPermissionScopeMap` 对缺表返回空 Map（`packages/core-backend/src/multitable/permission-service.ts:771`），严格 row flag helper 对缺表/缺列也可视为关闭（同文件 `:1048`），因此 schema 前置检查必须涵盖实际启用路径所需 ACL、flag、规则及关系表和列；缺失或不可验证即 unknown，不能依赖这些降级值证明允许。不得调用会修复或写入的读 handler，不新增 `base_members` 授权表。

读取复用 `multitable/access.ts:66` 与 `permission-service.ts:1796` 的查询及纯派生助手，在可注入事务 executor 上为目标提供其自身 access，覆盖 sheet 授权优先级（直接、成员组、角色）、base/read、field/view/record scope、行创建者及启用的行拒绝/条件规则；规则按现有 flag 的开关及投影逻辑处理。必须先确认 live base、live sheet 和父子关系，field/view/record 确实属于指定 live sheet，不能接受跨 base/sheet 拼接。特别是 `resolveSheetCapabilitiesForAccess` 返回单独 `sheetLiveness`，删除 sheet 的 capability 仍可能为 true（`permission-service.ts:1836`），必须独立验证 liveness。严格执行 approval projection 的参与者/逐行屏障、elearning tenant 限制、stock-preparation overview/project schema clamp、grid export closure（同文件 `:1864`），及相应 token 限界；不能通过 admin 快捷路径绕过目标路由实际限制。需要记录值才能计算条件规则时仅在服务端内存使用，绝不返回。未实现某条实际资源 guard 时返回 unknown。

## 实施顺序与验收

1. 先固定 policy 登记及旧端点契约，提取共享 guard 实现并保持现有调用点与顺序；再接 v2 本人和目标检查，最后实现 P2 只读适配。每步都先证明现有路由未扩大；不得把 permission-match 引入业务匹配。权限命令、授权变更、审计和影响评估以独立命令 ADR 为准。
2. 真实 PostgreSQL + JWT + HTTP 的差分测试，以同一凭证对实际受保护路由和 v2 对应**guard 层**比较 single/any/all：空数组、顺序、短路和被访问 lookup 出错；DB admin、request/claimed admin、token trust 开关、exact、资源/global wildcard、direct/role/legacy、admission 开关、混合分支、激活/停用/删除；证明 all fallback 仍是精确 every。对 API token 验证凭证、撤销、scope 和资源边界；不支持的 policy 明确拒绝。用有业务附加限制的真实路由保留上述 preflight/probe/business 差异，不能只测 mock 或简单 200。
3. P2 真库 HTTP 覆盖删除 base/sheet、跨 base/sheet field/view/record、每个 target 的 group 和 tenant、隐藏资源无存在性区分、行规则及 flag、两类 projection、备料 clamp、缺 ACL 表/列、超时和查询异常、只读事务及重复调用无副作用；让实际权限、归属、规则或 flag 发生 mutation 后证明结果随之改变，且业务写入仍重新授权。对 schema 缺失做反向试验，证明不会因 loader 降级产生 allow。只使用合成 fixture，不向证据输出真实数据或凭据。
