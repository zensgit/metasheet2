# SQL 源接入验收脚本 · 返修验证记录(2026-09-10,PR #5576 第二轮)

设计见同目录 `stock-prep-sql-source-onboarding-acceptance-design-20260910.md`。
本机:Windows 11,Windows PowerShell 5.1.26100.9168 + PowerShell 7.6.6,node --test。
分支 `ops/sql-source-onboarding-acceptance`,已变基到 `origin/main@1216c0539`。

## 一、命令与退出码

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `node --test --test-reporter=tap scripts/ops/__tests__/*.test.mjs` | `# tests 79 / # pass 79 / # fail 0` | 0 |
| 2 | `node --test --test-reporter=tap scripts/ops/__tests__/stock-preparation-sql-source-onboarding-acceptance-contract.test.mjs` | `# tests 31 / # pass 31 / # fail 0`(返修前 14 项) | 0 |
| 3 | `node --test --test-reporter=tap scripts/ops/multitable-onprem-package-no-node-modules.test.mjs` | `# tests 14 / # pass 13 / # fail 1` | 1 |
| 4 | `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | `tests 1 / pass 1 / fail 0` | 0 |
| 5 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\stock-preparation-sql-source-onboarding-acceptance.ps1 -SelfTest -SelfTestFixtureDir <tmp>` | 22 条分类器判定 + 5 条读取结果 JSON | 0 |
| 6 | `pwsh -NoProfile -File ... -SelfTest -SelfTestFixtureDir <tmp>` | 与 PS 5.1 **逐条一致** | 0 |
| 7 | `powershell ... -DryRun` | 打印 18 条计划行,零请求 | 0 |

`EXPECTED_OPS_TESTS_COUNT` 随 #1 的实测值改为 **79**
(scheduled-pull 31 + 本契约 31 + synth-large-bom 11 + attendance-mint-token 6)。

### #3 的那条红是既有的,不是本波引入

`not ok 10 - on-prem release and workflow artifacts publish both first-hop bootstrap sidecars`,
断言 `the workflow should declare a GitHub Release asset list`
(`multitable-onprem-package-no-node-modules.test.mjs:385`)。把本波改的三个打包文件
`git stash` 掉再跑,同一条依旧红(`# pass 13 / # fail 1`),与本波无关。本波新增的
`on-prem verifier rejects packages missing the stock-preparation acceptance runtime contract`
一条为绿。

## 二、变异探针(证明守卫是承重的,不是装饰)

做法:内存内改一处守卫 → 跑对应套件 → 无条件还原字节,结束后 `git status` 为空。
八条全部由绿转红:

| 探针 | 改动 | 转红的测试 |
|---|---|---|
| M1 | 删掉 STEP3 的 `data.ok` 断言 | `STEP3 refuses a connection test that answered HTTP 200 with data.ok false` / `...fails closed when data.ok is absent...` |
| M2 | 删掉回读的 `status`/`lastError` 断言 | `STEP3 readback refuses a saved failure (status=error, or a non-empty lastError)` / `lastError is asserted empty and never printed...` |
| M3 | 删掉预检的 `ok`/`verdict` 断言(退回只看 200) | `STEP4 preflight fails on verdict no-go and passes only on ok+go` / `...refuses a body that only carries the never-existing 'ready' field` |
| M4 | 绑定指向别的源时照样报 CLOSED_LOOP | `a table action bound to another source degrades STEP4/STEP6 to ENV_PROBE` / `every unprovable binding readback degrades to ENV_PROBE...` |
| M5 | 凭据读取退回 `.Trim()` | `a SQL credential keeps its leading and trailing spaces...` / `a credential reader strips exactly ONE trailing newline, never two` |
| M6 | 从 `REQUIRED_PATHS` 拿掉验收脚本 | `the acceptance script is part of the on-prem package manifest and its verifier` |
| M7 | 包校验不再要求 `ISOLATION_BREACH` | `on-prem verifier rejects packages missing the stock-preparation acceptance runtime contract` |
| M8 | 包校验不再要求脚本存在 | 同上 |

M7/M8 的输出里还带着上面那条既有的 `not ok 10`,不影响判读。

## 三、几处值得记下来的实测

- **凭据往返(真文件)**:`"  pa ss  \r\n"`(盘上 10 字符)→ 读出 9 字符、首 2 空格、尾 2 空格、
  不以换行结尾;`"  pa ss  \n"` 与 `"  pa ss  "` 结果完全相同;`"pw\n\n"` → 3 字符且**仍以换行结尾**
  (只剥一个);`"\n"` → 空串而非 `$null`。token 侧:`"  tok  \r\n"` → `tok`;
  `"\tto ken \r\n"` → `to ken`(内部空格保留,外侧含 Tab 一并去掉)。
- **PS 5.1 严格模式**:`Set-StrictMode -Version Latest` 下访问不存在的属性会抛
  `PropertyNotFoundException`(已实测)。老 STEP3 的 `$json.data.lastTestedAt` 在字段缺失时
  会直接把脚本打死而不是判 FAIL;所有响应字段现在统一走 `Get-JsonField`。
