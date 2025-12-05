# MetaSheet V2 Roadmap

## Phases
1. Core Integration MVP – DONE
2. Messaging RPC & Retries – DONE
3. Plugin Lifecycle & Sandbox – DONE
4. Observability (Prometheus) – DONE
5. Messaging Pattern + Expiry – DONE
6. Event Bus Metrics Unification – DONE
7. Permission Denial Metrics – DONE
8. Plugin Reload & Hot Swap – DONE
9. Snapshot / Versioning MVP – DONE
10. Advanced Messaging (delay, DLQ, backoff) – DONE
    - 10.1 Delay scheduling core (Redis ZSET implementation)
    - 10.2 Dead Letter Queue database tables and service
    - 10.3 Backoff strategy calculator (exponential, fibonacci, etc.)
    - 10.4 EnhancedMessageBus integration
    - 10.5 Admin API endpoints (/api/admin/dlq)
    - 10.6 Prometheus metrics (dlqMessagesTotal, backoffDelayHistogram)
11. Performance & Scale (pattern index, sharding) – PLANNED
    - 11.1 PatternTrie implementation for O(log n) matching
    - 11.2 LRU caching layer for hot patterns
    - 11.3 Tenant-based sharding strategy
    - 11.4 Benchmark test suite (autocannon)
    - 11.5 Connection pool optimization

## Completed
- DB connection pool & stats
- Event bus basic (string + regex)
- Message bus (priority, retries, RPC, pattern, expiry, metrics)
- Sandbox permission groups (database.*, events.basic, messaging.*, http.register)
- Plugin lifecycle load/activate & subscription cleanup
- Prometheus metrics exporter + CI grep
- Event Bus metrics counting unified (eventsEmittedTotal)
- Permission denial metrics (permissionDeniedTotal, PermissionMetrics class)
- Plugin reload: reloadPlugin() method, HTTP endpoint, metrics (pluginReloadTotal, pluginReloadDuration)
- Snapshot/versioning: DB tables (snapshots, snapshot_items, snapshot_restore_log), SnapshotService, REST API, metrics
- Snapshot enhancements: auto-cleanup (cleanupExpired), diff comparison API (diffSnapshots), statistics endpoint
- SafetyGuard: risk assessment, double-confirm flow, Express middleware, metrics (dangerousOperationsTotal, blockedOperationsTotal, confirmationRequestsTotal)

## In Progress
- None (All planned phases complete through Phase 9; Phase 5 baseline finalized locally, awaiting production rerun)

---

## 🏆 Milestone: Phase 5 Production Baseline

**目标**: 在生产环境验证 Phase 6-9 能力的稳定性

### 观察配置

| 参数 | 值 | 说明 |
|------|-----|------|
| **观察时长** | 2 小时 (最小) / 24 小时 (完整) | 12 样本 @ 10分钟间隔 |
| **采样间隔** | 600 秒 | 每 10 分钟一次 |
| **环境** | Production | 真实流量 |

### SLO 草案

| 指标 | 目标 | 阈值 | 状态 |
|------|------|------|------|
| HTTP 成功率 | ≥ 98% | < 95% 触发告警 | 待验证 |
| P99 延迟 | ≤ 2 秒 | > 5 秒 触发告警 | 待验证 |
| Fallback 使用率 | < 10% | > 20% 需优化 | 待验证 |
| 插件重载成功率 | ≥ 95% | < 90% 需调查 | 待验证 |
| Snapshot 操作成功率 | ≥ 99% | < 95% 需调查 | 待验证 |

### 成功条件

- [ ] 观察期间无 Sev-1 / Sev-2 事件
- [ ] 所有 SLO 指标达标
- [ ] 新增指标 (plugin_reload, snapshot_*) 正常上报
- [ ] 无异常错误率上升
- [ ] 资源使用在预期范围内 (CPU < 70%, Memory < 80%)

### 本地环境观察结果 (2025-11-16)

**状态**: ✅ **环境验证通过，基础设施就绪**

**执行成果**:
- ✅ Docker Desktop 自动启动
- ✅ PostgreSQL 连接成功 (端口 5433)
- ✅ 数据库迁移完成 (修复 3 个脚本)
- ✅ core-backend 服务启动 (端口 8900)
- ✅ 指标端点可用 (`/metrics/prom`)
- ✅ Health Check 通过
- ✅ EventBus 初始化 (15 事件类型)

