# SA-06V：显式启用受控记录触发（独立边界决定）

状态：2026-10-01，落实用户已批准的 Automation A，本地开发与合成验证；不是发布授权或已验收声明。实现与验证另记原 SA-06 验证报告，尚未提交。该新端点按 GOV-08 单独记录，不扩大到客户读取、发送、业务写入、合并或部署。

最新生产者覆盖见§12 SA06AJ；此前“Automation producer未覆盖”是原批次状态，普通create_record/update_record已补，不能据此扩大到其它写入口。

## 1. 决定与范围

复用既有 durable `automation-record-trigger` 消费者及私有只读账本，不新增调度器或 EventBus 自动读取入口。第一增量接精确 `record.created` 的无条件规则；其余记录类型、条件表达式及定时规则仍是上位 SA-06 待交付内容，不将本增量当作完整目标。

新增 `POST /api/integration/automation-read/record-activations`。调用者仍必须具有真实 JWT tenant、当前 canonical private Connection owner 及 live integration admin，workspace 固定 null。主体不取请求体、事件 actor 或租户头。输入只包括 activationKey、selector、一个 projectNo、budget、expiresAt、maxExecutions；不接受既有 grantId、trigger、来源证明、SQL 或凭据。响应只为 activationId/grantId。

owner 一次明确操作在同一事务内新建 automatic-only grant 与不可变 activation。旧 grant 默认 standalone；即使已经含 record/schedule，也不自动启用、不可升级。activationKey 在 owner/tenant 内幂等，绑定完整输入；丢失响应只能恢复原记录，不得产生新次数预算或把撤销记录重新启用。普通 `/requests` 不能消费 automatic grant。

activation 状态由对应 grant 的存活、期限及撤销状态决定，不引入另一套取消语义。现有授权历史及 revoke 保持可用，runtime 停止后仍能管理。每次 claim、IO checkpoint、结果发布重验关联与原完整 authority；取消/撤销不承诺已发送的原生 SQL 可物理停止，只阻止后续读取和结果发布。

## 2. 事件身份和持久化

只有宿主 durable consumer 可触发私有 record producer，普通 EventBus、测试、retry/resume 不获得此能力。delivery 只携带 outboxId/eventId/fence/attempts；payload、sheet/record、时间、depth 必须从持久 outbox 行读取。tenant/执行 owner/项目固定来自原 activation，不从事件业务值推导。

同一个授权/提交事务内锁住实际 outbox 与 consumer，校验精确事件家族、当前 in_progress fence/attempts 和锁后仍有效的租约。AbortSignal 在进入及提交边界检查；候选扫描不代表授权。已进入 COMMIT 的取消可能输给提交，不能承诺撤回已提交任务。真正 source IO 仍是后续私有 read consumer 的职责。

启用下限是 activation 事务中的 DB clock；当前 outbox.created_at 早于或等于该下限的积压行不执行。候选与最终准入还同时拒绝查询语句可见、仍保留的同 event_type/eventId 激活前副本，防止旧事件换一个新 outboxId 跨过切线。非唯一(event_type,event_id,created_at)索引只支持此检查，不禁止既有合法重复入队。**不证明跨 retention 删除历史、并发尚未提交历史或跨事务 COMMIT 顺序的逻辑事件首次发生时间**；未新增永久事件墓碑。稳定 invocation 使用 activation、固定事件家族和持久 eventId，不使用随机新ID、outboxId、fence、attempts 或实际回调时间。同一 eventId 已经准入后的多条投递、重新 claim、响应丢失只恢复同一个请求；unknown 不重读。

首增量要求规则 trigger 精确 record.created、conditions 为 null、trigger_config 为 null 或空对象。非空条件/配置拒绝启用和后续准入，不能绕过普通 executor 的条件判断。规则 revision 与完整 authority key 固定；修改/ABA 使旧授权失效。真实 outbox depth 0–2 沿用既有上限3，不重复执行回写 producer 已做的 +1。

候选有界且超限整次拒绝，不截断后假称已处理。候选未启用、过期或撤销不启动读取；数据库、锁或通信暂时失败不可当作没有候选而 ACK。授权拒绝应与暂时故障区分，不让一个已失效绑定使独立普通规则丢失执行。

## 3. 与普通 Automation 共存

record consumer 把真实 dispatch context 传入 read producer；read 腿和普通规则腿分别尝试，任一暂时失败最后重抛，允许原 dispatcher 按既有策略重投。read 请求用私有 invocation 去重，普通规则保留 event_fires 去重；read 腿不消费普通 event_fires。

