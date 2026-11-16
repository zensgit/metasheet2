# iPaaS 步骤线 S1–S4：「调用连接」动作只走具名操作，加上步骤输出与转换步骤，把登记系统接进自动化规则（ADR 2026-11-16）

> **状态**：草稿 v1，尚未经过独立评审。owner 2026-11-16「都按建议」批准三件事：开「iPaaS 步骤」线（切片 S1–S4）、现在写 ADR、宜搭余下工作合并后开工——这是主会话转述的口径，开线裁定引作 R-94（owner 2026-11-16）。标「T 层默认」的条目按章程默认前进、owner 24h 内可否决；标「待 owner 裁定」的条目在 §12 汇总。**真实客户读（O ①）、生产写与外部写回（O ②③）、上机与打开开关（O ④）都不在 T 层默认之内；本 ADR 交付的全部路径都只读。**
> **线别**：以 R-94 的行文为准。冻结基线上登记册的最大行是 R-92（`decision-register.md:97`），对 `R-93`、`R-94` 的 `git grep` 在整个仓库 0 命中；本 ADR 只新增这一个文件、不改登记册，所以只引用 R-94 这个编号，不转述它的内容。它与章程「最多两条线」（R-42，`decision-register.md:51`）、与冻结设计基线「不做通用画布、任意节点调任意 API、任意代码节点」（`ipaas-yida-dev-baseline-v2.3-20261106.md:738`）的关系见 §12 OQ1。
> **基线**：main `35dc8b272`（`35dc8b272f9f0a21ad95b77e360ad901ce1625a9`）。下文所有 `path:line` 都在这个提交上核过；新增文件只写路径不写行号。开工前若 main 前进，按章程重核行号。
> **values-free**：不含主机、地址、口令、令牌、租户名、账号名或任何客户值，只指位置；「222」只是客户测试机在本目录文档里的既有代号。
> **关联**：R-42（两条线）、R-50（框定范式）、R-69 / R-83 / R-84 / R-90 / R-92（两座桥与 I 链）、R-75（BPMN 不适用）、R-87（宜搭 ↔ 任意多维表后置）、R-88（未定事项做成可配置）；`adr-automation-pipeline-bridge-20261103.md`（先例，下称「桥 ADR」）；冻结设计基线 v2.3 §10 与附录一（`ipaas-yida-dev-baseline-v2.3-20261106.md`、`ipaas-yida-dev-baseline-addendum-20261106.md`）；`adr-yida-connection-test-20261028.md`。
> **来源**：owner 要的是 n8n 那样的交付模型——一个触发器、若干调用已登记系统的步骤、步骤之间传数据、再加转换；宜搭成为这个模型的一个使用方。两条约束：只借鉴 n8n 的思路、不用它的代码；每一个副作用都走同一个宿主侧的门。

**裁决记录**

| # | 问题 | 裁决 | 层 | 落在哪里 |
|---|---|---|---|---|
| Q1 | 「具名操作」从哪来 | **不新建目录。** 读操作 = 已批准的读源配置（`integration_read_source_configs`，`draft → approved → retired`，`read-source-config-store.cjs:24-29,379-382`）；写操作 = 已批准的写目标配置（`write-target-config-store.cjs:14-20`），本线不交发送。合成目录原样不动——它自己写明「不是通往真实读取的垫脚石」（`automation-operation-catalog.ts:14-16`） | T 层默认 | §1.4、§4.2 |
| Q2 | S1 是什么 | 把运行时读路由 `readSourceConfigsRead`（`http-routes.cjs:8559-8629`）的那条链抽成接受主体上下文的 req-less 受治理入口，再由插件向 core 登记一个新端口 `ConnectionCallPort`。**一条链、两个调用方**，与桥 ADR 的 1b-i / 1b-ii 同形 | T 层默认 | §3 |
| Q3 | 读和写怎么分 | 按操作所在的目录分（读源配置 / 写目标配置），**不按 HTTP 动词**——K3 的读本来就是带体的 POST（`k3-wise-webapi-adapter.cjs:2106-2112`）。传输层「有体或非安全方法即写」的独立判定照旧成立（`http-adapter.cjs:263-272`），S3 不给它加旁路 | T 层默认 | §4.3 |
| Q4 | 本线交不交真实的外部写 | **不交。** 引用写目标配置的规则保存一律 400、与开关无关；写的设计（门的操作词、台账、围栏、owner 门）在本 ADR 锁定，发送切片另批。理由：本目录文档里记录在案的外部写目标只有宜搭（有自己的受治理路径）和 K3（永久禁止），而章程规定通用能力不预先建设 | 待 owner 裁定（§12 OQ2） | §4.3、§7.9、§11 |
| Q5 | 运行身份 | 授权主体 = 规则创建者 + 其唯一在役租户，保存时由服务端盖章、每次触发实时复核；保存 / 启用 / 重试的操作者自己也要过同一道检查（沿用 R-92 的 B1 与 R1–R3，`automation-service.ts:238-260,291-322`）。数据面读身份 = 绑定主体本人 | T 层默认 | §4.5 |
| Q6 | 哪些触发器可以带 `call_connection` | 首片只有 `schedule.cron`（必带 IANA 时区）与 `schedule.interval`（≥ 15 min）；规则不得带条件；只在顶层、不进分支。记录事件与入站 webhook 触发待裁 | T 层默认（放开 = §12 OQ4） | §4.4 |
| Q7 | 步骤之间的数据走哪 | 独立的运行内通道（把合成片的 `RunValueStore` 一般化，`automation-run-values.ts:118-204`）；`step.output` 只放宿主从枚举与计数重建的摘要。原因：日志面只擦密钥形的值、**保留业务字段值**（`core-backend/src/multitable/automation-log-redact.ts:16-21`，`automation-log-service.ts:340-346`） | T 层默认 | §5 |
| Q8 | 持久化什么 | 只在必须时落快照：执行即将挂起、且后面的步骤引用了已产生的输出。脱敏、限长、带到期、执行终结即删。其余输出只活在内存里 | T 层默认 | §5.4 |
| Q9 | 续跑与重试 | 续跑从快照重建通道，逐条核对步骤身份与输出声明；被脱敏的单元格一经引用即失败关闭，绝不把占位符发出去。整次重试不恢复读输出——读步骤重读 | T 层默认 | §5.5 |
| Q10 | 转换步骤 | 新动作 `transform_records`：纯函数、零 IO，宿主在 core，把 `transform-engine.cjs` 当作单个纯函数注入（`yida-automation-preview.ts:148-194` 的做法） | T 层默认 | §6 |
| Q11 | 宜搭 v3 映射怎么「表达在它上面」 | 编译成转换步骤的映射规格 + 两个闭合扩展函数；**静态规划器仍是权威**，发送路径不读转换步骤的产物；对拍是合并门，运行时也双跑比对（影子模式） | T 层默认（备选见 §12 OQ6） | §6.3 |
| Q12 | 出网守卫 | 现有两套守卫都是「只许 https + 禁内网」（`webhook-ssrf-guard.ts:98-114`，`egress-guard.ts:149-187`），而登记系统按设计允许 http 与内网（`http-adapter.cjs:67-76`），不能套用。本线的围栏是：目的地只能是已登记系统的 origin + 已批准配置里的路径、不跟随重定向、换源强制重绑凭据 | T 层默认 | §7 |
| Q13 | 开关 | 三个新 env 开关，默认关、只认原文 `true`、登记 flag manifest；其中写开关只登记不读 | T 层默认（打开 = O 层） | §7.8 |
| Q14 | 真实客户读怎么放行 | O ①：开关、读源配置的批准、B2a 的新用途登记（部署已武装时）、每个系统 / 操作逐项由 owner 批 | O | §7.9、§8 |
| Q15 | 哪些切片可以交给外部构建者 | 只给前端配置面与纯函数的测试语料；门、凭据、锁、台账、授权、迁移一律不给 | T 层默认（交出去这个动作 = §12 OQ7） | §10.4 |

---

## 0. 为什么

1. **规则今天拿不到外部系统的一个值。** 两座桥（R-69）把两台引擎在「作业」这一层接上了，但 `run_integration_job` 必须是规则里唯一的动作（`automation-run-integration-job.ts:241-249`），端口只回 values-free 摘要（`integration-run-port.ts:57-66`）；执行上下文里没有任何步骤结果（`automation-executor.ts:1614-1640`），模板数据只由记录与触发事件组成（`:1438-1447`）。「读一下登记系统 → 用读到的值做下一步」这件事没有落点。
2. **零件其实都在，只是散着。** 已批准的读配置与只收业务键的运行时路由（§1.4）、出站写门与 K3 永久围栏（§1.2）、凭据库（§1.3）、带尝试令牌的意图台账（§1.6）、运行内传值容器（§1.8，只服务合成片）、转换引擎与宜搭规划器（§1.7）。本线做的是接线，不是新建。
3. **借思路、不借代码。** 许可与围栏两条理由沿用桥 ADR 附录（`adr-automation-pipeline-bridge-20261103.md:411-415`）；本 ADR 没有重新核对 n8n 的许可文本与节点行为，见文末附注。
4. **一个门。** 新步骤的每一次出网都只有一条路：core 动作 → 端口 → 插件受治理入口 → 适配器传输层。动作代码里不出现第二个 HTTP 客户端，这一条由 CI 的静态扫描钉住（§7.10 的 G2）。

## 1. 现状与约束（读码结论）

### 1.1 自动化引擎

- **动作与触发器闭集**：动作 17 种（`automation-actions.ts:6-38`，`ALL_ACTION_TYPES :40-58`），动作对象只有 `{ type, config }` 两个键（`:311-314`）；触发器 12 种（`automation-triggers.ts:6-18`）。新动作类型要改 DB CHECK，最近一次是 `zzzz20261106111300_add_run_integration_job_automation_action.ts:14-39`（沿用 `zzzz20260720120000_add_write_approval_form_values_automation_action.ts:28-43` 的形式）。**CHECK 只约束 `action_type` 这一列**；`actions` 列是没有约束的 jsonb（`zzzz20260414100000_extend_automation_rules.ts:26-27,51-58`），多动作规则由编辑器把 `actions[0]` 镜像进这一对旧列（`automation-run-integration-job.ts:221-225`）。
- **执行**：`execute` 用触发事件构造上下文（`automation-executor.ts:2113-2127`），`executeActions` 顺序执行、第一步失败就把其余标成 `skipped`（`:2426-2432,2606-2618`），分发是一个 `switch`（`:2998-3079`）。`ExecutionContext` 的字段是执行 / 规则 / 表 / 记录标识、记录数据、触发事件与台账身份（`:1614-1640`）——**没有步骤输出**。
- **模板**：`renderAutomationTemplate` 用正则 `[\w.]+` 取路径（`automation-executor.ts:330-334`），`lookupTemplateValue` 逐段取属性、遇到数组即返回 undefined、不防原型链（`:309-317`）。模板数据在七处各自组装（`:1189,1246,1317,1438,5923,6602,7274`），来源都是记录、标识与触发事件，外加从触发事件里取出的作业摘要（`:1891-1896`）。
- **步骤身份**：结构路径是下标（顶层 `"0"`，分支子步 `"${i}.branch.${k}.${j}"`，`automation-step-key.ts:22-29`），分支键允许 `-`（`automation-service.ts:712`）。动作身份 = (结构路径, 动作类型, sha256(规范化配置)[:16])（`automation-action-idempotency.ts:58-64`）；规则指纹对每个动作取这个身份再汇总（`automation-rule-fingerprint.ts:102-112`）。
- **三个会落值的面**：执行日志的 `steps` / `trigger_event` / `rule_snapshot` 经 `redactValue` 落库（`automation-log-service.ts:334-361`）；作业面的 `result` 同样经 `redactValue`（`automation-job-service.ts:79,212`）；HTTP 响应用同一个函数（`automation-log-service.ts:415-423`）。`redactValue` 只擦密钥形的字符串与认证类键名，文件头明写「业务字段值保留供诊断」（`core-backend/src/multitable/automation-log-redact.ts:16-21,121-143,162-179`）。
- **试运行**：`simulationDisposition` 是带 `never` 穷尽检查的 `switch`（`automation-executor.ts:1010-1035`），模拟模式下落库的步骤被压成 `{ dryRun, dispatched:false }`（`automation-service.ts:443-461`）；真发测试只放行 A / B 两族与五个控制动作，其余一律 `TEST_RUN_ACTION_UNSUPPORTED`（`automation-retry-eligibility.ts:18-39,61-87`）。
- **挂起与续跑**：`wait_for_callback` / `start_approval` 挂起（`automation-executor.ts:2457-2508`）；续跑从日志表读回执行、重建上下文——记录重新读、触发事件用落库的脱敏版、前序步骤只剩日志里的脱敏结果（`automation-service.ts:4914-4952`；`automation-suspension-service.ts:13-14` 的 D4）。续跑前的规则漂移守卫只比动作**类型**序列（`automation-service.ts:4843-4847`）。
- **整次重试**：`retryExecution` 用落库的触发事件对当前规则从第 0 步重跑（`automation-service.ts:4784-4788`），规则配置变了即 `RULE_CHANGED`（`:4697-4712`）；已发送的 B 类步骤得到的是不带输出的 `alreadyApplied`（`automation-executor.ts:4137-4139,4149-4165`）。
- **保存门**：`createRule` 里一串逐类校验（`automation-service.ts:1914-2009`），触发器专用的动作白名单（`:500-512,621-624`）、并行分支白名单（`:713`）、条件分支的嵌套限制（`:1229-1296`）；按钮路由有自己的闭合动作表，表外类型答 `BUTTON_ACTION_NOT_ENABLED`（`multitable-button.ts:99-109,170-173`）。

### 1.2 数据工厂：管道、http-adapter 与出站写门

