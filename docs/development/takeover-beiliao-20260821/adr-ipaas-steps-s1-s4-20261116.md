# iPaaS 步骤线 S1–S4：「调用连接」动作只走具名操作，加上步骤输出与转换步骤，把登记系统接进自动化规则（ADR 2026-11-16）

> **状态**：草稿 v5（2026-11-19）。v4（`aadb188f3`）经三轮独立评审修订（第一轮 17 条意见：12 条必改、5 条小项；第二轮 2 条：K3 档案例外、桥缺省 19 行；第三轮 1 条：§7.2 按种类说明路径守卫），终审结论 READY——**这个结论只对 `aadb188f3` 成立**。v5 在它之上按 owner 2026-11-19 在集成会话的原话「按建议执行」做了四处改动：白话终点（紧接本状态栏之后）、§12 记下 owner 的答复、按形态 B 重切切片（§10.1）、§11.1 记下封存自助栈与 S0-b 的处置。**v5 的增改未经独立评审。**未合并，合并须 owner 另批（R-94 ①）。开线裁定是登记册 R-94（owner 2026-11-16 原话「都按建议」，`decision-register.md:99`）：① 现在写 ADR、另开 PR、评审后另批合并；② 开发在宜搭剩余系列（R-93，`decision-register.md:98`）合并完后开工——2026-11-19 的「按建议执行」按计划评审决定 #7 收窄了这一条：S1-a、S2-a 可以带冻结的验收契约先在本地做（§10.1）；④ 真实系统读、任何写、开关、部署仍逐项批。标「T 层默认」的条目按章程默认前进、owner 24h 内可否决；标「待 owner 裁定」的条目在 §12 汇总。**真实客户读（O ①）、生产写与外部写回（O ②③）、上机与打开开关（O ④）都不在 T 层默认之内。对外部系统，本 ADR 交付的全部路径都只读；唯一的写是落点切片 S4-e 往宜搭的本地草稿库存一份发往 1 号槽（物料表测试副本）的草稿——默认关，打开后这一写属 O ②，它不发宜搭（§6.5）。**
> **线别**：R-94 ③ 已裁定（`decision-register.md:99`）——章程「最多两条线」不变（R-42，`decision-register.md:51`）；宜搭此前按 R-50 计入备料接管；**本线开工后与备料接管并列为两条线之一**，其它平台工作同时进行须 owner 另裁。本 ADR 只新增这一个文件、不改登记册。它与冻结设计基线「不做通用画布、任意节点调任意 API、任意代码节点」（`ipaas-yida-dev-baseline-v2.3-20261106.md:738`）的关系见 §12 OQ1。
> **基线**：代码引用冻结在 main `35dc8b272`（`35dc8b272f9f0a21ad95b77e360ad901ce1625a9`）——下文所有代码与既有文档的 `path:line` 都在这个提交上核过；新增文件只写路径不写行号。例外只有两个治理文档，取自 main `09dda5149`：登记册的 R-93 / R-94 / R-95 三行（`decision-register.md:98-100`；那个提交只在登记册第 97 行之后追加了这三行，此前各行的行号不变）与 Grok 接入说明（`ai-collaboration-grok-onboarding-20261116.md`，那个提交新增的文件）。本分支已合入 main `e0e4406bf`（`e0e4406bf36aba0b2e294d47a0e6ffea75879f5d`，2026-11-19；此前合入过 `7a98f388e`）。在 `35dc8b272` 与 `7a98f388e` 之间，本文引用到的行在三个文件里已经变了：`.github/workflows/integration-guard.yml`、`scripts/ops/global-history-flag-manifest.mjs` 与 `scripts/ops/global-history-flag-manifest.test.mjs`；到 `e0e4406bf` 又有五个被引用的文件变了：`yida-static-plan.mjs`、`yida-draft-compiler.mjs`、`yida-draft-plan-store.mjs`、`core-backend/src/integration/yida-owner-runtime.ts` 与 `core-backend/src/routes/integration-yida-owner.ts`。v4 已有的引用行号仍以 `35dc8b272` 为准；**v5 新增的引用一律标 `@e0e4406bf`**，行号在那个提交上核过。开工前按章程在届时的 main 上重核行号。
> **values-free**：不含主机、地址、口令、令牌、租户名、账号名或任何客户值，只指位置；「222」只是客户测试机在本目录文档里的既有代号。
> **关联**：R-42（两条线）、R-50（框定范式）、R-69 / R-83 / R-84 / R-90 / R-92（两座桥与 I 链）、R-75（BPMN 不适用）、R-87（宜搭 ↔ 任意多维表后置）、R-88（未定事项做成可配置）、R-93（宜搭剩余系列的常设合并授权，本线的开工条件）、R-94（开本线）、R-95（第三个实现方）；`adr-automation-pipeline-bridge-20261103.md`（先例，下称「桥 ADR」）；冻结设计基线 v2.3 §10 与附录一（`ipaas-yida-dev-baseline-v2.3-20261106.md`、`ipaas-yida-dev-baseline-addendum-20261106.md`）；`adr-yida-connection-test-20261028.md`。
> **来源**：owner 要的是 n8n 那样的交付模型——一个触发器、若干调用已登记系统的步骤、步骤之间传数据、再加转换；宜搭成为这个模型的一个使用方。两条约束：只借鉴 n8n 的思路、不用它的代码；每一个副作用都走同一个宿主侧的门。

## 白话终点：S4 落地之后客户能做什么（形态 B，owner 2026-11-19「按建议执行」）

> 这一节说的是终点，不是授权：下面每一个「能」都还要过本节最后列出的 owner 门。形态 B 的意思是：整条线围绕一个点名场景重切，带恰好一个落点（计划评审决定 #7，`plan-review-20261116/OWNER-DECISIONS-merged-20261117.md` #7，证据目录内）。

**点名场景，只有这一条**：指定备料项目的一行 → 已批准的 PLM 物料读取 → 物料表测试副本的草稿预览；一个落点。

**做完之后能做的**（开关打开、owner 逐项批过之后，只在客户自己的部署上）：

1. 在一张已登记、在役的备料项目表上建一条规则（§12 OQ3 的守卫就是「指定备料项目」的那一半）。规则的第一步引用一份集成管理员已经批准的 PLM 物料读——一份读源配置，种类 `data-source:sql-readonly`：客户的 PLM 在现场就是按这个种类登记的只读数据源（`222-deploy-window-runbook-20260901.md:725`、`customer-delivery-guide-20260904.md:315` @e0e4406bf）。第二步是一步宜搭物料映射，按物料表的 v3 模板编草稿，**只调宜搭规划器**（§6.3，OQ6 取退路）。
2. 规则的所有者在预览面板里点选这张项目表的一行。服务端用这一行的一个声明列（比如图号）当业务键读一次 PLM，再把这一行的其它声明列与读回来的物料字段一起交给规划器。面板里看到读回来的物料字段，以及规划器编出的那一行宜搭草稿（§6.4，S4-d）。这些值只留在面板的内存里，日志里只有行数与结果码。
3. 同一个人——他还必须是宜搭的锚点 owner——再点一次「存为测试副本草稿」。服务端把同一条链从头重跑一遍，不收浏览器送回来的任何行，把结果经既有的宜搭 owner 草稿入口存成一份草稿，目标固定为 1 号槽，也就是物料表（报工）的测试副本（R-71 ①，`decision-register.md:76`；代码里 1 号槽就是物料测试副本，`yida-owner-runtime.ts:29-33` @e0e4406bf）。这份草稿之后在既有的宜搭 owner 面板里可以逐行预览（§6.5，S4-e）。

**做完之后仍然不能做的**：

- **不写任何生产表**：不写备料表、项目表或任何多维表记录；读到的值不回写记录。唯一落库的值是第 3 步那份草稿，它进的是宜搭的本地草稿库，不是业务表。
- **不发通知**：不发消息、不发钉钉待办、不发 webhook。
- **不发宜搭**：S4-e 只存草稿。要把草稿发到测试副本，走既有的宜搭 owner 发送路径，按 R-50 / R-70 / R-71 逐次另批；发送时由发送编译器自己重算，不读本线的任何产物。本线不打开、不改宜搭的发送开关。正式表单（2–6 号槽）一律不能当落点。
- **场景规则不定时跑**：它引用了点选的那一行，所以只能在预览里跑，不能启用（§6.4）。别的定时规则可以有，但只记行数、不落值。
- **种类与规模有限**：首片只收 `data-source:sql-readonly`，不调 HTTP、K3 或桥种类的登记系统（§3.2）；一步至多 99 行、不翻页（§4.6）；宜搭映射只接受不拆分的分配（§6.3）。

**还剩哪些 owner 门**：

- **合并**：本 ADR 的合并（R-94 ①）与每个切片的合并都另批。S1-a、S2-a 已获准先在本地做；S1-c 要等 S0-b 归属的裁定；S1-b 起等本 ADR 合并（§10.1）。
- **落点切片 S4-e 是新的保证类切片**：独立核验，每条守卫都要见证红（§7.10 G18）。
- **它有自己的新开关** `INTEGRATION_AUTOMATION_TEST_COPY_DRAFT_ENABLED`：默认关、只认原文 `true`，登记进 `scripts/ops/global-history-flag-manifest`（§7.8）。在任何部署上打开它属 O ④；**打开之后它会写表**（宜搭本地草稿库），这一写属 O ②，逐次另批。
- **它借用的宜搭草稿入口自己要宜搭发送开关为 `true` 才收草稿**（`yida-owner-runtime.ts:194-197,223,334-343`，`index.ts:673` @e0e4406bf）。所以 S4-e 能用，前提是 owner 已经按 R-50 / R-70 打开了那个开关。那是既有的 O 层门，本线不替它做决定，也不绕开它（§6.5）。
- **对客户 PLM 的每一次首读**（预览里那一次也算）属 O ①（§7.9）。规则所在表的守卫要求 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 恰为 `'true'`（OQ3，§7.8）。
- **上机与打开任何开关**属 O ④。

**裁决记录**

| # | 问题 | 裁决 | 层 | 落在哪里 |
|---|---|---|---|---|
| Q1 | 「具名操作」从哪来 | **不新建目录。** 读操作 = 已批准的读源配置（`integration_read_source_configs`，`draft → approved → retired`，`read-source-config-store.cjs:24-29,379-382`）；写操作 = 已批准的写目标配置（`write-target-config-store.cjs:14-20`），本线不交发送。合成目录原样不动——它自己写明「不是通往真实读取的垫脚石」（`automation-operation-catalog.ts:14-16`） | T 层默认 | §1.4、§4.2 |
| Q2 | S1 是什么 | 把运行时读路由 `readSourceConfigsRead`（`http-routes.cjs:8559-8629`）的那条链抽成接受主体上下文的 req-less 受治理入口，再由插件向 core 登记一个新端口 `ConnectionCallPort`。**一条链、两个调用方**，与桥 ADR 的 1b-i / 1b-ii 同形 | T 层默认 | §3 |
| Q3 | 读和写怎么分 | 按操作所在的目录分（读源配置 / 写目标配置），**不按 HTTP 动词**——K3 的读本来就是带体的 POST（`k3-wise-webapi-adapter.cjs:2106-2112`）。传输层「有体或非安全方法即写」的独立判定照旧成立（`http-adapter.cjs:263-272`），S3 不给它加旁路。K3 与桥两个种类的读不经那道通用写门：K3 的读腿只被适配器里一张不闭合的写端点词表拦着，可证明的保证是客户侧的只读账号（§4.3、§7.7） | T 层默认 | §4.3 |
| Q4 | 本线交不交真实的外部写 | **不交。** 引用写目标配置的规则保存一律 400、与开关无关；写的设计（门的操作词、台账、围栏、owner 门）在本 ADR 锁定，发送切片另批。理由：本目录文档里记录在案的外部写目标只有宜搭（有自己的受治理路径）和 K3（永久禁止），而章程规定通用能力不预先建设 | owner 2026-11-19 确认（§12 OQ2） | §4.3、§7.9、§11 |
| Q5 | 运行身份 | 授权主体 = 规则创建者 + 其唯一在役租户，保存时由服务端盖章、每次触发实时复核；保存 / 启用 / 重试的操作者自己也要过同一道检查（沿用 R-92 的 B1 与 R1–R3，`automation-service.ts:238-260,291-322`）。数据面读身份 = 绑定主体本人 | T 层默认 | §4.5 |
| Q6 | 哪些触发器可以带 `call_connection` | 首片只有 `schedule.cron`（必带 IANA 时区）与 `schedule.interval`（≥ 15 min），cron 相邻两次触发同样不得近于 15 分钟；规则不得带条件；只在顶层、不进分支。记录事件与入站 webhook 触发待裁 | T 层默认（放开 = §12 OQ4） | §4.4 |
| Q7 | 步骤之间的数据走哪 | 独立的运行内通道（把合成片的 `RunValueStore` 一般化，`automation-run-values.ts:118-204`）；`step.output` 只放宿主从枚举与计数重建的摘要。原因：日志面只擦密钥形的值、**保留业务字段值**（`core-backend/src/multitable/automation-log-redact.ts:16-21`，`automation-log-service.ts:340-346`） | T 层默认 | §5 |
| Q8 | 持久化什么 | **首批什么都不持久化。** 输出只活在一次执行的内存里；带新动作的规则不得与任何会挂起的动作同处一条规则（保存即拒），所以首批不存在跨挂起的引用。跨挂起的快照后置，它必须满足的契约先记下 | T 层默认 | §5.4、§11 |
| Q9 | 续跑与重试 | 首批没有续跑（Q8）。整次重试不恢复读输出——读步骤重读。续跑恢复随快照一起后置：两条续跑道、三个挂起点、整条规则的指纹都要逐一规定 | T 层默认 | §5.4、§5.5 |
| Q10 | 转换步骤 | 新动作 `transform_records`：纯函数、零 IO，宿主在 core，把 `transform-engine.cjs` 当作单个纯函数注入（`yida-automation-preview.ts:148-194` 的做法） | T 层默认 | §6 |
| Q11 | 宜搭 v3 映射怎么「表达在它上面」 | **v5：步骤内只调规划器**（owner 2026-11-19 就 OQ6 取 ADR 自带的退路）：宜搭方言的转换步骤只调用静态规划器、发布规划器一侧的行，不做引擎表达；发送路径照旧不读转换步骤的产物。原稿的「编译成映射规格 + 两个闭合扩展函数 + 影子对拍」挪到 §11（拉入条件照 R-87） | owner 2026-11-19（§12 OQ6，取退路） | §6.3、§11 |
| Q12 | 出网守卫 | 现有两套守卫都是「只许 https + 禁内网」（`webhook-ssrf-guard.ts:98-114`，`egress-guard.ts:149-187`），而登记系统按设计允许 http 与内网（`http-adapter.cjs:67-76`），不能套用。本线的围栏按种类分别成立（§2 ⑧）：目的地只能是已登记系统的 origin；`http` 上「请求的路径与方法 = 已批准配置」**不是现有链的事实**，由 S1-b 强制；K3 的读路径与方法来自已批准配置，**例外**是 `material` 对象在登记系统里的条目选了具名档案（今天唯一的是只存物料档案）——那时线上走的是档案字面量的路径、方法与键字段，所以「请求 = 已批准配置」在 K3 上同样由 S1-b 强制（选了档案的条目即拒）；登录与取令牌的路径来自系统配置；桥与 SQL 只读源不用配置里的路径。不跟随重定向；origin 或认证身份变更必须重给认证材料。**v5（形态 B）**：首片只准入 `data-source:sql-readonly`，它不经 HTTP；上面各 HTTP 种类的围栏作为锁定契约保留，随该种类准入一起交付（§3.2、§11） | T 层默认 | §3.2、§7 |
| Q13 | 开关 | 四个新 env 开关（v5 加了落点的那一个），默认关、只认原文 `true`、登记 flag manifest；其中写开关只登记不读 | T 层默认（打开 = O 层） | §7.8 |
| Q14 | 真实客户读怎么放行 | O ①：开关、读源配置的批准、每个系统 / 操作逐项由 owner 批；K3 种类另加客户侧只读账号这条硬前置。部署已武装 B2a 时再加登记——**一条登记只授权一次读**，不是长期授权（形态见 OQ8） | O | §7.9、§8 |
| Q15 | 哪些切片可以交给第三个实现方（Grok） | 按 R-95 与接入说明：只接书面任务卡里边界清楚的切片——本线是动作配置面板、编写模块、标签与摘要及其 spec（v5：对拍语料随 OQ6 的退路挪到 §11，不再有）；守卫、凭据、锁、迁移判定、出站写闸、日志隔离、开关清单与车道接线一律不给 | 已由 R-95 裁定（`decision-register.md:100`） | §10.4 |

---

## 0. 为什么

1. **规则今天拿不到外部系统的一个值。** 两座桥（R-69）把两台引擎在「作业」这一层接上了，但 `run_integration_job` 必须是规则里唯一的动作（`automation-run-integration-job.ts:241-249`），端口只回 values-free 摘要（`integration-run-port.ts:57-66`）；执行上下文里没有任何步骤结果（`automation-executor.ts:1614-1640`），模板数据只由记录与触发事件组成（`:1438-1447`）。「读一下登记系统 → 用读到的值做下一步」这件事没有落点。
2. **零件其实都在，只是散着。** 已批准的读配置与只收业务键的运行时路由（§1.4）、出站写门与 K3 永久围栏（§1.2）、凭据库（§1.3）、带尝试令牌的意图台账（§1.6）、运行内传值容器（§1.8，只服务合成片）、转换引擎与宜搭规划器（§1.7）。本线做的是接线，不是新建。
3. **借思路、不借代码。** 许可与围栏两条理由沿用桥 ADR 附录（`adr-automation-pipeline-bridge-20261103.md:411-415`）；R-94 ④ 把同一结论写进了裁定——只借思路、不嵌代码，理由是许可限制、且它的 HTTP / Code 节点会绕过本系统的出站闸（`decision-register.md:99`）。本 ADR 自己没有重新核对 n8n 的许可文本与节点行为，见文末附注。
4. **一个门。** 新步骤的每一次出网都只有一条路：core 动作 → 端口 → 插件受治理入口 → 适配器传输层。动作代码里不出现第二个 HTTP 客户端，这一条由 CI 的静态扫描钉住（§7.10 的 G2）。

## 1. 现状与约束（读码结论）

### 1.1 自动化引擎

- **动作与触发器闭集**：动作 17 种（`automation-actions.ts:6-38`，`ALL_ACTION_TYPES :40-58`），动作对象只有 `{ type, config }` 两个键（`:311-314`）；触发器 12 种（`automation-triggers.ts:6-18`）。新动作类型要改 DB CHECK，最近一次是 `zzzz20261106111300_add_run_integration_job_automation_action.ts:14-39`（沿用 `zzzz20260720120000_add_write_approval_form_values_automation_action.ts:28-43` 的形式）。**CHECK 只约束 `action_type` 这一列**；`actions` 列是没有约束的 jsonb（`zzzz20260414100000_extend_automation_rules.ts:26-27,51-58`），多动作规则由编辑器把 `actions[0]` 镜像进这一对旧列（`automation-run-integration-job.ts:221-225`）。
- **执行**：`execute` 用触发事件构造上下文（`automation-executor.ts:2113-2127`），`executeActions` 顺序执行、第一步失败就把其余标成 `skipped`（`:2426-2432,2606-2618`），分发是一个 `switch`（`:2998-3079`）。`ExecutionContext` 的字段是执行 / 规则 / 表 / 记录标识、记录数据、触发事件与台账身份（`:1614-1640`）——**没有步骤输出**。
- **模板**：`renderAutomationTemplate` 用正则 `[\w.]+` 取路径（`automation-executor.ts:330-334`），`lookupTemplateValue` 逐段取属性、遇到数组即返回 undefined、不防原型链（`:309-317`）。模板数据在八处各自组装——执行器里七处（`:1189,1246,1317,1438,5923,6602,7274`），审批桥服务里一处（`automation-approval-bridge-service.ts:154-165`）——来源都是记录、标识与触发事件，外加从触发事件里取出的作业摘要（`automation-executor.ts:1891-1896`）。其中 `start_approval` 的表单映射有两处对**不带花括号**的表达式直接按裸路径取值（`automation-executor.ts:1448-1455`，`automation-approval-bridge-service.ts:167-178`）。
- **步骤身份**：结构路径是下标（顶层 `"0"`，分支子步 `"${i}.branch.${k}.${j}"`，`automation-step-key.ts:22-29`），分支键允许 `-`（`automation-service.ts:712`）。动作身份 = (结构路径, 动作类型, sha256(规范化配置)[:16])（`automation-action-idempotency.ts:58-64`）；规则指纹对每个动作取这个身份再汇总（`automation-rule-fingerprint.ts:102-112`）。
- **三个会落值的面**：执行日志的 `steps` / `trigger_event` / `rule_snapshot` 经 `redactValue` 落库（`automation-log-service.ts:334-361`）；作业面的 `result` 同样经 `redactValue`（`automation-job-service.ts:79,212`）；HTTP 响应用同一个函数（`automation-log-service.ts:415-423`）。`redactValue` 只擦密钥形的字符串与认证类键名，文件头明写「业务字段值保留供诊断」（`core-backend/src/multitable/automation-log-redact.ts:16-21,121-143,162-179`）。
- **试运行**：`simulationDisposition` 是带 `never` 穷尽检查的 `switch`（`automation-executor.ts:1010-1035`），模拟模式下落库的步骤被压成 `{ dryRun, dispatched:false }`（`automation-service.ts:443-461`）；真发测试只放行 A / B 两族与五个控制动作，其余一律 `TEST_RUN_ACTION_UNSUPPORTED`（`automation-retry-eligibility.ts:18-39,61-87`）。
- **挂起与续跑**：挂起点有三个——顶层的 `wait_for_callback`、分支内的 `wait_for_callback`（保存校验允许它，`automation-service.ts:1260-1261`；分支内的 `start_approval` 被拒，`:1262-1264`）与 `start_approval`（执行器 `automation-executor.ts:2457-2508`；三个钩子在 `automation-service.ts:4575,4590,4605`）。续跑有**两条道**。令牌道（`wait_for_callback`）：从日志表读回执行、重建上下文——记录重新读、触发事件用落库的脱敏版、前序步骤只剩日志里的脱敏结果（`automation-service.ts:4914-4952`；`automation-suspension-service.ts:13-14` 的 D4）；全部校验先于单次令牌认领，校验不过是 409、令牌不消耗（`automation-service.ts:4927-4939`）。审批道（`start_approval`）：由审批完成事件驱动，**没有令牌、也没有调用方**；规则缺失、停用或漂移时是把执行记成终态失败（`failApprovalBridgeExecution`，`automation-service.ts:5056-5073`），通过后接着跑规则的尾部（`:5123-5144`）。两条道的漂移守卫用的是同一个指纹，它只哈希动作**类型**序列（`automation-suspension-service.ts:63-66`；两条道各比一次，`automation-service.ts:4843-4847,5069-5073`）——看不见配置改动。审批桥的行是先插入、再创建审批，两步之间没有事务包着（`automation-approval-bridge-service.ts:341-373`）。
- **整次重试**：`retryExecution` 用落库的触发事件对当前规则从第 0 步重跑（`automation-service.ts:4784-4788`），规则配置变了即 `RULE_CHANGED`（`:4697-4712`）；已发送的 B 类步骤得到的是不带输出的 `alreadyApplied`（`automation-executor.ts:4137-4139,4149-4165`）。
- **保存门**：`createRule` 里一串逐类校验（`automation-service.ts:1914-2009`），触发器专用的动作白名单（`:500-512,621-624`）、并行分支白名单（`:713`）、条件分支的嵌套限制（`:1229-1296`；这一处是黑名单——分支里的动作只验类型在闭集内，`:1214`，再点名拒三种，`:1254-1264`，新类型不加任何东西就会被放进去）；按钮路由有自己的闭合动作表，表外类型答 `BUTTON_ACTION_NOT_ENABLED`（`multitable-button.ts:99-109,170-173`）。

### 1.2 数据工厂：管道、http-adapter 与出站写门

- **适配器登记**：九个连接器种类在激活时登记（`plugin-integration-core/index.cjs:425-433`）；`createAdapter(system, deps)` 把 `deps` 原样交给工厂（`lib/contracts.cjs:223-236`），`http` / K3 / bridge 三个适配器都接受注入的 `fetchImpl`（`http-adapter.cjs:228`，`k3-wise-webapi-adapter.cjs:1781`，`bridge-agent-readonly-adapter.cjs:308`）。
- **http-adapter**：`baseUrl` 允许 http 与 https、不限内外网（`http-adapter.cjs:67-76`）；路径必须是相对的、被补上前导 `/`（`:78-90`），`buildUrl` 用 `new URL(path, baseUrl)` 解析（`:127-131`）——**以 `/` 开头的路径从 origin 根解析，`baseUrl` 自带的路径前缀不参与拼接**。这是 `http` 适配器的事实，不是三个适配器共有的：桥同样用 `new URL(path, baseUrl)`（`bridge-agent-readonly-adapter.cjs:207-209`），K3 则把基路径拼在端点前面（`buildEndpointUrl`，`k3-wise-webapi-adapter.cjs:429-442`）。`http-adapter` 的 `fetch` 调用没有 `redirect` 选项、即默认跟随（`http-adapter.cjs:292-297`）；K3 与 bridge 适配器同样（`k3-wise-webapi-adapter.cjs:1844-1849`，`bridge-agent-readonly-adapter.cjs:329-334`）。`http-adapter` 的 `testConnection` 的 `path` / `method` 直接取自请求体（`http-adapter.cjs:350-369`）。
- **出站写门**：默认拒绝，只认部署文件 `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS`（`outbound-http-write-gate.cjs:142`），按**声明的身份**（系统 id / 名称 / 种类 + 对象 + 操作）匹配、从不按 URL（`:476-486`；URL 形的键在加载时按名拒绝 `:241-246`）。操作词是闭集 `{upsert, request}`（`:187-197`），**未知操作默认拒绝**，条目缺省只授权 `upsert`（`:370-372`）。策略不可传参：门自己读 env，调用方只给主体、不给策略（`:59-77`）；不缓存（`:88-90`）。两个强制点互相独立：`upsert` 的第一条语句（`http-adapter.cjs:440-454`）与传输层 `requestJson`（`:263-277`，有体或方法不在 GET / HEAD / OPTIONS 即为写，`outbound-http-write-gate.cjs:203,219-222`）。
- **K3 永久围栏**：按连接器种类判定、四层各自拒绝、无参数无 env（`k3-external-write-permanent-fence.cjs:16-35,99-107,118-121`）。它**不覆盖**一个 `baseUrl` 恰好指向 K3 的通用 `http` 系统——那个洞由写门补（`outbound-http-write-gate.cjs:27-31`）。四层全部落在 apply / upsert 面上（`k3-external-write-permanent-fence.cjs:24-35`），**不覆盖读腿**：K3 的读是带体的 POST，不经通用写门，把读路径与写端点分开的只有适配器里一张 12 个词的词表，适配器自己的注释写明 VOCABULARY「NOT CLOSED」、「an unlisted verb still passes」（`k3-wise-webapi-adapter.cjs:263,271-274,294-295`；读意图只在命中词表时被拒，`:400-413`）。
- **runner**：通用 HTTP 目标的非试算写在 runner 层先过写门（`pipeline-runner.cjs:518-519`），C6 生命周期在第一行（`:714,950`），转换在 `:814`，唯一的 `targetAdapter.upsert` 在 `:1112`。
- **受治理入口（1b-i）**：只有两个——`runGovernedStockPrepPull` 与 `runGovernedPipeline`（`http-routes.cjs:7936,8147,15971-15972`）；主体上下文恰好是请求上的六个字段（`:2131-2145`）；中止 / 检查点的接缝在 `governed-entry-checkpoint.cjs:69-110`，「两者都不传 = 行为不变」。

