# Metasheet V2架构迁移执行手册

**版本**: 1.0
**发布日期**: 2025-09-30
**目标读者**: 架构师、平台负责人、核心开发团队
**预计周期**: 4周 (2025-09-30 ~ 2025-10-28)

---

## 📋 文档导航

本手册是V2架构迁移的总纲，包含以下配套文档：

1. **核心文档**
   - `v2-merge-adjustment-plan.md` - 合并与调整方案（原始草案）
   - `v2-merge-adjustment-plan-review.md` - 方案评审意见
   - `v2-migration-tracker.md` - 详细迁移进度跟踪（📍主要工作文档）

2. **技术文档**
   - `046_workflow_core_schema_draft.sql` - 工作流表结构草案
   - `plugin-manifest-schema.md` - 插件Manifest规范（待创建）
   - `plugin-lifecycle.md` - 插件生命周期文档（待创建）

3. **风险管理**
   - `rollback-procedures/viewservice-unification.md` - ViewService回滚预案
   - 其他回滚预案（随各阶段创建）

4. **工具脚本**
   - `scripts/cleanup-test-branches.sh` - 测试分支批量清理工具
   - `scripts/compare-benchmarks.js` - 性能基准对比工具（待创建）

---

## 🎯 总体目标与原则

### 目标
1. **主线稳定**: 保持main分支随时可部署，合入节奏可控
2. **渐进增强**: 以"MVP壳 + 特性开关 + 逐步增强"落地v2架构
3. **分支收敛**: 统一服务层与数据模型，减少重复实现
4. **插件外放**: 把可变能力外放为插件，核心保持精简

### 原则
1. **仅追加迁移**: 不修改历史迁移，保持`043_core_model_views.sql`锚点
2. **小步快跑**: 每个PR ≤300行，具备回滚说明
3. **严格审核**: 核心/迁移/接口变更需CODEOWNERS审核
4. **CI快车道**: 依赖/文档类改动快速合并，关键路径严格校验

---

## 📊 方案评分与关键决策

### 方案评分: ⭐⭐⭐⭐½ (4.5/5)

**优秀之处（90%）**:
- ✅ 渐进式架构演进策略正确
- ✅ 锚点迁移策略避免破坏性变更
- ✅ 分阶段交付清晰可控
- ✅ 借鉴成熟开源项目（Baserow/NocoDB/n8n）
- ✅ CI快车道设计高效

**需调整之处（10%）**:
- ⚠️ P0周期拆分为P0-A（3天）+ P0-B（2天）
- ⚠️ ViewService合并策略细化（#155主 + #158增强）
- ⚠️ 工作流Schema补充详细字段定义（已完成草案）
- ⚠️ 插件失败处理明确critical标记和降级路径

### 关键技术决策

#### 决策1: ViewService统一策略
**问题**: PR #155 vs #158存在差异
**决策**:
- 采用#155的完整实现（275行ViewService + 迁移文件）
- Cherry-pick #158的增强（Metrics + 深度RBAC）
- 删除view-service.ts精简版（功能重复）

**影响**: 中等，需仔细合并和测试
**风险缓解**: 详细功能对比表 + 完整测试套件 + 回滚预案

#### 决策2: 插件失败处理策略
**问题**: 插件加载失败如何处理
**决策**:
- 关键插件（`critical: true`）: fail-closed，系统拒绝启动
- 非关键插件: fail-open，返回NullPlugin或加载fallback
- 所有失败都记录审计日志

**关键插件列表**:
- `audit-trail`: 审计功能，必须可用
- `rbac-enforcer`: 权限控制，必须可用

**非关键插件**:
- `view-kanban`: 降级到GridView
- `datasource-mysql`: 禁用MySQL数据源，保留Postgres

#### 决策3: 迁移顺序调整
**原计划**: P0本周完成所有基础工作
**调整后**:
- P0-A（Day 1-3）: 基础合并 + 测试分支清理
- P0-B（Day 4-5）: 架构准备 + Schema草案

**原因**: 避免时间压力导致质量下降

---

## 🚀 执行路线图（精简版）

### P0 阶段（本周 Day 1-5）

#### P0-A: 基础合并（Day 1-3）
- ✅ Task 1: ViewService功能对比与统一（2天）
  - 生成功能对比表
  - 合并#155主实现 + Cherry-pick #158增强
  - 完整测试验证
  - **产出**: 统一的ViewService + 回滚预案

- ✅ Task 2: 测试分支批量清理（0.5天）
  - 使用`scripts/cleanup-test-branches.sh`
  - 归档18-23个测试分支报告
  - **产出**: 干净的分支结构（~100分支 → <80分支）

- ✅ Task 3: 集成测试全面验证（0.5天）
  - 五类视图功能测试
  - RBAC权限测试
  - 性能基准测试
  - **产出**: 性能对比报告 + 测试通过证明

