# E2 钉钉容器壳（检测 + JSSDK + 免登接线）design-lock — 2026-07-07

> **Status: RATIFIED（方向锁 attendance-container-embed-direction-design-lock-20260705 E2 rung;
> owner 2026-07-07「请继续 … E2 容器壳」拍板;前置 E1✅(#3771)+UI-P1✅(#3788) 已达成）。**
> 依据 2026-07-07 主循环摸底。**关键:E2 主体落新文件 + `LoginView.vue` + `AttendanceExperienceView.vue`,
> 全不碰 `AttendanceView.vue` → 与 UI-P1余量/token化 是不同文件车道,可并行。**

## 1. 摸底事实

- 登录 token 落地（`LoginView.vue` 密码登录）:`setToken(token)` + `primeSession({success:true,data:{user,features}})`
  + `persistAuthContext(user,features)` + `loadProductFeatures` + `router.replace(home)`。E2 免登**逐字节同法**。
- E1 端点 `POST /api/auth/login/dingtalk/container` 返回 `{success,data:{mode:'login',user,token,features}}`,**默认关**（`DINGTALK_CONTAINER_LOGIN_ENABLED`,未开 404）。
- 设备门禁（`AttendanceExperienceView.vue`）:`admin/import/workflow` tab 移动端拦"建议桌面";
  **overview/reports 移动端已放行** → 容器落自助页**无需**斗门禁。
- 现有 dd JSSDK/requestAuthCode/CSP script-src **全零命中** → 绿地;CSP 无显式 script-src 限制记录。

## 2. 阶梯（E2a/b/c,每 rung 独立 opt-in;均不碰 AttendanceView.vue）

### E2a 容器检测模块（新文件 `apps/web/src/utils/dingtalkContainer.ts`,纯,可单测）
- `isDingTalkContainer()`:`navigator.userAgent` 命中 `/dingtalk/i`（钉钉 WebView UA 含 DingTalk）或 `window.dd` 存在。
- `ensureDingTalkJsApi(timeoutMs)`:若 `window.dd` 已预注入（微应用 WebView 常态）→ 立即 resolve;
  否则动态注入 jsapi 脚本（`https://g.alicdn.com/dingding/dingtalk-jsapi/…`）+ 超时;失败 → reject（调用方 fail-soft）。
- `requestContainerAuthCode(corpId)`:Promise 包 `dd.runtime.permission.requestAuthCode({corpId, onSuccess, onFail})` → authCode（单次）。
- **纯**:全部读 `window`/`navigator`,测试靠 stub 注入;无副作用导入。

### E2b 免登接线（`LoginView.vue`,fail-soft 渐进增强）
- `onMounted`:若 `isDingTalkContainer()` && 无 token → 尝试容器登录:
  `ensureDingTalkJsApi → requestContainerAuthCode → POST /container → setToken+primeSession+persistAuthContext → router.replace(home)`。
- **fail-soft 红线**:任一步失败（JSSDK 不可用 / authCode 取消 / 404 端点未开 / 403 政策门 / 网络）→ **静默回落到常规登录 UI**,不报错弹窗、不 loop、不阻塞。
- **非容器环境逐字节不变**（`isDingTalkContainer()` false → 整段不执行）。

### E2c 容器落地默认 tab（`AttendanceExperienceView.vue`）
- 容器内首屏默认 `overview`（自助+打卡,移动端已放行);`admin/import/workflow` 桌面引导**不动**。
- v1 仅"默认 tab",不改门禁语义。

## 3. 边界（OUT）

- 免登 authCode 单次、服务端换取（E1 已做）;深链 = E3;真机 smoke = E4（owner 注册微应用）。
- CSP:v1 优先假设 `window.dd` 预注入;动态加载为兜底,若部署侧 CSP 收紧 script-src 再单独处理（记 follow-up）。
- 不引入 GPS/人脸/硬件;不改 web-OAuth 路由与 E1 后端语义。

## 4. 测试契约

- E2a 单测（stub navigator/window.dd）:isDingTalkContainer（UA 命中/window.dd/都无→false）、
  ensureDingTalkJsApi（预注入立即 resolve/缺失+超时 reject）、requestContainerAuthCode（onSuccess/onFail Promise 化）。
- E2b:LoginView 挂载测试——容器+无 token → 调 /container、setToken;404/authCode 取消 → 回落常规 UI 不报错;非容器 → 整段不触发。
- E2c:容器内默认 tab=overview。
- Mutation:拆 isDingTalkContainer 判断 → 免登在普通浏览器误触发（测试红）;拆 fail-soft catch → 失败态测试红。

## 5. 完成口径

每 rung:实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。E2a 先行（新文件,即刻并行）;E2b/c 随后（LoginView/ExperienceView,仍不碰 AttendanceView.vue）。
