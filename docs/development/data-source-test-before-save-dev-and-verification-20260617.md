# 数据库连接页 test-before-save — 开发与验证记录 — 2026-06-17

> 目标:把"测试连接前置(test-before-save)"方案落地执行,完成全部计划,给出开发与验证 MD。
> 形态:design-lock → Slice 1 (BE) → Slice 2 (FE),各自独立 PR + 独立 opt-in;BE 刀子智能体复审;实库集成测试 CI 实跑(不静默 skip)。

## 0. 交付总览

| 阶段 | PR | 内容 | 状态 |
|---|---|---|---|
| design-lock | #2818 | 契约与边界(含 owner 复审 P1/P2a/P2b + 两钉子) | MERGED `1ae544192` |
| Slice 1 (BE) | #2822 | `testEphemeralConnection` helper + `POST /api/data-sources/test` + 测试 | MERGED `226cbea63`(2026-06-18 03:46) |
| Slice 2 (FE) | #2827 | create / 凭据轮换表单内「测试连接」+ 内联结果 + 测试 | MERGED `31a5efe05`(2026-06-18 03:54) |

## 1. 问题与方案

旧流程:`GET /api/data-sources/:id/test` 只认已存库 id → 必须先保存(创建源)才能测,host/凭据填错时已造出坏源。
方案:新增 stateless `POST /api/data-sources/test`,用当前表单参数**临时试连、零持久化**,在保存前就地暴露连接错误。

## 2. Slice 1 (BE) — 实现要点

- **`DataSourceManager.testEphemeralConnection(config)`**(封装于 manager,**钉子①**):`adapterTypes.get(type)` 直接 `new AdapterClass(config)` 构造临时 adapter;**不**走 `addDataSourceInternal`、**不**写 `adapters/scopes/connectionPool`、**不**接 manager 事件转发(仅一个本地 no-op `error` 吞掉,防 `onError` 的 `emit('error')` 抛未捕获);`try connect→probe→取 {success,latency,error}`,`finally disconnect()+removeAllListeners()`。
- **`POST /api/data-sources/test`**:`rbac data_sources:write`(owner 确认:按任意参数主动外连属 write 级);复用 `DataSourceCreateSchema`(type allowlist);**结果面响应**(**钉子②**)`{ success, latency, error.message }`,绝不 echo 提交的 config/connection/credentials。
- 作用域 = create + 凭据轮换;edit 不接(凭据 write-only);凭据存储边界不变。

## 3. 复审发现与修复(BE 子智能体复审 ×2)

两个 FIX-FIRST,均已修:

- **M1 失败路径连接池泄漏**(runtime/security):helper 的 `if(isConnected())disconnect()` 在 connect 失败时跳过(connected 未置真),且各 SQL adapter 的 `connect()` catch 未关闭已建的池 → 失败一次泄漏一个 pg/mysql Pool(test-before-save 的失败是主路径,非边角)。
  **修复(根因/adapter 层)**:`PostgresAdapter`/`MySQLAdapter` 的 `connect()` catch 增加 `await this.pool?.end(); this.pool=null`;`MSSQLAdapter` 增加 `await this.pool?.close()` 再置 null。connect 永远重建 pool,故置 null 安全;同时修了既有 `/:id/test` 的同源泄漏。新增 adapter 单测(坏 host→connect reject→`pool===null`)。
- **MAJOR 失败错误回显提交的 host/username**(test/contract):`redactSecrets` 只脱敏 password/token/apiKey,不脱 username/host;真实 PG 失败 `password authentication failed for user "x"` 会回显用户名,与本端点 no-echo 标准冲突,且失败路径 no-echo 此前无测试覆盖。
  **修复(本端点作用域)**:`testEphemeralConnection` 对返回的 error 额外剥离提交的 host/server/database/username(长度≥3 防短值误伤;password 已由 adapter 脱敏),**不动**共享 `redactSecrets`(`/:id/test` 诊断不变);错误**类别**保留(可操作)。新增失败路径 no-echo 测试(host+username+password 全不出现)。

MINOR/NIT(记录,未阻断):redaction 对 connection-string userinfo 的潜在盲点(无 adapter 消费连接串,latent);`/test` 无请求超时;`/test` 未审计;实库 row-count 断言在非 db-backed 测试环境为弱断言(in-memory 未注册才是零持久化的硬证)——这些列为后续。

## 4. 测试与验证(values-free)

**Slice 1 单测** `data-source-test-ephemeral.test.ts`(8):helper 成功(+latency、零注册、disconnect+removeAllListeners 触发)/ 失败(脱敏、host+username+password 不泄漏)/ 不支持类型抛错;路由 400 allowlist / 400 malformed / **成功结果面无回显** / **失败结果面无回显(host+username+password)** / **零持久化**(控制源在、测试 id 不在 + 404)。
**Slice 1 adapter 单测** `data-source-connect-failure-cleanup.test.ts`(2):Postgres/MySQL connect 失败 → reject + `pool===null`。
**Slice 1 实库集成** `data-source-test-ephemeral-realdb.test.ts`(3):实库成功(+latency)/ 不可达失败(脱敏)/ 零持久化(`data_sources` count 不变 + 未注册 + 404)。**已在 `plugin-tests.yml` 显式枚举 + 硬 `${DATABASE_URL:?...}` 守卫 → CI 实跑,不静默 skip。**
**Slice 2 组件/wire 测** `data-sources-ui.spec.ts`(+4):成功渲染 latency + **断言 POST body == buildCreatePayload(防 wire 漂移)** + 不自动建源;失败渲染脱敏 message;edit 隐藏按钮;凭据模式仅在新密钥后出现。

