# On-Prem Docker Run Hardening Design

日期：2026-04-01

## 目标

把 DingTalk on-prem 手工 `docker run` 的关键参数固化成可重复执行的脚本和部署文档，避免容器重启或人工替换时再次遗漏运行参数。

## 背景

浏览器级 DingTalk 登录 smoke 暴露了两个部署层问题：

1. `metasheet-backend` 缺少 `--network-alias backend`
   - `docker/nginx.conf` 固定通过 `backend:8900` 代理 `/api/*`
   - 如果 backend 只叫 `metasheet-backend` 但没有 `backend` alias，web 同源代理会返回 `502`
2. `metasheet-web` 被错误地只绑定到 `127.0.0.1:8081`
   - 远端主机内 `curl http://127.0.0.1:8081/login` 正常
   - 外部访问 `http://142.171.239.56:8081/login` 会得到 `ERR_EMPTY_RESPONSE`

这两个问题都不是应用代码 bug，而是部署参数漂移。

## 方案

新增脚本：

- `scripts/ops/dingtalk-onprem-docker-run.sh`

支持目标：

- `backend`
- `web`
- `all`

支持特性：

- `--dry-run`
- 通过环境变量显式传入 `BACKEND_IMAGE` / `WEB_IMAGE`
- 固定 backend 关键参数：
  - `--restart unless-stopped`
  - `--network metasheet2_default`
  - `--network-alias backend`
  - `--env-file docker/app.env`
  - `-v metasheet-attendance-import-data:/app/uploads/attendance-import`
  - `-p 127.0.0.1:8900:8900`
- 固定 web 关键参数：
  - `--restart unless-stopped`
  - `--network metasheet2_default`
  - `-p 8081:80`

## 设计取舍

### 明确要求镜像参数

脚本不自动猜测“最新镜像”，而是要求通过 `BACKEND_IMAGE` / `WEB_IMAGE` 明确传入，避免重新启动到错误 tag。

### Backend 继续只绑本地 8900

backend 保持 `127.0.0.1:8900:8900`，外部流量继续通过 web 的 nginx 进入。这样可以保留现网最小暴露面。

### Web 必须公开 8081

浏览器 smoke 依赖从外部直接访问 `http://<host>:8081`，因此 web 必须绑定 `8081:80`，不能只绑 `127.0.0.1`。

## 非目标

- 不解决 `docker-compose v1.29.2` 的兼容问题
- 不改变镜像构建流程
- 不替代更完整的 systemd / PM2 on-prem 方案
