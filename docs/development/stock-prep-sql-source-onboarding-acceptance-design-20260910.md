# SQL 源接入验收脚本 · 返修设计(2026-09-10,PR #5576 第二轮)

对象:`scripts/ops/stock-preparation-sql-source-onboarding-acceptance.ps1`(Windows PowerShell 5.1,values-free)。
第一轮评审提了四项,两条 P1 两条 P2。下面是每条的根因与改法。

## P1-1 连接失败仍判 PASS

根因在服务端而不是脚本:`plugins/plugin-integration-core/lib/http-routes.cjs` 的
`externalSystemsTest` 把适配器抛出的异常 catch 住,转成 `testConnectionErrorResult`
(`{ ok:false, code, message }`)后**照样走 `sendOk` 答 200**;紧接着
`persistExternalSystemTestResult` 会把 `resolveTestedStatus` 算出的 `status='error'`、
`resolveTestError` 算出的非空 `lastError`,连同一个**新鲜的 `lastTestedAt`** 一起存库。
所以源库完全连不上时,"HTTP 200"和"lastTestedAt 有值"这两件事同时成立——老口径断言的
正好就是这两件事。

改法:STEP3 拆成两条腿,各自独立判定。

- leg1 `Get-ConnectionTestCallVerdict`:HTTP 必须 200,且 `data.ok` 必须是**真布尔 true**。
  字段缺失、`"true"` 字符串、`1` 一律 FAIL(`TEST_RESULT_NOT_OK`)。
- leg2 `Get-ConnectionReadbackVerdict`:回读 `GET /api/integration/external-systems/:id`,
  要求 `lastTestedAt` 有值、`status != 'error'`、`lastError` 为空。
  `status='inactive'` **不算失败**——`resolveTestedStatus` 对故意停用的系统就是这样返回的。

leg1 失败时 leg2 照跑(GET 无副作用),因为 `status`/`lastError` 正是"这是哪一类失败"的证据。
`lastError` 只读来断言为空,永不回显,失败只报固定分类码(有测试钉死它不出现在任何打印行)。

## P1-2 "新源→一线 dry-run"没连成一条链

根因:STEP4 源预检和 STEP6 dry-run 走的都是**部署里那张备料表动作当前绑定的源**,
和本次新建的临时源没有任何关系;脚本却把它们的绿写成了整条链通过。同时 STEP4 断言的
`data.ready` 这个字段**在该路由上从来不存在**(真实返回是
`{ ok: blockers.length===0, verdict: 'go'|'no-go' }`,见
`stock-preparation-source-preflight.cjs`),读它恒为 `$null`,等于只剩 HTTP 200 一道门。

改法(明确不采用"脚本改生产绑定来凑闭环"):新增两条**只读**腿——
`GET /api/integration/stock-preparation/source-binding` 取 `effectiveExternalSystemId`
(该路由自己的定义就是"下一次请求这个动作会读谁"),再读该外接系统的 `connectionId`,
与 STEP1 建的数据源 id 比对。`Get-ActionSourceChainVerdict` 只有在**证明相等**时才给
`CLOSED_LOOP`,其余一律降级 `ENV_PROBE` 并带原因码(`BOUND_TO_OTHER_SOURCE`、
`BINDING_READBACK_FORBIDDEN`(该 GET 是 admin 档,401/403 记 WARN)、`ACTION_ID_MISMATCH`、
`NO_SOURCE_BOUND`、`BOUND_SYSTEM_UNREADABLE` 等)。

非闭环时步骤描述、汇总行 `NOT A CLOSED LOOP` 和 JSON 报告(`chainMode` / `closedLoop` /
`chainCode` / `boundSourceDigest`)都明写"测的是既有来源";既有源只用 digest
(id 的 sha256 前 12 位)指代,能和已知 id 对上又不把 id 写进报告。总结论三选一:
`CLOSED_LOOP_PASS` / `ENV_PROBE_PASS` / `FAILED`——非闭环的运行**写不出**"闭环通过"。
预检本身改读真实字段:`data.ok` 为真布尔且 `data.verdict == 'go'` 才 PASS,
`verdict: 'no-go'` 判 FAIL,只有 `ready` 的 body 判 `PREFLIGHT_FIELDS_ABSENT`。

## P2-1 脚本没进交付包

`scripts/ops/multitable-onprem-package-build.sh` 的 `REQUIRED_PATHS` 只列了两个老验收脚本,
客户拿到的包里根本没有这个验收器。补进清单,并在
`multitable-onprem-package-verify.sh` 的 `verify_stock_preparation_mvp_contract` 里加一组
存在性 + 五个关键字校验:`ISOLATION_BREACH`、`[switch]$DryRun`、self-test schema、
`CLOSED_LOOP_PASS`、`Read-AcceptanceCredential`。

## P2-2 凭据被 `.Trim()` 改写

SQL 登录名/密码与 bearer token 共用一个读取函数,`.Trim()` 会把合法的首尾空格吃掉,
表现为"密码明明对却认证失败"。拆成两个:

- `Read-AcceptanceToken` —— 首尾去空白(token 不可能含空白,只会吃掉编辑器多加的换行)。
- `Read-AcceptanceCredential` —— 按字节原样,只剥**一个**结尾 `CRLF` 或 `LF`;
  首尾空格保留;第二个换行故意留着,让坏文件大声失败而不是被悄悄"修好"。

底层统一走 `[System.IO.File]::ReadAllText(path, UTF8)`:PS 5.1 的 `Get-Content -Raw`
对无 BOM 文件按 ANSI 代码页解码,中文环境会把 UTF-8 密码读坏。

## 测试策略:从"静态"升级到"真跑分类器"

第一轮的契约测试是纯静态文本检查——能证明守卫**写了**,不能证明它**判得对**;
评审正是用内存替身证伪的。因此给脚本加了 `-SelfTest`:在真 PowerShell 里把四个纯分类器
和两个读取函数跑一遍固定合成载荷/真实夹具文件,打一份 values-free JSON。两条纪律:

1. **脚本不给自己判卷**——self-test 只输出"分类器判了什么",期望值全写在 `.test.mjs` 里。
2. **结构上够不着网络**——`if ($SelfTest)` 块位于 `function Invoke-Api` **之前**;
   PowerShell 执行到定义处才绑定函数名,所以它调不到(另有测试钉住这个先后顺序)。

读取函数的证明只报**长度 / 首尾空格数 / 是否仍以换行结尾**,不需要把值打出来。
找不到 PowerShell 时判红而不是 skip(本仓有过 skip 式假绿的教训)。
