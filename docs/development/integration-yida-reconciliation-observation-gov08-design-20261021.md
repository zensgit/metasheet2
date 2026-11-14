# 宜搭人工核验事实持久化：GOV-08 本地决策说明

日期：2026-10-21（Asia/Singapore）。状态：**Owner 已批准先独立提交、推送本 GOV-08 文档并开文档 PR，再将已验证补丁及验证 MD 普通追加至既有草稿 #6337，运行既有合成 CI。真实UI追加/更正/回读、201丢回执后同标签页整页刷新恢复，以及旧四操作/历史宿主搭配新表的定向兼容均已通过本地验证；最终候选原71项与独立新增15项通过既有运行器本地复验。本地结果不替代新 head 正式 CI，不承诺完整旧应用一键降级。**

关联：既有 #6337、SA-06D 独立决策 #6462。本说明补足“人工核验事实追加保存”的合同，不新开功能线、不改原目标、不扩大到自动对账或重新发送。最新发布授权仅覆盖上述独立文档 PR、既有草稿普通追加及既有合成 CI；不强推、不合并、不部署、不读取客户数据、不真实发送。迁移仅在新建、隔离的合成 PG 中执行。此前仅文档及本地实施授权的历史记录保留在既有验证 MD；以下原建议由第10节具体化，不把旧设计文字或发布授权当作已经部署。

## 1. 已核事实与缺口

### 本轮模型分工（2026-10-21，本地增量）

- 主代理负责真实路径复现、最小修复、测试整合和验收结论；不把子代理意见或模型名称当测试证据。
- Grok Build 已按 `--model grok-4.7` 建立实际会话，CLI 1.0.62 的会话界面显示 `Grok 4.7 (xhigh)`，并已执行指定源码读取。分配只读的前端命令恢复、账号切换、旧响应与人工确认审查。xhigh 是本次可观察到的 CLI 配置，未宣称通过 bridge 调整了不存在的 effort 参数，也未取得独立服务端模型证明。
- Astra ultra 负责高风险后端只读反驳：实时权限、同事务归属、只追加审计、未知结果、原额度/串行位/防重不变。与 Grok 的文件责任不同，均不写文件、不运行客户操作。
- 简单断言与文档由主代理直接处理，本轮不为机械工作额外启动模型。模型审查结果须经主代理验证；具体发现、修复与实跑结果续记既有验证 MD。

以上仅改变本地工作分工，不扩大 #6337 的功能、发布或外部访问授权。

实现基线：`f6a9847f5e877138a5e2ad24bf7c4a6766496183`。以下路径/行号均绑定该提交。

| 来源 | 实际事实 |
| --- | --- |
| `packages/core-backend/src/routes/integration-yida-automation.ts:14–18、155、173–198` | 仅create/inspect/revoke/requestManual四项操作；`:101–105`的observation是历史DTO投影，不是人工核验记录写入。 |
| `packages/core-backend/src/integration/yida-automation-authorization-service.ts:66–79、97–98` | 历史查看仍在真实事务中检查当前身份权限，不以授权仍有效或发送开关开启为前置。 |
| `packages/core-backend/src/integration/yida-automation-authorization-store.ts:134–177` | 按tenant、owner、null workspace查询grant/request/admission/ledger，展示原发送事实及serialBlocked。 |
| `packages/core-backend/src/integration/yida-automation-execution-authority.ts:409–429` | 原ACK与关闭request/释放active指针同事务；unknown不释放串行位、不退款。`closed_observed`在这里表示原ACK路径，不是人工复核。 |
| `plugins/plugin-integration-core/lib/yida-readback-observation.mjs:4–5、97–105` | 对给定观测进行纯比较，historyVerified/businessVerified=false、canRetry=false；不取远端数据或保存核验事实。 |

#6462 决策提交 `0da3ee27ffd4d719c5921dff36571b45cb150808` 的 `docs/development/integration-sa06d-yida-automation-authorization-gov08-design-20261019.md:275、324` 已列入追加核验事实。当前保守阻断和历史查看不等于该项已完成。已通过的71项、Chrome初始化及两行预览继续成立，不能代签本新增合同。

## 2. 决策建议与非目标

推荐采用**人工声明、只追加、无执行能力**的核验记录：把“核验者在何时依据哪份证据记录了什么结论”与“系统当时发送/收到/持久化了什么”分开保存和展示。

