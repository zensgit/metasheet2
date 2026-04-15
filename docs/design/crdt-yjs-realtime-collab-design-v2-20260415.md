# MetaSheet Phase 2 — Yjs 实时协同编辑设计 v2（决策收口）

Date: 2026-04-15

基于 v1 审阅意见修订。本文档**只收口 4 个核心决策**，不重复 v1 中已确认可沿用的部分（选型 Yjs、字段类型映射、依赖清单、验收标准）。

---

## 决策 1：Doc 粒度 — 每条记录一个 Y.Doc

### 问题回顾

v1 把"一个 sheet 一个 Y.Doc"和"只加载可见记录、翻页释放"混在一起。Yjs 的 Y.Doc 是 CRDT 共享状态容器，不是缓存——从 doc 中删除数据等同于对共享状态的删除操作，不是本地内存回收。

### 决策

**采用 record-per-doc 模型**：每条记录一个独立的 Y.Doc。

```
Sheet 不再是一个 Y.Doc。
每条 record 是一个独立 Y.Doc，doc_key = recordId。

record Y.Doc 结构：
├── "fields" (Y.Map<fieldId, value>)
│   ├── "fld_name" → Y.Text("Alice")
│   ├── "fld_age"  → 28
│   └── ...
└── "_meta" (Y.Map)
    ├── "version" → 5
    └── "updatedBy" → "user_123"
```

### 理由

| 维度 | sheet-per-doc | record-per-doc |
|---|---|---|
| 内存 | 整表常驻，10K 记录 ~10MB | 仅活跃记录，每条 ~1KB |
| 同步范围 | 任何人编辑任何记录，所有人收到 | 只有编辑同一条记录的人收到 |
| 权限 | 需解析整个 doc 的 update | 权限直接在 doc 路由层判断 |
| 翻页 | 需要 subdoc 或分片协议 | 天然支持——不可见记录不订阅 |
| 离线重连 | 整表 resync 开销大 | 单条记录 resync 极小 |
| 持久化 | 一个巨大 state blob | 按记录粒度存储/压缩 |

### 生命周期

```
用户打开 record detail → 客户端 subscribe(recordId)
  → 服务端 getOrCreateDoc(recordId)
  → 从 DB 加载 state（如有）
  → sync protocol 握手
  → 进入 steady-state 增量同步

用户关闭 record detail → 客户端 unsubscribe(recordId)
  → 服务端检查该 doc 是否还有订阅者
  → 无订阅者 → 60 秒后释放内存（已持久化到 DB）
```

### 对持久化的影响

```sql
-- v2: doc_key = recordId（不是 sheetId）
CREATE TABLE meta_record_yjs_states (
  record_id TEXT NOT NULL PRIMARY KEY,
  state_vector BYTEA,
  doc_state BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meta_record_yjs_updates (
  id BIGSERIAL PRIMARY KEY,
  record_id TEXT NOT NULL,
  update_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_yjs_updates_record ON meta_record_yjs_updates(record_id);
```

### 不在范围内

- Sheet 级元数据（字段定义、视图配置）**不**通过 Yjs 同步——继续走现有 REST + EventBus 广播
- 记录的创建和删除**不**通过 Yjs——继续走 REST API → `meta_records` INSERT/DELETE → EventBus 广播
- Yjs 只管**已存在记录的字段值编辑**

---

## 决策 2：权限拦截 — doc 路由层 + shadow doc apply

### 问题回顾

v1 说"解析 update 中修改了哪些 field"但没有给出可落地的实现。Yjs binary update 不能直接按 fieldId 静态解析。

### 决策

**两层权限控制：**

**第一层（doc 路由层，零解析成本）：**

record-per-doc 模型下，每个 WebSocket 订阅请求已经携带 `recordId`。在 subscribe 阶段检查用户对该 record 是否有写权限：

```typescript
// 订阅时
socket.on('yjs:subscribe', async ({ recordId }) => {
  const canEdit = await checkRecordPermission(userId, recordId, 'write')
  if (!canEdit) {
    socket.emit('yjs:error', { recordId, code: 'FORBIDDEN' })
    return
  }
  // 允许订阅 + 发送 sync
  socket.join(`yjs:${recordId}`)
  sendSyncStep1(socket, recordId)
})
```

只读用户可以 subscribe 接收状态（`canRead`），但发来的 update 被丢弃。

