# connection URL userinfo 的迁移设计（#5648 设计 §6 后续单 F01）

- 日期：2026-09-12
- 分支：`docs/data-source-url-userinfo-migration-design`（基线 `origin/main` @ `9fb29831c`）
- 范围：**零代码**。本文只做实读盘点 + 分期方案 + 待裁决清单，不改任何源码、不建迁移脚本文件。
- 关系：#5648 把"`connection` 下的**口令类键**写入即拒、读取剥离"收敛到 `data-source-secret-keys.ts`；该模块头注释自己把 **URL userinfo 值面**列为三个"键名判据看不见"的反例之首（`data-source-secret-keys.ts` 头注释第 31-35 行，`fix/data-source-secret-keys-vocab-nfkc` 分支实读）。本文就是那条后续单。
- 文档纪律：不出现任何真实主机 / 账号 / 口令。示例统一用 `https://<user>:<pw>@api.example.invalid`。

---

## 0. 一句话结论与推荐分期

**userinfo 不能像秘密键那样直接 400 拒收**——它在 axios 腿上是**真的在认证**，拒收会打断现网。但它在 `fetch` 腿上**根本不工作、而且把明文口令塞进 Error.message**。因此推荐的顺序是：

> **①日志/错误面先打码（零语义变更）→ ①b 读取面剥离 + 写入面"掩码哨兵不回写" 必须同一个 PR → ②写入面自动拆分到 `credentials`（不删 URL 里的 userinfo）→ ③存量盘点 + 逐条补 `credentials`（**逐字节复制、不做 percent-decode**）→ ④确认零残留后才删 URL userinfo 并转为 400 拒收。**

关键约束（§1.2 实读）：**`config.auth` 的优先级高于 URL userinfo**，所以"先补 `credentials`、URL 里先留着"这一步是**语义等价**的——只要复制时不解码。这就是把"不打断"和"最终拒收"拆开的支点。

---

## 1. 现状链（实读，基线 `9fb29831c`）

### 1.1 谁把 `connection.baseURL` / `connection.url` 交给 HTTP 客户端

| 消费者 | 位置 | 客户端 | userinfo 是否生效 |
|---|---|---|---|
| `HTTPAdapter.connect()` | `packages/core-backend/src/data-adapters/HTTPAdapter.ts:138` → `axios.create({ baseURL, … })` @ `:142` | axios | **是**（§1.2） |
| `PLMAdapter`（继承 `HTTPAdapter`）走 `super.connect()` | `PLMAdapter.ts:1070`/`:1072` 写入 → `:1138` `await super.connect()` | axios | **是** |
| `PLMAdapter.resolveUrl()` 拼绝对地址 | `PLMAdapter.ts:1149-1157`（读 `:1154`） | 交给 axios `request({url})` | 是（绝对 URL 时 `baseURL` 被忽略，见 §1.2 末） |
| `PLMAdapter.fetchYuantusToken()` | `PLMAdapter.ts:1249` 取 baseUrl → `:1259` `fetch(...)` | Node 内置 `fetch`(undici) | **否，且直接抛错**（§1.3） |
| `PLMAdapter.yuantusDiscussionFetch()` | `PLMAdapter.ts:2566` 取 baseUrl → `:2573` `fetch(...)` | Node 内置 `fetch` | **否，且抛错的 message 含明文口令**（§1.3） |
| `PLMAdapter.getRuntimeStatus()` | `PLMAdapter.ts:1290-1296` | — | 只产出 `configured: boolean`（`:1307`），**不外泄 URL**。这一处**不是**泄漏面。 |

写入侧只有一个 API 入口能落 `baseURL`：`routes/data-sources.ts:79` 的
`const ConnectionConfigSchema = z.record(z.union([z.string(), z.number(), z.boolean()]))`
——**任意键 + 任意标量值**，对 `baseURL` 的**值**不做任何形状检查（`:87` 建、`:147` 改）。

兄弟形状（本轮顺带发现，**不在 F01 主线**）：`MongoDBAdapter.ts:119-120` 直接吃 `connection.uri`，`mongodb://user:pw@host` 是同一类值面洞；但 `mongodb` **不在** `DEFAULT_ADAPTER_REGISTRY`（`DataSourceManager.ts:165-172` 只有 postgresql/postgres/http/sqlserver/mysql/plm），所以它**当前不是 API 可达面**，只有进程内注册者能用。本文不把它纳入迁移，只登记。

### 1.2 axios 腿：userinfo 在哪一步变成 Basic

本机 `packages/core-backend/node_modules/axios` 实读，版本 **1.13.2**（`package.json` 声明 `^1.8.0`，`pnpm-lock.yaml:2053` 锁 `axios@1.13.2`）。

```
lib/adapters/http.js:408   const parsed = new URL(fullPath, …)        // fullPath = buildFullPath(baseURL, url)
lib/adapters/http.js:566-571   // HTTP basic authentication
                           let auth = undefined;
                           if (config.auth) { auth = username + ':' + password }
lib/adapters/http.js:574-578   if (!auth && parsed.username) {
                             auth = parsed.username + ':' + parsed.password;
                           }
lib/adapters/http.js:580   auth && headers.delete('authorization');
lib/adapters/http.js:608   const options = { …, auth, … };            // 交给 follow-redirects / http(s).request
```

由此得到**四条判据**，全部是本文分期方案的地基：

1. **优先级：`config.auth` 胜过 URL userinfo。** `:568` 先取 `config.auth`，`:574` 才 `if (!auth && parsed.username)`。`HTTPAdapter.ts:162-167` 设置的正是 `client.defaults.auth`，它会走 `config.auth`。
   → **"先把口令补进 `credentials`、URL 里的 userinfo 先不动"是语义等价的**（前提见第 3 条）。
2. **userinfo 会删掉 `Authorization` 头。** `:580` 对 `auth`（不区分来源）执行 `headers.delete('authorization')`。
   → 一个 URL 带 userinfo 的 PLM 源，`PLMAdapter.ts:1076-1080` / `:1200-1205` 写进 `connection.headers.Authorization` 的 Bearer、以及 `HTTPAdapter.ts:171-178` 请求拦截器注入的 tokenProvider Bearer，**在 axios 腿上都会被删掉**。这是 #5679（PLM 令牌不落 `connection`）与 F01 的直接耦合面。
   （`apiKey` 走 `X-API-Key`（`HTTPAdapter.ts:159`），**不**受这条影响。）
