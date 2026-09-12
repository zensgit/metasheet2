# 数据源 connection 口令字段：验证记录

- 配套设计：`docs/development/data-source-connection-secret-keys-design-20260912.md`
- Issue #5621 / 分支 `fix/data-source-connection-password-plaintext` / worktree `metasheet-wt-w3b`
- 执行环境：Windows 11 + Node 20 + pnpm 9.15.9 + vitest 1.6.1；**本机无 Postgres**（`127.0.0.1:5432` ECONNREFUSED，`DATABASE_URL` 未设），真库件只写成 CI 真库道形状、本机未执行（见 §4）。
- 依赖安装：`pnpm install --frozen-lockfile --prefer-offline --filter @metasheet/core-backend...`（一次，46.6s，exit 0；用 filter 是为了省磁盘，本机 C: 仅余 17G）。

## 1. 新增/改动的件

| 件 | 性质 |
|---|---|
| `packages/core-backend/src/data-adapters/data-source-secret-keys.ts` | 新增：单一定义（词表 + 判据 + 拒收路径扫描 + 剥离 + 值收集 + 文本正则 + 错误码/文案） |
| `packages/core-backend/src/routes/data-sources.ts` | 改：import（:13、:35-40）、`sanitizeConfig` 剥离（:338-344）、拒收判据/守卫（:346-396）、三条写路由接线（:532/:618/:684） |
| `packages/core-backend/src/data-adapters/BaseAdapter.ts` | 改：import（:3）、`redactSecrets` 改用共享词表（:502-517） |
| `packages/core-backend/tests/unit/data-source-connection-secret-keys.test.ts` | 新增：68 例（终审返修 → 76；后续单 F03 → 123，见 §9） |
| `packages/core-backend/tests/integration/data-source-connection-secret-keys-realdb.test.ts` | 新增：4 例（真库道，本机 skip） |
| `.github/workflows/data-source-connection-secret-keys-realdb.yml` | 新增：**独立**真库道（`plugin-tests.yml` 是 s6a pin 输入，本刀逐字未动） |
| `packages/core-backend/vitest.config.ts` | 改：把真库件排除出无库默认配置（与上一行同提交，两点接线） |

`DataSourceManager.ts` **零改动**（避让在飞的 #5593）。未动 pin、迁移、`errorCodeLabels.ts`。

## 2. 单元测试（本机执行）

```
$ node_modules/.bin/vitest run tests/unit/data-source-connection-secret-keys.test.ts --reporter=dot
 ✓ tests/unit/data-source-connection-secret-keys.test.ts  (76 tests) 117ms
 Test Files  1 passed (1)
      Tests  76 passed (76)
```

（68 → 76 是终审返修加的 8 例：A 组 2 例 `passThroughMode` / `pass_through` 命中→400，D 组 4 例判据钉现状，D 组 2 例值列表按长度降序。见 §8。）

覆盖的四组：

- **A 写入拒收**：`POST /api/data-sources` 带 `connection.password` → 400 + `DATA_SOURCE_CONNECTION_SECRET_REJECTED`，**零落库**（假库 upsert 计数不变 + 读回 404）；8 种键形（`password / dbPassword / API_KEY / accessToken / clientSecret / pass / pwd / sslPassphrase`）逐一拒收；嵌套 `connection.headers.Authorization` 同码拒收；非标识符键名报成 `connection.<key>` 且不回显 `hunter2`；`PUT /:id` 拒收且存量行未被改名/改 host；`POST /api/data-sources/test` 拒收且 `dialAttempts === 0`（拒收发生在拨号之前）；匿名仍先得 401（顺序没被守卫抢跑）。
- **A 收窄对照**：`host/port/database/encrypt/trustServerCertificate/strictOffsetOrdering/passthroughMode` 一并提交 → 201 且原样回显（证明守卫不是一刀切）。
- **B 读取剥离**：直接插库造的存量行（`connection.password` + `connection.headers.Authorization`）→ `GET /:id` 只剩非秘密键、`hasCredentials:true` 仍在；`GET /:id/test` 的失败原因里秘密被打成 `***` 且保留 `ECONNREFUSED`；一次无关的 `PUT` 之后 **audit 行**（`before`/`after`）无秘密，**而库里那行仍带明文**（正向钉住"存储不动"）。
- **C 正例**：口令放 `credentials` → 201 + `hasCredentials:true`，落库是 `enc:` 前缀，响应不含口令；`POST /test` 正例照常 success。
- **D 单一定义**：`isSecretConfigKey` 命中表 22 项 / 不命中表 22 项 / 切词过度包含钉现状 4 项（`passThroughMode`、`pass_through`、`passThrough`、`byPass` 命中）；`stripSecretConfigKeys` 逐层去键；`collectSecretConfigValues` 同时取 credentials 与 connection（含嵌套）；生成的文本正则是旧手写正则的**超集**，且 `authorization=Bearer xyz` 仍交给专用规则处理。

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

