# 宜搭第一条真实发送：现场操作步骤 S0–S4（R79）

> **用途**：登记册 R-70（owner 2026-11-04「按建议执行」）裁定了 #6315 十道发送门槛对**第一条**真实发送的处置。本手册把那一条发送的现场步骤写死：开关打开前的核对（S0）、打开开关（S1）、在界面批准并发送（S2）、读回核对（S3）、关回开关（S4）。接在 R79 发布说明所附集成线清单第 3.1 版「L4 之后」一节后面执行。
> **基线**：所有脚本路径、`path:line`、面板文字、环境变量名与错误码都在 `onprem-r79` 标签（`7f04c54c2`，即客户测试机上运行的版本）上核过。
> **谁动开关**：`INTEGRATION_YIDA_OWNER_SEND_ENABLED` **只由 owner 或现场操作员在本裁定之后于现场设置**。Claude 不设置、不建议代为设置、不远程操作这个开关。S4 把它改回 `=false`，**不删这一行**。
> **目标是测试表单（owner 2026-11-04 追加裁定「首发先用测试表单」，记入 R-70 ④）**：这一条发送的目标是客户提供或新建的宜搭**测试**应用 / 表单（生产表单的副本），**不是生产表单**；发送的行只用合成数据。测试表单的 appType / formUuid 与凭据只在现场录入，任何文档与回报都不写这些值。发往生产表单只在第一个项目切换上线时，另行由 owner 批准。
> **后果（写明）**：目标在 L4 初始化时封存；R-50 ①（每个部署一个目标）不变，所以测试表单占用 1 号槽。以后要发往生产表单，需要对 R-50 ① 另行裁定并打开 `INTEGRATION_YIDA_MULTI_TARGET_ENABLED`（生产表单作为 2 号槽，#6718），或者一条今天不存在的重新初始化路径。推荐 2 号槽路线，测试表单留作以后的演练。
> **凭据谁录入（门 5，2026-11-06 补写）**：测试应用的凭据由锚点账号的持有人（anchor owner）本人在 222 **服务器本机**的浏览器里，经 localhost 地址打开宜搭初始化页（L3 测试连接、L4 一次性初始化）亲自录入。**任何人都不把凭据交给开发者**：不经聊天、邮件、工单、PR、截图或远程桌面转交，开发者也不代为录入、不索取。文档与回报只写「已录入 / 未录入」，不写任何凭据值或标识符。
> **开关当天另批**：本裁定只为**一条测试表单发送**清掉十道门槛；S1 打开开关仍要 owner 当天单独批准（R-50）。
> **范围**：只有这一条单行 CREATE。常规使用之前，门 1、4、6、10 的代码修复必须各自作为单独批准的 PR 先合入（R-70 ①）；本手册不授权第二条发送。
> **values-free**：回报只写 True/False、毫秒数、状态类别、面板上显示的错误码；不抄授权号、草稿号、rowKey、业务键、appType/formUuid 或任何字段内容。

## 十道门在本手册里的落点（R-70）

| 门 | 处置 | 在哪一步 |
|---|---|---|
| 1 请求断开不得取消已准入的 CREATE | owner 接受，以操作纪律兜底 | S2 第 10–12 步 |
| 2 `prepared` 行的审计路径 / DBA 手册 | 由 DBA 手册关门：`runbook-yida-prepared-ledger-cancel-20261104.md` | S3 第 15 步 |
| 3 凭据已验证 | L3 得 `ok` + L4 成功 + L4 之前全库备份与 `docker\app.env` 副本在手 | S0 第 1 步 |
| 4 预算在准入之前检查 | owner 接受 | S2 第 9 步（选短行） |
| 5 密钥只经 HTTPS 或 localhost | L3/L4 由锚点账号的持有人在 222 服务器本机浏览器经 localhost 打开初始化页、亲自录入凭据完成；凭据不交给开发者 | S0 第 1 步 |
| 6 收到的 2xx 绝不丢弃 | owner 接受，以操作纪律 + 宜搭人工核对兜底；代码关门（R-71 ⑦.1，PR-A `fix/yida-send-gate1-gate6-20261104`，合入并上机后生效）：状态行到达之后的中止 / 超时 / 开关翻转不再丢弃回执，2xx 但正文不可用落台账 reason `receipt_unparsed`（仍是 `outcome_unknown`、不自动重发） | S2 第 10–12 步、S3 第 14 步 |
| 7 `ENCRYPTION_KEY` 轮换方案 | owner 接受（两项加密值在部署生命期内不变） | S0 第 1 步（备份） |
| 8 PBKDF2 实测 | 发送前在客户机上用合成字串实测 | S0 第 4 步 |
| 9 租户声明与锚点 | 锚点账号 GET 在开关打开前、后都显示已初始化 | S0 第 2 步、S2 第 8 步 |
| 10 `SHUTDOWN_TIMEOUT` 测试 / 真库零跳过 | owner 接受（CI 卫生，不影响这一条） | — |
| （R-70 ④）目标是测试表单 | owner 用自己持有的值对照，只报 True/False | S0 第 1 步、S2 第 9 步 |

