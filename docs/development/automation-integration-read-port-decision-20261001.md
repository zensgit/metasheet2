# SA-06：Automation 受控只读集成端口（A 已获准）

状态：**2026-10-01 用户明确选择“A：按受控只读方案开发（推荐）”**，批准本合同的本地实现与合成测试。此为独立于PLM管理/验证门的Automation授权决定，不是已实现声明；仍不授权真实客户读取、发送、部署、提交或发布。上位目标仍为 [六批集成自助适配](integration-self-service-adaptation-goals-20260930.md)，不以此首刀缩小 SA-06 完整范围。以下A/B措辞保留为决策来由，当前选择A。

最新本地状态见§30手动新预算retry及§31普通Automation create/update可信image。§31最终冻结版完整114/114通过；§29完整108与§30完整112为历史批次证据，不累加覆盖数。此前原生107/108中的PLM预览outcome_unknown仍未解释，历史失败保留。自动请求retry、date_field、其它记录类型/未覆盖producer仍未完成；目标active，不代表发布就绪、生产验收或完整iPaaS交付。

## 1. 要用户决定什么

推荐 **A：开发“连接 owner 明确授权、绑定已激活版本、有期限/次数上限”的后台只读预览**。先用 PLM 备料实现真实纵切片，接已有 Automation 手动、定时、记录触发；分阶段启用，不新增 scheduler。每次执行仍重新验证身份、来源、版本和目标。只返回状态/计数，不写业务表、不产生 apply token、不发送宜搭、更不开放 K3 写回。

可选 **B：暂不增加后台读取授权**，保留当前交互式预览；SA-06 标为未完成，不把原有 outbox、引擎加固或手动入口说成已集成。

选择 A 只授权后续本地实现与合成测试；客户源读取窗口、部署及生产启用仍另批。真实发送和 SA-05 sender 的权限模型不在此提案中一并授权。

## 2. 当前代码依据

代码工作树 HEAD `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` **加累计未提交候选**，未刷新远端；下列行号针对本文件写作时工作副本，原始字节见§8，不冒充该HEAD原有实现。

- `packages/core-backend/src/multitable/automation-actions.ts:6` 的具名动作集合没有集成预览动作；不能把已有 send_webhook 当自调用授权桥。
- `automation-outbox-enqueue.ts:62,86,93` 已强制真实事务并原子写出站事件，但JSON payload不证明执行主体。request和outbox必须同事务，不能先HTTP调用再补任务记录。
- `automation-durable-dispatch-loop.ts:79,95,367` 已有结果枚举及AbortSignal；`automation-durable-activation.ts:97–117` 的原八个包装器只把event给handler。新增具名消费者可直接接context，不以重构八个旧消费者为前置，也不复用“handler resolve即业务success”的含糊判据。
- `plugins/plugin-integration-core/lib/stock-preparation-read-plan-runtime.cjs:27–56` 重验激活代次、可信tenant、来源作用域及connectionRevision/bindingRevision。仅保存connectionId或versionId不足以证明来源未换凭据/owner。
- `stock-preparation-table-actions.cjs:2291–2311` 在源读取前执行B2a，`:2316–2342` 才计算源与目标差异。`:2345–2353` 在可apply时持久化token。因此**不能调用现有dry-run后只从响应丢掉token**，也不能绕过外层B2a直接暴露内部computeDryRun。
- `http-routes.cjs:10435–10454` 既有run详情按integration read和scope读取，没有新request-owner门。新任务不能把私有参数/摘要直接塞进这些公共run行，再假定继承本提案权限。
- `packages/core-backend/src/routes/automation.ts:131,191–197,903–914,997–1016` 会把既有step.output投影成jobs/result或返回规则日志；平台admin执行详情同样没有Connection-owner门。因此原Automation日志/执行详情也不能承载新私有摘要，不能只防Data Factory runsGet。

本提案填补目标§41、§42、§51保留的GOV-08决定，不替换已批准的PLM生命周期或原09-01的“复用Automation+请求队列”方向。

## 3. A 的权限和授权材料

### 3.1 主体矩阵

首版仅tenant-level、workspace显式null，**当前 integration admin ∩ 当前 canonical private Connection owner**；无平台管理员owner旁路，无workspace共享，无自报tenant或principal。

| 操作 | 必须满足 | 明确拒绝 |
| --- | --- | --- |
| 创建/撤销只读授权 | 真实认证tenant、当前连接owner且有integration admin；授权创建人为规则创建人 | 代另一用户建授权、普通读用户、claimless+tenant header、客户端passed/owner自证 |
| 人工提交 | 同一授权创建人，当前权限仍满足；参数完全落在授权范围 | 仅持有授权ID、用他人的授权、客户端指定任意连接/端点/SQL |
| 定时/记录提交 | 保存于服务端的精确规则修订和显式授权仍有效；服务端重载并复核授权创建人的当前权限 | 直接相信event actor/createdBy字符串、service/admin自动代入、保存普通规则即自动授权 |
| 查询列表/详情、取消、显式重试 | 同一创建人且仍满足当前tenant/admin/owner条件 | 借原Data Factory runsGet绕过request-owner门；新owner自动接管前owner的历史输出 |

撤权/换owner后不再向旧主体返回历史摘要；历史账本保留，不删除掩盖状态。新owner需要自己的新授权。运维仅沿既有values-free审计定位错误，不新开查看业务参数或跨owner结果的管理员后门。

### 3.2 每份授权绑定的内容

由服务端从真实认证、规则、来源和当前受审安装材料铸造，不接受客户端提交一份“已批准JSON”：

- tenant/null workspace、授权创建人、规则ID及完整规则修订/动作指纹、允许的触发类型；人工场景另有明确一次性请求身份。允许手动不自动允许定时或记录触发。
- 具名operation/profile版本；首个操作为PLM备料**差异摘要预览**，不是任意SQL、任意pipeline或通用HTTP。
- action、source binding、canonical connection、connectionRevision、bindingRevision、已激活version/contentKey/generation及其有效样本回执。
- 真实目标部署/项目/表标识及必要映射修订。add/update/skip/inactive比较目标现有行，不是纯源计数；目标需属同一可信部署并通过既有受管records权限。当前顺序独立部署测试不证明同时多租户目标路由，无法解析目标就拒绝。
- 显式有限项目集合与参数schema；记录触发从绑定的字段取项目，也必须命中集合，不能从任意事件JSON扩展读取范围。
- 显式期限、执行次数及每次行数/页数/时间预算，均不得超出既有批准计划/B2a预算；没有无限期或无限次数默认值。重复投递同一已完成request不消费新执行，重新发起源读取必须原子预留预算。

参数或规则、来源修订、激活版本/代次、目标发生变化时必须重授；不自动跟随latest，不回退legacy。授权撤销与领取使用真实事务/锁/CAS，不能靠进程内Map或两次SELECT宣称不会越权启动。每次源IO前重验，完成发布摘要前再核权限与租约；不声称能撤销已发出的远端查询。

## 4. 请求、运行和输出

1. 宿主持有私有 `IntegrationRunPort`，只向受审插件实现注入所需窄能力，不经通用跨插件通信API传principal，不用自调用HTTP/mst allowlist。新增API若需要，只承载授权创建/撤销、人工提交、owner-bound查询/取消/重试；每个入口都适用§3同一矩阵，不能为UI方便扩大旧run详情。路由名称、迁移序号和类型接口在A获准后与当前main冻结。
2. 复用真实outbox/dispatcher，新增一个具名只读request消费者。私有request记录与出站事件原子建立；队列载荷仅不透明requestId，不放项目号、源行、凭据、授权主体或任意执行配置。request主体和业务参数来自受控私有存储，幂等身份绑定原始规则执行/动作及授权修订。
3. 领取与最终状态更新都需要独立sink fence，不能把outbox lease当业务表CAS。状态至少区分queued/running/succeeded/blocked/failed/cancelled/outcome_unknown；accepted不是预览完成，unknown不能自动再读或显示success。重试只能创建受新预算约束的关联尝试；失去lease的旧执行者不能覆盖新状态。
4. AbortSignal从dispatcher经过新consumer/port传到每个可协作步骤；超时、撤权、停worker禁止新的分页/子步骤。无法证明在途读取结束时标unknown，不把“超时”当物理取消。不要为取得普通重试而把非协作超时翻译成可立即重领。
5. 在现有受管读取与差异计算中抽取**有完整前置门的无token内部预览**，保留源/目标字段门、B2a独立用途/对象窗口/claim、源修订、预算、完整性及schema前后检查。后台用途不得自动借用人工B2a用途许可。只返回固定终态/原因/安全整数计数和必要版本关联；不返回BOM、缺件列表、revision摘要、apply token、原始异常。请求/审计可持久化，业务目标不写。
6. Automation执行与request终态有持久关联，运行详情区分“已受理/进行中/已完成/未知”。首个纵切片限定单一顶层具名预览动作，不允许后继写步骤把“已入队”当预览成功；完成/失败回填必须受同一请求身份和fence约束，不能重放整个规则重复读取。之后支持更一般组合需补独立语义证据。

**结果存储分界**：业务参数、计数、版本/来源关联只存于§3 owner-bound私有request及结果中。旧Data Factory run，以及普通Automation step.output、job.result、rule snapshot、执行日志/事件，只允许本动作的不透明requestId及有限状态，不回填私有参数、计数或配置。界面如需摘要，必须另外调用受§3矩阵保护的request查询；平台admin或规则读权限不能替代Connection-owner。保留旧接口权限，不靠扩大那些接口的允许范围解决兼容。

新flag（若实施需要）默认OFF，exact-literal `'true'`及manifest登记只是部署技术门，不代替owner授权或真实客户窗口。新consumer须满足manifest双向完整性；不能在flag OFF时漏登记造成其它已持久事件无法启动。保留Bridge在plugin分派、K3永久禁写。

## 5. A 获准后的实现顺序

