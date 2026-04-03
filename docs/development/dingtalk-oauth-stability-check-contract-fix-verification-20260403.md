# DingTalk OAuth Stability Check Contract Fix Verification

日期：2026-04-03

## 范围

验证 `scripts/ops/dingtalk-oauth-stability-check.sh` 在 backend `/health` 仅返回 `status=ok` 时，不再误报 `healthy=false`。

## 实际执行

### 1. Day 2 初次日检

执行：

```bash
pnpm ops:dingtalk-oauth-stability-check
```

初次结果：

- `health.status=ok`
- `health.ok=None`
- `healthy=false`

这与实际服务状态不一致。

### 2. 远端原始 health 响应

执行：

```bash
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no \
  mainuser@142.171.239.56 'curl -fsS http://127.0.0.1:8900/health'
```

实际返回：

```json
{"status":"ok","timestamp":"2026-04-03T00:39:13.992Z","plugins":11,"pluginsSummary":{"total":11,"active":11,"failed":0},"dbPool":{"total":2,"idle":2,"waiting":0}}
```

结论：

- 服务本身健康
- checker 判定过严

### 3. 修复后复验

执行：

```bash
pnpm ops:dingtalk-oauth-stability-check
JSON_OUTPUT=true pnpm ops:dingtalk-oauth-stability-check
```

预期：

- 当 `status=ok` 且 webhook / notify error 条件满足时
- `healthy=true`

## 验证结论

这次修复关闭的是 Day 2 观察过程中的 false negative，不是服务端真实故障。