**第二层（shadow doc apply，仅在需要字段级权限时启用）：**

如果 sheet 配置了字段级权限（大多数 sheet 不需要），服务端对 incoming update 做 shadow apply：

```typescript
async handleUpdate(recordId: string, update: Uint8Array, userId: string) {
  if (!this.hasFieldLevelPermissions(recordId)) {
    // 快速路径：无字段级权限，直接 apply + broadcast
    Y.applyUpdate(this.docs.get(recordId)!, update)
    this.broadcastUpdate(recordId, update, userId)
    return
  }

  // 慢速路径：shadow doc 检测变更字段
  const shadow = new Y.Doc()
  const before = this.docs.get(recordId)!.getMap('fields').toJSON()
  Y.applyUpdate(shadow, Y.encodeStateAsUpdate(this.docs.get(recordId)!))
  Y.applyUpdate(shadow, update)
  const after = shadow.getMap('fields').toJSON()

  const changedFieldIds = Object.keys(after).filter(fid => 
    JSON.stringify(after[fid]) !== JSON.stringify(before[fid])
  )

  for (const fieldId of changedFieldIds) {
    if (!await checkFieldPermission(userId, recordId, fieldId, 'write')) {
      // 拒绝整个 update（不做部分 apply）
      socket.emit('yjs:rejected', { recordId, reason: `No write access to field ${fieldId}` })
      return
    }
  }

  // 全部通过，apply 到主 doc
  Y.applyUpdate(this.docs.get(recordId)!, update)
  this.broadcastUpdate(recordId, update, userId)
}
```

### 部分字段拒绝的处理

**不做部分 apply**。如果一个 update 中包含无权限字段的修改，整个 update 被拒绝。客户端收到 `yjs:rejected` 后需要 undo 本地变更并 resync。

理由：Yjs update 是不可分割的原子单元。"只 apply 有权限的字段"需要手动构造 counter-update 来撤销特定字段的变更，复杂度极高且容易引入 CRDT 状态不一致。整体拒绝 + 客户端 resync 是更安全的选择。

### 快速路径 vs 慢速路径

| 场景 | 路径 | 成本 |
|---|---|---|
| 无字段级权限（大多数 sheet） | 快速路径：直接 apply + broadcast | ~0.1ms |
| 有字段级权限 | 慢速路径：shadow apply + diff + check | ~5-10ms |

---

## 决策 3：多实例同步 — Redis pub/sub 广播 Yjs updates

### 问题回顾

当前 `CollabService` 是单进程内存态（`WS_REDIS_ENABLED=true` 但实际无 Redis wiring）。如果 Y.Doc 也做进程内 Map，协同状态会锁死在单节点。

### 决策

**Phase 2 分两步走：**

**Step 1（POC + 初始版本）：单进程模式**

- 强制 sticky session（Socket.IO `sticky` adapter 或 Nginx `ip_hash`）
- 同一个 sheet 的所有 WebSocket 连接路由到同一个进程
- Y.Doc 驻留在该进程内存，DB 做持久化备份
- 足够支撑 Phase 2 验收（100 并发用户 = 单机可承载）

**Step 2（Phase 3 或用户量 > 单机承载时）：Redis pub/sub 扇出**

```
Node 1                    Redis                    Node 2
  │                         │                         │
  │ user edit → update      │                         │
  │ apply to local doc      │                         │
  │── PUBLISH yjs:{recordId} update ──→│              │
  │                         │──→ SUBSCRIBE ──→│       │
  │                         │              apply to   │
  │                         │              local doc  │
  │                         │              broadcast  │
  │                         │              to local   │
  │                         │              sockets    │
```

Channel 命名：`yjs:update:{recordId}`

每个节点：
- 持有自己服务的 record docs
- 收到 Redis 消息 → apply 到本地 doc → broadcast 到本地 sockets
- 本地 update → apply 本地 + publish Redis + persist DB

**为什么 Step 1 先做 sticky session 而不是直接 Redis：**

1. record-per-doc 模型下，同一条记录的并发编辑者通常 < 5 人，单机足够
2. Redis pub/sub 增加每次 update 的延迟（~1-3ms），POC 阶段不值得引入
3. Sticky session 的实现成本极低（Nginx `ip_hash` 一行配置）
4. 如果 Phase 2 结束时用户量不需要多实例，Step 2 可以推迟

