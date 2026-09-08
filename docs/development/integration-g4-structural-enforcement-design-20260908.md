# 集成层 G4 结构化强制设计（PR-2 第一刀，2026-09-08）

> 一句话：把「所有 `data-source:sql-readonly` 绑定必经 connection resolver 才能变成 adapter」从**调用点纪律**变成**结构强制**，并顺带关掉跨插件通信 API 的 `tenantId` / `createdBy` 自报。触发条件见 §6；在此之前不动工。

- 基线：`origin/main@a15f5433b`（2026-09-08）。行号为当日快照，动工前重核。
- 性质：设计说明，不是实施记录。values-free。
- 上游：`docs/integration-consolidation-minimal-plan-20260901.md`（PR-1/2/3 分工）、PR #5452 合并后终审（G4 被批评者判为"约定而非结构"）。

## 1. 为什么现在写：三次同类事故一个根因

| 事故 | 表现 | 根因归类 |
|---|---|---|
| PR-1 合并后终审（高） | `loadTableActionSourceAdapter` 先以请求者解析连接、再委托 owner；守卫测试只挂 `getExternalSystem`，resolver 从未运行 | 调用点纪律 + 测试替身绕过收口 |
| #5471 → #5534 | 读取口回退到租户级行，写入口按请求作用域保存，两半不一致 | 读写两侧各自决定作用域，无共享不变式 |
| #5538 反驳 | 把 sql-readonly 分支从 `scopedAuthenticatedWriteInput` 降为 `scopedInput` 后整套测试仍绿 | 守卫存在与否只靠测试作者记得去测 |

三者共同点：**守卫是否生效取决于每个调用点是否记得调它**。今天代码里的事实（均可核）：

- 路由注册只要求 `upsertExternalSystem / getExternalSystem / deleteExternalSystem / listExternalSystems`（`lib/http-routes.cjs:3495`），**不要求** `getExternalSystemForAdapter`；15 处调用点写成 `typeof externalSystems.getExternalSystemForAdapter === 'function' ? … : externalSystems.getExternalSystem.bind(…)`——生产永远走前者，但**测试替身可以只提供后者**，于是 resolver 在那套测试里不存在。
- adapter 对输入不设防：`lib/adapters/data-source-sql-readonly-source-adapter.cjs:561` 只要对象带 `config.dataSourceId` 就照单全收；resolver 的产物（`lib/connection-resolver.cjs:136-146` `adapterBinding`）只是一个普通对象，和一条从 DB 直读的旧行没有任何区别。
- 跨插件通信面（`index.cjs`）：`upsertExternalSystem` 已剥 `principal` 并强制 `runAs:'service'`（:214），但 `upsertPipeline` 原样转发（:227-228），`createdBy` 落库后即成为 pipeline-runner 的连接 principal；`tenantId` 两处都原样转发。

## 2. 目标不变式（每条都要可测、可变异）

- **I1** 任何以 kind `data-source:sql-readonly` 进入 `adapterRegistry.createAdapter` 的 `system`，都是 connection resolver 的产物；非产物一律 `ADAPTER_INPUT_UNRESOLVED` 拒绝。
- **I2** registry 的 credential-stripped 公共投影（`getExternalSystem` 的返回）永远不能作为 adapter 输入。
- **I3** 跨插件通信 API 不能自报 `principal` / `createdBy` / `tenantId` 作为任何授权或落库依据。
- **I4** I1–I3 各有一条"去掉守卫该测试就红"的变异证据，并用 `-r` 预载钩子在 CI 之外可复跑。

## 3. 机制：三刀加一条备注

### M1 · resolver 产物打不可伪造标记（实现 I1）

- `lib/connection-resolver.cjs` 内部定义模块私有 `const RESOLVED = Symbol('integration.resolvedBinding')`；`adapterBinding()` 用 `Object.defineProperty(out, RESOLVED, { value: true, enumerable: false })` 打标。**只**通过一个内部函数 `isResolvedBinding(x)` 暴露判定，不导出 Symbol 本身；`index.cjs` 的通信 API 不转发该判定。
- `lib/contracts.cjs:223 createAdapter(system, deps)`：当 `system.kind === 'data-source:sql-readonly'` 且 `!isResolvedBinding(system)` → 抛 `AdapterInputError('ADAPTER_INPUT_UNRESOLVED')`。sealed 路径同理检查 `resolveSealedSqlServer` 的产物。
- 为什么是 Symbol 而不是字段：JSON/DB 往返、spread 复制、测试替身都造不出私有 Symbol；同进程插件代码要伪造必须拿到模块内部引用，而它不导出。

