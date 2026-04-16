# Yjs 协同编辑运维手册

Date: 2026-04-16

## 1. 状态检查

```bash
# 确认 Yjs 是否启用
curl -s http://localhost:3000/api/admin/yjs/status -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# 或直接使用仓库脚本
YJS_BASE_URL=http://localhost:3000 \
YJS_ADMIN_TOKEN=$ADMIN_TOKEN \
node scripts/ops/check-yjs-rollout-status.mjs

# 预期输出
{
  "success": true,
  "yjs": {
    "enabled": true,
    "initialized": true,
    "sync": { "activeDocCount": 3, "docIds": ["rec_xxx", "rec_yyy", "rec_zzz"] },
    "bridge": { "pendingWriteCount": 0, "observedDocCount": 3, "flushSuccessCount": 42, "flushFailureCount": 0 },
    "socket": { "activeRecordCount": 2, "activeSocketCount": 5 }
  }
}
```

## 2. 常见问题排查

### Yjs 未初始化

**症状**: `initialized: false`

**排查**:
1. 检查 `ENABLE_YJS_COLLAB` 是否设为 `true`
2. 检查日志是否有 `Yjs: CollabService IO not available`
3. 确认 WebSocket 服务正常

### Bridge flush 失败

**症状**: `flushFailureCount` 持续增长

**排查**:
1. 检查日志中 `[yjs-bridge] Failed to flush patch` 错误
2. 常见原因：meta_records 表锁、字段权限变更、记录已删除
3. 解决：通常为临时性错误，会在下次 flush 恢复

### updates 表膨胀

**症状**: `SELECT count(*) FROM meta_record_yjs_updates` 持续增长

**排查**:
1. Compaction 只在 doc release（60s idle / graceful shutdown）时触发
2. 如果用户持续编辑同一记录，updates 会持续增长
3. 手动触发 compaction 见下方

### 手动 compaction

```sql
-- 查看哪些记录有大量 updates
SELECT record_id, count(*) as update_count
FROM meta_record_yjs_updates
GROUP BY record_id
ORDER BY update_count DESC
LIMIT 20;

-- 手动清理（需要服务端配合）
-- 方法 1: 重启服务（destroy 会触发所有活跃 doc 的 compaction）
-- 方法 2: 等待用户关闭记录（60s idle → compaction）
```

## 3. 紧急关闭

```bash
# 1. 关闭 Yjs
export ENABLE_YJS_COLLAB=false
# 2. 重启服务
pm2 restart metasheet  # 或对应的进程管理命令

# REST 功能不受影响
# Yjs 数据保留在 DB 中，下次启用时恢复
```

## 4. 数据清理（谨慎操作）

```sql
-- 清理指定记录的 Yjs 状态（完全重置）
DELETE FROM meta_record_yjs_updates WHERE record_id = 'rec_xxx';
DELETE FROM meta_record_yjs_states WHERE record_id = 'rec_xxx';

-- 清理所有 Yjs 状态（核选项）
TRUNCATE meta_record_yjs_updates;
TRUNCATE meta_record_yjs_states;
```
