# PLMAdapter Bearer 令牌不再写回 config.connection(#5648 §6 后续单 F02)

日期:2026-09-12
分支:`fix/plm-adapter-token-not-persisted-in-connection`
改动文件:`packages/core-backend/src/data-adapters/PLMAdapter.ts`、`packages/core-backend/tests/unit/plm-adapter-token-not-persisted.test.ts`

## 1. 问题:"PUT 一次就把进程内令牌落库一次"

行号以本分支基线 `origin/main`(9fb29831c)为准。

修复前 `PLMAdapter.connect()` 在拿到令牌后把它写进**公共配置对象**:

```
packages/core-backend/src/data-adapters/PLMAdapter.ts:1075-1081   connect():  headers.Authorization = `Bearer ${token}`; this.config.connection.headers = headers
packages/core-backend/src/data-adapters/PLMAdapter.ts:1200-1206   cacheAuthToken(): 同样再写一次(yuantus 登录成功后也走这里)
```

这份 `connection` 不是适配器私有的,它是数据源"公共半边",整条落库链:

| 环节 | 位置 | 做了什么 |
| --- | --- | --- |
| 取配置 | `data-adapters/BaseAdapter.ts:547-549` | `getConfig()` 返回 `{ ...this.config }` —— **浅拷贝**,`connection` 是同一个对象引用,令牌随之外泄给任何调用方 |
| PUT 读旧值 | `routes/data-sources.ts:634` | `const oldConfig = existing.getConfig()`(存活适配器,已 connect,headers 里就带着令牌) |
| PUT 深合并 | `routes/data-sources.ts:648-660` | `connection: { ...oldConfig.connection, ...parse.data.connection }` —— 请求体没带 `headers` 时,旧 `headers`(含令牌)原样进入 `newConfig` |
| 落库整形 | `data-adapters/DataSourceManager.ts:395-412` | `configToRecord()` 把 `config.connection` **原样**塞进 `record.config`;只有 `credentials` 过 `encryptCredentials()` |
| 写库 | `data-adapters/DataSourceManager.ts:750-780` | `persistDataSource()` upsert `data_sources` 行 —— 令牌**明文**入库,且每次 PUT 覆写一次 |

同一份 `connection` 还有两条旁路泄漏:`routes/data-sources.ts:321-327` 的 `sanitizeConfig()` 只剥 `credentials`,所以令牌同时出现在
- PUT 响应体(`routes/data-sources.ts:684-690`),以及
- `audit_logs.meta.before/after`(`routes/data-sources.ts:670-682`)。

复现见 spec 用例"整链:PUT 的深合并 + configToRecord 之后,落库 JSON 里没有令牌"——它直接调用真实的 `DataSourceManager.configToRecord`,修前的实际红是:

```
{"connection":{"url":"http://127.0.0.1:…","baseURL":"…","headers":{"Authorization":"Bearer fake-static-token-for-tests-0001","x-tenant-id":"tenant-a"}},"options":{},"poolConfig":{}}
```

## 2. 修法:令牌只活在实例上,连接时贴到 axios 客户端

- `connect()`(现 :1086-1091)只调 `cacheAuthToken(token)`,不再碰 `this.config.connection`。
- `cacheAuthToken()`(现 :1230-1233)只写实例字段 `authToken` / `authTokenExpiresAt`(这两个字段本来就存在,无需新增私有字段)。
- 新增 `applyAuthTokenToClient()`(现 :1245-1250),在 `await super.connect()` 之后、本函数发出任何请求(`refreshIntegrationCapabilities()`)之前调用。

为什么写 `client.defaults.headers` 的**扁平槽位**而不是 `.common`:

`HTTPAdapter.connect()`(`data-adapters/HTTPAdapter.ts:138-149`)原来就是把 `connection.headers` 整个塞进 `axios.create({ headers })`,axios 在发请求时把 `defaults.headers.common` 先铺、扁平 key 后铺,所以扁平槽位**赢过** `common`。写 `.common` 会让本次 connect 解析出的令牌输给两类值:
1. `config.credentials.bearerToken` 经 `HTTPAdapter.connect():160-161` 写进 `defaults.headers.common.Authorization` 的值;
2. `connection.headers` 里手工设置的、或**本 bug 已经落库、重启后回读的过期** `Authorization`。

第 2 条是真实回归风险(老行里就躺着旧令牌),所以扁平槽位是唯一与修复前等价的位置;顺带保留了旧代码的 `delete headers.authorization`(小写变体),避免一个请求带两份凭据。spec 用例"连接里遗留的旧 Authorization 头不得盖掉刚解析出的令牌"钉住这条优先级。