- **适配器登记**：九个连接器种类在激活时登记（`plugin-integration-core/index.cjs:425-433`）；`createAdapter(system, deps)` 把 `deps` 原样交给工厂（`lib/contracts.cjs:223-236`），`http` / K3 / bridge 三个适配器都接受注入的 `fetchImpl`（`http-adapter.cjs:228`，`k3-wise-webapi-adapter.cjs:1781`，`bridge-agent-readonly-adapter.cjs:308`）。
- **http-adapter**：`baseUrl` 允许 http 与 https、不限内外网（`http-adapter.cjs:67-76`）；路径必须是相对的、被补上前导 `/`（`:78-90`），`buildUrl` 用 `new URL(path, baseUrl)` 解析（`:127-131`）——**以 `/` 开头的路径从 origin 根解析，`baseUrl` 自带的路径前缀不参与拼接**。`fetch` 调用没有 `redirect` 选项、即默认跟随（`:292-297`）；K3 与 bridge 适配器同样（`k3-wise-webapi-adapter.cjs:1844-1849`，`bridge-agent-readonly-adapter.cjs:329-334`）。`http-adapter` 的 `testConnection` 的 `path` / `method` 直接取自请求体（`http-adapter.cjs:350-369`）。
- **出站写门**：默认拒绝，只认部署文件 `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS`（`outbound-http-write-gate.cjs:142`），按**声明的身份**（系统 id / 名称 / 种类 + 对象 + 操作）匹配、从不按 URL（`:476-486`；URL 形的键在加载时按名拒绝 `:241-246`）。操作词是闭集 `{upsert, request}`（`:187-197`），**未知操作默认拒绝**，条目缺省只授权 `upsert`（`:370-372`）。策略不可传参：门自己读 env，调用方只给主体、不给策略（`:59-77`）；不缓存（`:88-90`）。两个强制点互相独立：`upsert` 的第一条语句（`http-adapter.cjs:440-454`）与传输层 `requestJson`（`:263-277`，有体或方法不在 GET / HEAD / OPTIONS 即为写，`outbound-http-write-gate.cjs:203,219-222`）。
- **K3 永久围栏**：按连接器种类判定、四层各自拒绝、无参数无 env（`k3-external-write-permanent-fence.cjs:16-35,99-107,118-121`）。它**不覆盖**一个 `baseUrl` 恰好指向 K3 的通用 `http` 系统——那个洞由写门补（`outbound-http-write-gate.cjs:27-31`）。
- **runner**：通用 HTTP 目标的非试算写在 runner 层先过写门（`pipeline-runner.cjs:518-519`），C6 生命周期在第一行（`:714,950`），转换在 `:814`，唯一的 `targetAdapter.upsert` 在 `:1112`。
- **受治理入口（1b-i）**：只有两个——`runGovernedStockPrepPull` 与 `runGovernedPipeline`（`http-routes.cjs:7936,8147,15971-15972`）；主体上下文恰好是请求上的六个字段（`:2131-2145`）；中止 / 检查点的接缝在 `governed-entry-checkpoint.cjs:69-110`，「两者都不传 = 行为不变」。

### 1.3 外部系统与凭据库

- **登记表**：`integration_external_systems`（`external-systems.cjs:21`）；`kind` 与 `role` 创建后不可改（`:837-845`）；`config` 的更新是对存量的顶层 PATCH（`:407-410,850-854`）；服务端独占的键 `dataSourceOwnerId` 由登记处盖章、客户端值被丢弃（`:30-34`）。
- **凭据**：写入时整体加密进 `credentials_encrypted`（`external-systems.cjs:412-422,816`），对外响应只给 `hasCredentials` 与指纹（`:286-311`）。解密点：`git grep -n "\.decrypt(\|parseAdapterCredentials("` 在插件的非测试代码里命中外部系统凭据的两处——适配器加载路径（`:363-373,1093`）与 `gip-system-identity-read.cjs:502`（后者的上下文没有读）；规则与路由处理器都拿不到明文。新值用宿主安全服务的 `enc:` 格式，旧的 `v1:` 仍可读；生产环境缺密钥即拒绝启动（`credential-store.cjs:20-22,62-71,149-182`）。
- **换源不换凭据**：更新时不带 `credentials` 即保留旧密文（`external-systems.cjs:913-915`），而同一次更新可以改 `config.baseUrl`（`:850-854`）——**旧凭据会跟着新 origin 走**。`git log 35dc8b272 -i --grep="S0-b"` 0 命中；提交说明里含 `rebind` 的提交没有一个改登记处的凭据逻辑（其中两个是 webhook 守卫 #5619、#5649）。结论以上面两处代码为准。
- **删除 × 指针写的锁协议**：读源配置、管道等四类指针写入方先对系统行取 KEY SHARE，删除方 FOR UPDATE 后计数（`external-system-pointer-lock.cjs:15-28`）。它管的是悬挂引用，不管换源。
- **另一条 HTTP 路径（不是 S1 的底座）**：core 的 `data_sources` 有自己的 `HTTPAdapter`，`insert` 直接 `client.post`（`HTTPAdapter.ts:428-435`），凭据键含 `bearerToken`（`DataSourceManager.ts:33`）。谁能到达它的写方法本 ADR 没有审计（文末附注）；S1 不建在它上面，也不得把它当传输。

### 1.4 具名读已经存在：读源配置；写目标配置只到静态预览

- **两层模型**：顾问写配置并批准，运行时层只消费**已批准**的配置、只提供配置声明的那一个具名业务键，「从不给原始端点、过滤条件、请求体或响应路径」（`read-source-read-runtime.cjs:5-10`）。四种读模式、GET / POST 两种方法（`read-source-config.cjs:27-28`）；路径守卫拒绝 scheme、`//`、反斜杠、`..` 与一切百分号编码（`:98-116`），执行时再查一次（`read-source-read-runtime.cjs:393-395`）。
- **版本与生命周期**：每一行是一个按内容定键的版本（`read-source-config-store.cjs:102,244-258`），状态只走 `draft → approved → retired`（`:24-29`），运行时查找只认 `approved`（`:379-388`）。
- **运行时路由**：`POST /api/integration/read-source-configs/:id/read`（`http-routes.cjs:37`）。处理器的顺序是：`requireAccess(req,'read')`（`:8560`）→ 请求体严格只许 `inputs` 与 `rowSource`（`:8563-8584`）→ 取已批准配置（`:8587`）→ 用后端凭据上下文加载系统并比对种类（`:8599-8603`）→ `executeConfiguredRead`（`:8605-8612`）→ 返回 `{ evidence, data }`，其中 `evidence` 是 values-free 的、值只在 `data` 下（`:8613`）。输入是闭集 `{ key, pageIndex }`（`read-source-probe-runtime.cjs:84-118`），请求由配置拼出、调用方的键只落在预定的位置（`:172-199`）。
- **界限**：行数上限 1000、页号上限 10（`read-source-read-runtime.cjs:45-46`）；超时是平台常量 5 秒、不可由请求改（`read-source-probe-contract.cjs:19`，`read-source-read-runtime.cjs:379-382`）；**超时只是放弃等待，不中止底层请求**——适配器接口不收 signal（`:417-422`）。达到行上限时证据里有 `capReached`（`:359`）——行数**恰好等于**上限也算，它分不出「刚好这么多」与「还有更多」。数据面按容器别名组织（`primary` / `header` / `lines`，`read-source-probe-contract.cjs:23`；`read-source-read-runtime.cjs:361-364,530-533`），另有一个不可枚举的内部页对象只给受信的后端调用方（`:534-543`）。
- **写目标配置**：模型与存储已有（`write-target-config.cjs:12-28`，`write-target-config-store.cjs:14-20`），运行时只有**零网络的静态预览**，`canApply` 被有意做成不可达（`write-target-dry-run-runtime.cjs:6-30`）。存储是休眠的：登记处的注释写明「除 `__tests__/` 外没有任何地方实例化它，生产库里没有行」，并且接活它的那一刻必须把它计入系统删除守卫（`external-systems.cjs:70-73`）。`git grep -n -i "write-target\|writeTarget"` 对 `http-routes.cjs` 与插件的 `index.cjs` 0 命中：没有任何路由。
- **潜伏的动作契约**：`connector-action-contracts.cjs` 把「连接器动作」定义为围绕**已有适配器方法**的元数据、写操作一律 `gated`（`connector-action-contracts.cjs:3-7,11-20,214-237`）；除它自己的测试外没有调用方（`git grep -n "connector-action-contracts"` 只命中 `package.json`、`test-chain.txt`、一处注释与测试文件）。
- **B2a 读围栏**：用途是闭集（`b2a-trial-registry.cjs:205-218`），未登记的入口在已武装的部署上默认拒绝（`:1206-1213`），env 未设即休眠（`:16-21`）。**配置读不在围栏内**：`git grep -n "assertB2a\|b2aRegistry\|b2aTrialRegistry"` 在插件 `lib/` 的非测试代码里只命中六个文件（围栏模块自身、`http-routes.cjs`、`pipeline-runner.cjs`、备料的表动作与预检、SQL 只读源适配器）；`read-source-*` 各文件一处也没有，`external-systems.cjs` 里只有注释。`http-routes.cjs` 里三个守卫函数的调用行是 5183、7107、7335、7356、7421、7459、7466、8041、9023、9168、9478、9600、9762、9974、15763，没有一行落在配置读处理器的 `http-routes.cjs:8559-8629` 之内。SQL 只读源适配器只在调用方把授权对象随 `createAdapter` 传进来时才加两条下限（`data-source-sql-readonly-source-adapter.cjs:614-622`），配置读不传（`http-routes.cjs:8609`）。

### 1.5 出网守卫：两套，都不适用于登记系统

- 规则里的 `send_webhook`：只许 https、拒内网名与内网地址、解析后钉住地址、不跟随重定向（`webhook-ssrf-guard.ts:98-135`；用法 `automation-executor.ts:5333-5341,5552-5557`）。
- `guards/egress-guard.ts`：只许 https、必须有主机白名单（`egress-guard.ts:149-187`）；使用方是 BPMN 的 HTTP 任务与 AI 路由（`BPMNWorkflowEngine.ts:17-18`，`ai-routing-policy.ts:60`）。
- 插件里没有 SSRF / 出网模块：`git grep -n -i "ssrf\|egress\|isInternal" -- plugins/plugin-integration-core/lib` 只命中注释与上面那个路径守卫。宜搭的三个传输各自用 `redirect: 'error'`（`yida-form-transport.cjs:241`，`yida-token-exchange.cjs:173`，`yida-form-readback.cjs:344`）。

### 1.6 意图台账

- 两阶段：意图行先提交、带尝试令牌与租约（`automation-outbound-intent.ts:9-24,298-332`），结果写以 `status='pending' AND attempt_token=自己的` 为围栏并告诉调用方是否落地（`:342-365`）；`failed → pending` 的重武装是按行数裁定的 CAS（`:251-260`）；过期的 `pending` 只在令牌相符时翻成 `outcome_unknown`（`:203-214`）；租约可按令牌续期（`:376-394`）。
- 分类：2xx = sent；DNS / 拒连 / TLS 握手 = failed（可重试）；其余一律 `outcome_unknown`，包括每一个 4xx（`automation-outbound-intent.ts:488-497`）。执行器只把 `skip_sent` 当成功，`skip_unknown` / `skip_inflight` 是停下后续步骤的失败步（`automation-executor.ts:4149-4165`）；步骤只在自己的终态写落地时才报成功（`:4174-4186`）。

### 1.7 转换引擎与宜搭规划器

- **transform-engine**：八个固定转换（`transform-engine.cjs:10-19`），文件头写明永不执行配置里的 JavaScript（`:6-7`）；整个文件没有 `require`（`grep -n "require(" plugins/plugin-integration-core/lib/transform-engine.cjs` 0 命中）。`transformRecord` 逐映射取值、转换、写入目标路径，错误按字段收集（`:213-255`）。两处要留意：读路径不防原型链（`:34-41`，写路径才防 `:54-63`）；错误的 `details` 带原值（`:96,104,164`）。
- **宜搭 v3 映射已经在规划器里**：五种转换 `direct / copy / constant / concat / generated`（`yida-static-plan.mjs:256-262`），`concat` 有 `skip / refuse` 两种空值规则（`:690-707`），`generated` 是封闭部件模板（`:268-288,719-764`）；按字段目录顺序求值、逐字段校验类型与选项（`:774-807`）；业务键、键重复与生成值重复都在批次层裁定（`:813-822,944-967`）。规划器只导入 `./yida-material-code.mjs`（`:4`），附录一把这一条定为导入钉子（`ipaas-yida-dev-baseline-addendum-20261106.md:28`）。
- **编译与摘要**：`compileYidaLocalDraft` / `compileYidaSendDraft` / `compileYidaDraft` 是同一个编译器的三个入口（`yida-draft-compiler.mjs:188-203`），输出行摘要与计划摘要（`:158-176`）。core 的合成预览只注入其中一个纯函数（`yida-automation-preview.ts:148-194`），并写明预览结果不是授权、发送路径会自己重算（`:9-12`）。

### 1.8 操作目录（合成）与运行内传值（C1 / S2 首片，已在 main）

- 目录是代码资产：一个计划、一个具名只读操作、固定夹具、消费方白名单与预算（`automation-operation-catalog.ts:19-23,37-43,263-285`）；预览步骤类型**故意不进** `ALL_ACTION_TYPES`（`:26-33`）；请求只能选固定 id（`:332-350`）。
- `RunValueStore`：每次运行一个、只收声明列上的有限 JSON 标量、发布后冻结、句柄只在本容器内有效、只有前序已成功的步骤可被引用（`automation-run-values.ts:139-186`）；上限 1 万行、单字符串 1 MiB（`:76-77`）；**不持久化、不续跑、不跨运行**（`:5-6`）。
- 落库的是宿主重建的摘要行，入参类型本身就装不下值（`automation-log-service.ts:139-187`）。开关 `AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED`（`automation-synthetic-preview.ts:101-106`；清单 `global-history-flag-manifest.mjs:1021-1030`）。

### 1.9 I 链（R-69，已在 main，只试算、开关默认关）

- 动作 `run_integration_job`：意图 → 带 fence 的心跳租约 → 端口 → 落定后带围栏的结果写（`automation-executor.ts:4188-4211,4390-4594`）；只能是规则的唯一动作、不得带条件、只许 `schedule.cron`（`automation-run-integration-job.ts:178-207,241-249`）；绑定由服务端盖章（`:148-158`）。
- 端口：插件 → core 方向、按插件名记 owner、缺席即失败关闭（`integration-run-port.ts:79-81,132-156`；宿主接线 `core-backend/src/index.ts:3710-3718`、解绑 `:1838-1841`；插件登记 `plugin-integration-core/index.cjs:643-647`）。主体上下文由 core 在一个先提交的 RC 事务里从实时 RBAC 构造，权限码走请求路径的同一个解析器（`automation-run-authority.ts:51-114,123-142`）。
- 四个开关已登记（`global-history-flag-manifest.mjs:1034-1076`），其中两个「只登记不读」，名字写在源码里以通过清单的幽灵检查（`automation-run-integration-job.ts:45-48`）。

### 1.10 S1–S4 缺什么（每条附搜索）

