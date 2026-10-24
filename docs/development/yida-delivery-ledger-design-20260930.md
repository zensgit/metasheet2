# SA-05B1：宜搭逐行发送账本与未知结果保护

日期：2026-09-30。本地内部存储切片合同，非发送授权，非完整 SA-05。
基线 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` 叠前序未提交切片；远端核对为 `04de335490656d689361a692d044a10611cf684d`。

## 1. 边界与已有代码

- 复用 plugin 的结构化 `db.cjs` 事务/参数化 CRUD。它不开放任意 SQL，也没有可靠租约时钟；本片不增加 raw SQL 或时钟能力。
- Automation applied ledger 是同事务内部写，outbound intent 是 execution/action 身份；现有钉钉记录不承担宜搭租户/目标/逐行身份。借鉴发网前持久标记，不挪用其表或发送器。
- `credential-store.cjs` 的 fingerprint 是密文摘要，并非凭据版本或授权。SA-04 localBusinessKey 是本地查重值，并非执行身份。
- 没有新增 route、action、RPC、worker、adapter 注册、私有凭据消费者、开关或 UI 发送按钮。没有调用网络。新增运行消费者和授权边界仍须 GOV-08 独立决策；真实读取/发送/发布/迁移上线仍未授权。

本片实现内部存储及真实隔离 PostgreSQL 测试，不将未注册的 store 描述为用户已可发送。最终 SA-05 仍要求凭据代次/撤销、获准目标、一次性授权、真实回执核验及故障恢复；本片不删减这些目标。

## 2. 身份与快照

每条记录用可信调用方持久保存的 `operationId + rowKey`，加精确 `tenantId + workspaceId` 唯一。workspace 属性必须显式给 null 或非空 ID；不跨作用域回退。不接受浏览器本地键作为该身份，不根据时间、每次点击或凭据轮换重新生成 operationId。此处验证格式/相等性，不授予请求者填写这些值的权力。

首次 prepare 同时固定：ownerId、targetRef、targetRevision、planRevision、payloadDigest、businessKeyDigest、credentialRef、credentialGeneration、intent，以及 update 的显式 instanceId。摘要为完整 SHA-256；ID 是有界不透明引用，不收 payload、配置正文、URL、token、systemToken、userId 或任意 receipt body。create 不带 instanceId。

同身份同快照返回既有记录；任何内容、owner、凭据代次或配置改变均冲突，绝不取得第二次发送机会。所有读/转换以精确 tenant/workspace/owner 匹配。owner 不进入唯一键，不能通过改 owner 分裂同一 operation 行。

targetRef / credentialRef 是历史快照引用，不是 `integration_external_systems` 的运行指针：store 不加载目标/凭据，不按引用执行，不新增该表外键或删除计数。未来接线必须在可信解析后建立并持久复用引用；删除或撤销配置不能删除历史账本，更不能绕过运行前复核。本片没有证明两个不同 operationId 的远端业务幂等，未来授权层必须禁止为未决 CREATE 随意另发身份。

## 3. 单次领取状态机

```text
prepared ── claim（提交事务）──> dispatching ── acknowledgement ──> acknowledged
   │                                 └──── unknown ───────────> outcome_unknown
   └──── cancelPrepared ─────────────────────────────────────> not_sent
