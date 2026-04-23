# Approval Wave 2 WP3 slice 2 — 已读/未读 (开发记录)

- Date: 2026-04-23
- Branch: `codex/approval-wave2-wp3-approval-reads-20260423`
- Base: `origin/main@61f32f318`
- Scope owner: `docs/development/approval-mvp-wave2-scope-breakdown-20260411.md` §WP3

## 范围

WP3 slice 2 关掉飞书 Gap Matrix (§审批中心/Inbox) 里“已读/未读标记”和“消息红点/计数”两行的 MVP 缺口。Slice 1 已经落地了 `POST /:id/remind` 与 `GET /pending-count`，这次叠加 `approval_reads` 持久化、`mark-read` / `mark-all-read` 接口，并把待办红点切换到 **未读** 语义。

## 数据模型

### 新表 `approval_reads`

```sql
CREATE TABLE IF NOT EXISTS approval_reads (
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_approval_reads_user_read_at
  ON approval_reads(user_id, read_at DESC);
```

- 语义: **“一个用户什么时候把某审批实例标记为已读”**。不是“阅读事件流水”，因此复合主键取 `(user_id, instance_id)`；重复标记走 `ON CONFLICT DO UPDATE` 刷新 `read_at`。
- FK `ON DELETE CASCADE` 与 `approval_records` / `approval_assignments` 保持一致——实例被撤销时清除读状态；避免 orphan 行。
- 索引只建 `(user_id, read_at DESC)`，覆盖未来“我最近读过哪些”这类查询；未读计数本身用 pending-count 的 LEFT JOIN 实现，无需额外索引。

### 迁移

`packages/core-backend/src/db/migrations/zzzz20260423140000_create_approval_reads.ts`

- 双向：up 建表 + 索引；down drop 索引 + 表。
- 时间戳 `140000` 排在 slice 1 的 `120000`（remind action）和 dingtalk org scope 的 `130000` 之后。

### 测试 bootstrap

`packages/core-backend/tests/helpers/approval-schema-bootstrap.ts` 同步加上表/索引的 DDL，并把版本标记从 `20260423-wp3-remind-action` 推进到 `20260423-wp3-approval-reads`，确保并行 vitest worker 会重跑新的 DDL 而不是继续吃 slice 1 的缓存。

## 后端契约

### `POST /api/approvals/:id/mark-read`

- 权限：`approvals:read` —— 任何能看到审批的用户都可以对“自己”标记已读。**不做** requester / assignee 收窄，读状态是 presence 数据，不是审批行为，且 pending-count 查询天然只计算当前 actor 的活跃 assignments，所以旁观者的 `approval_reads` 行不会污染其他人的 `unreadCount`。
- 行为：`INSERT ... ON CONFLICT (user_id, instance_id) DO UPDATE SET read_at = now()`，幂等。
- 响应：`{ ok: true }`。
- PLM 边界 (见下文): 当 `:id` 尚未同步到 `approval_instances` 时返回 `{ ok: true, skipped: true, reason: 'instance_not_materialized' }`（仍是 200）。

### `POST /api/approvals/mark-all-read`

- 权限：`approvals:read`。
- Body：`{ sourceSystem?: 'all' | 'platform' | 'plm' }`，默认 `all`，未知值 400。
- 行为：对当前 actor 的**活跃 pending assignments**（与 pending-count 同口径：`is_active=TRUE` + `status='pending'` + user/role 匹配）批量 upsert。
- 实现：`INSERT ... SELECT DISTINCT a.instance_id FROM approval_assignments a INNER JOIN approval_instances i ... ON CONFLICT DO UPDATE ... RETURNING instance_id`，一次 round-trip，`DISTINCT` 去重角色 join 造成的同 instance_id 重复。
- 响应：`{ markedCount: N }`，N 是实际 upsert 的 distinct instance_id 数量（包括已存在行的“刷新 read_at”）。

### `GET /api/approvals/pending-count`（扩展，**additive**）

- 响应新增 `unreadCount`。原 `count` 保留未改。
- SQL 改为：

```sql
SELECT COUNT(DISTINCT a.instance_id)::text AS count,
       COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
FROM approval_assignments a
INNER JOIN approval_instances i ON i.id = a.instance_id
LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
WHERE ...
```

- 单 round-trip。`DISTINCT` 维持与 slice 1 一致的去重语义，`FILTER (WHERE r.instance_id IS NULL)` 命中了“user 没读过的 instance”。
- `degraded` 分支也补了 `unreadCount: 0`。

## PLM / external source 的边界

