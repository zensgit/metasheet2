# On-Prem Alertmanager Webhook Persistence Design

日期：2026-04-01

## 目标

把 Alertmanager 外部 webhook 从“每次 rollout 手工传环境变量”收口成 on-prem 主机上的持久化配置能力。

## 方案

### 1. 引入专用持久化 env 文件

新增模板：

- `docker/observability/alertmanager/alertmanager.onprem.env.example`

远端正式配置文件路径：

- `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.env`

文件仅保存：

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/webhook
```

并要求：

- 不提交真实值
- 宿主机上权限为 `600`

### 2. 新增远端配置脚本

新增：

- `scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh`

职责：

- `set`：写入远端持久化 webhook URL
- `--set-local-default`：把持久化配置恢复为安全本地默认 receiver
- `--clear`：删除远端持久化配置（仅在需要回退到纯 fallback 行为时使用）
- `--print-status`：输出是否已配置，以及经脱敏后的 host / scheme 信息

### 3. rollout 读取优先级

`scripts/ops/dingtalk-onprem-alert-notify-rollout.sh` 调整为：

1. 显式 `ALERTMANAGER_WEBHOOK_URL` 环境变量
2. 远端持久化配置文件 `alertmanager.onprem.env`
3. 本地默认 receiver `http://alert-webhook:8080/notify`

这样既能支持一次性覆盖，也能支持长期持久配置。

### 4. 用一次性外部端点验证持久化逻辑

当前没有现成长期生产 webhook 凭据，因此本轮用 Webhook.site 做一次性 exercise：

1. 先通过 `set-dingtalk-onprem-alertmanager-webhook-config.sh` 写入临时外部 URL
2. 不再通过环境变量传参，直接执行 notify rollout
3. 确认外部请求命中
4. 通过 `--set-local-default` 恢复到安全本地默认 receiver

## 非目标

- 不在本轮引入新的 secrets manager
- 不在本轮把真实第三方 webhook 提交到仓库
- 不在本轮改变 Alertmanager 本地自证路径
