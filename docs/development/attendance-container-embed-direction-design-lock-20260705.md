# 考勤容器嵌入（钉钉微应用 / 飞书网页应用）direction design-lock — 2026-07-05

> **Status: DIRECTION RATIFIED（owner 对话拍板 2026-07-05："我们只要嵌进钉钉微应用/飞书
> 网页应用就可以"）——本文锁方向与阶梯;E1+ 每 rung 仍各自独立 opt-in。**
> 原生 App 维持 tracker §1 OUT 红线**原样不动**——嵌入是 Web 的延伸,不触碰该线。
> 本文为平台集成设计（钉钉/飞书是集成目标,非对标来源）,命名合规同既有
> `dingtalk-pr3-attendance-notify-design` 先例。依据:2026-07-05 嵌入就绪度审计（§1）。

## 1. 就绪度（审计实证）

### 钉钉——Web SSO 已建成,容器内四件套为零

| 能力 | 状态 | 锚点 |
|---|---|---|
| 身份表（`user_external_identities`/`user_external_auth_grants`/`directory_*` 六表） | ✅ | migrations 20260323-24 |
| 钉钉用户→本地用户→**我方 JWT**（OAuth 回调全链） | ✅ | `auth.ts:1185` callback → `exchangeCodeForUser` → `issueAuthSessionToken`（`jwt.sign` :77） |
| 政策门（require-grant / corp 白名单 / auto-link / auto-provision） | ✅ | `dingtalk-oauth.ts:132-140,663-694` |
| directory 同步 + 账号绑定 | ✅ | `directory-sync.ts` + `directory_account_links` |
| **容器内免登**（`dd.runtime.permission.requestAuthCode`） | ❌ | 全 repo 零命中;现有 code 交换是 v1.0 **web-OAuth** grant（`login.dingtalk.com` 跳转,`client.ts:339` userAccessToken）,与企业免登 authCode **不是同一种 grant** |
| JSAPI ticket/签名（dd.config） | ❌ | 零命中（仅免登不需要;用高级 JSAPI 才补） |
| 前端容器检测/JSSDK 加载 | ❌ | apps/web 零 `dd.env`/UA 嗅探 |
| C5 通知深链 | ❌ | work-notification 是纯 markdown **无 URL**（`client.ts:644-673`）,点了回不到应用 |
| **WebView 地雷**：`AttendanceExperienceView` 设备门禁（移动 UA+<900px → 桌面 tab 拦截"建议桌面"） | ⚠️ | `AttendanceExperienceView.vue:115,147-156,203-216`——微应用 WebView 必中,E2 必须给容器入口豁免/专用 landing |

### 飞书——绿地 + 一个可复用地基

`NotificationService.ts:476-527` 的 Feishu channel 是**日志 stub**（`setTimeout(150)` 假发送）;无凭证/无 OAuth/无 JSSDK。**可复用**:身份/目录表 provider 参数化（`provider` 列默认 'dingtalk' 但通用）——F 系列走 `provider='feishu'` 镜像即可,不需要新表。

## 2. 阶梯（E=钉钉,F=飞书;每 rung 独立 opt-in）

| Rung | 内容 | 泳道/量级 | gate |
|---|---|---|---|
| **E1 免登 backend** | 新端点交换**企业免登 authCode**（app access token + `getuserinfo` 族,区别于既有 v1.0 web-OAuth grant）→ 复用 `resolveLocalUser`/`issueAuthSessionToken` 铸我方 JWT;沿用全部政策门（require-grant/corp 白名单）;绑定走既有 `user_external_identities` | backend,~3-5 pd | E0 后即可 |
| **E2 容器壳 + 移动 landing** | 前端:容器检测（dd.env/UA）+ 钉钉 JSSDK 按需加载 + 免登接线（container→authCode→E1→JWT→直达页面,无登录页闪现）;**微应用 landing = 员工自助页**（依赖 UI arc P1 的 768px 紧凑打卡）;ExperienceView 设备门禁给容器豁免（容器内 = 自助+打卡优先,管理 tab 仍引导桌面） | FE,~1 周 | E1 + UI-P1 后 |
| **E3 C5 深链** | work-notification 升级 actionCard/link msgtype（或 markdown 内嵌微应用 URL）:提醒/催办/审批通知点击直达容器内对应页（打卡/异常/审批）;深链 URL 形状与 E2 路由对齐 | backend(channel),~2-3 pd | E2 后 |
| **E4 真机 smoke** | 钉钉开放平台注册微应用（首页地址/安全域名/免登权限——**owner 侧动作**）+ 真机进容器跑通:免登→打卡→收通知→深链回;residue 口径同既有 staging smoke 纪律 | operator+FE,~2-3 pd | E1-E3 落 + owner 注册 app |
| **F0-F3 飞书系列** | F0 凭证/app 注册（owner）→ F1 `authen` code 交换（`provider='feishu'` 镜像 E1）→ F2 Lark JSSDK 壳（镜像 E2,复用容器抽象）→ F3 真消息渠道替换 stub（`im/v1/messages`,接 C5 channel seam） | 绿地,~2-3 周 | **E 系列跑通后按需**;每 rung 独立 opt-in |

## 3. 边界

- 原生 App / 极速打卡 / 人脸 / 硬件采集:维持 OUT 不动。
- E1 的免登交换**绝不**绕过既有政策门——require-grant/corp 白名单/auto-provision 语义与 web-OAuth 完全一致(同一 `resolveLocalUser`)。
- E2 容器检测 = 渐进增强:非容器环境行为**逐字节不变**(普通浏览器不受影响);JSSDK 只在容器内按需加载。
- 深链 URL 不携带凭证/敏感参数;免登 authCode 单次使用、服务端换取。
- GPS 定位采集(打卡前"已进入范围"反馈)仍是**独立 deferred 决策**(punch-outcome 锁 §6)——容器让它技术可行,但隐私/产品决策另议,不随 E 系列。

## 4. 与 UI arc 的合并排期

```
Wave 1  UI-P0 tokens+hero(mock 已出待 ratify) ∥ E1 免登 backend(不同泳道,可并行)
Wave 2  UI-P1 自助页+768px 紧凑打卡
Wave 3  E2 容器壳(landing=P1 成果) → E3 深链
Wave 4  E4 真机 smoke(owner 注册微应用) ⇒ 手机里可用的考勤
Wave 5  UI-P2 可视化 → P3a-d 管理台
F 系列  E 跑通后按需,gated
```

## 5. 完成口径

每 rung:设计细化(如需)→ Sonnet 实现 → opus 对抗审阅 0 P1/P2 → 三红线;E1 含真 DB 反向测试(政策门逐条);E2 含容器/非容器双态测试(非容器逐字节不变);E4 = 真机 PASS 记录。
