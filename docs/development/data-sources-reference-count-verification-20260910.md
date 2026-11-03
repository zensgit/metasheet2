# 外接数据源「被引用 N」列 — 验证 (2026-09-10)

设计见 `data-sources-reference-count-design-20260910.md`。
worktree `metasheet-wt-ds-refs`,分支 `feat/data-sources-reference-count`,基于 afcf9e374(PR #5587 终审修复后)。

## 1. 命令与退出码

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/data-source-visibility-authority-matrix.test.ts` | 51 passed | 0 |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/data-source-{visibility-authority-matrix,scope,readonly,result-boundary,connect-refusal,test-ephemeral,test-error-fidelity}.test.ts` | 131 passed(改动前基线,7 文件) | 0 |
| `pnpm --filter web exec vitest run tests/data-sources-ui.spec.ts tests/dataSourcesPanelEmbedded.spec.ts tests/IntegrationConnectionSection.spec.ts tests/dataSourcesDeleteRefusal.spec.ts` | 73 passed(4 文件) | 0 |
| `pnpm --filter @metasheet/core-backend run type-check`(`tsc --noEmit`) | — | 0 |
| `pnpm --filter web run type-check`(`vue-tsc -b` + 两个 verification tsconfig) | — | 0 |
| `pnpm --filter web exec vitest run <引用被改模块的 9 个 spec>` | 245 passed | 0 |
| `pnpm --filter web exec vitest run`(全量) | 10766 passed / 50 failed(38 文件) | 1 |

`data-sources-ui.spec.ts` 未被修改,39 项原样通过。

vue-tsc 不是假绿:首次跑时它抓到了模板里未定义的 `bindingsHref`
(`DataSourcesPanel.vue(158,26): error TS2339`),补上 computed 后才转绿。

## 2. 新增测试

后端 `packages/core-backend/tests/unit/data-source-visibility-authority-matrix.test.ts`(+13):

- `data_sources listing reference counts (batched, values-free)` 7 项:每项带整数计数
  (canonical 1 / canonical+legacy 2 / 未引用 0,外来 pin 不计)、**N+1 探针**(整页只服务
  一对 grouped 查询且一次问全部 id)、字段白名单(只有 `connected/id/name/ownerId/referenceCount/type`)、
  详情同值、计数失败时**省略字段而非填 0**、以及 THE BINDING:列表显示的数 == 删除守卫强制的数、
  管理员列表按**源的** owner 归属(看到 2 不是 3)。
- `DataSourceManager.countExternalSystemReferencesByIds` 6 项:无 db 全 0、空 ids 零查询、
  **与单条守卫逐 id 等价**(canonical/legacy/迁移行只计一次/外来 pin/未盖章/未注册 6 种形态)、
  无 scope 的 id 连问都不问、返回键不被未请求的行撑大、P2-B 姿态继承(仅 42P01 归零,散文上抛)。

前端:
- `apps/web/tests/dataSourcesPanelEmbedded.spec.ts`(+11):列三态、每行各自的数、
  嵌入态点击 emit `show-bindings` 且 `preventDefault`、独立态是真跳转不拦截;
  删除确认三态文案(点名 N / 原文案逐字 / 未知回退)、409 翻成人话、其它失败保留原消息。
- `apps/web/tests/IntegrationConnectionSection.spec.ts`(+1):宿主收到 `show-bindings` 后
  `update:inventoryExpanded(true)` —— 只跳锚点会落在一个折叠着的清单上。
- `apps/web/tests/dataSourcesDeleteRefusal.spec.ts`(新,6 项):mock 更底层的 `apiFetch`,
  让真实 `deleteDataSource` 跑在真实 409 信封上,钉住 code/details 的**提取**这一段。

## 3. 变异表

内存变异(脚本改字节 → 跑测试 → `finally` 还原并逐字节校验),不落盘。

| # | 变异 | 结果 |
| --- | --- | --- |
| M1 | 批量版去掉 legacy 那条分组查询(只剩 canonical) | 红 6(含等价性、THE BINDING) |
| M2 | 批量 legacy 循环去掉 owner 归属(裸 dataSourceId 匹配,P2-A) | 红 5(外来 pin 把 2 抬成 3) |
| M3 | 路由改成逐 id 调单条版(N+1) | 红 2(N+1 探针) |
| M4 | 计数失败时填 0 而不是省略字段 | 红 1(DEGRADES TO UNKNOWN) |
| M5 | 详情路由不再带计数 | 红 1 |
| W1 | 列不读 `referenceCount`(恒「未知」) | 红 6 |
| W2 | 「未知」并入「未被引用」(undefined 当 0) | 红 1 |
| W3 | 删除确认忽略计数(恒用原文案) | 红 1 |
| W4 | store 直接回显服务器英文散文 | 红 1 |
| W5 | api 客户端不把 `code` 挂到 Error 上 | 红 3 |
| W5b | api 客户端不把 `details.referenceCount` 挂上 | 红 2 |
| W6 | 嵌入态链接不再请求宿主展开 | 红 2 |
| W7 | 宿主忽略 `show-bindings` | 红 1 |
| W8 | 翻译文案不再读计数 | 红 2 |

W5 **第一轮存活**:面板测试注入的是已成形的错误对象,钉住了文案却没钉住提取。
补 `dataSourcesDeleteRefusal.spec.ts` 后 W5/W5b 才转红——这条缺口是变异探针自己抓出来的。

## 4. 未做 / 存疑

- 未跑真库集成测试(`tests/integration/*realdb*` 需要 PG),分组 SQL 的真实执行以 CI 为准。
  假 db 桩按位置捕获谓词,能证明形状与调用次数,不能证明 PostgreSQL 接受该语法。
- 本机全量 web 套件 50 项红(既有噪音,见记忆「本机测试环境真相」)。已做定向排查:
  `grep -rl` 出引用本次改动模块(`data-sources/{api,types,deleteRefusalCopy}`、`stores/dataSources`、
  `DataSourcesPanel`、`DataSourcesView`、`IntegrationConnectionSection`)的全部 9 个 spec,单独跑全绿
  (245 passed,退出 0),失败面与本改动无交集。最终以 CI 为裁判。
- 未改迁移、未改 `plugins/`、未改 openapi(200 本就无 schema 声明)。

## 5. 终审修复(2026-09-10)

对抗复核终审对本次切片提出 3 项必修 + 1 项建议,逐项收口:

- **F03 文案绝对断言**:`deleteConfirmMessage`(`apps/web/src/data-sources/deleteRefusalCopy.ts:69`,
  终审原话指的 :64 是加 JSDoc 前的行号,补了几行说明后下移到 :69)
  原文「正被 N 个绑定引用，删除会被服务器拒绝（409）」改为「按最近一次读取，正被 N 个绑定引用，
  删除很可能被服务器拒绝（409）」;函数上方 JSDoc 同步把 "the server will refuse" 改成
  "the server will most likely refuse"、补一句 "as of the last read"。理由:同一工作台页增删绑定
  只改本地 `systems`,面板只在 `onMounted` 拉一次(`DataSourcesPanel.vue`),列表上的计数可能已过期,
  不是保证。同步改了 `apps/web/tests/dataSourcesPanelEmbedded.spec.ts` 里断言该文案的用例(标题与
  资产同步为 "will most likely refuse",新增对 "最近一次读取" / "很可能" 的断言),以及
  `DataSourcesPanel.vue` 里 `confirmRemove`(:809 附近)的注释,把 "the SAME server fact" 改成
  "the most recent snapshot of the SAME server fact",并写明为何会过期。
- **F01 失败零信号**:`referenceCountsForDisplay`(`packages/core-backend/src/routes/data-sources.ts:338`,
  终审原话指的 334/341 是加 `Logger` 导入前的行号,导入语句插入后函数体下移到 338/345)的空
  `catch {}` 改为记一条 `warn`,载荷只有两个键
  `{ sqlstate: (err as { code?: string } | null)?.code ?? 'unknown', ids: ids.length }`,不带
  `message`(values-free,驱动错误可能带主机/库名)。沿用文件既有的 `Logger`(`../core/logger`,
  实例名 `logger = new Logger('DataSourcesRouter')`,与 `snapshots.ts` 等路由同一约定)。JSDoc 里
  "nothing about the failure is logged" 改成 "on failure only the SQLSTATE and the id count are
  logged"。新增单测 `on failure, logs ONLY the SQLSTATE and the id count — never the driver message`
  (`packages/core-backend/tests/unit/data-source-visibility-authority-matrix.test.ts`):对
  `DataSourceManager.prototype.countExternalSystemReferencesByIds` 注入一个带 `code: '57P01'` 且
  message 里嵌了主机/库名/口令失败原文的 Error(与既有 `DEGRADES TO UNKNOWN` 用例同一注入方式),
  断言 `Logger.prototype.warn` 恰好被调用一次、载荷键集合恰为 `['ids', 'sqlstate']`、且序列化后的
  载荷不包含注入错误的原文。
- **F07 文档基线**:本文件 `:4` 与设计文档 `:3` 的 `7eff1e8d2` 改为 `afcf9e374`
  (PR #5587 终审修复后的提交),避免读者对着一个已被终审改写过的基线核对。
- **建议项(慢→挂,3 秒预算)——已实现但回退,原因见下**:先在 `referenceCountsForDisplay` 里加了
  `Promise.race` 式的 3 秒预算(超时同样退化为空 Map、`sqlstate: 'timeout'`),并按任务指示的路子写了
  一条 `vi.useFakeTimers()` + 永不 resolve 的 db 桩单测。跑起来后,该测试本身在真实 30s 后超时失败,
  且此后同文件全部测试(包括与本次改动无关的既有用例)级联超时,连 `afterAll` 的 `hookTimeout` 都炸了
  ——本文件用 `usePinnedServer()`(真实 `http.createServer` + 真实 loopback 监听 + supertest 打真实
  socket),fake timers 一旦启用,supertest 那次请求的响应就再也没有从 socket 另一端回来
  (`vi.advanceTimersByTimeAsync(3000)` 之后 `await reqPromise` 仍挂着),与任务里预留的免责条款
  「如果 fake timers 与现有桩配合不上，跳过第 4 条并在回报里说明」的场景吻合。已把生产代码里的
  `REFERENCE_COUNT_QUERY_BUDGET_MS` / `ReferenceCountQueryTimeout` / `withReferenceCountBudget` 与
  对应单测整段回退,`referenceCountsForDisplay` 恢复为不带超时预算、只做 F01 的 warn 化。**未做**,
  按任务的免责条款处理;若要重试,建议换一个不经真实 socket 的测试宿主(例如直接单测
  `referenceCountsForDisplay` 本身,不经 Express/supertest),而不是在 `usePinnedServer` 套件里假计时器。

命令与退出码(本次收口):

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/data-source-visibility-authority-matrix.test.ts` | 52 passed(新增 1 项,DEGRADES TO UNKNOWN 用例数不变) | 0 |
| `pnpm --filter web exec vitest run tests/dataSourcesPanelEmbedded.spec.ts tests/dataSourcesDeleteRefusal.spec.ts tests/data-sources-ui.spec.ts` | 60 passed(3 文件) | 0 |
| `pnpm --filter @metasheet/core-backend run type-check` | — | 0 |
| `pnpm --filter web run type-check` | — | 0 |
