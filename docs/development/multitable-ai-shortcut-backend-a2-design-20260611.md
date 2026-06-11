# 多维表 AI 字段 shortcut 后端(A2 / M2)— 设计锁定 — 2026-06-11(核验修订版)

> Status: **DESIGN-LOCK(docs-only,无运行时代码)** · 主线位置:arc 计划 M2
> 决策依据:M0 批准结果(修正二:产品路径 RBAC/API 面不继承 A1)+ A1 已落地(#2486)。
> 核验:2026-06-11 fact-check workflow(verdict ready-with-edits)——**全部修正已并入**;行号引用以该轮核验为准。
> **本环显式声明一个 migration**(台账表)。K3:多维表内核;不碰 central RBAC/auth、`plugin-integration-core`、`formula/engine.ts`。

## 0. 范围一句话

A2 = **执行层(单记录、同步)**:字段级 AI shortcut(摘要/分类/抽取/翻译)的 preview(零写)+ run(经权威写路径落值)、provider 客户端(双确认门)、成本台账 + 配额执行(关 T1)、4 保留态推导(关 T6)。**目标字段限 `string`/`longText`**;无批量、无异步、无自动化 action、无前端、无 OpenAPI 公开。

## 1. 承重事实(核验后,实现必须遵守)

| 事实 | 含义 | 出处(origin/main @核验时) |
|---|---|---|
| `RecordWriteService.patchRecords`(:506-1092)含校验/乐观锁/echo/realtime/formula 重算/相关传播,POST `/patch`(univer-meta.ts:8528-8669)是端到端组合先例 | run 落值必须走它 | record-write-service.ts;univer-meta.ts |
| **全部真实 `RecordWriteHelpers` 与 `requireRecordReadable`(:2342)是 univer-meta.ts 模块私有** | **新路由文件今天无法构造完整输入**——见 §2.2 接缝决策 | univer-meta.ts(exports 仅 6 个) |
| **Yjs 失效不在 patchRecords 内**:`/patch` 每请求经 `setYjsInvalidatorForRoutes`→post-commit hook 接线 | run 必须接同款 hook,否则相关 Y.Doc 陈旧 | univer-meta.ts /patch 接线 |
| 自动化 `executeUpdateRecord`(:1210-1244)= 裸 SQL + 手动 emit | **反先例,禁止效仿** | automation-executor.ts |
| RBAC 原语:`resolveSheetCapabilities`(permission-service.ts:1151)、`deriveFieldPermissions`(permission-derivation.ts:71,**勿用 access.ts 的同名重复导出**)、`ensureRecordWriteAllowed`(:1108)、`loadFieldPermissionScopeMap`(:774) | 产品 RBAC 组合件 | 同左 |
| **patchRecords 不执行 layer-3 field_permissions 写闸**(#2106 F3 既有姿态) | A2 自己的 target-editable 预检**就是**该层执行点,不得声称 RWS 兜底 | record-write-service.ts |
| `jwt-middleware.ts:112-114` 在 JWT 无 claim 时**用 `x-tenant-id` 请求头回填 tenantId** | **header 派生租户可伪造 → 不得作配额主体键**(§2.5) | auth/jwt-middleware.ts |
| `createRateLimiter` 键提取硬编码 `(req as any).userId \|\| req.ip`,无自定义 keyFn | Q-3 需向后兼容地扩 keyFn 或包装(§2.4) | middleware/rate-limiter.ts |
| 台账模板 = `multitable_automation_executions`;**最新迁移 = `zzzz20260610150000_…`,无 zzzzz 层** | 新迁移 = zzzz + 严格更大且未占用的时间戳 | db/migrations/ |
| 出站 HTTP:fetch + AbortController + 超时,fetchFn 可注入 | provider 客户端复用;**测试 spy 必须从构造期同一 fetchFn 接缝注入** | webhook-service.ts:122-125 |
| 掩码采样先例 = dry-run #5c(:6408/6461-6472);读路径字段掩码先例 = GET record(:7807/7843+) | preview 输入构造沿用 | univer-meta.ts |
| 无 job 队列/死信基建 | 单记录同步是被迫且正确的范围 | automation-scheduler.ts |
| A1 守卫风格 = **per-route**(`router.get('/ai/readiness', requireAdminRole(), …)`) | A2 端点同样 per-route 守卫,禁 router.use 级 admin | routes/multitable-ai.ts |

## 2. 锁定设计

### 2.1 Shortcut 定义、存储与**写入治理**

- 配置存 `field.property.aiShortcut`:`{ kind: 'summarize'|'classify'|'extract'|'translate'; sourceFieldIds: string[]; params?: { options?: string[]; targetLang?: string; instruction?: string } }`。
- **治理(核验修正)**:`sanitizeFieldProperty` 现状对未知键放行——A2 在字段 create/update 路径**显式校验** `aiShortcut`(kind 枚举;source 字段存在且非 computed;**params 全量约束:options ≤50 项×each≤100 字符、targetLang ≤32 字符、instruction ≤500 字符**),非法即 4xx。写入门槛 = 既有字段属性写权限(manage-fields),不新增原语。
- **所有 param 字符串与 source 值一样进入 unsafe_input 发送前扫描**(防经 options/targetLang 注入)。
- preview 接受内联 config(M3 配置时预览);**run 只执行已持久化配置**。Prompt 由服务端模板按 kind 组装,用户数据只进槽位。
- **目标字段类型限 `string`/`longText`**(classify 输出写标签文本)——消除 select 选项不匹配类失败;select 目标后续环。

### 2.2 端点与写路径接缝(核验修正)

- 端点仍在 `routes/multitable-ai.ts`(internal 姿态,per-route 守卫):`POST /sheets/:sheetId/ai/shortcut/preview` + `POST /sheets/:sheetId/ai/shortcut/run`(单 recordId)。
- **接缝决策(锁)**:univer-meta.ts 新增**两个最小导出**:①req 作用域的 `createRecordWriteHelpers(req, pool)` 工厂(内聚现 `/patch` 的 writeHelpers 构造,`/patch` 自身改为消费同一工厂——单一事实源);②`requireRecordReadable`。multitable-ai.ts 消费两者。不搬迁 helper 本体、不复制逻辑。
- **run 序列(锁,防 TOCTOU)**:`requireRecordReadable` → **读记录一次,捕获 version + source 值** → 掩码/组 prompt → 配额/限流/双确认门 → provider 调用 → `patchRecords`(带捕获的 expectedVersion;并发编辑 → 409 原样透出,**无静默覆盖**)→ **接 Yjs post-commit 失效 hook(与 `/patch` 同款接线)** → 台账。
- RBAC:preview = 记录可读 + source 字段可读(掩码者不进 prompt);run 追加 `capabilities.canEditRecord` + `ensureRecordWriteAllowed` + **target 字段 editable(`deriveFieldPermissions`,此预检即 layer-3 写闸执行点)**。
- 测试矩阵补 RBAC 探针:recordId 不属 :sheetId → 404;表不可见 → 403/404;preview-可读-run-不可写分离。

### 2.3 Provider 客户端

`services/ai-provider-client.ts`:anthropic messages + openai chat completions;超时/输出上限取 A1 `caps`;fetch + AbortController;**fetchFn 构造期注入(测试 spy 同接缝)**。**双确认门**:`resolveAiProviderReadiness().status==='ready'` 且 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS==='1'`,否则 `blocked` 零出站。**usage 归一化(核验 gap)**:anthropic `input_tokens/output_tokens` ↔ openai `prompt_tokens/completion_tokens` → 统一 `promptTokens/completionTokens`。**价格表**:per-provider×model 常量(估算);**模型不在价格表 → 按配置错误 `blocked`,绝不静默 $0**(A1 allowlist 上游已挡,此为深防)。

### 2.4 T6 四保留态(关 T6)

| 状态 | 触发 |
|---|---|
| `rate_limited` | Q-3:`createRateLimiter` **向后兼容扩 `keyFn` 选项**(或薄包装),键 = §2.5 主体键;**429 不写台账**(防 DB 写放大,响应即审计) |
| `quota_exhausted` | Q-1/Q-2 主体 token、Q-4 实例 USD 聚合超额(§2.5) |
| `provider_error` | 客户端错误分类(HTTP/网络/超时/价格表缺失视为 blocked 见上) |
| `unsafe_input` | 发送前扫描(组装后 prompt 全文,含 params):复用后端 redactor 既有模式(sk-/Bearer/JWT/postgres/mysql conn-string;**JDBC/ODBC 不在现集,如实声明**);若 redactor 仅替换无检测面,实现以"替换前后不等即检出"派生,不重写规则 |

### 2.5 台账 + 配额(关 T1;唯一 migration,zzzz + >20260610150000 未占用时间戳)

- 表 `multitable_ai_usage_ledger`:`id, occurred_at, subject_key, user_id, sheet_id, field_id, record_id, action, provider, model, prompt_tokens, completion_tokens, estimated_cost_usd, status, duration_ms, error(脱敏)`;索引 `(subject_key, occurred_at)` + `(occurred_at DESC)`;down() 干净。**不持久化 prompt/输出原文**。
- **主体键(核验安全修正)**:`subject_key = user_id`(已认证、不可伪造)——header 回填的 tenantId **禁止**入键。E-8/E-9/E-10 的 "TENANT" 语义在真租户模型落地前 = **per-user**(env 名是已批契约不改,语义如实文档化);Q-4 USD 恒为 `__instance__` 聚合。
- **记账规则(核验修正)**:**凡 provider 返回了 usage 即记 tokens/cost,无论下游成败**(版本冲突/落值失败也消耗了真金白银);未达 provider 的尝试(blocked/quota/unsafe)记零 token 行;**rate_limited 不写行**。配额聚合 = SUM(tokens/cost 列),**不过滤 status**。
- **竞态(核验修正)**:配额检查+插入用 **pg advisory lock(键=subject_key 哈希)** 串行化(autoNumber #1406 先例),防并发超额。
- **台账写入失败策略(锁)**:best-effort——patchRecords 已提交后台账失败**绝不回滚/绝不 500**,记错误日志;quota 检查阶段台账不可用 → fail-closed(`blocked`)。
- **留存**:无 TTL 基建;声明 aging 为已知后续(NiFi 对标 #1880 的既有 GAP),表设计已留 `occurred_at DESC` 索引便于手动归档。

> **Implementation reconcile 2026-06-11(as-built,评审修复 F1/F3)**
>
> - **竞态条款的落地形态 = RESERVE-THEN-SETTLE**(advisory-lock 决策的实现化,语义不变):锁(`__instance__` → subject 固定顺序)只包住一个**短事务**——清扫过期 in_flight 预留(> requestTimeoutMs + 60s 宽限 → `abandoned` 零用量;每次 reserve 都先持实例锁,全局清扫无竞态)→ SUM 检查(**含 in_flight 预留**,仍不过滤 status)→ 插入 `in_flight` 预留行(prompt 估算 = ceil(组装后字符数/4),completion 估算 = maxOutputTokens 上限,成本按价格表估算)→ COMMIT 释放锁与连接。**provider 调用不持锁、不占池连接**;返回后将预留行 settle 为实际用量与终态(写失败路径保留实际用量只改 status;settle 失败 = best-effort 不回滚不 500)。崩溃遗留的 in_flight 行计入配额直至下次 reserve 清扫为 `abandoned`(零值,聚合无害)。T6 "N 并发不超额" 由预留占额保证,落败方呈现 `quota_exhausted`;门顺序相应为:RBAC → 配置/unsafe_input → 双确认 → 突发限流(429 提前:不加锁不写台账)→ 配额预留 → provider → settle → 落值。状态枚举新增 `in_flight`/`abandoned` 两个内部态(表无 CHECK 约束,无 migration 变更)。
> - **§2.2 "两个最小导出" 实际落为四导出 + 1 类型**:`createRecordWriteHelpers` / `requireRecordReadable`(锁定项)之外另需 `buildRecordPatchContext` + `RecordPatchRouteContext` + `getYjsInvalidatorForRoutes` —— `RecordPatchInput` 的构造件(serializeFieldRow / filterVisiblePropertyFields / buildFieldMutationGuardMap)与 Yjs invalidator 均为 univer-meta 模块私有状态,不复制逻辑的路径仅此一条;`/patch` 消费同一工厂,行为未变(评审 F3 记录在案)。

### 2.6 边界(硬性)

同前版 + :价格常量表"估算非账单"注记;不动 A1 readiness 语义;migration 仅台账一张。

## 3. 测试矩阵(fail-first;**A2-T5/T12 + 台账/配额 = 真库套件,挂 plugin-tests.yml 显式清单**——RWS 真路径禁 mock;其余路由级/单元)

| # | 场景 | 断言 |
|---|---|---|
| A2-T1 | readiness≠ready 或 E-12≠1 | preview/run `blocked`,fetch spy(构造期注入)零调用,台账零 token 行 |
| A2-T2 | RBAC 探针组:无记录读 / recordId 不属 :sheetId / 表不可见 | 404/403 语义各就位,零调用零台账 |
| A2-T3 | 可读不可写 actor | run 403;preview 成功 |
| A2-T4 | source 字段 deny → 不进 prompt(spy 捕获请求体);target readonly/denied/类型非 string|longText → run 4xx | 同左 |
| A2-T5 | run 成功(真库) | 值经 patchRecords 落库:version 递增、formula 重算/echo 副作用按 RWS 契约、**Yjs 失效 hook 收到记录 id**;台账行 tokens>0 |
| A2-T6 | 配额:user 日/周 token、实例日 USD 超额(真库聚合) | `quota_exhausted` 零调用;**并发探针:advisory lock 下 N 并发不超额** |
| A2-T7 | 限流 | `rate_limited`;**台账无行** |
| A2-T8 | provider 5xx/超时/未知模型价格(mock) | `provider_error`/`blocked`;错误入台账前脱敏;**失败但已返 usage → tokens 仍记账** |
| A2-T9 | unsafe_input:source 值/params(options/targetLang/instruction)含 secret 形状 | 拒发零调用 |
| A2-T10 | 泄漏哨兵 | key 不出现在响应/台账/日志/错误 |
| A2-T11 | run 拒内联 config;字段路径写非法 aiShortcut(坏 kind/超限 params)→ 4xx | 同左 |
| A2-T12 | 版本冲突(真库):捕获 version 后并发改记录 | 409 透出;**provider usage 已记账**;无落值 |
| A2-T13 | migration | 表/索引/down() |

## 4. 回滚

代码 revert + 台账表保留;E-12 撤掉即全局 blocked;run 已落值与用户编辑同地位。

## 5. 不在 A2

批量/异步 · 自动化 action · 流式 · M3 前端 · OpenAPI 公开 · select 目标字段 · 台账 aging 自动化 · prompt 自定义模板。
