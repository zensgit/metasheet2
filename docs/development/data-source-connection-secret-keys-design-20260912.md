# 数据源 connection 口令字段：单一定义 + 写入拒收 + 读取剥离（设计）

- Issue：#5621（`connection.password` 明文落库并随 `GET /api/data-sources/:id` 回显）
- 分支：`fix/data-source-connection-password-plaintext`（worktree `metasheet-wt-w3b`，基于 origin/main）
- 落笔时间：2026-09-11 18:5x（本地 UTC+8；Git Bash 的 `date` 打的是 UTC，差 8 小时）。文件名日期 `20260912` 沿用协调方指定的命名，不是落笔日。
- 配套：`docs/development/data-source-connection-secret-keys-verification-20260912.md`
- **后续单 F03 / F10 已叠在本 PR 上**（分支 `fix/data-source-secret-keys-vocab-nfkc`，worktree `metasheet-wt-w4e`，基于本 PR 头 `691a20e83`）：F03 = 词表补 `pw`/`pswd`/`passcode` + 限定词前缀 + NFKC（§2 末「F03 词表扩容 + NFKC」）；F10 = §5 盘点/迁移 SQL 补嵌套路径与第二种列形状。收据在验证文档 §9。

## 1. 缺口：同一个字段，四处三种口径

| # | 位置（改前） | 对 `connection.password` 的态度 |
|---|---|---|
| 1 | `packages/core-backend/src/routes/data-sources.ts:79` `ConnectionConfigSchema = z.record(...)` | **接受**（自由记录，任何字符串键都放行） |
| 2 | `packages/core-backend/src/data-adapters/DataSourceManager.ts:409` `configToRecord` | **明文落库**（只对 `config.credentials` 调 `encryptCredentials`，`connection` 原样进 jsonb） |
| 3 | `packages/core-backend/src/routes/data-sources.ts:321-327` `sanitizeConfig` | **原样回显**（只解构 `credentials`，`connection` 随 `...rest` 返回，并被复制进 update/rotate/delete 的审计 meta） |
| 4 | `packages/core-backend/src/data-adapters/BaseAdapter.ts:504` `redactSecrets` | **当作秘密**（`conn.password` 计入待打码值） |

随仓 Web 不触发：`apps/web/src/data-sources/buildPayload.ts:39-41` 把口令放 `credentials`。直接调 API 会触发。

### 一个关键事实（决定了可以 fail-closed 而不损功能）——严格限定在"API 可写的扁平 `connection` 的键名"

**在 API 可写的扁平 `connection`（`ConnectionConfigSchema` 只收标量，见上表第 1 行）里，没有任何适配器按键名从 `connection` 取秘密。** 逐个查过全部 10 个适配器，秘密一律来自 `config.credentials`：

- `PostgresAdapter.ts:85-86`、`MSSQLAdapter.ts:194-195`、`MySQLAdapter.ts:205-206`、`MongoDBAdapter.ts:519`、`HTTPAdapter.ts:152-156`、`PLMAdapter.ts:1084-1086`；
- `AthenaAdapter` / `ElasticsearchAdapter` / `RedisAdapter` / `BaseAdapter` 不读任何秘密键。

即：以**秘密形状的键名**写进 `connection` 的口令**从来没有参与过认证**，它只是一份会被 GET 回显的明文。拒收这种键不会拿走任何"本来能用"的配置。

**这句话不能读成"`connection` 底下的任何东西都不参与认证"——那是假的。** 三个实测反例（都按键名不可见，本刀一律拦不住，全部登记在 §6）：