### 1.3 外部系统与凭据库

- **登记表**：`integration_external_systems`（`external-systems.cjs:21`）；`kind` 与 `role` 创建后不可改（`:837-845`）；`config` 的更新是对存量的顶层 PATCH（`:407-410,850-854`）；服务端独占的键 `dataSourceOwnerId` 由登记处盖章、客户端值被丢弃（`:30-34`）。
- **凭据**：写入时整体加密进 `credentials_encrypted`（`external-systems.cjs:412-422,816`），对外响应只给 `hasCredentials` 与指纹（`:286-311`）。解密点：`git grep -n "\.decrypt(\|parseAdapterCredentials("` 在插件的非测试代码里命中外部系统凭据的两处——适配器加载路径（`:363-373,1093`）与 `gip-system-identity-read.cjs:502`（后者的上下文没有读）；规则（core 一侧）拿不到明文；插件的路由处理器经适配器加载路径拿到的系统对象带着解密后的凭据，在进程内交给适配器、不序列化也不回给调用方（`http-routes.cjs:8599-8600`，`external-systems.cjs:1093-1094`）。新值用宿主安全服务的 `enc:` 格式，旧的 `v1:` 仍可读（`credential-store.cjs:20-22,149-182`）；「生产环境缺密钥即拒绝启动」只在没有宿主安全服务的自洽路径上成立（`credential-store.cjs:62-71,184`），有宿主安全服务时旧密钥是用到才取的（`:155,169-170`；插件激活时把宿主安全服务传给凭据库，`plugin-integration-core/index.cjs:319-322`）。
- **换源不换凭据**：更新时不带 `credentials` 即保留旧密文（`external-systems.cjs:913-915`），而同一次更新可以改 `config.baseUrl`（`:850-854`）——**旧凭据会跟着新 origin 走**。**认证材料不只在密文里**：`config.headers` 被 `http` 与 K3 两个适配器并进每一次请求（`http-adapter.cjs:233-237`，`k3-wise-webapi-adapter.cjs:1835`），K3 的 `authorityCode` / `authMode` 可以来自配置（`k3-wise-webapi-adapter.cjs:1923-1924`），桥的密钥可以是配置点名的一个进程环境变量（`sharedSecretEnvVar`，`bridge-agent-readonly-adapter.cjs:189-196`）、放它的请求头名也来自配置（`:198-204`）。配置更新是顶层 PATCH、没给的键原样继承（`external-systems.cjs:407-410`），所以这些材料同样会跟着新 origin 走，而且库里可以一行密文都没有。三个适配器取 origin 的键序也不一样：`http` 与 K3 是 `baseUrl || url`（`http-adapter.cjs:231`，`k3-wise-webapi-adapter.cjs:1785`），桥是 `baseUrl || bridgeUrl || url`、全空时落到内置的本机缺省地址，并且只接受本机地址（`bridge-agent-readonly-adapter.cjs:43,120-143,311`）。`git log 35dc8b272 -i --grep="S0-b"` 0 命中；提交说明里含 `rebind` 的提交没有一个改登记处的凭据逻辑（其中两个是 webhook 守卫 #5619、#5649）。结论以上面的代码为准。
- **删除 × 指针写的锁协议**：读源配置、管道等四类指针写入方先对系统行取 KEY SHARE，删除方 FOR UPDATE 后计数（`external-system-pointer-lock.cjs:15-28`）。它管的是悬挂引用，不管换源。
- **另一条 HTTP 路径（不是 S1 的底座）**：core 的 `data_sources` 有自己的 `HTTPAdapter`，`insert` 直接 `client.post`（`HTTPAdapter.ts:428-435`），凭据键含 `bearerToken`（`DataSourceManager.ts:33`）。谁能到达它的写方法本 ADR 没有审计（文末附注）；S1 不建在它上面，也不得把它当传输。

### 1.4 具名读已经存在：读源配置；写目标配置只到静态预览

- **两层模型**：顾问写配置并批准，运行时层只消费**已批准**的配置、只提供配置声明的那一个具名业务键，「从不给原始端点、过滤条件、请求体或响应路径」（`read-source-read-runtime.cjs:5-10`）。四种读模式、GET / POST 两种方法（`read-source-config.cjs:26-27`）；路径守卫拒绝 scheme、`//`、反斜杠、`..` 与一切百分号编码（`:98-116`），执行时再查一次（`read-source-read-runtime.cjs:393-395`）。
- **版本与生命周期**：每一行是一个按内容定键的版本（`read-source-config-store.cjs:102,244-258`），状态只走 `draft → approved → retired`（`:24-29`），运行时查找只认 `approved`（`:379-388`）。
- **运行时路由**：`POST /api/integration/read-source-configs/:id/read`（`http-routes.cjs:37`）。处理器的顺序是：`requireAccess(req,'read')`（`:8560`）→ 请求体严格只许 `inputs` 与 `rowSource`（`:8563-8584`）→ 取已批准配置（`:8587`）→ 用后端凭据上下文加载系统并比对种类（`:8599-8603`）→ `executeConfiguredRead`（`:8605-8612`）→ 返回 `{ evidence, data }`，其中 `evidence` 是 values-free 的、值只在 `data` 下（`:8613`）。输入是闭集 `{ key, pageIndex }`（`read-source-probe-runtime.cjs:84-118`），请求由配置拼出、调用方的键只落在预定的位置（`:172-199`）。配置行按（租户, workspace）**精确**查找、没有回退（`read-source-config-store.cjs:82-86,362-371`）；workspace 是调用方给的查找提示，取自 input、query 或 params（`http-routes.cjs:1817-1819`）；工作台保存配置时带着它自己的 workspace 提示（`apps/web/src/services/integration/readSourceConfigs.ts:562-570`）；外部系统的查找只从非空提示向租户级行回退一步，空提示不加宽（`external-systems.cjs:998-1003`）。
- **界限**：这条链上**生效的行上限是 10**——计划里的 `rowCap` 取平台常量（`read-source-probe-contract.cjs:20,193`），HTTP 处理器只把 `rowSource` 交给执行器、不传行上限（`http-routes.cjs:8611`），读源配置的键白名单里也没有行上限这一项（`read-source-config.cjs:66-77`）。`read-source-read-runtime.cjs:45-46` 的 1000 与 10 是**受信后端调用方**显式给 `rowCap` / 页号时的天花板（`:210-213,220-228`），不是缺省值；请求可达的页号上限在 `read-source-probe-runtime.cjs:57`。全仓非测试代码里执行器的调用点是三处，都在插件 `lib/`——HTTP 路由、读源组合（它不带第三个参数，`read-source-composition-runtime.cjs:104-108`）与备料的只读源运行；显式抬高行上限的只有最后这一个（`stock-preparation-readonly-source-run.cjs:310-313`；它按种类取页大小，`:15-24,54-75`）。超时是平台常量 5 秒、不可由请求改（`read-source-probe-contract.cjs:19`，`read-source-read-runtime.cjs:379-382`）；**超时只是放弃等待，不中止底层请求**——适配器接口不收 signal（`read-source-read-runtime.cjs:417-422`）。达到行上限时证据里有 `capReached`（缺省的原始容器面在 `read-source-read-runtime.cjs:487-488,528`，适配器记录面在 `:359`）——行数**恰好等于**上限也算，它分不出「刚好这么多」与「还有更多」；而且它只和**我们自己的**上限比：源自己分了页、或适配器把请求的上限压低了，它都不知道。那些信号——适配器实际采用的上限、`done`、`nextCursor`、源声明的总数——只在一个不可枚举的内部页对象上，给受信的后端调用方（`:277-319,534-543`）。
- **数据面有三种形状，不是一种**：`list_page` / `single_record` 给 `data.containers.primary`；`detail_with_lines` 给 `header` 与 `lines` 两个容器（别名表 `read-source-probe-contract.cjs:23`；`read-source-read-runtime.cjs:361-364,530-533`）；`resolver_lookup` **绕过容器面**，返回 `data.resolver = { target, value }`（`read-source-read-runtime.cjs:443-460`；`read-source-resolver-evaluator.cjs:79,109`），而它的计划照样只报一个 `primary` 容器（`read-source-probe-contract.cjs:130-132`）——所以**不能拿 `plan.containers` 判断数据面的形状**。四种模式都是运行时支持的（`read-source-read-runtime.cjs:71`）。
- **两个取行面**：缺省的 `raw_containers` 在适配器的原始响应上按配置的容器路径取行；`adapter_records` 取适配器自己规整、分页后的记录，只对 `list_page` / `single_record` 开放（`read-source-read-runtime.cjs:201-209`）。`data-source:sql-readonly` 的适配器不产出原始响应（`data-source-sql-readonly-source-adapter.cjs:657-663`），在缺省面上只能得到 `RESPONSE_UNRECOGNIZED`（`read-source-read-runtime.cjs:433-435`；路由注释写的是同一件事，`http-routes.cjs:8576-8580`）。
- **写目标配置**：模型与存储已有（`write-target-config.cjs:12-28`，`write-target-config-store.cjs:14-20`），运行时只有**零网络的静态预览**，`canApply` 被有意做成不可达（`write-target-dry-run-runtime.cjs:6-30`）。存储是休眠的：登记处的注释写明「除 `__tests__/` 外没有任何地方实例化它，生产库里没有行」，并且接活它的那一刻必须把它计入系统删除守卫（`external-systems.cjs:70-73`）。`git grep -n -i "write-target\|writeTarget"` 对 `http-routes.cjs` 与插件的 `index.cjs` 0 命中：没有任何路由。
- **潜伏的动作契约**：`connector-action-contracts.cjs` 把「连接器动作」定义为围绕**已有适配器方法**的元数据、写操作一律 `gated`（`connector-action-contracts.cjs:3-7,11-20,214-237`）；除它自己的测试外没有调用方（`git grep -n "connector-action-contracts"` 只命中 `package.json`、`test-chain.txt`、一处注释与测试文件）。
- **B2a 读围栏**：用途是闭集（`b2a-trial-registry.cjs:205-218`），未登记的入口在已武装的部署上默认拒绝（`:1206-1213`），env 未设即休眠（`:16-21`）。**配置读不在围栏内**：`git grep -n "assertB2a\|b2aRegistry\|b2aTrialRegistry"` 在插件 `lib/` 的非测试代码里只命中六个文件（围栏模块自身、`http-routes.cjs`、`pipeline-runner.cjs`、备料的表动作与预检、SQL 只读源适配器）；`read-source-*` 各文件一处也没有，`external-systems.cjs` 里只有注释。`http-routes.cjs` 里三个守卫函数的调用行是 5183、7107、7335、7356、7421、7459、7466、8041、9023、9168、9478、9600、9762、9974、15763，没有一行落在配置读处理器的 `http-routes.cjs:8559-8629` 之内。SQL 只读源适配器只在调用方把授权对象随 `createAdapter` 传进来时才加两条下限（`data-source-sql-readonly-source-adapter.cjs:614-622`），配置读不传（`http-routes.cjs:8609`）。**一条登记只授权一次源读**：`forbidReuse` 必须为真、`sourceReadOperationLimit` 必须是 1，加载时逐条校验（`b2a-trial-registry.cjs:751-758`）；认领以 `runId` 为键，同一个 Run 重入放行、另一个 Run 一律拒绝（`:63-69,1104-1113,1149-1154`）；登记表在路由注册时建一次（`:22`）。

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

1. **「S4 = 把宜搭规划器搬到 transform-engine 上，补 #6711 的缺口」**：那几种转换已经由 v3 在规划器内部实现（§1.7），而规划器带导入钉子、还要在浏览器里跑，**不能反过来依赖引擎**。所以 S4 不是搬家，是对拍。→ Q11。（v5：OQ6 取了退路，连对拍也不做，步骤内只调规划器，§6.3。）
2. **「要为真实读新建一个具名操作目录」**：已批准的读源配置就是具名、有版本、有批准流的读操作，而且已有只收业务键的运行时路由（§1.4）。→ Q1。
3. **「出网守卫可以复用」**：两套守卫都拒 http 与内网（§1.5），登记系统两者都要。→ Q12。
4. **「S0-b 之后适配器已经拒重定向、换源会重绑」**：在本基线上都不成立（§1.2、§1.3）。那项工作在另一条线，状态见文末附注。→ §7.3、§7.5、OQ5。
5. **「台账的重武装不看行数、结果写不验尝试身份」**：已由 #6715 修正（§1.6）。本线直接依赖修正后的语义。

## 2. 决策清单（锁定）

① **具名操作 = 一个已批准的配置版本。** 规则里存的是引用 `{ kind, configId, workspaceId, contentKey }`，不是端点。规则作者只能在已批准的版本里选，不能写路径、动词、请求头或请求体；配置由持 `integration:write` 的人写并批准（`http-routes.cjs:8474-8477,8528-8529`），这是「谁能让系统访问哪个端点」与「谁能把它排进规则」两件事的分界。引用里的 `workspaceId` 是**查找范围、不是权限**：读源配置按（租户, workspace）精确查找、没有回退（§1.4），所以引用必须带上找到这一行时用的那个 workspace——调用方给提示，服务端以精确查找证明后盖章（含空值），每次触发用盖章的值重查（§4.1）。

② **core 持动作，插件供端口。** 动作类型、保存校验、身份绑定、步骤结果、运行内通道在 core；读本身——授权链、配置查找、凭据加载、适配器调用——留在插件，只经插件激活时登记的端口到达。新端口叫 `ConnectionCallPort`，**不复用** `IntegrationRunPort`：后者的返回值是闭合的 values-free 摘要（`integration-run-port.ts:57-66,90-117`），把数据面塞进去就破坏了它唯一的性质。

③ **一条链、两个调用方。** HTTP 路由与端口调用同一个 req-less 受治理入口；不得出现「端口版」的第二套检查，插件不得对收到的主体上下文加宽、补默认或另读权限（桥 ADR §2 ③ 的原话，这里照用）。自动化调用方与 HTTP 调用方之间唯一有意的差别是页内行上限（§3.1 的 `rowCap`）：它不碰主体上下文，也不碰任何一项权限。

④ **对外部系统只读。** 端口上没有写方法；引用写目标配置的规则保存即 400、不读任何开关；写开关只登记不读。这是结构上的，不是靠开关关着。**v5 的唯一例外是内部的一写**：落点切片 S4-e 经既有的宜搭 owner 草稿入口，往宜搭的本地草稿库存一份发往 1 号槽测试副本的草稿（§6.5）。它不经端口、不发宜搭，有自己的默认关开关，打开后属 O ②。

⑤ **步骤数据不进日志。** 步骤产生的值只进运行内通道；`step.output` 由宿主从枚举与计数重建，键集闭合。引用语法是闭集（§5.2），解析器是新写的严格函数，不复用 `lookupTemplateValue`。

⑥ **首批不持久化步骤输出。** 输出只活在一次执行的内存里；带新动作的规则不得含任何会挂起的动作（保存即拒，按位置遍历，含分支内的 `wait_for_callback`）。跨挂起的快照与续跑恢复后置（§11），它必须满足的契约记在 §5.4——恢复不信任快照；两条续跑道与三个挂起点逐一规定；整条规则的指纹对不上即拒；被脱敏的单元格被引用即失败关闭。

⑦ **转换是纯函数；宜搭的权威不搬家。** `transform_records` 没有 IO。v5 按 OQ6 的退路：宜搭方言的步骤只调规划器、发布规划器一侧的行，不在引擎上另做一份表达（那份表达与对拍挪到 §11）；发送路径继续用发送编译器自己编译，不读转换步骤的产物。

⑧ **围栏不靠 URL 检查，并且按种类分别成立。**（v5：形态 B 首片只准入 `data-source:sql-readonly`，它没有 HTTP，适用的只有本条最后一项。下面关于 `http`、K3 与桥的规定是锁定的契约，随该种类准入一起交付，§3.2、§11。）四个种类共有的：目的地只能是已登记系统的 origin；规则作者与步骤数据到不了路径、动词、请求头与请求体，步骤数据只能填配置声明的业务键；不跟随重定向；origin 或认证身份变更必须重给认证材料（§7.5）；出站写门不加任何旁路或新参数。「路径只来自已批准配置」**不是现有链的共同事实**，要一个种类一个种类地说：
- `http`：登记系统里同名对象的对象形条目会盖过已批准的路径与方法，并把它自己的查询参数与请求头并进请求（§3.2）。「请求 = 已批准配置」这条性质由 S1-b **强制**——带这类键的对象条目即拒，外加 wire 上的（方法, 路径）断言——不是继承来的。
- `erp:k3-wise-webapi`：读路径与方法来自已批准配置，**只有一个例外**：被引用对象是 `material`、而登记系统里它的条目带 `profile` 键选了具名档案时，适配器把档案当作合并的底（`k3-wise-webapi-adapter.cjs:716-735`），合并之后对只存（save-only）档案再把档案拥有的请求键——含 `readPath`、`readMethod`、`keyField`——从档案字面量重钉一遍，并删掉档案不声明的键——含读模式、列表上限与读请求体模板（`:77-90,734,747-769`）。今天登记的档案只有一个，就是只存的物料档案，它有自己的读路径与 `POST`（`k3-wise-document-templates.cjs:177-200,240-242`）。于是已批准的路径与方法到不了 wire：单条读的证据照样答成功，列表读以 `READ_SOURCE_PROBE_REJECTED` 失败（§3.2）。所以 K3 上「请求 = 已批准配置」同样由 S1-b **强制**——选了档案的条目即拒，外加 wire 上的（方法, 路径）断言——不是继承来的。登录与取令牌的路径、（未选档案时）读请求体的模板来自系统配置。「K3 写永久拒绝」说的是 `upsert` / apply 面；读腿只被一张不闭合的词表拦着（§7.7），可证明的保证是客户侧的只读账号。
- `bridge:legacy-sql-readonly`：配置里的路径与方法根本不参与请求——永远是向本机 Bridge Agent 的 `POST /query/<对象名>`。
- `data-source:sql-readonly`：没有 HTTP；对象名与等值过滤经宿主的数据源门面。

⑨ **四个开关**（§7.8）：连接调用、连接调用的写（只登记）、步骤输出与转换，以及 v5 的落点（测试副本草稿）。保存时与每次触发时都读原文；关着的动作在触发时记 `skipped(action_disabled)`，不静默成功。本文的 `skipped(…)`、`not_started(…)`、`failed(…)` 都是 `output.outcome(reason)` 的写法，不是步骤状态：三者的步骤状态一律是 `failed`，规则停在这一步（§4.8）。

⑩ **词表与表的变化**：动作 CHECK 增 `call_connection`、`transform_records`（各一支迁移，形式同 `zzzz20261106111300…:14-39`）；**本线不新增表**（步骤输出的快照表随 S2-b 后置，§11；v5 的落点写的是既有的宜搭本地草稿表，经既有入口，§6.5）；B2a 用途闭集增一项（`b2a-trial-registry.cjs:205-218`）。**出站写门的操作词表在本线不动**（`outbound-http-write-gate.cjs:194-197` 仍是 `upsert`、`request` 两项，由测试钉死）。

⑪ **首片的放置限制**（都在保存时校验）：新动作只在顶层、不进任何分支；规则不带条件；触发器只许两种定时，相邻两次触发不得近于 15 分钟（cron 同样算，§4.4）；一条规则里的 `call_connection` 至多 8 步（§5.6）；不与任何会挂起的动作同处一条规则——`start_approval`、顶层的与分支内的 `wait_for_callback`，判定按位置遍历分支子步（后置的 S2-b 交付后解除，§11）；不上按钮路由；真发测试不支持；v5 的点选行声明（§6.4）只在预览与存草稿两条路由上可用，带它的规则不能启用。每一条限制都写明解除它的切片或问题编号，不留「以后再说」。

## 3. S1：连接请求服务与 req-less 受治理入口

### 3.1 受治理入口 `runGovernedConfiguredRead`（切片 S1-a，只重构）

把 `readSourceConfigsRead`（`http-routes.cjs:8559-8629`）的整条链原样抽成接受主体上下文的函数，签名与两个既有入口同形：`(principalContext, { configId, workspaceId?, inputs, rowSource }, options?)`。链上的每一步都不变、顺序不变：读层权限 → 请求体闭合校验 → 只取已批准版本 → 准备读计划 → 用后端凭据上下文加载系统并比对种类 → 执行 → `{ evidence, data }`。`runAs:'user'` 仍由入口内部的 `scopedAdapterInput` 盖（`:1832-1838`），调用方盖不了。第二个参数里的 `workspaceId` 是可选的查找提示：它进 `scopedInput` 的 input 位，而 `resolveWorkspaceId` 本来就先读 input、再读 query 与 params（`:1817-1827`）；配置行与外部系统两次查找用同一个值。HTTP 处理器不传它，仍只从 query / params 取。

- HTTP 处理器改成「用 `req` 构造上下文（`http-routes.cjs:2138-2145`）后调用、不传 `options`、也不传 `workspaceId`」。**对外逐字节不变**：请求形状、状态码、成功体、错误体都不变，以既有路由测试加一组失败路径的响应体快照为验收。
- `options` 至多五个可选成员，**全部缺省就是今天的行为**（HTTP 处理器一个都不传）。**v5 按切片分**，`acceptance-S1-a.md` 也按这个写：
  - S1-a 只交 `signal` 与 `checkpoint`，外加第二个参数里可选的 `workspaceId`。它的入口对 `options` 做闭合键集校验，只收这两个键，别的键（包括下面三个名字）一律在入口拒绝。
  - `readPurpose` 与 `rowCap` 随 S1-b 加入。
  - `transport: 'strict'` 随第一个 HTTP 种类的准入加入（§3.2、§11）。

  每一次加键都是闭合键集的一次显式扩充，带它自己的拒绝测试。前四个只能收紧；第五个 `rowCap` **会放宽**页内行上限，所以把它放宽什么、凭什么放宽单独写明：
  - `signal`、`checkpoint`：既有接缝，在加载凭据之前、每次出站读之前各过一次检查点（`governed-entry-checkpoint.cjs:94-110`）；都不传时不多一个 await（`:69-88`）。
  - `transport: 'strict'`：一个闭合的枚举值，只能收紧。适配器是在入口自己的闭包里建的（`http-routes.cjs:8609`），执行器只带一个参数调用它（`read-source-read-runtime.cjs:400-401`），所以 §3.2 的传输包装只能由入口装上；调用方给的是这个字面量，**给不了函数**。入口在这个模式下还做两件事：建适配器之前按种类算出本次调用允许的（方法, 路径）清单，并拒绝会改写请求的系统侧对象条目（§3.2）；把包装看到的闭合事实——出站次数、是否见到 3xx、是否被出站写门拒绝、包装自己拒绝了哪一个请求以及是哪一类（origin 不符 / 不在清单内）——连同执行器的内部页对象，以**不可枚举**成员挂在返回值上（执行器对内部页就是这么做的，`read-source-read-runtime.cjs:534-543`）。HTTP 处理器只取 `evidence` 与 `data` 两个成员回给调用方（`http-routes.cjs:8613`），响应字节不变。
  - `readPurpose`：一个 B2a 用途常量，只能多加一道围栏（§3.2）。
  - `rowCap`：只接受**一个值**——入口模块自己导出的常量 `CONFIGURED_READ_AUTOMATION_ROW_CAP`（T 层默认 100）；别的数、字符串、函数一律在入口拒绝。它不来自规则配置、端口入参或任何请求：规则与端口契约里都没有这个键（§3.3、§4.1）。给了它，执行器走的是既有的受信执行参数（`read-source-read-runtime.cjs:210-213`），效果有三处，都要知道：① 页内行上限从 10 变成 100；② 列表读的叠加层 `maxListLimit` 与发给源的 `limit` 随之变成 100（`read-source-probe-runtime.cjs:151,174`）；③ 原本不带 `limit` 的 `single_record` 请求也会带上它（`read-source-read-runtime.cjs:240,252-254`）。连接调用服务对 `http`、桥、SQL 只读源三个种类传它，**对 K3 不传**——K3 的列表上限缺省是 10、超过即抛（`k3-wise-webapi-adapter.cjs:191,1090-1098`），备料的只读源运行对 K3 也停在 10（`stock-preparation-readonly-source-run.cjs:22-23,72-74`），本线不去改 K3 看到的请求形状。「不传」与「传 10」不是一回事（后者会走 ③），所以这里写的是不传。取 100 的理由：它等于本线唯一的行集消费方——宜搭规划器——自己的行上限（`yida-static-plan.mjs:6-9`），也是手动预览的回显上限（§6.4）；更大的读要翻页，归 §11。
- 入口加入 `governedEntries` 的冻结导出（`http-routes.cjs:15971-15972`）。s6a 的 `pluginHttpRoutes` 来源 pin 必须重算（`s6a-package-provenance-pins.json:73`）。

### 3.2 连接调用服务 `lib/connection-call-service.cjs`（切片 S1-b）

这是「同一个宿主侧的门」在插件里的实体：端口的每次调用都从这里进，再进 3.1 的入口。它决定入口那五个可选成员怎么填，并负责**只对自动化调用方成立**的那几件事：

- **读开关**：`INTEGRATION_AUTOMATION_CALL_CONNECTION_ENABLED` 在出站之前再读一次原文（第三个读取点，§7.8）。
- **准入的连接器种类是闭集**：首片 `http`、`erp:k3-wise-webapi`、`bridge:legacy-sql-readonly`（三者的适配器都接受注入的 `fetchImpl`，传输包装因此装得上，见下一条）与 `data-source:sql-readonly`（不走 HTTP，凭据在规范连接里，`external-systems.cjs:1065-1091`）。表外种类记 `skipped(kind_not_admitted)`。`plm:yuantus-wrapper` 的传输在宿主的 PLM 能力里，本 ADR 没有核它的重定向行为，核实之前不纳入。加一个种类 = 改这张表的源码 + 一条传输评审。
  - **v5（形态 B）：首片的准入表只有 `data-source:sql-readonly` 一项。** 场景要读的是客户的 PLM，而客户的 PLM 在现场就是按这个种类登记的只读数据源（`222-deploy-window-runbook-20260901.md:725`、`customer-delivery-guide-20260904.md:315` @e0e4406bf）。插件自己认作 PLM 来源的种类有三个（`stock-preparation-readonly-source-run.cjs:77-80` @e0e4406bf），另两个是 `plm:yuantus-wrapper`（未核传输，见上）与桥。现场今天用的是不是仍是这一种，要随附注 8 的现场计数再核一次。`http`、`erp:k3-wise-webapi`、`bridge:legacy-sql-readonly` 三种挪到 §11，拉入条件是一个用到该种类、有客户出处的场景。
  - 因此本节下面只对 HTTP 种类成立的几条——传输包装（不跟随重定向、同源、（方法, 路径）清单）、系统侧对象条目的拒绝、出站写门拒绝的识别——**作为锁定契约保留，不随首片交付**，随第一个 HTTP 种类的准入一起交付并见证红（§10.1）。SQL 只读源上服务**不传** `transport`。对它成立的是：B2a、在途上限、两个面分开回、适配器建立时的拒绝、完整性判定，以及 §4.5 的属主检查。
