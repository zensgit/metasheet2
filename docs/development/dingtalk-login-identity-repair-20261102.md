# 钉钉单账号登录身份受控修复

状态：Draft／HOLD。本轮修订以 PR #6693 当前 head 为准；原 head `6aa9a739998527c94665d5baf22da352d5c9a94f` 的 201 项记录不能替代修订验证，也不能证明旧实现可上线。

## 范围与身份依据

仅提供运维私有文件 CLI，修复现有账号的钉钉登录身份，不建立公开绑定接口。保留本地账号、角色、准入、组织成员权限、目录关联及审批记录；不切换企业、不代审批、不启用同步。

verify 同时要求有效管理员及其密码、目标账号的非临时本地密码、新鲜的当前应用钉钉资料，以及当前应用下已经关联到目标账号的活动目录证据。企业、UnionID、OpenID 证据必须相容；另一用户占用、隐藏的第二个人、企业不符、仅 OpenID 相同而 UnionID 冲突均拒绝。不按昵称、邮箱相同或管理员知道密码推定同一人。证据不足的旧 E4 关联仍阻断，不能用本工具绕过完整 E4→Canary 交接。目录证据必须已存储 UnionID：目标账号在当前应用下任一活动的钉钉目录关联缺少 UnionID 时，verify 在调用钉钉之前即以 `REPAIR_DIRECTORY_UNION_ID_REQUIRED` 拒绝（apply 同样复核）；仅 OpenID 相同（同应用亦然）不构成同人证据；UnionID 存在而目录 OpenID 为空的来源仍可作为证据。当前应用、同企业、同 UnionID 且仍关联到目标账号的活动钉钉来源必须恰好一个，多于一个以 `REPAIR_CANONICAL_SOURCE_REQUIRED` 拒绝。身份来源检查、journal 来源、release 允许列表与目录守卫只覆盖 `provider='dingtalk'` 的目录账号；本地目录账号保留在审批快照与摘要中，不受围栏约束。

证明使用平台 AES-GCM 材料加密，绑定管理员凭据摘要、目标权限／准入快照、登录应用范围与一次性 nonce，五分钟过期。只输出证明文件，不签发本地会话。预览仅输出打码线索和摘要，不构成本人确认的替代。

## 执行与互斥

preview、rollback-preview、release-preview 为只读 REPEATABLE READ 事务，不加核心表写锁、不递增 generation、不创建会话，也不写审计记录（零写入测试固定）；审计行只由 apply、rollback、release 写入。权限快照包含 users、角色、角色权限、直接权限、组织、namespace admissions、外部授权、目录关联、身份键和来源。仅忽略 created_at、updated_at、last_login_at 这三类元数据。