1. 独立核心合同、私有授权/request持久状态机和真实PG竞争测试；迁移编号以实施时main分配，保留未知/历史账本的回滚策略。
2. 宿主窄capability→plugin受管无token预览→实际PLM来源和合法目标的合成纵切片。无customer IO，先不接定时入口。
3. 手动提交/查询/取消、运行详情与owner授权界面；同一已批准版本及第二套合成物理布局验收。
4. 新具名Automation动作与单consumer接线；接已有定时/记录触发，不另造引擎。权限/规则修订/撤权/预算/并发/取消与最终状态全部复验。
5. 扩K3具名只读操作复用同一端口合同，另测POST读与网络边界；SA-05宜搭sender及自动发送授权仍是后续独立前置。首个PLM操作完成不等于SA-06全完成。

## 6. 合成验收硬门

- 实际JWT/DB角色及owner→授权→事务request+outbox→真实dispatcher/consumer/port→真实resolver/facade→临时PG/合法目标→真实状态API/DOM；外部网络可用本任务拥有的合成边界，不能替换正在证明的守卫。
- 跨tenant/workspace、伪principal/createdBy、普通admin非owner、旧owner、撤权、过期/次数耗尽、源同ID换材料、ABA、规则/版本/目标改变：源IO前拒绝；在飞改变不发布旧结果。
- request与outbox同事务；并发仅一个源执行获准；重投已完成请求不重读；lease丢失、取消、超时、进程中断、DB提交回包丢失均有真实PG交错证据；unknown不可自动重发。
- 无token不只是响应投影：真实token store新增数为0，源/目标业务快照不变；普通人工dry-run仍保持原token合同。移除token抑制、B2a用途门、来源修订或目标门须被各自真路径用例独立击败。
- 现有Data Factory run API和Automation规则日志/执行详情/持久jobs/快照均不能读新私有参数、计数或版本关联；授权列表/详情/取消/重试逐口负例，含有平台admin或规则读权但不是Connection-owner者。队列/DLQ/日志只含values-free引用，K3写和宜搭发送实际调用均0。
- 先证明正例命中生产路径，再做逐项内存变异；记录抓不到的降级。独立反驳无blocker，按实际pin清单重算并跑完整provenance。远端CI/发布/客户验收另计，不用本地绿背书。

## 7. 回滚与停止条件

新功能关闭后拒绝新授权/提交；已接受请求保留状态，未起跑的标blocked/cancelled，在飞未确定的保留unknown。不能删除账本或自动重发，也不自动回退通用pipeline/人工dry-run。不能证明来源授权、目标作用域、无token、唯一领取或正确终态时停止本刀，不扩大权限“修好”。

## 8. 本次代码证据原始 SHA-256

以下只冻结所引八文件，不是整棵候选树或发布制品签名。独立只读复核指出原稿遗漏既有Automation输出投影，已补§2/§4/§6；这是设计修正，不是已实现保证：

```text
packages/core-backend/src/multitable/automation-actions.ts
ee179b86f5c32616f467f728a3ff6de85d727d1e8e34abc8f79e7fad5950f526
packages/core-backend/src/multitable/automation-durable-activation.ts
0a0d6d488c76396a489736e48cea0aacc2cb63bf8d98608524380fb9189a856d
packages/core-backend/src/multitable/automation-durable-dispatch-loop.ts
1c68a6850d05c396702618edc23a681ad06a88cd3ed779f2d07c0cdb8ca4015a
packages/core-backend/src/multitable/automation-outbox-enqueue.ts
ca687474811715430ed8cff36e92221112be5c96bfad73d6ee09a1f3d801e54d
packages/core-backend/src/routes/automation.ts
4bc3aa99403475981c87d0568f750d46cfe397f8d449ca3bf6360deecc732bfe
plugins/plugin-integration-core/lib/stock-preparation-read-plan-runtime.cjs
aaf1b415cc778a4a399f016376e7abf382392d26ca733af2978842f97e99c728
plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs
51f2c37aead62f9465bf50c419b6e9a2713cc4d5c7503f7786eec62662d8527e
plugins/plugin-integration-core/lib/http-routes.cjs
96ecfff85bdbed49fc117027f31888aeb463ae899ca0a2d7cd2b77edd1562be0
```

## 9. SA-06Q owner HTTP 合同落点（2026-10-01，本地候选）

这是已批准 A 的八个入口细化，不新增客户读取或部署授权；未提交候选的实现/验证见代码工作树 `automation-integration-read-primitives-verification-20261001.md` §20。

统一前缀 `/api/integration/automation-read`，全局真实 JWT 在前。主体仅来自 `req.user.id` 与 `req.authenticatedTenantId`，workspace 固定 null；自报作用域/身份 header、body、query 均不作为凭据。当前 DB actor/admin 与原 canonical private Connection owner 条件逐次验证，没有平台管理员 owner 旁路。

| 相对端点 | 行为与私有边界 |
| --- | --- |
| `POST /grants` | 显式有限 selector、projects、triggers、budget、expiresAt、maxExecutions；宿主重建当前受审授权材料，返回 grantId |
| `GET /grants`、`GET /grants/:id` | 当前 owner 授权投影；列表默认20、最多50，无总数，不返回私有 proof/sourceReference |
| `POST /grants/:id/revoke` | 撤销原授权，不退款、不删除历史、不重读 |
| `POST /requests` | 仅 grantId、invocationId、projectNo；服务端固定 manual。同一 invocation 的重交仅恢复原请求，不是重试 |
| `GET /requests`、`GET /requests/:id` | 列表只投影状态/项目/时间；详情才可返回只读计数、`canApply:false`。不能借旧 Automation/Data Factory 日志读私有结果 |
| `POST /requests/:id/cancel` | 原请求取消，不能保证远端已在途 SQL 被物理停止；旧 fence 不可发布结果 |

执行面 grant/submit 依赖当前 runtime；其余六个管理操作独立于插件生命周期。插件停机仍允许合法 owner 查历史/取消/撤销；服务器停机同步关闭管理准入，排空已进入操作后再关数据库。所有管理操作仍验证当前权限和原 Connection 实体身份，不因执行配置失效而向新 owner 转交历史。

所有响应 no-store，包括 JWT 和解析拒绝。固定错误 code，不回传原始异常；未知错误为503，畸形路径/JSON/编码对应400/413/415。授权建立过程中私有 source receipt 的拒绝可被 authority 汇聚为固定 `AUTOMATION_READ_UNAVAILABLE`（503）；不能将503当作自动重试读取许可。撤销成员资格后 AuthService 可保留用户而移除可信 tenant，此 API 返回403，不改动全局认证契约。

分页用 DB 原始微秒 `(created_at,id)` 键集，游标仅已授权返回项 ID；过滤条件、游标、全部候选及 limit+1 探测项在同一事务中重验，出错整页拒绝。列表不做状态重整；详情沿既有逻辑把过期 running 收敛为 unknown。因此详情读取不是“绝无私有账本更新”，但不会执行源查询或写业务表。

**仍未完成**：显式关联重试（必须新预算+关联尝试）；可授权来源发现；普通规则保存的 action/DB CHECK/整规则校验与执行关联；UI；定时/记录 producer。已有测试中的规则由合成夹具直接建立，不能冒充用户已能从编辑器创建。下一步先补规则保存与 owner-safe 来源选择，再接 UI 和既有触发，不要求用户手填内部 target/profile ID。

## 10. SA-06R 保存与来源选择合同（2026-10-01，本地候选）

本节细化已批准 A，不新增真实客户 IO、发送或部署授权。实现证据见代码工作树同一验证报告§21；替代§9末段关于“保存/来源发现未实现”的阶段状态，不替代其中其余边界。

新增第九个端点 `GET /api/integration/automation-read/options?sheetId=...&limit=20&after=ruleId`。当前 sheet 必填，最多50、无总数、固定 C 排序键集。SQL候选仅作提示，每个返回项、cursor、limit+1均经实际 execution authority 后才读取名称。DTO仅 `{items:[{selector,ruleName,budget,allowedTriggers}],nextCursor}`；无名合法规则用空串，名称最多160字符，不回私有 material/proof/凭据。空列表也检验当前 actor/admin 和 producer。这个列表不授予权限，grant每次仍重建当前授权证据。

来源只允许当前tenant/null workspace的canonical private Connection当前owner，且当前规则由该owner创建、受审来源和目标均可用。存在pointer就优先使用，不能因其损坏偷偷回到部署默认；真实缺失才允许fallback。提示到证明之间出现切换、失权、繁忙锁或非法材料，整页拒绝，不自动追随或重试。options依赖active runtime，停止时关闭新请求并排空已进入请求；已有历史六口仍独立可用。沿用可信JWT、no-store、固定错误响应，既有ActorError保留固定403；未知错误固定503。

普通规则新增 `integration_read_preview`，公开config仅固定operation和boolean allowManual。raw create、全部partial update的完整合并形状、新DB最终行CHECK同时强制一个逻辑动作：可null/空actions或一个完全一致的动作，不可分支/后继/workflow。只读动作在普通执行器live/simulate/continue/continueBranch/单步均固定拒绝，直到未来私有执行身份关联落地；保存不创建授权，不直接读取。Service可保留固定失败审计，不承诺整链零数据库写。

兼容性变化：显式畸形actionConfig、actions、type不再被parser吞掉；合法旧输入保持，actions:null仍清空。新迁移133000先于代码，持表锁；down发现任何read规则就拒绝，不删除/改写规则。新增owner options部分索引，无新增布尔开关或调度runtime。没有raw SQL/外写/跨workspace能力。

**下一步仍是**：用户编辑与有限授权/预览结果界面、具名动作执行关联、复用既有schedule/record producer、显式新预算且关联尝试的retry。69项完整合成PG含真实parser/service保存和JWT HTTP选源/授权/预览，但未声称公共规则CRUD HTTP、浏览器界面、整机boot或全库升级已验收。

## 11. SA-06S 自助手动入口与会话合同（2026-10-01，本地候选）

