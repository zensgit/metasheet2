# legacy 绑定退役只在「生效指针变化」时触发（#5783 后续）

- 日期：2026-09-20（本机时钟 01:31）
- 基线：`origin/main` = `0708051caeee1ba6c2a69487eb6359e547b7c33d`
- 范围：`plugins/plugin-integration-core/lib/external-systems.cjs`（一个纯函数 + 一处条件收窄）、
  `plugins/plugin-integration-core/__tests__/legacy-binding-canonical-invariant.test.cjs`（新增 5 组）
- 不改：`lib/http-routes.cjs`、`test-chain.txt`（该测试第 40 行早已登记）、`package.json`、
  `s6a-package-provenance-pins.json`、`.github/`、前端任何文件
- **本 PR 放松了一条既有守卫的触发条件，须单独复核**；前一版的取舍见
  `docs/development/legacy-binding-canonical-invariant-design-20260916.md` §9 第 2 条，
  那里把「仅在指针变化时才退役」明确留给 owner 裁决，本 PR 就是执行它。

## 1. 改之前实际会发生什么（实读，非推测）

`upsertExternalSystem` 的更新分支里，退役条件（改动前）是：

```
kind === 'data-source:sql-readonly'
  && existing.legacy_connection_fallback_eligible === true
  && normalized.connectionId !== undefined
  && normalized.connectionId !== null
```

它**完全不看指针有没有变化**。而前端工作台的连接编辑抽屉：

- `apps/web/src/views/IntegrationWorkbenchView.vue:2309`（编辑）与 `:2325`（复制）把草稿的
  `connectionId` 填成 `system.connectionId || config.dataSourceId` —— 也就是这一行**自己当前**的连接；
- `:2445` 在 bridge kind 下**每次保存都带** `connectionId`（`...(isDataSourceBridgeKind ? { connectionId } : {})`）；
- `lib/http-routes.cjs:4889` 的 `externalSystemsUpsert` 用 `{ ...body, principal, runAs }` 原样透传。

后果链条（对一行 rollback 形状的备料桥：`connection_id IS NULL` + 标记 TRUE + `config.dataSourceId = A`）：

1. 操作员只把名字从「A 桥」改成「A 桥（旧）」，点保存；
2. 请求带 `connectionId = A`，判据命中（非空即退役）→ 标记被置 FALSE；
3. 紧接着 `lib/external-systems.cjs:797-798`：标记不再是 TRUE，于是
   `withoutLegacyDataSourcePointer` 把 `config.dataSourceId` 删掉；
4. 一次纯改名，回滚凭证（标记 + 旧指针）**同时静默消失**，请求里没有任何东西要求过这件事。

## 2. 收窄后的判据：生效指针

新增纯函数 `effectiveLegacyBindingPointer(existing)`（`lib/external-systems.cjs:685`）：

```
connection_id（非空，去空白） ?? config.dataSourceId（非空，去空白） ?? ''
```

退役条件（`:773-779`）变成：kind + 标记 TRUE + 显式非空 `connectionId` + **`!==` 生效指针**。

「生效指针」= 这一行**今天实际被读的那个连接 id**，优先级与读侧一致：
`lib/connection-resolver.cjs` 先走 `resolveCanonical`（读 `connection_id`），
`connection_id` 为空时才走 `resolveLegacy`（读 `config.dataSourceId`）。
所以「请求的连接 === 生效指针」在语义上就是「这次写入没有移动绑定」，不产生任何新证明，自然不该改变行的可回退性。

## 3. 为什么**不**用「payload 的 `config.dataSourceId` 是否变化」