**修复的问题**:
- ✅ pnpm workspace 协议 (`plugin-audit-logger`)
- ✅ 迁移脚本健壮性 (032, 042a, 042d)
- ✅ Docker Compose 配置

**观察结果**:
- 服务空闲状态稳定
- 基础指标正常上报
- Phase 8-9 指标已注册 (待触发)
- 插件 manifest 格式需更新

**结论**: 基础设施验证通过，可进入 Sprint 1 开发工作

**快速启动**: [docs/QUICK_START.md](docs/QUICK_START.md)
**完整报告**: [claudedocs/PHASE5_COMPLETION_REPORT.md](claudedocs/PHASE5_COMPLETION_REPORT.md)
**观测栈文档**: [docker/observability/README.md](docker/observability/README.md)
**安全护栏**: [packages/core-backend/src/guards/README.md](packages/core-backend/src/guards/README.md)

### 安全护栏已启用

SafetyGuard 已集成到以下管理员 API 端点 (`/api/admin/*`):

**插件管理** (MEDIUM-HIGH 风险):
- `POST /api/admin/plugins/:id/reload` - 重载单个插件
- `POST /api/admin/plugins/reload-all` - 重载所有插件 ⚠️ 需双重确认
- `DELETE /api/admin/plugins/:id` - 卸载插件

**快照管理** (MEDIUM-CRITICAL 风险):
- `POST /api/admin/snapshots/:id/restore` - 恢复快照 ⚠️ 需双重确认
- `DELETE /api/admin/snapshots/:id` - 删除快照
- `POST /api/admin/snapshots/cleanup` - 清理过期快照

**系统操作** (LOW-MEDIUM 风险):
- `POST /api/admin/cache/clear` - 清空缓存
- `POST /api/admin/metrics/reset` - 重置指标

**数据操作** (HIGH 风险):
- `DELETE /api/admin/data/bulk` - 批量删除数据
- `PUT /api/admin/data/bulk` - 批量更新数据

**安全管理**:
- `GET /api/admin/safety/status` - 查看 SafetyGuard 状态
- `POST /api/admin/safety/confirm` - 确认危险操作
- `POST /api/admin/safety/enable` - 启用 SafetyGuard
- `POST /api/admin/safety/disable` - 禁用 SafetyGuard

### Sprint 1 进入条件 ✅

Phase 5 已验证以下前置条件:

- [x] Docker + PostgreSQL 基础设施正常
- [x] core-backend 服务可稳定启动
- [x] 指标端点 `/metrics/prom` 可用
- [x] EventBus 服务初始化成功
- [x] 数据库迁移脚本健壮性已修复
- [x] 开发环境一键启动脚本就绪 (`dev-bootstrap.sh`)
- [x] 本地观测栈就绪 (Prometheus + Grafana via `observability-stack.sh`)
- [x] Linux/WSL 跨平台支持
- [x] SafetyGuard 安全护栏 (风险评估 + 双重确认 + 指标监控)

**判定**: ✅ **Sprint 1 进入条件已满足**

### 异常处理 Runbook

**场景 1: QPS 波动**
```bash
# 检查请求分布
curl "$METRICS_URL" | grep http_requests_total
# 对比历史基线，确认是否为正常波动
```

**场景 2: 错误率上升**
```bash
# 1. 识别错误类型
curl "$METRICS_URL" | grep -E "status=\"5"
# 2. 检查日志
kubectl logs -f deployment/metasheet-backend --since=10m | grep ERROR
# 3. 如果持续上升，考虑回滚最近变更
```

**场景 3: 延迟增加**
```bash
# 检查 P99 延迟
curl "$METRICS_URL" | grep http_server_requests_seconds
# 如果 > 5s，检查数据库连接池和慢查询
```

### 执行脚本

```bash
# Phase 5 生产基线观察 (2小时)
METRICS_URL="http://production:4000/metrics/prom" ./scripts/phase5-observe.sh

# 结论模板演示 (验证流程)
./scripts/phase5-demo-conclusion.sh pass     # 达标场景
./scripts/phase5-demo-conclusion.sh marginal # 临界场景
./scripts/phase5-demo-conclusion.sh fail     # 未达标场景
```

### 完成后动作

1. ✅ 生成观察报告 (包含所有指标截图)
2. ✅ 使用 [结论模板](claudedocs/PHASE5_CONCLUSION_TEMPLATE.md) 填写结果
3. ✅ 更新 SLO 为正式版本
4. ✅ 记录基线数据供后续对比
5. ✅ 进入 Sprint 1 其他工作

