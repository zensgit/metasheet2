# SA-01/SA-02：本地恢复、设计与验证记录

**最新授权（2026-10-24）：Owner 允许将已验证补丁与 MD 普通追加到现有 #6323/#6324，核对叠层和 pin 后运行既有合成 CI；不强推、不新增切片、不合并、不部署、不读取客户数据、不真实发送。#6337 保持封存。下文各轮“未推送/仅本地”保留为当时事实，不代表撤回本次发布授权。**

日期：2026-10-24。范围仅为既有 #6323 / #6324；Claude 实现，Codex 独立审阅与复现。用户本次授权允许本地对齐、最小修复、合成验收，不授权推送、CI 触发、GitHub 合并、部署、客户读取或外部发送。#6337 继续封存。本记录不表示完整自助集成目标已经完成。

## 0. 上一轮本地结果（复审已发现阻断）

**2026-10-24 复审更正：撤回此前“本地收尾完成、合成验收通过”的总体结论。** 下表中的选定测试结果仍成立，但未覆盖完整插件链，且新的合成反例确认了生产语义缺陷。当前裁决为修复后再验收，具体见 §7。历史结果及失败记录保留；没有推送或触发 CI。

用户随后限定本轮先修三项：宜搭链清单、FP-7、K3-F1。对应本地补丁及新验证见 §8；未把其余发现算作已解决。

用户再授权的 FP-1 / FP-6 本地最小修复及独立验证续记于 §9；前轮补丁和失败记录完整保留。

**客户语义补充（§10）：项目号按客户源字段的不区分大小写规则判断时，仅大小写不同代表同一项目。§7/§9 把该差异视为跨项目的假设已撤回；后续已按用户授权实现来源级可选比较，最终本地验证见 §11，不能用旧测试替代该验证。**

用户随后授权将来源比较方式及状态值做成配置；先行决策和本轮实现/验证见 §11。§10 保留为提出配置需求时的历史状态，不能据其“尚无配置”判断本轮代码。

| 验证面 | 最终本地结果 |
| --- | --- |
| K3 | 13 个相关完整插件入口；前端 7 文件 361/361；类型检查通过 |
| PLM / 备料交互回归 | WSL 单次完整批次 135/135 个既有 CJS 入口，零失败；不是全仓所有测试 |
| 真实宿主与数据库 | 宿主 23/23；锁协议 56/56；独占合成 PG 实际停止且移除 |
| 核心 unit | facade 79 + revision 38 = 117/117 |
| PLM 前端 | 6 文件 514/514；主类型目标及 approval / stock-prep 两个专项类型目标全部通过 |
| 核心类型目标 | 原 `tsc --noEmit` 及 recovery-archive-acceptance 目标均通过 |
| 构建 | 前端 Vite 构建成功，156 个产物；Docker 依赖闭包守卫 4/4（本轮没有新建真实 Docker 镜像） |
| 完整性 | required-wiring 65/65；完整 provenance 通过；模块重算零差异 |
| 关键校准 | active 110/110；artifact-version 106/106；身份 9/9；runtime 32/32；旧 golden 字面量保留，demand 124/124、continuation 13/13 |

K3 本地分支 `codex/local-k3-closeout-20261024`，检查点 `b92cbd908d31cbad95f30d4cc45ebc370b323533`；其树与已验证的 `67e9761` 完全相同，并保留原 #6323 与冻结 main 的祖先关系。PLM 本地分支为 `codex/local-plm-closeout-20261024`，同样保留原 PR 与新 K3 层的祖先关系，方便后续获得授权后普通追加。当前 GitHub PR 头未改变。

## 1. 固定对象与隔离方式

- 本轮 main 对齐锚：`771170234e95ff67c0b1d32b2e4929c08d7ee39e`。
- K3 原 PR：`1370b2d96f1e9edf0c36c322ac1156de0f02410f`；正确旧父为第二父 `1d37957705c6a16fb6885173e6645c2c068738a8`。
- 只移植两者净差量：33 文件，15 新增、18 修改，无迁移；避免再次携入已经 squash 合入 main 的旧宜搭层。
- PLM 原 PR：`8ff17b70554267bb2d34d5d67d588237bdfa6587`；应以 `1370b2d..8ff17b7` 的净差量接在新 K3 层之上，不盲目重放其中含 merge 的历史提交。
- 原 K3、PLM 检出均有未提交改动，本轮未修改它们。K3 在新建隔离 worktree 内进行。未更新任何公开分支。
- K3 修复的本地检查点：`0048067e178cc3fd4c1ccf3dc842ef9c1f6f2701`，仅用于保全已验证补丁。

## 2. K3 最小修复及模型来源

Codex 在原 K3 和 main `714c910` 上分别独立复现了同一个既有缺陷：BL2 物料 ID 允许有限数字，在通用输入归一化时先 `String()`，使 JavaScript 已经舍入的不安全整数变成合法十进制字符串。直接调用纯 key 校验器会拒绝该数字，但真实 prepare → execute → K3 adapter 链会查询舍入后的错误物料 ID。此问题不是 #6323 新引入，也不是写入或授权越界。

K3 修复实际调用本机 Claude Code 2.1.310，使用 Sonnet、high effort；返回的 `modelUsage` 标识为 `claude-sonnet-5-5`。该调用禁用工具、浏览器、MCP 和会话持久化，仅根据提供的代码返回受限补丁。Claude 没有运行测试；以下验证均由 Codex 实际执行。后续 PLM 的 Opus / Astra 分工见 §6；本轮未调用 Grok 或 Kimi。

修复只在 `read-source-probe-runtime.cjs` 的 BL2 计划分支、`String()` 之前重用既有 `isBomListByMaterialKeyValid` 校验数字，拒绝不安全整数、负数及小数，沿用封闭错误原因 `key_required`。原有长十进制字符串和安全整数保留；其它业务 key 模式不收紧。没有新增端点、标志、凭据路径或权限。

新增测试覆盖两条共享运行时路径及实际注册 HTTP handler。运行时使用真实 prepare、execute 与 K3 adapter，仅替换 fetch；HTTP 使用真实注册表/配置 store/adapter 及内存数据库，**不声称覆盖 JWT middleware 或物理数据库事务**。负例在读取凭据、创建 adapter、调用模拟 K3 之前拒绝，配置和业务记录不变。正例确认安全整数、最大安全整数及精确长字符串进入预期固定 Filter。

## 3. K3 已完成的本地验证

对齐到本轮 main 后，以下 13 个完整插件入口通过：

```text
read-source-probe-runtime
read-source-read-runtime
read-source-bom-list-by-material-contract
read-source-bom-list-by-material-runtime
read-source-k3-material-list-b4-contract
k3-b4-http-source-run
stock-preparation-readonly-source-run
k3-wise-redirect-fence
k3-read-operation-profiles
k3-b4-response-contract
k3-b4-source-run
k3-wise-adapters
k3-external-write-permanent-fence
```

其中 HTTP 文件为 68/68，重定向 10/10，operation profiles 8/8，B4 响应 9/9，B4 source-run 14/14，永久写围栏 14/14，B4 配置合同 7/7。其它入口只有自身 OK 行，未虚构用例数量。

- 前端 7 个完整文件：361/361，无失败。文件为 `IntegrationK3B4RunPanel`、`IntegrationK3B4WorkbenchAccess`、`IntegrationK3Bl2RunPanel`、`IntegrationK3Bl2Services`、`IntegrationK3WorkbenchStartup`、`IntegrationReadSourceConfigPanel`、`IntegrationReadSourceWizard`。使用 1–2 workers；保留组件/路由 fixture 的警告，不以警告当作失败。
- WSL 的 `integration-guard-required-wiring-contract.test.mjs`：65/65。
- WSL 的 `sealed-export-package-provenance.test.cjs`：完整通过；被 pin 文件为 LF，未重打或绕过 pin。
- 仅在内存移除新增数字守卫：运行时新增负例以 Missing expected exception 失败；HTTP 新增负例以应为 400、实际为 200 失败。两者 exit 1，没有修改工作树生产守卫。
- `git diff --cached --check`：通过。
- 前端 `vue-tsc -b`：exit 0，零 TS 错误。

执行环境记录：隔离检出与主检出的 lockfile blob 相同（`14074139e16b386c23a120b8061b89e2d0c2b76d`），复用既有依赖目录的本地 junction，未安装依赖、未读取 env 文件。MSSQL 只读工具包在两个固定对象间无源差异。

保留的失败与修正：第一轮批量命令有三个猜测的不存在测试名，不作为产品失败或通过；随后按仓库实际文件运行。Windows 门禁先被商店 Python 占位入口拒绝；provenance 的 Bash/Windows 路径执行失败；转至既有 WSL 执行完整测试。WSL 门禁最初 59/65，原因是两个 shell 工作副本 CRLF；仅从本隔离检出索引按 LF 还原同字节脚本后为 65/65，未削弱断言或提交行为改动。适配器首次因隔离检出未装 workspace 依赖失败，复用同锁依赖后通过。第一次前端命令只设 maxWorkers，触发 min/max 冲突且无测试执行；明确 minWorkers=1、maxWorkers=2 后完整 361/361。

## 4. PLM 对齐设计与阶段记录

初期只读三方分析：整支旧历史合 main 有 47 个文本冲突文件；以净差量处理后缩为 16 个。该数量是当时的分析结果，实际新 K3 父层上为 14 个，见下述续记。

必须同时保留：订单 BOM 版本选择、子件自身版本、main 的需求证据捕获；已生效 readPlan 身份与 token 配置身份；main 的 generation binder、项目写 lease、原子 consume、host fence、来源内容摘要及归档整链。前端失败原因 union 要包括 pilot/write-lock 分类，不能降级成普通读取错误或自动重试。

迁移保持原编号：PLM `089_create_integration_stock_prep_read_plan_versions.sql`，宜搭从 090 起；main 的 100 项目写锁、101 pilot 迁移都保留。不能复制旧 migrations 目录或为消除文本冲突恢复旧编号。

PLM host fixture 原来只建立到 089 及其 revision/ledger TS 迁移；对齐 main 后，可写 caller 预览在发 token 前会 bump generation，因此需要 fixture 的 100 写锁迁移支持。初查时尚未运行，未据此宣称已确认失败；后续实际补装既有 100 迁移并通过真实宿主验证，没有删除生产 binder。

初次对齐时待完成的是实际差量接线、SA01/SA02 回归、main 写锁/pilot/source parity 交互、类型检查与独立合成 PG + 浏览器闭环；这些已由后续验证闭合，见 §0/§6。既有 PR 的历史 CI 不替代本轮结果，本轮也没有触发新 CI。

### PLM 本地续记（保留当时状态，最终结果见 §0/§6）

- 使用全新 `plm-local-closeout-20261024` worktree；原 `membership-publish-20261021` 已恢复原 head `8ff17b7` 及干净 tracked/untracked 状态，原配置文件未改。
- 补充更正：`packages/core-backend/.env` 是仓库跟踪文件，最初将其误称为 ignored。新测试副本只对该文件做无读取的本地暂存隔离，未查看或哈希其内容，未提交删除；测试子进程清空非 OS 必要环境，只使用自行生成的合成材料。
- 实际 Claude Opus high（返回模型标识 `claude-opus-5-5`）生成 13 文件冲突补丁；Codex 应用后，两个生产模块 `node --check` 通过。净差量在新 K3 父层上实际为 14 个冲突文件，其中 provenance 文件由模块函数生成解决。
- `computePackageProvenancePinSet` 对当前工作树重算；相对新 K3 父仅 `runtimeFiles.pluginIndex` 与 `runtimeFiles.pluginHttpRoutes` 两项变化，没有手拼摘要。最终代码确定后仍需完整 provenance 测试及零差异复算。
- 核心两个真实 unit 文件：facade 79/79、source-validation-revision 38/38，合计 117/117、零 pending。为核实非零执行，第二次使用 JSON reporter 读取精确计数；首次仅 exit 0，不用于虚构计数。
- PLM 读计划九入口：bootstrap 1/1、catalog 79/79、management 29/29、store 12/12、validation-ledger 33/33、validation-read 75/75、validation-runtime 11/11 通过。execution-identity 8/9、runtime 27/32；失败阻于 main 新增的项目写锁，尚未达到旧断言期望分支，正在适配真实测试 harness，不删除生产门。
- BOM expansion、read-concurrency、demand-evidence、project-write-guard-apply 整文件通过。active-state 仅 10/110，主要旧夹具没有 generation binder / lease / fence；artifact-version 同类适配尚待完成。
- 旧 demand-evidence golden 九组失败已独立定位到 large lane 新增 `stock-preparation-bom.v3` 身份链（不是 v4）。旧 GOLDEN 字面量保持，按只读 Astra ultra 结论补历史格式投影与未经投影的 capture off/on/throwing 相等断言、真实 v3 revision/source link 断言；未重打 golden 以掩盖行为差异。
- 独立 Astra ultra 窄核：自动合并的 table-actions 与 index 保留 generation binder、lease、原子 consume、host fence、来源内容摘要以及 readPlan 接线；未发现这两个文件的新生产断线。路由冲突解决后复核 B2a authorization/adapter reload 仍在主线 lease 内，W-5 授权参数未丢。
- 本地验证脚手架以既有 owned-PG helper 在 WSL 新建、独占 PostgreSQL 14，Windows Vitest 只获得这一个临时连接。首次 lock-protocol 文件报告 56 个测试通过但进程 exit 1，整体判失败，未称验收完成；owned PG 停止及残留 0 已验证。正在补充未处理错误分类，真实宿主整文件验证仍在运行。
- 在冲突未全解决时误启动的三份 catalog/store/ledger 命令均因依赖 BOM 冲突标记而退出，不能算产品回归或通过；冲突解决后九入口结果以上文为准。

### PLM 后续实测（替代上段进行中计数，保留失败历史）

