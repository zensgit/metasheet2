# DingTalk On-Prem Rollout Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 执行完 on-prem rollout 后做独立验收时使用。

## 必核项

### 1. 写边界

- 是否只改了 rollout 允许路径
- 是否没有误碰任何运行时代码 / 测试代码 / OpenAPI

### 2. 目标环境事实

- 目标主机是否真的是 `142.171.239.56`
- 部署目录是否真的是 `/home/mainuser/metasheet2`
- 是否记录了真实部署方式（docker / systemd / pm2 / 其他）

### 3. DDL 落地

- 是否确认存在：
  - `directory_sync_status`
  - `directory_sync_history`
  - `deprovision_ledger`
- 是否记录了 `users.dingtalk_open_id` 的实际状态

### 4. OAuth 配置

- 是否确认 `DINGTALK_CLIENT_ID`
- 是否确认 `DINGTALK_CLIENT_SECRET`
- 是否确认 `DINGTALK_REDIRECT_URI`
- 是否对 secret 做了脱敏

### 5. 健康与 smoke

- `http://127.0.0.1:8900/health` 是否正常
- `node scripts/dingtalk-oauth-smoke.mjs --base-url http://127.0.0.1:8900` 是否执行
- `node scripts/dingtalk-directory-smoke.mjs --base-url http://127.0.0.1:8900` 是否执行
- 如果有 admin token，带 token 的 directory smoke 是否执行

### 6. 报告质量

- [dingtalk-onprem-rollout-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/dingtalk-onprem-rollout-verification-20260330.md) 是否写成事实报告
- 是否给出未解决风险，而不是笼统“部署成功”

## 建议独立复核命令

```bash
curl -s http://127.0.0.1:8900/health
node scripts/dingtalk-oauth-smoke.mjs --base-url http://127.0.0.1:8900
node scripts/dingtalk-directory-smoke.mjs --base-url http://127.0.0.1:8900
```
