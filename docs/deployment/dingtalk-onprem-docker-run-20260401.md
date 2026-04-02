# DingTalk On-Prem Docker Run 标准参数

日期：2026-04-01

## 适用场景

适用于 `docker-compose v1.29.2` 仍不可用、需要手工使用 `docker run` 替换 `metasheet-backend` / `metasheet-web` 的 on-prem 环境。

## 生产硬规则

当前 `142.171.239.56` 的 app 容器管理只支持这一条入口：

- `scripts/ops/dingtalk-onprem-docker-run.sh`

明确不支持：

- `docker compose -f docker-compose.app.yml ... up/down` 作为当前 host 的 app 运维入口
- 在 `/home/mainuser/metasheet2`、`/home/mainuser/metasheet2-rollout-*`、`/home/mainuser/metasheet2-git-baseline` 之间混用 app stack 的 compose 命令

原因：

- `2026-04-02` 的容器生命周期 investigation 已证明，app 容器缺失事件更像一次不受支持的批量 Docker 操作，而不是自动故障
- observability stack 可以继续使用它自己的 compose 文件，但 app stack 不再允许这样做

## 必须参数

### Backend

必须同时满足：

- `--network metasheet2_default`
- `--network-alias backend`
- `--env-file /home/mainuser/metasheet2/docker/app.env`
- `-v metasheet-attendance-import-data:/app/uploads/attendance-import`
- `-p 127.0.0.1:8900:8900`

原因：

- `backend` alias 是 `docker/nginx.conf` 中 `/api/*` 同源代理解析的固定名字
- `127.0.0.1:8900:8900` 保持 backend 仅对宿主机本地开放，外部流量继续经过 web

### Web

必须同时满足：

- `--network metasheet2_default`
- `-p 8081:80`

原因：

- DingTalk 登录和前端浏览器 smoke 都从外部访问 `http://<host>:8081`
- 如果只绑到 `127.0.0.1:8081`，远端本机 curl 正常，但浏览器外部访问会失败

## 标准脚本

推荐直接使用：

```bash
BACKEND_IMAGE=ghcr.io/zensgit/metasheet2-backend:<tag> \
WEB_IMAGE=ghcr.io/zensgit/metasheet2-web:<tag> \
ENV_FILE=/home/mainuser/metasheet2/docker/app.env \
bash scripts/ops/dingtalk-onprem-docker-run.sh all
```

只替换 backend：

```bash
BACKEND_IMAGE=ghcr.io/zensgit/metasheet2-backend:<tag> \
ENV_FILE=/home/mainuser/metasheet2/docker/app.env \
bash scripts/ops/dingtalk-onprem-docker-run.sh backend
```

只替换 web：

```bash
WEB_IMAGE=ghcr.io/zensgit/metasheet2-web:<tag> \
bash scripts/ops/dingtalk-onprem-docker-run.sh web
```

## 最小复验

```bash
curl -s http://127.0.0.1:8900/health
curl -i http://127.0.0.1:8081/api/auth/dingtalk/launch
curl -i http://<host>:8081/login
```

期望：

- `/health` 返回 `200`
- `/api/auth/dingtalk/launch` 返回 `200` 或按配置返回 `503`
- `/login` 从宿主机外部访问返回 `200`

## 缺失恢复

如果日检发现 `metasheet-backend` / `metasheet-web` 缺失：

1. 不要先跑 app compose
2. 先保留证据：
   - `journalctl -u docker`
   - `docker ps -a`
   - `stat /home/mainuser/metasheet2/docker/app.env`
3. 再按本页标准脚本恢复

关联调查：

- `docs/development/onprem-container-lifecycle-investigation-design-20260402.md`
- `docs/development/onprem-container-lifecycle-investigation-verification-20260402.md`
