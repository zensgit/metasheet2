# 数据源 connection 口令字段：单一定义 + 写入拒收 + 读取剥离（设计）

- Issue：#5621（`connection.password` 明文落库并随 `GET /api/data-sources/:id` 回显）
- 分支：`fix/data-source-connection-password-plaintext`（worktree `metasheet-wt-w3b`，基于 origin/main）
- 落笔时间：2026-09-11 18:5x（本地 UTC+8；Git Bash 的 `date` 打的是 UTC，差 8 小时）。文件名日期 `20260912` 沿用协调方指定的命名，不是落笔日。
- 配套：`docs/development/data-source-connection-secret-keys-verification-20260912.md`

## 1. 缺口：同一个字段，四处三种口径

| # | 位置（改前） | 对 `connection.password` 的态度 |
|---|---|---|
| 1 | `packages/core-backend/src/routes/data-sources.ts:79` `ConnectionConfigSchema = z.record(...)` | **接受**（自由记录，任何字符串键都放行） |
| 2 | `packages/core-backend/src/data-adapters/DataSourceManager.ts:409` `configToRecord` | **明文落库**（只对 `config.credentials` 调 `encryptCredentials`，`connection` 原样进 jsonb） |
| 3 | `packages/core-backend/src/routes/data-sources.ts:321-327` `sanitizeConfig` | **原样回显**（只解构 `credentials`，`connection` 随 `...rest` 返回，并被复制进 update/rotate/delete 的审计 meta） |
| 4 | `packages/core-backend/src/data-adapters/BaseAdapter.ts:504` `redactSecrets` | **当作秘密**（`conn.password` 计入待打码值） |

随仓 Web 不触发：`apps/web/src/data-sources/buildPayload.ts:39-41` 把口令放 `credentials`。直接调 API 会触发。

### 一个关键事实（决定了可以 fail-closed 而不损功能）

**没有任何适配器从 `connection` 取秘密。** 逐个查过全部 10 个适配器，秘密一律来自 `config.credentials`：

- `PostgresAdapter.ts:85-86`、`MSSQLAdapter.ts:194-195`、`MySQLAdapter.ts:205-206`、`MongoDBAdapter.ts:519`、`HTTPAdapter.ts:152-156`、`PLMAdapter.ts:1084-1086`；
- `AthenaAdapter` / `ElasticsearchAdapter` / `RedisAdapter` / `BaseAdapter` 不读任何秘密键。

即：写进 `connection` 的口令**从来没有参与过认证**，它只是一份会被 GET 回显的明文。拒收它不会拿走任何"本来能用"的配置。

## 2. 单一定义

新模块 `packages/core-backend/src/data-adapters/data-source-secret-keys.ts`（零依赖，不与 BaseAdapter 形成环）：

| 导出 | 行 | 用途 |
|---|---|---|
| `DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE` | :36 | 拒收错误码（沿用仓内既有的 `DATA_SOURCE_*` 导出常量形状，与 `DataSourceManager.ts:31 DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE`、`:32 DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE` 同形；不新造码体系，未动 `apps/web/src/services/integration/errorCodeLabels.ts`） |
| `DATA_SOURCE_SECRET_KEY_WORDS` | :60 | **唯一词表** |
| `isSecretConfigKey(key)` | :90 | 唯一判据 |
| `findSecretConfigKeyPaths(value, basePath)` | :125 | 写入拒收用；只回**键路径**，从不回值 |
| `stripSecretConfigKeys(value)` | :157 | 读取剥离用；深拷贝去键 |
| `collectSecretConfigValues(parts)` | :180 | `redactSecrets` 的值列表 |
| `secretKeyValueTextPattern()` | :209 | `redactSecrets` 的 `key=value` 正则，由同一词表生成 |
| `connectionSecretRefusalMessage(paths)` | :225 | values-free 拒收文案 |

词表（`password / passwd / pwd / passphrase / pass / secret / token / credential / apiKey / accessKey / privateKey / authorization`）是它替换掉的三份键集的**超集**：

- `DataSourceManager.ts:25` `SENSITIVE_CREDENTIAL_KEYS = ['password','apiKey','token']`（该常量本身未动，见 §5）；
- `BaseAdapter.redactSecrets` 原值元组 `credentials.password/token/apiKey/secret + connection.password`；
- `BaseAdapter.redactSecrets` 原正则 `password|pwd|pass|token|api[_-]?key|secret`。

