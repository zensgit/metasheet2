# 既有 #6337 收口验证

## 2026-10-14 Owner 授权发布当前候选

Owner 已明确批准“允许将六文件补丁及 MD 推入现有草稿 #6337，并运行既有合成 CI”。本次准备准确六个代码/测试文件与本设计、验证两份 MD，在 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024` 上追加；不夹带主检出或其它工作区改动、不新增切片。下方禁止推送记录保留为历史状态。当前提交准备不等于 CI 通过；新 head/run 与最终结果另记。原失败、时钟风险、Chromium 发布门仍未消除，不授权合并、部署、真实客户读取或真实宜搭发送。

## 2026-10-14 最终本地完整验收及真实页面试用（最新状态）

冻结基线 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`，交付副本共六个未提交/未推送代码与测试文件。下方“四文件／浏览器未执行”属于历史快照，本节为最新结果。

### 清单对齐与变异自证

新增 HTTP 诊断负例使原五文件总数从 70 增为 71。既有 browser CI launcher 与契约测试同步固定为 71（66 业务 + 5 哨兵），其余严格条件不变。两个整文件契约/工作流测试 61/61；定向基线 2 passed / 31 skipped（仅变异探针使用过滤，不冒充完整验收）。分别把 validator、caller 改回 70，两变异体各 1 passed / 1 failed / 31 skipped，均被杀死；随后恢复候选原字节。

| 当前候选文件 | LF SHA-256 |
| --- | --- |
| `packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts` | `9dfa8f7acf8f32bec4fb27ec58878c9e737cfe896da27807b35b32a8df62610a` |
| `scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs` | `6c8e3af9f1a0817094d976f2d0680a78dda936187df2eb16da6edceca154a9f3` |
| `packages/core-backend/tests/integration/stock-preparation-yida-owner-http-realdb.test.ts` | `fa9c0cbcf8b0f9c333ff72c83cdf4ce815040835e5dd993606696b6e25e53eb2` |
| `plugins/plugin-integration-core/__tests__/yida-delivery-runner.test.cjs` | `7d095595a8dca9c1140aed6c40332fc378587c546e3501a9f1c06772b748b232` |
| `scripts/ops/run-stock-preparation-yida-browser-ci.mjs` | `ca8dca4a67d419efd84439ae66e0f1b0a6ee47ff391ab088e7895de1daa7f503` |
| `scripts/ops/stock-preparation-yida-browser-ci.test.mjs` | `f651ee0e818d117e26a0574b18195d7a445a1dcc3d558c2d3eb3592344776637` |

### 保留失败，不用后续成功抹掉

第一轮原 Chromium CLI 为 70/71；owner browser 正例收到完整上游 503，固定标签 YIDA_OWNER_BROWSER_HTTP_STATUS / YIDA_OWNER_RUNTIME_UNAVAILABLE。浏览器请求完成、上游响应完整，不是该次请求意外 ABORTED。失败时独立数据库计数为 [1,0,1,2,1,1]，但没有内层阶段捕获，不追认成此前时钟回拨同因。其余两个 abort 属于预期的 clear/session-change 用例；清理成功。该轮 receipt SHA `4482ab37b7d27ea5593f37c280957f11183e2aab1f570bc45cb58470102819e6`。

随后临时原生阶段诊断的五文件运行 71/71，没有捕获失败阶段，receipt SHA `0dcf0d4f44eea69becf26fa16c20121f94ae5f4b1d1bc2d9c61ca3bb9b7594a5`。它仅属诊断，不列为最终验收；六个临时插桩文件均已还原。诊断脚本生成时曾发生语法错误、试用包装器曾被 SHA 拼写错误预检拒绝，均在业务执行前修正，不归为生产失败，也不计为验收。

### 最终原入口完整 Chromium 验收

Ubuntu-24.04 非 root runner、清空继承环境、独立真实 PG，通过原公开 `scripts/ops/run-stock-preparation-yida-browser-ci.mjs --pg-bin /usr/lib/postgresql/14/bin` 执行。目录 `yida-browser-ci-e4bf0a98-c203-4663-8056-01ee95aadd9f`。

- **71/71：66 业务 + 5 哨兵，准确五文件；skipped/retries/repeats/unhandled/missingRetryFields 均为 0。**
- 原 forks pool、原 vitest.yida-owner-realdb.config.ts，retry=0、repeat=0、watch=false、filtered=false、setupFiles=0、globalSetup=0。
- exit0；没有超时、中断或输出溢出；cleanup=stopped-owned-pg-removed，passed=true。
- 本轮始终保持时钟同步服务 active，没有暂停服务或修改持久配置；成功不证明环境永久稳定。
- sealed-export-package-provenance 整文件 1/1 PASS，没有改 pin。

| 原始本地证据 | SHA-256 |
| --- | --- |
| receipt.json | `3ce187f11a07231e4e68ab97dab3af61b466584571259154c4469682ae08ff4e` |
| tasks.json | `ac9bfc9dbc2d729b653cbcd7282faa9a633d98931cf2637f88cadb4d0613dd90` |
| vitest.json | `d0407af02fd261f8887684b65e5c6613f5c6086bf748913f0f0d72b46c38cc96` |
| vitest.stdout.log | `38e0dbaa00e8049b5386500e2e54723de31393d13fcfdbeb17b22af72138c323` |
| vitest.stderr.log | `f7d79b28fe7cab8eabf992ebbbb62066d9b6cdbeee4f21b767fd6073239a02ea` |

### 完整应用真实页面合成试用及带连接停止

用本轮全新合成账户通过页面真实登录（不注入 JWT），进入备料项目 SYN-YIDA-PREVIEW 的 v2，选择七项身份合成样例 A，执行只在本地预演。可见结果为两行，计划新增 2 / 更新 0 / 无效 0 / 重复 0，canApply=false。没有执行客户源拉取或切换租户范围。

打开本地初始化（不发送），通过真实 GET、仅填本轮生成的假材料与合成标识、确认后 POST，再次 GET 回读。页面 initialized=true、draftRows=2；canSend=false、tokenIssued=false、externalWriteAttempted=false，私有输入清空。没有真实宜搭 token 交换或外部发送。

截图：`E:/Projects/metasheet/tmp/pr6337-yida-final-initialization-preview-20261014.png`。此为代理实际观察的页面证据；试用包装器自身 uiAcceptanceClaimed=false，不能把包装器终态冒充它自行断言 UI。也没有声称浏览器具备内核级网络或文件系统隔离。

保持浏览器连接打开，向原公开 CLI 输入 stop：terminal code=0、passed=true、ready/stopped=true、invalid=false、sourceUnchanged=true、handoffRemoved=true、ownedPgDirectoriesAbsent=true。退出后关闭本次临时标签页，标签清单为空。临时库和 handoff 已由原停止链清除；诊断目录仍保留作为本地证据，不递归删除。

### 当前交付边界

### 目标续核：不能把局部试用当六批完成

续核读取目标文件位于 `C:/Users/zen08/.codex/worktrees/integration-goals/metasheet/docs/development/integration-self-service-adaptation-goals-20260930.md`；主检出与当前准入副本均无该目标文件，不在主检出新建重复目标。当前目标工作区 Git HEAD 为 `2888addb4951e831e93a250920af8096ac8b3474`，文件中后续追加记录是本地历史数据，不以 HEAD 或文档叙述替代实现证据。

按目标 §5/§6/§9 区分证据范围：本次 71 项全链与页面初始化/静态两行预览直接支持既有宜搭切片的本地验证；不证明 SA-01 全部 BOM 语义、SA-02 全部配置生命周期、SA-03 客户 K3 协议、SA-05 真实发送或 SA-06 全部 Automation 消费者完成。此前这些批次的专门证据仍需按准确候选和入口逐项核验，不能用本次测试计数替代，也不因此重开封存切片。完整目标继续 active，未标 achieved。

本次只读再核 GitHub：#6337 OPEN/draft，head 仍为 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`。run 38505094157 attempt 2 已 completed/failure；test (20.x) 为 failure。准确步骤中 isolated manual checkpoint、PLM full-app isolation/contracts、synthetic PLM manual/interval 成功，owner YiDa JWT HTTP/browser proof 失败。后置 PLM validation source-revision unit contracts 是 skipped，不能笼统声称全部 PLM 步骤通过。其它泳道绿不覆盖该失败，也不覆盖未推送六文件。