durable record.created 的普通执行腿只跳过实际 read 动作，避免额外生成固定失败日志；普通 EventBus、手工测试/重跑及 executor 的 read 拒绝不解除。条件规则不会因这条跳过规则在 read producer 获准。source consumer ACK 只表示任务已持久入队/无适用授权，不表示只读预览成功；最终状态仍来自 SA-06U 的真实请求审计。

未配置/停止 read runtime 且没有适用 activation 时，普通事件仍应正常处理。存在 activation 时不得因 runtime 不可用而静默丢弃；尚未入队的自动读取不能用普通引擎代替执行。

停机先同步关闭 record metadata 新准入并排空实际 promise。dispatcher 超时可能不再等待回调，因此 read 腿 await 返回后再次检查取消；取消后不启动普通 SQL。普通 durable 入口也拒绝停机后新任务并加入既有 producerInFlight，宿主统一等待这两个 barrier 后才能关闭 pool。插件 runtime 暂停不永久关闭 record metadata 入口；宿主整体停机才关闭。

## 4. 迁移、验证与非目标

135000 迁移追加在134000之后：grant purpose 默认 standalone，activation 私有不可变、一对一、owner/tenant 内 activationKey 唯一；automatic grant 在事务提交时必须存在匹配 activation，禁止原有 grant 转用途。存在自动历史时 down 拒绝，不删除历史来完成回滚。迁移先于应用；未授权真实部署，不执行生产升级。

验收必须走真实事务、真实规则/权限与 durable handler，不以宽松 facade 或返回成功的 producer 桩证明闭环。覆盖新启用零源IO、幂等/丢回执/异输入、撤销、假事件/租约/截止时间、旧积压、同 eventId 多 outbox、规则/权限变化、普通任务共存、每次IO/发布重验及不自动重读，并做单项降级变异。

没有新插件 facade、额外 CI 泳道或布尔开关。UI 自助启用按下节增量接入；其余记录类型/条件及 schedule 的稳定 occurrence 身份仍是后续内容。没有授权外部写、宜搭发送或 K3 写回。

## 5. SA-06W owner 界面合同（2026-10-01，本地合成验证完成）

复用上述唯一 record-activations 端点，不新增授权入口。默认模式仍是手动预览；用户必须显式选择记录触发、选定当前规则与单项目、限定次数/期限/读取预算并确认，才能请求启用。保存普通规则不表示激活。当前只支持无条件 record.created、空 trigger_config；手动许可关闭的规则仍可在满足该独立合同后进入记录模式。

options 在真实 execution authority 已锁住规则后派生必填 `recordActivationEligible`，返回资格不作为后续执行证明，activateRecord 仍重新验证。false 规则不从手动发现结果中消失；禁止仅靠 allowedTriggers 含 record 推定类型与条件。历史 grant 必填 `purpose: standalone|automatic`；本片 record automatic 必须单项目、仅 record。后续 SA-06X 通过独立 schedule activation 扩展为单项目、仅 schedule 的另一家族，不能互借或混合，两者均不能手动 submit；详见 [cron 独立合同](automation-read-schedule-activation-design-20261001.md)。老 standalone 即使含 record/schedule 也不能显示成已启用自动授权。

新 activationKey 与完整输入在发请求前固定。回执不确定或已返回 pair、后续详情读取失败时，当前会话只允许显式恢复同一 key/同一完整输入，不自动重试、不重新计算期限或预算、不创建替代授权。恢复回执不代表 active，必须取得当前详情后按真实状态显示；撤销回执不能复活。成功后另一次授权必须经过独立“新建授权”步骤和再次确认。会话/上下文变化、卸载清除本地恢复材料，旧异步响应不得写回新会话；本地不持久化 key，刷新页面后不承诺恢复未收到的 activation 身份，应通过当前 owner 历史核对。

automatic grant 禁止手动 submit，普通测试/重跑/Executor 禁止不解除。成功启用本身零源 IO；仅真实 durable 记录投递生成私有 queued 请求，随后 read worker 才执行源读与有限预览。验收分别记录生产 DOM/API/原生合成数据库链和受控回执丢失测试的证据层级，不把替身成功当成实际链路证明。命令与结果已记录在 CodeWT 验证报告 §26：实际 authority/Chromium76/76、record PG70/70、FE344/344、四项有界变异均捕获。没有真实浏览器网络断线恢复整链证据，也不是客户验收或发布声明。

options/grant 的新增字段是严格必填合同，前后端混用新旧版本会拒绝响应，未来发布需同步更新并刷新缓存，不以兼容回退省略目的/资格校验。该界面不增加新迁移，仍依赖前序134000/135000先迁移后代码的部署约束。当前只在本地候选完成，无合并或部署。

## 6. SA-06Z：明确授权更新事件（2026-10-01，本地合成验证完成）