写事务首句固定 READ COMMITTED，再取得身份维护互斥、核心表 SHARE ROW EXCLUSIVE 锁及 canonical 用户锁。这三步不使用 NOWAIT，每次加锁都在 lock_timeout（五秒）内有界等待；lock_timeout 按单次加锁计时，核心表一步要取 13 把锁，有多个持有者时等待会累加（实测两个持有者时约 9 秒才拒绝），整条语句最多到 statement_timeout（三十秒）为止。等待超过 deadlock_timeout 时，冲突的 autovacuum／autoanalyze 会自行取消。其他持有者（含防回卷 vacuum）使某次加锁超过五秒、出现锁环，或身份维护互斥等待超过五秒，都拒绝为 `REPAIR_LOCK_BUSY`，不写任何行，可在确认无长事务后重试；lock_timeout 按单次加锁计时，statement_timeout 按单条语句计时，事务没有总时限：锁阶段的互斥、核心表锁和用户行锁（每个用户一条）语句各自受这两个限制，之后每条语句各自不超过三十秒。锁阶段内单条语句（如 13 张表的 LOCK TABLE）累计等待达到三十秒时，服务端以 57014 取消，同样映射为 `REPAIR_LOCK_BUSY`，不写任何行；锁阶段之后的语句被服务端以 57014 取消时，CLI 打印 `REPAIR_STATEMENT_TIMEOUT`，事务已回滚。维护 CLI 进程自行要求客户端读超时不低于 max(45000, DB_STATEMENT_TIMEOUT+15000) 毫秒：未设置时自动采用该值；显式低于该值或无法解析（DB_STATEMENT_TIMEOUT 无法解析时同样）以 `REPAIR_CLIENT_TIMEOUT_TOO_LOW` 拒绝，且在建立连接池之前拒绝，不连接数据库；连接池建立后再核对其实际持有的值，不足同样拒绝。客户端读超时同时不得超过 2147483647 毫秒（2^31−1，Node 定时器可设的最大延迟；更大的值会被 Node 当作 1 毫秒，查询几乎立即以读超时结束，每次运行都成为「结果未知」）：显式值超过该上限，或 DB_STATEMENT_TIMEOUT 大到下限超过该上限（例如 PostgreSQL 自身的最大值 2147483647），以 `REPAIR_CLIENT_TIMEOUT_TOO_HIGH` 拒绝，同样在建立连接池之前拒绝、不连接数据库；连接池建立后的核对也检查该上限。应用进程参数不变。因此服务端超时先于客户端超时到达；客户端读超时（`REPAIR_CLIENT_TIMEOUT`，退出码 69）表示结果未知，须先读 journal。按另一顺序取这些表的并发写入（目录同步、角色或权限管理写入，以及登录写入，含钉钉 OAuth 登录：它锁用户行并写身份行，缺少 corpId 时还锁整张身份表）可能反过来被选为死锁牺牲者而中止，因此维护窗口内须暂停目录同步和角色、权限管理；期间个别登录也可能因此失败，需要重试。apply 排队期间，需要写这些表的请求会跟着等待，例如其他用户的登录：只有一个持有者时约五秒，多个持有者时更久，最长到 apply 被拒绝为止。令牌校验本身只读，不排队；只有在需要为该用户首次补齐考勤自助角色、写入 user_roles 时，才会像登录一样等待。与 applied handover 双向排斥；安全解绑也不能抹掉日志中原来源的互斥依据。不修改 handover 的产品摘要规则。

apply 需精确证明摘要及 `confirm=apply`。身份旧值加密保存；写产品审计，记录的管理员为 verify 时校验密码的管理员（apply 本身不另行认证执行者）。撤销目标已存在的 JWT 会话、session registry 记录与多维表 API token，递增 generation，不倒退。OAuth／免登认证结果携带在用户锁内取得的 generation，登记 session 时重新锁定并核对；API token 创建／轮换也复核请求认证时的 generation。旧 refresh 不得重新激活已撤销 sid，无 sid 的 refresh 同样复核 generation。切换组织（POST /api/auth/session-org）重新签发会话时同样携带请求认证时的 generation，版本已变则返回 409 `authentication_changed`，不登记会话。强制改密（POST /api/auth/password/change）重新签发会话时也携带请求认证时的 generation；版本已变则返回 409 `authentication_changed`，提示用新密码重新登录，不登记会话，已写入的新密码和会话撤销保留。

这不禁止修复完成后的有效新登录，也不承诺取消所有已经执行的业务请求。现有无 sid JWT 在应用节点时钟超前于数据库时，仍受既有时间水位机制限制；本轮没有修改全局 JWT 合约。生产必须完成迁移并验证时钟与会话机制，不能把本地结果称为全部凭据系统的安全证明。开发模式 RBAC_TOKEN_TRUST 不提供数据库 generation 时，API token 签发会拒绝；非 production 的信任声明模式下，用户的 generation 一旦变动，切换组织也会返回 409。未提供 generation、非 production 且用户确实不存在时保留原虚拟用户会话兼容；携带 generation 的 OAuth／refresh 不可走此分支，遇 schema 错误也拒绝。原无版本调用的缺表 synthetic 兼容未改，因此仍要求完整迁移。

## 防覆盖、回退与 release

活动记录严格固定企业、UnionID、OpenID、external key 及身份归属。只有新鲜 OAuth 在同一用户锁和事务内验证同企业／同 UnionID／同应用后，才可推进 OpenID pin；目录旧 OpenID 不能自行覆盖。目录 OpenID 为空的正常成员继续使用同人登录身份补全。第二目录来源关联由数据库守卫拒绝。