下一交付门仍为：owner 另行授权推入现有草稿后，按实际新 head 执行既有合成 CI，再核终态与精确业务步骤；本轮不执行。合并、部署、客户读取和真实宜搭 token/发送仍各自独立授权。本地试用已经实际完成，不为等待发布门反复重跑整站或重复制造绿灯。

续轮本地字节复核直接读取 Git 冻结基线的 browser CI launcher blob，与交付文件比较：全文件严格等于基线只将七处完整数字 70→71、两处 65→66 后的结果，断言 exit0。除准确库存总数外，所有安全和 policy 字节未变；没有删 sentinel、缩短文件集合、允许 skip/retry/filter、放宽退出或清理条件。另亲读实际 cleanup finally，确认 host.stop 在 preview.close 前，各自异常继续 retainFailure，handoff 仍有独立 finally。此为补丁差异复核，不冒称新增独立审查或新的业务验收。

停止后的最终后验：13,758 项准入源码核验通过，恰好只有表中六文件变化，交付副本 LF 字节一致，临时运行时与 fixture 插桩全部还原。systemd-timesyncd 为 active，无本次恢复 timer 残留。主检出仍仅原有 `?? artifacts/reviews/`，没有丢弃或改动其它工作。

这是原 head 加六个本地未发布文件的证据，不是 GitHub 同 head 正式 CI 成功。远端 run 38505094157 attempt 2 的宜搭 EXIT/WORKER_REJECTED 失败、attempt 1 的 250ms source-pin lease 到期证据均保留；Chromium 发布阻断仍待获授权发布后的准确新 head 正式步骤核验。后台监视已在终态停用。本轮不推送、不触发 CI、不合并、不部署、不访问客户系统、不真实发送。

## 2026-10-14 受控时钟窗口后台合成验收（已授权、已完成）

owner 单独批准最多 10 分钟、独立自动恢复的暂停窗口。执行前确认同步服务 active，13,758 项源码逐项校验仍仅四个批准代码/测试文件变化。建立独立 600 秒恢复 timer 后暂停服务，以 runner 身份进入原 loopback-only namespace、capability 全清、全新 owned PG 的三整文件验收。没有改任何生产时钟守卫、断言、超时、重试或源码准入规则。

结果 **59/59**，逐项 assertionResults 为 59 passed / 0 failed / 0 pending / 0 skipped，准确三文件集合；exit0、signal=null、timedOut=false、overflow=false、cleanupProven=true。固定结果目录 `metasheet-yida-backend-proof-L6Or3q`，stdout SHA `94f87c59e1640d23dbff3e7a57a6b91dc1d3f33a71df505a073d7745cbc5abcd`，stderr SHA `6a013b71d94eadb16a930c32d667b41cd78de87ee97381f3cb81ed13fbe986e3`。本机固定字段回执：`tmp/pr6337-controlled-proof-receipt-20261014.json`。

