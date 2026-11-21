# SA-06D 宜搭自动发送委托授权：GOV-08 决策草案

## 当前交付边界（2026-10-20 本地收尾后）

当前0353候选的本地证据已收敛：host在原90秒预算下两轮完整32/32、三取消变异精准致红、共享fixture五整文件75/75、原宜搭71/71，以及manual/interval/remaining-unknown三个完整应用各九阶段通过并正常停止/清理。详情、哈希和原失败由 [既有代码 PR #6337](https://github.com/zensgit/metasheet2/pull/6337) 配套的 `integration-sa06d-yida-automation-authorization-verification-20261019.md` 交付，本文不夹带实现或验收报告；下方分批32、旧源完整应用和等待独立审查的表述属于当时记录，不再作为当前验收状态。

独立只读审查及其发现的最小修复已执行，但不据本地通过承诺所有历史时序风险已解决，亦未宣告整个集成目标或发布完成。2026-10-20 owner 已明确批准先独立提交/推送本GOV-08文档并开文档PR，再普通追加更新既有草稿 #6337 并运行既有合成CI；不强推、不新增功能切片。合并、部署、客户读取、真实token交换和真实发送仍未获授权。下方“仅本地/未获推送”和“拟定/尚未实施”等措辞保留初稿及阶段历史，不覆盖本节当前授权和验收口径。

## 2026-10-20 整文件预算修复边界（仅测试准备）

Owner 已另授权定位原 90 秒整文件超时并本地最小修复。本轮生产授权/取消逻辑不再改动；原 90 秒进程、15 秒用例/hook、5 秒 SQL 均不调整。两个真实 PG fixture 的原初始化语句分别收进提交后才公开的事务；运行事务、逐行 epoch 触发器、真实加密和独立随机 schema 不变。两个双行用例直接准备各自双行 fixture，省去一套未受测就销毁的单行准备；仍保留原两行/max2及全部业务/安全断言。

这属于局部测试准备优化，不是共享授权缓存、模拟数据库结果或生产迁移执行方式变更；初始化 seed 的 `DEFAULT now()` 会同属各自事务起点，该差异已显式记录。Astra ultra 仅只读复核源码，未代跑/代签。正式通过数、原 statement timeout/90 秒失败与最终停止清理、源哈希均见验证 MD 最新节；不把旧 65e 三组完整应用/71项改标为新候选实跑，不由一次整文件绿承诺部署或稳定裕量。未推送/触发 CI/合并/部署/客户读取/真实发送。

## 2026-10-20 撤销取消接线修订（仅本地）

Owner 已明确批准原 #6337 内的最小修复及合成/变异验证。独立反驳发现的 P2 是：持久撤销已生效，但没有向本机在途 token/form 的原生 signal 发取消通知。当前补丁按真实数据库 grantId 与可信 tenant/owner/workspace 登记运行 controller；仅在事务 provider 确认 COMMIT 后取消匹配运行，且通知早于 HTTP waiter 的最终断连检查。回滚、错误作用域及另一授权不能误取消；运行登记在实际 runtime.stop 完成后才释放。默认开关、端点、预算、原始事务完整性与停止等待不变。

保证范围明确为**已知提交的本机取消通知**，不承诺远端回滚、未发生发送或恢复已用次数。COMMIT 回执丢失导致 provider reject 时不执行成功回调；持久撤销仍由后续检查强制执行，幂等重试 revoke 可补本机通知，但不能把未知提交写成已即时取消。测试中的 HTTP waiter 断开由 port AbortController 模拟，不是实际 TCP 断连证明。新增证据和源 SHA 以验证 MD 最新节为准；历史候选说明保留，不替代本轮结果。

独立只读审查已获授权并执行：authority 接线范围未发现可达阻断；Astra ultra 对此次事务/取消补丁未发现新增生产阻断；证据反驳发现“变异仅按失败标题计数可假绿”的工具缺口，已补类型/消息哈希绑定并获再次只读确认。审查者未执行测试，不代签作者运行。当前源的真实 host 测试按原预算固定分批覆盖32项、三取消变异均为预期布尔断言致红；原整文件90秒时序失败仍保留，不能改口单进程32/32。完整应用与71项的最终状态只以验证 MD 最新节为准。

以下按候选保留的进度为历史记录；其中“等待独立审查”已被上述授权和实际审查更新，不代表当前仍缺该项授权。

日期：2026-10-19（Asia/Singapore）。状态：**方案 A 已获本地实施与合成/变异验证授权；未获推送、CI、合并、部署或真实调用授权**。

本文件最初仅获本地编写授权；owner 随后明确同意方案 A 并允许 SA-06D 范围内本地实施。当前实施状态及测试证据见同目录 `integration-sa06d-yida-automation-authorization-verification-20261019.md`。下文拟定合同不因此冒称已全部实现；不得提交、推送、触发 CI、合并、部署、客户读取、真实 token 交换或宜搭发送。

当前 c056 补齐既有 remaining-unknown 场景在原 Node20 job 的本地定义接线，不增 job/trigger、不改原步骤/预算/默认/生产实现。实际 YAML 深比对只增加该一步；原 caller 三文件 382/382、原浏览器 CI 两文件 69/69、登记/status 另两文件 69/69 和原 provenance 均通过，并从该候选实际 workflow 提取 argv 运行原整应用九阶段，真实 worker/未知围栏、ABORTED0、实际停止与正常 PG 删除全部获证。此前绑定自检/三处 selector 的真实失败以及挂载路径对照失败均保留；十个 opt-in 真库文件不冒称已经逐一进入这一 CI 步骤。所有 SHA 与范围见验证 MD 当前节；未提交/推送/运行远端 CI/合并/部署/客户读取/真实发送，独立人员终审未取得，完整目标 active。

最新 8dd0 只纠正原开关登记中过期的“未注册 sender”说明，并补两条登记测试；原 b05 与当前只差这一条 purpose 及测试文件，6779 个其余源原字节相同，实际模块其它字段与激活结果不变。当前两整文件 69/69，恢复旧 purpose 的内存变异仅新说明用例致红，原 provenance 再通过；不改默认或执行权限，也不将状态展示 helper 当 live authority。本轮另实际取得原 53 套插件＋8 套 Bridge/Resolver 边界、SA-02 原宿主 39＋1（第二 owner/第二布局）及加密普查 62 的证据；来源、历史失败、不同浏览器和计数口径见验证 MD 当前节。b05 整链仍只署名 b05，不冒称 8dd0 三全应用重跑；当前未取得独立人员终审和正式发布资格，完整目标 active。

当前 b05 源已重新通过原契约 356/356、原 provenance、完整主应用 remaining-unknown/manual 页面/自然 interval 各九阶段，以及原宜搭 71/71（66＋5）；原 validator、源与构建字节、实际 host.stop 和正常 PG 删除均复核，三组主应用浏览器诊断 ABORTED 均 0，无遗留活动合成应用。剩余次数负例用真实 JWT 与原 worker 证明第二条未用批准行不能在第一条 UNKNOWN 后再次准入；页面正例和 fresh-confirmation 未知围栏由 manual 另证，自然调度/晚回包不 ACK 与不退款由 interval 另证，不能混成一个场景。具体 SHA/范围只以验证 MD 当前节为准。下列按候选追加的进度保留为历史，不将较早“尚未接线/未实跑”当作当前状态；现有业务变异属于真实 installed host，不冒称完整主应用变异或独立人员审查。正式 CI、独立终审与完整目标仍未签完成；未推送/合并/部署/客户读取/真实发送。

f22源完整主应用JWT“剩余行/额度UNKNOWN”独立合成case现已实际九阶段通过：原owner-bound namespace严格传case，原初始化/规则/安装/共享worker/native sender，首行未知后仍used1/max2、第二行真实请求与retry fence完成但无新admission/快照/IO，原未知账本不变、撤销不退款。原业务快照/flags OFF/实际host.stop/正常PG删除与独立只读源和构建复核通过。该case不是页面授权正例，不取代原manual/interval；f22合同355/356的签名断言失败保留，修正后b05源还须重验合同及各case，不预签同源全部回归。具体SHA/范围见验证MD首节；独立终审及完整目标审计未完成，未推送/CI/合并/部署/客户读取/真实发送。

当前继续补完整主应用“首行UNKNOWN仍有第二行/一次额度”隔离负例：仅测试helper及既有合成vendor unknown-first模式已落位，14项Linux小测试和三helper类型检查通过；原公开CLI/namespace独立case及必需证据门尚未接线、完整主应用JWT此负例尚未实跑，不能用host28项或旧32c1两整应用代签。必须新owned环境，禁止修改原初始化/approved材料/历史账本或额度来制造空余；完成后仍须独立终审，来源和历史失败见验证MD首节。生产权限/默认/端点未改。

671f新增测试证据：实际installed host/PG/native整文件28/28，含同一finite grant两行ACK正控制与第一行UNKNOWN后仍used1/max2/第二行已request+claim但不能admission负例。内存仅删原BUSY守卫后27过/唯一目标失败，实际第二次合成token/form及admission发生；源未变、PG正常删除，原公开合同325/325。原始外层报告定位失败收据保留，后续只读审计用同run报告字节hash绑定后才确认目标失败。此项不冒称完整MetaSheetServer/JWT下该负例或独立审查已完成，具体来源与历史限制见验证MD首节；生产实现/授权边界未改，目标active。

32c1同源收尾现已闭合：原合同325/325，原manual/interval各九阶段，原宜搭71/71及各自正常停止/PG删除、源与构建字节复核全部通过。自然tick证明来自原scheduler/实际JWT规则/interval-only有限授权与原共享sender/ledger，不借手工请求；manual真实页面和fresh未知围栏亦在同源重新通过。前端已有显式定时允许选项，未新增UI或调度器。预算/行未用尽时的未知隔离负例、真实路径变异、独立终审和完整目标逐项审计仍未完成；所有具体来源、限制和历史失败见验证MD最新节，完整目标active，未推送/CI/合并/部署/客户读取/真实发送。

最新32c1源原interval整应用九阶段与325原合同已通过：实际owner JWT的新HTTP规则/interval-only有限确认，由原boot scheduler自然产生两次请求（手工403），原共享outbox/native sender得到第一ACK和第二在途dispatching，原host.stop/晚2xx不ACK/不退款/正常PG删除全部通过；相位与occurrence独立观察、新公开强制门和源/构建字节复核亦通过。同源manual与71仍须回归，未知且有剩余预算隔离负例与独立终审仍未完成；当前事实和历史失败以验证MD最新节为准，不据自然触发绿签整条目标或真实外部发送完成。

当前验证候选进一步补自然定时：a90源的manual/interval/71已实际闭合后，既有interval在途测试改由**新真实HTTP规则＋新interval-only有限授权**触发，等待原boot scheduler的2000ms自然tick，不直接调producer/dispatcher、不回填created_at/改时钟、不新建引擎。原两行/max2/900秒、手工入口403、每行10秒、同一原sender/ledger及全部在途stop断言保留；独立PG phase/occurrence/共享outbox观察与公开强制证明门同步接线。该新32c1源仅小测试12项及纯门125项已通过，原整应用/自然tick仍待实际验收，不能借a90绿代签；来源见验证MD最新节。生产默认、现有端点/授权边界均未扩大。

最新本地实证：a90冻结源原manual整应用九阶段与313项原合同已通过，新增真实owner密码JWT/新confirmation/grant/request→原共享worker/native未知账本SELECT→原reschedule fence的隔离负例完整获证。新grant未admission/used0、原两ledger/快照与私有历史指纹不变、原token/form仍2/2且无第二CREATE，新确认真实撤销；actual stop与正常PG删除通过。新增仅测试观察与必需证据门，不改生产retry状态：原reschedule保持in_progress，以fresh default-zero consumer的fence=2*attempts及unknown原因区分已退避和仍在执行的claim，原10秒预算不变。具体失败、边界、SHA以验证MD最新节为准；同源interval/71仍待复验，未知且原grant预算未尽、新宜搭自然定时与独立终审仍未完成，完整目标active。

本地进度：已落地有限授权/持久预算/撤销、原outbox同事务受理、实际安装与worker前置、COMMIT后的私有单次票据、原native sender/090账本、实际页面批准/请求与反馈。原人工六方法不扩张，claim/finish保留同事务consumer锁/fence，CURRENT仍v4，私有candidate5不向普通action开放；requestManual只在确定提交后返回受理，不把reserve当入队。真实页面组合在6775源的原manual整应用已通过；6776源的原interval整应用又证明真正MetaSheetServer.stop等待在途native回包、晚有效2xx不ACK及正常PG删除。两组源与收据不能混同：active parent的malformed2xx可提交outcome_unknown，parent停止后仍严格保留dispatching未决，不补写旁路。完整来源、失败与范围见验证MD；主应用隔离负例、新证据帧的公开CLI强制验收接线、同源余项回归及独立终审仍待收尾，不签整个目标或正式CI/部署/真实IO完成。

## 完整应用冷安装修正（同一范围，未部署）

原真实provider冷安装暴露数字098早于共享outbox导致42P01；手工fixture先建outbox的绿没有覆盖这个顺序。该未提交迁移改名 `zzzz20261019121000_link_integration_yida_automation_outbox.sql`，原DDL逐字节保留，只改自然排序，不增skip/重复runner。当前全新库原命令478条执行成功；存在人工旧098历史的外部环境须另核历史，不可擅自删记录或照搬更名。

原package配置下的bind泛型丢类型，补显式原合同类型及InstalledSource别名；两个相关模块发出JavaScript与修前相同，未改编译设置、运行检查或授权范围。当前冻结6771源，原manual整应用9阶段与原构建/浏览器/实际stop/PG删除验收及只读复核已通过；不代签新自动授权整页或发布/真实IO，具体限制和SHA见验证MD最新节。

## UI 接线约束（同一 SA-06D；不新增端点或放宽既有门）

公开验收收口已落位：原完整CLI在旧全部门之后，无条件调用独立的values-free SA06D证据验证器；不按源文件存在与否跳过。manual必须有真实授权页面与执行记录，原interval场景必须有在途准备→actual stop→真实未决后验，两个场景不能互借。新95项及旧198合为原命令293项通过；删除执行/在途精确证明检查分别6/8致红，实际提取公开调用段的缺帧/删调用自证与旧静态正则全部保留。当前6778源码原manual与interval**各九阶段**均通过含新公开门的真实接受路径及只读工具复核，不借此前源码绿。此门只验证受核身原应用记录的完整/一致/顺序，不赋予发送权，不防恶意同进程伪造、不代替权限/DB/浏览器真实路径或独立终审；未改workflow、权限默认或生产开关。业务隔离负例、新宜搭自然interval与独立终审仍是未完成项，来源见验证MD。

该最新6778源的原宜搭71=66业务+5哨兵也已独立新owned环境执行通过，原source/owner/task/receipt与清理复核通过；它是原owner/初始化回归，新增有限授权的整页证明仍来自同源原manual整应用。公开门接线这一项收口，不等于SA-06D或整个自助接入目标收工；剩余主应用隔离负例、自然宜搭interval与独立终审必须继续，发布/CI/客户与vendor联调/部署仍未授权且未执行。

本轮落位结果：修正身份域比较后，新6775源的原完整主应用manual九阶段已通过；真实页面批准/两次请求→实际原worker/native假vendor→ACK/未知→页面撤销及正常host.stop/PG删除闭环通过。原源与构建收据的只读核验也通过。此结果只覆盖本地合成，不将候选描述中的限制自动取消；在途取消/晚回包、主应用隔离负例、同源其余回归和独立审查仍在剩余清单，详情与SHA以验证MD最新节为准。302前端与197原契约及两个单点变异分别计数，不相加冒称全仓通过。

身份分域修正：初始化draft的targetRef属于091 `local-unverified`，实际owner preview的targetRef属于090 `owner-attested-single-target`，两者通过后台090的draft_target_ref关联，不以UUID相等关联。UI不得比较两个不同身份域的ID；逐行owner预览仍必须由实际client核operation/member，并严格比较所有已审preview的目标ID、planDigest、review、organization、app与form彼此一致。不能以此修正为由接受混合目标、客户端自报目标或跳过服务端实时授权。原SFC样本共用target UUID的缺陷已改为分域样本，六类不一致负例及恢复旧比较/去掉跨行目标门变异随实现验证。

当前新增候选是**真实页面批准与请求的合成验收**，而非新功能切片。复用原初始化浏览器外壳，另开正常密码登录的独立 context，进入实际草稿项目的真实 board；专门窗口只放行逐次明确 armed 的既有 rules/init/owner-preview/有限授权四操作，正文、请求身份和完整响应逐项核验，不放行人工 send。原 OFF 页面与两子进程证明先完整结束，才在受核身的 owned PG/namespace + 固定假 vendor 内短暂打开两个已登记 flag，以满足原 owner-preview 门；测试 finally 原样还原两者。旧 Node 驱动组合的人工作业 flag 始终 OFF 的证据仍仅属于旧组合，不混写为当前页面候选。原生产默认、预览门和实际远端隔离均不变；在本轮完整验收完成前不签页面链通过，来源见验证 MD。

实际main/JWT→UI已创建规则→安装绑定/原worker/native sender/PG账本的有限合成执行组合已通过当前原整应用门及197契约：ACK一行、malformed-2xx账本unknown一行，token/form各2；原consumer各只attempt一次，done/dead_letter后才关测试flag。unknown请求刻意保留**admitted + outcome_unknown**与串行占用，不是closed_unknown；撤销不退款、不清掉未知。这里只替换进程内远端Response，Node HTTP批准/请求仍不是页面批准/运行证明；实际外部IO仍未授权、未发生。剩余隔离负例、在途停止与独立审查及所有来源SHA见验证MD最新节，不能以本节签整个目标完成。

完整主应用的下一测试窗口只模拟固定vendor边界：原OFF窗口结束后，以实际浏览器创建的规则、真实JWT/安装绑定/原共享worker与native sender验证ACK和malformed-2xx UNKNOWN；测试进程临时设置已登记自动flag并finally还原，人工发送flag保持OFF。假服务在未arm/已关闭时拒绝，绝不回落真实远端；production index不引入测试模块或测试端点。这不是实际外部发送授权，也不代签页面批准/运行、未知但预算未尽的隔离守卫或在途停止；候选结果见验证MD最新节。

默认OFF页面组合已通过当前原整应用manual门：原真实登录/初始化/重载后，同页新面板无隐式请求地加载实际草稿，创建规则、选两行，原preview403后保留错误且不出现授权/运行入口；实际rule版本/owner/sheet/slot由父进程查库对应，auto grant/request/admission及发送账本0。该候选的原契约197/197、正常host.stop与PG删除通过，ABORTED0，来源及保留失败见验证MD最新节。仅修验收等待，不放开OFF门；批准后执行/未知/在途停止的整页合成链及独立终审仍必须补齐。

真实main默认OFF组合已补到原整应用验收：在原初始化证明结束后，用实际密码JWT、安装profile/插件、规则HTTP版本和原worker验证有限授权；错项目/版本、自报scope、跨owner/tenant拒绝，合法排队与重放/撤销通过，admission与发送账本仍0，正常host.stop/PG删除通过。它不改变用户授权范围，也不代签新自动授权UI或发送ON/未知结果浏览器组合；完整来源与收据见验证MD最新节。

复用现有 `GET/POST /api/multitable/sheets/:sheetId/automations` 列出/创建规则；只给私有宜搭动作的既有规则响应增加合法 DB `integrationAuthorityRevision`，不从 body 接收/覆盖，不把版本当权限。普通动作响应不增加字段；列表仍由原 canManageAutomation/sheet-liveness 门控制，授权继续独立要求真实JWT tenant/owner与实时integration admin。

新面板从本地初始化GET取得服务端 operation/row引用，逐行通过**现有** owner preview取得真实目标、payload与摘要后，才可确认有限集合、项目、触发类型、次数和期限。owner preview目前要求既有手动流程开关，UI必须展示拒绝，不能用本地JSON或初始化引用冒充服务端逐行预览；本刀不放开此门、不变更全局默认。初始化/静态预演本身仍可独立在OFF工作；自动授权能力与它们分开展示。

规则创建和授权/请求提交均只由明确按钮触发；不挂载即创建、不自动批准、不自动手动请求。未知创建回执保留原slot仅允许刷新查找，未知授权/请求保留原命令；换账号/上下文/卸载清空并取消旧请求，晚回包不复活。未决、协议ACK与业务成功必须区分；不将stale/reused或登记记录显示为定时已启动。

## 最新实施补充：有限 interval 复用原调度器与已选授权

实际 scheduler 对此私有动作复用既有锚定 interval/单航班/排空机制；AutomationService 在可选第九个私有producer参数存在时才提交 occurrence，core index 明确接入同一个管理host。不存在普通executor fallback，scheduler快照不是授权。callback只提交 ruleId/interval/anchor/原始scheduledAt，没有用户可报的tenant/owner/grant/payload。

自动slot来自本激活内owner明确的新确认，仅在原事务COMMIT已知且生命周期仍有效后登记；历史重放不登记，重启/重新激活不恢复；manual-only授权不进入slot。每规则一个明确interval授权，不以latest/owner名称查授权；不同确认需要先显式撤销旧授权，拒绝静默替换。同一确认重放不刷新期限/次数。内存slot表固定上限256，pending确认也计入；停止立即清空，授权事实和已消费历史不删。

每次interval沿实际installed source→当前规则版本/live材料/ACL→原有限授权store→既有reservation/outbox执行。原DB created_at毫秒相位必须匹配，interval必须与DB严格定义相同，scheduledAt不得在未来或早于一个完整周期窗口；不做批量历史补发。定义摘要由服务端固定tuple生成，不接收客户端digest。原10秒预算包住该次producer，取消等待原SQL/COMMIT结束，stop仍排空真实工作。消费者继续默认OFF、每次独立重验，人工授权不可被定时器升级。

本地202单元整批和26项真实PG宿主整文件通过；后者在原native fetch边界模拟远端，实际interval入队后由原shared dispatch tick消费并核对原ledger ACK/同request退役。没有真实token交换或发送。真实JWT整应用组合、UI有限授权及未决终态反馈、独立审查/整站回归仍未完成；初始化/预演交付不得被此扩展替代。两次51项加载超时保留，201诊断绿及后续202绿都不证明WSL p9等待根因已修复。

## 较早实施补充：真实规则保存与数据库约束（仍非自动执行资格）

已补上先前不可保存的动作枚举缺口：实际规则 parser、create/merged update、动作类型和专属 CHECK 迁移均识别 `integration_yida_send_authorized`。配置只保存稳定 `authorizationSlot`；不在规则内存授权ID、tenant、owner或凭据，也不从保存成功推导执行许可。当前仅接纳严格有限 interval 形状，单一私有动作、无条件、legacy 模式；普通 executor 的执行、模拟和两种续跑入口必须整条拒绝私有节点，不能先执行它前面的普通写动作。

新迁移 `zzzz20261019120000_add_yida_authorized_automation_action.ts` 在实际原 read migration 之后扩充冻结动作集合，保留旧 read-shape CHECK；最终行 CHECK 同样拒绝 JSON 内嵌可执行私有节点、额外授权字段和不合形状的部分更新。up 幂等、不改规则版本；down 遇保留的私有规则或任何自动授权历史（含撤销、规则已删）拒绝，不通过删除历史回滚。只在本机自有临时数据库执行，未迁生产库。数据库的字符串长度/空白语义与 JS 不完全相同，不能据此宣称所有 Unicode 输入跨层等价；实际执行仍独立重验。

实际 AutomationService→PG 版本触发器→实际 installed source→显式 owner consent 的整文件9项已通过，纯规则保存不入 outbox、不产生发送资格。有限 interval 的真实 occurrence→slot→明确 grant 关联、UI 及完整应用回归仍待完成；现在的 scheduler 回调明确拒绝普通降级路径，不会暗中自动发出请求。验证数字、类型检查限制和原始失败保留见验证 MD 顶节。

## 较早验证补充：停止后的真实未决事实不能被美化

最新组合补证：6776源的原完整CLI interval场景已实际到达MetaSheetServer.stop，而非只调用管理host的子stop。真正host.stop触发原native form signal，原Promise在假服务晚有效201释放前保持pending、主池仍开；释放后真正stop同一Promise完成，再由独立真实PG client读取同一owned库，精确保留第一行ACK与第二行admitted/dispatching未决、used2/串行位。原主/源池/监听/timer/collab/PG删除门全部通过。原只读interval自然触发仍通过，但新增发送请求是明确manual-only，不冒称自动宜搭interval已整链获证。本轮首次错误oracle及VM夹具SyntaxError失败均保留；没有为追求terminal unknown而忽略父取消/当前权限/fence，也未改生产停止或发送权限。公开CLI新增帧的强制gate和同源余项仍在验证MD剩余清单。

该源的原契约198/198及原宜搭66业务+5哨兵71/71也已通过；71是原owner/初始化回归，不给新增自动授权整页或自然interval背书。正式CI仍未触发，独立只读工具审计不冒称独立人员/代理终审。所有原始来源与新旧失败继续以验证MD为准。

同一宿主21项当前真PG整文件及结果策略变异已验证：无效201在原live/fence守卫可用时落为原生outcome_unknown，预算不退、串行槽不释放，重投或新confirmation均不产生第二sender；已发出表单fetch后stop必须等待原回包，晚到的有效201不能成为ACK。parent已撤销时不另开末尾写旁路来“补unknown”，保留真实dispatching未决和used=1/serialBlocked，允许新宿主按真实权限观察，不恢复发送资格。该历史必须在后续UI明确表示未确认/需核对，不能等同远端撤销、业务成功或已经完成对账。

本轮只扩同一真实路径测试与MD，不修改生产授权边界，不新增端点或功能切片。原19阶段回拨失败与其它旧失败保留；当前21/21不签完整app、浏览器、interval/UI或独立审查完成，详见验证MD最新节。完整目标仍active。

## 较早实施补充：实际启动/插件能力/共享 consumer 接线

已在真实core index组合同一宿主、四个已批owner操作、16kb/no-store/parser错误门与全局JWT之后的位置；只给integration-core提供私有capability，在其真实read runtime激活后捕获实际native binding。重载、失败、停插件和server.stop加入本宿主同步关闭与排空，不依赖loader不等待的deactivate hook。原private观察策略覆盖新授权子树，不新增认证旁路、mst权限或其他端点。

既有durable boot/registry新增显式adapter槽位，仍使用原dispatch loop。默认CURRENT=v4、旧fan-out与默认OFF不变；build支持集合增加5，以便显式安装的private candidate通过真实双向完整性检查，未知6仍拒绝。未装该consumer则requestManual拒绝/回滚，不先留下无法消费的202。worker从不可变DB关联解析主体，原authority继续证明ACL、安装材料、lease/fence、次数与期限；实际native factory复用05C原生机制，不另写sender。总预算从metadata前开始、原10秒不抬高，取消/stop等待实际token flight，不宣称撤回已发送请求。

当前证据必须按验证MD最新节读取：宿主候选曾19/19，当前清理未用import后的复验18/19，实际并发正例期间PG回拨1155ms触发拒绝；不把旧绿签新源码、不降低守卫。就绪策略回退变异18通过/1目标失败，独立纯unit97/97、Linux原provenance1/1；Windows shell失败、初轮夹具/类型与分套件错误均保留。实际源码AST证实挂载位置/单一入口/69项固定census，但尚非完整server/浏览器证明。

下一步仍是同一SA-06D完整应用、相关回归与时序风险收敛，再接interval-slot和授权UI/终态反馈、独立审查；无新功能切片，不因代码已接线提前宣称可交付或准许真实发送。本轮不推送/CI/部署/客户读取。

## 较早实施补充：宿主拥有整笔事务的停止边界

四个已批操作新增 management host 组合：一次性插件 capability 激活、宿主生成 activationId，create/request 从实际read runtime重取安装来源；管理服务共享一次宿主RC事务，响应等真实COMMIT。read runtime 的新 core-only scope 等待整笔外层事务/COMMIT，不仅是安装元数据 SQL。最后 callback 同步重验取消/注册/来源，stop/deactivate 关闭入口后排空原 Promise。COMMIT阶段停止可能留下已提交grant，必须观察原记录而非宣称撤销/自动重发。

inspect/revoke 独立走 live actor/owner/admin 和原 scoped store，不依赖安装仍在线；新activation不得复活旧grant。当前宿主真PG11/11、当前安装回归12/12，外层事务drain单点降级被抓；ACL降级第一轮另有真实时钟回拨导致的正例拒绝，原失败如实保留，详见验证MD首节。未改变预算/TTL/未知结果合同。

仍未完成main/plugin正式激活、共享V5 consumer、worker/interval-slot、UI和完整app/独立审查；宿主组件绿不是产品交付，四操作不能在对应consumer就绪前对外受理。当前不挂运行入口、不动全局默认、不新增端点或功能切片、不推送或真实调用。

## 较早实施补充：实际安装来源接入材料版本

复用现有 Automation READ 的真实 producer/profile、目标材料 codec、metadata epoch 与字段/记录 ACL，增加仅 core 宿主可取的安装来源，不从请求提供 binding，不猜测 project=base，不增加调度器。批准与 worker admission 的材料根加入安装版本；材料内容恢复为原值、producer 重启、legacy 无安装 grant 均不能借新的有效来源复活旧授权。回调一旦提供，null/无效摘要拒绝，不能退回裸组件模式。安装查询纳入实际 read runtime runs，stop 先作废并等待原 SQL 结束。具体来源哈希、整文件12/12、两个单点变异致红、真实JWT12回归见验证MD最新节。

这是安装元数据边界的实现，**不是完整宿主接线或可交付证明**。生产 host 尚须强制要求该来源，拥有外层事务并在提交前重验生命周期，协调整个事务 drain；现在的 runs 只登记安装元数据操作。四路由正式挂载、V5 consumer/dispatcher、interval-slot、UI、完整 app 与独立复核仍按原目标完成，不增加切片或修改全局默认。原发送/时钟/CI失败历史保留，本轮不触发推送、CI或真实调用。

## 较早实施补充：四操作路由组件

已本地落地四操作路由模块，尚未main挂载。实际HTTP → 原生JWT/AuthService/session → 真实有限授权服务/PG的整文件11项通过；其后补上“JS调用真实错误构造器可绕过TS code union”的wire code白名单与负例，当前12/12。当前12项的tenant/owner/旧wire-code行为三个变异均各11通过/1目标失败，无额外失败、0pending、实际PG清理完成；scope查询错误200而非403，wire-code回退错误返回非白名单code，而不是用状态变化或setup失败冒充命中。只处理持久授权/观察/撤销/入队，0 token/form调用；首次批准201、批准重放200，首次durable受理202、请求重放200，不把202当发送完成。身份不取header兼容回填；scope hints/未知body/query拒绝；输出和异常闭合。旧全链时钟失败与尚未做的独立审查不因此消失。

真实前门夹具只采用固定合成绑定，不证明生产安装来源、V5正式注册、全局product-mode门、worker启动/停止或UI接线。测试启动阶段的tsx探测/worker loader失败以及业务全过但worker围栏失败都保留；最终仍使用原有精确“阻断optional parent pipe”策略，不允许该连接，不改围栏源码。不能把helper的reportedPassed当执行证据或借其它泳道绿背书。细节、哈希、当前收尾状态见验证MD首节。

## 历史实施补充：请求终态观察

串行 ACK 候选加固定阶段/计数及转发真实 Date.now 的诊断后，完整发送20/20、实际PG停止/删除已通过；先前时钟回退和 masked 失败证据仍保留，不声称环境根因已修。随后实现既有 GET 合同所需的 core inspect 投影：live owner ACL + scoped grant 锁 + 有限请求/原生 ledger 终态 + serialBlocked，校验预算/admission/active 指针一致，不读或返回秘密，不新增端点或授权范围。OFF/close/过期/撤销仍可在 live owner 权限下查历史，不自动激活、不刷新次数/TTL。

新增21项首轮20通过/1失败（原 copied-permit 准备用例，捕获 OWNER_REQUEST 时钟水位拒绝）；新 history scope 与 ACK/unknown 等投影用例通过。旧 live/management41/41。分别移除 tenant/owner 的单点变异都命中 scope 负例“错误地 resolved”，各有一个额外失败且已分别保留，不将额外失败归为变异成功。随后去掉历史 request 的 externalWriteAttempted:false 字段，避免未知结果被误读为从未尝试；顶层该字段仅描述本次观察本身没有 IO。最新21项20通过/1失败，原 fence-change 用例在 admission 前因水位拒绝，未进入 token/fence目标；新投影等用例通过，但不报全绿。正式 host/来源绑定、interval/JWT/UI、完整 activation 停止与独立审查仍未完成；详见验证MD最新节。

## 历史实施补充：串行 ACK 退役

已本地实现：在 unchanged admitted finalProof 完成后、仍持有同事务 grant/request/consumer 锁时，核对真实 ledger ACK/claim token/worker/admission/fence，再原子完成 request.closed_observed 和当前 active 指针退役。最后截止检查保留，原 native ACK/audit 与退役一起提交/回滚；unknown 不释放，不退次数，无新增迁移。没有把默认授权改为单次。

新19项发送整文件第二轮18通过/1失败，其中连续两行、unknown 阻塞和真实退役 SQL 故障回滚三项通过。去掉终态退役调用的单点变异精确打红两条目标用例，17通过/2失败，无额外时钟失败。之后补第20项终态 COMMIT 丢回执检查，修正新用例对原 native ACK readback 的错误预期后，当前20项18通过/2失败；三条串行用例通过，新 COMMIT-loss 正例被 claim 前置拒绝，仍未走到目标阶段；另有原 close-provider-fault 失败。同候选 runtime11 为10通过/1失败。actual PG 回退及未归因事实保留，不拿下面旧候选全绿代表当前完成。详情和精确哈希见验证MD最新节。当前仍须完成稳定整链，再推进正式 host/可信来源、interval/JWT/UI、完整 activation 停止和独立复核。全部仍限本地，不推送/CI/外网发送。

## 历史收口顺序（较早阶段进度）

当前本地整文件真库验收：execution22/22、send16/16、private runtime11/11。具体源码哈希、失败历史、四个单点降级和清理证据见验证MD首节；不代表正式 host/JWT/UI 或全部 SA-06D 完成。

私有 runtime 在 admission 前启动总预算，关闭入口后取消并等待原任务/token flight，最后关闭 authority；实际 close/drain 失败不与业务失败混算。attempt 构造前仅允许 metadata 重试；COMMIT 回执未知的重入仅观察持久历史，不重获发送票据。进入 attempt 构造后禁止通用重试恢复物理发送。该约束没有新增端点、没有扩大已批有限授权，没有更改全局 CURRENT v4 或默认 OFF。

最新发现：现有 admission 设置 grant.active_request_id，但 ACK 尚未退役该串行指针。单行成功不能代签有限多次数。因此下一步先在同事务及最终 fence/lease/live 重验后收口 request.closed_observed 与 active 指针，再验同授权第二批准行；unknown 继续阻塞、不退次数、不重获 CREATE。不得改成 maxExecutions=1 宣称交付。接着才做正式注册、interval/JWT/UI、完整 activation 停止与独立审查。097 已有终态枚举，先复用合同，不预设新增迁移。

## 1. 决策结论与交付边界

当前shared机制严格区分人工与自动：原人工导出的actor=owner门不变；不导出的kernel共用prepare/claim/ACK/unknown逻辑，另有显式私有自动入口消费actual core句柄后才创建原token/form组件。core使用真实worker而非冒充owner，snapshot/token凭据投影分离；原token client交换前与发布前两次真实重验必须都通过。单次attempt finally等待实际token flight排空，不能用business ACK代替close/drain成功。新机制尚未注册到index/consumer，默认OFF不变；当前不等于SA-06D可交付或准许真实发送。最新验证细节以验证MD首节为准，下文较早阶段数字保留作历史证据。

后续本地进度：真实shared dispatcher领取前置19/19及四降级已验证；已进一步组合真实live材料、native prepare/原永久fence、预算/admission与099加密快照，明确COMMIT后才发一次性前置票据，execution整文件16/16及五降级通过。checkpoint只向私有worker投影批准行，不交付整个source/plan；已用同draft的未获批项目行证明。原native人工/委托纯机制26项、flag46项、encrypted probe/census62项通过。一个并行降级的额外management拒绝仍未归因，证据保留，不能当作期望负例。完整sender尚缺worker宿主注册/真实JWT与源来源、共享runner/token/form、取消/stop/unknown整链及独立审查；不与原宜搭71或正式CI混用。

推荐采用 **A：有限快照集合的、可撤销的后台委托授权**。owner 显式批准有限行集合、明确项目与版本、固定目标和凭据代次、次数与截止时间；既有 Automation 触发只负责提出运行请求，不能产生或扩大授权。后台每次执行均由 core 重验授权及 live 权限，使用独立委托能力，不冒充已登录 owner。

本草案只覆盖原目标 SA-06D；不改变已经批准的 Automation A 只读合同，不把“允许编写文档”解释为允许自动发送实现。现有初始化、两行静态预览、人工单行发送和只读 Automation 可独立交付，不必等待本草案实施。

引用目标：`docs/development/integration-self-service-adaptation-goals-20260930.md` §11.6。该目标文件属于独立目标文档工作区；在本草案当前代码检出中未落文件，故不生成失效相对链接。本次实际从该独立工作区读取目标文件；SA-06D 明确要求另有自动发送授权决策才接线。

### Owner 已裁决的选择

- **A（已同意）**：按本文冻结受控委托合同，本地实施及合成/变异验证已获准；发布与真实调用仍分别批准。
- B（未选）：暂不做自动发送，继续交付现有人工单行和只读 Automation；完整 SA-06D 保留未完成，不删原目标。

不推荐：复制人工 grant 给定时器、替换 actor 为 owner、把已有只读 grant 当写授权、任意项目通配、无限期限、失败 CREATE 自动重试。

## 2. 冻结代码依据：已有能力与真实缺口

本次代码依据为已发布 #6337 head `e7305e65167bd512d814a88036cffd3462855c36`。本地检出 HEAD 是 `69140b86619e8fa9c1bf6da9bca5af731c8f5000`，已有八个未提交改动原样保留；本节引用的 core/src、plugin/lib 与迁移范围经该两提交 diff 核对无差异。下面行号只对冻结代码成立；未来 head/base 变化须重新核对。

| 已读代码（仓库相对路径、行号） | 已有事实 | SA-06D 不能偷换的边界 |
| --- | --- | --- |
| `packages/core-backend/src/multitable/automation-actions.ts:9,39`；`src/integration/automation-read-contracts.ts:283–292` | 已登记 `integration_read_preview`；结果必须 `canApply=false` | 原只读动作不能升级为外部写 |
| `packages/core-backend/src/routes/integration-yida-owner.ts:63–73,253–272` | HTTP actor 取真实用户与 authenticatedTenantId；拒绝 header/body 自报 scope；人工授权/撤销/提交已有入口 | worker 不自调用 HTTP，不伪造 JWT 或 owner 登录 |
| `packages/core-backend/src/integration/yida-send-approval-service.ts:207–219,231–238,308–350` | live core 权限、批准目标 owner 相等；单行 CREATE；TTL 至多 900000ms、maxAttempts=1、加密快照 | 不修改人工表约束来获得后台常开能力 |
| 同文件 `374–410,492–536` | admission 提交才可能产生私有一次性 WeakMap permit；历史重放不再产生 permit；COMMIT 回执不明不恢复能力 | 重启/重放不能重新拿到一次发送资格 |
| `plugins/plugin-integration-core/lib/yida-owner-send-port.mjs:90–100`；`yida-delivery-runner.mjs:205–210` | owner port **以及 runner** 均要求 actorId 等于 ownerId | 仅新增 wrapper 或只改上层 port 不足；不能填假 owner 绕过底层 |
| `plugins/plugin-integration-core/lib/yida-send-authority-primitives.mjs:149–156` | 原executionPayloadDigest也以实例WeakMap验证selection，并硬校验grant.actorId等于材料owner | 委托执行不能借用原digest工厂后填假owner；须与runner一起保持人工入口合同、接私有委托证明，原摘要算法本身不复制 |
| `yida-delivery-store.cjs:263–308`；迁移 `090_create_integration_yida_delivery_ledger.sql` | 真实 claim actor/fence、逐行状态、唯一行身份、受约束终态；unknown 不可直接跳回 prepared | 不重建账本或释放 CREATE 围栏来“恢复” |
| `yida-delivery-runner.mjs:298–360` | 发送前领取；异常/回执无效/ACK 提交不明进入 unknown 或 state_unconfirmed；businessVerified=false | HTTP 2xx 或任务结束不等于业务校验成功 |
| `packages/core-backend/src/integration/automation-read-ledger.ts:1–40`；`automation-read-recovery.ts:36–86` | 已有 outbox、ledger、lease/fence 与恢复设施；只读恢复不是发送重试器 | 复用基础设施，不复用只读 authority/事件作为写权限 |
| `scripts/ops/global-history-flag-manifest.mjs:51` | 旧 `INTEGRATION_YIDA_OWNER_SEND_ENABLED` 明确仅人工单目标 CREATE、不含 Automation | 新自动能力不能借旧人工开关隐式开启 |

迁移 090 的底层账本具备 create/update 形状，不代表当前受审 owner 路径或本草案批准 UPDATE。当前人工 primitives 在 `yida-send-authority-primitives.mjs:69,108` 继续限定 CREATE。本草案第一版同样只准 CREATE。

## 3. 授权主体、作用域与材料绑定

### 3.1 三种身份不得混淆

1. `grantorOwnerId`：当前连接、材料和已批准目标的实际 owner，同时通过平台现有 live integration 管理权限判定；同 tenant、有效用户、有效成员关系。平台管理员不能凭身份绕过资源 owner 相等检查。
2. `requesterId`：人工请求者或可信既有触发源。只能提交授权引用和稳定 occurrence，不能选择执行 owner、tenant、目标、凭据、payload 或授权次数。
3. `executionPrincipal`：core 受管 worker 身份与本次 activation/fence。它不是用户 JWT，不与 owner 相等；审计必须同时保存真实执行主体和 grantor，不能把两者压成 `createdBy=owner`。

tenant 只来自可信认证/已持久授权与受管执行上下文的一致比对；不采用 `x-tenant-id`、body tenant、ALS 回填或 webhook 文本自报。首次限定 `workspaceId=null`，沿用当前单批准目标，不顺带扩大 workspace 共享、多目标或跨 tenant。

后台不要求 owner 保持浏览器会话在线；但每次重新核对其当前账号、tenant 成员、管理权限、所有权和材料状态。已有人工 grant、cookie、短期手动 preview token 都不是本授权。

### 3.2 必须在批准时冻结的材料

- tenant、null workspace、grantor、规则 id、规则版本、动作槽位、允许的触发种类及 activation generation。
- **单个明确项目号**，源配置/激活版本与连接 incarnation/revision；仅授权已审源及其已批准读取结果。发送动作自身不顺便再次读取 PLM/K3。
- targetRef 与批准证据版本；credentialRef 与 generation；映射配置版本/digest、静态计划 digest。
- 明确枚举的 operationId/rowKey，每行 business-key digest、payload digest、不可变加密快照及本地 CREATE fence 身份。
- DB 生成的 approvedAt/expiresAt、最大执行次数、最大总行数、取消/撤销 generation、唯一确认标识。

首版只处理 owner 预览并确认过的有限快照集合。后续 Automation 读取生成了新行、payload/项目/版本变化，必须重新预览并显式授权；不能自动把新读取结果追加到授权集合。规则/来源/目标/凭据变更及 ABA 都使旧证据不可执行。摘要和材料必须由 core 从真实受管存储重新计算/核对；客户端提交 digest、`confirmed=true` 或“之前校验成功”的文本都不是证明。

## 4. 次数、期限和并发：建议的可审合同

以下为方案 A 已裁决的实施上限，不代表已全部产品接线。更宽范围另裁；本地实施不包含发布、部署或真实调用。

| 参数 | 首版建议 | 含义 |
| --- | --- | --- |
| maxExecutions | 1–10，默认 1；必须显式确认最终值 | 一个新 durable child admission 消耗一次；不是“成功次数” |
| maxRowsPerExecution | 固定 1 | 复用单行 ledger/runner，不新增批量 API |
| maxTotalRows | 等于批准行集合大小，1–10，且不超过 maxExecutions | 两个上限同时满足；不允许用相同业务键刷新 operationId 绕围栏 |
| expiresAt | 批准时 DB 时间 + TTL；TTL 1–900000ms，默认 900000ms | 既有 15 分钟安全上限，不引入续期或滑动延长 |
| maxConcurrentExecutions | 同一授权固定 1 | 行集合可在期限内依序执行，不并发 fan-out |
| 每行写尝试 | 固定 1 | 重复 occurrence/重复入队不增加写次数 |
| 单次执行超时 | 默认 10000ms，上限 60000ms，且不超过授权剩余期限 | 不因慢响应延长授权；与已有网络/SQL预算逐项匹配后实施，不放宽现有预算 |

授权不是定时计划。首版允许的触发种类固定为受管手动请求和 `schedule.interval`，每份授权显式选择其允许集合；复用既有 interval 调度，不新增 scheduler。cron/date-field/record/webhook 触发的自动发送不在首版；现有只读对应触发仍按原合同运行。首版不支持无限定时授权、动态全表扫描、任意条件选择目标或把下一次触发解释为新授权。先验收手动请求经后台队列运行，再验收有限 interval，不能把普通 Automation 全局 action executor 放开。

occurrence 身份必须由 host 按真实触发来源构造：手动请求使用绑定 grant/actor 的稳定 request key；interval 使用受管 activation id/generation、规则版本/动作槽位、调度定义摘要及 scheduler 证明的 scheduledAtMs，不使用 worker 当前时间或重投次数。唯一请求同时绑定 grant；相同 occurrence 重投返回原请求及原行，不选下一行。不同 occurrence 在事务中依批准顺序预留下一条未预留行，固定 request→row 关系；失败/阻断的请求不释放关系给后续 occurrence，不能靠反复换 request id 绕过行唯一约束或额度。

计数从**新 admission 事务确定提交**起消耗，而不是 enqueue、收到 202、HTTP 成功或 ACK。在此之前明确回滚不消费；COMMIT 是否成功无法确认时按已消耗/待核验处理，不退回许可、不新建替代授权。已经 admission 的 not_sent、取消、失败、unknown 均不自动退款；新授权仍受相同业务键永久 CREATE fence 保护。

Token HTTP 也是外部 IO：须在 admission 后、live 材料/期限复核后才可发生；首版不增加任何 token 交换或表单写入的自动重试，原受界并发 token client 不因接入 Automation 变成无界刷新器。实现必须证明令牌调用/缓存等待和表单调用都服从同一剩余期限、取消与开关。

## 5. 接线裁决：共享执行机制，人工与委托能力硬分离

### 5.1 不可采用的快捷方式

- 不调用 `ownerRuntime.submit({ actorId: owner })` 模拟登录；不修改原 owner port/runner 的相等守卫使任意 service 通过。
- 不把 095 人工 grant 表的 maxAttempts 改大、更新不可变快照或共享人工 WeakMap permit。
- 不让插件、规则 JSON、跨插件通信 API、webhook 或普通 `send_webhook` 动作直接拿到私有材料/fetch/授权构造器。
- 不新增 scheduler、通用连接器写 runtime 或第二套宜搭 HTTP sender。

### 5.2 推荐结构（拟实施，不是现状）

```text
owner 的显式委托确认 → core 持久授权/撤销事实
既有触发器 → durable outbox/request → 私有具名 consumer
    → core 委托 authority（live owner/规则/材料/预算/期限/fence）
    → 原子 child admission + 既有单行 ledger/fence
    → 本次不可序列化的一次性执行 handle
    → 共享宜搭执行内核 → 既有 token/transport/逐行账本
    → values-free 运行状态与逐行回执
```

现有 runner 也限定 owner，所以必须先把其实现抽为**未导出的共享内核**，再保留两个硬分离入口：原人工工厂继续执行原 owner 守卫；拟新增私有委托工厂只接受 core 当前 activation 创建、实例闭包 WeakMap 登记的一次性 handle。不得向普通导出 runner 增加可自报的 `runAs: service`、`skipOwnerCheck` 或默认回退。

委托 handle 绑定 grant、child admission、真实 service principal、worker fence、payload/材料指纹及截止时间。取出即消耗；不能用 JSON、Symbol 反射复制、旧对象或重放 DB 行恢复。材料 reader 保留 owner 的资源作用域，由新 core authority 证明委托；不能把“为 owner 读取材料”混写成“actor 就是 owner”。claim_actor_id 记录真实受管执行者，授权关系另有 durable 引用。

新句柄与共享内核的接线是保证型变更：若实施时不能保留人工负例或不能证明私有入口不可旁路，应停止并修订本决策，而不是改测试接受任意 actor。只复用已有 read outbox/dispatcher 的事务/租约机制，不把 ReadCheckpoint、只读 grant 或 integration_read_preview 当发送能力。

### 5.3 GOV-08 记录的新增面（方案 A 已获本地实施批准）

- 四个**拟新增**操作，采用下面独立子路由；不复用/改义人工 `/approvals`、`/submissions`，不把自动发送塞进既有只读路由。
- 一个私有具名动作 `integration_yida_send_authorized`（拟名）：只能绑定 grantRef 和受管 occurrence；普通 live/simulate executor 仍拒绝，授权创建绝不藏在 rule-save 或 run 中。
- plugin-integration-core 的一个受管私有委托能力消费者；仅该插件在真实 activation 注册，deactivate/stop 立即作废。其它插件、通信 API 和匿名 webhook 不获得能力。
- 授权事实、撤销、admission/预算与 reconciliation observation 的持久化；新迁移编号实施时以实际 main 分配，不能复用本草案举例编号。

| 拟定端点 | 输入与行为边界 |
| --- | --- |
| `POST /api/integration/yida-automation-authorizations` | owner JWT、唯一 confirmationId、规则/动作版本引用、已存在的计划与枚举行引用、允许触发种类、显式次数/TTL；core 核验当前材料并生成 grant。相同确认标识+相同合同返回原历史，合同不同报冲突；不能重新延长期限或补次数。输入不接受 actor/tenant/fetch/任意URL/凭据/执行许可 |
| `GET /api/integration/yida-automation-authorizations/:grantId` | live owner 权限下读取脱敏范围/预算/期限/撤销及请求终态；不返回快照、token、permit 或私有材料；授权过期不等于历史可公开 |
| `POST /api/integration/yida-automation-authorizations/:grantId/revoke` | live owner 显式撤销；重复撤销幂等；自动闸关闭仍可调用；只持久化撤销与取消通知，不做远端调用 |
| `POST /api/integration/yida-automation-authorizations/:grantId/requests` | live owner 只提交稳定 requestKey；仅在允许 manual 时受理，row 由 grant 内固定顺序预留；202 表示 durable 入队，不表示已发送。过期/撤销/无剩余行或次数拒绝。重放原请求只返回历史，不发新 permit |

上述方案 A 已获本地实施与合成验收批准，但这些端点尚未全部实现，且未获发布或真实调用授权；服务端对所有未知字段 fail closed。管理动作与 worker action 的副作用分开：创建授权/查询/撤销/受理端点绝不交换 token 或发送表单；只允许经已获准的私有 worker 后续执行。运行详情复用已有 owner-scoped 展示，若实现发现必须新增其它端点/权限/消费者，先更新独立决策，不能以“补接口”为由扩范围。

不扩大 JWT 例外、mst allowlist、全局权限默认或 Bridge transport。Bridge 继续 plugin Resolver 分派；K3 永久禁止写回；本动作不新增任何源读取或 K3/PLM 写请求。

本地实现对真实既有规则格式的具体化：rule JSON只保存稳定 `authorizationSlot`，grantRef绑定在私有持久activation/request中，而不是每次批准后改rule JSON（否则实际规则nonce变化会立即使刚批准的grant失效）。沿用现有 null/`legacy` execution_mode，拒绝 `workflow_job_v1`；支持原top-level单动作或与之完全相同的一项modern actions列表，不另造`sequential`执行模式，也不接受隐藏后继、分支或额外动作。首版仅空条件的专用interval规则；条件/record条件读取不顺带引入。宿主提供受管base/sheet/project字段角色绑定，不能从body或base/workspace反推tenant。这只是方案A内的具体合同，不是新增全局模式/调度器；实际注册与生产来源绑定仍待后续接线验证。

## 6. 事务、领取与发网前重验

1. 授权创建：真实 JWT、live tenant/member/管理权限、所有权与批准材料核验；显式确认 finite rows/digests/预算/期限；immutable 授权事实与审计同事务提交，不做外部 IO。
2. 受理：同一授权、规则版本/动作槽位和 canonical occurrence 唯一请求；请求与 outbox 同事务。重复受理只返回原 request，不增加计数。触发深度/来源限制沿用既有规则。
3. worker claim：取得既有 durable lease/fence，在 core 根据持久授权恢复 trusted 身份，不信任 outbox payload 中自报 owner。
4. admission：以确定锁序重验 live grantor、撤销 generation、规则/源/目标/凭据代次、快照、DB 期限、额度及行 fence；授权计数、child admission、ledger prepare/CREATE fence 和审计原子提交。未提交不得出网、不得产生 permit。
5. token 与表单前分别复核当前授权、live 材料、remaining deadline、active generation、lease/fence 与 exact-literal 开关；已发现撤销/过期必须拒绝。不可跨异步加载复用旧验证结论。
6. 只有已知提交的 admission 才 mint 本次 handle；重复投递/进程重启/admission COMMIT 回执丢失仅能查历史，不能再 mint。stale worker 不能 ACK/变更 ledger 或新取 handle。

入队时保留行/容量只是防止队列超额，不是消耗发送次数；admission 才消费。对账必须分别展示 reserved/consumed/blocked/unknown，不能将“未消费”直接计算为可用：已预留但阻断的行仍不可自动分配给第二请求。最坏情况少发也不越界多发；重新规划要重新批准，并继续受原 CREATE fence 限制。

外部 HTTP 无法参与本地 DB 事务：**不承诺撤销提交与已进入内核/socket 的请求原子互斥**。不要持有无限期 DB 锁等待远端。最后一次验证到网络调用间的竞态必须进入撤销/unknown 语义，而不是声称“撤销后远端绝不会生效”。lease 过期仅禁止新执行与旧 ACK，不证明旧进程已停止发网；已 admission 的 child 不因租约过期被第二 worker 重新执行。

## 7. 撤销、取消、停机与时钟

| 发生阶段 | 必须行为 | 明确不能承诺 |
| --- | --- | --- |
| 未 admission | durable 撤销/取消；后续领取与恢复拒绝；无 token/form IO | 仅删 UI 按钮不能代替服务端撤销 |
| 已 admission、尚未 form dispatch | 向本机 active handle 传播原生 AbortSignal；后续 checkpoint 拒绝；能证明未 dispatch 的 prepared 才可按原状态机转 not_sent | abort 返回不等于远端撤销；token 若已交换须记录发生过外部 IO |
| dispatching/网络响应丢失 | 不再发请求、不退款；保留 outcome_unknown 或 state_unconfirmed，等待对账 | 不返回“取消成功，未写入” |
| ACK 已知持久提交 | 保留 acknowledged 与回执；追加撤销影响后续行为的事实 | 不倒改已发生的发送，也不自动删远端记录 |
| plugin deactivate/host.stop | 作废 activation、取消 active handles、等待实际 drain；独立记录 stop 成败与未决数量 | 停 worker 不代表撤销远端，也不能拿业务失败代替 stop 失败 |

授权撤销必须 durable、幂等，返回“已记录撤销/未开始数/在途或未知数”等脱敏计数，不对未联系到的其它进程虚报即时停止。权限/成员/owner/目标/凭据/规则变化导致同样的执行拒绝，但保留原事实供追溯。

DB 负责期限与预算判定；进程单调时钟限制剩余执行时长，保留现有 wall-clock 回拨 fail-closed 检查。实现还须持久化授权时间水位并比较当前 activation 的单调经过时间：检测到不一致就拒绝，不能只对比一个已经回退的 DB 时间。首版 grant 绑定当前 host/plugin activation；重启或重新激活使未执行授权失效，不恢复跨重启发送资格，持久请求只保留历史/阻断或未知终态。不能声称持久时间水位本身证明离线期间经过了多久；要恢复后台跨重启授权必须另证可靠时间边界并修订本决策。已过期授权不以续期修复，不能停时间服务、调系统时钟或增大预算来获得通过。

## 8. 未知结果、幂等和对账

沿用原逐行状态：prepared、dispatching、acknowledged、outcome_unknown、not_sent；持久状态不能确认时公共投影为 state_unconfirmed/durable=false。自动任务完成只表示执行生命周期结束，不等于行发送成功；有任何 unknown/state_unconfirmed 时整体不得显示全成功。

- 稳定请求身份、一次 admission 和永久 CREATE fence 只保证本地不重复执行；没有真实远端幂等保证时不宣称 exactly-once。
- token 失败发生在 claim 前，可能仍是 prepared；已 admission 但进程崩溃后留下 prepared 也不能重发。不能只看 prepared 推断从未出网或退次数，须同时检查 admission 和 dispatch 证据。
- 发送超时、断线、无效回执、取消后晚返回、ACK COMMIT 不明、旧 worker 晚 ACK 均按原状态机保守处理，不进入通用自动 retry。
- 090 的 unknown 是受约束终态，**不 UPDATE 成 acknowledged/prepared**。拟新增 append-only reconciliation observation，引用原 ledger/admission/授权，记录证据摘要、核验者、观察时间与“远端已观察/未决/冲突”等结论；不释放 CREATE fence、不发新 permit。
- 已有 `yida-readback-observation.mjs:105` 的比较器只是数据比较，不等于已执行远端读取。真实远端查证、token 交换或导入客户材料仍要独立 owner 授权；实现验收只用合成返回或本地假服务。
- 查询暂时查不到、业务键本地唯一或 HTTP 2xx 都不足以允许重新 CREATE。确认远端存在也不能凭比较器改写历史发送回执；界面分开展示原发送事实与后续核验事实。

审计只记录批准/撤销/admit/claim/terminal/reconcile 的固定枚举、计数、内部授权引用与摘要。私有账本身份只在授权视图内展示；公开 CI/PR/文档 values-free，不输出业务行、地址、token、材料或响应原文。

## 9. 持久化与开关（仅拟定）

拟新增有限委托授权/撤销事实、child admission/预算事实、对账 observation，引用既有 ledger 与 CREATE fence；**不是第二套发送账本**。要求 unique(授权, occurrence)、unique(授权, 批准行)、同授权受控串行化、全程 tenant/owner/scope 约束与 RESTRICT 生命周期保护。具体表名、索引和迁移 SQL 留给批准后的实现设计，不现在执行 DDL。

拟新增独立 `INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED`，默认 OFF，仅精确字符串 `'true'` 生效、danger=high、实施时登记 manifest。它只是代码闸，不是执行授权。旧 OWNER_SEND 开关保持人工含义，互不隐式开启；不能把其 manifest 中“不含 Automation”改成全局可写。两个入口的 enablement 必须由可信 host 注入，不能来自请求、规则或数据库业务字段。

新自动开关关闭时不得新 token/form IO；授权观察与撤销须继续可用且不做远端读取。读操作和静态预演保持零网络/零发送，不因新开关打开获得执行能力。

## 10. 实施前退出条件与可变异验收矩阵

必须先证明用例命中真实 JWT → core authority → 实际 transaction/ledger → 私有能力 → 真实 token/transport 生产路径；只替换客户网络边界和合成材料，不能替换被证明的授权守卫。以下是**未来验收要求，本轮未执行**。

| 保证 | 必须有的正/负例 | 单点降级变异应致红 |
| --- | --- | --- |
| 人工/自动分离 | 原人工单次正例及 service≠owner 拒绝不变；合法自动委托记录真实 service 身份 | 删除私有自动 handle 身份验证；伪造 actor=owner |
| tenant/owner/live 权限 | 真实 JWT 跨 tenant/workspace、header 自报、非 owner admin、grantor 权限/成员撤销、规则 owner 变化；合法同 owner 控制 | 删除其中一条检查；负例其它条件均合法，防止另一守卫兜底假绿 |
| 有限范围 | 固定批准行成功；新行/新项目/新版本/凭据轮换/ABA/目标或映射变化在 IO 前拒绝 | 去掉 payload 或材料代次比对 |
| 原子预算 | 并发相同及不同 occurrence、最后一份额度竞争、rollback、COMMIT 回执丢失、重启；真实 PG 观测计数与 admission/fence | 把计数移出事务、先 mint permit 后 COMMIT |
| 有限期限 | DB 边界、执行中到期、排队到期、回拨/前跳/重启后水位；不放宽原预算 | 只在 enqueue 校验期限；回拨重启重新放行 |
| 不重放 CREATE | outbox 重投、lease 过期、worker 崩溃、旧 worker 晚 ACK、未知后新 operationId | 为 orphan prepared 重 mint handle 或重置 CREATE fence |
| 撤销/停止 | revoke 与 admission/token/form/ACK 分阶段竞态，保持连接的真实浏览器，独立 actual-stop 及临时 PG/交接清理 | 取消只影响 UI；漏传 AbortSignal；吞 stop 失败 |
| 结果不假绿 | 无效 2xx、断流、ACK 提交不明、对账只追加、不退款；unknown 不显示完成成功 | 将 unknown 当可重试、用请求 finished 代替 body done |
| 零网络默认 | 自动 OFF、人工 ON/自动 OFF、静态预演、只读 action、缺 grant；分别断言 token/form 次数 0 | 将旧人工开关当自动授权；普通 executor 接受私有 action |
| 证据与隔离 | values-free 投影、私有回执不泄露，合成环境非 root/隔离 PG/TTL/停止 | 把 snapshot/token 暴露到 DTO、日志或 capability |

保留现有 PLM manual/interval、宜搭71及父70的合同，不靠增删计数掩盖行为变化；如果新增自动业务验收，需要另外明确新增合同，不能继续称“旧71已经覆盖”。provenance 以模块实际清单和最终 LF 字节为准，不机械复制旧 pin。保证型实现必须有独立反驳、明确仍抓不到的变异；本文的作者自查不冒充独立审查。

已知不能仅用合成测试证明：真实宜搭远端幂等与最终一致性、真实客户字段/有效期合同、实际生产网络与代理行为、所有宿主时钟稳定性。各项须保留为交付前置或残余风险，不能用 CI 绿灯代签。

## 11. 实施次序、回滚与交付口径

Owner 已接受方案 A 并授权本地实施，按以下依赖推进；推送/正式 CI/合并/部署/真实调用仍未获准：

1. core 委托 authority、持久预算/撤销与并发 PG 负例；无外部 IO。
2. 共享 runner 内核与两入口隔离、scope/actor/fence 证据；原人工不回归；不注册可达动作。
3. 既有 outbox/dispatcher 私有具名接线、默认 OFF 开关和合成 token/form 边界；撤销/unknown/stop 全链。
4. owner 管理与原运行详情展示；独立反驳、变异、provenance、合成浏览器/完整 CI；新 head/base 逐项冻结。

这些是同一 SA-06D 的实现顺序，不是已获准的四个新 PR。GOV-08 要求决策与代码独立 PR；本地完成文档不等于可以开文档 PR。后续提交/推送/CI/合并/部署/真实 token 或发送均另行授权，不利用 T 层默认前进替代 O 层决策。

部署必须先备份并确认迁移/加密材料，再迁移后代码；旧 binary 对新状态/表的兼容须先证明。回滚首先关闭新自动闸、撤销/停用 activation 并实际 drain；保留授权、预算、admission、ledger、CREATE fence 和对账证据，不删表清零或退款。是否回退 binary 由迁移兼容与未决执行情况决定，不能笼统承诺一键回滚。任何在途请求仍可能远端生效。

**可交付判定分层**：

- 本轮：本地 GOV-08 草案及源码依据检查完成；不改变完整目标状态为“已完成”。
- 合成能力交付：批准后的实现、真实路径合成/并发/变异/独立审查、同 head CI、实际 stop/清理都齐备，才能称“自动发送机制合成验收通过”。
- 生产试用：先有合并/部署与真实调用独立授权、真实目标和材料核验、明确一次性试用范围及未知对账责任；没有这些不能给生产交付日期，也不能真实发送。

## 12. 初稿文档核验记录（不替代后续实施证据）

- 已读并对照：现有 owner 路由、approval service、owner runtime/port/factory、runner/store、095/090 迁移、Automation live authority/ledger/recovery、开关 manifest 和 GOV-08 模板。
- 所有新路径/动作/表/开关均标为拟定；没有假称现有 worker 可以直接复用 owner actor、unknown 可以直接变成功或既有71覆盖自动发送。
- 只检查 Markdown、路径/行号和代码版本关联；本轮不运行产品测试、迁移、浏览器、外部请求或 CI，不声称有新的合成/变异/独立审查结果。
- 这份文档仅在本地；未调整原目标 MD、已有四支 PR、远端 refs 或原八个工作区改动。
