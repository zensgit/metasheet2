# 数据源 connection 口令字段：验证记录

- 配套设计：`docs/development/data-source-connection-secret-keys-design-20260912.md`
- Issue #5621 / 分支 `fix/data-source-connection-password-plaintext` / worktree `metasheet-wt-w3b`
- 执行环境：Windows 11 + Node 20 + pnpm 9.15.9 + vitest 1.6.1；**本机无 Postgres**（`127.0.0.1:5432` ECONNREFUSED，`DATABASE_URL` 未设），真库件只写成 CI 真库道形状、本机未执行（见 §4）。
- 依赖安装：`pnpm install --frozen-lockfile --prefer-offline --filter @metasheet/core-backend...`（一次，46.6s，exit 0；用 filter 是为了省磁盘，本机 C: 仅余 17G）。

## 1. 新增/改动的件

| 件 | 性质 |
|---|---|
| `packages/core-backend/src/data-adapters/data-source-secret-keys.ts` | 新增：单一定义（词表 + 判据 + 拒收路径扫描 + 剥离 + 值收集 + 文本正则 + 错误码/文案） |
| `packages/core-backend/src/routes/data-sources.ts` | 改：import（:13、:35-40）、`sanitizeConfig` 剥离（:338-344）、拒收判据/守卫（:346-382）、三条写路由接线（:517/:603/:669） |
| `packages/core-backend/src/data-adapters/BaseAdapter.ts` | 改：import（:3）、`redactSecrets` 改用共享词表（:502-514） |
| `packages/core-backend/tests/unit/data-source-connection-secret-keys.test.ts` | 新增：68 例 |
| `packages/core-backend/tests/integration/data-source-connection-secret-keys-realdb.test.ts` | 新增：4 例（真库道，本机 skip） |
| `.github/workflows/plugin-tests.yml` | 改：真库道枚举里加一行（紧邻既有两条 data-source realdb 件） |

`DataSourceManager.ts` **零改动**（避让在飞的 #5593）。未动 pin、迁移、`errorCodeLabels.ts`。

## 2. 单元测试（本机执行）

```
$ node_modules/.bin/vitest run tests/unit/data-source-connection-secret-keys.test.ts --reporter=dot
 ✓ tests/unit/data-source-connection-secret-keys.test.ts  (68 tests) 85ms
 Test Files  1 passed (1)
      Tests  68 passed (68)
```

覆盖的四组：

- **A 写入拒收**：`POST /api/data-sources` 带 `connection.password` → 400 + `DATA_SOURCE_CONNECTION_SECRET_REJECTED`，**零落库**（假库 upsert 计数不变 + 读回 404）；8 种键形（`password / dbPassword / API_KEY / accessToken / clientSecret / pass / pwd / sslPassphrase`）逐一拒收；嵌套 `connection.headers.Authorization` 同码拒收；非标识符键名报成 `connection.<key>` 且不回显 `hunter2`；`PUT /:id` 拒收且存量行未被改名/改 host；`POST /api/data-sources/test` 拒收且 `dialAttempts === 0`（拒收发生在拨号之前）；匿名仍先得 401（顺序没被守卫抢跑）。
- **A 收窄对照**：`host/port/database/encrypt/trustServerCertificate/strictOffsetOrdering/passthroughMode` 一并提交 → 201 且原样回显（证明守卫不是一刀切）。
- **B 读取剥离**：直接插库造的存量行（`connection.password` + `connection.headers.Authorization`）→ `GET /:id` 只剩非秘密键、`hasCredentials:true` 仍在；`GET /:id/test` 的失败原因里秘密被打成 `***` 且保留 `ECONNREFUSED`；一次无关的 `PUT` 之后 **audit 行**（`before`/`after`）无秘密，**而库里那行仍带明文**（正向钉住"存储不动"）。
- **C 正例**：口令放 `credentials` → 201 + `hasCredentials:true`，落库是 `enc:` 前缀，响应不含口令；`POST /test` 正例照常 success。
- **D 单一定义**：`isSecretConfigKey` 命中表 22 项 / 不命中表 22 项；`stripSecretConfigKeys` 逐层去键；`collectSecretConfigValues` 同时取 credentials 与 connection（含嵌套）；生成的文本正则是旧手写正则的**超集**，且 `authorization=Bearer xyz` 仍交给专用规则处理。

## 3. 回归（本机执行，21 个相邻 spec）

