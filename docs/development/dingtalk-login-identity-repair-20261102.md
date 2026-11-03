# 钉钉单账号登录身份受控修复

状态：Draft／HOLD。本轮修订以 PR #6693 当前 head 为准；原 head `6aa9a739998527c94665d5baf22da352d5c9a94f` 的 201 项记录不能替代修订验证，也不能证明旧实现可上线。

## 范围与身份依据

仅提供运维私有文件 CLI，修复现有账号的钉钉登录身份，不建立公开绑定接口。保留本地账号、角色、准入、组织成员权限、目录关联及审批记录；不切换企业、不代审批、不启用同步。

verify 同时要求有效管理员及其密码、目标账号的非临时本地密码、新鲜的当前应用钉钉资料，以及当前应用下已经关联到目标账号的活动目录证据。企业、UnionID、OpenID 证据必须相容；另一用户占用、隐藏的第二个人、企业不符、仅 OpenID 相同而 UnionID 冲突均拒绝。不按昵称、邮箱相同或管理员知道密码推定同一人。证据不足的旧 E4 关联仍阻断，不能用本工具绕过完整 E4→Canary 交接。

证明使用平台 AES-GCM 材料加密，绑定管理员凭据摘要、目标权限／准入快照、登录应用范围与一次性 nonce，五分钟过期。只输出证明文件，不签发本地会话。预览仅输出打码线索和摘要，不构成本人确认的替代。

## 执行与互斥

preview、rollback-preview、release-preview 为只读 REPEATABLE READ 事务，不加核心表写锁、不递增 generation、不创建会话，也不写审计记录（零写入测试固定）；审计行只由 apply、rollback、release 写入。权限快照包含 users、角色、角色权限、直接权限、组织、namespace admissions、外部授权、目录关联、身份键和来源。仅忽略 created_at、updated_at、last_login_at 这三类元数据。

写事务首句固定 READ COMMITTED，再取得身份维护互斥、核心表 SHARE ROW EXCLUSIVE 锁及 canonical 用户锁。这三步都在 lock_timeout 内有界等待，最多五秒，不使用 NOWAIT。等待超过 deadlock_timeout 时，冲突的 autovacuum／autoanalyze 会自行取消。其他持有者（含防回卷 vacuum）超过五秒、出现锁环，或身份维护互斥等待超过五秒，都拒绝为 `REPAIR_LOCK_BUSY`，不写任何行，可在确认无长事务后重试。按另一顺序取这些表的并发写入（目录同步、角色或权限管理写入）可能反过来被选为死锁牺牲者而中止，因此维护窗口内须暂停目录同步和角色、权限管理。apply 排队期间，其他用户的登录和令牌校验可能等待至多约五秒。CLI 仍只打印单一拒绝码 `DINGTALK_LOGIN_REPAIR_REFUSED`，不区分锁忙。statement_timeout 为三十秒。与 applied handover 双向排斥；安全解绑也不能抹掉日志中原来源的互斥依据。不修改 handover 的产品摘要规则。

apply 需精确证明摘要及 `confirm=apply`。身份旧值加密保存；写产品审计，记录的管理员为 verify 时校验密码的管理员（apply 本身不另行认证执行者）。撤销目标已存在的 JWT 会话、session registry 记录与多维表 API token，递增 generation，不倒退。OAuth／免登认证结果携带在用户锁内取得的 generation，登记 session 时重新锁定并核对；API token 创建／轮换也复核请求认证时的 generation。旧 refresh 不得重新激活已撤销 sid，无 sid 的 refresh 同样复核 generation。切换组织（POST /api/auth/session-org）重新签发会话时同样携带请求认证时的 generation，版本已变则返回 409 `authentication_changed`，不登记会话。

这不禁止修复完成后的有效新登录，也不承诺取消所有已经执行的业务请求。现有无 sid JWT 在应用节点时钟超前于数据库时，仍受既有时间水位机制限制；本轮没有修改全局 JWT 合约。生产必须完成迁移并验证时钟与会话机制，不能把本地结果称为全部凭据系统的安全证明。开发模式 RBAC_TOKEN_TRUST 不提供数据库 generation 时，API token 签发会拒绝。未提供 generation、非 production 且用户确实不存在时保留原虚拟用户会话兼容；携带 generation 的 OAuth／refresh 不可走此分支，遇 schema 错误也拒绝。原无版本调用的缺表 synthetic 兼容未改，因此仍要求完整迁移。

## 防覆盖、回退与 release

活动记录严格固定企业、UnionID、OpenID、external key 及身份归属。只有新鲜 OAuth 在同一用户锁和事务内验证同企业／同 UnionID／同应用后，才可推进 OpenID pin；目录旧 OpenID 不能自行覆盖。目录 OpenID 为空的正常成员继续使用同人登录身份补全。第二目录来源关联由数据库守卫拒绝。

rollback-preview 显示当前摘要及变动分段。后续登录、角色补齐、资料或合法权限变更不再让恢复永久无出口，但必须重新审阅和批准当前恢复摘要。rollback 只恢复本次身份旧值，保留之后的角色、准入、密码、启用标记等合法变更；拒绝未解决撤权、其他人占用或 applied handover。执行后再次撤销目标当前会话和 API token。恢复不能复活已撤销授权。

