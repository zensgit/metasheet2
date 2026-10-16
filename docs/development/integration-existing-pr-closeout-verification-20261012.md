# 既有 #6337 收口验证

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