运行中独立 30 秒采样 2955 次：实时时钟回拨 0、最大回拨 0ms、单调时钟回拨 0，采样前后服务均 inactive。采样回执 `tmp/pr6337-controlled-proof-clock-20261014.json`。这证明该观测窗口没有时钟回拨，不扩大为完整机器永久稳定性的声明。

完成后立即在 finally 恢复同步服务；独立后验为 active / restoreTimers=0。源码后验仍只有四文件变化、交付副本 LF 字节一致、临时运行时插桩已还原。没有长期停用服务、修改持久配置、设置系统时间、重启 WSL、推送、触发 CI、部署、读取客户数据或真实发送。

当前裁决：本次受控后台验收已通过，初始化、预览及单行模拟发送/历史回读有完整链路证据。前端页面和固定 Chromium 正式步骤没有在本轮执行，browserAcceptanceClaimed=false；服务恢复后的时钟风险与原正式 CI 失败继续保留。不能用本轮结果宣布生产可用，或自动延长/复用暂停服务授权。

## 2026-10-14 本机同步服务对照实验（已授权、已完成）

owner 明确批准本轮 Ubuntu-24.04 实验。执行前确认 systemd-timesyncd active；建立独立 90 秒恢复 timer 后暂停服务，采样约 60 秒；finally 恢复并确认 active，再采样约 60 秒。实验中间的独立检查为 inactive / restoreTimers=1；恢复后的独立检查为 active / restoreTimers=0。

| 服务状态 | 样本数 | 实时时钟回拨次数 | 最大回拨 | 单调时钟回拨次数 |
| --- | ---: | ---: | ---: | ---: |
| 暂停 | 5713 | 0 | 0ms | 0 |
| 恢复 | 5675 | 2 | 1247ms | 0 |

命令 exit0，serviceRestored=true。没有设置系统时间、修改持久配置、重启 WSL、运行业务测试或访问客户系统。实际回执（散列不含 receiptSha256 自身字段）SHA `7fa3b51ceba06249042f20160a5f00d36b4539a03d82f5cd65fbaee4aac56be9`，本机文件 `tmp/pr6337-timesync-ab-receipt-20261014.json`。

结论：受控暂停/恢复实验支持本机校时服务运行与回拨相关；具体时间源/校正机制尚未证明。环境恢复原状后仍有回拨，因此没有宣布稳定试用或永久修复。没有长期停用服务，也不把约 60 秒实验授权扩展为更长的试用窗口。原生产回拨拒绝、历史 503/ACK 失败、宜搭正式 CI 失败与 Chromium 阻断继续保留。

## 2026-10-14 503 失败瞬间与最终本地候选（最新续记）

### 已捕获的直接触发链

原生模块桥接的阶段采样捕获新失败：equal_decimal_exact 正例第 0 轮，实际执行 2 passed / 1 failed；其余 33 pending / 35 skipped，不能用 Vitest 汇总 70 passed 冒充 70 条已执行。失败目录 `metasheet-yida-backend-proof-EeF5o3`，cleanupProven=true，未超时。固定序列为：

`ADMIT → TAKE → RUN → RESOLVE_1 → PREPARE → TOKEN → RUN_CLOCK(delta=-1352ms) → RUN_ERROR(CLOCK_INVALID) → SEND_ERROR(UNAVAILABLE) → RUNTIME_ERROR(UNAVAILABLE)`。

RUN_CLOCK 的两次单调时钟采样间隔约 503ms，实时时钟却回拨 1352ms。独立 PG 在失败当场返回 admissions=1、ledgers=1、audits=1、ledgerState=prepared；tokenRequests=1、formRequests=0。确证本次 503 的直接触发是回拨守卫，已授权的操作尚未 claim 或发送 form。单独的 tokenRequests=1 只证明请求发生，不单独作为 token 成功取得的依据。stdout SHA `9c6586a3cbed1596968364ef257bd32716dc7df7b7b963cf699862b29d64c6b6`，stderr SHA `bc2fc1b20d35aee79fffee5c6492fa78f66a903f36f2e3c071b961f8e4180723`。

之前同轮捕获的 d3JNJi 为 8 passed / 1 failed，失败摘要同样停在 prepared、token 1/form 0，但内部阶段桥接未贯通，不能追认具体原因。sAvFnE 为 18 passed / 1 failed，失败是 ACK 对象断言，未捕获实际状态，也不追認为回拨。两轮均清理成功，原证据保留。临时诊断的六个文件已按原字节恢复；收集器没有进入交付副本。

### 时钟与独立复核

本机 Windows/WSL 60 秒同步采样 1133 帧：Windows 回拨 0 次；WSL 回拨 2 次，最大 1796ms；WSL real-time 与 monotonic 的累计变化差为 -3697ms，Windows 为 0ms。Windows 与 WSL 观测偏差范围 -891..961ms，包含采样传输延迟，不当作精确时差证明。结果在本机 `tmp/pr6337-clock-comparison-20261014.json`，没有写系统时间、改服务或读时间服务器地址。

实际复用已授权的 Astra ultra 只读代理复核。裁决为：本次回拨直接触发证据成立，生产拒绝语义正确；具体校时来源未确定，不根据服务 active/stopped 快照归因，不把本次根因回填历史两次 503。拟议本机同步服务对照实验尚未执行，单独授权待答。

### 持久候选与验证

| 文件 | 当前 LF SHA-256 |
| --- | --- |
| `packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts` | `9dfa8f7acf8f32bec4fb27ec58878c9e737cfe896da27807b35b32a8df62610a` |
| `scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs` | `6c8e3af9f1a0817094d976f2d0680a78dda936187df2eb16da6edceca154a9f3` |
| `packages/core-backend/tests/integration/stock-preparation-yida-owner-http-realdb.test.ts` | `fa9c0cbcf8b0f9c333ff72c83cdf4ce815040835e5dd993606696b6e25e53eb2` |
| `plugins/plugin-integration-core/__tests__/yida-delivery-runner.test.cjs` | `7d095595a8dca9c1140aed6c40332fc378587c546e3501a9f1c06772b748b232` |