1. **没有「调用连接」动作**：在基线提交上，`git grep -n "call_connection"` 对整个仓库（含 docs）0 命中。
2. **配置读没有 req-less 入口**：受治理入口只有两个（`http-routes.cjs:15971-15972`），读源配置的读只能经 HTTP 路由到达。
3. **没有能把值带回 core 的端口**：现有端口的返回是闭合的 values-free 摘要，多余的键被丢弃（`integration-run-port.ts:90-117`）。
4. **没有步骤输出与 `steps.*` 模板**：`git grep -n "steps\.\(\w\+\)\.output\|{{steps\|stepOutputs" -- packages/core-backend/src apps/web/src` 0 命中；运行内容器只服务固定的合成计划（§1.8）。
5. **没有转换动作**：`git grep -n "'transform_records'\|'transform_step'" -- packages/core-backend/src/multitable` 0 命中；转换引擎的调用方全在插件里（`pipeline-runner.cjs:5`，`external-write-dry-run.cjs:9`，`http-routes.cjs:498` 等）。
6. **适配器不拒重定向、换源不重绑**（§1.2、§1.3）。
7. **没有代码沙箱**：`git grep -n -i "quickjs\|isolated-vm" -- packages plugins apps` 0 命中。这一项不在本线（§11）。

### 1.11 线索与代码的五处不一致（代码为准）

1. **「S4 = 把宜搭规划器搬到 transform-engine 上，补 #6711 的缺口」**：那几种转换已经由 v3 在规划器内部实现（§1.7），而规划器带导入钉子、还要在浏览器里跑，**不能反过来依赖引擎**。所以 S4 不是搬家，是对拍。→ Q11。
2. **「要为真实读新建一个具名操作目录」**：已批准的读源配置就是具名、有版本、有批准流的读操作，而且已有只收业务键的运行时路由（§1.4）。→ Q1。
3. **「出网守卫可以复用」**：两套守卫都拒 http 与内网（§1.5），登记系统两者都要。→ Q12。
4. **「S0-b 之后适配器已经拒重定向、换源会重绑」**：在本基线上都不成立（§1.2、§1.3）。那项工作在另一条线，状态见文末附注。→ §7.3、§7.5、OQ5。
5. **「台账的重武装不看行数、结果写不验尝试身份」**：已由 #6715 修正（§1.6）。本线直接依赖修正后的语义。

## 2. 决策清单（锁定）

① **具名操作 = 一个已批准的配置版本。** 规则里存的是引用 `{ kind, configId, contentKey }`，不是端点。规则作者只能在已批准的版本里选，不能写路径、动词、请求头或请求体；配置由持 `integration:write` 的人写并批准（`http-routes.cjs:8474-8477,8528-8529`），这是「谁能让系统访问哪个端点」与「谁能把它排进规则」两件事的分界。

② **core 持动作，插件供端口。** 动作类型、保存校验、身份绑定、步骤结果、运行内通道在 core；读本身——授权链、配置查找、凭据加载、适配器调用——留在插件，只经插件激活时登记的端口到达。新端口叫 `ConnectionCallPort`，**不复用** `IntegrationRunPort`：后者的返回值是闭合的 values-free 摘要（`integration-run-port.ts:57-66,90-117`），把数据面塞进去就破坏了它唯一的性质。

③ **一条链、两个调用方。** HTTP 路由与端口调用同一个 req-less 受治理入口；不得出现「端口版」的第二套检查，插件不得对收到的主体上下文加宽、补默认或另读权限（桥 ADR §2 ③ 的原话，这里照用）。

④ **本线只读。** 端口上没有写方法；引用写目标配置的规则保存即 400、不读任何开关；写开关只登记不读。这是结构上的，不是靠开关关着。

⑤ **步骤数据不进日志。** 步骤产生的值只进运行内通道；`step.output` 由宿主从枚举与计数重建，键集闭合。引用语法是闭集（§5.2），解析器是新写的严格函数，不复用 `lookupTemplateValue`。

⑥ **只在必须时持久化，恢复时逐条核对。** 快照只为跨挂起的引用而写；恢复不信任快照——步骤身份或输出声明对不上即拒绝续跑；被脱敏的单元格被引用即失败关闭。

⑦ **转换是纯函数；宜搭的权威不搬家。** `transform_records` 没有 IO。宜搭 v3 在它上面有一份等价表达，但发送路径继续用规划器自己编译；两者不一致时错的是转换步骤，并且会让步骤失败、不会静默通过。

⑧ **围栏不靠 URL 检查。** 目的地只能是已登记系统的 origin；路径只来自已批准配置；步骤数据只能填配置声明的业务键；不跟随重定向；换 origin 必须重绑凭据；K3 写永久拒绝；出站写门不加任何旁路或新参数。

⑨ **三个开关**（§7.8）：连接调用、连接调用的写（只登记）、步骤输出与转换。保存时与每次触发时都读原文；关着的动作在触发时记 `skipped(action_disabled)`，不静默成功。

⑩ **词表与表的变化**：动作 CHECK 增 `call_connection`、`transform_records`（各一支迁移，形式同 `zzzz20261106111300…:14-39`）；新表 `meta_automation_step_outputs`（S2-b）；B2a 用途闭集增一项（`b2a-trial-registry.cjs:205-218`）。**出站写门的操作词表在本线不动**（`outbound-http-write-gate.cjs:194-197` 仍是 `upsert`、`request` 两项，由测试钉死）。

⑪ **首片的放置限制**（都在保存时校验）：新动作只在顶层、不进任何分支；规则不带条件；触发器只许两种定时；不与 `wait_for_callback` / `start_approval` 同处一条规则（S2-b 交付后解除这一条）；不上按钮路由；真发测试不支持。每一条限制都写明解除它的切片或问题编号，不留「以后再说」。

## 3. S1：连接请求服务与 req-less 受治理入口

### 3.1 受治理入口 `runGovernedConfiguredRead`（切片 S1-a，只重构）

把 `readSourceConfigsRead`（`http-routes.cjs:8559-8629`）的整条链原样抽成接受主体上下文的函数，签名与两个既有入口同形：`(principalContext, { configId, inputs, rowSource }, options?)`。链上的每一步都不变、顺序不变：读层权限 → 请求体闭合校验 → 只取已批准版本 → 准备读计划 → 用后端凭据上下文加载系统并比对种类 → 执行 → `{ evidence, data }`。`runAs:'user'` 仍由入口内部的 `scopedAdapterInput` 盖（`:1832-1838`），调用方盖不了。

- HTTP 处理器改成「用 `req` 构造上下文（`http-routes.cjs:2138-2145`）后调用、不传 `options`」。**对外逐字节不变**：请求形状、状态码、成功体、错误体都不变，以既有路由测试加一组失败路径的响应体快照为验收。
- `options` 至多四个可选成员，**全部缺省就是今天的行为**（HTTP 处理器一个都不传），没有一个能放宽什么：
  - `signal`、`checkpoint`：既有接缝，在加载凭据之前、每次出站读之前各过一次检查点（`governed-entry-checkpoint.cjs:94-110`）；都不传时不多一个 await（`:69-88`）。
  - `transport: 'strict'`：一个闭合的枚举值，只能收紧。适配器是在入口自己的闭包里建的（`http-routes.cjs:8609`），执行器只带一个参数调用它（`read-source-read-runtime.cjs:400-401`），所以 §3.2 的传输包装只能由入口装上；调用方给的是这个字面量，**给不了函数**。
  - `readPurpose`：一个 B2a 用途常量，只能多加一道围栏（§3.2）。
- 入口加入 `governedEntries` 的冻结导出（`http-routes.cjs:15971-15972`）。s6a 的 `pluginHttpRoutes` 来源 pin 必须重算（`s6a-package-provenance-pins.json:73`）。

### 3.2 连接调用服务 `lib/connection-call-service.cjs`（切片 S1-b）

这是「同一个宿主侧的门」在插件里的实体：端口的每次调用都从这里进，再进 3.1 的入口。它决定入口那四个可选成员怎么填，并负责**只对自动化调用方成立**的那几件事：

- **读开关**：`INTEGRATION_AUTOMATION_CALL_CONNECTION_ENABLED` 在出站之前再读一次原文（第三个读取点，§7.8）。
- **准入的连接器种类是闭集**：首片 `http`、`erp:k3-wise-webapi`、`bridge:legacy-sql-readonly`（三者的适配器都接受注入的 `fetchImpl`，传输包装因此装得上，见下一条）与 `data-source:sql-readonly`（不走 HTTP，凭据在规范连接里，`external-systems.cjs:1065-1091`）。表外种类记 `skipped(kind_not_admitted)`。`plm:yuantus-wrapper` 的传输在宿主的 PLM 能力里，本 ADR 没有核它的重定向行为，核实之前不纳入。加一个种类 = 改这张表的源码 + 一条传输评审。
- **不跟随重定向、只去登记的 origin**：服务调用入口时固定传 `transport: 'strict'`，入口据此在 `createAdapter(system, { principal, fetchImpl })` 里装上一个包装（`lib/contracts.cjs:223-236` 把 `deps` 交给工厂），它只做两件事。一，给每次请求加 `redirect: 'manual'`：3xx 于是作为普通的非 2xx 回到适配器并被拒绝，本服务把它归为 `failed(redirect_refused)`，不发第二个请求。二，发出前断言请求 URL 的 origin 等于登记系统 `baseUrl` 的 origin：按今天的代码这由构造成立（相对路径 + `new URL`，§1.2），断言把它从「碰巧」变成「被检查」。管道与 HTTP 路由不经过本服务，行为不变。
- **基路径不是围栏**：`baseUrl` 的路径前缀不约束解析结果（§1.2 的事实），本线不改解析规则——改了会让既有的已批准配置指向别处；围栏是 origin 加已批准的路径。
- **B2a**：服务固定传 `readPurpose` = 新的闭合用途 `automation.call-connection.read`；入口在取到配置行、知道系统 id 之后、加载凭据之前，以它向 `assertB2aReadAuthorization` 出示。需要看系统配置时用不解密的那个访问器，它就是为「必须先于凭据加载的守卫」准备的（`external-systems.cjs:1020-1035`）。休眠部署返回 `null`、字节不变（`b2a-trial-registry.cjs:1192-1197`）；已武装而无登记即拒绝。键怎么填（数据范围取配置 id 还是对象名）留给 S1-b 评审——本 ADR 只读了该模块的头注释、用途表与守卫签名。
- **在途上限**：同一 (租户, 系统) 同一时刻至多一个在途调用，进程内计数；多出来的记 `skipped(busy)`。槽位在底层读**落定**时才释放，不是在 5 秒超时返回时——超时不中止请求（§1.4）。部署是 pm2 单 fork（`ecosystem.config.cjs:60-61`）；多实例时这条不成立，要换成库里的租约（§11）。
- **两个面分开回**：`evidence` 原样是配置读自己的 values-free 证据；`data` 是唯一带值的成员。错误只回闭合的类别——适配器错误的 `details` 可能带响应体（`http-adapter.cjs:329-336`），不出本服务。

### 3.3 端口契约（`packages/core-backend/src/core/connection-call-port.ts`）

```
ConnectionCallPort = {
  describeRead({ context, operation })            // 保存时用：零出站、不解密凭据
    -> { ok: true, systemId, requiredKind, contentKey, mode, requiredNamedInputs, columns[] }
     | { ok: false, reason }                      // 闭集，见 §4.8
  callRead({ context, operation, inputs, rowSource?, signal, checkpoint, automation })
    -> { status, reason?, errorClass?, evidence, capReached, durationMs, data?: { columns[], rows[] } }
}
```

- 登记与解绑照 `IntegrationRunPort`：`context.services.connectionCall.register(port)` 只对 `plugin-integration-core` 开放，按插件名记 owner，卸载 / 重载即解绑，缺席即 `port_inactive`（`integration-run-port.ts:132-156`；`core-backend/src/index.ts:3710-3718,1838-1841`）。
- **键集恰好这两个方法**，由测试按集合相等钉住：没有写、没有 `testConnection`、没有「按路径请求」。
- 服务只取数据面的 `primary` 容器组成 `rows`；**首片只接受数据面是单个 `primary` 容器的读模式**，`detail_with_lines`（表头与明细两个容器）在 `describeRead` 时即拒，等输出模型支持一步多输出再议。
- 每一行恰好是声明列的全集：配置读的投影把解析不到的目标写成 `null`、不省略键（`read-source-read-runtime.cjs:148-166`），而运行内通道要求一行的键数等于声明列数（`automation-run-values.ts:94`）。
- core 对返回值再消毒一次：未知键丢弃；`data.rows` 逐行投影到 `columns` 上，只收有限 JSON 标量（规则同 `automation-run-values.ts:88-112`）；投影失败是 `failed(output_not_scalar)`，不是「尽量收」。
- `describeRead` 做的是入口链的前半段：读层权限、已批准版本查找、系统存在与种类准入；`columns` 取自配置的 `fieldMap` 目标。它让保存时与运行时用**同一条**插件侧授权链。I 链的操作者检查用的是 core 侧谓词，作业权限本身留在插件入口里（`automation-run-authority.ts:16-18`），登记册把「保存时检查不含插件权限梯」记成了开开关的前提（R-92 的 11-13 补记，`decision-register.md:97`）；这个差距在这里不重复。

### 3.4 S1 不做的事

不加写方法；不把管道改到新服务上（管道继续直接用适配器登记表，两边共享的是适配器传输层的写门与 K3 围栏）；不改 `http-adapter.cjs` 的解析规则与默认重定向行为（那是对所有调用方的行为变更，归 §7.3 与 OQ5）；不接 core 的 `data_sources` HTTP 适配器（§1.3）。

## 4. S3：动作 `call_connection`

### 4.1 配置形状（闭合键集，保存时逐键校验，执行时重新解析）

```
{ stepKey?,                                        // §5.1；不带则只报计数、不发布输出
  operation: { kind: 'read_source_config', configId, contentKey },   // contentKey 由服务端盖章
  inputs:    { key?: string | '{{steps.<k>.output.first.<列>}}', pageIndex?: 1..10 },
  rowSource?: 'raw_containers' | 'adapter_records',
  connection: { systemId },                        // 服务端从配置行盖章，仅供展示与在途上限的键
  output:     { columns: string[] },               // 服务端从 describeRead 盖章
  binding:    { principalId, tenantId } }          // 服务端盖章，客户端值丢弃
```

