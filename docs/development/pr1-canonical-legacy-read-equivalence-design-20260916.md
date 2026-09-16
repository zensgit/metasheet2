# PR-1 canonical/legacy 读取路径等价性钉桩测试 — 设计（2026-09-16）

- 任务：W5-M / 缺口审计矩阵 CR-08。
- 范围：纯新增测试文件 + `test-chain.txt` 一行；零源码改动。
- 新增测试：`plugins/plugin-integration-core/__tests__/pr1-canonical-legacy-read-equivalence.test.cjs`
- 基线：`main@38caaf17b`（本任务的 worktree HEAD）。

## 1. 验收原文出处

`docs/integration-consolidation-minimal-plan-20260901.md` §5「PR-1 验收」逐字：

> - 旧 Pipeline 不改 ID 即可继续运行。
> - **新旧读取路径的 schema、对象列表和只读查询结果一致。**
> - 两个 Binding 可以复用一个 Connection，且不复制 secret。
> - 仅对迁移回填且仍保留 `config.dataSourceId` 的旧 Binding，将 `connection_id` 置空后可以回退 legacy 路径。
> - 新建 `data-source:sql-readonly` 类 Binding 的 `connection_id` 不可为空；缺失时返回配置错误。
> - tenant 不一致或旧记录 tenant 未确认时，不得扩大为 workspace/service 使用。

本文件与测试只钉第二条（加粗）。其余四条已有覆盖（见下）或不在本任务范围：
- 第一条（Pipeline ID 不变）与本测试无关，不涉及。
- 第三条（两个 Binding 复用一个 Connection、不复制 secret）已被
  `__tests__/external-systems.test.cjs`（`bound`/`decryptCallsBeforeCanonicalLoad` 附近断言）覆盖。
- 第四条（迁移回填行清空 `connection_id` 后回退 legacy）已被
  `__tests__/connection-resolver.test.cjs` 的 `legacyResolver`/`legacyBase` 用例族覆盖。
- 第五、六条（新建 Binding 必须 `connection_id`、tenant 不一致 fail closed）已被
  `__tests__/connection-resolver.test.cjs` 的 `CONNECTION_ID_REQUIRED`/`CONNECTION_TENANT_MISMATCH`
  用例覆盖。

## 2. 既有覆盖核查（先查后写，未发现重复）

在 `plugins/plugin-integration-core/__tests__/` 下 grep `legacy_connection_fallback_eligible`
与 `connectionId`，命中的测试文件逐一核对：

- `connection-resolver.test.cjs`（317 行）——只对 `createConnectionResolver` 的
  `resolve()`/`resolveSealedSqlServer()` 做策略级单元测试（tenant/type/legacy 标记/owner 校验等
  分支），每个用例独立构造一个 binding，从未让「同一个连接」的 canonical 行与 legacy 行在同一断言
  里被解析并逐字段比较，也从未把解析结果喂给真实 adapter 调用 `listObjects/getSchema/read`。
- `external-systems.test.cjs`（1682 行）——`getExternalSystemForAdapter` 在 `canonicalAdapterSystem`
  处只对**单个**canonical binding 做了取值断言（`config.dataSourceId`、`credentials` 等），同一测试
  里没有配对的 legacy binding 读同一个连接，也没有在断言之后创建 adapter 并跑三条只读调用。
- `integration-connection-binding-migration.test.cjs`（239 行）——纯文本断言 Kysely migration 的
  DDL 形状（列、约束、回填 UPDATE 语句），不执行任何运行时读取。

结论：三个文件都不构成「新旧路径读取结果一致」的钉桩测试，本任务因此新增独立文件，而不是扩展其中
任何一个——扩展会把「策略单元测试」「单路径 adapter 取值」「纯 DDL 文本」三种不同性质的断言硬塞进
不属于它们的文件，且这三个文件各自的现有断言粒度（分支级/单路径/纯文本）都不适合承载「双路径端到端
diff」这个新维度。

## 3. 测试覆盖的真实代码路径

新测试驱动的是生产代码中「读」这条完整链路，而不是自造的简化逻辑：

```
external-systems.cjs#getExternalSystemForAdapter (双读分派)
  -> connection-resolver.cjs#resolve (canonical/legacy 分支)
  -> contracts.cjs#createAdapterRegistry().createAdapter
  -> adapters/data-source-sql-readonly-source-adapter.cjs
       .listObjects() / .getSchema() / .read()
  -> 宿主 context.api.dataSources facade（假件）
```

关键行号（实读，`main@38caaf17b`）：
- `plugins/plugin-integration-core/lib/external-systems.cjs:829-869`
  （`getExternalSystemForAdapter`，SQL 只读 kind 分支调用 `connectionResolver.resolve`）
- `plugins/plugin-integration-core/lib/connection-resolver.cjs:166-267`
  （`resolveCanonical` / `resolveLegacy`，两者都把 host facade 返回的 `registration.id` 写进
  `binding.config.dataSourceId`）