1. **URL userinfo 在值里**：`connection.baseURL = 'https://user:pw@host'` 经 `HTTPAdapter.ts:138` 直接喂给 axios，axios（`axios@1.13.2` 的 `lib/adapters/http.js:574-578`，本 worktree 实读；`:580` 还会因此丢掉 credentials 来的 Bearer 头）把 URL 里的用户名/口令变成**真实的 Basic 认证**——这份口令是**在用的**，不是无害明文。键名是 `baseURL`，判据、剥离、`redactSecrets` 三条腿全部看不见它；`PLMAdapter.ts:1137` 还会把 `connection.url` 连 userinfo 原样写进服务端日志。
2. **`connection.headers.Authorization`**：API 送不进来（Zod 记录只收标量），但 `PLMAdapter.ts:1076-1080` / `:1200-1205` 在运行时把自己的 Bearer 写回 `this.config.connection.headers`，`HTTPAdapter.ts:140,:147` 把这些头铺进 axios 默认头；`BaseAdapter.ts:551-553` 的 `getConfig()` 是浅拷贝，所以 `PUT /:id` 的深合并（`routes/data-sources.ts:725`）会把它重新落库。存量行里可以躺着一份**能用的**凭证。
3. **进程内写入口**：`DataSourceManager.addDataSource/updateDataSource` 完全不经本刀的守卫（§3 末已明说）。

## 2. 单一定义

新模块 `packages/core-backend/src/data-adapters/data-source-secret-keys.ts`（零依赖，不与 BaseAdapter 形成环）：

| 导出 | 行（F03 之后） | 用途 |
|---|---|---|
| `DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE` | :68 | 拒收错误码（沿用仓内既有的 `DATA_SOURCE_*` 导出常量形状，与 `DataSourceManager.ts:31 DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE`、`:32 DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE` 同形；不新造码体系，未动 `apps/web/src/services/integration/errorCodeLabels.ts`） |
| `DATA_SOURCE_SECRET_KEY_WORDS` | :100 | **唯一词表** |
| `GLUED_KEY_QUALIFIERS`（模块内） | :133 | `wholeTokenOnly` 词的限定词前缀白名单（F03） |
| `foldKey`（模块内） | :155 | NFKC 归一化，**只作用于键名**（F03） |
| `isSecretConfigKey(key)` | :181 | 唯一判据 |
| `findSecretConfigKeyPaths(value, basePath)` | :216 | 写入拒收用；只回**键路径**，从不回值 |
| `stripSecretConfigKeys(value)` | :248 | 读取剥离用；深拷贝去键 |
| `collectSecretConfigValues(parts)` | :275 | `redactSecrets` 的值列表 |
| `secretKeyValueTextPattern()` | :315 | `redactSecrets` 的 `key=value` 正则，由同一词表生成 |
| `connectionSecretRefusalMessage(paths)` | :333 | values-free 拒收文案 |

词表（`password / passwd / pwd / pswd / passphrase / passcode / pass / pw / secret / token / credential / apiKey / accessKey / privateKey / authorization`）是它替换掉的三份键集的**超集**：

- `DataSourceManager.ts:25` `SENSITIVE_CREDENTIAL_KEYS = ['password','apiKey','token']`（该常量本身未动，见 §5）；
- `BaseAdapter.redactSecrets` 原值元组 `credentials.password/token/apiKey/secret + connection.password`；
- `BaseAdapter.redactSecrets` 原正则 `password|pwd|pass|token|api[_-]?key|secret`。

匹配规则刻意收窄，避免吃掉正常连接键：

- 键先过 **NFKC 归一化**（`foldKey`，:120 附近），再归一化（小写、去掉非字母数字）后**按子串**匹配词表；`dbPassword`、`API_KEY`、`sslPassphrase`、全角 `ｐａｓｓｗｏｒｄ` 命中。
- 标了 `wholeTokenOnly` 的词（`pass`、`pw`）必须等于键的某个 camel/下划线**整词**，或等于"**限定词前缀 + 该词**"（`GLUED_KEY_QUALIFIERS`）；`db_pass`、`dbPass`、`dbpass`、`pgpass`、`db_pw`、`rootpw` 命中，**不切词也不带限定词的拼写** `passthrough`、`bypass`、`compass`、`passive` **不**命中。实测反例（别把上一句读宽）：切词发生在比较**之前**，所以 `passThrough`、`pass_through`、`byPass` **命中**并被 400 拒收。现役五个注册适配器实读的 17 个 `connection` 键里没有这种形状（两个方向都由单测 D 组钉住）；真撞上时按词表加例外，而不是放宽规则（放宽会放行 `passHash` / `passValue` 这类真秘密形状——这两个键在单测里**正向钉着仍为 true**）。
- 没有豁免名单。`hasCredentials`（含 `credential`）是路由在剥离**之后**才挂上的计算标志，永远不会进到判据里。