- `tests/integration/data-source-connection-secret-keys-realdb.test.ts`：本机无 PG，只能空跑收集（import/语法已验证），**真正执行要等 CI 真库道**（独立工作流 `.github/workflows/data-source-connection-secret-keys-realdb.yml`，该道以 `EXPECT_DB=1` 武装 spec 顶部的哨兵：`itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL …')` 在缺 `DATABASE_URL` 时直接**红**，不会静默跳过；形状抄自 `tests/integration/approval-can-decide-current-node.db.test.ts:50-53`）。它验证假库验证不了的三件事：refused create 在**真表**里零落行；正例落库时 `config->'connection'` 没有 `password` 键而 `config->'credentials'->>'password'` 是 `enc:` 前缀；设计文档里的盘点 SQL（B）在实际 schema 上能跑且只出计数。
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

## 8. 终审返修（对抗复核 wf_16e0b6e5-bca 的最小修复清单）

1. **真库工作流外壳重写**（`.github/workflows/data-source-connection-secret-keys-realdb.yml`）：它是从 multitable schema-write 门克隆来的，`name`、头注释、两组 `paths`、证据摘要全指向不相干（甚至不存在）的文件。现在 `name` = `Data-source connection secret-keys gate (real DB)`，头注释按本件四个用例重写，两组 `paths` 换成本 PR 真实改动面（`data-source-secret-keys.ts` / `BaseAdapter.ts` / `DataSourceManager.ts` / `routes/data-sources.ts` / spec / `vitest.config.ts` / yml 自身，**7 条，逐条 `os.path.exists` 核过**），`suites=` / `scope=` 改成本件口径。YAML 用 `python -c "yaml.safe_load(...)"` 解析通过，两组 paths 逐字相等。
2. **`EXPECT_DB` 哨兵**（`tests/integration/data-source-connection-secret-keys-realdb.test.ts:34-37`）：形状抄自 `tests/integration/approval-can-decide-current-node.db.test.ts:50-53`。收据：
   - 有哨兵 + `EXPECT_DB=1` + 无 `DATABASE_URL` → `Tests 1 failed | 4 skipped (5)`，exit 1（**红**）；
   - 同条件把哨兵三行删掉（内存变异 M9，原件 sha256 还原核对）→ `Test Files 1 skipped (1)`，exit 0（**假绿**，正是终审说的旧行为）；
   - 无 `EXPECT_DB` + 无 `DATABASE_URL`（本机/别的道）→ `5 skipped`，exit 0，不误红。
   spec 头 `:14-18` 与本文件 §1 表、§4 的 `plugin-tests.yml` 说法一并改成独立工作流名（`plugin-tests.yml` 本 PR 逐字未动）。
3. **收窄被证伪的绝对句**：`data-source-secret-keys.ts` 模块头、`routes/data-sources.ts` 的 `#5621 WRITE FAIL-CLOSED` 注释、设计文档 §1/§2/§5 —— 一律限定为「**API 可写的扁平 `connection`（Zod 只收标量）里没有适配器按键名读秘密**」，并点名三个反例：URL userinfo 值（`HTTPAdapter.ts:138` → `axios@1.13.2 lib/adapters/http.js:574-578`，**真的当 Basic 认证**）、`connection.headers.Authorization`（PLMAdapter 运行时回写）、进程内写入口。`byPass`/`passThrough`/`pass_through` **实测命中**，设计文档原来那句「`passthrough`、`bypass` 不命中」只对不切词拼写成立，已改并由单测两向钉住。深合并注释补了「合并基底可能含进程内注入的秘密形状键」。
4. **值替换按长度降序**（`data-source-secret-keys.ts:234`）：`collectSecretConfigValues` 返回前 `values.sort((a,b)=>b.length-a.length)`；`BaseAdapter.ts:504-511` 与模块 `:81-86` 的「only ever widens」两句绝对话改为「值集是超集 + 按长度降序替换」。