rollback-preview 显示当前摘要及变动分段。后续登录、角色补齐、资料或合法权限变更不再让恢复永久无出口，但必须重新审阅和批准当前恢复摘要。rollback 只恢复本次身份旧值，保留之后的角色、准入、密码、启用标记等合法变更；拒绝未解决撤权、其他人占用或 applied handover。执行后再次撤销目标当前会话和 API token。恢复不能复活已撤销授权。

release 不恢复旧身份，也不恢复权限。release 分两种模式，两者都从 journal 记录的来源 ID 重新读取并核实真实目录账号与集成（历史 ID 本身不是证据）：被核实的是 apply 时记录为 `canonical_account_id` 的那一行（apply 预览中显示为 canonicalAccountId），其余 journal 来源 ID 只重新读取，用于发现被其他用户占用的情形。可登录用户（授权开启、钉钉身份存在、账号可登录）走 canonical 模式：必须恰好有一个当前应用、同企业、同 UnionID、活动且仍关联到该用户的钉钉来源，否则 `REPAIR_CANONICAL_SOURCE_REQUIRED`（可 rollback、重绑原账号或撤权后终结）。已撤权用户（授权关闭、身份已删、账号停用／回收站／未激活）走终结模式：只接受恰好一个同企业、同应用、同 UnionID 的原来源（来源 inactive 允许，不恢复其活跃状态），否则 `REPAIR_HISTORICAL_SOURCE_UNVERIFIED`；终结不重新启用授权、不恢复身份、不恢复关联、用户状态、权限、组织成员或旧会话，撤权状态与证据保留。两种模式都拒绝：登录应用或企业已变（`REPAIR_LOGIN_SCOPE_CHANGED`）、同企业同 UnionID 的目录行被其他用户占用（`REPAIR_DIRECTORY_OWNER_CONFLICT`）、其他用户持有该人的钉钉身份（`REPAIR_IDENTITY_CONFLICT`）、用户名下仍有名单外的钉钉关联（`REPAIR_SOURCE_OUTSIDE_ALLOWLIST`，含 inactive 旧关联，须先安全解绑；解绑会删除同 UnionID 身份并使 release 走终结模式）。拒绝时不写任何行。**release 仅解除身份 pin，目录来源约束继续生效。** released_account_ids 恒为恰好一个账户 ID，数据库 CHECK 拒绝空数组、NULL 与含 NULL 元素的数组；历史来源 IDs 保持不变。release-preview 输出 mode、releasedAccountIds、linkedDingTalkAccountIds、localLinkCount，并把当前登录 scope、最终名单与重新读取的来源行绑定进摘要，执行时在锁内重算，任何变化拒绝为 `REPAIR_RECOVERY_SNAPSHOT_CHANGED`。来源删失、换应用、企业／人员归属改变或被他人占用属于本版明确不支持的恢复范围（journal 停在 applied；已撤权用户的 rollback 也被拒绝），须另批受控重锚。新来源接入、跨企业或解除此持久约束不在本轮范围，须另行设计和批准。正常受控交接移动原稳定账户 ID，不创建第二个账户。

此约束不依赖没有实际消费者的 connectionDisabled 字段，也不把 status=inactive 或 sync_enabled=false 当作手动同步／在途同步已停止的证明。具有完整有效配置、能够成功同步的旧来源，在 release 后尝试第二关联仍由真实数据库守卫拒绝；其同步批次可能失败，禁止自动解除守卫。

## 运维入口与备份

以下仅说明接口，不授权真实执行：

```sh
pnpm --silent ops:dingtalk-login-repair verify /restricted/verify.json /restricted/proof.json
pnpm --silent ops:dingtalk-login-repair preview /restricted/proof.json
pnpm --silent ops:dingtalk-login-repair apply /restricted/apply.json
pnpm --silent ops:dingtalk-login-repair rollback-preview /restricted/recovery.json
pnpm --silent ops:dingtalk-login-repair rollback /restricted/rollback.json
pnpm --silent ops:dingtalk-login-repair release-preview /restricted/recovery.json
pnpm --silent ops:dingtalk-login-repair release /restricted/release.json
```