- 除此之外的任何键 → 保存 400。**负对照必须逐个有测试**：`url`、`baseUrl`、`host`、`path`、`method`、`headers`、`body`、`query`、`timeoutMs`、`credentials`。超时不是配置项：它是配置读的平台常量（§1.4）。
- `operation.kind` 是闭集 `{ read_source_config, write_target_config }`。**`write_target_config` 在本线保存一律 400、不读开关**——开关只是预留的名字与登记，一次提前的开关翻转造不出「可保存却没有实现」的规则（桥 ADR §3.1 对 `apply_when_ready` 的同一做法）。读源组合（两跳，`http-routes.cjs:44`）不在词表里，要加另议。
- `contentKey`、`connection`、`output`、`binding` 四项都是服务端盖章：保存时调用 `describeRead`，把返回值写进配置；触发时重新 `describeRead` 并比对，`contentKey` 或列集对不上即 `skipped(operation_changed)`。「声明 = 事实」每次都验，不是只在保存时。

### 4.2 具名操作的生命周期

- 批准、退役在集成侧做，规则侧不参与。被引用的版本退役后，运行时查找只认 `approved`（`read-source-config-store.cjs:379-388`），该步骤记 `skipped(operation_not_approved)`——**退役一个配置版本就是关掉所有引用它的规则步骤**，这是有意的失败关闭。
- 规则引用的是版本行的 id。顾问保存出新版本（新行）不会让旧规则自动跟过去；要换版本就编辑规则，重新盖章、重新过操作者权限检查（§4.5）。
- 本线**不**给规则→配置加库级指针或锁（`external-system-pointer-lock.cjs` 的协议只覆盖配置→系统那一层）：一个被规则引用的配置仍可退役，后果如上。要不要在退役时列出引用它的规则，属于前端便利，不在本线。

### 4.3 读 / 写的分类，以及它和传输层判定的关系

| 目录里的分类 | 传输形状 | 结果 |
|---|---|---|
| 读（读源配置） | `http` 种类，安全方法、无体 | 直接出站，不经写门 |
| 读（读源配置） | `http` 种类，POST 或带体 | 传输层按「写」处理，以操作词 `request` 过写门（`http-adapter.cjs:263-272`）：部署文件未设即 `OUTBOUND_HTTP_WRITE_DISABLED`；只有条目显式点名 `operations: ['request']` 才放行。**S3 不为「目录说它是读」开任何旁路**——那正是 `outbound-http-write-gate.cjs:59-77` 说的「把策略变成参数」 |
| 读（读源配置） | K3 种类（读是带体的 POST，适配器自带读意图） | 不经通用写门（K3 不用 `http-adapter`）；K3 的写在适配器的 `upsert` 上被永久拒绝，本线的服务只调用 `read` |
| 写（写目标配置） | 任何 | 本线：保存 400。之后的发送切片：见下 |

**发送切片的契约（不随本线交付，现在锁定以免读路径把路堵死）**：

1. 向写门出示一个**新的闭合操作词** `call_connection`，加进 `OUTBOUND_HTTP_WRITE_OPERATIONS`（`outbound-http-write-gate.cjs:194-197`）。既有条目缺省只授权 `upsert`（`:370-372`），所以**今天已经存在的任何放行条目都不会顺带放行自动化写**——负对照测试必须有。
2. 匹配主体的 `object` 取写目标配置的 `object`，`systemId` 取配置引用的系统；配置自带沙箱 / 生产两个系统引用（`write-target-config.cjs:25-28`），先沙箱。
3. 对 K3 两个种类调用 `assertK3ExternalWriteRefused`（`k3-external-write-permanent-fence.cjs:181-186`）；目录加载时就拒绝登记面向 K3 种类的写操作。可证明的 K3 保证仍然是客户侧的只读账号，围栏是纵深。
4. 走两阶段意图台账，整动作一行或按目标一行（`automation-outbound-intent.ts:156-166`）；结果写带尝试令牌，步骤只在 `confirmed` 时报成功（§1.6）；任何「体已发出而结果不明」= `outcome_unknown`，永不自动重发。
5. 写步骤的输出在同一次结果写里落快照，供重试时 `skip_sent` 的步骤恢复（§5.5）。
6. 打开 `…_CALL_CONNECTION_WRITE_ENABLED` 与每一个写操作都是 O ②（内部表以外的目标同时是 O ③）。

### 4.4 放置、触发与同规则的其它动作

- **触发器**：`schedule.cron`（时区必填且是合法 IANA，校验同 `automation-run-integration-job.ts:178-189`）与 `schedule.interval`（`intervalMs ≥ 15 min`）。其它触发器保存 400。为什么不先放开记录事件：记录事件由任意编辑者引发，而读是以规则创建者的权限执行的——「编辑一条记录就能驱动一次外部读，键值由记录内容决定」是一个要 owner 点头的授权形状（§12 OQ4），不是实现细节。
- **条件**：不许带（定时触发的记录是空的，条件只会失败，`automation-run-integration-job.ts:196-207` 的同一理由）。
- **位置**：只在顶层；嵌在 `condition_branch` / `parallel_branch` 里的保存 400（判定按位置，照 `automation-run-integration-job.ts:259-281` 的遍历，不按对象身份）。
- **同规则**：一条规则里可以有多个 `call_connection` 与 `transform_records`，也可以与既有的发送类动作并存；但既有动作的模板**不解析** `steps.*`（§5.2），含 `{{steps.` 的既有动作模板保存 400，免得它静默渲染成空串。
- **不进这些白名单**：两个审批触发器的动作白名单（`automation-service.ts:500-512,621-624`）、并行分支白名单（`:713`）、`integration.run_finished` 规则允许的动作（前端镜像 `integrationRunFinishedAuthoring.ts:35-42`，服务端保存门 `automation-service.ts:3585`）、按钮路由的动作表（`multitable-button.ts:99-109`）。每一处各有一条「新类型被拒」的测试。

### 4.5 授权与运行身份

- **谁能保存这样的规则**（同时满足）：① 对规则所在表 `canManageAutomation`；② 主体带租户、且在该租户恰有一行在役成员关系（无租户平台管理员保存即拒）；③ `describeRead` 以该主体的实时权限通过——即持读层集成权限、配置已批准、系统存在且种类准入；④ 规则所在的表通过 OQ3 裁定的守卫。
- **绑定**：保存时服务端把 `{ principalId: created_by, tenantId }` 盖进 `binding`，客户端同名键丢弃；改规则的人不接管绑定（`automation-run-integration-job.ts:148-158` 的做法）。
- **操作者权限**：一次保存（含只切换启用）之后规则带本动作且处于启用状态时，**操作者本人**必须通过与执行器相同的实时检查加 `describeRead`；缺操作者即拒。整次重试时，重试者本人同样要过（`retryExecution` 的路由只查全局管理员角色，`automation-service.ts:307-311` 记的就是这个洞）。只把规则关掉的写入不做这项检查，免得「创建者失权后规则关不掉」（`:312-314`）。
- **触发时**：主体上下文由 core 在一个先提交的 READ COMMITTED 事务里从实时 RBAC 构造（`automation-run-authority.ts:51-114`），**提交之后**再调端口，锁不跨出站调用；提交之后的撤权不中止在途的那一次读，这是与桥 ADR §6.4 相同的已接受窗口。定性的不在役 / 无成员关系 / 无权限 → `skipped(principal_unauthorized)`，不重试；读表本身失败 → `not_started(authority_unavailable)`。
- **数据面读身份 = 绑定主体本人**，不引入服务端委派。对 `data-source:sql-readonly` 这意味着规则创建者必须是该数据源的 owner 或平台管理员（宿主的数据源门严格比对 owner，`DataSourceManager.ts:791-801`；解析器只在 `runAs === 'user'` 且有主体时走 owner 路径，`connection-resolver.cjs:275`）。备料拉取那种「服务端盖章的 owner 委派」只对它那一个动作成立，本线不借用。
- **租户**：动作没有请求、没有请求头，租户只来自保存时冻结的绑定；规则所在表必须属于绑定租户（R-90 对作业规则的同一条守卫在这里是否照搬为「登记表」检查，见 OQ3——通用规则所在的表不一定是备料登记表）。

### 4.6 执行序（每次触发）

开关原文 → 配置重新解析 → 绑定主体 = 规则创建者 → 规则所在表的守卫（OQ3 裁定后的形态）→ 端口在役 → **实时复核绑定主体并提交**（§4.5）→ `describeRead` 复核引用（§4.1）→ 解析 `inputs` 里的步骤引用（§5.3；解析不出即 `failed(input_unresolved)`，不出站）→ `callRead({ context, operation, inputs, rowSource, signal, checkpoint, automation })` → 结果消毒 → `capReached` 为真即 `failed(row_cap_reached)`、不发布 → 过大小上限（§5.6）→ 发布到运行内通道 → 组装 values-free 的 `step.output`。

- `signal` = 步骤超时（常量，等于配置读超时加余量）与停机信号的并集；停机信号与在途任务的登记沿用 I 链的接缝（`automation-executor.ts:1779-1786`）。
- **读步骤不写意图行**：读没有「发出去了但不知道成没成」的歧义，失败就是失败；下一个定时点就是重试。配置里不设 `retry`（保留字，照 `automation-run-integration-job.ts:91-93`）。
- **截断即失败**：`capReached` 为真就不发布——包括行数恰好等于上限的情况（§1.4），所以配置的行上限要留在预期行数之上。一页被截断却被当作完整，下游不会知道自己拿到的是半份数据；宁可这一步失败。首片一步只读一页；翻页是后续切片（§11）。

### 4.7 模拟、真发测试与重试

- **模拟**（`dispatchMode === 'simulate'`）：`simulationDisposition` 归 `simulate`（`automation-executor.ts:1010-1035`），**永不到达端口**——端口探针的调用次数为 0 是验收断言。模拟计划只含操作引用与输入键名，引用到前序步骤的地方列为「未解析的引用」，不造样例值。
- **真发测试**：两个新类型都不进 `automation-retry-eligibility.ts:18-39` 的任何集合，于是落到 `TEST_RUN_ACTION_UNSUPPORTED`（`:76-78`）。要给人看一次真实读出来的数据，走 §6.4 的手动预览，不走真发测试——真发测试的结果面是日志，而日志不许带值。
- **整次重试**：读步骤重读；重试前先过重试者权限检查（§4.5）。本动作不属于 A / B 两族，重试的台账证据要求对它不适用（`automation-retry-eligibility.ts:151-165,172`）。

### 4.8 步骤结果词表（闭集）

`status ∈ {success, failed, skipped}`；`step.output = { outcome, reason, operation: { kind, configId }, counts: { rows, columns, bytes }, capReached, durationMs, errorClass? }`，键集闭合。`reason` 闭集：`ok`、`action_disabled`、`config_invalid`、`rule_sheet_unregistered`、`port_inactive`、`principal_unauthorized`、`authority_unavailable`、`operation_not_approved`、`operation_changed`、`kind_not_admitted`、`read_authorization_required`、`busy`、`timeout`、`shutdown`、`redirect_refused`、`source_error`、`row_cap_reached`、`output_not_scalar`、`output_too_large`、`input_unresolved`、`input_redacted`。`errorClass` 只取适配器或驱动的错误代码 / 类名，从不取消息文本。

### 4.9 登记点清单

来源：对最近两个新增动作 `run_integration_job`、`write_approval_form_values` 做全仓 `git grep -l`（去掉 docs 与测试后分别命中 31 个、20 个文件），剔除各自专属的模块后取并集。**这是下界，不是穷尽证明**：以集合差或默认分支隐式处理动作类型的地方 grep 不到，所以每个切片另外要有 `never` 穷尽检查与「未知类型落到拒绝分支」的测试兜底。`packages/openapi` 里没有动作类型的枚举（对三个动作名的 grep 0 命中），不是登记点。

| 位置 | 要做的事 |
|---|---|
| `automation-actions.ts:6-38,40-58` | 联合类型、`ALL_ACTION_TYPES`、配置形状接口（`automation-service.ts:656-660` 的两个集合由它派生） |
| `automation-service.ts:1952-1971`、`:2223`、`:2807` | 保存门接进 `createRule`、版本绑定的 `updateRuleOnce`、`setRuleEnabled`：开关 403、闭合配置、触发耦合、放置、条件、盖章 |
| `automation-service.ts:205-225` | 校验码联合增新码 |
| `automation-service.ts:500-512,621-624,713,1229-1296,3585` | 五处放置白名单 / 嵌套规则——新类型**不加入**，各配一条拒绝测试 |
| `automation-service.ts:3483,3508,4756-4769` | 操作者权限：保存、启用、重试 |
| `univer-meta.ts:22144-22145,22214-22215` | 开关拒绝映射为 403，其余 400 |
| `automation-executor.ts:1010-1035,1566,2998-3079` | `simulationDisposition`、模拟计划、分发 `switch` |
| `automation-executor.ts:1773-1786`，`automation-service.ts:1738-1742` | 端口的晚绑定接缝与接线 |
| `automation-retry-eligibility.ts:18-39,76-78` | 不进 A / B / 控制三个集合（保持 UNSUPPORTED），配测试 |
| 新迁移 | 动作 CHECK，链式导入上一支的类型表；迁移测试照 `run-integration-job-automation-action-migration.test.ts` |
| `core-backend/src/routes/auth.ts:334-338`，`stores/featureFlags.ts:78-83` | 把开关作为会话特性露给编辑器；关着时编辑器不渲染该动作 |
| `core-backend/src/index.ts:3710-3718,1838-1841`，`core-backend/src/types/plugin.ts:1488-1494` | 端口登记服务、卸载时解绑、插件服务类型 |
| `plugin-integration-core/index.cjs:643-647`，`http-routes.cjs:15971-15972` | 插件登记端口、导出新入口 |
| `multitable-button.ts:99-109` | **不加**（负对照：按钮路由对新类型答 `BUTTON_ACTION_NOT_ENABLED`） |
| `global-history-flag-manifest.mjs`、其测试、仓库根的 `.env.example:371-377` | 开关登记、读取点测试、默认关的示例行（§7.8） |
| `packages/core-backend/vitest.config.ts:1538`、`.github/workflows/plugin-tests.yml`、`test-chain.txt` | 真库用例的三处镜像、插件测试链登记 |
| `apps/web/src/multitable/types.ts:1366-1388` | 前端联合类型 |
| `meta-automation-labels.ts:1622-1650`，`automationActionSummary.ts:176,259` | 标签与规则摘要 |
| `MetaAutomationRuleEditor.vue:1438-1447,2553-2562,2603-2606` | 配置面板、可选动作表、选择条件 |
| 新的编写模块（照 `runIntegrationJobAuthoring.ts`）+ `automationSaveBlockReasons.ts` | 前端校验镜像与保存阻断原因；文案与服务端逐字节一致，由对拍测试钉住（先例 `automation-run-integration-job-web-parity.test.ts`） |
| `MetaAutomationLogViewer.vue:227`，`AutomationExecutionsView.vue:227-318,645-647`，`automation-log-support-packet.ts:73`，`MetaAutomationManager.vue:2483` | 日志、执行详情、支持包、规则列表里对新步骤的 values-free 呈现；快照面板里绑定显示为占位 |
| `apps/web/scripts/run-required-web-tests.sh` 及其 `.tokens` | 新 spec 的登记 |