---

## Near-Term Sprints (新规划)

### Sprint 1: 团队效率 + 安全护栏 (3-5 天)
- [x] 开发环境一键启动 (scripts/dev-bootstrap.sh) ✅ Day 2
- [x] 本地观测环境标准化 (Docker Prometheus + Grafana) ✅ Day 3
- [x] 安全护栏实现 (SafetyGuard, double-confirm) ✅ Day 4
- [x] Phase 5 生产观察基线 (2h local baseline complete; prod rerun scheduled) ✅ Day 5
- [x] Phase 5 指标扩展 (p50/p95/p99, error_rate, cpu/mem, request_rate) ✅ Day 6

### Sprint 2: 产品能力增强 (5-7 天) ✅ 已完成
- [x] Snapshot 标签系统 (stable, canary, critical) → `SnapshotService.ts` (tags, protection_level, release_channel)
- [x] 保护规则引擎 → `ProtectionRuleService.ts` (645 行，条件匹配 + 效果执行)
- [x] 插件健康监控 → `PluginHealthService.ts` (状态追踪 + EventBus 集成)
- [x] SLO + Error Budget 管理 → `SLOService.ts` (405 行，告警 + 可视化)

### Sprint 3: 变更管理体系 (10-15 天)
- [x] ChangeManagementService 核心实现
- [x] 变更请求审批流程
- [x] Schema 快照服务
- [x] 自动变更摘要生成
- [x] 一键回滚到稳定版本

**🎯 Sprint 3 MVP 定义** (最小可用版本):
- 简单 CR 表 (change_requests) ✅
- 状态流转: draft → approved → deployed ✅
- 与 Snapshot 打通的一键回滚 ✅
- 3 条关键指标 (created, deployed, rollbacks) ✅
- Feature Flag 控制 (enableChangeManagement) ✅

### Sprint 4: Phase 10/11 核心实现
- [x] 延迟投递 (内存/Redis)
- [x] DLQ + 简单重试
- [x] 可配置退避策略
- [x] 性能基准测试
- [x] 模式索引优化

**🎯 Sprint 4 MVP 定义** (最小可用版本):
- delayFor + delayUntil 基本语义 (内存实现) ✅
- 简单 DLQ (DB 持久化，无 UI) ✅
- 固定间隔重试 (1s, 2s, 4s) ✅
- 3 条指标 (delayed, dlq, retries) ✅
- 性能基准测试脚本 (无优化实现) ✅

## Near-Term Planned (Legacy)
- Plugin hot swap during reload (cache module state)

## Future Enhancements
- RPC latency histogram & active correlations gauge
- Auditing expansion & structured logs
- WebSocket real-time metrics streaming
- Multi-region deployment support
- 金丝雀发布流程
- 多环境审批策略
- 合规报告自动生成 (SOC2/ISO)
- 变更日历可视化
- 租户级消息 QoS
- 幂等防重机制

## 设计文档索引

### 快速入口
- [**快速启动指南**](docs/QUICK_START.md) - 30 分钟环境搭建
- [**观测栈指南**](docker/observability/README.md) - Prometheus + Grafana 本地监控
- [**安全护栏指南**](packages/core-backend/src/guards/README.md) - SafetyGuard 双重确认机制
- [**新成员 Onboarding 指南**](docs/NEW_MEMBER_ONBOARDING.md) - 5 天快速上手计划
- [**功能到代码映射索引**](docs/MAP_FEATURE_TO_CODE.md) - 快速定位功能实现和状态追踪
- [**Sprint 1 执行 Checklist**](TODO_SPRINT1.md) - 每日进度追踪和完成标准

### Phase 5 文档
- [Phase 5 观察配置](claudedocs/PHASE5_OBSERVATION_CONFIG.md)
- [Phase 5 上线计划](claudedocs/PHASE5_LAUNCH_PLAN.md) - 事前/事中/事后检查清单
- [Phase 5 结论模板](claudedocs/PHASE5_CONCLUSION_TEMPLATE.md) - 观察结果快速填写
- [Phase 5 完成报告](claudedocs/PHASE5_COMPLETION_REPORT.md) - 本地观察结果