各模式的请求头来源(修复后):

| 模式 | 令牌来源 | 送达路径 |
| --- | --- | --- |
| legacy + 静态令牌(`plm.apiToken`/`PLM_*`) | `cacheAuthToken` | `applyAuthTokenToClient()` 写的客户端默认头 |
| yuantus + 用户名口令 | `fetchYuantusToken()` 登录 | 连接时 `applyAuthTokenToClient()`;会话中刷新走 `setTokenProvider`(现 :1133-1138)注册的请求拦截器(`HTTPAdapter.ts:171-187`),它逐请求覆写 `Authorization` |
| 讨论区写路径 | 调用方每次自带 | `yuantusDiscussionFetch`(现 :2609+)本来就不读 `connection.headers`,未受影响 |

401 语义、`invalidateAuthToken()`、`query()` 的 401 重试条件都没动:tokenProvider 的注册条件仍旧只有 yuantus 分支那一处,所以 legacy 模式不会因为本次改动多出一次 401 重试。

## 3. 顺手改的一处日志(#5648 F01 相邻点,只改日志不改语义)

`:1149` 的 `PLM Adapter connecting to …` 直接打印 `connection.url`,而 `PLM_BASE_URL` 允许形如 `scheme://user:pass@host` 的 userinfo。新增模块级 `redactUrlUserinfo()`(:7-16),把 userinfo 段换成 `<redacted>@` 再打印;连接用的 URL 不变。规则与 `services/ai-provider-client.ts` 的 `stripUrlUserinfo` 一致,复制而非 import——数据适配器不该把 AI provider 模块拖进依赖图。

## 4. 没改什么,以及理由

1. **`resolvedUrl` 写回 `config.connection.url/baseURL`(基线 :1069-1073,现 :1080-1085)——保留,按任务约定回报不改。** 它有外部消费者:
   - `HTTPAdapter.connect():138` 用 `connection.baseURL || connection.url` 建客户端。只配 `plm.url`/`PLM_BASE_URL`、`connection.url` 为空的数据源,一旦改成私有字段,父类就拿不到 baseURL(除非改 `HTTPAdapter`,而它是本次要避开的争用面)。
   - `getRuntimeStatus()`(现 :1336-1341) 的 `configured` 判定、`GET /api/data-sources/:id` 经 `sanitizeConfig` 的 UI 回显,都读这个值。
   - URL 主体不是令牌；但带 userinfo 时那一段**是凭据**——本刀只在日志侧脱敏，落库/回显仍原样（R1，#5648 F01 的迁移设计另单）。代价:PUT 仍会把"适配器解析出的 URL"写回库,属于同一种"适配器改公共配置"模式,登记为残余。
2. **`applyTenantOrgHeaders()`(现 :1196-1213)仍写 `connection.headers` 的 `x-tenant-id`/`x-org-id`** —— `getEffectiveTenantId()`(现 :1035-1047)明确以"connect 后 connection.headers 上的 x-tenant-id"为事实来源,embed 中继据此做租户交叉校验;动它会动租户闭合语义,超出本单范围。且这两个值本来就是配置的一部分,不是凭据。
3. **`routes/data-sources.ts` / `BaseAdapter.ts` / `data-source-secret-keys.ts` 未改** —— #5648 在飞,避免争用。因此:`getConfig()` 的浅拷贝、`sanitizeConfig()` 只剥 credentials 这两条**结构性**问题仍在,本 PR 只是让 PLM 令牌不再进入那条链。
4. **未做历史数据清理** —— 修复前已写进 `data_sources.config.connection.headers.Authorization` 的旧令牌,本 PR 不会删。重启后它仍会被 `axios.create` 采纳,但只要配置里仍能解析出令牌,`applyAuthTokenToClient()` 就会覆盖它;真正的清理(以及旧令牌吊销)要 owner 侧动库/换令牌。

## 5. 残余

| 编号 | 残余 | 说明 |
| --- | --- | --- |
| R1 | #5648 F01:URL userinfo | 本 PR 只脱敏了 PLM 连接日志这一处;`connection.url` 本身仍原样落库/回显。**叠加提交后扩到两条 fetch 腿的错误面,见 §6**;落库/回显与"fetch 腿不接受 userinfo URL"的功能问题仍未动 |
| R2 | #5648 F03:密钥词表 | `connection` 里还有哪些 key 该被当秘密(`headers` 下的任意 `*-token` / `x-api-key` 等)由 #5648 的词表决定,本 PR 不引入新词表 |
| R3 | 进程内写入口 | `getConfig()` 浅拷贝 + 适配器可写 `this.config.connection` 这条模式依然成立(`resolvedUrl`、租户头就是例子);要根治得在 `BaseAdapter`/写入口上做(深拷贝或冻结),属于 #5648 及其后续单 |
| R4 | 旧行里的明文令牌 | 见 §4.4,需要 owner 侧清理 + 吊销 |
| R5 | ~~新 spec 未进任何 CI 闸~~（复核订正：**已被必跑的 `test` job 全量收**——`plugin-tests.yml:842-844` 的 `pnpm --filter @metasheet/core-backend test` = `vitest`，`vitest.config.ts` 无 include、exclude 不含 tests/unit；无需改 workflow） | 见验证文档 §5 |

