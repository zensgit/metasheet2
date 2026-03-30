# DingTalk Auth Design

## Goal

在不破坏现有邮箱密码登录的前提下，补齐一条正式可落地的钉钉身份认证链路：

- 第三方网站钉钉登录
- 已登录用户绑定 / 解绑钉钉身份
- 已绑定用户直接登录
- 默认采用方案 B：只有在 MetaSheet 内被明确授权的账号，才允许绑定并使用钉钉登录
- 未绑定用户自动开户保留为受控选项，不作为当前默认策略
- 登录后纳入现有会话中心与权限体系

这次实现不是把钉钉逻辑塞进考勤插件，而是把它提升为独立 IAM 能力。

## Scope

后端：

- 新增 `user_external_identities` 外部身份表。
- 新增 `user_external_auth_grants` 外部认证授权表，用于记录哪些本地账号被允许开通 `dingtalk` 登录。
- 新增 DingTalk auth service，负责 state、授权链接、code exchange、身份归一化。
- 在 `auth` 路由中新增 login-url、exchange、bind start、bindings、unbind。
- 在 `admin-users` 路由中新增 DingTalk 授权开关接口。
- 把原有密码登录、注册、邀请接受也切换到 session-aware token 签发，补齐 `sid`。
- 对公开 DingTalk 入口增加独立限流，避免它比密码登录更容易被刷。
- `refresh-token` 同步对齐 `user_sessions.expires_at`，避免 JWT 续期与会话中心显示漂移。
- 自动开户时写入 `users`、`user_orgs`、可选角色与权限模板，并记录审计日志。
- 补齐 OpenAPI 契约与环境模板，避免“代码有、交付面没有”。

前端：

- 登录页增加 `钉钉登录` 入口。
- 新增公开回调页 `DingTalkAuthCallbackView`。
- `useAuth` 增加 external auth context 持久化。
- external auth context 增加过期时间控制，避免旧跳转状态污染新会话。
- `api.ts` 与 `useAuth.ts` 对 loopback API 配置增加运行时保护，避免生产包错误继承本地 `127.0.0.1/localhost` 基址。
- 会话中心增加钉钉绑定区，支持刷新、发起绑定、解除绑定。
- 用户管理页增加“钉钉登录授权”区，支持创建用户时预授权，以及管理员事后授权/取消授权。
- 路由层增加公开 callback 路由。

文档：

- 设计文档说明数据模型、流程、安全边界与超越点。
- 验证文档沉淀命令、结果、未覆盖风险。
- 运维 preflight 文档提供上线前静态检查入口。

## Data Model

新增表：`user_external_identities`

核心字段：

- `provider`
- `external_key`
- `provider_user_id`
- `provider_union_id`
- `provider_open_id`
- `corp_id`
- `local_user_id`
- `profile`
- `bound_by`
- `last_login_at`

约束与索引：

- 唯一键：`(provider, external_key)`
- 唯一约束：`(local_user_id, provider)`
- 企业维度索引：`(corp_id, provider)`
- 外键：`local_user_id -> users.id`，删除用户时级联删除绑定

身份主键策略：

- 优先 `dingtalk:${corpId}:${userId}`
- 其次 `dingtalk-union:${unionId}`
- 再次 `dingtalk-open:${openId}`
- 最后兜底 `dingtalk-user:${userId}`

这样避免只依赖裸 `userId`，兼顾企业隔离和后续兼容。
另外新增的硬化 migration 会在加唯一约束前先按 `updated_at/created_at` 保留每个用户最新的一条绑定，避免历史脏数据阻塞上线。

新增表：`user_external_auth_grants`

核心字段：

- `provider`
- `local_user_id`
- `enabled`
- `granted_by`

约束与索引：

- 唯一键：`(provider, local_user_id)`
- 索引：`local_user_id`
- 外键：`local_user_id -> users.id`

迁移策略：

- 为避免现网已绑定账号在上线后被意外锁死，migration 会把已有 `dingtalk` 绑定用户回填为 `enabled=true`
- 新账号默认不授权，需由管理员在 MetaSheet 内显式开通

## Backend Flow

### Login Flow

1. 前端请求 `GET /api/auth/dingtalk/login-url?redirect=...`。
2. 后端签发短时效 state，内含：
   - `mode`
   - `redirect`
   - `requestedBy`（仅 bind 模式）
   - `nonce`
3. 用户在钉钉完成授权后回到前端 callback。
4. 前端调用 `POST /api/auth/dingtalk/exchange`。
5. 后端完成：
   - state 校验
   - code 换 token
   - 获取钉钉用户资料
   - 查找外部身份绑定
