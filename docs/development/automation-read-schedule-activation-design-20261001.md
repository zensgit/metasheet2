# SA-06X：显式启用受控 cron 触发（独立边界决定）

状态：2026-10-01，按用户已批准的 Automation A 实施本地代码与合成测试；本文件先冻结合同，验证结果另写原 SA-06 报告。不授权真实客户读、业务写、外发、提交、发布、合并或部署。上位 SA-06 保持 active。

## 1. 第一增量与授权

复用现有 AutomationScheduler，仅接无条件 `schedule.cron`。不新建调度引擎、轮询服务或公共触发接口。interval 的持久 anchor、date_field 的逐记录身份及条件求值另做增量；不是已完成全部 schedule。该片先交付后端与测试，owner 的定时启用界面随后补，不把 HTTP 入口称作完整自助体验。

新增 `POST /api/integration/automation-read/schedule-activations`，仍在真实 JWT 之后，只接受当前 Connection owner ∩ live integration admin，tenant 来自可信认证上下文，workspace 固定 null。输入仅 activationKey、selector、单 projectNo、budget、expiresAt、maxExecutions；不接受 tenant、owner、旧 grantId、触发时刻、SQL、源凭据或客户端证明。回执仅 activationId/grantId。

同事务新建 purpose=automatic、仅 schedule 的 grant 和不可变 activation。完整输入与 owner/key 绑定幂等，恢复不增加预算、不复活撤销授权。旧 standalone（即使允许 schedule）不升级；普通 requests/manual 不能使用 automatic。记录与定时 automatic 由精确单触发家族区分，二者必须有各自匹配的私有 activation，不能互借。历史可查/可撤销，仍不返回源数据。

## 2. 发生身份与校验

调度器把它已经计算出的 UTC 计划分钟原样传给宿主私有 producer；不是到达时刻，也不从请求体或事件业务值取。旧 callback 被替换、注销或销毁后，不得消费或重新挂接新 timer。leader 锁只负责协调唤醒，不作为授权或持久去重证明。

规则配置必须闭合：expression 或 cron 二选一，另可带合法 IANA timezone；无效时区拒绝，不沿普通调度器的 UTC 回退。条件必须 null，规则类型必须精确 cron。activation 固定规则 revision 和原配置，当前启用状态、创建者、完整 authority/来源/目标/权限在实际事务中重新验证，回调持有的旧 rule 快照不能作证明。

启用 cutover 取实际 DB clock。发生时刻必须是该配置的真实 cron 分钟、严格晚于 cutover、且不晚于当前 DB clock。invocation 身份取 activation + 固定 cron 家族 + UTC 计划时刻；多进程、延迟到达、同次重投只恢复同一 request，后一次合法发生为新 request。继续复用 grant/request/audit/outbox 同一事务及原唯一键，不增加第二份 occurrence 队列。

候选扫描只是有界元数据发现；无授权不读源，失效授权不影响普通规则。暂时 DB/runtime 失败不能假称已入队。**现有 cron 不补跑，也不承诺 callback 到请求入队之前的崩溃恢复**：停机错过的时间或入队失败的本次唤醒不会自行重建。成功事务入队后才沿既有 durable read worker 恢复；outcome_unknown 不自动重读。这里承诺稳定去重与安全上限，不承诺端到端恰好一次或不漏触发。

claim、每次 IO checkpoint、结果发布均重验定时 activation 与完整 authority。只读结果仍为有限状态/计数，无业务写、apply token 或发送。普通 Executor 的固定 read 拒绝不解除；已有 date_field/interval 不因这次接线获取权限。

## 3. 生命周期、迁移与验证

宿主停机同步关 metadata admission，排空真实 promise；scheduler.destroy 排空实际 callback 后才能关闭 pool。插件停止不永久关闭宿主发现入口，但有授权而 runtime 不可用时不得绕到普通执行器读取。

136000 迁移在135000之后追加 schedule activation，扩展 automatic 单家族形状及 deferred 必有关联的约束，不物理改写旧迁移，不回填旧授权。历史 identity 不可变，存在定时历史时 down 拒绝，不能删历史以完成回滚。迁移必须先于新代码，生产部署仍待单独授权。