本增量落实既有 Automation A 的记录触发目标；前述 created-only 是首增量历史边界。现在只扩展到无条件 `record.updated`，不新增公开端点、事件生产者或第二个调度器。条件必须 null，trigger_config 仍仅 null/空对象，项目仍由 owner 显式限定为一个。`record.deleted`、`field.value_changed`、字段条件与从记录字段派生项目不在本刀交付，仍留在上位目标。

真实 RecordService 的 updated payload.data 是提交的 patch，不是更新后完整行；零字段 patch 也有更新事件。因此语义是“适用的已提交更新事件可产生一次有预算的只读预览”，不承诺字段值实际发生变化。事件中的 project、actor、tenant 均不能决定读取范围。普通条件引擎的元数据失败降级和负向比较容错不能直接借作只读授权条件；本刀不运行该条件引擎。

复用 activation 不可变 rule_revision 与原完整 authority key。数据库规则 nonce 对整行变化重新生成，created→updated→created 不能复活旧授权。不为执行重复存储另一个事件类型列：每次候选与最终 submit 都从同事务锁定的实际规则与实际 outbox 比较精确映射，created 只配 multitable.record.created，updated 只配 multitable.record.updated；不能只检测二者都属于 record 家族。最终稳定 invocation 纳入实际验证过的 event_type；同 eventId 的两类事件不混淆。旧已授权 created 行不迁成 updated，旧 standalone 不自动启用，规则变化需重新明确授权。

两类受支持事件都经过 durable read 腿和普通规则腿；普通 durable 腿只跳过只读动作，普通规则仍使用原去重与执行。EventBus、普通 Test/retry/executor 的私有读取拒绝保持。删除/字段事件不获得新增的私有入口。source consumer 完成不表示预览已成功，来源 IO 仍在后续私有 worker，且逐次检查当前权限、版本、预算与期限。

options 在当前真实授权锁后增加严格必填 `recordTriggerType: 'record.created'|'record.updated'|null` 与 `recordRuleRevision: UUID|null`；二者非 null 当且仅当 recordActivationEligible=true。类型是当前候选的确认文案，不是从当前规则反推历史 grant。用户必须看见并确认精确类型，模式仍默认 manual。

独立复核发现旧六字段协议的新 TOCTOU：用户看见created，另一窗口改成updated，原请求会按新的合法类型批准。为此 record activation body 增加第七个必填 `expectedRuleRevision`，从此次确认的 options 冻结；服务端只把它作为并发前置条件，真实规则锁内不相等即409且不新建任何grant。版本同时覆盖类型、配置及ABA，不是可自报的执行类型或授权证明。schedule body保持六字段。既有 activationKey 重放与原activation.rule_revision比较，异版本409；准确旧请求可恢复原pair，即使规则已变化，也不重新授予读取权或增加预算。

规则/选择变化清确认；回执恢复不能改版本、类型、项目或预算，不能自动重新发现新版本后重发。历史列表只显示record家族；当前会话的恢复显示可保留原确认类型，不借当前options篡改它。前后端需同步升级，不静默接收缺少版本/类型的新旧混合合同。

新增137000迁移在135000/136000之后仅更新数据库 activation admit 的封闭类型门，历史迁移原字节不改；保留 automatic 用途、不可变身份、提交时关联及 schedule 家族合同。上线仍必须先迁移再应用；本轮只在自有临时PG验证，不授权生产迁移。保守回滚有记录授权历史时拒绝，不删历史、不以当前可变规则推断旧类型。

最终冻结字节实际authority/native/Chromium87/87、record PG94/94、schedule PG78/78、FE493/493通过；候选类型、最终提交类型、确认版本三条单守卫内存降级分别被3/3/1条行为AssertionError捕获。独立复核抓到确认TOCTOU后复核修订版无新增阻断。完整命令、局限、既有父页lint基线与15项源码/测试字节在CodeWT验证报告§32；该组合的更新事件是合成直接outbox入队，不冒称完整RecordService REST/客户链。仍未提交、发布、合并或部署，后续字段条件和其他记录类型未交付。

## 7. SA-06AA：字段条件的来源语义及前置引擎（2026-10-01）

本次仅完成严格求值前置，**不改变现有conditions=null准入门**。不是对未接通链路的批准/发布声明。原型讨论中的“按event patch全部字段求值”不采纳为最终产品语义：grid payload在部分入口是规范化前值，unset还会失去原操作信息；REST patch并非完整保存状态。不能因某个合成事件恰好带齐字段就认为其可信。