## S0 开关打开前

1. **前置（缺一条就不开工）**：
   - L3 测试连接结果是 `ok`，L4 一次性初始化成功（门 3 的可验部分）。
   - L4 之前的全库备份与 `docker\app.env` 副本在手、放在一起（门 3、门 7 的恢复点；清单第 3.1 版「开工前」C 段）。
   - L3、L4 是在**服务器本机**的浏览器里经 localhost 地址打开面板完成的（门 5）。不是：停，报 owner。
   - **目标是测试表单**：L4 时录入并封存的 appType / formUuid 是与 owner 约定的那张**测试**表单，不是生产表单。由 owner 用自己持有的值对照 L4 当时的录入核对，只报 `testFormTarget=True/False`，不抄标识符。`False` 或 owner 无法确认：停，不开开关（这时 1 号槽已封存为非测试目标，报 owner 另裁）。L4 还没做：L4 必须录入测试表单的标识符与凭据。初始化之后「手动 GET」不显示 appType / formUuid，所以发送前的最终核对在 S2 第 9 步的服务端预览上再做一次。
   - **L4 草稿的键布局（R-71 ⑦.3 决策 A）**：1 号槽的 L4 草稿必须用 v2 物料模板（`docs/development/takeover-beiliao-20260821/yida-legacy-templates/material.json`）的七键布局与可空键：项目号、图号、名称、规格、材质、版本、父组件图号，其中规格（`componentSpec`）与父组件图号（`parentComponentCode`）为可空键；七个键目标对到测试副本的真实字段 id。owner 只报 `materialKeyLayout=True/False`，不抄字段 id。`False`：停，不开开关，报 owner。原因：1 号槽在 L4 时永久封存键定义，以后只收键定义完全相同的草稿；布局不对，这个槽永远收不下 v3 物料草稿。v2 物料模板与 v3 物料夹具的键定义相同，由 `plugins/plugin-integration-core/__tests__/yida-mapping-v3-parity.test.cjs` 钉住。L4 还没做：L4 必须按这个布局起草。
   - 清单第 3.1 版「L4 之后」第 1–8 条已做完：测试连接开关已改为 `INTEGRATION_YIDA_CONNECTION_TEST_ENABLED=false` 并按「重启后端的方法」重启；那段核对输出全部符合。
2. **门 9（开关打开前）**：锚点账号退出后重新登录，Ctrl+F5，在项目备料页宜搭区点「手动 GET 本地初始化状态」（`apps/web/src/components/integration/stockPreparation/StockPreparationYidaInitializationPanel.vue:6`）：应显示「本地配置已初始化；…」（同文件 `:34`），行数等于 L4 时的行数。此时**不应**出现「打开单行 CREATE 确认（服务器已开通）」按钮（`StockPreparationYidaPreviewPanel.vue:107`；它只在 GET 回复的 `sendEnabled` 位为 true 时出现：`packages/core-backend/src/routes/integration-yida-owner.ts:213-220`、`:317-326`）。
3. **L4 预检**：在部署根目录 `node scripts\ops\integration-yida-l4-preflight.mjs`，最后一行必须是 `L4_PREFLIGHT=PASS`（`scripts/ops/integration-yida-l4-preflight.mjs:589`）。**必须在 S1 之前跑**：开关这一行一旦进入运行中的后端环境，不论值是什么，脚本都按设计答 `sendSwitchInRunningBackend=True` 并 `L4_PREFLIGHT=STOP sendSwitchInRunningBackend`（`:571-572`）。
4. **门 8：PBKDF2 实测（不接受跳过）**。每次提交约有 8 次同步密钥派生，全部落在运行器 10 秒计时之内（`plugins/plugin-integration-core/lib/yida-delivery-runner.mjs:215`）。派生参数是 100,000 次、32 字节、SHA-256（`packages/core-backend/src/security/encrypted-secrets.ts:12-14`，同步调用 `:199`），耗时与密钥取值无关，所以用合成字串量。用记事本在部署根目录**以外**的临时文件夹新建 `pbkdf2-measure.cjs`：

   ```js
   const crypto = require('node:crypto')
   const times = []
   for (let i = 0; i < 5; i += 1) {
     const started = process.hrtime.bigint()
     crypto.pbkdf2Sync('synthetic-not-a-secret', 'synthetic-salt', 100000, 32, 'sha256')
     times.push(Number(process.hrtime.bigint() - started) / 1e6)
   }
   times.sort((a, b) => a - b)
   const t = Math.round(times[2])
   console.log('PBKDF2_MEDIAN_MS=' + t + ' EIGHT_TIMES_MS=' + (8 * t))
   ```

   在该文件夹里 `node pbkdf2-measure.cjs`，记下 `PBKDF2_MEDIAN_MS`（= T）。判据（R-70 ②）：8×T 加两次出网往返（换令牌、表单 POST）**明显低于 10 秒**才继续；建议 T < 300 ms。T ≥ 300 ms：停，把 T 报 owner，由 owner 定。做完删掉这个临时文件。回报只写 T 的毫秒数。