- 在 fixture 保留生产 generation binder 并补装现有 100 迁移后：真实宿主整文件 **23/23、零跳过、exit 0**，包含实际 JWT/HTTP、真实浏览器 panel、校验与批准激活、两个 owner 的物理字段布局复用；该复用是在同一宿主/PG 内顺序重新激活插件，不是两台独立机器冷部署。
- 独占 PG 14 的 lock-protocol 再验 **56/56、exit 0**。两次正式本地宿主/锁协议成功结果均随后确认 owned PG 实际停止、残留 0；未借业务通过代替清理。此前 56 个断言通过而 exit 1 的首次结果仍保留，未据重跑宣称其历史退出根因已修。
- facade/revision 117、PLM 前端 6 文件 **514/514**、`vue-tsc -b --force` 零错误通过。active-state **110/110**、artifact-version **106/106**、execution identity **9/9**、read-plan runtime **32/32** 已通过。
- active-state 的无效输入不再用内部工厂伪造 token。先从真实有效 dry-run 取得带写绑定的 token，再变更源；失效 dry-run 使用独立空 store，仍断言不签发 token。Codex 复核修正精确 apply 预期为 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`：当前 apply 先比较重算 revision，再检查 canApply。无效 expansion / planner、零写及原行不变断言全部保留，不声称此路径越过 revision 检查抵达 NOT_APPLYABLE 分支。
- read-plan 两个复合变异原只断言 409，被 main 写代际拒绝掩护。现明确要求 healthy 的 `READ_PLAN_ACTIVATION_DISABLED` / `READ_PLAN_GENERATION_CONFLICT`，mutant 的 `STOCK_PREP_PROJECT_PLAN_SUPERSEDED` 不再假冒同一守卫。此证据是 readPlan 拒绝位置/错误归属，不是单一删除后可写的可利用性证明。
- demand-evidence golden 在保留全部旧字面量情况下先 121/121。Astra ultra 随后通过纯内存反例找到四个嵌套 revision 别名可被投影吞掉；实际 Claude Sonnet medium 补四个投影前相等断言及表驱动降级负校准后为 **124/124**。逐个删除四条新断言，每个都使三个真实场景的该校准失败。
- 真实生产模块内存变异：剥 artifact/plan hash 的版本输入、破坏 source link、改实际根数量、改实际 plan 计数均被整文件拒绝；source link 可被更早的生产完整性门拒绝，不冒称新断言的独立击杀。另将未知 active 状态视为 true 的真实变异致红。首次五个异步 mutation harness 过早检查加载次数，属于工具夹具失败，改为 exit 时确认实际模块恰好加载一次后，才记录有效变异结果。
- 扩大到 135 个既有相关 CJS 入口，Windows 首轮 **130/135**。其中 department 套件仅因 Python 入口失败，原文件在 WSL 完整通过；permission matrix 是工作副本迁移文件 CRLF 的多行文本断言，按索引原字节生成 LF 副本后完整通过。另三份旧用例的空 readPlan ledger / 精确变异目标 / continuation 版本摘要适配正在处理，未声称 135 全绿。
- 两个 shell 工作副本的 checkout-index 仍保留 CRLF。改用 `apply_patch` 写入与索引内容完全一致的 LF（先逐字校验只差行尾），required-wiring **65/65**。完整 provenance 测试通过，模块重算与当前向量 **零差异**。没有修改仓库行尾规则或全局配置。

## 5. CI 事实与验收边界

只读核对旧 main `714c910` 的 Plugin run `40044976618`：attempt 1 已取消，不能称整轮全绿。其正式 owner YiDa JWT HTTP/browser 步骤和随后 BPMN 步骤均为 success，但晚期整轮覆盖不闭合；这不替代新本地 K3/PLM 组合的验证。

初次检查点只能报告 K3 进展；PLM 本轮本地结果随后闭合，见 §0/§6。真实系统验收、发送及客户交付并未因此获准。#6337 未恢复，未重复启动已完成的 Chrome 宜搭试用。

## 6. 最终收口与证据边界

最终 WSL 回归报告为 `tmp/sa02-plugin-regression-linux-20261024.json`，135/135；其中 results 内容摘要为 `55798ab1b4f52853008c8d24f98b30daaa78bfbb04cf0dc34eabb3d95d7d35c3`。Windows 首轮 130/135 的原报告留在 `tmp/sa02-plugin-regression-20261024.json`，没有覆盖。

扩大回归找到的另三处已修：duplicate-hold-gate 明确空 ledger；C-13 只在真实 execution lookup 的参数范围内定位和变异 project 字段，不误命中 pilot 输入；continuation golden 复用真实 v3 生产链和旧格式投影，原字面量全部保留，真实 off/on 观测仍全量比较。为该投影补的是内存中的真实 metadata-only checkpoint approval，没有执行大车道写入。Codex 另外校正 SCC_CAPTURE 语义：它继续输出真实生产观测，不能把历史投影冒充新捕获；修前捕获错误等于旧 revision，修后输出真实 v3 revision，常规 13/13 保持通过。

模型分工采用实际 Claude Code 调用：Sonnet high 处理 K3 守卫、夹具与类型/作用域断言，Sonnet medium 处理窄负例和四个别名校准；Opus high 处理跨文件冲突和版本摘要兼容性；Codex 独立应用、审阅、执行及校正，Astra ultra 只读复核。多数调用返回 `claude-sonnet-5-5` / `claude-opus-5-5`；最后一批 CLI usage 同时报告 `claude-sonnet-5-5` 与 `claude-fable-5-1`，不据此推断后者的内部用途或 effort。本轮没有调用或冒称验证 Grok/Kimi。

本地结果覆盖的是合成 SQL 数据、假 K3 fetch 与真实本机宿主/浏览器。没有客户 SQL Server/K3/宜搭实服务读写，没有真实 token 交换，也不代表已验证客户数据库账号的实际权限。生产守卫未放宽；旧夹具按真实 generation/lease/fence/原子消费接线，测试差异有精确错误码及变异校准支撑。

本轮后续阶段是审阅本地提交；推送现有 PR、运行新 CI、合并、部署及真实客户窗口分别按后续授权执行。main 基线固定为本轮的 `771170234`，不声明在 main 继续前进后仍天然可合并。完整自助集成总目标没有被缩小成此次两支的本地验收。

## 7. 外部审查的独立复核与裁决（2026-10-24）

固定审查对象为 PLM `7e3d6241ea18572ec705960cb7cf8fce40bf2577`、K3 `b92cbd908d31cbad95f30d4cc45ebc370b323533`；外部材料为用户指定的 `review-6323-6324/judge-readable.txt`。本节是对代码、既有本地证据和合成反例的复核，不是修复完成报告。本轮只修改此 MD，未修改生产或测试文件、Git refs，也未运行新 CI 或真实数据库。三个窄范围只读复核与主审并行进行，不重复全仓审查。

### 7.1 当前必须先处理的事项

1. **P2 / FP-7，在线配置丢失部署语义：确认。** `plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:579` 整体替换 readPlan，而 `stock-preparation-read-plan-config.cjs:74` 不允许 `projectSubtree` / `batchIdentity`。独立重跑真实 ledger → registry → composition → expansion → planner 的纯内存链：无订单合成项目由 2 行变 0 行，仍 `valid:true`，既有 2 行被规划为 inactive；混合来源只丢子树部分。未执行 HTTP apply，不能称已发生真实业务写入。batchIdentity 的独立模块对照也确认：缺块后默认为 source_revision，同小时内容更正被分为不同批次，且没有降级提示；未证明覆盖或删除旧批次。
   - 最小可靠强制点是 composition：基于其已取得的真实部署 action，拒绝 SA02 无法表达的已声明块，先于读取、token 发放及写入。activation 当前没有部署 action 依赖（management `:83` / `:211`，index `:350`），提前拒绝激活需注入可信的配置检查器；不能仅在 activation 检查在线 config 就宣称兼容性已闭合。不要静默拼接未被校验证据和 execution identity 覆盖的旧块。
2. **P2 / FP-1，项目归属比较放宽：确认。** `stock-preparation-bom-expansion.cjs:1227` 引入的宽松比较影响旧六处根发现边界（`:2399`、`:2569`、`:2642`、`:2889`、`:2914`、`:2966`）。真实 dry-run + bridge adapter 合成探针中，大小写相近的两个项目形成 2 个 root、6 次另一项目读取，并得到可应用 token；数字等值项目在允许的 whole-table 回答下同样混入。应仅恢复这六处的精确归属比较，保留 readPages 及新五处重查的 SQL 等值语义；全局改回 matchesByField 会破坏既有 R67 关联读取合同。不需要读取客户数据才能恢复冻结 main 已有的精确边界。
3. **正式测试链阻断：确认。** 本头登记 299 个入口，宜搭 store 位于第 250 项。主审独立执行完整 `yida-delivery-store.test.cjs` 为 16/17、exit 1；仅在内存移除 workflow 中新增的 PLM host 文件后为 17/17。根因是该测试 `:28–33` 的完整文件清单未同步 `.github/workflows/plugin-tests.yml:1460`。正确修法是补齐精确清单及缺失/过滤负例，保留真实 PLM host 步骤；删除 workflow 测试不是修复。测试工作副本与 Git 对象只差 CRLF，workflow 与对象字节一致。完整链 298/299 是外部复核执行结果；本轮主审独立复现了其中唯一已报告失败，没有冒称又跑一遍全链。
4. **P3 / FP-6，未知数字 active 状态静默变 inactive：确认，建议本轮修完。** `stock-preparation-bom-expansion.cjs:1267` 将所有非 1 有限数字判 inactive。独立真实 dry-run 中，2、−1 均得到 ready/token，且 inactive 2、errors 空。更正外部报告：不只是“没测到”，active fixture `:290–291` 已把 2/−1 当作 inactive 正向验证，必须纠正测试语义。仅 0/1 为已知数字，其它数字按既有 UNKNOWN 错误拒绝；保留字符串及缺失状态的 fail-closed。客户值域没有核实，不能声称已发生客户损失。
5. **P2 / K3-F1，数值修复遗漏 composition handoff：确认，为历史缺口。** `read-source-composition-planner.cjs:217` 用无 BL2 身份的临时 plan 先转字符串；下一跳 `read-source-probe-runtime.cjs:117` 已看不到原始不安全 number。独立真实纯函数对照确认三个不同不安全数值的 handoff 被接受。应在 String 前拒绝绝对值超过 MAX_SAFE_INTEGER 的 number，使用现有 handoff invalid 错误；保留非 BL2 合法小数和精确字符串。不要统一用 !Number.isSafeInteger。该路径在 main 已存在，尚无真实 K3 int ID 触发证据。composition handler 预先加载两跳凭据，最小补丁只能证明不执行第二跳 adapter/fetch，不能承诺整链零凭据读取。

### 7.2 其余发现的裁决及最小处理

| 发现 | 裁决与处理 |
| --- | --- |
| FP-2 / pilot readiness | P3，元数据 plan 与实际执行 plan 不一致属实。当前 continuation support 为 0，受支持 enable 路径被 NOT_READY 拒绝；不能升级为已证明可启用 pilot 的漏洞，也不能推断库中绝无旧标记。让 readiness 解析真实执行 action；以后解封 continuation 前须处理启用后切换配置的复检。**specField 是 SA02 的可选字段**，不是 schema 无法表达的块。 |
| FP-3 / apply 拒绝记录 | P3，确认。`http-routes.cjs:8200` 在租户墙 `:8203` 与 try `:8216` 之前，拒绝不会进入 `:8291` 的记录逻辑。将该只读 token 检查放到租户墙之后、受 catch 覆盖的位置，保留在凭据/claim/consume 前；不能因此把跨租户拒绝写入别人的记录。未发现守卫绕过。 |
| FP-4 / 预览错误分类 | P3，确认。`projectSync.ts:1022` 漏传 projectSheet/detailReason，panel `:798–815` 漏掉既有锁/pilot 五类文字。复用 sync 上下文与原因映射，补五类 UI 断言；不自动转大车道或重试。 |
| FP-5 / 仅预览的代际副作用 | P3，确认。panel `:861` 的 strictPreview 仍走同步 dry-run，`http-routes.cjs:7751` 对可应用调用者绑定新 generation，可能使旧 token / checkpoint 过期。最窄修法是明确“生成新计划会使此前计划失效”的文案与测试；不要为文案问题全局去掉 main 的 binder。若改为真正无代际副作用的读预览，须明确独立的服务端语义，不能只改客户端标志。 |
| find-tests-2 / active apply 分支 | P3，局部覆盖缺口成立。当前真实旧 token 正确命中 TOKEN_MISMATCH，没有覆盖后续 NOT_APPLYABLE；现有 table-actions 整文件仍覆盖后者。保留真实旧 token 测试，并追加带当前 write binding 的对抗 token 负例，明确它是防御性伪造场景，验证 canApply 门与零写，不把它称为正常可签发 token。 |
| find-tests-1 / v3 golden | P3，部分成立。独立篡改 capture 的 applyJob.planRevision，当前 golden 校验/观测/投影均不变，需补它与 planned.planRevision 的相等断言及负校准。新增断言后应同步校准副本的 reseal 引用，避免其它变异被夹具失配提前拦住。v3 无 literal 是可增强项；生产单改会红，生产与共享 recipe 同改也被另一独立 inline recipe 拦住，不能称当前全链无覆盖。可加少量独立 v3 literal，保留原 GOLDEN。 |
| find-tests-3 / 原始 lookup 扫描 | P3，确认。call-site guard `:81` / `:283` 没识别 getTableActionForExecution。主审内存注入无 projectNo 的该调用仍 18/18；换成 getTableAction 则 C-01 红。补两处扫描及变异校准。当前生产唯一调用在受控 helper，尚无现行绕过证据。 |
| K3-F2 / key_required | P3，一致性问题成立，非当前安全阻断。无效数值用 key_invalid 更准确；reason 实际是经校验的字符串，不是闭合枚举。将非法字符串也提前改成 400 会改变原有 evidence-failure API 行为，不能顺手算作无行为变化，亦非 F1 修复必要条件。 |
| K3-F3 / 零 fetch 断言 | P3，runtime 那条未接入 deps 的零 calls 为空断言，重复大数应替换。但“guard 移到 execute 仍绿”不成立：同步 assert.throws 会红；真实 HTTP 测试 `:895–898` 已断言凭据/adapter/fetch 均零。补实际链与错误 reason，不能否定已存在的前置 IO 证据。 |
| FP-8 / 迁移注释 | P3，确认，`external-systems.cjs:109` 的 087 应为 089；仅订正注释。 |

### 7.3 证据范围的更正

- 原 135/135 **没有被推翻**：主审重新读取原 results，135 个 passed/exit0，摘要仍为 `55798ab1b4f52853008c8d24f98b30daaa78bfbb04cf0dc34eabb3d95d7d35c3`。筛选规则为顶层 `.test.cjs` 且前缀匹配 `^(stock-preparation-|b2a-trial-|data-source-sql-readonly-|external-systems-|integration-g4-m2-)`，不含 yida-delivery-store。Windows 原报告仍为 130/135。报告位于 ignored tmp，外部 Git clone 不包含它，所以该审阅方当时无法直接复跑同一子集。错误在于我用子集通过作总体收尾结论，现已撤回。
- 外部 host 首轮 4/23 失败、第二个新库 23/23，通过不能抹去首次 locator 超时。它不反证此前本地一次 23/23 的事实，但增加了稳定性风险；本轮未重跑真实 PG/浏览器，也未证明其是已知偶发问题。修复后的最终验收应保留两次记录，定位首个超时及其余是否级联，不提高原预算或以重跑代替原因。
- 外部未重跑的 Vite / Docker context guard / 两个专项类型目标 / 历史变异与 owned-PG 清理，仍标为此前本地证据，不冒称本轮被独立再现。外部 K3 全链 287/287 属它在 b92 的执行证据；本轮没有替代或触发远端 CI。
- 本轮冻结检出原有两个仅行尾状态的改动和未跟踪 review 产物保持原状。没有读取 .env、客户凭据或客户数据，也没有执行真实发送。

### 7.4 最小收尾路径

先修 PLM 丢块、六处项目边界及数字 UNKNOWN；并行补 K3 handoff。再合并同范围的精确清单、审计/预览与定向测试修正，不扩展 pilot 或新接口。按既有分层普通追加准备本地补丁；重算实际受影响 pin 后跑完整既有插件链、对应类型与前端测试、必要的真实合成宿主验证。当前结论为 **需修复，暂不具备本轮验收条件**；#6337 继续封存。所有发布和真实系统操作仍未获本轮授权。

## 8. 用户限定的三项本地修复（2026-10-24）

本节范围以用户最新指示为准：仅宜搭 lane 清单、FP-7 和 K3-F1。仍只在既有 #6323 / #6324 的本地工作树修改，未新增切片、提交、推送或 CI；#6337 保持封存。以下行号指本轮未提交补丁，基线仍为 §7 的两个冻结 commit，不冒充基线已有代码。

### 8.1 最小实现与行为变化

- **宜搭清单**：`plugins/plugin-integration-core/__tests__/yida-delivery-store.test.cjs:28` 将实际已在 workflow 执行的 PLM host 文件纳入完整且有序的允许清单。没有删除 workflow 的 host 步骤，也没有放松重复文件、测试过滤参数或泳道约束。
- **FP-7**：`stock-preparation-read-plan-execution.cjs:71/125` 在整体替换部署 readPlan 前，拒绝在线 v1 无法表达的显式 `projectSubtree` / `batchIdentity`，返回固定 `READ_PLAN_DEPLOYMENT_INCOMPATIBLE`（409）。已有 active pointer 同样经过这个检查，先于来源 adapter、读取和 token 写入；没有在线 pointer 的原部署读取继续执行子树。
  - `stock-preparation-read-plan-management.cjs:142/237` 在现有身份、owner、版本作用域及 generation 检查后、pointer/audit 修改前检查真实部署 action。缺失或故障的配置 resolver、缺失/非对象 readPlan 返回固定 `READ_PLAN_DEPLOYMENT_UNAVAILABLE`（501）。拒绝时不改变 pointer、generation 或审计。
  - `index.cjs:355–368` 从与 routes 相同的两个服务端配置入口构建独立、不可变的部署 registry，私有 resolver 只读该 registry；不带 binding/project resolver，不从请求注入，也不要求部署 systemId 与合法重绑定后的 systemId 相等。
  - 前端仅登记上述两对精确状态/错误码，显示固定中英文说明，提示联系管理员；不自动重试、不外显对象、字段或来源配置。
  - **这是拒绝静默降级，不是新增子树在线配置能力。** 含这些部署块时暂不可激活在线版本；不拼入未经在线校验证据和 execution identity 覆盖的旧块。其余预算、安全守卫、schema、端点和默认开关不变。
- **K3-F1**：`read-source-composition-planner.cjs:223` 在 String 转换前拒绝绝对值大于 `Number.MAX_SAFE_INTEGER` 的 number，沿用 `READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID`。安全数字、非 BL2 的合法有限小数和精确长数字字符串保持原行为。真实注册 handler → composition → 两个真实 K3 adapter 的用例证明：不安全值只运行第一跳，第二跳 adapter/fetch 不执行。路由仍预先载入两份来源系统材料，不能称整链零凭据读取。
  - 同一最小补丁已精确移入父 K3 工作树的三个文件，没有覆盖父层整份 HTTP 测试或修改其余层。父 HEAD 仍 `b92cbd908`，子 HEAD 仍 `7e3d6241e`。

### 8.2 本地验证与反例

| 验证 | 本轮结果 |
| --- | --- |
| 宜搭清单整文件 | 17/17；内存删 host、重复 host、加过滤参数三种变异均被精确清单断言拒绝 |
| FP-7 管理 / bootstrap / runtime | 34 + 3 + 34 = 71/71；这里是 PLM CJS 测试数，不是宜搭 owner 71 项合同 |
| FP-7 激活守卫变异 | 独立删除调用后，真实 handler + ledger 的拒绝用例报 Missing expected rejection；不是靠旁支错误码兜底 |
| FP-7 运行守卫变异 | 独立删除调用后，已激活旧指针的真实 dry-run 从期望 409 变 200，原零 adapter/读取/token 断言保留 |
| K3 子层 / 父层 | 各 5 个完整 CJS 文件 exit 0；删除唯一数值守卫后，planner 与完整 HTTP routes 各因目标反例失败；7 个验证进程网络探针均 0 |
| FP-7 页面 | 两个既有完整 spec 164/164；删除错误白名单、去掉 status 限制、删除不可用提示分支，三种内存变异均红 |
| 前端主类型目标 | `vue-tsc -b --force` exit 0，0 TypeScript error |
| 真实宿主 / 合成数据库 | 原 host 整文件 23/23，0 skipped；真实 owned PG 停止与移除成功，未延长原测试预算 |
| 完整插件链 | 独立 Linux LF 副本执行原 `node scripts/test-chain.cjs`：299/299，exit 0，原 fail-fast，无删项；运行后树与补丁哈希复核通过 |
| provenance | 模块实际重算只改变 `runtimeFiles.pluginIndex`；完整 pin set 逐项相等；完整链中原 `sealed-export-package-provenance.test.cjs` 明确输出 OK |

FP-7 新增合成用例使用真实管理 handler/store 与真实 registry；启动用例的 spy 只记录参数并透传真实 factory，证明两个配置入口和不可变副本接线。运行负例走真实 ledger、注册路由和组合器；无 active 的正控还明确看到真实子树读取，而不只是创建了 adapter。父 K3 本轮只重跑五个完整文件与变异，未另称重跑父官方 287 套链。

证据位置均为本地、不含客户材料：`tmp/three-review-fixes-20261024/fp7-results.json`、同目录逐文件/变异日志及类型日志；K3 两个工作树各有 `artifacts/k3-f1-verification-20261024/summary.json`。子 K3 汇总 SHA256 为 `9f6dc4915349a5e2959a2299c1f6c2aa6b6e7399416f5d3c902572d55c525b29`，父为 `4f88b8296b64da3b8a45dc5819621e20fbd1daf39dcb285c4a5b347fa480a5fb`。这两份证据生成后仅校正测试注释中的 hop 1 → hop 2，不改变可执行逻辑或断言；最终子链包含该注释订正。

最终代码清单为本地 `tmp/three-review-fixes-20261024/final-code-manifest.json`，14 个文件按 LF 归一化后的条目摘要 `570181cd7a544a87739332dd1099c2cc05cf54a91b497abe7d2b12bf44285842`。验证副本 `/home/runner/metasheet-three-fixes-20261024-a73f` 使用冻结 HEAD 的 14123 个显式 checkout 路径（排除真实 backend `.env`），叠加这 14 份相同补丁，复用 lock blob 相同的已装 Linux 依赖。原工作树和用户的旧审查 clone 均未被重置；临时 Linux 副本另对 3 个 HEAD 自带 CRLF 文本仅作 LF 行尾归一化，不计为产品修复。

完整链原始 stdout/stderr、结果摘要、精确树清单和仅含 14 份代码改动的 patch 已保存在 `tmp/three-review-fixes-linux-20261024/`。主审重新核对首尾 299 标记、退出码、失败名为空、provenance 通过行和以下日志哈希；未只采纳代理的一句“全绿”。patch SHA256 为 `492e382afed02935c93a248545a0892660dc1f8af49c3ef3dcc04615ddbc993d`，stdout 为 `1f35596012af0f6d4d5a79ab57333ed06822ee90eaac1053aa116ed0f0f1c2b0`，stderr 为 `73edaa5c9400d773fdf417104f815e0dd1066b9facdd9cfe51bf60ebefbf2864`，Linux tree manifest 为 `0169ea69ac721885ee2565e37e9a16b43450fe06254133a8fcaf38c328e9506c`。stderr 非空不等于失败；正式 runner exit 0，原完整链全部执行。

真实 host 23/23 的输出摘要为 `2a24af610f5ff3658261910c804ac74dd359bf6e78c3b761b0ce62fe5d4fa4d4`；清理结果为 exit 0、stopped true、stoppingFailed false。测试前将已有 backend `.env` 仅作不透明临时移位，未读取其内容，结束后已原样移回；子进程只使用本次自产的合成数据库。此成功不抹去 §7.3 外部宿主首次超时记录，也不证明所有历史时序问题已解决。

### 8.3 独立复核、失败记录与剩余边界

实际 Claude Code 实现：Sonnet medium 处理清单与 UI，Sonnet high 处理 K3，Opus high 处理 FP-7 跨文件接线；Codex 独立审阅、应用、补齐规范夹具/权限顺序/子树正控并执行反例。FP-7 请求 opus/high，CLI usage 返回 `claude-opus-5-5` 与 `claude-fable-5-1`，不推断后者内部用途。另一个只读复核检查了部署 registry、激活与运行两条门及错误映射，未发现新增阻断。没有调用或冒称调用 Grok/Kimi。

保留本轮真实失败：两个 Sonnet 首次调用因继承失效代理而失败、模型 token 为 0；仅对子进程移除代理环境后成功，未改全局代理。Codex 新增权限顺序反例起初期待了错误的拒绝码，实际先命中既有 `TENANT_CLAIM_REQUIRED`；校正测试期待后通过，没有放宽生产门。首轮 WSL 官方插件链在第三套 host-loader 因 Windows esbuild 平台不匹配停止，日志及 SHA `ebbf32d4423535f868babf11b67ee69fa34289d59ffa83e902bc62f7e8fa43ea` 保留；重新准备 Linux 依赖与 LF 副本不构成源代码修复，也不能把首次链报告成通过。

本轮限定三项已完成本地修复和验证，可交回复审。FP-1 六处项目边界、FP-6 未知 active 数值以及 §7.2 其它审计/预览/测试问题，本轮未修改。三项修复通过仍不等于两支 PR 已可总体验收或发布；#6337、真实发送、客户读取及部署边界保持不变。

## 9. 后续授权：FP-1 / FP-6 本地最小修复（2026-10-24）

本节记录 §8 之后另获授权的两项修复。PLM HEAD 仍为 `7e3d6241ea18572ec705960cb7cf8fce40bf2577`，K3 HEAD 仍为 `b92cbd908d31cbad95f30d4cc45ebc370b323533`。本轮新增差异只有一个生产模块和三个既有测试文件，不改 schema、接口、全局默认、超时预算或发送开关；未提交、推送或运行新 CI。#6337 未恢复。

### 9.1 实现边界

- **FP-1**：`stock-preparation-bom-expansion.cjs:1236` 新增内部 `matchesByExactField`，按冻结 main 的原语义比较 `toKey(readField(...))`。六处原有归属判断改用它：子件预读 `:2414`、项目入口 `:2584`、部件查找 `:2657`、子树 BOM 所属目录 `:2904`、子目录父节点 `:2929`、订单路径身份 `:2981`。数字 `100`、字符串 `'100'` 和首尾空格继续兼容；大小写不同的标识及 `'10'` / `'0010'` 不再被当成同一项目、目录或部件。字段名称的大小写别名识别不变。
- 五处新增 SQL 等值重查仍使用 `matchesByField`：BOM parent/version、detail parent、order path/owner；`readPages`、分页与 `sameFilterValue` 未修改。两条新增正控同时穿过这五处，明确保留大小写及数字形式的合法 SQL 等值读取。
- **FP-6**：同模块 `:1265` 的 active 状态解析仅接受数字 `0/1`。其它有限数、分数、NaN、正负 Infinity 均进入既有 `BOM_HEAD_ACTIVE_VALUE_INVALID` 拒绝；null、布尔、字符串白名单和未声明 active role 的行为不变。修前 `2/-1` 的真实反例是后代消失但 `canApply=true` 且签发 token；修后得到全局 `read_failed`，不生成可应用预览。
- 两项均是 PLM 净增合同的修复。冻结 K3 父层没有 FP-1 的六处放宽或 FP-6 的该数值分支，因此未机械复制到 #6323；其前轮 K3-F1 三文件补丁保留。

本节行号指当前未提交补丁，不能当成冻结 HEAD 已有实现。

### 9.2 真实路径与独立变异

| 验证 | 结果与范围 |
| --- | --- |
| FP-1 membership 整文件 | 原 71 条完整保留，现 **120/120**，0 skipped/cancelled |
| FP-1 修前对照 | 同一新增测试在内存加载冻结 HEAD 的原模块：88/120，32 条失败；没有改写磁盘生产源 |
| FP-1 六个单点变异 | 分别只把一个精确调用改回 SQL 等值调用；预读 / 入口 / 部件 / 子树 BOM / 子目录 / 路径分别致红 4 / 14 / 12 / 2 / 2 / 2 条，6/6 被拒绝 |
| FP-6 active 整文件 | **155/155**；原 root/recursive/subtree、两套字段布局及合法状态正控保留 |
| FP-6 相关完整回归 | active、BOM expansion、read-concurrency、project-subtree、table-actions 五个整文件 exit 0 |
| FP-6 并发对照 | 独立串行与 `readConcurrency=4` 共 **18/18**，其中并发 9 条；均检查具名原因及全局拒绝 |
| FP-6 两类变异 | 恢复旧“有限数非 1 即 inactive”、改成“非 0 即 active”；分别被完整 active/HTTP 套件与只运行并发 4 的独立探针拒绝，4/4 |
| 本轮完整插件链 | 独立 Linux native/LF 副本执行原 fail-fast runner：**299/299、exit 0**；失败名为空，日志含本轮 membership 120/120、active 155/155 及完整 package provenance OK |
| provenance | 实际模块递归重算零差异；本轮四路径没有引起新 pin 改动，保留 §8 的 pluginIndex pin |

FP-1 的六处夹具每次只构造一个 SQL 等值但身份不同的列，并断言该读取确实返回别名。预读额外加入“只有别名、没有真实部件”的负例：最终部件检查仍可能挡住业务行，故直接检查实际 adapter 调用，禁止对别名部件发起 BOM-head 读取，不能仅凭最终行数证明。

另有真实 `dryRunStockPreparationAction` + 真实 write-lock harness + 真实 Bridge adapter + 注入合成 fetch 的闭环，覆盖两类项目标识、普通/总图根选择、明确 filtered/整表/省略 `filtersApplied` 三种传输。断言只读取本项目后继、预览计数为两行、只签发一个 token、目标业务零写；不是注册 HTTP 路由、JWT middleware 或物理数据库的证明。Bridge 本来就把省略标志视为 false，测试按真实合同处理；public dry-run 本来只返回脱敏计数证据，不伪造原始 rows 响应。

FP-6 另走真实注册 dry-run/apply handler，只有来源行和持久化底座为内存合成对象。负例先取得真实有效 token，再改变源状态，确认读取到 BOM 后拒绝新 token，旧 token 的 apply 命中精确 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`，目标业务零写；冷启动负例确认从未签发 token。合法状态正控实际完成模拟 apply。**零业务写不等于零副作用**：旧 token 会按现有合同先 consume，再比较 revision；没有把该路径称为后续 canApply 守卫的独立覆盖。