```

- claim 在数据库行锁下由 prepared 原子转换，铸造随机 claimToken；返回前必须提交状态和审计。只有这次成功 claim 的返回值携带本次 token，后续 claim 不再返回可执行凭证。
- 无租约、无 TTL、无超时自动重领。prepared 前崩溃仍可领取；提交 dispatching 后，无论请求实际发出与否都不得自动重发。恢复时用原私有 token 标 unknown；缺 token 时保持 dispatching 也不可重领。将来恢复扫描器另行接线。
- token 与完整作用域绑定；错误/旧 token、跨 owner/tenant/workspace、任何非 dispatching 的完成调用均拒绝。unknown 是自动执行的终态，迟到 ACK 不覆盖它；后续人工/可信远端对账是独立操作，不能复用完成接口清掉不确定性。
- cancelPrepared 仅在 prepared 可记录 not_sent；dispatching 后不能凭普通错误改成 definitely-not-sent。not_sent 同样不自动重试，另一次获准意图须由未来授权层处理。
- 本片没有 success / delivered 状态。acknowledged 仅记录协议级应答，不承诺业务落地。HTTP 200 不是最终成功证据。

## 4. ACK 与私有数据

核官方 Go SDK 固定提交 `1986c966942afc67b8ccae59d29d57989a45fe76` 的 [yida_1_0/client.go](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/yida_1_0/client.go)：SaveFormDataResponseBody 含字符串 result，UpdateFormDataResponse 只有 headers/statusCode，无可假定的 result body。

内部 ACK 合同：create 必须有明确 2xx 状态和非空有界实例 ID；update 必须有明确 2xx 状态及与原记录完全相同的请求 instanceId。仅接受这几个字段；不接受 `verified:true`、凭据、任意错误文本/原始响应。token 和远端实例 ID 保留在私有 DB，普通记录投影不返回 claimToken；审计只记录事件/状态/固定 reason，不复制业务值或原始异常。

这是可信调用方的记录合同，不是网络来源证明。之后的 SA-05C 必须从受控 transport 获得这些字段，绑定尝试并验证远端业务状态；本片不得宣称该 verifier 已存在。

## 5. 存储、迁移、回滚

候选 `088_create_integration_yida_delivery_ledger.sql`，不覆盖未发布的 087。账本与 append-only 审计两表；精确作用域唯一索引包含 `COALESCE(workspace_id, '')`，空串输入/落库均拒绝。审计以 FK RESTRICT 关联账本。全部状态变化与审计在同一真实事务；audit 失败必须回滚状态，唯一键竞争失败后的重读另起事务，不在 aborted transaction 继续查询。

仅使用现有 DB facade，在事务最前钉 READ COMMITTED，再 FOR UPDATE。状态/字段 CHECK 提供落库约束；不假设 DB 校验可代替生产 store 状态守卫。业务时间不作为领取/安全判据。数据库异常转固定 values-free 错误，不输出 SQL 参数。

迁移须先于未来运行消费者部署；当前不注册消费者，无部署动作。回滚代码时保留两表和全部未决/已应答记录，不 DROP、不将 dispatching/unknown 清成 prepared，不因停 worker 宣称撤销外部请求。

## 6. 验证与分工

实现者只负责 store/088/其 hermetic 测试；另一实现者负责 realDB suite。主审负责设计、现有 CI 泳道接线和独立运行；第三位只读审查守卫/事务/生产测试路径及内存或隔离 DB 变异。共享 worktree 不互相覆盖。

最低证据：

1. 同身份复用，内容/owner/凭据/目标变化冲突；null/workspace、租户、owner 隔离。
2. 两个真实连接争 prepare/claim，观察数据库锁等待，最多一个 committed dispatch claim；另一路 rollback 后可成功。
3. claim/audit 同事务；审计错误不得留下已领取行；ACK/audit 失败保留原状态。
4. 发网前后崩溃窗口以真实持久状态模拟，不用假 facade 代替事务；重启 store 仍拒重领，unknown 不回 prepared。
5. 错 token、错误 scope、取消与领取竞争、迟到 ACK、缺实例/错误实例/非 2xx 分别拒绝；合法 ACK 仍非 success。
6. per-row 部分完成不影响其它行；一个已完成/未知行不能重发。
7. PostgreSQL migration 实际执行、重复执行、schema 约束、零 skip；CI 独立 EXPECT_DB sentinel 防缺库假绿。node suite 进入 test-chain，真库 suite 进入既有 PG 泳道。
8. 真实生产 store/真实 db.cjs，无 route/transport；因此不把这些测试称作最终宜搭发送 E2E。独立变异先证明走到被测分支，再单独破坏约束并取得行为 RED。

真实 PostgreSQL 仅新建 disposable loopback/tmpfs 合成实例，随机进程内凭据，禁用 .env。不得连接现有库或读取/发送客户数据。

## 7. 本地实施结果

本片已落地。088 除 CHECK/唯一索引外，增加普通 DML 的冻结身份、合法单向状态和 append-only 审计触发器；不防 DB 管理员禁用约束/触发器。update ACK 与请求实例相等同时落库验证。真实库177/177（新增123）和主审两项实际DB降级变异、独立七项Node变异完成；最终Node14/14，完整245套plugin分平台通过。没有sender/认证/恢复消费者，不将此记作SA-05完整交付。

详细冻结字节、故障/限制与命令在代码 worktree 的 `docs/development/integration-self-service-yida-ledger-verification-20260930.md`。当前仍本地未发布；原目标与后续授权前置不变。

## 8. 当前基线迁入与 CREATE 永久占位（2026-10-09）

T 层内部存储收紧，`Ratified-by-default-2026-10-09`；不授权新在线端点、运行消费者、真实发送或部署。前文 §7 是旧分支历史证据。本轮在 `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074` 的当前候选迁入 store/088/两套 B1 测试，新增 089 与独立真实 PG suite。

089 固定 CREATE 的精确 `tenant + workspace(null 明确区分) + target_ref + business_key_digest` 唯一。operation/row/owner/凭据/版本/payload 变化不分割占位；五种状态全保留，包括 not_sent。UPDATE 是另一种意图，不自动由 CREATE 转换。没有释放占位或跨作用域回退入口；被取消的 CREATE 也可能因此长期阻断，未来恢复合同不能靠删历史绕开。

新业务唯一索引与原操作唯一索引都可能先报告竞争。store 只捕获精确 23505/索引名，在原事务回滚后用新事务读取原 operation/row；快照一致复用、变更拒绝，不存在则固定 BUSINESS_CONFLICT，不返回其它操作资料。089 验证现有同名对象的真实索引键/谓词、valid/ready/live/immediate、text_ops、collation、排序及表身份。存量重复拒绝迁移，不删行、合并或选赢家。

本轮最终冻结 `07794a58ed6ad9ff38e402b2a7cbd7d11fcb0da2f52ffe5e2159ca674d3961a4`：新建隔离 PostgreSQL 正式 provider 455 项迁移、重放及实际 store/db 的 123+46=169 项全部通过；100 项 Node、4 项 provenance/chain、独立严格测试类型通过；三组真实 PG 降级和三组新分支 Node 变异均产生具体行为红，随后原字节再绿。报告在当前代码工作树 `artifacts/yida-ledger-20261009/verification.md`，失败和限制保留。旧发送模块未因此自动整合，仍无 sender/runtime consumer。

这只是可信输入相同 tuple 的本地 CREATE 防重。稳定 target/业务键的生产者、持久 credentialGeneration、owner grant、实例归属和远端业务收据仍未实现；改变 key 定义或重新分配 target_ref 仍可形成另一个 namespace。因此不宣称全局业务幂等/远端 exactly-once。部署必须在后续授权下先 088/089 再消费者；回滚保留历史和唯一占位。
