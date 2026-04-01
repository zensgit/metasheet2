# On-Prem Docker Run Hardening Verification

日期：2026-04-01

## 范围

验证 DingTalk on-prem `docker run` 硬化脚本和部署文档是否已把关键参数固化，并确认它能在 `142.171.239.56` 上真实恢复 backend/web 容器。

## 实际执行

本地：

- `bash -n scripts/ops/dingtalk-onprem-docker-run.sh`
- `bash scripts/ops/dingtalk-onprem-docker-run.sh --help`
- `ENV_FILE=docker/app.env.example BACKEND_IMAGE=ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260331-1d9d867b0 WEB_IMAGE=ghcr.io/zensgit/metasheet2-web:dingtalk-rollout-20260330-d619b560d bash scripts/ops/dingtalk-onprem-docker-run.sh --dry-run all`

远端 `142.171.239.56`：

- 上传脚本到 `/tmp/dingtalk-onprem-docker-run.sh`
- `BACKEND_IMAGE=ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260331-1d9d867b0 WEB_IMAGE=ghcr.io/zensgit/metasheet2-web:dingtalk-rollout-20260330-d619b560d ENV_FILE=/home/mainuser/metasheet2/docker/app.env bash /tmp/dingtalk-onprem-docker-run.sh all`
- `curl -s http://127.0.0.1:8900/health`
- `curl -i http://127.0.0.1:8081/api/auth/dingtalk/launch`
- `curl -i http://142.171.239.56:8081/login`

## 结果

### 1. 本地脚本静态检查

- `bash -n scripts/ops/dingtalk-onprem-docker-run.sh`
  - 结果：通过
- `bash scripts/ops/dingtalk-onprem-docker-run.sh --help`
  - 结果：通过
- `--dry-run all`
  - 结果：通过
  - 关键输出：
    - backend 命令固定包含 `--network-alias backend`
    - web 命令固定包含 `-p 8081:80`

### 2. 远端实际恢复

恢复前观察到：

- `metasheet-backend` / `metasheet-web` 容器均未运行
- 外部 `http://142.171.239.56:8081/login` 返回空响应

通过脚本恢复后：

- backend 以 `--network-alias backend` 重新启动
- web 以 `-p 8081:80` 重新启动
- `docker inspect metasheet-backend` 中 `Aliases=["backend"]`
- `docker inspect metasheet-web` 中 `HostPort="8081"`

远端实际复验：

- `GET http://127.0.0.1:8900/health` → `200`
- `GET http://127.0.0.1:8081/api/auth/dingtalk/launch` → `200`
- `GET http://142.171.239.56:8081/login` → `200`

### 3. 结果结论

这条 hardening 已把本次 DingTalk on-prem 登录 smoke 依赖的两个关键参数固化：

- backend 必须有 `backend` network alias
- web 必须对外暴露 `8081:80`

因此后续再做手工 `docker run` 替换时，不需要再凭记忆补参数。