### 本轮变异收据（都是内存变异，`finally` 还原 + sha256 复核，不落盘）

| 探针 | 变异 | 结果 |
|---|---|---|
| M7 | 删掉 `collectSecretConfigValues` 的 `values.sort(...)` | **2 failed / 74 passed**：`collectSecretConfigValues returns LONGEST-FIRST`、`redactSecrets consumes the WHOLE longer secret`（后者收到 `auth failed, tried ***z`） |
| M8 | 把 `pass` 的整词规则放宽成「等于最后一个 token」（终审明确不采纳的那个提议） | **5 failed**：A 组 2 例（`passThroughMode` / `pass_through` 不再 400）+ D 组 3 例判据钉 |
| M9 | 删掉真库件的 `EXPECT_DB` 哨兵三行 | 同条件从 exit 1（1 failed）变回 exit 0（1 skipped），即假绿复现 |

### 本轮复跑

```
$ vitest run tests/unit/data-source-connection-secret-keys.test.ts        -> 76 passed (76)
$ vitest run tests/unit/data-source-test-error-fidelity \
              tests/unit/data-source-visibility-authority-matrix          -> 41 passed (41)
$ vitest run tests/unit/plm-workbench-datasource-ownership tests/unit/outbound-sql-write-gate \
              tests/unit/plm-workbench-capabilities-routes \
              tests/unit/plm-workbench-bom-multitable-routes              -> 124 passed (124)
$ tsc --noEmit -p packages/core-backend/tsconfig.json                     -> exit 0
```

真库件本机仍无 PG，只跑了哨兵/skip 两种收集路径（见上），四个真库用例仍要等 CI 真库道。

## 9. 后续单 F03 + F10（叠在本 PR 上）

- 分支 `fix/data-source-secret-keys-vocab-nfkc`，worktree `metasheet-wt-w4e`，基于本 PR 头 `691a20e83`。
- 执行环境同上（Windows 11 + Node 20 + pnpm + vitest 1.6.1，**本机仍无 Postgres**）。依赖安装：`pnpm install --frozen-lockfile`（worktree 内一次，exit 0）。
- 改动件：`packages/core-backend/src/data-adapters/data-source-secret-keys.ts`（词表 + `GLUED_KEY_QUALIFIERS` + `foldKey` + `tokenMatchesWord` + 文本正则）、`packages/core-backend/tests/unit/data-source-connection-secret-keys.test.ts`（76 → 123 例）、本文件、设计文档。
  **未动**：`routes/data-sources.ts`、`BaseAdapter.ts`、`DataSourceManager.ts`、真库件、工作流、pin（`s6a-package-provenance-pins.json` 不含本次任何路径，逐项核过）。三条腿（拒收 / 剥离 / redactSecrets）是**通过共享判据自动获得新词的**，所以这三个文件一行不改就同步生效——这正是 #5621「单一定义」的兑现。

### 9.1 F03 词表匹配规则（实读后的口径）

| 规则 | 实现 | 例 |
|---|---|---|
| NFKC 折叠 | `foldKey`（`normalize('NFKC')`），`keyTokens` 与 `normalizeKey` 都先过它 | `ｐａｓｓｗｏｒｄ` → `password` |
| 子串匹配 | `normalizeKey` = NFKC + 小写 + 去非字母数字，再 `includes(word)` | `dbPassword`、`API_KEY`、`sslPassphrase`、`devicePasscode` |
| 整词匹配（`wholeTokenOnly`：`pass` / `pw`） | `keyTokens` 切 camel/下划线后，token **等于**该词 | `pass`、`db_pass`、`dbPass`、`pw`、`db_pw`、`userPw` |
| 限定词前缀（F03 新增） | token **以该词结尾**且剩下的前缀在 `GLUED_KEY_QUALIFIERS` 里 | `dbpass`、`pgpass`、`sqlpass`、`userpass`、`adminpass`、`rootpw` |
| 不命中 | 既不是整词、前缀也不在白名单 | `bypass`、`compass`、`surpass`、`trespass`、`overpass`、`encompass`、`passive`、`passiveMode`、`passenger`、`passthrough` |

