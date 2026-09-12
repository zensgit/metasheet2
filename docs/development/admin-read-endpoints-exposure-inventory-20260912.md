Language / 语言: 中文

# admin 只读侧无角色门 GET 端点暴露面盘点（#5665 对抗复核后续）

范围：`packages/core-backend/src/routes/admin-routes.ts` 与其子路由
`packages/core-backend/src/routes/protection-rules.ts` 中，PR #5665 对抗复核终审指出的、handler
层没有任何角色门（既无 `requireAdminRole()`，也无 `rbacGuard(...)`）的 GET 端点，共 **13 条**（`admin-routes.ts`
11 条 + `protection-rules.ts` 2 条）。全部行号已按 `origin/main`（本 worktree HEAD `9fb29831c`）实读核对，
与任务给出的估计行号有出入，差异见文末「与前提不符的实读发现」。

本文档只做盘点，不改代码、不下加门与否的最终结论——结论列在每条的「建议」里，供 owner 裁决。

## 结论（先读这段）

- **含业务/敏感 payload 的有 5 条**：`GET /dlq`、`GET /health/detailed`、`GET /health/subsystem/:name`、
  `protection-rules` 的 `GET /` 与 `GET /:id`。这 5 条不是同一档次的风险：
  - `GET /dlq` 证据最强、风险最高——handler 直接把死信队列的**原始失败消息体**（`payload`，任意 JSON，
    来自消息总线上任何一次 `publish()`，包括插件 SDK 与审计事件）和**原始异常文本**（`error_message`）
    整条吐给调用者，且 `dead_letter_queue` 表**没有 `tenant_id` 列**、`dlqService.list()` **没有租户过滤**——
    这是本次盘点里唯一一条同时命中「含业务 payload」与「内容级跨租户暴露」两项的端点。
  - `GET /health/detailed`、`GET /health/subsystem/:name` 含的是「有限业务信息」：插件错误文本
    （`PluginHealth.lastError.message`）和插件自定义 `metadata`、以及数据库连接池的原始驱动错误文本
    ——都是内部系统状态/错误细节，不是终端表格行数据。
  - `protection-rules` 的两条 GET 含的是治理配置本身（哪些操作会被 block/require_approval）加创建者
    身份标识（`created_by`），也不是终端业务数据行。
- **内容级跨租户暴露只有 1 条实读确认**：`GET /dlq`（原因见上）。另有 **1 条是休眠中的跨租户枚举设计缺口**
  （推断，非实读确认已被利用）：`GET /ratelimits/:key` 的 bucket key 在代码约定里是 `tenant:${tenantId}`，
  一旦这套 `MessageRateLimiter`/`consume()` 被接回生产消息流，任意已认证用户就能用猜测的租户 ID 探测
  其他租户是否存在、流量规模与接受率；但静态实读确认**当前 `message-bus.ts` 从未 import/consume 这套限流器**
  （仅 `HealthAggregatorService.ts` 只读 `getGlobalStats()`），所以这条目前是「设计上存在、当前未激活」的缺口，
  不是已经在被利用的活跃暴露面。
- **其余 7 条**（`safety/status`、`slo/status`、`shards`、`shards/:name`、`queues`、`ratelimits`、
  `health/summary`）本身是平台级/进程级基础设施或指标聚合，**没有租户维度**，用「跨租户」框住它们不准确——
  它们不是隔离失败，而是设计上就没有租户这个维度。但仍是可用于攻击前侦察的侧信道：Node 版本、内存使用率、
  数据库驱动原始错误文本、系统健康趋势等。
- **前端调用：全部 13 条在 `apps/web/src` 里零命中**（含拼接形态搜索）。ops 侧只有
  `scripts/verify-sprint2-staging.sh:158` 对 `protection-rules` 的 `GET /` 做过一次限流探测性调用
  （连打 11 次看是否 429，验证的是限流机制不是业务功能），不构成功能依赖；`scripts/performance-baseline-test.sh`
  和 `scripts/preflight-staging.sh` 只调用了同一路由的 POST（创建/评估）和 DELETE（清理），没有 GET 列表/详情调用。

