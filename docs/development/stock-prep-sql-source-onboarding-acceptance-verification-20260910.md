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

## 四、没做/留给下一轮

- STEP6B 仍只断言 dry-run 的 HTTP 200,没有断言返回体里的行数/字段形状——本轮返修范围外。
- `-SelfTest` 需要机器上有 PowerShell(`pwsh`,Windows 上也接受 `powershell`);
  找不到时契约测试**判红而不是 skip**。运行 `scripts/ops/__tests__/*.test.mjs` 的 CI job
  是 ubuntu-latest 且同一 job 里已有 `shell: pwsh` 步骤,前提成立。
- 闭环那一档(`CLOSED_LOOP_PASS`)在真机上尚未取得过:需要先把备料表动作绑到新建的源。
  本轮只保证"没绑就绝不写成闭环"。