5. 再做一次全库备份（首发前的恢复点），与 `docker\app.env` 副本放在一起。

## S1 打开发送开关（owner / 现场操作员本人）

前提：owner **当天单独批准**打开开关（R-50；R-70 只清掉了十道门槛，不等于批准开开关）。没有当天的批准：不做 S1。

6. 用记事本在 `docker\app.env` 加一行 `INTEGRATION_YIDA_OWNER_SEND_ENABLED=true`：小写、不加引号、不加空格，整个文件只有这一行写这个键；按原编码（UTF-8）保存，不要用 `Out-File`、`>` 或 `Add-Content`。后端只认原文 `true`，`TRUE`、`1`、` true` 都算关（`packages/core-backend/src/integration/yida-owner-runtime.ts:184-188`；读取的是进程环境 `packages/core-backend/src/index.ts:649`）。**不要**在 Windows 系统 / 用户环境变量里设这个键。
7. 按清单第 3.1 版「重启后端的方法」重启：在部署根目录打开一个**新的** PowerShell 窗口，运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ops\attendance-onprem-start-pm2.ps1`，最后一行应是 `[attendance-onprem-start-pm2] pm2 service is ready: metasheet-backend`（`scripts/ops/attendance-onprem-start-pm2.ps1:421`）。这个脚本先找 `app.env`、再找 `docker\app.env`（`:31-46`），把文件里写着的键读进环境（`:48-73`、`:350-352`）再让 pm2 带新环境启动。不要直接 `pm2 restart`。
   接着在部署根目录（同一个新窗口）运行下面这段核对（只打印 True/False、行数、开关原文与加密体检行）：

   ```powershell
   $pm2 = if (Test-Path .\node_modules\.bin\pm2.cmd) { '.\node_modules\.bin\pm2.cmd' } else { 'pm2' }
   $apps = ((& $pm2 jlist 2>$null) | Out-String).Trim() | ConvertFrom-Json
   $app = @($apps) | Where-Object { $_.name -eq 'metasheet-backend' } | Select-Object -First 1
   function Get-ProcEnv([string]$Name) { if ($null -eq $app) { return $null }; $p = $app.pm2_env; if ($null -ne $p.$Name) { return [string]$p.$Name }; if ($null -ne $p.env -and $null -ne $p.env.$Name) { return [string]$p.env.$Name }; return $null }
   'backendInPm2=' + ($null -ne $app) + ' rootAppEnvExists=' + (Test-Path .\app.env)
   $lines = @(Select-String -Path .\docker\app.env -Pattern '^\s*INTEGRATION_YIDA_OWNER_SEND_ENABLED\s*=')
   'sendLines=' + $lines.Count
   $lines | ForEach-Object { 'fileLine=' + $_.Line.Trim() }
   'sendSwitchValue=' + (Get-ProcEnv 'INTEGRATION_YIDA_OWNER_SEND_ENABLED')
   'machineVar=' + ($null -ne [Environment]::GetEnvironmentVariable('INTEGRATION_YIDA_OWNER_SEND_ENABLED', 'Machine')) + ' userVar=' + ($null -ne [Environment]::GetEnvironmentVariable('INTEGRATION_YIDA_OWNER_SEND_ENABLED', 'User'))
   (Select-String -Path .\output\logs\metasheet-backend.out.log -Pattern 'Encrypted store probe: \d+ encrypted' | Select-Object -Last 1).Line
   ```

   应显示：`backendInPm2=True rootAppEnvExists=False`；`sendLines=1`；`fileLine=INTEGRATION_YIDA_OWNER_SEND_ENABLED=true`；`sendSwitchValue=true`；`machineVar=False userVar=False`；最后一行（这次重启时的）是 `… 0 undecryptable with the current material …`。有一条对不上：按 S4 关回，报 owner。
   清单第 3.1 版原有的 `sendSwitchInRunningBackend=` 一行与 L4 预检从这一刻起都会显示 True / STOP——它们只判「键是否存在」，这是预期，不作为阻断；以 `sendSwitchValue` 为准。

## S2 在界面批准并发送（owner 本人，锚点账号）

8. **门 9（开关打开后）**：锚点账号退出后重新登录，Ctrl+F5，「手动 GET 本地初始化状态」：仍显示「本地配置已初始化；…」、行数不变，并且出现「打开单行 CREATE 确认（服务器已开通）」按钮。没有这个按钮 = 开关没生效：停，按 S4 关回，报 owner。
9. 在同一宜搭区先完成要发送那一行的协议 v2 创建预演（面板在没有有效预演时显示「请先完成有效的协议 v2 创建预演。」），选**字段少、文本短**、只含**合成数据**的一行（门 4：快照与请求体超过 256 KiB 时会在准入之后失败；R-70 ④：不发任何真实业务数据）。点「打开单行 CREATE 确认（服务器已开通）」，在「宜搭 Owner 单次创建确认」面板（`StockPreparationYidaOwnerSendPanel.vue:3`）依次：
   - 「保存服务端草稿（不发送）」（`:7`）→ 在「选择服务端行」里选那一行 →「读取所选行服务端预览」（`:19`）；
   - 逐字核对预览里的 appType、formUuid 与字段内容（`:23-33`；两个标识符在 `:29-30`，来自服务端封存的目标）；
   - **测试表单核对（R-70 ④）**：owner 把预览里的 appType / formUuid 与自己持有的测试表单值对照，只报 `previewIsTestForm=True/False`，不抄标识符。`False`：不勾选、不批准，按 S4 关回，报 owner；
   - 勾选「我已核对目标与此行内容，知悉只尝试一次及结果未知不可重试的风险。」→「确认并申请单次授权（尚未发送）」（`:35-37`）；
   - 面板出现「服务端授权记录」：状态 `approved`、到期时间、剩余尝试数 1（`:43-45`；授权固定 15 分钟：面板请求 `ttlMs: 900000`，`:162`）。
   这几步出现任何错误码都停，按 S4 关回，报 owner（错误码是 `packages/core-backend/src/routes/integration-yida-owner.ts:29-38` 的闭集）。其中与门 9 直接相关的两个：`YIDA_OWNER_HTTP_DENIED` = 会话没有租户声明（`:85`）；`YIDA_SEND_APPROVAL_NOT_FOUND` = 当前账号或租户与目标槽登记的 owner 不符（`packages/core-backend/src/integration/yida-send-approval-service.ts:213-216`）。
10. **门 1 / 门 6 的操作纪律（代替未关的代码门）**：只开这一个标签页；从这一刻起不动上面的预演区（预演输入的任何改动都会重置面板并中止在途请求：`StockPreparationYidaOwnerSendPanel.vue:99-120`）；网络稳定、不换网络；面板发给服务器的每个请求 15 秒不回就由浏览器中止（`apps/web/src/services/integration/yidaOwner.ts:251`），所以点提交之前确认 S0 第 4 步的 T 合格。
11. 点**一次**「提交此授权一次」（`StockPreparationYidaOwnerSendPanel.vue:46`），然后 30 秒内不刷新、不关页、不离开、不点任何东西。
12. 读结果（「持久记录状态：…」，`:51-53`；出现错误码时先点「手动刷新持久记录（只读）」`:47` 读真实状态）：
    - `acknowledged`：收到宜搭协议应答。面板同时写「仅收到协议应答，尚未核验业务创建成功。」——仍要做 S3。
    - `outcome_unknown`、`dispatching` 或面板显示 `state_unconfirmed`：结果不明，宜搭里**可能已经有**这条记录（门 6：在 PR-A 关门之前，已收到的 2xx 也可能被折成这一类；关门之后，已收到且正文可用的 2xx 一律落 `acknowledged`，台账 reason 为 `receipt_unparsed` 时表示服务器答过 2xx 但正文不可用——`outcome_unknown` 的任何 reason 都到宜搭人工核对）。系统永不自动重发。
    - `prepared`：在认领之前被取消，什么都没发。按 DBA 手册（S3 第 15 步）处理，不要重试。
    - 错误码：`YIDA_OWNER_RUNTIME_DISABLED` = 开关没生效；`YIDA_SEND_APPROVAL_EXPIRED` = 授权过了 15 分钟；`YIDA_OWNER_CANCELLED` 或 `YIDA_OWNER_RUNTIME_CANCELLED` = 请求被中止（门 1），以「手动刷新持久记录（只读）」读到的状态为准；`YIDA_OWNER_HTTP_DENIED` 会让面板失效并清掉授权显示（`apps/web/src/services/integration/yidaOwner.ts:289`）。
    无论什么结果，都**不要**再点提交，也不要对同一行再批准（新建占位永久保留，R-50 ⑥）。

## S3 读回核对

13. 点「手动刷新持久记录（只读）」，状态应与第 12 步一致。
14. owner 在宜搭界面按业务键人工核对：恰有一条新记录 = 首发成功；没有 = 首发未成功（不重试）；多于一条 = 停，报 owner。只记「有 / 无 / 多」。
15. 状态停在 `prepared`：授权到期 5 分钟之后，按 `runbook-yida-prepared-ledger-cancel-20261104.md` 由 owner 逐次批准、DBA 收口为 `not_sent`（门 2）。占位不释放、不重发。
16. 回报：面板状态类别 + 宜搭核对结果（有 / 无 / 多）+ S0 第 4 步的 T + `testFormTarget` / `previewIsTestForm` 两个 True/False；不抄任何编号或标识符。

## S4 关回开关（owner / 现场操作员本人）

17. 用记事本把那一行改为 `INTEGRATION_YIDA_OWNER_SEND_ENABLED=false`，**不要删掉这一行**：包内启动脚本只把文件里写着的键读进环境（`scripts/ops/attendance-onprem-start-pm2.ps1:48-73`），删掉这一行时，进程里原来的 `true` 可能保留下来（与清单第 3.1 版「L4 之后」第 1 条对测试连接开关的要求相同）。
18. 按第 7 步重启，并重跑第 7 步那段核对：`sendLines=1`、`fileLine=INTEGRATION_YIDA_OWNER_SEND_ENABLED=false`、`sendSwitchValue=false`、`machineVar=False userVar=False`、最后一行仍是 `0 undecryptable`。清单第 3.1 版的 `sendSwitchInRunningBackend=` 一行与 L4 预检此后仍显示 True / STOP（键还在），以 `sendSwitchValue=false` 为准。
19. 锚点账号退出后重新登录，Ctrl+F5，「手动 GET 本地初始化状态」：仍显示「本地配置已初始化；…」、行数不变，「打开单行 CREATE 确认（服务器已开通）」按钮消失（`sendEnabled` 位回 false：`packages/core-backend/src/integration/yida-owner-runtime.ts:366-370`）。有一条对不上：停，报 owner。
20. 之后每次重启后都可以用第 7 步那段的最后一行做加密体检：`undecryptable` 前面的数字必须是 0。

## 停止条件汇总

- S0 第 1 步任何一条前置不满足（含 `testFormTarget=False`、`materialKeyLayout=False`）、L4 预检不是 `PASS`、T ≥ 300 ms（owner 未另定）、owner 当天没有单独批准开开关 → 不开开关。
- S2 第 9 步 `previewIsTestForm=False` → 不批准，按 S4 关回，报 owner。
- 第 7 步核对有一条对不上、第 8 步没有发送入口、第 9 步出现任何错误码（尤其 `YIDA_OWNER_HTTP_DENIED` / `YIDA_SEND_APPROVAL_NOT_FOUND`）→ 按 S4 关回，报 owner。
- 提交之后无论结果如何 → 不再提交、不再批准同一行；按 S3 核对、按 S4 关回。
- 宜搭里出现多于一条 → 停，报 owner。

## 附：本手册怎么核的

- 脚本路径、面板文字、错误码、环境变量名与 `path:line` 都在 `onprem-r79`（`7f04c54c2`）的文件内容上逐条读过；`.vue` 与 `.ps1` 的行号人工对过。
- 第 7 步那段 PowerShell 在 Windows PowerShell 5.1 上对合成部署目录实跑过（合成 `docker\app.env`、返回合成 JSON 的 pm2 桩、合成日志行），输出与上文「应显示」逐行一致。
- 第 4 步的 PBKDF2 脚本在开发机上实跑过（只打印毫秒数）；客户机上的 T 以现场为准。
- 没有在客户机上执行任何一步，没有设置任何开关，没有向钉钉或宜搭发出任何请求。