FP-1 的 8 个验证进程、FP-6 的 10 个验证进程均检查 Node 网络调用为零。实际客户 SQL/K3/宜搭、真实 token 和发送均未接触。

### 9.3 证据来源与失败保留

实际 Claude Code 两次使用 `claude-sonnet-5-5` / high，仅返回限定 patch，无工具、浏览器或仓库写权限；Codex 应用、独立执行与校正测试。FP-1 调用约 371 秒，FP-6 约 107 秒。没有冒称调用 Grok/Kimi；这两项窄修复没有追加 Astra ultra 调用。独立只读复核确认 FP-6 数值边界与注册路由路径；FP-1 最终窄审也未发现新增阻断，逐个确认六个 mutant 只改对应调用，预读四个失败命中实际预读断言，原五处 SQL 兼容逻辑保持不变。

- FP-1：`tmp/fp1-fp6-local-20261024/round3/summary.json`，SHA256 `5c724468618009bc03ebe6ac082f1bbb7575ae33851dd754f3c89c57ddbca860`。Claude 返回文件 SHA256 `d0db12559ce702601d169dbb45bfa979e0d30b4c6f6e591e8e6018103f799dc0`。健康整文件 stdout SHA256 `667ca45ca11f4a34c8718f17bede313def995ac9f23dde2101686a77871b11b9`。
- FP-6：`tmp/fp1-fp6-local-20261024/fp6/checks3/summary.json`，SHA256 `29ab8359090a9a97124ff641f828d68f64b584686adb8c29f41c2f7899e5d91c`；修前反例在同目录上层 `baseline.json`。实际 Claude 返回 SHA256 `c265500d95644554a2356187d5a8c2f818363b4af43c662c9687ee8487b409e5`。
- 保留 FP-1 round1/round2：原提案错误假设 dry-run 暴露原始 rows、Bridge 缺省标志代表 filtered，随后主审第一次用了不存在的 `counts.create` 字段；均按实际代码改为计数证据、缺省 false 和 `counts.add`，没有修改生产 API 迁就测试。两轮各 12 条夹具失败不算通过；原生产补丁未因此放宽。
- 保留 FP-6 首轮相关回归失败：旧 BOM expansion 测试仍将 `2/-1/0.5` 列为 inactive，已移入 invalid；独立并发辅助脚本误把可选预算字段当必有，校正为“存在才比较”，未改生产预算。首轮日志保留，后续成功不抹去原结果。

