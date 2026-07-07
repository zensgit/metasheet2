# E2 钉钉容器壳 验证报告 — 2026-07-07

> 三 rung 全落：E2a 容器检测模块（#3795 `456accc77`）+ E2b 免登接线（#3799 `b1a2edc23`）
> + E2c 落地默认 tab（**既有默认已满足,无需代码**）。rung 设计锁：
> `attendance-e2-container-shell-design-lock-20260707.md`。前置 E1✅(#3771)+UI-P1✅(#3788/#3798)。

## 1. 交付（手机钉钉里的效果）

打开微应用 → 自动检测钉钉容器 → 静默取 authCode → 换我方 JWT → **直达自助打卡页,零登录页**;
任一步失败静默回落常规登录;普通浏览器逐字节不变。

## 2. E2a — 容器检测/JSSDK/authCode 模块（#3795）

新纯 util `dingtalkContainer.ts`：`isDingTalkContainer()`（UA `/dingtalk/i` ∪ `window.dd`）/
`ensureDingTalkJsApi()`（预注入立即 resolve;CDN 兜底 + **dd.ready gating**〔审阅 P3-1〕+ 超时,失败 fail-soft）/
`requestContainerAuthCode()`（Promise 包 dd.runtime.permission.requestAuthCode,code/auth_code/空守卫/onFail/超时防挂）。
- 验证：13 单测（检测/jsapi 就绪/authCode 六态）;mutation（UA/空码/timeout 三守卫红）。
- 审阅（opus）APPROVE-with-hardening：P2 CI 门缺失〔已修:接入 attendance-web-guard〕+ P3-1 dd.ready〔已加固〕。

## 3. E2b — 免登接线（#3799，认证面）

`LoginView.onMounted`：容器内 + 无 token → `ensureJsApi → requestAuthCode(corpId from launch probe) →
POST /container → setToken+primeSession+persistAuthContext+router.replace(home)`——与密码登录**同一 establish-session 序**。
- **fail-soft 红线**：抛出型失败（authCode 取消/JSSDK reject/网络）+ 显式失败（404 端点未开/403 政策门/空 token）
  全部静默吞、常规登录 UI 保留;普通浏览器 gate 短路不触发、不注入 JSSDK 脚本。免登中禁用其他登录入口（防双登录）。
- 验证：10 挂载测试（自动登录/404 fail-soft/**authCode 拒绝抛出型 fail-soft**/重复登录跳过/普通浏览器不触发+无脚本）;
  mutation（拆 gate → 普通浏览器红;拆 fail-soft catch → 抛出逃逸红）。LoginView spec+view 接入 attendance-web-guard。
- 审阅（opus）APPROVE-with-hardening：P2 抛出型 fail-soft 未测〔已补 setContainer(false) 测试〕+
  P3-3 双登录禁用〔已加〕+ P3-4 重复登录覆盖〔已加〕;P3-1（免登不查 must_change_password,lock §1 parity 内)/
  P3-2（catch 不 clearStoredAuthState,半初始化低危）= 接受/记录。

## 4. E2c — 落地默认 tab（既有默认已满足,零代码）

`AttendanceExperienceView`：`activeTab = ref('overview')` + `syncFromRoute`（`normalizeTab(undefined)='overview'`）→
容器 landing（`/attendance` 无 `?tab=`）恒落 overview（自助+打卡,移动端已放行）。lock E2c「v1 仅默认 tab、不改门禁」
**由既有默认行为满足,无需新切片**。admin/import/workflow 桌面引导不动。

## 5. Follow-up（gated）

- **E4 真机 smoke**：owner 在钉钉开放平台注册微应用（首页地址/安全域名/免登权限）+ 真机跑通免登→打卡→回落。
- E3 深链（work-notification 点击直达容器内页）;CSP script-src 收紧时的 JSSDK SRI/crossorigin（lock §3 记）。
- 启用：运维 `DINGTALK_CONTAINER_LOGIN_ENABLED=true`（web-OAuth 三件套 env 前置）。