3. **不做 percent-decode，逐字节上线。** `parsed.username` / `parsed.password` 是 WHATWG URL 的**百分号编码**形式；Node 的 `ClientRequest` 对 `options.auth` 的处理实读为
   `if (options.auth && !this.getHeader('Authorization')) setHeader('Authorization', 'Basic ' + Buffer.from(options.auth).toString('base64'))`
   ——**原样 base64，不解码**。实测（`node -p`，纯解析，不触网）：

   | 存的 URL | `parsed.username` | `parsed.password` |
   |---|---|---|
   | `http://us@er:pw@h/x` | `us%40er` | `pw` |
   | `http://u%40s:p%40w@h/x` | `u%40s` | `p%40w` |
   | `http://u:p%3Aw@h/x` | `u` | `p%3Aw` |
   | `http://tok@h/x` | `tok` | `""`（空串） |

   → 迁移脚本若 `decodeURIComponent` 再写进 `credentials`，**上线字节会变**，现网认证可能从"能过"变成"不能过"（或相反）。**逐字节复制 `parsed.username`/`parsed.password`** 才是等价迁移；"顺手修正编码"是另一件事，须逐源验证（§7 裁决点 3）。
4. **相对 URL 才吃 `baseURL`。** `lib/core/buildFullPath.js`：`isAbsoluteURL(requestedURL)` 为真且 `allowAbsoluteUrls != false` 时直接返回 `requestedURL`，`baseURL` 被整个忽略。`PLMAdapter.resolveUrl()`（`:1151-1152`）对 `http(s)://` 开头的 path 直接返回——这类调用**不会**带上 `baseURL` 的 userinfo。

重定向（`follow-redirects@1.15.11` 实读，**仅源码推断，本轮未实跑**）：`index.js:30-42` 的 `preservedUrlFields` 含 `"auth"`，`index.js:467` 的 `spreadUrlObject(redirectUrl, this._options)` 在 `index.js:595-599` 里**无条件** `spread[key] = urlObject[key]`。因此跳转后 `_options.auth` 被重定向 URL 的 `auth` 覆盖（WHATWG URL 对象没有 `.auth` → `undefined`）；`index.js:475` 另外在降级/跨域时删 `authorization` 头。**结论：userinfo 来源与 `config.auth` 来源走的是同一个 `options.auth` 槽位，重定向行为二者一致**——迁移不改变重定向语义。

### 1.3 `fetch` 腿：同一个 URL，行为完全相反

`packages/core-backend/node_modules/.pnpm/undici@6.26.0/.../lib/web/fetch/request.js:121-127` 实读：

```js
// 3. If parsedURL includes credentials, then throw a TypeError.
if (parsedURL.username || parsedURL.password) {
  throw new TypeError(
    'Request cannot be constructed from a URL that includes credentials: ' + input
  )
}
```

本机 Node v25.9.0 内置 `fetch` 实测（**未触网**，异常在 `Request` 构造阶段抛出）：

```
$ node -e "try{ new Request('http://u:p@h/x') }catch(e){ console.log(e.constructor.name,'|',e.message) }"
TypeError | Request cannot be constructed from a URL that includes credentials: http://u:p@h/x
$ node -e "fetch('http://u:p@h/x').catch(e=>console.log(e.constructor.name,'|',e.message))"
TypeError | Request cannot be constructed from a URL that includes credentials: http://u:p@h/x
```

后果（限定到已实读的两处调用点）：

- `PLMAdapter.fetchYuantusToken()`：`:1277-1278` 的 `catch (_err) { return null }` **吞掉**这个 TypeError → 登录静默失败 → `:1114` 打一条 `PLM Yuantus login failed; check PLM_USERNAME/...` 的**误导性**告警。也就是说：**一个 baseURL 带 userinfo 的 PLM 源，Yuantus 令牌刷新在今天就是坏的**，只是坏得很安静。
- `PLMAdapter.yuantusDiscussionFetch()`：`:2581-2582` 把这个 TypeError 原样放进 `QueryResult.error` —— **这个 Error 的 message 里带着明文口令**。它在已实读的写路由上被固定文案吃掉（`routes/plm-embed-discussion.ts:217-224` 的 `respondWriteError` 只回 `EMBED_DISCUSSION_WRITE_REJECTED` / `..._UNAVAILABLE`，不透传 `error.message`），**所以今天不经这条路由外泄**；但它是一个**携带明文口令在进程里流动的 Error 对象**，任何新增的 `logger.error(err)` / `err.message` 透传都会把它打出来。本轮未逐条核对 `plm-embed-discussion-read.ts` 及其它可能的消费点。

> 注意这是 **F01 的一个独立价值**：即便不谈安全，把口令从 URL 搬到 `credentials` 也会**修好**今天 PLM 的 `fetch` 腿。

### 1.4 读取 / 回显面：谁把带 userinfo 的 URL 吐出去

`routes/data-sources.ts:321-327`：

```ts
function sanitizeConfig(config: DataSourceConfig): Omit<DataSourceConfig,'credentials'> & { hasCredentials: boolean } {
  const { credentials, ...rest } = config      // 只摘掉 credentials
  return { ...rest, hasCredentials: !!credentials && Object.keys(credentials).length > 0 }
}
```

`connection` **整体原样带出**。调用点：

| 位置 | 面 |
|---|---|
| `:437` | `GET /api/data-sources/:id` 响应 |
| `:513` | `POST /api/data-sources` 201 响应 |
| `:687` | `PUT /api/data-sources/:id` 响应 |
| `:782` | `PUT /api/data-sources/:id/credentials` 响应 |
| `:679-680` | `update` **审计行** `meta.before` / `meta.after` |
| `:774-775` | `update_credentials` **审计行** |
| `:866` | `delete` **审计行** `meta` |

→ 带 userinfo 的 URL 今天会**落进 `audit_logs`**（三个动作），并被任何有 `data_sources:read` + 访问权的调用方读到。
（`listDataSources`（`DataSourceManager.ts:1262-1294`）只回 id/name/type/connected/ownerId，**不含 `connection`** —— 列表面不是泄漏面。）

**前端把它回填进编辑表单**（这是分期设计里最要命的一环）：