验证覆盖真实事务 atomic/COMMIT 丢回执/并发/回滚、旧授权不升级、合法发生与 DB cutover、未来/非分钟/非该 cron 时刻、规则修改/撤销/权限变化、单次去重、前后两次及服务生命周期。时间测试须区分真实 DB clock 与 JS fake clock；为合成 fixture 安排历史切点不算证明生产时间签发。另用真实 scheduler、owner 路由、runtime 与 native preview 的生产路径测接线，并做降级变异。所有源和身份为合成材料，无客户数据。最终报告如实区分单元、真实 PG、宿主组合和 UI 证据。

## 4. SA-06X 本地实现事实与验收边界（2026-10-01）

本节追加实现进展，不改写§1–3先冻结的合同；候选仍为 CodeWT `b35d4cd1f` 加累计未提交改动，不是 main 或已部署功能。完整命令、首次失败、七个定点变异及原始字节由 CodeWT `automation-integration-read-primitives-verification-20261001.md` §27集中记录；本节不另复制 hash。

- 后端已接实际 owner `schedule-activations` 路由、runtime、ledger 和136000迁移。闭合六字段输入、两ID回执；同事务新建仅 schedule 的 automatic grant 与 immutable activation。旧 standalone 不升级，record/schedule automatic 不能互借，普通 manual submit 仍拒绝 automatic。仅无条件 `schedule.cron`，interval/date_field、其它条件没有因此获得自动读权限。
- 原 `AutomationScheduler` 向实际 `AutomationService` 回调提供 frozen UTC planned occurrence，再经宿主第八个构造参数进入私有 producer；不调用普通 read executor，不在无 runtime 时回退执行。真实候选读取仅元数据，submit/claim/checkpoint/complete 继续核对当前 activation 与完整 authority。宿主关闭并排空独立 schedule metadata admission；插件与父级取消信号合并传入实际提交，service 同步取消并等待真实 scheduler callback 排空。
- 长月/年 cron 的 timeout 现限制为 `2^31-1` 毫秒分段，避免 Node 将溢出延迟缩成1ms循环。分段或时钟回拨未到期时只续挂原计划时刻，不调用 consumer；到期前后均核对当前 handle、leader 和 destroy 状态。实际 fake-clock 测试覆盖首段零消费、最终一次、回拨不改候选、旧 handle/替换/注销/销毁；既有 DST 与普通调度回归保留。
- 幂等范围明确为 **activation + cron 家族 + UTC计划时刻**。多进程或同 occurrence 重投恢复该 activation 的同一请求；用户另外明确建立的多份 activation 各有独立预算，同一 cron 时刻可分别入队，不提供跨 activation 的全局去重。没有补跑或入队前持久恢复；事务成功入队后才复用原 durable worker，unknown 不自动重读，不能称端到端恰好一次或无漏触发。
- 前端本片仅允许严格闭合的 schedule automatic 历史 DTO 展示、查看和撤销，不提供 cron 启用表单或专用激活 transport。当前生产面板授权模式仍为 `manual | record`（`apps/web/src/components/integration/stockPreparation/StockPreparationAutomationReadPanel.vue:150`），历史展示不是自动启用许可，automatic 不可手动启动。后端 HTTP 能力不能写成完整 owner 自助定时体验。
- **136000 必须先于新代码**，承接135000但不重写旧迁移、不升级旧授权。down 遇到 schedule activation 或 schedule automatic grant 历史即拒绝，不删除历史；没有该历史时才退回原 record-only 形状和约束，旧 record 数据保留。真实生产迁移/建索引锁与部署尚未验收或授权。
- 已确认的分套结果：schedule PG **78/78**、schedule单位组合 **231/231**、scheduler回归 **333/333**、ordinary **600/600**、record PG **70/70**、ledger **138/138**、所选 FE **314/314**、CI登记 **290/290**；66 provenance pins零差异，core选定类型检查与范围lint零诊断。套件有重叠，不加总为覆盖率；其中 scheduler/service 单元显式替身不是权限证明。
- 修正后的完整 authority **77/77**；加入停机排空后诊断对账的更严格最终版再次 **77/77**（136.9s），无skip/unhandled/禁止IO。实际JWT→真实分钟scheduler/service→runtime/原队列→native PG/planner产生有限预览，业务行不变；原Chromium场景保留。七项变异逐项结果见§27；不把本轮对账通过解释为已逐条证实旧diagnostic原因，也不冒称客户或完整站点boot。临时PG已清理，未读取客户数据、外发、提交、合并或部署。后续仍需 cron owner UI、其它记录/定时类型与条件、显式新预算关联 retry；SA-06及上位目标保持 active。

## 5. SA-06Y owner 定时启用界面合同（2026-10-01）