- 首版只关联SA-06D已存在的grant→request→admission→delivery ledger完整链；不是跨租户通用审计平台，也不顺带扩展人工单次发送链。
- 原文档阶段只拟定“追加核验记录”和“查看核验记录”两个逻辑操作；批准后的具体HTTP路径见第10节。不改变现有四个操作的参数或权限，不在GET中藏写入、不复用revoke/request写入核验事实。
- 不生成token、调用宜搭、接收任意远端URL、下载证据、导入业务行或改变默认开关。不新增发送消费者、后台自动核验、UPDATE/DELETE外部记录、补偿写入或盲重试。
- 不承诺exactly-once、远端最终一致性、证据真实性或“取消就没发出”。需要远端读取/真实材料时另行取得owner授权。

## 3. 权限与可信作用域

建议新增操作的权限合同如下，均由服务端强制，不能只限制按钮：

1. 真实登录JWT身份，tenant只取`authenticatedTenantId`，actor只取可信认证主体。拒绝请求头/body/query中自报或切换tenant/owner/workspace的载体；不以旧`user.tenantId`回填作为可信来源。
2. 复用`assertAutomationIntegrationActor`的实时用户有效性、tenant membership和既有集成管理员权限判定（`automation-live-authority.ts:62–165`）。其中已有平台admin/role:admin规则仍仅是**权限条件**，不能跳过下项所有权。通配权限、缓存结果或客户端admin布尔值均不代替原合同，不新增角色/权限码或全局豁免。
3. 操作者必须等于原grant记录的owner；workspace首版必须为null。通过锁定的原grant取得作用域，再沿实际外键验证request/admission/ledger均属于同一链；body中的引用仅是查找输入，不是归属证明。外租户、同租户其他owner、非owner管理员、拼接另一授权的ledger均拒绝且不泄露其存在。
4. 服务账号、普通worker、跨插件能力及代理身份不能提交“人工核验”。首版不支持转交核验权；原owner停用/离开tenant或失去权限后不能继续操作，也不自动由新连接owner接管历史。此类历史保全后的交接需另行决策，不绕过owner检查救急。
5. 过期、撤销、重启后stale授权仍可由上述合法主体查看/追加历史事实；不要求旧发送授权可执行、当前源/凭据仍有效或发送闸开启。历史访问应有独立受权路径，不调用发送live authority获取permit。若应用/历史服务本身不可用，则失败，不允许旁路直写。
6. 每次读取/追加都重验权限。身份检查、关联锁、幂等检查和追加提交在同一事务中按固定锁序进行，沿用真实权限行锁的保证范围；不承诺事务提交之后持续授权，更不把权限已撤销的未知提交当作允许继续写入。

## 4. 追加记录内容与证据边界

以下是批准的逻辑模型；本地表名及迁移选择见第10节。DDL只在隔离合成PG中验证，不执行部署迁移。

| 字段组 | 建议合同 |
| --- | --- |
| 归属与关联 | 服务端从历史链派生tenant、owner、workspace=null、grant/request/admission/ledger引用；服务端生成记录ID及每ledger递增序号。 |
| 作者与时间 | 作者来自认证；recordedAt使用DB时间。人工声称的观察时间另存为可选claimedObservedAt，仅是声明，不作为授权期限或发送顺序证明。排序使用序号，不依赖墙钟单调。 |
| 核验声明 | 闭集`observed_match`、`observed_mismatch`、`inconclusive`；固定reason code。标签必须为“人工记录：观察一致/不一致/未能判定”，不能显示“系统证明发送成功”。 |
| 证据摘要 | 固定格式SHA256声明、证据类型枚举、受界不透明证据引用；不接收任意URL/path、原HTTP响应、业务字段、token、凭据或自由文本。摘要由核验者提供时必须标为operator-supplied，不冒充服务端对原始证据重算。 |
| 幂等与内容摘要 | 稳定客户端命令键；服务端对允许字段规范化计算内容摘要，用于重复请求比较，不代表证据真实性。摘要不是授权秘密或访问凭据。 |
| 更正关系 | 可选supersedesObservationId，仅能指同一归属/ledger的旧记录；追加新记录而非修改/删除旧记录。保留前后内容与作者，不因更正覆盖原发送事实。 |

证据原件不在本操作中上传/获取。引用不得成为自动解引用能力；首版仅作为人工声明的受控线索，并明确`evidenceVerified=false`。若将来要自动验证附件权限、完整性或远端实例归属，须另核已有受管证据设施；不能假设当前已有该服务。无证据可供引用时，只可记录inconclusive及固定原因，不允许用任意摘要制造“已证实”。