### M2 · 去掉 credential-stripped 回退，硬依赖 ForAdapter（实现 I2）

- `requireService('externalSystemRegistry', [...])` 增加 `'getExternalSystemForAdapter'`（`http-routes.cjs:3495`），15 处三元回退全部改为直接调用。
- `rowToPublicExternalSystem` 的返回对象打 `PUBLIC_PROJECTION` 标记（同样私有 Symbol，或直接由 M1 的"非产物即拒"覆盖——两者取其一，推荐只靠 M1，M2 只做去回退）。
- **这是工作量主体**：所有只挂 `getExternalSystem` 的测试替身（例如 `stock-preparation-operator-pull-gate.test.cjs` 那类）会立刻失效——这正是它们此前掩盖事故 A 的原因。改法统一：替身提供 `getExternalSystemForAdapter`，并用真实 `createConnectionResolver` + 假 facade（参考 #5534 的闭环测试写法）。

### M3 · 通信 API 剥离自报身份（实现 I3）

- `upsertPipeline`：服务端置 `createdBy = null`；pipeline-runner 对 `createdBy` 为空的 pipeline，在 sql-readonly 源上因 principal 缺失被 facade 拒绝（现有行为，`requirePrincipal`），跨插件因此只能驱动非 SQL 源或走受治理的 HTTP 面——与 `upsertExternalSystem` 已有姿态一致。
- `tenantId`：跨插件调用没有 host 认证上下文，两种取舍——(a) 要求调用方传入的 `tenantId` 经 #5445 的 `tenantPrincipalDirectory.verifyTenantMembership` 对某个显式 principal 背书，否则拒绝；(b) 直接拒绝跨插件创建 sql-readonly / 含私有配置的系统。**推荐 (b)**：今天没有任何跨插件调用方需要它，(a) 引入的"principal 从哪来"问题又回到起点。
- `runPipeline` / `replayDeadLetter` 已强制 `runAs:'service'`，不动。

### M4 · 备注：W4 开关默认值不在本刀

`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 默认 OFF 是部署事件（`http-routes.cjs` 开关注释、交付指南 §5-5）。翻 ON 的前置是所有部署令牌带声明；#5538 的子例 (d) 已把 OFF 的过渡姿态显式断言，翻转时必须有意识地改它。

## 4. 测试策略

- 每刀一条变异探针（沿用 `scratchpad/mutate-resolver-hook.cjs` 的 `-r` 预载 + 内存篡改，不落盘）：
  - M1：去掉 `createAdapter` 里的 `isResolvedBinding` 检查 → 用一条 DB 直读行造 adapter 的测试必须红。
  - M2：把任意一处调用恢复成三元回退，并给替身只挂 `getExternalSystem` → 该路由的测试必须红（而不是像今天一样绿）。
  - M3：不剥 `createdBy` → 跨插件建 pipeline 后 service 运行读到 owner 连接的测试必须红。
- 反驳纪律：每刀合并前问一遍"哪种降级变异它抓不到"（#5538 的教训）。
- 被 pin 文件：`index.cjs`、`http-routes.cjs`、`sealed-export/*` 都在 pin 清单，每刀重打 pin；Windows 上按 LF 字节校验。

## 5. 分步、顺序、回滚

| 序 | 刀 | 为什么先/后 | 回滚 |
|---|---|---|---|
| 1 | M2 去回退 | 最机械，但触面最大（替身改造），先把测试基线立正 | 单独 revert |
| 2 | M1 标记 | 依赖 M2 后的替身都走真实 resolver，否则全红 | 单独 revert |
| 3 | M3 通信 API | 独立，最后做 | 单独 revert |

三刀三 PR，各自 pin 重打、各自可回滚；每刀走"rebase → re-pin → CI 绿 → 立即合"。

## 6. 触发条件与非目标

- **触发**（任一）：有人要给 integration 插件加一条"加载外部系统再建 adapter"的路由；任何部署出现第二个租户或 workspace；出现第二个跨插件调用方。
- **非目标**：workspace 共享模型、删除语义/软删复活、Bridge 下沉 core、W4 默认值翻转、连接器目录/自动化触发——各归各的 PR-2 条目。

## 7. 风险

- M2 会一次性让一批测试替身失效，必须在同一 PR 里改完，不能分批（否则中间态 CI 红）。
- M1 的 Symbol 一旦被导出到通信面或被 JSON 化处理"修复"，标记就失去意义；代码评审要盯这一点。
- 三刀都动 `http-routes.cjs` 与 `index.cjs`，与备料线并行时 pin 冲突概率高，建议开短暂合并窗口。