### F03 词表扩容 + NFKC（本次追加，分支 `fix/data-source-secret-keys-vocab-nfkc`）

改前**被放行**（明文落库 + `GET /:id` 回显）的形状，现已全部拒收；每一条都有"修前红"收据（验证文档 §9）：

| 形状 | 改前 | 改后靠什么命中 |
|---|---|---|
| `dbpass` / `pgpass` / `sqlpass` / `userpass` / `adminpass` | 放行 | `pass` 整词 + `GLUED_KEY_QUALIFIERS` 限定词前缀 |
| `pw` / `db_pw` / `dbPw` / `userPw` / `rootpw` | 放行 | 新词 `pw`（`wholeTokenOnly`，同上限定词规则） |
| `pswd` / `dbPswd` | 放行 | 新词 `pswd`（子串） |
| `passcode` / `devicePasscode` | 放行 | 新词 `passcode`（子串） |
| 全角 `ｐａｓｓｗｏｒｄ` / `ｐｗｄ` / `ｓｅｃｒｅｔ` / `Ｔｏｋｅｎ` / `ＡＰＩ＿ＫＥＹ` | 放行（归一化后是**空串**，匹配不到任何词） | `foldKey` 的 NFKC |

**`pw` 与 `pass` 为什么不能直接改成子串匹配**：写入口是 fail-closed，每一个误伤都是"调用方再也发不出去的合法配置"。子串 `pass` 会连带拒收 `bypass` / `compass` / `surpass` / `trespass` / `overpass` / `encompass` / `passive`（FTP 的 passive 模式）/ `passenger`；子串 `pw` 会撞上 `httpwait` 这类归一化后含 `pw` 的键。所以走的是"限定词前缀白名单"：`GLUED_KEY_QUALIFIERS` 里只放**系统限定词**（`db/pg/sql/mysql/mssql/user/usr/admin/root/login/account/svc/service/app/client/api/auth/conn/ftp/sftp/ssh/smtp/imap/mail/proxy/redis/mongo/ora/oracle/my/acct/pgsql`），刻意不放看起来像限定词的英文片段 `by` / `com` / `sur` / `tres` / `over` / `en`。

**NFKC 的作用范围**：**只归一化键名，绝不动值**。`stripSecretConfigKeys` 仍按**原始键**删键，值逐字节拷贝；`collectSecretConfigValues` / `redactSecrets` 也拿**原样的值**去比对（全角值 `ｈｕｎｔｅｒ２` 不会被折成 `hunter2`，否则真秘密可能反而匹配不上自己）。单测正向钉住这一条。已知边界：NFKC 只折**兼容等价**字形，**不折跨字种同形字**——西里尔 `а` 拼的 `раssword` 仍然不命中；这是形状匹配的固有上限，见 §6。

`redactSecrets` 的 `key=value` 文本腿由同一词表生成，因此同步获得新词；限定词前缀在文本腿上写成可选组 `(?:db|pg|…)[_-]?`，所以 `dbpass=…`、`db_pw=…`、`user-pass=…` 会被打码，而 `bypass=…` / `compass=…` 不会（`\b` 边界 + 无匹配限定词）。文本腿**不做 NFKC**：它改写的是要回给调用方的报文，不能重写它没有打码的字节。

`authorization` 标了 `skipInTextPattern`：它的值是"方案 + 令牌"（`Bearer xyz`），`redactSecrets` 有一条专门吃整串的规则；把它放进 `key=value` 正则只会吃掉 `Bearer` 而漏掉令牌（该行为由 `tests/unit/data-source-test-error-fidelity.test.ts:93` 钉着）。

## 3. 写入拒收（fail-closed）