- **不跟随重定向、只去登记的 origin、只发批准过的请求**：服务调用入口时固定传 `transport: 'strict'`，入口据此在 `createAdapter(system, { principal, fetchImpl })` 里装上一个包装（`lib/contracts.cjs:223-236` 把 `deps` 交给工厂）。包装对适配器发出的**每一个**请求做三件事。一，加 `redirect: 'manual'`：3xx 于是不会引出第二个请求。它在适配器眼里只是一个普通的非 2xx，而配置读的证据词表是闭合的、没有「重定向」这一项（`read-source-probe-contract.cjs:45-61`），所以由包装自己把「见到 3xx」记进内部通道（§3.1），服务据此归为 `failed(redirect_refused)`。二，发出前断言请求 URL 的 origin 等于登记系统的有效 origin（按该适配器自己的键序取，§7.5）。三，断言（方法, 路径）在入口为本次调用算出的闭合清单里，清单外的请求不发出。路径比较的是 URL 规范化之后的 pathname，清单项按同一规则规范化：已批准路径的守卫只拒 `..` 段、不拒单点段（`read-source-config.cjs:112,116`），而单点段在 URL 解析时被去掉——假 fetch 实测，`http` 与 K3 两个适配器发到 wire 上的都是去掉之后的路径。二、三两条是包装**自己**的拒绝：被拒的请求不发出，事实记进内部通道（§3.1），服务对外归为 `failed(origin_refused)` 或 `failed(request_not_allowed)`（§4.8），不落到 `source_error`。K3 的登录 / 取令牌腿排在读腿之前（`k3-wise-webapi-adapter.cjs:2103-2106,2333-2336`），读腿被拒时同一次调用可能已经发出过登录请求，所以这两个原因的 `outcome` 是 `failed` 而不是 `skipped`。清单按种类：
  - `http`：恰好一项——已批准配置的方法与路径（路径按适配器的规则补前导 `/`）。
  - `erp:k3-wise-webapi`：读腿一项——已批准配置的方法与路径，按适配器自己的拼接规则拼上基路径（`k3-wise-webapi-adapter.cjs:429-442`）。**这一项只从已批准配置算，永远不得用档案的路径或方法加宽**：选了档案的条目在前一道就被拒（下文「系统侧不得改写已批准的请求」），包装若看到档案的路径，说明前一道失灵了，正确的结果是 `request_not_allowed`，不是把档案路径补进清单。登录与取令牌两条腿的路径来自系统配置（`k3-wise-webapi-adapter.cjs:1797-1798`），清单按系统配置列出它们；对这两条腿成立的只是「同 origin、路径在清单里」，**不是**「等于已批准配置」。
  - `bridge:legacy-sql-readonly`：一项——`POST /query/<对象名>`（`bridge-agent-readonly-adapter.cjs:416-427`）。已批准配置的路径与方法不参与，包装断言的是适配器的这个固定形状。
  - `data-source:sql-readonly`：不经 HTTP，没有包装；它的边界是宿主数据源门面的只读入口。

  管道与 HTTP 路由不经过本服务，行为不变。
- **系统侧不得改写已批准的请求**（`http` 与 `erp:k3-wise-webapi` 两个种类；`describeRead` 查一次，每次调用再查一次）：配置读把已批准的路径 / 方法叠加到登记系统里同名对象的条目上时，用的是「存量在前、叠加在后」的合并（`read-smoke.cjs:347-352`），叠加层带的是 `operations` / `readPath` / `readMethod`，列表与明细模式再加读模式与列表上限——没有 `path` / `method` / `query` / `headers`（`read-source-probe-runtime.cjs:143-170`）；而 `http` 适配器取的是 `objectConfig.path || objectConfig.readPath`、`objectConfig.method || objectConfig.readMethod`，并把条目里的 `query` 与 `headers` 并进请求（`http-adapter.cjs:409-422`）。于是一个带 `path` 的对象形条目会让请求打到**存量路径**上：那个路径只过适配器较弱的相对路径检查（`http-adapter.cjs:78-90`，不拒 `..`、百分号与查询串），执行时的再检查查的又是计划里的路径、不是适配器真正用的那个（`read-source-read-runtime.cjs:393-395`）。本服务的处理是**拒绝，不是替换**：`http` 系统上被引用对象的存量条目若是对象形且带 `path` / `method` / `query` / `headers` 任一键，即 `skipped(system_overrides_request)`、零出站；字符串形或不存在的条目不受影响——合并时它们本来就被叠加层整个取代（`read-smoke.cjs:347`）。取拒绝而不取替换的理由：替换会让规则读到的地址与集成管理员在工作台里验证过的地址不是同一个，而且没有人会知道。代价也写明：一个已经靠对象形 `path` 条目给管道供数的对象名，不能同时充当自动化读的对象——要么改条目，要么另起一个对象名。**K3 上的同类情形是具名档案。** 叠加层同样合并在存量条目之上（`read-smoke.cjs:347-352`），存量 `material` 条目里的 `profile` 键因此留在合并结果里；适配器据此以档案为底，合并之后重钉 `readPath` / `readMethod` / `keyField`、删掉叠加层带来的读模式与列表上限（§2 ⑧ 的引用），单条读用的就是重钉之后的 `objectConfig.readPath` 与 `readMethod`（`k3-wise-webapi-adapter.cjs:2322-2342`）。假 fetch 实测：已批准的是另一条路径（`POST` 或 `GET`）时，wire 上是档案的读路径加 `POST`、证据答成功；列表读以 `READ_SOURCE_PROBE_REJECTED` 失败、零出站。本服务对 K3 同样取**拒绝**：被引用对象是 `material`、存量条目是对象形且带 `profile` 键（不论取值）即 `skipped(system_overrides_request)`、零出站；判定照适配器自己的谓词（`:708,716`），经不解密的访问器读存量配置。不取「（方法, 路径）等于档案字面量就放行」：档案还重钉了键字段、删掉了读模式与请求体模板，路径与方法相同不等于请求相同；按键是否存在来拒，比按档案内容放行更严，也不随以后新增的档案而变（重钉只对只存档案发生，`:734,747`；带别的档案的条目同样被拒）。代价：首片准入的两种读模式在 K3 上只收 `material` 对象——列表读与单条明细读各自拒绝别的对象（`:941-948,1039-1044`），单条读的请求不带列表与 BOM 的路由标记（`read-source-probe-runtime.cjs:196-198`），走不进另外三支读模式（`k3-wise-webapi-adapter.cjs:983-1036`）——所以没有「另起一个对象名」的退路——选了档案的登记系统不能同时充当自动化读的系统，要读就另登记一个不选档案的 K3 系统。这一条与上面的清单断言是两层：去掉拒绝，清单断言仍会拦下打到存量路径或档案路径的请求（K3 上的前提是清单只从已批准配置算，见上）。
- **基路径不是围栏**：在 `http` 与桥两个种类上，`baseUrl` 的路径前缀不约束解析结果；K3 相反，适配器把基路径拼在端点前面（§1.2）。本线两种规则都不改——改了会让既有的已批准配置指向别处；围栏是 origin 加上面那张（方法, 路径）清单。
- **B2a**：服务固定传 `readPurpose` = 新的闭合用途 `automation.call-connection.read`；入口在取到配置行、知道系统 id 之后、加载凭据之前，以它向 `assertB2aReadAuthorization` 出示。需要看系统配置时用不解密的那个访问器，它就是为「必须先于凭据加载的守卫」准备的（`external-systems.cjs:1020-1035`）。休眠部署返回 `null`、字节不变（`b2a-trial-registry.cjs:1192-1197`）；已武装而无登记即 `skipped(read_authorization_required)`。**一条登记只授权一次读，不是长期授权**（§1.4）：已武装的部署上，每一次触发的每一个 `call_connection` 步骤都是一个新的 Run。因此两条硬规定。一，出示给围栏的 `runId` 取「本次执行 id + 步骤的结构路径」，每次触发、每个步骤唯一；**不得**从规则 id、配置 id、系统 id 或任何跨触发稳定的值派生——那会把「同一个 Run 重入放行」（`b2a-trial-registry.cjs:1104-1113`）变成对「只许一次」的永久旁路。二，在 owner 就 OQ8 裁定之前，T 层默认是：**已武装的部署上，定时触发的读一律 `skipped(read_authorization_required)`，不出示也不消耗任何登记**；只有手动预览（§6.4）出示用途，而且每一次预览读各要一条自己的登记。数据范围那一格怎么填（取配置 id 还是对象名）留给 S1-b 评审——本 ADR 读了该模块的头注释、用途表、守卫入口、登记加载时的那两条校验与认领函数，没有读它的数据范围解析。
- **在途上限**：同一 (租户, 系统) 同一时刻至多一个在途调用，进程内计数；多出来的记 `skipped(busy)`。槽位在底层读**落定**时才释放，不是在 5 秒超时返回时——超时不中止请求（§1.4）。部署是 pm2 单 fork（`ecosystem.config.cjs:60-61`）；多实例时这条不成立，要换成库里的租约（§11）。
- **两个面分开回**：`evidence` 原样是配置读自己的 values-free 证据；`data` 是唯一带值的成员。错误只回闭合的类别——适配器错误的 `details` 可能带响应体（`http-adapter.cjs:329-336`），不出本服务。`errorClass` 只取证据面已经钳过的值：证据里的 `errorCode` 是闭集成员，集合外的一律被钳掉（`read-source-probe-contract.cjs:45-61,212-216`）。它**从不**取适配器抛出的原始错误码或类名——桥适配器的错误码可以来自对端的响应体，它自己的注释写明那不是闭合的（`bridge-agent-readonly-adapter.cjs:29-30,226-228,339`）。
- **出站写门的拒绝要单独认出来**：它的状态码是 403（`outbound-http-write-gate.cjs:166`），而配置读的错误分类先看状态码，401 / 403 一律归成认证失败，然后才看错误码（`read-source-probe-runtime.cjs:231-240`）。所以经这条链根本看不到 `OUTBOUND_HTTP_WRITE_DISABLED`，运维只会读到「凭据错了」。入口因此在自己建的适配器外面包一层 `read`：抛错时把错误码与写门的闭合拒绝码集合比对（`outbound-http-write-gate.cjs:158-162`；只比对、原样再抛），命中即记进内部通道，服务对外归为 `skipped(write_gate_refused)`——零出站，因为写门的检查在任何请求发出之前（`http-adapter.cjs:274-277`）。
- **适配器建立时的拒绝同样要单独认出来**：执行器是在 `try` 之外建适配器的（`read-source-read-runtime.cjs:400-401`，`try` 从 `:408` 起），所以适配器在建立那一刻的拒绝——K3 的读路径命中写端点词表就是这样被拒的（`k3-wise-webapi-adapter.cjs:796-798`）——是以**异常**而不是证据的形式回到入口的。HTTP 处理器对它的行为不变（原样抛出）。入口在 `transport: 'strict'` 下接住这个异常、记进内部通道，服务对外归为 `skipped(adapter_refused)`：适配器还没建起来，一个请求都没有发出。
- **完整性在这里判定**：服务读入口返回值上的内部页对象，按 §4.6 的四条信号得出「这一页完整与否」的布尔与闭合原因，只把这两样交给 core；页对象本身（游标、行指纹、各项计数）不出服务。

### 3.3 端口契约（`packages/core-backend/src/core/connection-call-port.ts`）

```
ConnectionCallPort = {
  describeRead({ context, operation })            // 保存、启用、重试与每次触发都用：零出站、不解密凭据
    -> { ok: true, systemId, requiredKind, workspaceId, contentKey, mode, rowSource, requiredNamedInputs, columns[] }
     | { ok: false, reason }                      // 闭集，见 §4.8
  callRead({ context, operation, inputs, rowSource, signal, checkpoint, automation })
    -> { status, reason?, errorClass?, evidence, capReached, complete, durationMs, data?: { columns[], rows[] } }
}
```

- 登记与解绑照 `IntegrationRunPort`：`context.services.connectionCall.register(port)` 只对 `plugin-integration-core` 开放，按插件名记 owner，卸载 / 重载即解绑，缺席即 `port_inactive`（`integration-run-port.ts:132-156`；`core-backend/src/index.ts:3710-3718,1838-1841`）。
- **键集恰好这两个方法**，由测试按集合相等钉住：没有写、没有 `testConnection`、没有「按路径请求」。
- `operation` = `{ kind, configId, workspaceId, contentKey }`（§4.1）。`automation` = `{ executionId, stepPath, origin }`，`origin` 是闭集 `schedule` / `steps_preview` / `steps_draft`（v5 加了最后一项，S4-e 的存草稿路由，§6.5），由 core 填：服务用它拼 B2a 的 `runId`，并在已武装的部署上区分定时读与人点击触发的读（§3.2；`steps_draft` 与 `steps_preview` 同等对待）。契约里**没有**行上限、超时、路径、方法这些键。
- **准入的读模式是闭集，按数据面的形状定**（§1.4）：首片只收 `list_page` 与 `single_record`——数据面是单个 `primary` 容器，服务取它组成 `rows`。`detail_with_lines`（表头与明细两个容器）与 `resolver_lookup`（绕过容器面、只回一对 `{ target, value }`）在 `describeRead` 时即拒，`reason` 是 `mode_not_admitted`。判定用配置的 `mode` 本身，**不用** `plan.containers`——解析模式的计划也报一个 `primary` 容器。`resolver_lookup` 最自然的映射是一行一列的输出，后置到 §11：首片的键值查找用 `single_record` 加 `first.<列>` 就够，多候选的裁决规则是另一件事。
- **取行面由服务端按种类盖章，不由规则作者选**：`data-source:sql-readonly` 固定 `adapter_records`（它没有原始响应，§1.4），其余三个种类固定 `raw_containers`——工作台缺省读用的那个面，也就是集成管理员验证字段映射时看到的那个面。`describeRead` 把它随 `mode` 一起返回，保存时盖进配置，触发时比对。
- **列名必须是扁平标识符**：`columns` 取自配置 `fieldMap` 的目标名，而那里的校验允许点号、冒号、连字符与数字开头（`read-source-config.cjs:84-86,124-128`），执行器自己的注释也写明 `constructor` / `toString` / `valueOf` 都是会被接受的目标名（`read-source-read-runtime.cjs:466-468`）。`describeRead` 因此拒绝任何目标名不满足 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`、或等于 `__proto__` / `prototype` / `constructor` 的配置，`reason` 是 `columns_not_admitted`。不这样做，`first.<列>` 落不进引用语法（§5.2），带点号的列对引用语法与引擎的点号路径都有歧义。
- 每一行恰好是声明列的全集：配置读的投影把解析不到的目标写成 `null`、不省略键（`read-source-read-runtime.cjs:148-166`），而运行内通道要求一行的键数等于声明列数（`automation-run-values.ts:94`）。
- core 对返回值再消毒一次：未知键丢弃；`data.rows` 逐行投影到 `columns` 上，只收有限 JSON 标量（规则同 `automation-run-values.ts:88-112`）；投影失败是 `failed(output_not_scalar)`，不是「尽量收」。
- `describeRead` 做的是入口链的前半段，外加只对自动化成立的准入，顺序是：读层权限 → 按（绑定租户, `operation.workspaceId`）精确查找已批准版本（§4.1）→ 系统存在、种类相符且在准入表内 → 读模式准入 → 列名准入 → 系统侧对象条目不得改写请求（`http` 的对象形改写键、K3 的档案条目，§3.2）→ SQL 只读源的属主（§4.5）。系统一侧的检查都经不解密的访问器（`external-systems.cjs:1035-1053`）。`columns` 取自配置的 `fieldMap` 目标。它让保存时与运行时用**同一条**插件侧授权链。I 链的操作者检查用的是 core 侧谓词，作业权限本身留在插件入口里（`automation-run-authority.ts:16-18`），登记册把「保存时检查不含插件权限梯」记成了开开关的前提（R-92 的 11-13 补记，`decision-register.md:97`）；这个差距在这里不重复。

### 3.4 S1 不做的事

不加写方法；不把管道改到新服务上（管道继续直接用适配器登记表，两边共享的是适配器传输层的写门与 K3 围栏）；不改 `http-adapter.cjs` 的解析规则与默认重定向行为（那是对所有调用方的行为变更，归 §7.3 与 OQ5）；不接 core 的 `data_sources` HTTP 适配器（§1.3）。

## 4. S3：动作 `call_connection`

### 4.1 配置形状（闭合键集，保存时逐键校验，执行时重新解析）

```
{ stepKey?,                                        // §5.1；不带则只报计数、不发布输出
  operation: { kind: 'read_source_config', configId, workspaceId?, contentKey },
                                                   // workspaceId：客户端给的是查找提示，服务端以精确查找证明后盖章
                                                   // contentKey：服务端盖章
  inputs:    { key?: string | '{{steps.<k>.output.first.<列>}}', pageIndex?: 1..10 },
  rowSource: 'raw_containers' | 'adapter_records', // 服务端按种类盖章（§3.3），客户端值丢弃
  connection: { systemId },                        // 服务端从配置行盖章，仅供展示与在途上限的键
  output:     { columns: string[] },               // 服务端从 describeRead 盖章
  binding:    { principalId, tenantId } }          // 服务端盖章，客户端值丢弃