那个判据会漏掉迁移形状（`connection_id = A` + 标记 TRUE + `config.dataSourceId = A`）：
一次 `connectionId = B` 且不带 `config` 的写入，"指针"没变（payload 根本没提），于是不退役，
却把 `connection_id` 写成了 B —— 造出 canonical B + legacy 指针 A 的僵尸行。
读侧 `lib/connection-resolver.cjs:193-200` 对这种双引用不一致直接抛
`CONNECTION_BINDING_MISMATCH`，这一行从此每次读都死，且本 API 没有清 `connection_id` 的路径
（`requestedConnectionId` 在既有行上拒绝 `connectionId: null`，`:507-512`）。
所以判据必须比较**连接 id**（canonical 优先），不是比较 payload 里的旧指针字段。

## 4. 这是一次放松：它还不能造成什么（逐条）

放松的面是「带着 `connectionId` 的写入不再一定退役标记」。逐条核对它能留下的状态：

1. **canonical 已写 + 标记仍 TRUE**：这不是新形状，是迁移回填本来就产生的形状
   （`__tests__/integration-connection-binding-migration.test.cjs` 与本测试第 2 组的 setup 都用它），
   读侧走 `resolveCanonical`，标记只作为回滚凭证存在，`resolveLegacy` 只有在
   `connection_id` 为空时才可能被选中。
2. **标记 FALSE 与 legacy 指针共存**：仍然不可能。指针删除条件（`:797`）读的是**这次写入之后**的标记，
   两者仍然在同一次写入里同进同退；本 PR 只改了标记何时变 FALSE，没改这个联动。
3. **绕过 MIN-PR2-i 的静默改指向**：不受影响。
   `assertLegacyBindingRepointCarriesCanonicalConnection`（`:647-668`）在本判据之前执行，
   不带 `connectionId` 的改指向照旧被 `LEGACY_BINDING_DATASOURCE_CHANGE_REQUIRES_CONNECTION_ID` 拒死。
4. **带 `connectionId` 移到别的连接**：照旧退役 + 照旧丢指针（测试第 3、11 组，两种形状都有）。
5. **只带 `connectionId` 不带 `config` 地移指针**：在写入之前就被读侧的
   `CONNECTION_BINDING_MISMATCH` 拒绝（`validateCanonicalConnectionBinding` 在 `:785-788`，
   先于指针删除 `:797` 发生），零写入，
   所以「不退役」不会变成造僵尸行的入口（测试第 12 组，两种形状都有）。
6. **权限面**：判据只读 `existing` 的两个字段与已归一化的请求值，不接触 principal 判定；
   所有权仍由 `resolveUpdatedConfig` / binder 先决（测试第 8 组未变）。

## 5. `connectionId: null` 的语义（按现状确认，不改）

两种「清空」是两件事，本 PR 都没动，并把它们钉进测试第 13 组：

- `config.dataSourceId: null` —— 允许，把 legacy 行去指针（读侧随后报
  `CONNECTION_LEGACY_POINTER_REQUIRED`）；clear-then-set 两步绕过仍被 MIN-PR2-i 拒绝（第 5 组）。
- `connectionId: null`（以及归一化后同样变 null 的 `''`）—— 在既有行上**拒绝**
  （`:507-512`，`SQL read-only bindings cannot clear their canonical connectionId`）。
  正因为 canonical 列没有取消路径，标记才是唯一的回滚凭证，这也正是「改名把它删掉」为什么严重。

## 6. 已知未覆盖 / 不在本 PR

- **存量巡检**：改动前可能已有行被一次纯改名退役并丢掉了 `config.dataSourceId`。
  本 PR 不做数据修复、不做扫描报告 —— 属 owner 层决定（触碰真实客户库）。
- 前端不改：工作台照旧每次保存都带 `connectionId`，服务端现在把它当「再次声明同一个连接」处理。
  由此，一次纯改名会把一行 rollback 形状的 `connection_id` 从 NULL 写成生效指针
  （这是 #5783 就已有的行为，本 PR 没有改变它），结果是迁移形状，读侧仍然一致、回滚凭证仍在。
- HTTP 层不新增路由用例：本层没有新增错误码，映射没变。