本节落实已批准 A 的有限授权/预览界面，替代§10末段关于该界面未实现的阶段状态；不增加客户读取、发送、发布或部署授权。完整实现/验证见代码工作树报告§22，上位目标§75。

备料项目页主动选择当前 sheet 的合格规则；浏览器只使用 options 返回的 selector，不要求手填内部 profile/target ID，也不自造 proof。当前项目、manual trigger、有限时间/次数/预算经二次明确确认建立 grant，另一次显式操作才提交 request。服务器绑定受审已激活版本，并在 grant、执行、发布结果时重验。默认15分钟/1次，UI输入最多1440分钟/100次且预算不超过当前 option；这些输入限制不替代后台验证。

新专用 transport 固定九口同源地址，credentials=omit、redirect=error、no-store，仅 Bearer及必要内容类型，不复用会自动带租户头/重试的通用客户端。15秒客户端等待不代表后台取消；DTO与流式 UTF-8 正文受限，最多1MiB，畸形响应固定拒绝。401/403先失效客户端，不读取可能带私有信息的错误正文。来源/租户/owner/admin资格继续由服务器确定，JWT解码或UI可见性不作授权依据。

会话以捕获的 token/signature 和面板 epoch 隔离；原始账号变更通知立即清理，相关 storage 事件本身即失效，不能因 A→B→A 的最终值相同恢复旧请求。每个异步边界前后检查；项目、sheet、scope变化及卸载也清空并丢弃迟到结果。scopeKey只用于清理，不发送成服务器作用域。

仅手动刷新元数据，无定时轮询/自动重试。提交不确定时保存原输入和 invocationId 于当前内存会话，用户可显式恢复原请求；不得换键制造第二次读取，不属于关联 retry。离开/换账号清空恢复材料并提示。历史启动必须匹配完整 rule/action/system/target selector及当前选中规则；同项目的其它历史可管理但不能借此启动。

独立历史入口不调用 options、不要求运行时或目标 sheet 可用；它会清掉启动资格，但保留符合当前 owner 权限的查看/撤销/取消。三处历史读取均按 grants→requests 顺序，避免同一 grant 的 NOWAIT 锁自冲突，每步之间仍验会话。取消仅阻止后续执行/发布，不承诺已经发出的原生 SQL 被物理停止；不确定状态不自动重读。

最终真实 PG71项包括实际 Chromium生产面板的显式授权→提交→只读结果、规则切换禁启动、切换账号清空、撤权403、runtime停止后历史查看和撤销。Vite挂载是隔离入口，不是完整站点登录/boot；规则使用真实parser/service，不是普通编辑器或公共规则CRUD HTTP。本片没有新API、迁移、布尔flag或第二调度器。**普通编辑器、具名动作执行身份关联、既有定时/记录触发、显式新预算关联 retry 仍待实现。**

## 12. SA-06T 普通编辑与执行隔离合同（2026-10-01，本地候选）

本节替代§11末尾“普通编辑器未实现”的阶段状态，不扩展 A 的授权。普通 Editor、Manager 与默认公共 client 已能创建、读回、修改固定只读规则；完整代码与复验记录在代码工作树报告§23。普通 CRUD 沿用真实 JWT、workflow 权限及 sheet 写权限，集成管理员资格不自动替代这些权限。保存只写规则，不创建 grant/request、不授予源读取资格。

公开动作仅固定 `integration_read_preview` / `plm.stock-preparation.diff-preview.v1` 与 boolean `allowManual`，默认 false。singleton、闭合配置、legacy/modern 一致、真实记录/定时 trigger 与 null/legacy mode 同时约束编辑器和 payload builder。未知键、旧配置冲突、非法 mode 必须明确修复，不能借重存悄悄取得有效规则。普通规则未知键保留不受影响；公共 client 仅对含 read 的畸形响应新增固定拒绝。

Editor/Manager 的“测试”和历史“重跑”均拒绝含 read 的实际执行路径；仅禁用按钮不够，handler 同样拒绝。用户必须去备料 owner 面板，仍由当前 Connection owner ∩ live integration admin 明确建立有限授权，再单独提交一次只读预览。UI 明确提示定时/记录自动执行尚未接通；本片没有解除普通 executor 的后端固定拒绝门，普通引擎仍可能记录固定失败审计，不能称为可自动执行。

响应式检测只对 draft 的已确认 own data 字段跟踪，不扩大到业务 JSON 字符串或普通动作的无关字段。getter 回归限定新 computed/save-policy，不保证既有整个 Editor 的 JSON dirty observer 永不调用任意 JavaScript getter；HTTP JSON 也不能携带 accessor。

**下一刀**：将私有 grant/request 与真实 Automation 执行及动作步骤建立持久关联，再接原 schedule/record producer。现有 selector.actionId 是受管备料动作标识，不冒充引擎 stepId；客户端调用参数、普通日志、`_triggeredBy` 字符串均不得成为新的授权证明。自动提交需稳定触发身份、限定项目和当前授权重验；不得因重复事件、重启或未知结果换 ID 重读。显式 retry 必须新预算并关联上一次尝试，继续与“原 invocation 恢复同一请求”区分。以上仍在已批准 A 的本地开发范围，真实读取、发送、发布和部署另行授权。

## 13. SA-06U 真实 execution 审计与状态投影合同（2026-10-01，本地候选）

本节替代§12末尾“持久执行关联未实现”的阶段状态，不新增客户 IO、发送、发布或部署授权。它是受权事务内审计，不是普通 Executor 新执行入口；完整复现、字节及未验边界见 CodeWT `automation-integration-read-primitives-verification-20261001.md` §24，上位目标§77。

私有 `submit` 新 request INSERT 后、outbox enqueue 前，唯一生产调用点无条件 await `recordAutomationReadExecution(trx,{requestId,ruleId,actorId,tenantId})`。helper 重验实际 queued request、原 grant 的 scope/owner/项目/trigger 和当前 enabled/creator/rule revision，实际调用 `new AutomationLogService().recordWithQuery(...)` 写 public shell，再 INSERT immutable private link；request/shell/link/outbox 全部同事务提交或回滚。重复 invocation 返回原请求，不另建壳，不回填旧 request。公开 owner route 继续强制 manual；内部 manual/schedule/record 账本合同保留，不据此宣称自动 producer 已启用。

shell 使用 `axe_UUID`、固定 `integration-read-owner` origin、running、steps=[]，不带 triggerEvent、ruleSnapshot、fingerprint、initiatedBy 或业务参数。private link 固定 request/execution/rule/DB revision 与 `step_index=0`；这个0是单动作审计位置，不是 job、引擎 stepId 或新工作流执行器，也不把受管 selector.actionId 改成引擎身份。关联和 origin 均不授予 source 权限；claim/checkpoint 及原结果/历史 owner 门保留。

DB trigger 跟随实际请求 writer，不依赖某一 TypeScript 成功回调：queued/running 投影 legacy running 和空 steps；succeeded 投影 success 及唯一 read success step；blocked/cancelled 投影 skipped；failed/outcome_unknown 投影 failed 和固定原因，其中 unknown 明确为 `AUTOMATION_READ_OUTCOME_UNKNOWN`。public `integration_read` / API `integrationRead` 严格只含 `{requestId,status}` 七态；step output 同形，没有 project、selector、digest、counts、私有结果或来源材料。公开管理员运行页不能借此获取原 owner 私有结果。

延迟 COMMIT constraint trigger 要求仍存在的非NULL公开引用有匹配 private link/request 和正确闭合当前投影，拒绝独立 COMMIT 假壳；先 shell 后 link 同事务合法，已经 cleanup 删除的行跳过。private link 不可换绑、修改、删除或清空；已 linked request 的 grant_id/owner_id/tenant_id/workspace_id/project_no/invocation_id/trigger_type/created_at 不可改，outbox_id 的后续附着及正常状态/result/fence 更新不冻结。无 public FK，retention 能删公共日志；后续 UPDATE0 不插回，同 execution ID 重插拒绝。所有触发表目标使用实际 `TG_TABLE_SCHEMA`，不从 search_path 取同名表。以上是有限身份硬化，不声称防 DB 管理员禁用触发器。

`xmin` 只证明本事务写入，不能区别本事务对旧请求 UPDATE 与初次 INSERT，不作为新授权或初次创建保证；不回填来自唯一生产调用点仅位于新 request INSERT 后。**134000 migration 严格先于应用代码**：普通日志路径也读写新增 `integration_read`，feature OFF 不能绕过部署先后条件。down 发现关联历史即拒，不清除审计；未验证全库升级或真实客户环境迁移。

FE list/detail 两层封闭新可选引用，unknown/extra/getter/非法 ID 不渲染；七态文案区分 queued/running 和未知/确定失败，不自动重做。不显示关联 run 的普通 snapshot、事件或业务 step JSON；read 引用和固定 origin 各自足以让通用 rerun 的按钮与 handler 拒绝，指向备料 owner 入口。普通 run 不变，普通 Executor 的 live/simulate/续跑等 read 拒绝门继续保留。

核验冻结：audit PG46、ledger138、authority/browser最终74；authority/browser一次首败未独立复现，诊断复跑及 DOM settled 后复跑均74，不隐去首次红。旧 event_fires8通过，fixture consumer expiry 与 `runDispatchTick` 共用 JS claimNow，生产 dispatcher 未改。unit+ordinary397、FE七文件317、CI282、wiring64通过；套件不累加成覆盖率。backend5/5和FE4/4有界变异均 AssertionError；FE handler变异一次撤两个检查，非逐守卫证明。core/web types0、core选定lint0，web Manager既有两错误未变，不称全仓lint绿。provenance66项0diff，仅按实际module重打pluginTestsWorkflow pin；细节统一引§24，不复制hash。

主检出8b2094471未改（仅原artifacts/reviews），候选b35d4cd1f仍未提交、未rebase；仅本地合成授权，无客户 IO/发送/提交/push/PR/merge/deploy。**SA-06与上位goal仍active**，剩余为原 schedule/record producer 显式自动授权绑定、稳定触发身份、显式新预算关联 retry。新 grant 不自动接管旧 binding；原 invocation 恢复同一请求与新预算关联 retry 继续区分，unknown 不换 ID 盲读。日志关联不等于这些自动调度能力已交付。