- `apps/web/src/views/DataSourcesView.vue:598` `form.baseURL = String(connection.baseURL ?? '')`
- `apps/web/src/views/DataSourcesView.vue:64` 是个**明文 `<input>`**
- `apps/web/src/data-sources/buildPayload.ts:73-74` 保存时 `connection.baseURL = form.baseURL` **原样回写**

→ **如果只在读取面打码而不管写入面，用户点一次"保存"就会把 `https://***@host` 写进库，直接打断现网源。** 见 §3 阶段①b。

### 1.5 打码面：各自漏在哪（逐条核对）

| 打码器 | 位置 | 对 URL userinfo 的效果 |
|---|---|---|
| `BaseAdapter.redactSecrets` 值集 | `BaseAdapter.ts:504` `[creds.password, creds.token, creds.apiKey, creds.secret, conn.password]` | **漏**。口令在 `conn.baseURL` 的**值里面**，不是任何一个被枚举的字段。 |
| `BaseAdapter.redactSecrets` key=value 正则 | `BaseAdapter.ts:510-513` `/(\b(?:password\|pwd\|pass\|token\|api[_-]?key\|secret)\b\s*[=:]\s*)(…)/gi` | **漏**。`https://u:pw@h` 里没有 `password=` / `password:` 这样的**键锚点**。（`u:pw` 的 `:` 前面不是词表里的词。） |
| `BaseAdapter.redactSecrets` Authorization 正则 | `BaseAdapter.ts:516-519` | **漏**。同理，无 `authorization` 锚点。 |
| #5681 `secretKeyValueTextPattern()` | `data-source-secret-keys.ts:315-326` | **漏**，且是**设计上的漏**：它生成的仍是 `(\b(?:word)\b\s*[=:]\s*)(value)` 键锚点正则。模块头注释 `:31-35` 自己承认了这一点。 |
| #5648/#5681 `isSecretConfigKey` / `stripSecretConfigKeys` / `findSecretConfigKeyPaths` | `data-source-secret-keys.ts:181-264` | **漏**。三者都只看**键名**；`baseURL` / `url` 不是秘密键，值不被检查。 |
| `DataSourceManager` 临时 test 的 `scrubInput` | `DataSourceManager.ts:955-991` | **部分挡住，但方向相反**。它把 `conn.baseURL` / `conn.baseUrl` / `conn.url` 的**整串**（含 userinfo）加进要 `split().join('***')` 的片段集（`:973-983`），所以 `POST /api/data-sources/test` 的错误文案里整串会被替换掉；但它的目的是"不回显调用方提交的标识符"，只覆盖**这一个临时端点**，不覆盖 `/:id/test`、日志、审计。另注意 `:978` 的 `conn.baseUrl`（小写 u）**没有任何适配器读它**（`HTTPAdapter.ts:138` 只读 `baseURL` 和 `url`）——是一处已存在的键名漂移。 |
| `automation-log-redact.redactString` | `multitable/automation-log-redact.ts:28` `/\b(?:postgres(?:ql)?\|mysql):\/\/[^\s<>]+/gi`、`:64-76` | **漏 http/https**。只覆盖 `postgres(ql)` / `mysql` 两种 scheme。 |
| **已有可复用件** `stripUrlUserinfo` | `services/ai-provider-client.ts:54-56` `text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, '$1<redacted>@')` | **命中**。scheme 无关、贪婪吃到 host 前最后一个 `@`（`:46-52` 注释解释了为什么不能用 `[^@/\s]+`）。**阶段①应当复用它，而不是另写一条正则。** |
| #5679 `redactUrlUserinfo`（PLMAdapter 内） | 见 §4 | 本轮**未实读**（fetch PR 内容时网络中断）。按 PR 文件清单只改 `PLMAdapter.ts`，推断为 PLM 局部件。 |

### 1.6 日志面：打印 URL 的点

- `PLMAdapter.ts:1137` `this.logger.info(\`PLM Adapter connecting to ${this.config.connection.url}\`)` —— #5679 声称已加 `redactUrlUserinfo`（未实读，§4）。
- `HTTPAdapter.ts:180` `this.emit('request', { method: config.method, url: config.url })`、`:192` `this.emit('response', { …, url: response.config.url })` —— 这里的 `config.url` 是**每次请求的相对 endpoint**，不含 `baseURL`，**不是** userinfo 泄漏点。（本轮未追这两个事件的所有订阅者。）
- `DataSourceManager.ts:320` `console.error('[DataSourceManager] Auto-connect failed for ${config.id}:', err)`、`:325`、`:333` —— 打的是 err，不直接打 URL；但 axios 的连接错误**是否**回显 baseURL 取决于驱动文案，本轮未穷举。这是"**不能声称已封死**"的那一类：§8 记为未验证。

### 1.7 存储面：两种列形状 + 加密边界

- **形状 A（当前活的 Kysely 迁移）**：`packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts` 建 `data_sources`，**单列** `config jsonb NOT NULL`，内容形状由 `DataSourceManager.configToRecord`（`:395-423`）决定：`{ connection, credentials, options, poolConfig }`。读回走 `recordToConfig`（`:382-393`）。落库走 `persistDataSource`（`:750-782`，`insertInto('data_sources')…onConflict…doUpdateSet({config: record.config, …})`）。
- **形状 B（历史裸 SQL 迁移）**：`packages/core-backend/migrations/040_data_sources.sql:7-27`，`connection JSONB NOT NULL` / `credentials JSONB` / `options JSONB` / `pool_config JSONB` **四个平列**。
  → 盘点 SQL 必须同时覆盖两种形状（§5），先探列再选查询。
- **加密边界**：`DataSourceManager.ts:25` `const SENSITIVE_CREDENTIAL_KEYS = ['password','apiKey','token']`；`encryptCredentials`（`:346-356`）**只加密 `credentials` 下这三个键**，`configToRecord:409` 只对 `config.credentials` 调它。
  → 推论（限定）：**`connection` 下的一切（含 `baseURL` 值里的口令）在库里是明文**；`credentials.username` 也是明文（`:22-24` 注释明说"标识符不加密"），迁移后 userinfo 的**用户名部分仍是明文**，只有口令进入 `enc:` 密文。这与今天 SQL 源的 `credentials.username` 待遇一致，不是回退。