后续采用当次记录写事务中实际保存的原始row.data证据，优先从INSERT/UPDATE RETURNING取得并与同事务生成的outboxId关联，零字段更新使用已锁定currentRow。私有旁表/证据通道与普通公开事件分离，不能进入webhook payload、API响应或日志；消费者不补读最新记录，不展开关联/计算字段。既有record revision不覆盖零字段更新事件，不能单靠它假装完整生产链。RETURNING证明该DML保存结果，不自动证明任意额外AFTER触发器/后续语句没有再次改变记录。

实现前仍须落实：全部record生产者清单与未有证据路径明确拒绝、精确sheet/record/event/version绑定、事务回滚与retention联动、UTF-8字节/结构深度/批次上限及超限结果、稀疏row.data缺失与显式空值语义。不能为方便引擎把未证明的缺失键补成null。只读owner实际字段访问与schema/规则修订继续在真实事务检查；compiled句柄不是身份或执行授权。不能借该新增检查收紧无关人工显式调用的历史条件兼容路径。

已实现的纯引擎复用原12算子合法组合：封闭有界AST、全树依赖先检查、三态结果、调用方可变材料隔离、私有WeakMap句柄与显式最终时区。CS-21历史越组选项保持可读，autoNumber仅支持已提供的原始数值；均不证明可读权限。147/147条件测试、195/195普通回归、静态通过；三种有限变异分别6/18/1条行为断言捕获，独立复核未见本片新增阻断。所有证据仅是本地引擎层；尚无私有snapshot迁移/producer、ledger/owner UI条件接线或真实生产者合成整链。详情见CodeWT验证报告§33。

## 8. SA-06AB：原始私有快照合同，不改变条件准入（2026-10-01）

本地新增138000旁表及REST create/patch/no-op/restore、grid set/unset生产接线。真实DML的版本与有界data::text，经同事务outbox receipt的内部第五参数持久化；no-op使用原FOR UPDATE有界文本。不能用JSONB经JS重序列化，已用真实PG证明高精度整数/小数不被舍入。显式rawJson坏值或缺失不退回公开patch；证据不进入公开event、webhook、响应或日志。

双态为captured完整object或unavailable固定原因且NULL正文；每条256KiB、结构深度16/节点8192/键及数组2048。同事务DB-issued xid共享256条/4MiB预算，grid额外在保留映射前丢弃超限数据；超限不阻止原合法业务提交，但后续条件不得执行。DB比较父eventType/eventId/sheetId/recordId，UPDATE拒绝，父删级联，有历史down拒绝，无回填。迁移严格先于新代码；缺表而durable开启会回滚业务保存，不静默继续。

这些约束并不独立证明rawJson来自DML，内部已核对的生产接点才提供因果保证；不防任意直接DB写者。原始稀疏键保持缺失/null/unset差异，未提供写时字段定义、当前字段权限或计算/关联补全。Automation executor、FWB/approval及recovery自身DML仍没有该证据。未来消费者必须拒绝缺失/不可信证据且复验父身份，不能查询当前行补全。未新增自动retention，父删除联动不等于总量/保留期管理已实现。

实际service/helper＋PG最终34/34，专用92/92、保存165/165、API7/7、普通195/195、定向静态及七种有限行为变异有证据；不是HTTP/JWT＋条件执行整链。现有CI步骤登记且pin重算66项0差异，无远端CI结果。详细失败修正/局限/字节在CodeWT验证报告§34。conditions=null、默认manual、owner/admin及只读用途均不改变；无客户读、外发、提交、合并或部署。下一步完成schema-at-write与当前字段可读性合同，再考虑owner条件确认和消费接线。

## 9. SA-06AC：写前schema nonce，不把版本当成权限（2026-10-01）

本地复用130000的sheet material epoch，在现有fence之后、首个源记录锁/DML之前取得SHARE NOWAIT元数据锁及epoch；私有token绑定同trx对象/sheet/DB xid。SAVEPOINT竞争仅55P03可回滚部分锁后标NULL，允许原合法保存，不晚取当前版本。持久化前观察锁仍存在、live sheet及原nonce；自身schema变更或回滚失锁使证据不可用。真实producer不允许借相同内容或同ID重建复活旧nonce。

新增139000 nullable schema_revision、非NULL当前nonce INSERT检查及历史保护down，138不改。NULL可与raw captured共存；它明确不是可用条件输入。捕获表锁可阻挡其它sheet的metadata写，本轮不承诺无影响或吞吐；DB trigger单独不证明写前时序，pg_locks单独不证明连续锁轨迹。保证在受控host producer内，不防任意SQL写者或同进程恶意代码。该nonce不包含完整字段定义文档、base时区或当前字段/行权限。

部署必须130/138/139先于新代码，漏139真实保存会42703并回滚全部副作用；有非NULL历史不可down删除。实际PG最终48/48及五种有限内存变异有行为证据，专用单元129、保存165、API7及普通195通过，命令/字节/边界归CodeWT报告§35。未触及真实实例，没有发布授权。