### 设计规划
- [Phase 10 Advanced Messaging 设计](claudedocs/PHASE10_ADVANCED_MESSAGING_PLAN.md)
- [Phase 11 Performance & Scale 规划](claudedocs/PHASE11_PERFORMANCE_SCALE_PLAN.md)
- [Phase 10/11 综合设计笔记](claudedocs/PHASE10_11_DESIGN_NOTES.md)
- [变更管理与快照体系设计](claudedocs/CHANGE_MANAGEMENT_SNAPSHOT_DESIGN.md)

## Metric Backlog
| Metric | Purpose | Priority |
|--------|---------|----------|
| rpcActiveCorrelations | RPC inflight gauge | Medium |
| messagesDelayedTotal | Delay adoption (Phase 10) | Planned |
| dlqMessagesTotal | DLQ monitoring (Phase 10) | Planned |
| backoffDelayHistogram | Retry patterns (Phase 10) | Planned |
| patternMatchDuration | Pattern perf (Phase 11) | Planned |
| shardDistribution | Data balance (Phase 11) | Planned |
| changeRequestsCreatedTotal | 变更管理 (Sprint 3) | Planned |
| changeDeploymentsTotal | 部署跟踪 (Sprint 3) | Planned |
| protectionRuleBlocksTotal | 保护规则 (Sprint 2) | ✅ Done |
| pluginHealthGauge | 插件健康 (Sprint 2) | ✅ Done |
| dangerousOperationsTotal | 安全护栏 (Sprint 1) | ✅ Done |
| plugin_reload_total / failures | Ops insight | ✅ Done |
| snapshot_create_total / restore_total | Versioning adoption | ✅ Done |
| snapshotCleanupTotal | Cleanup tracking | ✅ Done |

## Known Technical Debt
- RPC timeout path still keeps reply subscription (will unsubscribe in enhancement)
- Event bus previously had dual counting (now unified)
- Linear scan of patternSubs (optimize later)
- In-memory message queue (no persistence)

## Principles
- Ship minimal vertical slices with metrics
- Backward compatible within V2 until formal semantic versioning
- Favor observability before scale optimization

---

## ⚠️ Risks & Buffers

### 高优先级风险

| 风险 | 影响 | 概率 | 缓冲策略 |
|------|------|------|----------|
| **Phase 5 观察期间指标不达标** | 延迟后续 Sprint | 中 | 预留 1-2 天优化时间；允许 Sprint 1 拆分为两个小 Sprint |
| **ChangeManagementService 流程过重** | 用户体验差，采用率低 | 高 | 先实现最小闭环 (简单 CR + 一键回滚)；Feature Flag 可关闭 |
| **Phase 10/11 对现有消息路径性能影响** | 生产稳定性 | 中 | 试点验证 + 渐进式发布；保留回滚能力 |
| **团队并行开发冲突** | 合并冲突，进度延误 | 低 | 明确功能边界；每日同步；及时 code review |
| **新表/新字段兼容性问题** | 线上故障 | 中 | 所有迁移向后兼容；新功能有 Feature Flag |

### 缓冲策略

**时间缓冲**:
- Sprint 1: 标注 3-5 天，实际预留 7 天
- Sprint 2: 标注 5-7 天，实际预留 10 天
- Sprint 3: 允许拆分为多个子 Sprint

**功能缓冲**:
- 每个 Sprint 有"必做"和"可选"任务
- Sprint 3 可以只做"最小闭环"，复杂功能后推
- Phase 10/11 根据试点结果调整范围

**回滚策略**:
- 所有新功能有 Feature Flag
- 数据库迁移有回滚脚本
- 保留老代码路径至少一个 Sprint

### 决策检查点

| 检查点 | 时间 | 决策 |
|--------|------|------|
| Phase 5 观察完成 | Sprint 1 开始前 | 是否继续 Sprint 1 或优化现有功能 |
| Sprint 1 完成 | Sprint 1 结束 | Sprint 2 范围确认 |
| 试点验证完成 | Sprint 3 结束 | Phase 10/11 设计调整 |
| Sprint 3 中期 | 第 5 天 | 是否继续完整实现或缩减范围 |

### 应急预案

**场景: Phase 5 观察失败**
- 立即分析根因
- 预留 2-3 天修复时间
- 重新观察直到达标
- 推迟 Sprint 1 启动

**场景: Sprint 超时**
- 识别哪些任务可推迟
- 优先完成"必做"任务
- 记录技术债务
- 下个 Sprint 继续

**场景: 用户反馈流程过重**
- 快速迭代简化流程
- 增加更多 Feature Flag
- 考虑"简化模式"选项
- 收集具体反馈点