- `decryptCredentials`（`:364-380`）在 `ENCRYPTION_KEY` 变更时 **fail loud 抛错**（`:373-376`）——迁移脚本写完密文后，如果部署侧的 key 不对，**整个数据源加载会炸**，不是静默降级。这是阶段③的前置检查项（§6）。

### 1.8 `credentials` 侧的现有形状（目标落点的实读）

- API 可写的 `credentials`（创建）：`routes/data-sources.ts:109-114` → `{ username?, password?, apiKey?, token? }`（zod object 默认**剥掉**未声明键）。
- API 可写的 `credentials`（轮换）：`routes/data-sources.ts:177-184` `DataSourceCredentialsUpdateSchema`，`.strict()`，同样四个键，且每个 `.min(1)`。
- `PUT /api/data-sources/:id` 的 `DataSourceUpdateSchema`（`:145-175`）**没有 `credentials` 字段** —— 改口令只能走 `/credentials` 路由。
- `HTTPAdapter` 实际读的键（`:152-167`）：
  ```ts
  const apiKey = credentials.apiKey
  const bearerToken = credentials.bearerToken      // ← 注意
  const username = credentials.username
  const password = credentials.password
  if (apiKey) { X-API-Key }
  else if (bearerToken) { Authorization: Bearer }
  else if (username && password) { defaults.auth = {username, password} }
  ```
  两条**已存在的漂移 / 陷阱**，直接决定迁移的可行性：
  1. **`bearerToken` 不是 API 可写键**（创建/轮换 schema 里是 `token`）。所以 `credentials.token` 在 HTTP 源上**是个死字段**——存了、加密了、没人读。
  2. **三分支是 `else if`**：`apiKey` 存在时，补再多 `username`/`password` 也**不会**生效。
  3. **`username && password` 要求两者都非空**：`http://tok@host`（只有用户名、口令空串）今天在 axios 腿上产出 `Basic base64("tok:")`，但迁成 `credentials.username='tok', password=''` 后 `password` 为假值 → **`defaults.auth` 不会被设置 → 认证消失**。→ §7 裁决点 4。
- 前端 `http` 类型表单**只提供 `baseURL` + `apiKey`**（`apps/web/src/data-sources/buildPayload.ts:43-46`），**没有 username/password 输入框**。
  → **推论：今天想给一个 HTTP 源配 Basic，内置 UI 里唯一可达的办法就是把 `user:pw@` 写进 baseURL。** 这既解释了这些存量是怎么来的，也说明"阶段④拒收"必须与"UI 补 Basic 字段"同批上线，否则等于删掉一个功能。

---

## 2. 目标形状

1. `connection.baseURL` / `connection.url`（以及任何 `connection` 下的字符串值）**不含 userinfo**：`scheme://host[:port][/path]`。
2. HTTP/PLM 源的 Basic 口令**只住在 `credentials`**：`credentials.username` + `credentials.password`，由 `encryptCredentials`（`DataSourceManager.ts:346-356`）加密 `password`，由 `HTTPAdapter.ts:162-167` 装进 `client.defaults.auth`。
3. 任何**回显面**（`GET /:id`、create/update 响应、三处审计 meta）与任何**日志/错误面**看到的 URL 都不含 userinfo；打码统一复用 `stripUrlUserinfo`（`services/ai-provider-client.ts:54-56`），不新写正则。
4. 写入面对含 userinfo 的 URL 有**确定**的行为（自动拆分 或 400 带码），而不是今天的"照单全收"。
5. 前端 `http` 源表单提供 username / password（走 `PUT /:id/credentials`），使"不用 userinfo 也能配 Basic"成立。

**非目标（本文明确不做）**：`connection.headers.Authorization`（#5648 §6 的 F 项之二，归 #5679 线）、`MongoDBAdapter.connection.uri`（当前非 API 可达）、SQL 连接串形态的 userinfo（当前适配器不吃连接串）。

---

## 3. 迁移路径（四阶段，每阶段可单独上线）

> 记号：**红→绿** 指"先写一个在当前代码上必红的断言，改完变绿"；**变异探针**指"把新守卫在内存里改坏（`vi.mock` / 改 `require.cache`），断言测试重新变红"，不落盘。

### 阶段① — 读取面剥离 + 打码（不改语义）

拆成两个可独立上线的子步，**顺序不能反**。

#### ①a 只动日志/错误文案（零回显风险，最先上）

- 把 `stripUrlUserinfo` 从 `services/ai-provider-client.ts` 提到一个共享位置（建议 `src/security/` 或 `data-adapters/` 下），**只移动不改逻辑**，原处改为 re-export（避免 #5648/#5679 的争用面扩大，见 §4）。
- `BaseAdapter.redactSecrets`（`:500-520`）在返回前**追加**一次 `stripUrlUserinfo`。这是纯删除文本的操作，`redactCause`（`:494-496`）、`onError`（`:534`）、`connectionError` 三条路一起受益。
- `PLMAdapter.ts:1137` 若 #5679 已加局部件，改为调共享件（§4）。
- **谁会被打断**：只在错误文案/日志里少几个字符。已实读范围内没有消费者依赖"错误文案里带 URL 原文"。**限定**：本轮未穷举全部日志订阅者（§8）。

**红→绿测试形状**（`packages/core-backend/tests/unit/`）
- 红：构造 `config.connection.baseURL = 'https://u:pw@api.example.invalid'` 的 adapter，`redactCause('connect failed https://u:pw@api.example.invalid/x')` 断言结果**不含** `pw` —— 当前代码返回原文，必红。
- 绿：追加 `stripUrlUserinfo` 后通过。
- 变异探针：在测试内把共享件替换成 `(s)=>s`（`vi.mock`），断言该用例重新变红 —— 证明是新守卫在起作用、不是别的规则顺带挡住的。
- 边界用例（必须一起钉）：`u:p@ss@host`（未编码 `@`）只保留 host 后缀；`host/users@me`（`@` 只出现在 path）**不得**被改写；`postgres://…@…` 仍被 `automation-log-redact` 覆盖，不能因新规则出现双重替换导致字节漂移。

#### ①b 读取面剥离 + 写入面"掩码哨兵不回写"（**必须同一个 PR**）