绝对句先限定范围的说明：本文档不使用「全部 13 条都跨租户」「零业务价值」这类未限定的绝对句——上面已经把
「跨租户」「含业务 payload」严格拆到条目级别，并区分了「实读确认」与「推断」。

## 总表

| # | 方法 路径 | file:line | 业务 payload | 跨租户 | 前端调用 | 风险类 | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | GET /safety/status | admin-routes.ts:79 | 无 | 否（单例，无租户维度） | 无（0 命中） | 侦察面（低） | 加 requireAdminRole() |
| 2 | GET /slo/status | admin-routes.ts:1357 | 无 | 否（平台级 Prometheus 聚合） | 无 | 侦察面（低-中） | 加 requireAdminRole() |
| 3 | GET /dlq | admin-routes.ts:1400 | **有（原始消息体+异常原文，实读确认）** | **是（实读确认，无 tenant_id 列/过滤）** | 无 | **信息泄露（高）** | 加 requireAdminRole()，优先修 |
| 4 | GET /shards | admin-routes.ts:1485 | 无（含原始驱动错误文本） | 否（DB 连接池是进程级基础设施） | 无 | 侦察面（中）/ 需真库确认错误文本内容 | 加 requireAdminRole() |
| 5 | GET /shards/:name | admin-routes.ts:1531 | 同上 | 否 | 无 | 同上 | 加 requireAdminRole() |
| 6 | GET /queues | admin-routes.ts:1577 | 无（仅计数） | 否 | 无 | 侦察面（低） | 加 requireAdminRole() |
| 7 | GET /ratelimits | admin-routes.ts:1708 | 无 | 否（全局聚合） | 无 | 侦察面（低） | 加 requireAdminRole() |
| 8 | GET /ratelimits/:key | admin-routes.ts:1770 | 无 | **休眠中的跨租户枚举缺口（推断，未激活）** | 无 | 需接线/真库确认 | 加 requireAdminRole()，且应在重新接线 MessageRateLimiter 前先补门 |
| 9 | GET /health/detailed | admin-routes.ts:1884 | **有（插件错误文本/metadata + DB 驱动错误文本，实读确认）** | 否（平台级聚合） | 无 | 信息泄露（中）+ 侦察面（高） | 加 requireAdminRole()，优先修（与 /plugins/health 的门形成矛盾） |
| 10 | GET /health/summary | admin-routes.ts:1913 | 无（仅布尔/百分比） | 否 | 无 | 侦察面（低） | 加 requireAdminRole() |
| 11 | GET /health/subsystem/:name | admin-routes.ts:1946 | 有限（取 name=plugins/database 时同 #9 对应部分） | 否 | 无 | 信息泄露（中，视 name）/ 侦察面 | 加 requireAdminRole() |
| 12 | GET /safety/rules (protection-rules.ts `GET /`) | protection-rules.ts:54 | 有限（治理规则 + created_by 身份标识） | 否（表无 tenant_id 列，功能本身全平台单一规则集） | 无（ops 侧仅限流探测，见上） | 信息泄露（低-中） | 加 requireAdminRole() 或等价 rbacGuard('safety-rules','read')，待裁决具体码 |
| 13 | GET /safety/rules/:id (protection-rules.ts `GET /:id`) | protection-rules.ts:82 | 同上 | 同上 | 无 | 同上 | 同上 |

挂载与全局门（实读确认，非本次盘点对象，但按任务要求核对）：

- 挂载点：`packages/core-backend/src/index.ts:1884` —— `this.app.use('/api/admin', initAdminRoutes({...}))`，
  mount 与路由定义之间没有额外中间件插入。
