# MetaSheet Phase 2 — Yjs 实时协同编辑技术设计

Date: 2026-04-15

## 1. 背景与目标

### 1.1 当前问题

MetaSheet 的记录存储为 `meta_records.data` JSONB blob（整条记录一个 JSON 对象）。并发编辑场景：

```
Alice 编辑 field_a = "hello"  →  发送整条记录 patch { field_a: "hello", field_b: "old" }
Bob   编辑 field_b = "world"  →  发送整条记录 patch { field_a: "old", field_b: "world" }

结果：后写入者覆盖先写入者的修改 → Alice 或 Bob 的修改丢失
```

当前冲突处理仅为 `VersionConflictError`（乐观锁失败 → 客户端重试），无自动合并能力。

### 1.2 Phase 2 目标

1. 两个用户同时编辑同一条记录的**不同字段** → 两边修改自动合并，无丢失
2. 两个用户同时编辑同一个**文本字段** → 字符级合并（类 Google Docs）
3. 短暂断连（< 60 秒）后重连 → 自动同步，无需手动刷新
4. REST API 写入 → Yjs 客户端实时看到变更
5. 100 并发用户编辑同一张表 → P95 延迟 < 500ms

### 1.3 不在范围内

- 完整离线编辑（Progressive Web App 级别）
- 富文本 CRDT（RGA for rich text）
- 公式字段参与 CRDT（公式由服务端计算后广播）
- 跨表联动实时同步

---

## 2. 技术选型：为什么选 Yjs

### 2.1 候选对比

| 维度 | Yjs | Automerge | ShareDB | 自研 OT |
|---|---|---|---|---|
| 性能 | ⭐⭐⭐ 二进制编码，极快 | ⭐⭐ 较慢（Rust WASM） | ⭐⭐ JSON patch | ⭐ 需手写优化 |
| 社区 | 1.5K+ stars，活跃维护 | 1K+ stars | 4K+ stars | N/A |
| 离线支持 | 内置 | 内置 | 需自建 | 需自建 |
| 数据结构 | Y.Map/Y.Array/Y.Text | JSON-like | JSON OT | 需逐一实现 |
| 编码效率 | 二进制（极小） | 二进制（较大） | JSON（大） | 自定义 |
| Awareness | 内置协议 | 需自建 | 需自建 | 需自建 |

### 2.2 选择 Yjs 的理由

1. **字段级 CRDT 天然支持**：Y.Map 直接映射到记录的 field → value 结构
2. **文本字段字符级合并**：Y.Text 已解决 Google Docs 级别的文本冲突
3. **二进制编码**：网络传输比 JSON OT 小 10-50 倍
4. **Awareness 协议**：用户光标、选区、在线状态的标准协议
5. **增量同步**：仅传输 diff，不是全量状态

### 2.3 Yjs 劣势与缓解

| 劣势 | 缓解 |
|---|---|
| Y.Doc 内存占用 | 按 sheet 加载，懒初始化，空闲 10 分钟释放 |
| 无内置权限控制 | 服务端拦截 update，校验字段级权限后转发 |
| 需要适配 Socket.IO | 参考 y-websocket 实现自定义 provider |
| 大表（10K+ 记录）性能 | 分页加载到 Y.Doc，仅同步可见区域 |

---

## 3. 架构设计

### 3.1 整体架构

```
┌─────────────┐    ┌─────────────┐
│  Client A   │    │  Client B   │
│  Vue 3 App  │    │  Vue 3 App  │
│             │    │             │
│ ┌─────────┐ │    │ ┌─────────┐ │
│ │ Y.Doc   │ │    │ │ Y.Doc   │ │
│ │ (local) │ │    │ │ (local) │ │
│ └────┬────┘ │    │ └────┬────┘ │
│      │      │    │      │      │
│ ┌────┴────┐ │    │ ┌────┴────┐ │
│ │Provider │ │    │ │Provider │ │
│ │(WS)     │ │    │ │(WS)     │ │
│ └────┬────┘ │    │ └────┬────┘ │
└──────┼──────┘    └──────┼──────┘
       │    Socket.IO     │
       └────────┬─────────┘
                │
       ┌────────┴────────┐
       │    Server        │
       │                  │
       │ ┌──────────────┐ │    ┌──────────────┐
       │ │YjsSyncService│ │    │ PostgreSQL   │
       │ │  (per sheet)  │─────│              │
       │ └──────┬───────┘ │    │ yjs_states   │
       │        │         │    │ yjs_updates  │
       │ ┌──────┴───────┐ │    │ meta_records │
       │ │CollabService │ │    │ (snapshot)   │
       │ │ (existing)   │ │    └──────────────┘
       │ └──────────────┘ │
       └──────────────────┘
```

### 3.2 服务端组件

**YjsSyncService** — Y.Doc 生命周期管理 + sync 协议处理