- runner 整文件 **54/54**，exit0，无 skip/cancelled；新增 token 后与 claim 后回拨测试均通过。stdout SHA `4438163e901be520068c6e4ef15b3855dcb2d66dea0100488833335c60d8173a`。
- 删除 `now < lastClock` 的真实运行时变异体 **51/54**、exit1；两条新增回归都致红，原有回拨测试也致红。stdout SHA `239d190086bcd52b539f393d93689bd07152028745f15cfd0751c3c61fe1477c`。原 runner 随后恢复，SHA `809dd57d1c659ae642ccc1a22a42484316d2ad92e5a8e407c0d04ecab4993263`。
- 四文件最终候选、没有临时生产诊断的三整文件真实 PG 验收 **59/59**，无 pending/skipped，exit0、cleanupProven=true，目录 `metasheet-yida-backend-proof-d43GFN`。逐项核验 assertionResults 与准确三文件集合。stdout SHA `4c44e604ff7efe39cd065d256de43ad1bbfa3f8d56489eec741ffa6af9ea698d`。一次通过不证明本机时钟已稳定，也不消除历史失败。
- 13,758 项准入源码逐项后验：仅表中四文件变化；交付副本 LF 字节一致；所有临时运行时诊断还原，未改 index、pin、生产授权/时钟守卫。

PR #6337 再核仍 OPEN/draft，head `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`。本地补丁没有提交/推送，既有 CI attempt 2 的宜搭失败及 Chromium 发布阻断继续保留；没有新 CI、合并、部署、客户读取或真实发送。

## 2026-10-14 503 定位与 CI 终态（本地续记）

### 远端终态