- 全局 JWT 门：`index.ts:1670-1683`。判定顺序为 `isWhitelisted(path)`（=`isGateException`，见
  `auth/api-path-policy.ts:26-28,167-178`）→ `isPublicFormAuthBypass` → `isOapiAllowlistRequest` →
  `isApiPath(path)` 时走 `jwtAuthMiddleware`。`auth/api-path-policy.ts:114-164` 的 `GLOBAL_GATE_EXCEPTIONS`
  白名单里**没有 `/api/admin` 或其任何子路径**，因此匿名请求（无 Bearer token）在
  `jwt-middleware.ts:150-168` 的 `jwtAuthMiddleware` 处收到 401——**「匿名被挡」实读确认**。
- `jwtAuthMiddleware`（`jwt-middleware.ts:150-168`）本身只做 token 校验和 `hydrateAuthenticatedUser`，
  **不做任何角色判断**——**「角色不鉴」实读确认**：任何已认证用户，不论角色、不论租户，都能穿过全局门，
  落到 `admin-routes.ts`/`protection-rules.ts` 的 handler；本文档列出的 13 条端点在 handler 层没有第二道拦截。

## 逐条细节

### 1. GET /safety/status — admin-routes.ts:79

- **返回什么**（实读，`guards/middleware.ts:180-189` `createSafetyStatusEndpoint()`）：
  `{ enabled: boolean, pendingConfirmations: number }`。`enabled` 来自 `getSafetyGuard().isEnabled()`，
  `pendingConfirmations` 来自 `getPendingCount()`，是一个数字。没有 payload、没有租户/用户标识、
  没有主机名/连接串。
- **跨租户否**：SafetyGuard 是进程内单例，天然没有租户维度；不是隔离失败。
- **前端调用否**：`apps/web/src` 全量搜索零命中；`scripts`/`ops`/e2e 也零命中。
- **风险类**：侦察面（低）——只泄露「当前是否有危险操作在等确认」，信息量很小。
- **建议**：加 `requireAdminRole()`（与同文件里 `/plugins/health`、`/plugins` 等一致的模式），或维持不动
  （理由：信息量极小）——两个选项都成立，留给 owner 裁决优先级。

### 2. GET /slo/status — admin-routes.ts:1357

- **返回什么**（实读，`services/SLOService.ts:122-139` `getSLOStatus()`）：`SLOStatus[]`，每条含
  `id/name/target/currentAvailability/status/errorBudget{total,consumed,remaining}` 等，来源于
  `registry.getMetricsAsJSON()`（Prometheus 指标 `http_requests_total`）的聚合计算（`calculateSLO`，
  `SLOService.ts:141-` ）。没有原始请求体、没有用户/租户标识。
- **跨租户否**：实读 `SLOService.ts:93-96`，SLO 配置的 `indicator.labels` 是空对象（仅用状态码
  `5xx` 过滤），不是按租户打标签的指标；这是平台级聚合，天然覆盖全部租户的流量，但不含任何
  租户可识别信息——同样不是「隔离失败」意义上的跨租户。
- **前端调用否**：零命中。
- **风险类**：侦察面（低-中）——暴露平台整体错误率/可用性趋势，可用于判断系统当前是否脆弱、
  是否是发起进一步探测的好时机。
- **建议**：加 `requireAdminRole()`。

### 3. GET /dlq — admin-routes.ts:1400

- **返回什么**（实读，`services/DeadLetterQueueService.ts:151-210` `list()`/`mapEntry()`）：
  `{ items: DLQEntry[], total }`，其中每条 `DLQEntry` 含 `id, topic, payload（任意 JSON，原始失败消息体）,
  error_message（原始异常文本）, retry_count, last_retry_at, status, metadata, created_at`。
  `payload` 的来源（实读确认两条生产调用链）：
  - `integration/messaging/message-bus.ts:586-597`（`handleMessageError`）：任何消息在重试耗尽后，
    把 `msg.payload` 原样连同异常对象一起 `dlqService.enqueue()`；
  - `msg.payload` 本身可以来自 `index.ts:1262-1270` 暴露给**所有插件**的 SDK
    `messaging.publish<T>(topic, payload, opts)`（插件可以发布任意业务数据），也可以来自
    `audit/AuditService.ts:222` 发布的审计事件（含 IP/UA/地理位置/错误码/`correlationId` 等审计字段）。
  - 因此 `payload` 里出现终端业务数据（插件发布的记录/事件内容）是代码路径允许且已证实的，但「生产库里
    实际存量数据的业务敏感度分布」需要真库抽样才能量化，见文末。
