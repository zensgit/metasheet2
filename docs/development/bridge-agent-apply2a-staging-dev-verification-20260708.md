# BA-APPLY-2a — Bridge Agent 变更清单:后端审批门 + 审计 + values-free 暂存 · 开发/验证报告 — 2026-07-08

> Design-lock: `docs/development/bridge-agent-controlled-apply-design-lock-20260708.md`(#3876,已在
> main）§2 形态 B 后端受控通道 + §1 三条原则 + §4 硬锁。上位锁:
> `bridge-agent-admin-page-design-lock-20260707.md`(BA-UI-0 RATIFIED）。前置:BA-APPLY-1
> (`bridge-agent-apply1-export-dev-verification-20260708.md`,机读实施清单导出)已落 main。Demand
> anchor:#3746(保持 OPEN)。Owner 2026-07-08 opt-in 本片为 BA-APPLY-2。
>
> **本片严格是「后端受控通道」的一半:审批门 + 审计 + values-free 清单暂存。后端永不写 Bridge
> Agent。** 见 §2「形态 B blocker」——设计锁 §2 形态 B 的字面「经后端持有的凭据上下文写 Agent 的只读
> config」在当前实现中**不可能**,需要 owner 另一次决策 + 锁修订(2b)。

## 1. 范围与做法(vs design-lock §1/§2/§4 逐条)

| lock 条款 | 实现 |
| --- | --- |
| §1 原则 1:只扩只读暴露面,永不加写路径 | 清单操作枚举闭集 `add_readonly_object` / `add_readonly_field`;写/删/可写化操作被 contract 拒绝。本片零 apply、零 Agent 写。 |
| §1 原则 2:前端产建议、后端/受控通道落地 | 后端提供受控通道:save 草稿 → owner/admin 审批门(`integration:write`)→ 只有 approved 清单可被 apply 消费者取。**清单的实际应用仍是运维/脚本手工动作**(form A handoff),后端只暂存 + 审批 + 审计。 |
| §1 原则 3:凭据后端持有、apply 证据 values-free | 本表零凭据/host/systemId 列;审计只含 actor / 时间戳 / 粗粒度 action / 版本号或 {from,to} 状态枚举——绝不含 operations/objectName/fieldKeys/op。 |
| §2 形态 B:后端受控 config-apply 端点(只读 allowlist 白名单 + 审批 + 审计) | **部分落地 + 记录 blocker**:审批门 + 白名单校验 + 审计全部落地;但「写 Agent 只读 config」这一步**不存在**(见 §2 blocker),故本片是「受控通道的暂存 + 审批 + 审计侧」,不含任何 Agent 写。 |
| §4 硬锁:只读不变式,拒绝改可写/删除/raw SQL/host 放宽/凭据前端化 | contract 拒绝非白名单 op;表结构无 credential/host/systemId/apply 列;零 raw SQL;save/approve/retire 走 `integration:write`;GET 走 approved-only 审批门。 |

## 2. 形态 B blocker(交给 owner 的决策点)

设计锁 §2 形态 B 写道:「经后端持有的凭据上下文**写 Agent 的只读 config**(非业务数据)」。

**这一步在当前系统里不可能实现**,已核实(`scripts/ops/bridge-agent-readonly.ps1` +
`plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs`):Bridge Agent 只
暴露 `GET /health`、`GET /objects`、`GET /schema/<object>`、`POST /query/<object>`——**零 config-write /
reload 能力**(无 `Set-Content`/`Out-File`/reload endpoint)。Agent 的安全模型是「never writes」。

给 Agent 增加一个 config-write/reload endpoint 会**扩张 Agent 的安全模型**(从「只读、从不写」变成
「接受受控写」),这需要 **owner 另一次决策 + 一次锁修订(BA-APPLY-2b)**,不在本片授权范围内。

**因此本片(2a)只建后端受控通道的暂存 + 审批 + 审计侧**:一份 values-free 清单被 save(草稿)→ 审批
→ approved 后可被取用;由运维/脚本(form A handoff,现在多了审批 + 审计)在本机按 runbook 应用。后端
永不触达 Agent。2b(后端真正写 Agent config)= owner 决策 + 锁修订之后的独立 rung。

## 3. 契约(`lib/bridge-agent-change-checklist-contract.cjs`,纯函数)

`validateBridgeAgentChangeChecklist(input) → { valid:true, normalized } | { valid:false, errors }`

- **输入形状**:精确 `{ schemaVersion:1, operations:[{ op, objectName, fieldKeys }] }`——即 BA-APPLY-1
  `buildImplementationChecklist` 的**逐字节输出**(`apps/web/src/services/integration/bridgeAgentConfigCheck.ts`
  的 `BridgeAgentImplementationChecklist`)。契约 spec 有一条 round-trip 测试断言这份精确产物被接受。
- **op 白名单 EXACT**:`ALLOWED_OPS = ['add_readonly_object','add_readonly_field']`(frozen)。任何
  写/删/可写化 op(`delete_object`/`make_writable`/`write_object`/…)→ `BRIDGE_AGENT_CHECKLIST_OP_NOT_ALLOWED`,
  `field='operations[N].op'`。
- **标识符门(values-free)**:objectName + 每个 fieldKey 过 `SAFE_IDENTIFIER_PATTERN`
  `/^[A-Za-z_][A-Za-z0-9_]*$/`(≤64,镜像 `bridge-agent-readonly-adapter.cjs` 的
  `SAFE_OBJECT_NAME_PATTERN`)。含 `=;:.`/空白/host/连接串/secret 形状 → 拒绝,**从不回显**——
  错误的 `field` 永远是结构路径(`operations[0].objectName`),非提交值。
- **op↔fieldKeys 不变式**:`add_readonly_object` 必须零 fieldKey;`add_readonly_field` 必须 ≥1。
- **all-or-nothing**:比 BA-APPLY-1(UX 友好、丢弃并计数)更严——**任一** operation 非法则整份提交
  fail-closed,草稿绝不部分落地干净 + 拒绝的混合。
- **coarse-code family**:frozen `BRIDGE_AGENT_CHECKLIST_ERROR_CODES`(8 个,镜像
  `read-source-probe-contract.cjs` 的 safeErrorCode registered-set 纪律);codes 自产/确定性,egress 无
  需 clamp,frozen set 供测试断言完整性。
- **clamp**:`MAX_OPERATIONS=200`、`MAX_FIELD_KEYS_PER_OPERATION=100`。`operations:[]` 合法(BA-APPLY-1
  guided-empty 态可发)。永不 throw。

## 4. Store + 生命周期 + 审计(`lib/bridge-agent-change-checklist-store.cjs`,镜像 read-source-config-store)

- content-keyed 版本:`sha256(stable-stringify(normalized))`;相同内容 save = no-op 返回既有版本
  (reused），变更 = 家族内(家族 = tenant + workspace)下一版本。retired 内容不可被 save 静默复活
  (`content_retired` 冲突)。
- 状态生命周期 fail-closed:`draft → approved → retired`,别无其它。retire-before-approve / 双 approve /
  retired 复审 → typed Conflict。
- **审批门**:`getForApply` 只返回 `approved` 行;draft/retired → `BridgeAgentChecklistNotApprovedError`
  (coarse `{ status }`,零内容)。这是 apply 消费者(人/脚本)的唯一取用面。
- **审计 values-free**:每次 save/reuse/status_change 一条审计行,`detail` 只含 `{ version }` 或
  `{ from, to }`;actor/时间戳/粗粒度 action。store spec 断言审计文本不含 objectName/fieldKey/op 字面量
  /`operations`/`fieldKeys`。
- 23505 路由:content-key 冲突 → 复用 winner;family-version 冲突 → 有界重试(3);无关 23505 不吞。

## 5. 路由(`lib/http-routes.cjs`,镜像 read-source-config 路由)

| 路由 | 权限 | 说明 |
| --- | --- | --- |
| `POST /api/integration/bridge-agent-checklists` | `integration:write` | save 草稿(content-keyed 幂等:相同 200 reused / 新内容 201) |
| `POST /api/integration/bridge-agent-checklists/:id/approve` | `integration:write` | 审批门 |
| `POST /api/integration/bridge-agent-checklists/:id/retire` | `integration:write` | 退役 |
| `GET  /api/integration/bridge-agent-checklists/:id` | `integration:read` | **approved-only**(apply 消费者面);draft/retired → 409 fail-closed |

**刻意不加** list / audit / apply / Agent-write 路由:任务枚举精确 4 条;list/listAudit 保留为 store
方法(测试 + 未来 rung 用),不开路由,以免在安全敏感的受控通道上增加未请求的读面。**没有任何路由触达
Bridge Agent、没有 apply 路由。**

错误映射 `mapBridgeAgentChecklistError`:400 `BRIDGE_AGENT_CHECKLIST_INVALID`(contract 元组,field 恒
为结构路径)/ 404 NOT_FOUND / 409 NOT_APPROVED(coarse status)/ 409 STATUS_CONFLICT。

## 6. 零-Agent-write 证明(§4 硬锁)

新增/改动文件对 Agent-write 形状(`Set-Content` / `Out-File` / `.ps1` 调用 / `bridge-agent-readonly-adapter`
代码引用 / `createAdapter` / `getExternalSystemForAdapter` / `fetch(` / reload / `writeFile`)全仓 grep:

- `bridge-agent-change-checklist-contract.cjs`:唯一命中是**注释**引用
  `bridge-agent-readonly-adapter.cjs's SAFE_IDENTIFIER_PATTERN`(说明标识符门的出处),非代码。
- `bridge-agent-change-checklist-store.cjs` / migration 065 / 三个测试:**零命中**。
- `http-routes.cjs` 新增行:唯一命中是**注释**「…nothing here calls the Agent, writes a local config
  file, or invokes scripts/ops/bridge-agent-readonly.ps1」,非代码。

路由测试 `testBridgeAgentChecklistRoutes` 断言:整个 checklist 面 `createAdapter` 调用数 = 0、
`upsertExternalSystem` = 0、`getExternalSystemForAdapter` = 0——没有任何路由能创建 adapter 或加载外部
系统,故不可能触达/写 Agent。store 无 credential/system 依赖(`createBridgeAgentChecklistStore({ db })`)。

## 7. Mutation 证明(逐守卫)

基线:本片全部实现已提交(commit 2b442e026)后再做 mutation;每次 mutation + revert 只针对单个文件,
未用任何整仓 `checkout -- .`。所有 EXIT 码为 `node <spec>` 的真实退出码。

| # | 变体 | 预期 | 结果 |
| --- | --- | --- | --- |
| M1 | contract 里 `ALLOWED_OPS` 加入 `'delete_object'`(模拟把写/删操作偷进白名单) | op 白名单 exact 测试变红 | **RED** — contract EXIT=1(`ALLOWED_OPS is exactly the two readonly-expand ops` 断言失败,测试硬编码期望值不从源码 import)、store EXIT=1、route EXIT=1。三 spec 全 killed ✅ |
| M2 | store `getForApply` 把 `status !== 'approved'` 改为只拒 `status === 'retired'`(让 draft 也可被 apply 取) | 审批门 fail-closed 测试变红 | **RED** — store EXIT=1(`Missing expected rejection`:draft getForApply 本应抛 NotApproved)、route EXIT=1(draft GET 本应 409)。killed ✅ |
| M3 | contract `isSafeIdentifier` 改为「任意非空字符串即通过」(拆掉标识符门) | 标识符门 + SENTINEL 测试变红 | **RED** — contract EXIT=1(`object name "server=1.2.3.4;uid=sa;pwd=Secret123" must be rejected`)、store EXIT=1、route EXIT=1(SENTINEL host/secret 本应被拒且不回显)。killed ✅ |

每次 revert 后重跑对应 spec 确认 GREEN;M3 revert 后 `git diff --stat` 为空(工作树 = commit),再跑
**全链 EXIT=0**。

## 8. Values-free / SENTINEL

| 面 | 载体 | 断言 |
| --- | --- | --- |
| contract | objectName = `server=10.0.0.9;pwd=SENTINEL_S3cr3t`,fieldKeys 混入同 sentinel + 合法名 | 拒绝;`JSON.stringify(result)` 全文不含 `SENTINEL_S3cr3t` / `10.0.0.9` |
| store | objectName = `server=1.2.3.4;pwd=Secret123` | ValidationError;`JSON.stringify(error.details)` 不含 `Secret123`;两表零行 |
| store 审计 | save/approve/retire 后 | 审计文本不含 DISTINCTIVE objectName/fieldKey,也不含 `add_readonly_*`/`operations`/`fieldKeys` |
| route | objectName = `server=10.0.0.9;pwd=SENTINEL_S3cr3t`(经真实路由) | 400;`JSON.stringify(res.body)` 不含 `SENTINEL_S3cr3t` / `10.0.0.9` / `server=` |
| route | draft GET | 409 fail-closed;body 不含 `material`(内容不泄漏) |

## 9. 测试矩阵 + CI 面

| 面 | 文件 | 备注 |
| --- | --- | --- |
| contract(17 组:白名单 exact / 写删拒 / 标识符门 obj+field / op↔fieldKeys 不变式 / schemaVersion 严格 / unexpected-key coarsen ×2 / clamp / SENTINEL / round-trip BA-APPLY-1 / never-throws / empty-ok) | `__tests__/bridge-agent-change-checklist-contract.test.cjs` | 新增,已入 chain |
| store/lifecycle(10:非法拒 values-free / mint draft / content-key 幂等 / 生命周期 fail-closed + 审批门 / 每转一审计行 + values-free / retired-reuse fail-closed / scoping+notfound / 23505 路由 / content-key helper / require-transaction) | `__tests__/bridge-agent-change-checklist-store.test.cjs` | 新增,已入 chain |
| migration(结构/枚举/唯一索引/触发器/禁列断言) | `__tests__/bridge-agent-change-checklist-migration.test.cjs` | 新增,已入 chain |
| route(`testBridgeAgentChecklistRoutes`:权限门 / op 白名单 / SENTINEL / 审批门 draft+approved+retired / notfound / 生命周期 / 零-Agent-write) | `__tests__/http-routes.test.cjs`(既有,已在 chain) | ADD-ONLY;另在两个 harness 补 `bridgeAgentChecklistStore` mock(`http-routes.test.cjs` + `http-routes-plm-k3wise-poc.test.cjs`) |
| **全链** `pnpm --filter plugin-integration-core test` | `package.json` `test` 脚本 UNION(3 个新文件已追加,无 drop) | **EXIT=0**(该链不在任何 CI workflow,本地 EXIT 码验证) |

## 10. 改动清单

| 文件 | 类型 |
| --- | --- |
| `plugins/plugin-integration-core/lib/bridge-agent-change-checklist-contract.cjs` | 新增(纯 contract/validator) |
| `plugins/plugin-integration-core/lib/bridge-agent-change-checklist-store.cjs` | 新增(store + 生命周期 + 审计 + 审批门) |
| `packages/core-backend/migrations/065_create_integration_bridge_agent_checklists.sql` | 新增(两表 + 索引 + 触发器) |
| `plugins/plugin-integration-core/lib/http-routes.cjs` | 编辑(4 路由 + error mapper + requireService + import) |
| `plugins/plugin-integration-core/index.cjs` | 编辑(store 装配 + 注入 services + deactivate 清理) |
| `plugins/plugin-integration-core/__tests__/bridge-agent-change-checklist-contract.test.cjs` | 新增 |
| `plugins/plugin-integration-core/__tests__/bridge-agent-change-checklist-store.test.cjs` | 新增 |
| `plugins/plugin-integration-core/__tests__/bridge-agent-change-checklist-migration.test.cjs` | 新增 |
| `plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | 编辑(ADD-ONLY:mock + `testBridgeAgentChecklistRoutes` + main 注册) |
| `plugins/plugin-integration-core/__tests__/http-routes-plm-k3wise-poc.test.cjs` | 编辑(补 `bridgeAgentChecklistStore` mock) |
| `plugins/plugin-integration-core/package.json` | 编辑(chain UNION + 3 个 `test:*` 脚本) |
| `docs/development/bridge-agent-apply2a-staging-dev-verification-20260708.md` | 新增(本文) |

## 11. 边界外(维持冻结)

BA-APPLY-2b(后端真正写 Agent 只读 config)= **owner 决策 + 锁修订**(见 §2 blocker),未开。
BA-APPLY-3(apply 后自动复探测)未开。写业务数据 / 生产写 / K3-Save / delete-object / raw SQL /
host-allowlist 放宽 / 凭据前端化 全冻结。#3746 保持 OPEN 作 demand anchor。本片零 Agent 写、零 apply。
