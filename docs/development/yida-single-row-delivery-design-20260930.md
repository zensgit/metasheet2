# SA-05C1：单行发送协调与协议应答（内部合成接线）

日期：2026-09-30；代码基线 b35d4cd1fbaa50d0cf15e1a75745f77624a9468a 叠 SA-01～05 本地切片。此决策只冻结内部组合机制，不批准新 runtime consumer、真实发送或生产授权方式。

## 1. 范围和不能借用的权限

本片把实际 v2 planner、实际 delivery store、已配置 token client、固定宜搭协议接成单行最多一次业务请求；只用合成 private provider/fetch 验证。没有 route、action、worker、adapter 注册、host capability、UI 发送按钮、默认 fetch、env 读取或新开关。开关回调缺省 OFF，只有 exact-literal `'true'` 可进入内部流程；它不是授权。

检查到的 C6 确认（external-write-dry-run.cjs:156-204）、B2a 来源读取 claim（b2a-trial-registry.cjs:1170-1189）、私有 SQL facade（data-source-plugin-facade.ts:617-637,912-933）和组织群通知均不能原样授权宜搭写入。强制注入 `resolveExecutionSnapshot` 是未来可信 authority 的边界假设；本片不实现其持久权限来源，不以 callback 成功、普通对象或 verified:true 声称已经证明 owner 同意。

真实运行继续等待独立 GOV-08 端口/授权决定、持久 grant 与 credentialGeneration、服务器稳定 operation/row 身份、未决 CREATE 禁止换身份重发，以及最后复核到 socket 之间撤权的线性化合同。重复复核只缩小窗口，不解决跨进程授权原子性。

## 2. 两个内部 API

`createYidaDeliveryRunner({db, context, resolveExecutionSnapshot, tokenClient, formTransport, readEnablement?, wallClock?, timeoutMs?})`（ESM）。db 传给实际 createYidaDeliveryStore，不注入假 store。context 固定 tenantId、显式 workspaceId(null 或 ID)、ownerId、actorId，首版只容许 actorId===ownerId；constructor 不接受管理员/服务身份旁路。context 必须由未来可信宿主提供，不从请求体/事件声明取。

返回 `run({operationId,rowKey}, {signal}?)`；输入不收目标、凭据、payload、scope、approved 或 grant 覆盖。每实例只运行一个在途 attempt；第二个返回固定 BUSY，不排无界队列。timeoutMs 默认 10000、10..60000；signal 只收本 realm 直接原生 AbortSignal，拒 Proxy/继承。依赖无默认实现。

`createYidaFormTransport({fetch, readEnablement?})`（CJS），返回单次 `send({intent,data,accessToken,systemToken,userId}, {signal})`。它是私有机制，不授予执行权；消费者将来仅应由 runner 持有。自身也 exact-literal `'true'` 才允许调用 fetch，无默认 fetch/URL 覆盖。token/表单身份与许可依赖 runner 和未来 authority，不能把单测注入开关当权限证明。

## 3. 完整执行快照

resolver 输入为固定 context + operationId/rowKey，以及内部 signal；每次返回闭集 own-data：

```text
tenantId workspaceId ownerId actorId operationId rowKey
grantRef expiresAt targetRef targetRevision planRevision
credentialRef credentialGeneration config row systemToken userId
instanceId（仅 update 必填；create 不得有）
```

ID/revision 与账本一致，1..128 无控制/首尾空白；generation 1..2147483647；expiresAt 正安全整数 epoch ms，必须严格晚于有限且不倒退 wallClock。systemToken 非全空白、最多4096，userId 非全空白、最多128，保持字节，不 trim。context/op/row 必须精确相等。未来 generation 必须覆盖 appKey/appSecret/systemToken/userId 的改变，不能拿现有密文 fingerprint 或 updatedAt 代替。