匹配规则刻意收窄，避免吃掉正常连接键：

- 键先归一化（小写、去掉非字母数字）后**按子串**匹配词表；`dbPassword`、`API_KEY`、`sslPassphrase` 命中。
- 标了 `wholeTokenOnly` 的词（只有 `pass`）必须等于键的某个 camel/下划线**整词**；`db_pass`、`dbPass` 命中，`passthrough`、`bypass` **不**命中。
- 没有豁免名单。`hasCredentials`（含 `credential`）是路由在剥离**之后**才挂上的计算标志，永远不会进到判据里。

`authorization` 标了 `skipInTextPattern`：它的值是"方案 + 令牌"（`Bearer xyz`），`redactSecrets` 有一条专门吃整串的规则；把它放进 `key=value` 正则只会吃掉 `Bearer` 而漏掉令牌（该行为由 `tests/unit/data-source-test-error-fidelity.test.ts:93` 钉着）。

## 3. 写入拒收（fail-closed）

- 判据 `connectionSecretRefusal`：`routes/data-sources.ts:362`
- 路由守卫 `refuseConnectionSecrets`：`routes/data-sources.ts:374`
- 接线：`POST /api/data-sources`（:517）、`POST /api/data-sources/test`（:603）、`PUT /api/data-sources/:id`（:669）

答复：`400` + `{ ok:false, error: { code: 'DATA_SOURCE_CONNECTION_SECRET_REJECTED', message } }`。文案 values-free：只列**键路径**并指引改放 `credentials`；键路径逐段过 `^[A-Za-z0-9_-]{1,64}$`，不符合的段报成 `<key>`（防止调用方把 `password=hunter2` 当键名塞进来、再被我们原样回显/落日志）。

三个刻意的边界：

1. **在 Zod 之前、在 rbacGuard 之后**跑。之前：`ConnectionConfigSchema` 是自由记录，嵌套形状（`connection.headers.Authorization`）会先被 Zod 收成笼统的 `VALIDATION_ERROR`，拿不到可操作的拒收码；之后：匿名调用仍先得 401，不给未授权者探测器。
2. **只看本次请求发来的 `connection`，不看合并结果**。`PUT /:id` 会把补丁深合并到已存 `connection`（:710 附近的注释解释了为何必须深合并）；若检查合并结果，任何存量脏行都会被永久锁死，连改 host/port/TLS 都做不了。清除**已存**的秘密是迁移单的事。
3. **不动 `PUT /:id/credentials`**：该路由的 schema 是 `.strict()` 的纯 credentials 形状，`connection` 根本进不来。

未接线的写入口（明说）：`DataSourceManager.addDataSource/updateDataSource` 作为**进程内**入口仍可写入带秘密的 `connection`（例如插件门面直接构造 config）。这一刀不在 manager 上加拦截，原因有二：一是本刀的范围是 API 写入口；二是 `DataSourceManager.ts` 正被在飞的 #5593 改，要把 hunk 压到零。代价写在 §6。

## 4. 读取剥离（存量防御）

`sanitizeConfig`：`routes/data-sources.ts:338`，`...rest` → `...stripSecretConfigKeys(rest)`（:341）。深度剥离（存量行里可能有 `connection.headers.Authorization` 这种嵌套），非普通对象（Date/Buffer）按引用透传，环形引用丢弃。

**所有回显 `connection` 的面**（都经 `sanitizeConfig`，因此一次改全覆盖）：

| 面 | 位置 | 说明 |
|---|---|---|
| `GET /api/data-sources/:id` | :491 | 缺口的主现场 |
| `POST /api/data-sources`（201 回显） | :567 | |
| `PUT /api/data-sources/:id`（200 回显） | :741 | |
| `PUT /api/data-sources/:id/credentials`（200 回显） | :836 | |
| update 审计 meta `before`/`after` | :733-734 | **审计库也是回显面**，之前会把明文抄进 `audit_logs.meta` |
| rotate 审计 meta `before`/`after` | :828-829 | 同上 |
| delete 审计 meta | :920 | 同上 |

核过但**不经** `sanitizeConfig`、也不回显 connection 的面：