- 判据 `connectionSecretRefusal`：`routes/data-sources.ts:377`
- 路由守卫 `refuseConnectionSecrets`：`routes/data-sources.ts:389`
- 接线：`POST /api/data-sources`（:532）、`POST /api/data-sources/test`（:618）、`PUT /api/data-sources/:id`（:684）

答复：`400` + `{ ok:false, error: { code: 'DATA_SOURCE_CONNECTION_SECRET_REJECTED', message } }`。文案 values-free：只列**键路径**并指引改放 `credentials`；键路径逐段过 `^[A-Za-z0-9_-]{1,64}$`，不符合的段报成 `<key>`（防止调用方把 `password=hunter2` 当键名塞进来、再被我们原样回显/落日志）。

三个刻意的边界：

1. **在 Zod 之前、在 rbacGuard 之后**跑。之前：`ConnectionConfigSchema` 是自由记录，嵌套形状（`connection.headers.Authorization`）会先被 Zod 收成笼统的 `VALIDATION_ERROR`，拿不到可操作的拒收码；之后：匿名调用仍先得 401，不给未授权者探测器。
2. **只看本次请求发来的 `connection`，不看合并结果**。`PUT /:id` 会把补丁深合并到已存 `connection`（:725 附近的注释解释了为何必须深合并）；若检查合并结果，任何存量脏行都会被永久锁死，连改 host/port/TLS 都做不了。清除**已存**的秘密是迁移单的事。
3. **不动 `PUT /:id/credentials`**：该路由的 schema 是 `.strict()` 的纯 credentials 形状，`connection` 根本进不来。

未接线的写入口（明说）：`DataSourceManager.addDataSource/updateDataSource` 作为**进程内**入口仍可写入带秘密的 `connection`（例如插件门面直接构造 config）。这一刀不在 manager 上加拦截，原因有二：一是本刀的范围是 API 写入口；二是 `DataSourceManager.ts` 正被在飞的 #5593 改，要把 hunk 压到零。代价写在 §6。

## 4. 读取剥离（存量防御）

`sanitizeConfig`：`routes/data-sources.ts:338`，`...rest` → `...stripSecretConfigKeys(rest)`（:341）。深度剥离（存量行里可能有 `connection.headers.Authorization` 这种嵌套），非普通对象（Date/Buffer）按引用透传，环形引用丢弃。

**所有回显 `connection` 的面**（都经 `sanitizeConfig`，因此一次改全覆盖）：

| 面 | 位置 | 说明 |
|---|---|---|
| `GET /api/data-sources/:id` | :506 | 缺口的主现场 |
| `POST /api/data-sources`（201 回显） | :582 | |
| `PUT /api/data-sources/:id`（200 回显） | :756 | |
| `PUT /api/data-sources/:id/credentials`（200 回显） | :851 | |
| update 审计 meta `before`/`after` | :748-749 | **审计库也是回显面**，之前会把明文抄进 `audit_logs.meta` |
| rotate 审计 meta `before`/`after` | :843-844 | 同上 |
| delete 审计 meta | :935 | 同上 |

核过但**不经** `sanitizeConfig`、也不回显 connection 的面：

- `GET /api/data-sources`（列表）：`DataSourceManager.listDataSources`（:1262）只投影 `id/name/type/connected/ownerId`；
- `GET /api/data-sources/health`：只有 `id/connected/responsive/latency`；
- `GET /api/data-sources/:id/test`：只回 `success/latency/error.message`，其中 `error.message` 是 `redactSecrets` 之后的串——本刀让它按同一词表取值，存量 `connection.password` 因此也会被打成 `***`（第 4 条腿现在与前三条同源）；
- `POST /api/data-sources/test`：结果-only，且额外有 `testEphemeralConnection` 的提交值 scrub（`DataSourceManager.ts:953` 附近）；
- `/query` `/select` `/schema` `/tables/:table`：返回的是数据面结果，不含 config。

## 5. 存储不动（盘点 + 迁移方案 = 另单）

本刀**不改落库**：`configToRecord` 照旧、不写迁移、不改 `SENSITIVE_CREDENTIAL_KEYS`。存量行仍持有明文（单元与真库测试都把这一点**正向钉住**，防止有人误以为已经清理过）。