## 5. S2：步骤输出与 `{{steps.<key>.output…}}`

### 5.1 步骤键

- 产生输出的步骤在**自己的配置里**带 `stepKey`，形状 `^[A-Za-z][A-Za-z0-9_]{0,31}$`，规则内唯一。首片只有两种动作可以带：`call_connection` 与 `transform_records`；既有动作不产生可引用的输出（放开哪一个，见 §11）。
- **为什么不用结构路径当键**：结构路径是下标，分支子步里带点号，分支键还允许 `-`（`automation-step-key.ts:22-29`，`automation-service.ts:712`），而模板路径的正则是 `[\w.]+`（`automation-executor.ts:331`）——点号是分隔符、`-` 根本不匹配；下标在步骤调序后还会指到别的步骤。
- **为什么放在配置里而不是动作对象上**：动作身份与规则指纹只覆盖 `(结构路径, 类型, 配置)`（`automation-action-idempotency.ts:58-64`，`automation-rule-fingerprint.ts:102-112`），分支里的动作对象在校验时被重建成 `{ type, config }`、多余的键会被丢（`automation-service.ts:1210-1219`）。键在配置里，改名就等于改配置：整次重试的 `RULE_CHANGED` 守卫（`:4697-4712`）自动覆盖，不新增登记点。

### 5.2 引用语法（闭集）

```
引用    := 'steps.' 步骤键 '.output.' 选择器
选择器  := 'count'            // 已发布输出的行数
         | 'first.' 列名      // 输出恰有一行时该行该列的值；行数不是 1 即解析失败
```

- 只有这两种选择器，正好落在 `[\w.]+` 之内。没有下标、没有通配、没有任意深度的路径。
- **整值绑定，不做插值**：首片只接受「整个字符串恰好是一个 `{{引用}}`」，值按原类型交给使用方；混排文本另议。这样步骤数据拼不进任何更长的串里。
- **行集不走模板**：把整个行集交给下一步，用结构化引用 `source: { fromStep }`（§6.1），与合成片的 `StepInputRef` 同形（`automation-run-values.ts:52-57`）。
- **谁能用引用**：首片只有 `call_connection.inputs.key`（标量）与 `transform_records.source`（行集）。既有动作的模板继续走 `renderAutomationTemplate`，其模板数据里没有 `steps`——所以保存时就拒绝（§4.4），而不是让它在运行时渲染成空串。
- **解析器是新写的**：只按声明的列取自有属性，拒绝 `__proto__` / `prototype` / `constructor`，不复用 `lookupTemplateValue`（它不防原型链、对函数值会渲染出字面的 `undefined`，`automation-executor.ts:309-328`）。

### 5.3 运行内通道

- 把 `createRunValueStore` 一般化（`automation-run-values.ts:118-204`）：计划不再是固定的合成计划，而是从**已保存的规则**推导——步骤顺序 = 带 `stepKey` 的顶层步骤的顺序；每个输出的声明列 = 保存时盖章的 `output.columns`；每个输出的消费方白名单 = 保存时静态引用图里引用了它的那些步骤。容器既有的保证全部保留：只收声明列上的有限标量、发布一次、发布即冻结、句柄只在本次运行有效、只能引用前序且已成功的步骤（`:139-186`）。
- **保存时的静态检查**：每个引用必须指向更早的、带该键的顶层步骤及其声明的列；前向、自引用、未知键、未声明列一律保存 400。运行时容器再查一遍，两层各有测试——保存检查挡的是写错的规则，容器检查挡的是绕过保存写进库的规则。
- **生命周期**：一次执行一个，在 `execute` 入口创建、`finally` 里 `dispose`；续跑时由快照重建（§5.5）。容器不挂成 `ExecutionContext` 的可枚举字段——上下文在个别地方会被整体带进日志元数据，执行器里已有「不要展开 context」的注释（`automation-executor.ts:5417-5418`）；用以执行为键的模块私有表持有。
- 合成片的容器与它的固定计划保持原样（§7.10 的 G14）；一般化是加一个从规则推导计划的构造路径，不是改合成路径。

### 5.4 持久化（切片 S2-b）

**默认不落任何值。** 只有一种情况写快照：执行即将挂起（`wait_for_callback` 或 `start_approval`），且尚未执行的步骤里有对已发布输出的引用。只写被引用到的输出。

- **表** `meta_automation_step_outputs`：主键 `(execution_id, step_key)`；列有 `root_execution_id`、`rule_id`、`structural_path`、`action_key`（步骤当时的动作身份）、`output_schema_digest`（声明列的 sha256）、`row_count`、`payload`（jsonb）、`payload_bytes`、`redacted_columns`（text[]）、`created_at`、`expires_at`。
- **顺序**：快照与挂起行在同一个事务里写；对 `start_approval`，快照必须先于审批实例的创建——快照写不下去（超限、库错）则本次执行失败、**什么都不挂起、不产生审批**。
- **脱敏**：`payload` 落库前过 `redactValue`（`core-backend/src/multitable/automation-log-redact.ts:162-179`），并逐列比对脱敏前后，把发生过改写的列名记进 `redacted_columns`。脱敏是纵深，不是主防线——主防线是这张表只装声明列、只在必须时写、没有任何读出口。
- **保留**：执行进入终态（成功 / 失败）时，同一事务里删掉它的快照；另有一个按 `expires_at` 的清扫（T 层默认 30 天，与执行日志的清理默认值同量级，`automation-log-service.ts:323`），兜住没走到终态的执行。
- **没有读出口**：没有路由、没有界面、支持包不带；只有续跑路径读它。「路由与前端源码里不出现这个表名」是一条静态守卫。

### 5.5 续跑与重试

- **续跑**：在既有的漂移守卫之后、**单次令牌认领之前**（所有校验先于认领是既有纪律，`automation-service.ts:4927-4939`）读取本次执行的快照，逐条核对：当前规则在 `structural_path` 上的步骤仍带同一个 `stepKey`，重算的动作身份等于 `action_key`，声明列的摘要等于 `output_schema_digest`。任一不符 → 409 拒绝续跑、令牌不消耗。这一层是必须的：续跑的既有守卫只比动作类型序列（`:4843-4847`），看不见配置改动。
- 核对通过后重建容器；`redacted_columns` 里的列被标记为不可用，**一经引用即 `failed(input_redacted)`**——绝不把 `<redacted>` 占位符当作值交给下一步或发到外部系统。
- 快照缺失或过期而后续步骤又引用了它 → 409 `STEP_OUTPUT_UNAVAILABLE`，同样不消耗令牌。
- **整次重试不恢复读输出**：重试从第 0 步对当前数据重跑（`automation-service.ts:4784-4788`），读步骤重读——与续跑「重新读取活记录」是同一个取向（`automation-suspension-service.ts:13-14`）。
- **写步骤的输出是例外，留给发送切片**：重试时已发送的步骤被 `skip_sent` 跳过、不带输出（`automation-executor.ts:4137-4139`），依赖它返回值的下一步就没有输入。所以发送切片必须在记 `sent` 的同一次结果写里落该步的快照，重试时按台账身份恢复（§4.3 第 5 条）。本线没有写步骤，这条只定契约。

### 5.6 大小上限（T 层默认，全部是常量；每条都要有「去掉即红」的测试）

| 对象 | 上限 | 超限的结果 |
|---|---|---|
| 一个输出的行数 | 1000（配置读的行上限，`read-source-read-runtime.cjs:45`；容器硬上限 1 万，`automation-run-values.ts:76`） | 产生它的步骤 `failed(output_too_large)`，不发布、不截断 |
| 一个输出的规范化 JSON 字节数 | 1 MiB | 同上 |
| 一次执行全部输出的字节数 | 4 MiB | 超出的那一步失败 |
| 一条规则里带 `stepKey` 的步骤数 | 8 | 保存 400 |
| 被整值绑定的标量串长度 | 4096 字符 | `failed(input_unresolved)` |
| 一个输出的快照 / 一次执行的快照合计 | 256 KiB / 1 MiB | 挂起前失败（§5.4），不截断 |

「不截断」是统一规则：宁可这一步失败，也不让下一步在不知情的情况下拿到半份数据。

### 5.7 `step.output` 与日志隔离

- 新动作的 `step.output` 键集闭合（§4.8），由宿主从枚举与计数重建，**不是**从原始结果展开后删字段（冻结基线 §10.3.1 的原则）。行摘要与计划摘要是值的派生物，对低熵的值可以被枚举还原，同样不进日志。
- 验收用哨兵值：让一组带唯一标记的合成值流过一次完整执行（含失败、超时、挂起与续跑各一条路径），然后在 `multitable_automation_executions` 的四个自由形列、`multitable_automation_jobs.result`、出站意图表、发件箱、应用日志、指标标签与异常的 `cause` 里搜这个标记，命中数必须为 0；同一测试对运行内通道与（S2-b 之后）快照表断言命中数**大于 0**——那是它该在的地方，也是这条测试不是空转的证明。

## 6. S4：转换步骤，以及宜搭 v3 映射在它上面的表达

### 6.1 动作 `transform_records`（通用方言，切片 S4-a）

```
{ stepKey,
  source:  { fromStep },                        // 前序的、声明了输出的步骤
  mapping: { dialect: 'field_mappings_v1', fieldMappings: [ { sourceField?, targetField, transform?, defaultValue? } ] }
         | { dialect: 'yida_form_protocol_static_v3', config, allocation: { mode: 'original' } },
  output:  { columns: string[] } }              // 服务端从映射推导并盖章
```

- **宿主在 core，引擎是注入的一个纯函数**：按 `yida-automation-preview.ts:148-194` 的方式从插件目录的固定路径只取 `transformRecord`。前提是引擎文件保持零依赖——今天它没有任何 `require`（§1.7）；加一条静态测试钉住「无 `require` / `import`、无 `process` / `fs` / 网络」，与合成目录的同类测试并列。
- **保存时的校验**：`sourceField` 必须是源步骤的声明列（或缺省，表示常量）；`targetField` 是扁平标识符 `^[A-Za-z_][A-Za-z0-9_]{0,63}$` 且不重复；`transform` 里的函数名必须在引擎的闭集内（`transform-engine.cjs:10-19`）；映射条数 ≤ 64。
- **语义**：逐行调用 `transformRecord`；**全有或全无**——任何一行有错，整步 `failed(transform_failed)`，不发布部分结果。给人看的只有出错的行数、字段名与闭合的错误码。
- **放置**：与 `call_connection` 相同（§4.4）。没有任何 IO，但模拟模式下它没有输入可转，所以 `simulationDisposition` 同样归 `simulate`，计划里只列映射的目标字段名。

### 6.2 通用方言对引擎的五处收紧

| 引擎今天的行为 | 步骤层怎么处理 |
|---|---|
| 读路径按点号逐段取属性、不防原型链，`a[]` 表示取数组首元素（`transform-engine.cjs:34-52`） | 保存时把 `sourceField` 限制为声明列的名字（无点号、无 `[]`），原型链上的名字因此到不了 |
| 目标路径可嵌套（`transform-engine.cjs:54-83`） | `targetField` 只许扁平标识符——运行内通道只装标量列 |
| 错误的 `details` 带原值，消息是自由文本（`transform-engine.cjs:96,104,164,239-246`） | 步骤只保留 `code`、字段名与行号；`message` 与 `details` 不出步骤 |
| `toDate` 对非 ISO 文本用运行时的 `Date` 解析（`transform-engine.cjs:158-167`） | 通用方言照常可用并在界面上注明；宜搭方言里禁用（没有对应的 v3 转换） |
| `concat` 默认把当前值拼在最前、静默丢掉空白片段、把布尔值转成文本（`transform-engine.cjs:172-190`） | 通用方言保持原样（管道在用，不改）；宜搭的拼接语义不同，用扩展函数表达（§6.3） |

引擎文件本身只改一处：`transformRecord` 增加可选的第三个参数，接受一张冻结的扩展函数表；不传时行为逐字节不变，管道与其它既有调用方都不传（由它们现有的测试钉住，另加一条「扩展表泄漏进管道路径必红」的变异）。

### 6.3 宜搭 v3 映射的表达与对拍（切片 S4-b）

**表达。** 新的纯模块 `lib/yida-transform-spec.mjs` 把一份已通过 `validateYidaStaticConfig` 的 v3 配置编译成转换步骤的映射规格：

| v3 转换（`yida-static-plan.mjs:256-262`） | 映射规格 |
|---|---|
| `direct` | `{ sourceField: source, targetField: target }` |
| `copy` | `{ sourceField: 主条目的 source, targetField: target }` |
| `constant` | `{ targetField: target, defaultValue: value }` |
| `concat` | `{ targetField: target, transform: 扩展函数 yida_concat(parts, separator, blank) }` |
| `generated` | `{ targetField: target, transform: 扩展函数 yida_generated(template) }` |

两个扩展函数与编译器放在规划器旁边，只导入规划器已经导入的 `./yida-material-code.mjs`；**规划器不导入它们**（导入钉子的方向不变，§1.7）。字段目录的类型 / 数值 / 选项校验、必填、业务键缺失、键重复与生成值重复——这些逐行校验与批次层的裁定**都不重写**，仍只由规划器做。

**权威。** `yida-static-plan.mjs` 仍是唯一权威，在步骤里以两个导出函数的身份出现：

