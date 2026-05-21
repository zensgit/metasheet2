# On-Prem Docker GC Runbook

日期：2026-04-03

## 目标

为 `142.171.239.56` 安装一条低风险、可重复执行的 Docker 定期垃圾回收链，防止旧镜像和 build cache 再次把根分区打满。

## 安装

执行：

```bash
bash scripts/ops/install-dingtalk-onprem-docker-gc.sh
```

默认安装结果：

- 远端脚本：
  - `/home/mainuser/bin/dingtalk-onprem-docker-gc.sh`
- 远端日志目录：
  - `/home/mainuser/docker-gc-runs`
- 远端 cron：
  - `17 4 * * * REMOTE_SELF=true /home/mainuser/bin/dingtalk-onprem-docker-gc.sh >> /home/mainuser/docker-gc-runs/cron.log 2>&1`

## 查看状态

执行：

```bash
bash scripts/ops/install-dingtalk-onprem-docker-gc.sh --print-status
```

预期：

- `script_exists=true`
- `log_dir_exists=true`
- `cron_present=true`

## 手工执行一次

执行：

```bash
bash scripts/ops/dingtalk-onprem-docker-gc.sh
```

或 JSON：

```bash
JSON_OUTPUT=true bash scripts/ops/dingtalk-onprem-docker-gc.sh
```

报告会落到：

- `/home/mainuser/docker-gc-runs/docker-gc-*.json`

## GitHub deploy host sync 空间门禁

`Build and Push Docker Images` 在 deploy job 的 `Sync deploy host files`
阶段会先检查 deploy host 上 `DEPLOY_PATH` 所在文件系统的可用空间，再解包
`docker-compose.app.yml`、`docker/nginx.conf` 和 `scripts/ops/attendance-preflight.sh`。

默认门槛：

- `DEPLOY_SYNC_MIN_FREE_KB=1048576`（1 GiB）
- 低于这个值时，deploy host
  通常已经接近无法可靠完成镜像拉取、解包和日志写入。

可通过 GitHub repository variable `DEPLOY_SYNC_MIN_FREE_KB` 调整。这个门槛只用于
deploy host 文件同步前置检查；它不会清理磁盘，也不会停止容器。

如果 workflow 在 `Sync deploy host files` 阶段失败并出现类似输出：

```text
[host-sync] disk_available_kb=...
[host-sync][error] deploy host free space is below the sync gate
```

处理顺序：

1. SSH 到 deploy host。
2. 先查看根分区和 Docker 占用：

   ```bash
   df -h /
   docker system df
   ```

3. 执行一次手工 GC：

   ```bash
   bash scripts/ops/dingtalk-onprem-docker-gc.sh
   ```

   如果希望直接从 GitHub Actions 触发既有远端 GC，也可以手工运行
   `Attendance Remote Docker GC (Prod)` workflow；它会输出 `df -h` 和
   `docker system df` 证据。

4. 再确认空间：

   ```bash
   df -h /
   docker system df
   ```

5. 重新运行失败的 `Build and Push Docker Images` workflow。

如果 workflow 仍然显示：

```text
tar: ... Cannot write: No space left on device
```

说明磁盘在 preflight 之后、解包期间仍被占满，或门槛设得过低。先继续释放
deploy host 空间；必要时把 repository variable `DEPLOY_SYNC_MIN_FREE_KB`
调高后再重跑。

## 验证

执行：

```bash
bash scripts/ops/verify-dingtalk-onprem-docker-gc.sh
```

预期：

- `cron_present=true`
- `ok=true`

## 与稳定性检查的关系

当前 `dingtalk-oauth-stability-check.sh` 已增加磁盘门禁：

- 默认阈值：`MAX_ROOT_USE_PERCENT=95`
- 超阈值时，即使服务接口仍正常，也会判定 `healthy=false`

因此推荐的运维节奏是：

1. 保持 cron 自动 GC
2. 继续使用本机 `launchd` stability/drill
3. 继续使用 GitHub `DingTalk OAuth Stability Recording (Lite)` 做被动留档

## 清理边界

会清理：

- `docker image prune -a -f --filter until=168h`
- `docker container prune -f --filter until=168h`
- `docker network prune -f --filter until=168h`
- `docker builder prune -a -f --filter unused-for=168h`

不会清理：

- 当前运行中的容器
- volume
- Slack webhook / Alertmanager / Redis / Postgres 配置
