# 既有 #6337 收口验证

## 2026-10-18 本轮授权已收到，进入普通追加发布与正式验证

Owner明确允许将本轮已验证修复更新至既有四PR并运行既有合成CI。下文三回合等待授权是历史状态，当前授权前置已解除；保留全部原失败，不标目标完成。发布前重新核对四head/base/draft和main均未变化，本地八项已知改动保留。按原依赖普通追加，不强推、不新增切片、不合并、不部署、不读客户数据、不真实发送。父支完整树和新子head正式71项、停止清理仍以本次后续CI为准；默认完整前端脚本两次失败不因本地资源对照通过而删除。

## 2026-10-18 发布授权前置第3回合：目标受阻，不是完成或主动暂停

第三个连续回合仍只有自动goal续推进，没有owner对本轮新补丁发布的明确批准。只读GitHub回读四PR均OPEN、head/base/draft仍为已记录状态，尚无远端新补丁或可继续验证的新head CI；本地八个已知跟踪改动保留，diff-check通过。上一回合属于授权前置的无进展复核，不将重复哈希/文档更新包装为持续开发。本轮已知安全独立修复、三原入口、后验和本次CI跟踪均取得终态；不重复发起测试或扩新切片绕过授权。

按三回合阻塞审计，将原完整目标标记blocked，原因仅为等待“普通更新现有#6315/#6323/#6324/#6337并运行既有合成CI”的新一轮授权。未标complete/paused，未缩小六批目标，未合并/部署/客户读取/真实发送。恢复时先重核远端head/main及本地原字节，再依据明确授权推进；此前本地通过及默认批次失败范围、父树完整CI未证、子head正式71与停止证据缺口全部保留。

## 2026-10-18 新一轮发布授权前置复核（连续第2回合）

自动goal续推进不是human发布批准。上一回合完成当前三原入口与后验后请求新补丁更新四PR/既有CI授权，本回合仍未收到。重新逐字节核对六源码在Windows/Linux均匹配已通过的协调回执，三入口均实际终结成功，两个父支候选树对象仍存在、默认index未stage、diff-check通过。当前已知本轮安全独立修复/验收已结束，不将旧终结CI或进程冒称活等待，不重复重跑求绿或新开切片。目标仍不标complete；继续的最小前置仍是owner明确允许这轮既有四PR普通更新及既有合成CI，缺批准则不执行。保留默认批次失败和父树完整CI未证范围。

## 2026-10-18 当前本地六文件修复链路已终结，尚未授权发布新补丁

36345已自然exit0，三原入口均exit0/signal=null；最终协调回执位于本次新建/home/runner/metasheet-stack-acceptance-SQpgQU，SHA **7d5ba3cf64706d5009ba27b857fc2b1f00a5dc3022d8df008edea2cefc12d637**，schema=local-stack-full-acceptance/v2，baseHead5de0484+精确六overlay、sourceOverlayUnchanged=true、固定官方浏览器SHA43624de7…均实际通过。该目录是本次外层执行直接创建并写wx/0600，不是从旧候选拿来的回执；先前相同公共stdout哈希本身不证明来源，以本次实际spawn/终态/源码前后校验和协调回执绑定为据。

当前宜搭自产stdout重新按闭合YIDA_BROWSER_CI_RESULT解析，**passed=true/tests71/business66/sentinels5**；其原字节SHA **77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336** 与协调记录一致，stderr空。原reportOuterResult已在本次报告成功前验证owner/source哈希、71项passed及cleanup=stopped-owned-pg-removed；此处未读取私有CI产物，也不编造没有公开的额外PG路径/账号内容。最初PowerShell把Properties.Count枚举为六个1，只是投影问题；随后将属性名物化为数组，实际overlayFiles=6，不改原回执或业务执行。

本地当前候选证据汇总：UUID及三面板四整文件470/470；三core整文件98/98；保持最终526 token/原单例预算的2-worker最终大批次599文件/13857测试全通过；manual/interval各9阶段及6736项源码后验、ABORTED0、actual-stop-resolved与production-stop-verified各1/失败0/自有PG移除；当前宜搭71通过并由原CLI校验清理；sealed provenance原整文件exit0。两次默认31候选上限的完整前端批次失败仍保留，2-worker结果仅为完整最终批次的资源对照，不替代原默认整脚本或正式CI。未宣称旧250ms租约/WSL回拨/SQL/版本失败的唯一根因均已解决。

另已把#6315的UUID修复准备为准确69a55ce7父树上的两文件本地候选 **472de4272dc90608b5686860972a02ad3edc17b1**（35新增/2删除）；tmp/pr6315-uuid-local-fix.patch SHA **bd38c6d7511a1fbace7783157c21ab4f55d1e995f0c947ded361e276b41058c3**。只应用本次两条新回归，不把子支已有25行流式上限测试混带到父支。初次提取因Git CRLF警告在diff前而被工具fail-closed拒绝，未落候选；随后仅对该条diff命令禁用autocrlf输出干扰，不改Git全局设置，验证两个文件scope后以私有index cached apply --check/apply建树。#6324九行fixture候选树d67ba001…不变。默认index无stage，无提交/分支refs/强推或远端写。

main再次只读确认仍d671019f2。此轮新补丁尚未获准更新四个远端head/启动新CI，不把此前“发布已验证对齐结果”的单轮授权自动扩为后续补丁权限；本地安全独立复验已完成，可请求最窄新授权：只普通追加更新既有四PR及既有合成CI，保留所有失败，不合并/部署/客户读取/真实发送。完整六批目标不标complete，父支准确树完整CI及新子head正式71/停止证据仍有待取得。

## 2026-10-18 当前补丁interval已通过，宜搭71仍在跑

同一36345进程的interval已自然exit0、signal=null；原receipt SHA **416efc651c2059edc91d4b85add0573b235ead789022e197e01bd0611553afce**，stdout SHA **4cad7586fdd0dee63654396053b85b20314b015c1211ebed56097aada794b9c9**，stderr空。对准确该回执重复原六组生产验证、9阶段exit0/无超时、6736项源码原字节后验，全部通过。132个diagnostic帧ABORT/ABORTED/signalAborted0，独立actual-stop-resolved=1、production-stop-verified=1，两类停止失败0，自有PG移除成功。

interval没有manual的automationRequests POST202，故三个bodyLegs针对该特定POST202筛选各0，不误报为“interval丢body”；interval自然调度/读取/浏览器观察以原validateAutomationEvidence(interval)的完整合同通过为据，不把manual三条BODY_DONE强加到不同场景。当前原YiDa browser CI入口已STARTED，71项/清理尚未终结。另在隔离原环境执行sealed-export-package-provenance.test.cjs整文件exit0/OK，没有重算或修改任何pin。

## 2026-10-18 当前补丁manual：POST202完整body与实际停止已后验（仅本地）

限定选择原receipt SHA09624d6a…，不遍历后把旧候选回执冒充新候选；对该回执6736个sourceInputs逐项重算当前原字节长度/SHA，均匹配，无.env路径或越界读取。实际9阶段均exit0/timedOut=false，customerIO/externalSend=false。再次调用原validateProductionStopEvidence、K3、YiDa、OwnerOff、Initialization及manual Automation验证函数，全部通过。

204个闭合browser-transport-diagnostic中ABORT/ABORTED或signalAborted事件0；针对automationRequests POST202，SDK BODY_DONE+complete、PROXY UPSTREAM_COMPLETE+complete、PLAYWRIGHT BODY_DONE+complete各**1**。不是拿REQUEST_FINISHED/status0当body证明；本地后验对manual另断言三条完整body各1，未修改原生产判定。独立actual-stop-resolved=1、actual-stop-failed=0、production-stop-verified=1、production-stop-failed=0，cleanup=stopped-and-owned-database-removed。此为当前六文件overlay的真实原CLI与原回执证据，不签远端69140b head的skipped，也不据此将旧ABORTED唯一归因为某浏览器版本。

同一36345进程的interval仍待终态，之后才是原宜搭71；没有重新启动manual或新Chrome交互。#6324父fixture的本地候选树和尚未推送的UUID/排序修复继续保留，未新增切片或外部动作。

## 2026-10-18 四run全部终结：父支70项，不是子支71项；仅停用本次CI监视

全分页准确head复核终态：#6315 Plugin run39109296702 success（但同head另web-tests仍failure，不是该PR全绿）；#6323 run39109370449 success；#6324 run39109374898 failure；#6337 run39109378982 failure。前两支的checkpoint/默认Chromium/锁协议/宜搭步骤/后置SQL/晚期attendance均success。后二者前置core失败后所有目标后续为skipped；#6337的固定候选/PLM manual/interval/71/实际host.stop证明本轮均未执行。未以其它泳道或父支结果消除子支发布阻断。

