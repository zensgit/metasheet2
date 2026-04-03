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