建议输入采用固定键集合；单次仅一条、UTF-8总量不超过4KiB、单一引用不超过128字符且仅允许字母/数字/下划线/短横线、SHA256严格64位十六进制。原因建议限`OPERATOR_RECORDED_MATCH`、`FIELD_MISMATCH`、`FIELD_MISSING`、`INSTANCE_MISMATCH`、`INSTANCE_UNRESOLVED`、`NO_OBSERVATION`、`CORRECTION`，实施合同须约束其与结论的一致组合。查看建议使用受权游标分页、每页最多50条、不得跨ledger扫描；这些是待实施的资源合同，不是当前已存在的限制。不得把摘要或引用暴露到公开日志、CI或PR。

## 5. 原子性、幂等与更正

- 追加记录和对应私有审计事实必须同事务成功或失败；不得先返回成功再异步补存。保留原链外键RESTRICT语义，不CASCADE删除历史。
- 以可信作用域、grant及命令键建立唯一性；同键同内容返回原记录，同键异内容冲突，不能覆盖。错误时返回固定分类，不回显旧记录内容或数据库原错误。
- 同一ledger追加按固定锁序串行分配序号；提交前核expectedHeadSequence，避免并发更正悄悄覆盖双方认知。冲突只要求重新读取历史并由人确认，不自动把新记录当“最后写入者胜出”。幂等命中检查应先于新追加的head比较，否则成功请求的重试会被自身推进的序号拒绝。
- 已知提交才响应成功。响应断连或COMMIT回执不明：只按原命令键和原内容查询/受权重试，唯一约束保证至多一条；不换键再造记录，不把未知提交改称失败且无效果。此幂等重试**仅针对本地事实追加**，绝不触发token、form或新的发送request。
- 记录及审计禁止应用层UPDATE/DELETE/TRUNCATE；更正采用同scope追加链，不删除原证据。普通清理任务不得触碰这些关联历史。DB管理员篡改、备份恢复和仓库外维护不在应用防篡改保证内；不宣传仅靠哈希即可防数据库管理员。
- 不回填旧发送ACK、不改原时间戳、不把历史unknown变成acknowledged/not_sent。不得为完成更正重建授权、退款或释放锁位。

## 6. 未知结果处理与展示

| 原发送事实 | 允许追加的人工事实 | 永远不因此发生的动作 |
| --- | --- | --- |
| prepared且已有admission | 记录所持证据或inconclusive；明确prepared不能证明从未出网 | 重发、退款、重新mint许可 |
| dispatching / outcome_unknown / state_unconfirmed | 记录观察一致/不一致/未决，原状态并排保留；找不到远端记录只能说明本次未观察到 | 改成成功或未发送、解除serialBlocked、释放永久CREATE fence |
| acknowledged / closed_observed | 追加业务侧核验或差异声明；原ACK不被撤销 | 把协议ACK当业务验收、自动补偿/删除远端数据 |
| 授权expired/revoked/stale | 在实时身份与历史归属许可下继续追加/查看 | 续期、恢复activation、补次数或恢复调度资格 |

界面需分栏展示“原发送记录”“人工核验声明”“证据尚未由系统验证”；所有投影保持canSend=false、canRetry=false。存在矛盾或更正链时保留完整历史并显示需人工复核，不由最新声明自动得出总体成功。任何observed_match都不应改变原发送未知状态或用于解锁下一行。

本方案提供**事实留痕**，不是未知发送的自动解锁方案。若业务需要允许后续行继续或再次CREATE，必须单独决策并证明永久防重与预算合同；不得把这项需求偷渡进核验保存。

## 7. 验收目标与可变异保证（实跑结果见验证MD）

先证明测试走真实JWT→真实权限/归属→真实PG事务→实际存储，再讨论变异致红。只用合成历史与合成证据摘要，不触及客户材料。

| 保证 | 必须覆盖 | 应被独立用例杀死的变异 |
| --- | --- | --- |
| 可信身份 | 无claim+header、跨tenant、其他owner管理员、失活用户/成员/权限、跨workspace、合法owner正控制；拒绝前不读取外部材料 | 删除单条身份/owner守卫，其他条件全部合法 |
| 关联不可拼接 | 同owner其他grant/request/admission/ledger交叉引用；已过期/撤销的合法历史正控制 | 删除链式关联检查 |
| 历史与发送解耦 | 两发送闸均OFF仍可合法追加/查看；零token/form/dispatcher调用；所有原预算/状态/fence/active指针逐项不变 | 核验后清active、退used、改unknown或发enqueue |
| 追加与更正 | 原记录不可改删、越scope更正拒绝、并发序号/head冲突、审计失败整体回滚、重启后历史可查 | 关闭不可改保护、去掉head比较、审计移出事务 |
| 提交不明 | 成功断连、COMMIT回执丢失、并发同键、同键异内容、旧head幂等重试只返回原记录 | 去唯一键、先响应再提交、重试换键 |
| 声明不冒充证明 | observed_match仍evidenceVerified=false/canRetry=false；不一致/缺证/更正均保留原发送事实 | 把人工match当ACK、使用“未查到”自动解锁 |
| 数据边界 | 超长/未知键、URL/path、原响应/凭据字段拒绝；公开输出仅闭合枚举/计数/哈希 | 泄露请求体或原错误到日志/DTO |