### SQL 侧的两个前置（F10 追加）

**(1) 先确认列形状。** 仓内有**两份** `data_sources` 的 DDL，且都带 `IF NOT EXISTS` 守卫，谁先跑谁生效：

| 形状 | 来源 | `connection` 在哪 |
|---|---|---|
| **形状 A（现役）** | `packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:30` `config jsonb NOT NULL` | `config->'connection'` |
| **形状 B（旧 SQL 迁移）** | `packages/core-backend/migrations/040_data_sources.sql:12` `connection JSONB NOT NULL`（该 DDL 没有 `config` 列） | `connection` 自成一列 |

应用侧（`db/types.ts:895 DataSourcesTable.config`、`DataSourceManager.configToRecord`、真库件）一律按**形状 A**读写，所以生产库几乎肯定是 A；但上机前先跑这条再挑对应的 SQL：

```sql
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'data_sources'
   AND column_name IN ('config', 'connection');
```

**(2) 两段正则**（下文所有 SQL 里的 `<SECRET_SUBSTRING>` / `<SECRET_GLUED>` 都原样替换成这两行，改词表时只改这里）：

```
<SECRET_SUBSTRING> = (password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)
<SECRET_GLUED>     = ^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$
```

`<SECRET_GLUED>` 是 `pass` / `pw` 两个 `wholeTokenOnly` 词在 SQL 侧的近似：归一化（小写 + 去非字母数字）之后 `db_pass`、`dbPass`、`dbpass` 都变成 `dbpass`，锚定 `^…$` 就等价于"整词 / 限定词 + 整词"，同时 `bypass`、`passthrough` 仍然不命中。

### 只读盘点（只查 count / 键名，绝不 SELECT 值）

A. 键普查（看清 `connection` 里到底有哪些键名；只出键名与行数）：

```sql
SELECT k AS connection_key, count(*)::int AS rows
  FROM data_sources ds,
       LATERAL jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
 GROUP BY k
 ORDER BY rows DESC, connection_key;
```

B. 命中计数（**顶层键**，#5648 版词表，只出一个数）：

```sql
SELECT count(*)::int AS affected_rows
  FROM data_sources ds
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
          WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                ~ '(password|passwd|pwd|passphrase|secret|token|credential|apikey|accesskey|privatekey|authorization)'
       );
```

B 由真库道**原样执行**（`tests/integration/data-source-connection-secret-keys-realdb.test.ts` 最后一例），所以它不会随 schema 变化而腐烂——代价是它的正则被钉成了 #5648 那一版（既没有 F03 的新词，也没有嵌套分支）。**真正盘点以下面的 B2 为准**，B 只当"这段 SQL 还能在真 schema 上跑"的活证据。

B2. 命中计数（**顶层 + 嵌套路径**，F03 词表）——形状 A：

```sql
SELECT count(*)::int AS affected_rows
  FROM data_sources ds
 WHERE EXISTS (
         SELECT 1
           FROM (VALUES ('{connection}'::text[]),
                        ('{connection,headers}'::text[]),
                        ('{credentials}'::text[])        -- 可按 A 的键普查继续加行
                ) AS p(path)
           CROSS JOIN LATERAL jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> p.path) = 'object'
                      THEN ds.config #> p.path
                      ELSE '{}'::jsonb END
               ) AS keys(k)
          WHERE lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g')) ~  '<SECRET_SUBSTRING>'
             OR lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g')) ~  '<SECRET_GLUED>'
       );
```

形状 B 只需把 `ds.config #> p.path` 换成 `ds.connection #> p.path`，并把 VALUES 里的路径去掉首段（`'{}'::text[]` 表示 `connection` 自身、`'{headers}'` 表示嵌套头）：

```sql
           FROM (VALUES ('{}'::text[]), ('{headers}'::text[])) AS p(path)
           CROSS JOIN LATERAL jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.connection #> p.path) = 'object'
                      THEN ds.connection #> p.path
                      ELSE '{}'::jsonb END
               ) AS keys(k)
```

