# Feature to Code Mapping Index

快速定位功能对应的代码实现、设计文档和当前状态。

**最后更新**: 2025-11-16

---

## 已完成功能 (Phase 1-9)

### Snapshot/Versioning (Phase 9) 🚀

| 组件 | 路径 | 说明 |
|------|------|------|
| **数据库表** | `migrations/20250116_*_snapshot*.sql` | snapshots, snapshot_items, snapshot_restore_log |
| **核心服务** | `src/services/SnapshotService.ts` | createSnapshot, restoreSnapshot, diffSnapshots, cleanupExpired |
| **API 路由** | `src/routes/snapshots.ts` | REST endpoints for CRUD + diff + cleanup + stats |
| **类型定义** | `src/types/snapshot.ts` | SnapshotInput, RestoreInput, SnapshotDiff |
| **指标** | `src/metrics/metrics.ts:129-152` | snapshotCreateTotal, snapshotRestoreTotal, snapshotCleanupTotal |
| **文档** | `claudedocs/PHASE9_SNAPSHOT_DESIGN.md` | 原始设计文档 |

**状态**: ✅ **Verified** - 已实现，已测试，生产就绪

---

### Plugin Reload (Phase 8) 🚀

| 组件 | 路径 | 说明 |
|------|------|------|
| **核心实现** | `src/plugin/PluginLoader.ts:reloadPlugin()` | 热重载核心逻辑 |
| **HTTP 端点** | `src/routes/admin/plugins.ts` | POST /api/admin/plugins/:name/reload |
| **指标** | `src/metrics/metrics.ts:115-126` | pluginReloadTotal, pluginReloadDuration |
| **测试** | `test/plugin-reload.test.ts` | 单元测试和集成测试 |
| **文档** | `claudedocs/PHASE8_PLUGIN_RELOAD.md` | 设计文档 |

**状态**: ✅ **Verified** - 已实现，已测试，生产就绪

---

### Event Bus (Phase 6) 🚀

| 组件 | 路径 | 说明 |
|------|------|------|
| **核心实现** | `src/integration/EventBus.ts` | emit, subscribe, unsubscribe |
| **模式匹配** | `src/integration/PatternMatcher.ts` | 字符串和正则匹配 |
| **指标** | `src/metrics/metrics.ts:78-82` | eventsEmittedTotal |
| **订阅管理** | `EventBus.subscribe()` | 注册事件监听器 |

**状态**: ✅ **Verified** - 已实现，统一计数完成

---

### Message Bus (Phase 2, 5) 🚀

| 组件 | 路径 | 说明 |
|------|------|------|
| **核心实现** | `src/integration/MessageBus.ts` | publish, subscribe, rpc |
| **RPC 支持** | `MessageBus.rpc()`, `registerRpcHandler()` | 请求-响应模式 |
| **优先级** | `PriorityQueue` | 消息优先级排序 |
| **重试** | 内置重试逻辑 | 失败自动重试 |
| **指标** | `src/metrics/metrics.ts:84-112` | messagesProcessedTotal, messagesRetriedTotal, rpcTimeoutsTotal |
| **配置** | `src/config/messaging.ts` | 超时、重试配置 |

**状态**: ✅ **Verified** - 生产就绪

---

### RBAC & Permissions (Phase 7) 🚀

| 组件 | 路径 | 说明 |
|------|------|------|
| **权限检查** | `src/rbac/rbac.ts` | checkPermission, rbacGuard |
| **权限指标** | `src/rbac/PermissionMetrics.ts` | PermissionMetrics class |
| **守卫中间件** | `rbacGuard()` | Express 中间件 |
| **指标** | `src/metrics/metrics.ts:102-106` | permissionDeniedTotal, rbacDenials |
| **缓存** | `rbacPermCacheHits/Miss` | 权限缓存统计 |

**状态**: ✅ **Verified** - 生产就绪

---

### Observability (Phase 4) 🚀

| 组件 | 路径 | 说明 |
|------|------|------|
| **指标注册** | `src/metrics/metrics.ts` | Prometheus Counter, Histogram, Gauge |
| **中间件** | `requestMetricsMiddleware()` | HTTP 请求指标收集 |
| **端点** | `/metrics` (JSON), `/metrics/prom` | 指标暴露 |
| **配置文档** | `claudedocs/PHASE5_OBSERVATION_CONFIG.md` | 观察配置指南 |

**状态**: ✅ **Verified** - 生产就绪

---

## 规划中功能 (Sprint 1-4)

### Sprint 1: 团队效率 + 安全护栏 📐

| 功能 | 设计文档 | 计划代码路径 | 状态 |
|------|----------|--------------|------|
| **dev-bootstrap.sh** | `PHASE10_11_DESIGN_NOTES.md` | `scripts/dev-bootstrap.sh` | 📐 Design Only |
| **本地观测环境** | `PHASE10_11_DESIGN_NOTES.md` | `docker/observability/` | 📐 Design Only |
| **SafetyGuard** | `PHASE10_11_DESIGN_NOTES.md` | `src/guards/SafetyGuard.ts` | 📐 Design Only |