### 9.2 修前红（原样）

用内存变异 **P0** 把 `data-source-secret-keys.ts` 换回 `HEAD`（= 本 PR 头 `691a20e83` 的版本）、测试件保持新版，跑同一 spec：

```
Test Files  1 failed (1)
Tests  28 failed | 95 passed (123)
```

28 条失败逐条（vitest `--reporter=dot` 的 Failed Tests 列表，测试名原样；`→` 行为断言原文）：

```
FAIL  #5621 A > POST create refuses connection.dbpass (qualifier glued with no separator)
FAIL  #5621 A > POST create refuses connection.db_pw (pw token)
FAIL  #5621 A > POST create refuses connection.pswd
FAIL  #5621 A > POST create refuses connection.passcode
FAIL  #5621 A > POST create refuses connection.ｐａｓｓｗｏｒｄ (fullwidth, folded by NFKC)
FAIL  #5621 A > POST create refuses connection.Ｔｏｋｅｎ (fullwidth, folded by NFKC)
FAIL  #5621 A > F03 a FULLWIDTH secret key is refused and reported as <key> (the raw key is never echoed)
FAIL  #5621 D > F03 isSecretConfigKey("dbpass") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("pgpass") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("sqlpass") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("userpass") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("adminpass") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("pw") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("db_pw") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("dbPw") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("userPw") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("rootpw") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("pswd") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("dbPswd") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("passcode") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("devicePasscode") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("ｐａｓｓｗｏｒｄ") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("ｐｗｄ") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("ｓｅｃｒｅｔ") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("Ｔｏｋｅｎ") === true (was false before the widening)
FAIL  #5621 D > F03 isSecretConfigKey("ＡＰＩ＿ＫＥＹ") === true (was false before the widening)
FAIL  #5621 D > F03 the SAME new words reach all three legs: path scan, strip, and the write entry
FAIL  #5621 D > F03 the text pattern gained the same words and kept the same narrowness
```

断言原文（节选，`→` 行）：

```
→ expected 201 to be 400 // Object.is equality        （第一条 dbpass：改前直接 201 建成了）
→ expected 409 to be 400 // Object.is equality        （后续同 id 的变体撞上前一条建成的行）
→ expected false to be true // Object.is equality     （判据表 19 条）
→ expected [] to deeply equal [ 'connection.dbpass', …(2) ]   （findSecretConfigKeyPaths 一条都没扫到）
→ expected 'boom dbpass=hunter2' not to contain 'hunter2'     （文本腿没打码）
```

第一条 `expected 201 to be 400` 本身就是这张单的全部理由：**改前把 `connection.dbpass` 直接建成了数据源**，明文落库并会被 `GET /:id` 回显。

一条**不在**这张红表里的用例要说明：`F03 VALUES ARE NEVER NFKC-FOLDED` 改前改后都绿——它钉的是"不许把值也折"，是防止将来有人把 `foldKey` 误用到值面的护栏，不是修前红。

### 9.3 零误伤核查

命中面之外逐个实读、逐个断言 `false`：