## 14. SA-06V 显式 record 自动启用合同（2026-10-01，本地候选）

新增端点、授权与部署边界按 GOV-08 单列 [record activation 决定](automation-read-record-activation-design-20261001.md)，不扩大用户 A 到客户 IO 或发布。此节替代§13“全部record producer未实现”的历史状态，不改变完整SA-06范围。

owner必须显式调用record-activations，以完整输入幂等新建automatic grant和不可变activation；旧standalone grant不会自动升级。新同意固定单项目/规则版本/当前来源authority/期限/次数/预算，事件只充当触发，不提供用户身份或业务查询参数。普通submit无法使用automatic grant，撤销/历史沿既有owner门。

原durable consumer的实际delivery在同一准入事务核对真实DB事件、consumer fence/attempts/lease和取消信号，再按activation+eventId生成固定invocation，复用私有request/outbox/execution审计。候选只是元数据扫描，不授源权限；claim/checkpoint/publish各次重验完整authority及独立activation规则。仅首刀record.created/无条件/空trigger_config，普通executor拒绝不解除。普通规则腿独立尝试并去重；取消后不启动迟到普通SQL，宿主排空metadata及普通实际任务后才关闭pool。

cutover是DB已落盘行严格晚于activation，另拒绝当前语句可见、未被清理的同家族/eventId旧副本；不声称保留期外或未提交历史中的永久首次事件证明。相同已准入eventId重投仅恢复原请求，unknown不自动重读。source consumer ACK仅表示入队或无适用授权，最终预览仍看真实request七态。

135000先迁移后应用；automatic无匹配activation不能提交，用途与绑定身份不可变，有自动历史不能down。非唯一事件索引不禁止合法重复enqueue，真实部署建索引成本未实测。完整命令、首次失败、七个变异、独立复核与原始hash在CodeWT验证报告§25，上位目标§78。record PG70/70、真实认证/浏览器最终75/75；仅隔离合成PG，不是客户或完整app boot。没有外发、提交或部署。

**下一刀仍在已批准A内**：owner UI显式启用与DOM闭环，再其余record/conditions、schedule稳定occurrence、显式新预算关联retry。当前后台已接但自动启用界面未接，不宣告整个SA-06或iPaaS完成。目标继续active；真实读取、发送、发布、合并、部署仍另行授权。

## 15. SA-06W owner 显式记录授权界面（2026-10-01，本地候选）

本节替代§14“自动启用界面未接”的阶段状态，不扩大用户A授权。独立边界决定§5和CodeWT验证报告§26记录完整合同与证据。生产owner面板保留手动默认，只有明确选择record模式、合格规则、固定单项目和期限/次数/预算并勾选确认，才调用既有record-activations。仅无条件record.created可用；manual=false不阻止该独立自动同意。保存/启用普通规则不等于授权，普通测试/重跑/Executor的read拒绝继续保留。

options的recordActivationEligible在真实authority锁后派生，不作为激活或执行证明；grant purpose严格区分standalone/automatic，不从triggers推断。自动授权不可manual submit；旧standalone不会自动升级。回执不确定和POST后详情失败保留原key及完整冻结输入，仅显式同参核对；成功后新增预算要独立新确认，撤销/过期回执不显示为当前有效。账号/context/卸载清除恢复信息，晚到响应拒绝；刷新后不承诺恢复尚未取得的activationId。

实际DOM→JWT/RBAC/PG授权→真实durable记录准入→read worker→原生合成PG/planner→只读预览已跑通，业务行保持不变，webhook支路保留pending。十口实际JWT拒绝矩阵补入record-activations后全文件76/76；record PG70、ledger138、owner34、FE四文件344、CI登记286通过。四项组件内存变异精确命中、只以行为AssertionError捕获；首次无效探针与测试同步失败如实记录在§26。独立实现外只读复核无本片阻断，不是全仓安全扫描。

新旧DTO混用会fail closed，发布需同步前后端并刷新；未增加端点/迁移/flag/CI泳道，前序134000/135000先迁移约束仍在。完整provenance通过、66pin零差异，types零；web全量lint仍有父Board既有诊断，不称全仓绿。实际证据不包含客户库、SQLServer、全站boot、完整record CRUD或真实浏览器断线恢复链；丢回执的UI单元与后台PG幂等证据分别说明。

剩余：其它记录类型/条件、原schedule稳定occurrence与有限授权、显式新预算关联retry。目标仍active；不另建调度器、不自动重读unknown，无真实客户IO/发送/提交/push/PR/merge/deploy。

## 16. SA-06X 显式 cron 授权与原调度器接线（2026-10-01，本地候选）

本节替代§15“schedule稳定occurrence与有限授权未接”的阶段状态，不扩大用户A的本地开发授权。独立合同见 [schedule activation决定](automation-read-schedule-activation-design-20261001.md) §4；完整证据、首次失败、七个定点变异和26文件原始字节统一归 CodeWT验证报告§27。

新增owner `POST /schedule-activations` 仅接受 activationKey、selector、单projectNo、budget、expiresAt、maxExecutions，回执仅activationId/grantId。真实JWT tenant/null workspace、当前Connection owner ∩ live integration admin不变；同事务新建仅schedule的automatic grant和不可变activation，不消费或升级旧standalone。完整输入与owner/key幂等，不加预算、不复活撤销。record/schedule各自要求匹配的私有关联，普通submit仍不能消费automatic。

只允许无条件cron，闭合且原样绑定 expression/cron 二选一与合法timezone、规则修订及当前authority。原scheduler传首次算出的frozen UTC计划分钟，实际service callback只经宿主私有producer准入；旧规则快照、leader锁、客户端时间均不作授权。submit/claim/checkpoint/complete实时复验，旧ordinary read拒绝保留。runtime合并父级和插件取消；service同步abort并等scheduler.destroy，独立metadata admission也进入宿主pool关闭前的排空屏障。

月/年级timeout按signed-32-bit上限分段；提前回调只续挂原候选，不重新扫描更早分钟或执行consumer，旧handle不能重挂新timer。**幂等以activation为界，不是全局去重**：多份独立新同意有各自额度，同分钟可各入一条。没有补跑、成功入队前持久恢复或端到端不漏触发保证；入队成功后才沿原durable worker恢复，unknown不盲读。

136000迁移须先于代码；增加schedule独立关联及约束，不回填旧授权、保留原record链。有schedule历史时down固定拒绝，不删历史换回滚；无此历史时退回record-only约束。前端仅补schedule automatic历史DTO及查看/撤销，自动授权仍不能manual启动；现有面板仍只有manual/record模式（`apps/web/src/components/integration/stockPreparation/StockPreparationAutomationReadPanel.vue:150`），**cron启用UI及专用激活transport未交付**。

已确认schedule PG78、单位231、scheduler333、ordinary600、record70、ledger138、所选FE314、CI290均通过；66pin零差异，core/web types及所选core lint零。各套不加总为覆盖率。修正后的完整authority77/77，**加入停机排空后诊断对账的最终版本再次77/77**（136.9s），零skip/unhandled/禁止IO；七项变异细目见§27。实际JWT→真实分钟scheduler/service→runtime/原队列→native PG/planner生成有限预览且业务不变，保留原Chromium场景；不反推旧diagnostic逐条原因。临时PG已清理。未验证客户库、真实SQLServer、完整app boot、客户迁移或发布；无客户IO/发送/提交/push/PR/merge/deploy。下一刀为cron owner UI、其余触发/条件与显式新预算关联retry，完整SA-06与上位goal保持active。

## 17. SA-06Y owner 显式 cron 启用界面（2026-10-01，本地候选）

本节替代§16“cron启用UI及专用激活transport未交付”的阶段状态。生产owner面板新增cron模式及独立确认，默认仍manual；cron表达式与时区仍在原Automation编辑器配置，本面板批准的是服务端核验的当前保存cron版本，后续规则修改继续使旧授权失效。只支持无条件cron，不将interval/date_field或其它条件纳入本片。

options新增必填 `scheduleActivationEligible`，与record资格均在真实authority获取当前规则锁后派生；schedule要求精确cron类型、直接null条件、允许schedule及严格配置解析。闭合DTO要求两个boolean、各自匹配allowedTriggers且不能同时为true，不返回cron配置；资格仅供选择，不取代激活/执行重验。混版缺字段拒绝，需同步前后端与刷新。

transport沿既有独立 `schedule-activations` 接口发送闭合六字段，回执仍仅两ID，不新增API。面板冻结 `{ family, input }`，端点、回执详情匹配和显式恢复均取原命令；不确定POST或详情失败只用原key/原完整body核对。spent同意跨模式保留，再加一份独立预算需另行确认，旧授权不会因此撤销；session/context/卸载失效后的迟到结果不能回填，未承诺刷新后恢复尚未取得的回执。automatic仍不可manual启动。

界面说明过期或撤销回执不证明当前有效，默认15分钟可能不覆盖每日/月度cron且不补跑；未出现occurrence不等于执行成功。多份显式activation仍各有独立预算，不是跨activation全局去重。此前独立只读复核亲查上述冻结命令、模式/reset/迟到结果、detail家族与manual用途隔离，未发现该范围具体阻断；这是有界源码复核，不是全仓安全扫描或全部浏览器时序证明，不能消解下述尚未定位的整链失败记录。

已确认discovery **107/107**、routes **97/97**、所选FE四文件 **425/425**（transport254、panel133、authoring23、editor15）、CI登记 **290/290**；最新core/web types及所选core lint零。provenance host6/preview16，**66pin已实算零差异**。三项panel内存变异eligibility、recovery family、detail family分别以 **3/6/3个AssertionError**捕获；family首探针另出现2个TypeError，补expired/revoked用例的call-count前置断言后六个失败均为AssertionError，不将探针错误计作有效证明或声称穷举。

