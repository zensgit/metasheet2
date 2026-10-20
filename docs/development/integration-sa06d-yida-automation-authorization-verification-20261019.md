# SA-06D 有限委托授权：本地实施与验证记录

## 2026-10-20 本轮前置修复获准追加至既有草稿

Owner 已另行明确授权：将下节 **13 个修复文件及本 MD** 普通追加至现有草稿 #6337，并运行既有合成 CI。推送前核得远端仍为 `8f12ba5757f066b6e76693f8d895f4d3f5eaa1c1`，与本地父提交相同；不更换叠层 base、不强推、不新开 PR/切片。本次授权只覆盖这个已验补丁和既有合成 CI，不含合并、部署、客户数据读取或真实发送。下文“尚未获准/未推送”等表述保留为各次验证时点记录，不能误读为本轮状态。

本地通过仍分别是后端 328/328、浏览器登记 6/6、workflow 合同 35/35、provenance 1/1 及四组变异，不代签正式 CI。新 head 必须逐项核对前置测试、正式 Chromium/PLM、POST202/ABORTED、实际停止和清理、宜搭 71 项及后置 SQL；pending/skipped 不算通过，旧失败与风险全部保留。实际提交、run/head 与结果在后续本地续记，不预填成功。

## 2026-10-20 本轮 CI 前置失败：本地最小修复，不发布

本节对应 owner 最新授权：只在现有 #6337 内诊断、最小修复、本地合成与 MD；**不提交/推送、不重跑 CI、不合并/部署、不读取客户数据、不真实发送**。活动修复工作树为 `C:/Users/zen08/.codex/worktrees/sa06d-publish-20261020/metasheet`，代码基线/远端 head 均为 `8f12ba5757f066b6e76693f8d895f4d3f5eaa1c1`。下方发布授权与成功记录均为历史事件，不能作为本轮再发布授权或当前正式 CI 通过证据。

### 远端实际失败与边界

- Plugin System Tests `39364116468` attempt 1，按名字定位 `test (20.x)` job `118436849341`：core 前置 9 文件/9 测试失败，1200 文件/23936 测试通过，172 文件/1755 测试跳过。此计数属于原正式 CI，不与本地定向计数合并。PLM manual/interval、remaining-unknown、宜搭 71 项、checkpoint 与后置 SQL 均未执行，不能借历史成功解除正式门。
- 浏览器工作流 `39364014071` 的 ownership/collection 检查 6 项中 1 项失败：新增 `apps/web/src/services/integration/yidaAutomation.ts` 未进入该工作流的精确路径分类器。浏览器尚未运行，不是本轮捕获到 ABORTED。
- attendance 清理步骤实际是连接拒绝：前置 core 失败发生在 `Start Postgres` 之前，创建隔离 attendance 数据库的步骤也被跳过，但清理原为无条件 `always()`。它不是 PLM `host.stop` 失败。
- 公开失败日志仅按固定标签/计数/哈希读取。core 失败日志 SHA `e072e2a42686dd4e1a6f4299ddf303f2fd85cb31bbd56f8ed621c8dcd90d1869`；独立清理段 13 行，SHA `1bec59bdd4497630879104f827281610d396f8a01e1719623315ddcbb44ac85f`，固定分类 `connectionRefused=true`、`dropdbFailure=true`、exit 1。未读取私有 CI 产物或输出响应、参数、凭据及堆栈。

### 13 文件最小改动

本轮不改生产运行时、数据库迁移、权限默认值、超时预算或既有安全断言。改动仅为 10 个后端测试文件、两个已有 workflow 和一个已接入 CI 的 workflow 合同测试文件：

1. 五个历史迁移测试显式承认后来加入的 `integration_yida_send_authorized`，仍检查各自历史增量/回滚。现行完整枚举另在原 authoring suite 中检查：精确等于应用枚举加数据库既有 `notify` / `update_field` 两个历史值；并检查本次只比前序迁移增加一个 YiDa action、不得重复。不是给所有未来 action 开白名单。
2. 原 action drift guard 继续覆盖每个 action；仅 YiDa 使用已批准的 interval/slot 合法形状，另加 record-trigger 拒绝负例。
3. host AST 构造参数精确检查由 8 项更新为 9 项；原第八项读取 producer 断言保留，第九项必须逐参数转发给真正的 YiDa producer。
4. 生命周期变异 harness 显式处理新增 installed-binding 导入，工厂若被调用立即抛错；变异必须命中“提前停止”布尔断言，缺依赖等任意异常不再被算作成功杀死变异。
5. pre-JWT 清单精确补入 YiDa 的 no-store/JSON parser，另钉住管理 router 在 JWT 之后、错误处理中间件在 router 之后。没有把业务路由移到匿名面。
6. 浏览器分类器只增加上述一个具体服务文件，不使用宽泛匹配或跳过 ownership 检查。
7. attendance 创建步骤增加稳定 `id`；清理只排除 create outcome 为 absent/skipped，success/failure/cancelled 均仍清理，原 `dropdb` 命令和失败传播不变。合同测试读取实际 YAML，检查五类状态，并用 PATH 桩执行实际 bash 命令验证 argv/exit；**这不是一次真实 PG 删除或 GitHub Actions 调度器实跑**。

### 本地合成结果与证据归属

新建非 root 原生隔离候选目录，源自既有 `0353c681c75b73880689e537a47fe7eb44b9e8c7b21b8bc0f6c1f26f065381b7` 的 6781 文件冻结集合；补充测试所需 attendance 插件源码及 provenance 的三个原始输入，均不含 `.env`。生产源不改，13 个修复文件以 LF 精确投影。Node 网络/凭据读取守卫在父进程及每个 Vitest worker 加载，10 个 worker 回执齐全；仅实际测试自建的 localhost HTTP 连接 26 次，禁止连接/凭据读取均 0。**本次不是 Linux network namespace 证明，也不是宜搭完整应用重新验收。**

| 范围 | 修前/修后实际结果 | 说明 |
| --- | --- | --- |
| 后端 10 个整文件 | 325 项中 9 失败 → 328/328 通过 | 新增 3 项，0 pending/收集失败；原 30 秒 test /15 秒 hook，单 worker、0 retry |
| 浏览器 ownership/collection 原整文件 | 5/6 → 6/6 | 只验证 CI 分类/收集，不声称执行了页面或捕获 POST202 |
| 宜搭 workflow 原整文件 | 35/35 | 包含新增 2 项清理合同；0 skip/cancel |
| 原 package provenance | 1/1 | 补齐原始输入后通过；未重打 pin、未修改运行时字节 |

后端修前 stdout SHA `68e9cd289551ecbd509cd82d301f1e795314e3ac63ca215e7b923713085c4e62`，修后 `eedc70fde5e04ee2e4dbc447206f58e2401532b93794b15bf30c15070efc059d`；stderr 均 `5a80dd2a9d3a2979e5a118545211998186766ae7bdb74a2429d461e408affee2`。浏览器修后 stdout `aaaaf98615ed3e18e0ef7ca24eb3a322acfd56b11df671514c94f32732157248`，workflow `af47e1b36a9a76208ca541eddee8eb92a68c5b1af2a0bf42c84eded20e82bc77`，provenance `a2719a9714372ad3d4813763a31e28b3b66dd59617fc5bb30382993b51d62d1c`。

保留准备/候选失败：最初候选缺 attendance 插件源码、浏览器收集 harness 缺 pnpm PATH、provenance 候选缺三个原输入；补齐后分别重验，不把收集失败算业务失败或通过。新增枚举断言首次漏考虑两个数据库历史值，导致 327/328，已显式修正为完整集合；该失败回执亦保留。首次汇总脚本因 runner 路径错误在测试前退出，未产生有效验收结果，修正工具路径后才取得上述通过。早期只有父进程守卫的基线不能冒充逐 worker 隔离证明，最终基线/候选均补足 10 个 worker 回执。

四组整文件变异实跑完成，均在独立 owned 候选中精确改一个唯一命中点，`finally` 还原并校验原字节；没有改 Windows 工作树的生产文件：

| 变异 | 实际致红 | stdout SHA |
| --- | --- | --- |
| 删除最新迁移的 YiDa action | 328 项中仅新增完整枚举断言失败 | `38f8b227902a01a92902f00b7593924b121dbd35191df10b0de2c5a78c0f01f0` |
| 第九 producer 错接读取 producer | 328 项中仅 host 装配断言失败；第八项不动 | `a9e89db2afa034b008e16a55c793b00ce2454341d1798066bba108dc49323978` |
| 撤掉浏览器精确路径登记 | 6 项中 1 项失败，真实分类器未触发 | `1ad61f47f34a0f3e7ccf1aaff077e2f14bb62e3a2ed144a32ec750e3115a7497` |
| 清理恢复无条件 always | 35 项中 2 项失败，命中 create-outcome 合同 | `c59320d01ed179df2cd60686e520027dca2375831c789aa67e866e10b1acb67b` |

workflow 正控中另含“只在 create success 才清理”的内存变异，必须因 failure/cancelled 漏清理而致红。停止生命周期原变异也已随 328 项执行，其严格 `AssertionError/actual=true/expected=false` 断言通过；不把缺依赖或普通异常当变异证据。

最终独立回读结果：6781 个冻结文件中 6769 个未改、12 个为本轮测试/接线文件，另外一个浏览器 workflow 在冻结集合外；全部 13 个修复文件与 Windows 候选的 LF 字节一致，集合 SHA `46a262a1879dcca8617e028c60df9b1dd78c713cde882290f70eab2e5af36036`。运行时和迁移与原冻结源一致，变异目标全部还原；四个通过套件 stdout/stderr 共 8 个哈希与各自原日志相符。本地辅助工具及脱敏回执位于本次 owned 候选 `tmp/`，未提交；MD 不冒称这些工具已进入 CI。

续轮只读收口：再次核对 HEAD 和 13 个候选文件未漂移，实际解析原 `vitest.config.ts` 的默认 include / 完整 exclude（使用当前安装 Vitest defaults 与 glob matcher），10 个相关单元测试文件全部属于原默认收集集、0 被排除；核对 core package 的 `test: vitest` 与现有 core、宜搭 workflow 合同、浏览器 ownership 三处真实工作流命令，新增断言仍由原文件/原命令承载，无另建泳道或依赖临时 harness 才收集的问题。工具仅解析配置/命令，没有执行 GitHub Actions；Node 守卫禁止连接/凭据读取/允许连接均 0。这是收集与接线的静态补证，不代替整仓测试、实际 Actions 条件求值或正式 CI 成功。原始目标 MD 位于独立 `integration-goals` 工作树，未复制到本补丁、未缩减其目标，也未标整线完成。

本轮本地收尾通过，但整轮正式 CI 仍失败，未重跑或改变远端状态；ABORTED、实际 host.stop/PG 清理、宜搭 71 与后置 SQL 的正式同 head 证据仍未取得。这次没有重启完整应用或人工 Chrome 试用，没有启动数据库，更没有访问真实宜搭。原 90 秒 host 验收预算及所有生产安全断言均未修改，既有真实路径证明仍属于原冻结候选/历史运行。旧 SQL57014、250ms lease、WSL 回拨、90 秒窄裕量等风险不因本次前置修复被销账。下一道发布门需要另行获准后，把此本地补丁带入既有 #6337 并取得同 head 正式 CI 结果；当前不执行该动作。

## 2026-10-20 已获发布到草稿与既有合成 CI 的授权

Owner 已明确批准：先独立提交、推送 GOV-08 决策并开文档 PR，再将已验证补丁及 MD 以普通追加提交更新至现有草稿 #6337，运行既有合成 CI。独立决策已发布为 [PR #6462](https://github.com/zensgit/metasheet2/pull/6462)，文档提交 `0da3ee27f`；尚未合并。本代码提交仍以 #6337 当前远端 `e7305e65167bd512d814a88036cffd3462855c36` 为父提交，不改叠层 base、不强推、不新开功能 PR。

本地运行时冻结集合 `0353c681c75b73880689e537a47fe7eb44b9e8c7b21b8bc0f6c1f26f065381b7` 的 6781 个文件须与发布 Git 索引逐字节核对，记录须待实际核验通过才签收。下方“未推送/未触发 CI”均是各历史运行时点的事实；本节只更新授权与发布进度，不把本地证明改写为正式 CI。新 head CI 仍待运行，既有失败、窄裕量和类型检查风险全部保留。

本地合成初始化/推送预览已获本轮证明；真实宜搭 token 交换或发送不在本次批准范围内，仍需另行指定测试应用、表单与发送范围。禁止合并、部署、客户数据读取及真实发送。

发布前实际核验：隔离发布工作树 86 个暂存文件（含 3 份 MD，独立决策文件排除），全部 6781 个受验源的原始 Git 索引 blob SHA 与上述冻结集合一致，差异 0；原工作树固定 HEAD 与空索引未变。LF 原生受验副本执行原 `sealed-export-package-provenance.test.cjs` exit0；`git diff --cached --check` 通过。本轮只修复 MD 尾部空行并补授权/独立文档链接，没有修改已验运行时字节、预算或断言。此证据是提交前核对，不是新 head CI 通过。

## 2026-10-20 当前0353完整应用入口补验

接续原本地验收授权，相同0353候选按 manual → interval → remaining-unknown 顺序各运行一次既有完整CLI；原源、预算、断言、默认OFF、原生发送器的合成vendor边界均不改。运行前验证三份当前候选回执均不存在，6781源匹配当前Windows工作区、HEAD69140b8/index空。不是重跑远端CI，也不借65e旧回执。各入口终态如下逐项记录，未记录成功的入口不算通过。

manual 已实际九阶段通过并用原validators重审：478冷迁移/空重放，web-package types 0诊断，core/web构建字节与6781源核验一致；204条浏览器诊断中ABORTED0，原只读POST202的SDK BODY_DONE、代理UPSTREAM_COMPLETE、Playwright BODY_DONE各1。actual-stop-resolved与production-stop-verified各1，正常owned PG停止删除。真实登录/页面批准和请求→原共享worker/native sender的ACK/UNKNOWN链通过；fresh-consent有真实worker领取/原生未知查询正控，但新admission/snapshot/授权已用次数仍0，不能以新授权清除旧未知围栏。业务本体未写、externalSend=false，不称真实宜搭或业务验收。

manual 外层stdout SHA `7f338f630b1de418f62b9a324cd5ce9f431cd6e9e6a73f91bce368cac0b1ea99`，stderr空；完整内层证据SHA `875d66096a344b5bb04c51edf6d98b65f5213e0050dbda3fb363e523fcc12c61`。本节后续追加定时/余量入口终态；当前不把manual的页面证明或POST202计数借给其它入口。

interval 亦九阶段通过并按原validator/逐字段固定帧重审：478迁移/空重放、类型检查与构建/源字节同样通过；132条浏览器诊断ABORTED0，独立actual-stop-resolved/production-stop-verified各1、正常PG停止删除。真实JWT/规则HTTP/原scheduler自然产生2个occurrence与共享outbox请求，manual请求1拒绝/0接受；1个ACK、1个在途。实际host.stop使原生signal取消，停止在晚回包前保持pending且主pool未早关；晚到有效2xx不ACK，已用2次不退款、原请求仍admitted/串行围栏保留。此场景没有人工POST202，SDK/代理/Playwright对应计数为0，不借manual的body证据。externalSend=false、businessVerified=false。

interval 外层stdout SHA `ad0ed5324a6ebd4b06ba12a0186affd57f697de9de496bf2150b48c3c8537804`，stderr空；内层证据SHA `3e4d157b66636958b0a36469c196ed4d9b772aaa9168228f9ffa52264292137c`。余量入口仍单独取得终态后才记通过。

remaining-unknown 最后亦九阶段通过：实际解析当前workflow固定命令，命令SHA `45a0b4d40534937c08a9b3edc44eb2af3662f42082f80976bfa5dbeeabb85770`，不触发CI。478迁移/空重放、类型/构建/6781源复核通过；192条浏览器诊断ABORTED0，原只读POST202三层body完成各1，actual-stop-resolved/production-stop-verified各1，正常PG停止删除。两行/max2授权实际只用1次，剩1次时确实请求未用行并由原worker处理，仍只有1 admission/snapshot/ledger/token/form；未知历史和串行阻断不变，撤销不退款。原validator逐字段核验通过，未以授权耗尽解释拒绝。

remaining 外层stdout SHA `83fec8e457b02d91f7ebc3d6a5bbbb09e8f2286ed6426a5e650b70059c8b80b5`，stderr空；内层证据SHA `2d0e88cabe5dfd2dcb335d5f28dc502177b099a1c31a718aeefb97ca09c8db0f`。三个场景均为当前0353的一次真实原完整命令运行，没有筛选/重试/借旧source；每项运行之后分别执行 `tmp/audit-sa06d-current-full-app.mjs <owned-native> <0|1|2>`，调用原validators并绑定原结果/源及构建字节。结束后的本次source根目录进程检查为空；Windows全部6781源再次一致、index空。

本轮收敛：当前候选已取得host两轮原90秒32/32、三取消变异精确致红、五共享fixture整文件75/75、原宜搭71/71，以及三组原完整应用各九阶段/正常停止清理。计数分别属于各自范围，不合成一个“全仓通过数”。本节更新下方历史“0353尚未重跑完整应用”的状态，不销掉旧SQL具体语句未捕获、88.138秒窄裕量、旧WSL/租约风险及较大后端type-check根图诊断；本轮web-package types 0不能替代那个根图。未修改生产/测试源，未提交/推送/触发CI/开PR/合并/部署/客户读取/真实发送。当前没有活动合成环境或待观察后台进程；不再为已有本地通过而重复启动同一组合。整体交付及外部验证/发布门仍未获证，目标不标完成。

## 2026-10-20 当前候选原宜搭71：补齐隔离副本浏览器前置后验证

本次为相同0353冻结源补原五整文件71项证明，不修改生产/测试源码，不借65e旧结果。第一次实际启动在 `SOURCE_INTEGRITY/INTERNAL` 拒绝，exit1、未生成测试结果；stderr只有103字节固定启动诊断，SHA `8e7d8d03eff87a4b7d9522430ac31e435e1b77243ee910980a4bf5eb602e94f9`，stdout为空。不能称71失败或通过，也没有以重试覆盖原回执。

检查发现这个仅用于fixture回归的新隔离副本尚未预置固定浏览器：candidatePresentBefore=false。沿原完整应用wrapper的既有准备方式，从本机既有副本复制受审候选，复制前后均调用原 `pinnedBrowserForRoot`，SHA `43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925` 一致；没有下载/切换版本/环境路径覆盖或修改原守卫。此为本地验证环境准备缺项，不是产品权限放宽。

随后运行同一原CLI、同一参数/五文件/原15分钟launcher预算和30秒单例/hook预算，仍零筛选/重试；外层临时工具只增加 `browser-prepared` 回执后缀及绑定本次新增证据目录，避免覆盖启动失败或误用旧目录。审计需回读原失败哈希与新成功回执各自证据，不能挑一个绿目录就通过。当前结果以本节后续追加终态为准；未终结前不预签71或清理。无CI/推送/合并/部署/客户读取/真实发送。

终态：exit0、signal=null，原五整文件 **71/71＝66业务＋5哨兵**，零失败/跳过/重试/重复/未处理异常，原 task policy 校验器及 Vitest JSON 均通过。外层 stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr为空；实际内层 receipt SHA `e6a3db12fc6980fb348662bb259ae2daad389333a7675915a1ae88919d35f8b8` 与 namespace 输出绑定，owner/source/实际浏览器文件字节逐项复核成功。isolatedNetwork=true，cleanup=`stopped-owned-pg-removed`；限于本次owned source的进程元数据检查为空。6781源再核与Windows候选相同，HEAD/index未变。

这次补齐当前0353的原初始化/owner HTTP/浏览器71项来源归属；不再仅借旧65e的71通过。它**不是**新增SA-06D完整应用manual/interval/remaining-unknown三场景重跑，亦未在本节重新捕获整站POST202/ABORTED或production host.stop的诊断帧；那些已获证记录仍归原65e，不借本套PG清理等同整站停止。原启动拒绝、旧预算/SQL/type-check/WSL风险不销账。没有重新启动人工Chrome试用，没有触发远端CI或真实宜搭请求；不宣告完整目标或发布完成。

## 2026-10-20 共享 fixture 消费者补验：五个原整文件 75/75

在下节相同 `0353c681c75b73880689e537a47fe7eb44b9e8c7b21b8bc0f6c1f26f065381b7` 冻结源上，补齐两个已调整 fixture 的另外五个消费者。没有继续修改生产或测试源码。五套顺序执行，每套独立新建 owned PG、原完整文件、零筛选/重试；原 90 秒进程、15 秒单例/hook、网络/凭据读取守卫保留。不是把 host 32 项拆批，也不是重跑原宜搭 71 项。

| 原整文件 | 通过/总数 | 末项进度（秒） | stdout SHA-256 |
| --- | --- | --- | --- |
| installed-binding | 12/12 | 23.743 | `5bc9ea99f2229dd9e557ea5a11ca42484e5ee9bcf0f405b00494bf4375ac43e8` |
| execution | 22/22 | 42.703 | `6df55bde1d94ab08666aae2d2088aaa92afa8a28b960941b7153aafe715b3710` |
| send | 21/21 | 73.595 | `9da7cb35212fb659acbd806e7b730318e13dd17a7c348cad57a86ae90c533e62` |
| runtime | 11/11 | 25.024 | `208cfc4740f41316880f3a8df66f47c261f4a507f306d0ef942d4593ae54c5a1` |
| authoring | 9/9 | 25.663 | `abe3d469c21e853adbc4a0b7c6edd72b3c4f3c0e58a8eab8b4edd6e8ff31873e` |

各套均 completeReport=true，0 failed/pending/intentionalSkips，stderr 空；禁止连接/凭据文件读取计数 0，实际 PG 正常停止和删除均 true，源与工具运行前后字节相同。进度时间不包含外层准备/清理，75 含原隔离哨兵，不宣称 75 条纯业务断言。原 host 两轮32/32及三变异仍属于下节已完成运行，本次没有再次执行或增加其通过轮次。

本地 `tmp/run-sa06d-shared-fixture-regression.mjs <owned-native> <frozen> <installed|execution|send|runtime|authoring>` 复用原 namespace/runner/config；`tmp/audit-sa06d-shared-fixture-regression.mjs <owned-native>` 独立回读实际 stdout/stderr 与回执，核对哈希、完整计数、零跳过、隔离及实际清理，已 exit0。工具集合 SHA `cc15ebdd3e08cb2123447768d9c3cf091bd6093e5759a451a13bd079fe318b74`。Windows 再核全部6781源、HEAD69140b8及空index一致；结束后的限于本次 owned source 根目录的 `/proc` 元数据检查 processes=[]，未读取进程环境/命令行。

复用已授权的独立只读证据反驳代理，复核 wrapper/配置未发现跳过或不完整报告被签通过的路径；它未执行测试或读取私有原始日志，不代签实跑。证据边界：这五套按固定原文件及完整计数核验，没有逐标题将 reporter 结果再次绑定；工具集合只含列出的12个工具与 wrapper，不含所有共享依赖。实际共享 owned-PG helper 与当前冻结源对应文件的事后字节核对一致，SHA `37b430df4a9edc093d1f8839aeacd90d376088539e19f4a8916d01d501164677`；不把该事后核对冒称首次运行前完整依赖证明。

结论仅为本次 fixture 最小修复已补五套真实 PG 路径回归。host 首轮88.138秒的窄裕量、旧0c54未定位具体SQL的statement timeout、既有type-check诊断及历史风险保留。没有当前候选远端CI或新完整应用71项证据；未提交、推送、触发CI、合并、部署、读取客户数据或真实发送，整条交付目标未宣告完成。

## 2026-10-20 整文件 90 秒：累计成本定位与最小测试准备修复

本节接续 owner 的本地修复授权，不能被下方历史候选的通过数替代。本轮不修改生产代码、迁移内容、全局默认或 CI；只调整两个测试 fixture 的初始化事务，以及 host 测试中两例未使用即销毁的单行 fixture。原 90 秒进程、15 秒单例/hook、5 秒 SQL 限制全部保留，没有减少 32 个用例或任何业务/安全断言。没有共享授权/fixture、缓存加密结果、替换 SQL 结果、改变系统时间或暂停同步服务。

### 观测与范围

原 65e 全文件的分段进度持续增加、超时所在用例随运行变化；两条撤销用例的 TOKEN/COMMIT/REVOKED/INSPECT 均完成。一次原源穿透计时运行在 90 秒终止前完成 23 项，累计 DDL 216 次/24.064 秒、其它查询 34064 次/34.640 秒、事务类 866 次/4.427 秒、原 PBKDF2 1220 次/17.701 秒。此为累计成本证据，不是某条 SQL 死锁或唯一环境根因证明；并行调用的累计耗时不可直接相加成总墙钟时间。探针只调用原方法、保留实参/返回值，不输出 SQL/材料；最终验证已撤掉 PG/crypto 穿透探针，原隔离守卫保留。

修复范围：

- execution fixture 在新随机私有 schema 内，用一个真实事务执行原 outbox 及八份迁移/seed，提交后才生成原加密材料与暴露 fixture；实际运行的 BEGIN/COMMIT/ROLLBACK、原 COMMIT gate/loss 注入、最大连接数不变。
- installed fixture 在另一个真实初始化事务中保留原 schema/迁移/registry/逐字段 INSERT 与每行 epoch 触发器，提交后原 read runtime 激活。没有批量绕过触发器。明确的测试准备语义变化：`DEFAULT now()` 的 seed 时间戳现在同属初始化事务起点；revision 仍逐行随机更新，运行 lease 仍由原时钟/事务证明。
- host 两条双行用例由原标题常量精确选择初始两行数据，不再先建立再销毁一套未受测单行 fixture。每例仍独立随机 schema/完整迁移/真实 crypto/原 host 与 registry；原两行/max2、ACK、UNKNOWN、余量、不退款及账本不变断言全部保留。选择失配会被原两行断言拒绝。

Astra ultra 复用原只读反驳代理复核，未发现上述源码改动绕开初始化、触发器、runtime 事务或断言。它没有运行测试，不代签本节实跑；它亦明确取消 SQL 用例走 port.create，不启动 adapter 的 10 秒 timer，不能凭约 10 秒耗时删掉该等待或原 20ms“不早退”断言。

### 保留的定位失败

| 候选 / 对照 | 实际结果 | 外层 stdout SHA-256 |
| --- | --- | --- |
| 原 65e，crypto 穿透计时 | 24 完成、8 未完成，90s SIGTERM | `fdddf0e1c57c41a80047319e2c55d97eccfdf87a08ae65b35e8d24f0d9ed06fb` |
| 原 65e，PG＋crypto 计时 | 23 完成、9 未完成，90s SIGTERM | `393a0170649f481381acddcee35a21cf7f87624ae3ee48cd6e9261b19a5e35c9` |
| 12e，仅 execution 初始化分组 | 29 完成、3 未完成，90s SIGTERM | `1f18e6360bf9530c41224b161ffb70acd9cd9753cd4da674a68501f9982a021e` |
| 0c54，两 fixture 分组，仍带计时 | 28 完成、4 未完成，90s SIGTERM | `3c1b7c715ad701a5dcb20d087f1c63b006e9179f2380d374e900114600cdd4d0` |
| 0c54，撤掉 PG/crypto 计时 | 完整报告：31 pass、1 fail、0 pending；末项进度 89.048s | `93f11eae1b169660cf8c1c89802d29718d747599e6dc860a781984cde9e61ffb` |

最后一条失败是原 inspection/revocation 用例的 `statementTimeout=true`，不是通过或整文件 SIGTERM；原报告消息 SHA `de91f95a2899f946a7ac7503c63fc84350f2687b11bc8561b2f5ba3faaa0abd4`。尚未捕获具体 SQL，不把它归因于某条生产语句、时钟或去重逻辑。上述各轮源/工具未漂移，实际停止/owned PG 删除均通过。所有原失败与本地 WSL 风险继续保留。

当前候选 sourceSet `0353c681c75b73880689e537a47fe7eb44b9e8c7b21b8bc0f6c1f26f065381b7`，archive `3fb47f312089a313ed1d5836ac37f512fb5ec901192ff751f1cfd0802fca701c`，6781 源，固定 HEAD69140b8、空 index。完整报告/后续复核以下方本节追加结果为准；不预签仍在运行的测试。旧 65e 的完整应用 manual/interval/remaining-unknown 与原 71 项保持原 sourceSet 归属，不能改称当前候选已重跑全应用或远端 CI。

0353 当前源首轮单进程整文件 **32/32、0 failed/pending、0 intentionalSkips**，原剩余行 UNKNOWN 计数、源/工具字节、隔离守卫和实际停止/PG 删除全部通过；stdout SHA `34d5501c6560a81ebfc9b7f90a65364924542baaf6a75f34f21af1024e112104`，stderr 空。末项完成进度 88.138s（reporter 单调时钟，不冒称包含外层准备/清理总时长），已很靠近 90 秒预算，不能凭一次通过承诺稳定裕量。确认轮使用同一冻结源码、同一原 runner、另一全新 owned PG；仅本地外层回执增加 confirm 文件名防止覆盖原结果，不改变测试筛选/预算/守卫。

确认轮同样 **32/32、0 failed/pending/intentionalSkips**，末项完成进度 81.248s，stdout SHA `934e527dc1c19352c95c7953fdc7cbdfe3a87f9f6ff8ef671f450bc81e207590`，stderr 空；两个 waiter 的全部撤销阶段完成、原 UNKNOWN 计数不变、禁止 IO/凭据读取0、实际停止/PG 删除成功。两轮是各自一次完整单进程原文件，不是分批并集。6781 源清单逐路径比对旧 65e：0新增/删除、仅上述三个测试文件变化，6778个其余文件逐字节相同；固定 HEAD/空 index 与当前 Windows 字节另独立复核通过。

本轮闭合的是“保留预算和全部断言的局部准备修复已有两次完整通过”，不是历史所有时序根因已解：旧 0c54 statement timeout 的具体 SQL 仍未捕获；本机负载/WSL 风险、首轮不足两秒裕量和未运行新 CI 必须保留。不能用这两次通过代替正式发布门或承诺未来不再超时。

三组取消变异在当前 0353 源重新执行及严格审计通过：每组仅选原 5 项，明确 27 项未选，不冒称全文件变异。分别 3/1/1 条精确 native signal 布尔 AssertionError，原 JSON 消息与 reporter 类型/消息 SHA 交叉绑定，全部撤销阶段完成；没有 hook/超时/TypeError 代替目标失败。两次完整32的逐标题 SHA 清单亦核验一致、0未执行。所有变异仅内存生效，源未落盘修改，停止/PG删除成功，capturedStackLocation=false。

| 当前变异 | 原报告 SHA-256 | 外层 stdout SHA-256 |
| --- | --- | --- |
| 去掉已知 COMMIT 后通知 | `5e9e69d36ccd8d976d2a373ed7b67db5d5fa3539b955f5aea4a6dee58c449394` | `1ed74d292e361cc289d38898aca45b6be891b9dd1e20bfa1c48697375e7c67e5` |
| 通知移至 waiter 检查之后 | `0eda24617671e6e12c24ef7e829a6ad706cef1d8b4f85f78707ec5479e1a6d0b` | `d69475eca5ad070c7324a151f3dfbfaa4950cda7186dc2d6d03277ed28ed7d28` |
| 去掉真实 grantId 匹配 | `b57cbd8156511c628043ca8146251a2d035d3f4bc58fca7896fb8a7c86ca6899` | `73881b0c899e6e7aaf585d2f3196f6129c40bb38dba1fdb517b463d05d1cb199` |

复现入口为既有本地 `tmp/run-sa06d-native-host-current.mjs`，传当前 frozen/native 候选及 `baseline`、`baseline confirm`，后者只分开回执文件名；三变异 mode 为 `host-revoke-notify/waiter/grant`。`tmp/audit-sa06d-revoke-mutations.mjs <owned-native> whole` 同时拒绝非两次完整32覆盖、非精确布尔失败、源/报告不一致或清理缺失。工具留本机 tmp，不作为生产入口或对外 CI 成功证明。所有本轮合成测试已终结，未留活动试用服务；未推送、触发 CI、合并、部署、客户读取或真实宜搭发送。

最后重跑原 strict/noEmit 的 installed-tests 根图：本轮三个测试文件无诊断，较大根图仍返回 exit1，保留原 automation-executor 两条（2345/18048）、automation-service 一条（7022）与其它依赖51条；未 emit，不宣称完整 backend type-check 通过。该图历史已有问题未在本次预算修复中扩范围修改。

## 2026-10-20 撤销取消接线：本地修复与功能回归完成，整文件预算风险未闭合

当前冻结 sourceSet `65e3f70576a0435e14ba19eabad69e967c2598db7170c337565e0b1df1f1d3c1`，archive `8b1598a02d713874d4230b05b046f0a0f43095308382122cf6bcd30b848302da`。与 c056 的 6781 源逐项比对，恰好只改 production host 和同一 host 测试文件，0 新增/删除源；三份既有 MD 另续记。Windows 当前字节、固定 HEAD/空 index 及冻结 archive/native 字节均核验；后续 native 准备使用已有 snapshot-only 选项避免重复跨文件系统读取，**不借该选项声称又做了跨挂载原工作源核验**，原工作源独立由 Windows 逐项检查。

保留中间验证：3aa817 诊断候选曾整文件 **32/32、0失败/未完成**，实际 PG 正常停止删除，stdout SHA `bc8b4cb386e323621ff08b7202a92fe10036b9f35e2a42de150fcb6aa3abf226`。当前 65e 仅再修 TOKEN 探针位置并补闭合枚举诊断，没有再改生产；其单进程首轮在原 90 秒预算内完成 27 项、5 pending、SIGTERM（stdout SHA `655f6754d62d7abf75eec6c9eec017a77feee45ee92bd19921542f138886aeac`），正常 PG 清理通过。不把第二次失败藏掉，也不宣称唯一资源根因或已修单进程时序风险。

随后本地临时 runner 将原文件固定分为原 28 项（含哨兵）和新增 4 项＋同一哨兵的 5 项两批，逐项标题 SHA 的并集必须恰为 32、只重叠一哨兵、未执行并集为 0；每批仍是原 90 秒进程/15 秒单例预算，生产预算和原断言均不改。三种业务变异只执行后者，明确 27 项有意未选，不能说完整 32 项变异验收。分批首轮真实 5 项已执行，但该 Vitest JSON reporter 汇总把筛掉的用例算入 passed，临时工具按旧汇总口径拒绝签证（stdout SHA `d861406f366b20e9fe013b054d4285e627a60f4c6765f4c873ae5b6847215f02`）；后续改按原始逐 assertion 的 passed/failed/skipped 校验，不将 32 的假汇总用作通过数。

独立证据反驳还发现原变异 wrapper 只按失败标题计数，可能接受目标测试内的超时。最终审计要求 stdout/report SHA 绑定、唯一目标标题和唯一精确 native signal 布尔失败消息，并以自定义 reporter 的真实 `AssertionError` 类型和消息 SHA 与原 JSON assertion 对接；各等待阶段完成，拒绝超时/TypeError/hook/probe 失败，实际停止/PG 删除仍为必要条件。审计首版期待 JSON 自带错误类型前缀和 stack 而拒签；实际 JSON 只有消息，随后才改为上述类型/消息哈希交叉绑定。**capturedStackLocation=false：静态源码断言映射不是捕获到的失败栈行。** 审查者只确认工具源码，不代签作者实际运行。

当前 65e 的固定分批与严格审计已完成：原 28 项全过、新增四项＋同一隔离哨兵 5 项全过；逐标题 SHA 并集 **32 项执行，重叠一哨兵，0 漏项**。这不是单进程 32/32，原单进程 90 秒失败继续保留。两批 stdout SHA 分别为 `17b8cfd0dec124fda546dd899c2b80057fbf42de85cee6d98a311c60dd9e96d6`、`ac432f467f45ad7cebd1edc81679b52cc593014226e420834e8b7c10019e183b`；源与工具前后字节不变、禁止 IO/读取计数 0、正常 PG 停止删除。

三种内存生产变异均以同一 5 项（27 项明确未选）运行，最终独立审计脚本 exit0、各等待阶段完成，失败均为精确 signal 布尔 AssertionError，不是超时替代：

| 变异 | 实际通过/断言失败 | 原报告 SHA-256 |
| --- | --- | --- |
| 去掉已知 COMMIT 后取消通知 | 2 / 3 | `974c593249cc7d5019d9145ff26b7f0c317fc9d547e90781fb0791ee2bf9607a` |
| 把通知放到 HTTP waiter 取消检查之后 | 4 / 1 | `00bcf20782b2dfbdd42fe5bca6151cd42c30f8e470626f173857d8e5099c4655` |
| 去掉实际 grantId 匹配 | 4 / 1 | `57f27dfd4bf388dd41af7a7305ee89626dab3c74baf5a5bbebf267cdf4551c0f` |

三份外层 stdout SHA 依次为 `5906e0369a6dd0a2f4710f2fbfeef77ab6bda3f7069b9f29dd3f99cb4b4b9c93`、`3ac099f0d2c8667a110fdb781b580c59f0af3a097259637f866db08df1f2a2a4`、`512e29666b7f9ca40c40608beb5ef1c47b20fea36b28044ef7bd494d81ff5acd`。源未被变异落盘，正常停止/PG 删除与原隔离守卫均通过。此变异证据不扩张为完整主应用变异或全部 scope 条件逐个变异。独立反驳者对最终类型/消息哈希绑定及 `capturedStackLocation:false` 再次只读复核，确认原 P2 已在工具源码层关闭、无新增阻断；未运行工具或读取私有原始产物，故不冒称它独立复算了这些结果。