- `sanitizeConfig`（`routes/data-sources.ts:321-327`）对 `connection` 下每个字符串值做 `stripUrlUserinfo`，产出固定哨兵，例如 `https://<redacted>@host`（沿用 `ai-provider-client` 的 `<redacted>` 字样，减少词表分裂）。四个响应面 + 三个审计面（`:437/:513/:687/:782/:679-680/:774-775/:866`）同时受益。
- **同一 PR 必须**在写入面加：`connection` 的字符串值若匹配"哨兵形状的 userinfo"（`://<redacted>@`），则**拒绝写入**并返回带码 400（建议 `DATA_SOURCE_CONNECTION_URL_REDACTED_ECHO`），文案指引"该字段不可编辑回写，请改口令走 `/credentials`"。
  理由见 §1.4：`DataSourcesView.vue:598` 回填 + `buildPayload.ts:73-74` 原样回写，**没有这条守卫，用户点一次保存就毁掉现网源**。
- 前端同批：编辑态若 `baseURL` 含哨兵，输入框置为 readonly + 提示，`buildUpdatePayload` 不发该字段。

- **谁会被打断**：
  - 内置 Web 编辑表单的"保存"路径（已由同批前端改动兜住）。
  - 任何"GET → 改一点 → PUT 全量"的外部脚本/集成：它们会撞上新的 400。**这是有意的**——没有这条 400，它们撞上的是静默的配置毁坏。需要在发布说明里点名。
  - 依赖审计 `meta.before/after` 做**精确 diff** 的下游（若有）：`connection.baseURL` 的值从此是掩码，diff 会一直"看起来变了"。本轮**未确认**是否存在这种下游（§6 第 4 条）。

**红→绿测试形状**
- 红 1（读取）：`GET /api/data-sources/:id` 对带 userinfo 的源，断言响应 JSON 序列化后**不含**口令子串。当前必红。
- 红 2（审计）：同一次 `PUT`，断言 `auditLog` 收到的 `meta.before`/`meta.after` 序列化后不含口令。当前必红。
- 红 3（回写守卫）：`PUT /:id` body 带 `connection.baseURL = 'https://<redacted>@api.example.invalid'`，断言 **400 + 码**，且断言**库里的值没变**（读回原值）。当前必红（今天会 200 并写坏）。
- 变异探针：分别把 `sanitizeConfig` 的剥离、把回写守卫在内存里注释掉，断言对应用例各自变红。
- 反向钉（防守卫过宽）：`connection.baseURL = 'https://api.example.invalid/redacted@path'` 必须**照常 200**——哨兵判定不能把 path 里的 `@` 算进去。

### 阶段② — 写入面：自动拆分 vs 400

对**新写入**的含 userinfo URL，两条路：

| | **A. 自动拆到 `credentials`** | **B. 400 带码拒收** |
|---|---|---|
| 现网影响 | 零打断：调用方照旧写，后端悄悄搬家 | 打断所有还在用 userinfo 写入的调用方（含本文 §1.8 里"UI 唯一可达的 Basic 配法"） |
| 可审计性 | 差：请求体和落库形状不一致，出问题难复盘；需要额外审计字段记录"我改了你的输入" | 好：拒了就是拒了 |
| 正确性风险 | **高**：`else if` 链（§1.8.2）——若该源已有 `apiKey`，拆出来的 username/password **不会生效**，等于静默降级；`token@host` 形态（§1.8.3）拆出来直接失效 | 无 |
| 与"只收紧不放松"的关系 | 自动拆分**把口令从明文列搬进加密列**，是收紧；但"替调用方改输入"本身是一种放松（放过了本该拒的请求） | 纯收紧 |
| 可回滚 | 难（已经改过库里的形状） | 易 |

**推荐：A'（受限自动拆分）+ B 兜底**，即：

1. 仅当 **`credentials` 里没有 `apiKey` / `bearerToken`**、且 **userinfo 的用户名与口令都非空**、且 **`credentials.username`/`password` 为空**（不覆盖已有值）时，自动拆分；拆分**逐字节**复制 `parsed.username`/`parsed.password`，**不 decode**；并写一条专门的审计动作（例如 `connection_url_userinfo_split`，meta 只记 `{ sourceId, field, splitTo:['username','password'] }`，**不记值**）。
2. 其余情形一律 **400 带码**（建议 `DATA_SOURCE_CONNECTION_URL_USERINFO_REJECTED`），文案说明"请把口令放 `credentials`"，并**点名**是哪一种不可自动处理的情形（不含值）。
3. 自动拆分后**是否顺手从 URL 里删掉 userinfo**：建议**删**。因为此时 `credentials` 已是权威来源，`config.auth` 优先级更高（§1.2.1），删与不删上线字节一致；删了能让阶段③的存量口径变干净（新写入永远不产生新存量）。

- **谁会被打断**：命中第 2 类的调用方。已知至少包括：给已有 `apiKey` 的 HTTP 源再塞 userinfo 的写入；`token@host` 形态。数量未知（§6 第 1 条）。

**红→绿测试形状**
- 红：`POST /api/data-sources` 带 `connection.baseURL='https://u:pw@api.example.invalid'` → 断言落库的 `config.connection.baseURL` **无 userinfo** 且 `config.credentials.password` 是 `enc:` 前缀密文、`credentials.username === 'u'`。今天必红。
- 红（不 decode 钉）：`https://u%40s:p%40w@…` → 断言 `credentials.username === 'u%40s'`（**不是** `u@s`）。这条是防"顺手解码"的回归钉。
- 红（拒收支）：已有 `credentials.apiKey` 的源再写 userinfo → 断言 400 + 码，且断言**没有**写进 `credentials`。
- 红（token@host）：`https://tok@…` → 断言 400 + 码（而不是拆成 `password:''`）。
- 变异探针：把"已有 apiKey 则拒"这一条在内存里改成"照拆"，断言对应用例变红。
- 反向钉：不含 userinfo 的普通 URL 照常 201，`credentials` 不被创建。

### 阶段③ — 存量：盘点 + 迁移 + 回滚

只有阶段②上线（不再产生新存量）之后才做，否则边迁边生。