历史验证顺序：首次 **77/78**，仅新DOM cron报 **BROWSER_BODY_NOT_RETAINED**；随后诊断版 **78/78**（tests 237999ms，total 240.59s），曾走通实际owner DOM→201→原scheduler真实分钟→runtime与worker→原生合成PG→只读ready、业务不变及换账号/撤权/stop历史/撤销。此后修复诊断 `load.catch` 丢路由信息，以typed内部error保留诊断且不放宽断言，诊断保留版出现 **76/78**（tests 177237ms，total 179.86s）。补充候选诊断版再次 **78/78**（tests 210229ms，total 212.79s），但未复现并定位此前无queued，不能以复跑通过抹去该风险或宣称稳定性闭合。

两个失败的诊断边界保留：旧public-editor恢复options曾观察200及 `requestfailed: aborted`，但 `nativeAbortTrace=[]`、无UI error；新cron callback resolve后没有queued。runtime允许候选空集、明确typed denial或submit返回null后正常resolve，返回不等于入队。fixture已在原查询后增加固定布尔、相对时差与typed denial诊断，原返回/throw不变，无补调用、retry或放行；无queued本次未复现，具体路径及旧时刻时钟差仍未证实。

浏览器另外以实际生产client、无DB loopback复现 **200 headers→aborted→CDP missing，但页面解析成功、abort0/nav1**；保留Response强引用不足以避免该观察现象。原生clone12000次及bounded reader3000次对照为阴性，不能推成根因或根治证明。helper现仅加有界原生clone观察，原Response/CDP/DOM和零requestfailed断言不变，无retry。**最终clone版完整authority78/78通过**（tests 235479ms，total 238.03s），零skip/unhandled/禁止IO及环境文件读取，owned临时PG已清理。该版全链通过不证明旧CDP问题全部根治：clone确实改变观察生命周期；原无queued原因仍open，不宣称验收稳定性闭合。

原始命令、首次失败、有限变异与最终结果归CodeWT验证报告§28，此处不复制hash。没有新端点/迁移/flag/CI泳道，136000先迁移后代码及有历史拒绝down的边界不变。后续先收敛原无queued风险，再推进其它record/conditions、interval/date_field稳定身份和显式新预算关联retry；SA-06与上位goal保持active。本片仅本地候选，无客户IO、发送、提交/push/PR/merge/deploy；合成整链不等于完整app boot、客户/真实SQLServer、客户验收或发布。

## 18. SA-06Y 入队诊断补证（2026-10-01，范围不扩展）

本轮针对§17“runtime resolve却无queued”的证据缺口增加可重复的分支证明，不另增触发类型或放宽自动授权。三例均调用真实 `runtime.produceSchedule`，使用真实authority、ledger和owned合成PG，核对request/outbox/私有审计关联/公开执行壳的持久效果；不把observer输出或正常resolve当作入队证明，也不执行来源预览。

1. 未来minute经过真实候选查询得到零候选，正常resolve且四类持久效果均零；已过minute作为正对照可真实入队。
2. 真实候选查询完成后删除当前真实permission，执行重验产生明确authority denial；runtime正常resolve但零入队，恢复permission后同一occurrence可入队。
3. `used_executions=0`、`max_executions=1`时，首个queued request已预留唯一预算；另一minute被真实额度门拒绝，不增加request及其关联，原occurrence精确重放仍保持原request而不重复扣额。额度变异先由实际额外request断言失败，不只依赖diagnostic码。

为了隔离入队分支，三例只在owned synthetic schema内将本例activation的cutover回拨到已过时刻；临时禁用/恢复同一不可变触发器与修改同处事务，提交后核对触发器重新启用。该安排不是scheduler实际分钟或未修改cutover的证明。原有两条wall-clock链仍使用实际scheduler与真实分钟，本轮增加callback次数、同规则/相对minute和完成顺序的有限证据，不能据此倒推旧失败由多回调导致。

test-only observer读取原SQL回执，只保留固定stage、行数/布尔、数值额度、相对时差及白名单错误码；不保留标识、业务值、原SQL/参数或任意错误信息。事务数与每事务stage数均有限额和overflow标识，外层候选/denial采集也有上限。成功标签只在外层事务Promise resolve后记录；负向标签已修订为 `rejected`，只描述Promise reject并保留原throw，不能认定数据库已回滚：COMMIT丢回执时数据库可能已提交。两类标签都不代替实际持久行断言，不能把observer当独立commit证明。空候选后追加的有限metadata采样晚于原查询，不是原谓词的一致快照；observer不重试、不改返回/throw、不授予权限，更不是历史原因证据。

前版已确认 **targeted 3/3**（明确排除另外78项，非whole）及observer **52/52（原37＋新增15）**。负向标签修订后，新增COMMIT回执丢失的观察语义单元，最新observer **53/53（原37＋新增16）**，0 IO/skip/unhandled；三条真实准入再过 **3/3**，仍排除另外78项。此前future candidate guard、quota guard、runtime no-op/disconnected变异依次产生 **1/1/3个AssertionError**；不将有限变异写成穷举。此前所选types/lint零、CI登记/AST **290/290**、**66pin零差异**保留。另一代理有界只读复核曾未见具体阻断；随后发现负向标签过强并完成修订，不扩大旧复核为全仓保证。

前轮全文件 **80/81**（tests **211058ms**，total **213.76s**），0 skip/unhandled/禁止IO/环境文件读取，255个owned connections，owned临时PG已清理。唯一失败是原有plain-cron链而非新增DOM cron：正常queued及replay断言均通过，worker后status为 `outcome_unknown`、result为null。该入队后的未知结果原因待定位，不能与原先未入队混为一事；原noqueue该次未复现，也没有因此销账。此前78/78仅保留为§17历史结果，不覆盖本次80/81。

随后独立审查发现旧 `previewFailure` 只包住fixture.executor，而runtime另建executor未经过该诊断，因此旧观察为空不能证明runtime预览没有异常。当前两者已共享同一真实preview wrapper，并增加透传preview/execute/native结果诊断；不以诊断接线修补当作unknown根因修复。最终冻结诊断候选全文件 **81/81**（tests **202475ms**，total **205.05s**），0 skip/unhandled/禁止IO/环境读取，257个owned connections，owned临时PG已清理，最终所选types/lint再次零。该次未复现原resolve无queued及前轮worker后unknown，两项历史风险均仍open；不以本次整套通过宣称根治或稳定性闭合。最终三文件字节证据归CodeWT报告§29.5，本节不复制hash。

原cron无queued原因仍open：上述三条路径证明“resolve不必入队”的可达边界，没有重现并解释原失败；前轮queued后 `outcome_unknown` 同样仍待定位。后续先收敛这些风险，再扩其它触发/条件；保留clone改变观察生命周期、不能声称旧CDP问题全部根治的限制。本轮记录进展而非blocked/complete，SA-06及上位goal保持active，无客户IO、业务写入、发送、提交/push/PR/merge、发布或部署；原始执行记录与字节证据由CodeWT报告§29维护，并保留§28历史，本节不复制hash。

## 19. Producer续租与读取重验的碰撞边界（2026-10-01）

本轮技术决定：只让producer slot的SHARE读锁短暂等待普通续租，最多250ms每次锁获取，调用方更短正timeout保持不变；成功精确恢复原GUC，SQL失败保持原错误。取得锁后另起DBclock语句校验当前身份和到期，不能用等待前时钟；不改KEY SHARE，不降低对非键身份/期限写入的排斥。profiles与discovery共用该门，writer/profile/binding其余NOWAIT不变。没有新增授权或触发用途、重试、端点、DDL、开关。

真实PG已证明旧机制在一次native成功之后仅因续租持锁而55P03→unknown；修复后的短续租可成功，超时仍拒绝，等锁中stop不再读源或发布。停机本地拒绝立即生效，但既有best-effort退役可能留DB lease至自然到期；250ms不是总查询或停机上限，未实现物理SQL取消。新测试不把本地关闭误写成全部底层SQL已被取消。

限定组合3/3、profiles PG51、相关纯单元28/110/53，真实PG三种降级变异4/1/1个行为断言捕获。本轮完整文件82/84→81/84，最新未通过：截止时间fixture超时、cron无queued、record DOM零告警断言失败。cron后置DB采样为计划时间尚在未来172.885ms，其余采样谓词true；这是新的实际时钟差线索，不是原candidate快照或所有历史事件归因。不得删除future门或把unknown当成功。两条authoring的告警已实证为允许的续租55P03，改为严格对账并拒绝观察overflow，不屏蔽其他错误。完整记录、字节及有限验证归CodeWT报告§30；目标active，客户IO、发送、提交、合并、发布、部署仍不获授权。

最后两条authoring增加overflow硬门后限定复验2/2（其余82项排除）；它只验证该测试强化，不覆盖三项整链失败，也不是最终测试字节84/84。临时PG已清理；当前仍为未提交本地修订，不能据此发布。

## 20. 有界DB到点等待，不放宽自动读取授权（2026-10-01）

技术决定在既有Automation A内：runtime保留原rule/UTC分钟，在候选发现前读真实PG时钟，对≤1000ms的小正差短暂等待并重新取证到点。1000ms单调readiness预算含已观察的SQL/COMMIT延迟、最多4probe，短事务先结束再设timer；远未来或边界耗尽显式不可用。candidate/ledger两层future、原生cutover、当前actor/owner/版本、到期、预算及稳定invocation均不变。没有补跑或入队前崩溃恢复保证，不增加授权用途、读取重试、公开端点或sender。

取消和停机先关闭本地任务，清timer并继续排空已发SQL，不声称物理PG取消/1秒必返回。任务绑定入口plugin lifetime，不借用replacement；100个并发准入是内存上限，不是吞吐保证。每个caller/plugin/server取消源单监听，结束清理；上限后明确拒绝、无排队。正常暂停不会更新项目/版本/期限/次数。