已限定读取前两支公开完成job日志，仅投影owner YiDa步骤的最终结果帧：两支各1帧passed=true/**tests70/business65/sentinels5**，并非71漏跑或71通过。准确父head的原CLI源码本来就强制receipt.tests=70，且在报告passed前验证owner/source哈希、terminal与cleanup=stopped-owned-pg-removed；没有读取私有CI产物，清理结论属于公开帧加冻结生产报告合同支持的证明，不冒称直接看了private receipt或PLM stop帧。#6315公开job日志SHA **f39f566b907a46743b6c24c46762c678b661a666bee8f95e153b7f29ad42a74a**；#6323 SHA **7c3bb227a40d0c16e61fee670bb49aea84fe85e225697258443d315b33212e36**。收集器内部YIDA_71只是统一步骤标签，不是数量事实，数量以实际帧/准确源码为准；此前只签步骤success、待核计数的记录不追改为71。

按该监视原授权“所有run终结、报告并停用”，通过应用automation_update更新既有6337-ci为PAUSED，保留完整prompt/name/目标chat/10分钟rrule；工具返回status=PAUSED并由本机配置回读确认。只是本次已终结CI提醒停用，未调用goal pause/complete，也未停止本地验收。使用OpenAI Docs核对[Scheduled tasks管理入口](https://learn.chatgpt.com/docs/automations?surface=app)；页面未提供heartbeat更新schema，不把它当本机API字段证据，具体更新以工具/配置回读为准。没有新监视或重复发起Chrome试用。

当前六文件本地候选的三原入口复验36345继续：manual已自然exit0、原result=passed、9阶段报告合同下sourceFiles6736、cleanup=stopped-and-owned-database-removed，原receipt SHA **09624d6afc7171f7238a8c515ab4d2675bad4cefd2a2133ef8f15a7ae9224f0f**、stdout SHA **b81666127169d2fd972f3a809a945833e4a232d6961d0b2875774205beef3955**，stderr空。wrapper通用frame.passed=false是PLM不用该字段的投影（PLM用result字符串），不能误报失败；result/exit0/cleanup如实保留。interval已STARTED，宜搭71尚未启动，具体ABORTED计数和独立stop帧待原receipt后验，不移用旧候选。无新推送/CI重跑/合并/部署/客户读取/真实发送。

## 2026-10-18 当前六文件补丁：全量最终批次资源对照完成，三原入口复验已启动

2-worker诊断50716已自然exit0、signal=null、timedOut=false，原JSON实证**599文件全部通过、13857测试全部通过，failed/pending0**；七个原失败文件全部在本批次，亦包含K3面板138、Automation面板297、宜搭面板27及UUID8。526个原最终invocation token未删减，JSON numTotalTestSuites不用于文件计数。原JSON `tmp/web-final-batch-two-workers-20261018.json` SHA **0a85741a0e3741683fe8e13c4b62e1dd7e6d87edd2aa61166cf50b7023d476eb**；stdout SHA **bd1ecfd5b23d98730aaaeb31dbc17deef3e8e97447c1d332fe87d3a05d5f1bcf**，stderr空。过程观察器未发现完整argv marker时未误判停止；随后原执行句柄实际exit0与报告终态互相印证。

该成功支持本机执行条件/并发资源敏感，不等于唯一CPU根因：缓存和执行时序也可能变化，且两个token交换只是集合等价排序修复。两次默认完整脚本失败继续保留；没有把前19批和本次最终批次拼成“原默认完整脚本已通过”，未改仓库并发/原测试超时/业务代码来遮掩。无第三次原样完整脚本或新的CI重跑。

为不给修复后的运行时代码借旧5de证明，已启动原公开PLM full-app manual→interval→owner YiDa browser CI三入口逐段复验（观察句柄36345，当前plm-manual STARTED，后两段尚未执行）。Linux实际基底仍5de0484，跟踪差异精确六文件：三面板、宜搭spec、web脚本及tokens。Windows/Linux六项原字节SHA逐项相等；新增两项脚本SHA分别 **7993fe95aaba7592de3dc2f3590c45ea95a4806b23cdbbe95323d1b515654093**、**1a27a472b3cb2e2f1db9a5e4d9da8be6203eafdbecd45179a48e3aaef1864fd3**，其余四项见下节。AuthService fixture已finally恢复，未混入额外修改。

本地外层wrapper只记录baseHead+六份overlayHashes，不把未提交补丁冒称5de原树；执行前后/每段前后均验证固定基底、空暂存index、恰好六个跟踪差异及原字节哈希。复用已存在官方候选时仍验证固定SHA43624de7…，绝不覆盖或开放任意executable；原公共CLI/参数/判定/停止/.env与出网守卫不变。只使用新自产PG与合成材料，环境白名单和真实发送OFF不变。当前仅签“已实际启动”，尚未签manual/interval/71或停止清理通过；当前六文件新候选正式CI仍待另行授权，不自动提交/推送。

## 2026-10-18 08:34Z 当前收尾状态（仅本地，不替代历史失败）

#6324父支fixture已准备为真正基于其准确7cd868b树的本地候选，而非只有回补计划：独立临时GIT_INDEX_FILE执行read-tree、cached apply --check/apply、write-tree，候选树 **d67ba001f3031b70a3c32ccc2366d19502f2e944** 相对父支恰好1文件9新增行。patch仅tmp/pr6324-existing-legacy-fixture-backport.patch，SHA **659719026304dca898d7a6c4486236daf304d8ade7ef0432f1b5d48635363f64**；该AuthService测试blob与现有#6337中已测版本完全相同。finally恢复原GIT_INDEX_FILE，默认index无stage，未修改branch refs、生成提交或推送。仍未把“cached patch可应用/测试blob一致”称为父支完整宿主已测通过；原fixture去除/恢复因果证据及后续准确父树复验要求不变。

四PR准确head再次匹配。#6315的checkpoint、默认Chromium、锁协议和owner YiDa正式步骤已success，正执行后置multitable SQL；此处只有步骤状态，待公开日志闭合71计数及清理，不预签全部run。#6323的checkpoint/默认Chromium/锁协议已success，owner YiDa步骤in_progress。#6324/#6337已失败，后续PLM/宜搭及停止证明为skipped，不能借前两支的绿灯替代。#6315的web UUID失败仍是远端阻断；本地补丁未推送。

前端第二轮六个超时帧通过已有七文件JSON中的测试元数据重建标题，再逐一SHA精确比对，6/6匹配到源码：approval-center:545、approval-detail-record-table:447、multitable-automation-manager:2769/2825、multitable-automation-rule-editor:1057/1337。初版未忽略Vitest空ancestor而0匹配；修正后只是证据映射成功，未重新执行业务。没有把固定微任务/20ms等待直接判为根因；其中各例涵盖真实组件挂载/选择器/模拟客户端，而不是全为静态文本扫描。

本机Linux实际Node20.20.2，logicalCpus=availableParallelism=32、内存约30GiB；亲读已安装Vitest1.6.1的默认非watch threadsCount=numCpus-1，说明未限流时的候选上限为31，不冒称已测到每时每刻31个活worker。原vite测试配置不指定池或worker上限。已从该版本依赖代码确认VITEST_MAX/MIN_THREADS及MAX/MIN_FORKS受支持。

基于此新证据，只针对原失败最终批次启动资源对照（观察句柄50716，尚未终态）：通过原parser提取全部526个token，原脚本最终同一匹配集合不删项，清空环境、user/net隔离、同源码/原配置/原单例超时不变，仅本次进程设置两类pool max=2/min=1，原JSON reporter记录到tmp/web-final-batch-two-workers-20261018.json；不改仓库或全局默认，不创建产品开关，不把这次诊断当原默认完整脚本通过。此前19批两次均通过但不拼接为这次完整脚本的新通过证据。若对照变绿，只说明资源参数/执行条件相关，不能凭一次绿灯解释或抹除两次默认批次失败。暂不再原样第三次完整脚本，不改审批/多维表业务；新候选完整PLM/YiDa和新head正式CI仍未签完成。

## 2026-10-18 本轮正式CI失败定位与最小本地收敛

准确新head的#6324 run39109374898、#6337 run39109378982均已failure；#6315 job117621755664随后实际进入owner YiDa JWT HTTP/browser步骤，#6323 job117621978915进入external-system delete/pointer-write锁协议真实库步骤，后二者尚未终态。#6324/#6337的checkpoint、锁协议、PLM、宜搭71及后置SQL均skipped，本轮没有ABORTED或实际host.stop新证明。#6315另web-tests失败仍保留。

只读公开失败日志：#6324 SHA **2518862210158b5037045cb43b60e4fd6f120acd6b6572924cd8122f33d8878e**，1失败文件/1168通过/172 skipped，4失败测试/21606通过/1755 skipped，实际失败均AuthService.test.ts（公开日志有重试重复帧，不按12个FAIL帧算12项）。#6337日志SHA **2d50e64956576bbee3b9b1f65dc44b89b42859f4bc1c969da68b39bf363763d6**，2失败文件/1204通过/172 skipped，3失败测试/23804通过/1755 skipped，定位required-web-lane-registration-shape与required-web-lane-token-manifest-guard两整文件。collector全日志负例词不作为cleanup根因。

#6337局部真实复现：三原core整文件（含AuthService）95/98，三失败与正式CI类别相同，JSON SHA **6a31e448342a41ff0bb980a42feff7553195d9ddaca19fc9c9526af06f1f7641**。根因是exec块与tokens manifest均把automationRead放到builtinCatalogPresentation之后；真实ASCII大小写无关排序的首断点分别141/189。生成器默认check只比集合，故它629=629的成功不能证明顺序守卫通过；没有token丢失。待完整前端92891终结后，才在两源码副本各调整脚本一对相邻行，并运行原manifest --write（格式生成命令）；没有在活验收中改源码。diff仅两文件各交换同一对行，629项/20 invocation与原flags不变。修后原三整文件**98/98**、failed/pending0，JSON SHA **9da3f70b1e7ae025ff6f38af3b89d4a43e87dbd2067db8ed9f531e01cf2545c7**，未削弱守卫/变异自证。

#6324的AuthService四红并非#6337已绿即可自动覆盖：Git差异证明子支已有9行显式legacy fixture的stockPreparationReadPlanStore接线，父支没有。只在隔离Linux测试副本移除该fixture作变异，原35项AuthService变成31通过/4失败，JSON SHA **27fc3c1ee130fce37acd51bdafa9c190beb67a884c7e05784543a129b8916dac**；finally恢复后原文件exit0。fixture仍精确断言tenant/workspace/action/system且只返回null，不放宽缺runtime时fail-closed，不造已激活读计划。此为当前宿主上的fixture因果对照，不冒称冻结父支全树验收；后续授权更新父链时须将这份已存在的fixture前移到#6324并在其准确树重验，不能只修子支。

另通过#6337准确job元数据确认Start Postgres和Create isolated attendance timezone database均skipped，而always的Remove isolated attendance timezone database为failure。它是前序失败后仍执行的考勤库清理步骤，不是PLM host.stop失败；未读取私有产物或用全日志的预期DB负例猜具体报错，未额外改workflow来遮掩失败。上述所有本地补丁未提交/推送，不自动重跑CI，无合并/部署/真实IO。

本地完整前端第二轮92891也自然exit1、无超时保护触发：前19批报告仍通过，最终595文件通过/4失败，13851测试通过/6失败；六个实际FAIL诊断均Test timed out，来自approval-center、approval-detail-record-table、multitable-automation-manager及multitable-automation-rule-editor。stdout SHA **9966d526ae719e03b3d73c639a5ecffb112c19105e576e189dc10a0e98543450**，stderr SHA **025ca4f111c3a29b17dd3948392acb1f00c8e615a801e39df2f0dc656902d7a3**。仅证明本轮这六处为原测试预算超时，不把第一轮11失败一概归因为此，也不把七文件单独410/410当全量通过。部分用例有固定微任务/20ms等待，只列为待证假设；不修改审批/多维表业务或延长预算，完整前端阻断保留。

## 2026-10-18 08:10Z UUID最小本地修复及真实组件回归

原完整web gate26322现已自然exit1，signal=null、timedOut=false；不是外层600秒超时。前19个分批报告均通过，最后大批次7文件失败/592通过、11测试失败/13846通过；各批次可能重复覆盖，不合计为独立测试数。stdout SHA **cc5d04b9fa9f952891b9a3b97c9f3dac4f6b9739db3c257b858fa06402a4e928**，stderr SHA **e94914e92f572fe5deabb5cb3cd3a7a8af3457d10fec684c2813a74329340dea**。原collector因FAIL行样式未匹配而返回failures=[]，这不等于没有失败；原始stdout仅在内存处理，未保存正文，不能事后声称已读到原具体错误。

七原整文件诊断19688已自然exit0，signal=null、timedOut=false，原JSON逐项证明7文件/410测试全部passed，failed/pending0；JSON numTotalTestSuites=33是describe层级数，不冒称33文件。stdout SHA **07d88648d23ec9d5a00b13b50162e4dfd5bda6c08537657c9d5bb6ee6c7dacd3**、stderr为空；原JSON `tmp/uuid-seven-file-diagnostic-20261018.json` SHA **de00dd3034e90d04d4516e670e5372b30e9e215d656fd2e73f505ded511da8b1**。与全量相同原源码/配置/隔离和环境，仅定位为七文件单独运行未复现；不等于全量已绿、基线无关、根因确定或可豁免。完整批次失败仍阻断，不修改这七个审批/多维表业务模块。

下一步保持原完整脚本再次作批次诊断（句柄92891，尚在运行），不重跑远端CI、不改变源码/测试/筛选/预算，不以再绿删除上轮失败。诊断collector新增同时解析stderr和stdout（此前仅解析stdout），并兼容caret ANSI；只投影固定错误类别、源码位置及哈希。原失败正文已不在内存，不能追认其具体错误必然在哪个流。此次目的为取得完整批次失败上下文，与七文件单独410/410作对照，不将单独绿灯自动判为资源或批次污染根因。

随后在启动任何新测试前读取该次Vitest results.json缓存，精确failed=true七项为approval-detail-record-table、approval-center、multitable-automation-rule-editor、multitable-automation-manager、multitable-workbench-history-field-scope-wiring、multitable-workbench-permission-wiring、multitable-workbench-1672-1673（均apps/web/tests下整文件）。这是缓存提供的失败文件证据，不是原断言堆栈。保持完整失败及其哈希，单独启动这七个原整文件作诊断，原配置/断言/源码不改，无it名称过滤；输出由原Vitest JSON reporter写本次tmp诊断文件，只读取固定错误分类、源码位置与计数，不输出响应/凭据/业务值。当前观察句柄19688尚未终结，不能预判“无关基线”或“只是批次偶发”，也不扩大到修改审批/多维表业务。四文件470/470仍仅是定向证据，完整web gate阻断保留。

后续已启动原always-on前端完整脚本`bash apps/web/scripts/run-required-web-tests.sh`，不是仅四文件或手工缩短token清单。沿同一Linux验收副本运行，独立user/net namespace、清空继承环境，仅保留PATH/CI与npm offline/ignore-scripts；脚本原npx均用本地依赖，不下载包、不连客户系统。当前进程观察句柄26322已多次实际轮询存活，尚无完整终态，**未宣称完整web gate通过**。helper外层上限600秒只作本地进程保护，不改测试原配置或单例预算；输出在内存仅投影逐批计数、固定失败路径和日志哈希。原脚本实际路径来自workflow；初次只读误查scripts/ci路径不存在，不是产品测试失败。远端四Plugin run随后重查仍core-backend tests，无新增失败step，UUID远端原失败保留。

沿既有修复收尾范围，修改三面板六调用复用randomUuid，并在原宜搭UI spec增两项非安全上下文/无安全随机源回归；非新切片，无提交/推送/CI重跑。先在原Linux冻结源码5de0484跑四个原整文件：467通过/1失败（总468），恰是全树tripwire检出六处原生调用；三个组件原功能测试全绿，解释为何之前定向组件绿灯不能证明内网HTTP兼容。

补丁及两新增回归在独立Linux验收副本执行：Automation297、K3面板138、宜搭27、UUID8，四整文件**470/470**，exit0，无skip或放宽断言。恢复变异后完整四文件重验仍470/470。仅宜搭原生两调用恢复的变异导致UI非安全上下文回归+全树tripwire两项失败（33通过/2失败）；只恢复submission原生调用亦使同两项失败，证明用例不是仅依赖approval前段。第二变异先以缺少第4次模拟HTTP触发TypeError致红，随后补明确第4次调用计数断言后重验470/470；不把该诊断改进冒称又执行了一轮变异。两个变异均finally恢复。没有Math.random后备，无安全随机源时无授权POST，原默认OFF/单次确认/结果未知不重发均保留。

最终Windows与实际Linux测试四文件原字节SHA一致（非哈希前换行归一化）：K3面板`28ffb1c4964917ca0cafe6f1bb7ebdb4e11505c6f3c0ceb3ef7f22dda3e90bca`；Automation面板`35818f35761b912d2cf00625d570e307f3ae74134d64ff674c4786ab9208def8`；宜搭面板`99cea90d0a49806011deb39a9c3753e577d0452df925b078e9b85cfb59b43ab2`；宜搭spec`8becc94e6853ed8be985c924feeaa4772ac4a1a4b3d8eb9d34e9fc4de2620c01`。git diff --check通过，仅core.autocrlf未来转换警告，未改Git全局配置。测试为合成fetch组件检查，不冒称客户HTTP实机、真实JWT或新浏览器/71项验收。没有新增独立审查代理或借用旧候选审查结论。

本轮一次CI只读采集临时返回CI_READ_FAILED（stderr仅哈希），不认定run终止或产品失败；随后重查同run成功，四Plugin run实际均in_progress且已到core-backend tests，无失败step。#6315另web-tests真实失败保留，其余新head正式锁协议/PLM/宜搭71/停止清理仍pending，不能用本地470/470回填。本轮曾有一次PowerShell哈希投影空管道语法错误，未执行哈希检查；修正collector后四文件逐个取得上述匹配结果，非产品故障。

## 2026-10-18 08:06Z 新阻断：#6315 web UUID守卫失败（只读定位）

后续goal续推进属于verified wait：再次实际轮询同四run及精确head，均仍in_progress；#6315/#6324已进core-backend tests，#6323/#6337进入type checking，无新增失败step。#6337关键业务及停止步骤依然pending。只读固定Git对象进一步确认原生UUID调用随层累计为#6315两处、#6323三处、#6324三处、#6337六处；其中只有#6315已由实际web gate证明失败，不能宣称其余已跑红。当前跟踪树仅本MD修改，无产品补丁。继续既有只读监视，不因等待启动重复试用或额外CI。

四PR head仍精确匹配发布表；Plugin System Tests四run均in_progress且无失败step。#6337 job117622005436仍处attendance inventory前置，锁协议/固定Chromium/PLM/宜搭71/后置SQL均pending，不得签ABORTED或stop通过。其同head全分页check-runs本次97 success/1 pending/2 cancelled/0 failure。

#6315另一个同head run39109296520的web-tests job117621754772已failure，具体失败step为Run the always-on web spec gate。公开日志末尾实际FAIL定位`apps/web/tests/uuid-no-bare-randomuuid.spec.ts`，1文件失败/584通过，1测试失败/12193通过；日志SHA **f793841527a6dc390b4efd861f2500073f9aea837f8b933e4a7f91df2a2f080d**。中间大量预期负例含Error/FAIL不算独立新增失败；初次脱敏投影过宽导致工具输出截断，不使用截断部分推算其它失败或原始文本。

在冻结#6315 head69a55ce7上git grep直接证实`StockPreparationYidaOwnerSendPanel.vue:161/182`仍调用原生UUID；main已带入的全树tripwire要求除`utils/uuid.ts`外不得出现该API名，测试第2条直接扫描实际src，不是假DB或随机网络问题。实际helper以安全上下文原生路径/非安全上下文getRandomValues后备/无安全随机源抛错三分支实现。当前#6337冻结树另有K3一处及Automation三处同类调用；它们尚未由本轮web job执行证明失败，不把静态预判写成CI事实。

最窄修复方向是六个调用统一接既有randomUuid，不豁免扫描、不使用Math.random、不改TTL/安全随机性或授权；需沿四支既有依赖链普通前进并重新验收，不可只修根支冒称子支覆盖。当前用户仅要求监视定位，本轮未改产品/测试、未推送或重跑。已报告新失败，既有四run监视继续，未因单个其它泳道失败停止观察后续正式71项及清理。

## 2026-10-18 08:03Z 四PR本轮CI只读核对（仅本地续记）

逐支重查PR head、准确Plugin System Tests run/attempt1、全分页jobs及commit check-runs；四head均与上节发布表匹配。四个Plugin run均in_progress，各自DingTalk P4、after-sales及K3 WISE三个辅助job已success，test (20.x)仍执行且无失败step。全分页检查结果：#6315共62项（58 success/3 pending/1 skipped）；#6323共32项（29 success/1 pending/2 cancelled）；#6324共92项（89 success/1 pending/2 cancelled）；#6337共100项（95 success/3 pending/2 cancelled）。失败项均0；此计数含同head多个事件的检查记录，不冒称独立必需门数量，cancelled/skipped不算通过。

#6337精确job117622005436当前处于前置operator-tooling单元测试；checkpoint、锁协议真实库、默认及固定Chromium安装、PLM manual/interval、宜搭71项、后置multitable SQL与attendance family-4均pending。因此当前head尚不能签ABORTED=0、实际host.stop/清理成功或71/71；没有把本地5de或旧35a结果回填。暂无具体CI失败可归因，保留既有10分钟只读跟踪，实际失败出现后才读取公开脱敏诊断，不自动重跑或修改。没有重复启动已完成并清理的Chrome试用，无新推送、合并、部署、客户读取或真实发送。

## 2026-10-18 四PR普通快进已推送，既有新head CI已启动（本节仅本地续记）

Owner本轮明确授权后，重新核实main仍d671019f2、四个远端旧head与base完全匹配，再以一次`git push --atomic`普通快进更新四refs；命令exit0，未使用force/force-with-lease、未改PR base/draft、未新建PR。GitHub随后逐支回读均OPEN/mergeable=true：

| PR | 新head | 原base | Plugin System Tests |
| --- | --- | --- | --- |
| #6315 | 69a55ce7fa6872a7c2419f98cf1b42b8f9e409c4 | main | [run39109296702](https://github.com/zensgit/metasheet2/actions/runs/39109296702)，原pull_request自动触发 |
| #6323 | 276c9ccf897d90b5bbf223becf2b8972907b8da3 | 原YiDa分支 | [run39109370449](https://github.com/zensgit/metasheet2/actions/runs/39109370449)，既有workflow_dispatch |
| #6324 | 7cd868b45d1a59d1d01728d3f762e87fe4829dc1 | 原K3分支 | [run39109374898](https://github.com/zensgit/metasheet2/actions/runs/39109374898)，既有workflow_dispatch |
| #6337 | 69140b86619e8fa9c1bf6da9bca5af731c8f5000 | 原PLM分支 | [run39109378982](https://github.com/zensgit/metasheet2/actions/runs/39109378982)，既有workflow_dispatch |

首支原非草稿状态不变，其余三支仍DRAFT。前三树与本地已验快照完全相同；#6337在同树保留历史提交6ea5d1e9f之后，只追加两份既有MD，共160新增行，实际diff仅这两份docs，所有runtime/tests/workflow/package/lock/pin与已验5de0484相同。没有stage独立GOV-08文档、临时工具、截图、日志或私有交接材料。受验快照5de0484另用本地refs/codex/integration-stack-verified-20261018保留，未改原用户分支。

对root原自动run已存在不再dispatch。针对三个非main base先通过准确head的workflow runs API确认Plugin System Tests结果数0，再逐支重查PR head后仅dispatch一次；不是重跑失败job。API逐个回读上述四run的head、attempt1和event均匹配，初始均queued。#6337精确test (20.x) job为117622005436，原四执行job当前queued/失败步骤空；pending不是通过。自动Integration Guard已挂同head，存在base/head事件带来的重复或被替代取消项，取消不是通过或新产品失败，未自动取消/重跑任何CI。

本轮仅恢复既有heartbeat6337-ci，不新增跟踪任务，仍每10分钟；改为准确四run/head、优先6337正式71项/ABORTED/实际停止及后置SQL，仅有意义变化通知、未变安静。只读检查及当前本地MD脱敏续记，不自动重跑/改代码/再推送。先前Chrome试用已完成清理，监视不再重复启动环境。四run全部终结或head覆盖失效后按约定报告并停用；自动化工具已确认ACTIVE。通过OpenAI Docs技能核对调度入口，实际配置以本机既有任务及工具回读为准，不手改toml或改全局设置。

既有源公开日志初次按4个head各列100条返回过长而被工具截断；未把截断输出作为全CI计数/完整哈希。随即改用精确workflow/head与已知run ID投影确认目标，不基于截断猜测不存在或通过。本节仅本地记录，不为更新监视再制造提交触发CI。仍无合并、部署、客户读取或真实发送；新head业务与清理必须正式通过后再判交付。

## 2026-10-18 已获准更新现有四PR与既有合成CI

Owner明确批准将已验证对齐结果更新至现有#6315/#6323/#6324/#6337，并运行既有合成CI；禁止强推、新PR/切片、合并、部署、客户读取与真实发送。下方等待授权/blocked为此前阶段记录，不再代表当前权限状态。推送前重新只读确认main仍d671019f2，四个远端旧head及依赖base均精确匹配本地保留历史链；采用普通fast-forward，不改base或draft状态。

本次#6337除同树保留历史对齐提交外，只追加已有两份closeout MD的最新证据及授权状态；独立GOV-08文档、临时工具、日志、截图与私有材料不stage。产品/core/web/plugin/ops/package/lock/pin字节仍为本地已验树；MD提交不冒称另一次业务执行。新head既有CI须另核，不拿旧35a或本地5de绿灯直接判正式通过。若远端在实际push前改变则停止，不强推覆盖。

## 2026-10-18 授权前置终核：本地收口已闭合，不能自动发布

本次续推进重新只读核对GitHub：main仍d671019f2；#6315/db35b3f、#6323/6514634、#6324/9d843d8、#6337/35a76c3均OPEN，原依赖base不变（后三支仍DRAFT）。对齐工作树HEAD5de0484、跟踪树干净、diff-check通过。35a76c3是原已授权发布head，不是新本地对齐候选。原完整合成、Chrome、SA-02及SA-05执行均已取得实际终态和清理，不存在可冒称“仍在跑”的必要监视。

此前三个连续goal回合均保留同一个外部授权前置：只获准此前#6337限定补丁推送，**尚未获准更新四支父链并启动新head CI**。前两回合继续完成了可安全独立的Chrome、第二owner/字段布局及真实PG发送端口补证；当前未发现现有四PR内还必须修改的具体生产缺陷，不重复跑已绿用例制造进展，也不另开切片。

完整六批目标不标complete。SA-06D自动宜搭发送仍须独立授权合同/GOV-08，真实客户读取、真实表单/token/发送、合并与部署各自仍有owner门，不能靠“继续目标”取得这些权限。当前可请求的最小推进授权仅为：更新#6315/#6323/#6324/#6337既有分支（保留历史、普通fast-forward）及既有合成CI；不含新PR、合并、部署或真实IO。若未获准，停止自动重复工作并等待明确裁决；恢复后须重核远端head/main再动。

## 2026-10-18 SA-05新基底持久发送端口补验（零真实发送）

同一5de0484源码上运行原`stock-preparation-yida-owner-send-port-realdb.test.ts`整文件，无名称过滤/生产修改/结果替换；仅将已受检临时运行器的目标文件与七项sourceHashes改为该发送端口/authority/security/runner/ledger，复用原Vitest配置及隔离哨兵，不增加产品切片。新建自有PG14、原测试随机schema和实际PG事务；环境白名单、发送flag OFF、原Node网络/.env guard、新user/net/PID namespace、非root、仅lo和五capabilities零均保持。468迁移是该专用入口原有六项排除后的计数，非完整provider迁移声明。

**49项原业务测试+1项隔离哨兵=50/50**，实际JSON精确哨兵1，失败/未执行/变异0、exit0；禁止网络/.env读取0、七项源哈希前后不变、自有PG移除成功。port测试通过显式合成fetch返回原生假Response，不调用global fetch；不把合成token/form正例当真实宜搭发送。临时共用回执内secondOwnerCases/Passed/Marker均0属于原运行器未使用的统计栏，不冒称此套覆盖第二owner（该独立证据见下节）。浏览器仅hash预检而未启动，不报本轮浏览器执行。

已实读并执行并发领取/一次permit、材料与grant撤销、加载后再次exact-literal开关检查、取消后的unknown、admission/claim COMMIT回执丢失不退还许可、ACK SQL失败不重发、数据库期限和关闭后晚结果丢弃、孤儿prepared不得生成执行能力等原路径。没有通过放宽超时、重试CREATE或删完整性断言求绿；本轮无新变异/独立新审查，不移用其他候选的审查结论。

原receipt SHA **31938e5adb640077a038aeab3278b267d10013a789aa91f9834127bbc7a8bae1**；原测试日志SHA **4a14472d599fadace8e7900a7a4ac909c57366118f229e879072ed7606492562**；持久脱敏回执`artifacts/local-stack-yida-owner-realpg-20261018.json` SHA **7b049cf50ac2a9e7550dca913ab46812f20a31906853c671c29662a0669fc6e6**。此证据不替代真实表单/token、客户协议对账、JWT HTTP、其它PG套件、自动发送授权或新head正式CI。无新push/CI/合并/部署/客户数据/真实发送。

### 仍保持的交付边界

新基底上已补当前执行证据：SA-01/02合成PLM、版本与第二owner配置复用；SA-03受审K3 B4/BL2及永久写围栏；SA-04静态两行DTO；SA-05默认OFF/单次本地初始化与内部持久发送端口；SA-06原Automation manual/interval只读预览。按六批目标仍不得宣称完整iPaaS/全部协议/客户上线或自动宜搭发送完成。实际`automation-actions.ts:9/39`的现有动作是integration_read_preview，`automation-read-contracts.ts:23/283–292`强制canApply=false；不从只读端口绿灯推导外部写授权。SA-06D自动发送合同在原目标中明确要求另行授权决策，不在现有四PR内新增。

当前发布缺口是未获准更新四PR及新head既有CI；客户MSSQL/真实表单兼容、小批真实发送与部署均是独立owner门。原历史未知失败不因当前绿灯而全部归因。目标保持active，本轮不调用complete或擅自扩大授权。

## 2026-10-18 SA-02新基底复用与真实JWT补验

不把上一轮Chrome单owner两行演示当SA-02完整复用证明。本轮新Linux副本5de0484，复用原宿主real-DB整文件和先前受检本地包，仅调整临时包的源码根路径；不改原产品/测试、浏览器helper或迁移。新user/net/PID namespace、非root、仅lo、五capabilities为0，受管新PG14/自产材料、真实发送OFF、原Node网络/.env守卫。迁移沿该专用测试入口原有六项排除共468条；此处不冒称完整provider迁移，完整迁移与replay证据仍来自上轮原full-app CLI。

原宿主整文件**39业务+1外加隔离哨兵=40/40**，失败/未执行/变异均0；实际JSON逐项确认哨兵恰好1、真实JWT矩阵16、第二owner/第二物理布局复用用例1且均通过。首次临时计数投影把“非secondOwner项数39”误命名sentinel；该值不用于验收，改读原Vitest JSON fullName并精确匹配哨兵名称后确认上述39+1，未重跑业务换计数。

第二部署由真实plugin deactivate/activate切换原受管目标；第二owner使用自己的canonical连接、七组不同字段布局，导入首次浏览器实际下载文件后修改角色，重新验证/样本确认/批准/激活/预览。原用例真实断言源/业务目标快照不变、原owner版本/激活不变、新receipt/版本/短期preview token绑定第二owner，原owner越权403。不是第二个Promise或替身DB“模拟第二用户”，亦不是并行多租户/客户MSSQL验收。

实际PG移除、sourceUnchanged=true、禁止网络/.env读取0、自然exit0。原receipt SHA **0b50ea3ca2462dae285d57ee01d18e94b362dc403d34d44afdca7e2a3d5780cd**，测试日志SHA **1c8bcefec5779a43a1166371f184b53bb2ed37574594af209e8367bc4fe0c945**；持久脱敏回执`artifacts/local-stack-sa02-second-owner-20261018.json` SHA **80a278f63927fd9a07b37f6496b2a507144ea01e92a699f104bcb4c94e044f58**。本套使用已验Playwright默认浏览器SHA2e61bc3f…，并非upstream固定候选CLI，二者证据范围不混同。未移用到未发布的保留历史metadata head。

只读GitHub重新核对main仍d671019f2，#6337仍OPEN/DRAFT、准确head35a76c3及原PLM base，无新推送/CI；无需因为过期main猜测重建候选。四PR更新授权仍未收到，不从goal自动续推取得发布权。

## 2026-10-18 新对齐基底完整合成与Chrome交互闭合（仅本地）

本轮实际受验HEAD为5de0484eb4c973d315a78e1b923cdcc001254499：53原Node整文件、原PLM full-app manual/interval各9阶段、原宜搭71项全部通过；具体哈希与独立审查限界见下节。三入口运行句柄35430已自然exit0，不再当作活监视。未将本地结果转称远端CI或完整六批目标完成。

在Chrome扩展真实连接后，使用原公开`run-stock-preparation-yida-synthetic-trial.mjs`（SHA a7834d3db2390ef3cfbfe2b5ee5cad65c23bd644aee9d268725ae5bbced34516），typed入口SHA9dfa8f7acf8f32bec4fb27ec58878c9e737cfe896da27807b35b32a8df62610a、原网络guard SHA bda3deb2c5edec07894de592e6d592011a347a8c569a84ab57f0299522f9e721；Windows已验树与Linux执行字节相同。只带原pg-bin与TTL900参数，原CLI新建自有PG/随机合成账号/假材料，发送强制OFF，不借既有数据库或真实材料。

READY后仅在内存读取本次自产handoff，不输出口令；普通UI密码登录→当前租户视图→合成项目→v2七身份样例→两行静态预演→打开独立初始化→手动GET空槽→填本次假材料/合成审核信息并显式确认→单次本地初始化→再次手动GET。页面实际显示2行、canApply=false、canSend=false、tokenIssued=false、externalWriteAttempted=false、无grant/发送许可。没有点击PLM拉取、单行CREATE确认或发送，也没有token/storage注入、fetch代替UI或真实宜搭调用。

准确保留工具问题：AX把范围按钮显示为checkbox，但真实DOM是button；首次checkbox选择器未命中，刷新状态后用观察到的控件及确认链接切换。协议select的getByLabel亦未命中，读取真实DOM后改用具名combobox，不改产品。首次stdin stop失败是exec会话stdin已关闭，不冒称产品停止失败或重启整套；通过owner nonce/repoRoot、实时uid/cwd/精确CLI argv及kill(0)核对仅本次存活父进程后发正常SIGTERM，保持Chrome连接直到停止完成。原进程26157自然exit0，公开STOPPED/ownedDatabaseRemoved=true；随后独立检查handoff不存在、pg-*目录0、host guard帧1且禁止网络/.env读取0。host stdout SHA **88e681f3e1674aecc671d09e25a2fb0921f547bb1b75bd0bf187be51aed14c53**，stderr SHA **13513000082122a5a3e23b3d1d820d188ec0e5d8ba80d24cb648a76c4082e916**。关闭临时tab并清空handoff内存，保留诊断/构建回执而非递归清理未知目录。

原公开CLI的acceptancePassed=false、bootstrapParentNodeGuardAttested=false、browserNetworkAttested=false均原样保留：普通Chrome试用不是kernel隔离正式验收，不能替代上文原隔离PLM/YiDa入口。截图仅合成内容，`tmp/yida-chrome-synthetic-preview-20261018.png`，SHA **276523600cb00f64804e902a4f35d385649225fcf4f57cd1f5001ae20bc71d9e**。无真实账号/主机/凭据或客户数据进入MD与对外证据。

本轮无新产品切片/端点、未推送父链或追加CI、未合并/部署/客户读取/外发。保留历史失败范围。后续发布动作仍须按当前远端head/main重新核准并获得授权，不因本地完整合成绿灯自动执行。

## 2026-10-18 既有四支本地对齐：53整文件通过，尚非新基底完整验收

续验已实际启动，而非待执行计划：新Linux副本5de0484的原公开full-app CLI依次manual、interval，再执行原YiDa browser CI CLI。仅复制本机已校验的官方候选到原要求的相邻路径，复制前后实际binary SHA均`43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925`；没有下载新浏览器、传入任意executable override或改原默认。当前manual已通过harness/web类型、core/web原构建、完整迁移及重放，进入configured-app真实浏览器阶段；尚未签其业务或停止通过。执行观察句柄35430确实存活；后续interval/YiDa未执行不算成功，原预算/完整性/网络/.env守卫全部保留，不改系统时间服务。

manual随后实际终结exit0，原结果passed/failure=null，9阶段成功、6736项sourceInputs，cleanup=stopped-and-owned-database-removed；原完整证据JSON SHA **ea7c13190ba9a8e8f534fe9acaf1e102a182b14be0c090c26f4f4553e02b9b12**，外层stdout SHA **0e4cb7e0e33a9f665ccfc4317315b3fe71fe63aa3126cfbac0a1db672c06c70b**。直接对该自产回执读取固定字段：204个browser-transport-diagnostic，ABORT/ABORTED事件及失败0，actual-stop-resolved=1、production-stop-verified=1、actual/production/emergency失败0。原CLI在签passed前已执行全部stop/Automation/K3/YiDa验证和源码/构建后验。临时外层collector将不存在的通用passed布尔投影为false，但PLM协议用的是result=passed；不把该工具字段误报产品失败，也不改写原回执。native git status仅多出本次自产artifacts/stock-preparation-plm-full-app/，没有跟踪源变更；保留证据不删除换绿。

同一观察句柄已顺序启动interval，实际进入build-core；这不是manual重跑。宜搭71项仍在其后，尚未签整轮或新Chrome试用完成。不因manual成功删除旧失败、弱化预算或自动取得新推送授权。

interval现亦自然exit0、9阶段passed、failure未设置、6736项输入，owned PG已停止移除，原证据JSON SHA **9d50fcd09f584f0bf4dd097e374627bc51c3c5a4fcb18f889ef8a83547bdbb91**、stdout SHA **eeb6c39be2a162070a586ca766109b0a346dcf31d38d220897a3a38074b3d51b**。另只读审计两份自产回执，逐项重算所有sourceInputs当前原字节哈希，再调用未修改的原validateProductionStopEvidence/K3/YiDa/OwnerOff/Initialization/Automation函数：全部通过。manual/interval闭合diagnostic分别204/132，ABORT/ABORTED为0；各actual-stop-resolved=1、production-stop-verified=1、停止失败0，cleanup均移除成功。不把336帧数量本身当业务断言。宜搭原CLI随后已实际启动，仍待其71项及清理终态；外层进程35430保持同一个，不重启凑绿。

宜搭原CLI随后实际exit0，公开result明确passed=true、tests=71/business=66/sentinels=5；自产private receipt亦passed=true/tests=71/cleanup=stopped-owned-pg-removed，SHA **c67443647d6b8af421b17762e2dfb4eb898d86fe2df384d084cd7611e391c5a0**。外层stdout SHA **77f33b48143d6b1249b9534ae1e88907a582b22ee4b733234fa3ba24541a9336**、stderr为空。35430自然exit0，三入口全部终结成功；不将工具frames未复制tests字段或PLM不存在的passed布尔当正式协议。完整PLM只读audit另保留为`artifacts/local-stack-plm-full-audit-20261018.json`（SHA11484382ad6424aa4a51f88dde574420c3b6fdd87819651f7f2d943169df5736）。这仍是本地5de0484验证，不冒充远端新head CI。

另为后续安全更新准备了**仅Git对象**的保留历史链：#6315→69a55ce7fa6872a7c2419f98cf1b42b8f9e409c4、#6323→276c9ccf897d90b5bbf223becf2b8972907b8da3、#6324→7cd868b45d1a59d1d01728d3f762e87fe4829dc1、#6337→6ea5d1e9f61c77f5307a18a5fa1f539d0b8bc905。每个新对象保留该PR旧head和更新父层为双parent，实际证明旧head及固定main均为祖先，四树与对应已验快照逐树完全相同。没有切换冻结worktree、改原branch refs、force push或以这些新metadata SHA冒充实际运行head。后续若获更新现有四PR授权，可用普通fast-forward而无需重写/丢弃原提交；原始快照mapping继续保留。映射回执`artifacts/local-stack-preserved-lineage-20261018.json` SHA **a41a0f6e32a1b76c3bf5c496e28e86739d2eaf66af21c4baf3c07240aba34aec**。

Chrome实时inventory已确认family=chrome/type=extension连接存在（browser id=3），尚未打开试用页或启动TTL环境。按computer-use技能先核连接，最终通过后仍需重新核对，不能把此刻连接当永久可用。原目标文件在当前发布/对齐树中并不存在；通过Git受管worktree列表找到`integration-goals/metasheet/docs/development/integration-self-service-adaptation-goals-20260930.md`及独立decisions检出中的本地原稿，未复制/改写或冒称它已入库。原稿很长且含历史段落，重新读取六批退出条件及权限/交付界限；不根据过期状态表重复造功能或将全目标缩为本轮CI。

授权纠正：此前owner已经明确批准“既有四支PR的修复、对齐和合成验收”。这覆盖本地隔离对齐，不应再把本地工作误报成等待授权；本次两文件推送授权不扩大为四个父分支重推授权。以下仅本地候选，原远端PR引用和base未改，未再推送或触发CI。

固定远端main `d671019f2baf925b1651b8c9ade6131b22ec28ae`，采用四层净差异回放而非冒称逐原提交rebase：#6315→`9e2d1115018094595a6c225a4dc161056cea98bd`，#6323→`0302bf970ffcf055d556ab150f62bd8f50b2e148`，#6324→`eae6f8681183b5c6c64243b19d0270ba1c5c1376`，#6337→`5de0484eb4c973d315a78e1b923cdcc001254499`。只在新受管worktree建立未发布链。与整栈一次merge-tree对照，非pin源码差异0；四层pin均按实际模块函数重算，63个原文件工作字节与Git HEAD相同、CRLF为0、66叶子校验通过，未手拼哈希。

Windows最初物理CRLF导致权限矩阵M-08的严格文本断言失败，保留失败；随后仅在新隔离worktree按Git原LF字节重检出，没有改产品或原测试。LF准备后provenance、permission-matrix、http-routes三个整文件通过。首次扩验53整文件为44通过/9失败，亦保留：8个文件缺新副本依赖，K3真实重定向测试被原禁止监听守卫拒绝；不能将该轮写成全绿。

另建Linux本地共享对象副本，准确HEAD为5de0484；先离线安装因默认store缺缓存失败，保留原回执。随后使用既有本机PNPM缓存store离线frozen安装成功，禁用lifecycle及pnpmfile，不下载依赖、不借旧workspace的node_modules。实际元数据遍历确认环境文件0、pnpmfile钩子0，而非依赖setup初版常量标记。

在新user/net/PID namespace、非root、仅lo、五capabilities为0、NoNewPrivs=1和原Node网络/.env守卫下，重新执行**53/53原整文件通过**，源文件哈希前后不变，无跳过、取消或超时。只有原`k3-wise-redirect-fence`测试启用原有own-HTTP模式，允许同进程自建临时loopback服务，实际allowedConnections=14；禁止网络/环境读取仍0，其余suite允许连接仍0。没有修改原suite或放开外部地址。

完整本地回执`/tmp/metasheet-stack-unit-RD3V6Z/parent.receipt.json`，SHA **400192ecde84949db2c670229e4b7aa6175477452c7c3e54fa96fe44168a2b75**。独立既有只读复核在首尾相同5de0484及干净工作树上核验16门次序、可信JWT、canonical owner/tenant、plugin Bridge、K3永久拒写，未发现新增阻断；其范围为静态必要调用链，不冒称独立复算pins或运行完整验收。

上述“仍待完整验收”是本节起始阶段；本地5de0484的manual/interval、stop/清理、宜搭71项及Chrome试用现已实际闭合，见顶节。下节35a76c3的正式CI成功仍只属于旧发布head，不移用到该本地对齐候选。现有主目标保持active；这些本地结果不等于六批目标完成或获准推送父链、合并、部署、客户读取、真实宜搭发送。

## 2026-10-18 新head正式收口：Plugin与Guard均成功

准确head **35a76c37e16894b7827fdaac90aa905fb9ab78f5**的[Plugin System Tests run39099548759](https://github.com/zensgit/metasheet2/actions/runs/39099548759) attempt1已completed/success；精确test (20.x) job117592820694 success。四个执行job均success，原coverage job为条件性skipped，不计为验收通过。checkpoint、两项Chromium安装、33整文件实库步骤、PLM manual/interval、owner宜搭JWT HTTP/browser、后置multitable SQL及晚期attendance步骤八项目标均实际completed/success，没有用pending/skipped替代。相同head的[Integration Guard run39099550082](https://github.com/zensgit/metasheet2/actions/runs/39099550082)亦success。GitHub再次回读#6337仍OPEN/DRAFT、原base未变、head完全匹配。

本轮只读取公开job日志，剥离job/step列、时间戳和显示ANSI后作固定枚举/布尔/计数/哈希投影；未读取私有产物、.env或凭据，不输出响应、查询、业务标识或堆栈。日志摘要SHA **dfa7d7f94923080f964903d578857f0e4c34a05a1bb1db773c7fde9455dcba28**指原gh文本逐行以LF连接再按UTF-8计算（包含原CLI列与时间戳），不是原zip字节或声称哈希前已删列的文本。重复读取同一公开日志摘要一致，不重跑任何测试或CI。

- 宿主真实JWT整文件成功用例行**39**，其中新`requires real JWT tenant provenance`矩阵**16**。本地外加隔离哨兵不计入正式CI，仍不虚报40。
- 正式宜搭结果**71/71 = 66业务+5哨兵**，passed=true。原外层reportOuterResult在允许passed前检查owner/source哈希、子进程终态与持久receipt的stopped-owned-pg-removed；见原公开CLI L467–476及L528接线。
- 闭合browser-transport-diagnostic **324帧**，ABORT/ABORTED **0**。automationRequests的POST202在SDK BODY_DONE+complete、PLAYWRIGHT BODY_DONE+complete、PROXY UPSTREAM_COMPLETE+complete各**1**。帧总量不要求等于旧head的336，不把REQUEST_FINISHED默认status0当body完成证据。
- 独立actual-stop-resolved **2**，actual-stop-failed/production-stop-failed **0**。两条PLM结果均passed、failure=null、cleanup=stopped-and-owned-database-removed，各6588 sourceFiles，receipt SHA分别为`276821bba6f836e77360bd2489b873351616f7f4a700193fc22836ebc7050b8c`、`106eb4a390684ff6bf989c194b4cf60c0fb50287013b341f273e7b0890298a16`。
- 停止证据的可见性不扩大：完整production-stop-verified字段仍未由原CLI公开转发，因此汇总该字段/closed/ownedDatabaseRemoved直取计数为0；不是谎称直接读到私有stop帧。当前原CLI L990必须执行L376的validateProductionStopEvidence，强制唯一resolved→verified顺序、双池/HTTP/collaboration关闭、2断连、0timer、无emergency；随后实际owned PG停止。公开两次actual-resolved、两条passed+数据库移除结果与未修改的强制验证链共同构成本轮停止证据，不为补可见性读取私有材料。
- 晚期family-4正式整文件**10 tests、0 skipped、success**；恢复after-image正式整文件**11 tests、0 skipped、success**。本地外加哨兵不混入计数。闭合SA06AQ_SQL_CANCELLED帧**0**，原8秒预算与原子完整性守卫未变，不把没有取消帧单独当作测试已执行的证明。

日志提取初版把文件成功行数1与测试数分开，未冒称1项测试或空数组代表通过。随后只修临时汇总器对原日志caret编码ANSI（^[[…）的显示剥离和(n tests)/(n)格式识别，得到上述10/11及0 skipped；原公开日志SHA、产品/原测试和CI均未改变。Windows rg通配路径一次无匹配报123，改用原目录递归定位到实际CLI，并未据此改产品。

最终脱敏回执由Codex Security持久保存为`artifacts/selfservice16-followup-formal-ci-20261018.json`，SHA **af8b94c8894e6b525604d203592a37f7aec511750b20a5dbf95a1363acb6a028**。本节仅本地续记，结果同步PR正文，不为续记再造提交/推送或触发CI。旧75ea Guard的M-08失败、旧SQL57014/版本断言、ABORTED、250ms租约及WSL回拨仍保留各自历史范围；新绿不证明所有历史根因均已修复。

补充保留汇总器文本副本`artifacts/selfservice16-followup-public-ci-summary-20261018.ps1`，SHA **965c7e7f0be65828b2b6627817131bbf27330f69400b3a2dd2b5048231f841a8**，供复核同一公开日志的投影；不将该工具或补充回执冒充独立全仓扫描、私有原始日志或另一轮测试执行。PR正文更新前再次比较原body与当前head，确认无人新改后追加最新结论并保留全部历史段落，未覆盖他人修改。

交付前置仍分开：四支祖先head未变，main仍d671019f2，#6315仍CONFLICTING（前述同基底merge-tree仅pin文件冲突）；#6323的两个非成功条目准确是2026-10-12已取消的pr-validate与Stock-prep browser verify，不是两个新FAILURE，也不能算通过。#6438独立文档仍OPEN、21 success、0pending/0failure。本轮#6337候选合成阻断闭合，不等于父链已对齐、整个SA-01至06/客户验收已完成或获准合并部署；未重写父分支、启动重复Chrome试用、读取客户或真实宜搭发送。

## 2026-10-18 本轮checkpoint已通过，正式业务验收仍待执行

继续只读核对Plugin System Tests run39099548759 attempt1，GitHub回读head准确为35a76c37e16894b7827fdaac90aa905fb9ab78f5，test (20.x) job117592820694仍in_progress。原Run isolated manual checkpoint acceptance实际completed/success，随后DB migrations亦已越过；最新快照完成93个步骤、当前Run tasks auth gate、失败步骤0。观察句柄7933仍存活，不因单次观察结束而重启工作流。

固定Chromium安装、PLM manual/interval、owner宜搭JWT HTTP/browser及后置multitable SQL在前一次精确步骤快照均为pending，不把“checkpoint已通过”扩大为这些目标已通过。独立Guard成功只属于该泳道；最终须从本轮准确head的正式日志分别核验71=66+5、POST202完整body、ABORTED、实际stop及owned PG清理。当前只本地续记，不追加提交/推送/重跑，不启动新试用。原长期目标六批范围不缩为本轮测试修复；父链pin冲突及客户窗口等独立门仍保留。

后续同run快照确认两项安装均completed/success：Install Chromium for owner YiDa real-DB acceptance及Install hash-pinned Chromium candidate for PLM and YiDa acceptance。当前在Run external-system delete x pointer-write lock protocol real-DB proof（startedAt=2026-10-18T05:41:54Z），最新2026-10-18T05:44Z观察仍in_progress、失败步骤0。该步骤实际包含既有host/Automation多整文件，不能只按标题把在跑等同锁测试超时；未取得terminal前不诊断挂死、不重启。PLM manual/interval与宜搭步骤仍pending，安装成功不等于浏览器业务验收通过。

只读既有workflow实际命令确认该步骤包含33个原实库整文件，Vitest原配置fileParallelism=false。另读取旧head75ea803ab的成功run39048439856逐步骤时间：相同整文件步骤16:32:53Z→16:47:00Z，实际14分07秒；随后PLM6分02秒、宜搭1分44秒。此处仅用来避免把长步骤未经证据误报挂死，不构成新head通过证据、性能承诺或增加本轮预算的理由；仍以run39099548759实际终态为准。

## 2026-10-18 四支既有PR交付面复核：父链完整，根PR待对齐main

等待主CI时只读核对既有父链，不改分支/PR状态：

| PR | 当前head | base | 状态 |
| --- | --- | --- | --- |
| #6315 | db35b3f9678e48c90821ceb8d9ee315b8715f30e | main | OPEN，非draft，GitHub CONFLICTING |
| #6323 | 651463427eb788c6886cbded7b6103187ae572db | #6315分支 | OPEN/DRAFT，MERGEABLE |
| #6324 | 9d843d8928714da179a73bcb0aaa1da5ac7276a7 | #6323分支 | OPEN/DRAFT，MERGEABLE |
| #6337 | 35a76c37e16894b7827fdaac90aa905fb9ab78f5 | #6324分支 | OPEN/DRAFT，MERGEABLE |

三次git merge-base --is-ancestor实际exit0，确认当前6315→6323→6324→6337的祖先关系都成立，不是只按PR正文说堆叠。各PR当前statusCheckRollup都0failure/0pending，但**#6337显式workflow_dispatch主CI仍在core-backend tests**；这个分支的PR汇总不包含正在等待的全部显式工作流，不能据“47项/无pending”称正式71项/stop通过。

只用`git merge-tree --write-tree --name-only --no-messages`做本地合并预览（生成Git树对象，不改工作树、index、refs或提交），基底main d671019f2baf925b1651b8c9ade6131b22ec28ae与当前6315 head。诊断exit1，树对象2867ad9e067378d348e306daf7c3322c58d0a10a，仅一个冲突路径：`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`。随后直接读取GitHub main SHA，确认它仍准确等于这个本机origin/main，不把旧main的冲突清单冒充实时状态。

这是**另一个交付前置**，不是此次M-08修复回归。未来若owner授权父链对齐，应以实际最终合并树重算provenance全清单并跑测试，不能简单取ours/theirs的pin或手工拼哈希；随后按父链顺序复验。该动作会超出本次两文件push范围，当前未rebase/merge/cherry-pick/改pin/推送任何父分支。没有擅自把6315改回draft，也没有把子PR的MERGEABLE当作可绕过6315冲突直接交付的理由。

当前HEAD仍35a76c37e，只有本地MD续记及独立决策MD副本untracked；本轮不再造提交，不自动合并/部署，不访问客户或真实发送。主CI原run仍in_progress，继续只读等待。

## 2026-10-18 新head Integration Guard正式成功

准确head `35a76c37e16894b7827fdaac90aa905fb9ab78f5`的[Integration Guard run39099550082](https://github.com/zensgit/metasheet2/actions/runs/39099550082)已completed/success，失败步骤0。原插件CJS整链步骤实际success，随后targeted web guard亦完成，故M-08旧oracle在本轮正式流程的阻断已消除，不再以本地矩阵通过代替远端证明。

同head主Plugin System Tests run39099548759仍in_progress，当前Time Machine D2 archive real-DB fail-not-skip behavior，无失败步骤；不能提前称主CI、正式宜搭71/PLM/停止通过。本节仅本地续记，不追加推送或重跑。旧75ea Guard failure及其局部修复/有限变异仍保留，未合并、部署、客户读取或真实发送。

## 2026-10-18 M-08修复已推送，新head正式CI运行中（仅本地续记）

两文件提交`35a76c37e16894b7827fdaac90aa905fb9ab78f5`已按owner授权fast-forward推入原草稿#6337。GitHub回读head完全匹配；仍OPEN/DRAFT、base仍PLM分支，没有force push/新增切片/运行时/pin/workflow变更。

显式dispatch既有Plugin System Tests一次，得到[run39099548759](https://github.com/zensgit/metasheet2/actions/runs/39099548759)，attempt1、workflow_dispatch、head35a76c37e，精确test(20.x) job117592820694当前in_progress。自动同head[Integration Guard run39099550082](https://github.com/zensgit/metasheet2/actions/runs/39099550082)亦in_progress。pending不算通过；新头的M-08整链/真实JWT/固定Chromium/PLM manual+interval/宜搭71/实际停止和后置SQL都必须独立核验，旧75ea的Plugin成功/Guard失败不转移。

#6337正文已追加准确新head/run及两文件范围，旧候选各段标为历史记录。当前本地只续记该运行事实，不为日志再造提交/触发CI；独立GOV-08文档仍只在#6438。未合并、部署、客户读取、真实token或发送。

## 2026-10-18 已获准推送M-08两文件修复及既有合成CI

owner明确批准将本轮两文件（原权限矩阵测试+本文MD）推入现有草稿#6337并运行既有合成CI。下方“未推送/等待授权”保留为此前阶段，不再代表本次授权状态。推送前GitHub核实草稿OPEN/DRAFT，远端head与本地父提交均为75ea803ab，base仍PLM分支，无他人新提交需要覆盖。

本轮再次执行原权限矩阵整文件：exit0、TAP1/1、禁止网络/.env读取0，日志SHA `6f5706007fa3439a3595babfa608d5cb05f2ac0dc5a736f9181460a2415bba0a`。四项结构变异重新执行，缺转交/额外动态/错顺序/新identifier均在M-08失败，每项实际变异1次、原守卫0；完整provenance再次exit0。源码runtime/pin未改，测试候选仍为`06e9625629bef339dbb429b5bdeb1ba2b602f65b98307ebe9b997da4a2535a1e`，不重打无变化的pin。

首次复用变异驱动时四项均按预期致红，但驱动防覆盖写回旧回执遇EEXIST、整体exit1，保留该失败及旧证据；只将临时驱动的输出回执名改为新文件，保留wx防覆盖与全部断言，重新四项后驱动exit0。不是删除旧文件、隐藏失败或改产品以换绿。新回执由Codex Security持久保存为`artifacts/selfservice16-permission-census-publish-20261018-receipt.json`，不提交私有日志。

仅stage该测试和本文，不带独立GOV-08文档、临时驱动或其它文件。新head的CI须另行核验，旧75ea正式JWT/71项/stop成功与原Guard失败均继续保留，不能因只改测试而直接移用。仍不新增切片、不合并/部署/客户访问/真实发送。

## 2026-10-18 正式CI终态：Plugin全绿，Guard旧结构断言仍红

准确head `75ea803ab40b9e16d8ec45e6f594c4b522894ad2`的[Plugin System Tests run39048439856](https://github.com/zensgit/metasheet2/actions/runs/39048439856) attempt1已completed/success，精确job`test (20.x)` id117441812301 success，其它三个job亦success。原锁协议/宿主真实DB、PLM manual+interval、固定官方Chromium、owner宜搭JWT HTTP/browser、后置multitable SQL及attendance步骤均实际completed/success，无pending/skipped替代通过。

只读公开job日志，先剥job/step列、时间戳及ANSI，再按固定枚举/数字/布尔/哈希投影，未读私有artifact、.env或凭据，也未输出原响应、URL参数、业务ID或堆栈。完整文本按LF拼接的归一化公开日志SHA `0e488df8446342c66823b6b710d906a3d3c25078fb939e5f9c7adc7b082a15b5`，不是宣称原下载zip/字节流哈希。

- 真实宿主整文件逐case成功行**39**，其中明确标题`requires real JWT tenant provenance`成功行**16**。本地40项中的外加隔离哨兵不在正式文件，不虚报CI40。首次汇总器只查`(N tests)`文件汇总格式，未命中；未将空数组当通过，改从原verbose逐用例成功标记精确计数39/16。命令回显和无成功标记行不计入。
- 正式`YIDA_BROWSER_CI_RESULT`恰好1条，passed=true、tests=71、business=66、sentinels=5。原外层reportOuterResult还先验owner/source哈希、子进程终态和持久receipt的cleanup为stopped-owned-pg-removed，才允许passed；不以另一路绿或本地71/409替代。
- 闭合browser-transport-diagnostic **336帧**，failure ABORT/ABORTED计数**0**；automationRequests的POST202，SDK BODY_DONE+complete、PLAYWRIGHT BODY_DONE+complete、PROXY UPSTREAM_COMPLETE+complete各**1**。不把REQUEST_FINISHED默认status0当响应body完成；interval没有manual POST202不算缺失。
- 独立actual-stop-resolved公开帧**2**，actual-stop-failed/production-stop-failed **0**。两条PLM_FULL_APP_RESULT均passed、failure=null、cleanup=stopped-and-owned-database-removed，各6588sourceFiles，receipt SHA依次`90df714d558c5379970ee676c006f84b6f75b1026b70557ec8b3f77ad2462833`、`d1484677f69e2319ba051731aa06c77917c675a8f32ed3eca4102abae8121fa9`。

停止证明范围明确：成功的production-stop-verified完整字段不由原CLI公开转发，故日志投影该字段计数0，**不谎称直接读取到2条完整stop私有帧**。当前原CLI `run-stock-preparation-plm-full-app.mjs:990`在产生passed前必调`:376`的validateProductionStopEvidence，强制单次actual stop→proof顺序、双池结束/HTTP与collaboration关闭/2断连/0维护timer/无emergency；随后finally实际owned PG stop。上述同head真实CLI两次passed与cleanup给出按原验收合同验证的停止证据，公开actual-resolved提供独立印证。不为补该可见性读取私有产物或弱化assertion。

GitHub同时核实[#6438](https://github.com/zensgit/metasheet2/pull/6438)文档head d0daac73d当前21项success、0pending、0failure，OPEN未合并；#6337仍OPEN/DRAFT、head未变、0pending，**唯一failure是integration-guard**（run39048441736的M-08旧oracle，修复/变异见下）。因此不能称PR全绿/可合并或完整集成目标完成；本地权限矩阵修复未提交/推送，等待明确追加授权，不重跑失败job。

本轮CI闭合当前候选的正式浏览器/宜搭/PLM停止目标，不倒推旧ABORTED、250ms租约、SQL57014、版本断言或WSL回拨全部历史根因已修。本节和脱敏CI汇总仅本地续记；原独立文档与代码PR均不合并、不部署、不读客户/真实宜搭token、不真实发送。

## 2026-10-18 最后一套本地守卫拒绝分类（不改守卫）

亲读`sealed-export-s6a-product-runtime.test.cjs:27–32`，原负例显式使用本机不可达PG目标和假driver材料验证错误脱敏，不是客户数据库。限定重执行该原整文件，仅追加读取原guard.snapshot的exit观察器，未改目标/异常/SQL/守卫：实际blockedOrigins唯一`{kind:socket, origin:postgres}`，forbiddenConnections=1、allowedConnections=0、forbiddenEnvReads=0。故已经把“未知调用”缩窄到这条原负例的PG socket，不能误报为真实外部发送；也没有允许该socket穿过守卫。

原套件终点OK标记未出现，Node --test包装报告1失败/0通过，原子进程仍被exit92守卫拒绝。**不宣称该套件业务断言全部执行通过，也不因此报283/283**。这次仅分类本地受限环境，不等于证明普通CI无守卫环境下它必绿；不改本机网络/连接豁免、不提供真实数据库、不做无守卫重跑。限定日志SHA `5609c01d6ba97298e8328c5e586ddf9735a35130dfb987b420dc926d0f3db267`，观察器SHA `cf4edd2dbaa2f122a1138abc5c6dbea1c693132ad3a33e5839f34607983f9f08`。源/测试均未编辑，此证据不扩大到原整链或远端结果。

## 2026-10-18 原插件283套链本地扩展检查（保留守卫拒绝，不报全绿）

为减少逐条推送返修，复用原`plugins/plugin-integration-core/scripts/test-chain.cjs`及其loadChain/toArgv/无shell/fail-fast语义，在新user/net/PID namespace、非root、仅lo、五capabilities零及原Node网络/.env守卫下执行；不改test-chain.txt或原suite，当前只含未推送的M-08测试oracle修复。配置命令恰好283个，实际source/provenance和三项源哈希前后不变。

第一次净化环境没有测试模式/原可选tsx管道抑制设置，停在host-loader-smoke，exit92、禁止连接2/环境读取0；没有把这轮当业务回归。第二次只补原验收已使用的NODE_ENV=test与PLM_FULL_APP_BLOCK_OPTIONAL_TSX_PIPE=1，保留相同原守卫与隔离，执行到链最后一个`sealed-export-s6a-product-runtime.test.cjs`后被守卫exit92，禁止连接1/环境读取0，无超时。原runner第一处非零即停，配合实际清单确认**前282个命令exit0，第283个守卫拒绝，后续0个**；不是283/283，也不是仅凭290个守卫帧推算suite数量。没有放宽守卫、删测试、skip该套件或再做无守卫运行；具体被拒调用来源仍未归因，不谎称它是产品漏洞或已修环境根因。

第二次完整私有日志SHA `56910b2f6482d6945c6faf4ef6ff30e6002aba10d83434ef45992206600ad4d3`。初次回执`artifacts/selfservice16-plugin-chain-guard-refusal-receipt.json` SHA `0ffacaa6ae7b25282bf935129f785fca6a7720a8cda67dae3245ead1134d9c47`；补测试环境回执`artifacts/selfservice16-plugin-chain-test-env-receipt.json` SHA `124b03b732c32b09a7f0556217c0e224004200213e5ee1e76d34552469a0dab2`，均在前述Codex Security托管目录。回执completedSuites=null如实保留原链未输出全通过，firstStoppedFile=null是驱动只识别不含node前缀的旧regex限制；另对原日志末行固定停止文件和原清单索引核对，不伪造回执值。

远端run39048439856仍在test(20.x)的Run core-backend tests，尚无失败步骤，关键PLM/宜搭/stop不预判成功。本地链扩验不替代失败Guard或远端正式证据；M-08修复及MD未提交/推送，未重跑/取消CI，仍无合并、部署、客户读取或真实发送。

## 2026-10-18 同head Guard失败及权限矩阵局部候选（未推送）

同head75ea803ab的Integration Guard run39048441736已终结failure，真实失败为`stock-preparation-permission-matrix.test.cjs`的vocabularyIsFrozenAndRoutesAreRegistered，M-08原断言只认可四个STOCK_PREP常量。新具名helper内部唯一`requireAccess(req, action)`被原源码census识别成第五个identifier；不是生产权限被放开，也不是JWT负例失败。公开失败日志只在内存提取固定错误类型/文件/行号，未输出原响应或业务值；日志过长发生工具截断，未把截断内容当完整日志哈希/全链统计证据。末尾实际M-08栈及exit1足以定位该断言，未假称其它suite都通过。

在当前同字节Linux候选运行该原整文件，修前exit1，TAP1失败，失败函数/行1237与CI一致，禁止网络/.env读取0；日志SHA `16c9710ec1dc6d320300827eefa36568cc60f9ae52ea16f105dbe2a2f5e896e0`。随后只改这个原测试的结构oracle：保留四个冻结常量，明确列出action，同时钉死具名helper中permission-first→verified-tenant的精确位置，以及全模块非声明的动态action转交**恰好一次**。没有在census生产helper增加通配豁免，没有改任何runtime/JWT/原权限矩阵业务断言。

修后原整文件exit0、TAP1/1（manual main，不虚增内部矩阵计数），日志SHA `9788f24161fe7875d9c4fb471b5a38daf8c3df92db90ae3a2a751e2cee6a97e3`，原守卫0。追加四项有限源码census变异：删具名action转交、其它位置再加一次动态转交、调换权限与tenant检查顺序、增加未知identifier，4/4均在M-08 AssertionError致红、实际变异次数各1、无超时/禁止IO。变异预先加载真实runtime后只改测试读取的源码字符串，不改生产磁盘或执行行为；它们是结构oracle的负控，**不是新增四项真实JWT/runtime变异证明**。原真实JWT及23runtime变异证据保持各自范围。

本地Windows/Linux测试候选SHA均`06e9625629bef339dbb429b5bdeb1ba2b602f65b98307ebe9b997da4a2535a1e`。该测试不在实际pin输入；完整provenance再次exit0，未改pin。四探针持久回执`artifacts/selfservice16-permission-census-mutations-receipt.json`，SHA `49f7c39926d68783ac5b574fc81379aa46e51ec66d54e7f5d7d4eafe3d8acec4`，同此前托管目录。

Plugin System Tests run39048439856的test(20.x)仍in_progress，当前Run attendance W4C-0 Stage D §8.4 and W4C-4 §12.7 inventory collectors，尚无失败步骤；不能把Guard失败混称整轮Plugin终结，也不能把后续真实JWT/PLM/宜搭/stop未执行算通过。没有取消/重跑当前run或再推送。此次局部测试修复及本节留在本地，需owner明确批准下一次推送/合成CI；原独立文档PR与代码草稿均未合并，未部署/客户访问/真实发送。

## 2026-10-18 实际推送及同head CI跟踪（本节仅本地续记）

已先创建独立GOV-08文档[#6438](https://github.com/zensgit/metasheet2/pull/6438)，完整head `d0daac73dc9bd760c234e5376a863bc15abb6b4c`；随后七文件代码/测试/pin/closeout提交 `75ea803ab40b9e16d8ec45e6f594c4b522894ad2` fast-forward推入原分支。GitHub核实#6337仍OPEN/DRAFT、head准确匹配、base未变。未force push、未把独立决策文档放进代码提交、未合并或改base。

原Plugin System Tests没有因这个stacked base自动触发，故按授权显式dispatch既有`plugin-tests.yml`一次，得到[run39048439856](https://github.com/zensgit/metasheet2/actions/runs/39048439856)，attempt1，workflow_dispatch，head准确为75ea803ab。精确job名`test (20.x)`，job id117441812301，当前in_progress，已到Global History flag manifest contract，失败步骤0；**前置/真实JWT宿主/PLM manual+interval/宜搭71项/实际停止与后置SQL尚待正式证据，不能判PASS**。

同head自动Integration Guard为[run39048441736](https://github.com/zensgit/metasheet2/actions/runs/39048441736)，当前in_progress；其它自动PR checks未手工重复触发。#6337正文顶节已更新独立决策、准确head/run、本地范围及历史风险，不再让旧4e9等“当前head”口述误导审查。文档PR当前checks无失败、仍有pending，未合并；其main基底检查不替代代码候选检查。

本节写在推送后，仅本地保存，不为续记再造提交/再次触发CI。旧正文及本地40/130/409/50、有限变异和旧head71各自范围保留，任何新失败均先报告，不自动重跑。未经再授权，不真实客户读取、宜搭token/发送、合并或部署。

## 2026-10-18 独立决策PR已创建；获准推入原草稿及运行原CI

owner最新明确授权：独立GOV-08提交/推送/文档PR在先，然后既有草稿#6337追加已验证补丁及MD、运行既有合成CI。不新增功能切片，不合并/部署/客户读取/真实发送。本节取代下方历史段落中的“待授权推送/CI”当前状态，保留当时证据。

只读GitHub核实#6337仍OPEN/DRAFT，远端head仍`dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395`，base为`codex/plm-read-plan-self-service-final-20261011`。未改变base或重写他人提交。fetch得到当前main `d671019f2baf925b1651b8c9ade6131b22ec28ae`；独立干净文档分支`codex/selfservice16-gov08-20261018`以它为基底，commit `d0daac73d`只有47行决策MD，已推送并创建[#6438](https://github.com/zensgit/metasheet2/pull/6438)。其它带未提交内容的决策工作树保持原样。

代码候选五文件与封存补丁`git apply --reverse --check`一致，LF runtime/pin再次核对。2026-10-18推送前在同字节Linux候选执行原完整`sealed-export-package-provenance.test.cjs` exit0，原network/.env守卫禁止连接/读取0；未改hash算法或先归一化字节。代码提交仅这五文件及两份closeout MD；独立GOV-08留在#6438，不夹带进代码PR。后续CI必须按实际新head记录，pending/skipped不算通过。

首个GitHub只读检查因进程继承的本机代理不可达失败；只在后续命令子进程清空HTTP/HTTPS/ALL_PROXY并为git显式关闭该次代理，恢复访问。不改系统/全局代理配置，不读取或输出token/凭据。

## 2026-10-17 本轮局部候选封存（未提交）

已封存五文件统一diff（仅runtime、三个原测试及一个pin；不包含其它历史产品改动），`artifacts/selfservice16-local-candidate.patch` SHA `057cb74098accb4db6aeca97326918316a28fe666c67969ac610863cd232db8f`；托管目录同下。`git apply --reverse --check <该文件>`在当前未提交候选exit0，仅检查、不应用，确认补丁与工作树匹配。首次捕获因Git的LF→CRLF warning前缀被完整性检查拒绝，没有保存半件；再次仅移除首个diff之前的warning，校验恰好5个文件、无中途warning/截断，再保存并反向只读校验。

基线仍dcc82a1，生产diff33增/16删，只在http-routes.cjs局部执行。独立GOV-08及两份closeout MD留在工作树，不混入代码补丁。`artifacts/selfservice16-candidate-handoff.json` SHA `a6a8b63c5a7b6cc6fd0039ada4b57ec1fc89b6e367a5e1ba09f8c1523dc7510f`记录各项本地证据、哨兵口径与未执行外部动作；不是全部目标完成/正式CI/发布清单。原目标仍active。

当前授权仅本地实施与验证，不执行下一步推送/CI。若owner批准进入正式审阅，应先按GOV-08独立决策与代码的既定顺序处理，再将同一候选推入原草稿并核验同head正式步骤；不得自行另开PR或将两类PR的独立性省略。其余SA批次证据仍各自按准确源码/接口/测试范围审计，不在这份五文件局部补丁中追加功能。

## 2026-10-17 SA-05既有发送端口：当前候选真实PG补证

继续核原目标SA-05的持久领取、一次许可与未知结果处理，不增加产品功能或切片。复用原owned-PG helper、原network/.env guard及原Vitest整文件`stock-preparation-yida-owner-send-port-realdb.test.ts`，无testNamePattern、不替换SQL结果/授权服务、不修改原测试或生产文件。临时驱动及脱敏回执由Codex Security托管，不进入候选产品diff。

实际结果：**49项原测试+1项外加隔离哨兵=50/50**，failed/notExecuted/mutations均0，exit0；禁止连接与环境读取均0。新建PG14先执行462迁移；测试按原定义在自己的随机schema执行090–095 DDL，真实PluginRuntimeSecurityService加密、内部审批authority、private admission、runner与ledger均参与。独立PG会话/PID及pg_blocking_pids证明竞争，不把两个JS Promise误称两个实际数据库会话。

亲读并执行的关键路径：原`:430`并发提交只产生一个permit及一次合成token/form请求；`:447`权限/材料/grant在token阶段撤销后不发form；`:467`私有材料加载后重查exact-literal开关；`:489`最终resolver撤权转unknown且不公开body；`:506`取消token/form后不返还CREATE机会；`:529`admission/claim实际COMMIT回执丢失不恢复许可；`:543`真实ACK SQL失败转unknown且不自动重发；`:611/646`数据库期限复查；`:690`关闭/取消后的晚结果丢弃；`:707`孤儿prepared不生成capability。无token或form真实HTTP，原`:161`明确合成fetch返回假响应且不调用global fetch；不能把表中acknowledged或合成计数当真实宜搭业务成功。

隔离入口保留原非root、新user/net/PID namespace、只有lo、五capabilities全0。环境白名单仅传新owned PG地址及自产随机材料；父环境真实发送flag为false，原测试的正例通过显式合成依赖选择true，默认/false/TRUE/空格/非字符串等负例仍保留。未修改系统时间/时间同步、未接继承数据库；测试结束宿主连接正常关闭，外层PG stop及pg-*目录移除成功，源文件前后SHA未变。此次不启动浏览器；临时驱动仍保留原浏览器二进制hash预检，但不将其记作浏览器执行证据。

运行入口：`unshare`→`setpriv`→托管`artifacts/yida-owner-realpg-run.mjs`→`yida-owner-realpg-worker.mjs`→原Vitest integration config整文件；驱动SHA `98374db6702260248b87e2718b6c06cca04d28aae14bfe3838efaa350680afe2`，worker SHA `894c6ddbc6089da6fcd6e70df321038ff0146698f45ce4b8292ee1516250a3a2`。原test/source哈希在实际回执中，不借上轮409的内存DB范围替代真实PG。

日志SHA `4690c05d57316a04c416824a87b189da38f34ed8659f8be11430d8074db503b8`；持久回执`artifacts/selfservice16-yida-owner-realpg-receipt.json`与下节同托管目录，SHA `fb5d8796d8fc36d953ff2f4b470ce791712cbe99f4cebeb52b86ed168c757594`。这补上当前候选的内部持久发送端口证据，不替代JWT HTTP授权入口、其它PG整文件、正式71项/Chrome交互或真实表单对账。无额外变异或独立新审查，不借此前Astra审查冒称它已审本临时驱动。完整目标继续active，未推送、重跑CI、合并、部署、客户读取或真实发送。

## 2026-10-17 原目标续推进：相邻宜搭合同及既有CI接线补验

上一轮属于实际进展（16口生产修改、真实JWT/变异/清理证据），不是等待或状态复述。当前发布检出和main均没有目标MD；从既有goals worktree重新读取原文§5/§6/§9，原SHA `410961bbe4fea14cbb2d04e6e52fb9e970f69f3b9e3a43c9a637da9b55f50c26`未变。原六批目标不缩为16口修复，不把大量历史阶段数字当当前结果。

只读核对当前`.github/workflows/plugin-tests.yml:1357`确实把`stock-preparation-read-plan-host-realdb.test.ts`作为整文件交给原real-DB job，未加testNamePattern；本轮16个真实JWT用例将沿已有接线执行，不需要另建workflow或CI切片。此为静态接线事实，**不代表未推送候选已经在CI执行**。

补跑当前Linux候选的15整文件：yida-token-exchange、token-client、static-plan、send-authority-primitives、readback-observation、owner-send-port、owner-runtime-factory、initialization-producer、form-transport、form-readback、delivery-store、delivery-runner、credential-material-store、approved-target-store及write-target-dry-run-runtime。实际`node --test --test-reporter=tap <15文件>` **409/409**，fail/cancel/skip/todo均0、exit0、无超时；原network/.env守卫16帧，禁止连接/环境读取均0；测试文件前后哈希一致。测试只使用原合成fetch/DB边界，不访问真实宜搭、凭据或客户数据。

该集合比先前10文件307项多了静态预演、token-client、owner runtime factory、初始化producer和dry-run；不是新增102项测试代码，也不能将409再与包含在内的307相加。亲读static-plan原测试`:322`的实际fetch零调用正控及`:346`的canApply降级拒绝，owner-runtime-factory`:36`的网络must-not-start依赖和默认false、初始化producer原合同，证明这些不是单纯按文件名推断的能力。它支持SA-04静态不可apply和SA-05默认关闭/合成发送边界回归，不替代真实PG并发、正式宜搭71项、新候选Chrome交互或真实发送授权。

日志SHA `8cbd51ac6fd63568498c46745094c95b7cb02752a41487d4ddc4b84ab7898e0e`；持久回执与下节同目录`artifacts/selfservice16-yida-nearby-final-receipt.json`，SHA `5d0710e33b02bc3c199e288cee32573b7ea3a641aff7d066f17ac9af01fe9762`。未改生产/原测试，无新增端点、推送、CI执行或部署。

下一交付门仍是当前五文件局部候选及独立GOV-08的审核/提交次序与正式CI；现行授权明确禁止推送和CI重跑，因此不自动执行。后续完整目标还须逐项核验SA-03其它已支持具名操作、SA-05真实PG状态机及SA-06消费者的当前冻结证据，不能用这次409或原71项代替。需要新增端点/消费者/授权合同的任何差异另走GOV-08，不能从自动goal续推取得扩权。

## 2026-10-17 已授权16口可信租户：本地修复及验证完成

结论：**fixed（当时仅本地候选）**。本节取代下方“待裁/未获批准”的当前状态，历史证据保留。当时冻结HEAD `dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395` 未变；先写独立 [GOV-08决策PR#6438](https://github.com/zensgit/metasheet2/pull/6438)，再按owner批准实施。无新端点/切片/迁移/权限/开关，不改全局默认；当时未提交、推送、运行CI、合并、部署、读取客户或真实发送。2026-10-18提交/CI授权及执行见顶节。

### 边界与最小补丁

旧JWT链允许无tenant claim的有效token通过header回填user.tenantId；W4 OFF时通用scope可能只与该回填值比较。K3非SQL绑定不经过SQL Connection owner resolver，单读、组合与probe均受影响。现在局部requireSelfServiceReadAccess保留原requireAccess在先，再验证真实中间件提供的authenticatedTenantId。7 configs+7 compositions+2 probes共16个既有handler全部直接接线；缺claim 403 TENANT_CLAIM_REQUIRED，显式user/body/query/params/x-tenant-id冲突或非字符串/空值403 TENANT_MISMATCH，错误不回显tenant值。未登录401、原权限不足403及原read/write分层不变。

没有改变全局JWT、W4默认、其它旧入口、workspace或owner模型；相同显式tenant可进入原流程，但原body allowlist仍有效，不能把“过租户门”误称“任意body合法”。合法claimless会话现在必须换取含已验证tenant的会话，这是获准的兼容收紧，不做header兼容旁路。

实际修改五个代码/测试/pin文件：`lib/http-routes.cjs`、`__tests__/http-routes.test.cjs`、`__tests__/k3-b4-http-source-run.test.cjs`、core的`stock-preparation-read-plan-host-realdb.test.ts`及`s6a-package-provenance-pins.json`。生产diff为局部helper及16次调用替换，没有其它生产模块修改。旧测试只显式补独立claim，不在公共测试invoke中从user自动伪造可信身份。

### 有序验证与实际结果

1. **语法/类型/封装**：`pnpm --filter @metasheet/core-backend exec tsc --noEmit`；`pnpm exec tsc -p scripts/tsconfig.recovery-archive-acceptance.json`、`scripts/tsconfig.stock-preparation-plm-full-app.json`、`scripts/tsconfig.stock-preparation-yida-synthetic-trial.json`均exit0。额外`tsc -p <临时宿主测试配置>`最终exit0：extends原core配置、仅改为ESNext以支持import.meta、保留原Node模块解析并补齐已有ambient声明。最初临时配置沿用CommonJS且漏ambient导致TS1343等；中间Bundler版本引出23条依赖类型错误。两次失败证据保留，未改产品/断言或降低类型严格度；最终配置SHA `895c91b0aece47e55e67a9134e2092488d04689ce0dd06baa8fff3186b3798dc`。
2. **真实攻击替代与正常控制**：原`stock-preparation-read-plan-host-realdb.test.ts`整文件不筛选，**23原测试+16逐入口矩阵+1隔离哨兵=40/40**，两轮无变异通过。使用真实AuthService签发/验签、JWT中间件、真实DB RBAC与注册宿主路由，不mock verifyToken。W4 unset/false均拒绝claimless+header；逐口覆盖foreign/duplicate query、foreign header、POST畸形body、坏签名/过期token/无token，8个write口真实reader角色403。拒绝时实际配置/审计/组合/外部系统/连接表SQL、source facade、解密调用均为零，values-free负例检查不回显合成身份。合法同claim控制进入原契约/存储（200/400/404，不谎称16个完整业务动作全部200）；原23项包括真实UI第二owner复用继续成功。
3. **有限变异**：内存删除局部门后运行16条真实JWT矩阵，**16失败、0通过**，其余24条有意未执行；不是整文件通过或结果注入。另在完整CJS路由测试执行23种内存变异：删除总门、信任user、依赖flag、漏header/body/query/params，以及逐一漏16个handler，**23/23被杀死**。原磁盘源码未改。该集合非穷举；不声明能防同进程恶意代码伪造可信req字段。
4. **最近回归**：`node --test --test-reporter=tap .../__tests__/http-routes.test.cjs` exit0，直接16口及畸形params/header等矩阵完成；该文件手动main在TAP中计1，不把内部矩阵虚增为TAP数量。K3原八整文件`node --test --test-reporter=tap <八个文件>` **130/130**，fail/cancel/skip/todo=0，含B4 HTTP67项、受审POST读取、分页、重定向拒绝及永久禁写。最终本地日志SHA分别 `45536827bfdba7840119bd73eca746b17eb9948d0ffb54fa887aec84b8d9e37a`、`4113b4bac8c580744d50cfd5fcac16ef2a8d1778b9bc1e820c8058814a8b09a1`。所有原网络/.env守卫计数为0。
5. **完整provenance**：`node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` exit0。使用实际computePackageProvenancePinSet核对全部66项，只有runtimeFiles.pluginHttpRoutes需更新；更新后0差异。被pin文件LF字节不做哈希前归一化，未改其它pin。日志SHA `3c48c585665b48e52a0994374a884944d9386c4e51822da0fd7c10644a482856`。

真实DB验证入口是本地`tmp/sa02-reuse-local-20261017/boot.sh`→run-local.mjs→worker.mjs，用户/网络/PID namespace、非root、仅lo、五capabilities全0；清空继承环境，新建owner-bound PG14、自产随机材料、发送OFF、原网络/.env守卫。462迁移完成；两次正常测试均40/40，最后日志SHA `f95550e1b09d76d388f5ace0755cbe3b06752fe9e8b3bd9f28381266aabc0829`。宿主正常close、PG stop、pg-*目录移除、自然exit0、原受验文件前后SHA不变；未改WSL时钟/同步服务，无客户库连接。这是隔离合成复用入口，不冒称正式CLI、宜搭固定候选浏览器或新head CI验收。

### 候选字节与独立复核

Windows发布检出与Linux受验副本下列五文件SHA一致；runtime为独立Astra ultra所审git blob `179495204e1075837f41a5d6788e1912d003925d`。

| 文件 | SHA256 |
| --- | --- |
| http-routes.cjs | `8eaa3e375b6ed2cb90213926a002e1ab66bfdfb8ccde7d667c17f05002b7a0f4` |
| http-routes.test.cjs | `3478ce0a8996801663bd88e477daa2e1578182b0021a87f2a69693043d9f72f2` |
| k3-b4-http-source-run.test.cjs | `eefbca23e70b526c0267c4afba53e46b44b731f8ce249f20647b1ce44b9c0bd8` |
| stock-preparation-read-plan-host-realdb.test.ts | `e6265711230c1fa0c7cf27fe91b1f4971f7bcf620a9ceb342d42741f2a02cae2` |
| s6a-package-provenance-pins.json | `880d5c13eb44f1fc7af096267909859afd8843089df49fd55aca83f67902a9cc` |

按fix-finding流程，独立Astra high前置调查与新Astra ultra补丁只读复核完成一次审查循环，无新增具体绕过/回归阻断。保留其提醒：正常scope到达原400/404仅证明可信租户门未误挡，不单独证明业务全成功。依靠原整文件业务正例与K3回归补充，而不夸大矩阵结论。

脱敏持久回执由Codex Security存储，目录`C:/Users/zen08/.codex/state/plugins/codex-security/scans/pr6337-ci-publish-20261016/artifacts-49fb3d64fc14ef1d27e0ee28e18e2759b7a6bb22b57cd042240e7b0a1bf984ce/artifacts/`：

- selfservice16-final-realjwt-receipt.json：`604ab3bcd9f2360ed688eb599767a1f4c4f0216387ab7cc5f66a93c7f65a095d`
- selfservice16-realjwt-mutation-receipt.json：`8c8a31c2c5840832d8c1e76f750490a73cdb40472bce762c4768eb27671dd953`
- selfservice16-mutations-receipt.json：`1347db13dcbf556755d588c010adc00d07b1ea8bd0724b44b91d95f4ad6d3f10`
- selfservice16-k3-final-receipt.json：`6834bb38bfb14e2336914674379c973f65a3cea34edaf6b30a069d8a29e6505d`
- selfservice16-ordered-checks-receipt.json：`a98d09f10e8526de3aa10425df58ae6da1182432f456036ba1c5febc78053159`（保留首次额外类型配置失败）；selfservice16-host-test-types-final-receipt.json：`57b48e106de1889673c8149685f9ae2938886f4e96e2f2088e29756e5db2cfbb`。

剩余边界：这只关闭获准16口的已知可信tenant缺口，不是完整集成目标完成或全平台安全认证。旧正式CI/宜搭71项/Chrome试用各属其原head，不替代新候选证据；本轮没有重跑正式71项或新浏览器试用。提交、推送、CI、发布与真实外部操作仍须独立授权；独立GOV-08文档与代码的未来提交/PR次序亦未执行。

## 2026-10-17 授权前安全独立工作：自助入口平行路径盘点

本轮未获得A的明确批准，不更改身份合同。亲读http-routes.cjs L6349–6498：组合run入口L6432只requireAccess(read)，L6450从scopedInput取组合，L6470按同scope取step read config，L6474取adapter系统；它与单读共享同一flag受控租户来源。externalSystemReadSmoke L6107起及externalSystemReadSourceProbe L6150起也用scopedAdapterInput。故只保护单读配置七口不足以保护自助读面，上一建议需订正，不能先做七口再宣称闭合。

用纯文本提取当前注册表并逐项核对handler，现有范围为7 configs+7 compositions+2 probes，共16口；有序method/route/handler映射JSON SHA `3d503e794f04596781b56ba8815ce313cf6663c0de985d58be560ddec2868ada`。不执行路由、不访问DB/凭据/网络。read/write分层仍保留（configs/compositions的save/approve/retire及两probe为write，其余read）；目标仅可信scope前置，不引入新权限或owner模型。所有类型共用这些接口，不能假称只影响K3。完整待裁方案范围见设计MD顶节，尚未创建独立ADR/PR或实施。

此前本地24/24复用、K3 130/130、宜搭307/307及正式CI/Chrome证据的各自范围不变。原完整目标仍active；不能以这些绿灯跨越尚未批准的GOV-08授权兼容决策。

## 2026-10-17 SA-03／SA-05当前安全独立核验

独立Astra ultra只读反驳已完成：在当前HEAD、flag OFF、有效claimless且有integration:read、目标存在approved K3配置和可用来源的前提下，未能推翻静态可达性。AuthService.ts L290只对含tenant claim的token查membership；jwt-middleware L101–108随后回填header tenant；index.ts L1535/1941传播后直接调用注册handler，没有补membership。read-source-config-store.cjs L362只验证给定scope/approved；external-systems.cjs L1061起只有sql-readonly才走带principal的Connection resolver，K3走Binding凭据路径；K3 factory L1808/read L2121不提供额外owner阻断。无攻击执行、真实环境读取或部署配置推断；保留为既有#6323风险，不改称#6337回归。

下一裁决建议A（尚未批准/实施）：只在自助read-source-configs接口族采用既有resolveVerifiedClaimTenantId，缺可信claim或显式scope冲突在配置/凭据读取及网络前拒绝；不更改全局W4 flag默认、不扩其他历史入口。无claim的合法账户须取得含已验证tenant的会话，不能用header兼容回退。该方案改变既有claimless授权兼容行为，PR模板L62的GOV-08要求独立前置决策；先请求owner裁决，不能夹入#6337收尾。本地合成真实JWT负例及针对性变异应在裁决后实施，不以当前fake-user HTTP测试冒充已覆盖。若owner要求保留claimless多组织用户，应另裁宿主membership证明方案，而非允许自报tenant。当前未创建新ADR/PR/端点、未翻开关或改代码。

继续保留原完整目标，不以SA-01/02本地复用闭合缩小为只交宜搭。当前Linux候选与dcc82a1发布检出6735相关跟踪非.env文件一致，未改生产代码或原测试。

K3原八整文件：k3-read-operation-profiles、read-source-k3-material-list-b4-contract、k3-b4-response-contract、k3-b4-source-run、k3-b4-http-source-run、k3-external-write-permanent-fence、k3-wise-redirect-fence、k3-wise-material-presets。净化环境、原Node网络/.env守卫，只合成依赖/自有loopback HTTP，**130/130**、fail/cancel/skip/todo均0、exit0，9个守卫帧中禁止网络/环境读取均0。显式TAP输出SHA `3153aebf6f40caf394d438606c096459d5cf66eb9e76628786a8896226372206`。第一次同8文件exit0且守卫零，但默认reporter计数未被TAP解析器识别（null），未报计数通过；随后只为固定输出协议显式TAP运行，不修改断言、不把计数null解释为失败或业务修复。K3永久写围栏、受审POST读取、分页合同、原生fetch重定向拒绝及内存批准守卫变异属于本证据范围；不证明真实JWT/租户membership链或客户K3兼容。

宜搭原十整文件：yida-owner-send-port、yida-credential-material-store、yida-send-authority-primitives、yida-delivery-runner、yida-delivery-store、yida-approved-target-store、yida-token-exchange、yida-form-transport、yida-form-readback、yida-readback-observation。**307/307**、fail/cancel/skip/todo均0、exit0，11守卫帧禁止网络/环境读取均0；测试文件前后SHA未变，输出SHA `4764905b6be2eeaa756288e3c7a124b165d31db00b405daca607b851fa75c909`。正例发送/token/readback均为合成fetch边界，不访问宜搭；原用例覆盖默认OFF、精确开关、一次授权、abort/timeout/回拨、未知结果不重试及有限回读合同。不将内存DB合同替代真实PG并发、正式71项或真实客户/宜搭验证。

可信tenant残余风险仍在当前源：jwt-middleware.ts L101–108保存可信claim但兼容回填user.tenantId；http-routes.cjs L6274的readSourceConfigsRead经L6300起getForRuntime(scopedInput)与scopedAdapterInput取K3配置；L1569的scopedInput调用L1345 resolveTenantId。L1541的assertVerifiedTenantClaim受L1634默认OFF开关控制，L1238 requireAccess本身只检查权限。故上述130/307或宜搭专用可信JWT路径不支持“所有自助入口可信tenant已经闭合”。此为前期已记录的继承风险，不是本轮新增回归；不读取真实部署flag、不执行越租户攻击、不趁#6337收尾翻全局默认。改变K3自助入口的兼容授权合同须先按GOV-08单独裁决，再写实现和真实JWT负例；当前尚未取得该新增授权边界裁决。

仅本地MD续记。未新增产品切片/外部动作、推送、CI重跑、合并、部署、客户访问或真实发送。

## 2026-10-17 SA-02第二owner／第二布局：当前源码本地执行闭合

本节补上此前“仅有测试定义、尚未取得当次执行事实”的本地缺口，不改写公开CI日志读取失败。当前HEAD仍dcc82a1；Windows发布检出与Linux受验源的core/web/plugin/ops/workflow及根workspace文件共6735个跟踪非.env文件，收尾逐SHA比较全部相同、0缺失，未读取.env。运行前五项直接受验文件逐SHA也全部一致，运行后五项未变。

只在Linux源码tmp/sa02-reuse-local-20261017中新增临时验收包，不修改原产品/测试/CLI：boot创建新user/net/PID namespace，只启用loopback，降权后实际验证非root、独立netns、仅一个lo及五种capabilities全0；复用现有owned-PG helper和原Node网络/.env守卫。显式白名单子进程环境只注入新建PG地址和自产随机加密/JWT材料，发送与durable delivery OFF；没有继承数据库地址或真实凭据。与正式CLI隔离合同是不同入口，回执明确formalCi=false，不冒称原CLI正式acceptance或固定候选浏览器验收。

实际462迁移成功（日志SHA `437c779f10a62dbc83f59d8757d1dba4e4e457cb2714e05594087b949a091703`）；原host-realdb整文件不筛选、不改断言、不注入结果，**23项原测试+1项外加隔离哨兵=24/24**，failed/notExecuted均0。第二owner原用例恰好1项且pass，SA02Q_SECOND_OWNER_REUSE完成标记恰好1次；forbiddenConnections/forbiddenEnvReads均0。完整测试日志只保留本机私有文件、不读取输出原文，SHA `87ef48ae4493ad2cd70ba7f021ee9911710d48a9c26e53a402c329907b263a9a`。

真实整链覆盖前浏览器下载→新owner/tenant/private Connection与七种不同物理表列→UI导入只改配置→目录/样本校验→显式确认→批准/激活→预览。断言根物料P9与订单BOM B7不混同、根数量4/子数量20、原owner不可访问、原激活/版本不变、源及业务表快照不变。使用原helper选择的本地Playwright Chromium，执行前固定检查二进制SHA `2e61bc3fd990bd4d7b419ef6b6303c67aaed683e5b83b3b25e416f015f343209`；不是宜搭固定upstream-1719529候选，也不是Chrome密码登录验收。

原测试宿主清理及Vitest.close完成，外层owned PG正常stop；pg-*目录移除，namespace父命令自然exit0，无强杀/重试。脱敏回执位于Linux源 `tmp/sa02-reuse-local-20261017/9227a9a6-d4c8-4378-ad68-3b5e9429faba.receipt.json`，SHA `1759557f7d31e476347130974af1e293549e11df29bab93b2f9d5ac610d63ac7`。保留诊断目录，无手工递归清理；没有单独声明未测量的浏览器进程残留计数。

Astra ultra同一只读代理补审四个验收文件：无新增阻断，确认原整文件、无结果替换、清洁环境/自有PG/namespace/0caps、清理失败致红；特别要求计数区分23原测试与1哨兵，以及五文件未变不能单独代表整树。本节另列6735文件收尾对照，不掩盖边界。审查未运行测试、写文件或读取私有日志。

裁决：SA-01/02最低纵切片的本地生产路径与复用执行证据已补齐；不是完整六批目标已完成，不证明并行多租户、客户MSSQL、客户数据对账、现网迁移或发布。公开CI具体第二owner用例日志仍未取回，不能将本地24/24当正式CI计数。没有推送/重跑CI/开PR/合并/部署/客户读取/真实宜搭发送。

## 2026-10-17 SA-02复用验收入口复核（尚不签本轮执行通过）

独立只读复核已完成：`gpt-6-astra` / `ultra`，任务sa01_sa02_closeout_readonly，冻结同HEAD；未写文件、运行测试、访问客户或读取凭据。裁决无新增产品阻断，未发现为满足SA-01/02最低退出条件而必须新增实现的项。错误配置链：validation-read.cjs L147/163/177拒目录不匹配/异常分页/不完整展开，management.cjs L178起真实reader成功才完成收据、异常转失败；store.cjs L236的批准requireConfirmed经ledger.cjs L155检查同actor/Connection/binding修订与确认状态。host-realdb L501起验证未测量/未确认不可批准。第二owner导出白名单及去身份句柄见browser helper L565，导入零POST见L718，版本/数量见L750，源目标/原owner状态不变见host L1133。该审查是代码与测试定义核验，不伪称执行回执或当前逐守卫变异已完成；第二owner当次执行仍待签。

续核：使用45秒上限的独立子进程读取同一公开job日志，两次均timeout；第二次按大小写清除子进程HTTP/HTTPS/ALL代理变量，未修改用户持久环境。现有GitHub连接器也返回读取错误，没有取得日志正文/私有产物，未重跑CI。三个请求均已终结，不保留伪监视等待。此前291/291的11套测试当前SHA逐一匹配11/11；fcb20→当前HEAD的plugin生产目录、web目录、core src目录无Git差异。这支持已有回归证据连续性，但不代替第二owner用例的执行事实。

当前HEAD仍为 `dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395`。亲读host-realdb套件L1046–1163和browser-acceptance helper L622起：已有第二owner/第二tenant及独立Connection、七组不同字段布局、第一浏览器下载文件的真实UI导入和修改、重新验证/确认样本/批准/激活/预览。独立断言BOM版本B7、物料版本P9/P3及数量4/20；原owner访问拒绝，来源/业务表不变，原版本与原激活不变，新的回执/版本/预览token绑定第二owner。不是缺功能，不能另造向导。

workflow plugin-tests.yml L1357已将整文件接入既有lock-protocol real-DB步骤。尚须核对本轮公开日志中用例成功及SA02Q_SECOND_OWNER_REUSE完成标记；仅步骤成功/登记行不能替代具体用例证据。本轮只读公开日志请求已终结，返回PUBLIC_LOG_FETCH_FAILED，未取得可计数正文；不签具体用例通过、不重跑CI。该取证失败不撤销此前已取得的整轮正式CI结果，也不证明测试失败。

边界：该测试继承DATABASE_URL并创建schema，本轮未直接启动它、未读取继承地址或提供任意数据库地址。浏览器helper使用测试自产token注入localStorage，是真实组件/HTTP/宿主路径，但不是整站密码登录；其chromium.executablePath()也不是公开trial中固定候选的同一入口，不能混称固定候选验收。文件SHA256：host-realdb `8b05eff465b54870239b627cf1eecc4842071b21c15f3bbd8d0a36918b281e29`；browser helper `f32ae082eaee3d007435059cefe9fc5da944b59c72271d9309b26ee9c953e7fb`。未改生产代码、测试、权限或浏览器选择。本节仅本地MD续记，完整目标未标完成。

## 2026-10-17 Chrome单次合成试用完成：初始化、两行预览及带连接停止清理

本节终态覆盖下方“进行中/Chrome未连接”的历史状态。原草稿#6337仍OPEN/draft，远端head `dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395` 未变；同head run39025079404正式success及71项/SQL/传输/停止证据见下文。Owner明确授权Chrome合成初始化和两行推送预览，未授权客户读取、真实token/发送、合并或部署。

实际入口为原公开run-stock-preparation-yida-synthetic-trial.mjs，非root Linux runner、PG14、TTL900、净化环境、全新owner-bound临时库、发送强制OFF；未替换构建/迁移/认证/guard。启动前发布检出与Linux受验源6577个相关非.env跟踪文件逐SHA全部一致；未借旧构建启动。只在内存读取本次READY标识的合成交接文件，校验syntheticOnly/localSyntheticTrial/defaultOff=true及TTL和loopback登录入口，不输出随机密码、不读.env或真实凭据。

Chrome扩展绑定已确认，使用单独新建试用标签。首次新标签创建后的观察中断，但随后只读列表证实标签已存在；重新绑定同一标签继续，未再起环境、未新增重复标签、未重发业务POST。初次绑定变量未建立仅产生工具赋值错误，无业务请求。通过正常账号/随机密码UI登录，执行页面明确确认的“当前租户”切换，打开已有合成项目；未点击PLM拉取/同步、Automation执行或单行发送确认。

实际页面链：宜搭静态预演→协议v2→七项身份合成样例A→只在本地预演；结果2行、计划创建2、更新0、无效0、本地重复键0，canApply=false、远端未核验。行中0数量保留，第二行通过父件角色形成不同本地身份；这是预演候选，不是远端创建成功或幂等证明。随后打开本地初始化，手动GET确认空槽，仅输入本次自产假材料/假审核编号/假组织并人工确认，单次点击本地初始化POST。提交过程中短暂unknown状态未触发重试；后续页面明确已初始化，再次手动GET确认同一2行草稿以及canSend=false/tokenIssued=false/externalWriteAttempted=false，无grant/发送许可。

保存本机合成截图（无登录口令/输入材料，不上传PR/CI）：

- `E:/Projects/metasheet/tmp/pr6337-chrome-trial-20261017/initialization.png`，SHA `7946e45d775501cc316350cb76b01ca996524844123d916e32154f18eaba66ec`，显示初始化成功、2行草稿及三个false。画面中仅临时合成身份/编号，不是客户材料。
- `E:/Projects/metasheet/tmp/pr6337-chrome-trial-20261017/two-row-preview.png`，SHA `276523600cb00f64804e902a4f35d385649225fcf4f57cd1f5001ae20bc71d9e`，显示2行统计、canApply=false及data-fields-only/远端未核验边界。

真实停止：Chrome页面保持连接时，通过原CLI stdin发送stop一次；原exec session16853以exit0终结，公开STOPPED帧ownedDatabaseRemoved=true、prototype=false、localSyntheticTrial=true、acceptancePassed=false。原受审脚本正常执行host.stop→preview.close、pool ended/address null、构建回执/guard复验与owner-bound PG stop，并非kill/删库替代正常宿主停止。宿主再实查本次scratch的pg-*目录0、trial.private.json已移除；未手工删除目录。之后关闭仅本次创建的Chrome标签，并清空工具内合成材料引用。保留诊断目录与构建回执供复核，不读取/复制其中私有原始日志或凭据。

本轮Chrome交互合成验收已完成，但公开CLI自身acceptancePassed=false准确保留：它不是完整隔离正式验收入口；bootstrap parent及普通Chrome网络未获得kernel isolation attestation，服务器侧原guard成功不冒充整个浏览器零网络证明。正式隔离71项/PLM及停止证据来自同head CI，两类证据不互相替代。本轮没有真实宜搭查询/token交换/发送、客户读取、业务同步、推送、CI重跑、合并或部署。原完整自助适配目标未标完成，SA-01/02第二owner/第二物理布局等独立证据范围与剩余发布裁决继续按原目标审计，不由本轮两行预览替代。

## 2026-10-17 Chrome重新连接后的单次合成试用（进行中）

Owner明确要求重新检查已连接Chrome并继续原合成初始化/两行预览；无合并/部署/客户读取/真实发送授权。cua实时清单已出现Chrome family=chrome/type=extension，绑定原返回browser id=3并命名本次会话，未读取其它用户标签内容。重新核对run39025079404/dcc82a1de仍completed/success。公开CLI及typed入口、core/web/plugin/ops等6577个非.env跟踪源与Linux独立源逐SHA全部一致；Linux唯一相关untracked浏览器candidate模块也包含在发布检出逐SHA匹配集合，不是额外未审来源。

已调用原公开CLI（非root runner、PG14、全新owned库、TTL900、净化父环境、原默认OFF/网络与.env守卫）一次，当前exec session16853处于构建/准备中，尚未收到READY或操作UI。不得另起重复环境；后续必须记录真实READY、正常密码登录、初始化/两行静态预览及公开STOPPED/自有PG和交接文件移除，未完成前不预填成功。本段仅本地续记，不再推送/重跑CI。

## 2026-10-17 本轮正式CI成功；Chrome未连接，未启动交互环境

Plugin System Tests run `39025079404` attempt1 / test(20.x) job `117374375899` 已completed/success；run与当前PR head均严格匹配 `dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395`，PR仍OPEN/draft。98固定官方浏览器、100前置锁协议、101 PLM manual/interval、102宜搭、110后置SQL及121晚期attendance均success。只读公开job日志70142行，LF拼接SHA `1f0ed3775ba4837f6038217c87697f880b0d52d31c8587f5c4982a28b0644b86`；先剥job/step列和ANSI，真正大写FAIL头扫描中晚期失败0，family-4实际成功行1，原atomic-binding文件实际成功行存在。不将预期负例console内的failed字样误当失败。

后置SQL正式汇总：266文件通过，3102测试通过、2跳过、0失败；SQL取消闭合帧0。family-4候选字面量v4、独立两consumer/payload/回滚等原检查保持，晚期整步成功补齐原run39015466444缺口。本地两轮11/11和两类变异各五条红仍为各自证据，不与正式CI计数混算。

同head PLM manual/interval两条RESULT均passed、failurePresent=false、cleanup=stopped-and-owned-database-removed、sourceFiles=6588，回执SHA分别 `38a32629477aab50dab7d68311badb8ea103d9a6d327678957222d0373ed9eb0` / `2876a4813b5a50c7de791a02799fd8b8b87e6c5be94b90af6bbf50f2b9b957c0`。actual-stop-resolved=2、actual-stop-failed=0、production-stop-failed=0；360条transport帧内ABORTED/ABORT/signalAborted均0，SDK/PLAYWRIGHT POST202 BODY_DONE complete各1，PROXY DOWNSTREAM_FINISH/UPSTREAM_COMPLETE/UPSTREAM_END complete各1。宜搭闭合RESULT passed=true、71=66业务+5哨兵。清理依据受审runner强制校验后公开闭合帧，不读取私有产物或凭据；本轮正式浏览器/宜搭/SQL/停止清理门已闭合，不反向宣称全部历史风险唯一根因已证明或完整自助集成目标已交付。

试用前置实查：已完整阅读computer-use技能及guidance/confirmations，阅读现有公开trial CLI，检查MD未对本head重复开启试用。cua.getState实际清单仅内置浏览器与MCP Apps，无Chrome、无已连接Chrome扩展入口。依owner“Chrome未连接不得启动短TTL环境，不擅换浏览器”的条件，未创建PG、未启动trial CLI、未读取任何交接文件/口令、未打开业务页或点击初始化/预览/发送。不能把CI内浏览器合成成功称为Chrome人工试用已完成；需用户连接Chrome后才继续已授权的单次合成初始化和两行预览。

本轮跟踪按终态约定停用；本节仅本地续记，未再推送。无新增切片、自动重跑、合并、部署、客户数据/凭据读取、真实token交换或真实发送；既有lease、ABORTED、SQL超时、WSL回拨历史证据继续保留。完整原目标仍未标完成：SA-01/02第二owner/第二布局等各自当前生产路径证据不能由本轮宜搭71项代替。

## 2026-10-17 family-4 修复获准推入原草稿与既有CI

新head正式SQL步骤已通过：run39025079404 attempt1/head dcc82a1de的step110 completed/success；98固定浏览器、100前置锁协议、101 PLM manual/interval、102宜搭步骤亦success，当前step111仍in_progress，暂无失败job。晚期attendance/family-4尚未核验，公开日志闭合71项/ABORTED/actual-stop与清理结果仍待读取；整轮未结束，不提前启动Chrome或宣称本轮完整通过。

执行后本地续记（未再推）：三文件staged blob与受验原字节逐一一致、diff --check通过；commit `dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395`已正常fast-forward推入原草稿，保持OPEN/draft与原base/head分支，仅dispatch一次既有plugin-tests.yml。新run `39025079404` attempt1、event=workflow_dispatch，严格head匹配；test(20.x) job `117374375899`已in_progress，整run仍queued，其余job尚queued，未计任何目标通过。原6337-ci每10分钟heartbeat已更新为本轮run/head并恢复ACTIVE，不重复建监视器；只通知有意义变化，终态核证据后停用。保留原晚期断言/SQL/浏览器历史证据，不据本地或旧head绿启动Chrome。未新增切片、额外推送、合并、部署、客户读取或真实发送。

Owner明确授权本轮三文件（family-4版本断言+两份既有MD）推入原草稿#6337并运行既有合成CI；不新增切片、不合并/部署/客户读取/真实发送。执行前远端仍OPEN/draft、head=0a8634fd35bb0e651db490eb65f418429def0bc2，原base/head分支不变，本地仅这三文件改动。候选测试SHA仍d4f2d53793db640f01b5fa81f2035090a40235014965a482438b3bb0dafaab3d，本地两轮11/11及两类变异各五条致红、临时库清理证据见下节，不替代新head正式CI。

仅精确暂存三文件、逐一验证index与受验工作副本原字节一致后正常fast-forward推送；不force或转正式。仅dispatch一次既有Plugin System Tests，记录正确新head/run。新head正式门包括晚期family-4版本断言、后置SQL、PLM manual/interval、闭合POST202完整传输/ABORTED、实际停止清理及宜搭71=66+5；pending/skipped不计通过，不借旧run成功冒充新head。整轮成功、当前PR head仍匹配且全部证据齐备后才安排一次Chrome合成初始化/两行预览；真实发送OFF，不点击发送、不交换真实token。Chrome未连接不启动短TTL环境；无额外推送、重跑或系统时间同步变更授权。

## 2026-10-17 获准本地修复 family-4：两轮整文件通过、两类变异被杀

Owner明确授权现有#6337内最小修复版本断言、保留消费者/完整性检查、本地合成及变异验证和MD；不推送、不重跑CI、不新增切片、不合并/部署/客户读取/真实发送。代码仅原family-4测试共用断言3改4及两行注释；静态按HEAD原块精确替换后与候选全文比较为true，生产源码改动0。候选文件SHA `d4f2d53793db640f01b5fa81f2035090a40235014965a482438b3bb0dafaab3d`，Windows发布检出与Linux受验副本原字节一致。显式版本期望保留，不改为跟随生产常量自动求值。

本地新owner-bound PG14完成462项迁移，迁移输出SHA `437c779f10a62dbc83f59d8757d1dba4e4e457cb2714e05594087b949a091703`。子进程仅允许列表环境，真实宜搭发送false，原native网络/.env守卫；原整文件不做名称过滤、无跳过。运行依次为：

- baseline：仅内存将候选版本期望还原3，生产模块不变；6通过/5失败，五条均4对3版本错配，变换恰一次，精确复现正式CI的五条失败。日志SHA `35c1be5eef46f0a396d78e889f5e234c1d5d4624263ae40b01cf7223bdf7b049`。
- candidate：无变换，11/11（10原文件测试+1外置隔离哨兵），0失败/跳过。日志SHA `21b47fc8a8667209ca2472a6c0c48d61845f37a98b67e864a5930e775b4e41ed`。
- wrong-version：仅内存变换真实生产enqueue的入库版本参数为3，不改变测试期望或数据库返回值；6通过/5失败，五个ON入口均3对4断言致红，变换恰一次。日志SHA `02d56604d33747af731cf87402fa5dcb99bf0de0e03a7b574a0430f28d88d06b`。
- missing-consumer：仅内存从真实生产enqueue的路由展开结果删去webhook-event-bridge，不改变测试或查询结果；6通过/5失败，五条错误的expected包含该consumer而actual不含，变换恰一次。证明版本修正后独立fan-out守卫真接线，不是被版本错误提前兜住。日志SHA `241d9f98fee8948cfc61b4744c70dc53c2bfbefa8189f3ebb9dc3859eca401ca`。
- final：无变换再跑原整文件，11/11、0失败/跳过，日志SHA `2f74e50c6441ec3f407d36441c48932050f5b76b14b51b268485b1f41d64b616`。五轮均无unrun、出网/.env违规均0；测试依旧走真实RecordService/RecordWriteService与实际PG写入，ON/OFF、冲突回滚、payload、eventId、depth、零/单条outbox及两消费者pending检查均未删减。

闭合：受验三文件SHA前后不变，owner校验stop成功、owned PG移除，宿主只读检查该scratch下pg-*目录0。整轮脱敏回执SHA `9cf02410ca42be9fe1ff1c2e3302c3392c9d1ee5f1ad8ffbcf9dd54fab7216cc`；只复制此回执至tmp/pr6337-proxy-drain-local-20261014/family4-local-20261017并核对原SHA，未复制私有日志/报告/.env。临时工具位于Linux source/tmp/family4-local-20261017，不进入发布改动。

范围与门禁：本地仅原测试+两份既有MD，未提交/推送/重跑CI。正式CI仍为0a8634/run39015466444晚期失败；本地通过不能冒充新head正式绿，旧head宜搭71/71及停止清理证据保留。Chrome条件试用尚未启动，需后续明确授权推入原草稿及既有CI后，以正确新head整轮成功及71项/停止清理证据判断；本轮不自动采取该下一步。

## 2026-10-17 本轮正式终态：目标链路通过，晚期断言仍阻断整轮

终态后的只读定因补证：五个真实FAIL窗口均精确命中固定断言分类expectedFourToBeThree=true，不输出原日志或业务值。生产automation-outbox-enqueue.ts L65默认CURRENT_ROUTING_MANIFEST，L89-91将manifest.version写入outbox；automation-routing-manifest.ts L200-208新增v4只展开v3旧路由并增私有只读事件，CURRENT明确为v4。测试共用expectDurableRow在L116仍钉3，L117继续独立钉两项record fan-out；五个ON路径均在版本断言先失败。workflow L2192将该文件登记于晚期attendance步骤，故早先multitable步骤成功不能替代它。由此确认本轮五条失败为同一旧版本测试期望，不是新出现的SQL超时、ABORTED或停止失败；尚未修改/执行候选，不能宣称更新版本后其它断言必绿。建议仅更新显式版本期望与注释、保留独立两consumer/payload/事务断言，先运行原整文件并做错误版本及缺consumer变异，再另申请推送CI；本轮授权未扩展到这项新修复。

已按授权将三文件推入原草稿，head `0a8634fd35bb0e651db490eb65f418429def0bc2`；run `39015466444` attempt1 / test(20.x) job `117346576987` 最终 completed/failure，当前PR仍同head、draft。固定浏览器、前置锁协议、PLM manual/interval、宜搭与后置SQL步骤均success。公开日志70247行，LF拼接SHA `0eeb903fbf81867ae982d31daa7dd252693af924588fee4ba4ff886221dba59d`；未读取私有产物、凭据或客户数据。

后置multitable real-DB正式汇总：266文件通过，3102测试通过、2 skipped；原atomic binding测试文件存在实际成功行，SQL取消闭合帧0。此为本轮统计准备补丁的同head正式证据，不是仅借用本地40/40；两条skip不记作通过。

PLM两条RESULT均passed、failurePresent=false、cleanup=stopped-and-owned-database-removed、sourceFiles=6588，回执SHA分别 `13919f0cd41dcbdf886e0f6ad4dbd22ce026b47fe5a2bfa9bf04c1c14c6e7aa8` / `91d6832bd2a855ec853ca882dd279267acc01fb42b2a97fab22989b531beee7d`。actual-stop-resolved=2、actual-stop-failed=0、production-stop-failed=0；336条transport帧内ABORTED/ABORT/signalAborted均0，SDK与PLAYWRIGHT POST202 BODY_DONE complete各1，PROXY DOWNSTREAM_FINISH/UPSTREAM_COMPLETE/UPSTREAM_END complete各1。宜搭正式RESULT：passed=true，71=66业务+5哨兵。清理来自受审runner强制校验后的公开成功帧，未读取私有清理产物。旧ABORTED、lease、SQL超时与WSL回拨历史证据仍保留，不宣称全部历史根因消失。

新增阻断在step121（Run attendance integration tests）：严格大写FAIL头对应5条断言，全部位于 `packages/core-backend/tests/integration/multitable-automation-producer-family4-realdb.test.ts`，均为AssertionError，非statement/test/hook timeout；窗口含manifest_version。只读源码L116仍钉manifest_version=3，生产 `src/multitable/automation-routing-manifest.ts` L201已定义version=4；当前证据指向清单版本断言漂移，未通过修改断言或重新运行来证明最终修复，不擅改生产语义。失败窗口SHA依次 `875a6b76c7bb971db050f90ded4f4a5af44970cca0e1bbb45a6be5a0dbac6ced` / `f082b6a52673c8168d6a15097370da1191a22f39cd7752933a2e3fc8444ad81a` / `d6b7b0adbe86055add92b3082164bb159faab69629e729ae3e74e2465ff6e2b8` / `c5876bc70f930bb11eec2365025f462a0a09566357d6a981eda0d5b3bc03c789` / `2df33548600749fbce766c5de66abebe3f7c02313be928cf757190165cc85367`。

整轮未绿，原条件授权的Chrome合成试用未启动；不以目标步骤成功替代整轮门禁。终态报告后已暂停6337-ci跟踪，无自动重跑、额外推送、合并、部署或真实发送。本节仅本地续记，未再推送；新增断言修复需另获授权。

## 2026-10-17 本轮三文件推送与既有合成CI授权

后置SQL正式步骤已绿：同head0a8634fd3/run39015466444的step110 multitable real-DB已completed/success，98/100/101/102亦success，后续step111仍in_progress、整轮未结束。补丁已通过本轮正式SQL步骤元数据验收，尚需公开日志确认实际目标用例、取消帧与71项/停止清理结果；不能据此宣称整轮成功或所有历史SQL根因已消除，未启动Chrome试用。

后置SQL步骤已启动：同head0a8634fd3/run39015466444的step110 multitable real-DB现in_progress，正式执行包含本轮统计准备补丁的原测试；98/100/101/102均success，暂无失败job。尚不把执行中、旧head或本地复现通过当作本轮SQL完成，继续等待最终日志与停止/71项证据闭合。

宜搭步骤正式状态：同head0a8634fd3/run39015466444的step102已completed/success，后续已推进至step109；step110后置SQL仍pending。尚需可用公开日志中的71=66+5结果、ABORTED与actual-stop/清理帧，以及后置SQL正式成功，不据步骤元数据单独解除试用门禁。

PLM步骤状态变化：同head0a8634fd3/run39015466444的step101 manual/interval已completed/success，step102 owner宜搭JWT HTTP/browser real-DB已in_progress，step110后置SQL仍pending。此处只确认步骤元数据，不将尚未读取的71项、ABORTED或actual-stop/清理闭合帧当作通过；整轮仍in_progress，未启动Chrome试用。

最新正式推进：同head0a8634fd3/run39015466444的step100前置锁协议real-DB completed/success，step101 PLM manual/interval已in_progress；102宜搭与110后置SQL仍pending，暂无失败job。不借前置通过推定ABORTED、实际停止或71项已通过，旧风险继续保留。

正式目标推进：同head0a8634fd3/run39015466444 attempt1的step98固定官方Chromium安装已completed/success，step100前置删除/指针锁协议real-DB已in_progress，step101 PLM、102宜搭、110后置SQL仍pending，未见失败job。安装成功不代替ABORTED、实际停止清理或71项结果；旧lease/SQL超时风险仍保留。

执行后本地续记（未再推）：精确暂存三文件，staged blob与受验原字节一致；commit `0a8634fd35bb0e651db490eb65f418429def0bc2`正常fast-forward推入原草稿，OPEN/draft/base/head分支不变。仅dispatch一次既有plugin-tests.yml，run `39015466444` attempt1，test(20.x) job `117346576987`，head严格匹配；最新目标job已in_progress至早期flag合同，98/100/101/102/110仍pending。同head自动Integration Guard为run `39015449458`。复用了原PAUSED的6337-ci heartbeat，更新为本轮run/head并启用，每10分钟只读检查；不建重复监视器。仅有意义状态变化通知，终结即核证据并停用；正式整轮成功且所有门齐备才安排本次授权Chrome合成试用。旧失败、40/40本地与正式新head证据仍严格区分。

Owner已明确批准将本轮测试统计准备及两份既有MD推入原草稿#6337，并运行既有合成CI。推送前只读核验远端仍OPEN/draft，head=ad9056f888e44da9e1f01359c2c9c84e63fbe844，原base/head分支未变；本地仅这三文件有改动。授权不包含新增切片、合并、部署、客户读取或真实发送。

执行前精确暂存并比对staged blob与受验工作副本原字节，原测试候选SHA仍3afafbbc...6a349；正常fast-forward推送，不force或转正式。正式CI证据必须绑定新commit/run，不能借本地40/40、旧head宜搭71项与停止清理证明补齐。仅正确同head整轮成功且SQL/Chromium/宜搭71项/实际停止清理证据闭合后，才执行本次授权的Chrome本地合成初始化和两行推送预览；不点击发送、不交换真实token，Chrome未连接时不启动短TTL环境。

## 2026-10-17 新授权后的失败清单纠偏（覆盖下方“三个失败”历史表述）

### 本地最小修复与合成证据

本地代码仅测试8行新增：原子聚合前固定ANALYZE七张夹具表；候选SHA `3afafbbc9444f52fe7b5877830f48ce1716716e904b391b4d664e35703a6a349`，Windows与Linux受验源相同。原8秒预算、SQL哈希b60d8c...15ed、5001/5000+1、256/4744及same_xid/exact_binding断言均未改；生产代码、schema、权限、浏览器与发送配置未改。

负例：原源e2b509整文件先12/12，再在同一PG14上对清理后的已分配表页做空表ANALYZE并在该owned合成库关闭表autovacuum，目标实际1失败/1隔离哨兵通过/10过滤，原SQL8000.88ms被真实57014取消。诊断保持数据与SQL不变，仅刷新统计后同语句21.20ms得到total5000/same_xid=true/exact_binding=true，再重抛原错误，负例未被修后绿灯覆盖。前计划主要Nested Loop估1行，后Hash Join估4999；诊断计划回执SHA `28e8a90fb232c43448a090cad4e75ea17e2dbc06a55cfb36e1e9b9120fe64178`，整轮回执 `9cacf14c63bc552bc1e41ccfd9505414e47b627fabc6c3700a98f4b49ca3a2a5`，owned PG移除、源未改、隔离违规0。此为同类统计机制复现，不是伪造57014或pg_sleep，亦不冒称CI原始计划已被采集。

候选：新owned PG同462项完整迁移后，整文件12/12、0过滤；清理后重复相同残留统计实验，目标2/2、10过滤、取消帧0，原语句22.19ms，计划Hash Join估4999。计划回执SHA `7e753093b8154099691191be59de3a615b1c5ce2488282452011cf857b6b8cf2`，整轮 `4742938f8ee081029e1e67dbc390e3159e033f310f6e5f2a446b4481c1e6e458`；隔离违规0、源未改、owned PG移除。严格noEmit单根诊断116→116指纹集合不变，回执 `5e5809beb15e3fe71f5dbdc6e32e0b0ede7b0eb9fb9f5b7726326babc15785d9`；不是整包类型全绿。

额外AI/button回归首轮未通过，保留回执 `4ca1b1c7c4c3e2d74b861a1d54de227c9ef42dcf1d5ad9cd282c86683087a966`。业务请求均在Supertest同步读取临时listener的address().port时失败，错误哈希 `e973c1b7f7dfed39335e30c8d30c088a4773e02d631a7bb0e8163ee2cfa55f6e`精确等于null listener port错误；未执行到路由，不算业务回归通过。仅本地tmp工具将Supertest的隐式listen(0)固定到本进程loopback，并对原guard已允许的唯一literal地址做同步无需DNS回调；未扩大出网集合、未改正式测试。原失败与清理成功回执保留。

工具修订后的新owned PG完成同462项迁移，原三整文件依次实际12/12、19/19、9/9，总40/40（37原测试+3隔离哨兵）、0过滤、0失败、隔离违规均0；SQL取消帧0、受验源未改、owned PG已移除。整轮回执SHA `c04e60d53eee70f1989a0a735264f73d3ee004f7adfdd73fbc581dc5a325926f`；三文件日志SHA依次 `adb765cf52fa552ab9314a740d2a158a422b75020d25ce13c69cbbbc59bbe4a8` / `9051c10d5eb0670ffbca87f7be1059a5071a17ac13625ac944364994bc233344` / `fd42906002458c727fefce90b8444c677e9ce2032bf0ed986ef40101ba6902e9`。本地脱敏回执与计划副本存于tmp/pr6337-proxy-drain-local-20261014/post-ci-local-20261017，复制后逐SHA核对；不复制私有日志、报告、凭据或.env。负例/候选/工具失败/最终回归四轮对应scratch均实查pg-*目录0。

最终范围：未提交改动仅原测试与两份既有MD；主检出用户artifacts/reviews未动。git diff --check通过，原聚合SQL哈希、8000预算、5000原子绑定与256/4744断言均核实未变。未推送、未重跑CI、未合并/部署/真实读写；远端仍ad9056旧CI失败，不以本地通过改写正式CI状态或启动原条件要求“整轮正式CI成功”的Chrome试用。宜搭71项正式通过证据仍属于ad9056，不冒称候选另跑71项。

Owner授权在现有#6337本地复现、最小修复及合成验收，不推送/重跑CI/合并/部署/真实读写。重新核准日志发现此前PowerShell `-match` 默认大小写不敏感，将成功测试标题里的fail-closed误当成大写FAIL，后续预期负例日志又被错误归到失败窗口。此前把AI bulk preview缺表负例、button audit负例列为另外两项阻断的结论撤回；相应窗口哈希仅证明曾读取该窗口，不证明其为正式失败。

改用 `-cmatch` 严格大写FAIL、排除最终ERR_PNPM命令回显后，正式失败头仅1个：multitable-recovery-record-after-image-realdb.test.ts。公开汇总为Test Files 1 failed / 265 passed，Tests 1 failed / 3101 passed / 2 skipped；AI及button均无正式失败头。它们不得因本次误判被修迁移、放宽守卫或改业务实现。后续仅修已证实的ATOMIC_BINDING超时，并对另外两份做合成回归以补证据。旧SQL聚合哈希与真实57014诊断、PLM/宜搭71项及停止清理闭合证据不受此纠偏影响。

## 2026-10-17 本轮三文件诊断补丁推送及既有CI获准

### 本轮正式终态：失败，目标浏览器/宜搭证据已闭合，后置SQL仍阻断

run39002841136 attempt1 / job117309194154 / head ad9056严格匹配当前草稿head，整轮completed/failure；step98/100/101/102 success，step110 failure。公开日志64824行，LF拼接SHA `a2c361052cf2baa3e92e5ec53f07fdccf55430cd0cb611eba1ada5b5968a6de5`。只读公开日志先剥离job/step列，未读任何私有artifact或凭据。

PLM manual/interval两条闭合RESULT均passed、failurePresent=false、cleanup=stopped-and-owned-database-removed、sourceFiles=6588，回执SHA分别 `72cbb8ac6dc9f30de1da154f8327a8c77cd61f3948f57b2b512ca91ef0a927ff` / `3acda09600b9bde48ed2503825fc8ccd89f8546c70c67ce429c045719c28eed4`；actual-stop-resolved=2、actual-stop-failed=0、production-stop-failed=0。336条闭合transport帧内ABORTED/ABORT/signalAborted均0，SDK和PLAYWRIGHT POST202 BODY_DONE complete各1，PROXY DOWNSTREAM_FINISH/UPSTREAM_COMPLETE/UPSTREAM_END complete各1。宜搭闭合RESULT passed=true、tests=71、business=66、sentinels=5。清理证据是受审runner在公开成功帧前执行其强制校验的间接证据，不是读取私有清理产物；不将新绿冒称所有历史风险根因已修。

本轮SQL诊断真实捕获1条：stage=ATOMIC_BINDING、queryOrdinal=5534、sqlState=57014、statementSha256=`b60d8c0d3016a0fcb4d6495647be382a5f913f874789058bcea90afa73cd15ed`，同一步payload存在canceling statement due to statement timeout、无Test timed out。诊断将本轮失败定位到原5001-plan用例的原子绑定验证聚合查询，而不是本地注入负例的FIXTURE_RECORDS；原8秒预算与完整性断言保留，尚未修复该查询或证明更深执行计划根因。失败标签提取还命中multitable-ai-bulk-preview.test.ts与multitable-button-send-notification.test.ts，具体异常归因尚待闭合核实，不宣称只有一个失败。

只读终态补核：逐个提取FAIL标签后的错误窗口（不输出原错误），AI bulk preview错误行确认缺少ai_bulk缓存关系，非statement timeout；button send-notification错误窗口也未命中statement/hook/test timeout，具体分类仍未证明。三者不能归并成同一超时。失败窗口SHA分别 `03d26e00926bf9f232f635d38ff670ec1031b2b8ae634ea71ad0c8def469ced0` / `d96c1f8e71a8db2ed068e06ae13496f86f77a180b7444f59c0db5a4333aa576b` / `d47ca15b7e43f00979b049827b93c6858c8ba1ffb7f3a5dc402af45b4cf5dc35`。对本地源逐条提取q模板、归一空白后哈希，唯一含bool_and(r.xmin的完整SQL与CI `b60d8c...15ed`逐字节归一哈希相同，已将ATOMIC_BINDING准确绑定到L731聚合查询；初版跨模板regex提取哈希不符已弃用，不作为证据。

缓存前置静态核实：建表迁移zzzz20260621140000_create_multitable_ai_bulk_preview_cache.ts存在且不在当前plugin-tests的MIGRATION_EXCLUDE中；该测试L396会临时rename缓存表、L409 finally恢复。由此不能仅凭缺表报错断言漏迁移，需合成复现区分共享DB上的临时DDL/清理时序与初始schema缺失；当前没有修改迁移或测试。按钮失败原因仍未证实，不以没有命中固定异常分类推定为偶发。

补核范围：git diff --quiet确认AI bulk preview及button send-notification两个测试从549935039到ad9056未改。仅说明三文件诊断补丁未改这两份测试，不证明它们的失败与本PR无关；运行顺序、共享schema与导入路径的影响仍需复现。按钮守卫来源未能以当前闭合错误投影证明，保留unknown，不自行忽略。

整轮失败，因此按先前条件授权未启动Chrome试用；不自动重跑、修改代码、再次推送、合并或部署。下一步需核实三个失败标签的真实异常，并单独批准必要的本地最小修复；原历史SQL取消、lease到期与WSL回拨证据继续保留。

执行后本地续记（未再次推送）：精确暂存一个测试与两份MD，三个staged blob均等于受验工作副本原始字节，测试SHA仍e2b509；commit `ad9056f888e44da9e1f01359c2c9c84e63fbe844` 已正常fast-forward推入原草稿，OPEN/draft及原base/head分支不变。推送后同head未出现Plugin System Tests自动run（原stacked base不匹配该workflow自动过滤），故按本轮授权只dispatch一次既有plugin-tests.yml，run `39002841136` attempt1、test(20.x) job `117309194154`，元数据head严格匹配ad9056。当前in_progress，目标step98/100/101/102/110尚pending；不将queued、pending或旧head的通过算作本轮验收。

同head自动Integration Guard run `39002824831` attempt1经独立只读复核仍in_progress、暂无失败步骤；不借它替代主run正式目标证据。公开日志投影器已准备：先剥离job/step列，再解析闭合SQL_CANCELLED和PLM/宜搭帧；Playwright完成按BODY_DONE而非REQUEST_FINISHED的默认status0判断。尚未读取未完成job日志或任何私有artifact，不自动重跑、再次推送、合并或部署。

后续只读状态变化：Integration Guard run39002824831已completed/success，head仍严格匹配ad9056。主run39002841136仍in_progress，test(20.x)推进至step9，98/100/101/102/110仍pending。Guard绿不替代SQL取消诊断、正式浏览器/宜搭71项或实际停止清理证明；保持原发布门。

目标步骤推进：同head/run的step98固定浏览器安装已completed/success，step100前置real-DB proof开始执行；step101 PLM、step102宜搭和step110后置诊断仍pending。前期检查没有阻断到这里，但未据安装成功宣称ABORTED、host.stop或宜搭71项已通过。

前置等待期间的观测器勘误：PowerShell ConvertFrom-Json将startedAt自动转为UTC DateTime，再用DateTimeOffset.Parse隐式字符串转换会丢时区，曾得到29809秒错误耗时；该值撤回，不作为CI超时证据。改用DateTimeOffset直接转换与GitHub响应Date服务端时钟交叉核验，真实经过1040秒、run仍in_progress，主机UTC与服务端差约4秒。没有修改系统时间、重启或重跑；本步骤未配置独立timeout-minutes，当前没有正式超时/失败结论。

关键状态变化：同head/run的step100前置real-DB proof现completed/success，step101 PLM manual/interval已in_progress；step102宜搭与step110后置SQL诊断仍pending。前置本轮正式通过，不表示旧lease时序风险或原后置SQL超时根因已修，也不据此认定ABORTED/停止清理/71项通过。

最新目标状态：同head ad9056/run39002841136 attempt1的step101 PLM manual/interval现completed/success，step102 owner宜搭JWT HTTP/browser proof已in_progress；step110后置SQL诊断仍pending。这里只确认步骤元数据变化；公开闭合帧、ABORTED计数、actual-stop/清理与宜搭71项需待日志可用逐项核验，尚不解除发布门，也未启动Chrome试用。

宜搭步骤状态变化：同head/run的step102已completed/success，step103源修订单元合同开始；step110仍pending。宜搭正式步骤元数据已绿，但71=66+5闭合结果、传输取消及停止清理帧尚待公开job日志核验；整轮仍in_progress，未将此状态单独当作Chrome试用放行或后置SQL问题已解决。

后置测试已启动：同head/run的step110 multitable real-DB现in_progress，包含本轮SQL取消诊断所在测试；step98/100/101/102均completed/success，暂无失败job。未将执行中当作通过，原CI SQL超时具体语句仍不能凭本轮尚未闭合的状态推定。

Owner明确批准将本轮一个测试与两份现有MD推入原草稿#6337并运行既有合成CI；只覆盖此次推送/执行，不允许新增切片、合并、部署、客户读取或真实发送。推送前只读核验远端仍OPEN/draft，head=549935039，base/head分支未变；测试源仍为已验证e2b509，最终12/12、真实PG取消负例、dot透传及独立只读复核证据见下节。没有将诊断补丁冒称为原CI SQL超时根因修复。

本轮将精确暂存上述三文件，校验staged字节与工作副本一致，正常fast-forward推送；不force、改base或转正式。正式CI结果必须绑定新的实际commit/run，后续另作本地续记；原run38904209572失败、原CI具体SQL未知、旧ABORTED/lease到期及WSL回拨风险保留，不借旧head宜搭71项通过替代新head验收。

## 2026-10-16 后置失败本地复现授权与日志归因勘误

Owner 已授权仅在现有 #6337 内本地复现、最小修复与合成验证；不新增切片、不推送、不重跑 CI、不合并、部署、客户读取或真实发送，完整性守卫不得削弱。

必须撤回下节将 HISTORY_INCOMPLETE 当真实异常的归因：`gh run view --log` 每行含 job、step、payload 三列；step110 的长标题本身包含 HISTORY_INCOMPLETE/system_kind。旧提取器虽然按步骤过滤，却没先移除标题，因而误把标题词当故障枚举。现在先按 tab 切三列、只检查 payload，真实 FAIL 块不含 HISTORY_INCOMPLETE 或 system_kind，含 canceling statement、statement timeout 与 SQLSTATE 57014。它是 PostgreSQL statement timeout，不是已经证明的历史不完整；Test timed out 不命中也绝不等于没有数据库超时。此前宽块的文件名列表还包含失败命令回显，不能当额外失败套件。

首轮本地使用既有 Linux 隔离源与新建 owned PG，目标测试、三份真实 archive fixture、history precheck、迁移 provider、network guard/owned PG helper 逐 SHA 等于当前549935039对应副本；真实 source migration CLI 执行与现有 CI 相同 exclusion，462项成功。目标5001-plan用例+原生隔离哨兵实际2通过、0失败、10 skip，不冒称整文件通过。forbiddenConnections/forbiddenEnvReads均0；输入源码未改，owned PG已移除。回执 SHA `0cf9df3bd9542f5cfe696c2f2971bac2ccca8265a7eebd51bf4112990c272ab3`；migration公开脱敏日志哈希 `437c779f10a62dbc83f59d8757d1dba4e4e457cb2714e05594087b949a091703`，测试日志哈希 `ccf75b1cd058add5a11bfd6e47ff34ea84cf54706b7e42190be0cbc30c2a62a2`。首次定向通过不证明CI时序故障已修；正在原整文件真实路径上采集 SQL 语句哈希、闭合类别、耗时与SQLSTATE，不输出参数/业务值，不修改SQL结果、返回Promise、预算或完整性判定。

第二轮新PG、同462项迁移后，真实整文件11项原测试+1哨兵实际12/12通过、0 skip；隔离计数均0、源码未改、owned PG移除，回执 SHA `980e55d8280c92fd228729272d1e77f8d5e8beec593b0eaf026793637fef8ae9`，测试日志 SHA `22037e673ac7aace50d07a6a8a52c03a65c71c48f4b0042938090d98689e7732`。第一版耗时观察仅覆盖 Client.query 返回Promise路径，事务外 Pool.query 内部callback路径没被记录，不能用其最大398ms宣称全部SQL耗时无风险。已将观察补到Pool.query实际Promise，仍返回原Promise且不替换结果；完整性守卫与原8秒statement_timeout均未修改。CI原始异常仍未本地重现，不宣称已修。

补齐Pool/Client后，原目标再跑实际2通过、10 skip，最大单语句为FIXTURE_RECORDS约2209ms；回执SHA `8ee243f852dfeaca5208b3734fccbf6331ee639b25f29fd2891700e008141a02`，临时PG移除。此结果不能把原CI定性为同一条seed超时。

### 最终本地诊断补丁与真实负例

最终测试文件SHA `e2b509e08ce69886e63c10da0f247f2b4b9b248a4deb04e8e8a4b63e23deb3e6`。只在原q入口捕获57014时输出SA06AQ_SQL_CANCELLED固定帧（阶段、调用计数、SQLSTATE、SQL文本SHA），随后原样throw error。没有更改生产代码、SQL内容、statement_timeout=8000、完整性守卫、恢复事务、5001/5000+1分块、256/4744预算、原断言或任何重试逻辑。

外置负例仅将本次owned PG中目标fixture首次INSERT的实际转发换成SELECT pg_sleep(9)，由原8秒SQL限制产生真实57014；不是伪造reject/error，不是原CI故障重现。首次负例确实失败、PG已移除，但终端/JSON报告未包含console帧，因此外置证明门正确拒绝，回执SHA `640e61e40fffe3fc9c7aa14d97a7baf92d64e4040c455952301771404f78e548`保留。不能把这一轮宣称诊断接线通过。补查Vitest ctx.state实际task.logs后才能取得帧；未修改仓库runner、降低断言或屏蔽原失败。

最终同一新PG/462项真实迁移内先负例后整文件：负例目标失败1、哨兵通过1、其余skip10，真实取消耗时8001ms，任务日志恰一帧stage=FIXTURE_RECORDS/queryOrdinal=34/sqlState=57014/statementSha256=`9cc05846eca7d12432c6de3a9cb0ff0c168031c58cc7013daafa98426564c07c`，与原语句观测SHA一致，且原错误没有被吞掉；负例日志SHA `6216d2bd996fa31d99d98a69f052cf07dcd06d9ce9f0b9d7472f05b91c7d8e6d`。移除外置注入后，最终字节原整文件11项+哨兵实际12/12、0 skip、诊断帧0；最慢fixture INSERT约2245ms，原atomic binding联表约38ms。正例日志SHA `21d08a943626d5f8cb3f7cb6bc1f80c3a39a61c5eb48f453b46aa2dfc9f4c88b`。两段隔离计数均0，最终源码未变、owned PG移除，综合回执SHA `e26275ef4fc3ea92eedf7f7175103e0b7eb135d962cbfcf37a39926f0f2f80a3`。

原strict/noEmit选项下单独加入此测试root作基线/最终候选对照：116条对116条，file/code/message指纹集合相同，无新增类型诊断；不是全包类型绿灯。最终源SHA仍e2b509，类型回执SHA `9ce933dbbfad212ed6613a48c2b974a616c24e55505130fa2a9c596c3301b6e7`，禁网/禁.env计数均0。

结论：已修正错误日志归因并验证最小诊断接线；尚未在本地重现原CI具体SQL超时，也未证明其根因已修。现有正式CI仍failed，不能解除整run阻断或自动启动条件式Chrome试用。下一次获授权的同head/候选CI若再次失败，应以原dot reporter中的SA06AQ_SQL_CANCELLED定位真实阶段与语句SHA；若成功也不反向证明历史超时根因。当前仅本地一个测试与两份原MD改变，未推送或重跑CI。全部临时工具在任务tmp内，不注册新CI切片或产品flag，不碰系统时间服务。

收尾已将本轮5份脱敏运行回执及最终类型回执逐SHA复制到Windows任务tmp/history-incomplete-local-20261016，未复制私有日志、报告或生成凭据。5份运行回执ownedPostgresRemoved均true；主检出仍只有用户原有artifacts/reviews未跟踪目录，本轮隔离检出仅上述3文件改动，HEAD未变。

报告器补核：现有workflow step110显式--reporter=dot，覆盖config中的verbose；上文早期“原verbose reporter”措辞已订正。用当前Vitest1.6.1与真实dot reporter执行一个tmp内无DB诊断帧透传探针，1/1通过，终端stderr确实出现完整闭合SA06AQ_SQL_CANCELLED帧，禁网/禁.env计数均0；不需要修改workflow或添加泳道。该探针只证明报告器透传，不冒充真实PG、业务测试或正式CI证明；真实q入口的PG57014负例由上节独立证明。测试源最终SHA及3文件改动范围不变。

后续独立只读窄范围复核：review_sql_cancel_diagnostic核对冻结HEAD、最终源SHA、该diff、两份MD顶部章节、5份脱敏回执及tmp运行器，未发现该范围的新阻断或误述；确认q随后抛出同一error，8秒限制/5001与5000分块/256与4744断言未变，原CI根因未证明的限制未被省略。复核者未运行测试、联网、读私有日志或编辑文件；不将它表述成全PR/全仓审计。同时主代理只读实查这5个nonce对应scratch根，pg-*子目录残留0，没有读取其中私有文件。原历史误判段已就地明确撤回，避免只读局部片段时仍误用。源SHA仍e2b509，未推送或重跑CI。

## 2026-10-16 正式目标验收通过；整条 CI 后置失败，仍不启动试用

run `38904209572` attempt 1 已 completed/failure；head 为 `549935039ee6aa93cfffb1a9b1c0c7eb57400b85`，读取时仍等于草稿 #6337 当前 head。同 head Integration Guard run `38904179112` completed/success。step98 固定浏览器、step100 前置 real-DB、step101 PLM manual/interval、step102 owner 宜搭均 completed/success；整体失败在后置 step110 multitable real-DB，不是目标步骤 skipped 或前置再次失败。

公开 job 日志仅在内存按步骤与闭合诊断字段投影，未读私有 artifact、凭据或客户数据。64801 行公开日志按 LF 连接的 SHA-256 为 `cc165d64233f7a5ed76230ec4ee66e54a3b06d138c6a3c9692fec94af62e8388`。

- PLM 两条正式结果均 result=passed、failure=null、cleanup=stopped-and-owned-database-removed；回执 SHA 分别为 `6724561e71ec8e439a98718cdd1086ed520f977e3dab1a1722574100124288ba` 与 `8edf2f9e000fdb3a029f37902144bddd00887f99a1b3779c8bdfb21696a93fa0`，sourceFiles 各6588。独立 actual-stop-resolved=2、actual-stop-failed=0、production-stop-failed=0；入口成功还强制核验停止证明、池/监听/协作关闭及 owned PG 移除。
- 348 条闭合 transport 帧中 ABORTED=0、ABORT=0、signalAborted=0。automationRequests POST 的 SDK 与 PLAYWRIGHT 各有一条 BODY_DONE/status202/complete=true/failure=NONE；PROXY 有 UPSTREAM_COMPLETE、UPSTREAM_END、DOWNSTREAM_FINISH 各一条 status202/complete=true/failure=NONE。PLAYWRIGHT 的 REQUEST_FINISHED 按源码默认 status0/complete=false，不能用它要求 status202/complete=true 后得到0条便误判未完成。
- 宜搭正式 `YIDA_BROWSER_CI_RESULT` 恰一条：passed=true、tests=71、business=66、sentinels=5。该公开成功帧的原入口先校验同 source/owner SHA 的私有回执、71项计数和 stopped-owned-pg-removed；这里只审计入口契约与公开帧，未直接读取私有回执。不借本地71/71或其他泳道代替。

step110 的真实 FAIL 摘要只有一个测试文件 `packages/core-backend/tests/integration/multitable-recovery-record-after-image-realdb.test.ts`，命中648行的 SA06AR 5001-plan/256-image-budget 用例；本轮三文件提交未改该文件。尚未从闭合脱敏证据确定根因，不把整个步骤中预期负例的 SQL/timeout/deadlock 标签计数当成此用例故障，也不宣称是偶发或可忽略。整体 CI 阻断仍在，不能仅凭目标步骤通过宣称 PR 可发布。

【历史误判，已撤回；见顶部日志归因勘误】此前只读缩窄到真实 FAIL 摘要后100行时，未剥离step标题，误把其中HISTORY_INCOMPLETE当作异常，并误指向历史完整性/fixture链。Error标签及Test timed out未命中不能支持这一归因；真正payload为PostgreSQL statement timeout/57014，原CI具体SQL尚未知。保留此错误记录供审计，不作为当前实施方向。648行仍只是当时测试定义，不是已验证抛错行；后续本地诊断已由owner另行授权，边界及结果见顶部。

保留全部旧 run 的 lease 到期、ABORTED、停止证明失败、宜搭失败/skipped 与 WSL 回拨风险；这次正确 head 的成功是新增正式合成证据，不是历史根因全部修复。未自动重跑、扩展修复、再次推送、合并、部署或真实发送。Chrome 自动试用的“整 run 成功”前提未满足，因此没有启动会过期的临时环境。本段仅本地续记，未推送。

## 2026-10-16 三文件补丁已获授权推送，正式合成 CI 已启动

Owner 明确批准本轮三文件补丁推入原草稿并运行既有合成CI。推送前核验远端仍为bef3f94、OPEN/draft、base/head分支未变；精确暂存仅一个测试与两份MD，staged blob逐项等于受验工作副本，测试SHA仍为下节b1346d。commit `549935039ee6aa93cfffb1a9b1c0c7eb57400b85`，fast-forward推入现有#6337，未force push、改base或转正式。

同head查证plugin-tests.yml没有自动run（原PR base过滤不匹配stacked base），因此按本轮授权一次dispatch既有workflow。Plugin System Tests run `38904209572` attempt1，head严格为549935039；首次元数据状态queued，后续须按这个run核对前置、PLM manual/interval、owner宜搭71项与独立实际停止/清理，未完成或skipped不计通过。同head自动Integration Guard run `38904179112` 首次为in_progress。没有重跑旧失败job或新增泳道。

旧run38858364709 failure及目标skipped保留；本地两轮35/35、变异红和PG移除不替代新head正式证据。当前不解除Chromium发布阻断，不启动以正式通过为前提的试用。不合并、部署、客户读取或真实发送。本段为推送后的本地续记，未再次推送，不能把它误认成已发布commit里的内容。

后续只读核验：同head Integration Guard run38904179112已completed/success；Plugin System Tests run38904209572仍in_progress，step76执行中，step98/100/101/102待执行。Guard绿不替代目标正式浏览器/宜搭和实际停止清理证据，不解除发布门。

后续推进：同run step98固定浏览器安装completed/success，step100前置real-DB proof已in_progress；PLM step101、宜搭step102仍pending。没有把前置开始执行当作修复验收成功，也不回填此前失败或skipped。

关键状态变化：同head/run的step100现completed/success，step101 PLM manual/interval已in_progress，step102宜搭仍pending。此前失败的前置步骤本轮正式通过；单项数量/细节仍待可用正式日志核对，不以步骤绿冒称宜搭71项或实际host.stop/清理已经通过。没有重跑本轮run。

再次推进：step101 PLM manual/interval现completed/success，step102 owner宜搭正式HTTP/browser proof已in_progress。尚待正式日志中两场景的闭合transport帧、独立actual-stop与清理及宜搭71项计数；元数据步骤成功不替代逐项证据审计，发布门仍保留。

目标步骤现均为completed/success：step98、100、101、102。主job仍在step108后置检查；首次只读请求该job公开日志尚不可用，不能据此重启或判失败，也不读取私有artifact替代。宜搭71项实际帧及PLM停止/transport闭合审计暂待job日志可用，发布门仍未解除。

新失败：后置step110 multitable real-DB integration已completed/failure，step122上传结果中；step98/100/101/102仍success。不能把后置失败说成Automation前置复发或PLM/宜搭步骤失败。当前正式整run尚未终结，失败用例及目标日志待公开job日志可用后核验；不自动重跑、不据目标绿灯启动以整run成功为前提的Chrome试用，也不越界修复其它业务模块。

## 2026-10-16 已授权本地 Automation 复现与测试同步修复

本节覆盖同日之前“等待本地诊断授权”的状态，不改变远端结果。仅改 `packages/core-backend/tests/integration/automation-read-delivery-realdb.test.ts` 与现有设计/验证MD；未提交、推送、重跑CI、合并、部署、客户读取或真实发送。诊断工具保存在本任务tmp中，不接入产品或新增CI切片。

### 真实路径复现与最小修复

- 校验Linux隔离源的测试、delivery adapter、dispatcher/loop、原Vitest配置、owned-PG与network-guard逐SHA等于发布候选对应文件。仅启动本次新建PG，无继承数据库地址或.env，父进程/worker使用原network guard；worker内另有真实守卫哨兵及afterAll检查。没有改系统时间或时间同步服务。
- 初次工具启动被原守卫拒绝（Vite默认监听/localhost探测），尚未进入产品断言；均保留失败回执且owned PG已移除。临时工具只关闭组件验收不需要的HMR/WebSocket并选字面量host，显式fork预载同一守卫；不增加网络白名单、不更改仓库Vitest配置。后续实际SQL仅到新PG，forbiddenConnections/forbiddenEnvReads均0。
- 原生产handler的第二次 `FOR SHARE OF o,c` 查询被本地探针在真实事务中暂停；手工requeue后让该锁实际取得，再调用真实第二tick。第一tick为 claimed=1/rescheduled=1；第二为 claimed=0/completed=0，rescheduled/poisoned/lostLease/heartbeatErrors均0，oldTailLockHeld=true。原332行completed断言失败。回执SHA `40e97bd762eb8e47406450ec42a745794beb39f54a10b2a4e29abc0a67a604c8`；PG已移除。只改变时序，不伪造SQL结果、adapter结果或dispatch返回值。
- 第一版修补等待真实adapter handle结束后才requeue；固定尾部时序连续3次目标用例通过（回执SHA `ca46f9df13fdfffc3fd89953d3cd40bde0c6ab54b63043263489e5130a950b16`）。删除等待的变异再次得到 claimed=0/completed=0，原断言变红，回执SHA `6ce253b0c479e0e298d639b4f13c0a1c6062942104b7031480397de37fc32894`。
- 最终补丁将该收尾阶段固定进原测试：真实第二次reconcile transaction执行完工作后持锁等待barrier；测试等待tailEntered，安排setImmediate释放，再await同一handler的settled并断言完成，之后才重新投递。finally释放两道barrier并等待handler，原timeout=1000、signal精确传播、未知结果、fence与仅执行一次等断言不变。生产代码零改动。

### 最终字节验证与负向证明

最终测试文件SHA `b1346d14003d6711af0c60b4bd2c11ed4de9a61b4a23b282eec75ab11e59895b`。真实整文件执行34项原测试+1项native guard哨兵，35/35通过、skip/fail均0，owned PG移除；回执SHA `643f2182ad2ca7cf048add527c1b973f41ef7e0a0ad8dcb764da351be8d56fd9`。这是本地单文件回归，不是CI前置33套全跑或宜搭71项正式证明。

变异结束恢复相同最终SHA后，再次整文件35/35实际执行通过，skip/fail均0，PG移除，回执SHA `cb9a4ab27e14515603d2d6bcb77f51ac1596b78e7e2093120800d17641cc9a02`。收尾逐条核验本轮11份运行回执ownedPostgresRemoved均true，并检查其nonce对应owned scratch下没有pg-*子目录。诊断目录与失败证据保留，未删除既有工作区或其它进程的资产。脱敏回执已逐SHA复制到Windows本任务tmp的automation-delivery-local-20261016目录；未复制私有原日志或生成凭据。git diff --check通过，最终仅上述测试及两份既有MD有改动，主检出用户artifacts/reviews未触碰。

直接从最终补丁删掉requeue前的await settled（保留finally等待），关闭外置race探针，原用例自身即失败：实际执行1个目标用例+1个哨兵，目标失败/哨兵通过，33项其余用例按名称过滤未执行。回执SHA `119f245dc358c4e5e8030ccf6eb02cf74511606dd3b3116ba50c67aa2f65444e`；随后恢复最终文件并核验上述SHA。该负例由原用例的确定性尾部barrier触发，不依赖外置探针或修改返回值。

统计口径修正：本机Vitest 1.6的JSON reporter会把名称过滤的用例仍记为passed，不能采用其numPassedTests宣称整文件通过。后续改用ctx.state的task.mode/result.state直接核对：定向run为2实际执行+33 skip，整文件run为35实际执行+0 skip。本节上述“连续3次目标用例”不等同3次35/35；历史原JSON和工具失败回执保留，不改写为全链通过。

采用原strict/noEmit编译选项，仅补入本次测试root作基线/候选类型对照：基线54条、候选54条，file/code/message指纹集合一致，无新增诊断；回执SHA `b6dd77b3a218de1f86b28db72f2a0c08ac32e4231f749ca1e9e1d24df75ecf14`。不宣称严格类型全绿或整个backend类型通过，不扩大修复54条历史诊断。

证据限制：已证明可导致相同CI断言失败的真实收尾竞争，并使原用例可确定性发现等待丢失。CI旧日志缺少完整tick计数，故不宣称锁竞争为那一次失败的唯一已观测根因。本地通过不会把远端PLM/宜搭skipped变成通过；固定Chromium发布门、旧失败和WSL时钟风险继续保留。

## 2026-10-16 新 head 正式 CI 终结：前置失败，目标验收跳过

只读核验 run `38858364709` attempt 1，head 严格等于 `bef3f94b69938c37266ec306e1e551cbde3a5bb0`。该既有 workflow 经本轮授权一次 dispatch 执行：PR 的 stacked base 不匹配原 workflow 的 main/develop 自动触发过滤；没有修改过滤规则或重复重跑。Integration Guard run `38858293253` 同 head completed/success。

Plugin System Tests 最终 completed/failure：step98 固定 Chromium 安装 completed/success；step100 锁协议 real-DB proof completed/failure；step101 PLM manual/interval 与 step102 owner 宜搭均 skipped。不能据此判断新浏览器正式 ABORTED 是否解决，也没有本轮实际 host.stop、清理或宜搭71项正式通过证据。

公开 job 日志仅在内存筛选固定标签，不输出原响应、URL、query、业务ID或堆栈，不读取私有产物。全部公开日志规范为换行连接后的 SHA-256 为 `da6c4e294f1d1a796b28c7db702cba185e3c0264d95310d4e82b76e299f02a2a`（60600行）。精确限制 step100 后12253行中有一个 AssertionError、ABORTED计数0、Test timed out计数0；失败摘要命中 `automation-read-delivery-realdb.test.ts` 与 `db.test.ts`。这仅定位失败套件，不证明具体根因；整 job 的其他 timeout/ABORTED 字样可能来自预期负例，不能当作本步骤故障归因。

后续完整复核并纠正提取器误判：第一条 FAIL 长287字符，只含一个测试文件及真实 dispatcher timeout 用例；第二条长2251字符，是含33个测试文件的失败命令回显（Command、vitest均命中），不是第二个失败用例。初版 `db.test.ts` 后缀匹配、随后把命令里的 `stock-preparation-read-plan-host-realdb.test.ts` 当第二失败套件，两次判断都不成立，撤回。当前只证明 Automation 的一个真实失败用例，不能报告宿主套件失败。

Automation 失败用例对应源码309行（真实 dispatcher timeout 后 drain unknown 不重执行），失败引用指向332:35，即重新投递后的 completed 断言（期望1、实际0）。尚缺这一 tick 的完整 claimed/rescheduled/lostLease/heartbeatErrors 等计数，因此不能断言没有 claim、断言安全 sink 失败或归因某个竞争。源码中的 requeue 把该 outbox consumer 显式置 pending 并清空 lease，而 claim 接受 pending；因此“未清重试时间”也不是当前源码支持的解释。不能仅凭步骤标题归因锁协议死锁或超时。不修改重试/租约或安全约束来求绿。

只读调用链补充：dispatch loop 的 completed 为0还可能伴随 claimed为0、rescheduled、poisoned、lostLease或heartbeatErrors，必须记录整个闭合计数集合才能分类。adapter内部 reconcile 使用DB clock_timestamp 校验 delivery lease，而 dispatcher claim/complete 使用其 now seam（默认进程时钟）；这只是待检验的双时钟路径，不是CI时钟偏移证据。允许本地复现后应只记录相对时差、闭合阶段与计数，保留原断言和租约，不输出实际时间、请求ID、SQL参数或凭据；同时检查旧 handler 是否仍在收尾，不能仅靠调大等待预算掩盖竞争。

保持历史失败与本机时钟风险，发布阻断不解除，不启动以正式全绿为前提的 Chrome 试用。不自动重跑、不再推送、不合并、不部署、不读客户数据、不真实发送。本条为本地续记，未提交或推送。

## 2026-10-16 已授权推入原草稿并运行既有合成CI

本轮用户明确批准推送固定浏览器接线补丁与MD到现有#6337；不新增PR或切片、不改base/草稿状态、不合并/部署/客户读取/真实发送。远端推送前实读仍为fcb20，使用隔离发布副本，排除.env文件，16份代码字节逐SHA等于受验补丁回执；主检出和旧分支工作区不清理、不重置。

本次计划一次fast-forward推送，由现有pull_request同步事件触发CI，不另行重复dispatch或重跑旧job。下方“未推送/待批”均为历史验证时状态，而非本轮禁止；实际新head/run标识与结果需在推送后按GitHub元数据核实，本文不预写正式成功。本地266合同、类型、provenance及官方ZIP回放仅按原准确范围成立。历史run失败/宜搭skipped、首次manual timeout、WSL回拨风险继续保留，直到正确新head的正式Chromium/宜搭步骤与停止清理证据充分前不解除发布门。

## 2026-10-16 本地CI接线完成：266合同通过，未推送或触发CI

用户明确授权“允许在#6337内本地补齐固定浏览器候选的CI接线”。本轮只在现有隔离副本实施；主检出仍仅原用户artifacts/reviews未跟踪项，未触碰它。原所有禁令保持。

### 接线与真实本地验证

- 原required workflow保留Playwright默认安装；新增官方snapshot1719529固定HTTPS安装step，ZIP摘要先于解压、二进制摘要先于独占目录发布，原pin模块最后验证。已有目录拒绝，下载失败或校验失败不能继续，curl不跟随重定向。
- PLM manual/interval及宜搭71项的原CLI各传精确selector；原干净环境、namespace/native、owner/source/binary约束及业务/停止断言不变。没有新增真实发送通道，也未让其它browser消费者切换默认。
- 完整三整文件合同266/266，fail/cancel/skip/todo均0；原严格类型exit0、network/env类型检查守卫均0，diff --check通过。实际provenance套件1/1通过，未修改pin。
- workflow合同从真实run block执行Bash；合成curl与最终node边界，真实ZIP/sha256sum/unzip/文件发布；正例通过、两类摘要错/下载失败/既有目录分别拒绝。移除ZIP或binary校验时，各自独立负例会误接受，因此原拒绝oracle能识别删除守卫，不能被另一门遮住。宜搭caller两种selector变异被实际argv合同抓住。此为隔离合同，不冒称官方远端下载。
- 另用本机此前已核的官方ZIP字节回放同一Bash，只替换网络取得步骤为复制该ZIP，真实摘要/解压/候选pin模块均执行通过；再次安装因目标存在拒绝且二进制未变。没有启动browser/PG，没有网络下载；新安装文件保留在独立tmp下供审计，非试用服务、非系统默认浏览器。该安装回执SHA `e56b1e273a600a9607111504e59461cbea80c4cc51d2c9029af401e924e65186`。

首次真实ZIP核验发现历史文本摘要多了一个f（65位），在安装前即拒绝；最终ZIP SHA为`691d6469ab37218a362aaffff974fd378985d1428c2a690c6dbeb73501bbe51d`，实际文件重算一致，已修workflow/测试常量并加64位断言。之前合成ZIP合同不验证官方常量真实性，不能用其绿灯掩盖此错。完整合同首次263/266、三红均因PLM精确命令预期未同步selector，更新合同预期而未移除守卫；失败私有原输出保留，未上传。最终回执SHA `73bb9070c4c9fb14b8440be69373493c01090121e5d9a5d0fc370b7dbeb39cd2`。

### 最终交付身份与限制

新16文件本地补丁位于`ci-wiring-local-20261016/final/pr6337-local-ci-wiring-sixteen-fcb20-verified.patch`，基线fcb20、SHA `c090001264543072818f165d2f13771bc399ef49811d7281badd268a6af62a1b`；独立临时Git目录apply --check/index、实际apply逐SHA、reverse --check、diff --check均通过。补丁回执SHA `aab815fa4aa5996d407e867e3efd04a5cad2264746dfb050f1cf03cfea57bac8`。ci-wiring父目录较早16文件版本仅为中间快照，不是最终交付；旧reviewed/aligned补丁也均保留。

lineage审计核对当前16文件逐SHA：13份等于旧独立审过候选，变化恰好为`.github/workflows/plugin-tests.yml`、PLM full-app合同、宜搭workflow合同；无额外runtime、browser、授权、停止、namespace或native隔离变更。新workflow SHA也与官方ZIP真实安装回放及266合同回执一致。lineage回执SHA `6ab46ca17ff87e8213b62e9915416fb3ac79b80079d3742511b4618d83d1f3fd`。

未推送、未触发CI/重跑、未合并/部署/客户读取/真实发送。旧正式run38673376578失败/宜搭skipped、历史manual timeout、WSL时钟风险继续保留。新workflow尚未在真实Ubuntu runner下载和执行三门，因此formalCiEvidence=false，发布门不解除，也不宣称新候选已重跑整链或历史timeout根治。当前仅本地接线授权已完成；下一步推入现有草稿并运行既有合成CI必须另获明确授权，不擅自执行。

## 2026-10-16 最终独立复核与合同P2修补（新候选）

复用已获准的Astra ultra只读代理对14文件补丁、精确SHA与脱敏回执终审，未读.env/owner/private日志/原evidence、未运行测试/写文件/外派。发现一项P2：旧合同在observer callback中assert参数，但fixture已经正确隔离callback异常，故参数错误可能被吞而仍绿。现仅改`stock-preparation-plm-full-app-contract.test.mjs`：callback只记录四元组，查询返回后在隔离外断言SQL/params/Promise身份/started；独立throwing-observer合同保留。新增四种实际包装器的内存变异（错SQL、克隆params、替换Promise、started=0）全部被外部断言杀死；完整197/197、原严格类型通过、无skip/cancel/todo。回执SHA `3160296453f603c32367fdab52d3395a2ed1535d6437ed99b2132bf301f45a56`。

代理针对修补再次只读复核，确认P2闭合、未发现未解新增阻断；该结论不含尚未进行的新正式CI，也不扩大为历史timeout唯一原因或所有目标已完成。

新14文件补丁位于`reviewed-local-20261016/pr6337-local-reviewed-fourteen-fcb20-verified.patch`，SHA `a6931db77f3b6269c466867c8e2caa46c09e4af5bd4dc373f9a4d3d83ad95334`；独立临时Git目录apply-check/index、实际apply后逐SHA、reverse-check、diff-check再次通过，回执SHA `7dcf3805e1d202443060b20a2a25d9e517e305e2d833a0bede61f0a7bb99ce84`。之前aligned目录的旧补丁与三门回执保留，不覆盖、不混称当前最新版。

精确lineage审计：先验证原manual证据SHA及其sourceInputs与三门汇总身份，再逐SHA比较当前所有6588输入，6587相同、唯一变化是上述合同文件；新旧14文件补丁清单也仅该文件SHA不同，其余13份含全部生产/browser/isolation代码不变。新合同SHA与197回执一致。lineage回执SHA `f5103cb728e71a94f14cc3d61bb3485af9b673908fe718cf6d371fbe9a71c8e6`，明确newFullThreeGateRunClaimed=false。未为了测试文件差异盲重跑整链；原三门只能以其精确输入+本次仅测试变化关系佐证，不能涂改成新候选整链实跑。

### 正式CI与授权前置（只读现核）

GitHub现核#6337仍OPEN/draft，head=`fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`，base仍原PLM分支；run38673376578 attempt1 completed/failure，test(20.x) failure，step99 success、step100 failure、step101 skipped。只读元数据，未读日志/产物或重跑。

冻结workflow `.github/workflows/plugin-tests.yml`的blob已与该head核对完全一致，SHA `cfd4b2d7ef679933a68cb4194ea1d4eead6c850ac07829957196359bdc8c609d`。L1307安装Playwright默认Chromium；L1371/1372原manual/interval命令无candidate；L1411宜搭原CLI也无candidate。当前补丁没有修改该workflow，候选是显式可选、默认仍旧浏览器。因此“本地候选三门通过”不意味着正式默认CI已修，也不能建议仅推14文件就承诺CI会绿。将候选引入正式合成CI或改浏览器基线超出最近仅本地授权，须owner明确批准后才可接线/推送/执行；当前未做。原Chromium发布阻断、历史超时及真实发送禁令保留。

## 2026-10-16 原目标逐项审计：不把宜搭绿灯替代SA-01/SA-02

前端现有Draft/Versions/Validation三整文件也已补当前证据：实际163业务+3个逐文件native-guard哨兵通过，failed/pending/todo0；不是166业务测试。维持原Vite配置及localstorage setup、mock API边界，使用原METASHEET_ENV_DIR指向新建空目录，不读.env；只在临时运行器关闭测试不需的hmr/ws监听，以fork execArgv显式载入原guard，并在每个文件内assert guard存在、databaseAllowed=false、before/after守卫计数均0。全部6588输入后置逐SHA仍与冻结manual输入一致，三个spec也逐项属于该input清单。它支持真实Vue组件的草稿、导出/导入、版本与样本确认行为，不证明第二owner真实宿主/整站登录。

准确保留工具失败：默认配置和仅hmr:false两次均被原guard以FORBIDDEN_LISTENER拒绝（exit92、forbiddenConnections1、env读取0、allowedConnections0）；实读Vite当前依赖的createWebSocketServer确认独立server.ws=false才禁止该监听，没有放松guard。最初ws关闭的163通过只见父进程退出帧，不作worker完整隔离背书；fork尝试的“每文件必须有退出帧”断言也未满足，未降级冒充证明。改用逐文件真实哨兵后，首个setup放在workspace外被Vite拒载，保留为0测试/3套件失败；将该自有setup机械复制到workspace tmp内后实际166/166通过，但汇总器按未trim的fullName误判0/3。离线审计真实JSON每文件恰好一个通过哨兵，确认仅名称前空白，保持原driver失败记录；不重跑业务测试，name解析修为trim精确相等。离线审计首次历史文件名前缀拼错产生ENOENT，修正审计读路径后通过，亦非业务重跑。

最终离线闭合回执`aligned-local-20261016/sa-web-offline-closure-receipt.json` SHA `0573137f47cbe0fb33ab699cc8fe6db2d54a06b427ac64af0b1dee248700095a`，包含各次原stdout/stderr SHA、固定失败分类和计数；原日志仅留本机私有位置，未复制到交付面。汇总器明确originalDriverExitFailed=true、offlineReportRevalidatedWithoutBusinessRerun=true、fullSecondOwnerRealHostProof=false，不抹去任何红灯，不修改14文件产品候选或套用到正式CI。

本次仍是既有四PR的本地审计，无产品代码/新切片。实读原目标§5/§6及§55，核对当前冻结输入中的生产函数和测试。此前三项本地全链通过继续有效，但不能替代以下各自的保证范围。

新执行原11整文件（BOM展开、read-plan bootstrap/catalog/store/management/execution-identity/runtime/validation-ledger/validation-read/validation-runtime、Bridge只读adapter），291/291、fail/cancel/skip/todo均0。通过原网络/.env守卫预载运行，12个进程守卫帧均为forbiddenConnections/forbiddenEnvReads/allowedConnections=0。前后逐SHA核验全部6588份sourceInputs未变，测试文件SHA逐项写入回执，绑定同一input SHA `41e67dbc8b6ffb56ca360923740d05cffc33b1ae391e5c7b2cf9759ba8c6dc0e`。回执`aligned-local-20261016/sa-requirements-current-source-receipt.json` SHA `7fd75fdb8513c15d0e79e489f720746490f297cb909e6768f601e4d581b3e9c9`。这是291个runner报告测试，不额外把BOM单个suite内部的函数/断言数量计成更多测试。

另有独立membership审计逐项确认11个测试路径/SHA确实属于该冻结input，而不只记当前文件hash；回执SHA `4cb049f7b23653e0279a53e139e96a3dcea293309a90d84f617d5ae34a7ae719`。原目标MD本次SHA仍为 `410961bbe4fea14cbb2d04e6e52fb9e970f69f3b9e3a43c9a637da9b55f50c26`，未缩减或改写目标。

下表代码行号限定于冻结fcb20+本地14文件补丁、上述input SHA，不引用后来main：

| 原目标要求 | 已亲读的当前证据 | 当前裁决与限制 |
| --- | --- | --- |
| SA-01订单BOM版本不得被物料最新版替代 | bom-expansion生产L1906/L2189的无匹配/冲突拒绝；BOM测试L182–346明确订单指定版本、0值、错父件/错版本、冲突和失效头负例 | 对实际expander+合成adapter已证明；全应用fixture订单B2、物料P1的物理PG路径另有通过；不等于客户MSSQL证明 |
| 跨层数量、循环、限额与不完整结果 | 生产bom-expansion L1954循环拒绝、L1999父数量乘单耗；BOM测试L542–584深度/缺子BOM/循环，L757 boundedPreview.complete=false及后续截断样本断言 | 当前生产函数回归通过；不以正常项目预览成功覆盖所有异常，也不以有界预览冒充完整对账 |
| SA-02保存/确认/批准/激活后只预览 | 全应用browser helper L1112–1263的真实保存、validation/sample确认、批准与activation回读；当前manual/interval原CLI均通过 | 当前一owner合成全应用生命周期可证，不是全部复用/并发身份场景 |
| 版本/代次/tenant/workspace绑定执行 | execution-identity测试L175/195/209/236/266依次走真实ledger→compose→normalize→dry-run、同内容重激活失效、作用域拒绝、旧token零写拒绝 | 当前291内通过，边界DB是内存ledger，不能称真实并发Postgres事务证明 |
| 凭据/权限不随模板复制，错误配置不发布 | config生产exactKeys L44和validate L67；store测试L144起包括credential等越界字段拒绝；管理测试L245严格形状、L271当前owner门、L298转移/重绑撤权 | 当前guard/存储合同已证明；前端Versions测试L275的下载→另组件导入使用mock API，不冒称整站第二owner实跑 |
| 第二名用户对第二物理布局只改配置预览 | 当前确有realdb测试L1046的独立第二部署、新owner/connection及七组reuse表；browser-acceptance helper L622起接收前浏览器下载字节再改七角色；原目标§55有历史21项说明 | 不是“系统没有该功能”。本轮三项全应用未执行这套第二部署；旧§55口述/历史计数不能直接证明当前冻结输入全路径。需沿这套既有验收补当前证据，不能重写一套向导或冒称当前已全部完成 |
| Bridge只读及完整性边界 | 当前Bridge adapter整文件使用fake fetch边界，验证filtersApplied、有限页applied limit等；未把它下沉BaseAdapter/raw SQL合同 | 合成adapter合同通过，不证明边缘Agent部署或客户源完整性，不用于宣称生产完整对账 |
| SA-03/04/05/06独立边界 | 既有前三PR读取链审查、宜搭71和Automation manual/interval当前同输入回执各有独立范围 | 不把上述291或71当作K3全部协议/真实宜搭发送/所有Automation消费者完成；实际发送仍OFF，真实读/发布另授权 |
| 真路径先于变异 | 当前合同直接调用生产expander、真实route handler/store/identity组合，外部adapter/facade/DB边界仍有替身；原14文件浏览器pin/observer变异另有专属回执 | 本轮未逐条重跑所有安全守卫变异，不宣称每条保证已在当前整树完成独立反驳；保留mock边界和未抓到的降级范围 |

原目标仍active，未标完成。下一安全方向是复核并复用已存在的第二owner/第二布局验收及其隔离入口，不新增切片、不用放宽身份门来消除原同租户指针owner的403；执行前必须确认其不读取继承DATABASE_URL、不碰非自有DB、固定浏览器/原隔离仍受控。当前未启动该realdb套件，未临时提供数据库地址来绕过其前置，也未扩大当前已批准的manual/interval入口范围。

预检已确认它的真实约束：host-realdb测试L32要求DATABASE_URL及EXPECT_DB/METASHEET_REAL_DB_TEST_STEP，L202起直接用该地址创建adminPool/schema；当前既有ops入口仅见guarded-path登记，尚无等价的已审自有PG/native-namespace/固定候选封装。不能无人值守拿继承DB地址直接跑，亦不能把这项环境缺口改写成业务功能缺失。仅保留为既有验收的隔离接线待核，不在本轮增加第15个产品文件或新CLI动作。

## 2026-10-16 冻结源码对齐与完整补丁

本节最终结果：同一冻结6588份sourceInputs下，manual、interval及宜搭71项均已实际完成并通过；不是将旧版本绿灯拼接。汇总回执`aligned-local-20261016/aligned-local-three-gates-receipt.json` SHA `0f73a9b0bb9ee7a92b32a1a4dbb2c8a1d1cf2ca7f712477096e1da9720659a5f`，逐项绑定manual/interval独立闭合、宜搭task/worker/report闭合、完整补丁及基线输入身份回执。它明确formalCiEvidence=false、historicalTimeoutRootCauseFixed=false、releaseBlockRemoved=false。

| 当前冻结输入上的实际验收 | 业务结果 | 独立停止/清理 |
| --- | --- | --- |
| manual | complete/succeeded，17546ms，140checkpoint；204传输帧，ABORT/ABORTED0，POST202 SDK/PW complete各1 | actual stop + full stop proof通过；PG移除；专用browser残留0 |
| interval | complete/succeeded，9032ms，140checkpoint；132传输帧，ABORT/ABORTED0；该自动触发路径没有manual POST202，不将计数0当缺失 | actual stop + full stop proof通过；PG移除；专用browser残留0 |
| 宜搭原5整文件 | 71/71（66业务+5哨兵），failed/pending/todo0，原安全/大小/取消断言保持 | 原owned PG移除；专用browser残留0；worker/task/report三者核验 |

interval闭合回执SHA `511578c1bebbf4ae8fec9f2f366d511b855707bad494766c598daf7b60a66447`，控制器回执SHA `b26538b68ed4adc8ed1f8c68e269c3c06271351c25700ed7aeef9d7728a94607`。本轮没有在跑的这三项试验或试用服务，没有重试失败job、上传raw日志、推送、合并、部署、客户读取或真实宜搭发送。仍保留首次manual timeout、历史CI失败及WSL时钟风险；一次同输入通过不能证明长期稳定，正常Chrome交互试用的原CI授权前置未被本地headless验收代替。

不是重复宣读旧绿灯：本轮先对最新manual记录的6588份sourceInputs重新逐SHA校验，再只读取Git冻结head的ls-tree对象元数据进行blob身份比较。结果6574份完全等于`fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`，13份修改+1份新增；这14份的路径与candidate SHA逐项等于本次完整补丁清单，没有第15份差异。sourceInputs SHA `41e67dbc8b6ffb56ca360923740d05cffc33b1ae391e5c7b2cf9759ba8c6dc0e`。未读取冻结版本.env/凭据或原始业务内容；不证明未枚举输入、依赖安装树和整个Git目录绝对一致。

完整14文件补丁在`aligned-local-20261016/pr6337-local-aligned-fourteen-fcb20-verified.patch`，SHA `300d3791ce3e9f5a550328af54d7522e357e6184b785454c0d104c43cb4d9cc3`。在独立仅含目标代码blob的临时Git目录，执行apply --check/index、实际apply后逐文件SHA、reverse --check/index、diff --check均通过；未应用到产品主检出，未提交/推送。补丁回执SHA `6e80af43389c1213efcba31681d1c6e9986d28470b23231416d4e247fef2c4fa`。

sourceInputs与补丁绑定回执SHA `d4f25c631ea3d0e3ac25f7f80dc0f9a8ec74ef0e52230b42fa593688320c59ea`，明确sourceInputsEqualFrozenPlusPatch=true、wholeUnenumeratedTreeProven=false、formalCiEvidence=false、historicalTimeoutResolved=false。这补强上一节的基线缺口，不把本地Git HEAD标签当整树证明，也不把旧六文件补丁作为当前交付物。

一次冻结现源码的原宜搭71项已终结并独立审计通过：66业务+5哨兵、failed/pending/todo均0、原owned PG移除、专用browser残留0；闭合回执SHA `1eb2215f6f4ab1651af55d51fc65550753c930987170b1164c2652be70ec1b8a`。使用独立aligned产物前缀，试验前后检查全部6588份sourceInputs不变。随后同版本interval顺序执行并已通过，以免两个试验的browser残留审计互相干扰。旧71/interval仍标为各自历史源码回执，不静默归到当前版本。

## 2026-10-16 无人值守终结：带回执观测的manual整链通过

本次一次性clock-manual诊断已实际终结，CLI/控制器exit0，未另起第二次试验。仍沿原公开入口、全部9个stage、6588份sourceInputs与原安全断言；后置审计逐项重哈希当前源码匹配，不是仅看退出码。

- manual整链passed；POST202的SDK BODY_DONE/complete与Playwright BODY_DONE/complete各1；204个闭合transport帧中ABORT/ABORTED计数0。
- 生产执行诊断firstStop=none、phase=complete、outcome=succeeded、elapsedMs=17546、checkpointCount=140、cleanupCount=1。非旧栈名推测。
- readiness最终145份有效clock回执，rejected/invalid均0，最大receipt等待2ms，超出等待界的forward/backward计数均0；仅代表本次观测窗口，不能证明历史时钟原因已排除或已修复。
- actual host.stop resolved、完整production-stop proof通过，原owned PG stopped-and-owned-database-removed，专用固定browser binary存活进程0。没有遗留本次试用服务。

原evidence SHA `f6a67333a510236bde1822376db474044033e8377ed1e1a69fdb4b76437a1778`；manual控制器回执SHA `6d58c4f42af43d00d54c5aa2ae256f43465b30ff5fc429b3d6c1a389d908cc42`；包含transport、生产firstStop、clock与独立清理审计的最终回执SHA `0441643b79ec15a56c2005c5f21e8033ae4318bea1db1cf6bcaf169c96e0a845`。仅复制闭合回执和自有脚本到clock-receipt-diagnostic目录，不复制raw日志/owner/原evidence/.env。

结论限定：宜搭本地71项、之前首次interval、本次新增诊断版manual分别通过，但它们不是全部同一源码整树/正式CI的三连绿。首次manual的source-checkpoint/timeout失败、历史正式CI失败及宜搭skipped继续保留；本轮只新增测试诊断与异常隔离，未修复runtime timeout根因，不能据一次成功撤销发布阻断或宣称稳定性已证明。未推送、未重跑CI、未合并部署、未读取客户数据、未真实发送；不因用户离席而扩展权限。下一步仍限于冻结源码对齐与已有本地证据收口，发布/真实试用不在本次范围。

## 2026-10-15 无人值守续验：时钟回执诊断，非超时修复

在已授权的同一#6337本地范围内，只修改既有Automation合成fixture及其合同；未更改runtime预算、授权检查、SQL、业务断言或系统时钟。after-grant后旁观原host pool的两条精确clock SQL回执，仅保留计数、查询等待上界与DB/monotonic增量差的最大超额，不输出时间戳/SQL参数/业务ID/错误内容。阈值为前后两次查询等待之和再加250ms，慢响应本身不判为跳时；结果只代表被包装host pool的相邻有效回执，不唯一归因于worker/WSL/NTP，零计数也不证明时钟稳定。

实际函数抽取合同覆盖慢响应负控制、前后偏移、无关查询不读值、原Promise/receiver/参数身份及还原；删除等待界的变异会致红。独立只读复核发现一般observer抛错可遮住原查询，已在原调用点加异常隔离并新增throwing-observer合同，未放松native结果。最终完整合同196/196、fail/cancel/skip/todo均0；原严格14入口类型检查exit0，网络/env守卫计数均0。回执SHA `7c478c2a54bdd590b92c7602c068d6189bec6b3b5f41fb4672170a20ef4e3920`；隔离修补前195/195回执另保留，不能把两次相加。

当前fixture SHA `de74c72fe7460e91a4865aa43b013f04e6440f96d2faee7a2ce571b28ae65d65`，合同SHA `20eb948b175c4317f21d51b945b91dd6ab09b607fb34140a7d0db16e250de422`。两份源码和闭合回执在`clock-receipt-diagnostic-20261015/`，逐SHA核验复制；未覆盖旧candidate-pinned-plm目录的通过/失败源快照。旧191合同、manual失败与interval通过均属于加此observer之前的sourceInputs，旧“当前仍匹配”仅指其审计时刻。

已启动一次显式`--clock-manual`诊断整链（控制器session83716）；产物使用clock前缀且wx独占新建，保留原manual失败和interval通过，不覆盖或伪称同源码再次通过。仍沿原公开CLI执行原类型/构建/迁移/真实浏览器与停止清理步骤。开始时结果待定，不能预写通过；只读采样，不调整系统时间/同步服务。该collector经现有readiness诊断输出，未进入该分支时可能没有回执帧，不得把缺帧视为零偏差。无推送、无CI重跑、无合并部署、无客户读取或真实发送。

## 2026-10-15 无人值守本轮结果：interval整链通过，manual超时保留

用户批准的两场景均已首次执行终结，没有重跑manual：

实际每套使用Linux非root、清空继承环境、固定Node与原公开入口，只有scenario分别为manual/interval：

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  /usr/bin/node scripts/ops/run-stock-preparation-plm-full-app.mjs \
  --pg-bin=/usr/lib/postgresql/14/bin --automation-scenario=manual \
  --browser-candidate=upstream-1719529
# interval首次仅将automation-scenario改为interval；不是再跑manual。
```

| 场景 | 原CLI/外层进程 | 实际host.stop | 完整stop proof | 原自有PG清理 |
| --- | --- | --- | --- | --- |
| manual | failed/code1，无signal | resolved | false，EARLIER_PROBE_FAILED | stopped-and-owned-database-removed |
| interval | passed/code0 | resolved | 原完整检查通过，含2次协作断连、pool/HTTP/adapter/timer状态 | stopped-and-owned-database-removed |

interval回执SHA `701e990d8d77eaa42efad042922aa48d749f51156ae4fc87d7c35b6fb2b7db73`，原evidence SHA `f69b7c80ee6b4231acaadb6dde70665cb7bae022ba5827213624e4257de4bb11`。它执行原9个stage及6588份sourceInputs，不是宜搭71项或简化browser probe。独立后置审计证明两套sourceInputs完整相同且当前仍逐SHA匹配、两套PG均已移除，专用candidate binary存活进程0；闭合审计SHA `7e5397ad4c7132b77aab73bbc1c1d1eecfb9fd50f4372715e8d6cf90f5ab99bf`，其allScenariosPassed明确false，不把审计程序exit0偷换成两套业务通过。

### 取消归因纠偏：以生产结构化首因替代旧栈名推断

后续无新增试验的生产诊断对照已完成：在相同6588份sourceInputs下，manual为source-checkpoint/timeout/outcome_unknown、21845ms、134次checkpoint；成功interval为complete/none/succeeded、10018ms、140次checkpoint，cleanupCount均1。两者数据均来自各自已有configured-app原stdout，先核对evidence/log长度与SHA，再只投影既有有限枚举和计数。对照回执SHA `4353a099489187057f1de9f0c939ea602a7f30381b36fc8a25df76b1905c2746`。这不能把总耗时除以checkpoint次数冒充单次SQL耗时，也不证明任一模式存在固定逻辑缺陷。

当前源码预算链实读：runtime的CEILING.timeoutMs为25000（不是fixture等待窗口30000），profile再与有效action.maxElapsedMs取min；实际单次grant可能更低，未从日志重建其具体数值。ledger claim将该预算与grant有效期写成DB绝对lease；每次checkpoint在锁/授权之后取DB clock并返回remainingMs；executor用`min(旧deadline, checkpoint开始的performance.now + remainingMs)`只收紧、不延长。因此时钟偏差和实际权限/SQL耗时需分别观测，不能因“21.8秒小于25秒”直接认定timer错误，不能放宽预算、缓存live ACL或跳过checkpoint来换绿。下一项最窄诊断是同一执行中checkpoint receipt latency与DB剩余lease/单调时间消耗的关联；当前数据不足以唯一归因，未实施新的runtime修复或重跑manual。

只读复核查出旧AbortController观察器的分类盲区：生产timer是匿名callback调用stop('timeout')，观察器仅识别Timeout.stop直接帧；arm中的live-deadline和普通finally也可能归入other。因此timeoutAborts0/executorOtherAborts1不足以排除timeout，前面“非超时取消”说法撤回；原数值保留但只作粗观察。

进一步从本次自产configured-app stdout按原路径/长度/SHA校验后，提取已有宿主AUTOMATION_READ_EXECUTION_DIAGNOSTIC的有限字段，实际单条为：firstStop=timeout、phase=source-checkpoint、outcome=outcome_unknown、elapsedMs=21845、checkpointCount=134、cleanupCount=1。原生产callback已在executor分支直接记录首次来源，不是从Error/stack/AbortSignal.reason反推。对应原行SHA `849fd56bb9be456690a8f226aff60c9fe2ddde13545c709a30bdaac1ec7c8918`；未复制该原始日志，不输出原业务内容。这证明manual有真实执行预算超时；未证明为何该预算被耗尽，不能通过放宽timeout来收口。

interval期间只读250ms阈值的Date.now增量与performance.now增量差观测：2494次采样，backwardEvents0、forwardEvents8、maxForwardMs2814。它证明采样窗口两类时钟增量有显著偏差，不单独证明NTP/具体时间服务或manual唯一根因；manual首次没有同期采样，不能倒推。本轮未改系统时间、同步服务或持久配置。

### 本轮交付及仍未通过的门

`candidate-pinned-plm-20261015/`保存13份当前相关源码和11份诊断脚本/脱敏回执，24项源/副本逐SHA一致；无.env、owner文件、原stdout/stderr、原evidence或凭据复制。上轮`candidate-pinned-yida-20261015/`的六文件patch仍是当时宜搭候选快照，不包含本轮PLM接线；不能将它冒充当前13文件补丁或部署包。主检出tracked零改动，原`artifacts/reviews/`未触碰。

静态独立复核、191项合同、原严格14入口类型和diff检查均已通过，范围见下文。PLM manual尚未通过，稳定试用与发布门仍保留；本地interval/宜搭绿不抵消它或旧正式CI失败。本轮未推送、CI重跑、合并、部署、真实客户读取、真实token交换或真实发送，未启动条件尚未满足的Chrome交互试用。完整长期目标未宣告完成。

## 2026-10-15 Owner授权无人值守：固定候选PLM原整链接线及执行记录

Owner已明确批准本地PLM manual/interval、实际host.stop及清理，并要求无人值守，原禁止推送/CI/合并/部署/客户读取/真实发送继续有效。本轮已按原namespace能力链接入候选，不借宜搭owner环境输送：固定selector与完整metadata经PLM owner摘要绑定、Node/Python一致源码清单、scope重建及子进程原preload传递；两个真实browser helper均消费安装后的能力并检查158.0.8107.0。候选binary及原SDK字节未改。实现详见设计MD顶节。

已实际完成：

- 原PLM full-app合同整文件191/191，fail/cancelled/skipped/todo均0，进程exit0、stderr为空，执行前后九份相关源码/合同hash一致。固定回执SHA `319e9129a5634f7d8a07cbb36d54a7a71de5404d497bbf33a8efa9ef59dd0836`。
- 原14入口严格tsconfig直接tsc检查exit0，未改配置/strict/根文件。原Node网络/env guard观测允许/禁止连接、禁止env读取均0。它仍不覆盖此前65项继承缺口，不能用此绿灯抹掉该失败。
- 本轮八份改动文件git diff --check通过。原owned PG模块SHA仍`37b430df4a9edc093d1f8839aeacd90d376088539e19f4a8916d01d501164677`，原native网络隔离模块仍`cf364bfed3960af8e5c387a4c5d7aa882ce1d558c84f937e6b5816ae5927980c`。
- 首次合同复跑新增正例因VM stub返回外realm对象，与VM JSON owner的prototype不同而失败；只将stub返回值改为同VM realm，生产deepEqual未放松。失败保留，不隐瞒或当作runtime bug。
- 已授权独立只读代理复核新增接线，未发现明确新增阻断；确认两个真实spawn均携带namespace preload、两个launch均取候选、缺少安装能力拒绝、默认合法scope不变、原manual/interval与host.stop/PG门仍在。代理未跑测试/读私有owner/log，不能替代实际执行。

控制器首轮manual已终结失败（句柄11766 code1，无signal），PG已移除；没有重新执行manual。其stdout SHA `0bff885ce5da85a981a620ceca9aff44eb42f8f7ed2f4bbd4be2192fd8533e94`，stderr SHA `5270c7adbbb3ec38d6d4a8b26c76dcc54ba5abb9edf2391126b9621c9ebaf9ec`。原证据SHA `724d8a32e55cbbc03680f17d1a331d7618dde4acf6c984cac7b1f471f6e557dc`。控制器原默认停止逻辑已执行；为完成用户已授权的两场景，随后用显式只选剩余interval的诊断参数启动其首次独立试验（句柄13795，最终code0），不是重试manual或把失败洗绿。产品源码从首次执行前冻结至今，仅变更外层诊断控制器；interval最终结果见顶节。

manual闭合事实（不是整体通过）：

- Automation POST202的SDK和Playwright各有1次BODY_DONE/complete，整套记录ABORTED transport事件0。本轮不再是旧POST202误报取消签名；不能据此宣称远端CI根因已唯一证明或发布门解除。
- 同一owner的detail前两次200，第3次503；每次parent观察incoming=1/finished=1/sourceMirrorQueries=1。503对应同请求sourceMirror55P03=1、otherQueryErrors=0、verified=true，是原严格合同许可的受控busy，不是任意503获准。SDK/PW读取该503响应完成；不能沿用历史“503=WSL回拨”的结论。
- 后续await-completed在约21秒仍running/in_progress；所有metadata/native已结、pool waiting0。随后request变outcome_unknown，旧executor观察elapsed35230ms、firstControllerAborts1、timeoutAborts0、liveCheckAborts0、executorOtherAborts1，UI收到固定AUTOMATION_CHECKPOINT_REFUSED。此旧分类已由顶节生产结构化首因timeout纠正；该35230ms从观察器安装计时，不是executor预算耗时。manual无同期时钟采样，不能声称本轮回拨已证。
- actual-stop-resolved实际存在；production-stop失败原因是EARLIER_PROBE_FAILED，非实际host.stop失败。原PG cleanup为stopped-and-owned-database-removed。完整stop proof仍为false，未用清理绿掩盖业务失败。

上述分析只读取并校验本次自产证据/日志路径与hash，从中提取固定诊断、计数、状态；不输出原URL/body/业务ID/原stack，不读CI私有产物、.env或真实凭据。脱敏分析回执SHA `5a784cd00592bb27529030fbf028266ded4f6f402a62dac9897efc27465e46b3`。interval同时新增只读Date.now/performance.now差值采样，记录跳变量而非真实时间戳；不修改系统时间、时间服务或任何安全时钟。原full-app全部断言继续保留。

## 2026-10-15 已授权固定候选：宜搭完整71项及PG清理通过

Owner明确批准在现有#6337内显式固定已校验官方浏览器候选，仅本地完整宜搭71项及停止清理。goal本轮实核active，完整objective保留。此前等待来源裁决的blocked状态已失效；没有把此次授权扩成推送/CI/合并/部署/客户读取/真实发送或条件尚未满足的Chrome交互试用。

### 实际执行与闭合证据

在原隔离组合源码、Linux非root用户下，清空继承环境后实际执行：

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner \
  /usr/bin/node scripts/ops/run-stock-preparation-yida-browser-ci.mjs \
  --pg-bin /usr/lib/postgresql/14/bin --browser-candidate upstream-1719529
```

工具进程最终exit0，原公开结果为`passed:true, tests:71, business:66, sentinels:5`。不是测试筛选、retry、跳过或仅静态投影；实际五整文件、原Vitest/task collector、原内核网络隔离和自有PG生产路径均执行。后置独立审计重新读取仅本次自产owner/receipt/tasks/report，验证ownerSha、sourceSha、每个实际输入文件/binary SHA、五文件与71项、原隔离模块及原PG模块固定字节；没有读取CI私有产物或真实凭据。

| 证据 | 结果 |
| --- | --- |
| 宜搭五整文件 | 71/71，66业务+5哨兵，failed/pending/todo均0 |
| 实际Vitest进程 | code0，signal/timedOut/interrupted/outputExceeded/error均false |
| 自有PG | 原stop实际通过，`stopped-owned-pg-removed`；保留原pg_ctl状态/身份/停止后状态与目录移除断言 |
| 候选浏览器清理 | 后置只读/proc元数据核对，该专用binary存活进程0 |
| 来源固定 | 原owner/source完整性链包含新模块与实际binary，测试前后hash一致，运行版本必须158.0.8107.0 |
| 入口/工作流整文件合同 | 64/64，无跳过/取消/todo，exit0，stderr为空 |
| provenance | 原sealed-export-package-provenance整文件通过，exit0 |
| 本轮跟踪文件diff检查 | git diff --check通过 |

主binary SHA仍为`43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925`。新模块只允许字面量`upstream-1719529`与固定隔离路径；未知候选、任意binary路径、ambient变量、外来owner路径、错误binary字节和owner篡改均拒绝。未指定参数时原默认浏览器不变。新增三条合同覆盖默认/环境/owner边界、错误binary以及owner摘要篡改；最初定向3例的32个筛选跳过不充当整文件结果，最终64项才是本轮整文件证据。

关键脱敏回执SHA256：

- 原worker receipt：`e088b414c9151f4eced93e5a13ee193b99d95b511aee53d7f0692040694dc69a`。
- 原task receipt：`ac9bfc9dbc2d729b653cbcd7282faa9a633d98931cf2637f88cadb4d0613dd90`。
- 原Vitest report：`ce9a0156015fe1cbabca25b1814fb9fddf6d88fdbe21906ff0e7b5ade780c001`（只记录hash，不复制含原始结果的报告）。
- 独立闭合摘要：`4a7c8cff7e29b7dedef43291543f2505575550d0df3dcf0df113aeb5a01f7c21`。
- 64项合同回执：`7cbd2226870378d58ec2ecb67fe587b90979e78303bf6ecedac54ae968d09395`。

### 来源守卫的定向变异补验

后续续跑实际补验三条守卫：binary SHA、owner摘要、固定selector。每条先用原模块执行同一个真实合同用例，均exit0/1通过；再由只在诊断子进程加载的CJS hook把该模块对应守卫单独移除，三条均为真实合同断言失败、exit1/1失败，全部杀死。修改只发生在内存，模块与合同文件前后SHA不变；未改71项时的源码，也未重新运行或替换其整链回执。没有新增browser/PG进程、网络或真实发送。

变异控制器主动筛选三个单条合同，故其它用例的SKIP如实留在定向回执里，不能算本轮完整64项或71项证据。它补的是三条明确守卫的反事实敏感性，不声称所有来源/同UID对抗都已证明。固定回执`pinned-yida-local-mutations-receipt.json` SHA256为`6f00e4fdce5f2ed1b39204c521c631ea142ffb920f473873674e444a88d26522`；源码、hook和回执一并加入现有本地交付目录，未推送。

### 补充语义检查：已有类型覆盖缺口，未伪报通过

实际亲读`tsconfig.stock-preparation-plm-full-app.json`：其14个入口不包含本轮改动的宜搭owner-browser helper；`tsconfig.stock-preparation-yida-synthetic-trial.json`只纳入另一trial入口，也不能据此覆盖该helper。本轮诊断程序保持现有full-app配置的所有compilerOptions（strict/noEmit等）不变，额外纳入该helper实际完整依赖图949项，TypeScript pre-emit diagnostics实际为65，进程exit1。保留失败回执SHA `406a2b8d06ed9d8955253f4f1d256844ad9735c3bbdae24aab4026df523ec871`，不是正式原配置或全包typecheck通过。

随后仅从Git精确fcb20导出该一个代码blob（SHA `55cb81f78be16fa04fe000379d8d4f6301e8a54d854f65bea03decaeddd3390f`），在内存CompilerHost中替换该helper作对照，未改工作源码：原14入口0诊断；14入口+冻结helper65诊断；14入口+候选helper65诊断。逐项比较code、文件、message摘要、length及按本次文本前后共同段映射的source offset，指纹完全一致，未观察到本轮新增诊断。对照进程exit0仅证明对照一致，不是把65项修绿；候选扩展strict compilation仍为false。仅该helper冻结，依赖图仍为组合源码，不声称整树fcb20类型检查。

对照回执SHA `b4cbbce6db87a76df3178dfa0d003f7d775eb265aeb8d94293bd3b69b93e32f3`。两个过程都加载原只读网络/env防护，允许/禁止连接、禁止env读取计数全0，没有DB、PG、browser或业务执行。类型覆盖缺口记为遗留，不为消除它降低strict/新增any，也未将65项扩成未经授权的修复切片。源码、原71项及精确head补丁字节未变。

### 范围与剩余门

后续安全收尾已补齐针对远端精确head的机械补丁：从主仓Git对象只导出fcb20c3d的五个相关代码blob（不读.env/历史JSON），与当前五个改动文件及新模块形成六文件patch。独立临时Git/index先按原blob重建基线，执行apply --check --index、实际应用、六文件逐SHA对照、反向检查及diff --check均通过；当前源码前后不变，没有应用到产品主检出。patch SHA为`4620f1502b0c976ff457716426a1c6af75db6df7358e3730f87584c192451c69`，精确head补丁回执SHA为`780a83fbfa559a76d8a53b68620168723b0070a059f12af3978b78b4f2c59124`。原PLM公开诊断CLI与fcb20字节一致。

首次机械审计失败保留：用cacheinfo写入blob而没有刷新stat缓存，apply --index拒绝does not match index；修正仅为在clean审计副本update-index --refresh，未改产品或patch内容，后续检查完整通过。初始patch保留但未作为闭合证据；交付使用带-verified后缀者。此结果仅证明精确基线上的六文件补丁可应用且字节匹配，不把组合树71项冒充完整fcb20+patch整树已测试；该限定已写进独立回执与README。

这证明固定候选下宜搭初始化、预览及合成发送/拒绝路径的本地原五文件链已通过；外部网络由原namespace边界限制，发送端是测试合成sink，不是平台真实token交换或宜搭写入。fixture是实际Vue面板+JWT/core/PG，不是整个Workbench正常登录交互验收。未将其伪报为后者。

本轮没有改production SDK、工作流、锁文件或默认浏览器，没有新增产品切片。此前两文件stop归因补丁不变。PLM manual/interval及其host.stop/collaboration证明尚未在此浏览器候选下补验；本次自有PG清理不能代替它。正式同head CI run38673376578失败、宜搭skipped及发布门继续保留，本地71绿不抹掉250ms lease、旧宜搭失败与WSL回拨历史风险。

后续只读核查补充：PLM的namespace owner是独立固定键协议，且runAcceptance再清空环境；宜搭owner读取器不能直接套用，否则其缺失owner时的默认行为会继续选原浏览器。下一步必须沿原PLM owner/子进程能力/来源清单显式传递候选，保留原actual-stop与完整stop-proof的区别；设计MD顶节已写出最小方向。本次未改该链源码、未启动PLM验收、未读取其旧私有日志，也未把自动goal续跑视为扩权。

沿用已授权只读代理的本轮接线审阅已返回：未发现新增明确阻断；确认固定选择/默认不变、binary进入owner/source完整性链、fixture真实使用候选且检查版本、71项及原生隔离/PG停止移除断言未放松。代理未执行测试或读取私有owner/log，不能把其代码结论冒充运行回执；本轮运行与后置审计由主任务执行。同UID恶意文件替换不在原保证范围内。

隔离源码Git HEAD实际为`7ccd6da23c92d45a0c4ef4ee02de7111d8310291`，叠加此前诊断/两文件归因补丁及本轮候选接线，不是远端fcb20整树。原两文件归因补丁SHA仍为`bc4ab1633234fb99994f5131e3e56e8922005f89b2bfe4145c253827761cdcaa`与`ae34356df17160e67039e10494f8a40897beb069b044bb19be76eb6c7c673ee4`；未改写。四份本轮源码、两份脱敏摘要和两个审计脚本已复制至`candidate-pinned-yida-20261015/`，八项逐SHA一致；没有复制原owner、私有日志、原Vitest报告、.env或凭据。主检出tracked仍无变动。

仅本地修改与合成执行，无推送、CI重跑、合并、部署、客户读取或真实发送。

## 2026-10-15 续跑复核：浏览器来源决策仍是同一前置

本轮重新读取GitHub，#6337仍OPEN/draft，head仍为`fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`；主检出tracked无变动，既有`artifacts/reviews/`未触碰。没有运行或重跑CI。

亲读现有公开宜搭验证器：`run-stock-preparation-yida-browser-ci.mjs:169-174`只接受`--pg-bin`，`:158-167`只保留HOME/TMPDIR/PLAYWRIGHT_BROWSERS_PATH等OS路径；真实浏览器fixture在`:407`固定使用`chromium.executablePath()`。其worker在原生namespace/无capability环境启动自有PG，仍要求五文件71项、66业务+5哨兵、无pending以及实际PG停止移除。此入口没有受审的另一浏览器binary参数。

因此，既有公开入口不能不改来源就验证已校验的158候选；用缓存别名替换原143、额外preload注入或借另一套绿灯会破坏证据准确性，本轮未执行。前轮已要求确认正式固定浏览器来源，但尚无该确认。当前本地候选24个阳性、12个负例、4个字节守卫变异和PLM290项等证据保持各自范围，不重复执行来制造进度；新配置整链/正式CI/Chrome条件试用仍未达成。

本轮只增加了上述当前状态与真实入口限制核验，不新增应用代码或产品切片。原目标完整保留；需要的下一项裁决为：是否允许在现有#6337内显式固定已校验官方browser候选的测试执行来源，先仅本地整链验证。推送/CI/合并/部署/客户读取/真实发送均不随此裁决获得授权。

## 2026-10-15 长期目标恢复后的首轮：原验收范围与PLM业务补验

本轮get_goal实际返回active，完整objective未改写；此前blocked为当时工具状态的历史记录，不再当作当前状态。上一轮已完成有效浏览器候选/反驳/原始回执，属于progress，而非等待或空转。本轮没有把目标缩成“浏览器样例通过”，也未标complete。

当前main和隔离组合源码均没有目标MD。通过本聊天既有worktree附件定位到原文：`C:/Users/zen08/.codex/worktrees/integration-goals/metasheet/docs/development/integration-self-service-adaptation-goals-20260930.md`，SHA256 `410961bbe4fea14cbb2d04e6e52fb9e970f69f3b9e3a43c9a637da9b55f50c26`。本轮亲读基础目标/SA-01至SA-06最低条件、§4既有裁决、§6真路径/正确性/权限/HTTP/宜搭/触发/可达性/证据要求、§9阶段区分；未把其大量旧实施记录当当前完成证据或扩权指令，也不把找到原文等同完整完成审计。

新增实际执行10个既有整文件：bom-expansion、read-plan bootstrap/catalog/store/management/execution-identity/runtime/validation-ledger/validation-read/validation-runtime，共290/290，fail/cancel/skip/todo均0，进程exit0，测试文件前后hash相同、stderr为空。固定回执SHA `c9a9eb1d6de4a21ba0ffad25b52266caa1e916703ffcb427e00ce08b75128d0f`，原stdout SHA `000bf54962232c75dc0a3b0c9e95c3478f23391fabc8b00721ddb4c09a9a8477`。运行源码为现有组合候选，非三支冻结head独立测试；Node合成adapter/内存事务边界不是实际JWT/PG或客户读取。

与目标逐项对应的本轮证据和限制：

| 目标要求 | 实读/执行证据 | 仍不能推出 |
| --- | --- | --- |
| SA-01订单指定BOM版本，不被物料最新版本覆盖 | bom-expansion测试`:182-370`包含版本有效性、无活跃匹配、歧义与冲突；相关整文件实际通过 | 客户MSSQL/真实订单字段已验收 |
| 数量、缺失、循环、部分结果不能伪成功 | 同文件`:584-606,639-732,800-815`包含循环/缺件歧义、NULL/空数量与真实0区分、预算拒绝 | 任意Bridge读法完整或全部业务有效期已确认 |
| SA-02已批准激活身份贯穿实际预览/失效旧许可 | execution-identity测试`:175-290`实际composition/normalizer/dry-run及旧许可apply拒绝；store、management、validation整文件通过 | 另一owner/另一物理布局已在当前浏览器配置完成完整UI复用 |
| 可信tenant/owner、K3永久禁写 | 上轮冻结生产链复核及K3永久拒写证据继续有效；K3 claimless/header继承风险仍保留 | 因非新增回归就宣布整个目标的租户不变量成立 |
| 宜搭不发送预演与可靠受控能力 | 上轮Web181、Core99、plugin491及本地浏览器24/12/4回执各按自身范围有效 | 完整同配置71项/正式CI/真实宜搭发送已通过 |
| Automation沿既有引擎与独立授权 | 本轮store包含#6337私有source锁定接口回归，未扩scheduler、消费者或写权限 | 新浏览器下manual/interval、所有旧时序失败已解决 |

因此下一关仍为正式固定浏览器依赖/验收来源及原始整链验证；未收到上一轮所请求的采纳确认，不能把自动目标续跑当成同意更换来源、推送或运行CI。当前仍能做的安全独立核验已先完成。继续保持宜搭为首要目标及四PR既有范围；不另开SA切片，不依据旧§11工作包去恢复封存线。本轮未改产品源码、推送、重跑CI、合并、部署、读取客户/凭据或真实发送。

## 2026-10-15 本轮收敛：有效浏览器候选已验证，正式依赖/整链门未解除

**当前首要目标是宜搭初始化与推送预览稳定可试用。** Owner无需在电脑前参与本轮合成工作。已完成安全独立的本地调查、候选验证、前三支指定生产链复核与MD；没有把本地候选替换为正式CI浏览器，也没有宣布全部交付完成。

### ABORTED 的新事实与修复方向

官方Chromium CL8508456把DelegatingBytesConsumer的terminal结果登记移到client通知之前，避免已EOF的流被回调重入Cancel记成取消。本轮读了精确revision源码，并取得包含修复的官方snapshot1719529；这是上游实现解释与浏览器候选对照，不是本机原生栈或只改该三行的patch-only实验，不能宣称远端CI唯一根因已证明。

| 实际浏览器 | 源码terminal-before-notify | 本轮限定结果 |
| --- | --- | --- |
| 冻结143.0.7499.4 | 无 | 重核仍路由4/4红；另一个代理无路由格也红，不能说路由是必要条件 |
| 稳定参考156.0.8078.4 | 无 | 保留此前失败，不能拿版本号反驳尚未包含的修复 |
| 当日alpha156.0.8078.12 | 无 | 同上 |
| 官方隔离snapshot1719529，158.0.8107.0 | 其官方REVISIONS对应源码有 | 最终三轮8格，共24/24真实请求完成 |

最终clean阳性不改reader、不加SDK诊断、无binding，真实SDK/原HTTP请求/原Vite代理/route防火墙；每格必须SDK返回准确DTO、PW FINISHED、启用CDP时原生FINISHED、随后host读取原响应成功、服务端正常finish且无premature。原SDK SHA `b31241cebc7df5efb12872a946def9dcc772998d4864a925a5a75674463e8c56` 未改，1MiB/15秒/no-store保持。三轮是固定快照，不累加之前所有尝试夸大通过数。

官方zip：251,659,180字节，公开对象MD5核对成功；SHA256 `691d6469ab37218a362aafffff974fd378985d1428c2a690c6dbeb73501bbe51d`。Windows直接读取zip内chrome条目计算SHA，与Linux实际解压binary相同：`43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925`。snapshot的CDP revision实际全0，首次按精确Git revision断言因此失败，已保留该失败说明；后续以官方对象/REVISIONS、zip校验、实际binary SHA及版本绑定，未把全0伪报为源码revision。校验现在在browser finally内。

公开源码SHA：原143 `28d36671e27eb9d4378c9a8c20a986883e1ad54b5fc8a9b100c103b1968231b5`；两个156参考均 `667ec6672e478ce6841cfeacdd1c09d0d560463ae461b9109beae962f5d9a037`；新snapshot `979ce76e70424734af0539e1858345b2e000a422fba5d34170d4748364143047`。源码审计首次以旧函数应有HandleResult(result)作断言而失败；实读发现旧代码在通知后的switch才HandleResult(kDone)，修正为同时识别旧分支后四项审计成功，不把“缺失marker”当无补丁的唯一依据。

### 负例、变异及清理

- 最终真实SDK负例覆盖代理×路由×超限/截断/主动取消，共12个联合观测全部符合预期；没有成功DTO、没有native TIMEOUT/OTHER绿。超限用chunked、无Content-Length、合法DTO前置大段空白，防止被header或DTO其它守卫兜住而假绿。
- 保留 `post-ci-upstream-negative-proxy-result.json` 原严格oracle 10/12红：两个代理截断仍被SDK拒绝，但native最终是ABORTED而非直接链路的CONTENT_LENGTH_MISMATCH。没有把它们说成产品修复。新增独立observed回执证明上游aborted/incomplete、真实15000ms callback触发一次、实际signal abort一次、SDK INVALID、原生FAILED/ABORTED同时成立；SDK原定时器、delay/参数/this/ID、原fetch参数/Promise都原样保留。它是带透明runtime诊断包装的负例，不是clean阳性；事件计数不单独证明跨层严格顺序或唯一因果。
- 临时bundle移除唯一字节守卫，四个超限变异均返回准确DTO、native FINISHED，但负例断言明确变红，进程exit1。原SDK文件未改；不能把预期变异exit1当待修产品失败，也不能隐藏它。
- 诊断context创建已移入try，context/Vite/server各有独立finally；四个实际newContext拒绝注入（两fixture各直连/代理阶段）均正常进程退出、无强杀。只说明本次注入路径，不声称枚举全部OS/分配失败。最终独立元数据审计本次官方binary存活进程为0。
- 最终执行器记录实际子进程退出码：三阳性0、负例0、变异1、四清理注入0；脚本执行前后SHA不变，所有stderr为空。不是仅靠JSON里pass字段证明进程退出。

### 宜搭应用回归与三支复核

本轮宜搭Web三文件181/181、Core四文件99/99、插件17文件491/491均通过，无跳过/取消；插件固定回执SHA `b7a2514b4ae23565366a523ecb97bb10129f3d2bc8075e1bec59fd29ce2d1ec0`。它们分别是合成DOM/控制/查询/插件合同，不冒充新浏览器的71项整链或真实JWT/PG授权证明。

#6315/#6323/#6324指定生产链只读复核未确认新增P1/P2阻断；冻结head本轮末只读重核均未变，#6337仍fcb20/draft。继承的K3 claimless-JWT/header-tenant风险仍需单列处理，不能签全系统租户保证闭合，准确冻结坐标与范围见下一节。宜搭初始化不持有send/token能力，发送仍精确开关+live ACL/永久owner anchor+一次permit；PLM目录/样本receipt在批准、激活与普通执行真实接线。复核不等于所有diff/所有部署条件终审。

### 固定交付物与剩余门

19份脱敏诊断源码/回执已复制到 `diagnostics/upstream-20261015/`，源/副本逐SHA一致；不含.env、真实凭据或CI私有产物。闭合摘要SHA `d336607e8159b95efca8914f97b2cec45c8ffda3a81655f5a2046646e13b2905`；最终执行回执SHA `62d0e5c825859fb74ddad84206d14ff31aa43841d01ffd3a2dd14e252a53acae`。官方binary/zip仅在本机隔离位置保留，未安装为系统默认浏览器。

仍未完成：正式受审的浏览器依赖/执行来源固定、该配置下原manual/interval与宜搭五文件71项、实际stop/自有PG清理以及同head正式CI。当前没有采纳snapshot到仓库包/锁文件/workflow/CLI，也没有用cache别名把158伪装成143。旧CI run38673376578 failure、宜搭skipped及原Chromium门保持；历史250ms lease/WSL回拨等风险不被本轮绿抹掉。此前local71及PG清理只能留作旧配置证据。

本轮新增的是本地有效修复候选及验证材料，不是新的应用源码补丁。既有两文件stop归因补丁不变，主检出tracked零改动。没有新增产品切片、推送、CI重跑、合并、部署、客户读取、真实token交换或真实发送；没有启动条件尚未满足的Chrome UI试用。

## 2026-10-15 宜搭优先：三支复核与精确 Chromium 补丁核验

Owner不在电脑前，当前首要目标改为宜搭初始化/推送预览稳定可试用；仍仅本地既有范围，不推送/重跑CI/合并/部署/客户读取/真实发送。目标工具仍blocked，不冒称已切active。独立只读复核沿用此前授权的Astra ultra代理；主任务负责所有本地执行和MD，没有并发写产品文件。

本轮新增本地合成测试：

- Web三整文件：StockPreparationYidaInitialization 58、StockPreparationYidaPreview 98、StockPreparationYidaOwnerSend 25，共181/181，exit0。
- Core四整文件：yida-initialization-runtime、yida-initialization-http-boundary、yida-owner-runtime、yida-owner-request-logging，共99/99，exit0。
- 均在清空继承环境的隔离组合源码执行、无CI重试。Web是DOM/合成fetch测试，Core为控制/查询合同和假端口，不冒充真实JWT/PG或浏览器端到端证据；导入PoolManager打印未设DATABASE_URL警告不代表已连接数据库，测试走假query/端口。此前94/94与五文件71/71保留为各自独立范围，不相加冒称完整端到端项数。

前三支指定生产链只读复核已完成，未确认新增P1/P2阻断项，不等于全部diff/所有环境下安全终审。固定head：#6315 db35b3f9678e48c90821ceb8d9ee315b8715f30e；#6323 651463427eb788c6886cbded7b6103187ae572db；#6324 9d843d8928714da179a73bcb0aaa1da5ac7276a7。

1. 宜搭：冻结db35的route `packages/core-backend/src/routes/integration-yida-owner.ts:63` 只采用authenticatedTenantId/真实用户；initialization runtime `:181-195` 做live ACL、永久owner anchor；producer `plugins/plugin-integration-core/lib/yida-initialization-producer.mjs:104` 只做本地材料/草稿/目标持久化，没有fetch/token/send能力。发送runtime literal true、fresh一次性permit、未知结果不重试、永久CREATE fence均接真实链。宜搭专用37项代码/SQL与组合源逐blob一致，共享index另有后续变更。注册坐标为 `db35:packages/core-backend/src/index.ts:2082`，不是组合源2134，不能链接当前main行号冒充冻结证据。
2. K3：冻结651的 `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs:2495` login前永久拒绝upsert，profile实际接入读取runtime。**继承风险需独立登记**：`http-routes.cjs:1629` 的claim-required flag未设置时false，`:1535` 因而不强制可信claim；JWT middleware `:101,106-108` 保存authenticated tenant后仍把header填入缺失的user.tenantId；插件scope `http-routes.cjs:1341` 消费它，K3 `/read` 在 `:6213,6226` 依此scope取配置/Binding，没有再次做membership检查。有效且有integration:read/admin的无tenant claim用户在该配置下静态可达其它header租户。此代码与前基线相同，不是#6323新增回归，也未执行攻击/客户访问。K3授权单位本来是tenant/workspace Binding，不把缺SQL Connection owner resolver单独报bug。应在可信claim或宿主membership边界修复，并补真实JWT→注册插件负例；当前不扩大既有宜搭收尾切片去改全局认证，也不宣称K3租户保证已全部闭合。
3. PLM：冻结9d管理handler `stock-preparation-read-plan-management.cjs:257` 强制admin/verified tenant/host principal；宿主facade当前owner检查；真实catalog/sample读取产出服务端receipt，绑定actor/版本/源修订和有效期。冻结store `:207,282` approve/activate重验confirmed receipt，普通执行路由 `http-routes.cjs:4674` 实际消费active plan。组合store新增lockActiveForAutomation属于#6337，不计为#6324证据。089、090–096及两个validation/revision迁移已注册，静态未见此组内部编号冲突；未运行生产迁移或真实客户库。

独立复核边界：K3新HTTP合同直接注入user的内存替身未覆盖上述真实JWT链；PLM host-realdb由fixture建立Binding、未覆盖完整host.start；宜搭真实JWT/PG合同的外部fetch为合成sink。复核代理未写文件/跑测试，以上新增181/99由主任务执行。

浏览器上游调查出现可检验新事实：官方 [CL8508456](https://chromium-review.googlesource.com/c/chromium/src/+/8508456) 已MERGED，commit `62473ad0f747e245e514c93e741bb8e168a2a207`、position1712735。其三行改动在DelegatingBytesConsumer::OnStateChange通知client之前HandleResult(result)，防止EOF回调重入Cancel把已终结请求记为取消；这是上游实现解释，不冒称本机已经抓到C++栈。

用Browser.getVersion读取实际二进制revision，再逐revision读取官方gitiles源码：原Chrome143 `ee5ecaf663495e92dfe322aa76c114a3465602ab`、稳定参考Chrome156 `f842f52ef39fd97b449eb27cff414bf05a98ddce`、当日alpha156 `634b046faf2137b83af71c87baf362b533af9104` 均没有该三行；此前“升级版本仍红”不能据此反驳这个尚未包含的补丁。官方snapshot1719529 `4fc22c1403a9941ca0b2fb004c95d22fc391beaf` 的公开源码包含terminal-before-notify。只在临时目录下载官方zip、按对象公开长度/MD5校验后才执行，不改系统浏览器或仓库依赖。下载/本地对照结果另记，未预写通过，更不改正式Chromium门。

## 2026-10-15 恢复推进：前三支固定代码核验与 Response 寿命对照

本轮继续既有四支，不新增切片。只读 GitHub 确认 #6337 head 仍为 `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`，run `38673376578` attempt 1 仍 completed/failure；未重跑。原目标记录仍 blocked，工具不提供恢复操作；没有伪报恢复成功，也没有为重建目标而将旧目标标为完成。当前用户的明确继续指令用于推进本地工作，不扩大权限。

前三支本轮完成的是重点路径复核，不是完整终审：

- #6315：`yida-owner-send-port.mjs:83,90-93,109-130` 限 owner 且默认关闭，入场、取得执行材料及 token 交换前重复检查精确字面量；`yida-credential-material-store.cjs:84-85,104-128` 查询与解密信封均绑定 tenant/workspace/owner、凭据引用与代次，必须有宿主加解密依赖。两模块 LF 归一哈希与其固定 head 完全一致。
- #6323：`adapters/k3-wise-webapi-adapter.cjs:1847-1887` 对实际生成的 wire pathname 检查意图，并在原 fetch 设置 redirect:error，额外拒绝 3xx/redirected 响应；这不等于断言整个旧适配器不存在生命周期写方法。B4 profile 与适配器模块均与该 PR 固定 head 一致；仍须由只读入口与许可配置约束可达操作。
- #6324：`stock-preparation-read-plan-management.cjs:91-123,170-220` 当前 owner/可信 tenant 的 canonical 注册检查先于管理操作；`stock-preparation-read-plan-validation-ledger.cjs:124-163` 锁定 source revision、owner、binding revision，要求 confirmed 回执；store 的 approve/activate 分别在 `:237-238`、`:312-313` 重验回执。management/validation-ledger 与固定 head 相同。store 不相同，已明确追到 #6337 增加的私有 lockActiveForAutomation 等差异，不能把组合候选测试冒充 #6324 独立 head 测试。

本轮运行完整五文件：`yida-owner-send-port.test.cjs`、`yida-credential-material-store.test.cjs`、`k3-wise-redirect-fence.test.cjs`、`stock-preparation-read-plan-management.test.cjs`、`stock-preparation-read-plan-validation-ledger.test.cjs`，94/94，零失败/跳过/取消，进程 exit 0。使用隔离组合候选，只合成材料；K3 重定向测试只启自有 loopback 服务，不接客户。七模块固定代码核验脚本为 `tmp/6337-parent-focused-review-20261015.mjs`：6 项一致、store 1 项不同，脚本保留 exit 1，不掩盖差异。

迁移文件名只读复核：宜搭 090–096，PLM 089；source revision 时间戳为 `zzzz20261001120001`，已非早期撞号的 `...120000`。本轮未运行任何迁移，也未完成与最新 main 全量重复编号/部署兼容终审；仅文件名正确不能作为数据库验收。

ABORTED 新因果对照：只在 clean fixture 的临时 SDK bundle 中，在原 fetch 返回后保留原 Response 强引用，直到 PW/原生 CDP 终态及 host body 取样后删除；不 patch reader、不安装诊断 observer、不强制 GC、不加客户端 sleep、不改 route/no-store/上限/超时。8 格 4 通过 4 失败，路由四格仍为 SDK 返回准确 queued DTO、PW ABORTED、host body 不可读；启用原生 CDP 的两格也 ABORTED/canceled，服务端全部正常 finish、无 premature close。结果反证“只因 Response 在 SDK 返回后失去强引用”足以解释失败；不声称已排除所有浏览器内部生命周期问题。强引用不是产品修复，原 SDK 源码哈希不变。

新回执 `browser-fix-probe/post-ci-clean-retain-response-result.json` SHA256 `4a03d0688bb340a58028804aec4335093c4eb61c7c932963bdff9db4dcdac913`；诊断临时输入 SHA `ba1d972ebadcbf85648ef9e4024d583fa183115f5237651425b54aaf2307d8ea`。fixture 按 finally 关闭浏览器/context/Vite/server。没有新产品补丁，先前两文件停止归因补丁不变。保留正式 CI 失败、宜搭 skipped、Chromium 发布门；没有启动条件尚不满足的 Chrome 试用。未推送、重跑 CI、合并、部署、读取客户数据或真实发送。

追加两项限定诊断（不是产品候选）：

1. 临时 bundle 省略 reader.releaseLock 的因果对照仍路由 4/4 失败，八格 3 通过 5 失败；不据此删除产品清理语句。回执 `post-ci-clean-no-release-result.json` SHA `cb3d09cff2eaa706a2ec08c149ab6ff3f6100f82d587076557a5e4931586395a`，原 SDK 文件不变。
2. 在 Playwright 原 CRSession.send 外透明计数，只允许固定协议方法、错误枚举、布尔和栈哈希，原参数与 Promise 原样转发，不输出请求值/ID/URL/原堆栈。网络终态前未见 Page.stopLoading/Page.close/Target.closeTarget；路由臂有 Fetch.failRequest，但其 interception 与最后 continue 的不同，调用路径为 FrameManager.requestStarted → RouteImpl.abort。实读原依赖 `lib/server/frames.js:233-236`：此直接调用对应 favicon 内部拒绝，不能把它误认成 API 被 route 防火墙主动取消。API 的原生 ABORTED 仍未解释；代理无路由格也存在时序失败，本轮八格 3 通过 5 失败。原 SDK 临时 bundle 输入与原文件哈希相同。第一次命令审计因包未直接暴露给 backend 的 require 而在浏览器启动前失败；改用隔离安装的准确 1.57.0 模块位置后运行，未安装/修改依赖。中间粗粒度审计快照被后续增加关联布尔的同名回执替代，不能当独立额外通过。

只读复核代理本轮结论为“尚无未重复且有证据支持的安全修复候选”；它只复核到 Response 寿命对照，后续 releaseLock 和协议命令诊断由主任务执行，不冒称代理已终审。下一调查边界是原生加载器的内部取消来源，而非继续改应用超时、禁用防火墙或忽略失败。浏览器发布门与所有权限禁令不变。

最终协议命令审计回执 SHA `eb66cfd797d8a26c3b9593d34913f37e15d0f53a3119260396bbb7fd698a3a29`，位于隔离目录 `browser-fix-probe/post-ci-clean-command-audit-result.json`。本轮所有诊断仍 exit 1 保留真实失败；主检出 tracked 零改动。

## 2026-10-15 目标收尾启动：只读复核后的无观测干净对照

Owner要求按剩余事项设目标、按难度选模型/effort。线程已有未完成长期目标且工具仍blocked，新建请求被拒绝；没有误报create_goal成功或把旧目标标为完成。当前子目标/完成门/模型分级已写入设计MD顶节，沿用已授权只读复核代理，禁止多模型并发写相同文件。实际开始了独立只读复核和主任务对照，不仅登记计划。

只读复核指出原复现仍共同含reader observer、binding首块放行、host在SDK前settle读取；其负例为手写分支，不能称原SDK负例全部通过。主任务已补无这些共同条件的clean对照：真实SDK原模块（SHA b31241ce…63e8c56）、不patch reader、不装SDK诊断、无binding、服务器自行两次写（20ms仅服务器分段fixture，不是客户端修复sleep），SDK与网络终态settle后才读host body。代理×路由×额外CDP八格中，路由四格均SDK返回准确queued DTO，PW ABORTED且host不可读；额外CDP开启两格也报告原生ABORTED/canceled。服务端finish均true、premature均false。额外CDP、代理、提前host读、reader observer和binding均非路由失败的必要条件；无路由的代理臂仍有时序敏感，不笼统声称所有非路由格必绿。只读复核确认旧clean快照已排除上述共同条件，但不等于浏览器内部调用栈/CI唯一根因已证实。

采纳只读复核的验收建议：最终clean脚本在启用CDP时显式等待独立native终态，并要求native FINISHED才可pass；不再只等待PW终态。最终基线8格3通过5失败，路由4/4失败。唯一建议候选BYOB只在临时bundle内替换原SDK reader/loop（每次至多64KiB或remaining+1、done非空先处理、保留session/abort/UTF8/DTO/15s），产品文件原字节未改；8格4通过4失败，路由4/4仍ABORTED，因此未进入产品，也不浪费整链验收去掩盖最小复现失败。

固定摘要 `goal-clean-evidence-20261015.json`；clean脚本SHA `6a3f3eb4ab7d2030d68e19d64abda992e776940f65288661d3ebe085ec107eac`，基线结果SHA `157a443a8c15f5e06d33c868d2674f7733bebfb1d89a851878ae2b7018a2e12c`，BYOB结果SHA `3035c5de5c6c1087adc23918175cb74687b94ca9484164799ca165112892e32b`，候选bundle输入SHA `5898967049687dbf8026a68ef4a94003f61df4cb871d32be90252f01aaaf20af`。副本在本地diagnostics，不新增产品切片/工作流，不伪报任何修复完成。只读复核未改文件、跑测试或读private；后续CDP断言加强和BYOB运行由主任务完成，不能把此前审阅行号冒称最终脚本终审。

四PR状态只读抽查：#6315 head db35b3f9678e48c90821ceb8d9ee315b8715f30e，OPEN非草稿；#6323 head651463427eb788c6886cbded7b6103187ae572db，OPEN/draft；#6324 head9d843d8928714da179a73bcb0aaa1da5ac7276a7，OPEN/draft；#6337仍fcb20/draft。本地git元数据逐级merge-base检查确认这三组准确父head已是子head祖先，不读取历史文件内容。PR rollup抽查分别为61SUCCESS+1SKIPPED、26SUCCESS+2CANCELLED、43SUCCESS；取消含重复历史名字，不未经逐job去重便判新阻断。#6315有test(20.x) SUCCESS；后两支该rollup无此项，不能借此断言其完整独立正式合成链已过。它们尚未完整重审，G2保持未完成。未新建分支、推送、重跑CI、合并、部署、客户数据读取或真实发送；原Chromium发布门不变。

## 2026-10-15 本轮最终结论：POST已复现，五个候选未修复

官方 `playwright-core@1.65.0-alpha-2026-10-15` / Chromium `156.0.8078.12` 的隔离对照也已结束：8格中3通过、5失败，路由四格全部重现原生CDP与Playwright ABORTED；回执SHA `4c63c7a7bb8392b7d332f2fb6a6d031e32c06722f56ee05364ab10ec0732312e`。不引入预发布依赖、不把上游声称修复当作本机验证通过。五种候选（新稳定构建、官方当日预发布构建、额外session缓存对照、reader.closed、有界native转换）均未解决路由场景，没有选取一个写入产品。

最终固定材料为9组/68个case快照，包含正常失败、成功参考与真实负例，严格红灯保留；摘要 `post-202-ci-reproduction-20261015.json`，实际生产客户端源码SHA `b31241cebc7df5efb12872a946def9dcc772998d4864a925a5a75674463e8c56`，真实SDK矩阵回执SHA `d1dd6968de606fbd497ba6d4a711dc8116f31b89a4b938bb3aa30822e5290530`。真实SDK成功完成DTO校验、路由四格原生失败的可复现签名已坐实，但未捕获浏览器内部调用栈，不能宣称上游内部根因或CI唯一根因已证实。当前还没有保留既有安全边界的、已验证有效的ABORTED最小产品修复。

本轮没有新增产品补丁，也没有为了过门而重跑完整应用/宜搭；前轮189项合同、原manual/interval全链与宜搭71项结果仍仅是原始本地证据。再次只读独立审计manual原回执、全部业务验收器/18流/嵌套进程/6,587源码输入，字节仍一致、原停止和PG清理证据仍有效。主检出tracked零改动，既有两文件停止归因补丁字节未变。所有本轮fixture按finally关闭context/browser/Vite/server，官方临时安装进程已exit0；首轮挂起诊断的精确中断另有记录。临时浏览器与脱敏诊断材料保留在本机隔离目录供复核，未安装到系统或改默认浏览器。

因此保持远端失败/宜搭skipped与Chromium发布门，不启动有条件但尚未过门的Chrome试用。继续推进若需要更换交付浏览器策略或改变验收来源，应单独裁决，不能在本轮以禁用路由、改变私有响应缓存、无界解析、忽略取消来绕过。未新增切片、推送、重跑CI、合并、部署、客户读取或真实发送。

## 2026-10-15 继续对齐CI：POST202失败签名已复现，尚无修复

已进一步走到真实生产客户端：以现有esbuild打包原 `automationRead.ts` 及原auth辅助模块，调用真实 `createAutomationReadClient().submit()`，不是复写request函数。仅在独立自有空白合成页种入明确的假会话，fixture后端不宣称做JWT授权；不把此用例当UI登录、真实授权或客户数据证据。一个返回原SDK格式的89字节真实合成queued响应被分两段传输，真实SDK完成DTO校验并返回queued；路由四格仍同时原生CDP/PW ABORTED、hostBody失败，诊断启用格SDK EOF已出现且SIGNAL_ABORT计数0。观测所需首段放行仅在自有context透明观察原reader Promise，仍返回原Promise，不注入响应/DTO，不改SDK源码。八格完整执行，严格总exit1，不能报告已修复。第一次打包脚本从backend直接找esbuild失败于启动前，已改为现有tsx自身的esbuild依赖，未安装/改动仓库依赖。

本节更新此前“POST202未复现”结论。本轮针对冻结head fcb20 的原fetch选项、原诊断包装与同版本Vite preview代理，以及真实Playwright route.continue逐维对齐；独立合成fixture不需要数据库、登录或业务数据。使用完整Chromium可执行文件（不是默认headless shell），1440×1000、zh-CN、serviceWorkers=block，真实POST JSON请求，202/no-store/Content-Length，89字节响应分6+83两段；第二段由页面读到首段后通过受控binding放行，没有响应替换、tee/clone、额外HTTP请求或扩大响应上限。

关键8格对照（代理×路由×诊断包装）：直连且无路由两格完整通过；开启路由四格均页面EOF/JSON有效、signalAborted=false，但Playwright与独立原生CDP都报告ABORTED/canceled=true，host body不可读，严格失败。原SDK诊断包装不是必要条件。仅代理、无路由的两格有时序敏感，不能声称代理始终足以复现或包装完全不影响时序。清空继承环境，仅保留PATH/HOME后重新执行同一8格，路由四格结论一致。该轻量fixture复现关键签名，不等于完全镜像CI的调度/CPU/内核/原构建与业务调用链，尚不能断言它是CI唯一根因。

新浏览器156、额外CDP session恢复cache默认值、等待reader.closed、有界TransformStream+native arrayBuffer四个候选臂均保持红灯，未进入产品。cache实验不能证明Playwright自有session的cache-disabled已被覆盖；无效对照不当作因果结论。未取消no-store/路由防火墙，未改大小/超时/失败断言，未采用无界JSON、clone/tee、响应重放或忽略ABORTED。

同一代理+路由+诊断条件补齐真实超限/截断/主动abort三个负例，全部拒绝：超限观察1,048,590字节时仅保留947,206字节（小于1MiB）；截断89字节未EOF，等待15秒SDK同规格超时后拒绝，代理未complete；主动abort仅保留6字节。对应正常202正例依旧严格失败，负例绿不冒充修复。初次负例fixture缺少15秒request timer导致截断经代理时挂起；核对唯一自有PID/完整命令后仅SIGINT停止该诊断进程，Playwright关闭浏览器，随后补齐原SDK同规格timer完成矩阵。生产timer不变，保留该诊断失败。

含真实SDK的8组固定结果/60个诊断case哈希摘要见同目录 `post-202-ci-reproduction-20261015.json`；这不是60项通过，记录包含已知失败和失败候选，也不是全部历史执行次数统计。脚本副本在diagnostics，仅属临时诊断材料，不新增产品切片或CI泳道。此前两文件停止归因补丁字节未变，本轮无新增产品修复；189/189、原manual/interval、宜搭71/71为前轮已取得的本地证据，不冒称本轮重跑或远端正式通过。主检出tracked零改动，不推送、不重跑CI、不合并、不部署、不读客户数据、不真实发送。官方当日预发布浏览器仅临时隔离验证中，不改仓库依赖，不预写结果。

## 2026-10-15 本次本地收口终态（未推送，ABORTED仍未修复）

- 两文件最小补丁仅修正停止证明的前序失败归因：实际stop仍独立执行；浏览器失败后proof仍拒绝，不把未创建的协作子进程当作原始故障。运行时生产SDK、权限、响应大小上限、no-store、取消/超时策略均不变。补丁LF副本与准确SHA见同目录 `local-stop-guard-receipt-20261015.json`，反向重建与远端fcb20基线一致。
- 完整合同189/189、provenance1/1、定向tsc与git diff --check均通过，合同无过滤、重试或跳过；新增真实finally代码路径测试覆盖前序失败、真实stop拒绝、前序成功但缺失协作探针，移除守卫变异致红。
- 原public CLI manual及interval各执行一轮，均exit0，namespace worker正常退出。manual回执SHA `0ecfd96d58a8a3c348901a8be18898b473e64fe08697dbc87bb89407f27c61de`；interval回执 `artifacts/stock-preparation-plm-full-app/01d6a71d-b7a1-4d6c-b74a-7bce44067339.json`，SHA `905f4d87b4c9e9403da723fac1b571ea9f92e7ef708824003bcb97447c2c420c`。每轮独立审计9阶段18份raw流、2个嵌套浏览器进程、6,587源码输入及全部原业务验收器均通过；actual-stop/production-stop-verified/owned-PG-removed均true，原始业务快照不变、responseStubs/storageInjections=0、customerIO/externalSend=false。manual204、interval132条传输帧；不把两次本地通过冒称历史CI根因已修。
- 宜搭五整文件公开隔离CLI71/71（66业务+5哨兵）通过，固定回执SHA `55e3df158a6893b1a241d1b96a26aa0a467b022d8ca4578d269ff7929bdae692`，实际临时PG已停止删除；仅本地证据，不是远端正式步骤。
- 独立Chromium对照仍红：最终12例矩阵（SHA `47d01c7bb762182b21e68295481b2e864c53d60ff86a28aab86d07c1a30d8dba`）旧143与临时156的GET200有界流均失败，POST202（实际JSON请求体）均完整成功，六个负例仍拒绝。因此GET兼容问题已复现，但本轮CI POST202精确触发条件尚未复现，不存在已验证的ABORTED修复，不能借上游修复说明或浏览器升级蒙混过门。
- 当前远端保持fcb20原失败、宜搭skipped；原监视任务保持暂停。没有启动不满足前提的Chrome试用，没有改依赖/锁文件/工作流或系统校时；主检出tracked零改动。未新增切片、推送、重跑CI、合并、部署、客户数据读取或真实宜搭发送。所有本轮实际应用/DB/浏览器进程已通过原CLI终态退出；临时诊断材料保留供复核。

## 2026-10-15 CI失败后的本地核验与证据更正

进一步限定ABORTED归因：初始矩阵的200/202均为GET，只说明状态码不同的GET均可复现，不能当作CI POST202的同构复现。后续分别把202控制改为真实POST、再增加application/json合成请求体并正常drain服务端请求，各执行完整12例：两版本GET200仍出现完整读完但terminal FAILED；POST202（无body及带JSON body）均FINISHED且hostBody可读；native JSON参考及六个负控制结论不变。矩阵仍exit1，未凑绿。故已证明存在独立GET流式兼容问题，但本轮CI POST202的精确触发条件仍未复现，不能将它定性为同一上游根因。当前最终脚本与闭合结果位于隔离目录browser-fix-probe，未进入产品或PR。

补丁后的原 public CLI manual 全链已 exit0：回执 `artifacts/stock-preparation-plm-full-app/39a84311-7358-40d3-b33c-636b98992b7c.json`，SHA `0ecfd96d58a8a3c348901a8be18898b473e64fe08697dbc87bb89407f27c61de`。独立审计原业务验收器、9阶段18份raw流、2个嵌套浏览器进程、6,587源码输入全部通过；实际stopResolved/stopVerified、PG目录移除均true，sourceAndTargetUnchanged=true、responseStubs/storageInjections=0、customerIO/externalSend=false。204条传输帧；options完整200，SDK EOF457ms、Playwright完整458ms。本地原interval链在运行，未预写通过。一次完整manual通过不抵消独立分段矩阵和远端原失败，不能据此宣布ABORTED根因已修。

宜搭原五文件隔离CLI本轮终态 exit0，`passed=true, tests=71, business=66, sentinels=5`。自有回执 `tmp/yida-browser-ci-8d5c4d43-7c6b-497b-8cdc-1941d023be99/receipt.json`，SHA `55e3df158a6893b1a241d1b96a26aa0a467b022d8ca4578d269ff7929bdae692`；0600单链接常规文件的闭合字段复核：cleanup=`stopped-owned-pg-removed`、isolatedNetwork=true、pgDirectoriesAbsent=true。原reportOuterResult在清理、源码后验、准确任务计数与子进程终态全满足才报告通过。仅本地合成证据，不是远端正式71项，不覆盖远端skipped，不解除Chromium门。

固定完整回执已完成：STOP_CONTRACTS exit0、189 tests/pass、fail/cancelled/skipped/todo均0，stdout SHA `3fa670f4e00e6792e8c88c61360e0466621c21eb8db247e93c7c8c6fa662c866`；PROVENANCE exit0、1/1、零失败/跳过，stdout SHA `3fcbb10b430ea00cf8bb737b5518889f1af62bdcba90748ab501b805c8dc37d2`；两者stderr为空。固定回执位于隔离目录 `browser-fix-probe/local-verification-receipt.json`。主检出tracked零改动，仍仅原artifacts/reviews未跟踪。未推送或触发CI。

更正下方11:45节：当时工具把已是闭合公开投影的帧再次送入只接受原始diagnostic的分类器，导致phase/reason退化为OTHER。只读重核原公开帧的白名单字段，准确结果为 `isolated-browser-failed: AUTOMATION_MANUAL/REQUEST_FAILED`、`production-stop-failed: COLLAB_CHILD_REQUIRED`。原先报告的实际host.stop已resolve、options完整及POST202取消观察不变，不再用OTHER推断根因。没有读取私有CI产物。

本地最小补丁：原 verifier 的既有业务前置成功守卫提前至停止证明块第一条，实际stop仍先执行。对远端基线反向重建哈希成功：原verifier `327ad0ad62aea6c83004d9c08b540b91eb71bab78232ed6b1aa44882b4ffce6c`、原合同 `7e24ad937fc2d1a1762516b48426e2899b72ff40f6144068109f7813c16ec852`；本地两文件及LF副本哈希记录在 `local-stop-guard-receipt-20261015.json`。定向tsc成功。新增VM测试第一次执行因跨realm Error构造器不一致导致两例失败，已修正测试上下文传入原Error，随后完整189项合同 exit0，非跳过/过滤验收；再次固定回执收集中。此修复仅改善失败归因，不把失败浏览器链变绿。

ABORTED真实合成矩阵：旧Chromium143.0.7499.4与临时独立Playwright-core1.64.1/Chromium156.0.8078.4，各执行HTTP200/202有界流正例、native JSON诊断参考、超限/截断/主动取消负例，共12例。两版本的4个有界流正例均页面读完11字节并解析成功，但hostBody=false、terminal=FAILED；两个native JSON参考完整成功；六个负控制全部拒绝，超限只保留6字节。矩阵总进程exit1，保留失败，不声称新浏览器修复。无代理、无应用、无DB、无账号、无.env、无客户IO或真实发送，所有server/context/browser均finally关闭。材料与结果位于隔离目录 `browser-fix-probe/`，没有改变源代码依赖或锁文件；第一次10例矩阵也失败，后续12例增加native参考而非凑绿重跑。

宜搭原五文件公开隔离CLI正在本地运行。第一次调用误用了`--pg-bin=...`，参数检查拒绝、未启动DB/业务；根据原parseArguments改为既有`--pg-bin PATH`后启动。结果另记，不能预写71/71。保持远端CI失败/宜搭skipped及Chromium门；本轮未推送、未重跑CI、未合并/部署/真实发送。

## 2026-10-15 11:45 心跳终态：PLM失败，宜搭未执行

run `38673376578` attempt 1、准确 head `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4` 已 completed/failure。前置锁协议 success；PLM manual/interval步骤 failure；owner YiDa proof与后置两项合同 skipped，不是71项通过。

仅在内存读取公开job日志，用本轮原 publicBrowserFailure 闭合投影提取77条有限帧，未读取私有产物或凭据。automationOptions：上游200、PROXY complete=true，SDK BODY_DONE（201ms）、Playwright BODY_DONE（204ms），本请求未见取消。后续 automationRequests POST：上游202、PROXY UPSTREAM_COMPLETE/DOWNSTREAM_FINISH（106ms），SDK HEADERS（113ms）、BODY_DONE（115ms，complete=true、signalAborted=false）；Playwright REQUEST_FAILED/ABORTED（116ms），随后 READER_REJECT/OTHER（119ms）。这些为各层相对时钟记录，不足以推断精确跨层因果，也不能据ABORTED标签断言SDK请求真的未完成或根因已定。

终态有限帧：isolated-browser-failed phase=OTHER/reason=OTHER；isolated-browser-exit code=1、hasResult=false；actual-stop-resolved 已出现，其后 production-stop-failed reason=OTHER。故本轮 host.stop 已resolve，但停止证明仍失败，不能写成实际stop调用超时，也不能宣布整体清理成功。尚需后续授权范围内定位停止证明OTHER与浏览器监测失败的具体原因；本次只读跟踪不改代码或重跑。保留旧run租约到期、宜搭失败和WSL回拨历史。依照终态规则报告并停用本次跟踪，不启动有条件授权但尚未过门的Chrome试用，不合并、不部署、不真实发送。

## 2026-10-15 11:38 新加坡时间：前置锁协议已通过，PLM实际验收开始

run `38673376578` attempt 1、head `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`：第99步 external-system delete × pointer-write lock protocol real-DB proof 已 completed/success，并非超时失败。第100步 PLM manual/interval 为 in_progress；第101步 owner YiDa 与后置合同仍 pending。只读核对冻结head的workflow，PLM两场景步骤合计 timeout-minutes=20，job总预算150分钟；预算不是完成时间承诺。尚无本轮目标终态，不预判ABORTED、实际停止/清理或正式71项结果；继续原跟踪任务与通过后的Chrome合成试用安排。

## 2026-10-15 11:36 新加坡时间：当前前置数据库锁协议步骤仍在运行

只读 API 核验 run `38673376578` attempt 1 仍 in_progress，PR OPEN/draft，run 与 PR head 均为 `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`。test (20.x) 已完成98个步骤，当前第99步 external-system delete × pointer-write lock protocol real-DB proof 自03:20:34Z运行，采样时约16分钟；这只是耗时观察，未据此判定死锁或失败。第100步PLM manual/interval、第101步owner YiDa proof及后置步骤仍pending。尚无本轮目标ABORTED/actual-stop或宜搭71项终态证据，禁止将未执行视为通过。保持既有条件式跟踪与Chrome试用安排，不重跑、不推送、不启动提前到期的试用环境。

## 2026-10-15 本轮只读跟踪与条件式 Chrome 试用安排

再次核验 run `38673376578` attempt 1，head 精确匹配 `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`。test (20.x) 仍 in_progress；checkpoint、Chromium 安装、PLM isolation/CI contracts 均 success；PLM manual/interval、owner YiDa JWT HTTP/browser proof、后置 source-revision contracts 仍 pending。目标阶段尚未执行，不能据此前置通过报告无 ABORTED、实际停止通过或正式宜搭71项通过。

用户本轮授权通过后安排 Chrome 本地合成初始化与推送预览。已更新原 `6337-ci` 跟踪任务：仅当正确同 head 正式目标步骤、71项及实际停止/清理证据齐备，且 PR head 未变化，才检查 Chrome 连接并安排一次新建临时合成环境；Chrome 未连接先请求连接，不提前启动即将过期的环境，不擅换浏览器。沿用既有受审 CLI、假材料、自有临时 PG、发送强制 OFF、TTL不超过900秒，结束验证停止和清理，不重复启动。保留全部历史失败与回拨风险；失败不自动重跑。不新增切片、不推送、不合并、不部署、不访问客户数据、不真实发送。本段仅本地续记。

## 2026-10-15 11:17 CI 只读状态核验（新加坡时间）

run `38673376578` attempt 1、PR head 均精确为 `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`，PR OPEN/draft。test (20.x) in_progress，当前 isolated manual checkpoint acceptance，自03:12:57Z开始；PLM manual/interval、owner YiDa JWT HTTP/browser proof及后置PLM contracts仍 pending。尚未进入本轮取消/停止捕获阶段，不能报没有ABORTED、已修复或正式宜搭通过。

当前剩余发布证据：同head PLM两场景实际运行及独立stop/清理终态、专用宜搭五整文件71项正式步骤，另保留历史取消未归因和本机WSL校时风险。原workflow的PLM两场景步骤总预算20分钟，这是超时门，不是剩余时间承诺；当前尚有前置步骤，无法可靠给CI完成时刻。现有功能无需再开新切片即可安排临时合成初始化/预览，但稳定就绪声明仍待证据。仅只读CI及本地MD续记，未重跑、改代码、推送、合并、部署、客户读取或真实发送。

## 2026-10-15 10:53 本轮已推送并启动 CI（仅本地状态续记）

按 owner 本次授权，准确四文件已快进推入现有草稿 #6337：`36cdb73f8ac9c42719965d4ffaa3b050ee82fa35` → `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`。OPEN/draft、原 PLM base 分支保持不变，主检出未改。新 Plugin System Tests run `38673376578` attempt 1 已创建（02:53:28Z/新加坡10:53:28），head 精确匹配；当前 run 与 test (20.x) 均 queued，不算通过。原 6337-ci 已更新到新 run/head，保持只读与终态停用。此段是启动后的本地续记，不夹带第二次提交或重启 CI。历史 ABORTED、租约与WSL回拨风险及发布门保留；未合并、部署、客户读取或真实发送。

## 2026-10-15 本轮追加提交授权（CI 尚待新 head 证明）

Owner 已明确授权本轮两个诊断/合同文件及两份既有 MD 推入现有草稿 #6337，并运行既有合成 CI。准备从当前远端 head `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35` 追加，严格四文件；代码的准确 LF SHA 仍为本轮表列两项。只更新公开白名单诊断，不修改原验收通过条件或生产行为。新提交、新 run 与实际终态另记，本地 manual/interval 通过不覆盖远端原失败。禁止新增切片、自动失败重跑、合并、部署、客户读取或真实宜搭发送。

## 2026-10-15 本轮收尾裁决：诊断修复完成，历史取消未复现

原 public CLI 的 manual 与 interval 各一轮完整合成验收均已 exit0，分别独立创建/迁移/重放/构建/执行/停止/删除自有 PG，没有为凑绿重跑失败业务阶段。manual 回执 SHA `32a1d3e6d4e8ee6527271d787b55895424f3846de99717f28d12ff07919c4710`；interval 回执 `artifacts/stock-preparation-plm-full-app/4f9b311c-b523-4b1d-a769-edd15377494f.json`，SHA `1da73d8b706c68a327724af6bb3858dc877b35244357c1ca56adfbe913c70507`。此前进行中描述为历史快照。

两轮均另行调用原阶段/嵌套日志与全部业务验收器复核，每轮9阶段18份阶段流、2个嵌套浏览器进程、6,587源码输入；长度及 SHA 逐项一致，stopResolved/stopVerified/ownedPgDirectoriesAbsent 均 true。interval 共132条原传输记录，options 上游200（122ms），SDK EOF（131ms），该请求未取消。两轮 sourceAndTargetUnchanged=true，responseStubs/storageInjections=0，customerIO/externalSend=false。namespace 原终态均证明 worker 正常退出、PID1 capabilities zero、ordinary worker；Chrome 对照不借此声称也有内核隔离。

本轮准确改动仍仅两个现有诊断/合同文件（相对已发布36cdb），加两份既有 MD；没有修 SDK、请求取消、事务、授权、host.stop 或时钟行为，没有新增业务切片/端点/flag/依赖/workflow，也没有推送或重跑 CI。合同187/187、四组真实测试变异全杀、provenance1/1与 Astra ultra 只读复核无阻断已完成。13,758项最终后验仅六个前轮已发布文件＋这两个新增本地文件相对准入基线变化，交付副本原 LF 匹配，无临时源码插桩遗留；主检出仍只有原 artifacts/reviews 未跟踪目录。

为确认能否利用已有失败而避免反复本地跑绿，只读列出旧 run 38541640996 的 artifact 元数据：仅有无关的 dingtalk-p4-ops-regression-gate 一项，没有 PLM 阶段产物。未下载该无关产物、未读取远端私有日志/凭据，也未触发 CI。不能从不存在的 PLM 产物补造历史取消来源。

**不报“历史取消根因已修”或“稳定发布就绪”。** 本次观察未复现远端 ABORTED，增加诊断输出也可能改变时序；不能用本地两轮成功覆盖旧 CI 失败、source-pin短租约和 WSL 回拨风险。此后若再出现失败，可准确区分 SDK/代理/浏览器阶段及实际 stop 与前置验证失败。本轮不继续无目标重复运行，远端 Chromium/宜搭正式步骤的发布门保留。两份 MD 与两文件补丁只在本地交付副本，当前没有推送/CI/合并/部署/真实读取或发送权限。

## 2026-10-15 manual 原完整合成验收通过（interval 仍待终态）

本轮未经推送的两文件观测候选，原 public CLI / Linux non-root / user-net-PID namespace / 能力清零 / 临时真实 PG / 固定 Chromium，以原 manual 场景完整执行，exit0。result=passed，cleanup=stopped-and-owned-database-removed，namespace 终态 passed/workerReceiptObserved/normalChildExit/pidInitCapabilitiesZero/ordinaryWorker 均 true。没有暂停校时或放宽任何预算。

原回执 `artifacts/stock-preparation-plm-full-app/f243a6e3-7afb-4930-8843-1ff287d7f06b.json`，SHA `32a1d3e6d4e8ee6527271d787b55895424f3846de99717f28d12ff07919c4710`。另运行原 verifyStageLogs、production-stop/K3/静态宜搭/OFF/初始化/Automation/浏览器进程验收器及原 OFF raw-log 核验；9阶段18份流、2个嵌套浏览器进程均验证；6,587源码输入长度/哈希逐项一致。sourceAndTargetUnchanged=true、responseStubs=0、storageInjections=0、ownedPgDirectoriesAbsent=true、customerIO/externalSend=false。不以宽泛 test 数量替代这套业务验收器。

实际 options 顺序：SDK request → PROXY upstream 200（210ms，end/complete）→ downstream finish（211ms）→ SDK headers（220ms）→ SDK BODY_DONE（221ms）。该请求没有 signalAborted 或失败；整链216条三层传输观测，actual-stop-resolved 与 production-stop-verified 同时存在。**本轮未复现 CI 的取消；观测修复不等于历史取消根因已修**。原 CI 失败和 Chromium 发布阻断继续保留；后续不盲目改 SDK 或增加重试。

完整 provenance 整文件 1/1 PASS，无 pin 改动。13,758项后验仅六个已发布文件与本次两个本地观测文件有差异，LF交付副本匹配；原主检出仍仅既有 artifacts/reviews 未跟踪目录。当前 interval 原完整场景运行中，不计通过。

Chrome 收尾时扩展连接断开，工具库存已不含 Chrome/Edge，因此没能确认临时标签页关闭或发送 Network.disable；不绕过浏览器机制、不改系统权限。合成私有内存字段 password/material 已删除，本次服务已 STOPPED、PG/handoff 已移除，不把浏览器断开当业务故障。截图留作默认关闭对照，不作为启用 Automation 场景验收。

## 2026-10-15 本地 Chrome 对照及诊断补丁（进行中）

- 已获 owner 授权仅本地复现/最小修复/合成验证与必要 Astra ultra 只读复核；无推送、CI 重跑、合并、部署、客户读取或真实发送。
- Chrome 扩展已连接，独立标签页通过真实合成账户登录原生产 bundle，进入 SYN-YIDA-PREVIEW 项目及 Automation 面板。第一次观察器在整页导航后未保留事件，记录为空不作网络证明；重新启用后明确执行第二次单次 UI 读取，CDP 实际记录 request → response 503 → loadingFinished，没有 loadingFailed/ABORTED。未读响应正文/凭据；本入口默认读取 OFF，因此是对照，不冒称 CI 场景复现或同因。
- 截图 `E:/Projects/metasheet/tmp/pr6337-chrome-options-default-off-20261015.png`。不注入 token、不调用页面私有状态或 fetch，不向客户系统发送。
- 本次 exec 会话 stdin 已关闭，写 stop 未成功；没有重启同一应用。核对本次 owner 与公共 CLI 完整命令后精确 SIGTERM，浏览器连接仍在：terminal code0、signal=null、passed=true、STOPPED、sourceUnchanged/handoffRemoved/ownedPgDirectoriesAbsent=true。wrapper head 字段仍标历史 0a，但运行代码是已核六文件候选（与发布 36cdb 代码一致）；不将旧字段冒称正式新 head CI。私有输出 371/0 字节，SHA `a5d6ae537b1613318fa04ab8bed663b24b1f1727244fb9534498fd21b699c359` / 空流 SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

### 两文件观测修复与实际路径测试

`run-stock-preparation-plm-full-app.mjs` 的原 transport 帧在公开投影被丢弃。新增仅固定 enum、有限整数/严格 boolean 的二次投影，丢弃 url/header/body/token/原异常；新增 actual-stop 固定帧与精确 COLLAB_CHILD_REQUIRED reason。原 timeout、输出上限、退出码、真实 stop 和 validateProductionStopEvidence 全部不变。

| 文件 | 当前 LF SHA-256 |
| --- | --- |
| `scripts/ops/run-stock-preparation-plm-full-app.mjs` | `51246a22d33c9bc2f90f8a3217362560f0fea00c089ffcf42bd33baa2b878adc` |
| `scripts/ops/stock-preparation-plm-full-app-contract.test.mjs` | `7e24ad937fc2d1a1762516b48426e2899b72ff40f6144068109f7813c16ec852` |

原完整合同 **187/187**、fail/skip/cancel=0、exit0。新增实际链为 createFullAppStageRunner → spawn node → stdout → 投影 → emit，子进程原 exit1 保留，非 Chromium 业务验收。定向变异基线 2 passed/185 skipped；移除 transport 投影与改为原 record 展开各 0 passed/2 failed；移除 stop 投影或 collab 原因各 1 passed/1 failed，四组均被真实测试杀死。此定向 skip 不计为完整验收。首次变异工具错误地假定 drop-transport 只会杀一条，实际两条都红，修正工具计数断言后四组完成；未改测试或候选来迎合工具。来源字节保持不变，回执目录 `metasheet-6337-projection-mutations-bDAlgr`。

实际 Astra ultra 子代理只读复核了两文件 diff 与真实调用点：无阻断项；确认没有扩大通过条件或输出私有值。其测试计数引用父任务运行，并非代理又跑一遍。合同使用 READER_REJECT 枚举，实际 SDK reader 拒绝为 SDK_REJECT+READ，两者均有限接受，但合同不冒充真实 SDK 故障证据。

### 原 full-app 入口

首轮原 namespace/public CLI 在 stage 启动前失败；查明 runAcceptance 的 git rev-parse HEAD 需要 Git 元数据，隔离副本没有 .git。仅为准入的 13,758 文件创建无历史的本地 Git 快照 `7ccd6da23c92d45a0c4ef4ee02de7111d8310291`，没有导入其它文件或历史，也没有改网络隔离。当前再次运行原公开 manual 入口，已完成类型、两端构建、迁移与重放并进入 configured-app；尚未取得终态，不能报通过。保持原失败和远端阻断。

## 公开日志投影层复核：保留已知与未知

亲读 `scripts/ops/run-stock-preparation-plm-full-app.mjs:185–251`：生产诊断前缀在公开出口映射为有限 reason 枚举，所以先前扫描 APP_* 前缀没有命中，不代表原诊断为空。按模块定义的准确白名单重新提取同一公开日志，实际为 isolated-browser-failed / REQUEST_FAILED、configured-app-failed / BROWSER_PROCESS_FAILED、production-stop-failed / OTHER。原错误前缀、正文与私有日志仍未读取或输出。

公开记录只有 26 个 browser-phase、一次 browser-request-failure 和上述失败/退出帧，没有浏览器 SDK 传输阶段。不能从当前公开证据判断请求是在 headers 前、响应流读取中、15 秒超时或会话释放时取消。stop reason=OTHER，不能把代码中 EARLIER_PROBE_FAILED 的可能性认成这次实际原因；也不能认定实际 host/socket 关闭超时。无修改/重跑，保持失败及发布门。

## 新 head 失败的只读调用链核查（不改代码）

核对已发布 `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35` 的 `verify-stock-preparation-plm-full-app.mts` 与本地准入副本原字节一致，SHA `327ad0ad62aea6c83004d9c08b540b91eb71bab78232ed6b1aa44882b4ffce6c`。真实 manual 浏览器链先等待 automationOptions 响应，再点击 automation-read-load（`stock-preparation-automation-full-app-browser.ts:53`）；尚未取得 options 时不能推定已经创建 grant 或发送执行请求。

生产 `automationRead.ts:496` 起维护实际 AbortController：session/dispose 会 abort；request 的 15 秒 timer 会 abort；响应流类型/长度/解码/结构失败也会 abort。因此 ABORTED 不是单一根因码；仅凭该网络标签不能断言 Chromium 缺陷、后台超时、会话撤销或响应解析中的哪一种，更不能删 guard、增加重试或放宽大小预算来修。

停止证据另需区分：宿主 stop 有独立 try/actual-stop-resolved 或 failed，而后置 proof 在 `verify-stock-preparation-plm-full-app.mts:817` 先断言原业务 probe 的 process.exitCode 必须为零；已有业务失败也能触发 production-stop-failed 标签。故现有日志的这一标签不独自证明 socket drain 再次超时。该轮未捕获能区分上述两种失败的完整固定诊断，保留为未证实；父级临时库已清除仍不替代宿主成功的证据。

后续最小本地复现应首先捕获取消来源、请求/响应阶段与独立 stop 状态，而不是直接修改生产超时或取消语义。本次只读核查不包含启动合成应用、子代理、代码修改、CI 重跑或真实系统操作。

## 2026-10-14 18:21 新 head CI 失败终态（新加坡时间）

只读确认 run `38541640996` attempt 1，head `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35`，run 与 test (20.x) 均 completed/failure。checkpoint、Chromium 安装、PLM 前置合同成功；`Run synthetic PLM full-app manual and interval acceptance` 失败，后续 `Run owner YiDa JWT HTTP and browser real-DB proof` skipped，不能判宜搭 71 项正式 CI 已通过，也不能解除 Chromium 发布门。

失败公开日志仅内存解析固定标签与字段，未输出原文：10,837 字节，SHA-256 `6ec61623710a95717d63ce7af42623f2276d2903c31d108f9823185612454c28`。类型、两端构建、迁移阶段均 code=0；configured-app code=1，固定失败标签 `PLM_FULL_APP_STAGE_FAILED_CONFIGURED_APP`。浏览器走到 `AUTOMATION_MANUAL` 阶段，记录 API surface / automationOptions / ABORTED，随后 isolated-browser-failed 与 configured-app-failed。没有日志标签足以证明具体根因，也不能倒推为 503、时钟回拨或上一轮宜搭失败同因。

同次另记录 production-stop-failed，保留而不粉饰为宿主干净退出；父级最终 result=failed、cleanup=stopped-and-owned-database-removed，证明最终临时库已清除，不替代宿主停止成功证明。前面的宜搭静态预演与 default-off 阶段标签只证明抵达阶段，不冒称独立初始化/浏览器 proof 通过。

本次仅只读诊断与 MD 续记，未下载私有产物、读取凭据、重跑、改代码、推送、合并、部署或真实发送。原 `6337-ci` 跟踪已按终态更新为 PAUSED；后续代码复现/修复与再次 CI 需新的明确范围授权。旧失败、租约风险与本机回拨风险继续保留。

## 2026-10-14 18:01 新 head 前置合同进展（新加坡时间）

run `38541640996` attempt 1、head `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35`：test (20.x) 仍 in_progress。checkpoint、Chromium 安装、PLM full-app acceptance isolation and CI contracts 均 completed/success。synthetic PLM manual/interval 与 owner YiDa JWT HTTP/browser proof 仍 pending；安装与合同成功不等于实际业务或浏览器验收成功。历史失败与发布门继续保留；仅只读观察及本地 MD 续记。

## 2026-10-14 17:51 新 head checkpoint 进展（新加坡时间）

只读再核 run `38541640996` attempt 1，head `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35`：test (20.x) 仍 in_progress；isolated manual checkpoint acceptance 已 completed/success。Chromium 安装、PLM full-app 合同与 manual/interval、owner YiDa JWT HTTP/browser proof 仍 pending，不计通过。旧 head attempt 1 的 250ms source-pin lease 到期失败继续保留，新 head 此步骤成功不证明时序风险已解决。未重跑或修改任何代码，发布门仍保留。

## 2026-10-14 17:31 新 head CI 只读观察（新加坡时间）

实际 head `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35`。同 head Integration Guard run `38541513035` 已 completed/success。Plugin System Tests run `38541640996` attempt 1 仍 in_progress，test (20.x) 仍 in_progress；checkpoint、Chromium 安装、PLM 合同/manual+interval、owner YiDa JWT HTTP/browser proof 均 pending，尚无业务通过证据。不因 Integration Guard 成功解除 Chromium/宜搭发布门，保留旧租约到期、宜搭失败及本机回拨风险。只读观察，未重跑、改代码、推送、合并、部署或真实发送。

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