- **逐行的判据**：`buildYidaStaticPlan({ config, rows: parseYidaStaticRows(rowsText, config) })`（两个都是导出函数，`yida-static-plan.mjs:638,865`）。它对每一行给出状态、`payload` 与问题码，对拍用的是这一侧。不拆分的分配下，编译器内部调用的就是同一句（`yida-draft-compiler.mjs:85-89`）。
- **可发布的结果**：`compileYidaLocalDraft`（`yida-draft-compiler.mjs:198-203`）。它在逐行结果之上还要求没有任何无效行、没有重复键、批次非空，否则抛出，并且只留下一个闭合的错误种类（`:104-123,180-183`）——所以它**给不出逐行问题码，不能当对拍的判据**，只充当「这一批能不能成为草稿」的闸。
- **步骤的顺序（影子模式）**：按映射规格在引擎上算一遍 → 调逐行判据 → 比对（定义见下）。不一致 → `failed(parity_violation)`，记一行 values-free 的告警日志，什么都不发布。一致 → 调 `compileYidaLocalDraft`：它抛出即 `failed(yida_plan_rejected)`（带那个闭合种类），不发布；它通过才发布**它的** `plan.rows[*].payload`。引擎一侧的结果从不发布。
- **发布时补齐列**：规划器对缺失的可选目标不写 `payload` 的键（`yida-static-plan.mjs:784-790`），而运行内通道要求每行恰好是声明列（`automation-run-values.ts:94`），所以发布前把缺的列填成 `null`。
- 发送路径不变，继续用 `compileYidaSendDraft` 自己编译（`yida-draft-compiler.mjs:192-196`），不读转换步骤的任何产物——预览不是授权（`yida-automation-preview.ts:9-12`）。

**对拍的定义（合并门，也是运行时的比对内容）。** 对拍的对象是规划器的**逐条目求值**（`transformValue`，`yida-static-plan.mjs:766-772`）：对每一个（映射条目, 行），引擎一侧必须给出同一个结果——同一个值（含类型），或同一个「缺失」，或同一个拒绝码（`FIELD_PART_MISSING` / `FIELD_TYPE` / `FIELD_VALUE_TOO_LONG`，出处 `:701-706,731-763`），或同样地「因模板读到的键缺失而跳过」（`:722-724`；这种行由规划器记 `KEY_MISSING`，引擎一侧不得把它算成拒绝码）。这个函数没有导出，所以比对经逐行判据的公开输出来做：

1. 规划器判为已规划的行：`payload` 里的每个目标，引擎给出的值与之相同（值与类型）；`payload` 里没有的目标，引擎给出的是「缺失」。
2. 规划器判为无效的行：引擎给出拒绝码的每个目标，规划器在该行的问题里必须有同一目标的同一个码——引擎的拒绝是规划器问题的子集。反方向不要求：必填、目录的类型 / 数值 / 选项校验（`yida-static-plan.mjs:784-803`）、键缺失与两种重复是规划器独有的裁定，引擎一侧不算。
3. CI 的语料保证第 2 条不是空转：每个拒绝码都有专门的单行批次，键齐全、目录校验全部通过，使规划器的问题恰好只剩那一个码，于是两侧必须逐码相等。

键序不需要比：发布的是规划器一侧的 `payload`，它按字段目录顺序构造（`yida-static-plan.mjs:673-676`）。`localBusinessKey` 与四个摘要（`yida-draft-compiler.mjs:145-176`）也只由规划器一侧产生，所以不存在「两份摘要是否相等」的问题。

**语料。** 规划器自带的三组样例（`yida-static-plan.mjs:983,1024,1060`）、入库的 v3 模板 `fixtures/yida-rule-templates/material-v3.json`、合成预设（`automation-operation-catalog.ts:178-222`），加一个确定性生成器：覆盖五种转换、两种 `blank` 规则、空键字段、数字 / 布尔 / 缺失 / 空串 / 纯空白 / 超长串 / 孤立代理项、同批重复键与重复生成值。生成器固定种子，失败时打印的是行号与问题码，不是值。

**必须见证的变异**（每条先红再绿）：`yida_concat` 的 `refuse` 改成 `skip`；全部列片段为空时返回空串而不是缺失；布尔片段被转成文本；`copy` 读成目标名而不是主条目的源列；`constant` 的映射误带了 `sourceField`，行里同名列的值于是盖过常量；`yida_generated` 少一个部件或换了命名空间；影子比对被跳过（引擎一侧故意算错仍发布）；发布的是引擎一侧而不是规划器一侧；跳过 `compileYidaLocalDraft`、直接发布逐行判据的行（含无效行的批次于是被发布）；发布前不补齐列。

**退路。** 如果某个 v3 构造在两轮评审内无法在引擎上逐字节复现，T 层默认退到「步骤内只调规划器、不做引擎表达」（§13 里保留的那个备选），**不放宽对拍**。

**首片的限制。** 只接受 `allocation.mode: 'original'`；拆分分配仍在宜搭自己的预览路径里（`yida-draft-compiler.mjs:85-95`）。行数与文本上限沿用规划器的（`yida-static-plan.mjs:6-9`）。

### 6.4 手动预览：这条线的可演示出口（切片 S4-d）

定时规则的结果只进日志，而日志不带值——所以需要一个给人看的出口，否则 S1–S4 做完了客户什么也看不到。

- 新路由 `POST /api/multitable/sheets/:sheetId/automations/:ruleId/steps-preview`：把已保存规则里的 `call_connection` 与 `transform_records` 步骤按顺序跑一次，把**最后一步**的行（至多 100 行、只含声明列）放在响应里，`Cache-Control: no-store`；前端只放在当前面板的内存里。合成预览的路由与目录不动（它是另一条路，`routes/automation.ts:1049-1056`）。
- **准入**：操作者必须是规则的所有者，并在运行开始、每次出站读之前、结果返回之前各过一次检查——规则归属、表在役、§4.5 的实时权限与 `describeRead`。检查点的事务与锁顺序照合成片已经验证过的协议（`automation-synthetic-preview.ts:17-38`），已知间隙也照实写：检查通过之后才撤权的那一次读仍会发出。
- **落库**：一行 values-free 摘要，`triggered_by = 'steps_preview'`，加进不计入规则监控的那张名单（`automation-log-service.ts:18`）；`trigger_event` 与 `rule_snapshot` 为空，所以既有的重试门自然拒绝它（合成片的同一做法，`:139-149`）。
- **它是一次真实读**：在客户机器上由人点击触发，与定时触发同属 O ①，受同一个开关、同一份已批准配置、同一个 B2a 用途约束。开发与 CI 只对合成的登记系统（本机夹具服务）运行。

## 7. 安全

### 7.1 边界：谁控制什么

| 角色 | 能决定的 | 不能决定的 |
|---|---|---|
| 集成管理员（`integration:write`） | 登记系统的 origin 与凭据；读源配置的路径、方法、字段映射；批准与退役 | 让未批准的版本被运行时使用 |
| 规则作者（`canManageAutomation` + 读层集成权限 + 租户内在役） | 选哪个已批准的操作、业务键的字面值或引用、步骤顺序与映射 | 端点、动词、请求头、请求体、凭据、超时、目的系统的地址 |
| 步骤数据（来自上一步） | 成为业务键的值，或转换的输入行 | 成为路径、主机、键名、列名、扩展函数名 |
| 部署者 | 三个开关、出站写门的允许清单文件、B2a 登记 | 用请求或规则配置改变以上任何一项 |

### 7.2 SSRF：为什么不是一道 URL 检查

- 现有两套守卫的策略是「只许 https、拒绝内网」，对规则作者可以随手写 URL 的 `send_webhook` 是对的（`automation-executor.ts:5303-5341`）。登记系统正相反：客户的 PLM / K3 就在内网、常是 http，这是 `http-adapter` 明确允许的（`http-adapter.cjs:67-76`）。把那两套守卫接过来，要么全拒、要么得开一个「内网白名单」——后者正是它们有意不提供的东西（`automation-executor.ts:5331-5332`）。
- 所以本线的防线是**规则作者根本没有地方写 URL**：目的 origin 来自登记系统（集成管理员），路径来自已批准的配置（路径守卫 `read-source-config.cjs:98-116`，执行时再查 `read-source-read-runtime.cjs:393-395`），规则只带配置版本的 id 与一个有界的业务键（`read-source-probe-runtime.cjs:84-118`）。这道路径守卫自己的注释说它是「配置与 SSRF 之间唯一的屏障」（`read-source-config.cjs:94-97`）——本线不削弱它，也不新增任何绕过它到达适配器的路径。
- 已知的残余，照实写：登记系统的 `baseUrl` 可以指向回环或链路本地地址，这由登记权限（集成管理员）承担，不是本线新引入的；本线不在自动化路径上另加地址类别过滤，因为那会把「能在工作台里读」与「能在规则里读」变成两套口径。要不要加，见 §12 OQ5 的子问。

### 7.3 重定向

- 事实：三个 HTTP 适配器的 `fetch` 都不带 `redirect` 选项、默认跟随（§1.2）。一次 3xx 会让凭据头（`http-adapter.cjs:143-160`）随请求到达另一个地址——同站跳转之外的目的地从未被任何人批准过。
- 决策：经本线服务发出的每个请求都是 `redirect: 'manual'`，3xx 即终态拒绝（§3.2）。只对自动化调用方生效，既有调用方不变。
- 为什么不直接改适配器的默认值：那是对管道、工作台探测与备料拉取的行为变更，现场是否有依赖跳转的源（例如 http 跳 https）没有人数过。由谁、何时把它收敛成适配器的默认行为，见 OQ5。

### 7.4 `buildUrl` 的路径事实

- 事实：路径被补成以 `/` 开头再交给 `new URL(path, baseUrl)`，所以总是从 origin 根解析，`baseUrl` 里的路径前缀不起约束作用（`http-adapter.cjs:89,127-131`）。读源配置的路径守卫另外挡掉了 `..`、`//`、scheme 与百分号编码。
- 决策：**不把基路径当围栏，也不在本线改解析规则**（改了会让已批准的配置解析到别的地址）。围栏是 origin：本线服务在出站前断言最终 URL 与登记的 `baseUrl` 同源（§3.2），凭据也是按 origin 绑定的（§7.5）。这条事实写进集成管理员看得到的配置说明里，免得有人以为基路径能把访问限制在某个子目录下。

### 7.5 换 origin 必须重绑凭据

- 事实：§1.3——更新 `config.baseUrl` 而不带 `credentials`，旧密文原样保留。
- 决策：登记处在更新时比较新旧 `baseUrl`（适配器实际读的那一对键，`http-adapter.cjs:231`）的 origin（协议、主机、端口）；origin 变了、库里有密文、而本次请求没有给出 `credentials`，即拒绝（固定码 `EXTERNAL_SYSTEM_CREDENTIAL_REBIND_REQUIRED`）。显式给 `credentials: null` 是清除，允许。同源内改路径或其它配置不受影响。K3 两个种类的实例身份还包含账套（`external-systems.cjs:1140-1152`），账套变更同样要求重绑。
- 这是登记处的行为，对所有调用方生效，不是自动化专属。它是 §8 梯子 L2 的硬前置；由本线交付（切片 S1-c）还是由持有 S0-b 的那条线交付，见 OQ5。

### 7.6 终态写的尝试身份

- 本线的读步骤**不写意图行**（§4.6），因此不新增任何「先写 pending、后写终态」的位置；这一点由静态守卫钉住（新动作的模块不引用 `claimOutboundIntent` / `recordOutboundOutcome`），免得出现只用了台账一半的路径。
- 本线唯一的新落库位置是快照（§5.4），它与挂起行同事务，不存在「谁的尝试」的问题。
- 发送切片继承 §1.6 的全部语义：认领发令牌，结果写以令牌为围栏，0 行即 `confirmed:false`、步骤不得报成功；过期的 `pending` 只由观察到同一令牌的重放翻成 `outcome_unknown`；需要长于租约的写要按令牌续租。这些是契约，不是本线的实现。

### 7.7 K3 永久写围栏

- 本线的服务只调用适配器的 `read`；K3 适配器的 `upsert` 在登录之前就被无条件拒绝（围栏第四层，`k3-external-write-permanent-fence.cjs:32-35`）。静态守卫：服务模块里不出现 `.upsert(`、`testConnection(` 与任何按路径发请求的调用。
- 一个 `baseUrl` 指向 K3 的通用 `http` 系统不在围栏的判定范围内（§1.2）——它靠出站写门挡。所以 §4.3「POST 形状的读不加旁路」不只是整洁问题：一条旁路就等于给「把 K3 的写接口登记成 http 系统的读操作」开了门。
- 发送切片：见 §4.3 第 3 条。没有任何开关、策略、审批结果或请求参数能解锁 K3 写，本 ADR 不预留。

### 7.8 开关：默认关、只认原文 `true`、登记清单

| 开关 | 读取点 | 关着时 | danger | 打开归谁 |
|---|---|---|---|---|
| `INTEGRATION_AUTOMATION_CALL_CONNECTION_ENABLED` | core 保存校验；执行器每次触发；插件服务出站之前；手动预览路由 | 含该动作的规则保存 403 `CALL_CONNECTION_DISABLED`；既有规则触发记 `skipped(action_disabled)`；预览路由固定 404；编辑器不渲染该动作 | high | 上机属 O ④；对真实系统的读属 O ①（§7.9） |
| `INTEGRATION_AUTOMATION_CALL_CONNECTION_WRITE_ENABLED` | **本线不读**（写目标配置保存一律 400） | — | high | O ②③（§12 OQ2） |
| `AUTOMATION_STEP_OUTPUTS_ENABLED` | core 保存校验（规则带 `stepKey`、步骤引用或 `transform_records`）；执行器每次触发 | 保存 403 `STEP_OUTPUTS_DISABLED`；触发记 `skipped(action_disabled)` | medium | T 层梯子（上机仍是 O ④） |

- 三个都是 `type: 'boolean'`、`activationValue: 'true'`、不修剪不折大小写（`'1'`、`'TRUE'`、`' true'` 都是关）、`dependsOn: []`、`conflictsWith: []`，登记在 `scripts/ops/global-history-flag-manifest.mjs` 里 R-69 四个开关之后（条目范例 `global-history-flag-manifest.mjs:1034-1043`）。三者互不联动：`call_connection` 不带 `stepKey` 时只报计数、不需要第三个开关；带了就需要。
- **清单测试不会自己发现它们**，切片要一并改：`INTEGRATION_AUTOMATION_RUN_…` 的族扫描（`global-history-flag-manifest.test.mjs:459`）匹配不到 `…_CALL_CONNECTION_…`，要加一条族扫描；`env.AUTOMATION_*` 的读取点扫描（`:1207`）会抓到第三个开关，随之要更新那条精确列表断言（`:1214-1224`）；幽灵检查（`:598-627`）要求每个登记的键都在被扫描的源码里出现，所以「只登记不读」的写开关要像 `automation-run-integration-job.ts:45-48` 那样以名字写进源码；插件侧的读取点要进插件的扫描；每个开关一条显式的读取点测试（范例 `global-history-flag-manifest.test.mjs:1312-1346`，含「不得按前缀匹配」的断言 `:1337`，以及对仓库根 `.env.example` 里默认关示例行的断言 `:1346`）。
- 会话特性：把第一个与第三个开关的布尔值露给编辑器（`core-backend/src/routes/auth.ts:334-338` 的做法），关着的功能在界面上不可见。

