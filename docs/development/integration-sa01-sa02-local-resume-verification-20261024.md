# SA-01/SA-02：本地恢复、设计与验证记录

日期：2026-10-24。范围仅为既有 #6323 / #6324；Claude 实现，Codex 独立审阅与复现。用户本次授权允许本地对齐、最小修复、合成验收，不授权推送、CI 触发、GitHub 合并、部署、客户读取或外部发送。#6337 继续封存。本记录不表示完整自助集成目标已经完成。

## 0. 本轮最终结果

**#6323 / #6324 的本轮本地对齐、最小修复及合成验收通过。** 以下阶段失败记录保留，最终结果以本节及 §6 为准。没有推送或触发 CI。

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