#### P0-B: 架构准备（Day 4-5）
- ✅ Task 4: feat/core-backend-v2分支创建（1.5天）
  - 抽取PluginContext/EventBus/ConfigService
  - 保持向后兼容
  - **产出**: 核心服务层框架 + API文档

- ✅ Task 5: feat/plugin-framework-v2分支创建（1.5天）
  - 增强PluginManifest schema
  - 实现PluginLoader增强（critical标记、fallback）
  - **产出**: 插件框架V2 + 开发指南

- ✅ Task 6: 工作流Schema详细化（0.5天）
  - 完善`046_workflow_core.sql`
  - 添加迁移检查和幂等性验证
  - **产出**: 可执行的迁移文件 + Token状态机文档

---

### P1 阶段（第1-2周）

**核心任务**:
1. Kanban插件化（最复杂，3天）
2. Gallery插件化（中等，3天）
3. Form插件化（简单，2天）
4. DataMaterialization插件壳（2天）
5. 工作流最小API（definitions/instances CRUD，2天）

**总计**: 12天工作量，2周（允许缓冲）

**详细步骤**: 见`v2-migration-tracker.md` P1章节

---

### P2 阶段（第2-4周）

**核心任务**:
1. Workflow Engine V2（Token执行引擎，5天）
2. ScriptRunner插件（JS沙箱 + 队列，3天）
3. DataSource Adapters（统一接口，3天）
4. Audit Trail插件（审计日志统一，2天）
5. Calendar插件（新功能，4天）

**总计**: 17天工作量，2周（密集开发）

**详细步骤**: 见`v2-migration-tracker.md` P2章节

---

## 🛡️ 风险管理

### 高风险项（🔴）
1. **ViewService合并复杂度**
   - 缓解: 详细功能对比 + 完整测试 + 回滚预案
   - 负责人: 后端负责人
   - 文档: `rollback-procedures/viewservice-unification.md`

2. **P0周期过紧**
   - 缓解: 拆分P0-A/P0-B，增加缓冲时间
   - 调整: 从5天单阶段 → 3+2天双阶段

### 中风险项（🟡）
1. **工作流Schema设计不完善**
   - 缓解: P0-B完成详细Schema草案
   - 文档: `046_workflow_core_schema_draft.sql`

2. **插件失败处理策略不明确**
   - 缓解: 明确critical标记和fallback机制
   - 实现: PluginLoader增强版

### 低风险项（🟢）
1. **测试分支清理**
   - 工具: `scripts/cleanup-test-branches.sh`
   - 影响: 仅管理层面，不影响功能

---

## 📈 监控与指标

### 关键指标

**插件相关**:
- `plugin_load_time_ms` (P99 < 1s)
- `plugin_error_count` (错误率 < 1%)

**视图相关**:
- `view_render_time_ms` (P95 < 500ms)

**工作流相关**:
- `workflow_instance_duration_ms` (按workflow_name分组)
- `workflow_token_count` (活跃Token数量)

**迁移相关**:
- `migration_execution_time_ms` (执行时长)

### 告警阈值

| 指标 | 警告阈值 | 严重阈值 |
|------|---------|---------|
| 插件加载时间 | >500ms | >1s |
| 插件错误率 | >0.5% | >1% |
| 视图渲染时间 | >300ms | >500ms |
| 系统错误率 | >0.1% | >1% |
| P99延迟 | >500ms | >1s |

### Grafana仪表盘

**核心面板**:
1. 插件健康状态（加载时间、错误率）
2. 视图性能（渲染时间、QPS）
3. 工作流执行（实例数、Token数）
4. 系统整体（错误率、延迟、吞吐）

**配置**: 见`v2-migration-tracker.md` 监控指标增强章节

---

## ✅ 质量门禁

### P0-A完成标准
- [ ] ViewService功能对比表完成
- [ ] #155主实现 + #158增强合并完成
- [ ] 单元测试覆盖率 >80%
- [ ] 集成测试100%通过
- [ ] 五类视图回归测试通过
- [ ] RBAC权限测试通过（403 → grant → 200）
- [ ] 性能退化 <10%（P99延迟）
- [ ] 测试分支清理完成（归档报告）
- [ ] 回滚预案文档完成

### P0-B完成标准
- [ ] PluginContext接口定义完整
- [ ] DatabaseService/EventBus/ConfigService抽取完成
- [ ] 所有Service有单元测试覆盖
- [ ] 向后兼容性验证通过
- [ ] PluginManifest schema V2定义完成
- [ ] PluginLoader增强实现完成（critical + fallback）
- [ ] 插件开发指南文档完成
- [ ] 046_workflow_core.sql迁移文件就绪
- [ ] 迁移幂等性验证通过

### P1完成标准
- [ ] Kanban/Gallery/Form插件化完成
- [ ] 每个插件独立加载测试通过
- [ ] 插件降级测试通过（fallback机制）
- [ ] DataMaterialization插件壳上线
- [ ] 工作流CRUD API实现并测试
- [ ] 046/047迁移应用到生产