现有71项、父70项及停止/清理证据不被重新编号或拿来抵此新增验收。必须另有独立反驳，说明仍抓不到的降级；真人证据真实性、生产远端一致性、仓库外DB维护及所有并发时序不能仅靠这些合成用例证明。

## 8. 授权、发布与回退门

当前已批准本地实施，逻辑操作暴露、存储迁移及精确权限范围见第10节；后续若获发布授权，按GOV-08将决策与代码分别提交。已有#6462已经提出该概念，不等于本地文件已经作为独立决策发布。

不新增环境变量，不把已有GET变写入口，不改全局授权默认。后续发布前仍须重核远端迁移命名冲突；发布、部署迁移、客户材料核验或真实宜搭调用均另行授权。新增能力停用时保留所有记录及关联；不得删表、撤回原事实或退款来“回滚”。旧代码兼容新schema须另验，不能预签一键降级。

## 9. 原仅文档阶段验证（历史记录）

已亲读上述当前代码与GOV-08 PR模板，区分现有事实、拟定行为和未授权动作。只新增本说明并在既有验证MD登记；检查Markdown差异、引用路径、冻结head与生产文件零改动。五处源码引用在当前检出中存在；#6462文档不在此代码检出，按上列独立提交中的Git对象验证存在，不伪报为本地相对链接可打开。尾随空白/冲突标记检查为0，既有跟踪差异通过`git diff --check`。未实施schema/API/UI、未运行新产品/变异测试或CI、未读取凭据/客户数据、未请求真实宜搭。原完整目标仍未完成，本文不替代实施授权或功能验收。

## 10. Owner批准后的本地实施决策（覆盖前述待定项）

本节对应本轮明确批准的“现有 #6337 内本地实施”，不是对外发布或独立文档PR授权。第1节源码引用仍绑定原冻结head；本节实现为该head上的未提交补丁。

### 10.1 暴露方式与存储

- 在原私有前缀 `/api/integration/yida-automation-authorizations` 下新增两个逻辑操作：`POST /:grantId/requests/:requestId/observations` 追加；`GET /:grantId/requests/:requestId/observations/:afterId?` 分页查看。afterId是同ledger既有记录ID，服务端重新查归属，不能跨scope；不接受query作用域、任意offset或可控页长，每页最多50条。旧四操作合同不变，没有全局授权默认变更。
- 由现有management host执行真实JWT主体、实时ACL与owner链，使用原事务、取消检查及stop等待集合；不激活安装态、不调用源、凭据或发送许可。权限403，输入400，head/同键异内容409；存储异常、COMMIT回执不明及停止/取消导致无法确认返回503。客户端不得将503解读成“未提交”。
- 新增私有表 `integration_yida_reconciliation_observations` 与 `integration_yida_reconciliation_audit`；迁移 `zzzz20261021120000_create_yida_reconciliation_observations.sql`。使用现有raw SQL迁移入口，不修改旧097/099。记录有完整FK链及RESTRICT、ledger序号唯一、scope/grant/command唯一；数据库触发器验证链、序号和更正归属，延迟约束要求提交时已有audit；两表UPDATE/DELETE/TRUNCATE拒绝。
- body必须包含固定九字段（无可选遗漏；缺省项显式null）。入口按实际解码body字节拒绝超过4KiB，包括空白填充；路径检测与Express路由保持相同的不区分大小写语义，大小写变体及尾斜杠不得绕过限制。旧授权操作仍保留原16KiB限制。证据类型仅`operator_receipt`/`operator_comparison`/null；证据类型和reason在前后端均先检查类型再匹配枚举，不做数组或对象到字符串强转。人工时间要求规范UTC ISO且只作声明。

### 10.2 人工确认与未知提交恢复