6. 若已绑定：
   - 读取本地用户
   - 校验该本地用户是否仍被允许使用 DingTalk 登录
   - 更新 `last_login_at`
   - 创建带 `sid` 的本地会话
   - 返回本地 JWT 与功能特性
7. 若未绑定：
   - 若允许自动开户，则创建本地用户与组织关系并落库绑定
   - 否则返回结构化错误

### Bind Flow

1. 已登录用户在会话中心点击 `绑定钉钉账号`。
2. 前端调用 `POST /api/auth/dingtalk/bind/start`。
3. 后端先校验该本地账号是否已在 MetaSheet 内获授权开通 `dingtalk` 登录。
4. 通过后在 state 中写入 `requestedBy=user.id`。
5. 用户完成钉钉授权后，callback 再调用 `exchange`。
6. 后端校验当前 bearer token 与 state 里的 `requestedBy` 一致。
7. 若当前用户已经绑定了另一个 DingTalk 身份，则拒绝第二次绑定。
8. 绑定成功后写入 `user_external_identities`，并记审计日志。

### Session Flow

这次顺手补了 IAM 里原本不完整的一段：

- `AuthService.createToken()` 现在支持 `sid` 与 `authProvider`
- `/login`、`/register`、`/invite/accept` 统一走 `issueAuthenticatedSession()`
- token payload 带上：
  - `sub`
  - `sid`
  - `authProvider`
- session registry 同步落库

这样钉钉登录与密码登录都能进入现有：

- `/api/auth/sessions`
- `/api/auth/sessions/current/ping`
- `/api/auth/logout`
- `/api/auth/sessions/others/logout`

### Refresh Flow

`/api/auth/refresh-token` 现在不再只刷新 JWT。

它还会：

- 读取新 token 中继承下来的 `sid`
- 解析新的 `exp`
- 回写 `user_sessions.expires_at`

这样“JWT 已续期，但会话中心显示仍快过期”的漂移被消掉了。

## Frontend Flow

### Login Entry

`LoginView` 现在有两条入口：

- 邮箱密码登录
- 钉钉登录

点击钉钉登录时：

1. 先写入 external auth context：
   - `provider`
   - `mode`
   - `redirect`
   - `state`
   - `createdAt`
2. 再请求后端登录链接
3. 浏览器跳转钉钉授权页

### Callback View

`DingTalkAuthCallbackView` 负责：

- 读取 `code/state/error`
- 校验本地 external auth context 是否过期、是否与 callback `state/mode` 对齐
- 调用 `exchange`
- 接收 token 并 prime session
- 拉取 feature flags
- 重定向到业务首页或原目标页
- 在失败时提供重试与返回登录

### Session Center

`SessionCenterView` 增加了钉钉绑定管理区：

- 加载当前绑定列表
- 进入页面时自动拉取当前绑定，减少“已绑定但页面仍显示空状态”的误判
- 发起绑定
- 解除绑定
- 当账号未获授权时，明确展示“请联系管理员”的提示，并禁用绑定入口
- 复用现有登录失效处理，401 时回到登录页

另外，绑定列表做了后端真实响应兼容：

- 支持 `id` 作为绑定主键
- 支持 `providerUserId / providerUnionId / providerOpenId`
- 支持从 `profile.nick / profile.name / profile.profile.*` 提取展示名称
- 支持从 `createdAt / created_at` 提取绑定时间

这样前端不会依赖理想化字段名，能直接消费后端现网返回。

## Runtime API Base Guard

这次线上联调暴露了一个交付层面的真实风险：前端构建如果继承了本地 `.env.local` 中的 `VITE_API_* = http://127.0.0.1:7778`，页面在公网部署后会错误请求浏览器本机 loopback，表现为：

- `/api/auth/me` 失败
- 会话 bootstrap 误判为未登录
- 钉钉绑定回调后被重定向回 `login?redirect=/settings`

为避免这类问题再次出现，前端基址解析增加了运行时保护：

1. 先读取构建时 `VITE_API_BASE / VITE_API_URL / VITE_BACKEND_URL`
2. 若该值是 `127.0.0.1 / localhost / ::1`
3. 且当前 `window.location.origin` 不是 loopback
4. 则强制回退到 `window.location.origin`

这样可以覆盖“开发环境方便、生产环境安全”的双场景，不需要依赖每次构建前人工清理本地 `.env.local`。

## Auto Provisioning Policy

## Explicit Authorization Policy

当前默认采用方案 B，而不是“首次钉钉登录自动开户”：