1. **盘点**：§5 的 SQL，先在只读副本上跑，产出 `{id, type, path, 是否含 %, credentials 已有哪些键, userinfo 是否只有用户名}` 的分类计数。**不导出值**。
2. **迁移**：写一次性脚本（建议放 `scripts/`，一次性、带 `--dry-run` 默认、`--apply` 显式），复用现有件而不是重写：
   - 读：`DataSourceManager.recordToConfig` 的等价逻辑（或直接读 `config` JSONB）；
   - 加密：`security/encrypted-secrets` 的 `encryptStoredSecretValue`（`DataSourceManager.ts:10` 导入处可见），与 `encryptCredentials`（`:346-356`）同一把 key；
   - 写：**只** `UPDATE data_sources SET config = jsonb_set(...)`，不走 `persistDataSource`（避免 `onConflict` 的 `is_active/deleted_at` 复活语义误伤软删行）。
   - **本阶段只加 `credentials`，不删 URL 里的 userinfo**（靠 §1.2.1 的优先级保证等价）。
   - 跳过并列表输出：已有 `apiKey`/`bearerToken` 的行、用户名-only 的行、`credentials.username`/`password` 已有值且与 URL 不一致的行 → 这些交人工/裁决。
3. **验证**：迁移后逐源 `POST /api/data-sources/:id/test`（该端点是唯一刻意回报脱敏原因的面），断言仍 `success:true`。
4. **回滚**：迁移前把受影响行的 `config` 整列快照进一张一次性表（例如 `data_sources_userinfo_migration_backup(id, config, captured_at)`，**含明文口令，属敏感表**，需与 owner 约定保留期与销毁）；回滚 = 用快照覆盖回 `config`。因为本阶段**没删** URL userinfo，实际上"不回滚也能跑"——回滚主要是为 `credentials` 写错的情形兜底。

- **谁会被打断**：
  - `ENCRYPTION_KEY` 未配置 / 与部署不一致的环境：新写的 `enc:` 密文在下次加载时会让 `decryptCredentials`（`:373-376`）**抛错**，进而 `loadFromDatabase` 的 `catch`（`:324-326`）跳过该源 → **源从可用变不可用**。这是阶段③最大的单点，必须先做 §6 第 3 条的 key 确认。
  - 被跳过的三类行：它们在阶段④到来前保持现状，但不能被当成"已迁移"。

**红→绿测试形状**（脚本层单测，不连真库）
- 红：给一个内存 fixture（形状 A 与形状 B 各一份），跑迁移函数，断言输出的 `credentials.password` 可被 `decryptStoredSecretValue` 还原成原 `parsed.password`，且 `connection.baseURL` **未变**。
- 红：跳过规则的四类各一条 fixture，断言它们进 `skipped` 列表且 `config` 一字未改。
- 变异探针：把"跳过已有 apiKey"改成不跳，断言该 fixture 的断言变红。
- 幂等钉：连续跑两次，第二次 `changed === 0`。

### 阶段④ — 删 URL userinfo + 转为纯拒收

前置：盘点为 0 残留（阶段③ + 人工处理完），且前端 Basic 字段已上线。

- 迁移脚本第二趟：从 `connection` 字符串值里删掉 userinfo（保留 scheme/host/port/path/query）。
- 写入面：把阶段②的"受限自动拆分"降级为**纯 400 拒收**（保留同一个错误码，文案改为"不接受"）。
- `data-source-secret-keys.ts` 的模块头注释里把 F01 反例标为已闭环（连同它对 `HTTPAdapter.ts:138` / `axios http.js:574-578` 的引用）。

- **谁会被打断**：任何**未走路由**的进程内写入者。`DataSourceManager.addDataSource` / `updateDataSource` **不经过**路由层的校验（#5681 模块头 `:40-41` 已把这条列为"本刀的边界"）。本轮实读：`packages/core-backend/src` 与 `plugins/*/src` 里 `addDataSource(` / `updateDataSource(` 的调用点**只有** `routes/data-sources.ts:495/:665/:759` 三处，即今天没有别的进程内写入者；但这是一条**随时会被新代码打破**的现状，不是结构性保证。→ 建议阶段④把守卫下沉到 `DataSourceManager.addDataSourceInternal`，让路由和进程内写入共用同一道门。

---

## 4. 与在飞 PR 的关系与争用面

| PR | 状态/分支 | 与 F01 的关系 | 文件争用 |
|---|---|---|---|
| **#5648**「connection 下的口令类键写入即拒、读取剥离，秘密键判据收敛到一处（issue #5621）」 | OPEN，`fix/data-source-connection-password-plaintext` | **判据来源**。F01 是它 §6 登记的后续单；它建立了"一处判据 + 写入拒 + 读取剥 + 值集打码"的**模板**，F01 沿用同一套骨架，只是把判据从**键名**换成**值形状**。 | `BaseAdapter.ts`、`routes/data-sources.ts`、`data-source-secret-keys.ts`、`vitest.config.ts` —— **与 F01 阶段①b/② 完全重叠**。 |
| **#5681**「秘密键词表补 pw/pswd/passcode 并 NFKC 归一化…盘点 SQL 补两种列形状与嵌套路径（#5648 F03/F10，叠 #5648）」 | OPEN，`fix/data-source-secret-keys-vocab-nfkc`，**叠在 #5648 上** | **词表 + 盘点 SQL 的先例**。F01 的盘点 SQL（§5）复用它的"两种列形状 + 嵌套路径"写法。其 `data-source-secret-keys.ts` 已实读（本轮唯一成功拉到的 PR 文件），头注释 `:28-41` 明确把 F01 列为反例之一。 | `data-source-secret-keys.ts`、`tests/unit/data-source-connection-secret-keys.test.ts`、以及 `docs/development/data-source-connection-secret-keys-design-20260912.md`。 |
| **#5679**「PLMAdapter 的 Bearer 令牌改存实例字段、建 client 时合并，不再写回 `config.connection` 明文落库（#5648 F02）」 | OPEN，`fix/plm-adapter-token-not-persisted-in-connection` | **同一根因的另一半**，且有**语义耦合**：axios `http.js:580` 在存在 userinfo 时会 `headers.delete('authorization')`（§1.2.2）——也就是说 **#5679 修好的 Bearer，在一个 URL 仍带 userinfo 的 PLM 源上仍然发不出去**。两条线要么都做完，要么在文档里互相点名。 | `PLMAdapter.ts`（`:1137` 日志、`:1076-1080`/`:1200-1205` headers）。它引入的 `redactUrlUserinfo` 与 F01 阶段①a 要提的共享 `stripUrlUserinfo` **是同一件东西的两份实现** → 建议 #5679 先合，F01 ①a 负责"合并成一份、PLM 改调共享件"。 |