`jsonb_typeof(...) = 'object'` 的 CASE 不是装饰：`jsonb_object_keys` 对标量/数组直接报错，而 `connection.headers` 在存量行里完全可能是字符串。

B3（可选）。**全深度**递归——当 A 的键普查显示还有别的嵌套容器时用，形状 A：

```sql
WITH RECURSIVE walk(id, path, node) AS (
        SELECT ds.id, '{connection}'::text[], ds.config #> '{connection}'
          FROM data_sources ds
         WHERE jsonb_typeof(ds.config #> '{connection}') = 'object'
      UNION ALL
        SELECT w.id, w.path || e.key, e.value
          FROM walk w
          CROSS JOIN LATERAL jsonb_each(w.node) AS e
         WHERE jsonb_typeof(e.value) = 'object'
     )
SELECT count(DISTINCT w.id)::int AS affected_rows
  FROM walk w
  CROSS JOIN LATERAL jsonb_object_keys(w.node) AS keys(k)
 WHERE lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g')) ~ '<SECRET_SUBSTRING>'
    OR lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g')) ~ '<SECRET_GLUED>';
```

（把最后两行的 `count(DISTINCT w.id)` 换成 `SELECT DISTINCT w.path || keys.k AS secret_path` 就得到"键路径清单"，仍然只出键名、不出值。没用 `jsonb_path_query(..., '$.**.keyvalue()')` 那个更短的写法：`.**` 配 `.keyvalue()` 在 lax 模式下对非对象节点的行为本机无 PG 可证，递归 CTE 的语义是确定的。）

B/B2/B3 与应用判据的**已知差异**（都只会**漏报**，不会多报）：

1. **切词只在应用侧**：应用把 `passThroughMode` 切成 `[pass, through, mode]` 后命中，SQL 归一化成 `passthroughmode` 后不命中；同理 `passHash` 应用命中、SQL 不命中。SQL 认得的是"整键就是（限定词+）`pass`/`pw`"。以 A 的键普查兜底，人工过一眼键名。
2. **数组不进 B3**：`jsonb_each` 对数组报错，B3 用 `jsonb_typeof(e.value) = 'object'` 只下钻对象；应用侧 `findSecretConfigKeyPaths` 会走数组。存量 `connection` 里出现数组容器的概率极低，但这是差异。
3. **全角/兼容字形**：应用侧 F03 之后做 NFKC，SQL 侧**没做**——`connection.ｐａｓｓｗｏｒｄ` 归一化后是空串，B/B2/B3 都盘不到。PG 侧要补需要 `normalize(k, NFKC)`（PG 13+ 对 `text` 可用），本机无 PG 未验证，先由 A 的键普查肉眼兜住（全角键在键名清单里一眼可见）。
4. **值面盘不出来**：口令藏在 URL userinfo（`connection.baseURL = 'https://user:pw@host'`）里时键名是 `baseURL`，所有这些查询都只认键名，永远看不见它。见 §6（F01）。

### 迁移方案（另单执行）

1. 先跑列形状探针 + A + B2，把受影响行数与键名固定成工单证据；
2. 备份 `data_sources`（形状 A 至少 `id, config` 两列；形状 B 至少 `id, connection`）；
3. 去键（不改任何其它字段）。**顶层**（形状 A）：

```sql
UPDATE data_sources ds
   SET config = jsonb_set(
         ds.config, '{connection}',
         (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
            FROM jsonb_each(ds.config->'connection') AS e
           WHERE lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_SUBSTRING>'
             AND lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_GLUED>')
       ),
       updated_at = NOW()
 WHERE jsonb_typeof(ds.config->'connection') = 'object'
   AND <与 B2 相同的 EXISTS 条件>;
```

3b. **嵌套 `{connection,headers}`**（形状 A）——**单独一步，且不能和上一步一起无脑跑**，理由见第 5 条：