```

- v5 的两处增补（点名场景用，§6.4）：一，规则的第一个 `call_connection` 可以多带一个闭合键 `rowInput: { columns: { <行列名>: <字段 id> } }`；二，`inputs.key` 还可以是 `'{{row.<行列名>}}'`（§5.2）。带 `rowInput` 的规则不能启用。
- 除此之外的任何键 → 保存 400。**负对照必须逐个有测试**：`url`、`baseUrl`、`host`、`path`、`method`、`headers`、`body`、`query`、`timeoutMs`、`credentials`、`rowCap`、`limit`。超时与行上限都不是配置项：前者是配置读的平台常量（§1.4），后者是入口自己的常量（§3.1）。
- `operation.kind` 是闭集 `{ read_source_config, write_target_config }`。**`write_target_config` 在本线保存一律 400、不读开关**——开关只是预留的名字与登记，一次提前的开关翻转造不出「可保存却没有实现」的规则（桥 ADR §3.1 对 `apply_when_ready` 的同一做法）。读源组合（两跳，`http-routes.cjs:44`）不在词表里，要加另议。
- `operation.workspaceId`、`contentKey`、`rowSource`、`connection`、`output`、`binding` 都是服务端盖章：保存时调用 `describeRead`，把返回值写进配置；触发时重新 `describeRead` 并比对，`contentKey`、取行面或列集对不上即 `skipped(operation_changed)`，按盖章的 workspace 找不到那一行即 `skipped(operation_not_found)`。「声明 = 事实」每次都验，不是只在保存时。
- **workspace 的规则**：读源配置按（租户, workspace）精确查找、没有回退（§1.4），而端口的主体上下文若照 I 链那样构造，`query` 与 `params` 是空的（`automation-run-authority.ts:123-142`）——只凭配置 id 会去查 workspace 为空的那一格，查不到工作台带着 workspace 提示保存的配置。所以分三步。提示：保存请求里的 `operation.workspaceId` 是调用方给的**查找提示**（编辑器列出已批准配置时用的那个范围，可以为空）。证明：`describeRead` 用（绑定租户, 该提示）做精确查找，找到才算数。盖章：把**那一行自己的** `workspace_id`（含空值）写进引用。之后每次触发，core 把盖章的值随 `operation` 交给端口，服务把它放进入口第二个参数的 `workspaceId`（§3.1），配置行与外部系统两次查找都用它。入口不能从配置 id 反推 workspace（查找是精确范围的），所以它只能来自提示。它是查找范围、不是权限：HTTP 路由今天对任何带读层权限的调用方也接受任意提示。外部系统一侧与 HTTP 路由相同：非空提示未命中时向租户级行回退一步，空提示不加宽（`external-systems.cjs:998-1003`）。本线不改任何一处的查找语义。
- **`contentKey` 钉不住系统一侧**：它只哈希配置行的内容（`read-source-config-store.cjs:102-105`），登记系统的 origin、对象条目、K3 的登录路径与请求体模板都不在里面。本线**不**在规则里盖一个系统侧的摘要：origin 是低熵值，它的哈希可以被枚举还原，而规则配置是会进日志与界面的面（§1.1），那等于把主机地址的派生物写进日志；要它不可还原就得引入一把持久的密钥，这不是本线要建的东西。顶替它的是三件**每次都发生**的事：每次触发 `describeRead` 都重查系统一侧（种类、对象条目不得改写请求）；每次出站包装都断言 origin 与（方法, 路径）清单（§3.2）；改 origin 或认证身份必须重给认证材料（§7.5）。**残余照实写**：集成管理员在两次触发之间把系统改指到别处，规则侧看不到，下一次触发读的是新地址——这是登记权限本来就有的权力（§7.1），本线不把它说成被守住了；运维上，登记系统换 origin 之后，它上面此前批准过的每个操作重新算作首次读（§7.9）。

### 4.2 具名操作的生命周期

- 批准、退役在集成侧做，规则侧不参与。被引用的版本退役后，运行时查找只认 `approved`（`read-source-config-store.cjs:379-388`），该步骤记 `skipped(operation_not_approved)`——**退役一个配置版本就是关掉所有引用它的规则步骤**，这是有意的失败关闭：步骤状态是 `failed`，规则停在这一步（§4.8）。
- 规则引用的是版本行的 id。顾问保存出新版本（新行）不会让旧规则自动跟过去；要换版本就编辑规则，重新盖章、重新过操作者权限检查（§4.5）。
- 本线**不**给规则→配置加库级指针或锁（`external-system-pointer-lock.cjs` 的协议只覆盖配置→系统那一层）：一个被规则引用的配置仍可退役，后果如上。要不要在退役时列出引用它的规则，属于前端便利，不在本线。

### 4.3 读 / 写的分类，以及它和传输层判定的关系

| 目录里的分类 | 传输形状 | 结果 |
|---|---|---|
| 读（读源配置） | `http` 种类，安全方法、无体 | 直接出站，不经写门 |
| 读（读源配置） | `http` 种类，POST（`http` 的读不带体） | 传输层按「写」处理，以操作词 `request` 过写门（`http-adapter.cjs:263-272`）：部署文件未设即被拒，经本服务表现为 `skipped(write_gate_refused)`、零出站（原始码 `OUTBOUND_HTTP_WRITE_DISABLED` 经这条链观察不到，§3.2）；只有条目显式点名 `operations: ['request']` 才放行。**S3 不为「目录说它是读」开任何旁路**——那正是 `outbound-http-write-gate.cjs:59-77` 说的「把策略变成参数」。放行的代价也要知道：写门按系统 / 种类 / 对象 / 操作匹配，不看路径与方法（`outbound-http-write-gate.cjs:476-486`），一条点名 `request` 的条目授权的是该系统该对象上**任何**有体或非安全方法的请求，不只是这一个读 |
| 读（读源配置） | K3 种类（读是带体的 POST，适配器自带读意图） | 不经通用写门（K3 不用 `http-adapter`）。K3 的写在适配器的 `upsert` 上被永久拒绝，本线的服务只调用 `read`；**读腿本身只被一张写端点词表拦着**：命中词表的路径在适配器建立时与 wire 关口各被拒一次（`k3-wise-webapi-adapter.cjs:796-798,400-413`），词表外的动词会通过——适配器注释的原话是 VOCABULARY「NOT CLOSED」与「an unlisted verb still passes」（`:263,294-295`）。读请求体还以系统配置里的模板为底（`:1273-1282`；`material` 条目选了档案时模板被删、路径与方法换成档案的，S1-b 对这种条目即拒，§2 ⑧、§3.2），已批准配置的路径守卫只查字符、不认端点（`read-source-config.cjs:98-118`）。所以对 K3，**可证明的保证是客户侧的只读账号**，它是 L3 的硬前置（§7.7、§8）；正向目录见 OQ10 |
| 读（读源配置） | 桥种类 | 永远是带体的 `POST /query/<对象名>`（`bridge-agent-readonly-adapter.cjs:416-427`），目的地只能是本机（`:131-137`）；适配器只 `require` 契约模块、不引用写门（`:10-16`），所以这个带体的 POST 不过写门。读写的分界在 Bridge Agent 的协议与它连库用的只读账号，不在本服务（仓库对桥脚本的合同测试取的是同一口径，`.github/workflows/integration-guard.yml:529-531`） |
| 读（读源配置） | SQL 只读源 | 不经 HTTP：对象名加等值过滤，经宿主数据源门面的查询入口（`data-source-sql-readonly-source-adapter.cjs:602-631`）；属主由宿主严格比对（§4.5） |
| 写（写目标配置） | 任何 | 本线：保存 400。之后的发送切片：见下 |

**发送切片的契约（不随本线交付，现在锁定以免读路径把路堵死）**：

1. 向写门出示一个**新的闭合操作词** `call_connection`，加进 `OUTBOUND_HTTP_WRITE_OPERATIONS`（`outbound-http-write-gate.cjs:194-197`）。既有条目缺省只授权 `upsert`（`:370-372`），所以**今天已经存在的任何放行条目都不会顺带放行自动化写**——负对照测试必须有。
2. 匹配主体的 `object` 取写目标配置的 `object`，`systemId` 取配置引用的系统；配置自带沙箱 / 生产两个系统引用（`write-target-config.cjs:25-28`），先沙箱。
3. 对 K3 两个种类调用 `assertK3ExternalWriteRefused`（`k3-external-write-permanent-fence.cjs:181-186`）；目录加载时就拒绝登记面向 K3 种类的写操作。K3 的可证明保证是客户侧的只读账号，它在读路径上就已经是硬前置（上表第三行、§8），围栏是纵深。
4. 走两阶段意图台账，整动作一行或按目标一行（`automation-outbound-intent.ts:156-166`）；结果写带尝试令牌，步骤只在 `confirmed` 时报成功（§1.6）；任何「体已发出而结果不明」= `outcome_unknown`，永不自动重发。
5. 写步骤的输出要在记 `sent` 的同一次结果写里落下来，供重试时 `skip_sent` 的步骤恢复（§5.5）；它用的存储与后置的快照是同一件事（§5.4 的契约），随发送切片一起定。
6. 打开 `…_CALL_CONNECTION_WRITE_ENABLED` 与每一个写操作都是 O ②（内部表以外的目标同时是 O ③）。

### 4.4 放置、触发与同规则的其它动作

- **触发器**：`schedule.cron`（时区必填且是合法 IANA，校验同 `automation-run-integration-job.ts:178-189`）与 `schedule.interval`（`intervalMs ≥ 15 min`）。**cron 同样有 15 分钟的下限**：既有的 cron 保存校验只验时区（`automation-service.ts:3348-3362`），I 链的触发耦合也不设间隔下限（`automation-run-integration-job.ts:178-189`），一条每分钟触发的 cron 今天是存得进去的。带 `call_connection` 的规则在保存时用调度器自己的解析结果（`parseCronExpression` 给出分钟与小时两个集合，`automation-scheduler.ts:105-113,159-178`）算出「分钟 × 小时」集合上相邻两个触发点的最小间隔（含跨日的首尾相接），小于 15 分钟即 400。它按墙上时间算：夏令时前跳的那一天，实际间隔可能有一次短于它，由在途上限兜住（§3.2）。其它触发器保存 400。为什么不先放开记录事件：记录事件由任意编辑者引发，而读是以规则创建者的权限执行的——「编辑一条记录就能驱动一次外部读，键值由记录内容决定」是一个要 owner 点头的授权形状（§12 OQ4），不是实现细节。
- **条件**：不许带（定时触发的记录是空的，条件只会失败，`automation-run-integration-job.ts:196-207` 的同一理由）。
- **位置**：只在顶层；嵌在 `condition_branch` / `parallel_branch` 里的保存 400（判定按位置，照 `automation-run-integration-job.ts:259-281` 的遍历，不按对象身份）。这一条必须是**显式的拒绝**：条件分支的嵌套校验是黑名单——分支里的动作只验类型在闭集内（`automation-service.ts:1214`），再点名拒三种（`automation-service.ts:1254-1264`），「不把新类型加进去」在那里什么也挡不住。
- **同规则**：一条规则里可以有多个 `call_connection`（至多 8 步，§5.6）与 `transform_records`，也可以与既有的发送类动作并存。随之而来三条规定：
  - **新动作的任何非 `ok` 结果都让规则停在这一步。** 执行器只在步骤状态是 `failed` 时才停下并把其余步骤标成跳过（`automation-executor.ts:2606-2618`）；状态是 `skipped` 的步骤**不**停规则。I 链把「开关关着」记成 `skipped` 状态没有后果，因为它的动作必须是规则里唯一的动作（`automation-run-integration-job.ts:241-249`）；本线允许后面还有发送类动作，所以每一道门的拒绝都必须是 `failed` 状态（§4.8）——否则授权被拒之后，后面的 webhook、通知、记录写会照常发出去，像读成功了一样。
  - **既有动作不解析 `steps.*`**（§5.2），所以保存时拒绝任何引用它的既有动作配置。要拒的不只是含 `{{steps.` 的模板：`start_approval` 的表单映射对**不带花括号**的表达式直接按裸路径取值（`automation-executor.ts:1448-1455`，`automation-approval-bridge-service.ts:167-178`），一个写成 `steps.k.output.count` 的裸表达式会静默变成空串。两种写法都拒。
  - **不与会挂起的动作同处一条规则**（§2 ⑪）：检查按位置遍历分支子步，因为分支内的 `wait_for_callback` 是保存校验允许的（`automation-service.ts:1260-1261`），只看顶层会漏掉它。
- **不进这些白名单**：两个审批触发器的动作白名单（`automation-service.ts:500-512,621-624`）、并行分支白名单（`:713`）、`integration.run_finished` 规则允许的动作（前端镜像 `integrationRunFinishedAuthoring.ts:35-42`，服务端保存门 `automation-service.ts:3585`）、按钮路由的动作表（`multitable-button.ts:99-109`）。每一处各有一条「新类型被拒」的测试。

### 4.5 授权与运行身份

- **谁能保存这样的规则**（同时满足）：① 对规则所在表 `canManageAutomation`；② 主体带租户、且在该租户恰有一行在役成员关系（无租户平台管理员保存即拒）；③ `describeRead` 以该主体的实时权限通过——即持读层集成权限、配置已批准、系统存在且种类、读模式、列名都准入、系统侧对象条目不改写请求（§3.2、§3.3）；④ 规则所在的表通过 OQ3 裁定的守卫。
- **绑定**：保存时服务端把 `{ principalId: created_by, tenantId }` 盖进 `binding`，客户端同名键丢弃；改规则的人不接管绑定（`automation-run-integration-job.ts:148-158` 的做法）。
- **操作者权限**：一次保存（含只切换启用）之后规则带本动作且处于启用状态时，**操作者本人**必须通过与执行器相同的实时检查加 `describeRead`；缺操作者即拒。整次重试时，重试者本人同样要过（`retryExecution` 的路由只查全局管理员角色，`automation-service.ts:307-311` 记的就是这个洞）。只把规则关掉的写入不做这项检查，免得「创建者失权后规则关不掉」（`:312-314`）。
- **触发时**：主体上下文由 core 在一个先提交的 READ COMMITTED 事务里从实时 RBAC 构造（`automation-run-authority.ts:51-114`），**提交之后**再调端口，锁不跨出站调用；提交之后的撤权不中止在途的那一次读，这是与桥 ADR §6.4 相同的已接受窗口。定性的不在役 / 无成员关系 / 无权限 → `skipped(principal_unauthorized)`，不重试；读表本身失败 → `not_started(authority_unavailable)`。两者的步骤状态都是 `failed`（§4.8）。
- **数据面读身份 = 绑定主体本人**，不引入服务端委派。对 `data-source:sql-readonly` 这意味着规则创建者必须是该数据源的 owner 或平台管理员（宿主的数据源门严格比对 owner，`DataSourceManager.ts:791-801`；解析器只在 `runAs === 'user'` 且有主体时走 owner 路径，`connection-resolver.cjs:275`）。这是运行时那道门的口径；保存时本线取更严的一侧，见下一条。备料拉取那种「服务端盖章的 owner 委派」只对它那一个动作成立，本线不借用。
- **SQL 只读源的属主在保存 / 启用 / 重试时就查，不等到触发**：运行时的属主检查发生在连接解析里（`external-systems.cjs:1073-1078`），而 `describeRead` 用的不解密访问器不做解析（`external-systems.cjs:1035-1053`）——不补这一步，非属主的创建者能存下一条只会在触发时失败的规则，非属主的操作者也能启用或重试属主的规则。做法：对 SQL 只读源，`describeRead` 要求调用主体等于登记处在绑定时盖下的服务端属主戳 `config.dataSourceOwnerId`。两种绑定形态的戳都是在宿主证明了归属之后由登记处盖的，客户端送来的值会被丢弃（`external-systems.cjs:30-34,512-515,581-595`）。戳缺失或不相等即 `skipped(system_unavailable)`，与「系统不存在」不可区分——宿主对非属主也只答「不存在」（`DataSourceManager.ts:782-785`）。它取的是保守一侧：戳是绑定时的事实，平台管理员若不是盖戳的那个人也会在这里被拒；实时归属仍由触发时的连接解析裁定。
- **租户**：动作没有请求、没有请求头，租户只来自保存时冻结的绑定；规则所在表必须属于绑定租户（R-90 对作业规则的同一条守卫在这里是否照搬为「登记表」检查，见 OQ3——通用规则所在的表不一定是备料登记表）。

### 4.6 执行序（每次触发）

开关原文 → 配置重新解析 → 绑定主体 = 规则创建者 → 规则所在表的守卫（OQ3 裁定后的形态）→ 端口在役 → **实时复核绑定主体并提交**（§4.5）→ `describeRead` 复核引用（§4.1）→ 解析 `inputs` 里的步骤引用（§5.3；解析不出即 `not_started(input_unresolved)`，不出站）→ `callRead({ context, operation, inputs, rowSource, signal, checkpoint, automation })` → 结果消毒 → 读不完整即失败、不发布（见下）→ 过大小上限（§5.6）→ 发布到运行内通道 → 组装 values-free 的 `step.output`。任何一步没过，步骤状态都是 `failed`，规则停在这里（§4.8）。

- `signal` = 步骤超时（常量，等于配置读超时加余量）与停机信号的并集；停机信号与在途任务的登记沿用 I 链的接缝（`automation-executor.ts:1779-1786`）。
- **读步骤不写意图行**：读没有「发出去了但不知道成没成」的歧义，失败就是失败；下一个定时点就是重试。配置里不设 `retry`（保留字，照 `automation-run-integration-job.ts:91-93`）。
- **不完整即失败**：一页被截断却被当作完整，下游不会知道自己拿到的是半份数据；宁可这一步失败。「不完整」是下面任一条成立（几条同时成立时，原因取序号最小的那条）；服务在插件侧判定，只把一个布尔与闭合的原因交给 core（§3.2）：
  1. **触到我们自己的上限**（`capReached`）：行数**恰好等于**上限也算（§1.4）。所以一步能发布的行数是上限减一——`http`、SQL 只读源至多 99 行，K3 的列表读至多 9 行（§3.1）。原因 `row_cap_reached`。**桥另受信号 3 约束**：适配器把请求压到系统配置的 `maxLimit`（缺省 20、上限 500，`bridge-agent-readonly-adapter.cjs:46-47,165-175,270-274`），一页打满这个值即信号 3，所以桥一步至多 min(100, `maxLimit`) − 1 行——缺省配置下 19 行，一页 20 行是 `failed(source_incomplete)`；只有 `maxLimit` 调到 100 及以上才是 99 行。
  2. **适配器说还有**：内部页对象的 `done` 不为真，或带着 `nextCursor`（`read-source-read-runtime.cjs:280-283`）。原因 `source_incomplete`。
  3. **适配器实际采用的上限被打满**：内部页对象的 `effectiveLimit` 有值，且适配器这一页的行数不小于它（`read-source-read-runtime.cjs:300,308`）。原因 `source_incomplete`。
  4. **源声明的总数多于拿到的行数**：`sourceTotalCount` 有值且大于本页行数（`read-source-read-runtime.cjs:289-291`）。原因 `source_incomplete`。

  各种类实际会给出哪些信号（逐个去掉，对应的对照必须变红，G12）：

  | 种类 | 能看到的信号 | 看不到的 |
  |---|---|---|
  | `http` | 1；响应里的游标与完成标志（→ 2）——适配器按登记系统对象条目的 `nextCursorPath` / `donePath` 取，条目没配时只认响应顶层的 `nextCursor`（`http-adapter.cjs:425-431`） | 源自己分了页，而它声明后续的方式既不是顶层 `nextCursor`、也没有用这两个键配给适配器。源无视 `limit` 一次给全时由 1 兜住 |
  | `erp:k3-wise-webapi` | 1；列表响应里源声明的行数总计（→ 4，`k3-wise-webapi-adapter.cjs:2150-2162`） | `done` 对它恒为真（没有游标时缺省为真，`lib/contracts.cjs:128-140`）；响应不带总计时只剩 1 |
  | `bridge:legacy-sql-readonly` | 1；适配器把上限压到自己的 `maxLimit`（缺省 20）并回报经对端确认的实际值（→ 3，`bridge-agent-readonly-adapter.cjs:270-274,440-466`） | — |
  | `data-source:sql-readonly` | 1；满页即 `done: false` 并给游标（→ 2，`data-source-sql-readonly-source-adapter.cjs:653-662`） | — |

  **残余，照实写**：对「看不到的」那一列，一次被源截断的读会被当成完整的发布出去。它由批准该配置的集成管理员承担——在 `http` 系统上批准一个 `list_page` 配置，等于断言这个端点要么一次给全、要么它声明后续的方式适配器读得到（顶层 `nextCursor`，或对象条目里配好的 `nextCursorPath` / `donePath`）；这句话写进集成管理员看得到的配置说明（§7.4）。这两个键在系统配置里、不在已批准的配置里：它们不改写请求，所以不在 §3.2 的拒绝之列，但配错了会让信号 2 失灵——§4.1 关于系统一侧的残余同样适用于它们。首片一步只读一页；翻页是后续切片（§11）。

### 4.7 模拟、真发测试与重试

- **模拟**（`dispatchMode === 'simulate'`）：`simulationDisposition` 归 `simulate`（`automation-executor.ts:1010-1035`），**永不到达端口**——端口探针的调用次数为 0 是验收断言。模拟计划只含操作引用与输入键名，引用到前序步骤的地方列为「未解析的引用」，不造样例值。
- **真发测试**：两个新类型都不进 `automation-retry-eligibility.ts:18-39` 的任何集合，于是落到 `TEST_RUN_ACTION_UNSUPPORTED`（`:76-78`）。要给人看一次真实读出来的数据，走 §6.4 的手动预览，不走真发测试——真发测试的结果面是日志，而日志不许带值。
- **整次重试**：读步骤重读；重试前先过重试者权限检查（§4.5）。本动作不属于 A / B 两族，重试的台账证据要求对它不适用（`automation-retry-eligibility.ts:151-165,172`）。

### 4.8 步骤结果词表（闭集）

**记法。** 本文写的 `skipped(x)`、`not_started(x)`、`failed(x)` 都是 `output.outcome(reason)`，**不是步骤状态**。两个新动作的步骤状态只有两个值：`success`（只在 `outcome` 为 `completed` 时）与 `failed`（其余全部）。执行器只在步骤状态为 `failed` 时停下（`automation-executor.ts:2606-2618`），所以**每一个非 `ok` 的原因都让规则停在这一步**，后面的动作由执行器标成跳过、不执行。步骤状态与 `output.outcome` 分开记，是 I 链已有的形状（`automation-executor.ts:4225-4238`；端口缺席在那里就是 `failed` 状态加 `not_started`，`:4413`）。本线与它不同的只有一处：「开关关着」在 I 链是 `skipped` 状态（`automation-executor.ts:4397`），在这里是 `failed` 状态——理由见 §4.4。

`step.output = { outcome, reason, operation: { kind, configId }, counts: { rows, columns, bytes }, capReached, complete, durationMs, errorClass? }`，键集闭合。`outcome` 是闭集，四个值：

- `completed`：读（或转换）做完了，输出已发布。
- `skipped`：一道门决定不做，**没有任何请求发出**；不改变点什么，下一次触发还是同一个结果。
- `not_started`：前提没能建立（配置、端口、授权读取、输入），**没有任何请求发出**。
- `failed`：读已经发出（或可能已经发出），或者结果不能被接受。

| `reason` | 谁判定 | `outcome` | 步骤状态 | 是否已出站 |
|---|---|---|---|---|
| `ok` | — | `completed` | `success` | 是 |
| `action_disabled` | core 触发时读开关；插件服务出站前再读一次 | `skipped` | `failed` | 否 |
| `rule_sheet_unregistered` | core：规则所在表的守卫（OQ3） | `skipped` | `failed` | 否 |
| `principal_unauthorized` | core：实时 RBAC；插件：读层权限 | `skipped` | `failed` | 否 |
| `operation_not_found` | 插件 `describeRead`：按盖章的 workspace 查不到配置行 | `skipped` | `failed` | 否 |
| `operation_not_approved` | 插件 `describeRead`：版本不是 `approved` | `skipped` | `failed` | 否 |
| `operation_changed` | core：`contentKey`、取行面或列集与盖章不符 | `skipped` | `failed` | 否 |
| `kind_not_admitted` | 插件：种类不在准入表 | `skipped` | `failed` | 否 |
| `mode_not_admitted` | 插件：读模式不在准入表（§3.3） | `skipped` | `failed` | 否 |
| `columns_not_admitted` | 插件：列名不是扁平标识符或是保留名（§3.3） | `skipped` | `failed` | 否 |
| `system_unavailable` | 插件：系统不存在、种类不符，或 SQL 只读源的属主不符——故意不可区分 | `skipped` | `failed` | 否 |
| `system_overrides_request` | 插件：`http` 系统的对象条目会改写请求，或 K3 系统的 `material` 条目选了具名档案（§3.2） | `skipped` | `failed` | 否 |
| `read_authorization_required` | 插件：已武装部署上没有可用的 B2a 登记，或定时读在已武装部署上不可用（§3.2） | `skipped` | `failed` | 否 |
| `write_gate_refused` | 插件：出站写门拒绝了一个 POST 形状的读（§3.2、§4.3） | `skipped` | `failed` | 否 |
| `adapter_refused` | 插件：适配器在建立时拒绝了这个配置，一个请求都没发出（§3.2）；K3 的读路径命中写端点词表属此类 | `skipped` | `failed` | 否 |
| `busy` | 插件：同一（租户, 系统）已有在途调用 | `skipped` | `failed` | 否 |
| `config_invalid` | core：落库的配置解析不过 | `not_started` | `failed` | 否 |
| `port_inactive` | core：端口缺席 | `not_started` | `failed` | 否 |
| `authority_unavailable` | core：读 RBAC 表本身失败 | `not_started` | `failed` | 否 |
| `input_unresolved` | core：步骤引用解析不出，或解析出的值不是可用的业务键（§5.6） | `not_started` | `failed` | 否 |
| `timeout` | 插件 / core：到点放弃等待 | `failed` | `failed` | 是（底层请求可能仍在途，§1.4） |
| `shutdown` | core：停机信号 | `failed` | `failed` | 可能 |
| `redirect_refused` | 插件：包装见到 3xx | `failed` | `failed` | 是（只有第一个请求） |
| `origin_refused` | 插件：包装发现请求 URL 的 origin 不是登记系统的有效 origin，不发出（§3.2） | `failed` | `failed` | 被拒的请求：否；同一次调用里排在它前面的腿（只有 K3 的登录 / 取令牌）可能已发出 |
| `request_not_allowed` | 插件：包装发现（方法, 路径）不在本次调用的清单里，不发出（§3.2） | `failed` | `failed` | 同上 |
| `source_error` | 插件：其余读失败，细分只在 `errorClass` | `failed` | `failed` | 是或可能 |
| `row_cap_reached` | 插件：触到我们自己的行上限（§4.6） | `failed` | `failed` | 是 |
| `source_incomplete` | 插件：适配器或源表明还有后续（§4.6） | `failed` | `failed` | 是 |
| `output_not_scalar` | core：结果消毒 | `failed` | `failed` | 是 |
| `output_too_large` | core：§5.6 的上限 | `failed` | `failed` | 是 |
| `transform_failed` | core：`transform_records` 任一行出错（§6.1） | `failed` | `failed` | 不适用（无 IO） |
| `yida_plan_rejected` | core：规划器拒绝这一批（§6.3） | `failed` | `failed` | 不适用 |
| `row_unavailable` | core（v5）：点选的那一行不在规则所在的表上、操作者读不到它、或它缺声明列（§6.4） | `not_started` | `failed` | 否 |
| `draft_refused` | core（v5）：S4-e 借用的宜搭 owner 草稿入口拒绝了这一写——发送开关未开、不是锚点 owner、1 号槽不可用或输入不合格，细分只在闭合的 `errorClass`（§6.5） | `failed` | `failed` | 读：是；草稿：未写 |

`errorClass` 只取证据面已经钳进闭集的错误码（§3.2），从不取适配器的原始错误码、类名或消息文本。

**v5 的两点说明。** 一，`parity_violation` 随 OQ6 的退路一起挪到 §11，不再产生。二，`system_overrides_request`、`write_gate_refused`、`redirect_refused`、`origin_refused`、`request_not_allowed` 这五个原因只在 HTTP 种类上出现；形态 B 的首片不准入 HTTP 种类，这五个原因在首片里永远不出现。它们留在词表里，等那些种类准入时用（§3.2）。

### 4.9 登记点清单

来源：对最近两个新增动作 `run_integration_job`、`write_approval_form_values` 做全仓 `git grep -l`（去掉 docs 与测试后分别命中 31 个、20 个文件），剔除各自专属的模块后取并集。**这是下界，不是穷尽证明**：以集合差或默认分支隐式处理动作类型的地方 grep 不到，所以每个切片另外要有 `never` 穷尽检查与「未知类型落到拒绝分支」的测试兜底。`packages/openapi` 里没有动作类型的枚举（对三个动作名的 grep 0 命中），不是登记点。

| 位置 | 要做的事 |
|---|---|
| `automation-actions.ts:6-38,40-58` | 联合类型、`ALL_ACTION_TYPES`、配置形状接口（`automation-service.ts:656-660` 的两个集合由它派生） |
| `automation-service.ts:1952-1971`、`:2223`、`:2807` | 保存门接进 `createRule`、版本绑定的 `updateRuleOnce`、`setRuleEnabled`：开关 403、闭合配置、触发耦合、放置、条件、盖章 |
| `automation-service.ts:205-225` | 校验码联合增新码 |
| `automation-service.ts:500-512,621-624,713,3585` | 四处放置白名单——新类型**不加入**，各配一条拒绝测试 |
| `automation-service.ts:1229-1296` | 条件分支的嵌套校验是黑名单（只点名拒三种，`automation-service.ts:1254-1264`）：要**加一条显式拒绝**，按位置遍历（§4.4），配拒绝测试 |
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
| `global-history-flag-manifest.mjs`、其测试、仓库根的 `.env.example:371-377` | 开关登记、读取点测试、默认关的示例行；由落下该开关第一个读取点的切片登记（§7.8） |
| `packages/core-backend/vitest.config.ts:1538`、`.github/workflows/plugin-tests.yml`、`test-chain.txt` | 真库用例的三处镜像、插件测试链登记 |
| `.github/workflows/integration-guard.yml` 的路径清单与 `scripts/ops/integration-guard-guarded-paths.mjs` | 插件链只在改动落进受守卫路径清单时运行（`.github/workflows/integration-guard.yml:677-680`）；被插件侧测试跨边界读到的 core 新文件要同时进这两份清单——两者集合相等是既有的陷阱（`adr-automation-pipeline-bridge-20261103.md:345`） |
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

- 只有这两种选择器，正好落在 `[\w.]+` 之内。没有下标、没有通配、没有任意深度的路径。列名落在其中靠的是 `describeRead` 的列名准入（§3.3）：配置读自己的目标名校验允许点号、冒号与连字符，不能直接当列名用。
- **整值绑定，不做插值**：首片只接受「整个字符串恰好是一个 `{{引用}}`」，值按原类型交给使用方；混排文本另议。这样步骤数据拼不进任何更长的串里。
- **行集不走模板**：把整个行集交给下一步，用结构化引用 `source: { fromStep }`（§6.1），与合成片的 `StepInputRef` 同形（`automation-run-values.ts:52-57`）。
- **谁能用引用**：首片只有 `call_connection.inputs.key`（标量）与 `transform_records.source`（行集）。既有动作的模板继续走 `renderAutomationTemplate`，其模板数据里没有 `steps`——所以保存时就拒绝（§4.4），而不是让它在运行时渲染成空串。含花括号的模板与不带花括号的裸路径表达式都在拒绝之列（§4.4）。
- **v5 加一个引用根 `row.`**（只为点名场景，§6.4）。写法是 `'row.' 行列名`，行列名必须在规则声明的 `rowInput.columns` 里。它只用在两个位置：`call_connection.inputs.key`，整值绑定、标量；以及 `transform_records.source.withRow: true`，把点选的那一行的声明列并进源步骤的每一行。带 `rowInput` 的规则不能启用定时（§6.4），所以这个引用只在预览与存草稿两条路由上有值。没有点选行时一律 `not_started(input_unresolved)`，不出站。
- **解析器是新写的**：只按声明的列取自有属性，拒绝 `__proto__` / `prototype` / `constructor`，不复用 `lookupTemplateValue`（它不防原型链、对函数值会渲染出字面的 `undefined`，`automation-executor.ts:309-328`）。

### 5.3 运行内通道

- 把 `createRunValueStore` 一般化（`automation-run-values.ts:118-204`）：计划不再是固定的合成计划，而是从**已保存的规则**推导——步骤顺序 = 带 `stepKey` 的顶层步骤的顺序；每个输出的声明列 = 保存时盖章的 `output.columns`；每个输出的消费方白名单 = 保存时静态引用图里引用了它的那些步骤。容器既有的保证全部保留：只收声明列上的有限标量、发布一次、发布即冻结、句柄只在本次运行有效、只能引用前序且已成功的步骤（`:139-186`）。
- **保存时的静态检查**：每个引用必须指向更早的、带该键的顶层步骤及其声明的列；前向、自引用、未知键、未声明列一律保存 400。运行时容器再查一遍，两层各有测试——保存检查挡的是写错的规则，容器检查挡的是绕过保存写进库的规则。
- **生命周期**：一次执行一个，在 `execute` 入口创建、`finally` 里 `dispose`。首批不存在续跑：带新动作的规则不能含会挂起的动作（§2 ⑪）；万一有绕过保存写进库的规则走到续跑，续跑的执行没有容器，引用一律解析失败（`not_started(input_unresolved)`）——失败关闭，不会有占位符被当成值。容器不挂成 `ExecutionContext` 的可枚举字段——上下文在个别地方会被整体带进日志元数据，执行器里已有「不要展开 context」的注释（`automation-executor.ts:5417-5418`）；用以执行为键的模块私有表持有。
- 合成片的容器与它的固定计划保持原样（§7.10 的 G14）；一般化是加一个从规则推导计划的构造路径，不是改合成路径。

### 5.4 持久化：首批不做，契约先记下（S2-b 后置）

**首批不落任何值。** 步骤输出只活在一次执行的内存里，执行结束即 `dispose`。跨挂起的引用在首批不存在：带 `call_connection` 或 `transform_records` 的规则不得含任何会挂起的动作，保存即拒（§2 ⑪、§4.4）。原稿设想的快照表与续跑恢复整体后置到 §11，拉入条件写在那里。

**为什么后置，而不是照原稿交付。** 原稿把续跑写成一条道——校验先于令牌认领、不符即 409、令牌不消耗。读码之后这不成立（§1.1）：

- **续跑有两条道。** 令牌道如上；审批道没有令牌也没有调用方，漂移的结局是把执行记成终态失败（`resumeApprovalBridgeContinuation`，`automation-service.ts:5056-5073`），「409、令牌不消耗」在那里没有意义。而原稿点名要处理的 `start_approval`，恰恰走审批道。
- **挂起点有三个。** 顶层 `wait_for_callback`、分支内 `wait_for_callback`、`start_approval`（`automation-service.ts:4575,4590,4605`）。
- **两条道的漂移守卫都只哈希动作类型**（`automation-suspension-service.ts:63-66`）：消费方步骤的配置在挂起期间改了、类型没变，续跑照样进行。只核对产生方的身份不够。
- **「快照与挂起行同一个事务」今天做不到**：审批桥的行是先插入、再创建审批，两步之间没有事务（`automation-approval-bridge-service.ts:341-373`）。
- **30 天清扫没有可以照搬的东西**：执行日志的 `cleanup()` 只有定义（`automation-log-service.ts:323`）、没有生产调用方——对 `packages/core-backend/src` 做 `git grep -n "\.cleanup("` 命中 13 处，没有一处在日志服务上。

**后置切片必须满足的契约**（现在锁定，免得首批的实现把路堵死）：

1. 快照只为跨挂起的引用而写、只写被引用到的输出、落库前脱敏并记下被改写的列；被脱敏的单元格一经引用即失败关闭，**绝不**把占位符当作值交给下一步或发到外部系统。没有任何读出口。
2. **三个挂起点逐一规定**：允许哪几个、拒哪几个，各自在哪个事务里写快照。`start_approval` 的快照必须先于审批实例的创建，并说明它与桥行怎样成为一个事务。
3. **两条道各有各的失败形态**：令牌道是 409、令牌不消耗；审批道是经 `failApprovalBridgeExecution` 的终态失败，带闭合的原因。快照缺失、过期、对不上、被脱敏，四种情况在两条道上各写一行。审批的等待时间超过快照有效期时怎么办，要有明文。
4. **挂起时存整条规则的指纹，续跑时不符即拒**——用覆盖配置的那个规则指纹（`automation-rule-fingerprint.ts:102-112`），不是只比类型的那个。这样产生方与消费方的任何配置改动都会被看到，改过的消费方步骤拿不到快照里的值。
5. 清扫是一个具名的定时任务，写明它依赖单 fork 还是调度主选举。
6. 守卫随切片交付：原 G11 的全部对照，加上「哨兵在快照表里找得到、在其它持久面找不到」（G10 的快照那一半），两条道各一组真库用例。

### 5.5 重试（续跑见 §5.4）

- **首批没有续跑。** 带新动作的规则不会挂起（§5.4）；续跑恢复的规定随快照一起后置。
- **整次重试不恢复读输出**：重试从第 0 步对当前数据重跑（`automation-service.ts:4784-4788`），读步骤重读；规则配置变了即 `RULE_CHANGED`（`:4697-4712`）。重试前先过重试者的权限检查（§4.5）。
- **写步骤的输出是例外，留给发送切片**：重试时已发送的步骤被 `skip_sent` 跳过、不带输出（`automation-executor.ts:4137-4139`），依赖它返回值的下一步就没有输入。所以发送切片必须在记 `sent` 的同一次结果写里落该步的输出，重试时按台账身份恢复（§4.3 第 5 条）。本线没有写步骤，这条只定契约。

### 5.6 大小上限（T 层默认，全部是常量；每条都要有「去掉即红」的测试）

| 对象 | 上限 | 超限的结果 |
|---|---|---|
| 一次读的页内行上限 | `http`、桥、SQL 只读源：100（入口常量 `CONFIGURED_READ_AUTOMATION_ROW_CAP`，§3.1）；K3：10（平台常量 `READ_SOURCE_PROBE_ROW_CAP`，`read-source-probe-contract.cjs:20`）。触到即失败，所以可发布的行数分别至多 99 与 9；桥另受适配器的 `maxLimit`（缺省 20）约束，至多 min(100, `maxLimit`) − 1 行，缺省配置下 19 行（§4.6 第 1 条） | `failed(row_cap_reached)`；桥一页打满小于 100 的 `maxLimit` 时是 `failed(source_incomplete)`。都不发布、不截断 |
| 一个输出的行数（core 自己再数一次） | 100（core 的常量；容器硬上限 1 万，`automation-run-values.ts:76`） | 产生它的步骤 `failed(output_too_large)`，不发布、不截断 |
| 一个输出的规范化 JSON 字节数 | 1 MiB | 同上 |
| 一次执行全部输出的字节数 | 4 MiB | 超出的那一步失败 |
| 一条规则里带 `stepKey` 的步骤数 | 8 | 保存 400 |
| 一条规则里的 `call_connection` 步骤数（不论带不带 `stepKey`） | 8 | 保存 400 |
| 被整值绑定的业务键 | 128 个字符，去掉首尾空白后计，不得含控制字符；只收字符串或有限数字——这是配置读自己的键界（`read-source-probe-runtime.cjs:51,72-82,109`）。`null`、布尔、空串都不是可用的键 | `not_started(input_unresolved)`，不出站 |

「不截断」是统一规则：宁可这一步失败，也不让下一步在不知情的情况下拿到半份数据。

### 5.7 `step.output` 与日志隔离

- 新动作的 `step.output` 键集闭合（§4.8），由宿主从枚举与计数重建，**不是**从原始结果展开后删字段（冻结基线 §10.3.1 的原则）。行摘要与计划摘要是值的派生物，对低熵的值可以被枚举还原，同样不进日志。
- 验收用哨兵值：让一组带唯一标记的合成值流过一次完整执行（成功、失败、超时各一条路径），然后在 `multitable_automation_executions` 的四个自由形列、`multitable_automation_jobs.result`、出站意图表、发件箱、应用日志、指标标签与异常的 `cause` 里搜这个标记，命中数必须为 0；同一测试对运行内通道断言命中数**大于 0**——那是它该在的地方，也是这条测试不是空转的证明。哨兵还要放进一处对端可控的位置：桥对端响应体里的错误码（§3.2），它同样不得出现在任何持久面。这条测试由 S3-a2 交付——它是第一个有值流过一次真实执行的切片；S2-a 只能证明内存里的那一半（§10.2）。

## 6. S4：转换步骤、宜搭 v3 方言、预览与落点

### 6.1 动作 `transform_records`（切片 S4-a：通用方言，加 v5 只调规划器的宜搭方言）

```
{ stepKey,
  source:  { fromStep, withRow? },              // 前序的、声明了输出的步骤；withRow（v5）见 §5.2、§6.4
  mapping: { dialect: 'field_mappings_v1', fieldMappings: [ { sourceField?, targetField, transform?, defaultValue? } ] }
         | { dialect: 'yida_form_protocol_static_v3', config, allocation: { mode: 'original' } },
  output:  { columns: string[] } }              // 服务端从映射推导并盖章
```

- **宿主在 core，引擎是注入的一个纯函数**：按 `yida-automation-preview.ts:148-194` 的方式从插件目录的固定路径只取 `transformRecord`。前提是引擎文件保持零依赖——今天它没有任何 `require`（§1.7）；加一条静态测试钉住「无 `require` / `import`、无 `process` / `fs` / 网络」，与合成目录的同类测试并列。
- **保存时的校验**：`sourceField` 必须是源步骤的声明列（或缺省，表示常量）；`targetField` 是扁平标识符 `^[A-Za-z_][A-Za-z0-9_]{0,63}$` 且不重复；`transform` 里的函数名必须在引擎的闭集内（`transform-engine.cjs:10-19`）；映射条数 ≤ 64。转换的参数里凡是指名字段的——`concat` 的 `fields`——也必须逐个是源步骤的声明列：引擎对它们走的是同一条不防原型链的读路径（`transform-engine.cjs:172-190`）。
- **语义**：逐行调用 `transformRecord`；**全有或全无**——任何一行有错，整步 `failed(transform_failed)`，不发布部分结果。给人看的只有出错的行数、字段名与闭合的错误码。交给引擎的每一行是只含声明列的**空原型**副本——容器读出来的行是普通对象（`automation-run-values.ts:181-185`）——原型链上的名字因此在引擎的读路径上什么也取不到。
- **放置**：与 `call_connection` 相同（§4.4）。没有任何 IO，但模拟模式下它没有输入可转，所以 `simulationDisposition` 同样归 `simulate`，计划里只列映射的目标字段名。

### 6.2 通用方言对引擎的五处收紧

| 引擎今天的行为 | 步骤层怎么处理 |
|---|---|
| 读路径按点号逐段取属性、不防原型链，`a[]` 表示取数组首元素（`transform-engine.cjs:34-52`）；`concat` 的 `fields` 参数走同一条读路径（`transform-engine.cjs:183`） | 三层，只限制 `sourceField` 一处是不够的：保存时把 `sourceField` 与转换参数里的字段名都限制为声明列的名字（无点号、无 `[]`）；声明列本身不会是保留名（§3.3）；交给引擎的行是空原型副本（§6.1） |
| 目标路径可嵌套（`transform-engine.cjs:54-83`） | `targetField` 只许扁平标识符——运行内通道只装标量列 |
| 错误的 `details` 带原值，消息是自由文本（`transform-engine.cjs:96,104,164,239-246`） | 步骤只保留 `code`、字段名与行号；`message` 与 `details` 不出步骤 |
| `toDate` 对非 ISO 文本用运行时的 `Date` 解析（`transform-engine.cjs:158-167`） | 通用方言照常可用并在界面上注明；宜搭方言不走引擎（§6.3），不涉及 |
| `concat` 默认把当前值拼在最前、静默丢掉空白片段、把布尔值转成文本（`transform-engine.cjs:172-190`） | 通用方言保持原样（管道在用，不改）；宜搭方言不走引擎，拼接语义只由规划器定（§6.3） |

**v5：引擎文件不改。** 原稿给 `transformRecord` 加的可选扩展函数表参数，以及「扩展表泄漏进管道路径必红」的那条变异，随引擎表达一起挪到 §11（OQ6 的退路）。

### 6.3 宜搭 v3 方言：步骤内只调规划器（v5，随 S4-a）

v4 在这里写的是「编译到引擎 + 两个扩展函数 + 影子对拍，规划器为权威」（切片 S4-b，全文见 `aadb188f3`）。owner 2026-11-19 就 OQ6 取了本 ADR 自带的退路，所以 v5 只留下面这一种做法。原稿的引擎表达、`yida-transform-spec.mjs`、`yida_concat` / `yida_generated` 两个扩展函数、影子比对、对拍语料与 G13 整体挪到 §11，拉入条件照 R-87（`decision-register.md:92` @e0e4406bf）。

- **做法**：core 从插件目录的固定路径只注入一个纯函数 `compileYidaLocalDraft`，注入方式照 `yida-automation-preview.ts:148-194`。这个入口写明「从不持久化」，它的结果「nothing may store, approve or send」（`yida-draft-compiler.mjs:300-305` @e0e4406bf）。
  - 步骤先在服务端拼出规划器要的 JSON 行文本（`parseYidaStaticRows` 收的就是 JSON，`yida-static-plan.mjs:664-672` @e0e4406bf）：每一行取源步骤的声明列，`withRow: true` 时再并进点选的那一行的声明列（§6.4）。
  - 然后把这段行文本连同保存时盖章的 v3 配置、`allocation: { mode: 'original' }` 交给规划器。
- **结果**：
  - 规划器抛出 → `failed(yida_plan_rejected)`，只带它那个闭合的错误种类，什么都不发布。它在有无效行、键重复或批次为空时都会抛出（v4 的引用，`yida-draft-compiler.mjs:104-123,180-183` @35dc8b272）。
  - 规划器通过 → 只发布**它的** `plan.rows[*].payload`。规划器对缺失的可选目标不写 `payload` 的键，而运行内通道要求每行恰好是声明列（`automation-run-values.ts:94`），所以发布前把缺的列填成 `null`。
- **权威只有一份**：规划器是这个方言唯一的实现，没有第二份表达，所以不比对、不影子跑，也没有 `parity_violation`。
- **保存时的校验**：
  - 配置要过 `validateYidaStaticConfig`（`yida-static-plan.mjs:464` @e0e4406bf）。
  - 配置读到的每一个源列（`yidaTransformSourceColumns`，`:528` @e0e4406bf）都必须是源步骤的声明列，或 `rowInput` 声明的行列名，否则保存 400。
  - `output.columns` 由服务端从配置的目标推导并盖章。
- **发送路径不变**：发送照旧由 `compileYidaSendDraft` 自己编译（`yida-draft-compiler.mjs:293-295` @e0e4406bf），不读转换步骤的任何产物。预览不是授权（`yida-automation-preview.ts:9-12`）。落点切片 S4-e 存草稿时，草稿库同样用发送编译器从行文本重算一遍（`yida-draft-plan-store.mjs:5,240` @e0e4406bf），也不读步骤的产物（§6.5）。
- **必须见证的变异**（每条先红再绿）：
  - 规划器抛出时仍发布；
  - 发布前不补齐列；
  - 源列校验被跳过（配置读一个未声明的列也能保存）；
  - 行文本由引擎或客户端拼出，而不是服务端从声明列拼出。
- **首片的限制**：只接受 `allocation.mode: 'original'`；拆分分配仍在宜搭自己的预览路径里。行数与文本上限沿用规划器的（`yida-static-plan.mjs:6-9`）。

### 6.4 手动预览：这条线的可演示出口（切片 S4-d）

定时规则的结果只进日志，而日志不带值——所以需要一个给人看的出口，否则 S1–S4 做完了客户什么也看不到。

- 新路由 `POST /api/multitable/sheets/:sheetId/automations/:ruleId/steps-preview`：把已保存规则里的 `call_connection` 与 `transform_records` 步骤按顺序跑一次，把**最后一步**的行（至多 100 行、只含声明列）放在响应里，`Cache-Control: no-store`；前端只放在当前面板的内存里——不写 `localStorage` / `sessionStorage` / IndexedDB，取消、清除、关闭、重开与卸载时清空（G16）。合成预览的面板钉的是同一组行为（`multitable-automation-integration-preview.spec.ts:3-7`），而这块面板装的是**真实读出来的值**，所以它留在我们手里做（§10.4）。合成预览的路由与目录不动（它是另一条路，`routes/automation.ts:1049-1056`）。
- **准入**：操作者必须是规则的所有者，并在运行开始、每次出站读之前、结果返回之前各过一次检查——规则归属、表在役、§4.5 的实时权限与 `describeRead`。检查点的事务与锁顺序照合成片已经验证过的协议（`automation-synthetic-preview.ts:17-38`），已知间隙也照实写：检查通过之后才撤权的那一次读仍会发出。
- **落库**：一行 values-free 摘要，`triggered_by = 'steps_preview'`，加进不计入规则监控的那张名单（`automation-log-service.ts:18`）；`trigger_event` 与 `rule_snapshot` 为空，所以既有的重试门自然拒绝它（合成片的同一做法，`:139-149`）。
- **它是一次真实读**：在客户机器上由人点击触发，与定时触发同属 O ①，受同一个开关、同一份已批准配置、同一个 B2a 用途约束——已武装的部署上，预览里的每一次读各用掉一条登记，`runId` 取本次预览运行的 id 加步骤路径（§3.2）。开发与 CI 只对合成的登记系统（本机夹具服务）运行。

- **点选的那一行（v5，点名场景的入口）**。场景的第一格是「指定备料项目的一行」，而定时触发的记录是空的（§4.4），既有的引用里也没有记录（§5.2），所以 v5 给预览加一个入口。它是 T 层默认（§12 第 10 项），在 S4-d 评审时定稿。
  - **声明**：规则在第一个 `call_connection` 的配置里加一个闭合键 `rowInput: { columns: { <行列名>: <字段 id> } }`。至多 16 列；行列名是扁平标识符，规则与 §3.3 相同；字段 id 必须是规则所在表的字段，保存时核对。行列名不得与 `withRow` 并进的源步骤的列名重名，否则保存 400。
  - **只能预览，不能启用**：带 `rowInput` 的规则保存时必须是停用的；启用、或保存成启用，一律 400 `ROW_INPUT_PREVIEW_ONLY`。所以定时触发到不了它，编辑记录也驱动不了它（OQ4 不放开）。
  - **请求**：预览请求体只收 `{ recordId }`。规则带 `rowInput` 时必填；不带时出现即 400。
  - **读这一行**：用操作者本人的多维表读，与宜搭 owner 路由读表源是同一口径——「the owner's own multitable read (this request's actor), never an elevated or plugin read」（`integration-yida-owner.ts:411` @e0e4406bf）。这条记录必须在规则所在的表上。读不到、不在这张表或缺声明列，都是 `not_started(row_unavailable)`，零出站。
  - **为什么它就是「指定备料项目的一行」**：规则所在的表本来就要过 OQ3 的守卫，必须是绑定租户名下在役的备料项目登记表（§12 OQ3）。
  - **值去哪里**：这一行的值只进运行内通道（一行，只含声明列），作为 §5.2 的 `row.<行列名>` 被引用；日志与 `step.output` 里只有计数。
  - 守卫见 G19。

### 6.5 落点：物料表测试副本草稿（切片 S4-e；v5，形态 B 唯一的落点）

点名场景的最后一格是「物料表测试副本的草稿预览」。物料表测试副本就是宜搭的 1 号槽：物料表（报工）的测试副本（R-71 ①，`decision-register.md:76`）。代码里，1 号槽同样被当作物料测试副本，它可以收无绑定的行（`yida-owner-runtime.ts:29-33` @e0e4406bf；冻结基线 D20，`ipaas-yida-dev-baseline-v2.3-20261106.md:212`）。面板里的草稿预览 S4-d 已经给了；**落点**是把它存成一份宜搭草稿，之后能在既有的宜搭 owner 面板里逐行预览，而不发送。这是形态 B 唯一的落点，也是本线对内部表唯一的一写。

- **路由**：新增 `POST /api/multitable/sheets/:sheetId/automations/:ruleId/steps-draft`，请求体只收 `{ recordId }`（规则带 `rowInput` 时必填，§6.4），`Cache-Control: no-store`。
  - 它在服务端把规则的步骤**从头重跑一遍**，准入、检查点与排空都同 §6.4，`origin = 'steps_draft'`。最后一步必须是宜搭方言的 `transform_records`（§6.3），否则 400。
  - 重跑成功后，它把**交给规划器的那段 JSON 行文本**连同盖章的 v3 配置、`allocation: { mode: 'original' }`，经既有的宜搭 owner 草稿入口 `prepareDraft(owner, { config, rowsText, allocation })` 存成一份草稿（`yida-owner-runtime.ts:334-343` @e0e4406bf）。
  - **不带 `targetRef`，也不带 `sourceBinding`**：这两个键的代码路径在 S4-e 的模块里根本不存在，由静态扫描钉住。
- **不收客户端的行**：请求体只有 `recordId`。行只来自这一次的服务端重跑，预览的响应不回流；所以浏览器造不出一份草稿。
- **为什么借这个入口，而不是另写**（T 层默认，§12 第 10 项）：
  - **不新增写路径、不新增表**：这是既有的、owner 用的草稿入口。草稿库写明自己不能批准、签发授权、加载凭据、准备投递台账或发送（`yida-draft-plan-store.mjs:7-10` @e0e4406bf），存进去的目标与操作快照先加密（`:123,163,221`）。
  - **人与开关都由它自己证明**：它证明调用者是活的宜搭锚点 owner，也就是它自己的拒绝；它只在宜搭发送开关为原文 `true` 时收草稿（`yida-owner-runtime.ts:194-197,223` 与 `index.ts:673` @e0e4406bf）。S4-e 不绕开这两条，也不替它们做决定。
  - **重复点击不会重复建**：内容相同的草稿再存一次，草稿库返回 `reused: true`（`yida-draft-plan-store.mjs:218` @e0e4406bf）。
  - 被否掉的另一种做法是直接调草稿库的内部写入器。那会多出一个不看发送开关、也不证明锚点 owner 的第二写入方。
- **目标只能是 1 号槽**：
  - 多目标开关不为 `'true'` 时，这个入口只认 1 号槽（`yida-owner-runtime.ts:28-29,338` @e0e4406bf）。
  - 多目标开关为 `'true'` 时，不带 `targetRef` 的草稿落在哪个目标，本 ADR **没有核**。所以 T 层默认是：S4-e 在这个开关为 `'true'` 的部署上一律拒写，记 `failed(draft_refused)`，直到 S4-e 评审读码证明缺省目标就是 1 号槽。
  - 正式表单（2–6 号槽）在任何情况下都不是 S4-e 的落点。
- **不能带 `generated`**：发送编译器在无绑定的行上拒绝 `generated` 字段（`yida-draft-compiler.mjs:228-232` @e0e4406bf），而 S4-e 的草稿永远无绑定。所以规则的宜搭配置里有 `generated` 条目时，路由在任何读之前就答 400 `TEST_COPY_DRAFT_GENERATED_UNSUPPORTED`。物料编码（R-71 ②）因此不在这个落点上。
- **键布局**：1 号槽在 L4 时封存的是 v2 物料模板的七键布局（`runbook-yida-first-send-20261104.md:36`），而一份 v3 草稿只能进封存键定义与它完全相同的目标（`yida-draft-compiler.mjs:290-291` @e0e4406bf）。布局不符就是入口自己的拒绝，记 `failed(draft_refused)`。
- **结果**：
  - 成功时的响应只有 `{ operationId, rowCount, reused }`。
  - 落库的是一行 values-free 摘要，`triggered_by = 'steps_draft'`，加进不计入规则监控的那张名单（同 §6.4）。
  - 失败时，入口的闭合错误码进 `errorClass`，原因是 `draft_refused`（§4.8）。
- **什么都不发**：S4-e 的模块不引用发送、批准、授权、准入、回执与表单传输（静态扫描）。存草稿前后，投递台账、批准、授权行与表单请求的计数都不变（G18）。之后要不要把这份草稿发到测试副本，是既有的宜搭 owner 发送路径上的事：R-50 / R-70 / R-71 逐次另批，发送时由发送编译器重算。S4-e 不改那条路径上的任何东西。
- **开关**：`INTEGRATION_AUTOMATION_TEST_COPY_DRAFT_ENABLED`（§7.8）。路由入口读一次，调用草稿入口之前再读一次，都只认原文 `true`。关着时路由固定 404，零读、零草稿。
- **门**：S4-e 是保证类切片，独立核验，每条守卫见证红（G18）。在任何部署上打开它的开关属 O ④；打开之后它会写表（宜搭本地草稿库），这一写属 O ②。两者一起由 owner 批，打开期间每一份草稿都由锚点 owner 本人点击产生。它读的那一次 PLM 照旧属 O ①（§7.9）。
- **依赖**：
  - S4-d：路由的准入、检查点与排空。
  - S4-a：宜搭方言。
  - 宜搭剩余系列（R-93）：`yida-draft-compiler.mjs`、`yida-static-plan.mjs` 与草稿库的测试正被宜搭栈的未合并分支修改（#6812 对 main 的差异里有它们）。所以 S4-e 在宜搭栈合并之后的 main 上开工，开工时重核本节的全部行号。

## 7. 安全

### 7.1 边界：谁控制什么

| 角色 | 能决定的 | 不能决定的 |
|---|---|---|
| 集成管理员（`integration:write`） | 登记系统的 origin、凭据与系统配置（对象条目、默认请求头、K3 的登录路径与请求体模板）；读源配置的路径、方法、字段映射；批准与退役 | 让未批准的版本被运行时使用 |
| 规则作者（`canManageAutomation` + 读层集成权限 + 租户内在役） | 选哪个已批准的操作、业务键的字面值或引用、步骤顺序与映射 | 端点、动词、请求头、请求体、凭据、超时、目的系统的地址 |
| 步骤数据（来自上一步） | 成为业务键的值，或转换的输入行 | 成为路径、主机、键名、列名、扩展函数名 |
| 部署者 | 四个开关（v5 加了落点的那一个）、出站写门的允许清单文件、B2a 登记（一条登记只授权一次读） | 用请求或规则配置改变以上任何一项 |

### 7.2 SSRF：为什么不是一道 URL 检查

- 现有两套守卫的策略是「只许 https、拒绝内网」，对规则作者可以随手写 URL 的 `send_webhook` 是对的（`automation-executor.ts:5303-5341`）。登记系统正相反：客户的 PLM / K3 就在内网、常是 http，这是 `http-adapter` 明确允许的（`http-adapter.cjs:67-76`）。把那两套守卫接过来，要么全拒、要么得开一个「内网白名单」——后者正是它们有意不提供的东西（`automation-executor.ts:5331-5332`）。
- 所以本线的防线是**规则作者根本没有地方写 URL**：目的 origin 来自登记系统（集成管理员），规则只带配置版本的引用与一个有界的业务键（`read-source-probe-runtime.cjs:84-118`）。至于路径，「来自已批准的配置」**要按种类说**（§2 ⑧）。路径守卫（`read-source-config.cjs:98-118`，保存时在 `:186` 调用）与执行时的再检查（`read-source-read-runtime.cjs:393-395`）在每个种类上看的都是已批准配置里的那个字符串，而适配器真正用的可以是另一个。在 `http` 种类上，它是登记系统对象条目里的路径，只经过适配器自己的相对路径检查（`http-adapter.cjs:78-90`、`:409`），从未到达这道守卫。在 K3 上，`material` 条目选了具名档案时用的是档案的读路径（§2 ⑧、§3.2），但 K3 适配器建立时会在钉住档案之后，对每个对象的有效读路径调用同一个守卫函数（`k3-wise-webapi-adapter.cjs:350-367`、`:763-766`、`:794-798`），所以档案路径经过了守卫；K3 的缺口只是「批准时检查的字符串不是上线的那个」。守卫自己的注释说它是「配置与 SSRF 之间唯一的屏障」（`read-source-config.cjs:94-97`）——在今天的 `http` 链上，这句话对存量对象条目里的路径并不成立。本线不削弱这道守卫，并且由 S1-b 把缺的那一段补上：会改写请求的对象条目即拒，wire 上的（方法, 路径）逐次断言。
- 这一段的影响范围也要说准，不夸大：系统配置与批准配置是**同一档**权限（登记系统、保存配置、批准配置都要 `integration:write`，`http-routes.cjs:8341,8477,8529`）；origin 的围栏不受影响；规则作者与步骤数据从中得不到任何东西。它修的是「已批准的路径 = 实际请求的路径」这句话，不是一个提权。
- 已知的残余，照实写：登记系统的 `baseUrl` 可以指向回环或链路本地地址，这由登记权限（集成管理员）承担，不是本线新引入的；本线不在自动化路径上另加地址类别过滤，因为那会把「能在工作台里读」与「能在规则里读」变成两套口径。要不要加，见 §12 OQ5 的子问。

### 7.3 重定向

- 事实：三个 HTTP 适配器的 `fetch` 都不带 `redirect` 选项、默认跟随（§1.2）。跟随之后**哪些东西会到达另一个地址，要说准**。用一个只连本机回环的独立脚本在本地 Node v20 上看到的是：跨 origin 的跳转会丢掉 `Authorization` 与 `Cookie`，但**自定义请求头照常转发**，307 会把 POST 的请求体**重发**一遍；生产运行时没有核（附注）。对本线的三个适配器，会被带过去的因此是：`http` 的 API key 头（它用自定义头名，`http-adapter.cjs:149-154`）与 `config.headers` 里的任何认证头、K3 的会话头（`k3-wise-webapi-adapter.cjs:1918-1919`）、桥的共享密钥头（`bridge-agent-readonly-adapter.cjs:198-204`），以及 307 / 308 下 K3 与桥那两个带体读的请求体——里面有业务键。`http` 的 Bearer / Basic 走的是 `Authorization`（`http-adapter.cjs:146-148,155-158`），在这个运行时上不会被带过去。无论带过去的是哪一样，跳转的目的地都从未被任何人批准过。
- 决策：经本线服务发出的每个请求都是 `redirect: 'manual'`，3xx 即终态拒绝（§3.2）——同一个脚本看到的是：带上这个选项，拿到的就是那个 3xx 本身，没有第二个请求。只对自动化调用方生效，既有调用方不变。
- 为什么不直接改适配器的默认值：那是对管道、工作台探测与备料拉取的行为变更，现场是否有依赖跳转的源（例如 http 跳 https）没有人数过。由谁、何时把它收敛成适配器的默认行为，见 OQ5。

### 7.4 `buildUrl` 的路径事实

- 事实，**按种类不同**：`http` 把路径补成以 `/` 开头再交给 `new URL(path, baseUrl)`，所以总是从 origin 根解析，`baseUrl` 里的路径前缀不起约束作用（`http-adapter.cjs:89,127-131`）；桥用的是同一种解析（`bridge-agent-readonly-adapter.cjs:207-209`）。**K3 不是这样**：适配器把基路径拼在端点前面（`k3-wise-webapi-adapter.cjs:429-442`），基路径是 wire 路径的一部分。读源配置的路径守卫另外挡掉了 `..`、`//`、scheme 与百分号编码。
- 决策：**不把基路径当围栏，也不在本线改任何一种解析规则**（改了会让已批准的配置解析到别的地址）。围栏是 origin 加（方法, 路径）清单：本线服务在出站前断言最终 URL 与登记系统的有效 origin 同源、请求在清单里（§3.2），认证材料也是按 origin 绑定的（§7.5）。写给集成管理员的配置说明**按种类写**：`http` 与桥上基路径不能把访问限制在某个子目录下，K3 上基路径会被拼进去；并写上 §4.6 那句关于列表读完整性的话。

### 7.5 换 origin 或认证身份，必须重给认证材料

- 事实：§1.3——配置更新是顶层 PATCH，没给的键继承；不带 `credentials` 即保留旧密文。认证材料不只在密文里，还在配置里；三个适配器取 origin 的键序也不同。
- **定义。** 一个登记系统的**有效 origin** 按该种类适配器自己的键序取：`http` 与 K3 是 `baseUrl || url`（`http-adapter.cjs:231`，`k3-wise-webapi-adapter.cjs:1785`）；桥是 `baseUrl || bridgeUrl || url`，全空时是适配器内置的本机缺省地址（`bridge-agent-readonly-adapter.cjs:43,120-121,311`）——所以把这些键清空也是一次 origin 变更。**认证材料** = 密文，加上配置里承载认证的键，按种类是一张闭合的表：

  | 种类 | 配置里的认证材料键 |
  |---|---|
  | `http` | `headers`、`apiKeyHeader`（`http-adapter.cjs:150-152,233-237`） |
  | `erp:k3-wise-webapi` | `headers`、`authorityCode`、`authMode`、`sessionHeader`、`tokenQueryParam`（`k3-wise-webapi-adapter.cjs:1799-1801,1835,1918,1923-1924`） |
  | `bridge:legacy-sql-readonly` | `sharedSecretEnvVar`、`authHeaderName`（别名 `headerName`）、`authMode`（`bridge-agent-readonly-adapter.cjs:189-204`） |

- **决策。** 一次更新只要满足下面任一条，就必须在**同一次请求**里对认证材料逐项表态：`credentials` 键必须出现（新值，或显式 `null` 清除），库里已有的每一个认证材料键也必须出现（新值，或显式 `null` 清除）。任何一项没有表态即拒绝，固定码 `EXTERNAL_SYSTEM_CREDENTIAL_REBIND_REQUIRED`。
  1. **有效 origin 变了**（协议、主机、端口任一不同）。库里一行密文都没有、认证头只在 `config.headers` 里的系统同样适用——原稿的规则只在「库里有密文」时触发，漏的正是这一种。
  2. **配置里决定「用哪一份密钥、以什么身份认证」的键变了**：K3 的 `authorityCode` / `authMode`，桥的 `sharedSecretEnvVar` / `authMode`。原稿在这里写的是「K3 的账套变更」，那是错的：账套在凭据文档里（`k3-wise-webapi-adapter.cjs:1937`；实例摘要读的也是凭据，`external-systems.cjs:1224`），不重给 `credentials` 根本改不到它。

  只换密文（轮换密钥）、同源内改路径或其它配置，不受影响。
- 这是登记处的行为，对所有调用方生效，不是自动化专属。首批只对上表三个种类定义——其余种类取 origin 的键序与配置里的认证键本 ADR 没有读（附注），S1-c 评审时逐个补，补之前它们的更新行为不变。它是 §8 梯子 L2 的硬前置；由本线交付（切片 S1-c）还是由持有 S0-b 的那条线交付，见 OQ5。

### 7.6 终态写的尝试身份

- 本线的读步骤**不写意图行**（§4.6），因此不新增任何「先写 pending、后写终态」的位置；这一点由静态守卫钉住（新动作的模块不引用 `claimOutboundIntent` / `recordOutboundOutcome`），免得出现只用了台账一半的路径。
- 本线**只有一个**新的值落库位置，就是 v5 的落点：S4-e 经既有的宜搭 owner 草稿入口存进宜搭本地草稿库的那份草稿，草稿库先加密再写（§6.5）。它不是一个新表，也不是一个新写入方。除此之外，步骤输出不持久化（§5.4），落库的只有 values-free 的步骤结果与预览、存草稿两行摘要。S4-e 不写意图行：它不发宜搭，「发出去了但不知道成没成」的歧义不存在；重复点击由草稿库的 `reused` 吸收（§6.5）。后置的快照切片要自己回答「与挂起行、桥行是不是一个事务」（§5.4 契约的第 2 条）。
- 发送切片继承 §1.6 的全部语义：认领发令牌，结果写以令牌为围栏，0 行即 `confirmed:false`、步骤不得报成功；过期的 `pending` 只由观察到同一令牌的重放翻成 `outcome_unknown`；需要长于租约的写要按令牌续租。这些是契约，不是本线的实现。

### 7.7 K3：永久写围栏管到哪里，读腿的残余在哪里

- 本线的服务只调用适配器的 `read`；K3 适配器的 `upsert` 在登录之前就被无条件拒绝（围栏第四层，`k3-external-write-permanent-fence.cjs:32-35`）。静态守卫：服务模块里不出现 `.upsert(`、`testConnection(` 与任何按路径发请求的调用。
- **这只关上了 `upsert` / apply 面，没有关上读腿。** 围栏的四层全部落在 apply / upsert 面上（`k3-external-write-permanent-fence.cjs:24-35`）。K3 的读是带体的 POST，不经通用写门；把一个读路径与一个写端点分开的，只有适配器里一张 12 个词的写端点词表（`k3-wise-webapi-adapter.cjs:271-274`）。适配器自己的注释把话说死了：三个性质里 AGREEMENT 与 COVERAGE 是闭合的，「VOCABULARY (which endpoints count as writes) .... NOT CLOSED」（`:263`）；以及「It does not close VOCABULARY: an unlisted verb still passes」（`:294-295`）。读请求体以系统配置里的模板为底（`:1273-1282`；选了档案的条目由 S1-b 即拒，§3.2）；已批准配置的路径守卫只查字符（`read-source-config.cjs:98-118`）。也就是说：持 `integration:write` 的人把一个词表之外的动词写成读路径、再配上请求体模板，这个「读」就会带着凭据打到那个端点上。这不是本线引入的——工作台的配置读今天就走同一条腿；本线增加的是**按计划重复执行**。目标 K3 上是否真有这样一个词表外的写端点，没有核实。
- **所以对 K3 种类，本线不声称代码守住了读腿。** 可证明的保证是客户侧的只读账号——保证在账号层，代码里的词表是纵深。它是 K3 种类进 L3 的**硬前置**，逐系统核对后才谈批准（§8）。要不要在本线把读路径做成正向目录（只收适配器内置的读端点、严格模式下拒绝存量的读请求体模板），交 owner 裁定（OQ10）。
- 一个 `baseUrl` 指向 K3 的通用 `http` 系统不在围栏的判定范围内（§1.2）——它靠出站写门挡。所以 §4.3「POST 形状的读不加旁路」不只是整洁问题：一条旁路就等于给「把 K3 的写接口登记成 http 系统的读操作」开了门。
- 发送切片：见 §4.3 第 3 条。没有任何开关、策略、审批结果或请求参数能解锁 K3 写，本 ADR 不预留。

### 7.8 开关：默认关、只认原文 `true`、登记清单

| 开关 | 读取点 | 关着时 | danger | 打开归谁 |
|---|---|---|---|---|
| `INTEGRATION_AUTOMATION_CALL_CONNECTION_ENABLED` | core 保存校验；执行器每次触发；插件服务出站之前；手动预览路由 | 含该动作的规则保存 403 `CALL_CONNECTION_DISABLED`；既有规则触发记 `skipped(action_disabled)`（步骤状态 `failed`，规则停在这一步）；预览路由固定 404；编辑器不渲染该动作 | high | 上机属 O ④；对真实系统的读属 O ①（§7.9） |
| `INTEGRATION_AUTOMATION_CALL_CONNECTION_WRITE_ENABLED` | **本线不读**（写目标配置保存一律 400） | — | high | O ②③（§12 OQ2） |
| `AUTOMATION_STEP_OUTPUTS_ENABLED` | core 保存校验（规则带 `stepKey`、步骤引用或 `transform_records`）；执行器每次触发 | 保存 403 `STEP_OUTPUTS_DISABLED`；触发记 `skipped(action_disabled)`（同上） | medium | T 层梯子（上机仍是 O ④） |
| `INTEGRATION_AUTOMATION_TEST_COPY_DRAFT_ENABLED`（v5，落点） | S4-e 存草稿路由：入口一次、调用宜搭 owner 草稿入口之前再一次（§6.5） | 路由固定 404，零读、零草稿；编辑器不渲染「存为测试副本草稿」 | high | 打开属 O ④；打开之后它写宜搭本地草稿库，这一写属 O ②（§6.5、§7.9） |

- 四个都是 `type: 'boolean'`、`activationValue: 'true'`、不修剪不折大小写（`'1'`、`'TRUE'`、`' true'` 都是关）、`dependsOn: []`、`conflictsWith: []`，登记在 `scripts/ops/global-history-flag-manifest.mjs` 里 R-69 四个开关之后（条目范例 `global-history-flag-manifest.mjs:1034-1043`）。四者互不联动：`call_connection` 不带 `stepKey` 时只报计数、不需要第三个开关；带了就需要。第四个开关**不**取代宜搭发送开关：S4-e 借用的草稿入口自己还要 `INTEGRATION_YIDA_OWNER_SEND_ENABLED` 为 `'true'`（`index.ts:673` @e0e4406bf），两者是「且」。这一层依赖不写成 manifest 里的 `dependsOn`，因为那是宜搭线自己的开关，它的读取点与登记都不归本线。
- **S4-e 登记开关 ④**：它的第一个读取点就在 S4-e 的路由里。登记内容包括清单条目、显式读取点测试与 `.env.example` 的默认关示例行。若读取点落在缺省扫描面之外，或被一个精确列表断言抓到，照下一条的同一教训处理：加族扫描、更新列表，不能让它静默漏登。
- **谁登记：落下该开关第一个读取点的那个切片**，不是「做动作的那个切片」。清单测试的缺省扫描面只有 `packages/core-backend/src` 下的 `*.ts`（`global-history-flag-manifest.test.mjs:369-375`），插件 `lib/` 只按**点了名的族**扫（`:503-507`），而既有的那一族正则 `INTEGRATION_AUTOMATION_RUN_…`（`:459`）匹配不到 `…_CALL_CONNECTION_…`。所以开关 ① 在 S1-b 落进插件 `lib/` 的那个读取点不在任何被扫描的集合里——**不登记，测试照样是绿的**，章程「新增 env flag 必须登记」会被静默地漏掉。因此：
  - **S1-b 登记开关 ①**：清单条目；给插件 `lib/` 加一条匹配新名字的族扫描，并把它并进完整性断言（`global-history-flag-manifest.test.mjs:598-616`）；一条显式的插件读取点测试（先例 `:1376-1387`；被读的谓词照 `integration-run-events.cjs:32-34` 的形状）；仓库根 `.env.example` 的默认关示例行。G7 多一条负对照：插件 `lib/` 里不存在未登记的对开关 ① 的读取。
  - **S3-a1 登记开关 ③ 与 ②**：③ 的第一个读取点在 core，`env.AUTOMATION_*` 的读取点扫描（`global-history-flag-manifest.test.mjs:1205-1212`）会自己抓到它，那条精确列表断言（`:1214-1224`）当场变红——带来这个读取点的切片必须同时更新列表与清单，拆不开。② 只登记不读：幽灵检查（`:598-627`）要求每个登记的键都在被扫描的源码里出现，所以它的名字像 `automation-run-integration-job.ts:45-48` 那样写进 core 的动作模块，随 S3-a1 落地。同一个切片补上开关 ① 在 core 的读取点与显式读取点测试（范例 `global-history-flag-manifest.test.mjs:1312-1346`，含「不得按前缀匹配」的断言 `:1337`，以及对 `.env.example` 示例行的断言 `:1346`）。
- **OQ3 的守卫带来对一个既有开关的依赖**：I 链那个「规则所在的表」守卫只在 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 恰为 `'true'` 时才把登记表当权威，关着时一律判 `switch_off`、失败关闭（`automation-run-integration-job-rule-sheet.ts:19-21`）。所以若 OQ3 取建议值，这个既有开关就是本线的一个前置，要写进 L2（§8）；它不是新开关，不需要重新登记。
- 会话特性：把第一个与第三个开关的布尔值露给编辑器（`core-backend/src/routes/auth.ts:334-338` 的做法），关着的功能在界面上不可见。v5 的第四个开关同样露给面板：关着时「存为测试副本草稿」不渲染（S4-e）。

### 7.9 O 层的门

- **O ① 真实客户读**：对客户真实系统的每一个「系统 × 操作」的首次读——不论由定时规则还是手动预览触发——逐项由 owner 批准；登记系统换 origin 之后，它上面此前批准过的每个操作重新算作首次读（§4.1 的残余）。机制上挡在前面的有：开关、读源配置的批准状态、规则创建者的实时权限；部署已武装 B2a 时再加一层登记。**B2a 登记不是长期授权**：一条登记只授权一次读（§1.4、§3.2），已武装的部署上定时读在 OQ8 裁定之前一律被拒，手动预览每读一次用掉一条登记；休眠的部署上这一层不存在，挡在前面的只有前三样加 owner 的逐项批准。K3 种类另有一条硬前置：客户侧的只读账号（§7.7）。开发与 CI 只用合成的登记系统。
- **O ② 生产写 / O ③ 外部写回**：本线不含任何外部写路径。v5 的唯一一写是 S4-e 往宜搭本地草稿库存测试副本草稿（§6.5）：在部署上打开它的开关、以及打开后的这一写，属 O ②，由 owner 批；它不发宜搭，不是 O ③。把草稿发到测试副本仍走既有的宜搭发送路径，按 R-50 / R-70 / R-71 逐次另批。发送切片的每一个写操作、写开关的打开、允许清单文件里的每一个条目，都逐项由 owner 批准；K3 写永久禁止，不在可批准之列。
- **O ④**：上机、在任何部署上打开开关、开对外 PR。把任务卡交给第三个实现方已由 R-95 裁定，不再是待裁事项（§10.4）；它的 PR 合并仍逐项批。

### 7.10 CI 必须钉住的守卫

每一条都要三样东西：一个正对照（合法路径确实通）、一个负对照（被禁的路径确实被拒）、一个见证红的变异（去掉守卫，测试变红）。只有负对照的守卫可能是空转的，不算数。

| # | 守卫 | 正对照 | 负对照 | 见证红的变异 |
|---|---|---|---|---|
| G1 | 只能引用具名操作 | 引用一个已批准版本的规则保存成功 | 配置里出现 `url` / `path` / `method` / `headers` / `body` / `query` / `timeoutMs` 任一键即 400；引用 `draft` 或 `retired` 版本即拒 | 去掉闭合键集检查 |
| G2 | 一个门 | 扫描确实找到那唯一的出站调用点（端口的 `callRead`） | core 的新动作模块里没有 `fetch` / `http` / `https` / `undici` / `axios`；插件服务里没有 `.upsert(`、`testConnection(` | 在动作里加一处直接 `fetch` |
| G3 | 写默认拒绝（v5：保存那一半随 S3-a1；`http` 传输那一半随 HTTP 种类准入，§11） | `http` 种类上无体的 GET 读成功 | 引用写目标配置的规则保存 400（开关设成 `true` 也一样）；端口的键集恰为两个方法；写门操作词表恰为两项；`http` 种类上写门 env 未设时，POST 形状的读零出站、步骤是 `skipped(write_gate_refused)`——原始拒绝码经这条链观察不到（§3.2），断言的是出站计数与闭合原因 | 给服务加一个按目录分类跳过写门的分支；去掉入口对写门拒绝码的识别（步骤于是被读成认证失败） |
| G4 | 重定向（v5：随 HTTP 种类准入，§11） | 本机夹具回 200 时读成功 | 夹具回 302 时步骤 `failed(redirect_refused)`，跳转目标上的请求计数为 0、从未见到任何请求头；307 加 POST 体同样为 0 | 去掉 `redirect: 'manual'`；去掉包装对 3xx 的记录（步骤于是变成 `source_error`） |
| G5 | 同源与路径（v5：路径守卫那一条照常；其余随 HTTP 种类准入，§11） | 已批准路径解析到登记的 origin；`http` 系统的对象条目不存在或是字符串形时、K3 系统的 `material` 条目不选档案时读成功，wire 上的（方法, 路径）等于已批准配置；已批准路径带单点段时按规范化后的 pathname 比较、读成功 | 含 scheme、`//`、`..`、百分号编码的路径在保存与执行两处都被拒；交给包装的请求 URL 不同源即拒、不发出，原因是 `origin_refused`；`http` 系统的对象条目带 `path` / `method` / `query` / `headers` 任一键 → `describeRead` 与每次调用都答 `system_overrides_request`、零出站（四个键各一条）；**K3 的负对照**（用 `single_record` 配置：`list_page` 下适配器在发请求前就拒绝，档案路径到不了包装，两层变异无从见证）：`material` 条目选了只存档案、已批准路径与档案的不同 → `describeRead` 与每次调用都答 `system_overrides_request`、零出站，且这样的系统上 K3 清单的内容不含档案路径（直接断言清单）；K3 与桥各一条「清单外的（方法, 路径）不发出」，原因是 `request_not_allowed`。每条都同时断言出站计数与闭合原因；K3 用会话凭据夹具，登录腿不出站，零出站指整次调用 | 去掉执行时的再检查；去掉包装里的同源断言；去掉 `http` 对象条目的拒绝（存量路径于是到达包装，被清单断言拦下——两层各见一次红）；去掉 K3 的档案拒绝（档案路径于是到达包装，被清单断言以 `request_not_allowed` 拦下、档案路径上的请求为 0——拒绝这一层见红；再同时去掉清单断言，档案路径上出现一个请求——清单这一层见红）；K3 清单改为取适配器合并后的读路径（清单内容的断言变红）；去掉清单断言 |
| G6 | 换源重绑 | 同源内改路径不要求重绑；只换密文不要求重给配置键；一次把认证材料逐项表态的更新成功 | origin 变更而请求里没有 `credentials` 键即拒；认证头只在 `config.headers`、库里没有密文时换 origin 而不重给 → 拒；桥系统只改 `sharedSecretEnvVar` 而不对其余认证材料表态 → 拒；经 `bridgeUrl` 键换 origin、把三个地址键清空落回内置缺省，都算变更；K3 改 `authorityCode` / `authMode` 同理 | 去掉 origin 比较；把触发条件改回「库里有密文才查」；桥的键序里漏掉 `bridgeUrl` |
| G7 | 开关 | 原文 `true` 时可保存、可执行 | `'1'`、`'TRUE'`、`' true'`、未设都是关；关着时保存 403、触发记 `skipped(action_disabled)`（步骤状态 `failed`）、端口调用 0 次；插件 `lib/` 里没有未登记的对开关 ① 的读取 | 读取点改成 `!== 'false'`；插件侧的读取点删掉；清单里删掉开关 ① 的条目 |
| G8 | 运行身份 | 在役且有权限的创建者触发成功 | 撤权后的下一次触发即 `skipped(principal_unauthorized)`；无权限的操作者不能保存、启用或重试；客户端送来的 `binding` 被丢弃；无租户主体保存即拒；SQL 只读源上，非属主的创建者保存即拒、非属主的操作者不能启用或重试（`system_unavailable`）；系统侧对象条目会改写请求时（`http` 的改写键、K3 的档案条目）保存即拒（`system_overrides_request`，变异见 G5） | 去掉触发时的实时复核；操作者检查改成只查创建者；去掉属主戳的比对 |
| G9 | 引用完整性 | `call_connection → call_connection`（标量）与 `call_connection → transform_records`（行集）的引用在保存与运行时都解析成功 | 前向、自引用、未知键、未声明列、别的运行的句柄、原型链上的名字一律拒绝；目标名带点号 / 冒号 / 连字符、以数字开头或是保留名的配置在 `describeRead` 被拒（`columns_not_admitted`）；`concat.fields` 指向未声明列保存 400；既有动作里的 `{{steps.…}}` 与裸 `steps.…` 表达式保存 400 | 去掉容器的前序检查；去掉列名准入；把交给引擎的行换回普通对象 |
| G10 | 值不进日志 | 哨兵在运行内通道里找得到 | 哨兵在 §5.7 列的每一个持久面与日志里命中 0 次（成功、失败、超时三条路径）；放在桥对端错误码里的哨兵同样 0 次；`step.output` 多一个键即红 | 把原始结果赋给 `step.output`；`errorClass` 改取适配器的原始错误码 |
| G11 | 快照与续跑（**后置，不随本线交付**） | — | 契约与对照见 §5.4；首批由 G14 的「不与会挂起的动作同规则」顶替 | — |
| G12 | 完整性与上限（v5：首片只做 SQL 只读源那一对与它的信号 2；K3 与桥的各对随种类准入，§11） | 99 行的读（K3 的列表读：9 行；桥：缺省 `maxLimit` 的夹具上 19 行，`maxLimit` 为 500 的夹具上 99 行）被完整发布 | 恰好 100 行（K3：10 行；桥用 `maxLimit` 为 500 的夹具）即 `failed(row_cap_reached)`、不发布；缺省 `maxLimit` 的桥夹具上一页 20 行即 `failed(source_incomplete)`（信号 3）、不发布；§4.6 表里每个种类的每个信号各一条 `failed(source_incomplete)`；§5.6 每一项超限都失败；规则配置、请求体与端口入参里的 `rowCap` 一律被拒 | 把 `CONFIGURED_READ_AUTOMATION_ROW_CAP` 调大十倍（100 行的负对照变红；桥夹具取 `maxLimit` 500 而不是 100 正是为了这条——`maxLimit` 为 100 时上限调大后发给源的仍是 100，信号 3 会把这一页拦下，变异只能从原因上看出来）；把平台常量 `READ_SOURCE_PROBE_ROW_CAP` 调大十倍（K3 的 10 行负对照变红）；§5.6 的 core 常量各调大十倍；逐个去掉 §4.6 的信号 2、3、4（去掉信号 3 时缺省桥夹具的 20 行负对照变红） |
| G13 | 宜搭方言（v5：只调规划器；原「对拍」随 OQ6 的退路挪到 §11） | 全部有效的批次被发布，发布的是规划器一侧的行、缺的列补成 `null` | 含无效行、重复键或空批次得到 `failed(yida_plan_rejected)`、不发布；配置读未声明的列保存 400 | §6.3 列的四条变异 |
| G14 | 放置与既有不变量 | 顶层的定时规则可保存 | 进分支（含条件分支，那里要显式拒绝）、带条件、非定时触发、相邻触发近于 15 分钟的 cron、上按钮路由、进审批触发器白名单、`call_connection` 超过 8 步、与 `start_approval` 或顶层 / 分支内的 `wait_for_callback` 同规则——都被拒；真发测试答 `TEST_RUN_ACTION_UNSUPPORTED`；模拟时端口调用 0 次；任何非 `ok` 结果之后，同规则里排在后面的发送类动作一个都不执行。合成目录仍只有一个操作、其步骤类型仍不在 `ALL_ACTION_TYPES`；`IntegrationRunSummary` 的键集不变 | 把新类型加进并行分支白名单；去掉条件分支里的显式拒绝；把同规则检查改成只看顶层；把门拒绝的步骤状态改回 `skipped` |
| G15 | B2a | 休眠部署上字节不变；已武装且有登记时，手动预览的一次读成功 | 已武装而无登记时在凭据加载之前被拒；**同一条登记上的第二次读被拒**（另一次预览、同一次预览里的另一步都算）；已武装部署上定时触发的读被拒且不消耗登记；新用途在闭集里、别的用途的登记不能被它花掉 | 把出示用途的调用挪到凭据加载之后；把 `runId` 改成由规则 id 派生（第二次读于是放行） |
| G16 | 预览行只留在面板内存 | 预览成功后行显示在面板里 | 不写 `localStorage` / `sessionStorage` / IndexedDB；取消、清除、关闭抽屉、重开与卸载之后行都不在了；响应带 `no-store` | 把结果存进 store 或浏览器存储；去掉卸载时的清空 |
| G17 | K3 读腿的写端点词表（v5：随 K3 种类准入，§11） | 词表外、形如读端点的路径经假 `fetch` 读成功 | 已批准配置的读路径含词表里的任何一个词 → 适配器建立时即拒，步骤是 `skipped(adapter_refused)`、零出站（带扩展名、不在末段两种写法各一条） | 同时去掉适配器建立时的检查与 wire 关口的读意图检查——本线的零出站断言必须变红 |

| G18 | 落点只存测试副本草稿（v5，S4-e） | 两个开关（落点开关与宜搭发送开关）都为原文 `true`、操作者是规则所有者且是活的锚点 owner 时，合成部署上恰好多出一份发往 1 号槽的草稿操作；草稿内容等于草稿库从同一段行文本自己重算的结果；同一内容再存一次得到 `reused: true` | 落点开关不是原文 `true` → 404，零读、零草稿；宜搭发送开关关着 → `failed(draft_refused)`、零草稿；非锚点 owner → `draft_refused`；多目标开关为 `'true'` → 拒写（§6.5）；请求体带行、配置、`targetRef` 或 `sourceBinding` 任一键 → 400；宜搭配置带 `generated` → 400，在任何读之前；最后一步不是宜搭方言 → 400；存草稿前后投递台账、批准、授权行与表单请求的计数都不变；S4-e 模块里没有对发送、批准、授权、准入、回执与表单传输模块的引用 | 让路由接受客户端的行；给 `prepareDraft` 传 `targetRef`；去掉落点开关的第二次读取；把写改成直接调草稿库的内部写入器（静态扫描变红）；去掉 `generated` 的前置拒绝（草稿库以 `PLAN` 拒绝，原因从 400 变成 `draft_refused`，断言变红） |
| G19 | 点选的那一行（v5，S4-d） | 规则带 `rowInput`、操作者读得到规则所在表上的那条记录时，预览把它的声明列当业务键读一次、并把声明列并进转换的每一行 | 带 `rowInput` 的规则保存成启用或被启用 → 400 `ROW_INPUT_PREVIEW_ONLY`；记录在别的表上、操作者读不到、缺声明列 → `not_started(row_unavailable)`、零出站；不带 `rowInput` 的规则收到 `recordId` → 400；带 `rowInput` 而缺 `recordId` → 400；`row.` 引用出现在 `call_connection.inputs.key` 与 `withRow` 之外 → 保存 400；行列名与源列重名 → 保存 400；这一行的值在 §5.7 的每一个持久面上 0 命中 | 去掉「不能启用」的检查；把这一行的读换成插件或提权读；去掉「必须在规则所在表上」的比对 |

G17 钉的是本线对既有词表的**依赖**，证明这条对照不是空转；它不把词表说成闭合的（§7.7）。G11 留着编号但不随本线交付。

**v5 对 G10 的修订**：S4-e 让宜搭本地草稿库成了本线唯一允许落值的面（§6.5、§7.6），这与 §5.4 契约第 6 条「哨兵在快照表里找得到、在其它持久面找不到」是同一个形状。所以 S4-e 重跑 G10 时：哨兵在草稿库经它自己的读取器解密之后必须找得到（大于 0），在草稿库的密文列、§5.7 的其它每一个持久面与日志里都是 0 次。草稿库里凡是不加密、而又带值的列，S4-e 评审时逐列点名，加进 G10。

## 8. 上线梯子与回退

每一级都由 owner 另批，上一级成立不自动成立下一级。

- **L0** 合并休眠代码：四个开关未设；迁移只放宽 CHECK（本线不新增表），旧代码不写新值。
- **L1** 上机，开关仍不设。
- **L2 的前置**（全部成立才谈打开）：① §7.5 的重给认证材料在 main 上（S1-c，或 S0-b，看归属裁定，§11.1），有见证红的测试；§7.3 的重定向拒绝、§3.2 的对象条目拒绝与（方法, 路径）断言只在某个 HTTP 种类准入时才成为前置（v5：形态 B 首片不收 HTTP 种类）；② 规则创建者的令牌带租户、且在该租户恰有一行在役成员关系（与桥 ADR §7 的 L2 前置相同）；③ 目标系统上有一份由集成管理员批准的读源配置；④ 若 OQ3 取建议值，`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 在该部署上恰为 `'true'`（§7.8）；⑤ 推荐由租户绑定的服务账号经 API 创建规则（桥 ADR §6.2 的建议，理由相同：人员变动不影响定时读）。B2a 不在 L2 的前置里：L2 只读合成系统。
- **L2** 打开两个读取开关，只对**合成的登记系统**建一条定时规则与一次手动预览，观察步骤结果与日志。
- **L3**（O ①）对客户真实系统的第一个读操作：逐系统、逐操作批准。**K3 种类的硬前置**：该系统连的是客户侧的只读账号，批准之前逐系统核对（§7.7）。次序是先手动预览、再谈定时。**部署已武装 B2a 时，L3 只有手动预览这一种形态**——每次预览读用掉一条登记，定时读要等 OQ8 的裁定（§3.2）。所以「已武装」不是 L3 的一个前置条件，而是决定 L3 长什么样的分支：把它当前置的话，第一次定时读之后的每一次都会失败。
- **L3-d**（v5，O ② + O ④）打开落点开关 `INTEGRATION_AUTOMATION_TEST_COPY_DRAFT_ENABLED`，让锚点 owner 把场景的结果存成 1 号槽测试副本的草稿（§6.5）。前置有四条：
  1. L3 的那一个 PLM 读操作已经批准，并在手动预览里看过；
  2. 该部署上宜搭发送开关已按 R-50 / R-70 打开——这是宜搭线既有的门，不由本级打开；
  3. 1 号槽已初始化，它封存的键布局与场景的宜搭配置相符（`runbook-yida-first-send-20261104.md:36`）；
  4. 多目标开关不为 `'true'`，除非 S4-e 评审已证明缺省目标是 1 号槽（§6.5）。

  先在合成部署上演练一遍。把草稿发到测试副本不在本级，仍按 R-50 / R-70 / R-71 逐次另批。
- **L4**（O ②③，另一个切片）写。
- **回退**：把开关改成 `=false` 并重启、确认进程里读到的是关，**然后**再删那一行——只删行再重启不会把变量从运行中的进程里清掉（`222-deploy-window-runbook-20260901.md:977` 记的实测）。回退不需要迁移回滚；规则留在表里，每次触发在这一步记 `skipped(action_disabled)`——步骤状态是 `failed`，所以这些规则在监控里会按次显示为失败，直到有人把规则停掉。这是有意的（§4.4），做回退的人要事先知道。动作 CHECK 的 `down()` 只在该类型从未被保存过的部署上是无害的（与 `zzzz20261106111300…:1-8` 的说明相同）。

## 9. 可观测与 values-free

- **执行行**：新步骤的 `step.output` 只有 §4.8 的闭合键——结果、原因、操作引用（种类与配置版本 id）、行数 / 列数 / 字节数、是否触顶、是否完整、时长、错误类别。没有行、没有字段值、没有端点、没有连接信息、没有业务键的值。
- **配置读的证据**：它自己的证据面已经是 values-free 的，但内部页对象带行指纹（对行做 sha256，`read-source-read-runtime.cjs:180-182`）——那是值的派生物，core 的消毒只留计数与布尔，指纹不进 `step.output`。服务读内部页对象只为得出完整性的布尔与原因（§4.6），页对象本身不出服务。
- **日志**：新代码的每一条日志只带 `ruleId / executionId / stepKey / configId / status / errorClass`；主体 id、租户 id、系统 id 不进日志行；从不记 `error.message`（适配器错误的消息与 `details` 可能带路径或响应体）。
- **规则快照**：`rule_snapshot` 里会有规则配置，包括写成字面量的业务键——它是规则作者自己写进规则的配置，与既有动作配置同一类；`binding` 在界面上显示为占位（执行详情页对作业动作的既有做法，`AutomationExecutionsView.vue:227-318`）；`operation.workspaceId` 同样显示为占位——workspace 提示在实践中常与租户标识同值（登记处自己的注释，`external-systems.cjs:973-975`）。
- **证据面**（issue / PR / 登记册）：只记状态与计数；不记系统名、配置名、业务键、任何读到的值。

## 10. 切片、测试与变异见证

### 10.1 切片与依赖

规模按生产代码估（不含测试）：S < 200 行，M 200–500 行，L 500–1000 行。这是读码后的估计，不是承诺。开关一列的 ①②③ 按 §7.8 表的行序：① 连接调用，② 连接调用的写，③ 步骤输出与转换。「保证类」指授权、门、凭据、锁、台账、隔离——要独立核验并逐条见证红。

三行规模是拿先例切片校过的（`git show --numstat`，只数生产代码行）；原稿对这三行估低了：

| 先例切片 | 生产代码行 | 对照本线 |
|---|---|---|
| I 链的动作 #6789（`dc13df127`） | 1,589；其中端口与接线 417、授权模块 142、动作本身 1,030 | 动作本身 → S3-a1 + S3-a2；端口与接线 → S1-b |
| I 链的前端 #6793（`ea8aa7373`） | 8 个 web 文件 664 | S3-b1 + S3-b2 |
| 合成预览 #6764（`08dd1f604`） | 预览运行时 669、路由 131、日志服务 82、服务 67；面板 246、客户端 83 | S4-d |

原稿的 S3-a 是一个切片；照先例它在 1,030 行上下，**超出 L 的上限**，所以按「存得进去」与「跑得起来」拆成 S3-a1 与 S3-a2 两个 PR。

| 切片 | 内容 | 规模 | 依赖 | 迁移 | 开关（登记 / 读取点） | 类别 | 第三个实现方 |
|---|---|---|---|---|---|---|---|
| P0 | 本 ADR（登记行由主会话另行入册） | — | — | — | — | 文档 | 否 |
| S1-a | 插件：抽出 `runGovernedConfiguredRead`（含可选的 `workspaceId` 输入与 `signal` / `checkpoint` 两个可选成员；`options` 的闭合键集只收这两个，§3.1），HTTP 逐字节不变，加检查点。**v5：现在可在本地开工**，带冻结的验收契约 | M | — | 无 | 无 | 保证类 | 否 |
| S1-b | 插件 + core：连接调用服务、`ConnectionCallPort` 与登记接线、`describeRead` 的各项准入（v5：种类准入表只有 `data-source:sql-readonly`）、入口的 `readPurpose` 与 `rowCap` 两个成员、B2a 新用途与一次性规则、完整性判定、在途上限。v5 **不含**传输包装（不跟随重定向、同源与（方法, 路径）断言）、对象条目拒绝与写门拒绝的识别——它们随第一个 HTTP 种类的准入交付（§3.2、§11）。没有生产调用方，休眠合并，经测试夹具验证（§10.2） | L（v5 收窄后估 M–L） | S1-a | 无 | **登记 ①**；① 的插件侧读取点 | 保证类 | 否 |
| S1-c | 插件：origin 或认证身份变更必须重给认证材料（若由本线交付，OQ5）。**v5：等 S0-b 归属的裁定**（Codex 线，§11.1），两边不同时做 | M | S0-b 归属裁定 | 无 | 无 | 保证类 | 否 |
| S2-a | core：**只有库**——容器一般化、严格解析器、输出声明与 `step.output` 契约的类型。不碰保存门、不读开关；经测试夹具验证（§10.2）。**v5：现在可在本地开工**，带冻结的验收契约；它不依赖 S1-b | M | — | 无 | 无 | 保证类 | 否 |
| S3-a1 | core：`call_connection` 的类型、CHECK 迁移、配置解析与闭合校验、`describeRead` 盖章、保存门（触发耦合、cron 间隔、放置、同规则检查）、`stepKey` 与保存时引用图、操作者权限、会话特性。执行器分支只有失败关闭的桩 | L | S1-b、S2-a | 动作 CHECK +1 | **登记 ③ 与 ②**；① 与 ③ 的保存读取点 | 保证类 | 否 |
| S3-a2 | core：执行步、结果消毒与发布、模拟、重试资格、端到端守卫 | L | S3-a1 | 无 | ①、③ 的触发读取点 | 保证类 | 否 |
| S3-b1 | 前端：动作配置面板、编写模块（与服务端文案逐字节对拍）、标签与规则摘要，及它们的 web spec | L | S3-a1 冻结的 DTO 与文案 | 无 | 会话特性 | 非保证类 | **是** |
| S3-b2 | 前端 + core 测试：日志 / 执行详情 / 支持包对新步骤的 values-free 呈现、服务端对拍测试、spec 登记 | S | S3-a2 | 无 | — | 保证类（日志隔离） | 否 |
| S4-a | core + 插件：`transform_records`——通用方言（引擎的单函数注入与纯度钉子），加 v5 的宜搭 v3 方言（只注入 `compileYidaLocalDraft`，§6.3）与 `source.withRow`；引擎文件不改 | M | S2-a、S3-a1（迁移链与它唯一可能的源步骤都来自 S3-a1）；端到端对照还要 S3-a2 | 动作 CHECK +1 | ③ | 保证类（隔离部分） | 否 |
| ~~S4-b~~ | **v5 移除**：宜搭 v3 的引擎表达、两个扩展函数、影子比对与对拍门随 OQ6 的退路挪到 §11（拉入条件照 R-87）；它在形态 B 里的位置由落点 S4-e 取代 | — | — | — | — | — | — |
| S4-c | 前端：映射编辑面板、编写模块、web spec | M | S4-a 冻结的 DTO | 无 | 会话特性 | 非保证类 | **是** |
| S4-d | core + 前端：手动预览路由与面板；v5 加点选的那一行（`rowInput`、`recordId`、`row_unavailable`、「不能启用」，§6.4，G19） | 路由 L、面板 M | S3-a2、S4-a | 无 | ①、③ | 保证类（面板装的是真实读到的值，G16、G19） | 否 |
| S4-e | core + 前端（v5，形态 B 唯一的落点）：存草稿路由 `steps-draft`——服务端重跑整条链，经既有的宜搭 owner 草稿入口把结果存成 1 号槽（物料表测试副本）的草稿，不带 `targetRef` / `sourceBinding`、不收客户端的行；面板上的「存为测试副本草稿」（§6.5） | M | S4-d、S4-a；宜搭剩余系列（R-93）合并之后的 main（§6.5） | 无 | **登记 ④**；④ 的两个读取点 | 保证类（G18，并重跑 G10） | 否 |
| S2-b | **后置（§11）**：快照表、挂起时落快照、续跑核对与恢复、清扫 | — | — | — | — | — | — |

- **顺序（v5）**：（S1-a ∥ S2-a）→ S1-b → S3-a1 → S3-a2 →（S3-b2 ∥ S4-a）→ S4-d → S4-e。S3-b1 只依赖 S3-a1 冻结的 DTO 与文案，可以与 S3-a2 并行；S4-c 在 S4-a 之后，可以与 S4-d 并行。
  - **S2-a 与 S1-b 之间没有依赖**：S2-a 的依赖列一直是「—」，它只碰 core 的纯模块。v4 的顺序行把它排在 S1-b 之后，那是一条假依赖。真正同时需要两者的是 S3-a1。
  - S1-c 先等 S0-b 归属的裁定，再先于梯子的 L2。
- **开工状态（v5，owner 2026-11-19「按建议执行」，计划评审决定 #7）**：
  - **现在可以开工、只在本地**：S1-a、S2-a。各带一份冻结的验收契约（输入、输出、错误码、必须存在的测试、范围之外），在证据目录 `s-line-20261119/adr/acceptance-S1-a.md` 与 `acceptance-S2-a.md` 里，values-free、不入库。它们由本 ADR 的 §3.1、§5.1–§5.3、§5.6、§10.2 推出，与本节不一致时以本 ADR 为准。推送、开 PR 与合并仍逐项另批。
  - **等 S0-b 归属的裁定**（Codex 线，§11.1）：S1-c。
  - **等本 ADR 合并**（R-94 ①）：S1-b 及之后的全部切片。R-94 ② 原有的「宜搭剩余系列合并完」对它们是否仍是条件，以 owner 对 R-94 ② 的收窄为准——决定 #7 只点名了 S1-a、S2-a。S4-e 另外一定要等宜搭剩余系列合并（§6.5）。
- **每周的可演示增量**：S3-a2 加 S3-b1 / S3-b2 之后——一条定时规则每隔 N 分钟读一次合成的登记系统，执行详情里看到读了多少行（一步至多 99 行，§4.6）、多少列；S4-d 之后——在预览面板里点选合成项目表的一行，看到读出来的物料字段与规划器编出的宜搭草稿行；S4-e 之后——在合成部署上把它存成一份 1 号槽草稿，并在既有的宜搭 owner 面板里预览它。三者都只对合成系统，不需要任何 O 层批准。S1-a 到 S3-a1 是休眠合并，属「可合并」而不是「可演示」。
- **迁移前缀**：两支迁移（都是动作 CHECK；本线不新增表）各用互不相同、且晚于 `zzzz20261111181500` 的时间戳前缀；并行切片各自预先分配，避免两支迁移撞前缀后其中一支要改名。动作 CHECK 的类型表按 `zzzz20261106111300…:10-17` 的方式链式导入上一支。**次序是硬约束**：迁移器允许乱序历史（`packages/core-backend/src/db/migrate.ts:32`），而每一支 CHECK 迁移都是先删约束、再按自己链上的列表重建（`zzzz20261106111300…:24-31`）。所以 S4-a 的前缀必须排在 S3-a1 之后，并且 S3-a1 先合并；反过来的话，后应用的那一支会把另一支加的类型悄悄从约束里去掉。

### 10.2 各切片的验收

**车道。** U = `plugin-tests.yml` 的 `unit` 作业里的 core-backend 测试（`.github/workflows/plugin-tests.yml:797,1110-1112`），每个 PR 都跑；DB = 同一工作流的 `runtime-db` 作业，EXPECT_DB 真库与浏览器真库用例在那里（`:1455,1823`）；C = 同一工作流 `contracts` 作业里的开关清单合同（`:163-164`）；P = `integration-guard.yml` 的插件 CJS 链（`.github/workflows/integration-guard.yml:677-680`）——它**只在改动落进受守卫路径清单时运行**，`plugins/plugin-integration-core/**` 整个在清单里（`:332`），core 的文件要逐个点名；W = web 必跑 spec（`apps/web/scripts/run-required-web-tests.sh`）。由此两条规定：主体是 core 代码的守卫（含跨边界的静态扫描）放 U，不放 P；被 P 里的测试读到的 core 新文件，同时加进工作流的路径清单与 `scripts/ops/integration-guard-guarded-paths.mjs`。

**S1-b 与 S2-a 合并时没有生产调用方**，它们的守卫经测试夹具验证：S1-b 用假适配器与本机夹具服务直接驱动服务与端口——I 链的 1b-i 就是这样合的，只重构、无新调用方（`adr-automation-pipeline-bridge-20261103.md:339-340`）；S2-a 是纯模块的单元测试。夹具证明不了的是「值流过一次真实执行」，所以下表里凡是需要它的对照都落在 S3-a2 或更后，并在那里**重新见证一次红**。

**守卫 × 切片。** 每一行写明这个切片为这条守卫交付什么、跑在哪条车道上；一条守卫的正对照、负对照与见证红的变异都必须在表里找得到归属。

| 守卫 | 切片 | 这个切片交付的对照 | 车道 |
|---|---|---|---|
| G1 | S3-a1 | 正、负、变异（闭合键集；`draft` / `retired` 引用） | U |
| G2 | S1-b | 插件服务一侧的负对照与变异（服务模块里没有 `.upsert(`、`testConnection(`） | P |
| G2 | S3-a2 | core 动作模块的扫描：正（找到唯一的出站点）、负、变异（在动作里加一处直接 `fetch`） | U |
| G2 | S4-d | 预览路由成为第二个端口调用方：扫描重钉，变异重做 | U |
| G3 | S1-b | 端口键集恰为两个方法、写门词表恰为两项。传输部分——正、负（零出站加 `write_gate_refused`）、两条变异——（v5：随 HTTP 种类准入，§11） | P |
| G3 | S3-a1 | 保存部分：引用写目标配置即 400，与开关无关 | U |
| G4 | （v5：随 HTTP 种类准入，§11） | 正、负、两条变异 | P |
| G5 | S1-b | 路径守卫在保存与执行两处的拒绝（种类无关） | P |
| G5 | （v5：随 HTTP 种类准入，§11） | 正、负（四个键各一条；K3 的档案条目与清单内容；K3 与桥的清单外请求；包装的两个闭合原因）、六条变异（含去掉 K3 档案拒绝，两层各见一次红） | P |
| G6 | S1-c | 正、负、三条变异 | P |
| G7 | S1-b | 开关 ①：插件读取点的正、负、变异；登记与「无未登记读取」 | P、C |
| G7 | S3-a1 | 开关 ③ 与 ②：登记、精确列表、③ 的保存读取点；开关 ① 的保存读取点 | U、C |
| G7 | S3-a2 | 开关 ①、③ 的触发读取点：关着时端口调用 0 次 | U |
| G8 | S3-a1 | 保存 / 启用 / 重试一侧：正、负、变异（操作者、`binding`、无租户、SQL 属主） | U、DB |
| G8 | S3-a2 | 触发一侧：撤权后的下一次触发被拒；去掉实时复核必红 | DB |
| G9 | S2-a | 容器层：前序、未知键、未声明列、别的运行的句柄、原型链名字；解析器的逐例表 | U |
| G9 | S1-b | 列名准入（`describeRead`）：正、负、变异 | P |
| G9 | S3-a1 | 保存时引用图；既有动作里的两种 `steps.` 写法被拒 | U |
| G9 | S3-a2 | 端到端的 `call_connection → call_connection`：正、负，容器前序检查的变异重新见红 | U |
| G9 | S4-a | 端到端的 `call_connection → transform_records`；`concat.fields`；空原型行的变异 | U |
| G10 | S2-a | 只有内存那一半：两次执行的容器互不可见、`dispose` | U |
| G10 | S3-a2 | **持久面哨兵**：成功、失败、超时三条路径，各持久面 0 命中、通道内大于 0；两条变异（桥错误码里的哨兵随桥种类准入） | DB |
| G10 | S4-a、S4-d | 各自新增的落库面（转换步骤的结果、预览摘要行）重跑哨兵；S4-d 另含点选那一行的值 | DB |
| G10 | S4-e | 草稿库作为唯一允许落值的面：经它自己的读取器解密后大于 0，密文列、存草稿摘要行与其它持久面 0 命中（§7.10 的 v5 修订） | DB |
| G11 | 后置 | 不随本线交付（§5.4） | — |
| G12 | S1-b | 插件一侧：SQL 只读源的 99 / 100 与它的信号 2（满页即 `done: false`、带游标 → `source_incomplete`）；`rowCap` 只收那一个值；`CONFIGURED_READ_AUTOMATION_ROW_CAP` 的变异与信号 2 的变异。K3 的 9 / 10、桥的 19 / 20 与它们的信号 3、4（v5：随 HTTP 种类准入，§11） | P |
| G12 | S2-a | 容器层的行数与字节上限 | U |
| G12 | S3-a2 | 端到端：触顶与不完整的读不发布；§5.6 的 core 常量变异 | U |
| G12 | S4-a | 转换输出过同一组上限 | U |
| G13 | S4-a | 宜搭方言（只调规划器）：正、负、§6.3 的四条变异（v5；原对拍随 OQ6 的退路挪到 §11） | U、P |
| G14 | S3-a1 | 保存一侧的全部放置对照与变异 | U |
| G14 | S3-a2 | 模拟时端口调用 0 次；真发测试不支持；非 `ok` 之后发送类动作不执行，及其变异 | U |
| G14 | S4-a | `transform_records` 重跑同一组放置对照 | U |
| G15 | S1-b | 正、负（含同一条登记上的第二次读）、两条变异 | P |
| G15 | S4-d | 预览路由下的一次性：两次预览各要一条登记 | DB |
| G15 | S4-e | 存草稿路由下的一次性：重跑的那一次读另要一条登记，不能沿用预览那一条 | DB |
| G16 | S4-d | 面板 spec：正、负、变异；浏览器真库用例一条 | W、DB |
| G17 | （v5：随 K3 种类准入，§11） | 正、负、变异 | P |
| G18 | S4-e | 正、负、五条变异（§7.10） | U、DB |
| G19 | S4-d | 正、负、三条变异（§7.10） | U、DB |

各切片在上表之外的验收：

- **S1-a**：既有路由测试全绿；失败路径的响应体快照（未批准、种类不符、请求体多键、输入非法、无权限）逐字节相等；「用 `req` 构造的上下文 = 处理器此前从 `req` 读到的字段」的等价测试；不传 `options` 时请求与响应与快照相同（先例 `governed-entry-abort-checkpoints.test.cjs`）；不传 `options` 也不传 `workspaceId` 时，计划的行上限是 10、发给源的 `limit` 是 10、返回值上没有新增的可枚举成员——把 `rowCap` 与内部通道的缺省行为钉在 HTTP 这一侧；信号已中止时不加载系统、不建适配器（探针计数为 0）；s6a 的 pin 重算；`test-chain.txt` 登记。
- **S1-b**：入口的 `options` 闭合键集从 S1-a 的两个扩到四个，`transport` 不在其中、给了即拒（v5，它随 HTTP 种类准入）；`readPurpose` 只接受用途闭集里的常量；`rowCap` 只接受入口自己的那个常量；端口登记与解绑（非 owner 解绑是空操作，旧 owner 解不掉后继者的登记）；同一系统两次并发调用恰一次执行、一次 `skipped(busy)`，且槽位在迟到的落定时才释放（用一个晚于超时才落定的假适配器见证）；表外种类被拒（v5：`http`、K3、桥三种各一条 `kind_not_admitted`）；**每个读模式一条**——两个准入模式各一条正对照，`detail_with_lines` 与 `resolver_lookup` 各一条 `mode_not_admitted`，SQL 只读源上取行面被盖成 `adapter_records`；**带 workspace 的配置**——带着保存时的提示查得到，不带提示查不到（`operation_not_found`），盖章值等于那一行自己的值，系统一侧从非空提示回退到租户级行；失败夹具的响应体里放哨兵，哨兵不出服务。
- **S1-c**：G6。
- **S2-a**：引用语法的逐例表；解析器拒绝原型链上的名字；两次执行的容器互不可见；失败与抛错路径上都 `dispose`。它不碰保存门、不读开关，所以没有 G7 的份。
- **S3-a1**：真库用例（DB）：动作 CHECK 迁移的 up / down；两次并发保存不会留下没盖章的绑定（I 链 F1 的同一类用例）；无权限管理员的重试在任何调用之前被拒；带 workspace 的配置存下之后，规则里的 `operation.workspaceId` 等于那一行自己的值。执行器的桩：这个切片里执行器不取端口，一律按端口缺席处理（`not_started(port_inactive)`），所以即使开关被提前打开，也一次端口调用都没有。
- **S3-a2**：真库用例（DB）：授权事务在端口调用之前已提交（端口调用期间对该用户 `user_roles` 的 UPDATE 不被阻塞）；撤权后的下一次触发被拒；配置版本退役后记 `operation_not_approved`；重新 `describeRead` 发现列集变化时记 `operation_changed`；按盖章的 workspace 找不到配置行时记 `operation_not_found`。
- **S3-b1**：开关关时面板不渲染；开关关时打开一条已带该动作的规则仍完整显示、不被静默丢掉；选择器对集成列表的 403 显示为「看不到」而不是报错；选择器把列出配置时用的 workspace 提示带进 `operation`；编写模块的文案与服务端逐字节一致。
- **S3-b2**：日志里的一句话不含任何值；支持包剥掉绑定与 workspace 标识，对新步骤只给 values-free 的那一句——它今天对 `run_integration_job` 就是这么做的（`automation-log-support-packet.ts:73-77`）；服务端对拍测试；spec 登记。
- **S4-a**：八个转换各自经步骤走一遍的逐例表；全有或全无；错误 `details` 里的哨兵不出步骤；引擎纯度钉子；引擎文件逐字节不变（v5）；宜搭方言的 G13；`withRow` 的并列与重名拒绝；管道与外部写试算的既有测试不变。
- ~~S4-b~~（v5 移除）。它原有的一条验收——发送路径的调用点与测试不变，`compileYidaSendDraft` 的调用方集合由静态测试钉住——转给 S4-a 与 S4-e 共同承担：两者都不得新增 `compileYidaSendDraft` 的调用方（S4-e 只经草稿入口间接用到它）。
- **S4-c**：映射表的增删改；`sourceField` 只能从源步骤的声明列里选；保存阻断原因与服务端一致。
- **S4-d**：两条连接加屏障的准入用例（检查点之间撤权，下一个检查点即停，照合成片的 C04）；响应带 `no-store`；摘要行不含值、不可重试、不计入规则监控；断开 / 取消 / 停机走同一套排空；G19。
- **S4-e**（v5）：G18；真库用例在合成部署上走完「点一行 → 读合成 PLM → 存草稿 → 既有 owner 预览看到它」；同内容第二次存草稿得到 `reused: true`、草稿操作数不变；存草稿前后宜搭投递台账、批准与授权行计数不变、表单传输的假 `fetch` 调用 0 次；宜搭发送开关关、落点开关开时零草稿；多目标开关为 `'true'` 时拒写（直到读码证明缺省目标是 1 号槽）；开关 ④ 的登记与读取点测试。

### 10.3 CI 陷阱清单

桥 ADR §11 列过的那几条在这里全部适用（`adr-automation-pipeline-bridge-20261103.md:345`）：插件新测试要登记 `test-chain.txt`；S1-a / S1-b 必动 `http-routes.cjs` 与 `index.cjs`，s6a 的两个来源 pin 要重算（`s6a-package-provenance-pins.json:72-73`）；真库用例的三处镜像；开关清单的扫描与显式测试（§7.8）；`core-backend/src/index.ts` 新增 `this.X` 要跑完整的 core-backend 单元套件；web spec 的登记文件；动到 `scripts/ops/__tests__` 时同步 `EXPECTED_OPS_TESTS_COUNT`（`.github/workflows/plugin-tests.yml:1145`）。本线另加两条：规划器的导入钉子测试必须保持绿——它是「规划器不依赖引擎」的唯一机器证明；v5 的 S4-a 从插件目录注入 `compileYidaLocalDraft`，被 core 跨边界读到的这个模块（及它的导入）要进插件链的受守卫路径清单（§10.2 的两份清单）。（v4 这里还有一条 `yida-transform-spec.mjs` 进前端闭包清单的要求，随 OQ6 的退路挪到 §11。）S4-e 另加一条：它碰 `core-backend/src/routes/` 与宜搭 owner 端口的接线，宜搭栈（R-93）的各支在这些文件上有未合并的改动（§6.5），开工前在届时的 main 上重核。再加三条：每加一个动作类型，都要改既有的逐动作迁移漂移测试——I 链的动作切片就改了五个旧的 `*-automation-action-migration.test.ts`（#6789 的 numstat），S3-a1 与 S4-a 各要再来一遍；插件链只在受守卫路径变动时运行（§10.2），被它读到的 core 新文件要进两份清单；两支 CHECK 迁移的前缀次序与合并次序是硬约束（§10.1）。

### 10.4 哪些切片可以交给第三个实现方（Grok）

这件事已由 R-95 裁定（`decision-register.md:100`），规则在接入说明里（`ai-collaboration-grok-onboarding-20261116.md`）。本节只把那两处的规定落到本线的切片上，不另立口径；与它们冲突时以它们为准。

- **它是怎样工作的**（接入说明的规定，不是本 ADR 的假设）：只接书面任务卡；在自己的克隆或工作树里干活、分支前缀 `grok/`、只开 Draft PR；PR 走同样的 CI，由 Codex 或 Claude 审，合并逐项批（`ai-collaboration-grok-onboarding-20261116.md:7-15,26-35,65`；R-95 ②）。原稿把它写成「看不到仓库的历史与约定、不参与评审」，那与接入说明不符：它看得到仓库，开工前要读章程、R-93 至 R-95 与任务卡所引的 ADR（`:19-22`）。它接触不到的是凭据、`.env`、现场与真实客户数据（`:42`）。
- **可以交**：S3-b1（动作配置面板、编写模块、标签与规则摘要，及它们的 web spec）、S4-c（映射编辑面板、编写模块及其 spec）。（v4 还列了 S4-b 的对拍语料与生成器；v5 里 S4-b 已移除，这一项随之没有。）共同点：前端配置界面，边界能写进一张任务卡，写错了的后果是界面不对或测试变红，而不是一道门开了。
- **不交**：S1-a、S1-b、S1-c、S2-a、S3-a1、S3-a2、S3-b2、S4-a、S4-d 整片、S4-e 整片（v5：它写宜搭草稿库，碰宜搭 owner 端口与 `lib/yida-*` 的接线，是保证类）。理由逐条对得上接入说明的「不接」与禁区（`ai-collaboration-grok-onboarding-20261116.md:12-14,49-60`）：授权链、端口、凭据、出站写闸、B2a、台账、迁移判定都在「不接」之列；`plugins/plugin-integration-core/lib/yida-*`、`.github/workflows/**`、开关清单与来源 pin 在禁区里——所以宜搭方言的注入与 S4-e 的接线（都碰 `lib/yida-*`）、每个切片的车道接线与开关登记都留在我们手里。另有三样接入说明没有点名、本线自己判为不交：**日志隔离**（S3-b2：日志、执行详情、支持包对新步骤的呈现与服务端对拍测试——值不进日志是这条线的中心保证，G10）、**装真实值的界面**（S4-d 的面板，G16）、**spec 与测试链的登记文件**（已知的冲突点，自己做更便宜）。
- **任务卡**用接入说明的模板（`ai-collaboration-grok-onboarding-20261116.md:83-95`），另外必须包含：冻结的 DTO 与类型；服务端校验文案的逐字节清单（前端编写模块要与之对拍）；合成样例数据；允许修改的文件清单；验收用的 spec 名单与需要亲眼见红的断言。**不包含**：任何客户值、现场事实、凭据位置。开关一栏写「不允许新增」。
- **我们保留的**：评审；对它交回的每一条测试再见证一次红；合并前的保真核对。它交回的测试在我们手里见过红之前只算语料，不算守卫。

## 11. 不在本 ADR 范围内（每项附拉入条件）

- **S5 代码步骤（QuickJS 沙箱）**。拉入条件：出现一个有客户出处、用闭合转换集与扩展函数表达不了的转换，且 owner 裁定要做。到那时它唯一的出站能力必须是本线的 `ConnectionCallPort`，不另开网络。
- **S6 宜搭通用化（任意表 ↔ 宜搭的可配置映射）**。owner 2026-11-07 已裁定后置（R-87，`decision-register.md:92`）。拉入条件照该行：备料宜搭链路在 222 首发成功并稳定；或该客户提出第二个宜搭场景；或 owner 决定作为对外功能。在此之前本线不往通用部件里加备料专属假设，也不把转换步骤的宜搭产物接进发送路径。
- **S7 交付包（规则链与配置的导出 / 导入）**。拉入条件：第二个部署或第二个客户要复用同一条链。
- **可视化画布**。冻结基线明确不做（`ipaas-yida-dev-baseline-v2.3-20261106.md:738,973`）。拉入条件：有客户提出，且表单式编辑器在真实规则上已经不够用（出现分支内步骤或十步以上的链）。
- **S2-b 步骤输出的快照与续跑恢复**（原稿在本线内，现后置）。拉入条件：一条有客户出处的规则需要在读之后等回调或审批、再用读到的值。届时按 §5.4 的契约做，并解除「不与会挂起的动作同规则」。
- **真实外部写的发送切片**（§4.3 的契约）。拉入条件：一个有客户出处的、既不是宜搭也不是 K3 的写目标，加 owner 的 O ② 批准。
- **记录事件 / 入站 webhook 触发的连接调用**。拉入条件：OQ4 的裁定。
- **翻页、逐行循环、分支内的步骤**。拉入条件：一个真实的读超过单页行上限（一步至多 99 行，K3 的列表读至多 9 行，缺省配置的桥 19 行，§4.6），或一个真实场景需要「对上一步的每一行再读一次」。翻页要先解决文末附注第 5 条。
- **既有动作引用步骤输出**（把读到的值写回记录、放进通知）。拉入条件：L3 之后客户要把链的结果落到表里或通知里。记录写是 A 类、通知是 B 类，各自要过自己的台账与白名单评审。
- **读源组合（两跳）作为具名操作**。拉入条件：一个需要「先解析、再读」的真实读。
- **`resolver_lookup` 作为一行一列的输出、`detail_with_lines` 作为一步两个输出**。拉入条件：一个真实的读，它的源对同一个键返回多行、需要配置里的多候选裁决规则；或需要把表头与明细一起往下传。
- **链路失败的告警事件**。拉入条件：L3 之后客户要失败通知；在那之前失败体现在执行状态上。
- **多实例下的在途上限**（改用库里的租约）。拉入条件：部署不再是单 fork；届时同时要求打开调度主选举。
- **把「不跟随重定向」收敛成适配器的默认行为**。拉入条件：OQ5，加现场对「有无依赖跳转的源」的计数。
- **K3 读路径的正向目录**。拉入条件：OQ10 的裁定。
- **已武装部署上可重复的自动化读授权**（「一条登记一次读」之外的形态）。拉入条件：OQ8 的裁定。
- **core `data_sources` HTTP 适配器写路径的审计**、接活或删除既有死表、用户自定义连接器种类、连接器市场、OAuth2：另案或不做，本线不碰。
- **v5：`http`、`erp:k3-wise-webapi`、`bridge:legacy-sql-readonly` 三个种类**（形态 B 首片只收 `data-source:sql-readonly`，§3.2）。拉入条件：一个用到该种类、有客户出处的点名场景，加 owner 对形态的裁定。随种类一起交付的，是本 ADR 已锁定的契约：
  - §3.2 的传输包装、对象条目拒绝与写门拒绝的识别，入口的 `transport: 'strict'`；
  - §7.3–§7.7 的结论；
  - G3 的传输一半、G4、G5、G17，以及 K3 与桥的 G12 各对。

  K3 另有两条：客户侧只读账号这个硬前置，以及 OQ10。`plm:yuantus-wrapper` 先要一条传输评审（附注 4）。
- **v5：宜搭 v3 的引擎表达**——原 S4-b 的全部内容，全文见 `aadb188f3` 的 §6.3。它包括：
  - `yida-transform-spec.mjs`、`yida_concat` / `yida_generated` 两个扩展函数；
  - `transformRecord` 的可选扩展表参数及其「泄漏进管道」变异；
  - 影子比对、对拍语料与生成器、原 G13、原因码 `parity_violation`。

  拉入条件照 R-87（`decision-register.md:92` @e0e4406bf），任一即可：备料宜搭链路在 222 首发成功并稳定；该客户提出第二个宜搭场景；owner 决定作为对外功能。在那之前，宜搭方言只调规划器（§6.3）。
- **v5：第二个落点**——正式表单（2–6 号槽）、其它测试副本、把读到的值写进多维表记录、发通知。S4-e 只落 1 号槽测试副本（§6.5）。拉入条件：一个有客户出处的场景，加 owner 对形态的裁定。每个新落点各是一个保证类切片、各有一个默认关并登记的新开关；写表属 O ②，发通知属 O ④，发外部系统属 O ③。
- **v5：带绑定的草稿与物料编码（`generated`）进落点**。S4-e 的草稿无绑定，所以不能带 `generated`（§6.5）。拉入条件：宜搭栈的表源绑定路径（D17）可用，加 owner 裁定，让落点产出带绑定的草稿。
- **v5：点选行规则的定时运行**（带 `rowInput` 的规则今天不能启用，§6.4）。拉入条件：OQ4 那一类的裁定——由什么事件、按什么速率驱动「对某一行读一次」。

## 12. 待 owner 裁定（2026-11-19 已答）

**owner 的答复**：2026-11-19，集成会话，原话「按建议执行」。它回的是一条含四个待填项的加速消息，其中一项是「S 线选 B，场景是 ___；11 项按合并建议」。这条消息之后的执行记录在证据目录的 `RESUME-20261115.md` 最后一节。对本节的意思按如下记：

- **每一个 OQ 都取本 ADR 写的建议值**，各条的答复记在条末。
- **两处例外**：OQ6 取本 ADR 自带的退路，不取原建议，依据是计划评审决定 #7「OQ6 取 ADR 自带的退路」；OQ1 的范围一半，按决定 #7 的要求逐句回答冻结基线 v2.3 的 `:739` 与 `:749`。
- **OQ5（a）带上了条件**：决定 #7 要 S1-c 先和 S0-b 定下唯一的实现归属，所以「由本线以 S1-c 交付」现在以那个归属裁定为前提（§11.1）。
- **已由登记册裁定的两条**（OQ1 的线别一半、OQ7）不重复记录。
- **不在这句答复之内的**，仍按各自的出处处理，本节不当作已答：计划评审决定 #10 说的「OQ3、OQ4、OQ5、OQ7 留着」是**桥 ADR**（I 链）的待裁项，不是本 ADR 的同号问题；同一条消息之外的事项，如 §11 的权限例外、D21 的 `lock_timeout`、正式目标的代码守卫，另由 owner 裁。

1. **OQ1 线别与范围**。**线别这一半已由 R-94 ③ 裁定，不再待裁**（`decision-register.md:99`）：章程「最多两条线」不变，本线开工后与备料接管并列为两条线之一，其它平台工作同时进行须 owner 另裁。原稿建议的「记为既有线下的交付项、不新增第三条线」与裁定不同，以裁定为准。**仍待确认的只有范围这一半**：冻结基线那句「不做任意节点调任意 API」是否仍然成立——R-94 那一行没有直接说。**建议**：成立，并且本 ADR 就是按它写的：步骤只能调用已批准的具名操作，不是任意 API（R-94 对 S3 的表述也是「只调具名操作」）。**owner 答复（2026-11-19）：按建议——成立。** 冻结基线 v2.3 那三句逐句对上（`ipaas-yida-dev-baseline-v2.3-20261106.md` @e0e4406bf；该文件在 `35dc8b272` 与 `e0e4406bf` 之间没有改动）：
   - `:738`「不做通用画布、任意节点调任意 API、任意代码节点」仍然成立。步骤只能调已批准的具名操作；形态 B 首片只准入一个种类、一个读源配置版本（§3.2）；代码步骤与画布都在 §11。
   - `:739`「每一层都由客户的真实需求拉动，每个对外调用都走同一套守门规则」。前一半：本线由一个点名场景拉动——指定备料项目的一行 → 已批准的 PLM 物料读取 → 物料表测试副本的草稿预览（白话终点）；不服务这个场景的种类与方言一律挪到 §11，拉入条件都是「出现有客户出处的场景」。后一半：唯一的出网是端口 → 插件受治理入口 → 适配器（§0 ④，G2）；唯一的写走既有的宜搭 owner 草稿入口，不另开写路径（§6.5）。
   - `:749` 第 ⑤ 层「编排：本期只做备料最小闭环（§10.3）；备料；第二个真实场景出现时再扩」。形态 B 的这一条场景就是本期的「备料最小闭环」：输入是备料项目表的一行，读的是备料要用的 PLM 物料，落点是备料宜搭链路的 1 号槽测试副本。第二个场景——另一个种类、另一个落点或正式表单——就是 `:749` 说的「再扩」，按 §11 的拉入条件另立。
2. **OQ2 本线不含真实外部写**（Q4）。**建议**：确认。写开关只登记；发送切片等出现有客户出处的写目标时再以本 ADR 的增补立项，届时每个写操作逐项 O ②。**owner 答复（2026-11-19）：按建议——确认。** 形态 B 的落点 S4-e 不是外部写：它往本地草稿库存草稿，不发宜搭（§6.5）。所以 OQ2 的结论不受它影响；它自己的那一写另属 O ②。
3. **OQ3 这类规则能建在哪些表上**。规则表没有租户列；I 链判断「这张表属于哪个租户」靠的是备料项目登记表（`automation-run-integration-job-rule-sheet.ts:16-21,32-40`）。**建议**：首片沿用同一个守卫——只有绑定租户名下、处于活跃状态的备料项目登记表上能建带 `call_connection` 的规则；等有了通用的「表 → 租户」权威来源再放开到其它表。代价有两个：这条线在首期只服务备料项目表，这与章程的优先级一致；这个守卫只在 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 恰为 `'true'` 时才认登记表，关着就一律拒绝，所以取这个建议等于给本线多一个前置开关（§7.8、§8）。**owner 答复（2026-11-19）：按建议。** 它正好给出场景里「指定备料项目」的那一半：点选的那一行只能来自规则所在的、已登记且在役的备料项目表（§6.4）。
4. **OQ4 记录事件与入站 webhook 触发**。**建议**：本线不放开。若以后放开：只限读操作；规则要显式声明「允许由记录事件驱动外部读」；业务键取自哪一列在保存时声明；每条规则有速率上限。**owner 答复（2026-11-19）：按建议——不放开。** 场景里的那一行**不是**记录事件触发：它是规则的所有者在预览面板里亲手点选的，只在预览与存草稿两条路由上可用，带它的规则不能启用定时（§6.4）。编辑记录驱动不了任何读。
5. **OQ5 三项传输 / 凭据加固由谁交、交到哪一层**。（a）换 origin 或认证身份必须重给认证材料（§7.5）：若 S0-b 在 S3-a1 就绪时仍未进 main，是否由本线以 S1-c 交付？**建议**：是。（b）不跟随重定向：本线只对自动化调用方生效；是否改成适配器对所有调用方的默认行为？**建议**：先在现场数清有无依赖跳转的源，再定。（c）是否在自动化路径上额外拒绝回环 / 链路本地地址？**建议**：不加——那是登记权限的职责，加了会让工作台与规则两套口径。**owner 答复（2026-11-19）：按建议**，（a）带一个条件。（a）由本线以 S1-c 交付，前提是先和 S0-b 定下唯一的实现归属，两边不同时做（计划评审决定 #7、#8；§11.1）。在那个裁定之前 S1-c 不开工。（b）先在现场计数再定；形态 B 首片不收 HTTP 种类，所以本线在 HTTP 种类准入之前不改变任何重定向行为。（c）不加。
6. **OQ6 宜搭 v3 在转换步骤上的做法**。本 ADR 取「编译到引擎 + 影子对拍，规划器为权威」。备选是「步骤内只调规划器，不做引擎表达」（零漂移，但转换步骤里就有一个宜搭专属的旁路）。**建议**：取前者，并保留 §6.3 的退路条款。**owner 答复（2026-11-19）：取退路——步骤内只调规划器。** 依据是计划评审决定 #7 的原文「OQ6 取 ADR 自带的退路」，这是本节唯一一处没有取原建议的地方。随之：
   - 宜搭方言在步骤里只调规划器（§6.3）。
   - 引擎表达（`yida-transform-spec.mjs`）、两个扩展函数（`yida_concat`、`yida_generated`）、影子比对与对拍门（原 G13；v5 里 G13 这个编号改指宜搭方言自己的守卫，§7.10）整体挪到 §11，拉入条件照 R-87（`decision-register.md:92` @e0e4406bf）。
   - 引擎文件的可选扩展表参数（§6.2 末段）不再随本线交付。
   - 原因码 `parity_violation` 不再产生（§4.8）。
   - 原 S4-b 整片由落点切片 S4-e 取代（§10.1）。
7. **OQ7 外部构建者**。**已由 R-95 裁定，不再待裁**（`decision-register.md:100`；规则见 `ai-collaboration-grok-onboarding-20261116.md`）：Grok 作为第三个实现方只接书面任务卡里边界清楚的切片，PR 走同样的 CI，合并逐项批。本线照它落到切片上的结果见 §10.4。原稿建议的「每张任务卡发出前给 owner 过目一次」不在裁定里，不再提。
8. **OQ8 B2a 的两件事**。（a）HTTP 配置读路由要不要进围栏：今天它不在围栏内（§1.4）；本线只让自动化调用方出示用途。**建议**：另行裁定，不在本线——它会改变已武装部署上既有路由的行为，要先有现场事实。（b）**已武装的部署上，自动化读取什么形态**：一条登记只授权一次读（§1.4），登记表在路由注册时建一次，所以「登记一次、定时一直读」在现有机制下不存在。两个选项：(i) 已武装的部署上定时触发的读一律拒绝，只有手动预览可用、每读一次用掉一条登记，直到 owner 另裁一种可重复授权的形态；(ii) 把「一次读一条登记」定为 L3 的成文形态——预览与每一次定时读各用各的登记，补登记要重启进程。**建议**：(i)，本 ADR 的 T 层默认已经按它写（§3.2）。(ii) 在机制上成立但没有可操作性，而且容易诱导出「让 `runId` 稳定一点」的实现——那是对一次性的旁路，本 ADR 明文禁止。**owner 答复（2026-11-19）：按建议**——（a）另行裁定，不在本线；（b）取 (i)。场景的读本来就只在预览与存草稿两条路由上发生（§6.4、§6.5）。已武装的部署上，这两条路由的每一次读各用掉一条登记。
9. **OQ9 手动预览是否随本线交付**（S4-d）。**建议**：交付。没有它，这条线做完之后客户能看到的只有日志里的行数。**owner 答复（2026-11-19）：按建议——交付。** 形态 B 里它还多了一项：接收点选的那一行（§6.4）。
10. **T 层默认、24h 可否决**：三个开关的名字；两个新动作的名字；`ConnectionCallPort` 是新端口而不复用既有端口；准入的连接器种类首批四个、读模式首批两个；取行面按种类盖章；同一系统在途上限为 1；读步骤不写意图行、不自动重试；页内行上限 100（K3 沿用 10），触到即失败；不完整即失败及其四条信号；两个新动作任何非 `ok` 结果的步骤状态都是 `failed`；`http` 系统的对象条目改写请求即拒、K3 的 `material` 条目选了具名档案即拒（都不取替换，K3 也不取「等于档案就放行」）；不在规则里盖系统侧摘要；workspace 由提示、证明、盖章三步确定；cron 的 15 分钟下限与每条规则至多 8 个 `call_connection`；`stepKey` 的形状与放在配置里；引用语法只有两种选择器、只做整值绑定；§5.6 的全部上限；**首批不持久化步骤输出、S2-b 后置**；转换步骤全有或全无；宜搭方言首片只接受不拆分的分配；手动预览至多回 100 行；已武装部署上定时读默认拒绝（OQ8 裁定之前）；S3-a 拆成两个 PR；生产规则的身份沿用桥 ADR OQ7 的推荐值（租户绑定的服务账号）。**owner 答复（2026-11-19）：按建议，24h 否决窗从这一天起算**，并照形态 B 改三处：
   - 准入的连接器种类首批只有一个（`data-source:sql-readonly`）。另三种的规定留作锁定契约（§3.2）。
   - 「`http` 对象条目即拒、K3 档案条目即拒」随那两个种类一起挪到 §11。
   - 「宜搭方言首片只接受不拆分的分配」照旧。

   另加形态 B 新增的 T 层默认，同样 24h 可否决：
   - 第四个开关的名字（§7.8）；
   - 落点借用既有的宜搭 owner 草稿入口、不新增写路径（§6.5）；
   - 点选的那一行的声明方式与「带它的规则不能启用」（§6.4）；
   - 存草稿时服务端重跑整条链、不收客户端的行（§6.5）。
11. **OQ10 K3 读腿的残余**（§7.7）。K3 的读不经通用写门，只被一张适配器自己承认不闭合的写端点词表拦着。**已定的**：对 K3 种类，客户侧只读账号是进 L3 的硬前置，逐系统核对。**待裁的**：要不要在本线为 K3 建读路径的正向目录——`describeRead` 只收适配器内置的读端点，严格模式下拒绝系统配置里存量的读请求体模板——作为 K3 种类进 L3 的第二个前置。**建议**：不拉进本线。那是适配器的设计锁明文推迟的工作（`k3-wise-webapi-adapter.cjs:264-266`），而可证明的保证已经在账号层；owner 若要它成为前置，另立切片，本线的 K3 种类在它交付之前停在 L2。**owner 答复（2026-11-19）：按建议——不拉进本线。** 形态 B 首片不收 K3 种类（§3.2）。K3 种类连同这一条的残余一起挪到 §11，到那时只读账号这个硬前置照旧成立。

## 13. 考虑过的替代方案

- **嵌入 n8n（或任何外部编排引擎）**。不取。理由沿用桥 ADR 附录的三条（`adr-automation-pipeline-bridge-20261103.md:411-415`）：按它的许可，嵌进交付给客户的产品要另签商业协议；它的 HTTP 节点与 Code 节点可以直接出网、直接写，等于绕过「外部写默认关」「K3 永久禁写」「宜搭逐条批准」三道红线，在别人的代码里重建这些围栏的工作量不小于本线；它是一个带自己的数据库、账号与密钥的独立应用，客户机是 Windows 上的 pm2 单 fork。借的只是思路：凭据与流程分离、连接器是「操作清单 + 参数声明」、按步的执行历史、用固定样例试运行。
- **原始 HTTP 步骤**（规则里写 URL、动词、请求头、请求体）。不取。它让每个规则作者都能把登记系统里存着的凭据对准该系统的任何端点——包括写端点；动词不是读写的分界（§1.2 的 K3 事实），所以也没有可靠的办法只放行「读」；对内网目标又没有可用的 URL 守卫（§7.2）。`testConnection` 的 `path` / `method` 来自请求体这件事，当初就是作为一个洞被传输层的写门补上的（`http-adapter.cjs:17-26`）——原始 HTTP 步骤是把同一个洞做成功能。
- **单个通用 webhook 动作**（让 `send_webhook` 指向登记系统）。不取。它的守卫只许公网 https，根本到不了内网的登记系统（§1.5）；凭据写在规则配置的请求头里而不是凭据库里（`automation-executor.ts:5304-5306` 的注释记着这一点）；它不把响应数据交给下一步，成功时的输出只有状态码与尝试次数（`:5426-5431`）；没有具名操作，也就没有批准与退役。
- **为真实读另建一个代码资产目录**（合成目录的延伸）。不作为主路径。每加一个客户端点都要改仓库、走发版；而已批准的读源配置已经提供了版本、批准流与只收业务键的运行时。代码资产目录仍适合第一方的固定操作，合成片照旧。
- **把步骤输出放进 `step.output`，续跑时从日志读回**。不取。日志面保留业务值并流向界面、作业面与支持包（§1.1）；续跑读回的会是被擦过的值，而且没有办法区分「值本来如此」与「值被擦过」。
- **让 `IntegrationRunPort` 兼带数据**。不取（§2 ②）。
- **步骤内只调宜搭规划器**（v4 里是 S4 的备选与退路）。**v5 采用**：owner 2026-11-19 就 OQ6 取了这条退路（§6.3）。
- **把宜搭 v3 编译到引擎上、影子对拍、规划器为权威**（v4 的主方案，原 S4-b）。v5 不取，挪到 §11，拉入条件照 R-87。理由是计划评审的结论：它的结果从不发布，发送路径也不读，却是一个 L 级切片；形态 B 的点名场景用不到第二份表达。
- **BPMN 引擎**。不适用（R-75）。

## 附注：未能核实的事项

1. **（原「R-94 的行文未核」一条撤销。）** R-93 / R-94 / R-95 与 Grok 接入说明已在 main `09dda5149`，本稿按行引用（`decision-register.md:98-100`）；保留这个编号只为不动后面各条的序号。
2. **S0-b 在另一条线上的状态**。只核了 main：重定向拒绝与换源重绑在 `35dc8b272` 上都不存在（§1.2、§1.3）。那条线上的代码写到哪一步、何时进 main，没有核。
3. **n8n 的许可文本与节点行为**。引自桥 ADR 附录；R-94 ④ 写了同一结论（`decision-register.md:99`）。本 ADR 自己没有核对许可文本。
4. **`plm:yuantus-wrapper` 的传输**。它经宿主的 PLM 能力出站，是否跟随重定向没有读；所以首批准入种类里没有它（§3.2）。
5. **读源配置在通用 `http` 种类上的行为**。原稿这一条只说「覆盖没有核」。第一轮评审读了代码，并用一个假 `fetch` 的独立脚本跑了这条链，结论已写进 §3.2：`http` 系统的对象形条目会盖过已批准的路径与方法。**仍未核的**：插件的测试与夹具里 `requiredKind: 'http'` 只出现 2 处，没有读那些测试；`list_page` 的页号是经 K3 适配器的选项名传递的（`read-source-probe-runtime.cjs:172-180`），通用 `http` 适配器的翻页只认 `cursor`（`http-adapter.cjs:410-418`）——通用 `http` 上能否按页号翻页未核实；首片一步只读一页，不依赖它。那个脚本用的是假 `fetch` 与本地 Node v20，生产运行时没有核。
6. **B2a 模块**。全文两千余行；读了头注释、用途表、守卫入口、登记加载时对 `forbidReuse` 与 `sourceReadOperationLimit` 的校验、认领函数。数据范围的解析没有读；新用途的那一格怎么填留给 S1-b。
7. **core `data_sources` HTTP 适配器写方法的可达性**（哪些路由、什么权限）。没有审计。
8. **222 现场**。是否已武装 B2a、有哪些已批准的读源配置、它们落在哪些 workspace 值上、有无依赖跳转的源、K3 系统连的是不是只读账号——都没有现场计数。workspace 的语义本线不动（§4.1）。
9. **「表 → 租户」的其它权威来源**。只核了 I 链那一个守卫的实现，没有做全仓的否定性搜索（OQ3 的建议因此取保守一侧）。
10. **没有运行任何测试。** 全部结论来自读码与 grep；另用一个不加载仓库代码的独立脚本核对了两条 JavaScript 语义：模板渲染对原型链上的名字与缺失路径的结果（§5.2），以及 `new URL` 对以 `/` 开头的路径的解析（§1.2）。第一轮评审的评判脚本（只读；适配器部分用假 `fetch`，重定向部分只连本机回环）在本次修订时用本地 Node v20 重跑过一遍，结果与评审所记相同：路由形状的调用行上限是 10；`http` 的对象形条目盖过已批准路径；解析模式的数据面没有容器；跨 origin 跳转丢 `Authorization` 与 `Cookie`、转发自定义头、307 重发请求体。生产运行时没有核。
11. **切片规模**是估计，没有原型支撑；其中三行用先例切片的 numstat 校过（§10.1）。
12. **§7.5 表外的连接器种类**。`plm:yuantus-wrapper`、`erp:k3-wise-sqlserver` 等种类取 origin 的键序与配置里的认证键没有读。
13. **目标 K3 上有没有词表外的写端点**。没有核实（§7.7）。
14. **SQL 只读源的属主戳是否每一行都有**。两种绑定形态的盖戳逻辑读了（§4.5）；存量行里有没有缺戳的，没有现场计数——缺戳即拒，取的是保守一侧。
15. **各适配器在真实源上的完整性信号**。§4.6 的表来自读适配器代码；没有对任何真实源跑过，`http` 与 K3 两行的「看不到的」一列是读码推出来的下界。
