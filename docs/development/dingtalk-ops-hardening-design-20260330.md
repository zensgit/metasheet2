# DingTalk Ops Hardening Design

日期：2026-03-30

## 目标

把当前 DingTalk 目录/登录链路从"功能可用"推进到运营闭环：

- 管理员可见定时同步状态与告警
- 离职/停用操作可审计可回滚
- 待审核用户批量处理写入服务端审计记录

本轮不扩 Git 工具链，不涉及 attendance/workflow/kanban/snapshot 业务线。

## 新增接口

### 目录同步告警

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/admin/directory/sync/status` | 获取同步状态与告警等级 |
| POST | `/api/admin/directory/sync/acknowledge` | 管理员确认告警 |
| GET | `/api/admin/directory/sync/history` | 分页获取同步执行历史 |

### 离职审计与回滚

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/admin/directory/deprovisions` | 分页查询离职审计记录 |
| GET | `/api/admin/directory/deprovisions/{id}` | 获取离职操作详情与快照 |
| POST | `/api/admin/directory/deprovisions/{id}/rollback` | 回滚一次离职操作 |

### 批量处理

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/admin/users/batch` | 批量通过/拒绝待审核用户 |

## 数据模型

### directory_sync_status

单行记录，存储当前同步状态摘要。

```sql
CREATE TABLE IF NOT EXISTS directory_sync_status (
  id                      TEXT PRIMARY KEY DEFAULT 'singleton',
  last_sync_at            TIMESTAMPTZ,
  next_sync_at            TIMESTAMPTZ,
  status                  TEXT NOT NULL DEFAULT 'idle',   -- idle | running | failed | completed
  has_alert               BOOLEAN NOT NULL DEFAULT FALSE,
  alert_message           TEXT,
  alert_acknowledged_at   TIMESTAMPTZ,
  alert_acknowledged_by   TEXT
);
```

设计选择：

- 使用 singleton 行而非配置表，因为同步状态全局唯一
- `has_alert` 由 `recordSyncRun` 在 `status = 'failed'` 时自动置为 `TRUE`
- `acknowledge` 操作将 `has_alert` 置为 `FALSE` 并记录确认人和时间

### directory_sync_history

每次同步执行产生一条记录。

```sql
CREATE TABLE IF NOT EXISTS directory_sync_history (
  id              SERIAL PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'idle',      -- idle | running | failed | completed
  message         TEXT,
  synced_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_history_created ON directory_sync_history (created_at DESC);
```

设计选择：

- 保留完整执行记录，不做自动清理（管理员需要完整审计视图）
- `message` 字段记录同步失败原因或成功摘要

### deprovision_ledger

离职/停用操作审计账本。

```sql
CREATE TABLE IF NOT EXISTS deprovision_ledger (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  target_user_id  TEXT NOT NULL,
  performed_by    TEXT NOT NULL,
  reason          TEXT,
  user_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'executed',   -- executed | rolled-back
  rolled_back_by  TEXT,
  rolled_back_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deprovision_target ON deprovision_ledger (target_user_id);
CREATE INDEX IF NOT EXISTS idx_deprovision_created ON deprovision_ledger (created_at DESC);
```

设计选择：

- `user_snapshot` 存储 JSONB 格式的操作前状态（角色、权限、组、邮箱等），用于回滚恢复
- 回滚是更新操作，将 `status` 从 `executed` 改为 `rolled-back`
- 一条记录只能回滚一次（`status = 'rolled-back'` 后 WHERE 条件不再匹配）

## 审计设计

### 批量处理审计

`/api/admin/users/batch` 的 `approve`/`reject` 操作：

1. 每个用户独立处理，独立记录结果
2. 每个成功处理的用户产生一条 `audit_log` 记录：
   - `action`：`batch_approve` 或 `batch_reject`
   - `resource_type`：`user`
   - `resource_id`：被处理用户的 ID
   - `actor_id`：操作管理员 ID
   - `metadata`：包含 `{ action, reason, batchSize }`

### 离职审计

离职操作本身写入 `deprovision_ledger`，同时在 `audit_log` 中记录：

- `action`：`deprovision`
- `metadata`：`{ deprovisionId, action, userId }`

回滚操作同样双写：

- `deprovision_ledger` 将 `status` 从 `'executed'` 更新为 `'rolled-back'`
- `audit_log` 记录 `action: directory.deprovision.rollback`

### 同步告警确认审计

`acknowledge` 操作记入 `audit_log`：

- `action`：`directory.sync.acknowledge`
- `metadata`：`{ acknowledgedBy }`

## 前端变更

### DirectoryManagementView

新增"同步与告警"操作区：

- 显示当前同步状态（最近同步时间、状态、是否有告警）
- `hasAlert` 为 `true` 时显示告警横幅
- "确认告警"按钮调用 `acknowledge` 接口
- 同步历史列表（分页表格）

新增"离职审计"操作区：

- 离职记录列表（支持搜索、分页）
- 点击查看详情（含快照信息）
- "回滚"按钮（仅未回滚记录可操作）

### DingTalkAuthCallbackView

已回退为暂缓占位。页面静态展示"钉钉登录功能尚未开放"并提供"返回登录"按钮，不调用任何后端 API。路由 `/auth/dingtalk/callback` 保留，后端 OAuth 实现待后续 slice 补齐。

### UserManagementView

新增"批量处理"区域：

- 待审核用户列表支持多选
- "批量通过"/"批量拒绝"按钮
- 操作结果反馈（成功数、失败数、失败详情）
- 操作后自动刷新列表

## 非目标

本轮明确不做：

1. **Git 工具链扩展** — 不扩展 `scripts/ops/git-*` 系列工具
2. **实时同步推送** — 告警状态通过轮询获取，不做 WebSocket 推送
3. **自动回滚** — 回滚必须由管理员手动触发，不做自动回滚策略
4. **跨租户同步** — 当前只处理单租户场景
5. **DingTalk 侧回写** — 不向 DingTalk 侧写回任何状态
6. **attendance/workflow/kanban/snapshot 业务线** — 不触碰这些功能的代码
7. **批量处理异步化** — 当前批量处理为同步执行，不引入任务队列