verify 输入：userId/password/code/actorId/actorPassword。preview：proof。apply：proof/digest/confirm。两种 recovery preview：id/actorId/actorPassword；执行 rollback／release 再增加 digest/confirm。输入必须为私有常规文件，无组／其他用户权限，最多 64 KiB，严格字段集；证明输出 0600 且不覆盖。凭据、授权码和证明不得进入命令参数、聊天或 PR。失败只打印固定拒绝码集合中的一个（模块码与 CLI 码清单见 `dingtalk-identity-repair-codes.ts`），不打印错误文本、堆栈、SQL 或标识。下述输出流保证适用于上面的 `pnpm --silent ops:dingtalk-login-repair …` 调用（`--silent` 必须写在脚本名之前；写在之后会作为 CLI 参数传入，被拒绝为 `REPAIR_INPUT_INVALID`）以及直接调用 `tsx scripts/dingtalk-login-repair.ts …`；不带 `--silent` 的 `pnpm` 会在 stdout 另外打印自己的脚本横幅，失败时再打印 ELIFECYCLE 行，stdout 便不再是可解析的 JSON（退出码与 stderr 不变）。CLI 进程在加载任何会写日志的模块之前接管标准输出与标准错误：应用日志（含慢查询、ROLLBACK 失败与连接池配置警告）、console 与库输出一律丢弃，stdout 只含成功时的一行 JSON，stderr 只含一个拒绝码；连接在等待中被终止等未捕获异常或未处理拒绝同样按上述分类只打印一个码（读超时为 `REPAIR_CLIENT_TIMEOUT`，其余为 `DINGTALK_LOGIN_REPAIR_REFUSED`），之后按下文「非零退出之后」确认是否已提交。CLI 不提供调试输出，需要诊断时由 DBA 查看数据库日志与 `pg_stat_activity`。`REPAIR_LOCK_BUSY` 退出码 75，`REPAIR_CLIENT_TIMEOUT` 退出码 69，其余 1；输入文件、字段或权限问题为 `REPAIR_INPUT_INVALID`；成功输出 JSON 含 clientQueryTimeoutMs。

执行 apply、rollback、release 之前：（一）定时同步关闭不等于没有同步在跑：确认该企业所有钉钉集成在 `directory_sync_runs` 中没有 `status='running'` 的行，且 `pg_stat_activity` 中没有处于事务中的同步会话；（二）窗口内暂停手动同步、管理员绑定／解绑以及角色、权限和组织成员管理；（三）执行前立即重新运行对应的 preview；（四）CLI 进程不设置 DB_QUERY_TIMEOUT（由 CLI 预设下限），或显式设置为不低于该下限的值，显式更低的值以 `REPAIR_CLIENT_TIMEOUT_TOO_LOW` 拒绝且不连接数据库；显式值不得超过 2147483647，DB_STATEMENT_TIMEOUT 不得超过 2147468647（使下限不超过同一上限），否则以 `REPAIR_CLIENT_TIMEOUT_TOO_HIGH` 拒绝且不连接数据库；（五）锁阶段内登录会排队（每个持有者约五秒），并发写入可能被选为死锁牺牲者（见上文执行与互斥）。

非零退出之后：（一）先确认是否已提交。rollback／release 重新运行同一 preview：返回 `REPAIR_NOT_ACTIVE` 表示已提交，得到新摘要表示已回滚。apply 用同一证明重新运行 preview：仍然成功表示 apply 已回滚，返回 `REPAIR_SNAPSHOT_CHANGED` 表示已提交（apply 改变了身份，此检查先于 `REPAIR_ALREADY_ACTIVE`）；这只在证明的五分钟有效期内可行，证明过期（`REPAIR_PROOF_INVALID`）后由 DBA 读取 journal（`SELECT id,state,released_account_ids FROM dingtalk_login_repairs WHERE user_id=$1 ORDER BY created_at DESC`）及该 id 最新的 audit_logs 行。（二）退出码 75 时由 DBA 在 `pg_stat_activity`、`pg_locks` 中查找 `hashtext('directory:identity-maintenance')` 互斥或 13 张核心表的持有者。（三）重新运行对应 preview 并批准新摘要。（四）只手动重试一次，不循环重试；CLI 不自动重试。（五）退出码 69 时，在确认 journal 状态之前不做任何操作。暂停真实同步、修改在线参数和执行修复仍是三项独立审批。