- 在现有授权历史面板中，仅为已有admission的request显示人工事实子面板；显示原发送状态、完整可分页声明及“未经系统验证”。不自动取历史、不自动追加或发送。
- 首次追加必须读到服务器head（不能只读第一页取得全局head）、明确勾选确认；改变内容、更正对象或重新读取历史都清除原确认。更正只追加并引用旧ID；声明不用于计算发送成功或恢复下一行资格。
- 409后保留旧命令；必须重新读完历史并显式选择放弃冲突命令，再重新确认，不能自动换key。未知回执只重放原key/原body；幂等读取先于head比较。
- 为防止组件卸载/页面刷新丢失未知命令，提交前写入同标签页`sessionStorage`恢复日志。键以主体、JWT tenant声明、grant/request做SHA256分区；该分区只是UI缓存隔离，不是认证，真实权限仍逐次在服务端验证。缓存**不含JWT/口令/原证据**，只含固定九字段声明；每标签页最多16条未决命令，不驱逐未决项，存储失败不发请求，不自动重放。
- 同主体/tenant刷新token后可人工恢复原命令；换主体不能通过正常UI显示另一主体缓存。SHA256键不加密缓存，同源脚本/可访问浏览器存储者可读取引用和声明。关闭标签页、清除存储或浏览器未保留sessionStorage后不能承诺恢复原命令，应先核对服务端历史，不能宣称具备跨设备/浏览器故障的exactly-once。扩展到跨设备持久命令恢复需另行评估，不在本轮暗增API。

### 10.3 验收与发布界限

新增验收独立于原71项；后端使用真实JWT、真实management host和PG，没有把sender调用改为成功桩。历史admission/unknown仅是合成种子，不是一次真实宜搭发送。前端为实际组件及客户端、fetch边界合成，不等同于这份新补丁的Chrome整应用验收。结果、变异及未跑项逐项登记在 `integration-existing-pr-closeout-verification-20261012.md` 最新节。

本地补入原manual整应用入口的新增验收：在原合成vendor造成的unknown及真实撤销授权后，使用实际页面读取历史、追加未决声明、追加更正、清除页面状态并通过原“查看记录”入口重新挂载回读。所有请求经过原页面JWT、真实主应用router/host/PG；不改原Automation请求计数。最新旅程扩为8次历史请求、7个浏览器成功响应及1次受控丢回执；主应用将浏览器所见两条记录与PG记录/audit逐字段比对，原发送DTO不变。公开证据仅含固定布尔和计数。原证据验证器必须收到且按顺序核验新增完整帧，旧正常旅程回执不能代签恢复。是否实跑通过以验证MD终态为准。

丢回执故障只在验收辅助代码中：精确匹配已登记的首次POST，`route.fetch`转发原请求且禁止重定向/重试，校验真实服务端201及完整记录后才`route.abort('failed')`丢弃浏览器交付。没有`fulfill`成功桩、JWT注入或存储注入。仅该Request身份的一次固定`net::ERR_FAILED`可作为预期故障；其他请求/错误仍失败。最新本地旅程实际调用`page.reload()`，再读取真实auth/me和项目board，核对原owner、tenant、项目和sheet；必须恰好一次刷新、两次文档加载。经普通UI重新打开面板并显式读取历史，从真实sessionStorage恢复原九字段命令，人工重放须200/reused且与原201记录逐字段相等。随后更正为第二条记录，再清除组件状态回读，最终PG/audit仍各两条。证据门强制`realPageReloadSamePrincipal=true`，旧组件重挂回执不能代签。覆盖同标签页、存储仍保留、同主体的整页刷新；不等于浏览器崩溃、清除存储、跨标签页/设备恢复，也不等于服务端COMMIT回执丢失；后者有独立真实DB用例，分开报告。

独立后端核验整文件接入现有 `run-stock-preparation-yida-browser-ci.mjs`，不新增workflow或可控测试选择器。原5文件71项（66业务+5哨兵）保持原计数/任务回执；其后另启新的Vitest进程运行核验整文件15项（14业务+1哨兵），使用同一owner-bound临时PG和原隔离preload，但独立任务回执/JSON/私有日志。新批次最多90秒，且从原13分钟测试总预算扣除已耗时；外层15分钟、停止清理及原断言不变。父进程重新核验新增回执，缺失、跳过或用旧71回执替代均不得成功。只有两批和清理全部通过才输出各自成功计数；不把71改称86，也不把本地实跑写成远端CI。

迁移需先于新增历史操作使用；缺表失败关闭，不回退到本地假记录。停用功能保留两表及旧链，不删表、不修改发送事实。冻结旧router/历史宿主搭配新schema及已有合成人工记录的定向兼容探针已通过（1场景+1源码环境哨兵）：旧四操作及stop可工作，新记录/audit保留，unknown/额度/串行阻断不解除。该证据不是完整旧index/旧前端整包验证，也未执行down迁移；全应用一键降级仍不能预签。详见验证MD最新节。本地文档与代码仍未提交；后续独立GOV-08文档发布、代码推送、CI及部署分别需要授权。