conditions=null门保持。下一片应把条件全树引用字段的真实当前read权限与metadata锁放入authority的既有锁序，在grant锁之前准备并复核规则，而非在后期recordRule倒序加锁。新准入使用原事件私有快照且版本匹配；重放恢复原准入，不能查询最新行重新判断或换预算。当前仅明确后续合同，尚无消费者/owner条件确认整链，不记该部分完成。

## 10. SA-06AD：当前条件字段权限与私有解释（2026-10-01）

本地实现显式host-private准备/求值方法，但不开放conditions非null准入。`lockRecordExecution`先走完整原authority的actor/Connection owner/source receipt/全部target字段/规则/profile验证，再在grant锁前准备所有条件依赖，比较同一rule/schema nonce，末尾复验producer期限；原七字段proof只换纳入条件fingerprint的key，私有context留在同factory WeakMap。普通/manual调用保持原条件兼容，不把新增条件限制倒灌给无关路径。

条件字段和目标投影共用现有真实read权限服务与ACL锁；仅condition增加原始person/user/link比较类型，不展开关联。执行前再次查当前字段权限，覆盖同事务自身撤权及savepoint释放ACL锁后其它连接撤权；明确拒绝可返回FIELD_ACCESS_DENIED，SQL/锁失败必须抛UNAVAILABLE，不能当作条件不命中。schema nonce不是权限版本。context只限同handle/DB xid，不能跨事务或结构复制复用，也不是来源IO授权。

实际outbox/不可变image身份与原schema全匹配后，仅取完整条件依赖的原保存值投影；不读最新meta_records，不补公开patch、不把缺失改null。AST、完整metadata property和投影分别用真实PG JSONB往返比较拒绝JS数值舍入；numeric string另验数学往返。固定host/字段时区，普通引擎不变。只对本模块新增文本传输声明界限，既有raw rule加载仍非全局有界。任意直接DB writer/同进程恶意代码不在来源保证内。

独立复核提出的事件参数测试接错和旧context权限问题均已修正；命令、实际PG/有限变异/完整回归结果与冻结字节由CodeWT验证报告§36统一维护，不用分层测试冒充条件自动整链。下一步仍需owner确认、不可变一次准入/重放合同、ledger/runtime接线、未覆盖producer及生命周期；本片无新增DDL、flag或端点，迁移130/138/139部署前置与历史保护不变。客户读取、外发、提交、合并、发布和部署仍未授权。

## 11. SA-06AE 实施合同：条件自动准入与 owner 确认（2026-10-01）

在已批准的 Automation A 本地开发范围内，record.created/updated 接入已保存条件。新增封闭公开描述：无条件 `{mode:'unconditional'}`，条件 `{mode:'saved_conditions',schemaRevision,businessTimeZone}`。描述不含 AST、常量、字段值或私有授权指纹；它与 expectedRuleRevision 一起成为 owner 确认的并发前置，不是客户端选择执行策略。options 必须经真实 record authority 才可声明可启用；POST 必须显式携带描述，schedule 合同不变。界面描述变化清除确认，回执不确定时只恢复原请求，不重采当前版本或追加预算。

140000 后续迁移把原始描述保存在不可变 activation.condition_confirmation；旧 activation 来自已执行的 NULL-only 合同，可明确标 unconditional，不从当前规则反推历史。新插入仍由 DB 检查 owner/scope/规则版本/事件类型/真实时间切换点，并对条件描述和当前 sheet epoch 作窄校验；严格 AST/ACL 仍由生产编译器负责。迁移先于代码，有保留 record 授权历史时 down 拒绝。

运行时精确选择 record authority，旧 NULL grant 保持原 key；不得尝试普通 key 作为条件降级。当前权限和条件解释版本在 activate、submit、claim、checkpoint、complete 重验。首次请求在 duplicate 一致性检查之后、任何 quota/request/audit/read-outbox 写入之前判定实际私有事件快照；只有 match 入队。no_match/unreadable 不占额度，不回读最新记录。数据库或锁错误不是条件不命中，不可静默 ACK。

已准入 invocation 重放返回原请求，仍重验当前授权、事件租约及切换点，不再依赖旧快照、不另造额度。未准入的负结果不另建永久判定账本；此设计不声称跨任意重造 outbox 的负结果永久去重。执行 worker 按 grant 派生的私有 authorityMode 使用同一 record proof，但不二次求值原事件。