真实窗口前必须另批：完整迁移台账、专用加密材料及可恢复配置／数据库备份、当前身份与目录证据、审批在途依赖、session/API token 影响、来源约束后续处理和维护窗口。新加密字段 `dingtalk_login_repairs.before_identity` 已登记普查和启动探测，单字段最多抽取二十行，不代表全库普查。换材料而不迁移密文会使恢复拒绝；必须保留原材料与密文备份。非空修复历史不允许 migration down，不能通过删除历史或直接拆守卫回滚。迁移在合并前再次原地改写（CHECK 与目录守卫函数）：跑过 `cbd01a7101` 版本的开发库须重建。

## 本版限制

- 不支持目录缺少 UnionID 的修复：verify 在调用钉钉之前拒绝，须先补齐目录 UnionID。
- 不提供重锚：登录应用或企业变更、canonical 来源被删除、换应用、人员或企业归属改变、被其他用户占用时，journal 停在 applied，须另批受控重锚。
- 同一用户在当前应用下有两个活动的同人来源时，verify 拒绝（`REPAIR_CANONICAL_SOURCE_REQUIRED`），须先解绑其中一个。
- release 前必须解绑名单外的钉钉关联（任何应用，活动或 inactive）；解绑会删除该用户同 UnionID 的钉钉身份，即撤销其钉钉登录，release 随之走终结模式。
- 锁阶段内单条语句三十秒累计等待触发的真实 57014 未在真实 PostgreSQL 上复现，只由分类单测（桩事务客户端）覆盖。

## 本地验证与交付门槛

Node 20.20.2、本机 PostgreSQL 15.17、全新合成库；提供方仅测试桩。没有真实扫码、线上连接、真实绑定、部署、候选构建或 Mac mini 使用。

修订验证：十一文件真实 DB 组合 252 项（含原八文件 185、修复文件 57、API 路由／组织准入十项）；认证／钉钉联合单测 55 文件 1040 项；独立 todo-center 待办门槛 27 项（EXPECT_DB=1，0 跳过）。CI 合约六项、TypeScript noEmit 通过。十个其他改动运行文件定向 ESLint 通过；AuthService 的 137 行原有 no-extra-semi 在旧 head 上同样失败，本轮未改无关代码。

包含真实 refresh 屏障红转绿、旧 OAuth 认证版本拒绝、API 创建／轮换版本拒绝、RR 默认事务在用户锁等待期间新提交 token 的撤销、首次登录补角色后的恢复、无变化同步后的恢复、缺 OpenID 绑定／解绑、OpenID 轮换后旧目录拒绝、release 前同步成功正对照及其后精确拒绝、隐藏第二人／UnionID 冲突拒绝、加密字段探测及密钥变化后恢复拒绝／原密文恢复。真实行为优于仅检查 generation 值。

CI 修正（承接 34bcb2c8）：两处私有 schema 的合成 users 表补齐 `access_generation`（与 zzzz20260724170000 一致）；修复套件改用每个夹具独立的组织，不再向 'default' 留下关联用户；真实 DB 加密存储探测固定清单加入 `dingtalk_login_repairs.before_identity`（含当前／旧材料两行）。本地同一 PostgreSQL 15.17：修复文件 63 项；十一文件组合 258 项（原 252 加组织切换 3 项、锁等待 3 项）；approval-db 全部 102 文件按 CI 顺序 1424 通过，余 5 项为本机 worktree 无法运行 `pnpm` 子进程及一次瞬时连接重置，单独复跑通过；multitable 加密探测 11 项；YiDa owner／初始化 HTTP 与运行时 60 项（两份浏览器文件需固定 Chromium，未在本机运行）。

