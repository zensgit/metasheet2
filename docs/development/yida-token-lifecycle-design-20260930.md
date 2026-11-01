# SA-05A1：宜搭应用 token 的内部生命周期

日期：2026-09-30。基线 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` 叠前序本地切片。本片是可测试、未注册的内部模块，不是发送授权或完整 SA-05。

> 2026-10-09：§7补当前afd32候选的持久材料实现决定，目标文件§126记录本地验证；原§1–6的“无表/无durable provider”等为旧阶段边界。当前仍无运行消费者或发送授权。

## 1. 独立决策及不做的事

现有 core 钉钉 token client 的 key 是 appKey/baseUrl，invalidate 只清已完成缓存；未完成请求仍能回填（`packages/core-backend/src/integrations/dingtalk/client.ts:419-492`）。现有 credential-store fingerprint 来自密文且截断（`plugins/plugin-integration-core/lib/credential-store.cjs:174-178,201-205`），不能冒充单调凭据版本。

本片新增 CJS 生命周期及固定协议 exchange helper，借鉴取消/重定向模式，不改已有钉钉调用者。双方均必须显式注入依赖，禁止自动读取 env、创建凭据 store、使用隐式 global fetch 或默认联网。不接 route、RPC、worker、Automation action、UI 发送按钮、plugin capability 或真实 credential loader。没有新开关、表或授权决定。

未来可信私有消费者、持久 credentialGeneration、目标授权、一次性发送、业务回执及跨进程撤销仍需单独 GOV-08 合同与接线；本片的相等检查不是权限校验。测试依赖均为合成对象/响应，不调用真实 token 接口。真实读取、发送、发布、合并和部署仍需单独授权。

## 2. 固定官方协议

依据[钉钉企业内部应用 token 文档](https://open.dingtalk.com/document/orgapp/obtain-the-access_token-of-an-internal-app)和官方 Go SDK oauth2_1_0 的 GetAccessToken 模型（公开版本 v1.7.46）：

- 固定 HTTPS `api.dingtalk.com` 的 `POST /v1.0/oauth2/accessToken`，JSON appKey/appSecret；两项在本地安全合同中均必填。官方 appSecret 可选不代表本片允许无 secret。
- 成功为 HTTP 200，正文顶层 accessToken 字符串、expireIn 整数秒。官方示例/说明的 7200 秒不能代替响应有效期；不猜测缺失 TTL，不把短 TTL 延长。
- 它是应用 token，不是用户 OAuth 授权码，不是宜搭 systemToken 或 userId，也不是新组织 token 的 snake_case 合同。
- helper 只接受固定字段，不开放 URL/path/header/body 覆盖；redirect:error，且响应 redirected/非 200 在读正文前拒绝。正文流限制 16 KiB，声明长度非法或超限也拒绝；中断时取消 reader，错误不携带上游内容。
- 流读取最多 16385 次（覆盖 16 KiB 每次一字节及末次 done），空 chunk 不累积；超量固定拒绝。仅限总字节而不限制空 chunk，会留下无界容器/微任务循环，不能靠 timeout 定时器兜住。
- token 1–8192 字符、无控制字符/首尾空白；expireIn 为 1–86400 的安全整数（86400 是本地拒绝上限，不是供应商承诺）。未知响应字段不进入返回值。appKey/appSecret 非空非全空白、各不超过 4096 字符；保留有效字符串的首尾空格，不 trim。

## 3. 内部 API 与有界控制状态

`createYidaTokenClient({loadCredential, exchangeToken, monotonicNow?, maxBindings?, maxOutstandingFlights?, maxWaitersPerFlight?, refreshTimeoutMs?, safetySkewMs?})`。

- activate(binding)、revoke(binding)、getAccessToken(binding, {signal}?)、dispose()。binding 固定包含 tenantId、显式 workspaceId(null 或 ID)、ownerId、credentialRef、credentialGeneration；ID 使用与账本一致的有界不透明格式，generation 为 1..2147483647。
- key 是上述四项身份的无歧义元组，不包含 generation。未 activate 不可读取；getAccessToken 不自动注册/推进代次。activate 同有效代次幂等，更低代次拒绝；撤销后相同代次不可复活，重新授予须更高代次。revoke 仅能作用于精确当前代次，旧请求不能撤销新代次。
- maxBindings 默认 64、范围 1..256；控制记录/撤销墓碑直到 dispose 不淘汰，容量满拒绝新增。不能用 LRU 让旧代次复活。
- maxOutstandingFlights 默认 8、范围 1..64；maxWaitersPerFlight 默认 64、范围 1..256。已取消但依赖尚未结束的工作仍计入 outstanding，不能反复取消绕过上限。无自动重试。
- 返回 token 仅供未来可信消费者；API 不提供缓存/凭据枚举或序列化导出。dispose 永久关闭实例；新实例不是持久撤销证明。

## 4. 私有 provider 与并发不变式

loadCredential(binding, {signal}) 必须由未来可信提供方验证活跃授权，并返回精确 binding 加 appKey/appSecret。当前测试实现不被描述为生产权限。每个 flight 先加载：即使 token 尚未过期，也不能跳过 provider 验证。并发同身份/代次共用这一完整 flight。

首次有效材料用进程私有随机密钥 HMAC 登记在当前代次，后续同代次材料变化拒绝、清缓存；不保存原 secret 为长期缓存、不借现有 ciphertext fingerprint。轮换须推进代次。交换成功后再次加载并核对绑定/代次/材料，才可发布 token；provider 拒绝/异常时清缓存并返回固定错误。

activate 更高代次、revoke、dispose 立即清缓存并中止旧 flight。每次 await 后及缓存写入/每个 waiter 返回前，重验 entry 身份、generation、flight 身份、取消和到期；晚到 provider 不触发 exchange，晚到 token 不发布/回填，旧 finally 不删除新 flight。

调用者 signal 只取消自己的等待；最后一位 waiter 退出才取消共享工作。实例轮换/撤销/超时取消全部旧 waiter。即使依赖忽略 AbortSignal，等待方也及时失败；底层无法强制停止，因此继续占 outstanding 直到真正结束。signal.reason 不进入错误。

取消的两层合同不得混淆：exchange helper 不用 Promise.race 提前丢弃尚未完成的 fetch/read；它传递 signal、取消 reader，并在实际 await 前后核中断。如果依赖忽略中断，helper 的 Promise 保持 pending 直到依赖真实完成，随后丢弃结果。及时失败由 lifecycle 的 waiter 层保证；否则 helper 提前 reject 会让 lifecycle 错误释放 outstanding，而底层仍在运行。两模块组合测试必须覆盖这一点，不另造第二个独立限额器。

这里的“完成”是等待的 fetch/read Promise 结算，不是网络 socket 已物理断开的证明；reader.cancel 是尽力清理，不能替任意注入实现证明底层取消已完成。未来受控 transport 仍须提供其真实资源边界，本片不宣称能强制终止恶意同进程依赖。

## 5. 时间、值与错误

- 默认 performance.now 单调时钟，注入时钟必须有限、非负且不倒退，坏时钟拒绝并清缓存。
- TTL 从 exchange 调用开始计算，扣 safetySkewMs（默认 30000，允许 0..120000）；不设最短缓存期。响应到达时已无有效期就拒绝。refreshTimeoutMs 默认 10000，范围 10..60000，覆盖加载、exchange 与第二次加载。
- 参数、provider 结果、协议结果按闭集 own-data 属性校验（不得执行 getter，拒绝继承/额外输入）；HTTP 正文先按 JSON 解析后抽取协议字段。返回固定 token 字符串，不混入 receipt 或业务成功标志。
- 调用者 signal 仅接受本 realm 的直接原生 AbortSignal，先拒绝 Proxy 与继承实例，再调用 intrinsic getter；不能只靠 getter 作品牌检查。同步 abort 监听器能合法推进新代次，因此 activate 必须先发布新状态再取消旧 flight，不能把监听器已作出的更新覆盖回去。
- 错误是固定 code/message，无原异常、cause、response body、URL、身份值、secret、token、signal.reason；没有日志。自有 HMAC 密钥在 dispose 清零，但不承诺 JS 字符串物理擦除。
- 本地撤销无法收回已经交付给消费者的 token，不能替代服务端/供应商撤销。多进程、重启、durable provider 与发送前最后授权尚未验证，必须写在报告中。

## 6. 验收和回滚

分别实现 lifecycle 与 fixed exchange，独立测试/审查；主审把两套测试登记真实 test-chain 并验证 provenance。合成测试需通过真实函数，覆盖跨租户/owner/workspace、代次推进/墓碑、cache-hit provider 拒绝、同代次材料漂移、加载/交换晚到、独立取消/最后取消、超时/容量、短 TTL/倒退时钟、重定向、流体积和脱敏。再做两模块实际组合的正负例，不能只让 exchange 假件返回成功。

独立内存降级变异必须先证明用例经过被改生产路径，再记录行为失败；冗余守卫遮盖如实报告。内部模块无消费者，回滚移除模块/测试登记即可，不改变线上凭据、既有钉钉流程或数据库。未发布前不声明远端 CI 通过。

## 7. 持久材料切片决定（2026-10-09）

T 层内部实现决定 `Ratified-by-default-2026-10-09`，仅本地开发/合成验证：新增专用 `090` 和未注册的 `createYidaCredentialMaterialStore`，迁入原 token lifecycle/fixed exchange 的实际模块与测试；不增加消费者、端点、网络默认实现、flag 或发送权限。前文无 durable provider 的表述是历史基线；本片补材料有效性，不补活跃执行授权。

- 两表而非历史密文仓库：当前材料行永久保留服务端生成 ref、固定 tenant/显式 workspace/owner、代次和状态；独立 append-only 审计保留生命周期事件，不含材料/密文/fingerprint。只保留当前一份加密材料，轮换覆盖，撤销擦除。无历史秘密恢复能力，也不声称物理介质/备份中的旧字节已擦除。
- appKey/appSecret/systemToken/userId 全部进入同一代次；前三项最大4096字符、userId最大128字符，与既有单行合同一致。保留有效材料原始字节。用户不能选择 ref 或安装代次；expectedGeneration 仅 CAS。READ COMMITTED + 行锁后严格 +1，旧请求不能撤销新代。撤销同代状态并清空密文，因此整数上限仍可撤销；恢复必须完整新材料与更高代次，不能同代复活。
- 强制真实宿主 security，通过现有 credential-store 复用平台 `enc:`；缺服务或 plaintext/v1 一律拒绝。加密 JSON 包含 purpose/schemaVersion/完整五项 binding/四项材料，解密后逐项精确匹配。这是加密封包绑定，不冒称平台提供 AAD。平台主密钥轮换尚未覆盖新表；此处材料换代不等于平台主密钥重包。
- 材料与 values-free 审计同事务；普通 DML 触发器禁止自选初代、跳代/降代、同代改材料/恢复、改身份、删除/清空；不以此防恶意同进程或 DB 管理员。COMMIT 未确认返回固定不可用，不自动重试或宣称回滚。
- 固定可信 context 不可由未来请求体/header 决定；查库无 workspace 回退、无 admin 绕过。`loadTokenCredential` 只投影 binding + appKey/appSecret，当前不提供完整材料读取接口。create/inspect 的 metadata 另有 status，构造 token binding 必须剥离它，不放宽 token-client 闭集合同。
- 持久 loader 组合缓存命中前和交换后复验，覆盖新实例/独立连接后的旧代拒绝；并发 waiter 共享一个 flight。最后 DB 校验与交付 token 之间仍非跨进程原子撤销；不收回已交付 token，不等于发送前授权。
- 稳定物理 target/远端组织与表单归属证明、冻结业务键定义、operation/row 持久生产者仍是 runner 接线前硬门。089 只防精确 tenant/workspace/target/digest 元组，不宣称跨 workspace 或重建目标后全局去重。成功 token 不证明上述身份；不猜测回填旧账本或释放历史占位。

测试要求：生产 db/store/security + owned PostgreSQL；独立会话真实锁争用、四项换代、撤销/ABA、审计失败、COMMIT 回执丢失、密文跨行移植、实际 token client 缓存前/交换后拒绝。外部 exchange 只用合成依赖，禁止真实凭据/网络。没有执行正式部署；090 的部署/备份/主密钥重包与新增运行消费者另行授权，回滚不得删除材料身份/审计墓碑。