release 不恢复旧身份，也不恢复权限。有效用户必须有唯一当前应用、同企业同人的 canonical 目录来源；撤权用户可结束活动身份 pin，但撤权状态及证据保留。**release 仅解除身份 pin，目录来源约束继续生效。** released_account_ids 只保留恰好一个 canonical 账户 ID，否则为空数组；空数组会持续拒绝包括原账号在内的目录重绑。历史来源 IDs 保持不变。新来源接入、跨企业或解除此持久约束不在本轮范围，须另行设计和批准。正常受控交接移动原稳定账户 ID，不创建第二个账户。

此约束不依赖没有实际消费者的 connectionDisabled 字段，也不把 status=inactive 或 sync_enabled=false 当作手动同步／在途同步已停止的证明。具有完整有效配置、能够成功同步的旧来源，在 release 后尝试第二关联仍由真实数据库守卫拒绝；其同步批次可能失败，禁止自动解除守卫。

## 运维入口与备份

以下仅说明接口，不授权真实执行：

```sh
pnpm ops:dingtalk-login-repair verify /restricted/verify.json /restricted/proof.json
pnpm ops:dingtalk-login-repair preview /restricted/proof.json
pnpm ops:dingtalk-login-repair apply /restricted/apply.json
pnpm ops:dingtalk-login-repair rollback-preview /restricted/recovery.json
pnpm ops:dingtalk-login-repair rollback /restricted/rollback.json
pnpm ops:dingtalk-login-repair release-preview /restricted/recovery.json
pnpm ops:dingtalk-login-repair release /restricted/release.json
```

verify 输入：userId/password/code/actorId/actorPassword。preview：proof。apply：proof/digest/confirm。两种 recovery preview：id/actorId/actorPassword；执行 rollback／release 再增加 digest/confirm。输入必须为私有常规文件，无组／其他用户权限，最多 64 KiB，严格字段集；证明输出 0600 且不覆盖。凭据、授权码和证明不得进入命令参数、聊天或 PR。失败仅打印固定拒绝码。

真实窗口前必须另批：完整迁移台账、专用加密材料及可恢复配置／数据库备份、当前身份与目录证据、审批在途依赖、session/API token 影响、来源约束后续处理和维护窗口。新加密字段 `dingtalk_login_repairs.before_identity` 已登记普查和启动探测，单字段最多抽取二十行，不代表全库普查。换材料而不迁移密文会使恢复拒绝；必须保留原材料与密文备份。非空修复历史不允许 migration down，不能通过删除历史或直接拆守卫回滚。

## 本地验证与交付门槛

Node 20.20.2、本机 PostgreSQL 15.17、全新合成库；提供方仅测试桩。没有真实扫码、线上连接、真实绑定、部署、候选构建或 Mac mini 使用。

修订验证：十一文件真实 DB 组合 252 项（含原八文件 185、修复文件 57、API 路由／组织准入十项）；认证／钉钉联合单测 55 文件 1040 项；独立 todo-center 待办门槛 27 项（EXPECT_DB=1，0 跳过）。CI 合约六项、TypeScript noEmit 通过。十个其他改动运行文件定向 ESLint 通过；AuthService 的 137 行原有 no-extra-semi 在旧 head 上同样失败，本轮未改无关代码。

包含真实 refresh 屏障红转绿、旧 OAuth 认证版本拒绝、API 创建／轮换版本拒绝、RR 默认事务在用户锁等待期间新提交 token 的撤销、首次登录补角色后的恢复、无变化同步后的恢复、缺 OpenID 绑定／解绑、OpenID 轮换后旧目录拒绝、release 前同步成功正对照及其后精确拒绝、隐藏第二人／UnionID 冲突拒绝、加密字段探测及密钥变化后恢复拒绝／原密文恢复。真实行为优于仅检查 generation 值。

CI 修正（承接 34bcb2c8）：两处私有 schema 的合成 users 表补齐 `access_generation`（与 zzzz20260724170000 一致）；修复套件改用每个夹具独立的组织，不再向 'default' 留下关联用户；真实 DB 加密存储探测固定清单加入 `dingtalk_login_repairs.before_identity`（含当前／旧材料两行）。本地同一 PostgreSQL 15.17：修复文件 63 项；十一文件组合 258 项（原 252 加组织切换 3 项、锁等待 3 项）；approval-db 全部 102 文件按 CI 顺序 1424 通过，余 5 项为本机 worktree 无法运行 `pnpm` 子进程及一次瞬时连接重置，单独复跑通过；multitable 加密探测 11 项；YiDa owner／初始化 HTTP 与运行时 60 项（两份浏览器文件需固定 Chromium，未在本机运行）。

锁修正（承接 94576920）：身份维护互斥移入同一错误映射，锁超时与死锁牺牲均拒绝为 `REPAIR_LOCK_BUSY`。新增两项真实 DB 用例（锁环、互斥等待超时），在旧实现上分别得到原始 `deadlock detected` 与 `canceling statement due to lock timeout`。本地同一 PostgreSQL 15.17：修复文件 65 项；十一文件组合 260 项；认证单测 8 文件 312 项。

执行命令和当前 head／CI 结论保存在本地 FINAL-VERIFICATION.md。以上为本地验证，未宣告当前 head 的十三项必需 CI 通过。合并、部署、真实绑定、E4 交接、审批处置、停用和启用同步仍需单独批准。