复用上文已获准的六字段 schedule-activations 端点，不新增授权来源、迁移、触发类型或cron编辑器。面板默认仍手动，owner须另选定时模式、所选规则、固定项目和期限/次数/读取预算，勾选明确确认后才创建自动授权。文案明确批准的是启用时服务端重新核验的当前已保存cron规则及已生效配置；不是把加载列表时的快照当成固定授权证明。规则计划在既有Automation编辑器配置，修改后原授权失效；不承诺列表加载与点击之间的版本不变或替代四眼审批。

options新增必填 `scheduleActivationEligible`，在真实authority已锁规则后派生；仅allowedTriggers含schedule、类型精确schedule.cron、conditions为null且既有closed cron配置校验通过才true。record/schedule两资格互斥，false不移除仍可手动的候选。该字段只决定UI是否可选，激活/执行的当前重验不解除；interval/date_field、带条件或不合法时区不能借schedule标签启用。前后端closed DTO均要求新字段，混版拒绝，不用缺字段默认值放行。

恢复材料必须为本会话内冻结的 `{ family, input }`：family仅record或schedule，input仍为原六字段（含原key与期限），family不加入HTTP body。恢复按冻结family选择原端点，不能依据当前UI模式改投另一家族；两家族幂等命名空间不同，改投可能新建独立预算。POST回执不确定或其后的详情失败均只允许显式原参核对；无自动retry，未核对完锁其它授权/模式/输入。详情必须与family、selector、单项目、预算、期限、次数及回执grantId匹配。恢复不声称撤销/过期授权当前有效；另一份预算需独立新确认。

账号/项目/表/scope变化或卸载清除本地材料，旧响应不得写回。所有automatic仍不能manual submit，保存普通规则不代表授权；启用本身零源IO，仅后续合格真实分钟可入队，无补跑/入队前持久恢复。验收包括真实生产面板→transport→JWT→PG授权→原scheduler/runtime/worker→native合成PG/planner，不以UI替身或fake clock充当整链。客户读取、发送、合并及部署仍另批。

## 6. SA-06Y 本地候选与验证限制（2026-10-01）

§5合同已在原面板、transport、options派生与闭合DTO中实现，没有新增端点/迁移/flag/CI泳道。discovery107、routes97、前端425（transport254/panel133/authoring23/editor15）、CI登记290通过，core/web types与所选lint零、66pin零差异。三项定点组件降级探针分别产生3/6/3个行为AssertionError；完整证据与首次无效探针归CodeWT验证报告§28，不复制造一份hash或新平台方案。

全链曾78/78，随后76/78暴露旧浏览器响应观察中止和新cron callback resolve却没有queued两项；不能用旧绿覆盖新失败。补候选/typed拒绝的只读诊断后再次78/78，但原未入队原因尚未定位，不能把callback返回当准入成功。时钟差是可达机制而非已确认原因；当前独立合成PG100次采样反而比宿主领先约66–68ms，不重建原失败时刻。

浏览器在无DB本机合成环境用未修改生产client复现了页面成功/无主动取消/无额外导航，却有CDP body missing；新增仅测试helper的有界原生Response.clone观察分支，返回原Response、不重试，不豁免任何成功请求中止，仍强制原CDP body/status、DOM和零requestfailed。clone确实改变读取生命周期，不冒称无观测扰动或已经根治；最终完整文件 **78/78**（tests235479ms/total238.03s），零skip/unhandled/禁IO/环境读取，临时PG已清理。原无queued原因仍open，先收敛该风险再扩大触发面。本片当前仍为未提交本地候选，不宣告稳定性问题已闭合、客户验收、发布或完整SA-06完成。其它记录/条件、interval/date_field与显式新预算关联retry仍在原目标内。

## 7. SA-06Y 准入与执行诊断补证（2026-10-01）

未扩大合同或修改生产行为。新增三条真实runtime/authority/ledger/PG组合测试，明确证明未来分钟、candidate之后撤权、已queued但used为0的预算预留会正常拒绝准入，且保留实际入队/精确重放正对照。三条诊断采用自有合成schema内显式安排的旧activation floor，不充当真实分钟证据；两条原scheduler实时时钟用例继续保留。准入3/3、定点变异分别1/1/3个AssertionError，详细范围及边界在CodeWT验证报告§29。

