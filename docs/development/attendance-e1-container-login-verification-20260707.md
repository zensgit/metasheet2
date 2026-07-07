# E1 钉钉容器内免登 验证报告 — 2026-07-07

> PR #3771 MERGED（squash `73c6eeda1`）。rung 设计锁：
> `attendance-e1-container-login-design-lock-20260706.md`（RATIFIED，含 §6 审阅硬化记录）。
> 方向锁：attendance-container-embed-direction-design-lock-20260705（E1 = 首个承重 rung ✅）。
> 对抗审阅（opus，认证级）：CHANGES-REQUESTED light（无 P1，2 P2）→ 全部修毕（`5311927c0`）。

## 1. 交付

`POST /api/auth/login/dingtalk/container`（**默认关闭** `DINGTALK_CONTAINER_LOGIN_ENABLED`）：
容器内企业免登 authCode → app access token（复用既有 helper）→ 新 client
`getDingTalkUserInfoByAuthCode`（topapi/v2/user/getuserinfo，既有错误栈）→ unionId
（user/get 回查兜底，双缺硬失败 `identity_key_unavailable`）→ **同一个私有 `resolveLocalUser`**
（require-grant / corp 白名单 / auto-link / auto-provision / 禁用用户五门逐字节同语义）→
同 `issueAuthSessionToken`（同 claims/session）。per-IP 限流前置于 outbound。

## 2. 身份键加固（本 rung 的核心工程决策）

侦察实锤：企业面无 sns openId，而 upsert 原本无条件覆写 openId 系键 → 容器/web 交替登录键翻转。
修法 = `openId` optional + upsert **单向增益**（仅 incoming 有 openId 才动 openId 系列列）。
真 DB 金测试：容器→web→容器三连，`external_key/provider_open_id` **恰升级一次**后稳定；
mutation（恢复破坏性 upsert → 金测试红）实证守卫。web-OAuth 行为零变。

## 3. 验证证据

- 四层测试：client/oauth/route 单测 56/56；**真 DB 反向套件** `dingtalk-container-login.db.test.ts`
  （挂入 plugin-tests.yml 真 Postgres 门）——政策门逐条 + §2 金测试 + emailless 双 provision 回归，
  新起 Postgres 16 本地实跑 **8/8**；审阅方独立复跑同绿并另做一刀 mutation。
- 审阅硬化：P2-1 emailless 占位邮箱碰撞（`dingtalk_undefined@…` UNIQUE → 500，审阅方实证复现）
  → 占位改 unionId；P2-2 未认证端点无限流（放大共享 gettoken QPS）→ per-IP checkRateLimit；
  P3-1 flag 宽容解析（仍 fail-closed）；无效 authCode → 401 `invalid_auth_code`。
- 安全面审定：authCode 无 CSRF/state 安全（单次/短时/appKey 绑定）；错误响应不泄漏 token。
- 顺带勘误方向锁 jwt 锚点（真签名在 `AuthService.createToken`，`auth.ts:77` 是 dev-token）。

## 4. Follow-up

- **P3-2 defer**：app access token 请求级新取无缓存——E 系列后续 rung 统一处理。
- E2 容器壳+移动 landing（前置 = E1 ✅ + UI-P1）→ E3 深链 → E4 真机 smoke（owner 注册微应用）。
- 启用路径：运维配置 `DINGTALK_CONTAINER_LOGIN_ENABLED=true`（web-OAuth 三件套 env 为前置）。
