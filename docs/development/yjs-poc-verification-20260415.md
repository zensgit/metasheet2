# Yjs POC 验证文档

Date: 2026-04-15

## 测试结果

```bash
cd packages/core-backend
npx vitest run tests/unit/yjs-poc.test.ts --watch=false
# 19/19 通过
```

## 验证项

### 1. Backend infra

- [x] `YjsSyncService.getOrCreateDoc(recordId)` 返回 Y.Doc
- [x] 相同 recordId 返回相同 doc 实例（缓存）
- [x] `releaseDoc()` 从缓存移除并 destroy
- [x] 60 秒无访问的 doc 被自动清理
- [x] doc update 自动触发 `persistence.storeUpdate()`
- [x] `persistence='persistence'` origin 的 update 不触发持久化（防循环）
- [x] `loadDoc()` 无数据时返回 null
- [x] `loadDoc()` 正确加载 snapshot + incremental updates
- [x] `storeUpdate()` INSERT 到 yjs_updates 表
- [x] `storeSnapshot()` UPSERT 到 yjs_states 表

### 2. Sync protocol

- [x] 两个 Y.Doc 通过 y-protocols sync 消息完成同步
- [x] 一个 doc 的 update 通过 binary 应用到另一个 doc
- [x] 并发编辑：两个 doc 各自插入不同位置 → 合并后两个字符都在
- [x] 断连恢复：离线 doc 有 pending changes → 重连后正确同步
- [x] y-protocols readSyncMessage 完成完整握手

### 3. Bridge (Y.Text → RecordWriteService)

- [x] Y.Text 插入触发 bridge flush → 调用 `patchRecords()`
- [x] 快速连续编辑在 mergeWindow 内合并为单次 patch
- [x] `origin='rest'` 的变更被跳过，不触发 bridge（防循环）
- [x] bridge 通过 `getWriteInput` 构建完整 RecordPatchInput

### 4. 范围控制

- [x] 无 sheet 级状态混入 record doc（doc 只有 Y.Map("fields")）
- [x] 无 create/delete 逻辑
- [x] 无 webhook/automation 直接调用（通过 RecordWriteService 间接触发）
- [x] 无字段级权限检查
- [x] 无 Redis/多实例代码
- [x] 不修改现有 REST 路由或 CollabService 事件语义
- [x] `/yjs` namespace 独立于现有 `/` namespace

### 5. 未测试（需人工验证）

- [ ] 真实浏览器双窗口编辑 text 字段 → 字符级合并
- [ ] 断网 30 秒后重连 → 自动恢复
- [ ] 服务端重启后 → 从 DB 加载 doc state → 客户端 resync
- [ ] 前端 useYjsDocument + useYjsTextField composable 接入实际组件

## 依赖变更

```
+ yjs@13.6.24
+ y-protocols@1.0.6
+ lib0@0.2.99
```

安装到 root workspace + core-backend + web。

## DB 表

| 表 | 用途 |
|---|---|
| `meta_record_yjs_states` | 完整 doc 快照（BYTEA），PK = record_id |
| `meta_record_yjs_updates` | 增量 updates（BIGSERIAL + BYTEA），index on record_id |