**本地验证**:BE `tsc` build 通过、eslint 通过、单测 95 passed(data-source 全量,集成本地按 DATABASE_URL 跳过)+ 新 adapter 测 2/2;FE `vue-tsc -b` 通过、eslint 通过、`data-sources-ui` 39/39。
**CI**:Slice 1 #2822 全检查通过(含 `test (20.x)` 实库集成 6m59s PASS = 枚举的 ephemeral 实库套件在 CI 实跑),squash `226cbea63` 已落 main;Slice 2 #2827 全检查通过(FE `data-sources-ui` 39/39 + `vue-tsc -b` + e2e),squash `31a5efe05` 已落 main。三 PR 落地序:#2818(design-lock)→ #2822(BE)→ #2827(FE),FE 始终在 BE 端点上线之后合并。

## 5. 待 owner / 可覆盖决策

- **no-echo 取严**:失败错误剥离用户提交的 host/username(只留错误类别)。备选"保留完整诊断细节(用户自有非密输入)"也成立;此处取严是因 owner 写了钉子②、不可询问时默认从严。可改回。
- **不硬门控保存**:失败仅强提示,不阻断(owner 确认)。
- **rbac `write`**:按任意参数外连属 write 级(owner 确认)。
- **edit 场景预验证 = v2**:`POST /:id/test-draft`(后端 merge 存量密钥 + 非密 draft),单独 opt-in,未做。

## 6. 结论

test-before-save 全链路(契约 → BE 临时试连路由 → FE 表单内按钮)按 design-lock 落地,两处复审 FIX-FIRST 已修并加测,实库集成 CI 实跑。可视为方案完成。

> 后续(post-#2839)follow-ups + 实体机发现见 §7。

## 7. 后续与实体机发现 (post-release, 2026-06-18)

本节记录 #2839 留档之后的两项后续——一项主动加固,一项**实体机抓到、而我静态复审 + 单测都漏掉的真实漏洞**。

### 7.1 端点加固 #2846(`341d1425b`)

关闭复审记录的 m3/m4 两个 MINOR:
- **连接超时收敛**:`testEphemeralConnection` 按各 driver knob 注入 10s 连接超时(pg `poolConfig.acquireTimeout`——原 30s 默认;mysql2 `options.connectTimeout`;mssql `connection.connectionTimeoutMs`),仅在 caller 未设时默认。hang 住的 host 现在快速失败(并经既有 catch 释放连接池),不再占住请求 ~30s。
- **审计留痕**:`POST /api/data-sources/test` 写审计记录(`action=test`,id/name/type + success),values-free,给"按任意参数主动外连"的 write 级能力留 SSRF-probe 痕迹。
子智能体复审判定 SHIP;补了失败路径审计断言、三 knob caller-override、审计 meta 精确键约束。

### 7.2 HTTP baseURL no-echo 漏洞 → #2845(`21d29403d`)

- **gap**:Slice 1 的 `scrubInput` 只枚举了 **SQL 连接形状**(host/server/database/username),没枚举 **HTTP 形状**——HTTP 数据源 endpoint 在 `connection.baseURL`/`url`,HTTP client 失败文本会回显它。
- **证据**:实体机在包 `f6e818e73` 上跑出 `draftTestResponseEchoesSubmittedUrl=true`(本 issue #2769 线程,@adharamans 2026-06-18)。
- **修复**:#2845 把 `scrubInput` 扩到 host/server/database/**baseURL/baseUrl/url**/username,并对 URL 值额外解析 `origin/host/hostname` 一并剥、按长度降序剥;仍 scoped 在 helper、不动共享 `redactSecrets`。重测包 `21d29403d` → `draftTestResponseEchoesSubmittedUrl=false` PASS。
- **教训(forward guardrail)**:
  1. redaction/no-echo 必须**按 connection 形状逐一枚举**(SQL host vs HTTP baseURL);漏一种形状就漏一个回显面。
  2. no-echo 测试必须**含 HTTP 形状 payload**,不能只用 SQL fixture——本次正是 SQL-only fixture 制造了测试盲点(wire-vs-fixture)。
  3. 静态复审当时把 connection-URL 判为 "latent / 无 adapter 消费 connection-string" 是**错的**:HTTPAdapter 消费 `baseURL`,它是 live 不是 latent。实体机冒烟补上了静态复审 + SQL-only 单测的盲区。
- **仍存 latent 边角**:URL userinfo 里的裸密码(`user:pw@host` 且错误只回显 pw 片段)仍不保证;目前无 bundled adapter 把连接串解析成凭据,故 latent。
- **前瞻硬化(未做,待 owner 定)**:`scrubInput` 改为**通用剥 `connection` 内所有 string 值 + username**,而非维护枚举 allow-list,可免将来新增 adapter 字段重蹈覆辙。

### 7.3 实体机包锚点

- `f6e818e73` — test-before-save 首包(含 #2822/#2827)→ 抓到 §7.2 漏洞。
- `21d29403d` — no-echo 修复包(含 #2846 + #2845)→ 重测 PASS。