锁修正（承接 94576920）：身份维护互斥移入同一错误映射，锁超时与死锁牺牲均拒绝为 `REPAIR_LOCK_BUSY`。新增两项真实 DB 用例（锁环、互斥等待超时），在旧实现上分别得到原始 `deadlock detected` 与 `canceling statement due to lock timeout`。本地同一 PostgreSQL 15.17：修复文件 65 项；十一文件组合 260 项；认证单测 8 文件 312 项。

改密栅栏修正（承接 7057f9d5）：强制改密重新签发会话时携带请求认证时的 generation，版本已变返回 409 `authentication_changed`，不登记会话。新增两项单测和一项真实 DB 用例：改密请求写入新密码后停住，期间 rollback 推进 generation，结果为 409、无有效会话、新密码仍然生效；之后在已推进的 generation 上正常改密，返回可用令牌。该用例在撤销之后等待一秒以上才签发令牌：撤销水位精确到毫秒，令牌签发时间只精确到秒，与撤销同一秒签发的令牌会立即被判为已撤销。这是 main 上已有的行为，本修订没有改变。去掉栅栏时该真实 DB 用例得到 200。锁环用例中，持有者在观察到 apply 排队约 500 毫秒后再加锁，即两侧 deadlock_timeout 检查的中点；立即加锁时 10 次中有 3 次由持有者先检查而成为牺牲者，500 毫秒时 20 次全部由 apply 拒绝。本地同一 PostgreSQL 15.17：修复文件 66 项；十一文件组合 261 项；认证单测 8 文件 314 项。

来源与超时修正（承接 cbd01a71）：release 只允许一个重新核实的钉钉来源（canonical 与终结两种模式），目录证据要求已存储的 UnionID，本地目录关联不进围栏；锁阶段内的 57014 映射为 `REPAIR_LOCK_BUSY`；维护 CLI 自行设定客户端读超时下限，只打印固定拒绝码。修复文件新增 46 项真实 DB 用例（来源、模式与围栏 44 项，CLI 子进程 2 项：持锁时退出码 75 且不写行；release-preview 输出计划与 clientQueryTimeoutMs 45000，错误摘要退出码 1，批准摘要完成 release），另有 CLI 单测 2 文件 90 项（含不连接数据库的子进程用例和桩事务客户端的 57014 分类）。变异检查：来源部分 31 项中 30 项转红，未转红的一项（从计划中去掉 mode）与预期一致；CLI 与超时部分 15 项全部转红。其中把正文改为静态导入时，子进程中的连接池实际持有三十秒并以 `REPAIR_CLIENT_TIMEOUT_TOO_LOW` 拒绝，说明脚本顶部赋值来不及，必须先过门再动态加载。本地同一 PostgreSQL 15.17（全新库按 CI 排除清单执行 456 项迁移）：修复文件 112 项；十一文件组合 307 项；认证单测 8 文件 314 项；CLI 单测 2 文件 90 项。后端单测全量（CI=true，无数据库）1414 个文件中 1238 通过、172 跳过、4 个失败，失败的是 multitable 恢复归档相关的 4 个文件共 43 项，在 cbd01a71 上同样失败，与本修订无关。TypeScript noEmit 两套配置、CI 合约 6 项、W4C-0 收集器 67 项通过。