完整链本轮证据在 `tmp/fp1-fp6-linux-20261024/`，包括真实 exit、stdout/stderr、前后树清单、18 个代码文件冻结清单与本轮 patch。主审重新检查原 runner 的首尾 299 标记、120/120、155/155、package provenance OK 和日志哈希；没有只采纳代理的成功摘要。完整 patch SHA256 为 `7d81f045dac2dd9c4e0d8a6c7a9bec9091462760cdac31f5fa24e9f7f85b6f98`，stdout 为 `7d08627c1663dbcb590e2fd5378e7c191f78638f1974d6004f49187f6c03fe2c`，stderr 为 `73edaa5c9400d773fdf417104f815e0dd1066b9facdd9cfe51bf60ebefbf2864`。运行前后 14123 个安全路径的树摘要均为 `6358a80ecb198423c04783bfd23ce7fdc64f76951807d48f33cc74d7093fd9e4`，无源文件变化；当前 Windows 的 18 个代码文件经 LF 归一后仍与冻结清单相符。验证环境 provenance SHA256 为 `d74f7cea565eab5bfd5c9855188f66f6f253efc830c23957a0491a7aaa9a5942`。

§8 原日志未覆盖；本轮未重复 UI、真实 PG/浏览器宿主或客户验证，不把前轮 23/23 冒充本次执行。当前 backend `.env` 只检查存在性，未读取、移动或复制。两个本地 HEAD 未变，原 K3/FP-7/清单补丁全部保留。

**FP-1 / FP-6 已完成本地修复、真实路径合成和独立变异，可交回复审。** 其余 §7.2 审计/预览/测试事项未包含在本次授权修复内，不把这两项修复称为两支 PR 的全部收尾；发布、真实系统验收及 #6337 仍维持原边界。

## 10. 客户语义补充与前述结论订正（2026-10-24）

用户明确：客户库按不区分大小写规则匹配项目号时，仅大小写不同属于同一项目。因此 §7/§9 的大小写别名反例只能证明旧/新比较行为不同，不能再证明读取了另一个项目；上一轮恢复六处精确比较的代码不能直接作为该客户的最终验收实现。299/299、120/120 等实跑事实保留，但其业务假设需要订正。此轮只核实代码并记录说明，没有继续修改生产/测试、推送或触发 CI。

后续修复应使用已确认的源字段比较语义，区分项目号与目录/部件主外键，不把“数据库不区分大小写”扩展成“任何数字字符串都按数值合并”。项目别名还需落到一致的内部项目身份，避免相同项目因不同输入大小写出现不同登记、预览或幂等身份。不能只改入口的一次比较、或全局将所有标识转小写后宣称完成；本轮未读取客户库，也未声称已自动识别有效列排序规则。

字段名和状态值是两件事：`PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomHead.activeField` 默认 `bom_able`（`stock-preparation-bom-expansion.cjs:520`），但 `stock-preparation-read-plan-config.cjs:16/83–89` 允许将该角色映射到其它合法字段名；不要求客户改库。当前 `isActiveBomHead` 的状态值解释仍是固定规则，尚无可配置 active/inactive 值集合。未声明 active role 会按不筛状态处理；SQL null 当前按 active 处理。这些是既有兼容行为，不是已确认的客户业务规则，更不能通过删除字段映射来绕过未知值拒绝。

如客户使用其它状态码，应先明确字段与已启用/已停用/空值/未知值的含义，再在既有配置验证链中做显式映射或由受控源投影提供统一状态。未知值继续拒绝，不能一律当成停用而生成缺件计划。是否采用具体映射能力、客户实际值域与空值含义，本次问答未确认；不把设计建议记成已实现功能。

## 11. 来源比较及状态配置：本地实现（2026-10-24）

本节依据用户后续明确授权；独立 GOV-08 决策 [integration-source-value-semantics-design-20261024.md](integration-source-value-semantics-design-20261024.md) 先于代码落地。仍仅本地 #6323/#6324，#6337 封存，无新端点、DDL、提交、推送、CI、合并、部署、客户读取或真实发送。新增 PLM 合同落在 #6324；K3 父层不消费此合同，未机械移植该功能。

### 11.1 实际行为

- 既有来源计划编辑器可选择 `sourceProjectComparison: case-sensitive / case-insensitive`，未选不补键且保留旧精确入口；只改变来源项目入口，另外五处目录/部件精确边界和五处 SQL 等价复核不改。`10` 与 `0010` 仍不同。显式模式只处理文本与安全幅度的有限数字；不声称自动识别客户库规则或模拟所有 SQL collation。
- 状态列继续用 `bomHead.activeField`，`bom_able` 只是默认示例；可选顶层 `bomActiveState` 绑定两个有界、互斥、严格类型的启停值集合。配置映射时缺列、歧义、未知值拒绝，NULL 仅在显式集合里才有含义；未配置保留旧 NULL/无 activeField 行为。前端原始 JSON 无效时预览、保存均被阻止，不保存上一次有效映射。
- 项目请求使用已登记拼写，不自动 alias 路由或全局 lower-case。CI 来源模式在真实执行前验证可信 tenant、精确登记及目标 sheet/object/status，count→get→list→count 校验含 archived 的登记完整性和等价组唯一性；异常/冲突在打开来源、签发 token 前拒绝。不是并发登记的原子唯一约束，不修改登记创建事务。
- source preflight 和大 BOM readiness 是服务器固定的前置豁免；真正 dry-run/apply/start/run/plan/approve/chunk 仍使用当前或已存项目号完整复核。body/query 不能声明豁免。原 snapshot contract 保留。
- 两项策略参加完整配置摘要，变更后需要独立版本与样本确认；真实 token 消费路径拒绝旧配置 token。目录校验仍只枚举七个物理角色，不把值集合当成列。

### 11.2 定向证据

| 验证 | 本轮事实 |
| --- | --- |
| 项目成员整文件 | 132/132，含真实 Bridge + write-lock + dry-run；新规则下大小写路径归入同一来源项目、内部请求拼写保留、总图选择照常、数字文本不折叠 |
| 状态与目录/样本相关回归 | expansion、active-state、catalog、validation-read、concurrency、subtree、table-actions 七整文件 exit 0；原 active 155/155 及新增配置状态 106/106 |
| 版本存储 / 执行身份整文件 | 15/15、12/12；新增三种配置变更的独立版本确认和旧 token 拒绝，fresh token 通过同一模拟写入口 |
| runtime 整文件 | 54/54；真实注册路由 + 实际内存 registry、有效 token 与后续大 BOM 阶段；仅持久化/来源为合成替身，不宣称物理数据库或 JWT middleware 验证 |
| 前端 | 4 整文件 257/257（原 230，新增 27），主 `vue-tsc -b --force` exit 0；导入导出、实际组件保存正负例 |
| 前后端合同一致性 | 独立 38 组 JSON 向量通过：类型、NULL、重复/重叠、上下界、控制字符、空白、缺列及保留字段 |
| K3 父层 | 本轮重新执行 composition-planner / http-routes 两个整入口，exit 0；未改父层代码，不把两个入口说成仅两个业务断言 |

项目三组单点内存变异：忽略选择的 case 模式、规范化丢字段、数字文本折叠，分别导致 9 / 9 / 3 条失败；健康 132/132，每进程实际替换命中 1、网络调用 0。后端另七组变异覆盖入口、状态规范化、未知值降为停用、类型强转和三个状态消费者，各 hits=1/network=0 且目标断言致红。runtime 三组 omission 变异：删实际 guard、强制服务器豁免、不转发 registry，均被真实路由 oracle 拒绝。前端四组定向变异：丢比较字段、去重叠拒绝、允许控制字符、保存绕过原始 JSON 校验，均在预期断言致红；有意使用 test-name 过滤的其它跳过项不计验证通过。

证据位于 `tmp/source-value-semantics-20261024/`：`root-final/summary.json`、`backend-final-summary.json`、`source-mutations/summary.json`、`parity-summary.json`、`web/round3/summary.json`、`web/mutants-final/summary.json`；runtime 整文件记录为 `tmp/fp1-fp6-local-20261024/project-identity-runtime.tap`。

### 11.3 独立校正与边界

实际三个 Claude Code patchgen 请求均为 `claude-sonnet-5-5` / high、工具禁用，Codex 应用并独立审阅、执行；没有把协作子代理冒称 Claude，也未冒称本轮调用 Grok/Kimi。最终边界复核另由一名 Astra ultra 只读代理进行，未发现新增阻断：确认项目号不被改写、完整执行确有登记检查、readiness 后仍用存储项目号重查，三个状态消费点接线。它只读代码，没有运行测试，不把代码路径复核冒充额外实跑。

该复核特别限定三点：count/get/list/count 不构成事务快照或跨登记原子唯一保证；预取的 advisory catch 仍吞掉预取错误，正式 walk 再验状态并全局拒绝，不能称三个入口各自都抛出最终错误；“缺省不改”以本轮开始前已授权的本地 FP-1/FP-6 修复为基线，不能扩大成相对原始 HEAD 所有行为均未变。新增策略没有改变部署全局默认或开关。

保留本轮失败记录：root 最初两版新 Bridge 夹具缺完整 readPlan、随后 sourceKind 与 Bridge 不同；这两次加载/合同失败不算业务反例。修正夹具后旧代码 123/129、6 个 case 配置反例真实失败，旧 120 项仍全过；最终增加三条总图场景后 132/132。Claude 前端提案的跳过负例、Infinity 经 JSON 变 NULL 的假设、保存请求封装和测试时序已按实际路径修正；未降低生产门。后端提案曾误将仍应 SQL 等价的 order-path 当成精确边界，改测试验证真实 pathInfo 身份而未改该生产口。

独立 parity 抓到后端允许纯空白状态字符串而前端拒绝的真实差异，已在后端拒绝 `trim()===''`，但不修改实际存储/比较字节；`" Y "` 是可配置的精确值，不等于 `"Y"`。本轮历史失败均保留，不用后续绿灯覆盖。

预取变异由真实 detail-read 计数断言杀死，最终结果本来就 fail closed。临时验证器最初误期待稍后的另一条断言标签，因此首份 summary 将其列为未确认；保留该失败记录，仅修验证器的命中标签并单跑复验，冻结的生产/测试源未变。最终后端汇总 SHA256：`b7a56323256a63fcd86e84c04d10191ed72cdc3abc600436b7fd169ffcc386ea`。

### 11.4 完整链与最终收口

全部本轮代码冻结后，使用既有独立 Linux native/LF 副本运行原 `node scripts/test-chain.cjs`，**299/299、exit 0**，没有跳过 provenance、删减链或改 fail-fast。主审亲核实际日志中的完整 provenance OK、原 active 155/155、新配置 106/106、membership 132、runtime 54 和末尾 299 成功标记。

- 原始 stdout SHA256：`f51c4a1fc10324019b7e577fb2f1cb308bd07a2f42d621aa3ec25532093aa6d4`；stderr SHA256：`73edaa5c9400d773fdf417104f815e0dd1066b9facdd9cfe51bf60ebefbf2864`。
- `linux-chain-summary.json` SHA256：`062b0887a48c0eb9211013392c61ffe53d4271ac01fc378b5d27493a4447d658`。验证前后 14124 个安全路径内容相同（含本轮新增纯策略模块）；backend `.env` 从未读入或复制。
- 累计本地修复共冻结 29 个代码路径（含之前修复），`frozen-code-manifest.json` 文件 SHA256：`a562a6b120926d4dac76ffbe4cee6bd8800d8ded831c4b576b379a2ae2695500`。Windows 与 Linux 各自再次核对 29 路径均零差异（LF 口径）；原始字节哈希亦保留在 manifest 中。
- 本轮 actual module 重算只新增 `runtimeFiles.pluginHttpRoutes` 变化，为 `ab4a02a79828f7875219bf98f25454a4031dbb890c0f393bc7a5629fc0b4c894`；保留之前 pluginIndex 修复。Windows、Linux 都递归比较 pin 零差异，pin 文件 SHA256 同为 `f041532e9e3a939a3849daedc49bd93b30027d5d22965e0849b7af751db0e978`。
- 主审最终复跑独立 159 项和 38 组 parity 全过；前端最终四整文件 257/257。主类型检查通过仅指 Linux；Windows 300 秒超时及同目标对照见 §12.2。`git diff --check` 通过；两个本地 HEAD 未移动，未改 #6337。