同源完整主应用 manual 九阶段已通过并复核：478 冷迁移/空重放、真实密码 JWT/页面批准与请求、原共享 worker/native sender、fresh-consent 未知围栏、全部 6781 源/core/web 构建字节均通过。192 browser frames、ABORTED0、原只读 POST202 的 SDK/PROXY/PLAYWRIGHT body 完成各1、actual-stop-resolved1/production-stop-verified1/正常 PG 删除。stdout SHA `8dcbbb9b91e0ec06bd10c54d181bfab4b0b13d968dbb5c79f1c0f7ccc52763d7`，evidence SHA `3e801c25d49d7fa3356eb127e070bade4a40d593918d424c44edac743c1f068c`。

同源 interval 自然调度九阶段与只读复核亦通过：真实密码 JWT/规则创建、interval-only 授权、原 scheduler 自然请求2、手工请求403、两 occurrence/phase anchor、原共享 outbox/consumer 各2。第一行 ACK、第二行 native form 在途；实际 host.stop 等待晚有效回包，不提前完成、不晚记 ACK，第二行保持 dispatching 未决和串行占位、used2/max2、不退款。132 browser frames、ABORTED0、actual-stop-resolved1/production-stop-verified1及正常 PG 删除，478冷迁移/空重放和全部源/core-web构建字节均复核。interval 不执行只读 manual POST202，对应三层计数真实为0，不借 manual 填数。stdout SHA `a15f13ecdf002f7bc15f1e4f2ea5c5194013756cd2882e47a752d91ad2609448`，evidence SHA `daba59eb0df11535caf5cdd8aa42cac7654c289855f80d739ad6980af2f31689`。

同源 remaining-unknown 九阶段亦已通过及复核；仍从当前 workflow 原字段解析实际 argv（命令 SHA `45a0b4d40534937c08a9b3edc44eb2af3662f42082f80976bfa5dbeeabb85770`），不是手抄近似入口或远端 CI。真实 JWT/原规则/共享 worker/native sender：第一条 UNKNOWN 后 used1/max2、第二条原批准行 HTTP 请求及 worker retry1 完成，但 ledger/admission/snapshot/token/form 均仍1，原未知全账本不变、串行占位、撤销不退款、业务快照不变、flags 恢复OFF。216 browser frames、ABORTED0、原只读 POST202 三层 body 各1、actual-stop-resolved1/production-stop-verified1/正常 PG 删除；原 validators、478冷迁移/空重放、6781源/core-web构建字节均通过。stdout SHA `2238173ea4d5850c87d30c2fa6042f0087b51ac4dd07ca032bbf71dcb1038149`，evidence SHA `75a22c7f39c5f9ef06b5eb7db9c722dfae4e5ff64a044bc5f65b86e3443f3d4d`。此 Node HTTP 负例不冒称页面批准正例；页面正例由同源 manual 另证。

同源原宜搭 **71/71（66业务＋5隔离哨兵）** 已执行及只读复核，0 failed/pending/todo。原 task validator、逐项报告、owner/source/task/namespace 及隔离网络回执全部匹配，正常停止并删除 owned PG。stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr 空，当前原回执 SHA `7138e6056cc87d7ab69a36bbbade9badc35e92ba39e9a3ae9de1899dc6001419`。stdout 与历史 run 相同不等于复用旧证据，本次 owner/源/task/回执均重新核验；原71不代签新增 SA-06D 浏览器授权（该证明来自上述同源 manual）。

三全应用与71均退出并正常清理后，另做**一次无这些构建/验收并行的原90秒整文件对照**，仍 SIGTERM：24 completed/pass、0已报告失败、8未完成，完整 JSON 报告缺失，不能记成全过。stdout SHA `2e37067a325262e40bc2d328a8b677f74a4b2682d901ea393eb1da4b77c2d894`，stderr 空，源/工具不变、实际停止/owned PG 删除均成功。只读闭合帧核验显示两个 COMMIT/waiter 用例的 TOKEN/COMMIT/REVOKED/INSPECT 均完成；最后报告的用例静态映射到测试文件 L396（other grant / denied scope / rollback），beforeEachFailed=false、afterEachFailed=null。这只界定最后观测位置，不证明在该行死锁或生产缺陷，且**不能再把超时唯一归因于其它构建竞争**。没有提高预算、自动反复重跑至绿或借分批/历史3aa32通过抹掉该失败。整文件运行稳定性与累计预算成因仍未定位；本轮不改共享 fixture/全局 timeout 以扩张最小修复范围。

本轮全部启动的合成应用/测试已终结，对应 owned PG 正常停止删除；保留脱敏回执及本机合成诊断，不留下活动试用环境。功能/取消守卫由当前源分批32、三变异、三主应用及71分别证明；**当前原90秒整文件没有通过，远端 CI 未运行，不能签全线交付或发布资格**。

Owner 授权后直接处理独立只读反驳的 P2，不新增切片。生产修改仅在 `yida-automation-management-host.ts`：按真实 DB grantId/可信 tenant、owner、workspace 登记本机 controller，已知 COMMIT 后通知匹配运行，通知先于 HTTP waiter 的最终取消检查；回滚不通知，运行 drain 完成后移除登记。原预算、完整性守卫、默认 OFF、原 sender、持久未知和不退款规则不变。Astra ultra 对该补丁独立只读复核未发现新增阻断；它未运行测试，不代签以下执行结果。

新增四例经过真实安装 read runtime、管理 host、PostgreSQL 事务、原 native token/form client/账本，远端 fetch 仅为合成边界。两例用原 provider COMMIT gate 分别验证正常与 waiter 断开；另两例验证不同 grant/错误主体/回滚不取消，以及在途 form 的晚有效回执不 ACK。此处的 waiter 是 port AbortController，不冒称真实 TCP 断连。

首候选 sourceSet `fb101e154cf2bc61ecaf9a4df56b456ca0c785c2c4480f7d60669d6b1e81fc5b`（6781 源）真实 host baseline 在原 90 秒进程预算内未完成：21 passed、0 failed、11 pending，SIGTERM，完整报告缺失；不能称 32 项通过。实际 PG 已正常停止删除，工作源不变。stdout SHA `1a5997a7f348f4955e885d34b8f265de117a7473f3aaecfa8a496a7c2e14de0a`，stderr 空。最后完成的是旧 unknown/fresh-consent 用例，不能仅凭此把后续等待归因于生产取消代码。后续仅在测试加固定等待阶段诊断，未放宽 90 秒进程或 15 秒单例预算。

同一 fb101 源的原完整主应用 manual 九阶段实际通过并复核：478 冷迁移与空重放、真实密码 JWT/页面批准及请求、原共享 worker/native sender、fresh-consent 未知围栏、源与 core/web 构建字节全部获证。216 browser frames、ABORTED0、原只读 POST202 三层 body 完成各 1、actual-stop-resolved1、production-stop-verified1，owned PG 正常删除。stdout SHA `7c94a76808519efe5331454da70e5a37de9f52ab09058120662a872e6625ad65`、evidence SHA `64b6ab910b676027b6cbc81fdc9519ca90b0180b424b5d3171c3e39c2a09794b`；这不替代未完成的新增在途撤销负例或新诊断测试源。

定向 strict/noEmit 检查本轮 host 与测试无诊断；所选较大根图仍有 3 条 automation-executor/service 诊断（2345、18048、7022）及 51 条其它依赖诊断，不宣称完整 backend type-check 通过。COMMIT 回执丢失的 revoke 未新增实跑证据，也不承诺未知提交即时通知；后续持久守卫仍执行、幂等重试可补通知。未推送、CI、合并、部署、客户读取或真实发送；历史风险保留，完整目标未完成。