### 7.9 O 层的门

- **O ① 真实客户读**：对客户真实系统的每一个「系统 × 操作」的首次读——不论由定时规则还是手动预览触发——逐项由 owner 批准。机制上有四层互相独立的东西挡在前面：开关、读源配置的批准状态、规则创建者的实时权限、已武装部署上的 B2a 登记。开发与 CI 只用合成的登记系统。
- **O ② 生产写 / O ③ 外部写回**：本线不含任何写路径。发送切片的每一个写操作、写开关的打开、允许清单文件里的每一个条目都逐项由 owner 批准；K3 写永久禁止，不在可批准之列。
- **O ④**：上机、在任何部署上打开开关、开对外 PR、把任务卡交给外部构建者（OQ7）。

### 7.10 CI 必须钉住的守卫

每一条都要三样东西：一个正对照（合法路径确实通）、一个负对照（被禁的路径确实被拒）、一个见证红的变异（去掉守卫，测试变红）。只有负对照的守卫可能是空转的，不算数。

| # | 守卫 | 正对照 | 负对照 | 见证红的变异 |
|---|---|---|---|---|
| G1 | 只能引用具名操作 | 引用一个已批准版本的规则保存成功 | 配置里出现 `url` / `path` / `method` / `headers` / `body` / `query` / `timeoutMs` 任一键即 400；引用 `draft` 或 `retired` 版本即拒 | 去掉闭合键集检查 |
| G2 | 一个门 | 扫描确实找到那唯一的出站调用点（端口的 `callRead`） | core 的新动作模块里没有 `fetch` / `http` / `https` / `undici` / `axios`；插件服务里没有 `.upsert(`、`testConnection(` | 在动作里加一处直接 `fetch` |
| G3 | 写默认拒绝 | `http` 种类上无体的 GET 读成功 | 引用写目标配置的规则保存 400（开关设成 `true` 也一样）；端口的键集恰为两个方法；写门操作词表恰为两项；写门 env 未设时 POST 形状的读得到 `OUTBOUND_HTTP_WRITE_DISABLED` | 给服务加一个按目录分类跳过写门的分支 |
| G4 | 重定向 | 本机夹具回 200 时读成功 | 夹具回 302 时步骤 `failed(redirect_refused)`，跳转目标上的请求计数为 0、从未见到凭据头 | 去掉 `redirect: 'manual'` |
| G5 | 同源与路径 | 已批准路径解析到登记的 origin | 含 scheme、`//`、`..`、百分号编码的路径在保存与执行两处都被拒；交给包装的请求 URL 不同源即拒、不发出 | 去掉执行时的再检查；去掉包装里的同源断言 |
| G6 | 换源重绑 | 同源内改路径不要求重绑 | origin 变更且不带凭据即拒；账套变更同理 | 去掉 origin 比较 |
| G7 | 开关 | 原文 `true` 时可保存、可执行 | `'1'`、`'TRUE'`、`' true'`、未设都是关；关着时保存 403、触发记 `skipped(action_disabled)`、端口调用 0 次 | 读取点改成 `!== 'false'`；插件侧的读取点删掉 |
| G8 | 运行身份 | 在役且有权限的创建者触发成功 | 撤权后的下一次触发即 `skipped(principal_unauthorized)`；无权限的操作者不能保存、启用或重试；客户端送来的 `binding` 被丢弃；无租户主体保存即拒 | 去掉触发时的实时复核；操作者检查改成只查创建者 |
| G9 | 引用完整性 | `call_connection → transform_records` 的引用在保存与运行时都解析成功 | 前向、自引用、未知键、未声明列、别的运行的句柄、原型链上的名字一律拒绝 | 去掉容器的前序检查 |
| G10 | 值不进日志 | 哨兵在运行内通道（与快照表）里找得到 | 哨兵在 §5.7 列的每一个持久面与日志里命中 0 次；`step.output` 多一个键即红 | 把原始结果赋给 `step.output` |
| G11 | 快照与续跑 | 跨挂起的引用在续跑后解析成功 | 改过配置 / 换过键 / 改过列的规则续跑被拒且令牌不消耗；被脱敏列被引用即 `failed(input_redacted)`；超限在挂起前失败且不产生审批 | 去掉动作身份比对；把占位符当值放行 |
| G12 | 截断与上限 | 行数低于上限的读被完整发布 | 达到行上限即失败且不发布；§5.6 每一项超限都失败 | 把上限常量调大十倍 |
| G13 | 宜搭对拍 | 语料全集上两侧一致；全部有效的批次被发布，发布的是规划器一侧的行 | §6.3 列的每一个变异都红；运行时故意算错的引擎一侧导致 `failed(parity_violation)`；含无效行或重复键的批次得到 `failed(yida_plan_rejected)`、不发布 | 跳过影子比对；跳过编译这道闸 |
| G14 | 放置与既有不变量 | 顶层的定时规则可保存 | 进分支、带条件、非定时触发、上按钮路由、进审批触发器白名单都被拒；真发测试答 `TEST_RUN_ACTION_UNSUPPORTED`；模拟时端口调用 0 次。合成目录仍只有一个操作、其步骤类型仍不在 `ALL_ACTION_TYPES`；`IntegrationRunSummary` 的键集不变 | 把新类型加进并行分支白名单 |
| G15 | B2a | 休眠部署上字节不变；已武装且有登记时读成功 | 已武装而无登记时在凭据加载之前被拒；新用途在闭集里、别的用途的登记不能被它花掉 | 把出示用途的调用挪到凭据加载之后 |

## 8. 上线梯子与回退

每一级都由 owner 另批，上一级成立不自动成立下一级。

- **L0** 合并休眠代码：三个开关未设；迁移只放宽 CHECK、新增一张表，旧代码不写新值、不读新表。
- **L1** 上机，开关仍不设。
- **L2 的前置**（全部成立才谈打开）：① §7.3 的重定向拒绝与 §7.5 的换源重绑都在 main 上，各有见证红的测试；② 规则创建者的令牌带租户、且在该租户恰有一行在役成员关系（与桥 ADR §7 的 L2 前置相同）；③ 目标系统上有一份由集成管理员批准的读源配置；④ 部署若已武装 B2a，有新用途的登记；⑤ 推荐由租户绑定的服务账号经 API 创建规则（桥 ADR §6.2 的建议，理由相同：人员变动不影响定时读）。
- **L2** 打开两个读取开关，只对**合成的登记系统**建一条定时规则与一次手动预览，观察步骤结果与日志。
- **L3**（O ①）对客户真实系统的第一个读操作：逐系统、逐操作批准；先手动预览一次，再开定时。
- **L4**（O ②③，另一个切片）写。
- **回退**：把开关改成 `=false` 并重启、确认进程里读到的是关，**然后**再删那一行——只删行再重启不会把变量从运行中的进程里清掉（`222-deploy-window-runbook-20260901.md:977` 记的实测）。回退不需要迁移回滚；规则留在表里，触发时记 `skipped(action_disabled)`。动作 CHECK 的 `down()` 只在该类型从未被保存过的部署上是无害的（与 `zzzz20261106111300…:1-8` 的说明相同）。

## 9. 可观测与 values-free

- **执行行**：新步骤的 `step.output` 只有 §4.8 的闭合键——结果、原因、操作引用（种类与配置版本 id）、行数 / 列数 / 字节数、是否触顶、时长、错误类别。没有行、没有字段值、没有端点、没有连接信息、没有业务键的值。
- **配置读的证据**：它自己的证据面已经是 values-free 的，但内部页对象带行指纹（对行做 sha256，`read-source-read-runtime.cjs:180-182`）——那是值的派生物，core 的消毒只留计数与布尔，指纹不进 `step.output`。
- **日志**：新代码的每一条日志只带 `ruleId / executionId / stepKey / configId / status / errorClass`；主体 id、租户 id、系统 id 不进日志行；从不记 `error.message`（适配器错误的消息与 `details` 可能带路径或响应体）。
- **规则快照**：`rule_snapshot` 里会有规则配置，包括写成字面量的业务键——它是规则作者自己写进规则的配置，与既有动作配置同一类；`binding` 在界面上显示为占位（执行详情页对作业动作的既有做法，`AutomationExecutionsView.vue:227-318`）。
- **证据面**（issue / PR / 登记册）：只记状态与计数；不记系统名、配置名、业务键、任何读到的值。

## 10. 切片、测试与变异见证

### 10.1 切片与依赖

规模按生产代码估（不含测试）：S < 200 行，M 200–500 行，L 500–1000 行。这是读码后的估计，不是承诺。开关一列的 ①②③ 按 §7.8 表的行序：① 连接调用，② 连接调用的写，③ 步骤输出与转换。「保证类」指授权、门、凭据、锁、台账、隔离——要独立核验并逐条见证红。

| 切片 | 内容 | 规模 | 依赖 | 迁移 | 开关 | 类别 | 外部构建者 |
|---|---|---|---|---|---|---|---|
| P0 | 本 ADR（登记行由主会话另行入册） | — | — | — | — | 文档 | 否 |
| S1-a | 插件：抽出 `runGovernedConfiguredRead`，HTTP 逐字节不变，加检查点 | M | — | 无 | 无 | 保证类 | 否 |
| S1-b | 插件 + core：连接调用服务、`ConnectionCallPort` 与登记接线、B2a 新用途、不跟随重定向、同源断言、在途上限。没有调用方，休眠合并 | L | S1-a | 无 | ① 的插件侧读取点 | 保证类 | 否 |
| S1-c | 插件：换 origin 强制重绑凭据（若由本线交付，OQ5） | S | — | 无 | 无 | 保证类 | 否 |
| S2-a | core：步骤键、输出声明、容器一般化、严格解析器、保存时引用图、`step.output` 契约。休眠合并 | M | — | 无 | ③ | 保证类 | 否 |
| S3-a | core：`call_connection`（只读操作）——类型、校验与盖章、保存门、执行步、模拟、重试资格、操作者权限、会话特性、清单登记 | L | S1-b、S2-a | 动作 CHECK +1 | ①；② 只登记 | 保证类 | 否 |
| S3-b | 前端：动作配置面板、编写模块（与服务端文案逐字节对拍）、标签与摘要、日志 / 执行详情 / 支持包的呈现、web spec | M | S3-a 冻结的 DTO 与文案 | 无 | 会话特性 | 非保证类 | **是** |
| S2-b | core：快照表、挂起时落快照、续跑核对与恢复、清扫；解除「不与挂起类动作同规则」 | M | S3-a | 新表 +1 | ③ | 保证类 | 否 |
| S4-a | core + 插件：`transform_records` 通用方言、引擎的单函数注入与纯度钉子、引擎的可选扩展表参数 | M | S2-a | 动作 CHECK +1 | ③ | 保证类（隔离部分） | 否 |
| S4-b | 插件 + core：宜搭 v3 编译器、两个扩展函数、影子比对、对拍门 | L | S4-a | 无 | ③ | 保证类 | 仅语料与生成器 |
| S4-c | 前端：映射编辑面板、编写模块、web spec | M | S4-a 冻结的 DTO | 无 | 会话特性 | 非保证类 | **是** |
| S4-d | core + 前端：手动预览路由与面板 | L（路由 M、面板 S） | S3-a、S4-a | 无 | ①、③ | 路由与准入是保证类；面板不是 | 仅面板 |

- **顺序**：S1-a → S1-b → S2-a → S3-a →（S3-b ∥ S2-b ∥ S4-a）→ S4-b →（S4-c ∥ S4-d）。S1-c 可以在任何时候做，但必须先于梯子的 L2。
- **每周的可演示增量**：S3-a 加 S3-b 之后——一条定时规则每隔 N 分钟读一次合成的登记系统，执行详情里看到读了多少行、多少列；S4-d 之后——在预览面板里看到读出来并映射好的行，以及宜搭草稿预览。两者都只对合成系统，不需要任何 O 层批准。
- **迁移前缀**：三支迁移各用互不相同、且晚于 `zzzz20261111181500` 的时间戳前缀；并行切片各自预先分配，避免两支迁移撞前缀后其中一支要改名。动作 CHECK 的类型表按 `zzzz20261106111300…:10-17` 的方式链式导入上一支。

### 10.2 各切片的验收

- **S1-a**：既有路由测试全绿；失败路径的响应体快照（未批准、种类不符、请求体多键、输入非法、无权限）逐字节相等；「用 `req` 构造的上下文 = 处理器此前从 `req` 读到的字段」的等价测试；不传 `options` 时请求与响应与快照相同（先例 `governed-entry-abort-checkpoints.test.cjs`）；信号已中止时不加载系统、不建适配器（探针计数为 0）；s6a 的 pin 重算；`test-chain.txt` 登记。
- **S1-b**：G2、G3（传输部分）、G4、G5、G7（插件侧）、G15；入口的 `transport` 只接受字面量 `'strict'`，别的值（包括函数）直接拒绝，`readPurpose` 只接受用途闭集里的常量；端口登记与解绑（非 owner 解绑是空操作，旧 owner 解不掉后继者的登记）；同一系统两次并发调用恰一次执行、一次 `skipped(busy)`，且槽位在迟到的落定时才释放（用一个晚于超时才落定的假适配器见证）；表外种类被拒；失败夹具的响应体里放哨兵，哨兵不出服务。
- **S1-c**：G6。
- **S2-a**：G9、G10（内存部分）、G12；引用语法的逐例表；解析器拒绝原型链上的名字；两次执行的容器互不可见；失败与抛错路径上都 `dispose`。
- **S3-a**：G1、G3、G7、G8、G14。真库用例（EXPECT_DB 车道）：动作 CHECK 迁移的 up / down；授权事务在端口调用之前已提交（端口调用期间对该用户 `user_roles` 的 UPDATE 不被阻塞）；撤权后的下一次触发被跳过；配置版本退役后记 `operation_not_approved`；重新 `describeRead` 发现列集变化时记 `operation_changed`；两次并发保存不会留下没盖章的绑定（I 链 F1 的同一类用例）；无权限管理员的重试在任何调用之前被拒。
- **S3-b**：开关关时面板不渲染；开关关时打开一条已带该动作的规则仍完整显示、不被静默丢掉；选择器对集成列表的 403 显示为「看不到」而不是报错；编写模块的文案与服务端逐字节一致；日志里的一句话不含任何值；支持包剥掉绑定。
- **S2-b**：G11。真库用例：快照与挂起行同事务（中途失败两者都不在）；`start_approval` 的快照失败不产生审批实例；终态时快照被删；清扫；两条连接上的并发续跑只有一个认领成功。
- **S4-a**：八个转换各自经步骤走一遍的逐例表；全有或全无；错误 `details` 里的哨兵不出步骤；引擎纯度钉子；「扩展表泄漏进管道路径」的变异必红；管道与外部写试算的既有测试不变。
- **S4-b**：G13；发送路径的调用点与测试不变（`compileYidaSendDraft` 的调用方集合由静态测试钉住）。
- **S4-c**：映射表的增删改；`sourceField` 只能从源步骤的声明列里选；保存阻断原因与服务端一致。
- **S4-d**：两条连接加屏障的准入用例（检查点之间撤权，下一个检查点即停，照合成片的 C04）；响应带 `no-store`；摘要行不含值、不可重试、不计入规则监控；断开 / 取消 / 停机走同一套排空。