## 复核订正（对抗复核 23 代理，10 条发现 → 0 存活；终审「修完 X 再合」）

- **保证①的措辞限定**：「不再写回 `config.connection`」指**本次 connect 解析出的令牌**；修复前已经落库的 `data_sources.config.connection.headers.Authorization` 与 `audit_logs.meta` 里的历史副本本刀不清、也清不掉审计副本——owner 须吊销/轮换（R4）。修复后 PLMAdapter 不再删旧键，`GET /:id`、PUT 响应、`PUT /credentials`（routes:745-756）与 DELETE 审计（:866）仍会把存量旧值原样回显——零回归、单调改善，但不是「已无泄漏」。
- **时序窗口（本刀新引入、已关）**：`HTTPAdapter.connect()` 在 `connected = true` 之后 `await onConnect()` 才返回；原实现等 `super.connect()` 返回后再接线令牌，留下一个微任务级窗口——并发调用方（如 facade 的 `if (!adapter.isConnected())` 模式）可能发出不带 Authorization 的请求。现改为在 `onConnect()` 的同步段接线，并用 spec 钉住「`super.onConnect()` 被调用时默认头已含令牌且 `connected` 已真」。
- **axios 版本**：仓内锁定 1.13.2（`pnpm-lock.yaml:2053`），不是 1.8.x；合并次序结论按 1.13.2 的 `Axios.js:118-130` + `AxiosHeaders.js:79-92` 源码核过（扁平后铺、findKey 大小写不敏感、后写覆盖）。`applyAuthTokenToClient` 里 `delete defaultHeaders.authorization` 按该语义冗余，留作防御，未加测试。
- **没人看的路径（终审）**：带 userinfo 的 baseURL 会让 axios `http.js:574-580` 删掉 authorization 改走 Basic——Bearer 根本到不了线（修前同，用例 7 不断言 wire）；归 #5648 F01。`credentials.bearerToken` 全仓零写点（`docs/DATA_SOURCE_ADAPTERS.md:247-252` 却列出），优先级论证靠槽位同一性而非测试。

## 6. 追加(叠加提交):两条 fetch 腿的**错误面**打码(#5648 F01 ①a)

§3 只处理了 `connect()` 那一条 `logger.info`。W4-J 实读把同一类泄漏在**错误面**上又找出两处——它们不走 axios,走 Node 内置 `fetch`:

| 腿 | fetch 调用 | 修前的错误出口 |
| --- | --- | --- |
| Yuantus 登录 `fetchYuantusToken()` | 现 `:1389` | `catch (_err) { return null }` 整个吞掉;`connect()`(旧 `:1124`)打一条**误导性**告警,叫操作员去查 `PLM_USERNAME/PLM_PASSWORD` |
| discussion 会话/写 `yuantusDiscussionFetch()` | 现 `:2708` | `error: err instanceof Error ? err : new Error(String(err))` —— **原错误对象**直接进 `QueryResult.error` |

### 6.1 事实:message 里就是明文口令

`connection.url/baseURL` 形如 `scheme://user:pass@host` 时,`fetch` 在 **Request 构造阶段**(还没发包)就抛 `TypeError`,而 Node 把 URL **原样**嵌进 message。本机 Node v25.9.0 实测两种形状:

```
Request cannot be constructed from a URL that includes credentials: http://u:<口令原文>@host/api/v1/auth/login
Failed to parse URL from http://u:<口令原文>@host/api/x        # 口令里含 '/' 时走这条,且 cause.input 也带原文
```

于是 discussion 腿把明文口令交到了适配器边界之外。两条 relay 路由(`routes/plm-embed-discussion.ts:217-224`、`-read.ts:196+`)当前确实不回显 message(统一映射成 `EMBED_DISCUSSION_*` + 502),所以今天没有 HTTP 层泄漏;但那是**消费者的选择**,不是适配器的保证——同文件里 `routes/plm-workbench.ts:1131/1219` 就是把 `result.error.message` 直接塞进响应体的反例(那两处走 axios 腿,不经本次改动)。登录腿则相反:今天**不**泄漏(错误被整个吞掉),坏在没有任何可定位信息 + 告警指错方向。