- 只有本地已存在且被管理员授权的 MetaSheet 账号，才允许绑定 DingTalk
- 已有绑定的账号，若管理员后续撤销授权，则后续 DingTalk 直登也会被拒绝
- 当前授权状态会在 `/api/auth/dingtalk/bindings` 返回给前端，用于在会话中心做禁用提示
- 管理员可在用户管理页显式开通或关闭 `dingtalk` 登录

这让企业可以把“是否允许钉钉登录”收敛为一项平台授权，而不是完全交给用户自助决定。

## Auto Provisioning Policy

自动开户不是无条件放开，而是受环境变量控制：

- `DINGTALK_AUTO_PROVISION`
- `DINGTALK_AUTO_PROVISION_PRESET_ID`
- `DINGTALK_AUTO_PROVISION_ORG_ID`
- `DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN`
- `DINGTALK_ALLOWED_CORP_IDS`

策略：

- 只允许指定企业
- 默认挂到指定组织
- 默认赋给指定 preset / 角色模板
- 邮箱缺失时生成受控占位邮箱
- 若邮箱已被本地用户占用，则拒绝自动开户

## Contract And Ops Delivery

为了让这条链路真正可交付，这次额外补了两块：

- OpenAPI：`/api/auth/dingtalk/login-url`、`/bind/start`、`/exchange`、`/bindings`、`/unbind`
- 环境模板：根目录和 backend `.env` 示例里增加 `PUBLIC_APP_URL` 与 `DINGTALK_*` 配置
- Preflight：提供 [dingtalk-auth-preflight.mjs](/Users/huazhou/Downloads/Github/metasheet2/scripts/dingtalk-auth-preflight.mjs) 做发布前静态配置检查

这意味着后续对接方、测试环境、运维环境都不需要再倒推代码猜接口和变量。

## Security Controls

- state 使用签名 JWT，并带过期时间。
- redirect 只接受站内路径，拒绝 `//` 和外域跳转。
- 前端 external auth context 带 TTL，并在 callback 时校验 state/mode 一致性。
- bind 模式要求当前登录用户与 `requestedBy` 一致。
- 外部身份唯一键防止一个 DingTalk 身份被多本地账号重复绑定。
- 当前用户若已绑定其他 DingTalk 身份，则拒绝重复绑定。
- 钉钉 client secret 通过现有 secret manager 读取。
- 自动开户前做 `corpId` allowlist 校验。
- 绑定、解绑、自动开户均写审计日志。
- 授权开关的变更也写审计日志，资源类型为 `user-external-auth`。
- `login-url` 与 `exchange` 公开入口增加独立限流。

## Why This Exceeds A Basic Reference Implementation

如果只做“扫码登录成功就进系统”，那只是最小样板。

这次实现额外覆盖了这些细节：

- 不只登录，还支持绑定、解绑和绑定列表管理。
- 不只发 token，还把 `sid` 真正接入会话中心。
- 不只接入会话中心，还把 refresh 后的 session expiry 一并对齐。
- 不只完成绑定成功路径，还把顶栏“退出登录”统一收口到当前会话注销、前端 token/特性缓存清理，以及强制回到 `/login?redirect=...` 的完整退出流程。
- 不只识别外部身份，还支持按企业范围控制自动开户。
- 不只新增第三方登录入口，还保留本地密码登录兜底。
- 不只让代码可跑，还补齐了 OpenAPI 和 `.env` 模板，降低交付摩擦。
- 不只返回成功失败，还对 callback、绑定和未开户场景提供结构化错误与前端状态机。
- 不只在代码层面可跑，还补了生产环境 API 基址保护，避免构建机本地配置把线上认证链路带偏。

## Logout UX Hardening

线上联调里暴露了一个典型的“认证链路闭环已通，但退出体验不稳”的问题：顶栏退出按钮只删除了 `auth_token`，没有同步清掉兼容字段 `jwt` / `devToken`，也没有显式回收当前服务端会话。

这次额外做了三件事：

- 顶栏退出改为优先调用 `/api/auth/logout`，对当前 bearer token 代表的会话做 best-effort 注销。
- 前端统一走 `useAuth.clearToken()`，同时清理 `auth_token`、`jwt`、`devToken`、`metasheet_features`、`metasheet_product_mode`、`user_permissions`、`user_roles` 和 DingTalk external auth context。
- 退出后不再回到 `/`，而是强制跳到 `/login?redirect=<当前页>`，避免首页守卫在残留 token 下把用户带回受保护页面。

这样一来，“已绑定用户退出后再次走钉钉直登”就不会再被本地旧 token 干扰。

## Residual Risks

- 还没有跑真实 DingTalk 沙箱 / 企业租户联调。
- 自动开户目前以环境变量驱动，后续可上收为管理后台配置。
- 若未来要支持多个外部身份源，建议把 provider 抽象进一步通用化。
