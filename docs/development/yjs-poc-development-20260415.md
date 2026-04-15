# Yjs POC 开发文档

Date: 2026-04-15

## 范围

| 做 | 不做 |
|---|---|
| 单条 record | sheet 级状态 |
| 单个 text 字段（Y.Text） | 非 text 字段 |
| 双浏览器字符级合并 | 多字段同步 |
| 断连恢复（60s idle release） | 完整离线 |
| DB 持久化（snapshot + incremental） | compaction 定时任务 |
| 走 RecordWriteService.patchRecords() | 直接写 meta_records |
| record-per-doc 模型 | sheet-per-doc |
| Socket.IO /yjs namespace | 替换现有 / namespace |

**不做：** create/delete, webhook/automation, 字段级权限, Redis/多实例

## 文件清单

### Backend infra

| 文件 | 说明 |
|---|---|
| `packages/core-backend/src/collab/yjs-sync-service.ts` | Y.Doc 生命周期（内存缓存 + 60s idle 清理 + 持久化加载） |
| `packages/core-backend/src/collab/yjs-persistence-adapter.ts` | Kysely：loadDoc（snapshot + incremental）、storeUpdate、storeSnapshot |
| `packages/core-backend/src/collab/yjs-websocket-adapter.ts` | Socket.IO `/yjs` namespace：subscribe/message/update/unsubscribe |
| `packages/core-backend/src/db/migrations/zzzz20260501100000_create_yjs_state_tables.ts` | `meta_record_yjs_states` + `meta_record_yjs_updates` 表 |
| `packages/core-backend/src/services/CollabService.ts` | 新增 `getIO()` getter |
| `packages/core-backend/src/index.ts` | Yjs 初始化接入 |

### Backend bridge

| 文件 | 说明 |
|---|---|
| `packages/core-backend/src/collab/yjs-record-bridge.ts` | Y.Text 变更 → 单字段 patch → RecordWriteService.patchRecords() |

Bridge 设计要点：
- 观察 Y.Map("fields") 的 deepObserve，检测 Y.Text 变更
- 200ms 合并窗口（快速连续按键合并为单次 patch），500ms 最大延迟
- `origin='rest'` 和 `origin='persistence'` 的变更被跳过（防止循环）
- 通过 `getWriteInput` 回调获取 RecordPatchInput（sheetId, fieldById 等上下文）
- 错误只 log，不中断 Yjs 同步

### Frontend POC

| 文件 | 说明 |
|---|---|
| `apps/web/src/multitable/composables/useYjsDocument.ts` | Y.Doc 生命周期 + Socket.IO /yjs 连接管理 |
| `apps/web/src/multitable/composables/useYjsTextField.ts` | Y.Text ↔ Vue ref 双向绑定（setText/insertAt/deleteRange） |

### Tests

| 文件 | 测试数 |
|---|---|
| `packages/core-backend/tests/unit/yjs-poc.test.ts` | 19 |

测试覆盖：
- YjsSyncService (7)：getOrCreateDoc、缓存、releaseDoc、idle 清理、update 持久化
- YjsPersistenceAdapter (4)：loadDoc 空态、snapshot 加载、storeUpdate、storeSnapshot
- Yjs sync protocol (5)：双 doc 同步、binary 交换、并发编辑合并、断连恢复
- YjsRecordBridge (3)：flush patch via patchRecords、合并快速编辑、origin='rest' 跳过

## 架构决策映射

| 设计 v2 决策 | POC 实现 |
|---|---|
| record-per-doc | ✅ YjsSyncService.docs Map<recordId, Y.Doc> |
| 权限在 doc 路由层 | ⏸️ POC 不做权限 |
| sticky session | ✅ 单进程（POC 不需要多实例） |
| meta_records 为权威层 | ✅ bridge → RecordWriteService.patchRecords() |
| 200ms 合并窗口 | ✅ YjsRecordBridge.mergeWindowMs |