```
$ vitest run tests/unit/data-source-a5-adapter-conformance tests/unit/data-source-connect-failure-cleanup \
    tests/unit/data-source-connect-refusal tests/unit/data-source-credential-encryption \
    tests/unit/data-source-identifier-quoting tests/unit/data-source-k3-destination-fence \
    tests/unit/data-source-plugin-facade tests/unit/data-source-readonly
 Test Files  8 passed (8)    Tests  116 passed (116)

$ vitest run tests/unit/data-source-result-boundary tests/unit/data-source-schema-list-only \
    tests/unit/data-source-scope tests/unit/data-source-sealed-snapshot-connection \
    tests/unit/data-source-test-ephemeral tests/unit/data-source-test-error-fidelity \
    tests/unit/data-source-visibility-authority-matrix tests/unit/data-source-mysql-schema \
    tests/unit/mssql-adapter
 Test Files  9 passed (9)     Tests  163 passed (163)
```

```
$ vitest run tests/unit/plm-workbench-datasource-ownership tests/unit/outbound-sql-write-gate     tests/unit/plm-workbench-capabilities-routes tests/unit/plm-workbench-bom-multitable-routes
 Test Files  4 passed (4)     Tests  124 passed (124)
```

（第三批是仓内其它挂载 `dataSourcesRouter` / 走 `DataSourceManager` 写口的件。）

其中 `data-source-test-error-fidelity`（redactSecrets 的既有断言，含 `authorization=Bearer xyz` 必须整串消失）与 `data-source-visibility-authority-matrix`（credentials 写-only 的毒值扫描 + 权威矩阵）是这次改动最容易碰坏的两件，均绿。

类型检查：`tsc --noEmit -p packages/core-backend/tsconfig.json` → exit 0（该 tsconfig 不含 `*.test.ts`，测试件由 vitest 转译执行）。

## 4. 未在本机跑的

- `tests/integration/data-source-connection-secret-keys-realdb.test.ts`：本机无 PG，只能空跑收集（`4 skipped`，import/语法已验证），**真正执行要等 CI 真库道**（已加进 `.github/workflows/plugin-tests.yml` 的枚举，runner 会断言 `DATABASE_URL` 存在，不会静默跳过）。它验证假库验证不了的三件事：refused create 在**真表**里零落行；正例落库时 `config->'connection'` 没有 `password` 键而 `config->'credentials'->>'password'` 是 `enc:` 前缀；设计文档里的盘点 SQL（B）在实际 schema 上能跑且只出计数。
- 前端：未改 `apps/web`，未跑 web 构建/单测（`buildPayload` 早就把口令放 `credentials`，行为不变）。
- 其它包与全量 `test:unit`：按"只跑受影响 spec"的约束没跑。

## 5. 变异探针（每条守卫一张"删掉就红"的收据）

脚本：`%TEMP%/claude/.../scratchpad/mutate-5621-w3b.py`（仅在 worktree 内改文件、`finally` 里按内存原件还原、sha256 复核；不提交、不落盘留痕）。基线 `68 passed (68)`；还原后三个源文件 sha256 与探针前逐字节一致。

| 探针 | 变异内容 | 结果 | 变红的例 |
|---|---|---|---|
| M1 | 三条写路由摘掉 `refuseConnectionSecrets` | **15 failed / 53 passed** | A 组 13 例全红 + B 组 2 例（拒收没了之后 `PUT` 真的写进去了，连带污染读取面） |
| M2 | `sanitizeConfig` 退回 `...rest`（改前行为） | **2 failed / 66 passed** | `GET /:id` 不再剥离；update 审计行重新带上存量明文 |
| M3 | 词表删掉一项 `{ parts: ['password'] }` | **22 failed / 46 passed** | A 组 12 例 + B 组 3 例 + D 组 7 例（写入口/读取面/redactSecrets 三处同时塌，正是"单一定义"的证据） |
| M4 | `safeSegment` 改成恒等（键名原样回显） | **1 failed / 67 passed** | "caller-controlled KEY ... 报成 `<key>`" 一例 |
| M5 | `findSecretConfigKeyPaths` 不再递归 | **1 failed / 67 passed** | 嵌套 `connection.headers.Authorization` 一例 |
| M6 | `redactSecrets` 退回手写元组（只看 credentials） | **1 failed / 67 passed** | `GET /:id/test` 不再打码存量 `connection.password` |

M6 的第一版探针是**绿的**——因为最初的测试把秘密写成 `password=<secret>`，`key=value` 文本规则已经能兜住，值列表那条腿没被真正考到。改成把秘密嵌在连接串里（`postgres://user:<secret>@host`，pg 真实报错形状）之后 M6 才变红。这条弯路记在这里：*同一效果有两条腿时，测试必须挑只有目标腿能救的输入*。

## 6. 复现命令

```bash
cd <worktree>/packages/core-backend
../../node_modules/.bin/vitest run tests/unit/data-source-connection-secret-keys.test.ts --reporter=dot
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
# 真库道（需要 DATABASE_URL 指向已迁移的 Postgres）
../../node_modules/.bin/vitest run --config vitest.integration.config.ts \
  tests/integration/data-source-connection-secret-keys-realdb.test.ts
```