### 对现有 CollabService 的影响

不修改 `CollabService`。Yjs 同步通过**独立的 Socket.IO namespace** (`/yjs`) 运行，不与现有 `/` namespace 的 `sheet:op` / `comment:*` 事件混合。两套系统可以在同一个 Socket.IO server 上并存。

---

## 决策 4：Bridge authoritative path — meta_records 仍是权威写入层

### 问题回顾

v1 的"1 秒防抖 bridge"会打破现有 webhook / automation / version 的同步时序语义。当前代码（`univer-meta.ts:7066`）是写 DB 后立即 `eventBus.emit`，不存在异步窗口。

### 决策

**meta_records 保持为 authoritative write path。Yjs 不直接写 DB。**

```
Yjs 编辑流程：

Client Y.Doc edit
  ↓
Server Y.Doc apply（纯内存 CRDT 状态）
  ↓
Server 从 Y.Doc 提取变更的 fieldIds + values
  ↓
Server 调用现有的 patchRecord()（写 meta_records + version++）
  ↓
patchRecord() 内部 eventBus.emit('multitable.record.updated', ...)
  ↓
Webhook / Automation / CollabService 按现有语义触发
```

**关键点：**

| 问题 | 解答 |
|---|---|
| 何时算 authoritative write | Y.Doc apply 后**立即**调用 `patchRecord()`，不防抖 |
| version 在哪层递增 | `patchRecord()` 内部（`version = version + 1`），与现有一致 |
| eventBus 由谁发 | `patchRecord()` 内部（`eventBus.emit`），与现有一致 |
| formula/lookup 回写 | `patchRecord()` 触发重算 → 结果写入 meta_records → `sheet:op` 广播 → 不回写 Y.Doc |
| REST 写入如何同步到 Yjs | REST `patchRecord()` 成功后 → 读取新 data → `doc.transact()` 写入 Y.Doc → broadcast（origin='rest'） |

### 为什么不防抖

1. **Webhook / Automation 语义不变**：每次字段变更都触发事件，无延迟窗口
2. **Version 语义不变**：每次 `patchRecord()` 原子递增
3. **REST 一致性**：任何时刻 `GET /records/:id` 都返回最新值

### 写入频率问题

Yjs 的 update 可能非常频繁（每个按键一次），如果每次都写 `meta_records`，DB 压力大。

**缓解：合并同一用户连续编辑同一记录的 updates**

```typescript
// 服务端维护 per-record pending writes
const pendingWrites = new Map<string, { fields: Record<string, unknown>, timer: NodeJS.Timeout }>()

function onYjsUpdate(recordId, changedFields, userId) {
  const pending = pendingWrites.get(recordId)
  if (pending) {
    // 合并字段
    Object.assign(pending.fields, changedFields)
    clearTimeout(pending.timer)
  }
  
  const entry = pending ?? { fields: { ...changedFields }, timer: null! }
  
  // 最多延迟 200ms 合并（不是 1 秒）
  entry.timer = setTimeout(async () => {
    pendingWrites.delete(recordId)
    await patchRecord({ recordId, changes: entry.fields })
    // patchRecord 内部 eventBus.emit → webhook/automation 触发
  }, 200)
  
  // 但如果距离上次写入已超过 500ms，立即写入（保证最大延迟 500ms）
  if (!pending) {
    pendingWrites.set(recordId, entry)
  }
}
```

**200ms 合并窗口**比 1 秒防抖合理得多：
- 足够合并快速连续按键（平均打字间隔 ~100ms）
- 不会让 webhook 感知到明显延迟
- 最大延迟 500ms（保底 flush），远好于 v1 的 1 秒

### Yjs updates 的持久化（独立于 meta_records）

Yjs binary updates 仍然写入 `meta_record_yjs_updates` 表，但这只是为了 **doc 重建和断连恢复**，不是 authoritative state。

```
Authoritative state: meta_records.data (JSON, version, eventBus)
CRDT state: meta_record_yjs_states/updates (binary, 用于 doc 重建)
```

两者通过 bridge 保持一致。如果出现不一致，以 `meta_records.data` 为准。

### 避免循环的机制