### 10.3 CI 陷阱清单

桥 ADR §11 列过的那几条在这里全部适用（`adr-automation-pipeline-bridge-20261103.md:345`）：插件新测试要登记 `test-chain.txt`；S1-a / S1-b 必动 `http-routes.cjs` 与 `index.cjs`，s6a 的两个来源 pin 要重算（`s6a-package-provenance-pins.json:72-73`）；真库用例的三处镜像；开关清单的扫描与显式测试（§7.8）；`core-backend/src/index.ts` 新增 `this.X` 要跑完整的 core-backend 单元套件；web spec 的登记文件；动到 `scripts/ops/__tests__` 时同步 `EXPECTED_OPS_TESTS_COUNT`（`.github/workflows/plugin-tests.yml:1145`）。本线另加两条：`yida-transform-spec.mjs` 只要被前端引用，就要进前端镜像与浏览器车道的闭包清单（附录一对 `yida-material-code.mjs` 的同一要求，`ipaas-yida-dev-baseline-addendum-20261106.md:28`）；规划器的导入钉子测试必须保持绿——它是「规划器不依赖引擎」的唯一机器证明。

### 10.4 哪些切片可以交给外部构建者

外部构建者指另一个只凭书面任务卡工作的 AI（例如 Grok）：它看不到仓库的历史与约定，不参与评审，也不会被告知任何客户事实。

- **可以交**：S3-b、S4-c、S4-d 的面板部分，以及 S4-b 的对拍语料与确定性生成器。共同点：纯前端或纯函数；零 IO；正确与否可以由我们自己写的测试判定；写错了的后果是界面不对或测试变红，而不是一道门开了。
- **不交**：S1-a、S1-b、S1-c、S2-a、S2-b、S3-a、S4-a、S4-b 的编译器与影子比对、S4-d 的路由。也就是凡涉及授权链、端口、凭据、写门、B2a、台账、租约、迁移、日志隔离、清单与 pin 的部分。迁移虽然机械，但撞前缀与链式导入是已知的坑，自己做更便宜。
- **任务卡必须包含**：冻结的 DTO 与类型；服务端校验文案的逐字节清单（前端编写模块要与之对拍）；合成样例数据；要改的文件清单与不许碰的文件清单；验收用的 spec 名单。**不包含**：任何客户值、现场事实、凭据位置、未公开的决策。
- **我们保留的**：评审、变异见证（对它交回的每一条测试先见红）、CI、合并。外部构建者交回的测试只算语料，不算守卫——守卫要在我们手里见过红才计数。
- 把任务卡交出去这个动作本身是否需要 owner 逐次批准，见 OQ7。

## 11. 不在本 ADR 范围内（每项附拉入条件）

- **S5 代码步骤（QuickJS 沙箱）**。拉入条件：出现一个有客户出处、用闭合转换集与扩展函数表达不了的转换，且 owner 裁定要做。到那时它唯一的出站能力必须是本线的 `ConnectionCallPort`，不另开网络。
- **S6 宜搭通用化（任意表 ↔ 宜搭的可配置映射）**。owner 2026-11-07 已裁定后置（R-87，`decision-register.md:92`）。拉入条件照该行：备料宜搭链路在 222 首发成功并稳定；或该客户提出第二个宜搭场景；或 owner 决定作为对外功能。在此之前本线不往通用部件里加备料专属假设，也不把转换步骤的宜搭产物接进发送路径。
- **S7 交付包（规则链与配置的导出 / 导入）**。拉入条件：第二个部署或第二个客户要复用同一条链。
- **可视化画布**。冻结基线明确不做（`ipaas-yida-dev-baseline-v2.3-20261106.md:738,973`）。拉入条件：有客户提出，且表单式编辑器在真实规则上已经不够用（出现分支内步骤或十步以上的链）。
- **真实外部写的发送切片**（§4.3 的契约）。拉入条件：一个有客户出处的、既不是宜搭也不是 K3 的写目标，加 owner 的 O ② 批准。
- **记录事件 / 入站 webhook 触发的连接调用**。拉入条件：OQ4 的裁定。
- **翻页、逐行循环、分支内的步骤**。拉入条件：一个真实的读超过单页行上限，或一个真实场景需要「对上一步的每一行再读一次」。翻页要先解决文末附注第 5 条。
- **既有动作引用步骤输出**（把读到的值写回记录、放进通知）。拉入条件：L3 之后客户要把链的结果落到表里或通知里。记录写是 A 类、通知是 B 类，各自要过自己的台账与白名单评审。
- **读源组合（两跳）作为具名操作**。拉入条件：一个需要「先解析、再读」的真实读。
- **链路失败的告警事件**。拉入条件：L3 之后客户要失败通知；在那之前失败体现在执行状态上。
- **多实例下的在途上限**（改用库里的租约）。拉入条件：部署不再是单 fork；届时同时要求打开调度主选举。
- **把「不跟随重定向」收敛成适配器的默认行为**。拉入条件：OQ5，加现场对「有无依赖跳转的源」的计数。
- **core `data_sources` HTTP 适配器写路径的审计**、接活或删除既有死表、用户自定义连接器种类、连接器市场、OAuth2：另案或不做，本线不碰。

## 12. 待 owner 裁定

1. **OQ1 线别与范围**。R-94 把这条线记作什么——既有两条线之一下的交付项（比照 R-50、R-69），还是对 R-42 的新例外？冻结基线那句「不做任意节点调任意 API」是否仍然成立？**建议**：成立，并且本 ADR 就是按它写的——步骤只能调用已批准的具名操作，不是任意 API；线别记为既有线下的交付项，不新增第三条线。
2. **OQ2 本线不含真实外部写**（Q4）。**建议**：确认。写开关只登记；发送切片等出现有客户出处的写目标时再以本 ADR 的增补立项，届时每个写操作逐项 O ②。
3. **OQ3 这类规则能建在哪些表上**。规则表没有租户列；I 链判断「这张表属于哪个租户」靠的是备料项目登记表（`automation-run-integration-job-rule-sheet.ts:16-21,32-40`）。**建议**：首片沿用同一个守卫——只有绑定租户名下、处于活跃状态的备料项目登记表上能建带 `call_connection` 的规则；等有了通用的「表 → 租户」权威来源再放开到其它表。代价是这条线在首期只服务备料项目表，这与章程的优先级一致。
4. **OQ4 记录事件与入站 webhook 触发**。**建议**：本线不放开。若以后放开：只限读操作；规则要显式声明「允许由记录事件驱动外部读」；业务键取自哪一列在保存时声明；每条规则有速率上限。
5. **OQ5 三项传输 / 凭据加固由谁交、交到哪一层**。（a）换源重绑（§7.5）：若 S0-b 在 S3-a 就绪时仍未进 main，是否由本线以 S1-c 交付？**建议**：是。（b）不跟随重定向：本线只对自动化调用方生效；是否改成适配器对所有调用方的默认行为？**建议**：先在现场数清有无依赖跳转的源，再定。（c）是否在自动化路径上额外拒绝回环 / 链路本地地址？**建议**：不加——那是登记权限的职责，加了会让工作台与规则两套口径。
6. **OQ6 宜搭 v3 在转换步骤上的做法**。本 ADR 取「编译到引擎 + 影子对拍，规划器为权威」。备选是「步骤内只调规划器，不做引擎表达」（零漂移，但转换步骤里就有一个宜搭专属的旁路）。**建议**：取前者，并保留 §6.3 的退路条款。
7. **OQ7 外部构建者**。是否同意把 §10.4 列出的四块以任务卡形式交给外部 AI？任务卡只含冻结接口与合成样例。**建议**：同意这四块；每张任务卡发出前给 owner 过目一次（对外发送属 O ④）。
8. **OQ8 HTTP 配置读路由要不要进 B2a 围栏**。今天它不在围栏内（§1.4）；本线只让自动化调用方出示用途。**建议**：另行裁定，不在本线——它会改变已武装部署上既有路由的行为，要先有现场事实。
9. **OQ9 手动预览是否随本线交付**（S4-d）。**建议**：交付。没有它，这条线做完之后客户能看到的只有日志里的行数。
10. **T 层默认、24h 可否决**：三个开关的名字；两个新动作的名字；`ConnectionCallPort` 是新端口而不复用既有端口；准入的连接器种类首批四个；同一系统在途上限为 1；读步骤不写意图行、不自动重试；截断即失败；`stepKey` 的形状与放在配置里；引用语法只有两种选择器、只做整值绑定；§5.6 的全部上限；快照只在挂起时写、终态即删、30 天兜底清扫；转换步骤全有或全无；宜搭方言首片只接受不拆分的分配；手动预览至多回 100 行；生产规则的身份沿用桥 ADR OQ7 的推荐值（租户绑定的服务账号）。

## 13. 考虑过的替代方案

- **嵌入 n8n（或任何外部编排引擎）**。不取。理由沿用桥 ADR 附录的三条（`adr-automation-pipeline-bridge-20261103.md:411-415`）：按它的许可，嵌进交付给客户的产品要另签商业协议；它的 HTTP 节点与 Code 节点可以直接出网、直接写，等于绕过「外部写默认关」「K3 永久禁写」「宜搭逐条批准」三道红线，在别人的代码里重建这些围栏的工作量不小于本线；它是一个带自己的数据库、账号与密钥的独立应用，客户机是 Windows 上的 pm2 单 fork。借的只是思路：凭据与流程分离、连接器是「操作清单 + 参数声明」、按步的执行历史、用固定样例试运行。
- **原始 HTTP 步骤**（规则里写 URL、动词、请求头、请求体）。不取。它让每个规则作者都能把登记系统里存着的凭据对准该系统的任何端点——包括写端点；动词不是读写的分界（§1.2 的 K3 事实），所以也没有可靠的办法只放行「读」；对内网目标又没有可用的 URL 守卫（§7.2）。`testConnection` 的 `path` / `method` 来自请求体这件事，当初就是作为一个洞被传输层的写门补上的（`http-adapter.cjs:17-26`）——原始 HTTP 步骤是把同一个洞做成功能。
- **单个通用 webhook 动作**（让 `send_webhook` 指向登记系统）。不取。它的守卫只许公网 https，根本到不了内网的登记系统（§1.5）；凭据写在规则配置的请求头里而不是凭据库里（`automation-executor.ts:5304-5306` 的注释记着这一点）；它不把响应数据交给下一步，成功时的输出只有状态码与尝试次数（`:5426-5431`）；没有具名操作，也就没有批准与退役。
- **为真实读另建一个代码资产目录**（合成目录的延伸）。不作为主路径。每加一个客户端点都要改仓库、走发版；而已批准的读源配置已经提供了版本、批准流与只收业务键的运行时。代码资产目录仍适合第一方的固定操作，合成片照旧。
- **把步骤输出放进 `step.output`，续跑时从日志读回**。不取。日志面保留业务值并流向界面、作业面与支持包（§1.1）；续跑读回的会是被擦过的值，而且没有办法区分「值本来如此」与「值被擦过」。
- **让 `IntegrationRunPort` 兼带数据**。不取（§2 ②）。
- **步骤内只调宜搭规划器**（S4 的备选）。保留为退路（§6.3、OQ6）。
- **BPMN 引擎**。不适用（R-75）。

## 附注：未能核实的事项

1. **R-94 的行文**。它不在基线提交的登记册里；本 ADR 只按任务口径引用编号（OQ1）。
2. **S0-b 在另一条线上的状态**。只核了 main：重定向拒绝与换源重绑在 `35dc8b272` 上都不存在（§1.2、§1.3）。那条线上的代码写到哪一步、何时进 main，没有核。
3. **n8n 的许可文本与节点行为**。引自桥 ADR 附录，本次没有重新核对。
4. **`plm:yuantus-wrapper` 的传输**。它经宿主的 PLM 能力出站，是否跟随重定向没有读；所以首批准入种类里没有它（§3.2）。
5. **读源配置在通用 `http` 种类上的覆盖**。插件的测试与夹具里 `requiredKind: 'http'` 只出现 2 处，没有读那些测试。另外 `list_page` 的页号是经 K3 适配器的选项名传递的（`read-source-probe-runtime.cjs:172-180`），通用 `http` 适配器的翻页只认 `cursor`（`http-adapter.cjs:410-418`）——通用 `http` 上能否翻页未核实；首片一步只读一页，不依赖它。
6. **B2a 模块**。全文两千余行，只读了头注释、用途表与守卫入口；新用途的键怎么填留给 S1-b。
7. **core `data_sources` HTTP 适配器写方法的可达性**（哪些路由、什么权限）。没有审计。
8. **222 现场**。是否已武装 B2a、有哪些已批准的读源配置、有无依赖跳转的源——都没有现场计数。
9. **「表 → 租户」的其它权威来源**。只核了 I 链那一个守卫的实现，没有做全仓的否定性搜索（OQ3 的建议因此取保守一侧）。
10. **没有运行任何测试。** 全部结论来自读码与 grep；另用一个不加载仓库代码的独立脚本核对了两条 JavaScript 语义：模板渲染对原型链上的名字与缺失路径的结果（§5.2），以及 `new URL` 对以 `/` 开头的路径的解析（§1.2）。
11. **切片规模**是估计，没有原型支撑。