**验证方案**: `PHASE10_11_DESIGN_NOTES.md` - Sprint 1 验证方案章节

---

### Sprint 2: Snapshot 标签与保护 📐

| 功能 | 设计文档 | 计划代码路径 | 状态 |
|------|----------|--------------|------|
| **Snapshot 标签** | `CHANGE_MANAGEMENT_*.md` | `migrations/add_snapshot_tags.sql` | 📐 Design Only |
| **保护规则** | `CHANGE_MANAGEMENT_*.md` | `src/services/ProtectionRuleService.ts` | 📐 Design Only |
| **插件健康监控** | `PHASE10_11_DESIGN_NOTES.md` | `src/services/PluginHealthService.ts` | 📐 Design Only |
| **SLO Manager** | `PHASE10_11_DESIGN_NOTES.md` | `src/slo/SLOManager.ts` | 📐 Design Only |

**Feature Flags**: `enableSnapshotLabels`, `enableProtectionRules`, `enablePluginHealthMonitoring`, `enableSLOManager`

---

### Sprint 3: 变更管理体系 📐

| 功能 | 设计文档 | 计划代码路径 | 状态 |
|------|----------|--------------|------|
| **ChangeManagementService** | `CHANGE_MANAGEMENT_*.md` | `src/services/ChangeManagementService.ts` | 📐 Design Only |
| **变更请求表** | `CHANGE_MANAGEMENT_*.md` | `migrations/change_requests.sql` | 📐 Design Only |
| **Schema 快照** | `CHANGE_MANAGEMENT_*.md` | `src/services/SchemaSnapshotService.ts` | 📐 Design Only |
| **API 端点** | `CHANGE_MANAGEMENT_*.md` | `src/routes/change-management.ts` | 📐 Design Only |

**Feature Flags**: `enableChangeManagement`, `enableSchemaSnapshots`, `enableAutoChangeNotes`

---

### Sprint 4: Phase 10/11 核心 📐

| 功能 | 设计文档 | 计划代码路径 | 状态 |
|------|----------|--------------|------|
| **延迟投递** | `PHASE10_ADVANCED_MESSAGING_PLAN.md` | `src/messaging/DelayScheduler.ts` | 📐 Design Only |
| **DLQ** | `PHASE10_ADVANCED_MESSAGING_PLAN.md` | `src/messaging/DeadLetterQueue.ts` | 📐 Design Only |
| **退避策略** | `PHASE10_ADVANCED_MESSAGING_PLAN.md` | `src/messaging/BackoffCalculator.ts` | 📐 Design Only |
| **PatternTrie** | `PHASE11_PERFORMANCE_SCALE_PLAN.md` | `src/integration/PatternTrie.ts` | 📐 Design Only |

**试点验证**: `PHASE10_11_DESIGN_NOTES.md` - Pilot Use Cases 章节

---

## 状态图例

| 符号 | 状态 | 说明 |
|------|------|------|
| 📐 | **Design Only** | 仅有设计文档，未开始实现 |
| 🔨 | **In Progress** | 正在实现中 |
| ✅ | **Implemented** | 已实现，待验证 |
| 🚀 | **Verified** | 已验证，生产就绪 |

---

## 设计文档完整索引

| 文档 | 路径 | 内容 |
|------|------|------|
| Phase 5 观察配置 | `claudedocs/PHASE5_OBSERVATION_CONFIG.md` | 生产环境监控配置 |
| Phase 10 设计 | `claudedocs/PHASE10_ADVANCED_MESSAGING_PLAN.md` | 高级消息处理 |
| Phase 11 规划 | `claudedocs/PHASE11_PERFORMANCE_SCALE_PLAN.md` | 性能优化 |
| Phase 10/11 综合 | `claudedocs/PHASE10_11_DESIGN_NOTES.md` | Sprint 规划、验证方案、试点 |
| 变更管理设计 | `claudedocs/CHANGE_MANAGEMENT_SNAPSHOT_DESIGN.md` | 完整变更管理体系 |
| ROADMAP | `ROADMAP_V2.md` | 项目路线图、里程碑、风险清单 |

---

## 快速查找指南

**"我想找某个 API 端点"**
→ 查看 `src/routes/` 目录，按功能模块分文件

**"我想了解某个指标"**
→ 查看 `src/metrics/metrics.ts`，所有指标集中定义

**"我想修改某个服务"**
→ 查看 `src/services/` 目录，核心业务逻辑

**"我想了解数据库表结构"**
→ 查看 `migrations/` 目录，按时间顺序排列

**"我想了解某个功能的设计思路"**
→ 查看 `claudedocs/` 目录，详细设计文档

**"我想知道项目整体规划"**
→ 查看 `ROADMAP_V2.md`，包含里程碑和风险管理

---

## 维护指南

**更新时机**:
1. 新功能实现后，更新状态从 📐 到 🔨/✅
2. 功能验证后，更新状态到 🚀
3. 新增设计文档时，添加到索引
4. 代码路径变更时，同步更新映射

**检查清单**:
- [ ] 每个 Sprint 结束时更新功能状态
- [ ] 每次 PR 合并后检查映射准确性
- [ ] 每月一次完整性审查

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
