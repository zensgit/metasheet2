# Yjs 协同编辑内部试点 — Rollout Checklist

Date: 2026-04-16

## 前提条件

- [ ] `ENABLE_YJS_COLLAB=true` 设置在目标环境
- [ ] PostgreSQL 已执行迁移 `zzzz20260501100000_create_yjs_state_tables`
- [ ] Redis 可用（rate limiter 用，非 Yjs 必需）
- [ ] WebSocket (Socket.IO) 正常运行
- [ ] 管理员可访问 `GET /api/admin/yjs/status`

## 开启步骤

1. 选定试点 sheet（建议 1-3 张，活跃但非关键）
2. 设置 `ENABLE_YJS_COLLAB=true`
3. 重启服务
4. 确认 `/api/admin/yjs/status` 返回 `initialized: true`
5. 通知试点用户在浏览器中打开目标 sheet

可选脚本化检查：

```bash
YJS_BASE_URL=http://localhost:3000 \
YJS_ADMIN_TOKEN=$ADMIN_TOKEN \
node scripts/ops/check-yjs-rollout-status.mjs

YJS_DATABASE_URL=$DATABASE_URL \
node scripts/ops/check-yjs-retention-health.mjs
```
## 监控项

| 指标 | 来源 | 预期 | 告警阈值 |
|---|---|---|---|
| Active doc count | `/api/admin/yjs/status` → sync.activeDocCount | < 50 | > 200 |
| Bridge flush failures | `/api/admin/yjs/status` → bridge.flushFailureCount | 0 | > 10/min |
| Bridge pending writes | `/api/admin/yjs/status` → bridge.pendingWriteCount | < 5 | > 50 |
| Active socket count | `/api/admin/yjs/status` → socket.activeSocketCount | < 100 | > 500 |
| yjs_updates 行数 | SQL: `SELECT count(*) FROM meta_record_yjs_updates` | < 10K | > 100K |
| yjs_states 行数 | SQL: `SELECT count(*) FROM meta_record_yjs_states` | = active records | — |

## 回滚步骤

1. 设置 `ENABLE_YJS_COLLAB=false`（或删除该 env var）
2. 重启服务
3. `/yjs` namespace 停止接受连接
4. 现有 REST 功能不受影响
5. `meta_record_yjs_states/updates` 数据保留，不需要清理

## 已知限制

- 仅支持 text 字段的字符级合并
- 非 text 字段不参与 Yjs 同步
- 记录的创建/删除不通过 Yjs
- 单进程模式（sticky session），不支持多实例横向扩展
- Compaction 在 doc release 时触发，不是定时任务
- 200ms 合并窗口内多用户编辑 → 主要归因为第一个用户