- **跨租户否**：实读 `db/migrations/20251216000001_create_dlq_table.ts`——`dead_letter_queue` 表**没有
  `tenant_id` 列**；`DeadLetterQueueService.list()`（`DeadLetterQueueService.ts:151-178`）的过滤条件只有
  `status`/`topic`，没有任何租户过滤。**结论：是**——任意租户失败的消息混在同一张表里，对任意已认证用户
  （不论其自己所属租户）可读，无区分。
- **前端调用否**：`apps/web/src` 对 `/admin/dlq`、`dlqService`、`DLQ`、`deadLetter` 等关键词零命中真实调用。
  唯一相关的命中是 `apps/web/src/services/integration/workbench.ts:328,1325-1643`，那是**另一套不相关的
  功能**——`/api/integration/dead-letters/:id/replay`（连接器级死信重放，属于 data-sources/集成子系统，
  不是本文档讨论的 `admin-routes.ts` 里的 `/api/admin/dlq`）。为避免混淆特此说明；本文档讨论的端点在前端零命中。
- **风险类**：信息泄露（高）——本次盘点里唯一同时命中「含业务 payload」与「跨租户」的端点。
- **建议**：加 `requireAdminRole()`，且建议在这批里优先修。

### 4. GET /shards — admin-routes.ts:1485

