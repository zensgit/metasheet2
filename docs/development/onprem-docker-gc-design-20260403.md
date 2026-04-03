# On-Prem Docker GC Design

日期：2026-04-03

## 背景

`2026-04-03` 的自动 DingTalk OAuth drill 失败，日志为：

- `base64: write error: No space left on device`

进一步排查确认：

- 目标主机 `142.171.239.56` 根分区 `/` 一度达到 `100%`
- `/tmp` 不是单独的大目录，核心问题是整盘被 Docker 历史镜像和 build cache 挤满
- 当根分区写满时，`dingtalk-onprem-alert-drill.sh` 在远端创建临时文件就会失败

## 目标

补一条长期可执行的 on-prem Docker 垃圾回收链，要求：

- 不影响当前运行中的 app / observability 容器
- 只清理未被运行容器引用的历史镜像、旧 stopped container、旧 network 和 build cache
- 支持远端持久化安装
- 支持状态查看和一次性手工验证
- 把根分区利用率纳入现有 `dingtalk-oauth-stability-check.sh` 的健康门禁

## 方案

### 1. 远端 GC 执行脚本

新增：

- `scripts/ops/dingtalk-onprem-docker-gc.sh`

职责：

- 本地调用时通过 SSH 自传输到 `142.171.239.56`
- 远端自执行时：
  - 采集 `df -P /` 前后快照
  - 执行：
    - `docker image prune -a -f --filter until=168h`
    - `docker container prune -f --filter until=168h`
    - `docker network prune -f --filter until=168h`
    - `docker builder prune -a -f --filter unused-for=168h`
  - 输出 JSON / 文本报告
  - 将每次结果落到 `/home/mainuser/docker-gc-runs/docker-gc-*.json`

边界：

- 不做 `docker volume prune`
- 不停止或重启任何容器
- `image prune -a` 只删除未被当前容器使用的历史镜像

### 2. 远端持久化安装

新增：

- `scripts/ops/install-dingtalk-onprem-docker-gc.sh`

职责：

- 将 GC 脚本安装到：
  - `/home/mainuser/bin/dingtalk-onprem-docker-gc.sh`
- 创建日志目录：
  - `/home/mainuser/docker-gc-runs`
- 为 `mainuser` 安装 cron：
  - `17 4 * * * REMOTE_SELF=true /home/mainuser/bin/dingtalk-onprem-docker-gc.sh >> /home/mainuser/docker-gc-runs/cron.log 2>&1`

理由：

- cron 成本低，不要求 root
- `REMOTE_SELF=true` 明确让远端脚本本地执行，避免再次 SSH 自己
- 固定日志目录便于事后排查

### 3. 验证入口

新增：

- `scripts/ops/verify-dingtalk-onprem-docker-gc.sh`

职责：

- 读取安装状态
- 实际执行一次远端 GC
- 断言：
  - `script_exists=true`
  - `cron_present=true`
  - 根分区仍有可用空间
  - 当前运行容器数量大于 0

### 4. 稳定性门禁补强

更新：

- `scripts/ops/dingtalk-oauth-stability-check.sh`
- `scripts/ops/github-dingtalk-oauth-stability-summary.py`

变更：

- 增加 `storage.root.usePercent`
- 默认门禁阈值：
  - `MAX_ROOT_USE_PERCENT=95`
- 超过阈值时，即使服务本身 `health.status=ok`，也会把整条稳定性检查判为 `healthy=false`
- GitHub lite recording summary 同步显示根分区使用率

## 结果

这一条设计把问题从“手工救火”推进到：

- 远端定期 GC
- 稳定性检查可提前暴露磁盘风险
- 失败后有固定报告和日志可追
