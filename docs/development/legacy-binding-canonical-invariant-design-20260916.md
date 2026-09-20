# 可回退 legacy Binding 改指向必须同写 connectionId(MIN-PR2-i / PERM-05)

- 日期:2026-09-16
- 基线:`origin/main` = `38caaf17bfc8eeca23e23f6dfe796683d35ab525`
- 范围:`plugins/plugin-integration-core/lib/external-systems.cjs` 一个守卫函数 + 一处调用 + 一处标记退役
- 不改:`lib/http-routes.cjs`、`package.json`、`.github/`、stock-prep 任何文件

## 1. 规则原文

`docs/integration-consolidation-minimal-plan-20260901.md:214`(§5 PR-2 实施要求),原文照抄:

> 已标记可回退的 legacy Binding 若修改 `config.dataSourceId`,必须在同一次写入中提供 `connectionId` 并转为 canonical;不得允许旧指针在 legacy 状态下静默改指向。

## 2. 改之前实际会发生什么(实读,非推测)

`upsertExternalSystem` 更新既有行时:

- `requestedConnectionId`(`lib/external-systems.cjs:494-530`)在 `normalized.connectionId === undefined`
  时直接继承 `existing.connection_id`,不看 `config.dataSourceId` 有没有变;
- `baseRow`(:704)把 `legacy_connection_fallback_eligible` 原样抄过去;
- canonical 分支(:744)的进入条件是 `connectionId !== null`。

于是回滚形态的行——`connection_id IS NULL` + 标记 TRUE,即切换迁移
(`packages/core-backend/src/db/migrations/zzzz20260902120000_add_integration_connection_binding.ts`)
回填过、之后在回滚窗口里被置空 canonical id 的行(该迁移的幂等条款原话:"a later rollback that nulls
connection_id is not undone by replaying this migration";`__tests__/external-systems.test.cjs:1376-1380`
的既有夹具正是这个形态)——
接受一个全新的 `config.dataSourceId`、保留标记、整个 canonical 分支被跳过,之后继续走
`connection-resolver.cjs` 的 `resolveLegacy`——指向的是与切换记录不同的连接,没有任何 canonical 证明,
库里也没有任何痕迹说明这个 Binding 挪过位置。

基线上的内存探针输出(改动前):

```
BEFORE  {"pointer":"ds-1","connection_id":null,"legacy":true}
UPSERT   RESOLVED (no refusal)
AFTER   {"pointer":"ds-2","connection_id":null,"legacy":true}
```

迁移回填的另一种可回退形态(`connection_id` 已写 + 标记 TRUE,回填 SQL 两列同时写)在改前也会被拒,
但拒因是 resolver 的 `CONNECTION_BINDING_MISMATCH`(双引用不一致)——规则成立但是"顺带成立"的,
错误码指向的是"两个引用不一致",不是"你少给了 connectionId",运维看不出补救动作。

需要说明的是:改前这条路径**不是**没有 owner 校验。`resolveUpdatedConfig`(:425-442)在 payload 显式
带 `dataSourceId` 时走 `withValidatedDataSourceBinding` → `dataSourceBinder.assertReferenceable`,
新指针的 owner 必须是当前 principal。所以这个洞不是越权读别人的连接,而是**权属正确的人也能让一行悄悄
停在 legacy 态改指向**——rollback 证据与实际指向脱钩。

## 3. 为什么是拒绝,不是自动转 canonical

三条理由,按份量排序:

1. **自动转要靠猜。** 自动转意味着把 `config.dataSourceId` 当成 canonical id 写进 `connection_id`。
   切换迁移只在"服务端盖章的 `config.dataSourceOwnerId` 等于 `data_sources.owner_id`"时才敢做这个推断
   (迁移文件 UPDATE 的 WHERE 里写死了这个等式);写入口没有比迁移更强的证据,不该做迁移不敢做的推断。
2. **自动转不可逆,而且是调用方没要求的写。** `requestedConnectionId`(:507-513)明确禁止事后清空
   `connectionId`("SQL read-only bindings cannot clear their canonical connectionId")。一次改名/改
   object 的编辑顺手把行转成 canonical,调用方既没请求也回不去。
3. **拒绝把选择权留给运维,且代价极低。** 补救动作就是同一次写入带上 `connectionId`,前端选源面板本来
   就持有这个 id(它现在以 `config.dataSourceId` 的兼容别名提交)。

## 4. 实现(file:line 以本分支为准)