- **17 个合法 `connection` 键**（现役五个注册适配器 + sealed-snapshot 门实读）：`host` `server` `port` `database` `ssl`（`PostgresAdapter.ts` / `MySQLAdapter.ts` / `MSSQLAdapter.ts:105-107,:193`）、`encrypt` `trustServerCertificate` `legacyTls` `tlsMinVersion` `tlsCiphers` `connectionTimeoutMs` `requestTimeoutMs` `strictOffsetOrdering`（`MSSQLAdapter.ts:142-149,:202-208,:403`）、`baseURL` `url` `headers`（`HTTPAdapter.ts:138-140`、`PLMAdapter.ts`）、`instanceName`（`data-source-plugin-facade.ts:680-688` `SEALED_SQL_CONNECTION_FIELDS`）。**全部 false**（`headers` 作为容器键本身不命中，它底下的 `Authorization` 才命中）。
- 其中 16 个标量键**在路由层**一次性发出去：新增用例 `F03 NARROWNESS: all 16 scalar connection keys the registered adapters read still create 201` → 201 且原样回显（`headers` 是对象，过不了 `ConnectionConfigSchema` 的标量记录，只在判据表里核）。
- **英文近邻**（子串规则会误伤、限定词规则不会）：`bypass` `compass` `compassPoint` `surpass` `trespass` `overpass` `encompass` `passive` `passiveMode` `passenger` → 全部 false。
- **`pw` 的近邻**：`httpwait` `httpWait` `tcpWindowSize` `sftpWorkdir` `ftpWorkingDirectory` → 全部 false（这正是 `pw` 必须走整词/限定词、不能走子串的原因：`httpwait` 归一化后含 `pw`）。
- **现状不变**：`passThroughMode` / `pass_through` / `passThrough` / `byPass` 仍 true（#5648 已钉的过度包含），`passthrough` / `bypass` 仍 false。新增 `passHash` / `passValue` **正向钉 true**，把「等于最后一个 token」那个被终审否掉的放宽堵死在 F03 这道门上。
- **唯一一个"已经命中"的非典型键**：`sftpwd` 在 F03 **之前就是 true**（归一化 `sftpwd` 含既有词 `pwd` 的子串），不是本次引入，也不是任何适配器读的键——记在这里免得后人以为是 F03 干的。

### 9.4 三处同源

新词在三条腿上同时生效，由 `F03 the SAME new words reach all three legs` 一例三段断言钉住：`findSecretConfigKeyPaths` 扫出 `connection.dbpass` / `connection.headers.pswd` / `connection.headers.<key>`（全角键不是标识符形状 → 报 `<key>`，不回显原键）；`stripSecretConfigKeys` 逐层删掉 `dbpass` / 全角 `ｐａｓｓｗｏｒｄ` / `headers.passcode` 而保留 `host` / `passive` / `content-type`；`collectSecretConfigValues` 取到新词下的值喂给 `redactSecrets`。路由腿另由 A 组 6 条 `it.each` + 全角专例覆盖（真走 `POST /api/data-sources`，`persisted` 计数不变）。

### 9.5 本轮测试

```
$ vitest run tests/unit/data-source-connection-secret-keys.test.ts    -> 123 passed (123)   （改前 76）
$ vitest run tests/unit/data-source-a5-adapter-conformance tests/unit/data-source-connect-failure-cleanup \
    tests/unit/data-source-connect-refusal tests/unit/data-source-credential-encryption \
    tests/unit/data-source-identifier-quoting tests/unit/data-source-k3-destination-fence \
    tests/unit/data-source-plugin-facade tests/unit/data-source-readonly
                                                                      -> 8 files / 116 passed
$ vitest run tests/unit/data-source-result-boundary tests/unit/data-source-schema-list-only \
    tests/unit/data-source-scope tests/unit/data-source-sealed-snapshot-connection \
    tests/unit/data-source-test-ephemeral tests/unit/data-source-test-error-fidelity \
    tests/unit/data-source-visibility-authority-matrix tests/unit/data-source-mysql-schema \
    tests/unit/mssql-adapter                                          -> 10 files / 167 passed
$ vitest run tests/unit/plm-workbench-datasource-ownership tests/unit/outbound-sql-write-gate \
    tests/unit/plm-workbench-capabilities-routes \
    tests/unit/plm-workbench-bom-multitable-routes                    -> 4 files / 124 passed
$ tsc --noEmit -p packages/core-backend/tsconfig.json                 -> exit 0
```

`data-source-test-error-fidelity`（`redactSecrets` 的既有断言，含 `authorization=Bearer xyz` 整串消失）与 `data-source-test-ephemeral` 是仓内另外两个碰 `redactSecrets` 的件（全仓 grep 过：只有这两个 + 本件），都在上面第二批里，绿。