### 6.2 修法

1. **`redactErrorText()`(:55)—— 专供错误文本的两层打码**,与 `redactUrlUserinfo()`(:14,#5679 加的)并存而不是替换:
   - **值层**:把本适配器交给 fetch 的那些 URL(`connection.baseURL` / `connection.url`)的 userinfo 段**按字面量**从文本里抹掉,形状无关。
   - **形状层**:再过一遍 `redactUrlUserinfo()`,兜住不是我们构造的 URL(上游 `detail` 回显的跳转目标等)。
   - **为什么一层不够(实测,不是推测)**:共享正则的 userinfo 段是 `[^/\s]*@`,口令里只要含**空格**或 `/`,这个字符类就被截断、后面跟不上 `@`,**整条正则不匹配**,口令原文原封不动留在文本里。两种形状都在新 spec 里钉住了。
   - `extractUrlUserinfo()`(:30) 故意不用 `new URL()`:到得了这里的 URL 恰恰是 URL 解析器拒绝的那些。取 `://` 到(去掉 query/fragment 后)**最后一个 `@`**,宁可多打码——路径里带 `@` 又没凭据的 base URL 会连主机名一起被遮,代价是错误文本少一点可读性;少遮一个字符的代价是一条明文凭据。
2. **登录腿改成结构性不外带**(:1412):catch 只把**错误类型名**记进私有字段 `lastTokenFetchFailureKind`(:1052),message 从此不进任何汇——不是"打码后再打",是根本不打。返回值语义不变,登录失败对调用方仍是 `null`。
3. **告警改成 values-free 且不误导**(:1180-1187):`connect()` 按上面那个字段分两支——"请求根本没发出去(附类型名,明说凭据**未被验证**、先查 base URL 形状)" vs 原来那条凭据告警(服务端确实拒登时才打,语义不变)。
4. **discussion 腿返回打码后的新 Error**(:2724-2726):`PLM discussion request failed (TypeError): <打码文本>`。**不**把原错误挂成 `cause`——"Failed to parse URL" 那条变体的 `cause.input` 同样带 URL 原文。信封语义不变:这个 catch 只会产生传输层错误,从来不带 `.response`,relay 的 `providerErrorStatus()` 照旧读到 null、照旧降级 502。
5. **非 2xx 分支的 `detail`(:2746)也过一遍打码**:它是上游可控文本,有些网关会把请求 URL 回显进去。不含 URL 时是恒等变换(新 spec 有"原样回传"的不回归用例)。`response.data` 原样不动——那是上游载荷、不是我们的 URL,重塑它会改消费者读到的形状。

### 6.3 不在本刀里的(留给 F01 裁决)

- **功能问题**:`fetch` 腿根本不接受带 userinfo 的 URL —— 这两条腿在这种配置下**必然失败**(登录拿不到令牌、discussion 全部 502)。本刀只保证"失败时不泄漏、且报得准",**没有**让它们跑通;怎么迁移(改写 URL 为 Basic 头 / 拒绝这种 URL 落库 / 兜到 credentials)属于 #5648 F01 的迁移设计。附带说明:axios 腿在同样配置下会走 Basic(设计文档终审那条),两条腿行为**不一致**,这本身就是 F01 要裁的东西。
- `HTTPAdapter.ts` / `BaseAdapter.ts` / `routes/*` 未动(§4.3 同因:#5648 在飞,避开争用)。因此 `routes/plm-workbench.ts:1131/1219` 那两处 `result.error.message` 直传仍在——它们消费的是 axios 腿的错误,不在本刀射程内,登记为残余 R6。

### 6.4 残余(接 §5)

| 编号 | 残余 | 说明 |
| --- | --- | --- |
| R6 | axios 腿的错误文本未打码 | `routes/plm-workbench.ts:1131/1219` 把 `result.error.message` 直传响应体;axios 错误是否会带上 userinfo 未实证(axios 对带 userinfo 的 URL 走 Basic,见终审那条),要动得先动 `HTTPAdapter`——避开争用,留给 F01 |
| R7 | 值层依赖"URL 还在 config 上" | `redactErrorText` 的值层读 `this.config.connection.{baseURL,url}`;若将来 URL 改由别处提供(F01 迁移的可能结果),值层会退化成只剩形状层,那时空格/斜杠形状会重新漏——新 spec 的两个形状用例就是那时的探针 |