config 必须为现有 v2；row 为一条源行。先做严格结构/深度/节点/UTF-8预算与负零检查，再用已有 strict canonical codec 复制/冻结，防 canonical 将 -0 变0后绕过 planner。最大快照256KiB、深度12、4096节点；未知字段、getter、Proxy、非有限数、异常原型/稀疏数组拒绝。调用实际 planner，必须恰有一个无错误行及数据 DTO；不改其 canApply:false、remoteState:unverified。update 的 resolver instanceId 必须与实际计划实例相同，不能仅相信普通源行里的实例属于获准表单。

内层表单 JSON 用同一 stableCanonicalStringify 产生并冻结；发送原封复用这份字符串。payloadDigest 为 SHA256(stableCanonicalStringify({version:1,grantRef,expiresAt,actorId,targetRef,targetRevision,planRevision,intent,data,formUuid}))；data 是实际发送的数据字段（含 canonical 内层 JSON），formUuid 在 update 请求之外仍绑定受审表单。businessKeyDigest 是 SHA256(planner 的 localBusinessKey)。不信调用方给 digest，密钥不进入这两个持久摘要。

每次 resolver 重新构建/冻结并比较完整快照（包括 grant、有效期、配置/源行、systemToken/userId），任意变化即拒绝；不要只比 targetRevision 字符串。完整快照只在本次私有执行内，普通结果不返回。

## 4. 执行顺序与故障语义

```text
OFF/取消/输入拒绝 -> 零 resolver/DB/token/业务调用
初次私有快照 -> 实际 planner/摘要 -> prepare
已有非 prepared 行 -> 返回原持久状态，不取 token、不再业务发送
prepared -> token（不自动 activate） -> 再次私有快照比对
-> claim 事务提交 -> 最后私有快照比对/开关/取消/期限检查
-> 固定业务请求至多一次 -> 协议 ACK 持久化
```

token 放在 claim 前：现有088不允许 dispatching 回 not_sent/prepared，不能为方便而新增回退。任何 token/预检失败不调用业务接口；prepared 保留，未来仍须新的有效授权才能再次进入。

- claim 抛错未拿到 claimToken：固定 CLAIM_UNCONFIRMED，不发送、不重 claim；可能已提交 dispatching，不能假称回滚成功。
- claim 后尚未业务调用的取消/期限/开关/快照拒绝：用私有 claimToken 尝试一次 markUnknown(manual_recovery)，externalWriteAttempted=false；不调用 cancelPrepared、不重领。
- 调用了业务 transport 后的网络异常、取消或超时：一次 markUnknown(transport_unknown)；畸形协议应答使用 receipt_invalid。绝不自动重发，包括刷新 token 后重发。
- ACK 存储抛错：一次 get 观察实际状态；已 acknowledged 可如实报告协议应答持久化，否则尝试一次 markUnknown(commit_unknown)。不重复 ACK，不发送第二次。unknown 写入也失败时报告 state_unconfirmed/durable=false，不能宣称已经持久化 unknown。
- 超时/取消通过内部 signal 传递，并在每次 await 后检查。DB/transport 忽略 signal 时 run 保持在途、保留 BUSY，直到依赖结束后收尾；不 race 丢弃晚到 claimToken、不放出第二个名额。不承诺 HTTP 用户及时返回或物理中止供应商处理，未来运行端口需要另接状态反馈。

结果固定为 `{status, externalWriteAttempted, businessVerified:false, durable, record}`；status 为观察到的账本状态或 state_unconfirmed，record 是既有安全投影/null，无 claimToken、实例、payload、grant、秘密和上游异常。前 claim 固定 YIDA_RUN_* Error；claim 不明也固定 Error。单次历史相等/claim 不等于跨任意 operation 的业务 exactly-once。

## 5. 固定线协议与 ACK 含义