私有快照后续清理仅删除足龄且源消费者完成的 after-image，不删父 outbox 或切换点历史；停机、开关关闭或清理失败不承诺硬容量上限。未覆盖的 Automation/FWB/approval/recovery producer 继续因证据缺失拒绝条件读取。真实 DOM→JWT→准入→dispatcher→合成只读源验证及生命周期测试完成前，不把本合同记为完整交付。无新客户读取、外发、合并或部署授权。

### 11.1 SA-06AE 已实现状态与验收边界（2026-10-01）

实现已接入 `record.created` / `record.updated` 的已保存条件准入，不再停留在 §10 的 NULL-only 前置阶段。options 只有在真实 record authority 准备成功后才给出可启用状态及封闭描述；明确不支持的条件可使 record 选项不可启用而保留原 manual 能力，缺必需元数据、数据库或锁失败不能伪装成可启用或普通条件不命中。默认 manual、Connection owner 与集成管理员的交集、固定项目及有限期限/次数/预算均保持；schedule 的六字段无条件 cron 合同不变。

record 激活请求现在严格为八字段：`activationKey`、`expectedRuleRevision`、`expectedRecordCondition`、`selector`、`projectNo`、`budget`、`expiresAt`、`maxExecutions`。界面同时确认事件类型和条件模式；条件按事件时私有保存后快照解释，不读取当前行补齐。描述不含条件 AST、常量、字段值或私有指纹。规则版本以及条件描述是服务端实际权限检查之外的并发前置，不是自报授权。确认期间描述变化会清除同意；回执丢失或 detail 读取失败只允许按原 family/key/完整八字段恢复，不重采描述、不换版本、不增加预算。历史授权不借当前 options 推断原条件模式。

生产调用保留 `lockRecordExecution` 返回的原始 proof，私有描述与求值 context 只接受同 authority 实例登记的原对象；普通 proof、结构复制或普通 key 不成为条件降级路径。初始 activate 已完整验证；后续在 submit、claim、每次 checkpoint、complete 四个执行阶段重验 live 权限和规则/解释版本。submit 在当前授权、事件租约与切换点验证后先查一致的既有 invocation，再对首次请求求值真实私有快照；只有 match 才写额度、request、公开审计和只读 outbox。no_match/unreadable 不入队、不占额度、也不触发来源读取；SQL/锁异常抛出交由既有 durable 流程重试，不当作不命中 ACK。既有请求恢复不再依赖旧快照或重算原条件，worker 仍逐阶段重验但不二次求值；没有为未准入负结果增加永久去重账本。

生命周期清理已接既有 dispatcher tick：按实际数据库时间，仅删除严格超过七天、且源 `automation-record-trigger` 消费者已 done 的私有 after-image；每次最多 200 条，进程存活期间每十五分钟最多尝试一次（失败也计入间隔），同进程在途任务合并，stop 拒绝新任务并等待已开始任务结束。清理不删除父 outbox、消费者或切换点历史；已准入的后续只读执行不依赖该快照。pending/in_progress/dead-letter/缺消费者行继续保留；停机、开关关闭或清理失败期间，不承诺严格七天删除或总容量硬上限。未覆盖 producer 仍因缺可信事件证据拒绝条件准入，不回读最新记录兜底。

部署须在既有 130000/138000/139000 前置满足后，先执行 `140000` 再上线新代码。它把原确认保存为不可变 `condition_confirmation`；旧 NULL-only activation 明确迁为 unconditional，不根据当前规则回填条件含义。有任何保留的 record activation/automatic record grant 历史时 down 拒绝。新旧公开协议不兼容：旧七字段 record POST 会被拒绝，新客户端缺描述拒绝解析，旧严格客户端也不能接受新 options 字段；前后端需协调更新并刷新客户端，不能静默省略字段回退。

最终状态补记（2026-10-02）：整文件实际authority/native/JWT/Chromium **104/104**，另record activation PG **119/119**、retention PG **15/15**，五项有限内存变异均被行为断言捕获。条件事件来自真实DML＋生产schema/snapshot helper，尚不是HTTP记录写端点整链；此前producer PG证据是直接调用实际RecordService方法，两套不合称一个端到端。首次103/104的旧时钟fixture入场失败及有界等待修正、其它首败、完整命令和19项冻结字节统一见CodeWT报告§37；不以绿反推历史根因。当前仅本地合成开发与验证，没有真实客户来源读取、业务写入、宜搭等外部发送、提交、合并、发布或部署；完整目标继续 active。

### 11.2 SA-06AF：真实 HTTP 记录写入同链验收进度（2026-10-02）

