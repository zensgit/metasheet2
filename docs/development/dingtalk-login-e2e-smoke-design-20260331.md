# DingTalk Login E2E Smoke Design

日期：2026-03-31

## 目标

把 DingTalk 登录前端验收从接口级 smoke 提升到浏览器级 smoke，形成一条可重复执行的真实 UI 验收链。

## 范围

脚本路径：

- `scripts/dingtalk-login-e2e-smoke.mjs`

覆盖场景：

1. 登录页在 DingTalk launch 可达时显示“钉钉登录”按钮
2. 点击按钮后实际跳转到 DingTalk OAuth 授权 URL
3. launch 被强制返回 `503` 时，登录页隐藏“钉钉登录”按钮
4. callback 缺少 `code` 时，前端显示错误页
5. callback 带错误 `state` 时，前端显示错误页
6. 通过浏览器内拦截模拟 callback 成功响应，验证前端会写入 token 并离开 callback 路由

## 设计取舍

### 真实链路

以下场景走真实后端：

- 登录页 probe `/api/auth/dingtalk/launch`
- 点击“钉钉登录”后拿到真实 DingTalk 授权 URL
- callback 缺参 / 错 state 的错误页展示

### 浏览器内模拟

真正的 DingTalk 授权成功需要外部账号交互和一次性授权码，不适合稳定自动化。为避免把 smoke 建在外部身份提供商可用性上，成功场景使用浏览器内 route fulfill：

- 拦截 `/api/auth/dingtalk/callback`
- 返回与 runtime 一致的成功 payload
- 验证前端 `setToken + primeSession + router.replace(...)` 是否成立

这样可以把“真实错误链路”和“前端成功收口链路”同时覆盖，而不依赖真实 DingTalk 账号。

## 产物

脚本默认输出到：

- `output/playwright/dingtalk-login-e2e-smoke/summary.json`
- `output/playwright/dingtalk-login-e2e-smoke/*.png`

## 非目标

- 不自动化真实 DingTalk 外部授权成功
- 不验证目录管理后台
- 不替代 API 级 `scripts/dingtalk-oauth-smoke.mjs`