### 9.6 变异（内存变异，`finally` 还原 + sha256 复核，不落盘）

脚本 `%TEMP%/claude/.../scratchpad/wt-w4e/w4e-mutate.py`；基线 `123 passed`，还原后源文件 sha256 与探针前逐字节一致（`match=True`）。

| 探针 | 变异 | 结果 | 变红的例 |
|---|---|---|---|
| P0 | 源文件整体换回 `HEAD`（F03 之前） | **28 failed / 95 passed** | 见 §9.2 全表 |
| M1 | 删掉 NFKC（`foldKey` 改成恒等 `return key`） | **9 failed / 114 passed** | 5 条全角判据（`ｐａｓｓｗｏｒｄ`/`ｐｗｄ`/`ｓｅｃｒｅｔ`/`Ｔｏｋｅｎ`/`ＡＰＩ＿ＫＥＹ`）+ 2 条全角路由拒收 + 全角专例 + 三腿例少一条路径 |
| M2 | 词表删掉三条新词（`pswd` / `passcode` / `pw`） | **16 failed / 107 passed** | 判据 9 条（`pw`/`db_pw`/`dbPw`/`userPw`/`rootpw`/`pswd`/`dbPswd`/`passcode`/`devicePasscode`；`ｐｗｄ` 仍绿，它靠的是既有词 `pwd`）+ 路由 3 条 + 连带 2 条 + 三腿例 + 文本腿 `boom pw=hunter2` |
| M3 | 删掉限定词前缀规则（`tokenMatchesWord` 退回严格相等） | **13 failed / 110 passed** | 判据 6 条（`dbpass`/`pgpass`/`sqlpass`/`userpass`/`adminpass`/`rootpw`）+ `dbpass` 路由拒收 + 连带 5 条 + 三腿例 |

"连带 N 条"是 `expected true to be false`，即 `expect(persisted.has('dscs-refuse-variant')).toBe(false)`：A 组那张 `it.each` 表**共用一个 id**，一旦前面某个变体被放行真的落了库，后面本来仍被拒收的变体就在这句上红。换句话说这几条不是"该变体失效"，而是"**前一个变体真的写进了库**"——正是这道门要挡的事。这个共用 id 是 #5648 原件的形状，本次没动；代价是变异归因要多看一眼，好处是它把"落库"这件事跨用例也钉住了。

### 9.7 F10：SQL 一条都没实跑

设计文档 §5 新增的列形状探针、B2、B3、迁移 3b 以及形状 B 的两条 UPDATE，**本机全部未执行**（无 Postgres，`DATABASE_URL` 未设），语法按 PG 16 文档写。已经做到的核对只有三条，不要读成"验证过"：

1. **列形状二选一是实读出来的**：`src/db/migrations/20251206000001_create_data_sources_table.ts:30` 建 `config jsonb`，`migrations/040_data_sources.sql:12` 建 `connection JSONB`（两份 DDL 都带 `IF NOT EXISTS`/`checkTableExists` 守卫，谁先跑谁生效）；`db/types.ts:895` 与全部应用代码按 `config` 走。所以文档给了两套并要求上机前先跑 `information_schema` 探针。
2. **B 未改一个字节**：真库件 `tests/integration/data-source-connection-secret-keys-realdb.test.ts:160-169` 里那段与文档 §5 的 B **仍逐字相同**（本次没碰真库件），CI 真库道的那条断言不受影响；代价是 B 的正则停在 #5648 版，文档已改成"盘点以 B2 为准，B 只作活证据"。
3. **没有采用 `jsonb_path_query('$.**.keyvalue()')`**：`.**` 配 `.keyvalue()` 在 lax 模式下对非对象节点的行为无法本机证实，改用语义确定的 `WITH RECURSIVE` + `jsonb_typeof` 守卫。

还留着的 SQL 侧差异（都是漏报，写进了 §5「已知差异」）：SQL 不切 camel 词（`passThroughMode` / `passHash` 盘不到）、B3 不下钻数组、SQL 侧**没有做 NFKC**（全角键盘不到，PG 侧要补得用 `normalize(k, NFKC)`，同样未验证）。