本轮新增一例同链验证：真实 `POST /api/multitable/records` 经实际 JWT、权限门、`RecordService` 和真实事务，产生 revision/outbox/私有 image，再由已取得 owner 条件授权的消费者准入，最终进入 native 只读预览。该证据补上 §11.1 明示的 HTTP 写入口缺口，但边界不能扩大：记录写请求由夹具 HTTP 客户端发送，不是业务记录编辑器 DOM；owner 同意和结果查看使用真实 DOM。写入口负例实际证明未认证请求 **401**，不是有身份但无权限的 **403**。预览阶段业务基线按全量 `id/sheet/data/version/actor/timestamps` 比较，不能只用行数相等声称未改业务内容。

另一新增用例验证 HTTP 夹具关闭时真实处理器的排空：调用原 `createRecord` 完成实际提交后暂扣其返回，真实 socket 关闭不等于处理器完成；只有原异步 handler（含后续路由读取）结束，才可恢复共享数据库转发。夹具递归观察实际 Express/JWT handler 返回的 Promise，保留原调用、`next`、返回值及错误处理器签名，关闭时拒绝尚未进入的 handler；不替换事务控制或生产权限。该生命周期保证仅覆盖归属 handler 的 Promise，不扩称可以排空生产主动分离的后台任务。

本次受测代码仅修改 `automation-read-authority-realdb.test.ts` 与 `automation-read-http-acceptance.ts` 两个测试文件，另更新本地包装器和伴随文档；无生产端点、权限、DDL、flag、pin 或 CI 泳道新增。限定 **2/2** 之后，根线程已完成未变异整文件 **106/106**（tests418538ms、total421.43s），0skip/unhandled/禁止连接/环境文件读取，临时PG已移除。三项单点内存变异 `http-record-no-drain`、`image-unwired`、`record-condition-admit` 各被一条真实行为 `AssertionError` 捕获，安全清理零越界；每项只选两例、另104项刻意排除，不冒称完整变异回归或穷举。核心类型/所选lint零，CI登记328/328、66pin零差异及实际provenance/host6/preview16通过。完整命令、证据边界与两项原始hash归CodeWT验证报告§38，不是远端CI或客户验收。

本节是现有实现的伴随验证记录，不另开设计或扩大授权。所有记录写入和来源预览均在本地合成夹具内；没有真实客户读取/写入、外部发送、提交、合并、发布或部署。原八字段 owner 确认、迁移 140000 先部署及前后端协议不兼容约束不变，完整目标仍 active。

## 12. SA06AJ 普通 Automation create/update 的可信事件（2026-10-02）

普通 `AutomationExecutor.execute` 的 `create_record/update_record` 已在原事务内接入schema capture与实际DML返回的完整有界image；不取input/patch代替，不在consumer读取最新行补齐。Class A重复早退、OFF SQL、原写权限、原公共事件/depth、UPDATE零命中及既有revision语义保留。特别是CREATE旧revision仍为版本1和输入snapshot，新私有image才取真实数据库返回；不混称两者。

schema NOWAIT冲突通过SAVEPOINT恢复，原写可以成功但无nonce的条件证据拒绝；image落库异常则连原记录/revision/outbox/consumer/claim一起回滚。专用真实PG98/98（新增17项）已验证锁顺序、字节/版本/xid、数值、旧事件与当前行隔离、锁冲突、回滚/重试、OFF和去重。新增2条实链从公开executor进入已由owner HTTP批准的条件准入，最后真实原生合成预览成功且业务全量快照不变。executor入口由fixture直接调用，不冒称普通规则HTTP保存/调度链。

限定4例与4个单点内存降级探针均完成；最终冻结版完整114/114通过（tests421061ms/total423.96s），零skip/unhandled/禁止IO，临时PG清理。命令、真实失败及证据边界归CodeWT验证报告§42，目标文件§95。无新端点/角色/DDL/flag；resultWriteback、FWB/approval/recovery等其余producer仍因缺可信证据拒绝条件准入。copy-sheet/form-submit的不发事件是既有明确合同，不新增隐式来源读取。仅本地开发与合成测试，无客户读写、外发、提交、合并或部署。

## 13. SA06AK 审批 resultWriteback 可信事件（2026-10-02）

本续篇仅替代前节resultWriteback未覆盖状态：既有共享审批回写事务在受管门之后、DML之前捕获schema，并由实际UPDATE RETURNING取得完整image/版本，原子保存revision/outbox/image。不同于普通动作的Class A合同，此处没有新增审批整体exactly-once；原上层best-effort catch仍可能在回写回滚后把审批继续完成并记录backwriteSkipped，重复完成事件不自动补写。此行为已由真实失败/replay用例证明，不称自动恢复。

专用同/跨库等6项真实PG及一条owner HTTP确认→真实模板/审批/bridge→历史image条件准入→native只读预览已通过；事件后live row改变不重解释原条件，预览canApply=false、业务全量快照不变。6项专用只选新组，原组6项排除；authority限定5项还排除110项。三项有限降级被行为断言捕获，详细命令/夹具真实首败及异步收尾修正归CodeWT报告§43、目标§96。

