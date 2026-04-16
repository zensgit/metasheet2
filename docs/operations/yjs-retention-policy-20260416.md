# Yjs 数据保留策略

Date: 2026-04-16

## 表结构

| 表 | 用途 | 增长模式 |
|---|---|---|
| `meta_record_yjs_states` | 完整 doc 快照 | 每记录一行，upsert |
| `meta_record_yjs_updates` | 增量 updates | 每次编辑追加，compaction 后清零 |

## 当前 Compaction 策略

触发时机：
- Doc idle release（60s 无访问）
- Graceful shutdown（destroy）
- Cleanup timer（30s 周期检查 idle docs）

Compaction 操作（事务内）：
1. UPSERT snapshot 到 `meta_record_yjs_states`
2. DELETE 该 record 的所有 `meta_record_yjs_updates`

## 保留策略建议

### Phase 1（当前 - 内测）

| 策略 | 设置 |
|---|---|
| updates 保留 | 无上限（compaction 负责清理） |
| states 保留 | 无上限（按 record 粒度，自然与 meta_records 对齐） |
| 定时 compaction | 无（依赖 idle release） |

### Phase 2（小范围 rollout 后）

| 策略 | 设置 |
|---|---|
| 定时 compaction job | 每 10 分钟扫描 updates 数 > 500 的 record |
| updates 保留 | compaction 后清零 |
| states 保留 | 永久（= record 生命周期） |
| 孤儿清理 | 每天检查 `meta_record_yjs_states.record_id NOT IN (SELECT id FROM meta_records)` |

### Phase 3（生产 GA）

| 策略 | 设置 |
|---|---|
| 定时 compaction | 每 5 分钟 |
| updates 硬上限 | 单 record > 1000 条 → 强制 compaction |
| states TTL | 无（与 record 共存亡） |
| 监控告警 | updates 总行数 > 100K 告警 |

## 孤儿数据

当 `meta_records` 中的记录被删除时，对应的 Yjs 状态成为孤儿。

清理 SQL：
```sql
-- 查找孤儿
SELECT s.record_id
FROM meta_record_yjs_states s
LEFT JOIN meta_records r ON r.id = s.record_id
WHERE r.id IS NULL;

-- 清理孤儿
DELETE FROM meta_record_yjs_updates u
WHERE u.record_id NOT IN (SELECT id FROM meta_records);

DELETE FROM meta_record_yjs_states s
WHERE s.record_id NOT IN (SELECT id FROM meta_records);
```

## 容量估算

| 场景 | updates/天 | states 大小 | 说明 |
|---|---|---|---|
| 10 用户 × 10 记录 | ~5K 行 | ~100 KB | 内测 |
| 50 用户 × 100 记录 | ~50K 行 | ~1 MB | 小范围 rollout |
| 500 用户 × 1000 记录 | ~500K 行 | ~10 MB | 需要定时 compaction |
