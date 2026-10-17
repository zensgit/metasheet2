# 既有 #6337 收口设计

## 2026-10-18 已获准按顺序提交独立决策与原草稿

owner明确批准先提交/推送独立GOV-08并开文档PR，再将已验证补丁及MD推入原草稿#6337，运行既有合成CI。独立决策现为[#6438](https://github.com/zensgit/metasheet2/pull/6438)，文档commit d0daac73d、基底main d671019f2；只含一份决策，不夹带代码或这些closeout记录。下方“禁止提交/推送/CI”及“待授权”文字保留为此前阶段，不再代表本轮授权状态。

#6337仍以PLM分支为base，不擅自改为main。当前只追加已冻结的runtime/三个既有测试/一个pin及两份closeout MD，不增加功能切片。独立决策文档不复制进代码提交；代码PR通过链接引用#6438。已有本地证据仅证明准确候选；新推送head的CI、正式71项及清理需另核，不移用旧head绿灯。仍不合并、部署、客户读取或真实发送。

## 2026-10-17 当前裁决已获准并本地实施：16口可信租户

本节替代下方历史记录中的“未获批准/待裁”当前状态，不删除原调查证据。owner已明确批准16个既有自助接口的完整范围，先形成独立 [GOV-08决策PR#6438](https://github.com/zensgit/metasheet2/pull/6438)，再实施。当时HEAD为dcc82a1，修改仅在本地候选；后续提交授权见顶节。

用局部requireSelfServiceReadAccess保留原read/write权限第一道门，随后只认authenticatedTenantId；缺claim拒绝，user/body/query/params/header的冲突或畸形显式租户在配置/凭据/适配器IO前拒绝。16个导出handler本身接线，不能靠绕过路由包装避开。保持全局JWT/W4默认、Connection owner、workspace及原参数allowlist不变，不增加端点/开关/迁移。

真实JWT/宿主/自有PG整文件40/40，K3八整文件130/130，直接handler矩阵通过；23种有限变异被杀，删除门另使真实JWT矩阵16条全红。provenance与类型检查通过，独立Astra ultra复核无新增阻断。实现、测试与哈希详见验证MD顶节。只关闭本次16口的已知可信tenant缺口，不宣称全平台隔离或完整自助集成目标完成。没有提交、推送、CI重跑、合并、部署、真实客户访问或宜搭发送。

## 2026-10-17 待裁范围订正：只保护单读配置不足

尚未收到A明确批准，不将自动goal续推进解释为授权。后续亲读发现此前“只保护read-source-configs七口”的建议不完整：同文件L6432 readSourceCompositionsRun同样经scopedInput加载已批准组合，L6470加载步骤read config，L6474用scopedAdapterInput取得系统凭据再执行；没有独立可信claim检查。只改七口会留下组合平行路径。因此撤回“仅七口即可收口”的暗示，不实施该残缺方案。

待裁推荐范围更新为现有自助读取接口集合共16口：7个read-source-configs（save/list/get/audit/approve/retire/read）、7个read-source-compositions（save/list/get/audit/approve/retire/run）、2个external-system探测（read-smoke/read-source-probe）。这是待批准的单一授权合同，不是16个新动作；所有现有read/write权限分层及参数合同保持，可信claim门位于任何配置/凭据读取及adapter网络前。范围覆盖这些通用接口的已有支持类型，不谎称可以在无可信scope读取配置后才判断是否K3。目录中其它旧integration入口不在此授权合同，不宣称全平台隔离由此完成。

建议仍是独立GOV-08先决策：缺可信claim或scope冲突则拒绝，不接受header自证；不翻全局flag默认、不改变全局JWT中间件、不增加tenant选择端点、无workspace共享扩展。若合法claimless多组织会话必须保留，应在该独立决策选择宿主membership验证，而非用兼容回退留洞。批准后才可准备实现及真实JWT/零依赖IO负例和守卫变异。本轮没有生产/测试代码变更、额外授权或外部动作。

## 2026-10-17 下一授权边界前置（待裁，不实施）

SA-01/02本地纵切片证据已补齐，K3八整文件130/130与宜搭十整文件307/307安全合成通过。但当前K3自助读取仍继承flag OFF下claimless token可使用header填入tenant的静态可达路径，Astra ultra独立反驳未能否定；细节与冻结行号见验证MD顶节。这不是#6337新回归，也不能因合成绿灯宣称完整可信tenant目标完成。

建议先独立裁决A：自助read-source-configs接口族强制现有可信claim resolver，拒绝claimless/header自证，不翻全局flag默认、不改变其他历史入口；随后才在获准范围本地实现及真实JWT合成负例/变异。合法claimless多组织兼容若必需，则另选宿主membership证明方案。按GOV-08先决定授权兼容合同，当前未新增ADR/切片/端点/生产修改或外部动作。

## 2026-10-17 SA-02复用本地证据补齐（非新增产品切片）

复用已有host-realdb整文件及真实Vue/HTTP/宿主/配置版本路径，只在tmp验收包提供自有PG、原Node守卫、新loopback-only net/PID namespace与0caps环境，不更改产品/原测试/固定浏览器CLI。462迁移成功，23原测试+1隔离哨兵24/24，第二owner/第二物理布局导入再验证、样本确认、批准、激活、预览成功，源/目标不变；PG移除、自然exit0。6735相关跟踪非.env文件与当前dcc82a1发布检出全部逐SHA一致，Astra ultra只读审验收包无新增阻断。精确回执、浏览器默认路径与正式CI的区别见验证MD顶节。本地缺口已闭合，不再以此为由追加功能；完整目标和真实客户/发送/发布授权门仍保留。

## 2026-10-17 本轮收口状态：正式CI与Chrome合成试用完成

本轮family-4仅更新旧版本断言及注释，保留独立consumer与完整性检查；本地两轮整文件11/11、两类降级各五条致红之后，owner授权三文件推入原草稿并运行原CI。head dcc82a1de/run39025079404已正式success，晚期版本断言、后置SQL、固定浏览器、PLM/宜搭71项及实际停止清理闭合；并非以另一路绿灯代替正式目标。

Chrome连接恢复后，原公开CLI新建隔离合成库/随机账号，普通密码UI登录→合成项目→v2七身份两行静态预演→手动GET空槽→假材料单次本地初始化→手动GET回读2行草稿。页面canApply=false与canSend/tokenIssued/externalWriteAttempted三false分别保留。Chrome仍连接时原stdin stop正常exit0/STOPPED，自有PG和交接文件移除；无源码新改、无真实读写或发送。普通Chrome不冒充kernel网络隔离，public CLI的acceptancePassed=false亦不改写。具体截图/哈希和工具恢复边界见验证MD顶节；未因此合并、部署、推送或宣告完整原目标完成。

## 2026-10-17 晚期 family-4 版本断言最小修复（本地授权）

本轮owner授权仅现有#6337内最小修复、保留消费者/完整性检查、本地合成与变异验证及MD；不新增切片、不推送、不重跑CI、不合并/部署/客户读取/真实发送。冻结head为0a8634fd35bb0e651db490eb65f418429def0bc2；旧run39015466444晚期五条失败均精确为4对3版本断言，而其宜搭71项、后置SQL及实际停止清理已通过。

生产CURRENT_ROUTING_MANIFEST已显式指向v4；v4复用v3全部旧路由，只增私有受控读取事件。enqueueOutboxEvent仍从实际manifest.version写入outbox，不应为了旧测试把生产版本改回3。最小补丁只将family-4整文件共用expectDurableRow的显式字面量3改为4，并更新两行注释；不从生产常量动态计算期望，避免生产与测试一起漂移时自证。独立固定两consumer列表、pending状态、payload逐字段、稳定eventId、automationDepth、单条outbox、OFF旧总线与零outbox、冲突回滚零写/零emit检查全部保留。

验证复用隔离Linux受验源，修改前目标测试、routing manifest和enqueue模块均与发布检出原字节SHA一致。新建owner-bound PG14、完整迁移、清空继承环境、原native网络/.env守卫、真实发送强制false；原整文件不做名称过滤。先通过仅内存测试变换回3复现五条旧失败，再跑候选；分别仅内存变换生产enqueue的版本参数为3、删除webhook消费者，要求每个变异均在五个真实ON生产入口致红。末轮无变异再跑整文件，结束验证源SHA未改及owned PG移除。变异不改生产磁盘文件、不替换数据库返回值、不弱化原测试；本地结果不替代新head正式CI或自动解锁Chrome条件试用。

## 2026-10-17 后置失败收口：先纠正清单，再验证统计假设

Owner已授权现有#6337内本地复现、最小修复和合成验证；禁止新增切片、推送、CI重跑、合并、部署、真实读写。正式run39002841136/ad9056的大小写严格失败头及汇总证明仅一个真实失败，原“两项额外失败”来自将fail-closed负例标题误匹配为FAIL，已撤回，禁止据此修改AI或button业务实现。

唯一正式阻断为原子绑定聚合查询，归一化SQL哈希b60d8c...15ed与源码相同、57014由statement_timeout触发。保持8000ms、5000行原子同xid/精确绑定、256/4744预算断言、真实5001-plan worker与所有完整性守卫。先在owned PG14（与CI大版本一致）验证“先前测试清理留下已分配空表页/陈旧统计”的计划退化假设；执行计划只输出节点枚举、估计行数/成本和哈希，不输出SQL参数、原始计划条件或业务值。初次在全新无页表上ANALYZE空表后目标仍约32ms通过，不能当作成功复现；下一实验先跑真实整文件再清理，然后在同一owned库运行目标，严禁把人工统计实验冒称CI当时执行计划。

本地实证已成立：先真实整文件运行并清理、再在同一owned库ANALYZE空表且关闭该合成库表autovacuum，随后原目标计划将实际5000行估为1行并选Nested Loop；同原SQL哈希在8000.88ms取消。外置诊断器保持同数据/SQL/8000ms，刷新统计后原查询21.20ms通过、total=5000/same_xid=true/exact_binding=true，随后仍抛出原错误保留负例红灯。CI未保存当时EXPLAIN，故这是已重现且可修复的同类机制，不冒称已证明CI唯一执行计划。

最终补丁只在原子聚合前对其七张夹具表执行一条固定ANALYZE（含注释共8新增行）；原SQL、参数、超时和所有断言逐字保留，无生产模块/迁移/workflow改动。新PG下整文件12/12；随后相同残留统计实验目标2/2（业务+隔离哨兵，10项明确过滤），原SQL22.19ms、Hash Join估4999行、取消帧0、清理移除成功。此前未修版本同实验红灯作为去掉该统计准备的负例；不以增加SQL重试或预算求绿。额外AI/button回归不改正式测试，只在本地工具使用已受管本进程loopback监听；首轮工具就绪失败保留，修工具后原三整文件40/40（37业务+3哨兵）。新建PG均由既有owner校验stop并确认移除。正式CI仍为旧head失败，未获推送/CI重跑授权，亦未启动Chrome条件试用。

## 2026-10-16 后置 SQL 取消：保留完整性守卫，先消除诊断盲区（本地）

本轮限 owner 已授权的既有 #6337 本地复现、最小修复、合成验证及MD。CI run38904209572的后置失败不是已证明的 HISTORY_INCOMPLETE：先剥离 gh 日志的 job/step 列后，真实 payload 是 PostgreSQL statement timeout/57014；旧提取器误读长step标题，勘误及回执见验证MD。

新建owned PG的原目标与整文件均通过，尚不能证明原CI超时的具体语句、性能或锁等待根因。补齐 Pool.query 观测后，目标run最慢为5001行夹具INSERT约2209ms，未超原8000ms；不得只凭这个局部样本把CI归因为seed或提高预算求绿，不猜测批量拆分、添加重试、过滤历史或跳过断言。

当前最小本地补丁只增强原测试q入口的失败证据：捕获SQLSTATE57014时，输出固定阶段 FIXTURE_RECORDS/ATOMIC_BINDING/OTHER、单调调用计数和归一化SQL文本SHA；不输出SQL、参数、fixture身份或原错误文本，随后原样抛出同一个error。57014也覆盖显式取消，因此帧名使用SA06AQ_SQL_CANCELLED，不把所有取消都命名为超时。原事务、生产代码、8秒SQL限制、完整性判定和全部业务断言保持不变。它是诊断补丁，不冒称根因修复。

验证必须经过真实PG取消负例与原整文件正例，且直接检查Vitest ctx.state中的实际任务与任务日志；不把名称过滤的JSON passed统计或终端未显示console当作有效证明。外置负例仅在本次新PG上以pg_sleep触发原8秒statement_timeout，不伪造57014/error或结果，不构成对原CI时序的重现证明。无法获得正确失败阶段时保持CI阻断，不借原宜搭71项/PLM通过宣称整run全绿。不推送、重跑CI、合并、部署、客户读取或真实发送。

## 2026-10-16 Automation 前置失败：只修测试收尾同步（本地）

本轮 owner 明确授权在现有 #6337 内本地复现、捕获脱敏计数、最小修复、合成验证及更新 MD。不新增切片，不提交/推送、重跑 CI、合并、部署、客户读取或真实发送。

冻结远端 head 为 `bef3f94b69938c37266ec306e1e551cbde3a5bb0`。真实失败断言是 `automation-read-delivery-realdb.test.ts` 原332行，取消超时后的重新投递期望 completed=1、实际0。只读日志没有保存完整 dispatch 计数，不能证明此次 CI 的唯一实际时序。

生产路径存在可实证的测试竞争：`automation-read-delivery.ts:87` 的 trailing reconciliation 对 consumer 行取 FOR SHARE；dispatcher `automation-durable-dispatcher.ts:189` 的领取使用 FOR UPDATE SKIP LOCKED。超时结束的是外层 dispatch，不保证原 adapter 已完成 reconciliation。旧 adapter 在手工 requeue 之后持有该共享锁时，下一 tick 可以合法 claimed=0/completed=0。只有 durable source 状态成为 outcome_unknown，并不能证明旧 invocation 已释放锁。

最小改动限于这个测试文件：真实 adapter 原样接收 event/context，finally 记录其完整 handle 已 settled；测试先确认原 timeout/AbortSignal/unknown，再等待同一个 handle settle，才手工 requeue 并要求下一 tick ACK。生产 dispatcher、adapter、数据库租约、timeout=1000、原单次执行/fence/unknown断言全部不变。

为使回归不靠运气，在该用例的真实 transaction 包装器中，以两个本地 barrier 暂停第二次 reconciliation 的提交；所有实际 SQL、锁和事务仍走原路径。测试等到 tail 已进入，安排下一事件循环释放，再等待 settled 并断言 handlerSettled，最后重新投递。删除 drain wait 将在原用例内确定性失败，而不是只能靠外置探针重现。finally 同时释放 tail 与 cooperative execution，并等待 settled，避免失败时留下挂起事务。未新增端点、env flag、迁移或生产能力。

边界：这是已复现的测试同步缺陷及修复，不冒称已证明 CI 当时唯一根因、Chromium ABORTED 已修复或宜搭正式71项通过。固定浏览器正式安装已通过，但目标 PLM/宜搭步骤在失败 run 中 skipped，发布门继续保留。仅回滚本地测试补丁即可回到原行为；不回滚运行时或任何数据。

## 2026-10-16 本轮推送授权与发布范围

用户已明确授权将固定浏览器CI接线补丁及本MD推入现有草稿#6337，并运行既有合成CI。仅此推送/CI授权覆盖下方历史“未获推送授权”的状态；不允许新增切片、合并、部署、读取客户数据或真实宜搭发送。发布内容为基线fcb20上的16文件受验补丁及两份现有MD，保持草稿及原base不变。正式CI结果以新head实跑为准，既有本地三门、266合同及历史失败不被改写。

## 2026-10-16 获准的本地CI候选接线（未推送/未执行CI）

owner新授权明确限于#6337本地补齐固定浏览器候选CI接线；不含推送、workflow dispatch/重跑、合并、部署、客户读取或真实发送。旧“接线待批”仅为历史状态，不再作为本地实施阻挡；实际远端执行仍未获批。

保留原Playwright默认Chromium安装，避免影响其它消费者。在required test(20.x)的原安装之后新增固定candidate安装step；只使用官方Linux_x64 snapshot1719529的固定HTTPS地址，不接受latest、环境URL、任意路径或重定向。先SHA验证ZIP，才unzip；再验证解出的chrome SHA，才在独占新目录发布，并调用现有真实pin模块验证路径/文件/执行权限/摘要。目录已存在即拒绝，不复用缓存、不覆盖。两个PLM公开CLI及宜搭清空环境的原CLI各显式传唯一upstream-1719529 selector；仍各走原namespace/owner/source/binary/native隔离，无额外env信任、no-sandbox或默认fallback。

官方ZIP正确SHA为`691d6469ab37218a362aaffff974fd378985d1428c2a690c6dbeb73501bbe51d`（64位）。首次由历史记录转录时多写一个f，真实本地ZIP核验拒绝，已以文件实算修正并补长度断言；不将早期错误摘要沿用到CI。二进制SHA仍`43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925`。候选metadata的localOnly字段保留现有合同，指测试候选非产品浏览器/生产发布基线，不借此次接线解除发布门。

本轮相对reviewed14文件只改变workflow及两份相关命令合同，全部13份原生产/browser/native隔离文件不变；最终16文件patch与精确lineage见验证MD。没有新增业务切片、接口、凭据模型、迁移或运行时。新的workflow合同执行提取的实际Bash：合成下载与node边界下正例、ZIP/二进制分别损坏、下载失败、既有目录拒绝，并删除两处digest分别让原负例失效；两处guard不互相遮掩。宜搭原caller清空环境/argv守卫保持，新增selector删除/替换变异。另以之前已核验官方ZIP回放原Bash、真实sha/unzip/node pin，证明本机安装链而非远端下载成功。

本地266合同、原严格类型与实际provenance通过；旧整链71/manual/interval回执不改写成新workflow已跑。CI候选故障时不静默回退，失败保留；回滚本次接线可退回原workflow及selector合同，但旧默认Chromium ABORTED发布阻断仍在，回滚不表示可发布。真实网络下载、Ubuntu runner权限/依赖与新head正式三门/清理仍待获准远端CI证明。

## 2026-10-16 独立终审后的候选与正式CI止点

独立只读终审查出合同callback内断言被异常隔离吞掉的P2，现把断言移到外部并以真实包装器四种参数变异杀死，完整197合同及类型通过；复审确认闭合。仅一份合同文件改变，6587其余输入及全部生产/browser/isolation代码逐SHA不变。新14文件补丁与lineage回执见验证MD，旧三门回执仍绑定旧精确输入，不伪造新整链运行。

正式CI并未选择本地candidate：原workflow默认安装Chromium、两套公开CLI均不传selector。只读现核PR仍fcb20草稿，原run失败、宜搭skipped。故仅推本地14文件不能保证正式CI解决；未经owner明确批准，不将local-only浏览器候选悄悄转为正式CI基线、不改workflow或重跑。当前没有在跑任务，原完整目标保持active且未完成；后续CI候选接线/推送执行及第二owner新隔离入口均需先明确范围，不能用无人值守扩大权限。

## 2026-10-16 SA-01/SA-02证据范围审计

前端三整文件也已实际163业务+3逐文件native guard哨兵通过，使用现有配置、空owned env目录和原localstorage setup。Vite的hmr:false不关闭ws，前两次原guard拒绝仍保留；临时工具只设hmr/ws=false，未开放监听。退出帧不能证明worker时，改用fork显式预载+各文件哨兵/afterAll；setup路径与汇总名称空白造成的工具红灯逐项保留，最终只离线核报告，不盲重跑换绿。具体回执与界限见验证MD，不扩大为第二owner真实host证明，不改原14文件产品候选。

原目标不缩成“宜搭71通过”。当前同输入重验原11整文件291项，原network/.env守卫计数均0、6588份输入前后未变，精确回执与要求矩阵见验证MD。生产订单版本/数量/循环/截断、read-plan身份与配置合同有当前证据；真实PG全应用有当前一owner生命周期证据。当前源码也确有第二owner、第二物理布局的独立部署验收（realdb测试与复用browser helper），不能下“功能不存在”的否定结论；但本轮三项不是这套测试，不能把旧§55计数视为当前完整验收。

只复用该既有验收的隔离/固定候选前置检查，不新造向导、不扩大同租户指针owner门，不擅自执行读取继承DATABASE_URL的入口。尚未启动第二部署realdb套件、未新增产品文件或改变14文件补丁。仍不推送/重跑CI/合并/部署/客户读取/真实发送，完整目标active。

## 2026-10-16 输入身份对齐

同输入三项已实际收口：manual、interval及原宜搭71项均通过，完整停止与PG清理独立核验，汇总回执SHA `0f73a9b0bb9ee7a92b32a1a4dbb2c8a1d1cf2ca7f712477096e1da9720659a5f`。这结束本轮本地同版本证据拼接缺口，不等于产品runtime timeout根因已修或正式CI已通过，不擅自启动受CI前置约束的Chrome交互试用。未新增切片/推送/重跑CI/部署/真实发送。

14文件完整补丁已在独立临时Git目录对冻结fcb20做实际应用、逐SHA及反向检查。进一步不是依赖本地7ccd HEAD标签：比较manual记录的全部6588份sourceInputs与fcb20 Git blob元数据，6574份相同、剩余13改1新增恰好等于补丁路径/SHA；绑定回执见验证MD。只证明枚举输入等于冻结head+补丁，不宣称未枚举文件/依赖/正式CI一致。冻结源码后顺序执行的原宜搭71和interval已补齐本地同输入证据；不新增产品代码、不扩安全边界，不以重复试验洗掉历史timeout。

## 2026-10-16 本次诊断终结

一次clock-manual完整试验通过，实际stop/完整proof/PG移除及browser残留0均独立核验；POST202的SDK/PW均complete，204帧中ABORT/ABORTED0。生产执行17.546秒、140checkpoint、firstStop none；145份clock回执未检出超等待界偏差。详情与SHA见验证MD。保留首次manual timeout及正式CI失败，不能将本次有观测的成功当作runtime根因修复、同head正式CI通过或稳定性承诺。未继续盲重试，不改时间服务，不扩大授权。

## 2026-10-15 无人值守诊断续项：保守的时钟回执观测

本次续轮get_goal实读已为active，原始完整objective保持不变；下方历史“最后实读blocked”仅指前一轮快照，不代表当前停止，也不将诊断局部通过标为完整目标完成。

manual原失败已由生产firstStop明确为source-checkpoint预算超时，尚无唯一根因。沿现有测试fixture包装原host PG查询，不新增SQL、不替换原Promise/receiver/参数，不读取异常内容；仅对两条精确clock查询观察DB增量与单调增量。以相邻查询各自等待总和+250ms作为保守不确定界，超过才计数；原时间戳不出snapshot。观测覆盖host pool而非唯一worker，缺帧/零计数均不构成时钟稳定证明，不能据此修改lease、缓存live授权或延长预算。

独立只读复核确认等待界并指出一般observer抛错会遮住结果，最小补丁在回调点隔离同步异常；真实包装器throwing-observer、身份/还原合同均补齐。完整196合同及原严格类型通过。两文件独立诊断快照见验证MD，不覆盖旧首次manual/interval的sourceInputs。只进行一次带新观测的manual整链来增添事实，不将其绿灯当超时根因已修；保留原失败、正式CI失败/宜搭skipped及发布阻断。用户不在电脑前不阻碍该已授权本地合成工作，也不扩大到真实发送、部署、推送或重跑CI。

## 2026-10-15 Owner批准无人值守：PLM固定候选原隔离链补验

Owner明确允许现有#6337内本地接入固定候选，执行manual/interval、实际host.stop与清理，并要求无人值守。原禁令不变；不再把此本地范围当作待批准事项。目标工具最后一次实读仍显示旧blocked，工具没有恢复接口，本文不伪报状态；用户明确授权用于继续实际工作，完整objective不缩减。

接线保持两个owner协议分离。PLM公开CLI只新增可选精确字面量`--browser-candidate=upstream-1719529`，重复selector/scenario拒绝；默认返回形状不变。完整候选metadata纳入PLM原owner摘要，namespace scope重建固定ID/path/SHA/version并deepEqual；新增候选模块纳入原Node/Python一致的SOURCE_PATHS。PID1传递原owner绑定的选项，runAcceptance重验选项与scope一致，不通过ambient env输送。

真实browser子进程的原preload成功安装后，仅在namespace模块闭包登记scope；新getter要求该安装、重读owner/source/binary并检查原生隔离。缺失能力拒绝，不静默fallback。合法默认scope不选候选时仍用原浏览器。PLM全应用与其第二个宜搭初始化browser helper均从该getter取候选并检查实际版本，不只改第一个launch；真实SDK/route/no-store/大小/取消/业务与停止断言未改。

新增合同证明无preload拒绝、合法默认scope、完整metadata字段约束和读前重验owner；VM仅替代filesystem/native/pin，不能当作真实kernel/binary证明。首次新增正例因跨VM对象prototype不相同失败，修复只在测试替身返回VM realm对象，未放松生产deepEqual；原失败保留说明。完整合同复跑、原严格14入口类型检查和diff检查已通过；最终计数/回执由验证MD记录。

manual、interval顺序执行，避免两个原构建峰值并行。每套沿原公开CLI执行全部类型/构建/迁移/真实Workbench/Automation/两browser/host.stop/协作断连及PG停止移除；不借宜搭71项代替。运行期间冻结源码，不为绿灯重跑、不改系统时间同步、不读真实材料。执行时未预写通过，以实际退出及后置回执为准。

本轮实际结果已落定：manual首次失败、实际host.stop resolved而完整stop proof因前序失败不通过；interval首次完整通过，两套原PG实际移除，源输入相同、专用browser残留0。不得写成两套均绿。manual原POST202的SDK/PW完成、ABORTED事件0，但后续真实执行预算在source-checkpoint超时；已有生产structured firstStop确认timeout，旧栈名observer的other分类不作首因。interval只读时钟增量差有8次显著前跳观测，未证明manual唯一原因；不放宽预算、不擅改时间服务。详情/摘要及13份当前源码在验证MD顶节与`candidate-pinned-plm-20261015/`。

## 2026-10-15 已授权：显式固定候选，仅本地整链验证

Owner已明确批准在现有#6337内显式固定已校验官方浏览器候选，仅执行本地宜搭71项和停止清理，全部原安全断言保留。goal实核恢复active，完整objective未改写。此前等待采纳的文字为历史状态；本次不是授权正式CI来源迁移或Chrome交互试用，更不包含推送/CI重跑/合并/部署/客户读取/真实发送。

本地最小接线：公开测试CLI新增唯一可选字面量`--browser-candidate upstream-1719529`，未提供时沿用原默认。候选路径在专用隔离树内固定，不接受任意路径或环境覆盖；主binary SHA256固定`43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925`，实际browser.version必须为`158.0.8107.0`。新增选择模块、候选binary纳入现有owner/source哈希集合，原Python/bootstrap/preload/worker前后完整性校验继续生效。fixture从仅本次自产owner读取已绑定候选元数据，不伪装Playwright原缓存版本。

不变项：原五整文件、71项（66业务+5哨兵）、retry0、无测试筛选、原生user/net/PID namespace及capability检查、scope/owner/JWT、原fetch/response路径、原自有PG停止与移除。没有改production SDK或网络/取消/大小限制；没有安装系统浏览器或改默认浏览器。官方zip及配套资源仍是此前完整校验的隔离解压目录，非正式分发依赖。

本轮已执行完成：原五整文件71/71、入口/工作流合同64/64、原provenance整文件通过，进程均exit0；原自有PG停止并移除、专用browser存活0、owner/source/binary哈希前后相符。独立只读接线复核未发现新增明确阻断，不替代主任务的实际运行证据。详情与固定回执见验证MD顶节及`candidate-pinned-yida-20261015/`。

本次合同包含候选枚举拒绝、默认不变、环境不能选binary、外来owner路径、错误binary字节、owner字节篡改拒绝。剩余未证明项仍为候选下PLM manual/interval及其host.stop/collaboration、同head正式CI和整个Workbench/Chrome交互试用，不用本地71项替代它们。独立只读复核沿用此前已授权代理，未新增写文件代理。

本地来源守卫已追加三组定向变异自证：原模块3/3正控制通过；仅在子进程内存移除binary SHA、owner摘要、selector限制，各自对应的真实合同均致红、exit1。源码保持71项执行时字节，不把定向筛选中的跳过算作整文件验收。固定回执及方法见验证MD顶节。

### 下一关的只读接线核查：不能原样复用宜搭owner读取器

后续只读核查确认PLM full-app使用另一条独立的受管namespace能力链，而不是宜搭`YIDA_BROWSER_CI_OWNER`协议：公开CLI `parseArguments`只接收PG与manual/interval；`stock-preparation-plm-namespace.mjs`生成固定键的owner，`stock-preparation-plm-namespace-scope.cjs:42-68`重验完整键集、node与固定SOURCE_PATHS。`runAcceptance`再次清空非白名单环境；真实PLM browser helper仍在原native断言后固定调用`chromium.executablePath()`。因此简单插入宜搭`browserFromOwner(root, process.env)`会缺少它所需owner环境，可能退回旧浏览器，不能用来证明同候选验收。

若Owner另行批准本地PLM manual/interval补验，最小正确方向是：保持现有两个owner协议分离；只复用已固定的候选ID/path/SHA/version校验；将可选候选元数据显式绑定到PLM原owner、原子进程能力传递及来源清单，再由真实helper使用并校验实际版本。不增加环境后门或降低完整键集校验，不改真实业务权限/SDK。需同时验证新字段篡改拒绝、默认旧路径不变，以及原全部stop证据；不能只改launch一行后宣称来源固定。

停止验收仍区分两层：verify脚本独立尝试并等待实际`host.stop()`且检查重复调用Promise身份；仅在前序业务成功后检查collaboration child、2次断连、HTTP/SQL/adapter关闭与timer归零。manual/interval成功必须同时有actual-stop-resolved与production-stop-verified、无emergency cleanup以及外层原PG实际移除。宜搭71项中的自有PG清理不代替这一层。以上为只读确定的下一步边界，尚未实施或执行PLM验收，未自行扩大本轮仅宜搭71项的授权。

## 2026-10-15 长期目标已恢复active，原范围不缩减

本轮get_goal实核active，完整objective不变；本文旧blocked文字保留原时态，不再作为当前状态。首要执行重点仍是宜搭初始化/推送预览稳定试用，但PLM业务正确性/配置复用、K3只读与可信tenant、受管Automation及全部安全不变量没有从原目标删除。原目标MD已在本聊天integration-goals工作区找到，§4–6/§9要求用于本轮差距核对，不依据旧续篇扩展切片或权限。

现有组合源码的10个PLM整文件已实际补验290/290，并续记证据层级；浏览器候选不直接等同全目标达成。当前仍待正式浏览器来源采纳确认及其后整链门，自动目标续跑不替代该确认或推送/CI授权。保持所有现行禁令，不标complete，也不在恢复后的首轮即标blocked。

## 2026-10-15 有效本地候选：不改SDK，使用包含上游修复的隔离浏览器

本轮已从“只有复现、没有有效候选”推进到有效本地浏览器候选。原production SDK字节不改，1MiB、15秒、no-store、路由防火墙、host读取原响应全部保留；官方snapshot1719529 Chromium158.0.8107.0消除了当前合成复现的成功请求误报取消。最终证据以验证MD顶节/固定回执为准，不把这一构建与原CI143或未包含补丁的156参考混用。

- [x] 精确revision源码核验，找到上游CL8508456；3份原参考源码不含terminal-before-notify，官方新snapshot源码含修复。
- [x] 官方zip长度、公开MD5及本地SHA核对，独立比较zip内chrome条目与Linux解压binary的SHA；不信任CDP的全零revision去冒充精确运行源码revision。
- [x] 保持原SDK真实请求的三轮8格正常请求验证；原143基线另存红灯，不作重试洗绿。
- [x] 扩充真实SDK超限/截断/主动取消负例及字节守卫移除变异；区分透明诊断包装与无包装clean阳性，保留代理截断原oracle红证据。
- [ ] 固定为正式受审浏览器依赖/执行来源并完成同配置原manual/interval、宜搭五整文件71项、实际stop/自有PG清理。当前没有改包版本、锁文件、workflow或已有CLI浏览器来源，也没有用临时cache别名把158伪装成143。
- [ ] 满足原同head正式CI证据后，才开始此前有条件授权的Chrome正常UI合成试用；不因局部候选通过自动解除门。

最小采纳方向是**浏览器依赖/构建修复**，不是重写宜搭或Automation客户端；现有两文件stop归因补丁继续独立保留。正式采纳前需锁定受审的官方版本/来源/哈希和兼容范围，不能用滚动latest/不固定Canary替代；不能为了过门放松no-store、响应大小、路由、取消或原响应body断言。当前结论只证明该二进制候选对本地样例有效；非CL三行patch-only实验，非原生栈捕获，非远端CI唯一根因裁决。

Owner不在电脑前期间已自主完成安全独立工作，不要求其手工输入合成账号。到正式依赖/验收来源采纳以及未来推送/CI授权边界为止，不擅自扩大权限。当前主检出tracked未改，无新增产品切片。

## 2026-10-15 Owner不在电脑前：宜搭试用为当前首要收尾目标

Owner明确要求当前以宜搭对接为主目标，无需其守在电脑前。当前可自主执行范围不变：仅现有四PR内本地诊断、最小修复、合成验证和既有MD；不新增切片、不推送、不重跑CI、不合并、不部署、不读客户数据、不真实发送。此优先级调整不是恢复其它封存线，也不是将目标工具的blocked状态伪报为active。

可见完成标准：宜搭初始化→持久化合成配置→两行推送预览在受控环境中可稳定完成，并有真实取消/超限/截断拒绝、实际停止与自有PG清理证据。真实token交换和真实记录发送仍不在当前授权内。前三支PR安全复核作为配套依赖；#6337前置Chromium失败仍是正式试用/发布门，不能因宜搭局部测试绿而跳过。

新增调查方向基于实际源码差异而非版本号：Chromium官方CL8508456在DelegatingBytesConsumer::OnStateChange中先记录terminal result再通知client，阻止EOF回调重入Cancel将已完成请求误报取消。已核本地143、156稳定参考、156当日alpha的精确revision均没有该三行修复；官方snapshot1719529的公开源码含此修复。仅在隔离目录取得官方构建做因果对照，不改变仓库依赖、CI来源或原验收合同；该构建通过也只能算本地证据，正式采用的浏览器/CI变更须另裁，禁止偷偷切换验收来源。

## 2026-10-15 当前执行目标与模型分级（沿用原长期目标）

Owner已要求把剩余事项作为目标继续开发。线程原长期目标仍未完成且工具显示blocked，create_goal因存在未完成目标拒绝新建；不得伪造完成来绕过，也不能由本工具直接切回active。本节登记该长期目标下的当前子目标与继续执行范围，不声称新目标已成功激活。收尾范围仅现有 #6315→#6323→#6324→#6337，禁止新增切片。

- [ ] G1：为#6337 POST202原始请求找到安全有效的最小修复；必须保持真实请求FINISHED、SDK/host原响应验证、1MiB有界读取、no-store、路由防火墙与取消/截断/超限拒绝。复现或增加诊断不算修复完成。
- [x] G1-a：补齐不patch reader、无binding、服务端自行两写、host在终态后读取的真实SDK复现，以反驳观测自扰动假设；仍是失败证据。
- [ ] G2：检查#6315/#6323/#6324各自准确head上的迁移、凭据/owner/tenant、安全开关、测试接线与部署前置；状态抽查不能替代完整代码复审。仅修既有范围内缺陷。
- [ ] G3：候选有效后补齐原合同、类型、provenance、PLM manual/interval、宜搭五文件71项与实际停止/PG清理；保存同字节回执，不借旧绿冒充候选验收。
- [ ] G4：最终本地代码/MD/回滚说明与分支依赖收口，形成待授权交付包。推送、CI重跑、合并、部署、真实客户读取与宜搭发送仍须另行授权，不列为当前可自动执行动作。

模型/effort按工作性质选择，而不是全部最高档：机械清单/引用/MD整理优先Luna low/medium；已有边界内的跨文件实现与回归优先Sol6.1 high，涉及状态/异步收敛时升xhigh；浏览器原生竞态、租户/owner与写围栏取舍、反驳性终审才用Astra ultra只读复核。仅在有明确独立且已授权职责时派发，写文件保持单一责任人，不让多个模型修改同一文件。可用性和effort取本会话工具实际支持值，不能把API文档参数名直接等同桌面配置；未调用的模型只算分配策略，不伪报运行证据。本轮沿用此前已获批的只读复核代理，主任务负责实现与最终验证。

完成门：G1至G4全部满足才可称本地收尾完成；当前仍被G1阻断。1–2工作日仅为可控收口预算，不含尚无有效方案的浏览器故障，也不作为上线承诺。

## 2026-10-15 本轮裁定：复现已成立，不能提交无效绕过

真实生产SDK.submit、真实HTTP POST202、原Vite代理/诊断包装、真实route.continue及独立原生CDP已复现“SDK返回queued但原生请求ABORTED”的关键签名；真实超限/截断/主动取消负例继续拒绝。五个局部/浏览器候选均未通过，含官方当日预发布Chromium156.0.8078.12。因此没有新增可验证的产品修复，不把之前已完成的停止归因补丁冒充ABORTED修复；保留现有业务SDK、安全守卫、严格验收与发布阻断。后续应针对真正修复该路由场景的浏览器构建继续验证；若改交付浏览器或验收来源，须另裁，不默默降级或绕过。本轮结果、固定哈希、差异边界和原证据复核见验证MD顶节。

## 2026-10-15 继续定位：CI关键POST签名已可本地复现

已从“直连POST202未复现”推进到真实POST+分段响应+Playwright route.continue/Vite代理的对照矩阵。路由四格均复现页面EOF但原生CDP与Playwright ABORTED，原SDK诊断包装非必要条件；仅代理的结果有时序敏感。故修复目标是保留原始请求真实完成、host读取与严格网络断言，而不是抹去Playwright报错。现有独立停止及清理通过证据不抵消它。

本轮四个候选对照均失败，无新增产品补丁。禁止以移除路由防火墙、缓存private响应、无界读取、clone/tee、重放响应或忽略取消来交付假绿；候选必须使同一真实请求正常FINISHED、页面与host均读到完整原响应，并保住超限/截断/主动取消负例，随后再跑原合成全链。官方预发布浏览器只在隔离目录验证，不默认改锁文件或引入交付依赖。详细对齐项、剩余差异和准确终态见验证MD顶节。

## 2026-10-15 本次落地结论

现有verifier和合同测试两文件本地最小补丁已完成，准确区分前序浏览器失败与实际停止；189项合同、provenance、类型检查、原manual/interval全链及宜搭71项本地验收均通过，实际停止与自有PG删除已验证。剩余不是“继续改stop超时”，而是CI POST202的Playwright取消精确触发条件未复现、未修复。保持原Chromium门和远端失败，不放松原验收合同，不启动有条件授权但尚未满足正式证据前提的试用。本轮仅本地补丁/MD，未推送、CI重跑、合并、部署、客户读取或真实发送；具体回执与限制见验证MD顶节。

## 2026-10-15 CI失败后的本地最小处理（本节优先于旧发布授权）

本次 owner 只授权现有 #6337 本地定位、最小修复、合成验收与 MD；不推送、不重跑CI、不新增切片、不合并、不部署、不读客户数据、不真实发送。冻结远端基线 `fcb20c3d054cb8d057b0e8938c7f16ca6b8c34a4`。

停止链的准确事实是：浏览器 `AUTOMATION_MANUAL/REQUEST_FAILED`，随后 `actual-stop-resolved`，再因尚未执行到协作子进程启动而出现 `COLLAB_CHILD_REQUIRED`。这不是 host.stop 超时。最小补丁只把已有“前序业务必须成功”守卫移至停止证明块最前方；实际 host.stop 仍无条件先执行，业务失败仍阻断 proof，没有产生新通过路径，缺失协作子进程在前序成功路径仍拒绝。新增合同提取并执行原 finally 代码，覆盖前序失败、实际stop拒绝、缺失协作探针；守卫移除变异改变真实路径结果并被断言抓住。不改生产停止实现或业务SDK。

兼容问题与CI根因必须分开：后续对齐method后，两版本POST202（含JSON body）未复现，GET200仍复现；早期GET202结果不能冒充POST控制。因此本次只确认GET有独立兼容缺陷，尚未坐实CI POST202失败的精确根因，不以修复上游GET问题或简单升级冒充全部收尾。

ABORTED 严格保留为未修复：临时目录的独立真实HTTP对照，在当前Chromium143及临时Playwright-core1.64.1/Chromium156上均复现 no-store 分段有界流消费后页面EOF/JSON成功，但host读取失败、requestfailed；native JSON仅作为无界诊断参考，两版本均正常。超限/截断/主动取消的六个负控制均拒绝；不把这组小矩阵等同实际应用端到端验收。上游issue42742虽有修复记录，本机新版本对照未验证奏效，不升级仓库依赖或宣称修复。禁止取消no-store、改为无界body读取、忽略ABORTED、重放/伪造响应或以Firefox/本地绿替代正式Chromium门。

交付只包含原 verifier 与现有合同测试的本地两文件补丁及既有MD；独立browser-fix-probe是仓外临时合成诊断材料，不进入PR、不增加工作流。宜搭原五文件71项验收单独运行，结果只能证明宜搭本地链，不能解除PLM/Chromium发布阻断。若不能找到保持这些边界的安全修复，应如实停在该阻断，不发布假绿。

## 2026-10-15 本轮发布授权

Owner 已明确批准将本轮两个诊断/合同文件和这两份既有 MD 追加到现有草稿 #6337，并运行既有合成 CI，继续捕获 ABORTED 与停止阶段。仅以 `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35` 为父提交追加，不新增切片或工作流，不把观察修复宣称为历史根因修复。下方“未授权推送/重跑 CI”为此前阶段状态；此次授权仅覆盖本轮准确补丁及一次既有合成 CI 启动，不包含自动失败重跑、合并、部署、客户读取或真实发送。

## 2026-10-15 本轮实际终态

两个现有诊断/合同文件的最小修复已本地完成：不再丢弃三层传输诊断，实际 stop 与停止证明前置失败可以分辨。完整合同187/187、四组变异致红、provenance1/1、Astra ultra独立只读复核通过；原 manual/interval public CLI 各一轮完整合成链及原始证据复核通过，实际 stop 和 PG 删除均成功。Chrome 真实操作仅得到默认读取OFF的完整503对照，后续连接断开，没有伪报Chrome已跑过启用Automation夹具。

本轮未复现历史取消，因此不改生产SDK/超时/权限/取消/时钟，不声明根因修复或稳定发布。本地通过不抵消远端失败，诊断输出本身可能影响时序。现有草稿 #6337 仍只保留已发布36cdb，当前新两文件和MD未提交/推送；不新增切片、不重跑CI、不合并、不部署、不读客户数据、不真实发送。详细冻结字节、终态及限制以验证MD最新节为准。

## 2026-10-15 Chrome 复现与诊断最小修复（仅本地）

Owner 已授权现有 #6337 内本地复现、捕获取消和停止阶段、最小修复及合成验证，必要时 Astra ultra 只读复核；当前不授权新增切片、推送、CI 重跑、合并、部署、客户读取或真实发送。发布基线为 `36cdb73f8ac9c42719965d4ffaa3b050ee82fa35`。

Chrome 真实密码登录、独立合成项目看板与 Automation options 按钮已实际操作。公开交互试用的读取功能默认关闭，该请求完整返回 503 + loadingFinished，没有取消；只作 OFF 对照，不当作 CI 已启用 Automation 夹具中的 ABORTED 复现。浏览器保持连接时对已核 exact cmdline/owner 的本次公共 CLI 发 SIGTERM，原停止链 exit0/STOPPED，PG/handoff 清理；没有杀其它进程或重启 WSL。

本轮仅两个既有测试设施文件改动：公开 PLM full-app runner 对原有 SDK/PROXY/PLAYWRIGHT transport 帧再次做有限白名单投影，并公开独立 actual-stop-resolved/failed 与精确 COLLAB_CHILD_REQUIRED 诊断；既有整文件合同新增真实子进程转发与污染/越界负例。没有修改 SDK、生产请求/取消、host.stop 或任何通过条件，不把观测修复当作取消根因修复。两个文件已加入本地交付副本，未提交或推送。

原公开 full-app 入口首轮在业务启动前因隔离副本无 Git 元数据失败。仅针对已准入的 13,758 文件建立无历史的本地 Git 快照 `7ccd6da23c92d45a0c4ef4ee02de7111d8310291`；该快照不是 GitHub 新 head。随后运行原 namespace/manual 合成入口，阶段终态见验证 MD。没有放松 native namespace 或导入 Git 历史、env、客户数据。

## 2026-10-14 发布授权范围更新

Owner 已明确授权将本次六文件补丁及两份 MD 推入现有草稿 #6337，并运行既有合成 CI。仅追加到当前 head，不新增切片、workflow 或授权边界。下方“不推送／待授权”是此前阶段记录；本次授权不包含合并、部署、客户读取、真实 token 交换或宜搭发送。原失败证据和发布门仍保留，新的 CI 结论必须锁定实际新 head；不能借本地 71/71 或其它泳道绿判正式步骤成功。

## 2026-10-14 最终本地候选：完整 Chromium 与页面试用（最新状态）

本节覆盖下方历史快照中的“四文件候选／浏览器未执行”状态，但不删除其失败证据。基线仍为 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`；当前为六个尚未提交、尚未推送的代码/测试文件。原四文件之外，新增修改既有 `scripts/ops/run-stock-preparation-yida-browser-ci.mjs` 及其 `stock-preparation-yida-browser-ci.test.mjs`。

原因是前述 HTTP 诊断负例增加一条测试，原固定清单仍要求 70 条，会让新增候选在 VALIDATE 阶段被拒。按准确清单改为 71 条（66 业务 + 5 哨兵），保持五文件全集、零过滤、零重试、零重复、零跳过、零未处理错误要求。此问题仅属于本地新增候选，不是远端原 head 的 EXIT 失败原因；不放宽门槛，也不改生产运行时、时钟拒绝或发送授权。

最终无临时插桩的原公开 Chromium CLI 已通过 71/71，真实 PG 清理成功。随后真实完整应用页面完成合成账户登录、两行预览、本地初始化、再次 GET 回读，私有输入清空；保持 canSend=false、tokenIssued=false、externalWriteAttempted=false。浏览器连接保持打开时经原停止协议退出，exit0、handoff 与临时 PG 删除，最后关闭本次临时标签页。该轮始终保持 systemd-timesyncd active，未复用暂停授权。

边界：这证明当前本地候选成功跑通，不证明时钟环境永久稳定，也不代替正确新 head 的正式 CI。第一轮原 CLI 的 70/71 与中间诊断运行的结果均保留在验证文档；远端 attempt 1 租约失败、attempt 2 宜搭失败及 Chromium 发布阻断仍保留。不新增切片、不推送、不触发 CI、不合并、不部署、不读取客户数据、不向宜搭真实发送。

## 2026-10-14 已捕获时钟回拨触发 503（仅本地）

本轮冻结基线仍为 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`。隔离合成正例捕获到 `TOKEN → RUN_CLOCK(delta=-1352ms) → CLOCK_INVALID → SEND/RUNTIME UNAVAILABLE`。失败当场的独立 PG 摘要为 admissions=1、ledgers=1、audits=1、ledgerState=prepared、tokenRequests=1、formRequests=0。该新失败的直接原因是实时时钟回拨；先前没有内层证据的两次 503 与另一轮 ACK 断言失败仍不追认同因。

后续 60 秒双机只读采样：Windows 回拨 0 次，WSL 回拨 2 次、最大 1796ms，WSL 实时时钟与单调时钟的变化差为 -3697ms。已定位本机 WSL 的实时时钟不稳定；还没有证明造成校时的具体服务或机制。NTP=yes、同步服务 active 不能作为时钟始终单调的证明。

本轮最小代码变更是诊断与回归补强，保留已验证的退出顺序修复。当前交付副本共四个代码/测试文件：试用 cleanup 脚本、其真实代理连接回归、现有 owner HTTP 测试的安全失败摘要、现有 runner 测试的两条 token 后/claim 后回拨回归。HTTP 摘要只读取独立合成 PG 的固定计数及状态；没有打印 ID、正文、凭据或材料。状态选取第一条，必须结合 ledgers=1 解读；诊断查询没有独立短超时，极端数据库挂起仍可能影响失败报告。

生产运行时的回拨拒绝是正确行为，本轮不放宽容差、不钳住 Date.now、不自动重试或退还 admission。token 后回拨须保持 prepared 且没有 claim/form；claim 后回拨须保持 outcome_unknown 且没有发送/ACK。两条新增回归均走真实 runner/store/token/transport 组合，数据库边界为原有显式内存替身，不冒充 PostgreSQL 并发证据。三整文件原生 JWT/实际授权/实际 PG 的最终候选验收另行记录。

临时原生阶段收集器解决了 Vitest 与原生模块图的隔离，捕获后全部还原。13,758 项源码后验确认仅上述四文件变化，生产 runner、send-port、runtime、approval service、token client 与 pin 均保留原字节。

本机时钟对照实验已按 owner 单独授权完成：只针对 Ubuntu-24.04 的 systemd-timesyncd 暂停约 60 秒，先设置独立 90 秒恢复定时器，再在 finally 确认服务恢复，随后采样 60 秒。暂停阶段 5713 个样本、回拨 0 次；恢复阶段 5675 个样本、回拨 2 次、最大 1247ms；两阶段单调时钟回拨均为 0。服务已恢复 active，恢复定时器已清理。脚本没有设置系统时间、修改持久配置、重启 WSL 或访问 DB/HTTP。

该受控对照支持回拨与本机同步服务运行有关，但还不足以定位其底层时间源/校正机制。当前服务恢复后仍复现回拨，不能宣布环境已修复，也没有据此关闭历史 CI 或 Chromium 阻断。owner 只授权本轮约 60 秒暂停；更长的合成试用暂停窗口或持久环境调整须另行确认，不能由本轮授权扩展。

后续现有三整文件合成验收的控制脚本 `tmp/6337-timesync-controlled-proof-20261014.mjs` 已在 owner 单独批准的最多 10 分钟窗口内执行。先设置独立 600 秒恢复 timer，临时暂停服务，以 runner 身份执行原 loopback-only / 独立 PG / 固定源码哈希的三整文件驱动；结果 59/59、清理成功，完成即在 finally 恢复服务。独立检查确认 active / restoreTimers=0；没有延长窗口、改持久配置或操作浏览器、真实系统。验收期间另外 30 秒采样 2955 次，实时时钟和单调时钟回拨均为 0，采样前后服务均 inactive。

该结果完成本次受控后台验收，覆盖初始化、预览、单行模拟发送及历史回读。它不包含前端浏览器验收，也不证明同步服务恢复后的环境已永久修复。后续不得自行复用本次暂停授权、长期停服务或消除原正式 CI/Chromium 阻断。

## 2026-10-14 模拟提交 503 定位续记（仅本地）

在原两文件退出补丁上，只新增修改现有 `stock-preparation-yida-owner-http-realdb.test.ts`：共享成功响应断言附固定阶段与 `YIDA_[A-Z_]+` 格式错误码，覆盖 draft/preview/approve/submit/replay/history；错误消息不附带响应正文、凭据或标识。增加一条用例验证未知内容归为 UNCLASSIFIED、合成私有内容不会进入诊断。原状态码、payload、权限、计数、超时及重试要求不变。

这项改动已把新复现的同类 503 收窄到 `submit:YIDA_OWNER_RUNTIME_UNAVAILABLE`，没有把原两次无阶段记录的失败追认为同一内层原因。临时插桩只在隔离源副本定位异常，必须还原，不进入补丁。观察到 WSL 时钟回拨；执行器原有回拨拒绝守卫保留，未将该相关线索当成已证实根因，不据此修改生产行为。

远端原 head 的 CI 已以宜搭 worker 失败结束；本地任何成功不代替该失败。监视器已按终态停止，不自动重跑。不新增切片、不推送、不合并、不部署、不真实发送。

## 2026-10-14 浏览器连接退出最小修复（仅本地，禁止推送）

基线 `0a33783580fc6d6e5f3fc5e698f2edf717d2f024`。本次仅改试用脚本与其现有测试文件，不创建 PR/切片，不动恢复生产代码或宿主 index。运行时有效改动只有 cleanup 顺序：先 `host.stop()`，再 `preview.close()`；两步仍分别保留失败，handoff 的独立 finally、PG 父进程清理、十秒 producer 屏障、随机身份、TTL 和默认禁止发送完全不变。

根因证据：原脚本先关闭 Vite 代理，使已升级的上游 WebSocket 无法通过该代理完成关闭握手，直到底层 30 秒 close timeout 才结束；宿主十秒 producer 屏障如实失败。用真实 Vite preview、真实 CollabService、真实 Socket.IO 客户端和本地 HTTP 链路复现：原顺序 30,035ms，新顺序 2ms。修复版完整应用中浏览器不先关闭，HTTP 从停止到关闭为 4ms，整个公开 CLI 正常 STOPPED、exit0。此证据解释本次带浏览器连接的失败，不追认所有历史超时为同一根因。

测试从真实 `ownedWorker` 的 finally AST 提取实际两步清理语句并执行，不手抄实现；覆盖 host-first 次序、host 失败仍清理 proxy、proxy 失败保留、preview 未创建。另用真实 Vite/Socket.IO/HTTP 测试完整关闭握手，未提前断开客户端、缩短 ws 超时、替换计时器或 mock socket。该回归在原代码 11/13（两失败），本地修复 13/13。

执行源码位于独立准入副本；两文件补丁的 Windows 交付副本在 `tmp/pr6337-proxy-drain-local-20261014/`。仍须 owner 再授权才能推送；当前远端 CI 不包含该未提交补丁，任何远端绿灯都不冒充本补丁验收。

## 2026-10-14 本地页面验证边界（续记，尚未推送）

Owner 授权在原 head 上重跑单个失败 job，并改用内置浏览器执行合成试用。本次未产生运行时代码变更；继续使用原 CLI、900 秒 TTL、随机合成身份、临时 PG、发送默认 OFF。公开 CLI 的清理回执与 UI 功能结果必须分别判定；新实测已证明初始化与两行静态预览成功，但带页面连接的停止协议触发生产者 drain 屏障失败，不能用父进程最终删库成功替代宿主正常停止。

后续如在既有 #6337 内修复，应先用真实浏览器/HTTP 连接证明具体 drain 等待点，保留已接纳请求和审批完成屏障，不延长十秒屏障、不清空全部活动连接、不修改恢复代码、不降低 Chromium 验收标准。当前不作未经证明的根因断言。本地续记不授权新的推送或 CI 触发。

## 2026-10-14 CI 登记修复（已获准推入原草稿并运行既有 CI）

准确 head `f77208bfcfa42cca86d1fde3606229aecd1985ba` 的 CI 在 core 测试提前失败。新增 socket 构造器逻辑出现三个新的 `this` 使用位置，但 attendance 装配安全测试仍钉住旧 65 项 SAFE 清单。本次仅更新该测试：登记 listener/add/delete 的三个完整 AST occurrence key，计数改为 68、固定 hash 重算；不改变分类器，不改作用域，不动态生成放行清单，不设置整个属性名豁免。

同时增加 httpServer/httpSockets 新使用位置及 socket add 重复出现的负例，证明现有登记不准许新的访问位置自动进入 SAFE。生产 index 和四个已发布文件均不改变；不是新业务切片。owner 已明确授权本次测试修复和 MD 更新推入现有草稿 #6337，并运行既有合成 CI。CI 结果须绑定新提交，不预记成功。合并、部署、客户读取与真实发送仍禁止。

更新：2026-10-13。发布父提交：`8b75e155a41e4f8ea4e892e4c87d7f9572b8a5b8`。

## 范围与授权

owner 已明确允许将既有补丁推入草稿 #6337，并运行既有合成 CI。只修改四个代码/测试文件及本设计、验证 MD，不新增 PR、切片、端点、开关或 workflow。不合并、不部署、不读取客户数据、不做真实宜搭 token 交换或发送；K3 写回永久禁止。PR 保持草稿。

## 两项最小修改

1. 临时合成试用使用简短固定登录名；该名称不是秘密。每次仍创建独立临时数据库，owner/tenant 仍分别生成 UUID，密码仍来自 24 个加密随机字节，仅写私有交接文件。正式认证、权限、TTL 60–900 秒、所有权清理及发送默认 OFF 不变。
2. 宿主 HTTP server 在实际构造器登记 connection/close。停止监听后，仅销毁 `socket.bytesRead === 0` 的 TCP 预连接，避免这类连接等待 header timeout 而拖住停止。已被 Node 读取任何字节的连接继续原 drain；不关闭所有连接，不延长十秒屏障，不跳过审批/恢复/custody 屏障，不改变 pool 关闭顺序。

`bytesRead` 指 Node 已读取的字节；本保证不把网络或内核缓冲区中尚未被读取的字节说成已接纳请求。此修复证明一个真实预连接缺陷，不能证明它是此前 Windows 试用到期失败的唯一原因。

## 发布候选隔离

本地实现检出落后于远端且有其他未提交内容。发布使用独立 Git 索引，直接以准确远端 head 为父提交；只写四个批准文件和两份 MD，不操作原工作树/索引、不 force push。

逐文件核对发现本地 `index.ts` 还含一处非本任务的 `release(error)` → `release()` 差异，已从发布候选排除，保留远端错误传递语义。最终 index SHA-256 为 `51195cab0d27b5fb4a6352428f0945d1d5bd85f838be7c043b4871b8a9362fa2`。旧候选的本地证据与新发布候选分开记载，不混用。

## 验收与限制

测试先证明真实构造器、TCP socket、实际关闭方法和未完成 HTTP 响应可达，再以删除预连接清理、扩大到活动连接两种变异检验断言。试用身份测试执行实际声明及真实 crypto，并拒绝固定密码/owner/tenant 等四类变异。

准确发布候选需重跑 shutdown/recovery 整文件、宜搭后台三整文件、试用契约及完整 provenance。已有 Chromium 完整应用 ABORTED 仍是发布阻断；后台 HTTP/数据库通过不等于浏览器页面通过，Firefox 交叉验证不替代固定 Chromium 门。

本次只运行原有 CI；不修改失败判定、请求大小、no-store、取消策略或隔离门。合成初始化与静态预览不代表可以真实发送。回滚只撤销本次提交，无迁移、无客户数据操作。