日期：2026-10-19（Asia/Singapore，历史授权记录）。Owner 已同意[方案 A（后独立发布为 #6462）](https://github.com/zensgit/metasheet2/pull/6462)，允许本地实施、真实路径合成测试及变异验证。当时禁止推送/CI/合并/部署/客户读取/真实发送；后续范围以文首 2026-10-20 明确授权为准。本文不替代独立审查，也不代表整个 SA-06D 完成。

## 当前候选 c056：既有 UNKNOWN 场景接入现有验收 job（仅本地）

继续检查原目标的证据接线，发现已存在且本地通过的 `--yida-case=remaining-unknown` 没有进入 `plugin-tests.yml`。本轮仅在原 Node20 `test` job 增加一个新 owned fixture 的完整场景步骤，位于原 manual/interval 之后、原 owner 宜搭 71 之前；不新增 job/trigger、不改原两命令/20 分钟步骤预算/150 分钟 job 预算、不打开默认、不扩大凭据环境。新增单场景步骤固定 10 分钟，原 CLI 内部各阶段和 300 秒 probe 预算不变。其命令由既有公开 CLI 执行，namespace owner 中的严格 case 和全部原验收门保留，不能用两行均已发送的 manual fixture 假证剩余额度围栏。

扩展原工作流契约：要求本步骤唯一、Node20、精确命令、无 env/替身 action/shell/working-directory/continue-on-error、10 分钟预算且顺序正确。删除步骤、换普通 manual、echo/`|| true`、跳 Node20、提高预算、注入自动开关和前移/后移等输入变异都须拒绝。浏览器调用契约从“三处 selector”更新为**原两条 PLM＋新的 UNKNOWN＋原 owner 宜搭四处逐项精确核验**，未把精确计数换宽松匹配；旧九条 install/invocation guard 删除自证保留。

当前冻结 6781 源 sourceSet SHA `c056a21b53a0878190d78aa825802075eb1d007a1c5c5023dfb694f45cad7f35`、archive SHA `f3dc9c367cc67d35536ab9c454328403eb2aa56ef58efe0035ffc7e63f091565`；当前 Windows 源/固定 HEAD/空 index 与新 native 副本均核验，不含 `.env`。本轮相对 8dd0 只改工作流与两个原契约文件，未改生产 sender/权限/存储/调度实现。

当前 native 副本按实际原 CI 调用方三文件运行 **382/382**，另按原 owner 步骤两份契约运行 **69/69**，均 0 fail/cancel/skip/todo、源前后不变。stdout SHA 分别为 `15a7841a5036fbee3daf2fbad028a6203564ca29d85a8688916eca7af71b62ab`、`9469a4a016307e033f0ff9c9c501cf36c406832842d29bbe4e90bbc00a06c286`，stderr 均空。当前登记/status 两整文件又在同 native 副本 **69/69**，guard 禁止连接/读取 0，stdout SHA `3c2df3eeb0489657f5e6de4ef20022d798bc5dc23b482ac758c983e85916415c`；这两种 69 是不同测试，不能混用。原 provenance 再执行 exit0，stdout SHA `f100c276587a34f70f4ea13506812da8b9ad5788bdb3ca0c655dc4f92f088a04`，未重打未变 pin。

真实 caller 组合不是手抄近似 argv：临时 driver 以原 YAML parser 从冻结 workflow 提取该唯一步骤，检查精确字段，再无 shell 地执行其实际 argv，固定命令 SHA `45a0b4d40534937c08a9b3edc44eb2af3662f42082f80976bfa5dbeeabb85770`。**当前 c056 九阶段及只读复核已通过**：stdout SHA `ddf5e3d8d725ffa1705e63be0b047c775f4cbedcd06ff026ec0628ebc2a86bf9`、stderr 空，evidence SHA `9b96079c8c1dd49079d679ab858b4aa1a9935ff87f902b244d8daf6b48f3144e`；类型 0、478 冷迁移与空重放、6781 源及 core/web 构建字节、全部原 validator 和新 case 强制门均核验。真实 JWT/规则/安装 host/共享 worker/native sender：retry1、used1/max2、ledger/admission/snapshot/token/form 各1，原未知全账本不变、第二批准行无 admission、真实撤销不退款、flags 恢复 OFF、业务快照不变。204 browser frames/ABORTED0，原只读 POST202 三层 body 各1，actual-stop-resolved1/production-stop-verified1/正常 PG 删除均通过。不是新页面批准正例，也不是一次远端 GitHub CI。

此外以原 YAML parser 比较 b05/c056 的实际 workflow，内存仅移除该唯一新步骤后，**其余整份文档 deepEqual**：原步骤、所有 job/trigger/env/既有 timeout/default 等完全相同。原 workflow SHA `8a66efc77e0a4af40a63564a17914e2de4435e0732cb77a327827d6f22d3dc98`、新 SHA `679a844aa5df130e5c3da8186ca743a58a61ae619d8867ad5c72dc7218916963`。该只读比对首条 shell 引号不合法在解析前 SyntaxError，未执行任何比对/写入；改为无歧义字面量后才取得上述结果。先前 ebc1 的相同命令亦已独立通过（stdout SHA `f50815d459eb8e0bf3e8c8a99373d3c5d76ac64b6d715fc2cb811a482c0804da`、evidence SHA `1d4829509b65beda40e5c8a81e8f02ab092fff48573f97e71ca94068155d213d`，192 browser frames），历史来源仍分别保留，不借它代签当前。

保留失败：ebc1 的原契约首轮 **357/358**，唯一旧内存变异自检缺两个新常量 binding，stdout SHA `d566b7c4467c88ece6ba978469cd109f39a33f767a99285334a1c5707f97e74c`；只补绑定，不删九条自证。直接在挂载工作源运行原 caller pack **329/370**、owner pack **53/69**，stdout SHA `a714e8bd420b165a7ecb3b09027c0a9e4329b77d8c95ff53e298a6b33e2485e9` / `f91115a4a31d733fdb1ca252058e31a4b053daac098450675d59d13493a1b331`，均 exit1，保留原流，不预断全部唯一根因或靠改守卫洗绿。dcfd 冻结 native 对照 caller pack 382/382，owner pack 68/69（stdout SHA `fdcb8b9b1efa455ef35cf547273dfc5668bbbb7f1ab05e47d5fa87b55caeb50b`），后者原“三处 selector”与新增第四处确实不一致，才补精确四处；当前 c056 两 pack 终态如上，不借对照绿代签挂载失败。

覆盖边界：本次只接已获真实主应用证据的独立场景。默认 Vitest 配置排除的十个 SA-06D opt-in 真库整文件仍保持，防无 owned PG 时误收集；这个新增步骤不冒称已逐一运行那十个文件或代替其本地真实 PG/变异证据。当前未派独立代理、未提交/推送/运行远端 CI/合并/部署/读取客户或真实发送，完整目标 active。

## 前一候选 8dd0：原目标横向审计与登记说明纠偏（仅本地）

上一轮已完成 b05 同源整链，不是等待或无进展。本轮继续按原目标 §2/§4–6/§11.1–11.6 核查，没有把整个目标缩成 SA-06D 测试全绿。当前仍固定 HEAD `69140b86619e8fa9c1bf6da9bca5af731c8f5000`、index 空；新冻结 6781 源 sourceSet SHA `8dd0ca693cf94b766adbb27a7042874944d8dd545895fbf344e376103bc04f8b`，archive SHA `698f388ba906d3f0ba513f7b3b49ad8ed22be55f6b38cde437a0e42941423251`，不含 `.env`，Windows 实际字节复核通过。

发现并修正一个真实交付信息缺口：`global-history-flag-manifest.mjs` 的 SA-06D purpose 仍称本候选未注册 token/form sender、未来才检查 IO，已与当前安装宿主/共享 worker/原 native sender 接线不符。仅改该说明为当前事实及停止/未决/不退款限制，增加两个登记测试；**未改开关默认、激活值、依赖、危险等级、授权门或发送实现**。原 b05 与当前 manifest 实际模块导出逐项比较，只有这一条 purpose 变化；原始源也精确等于一次 purpose 替换，九个激活输入的结果与旧模块相同。两份冻结清单完整校验后仅两文件不同：manifest 与其测试，0 新增/删除，其余 6779 文件原字节相等。

当前 manifest/status 两整文件 **69/69**，0 fail/cancel/skip/todo、三份 Node guard 观测均连接与禁止读取 0，stdout SHA `b05dce4f2b33fc8f3e70978d5a0fb53999a828883683ee98b2c09431e58da83f`。首轮 68/69 的失败保留（stdout SHA `64e0329775db458feea319bed291711246b3131d4192107087fe7f3ba1ceaad8`）：新增测试误将状态工具 `isActivated` 的 typed-input 格式化合同当作生产授权；该共享展示 helper 会 String(true)，不是 live authority。仅修测试假设，公共 helper 及生产门均未改；生产 literal 检查仍以既有真实执行测试为证，不能用此状态工具代签。

内存仅恢复旧 purpose、保持所有函数/元数据与磁盘源不变后，原两整文件 **68 过/唯一新增说明用例失败**，真实 exit1、0 cancel/skip/todo；其余新旧测试仍过，禁止连接/读取 0。stdout SHA `13a9c3a99b3bfcda637990354eabaf7682c4ee4116806257d7cee86be04f7078`，目标 title SHA `616a5e86c37ca7680908676ac8079b871465cb7956ac7371605f7684575acd30`。这是登记说明防回退变异，不是发送安全守卫或独立人员审查。

本轮还补齐以下**实际运行**的原目标横向证据；它们执行于 b05 的原生副本/工作源，随后仅有上述说明与测试二文件变化，不把 b05 全应用改写为 8dd0 全应用已重跑：

- 原有隔离 runner 的 extended **53/53 套插件脚本**：PLM BOM/read-plan、K3 B4/POST/响应/重定向/永久写围栏、宜搭静态计划/token/账本/原 sender/观察等；stdout SHA `9ae8f88486ed40497c778b22738c8c1b52d2cc3c77ea7e7ab73cc0edddc54ead`。每套 exit0、未超时、源不变、guard 存在且禁止连接/读取 0；只有原 K3 重定向用例按既有规则允许自有 loopback HTTP。脚本自定义报告不同，不虚构总用例数。
- 另选原有 **8/8 套边界脚本**：connection-resolver、binding migration、Bridge readonly adapter/有限批 profile、项目子树/PLM persist bridge、read-runtime、external-systems。只机械改旧 runner 的固定 suite 名单，不动预算/网络/env 守卫/测试断言；stdout SHA `92116fa39d52152fc8edcc4ffee04f064d7930a92f6e0858eb7e9b05ff576756`，相同隔离与禁止 IO/读取检查通过。
- 原 SA-02 宿主整文件 **40/40＝39 业务＋1 隔离哨兵**：重新执行真实 AuthService/JWT、实际 MetaSheetServer 私有组合/插件能力/Resolver/PG SQL/浏览器。第二 owner 以第一浏览器下载的原文件导入，改另一套物理字段角色，经真实目录校验/样本确认/批准/激活和业务预览；不复制凭据/权限，原 owner 版本/激活/源/目标不变。正向源读取是原 PostgresAdapter/facade 的 call-through spy，不是 mock 返回数据。四个旧工具只机械重定位候选根；原迁移、浏览器 SHA 检查、预算、守卫和用例不改。stdout SHA `3f9238bbf9792f60a1eded00f5964e9e895db95ddc56ff34f32a6c05a0caeb56`，原回执 SHA `1b5409184fcb2673f6b8bf7dd5f7a6f70fae04e6f3b970a13ed18b672a005f5a`。第二 owner 用例 1/1、未执行 0、禁止连接/读取 0、迁移成功、临时 PG 正常删除。此原 helper 使用其原校验浏览器 SHA `2e61bc3fd990bd4d7b419ef6b6303c67aaed683e5b83b3b25e416f015f343209`，不是主应用 158 候选；没有给这套 helper 虚补 ABORTED 或密码登录证明，也不冒称并行多租户/客户真库验收。
- 加密 probe/census 三整文件 **62/62**，0 failed/pending，源前后不变、Node guard 禁止连接/读取 0，stdout SHA `455dceda47ad800502d8af87a6b84d36e7975929613713425bd5c0f7dbd3cb29`。不是全 backend unit；新委托 snapshot writer 未逃出普查登记。

当前 8dd0 工作源的原 provenance 整文件另重新执行 exit0、stdout SHA `f100c276587a34f70f4ea13506812da8b9ad5788bdb3ca0c655dc4f92f088a04`、stderr 空，未重打无变化的 pin。当前两整文件 69 项不与历史 356/71/40/62 相加冒称全仓数量；历史根因和失败仍保留。完整需求审计见既有 closeout 验证当前节。独立人员终审、当前候选正式 CI、后续发布/真实试用仍未齐备；未提交/推送/触发 CI/合并/部署/读取客户或真实发送，目标 active。

## 上一执行候选：b05 同源验收已闭合（仅本地）

当前冻结 6781 个源文件，sourceSet SHA `b05fc4d1152122031aee073db70863cef51e0df950760f4a2b81cfa8aeb494d0`，archive SHA `a17735fe9cfea2fb313843f486b56c67c6c031741cb8ef1e6fc3711a635d3171`。独立本机 native 副本准备通过，未复制 `.env`，固定 HEAD/空 index/原源码字节约束保留。原公开契约已重新执行 **356/356**、失败/取消/跳过/todo 均 0，stdout SHA `d159798bd7282c0f356a3392a26e2fe5010f77fd327497930924ccead76e9a39`、stderr 空。

同源 remaining-unknown 完整主应用九阶段及只读复核已通过，stdout SHA `919878b9652725d01a60af88616414892106e7882eeaa4441739056dedbefa28`、stderr 空，原 evidence SHA `816a4acc21b85fa7a756404d5ee7b9eb5f0c9cd3ba81843f522a45475c8af9a3`。原 validator、新 case 强制门、全部 6781 源及 core/web 构建字节核验通过，类型 0、冷迁移 478 与空重放通过。真实主应用 owner 密码 JWT/原初始化/原队列及 worker/native sender：首行 UNKNOWN 后 used1/max2，第二条原批准行实际 HTTP202 并由原 worker 完成 retry fence 一次；原 ledger/admission/snapshot 与合成 token/form 仍各 1，第二请求没有 admission，原未知全账本不变，撤销不退款、flags 恢复 OFF、业务快照不变。192 条原浏览器诊断 ABORTED0；原只读 manual POST202 的三层 body 完成各 1，不借此冒称宜搭同名 POST 传输证明。actual-stop-resolved1/production-stop-verified1、正常 owned PG 停止删除通过，无应急清理代签。

原 manual 页面同源九阶段与只读复核亦已通过，stdout SHA `4f83ccac0ce61aec3ed49fb9af7236e5cb52ce2d535959f846f432c7b5e94e89`、stderr 空，evidence SHA `84cf90b0346126b1d66af2cec30baaf6477980af9b9862faf57219bfbd2219d0`。真实页面密码登录、批准与两行请求，原 worker/native sender 得到 ACK/UNKNOWN，页面撤销不退款；fresh confirmation/new grant 的真实请求命中原 native unknown lookup 一次且成功完成，重试 fence 已退避，fresh used0/无新 admission 或 snapshot、原两条全账本不变、合成 token/form 仍各 2，随后真实撤销新 grant。204 条原浏览器诊断 ABORTED0；原只读 POST202 三层 body 完成各 1，actual-stop-resolved1/production-stop-verified1/正常 PG 停删通过，全部源与构建字节重新核验。

interval 自然调度同源九阶段及只读复核已通过，stdout SHA `1290a3363654d6e1da3a150b859782ac02874921be23f68fd8e4c4eb39efcdc9`、stderr 空，evidence SHA `1e1f2f67e77906628cb02248fe8a8043c7a29c2c545685a521e5fc3fb4ef619b`。真实 owner JWT 创建的新规则及 interval-only 有限确认，原 scheduler 自然产生 2 次请求，手工请求 403；独立核验相位和两 occurrence，原共享 outbox/consumer 各 2，第一行 ACK、第二行 native form 在途。实际 host.stop 触发原取消并等待晚有效 2xx，不能提前完成或晚记 ACK，第二行仍 dispatching 未决、请求 admitted/串行占用、used2/不退款，不以停止后补写 UNKNOWN 绕过取消守卫。132 条原浏览器诊断 ABORTED0；actual-stop-resolved1/production-stop-verified1、原 flags 恢复与业务快照、正常 owned PG 停删及全部源/构建字节复核通过。interval 无手工只读 POST202，三层对应计数真实为 0，不借 manual 的各 1 填入。

原宜搭同源 **71/71（66 业务＋5 哨兵）** 已执行并只读复核通过：原 task validator、真实报告逐数、owner/source/task/namespace 回执及原隔离网络合同全部匹配，临时 PG 正常停止删除，0 failed/pending/todo。stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr 空，原受核回执 SHA `d3e3ec5a10907e55a552768da58af01497b0370b64f7476bc0a3acc49e6673e8`。stdout 与旧源相同不代表复用旧证据：本次独立 owner/原 task/report/回执以及实际源字节重新核验，原 71 不代签新增 SA-06D 页面链（后者由本源 manual 另证）。

本源公开合同 356/356、三组原完整主应用各九阶段、原宜搭 71/71、原 provenance 均已终结；各次正常 stop/PG 删除和源/构建字节有对应复核，无遗留活动合成应用。最终 Windows 实际 6781 源/固定 HEAD/空 index 核验及 `git diff --check` 均 exit0。新 UNKNOWN 负例是 Node HTTP 授权，页面批准正例由上述独立 manual run 证明；现有业务单点变异属于真实 installed host，尚未冒称在完整主应用变异。这里的“独立 run/只读复核”不是独立人员审查。没有推送、CI、合并、部署、客户读取或真实发送，历史失败不销账；独立人员终审与后续发布资格尚未齐备，完整目标保持 active。

同源原 `sealed-export-package-provenance.test.cjs` 已实际执行 exit0、无 signal，stdout SHA `f100c276587a34f70f4ea13506812da8b9ad5788bdb3ca0c655dc4f92f088a04`、stderr 空；没有借此扩大为整个 integration-guard 或远端 CI 通过。

下文为按候选保留的历史过程；其中“正在/尚未”只描述该候选当时状态，以本节和对应明确终态为准，不删除历史失败，也不将作者自核冒称独立人员终审。

## 前一候选：完整主应用剩余预算 UNKNOWN 负例（f22真实整应用已通过，后续同源回归待补）

**f22独立remaining case原整应用九阶段已通过。** stdout SHA `f1e3d87e74f4a92064fc1719d381feae777662df3e379c2592504b4823d8f20c`、stderr空，原evidence SHA `53a7246220e71ad3831abea9296f9528c55931bed1c41f6df81bf2e66a405ccd`。只读重核全部原validator与新case强制门、6781实际源/core-web构建字节均通过；类型0、478冷迁移及空重放通过。

真实主应用owner密码JWT/原初始化两行/原规则/安装绑定/原共享worker/native sender：首行malformed2xx账本UNKNOWN、consumer dead_letter；未撤销且used1/max2时真实第二行HTTP受理并由原worker完成retry fence一次。原ledger/admission/snapshot与token/form均**1**，原未知全账本不变、第二行queued且无admission，串行占用保留；随后真实API撤销不退款，业务快照不变、发送flags恢复OFF。新case不是实际用户页面授权证明，普通manual原页面case仍须单独回归。

192原browser诊断ABORTED0；原只读manual POST202三层body完成各1，不冒称宜搭POST同名传输证明。actual-stop-resolved1、production-stop-verified1、owned PG正常停止删除，无应急清理代签。原355/356合同失败仍保留；当前仅修精确签名断言和CLI help后的源码须另冻/重验，不能把f22全应用绿签下一源。主应用此负例已获证，不等于业务变异已在完整主应用跑（现有变异证据来自真实installed host）、独立终审/所有源回归或完整目标已完成。未推送/CI/合并/部署/客户读取/真实发送。

本轮已接原公开CLI的显式合成参数`--yida-case=remaining-unknown`（只允许manual、exact literal、重复/未知拒绝），不使用env或生产flag选择场景。该值进入原owner-bound namespace哈希材料并由原init传至原runner；runner与MTS都比对同一个owner值，普通manual/interval仍沿用原路径。MTS只在已完成全部原OFF/UI初始化和默认OFF主应用检查后，以该case选择新的真实JWT负例，不和原两行ACK/unknown页面case混用。原九阶段、300秒总probe、每行10秒、所有原validator/源与构建/业务快照/清理/发送OFF边界保持；新公开门强制本case唯一有序证明，不借其它case。

纯门首轮154/155，唯一旧公开调用段自证仍使用两参数needle；改为精确三参数并给VM显式undefined后155/155、0skip/cancel/todo，stdout SHA `b652286577b389aa9eded8718f4a61e17c9df81ceeb8785dc43ab41cceea10cb`，旧失败stdout `a78d377fa6482ec5720de6c30e63107a417cb541ebda3915204d004e25304e25`保留。删除remaining精确证明→134过/21失败、真实exit1，stdout SHA `5a4e7ab9703f45447684366a0a5b2c7c09689469d59abb69bcd01a6f209f407f`，源/工具不变、IO/env0；它是证据门变异，不代签真实业务。

冻结6781源sourceSet `f22d7078581b698b535199594a95ed1b22e30f95c14336ecc98eae77ec79dbc4`、archive `cd49e1d9f3de6d88aadbac6a3281c46ac99396a93f15df74f5b3fa02237e2d19`的原全应用remaining case已启动，类型通过进入构建。原合同355过/1失败（356条、0skip），stdout SHA `e7d2601800539ab90dbd786dba271f7b7ff14275b3db2affc8ae046685118e1d`；唯一另一处严格全validator调用顺序正则仍写两参数，不是业务失败。随后仅把此处改为精确三参数，原完整顺序/关闭门不变；Windows当前合同文件已不同于f22，native该run仍只代表原f22。新修正合同须另验，remaining真实业务及停止尚未签通过。

在671f已完成host负例和单点变异后，新增仅测试用`yida-automation-main-remaining-unknown.ts`，要求全新原初始化两行、原ledger/admission/snapshot全0，实际owner密码JWT/规则/既有四操作HTTP→原worker；首行malformed2xx后等待原consumer dead_letter，再在未撤销/used1/max2时真实提交第二行并要求原退避fence完成，核对原UNKNOWN全账本不变、第二行无admission/ledger、token/form仍1，最后真实API撤销不退款。不得放到原两行发送完成后的环境里借已有账本冲突假证serial guard；未修改approved材料/历史行或额度。

为该独立场景仅扩既有测试vendor的`unknown-first`模式，原默认首ACK和hold-final行为保留；未改生产远端、开关、授权或sender。新增两条真实Response/精确正文/关闭后拒绝/无fallback小测试：Linux整文件14/14、0pending、无IO/env读取，stdout SHA `99f60b9fce390426178997a01c0c9e2053887f54bbea61bf421bdb5c7b0e8106`；Windows首次12/14，两新增用例因vendor原Linux-only前置拒绝，保留失败stdout SHA `f4dc76a9ac6f2c84a59b94f34ac6e39a688dabb564ceb69ac15601ebad4df02c`，没有放宽平台门。三helper实际TypeScript程序检查0诊断（含依赖），无emit、源不变；非完整backend build声明。

**尚未接入原公开CLI/namespace的独立case选择与必需证据门，尚未执行完整主应用JWT该负例。** 这不是新增功能切片，也不允许用小测试/host28项代签主应用完成；下一步先接严格case与scope传递、保留现有manual/interval接受路径及原预算，再实际运行原整应用。当前仅测试源新增，旧32c1/671f冻结证据仍仅属于各自来源；独立终审和完整目标审计亦未完成。未推送/CI/合并/部署/客户读取/真实发送，目标active。

## 已获installed-host证据：剩余行/预算 UNKNOWN 隔离与正控制

同源671f原公开合同整文件亦已325/325、0失败/取消/跳过/todo，stdout SHA `1fde09c11b0ab3be6763cf82662900bb69738062285b1d12acc94a6d15d7886c`、stderr空、冻结源未变；它不替代新installed-host用例的实际PG证据，也不是当前全主应用回归。当前全部已启动测试均终结，正常PG停止删除获证；未遗留活动合成应用。下一步仍需完整主应用剩余行/预算未知负例及独立终审，不将目标缩为现有测试全绿。

**671f真实installed host/PG整文件及单点变异现已获证。** baseline28/28、0failed/pending，额外checkpoint匹配，原namespace/网络/env守卫与原90秒预算保留，实际PG停止删除。stdout SHA `6fe685727ce659083356e38e5ffb43419825972d5b98d94bda0cf18b06bead8e`；两行ACK正控制通过。未知负例实际第二行请求/claim到原adapter，approvedRows2/max2而used1，token/form、ledger/admission/snapshot均1，没有撤销或额度耗尽掩盖。

仅内存删除原`if (row.active_request_id !== null) fail('BUSY')`后，同整文件27过/1失败、0pending，正控制仍通过，唯一失败精确为上述未知剩余行用例；checkpoint显示token/form、ledger/admission/snapshot/used全部变2，第二次合成外部边界调用真实发生（不是仅比错误码致红），原生产文件未改。变异stdout SHA `b2028a89a0c508b1e1119bf633c775dd41cc8c0bc9975465e577799bb968b5da`、真实测试报告SHA `da8ad4434765d973b954cb8db9aaa7c6478c86eb1398421bdff582c03cbc9cb2`，目标title SHA `ad3a7f8b8189529c250b576ab5ce297be6d2113466c0cc2f6e9190f09eca7581`。实际PG停止删除、源及11工具前后不变。

外层首轮仍正确返回passed=false/targetFailure=false：定位器误以为retainedSyntheticReport是候选tmp里的文件，实际原runner输出共享owned目录中的报告**目录**。保留该原始拒绝收据，不覆盖。后续只读审计精确白名单目录、realpath/普通文件/大小门，读取其result.private.json并将字节hash与同run execution.stdoutSha256绑定，确认28条/唯一目标失败/正控制通过和额外发送计数后才签变异证据；没有重跑凑绿、读取.env/凭据或输出原报告。未来定位器按同样限制修正，未将工具修正冒称生产修复或独立人员审查。

这项证明的范围仍为installed host/PG/native真实组合；完整MetaSheetServer/JWT下“剩余行/预算未知”独立负例、同源完整回归与独立终审尚未签完成。与32c1相比仅两份测试文件改变，runtimeSourceChanged=false、0删除；不能把32c1的整应用来源冒写为671f整应用已跑。所有历史失败保留，目标active，未推送/CI/部署/客户读取/真实发送。

仅扩原测试fixture的显式approvedSecondRow选项（默认行为不变）并在原management-host整文件加两个真实PG用例，不改生产实现/guard/迁移/时钟/预算。正控制：同一实际installed host、read runtime、原primitives/native sender，两条真实批准行均能ACK，used2/max2/ledger与admission及snapshot各2。负例：第一条malformed2xx持久UNKNOWN后仍used1/max2、未撤销；第二条原未用批准行能通过真实request/claim，再由实际host adapter拒准入；原未知整账本保持不变、第二请求仍queued/无admission/ledger，计数和token/form均保持1。不会用额度耗尽、无第二行、未激活或关开关冒充serial guard证据。

范围声明：此项是**真实installed host/PG/native组合，不是新增完整MetaSheetServer/JWT/页面负例**；32c1的真实主应用接线证据另列，不能将两者混称同一场景。主应用剩余行/预算负例及独立终审仍未签完成。

首次误直接调用内部run脚本，两次均在原namespace前置拒绝、PG未启动；随后改用原boot脚本，原user/net/pid namespace、lo-only、capability清零、网络/env守卫均保持。挂载路径候选在原90秒预算SIGTERM终结，只2/28通过、26pending、无完整报告/guard终结帧，stdout空、stderr SHA `ede5dd0ecbbd75d5d29f0be9dd49dadb18c15f4305e4df60d33be1cd2fc9b764`；实际PG停止并删除。不加预算，不称全绿或据此推断唯一性能根因。

4c82冻结源sourceSet `4c82715e703a6a51f7234a640df3f2b0e9989631f45e11354b1f6521f38c617f`在owned native FS副本，原host整文件**28/28、0failed/pending、实际PG停止删除**；但额外外层门因console诊断未进入固定checkpoint通道而拒绝passed（checkpointMatches=false），因此未将其签为完整验收。stdout SHA `7a318ba517425a94c6cb266d8634559f9fffb63ab4f27ce2b05bbb665bc91897`、工具集合SHA `3a6ba504326a47b5a8f40798effb5c63f7890429b0ee2e6a501f8631b3dcd46e`、6780源/11工具前后不变；它只是环境对照，不等于挂载路径超时根因已证明。原生wrapper首轮因未建立tmp父目录在测试/PG启动前ENOENT，已补仅本次owned tmp目录，未跳过门。

修前Windows源/固定HEAD/空index核验通过；仅把新checkpoint从console.error改成与原fixture一致的process.stderr固定帧，未改业务断言。新冻结6780源sourceSet `671f6ba9103f2eb53930084a7880933dd458f95c06fc2ce3430c66f83fd1083d`、archive `4e2e1ae30937b810c121800fbd69b1f8cc3a197fc11eb0aa4d8f545933f7c10b`，正在准备native整文件及serial-admission单点变异；尚未签其checkpoint/变异通过。所有复制工具严格枚举、不复制.env或凭据、不改旧冻结源，测试前后核全部来源与工具字节；无独立人员审查背书。目标active，未推送/CI/部署/客户读取/真实发送。

## 已通过的32c1候选：宜搭自然 interval 由原 scheduler 入原共享队列，再进入真实停止

**本轮同源回归已闭合：原合同325/325、原manual/interval各九阶段、原宜搭71/71全部通过。** 没有把旧a90或更早候选的绿代签32c1；当前没有遗留运行中的合成应用/PG。本项收口仍不等于完整自助目标或SA-06D全部完成，未推送/触发CI/合并/部署/客户读取/真实发送。

本源manual stdout SHA `cccb449e7d00d9af70a177c05b717f3dede024e183a91cdbc915fe49c9770f6c`、stderr空，原evidence SHA `f4d9ee18eb5af6cf1fd7c927eac25c6eefba865d0f2477c2af69acac4c11af8d`；全部原validator与新公开强制门、实际6780源和core/web构建字节复核通过。真实授权页面/两行执行/撤销及fresh确认未知围栏均完整获证；fresh原worker claim/原unknown SELECT各1、error0/退避fence完成，新used0/新admission与快照0/原历史不变，token/form2/2、refused0。204原browser帧ABORTED0，原只读manual POST202的SDK/PROXY/PLAYWRIGHT body完成各1；actual stop及production stop各1、正常PG删除。

本源原71=66业务+5哨兵通过，独立原task/owner/source/nonce/收据校验和正常`stopped-owned-pg-removed`通过，receipt SHA `7d2c56de778f34841ace011dd44107361f44a743279a2f88b0b6ff8ed16d4739`、stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr空，newSa06dBrowserProof=false明确保留。验收结束后Windows全源/固定HEAD/空index再次通过，diff-check无错误；它不替代新增自然授权场景的整应用证据，也不是正式CI/真实vendor联调。

剩余仍为预算/行尚未用尽的未知结果隔离负例、相关真实路径变异与独立终审，以及完整目标逐项完成审计。自然定时已有前端显式允许选项，本轮未新增UI、端点、flag或调度引擎；历史250ms租约、WSL回拨、SQL与旧ABORTED不因本地新绿被宣布全部根因已修。下文保留本轮进行中记录，以上终结证据为该源最新状态。

**32c1新自然interval原整应用九阶段已通过。** stdout SHA `19614b0704f9a73bd9d3e9739b0b2860bdbc35ae3eaef97ba7b3b912c4f75c4e`、stderr空，原evidence SHA `46ff044725a166d9d370f83c8e68f967422fb7599c3348f686a31cf124a87597`；原全部validator、新自然证明强制门、6780实际源和core/web构建字节只读复核通过，Windows全源/固定HEAD/空index在下一场景之前再次通过。

同一真实主应用/owner密码JWT创建新2000ms规则、interval-only max2/900秒授权，真实手工请求403/accepted0，原scheduler自然产生两条相位和occurrence key匹配的请求；原共享outbox两行/consumer attempts合计2，原native sender token/form各2、refused0，第一行ACK、第二行held dispatching，used2/max2。没有直接调用producer/dispatcher、回填相位、假timer或新增scheduler。实际host.stop触发原signal、等待晚有效2xx且不ACK，主池关闭后的原未决dispatching/不退款/串行占用及原业务快照/维护/监听/两个collab清理全部保持；actual-stop-resolved1、production-stop-verified1、owned PG正常停止删除。132原browser帧ABORTED0，不冒称本场景有manual只读POST202 body证明。

原合同325/325见下。当前已启动同源manual完整回归（须再次覆盖真实授权页面与fresh fence，不能借a90），同源原71仍待执行；自然触发本项不等于独立终审、剩余预算未知隔离负例、所有旧时钟/SQL失败根因或完整目标已完成。未推送/CI/部署/客户读取/真实发送。

32c1原合同现已 **325/325**、失败/取消/跳过/todo均0，stdout SHA `af6b1c0726389aca3431f530b8a73744c5a6f5bc82399f088f2d25fc1cae7a2a`、stderr空，原冻结6780源前后不变。原interval整应用已完成类型、构建、478条冷迁移及空重放，进入configured-app，尚未终结；不预签自然tick、在途stop或清理，也不借a90旧证据代签本源。

上一a90冻结源的同源回归已闭合：原manual/interval各九阶段、原合同313/313、原宜搭71/71。interval stdout SHA `e84093fedb432b8f6cd6c331b18481efa2a24eaada4e07094fbd7442e8a40ad5`、evidence SHA `ded4870e3f516679da24017db82a269a077dcab3e21f0a61ee3f93f516ee03f3`；原/新validator、6780源和构建字节复核通过，132原browser帧ABORTED0，actual stop及production stop各1、正常PG删除。该interval保留的是原只读自然tick＋宜搭人工请求的在途stop，**不能算宜搭自然tick**。71原task validator/owner/source/nonce/收据及正常owned PG删除均获证，独立receipt SHA `2b36039217cc1f12dd9f4e8cc43dd95ac2bce7360e148314d155283b9c0e9405`，stdout固定 `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336` 并非据固定stdout冒认新run；它仍是原owner/初始化回归，newSa06dBrowserProof=false。Windows源在本轮新自然候选编辑前通过a90核验，71的冻结native源运行前后不变；不冒称编辑后Windows仍等于a90。

新增仅修改既有interval在途合成验证的刺激来源，不改生产scheduler/端点/开关/授权：用同一实际owner密码JWT和既有规则POST创建**新规则**（2000ms，原允许最小值1000ms未改，created_at不回填），再显式新建interval-only有限授权（原两行/max2/TTL900000）。不复用旧manual确认，不调用produceSchedule/runDispatchTick/私有scheduler方法，不设置时钟或假timer；先证明真实manual请求403，随后每行仍用原10秒预算等待原boot scheduler/原共享队列/native sender自然产生ACK第一行和held第二行。旧host.stop/父signal/晚2xx不ACK/持久dispatching未决/不退款/原子完整性/业务快照与正常清理断言全部保留。

候选还将真实PG的rule phase、grant activation/approved时间、两个request occurrence、原outbox payload/manifest/consumer逐项对应：独立固定tuple候选域只覆盖批准后、观察前的自然tick，要求顺序/唯一且排除manual域；哈希本身不被当作authority或scheduler证明，仍须整应用无手工producer接线和真实worker/ledger组合。原公开门interval新增唯一且有序natural证明，manual禁止借用；新增结构接线检查要求真实authoring/原10秒/无直接producer，未新建CI泳道。

小测试当前12/12，删除自然顺序检查→11过/1失败、真实exit1，stdout SHA `2acd9aaac9532fe587c315a410d2e75d8b5dac9fa1922ccd7dfc25a401437710` / `e52902e044bd43fe5ca7a15536f44aaf6bda2f2aef895ab982c27590a059d245`。公开纯门125/125，删除natural精确证明→117过/8失败、真实exit1，stdout SHA `96919ff11a990ddf38c4d4b7dce1014952c39abb1e90613cb751f85214675b09` / `a41900d6a3d1ebb7839ea5e38d7502736c36ae9bd447066808db3139028707e0`。0pending/skip、IO/env0、源/工具前后不变；纯门四源集合 `24e841db8e57d852076387ca91f6cc2cab07d2bde714c67a34aec4b71f09c510`、工具三项集合 `ec0011b934edaacd77f7150c101c4ff5da12f5008be03b9e01ec9992278b7845`。这不是业务围栏变异、独立人员审查或真实自然发送已通过。

当前新冻结6780源sourceSet `32c100c6320fb549e0a07184adf53f6f0601c2eead8dd53134ead3dbf91d3982`、archive `38104a7e58ab485abb0c4972d683a0f5a790f871f0518467b5402a0c20d19352`，正在准备owned native原合同及interval整应用；**尚未签自然tick或新源整链完成**。原未知且有剩余行/预算隔离负例、同源回归和独立终审仍未完成，完整目标active；未推送/CI/部署/客户读取/真实发送。

## 已通过的a90候选：真实主应用新确认不能绕过未知账本的永久 CREATE 围栏

**本项最新真实结果：a90源manual原完整CLI九阶段全部通过。** 原全类型/前后端构建、478条冷迁移及空重放全部通过，stdout SHA `e2e9b93df1027eb16b08f4e6a8ff99e44d081d2abaa73ac839301e7c8b967b6b`、stderr空，原evidence SHA `73a1f3598b840fd8ca4e75a47324a937cc24835c21b50995985f2a3d7fc99f30`。只读复核原全部validator与新公开必需门、6780源及core/web构建字节均通过，Windows固定HEAD/空index/全源也通过。

真实owner密码JWT登记新确认和请求，原共享worker实际claim **1**次，原native未知行查询attempt/completion/unknownRows各**1**、error0，正控制另计；原consumer保持in_progress的原退避fence完成已获证。新grant used0、无新admission/执行快照，原两ledger及私有整账本指纹不变；旧grant used2/串行占用不变，新grant随后真实API撤销，token/form各2、refused0，无第二CREATE、无退款。原页面批准/两请求/ACK/unknown/撤销仍完整通过。它证明原未知行不能借新确认复发，不代替旧grant尚有未用行/预算时的独立serial负例。

192个原browser闭合帧ABORTED0；原**只读**manual POST202三层body完成各1，不冒称新宜搭同名传输帧。actual-stop-resolved1、production-stop-verified1、owned PG正常停止删除，不以应急清理代签。本源原合同313/313见下，仍须同源interval和原71回归、新宜搭自然定时/其它隔离负例与独立终审；完整目标未完成，未推送/CI/部署/客户读取/真实发送。

a90候选原合同已 **313/313**、失败/取消/跳过/todo均0，stdout SHA `6738e124b7f539b8b00b257cd520f5a74c66507a4f88a33de10b74d2c92174b7`、stderr空、原冻结源前后不变；旧严格K3清理门及新增fresh门均保留并通过。原完整manual已通过harness/web类型检查，正在原构建阶段；fresh fence、实际停止和清理尚未获本源通过，不能借0576的局部观察或旧1724全绿代签。

0576实际manual亦已终结失败，不能签闭环：已走过CONTROL及真实新请求，原native worker的未知行SELECT **attempts2/completions2/unknownRows2/errors0**，token/form仍2/2、refused0，但REQUEST等待条件未满足；stdout SHA `dfce77b999a79e82f44019f495b4b9294e8144c1cb3ed8b164ab9acd35b0e704`、evidence SHA `4a50d2005949ddceea5cb984d5573330b20149c719df561168ba5e8adc5c774f`。实际stop成功/owned PG已删除，production-stop因前序未通过拒绝。此结果证明提前安装和QueryConfig观察已接通，不代表fresh fence全部断言完成。

实读原dispatcher发现第三个测试oracle错误：retryable_failure的原reschedule**刻意保持in_progress**，只推进退避lease并原子fence+1；原claim亦fence+1且attempts+1，heartbeat不改fence，fresh consumer默认为0/0。因此不再错误等待pending/dead_letter；改为严格要求`in_progress + last_error='unknown' + fence=2*attempts`（1..64），同时必须实际未知行SELECT完成，结束时再次核对原退避fence。运行中刚claim的奇数fence、仅保留旧last_error的重领、pending/done/dead_letter均不能过；没有修改原dispatcher、consumer行、lease、重试或10秒预算。公开fresh帧新增retryFenceResolved及原consumer状态必需项。

新观察器/退避判定整文件10/10，去掉fence相等判定→9过/1失败、真实exit1，stdout SHA `1024d47eaba53494cd5bfc4043275627d53c29579e8c3309cedb120430984950` / `975a676af33f8e31230b84881c2cfa7027e0bf4da82584c4aa4ce648a6ac6dd8`。原公开纯门114/114；删fresh精确检查→98过/16失败、真实exit1，stdout SHA `b2d0c1caf0eb6fa5776995bd69fcbeffd7d8c53ae8fa18cc6f5addd08c158db0` / `8eead12c7bed02628ac90d8ba111928c10ff1a72a6045415cf4c101b83803352`。均0pending/skip、守卫IO/env0、源前后不变；不替代业务围栏变异或真实整链。新6780源sourceSet `a90c76b774cd15fdef9b24defa7b80d0358f4af691b0fd2db5dfe0adfa068827`、archive `7cc9b6b324f48ed52d80d8bf7e8c1754a58f8892ee37a56f1fa4ee75bd9384b5`已冻结，仍待完整manual及原合同重验，目标active。

c35候选也已终结失败：configured-app仍在CONTROL正控制拒绝，新请求未提交、worker计数0，原token/form2/2、refused0；actual-stop-resolved而production-stop因前序未通过拒绝，owned PG已停止删除。stdout SHA `bef3c9d1004af3ca845ebbed5fcc2fc2fd01ef263888fe6b21c5ff608cb873a5`、evidence SHA `2b936647840cdbcf79b47c1bfe09d116f61cbf5016122384a37013db4c2bc11f`，修正前全源/HEAD/空index核验通过。前次QueryConfig修正必要但不足，不能据其七项小测试签实际主应用。

后续实读发现叠加的观察器捕获问题：原`observeOwnedDetailRequests`在pool acquire时把client.query保存为实例自有Proxy，直到原finally才dispose，晚装prototype观察器看不到已捕获方法。因此仅在原Automation fixture建客户端之前安装新观察器、保持inactive，实际fresh grant后才arm exact identity；原观察器、查询/回调/Promise及执行围栏不变。新观察器finally恢复后，即便旧客户端仍保存原函数也仅作为inactive转发器，不改旧方法身份。增加捕获前安装/迟arm/恢复后inactive以及unarmed不得出证明两项，整文件9/9；string-only变异为5过/4失败、真实exit1、无IO/env读取、源前后不变，baseline stdout SHA `41c096761cf4812c34fc43fd1144321830dabdc76211e03fc740cf63447977b9`、变异 `7728b96d80829242aca96578fbd00cb5a2917feaaec3c3b75557a777c8650dad`。原公开合同另加安装顺序和晚arm接线断言；新完整候选还须实际重验，不把此假客户端测试称为真实PG/业务证明。

同一九项另做arm-missing变异：8过/1失败、实际exit1、0pending、守卫网络/env0且两源未变，stdout SHA `0a699ed8ab1460e4e3a396de4cb6e8a3150d9ea57592fc4508c1d3d4390c7af0`。下一冻结6780源sourceSet `0576a642a3a9f0bd132576c93d34a6376d75f493959810674095df1aa7510d60`、archive `ec54a8fc5d0134855d5f656afb7c664ecf02666969d1e2b0109e8ff6203feb21`，正准备owned native源再执行原合同和manual；当前仍未获新真实fresh proof，完整目标active。

0576原合同已实际终结310过/1失败（311条、0跳过），stdout SHA `33918734ecc171dc18032c0db91a1553102cd460d87c52102719092ee44e3eed`；新增提前安装/晚arm接线检查通过。唯一失败为旧K3清理接线正则逐行要求owner观察器restore紧接K3 close，未包含新增fresh观察器restore；在Windows全源/HEAD/空index复核后，仅将新restore及其固定失败标记明确纳入原严格正则，原owner/K3约束全留，没有放宽为任意跨段匹配。此后工作树与0576合同文件不同，0576原manual仍在其冻结副本运行，不冒称下一源整链已过；修正合同仍须重验。

4cef真实manual已终结失败，不能签完成：八个原前置阶段通过，configured-app在fresh fence **CONTROL**正控制拒绝，新请求尚未提交、worker计数0；原两行token/form各2、refused0，实际stop-resolved，但production-stop证明因前序业务未通过而拒绝（不是实际host.stop失败），owned PG已停止删除。stdout SHA `4d6bf9f223cc133844d82369ca64dfd4fc815eab600c05837cfc22065a05aace`、evidence SHA `fcc41bf81ef12ec5b1db71add31cb53c0701fa063df47ed2c85d50215a82f41f`。修正前Windows全源/HEAD/空index复核通过。

根因实读：`connection-pool.ts` 的query与transaction均把字符串转成QueryConfig再调用native Client；新测试观察器仅识别string，因此其正控制没有认到实际查询。仅修测试观察器同时识别string与原{text,values}，不改参数、结果、Promise、回调this/额外参数或生产查询。新增七项整文件正负例 **7/7**，恢复string-only变异为4过/3失败，实际exit1；无网络/环境读取、磁盘源不变，不能替代新整应用。baseline stdout SHA `881a4b65e2082b3c9ace3c0b375f29ffb5fba977b7f4ff722e9819cae6a183f8`、变异 `6fcf380a0e2f1de32385659657d114534afdd5ebb59f0b8d79644b0d13f10b6a`。本机工作树直接pnpm第一次因未装vitest未启动，随后用既有共享runtime及严格无IO/env守卫运行上述真实测试；没有安装依赖或改默认测试配置。

修正后6780源sourceSet `c35a9d2db9155d5035047db622e91094630b2a3adb8d55c5744c0fa7fbbc1b33`、archive `22bbe72043a79cad80554eb02633d1e3b4dd3713ff652e184ef0e29997256b66`准备完毕。原合同310/310、失败/取消/跳过/todo0，stdout SHA `54e70c908540320798cc6758e49343e06504f2492bbf95b00370f208d6fe579c`；Windows全源/固定HEAD/空index复核通过。该同源原manual已启动且harness-types通过，仍在原整应用阶段执行，不借4cef或1724旧绿签fresh fence完成。观察器七项属于独立整文件，未与310相加冒称单一全仓通过；完整目标仍active。

本轮实际结果补记：e379冻结源原合同 **310/310**、失败/取消/跳过/todo均0，stdout SHA `064cfef75596b06995e07c32a4ced1a50501780059290bb18db82ce2dc859c16`。同源完整manual在harness-types阶段因新增观察器TS2339两处失败，业务未启动、cleanup为not-started；stdout SHA `17bb58772ee7c057d31afa1d1578b3b8b83583d052131df8f7a83096f29f18ed`，不能宣称业务或停止通过。原源/HEAD/空index在修正前核验通过；仅补PromiseLike类型声明，原Promise及查询转发逻辑不变。新冻结sourceSet `4cef6569e040e8dc1d353898f3de73b7f2836499cb856c8bcb5ab4192d45ef16`，正在重新准备本地原整应用验收，尚未通过。

4cef候选准备完成，原合同再次 **310/310**、失败/取消/跳过/todo均0，stdout SHA `0d84eaa188f1da641cb65e502988993048ebd6e61d4506b5a7144d1c7640410c`、stderr空、候选源码前后不变。真实整应用manual已通过harness-types与web-package-types进入build-core，尚未终结；此处不预签worker、未知账本围栏、停止或清理。Windows全6779源/固定HEAD/空index复核通过；没有推送或触发CI。

e379纯证据门其余两项删除变异亦实际致红：execution为106过/6失败，stdout SHA `0b9f0c3128d5033e310ec5e15d8d913f33630748315f30f76f623b693c873867`；inflight为104过/8失败，stdout SHA `a708ba92286882a1771ae9cd2dcb6f6b302390959841877bbe966068364ed7f2`。均112条、真实exit1、0跳过、禁止连接/环境读取0、源和工具前后不变；不是生产围栏本身的变异证明。

新增仅为既有范围的执行负例，不新增端点/生产模式/默认开关：在原manual真实页面完成ACK/unknown/撤销及原两consumer终态后，用同一个实际owner的密码JWT、同一个已装绑定/真实DB规则版本/原operation，针对原第二行unknown成员登记**新confirmation/new grant（单行、一次、900秒）**并提出新请求。原自动发送测试flag仍ON、假vendor仍arm，不能借关开关或停worker得到“无IO”。必须等原outbox consumer实际claim过、离开in_progress；还必须在真实pg.Client层观测原db.cjs/原delivery store的exact scope-row FOR UPDATE查询完整读到原outcome_unknown行。测试自身同SQL正控制单独ALS计数，不能混进worker计数；查询/回调/Promise数据原样转发，不伪造row、authority或sender。

要求新grant未admission、used0、request仍queued无ledger/admission，旧两ledger/原两admission/两snapshot与私有整账本指纹均不变，旧grant used2/serialBlocked保留；新确认随后真实API撤销，token/form保持2/2、refused0。指纹与opaque IDs只在内存比较、不输出。此证明的目标是完整路径不产生第二sender，不声称某一行guard是唯一保护；原store同snapshot/reused检查及PG永久唯一围栏均保留。它也**不代替**unknown且旧grant尚有未用行/预算的独立serial守卫场景。

原公开证据门新增manual必需fresh-consent-fence帧，要求新授权/请求、真实worker与原未知行查询完整计数、无新admission/snapshot/IO；interval禁止借该帧。新增metadata负例不替代真实主应用：纯门整文件当前112/112；删除fresh证明精确检查→98过/14失败、实际exit1，父子guard禁止IO/env0、四源及三工具前后未变。baseline stdout SHA `2dc1434b0d3a2c8eccf3e80c94400f23702f27ce213728e64c165b30c2257430`；变异stdout `1bdd2aa0f4da3e35080bb6eb4952b4c26e2db6a100cba92cf3bb2f21c32f91cb`；原module `aa28c6825b28a496342e2f66a9ef59ff07a29a6bd52a08e5f584f14c1bff2964`→内存module `bed51171c5f70e81fae47f733dd690b7d427c20e0b23dd286fafa982920849e8`。工具集合SHA `5b44b5ecdae9daf5a0339acc88b5654d4ab51677efa621ea74f29961eb444825`，不是整业务源码的变异或独立审查。

当前6779源sourceSet `e3797d5acf9cd39a65f1cc9163fda3bf805a68eab751edb656ba1f249d379beb`、archive `da6b4b87e41c9c6292b39c75c63dc7e4d1e56d7fb3056cafb611160a4dd65add`已冻结，Windows源/固定HEAD/空index准备前核验通过，正在准备owned原生FS候选运行原整应用及合同；**尚未签新真实主路径通过**，不借旧1724的293/两9阶段/71代签。没有推送/CI/合并/部署/客户读取/真实发送，完整目标active。

## 较早通过：SA-06D 证据进入原公开 CLI 的强制门

当前6778源sourceSet `17242328fc82b8e2cb93b4fc5da6c7abe77fb6d9c4c0827f6be8ae080e776350` 的**原合同293/293、原完整CLI manual/interval各九阶段**全部通过；两条真实整应用接受路径均无条件执行新公开门，随后只读重核同源原/新导出门、实际源及core/web构建字节均通过。不是仅对旧收据回放新validator；旧291/293失败及修正过程保留在下文。

| 本源真实命令 | stdout SHA-256 | 原收据 SHA-256 |
| --- | --- | --- |
| 原manual整应用 | `0a3bd94f1b2d93efa2549ef4ff0816221226e53cf94996b693b87e26e59cdf31` | `6d05eef5e623ace0d4e3048f48ea99be067f66266cf7b03040760030c3f56e62` |
| 原interval整应用 | `c30a0002ea9f084842825d34436b651d4f6b305eef87267ca6f1fddf83d49edd` | `4ffe6102e04bdb7722c42f677cb9416a45c3e03be79a1808cfd267d9d1725e52` |

两轮stderr空、类型0诊断、原478迁移/空重放、实际stop/production-stop各1及正常owned PG删除均通过，无应急清理代签。manual有实际新授权页面、worker/ledger ACK与outcome_unknown、撤销；interval保持parent停止后的dispatching未决/不退款/无晚ACK，不冒称新宜搭自然interval。原browser帧manual204、interval132，均ABORTED0；原只读manual POST202的SDK/PROXY/PLAYWRIGHT body完成各1，这些不改称新宜搭同名传输证据。运行前后Windows全源/固定HEAD/空index核验通过。当前同源原71正在独立新owned环境运行，未借旧71绿签当前71；业务组合隔离负例、新宜搭自然interval与独立终审仍待收尾，完整目标active，未推送/CI/合并/部署/客户读取/真实发送。

同源原71现已实际终结通过：**71/71=66业务+5哨兵**、exit0、无失败/跳过/todo；stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr空（公开输出仅固定结果，因此该stdout哈希与旧源相同，不据此借旧运行）。本次新owned目录/nonce、当前6778源前后哈希及原owner/source/task/report/receipt绑定须由本轮独立审计共同证明。71只支持原owner/初始化路径，`newSa06dBrowserProof=false`仍保留，新增授权整页证据来自上述同源manual整应用而非这71；不是远端CI或真实vendor联调。

本次71的原task validator及全部owner/source/task/report绑定只读复核已通过，receipt SHA `b52fe7723d6d44f3bb93ea52dafd790fda036502d069a5a0bd5ac20a3fa960a5`；namespace隔离及`stopped-owned-pg-removed`获证，原Windows6778源/固定HEAD/空index最终核验通过。当前两轮整应用和71均已终结，无遗留运行中的合成环境；不把工具复核称为独立人员/代理审查。下列剩余仍未完成：主应用unknown且尚有未用行/预算的独立拒绝、新确认不绕永久CREATE围栏、新宜搭自然interval的完整组合、独立终审。之后仍需另行授权发布/同head正式CI/真实客户与vendor联调、合并部署；本轮没有实施这些动作，整体目标保持active。

原 `run-stock-preparation-plm-full-app.mjs` 在现有业务/停止/只读Automation验证后，无条件按可信CLI scenario调用新增纯函数 `validateYidaAutomationEvidence(records, automationScenario)`；原workflow/端点/开关/生产权限不改。新模块不接受源文件存在即跳过、其它泳道绿或混合场景记录：默认OFF UI与main两证明均须唯一、完整、有序；manual须真实批准/两次请求页面帧和实际native执行帧，interval须在途准备、真正actual-stop-resolved之后的未决后验帧，并在production-stop-verified之前完成。拒绝缺/重/错序/失败记录、未知字段、退款/多attempt、外发true或把dispatching美化为已提交unknown等。

新增95项为**纯证据门与实际提取公开编排段**合同，不冒称新业务/JWT/PG/browser验收。真实新导出函数原整文件95/95，exit0、fail/cancelled/skipped/todo均0；stdout SHA `6f843b57004b9f0aa5b3eee4acb49af749db29d25f775e82a80e2e8bf8a27586`、stderr SHA `2473831baa7784edb5185b6e98f9c48c8a6b5e999634ba8bd3feb151a8d4bb46`。内存ESM loader仅删actual execution证明精确检查→89过/6失败（stdout `becaae16982aacb464d566adc18741810b7202843331a20455d947cf3ccf57f1`）；仅删inflight terminal证明精确检查→87过/8失败（stdout `0d49c7f239ddad040f7b140058f7a3360ee0ced5c8a58d3aa86eb4603e7d27b9`）。两者实际测试exit1、完整95项执行、无pending/skip；父/子两guard帧禁止连接/.env读取0，磁盘生产/测试字节未变。外层exit0只表示核实变异被杀。编排段另用真实gate验证缺帧确实拒绝，删除该唯一调用后拒绝消失；其它旧验证器在这条局部接线合同中是noop，不拿它替代真实整应用。

工具首轮收集只看stderr，遗漏node:test转到stdout TAP注释的loader/子guard帧，故外层如实failed，虽原测试已6/8致红仍未记变异合格。修collector为两流严格带可选`# `前缀的固定帧解析后，重新执行两变异及baseline，上述为新收据；不吞失败或改变被测源码。首次stdout分别 `e98d83741a18e13dc18f592f2ca9191a1ba3b541a23e81518a1948a7672c2e7f`、`8dfb03877774e44156f61c1ab221ef98679ed939f13ae26ae30697e2a8497542`。

新门SHA `2295ae9e43f520a09249df17d8080ed8d08030f6d5210fe2ca072972baf01825`已只读核过两份既有真实整应用收据：旧f443的manual页面组合和旧a06的interval在途组合均被接受；它们仍只证明各自记录与新门兼容，**newSourceFullAppProof=false**，不代签新源。新增测试通过既有full-app-contract文件import进入原CI命令，不新建泳道/工作流。

新6778项sourceSet `128f76ba6dd5e401fb6bb6be5cf47c8c035336fb9f3804518087006749200eea`、archive `28918a8242f29a98576ef2fccdfcb16d79413cb6b397791c63190bb206c19927`已冻结，Windows源/固定HEAD/空index核验通过，正在准备owned原生FS候选跑原合同及原完整CLI。整个目标保持active；当前尚不签新整链或正式CI，不推送/部署/客户读取/真实发送。

接入原合同命令首次实际结果 **291/293、2失败、取消/跳过/todo0、exit1**；stdout SHA `3d4d2f78fea8fea06772058c019803d27fea7731c15eb57fc037fc76b39d8568`，stderr空，源前后未变。两失败定位原full-app-contract的1373与1627，是两处完整验证调用链的静态正则仍要求旧`validateAutomationEvidence`之后紧邻log验收，新加的强制YidaAutomation调用正确打破旧串。拟仅将两正则同时收紧为“保留所有旧门+必须有新增门”，不删除原检查或移动实际gate绕过它们；新增95条及实际编排段接线自证已通过。原manual整应用仍以本冻结在跑，未改其运行源码，待终结后核源再修正则。

该6778源的原manual完整CLI已真实 **exit0/9阶段全通过**，不是只回放历史收据。stdout SHA `cbcb70ae2f85ac4df34a9314f018bd4405f8e62f66b6f74c058c2eab9cf2e4fc`，stderr空，原收据SHA `fe8cc5bd145619aea8beaf40e4db0062a676611fefe80919f73ce107593a73f2`；类型0、core/web构建、478迁移/空重放、原OFF与新页面批准/两请求/ACK/unknown/撤销、原worker/ledger与正常host.stop/PG清理通过。独立只读工具重跑所有原门与**同源实际公开新导出门**、源6778项及构建字节均通过；216原闭合browser帧ABORTED0，原只读POST202三层body完成各1，不代称新宜搭同名传输证明。编辑之前Windows源/固定HEAD/空index也通过。此完整应用绿不覆盖同时记录的291/293合同失败。

随后仅把两处原正则的唯一位置增加新函数调用要求，各旧门及原guard/编排提取负例不动。新6778源sourceSet `17242328fc82b8e2cb93b4fc5da6c7abe77fb6d9c4c0827f6be8ae080e776350`、archive `d4b8fffd5cbfc344e04da9e42226f9579a10e282cacbc25bc16d2f98847a3696`，准备前Windows核验通过；正在新owned候选重跑合同与原interval在途，尚未签本源绿。本门只保证同一受校验应用流的证据完整/一致/顺序，不防同进程恶意伪造帧，不替代真实JWT/权限/DB/原生发送路径的执行负例与独立终审。

本最新源在`p4mAVn`的原合同命令实际 **293/293（原198+新增95）、fail/cancelled/skipped/todo均0、exit0**，source前后不变；stdout SHA `d29952274c4da8c6e32423a060f53deeb26a5537074fc96da965d21c52656ce9`、stderr空。这是已修原严格正则后的整批证明，不借前一次95绿或manual整站绿抹去291/293失败；原interval整站仍在执行。

该1724冻结的原interval完整CLI已真实 **exit0/9阶段全通过**，stdout SHA `c30a0002ea9f084842825d34436b651d4f6b305eef87267ca6f1fddf83d49edd`、stderr为空，收据SHA `4ffe6102e04bdb7722c42f677cb9416a45c3e03be79a1808cfd267d9d1725e52`。新公开门在原CLI的真实接受路径实际执行；再由只读工具重跑同源所有原门和新公开门、6778源/构建字节/原478迁移均通过。原132个browser帧ABORTED0，实际stop与production-stop验证各1，正常PG停止删除；parent停止后dispatching未决的事实及manual-only请求类型不改。结束后、下一场景开始前Windows源/固定HEAD/空index再次通过。当前同源manual完整CLI另起新owned库正在运行，不能借128f前一manual的绿代签本源manual。

同源95纯门又完成可重放收据绑定：四源SHA集合 `2a4893165fc639ae24bdd922c6afa5344935522d62740fc8700e63a86d282ff2`，三个工具SHA集合 `69521780ef618e05527004007ffc03bba63b524101d28a96a29c6874587b77f6`，运行前后源/工具全等；实际loader帧绑定原module SHA `2295ae9e43f520a09249df17d8080ed8d08030f6d5210fe2ca072972baf01825` 与内存变异后的SHA，未改磁盘模块。baseline95/95 stdout `57928476ef800b28683d039c29dfcc5c61ed7327a11400927b01081fbe4974d1`；execution删门89/6失败、变异module `257fbeeafa6d8d50ec40829cee458f6fb6fa96e219d9a02f65cf63b7dc052cb4`、stdout `0cce7f480b7e311cb004bd3d0a7e8df86be0f83603becfeaf47cc4d88030ccef`；inflight删门87/8失败、变异module `2ceea34da3dd276c28ea2fee2291b48fca91873c70d051e8645ffe1e3c6413ba`、stdout `f0963227bad02a7d79fcea665e52447030449acff1c818d82ec2579d83077299`。两真实测试exit1、0pending/skip、父子两guard禁止IO/env0，外层证实致红才返回0。

## 较早通过：原完整应用的在途 host.stop 与晚有效 2xx

新6776源 sourceSet `a06eb2274d8da836f9f174c5bee528fe6340017669a3e67e2209286b6fe11b35`，候选 `7h3apr` 原完整CLI interval **exit0/9阶段全部通过**；原harness/完整web类型0、core/web生产构建、478完整迁移和空重放、原只读interval自然触发/真实浏览器/OFF/初始化全部保留。stdout SHA `b5dc7f569638c7896d587db10330878e2637c490e37e9c7c835834991b1298a8`，stderr为空；收据SHA `d47da74a55381c3774dfc53b32df0e4579e0d5eb2238c464ae5fb78929d16d5d`。独立只读审计原校验器、实际6776源和core/web构建字节及精确新帧全部通过；Windows原生源/固定HEAD/空index在准备前后和验收后通过。

真实main/密码JWT/已安装绑定/原shared worker/native sender，第一行ACK、第二行dispatching且原fetch仍held时开始真正host.stop；不是单独调用子runtime.stop。测试不自行abort生产signal：实际host.stop触发该signal，stopRequested之后才观察到abort；释放晚回包前stop仍pending、主PG池仍开，随后释放有效201。真正stop同一Promise被重复调用验证、实际等待完成；主池结束后，用独立真PG client读取**同一个owned库**：第一行closed_observed/acknowledged不变，第二行admitted/**dispatching未决**、used2/max2、active串行位true。原已审parent撤销边界不允许补写，因此明确 **outcomeUnknownCommitted=0、unresolvedDispatching=1**；绝不将其表述为已提交outcome_unknown、业务成功或完成对账。token/form各2、refused0，无第二CREATE、无退款，真实发送0。

晚回包后实际host.stop成功与原production-stop-verified各1、无对应failed；观察client真正end、主/源池/监听/maintenance与两个collab客户端原清理门全通过；原owned PG正常停止删除，没有应急清理替代正常门。132闭合原browser诊断帧ABORTED0；本场景为原只读interval，所以不要求或冒称只读manual POST202三层body帧，新宜搭请求由Node HTTP而非页面驱动。上一冻结6775的真实页面批准/两请求证明不自动转为本源；本源manual完整回归仍待补。

本源原契约整文件198/198见下文；仍需主应用unknown且有剩余行/预算、重新确认永久CREATE围栏的独立负例、新增SA06D证据帧接入原公开CLI的强制验收门（当前另一次本地审计已核，不代称正式CI gate）、同源剩余回归及独立终审。完整目标未完成；没有推送/CI/合并/部署/客户读取/真实发送。以下保留此前错误oracle与首轮失败，不以新绿覆盖。

同一6776源又完成原公开 `run-stock-preparation-yida-browser-ci.mjs` 本地回归 **71/71=66业务+5哨兵、失败/跳过/todo0、exit0**；stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr空。独立原task validator、owner/source哈希、task/report闭合与receipt SHA `9a62cf9baf4705b553bed7b5e873f5bdfa53c3c3c3e38692f4ba92529ede7d02` 均通过，原namespace隔离和`stopped-owned-pg-removed`获证；验收后Windows源/固定HEAD/空index也通过。此71只覆盖原owner/初始化模块，`newSa06dBrowserProof=false`明确保留，不冒充新授权整页、正式远端CI或真实vendor联调。原完整CLI与71均已终结，当前没有留运行中的合成环境。

## 本轮实施与失败对照：在途真实 host.stop 与晚有效 2xx

只增加既有范围的合成验收，不新增端点、环境开关或生产模式：原完整CLI manual保留上一轮实际页面组合；原CLI interval先完成所有既有只读interval/OFF/初始化/真实UI规则/停止正控制，再通过实际main密码JWT、实际安装绑定及原shared worker提出manual-only两行有限请求。第一行ACK后第二行进入真实090账本dispatching，原native fetch接收到的实际AbortSignal必须尚未取消，假vendor故意暂扣第二个Response。该场景不是“宜搭自然interval触发”证明，后者不借原只读interval代签。

仅在原真实停止入口即将执行时打测试观察标记，**不主动abort生产controller**；真实host.stop触发原signal，测试确认stop仍pending、主池尚开，再释放故意迟到的有效2xx。最终用另一个真正PG client只读同一owned库，按既有parent撤销合同要求第二行保留真实dispatching未决/request admitted/串行占用/次数不退、第一行ACK不变，不能将其叫作已提交outcome_unknown。首版错误地要求terminal unknown的失败与纠偏依据见本节后文，未改生产guard或补写历史。主pool必须已经关闭；只读client也必须在原timer清零门之前真正end。新证明失败单独记为inflight-stop失败，不篡改actual-stop-resolved为actual-stop-failed。测试失败finally始终释放/拒绝本测试假IO、恢复自动flag，避免夹具卡死真实stop；原手动发送flag始终OFF。

冻结6776源sourceSet `92048b3e92d4ab4ed1360e6a4bdbef99fb09fc6c13db9e6bc60246540d30102c`、archive `21be549551cdbf1103ae5cf49cb0ae78a108495985162bce89fef4d40f3066fa`，Windows原生源/固定HEAD/空index准备前核验通过，正在准备原生FS owned候选。保持原CLI/生产发送器/停止链/超时预算和所有原门，不借旧6775的UI/197/302或旧71/interval绿为本候选通过。全目标保持active，未推送/CI/合并/部署/真实数据/真实发送。

本源原契约套件已实际失败 **195/197**、pending/取消/跳过0、exit1，stdout SHA `b20dc54a7ec502b9d9de56ce3e03d0d5810a00b5a3315dad000bcc3333954c58`、stderr空。两失败均调用原 `executeActualStopFailurePath`（源1252/1268）；该夹具把真实MTS finally片段直接放入JS VM，新片段含合法TS `as typeof import('pg')`，只读同片段解析对照明确SyntaxError。不是host.stop真实执行失败或业务守卫被绕过的证据。拟改为原TypeScript转译后执行真实片段、补齐显式无inflight上下文，并加“独立探针失败不得伪报actual stop失败”合同；原前序失败/缺collaboration/拒绝stop三条检查和变异全部保留。当前原完整CLI仍以未修改冻结源码继续，尚不改运行中的源集合或把195/197说成绿。

首个在途完整CLI也已失败，不得洗绿：`6Wo0iw` interval九阶段到configured-app前均0，stdout SHA `fc640a5e78c1e6c365d84344a30d9bbf5c1f247ce8d6331350f422b5b73ef02d`，stderr固定失败标签，收据SHA `e0aa334ebaea94dd212b8f8600c0f486beaf755abf9d8ca78623a742efb5b8ea`。真实停止观察已走到AFTER_STOP；token/form各2、refused0，held/stopRequested/abortObserved/lateDelivered/signalAborted全true，abortedBeforeStop=false；actual-stop-resolved成功，inflight后验失败使production-stop按原前序门拒绝，工具随后停止删除自有PG，编辑前全源审计通过。旧候选没有输出后验行的固定状态，因此不凭此冒称已读到任一最终状态。

Oracle纠偏依据是**早于本候选已存在**的设计MD“停止后的真实未决事实不能被美化”和实际host真库测试 `stopping after form dispatch...`：parent停止后不绕过父取消/当前fence/实时权限补写terminal，保留真实`dispatching`未决、admitted/used/串行位，晚2xx不得ACK或恢复CREATE。原send叶级的“仅调用者取消、parent仍有效”才可能提交outcome_unknown，不能移用到实际host.stop。故本轮只修新增在途用例的预期与固定元数据为**unresolvedDispatching=1、outcomeUnknownCommitted=0**，并补输出封闭行状态；不修改生产授权/停止/terminal writer，不把dispatching叫作已提交unknown。这是回到原方案而非降低原安全门；仍需真实后验对照，当前不签通过。

原契约VM夹具现使用已有TypeScript仅转译实际截取的finally，显式无probe上下文，并新增probe拒绝与actual stop成功分离的执行负例（预期总198）；前序失败guard删除变异仍执行原代码。新6776项sourceSet `a06eb2274d8da836f9f174c5bee528fe6340017669a3e67e2209286b6fe11b35`、archive `f615e2b66e6f5acb3b17a535bbc87140f3e599a3d05bdab4501d2ea933cce9e1`，正准备新owned候选重验；Windows源/固定HEAD/空index已通过。未改在跑的旧冻结或账本事实，没有发布/真实IO。

本源原契约整文件实际 **198/198、fail/cancelled/skipped/todo均0、exit0**；stdout SHA `f03ca6b46508352135b2f74817431c9796a94a8d342dd0779d167b239807fcff`，stderr空，原源前后字节不变。原两条finally执行负例、删除前序失败guard的变异、新的probe失败/actual stop成功区分均实际执行；并非skip或把SyntaxError捕捉成通过。新原CLI interval正在 `7h3apr` owned候选运行；契约绿不代替完整在途后验。

## 较早通过：真实页面有限批准→原主应用/worker→ACK与未知→撤销及正常停止

当前冻结6775项sourceSet `f44330e141f3f4d353d2bcb21f9d79dcdc6172b17d841920a436e0f990200da9` 的原完整CLI manual **exit0、9阶段全部通过**；真实harness/完整web类型0诊断、core/web生产构建、原provider478迁移及空重放均通过。stdout SHA `90775146f2f6be55f84ad77ad0256a9d2df7f1621be60e294ac8dfa8b99388a8`，stderr为空，原收据SHA `eb6d28a63b0fc9b7da174c90596ef385226c34919adeb422683a78838033d1cc`。独立只读脚本逐项核6775源、实际core/web构建字节、全部原校验器及新增精确帧通过；Windows原生源/固定HEAD/空index在准备前后和验收后通过。

**本次是实际页面批准/运行证明**：另一个全新context正常密码登录真实main，进入真实匹配草稿项目的board；使用实际UI创建过并经真实DB核对版本/owner/slot的规则，实际GET服务端草稿并对两成员逐行owner preview，明确manual-only/两次/900秒和确认后，真实按钮POST201批准；实际按钮两次POST202运行。全部请求受单独精确armed窗口约束，实际Response身份/status/完整JSON正文逐一校验，无响应/会话/存储注入。第一行实际ledger ACK、request closed_observed；第二行malformed假2xx为ledger outcome_unknown、request仍admitted、串行仍占用。页面显示协议ACK不等于业务成功、未知禁止再次CREATE、下一请求按钮禁用；实际按钮撤销和随后只读查询仍used2、revoked、serialBlocked。没有点击人工send或调用真实远端。

父应用继续查询同一原PG的grant/request/admission/090账本和原共享consumer：两个consumer分别done/dead_letter、attempts均1；fake token/form各2、拒绝0，真实外部IO0，原业务快照未变。两flag在finally还原后再跑原停止门，actual-stop-resolved/production-stop-verified各1、无failed，正常owned PG停止删除，**这次没有应急清理替代正常门**。原两个隔离浏览器子进程合同保留；新UI由同一受校验namespace内父进程驱动实际浏览器及Vite，二者close均await完成后才发新UI验证帧。

修正身份域比较在原真实路径上对照生效：上一源真实两个preview200后未出现批准，本源同一流程已完成实际有限批准/发送合成/未知与撤销；302/302前端及两个单点变异详见下方记录。原完整CLI契约本源 **197/197、失败/取消/跳过/todo均0**，stdout SHA `6f718ad53cc5602d1fa9ab897b3ca2b7dead03242594274b36cc7427a8eafca2`，stderr空。

来源范围必须分清：原192个闭合browser诊断帧ABORTED0，原只读Automation POST202的SDK BODY_DONE/PROXY UPSTREAM_COMPLETE/PLAYWRIGHT BODY_DONE各1且complete=true；这些标签不冒称是新增宜搭自动授权的三层诊断。新宜搭页面自身有真实完整响应、无requestfailed/fault及实际DB/consumer闭环，但不伪造同名传输帧。新源未跑正式CI，也未做交互Chrome试用；旧71/interval不自动转移到本源。

**仍未收尾**：实际main上unknown且尚有未用行/预算的独立拒绝、重新确认不能绕过永久CREATE围栏的隔离探针，未决外部请求在途时的真实host.stop/晚2xx组合、同源其余回归与独立终审。当前新UI不是同键重复点击证明，旧Node驱动组合的重放证据另保留；正常完成后的stop不等于在途取消证明。整体SA-06D保持未完成。原失败/250ms租约/WSL回拨/SQL/ABORTED历史保留；无推送/CI/合并/部署/客户读取/真实发送。

## 较早通过：原主应用有限执行、ACK/未知及次数/撤销组合

最新6774项sourceSet `08566d3722022e518a1ca68c6e3856e34a97271eb4f908b3415845d13c609621`，archive `40d3390fd69ad9b24f58bd75ac573a1a0f774ed03948f879187e29077baf5d39`，新owned原生FS候选 `/home/runner/metasheet-sa06d-fullapp-36P9bY/source` 原完整CLI manual **exit0/9阶段全部通过**。原harness和完整web类型0诊断、core/web生产构建、478迁移/空重放、原默认OFF页面与main证明全部保留；真实主应用/安装插件/shared worker/native sender及真实PG账本处理两次有限请求，仅固定远端边界为进程内假服务。stdout SHA `7b290e7c5c1aba4ca701ce0fd738e6c826b26cbe1b16124ecdc829544b22f22e`，stderr为空，原收据SHA `1df281b8f139e15d21ec13daba8b47874abecdbbc198fa305a46adddc773ad4e`。

独立只读重验全部原校验器、6774项实际源、core/web产物与三个新证明帧逐字段精确匹配通过；Windows原生源核验在准备前后和本轮结束后都通过，固定HEAD/空索引不变。同源原契约 **197/197**，0fail/cancelled/skipped/todo，stdout SHA `2401626b531fbe684a493c6069c9dc701433cafd804b6894baaff7b413c1cc33`，stderr为空。这里的“独立只读重验”是另一次原校验器审计，不冒称独立人员/代理终审。

实际数据链：由真实浏览器创建并查库核对的规则，通过真正密码JWT Node HTTP登记两行、maxExecutions=2/TTL=900000的明确manual授权；登记本身token/form=0。两次真实202分别经原worker/native通道落账：第一行request=`closed_observed`、ledger=`acknowledged`，释放串行位；第二行malformed 2xx后request仍=`admitted`、ledger=`outcome_unknown`，串行位保留，used=2/max=2。每次同键历史200回执都保持原request，native token/form最终各2。发送测试flag仍ON时，另等原dispatcher真实决议：两consumer分别done/dead_letter、attempts各1，总attempts2，**不是关flag后掩盖generic retry**。该dead-letter是调度层不再重试的终态，不是远端已明确拒绝的业务证明。

第三新请求403发生在未知占用和预算耗尽同时存在时，不隔离背书唯一unknown守卫。撤销后仍used=2/serialBlocked=true，拒绝新键，不退款、不清掉未知。finally还原自动flag、人工发送flag全程OFF、假服务关闭；原业务表快照不变，无真实vendor IO。192闭合browser诊断帧、ABORTED=0；**原只读Automation** POST202的SDK BODY_DONE/PROXY UPSTREAM_COMPLETE/PLAYWRIGHT BODY_DONE各1/complete=true，不代签自动请求的浏览器SDK完成。actual-stop-resolved/production-stop-verified各1，无对应failed，原main/source pool、HTTP/collab及维护timer正常收尾，自有PG停止删除。

**仍未完成**：真实页面的批准/运行按钮→完整执行组合（当前只有规则由页面创建，批准/请求为Node HTTP）、预算尚余时的未知串行守卫及新确认永久CREATE围栏的主应用隔离探针、在途host.stop/迟到响应组合，以及独立终审。旧26等机制用例不代签这些整应用边界。没有推送、CI、合并、部署、客户读取、真实token交换或真实宜搭发送，完整目标保持active。

### 保留的候选、失败与合同修正

首6774候选326e整套失败：stdout SHA `df2fccc43fc1163feb1704714b6230aad245fe7c1624c6449c1dde5eeea42ef4`，stderr SHA `5270c7adbbb3ec38d6d4a8b26c76dcc54ba5abb9edf2391126b9621c9ebaf9ec`，收据SHA `3f2fb635b4c8989f5a9cf9eca78237c614a9c209f2e6db59bb044fad11128cf6`。阶段SECOND_QUEUED，token/form各2/refused0；原类型/构建/迁移及OFF UI均通过，但新测试错误等待request=`closed_unknown`。代码核实 `yida-automation-execution-authority.finish` 仅ACK运行retirement/清active pointer，unknown刻意不退役；源码中closed_unknown仅为兼容枚举/校验，没有本次writer。旧26用例也只要求unknown ledger/serial blocked，未承诺closed_unknown。故只修测试配对为**admitted + outcome_unknown**并保留used/active约束，未改生产状态机；再加原consumer在flag仍ON时的精确终态/attempts断言。08566对照后真实查询与API均证实该配对。首次失败actual stop成功，但正常生产stop证明因前序失败拒绝，应急PG清理后删除，不能记为整套通过；原Windows源核验在修补前已通过。

以下记录是上述新组合首次候选的设计范围，不借后续绿涂改旧失败。

新增测试helper `yida-automation-main-synthetic-send.ts`，在原默认OFF页面和main证明全部结束后，复用实际浏览器创建并由父进程核对过的规则、原初始化operation/两成员，以及真正密码登录JWT。批准/请求由真实Node HTTP驱动，**不是页面批准/运行按钮证据**。不新建端点、worker或sender；原主应用/插件/installed binding/共享outbox worker/native token/form/090账本均真实执行，仅两个固定远端端点在进程内返回合成Response。第一行返回有效201/ACK（不等于业务成功），第二行返回malformed 2xx，要求实际ledger/request UNKNOWN、次数不退款和撤销后历史仍未决。

假服务只在真实host构造时作为fetch依赖捕获，构造后立即还原global fetch再start/login/UI；非目标请求保留原fetch Promise，两个固定vendor端点在未arm或关闭后也绝不回落真实网络。原OFF全部结束后，在已核身owned PG/namespace进程中仅临时设置**已登记**的自动发送flag字面量true；owner人工发送flag仍OFF。finally还原原自动flag并关闭假服务，母应用随后再次核两flag为未配置/false、原业务表快照不变，再走原actual host.stop/PG删除。真实token/真实表单外部IO始终无授权且未执行。

候选要求两次202、分别观察ACK/UNKNOWN后同键200重放不新增native尝试，最终token/form各2、ledger两状态及同grant used=2/max=2对应真实DB，并拒绝第三新请求。**第三请求此时同时受未知串行状态与已耗尽预算约束，不宣称隔离证明了唯一unknown守卫**；新确认的永久CREATE围栏、未知时预算尚余的主应用隔离探针、页面批准/运行按钮与在途stop组合仍未由此覆盖。

当前6774文件sourceSet `326e16cfc581524df6060235e81af9a35f335f923c8c825d81f8536380f37ac6`，archive `d6fbe777ced502f21223ede2e78aae67cb12513c97bb4bb9aaad3f6f3431c890`，固定HEAD/空索引和Windows源核验准备前后通过；新owned候选 `/home/runner/metasheet-sa06d-fullapp-Nbyg1A/source` 原完整CLI正在运行，harness/完整web类型及core构建已经进入下一阶段，**尚不签整链通过**。旧6773/197/71仅限各自原源集合；没有推送、CI、合并、部署或真实外部发送。

## 较早通过：新页面默认 OFF 浏览器 + 真实主应用组合

最新6773源候选 `/home/runner/metasheet-sa06d-fullapp-fR0u01/source` 的原完整CLI manual **exit0/9阶段全部通过**；harness与完整web类型0诊断、core/web生产构建、原478迁移/空重放、真实main/登录/production bundle均通过，原输入/产物/日志/网络及停止校验器全保留。stdout SHA `05284a992cbb47b0be35eac9bc0e9601bd3a88d76f5f94cc9e89180efefe3695`，stderr为空；原收据SHA `100ad02ad3c5241c9d9859b9548780b12b7ab45adbedf3d70773945b31f487a1`。sourceSet为`bc3adfc600e29419db9d71c763fd4def1c6ab708811b9ffa73d481df6747cc44`，与下文等待修正候选一致，不借旧源绿。独立只读核验6773项实际源、core/web构建字节、所有原校验器及两个新证明帧逐字段精确一致，全部通过；验收后的Windows原生全量源/固定HEAD/空索引检查也通过（本轮核验先于后续任何源码编辑）。

新UI在真实页面/会话/SDK中：打开无新增业务IO，实际GET规则/初始化草稿、实际POST创建规则，选择两个服务端成员，原preview返回精确403/固定错误；原始四请求四响应闭合，无stub/存储注入，未显示授权/运行入口。父进程核对实际DB rule owner/sheet/nonce/slot，grant/request/admission/ledger全0。随后原真实main有限授权窗口仍通过：错误项目/版本、scope自报、非owner管理员与跨租户拒绝，原owner明确同意的201/200重放、202/200请求重放、实际worker claim及GET/revoke/撤销后拒绝均通过，发送仍OFF。两个新frame不是互相替代；页面创建规则不等于授权。

同源原契约套件 **197/197**，0失败/取消/跳过/todo，stdout SHA `edb19563e94a1800d40c5ef6fc983d5ac167aac976471a10fb3dc2623476659b`、stderr为空。204闭合browser诊断帧、ABORTED=0；**只读Automation** POST202的SDK BODY_DONE/PROXY UPSTREAM_COMPLETE/PLAYWRIGHT BODY_DONE各1且complete=true，不签自动发送请求的浏览器body。actual-stop-resolved/production-stop-verified各1、无对应failed，原main/source池/监听/维护timer和collab真实停止验证通过，cleanup=`stopped-and-owned-database-removed`。本轮无应急清理替代正常stop，未改时间/同步服务。

对照支持的本地修复仅为新验收脚本：networkidle不能充当本次POST/UI结果回执，原生option不应等默认visible；现等实际client结果option attached，再核非空selection、完整响应与其余原门。未改生产授权/业务代码或增加超时/重试。下文三轮失败继续保留，不据此宣称所有历史CI ABORTED/WSL/租约/SQL问题已修。

**尚未完成**：新有限授权页面批准→实际主应用JWT/安装绑定→原shared worker/native fake-vendor sender→ACK/未知结果/次数与撤销的完整执行组合，以及同边界在途停止与独立终审。既有发送26/26等真库机制证据不代替此整页组合；这次默认OFF通过不等于真实宜搭发送、Chrome交互试用、正式CI或部署。未推送/合并/部署/客户读取/真实token交换/真实发送；完整目标保持active。

### 保留的失败、修复候选与工具记录

显式等待选项的首版也未通过：stdout SHA `a602282889f5b577bed019fa85e0b173a7b53e935a595688c1a998292bf3e4e4`、stderr仍`5270c7adbbb3ec38d6d4a8b26c76dcc54ba5abb9edf2391126b9621c9ebaf9ec`，收据SHA `3416184cf45c4cb181684d9958edcce7b0712693e2535c36f304a8c8e0b78212`。此轮CREATE_RULE requests=responses=3、最后responsePhase=DONE/status200，**本次POST的完整正文与规则owner/config/nonce/sheet合同实际通过**，不能再归类为HTTP创建失败或ABORTED。等待原生option默认visible仍不适合作为创建结果门；现改为attached，再原样检查非空selection、响应合同、无授权/请求及所有安全门，未增加timeout/重试。仍需下一整链对照，未提前宣称全部根因闭合。

新的6773项sourceSet `bc3adfc600e29419db9d71c763fd4def1c6ab708811b9ffa73d481df6747cc44`、archive `7d24a902e8ed73d7f7bbab6e4c965346d618cffd85a98fa804b25c6c74f98ddc`；与上版仅浏览器测试helper一文件不同，其余6772项逐字节相同。候选 `/home/runner/metasheet-sa06d-fullapp-fR0u01/source` 原完整CLI正在执行，另跑相同源原197契约套件。Windows原生全量源核验在新准备前后已分别通过，仍待本轮结束后核验，不能签本轮绿。

工具次序失误如实保留：上轮结束后先应用attached补丁，再去核对旧133c冻结，Windows核验正确拒绝（新helper长度11556、旧10982），没有绕过或将其记绿。随后新freeze及新Windows全量核验通过；该旧Linux候选自身前后字节核验仍成立，但不冒称原工作副本在那段未变。Windows审计器现只输出固定失败标志，不再把未捕获工具异常堆栈打印到交接面。

诊断版6773项也失败，必须保留：stdout SHA `77efbf96930aa6603789c3e93ebc4b9edfa5ac561c7222dd42bca73669a616e1`、stderr SHA `5270c7adbbb3ec38d6d4a8b26c76dcc54ba5abb9edf2391126b9621c9ebaf9ec`，收据SHA `1c61a3d0266e1049d6050339ae8d72848ba73a7ce227232948e123015d0a3267`。仍为CREATE_RULE requests=3/responses=2；responsePhase=DONE/status=200属于最后已完成的GET，不能冒充第三个POST已成功或ABORTED的证据。源码在该位置只click→networkidle→立即断言选择框，缺少本次创建结果的显式等待，存在提前断言窗口；此时尚不能排除其它传输失败，故未修改生产授权代码。实际host.stop成功、正常生产停止证明因前序失败而拒绝、应急收尾后自有PG删除，原运行时预算与完整性守卫未动；验收后Windows原生6773项核验再次通过。

当前仅补**实际SDK解析结果后新规则option进入DOM**的等待，随后仍核选择值、原严格响应合同与所有后续门，不新增POST/重试或增加超时预算。新6773项sourceSet `133c22bf341f0eb1ee2788771553ff4a8dd8bf4f8955e275dde194a216ed05ac`、archive `65d754306801bd188e47a886f0c3afcd56abf395a600d05c3b74576bb64dee51`；与诊断版仅一个测试helper文件不同，生产源0变动。新隔离候选 `/home/runner/metasheet-sa06d-fullapp-eqXuJp/source` 正在执行原完整CLI，尚未作为通过证据。

首次6773源候选整套已真实失败：新页面CREATE_RULE阶段requests=3/responses=2，原harness/完整web类型、core/web构建、478迁移与重放均通过。完整CLI stdout SHA `d92a6e2ca55fe6c8da8a51eae8d200ac9b88f4d1295d4d0f3466188f8267cff5`、stderr SHA `5270c7adbbb3ec38d6d4a8b26c76dcc54ba5abb9edf2391126b9621c9ebaf9ec`，原收据SHA `698b8bae9f0e22ccdb4454f0c51ce60c8936524bc6eedfb9ef45c22219e8291b`。actual-stop-resolved已出现；production-stop-failed为明确的前序探针未通过（`APP_CONFIGURED_PROBE_MUST_PASS_BEFORE_STOP_PROOF`），不是实际stop失败；emergency收尾后自有PG停止删除。这轮不能当正常整站停止门已过，亦不能凭CREATE_RULE失败猜为ABORTED/权限/序列化根因。相同源原contract套件197/197、0fail/cancelled/skipped/todo，stdout SHA `ddd847b88f3d55a843653636abe24f79f6a218b5374ff98118740118cbd6bee4`、stderr为空；不能借它盖过真实页面红。

只追加测试诊断，未修改生产授权/业务代码：固定response阶段与status计数，候选响应须走原请求身份校验，不允许因未匹配而落回普通shell处理。新冻结仍6773项sourceSet `bf7d223367f0e672a600ad7f922b3a64130662502bac57674901fc43ad44e9d0`、archive `5b2bfbf0534b6c51a636d4409df87ca9b4ecf850233becbb7a46d88ef665e0d6`，正在新隔离候选复现，不自动重跑旧CI。为减少准备耗时，**仅临时副本准备工具**增加显式native-snapshot模式：Linux仍逐项核冻结archive与实际6773文件，原工作副本相等性由Windows原生路径独立全量核验，已在准备前后各通过一次（固定HEAD/空索引/不读.env），不用WSL逐文件重复跨FS读取。原完整CLI、构建收据、输入前后核验、运行时守卫与预算不改；验收结束还须再核Windows源。该优化不把crossFilesystemCheck=false冒称旧模式通过，也不改变任何平台开关。

在原初始化浏览器完成登录、初始化、刷新与整页重载的全部原断言后，追加一个独立、逐次armed的精确请求窗口，驱动同一个真实页面中的有限授权面板：打开必须无业务IO；从实际board.fillTarget取目标表，真实规则GET与初始化GET，真实规则POST/DB版本，再选择服务端两行并调用原preview。默认OFF必须403，保留固定错误，不能出现授权/请求按钮。新增窗口不扩原shell通配允许列表，不改响应/session，不注入存储或JS调用业务API；只有已匹配请求身份可进入新增响应校验，规则与owner JSON正文严格核对。

父应用另外匹配实际DB中的规则owner/sheet/nonce/slot，并要求auto grant/request/admission与原发送账本全0；原OFF/初始化数据检查与两个原浏览器进程收尾仍保留。新增固定证据帧与原日志/正常host.stop/PG删除共同校验，不能借旧整套绿背书。此次新6773项sourceSet `e73303cda0ceaecc67e40cb790b56b8d21c03065e1fb2a4dfc45f3715ac60da9`、archive `d4fe675b38f8a6f4ec608a01c457090d350db76e6dfacf123548d775bb01f949`，固定HEAD未动，当前仅在新owned原生FS候选准备/验收；**尚未宣称通过**。这项是默认关闭的真实UI门，不代替有限授权/发送ON/未知结果整页组合及独立终审，也未推送或触发CI。

## 较早通过：新授权默认 OFF 的真实主应用门

新增 `tests/utils/yida-automation-main-full-app.ts`，由原 configured-app 在原默认OFF/初始化浏览器和数据库检查全部通过后调用；不是另起假Express、替换JWT/port/resolver或私造plugin/consumer。原密码登录token、实际安装的read profile、原初始化UI产生的operation/row、实际规则HTTP及DB版本和原shared worker连起来。两个发送flag必须为未配置或字面量false；不改全局默认、不装vendor fetch替身、不交换token、不真实发送。

候选检查包括匿名/坏JWT、body与header自报scope、错误规则版本、当前页面项目与原合成草稿项目错配、真实密码登录的另一个同租户管理员及跨租户管理员均拒绝。合法owner明示原草稿项目后才允许201/同确认200、实际202/同请求200；原worker实际claim尝试可观测后，仍要求admission/ledger=0，再走原GET/revoke及撤销后拒绝新请求。所有body原生读完才验状态，不拿requestfinished冒充完成。原业务快照必须不变，仍走原整站stop与PG删除门，无新端点/授权类型/发送开关。

新冻结6772项sourceSet `a63d05f3cea7fe23bf8c3bd276bd6169889fd76bdc608782d30f2e5b81a76da1`、archive `95c62b332f287cd285b14dbdbc504833fece0115c23abee56e6313be21e7a98b`，原HEAD/索引未改。新建独立原生FS候选 `/home/runner/metasheet-sa06d-fullapp-0qPW2F/source`，相同离线frozen依赖/禁生命周期准备成功；旧失败/成功源均未覆盖。原完整CLI manual **exit0/9阶段全通过**，实际harness与完整web类型0诊断、core/web生产构建、原478迁移与空重放、真实主应用全链及正常stop/自有PG删除。原预算/守卫/浏览器候选不变。stdout SHA `fab44d3c81ae7906dafdbbfdc1e1e3f30a16e63066b8e862ff597c9dabc502e8`，stderr为空。

独立只读重验原收据SHA `46e9fece751d937a21835aeaaa1bdd70efbd9a48f2e4a1a7a486318d51d3459d`、6772项源字节、core/web产物及全部原校验器通过；额外要求新main证明帧**唯一且逐字段精确相等**，不能在删掉新调用后借原整套绿自证。该帧证明6条前置HTTP负例（401/401/400/400/403/403）、两个真实密码登录的非owner管理员各GET/revoke拒绝，以及原owner的201/同确认200、202/同请求200、GET/revoke和撤销后新请求403。实际共享worker claim已观测；最后grant=1/request=1/link=1/admission=0/ledger=0，原业务快照不变，未建sender替身或外部连接。

204闭合browser诊断帧，ABORTED=0；**原只读Automation** POST202的SDK BODY_DONE、PROXY UPSTREAM_COMPLETE、PLAYWRIGHT BODY_DONE各1/complete=true。新有限授权请求则由真实Node HTTP原生json完整读取，不混称它已有浏览器SDK/Playwright帧。actual-stop-resolved/production-stop-verified各1、无相应failed帧，cleanup=`stopped-and-owned-database-removed`。旧6771项interval/71绿仍仅属于旧冻结，不自动转移；本轮不是新有限授权UI、自动发送ON或未知结果的整页组合证明，也不是独立人员/代理审查。没有推送/CI/合并/部署/客户读取或真实发送。

## 较早补充：当前完整源码构建、冷迁移缺陷与最小修复

为进入整应用门，用当前HEAD `69140b86619e8fa9c1bf6da9bca5af731c8f5000` 加实际工作副本覆盖，冻结原public full-app CLI相同范围的**6771个文件**（apps/web、core、integration plugin、ops及四个根/CI输入）；排除.env/node_modules/dist，不读客户材料。Windows原生打包前后复核全部SHA与Git状态/索引未变。首冻结sourceSet `7cd17552870fb82b4657232ae60159ca117111135a9cfdc55ba3f3daa290f340`，archive `efdeb702844e5794908ea69a0db7039fbe20d457d8d0d6e2a5c1e427061ca1e9`。新建独立Linux候选 `/home/runner/metasheet-sa06d-fullapp-XPpQJ8/source`，与固定Git基线结合再逐字节覆盖/复核；离线frozen-lockfile依赖准备（ignore-scripts/ignore-pnpmfile），网络namespace/capability drop，无.env，没有改写旧WZoE3q依赖副本或主检出。

### 完整门抓到两处真实缺口，不沿用叶测试绿

1. 原CLI首轮真实执行：harness-types=0、**原完整web-package-types=0/诊断0**，core build失败，未启动配置服务或数据库。stdout SHA `05a43ce91b1aadf0a524ee570b93e0f38b24ee023f2a4be6c182fa6a25aa20f1`，stderr SHA `f57734a742a6ae3a17b72d583edc2c26c0abc8545906b2a55d5216152623de71`，结果 `PLM_FULL_APP_STAGE_FAILED_BUILD_CORE` / cleanup=not-started。原构建receipt有8项诊断：execution-authority原210/211的2339、management-host原118/126/148的2344、127/150的2339、140的2345。此前strict叶检查不能签原package的strict=false配置：bind后的泛型在该配置下丢失类型，嵌套Parameters变unknown。
2. 独立全新owned PG上执行**原生产migrate.ts --latest / 原provider**，不是fixture手工排序：旧数字名098早于`zzzz20260715120000_create_automation_outbox`，真实报42P01/缺共享outbox；此前72条Success输出后整批回滚，查询shared/links均不存在。stdout SHA `c90d9969ac1fef599b2a81f2e975c32a6562b920d7859e6b943bc7e619d714bd`，stderr SHA `ddd57858950330f8bb29d53747ddc2902395411ad78f93681ee1ee37470018b7`。不能把72个Success日志当最终提交。原guard帧1、0违规IO/env，实际PG停止删除；没有给生产数据库跑迁移。

### 最小修复与当前来源

只给bound transaction/installed-source/prepare函数补显式原合同类型，并用真正InstalledSource类型替代对bound函数套Parameters；未加any或放宽compilerOptions/守卫。用同一实际TS编译器比较修前冻结源与修后源，**两个模块发出的CommonJS JavaScript逐字节相同**。

098是本任务尚未提交/推送的本地候选，不是改既有已发布迁移。将其改名为 `packages/core-backend/migrations/zzzz20261019121000_link_integration_yida_automation_outbox.sql`，让原provider自然排在共享outbox后；更新实际fixture/测试引用。没有复制DDL、加skip/exclusion或造第二迁移runner。除前置说明外SQL正文逐字节不变，正文SHA `20f217d41fd96fb37fae9415e70278fa6b67e63e4bac77a8a30e26c152346962`，原外键/身份/不可变/禁止TRUNCATE守卫全留。097与099其余正文不变，下文旧098名称和旧SHA仅为历史证据。

修后重新冻结6771文件，sourceSet `4593bc2ed213b857af9e3770331ce74f309d8a31b18884aa5289bc6827658f8f`，archive `b40f02ca1985cc0c29c51dfc54bf2c378ef49167be50436a1e1592042649e540`；新独立候选 `/home/runner/metasheet-sa06d-fullapp-wbjwNt/source`，旧失败源/产物未覆盖。相同离线隔离准备成功。

- 原生产迁移命令在新的空库执行 **478条成功**，实际shared/links均存在，未报42P01；stdout SHA `9be9d6fb7a71dc295b0c9df153d87a4b0e8e2cf5e2d2da8dba6565cb24621e84`，stderr SHA `98919dc860ad9d7c2df860ccf139f2488869250986712d7d9322ddecd50c30a9`。源未改，原guard帧1/0违规IO/env，真实停止删除。它是冷安装证据，不冒称已验证回滚或生产部署。
- 修后原CLI **manual完整场景exit0**，9阶段全部通过：harness类型、完整web包类型、core/web生产构建、原迁移list/latest/list/replay、configured-app。stdout SHA `3125e2594c7c2164410723e11c0d4268c3775e9335c2365b11a6061df0eb36c1`，stderr为空SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`；原证据SHA `24a8ace801e32e9730ec9e4259934b21bcb497f8b6298b5f38d3e410ae906904`。停止/自有PG删除通过，源6771项未改。
- 独立只读重验该原收据、全部stage终态、源SHA、core/web实际产物字节及原 stop/K3/YiDa静态/OFF/初始化/Automation/browser-process校验器，均通过；完整web package类型诊断0。192个闭合browser-transport帧，ABORTED=0；**只读Automation的**POST202分别有SDK BODY_DONE=1、PROXY UPSTREAM_COMPLETE=1、PLAYWRIGHT BODY_DONE=1，均complete=true，不用REQUEST_FINISHED的status0代替。actual-stop-resolved与production-stop-verified各1、无相应failed帧。该真实main/真实密码登录/生产bundle/初始化和只读场景证据，不是新SA06D自动授权UI的整页发送证明。
- 同一6771源集合的原interval场景已exit0，原9阶段全通过、源未改，stdout SHA `d2b733bc75be3371262fb0d8d3ad42de910575228201a05f978a6628ae2b54bb`、stderr为空。独立复核原证据SHA `14c2ac175086df0078c15c76e033d97e5381cd45ea95d61f06c42fe1ce4bec0e`、全部原校验器及core/web产物字节通过；完整web类型诊断0、478迁移成功，132闭合browser帧、ABORTED=0，actual-stop-resolved/production-stop-verified各1，实际停止和自有PG删除。interval没有manual POST202，三个HTTP完成计数为0，不拿它代替manual的正向BODY_DONE证据。
- 同源原宜搭入口也已exit0，并独立复核原task校验器、71项真实report和源字节：**71/71=66业务+5哨兵，0失败/0pending/0todo**；原task合同还要求0重试/0重复/0未处理异常。stdout SHA `77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336`、stderr为空，内部收据SHA `f8f20c33d07cd645d21d6d0a821b7c410b153c4b7a1391afd5b28f929b90a88e`，与namespace闭合收据帧及owner/source SHA对应；网络隔离true、cleanup=`stopped-owned-pg-removed`。不是只看外层exit或复用旧71。
- 上述均为本地合成证据，没有触发CI，未证明新SA06D整页有限授权组合。原timeout、校验器、source/build receipt及官方固定浏览器候选均不改；固定浏览器SHA `43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925`。不据此取消历史CI/时钟风险，也不冒称正式CI、Chrome交互试用或真实宜搭发送通过。

部署提示：本任务旧098只在已删除的临时库手工执行过，未提交或发布；若任何别的环境曾人工应用旧名称，不可据此文直接更名升级，须独立核对其真实迁移历史后制定兼容处理。不得通过删历史、假noop或跳过外键来消除此风险。此处不是部署授权。

### 宿主回归的环境失败与原生FS对照，不能混成一条绿

修后当前源在/mnt/c执行26项：最后观测18通过/1失败/7未完成，90秒SIGTERM，无完整JSON及最终guard帧，不能称其0违规或全通过；有真实DB时钟回退**602ms**/水位拒绝帧，但不能仅凭该帧断言后续超时唯一根因。stdout为空SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，stderr SHA `00c2d6f50e01ef41d9c0b798233e61c634f30b018fcee34d0e24fda61bb5af2f`。源不变，实际PG已停止删除，没有动时间/同步服务或测试预算。

将23个本任务临时驱动按SHA复制到修后Linux原生候选tmp（不改生产源），同一实际源码55来源sourceSet `67a7417c0ff3ffcb5be2a3067c439f0f4744fdd279e54dc7fb65124a606442c5`，在原90秒预算执行同整文件 **26/26**、0suite失败/0pending，最终guard帧齐全/0违规IO/env/实际停止删除。stdout SHA `121cadc6c3ee56811ea4f87d495b710bf64c815b89255f7e151dc26846cfb668`，stderr SHA `51e2b78c89519b382193b64b5c79ee94dc502a6086680cee245f5fad9ce64f58`。这是文件系统位置的对照通过，不是证明WSL时钟或p9根因已修复，旧失败继续保留。

本节尚未证明新有限授权UI与真实JWT/main/sharedloop的整个浏览器组合，也未获独立审查、正式CI、合并或部署授权；原初始化/预览验收不被新功能替代。目标保持active。

## 较早补充：有限授权 UI、真实版本响应和前端原链回归

新增 `StockPreparationYidaAutomationPanel.vue` 与固定路由客户端 `services/integration/yidaAutomation.ts`；项目备料页→原宜搭预演面板显式带入当前 projectNo/已核实 sheetId/scope equality key，点开新入口才读取，不在挂载时请求、创建、批准或发送。保留原初始化/人工单行面板；有授权或不确定命令时锁定相互影响的操作，切项目/账号/上下文或卸载同步清空并取消，晚回包不复活。原先8处工作区改动保留；必跑脚本/名册只追加本新套件，未整行覆盖旧队列。

UI只读本地初始化返回的真实operation/row引用，要求**所有已选行**通过原owner preview取得服务端内容、目标与摘要后，再明确确认项目、manual/interval、1–10行对应的有限次数和1–900秒期限。没有放开原owner preview的发送流程开关：OFF/拒绝时显示固定错误、不用本地JSON代替预览，不允许批准。新规则用既有POST显式创建并启用，仅保存slot，无grant；既有规则响应仅为该私有动作增加合法DB `integrationAuthorityRevision`。普通动作与畸形版本不回显，不从请求体接收nonce，不需要用户手填版本或授权材料。真实管理API仍独立重验JWT tenant、严格owner与live权限。

规则创建回执未知只保留原slot查找唯一GET结果，不再发POST；授权/运行请求未知只保留原命令键及原参数，绝不自动重试或另建预算。已有grant可以按标识只读查看/撤销，但不会恢复定时或手动资格。`dispatching/outcome_unknown`明确显示结果未确认/禁止再CREATE，ACK明确为协议应答而非业务成功；观察到原行ACK后才允许显式提出下一已批准行请求，不把受控多次数缩成只能一次。撤销仍说明远端可能在途，不冒称远端撤回。

### 当前本地结果（不是正式CI或完整应用）

- **5个前端原整文件296/296**：新17项、原宜搭初始化/人工发送/静态预演183项、原项目备料页面96项；完整JSON、0suite失败/0pending。实际Vite+Vue插件编译当前SFC、原客户端调用，只有fetch替身边界；不是替换客户端、手拼按钮或纯AST背书。stdout SHA `61da6786febf0b5d19474bc0097199c7d2c09b02358ef4dc5a4fff6be15ccfed`，stderr SHA `027f68ebcd7578df0ba3fa1dcf87411d5722deb40d4fd893dc8917af76d37281`；48显式来源sourceSet `db4a6912e6c0658f429df8ed4265b87eba96bdc3660dddffbeaf808787c557d0`。新增测试在无自动IO、真实逐行预览门、完整有限命令、A→B→A、账号变化、未知授权/请求恢复、未决/ACK反馈、规则创建不确定、历史只读恢复、流式1MiB上限和闭合DTO等路径取证。
- 去掉新客户端所有await前后共用的**会话相等性检查策略**（一个策略，不伪称每处调用独立变异）：同4文件200项 **199通过/1失败**，精确命中“token变化后原fetch仍返回成功，必须拒绝晚回包”。原进程exit1、0额外suite/hook/setup失败/0pending。stdout SHA `fd39a8355bf67bc866ec1ba2debfadd857a6d07a83dbebb6aba1a07b70a78e0e`，stderr SHA `59ab724dc098d071586a1fcfa1e5ae1bafe055f920b9ea425e8b8cb29dd85672`，47来源sourceSet `bb1261457f96cdb565ec9ab80dae5a2280bc56dd6e5c453f52719967dcf669ac`。下层服务端真实JWT隔离不能由此客户端变异代签。
- 后端原5个纯单元整文件 **203/203**（新增私有动作版本序列化正反例1），stdout SHA `17c535c936a622958f6654db8fcd2a50d0cdbc496ca9fc62c7ed1e11ca32dc80`，stderr SHA `ee049a8f9f57e50917b05a1215b239f64307fe5f860c478698761dedc952a984`，55来源sourceSet `dcaa14af19583b259905b1ca0a07e51dcd405ee36437b0e5522587324b879142`。真实service保存/migration整文件 **9/9**，已断言实际DB生成nonce经真实mapRow→serializer回到响应，stdout SHA `f1481afee7d2e3b8edfd8d5fd75d8ecc16634442bf82a574c28ad600ab7ac176`，stderr SHA `7eaf975134cd8b9c0541f0b4bfbf9957f1ca8ff90a2af2477c0edf742f7197ac`，42来源sourceSet `995e03012390a17ff4434597b624c40d93e3ab1342afc92d63139e97df67cece`。仍非完整JWT保存路由/当前main启动。
- 新SFC及新客户端独立 **真实vue-tsc严格/noEmit检查0诊断**，沿用原Vue DOM配置及erasableSyntaxOnly，不是全web类型检查；stdout/stderr均空 SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。首轮2项自有诊断（参数属性不满足erasableSyntaxOnly、Object.hasOwn库版本）已改为显式字段赋值及hasOwnProperty调用，没有放宽lib/strict。后端检查仍3项已与原Git blob对照的旧executor/service错误（service当前3777）及其它51项，完整backend类型检查仍不是绿。
- 必跑脚本新增独立 `tests/YidaAutomation.spec.ts` gating invocation；用原 `required-web-lane-token-manifest.mjs --write` 生成并check，当前630 distinct tokens/21 invocations，工作副本名册与脚本集合一致，未手改tokens、未新增workflow/触发CI。不是声明原630项完整脚本已执行。

以上测试仍用原90秒预算/原安全preloader，0违规连接/env、原磁盘源码前后相同、实际临时PG停止及目录移除。web测试本身要求allowedConnections=0，不因包装器起过PG就冒称前端测试是真库。仅在本工作树先验证无既有apps/web/node_modules，再创建到本机既有Linux web依赖的ignored链接；不安装/下载包，不改全局配置或共享native源码。独立tmp配置使用实际当前源与已装依赖，测试不联网，不读.env或凭据。

### 本轮工具与测试失败保留

首轮前端 **197通过/1失败（198项）**：新方法在参数校验时同步抛错，而新异步API用例要求Promise拒绝；统一public方法为async后旧198项全过。该红stdout SHA `c7b7aba14730003a6e0f10b67127aea9a9c78bc08858cc3e45fa0903e4bc0cb3`，stderr SHA `a3a3d6a6cb9bf14d2410119162f182196c7dc6644b422c89e423838d5c1fc34a`。之后补日期域/历史恢复为200项，先200全过，再扩项目备料页为当前296；前者SHA `4fbb5f76ab74970bd1814f227e7cbb092a54d324b5d4c40ad7c535d153786a91`/`a5e3c5c3ad925e08b9de20750993d31edcd71e6f6c7f26d5e0aecd43f6de7d4f`，不与当前48来源混用。

首次会话变异未收集用例：临时web配置继承backend mutation校验误拒web枚举，stderr SHA `9556abc4698ef919725abab5a0250ac6b4ef6a75fbb8aa8c60487dfd8c4f10d8`；只修临时继承链。随后200项198通过/2失败，其中一条是真实目标、一条是测试公共源码路径的`new URL`被Vite asset转换为非file URL，不能作为“无额外失败”的变异证据；stdout `2b143bc47ed55093ce77bafb53382ea92e542dafb8ae90e72a1fadecbad6a3d7`，stderr `b4515d1c1acd2eb2b65436771a3aaa6c2d2fe9d1404c3e9fa6619886766be9fe`。改用显式NodeURL读取同一生产路由常量，未换断言或伪造路由，再获得前述仅1目标失败及当前296无变异全过。所有失败清理成功，旧WSL p9等待/ABORTED/租约/SQL/版本风险继续保留。

### 下一依赖，不能借单元数字宣告交付

当前UI/nonce/受控interval已各有本地证据；仍缺**当前完整源**的core真实JWT→实际安装/plugin→sharedloop→新UI浏览器的组合验证、当前production build/整站启停清理、相关全局守卫与独立审查。不能用假fetch的296项、叶类型0或较早原宿主26项签完整应用，更不能用旧71/旧head CI签本地新源。没有提交/推送/CI/合并/部署/客户读取/真实token交换或发送，目标仍active。

## 较早补充：有限 interval 实际接线与本地原链验证

当前不是第二调度器：原 AutomationScheduler 的锚定 interval/单航班通道新增识别此私有动作，实际 AutomationService 可选第九个producer只转交闭合 occurrence，actual core index 指向当前管理host。普通executor仍整条拒绝。私有slot只在显式新consent的已知COMMIT后绑定真正grantor和grant，manual-only、历史重放、重载不自动升级；不同确认先撤销，不选latest。每规则单一指针、表含pending固定上限256，停止同步清除；历史事实不删。每次独立重载DB实际版本/created_at毫秒相位/严格interval/DB now，拒绝未来或已过一个完整周期的触发，摘要由服务端固定tuple生成，再走原live材料、有限store和原outbox；默认10秒取消预算不抬高、不放弃原SQL/COMMIT。

**同当前55显式来源** sourceSet SHA `b3d63a6041be2f2685201d732eedfd2a2abde4f9bd72c2fdabbc25b1ffaa2471`：

- 5个纯单元整文件 **202/202**（原201+真实scheduler相位/显式producer接线1），完整JSON与五文件三阶段齐全，0suite失败/0pending。新增用例用假时钟但是真实scheduler和service，验证半周期注册也在原created_at相位触发，不从注册时刻另起；producer缺失仍零普通IO。stdout SHA `e166dcffbf85b3eceb22905b98c7559a352bdc0fc6e9c98483f29e00673b22c9`，stderr SHA `25cccfbccbcc924716dd694614883cea0177c05043e6ce90ecd98d600973238f`。它不是DB或浏览器证据。
- 当前真实PG宿主整文件 **26/26（25业务+1隔离哨兵）**，0suite失败/0pending。stdout SHA `d9d1418927253586becd96926839343e638aed9d58b1f85a0db003184f7810a3`，stderr SHA `51e2b78c89519b382193b64b5c79ee94dc502a6086680cee245f5fad9ce64f58`。原21项保留，新增5项：显式interval许可→实际installed source→原reservation/outbox→原shared tick→原native fetch/ledger ACK和同request退役；同一occurrence只入队一次；无授权/manual-only不借DB最新grant；不同confirmation拒绝替换而显式撤销后可选新grant；重新激活后的历史确认重放不恢复slot；错误anchor/interval/未来时间/自报principal/DB新nonce均拒绝，0额外outbox/token/form。

原unknown→新confirmation→永久CREATE围栏用例仍走真实native sender：新增第二授权明确限定manual，不占用/替换旧interval槽，验证原永久围栏仍挡第二次写；未删原ledger/admission/count断言。不是靠新增槽冲突代替原CREATE围栏自证。

两轮原90秒预算、零违规连接/env、源码前后相同、实际PG停止/目录移除。原宿主fixture中预期负例rollback帧不被误报业务失败。固定入口AST审计仍69/69、unknown0/independentCoverage/全局JWT之后唯一router；只是静态审计，不冒称完整attendance HTTP或真实main启动通过。没有推送/CI/客户数据/真实vendor IO/合并/部署。

同当前55来源内存单点变异仅去掉“历史reused结果不得发布interval slot”的条件，原宿主整文件 **25通过/1失败**，精确命中重新激活后的历史确认重放用例；错误重新登记slot后真正进入了下层authority并被DENIED，而原路径应无slot、无producer工作。0额外suite/hook/setup失败、0pending/0违规IO，磁盘源码不变，原进程exit1，实际PG停止删除。stdout SHA `b4e604768c9c7229c1c69dda89b1f38bdcdcb4bb2041a6d594121e0d9af95483`，stderr SHA `21ad7f6c1abd15737a8a0047156907f234b316aee773c4abae9b2b524541286b`。这证明历史重放测试能观察错误的宿主恢复行为，不代表下层授权守卫失效或已证明绕过所有层真实发送。

当前 strict/noEmit 仍仅3项已与原Git blob对照的旧executor/service问题（service新行3776），其它51项传递诊断未修；新interval/host/单元/迁移测试无新增自有类型错误，但**全backend类型检查仍非绿**。只读入口AST仍原69，无新增scope默认或全局门修改。

定时接线后的当前来源另重跑实际 authoring/migration 真库整文件，**9/9**、0suite失败/0pending；stdout SHA `500074fc3c2c805ee6f2a2d3c95fc3f2a9dc7e497ba29c15f4d526a3c97d050c`，stderr SHA `7eaf975134cd8b9c0541f0b4bfbf9957f1ca8ff90a2af2477c0edf742f7197ac`。本配置显式42来源（含实际scheduler）sourceSet SHA `c661e411fd6d750b24ef645ef09ccc3dc4783616519971a9ecef9ff6dfeeec80`，源未漂移/0违规IO与env/实际停止删除。它证明实际service保存→DB版本→installed材料→显式consent仍有效；仍非真实JWT保存路由或整应用浏览器。下节旧9项红绿来源和migration变异证据保留，不互换sourceSet。

仍待完整应用真实JWT→当前宿主/插件/sharedloop与browser验证、UI授权/未知结果反馈、全类型及相关守卫、独立审查；没有把26/202/9当整目标完成，本节26项规则来自自有fixture，不冒称来自真实JWT作者保存路由。全部本地进程已终结并获清理证据，Git index未加入本轮改动；未推送/触发CI/合并/部署/客户读取/真实发送。

## 较早补充：原预算回归获证；继续有限 interval 接线

对上一节记录的两次超时补本机诊断，而非盲目重跑：临时配置增加五个原整文件的 TRANSFORM/BODY_ENTER/BODY_EXIT 固定枚举，原文件/测试/断言不删不改；父进程仅投影闭合诊断。精确选中本任务 runner 的子进程线程，观测到等待 `p9_client_rpc`；这只是当时的WSL文件系统等待，不能证明唯一根因或已修复。

该诊断轮在**原90秒预算**内完整201/201，0failed suites/0pending、完整JSON与最终隔离帧齐全；stdout SHA `d06f40e9342a84ede94ef9175f58a913e96288c1a6e983a6774c3557db14ec1b`，stderr SHA `e77c065e3dfeac622a0959a636e64d47c91c9b55c5159ea8a9336764a785ff16`，54来源sourceSet `1b5cad900a4b4893abb2b9ba5759cf48aeafd5d47754c80c2f255c019d577362`。五文件均有完整三阶段，源未变、0违规连接/env、实际PG停止删除。未调预算/重试/过滤断言。前两次51项后SIGTERM仍是同来源历史失败，第三次绿不意味着p9等待原因已解决；也不是CI或整应用验收。

随后继续同一批准范围：在原 scheduler 的锚定 interval 通道提出 occurrence，实际service仅调用显式私有producer，不回落普通executor；core boot明确把该producer接到当前授权host。host只在owner新确认的原COMMIT已知后登记私有slot，一条规则一个明确interval授权；不同确认不得暗中替换，必须显式撤销旧项，manual-only确认不附着slot。历史replay/重启/重新激活不恢复定时资格，私有表有256条上界，关闭即清除。每次触发从原DB行重验版本、真实created_at相位、严格interval、当前数据库时间、live材料/ACL与有限授权，再沿原reservation/outbox/consumer/native sender；无新端点/第二调度器/全局默认翻转。新实现和新增真实路径用例正在本地验证，**不能把前述201或9/9签给后续改动**。

## 较早补充：规则真实保存、旧新迁移和数据库最终行保护

本轮继续同一 SA-06D，不新增端点或功能切片。实际动作列表、public parser、AutomationService 的原始 create/完整 merged update、普通执行/模拟/两种 continuation 已接上私有动作形状与整条拒绝。规则只保存 slot，不保存 grant/tenant/owner；未配专属 producer 时 scheduler 明确拒绝，不能降级到普通执行器。新动作可以保存不是自动运行已接通，更不代表发送资格。

新 TS 迁移 `zzzz20261019120000_add_yida_authorized_automation_action.ts` 使用冻结历史 action 集合、保持原 read-shape CHECK，独立新增最终行 CHECK；up 在锁内原子安装并可重放，down 拒绝保留私有规则和任何自动授权历史。不执行生产迁移。文件 SHA `2980d3afd837cccd769a98bc4ffd3feaf6fd7cb942025fbb4e97e49253625bfc`；策略 SHA `b07b510898734e1da22d4232fd9f9a1c27fe4f7dcf85eb2ec351e47e0e42b8f3`，实际 service SHA `08cac68da20d8ff944b49fc65e337f471179830926938d6b384bf184d9a4f4a1`，真库整文件 SHA `b58801d2d89cd321d922be08fd17040298719746430d17ee2c1053701aaa26e1`。SQL char_length/btrim 与 JS 的 UTF-16/Unicode trim 不完全等价，执行前 JS 守卫未撤，不签 Unicode 全等保证。

### 真实 PostgreSQL 整文件

`yida-automation-authoring-realdb.test.ts` **9/9（8业务+1隔离哨兵）**，0失败/0failed suites/0pending。执行真实既有 revision/read 迁移与新迁移，再用真实 AutomationService 保存，不以截获 insert 假装持久化。覆盖：

- 未安装新迁移时旧 action CHECK 真拒绝；安装后可保存，DB 真实产生版本，实际 installed source 重新装载该规则，原 management factory 能以真实版本完成显式有限授权，used=0/canSend=false/outbox=0。
- 13种直接/部分 SQL 非法形状逐项被最终行约束拒绝，失败后原规则及版本不变；保留原 read-shape 约束，普通 config 中的相似文本不误判为可执行节点。
- up 重放不重写规则/版本；存在私有规则则 down 拒绝；真实授权后删除规则并撤销授权，down 仍拒绝保留历史；空历史可 down/down/up，回滚期间旧枚举真拒绝。

stdout SHA `098178b9efbc962815dfd4b8ec8cb39c5c62462f58b16c4424e6c7670814d508`；stderr SHA `7eaf975134cd8b9c0541f0b4bfbf9957f1ca8ff90a2af2477c0edf742f7197ac`；41个显式来源 sourceSet SHA `3de33d5647186b10eb427019906b043c0b7a37ae9c2ad9394bb9040dae5d3e15`。源码前后一致，0违规连接/环境读取，实际 PG 已停止、目录已删除。新套件显式排除默认无库收集，仅本地独立配置完整运行，未接线或触发 CI。

首轮 **2通过/7失败** 如实保留：新迁移动态 SQL 内枚举值引号未隔离，共同失败为语法错误；stdout SHA `b03b505e61b4e69a543cca7910283e02269c0eba5ff770de40675be164026621`，stderr SHA `9984e1fac733aa9f295b870918a2a2e247d8e70203805ccb54747789a8105b48`。修为独立 dollar quote，未改约束允许集或放宽守卫，随后重跑9项获得上述通过。首轮也已真实停止删除，无客户读取或真实出网。

同一真库整文件内存单点变异仅去掉新迁移的 exact-config 等式：**8通过/1失败**，恰为十三种直接SQL矩阵，非法附带授权字段被接受使原拒绝断言失败；0额外suite/hook/setup失败/0pending，原进程exit1。stdout SHA `66a822440f8247509a2160e848a7d9603c471a5e2524cce0be51bcd86eb7f74a`，stderr SHA `5ff3772739791d41faa36d3ffdcbf227a69c111131bee85a1ceae4d61c134187`；与9/9相同41来源sourceSet，磁盘源码未改、实际PG停止删除、0违规连接/env。外层exit0仅表示变异被杀及清理确认，不是把原失败改绿；单一矩阵致红不证明13项各自独立变异均覆盖，更不替代后续完整应用/调度测试。

### 纯单元与类型边界（不冒称真库或完整应用）

此前5个整文件201/201（新 authoring31 + 既有 read73 + routing/consumer/logging），0其它suite失败/pending；stdout SHA `0d62f70cde87de70468930f0353e4d70b6760ce188106881a44b8e963434651e`，stderr SHA `f872954be37002b392b4711c4725f03987de9703f2c5d4da0c1faa793a909132`。它发生在最后新增 migration-error 映射之前，不将旧sourceSet签给新文件。service-save 单元截获DB写意图不是持久化证明；真实持久化证据仅上节。

当前54来源 sourceSet `1b5cad900a4b4893abb2b9ba5759cf48aeafd5d47754c80c2f255c019d577362` 的重跑 **未完成，不能报201通过**：原90秒外层预算触发SIGTERM，最后进度只观测到51项通过，无完整JSON报告或最终guard帧。驱动打印pending=0来自当时已收集51项，不能用于宣称全部201已完成/无未执行项。stdout为空 SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，stderr SHA `abba8e855985ff98825f0023987adfd773e78df807e1e8314726bce3cecb8a80`。源码前后相同、实际PG已停止删除；没有调高预算、skip或改retry，具体超时来源未定，不归因为唯一资源问题。上述9/9真库不受此证据替代，也不能掩盖该回归未完成。

同201整文件内存变异：仅去掉最终 merged update 私有形状门，197通过/4失败（stdout `f7dfc23eac605c8adebd381fc09c2d2f9823e7daae79559db1ae27d17a13c5f2`）；仅去掉 execute 顶层整条门，保留单动作/续跑门，199通过/2失败（stdout `5c318b583be7159dd3af32c584e8714f54e5291996a145d1026056b51a8cf961`）。0其它suite/hook/setup额外失败/0pending、实际清理通过。普通 webhook 正控制真命中注入fetch一次，私有动作零IO不是不工作的替身造成。

前两轮单元收集曾分别124通过/1失败+1suite失败、125断言通过但1suite失败，不算绿；原因包括显式 undefined 输入用例与实际 web policy 的 Vue tsconfig 解析。未更换原 web 模块：局部临时配置只将该无依赖纯TS的当前真实字节转译为JS，锁定realpath、拒绝import/parser错误；这不代表SFC编译/完整frontend typecheck通过。原失败 stdout SHA 分别 `9c3cb866b47a56558a67b29b08509b6659580808ca64ee8c3792b7de9b75455f`、`b9277163fbc461bebd8c72f5b6b34875cdb8af229570cf9fca37b9d5c76d4adf`。

当前 strict/noEmit：新测试的 Kysely<Database> 与迁移 Kysely<unknown> 不变性错误已用同一自有池的显式 migrationDb 修正，没有 any/cast 放宽。检查仍有3项旧 executor/service 错误，另51项传递模块错误，**全backend类型检查未通过**。此前按 Git HEAD `69140b86619e8fa9c1bf6da9bca5af731c8f5000` 的三个真实 blob 校验并在内存替换编译器输入，证实相同3项在原行号已存在；旧 enum 对新测试额外不兼容也未隐藏。未改无关旧代码掩盖失败，未输出构建件。

仍待：有限 interval 真 occurrence/明确 slot-grant 关联、完整应用真实JWT→当前宿主/插件/共享loop、UI授权与未决反馈、整站/浏览器/相关守卫回归及独立审查。保留旧 ABORTED、时钟回拨、SQL57014、租约和版本断言风险；本轮9项不是71项或正式CI的新证据。禁止推送/CI/合并/部署/客户读取/真实token交换和发送不变。

隔离重跑对照仍在相同51项后于90秒SIGTERM，stdout/stderr/sourceSet与前一次相同；两轮都真实停止删除。同期只读资源采样load约0.83/0.73/0.53、可用内存约26007MiB，观察到Vitest进程D态；这些只是采样，不足以证明唯一根因，不以重复运行消除超时。暂存本地驱动后续新增 completeReport/expectedTests=201 和未完成项统计，避免“已收集51项的pending=0”误导；该诊断改进在第二次进程启动后才编辑，不能追溯作为该轮已有字段。当前仍保留回归未完成阻断，不再无新取证重复重跑。

## 较早补充：已发出表单请求的停止、未知与不重发

本轮不扩大生产授权或绕过停止守卫，给同一宿主整文件补两条真实路径负例：actual native form transport收到无效201；以及实际表单fetch已经被调用、原回包被持有时host.stop。原表单transport本就等待原fetch/reader Promise，不用race冒充实际停止，本轮没有重写它。

当前整文件 **21/21（20业务+1隔离哨兵）**、0failed suites/0pending；stdout SHA `e36d7c73c65906f88e5d1dab4b54272b05eaf8e5d57d3bfcd3cde34a0c1b021b`，stderr SHA `5f583d6a93f253eb26d50ab64b1cd257c514dc7e26dfdcd3bd6210f42adeb05c`。47个显式来源sourceSet SHA `cf095adba41ec509b457b995496316c5cc0671d465d5ef2d1d6026685102be34`，宿主整文件SHA `5ad287b35c9494b6b3e95f97d0ab5c51f39cff358da8469675d239bf08f52432`。真实隔离PG停止、目录移除，source前后相同，0违规连接/env读取；当前自有类型错误0、其它52项仍未分诊。该绿不消除下节当前19阶段的1155ms回拨失败或其它旧失败。

新用例对原生账本/次数独立取证，而不是只相信adapter verdict：

- 无效201走原form解码、原受控terminal writer后确实为 `outcome_unknown`；原grant used=1且serialBlocked=true。重投原claim只观察持久历史，不建第二attempt。即便重新批准新confirmation并入队，原永久CREATE围栏仍拒绝第二sender，ledger/admission/snapshot各1、总used仍1，token/form模拟调用各1。这里验证的是新consent，不冒称覆盖新operationId或新的远端目标。
- 已发出表单fetch时host.stop保持pending，原handle也未提前结束；释放原fetch后返回的有效201不得成为ACK。由于parent已经撤销，原cleanup不能绕过parent/source/lease守卫做末尾写；账本保留真实 `dispatching` 未决，而不是伪造已落库unknown或声称回滚。新宿主以真实权限观察旧grant为stale、used=1、serialBlocked=true、ledgerStatus=dispatching；再次收到原claim只观察/拒绝，不能发新token/form，账本等仍各1。这不等于远端请求已经撤销，更不代表已完成远端对账；后续UI必须将该未决历史呈现为不可重试/需核对，不渲染成功。

同来源整文件内存变异把私有runtime结果策略回退为“无条件ACK”（一个结果不变量的降级，不伪称各字段独立单点）：**19通过/2目标失败**，恰为上述无效201与晚到201停止用例，实际adapter误报success；0其它失败/0hook或setup额外失败/0pending。stdout SHA `73e50a81996e032df302348e46421a4b968f819b849ba8b7edc83163b4610d59`，stderr SHA `8741c4d8849f355f262a26021bb07c3b12319769cfb3fe596f8f0bca1ecbb2a7`。原磁盘源码不变、实际PG停止/删除、0违规IO/env。证明用例走到真正发送/terminal边界，不能借一个返回success的替身背书。

仍待完整应用的真实JWT→安装宿主/插件→共享loop组合、整站/浏览器回归、interval-slot关联、授权UI/未知终态反馈、独立审查与全类型/相关守卫回归。仅在本地测试，没有推送/CI/客户读取/真实token交换/发送，也不宣称完整SA-06D或原目标交付。初始化与静态预览仍按原独立交付线验收，不被自动发送扩展取代。

## 较早补充：正式入口、原共享 consumer 与原生 sender 接线（仍未整体交付）

本轮在实际 `src/index.ts` 构造同一管理/执行宿主，四操作位于原全局JWT之后；独立16kb JSON parser 位于原10mb parser之前，不新增JWT例外或mst allowlist。只有 integration-core 收到私有capability，插件在真实read runtime激活后交付 `yida-automation-runtime-factory.mjs` 的实际native工厂；正常重载、激活失败、停插件及server.stop全部关闭并等待本宿主。原日志私有观察分类覆盖该授权子树（含前置拒绝和未知子路由），不扩大任何权限。

`automation-durable-activation.ts` 的既有 boot/registry 接收显式的宜搭adapter，复用原 dispatch loop，不另起轮询器。默认 CURRENT 仍v4、旧事件fan-out不改；build支持版本集合增加v5，仅显式注册该adapter时用原私有v5候选做双向完整性检查。遗漏adapter仍用原v4 registry。未知版本负例顺延为v6，仍必须拒绝。实际server把宿主adapter交给该boot；请求受理在真实loop就绪前及提交前检查ready，否则整笔回滚。

worker不从消息获取自报owner/tenant，而通过实际grant/request/outbox不可变关联取得资源主体，再由原authority独立证明live ACL、来源版本、lease/fence/payload、预算与次数。独立worker ID不冒充owner。原共享sender/token/form/账本机制未重写；native factory只捕获实际db/security和既有原生构造器。宿主保留32并发上限与同请求去重，总预算从owner/profile查询前开始，timer加真实monotonic截止检查，不增加原10秒预算。取消、stop和原token flight排空均纳入实际producer生命周期；发送默认OFF且只接受精确字面量true。

### 验证范围与最新失败

- 扩展宿主真PG整文件先18/18，加入总预算用例后曾19/19。后一收据 stdout SHA `361673409c3cc3b6e709ca951eee89d0022cf99183906b63563895aa5e708c03`、stderr SHA `deb4d2236369e5ec33e24f361f55f266834b4bb0bc795a45dc98279db21efb30`；47来源sourceSet `0e8d5c1d4963acaca3993684df377b7f2e9d9209908a269546fb90bbb21d209d`。实际共享runDispatchTick/native工厂/账本ACK，同一request关闭、串行指针退役、OFF/伪造claim/ABA/live撤销、重复claim、持有token时真实宿主stop、总预算覆盖metadata均覆盖。vendor fetch仅为合成响应边界，实际token/form外网调用0，不等于真实宜搭业务验证。
- 随后只清理测试未用import，**当前源码复验18/19，不是全绿**：并发同claim正例中实际PG记录1次回拨、最大1155ms、当前样本低于grant水位，原dispatch完整性守卫拒绝。stdout SHA `b2faa6dcb7a0335e433ac8157dd28718eb3d310665942f95b85e7da8e88a10d0`、stderr SHA `0b8783f64956808fa375778c9e62dc9adfc0d3e3d916052f3c6fe0d9651da29b`；47来源sourceSet `149fa8193dbefadbcb232443d2bed32faca5d23fe1279dfc108e5125737e37c0`。0pending/0failed suites，实际PG停止/目录删除、0违规连接/env读取、源码前后相同。保留失败，不以先前19/19签当前整链，不改时钟/同步服务或降低双时钟守卫；回拨与拒绝确有观测，不据此宣称所有旧失败仅此一因。
- 同当前47来源，仅内存回退“请求消费者就绪策略”（同时去掉该策略的两个执行点，不伪称两个独立单点）为18通过/1目标失败：消费者未就绪时request竟成功提交，而非预期拒绝。其它18项通过、0pending/0额外hook/setup失败，原盘源码相同、实际停止清理。stdout SHA `7d0db83dd0adb256d86244b878e85bfc054475985e7a2add29c2e520bd6688fa`、stderr SHA `364b756461a79a055ee585006ed9815a909f0d2fd434ee671fe6b53fe2658fd4`。
- 独立三整文件纯unit（原routing manifest、原consumer handlers、实际Console日志生产路径）**97/97**，没有连接数据库；纯unit守卫要求allowedConnections=0，仍拒绝任何违规连接/env读取/global DB。stdout SHA `e3c18540168a93710ee69337cfbd6a8818b09fea0ec64d59cc96cbb6e02c1e89`、stderr SHA `b9906a82165073b12f2f12ae93adee49d464384f8116534fc661d3c2912ad30c`；同47来源。不能把97当97条真实数据库用例。
- 第一次把两个纯unit文件放进原真PG守卫时，实际63断言通过但2个suite在afterAll拒绝“0 allowed connections”（原 stdout `a143bc3ee7a0c15f6e6b3c41a653e43efcc42467b513586ea82e490a17b0b11b`、stderr `bb755485ad2c29031279f24b055af8b485d810364dd0bf3dea497af55c1ab29d`），该轮整体失败。后续仅分开pure与realDB配置，真PG守卫仍要求真实连接，未放松它。原生binding初轮2/11、9个构造拒绝也保留：合成夹具传了prototype方法的security实例；改为与实际plugin入口相同的、绑定真实平台方法的own-property安全服务投影，未弱化native factory。新增类型调用错误也已修正，当前自有文件strict/noEmit错误0，其它52项仍未分诊，非全后端类型绿。

### 入口静态核验、pin 与范围边界

原assembly helper直接核当前index：新路由单一无条件挂载、全局JWT位置在前；原this-census只新增一个明确的 `.yidaAutomationHost.port` 访问，68→69，固定literal/hash `edbacdccce6de03e63e49d86facf944405f6bddd722957258daa30bb251f1a47`，UNKNOWN=0且覆盖独立ThisKeyword遍历。没有名字通配或动态接纳UNKNOWN。该项是实际源码AST核验，不是整个attendance HTTP unit或完整server启动证明，后两者尚待运行。

实际provenance模块重算仅 `runtimeFiles.pluginIndex` 一项改变为 `87129b3576e7837059f96cc9ee7df90d4366ff85d693f4362dae747aaddcda84`。按模块真实清单重打后，原完整provenance测试在Linux实际1/1通过（包括shell verifier负例）；Windows原轮失败127，原因是bash路径/加载脚本失败，保留不掩盖。没有手拼额外pin，也不把固定清单伪称新native factory的全传递依赖SBOM。

| 当前主要源码 | SHA-256 |
| --- | --- |
| core index | `23ef1a141d50eb0546f4dbc2dc86f0fa734ef4ea218628f487ffc07a731bbaf9` |
| plugin index | `87129b3576e7837059f96cc9ee7df90d4366ff85d693f4362dae747aaddcda84` |
| management/execution host | `fe7354a354445c3da321825f126f0ae62fd096551b87ce5a51b07f69f0652e42` |
| actual native binding factory | `7992322ba34ee002672c3dbf8a4faf380cd14bdd711b01b0afa1e686ae7c6b24` |
| host19整文件 | `2d511b4c3893de819db0c87d2ce379708ebca983e530b76c56c8137d8c707668` |

仍缺：当前完整应用的实际JWT→宿主/插件→共享loop→原生sender组合、整站停止/浏览器回归、原assembly HTTP整文件与全后端类型/相关守卫回归、interval与grant-slot稳定关联、授权UI和终态反馈、独立审查。当前18/19及上述缺项均不允许宣称SA-06D或原目标完成。没有推送/触发CI/合并/部署/客户读取/真实token交换或发送；K3永久禁写与Bridge plugin分派未改。旧ABORTED/SQL/租约/时钟失败继续保留。

## 较早补充：管理宿主与完整事务生命周期

继续按原 SA-06D 推进，新增 `yida-automation-management-host.ts`，将已批 create/inspect/revoke/requestManual 组合到真实安装来源与一次外层 RC 事务中。create/request 只能由一次性、宿主生成 activationId 的插件注册提供实际 native primitives，绑定从真实 read runtime 重新解析；management 内部复用 caller 的同一事务，不开 nested transaction。观察/撤销不要求安装仍在线，但每次独立走真实 live actor/owner/admin 与 scoped store，不能用失效安装阻止 owner 撤销。

原 read runtime 增加 core-only `withInstalledBindingSourceForYida`，将**外层事务及原 COMMIT 回包**登记到真实 producer 的 runs；最后事务 callback 边界同步复核 caller 取消、宿主注册与安装来源。stop/deactivate 关闭入口后等待原 Promise，不用 race 抛弃 SQL/COMMIT。取消/停止落在 COMMIT 已发出之后仍可能留下持久 grant；此时调用失败不意味着回滚，新的只观察宿主能以原 grant 查看/撤销，不能重新铸造执行票据。当前宿主没有 sender，不宣称终止已发送的远端写入。

当前宿主整文件 **11/11（10业务+1哨兵）**，0 failed suites/0pending；stdout SHA `a57944bcbc72425c42936b8167b3f9822636e0705cf1bd9e43a2da308b51dc22`、stderr SHA `491a613e14f986cbf67fedfcc12afc6bbe652d5a9ce9a831a662cf4b78660cfa`。35文件 sourceSet SHA `760a2728395751af518ac31f56e1146d820ff4e61d73f9fae02fcd19091b031f`；0违规连接/env读取、source前后未变、实际PG停止/目录删除。覆盖激活前拒绝、真实一次 grant/request/outbox 与幂等、禁用后的观察/撤销/live撤权、无安装拒绝、ABA后旧grant拒绝、新activation不复活旧grant、过时capability拒绝、持有原SQL时取消、持有原COMMIT时双stop与历史观察、真实提交前失败整笔回滚。首次类型检查有10个同源测试调用错误（fixture allowedTriggers被推断成string[]）；改为实际contract parser生成输入，当前自有文件0类型错误，其它52未分诊，非全后端类型绿。

真实COMMIT门用例还观察实际 read-runtime 事务 provider 的进入次数：仅看 stop pending 可能被 producer 行锁等待兜底，不能独立证明 runs drain。去掉外层事务登记的内存单点变异为 **10通过/1目标失败**，原COMMIT尚持有时实际停止提前完成；0hook/setup额外失败、0pending、同35来源、实际停止清理。stdout SHA `534e8f451fa6dfdbf5b8003123021567582f75e11d89f2f0cd61f18d67f5e0d4`，stderr SHA `a67e6d5cb181c7ebe4fc2b544a73e7373b6f2a98442b23e9cc2aa1f7e1359c53`。

另一个移除宿主 live ACL 的变异首轮 **9通过/2失败**：目标撤权后 inspect 意外获准，另一个正例在实际PG回拨（3次、最大1359ms）后被时钟完整性守卫拒绝。额外失败不能冒称都是目标变异效果，亦不放宽时钟守卫。原 stdout SHA `cfcd81f6b912b19ab5c830c450822566210e1921dca88434a17ebfcd02f849c2`，stderr SHA `b9fdf6629cfd339ee2326df14b999a6abbaa84dfc40a03a978cf72c890039b69`；原失败已保留，后续同源码对照单列，不改系统时间或同步服务。

后续不改源码/守卫/时间服务，以同35来源整文件对照该 ACL 变异：**10通过/1目标失败**，恰为撤权后 inspect 的 Promise 意外成功，0其它失败/0pending；stdout SHA `8e8fbbf49fee8426b272bf1eb3db4ae4aa690366f3ae33dca6f3b5a838b57b4e`、stderr SHA `46c6b41367273d02edadbd1b0210d32ca57b3cbc8f4b801baeec6d88ee454027`。实际PG停止/删除、0违规连接/env读取、源码未变。此轮区分目标守卫与额外时序失败，不消除上一轮真实时钟风险。

同当前 read-runtime/source/fixture 另跑安装绑定整文件 **12/12**；stdout SHA `2aead61be580108d57ba98a88481b4d9dd3ce22ec27c5b925b8fccfb050ff618`，stderr SHA `8b9d5d64eaaa5939644557306528b8e03dc794c537dd26b63228a17f58a66bf3`，34来源 sourceSet SHA `605bc0446cce7e717adb4ff01ac1a29bfe1a18a5d2f4c53ebf60c8f8d329723f`；0违规/0pending、实际停止/清理。下节以前的源码SHA及回归数字仅签各自旧候选。

| 当前来源 | SHA-256 |
| --- | --- |
| management host | `5ecb18738edfb0a1328d71ad2d40bee92c9cf0ff3f4caf5b48156eef69dc68e9` |
| read runtime | `8046c62507a3206a25a1f75ad328057e1e7312ed9b135b2f399d965917fa4e8c` |
| installed source | `50305fe3ad35c6bfb4a1dd098341a488afe09c24c4f9fbaf26eced0c69f3d461` |
| installed fixture | `d2b1fc18c4af0c6aa456b91744aecd41c4698f5df0562f95cc58ea62fe0d5d9b` |
| host whole test | `eff02fd05769c9e44c2d3cbf276ec9fd0e826e10a7ef08149ef6cf0f8f6451de` |

边界：本宿主尚未由真实 main/plugin 激活或对外挂路由，不能让受理请求先于实际 V5 consumer 注册上线；当前四操作内部测试也不等于真实JWT→安装宿主→worker整链。下一步仍是同一SA-06D的生产入口/共享consumer与worker生命周期、interval-slot、UI与完整app和独立审查。没有新增端点、调度器、开关或功能切片；未推送/CI/部署/客户读取/真实发送。旧SQL/ABORTED/租约/时钟与发送21项失败全部保留，完整goal active。

## 较早补充：真实安装来源、材料版本与停止等待

本轮补入 `yida-automation-installed-binding.ts`，由实际 `automation-read-runtime.ts` 的活跃 producer、宿主捕获的 codec 与生命周期提供来源，不接收请求自报的 tenant/owner/binding。实际查询当前 producer 的唯一 profile，再走已有 target-context、注册表、安装材料代次、字段与记录 ACL；逻辑 projectNo 可映射到不同物理字段，部署 project 不假定等于 base。没有新增调度器、端点或默认开关。

管理/执行 authority 同时传递安装复核回调；安装 revision 纳入 V2 材料摘要及同事务一次性 proof 的再次消费检查。旧无安装组件的 V1 摘要保持原状，但不能被提升为安装态 worker 授权。回调提供后返回 null 必须拒绝，不能降级 V1。真实 read runtime 将安装元数据查询登记到既有 runs；stop 先作废来源，再等待原查询响应结束后退役 producer，不抛弃 SQL Promise。

整文件 **12/12（11业务+1隔离哨兵）**，0 failed suites/0pending。覆盖真实 profile/epoch/有限字段 ACL、当前 profile 禁用、字段内容 ABA、重启 producer、fresh 有效来源也不能激活旧 grant、实际共享 dispatcher/worker admission、legacy grant 拒绝提升、null-provider 拒绝，以及持有实际 SQL 响应时 stop 仍 pending。源记录/Connection/token/form 依赖在此套件中一律抛错并计数，断言0调用；故这是安装元数据与授权边界验证，不是 PLM 源执行或完整 app 验证。

修正闭包类型收窄及合成夹具的真实事务类型后，当前 strict/noEmit 自有文件错误0；其它52项诊断尚未分诊，不能宣称全后端 type-check 通过。修前6处类型错误保留在过程记录，不以运行时绿覆盖。当前34个显式来源文件的 sourceSet SHA `0e8dca1ee30a6c13ddf399abef11fe591efcb893dd6719a22e0e41348b5ea157`；stdout SHA `22788a31e9e5e0d6296940991cada87e7a10ed7293f70d20c5a86ce71e9361a3`，stderr SHA `8b9d5d64eaaa5939644557306528b8e03dc794c537dd26b63228a17f58a66bf3`。0违规连接/env读取，源码前后相同，实际隔离PG停止且目录移除。

两项仅内存单点降级均以同34文件来源完成，0pending、0额外 hook/setup 失败、0违规网络/env读取，实际PG停止/删除：

| 降级 | 真实结果 | stdout / stderr SHA-256 |
| --- | --- | --- |
| 材料摘要不含安装 revision | 9通过/3失败；fresh-reference-after-ABA、legacy提升、producer重启三个负例均意外获准，不是 setup 失败 | `bfc15174af2024beda5b6e6d1df8d027a549b4eabb5d8ac0062c550cdffa4625` / `2b470e3e869c9868542aa8c4fff390e23b32f8b6367bc1f12bc01fdf2add2eb6` |
| 安装查询不登记 runs | 11通过/1失败；原查询响应尚持有时实际 stop 已提前完成；finally 仍释放并等待原查询 | `65669b2407de6358d6e0f9b32bf748486c5447ffec71c1a5c3610ba90f59eab5` / `55eeff0b5c04662c80f84a34bb83ce7aff4e0995e5cdbd585974203ac6e5d99c` |

当前服务与安装回调修改后另跑原真实 JWT 四接口整文件 **12/12**（该夹具仍是无安装组件模式，不能代签安装态 HTTP/宿主）：stdout SHA `1b96fde9fdccfb59340b9697524a5182259483347c83f7cae254767bc1a618cd`，stderr SHA `1bcc072ab7477cde536e4457957e6934adc231fd0304ea90d379067218f2e20e`，26来源 sourceSet SHA `6f1b95655e5f11a5461449f68506656d93a541f4e8268a4fd4f77bcd5c6707d8`；0failed suites/0pending、0违规读取/连接，实际停止/清理。

| 本轮源码 | SHA-256 |
| --- | --- |
| installed binding source | `6b0f67494c2c9d29f1ed9fc01a2ffe7773c6e27f7cbff5f4a1dea668a9cc06bb` |
| actual read runtime | `27f7e4b35987e6fb8f4963ddb0fef3d9373f63983db09ea904f0c131a76b2e03` |
| live authority | `2667d139bffd1f178ec555bbbd057cb4e790713e20aa8f1fecd21b9eedd485f0` |
| management service | `0ae870f8335d77c053f3ca9179ed96989b3855507189b52257df3d4e9f2ea43c` |
| execution authority | `7487e5682a158f8134d480573da76bb14bcba009a2082ed03aabba854a20c755` |
| installed fixture | `d325619886ebe803120d7a7154fa85ae3a85038f855b10027e1e6cc59dd4c5cf` |
| installed whole test | `4b6795ee194baf49074d71ce332b3062a611ecceb358419c0a60a91b354de894` |

**尚未交付的实质缺口**：main/plugin 宿主尚未强制安装来源并挂四路由，V5 consumer/共享 dispatcher 生命周期尚未正式注册，interval 与 grant-slot 关联及用户界面尚缺，完整 app/独立复核尚缺。当前 track 只等待安装元数据操作，不能代称宿主等待整个调用方事务；正式 host 仍须拥有外层事务，在提交前复核生命周期并协调 producer 退役。下文旧 HTTP12、execution/send/runtime 的来源与时钟失败均保留，不借本轮绿覆盖，也不代替当前完整发送整链回归。未推送/CI/部署/客户读取/真实发送。

## 较早补充：四个管理路由的真实 JWT 前门

按已获本地实施批准的 GOV-08 四操作范围，新增 `src/routes/integration-yida-automation.ts`，没有增加其它端点或改变人工 send/read 路由：create、inspect、revoke、requestManual。严格捕获有限 consent/request 引用；actor 只来自真实 req.user.id 与 authenticatedTenantId，拒绝 body/query/scope header 自报，不采用中间件兼容回填的 user.tenantId。no-store、JSON-only、16kb、闭合响应 DTO 和 WeakMap 错误解码均落地；foreign Proxy error 不读任意属性。首建201、确认重放200；首次持久受理202、原请求重放200，两者均不代表发送。

这只是**独立路由组件**，未挂进 main、未注册 V5/consumer、未改全局默认/JWT例外/mst/product-mode策略。测试固定的 sheet/base/project 绑定不是生产安装来源证明。正式宿主、可信来源、worker生命周期、interval、UI和独立审查仍缺，不能称四接口已经向真实用户交付。

新整文件11项（10业务+1隔离哨兵）：实际监听器 → 原生 JWT/AuthService/session/tenant membership → 本路由 → 当前真实管理服务/native凭据与计划 → PostgreSQL授权/请求/原durable outbox。只复用已有 owner HTTP 夹具的合成账户/材料和新建隔离库，不替换 verifyToken、ACL、store 或 outbox 结果。覆盖四操作与幂等、无token/坏签名、真实无租户JWT与legacy header回填、header/body/query伪造、foreign tenant和其它admin、展示角色/reader、live角色撤销、JSON/大小门、真实提交结果多出token字段及恶意错误。每个用例均断言0 token/form调用。全局宿主没有在此夹具启动，不借此声称 full-app 或 actual host.stop 通过。

### 当前候选：错误码也必须闭合，HTTP12整文件

继续核对新解码边界时发现：导出的 `YidaAutomationManagementError` 构造器可被 JS 传入 TS union 外的值，真实 WeakMap 身份不保证其 code 是安全枚举。初版router的HTTP状态有503回退，但会原样返回未知code。未对外挂载前最小修复：`sendError` 最后以 `Object.hasOwn(statuses, code)` 固定wire code，不读异常message/cause，未知一律HTTP_UNAVAILABLE。测试通过 Reflect.construct 调用**实际构造器**，没有伪造WeakMap或替换decoder；不能以TS类型宣称运行时不可能发生。

当前12项（11业务+1哨兵）**12/12、0 failed suites、0pending**；stdout SHA `0aadac1525d5fc017b035e989b9cab704f8b1edf95ada38cac504d6c694029a5`、stderr SHA `1bcc072ab7477cde536e4457957e6934adc231fd0304ea90d379067218f2e20e`。0违规网络/env读取，源码前后相同，实际PG停止/删除；26文件sourceSet SHA `53dcf5672d06affee0bf76b90c4e1ea296362baec54e1b027967ec93d2b593ed`。当前route SHA `297610f41d6aa298313158741e9e051c5bc4bee3a9f4cbe6ae8af3227904a4b1`、fixture SHA `3db5169834ec83d88fdc67aa225599104c073cfd3cd99dc799d6f31ddbb51be0`、HTTP12 test SHA `66efd1a3cef05d21b3c9820d0e7a5d959919293002c41341cd04bdf809e38380`；service仍为下表8c1003来源。当前strict/noEmit自有错误0，其它50未分诊。

当前12项的三个变异均已整文件完成：每轮11通过/1失败、0pending、0额外失败，实际PG停止/删除与0违规网络/env读取成立，sourceSet均为同一 `53dcf5672d06affee0bf76b90c4e1ea296362baec54e1b027967ec93d2b593ed`。tenant/owner各移除一个谓词，目标查询实际200而非403；wire-code实验是一个闭合输出不变量的**原行为回退**（未知code保持503状态但原样返回），不是宣称两个独立守卫的单点证明。它只打红JS调用真实owned构造器的负例，实际回码是非白名单MANAGEMENT前缀（框架差异显示会截断长字符串），不是状态码异常/setup失败。原进程exit1，外层exit0仅表明目标降级被杀与清理成功，原磁盘源码不变。

| 当前HTTP12变异 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- |
| tenant predicate | `e2302a31f500fa3609d86866e5f6988a932b7f66151170e71ac0823c9525c198` | `804d2926b3830e7b57739f898efd4275cc84f806252fdb9b65fd698c2da6ab7f` |
| owner predicate | `d4889f4a296854e36cd114e2f9433f5494dca5e7f74a6544e43708828449594a` | `804d2926b3830e7b57739f898efd4275cc84f806252fdb9b65fd698c2da6ab7f` |
| wire-code prior behavior | `0079e065c00d84881654607ab89a0f2d90ed41e00c606443cb2a93517bd8af11` | `48e4d8687d5fcda1db1dbb7fd7ccd0a73a7c4230a07e8d1e97e0692f1d6fe504` |

下一步必须做真实安装绑定与host activation/worker作废、V5私有consumer、四路由正式挂载，随后接既有interval/规则UI及完整app停止验证；不要把固定测试binding复制为生产来源，也不靠单纯注册一个内部工厂宣布交付。本套件通过不消除旧发送21项/时钟失败，亦不替代独立审查。

| HTTP11阶段来源（历史） | SHA-256 |
| --- | --- |
| production route | `f97bc7cb0946f82386e6d8636d5339026404713ace17188b2c364188f24e45e9` |
| management service（仅增加本模块WeakMap错误解码） | `8c1003d464564f1b6b492b2df76c2898a1796d2abdb8590e0665861afe49fbb7` |
| real HTTP/JWT fixture | `75b99dbf59a4e6b9701a4b43b5272c5124afe49cad1ca1af290025dd0547d31e` |
| HTTP11整文件 | `9c86a73047e008a31b77ec93ee40ed92c9f5731461e83f44f2c6d622fe98f4c3` |

两轮未变异基线 **11/11、0 failed suites、0pending**，实际PG停止/删除、源码前后相同，0非法网络/env读取。第一轮 stdout SHA `2822a706c97da2f8f8ddc25c8fb6b64041cb0666ea1a2dce751f47320993c7f3`、stderr SHA `147881e1a26826462e9669b778c62248d706d7fb6e0df3c53ffc2bd662ae10da`；隔离缓存的后置基线 stdout SHA `efbf61f69a96af3f75a25356beb52900fb396cf93f5fd5251a9982a52fdd72bc`、stderr SHA `d93bea63cbcd663684a7c710afa36570bc88fa8f4ce0638a1c1ad8c63d68b6a6`。sourceSet SHA `bbee73a0fa7b45169ced0b1e315c64ecaf2fa640cb7b43c00010a44415293d41` 对应helper明确列出的26文件，不是全仓证明。

端到端单点变异只在内存移除core scoped grant的一个谓词，保留参数类型和其余守卫，两轮各**10通过/1失败**，无额外失败/挂起；两者均是“真实 foreign-tenant JWT/其它admin不能观察owner grant”用例实际返回200而非403。有效签名、真实session/membership与实际前门均保留，因此不是另一ACL先拒绝的假绿。原进程exit1，外层exit0只说明目标降级被杀、原源码及清理成功，不是生产候选全绿。

| HTTP变异 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- |
| history tenant | `d048cb0df5636a7543317057cb38274eb6de1953ecde0f1a20e4cada4d240db6` | `7a5feb4f369e288b197f3363bed8646bb49a1dbecce90f92096368d8bbad483d` |
| history owner | `331f6e5052f1f6722866195390908ade8b6701a06cd9d252c8a331335675b170` | `e0fa86b9a8c1dcff8e2577235a0880f7f6a1af72672c59f5289ff6c6dc98b4e3` |

局限：JWT claim来源与header拒绝是两层门；仅把错误码403改成400造成致红，不足以声称已独立证明 claim-only 守卫。本轮未用这种状态差异给授权保证背书。两项真正的越界降级是上表实际200的 core scope 守卫；安装代次/取消/停止/interval的正式接线还须另外真链证明。

### 保留的测试启动失败与修复

首次原生加载tsx的parent IPC探测被**未修改的**网络围栏拦住，exit92、forbiddenConnections=1，未执行业务；stdout SHA `31e442e27880edc16af4e8ade1facf12fe48f5d553bc7009c494fbcf952b3f84`、stderr SHA `9f1767568282884d53146c892c64b1dbb3d80c8010d2077fd89dc32996942436`。固定origin取证为socket/tsx，第二次同类证据 stdout `d9ab21270e6f622eddb4f37c7522779b7ded5a93978a52fc076ec04c60655ce4`、stderr `fe9420527ca920f76355d2a4f9b5d2b48c22909da31d0ee7d08c60a45bc2fae2`。

然后发现loader仅注册在父进程，实际Vitest worker的原生.ts导入 Unknown file extension：TypeError message SHA `0857878d453f4a3c9adbc845f89926ecd34127db22b1eefd07f4e8c74d1ff028`。保留 stdout `726fc54928cd8a7a395b0fa3c5fd0f6ade5bbe272d65c194d3be9971b01380b0`、stderr `44deec37f39b399dff20bab2a5f4c60bf76d1d30b92e5abd9a38cbddac70c8a9`。修复为在**实际worker**使用既有tsx的cjs/esm register API，afterAll注销，不替换真实AuthService。

该 beforeAll 失败暴露Vitest JSON“reportedPassed=11但实际只跑哨兵”的统计陷阱。helper现在以最终task状态、失败suite及pending交叉判定，suite错误只输出白名单标签/计数/哈希；当时实际1通过/10未执行/failedSuites=1，不算11通过。保留误统计原报告与已纠正的运行证据，不通过过滤/跳过隐藏前置失败。

进一步去掉既有 optional-pipe 阻断模式做最小启动对照，业务11项虽通过，worker的IO guard仍捕获1次被拒探测（allowed=50、env违规0），所以整套判失败：stdout `47a4106ceedb72697c4a5647087590b48ea1ccc50fc79c71d8de2cf94366b447`、stderr `feadfd47c69eec90a4dc6fcbf66981bce83ab5cfc11636bae64b1ecf636d23d8`。父进程exit统计0不能代替worker的失败检查。最终恢复原受审 `PLM_FULL_APP_BLOCK_OPTIONAL_TSX_PIPE=1`：原guard只对精确tsx父pipe探测**仍throw拒绝、单独计数**，不是允许连接；任意其它管道、非owned PG/HTTP及.env访问仍失败。原安全围栏源文件字节未改，所有既有assert保留。最终HTTP11复核整套成功（含guard/cleanup而非仅业务计数），stdout `c0a08acb6fcbbfe6953e70c018a6176b50efe83c9731f1b005d91c8639b62b0b`、stderr `346a3359c6e554d656c03341dfb17e8f11e01f52e21b854d814cdaa95a30215c`；后续HTTP12使用同一原围栏策略。

当前strict/noEmit（含真实Express全局声明）自有错误0、依赖图50项未分诊，不是全backend通过；初版缺声明和header联合类型的7项检查失败已修，不通过编造类型或any消除。没有推送、CI、main挂载、合并、部署、客户读取或真实发送；旧发送21项失败与历史时钟风险仍保留。

## 历史补充：失败阶段取证与 owner 请求终态投影

为定位上一轮两个失败，仅加测试诊断：fixture 固定 caseCode（TERMINAL_COMMIT_LOSS/CLOSE_PROVIDER/UNLABELLED）关联 actual PG 水位/回退计数；两个目标用例转发原样 Date.now 给原 kernel，记录实际回退计数，不钳位或替换时间；失败仅投影阶段、token/form计数和枚举账本状态。没有改生产 timeout、时钟守卫或 OS 配置。

该诊断候选整文件 **send20/20通过**，无pending，0非法连接/env读取，源码前后相同，实际PG stop/remove完成；stdout SHA `b74d87d18222bf9bbd08a61d3c2a82af95de49b95bbfa656c406b14c85b59c8f`，stderr SHA `440b47f21575d7cabba896c40f100cb6a846e17afdf8d4f3e5e140a858db2829`。execution authority仍 `86948b124f0c57a495775db4338bc383e7ddaba631570b8f02fc2c2f0eafaf63`；当次 send源码 `8b970f28d88c4156f8b0dab5818f61cc483656fda7554b77fa7e159e251e89ec`、fixture `03eb407c14d19059705358b1212fb1d101775de97a4b7db2629cfa949a4a3f98`。实际终态 COMMIT-loss 标签命中原故障注入并完成双行和回读证明；没有注入未知结果重发。该次无回退拒绝，但**不能因此声称先前回退或所有 masked 失败根因已修**。历史失败保留于下节。

随后继续同一 SA-06D 的既有 GET 合同实现，不增端点范围：management.inspect 通过实际 live actor ACL，再锁可信 tenant/owner 下的 grant，投影最多10条请求的 ordinal/status/admission ref/ledger status、有限预算和 serialBlocked。只有枚举/内部引用/布尔，无 row payload、项目值、凭据或 cipher。实际 admission 数须与 used 相符，active 指针与未收口请求须相符，ledger 跨作用域或终态不一致均拒绝。sender OFF、service close、授权过期/撤销不使历史公开：仍要求 live owner ACL，但不需要旧执行许可/密钥或 token，也不刷新授权。

首个新21项整文件 **20通过/1失败**，stdout SHA `7a8efb03f13b9331b1f275edad18615374ab0a05b569542dad54040986499052`，stderr SHA `08723da125cf9d778e7edb580930bb5f058a214f82305bafc6673b9fba695055`。实际 owner history 跨 tenant/owner 用例、ACK/unknown/OFF/close/revoke 历史与终态 COMMIT-loss用例通过。失败为原 copied-permit 用例，该轮捕获 OWNER_REQUEST 阶段 actual PG 回退1660ms、水位拒绝及 STORE_STALE；不能把该轮当作 copied-permit 保证已验过。无pending，0非法连接/env读取、实际PG停止/删库、源码不变。

该投影版本 store SHA `827ed7d2d52cd57873d6c6a092c630995d57ce7b5710cf3f236230b6c0835bea`、service SHA `eae7686fe133de803d25e9a4318441b8090bc9b02738c602b3f75f921b0e8269`、send21 SHA `111a667e63a0d1a4045d65de3a076be37637b31a55ac79125bb7af036da7701a`。实际旧 live/management整文件 **41/41**，stdout SHA `c3d04e75eddcda1a3e2ece80f3bf4d8e4c6f3c94b4394bc31a6893947b996212`、stderr SHA `a1f4c0837d9b174ddd0d632e315b5e3d477a62ebb8c25736b681210d4faa8836`，含原 ACL/拒绝/关闭等合同，实际停止清理及原安全守卫成功，不借它代签新增21项。

两个独立内存变异保留参数类型，仅去掉 scoped grant lock 的一个谓词；不替换服务、ACL、事务或数据库返回。两次均精确打红“双方真实 ACL 已通过仍须拒绝历史”的用例，错误为 unauthorized lookup 实际 resolved 而不是应有的 reject，故不是由另一守卫兜底的假绿。tenant变异21项19通过/2失败，另1失败为原单行正例；owner变异21项19通过/2失败，另1失败为原 claim COMMIT取消等待。额外两失败仍记录，各轮捕获 PG 回退1739/1623ms；只将目标 scope 用例计为变异命中，不把额外失败算成功证据。

| 内存变异 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- |
| history tenant predicate | `d72b15dbc018fd913966de0220219c3faa7c32a578861310c44ce5d7dbb2365a` | `ec821158360ef4b035540c8602e2c169fdcc885e44c76aa6f43227c7bcfca757` |
| history owner predicate | `e86db902d8ac268c56047dd635e0e8f2b20fe0a1c8072e01a687d2afabc8a573` | `64bfdd0e072f41e83657ca5136f92969b0ba22d104d672f8aa5e56b4903bfa69` |

随后审阅 DTO 语义，去掉嵌套历史 request 上的 `externalWriteAttempted:false`：这可能把未知结果误读为“该历史请求从未尝试发送”。顶层同名字段仍按原合同表示**本次查询**没有发送；历史项只返回真实 ledgerStatus，不伪造历史外部尝试事实。新增对应断言。上述两 scope 变异属于移除该投影字段前的明确版本，不能冒称已对后续任意改动重跑。

当前 store SHA `1585a19d25ab52a73a3dc2b1aa65f6a2db5ae35f90174872c99b8f5a43ccd0b1`、service SHA仍 `eae7686fe133de803d25e9a4318441b8090bc9b02738c602b3f75f921b0e8269`、send21 SHA `3218f1751831253687fc303f2bb13dfcbcfcc3a3f11efb0f18a3d1346340e20e`。整文件 **20通过/1失败**，stdout SHA `afa132eaae018d2a2b470497abf03c0a3ac60c1ff4b5d6e677bd3716be56213c`、stderr SHA `edcbc2cc524ff5958944ef95226a4d0f9df253b6196d444e07cd5c538c58daf5`。新增投影/unknown 语义、双实际 ACL scope、双行、终态 COMMIT-loss和回滚用例均通过；失败为原 token-exchange fence-change 用例，它在 `attempt()` 的 admission 前置即拒绝（EXECUTION_DENIED），尚未执行 tokenHook 的 fence 修改。捕获 actual PG 回退1588ms、水位拒绝，不把该轮当作 fence 变化负例已验过。0pending、0非法连接/env读取、源码不变、实际PG停止/删除获证；没有过滤用例、抬预算或弱化守卫。

当前定向 strict/noEmit自有错误0，其它57项未分诊。此21项与20项来源不同，不借20项绿灯代签新投影。正式 host/JWT/UI、interval、完整 activation stop与独立审查仍未完成；没有推送/CI/部署/客户访问/真实发送。

## 历史补充：已知 ACK 的有限多行串行退役

本轮本地最小修复已落地：`authenticated` 保留原 admitted finalProof/take 与截止检查，随后才在**同一事务、仍持有 grant/request/consumer 锁**的私有 finalizer 中重读实际 ACK、ledger claim token、worker/fence 与 admission 身份；把 request 变成 closed_observed，并只清空该 grant 指向该 request 的 active 指针。之后再次检查截止时间；原 native ACK/audit、request 和指针一起 COMMIT 或回滚。没有放宽共享 admitted validator、没有增加迁移、没有退还 used_executions。unknown 分支不调用该 finalizer，继续阻塞后续行。

候选 execution authority SHA `86948b124f0c57a495775db4338bc383e7ddaba631570b8f02fc2c2f0eafaf63`；fixture SHA `a0c55f6fd9ef3901bd3bff2fdc3d95c8f87d3ad648fe82485b590e035133119a`；当前 send19项 SHA `a4d5a67a9bbb64f67391a335e25dd03f1c18add35003940fe66b1c2c6e0721d9`。fixture 显式选择增加第二条同项目批准行，默认旧 fixture 不变，未批准项目行仍在且不得发送。

新增三条真实整链用例：同授权 L1 ACK 后 L2 ACK、used=2且第三请求拒绝；第一行结果 unknown 时第二行的原 prepare/admission 整事务回滚且0额外 token/form；真实 PostgreSQL trigger 拒绝 closed_observed 时 ACK 回滚为 dispatching、request 仍 admitted、active 指针保留、次数不退。两行均使用 actual core/native runner/token/form/store 与真实 PG；仅 fetch 为合成响应，不是外网调用。

整文件两次结果保留，不报全绿：

| 运行 | 结果 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- | --- |
| 最初 send19，尚无新用例错误投影探针 | 18通过/1失败 | `128837ead90b12e90b09d21b27d4f7c0d01ccf31552ac1c7387da2e59e7a143f` | `a625295b2fbd94eefb234e27a08d730c6b7d8efeb00b63e04a19c22fa99d37ba` |
| 增加 values-free rollback 错误投影后的 send19 | 18通过/1失败，新增3项均通过 | `0bed1bd13278fa89acea411a2b69a710a19741cc23570dfa4f72a5437ff13163` | `ee96b314f1ecf503f01677c4e5fccbe6dd469b93fb236ae72e4f7f0aa41384b5` |
| 同候选 runtime11 | 10通过/1失败 | `8b7e4e630f4cf6f1a266b6131faf477acc1d9221b44542c4c8f8ad31a6189a02` | `1320f95e63611e7a9e4c015896d69744ffbee0057a630dec61549fbd94e88dfa` |

首次 send19 失败是新增回滚用例在 snapshot 阶段拒绝；第二次失败是原单行正例。两次均捕获 actual PG 回退1740ms、lastClockBelowWatermark=true。runtime11 失败是 concurrent redelivery 用例，并捕获回退1726ms及同一水位拒绝。不得把所有 assertion/setup 标签直接归因时钟，或把先前候选22/22、16/16、11/11当作当前候选全绿。所有运行均0非法连接/env读取、无pending、源码前后相同、actual PG stop/remove 成功。未改系统时钟/同步服务、未放宽预算或守卫。当前定向 strict/noEmit 自有错误0、其它57未分诊，不是全库通过。

串行退役单点变异已完成：仅内存去掉 `await afterFinalProof(trx)`，原19项整文件17通过/2失败，精确命中“同授权连续两行”和“真实退役 SQL 故障应回滚 ACK”，分别证明不能保留 admitted 假称已退役、不能绕过真实退役故障仍 ACK。无额外时钟/fixture 错误；0非法连接/env读取、无pending、实际PG停止/删除、原源码不变。stdout SHA `ade52c172e0425d2d9e5f1c3fe0ebd63e4a3b8f4b91448dfa4fe613bfa19e633`，stderr SHA `34dafa218ce3e53d9de8730dd0bbb0c457fb19ac975b58635f899cee962b4d9d`。原进程exit1，外层exit0只表示目标变异被杀和清理完成；它不替代当前基线全绿。

随后补第20项：终态真实 COMMIT 已完成但回执丢失，只允许观察持久 ACK，不重新发票据，再执行第二批准行，最终 token/form 各2次、预算2次。真实退役失败用例另明确断言 ACK audit 为0。

最初20项17通过/3失败，stdout SHA `8f06c39e6172df38204abb08510d3cfc45e042dc026217d57e799f322903a481`，stderr SHA `742f5f575c043959d29a082f6669b1785433223294e8220201e2da3e87489dbe`。其中新 COMMIT-loss 用例错误地要求 state_unconfirmed，但原 kernel 的 ACK catch 会 `store.get(scope)`，回读真实 acknowledged 后返回 durable ACK（`yida-delivery-runner.mjs` 的原合同）。该次固定投影确认 observed acknowledged，不是时钟失败。只修新用例预期为已观察 acknowledged/durable，保留真实 COMMIT-loss、账本、pointer、预算、无 remint 和第二行断言，**没有改生产 readback 或放宽 unknown 守卫**。另两失败为退役回滚用例 CLOCK_INVALID、取消form等待用例 FORM_NOT_REACHED；本轮捕获 PG 回退1617/1683ms，未把全部失败混同一个根因。

修正预期后 send20源码 SHA `4cf650d09e5422845787f116180c54ffb5ea048de3f42ca2000851874f9084ac`，整文件 **18通过/2失败**，stdout SHA `36b0859176436a9db459e3917520498245b646d45d04dd8d83c3bac70b945eca`，stderr SHA `1f89b344956911c02d2ee35f007d86291d44847ae8a4caf6f2758d62eeb3a1d0`。新 COMMIT-loss 用例这次在实际 claim 阶段以 CLAIM_UNCONFIRMED 拒绝，尚未执行到它要证明的终态丢回执；不能宣称修正后的该正例已通过。另一个失败为原 close-provider-fault 用例，不能仅凭其注入的 STOP_FAILED 声称底层业务先前 ACK 或实际 host.stop 失败。该轮捕获两次 PG 回退1556/1773ms及水位拒绝，仍不把全部失败无条件归为同一根因。原两行、unknown 阻塞及真实退役 SQL 回滚用例在该轮通过。无pending，0非法连接/env读取，源码不变，实际PG停止/删除完成。

本轮生产只改串行终态收口；没有触碰原 timeout、时钟/完整性门或 OS 同步配置。不得用重复运行的绿灯冲销这些失败；需进一步捕获对应阶段及完成当前整文件稳定验证。后续仍缺正式 host/可信来源安装、interval/JWT/UI、完整 activation 取消停止与独立复核。整个目标保持未完成，不缩减为单次或纯私有工厂演示。

## 历史补充：取消提交等待、私有 runtime 与多行授权收口

本节覆盖下面较早阶段的“当前”数字，保留旧失败与旧哈希，不将新通过解释为所有历史根因已修。仍仅本地合成；没有推送、CI、客户调用或真实发送。

### 最小修复与真实路径

- 新增实际 ledger claim COMMIT 被持有期间取消的整链回归。修前发送16项中15通过/1失败：没有发送，但结果停在 state_unconfirmed。仅允许 `unknown` 在两次 snapshot resolution 且真实 claim 已成立时闭合；ACK 仍要求三次 resolution，原身份/租约/事务/预算门不变。等待原 COMMIT，不用 Promise.race 抛弃提交。
- 新增按可信 profile 构造的私有 runtime，使用实际 ConsumerAdapterRegistry/runDispatchTick、core authority、原 token/form 与账本机制。总预算从 admission 前计时；stop 先关闭入口和取消，再等原任务及 token flight 排空，最后关闭 authority。实际 close/drain 失败与业务失败分别证明。尚未安装到正式 host/index，不能称完整 host.stop 已验收。
- attempt 构造前失败仅允许 metadata 重试：提交不确定后重入只查持久历史，不重获发送票据；进入 attempt 构造后不由通用重试恢复物理发送。重复 active request 不加入旧 flight、不另发一次。
- scoped admission observer 只返回状态/布尔，不投影材料或凭据。跨租户负例中实际 actor 在两个 tenant 均通过真实 ACL，随后以相同 admission ID 证明查询自身 tenant 谓词拒绝，避免被上游 ACL 兜住的假绿。

### 当前候选来源与整文件验收

| 文件/整文件测试 | SHA-256 |
| --- | --- |
| core execution authority | `2408b0b6713dc667a6a0bdca01417170d14f779fddcbbe4850861bd1c5b8de2d` |
| private send runtime | `e44b98b7389d946adea12e8787eae45ea401e9fd5c20dc76971223b9da7bc5aa` |
| original shared runner | `6d132adc373a43b087e21bcb2a68e3fe8512d5ad8c171828864c20a2a82e38b9` |
| execution 22项 | `8eef471c425b59ee38b9866c6f7f3cb65e18874c739aabdad0de68f41286aa64` |
| send 16项 | `48fe2e2347ce85e7f35ffbae601ae35d418571e2924caeb8534f3d50b61f2acd` |
| runtime 11项 | `6b091d019e39644c30b99b39351d87947d39fe3c4045499f21bce19d4fc4645f` |
| actual PG/native fixture | `e4c8c94b9da0ebd0cf2d1763f190173efce8d0192f15ad583ea5613956151091` |

| 验收 | 结果 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- | --- |
| execution | 22/22 | `b36d45205ac261f9fab01726bce889868d943a86ad1d531e88f9ba46b3a4de05` | `61d5e8bd567b2d64c7184882d8ab5383175ec196a8a4ad704fbade23428f7346` |
| send | 16/16 | `ab2ce0c6f4164dec72c615937a0f039230d2c8960de904b04ca0008b75e4eb00` | `c2b7d301ac6ce3c73adb6496aba0d4b9827d2df47664a5bd36ae37f24a4793d0` |
| runtime | 11/11 | `4bbfa4e9b469d05f0c8da4d6167496d6f8648c8693dfca1df1bbea0bcbdfee94` | `d61f1d6e5a7ef949c25d11069997ed0f1c8826d5aa8cdae1aca0c4fe5f5379e6` |

上述均为独立 owned PG、整文件、0 forbidden、源码前后相同，实际 PG stop/remove 成功。使用原 token/form 机制但 fetch 为合成响应边界，不是外网或客户系统。runtime 覆盖实际共享领取、ACK history replay、OFF/坏输入/预取消、真实 ACL、停止等待不合作 token、SQL 响应等待中的总截止、COMMIT 回执丢失、真实回滚后的 metadata 重试、close 独立失败及 active 去重。

原 runner 54/54（stdout `400a7e22de63a000f28bd1f538bcbfd9e4225141c2e47fe48e3df9ed141b2d50`），原 owner port 7/7（`4752e2db205686e5fb1d730dce35a12e3e7388ca847f0a4fd22c319c902977f4`）；人工入口额外拒绝私有 terminal 覆盖。未变源码原 store17/17、primitives26/26 的证据见历史节。scoped strict/noEmit 曾返回自有错误0、依赖图57项未分诊，不能报整个 backend type-check 通过。provenance 模块实际66项比较0差异；新 SA-06D 文件不因此自动获得 sealed 覆盖。

### 单点降级与保留失败

以下仅内存替换生产守卫、运行整文件，不替换 SQL 返回或 oracle；全部实际停止/删库，原进程 exit1，外层成功只表示变异被杀及清理成立。

| 变异 | 整文件结果/命中用例 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- | --- |
| 恢复 unknown 必须第三次 resolution | send15通过/1失败；claim COMMIT 持有取消 | `a6cf7baa400b6873de63298696f1d1e7c50221738619967a72f6a1db0cb24c74` | `729f3e454d9935eef4588a9c34ec14277620526af48488d7e9931e3154bf452d` |
| 仅去 observer tenant 谓词，保留类型/owner/workspace | execution21通过/1失败；双实际 ACL 的跨租户观察 | `9313b1b485fbf3e89857ae1c915d6d6758c6b2d23713e4645cfe8d4e4b198ffc` | `5a9a367c31474998c0e171b7d8520e021050bc454d708c8608fe5f5c650218af` |
| 去 runtime 原任务 drain 等待 | runtime10通过/1失败；不合作 token 的实际停止等待 | `9e81c200f87f7fe2d5f3e5ba102d1c6fa4aaba7b5a0704df1eac6af8c2d8e2e2` | `51a2f1de1acbef6a80354233cadaec421299d7875f4c25f47d176bca717fbf31` |
| 总截止 timer 回调空转 | runtime10通过/1失败；首 SQL 后不可继续 | `fb32599b869c17973673086459f939f34bb45758c6582b55e81104951c3b1ce7` | `8926679cd7eeaca4b2e9cc99a8485432b265f40a0c3a041f1a8177e278ee49fa` |

runtime stop 变异用例 finally 仍释放并等待原任务；总截止用例等待原 SQL 后断言 statementCount=1，不能被稍后 core 拒绝掩盖。旧15项 delivery-identity 变异只属于旧候选，不冒作当前源码的单点证明。

本轮原失败也保留：

- 修前 claim-COMMIT 取消用例15/16，stdout `61779cb2c14f89d4d1489fb57527c91784c566cf0838c87e42ac92cf08dc6782`；这是已复现并最小修复的具体缺口。
- 早期 runtime10项9通过/1失败，actual PG 回退1827ms且 lastClockBelowWatermark=true，stdout `0193e5819877e80a2597dab4113be2725b277fdc70491fa7bed8d0fbdd09bad1`，stderr `9a464964d5c3e9e0689f3cb3f76eab9f8cd8b3fadfe9316a6f1bd0885454fa4f`。
- 后续11项10通过/1失败，post-close 独立故障用例停止失败断言成立，但 ledger prepared 而非预期 ACK；stdout `ecf2ac1c072a1fb67629a35edb83a8362b31a9ee7c47828d16d79724ebb3a29b`，stderr `cb0612483b30d0ce5c9e4ed7bec7781f331ea814eeb620bd428c741ea6124d55`。底层业务失败被故障注入覆盖，根因未证明，不能归咎时钟。
- 增加转发真实 Date.now 的计数探针后，另一次11项10通过/1失败捕获 actual PG 回退1979ms，stdout `aecc78cf6a4e2a144af3f76ab463dcac8d82f41907b78f2c97f9f306383e2b16`，stderr `6860dcb5720cd392f2b1a819b21aa97feaa6b3f7cbe2082dab01ea85a8d27275`。未设置时间、暂停同步服务、抬预算或放宽完整性守卫；后来11/11不等于 OS 回拨已修复。

### 收尾顺序：多行授权不降格为单次演示

当前 store 受理检查 active_request_id，真实 admission 设置该指针，但现有终态 writer 尚未退役它。故目前单行 ACK 不能证明同一有限授权能继续第二批准行。优先实现同事务的已知 ACK → request.closed_observed → 当前 active 指针退役；次数不可退回，unknown 不可清空阻塞，不可重获 CREATE。097 已有终态枚举和不可变迁移门，需先验证是否无需新迁移。authenticated 最后重验当前要求 admitted，必须安排终态收口顺序，不能删掉末尾守卫硬凑通过。

随后补真实同授权两行回归及未知结果阻塞，再做正式 host/可信来源注册、interval/JWT/UI 接线、完整 activation 取消停止和独立复核。以上仍未完成；不缩减原目标，不宣称可交付自动发送，不用旧浏览器71项替代本轮新增合同。

## 历史补充：真实重领后的 stale worker 不能绕过原子终态门

14项初步共享内核验收后继续按目标§11.6复核：仅在form前重验不足。新增第15项真实PG回归，在合成form边界内使原lease到期，再调用**实际claimDueConsumers**重领，确认新fence；旧worker拿到合成ACK后仍能经旧ledger token记acknowledged。修前15项14通过/1失败，stdout SHA `a84a75b9b2cd004f25039f983b294f0d577d4ba7f7f52ad8f293a57c029f090d`，stderr SHA `158a90e4d2ab9ce305da04d25aa8351f64e8aaec9f9dedca98e710ca6089ce10`。这是真正生产路径缺口，不是时钟假阴性，不能拿之前14/14背书。

当前修复：把原delivery-store的claim/finish算法抽为**原事务外壳和core共用的事务内纯机制**，没有第二套状态SQL或audit实现。只有显式delegated primitives暴露claimInTransaction/finishInTransaction；原owner工厂仍保持六方法合同。core私有handle的claim、ACK、unknown通过authenticated同事务重验live材料/admission/真实consumer lease/fence/快照/ledger，再调用该原writer，末尾再次重验并等待真实COMMIT。consumer行锁持有至同一COMMIT，不能用“先check、另事务写”替代。kernel只有内部terminal委托，人工入口的options白名单仍拒绝自报terminal，默认仍用原store。

旧worker已经被真实重领时，ACK及后续unknown写都被拒；返回state_unconfirmed，ledger仍dispatching，不伪造durable unknown/ACK，不退次数、不重新发票据。当前撤销/过期/父取消等使core拒绝清理时同样可能保留state_unconfirmed，需后续owner-scoped历史/人工unknown处理；不能把该保守状态算成自动对账已完成。尤其“等待claim COMMIT期间取消”的完整委托整链回归尚需补齐，原人工runner同类用例不能代签。

### 当前候选精确来源

| 当前文件 | SHA-256 |
| --- | --- |
| core execution authority | `ffba1484f16ff42b96937302ec19e222d13511d9300936582f3d84e7f0e8e258` |
| shared runner | `78ef13c2e6841f42cf5673295e2dc2b9afcae70e2db961706f76d500c6e17d05` |
| original delivery-store/shared txn transitions | `7a215023fa33e3efa2b207b0bffc3725f21e05efaecab114704324cfe44b1b6a` |
| native owner/delegated primitives | `d9f1db57e4cd6d8b0d11c83ce1409a9ccfeb489d30921bf9dad3f72d4da04bf8` |
| actual delegated send 15项整文件 | `8ccf2cfa34294a3fcd5baf516626c435f20f0ac5e97925f119b7304a61e9b338` |
| actual execution前置21项整文件 | `e3a7bc3c42413f81f995511c3ec23094e8cc0787dfefa2b0eda9fc5a02626a62` |
| actual PG/native fixture | `3e104d8869d89d98807c380a3d8797a3c61ce929ebe64ef37d06821d31add3c6` |

当前发送整文件 **15/15，0失败、0pending**，stdout SHA `1862eb1fb43d3bab475e212058986f44b879ce3348adec8e540795b380457ed0`，stderr SHA `c65c57a64c2fd650d997b24403a456e44a0016efcc98328385b6fe09cd3dc744`。原网络/.env守卫0违规，源码前后相同，actual PG stop/remove获证。当前原runner54/54（stdout `b561a23af0557588bdd159b8310948898a1021080c88790ceea6756b2a3f139c`）、owner port7/7（`72df6c6847f1528c0a2b40d2a637b4559b020edd8a5c53f893e4c798917ac60b`）、原delivery-store17/17（`33da659d9b055b82537c8478ccad17bbf22236d73d47213a8eaeae8ee78d41cc`）、native primitives26/26（`4d8cd6e3cbc42be1dab7ed6f4a06a6328851718c9777782b033926a003475b72`）；后三类仍是各自原边界替身/纯机制单测，不与真PG或浏览器71混算。scoped strict/noEmit自有错误0，依赖图57项仍未分诊。

当前delivery-identity变异：只在内存去掉actual dispatch claim的相邻fence/attempts两项身份比较（一个领取身份守卫家族，**不是宣称两条独立单点守卫都被测出**）。当前15项整文件13通过/2失败，精确为“token交换期间改fence”和“actual claimDueConsumers真实重领”；0pending，无非期望setup失败。stdout SHA `98c932bbb8c60aa8e57e145cb19afc905ec9bf2b0246cc234f0d4901672da51b`，stderr SHA `df7cf476a9d11101e422b2a5439eb49883d1cecae6be0ea05cfcaace7a28e590`。实际调用链继续走原native token/form、PG writer及core，只移除生产守卫，没有替换oracle/数据库返回或制造假proof；0非法出网/env读取、实际PG停止/删除、原磁盘源码不变。原进程exit1，外层exit0仅表示变异致红和清理获证。此变异不能证明未来index/consumer一定调用本工厂，也不能证明所有COMMIT竞态与host.stop已覆盖。

当前21项前置整文件 **20通过/1失败，不报全绿**。stdout SHA `4d33df71bd637fc0c724ea92286dde953c6105a66dabb3c0a8dee42873160b60`，stderr SHA `04360eeae23983651944903cd4afdba55a9d845a3b229171a167247718dd74da`。该失败捕获actual PG时钟回退1957ms、最后SQL分类CLOCK且lastClockBelowWatermark=true，随后的真实claim守卫拒绝；0pending、无超时、0非法出网/env读取、源码不变、实际stop/remove完成。不是普通预期负例，也不能删该正控制或通过重跑绿抹掉失败。当前候选仅发送整文件15/15，不是全栈验收通过；必须在稳定授权环境重新完整验证前置与发送，并保留本次时钟风险。

此前当前补充之前的21/21 stdout `0242f69b0a23c5240d80fd5bcd35044ee88f296d547196711a81979456c828a8` 只属于下节shared sender初版。初版新增的load-limit变异14项13通过/1期望失败（stdout `3ec477e9e72929c2e4257a91b87188f0cba2d09fc7a4ead32279e2f16fd414a9`）和snapshot-source变异5通过/9失败（`7d7386fe3ae994009cafa5cc8bb0ce32d44a0be4b7dad5a09b5f43d5f1acb0b5`，含直接材料投影用例），只能为它们当时对应的core/runner字节背书。

本补充后的只读provenance重算仍66叶/0差异，没改pin；新增SA-06D文件不因此自动成为已密封代码。原owner工厂契约保留，人工摘要拒service的原26项仍在，不以安装负例替代它。

### 新失败与诊断边界（不掩盖）

- 终态初修一次15项14通过/1失败：stdout `e9bc773efb5dd06ca188a576e04f7d53a208a7485e54f4310495c38226530afa`；原PG返回值观察到回退1918ms，最后一条为CLOCK且lastClockBelowWatermark=true，实际claim守卫拒绝。此时已经修好的真实重领回归通过；失败在另一用例admission前置。
- 当前原子claim/finish候选一次15项14通过/1失败：stdout `1e87336b0358d8dffd82ec9fa0b39ddd206f37dcc4c0b54cd07e3f207d283e0f`；回退1914ms、最后CLOCK低于实际持久水位，YIDA_RUN_CLAIM_UNCONFIRMED。没有降低水位、加重试、延长期限或修改WSL时间服务。该轮失败保留；后续绿不等于本机回拨已修。
- 新native transitions最初错误地扩展了原owner工厂的精确方法清单，原26项23通过/3失败（stdout `9397a37f9be21cd879ee08c9b4811506f19b509b0f11b42fc7ee7f5eae9670a2`）。修为只有显式delegated工厂暴露两个事务内机制，不删原六方法断言；原owner缺少私有机制时core安装即固定错误拒绝。对应21项负例据此改为证明真实owner工厂不能装成worker；原owner摘要拒service仍由native26原负例证明。
- 原delivery-store单测首次0通过/1装载失败（stdout `6fee1b6ddec9b458ca440f4d24ea7561b97863cc0e0bc89ae5485edc97a00224`），独立tmp驱动缺现有js-yaml/typescript解析路径；仅补已安装依赖NODE_PATH、无安装/下载或测试过滤后才17/17。

整体目标仍未完成：真正宿主安装/来源、consumer/有限interval、JWT/UI管理、历史/终态反馈和人工unknown、activation取消及actual host.stop、独立审查/正式整链均须继续。不推送、CI、合并、部署、客户读取或真实发送。

## 前一阶段：一次性委托句柄接入原共享发送内核

本轮实际实现：core私有handle新增可信context/operation/credentialBinding、`resolveExecutionSnapshot`、`loadCredential`、`assertActive`。每次解密/取凭据都在同一真实事务中重验live owner/规则/材料、已admission身份、实际lease/fence、加密锚点、原ledger和期限；先做一次prepared快照解析，原token client在交换前/发布前各读一次凭据，再核prepared快照、原store claim，最后核dispatching快照。token port只返回binding/appKey/appSecret；snapshot只有获批单行/config/systemToken/userId，没有完整source/plan或appSecret。第三次凭据读取/第四次snapshot解析不被授权；任何错误关闭句柄。前一轮父signal绑定和逐SQL停止守卫保留。

在原 `yida-delivery-runner.mjs` 内抽出**不导出的** `createDeliveryKernel`，人工导出仍在进入内核前强制actor=owner。与冻结HEAD原文件按LF归一化比较，内核函数体文本相同；没有第二套prepare/claim/ACK/unknown算法。新增显式host-private `createInternalYidaAutomationSendAttempt`，先消费actual core的WeakMap票据并比对宿主context，再创建原token client/exchange/form transport；只有`run(options)`，不能改operation或从JSON提升成执行权。attempt只执行一次，失败也不恢复；token/form fetch前都重验实际handle与literal开关。finally先close再**等待实际disposeAndDrain**；close/drain故障返回固定STOP_FAILED，不能借业务ACK报告停止成功。依赖由受信宿主注入，不宣称防御同进程任意恶意代码。

### 当前精确输入与已验范围

| 当前文件 | SHA-256 |
| --- | --- |
| core execution authority | `b784d1e92f77b782ce73eb956205f4a42ea04347d939ff1225b6082eab8cdb8e` |
| 原runner中的共享内核/私有attempt | `f4b59352798ed740d8bbb8027b165d0ce703626ccba8aadb88487a5c65dd02eb` |
| 新真实PG发送整文件 | `828055ca5555af1262b41299f41ea2e024cc78eff43eee1c93cbecb70487ee08` |
| 真实PG/crypto/native fixture | `042cf90b892f8fdf039488f61881813c9d61339dc21b9f893badb6ae8860dcbd` |

新整文件 **14/14，0失败、0pending**（13业务+1隔离哨兵），stdout SHA `90e1a26dce0733850a345f6eb47b5506b0d4865c822fe3b1874cfd4770b1abe4`、stderr SHA `ae84f516505ad14661a32d0f9b5cb59ddb46c363daa530e40cc62727373b090f`。真实live/core/outbox/claim/097预算/099加密锚点、native loader、token client/exchange、静态planner、共享runner、form transport和原090/091 PG账本全部实际执行；**仅fetch边界返回原生合成Response，不是真实HTTP网络或JWT/全app证明**。

14项覆盖：批准单行真实协议编码且未批准P2不出现在请求；ACK绑定真实worker并不等于businessVerified；人工入口仍拒worker；空/异实例票据拒绝；运行前与token返回后撤权；form异常持久unknown且不退次数/不重试；默认OFF；snapshot/token材料投影隔离与两次load上限；宿主context不符消费并关闭；真实shared fence变更阻止form；真实token client drain等待忽略取消的合成exchange；真实form transport等待忽略取消的合成边界并记unknown；真实close完成后故意注入provider异常，不能泄露原消息或由ACK掩盖。最后一项**不是actual host.stop故障试验**。全轮实际隔离PG停止/删除获证，源码前后哈希不变，0非法出网/0.env读取。

当前runner字节上的原人工整文件：54/54，stdout SHA `eca84c8161e19d582dbb691c57199240d78b9078e3eda4fe7322f0db8f10abda`；原owner port整文件7/7，stdout SHA `a05b4e2be0dc0165501647143da8cb64812fb4a70043ff9b48686b250d1edb2e`。两者是原SQL边界替身的Node单测，**不借为原人工71项浏览器整链**。原provenance函数只读计算66叶/0差异（其中63个SHA叶）；未重打pin，不把未纳入原pin集的新代码称为已密封。

当前前置21项整文件及新发送两项降级验证仍在运行/待收录；此前13项baseline与load-limit变异属于增加close故障用例和固定错误收口之前的runner，分别为13/13和12通过/1期望失败，不能代签当前14项。此前load-limit变异stdout SHA `c316973a92734d24f2db55ee037e8a15c148508bdca54e8526b3b370ade01722`。

### 本轮失败必须保留

1. 首个发送候选4通过/5失败，stdout SHA `c853a92ba860ab1438c5d558270a3344723fd15d2fde7ab031178076eb2daa2f`：core只允许一次credential load，与原token client交换前和发布前两次真实重验不兼容。修为一个flight严格两次读取及原后续snapshot序列，不删第二次重验、不加token重试。首个取消用例没抵达form后等满原15秒；随后测试改为同时观察真实pending提前失败，仍finally释放合成gate，不抬超时。
2. 修读次数后9项曾8通过/1失败，stdout SHA `410f4c8d7871965338351ac82eca663ccdf09ceab128dde608d0644bfe188cde`；未取证的SNAPSHOT_INVALID不借后来9/9归因为同一原因。扩展13项首次12通过/1失败，stdout SHA `b5efbc0b98dfa6d6061e950745e5e3b580199a4a41c1936a1303c4243748a55c`，在admission前置被拒，内部原因当时仍未知。
3. 加真实PG时钟传感后13项一次12通过/1失败，stdout SHA `ac45f12fdec3b97c19fdd5d9b665e1984037942c3809b71358f3d8fb471462eb`，stderr SHA `42ea8ebe29a3d05cff599a34d0bf553a202a31236c4e430b5c9cd1c4b4897d63`：失败事务观察到now_ms实际回退1965ms，固定claim拒绝。此为该轮新的时钟回退证据，与既有fail-closed时钟守卫一致；**当时尚无“最后sample低于持久水位”帧，不冒称唯一根因或解释全部历史失败**。传感只从实际PG返回的now_ms采样，不代换时钟。后来又记录lastStatementKind/lastClockBelowWatermark，尚未用该新帧复获同一失败。没有改系统时间、时间同步服务、原10秒执行/5秒SQL/15秒测试预算。
4. 前一轮未归因management拒绝仍保留。fixture现在在生产服务遮蔽错误前用raw stderr发固定phase/code/statementCount/时钟布尔与回退量，不输出SQL、参数、凭据、原消息或堆栈；这是合成诊断，不是生产错误契约扩张。

### 仍未完成的目标

宿主安装/可信来源组装、actual consumer与有限interval producer、真实JWT四操作/UI授权引用、整个activation的取消传播/actual host.stop、safe history/终态反馈与unknown人工处理、独立审查和正式整链验收仍需继续。全局manifest CURRENT仍v4，新v5只有私有候选；index/外部环境读取/消费者没有注册。原人工/只读路径不被新许可替代。没有推送、CI、合并、部署、客户读取或真实token/宜搭请求。本地14/14不等于目标完成或可发布。

## 前一阶段：前置票据的取消、关闭与真实提交等待

本轮在原execution authority内部增加原生AbortSignal校验。admission的signal保留在实例私有锚点，不入库、不序列化；后续调用者省略signal也不能恢复被取消的票据。checkpoint可另接原生signal；拒绝Proxy、伪signal、getter及额外字段。人工owner port/runner没有改动。

每个实际事务只有一个Queryable包装对象，保持原live/claim的同事务/xid证明。授权SQL前后都重验默认OFF、原期限/单调时钟、取消和本handle关闭；不改statement_timeout，不以Promise.race遗弃在途PG操作。provider负责真实BEGIN/COMMIT/ROLLBACK，清理SQL不受“禁止下一条授权SQL”限制。取消发生在provider已进入COMMIT时，等待结果再拒绝发票据；已提交次数不退还，重放只读历史、不重铸票据。**这不证明物理取消了已提交给PG的语句，也不是完整发送器停止证明。**

当前源码SHA-256：execution `ecaa96650e48bc348e740629cd2dacc4e1e4645d76784398eea909e6f98b3f12`；整文件test `9a87947a07f3e2a2bfa3723812696fa966886fe9a7f17d9d0b2deaa6352545b3`；真实PG fixture `b026dbf28229045ae1b760dfc240a624890553084ea374c9a33fb40df42b4a27`。

最新真PG整文件 **21/21，0失败、0pending**，保留原16项并新增5项：预取消/伪signal零授权SQL；第5条真实语句完成时取消后无第6条；执行中close无下一条；不可丢弃admission父signal；COMMIT等待期间取消不提前settle、不重铸。stdout SHA `ecfddad9fe2ce60a8d5129496b49ee363f3b9e710edb276f60cbcf75a7df2530`，stderr SHA `bf0d526d743d7182ab618d8bc37dc4311d246fb36251737f67c8ad44f1ff9077`。原网络/env守卫0非法连接/0.env读取，实际PG停止/删除获证，测试过程源码未变。当前7个生产根及3个测试/夹具的scoped strict/noEmit自有错误0；依赖图仍有57项未分诊，不是全backend type-check通过。

必须保留的失败：初版20项整文件20/20属于父signal绑定新增之前；扩展21项第一次 **20通过/1失败**，固定码 `YIDA_AUTOMATION_MANAGEMENT_DENIED`，stdout SHA `36c69b5b108dee460c90bc8588a877997ac014b47ab49062559ed178d97eb0b1`，stderr SHA `98e81a10f26e09138dd7d505734a8e00bb50dbefcb7108d65b172a3d4beebee2`。该用例在准备授权时失败，没有内部因果证据；不归因时钟/资源，不借后一轮21/21称已修。后来只在合成fixture的真实事务catch新增闭合phase/固定code/statementCount诊断（不输出SQL/参数/消息/堆栈），当前通过尚未复获该失败。它与此前并行变异的management拒绝均继续待取证。

新增逐语句取消降级：仅在内存去掉`raw.query`前后的check，原21项整文件19通过/2失败，取消中断与close中断两例致红、其它19项通过；stdout SHA `0fcb25b4ac8cc9f8a3b96cf238c5507468e343d82dd4a414384827a8500d41d6`，stderr SHA `bae0615560fb166c9fb3dbe8a474b048c3aeffbff0fb5ed3471c061310842aa0`。原测试进程exit1；外层exit0仅表示变异确实致红且清理获证。变异启动器最初缺少新增variant的精确白名单，启动即exit1、没运行测试；已只补本地tmp启动器的两个固定variant，未放宽业务守卫/网络规则。

父signal绑定降级：仅在内存去掉`notCancelled(anchor.signal)`，整文件20通过/1失败，省略checkpoint signal不可恢复的用例致红；stdout SHA `749e93c044b296918922aa577856fcd70a8f0a302b4c0f1a6593e2a5339371ed`，stderr SHA `c37709a21f257cfc2248377340b8af331f250e2dd58dfbf8dd46829babf265f1`。两轮变异均0pending、原进程exit1、源码未改、0非法连接/0.env读取、真实PG停止/删除获证。这两项只证明authority实际守卫被用例覆盖，不能证明未来sender/consumer一定接线或物理取消HTTP成功。

下方原五变异只属于上一阶段源码，不能代签当前新增守卫。完整sender/shared kernel、宿主consumer/interval、真实JWT管理入口和整链unknown/停止仍未完成；当前不是可用自动发送版本。无推送、CI、合并、部署、客户读取或真实发送。

## 前一阶段：live材料、真实领取、原子admission与提交后一次性前置票据

新增 `yida-automation-execution-authority.ts`、099加密锚点迁移及真实PG整文件/夹具。实际组合 live actor/规则/宜搭材料、原shared outbox领取、原native prepare/091永久CREATE fence、新预算/admission及加密锚点；相同request的私有admission advisory锁在rule/material前取得，不提前锁grant/request行。事务明确提交之后才把空对象票据放进本实例WeakMap；回滚不留下半状态，提交回执不明或历史重放不重新发票据。take同步消费，复制/跨实例不能恢复。

**这是提交后前置票据与checkpoint，不是已接好的token/form发送handle。** 私有checkpoint重新核验live材料、已admission身份、真实shared lease/fence、期限、密文锚点和实际ledger绑定/状态；资源owner与真实worker分别记录。checkpoint只投影获批单行/config及所需绑定，不返回完整selection/source/plan，仍不是公共DTO。当前没有token/HTTP sender、全局consumer或新JWT路由；原owner port/runner仍要求actor=owner，不会接受该票据。整体授权/执行/取消与stop收口、原生AbortSignal、完整IO deadline、unknown对账仍待接线。

原native primitives内部共用选择/prepare/摘要实现，增加**显式私有纯机制工厂** `createInternalYidaAutomationAuthorityPrimitives`：资源读取仍owner scoped，摘要绑定宿主固定worker；原owner工厂继续拒绝worker，无runAs/skipOwnerCheck输入，无第二套摘要算法、token或sender。只从原manual服务复用其有界canonical serializer，不改变原人工审批流程。

新增独立开关已登记manifest：`INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED`，danger=high、默认OFF、仅byte-exact `'true'`；原OWNER开关语义不变。当前authority默认拒绝，测试通过私有宿主依赖注入固定literal；**index/环境读取与consumer尚未注册**，不是设置env就能使用的功能。新表 `integration_yida_auto_execution_snapshots.snapshot_encrypted` 已加入实际只读probe和sealing-site census，未加豁免。

### 当前精确输入与基线

| 输入 | SHA-256 |
| --- | --- |
| execution authority | `043524c3458686460fec3c589028401e381741158fc9bf4d7dca56e4bbfb0634` |
| 扩展admitted专用验证后的claim模块 | `509a9819c77dbf643fef13049cef7eb982836d472a857f1df7ba87f5c4d1bf1d` |
| native primitives（保留原工厂，新增私有纯工厂） | `1bd087a6ef29d32c8ee46739dcf1e987b98d63db620029b03a963c435ca8f45a` |
| 原manual服务（只新增serializer出口） | `42f01f2daa46fc2c68f54b9525d8deb7364b90bbf19713f6b2445c2ff2f2f69a` |
| 099 SQL | `cda96e3702d6240137e5d776ff4f9d7c554c308dfefe5e1ede988af98287c3ce` |
| 真库execution夹具（含另一个未获批项目行） | `613b0fd4f2b3657537de9197c4262e8129ae3996191d35d17a22824494721307` |
| execution整文件 | `4b93223089aa21bba2b005682fa32a1f587dcc67390388b88ef5e7650af06426` |

当前execution整文件 **16/16、1硬哨兵+15业务例、0失败/0pending/exit0**；stdout SHA `9bd6bcf009605588b20b049ee667d1dd9aacaa1fb746ba882b62af1dab5c94a4`，stderr SHA `da99ac9ff503529d39ee3d9ee76fca153fa84951ddac25b2b3747e44eb1815c1`。实际原outbox迁移、090/091/092/093/094与097/098/099；账号/规则基础表为实际helper所需合成schema，不是完整平台迁移或JWT/安装来源证明。真实Crypto、native planner/材料/prepare/永久fence和PG事务，无被测授权/材料结果替身；原guard违规0，source前后hash相同，实际PG停止删除true。测试预算和SQL/PG隔离不变，不改系统时间。原16项投影收窄前候选(stdout `96e30790…1feec`)保留，但不移签当前源码。

已证：并发同request仅一票据；真实snapshot INSERT错误和COMMIT前回滚使ledger/admission/snapshot/预算一起回滚；实际COMMIT后合成回执异常使预算保留、重放及同activation另一实例均只返回历史。通过实际COMMIT前gate和另一PG连接观测，提交前公开Promise未返回票据，observer看不到未提交状态。后者不证明同进程恶意代码隔离，也不是实际网络丢COMMIT回执/真实进程重启。

撤销、真实凭据撤销、规则fingerprint变化、producer lease丢失、期限/关闭均使已发前置票据的checkpoint拒绝，预算不退。真实AES解密后注入的provider尾随空白被锚点比较拒绝：它只证明比较守卫，不冒称对AES本身的降级证明。新表的真实密文还通过原probe读取/当前key解密，目标entry为ok/1 encrypted/0 undecryptable/0 plaintext；夹具其它非目标平台表可缺失，不能称整平台probe全绿。

### 当前16整文件的五条单点降级

每轮只临时内存修改一个production needle，测试/oracle/迁移/磁盘生产源码不变，独立自产PG；已逐一核对失败用例身份，无TypeError/超时：

| 删除的守卫 | 结果 | 实际失败 | stdout SHA-256 |
| --- | --- | --- | --- |
| 独立exact-literal自动闸 | 15通过/1失败 | 默认OFF/非精确值不能admit | `4b2e9fe7bf1e58eeeb243be58ad3a774f3423571b0453097da614c56afe8354c` |
| checkpoint真实材料重取（改用旧selection） | 14通过/2失败 | 真实credential撤销、规则fingerprint变化 | `e7f8e78d39d3f4b73a17635b723c4a037dcdf544e0487ba9ef6e4ee5ac9ff1cb` |
| take同步消费票据 | 15通过/1失败 | 同一真实提交票据二次take必须拒绝 | `8a8a3ffbc434b05309a955d5c2453742fdbb0447af8f586e6a98fa6d4d006bb0` |
| 解密后的完整锚点比较 | 15通过/1失败 | 实际AES解密后的provider故障不能通过 | `1ce501dfe79092eda0460bbb4438659e932a816d0a4691b9c196976a1fe46ff8` |
| worker投影偷带完整source | 15通过/1失败 | 同一真实draft中的未获批项目行不能泄露 | `fe756f75c17d7140659ffd7fdeff132b0e9e099058af3cbf732e3bd609b4c40e` |

五轮原测试exit1，0pending、guard违规0、源hash不变、actualStopResolved/ownedDatabaseRemoved均true；外层exit0只表示降级被杀与清理闭合。未覆盖/不能代签：宿主不调用此模块、scope/worker注册伪造、真实JWT/PLM源溯源、最终发送前未checkpoint、runner绕过票据、网络取消/ACK/unknown、实际远端幂等、真实host stop/drain和正式CI。未对“重放后重建完整可用anchor”做降级变异，保留为独立审查/整链待办，不能只靠permit字段非null的假件断言背书。

保留一轮并行enablement变异的**14通过/2失败**（stdout `0d906f0aa6879ed9522a2121c81121fb4abf79bcc3f402c4ad127b5a8a941488`）：除预期OFF负例外，锚点比较用例额外报Management_Denied；该用例主体不调用management，额外拒绝落在ready链，不计为该变异命中。消息未提供fixture位置帧，未捕到当时实际hook/时钟状态，根因未确诊，不能归因为clock/CPU。其它进程结束后同源完整16项复跑得到表中15/1，仅预期OFF例红。没有改代码或预算去换绿；保留额外失败，临时reporter另补beforeEach/afterEach失败布尔，供后续同类采样，不声称旧风险已修。

### 回归、普查及保留的失败

- 加入admitted专用取证后，当前claim `509a9819…bf1d` 整文件 **19/19**（stdout `2a9ef94264f95bb28fa89df19f14b62145e86e02b4fc06301fe7d249656615ea`），四原降级重跑分别18/1、18/1、16/3、18/1，源码/原预算不变、guard违规0、实际PG清理成功。它仍只是领取前置/已admission绑定，不是宿主身份注册证明。当前native改动下原live+management+producer整文件另复跑 **41/41**（stdout `1ab362be69750d507d975752990a50c1b2b5ad69aa972dda49d50b72cbcd810d`），0pending、停止清理通过。
- 当前7个新生产模块，以及本轮execution fixture/execution PG/claim PG三文件，定向strict/noEmit在匹配测试的ESM目标下自身诊断0；其它依赖图57条未归因诊断保留。不是完整backend或所有测试的type-check绿灯。
- 临时hook观察字段采用true/false/null三态：缺少Vitest hook状态时记unknown/null，不把缺证据当作“hook正常”；未据该补充诊断反推旧失败根因。

- 原native primitives整文件加一条显式人工/委托隔离例，**26/26**，0网络/.env违规；stdout `59aa641196e28e922bda8782976961635aca4a478736859fb72d290fee07bbeb`。这是native单元/内存SQL证据，不是完整人工71回归；原人工71/父70只属于既有发布head，未移签到本地SA06D。
- flag manifest整文件 **46/46**；stdout `8f5e04239f45e740f8c63cb1c6ca039a50d7ccba16a711036e09f18782b1c1b2`。不等于新flag已在index真实读取/启用。
- encrypted-store probe+census两整文件 **62/62**，guard违规0；stdout `6c51b222785ad1cdb7ee17fcbc430ac8a385f8db394015e59a6f3e7d2d4d28ae`。probe format夹具保留原5个实际memory-backed writer，第6个automatic entry只用实际platform格式fixture；其真实writer/表由上面的16项PG suite另证。总数固定断言从17 encrypted/12 plaintext/16 fields增为18/13/17，未删key轮换/一次derive/告警等断言。
- 依模块原 `computePackageProvenancePinSet` 只读核对 **66 leaves、0差异**；新改文件不在该pin集合，没有重打pin，亦不声称集合覆盖了新授权面。
- 保留首轮execution **3通过/9失败**（stdout `24ce8b28f0c0049da13ef2ce867cb94ee1f3ecd14e1bde258f974fad8295ee42`）：新consumer误把原prepare脱敏投影当成包含payloadDigest的私有行，合法结果被拒绝。修复在同事务读实际ledger全绑定，不扩大原DTO、不移除digest断言。随后12/12属于扩为当前16之前的候选。
- 保留初始30条TS诊断（同一闭包Anchor可能undefined）；用显式已验证Anchor局部量修正，未非空断言绕过守卫。生产定向strict/noEmit后自身0、其它依赖图57条未归因，仍不称完整backend绿。测试辅助曾以CommonJS目标检查import.meta产生3条1343，改临时测试检查器为与Vitest一致的ESM目标，不改产品tsconfig/strict规则。
- 保留普查初轮13通过、probe collection未成功（zod解析；stdout `7e20e4faf237699fa710ac24dbd1fe39e49a8e466f56082793455fded03c87a8`），只补临时NODE_PATH到既有native依赖，不安装包。随后57通过/5失败（stdout `e7a81927e0596f2d7bd5ee471cd6d9a3feb9196f5eb53a759e5fe416623d7c38`）为新增entry后固定总数未更新，按新增一个encrypted+一个plaintext补齐固定oracle后才取得62/62。

仍不交付生产自动发送：未全局注册consumer/新route、未接token/form/共享runner内核、未实现未知结果/撤销取消/stop整链与独立审查、未跑正式CI，均未推送/合并/部署/真实调用。099编号、schema兼容与事实保留策略在未来发布前再核对，不能删admission/fence/快照退次数。

## 前一阶段：真实 shared dispatcher 的领取前置证明

新增私有 `yida-automation-dispatch-claim.ts` 与独立 realdb 整文件。实际调用原 `claimDueConsumers` 领取前一阶段真实shared outbox，不用SQL替身伪造领取返回；claim对象自身只作为描述，core再次读取link/source grant/request/outbox/consumer验证scope、activation、撤销/双时钟、queued请求、in_progress消费者、确切fence/attempts、真实事件/payload/版本/深度与DB租约。锁序为grant→request→consumer；后续组装必须先锁live actor/rule/material，不能反向先拿consumer再等规则/授权。

proof是实例WeakMap内的空对象，同queryable/真实xid绑定、取出先消费再await。take时重新查询，不复用过时facts；同client跨COMMIT、JSON/跨实例、并发二次消费、close均拒绝。已admission的请求不能再拿queued领取证明。返回facts的canSend/externalWriteAttempted均false，**不是可执行handle，更不允许把返回的普通facts DTO当作授权输入**；未来core执行authority必须私有持有该实例并在同事务中直接取证。

workerId来自私有宿主构造依赖，与资源owner不同；没有填假owner。当前shared consumer表没有worker身份列：本层证明PG中真实领取事实/令牌，不证明宿主注册来源或某个外部调用者就是此worker。真实私有consumer注册、runtime→实例调用链及完整live actor/material/child admission/已知COMMIT后的permit仍待接线，不把一个worker字符串当作已验证身份。fixture通过实际私有store准备合成grant/row/队列；materialRevision为固定合成摘要，**本套不证明live批准或源溯源**，它们由之前的真实材料suite及后续整链分别覆盖。

### 当前精确输入与基线

| 输入 | SHA-256 |
| --- | --- |
| claim生产模块 | `4671ecaf34894bff89eaa677733b06613251ae0e55f56a28307f982f89a53c8e` |
| 当前claim整文件 | `c94e1b9752c5f7049a6eea994bbb2b96315c21edf4b35e1756f816394cd6b34c` |
| 原shared dispatcher（未改） | `f24ac3e5a5bfb3eb5cedc6e530180e49897b36658bd1e0121309dd8f6e8ee77b` |
| 原shared enqueue（未改） | `765f7b7caad012e6f00b489702e3e32ccc0253913ed5dee1cf1ff429d35196a6` |
| 当前store（未改） | `b309d6da272323303a35039e0aa335daa034b00f63fd6c001922d9f65f857fca` |

当前 **19/19，1硬哨兵+18业务例，0失败/0pending/exit0**；stdout SHA `2897af8535a70dbf2d5067abf82ea55a637c835402ec5b2ab441253338609796`，stderr SHA `0902ce915d77e3f2d055dc19dd426c58356764bb2f30ca1ee5c6eaa7195f0a56`。真实原outbox迁移、090/097/098、PG锁和事务；原owned-PG14、隔离namespace/非root/仅lo/五caps零、原guard违规0，source前后hash不变，actualStopResolved/ownedDatabaseRemoved均true。旧18/18属添加真实存储事件五分支核对之前的测试文件，不移签到当前19项。

真实reschedule会只改变fence而保留attempts与合法lease：该负例刻意隔离fence守卫，避免attempts或status掩盖降级。事件核对用例在五笔独立回滚事务中改变实际存储的type/id/payload/depth/version，输入claim保持合法，证明不是只检查输入。过期/撤销负例发生在lock proof之后、take之前；admitted负例通过真实store admission与预算约束构造，但prepared ledger是显式合成行fixture，不称原plugin prepare/永久CREATE fence已串联。

测试给原dispatcher的既有now依赖传实际DB clock，以明确fixture lease源；没有设置系统时间或修改生产claim时钟。生产app/DB时钟差异可能触发拒绝，这不是时钟风险已修的证明。新文件仅加入原默认非DB配置的明确exclude，独立本地配置确实运行19项；未接正式CI或全局consumer，也未改变原15000ms test/hook、5000ms SQL及90000ms总预算。

### 当前19整文件的四条单点降级

只通过临时内存transform改一处生产needle、不筛测试名/改SQL结果，每轮独立自产PG；已核对每个失败测试身份，非模块解析/TypeError/超时：

| 删除的守卫 | 结果 | 对应失败 | stdout SHA-256 |
| --- | --- | --- | --- |
| exact fence比对 | 18通过/1失败 | 原reschedule后旧fence | `6da700e3e6843c5d65531090cd159b7b683d2c2ce25ae75e2e20d29bb7c87fa9` |
| proof xid比对 | 18通过/1失败 | 同物理client跨COMMIT | `3186135b8d777cbb60d57013d5586d5864c7e36df6082917836590cf600654dc` |
| take时重新validate | 16通过/3失败 | proof后lease到期/撤销/grant TTL到期 | `038dcc95ab62402fd2a81a971899828353fdb034002b56870c8cdfff12956ed3` |
| 实际存储payload比对 | 18通过/1失败 | 合法输入claim不能背书已变更的存储事件 | `765c6c7ce8d50e25b0b3732819fb1e974220897afe5afa3db66ec70433be2726` |

四轮均原测试exit1/0pending、source不变、guard违规0、实际停止删除成功；外层exit0仅表示降级确实致红且清理成功。当前六生产TS模块strict/noEmit自身诊断0，依赖图其它57条未归因诊断仍保留，不宣称全backend type-check。

抓不到的关键漏法：真实host绕过本模块、scope/worker注册来源不可信、JWT/live源验证未接线、先mint后COMMIT、COMMIT不明或重放后重mint、共享runner允许无私有handle调用、发送前未重验、ACK/unknown或远端重复CREATE。这些仍是执行整链的剩余工作，不因本层19项通过而删除。

## 前一阶段：请求与既有 outbox 同事务受理（私有候选，未全局激活）

新增 `yida-automation-outbox.ts` 和 `098_link_integration_yida_automation_outbox.sql`；管理 service 新增 `requestManual`，真实调用原 `enqueueOutboxEvent`，同事务写入批准行预留、原 outbox 事件、原 consumer 行与不可变 link。原 `reserveManual` 仍只做内部预留、deliveryQueued=false，不偷换为已受理；`requestManual` 仅在已知 COMMIT 后返回 deliveryQueued=true，含义是“有持久入队事实”，不表示仍在排队、已执行或已发送。canSend/externalWriteAttempted 仍为false，无执行permit。

新事件 `integration.yida.authorized.requested` 的 payload 只有 requestId；唯一事件身份、深度0、manifest版本5、固定consumer与source请求关系在SQL中约束。link不可改删/截断，并以RESTRICT保留原outbox/consumer；重复请求只读同一link，不重新分配行、不增加次数或重发事件。曾由内部方法留下、没有link的旧预留拒绝在重放时补建队列。共享producer或link插入失败时，新请求/事件/fanout一起回滚；COMMIT回执未知仅留下可回读的持久事实，不新mint能力。

显式私有 manifest v5 **只是候选**：基于冻结v4扩一条route，不改 CURRENT_ROUTING_MANIFEST、SUPPORTED_MANIFEST_VERSIONS、全局worker registry、HTTP或全局默认。测试明确默认仍v4、版本5未全局支持，不能在匹配私有consumer/权限/默认OFF闸尚未完成时注册生产调用方。发布前须复核manifest版本及097/098编号，不能据本地候选抢占其它分支编号。

新增最后期限checkpoint：真实入队SQL和锁等待也消费同一授权TTL；新请求在最后一次检查已过期则整体回滚。历史重放不重验发送资格、不续期。授权检查至实际COMMIT或网络的时间竞态仍不能被此检查原子消除，执行前还必须重验。

### 当前精确输入

| 输入 | SHA-256 |
| --- | --- |
| management service | `e91c3f2ecd285b2b89823ea4eebe1a316a874555b3d38d48fd38d1a157b60073` |
| private outbox producer | `90cad7c02913971e4e2a28cd097734cfa8d65a76e0c112cebfb12504ec3f7ae2` |
| store（含最后期限checkpoint） | `b309d6da272323303a35039e0aa335daa034b00f63fd6c001922d9f65f857fca` |
| 098 SQL | `1c2e6a2affab9956af85108246a0b4d318826cc438fe1d64b0c270c0a427dcac` |
| 原共享outbox迁移（未改） | `7e06d57f92d9e7b93fbd1202128325b475a991ac1e52d9aea0cfed716ea33300` |
| 当前live/management/producer整文件 | `a43862eb38705f0b95cdde2e1d18fc620e7e28e583e977dff7d009ece968e36a` |

### 整文件基线与保留的失败

当前 **41/41，0失败/0pending/exit0**：原30项+9项producer用例+五类SQL错配的一个完整循环+1项入队后过期回滚。五个错配各有独立实际事务/回滚与SQL错误码断言，不省略任何分支。实际执行原共享outbox Kysely迁移、原090–094与本地097/098；无宽松outbox假表，无权限/材料/SQL结果替身。SQL形状记录器仅透传实际结果；过期用例只注入单调时钟，在实际link INSERT之后推进，未伪造DB结果/设置系统时间。

stdout SHA `00601799d6c7bdaa429f29f234ee05be239c3bcf7969ae89b587d3649b26c817`；stderr SHA `254cf0eb01ba39e8504da3d1cf015b5b569d49d73ddf5c68e821c758a8e25df1`（新增临时values-free任务进度帧，不与旧stderr哈希混用）。原owned PG14/隔离namespace/非root/仅lo/五caps零；非法连接/.env读取0；源码hash前后相同；actualStopResolved/ownedDatabaseRemoved均true。五个当前生产TS模块strict/noEmit自身诊断0；依赖图仍57条未归因诊断，不称全backend通过。

保留：中间39项候选先通过（stdout `3b669333cbe3e77043a4da0359f1d3b33e395e8797bd374eed48c254c6489a52`）；增加五个独立建schema的SQL负例后，44项候选撞到**原90000ms外层进程上限**，SIGTERM、未取得JSON报告/guard结束帧（stdout/stderr均空SHA）。不得称44项绿、0 guard帧也不是零违规证明；该轮源码未变且实际PG停止删除。随后将五个SQL负例复用同一未改变夹具、仍逐事务回滚，减少四次完整schema构建，新增到期断言后成为当前41项。原90000ms总预算、15000ms test/hook预算、5000ms SQL预算及全部断言均未提高/放宽；未改时间服务。未单独量化总超时的唯一性能根因，不把后续通过解释为所有宿主时序风险已消失。

### 当前41项候选的降级验证

原41整文件、同一source hash集合，每轮新自产隔离PG；只通过临时Vite内存变换删除一个生产needle，不改测试oracle、磁盘源码或迁移：

| 删除的守卫 | 结果 | 被杀负例（已按失败身份核对） | stdout SHA-256 |
| --- | --- | --- | --- |
| 旧预留缺link时禁止补入队列 | 40通过/1失败 | old unlinked reservation不能在重放中升级为delivery | `3c43d82303688e2ea67d167d924150cde1633c3ce8a2fe45baf0c7af8f51fe38` |
| 新入队完成后的最后期限复核 | 40通过/1失败 | 实际link INSERT后到期必须回滚全部新入队事实 | `d3b4d931ed81af946fca4c254854c5f4f06e52fdbfb4d6f597e0e1f88194ebe1` |

两轮均原测试exit1/0pending，无TypeError或超时；guard违规0、源码前后相同、actualStopResolved和ownedDatabaseRemoved均true。外层exit0表示降级如期被杀与清理成功，不是41项全绿。尚抓不到真实JWT/宿主绑定、错误worker注册、伪造claim/fence、未提交/重放permit、远端重复CREATE或撤销中的网络竞态；后续执行整链必须另证。

这仍不是JWT端到端、worker执行/发送或正式CI证据。原通用outbox清理将被link的RESTRICT约束阻止删除相关事实；完整启用前还必须接清理器的精确跳过/保留策略，避免批量清理被单条引用打断，不能靠CASCADE释放发送证据。

当前store `b309d6da…57fca` 另已重跑原仓库整文件 **18/18、0失败/0pending/exit0**；stdout SHA `96a6f9c450a2c722c6d2eeeb97913b8675d3d0686a515c23aec5935a2cd898c9`，stderr SHA `7338c15117ddb5ad0a32ee14383fcfb242f1cbb41c21f6bd265311ef375ae868`。实际PG停止删除、guard违规0、source前后相同。此回归证明既有预算/撤销/事务用例在当前store上仍通过，不替代41项入队证据或未来worker执行验收。

下一实现顺序维持同一SA-06D：先接真实shared claim/fence与已知COMMIT后的私有委托能力，再保留人工守卫抽共享内核（包括原digest工厂的owner等式，见设计§2新增代码依据），随后接默认OFF私有consumer/interval及JWT、源溯源、unknown/stop整链。当前不提前注册可达发送入口。

## 前一阶段：授权管理与真实 live 前置、持久仓库同事务组合

新增私有 `yida-automation-authorization-service.ts`，将真实账号/权限复核、真实规则与加密材料选择、097 授权落库放进同一实际 PostgreSQL 事务。提供本地管理方法 create/inspect/revoke，以及尚未接 outbox 的内部 reserveManual。**没有注册 HTTP 端点，也没有产生可执行发送许可**；reservation 明确返回 deliveryQueued=false、canSend=false，不能据此返回“发送已受理”的 HTTP202。

每个操作（包括历史确认、查询和撤销）都复核 live grantor；新授权/新预留再重验规则和材料。重复确认及相同 requestKey 只回读历史，不重读凭据、不续期、不加次数、不授予新执行资格。材料撤销后可看历史但不能新增预留；规则 fingerprint 变化拒绝新预留；事务落库失败不留下半份授权；关闭 activation 后禁止新工作，仍允许通过当前权限验证的 owner 查询和撤销。未放宽旧人工 actor===owner 入口。

### 当前精确输入与组合验收

| 项目 | SHA-256 |
| --- | --- |
| management service | `20bda54a4f2b12faedb2d24384e26c0a802d360eedb1ca0fc78724b424b53fef` |
| 扩展历史查询后的 store | `9f8fe58b57ab3d760b7511d8953d229374ed1f8ab4792bca469abc660414a7be` |
| live authority（未改） | `cf926af314c846fe4263c242f2be94c7f89a49b21365f464598a48108421db24` |
| 当前 live+management realdb 整文件 | `15286ef9c889d787228c9869f0f95fe31280f047a5c83b28a30bcc80fbf589aa` |
| 097 SQL（未改） | `36a6f3f6d0097620cec889585bfedb57a75963b2722183e4b88284b38a82d1fc` |

上述精确候选 **30/30、0失败、0pending、exit0**（原22项+8项管理组合用例），stdout SHA `4f98e78d9473d38ef507127f2ca4356f637442772a8af461dd6c9b368bed51ec`；stderr SHA `2473831baa7784edb5185b6e98f9c48c8a6b5e999634ba8bd3feb151a8d4bb46`。沿用原 owned-PG14/helper/网络守卫，独立 namespace/非root/仅lo/五caps零；非法连接和.env读取0；源文件前后哈希相同；actualStopResolved=true、ownedDatabaseRemoved=true。不是用户 JWT HTTP 测试，不是正式 CI。

管理层 SQL 追踪器只记录语句形状并委派给实际 trx.query，不替换任何权限/规则/材料/仓库结果。当前四生产 TS 模块 strict/noEmit 自身诊断0，依赖图其它57条诊断未归因，仍不能称完整 backend type-check 通过。

上一轮30项运行的会话输出因上下文截断未取得最终收据，未据此宣布成功或失败；确认该会话已退出后，重新执行同一候选取得以上完整结果。没有把丢失观察记录的运行冒充新的成功证据。

### 管理组合的真实路径降级变异

两轮均对上述原30整文件执行，仅临时内存删除管理 service 的唯一生产 needle，不修改磁盘生产文件、不替换 DB 返回、不筛选测试名。用独立自产 PG 分别验证：

| 删除的守卫 | 实际被杀的负例 | 结果 | stdout SHA-256 |
| --- | --- | --- | --- |
| 管理操作的 live actor 复核 | 撤销管理权限后，历史/inspect/revoke 也必须拒绝 | 29通过/1失败 | `d169739473f46ddceab6a49afc5027b36320e0b0559f4f9ea0176f7de811fda3` |
| 新请求的 live 材料/规则复核 | 规则 fingerprint 改变后，新预留必须拒绝且不新增行 | 29通过/1失败 | `c512e0af571f4bbbf0fcd44f3c443f8555c9f73032477a133d7fe23e76d07ff4` |

按失败测试身份核对是预期真实路径，不是模块解析、TypeError、超时或另一条守卫碰巧兜底。两轮原测试exit1、0pending，实际停止/PG删除成功、非法出网/.env读取0、生产源码前后hash相同；外层exit0仅代表变异如期致红且清理闭合。这两条变异抓不到尚未实现的宿主JWT、outbox/worker、已提交permit和远端发送行为。

仍待接线：真实 JWT 和宿主安装/PLM 源溯源、同事务 outbox 受理与真实 claim/fence、明确 COMMIT 后的私有委托能力、人工/委托共享内核隔离、默认关闭的独立自动闸、interval producer、ACK/unknown 对账和整链审查。下面22项及旧store18项均为其各自旧输入的阶段证据，不移签到当前修改后的全部模块。

### 当前源码回归复跑

- 修改后的 store `9f8fe58b…14a7be` 跑原仓库整文件 **18/18**，0失败/0pending，stdout SHA `b5ec63c7c7030b817691baab53fc5b2c7377bf1485ba97721749ff819fb78c26`。原090与097实际执行；源码前后不变，原guard违规0，actualStopResolved/ownedDatabaseRemoved均true。这次结果才覆盖新增历史/read方法后的store候选；下节旧18项证据保留但不替代此结果。
- 合同整文件 **82/82**，源码/测试hash保持原值，0失败/0pending/exit0，原网络/.env守卫0违规；stdout SHA `c31da001630ab654fa3f58c657204ef42b2a9c6fe1ce808a4fc92b1fa96c918c`。这是合同回归，不是整个自动发送的端到端验收。
- 本次30/18/82分别覆盖管理组合、仓库和纯合同；不要将三个计数合并包装成完整自动发送130项验收。没有正式CI、JWT请求或真实宜搭调用。

## 前一阶段：live actor/规则/宜搭材料前置证明已本地实现

新增 `yida-automation-live-authority.ts` 和独立 realdb 整文件。当前仅是**同事务私有材料前置证明**，不是已提交的发送permit，不是JWT路由或完整执行授权。调用真实 `assertAutomationIntegrationActor`、真实 `lockAutomationReadRule` 以及原生 `createYidaSendAuthorityPrimitives.resolveSelectionInTransaction`；不复制凭据/草案/批准目标读取实现，不调用旧owner执行digest冒充service。

已实际核对：当前账号/成员/管理权限/namespace admission、真实规则creator与nonce/enabled状态、受管base/sheet关系、稳定action slot、单目标/CREATE/credential generation、计划/业务键/payload摘要、实际选中行的项目字段。材料摘要还绑定确认标识、触发同意集合、次数与TTL，旧摘要不能背书扩大后的同意合同。材料proof是实例闭包WeakMap中的空对象：单次取出、绑定实际queryable及数据库xid，JSON复制、关闭activation或同client跨COMMIT均拒绝。

真实现有rule格式使用null/legacy，不是最初夹具中误设的sequential；已据原operation-policy代码修正候选与夹具，并增加真实单项modern action正例、第二动作/workflow mode负例。grantRef将在私有activation映射中绑定，rule只存稳定authorizationSlot，避免改rule后nonce自失效。该格式与受管绑定来源的实际注册尚待接线，不冒称当前工作台已能保存新动作。

### 精确输入与基线

| 项目 | SHA-256 |
| --- | --- |
| 新live authority源码 | `cf926af314c846fe4263c242f2be94c7f89a49b21365f464598a48108421db24` |
| 对应realdb整文件 | `b7c10aa91c5b597d756206dda82fc787cebd8bcd9f31e0bf013a1eebc28e63fe` |
| 原live actor helper | `6ca930c0ba4916df791253dde71d938a70f215bd227b82a46976e92727c21c9c` |
| 原rule helper | `7cf306bedff74333fbe6ecd1c1ab56389ef9da4c82b3877970aeff156e011099` |
| 原私有plugin primitives | `51be40dec3a558b43eb3724c1a014071e16eb3625d419603427cef676f398e78` |

当前整文件**22/22**（1环境硬哨兵+21业务用例），0失败/0pending/exit0；stdout SHA `eb133a1bfd5e21a5bd3d4eb6ec9ec59a6068b3e5d13edd47d228ab7c87955cc0`，stderr SHA `2473831baa7784edb5185b6e98f9c48c8a6b5e999634ba8bd3feb151a8d4bb46`。原owned PG14、新namespace/仅lo/非root/五caps零，实际Crypto与原090–094完整SQL；用户/规则表仅为现有helper实际读取列的合成schema fixture，不是全部平台迁移证据。源码前后哈希相等；actualStopResolved、ownedDatabaseRemoved均true。

临时setup仅将namespace-admission无关的global DB导出换成**一调用即抛错的tripwire**，调用数最终为0；不是伪造DB返回，也不替换正要证明的live helper/规则守卫/加密/primitives。所有被测ACL、规则及材料SQL经显式原PG事务执行；原网络/.env guard仍安装并0违规。宿主base/sheet/字段角色绑定作为合成可信安装输入：其真实安装来源、JWT认证以及原PLM读取/连接revision等源溯源仍须后续接线证明。

三新生产模块使用当前源码图、既有安装包声明做strict/noEmit定向检查：本三文件自身诊断0；依赖图还有57条其它诊断，未做基线归因，不宣称完整backend type-check通过。包声明从已有native检出解析，项目相对导入保持当前源码，不替换实现。

### 当前精确源码的三条真库路径变异

每轮执行当前原22整文件，唯一变化是临时Vite pre-transform中的一个生产needle；各轮新建隔离PG，无test名称过滤，不替换ACL/规则/材料查询结果，source hash前后一致。三轮均实际停止并删除PG、0pending、零非法出网/.env读取；原测试exit1，外层exit0只表示预期变异确实致红且清理成功。

| 降级 | 结果 | stdout SHA-256 |
| --- | --- | --- |
| 删除live actor复核 | 18通过/4失败，对应四种live撤权负例 | `ea3d3b44a5aba1e7561383d650b73109b49864ae36e5ba56c30a7dee9bb1214b` |
| 删除实际选中行的项目绑定 | 21通过/1失败 | `e012e69888733133db7f93bccea62408a4c14d0b578ae90e6dd543581f1d4220` |
| 不比较proof原数据库xid | 21通过/1失败，同一client跨COMMIT负例 | `b85ce7d13100bc12d14eea4a34e4e9e3002fc9c638344d778677ab13ed651866` |

这些变异仍抓不到：最终宿主不调用本前置、host安装绑定来源伪造、JWT门未接线、后台用owner冒充service、发送前跨事务未重验、permit在COMMIT不明后再mint、远端重复CREATE。它们不是当前测试的保证范围，后续实际组装/HTTP/worker/私有能力/回归和独立审查必须另证。

### 初始失败保留

- 最初collection未执行业务例（0/0），由缺少临时依赖解析定位到bcryptjs；只给临时配置接已有安装依赖，不安装包、不改生产依赖。stdout SHA `1300a11609c2501dbc4a7db82c1ec2e6ae54bbc66d41d7b9afebf2c71f5fc05d`。
- 随后1哨兵通过/19业务失败，固定码YIDA_APPROVED_TARGET_INPUT；夹具将credential create返回metadata整体spread给严格target.register，违反其闭合输入合同。改为仅传credentialRef/generation；未修改目标守卫。该失败stdout SHA `75a50414b655e88662dc008ba4c5794907876c8faf7249d359abf56da8fe32b2`，自产合成报告保留在native tmp私有目录，不读取.env/客户数据。
- 20/20属于添加真实legacy/modern合同核对前的旧候选；22/22的中间候选也先于完整同意摘要绑定。只以上述当前源码hash及最新22/22为基线；此前变异结果不移签当前源码。

本阶段仍未实现发送许可mint/worker、四JWT入口、实际安装/源配置revision接线、独立自动闸、ACK/unknown收口及对账。不能从真实PG材料前置证明推导“允许发送”或“自动发送已可试用”。

## 最新阶段：持久授权仓库与原子预算已本地验收

新增 `097_create_integration_yida_automation_authorizations.sql`、私有 `yida-automation-authorization-store.ts` 和对应 realdb 整文件。编号分配前只读 main 目录，main 数字 SQL 最新088，本叠层已使用089–096，故本地选097；未来发布前仍须重新盘点，不占用其它分支未公布编号。

这层是**私有持久化仓库，不是 live 授权服务或发送许可**。每个调用要求真实、read-committed 事务（复用原 xid 双探针），固定 tenant/null-workspace/owner 作用域；后续 core authority 必须在同一事务内重验 live ACL、实际材料/版本/目标、准备真实 ledger，再调用 admission，待明确 COMMIT 后才能产生私有 handle。没有把 materialRevision 字符串当权限证明，没有把 workerId/fence 输入当作已核验 dispatcher 身份。

已实现：

- 同确认标识事务锁与不可变合同；重复确认只读历史，不续期或加次数。
- 同 occurrence 唯一请求、固定 row ordinal；重复请求不取下一行，不释放预留。
- durable 撤销；新请求与 admission 拒绝已撤销、重启 activation、过期或时间水位回退。
- admission 核对实际090 prepared CREATE行的 scope/operation/row；与 ledger 准备、一次计数、active-request 及 admission 同事务提交。
- 数据库 immutable/RESTRICT/唯一约束，以及 deferred constraint trigger：提交时 used_executions 必须等于持久 admission 数；禁止退款或孤立改计数。
- 不并发 admission；未知/崩溃的 active request 当前继续阻止下一次 admission。后续按原ledger事实关闭/对账的能力尚未接入，不能自行清 active 指针来恢复。

### 当前精确证据

| 输入 | SHA-256 |
| --- | --- |
| store生产TS | `53ad7472d3e55380f4150ad74002d28158b257c454c1c1feb61dae6e92f5319a` |
| realdb整文件 | `8284d6cc3208e0b866ff9100d1c4ba7434d6d83ae29e71fab89867bb73cd1363` |
| 097迁移 | `36a6f3f6d0097620cec889585bfedb57a75963b2722183e4b88284b38a82d1fc` |
| 原090迁移 | `e47626c4e07c73d22c84d66141a12d0fcff59d49a75b246b7857ed7e22d50fd1` |
| 原native guard | `bda3deb2c5edec07894de592e6d592011a347a8c569a84ab57f0299522f9e721` |

使用原 owned-PG helper新建 PostgreSQL14，自产随机材料、独立user/net/PID namespace、仅lo、非root、五capabilities零；不连接任何既有DB。每个用例实际应用原090和新097，真实连接/行锁/事务/约束，不替换SQL结果。18项包含1个EXPECT_DB硬哨兵和17个业务仓库用例，**18/18、0失败、0pending、exit0**；stderr原guard非法出网/.env读取均0，worker afterAll确认实际guard安装、只使用获准的自产PG。source前后逐hash相同，actualStopResolved=true、ownedDatabaseRemoved=true，外层自然exit0。

baseline stdout SHA `74c3fff6ed15a797aae5b013d4449176789b69f16a8ded4a4fae85b748019a65`；stderr SHA `2473831baa7784edb5185b6e98f9c48c8a6b5e999634ba8bd3feb151a8d4bb46`。

其中并发例实际同时运行两个事务竞争，确认一个admission提交、另一个整笔回滚；回滚例确认准备ledger/admission/计数一起消失；提交未知例在真实COMMIT之后注入合成调用方异常，再验证历史重读不重复计数。后者不是网络断连实测，也不证明尚未实现的执行handle不会重mint。

### 两个真实DB路径降级变异

在已通过的18整文件上，仅临时Vite内存变换生产store唯一needle，不改测试oracle/生产磁盘/迁移，分别新建独立自产PG：

- 删除 active admission 守卫：17通过/1失败，原进程exit1；stdout SHA `af08186b7754a7aeba01624c0369cb19fc2455bfb7d37b75e687e5a3d7cd4982`。
- 删除撤销守卫：16通过/2失败，原进程exit1；stdout SHA `939b1cad6a8585e5190c76732e1d09fcad76191407066d6cb8b0f0543610a5e9`。

两轮均0pending、零非法出网/.env读取、源码未改，最终真实PG停止删除，外层exit0表示变异致红及清理获证。前一版13/13属于添加5条负例之前的测试文件，不与当前18计数混用。

store与测试TS已通过语法转译诊断0；**尚未跑完整backend type-check/lint或CI**。为防默认非DB配置收集真库套件，只在既有vitest.config.ts显式exclude新文件，原套件和全局开关/重试默认不变；本轮通过独立tmp配置实际运行，不是skip-green。未来CI接线仍待授权，不声称新文件已进入正式CI。

### 仍未完成，不得代签的部分

core真实JWT、live owner/材料前置与本仓库的同事务组装、已审目标/连接引用生命周期保护、scope版本变化下的原子拒绝、私有一次性委托句柄、runner共享内核与人工入口隔离、outbox同事务受理/producer proof、四路由/有限interval、独立默认OFF开关、ACK/unknown收口及对账、整链变异与独立审查均仍需继续实现。独立live前置的代码/22项证据见顶节，不冒称已经接入本仓库的调用方。仓库层允许在内部事务中保存/查询事实，但不对外注册或发网；不把18/18+82/82当整个SA-06D完成。

## 1. 当前落地范围

首个依赖步骤为 core 纯合同模块 `packages/core-backend/src/integration/yida-automation-authorization-contracts.ts`，以及原生产函数的 Vitest 整文件 `packages/core-backend/tests/unit/integration/yida-automation-authorization-contracts.test.ts`。

- 显式固定确认标识、项目、规则版本/动作、operation 与有限行引用；次数 1–10、TTL 1–900000ms、行数不超过次数；不默补客户端遗漏的同意参数。
- 固定 manual/interval 集合，拒绝 cron/record/webhook 扩范围；拒绝 tenant/actor/owner/permit/payload 自报字段。
- 深入检查 own data descriptor；拒绝 getter、Proxy、符号字段、稀疏/带额外字段数组与继承输入，返回独立冻结副本。
- 明确版本化 canonical occurrence tuple，绑定授权、activation、规则版本/动作和真正调度时刻/定义摘要；重投次数、fence、当前时间不能加入请求身份。
- 模块只解析描述，不产生授权、scheduler proof 或执行 handle；**尚未接线**真实 JWT、DB live 权限、授权表、原子 admission/计数、私有委托能力、队列/端点/worker 或发送器。不能把纯合同测试称为完整真实发送链路。

首轮当时已有八个工作区跟踪改动原样保留，新增业务文件为上述两项；后续新增store/迁移/真库套件及独立收集排除见顶节。没有改人工 owner/只读 Automation 的现有实现，没有新增真实可达入口或环境开关。

## 2. 当前精确源码与验收

| 项目 | SHA-256 |
| --- | --- |
| 生产合同 TS | `9842bbc25ce49a98c0aafe76f13cb9d7895acc653c966c2e5d6d8e8cce47b313` |
| 原 Vitest 整文件 | `bd23e4dc9375c7452edfabbf7e28be7262cd4e07d1f6f2b424cd9b2d79fef25a` |
| 最终无变异 stdout | `0c162a9501673268deb5eebdc47b44ed63e3ccc9847e732c52efb68d9d7584ed` |
| 最终 stderr/隔离帧 | `2473831baa7784edb5185b6e98f9c48c8a6b5e999634ba8bd3feb151a8d4bb46` |

运行现有本机 Vitest 1.6.1、Node20.20.2，通过隔离 Linux 非 root runner；只借用已存在依赖，不安装、不下载。原网络/.env preloader 不修改；临时配置单文件运行、retry=0、关闭 Vite ws/hmr、host=127.0.0.1，空 envDir，不读取项目默认 setup 或继承数据库配置。

原整文件 **82/82，通过；失败0、pending0、exit0**。setup/afterAll 确认真正安装原 native guard，禁止网络/.env读取/允许连接计数全为0；父/子进程源码前后哈希相等。此次没有数据库、浏览器或外部目标，所以不借旧71/真实PG证据为本新代码背书。

叶模块独立 TypeScript strict/noEmit 检查：0诊断、未输出构建件。不是整个 backend type-check 或 lint 已通过。最初发现一个数组属性描述符的 TS2551，改为原生 own length descriptor；改后重新跑完整82项和全部四变异，证据绑定改后源码。

## 3. 单点变异自证（内存，不修改生产文件）

先执行真实导出函数的原整文件，再通过临时 Vite pre-transform 对唯一生产模块替换一个明确 needle；不更换测试 oracle、数据库返回或生产落盘源码。每个变异独立缓存目录，整文件执行、不做用例名称过滤。

| 变异 | 测试结果 | stdout SHA-256 |
| --- | --- | --- |
| 去掉 maxExecutions≤10 | 81通过/1失败，变异被杀 | `14cb8311ef12d8a9b15c22b11cd65d9d8be20af27d6e0cfe34a0bebc150f063d` |
| 去掉行数≤次数 | 81通过/1失败，变异被杀 | `a902b6832dd74a99b729dea00edf45decbd849a16b1f237a2d6ee6883913247b` |
| 去掉行去重 | 81通过/1失败，变异被杀 | `88cab09e6c20ce98c2fc83109a9216fc5e7104deebf33e7861687216174ee4a2` |
| occurrence 不绑定 activation | 81通过/1失败，变异被杀 | `5684ca88ac7e9b1f5ace96b436720d914b3ce50a271f6bdcaf726a0e344e7935` |

四者 pending=0、原测试进程exit1、零网络/.env读取、源码未变；外层核验程序exit0表示确认变异确实致红，不是把测试失败改成通过。仍抓不到的降级：后续宿主不调用这些函数、JWT/DB授权守卫缺失、持久预算竞态、委托句柄伪造、worker重放、真实远端幂等；这些必须由尚待实现的接线/真库/HTTP/私有能力测试补齐，不能从82项推导。

## 4. 工具失败与限制如实保留

- 首次 Windows 验证 exit92、无测试报告，原 guard 拒绝；stderr SHA `e4422b3b2d0ed30dc43810c477076e30e04ad00029bce9e4356b1b530524fd44`。未宣称业务测试失败或移除守卫。
- Linux 首次同样 exit92，分类 FORBIDDEN_NETWORK；stderr SHA `8b87ced6daf3c9d24eee55def909c1d4293a17757cec2c0d8f89fa9289265d22`。临时 Vite 配置后来显式设 host=127.0.0.1 后才通过；这证明配置对照相关，不宣称唯一根因已充分取证。原 guard 没有增加放行规则，最终连接数仍0。
- 临时驱动/配置仅在 tmp，清空继承环境并输出固定计数/哈希；未读取.env、私有凭据、客户数据或旧私有CI产物。没有改变系统时间/同步服务。

## 5. 下一依赖与完成门（继续实施，不缩小目标）

1. 实现有限授权持久事实、撤销与 request→row 预留/原子 budget admission；使用当前 main 对齐的独立迁移编号，真PG并发/提交未知/重启负例。
2. core 根据真实已审材料和当前 owner/tenant/member/权限生成委托证明；私有句柄与共享 runner 内核接线，人工相等守卫不放宽。
3. 既有 outbox/dispatcher、有限 interval/手动请求、四操作路由、默认OFF/独立自动开关与停止清理；不复用只读grant或自调用HTTP。
4. 真实 JWT→core→transaction/ledger→私有能力→生产 token/form 模块全链合成网络边界，撤销/unknown/多worker/时钟/原71回归、变异与独立审查。

没有在此阶段宣称SA-06D可试用或整个目标完成；现有初始化/静态预览的阶段交付与新自动发送实现进度分开。后续所有工作仍仅本地，不推送、不触发CI、不合并、不部署、不访问客户系统、不真实发送。
# 本轮加速收尾：真实批准/请求页面组合候选（未验收）

新增的仅为既有 SA-06D 验收接线：复用原初始化浏览器的真实密码登录、生产 bundle 字节检查、严格请求窗口及真实浏览器/Vite close；新建独立 context，在实际匹配草稿的合成项目进入有限授权面板，点击逐行预览、有限同意、两次请求和撤销。原默认 OFF 初始化、两子进程及停止证明不替换、不放宽。测试数据中的另一条 inactive 项目行在原业务快照之前建立，原项目种子仍是一条，不能把错误项目改成可授权。

发送仅在原隔离主应用内部、两个固定假远端的独立窗口中开启已登记开关；finally 还原两个开关，真实远端仍禁止。新页面必须分别观测 ACK（业务未核实）与 admitted/outcome_unknown、禁再次 CREATE 和不退次数，父应用继续核对真实账本及原 consumer 的 done/dead_letter、attempts=1。旧 Node HTTP 同键重放证明保留在上一源集合，不伪称本次页面有重复点击证明；在途 stop 和独立终审仍未完成。

本次冻结 6775 项，sourceSet `e0f60cfd8802e46169784f232a1ef26830fbd86baa105ff58f14f7955b18b4cd`，archive `e302942e2dff83140622576f1ae42d50570d288b7ac1a2c7f0e9e1893e9cedf5`，固定 HEAD 与空 index、Windows 原生源字节核验已通过。正在准备 owned 原生 FS 候选并运行原 CLI；**尚未通过，不借旧 197/71 或旧完整链绿代签**。没有推送、CI、合并、部署、客户读取或真实发送。

该源集合的原契约套件已经真实执行 **197/197，fail/cancelled/skipped/todo 全0、exit0**，源字节前后不变；stdout SHA `e6f0cd30596dc7f8b45a5728cf6c8a27241e886d9e8a0a90408a70f1f4d6491c`、stderr 为空。原完整 CLI 的 harness types、完整 web 类型和 core 构建已进入后续阶段，页面执行及正常停止结果仍待验证；197 项不代替该结果。

首次页面组合已终结为失败，不能沿用上一段等待口径：`P7vW3z` 原9阶段的类型/两构建/478迁移与重放均成功，configured-app 在新合成窗口 BEGIN 失败，token/form/refused 均0，尚未进入批准或请求；不是已捕获 ABORTED 或某个生产守卫错误的证据。stdout SHA `9239d65e988f20b1f6c952884b2ddd5f4e84c0895d5877db2e58d4d302b04507`，stderr `5270c7adbbb3ec38d6d4a8b26c76dcc54ba5abb9edf2391126b9621c9ebaf9ec`，原收据 SHA `bb87d733e92a26444abe51236f7d6b8a298f7b2118b46c1971ca95885a25741c`。actual-stop-resolved 出现，正常 production-stop 证明因前序探针失败拒绝，应急收尾后 owned PG 停止删除；不冒称正常整链停止门已过。终结后、编辑前 Windows 原生6775项/固定HEAD/空index再次核验通过。

下一候选仅增加新页面外壳的闭合 phase/计数/固定 fault 标签诊断，不改生产授权逻辑、超时预算、路由允许集合或业务断言；sourceSet `bee7b33940281cf8a2fc3662c38ee145ecd7bff1df2ca3292f81f9d909d751d3`、archive `16111f98c19e2d07f175957255cc90e4ee791eb98888a89b86ecb708104e2ad3`。不转发 Playwright 原错误、URL、DOM、响应、口令或 JWT；准备前 Windows 核验通过，尚待隔离原CLI结果。

诊断版同样失败，来源 `YkDO7e`、stdout SHA `bde56e8df609ea3f64def6c4948aa3457b0b33f7d6cfeab8a908236fe4f779d9`、stderr 仍为上述固定失败标签、原收据 SHA `754100c1eef40ff52b2f4de9118912cbccf958854084b132a07e5c7bf3b6b84c`。阶段精确到 PREVIEW：四请求/四完整响应、两预览200，批准/运行均0；正常登录1/board1/production document1，外部请求/禁止请求及外壳fault均0。不是启动、401、503或ABORTED的证据；actual stop成功、前序失败使正常stop proof拒绝、应急PG清理与编辑前全源核验均获证。

代码溯源发现真实身份域混淆：`yida-approved-target-store.mjs` 为090批准目标独立生成UUID，并以 `draft_target_ref` 引用091本地草稿目标；preview返回090 targetRef，初始化draft返回091 targetRef。新UI却把前者与 `snapshot.targetRef` 比较，原SFC假响应又共用同一个UUID，故漏测。最小候选只改为**比较所有服务端preview的已审目标彼此一致**，原operation/row成员由现有实际client精确校验，原planDigest/review/organization/app/form一致性检查及后台实时重验全部保留。测试fixture从此区分两ID，并新增六类跨行身份/摘要不一致负例；正在跑原整批web及恢复旧比较/移除跨行目标检查的两个单点变异。完整页面对照仍待验证，当前不能提前签根因已全部闭合。

修复后的原整批真实SFC/实际client套件 **302/302**，pending/失败0、exit0；stdout SHA `b292fef86f8e848935e86f68d9d02afa8bdc85ac9890751f66ad655bcc5433ad`、stderr `83aaca77318328cc4b1377435001309e99dccec64e638c2730ac48786eaa6a2d`。这批仍只在fetch边界合成，不替代真实页面。两个内存单点变异单独执行原mutation范围206项：恢复旧targetRef跨域比较200过/6失败，stdout `bd4620952e68300400b205e365ae744233949151a7a3a992d916492dc01d8185`；删除跨行approved targetRef相等检查205过/1失败，stdout `4ee0130086fe8dd7c00775dd10a5784629a5b231e6ef453af5c8f614a82b0d86`。均实际exit1、pending0、原源码不变、非法连接/.env读取0、owned资源停止清理；外层exit0是证实变异致红，不是忽略失败。mutation范围不包含既有ProjectBoard整文件，明确不把206冒充302。

新6775源 sourceSet `f44330e141f3f4d353d2bcb21f9d79dcdc6172b17d841920a436e0f990200da9`、archive `b0728d1e4b27a657ebb0cab1bc95b7ded909ab0cb0d00f303c388b2d9a996a84`，正准备全新owned候选跑原完整CLI；原工作副本/固定HEAD/空index核验通过。当前这一步不是CI或正式Chrome交互试用，不改变无推送/无部署/无客户数据/无真实发送边界。