14:31（新加坡时间）核验 run `38505094157` attempt 2 为 completed/failure，head 仍为 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`。检查点、PLM 完整应用步骤已通过；`Run owner YiDa JWT HTTP and browser real-DB proof` 失败。

公开固定诊断：`stage=EXIT / reason=WORKER_REJECTED / diagnosticSource=RECEIPT / diagnosticOutcome=FRAME_ACCEPTED / childExit=1`，signaled/timedOut/interrupted/outputExceeded/error 均 false。按冻结源码 `run-stock-preparation-yida-browser-ci.mjs:390`，该阶段是 Vitest 子进程退出后成功条件不成立，不是此前启动 namespace 的错误。公开结果 tests/business/sentinels=0 是失败时的固定输出，**不表示实际执行零条测试**。当前 artifact 清单只有 DingTalk 产物，没有本次宜搭私有 Vitest 报告；不能从公共 frame 判定具体用例，也不能认定它与本地 503 同因。公开失败日志摘要（内存 UTF-8 规范化）SHA `2fdea9c832066b8d927a9614f1d075a7247ff9a3af8a1712e9dea597aba5f265`。

`6337-ci` 已按终态规则置为 PAUSED，未自动重跑。attempt 1 的 250ms 租约失败、本次宜搭失败以及固定 Chromium 发布阻断全部保留。本地未推送补丁不在该 head 中。

### 本地新增证据

- 原测试上增加临时接口标签的三整文件诊断轮为 58/58，原 fixture 已恢复，不能把诊断轮当最终候选。
- 定向冷启动只执行三个模式的正例。Vitest 汇总 `numPassedTests` 会包含按名称过滤掉的用例，因此已改为逐项读取 `assertionResults.status`。首次驱动期望 3 却读到汇总 37 时如实拒绝；实际是 3 passed/34 skipped，不是产品失败，也不是 37 条已执行。四次带时钟守卫诊断的定向运行共 12 条正例通过，但没有捕获时钟拒绝；另一个定向轮曾在 equal_decimal_exact 的 ACK 断言失败，未报 503，同样保留，不能混并归因。
- 本机 60 秒只读时钟采样共 51,023 次，发现两次回拨，最大 1,984ms。执行器 `yida-delivery-runner.mjs:243` 会拒绝回拨，但尚无证据把这与历史两次 503 直接关联；不改系统时钟、不放宽回拨检查。
- 现有 HTTP 测试新增固定阶段与错误码诊断以及一条不泄漏响应值的检查，测试文件 SHA `7d172c2f95b9951d78ee5f69c13523fdaad8eb11738291825e757e5b69b758f4`。最终候选三整文件一轮为 **58/59**，失败为 equal_integer 正例：`submit:YIDA_OWNER_RUNTIME_UNAVAILABLE`，expected 503 to be 200，duration 1292ms。其前置 preview 与 approve 已通过。该证据将本次新失败定位至模拟提交，不足以断言历史两条必为同因。stdout SHA `e09f910cd5931f59eab2a711bc1a7d44c78bb46971ab949a385ce013ce36ee5d`，cleanupProven=true，未真实发送。
- 临时内层诊断的一轮三整文件为 59/59，但因生产模块当时含诊断插桩，不计作最终字节验收；没有捕获正例失败。原字节随后恢复。stdout SHA `dc6425c61af3dedddf666ca08854d70d235499abf8b8e69a6bdcbe2d095ad29e`。

- 随后的三轮内层原因诊断均为三整文件 59/59、cleanupProven=true，均只捕获预期负例的审批拒绝，没有捕获正例 503 原因。stdout SHA 依次为 `9484da3e6bf5387027a585aff751091f5a83e18c22797e1f60ecaf09e21aa2f2`、`76ff5d1b40b7e67e6c2133f9396cae1770ccdca500a1dd053685b735f54bc810`、`8b45083039cb8b8f2899fa67a4a93339cc5374f061cc914a7d467a8025c6b34c`。这些含临时诊断的运行不替代最终候选 58/59 的失败证据。
- 诊断驱动 finally 已恢复原 send-port；独立逐项比对 13,758 项准入文件，确认实际源码仅保留退出顺序修复、其回归测试以及上述 HTTP 测试诊断三文件，Windows 交付副本与实际 LF 字节一致。fixture、runner、approval service、send-port 的所有临时诊断均已恢复，未修改 pin。

当前：内层异常原因仍未定位，未给生产业务代码打猜测补丁，也不继续以无差别重跑替代归因。当前不宣称 503 根因已修或可稳定发布；初始化与预览的已有演示证据和完整发送合成链的不稳定分开判断。

### Astra ultra 独立只读复核

owner 单独授权后，实际使用 `gpt-6-astra / ultra` 子代理，只读核对调用链及限定脱敏证据。未委派任何文件修改、真实访问或发布操作。结论：**503 未定位，没有足够证据修改业务代码**。

- `yida-owner-send-port.mjs:30` 把非自身错误封装为 UNAVAILABLE，`yida-owner-runtime.ts:69` 再封装为 YIDA_OWNER_RUNTIME_UNAVAILABLE，HTTP 码不能区分 admission、runner 或最后回读失败。
- authority 的三次 resolve / 两次 load 限额与真实调用链 `resolve₁ → load₁ → exchange → load₂ → resolve₂ → claim → resolve₃` 匹配，未发现正例自身触发超限的路径。
- 时钟回拨与症状相容，但不是已证实根因。claim 前拒绝可能成为 503，claim 后失败通常转 outcome_unknown；现有 runner 单测已证明回拨拒绝机制，无需重复该机制探针来冒充历史故障归因。
- 独立核对最终候选 58/59 失败事实；三轮带诊断全绿不能覆盖它。本次代理未审 cleanup 改动，不把此结论当作整个 PR 或退出修复的额外背书。

最窄后续诊断：仅在正例 submit 失败当场、fixture reset 前记录固定阶段、admission/ledger/audit/token/form 计数及 ledger 状态枚举；禁止异常正文、响应正文、ID 或材料。只有确定落在 runner 后才进一步细分检查点。此项是后续建议，**尚未实施**，没有额外生产插桩留在交付副本。

模型使用如实记录：本轮实际委派 Astra ultra 一次；Grok Build 的本机模型清单已确认 `grok-4.7` 可用，但没有创建 Grok 任务。模型可用不等于已调用，也不扩大原有操作授权。

## 2026-10-14 本地 proxy-drain 顺序修复验收（尚未提交/推送）

基线 head `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`。13,758 项准入文件逐项校验，仅下面两文件变化；其它运行时、index、凭据/权限、恢复代码及 provenance pin 不变。

| 文件 | SHA-256（实际 LF 字节） |
| --- | --- |
| `packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts` | `9dfa8f7acf8f32bec4fb27ec58878c9e737cfe896da27807b35b32a8df62610a` |
| `scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs` | `6c8e3af9f1a0817094d976f2d0680a78dda936187df2eb16da6edceca154a9f3` |

### 已完成

- 原代码 + 新回归：11/13，两条清理回归失败。真实代理连接用例约 30,170ms，超过未改变的十秒要求；测试不是仅靠源码字符串制造红灯。
- 修复 + 同一整文件：13/13，exit0，skip/todo/cancelled=0；真实连接用例含 setup 约 149ms。
- 宿主 shutdown、recovery wiring、attendance census 三整文件：139/139，failed/pending/todo=0，exit0。运行器逐一核对实际测试文件集，不靠过滤器总数放行。stdout SHA `2cb9b73c5376fa39506323d5870203a8e08ff5812793d9ef3bcbeca9b51de2e7`。
- 严格 trial tsc：exit0、stdout/stderr 空；完整 sealed-export provenance：exit0，stdout SHA `f100c276587a34f70f4ea13506812da8b9ad5788bdb3ca0c655dc4f92f088a04`。未改 pin。
- 内置浏览器完成真实本地登录、两行协议 v2 预览、初始化 POST、再次 GET 确认。页面显示 `canSend=false / tokenIssued=false / externalWriteAttempted=false`；未进入发送授权或发送流程。
- 页面保持打开、没有预先关闭浏览器连接时，原 stop 协议正常结束：05:45:54.176Z 开始，05:45:54.177Z WebSocket 断开，05:45:54.180Z HTTP 关闭。随后 `STOPPED → exit0`，sourceUnchanged/handoffRemoved/ownedPgDirectoriesAbsent=true，invalid=false。待终态完成后才关浏览器标签页。
- 本次回执 SHA `efa48f8006d50c5f35a598938bbb64ee29f4145ba98f352edacddea87fb8ef76`；宿主日志 SHA `9f4dd4eb4c030bcee955263261f7c3c09ad3bb4149292d3e384f89c6b19326e3`。结果截图：本机 `tmp/pr6337-yida-fixed-ui-20261014.png`。

### 不能隐去的失败与范围

后台三整文件与完整构建并行的一轮为 **57/58**：`one real preview/confirm/admission/token/form/ACK and history without IO: original` 在共享 bodyData 断言报 expected 503 to be 200，case duration 1100ms；回执没有错误 body，因此不能断言是 5s fetch timeout 或仅因 CPU 负载。该测试的 YiDa fetch 为进程内假响应，未真实发送；正常清理成功。原失败日志 stdout SHA `5f096db055c15ae657cf01ec5062dc1c593570422a99db6ca79b17124765fea2` 保留。本修复的 trial 入口不由这些后台文件加载，不能仅凭同时发生就判为换序回归。

随后使用同字节、同 config/timeout/断言、全新 PG 单独复核，仍为 **57/58**，同一 case 报 503，duration 322ms，清理成功；stdout SHA `f3fb88ecadb3ef65e108ecd62f8d2bc226fd4448b9db0ed0550370c0cd7263fe`。因此不能用构建并行负载解释或关闭此风险。

为定位，只在临时副本为共享状态码断言增加白名单 `YIDA_[A-Z_]+` 错误码标签（不输出响应正文、不改期望值），同三整文件得到 **58/58**，没有取得失败错误码。随后 finally 恢复原测试，SHA `8d47d5ed3b991cad8d9273774e4dc8a23f8b63605b15b0809dae04e24cd74768`，诊断不进入补丁。诊断轮 stdout SHA `9621e427d7e01b602be0dccb4b0321db6e16beb5b9cf036f0b6801575954eff5`，只作诊断记录，不冒充最终字节验收。

恢复原测试后，再以最终两文件候选跑三整文件：**58/58**，failed/pending/todo=0、exit0、signal=null、timedOut=false、overflow=false、cleanupProven=true；stdout SHA `9f84cf50bd224846e54560695e1729385e1cc1819fecff1e06bffc8e42d501a9`。13,758 项后验及额外独立 scope 校验确认仅表中两文件变化，Windows 交付副本与 Linux 实际 LF 字节完全一致。此结果补齐一次最终候选成功证据，**没有定位或消除前两轮 503 的稳定性风险，仍不作全绿/可发布裁决**。没有把重跑设成自动重试或降低任何断言。

单元检查驱动初次误写不存在的 recovery 文件过滤器，Vitest 忽略它，仅运行了两文件 126/126；不算三文件通过证据。已修驱动为准确 `metasheet-recovery-archive-wiring.test.ts`，增加文件存在及 report 文件集断言后重跑，得到上面的真实 139/139。

截至 2026-10-14 05:55Z，远端 run `38505094157` attempt 2 仍绑定未改 head，`test (20.x)` 执行 `Run isolated manual checkpoint acceptance`，尚未到 PLM/宜搭完整验收。当前本地补丁未提交、未推送、未触发新 CI。旧 attempt 1 的 250ms source-pin 到期与固定 Chromium 发布阻断仍保留；既有只读跟踪 `6337-ci` 继续观察，终态后停止，不重复创建监视器。本机可见页面验证没有内核网络隔离声明，不冒充完整固定 Chromium 验收。生产部署、真实客户读取、真实宜搭 token 交换/发送均未执行。

## 2026-10-14 当前 head 后台与 CI 补证（本地续记，尚未推送）

### 内置浏览器实测：页面通过，停止协议失败

同一 head 的全新实例于 2026-10-14 05:31:38Z READY。通过 Browser Use 内置浏览器，实际完成：合成账号登录 → 备料合成项目 → 协议 v2 → 七项身份样例 A → 本地预演 → 初始化前 GET 空槽 → 填入本次假材料并显式 POST → 再 GET 确认持久化。页面显示计划创建 2、更新/无效/本地重复均 0；初始化返回本地草稿 2 行，`canSend=false / tokenIssued=false / externalWriteAttempted=false`，没有 grant 或发送许可。未打开单行 CREATE 授权流程，未查询宜搭、未发送。本次是 UI 实测，不再仅是后台证据；但不替代固定 Chromium 完整应用 CI。

实测后通过原 stdin `stop` 协议收尾。终态 **exit1、stage FAILED，未出现 STOPPED**，不能记录为全链通过。宿主日志固定标签顺序：05:33:17.577Z 开始停止；05:33:27.579Z `Approval completion producer drain timeout` 与 `APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED`；05:33:45.387Z 才出现 `HTTP server closed`。HTTP drain 在生产者屏障之后才结束，指向带浏览器连接的收尾路径，但这些标签不足以确定唯一根因，不能未经复现即归因某一种 socket。

父进程仍完成兜底清理：`handoffRemoved=true / ownedPgDirectoriesAbsent=true / sourceUnchanged=true`，只读扫描无本次源码路径关联的残留进程。数据库及临时交接材料已删除；诊断保留，未手工递归删除。清理成功与正常退出失败分开记。

- 本次停止回执 SHA-256：`ebf6cde7605812b5ac13c3dc6fb86f14205192def427f01495695c1366b304a0`。
- 宿主日志 SHA-256：`0d71f9020f4c4e1d9a21e6984bfc39ed1c975c18ded6453e2a74e5c3a0fcd0db`，仅输出固定标签、顺序和时间，没有公开原日志。
- 页面结果截图留在本机 `tmp/pr6337-yida-initialization-ui-result-20261014.png`，不含真实凭据。

当前裁决：本地初始化与静态推送预览已可完成合成演示；带页面连接的正常退出仍阻断收口。原 CI attempt 2 继续执行，原失败与固定 Chromium 发布阻断保留。未改恢复代码、未新增切片、未推送、未合并、未部署。

Owner 后续明确授权：只重跑同一提交上的失败 job，以及内置浏览器本地合成试用。已执行 `gh run rerun 38505094157 --job 115660672988`，GitHub 确认 attempt 2 仍绑定 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`；新 test job 为 `115697733438`。原 attempt 1 的失败保留；重跑不是恢复代码修复，也不能证明 250ms 时序风险消失。已登记仅针对该 run 的只读跟踪，终态后停止。尚未产生新代码提交、推送、合并或部署。