输出守卫修正（承接 2c8804cb）：维护 CLI 入口在加载正文之前接管进程的标准输出与标准错误，并登记 uncaughtException／unhandledRejection 处理；连接池与日志模块未改。修正前实测四种泄漏：等待锁时后端被 `pg_terminate_backend` 终止，stderr 为 Node 的未处理 `'error'` 事件堆栈（含安装路径）；verify 在慢查询阈值以下（DB_SLOW_MS=0）于 stdout 打印带 SQL 文本的慢查询日志；连接停止应答时两次各 45 秒读超时后，stdout 打印带堆栈的 ROLLBACK 失败日志；非 production 且未设 DATABASE_URL 时 stdout 打印连接池警告。修复文件新增 3 项 CLI 子进程真实 DB 用例（慢查询日志下的 verify 拒绝、等待中被终止只打印 `DINGTALK_LOGIN_REPAIR_REFUSED` 且不写行、经可停顿的 TCP 中继在约 90 秒后只打印 `REPAIR_CLIENT_TIMEOUT` 且退出码 69），CLI 子进程默认以 DB_SLOW_MS=0 运行，原有两项 CLI 用例因此也检查日志泄漏；CLI 单测新增 6 项（守卫 5 项、未设 DATABASE_URL 的子进程 1 项）。读超时用例使修复文件多耗约 90 秒。变异检查：恢复入口旧版 3 项 DB 与 2 项单测转红；去掉流接管 2 项 DB 与 2 项单测转红；去掉 uncaughtException 处理 1 项 DB 与 2 项单测转红；另 4 项守卫内部变异各有单测转红。本地同一 PostgreSQL 15.17（全新库按 CI 排除清单执行 456 项迁移）：修复文件 115 项；十一文件组合 310 项；认证单测 8 文件 314 项；CLI 单测 2 文件 96 项。后端单测全量（CI=true，无数据库）仍只有既有的 multitable 恢复归档 4 个文件 43 项失败。TypeScript noEmit 两套配置、CI 合约 6 项、W4C-0 收集器 67 项通过。

调用与上限修正（承接 71fec829）：运维命令改为 `pnpm --silent ops:dingtalk-login-repair …`，并写明输出流保证只适用于该调用与直接 tsx 调用；客户端读超时增加 2147483647 毫秒上限，显式值或由 DB_STATEMENT_TIMEOUT 推出的下限超过上限时以新增 CLI 码 `REPAIR_CLIENT_TIMEOUT_TOO_HIGH` 拒绝，连接池建立后的核对也检查上限。修正前实测：pnpm 10.33.0 不带 `--silent` 时 stdout 先有脚本横幅，失败时再有 ELIFECYCLE 行；带 `--silent` 时两个流都干净，退出码 0／1／69／75 原样透传；`--silent` 写在脚本名之后会被当作 CLI 参数，拒绝为 `REPAIR_INPUT_INVALID`。DB_STATEMENT_TIMEOUT=2147483647 时 verify 4 次均在约 0.4 至 0.7 秒内以退出码 69 `REPAIR_CLIENT_TIMEOUT` 结束；DB_QUERY_TIMEOUT=2147483648 与 9999999999 各 4 次中分别有 1 次、2 次如此（其余几次第一条查询赶在 1 毫秒定时器之前返回）；2147483647 的 4 次均未出现。修复文件新增 2 项真实 DB 用例：经 `pnpm --silent` 调用时 release-preview 的 stdout 恰为一行 JSON，持锁时 release 退出码 75 且只打印 `REPAIR_LOCK_BUSY`；三种超上限设置各自在连接之前拒绝，2147483647 的 release-preview 正常完成且不写行。CLI 单测新增 14 项（上限边界 7 行、连接池实际值超上限 1 项、子进程 4 项、文档命令均带 `--silent` 1 项、新码按固定码以退出码 1 打印 1 项，另有原用例中新增的上限常量断言）。变异检查：去掉三处上限检查，单测 9 项与 DB 1 项转红（DB 用例得到退出码 69 `REPAIR_CLIENT_TIMEOUT`）；DB 用例去掉 `--silent`，stdout 变为 6 行而转红；文档命令检查在修改前的文档上转红。本地同一 PostgreSQL 15.17（全新库按 CI 排除清单执行 456 项迁移）：修复文件 117 项；十一文件组合 312 项；认证单测 8 文件 314 项；CLI 单测 2 文件 110 项。后端单测全量（CI=true，无数据库）1414 个文件中 1238 通过、172 跳过，仍只有既有的 multitable 恢复归档 4 个文件 43 项失败。TypeScript noEmit 两套配置、改动源文件定向 ESLint、CI 合约 6 项、W4C-0 收集器 67 项、多维表 liveness 守卫 82 项通过。CI 使用的 pnpm 10.16.1 未在本机运行，其输出与退出码行为按同一实现推定。

执行命令和当前 head／CI 结论保存在本地 FINAL-VERIFICATION.md。以上为本地验证，未宣告当前 head 的十三项必需 CI 通过。合并、部署、真实绑定、E4 交接、审批处置、停用和启用同步仍需单独批准。