Slice 1 的 pending-count 说明已经指出 PLM 审批在“assignment 没回灌回平台”的场景下不进入统计。对 slice 2 的 `mark-read` 我们也要面对：一个前端可见但 `approval_instances` 里尚未有行的 PLM 审批 id。

**选择：skip-no-op**。原因：
- FK `approval_reads.instance_id REFERENCES approval_instances(id)`。直接 upsert 会触发 23503（foreign_key_violation）。
- 详情页按设计是 fire-and-forget；如果因为 FK 失败而 500，会在控制台糊一堆红字；但业务语义上“这个审批我看过了”本应静默生效。
- 所以 handler 先 `SELECT 1 FROM approval_instances WHERE id=$1`，如果不存在就返回 `{ ok:true, skipped:true, reason:'instance_not_materialized' }`，HTTP 仍然 200。
- 代价：该 PLM 审批在重新同步回 `approval_instances` 之前，用户的这次“读”不会被持久化；下次再打开详情页，mark-read 再次尝试，此时实例可能已经回灌成功，就正常记录。
- 这比 404（前端要吞 toast）或 500（控制台污染）更稳。

覆盖在 `approval-wp3-reads.api.test.ts > mark-read on an unsynced PLM instance id ...` 下。

## 前端改动

### API 客户端 `apps/web/src/approvals/api.ts`

- `PendingCountResponse` 增补 `unreadCount: number`。
- 新增 `markApprovalRead(id)` → POST /mark-read。
- 新增 `markAllApprovalsRead(sourceSystem)` → POST /mark-all-read。
- USE_MOCK 分支把“每条待办都是未读”作为默认，保持开发模式下红点与列表同步。

### `ApprovalCenterView.vue`

- 红点数据源从 `count` 切到 `unreadCount`。命中 `> 0` 才显示徽标。
- 新增 `pendingTotalCount`，通过 el-tooltip 呈现“待办 X / 其中 Y 未读”以保留总量信息。
- 新增“全部标记已读”按钮（`data-testid="approval-mark-all-read"`），disabled 条件 `pendingBadgeCount <= 0`；点击后触发 `markAllApprovalsRead(currentSourceSystem)`，成功后重新拉 pending-count。Loading 状态本地化到按钮。
- Toast 使用 ElMessage.success；`已标记 N 条为已读` 或 `当前范围内无未读审批`。

### `ApprovalDetailView.vue`

- onMounted：`void markApprovalRead(id).catch(warn)`，不阻塞主详情加载。
- 错误记录到 `console.warn`，不弹 toast —— 已读状态属于 presence，用户不需要感知失败。

## 测试

### 后端（新 + 回归）

`tests/integration/approval-wp3-reads.api.test.ts` 新增 7 个用例：

1. pending-count before any read：`count === unreadCount === 3`
2. mark-read insert + idempotent update（`read_at` 单调不减）
3. pending-count reflect：`unreadCount` 从 3 掉到 2
4. mark-all-read bulk upsert → `markedCount: 3`，`unreadCount: 0`
5. mark-all-read w/ sourceSystem filter：仅平台 2 条被标记，PLM 1 条仍未读
6. unsynced PLM id：`{ ok:true, skipped:true, reason:'instance_not_materialized' }`，无 FK violation
7. 非 assignee 标记已读：允许，但对该用户的 unreadCount 无影响

Slice 1 的 `approval-wp3-pending-count.api.test.ts` / `approval-wp3-remind.api.test.ts` 原样通过——pending-count 响应里多一个 `unreadCount` 字段，对旧用例 `count` 断言无影响。

### 前端

`tests/approvalCenterUnreadBadge.spec.ts` 新增 6 个用例：

1. 红点显示 `unreadCount`（不是 `count`）
2. `unreadCount === 0` 但 `count > 0` 时红点隐藏
3. 全部标记已读：API 调用 + 红点刷新到 0
4. 无未读时“全部标记已读”按钮 disabled
5. 详情页 onMounted 触发 markApprovalRead
6. markApprovalRead 失败时不弹 error toast

slice 1 的 `approvalCenterRemindBadge.spec.ts` 更新 mock 让 `getPendingCount` 同时返回 `count` 和 `unreadCount`（两者相等），原断言保留。

## 延后项

- **WebSocket 实时同步**：红点变化仍依赖 tab 切换/按钮点击触发 refresh。WP3 slice 3 会引入推送通道让“对方审批后我这边红点立即减一”。
- **阅读事件流水**：当前 `approval_reads` 只记录“最近一次读”，不追加事件行。若将来需要阅读审计，应在 `approval_records` 扩展 `action='read'` 而不是在这张表做 append-only 改造。
- **跨端同步**：本 slice 只覆盖 Web；钉钉 mini-app / 移动端沿用 WP4 的移动端适配计划。
