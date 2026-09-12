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
   - 它不是秘密(userinfo 的部分已在日志侧脱敏)。代价:PUT 仍会把"适配器解析出的 URL"写回库,属于同一种"适配器改公共配置"模式,登记为残余。
2. **`applyTenantOrgHeaders()`(现 :1196-1213)仍写 `connection.headers` 的 `x-tenant-id`/`x-org-id`** —— `getEffectiveTenantId()`(现 :1035-1047)明确以"connect 后 connection.headers 上的 x-tenant-id"为事实来源,embed 中继据此做租户交叉校验;动它会动租户闭合语义,超出本单范围。且这两个值本来就是配置的一部分,不是凭据。
3. **`routes/data-sources.ts` / `BaseAdapter.ts` / `data-source-secret-keys.ts` 未改** —— #5648 在飞,避免争用。因此:`getConfig()` 的浅拷贝、`sanitizeConfig()` 只剥 credentials 这两条**结构性**问题仍在,本 PR 只是让 PLM 令牌不再进入那条链。
4. **未做历史数据清理** —— 修复前已写进 `data_sources.config.connection.headers.Authorization` 的旧令牌,本 PR 不会删。重启后它仍会被 `axios.create` 采纳,但只要配置里仍能解析出令牌,`applyAuthTokenToClient()` 就会覆盖它;真正的清理(以及旧令牌吊销)要 owner 侧动库/换令牌。

## 5. 残余

| 编号 | 残余 | 说明 |
| --- | --- | --- |
| R1 | #5648 F01:URL userinfo | 本 PR 只脱敏了 PLM 连接日志这一处;`connection.url` 本身仍原样落库/回显 |
| R2 | #5648 F03:密钥词表 | `connection` 里还有哪些 key 该被当秘密(`headers` 下的任意 `*-token` / `x-api-key` 等)由 #5648 的词表决定,本 PR 不引入新词表 |
| R3 | 进程内写入口 | `getConfig()` 浅拷贝 + 适配器可写 `this.config.connection` 这条模式依然成立(`resolvedUrl`、租户头就是例子);要根治得在 `BaseAdapter`/写入口上做(深拷贝或冻结),属于 #5648 及其后续单 |
| R4 | 旧行里的明文令牌 | 见 §4.4,需要 owner 侧清理 + 吊销 |
| R5 | 新 spec 未进任何 CI 闸 | 见验证文档 §5:仓库里没有"跑整个 tests/unit"的 lane,而本单不允许改 `.github/workflows/*` |