**本次来源比较/状态配置的本地实现、真实路径合成、变异及只读复核已完成，可交回复审。** 不将其扩大为 #6323/#6324 所有历史待办完成；未重复浏览器/物理 PG/客户验证，没有推送、远端 CI、合并、部署或真实发送。实际客户比较规则和值域仍须在另行授权的客户验收中确认；本文不会据合成结果替客户选择值域。

## 12. Owner 授权普通追加发布及最终叠层门禁（2026-10-24）

Owner 此后明确允许将已验证补丁与 MD 普通追加至既有 #6323/#6324、核对叠层和 pin 后运行既有合成 CI。#6337 保持封存，不新增切片、不强推、不合并、不部署、不读取客户数据、不真实发送。前述各轮“未发布”是当时事实，历史失败均保留。

### 12.1 实际叠层与不变性

- 重新取得 main `fdb30a671686db8dbdbdf606f3a6f1b98add9969`；相对前轮锚只新增考勤固定排班与登录目录绑定修复。
- 父层先普通提交 K3-F1，再普通 merge main，代码候选为 `39e73e1ee960c0b294a989a322790428cfa14c43`；子层普通提交累计 29 个代码路径及两份 MD，再继承父层，代码候选为 `097a0169a40cf700db5cd8b8fd5b8b86a3ba79f3`。
- 原 #6323/#6324 头均为对应新候选祖先，main → 父 → 子关系成立；未重新引入已 squash 合入 main 的旧宜搭实现。子层唯一 YiDa 命名净差量是 host 文件清单测试。
- 独立只读复核确认两个 `.sh` 和 `.tokens` 都保留两侧必跑项：父 token 636→637、子639→640，仅继承 main 的新考勤 token。父相对 main 的净差量在 merge 前后不变。
- 子层 29 个代码 Git blob 的原始字节 SHA256 全部等于 §11 冻结 LF 候选哈希；两层实际 provenance 模块递归重算均零差异。验收后的后续提交仅更新 MD，不以文档提交伪装新的代码验证。
- 两个原有仅状态栏显示修改、实际无内容差异的文件及未跟踪 review 产物均未暂存。首次 fetch 遇失效代理失败，后续仅对该 Git 子进程禁用代理取得远端，没有修改全局配置。

### 12.2 最终合并代码树的实跑

从各候选 Git 对象显式选择安全文件再读出，在两个新建 Linux native 副本运行；读取前排除 backend `.env`，未搬移或读取原文件。与前轮一致，仅三个既有 CRLF 文本作 LF 测试准备，原 Git 哈希与副本哈希分列保留；被 pin 文件不在这三项内。复用相同 lock 的已安装 Linux 依赖，未重置原检出或其他审阅 clone。

| 最终候选检查 | 本轮结果 |
| --- | --- |
| 父层完整原 fail-fast 插件链 | **287/287，exit 0** |
| 子层完整原 fail-fast 插件链 | **299/299，exit 0** |
| 完整 exact-byte provenance | 两层均 exit 0，另在完整链再次执行；未在计算 pin 时归一化 |
| 两个既有接线整文件 | 每层 **71/71**，0 failed/cancelled/skipped；不是宜搭浏览器 70/71 项合同 |
| 全安全源树前后比对 | 父 14099、子 14135 路径均相同 |
| 前端合并交互回归 | **8 整文件 / 536 条通过**，含四个 PLM 配置文件及 main 新增考勤、目录和必跑清单形状检查 |

本轮原主类型目标 `vue-tsc -b --force` 在 Windows 300 秒预算到期，exit 为 SIGTERM/ETIMEDOUT，stdout/stderr 均空。无 TS 错误输出不等于类型检查通过；原失败及预算保留，没有延长预算或修改类型目标。随后在上述子层 Linux 副本按同一目标、同一 300 秒预算进行对照，结果另续记。

Linux 对照实际完成：**exit 0、timeout false、0 TypeScript errors**，14135 个安全源码路径前后不变，stdout/stderr 均为空；结果为 `tmp/publication-20261024/linux-types-summary.json`。这证明最终代码组合通过相同主类型目标，不证明 Windows 超时的唯一根因或 Windows 检查已通过。未修改代码、类型目标或预算后重跑取绿。

证据在 `tmp/publication-20261024/`：两份完整安全源 manifest、`k3-summary.json`、`plm-summary.json`、`web/summary.json` 与 `final-publication-proof.json`。父链 stdout SHA256 `1612d59d72b53e4cb93ad1eee51c228ad9c41567027a4b78e22894a61e3532e5`，子链 `f9b7d10ae6bcbf5b0b9529a0c4e61e490774d2a65482f49c83214f33555f46bc`；两者 stderr 均为 `73edaa5c9400d773fdf417104f815e0dd1066b9facdd9cfe51bf60ebefbf2864`。前端 stdout SHA256 `c4b6f61912c7a5b65108b6bc334f84337a7987cd9676a03e7ba7ad7720e6f9da`；stderr 为预期 Vue/jsdom 警告，不能只凭 stderr 非空报失败。

该发布仍是草稿审阅与合成 CI，不宣称客户可直接上线。§7.2 的其余审计/预览/测试增强、真实宿主首次 locator 超时及历史旧租约、WSL 回拨、ABORTED、SQL/版本风险不被本轮绿灯一并关闭。#6324 继续叠在 #6323；它的原 Plugin workflow 需要分支 dispatch，不能把未执行的 main-only Web 流水线或 no-op Guard 当成完整合成验收。

### 12.3 已发布的新 head 与 CI 初始事实（仅本地续记）

2026-10-24 08:16 UTC，只读核对当前 PR 头、base 和全分页同 head checks/runs：

- #6323 已普通追加至 `64f9d2183cfcb5bf0c5072f8179f96deaab22e42`，base main `fdb30a671686db8dbdbdf606f3a6f1b98add9969`；Plugin System Tests run **40077261387** / attempt 1 / `test (20.x)` job **120823206304** 正在运行。25 个 check-run 为 success 16、in_progress 8、skipped 1；Stock-prep Browser Verify run 40077261383 success，不能替代 Plugin 内的实际宿主/宜搭步骤。
- #6324 已普通追加至 `d3930865ea79e05550d1203fbde43dc0495be20a`，base 为上述 #6323 新头。仅一次 dispatch 既有 `plugin-tests.yml`，run **40077303606** / attempt 1 / `test (20.x)` job **120823334617** 已建立、仍 queued。92 个 check-run 为 success 24、in_progress 30、queued 36、cancelled 2；取消记录不算通过，不自动重跑或取消它们。全分页 workflow runs 共 81，未把同名运行折叠成唯一一次结果。
- 两支均保持 OPEN / draft；远端普通更新同时成功，无强推、删除分支、合并或部署。PR 描述已改为当前行为及真实证据边界。#6337 未提交、推送或 dispatch。

本节 CI 状态只在本地续记，**没有再次提交推送以制造新一轮 head/CI**。发布到 PR 的文档及代码截至 §12.2。当前没有 failure/timed_out/action_required/startup_failure 检查，但 queued/in_progress/skipped/cancelled 不算完成；此时不得宣告两支 CI 全绿或总体验收可通过。完整状态留在 `tmp/publication-20261024/latest-ci.json`，后续以相同 head 的实际最终步骤与清理证据为准。

## 13. 第四轮审阅 P2：登记前大小写冲突（本地续修）

冻结审阅基线 `d3930865ea79e05550d1203fbde43dc0495be20a`。主审亲读真实 create 路由和 store：路由按精确项目号查登记，未命中则先 provision 与安装字段包，再调用持租户 advisory lock 的 store.create；store 只检查容量并插入，没有大小写等价检查。执行期 runtime 虽拒绝含归档行的大小写歧义，但不能阻止第二张表先产生。P2 成立，上轮有限复核确有漏项；299/299 或变异通过不证明未被用例覆盖的入口安全。

### 13.1 决策与权限

先更新已有 GOV-08 说明，再局部修复：拒绝大小写变体，保留原拼写，不自动路由。比较模式从有效在线/部署计划读取，在租户登记锁内重新解析与检查，检查通过之后才允许建表并登记；归档行仍占用项目身份。没有改全局默认、客户部署设置、项目以外的标识规则或状态未知值的拒绝策略；没有自动修复历史重复行。

上轮追加推送 #6323/#6324 与既有 CI 的授权来自 Owner 的直接消息，并已在 §12 执行；本轮新补丁先局限于 #6324 本地，不把上一轮授权扩展成新一轮发布。#6323 不引入无关 PLM 新合同，#6337 仍封存。无推送、CI 重跑、合并、部署、客户读取或真实发送。

类型结果以 §12.2 为准：Linux 同目标通过，Windows 300 秒超时没有关闭。§11 的 38 组 parity 是未入 Git 的本地补充证据，不当作已接入必跑链的持久回归用例。第四轮提供的 22,716 组对拍属于独立审阅方报告，不冒称本轮主审实跑。

### 13.2 验证状态

前轮 CI 仍对应已发布旧头，不能覆盖此次未提交补丁。本次使用实际 Claude CLI Sonnet/high 生成两个生产文件的限定补丁，CLI 回执模型为 `claude-sonnet-5-5`，无工具、无文件写权限；Codex 应用并独立复现。Sol6.1/high 补充两份真实路径测试，Astra/ultra 只读复核生产边界。没有冒称使用本轮未调用的 Grok/Kimi。

首次在旧生产代码运行新测试，12 个新增用例红，原有用例保持通过。Claude 初版未严格拒绝非法 select 返回及缺失租户字段，主审构造 count=0/select={} 后确认可被当成空表放行，已修为严格数组/字段/计数校验。另有两处测试夹具问题（公开错误 details 为 null-prototype 对象、有效在线计划的旧部署夹具缺完整读取合同）按真实生产形状修正，未改宽生产守卫。

Astra 找到两项并发缺口后继续修补：新的 create/replay 回调路径先固定 READ COMMITTED 再非阻塞争抢原租户锁，忙时 409，未取得锁时不解析计划/建表。回调、容量检查、登记插入仍在同一事务内；宿主写入并非跨库事务回滚。代码复核未再发现新增阻断；它未运行物理 PostgreSQL，不把只读判断写成实测。

主审最终独立运行两份完整 CJS：**store 20/20、routes 28/28，共新增 16 个 P2 用例**。覆盖 active/archived 变体拒绝、精确重放、默认/CS、租户隔离、在线与部署两方向覆盖、无效清单及计划不可用、请求不能覆盖模式、并发 BUSY→重试 CONFLICT、历史歧义重放拒绝。真实路由、真实 store、真实有效计划解析器均参与；数据库与宿主端口是合成替身，不连接客户库。

七组内存变异：去查重、去锁、将身份检查移到 prepare 之后、忽略归档、误用部署模式，这五组均被真实路由断言杀死；去隔离固定、恢复阻塞锁两组被真实 store 的首语句顺序与有限双连接池进度用例杀死。保留一个重要证据边界：路由内存 DB 本身不模拟 PostgreSQL snapshot，单在路由套件删除隔离固定不会变红；因此隔离级别保证来自 store 调用序列测试和仓库既有隔离 helper，**本轮没有物理 PG 的 REPEATABLE READ 并发实跑**。没有用存活路由变异伪装全绿。

完整链首次运行红在三条旧 call-site 源码顺序断言；已改为检查 deferred callback 中 provision→install→返回句柄、同一 store 事务 lock→identity→prepare→insert，并保留原 grant/pack 先后门。第二次红在旧合成 DB 将 blocking/try 两类锁分开建模，导致归档能穿透 try 锁；已统一同一 key 的锁状态与等待队列，原归档竞态用例通过。两次失败及哈希均保存在本地证据，未抹去或改原套件预算。

证据目录：`tmp/p2-registration-20261024/`；定向结果 `nonblocking-final-summary.json`，五组路由及一组未捕获隔离变异原始记录 `mutations-summary.json`，两组 store 补证 `store-lock-mutations-summary.json`。store stdout SHA256 `2f264ec446d43a6294c9f2bce310a99a0e0c4b72fc6f2a47de313d0e9a79bb05`，routes stdout SHA256 `21d2b9520ba35281d39777a56a1f77725617bc141fac6449e2a2d19d59056263`。

最终冻结候选在新建 Linux native/LF 副本执行原完整 fail-fast 插件链：**299/299、exit 0**。完整 exact-byte provenance 通过；既有两份接线整文件 **71/71**，0 fail/cancelled/skipped；前端 Docker 构建依赖闭包守卫 **4/4**。没有删套件、忽略 pin 或延长原预算。`final-linux-summary.json` 记录 14,135 个安全源码路径运行前后不变；导出前排除 backend `.env`，没有读取或复制该文件。七个本轮代码/测试/pin 路径及 Windows 原字节、Linux LF 字节哈希在 `final-overlay-manifest.json`，不是把工作区未提交补丁漏在 Git 导出之外。

最终完整链 stdout SHA256 `e9d48ca59b6740f0f7d512c2ecac1436a083f06cce29e8087c1e82a2351c774a`，stderr SHA256 `73edaa5c9400d773fdf417104f815e0dd1066b9facdd9cfe51bf60ebefbf2864`。唯一变化的实际 provenance 项为 `runtimeFiles.pluginHttpRoutes`：`06f41424997bab7be0dabc06da44a247ca7e674eae639f68e28b245160c2a1f3`；完整计算结果与 pin 文件零差异。此次仅 CJS/测试/MD 变更，没有把历史 Linux 类型通过冒充新跑了 Windows 类型检查。

本轮 P2 的本地修复与合成回归已完成，可重新审阅。HEAD 仍为上述基线；没有提交推送、触发 CI、操作 #6337 或修改客户配置。下面的限制保留，不以本地完整链通过代替全部 P3、客户验收或新的 CI 结果。

### 13.3 尚未关闭的边界

- 历史大小写重复登记不自动合并或删除，归档不会解除冲突；启用该模式前需另行授权盘点及处置。整个租户锁协议中既有生命周期等阻塞参与者仍可能造成连接池压力，本轮只证明新的 create/replay 争抢不阻塞等待。
- P3 的激活前提、在线计划缺省字段语义、操作员拉取错误提示、持久前后端对拍及其余覆盖没有借本轮顺带宣称完成。只补正类型检查措辞、回滚同时覆盖部署 JSON 的说明。
- 没有替客户选默认大小写模式；状态字段名与显式启停值仍可配置，未知值保持拒绝，没有增加“其余按停用”选项；项目以外的标识不扩范围。