内置浏览器试用启动时使用同一准入源码清单加七项精确覆盖。保持原公开 CLI、TTL 900 秒、全新自有 PG、默认禁止外部发送及源码后验。为本机页面可达，此次可见试用不在私有网络命名空间中，因此不声称内核级零出网或 browserNetworkAttested；运行时原有守卫保持。页面结果和终态清理见上节，未提前记录成功。

run `38505094157` 绑定 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`，终态 failure；core-backend 整体测试已 success，上轮三条 socket 清单断言不再阻塞。K3 offline、DingTalk regression、after-sales 三任务 success。当前失败是原有前置步骤 `Run isolated manual checkpoint acceptance`：恢复 stale-pin suite 的 `the current owner can consume one source pin without touching another generation` 在 insertSourcePin 阶段报 `recovery_archive_source_pin_lease_expired`，127 项中 126 通过、1 失败。该测试的 `insertExpiringArchive` 使用真实时钟加 250ms，随后测试先创建两代记录再插 pin，存在到期前置窗口；本轮没有修改该测试或恢复生产代码。宜搭/PLM 后续步骤均 skipped，不能说该 CI 已验证它们。是否同 head 重跑失败 job 已请求 owner 单独授权，不自动重跑。

已为当前提交新建准入源码副本，13758 项清单叠加已发布补丁，特别包括最新 socket 清单测试 SHA `d28af00e471c4191026704f374deff20b63dd3a775264ed0750f4f5327ea0202`；未复制旧 tmp、旧凭据或 .env。原后台三整文件、原 config/retry/断言不变，在新的自有 PG 与 loopback-only namespace 中 58/58 通过，failed/pending/todo=0，exit0、signal=null、timedOut=false、overflow=false，随后原 stop 删除 PG 目录并完成源码后验。

后台回执 SHA-256 `7f9d3226db8d5d76fa5cf59a7b7c99aa6ae48efe04dd1f4f3a2ff68b50c11ac7`；stdout SHA-256 `1da57f9a00d0cc2979c3cec18162a77bb64e4bf6e98d21ac4a7b5fc70e593bd3`。独立只读目录检查确认本次后台验收无残留 pg-*。这为当前版本补上一次成功的后台与正常清理证据，但不解释或抹除之前一次启动失败和一次超时。旧超时目录仍保留，已核无关联存活 node/postgres 进程，不能说旧目录已自动清理。

当前版本完整公开 CLI 的后台合成入口已完成构建和 READY，并成功执行一次真实本地登录、一次初始化 POST、两次初始化 GET 及两行静态预览；sendRequests=0、canApply/canSend/tokenIssued/externalWriteAttempted=false。原 CLI 使用其支持的 60 秒 TTL，自然到期 STOPPED→exit0、signal=null、invalid=false；sourceUnchanged/handoffRemoved/ownedPgDirectoriesAbsent 均 true，stdout SHA-256 `95fedfec051eec5e3200e1370038b6308010dbae7efbc0a643036f5866d75a79`，stderr 空。当前源码的完整后台试用和正常清理已有新证据，不再只是旧候选通过；这仍不追认先前失败、也不证明其唯一根因。

此前页面准备检查（后续已按上节获准使用内置浏览器）：Browser Use inventory 已恢复响应，但仅返回内置浏览器与 MCP Apps；显式请求 Chrome 标签页返回 `Browser is not available: chrome`。当时没有采取桌面输入或其他绕过，也没有打开新倒计时窗口。后台记录 `uiAcceptanceClaimed=false`；不能把后台初始化/预览算作页面验收。后来完成的内置浏览器实测仍不等同于正式固定 Chromium，发布阻断保留。

## 2026-10-14 新 CI 失败与最小本地修复

run `38422348395` 绑定 head `f77208bfcfa42cca86d1fde3606229aecd1985ba`，终态 failure。core 测试 1 文件失败 / 1183 文件通过 / 172 文件 skipped；3 测试失败 / 22940 通过 / 1752 skipped。失败均来自 `attendance-w6-group-effective-policy-authorization.test.ts` 对构造器 SAFE 清单的登记断言。后续 PLM 完整应用、外部系统真实库和宜搭 owner/browser 均 skipped，不得回填为成功，也不是这轮已重现 Chromium 故障。

最小修复仅该测试文件：新增三条精确 occurrence key、count=68、固定 hash `d4f6c884e8417a75c8ce7ed410c5a9ba5ca308d0b3717e181f94dba92cec04cc`，并新增三个负例。分类器、生产代码、权限与验收判定不变。修后测试文件 LF SHA-256：`d28af00e471c4191026704f374deff20b63dd3a775264ed0750f4f5327ea0202`。

在准确已发布 index（SHA-256 `51195cab0d27b5fb4a6352428f0945d1d5bd85f838be7c043b4871b8a9362fa2`）及既有隔离 Linux 副本上，使用真实 Vitest 运行 attendance 装配、approval shutdown、recovery wiring 三整文件，单 worker、无过滤、无 skip/todo：

| 运行 | 结果 | stdout SHA-256 |
| --- | --- | --- |
| 修前 | 133/136，三失败与 CI 一致，exit1 | `a83dc6889be8a7330e865e80c7cc1967cc6e150b83b3a25206aba3ac799fa4a9` |
| 修后 | 139/139，exit0 | `44edb596154a8fce59377bae1114aa523fce73d533fbc8b744d269e7e219d78c` |
| 删除一条 socket 登记的变异体 | 135/139，四失败且 UNKNOWN-empty 直接失败，exit1 | `2db8ed235616bd9a9cedcb4a78b60602d338d3be42a40685dbfeffb3f49d1bd5` |

三次执行均无 signal，原 Linux 测试文件已按原字节恢复。新增访问/重复访问变异负例均随整文件通过。此结果只关闭本地登记缺口，不证明全部 core suite 或完整后台/浏览器已通过；此前后台启动失败、超时与 Chromium 阻断继续保留。owner 随后明确授权本次修复及 MD 更新推入原草稿并运行既有合成 CI；提交前再次核对测试文件实际 LF 字节与上述哈希一致，CI 结果以新 head 对应的 GitHub run 为准，不预记全绿。

更新：2026-10-13。父提交：`8b75e155a41e4f8ea4e892e4c87d7f9572b8a5b8`。

## 准确候选

| 文件 | SHA-256（实际 LF bytes） |
| --- | --- |
| `packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts` | `14fa8e64a4ddac1257d20745158e3210984ee0927e63f445c5ee674fccc7061a` |
| `scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs` | `537729b1cfd5b78f84000876153b3085e2c722d7178733d5fefb62949176754e` |
| `packages/core-backend/src/index.ts` | `51195cab0d27b5fb4a6352428f0945d1d5bd85f838be7c043b4871b8a9362fa2` |
| `packages/core-backend/tests/unit/approval-completion-shutdown-lifecycle.test.ts` | `e328cbc6a70687b028df198c07297eeadef4a16288b26f1bc0e9ddd7a0c44341` |

之前准入的 13,758 个源码项已逐项与远端 Git blob 比对；原清单与远端差异恰好为已发布的两份诊断文件。新 Linux 副本基于该清单、两份已发布文件和上表四份补丁构建，不读取或复制 .env，不复用旧诊断目录。没有改动四文件以外的运行时代码。原 Windows 工作区和历史 Linux 证据保留。

## 准确发布候选重验

发布前已把 index 的 CRLF 工作副本规范为 LF，随后在新副本重验实际发布字节，不采用“哈希前归一化”方式放行。独立只读复核确认相对父提交仅 12 行 socket 逻辑，`release(error)` 保持远端版本；其他三文件仍为预期变更，无新增权限扩大。

- shutdown/recovery 两个整文件：23/23，failed/pending/todo 均 0，exit0。原测试 stdout SHA-256：`54f929a2c9427f1406cedcad3b79ea84cc60ff20944846bb551943611fabc1d3`。
- 后台验证首次在启动自有 PG 时返回固定 `PLM_FULL_APP_PG_START_FAILED`，尚未执行测试（result=null），不能记成 58 个测试失败或成功。失败日志仅核对固定标签和 SHA-256 `5af7679f3bbbef6f0d4609954a380cf6caa51ad75871ebc31a5596540540ed91`；随后只读确认该候选没有残留 pg-* 目录。不修改代码、配置或超时，单独重跑结果见下。

- 后台单独重跑：外层 240 秒超时，code=null / signal=SIGTERM，没有完整测试报告，不能宣称 58/58。stdout SHA-256 `624cb028d4bc128f007f53852a8a0e2a31c9d71fac1b144732d25796b8798b64`。该失败保留；网络/PID 命名空间退出，未手工删除保留的诊断/数据库目录，清理未证为成功。不把没有报告理解为产品断言通过或已定位根因。
- 试用契约：`node --test scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs`，11/11，exit0；stdout SHA-256 `89962f3f60cd910cc06e2c971376069196407658e68502f4390e099a61bd103b`。
- 完整 provenance：`node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`，exit0；stdout SHA-256 `f100c276587a34f70f4ea13506812da8b9ad5788bdb3ca0c655dc4f92f088a04`。未重打 pin、未改被 pin 的文件。

当前判断：可按 owner 明确授权推入原草稿并运行既有 CI，用于进一步验证；不是全绿、可合并或可发布裁决。新候选后台完整结果与清理证据仍阻断；不能用只差换行的前一轮成功代替本次失败。

## 历史本地证据（不等同于本次提交验收）

此前本地 index SHA 为 `601da1634a84eee10a1177772827ca5c24cf92fd47dde321d54a3e5d1c5336ab`，含本次已排除的连接释放差异。该旧候选记录：shutdown/recovery 23/23、后台三整文件 58/58、试用契约 11/11；原 CLI 完整后台链路及带预连接链路都 READY→STOPPED→exit0，清理自有 PG 和私有交接文件，源码后验通过。这些结果不冒充新候选的完整 CLI 结果。

真实 socket 测试在原未修实现为 9/10，修复为 10/10；去掉预连接清理的变异体为 9/10，错误清理活动请求的变异体为 9/10，各命中对应测试。测试没有依赖新增字段来制造基线失败。此前独立只读复核无 blocker，但旧候选完整预连接运行未记录关闭时点与最终 bytesRead，因此不能单凭该回执归因历史 Windows 超时；部分请求头专用用例也不是已完成证据。

## CI 与仍保留的阻断

旧 head 的正式 run `38349690929` 失败于 Chromium 完整应用 Automation 请求 ABORTED，后续 owner-browser 步骤 skipped。此前独立 owner 原步骤本地 61 契约/70 测试通过及 Firefox manual/interval 各九阶段通过，均不回填远端 skipped，也不解除 Chromium 发布阻断。

owner 已授权本次推送与既有合成 CI；结果须绑定新 head，并在 GitHub 上核实，不能预记成功。未新增 workflow、没有跳过失败、没有调整浏览器验收阈值。

## 权限与证据边界

仅合成数据、临时自有数据库、独立网络命名空间；无客户读取、真实宜搭发送、合并或部署。Chrome/Firefox 桌面自动操作曾因工具无法执行 URL 策略校验而停止，未通过其他渠道绕过；后台证明不是页面验收。公开材料只保留代码路径、固定状态和哈希，不上传私有日志、账号交接材料或凭据。
