# On-Prem Container Lifecycle Investigation Verification

日期：2026-04-02

## 范围

验证 Day 1 容器缺失事件的最可信根因，并确认需要固化的 on-prem 运维护栏。

## 实际执行

### 1. 事件起点

- `pnpm ops:dingtalk-oauth-stability-check`
  - 初次结果：失败
  - 现象：
    - `curl: (7) Failed to connect to 127.0.0.1 port 8900`
    - `curl: (7) Failed to connect to 127.0.0.1 port 8081`

### 2. 当前容器与主机状态

检查：

- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'`
- `docker inspect metasheet-backend metasheet-web --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}}'`
- `docker info --format 'DockerRootDir={{.DockerRootDir}} LoggingDriver={{.LoggingDriver}} CgroupDriver={{.CgroupDriver}} ServerVersion={{.ServerVersion}}'`
- `date -Is`
- `uptime`

结果：

- 事件发生时 backend/web 容器缺失
- host uptime 为 `4 days, 22:33`
- 没有宿主机重启证据
- 当前恢复后的 `metasheet-backend` / `metasheet-web` 都是 `restart=unless-stopped`

### 3. Docker journal

检查：

- `journalctl -u docker --since '2026-04-01 00:00:00' --no-pager | egrep 'metasheet|ShouldRestart failed|restart canceled|hasBeenManuallyStopped|compose|docker rm|docker stop'`
- `journalctl -u docker --since '2026-04-01 17:40:00' --until '2026-04-01 17:50:00' --no-pager -o short-iso | egrep 'metasheet|ShouldRestart failed|restart canceled|hasBeenManuallyStopped|container|compose'`
- `journalctl -u docker --since '2026-04-01 17:44:00' --until '2026-04-01 17:46:30' --no-pager -o cat`

关键结果：

- `2026-04-01T17:45:25Z` 到 `17:45:28Z` 间，多个容器连续出现：
  - `topic=/tasks/delete`
  - `ShouldRestart failed, container will not be restarted`
  - `error="restart canceled"`
  - `hasBeenManuallyStopped=true`
- 这不是 daemon shutdown，也不是宿主机 reboot。
- 这是 Docker 明确记录的“手工停止/删除后不再自动重启”模式。

### 4. shell history / sudo journal

检查：

- `/root/.bash_history`
- `/root/.zsh_history`
- `/home/mainuser/.bash_history`
- `/home/mainuser/.zsh_history`
- `journalctl _COMM=sudo --since '2026-04-01 00:00:00'`

结果：

- root history 没有与 `metasheet-backend` / `metasheet-web` 对应的直接 stop/down 记录
- mainuser history 基本为空
- `sudo` journal 无可用记录

结论：

- 现有保留历史不足以归因到具体 actor 或具体 shell 命令
- 但不足以推翻 Docker 自身的 `hasBeenManuallyStopped=true`

### 5. 文件与 rollout 时间线

检查：

- `stat -c '%y %n' /home/mainuser/metasheet2-rollout-oauth-state-observability ...`
- `find /home/mainuser -maxdepth 2 -mindepth 1 -type d -name 'metasheet2*' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' | sort`
- `grep -RniE 'docker compose .*down|docker-compose .*down|docker rm -f .*metasheet|docker stop .*metasheet' /home/mainuser/metasheet2* /root`
- 审阅：
  - `/home/mainuser/metasheet2-rollout-oauth-state-observability/scripts/deploy-ghcr.sh`
  - `/home/mainuser/metasheet2-rollout-oauth-state-observability/scripts/deploy-ghcr-gh.sh`
  - `/home/mainuser/metasheet2-rollout-oauth-state-observability/scripts/ops/deploy-attendance-prod.sh`

关键结果：

- host 上同时存在：
  - `/home/mainuser/metasheet2`
  - `/home/mainuser/metasheet2-git-baseline`
  - `/home/mainuser/metasheet2-rollout-oauth-state-redis`
  - `/home/mainuser/metasheet2-rollout-oauth-state-observability`
- rollout 目录和主 repo 中都存在 app stack 的 compose/up/down 说明与脚本。
- investigation 初始快照里，`/home/mainuser/metasheet2/docker/app.env` 的 mtime 为 `2026-04-01 17:45:25.512000000 +0000`，与第一条 `TaskDelete`/`restart canceled` 日志同秒。

结论：

- 现有证据更像“某次 rollout 或临时运维动作在 17:45 左右同时改动生产 env 并批量停止了 app 容器”。
- 但缺乏足够日志把它锁定为某一条具体脚本。

## 结论

### 1. 最可信根因

最可信结论不是“容器自己消失”，而是：

**在 `2026-04-01 17:45 UTC` 左右，宿主机上发生了一次不受支持的批量 Docker 运维动作，手工停止/删除了 app 容器；由于 Docker 将其记为 `hasBeenManuallyStopped=true`，`--restart unless-stopped` 没有再接管。**

### 2. 可证明范围

已证明：

- 不是宿主机 reboot
- 不是 Docker daemon shutdown
- 不是 restart policy 自然失效
- 是批量手工 stop/delete 模式

未证明：

- 具体是谁执行
- 具体是哪条 shell 命令
- 具体是哪个 rollout clone / 脚本被触发

### 3. 运维护栏

需要立刻固化：

1. 该 host 的 app 容器只允许通过 `scripts/ops/dingtalk-onprem-docker-run.sh` 管理
2. 不再把 `docker compose -f docker-compose.app.yml ... down/up` 当作当前 host 的标准 app 运维入口
3. observability stack 的 compose 入口继续独立保留
4. 若再次出现 backend/web 缺失，先按 docker run runbook 恢复，再保留 journal / mtime / history 证据

## 验证结论

这次 investigation 已把 Day 1 事件从“容器莫名消失”压缩成了有证据支撑的 root-cause 等级：

- **等级：批量手工 Docker 操作 / 不受支持 rollout 动作**
- **置信度：高**
- **具体 actor / 命令归因：未恢复**