## 14. 第五轮 P2-A / P2-B 本地修正（2026-10-24）

本节取代 §13 对候选“已可收敛”的判断，不覆盖或删除历史证据。基线仍为 `d3930865ea79e05550d1203fbde43dc0495be20a`。实读第五轮交接 `round5/to-codex-round5.md` 后确认：请求 workspace 及部署 CI/在线 CS 组合能够绕过租户登记检查；默认登记改用 try-lock 又产生 BUSY 回归。本轮仅本地修复 #6324，未改 #6323、#6337、Git refs 或远端 CI。

### 14.1 修改及责任边界

- P2-A：建表 query 空键白名单；专用 `resolveStockPreparationProjectRegistrationComparison` 仅接收服务端已核实租户，汇总部署、tenant-null、部署 workspace 和完整绑定清单各 workspace 的策略，任一 CI 即 CI。在线缺省/CS 不抵消部署 CI。指针及 approved 版本身份必须一致，指针/绑定清单二读变化拒绝；不调用完整执行解析、来源验证或凭据能力。
- 未迁移兼容只限首次 `getActivation(tenant, null, action)` 单表读取的精确 SQLSTATE `42P01`。后续 scope、binding、version、权限或服务方法失败均不能充当“无在线策略”。内容规范化及摘要由真实 `getForRuntime` 的 `checkedRow` 合同验证；真实存储记录内容/摘要损坏负例已覆盖，不复制第二套 hash 算法。校验后由同进程失约 producer 篡改返回物不在此保证内。
- P2-B：默认/CS 恢复锁外 provision/装包、原阻塞事务内登记；CI 才采用 try-lock、READ COMMITTED、锁内身份复验后准备目标。默认同租户不同项目并发得到 `[201,201]`，同项目并发为 `[201,409 EXISTS]`，不新增 BUSY。重放只在 CI 传入策略 resolver。
- 前端 BUSY 只重读本次同一项目一次：active 才继续既有预览及写入确认，未登记/归档/不可读/开关关闭不推断成功；不自动重试建表，也不因另一个项目完成而继续拉取。新增五种专用拒绝文案；大小写冲突不提示“稍后重试”。数据库句柄缺 strict-lock 能力使用 `STOCK_PREPARATION_PROJECT_TARGET_LOCK_UNAVAILABLE`。
- 登记仍以宿主成员关系确认租户，不额外继承执行的 tenant-claim 开关；客户包本来具有的授权前置条件未删除。归档恢复/合同选项修复不创建新身份，保留原合同，不能解除执行侧对存量歧义的拒绝。

实施记录：实际 Claude CLI 以 Sonnet/high、禁工具模式返回限定三生产文件补丁，回执 `modelUsage` 为 `claude-sonnet-5-5`；Codex 独立基线复现、审阅应用并补 pointer.id / 内容键格式 / workspace 形状检查，测试工作由 Sol6.1 high 分担。Astra ultra 对新政策查询、默认创建路径及 BUSY 重读只读反驳，未发现新增阻断；其结论不替代备料线会话的跨线评审。

### 14.2 已执行证据及原失败

本轮 evidence 根目录 `tmp/p2-r5-20261024/`；独立旧实现负例在 `tmp/p2-registration-20261024/r5-root-before-*`。先跑新测试，旧候选 route 7 条失败、store 1 条失败，保留日志。新代码初跑的四条 route 503 来自测试指针缺少 id，改为带规范指针身份的夹具后通过，未放宽生产检查。

| 核验 | 本轮结果 |
| --- | --- |
| 后端真实路由/存储/运行时整文件 | 32 + 20 + 60 = **112/112**；真实绑定 store、真实版本 store、合成内存数据库 |
| 调用点结构守卫 | **18/18**，保留原 grant/pack/锁内重读顺序，新增 7 个有限静态变异自测 |
| 客户包重装与归档整文件 | **16/16 + 10/10**，原断言保留 |
| 前端五整文件 | **301/301**（项目登记 44 + 原来源计划四文件 257）；Windows 独立主审执行 |
| 行为变异 | 新后端 8 + 原身份/锁 6 + 前端 2 = **16/16 致红**；无语法错误/未命中被冒充杀死 |
| 完整插件链 | 原 fail-fast 链 **299/299**、exit 0；没有删套件或绕过 provenance |
| 接线 / Docker 依赖守卫 | **71/71 / 4/4**，0 fail/cancelled/skipped |
| exact-byte provenance | 完整测试通过，实际模块重算与 pin 文件零差异 |
| 主类型目标 | Linux `vue-tsc -b --force` 原 300 秒预算，exit 0、timeout false、0 TS error；不是新的 Windows 类型通过证明 |

前端两变异直接改变隔离 Linux 副本的生产模块后跑原整文件：BUSY 当 EXISTS、重读另一个项目均被真实流程断言抓到，随后还原副本源字节。后端变异为内存编译注入；部署降级、丢工作区、宽泛错误回退、忽略版本/二读变化、接受 query、默认一律 strict，以及原身份/归档/锁/隔离时序均有对应失败名。行为变异摘要分别为 `mutations-summary.json`、`retained-mutations-summary.json`、`web-mutations-summary.json`。

完整链首跑保留为真实失败：客户包重装旧夹具只有 `getActiveForRuntime`，未声明新的 no-pointer 元数据能力，11 条原测试先遇到 503。只对两个明确无在线指针的夹具补 `getActivation() => null`，没有更改预期或真实缺能力负例；归档 10 项也独立复跑。首轮链 stdout SHA256 `134bc5c0d1f79fd725bcfe4f0903b444047269d29c17f5a8914b1a459d85446d`；不得记成首轮全绿。

最终 Linux/LF 候选的 14 个代码、测试、pin 路径由显式覆盖清单完整装入安全基线，导出前排除 backend `.env`，没有读取/复制该文件。原完整链执行前后 14,135 个安全源码路径不变；最终 Windows 工作区原字节与覆盖清单全部相符。证据为 `final-overlay-manifest.json`、`final-linux-summary.json`、`final-source-verification.json`。最终链 stdout SHA256 `206bb36bd8a34d4e69778626df69a8c5392c8ce52fbd59c59f3294fffa73a09e`，stderr SHA256 `73edaa5c9400d773fdf417104f815e0dd1066b9facdd9cfe51bf60ebefbf2864`（既有合成 host 能力警告，不是测试失败）。

本轮实际 provenance 计算只改变 `runtimeFiles.pluginHttpRoutes`，值为 `384027d52ebc3dde576e459db38e968c06954c63a1551975c96f973f98802863`；未手猜 pin。Linux 类型检查运行前后安全源码不变，stdout/stderr 为空且 exit 0；其候选与最终树只有随后补齐的两个 CJS 测试夹具不同，生产及前端字节一致。前端 301 项 stdout SHA256 `c646a9d00836ef1bba60fe2208b366098cf3adaf9f41ff222e0ddea06f38afcf`。工作区和父层 HEAD 保持 `d3930865e` / `64f9d2183`，没有提交/推送/触发 CI。

工作区范围变异进一步同步删去首次与二次 scope 枚举，避免仅靠“二读不一致”兜底致红：真实绑定/版本用例仍因漏掉 workspace CI 失败。首次较弱探针记录保留，最终仍为 16 组行为变异，不将重复运行加进数量。常规路由不能单独证明 READ COMMITTED，隔离/锁变异继续由 store 的顺序与有限连接模型断言捕获。

### 14.3 提交前仍需满足

备料线会话必须复核共享登记 store 的 `create(input, prepareTarget)` 契约、锁类型及建表顺序。本轮只读子代理不等于该会话认可；当前未提交、未推送，跨线评审仍待完成。

策略二读稳定不是登记与激活的事务快照；后续/并发激活、历史大小写重复治理及 strict 路径的宿主写不可随 registry transaction 回滚等边界仍保留。此次并发测试使用合成内存锁模型；第五轮审阅方的物理 PostgreSQL 7/7 属其上一候选证据，本轮未冒称重跑物理库。Windows 历史 vue-tsc 300 秒超时仍保留，Linux 通过不能改写该历史。未读客户数据、未真实发送、未开启任何开关。

## 15. 登记与激活串行化（Claude 实现，2026-10-26）

owner 2026-10-26 同意由 Claude 在第五轮未提交补丁之上实现，交回补丁，由 Codex 或 owner 指定的人提交。基线：`d3930865e` + 第五轮工作区补丁（Claude 只读快照 sha256 前缀 `7f593fea`，16 个文件与 Codex 工作区逐个 hash 一致）。实现与验证均在 Claude 的 WSL 私有克隆中完成，未写 Codex 工作区，未提交、推送、触发 CI。设计见设计说明“第六轮补正”。

### 15.1 修改

- `stock-preparation-project-target-store.cjs`：登记行读取与校验提为模块级 `readRegistryRowsForIdentity`；新增并导出 `lockRegistryAndCountCaseFoldedProjectGroups`（阻塞取同一租户锁后统计大小写折叠组，含归档）；`lockRegistration` 分 `try` / `pinned` / `blocking` 三种，`create` 无 prepareTarget 但有解析器时走 `pinned`（固定 READ COMMITTED + 阻塞锁 + 锁内复查）。
- `stock-preparation-read-plan-store.cjs`：`activate` 对 CI 版本在固定隔离级别后、锁来源前调用上述函数；冲突 409、不可信 503。`stock-preparation-read-plan-management.cjs` 放行两码。
- `http-routes.cjs`：默认/CS 登记把解析器传给 `create`。provenance 仅 `runtimeFiles.pluginHttpRoutes` 变化，由仓库模块重算写入。
- 前端：`sourcePlanVersions.ts` 诊断白名单、`StockPreparationSourceBindingPanel.vue` 两条文案。
- 测试：登记表 store 新增 P2-S09/S10；路由新增 P2-R13、更新 P2-R12（默认路径固定隔离 + 阻塞锁，仍无 try-lock）；读计划 store 新增 3 例，并给其内存库补登记表、锁与计数；执行身份测试内存库同补；调用点守卫更新默认路径期望及对应变异；前端校验 spec 新增两码与两个错误状态组合。

### 15.2 证据（WSL 私有克隆，Linux/LF）

| 核验 | 结果 |
| --- | --- |
| 基线复现（改动前） | 第五轮全部数字复现：定向套件全绿、插件链 299/299、接线 71/71、Docker 守卫 4/4、pin 零差异、前端 301/301、Linux vue-tsc 0 错误 |
| 定向后端 9 个整文件 | 全部 exit 0（含读计划 store 18/18、管理 35/35、执行身份 12/12、运行时 60/60、调用点守卫 18/18） |
| 完整插件链 | 299/299，exit 0 |
| 接线 / Docker 守卫 / provenance | 71/71、4/4；provenance 通过，重算与 pin 零差异 |
| 前端 5 个整文件 | 313/313（原 301 + 新增 12） |
| Linux `vue-tsc -b --force` | exit 0，0 错误（Windows 未跑） |
| 后端变异 | 10/10 致红：去激活检查、检查移到来源锁之后、激活永不视为 CI、忽略已发现组、默认路径不传解析器、去隔离固定、默认路径改 try-lock、扫描不取锁、扫描忽略归档、管理层不再映射两码；每次字节级还原后全绿 |
| 前端变异 | 2/2 致红：冲突文案分支、诊断白名单两码 |
| 真实 PostgreSQL（WSL PG14，临时库，按 CI 迁移） | READ COMMITTED 6/6、REPEATABLE READ 7/7：激活先持锁则变体登记 409；登记先持锁则激活 409；默认路径等锁期间对方提交的行可见；默认并发登记两个都成功。对照：去掉登记侧复查、激活扫描不取锁均重现配对；REPEATABLE READ 下去掉隔离固定重现读旧。临时库已删除 |

真实库探针以真实登记 store、真实激活检查函数和插件 db 适配器运行；“激活”按读计划 store 的事务顺序模拟（固定隔离 → 检查 → 写指针 → 提交），未经过完整读计划账本与 HTTP 路由。

### 15.3 残余与仍需

- 默认/CS 登记持阻塞锁期间，模式解析占用连接池另一条连接（新建腿新增；main 的重放腿与修复路由已有同类）。备料线评审实测并接受：同租户同时 ≥20 个默认路径登记时后端约停滞 9–10 秒，持锁者 503 且无改动，多余请求无类型 500，自行恢复；19 个并发 65 毫秒完成。可选后续（owner 决定）：向模式解析传事务句柄（`{ executor }`），实测 20/40 并发 55–79 毫秒无停滞。

### 15.4 备料线跨线评审（2026-10-26）

结论 SIGN-OFF（独立 Opus max 评审，真实 PG14 实跑）：全部租户锁持有者的总锁序成立（暂停探针 7/7，倒序对照触发 40P01）；#6514 治理快照的 `{ executor }` 与两参数 getPilotState 在合并后保留，大小写变体各自解析到本行；计数/扫描失败两侧均拒绝（变异 8/8）；连接池残余按上一条数字接受。提交前须与 main `9bcaf4b81` 合并：登记表 store 自动合并；唯一冲突为 provenance pin 文件，两项均用 `computePackageProvenancePinSet` 在合并后的树上重算，不择一侧；合并树完整插件链 301 套件通过。另有与本补丁无关的现象：数据库默认 REPEATABLE READ 时，排在试点标记后的阻塞重放可能 40001，main 上同样存在，READ COMMITTED 下不出现。
- “预读为 CS、激活恰在建表期间提交”时，锁外已建的表不登记，由同一拼写的重试复用。
- 真实库探针未经过完整读计划账本、HTTP 路由及真实 `getForRuntime`；内存测试只证明语句顺序，不证明 PostgreSQL 锁。
- 备料线会话复核共享登记 store 的新增导出函数、三种锁模式及默认路径锁内复查；Windows 类型检查未跑；未读客户数据、未真实发送、未开启任何开关。

## 16. 在线读计划开关与迁移 089 乱序实测（Claude 实现，2026-10-26）

owner 2026-10-26 要求在合并前补两件事：在线读计划（SA-02）加默认关闭的部署开关；在已迁移到 main 的库上实测补跑 089。实现与验证均在 Claude 的 WSL 私有克隆（第十五节之上）完成，未写 Codex 工作区，未提交到任何共享分支、未推送、未触发 CI，未读客户数据，未开启任何开关。

### 16.1 开关

- 环境变量 `MULTITABLE_STOCK_PREP_ONLINE_READ_PLANS_ENABLED`：只有逐字的 `'true'` 才算开（不去空格、不折叠大小写），插件路由模块每次调用时读取；谓词在 `lib/stock-preparation-read-plan-switch.cjs`，已登记进 `scripts/ops/global-history-flag-manifest.mjs`（boolean、danger high），完整性测试新增该插件族扫描与逐项测试。
- 关闭态（默认）：