完整冻结回归114/115（tests317655ms/total320.54s），新增审批链通过，唯一旧native预览在checkpoint拒绝；62次来源SQL均成功，checkpoint199/198，固定码不足以定位下层原因，仍待test-only脱敏阶段诊断，不能以新链成功宣布整体稳定。0skip/unhandled/禁止IO，临时PG清理、7项hash无变化。其它approval写入口/FWB/recovery仍不在本片承诺内，缺证据继续拒绝。无新授权、公开协议或迁移；不扩大Connection owner/admin、固定项目/版本/期限/次数/预算，也没有客户读取、发送、发布或部署。

## 14. SA06AM / SA06AP FWB新建与更新的可信事件（2026-10-02）

旧§12/13的FWB未覆盖状态，现仅由create和update两种既有write_approval_form_values接点替代；其它approval/recovery来源仍不能由缺失证据回读最新行补齐。create的实现及验收归目标§98/CodeWT报告§45；update归目标§101/报告§48，不把两个批次的重叠测试累加。

update在原Q6、派生目标写门、record锁、mapping与业务claim成功之后，在同`t`上capture目标sheet schema→实际UPDATE RETURNING→原revision→outbox/image。规则sheet可以不同于派生目标，不接受客户端另指目标。原revision仍使用完整保存data与mapped patch；有界image取PG文本和真实版本，不用映射值或当前live row。零行/非法receipt拒绝，真正image错误整笔回滚；schema NOWAIT则经savepoint恢复、旧写可成功但条件证据不可用。下游read grant不授予这些写权限。

专用PG9例和实际owner HTTP/JWT→真实审批/consumer→native合成预览1例已通过，故意取输入/错sheet/复制事务/断image的4个有限降级被真实路径拒绝。完整120项回归终态与10项列举hash由报告§48统一记录。本片是同base跨sheet、审批service调用而非完整审批UI；人工新eventId只证明业务claim去重，不承诺自动retry或崩溃恢复。无新端点/迁移/授权开关；真实客户、外发、提交/合并及部署继续单独授权。

## 15. SA06AQ 恢复revert的同事务事件证据（2026-10-02）

本片只为已有恢复写操作补可信事件材料，不使只读grant获得恢复权限。共享revert执行点在原授权/围栏/行锁后捕获schema、取实际UPDATE RETURNING有界image；私有WeakMap以原mutation身份短期绑定QueryFn和原事务对象，既有producer复用同对象落outbox/image。公共payload不增字段，revision保留归档投影的原合同，删除/禁止复活和durable OFF行为不变。无证据的旧producer仍不能条件准入，不回读live row。

新增archive sync公共服务链真实PG8例，实际加密归档/preview token/生产权限/执行/事件保存，验证RETURNING与BEFORE/AFTER trigger最终live值不同、七项同xmin、真实失败回滚、NOWAIT无schema条件拒绝、撤权与错误绑定。六项有限降级实际致红；主正控已由独立核对补强为精确公共payload和双trigger，排除late SELECT替代。完整命令、CI接线及旧恢复回归失败归CodeWT报告§49。

这是service facades到真实条件原语的验收，不是恢复HTTP/JWT或owner grant→dispatcher/native链，也不是hot/async新增image验收。共享代码接线与分别跑通三条入口不能混称；旧§14所列完整120来自上一片，本片未复跑。既有条件描述、owner/admin交集、固定授权范围/预算和canApply=false不改，无新端点/权限/DDL/flag，不访问客户、不发送、不发布或部署。

## 16. SA06AR hot实链及async证据补齐（2026-10-02）

目标§103/CodeWT报告§50以实际hot HTTP/JWT/RBAC→owner record activation→记录消费→native只读预览替代上节相应“未验证”状态；生产共享seam未改。preview后撤字段权限真403，恢复权限才写；image使用实际保存值而非旧revision投影，事件后live漂移不重解释条件，预览业务快照不变。原HTTP重放因刻意触发的history mismatch先拒409，不能称token-replayed守卫单独已证。

async使用真实5001计划及canonical worker callbacks，仅首5000 chunk；256 captured/4744 unavailable预算明确，不宣称整job、resume或全部afterCommit内部效果。新增3例加旧8例整文件11通过，hot限定1通过、五项有限降级捕获；完整121及最终检查终态统一见报告§50，不复用上一片旧绿。原owner/admin、单项目/版本/期限/次数/预算和不写/不发送合同未扩大，只读grant不授予恢复权限；没有客户IO或发布部署。