新增真实PG用例以未经修改的DB-minted activation和原分钟证明提前到达→到点后一次入队、原invocation与重放、native0。旧deadline测试只修等待遗漏，不增2秒预算；record DOM只接受完整已证实的续租55P03对账，其他错误仍红。首轮完整85/85为广播前候选，最终广播冻结版完整85/85（344844ms/347.66s）亦通过，零skip/unhandled/禁止IO/环境读取、临时PG已清理；其余单元283、专用PG78、CI登记290、66pin和最终types/所选lint通过。完整结果、两项独立只读复核及非阻断补证点见CodeWT报告§31，有限变异不冒充穷举。旧缺现场事件不因本轮机制或局部绿全部销账。上位目标active，客户IO、发送、提交/合并/发布/部署仍不获授权。

## 21. 明确授权更新事件与确认版本（2026-10-01）

在已批准A的记录触发范围内交付无条件record.updated，仍固定单项目、owner/admin、期限、次数、配置版本与只读预算。真实payload是patch且零字段也可能发事件；不借普通条件引擎的兼容降级来准许只读源IO。candidate及submit都精确匹配DB event_type与原nonce规则；旧created/standalone不升级，普通EventBus/Test/executor不获得read能力。

新增类型后，旧六字段确认不能排除options之后规则被改型。最终record输入增加expectedRuleRevision作为并发前置条件而非权限：在真正规则锁内且新grant INSERT前校验，变化或ABA返回409；同key只匹配原activation revision并恢复旧pair，不重授或换预算。schedule保留六字段。严格options同步返回type/revision，面板默认manual、明确显示原确认类型，历史只诚实显示record家族。GOV-08详细决定见record activation设计§6。

137000只替换closed admission，不改135/136、不重写历史；有任何record历史的down拒绝。最终真实authority/native/Chromium87/87，record PG94/94、schedule PG78/78、FE493/493通过，三个单守卫降级3/3/1条行为断言捕获；独立复核修订版无新增阻断。详情、字节、旧父页lint基线与组合测试真实范围见CodeWT报告§32。没有客户IO、外发、业务写、提交、合并、发布或部署；完整目标active，下一步仍按原范围推进字段条件、其他触发与显式关联retry。

## 22. 严格条件求值前置，不开放条件读取（2026-10-01）

本地新增复用原比较器的严格条件基础，147/147条件测试、195/195普通回归和定向静态检查通过；三项内存降级有行为失败，独立复核无新增阻断。其不读取源、不批准配置、不创建grant，也未进入生产调用链。conditions=null门保持。不能以“单元验证通过”代替条件自动读取已交付。

record ADR §7明确下一片要保存与outbox同事务关联的私有实际记录结果；公开patch、规范化前grid输入与消费时最新记录均不能充当当次可信after-image。真实生产者覆盖、私有存储上限/生命周期、稀疏空值语义和当前字段权限/版本接线尚待完成；不新增客户读取或外部发送授权。完整goal仍active，详细证据见CodeWT报告§33。

## 23. 私有记录证据基础落地，权限准入不扩张（2026-10-01）

SA-06AB在本地补实际REST/grid写事务→真实outbox receipt→私有原始快照，限定字节/结构/批次、保证PG数值原文不舍入、UPDATE拒绝及父删除级联。真实PG34/34与有限降级证明生产接线；不改公开payload，不把patch/当前行当事件证据，未提供HTTP/JWT或完整条件授权链。record ADR §8及CodeWT验证报告§34记录具体合同和实际覆盖。

新增138000须先迁移后上producer；本轮只验证自有临时PG，没有生产迁移。Automation/FWB/recovery未接快照，schema-at-write、当前字段权限、稀疏空值定义与自动生命周期仍未完成，conditions=null门保持。该基础不授予用户或插件读取私有正文、不产生新grant/执行能力，不放开客户来源IO或宜搭sender。完整goal继续active。

## 24. 写前版本绑定，不新增读取许可（2026-10-01）

SA-06AC复用已有sheet epoch，用真实REST/grid写前捕获、事务私有token和持久化复验，补充可选schema_revision。锁竞争/回滚失锁/自身schema变化不补采；139000当前nonce校验不冒称任意DB写者的来源防伪。record ADR §9规定表级锁可用性取舍、迁移先于代码、有历史拒绝down以及后续权限/准入锁序。

最终实际PG48/48、专用129/129、保存165/165及其它定向回归/静态通过，五种有限降级有行为失败；完整证据与字节在CodeWT报告§35。本轮仍不开放条件准入、不新增端点/授权/flag，不授予客户读取或外部发送。当前条件字段read权限、历史快照准入、owner确认和生命周期待交付；目标active，没有提交、合并、发布或部署。

## 25. 私有条件准备及求值边界（2026-10-01）

SA-06AD在实际authority上增加显式条件准备与同事务求值；不改变原AutomationReadAuthorityPort/公开七字段proof、不向plugin预览传条件数据，不开放activation/discovery/ledger/DB的null-only门。先完整原授权后验证条件所有引用字段，复用共享权限代码及严格引擎；schema/rule nonce和最终profile必须对齐。求值前再次实际查read权限，避免同txn或savepoint退锁后复用旧权限。SQL错误不归为no_match。

实际父outbox和私有image严格同身份/字段版本，仅对依赖原保存值求值；高精度原JSONB与JS重编码比较、numeric string数学往返、显式缺失/空值语义都有本地证据。WeakMap context只属于同factory/handle/DB xid，不能克隆后当原证明；match结果不授权来源IO。新增文本传输有界不等于既有raw-rule读取全局有界。详细决定见record ADR §10，验证与局限见CodeWT报告§36。

尚未交付条件owner确认、不可变准入记录、自动消费者接线或保留期管理。没有新增公开端点、DDL、flag、CI泳道或发布动作；受控只读A的原owner/admin、版本、期限、次数及不写/不发送约束不变。完整目标仍active。

## 26. SA-06AE：条件记录自动准入与有限生命周期（2026-10-01）

本节更新 §25 的阶段状态：实际 `record.created` / `record.updated` 自动入口已接已保存条件、owner 确认和 ledger/runtime，仍复用现有只读 action 与 durable 消费链，不新增调度器或写入能力。options 的 record 可启用状态必须来自真实 record authority 准备；公开描述仅为 `{mode:'unconditional'}` 或 `{mode:'saved_conditions',schemaRevision,businessTimeZone}`，不输出 AST、常量、字段值或私有指纹。必需元数据缺失、数据库/锁错误不能伪装成正常不命中或可启用状态。默认 manual 与原 owner/admin 门不变，schedule 仍是原六字段无条件 cron 合同。

record POST 严格接收八字段：`activationKey`、`expectedRuleRevision`、`expectedRecordCondition`、`selector`、`projectNo`、`budget`、`expiresAt`、`maxExecutions`。前端确认事件类型和条件模式，说明仅以该事件的私有保存后快照求值，缺失或不可读不触发、不回读当前行。规则/解释描述变化须重新确认；不确定回执仅按原 family/key/完整请求恢复，不重采当前 options、不换版本或叠加预算。历史授权不从当前 options 推断含义。版本和描述只是实际服务端授权之外的并发前置，不能由用户选择策略来扩大读取许可。

record authority 使用本实例登记的 original proof；描述与求值 context 不接受普通 proof、结构复制或普通 key 回退。初始激活完成验证后，执行路径在 submit、claim、每次 checkpoint、complete 四阶段继续重验当前权限及规则/解释版本。submit 先完成当前授权、实际事件租约/切换点验证，再查一致的既有 invocation；仅首次准入才在所有额度/request/audit/read-outbox 写入前求值原事件证据。match 才入队；no_match/unreadable 无额度或来源读取副作用，SQL/锁异常进入既有错误/重试路径而不是静默 ACK。既有请求重放复用原结果，不因快照清理而重新求值或增加预算；未准入负结果没有新增永久去重账本。

after-image retention 已由既有 dispatcher tick 驱动：实际数据库时间超过七天，且源 `automation-record-trigger` 消费者 done，才可清理私有 image；单次最多 200 条、进程内每十五分钟最多一次尝试（失败也计时）、在途合并，stop 关闭入口并排空已开始任务。不删除父 outbox、消费者或切换点历史。未完成/死信/缺消费者证据继续保留；停机、开关关闭、失败不承诺硬容量上限或严格七天到期删除。未覆盖的 Automation/FWB/approval/recovery producer 仍因证据缺失拒绝条件读取，不补读最新记录。

新增 `140000` 必须先于新代码部署，沿用 130000/138000/139000 前置；不可变 `activation.condition_confirmation` 保存原确认，旧 NULL-only 授权明确标 unconditional，不能借当前规则重解释历史。有保留 record 授权历史时 down 拒绝。此轮 record 的七字段→八字段及 options 新必填描述是前后端协议不兼容变更：旧 POST、新旧严格 DTO 解析都会拒绝缺失/额外字段，需协调更新前后端并刷新客户端，不提供猜测式兼容回退。

最终补记（2026-10-02）：实际authority/native/JWT/Chromium整文件 **104/104**，独立record activation PG **119/119**、retention PG **15/15**；五项有限内存变异被行为断言捕获，不是穷举。条件DOM的事件是实际DML＋schema/snapshot helper，不是HTTP记录写端点；原producer证据为实际RecordService方法直调，两套不能合称HTTP端到端。具体合同见record ADR §11.1，首次103/104的时序fixture失败及修正、最终命令与19项冻结字节见CodeWT报告§37。当前仍仅本地合成验证，无真实客户读取、业务写入、外部发送、提交、合并、发布或部署，完整目标仍 active。

## 27. SA-06AF：HTTP 写入口与条件预览同链验收进度（2026-10-02）

新增一例真实 `POST /api/multitable/records` → 实际 JWT/权限门 → `RecordService`/真实事务 → revision/outbox/私有 image → owner 条件消费者 → native 只读预览的同链验证，补 §26 的 HTTP 写入口证据缺口。HTTP 写请求来自夹具客户端，owner 同意和结果查看是真实 DOM；这不是完整业务记录编辑器或整应用启动验收。写负例为未认证 **401**，不冒称已覆盖无权限身份 **403**。业务基线比较覆盖全量 `id/sheet/data/version/actor/timestamps`，用于检查预览没有额外改写合成业务记录，不以单纯数量不变代替。