- `plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:305-320,557-678`
  （`getDataSourcesApi` 要求 `context.api.dataSources` 同时暴露 `test/getSchema/getTableInfo/select`；
  `listObjects/getSchema/read` 三个只读方法的实现）
- `plugins/plugin-integration-core/index.cjs:305-323`
  （生产环境里 `context.api.dataSources` 是**同一个对象**，既是 resolver 的
  `resolveConnectionRegistration` facade，也是 adapter 的读执行 facade——这是本测试把两者做成
  同一个假件对象的依据，而不是拆成两个互相不知情的 mock）

## 4. 夹具形状与为什么这样设计

### 4.1 假「host DataSourceManager」是单一对象

`createFakeDataSourceManager()` 同时实现 `resolveConnectionRegistration` 与
`test/getSchema/getTableInfo/select`，键是 `dataSourceId`（`ds_alpha`/`ds_beta`）。这样设计是因为
生产环境正是「一个 facade 对象两种用途」（见上一节 index.cjs 引用），拆成两个 mock 会让测试悄悄放宽
生产不变量——例如 resolver 解析出的 `dataSourceId` 与 adapter 实际读取的 `dataSourceId` 本可能对不
上而测试却发现不了。

### 4.2 两个 Binding 行指向同一个连接

- `sys_canonical_alpha`：`connection_id = 'ds_alpha'`，`config = { schema: 'dbo' }`（新形态，
  不含 `dataSourceId`）。
- `sys_legacy_alpha`：`connection_id = null`，`legacy_connection_fallback_eligible = true`，
  `config = { dataSourceId: 'ds_alpha', schema: 'dbo' }`，`created_at` 早于新建行（迁移回填形状）。

两行读取时用**完全相同**的 `READ_CONTEXT`（`tenantId/workspaceId/principal/runAs`），确保任何差异
只能来自 canonical vs legacy 两条解析分支本身，而不是上下文不同。

`resolveLegacy` 要求 legacy 指针指向的 connection `scopeKind === 'legacy_private'`（否则
`CONNECTION_LEGACY_FALLBACK_DENIED`，见 connection-resolver.cjs:251-257），而 `resolveCanonical`
对 scopeKind 本身没有强制要求（只要 tenant 匹配）。因此假连接 `ds_alpha`/`ds_beta` 的
`registration.scopeKind` 统一取 `legacy_private`——这是唯一能让「同一个连接」被两条路径都合法解析
通过的取值，也对应验收原文「仅对迁移回填且仍保留 `config.dataSourceId` 的旧 Binding」描述的真实迁移
场景（原 owner-only 连接）。

### 4.3 断言维度对应验收原文的三个名词

- 「schema」→ `adapter.getSchema({ object: 'dbo.items' })` 的返回值逐字段 `deepEqual`。
- 「对象列表」→ `adapter.listObjects()` 的返回值逐字段 `deepEqual`。
- 「只读查询结果」→ `adapter.read({ object, limit })` 的返回值（含 `records`/`nextCursor`/
  `done`/`metadata`）逐字段 `deepEqual`。
- 额外加了「解析出的连接引用（dataSourceId/tenant/scope）逐字段相等」——直接比较两次
  `resolveConnectionRegistration` 调用各自返回的 registration 对象（工厂每次返回新对象，不是同一个
  引用，所以 `deepEqual` 真正比较的是内容而不是引用相等），以及 `adapter 收到的 config 相等`——
  直接 `deepEqual(canonicalAlpha.config, legacyAlpha.config)`。

### 4.4 为什么必须有反向控制（reverse control）

如果测试只对同一个连接的两条路径做「结果相等」断言，一个把 `dataSourceId` 参数完全丢弃、对任何输入
都返回同一份罐头数据的假件（或者未来一次把 adapter 实现改坏成「忽略 config.dataSourceId」的回归）
会让上面所有 `deepEqual` 断言全部继续通过——因为两条路径readonly 反正读的是同一份常量数据，测试测的
其实是「两次调用返回同一个常量」而不是「两条路径解析到同一个真实连接」。

因此新增 `ds_beta`：与 `ds_alpha` 的 schema（列数）、views、行内容全部不同。测试对 `ds_beta` 重复
一遍「canonical vs legacy 一致」之后，额外断言 `ds_alpha` 的结果与 `ds_beta` 的结果在 `listObjects`
/`getSchema`/`read` 三个维度上都 `notDeepEqual`。这证明：
1. 假件确实按 `dataSourceId` 分流数据，不是忽略输入的常量返回；
2. 前面「canonical == legacy」的等价性,是因为两条路径解析到了同一个真实连接 `ds_alpha`/`ds_beta`,
   而不是因为测试夹具本身无法产生差异。

## 5. 与源码的边界

本测试文件不修改：
- `plugins/plugin-integration-core/lib/connection-resolver.cjs`
- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs`
- `plugins/plugin-integration-core/lib/contracts.cjs`
- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/package.json`（未触碰，未触发 pin 重算）

变更范围只有：
- 新文件 `__tests__/pr1-canonical-legacy-read-equivalence.test.cjs`
- `test-chain.txt` 追加一行
- 本设计文档 + 对应验证文档