| 面 | 关闭时 | IO |
| --- | --- | --- |
| 8 条读计划管理路由（list / save / validate / confirm-sample / approve / retire / activate / deactivate） | 先过管理员门（非管理员仍 403），再一律 404 `READ_PLAN_MANAGEMENT_DISABLED` | 零：不读账本、元数据、登记表或来源 |
| 拉取执行（dry-run / apply / 大 BOM 作业） | 不读激活指针，执行部署动作 | 不触及 089 的读计划表（读计划存储缺失或报错都不影响拉取） |
| 开着时签发、关后才用的工作 | dry-run 令牌 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`（令牌绑定的是计划组合后的动作）；已存的大 BOM 作业各阶段 409 `READ_PLAN_ACTIVATION_MISSING` | 不访问来源、不写目标、不消费令牌；拒绝前可能读取绑定、项目或令牌元数据。不是“零 IO”，详见 §17 |
| 项目登记的大小写比较 | 只取部署动作的答案 | 不读指针、版本、绑定 |
| 未配置动作的来源预检 | 跳过指针探测 | 不触及读计划表 |
| 来源绑定读取 | 响应带 `onlineReadPlansEnabled: false` | — |
| 前端来源绑定面板 | 初始缺省为关；成功回读为关时隐藏勾选、收起区块；离线 JSON 草稿保留 | 成功取得关闭响应后不发读计划请求；曾回读为开而后续刷新失败的缓存边界见 §17 |

- 打开：管理员可保存、抽样核对、审批、激活租户级读计划；已激活的计划替换该租户每次备料拉取的部署 readPlan。打开属 owner 决定。
- 关闭不删除指针：开→激活→关→再开时，原指针立即恢复生效，关时被拒的令牌再开后仍可应用（运行时翻转测试实测）。部署动作里配置的大小写比较不受此开关影响。
- 宿主真库测试 `stock-preparation-read-plan-host-realdb.test.ts` 现在在自己的环境里设置该开关为 `'true'`；CI 真库步骤无需另加环境变量。

### 16.2 迁移 089 乱序实测（WSL PG14，临时库，已删除）

PR 相对共同基点只新增 3 个迁移文件（`089_create_integration_stock_prep_read_plan_versions.sql`、`zzzz20261001120001_stock_prep_validation_source_revisions.ts`、`zzzz20261001121000_stock_prep_read_plan_validation_ledger.ts`），不改已有迁移或执行器；main 在共同基点之后新增 102、103。执行器：`src/db/migrate.ts`（Kysely Migrator，`allowUnorderedMigrations: true`）；`.sql` 文件由 `createCoreBackendMigrationProvider` 包装为同一 Kysely 迁移，记入 `kysely_migration`。仓库内部署脚本（`scripts/deploy-ghcr.sh`、`scripts/deploy-ghcr-gh.sh`、各 on-prem 安装/升级脚本）调用的是同一源码编译出的 `dist/src/db/migrate.js`。

| 步骤 | 结果 |
| --- | --- |
| A：main `9bcaf4b81` 迁移集迁新库 | exit 0；已应用 452；含 102、103；不含 089；名字排在 089 之后的已执行迁移 393 条；读计划表 0 |
| 对照：合并后迁移集 + `allowUnorderedMigrations: false` | exit 1：`corrupted migrations: expected previously executed migration 090_create_integration_yida_delivery_ledger to be at index 59 but 089_create_integration_stock_prep_read_plan_versions was found in its place`；已应用仍 452 |
| B：合并后迁移集 + 原执行器 | exit 0；恰好执行 089 与两个 zzzz 迁移；已应用 455；读计划 4 表齐全；089 执行时间晚于 103 |
| C：再跑一次 / `--list` | 执行 0 条；Applied 455、Pending 0 |

结论：在已迁移到 main 的库上补跑 089 成功、不重跑；`allowUnorderedMigrations: true` 是必要条件（对照见红）。“合并后迁移集”= main 树叠加 PR 新增的 3 个文件（逐字节相同）。两阶段使用 CI 的 MIGRATION_EXCLUDE 清单（与 089 无关的旧迁移）。开关关闭时拉取路径不访问读计划表，所以即使某环境在 089 补跑前先上了新代码，拉取也不受影响（bootstrap 测试以“读计划语句全部报错”实测）。

### 16.3 证据（WSL 私有克隆，Linux/LF）

| 核验 | 结果 |
| --- | --- |
| 定向后端 12 个整文件 | 全部 exit 0（运行时 66/66、管理 38/38、读计划 store 18/18、执行身份 12/12、bootstrap 4/4、来源绑定路由 17/17、调用点守卫 18，另含登记 store / 路由、两份来源预检、dry-run 作业） |
| 完整插件链 | 299/299，exit 0 |
| 接线 / Docker 守卫 / 开关清单 | 71/71、4/4、47/47 |
| provenance | 通过；仅 `runtimeFiles.pluginHttpRoutes` 变化，用仓库模块重算，与 pin 零差异 |
| 前端 5 个整文件 | 316/316 |
| Linux `vue-tsc -b --force` | exit 0，0 错误（Windows 未跑） |
| 后端与开关清单变异 | 15/15 致红：谓词折叠大小写/空格、谓词恒开、执行侧非 false 即读指针、登记侧关时仍读在线范围、管理层忽略开关、开关检查提到管理员门之前、处理器工厂不要求开关、执行路由恒传开、管理挂载恒开、预检关时仍探测、登记路由恒传开、绑定读取恒报开、清单删条目、完整性扫描删插件族、关时在途身份不再拒绝；每次字节级还原（sha256 核对）后全绿 |
| 前端变异 | 3/3 致红：关时仍显示勾选、关时回读不收起（两道防线同时去掉）、字段缺省按开 |
| 宿主真库（WSL PG14 临时库，按 CI 迁移） | 开关打开：锁协议套件 56/56；读计划宿主套件本机 19/23，失败的 4 条（浏览器验收点击超时、依赖它的下载复用、两条“应等锁”计时）在 fix7 基线 `5ce54762d` 上本机完全相同。相同失败只说明尚未证明是本次开关引入，不足以确立“本机环境”根因；四条仍未关闭。把开关从该测试环境去掉：19/23 失败（管理路由 404），开关在真实宿主上生效见红。临时库已删除 |
| 迁移 089 | 见 16.2 |

### 16.4 残余与发现

- 原报告把区块 `v-if` 与关闭即收起视为可单删的等价防线；§17 的独立 true→false→true 反例否定了这一判断：单删关闭复位会恢复旧确认状态。原“同时删除致红”证据保留，但不再据此声称单删等价。会话切换清空开关值仍没有单独测试。
- 只出结论、未改（#6323）：K3 B4 / BL2 运行面板调用的两条路由在 main 上已存在，#6323 未改 `http-routes.cjs`。`POST /api/integration/read-source-configs/:id/read`（`http-routes.cjs:37`、处理函数 `:6733`，`9bcaf4b81` 与 `64f9d2183` 行号一致）只要求集成读权限，并只执行已审批的读源配置；`POST /api/integration/stock-preparation/mvp/source-runs/erp-materials`（`:144`、`:9545`）要求集成管理员，读取本身没有部署开关，只有自动落库受 `MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED` 控制。两者都没有部署级开关；现有闸门 = 读源配置审批 + 权限档位 + K3 只读账号（裁决 A）。
- 只出结论、未改（main 既有）：`MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED` 的谓词（`http-routes.cjs:1658`，`9bcaf4b81`）做了 trim + 小写折叠，不是逐字 `'true'`，且未登记进全局开关清单。
- 宿主真库套件有 4 条在本机（fix7 基线与 fix8 相同）不过，CI 是裁判；Windows 类型检查未跑。

## 17. Codex 独立交接复审（2026-10-26）

### 17.1 冻结范围与本地应用

实读第七轮交接后，在第五轮工作区先备份再应用 fix7+fix8 的 27 文件增量；补丁 SHA256 为 `c53e7be0290140ddb0400649a1942e564d18d32f1283b4152290fc3e167be094`。应用后 27 个文件按 LF Git blob 哈希逐项匹配交接清单。随后仅补正本节及设计说明的审阅措辞。工作区 HEAD 仍为 `d3930865ea79e05550d1203fbde43dc0495be20a`；没有提交、推送、触发 CI、合并远端 PR、部署或修改 #6337。

审阅对象是 Claude 私有候选 `8bb40c7e0baa11ba31e14ff1623b911564fcb02b` 的源码。Astra ultra 负责后端关闭态、在途身份和最新 main 交互的只读反驳；Sol6.1 high 负责前端/清单和真实组件合成反例；Codex 主审独立执行完整链、pin 和最新 main 定向复现。没有把代理意见代替实跑证据。

### 17.2 独立实跑与证据审计

采用新建 Linux/LF 审阅副本，显式安全源码导出与 33 文件覆盖清单；不读取或复制 backend `.env`，测试使用空 `METASHEET_ENV_DIR`。证据位于 `tmp/round7-review-20261026/`。

| 项目 | 独立核验结果 |
| --- | --- |
| 原候选完整插件链 | **299/299**，exit 0，包含完整 exact-byte provenance 测试；stdout SHA256 `52e5c66bf7489d9a34642a2035b58d1f9f0e223d7afc536a5da584fd13b37ab9` |
| 接线 / Docker 守卫 / 开关清单 | **65+6=71/71 / 4/4 / 47/47**；没有 skip、cancelled 或预算放宽 |
| 原前端五整文件 | **316/316**，exit 0；未用新增反例替换原测试；stdout SHA256 `750b1b1651e8e0145fece7d406b8016650f732736bdc62f744adcfb109b7b8c5` |
| 独立 pin 计算 | 仓库 `computePackageProvenancePinSet` 的六组字段与冻结清单完全相同；`pluginHttpRoutes` = `0c5355e6c4fbff182bab12c454838f4351f14bb9b32a0b642830a23edbf37325` |
| 迁移证据审计 | 亲读迁移执行器、provider 与合成脚本，内存解析原日志：A 成功执行 452 条且含 102/103、不含 089；B 恰好 3 条且含 089；负对照 `C-migrate.log` 为指定乱序错误；重复执行 `R-migrate.log` 无新增；list 为 Applied 455 / Pending 0。此项是核验 Claude 原 PG 实跑证据，**不是 Codex 再跑一次物理 PG** |
| 宿主失败证据审计 | 原合并日志为 75 通过 / 4 失败（56+23）；fix7 和 fix8 单独宿主日志均为 19 通过 / 4 失败。四条失败保留，不宣称根因已定位或全部可验收 |

迁移审计仍受 §16.2 的 CI 排除集限制；不能外推为所有生产迁移历史均已演练。本轮没有重跑 Windows/Linux 类型目标；既有 Linux 类型通过、Windows 历史超时分别保留。没有复跑或调用真实客户 SQL/API。

### 17.3 保证范围与前端反例

未发现第七轮新增后端开关绕过。需要明确三条语义：

- 开关在准入时读取，不是运行中取消令牌。已经解析完成并排入后台的 dry-run 或当前阶段可以继续；后续新请求/新阶段重新检查。关闭不等于撤销，重新开启仍可能恢复原激活指针及尚未消费的有效 token。
- 旧在线工作被拒绝前允许读取绑定、登记或 token 元数据；拒绝发生在来源访问、目标写入和 token 消费之前。外部系统删除的引用保护仍可查询读计划版本表，这不是读计划执行入口，也不应为关闭开关删除引用保护。
- 前端曾成功取得 true 后，绑定刷新 503 会保留管理开关和区块；手动再读计划仍发请求，服务端会独立检查开关。真实组件反例中调用计数为 1→2，属于 **P3 缓存显示/错误处理问题，不是权限绕过**。初始读取失败仍默认关闭，成功回读 false 会收起并清空确认。

真实组件原文件 46/46 通过；增加两条反例后 47 通过 / 1 失败（失败项采用额外的“刷新失败即收起”UX 期望，不冒充现有合同）。原组件的 true→false→true 清理用例通过；仅删除关闭复位一行后，该用例四个断言失败：管理状态、区块、旧确认恢复，并可再发一条 mock 审批请求。字节还原后同用例通过。因此 §16.4 原“单删等价”结论已更正。补丁及日志在 `ui-stale-switch.regression.patch`、`ui-reproduction-notes.md`；反例只添加到隔离副本，没有更改当前工作区生产代码/测试。全部请求均为合成 mock，没有真实发送。

### 17.4 当前提交阻断：最新 main 已改变合同

交接试合并基线为 `9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651`。本轮本地已知 `origin/main` 为 `4c4cd3abafad0761cb1fedcc8731b4341d02ee19`，新增了 #6550 的治理 consult/整次暂停等行为，**不能沿用旧 main 的“仅 pin 冲突、301 套件通过”结论**。

对这两个冻结输入执行 `git merge-tree --write-tree`，不移动任何 ref 或工作区，得到虚拟树 `62aad3eccb78445222a2441a1289a783b5cc36f9`，exit 1，四个真实冲突：`stock-preparation-table-actions.cjs`、`stock-preparation-continuation-golden.test.cjs`、`stock-preparation-demand-evidence-golden.test.cjs`、`s6a-package-provenance-pins.json`。

产品冲突不能整块取候选：必须保留 main 的 `refreshGovernance: input.refreshGovernance`，同时保留候选 SA01D 的无条件 broken-cursor 检查语义。丢掉治理参数会让后续 `dryRun.refresh && ...` 拒绝静默失效。两份黄金用例必须保留 `wired/absent × modes` 两维及候选 v3/负校准，跨 mode 结果不能被最后一个 handle 覆盖。自动合并的 HTTP 仍同时保留在线身份检查和 main 治理 handle，未发现相互替代。

在另一份独立审阅副本，仅按上述规则解决产品 hunk（其余冲突仍保留，**不是最终对齐树**），实跑原 `stock-preparation-read-plan-runtime.test.cjs`：**50/66 通过、16 失败、exit 1**，存在明确 `501 !== 200`。夹具未提供 main 新增的两个治理服务，HTTP 在来源 IO 前拒绝；不能通过删除治理门或让在线关闭态绕过治理来恢复绿灯。stdout SHA256 `2babab1c78ea8fa8120601af7ba61c48e360784147b2d0760af4d8daf0ad6177`；详情 `latest-main-targeted-probe.json`。这一步用于复现对齐缺口，不宣称完整合并/CI 验收。

最小收尾顺序：保留两边合同解冲突 → 补真实内存治理 harness 并保留 absent 负例 → 在完整对齐树重算 pin、重跑受影响完整测试 → 保留并继续定位宿主四失败 → owner 放行后才提交推送及既有 CI。§15.4 已有备料线 SIGN-OFF 的事实保留，但它只覆盖旧 `9bc` 基线；最新治理交互需将新证据交回同线复核。本轮结论是 **原候选默认关闭逻辑可采纳，尚不可按旧交接直接提交或宣称全部验收完成**。

## 18. 最新 main 本地对齐与宿主复验（2026-10-26）

### 18.1 范围、基线与冲突处理

本节落实 owner 本轮授权，仅在 #6324 本地对齐、修复夹具并合成验证。冻结 main 为 `4c4cd3abafad0761cb1fedcc8731b4341d02ee19`（本轮远端只读查询核实），交接候选为 `8bb40c7e0baa11ba31e14ff1623b911564fcb02b`。工作区 HEAD 仍为 `d3930865ea79e05550d1203fbde43dc0495be20a`：这是工作区内容对齐，没有移动 ref、提交或合并 PR。

§17.4 的四处冲突已解决：table-actions 同时保留 main 的治理参数与候选的无条件 broken-cursor 合同；两份 golden 同时保留 wired/absent × modes、v3 合同、历史投影和负校准，原 GOLDEN 字面量相对两边冻结输入均未改变；pin 使用仓库计算函数在最终组合树重算。HTTP 的治理服务准入与读计划版本/激活身份检查仍分别执行，没有相互替代。

按文件清单备份后落回工作区 88 个文件，其中包括从 main 带入的既有改动，不代表新增 88 个文件或功能切片。最终逐字节核对：工作区、已测试 Linux 副本和落盘回执 **88/88 一致**，冲突标记 0；仓库计算出的 **66 项 pin 零差异**。主源码位置：`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:2999`。

收尾时再次只读核对远端 main，仍为同一 `4c4cd3aba`。`git diff --check` 仅报告随 main 原样带入的 `decision-register.md:62` 行尾空白；该文件与 main 字节一致，未为清理历史格式另改它。排除此文件后 whitespace 检查 exit 0，不宣称全工作区检查无告警。

### 18.2 治理夹具与真实宿主隔离

- 运行时测试使用 main 已有的 `wireRefreshGovernance(services)`，接入同一套服务、登记与锁，补足原 16 条 `501 !== 200` 的夹具缺口。新增 wired 正控制之后的服务缺失负例，分别覆盖在线开关 ON 与 unset OFF 的同步 dry-run：精确返回 `501/governance_service`，来源行读取、目标记录读取、业务写、token 与治理状态均不变；不扩称 schema、绑定等元数据零 IO。这不是全部 lane 或全部开关字面量覆盖。位置：`plugins/plugin-integration-core/__tests__/stock-preparation-read-plan-runtime.test.cjs:234`、`:328`。
- 宿主专用 schema 补入真实 087/101/102/103 迁移。项目登记、continuation/member、refresh state/hold/execution 六表同时纳入 owned-schema 断言和带 schema 的零写入快照，避免依赖 public 同名表。位置：`packages/core-backend/tests/integration/stock-preparation-read-plan-host-realdb.test.ts:201`、`:244`、`:311`。
- 先前本轮 baseline 虽为 23/23，但当时未补上述 schema 隔离，不能作为此保证的证据。补齐后一次 23/23；移除 owned 103 的负对照按预期失败；字节还原后再一次 23/23。原 23 项、浏览器操作 15 秒、整项 90 秒及锁等待预算均保留；浏览器辅助文件未修改，没有 force-click、增加重试或放宽身份/锁守卫。
- 每次宿主验证都由已有 owned-PG helper 新建独占临时集群，使用合成账号/材料、空 `METASHEET_ENV_DIR` 和 CI 迁移排除集；没有借用已有数据库。正常与负对照均完成清理：await stop，核实 stop exit 0、status 3、postmaster.pid 消失，再移除独占 PG 目录，最终 pg-* 残留 0。宿主套件自身 afterAll await server.stop；它与外层 PG 清理是两层证据，没有虚构额外的 actual-stop 日志帧。

### 18.3 最终本地验证

| 检查 | 结果与边界 |
| --- | --- |
| 完整原插件测试链 | **308/308 套**，exit 0，含完整 exact-byte provenance；main 新增套件一并执行，没有跳过旧失败套件 |
| 读计划 runtime / bootstrap | **67/67 / 4/4**；runtime 为原 66 项加一项 ON/OFF 治理服务缺失正反对照 |
| continuation / demand-evidence golden | **25/25 / 246/246**；保留两治理分支及原 golden 值，不外推为 membership 专项覆盖 |
| 必跑接线 / flag manifest / Docker 上下文守卫 | **71/71 / 47/47 / 4/4** |
| 原前端五整文件 | **316/316**，exit 0 |
| Linux 原类型目标 `vue-tsc -b --force` | exit 0、0 错误，56.15 秒，保留 300 秒外层预算；Windows 本轮未跑，历史 Windows 超时记录不删除 |
| 真宿主整文件（完成 schema 修复后） | 两次各 **23/23**，exit 0；两次独占 PG 均停止并移除；期间 wall/monotonic 采样回拨计数均为 0 |
| 有界变异自证 | **7 组按预期致红**，变异后还原；见下文，不代表穷举全部威胁 |

七组变异：两份 golden 各做“强制 wired”与“禁用 v3 contract”共四组，分别产生 2/21 和 4/30 条预期失败；去掉运行时治理 fixture，正控制因 501 而失败；绕过读计划身份预检，既有负例因多一次适配器调用而失败；从真实宿主 owned schema 去掉 103，实际解析到 public 的断言失败。前六组使用内存加载钩子，最后一组只临时修改隔离副本并按 SHA256 还原。宿主最后一组的 Vitest JSON 未包含 beforeAll 错误，初版分析器未识别预期失败；随后依据 stdout/stderr 的 schema 断言修正分类，初版回执也保留，没有只看 exit 1 就称变异有效。

本轮 evidence 根目录为 `tmp/round8-align-20261026/`：`integration-receipt.json`、`final-source-receipt.json`、`final-gates.json`、`owned-host-owned-fixture.json`、`owned-host-final-owned.json`、`host-schema-mutation.json`。golden/治理变异证据另在 Linux 副本 `tmp/round8/`。供交接核对的摘要哈希：

- 完整链 stdout：`767bc017bb6c4ab58c71f845ea3a8e1f3f8d38c234b76d514cc8b03adec9f79d`。
- 前端 stdout：`11da467d037743ee334a9661e0f192cc0023d96eb7a487e20da2900b0320e114`。
- 最终宿主 stdout：`6885d4e76601a5d17eac2189a3b8cd606006a9ea45f3077e81e52492492b76a2`。
- 最终 host 测试文件：`87f19bbf7a0fbeb2394ea002baa6325310b6416c9ee776f410b8c295074dd4f6`。
- 新 `pluginHttpRoutes` pin：`36ecb43c7d93a0d352acfc1a3d228b18aa56386b25563895fbbaa6c54bb6db25`；`pluginIndex`：`8464e2d1b0ce33c134f5914ba0b933ddde7d8c67da8fc204b7fbf21837503f7a`。

### 18.4 宿主历史四失败的定位及保留风险

复核原日志后，首个失败为浏览器初始 draft summary 的点击在 15 秒操作预算内未完成；locator 已解析，但日志不足以确定 visibility/stability 等待为什么没有结束。rAF 调度是待证假设，不能把它写成本次已证明的 WSL 回拨。

其余三条可沿真实顺序解释为连锁失败：浏览器没完成 generation 4 的流程，激活指针仍为 generation 2；后续 activate/deactivate 在更早的 generation 身份检查被拒，因而没有走到用例期待的锁等待；复用下载材料仅在浏览器 helper 成功返回后赋值，所以仍为空。原绑定锁测试失败的是 deactivate，前面的 save-new/save-reuse/retire 已通过。不能为让后续计时变绿而放松 generation 或锁协议。

本轮清洁集群与原预算下，上述四项全部通过，**没有复现历史首次点击超时，也没有证明其根因已修复**。本轮采样零回拨只说明这些运行中未观察到回拨。旧 19/23、250ms 租约、WSL 回拨、ABORTED、SQL 与版本风险记录全部保留。当前证据关闭的是本地对齐/治理夹具和宿主隔离缺口，不代替未来同 head 正式 CI 或生产验收。

### 18.5 分工与交付状态

尝试复用 Grok runtime 时，桥接会话元数据请求 `grok-4.7`，CLI 屏幕却标为 Grok 4.6（xhigh）；在没有工具实施证据时关闭会话，**未认证实际 Grok4.7 调用，不把本轮改动归于它**。两组边界清楚的 golden/治理夹具工作改用 Sol6.1 high；Codex 主审负责真实 PG、还原负例与最终源文件核对；Astra ultra 只读审查限定差异和旧失败调用链，未发现新增 blocker。其意见不替代上述实跑。

本轮授权的本地工作已完成，可交回备料线复核最新 main 的治理组合后申请后续提交/CI。§17.4 的四冲突及 16/66 治理夹具阻断由本节新证据取代，历史失败事实不撤销。尚未取得新 CI，也未将此次未提交工作区包装成正式交付。#6323 本轮未改，#6337 保持封存；未提交、推送、触发 CI、合并 PR、部署、读取客户数据或真实发送。

## 19. 备料线复核通过与本轮发布准备（2026-10-26）

owner 本轮授权：先完成备料线复核，通过后把已验证对齐补丁及 MD 普通追加至现有 #6324，并运行既有合成 CI；不强推、不新增切片、不合并 PR、不部署、不读取客户数据、不真实发送，#6337 保持封存。

### 19.1 新 main 增量与实际发布范围

发布前远端 main 从 §18 的 `4c4cd3aba` 前进一笔到 `40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b`（#6558），因此没有直接发布旧受测树。九个增量文件完整重放并独立复核：八个与新 main 逐字节相同，组合的 `stock-preparation-table-actions.cjs` 保留 `await previewRecoveryRechecked(...)`、治理参数及读计划身份检查。lease-less running-only 的一次重检不会替代实际写入持租约时的行检查；重检显示执行已结束时仍在 reconcile/token/bump 前拒绝。

使用独立发布工作区，以远端现有 #6324 头 `d3930865ea79e05550d1203fbde43dc0495be20a` 为第一父节点准备普通追加，以上述 main 为合入父节点，不改写历史。PR 仍叠在 #6323（base `64f9d2183cfcb5bf0c5072f8179f96deaab22e42`）上，#6323 和 #6337 本轮不更新。

准备树相对 d393 为 **91 个路径**：89 个代码、测试或 main 既有资产，加两份本轮 MD。相对实际 PR base 是 150 个路径，不能把本轮增量数当作整 PR 的规模。未带入 `.env`、临时 artifacts、两个仅 status 显示 M 而字节未变的路径，未新增 #6337 自动宜搭功能。继承 main 的 102/103 迁移不属于此次新开发的迁移。备料线核对 89 个非说明路径与受测 Linux 副本逐字节一致；两份 MD 单独审计。

### 19.2 实际备料线复核

已由既有“备料应用插件”会话完成复核，结论 **PASS，本轮限定组合无新增实现阻断**，不是本任务另起子代理冒充跨线认可。审阅对象是上述 40ce 的最终组合，未沿用旧 9bc 或 4c 的 SIGN-OFF。报告在本机 `C:/Users/zen08/AppData/Local/Temp/codex-stockprep-composition-review-20261026/review.md`，本节保留其可随提交交接的核心结果：

- 治理 consult 准入与来源/版本/激活身份分别执行；默认关闭在线计划不绕过治理。
- 登记与 CI 激活保持同一租户 registry 锁及原锁序，optional executor/getPilotState 合同未回退。既知连接池占用残余仍保留，不扩称解决全部并发。
- golden 的 wired/absent × modes、v3 与历史负校准保持；host 的六表 owned-schema/零写入断言保持。
- 复核侧独立跑八套：runtime 67、continuation golden 25、demand golden 246、project-target-store、read-plan-store 18、refresh-small-lane（含 SL-R4/R5/R6）、refresh-egress、完整 provenance，全部 exit 0。
- 复核侧再次核验本节六组最终门禁 stdout/stderr 哈希及宿主回执，与声明一致；真实宿主由根代理执行，复核侧未冒称自行重复 PG 验证。

### 19.3 新组合最终本地证据

| 检查 | 40ce 组合结果 |
| --- | --- |
| 完整插件链 | **308/308 套**，exit 0，含完整 exact-byte provenance |
| 必跑接线 / flag / Docker 构建上下文 | **71/71 / 47/47 / 4/4** |
| 前端原五整文件 | **316/316**，exit 0 |
| Linux 原 `vue-tsc -b --force` | exit 0、0 错误、60.53 秒，原 300 秒预算不变；不替代 Windows 结果 |
| owned 真宿主原整文件 | **23/23**，exit 0，failed/pending 0；host stop 返回，独占 PG 停止并移除，cleanup=true；采样回拨 0 |
| pin | 仓库函数重新计算 **66 项零差异**；本轮 #6558 未改变这两个 runtime pin，index/httpRoutes 均与最终提交内容相符 |

新证据目录：原本地工作区 `tmp/round9-publish-20261026/`，包括 `main-delta-receipt.json`、`publication-overlay.json`、`final-gates.json`、`owned-host-main-6558.json`。与 §18 的 round8 证据分开，不改名冒充新运行。

- 完整链 stdout SHA256：`577aaa99919e659cc718324cfdcdea55db1ec4fdce7d59fe623cd58276790434`。
- 前端 stdout SHA256：`986d83171ce12527d749655e56ccb38351aa1754158a283d19360b70140b70cd`。
- 宿主 stdout SHA256：`51df0d57a8e3c0ea8538faa714fa00ab1ed6a9462cf8cf24f6a146440a471ed2`。

§18 七组限定变异的受测代码保留；本节是新 main 组合复验，没有把它们重算成新变异次数，也没有宣称再次运行所有物理并发探针。原首点击超时未复现、根因未证明修复；连锁解释及全部历史失败保留。

### 19.4 发布与 CI 判定边界

满足本轮“备料线 PASS＋最终本地验证＋源字节/pin 核对”的追加发布前提。普通分支推送触发既有 PR synchronize 检查，不修改 workflow，不手工 dispatch 发布或部署。路径过滤与 job 分类须按整份 PR 相对其实际 base 判定：不能只检查 Plugin，不能把稳定 context/no-op、skipped 或旧 head 的绿算作目标步骤通过。

本地通过尚不是新提交正式 CI 的结论。之后按实际新 head 核验全分页 checks、Plugin 的锁协议/读计划宿主、继承的宜搭 owner 合同、后置 SQL、初始化/停止与独占 PG 清理；保留旧失败证据。最终 commit/run 链接以本轮 PR 更新和 CI 核验结果为准，本文不预填未发生的成功。保持草稿；未授权合并、部署、客户读取、真实 token 交换或宜搭发送，#6337 继续封存。