```
Yjs update → patchRecord() → eventBus → CollabService sheet:op 广播
                                          ↑ 不触发反向 Yjs 写入
                                          （非 Yjs 客户端通过 sheet:op 感知变化）

REST patchRecord() → eventBus → CollabService sheet:op + Yjs doc.transact(origin='rest')
                                                          ↑ origin='rest' 的 Y.Doc update
                                                            不触发 patchRecord()
```

循环断开点：
- Yjs → patchRecord：通过 `pendingWrites` 合并，不重入
- REST → Y.Doc：`origin='rest'`，服务端 `doc.on('update')` handler 检查 origin，跳过 `'rest'`

---

## Awareness 迁移策略（补充）

**Phase 2 不替换现有 presence，并行运行**：

| 功能 | 现有系统 | Yjs Awareness |
|---|---|---|
| "谁在看这张表" | `sheet:presence` 事件 | 保留不动 |
| "谁在编辑哪条记录" | 无 | 新增：Awareness on record doc |
| 评论 presence | `comment:*` 事件 | 保留不动 |
| 远程光标/选区 | 无 | 新增：Awareness cursor state |

Awareness 只在 record-level Y.Doc 上运行。用户打开 record detail 时加入 awareness，关闭时退出。不影响 sheet-level presence。

---

## POC 范围定义

### 目标

验证 record-per-doc 模型 + authoritative patchRecord bridge 在真实代码中可行。

### 范围

| 做 | 不做 |
|---|---|
| 单条记录的 text 字段 Yjs 同步 | 非 text 字段 |
| 两浏览器同时编辑同一 text 字段 → 字符级合并 | REST → Yjs 反向 bridge |
| 断连 30 秒后重连 → 自动恢复 | Webhook / Automation 触发 |
| DB 持久化（yjs_states + yjs_updates） | Compaction 定时任务 |
| record 级 Y.Doc 生命周期管理 | 字段级权限 shadow apply |
| Socket.IO `/yjs` namespace | Redis pub/sub 多实例 |

### POC 文件

```
packages/core-backend/src/collab/
├── yjs-sync-service.ts          — record-per-doc lifecycle
├── yjs-persistence-adapter.ts   — DB load/store
└── yjs-websocket-adapter.ts     — Socket.IO /yjs namespace

apps/web/src/multitable/composables/
├── useYjsDocument.ts            — connect/disconnect/observe
└── useYjsCellBinding.ts         — Y.Text ↔ input binding

packages/core-backend/src/db/migrations/
└── zzzz20260501100000_create_yjs_state_tables.ts

packages/core-backend/tests/unit/
├── yjs-sync-service.test.ts
└── yjs-persistence-adapter.test.ts
```

### POC 验收标准

| # | 场景 | 预期 |
|---|---|---|
| 1 | 两浏览器打开同一 record，同时编辑 text 字段 | 字符级合并，无丢失 |
| 2 | 一方断网 30 秒后重连 | 自动恢复，双方一致 |
| 3 | 服务端重启 | 从 DB 加载 doc state，客户端 resync 成功 |
| 4 | 无人编辑 60 秒后 | 服务端释放 doc 内存 |
| 5 | 单元测试 | sync protocol + persistence + lifecycle 全部通过 |

---

## 决策汇总表

| 决策 | 选择 | 理由 |
|---|---|---|
| Doc 粒度 | **record-per-doc** | 内存可控、权限天然隔离、翻页无需分片 |
| 权限拦截 | **doc 路由层 + shadow apply（仅字段权限时）** | 快速路径零成本，慢速路径精确拦截 |
| 多实例同步 | **Phase 2 sticky session → Phase 3 Redis pub/sub** | 单机足够 POC，延迟最小 |
| Bridge authoritative path | **meta_records 仍是权威层，Yjs → patchRecord() 立即写** | 不改变 webhook/automation/version 语义，200ms 合并窗口控制写入频率 |

---

## 非目标清单

Phase 2 **明确不做**：

1. Sheet 级元数据（字段定义、视图配置）通过 Yjs 同步
2. 记录创建/删除通过 Yjs
3. 公式/lookup/rollup 字段参与 CRDT
4. 完整离线编辑（仅支持 60 秒内断连恢复）
5. Redis pub/sub 多实例（推迟到 Phase 3）
6. 替换现有 `sheet:presence` / `comment:*` 事件系统
7. Rich text CRDT（Phase 2 仅 plain text）