- **打包校验关键字的选取**:夹具第一版只写 `[switch]$DryRun`,而校验查的是字面量 `-DryRun`,
  于是干净夹具都过不了——顺手证明了"必须按脚本里实际存在的声明来钉",最终钉 `[switch]$DryRun`。
- **溯源 pin**:本波动了三个被 `sealed-export-package-provenance` 按字节钉住的文件
  (package-build.sh / package-verify.sh / plugin-tests.yml,三者在 `.gitattributes` 里都是
  `text eol=lf`,工作区即 LF 字节)。三条 pin 全部重算,40 条 pin 逐条复核对齐,#4 由红转绿。

## 三点五、第三轮返修(2026-09-10,评审反例:跳过一线步骤仍报闭环通过)

反例原话:抽取真实结论表达式,`STEP6B = SKIP` 时 `conclusion = CLOSED_LOOP_PASS`。

复现方式就是新测试本身:契约测试把 .ps1 里真实的 `$conclusion = ...` 语句(以及修后它调用的
`Get-RequiredClosedLoopStepIds` / `Get-AcceptanceConclusion` 两个纯函数)按大括号配平**原文切出**,
灌进一个只喂状态表(`$script:ExitCode` / `$script:ChainMode` / `$script:Results`)的 PowerShell
harness 跑,打印脚本自己的判定——不写平行逻辑,两份替身互相印证等于没证。

| 阶段 | 结果 |
|---|---|
| 修前(HEAD `b1f5d926c`) | `# tests 39 / # pass 31 / # fail 8`;反例那条的断言输出 `actual: 'CLOSED_LOOP_PASS'` |
| 修后 | 本契约 `# tests 40 / # pass 40 / # fail 0`;全目录 `# tests 88 / # pass 88 / # fail 0` |

真机口径的两次实跑(把脚本汇总+报告那一段原文切出来喂合成步骤表,PS 5.1.26100.9168):
STEP6B=SKIP 其余全 PASS → 打 `CONCLUSION: INCOMPLETE (REQUIRED_STEP_NOT_PASSED)`、
`MISSING STEP STEP6B-... SKIP`、`MISSING INPUT PROJECT_NO`,报告 `closedLoop: false`;
十条必需步骤全 PASS 且 `chainMode=CLOSED_LOOP` → `CONCLUSION: CLOSED_LOOP_PASS
(ALL_REQUIRED_STEPS_PASSED)`,`missingRequiredSteps: []`。

变异探针(只改 scratch 里的镜像副本,仓库工作区零改动):

| 探针 | 改动 | 转红 |
|---|---|---|
| M9 | 结论表达式退回只看 `ExitCode` + `ChainMode` | 9 条(含 `a run that SKIPPED the front-line dry-run can never conclude CLOSED_LOOP_PASS`),`# pass 31 / # fail 9` |
| M10 | 必需清单里拿掉 `STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN` | 5 条(含反例那条与清单断言),`# pass 35 / # fail 5` |

`EXPECTED_OPS_TESTS_COUNT` 随之 79 → **88**(scheduled-pull 31 + 本契约 **40** +
synth-large-bom 11 + attendance-mint-token 6)。改了 `plugin-tests.yml` 就要重钉
`evidenceFiles.pluginTestsWorkflow`:`dcf6d5ba…4344` 之前是
`dcf6d5bae8ca8f12b7a81b2beab1b332848bac5d14f8fc2720a5275cd7bb54a1`,新值
`9921d9d7d72953e7ff701141c644feed386fd4985863233087a90bea94c74344`;官方口径重算后
66 条 pin 逐条比对零差异,`sealed-export-package-provenance.test.cjs` 绿。
验收脚本本体与它的契约测试都不在 pin 名单里(名单里的 `s6aAcceptanceRunner` /
`s6aAcceptancePs51Test` 指的是另一支 S6-A 脚本)。

## 四、没做/留给下一轮

- STEP6B 仍只断言 dry-run 的 HTTP 200,没有断言返回体里的行数/字段形状——本轮返修范围外。
- `-SelfTest` 需要机器上有 PowerShell(`pwsh`,Windows 上也接受 `powershell`);
  找不到时契约测试**判红而不是 skip**。运行 `scripts/ops/__tests__/*.test.mjs` 的 CI job
  是 ubuntu-latest 且同一 job 里已有 `shell: pwsh` 步骤,前提成立。
- 闭环那一档(`CLOSED_LOOP_PASS`)在真机上尚未取得过:需要先把备料表动作绑到新建的源。
  现在的保证是两条:没绑就绝不写成闭环,必需步骤没跑就绝不写成"通过"(报 `INCOMPLETE`)。
- `INCOMPLETE` **不改退出码**(仍是 0)。退出码只表达"有没有 FAIL / ISOLATION_BREACH",
  这是上一轮既有语义,本轮没动;只看退出码的自动化仍需要再读一眼 `conclusion` 字段。
- 缺 `-ProjectNo` / `-OperatorTokenFile` 的判定来自步骤表(两条 STEP6 都 SKIP → 缺 token,
  只有 STEP6B SKIP → 缺项目号),不是回读参数本身;若将来 STEP6A 因别的原因记成 SKIP,
  这条提示会指错输入——步骤清单本身仍然是准的。
