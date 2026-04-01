# DingTalk Login E2E Smoke Verification

日期：2026-03-31

## 范围

验证浏览器级 DingTalk 登录 smoke 是否可执行，并确认它能覆盖真实按钮/跳转、真实 callback 错误链路和模拟成功收口链路。

## 实际执行

- `node scripts/dingtalk-login-e2e-smoke.mjs --help`
- `WEB_BASE=http://142.171.239.56:8081 OUTPUT_DIR=output/playwright/dingtalk-login-e2e-smoke/onprem-20260331 node scripts/dingtalk-login-e2e-smoke.mjs`

## 预期

- 登录页显示真实“钉钉登录”按钮
- 点击后 URL 进入 `login.dingtalk.com/oauth2/auth`
- callback 缺 code 显示错误
- callback 错 state 显示错误
- 模拟成功 callback 后，前端写入 token 并跳出 callback 路由

## 结果

### 1. 脚本帮助

- `node scripts/dingtalk-login-e2e-smoke.mjs --help`
  - 结果：通过

### 2. 浏览器级 on-prem smoke

- `WEB_BASE=http://142.171.239.56:8081 OUTPUT_DIR=output/playwright/dingtalk-login-e2e-smoke/onprem-20260331 node scripts/dingtalk-login-e2e-smoke.mjs`
  - 结果：通过

实际检查结果：

- `login.button.visible` → 通过
- `login.redirect.external` → 通过
- `login.button.hidden.on-503` → 通过
- `callback.error.missing-code` → 通过
- `callback.error.return-login` → 通过
- `callback.error.invalid-state` → 通过
- `callback.success.simulated` → 通过

关键输出：

- 汇总：[summary.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/summary.json)
- 截图：
  - [01-login-visible.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/01-login-visible.png)
  - [02-dingtalk-redirect.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/02-dingtalk-redirect.png)
  - [03-login-hidden-when-launch-unavailable.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/03-login-hidden-when-launch-unavailable.png)
  - [04-callback-missing-code.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/04-callback-missing-code.png)
  - [05-callback-invalid-state.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/05-callback-invalid-state.png)
  - [06-callback-success-simulated.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/dingtalk-login-e2e-smoke/onprem-20260331/06-callback-success-simulated.png)

### 3. 现网 blocker 与修复

首次执行失败不是脚本问题，而是现网部署参数不完整，实际出现了两层问题：

1. 同源代理链断开：
   - `http://142.171.239.56:8081/api/auth/dingtalk/launch` 返回 `502 Bad Gateway`
   - `docker/nginx.conf` 里的 upstream 是 `backend:8900`
   - 但运行中的 backend 容器名是 `metasheet-backend`，且最初没有 `--network-alias backend`
2. 外部入口不可达：
   - `metasheet-web` 曾被只绑定到 `127.0.0.1:8081`
   - 远端本机 `curl http://127.0.0.1:8081/login` 正常，但从外部访问 `http://142.171.239.56:8081/login` 会得到 `ERR_EMPTY_RESPONSE`

修复动作：

- 保留已验证镜像不变，只修正 `docker run` 参数
- 重新运行 `metasheet-backend` 时补上 `--network-alias backend`
- 重新运行 `metasheet-web` 时改为 `-p 8081:80`，不再只绑到 `127.0.0.1`

修复后：

- `http://127.0.0.1:8081/api/auth/dingtalk/launch` 返回 `200`
- `http://142.171.239.56:8081/login` 返回 `200`
- 浏览器级 smoke 全绿

### 4. 当前结论

这条 `dingtalk-login-e2e-smoke` 现在可作为 DingTalk 登录前端验收入口：

- 真实覆盖：按钮显示、真实 launch URL、callback 缺参/错 state
- 浏览器内模拟覆盖：callback 成功后的 token 写入和路由跳转
- 现网 `142.171.239.56` 已复验通过