### P2完成标准
- [ ] Token执行引擎实现并测试
- [ ] 工作流示例（购买审批）运行成功
- [ ] ScriptRunner插件上线（JS沙箱）
- [ ] DataSource Adapters统一接口实现
- [ ] Audit Trail插件集成完成
- [ ] 性能基准达标（见指标要求）
- [ ] 文档完整（架构文档、API文档、开发指南）

---

## 👥 团队协作

### 角色与职责

| 角色 | 负责人 | 职责 |
|------|--------|------|
| **架构师** | [待指定] | 总体设计、技术决策、Code Review |
| **平台负责人** | [待指定] | 项目管理、风险控制、资源协调 |
| **后端负责人** | [待指定] | ViewService统一、工作流引擎、插件框架 |
| **前端负责人** | [待指定] | 视图组件迁移、插件前端集成 |
| **数据库负责人** | [待指定] | 迁移文件、Schema设计、性能优化 |
| **DevOps** | [待指定] | CI/CD、部署、监控、回滚演练 |
| **QA** | [待指定] | 测试策略、集成测试、性能测试 |

### 沟通机制

**日常沟通**:
- Slack: `#v2-migration`
- 每日站会: 10:00 AM（15分钟）
- 周五周报: 提交至`docs/weekly-reports/`

**紧急沟通**:
- Slack: `#incident-response`
- On-Call轮值表
- 紧急联系人列表（见各回滚预案）

**决策机制**:
- 技术决策: 架构师主导，团队评审
- 风险决策: 平台负责人主导，架构师协助
- 紧急决策: On-Call有权快速决策，事后补充说明

---

## 📚 学习资源

### 参考项目
- **Baserow**: 视图插件化设计 (https://gitlab.com/baserow/baserow)
- **NocoDB**: 外部数据源适配器 (https://github.com/nocodb/nocodb)
- **n8n**: 工作流可视化设计器 (https://github.com/n8n-io/n8n)
- **Camunda**: Token-based工作流引擎 (https://github.com/camunda/camunda-bpm-platform)
- **SeaTable**: 脚本沙箱实现 (https://github.com/seatable/seatable)

### 内部文档
- 插件开发指南（待创建）
- PluginContext API文档（P0-B产出）
- 工作流Schema设计（P0-B产出）
- 迁移最佳实践（待创建）

### 培训计划
- **Week 1**: 插件框架培训（2小时）
- **Week 2**: 工作流引擎原理（2小时）
- **Week 3**: 性能优化实践（2小时）
- **Week 4**: 回滚演练（1小时）

---

## 🎯 成功标准

### 技术成功标准
1. ✅ 主线稳定性 ≥99.9%（无严重故障）
2. ✅ 性能退化 <10%（P99延迟）
3. ✅ 测试覆盖率 >80%（单元 + 集成）
4. ✅ 代码质量 >85分（SonarQube）
5. ✅ 文档完整性 100%（所有公开API有文档）

### 业务成功标准
1. ✅ 零数据丢失或损坏
2. ✅ 用户体验无负面影响
3. ✅ 新功能（Calendar视图）上线
4. ✅ 架构灵活性提升（插件化完成）
5. ✅ 技术债务减少（分支收敛、代码统一）

### 团队成功标准
1. ✅ 按时交付（4周内完成）
2. ✅ 无团队成员过度加班（周工作时长 <50小时）
3. ✅ 知识沉淀（文档完整、培训完成）
4. ✅ 技能提升（团队掌握插件化架构、工作流引擎）

---

## 🔄 持续改进

### 回顾会议
- **时间**: 每阶段结束后
- **参与者**: 全体团队成员
- **议程**:
  1. What went well? (做得好的)
  2. What could be improved? (可改进的)
  3. Action items (行动计划)

### 文档更新
- 根据实际执行情况更新本手册
- 补充实践中发现的最佳实践
- 记录踩过的坑和解决方案

### 知识分享
- 内部技术分享会（每个阶段1次）
- 技术博客文章（对外分享）
- 代码注释和README完善

---

## 📞 支持与反馈

**问题上报**:
- GitHub Issues: label `v2-migration`
- Slack: `#v2-migration`

**文档反馈**:
- PR到`docs/`目录
- 或在Slack讨论

**紧急支持**:
- On-Call: [当前值班人员]
- 架构师: [紧急联系方式]
- 平台负责人: [紧急联系方式]

---

## 🎉 里程碑庆祝

**P0完成**: 团队午餐 🍕
**P1完成**: 团队晚餐 🍽️
**P2完成**: 团队活动 🎳
**全部完成**: 项目总结会 + 奖金 🎊

---

**祝大家顺利完成V2架构迁移！** 🚀

---

**最后更新**: 2025-09-30
**下次审查**: P0完成后（预计2025-10-04）