另增真实关闭竞态用例：原 `createRecord` 已实际提交后暂扣返回，证明 socket 关闭后仍须等待真实 handler Promise 完成，再恢复数据库转发。夹具保留原 JWT/RBAC/事务与 handler 调用，递归观察真实 Express layers；关闭先挡新 handler，继而排空已进入 handler，包括提交后的路由读取。该保证不涵盖生产主动 detached 的后台任务，也不是生产运行时新增停机逻辑。

本轮受测代码只有两个测试文件变化，另更新本地包装器和伴随文档；无生产端点、权限、DDL、flag、pin 或泳道新增。两例限定 **2/2** 后，未变异整文件实际authority/native/JWT/Chromium **106/106** 通过（tests418538ms、total421.43s），0skip/unhandled/禁止连接/环境文件读取，临时PG已移除。`http-record-no-drain`、`image-unwired`、`record-condition-admit` 三个单点内存变异各被一条真实行为 `AssertionError` 捕获，安全清理零越界；每个变异仅选两例、另104例刻意排除，不是穷举。核心类型/所选lint零，CI登记328/328、66pin零差异及实际provenance/host6/preview16通过。具体边界见 record ADR §11.2，完整命令和原始hash归CodeWT验证报告§38；不冒称远端CI或完整应用验收。

仍只在本地合成环境开发与验证，没有真实客户读取/写入、宜搭等外部发送、提交、合并、发布或部署；八字段确认、140000 先部署与前后端协议不兼容要求不变。此处仅追加代码伴随验证进度，不新增设计决定，完整目标继续 active。

## 28. SA-06AG：interval 明确确认与固定相位（2026-10-02）

在已批准 Automation A 与 GOV-08 的本地实施范围内，本片将有限 schedule 授权扩为无条件 `schedule.cron` / `schedule.interval`，不新建授权端点、不增加用户或插件权限，不开放 `date_field` 或定时条件。owner 面板仍默认 manual，规则保存不等于授权；自动授权仍绑定 Connection owner/admin、固定项目、期限、次数与读取预算，不授手动执行，不写业务表或外发。原 record 八字段确认合同保持。

冻结的 options 合同新增必填 `scheduleRuleRevision` 与 `scheduleDefinition`：仅 schedule eligible 时二者非 null，且与 record eligibility 互斥。cron 描述保留精确 `expression` XOR `cron` 及可选合法时区，不猜测或改写配置；interval 描述仅有 `triggerType`、`intervalMs`、`anchorMs`，毫秒间隔为整数 1000..2147483647，anchor 为有效日期范围内的正安全整数。前端只作闭合语法/范围/时区验证，不计算或证明实际可执行 occurrence。

interval 的固定相位 `A` 是规则创建时间向下取整到毫秒，计划时点为 `A+nI`、`n≥1`，仅取授权后严格后续时点；不是点击后重新计时，首次等待可能短于完整间隔，不补跑。界面展示精确毫秒间隔、anchor 毫秒值及 ISO 时间，并提示期限内可能没有匹配时点。schedule POST 从六字段变为七字段：原 `activationKey/selector/projectNo/budget/expiresAt/maxExecutions` 加必填 `expectedRuleRevision`；不接受客户端自报 type/config/anchor。服务端负责真实锁内版本及创建时间身份校验，前端字段不是授权证据。

本地前端实现已把 revision、类型和精确配置变化接到同步清确认（含 ABA）；未确认回执冻结原 family/key/完整七字段及显示描述，恢复不重新发现版本、换 key、改相位或叠加预算。成功回执沿用原确认描述，历史 grant 仍只称“定时自动授权”，不从当前 options 推断历史 cron/interval。旧六字段请求及缺少新必填 options 字段的混合版本会拒绝，前后端须协调升级、刷新客户端；不提供静默兼容回退。

部署与回滚约束：本片新增 `zzzz20261001141000_automation_read_interval_schedule_activation.ts`，不修改既有136000迁移；部署顺序为140000后执行141000，再上线使用新列的代码，并同步升级 schedule 六→七字段的前后端。141000给存量 cron 授权增加默认 `trigger_type='schedule.cron'` 与 NULL `interval_anchor_ms`，不改其原有身份/预算；新判别 union 的整体 CHECK 使用 `IS TRUE`，不能因 SQL NULL 获得放行。`down` 先检查保留历史，任何非 cron 类型或非 NULL 相位均以 `AUTOMATION_READ_INTERVAL_SCHEDULE_HAS_HISTORY` 拒绝；存在 interval 授权历史时不能以删除历史或强制降级作为回滚步骤。只有该历史检查通过，才恢复原 cron admission/shape 并移除新列；迁移通过不等于运行时权限或真实客户读取获准。

当前隔离前端验证为 transport **383/383**、owner panel **201/201**，共 **584/584**，0skip/unhandled/禁止连接/环境文件读取。首跑两项新 fixture 因先切换模式使后续输入 DOM 消失而失败，调整测试操作顺序后通过，未放宽生产守卫。此证据是实际组件 DOM 与假 service/HTTP transport 单元边界，不能替代真实 JWT/PG/scheduler/来源读取同链。

根线程已取得的后端与限定链证据分别记录如下，不合并为一次整文件运行：

- 此前专用 PG suite **126/126** 通过。三项 DB 单守卫变异分别得到 **125 pass / 1 expected fail**；host-clock 单元变异得到 **329 pass / 1 expected fail**。这些是各自基线及预期致红证据，不是后续完整108项的结果。
- 较早 interval 诊断版限定两例 **2/2** 通过，保留为历史有限证据。“新建规则后不重载”的用例经过真实 service/Kysely 保存，不是 HTTP 创建证据；另一 DOM 用例经过真实 Editor/client 的 POST/GET/PATCH 后 reload，再进入 owner 同意与执行链。两种入口不可互相替称，也不是完整应用导航启动验收。
- 测试观察器的 candidate SQL matcher 已跟随实际四列投影 `a.id/a.cron_config/a.trigger_type/a.interval_anchor_ms` 修正。它只识别真实候选查询以记录诊断，不代替实际查询、候选结果或授权；旧 matcher 未命中不能被写成“生产没有候选”的证据。第一轮完整运行为 **107/108**（tests 363340ms / total 366.06s），失败于旧 cron 用例的空候选附加诊断 SQL：只使用两个参数，却透传生产查询的三个参数。随后已改为显式两个参数，并补真实 empty 候选观察断言。
- 上述窄 fixture 修复后，第二轮完整运行为 **107/108**（tests 465085ms / total 467.82s）：旧 cron 用例通过，唯一失败为 DOM interval 的 clock-readiness 拒绝。该轮未有完整现场，不以后续诊断倒推其原因。
- 新增 test-only 诊断后的限定两例为 **1/2**（tests 23379ms / total 26.14s，另106项刻意排除）。本次失败现场为 elapsed **3.7478ms**、hostLate **18ms**、`clockReadiness=[1159.528076171875]`；signal 未 abort、无 SQL 失败，candidate/queue/native 均为零。这些现场支持的结论仅是：**本次 planned 时点比实际 PG 时钟超前超过1000ms，触发既有时间门**；不是1501ms周期与1000ms门限相互冲突，也不证明跨 Windows/WSL/Docker/PG 的全局时钟根因已经确定或修复。

**本节历史收尾状态：完整验收未闭合；后续进度见§29。** 保留生产1秒/最多4次探测及拒绝未来发生时点的门，不改全局时间、不重试凑绿；该轮尚未准备同机隔离环境，本地临时实例的后续验证见§29，不涉及系统时钟变更。禁止将较早两例2/2、专用126/126或本次限定诊断写成完整108整链通过。该轮受控临时 PG 已清理；未发生真实客户读取、外部发送、提交、合并、发布或部署，完整目标仍 active。

## 29. SA-06AH：原生同钟隔离环境的诊断验收（2026-10-02）

本片只调整本地合成验收环境，让 Windows Node 与原生 PostgreSQL 使用同一宿主时钟，不修改生产代码、1秒/最多4次 clock-readiness 门限、定时器或 occurrence 语义。使用官方分发的便携 PostgreSQL **14.24** ZIP，本地 SHA256 为 `8d5b5aef56848dbd0562e5e02d613eb5cbc7d97cae10b290cbfdabf1b4969088`；此哈希仅作为本地可复现材料标识，**不是厂商数字签名验证**。

验收使用本轮拥有的 Windows 原生**磁盘集群（不是 tmpfs）**，仅 loopback、SCRAM，随机一次性口令与端口；不安装 Windows 服务、不更改全局时钟，不接客户或共享数据库。采样、专用、限定及下述完整运行均已结束，并成功清理自身集群。

已取得的证据分开记录：

