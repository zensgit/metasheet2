# DingTalk Ops Hardening 部署清单

日期：2026-03-30

适用场景：已部署 MetaSheet 的环境，新增 DingTalk 目录运营硬化功能。

---

## A. 数据库迁移

### 1. 创建 directory_sync_status 表

列名与 `DirectorySyncService.ts` 的 `SyncStatusRow` 完全一致。

```sql
CREATE TABLE IF NOT EXISTS directory_sync_status (
  id                      TEXT PRIMARY KEY DEFAULT 'singleton',
  last_sync_at            TIMESTAMPTZ,
  next_sync_at            TIMESTAMPTZ,
  status                  TEXT NOT NULL DEFAULT 'idle',
  has_alert               BOOLEAN NOT NULL DEFAULT FALSE,
  alert_message           TEXT,
  alert_acknowledged_at   TIMESTAMPTZ,
  alert_acknowledged_by   TEXT
);

-- 初始化 singleton 行
INSERT INTO directory_sync_status (id) VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;
```

### 2. 创建 directory_sync_history 表

列名与 `DirectorySyncService.ts` 的 `SyncHistoryRow` 完全一致。

```sql
CREATE TABLE IF NOT EXISTS directory_sync_history (
  id              SERIAL PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'idle',
  message         TEXT,
  synced_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_history_created
  ON directory_sync_history (created_at DESC);
```

### 3. 创建 deprovision_ledger 表

列名与 `deprovision-ledger.ts` 的 `DeprovisionRow` 完全一致。

```sql
CREATE TABLE IF NOT EXISTS deprovision_ledger (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  target_user_id  TEXT NOT NULL,
  performed_by    TEXT NOT NULL,
  reason          TEXT,
  user_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'executed',
  rolled_back_by  TEXT,
  rolled_back_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deprovision_target
  ON deprovision_ledger (target_user_id);

CREATE INDEX IF NOT EXISTS idx_deprovision_created
  ON deprovision_ledger (created_at DESC);
```

### 执行方式

```bash
# 在目标服务器上通过 psql 执行
psql -U metasheet -d metasheet -f migrations/dingtalk-ops-hardening.sql

# 或逐条执行
psql -U metasheet -d metasheet
```

## B. 环境变量

本轮新增功能不引入新的必填环境变量。以下为可选配置：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `DIRECTORY_SYNC_INTERVAL_MS` | `3600000` (1h) | 目录同步定时间隔 |
| `DIRECTORY_SYNC_ALERT_THRESHOLD` | `0.5` | 告警阈值（失败比例） |
| `DEPROVISION_SNAPSHOT_ENABLED` | `true` | 是否在离职操作时保存快照 |

如需配置，在 `docker/app.env` 或服务环境中添加对应变量。

## C. 部署步骤

### 1. 拉取最新代码或交付包

```bash
cd /opt/metasheet
# 如果使用 Git
git pull origin main

# 如果使用交付包
tar xzf metasheet-<version>.tgz
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 执行数据库迁移

```bash
psql -U metasheet -d metasheet <<'EOF'
-- 粘贴上述 A 节的全部 SQL
EOF
```

### 4. 构建

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

### 5. 重启服务

```bash
# systemd 方式
sudo systemctl restart metasheet-api
sudo systemctl restart metasheet-web

# 或 PM2 方式
pm2 restart metasheet-api
pm2 restart metasheet-web
```

## D. 验证步骤

### 1. 健康检查

```bash
curl -s http://localhost:7778/health | jq .
# 期望：{ "ok": true }
```

### 2. Smoke 测试

```bash
# 无 token 模式（验证端点可达）
node scripts/dingtalk-directory-smoke.mjs

# 有 token 模式（验证端点功能）
node scripts/dingtalk-directory-smoke.mjs --token <admin-token>
```

### 3. 手动验证

- [ ] 访问管理后台，确认目录管理页显示同步状态
- [ ] 确认告警横幅在有未确认告警时显示
- [ ] 确认离职审计列表可访问
- [ ] 确认用户管理页批量操作按钮可见
- [ ] 确认 OpenAPI 校验通过：`node scripts/openapi-check.mjs`

## E. 回滚方案

### 回滚代码

```bash
# 方式 1：Git 回退
cd /opt/metasheet
git checkout <previous-commit>
pnpm install
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
sudo systemctl restart metasheet-api
sudo systemctl restart metasheet-web

# 方式 2：交付包回退
cd /opt/metasheet
tar xzf metasheet-<previous-version>.tgz
pnpm install
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
sudo systemctl restart metasheet-api
sudo systemctl restart metasheet-web
```

### 回滚数据库

本轮新增的三张表为独立表，不影响既有业务数据。如需回滚：

```sql
-- 仅在确认不需要保留数据时执行
DROP TABLE IF EXISTS directory_sync_status;
DROP TABLE IF EXISTS directory_sync_history;
DROP TABLE IF EXISTS deprovision_ledger;
```

注意：回滚数据库会丢失同步历史和离职审计数据，请在回滚前确认是否需要备份。

### 回滚后验证

```bash
curl -s http://localhost:7778/health | jq .
node scripts/verify-smoke-core.mjs
```