本轮实读官方 SDK 固定提交 [1986c966 的 yida_1_0](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/yida_1_0/client.go#L28678) 与所固定依赖 [gateway-dingtalk v1.0.2](https://github.com/alibabacloud-go/gateway-dingtalk/blob/v1.0.2/client/client.go#L32)。create POST、update PUT，固定 `/v1.0/yida/forms/instances`；data 三字段与既有 planner 一致，再加 systemToken/userId；header x-acs-dingtalk-access-token，JSON Content-Type/Accept。HTTPS 是本地强制安全策略，不能宣称该生成 SDK 默认就是 HTTPS。

transport 在参数/信号/开关验证后才 fetch，redirect:error；任何3xx/redirected拒绝，不自动重试。使用实际 Response，字节上限16KiB、读取最多16385次、严格UTF-8；正文/错误不进入日志或异常。请求body最多256KiB。凭据不trim，token禁止控制字符和首尾空白；data只接受实际create/update三个字段，内层JSON必须为1..32平面有限标量字段，不能带任意URL/header/path。

create：接受2xx且JSON顶层有合法有界字符串result，得到实例ACK；update：接受2xx、消费有界正文后只得到HTTP ACK，实例沿用请求身份。SDK update 无 modeled body不等于正文必须零字节，因此不虚构空正文限定或猜一个 success 字段。返回 `{statusCode,instanceId}`，两者都只是协议应答，**不是远端表单归属、读后数据或业务成功证明**。update 的 instanceId 不是供应商返回或比对成功。若供应商200内含业务错误，本片没有可证明的完整错误包合同，因此ACK不得被UI/消费者映射为业务成功；最终SA05仍需独立读后业务回执/对账，不能省略。

## 6. 验证及停止线

两模块分别实现，独立作者写实际 planner/store/token/exchange/formTransport 的合成组合和隔离真实 PostgreSQL 故障测试。未来authority及两个外部fetch为明确替身；不能替换生产store/协调器守卫后宣称真实事务或授权已证明。至少核默认OFF、owner/context、expired/变更/取消、同身份双runner并发一次、claim commit响应丢失、迟到claim、ACK落账失败/commit后异常、unknown落账失败、重启不重发、update实例与无业务成功标记。

新Node进入真实test-chain；新DB整文件进入既有PG泳道，sentinel不许skip绿；本地主审只用新建loopback/tmpfs随机凭据PG，不读.env或现有数据库。独立变异须先证明真路径再故意断线。最终候选修改workflow时只按实际模块重算相关provenance pin。

回滚撤掉未注册runner/transport及新测试登记，保留088历史，不清理dispatching/unknown，不把停代码当撤销远端请求。本片不交付在线用户发送，不完成SA05/06，不替代待批准的真实authority合同。

## 7. 当前整合续记（2026-10-09）

旧C1模块已迁入afd32b704当前候选，见目标§128。没有改变本合同的authority假设或新增消费者。runner和transport最小修复普通异步控制值观察：只观察本realm直接Promise且无own constructor、非Proxy，捕获观察异常；依赖constructor/species不执行。新增9例中6个修前致红、3个子类正控，修后全宜搭416项通过。恶意依赖预先制造拒绝/改全局原型不在隔离保证内。

原PG保留22项，加当前089五状态防换operation/revision/generation、真正不同键与锁争用，以及真实090 host加密/loader组合，形成44项；全部五PG文件351/351。旧“unknown换operation还能第二次发送”的限制正例已被当前089正确改为拒绝，但target/业务键物理归属仍待，非全局exactly-once。090仍只提供token材料，systemToken/userId与grant的测试来源明确合成，不给私密列新读口；091 metadata/不可发送状态不提升为execution authority。

实际Node原生ESM变异覆盖完整snapshot、postclaim复验、ACK落库、业务键不能混入operation。逐项因果与伴随失败在candidate `artifacts/yida-runner-20261009/verification.md`，不是只数红。冻结391路径manifest `e91fdbbc3595f5215ca288cc84f7e4cb852552bace9ee581b9cb3951c5cc7c9e`；同字节最终351重跑通过，无客户读取/外发/提交/部署。线上grant、业务回执、未知恢复和最后复验至socket仍未完成。