- **返回什么**（实读，`integration/db/connection-pool.ts:302-336` `getPoolStats()` + `:359+`
  `getMetricsSnapshot()`）：`{ summary, shards: [{ name, status, connections{total,idle,active,waiting},
  error }], metrics }`。`error` 字段是健康检查失败时 `error.message`（原始 pg 驱动异常文本，
  `connection-pool.ts:319-327`）——**没有脱敏**。这类驱动异常文本在其他端点已经被认定为风险并修过：
  近期提交 `e89f3e15e`（#5586）就是把 `data-sources` 相关接口的驱动原文回显改成 `503
  SOURCE_UNAVAILABLE` 且不回显驱动原文；本端点的 `error` 字段是同一类风险，但目前**没有**做同样的处理。
  实际驱动异常文本会不会包含主机名/端口/认证失败提示，需要真实环境触发一次连接失败才能确认具体格式，
  见文末「需要真库确认的点」。
- **跨租户否**：数据库连接池/分片是进程级基础设施，没有租户维度；这不是隔离失败，是设计上没有租户概念
  的资源。
- **前端调用否**：零命中。
- **风险类**：侦察面（中）；驱动错误文本的具体泄露程度**需真库确认**。
- **建议**：加 `requireAdminRole()`；驱动错误文本是否需要按 #5586 的模式脱敏是另一个决策点，本文档
  不下结论，列入「待裁决」。

### 5. GET /shards/:name — admin-routes.ts:1531

- **返回什么**：与 #4 相同的数据源（`poolManager.getPoolStats()`），按 `name` 过滤出单个 shard 的
  `{ name, status, connections, error }`；`name` 不存在时 404。
- **跨租户否**：同 #4。
- **前端调用否**：零命中。
- **风险类**：同 #4。
- **建议**：加 `requireAdminRole()`。

### 6. GET /queues — admin-routes.ts:1577

- **返回什么**（实读，`integration/messaging/message-bus.ts:703-727` `getStats()` +
  `dlqService.list({ limit: 0 })` 三次调用取 `total`）：`messageBus{queueLength, exactSubscriptions,
  patternSubscriptions, pendingRpcCount, ...}` + `deadLetterQueue{pending, retrying, resolved, total}`
  （只是数字，因为 `limit: 0` 不返回 `items`）+ `health{status, warnings}`。**没有** DLQ 的 `items`，
  所以不像 #3 那样含业务 payload。
- **跨租户否**：DLQ 计数来自同一张无租户维度的表，是全局汇总，不是「隔离失败」。
- **前端调用否**：零命中。
- **风险类**：侦察面（低）——泄露排队积压/DLQ 待处理数量，可用于判断系统健康度，选择攻击窗口。
- **建议**：加 `requireAdminRole()`。

### 7. GET /ratelimits — admin-routes.ts:1708

- **返回什么**（实读，`integration/rate-limiting/token-bucket.ts` `getGlobalStats()`/`getConfig()`）：
  限流配置（`tokensPerSecond, bucketCapacity, ...`）+ 全局统计（`activeBuckets, totalAccepted,
  totalRejected, rejectionRate` 等）。`showBuckets=true` 时预留了按 bucket 明细展开的分支，但**当前
  实现里这段是空的**（`admin-routes.ts:1724-1727` 注释写着「Note: We'd need to expose getAllKeys()...
  For now, return global stats only」），所以即使传 `showBuckets=true` 也不会泄露具体 bucket key 列表。
- **跨租户否**：是全局聚合数字，没有按 key/租户展开，不构成跨租户枚举。
- **前端调用否**：零命中。
- **风险类**：侦察面（低）。
- **建议**：加 `requireAdminRole()`。

### 8. GET /ratelimits/:key — admin-routes.ts:1770

- **返回什么**（实读，`token-bucket.ts:231-250` `getStats(key)`）：命中时返回
  `{ tokensRemaining, bucketCapacity, totalAccepted, totalRejected, acceptanceRate }`；未命中返回
  `{ status: 'not_tracked' }`。`key` 是路径参数，调用者可以传任意字符串。
- **跨租户否（关键发现，分两层说）**：
  - **约定层**：实读确认 bucket key 的生产约定格式是 `tenant:${tenantId}`——
    `integration/rate-limiting/message-rate-limiter.ts:159-161`（从消息 header 里取
    `tenantHeaderName` 拼成 `tenant:${tenantId}`）、`:229-231`（`getStatsForTenant`）、
    `:243-245`（`resetTenant`）都是这个格式；测试文件 `tests/sharding-e2e.test.ts:482-533` 用同样的
    `tenant:${tenantId}` 格式验证过这套限流器。所以只要这套东西被启用，`GET /ratelimits/:key` 加上
    `key=tenant:<猜测的ID>` 就能让任意已认证用户探测「这个租户 ID 存不存在」（`not_tracked` vs 有数据）、
    以及它的流量规模/接受率——这是真实的跨租户枚举设计缺口。
  - **接线层（实读，把"是否已激活"这件事坐实）**：`getMessageRateLimiter`/`MessageRateLimiter` 类
    在生产代码里**没有任何调用点**——`grep` 全 `packages/core-backend/src` 只在它自己的定义文件和两个
    测试文件里出现；`message-bus.ts` 完全不 import `rate-limiting` 目录下任何东西；`.consume(`
    的调用点也只在 `message-rate-limiter.ts` 内部和测试文件里，生产路径上不存在。`getRateLimiter()`
    这个 token-bucket 单例本身，除了 `admin-routes.ts` 自己和它的测试外，唯一的其他消费者是
    `HealthAggregatorService.ts:22`，且那里只读 `getGlobalStats()`，不 `consume()`。
  - **结论**：当前生产代码路径下，这个令牌桶**从未被写入过数据**（没有任何生产代码调用
    `.consume(key)`），所以 `GET /ratelimits/:key` 现在查任何 key 大概率都是 `not_tracked`——
    风险是「设计上存在、当前休眠未接线」，不是「正在被利用的活跃跨租户枚举面」。但如果未来有 PR
    把 `MessageRateLimiter.wrap()` 接回 `message-bus.ts`（这正是它存在的目的），这个枚举面会随之激活，
    且这条 GET 端点不会同步获得任何门。
- **前端调用否**：零命中。
- **风险类**：需接线/真库确认——静态代码分析支持「当前休眠」的结论，但不能 100% 排除有别的、
  本次搜索没覆盖到的调用路径（例如运行时动态 import、其他包里的调用）；建议真实环境跑一次流量后
  查 `/ratelimits` 的 `activeBuckets` 是否始终为 0 来做最终确认。
- **建议**：加 `requireAdminRole()`；且建议这道门应该在「重新把 `MessageRateLimiter` 接回生产消息流」
  之前就先补上，避免功能一上线就自带一个跨租户枚举面。

### 9. GET /health/detailed — admin-routes.ts:1884

- **返回什么**（实读，`services/HealthAggregatorService.ts:209-` `checkHealth()` 及其子检查）：
  `AggregatedHealth` 全量，包含：
  - `database`：同 #4 的 `shards[]`（含原始驱动 `error` 文本）；
  - `messageBus`：同 #6 的计数；
  - `plugins`：**完整的 `PluginHealth[]` 数组**（`checkPluginHealth()`，`HealthAggregatorService.ts:447-501`，
    直接 `pluginHealthService.getAllPluginHealth()`），每条含 `pluginName, status, uptime, errorCount,
    lastError{message, timestamp}, metadata`。`lastError.message` 是插件抛出的原始异常文本，
    `metadata` 是插件自定义的任意对象（`services/PluginHealthService.ts:12-24` 类型定义）；
  - `rateLimiting`：全局聚合（同 #7）；
  - `system`：`memory{heapUsed,heapTotal,external,rss,usagePercent}, uptime, nodeVersion, platform`
    （`checkSystemHealth()`，未完整读取具体行号但类型定义在 `HealthAggregatorService.ts:88-101`）。
- **跨租户否**：全部是进程级/平台级聚合，没有租户维度；不是隔离失败。
- **与既有防线矛盾（实读确认，非推断）**：同一份插件健康数据，在专门端点
  `GET /plugins/health`（`admin-routes.ts:376-383`）已经用 `requireAdminRole()` 挡住；但
  `GET /health/detailed` 通过另一条路径把包含 `lastError.message`/`metadata` 的同样内容原样吐给
  任意已认证用户——这是本仓库自己制造的一致性缺口：同一份数据，一条路径设了门，另一条没有。
- **前端调用否**：零命中。
- **风险类**：信息泄露（中）+ 侦察面（高）——Node 版本、平台、内存使用率、插件清单及其错误文本、
  数据库驱动错误原文，是典型的攻击前系统指纹信息。
- **建议**：加 `requireAdminRole()`，建议在这批里优先修（理由：暴露面最广，且与 `/plugins/health`
  的既有门形成直接矛盾）。

### 10. GET /health/summary — admin-routes.ts:1913

- **返回什么**（实读，`admin-routes.ts:1913-1940`）：`{ status, uptime, summary, hasWarnings: boolean,
  hasErrors: boolean }`——用的是 `getLastHealth()` 缓存或现算的 `AggregatedHealth`，但 handler 只挑了
  `status/uptime/summary/hasWarnings/hasErrors` 五个字段往外吐，**不包含** `subsystems` 明细。
- **跨租户否**：同 #9，平台级。
- **前端调用否**：零命中。
- **风险类**：侦察面（低）——只泄露系统整体是否健康/降级、运行时长，字段本身已经做了收窄。
- **建议**：加 `requireAdminRole()`（一致性优先于必要性——风险本身比 #9 低很多）。

### 11. GET /health/subsystem/:name — admin-routes.ts:1946

- **返回什么**（实读，`admin-routes.ts:1946-1976`）：`name` 先按白名单
  `['database','messageBus','plugins','rateLimiting','system']` 校验（非法值 400），然后跑一次完整
  `checkHealth()` 取 `health.subsystems[name]` 原样返回——**内容与 #9 对应子系统完全相同**
  （`name=plugins` 时含插件 `lastError.message`/`metadata`；`name=database` 时含驱动原始 `error` 文本）。
- **跨租户否**：同 #9。
- **前端调用否**：零命中。
- **风险类**：信息泄露（中，当 `name` 取 `plugins`/`database` 时）/ 侦察面（其余 `name` 取值时较低）。
- **建议**：加 `requireAdminRole()`。

### 12. GET /safety/rules（protection-rules.ts `GET /`） — protection-rules.ts:54

- 完整路径：`GET /api/admin/safety/rules`（挂载于 `admin-routes.ts:2022`
  `router.use('/safety/rules', protectionRulesRouter)`）。
- **返回什么**（实读，`services/ProtectionRuleService.ts:340-` `listRules()` + `protection-rules.ts:54-76`）：
  `{ rules: ProtectionRule[], count }`，每条 `ProtectionRule` 含 `id, rule_name, description, target_type,
  conditions（JSONB 规则条件）, effects（JSONB 效果，如 block/require_approval）, priority, is_active,
  version, created_by, created_at, updated_at, last_evaluated_at, evaluation_count`（类型定义
  `ProtectionRuleService.ts:28-43`）。`created_by` 是创建该规则的用户标识（字符串，实际取值取决于调用方
  传入的 `x-user-id` 或登录用户 email/ID，见文末真库确认点）。
- **跨租户否（先证伪再限定）**：实读 `migrations/053_create_protection_rules.sql:5-21`——
  `protection_rules` 表**没有 `tenant_id` 列**，`listRules()` 也没有任何租户过滤（只按
  `target_type`/`is_active` 过滤）。**这不是「多租户数据未隔离导致跨租户泄露」的洞**——这个功能本身
  就是全平台单一规则集，压根没有租户维度可言。把这条打上「跨租户」标签是不准确的；准确的表述是
  「全平台共享的治理配置，对任意已认证用户可读，且带有创建者身份标识」。
- **前端调用否**：`apps/web/src` 零命中。ops 侧：`scripts/verify-sprint2-staging.sh:155-160` 有一段
  连续 11 次 `GET /api/admin/safety/rules` 的调用，但目的是探测限流中间件是否在第 11 次返回 429
  （`protection-rules.ts:20-33` 的进程内限流器），不是读取规则内容本身；`scripts/preflight-staging.sh`
  和 `scripts/performance-baseline-test.sh` 对这个路由只有 POST（创建规则/评估）和 DELETE（清理），
  没有 GET 列表/详情调用。
- **风险类**：信息泄露（低-中）——治理策略配置 + 创建者身份标识，不是终端业务数据行。
- **建议**：加 `requireAdminRole()`，或按仓库里已有的 `rbacGuard(resource, action)` 模式（例如
  `routes/audit-logs.ts:10` 的 `rbacGuard('audit', 'read')`）新增一个类似
  `rbacGuard('safety-rules', 'read')` 的细粒度码——两个选项都成立，具体资源/动作命名待裁决。
  另需注意：本子路由的写操作（`POST /`、`PATCH /:id`、`DELETE /:id`、`POST /evaluate`）同样零角色门，
  但不在本次任务范围内，这里只作提示，不展开盘点。

### 13. GET /safety/rules/:id（protection-rules.ts `GET /:id`） — protection-rules.ts:82

- 完整路径：`GET /api/admin/safety/rules/:id`。
- **返回什么**（实读，`ProtectionRuleService.ts:303-` `getRule()` + `protection-rules.ts:82-105`）：
  单条 `ProtectionRule`，字段结构与 #12 相同；不存在时 404。
- **跨租户否**：同 #12——表无 `tenant_id`，功能本身无租户维度，不是隔离失败。
- **前端调用否**：零命中。
- **风险类**：同 #12。
- **建议**：同 #12。

## 建议分批

按「暴露面大小 × 是否已有实读证据」排的一个可能分批方式，供 owner 参考、不代表最终决定：

1. **第一批（证据最强，建议优先）**：`GET /dlq`（业务 payload + 内容级跨租户，双高）、
   `GET /health/detailed`（暴露面最广，且与 `/plugins/health` 的既有门直接矛盾）、
   `GET /health/subsystem/:name`（同一份数据的另一条路径，应与 `/health/detailed` 一起改，否则等于
   只堵了一个门留了一个后门）。
2. **第二批（平台级基础设施侦察面，风险中等，建议成组处理）**：`GET /shards`、`GET /shards/:name`
   （驱动错误文本回显问题与 #5586 同类）、`GET /queues`、`GET /ratelimits`、`GET /ratelimits/:key`
   （建议赶在 `MessageRateLimiter` 重新接线之前修）。
3. **第三批（低风险、纯一致性）**：`GET /safety/status`、`GET /slo/status`、`GET /health/summary`。
4. **第四批（治理配置，独立评审）**：`protection-rules.ts` 的 `GET /`、`GET /:id`——因为涉及
   `rbacGuard` 资源/动作码命名的裁决，且与该子路由的写操作缺口关联，建议单独过一轮，不与上面三批混合。

## 需要真库确认的点

- `GET /shards`/`GET /shards/:name`/`GET /health/detailed` 里 `error` 字段的**实际文本格式**：本文档
  只证明了代码路径上会把 `error.message` 原样吐出，没有在真实环境触发一次连接失败去看实际
  pg 驱动异常文本长什么样（是否含主机名/端口/认证失败提示）。需要真库/真实环境才能定档这条与
  #5586 修复模式的相似程度。
- `GET /health/detailed`（及 `/health/subsystem/:name` 取 `name=plugins`）里
  `PluginHealth.lastError.message`/`metadata` 的**实际内容**：取决于各插件实现在抛错误时具体传了什么，
  需要在真实运行环境让某个插件报错后观察实际字段内容。
- `GET /dlq` 的 `payload` 在**生产数据里的实际业务敏感度分布**：本文档证明的是「代码路径允许 DLQ
  payload 含终端业务数据」，没有证明「生产库里已经存了多少这类数据、敏感到什么程度」——需要连真库
  抽样 `dead_letter_queue` 表才能给出比例。
- `GET /ratelimits/:key` 对应的令牌桶**是否真的从未被生产路径 `consume()` 过**：本文档的结论
  （「当前休眠未接线」）来自静态 grep（`message-bus.ts` 不 import `rate-limiting`，`.consume(` 只出现在
  `message-rate-limiter.ts` 内部和测试里），不能 100% 排除本次搜索没覆盖到的调用路径（例如插件运行时
  动态调用、其他包间接引用）。建议真实环境跑一段真实流量后查 `GET /ratelimits` 的 `activeBuckets`
  是否始终为 0 来做最终确认。
- `protection_rules.created_by` 在真实数据里的**实际取值格式**（email/用户 ID/字面量 `'system'`）：
  决定这条身份标识泄露的具体颗粒度，代码里两个入口（`x-user-id` header 与登录用户 email/ID）都能写入，
  哪个占多数需要真库确认。

## 与前提不符的实读发现

- 任务给出的估计行号（`safety/status`:79、`slo/status`:1392、`dlq`:1435、`shards`:1530、
  `shards/:name`:1576、`queues`:1622、`ratelimits`:1763、`ratelimits/:key`:1825、`health/detailed`:1949、
  `health/summary`:1978、`health/subsystem/:name`:2011）与本次在 `origin/main`（HEAD `9fb29831c`）
  实读到的行号有出入（除 `safety/status`:79 精确吻合外，其余普遍相差约 30-35 行，例如
  `slo/status` 实际在 :1357、`dlq` 实际在 :1400、`health/detailed` 实际在 :1884）。本文档全部使用
  本次实读到的行号；差异大概率来自任务描述编写时对照的是稍早的一个 revision，文件在那之后有过
  与本文档主题无关的增量改动（如新增了 `yjs/status` 等端点）。任务原文列出「约 12 条」，本次实读
  `admin-routes.ts` 里符合「GET + 无角色门」条件的正好是 11 条，加 `protection-rules.ts` 的 2 条，
  合计 13 条，与「约 12 条」的估计在同一量级，视为吻合。
- 任务要求盘点的 `protection-rules.ts` 子路由挂载路径实际是 `/safety/rules`
  （`admin-routes.ts:2022` `router.use('/safety/rules', protectionRulesRouter)`），完整路径是
  `/api/admin/safety/rules`，与任务描述一致，未发现出入。