- 原生 PG14.24 时钟采样 **100次**：观测括区间下界范围 **-2.152..-0.226ms**、上界范围 **-1.152..-0.121ms**，最大 RTT **2ms**。这只是该环境该批采样的时间一致性证据，不宣称所有宿主/虚拟机时钟完全相等或旧跨环境问题已被全局修复。
- 原生 schedule PG **126/126**（tests **9775ms** / total **11.04s**），**6** 个本轮拥有的连接，无禁止 IO，清理成功。它与§28旧环境的126/126是两次独立运行。
- 原生 interval 限定两例 **2/2**（共108 collected、另106项刻意排除；tests **23530ms** / total **26.33s**），**34** 个本轮拥有的连接，unhandled **0**、禁止 IO **0**，清理成功。入口边界仍按§28：新建不重载用例是 service/Kysely；DOM用例才经过真实 Editor/client POST/GET/PATCH 后 reload，不冒称完整业务编辑器导航验收。
- 原生完整套件 **107/108**（tests **334945ms** / total **337.68s**），**405** 个本轮拥有的连接，skip/unhandled/禁止 IO/环境文件读取均为 **0**，清理成功。两个 interval 用例均通过；唯一失败是既有真实 PG PLM 预览用例，期望 `succeeded`、实际 `outcome_unknown`。固定诊断为 `previewFailure=AUTOMATION_PREVIEW_UNAVAILABLE`、Entered **1**、Returned **0**、nativeQueries **56** / succeeded **56** / failed **0**。这些计数和固定错误码不等于根因说明，也不能仅因原生查询无失败就把整体预览记为成功。
- 追加有界 test-only 诊断后，原生限定两例 **2/2**（另106项刻意排除；tests **13618ms** / total **16.61s**），**8** 个本轮拥有的连接。它是完整复跑之前的限定证据，不与较早 interval 两例混为同一次运行。诊断绑定原 ledger、原回执，原样转发返回结果和错误，不替换执行结果、不改变生产行为。
- 随后的冻结诊断版原生完整套件 **108/108**，exit **0**（tests **327372ms** / total **330.20s**），**404** 个本轮拥有的连接，skip/unhandled/禁止连接/环境文件读取均为 **0**；原生 PG 已成功清理。两条正向用例**各自**的204个 checkpoint 均返回、62次 native 查询均成功，这些不是两例合计。这证明该冻结诊断版本次完整运行通过，**不是上述首次原生107/108失败已修复的证据**。

**当前结论：完整108/108的有效诊断证据已经取得；稳健性调查仍 open，不能据此宣称稳定、发布就绪、生产验收或完整目标完成。** 首次原生完整107/108中的预览失败仍未解释，不能将未复现等同已修复。§28的两轮107/108及限定1/2全部保留；新环境成功不反向归因缺少现场的旧失败，也不靠放宽时间门或改写发生时点凑绿。date_field、其它记录触发/生产者、新预算重试等剩余目标不因环境验收缩掉。未进行真实客户读取、外部发送、提交、合并、发布或部署，完整目标保持 active。

## 30. SA06AI 手动关联retry首片（2026-10-02）

具体新端点/授权边界依[独立GOV-08关联重试决策](automation-read-linked-retry-decision-20261002.md)，不是用本续篇替代决策。manual四类未成功终态可由原Connection当前owner/admin显式确认新预算；source/authority版本仍一致、每父一子、旧请求和次数不改、同key只恢复原尝试，普通submit不能复用retry grant。GET context独立management只观察，POST包括回执恢复必须有在线runtime；自动record/schedule失败暂不转manual。

首次实际链确认现有B2a一次性围栏会拒绝消耗唯一来源登记后的child，ledger预算不能替代来源授权。生产围栏不改；合成正控明确预置两份独立一次登记，负控一份耗尽证明额外native为0。真实客户第二次源操作仍需单独授权。UI/文档清楚说明202只表示登记，不保证来源可以执行。

142000须先于新代码上线，有retry历史down拒绝。新增PG整文件登记到既有EXPECT_DB命令而非另造泳道，workflow实际pin重算。本轮local unit249、FE705、专用PG25与限定实际native/HTTP/DOM7通过；四项内存降级各被实际行为断言杀死。随后完整112/112（tests335493ms/total338.20s）通过，无skip/unhandled/禁止IO，临时PG清理；旧账本整套精确context断言修订后138/138，首败仍记录。正确范围core类型/所选lint、web类型、CI登记330及实际provenance/66pin通过。父页面既有lint与缺PyYAML的运维契约检查不报绿，详情归CodeWT报告§41。历史稳定性未归因项保留。目标仍active，无真实客户IO、发送、提交、发布、合并或部署。

## 31. SA06AJ 普通记录生产者覆盖扩展（2026-10-02）

按[记录触发决策§12](automation-read-record-activation-design-20261001.md#12-sa06aj-普通-automation-createupdate-的可信事件)及目标§95，普通create_record/update_record在原写事务中保存可信schema与真实RETURNING image。旧§26所述Automation未覆盖状态，仅这两种普通动作已被本片替代；resultWriteback、FWB/approval/recovery仍未覆盖。原Connection owner/admin授权、条件准入与只读执行各阶段重验不变，没有新端点/DDL/flag。

PG98/98及限定实际链4/4、回归347/165通过，四个单点内存降级被行为断言捕获；最终冻结版完整114/114通过，0skip/unhandled/禁止IO，临时PG已清理，详细结果归CodeWT报告§42。producer从公开executor直接进入，不宣称普通规则HTTP调度整链；预览只返状态/计数且canApply=false，业务全量快照不变。类型/所选lint及provenance/66pin通过不抵销历史稳定性、基线lint或PyYAML前置。仅本地合成验证，未发布或接触客户数据。

## 32. SA06AK 审批回写来源覆盖（2026-10-02）

按[记录触发决策§13](automation-read-record-activation-design-20261001.md#13-sa06ak-审批-resultwriteback-可信事件)和目标§96，原resultWriteback在同一受管事务提供真实完整RETURNING image及DML前schema证据。新增下游只读端口权限、预算和owner确认不变；原审批写入权限不由read grant赋予。回写失败可留backwriteSkipped而审批继续成功，bridge重投不自动补写，不把局部事务原子性说成全审批exactly-once。

专用PG6/6、限定authority5/5与三项内存降级已有真实证据；完整冻结114/115，新增审批链通过，唯一旧来源checkpoint拒绝仍未归因，不能报整套通过或稳定性关闭。0skip/unhandled/禁止IO、临时PG清理，7项hash无变化；下一步先补固定阶段的test-only脱敏诊断，不改生产拒绝码或放门。实链审批由公开生产方法进入而非审批DOM/HTTP，owner确认/查询使用真实HTTP，来源仅owned合成PG。完整命令和hash边界归CodeWT报告§43。无新端点/角色/DDL/flag/CI泳道，未覆盖producer与其它上位待办保持；没有客户IO/发送、提交、发布、合并或部署。

## 33. SA06AM / SA06AP FWB两种既有来源覆盖（2026-10-02）

接记录触发决策§14，原FWB create及update在既有合法写事务内保存真实数据库image，目标§98和§101分别记录证据。update捕获的是server派生的目标sheet，而不是规则sheet；仍保留原跨表权限/记录锁/审批不可变快照/业务去重与OFF合同。同一个事务对象完成capture和image保存，revision完整snapshot不因有界私有image改变语义。

新增只读端口的Connection owner/admin交集、有限项目/版本/期限/次数/预算和canApply=false均不变，没有获得审批写权限。专用PG9和真实owner确认→持久审批/记录消费→native预览1例验证本地同base跨sheet；不声称完整宿主/审批UI或客户验收。有限降级、完整120终态、历史未归因项和冻结由CodeWT报告§48统一维护。其它producer、自动请求retry/date_field仍需推进；没有新的公开协议、迁移、flag或客户/发送/发布授权。

## 34. SA06AQ 恢复来源证据首片（2026-10-02）

接记录触发决策§15，既有revert共享执行点补同事务实际RETURNING image，生产事件不附私有材料；不增加恢复写权、业务事件或复活路径。当前验收为archive sync公共服务方法→真实权限/事务/事件→私有image条件原语，专用PG8/8、六项有限降级及无DB163/163；不是恢复HTTP→owner grant→runtime/native整链，更不能代替hot/async各入口新增image证明。

新PG整文件接既有实库CI命令，workflow pin按实际模块重算；无新泳道、未远端执行。旧恢复158例的环境失败、诊断和冻结统一见CodeWT报告§49，不宣称全部回归通过。本端口当前授权、额度/来源一次性许可及无业务写/无apply token合同不变；自动retry/date_field及原目标不缩减，客户读取、外发、合并、发布、部署仍单独授权。

## 35. SA06AR 恢复入口验证续篇（2026-10-02）

记录触发设计§16、目标§103补hot实际HTTP到owner授权native只读预览链，以及async真实5001计划首5000 chunk的image证据。只增加验证，没有新生产端口、授权或自动重试；普通恢复仍须原写权限，下游仍canApply=false且业务快照不变。async的256-image预算外拒条件准入，不由live行补值；首chunk和canonical afterCommit返回不等于整job/derived全部完成。

专用PG11、hot限定1、五项有限降级及完整121/最终静态/provenance的具体终态统一见CodeWT报告§50。Windows旧恢复失败及历史未归因项保留，不拿有限新链或上一片完整120代替当前回归。自动retry/date_field仍非完成项；真实客户读取、发送、合并、发布、部署仍另行授权。

## 36. SA06AS 日期字段只读激活（2026-10-02）

日期触发的独立决策见`automation-read-date-field-activation-decision-20261002.md`。沿用本端口、原调度器和owner控制，新增明确日期确认及私有逐记录occurrence关联，不沿用旧cron/interval授权。固定项目、每记录一次额度、有限扫描、当前字段/完整读权限、严格cutover及每checkpoint授权不变；queued后的日期值变化不改写已接受事件。没有新增手动业务写或自动retry。

本片代码与最终本地验证归CodeWT报告§51：完整authority122、日期PG16、旧schedulePG126、unit649与前端807分别通过，有限六项降级被拒绝；不是远端CI或发布。新143000迁移先于代码，日期历史存在时拒down。真实HTTP→scheduler→native合成链和日期面板jsdom分开举证，日期面板Chromium同链尚未完成，不冒称完整浏览器部署链。旧未归因项、前端基线lint与真实客户/外发/合并/部署授权边界继续保留。

后续SA06AT已补上前段当时未完成的日期owner面板Chromium同链，见目标§105及CodeWT报告§52：冻结版完整123/123、零跳过，精确确认→真实scheduler/私有receipt/队列→原生合成预览，业务完整快照不变。仅测试/helper/本地runner调整，不修改端口权限或生产代码；最终静态/provenance/66pin通过，PG清理。不是整应用登录/导航或日期编辑器DOM验收，不能据此消除旧未归因项、平台待办或取得客户/发送/部署授权。