```typescript
class YjsSyncService {
  private docs: Map<string, Y.Doc>  // sheetId → Y.Doc
  
  async getOrCreateDoc(sheetId): Promise<Y.Doc>
  handleSyncStep1(sheetId, stateVector): Uint8Array
  async handleUpdate(sheetId, update, origin): Promise<void>
  releaseIdleDoc(sheetId): void
  private syncToMetaRecords(sheetId, doc): Promise<void>
}
```

**YjsPersistenceAdapter** — DB 读写 + compaction

```typescript
class YjsPersistenceAdapter {
  async loadDoc(sheetId): Promise<Uint8Array | null>
  async storeUpdate(sheetId, update): Promise<void>
  async storeSnapshot(sheetId, doc): Promise<void>
  async compact(sheetId): Promise<void>
  async pruneUpdates(sheetId, beforeId): Promise<number>
}
```

**YjsWebSocketAdapter** — Socket.IO 适配 Yjs 协议

- 事件：`yjs:sync-step-1`, `yjs:sync-step-2`, `yjs:update`, `yjs:awareness`
- 与现有 CollabService **扩展而非替代**

**YjsPermissionGuard** — 服务端 update 权限校验

```typescript
async handleUpdate(sheetId, update, userId) {
  // 解析 update 中修改了哪些 record/field
  // 校验 userId 对这些字段是否有写权限
  // 通过 → 应用到主 doc + 广播
  // 拒绝 → 丢弃 update，通知客户端
}
```

### 3.3 客户端组件

**useYjsDocument()** — Vue composable

```typescript
function useYjsDocument(sheetId: Ref<string>) {
  const doc: Ref<Y.Doc | null>
  const connected: Ref<boolean>
  const synced: Ref<boolean>
  
  function connect(): void
  function disconnect(): void
  function getRecord(recordId): Y.Map | undefined
  function setFieldValue(recordId, fieldId, value): void
  function observeField(recordId, fieldId, callback): () => void
}
```

**useYjsAwareness()** — 用户状态 + 远程光标

```typescript
function useYjsAwareness(doc: Ref<Y.Doc>) {
  const peers: Ref<Map<number, AwarenessState>>
  const remoteCursors: ComputedRef<CursorInfo[]>
  
  function setLocalState(state: { userId, displayName, cursor? }): void
}
```

### 3.4 数据模型映射

```
Sheet Y.Doc
├── records (Y.Map<recordId, Y.Map>)
│   ├── "rec_001" (Y.Map)
│   │   ├── "fld_name"    → Y.Text("Alice")        // 文本：字符级合并
│   │   ├── "fld_age"     → 28                      // 数值：LWW
│   │   ├── "fld_status"  → "active"                // 选择：LWW
│   │   ├── "fld_tags"    → Y.Array(["a", "b"])     // 多选：集合合并
│   │   ├── "fld_links"   → Y.Array(["rec_x"])      // 链接：集合合并
│   │   ├── "fld_files"   → Y.Array([{id, name}])   // 附件：集合合并
│   │   └── "_meta" (Y.Map: version, updatedAt, updatedBy)
│   └── "rec_002" (Y.Map) ...
└── _deleted (Y.Map<recordId, timestamp>)            // 软删除墓碑
```

**字段类型 → Yjs 类型**：

| 字段类型 | Yjs 类型 | 合并语义 |
|---|---|---|
| text | Y.Text | 字符级合并 |
| number / boolean / date | primitive in Y.Map | LWW |
| select (single) | primitive in Y.Map | LWW |
| select (multi) | Y.Array | 集合合并（并集） |
| link / attachment | Y.Array | 集合合并 |
| formula / lookup / rollup | **不参与 CRDT** | 服务端计算，结果广播 |

---

## 4. 数据库 Schema 变更

```sql
-- Yjs 文档完整快照
CREATE TABLE meta_record_yjs_states (
  sheet_id TEXT NOT NULL,
  doc_key TEXT NOT NULL DEFAULT 'default',
  state_vector BYTEA,
  doc_state BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet_id, doc_key)
);

-- Yjs 增量 updates
CREATE TABLE meta_record_yjs_updates (
  id BIGSERIAL PRIMARY KEY,
  sheet_id TEXT NOT NULL,
  doc_key TEXT NOT NULL DEFAULT 'default',
  update_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_yjs_updates_doc ON meta_record_yjs_updates(sheet_id, doc_key);
CREATE INDEX idx_yjs_updates_created ON meta_record_yjs_updates(created_at);
```

**Compaction 策略**：updates 数量 > 500 或总大小 > 1MB 时 → 合并为单个 snapshot → 清理旧 updates。定时任务每 5 分钟检查。

---

## 5. 同步协议

### 连接建立