**排序建议**：#5648 → #5681 → #5679 →（F01 ①a 合并打码件）→ F01 ①b → ② → ③ → ④。理由是 ①b/② 要改的 `routes/data-sources.ts` 与 `BaseAdapter.ts` 正是 #5648 的主战场，抢在它前面必然 O(n²) 冲突（这也是"插件测试链×pin 冲突"那类摩擦的同构）。

**`HTTPAdapter`/`BaseAdapter` 的争用面**：F01 阶段②若把"拆分"做在路由层，只碰 `routes/data-sources.ts`；若做在 `DataSourceManager.addDataSourceInternal`（阶段④建议的位置），会碰 `DataSourceManager.ts` —— 该文件同时被 K3 写栅栏、SQL 写臂绑定、引用删除守卫占用，改动面要尽量小且靠近 `configToRecord`。`HTTPAdapter.ts:152-167` 的 `else if` 链**迟早要改**（§7 裁决点 4），但那是一个独立的行为变更，**不应**捆进 F01 的任何一个阶段。

---

## 5. 盘点 SQL（两种列形状，仿 #5681 §5 写法）

> 三段都**只输出打码后的值**（`<userinfo>@`），绝不 SELECT 明文。先在只读副本跑。**本轮无真库，以下 SQL 未实跑**（§8 第 7 条）。

### 5.0 先探列形状

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name   = 'data_sources'
  AND column_name IN ('config', 'connection', 'credentials', 'options', 'pool_config')