- `plugins/plugin-integration-core/lib/external-systems.cjs:609-668`
  新增 `assertLegacyBindingRepointCarriesCanonicalConnection(existing, normalized)`。
  触发条件(五条全满足才抛):
  1. `normalized.kind === 'data-source:sql-readonly'`;
  2. 既有行 `legacy_connection_fallback_eligible === true`;
  3. 本次写入**没有**显式 `connectionId`;
  4. payload 的 `config` 自带 `dataSourceId` 键且 trim 后非空;
  5. 该值与库里存的 `config.dataSourceId`(trim 后,可能为空串)不同。
  抛 `ExternalSystemValidationError`,`details = { field: 'connectionId', code:
  'LEGACY_BINDING_DATASOURCE_CHANGE_REQUIRES_CONNECTION_ID' }`,消息与 details 都不回显任何指针、行 id、
  租户或名称(values-free)。
- `plugins/plugin-integration-core/lib/external-systems.cjs:729` 调用点。
  **位置是刻意的:在 `resolveUpdatedConfig` 之后**——owner 先判。非 owner 仍然拿到 binder 统一的
  "not found",不会通过这个新错误码反推出"这行存在且是 legacy"。两者都是纯校验,拒绝时零写入。
- `plugins/plugin-integration-core/lib/external-systems.cjs:730-743` 规则的另一半:既有行标记为 TRUE 且
  本次显式带了 `connectionId` 时,把 `updateRow.legacy_connection_fallback_eligible` 置 false。这次写入
  随后仍然经过 `validateCanonicalConnectionBinding`(:745-753,`reassertsConnection` 因
  `normalized.connectionId !== undefined` 恒为真),也就是说标记退役发生在 canonical 证明**之前决定、之后
  生效**:证明失败就整个写入抛错,标记不会掉。
- `plugins/plugin-integration-core/lib/external-systems.cjs:760` 旧指针清理的条件由
  `existing.legacy_connection_fallback_eligible !== true` 改成
  `updateRow.legacy_connection_fallback_eligible !== true`。这样"标记 FALSE"与"config 里没有 legacy
  指针"这条既有形态不变式在转换写入里继续成立,不会新造出"标记 FALSE + 仍带旧指针"这种两个 resolver
  分支都没针对写过的形态。

方向性:标记 TRUE→FALSE 只会让该行**失去** `resolveLegacy` 资格(`connection-resolver.cjs:204-214`),
是收紧;守卫本身只新增拒绝,不放宽任何既有作用域;读取面、租户隔离、owner 校验一律没碰。

## 5. 刻意不覆盖的范围

| 情形 | 行为 | 理由 |
| --- | --- | --- |
| 新建(INSERT) | 不变 | 没有"旧指针"可挪;新行本来就 canonical-only(`:791-812`) |
| 非 sql-readonly kind(`data-source:sql-write-gated`、http、erp:*) | 不变 | 它们根本不带 `connection_id`,且 `requestedConnectionId:495-503` 对这些 kind **直接拒绝** `connectionId` 字段——守卫若不分 kind,这些行的指针会被永久冻死且无补救手段 |
| 标记为 FALSE 的 canonical 行 | 不变 | 仍由 resolver 的 `CONNECTION_BINDING_MISMATCH` 拒 |
| 重复提交同一个指针(选源面板每次改名都这么发) | 不变 | 不是改指向 |
| 显式清空(`{ dataSourceId: null }`) | 不变,仍允许 | 这是"取消指向"不是"改指向":清空后 `resolveLegacy` 抛 `CONNECTION_LEGACY_POINTER_REQUIRED`,指到"无",不会指到别处。它可能打开的"先清后设"两步绕过被同一个守卫关上了——库里存的是空串,与要写入的非空值仍然不同,第二步照样拒 |

## 6. HTTP 映射

不需要改 `lib/http-routes.cjs`(该文件是 `runtimeFiles` 数字 pin,历来是冲突源)。
`inferHttpStatus`(`lib/http-routes.cjs:850-878`)按错误类名映射:`/Validation|Transform|Watermark|DeadLetter/`
→ **400**。新错误是 `ExternalSystemValidationError`,类名含 `Validation`,因此
`PUT/POST /external-systems` 这条路径上运维看到的是 400 + `code:
LEGACY_BINDING_DATASOURCE_CHANGE_REQUIRES_CONNECTION_ID`。
这是"请求缺字段"而不是"状态冲突",所以取 400 而非 409(409 留给
`ExternalSystemConflictError`,名字含 `Conflict`,如 `EXTERNAL_SYSTEM_SCOPE_MISMATCH`)。
`ExternalSystemValidationError` 不带 `.status` 字段,`sendError` 没有可优先采用的值,走的就是上面的类名映射。