- `GET /api/data-sources`（列表）：`DataSourceManager.listDataSources`（:1262）只投影 `id/name/type/connected/ownerId`；
- `GET /api/data-sources/health`：只有 `id/connected/responsive/latency`；
- `GET /api/data-sources/:id/test`：只回 `success/latency/error.message`，其中 `error.message` 是 `redactSecrets` 之后的串——本刀让它按同一词表取值，存量 `connection.password` 因此也会被打成 `***`（第 4 条腿现在与前三条同源）；
- `POST /api/data-sources/test`：结果-only，且额外有 `testEphemeralConnection` 的提交值 scrub（`DataSourceManager.ts:953` 附近）；
- `/query` `/select` `/schema` `/tables/:table`：返回的是数据面结果，不含 config。

## 5. 存储不动（盘点 + 迁移方案 = 另单）

本刀**不改落库**：`configToRecord` 照旧、不写迁移、不改 `SENSITIVE_CREDENTIAL_KEYS`。存量行仍持有明文（单元与真库测试都把这一点**正向钉住**，防止有人误以为已经清理过）。

### 只读盘点（只查 count / 键名，绝不 SELECT 值）

A. 键普查（看清 `connection` 里到底有哪些键名；只出键名与行数）：

```sql
SELECT k AS connection_key, count(*)::int AS rows
  FROM data_sources ds,
       LATERAL jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
 GROUP BY k
 ORDER BY rows DESC, connection_key;
```

B. 命中计数（与应用侧词表同形，只出一个数）：

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

B 与应用判据的**已知差异**：SQL 侧没有实现 `pass` 的"整词"规则（归一化后无法表达词边界），所以 `connection.pass` / `connection.db_pass` 不会被 B 计入 —— 由 A 的键普查兜住（人工过一眼键名即可）。写迁移前以 A 为准。

真库道里 B 被原样执行（`tests/integration/data-source-connection-secret-keys-realdb.test.ts` 最后一例），所以这段 SQL 不会随 schema 变化而腐烂。

### 迁移方案（另单执行）

1. 先跑 A + B，把受影响行数与键名固定成工单证据；
2. 备份 `data_sources`（至少 `id, config` 两列）；
3. 去键（不改任何其它字段）：

```sql
UPDATE data_sources ds
   SET config = jsonb_set(
         ds.config, '{connection}',
         (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
            FROM jsonb_each(ds.config->'connection') AS e
           WHERE lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g'))
                 !~ '(password|passwd|pwd|passphrase|secret|token|credential|apikey|accesskey|privatekey|authorization)')
       ),
       updated_at = NOW()
 WHERE <与 B 相同的 EXISTS 条件>;
```

4. 复跑 B，期望 0；
5. **把被删掉的口令视为已泄露**（它进过 GET 响应，多半也进过 `audit_logs.meta`），通知 owner 走 `PUT /:id/credentials` 轮换；删除本身不会弄坏任何连接——§1 已证明没有适配器读它。
6. `audit_logs` 里的历史 `meta.connection` 是否一并清洗，由 owner 裁决（涉及审计不可变性，不在工程侧单方面决定）。

## 6. 已知边界（不隐瞒）

- **进程内写入口未拦**：见 §3 末。现状下它只能由仓内代码触发（无外部输入路径），且读取面已剥离；真正封口应在 `DataSourceManager` 的 `configToRecord`/`addDataSource` 上做，建议与迁移单一起做（那时 manager 上的 #5593 冲突也已落地）。
- **判据是形状匹配，不是语义**：把口令放进 `connection.hostAlias` 这种非口令形状的键，仍会明文落库并回显。形状匹配抓的是"看起来像秘密的键"，抓不住"藏在正常键里的秘密"。
- **拒收不回溯**：存量行照旧可以被编辑（只要本次请求不带秘密键），其存量秘密不会被这次编辑清掉。
- **`redactSecrets` 的值打码对超短值仍然粗暴**（1-2 字符的口令会把消息切碎）——改前就是这样，本刀没有改变该行为。

## 7. 与在飞 PR 的争用

- #5593（列表/详情加 `referenceCount`）同时改 `routes/data-sources.ts` 与 `DataSourceManager.ts`。本刀：`DataSourceManager.ts` **零改动**；`routes/data-sources.ts` 的 hunk 全部落在 import 区（:13、:35-40）、`sanitizeConfig`/新守卫区（:338-382）以及三条**写**路由的注册行（:517/:603/:669），不碰列表（:390）与详情（:475）路由体。
- 未动 pin、未动迁移、未动 `errorCodeLabels.ts`。
