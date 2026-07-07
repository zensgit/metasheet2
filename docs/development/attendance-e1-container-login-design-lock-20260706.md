# E1 钉钉容器内免登 backend design-lock — 2026-07-06

> **Status: RATIFIED（方向锁 attendance-container-embed-direction-design-lock-20260705 E1 rung；
> owner 2026-07-06「不反对」E1 先行）。** 本文 = rung 级细化，依据 3-lens 侦察（wf_97c81165）。
> 勘误上游方向锁一处锚点：web-OAuth 链真正的 jwt.sign 在 `AuthService.createToken`
> （auth.ts:435 `issueAuthSessionToken` → AuthService.ts:216），`auth.ts:77` 是无关的 dev-token 端点。

## 1. 端点与链路

`POST /api/auth/login/dingtalk/container`，body `{ authCode }`（容器内 `dd.runtime.permission.requestAuthCode` 所得，单次使用、服务端换取）：

1. **默认关闭门**：env `DINGTALK_CONTAINER_LOGIN_ENABLED`（默认 false → 404 `container_login_disabled`；default-preserving）。
2. 复用 `readDingTalkOauthConfig()`（内含 **corp 白名单门** `assertDingTalkCorpAllowed`，与 web-OAuth 同点位）。
3. app access token：**复用** `fetchDingTalkAppAccessToken`（client.ts:432，directory-sync/通知已共用）。
4. **新增** client 函数 `getDingTalkUserInfoByAuthCode(accessToken, authCode, config?)`：POST `/topapi/v2/user/getuserinfo?access_token=…` body `{code}`，结构模板 = `getDingTalkUserDetail`（client.ts:593），走既有 `requestDingTalkDirectoryJson` + `readNestedPayload('result')` + `DingTalkRequestError/DingTalkBusinessError` 错误栈 → `{ userid, unionid?, sysLevel? }`。
5. `unionid` 缺失时**复用** `getDingTalkUserDetail`（topapi/v2/user/get）按 `userid` 回查（该响应可靠含 `unionid` + name/mobile/email/avatar）；仍无 unionId → 硬失败 `identity_key_unavailable`（**绝不**用空键/userid 冒充继续）。
6. **新增** dingtalk-oauth.ts 导出函数 `exchangeEnterpriseAuthCodeForUser(authCode)`：镜像 `exchangeCodeForUser` 的组合点——企业链取 profile → 调**同一个私有 `resolveLocalUser`**（require-grant/auto-link/auto-provision/disabled-user 四门逐语义一致）→ 返回同形 `DingTalkExchangeResult`。
7. 路由层复用 callback 的下半身：`loadAuthPermissions` → `User` → `issueAuthSessionToken(user, req)`（同 claims/session 行为）→ 同形响应 `{mode:'login', user, token, …}`。**不引入** web-only 的 state/nonce（CSRF 概念不适用；authCode 由钉钉服务端一次性核销）。

## 2. 身份键决策（侦察实锤的腐蚀陷阱及解法）

事实：`buildExternalKey` 在 `DINGTALK_CORP_ID` 配置时 = `${corpId}:${openId}`（sns openId 主键）；企业免登只有 corp `userid`/`unionId`，**没有** sns openId；而 `upsertExternalIdentity` 每次登录**无条件覆写** `external_key/provider_open_id`。若 E1 拿 userid 冒充 openId，web-OAuth 与容器登录交替时身份键**来回翻转**。

解法（一次性、单向增益，web-OAuth 语义逐字节不变）：
- `DingTalkUserInfo.openId` 改 optional；E1 构造 `{ unionId, openId: undefined, nick/email/mobile/avatarUrl }`——匹配天然走 `findIdentityUser` 既有的 `provider_union_id` OR 分支（corp 作用域）。
- `buildExternalKey`：openId 缺失时 fallback `${corpId}:${unionId}`（仅新建行使用）。
- `upsertExternalIdentity` UPDATE 分支改**非破坏**：`external_key/provider_open_id/corp_id` 仅当 incoming `openId` 存在时才覆写，否则保留既有值（COALESCE 语义）；`provider_union_id`/profile 照常刷新。效果：容器先登 → 行以 union 键落库；此后 web-OAuth 登录一次即**单向升级**为 openId 主键，不再回翻。
- 回归金测试：容器登→web 登→容器登三连，`external_key/provider_open_id` 升级一次后保持不变。

## 3. 边界（OUT）

- 前端容器检测/JSSDK/免登接线 = E2；深链 = E3；真机 = E4。
- `directory_account_links` 的 userid→local 映射**不用于登录**（绕过 grant 门，违反"同语义"红线；仅未来 auto-link 辅助信号候选）。
- 不新增表/迁移；不动 web-OAuth 路由与其测试语义。

## 4. 测试契约

1. **client 单测**（dingtalk-client.test.ts 模式，global.fetch mock）：新函数 URL/body 形状、`result` 解包、errcode→BusinessError。
2. **oauth 单测**（dingtalk-oauth-login-gates.test.ts 模式，mock pg+client）：`exchangeEnterpriseAuthCodeForUser` 快乐路（union 命中既有身份）、四政策门逐条、getuserinfo 缺 unionid → user/get 回查、双双缺失 → `identity_key_unavailable`、upsert 非破坏语义。
3. **路由单测**（auth-login-routes.test.ts 模式）：disabled 门 404、缺 authCode 400、成功形状（token/user/permissions）、政策 403 codes 透传。
4. **真 DB 反向测试**（方向锁 §5 完成口径）：新 `tests/integration/dingtalk-container-login.db.test.ts`，接入 plugin-tests.yml 既有 dingtalk db-test 挂点（:375 模式）——政策门逐条 + §2 三连回归金测试，pg 真库、HTTP client mock。
5. Mutation：拆非破坏 COALESCE → 三连金测试红；拆 unionId 硬失败 → 对应单测红。

## 5. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。backend 泳道（与 FE 车道并行无冲突）。

## 6. 审阅硬化记录（2026-07-07 对抗审阅 #3771）

- P2-1 emailless 占位邮箱碰撞（`dingtalk_undefined@…` UNIQUE 冲突 → 500 锁死）：占位改 unionId（硬失败保证非空）+ 真 DB 双 emailless 回归。
- P2-2 未认证端点无限流（每个 well-formed 请求放大到共享 gettoken QPS）：复用 `checkRateLimit` per-IP，成功即 reset；flood 单测锁。
- P3-1 flag 解析宽容化（trim + true/1/yes，仍 fail-closed）；NIT 无效 authCode → 401 `invalid_auth_code`（`DingTalkBusinessError` 映射）；golden 补行数断言。
- **P3-2 defer**：app access token 每请求新取无缓存——E 系列后续 rung 统一处理（缓存亦进一步削弱限流放大面）。