```sql
UPDATE data_sources ds
   SET config = jsonb_set(
         ds.config, '{connection,headers}',
         (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
            FROM jsonb_each(ds.config #> '{connection,headers}') AS e
           WHERE lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_SUBSTRING>'
             AND lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_GLUED>'),
         false   -- create_missing=false：没有 headers 的行绝不能被"创建"出一个空 headers
       ),
       updated_at = NOW()
 WHERE jsonb_typeof(ds.config #> '{connection,headers}') = 'object'
   AND EXISTS (
         SELECT 1
           FROM jsonb_object_keys(ds.config #> '{connection,headers}') AS k
          WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g')) ~ '<SECRET_SUBSTRING>'
             OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g')) ~ '<SECRET_GLUED>'
       );
```

形状 B 的两条：把 `ds.config` 换成 `ds.connection`、路径 `'{connection}'` → 直接对整列聚合、`'{connection,headers}'` → `'{headers}'`：

```sql
-- 形状 B 顶层
UPDATE data_sources ds
   SET connection = (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                       FROM jsonb_each(ds.connection) AS e
                      WHERE lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_SUBSTRING>'
                        AND lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_GLUED>'),
       updated_at = NOW()
 WHERE jsonb_typeof(ds.connection) = 'object' AND <与 B2 相同的 EXISTS 条件>;

-- 形状 B 嵌套
UPDATE data_sources ds
   SET connection = jsonb_set(ds.connection, '{headers}',
         (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
            FROM jsonb_each(ds.connection #> '{headers}') AS e
           WHERE lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_SUBSTRING>'
             AND lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) !~ '<SECRET_GLUED>'),
         false),
       updated_at = NOW()
 WHERE jsonb_typeof(ds.connection #> '{headers}') = 'object' AND <同上 EXISTS>;
```

**以上 SQL 一条都没有实跑**（本机无 Postgres，见验证文档 §4/§9），语法按 PG 16 文档写：`jsonb_set(target, path, new_value[, create_missing])`、`#>`、`jsonb_typeof`、`jsonb_object_keys`、`jsonb_each`、`jsonb_object_agg`、`WITH RECURSIVE`。上机前先在**备份库**上跑一遍，并先用 `SELECT` 版（把 `UPDATE … SET` 换成 `SELECT ds.id, <新值>`）对照几行再落 UPDATE。

4. 复跑 **B2**（不是 B），期望 0；
5. **把被删掉的口令视为已泄露**（它进过 GET 响应，多半也进过 `audit_logs.meta`），通知 owner 走 `PUT /:id/credentials` 轮换；删除这些**顶层秘密形状键**不会弄坏任何连接——§1 证明的是"没有适配器按**键名**从 `connection` 取秘密"。

   **第 3b 步（嵌套 headers）不享受这条理由，必须单独走。** §1 的反例 2 是实测的：`connection.headers.Authorization` 是 PLMAdapter 在运行时写回、HTTPAdapter 真的会铺进 axios 默认头的**在用凭证**（`PLMAdapter.ts:1076-1080`/`:1200-1205`、`HTTPAdapter.ts:140,:147`）。删掉它 = 让该数据源当场失去认证，直到令牌重新签发。因此 3b 是"先与 owner 约定重新签发/重连窗口，再执行"的一步，不能和第 3 步打包成一条运维命令；F02 落地（Bearer 不再写回 config）之后 3b 才会退化成纯清理。URL userinfo 里的口令（反例 1）同理是在用凭证，且**任何一条 SQL 都看不见它**（键名是 `baseURL`）。
6. `audit_logs` 里的历史 `meta.connection` 是否一并清洗，由 owner 裁决（涉及审计不可变性，不在工程侧单方面决定）。

## 6. 已知边界（不隐瞒）