加入有界、values-free SQL事务阶段观察，负标签仅为Promise `rejected`，不保证数据库已回滚；观察器单元53/53（含原runtime37）。本轮首次完整文件80/81，唯一失败发生在旧plain-cron已入队后worker结果为unknown，并非原无queued。补接实际runtime preview/execute/native路径的透传诊断后完整文件81/81（202475ms/205.05s），零skip/unhandled/禁IO/环境读取，临时PG已清理，types/lint零。两个历史事件都未复现出根因，仍保持open；不增加重试、不放宽成功要求、不用本次绿授权扩大触发面或发布。上位目标继续active。

## 8. 续租碰撞修复不改变schedule授权（2026-10-01）

实际PG安排普通producer续租持锁后，已证明旧afterIO重验会因NOWAIT而把一次成功native读收为unknown。profiles/discovery现在仅对producer SHARE读锁允许最多250ms单次锁等待，尊重更短调用方timeout，成功恢复原值，再按持锁后的新DBclock与身份重验；writer/profile/binding锁和schedule准入、cutover、幂等、预算、用途隔离均不变。不是KEY SHARE、自动重试、catch-up、新scheduler或授权范围放大，也不是物理取消SQL保证。

限定三条真实runtime链3/3，profiles PG51、相关单元28/110/53，真实降级变异4/1/1条有效行为断言捕获。完整authority/native/Chromium文件本轮82/84→81/84，未验收通过；除截止时间fixture超时和record DOM零告警失败，真实cron又出现candidate0/无queued，紧接DB采样显示计划时间仍在未来172.885ms、其余采样谓词true。该实际时间差是新线索，但不是candidate原statement快照或历史事件归因；后续收敛时钟边界，不能删除future拒绝、回拨真实场景cutover或增加未经批准的源读取重试。报告§30保留全部失败、严格告警对账和字节证据。真实客户读取、发送、发布/合并/部署仍另批，目标继续active。

## 9. SA-06Y 对时准入合同（2026-10-01）

runtime冻结scheduler给出的原occurrence，候选查询前最多4次在短READ COMMITTED事务读取真实PG clock。仅小正差≤1000ms时在事务结束后设置可取消timer，重新采样到点才进入原候选/submit；1000ms单调readiness预算包括已观察的probe/COMMIT开销，迟到due回执也不重新获配预算。它不物理终止SQL，不能承诺调用在1秒内结束；取消先清timer，已发查询仍排空。远未来与耗尽显式UNAVAILABLE，不继续假称空候选已处理。

原两层future、strict activated_at、当前grant/owner/规则版本/预算及幂等均不改，不容忍提前入队，不换分钟、不新增catch-up。入口plugin lifetime绑定、server/caller取消、100并发无队列上限及单源单监听防止晚任务换实例与取消监听增长；并发数不代表真实DB吞吐。原无integration runtime且无候选的已到点元数据仍可正常空返回；中途激活plugin不使旧任务取得其权力。

真实PG新增用例不修改时钟/cutover：首probe仍未来、末probe到点、created_at≥原minute、四类真实持久效果各1、原invocation精确重放、native0。直接runtime用例不冒充完整scheduler；原两条wall-clock链保留。首轮完整85/85是广播前快照，最终广播冻结版完整85/85（344844ms/347.66s）也通过，零skip/unhandled/禁止IO/环境读取，临时PG已清理；字节及有限验证归CodeWT报告§31。原candidate与ledger future门各自单点变异在专用PG真实入口均失败，外层对时没有掩盖其独立证据。旧缺现场事件仍保留，不把本轮新证据写成所有历史故障根治或发布就绪。

## 10. SA06AS 日期分支不是旧计划升级（2026-10-02）

日期分支另见`automation-read-date-field-activation-decision-20261002.md`。新日期授权绑定field/type/schema确认，wake只作固定扫描上界，逐记录due在真实当前权限后计算并持久关联；不能用cron/interval的分钟/相位身份替代。旧记录和授权不变，普通submitSchedule明确拒绝date wake。复用§9对时及生命周期，但没有添加无限catch-up或源读取自动retry；实际验证与限制见CodeWT报告§51。

SA06AT只追加日期owner生产面板Chromium→真实调度→durable request→native合成预览证据（CodeWT报告§52、目标§105），未改变上述合同或13个所列生产文件。冻结版完整123/123、零跳过，三项有限降级分别被DOM/真实HTTP/实际生产时间门捕获，最终静态及66项pin核对通过、临时PG清理。隔离owner面板不是整应用登录或日期编辑器DOM验收；真实外部执行与发布仍另批。