ORDER BY column_name;
```
- 出现 `config` → **形状 A**（Kysely 迁移，当前代码走这条），用 5.1。
- 出现 `connection` / `credentials` 平列 → **形状 B**（`040_data_sources.sql`），用 5.2。
- 两者都出现 → 两段都跑，逐 id 比对。

### 5.1 形状 A：递归走 `config` 的所有字符串叶子（覆盖嵌套路径）

```sql
WITH RECURSIVE walk(id, name, type, path, node) AS (
  SELECT ds.id, ds.name, ds.type, 'config'::text, ds.config
  FROM data_sources ds
  WHERE ds.deleted_at IS NULL AND ds.is_active
  UNION ALL
  SELECT w.id, w.name, w.type,
         CASE WHEN jsonb_typeof(w.node) = 'object'
              THEN w.path || '.' || e.key
              ELSE w.path || '[' || e.key || ']' END,
         e.value
  FROM walk w
  CROSS JOIN LATERAL (
    SELECT key, value
      FROM jsonb_each(CASE WHEN jsonb_typeof(w.node) = 'object' THEN w.node ELSE '{}'::jsonb END)
    UNION ALL
    SELECT (a.ord - 1)::text, a.value
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.node) = 'array' THEN w.node ELSE '[]'::jsonb END)
           WITH ORDINALITY AS a(value, ord)
  ) AS e(key, value)
)
SELECT
  id, type, path,
  regexp_replace(node #>> '{}',
                 '^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/[:space:]]*@',
                 '\1<userinfo>@')                                   AS masked_value,
  (node #>> '{}') ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]]*%'    AS userinfo_has_percent,
  (node #>> '{}') ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^:/[:space:]]+@'   AS username_only
FROM walk
WHERE jsonb_typeof(node) = 'string'
  AND path NOT LIKE 'config.credentials%'          -- credentials 是目标落点，不算存量
  AND (node #>> '{}') ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]]*@'
ORDER BY id, path;
```

`^…://[^/[:space:]]*@` 与 `stripUrlUserinfo`（`ai-provider-client.ts:55`）的 `([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@` **同形**（贪婪吃到 host 前的最后一个 `@`），所以"SQL 盘出来的"和"代码会打码的"是同一个集合——这条对齐比 SQL 本身更重要。

**分类计数**（决定阶段②/③ 的工作量与裁决点）：

```sql
-- 在上面的 WITH RECURSIVE 之后接：
SELECT
  count(*) FILTER (WHERE true)                            AS rows_with_userinfo,
  count(*) FILTER (WHERE userinfo_has_percent)            AS rows_needing_encoding_ruling,
  count(*) FILTER (WHERE username_only)                   AS rows_username_only,
  count(*) FILTER (WHERE path LIKE 'config.connection.%') AS rows_under_connection,
  count(*) FILTER (WHERE path NOT LIKE 'config.connection.%') AS rows_elsewhere
FROM (/* 上面的 SELECT */) t;
```

**与 `credentials` 现状的交叉**（判断哪些行会被 `else if` 链吞掉）：

```sql
SELECT ds.id, ds.type,
       (ds.config -> 'credentials') ? 'apiKey'      AS has_apikey,
       (ds.config -> 'credentials') ? 'bearerToken' AS has_bearer,
       (ds.config -> 'credentials') ? 'token'       AS has_token,
       (ds.config -> 'credentials') ? 'username'    AS has_username,
       (ds.config -> 'credentials') ? 'password'    AS has_password
FROM data_sources ds
WHERE ds.deleted_at IS NULL AND ds.is_active
  AND EXISTS (
    SELECT 1
    FROM jsonb_each_text(COALESCE(ds.config -> 'connection', '{}'::jsonb)) AS c(k, v)
    WHERE v ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]]*@'
  );
```

### 5.2 形状 B：平列 `connection`

把 5.1 的递归种子换成：

```sql
  SELECT ds.id, ds.name, ds.type, 'connection'::text, ds.connection
  FROM data_sources ds
```
并把 `path NOT LIKE 'config.credentials%'` 去掉（形状 B 的 `credentials` 是独立列，本就不在这棵树里）。其余不变。

### 5.3 审计表残留（阶段①b 之前写下的行）

```sql
SELECT count(*)
FROM audit_logs
WHERE resource_type = 'data_source'
  AND action IN ('update', 'update_credentials', 'delete')
  AND meta::text ~ '[a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]"]*@';
```
> 若目标库的 `audit_logs` 是**按月分区**的，跨分区全表扫描要先限时间窗，且中文 locale 下不要用英文散文做判据——这里用的是纯正则 + 列名，不依赖任何消息文案。审计残留**是否清洗**见 §7 裁决点 5。

---

## 6. 需要真库确认的点

1. **存量条数与形状**：§5.1/§5.2 的计数——`rows_with_userinfo`、`rows_needing_encoding_ruling`（含 `%`）、`rows_username_only`、以及 5.1 交叉表里 `has_apikey/has_bearer` 为真的条数。这四个数字直接决定阶段②走 A' 还是纯 B、阶段③要不要人工批。
2. **`data_sources` 实际是哪种列形状**（跑 §5.0）。代码只走形状 A，但 `040_data_sources.sql` 的存在说明历史库可能是 B 或两者并存。
3. **`ENCRYPTION_KEY` 在目标环境是否已配、是否与库里已有 `enc:` 密文一致**。验证法：对任意一个已有 `credentials.password` 且值以 `enc:` 开头的源，调 `POST /api/data-sources/:id/test`，若返回 `Failed to decrypt credential 'password' (ENCRYPTION_KEY may have changed)` 形状的错误则不一致。**这是阶段③的硬前置**（§1.7）。
4. **是否存在依赖 `GET /:id` 回显 `connection.baseURL` 原文的下游**（外部脚本、集成、报表）。本轮只确认了内置 Web（`DataSourcesView.vue:598`）这一个；仓库外的调用方查不到。
5. **审计表里含 userinfo 的行数**（§5.3）与其分区跨度。
6. **生产环境实际安装的 axios 版本**：`package.json` 声明 `^1.8.0`，本机锁到 1.13.2。若某个部署产物锁到别的 1.x，需复核 `lib/adapters/http.js` 里那四行的**行为**（行号必然不同）。

---

## 7. 需要用户裁决的点

1. **阶段②走哪条？** 建议 A'（受限自动拆分 + 拒收兜底）。若 owner 更看重"后端绝不替调用方改输入"，则直接走纯 B，但必须与"前端补 Basic 字段"同批，否则 HTTP 源的 Basic 认证在 UI 上无路可走（§1.8 末）。
2. **是否允许后端自动拆分**（等价于 1 的另一种问法，但影响审计口径）：自动拆分要不要单独一条审计动作？建议要，且 meta 只记路径不记值。
3. **percent-encoding 口径**：迁移一律**逐字节复制**（保持今天的上线字节，包括今天可能是"错"的那些）？还是对含 `%` 的行做一次**解码修正**（可能修好一批、也可能弄坏一批）？建议**默认逐字节**，含 `%` 的行**单独列出来交人工逐源验证**。
4. **`token@host`（用户名-only）形态怎么办？** 三选一：(a) 阶段②起直接 400 拒、存量人工处理；(b) 放宽 `HTTPAdapter.ts:162` 的 `username && password` 为 `username != null`，让 `Basic base64("tok:")` 可由 `credentials` 表达；(c) 视为"这本来就是个 Bearer/API-key 被塞错了位置"，逐源改配。建议 (a) + 逐源问清它到底是什么。注意 (b) 是**放松适配器的判据**，需要单独的 PR 和单独的裁决，不应混进 F01。
5. **审计表存量是否清洗？** `audit_logs` 里已写下的明文 userinfo：不动（历史真相）/ 就地打码（改写审计记录）/ 按保留期自然过期。三者取舍是合规问题，不是技术问题。
6. **阶段③的回滚快照表**（`data_sources_userinfo_migration_backup`）含明文口令：保留期多久、谁能读、什么时候 DROP。
7. **`credentials.token` 死字段**（§1.8.1：API 写 `token`，`HTTPAdapter` 读 `bearerToken`）要不要在 F01 顺手修？建议**不要**——它是独立缺陷，混进来会让 F01 的"先红后绿"证据面失焦；单开一单。

---

## 8. 本轮未验证 / 不确定（明确不作保证的部分）

1. **#5648 / #5679 的代码本体未实读**。会话中途 `git fetch`（schannel TLS 握手失败）与 `gh api`（EOF）双双中断，只成功拉到 `fix/data-source-secret-keys-vocab-nfkc` 分支上的 `data-source-secret-keys.ts` 全文。因此：#5648 对 `routes/data-sources.ts` / `BaseAdapter.ts` 的**具体接线位置与行号**、#5679 的 `redactUrlUserinfo` **实现与覆盖范围**，本文均按 PR 标题 + 文件清单 + 该模块头注释推断，**合并后须复核**。
2. **axios 版本前提与任务描述不符**：任务写"1.8.x"，实读为 **1.13.2**（`package.json` 声明 `^1.8.0`）。任务给的 `lib/adapters/http.js:574-578` 在 1.13.2 上是对的（574 `if (!auth && parsed.username)`，577 `auth = …`，另有 **580** `auth && headers.delete('authorization')` 这条任务未提及、但对 #5679 很关键）。**1.8.0 本身的源码本轮未读**。
3. **follow-redirects 的重定向 auth 行为是源码推断，未实跑**（§1.2 末）。
4. **Node 内置 `fetch` 的 undici 版本**与 `node_modules/.pnpm/undici@6.26.0`（独立依赖副本）不是同一份。§1.3 的行为已在**本机 Node v25.9.0 上实测复现**，但"所有部署的 Node 版本都如此"未验证——这是规范强制的行为，历史上长期稳定，但本文不把它当绝对。
5. **日志订阅者未穷举**：`HTTPAdapter.ts:180/:192` 的 `request`/`response` 事件、`DataSourceManager.ts:320/:325/:333` 的 console 输出，其下游是否再打印/持久化 URL，本轮未逐条追。§1.6 的"不是泄漏点"限定在**这三处本身打印的内容**。
6. **`plm-embed-discussion-read.ts` 及其它 `QueryResult.error` 消费点未逐条核对**（§1.3）。已核的只有 `plm-embed-discussion.ts:217-224`。
7. **§5 的 SQL 未在任何真库上执行过**；递归 CTE 用 `CASE` 包住 `jsonb_each`/`jsonb_array_elements` 是为了避免对非对象/非数组节点调 SRF 报错，但实际计划与性能须先小表试跑。
8. **"今天没有别的进程内写入者"是一次全仓 grep 的结论**（`packages/core-backend/src` + `plugins/*/src` 里 `addDataSource(`/`updateDataSource(` 只命中 `routes/data-sources.ts:495/:665/:759`），是**现状快照**，不是结构性保证——这正是阶段④建议把守卫下沉到 manager 的理由。