- **进程内写入口未拦**：见 §3 末。现状下它只能由仓内代码触发（无外部输入路径），且读取面已剥离；真正封口应在 `DataSourceManager` 的 `configToRecord`/`addDataSource` 上做，建议与迁移单一起做（那时 manager 上的 #5593 冲突也已落地）。
- **判据是形状匹配，不是语义**：把口令放进 `connection.hostAlias` 这种非口令形状的键，仍会明文落库并回显。形状匹配抓的是"看起来像秘密的键"，抓不住"藏在正常键里的秘密"。F03 把词表加宽、加了 NFKC，抬高的是**同一种**匹配的下限，没有改变它的种类；跨字种同形字（西里尔 `а` 拼的 `раssword`）NFKC 也不折，同样漏。
- **拒收不回溯**：存量行照旧可以被编辑（只要本次请求不带秘密键），其存量秘密不会被这次编辑清掉。
- **`redactSecrets` 的值打码对超短值仍然粗暴**（1-2 字符的口令会把消息切碎）——改前就是这样，本刀没有改变该行为。本刀只加了**按长度降序替换**（`collectSecretConfigValues` 返回前排序），使短秘密不会把以它为前缀的长秘密切碎留尾巴（`{secret:'xy', password:'xyz'}` 对 "tried xyz" 原本得 `***z`）。

### 后续单（终审登记，均不在本刀范围）

| 编号 | 内容 | 落点 |
|---|---|---|
| F01 | **URL userinfo 值面**：`connection.baseURL/url` 里的 `user:pw@` 不拒、不剥、不打码，且经 axios 真的当 Basic 认证用。修法需要配套的 credentials 迁移路径（`HTTPAdapter.ts:162-166` 已支持 Basic），不能直接 400 掐断存量可用配置；同时把 `PLMAdapter.ts:1137` 的日志改成脱敏 URL | `data-source-secret-keys.ts`（加值形状判据）+ `PLMAdapter.ts:1137` |
| F02 | **PLMAdapter 别把 Bearer 写回 `config.connection`**：改存私有字段、建 axios client 时再合并 headers，从源头消掉"PUT 一次就把进程内令牌落库一次" | `PLMAdapter.ts:1076-1080`、`:1200-1205` |
| ~~F03~~ | **已落地**（分支 `fix/data-source-secret-keys-vocab-nfkc`，叠在本 PR 上）：词表补 `pw` / `pswd` / `passcode` + 限定词前缀 + NFKC，`dbpass`、`db_pw`、`pswd`、`passcode`、`ｐａｓｓｗｏｒｄ` 全部改判拒收。见上面 §2 的「F03 词表扩容 + NFKC」与验证文档 §9 | `data-source-secret-keys.ts` |
| ~~F10~~ | **已落地**（同上分支）：§5 加了列形状探针、B2（顶层 + `{connection,headers}` 嵌套）、B3（全深度递归）、迁移 UPDATE 的 3b 嵌套分支，形状 A / 形状 B 两套都给；**全部未实跑**（本机无 PG） | 本文件 §5 |
| — | **admin bulk 路由对 `data_sources` 的原始写**：`routes/admin-routes.ts:1259-1318` 的 `PUT /api/admin/data/bulk`，`validTables` 含 `data_sources`（`:1283`），`:1315` `db.updateTable(table).set(updates)` 原样落库，绕过 `refuseConnectionSecrets` 与 `configToRecord`；同文件 `:1197` 的 bulk delete 同理可删源。**门是 `requireSafetyCheck({operation: BULK_UPDATE})`（`:1261-1268`）而不是 `requireAdminRole`**（`admin-routes.ts:92` 的 `requireAdminRole()` 挂在另一条"安全确认"端点上，不在这条链里）；`BULK_UPDATE` 在 `guards/SafetyGuard.ts:57` 是 `RiskLevel.HIGH`，因此要走确认令牌流程——该流程是否等价于"仅平台管理员"本轮未复核。读面仍被 `sanitizeConfig` 剥。建议把 `data_sources` 从两张 `validTables` 里摘掉，与在飞的 #5593 存储线协调后执行 | `routes/admin-routes.ts` |

## 7. 与在飞 PR 的争用

- #5593（列表/详情加 `referenceCount`）同时改 `routes/data-sources.ts` 与 `DataSourceManager.ts`。本刀：`DataSourceManager.ts` **零改动**；`routes/data-sources.ts` 的 hunk 全部落在 import 区（:13、:35-40）、`sanitizeConfig`/新守卫区（:338-396）以及三条**写**路由的注册行（:532/:618/:684），不碰列表（:405）与详情（:490）路由体。
- 未动 pin、未动迁移、未动 `errorCodeLabels.ts`。
