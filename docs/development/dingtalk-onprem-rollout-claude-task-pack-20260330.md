# DingTalk On-Prem Rollout Claude Task Pack

日期：2026-03-30

## 目标

把两条已通过的能力真正落到 on-prem 目标环境，而不是停留在本地代码和文档收口：

1. `dingtalk-ops-hardening`
2. `dingtalk-oauth-backend`

本轮重点是 **部署、配置、执行、验证**，不是新功能开发。

## 目标环境

- 目标主机：`142.171.239.56`
- 目标用户：优先使用当前已恢复的 `mainuser` SSH 访问
- 当前部署目录：`/home/mainuser/metasheet2`
- 当前 clean baseline clone：`/home/mainuser/metasheet2-git-baseline`
- backend 健康端点：`http://127.0.0.1:8900/health`
- 前端入口：`http://142.171.239.56:8081`

## 现有部署文档

Claude Code 本轮以这两份部署文档为事实基础执行：

- [dingtalk-ops-hardening-deploy-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-ops-hardening-deploy-20260330.md)
- [dingtalk-oauth-backend-deploy-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-oauth-backend-deploy-20260330.md)

## 允许写入

- `docs/deployment/dingtalk-ops-hardening-deploy-20260330.md`
- `docs/deployment/dingtalk-oauth-backend-deploy-20260330.md`
- `docs/deployment/dingtalk-onprem-rollout-verification-20260330.md`
- `docs/development/dingtalk-onprem-rollout-claude-task-pack-20260330.md`
- `docs/development/dingtalk-onprem-rollout-claude-verification-template-20260330.md`
- `docs/verification-index.md`
- `scripts/dingtalk-directory-smoke.mjs`
- `scripts/dingtalk-oauth-smoke.mjs`

## 明确禁止

本轮不允许修改：

- `packages/core-backend/src/**`
- `packages/core-backend/tests/**`
- `apps/web/src/**`
- `apps/web/tests/**`
- `packages/openapi/src/**`
- `scripts/ops/git-*`
- `scripts/ops/*remote-git-slice*`
- `output/**`

如果 rollout 过程中发现必须改运行时代码，立刻停止，并在报告里明确列为 blocker；不要顺手修代码。

## 必做项

### 1. 执行 ops hardening DDL

把 [dingtalk-ops-hardening-deploy-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-ops-hardening-deploy-20260330.md) 中的 DDL 真正执行到目标环境。

至少确认这几个对象存在：

- `directory_sync_status`
- `directory_sync_history`
- `deprovision_ledger`

如环境允许，也确认 `users.dingtalk_open_id` 列是否存在；若不存在但本轮未执行，也要明确写进报告。

### 2. 配置 OAuth 环境变量

按 [dingtalk-oauth-backend-deploy-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-oauth-backend-deploy-20260330.md)：

- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `DINGTALK_REDIRECT_URI`

要求：

- 可以在报告里红acted 展示是否已配置
- 不要把明文 secret 写入 repo 或文档

### 3. 重启并确认服务健康

完成 DDL 和 env 后，按目标环境当前实际方式重启服务。

必须验证：

- `http://127.0.0.1:8900/health` 正常
- 若当前环境是容器部署，记录容器名和重启方式
- 若当前环境不是容器，记录 systemd / pm2 / 其他方式

### 4. 跑真实 smoke

必须跑两类验证：

#### OAuth

- `node scripts/dingtalk-oauth-smoke.mjs --base-url http://127.0.0.1:8900`

至少覆盖：

- launch 可达
- callback 缺 code → 400
- callback 错误 state → 400

#### Directory ops

- `node scripts/dingtalk-directory-smoke.mjs --base-url http://127.0.0.1:8900`
- 如果能获得 admin token，再跑：
  - `node scripts/dingtalk-directory-smoke.mjs --base-url http://127.0.0.1:8900 --token <admin-token>`

### 5. 手动验收事实

至少确认并写入报告：

- DingTalk env 缺失时是否自动降级
- DingTalk env 就绪时 `/api/auth/dingtalk/launch` 是否返回 200
- 目录同步三张表是否真实可读
- 如果能做浏览器验证，登录页是否显示 DingTalk 按钮

## 交付结果格式

Claude Code 回传时必须包含：

- 实际执行命令清单
- 每条命令 pass / fail
- 目标主机上的实际部署方式
- DDL 是否已执行
- OAuth env 是否已配置（值可脱敏）
- health / smoke 结果
- 未解决风险
- 回填到 [dingtalk-onprem-rollout-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-onprem-rollout-verification-20260330.md) 的内容

## Codex 独立验收标准

我会独立复核：

- 是否没有越界修改运行时代码
- 目标环境的 DDL 是否真实落地
- health 是否正常
- OAuth smoke / directory smoke 是否真实执行
- 报告里是否给出明确的 env / DDL / health / smoke 事实，而不是泛泛“部署成功”

## 给 Claude Code 的直接提示词

```text
Execute the "dingtalk-onprem-rollout" task pack in /Users/huazhou/Downloads/Github/metasheet2.

This is a deployment/rollout slice, not a feature-development slice.

Target environment:
- host: 142.171.239.56
- user: mainuser (use the currently restored SSH access)
- deploy dir: /home/mainuser/metasheet2
- clean baseline clone: /home/mainuser/metasheet2-git-baseline
- backend health: http://127.0.0.1:8900/health
- frontend entry: http://142.171.239.56:8081

Use these existing deployment docs as the source of truth:
- docs/deployment/dingtalk-ops-hardening-deploy-20260330.md
- docs/deployment/dingtalk-oauth-backend-deploy-20260330.md

Write boundary:
- docs/deployment/dingtalk-ops-hardening-deploy-20260330.md
- docs/deployment/dingtalk-oauth-backend-deploy-20260330.md
- docs/deployment/dingtalk-onprem-rollout-verification-20260330.md
- docs/development/dingtalk-onprem-rollout-claude-task-pack-20260330.md
- docs/development/dingtalk-onprem-rollout-claude-verification-template-20260330.md
- docs/verification-index.md
- scripts/dingtalk-directory-smoke.mjs
- scripts/dingtalk-oauth-smoke.mjs

Do not modify:
- packages/core-backend/src/**
- packages/core-backend/tests/**
- apps/web/src/**
- apps/web/tests/**
- packages/openapi/src/**
- scripts/ops/git-*
- scripts/ops/*remote-git-slice*
- output/**

Goals:
1. execute the DingTalk ops hardening DDL on the target environment
2. configure DingTalk OAuth env vars on the target environment
3. restart services using the environment's real deployment mechanism
4. verify health
5. run both OAuth and directory smoke against the target backend
6. write a factual rollout verification report

Required facts to collect:
- whether directory_sync_status, directory_sync_history, deprovision_ledger exist
- whether users.dingtalk_open_id exists
- whether DingTalk env vars are configured (redact values)
- health result
- OAuth smoke result
- directory smoke result

If you discover rollout blockers that require runtime code changes, stop and report them. Do not change runtime code in this slice.

Return:
- commands run with pass/fail
- actual deployment mechanism on the target host
- whether DDL was applied
- whether OAuth env is configured
- health/smoke results
- unresolved risks
- rollout verification doc path
```
