# On-Prem Container Lifecycle Investigation Design

日期：2026-04-02

## 目标

对 `2026-04-02` Day 1 稳定观察开始时 `metasheet-backend` / `metasheet-web` 容器缺失事件做出可证明的定性，并把最小防回归护栏固化到现有 on-prem 运维文档。

## 触发背景

Day 1 首次执行：

- `pnpm ops:dingtalk-oauth-stability-check`

直接失败，原因不是应用逻辑或 OAuth 回归，而是：

- `http://127.0.0.1:8900/health` 连接拒绝
- `http://127.0.0.1:8081/login` 连接拒绝

排查时发现：

- `metasheet-backend` 和 `metasheet-web` 容器均不存在
- Redis / Postgres / Prometheus / Grafana / Alertmanager 仍在运行

这说明故障范围不是整机或整套 Docker 崩溃，而是 app 容器生命周期发生了漂移。

## 设计问题

这次 investigation 要回答三个问题：

1. 容器缺失更像“自动故障”还是“人为/脚本操作”？
2. 这次事件有没有足够证据定位到具体 actor / 具体脚本？
3. 现阶段最小、可执行的护栏是什么？

## 证据源

本次 investigation 只依赖现有可复现证据：

- 宿主机 uptime / Docker daemon 信息
- `journalctl -u docker`
- root / mainuser shell history
- `docker ps -a`
- on-prem 目录与部署脚本时间线
- 当前已固化的 runbook / rollout 脚本

不把无法追溯、不可复现的聊天记忆当证据。

## 判断标准

### 自动故障

若是自动故障，应更接近以下模式：

- 宿主机重启
- Docker daemon 重启
- OOM / kernel kill
- healthcheck 持续失败导致自动替换
- restart policy 自动拉起失败但没有 `manually stopped` 痕迹

### 人为/脚本操作

若是人为或脚本操作，应更接近以下模式：

- Docker journal 出现 `hasBeenManuallyStopped=true`
- 同一时间窗口内多个容器连续 `TaskDelete`
- restart policy 被 `restart canceled` 绕过
- 伴随生产配置文件或 rollout 目录时间线变化

## 预期结论层级

本次 investigation 接受两种结论：

1. 强结论：能证明是某个具体命令或具体脚本
2. 次强结论：能证明是“批量手工 Docker 操作/不受支持 rollout 动作”，但不能归因到具体 actor

如果只能达到第 2 层，也足够支撑运维护栏。

## 防回归护栏

即使不能归因到具体 actor，本次 investigation 也要把以下规则固化：

1. 当前 host 的 app 容器只允许通过 `scripts/ops/dingtalk-onprem-docker-run.sh` 管理
2. `docker compose -f docker-compose.app.yml ... down/up` 不再作为该 host 的标准 app 运维入口
3. observability stack 继续允许使用其独立 compose 文件
4. 若再出现 backend/web 缺失，优先按 docker run runbook 恢复，再保留证据

## 非目标

- 不追溯到无法从现有日志证明的个人责任
- 不改应用代码
- 不重做容器编排体系
- 不把当前 host 从 `docker run` 直接迁回 compose / systemd