```
Client                          Server
  │── connect(sheetId) ────────→│ getOrCreateDoc + loadFromDB
  │←── yjs:sync-step-1 ────────│ (server state vector)
  │── yjs:sync-step-2 ────────→│ (client missing updates)
  │←── yjs:sync-step-2 ────────│ (server missing updates)
  │         ── synced ──        │
```

### 增量同步（steady state）

```
Client A          Server          Client B
  │ edit field_a    │               │
  │── yjs:update ──→│ apply + store │
  │                 │── yjs:update →│ apply locally
```

### Awareness（用户状态）

```typescript
awareness.setLocalState({
  user: { id: 'user_123', name: 'Alice', color: '#ff0000' },
  cursor: { recordId: 'rec_001', fieldId: 'fld_name', position: 5 },
})
// → 其他客户端收到 → 渲染远程光标
```

---

## 6. Bridge：Yjs ↔ REST API 双向同步

**Yjs → meta_records**：Y.Doc 变更后防抖 1 秒同步到 `meta_records.data`（snapshot），版本号 +1。

**REST → Yjs**：REST API 修改记录后，将 changes 写入对应 Y.Map，origin 标记为 `'rest-api'` 避免循环广播。

---

## 7. 迁移计划（8 周）

| 阶段 | 时间 | 内容 |
|---|---|---|
| **2.1 基础设施** | Week 1-2 | 安装 yjs/y-protocols/lib0，YjsSyncService，YjsPersistenceAdapter，DB 迁移，单元测试 |
| **2.2 后端集成** | Week 3-4 | WebSocket 适配，双向 Bridge，权限校验，集成测试 |
| **2.3 前端集成** | Week 5-6 | useYjsDocument，MetaGridTable 改造，Awareness UI，远程光标 |
| **2.4 加固** | Week 7-8 | 断连重连，100 并发压测，Compaction 定时任务，边界情况，文档 |

---

## 8. 向后兼容

| 场景 | 处理 |
|---|---|
| 现有 REST API | 不变 — meta_records.data 持续更新 |
| API Token 访问 | REST → bridge → Y.Doc |
| 公开表单提交 | REST POST → bridge |
| Webhook / 自动化 | 从 meta_records 变更触发 |
| 版本号 | 继续递增 |
| 旧版前端 | `sheet:op` 保留，Yjs 客户端额外收 `yjs:update` |

---

## 9. 性能考量

| 场景 | Y.Doc 大小 | 内存占用 |
|---|---|---|
| 100 记录 × 10 字段 | ~50 KB | ~100 KB |
| 1,000 记录 × 10 字段 | ~500 KB | ~1 MB |
| 10,000 记录 × 10 字段 | ~5 MB | ~10 MB |

Yjs 二进制 vs JSON：单字段更新 ~30 bytes vs ~300 bytes（**10 倍差距**）。

**大表**：仅加载当前视图可见记录到 Y.Doc，翻页时动态加载/释放。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 大表内存占用 | 分页加载 + 空闲释放 + 内存限额 |
| 离线时间过长 | Phase 2 仅支持 60 秒内重连 |
| 公式依赖 | 不参与 CRDT，服务端计算后广播 |
| 权限绕过 | 每个 update 服务端校验 |
| Bridge 死循环 | origin 标记区分来源 |

---

## 11. 依赖清单

```json
{
  "yjs": "^13.6.18",
  "y-protocols": "^1.0.6",
  "lib0": "^0.2.93"
}
```

不使用 y-websocket（自建 Socket.IO 适配），不使用 y-indexeddb（Phase 2 不做客户端持久化）。

---

## 12. 验收标准

| # | 场景 | 预期 |
|---|---|---|
| 1 | 两浏览器编辑同记录不同字段 | 两边修改都保留 |
| 2 | 两浏览器编辑同文本字段 | 字符级合并 |
| 3 | 离线 30 秒后重连 | 自动同步 |
| 4 | REST API 写入 | Yjs 客户端实时可见 |
| 5 | Yjs 写入 | meta_records < 2 秒更新 |
| 6 | 无权限字段 | 服务端拒绝 update |
| 7 | 100 并发用户 | P95 < 500ms |
| 8 | Compaction | updates 表不无限增长 |

---

## 13. 文件结构

```
packages/core-backend/src/collab/
├── yjs-sync-service.ts
├── yjs-persistence-adapter.ts
├── yjs-websocket-adapter.ts
├── yjs-meta-records-bridge.ts
└── yjs-permission-guard.ts

apps/web/src/multitable/composables/
├── useYjsDocument.ts
├── useYjsAwareness.ts
└── useYjsCellBinding.ts

packages/core-backend/src/db/migrations/
└── zzzz20260501100000_create_yjs_state_tables.ts

packages/core-backend/tests/unit/
├── yjs-sync-service.test.ts
├── yjs-persistence-adapter.test.ts
└── yjs-bridge.test.ts
```