## 7. 与 #5452 / #5449 的关系

- **#5452(已合)"feat(integration): unify SQL connection bindings"** = 最小方案 PR-1 的落地:建
  `integration_external_systems.connection_id` 与 `legacy_connection_fallback_eligible` 两列、写回填
  迁移、加 `connection-resolver.cjs` 的 canonical/legacy 双读。它把"可回退"做成了一个**服务端持有的持久
  标记**,但没有规定这个标记在后续写入里怎么退役——本次改动补的正是这半条:标记不再是只读的历史证据,
  而是有明确的、由 canonical 证明驱动的退役路径。
- **#5449(已合)"docs(integration): 最小方案两处规格澄清"** 写死了"`connection_id` 仅限
  `data-source:sql-readonly`"。本守卫的 kind 作用域直接依赖这条:正因为别的 kind 合法地没有
  `connection_id`,守卫必须放过它们,否则规则的补救动作(带上 `connectionId`)对它们不存在,等于把它们的
  指针永久冻死。这一条在测试 7 里用行为钉住,不靠读源码。
- 本 PR 只做 PR-2 实施要求里的这一条(MIN-PR2-i);`ConnectionAccessContext`、引用追踪与安全删除、
  raw `/query` 分权等其余 PR-2 条目未动。

## 8. 前置核查结果

### 8.1 文件重叠核查

`gh pr diff <n> --name-only`(经本机代理 `127.0.0.1:10808`):

| PR | 是否碰 `lib/external-systems.cjs` | 与本 PR 的公共文件 |
| --- | --- | --- |
| #5590 | 否 | `plugins/plugin-integration-core/test-chain.txt`(另有 `lib/http-routes.cjs`、`lib/pipeline-runner.cjs`、`s6a-package-provenance-pins.json`,本 PR 都没碰) |
| #5648 | 否 | 无(全在 `packages/core-backend` 与 `.github/`) |
| #5681 | 否 | 无 |

结论:三支都不碰 `external-systems.cjs`,**该文件零重叠**。唯一公共文件是 `test-chain.txt`,而它被
`.gitattributes` 标了 `merge=union` 且**不是**数字 pin 的输入(文件头注释与
`scripts/test-chain.cjs` 的语义守卫),两个 PR 各加一行会自动合并。本 PR 仍按"最局部"执行:
一个守卫函数 + 一处调用 + 一处条件改写,`test-chain.txt` 只加一行,`package.json` 一个字节没动。

### 8.2 pin 集核查

- `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 里
  `external-systems` / `externalSystems` 出现次数 = **0**;`.gitattributes` 里出现次数 = **0**。
- `git check-attr eol` 逐个核对本 PR 的四个路径:
  - `lib/external-systems.cjs` → `eol: unspecified`(不在 pin 集)
  - `__tests__/external-systems.test.cjs` → `eol: unspecified`(不在 pin 集)
  - `__tests__/legacy-binding-canonical-invariant.test.cjs` → `eol: unspecified`(不在 pin 集)
  - `plugins/plugin-integration-core/test-chain.txt` → `eol: lf`,但按文件头与 `.gitattributes` 的说明
    它**故意不是 digest pin 的输入**,改它不触发重算
- 全仓 `eol=lf` 文件共 69 个,pin 清单共 40 条(migrations 6 / modules 6 / externalModules 7 /
  dependencies 2 / runtimeFiles 9 / evidenceFiles 10)。
- 结论:**本 PR 未改任何被 pin 的文件,无需重打 pin**。经验证据见验证文档 §4:
  `sealed-export-package-provenance.test.cjs`(逐文件 sha256 比对整份冻结清单)与
  `sealed-export-s6a-product-runtime.test.cjs` 改动后仍全绿。

## 9. 已知未覆盖 / 待裁决

- 本守卫只管**写入口**。库里如果已经存在被静默改过指向的行(改动前发生的),本 PR 不做数据修复,也不做
  扫描报告;是否需要一次性巡检由 owner 决定。
- "标记退役"只发生在显式带 `connectionId` 的写入。带了 `connectionId` 但指针没变的写入同样会退役标记
  (那仍然是一次 canonical 证明)。如果希望"仅在指针变化时才退役",需要 owner 明确,这会让标记的语义
  依赖于指针是否变化,反而更难解释。
- HTTP 层没有新增专门的路由测试:本层改动的 400 映射完全由既有 `inferHttpStatus` 的类名规则决定,新增
  路由用例会引入 `lib/http-routes.cjs` 相关的 pin/冲突风险,收益不抵风险。
