# 变更管理与快照体系设计草案

**文档版本**: 1.0.0
**创建日期**: 2025-11-16
**状态**: 设计阶段

---

## 📋 概述

将现有 Snapshot/Versioning MVP 扩展为完整的变更管理体系，支持：

- **变更工作流化** - 审批、发布、回滚的标准流程
- **标签与保护规则** - stable, canary, critical 等标签系统
- **变更摘要自动生成** - 从 diff 生成变更说明
- **Schema 级安全快照** - 配置/逻辑与数据分离
- **审计与合规** - 完整的变更追溯链

---

## 🎯 设计目标

| 目标 | 指标 | 优先级 |
|------|------|--------|
| 变更可追溯 | 100% 变更有记录 | 高 |
| 快速回滚 | < 5 分钟恢复 | 高 |
| 审批流程 | 支持多人/多环境 | 中 |
| 自动化程度 | > 80% 操作无需手动 | 中 |
| 合规性 | SOC2/ISO 就绪 | 高 |

---

## 🏗️ 核心架构

### 1. 数据模型扩展

```sql
-- 快照标签系统
ALTER TABLE snapshots
ADD COLUMN tags TEXT[] DEFAULT '{}',
ADD COLUMN protection_level TEXT DEFAULT 'normal',
ADD COLUMN release_channel TEXT,
ADD COLUMN change_type TEXT,
ADD COLUMN parent_snapshot_id TEXT REFERENCES snapshots(id);

-- 预定义值
-- protection_level: 'normal', 'protected', 'critical'
-- release_channel: 'stable', 'canary', 'beta', 'experimental'
-- change_type: 'feature', 'bugfix', 'hotfix', 'schema', 'config', 'rollback'

CREATE INDEX idx_snapshots_tags ON snapshots USING GIN(tags);
CREATE INDEX idx_snapshots_channel ON snapshots(release_channel);
CREATE INDEX idx_snapshots_protection ON snapshots(protection_level);

-- 变更请求表 (Change Request)
CREATE TABLE change_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  title TEXT NOT NULL,
  description TEXT,
  change_type TEXT NOT NULL,
  target_environment TEXT NOT NULL, -- dev, staging, production
  status TEXT DEFAULT 'pending',
  -- pending, approved, rejected, deployed, rolled_back

  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ DEFAULT NOW(),

  approvers TEXT[] DEFAULT '{}',
  required_approvals INTEGER DEFAULT 1,
  current_approvals INTEGER DEFAULT 0,

  deployed_at TIMESTAMPTZ,
  deployed_by TEXT,

  rolled_back_at TIMESTAMPTZ,
  rolled_back_by TEXT,
  rollback_reason TEXT,

  auto_generated_notes TEXT,
  risk_score FLOAT DEFAULT 0.0,
  impact_assessment JSONB DEFAULT '{}',

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cr_status ON change_requests(status);
CREATE INDEX idx_cr_environment ON change_requests(target_environment);
CREATE INDEX idx_cr_requested_by ON change_requests(requested_by);

-- 变更审批记录
CREATE TABLE change_approvals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id),
  approver_id TEXT NOT NULL,
  decision TEXT NOT NULL, -- approved, rejected
  comment TEXT,
  approved_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ca_request ON change_approvals(change_request_id);

-- 变更历史追溯
CREATE TABLE change_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  entity_type TEXT NOT NULL, -- snapshot, plugin, schema, config
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL, -- created, updated, deleted, restored, deployed
  actor_id TEXT NOT NULL,
  change_request_id TEXT REFERENCES change_requests(id),
  before_state JSONB,
  after_state JSONB,
  diff_summary TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ch_entity ON change_history(entity_type, entity_id);
CREATE INDEX idx_ch_timestamp ON change_history(timestamp);

-- 保护规则表
CREATE TABLE protection_rules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  rule_name TEXT NOT NULL UNIQUE,
  description TEXT,
  target_type TEXT NOT NULL, -- snapshot, plugin, schema
  conditions JSONB NOT NULL,
  actions JSONB NOT NULL,
  -- 例如: {"block_delete": true, "require_approval": true, "notify": ["slack"]}
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schema 快照表 (独立于数据快照)
CREATE TABLE schema_snapshots (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  view_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  schema_definition JSONB NOT NULL,
  -- 包含: 字段定义、约束、索引、关系
  validation_rules JSONB DEFAULT '{}',
  migration_script TEXT,
  rollback_script TEXT,
  is_current BOOLEAN DEFAULT false,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ss_view ON schema_snapshots(view_id);
CREATE INDEX idx_ss_current ON schema_snapshots(is_current) WHERE is_current = true;
```

---

### 2. 变更工作流服务

```typescript
// src/services/ChangeManagementService.ts

interface ChangeRequestInput {
  snapshotId: string
  title: string
  description?: string
  changeType: 'feature' | 'bugfix' | 'hotfix' | 'schema' | 'config' | 'rollback'
  targetEnvironment: 'dev' | 'staging' | 'production'
  requestedBy: string
  requiredApprovals?: number
}

interface ChangeRequestResult {
  changeRequest: ChangeRequest
  riskScore: number
  impactAssessment: ImpactAssessment
  autoGeneratedNotes: string
  warnings: string[]
}

interface ImpactAssessment {
  affectedItems: number
  affectedViews: string[]
  hasSchemaChanges: boolean
  hasDataChanges: boolean
  estimatedDowntime: number // 秒
  riskFactors: string[]
}

class ChangeManagementService {
  constructor(
    private snapshotService: SnapshotService,
    private notificationService: NotificationService,
    private auditService: AuditService
  ) {}

  /**
   * 创建变更请求
   */
  async createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestResult> {
    // 1. 获取快照信息
    const snapshot = await this.snapshotService.getSnapshot(input.snapshotId)
    if (!snapshot) throw new Error('Snapshot not found')

    // 2. 评估风险
    const riskScore = await this.assessRisk(snapshot, input.targetEnvironment)

    // 3. 影响分析
    const impactAssessment = await this.analyzeImpact(snapshot)

    // 4. 自动生成变更说明
    const autoGeneratedNotes = await this.generateChangeNotes(snapshot)

    // 5. 确定所需审批数量
    let requiredApprovals = input.requiredApprovals || 1
    if (input.targetEnvironment === 'production') {
      requiredApprovals = Math.max(requiredApprovals, 2)
    }
    if (riskScore > 0.7) {
      requiredApprovals = Math.max(requiredApprovals, 3)
    }

    // 6. 创建变更请求
    const changeRequest = await db
      .insertInto('change_requests')
      .values({
        snapshot_id: input.snapshotId,
        title: input.title,
        description: input.description,
        change_type: input.changeType,
        target_environment: input.targetEnvironment,
        requested_by: input.requestedBy,
        required_approvals: requiredApprovals,
        auto_generated_notes: autoGeneratedNotes,
        risk_score: riskScore,
        impact_assessment: JSON.stringify(impactAssessment)
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // 7. 发送通知
    await this.notifyReviewers(changeRequest, riskScore)

    // 8. 记录审计
    await this.auditService.log({
      entityType: 'change_request',
      entityId: changeRequest.id,
      action: 'created',
      actorId: input.requestedBy,
      afterState: changeRequest
    })

    // 9. 检查警告
    const warnings = this.generateWarnings(riskScore, impactAssessment, input.targetEnvironment)

    metrics.changeRequestsCreatedTotal.labels(input.changeType, input.targetEnvironment).inc()

    return {
      changeRequest,
      riskScore,
      impactAssessment,
      autoGeneratedNotes,
      warnings
    }
  }

  /**
   * 审批变更请求
   */
  async approveChangeRequest(
    changeRequestId: string,
    approverId: string,
    comment?: string
  ): Promise<{ approved: boolean; readyToDeploy: boolean }> {
    const cr = await this.getChangeRequest(changeRequestId)
    if (!cr) throw new Error('Change request not found')

    if (cr.status !== 'pending') {
      throw new Error(`Cannot approve: status is ${cr.status}`)
    }

    // 检查是否已经审批过
    const existingApproval = await db
      .selectFrom('change_approvals')
      .where('change_request_id', '=', changeRequestId)
      .where('approver_id', '=', approverId)
      .executeTakeFirst()

    if (existingApproval) {
      throw new Error('Already approved by this user')
    }

    // 记录审批
    await db.insertInto('change_approvals').values({
      change_request_id: changeRequestId,
      approver_id: approverId,
      decision: 'approved',
      comment
    }).execute()

    // 更新审批计数
    const newApprovalCount = cr.current_approvals + 1
    await db
      .updateTable('change_requests')
      .set({
        current_approvals: newApprovalCount,
        approvers: [...cr.approvers, approverId],
        updated_at: new Date()
      })
      .where('id', '=', changeRequestId)
      .execute()

    const readyToDeploy = newApprovalCount >= cr.required_approvals

    if (readyToDeploy) {
      await db
        .updateTable('change_requests')
        .set({ status: 'approved' })
        .where('id', '=', changeRequestId)
        .execute()

      await this.notificationService.send({
        channel: 'slack',
        message: `✅ Change Request ${cr.title} approved and ready to deploy`
      })
    }

    metrics.changeApprovalsTotal.labels('approved').inc()

    return { approved: true, readyToDeploy }
  }

  /**
   * 部署变更
   */
  async deployChange(
    changeRequestId: string,
    deployedBy: string,
    options: { dryRun?: boolean; force?: boolean } = {}
  ): Promise<DeploymentResult> {
    const cr = await this.getChangeRequest(changeRequestId)
    if (!cr) throw new Error('Change request not found')

    if (cr.status !== 'approved' && !options.force) {
      throw new Error('Change request not yet approved')
    }

    // 安全检查
    if (cr.target_environment === 'production' && !options.force) {
      const safetyCheck = await this.performSafetyCheck(cr)
      if (!safetyCheck.passed) {
        throw new Error(`Safety check failed: ${safetyCheck.reason}`)
      }
    }

    // Dry run 模式
    if (options.dryRun) {
      return {
        success: true,
        dryRun: true,
        wouldAffect: await this.previewDeployment(cr)
      }
    }

    // 执行部署 (恢复快照)
    const deployStart = Date.now()
    try {
      const restoreResult = await this.snapshotService.restoreSnapshot({
        snapshotId: cr.snapshot_id,
        restoredBy: deployedBy,
        restoreType: 'full'
      })

      // 更新变更请求状态
      await db
        .updateTable('change_requests')
        .set({
          status: 'deployed',
          deployed_at: new Date(),
          deployed_by: deployedBy,
          updated_at: new Date()
        })
        .where('id', '=', changeRequestId)
        .execute()

      // 记录变更历史
      await this.auditService.log({
        entityType: 'change_request',
        entityId: changeRequestId,
        action: 'deployed',
        actorId: deployedBy,
        changeRequestId,
        afterState: { restoreResult }
      })

      // 发送部署通知
      await this.notifyDeployment(cr, deployedBy, 'success')

      const deployDuration = (Date.now() - deployStart) / 1000
      metrics.changeDeploymentDuration.observe(deployDuration)
      metrics.changeDeploymentsTotal.labels('success').inc()

      return {
        success: true,
        dryRun: false,
        restoreResult,
        deployDuration
      }
    } catch (error) {
      metrics.changeDeploymentsTotal.labels('failure').inc()
      await this.notifyDeployment(cr, deployedBy, 'failure', error as Error)
      throw error
    }
  }

  /**
   * 回滚变更
   */
  async rollbackChange(
    changeRequestId: string,
    rolledBackBy: string,
    reason: string
  ): Promise<RollbackResult> {
    const cr = await this.getChangeRequest(changeRequestId)
    if (!cr) throw new Error('Change request not found')

    if (cr.status !== 'deployed') {
      throw new Error('Can only rollback deployed changes')
    }

    // 找到父快照 (部署前的状态)
    const snapshot = await this.snapshotService.getSnapshot(cr.snapshot_id)
    if (!snapshot.parent_snapshot_id) {
      throw new Error('No parent snapshot available for rollback')
    }

    // 恢复到父快照
    const rollbackResult = await this.snapshotService.restoreSnapshot({
      snapshotId: snapshot.parent_snapshot_id,
      restoredBy: rolledBackBy,
      restoreType: 'full'
    })

    // 更新状态
    await db
      .updateTable('change_requests')
      .set({
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rolled_back_by: rolledBackBy,
        rollback_reason: reason,
        updated_at: new Date()
      })
      .where('id', '=', changeRequestId)
      .execute()

    // 记录审计
    await this.auditService.log({
      entityType: 'change_request',
      entityId: changeRequestId,
      action: 'rolled_back',
      actorId: rolledBackBy,
      changeRequestId,
      afterState: { reason, rollbackResult }
    })

    // 告警通知
    await this.notificationService.send({
      channel: ['slack', 'pagerduty'],
      priority: 'high',
      message: `🔄 ROLLBACK: ${cr.title} has been rolled back. Reason: ${reason}`
    })

    metrics.changeRollbacksTotal.inc()

    return {
      success: true,
      rollbackResult,
      parentSnapshotId: snapshot.parent_snapshot_id
    }
  }

  /**
   * 风险评估
   */
  private async assessRisk(snapshot: Snapshot, environment: string): Promise<number> {
    let score = 0

    // 环境风险权重
    const envWeights = { dev: 0.1, staging: 0.3, production: 0.6 }
    score += envWeights[environment] || 0

    // 变更规模
    const itemCount = snapshot.metadata?.item_count || 0
    if (itemCount > 1000) score += 0.2
    if (itemCount > 10000) score += 0.2

    // 是否包含 schema 变更
    if (snapshot.snapshot_type === 'schema' || snapshot.tags?.includes('schema-change')) {
      score += 0.3
    }

    // 检查保护规则
    const protectedItems = await this.checkProtectionRules(snapshot)
    if (protectedItems.length > 0) {
      score += 0.2
    }

    return Math.min(1.0, score)
  }

  /**
   * 影响分析
   */
  private async analyzeImpact(snapshot: Snapshot): Promise<ImpactAssessment> {
    const items = await this.snapshotService.getSnapshotItems(snapshot.id)

    const affectedViews = [...new Set(items.map(i => i.view_id).filter(Boolean))]
    const hasSchemaChanges = snapshot.tags?.includes('schema-change') || false
    const hasDataChanges = items.length > 0

    const riskFactors: string[] = []
    if (items.length > 10000) riskFactors.push('Large dataset')
    if (hasSchemaChanges) riskFactors.push('Schema modification')
    if (affectedViews.length > 5) riskFactors.push('Multiple views affected')

    return {
      affectedItems: items.length,
      affectedViews,
      hasSchemaChanges,
      hasDataChanges,
      estimatedDowntime: hasSchemaChanges ? 60 : 0, // 秒
      riskFactors
    }
  }

  /**
   * 自动生成变更说明
   */
  private async generateChangeNotes(snapshot: Snapshot): Promise<string> {
    const items = await this.snapshotService.getSnapshotItems(snapshot.id)

    const summary = {
      totalItems: items.length,
      itemsByType: {} as Record<string, number>,
      changedFields: [] as string[]
    }

    // 统计 item 类型
    for (const item of items) {
      summary.itemsByType[item.item_type] = (summary.itemsByType[item.item_type] || 0) + 1
    }

    // 生成 Markdown 格式
    let notes = `## 变更摘要\n\n`
    notes += `**快照 ID**: ${snapshot.id}\n`
    notes += `**创建时间**: ${snapshot.created_at}\n`
    notes += `**创建者**: ${snapshot.created_by}\n`
    notes += `**总计项目**: ${summary.totalItems}\n\n`

    notes += `### 按类型分布\n`
    for (const [type, count] of Object.entries(summary.itemsByType)) {
      notes += `- ${type}: ${count} 项\n`
    }

    if (snapshot.tags && snapshot.tags.length > 0) {
      notes += `\n### 标签\n`
      notes += snapshot.tags.map(t => `- ${t}`).join('\n')
    }

    if (snapshot.description) {
      notes += `\n### 描述\n${snapshot.description}\n`
    }

    return notes
  }

  /**
   * 生成警告信息
   */
  private generateWarnings(
    riskScore: number,
    impact: ImpactAssessment,
    environment: string
  ): string[] {
    const warnings: string[] = []

    if (riskScore > 0.7) {
      warnings.push(`⚠️ HIGH RISK: Risk score is ${(riskScore * 100).toFixed(0)}%`)
    }

    if (environment === 'production') {
      warnings.push('🔴 PRODUCTION DEPLOYMENT: This will affect live system')
    }

    if (impact.hasSchemaChanges) {
      warnings.push('📐 SCHEMA CHANGE: Database structure will be modified')
    }

    if (impact.affectedItems > 10000) {
      warnings.push(`📊 LARGE DATASET: ${impact.affectedItems} items will be affected`)
    }

    if (impact.estimatedDowntime > 0) {
      warnings.push(`⏱️ DOWNTIME: Estimated ${impact.estimatedDowntime} seconds`)
    }

    return warnings
  }

  /**
   * 一键回滚到最近稳定版本
   */
  async rollbackToLatestStable(
    viewId: string,
    rolledBackBy: string,
    reason: string
  ): Promise<RollbackResult> {
    // 查找最近的 stable 快照
    const stableSnapshot = await db
      .selectFrom('snapshots' as any)
      .where('view_id', '=', viewId)
      .where('release_channel', '=', 'stable')
      .where('is_locked', '=', false)
      .orderBy('created_at', 'desc')
      .selectAll()
      .executeTakeFirst()

    if (!stableSnapshot) {
      throw new Error('No stable snapshot found for this view')
    }

    // 创建快速回滚变更请求
    const cr = await this.createChangeRequest({
      snapshotId: stableSnapshot.id,
      title: `Emergency rollback to stable: ${stableSnapshot.name}`,
      description: reason,
      changeType: 'rollback',
      targetEnvironment: 'production',
      requestedBy: rolledBackBy,
      requiredApprovals: 0 // 紧急回滚无需审批
    })

    // 立即部署
    return this.deployChange(cr.changeRequest.id, rolledBackBy, { force: true })
  }
}
```

---

### 3. 标签与保护规则服务

```typescript
// src/services/ProtectionRuleService.ts

interface ProtectionRule {
  id: string
  ruleName: string
  targetType: 'snapshot' | 'plugin' | 'schema'
  conditions: {
    tags_contain?: string[]
    tags_not_contain?: string[]
    age_less_than_days?: number
    protection_level?: string
    release_channel?: string
    view_id?: string
  }
  actions: {
    block_delete?: boolean
    block_modify?: boolean
    require_approval?: boolean
    require_reason?: boolean
    notify?: string[]
    min_approvers?: number
  }
  isActive: boolean
  priority: number
}

class ProtectionRuleService {
  /**
   * 评估实体是否受保护
   */
  async evaluateProtection(
    entityType: 'snapshot' | 'plugin' | 'schema',
    entity: any,
    operation: 'delete' | 'modify' | 'restore'
  ): Promise<{
    protected: boolean
    rules: ProtectionRule[]
    requiredActions: string[]
  }> {
    const rules = await this.getActiveRules(entityType)
    const matchingRules: ProtectionRule[] = []
    const requiredActions: string[] = []

    for (const rule of rules) {
      if (this.matchesConditions(entity, rule.conditions)) {
        matchingRules.push(rule)

        // 收集需要的操作
        if (operation === 'delete' && rule.actions.block_delete) {
          requiredActions.push(`BLOCKED: ${rule.ruleName} prevents deletion`)
        }
        if (operation === 'modify' && rule.actions.block_modify) {
          requiredActions.push(`BLOCKED: ${rule.ruleName} prevents modification`)
        }
        if (rule.actions.require_approval) {
          requiredActions.push(`APPROVAL_REQUIRED: ${rule.actions.min_approvers || 1} approvers`)
        }
        if (rule.actions.require_reason) {
          requiredActions.push('REASON_REQUIRED')
        }
        if (rule.actions.notify) {
          requiredActions.push(`NOTIFY: ${rule.actions.notify.join(', ')}`)
        }
      }
    }

    const hasBlockingAction = requiredActions.some(a => a.startsWith('BLOCKED'))

    return {
      protected: matchingRules.length > 0,
      rules: matchingRules,
      requiredActions
    }
  }

  /**
   * 自动应用保护规则到快照
   */
  async autoApplyProtection(snapshot: Snapshot): Promise<void> {
    const rules = await db
      .selectFrom('protection_rules')
      .where('target_type', '=', 'snapshot')
      .where('is_active', '=', true)
      .selectAll()
      .execute()

    for (const rule of rules) {
      if (this.matchesConditions(snapshot, rule.conditions)) {
        // 更新快照保护级别
        await db
          .updateTable('snapshots' as any)
          .set({
            protection_level: rule.actions.protection_level || 'protected'
          })
          .where('id', '=', snapshot.id)
          .execute()

        await this.auditService.log({
          entityType: 'snapshot',
          entityId: snapshot.id,
          action: 'protection_applied',
          actorId: 'system',
          afterState: { rule: rule.rule_name }
        })
      }
    }
  }

  private matchesConditions(entity: any, conditions: any): boolean {
    if (conditions.tags_contain) {
      const hasAllTags = conditions.tags_contain.every(
        (tag: string) => entity.tags?.includes(tag)
      )
      if (!hasAllTags) return false
    }

    if (conditions.protection_level && entity.protection_level !== conditions.protection_level) {
      return false
    }

    if (conditions.release_channel && entity.release_channel !== conditions.release_channel) {
      return false
    }

    if (conditions.age_less_than_days) {
      const ageInDays = (Date.now() - new Date(entity.created_at).getTime()) / (24 * 3600 * 1000)
      if (ageInDays >= conditions.age_less_than_days) return false
    }

    return true
  }
}
```

---

### 4. Schema 快照服务

```typescript
// src/services/SchemaSnapshotService.ts

interface SchemaDefinition {
  fields: Array<{
    name: string
    type: string
    nullable: boolean
    defaultValue?: any
    constraints?: string[]
  }>
  indexes: Array<{
    name: string
    columns: string[]
    unique: boolean
  }>
  relations: Array<{
    name: string
    targetTable: string
    type: 'one-to-one' | 'one-to-many' | 'many-to-many'
  }>
}

class SchemaSnapshotService {
  /**
   * 创建 Schema 快照
   */
  async createSchemaSnapshot(
    viewId: string,
    createdBy: string
  ): Promise<SchemaSnapshot> {
    // 提取当前 Schema
    const schemaDefinition = await this.extractSchemaDefinition(viewId)

    // 生成版本号
    const version = `v${Date.now()}`

    // 生成迁移脚本
    const migrationScript = await this.generateMigrationScript(viewId, schemaDefinition)
    const rollbackScript = await this.generateRollbackScript(viewId, schemaDefinition)

    // 验证规则
    const validationRules = await this.extractValidationRules(viewId)

    const schemaSnapshot = await db
      .insertInto('schema_snapshots')
      .values({
        view_id: viewId,
        schema_version: version,
        schema_definition: JSON.stringify(schemaDefinition),
        validation_rules: JSON.stringify(validationRules),
        migration_script: migrationScript,
        rollback_script: rollbackScript,
        created_by: createdBy
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    metrics.schemaSnapshotsCreatedTotal.inc()

    return schemaSnapshot
  }

  /**
   * 比较两个 Schema 快照
   */
  async diffSchemas(
    snapshotId1: string,
    snapshotId2: string
  ): Promise<SchemaDiff> {
    const s1 = await this.getSchemaSnapshot(snapshotId1)
    const s2 = await this.getSchemaSnapshot(snapshotId2)

    const schema1 = JSON.parse(s1.schema_definition) as SchemaDefinition
    const schema2 = JSON.parse(s2.schema_definition) as SchemaDefinition

    const diff: SchemaDiff = {
      addedFields: [],
      removedFields: [],
      modifiedFields: [],
      addedIndexes: [],
      removedIndexes: [],
      addedRelations: [],
      removedRelations: [],
      isBreakingChange: false
    }

    // 比较字段
    const fieldsMap1 = new Map(schema1.fields.map(f => [f.name, f]))
    const fieldsMap2 = new Map(schema2.fields.map(f => [f.name, f]))

    for (const [name, field] of fieldsMap2) {
      if (!fieldsMap1.has(name)) {
        diff.addedFields.push(field)
      } else {
        const oldField = fieldsMap1.get(name)!
        if (JSON.stringify(oldField) !== JSON.stringify(field)) {
          diff.modifiedFields.push({ before: oldField, after: field })
        }
      }
    }

    for (const [name, field] of fieldsMap1) {
      if (!fieldsMap2.has(name)) {
        diff.removedFields.push(field)
        diff.isBreakingChange = true // 删除字段是破坏性变更
      }
    }

    // 检查破坏性变更
    if (diff.removedFields.length > 0) {
      diff.isBreakingChange = true
    }

    for (const mod of diff.modifiedFields) {
      // 类型变更是破坏性的
      if (mod.before.type !== mod.after.type) {
        diff.isBreakingChange = true
      }
      // nullable 从 true 变 false 是破坏性的
      if (mod.before.nullable && !mod.after.nullable) {
        diff.isBreakingChange = true
      }
    }

    return diff
  }

  /**
   * 在数据变更前自动创建 Schema 快照
   */
  async autoSnapshotBeforeSchemaChange(viewId: string): Promise<void> {
    const snapshot = await this.createSchemaSnapshot(viewId, 'system')

    // 给快照打上标签
    await db
      .updateTable('schema_snapshots')
      .set({
        // 标记为自动生成
        metadata: JSON.stringify({ auto_generated: true, reason: 'pre_change_backup' })
      })
      .where('id', '=', snapshot.id)
      .execute()

    console.log(`Auto schema snapshot created: ${snapshot.id}`)
  }
}
```

---

### 5. API 端点设计

```typescript
// src/routes/change-management.ts

export function changeManagementRouter(): Router {
  const r = Router()

  // 创建变更请求
  r.post('/api/changes', rbacGuard('changes', 'create'), async (req, res) => {
    const result = await changeManagementService.createChangeRequest(req.body)
    return res.status(201).json({ ok: true, data: result })
  })

  // 审批变更请求
  r.post('/api/changes/:id/approve', rbacGuard('changes', 'approve'), async (req, res) => {
    const userId = (req as any).user?.id
    const result = await changeManagementService.approveChangeRequest(
      req.params.id,
      userId,
      req.body.comment
    )
    return res.json({ ok: true, data: result })
  })

  // 拒绝变更请求
  r.post('/api/changes/:id/reject', rbacGuard('changes', 'approve'), async (req, res) => {
    const userId = (req as any).user?.id
    const result = await changeManagementService.rejectChangeRequest(
      req.params.id,
      userId,
      req.body.reason
    )
    return res.json({ ok: true, data: result })
  })

  // 部署变更
  r.post('/api/changes/:id/deploy', rbacGuard('changes', 'deploy'), async (req, res) => {
    const userId = (req as any).user?.id
    const result = await changeManagementService.deployChange(
      req.params.id,
      userId,
      { dryRun: req.body.dry_run, force: req.body.force }
    )
    return res.json({ ok: true, data: result })
  })

  // 回滚变更
  r.post('/api/changes/:id/rollback', rbacGuard('changes', 'deploy'), async (req, res) => {
    const userId = (req as any).user?.id
    const result = await changeManagementService.rollbackChange(
      req.params.id,
      userId,
      req.body.reason
    )
    return res.json({ ok: true, data: result })
  })

  // 一键回滚到稳定版本
  r.post('/api/views/:viewId/rollback-to-stable', rbacGuard('changes', 'deploy'), async (req, res) => {
    const userId = (req as any).user?.id
    const result = await changeManagementService.rollbackToLatestStable(
      req.params.viewId,
      userId,
      req.body.reason
    )
    return res.json({ ok: true, data: result })
  })

  // 快照标签管理
  r.patch('/api/snapshots/:id/tags', rbacGuard('snapshots', 'write'), async (req, res) => {
    const { add_tags, remove_tags } = req.body
    const result = await snapshotService.updateTags(req.params.id, add_tags, remove_tags)
    return res.json({ ok: true, data: result })
  })

  // 设置保护级别
  r.post('/api/snapshots/:id/protection', rbacGuard('snapshots', 'admin'), async (req, res) => {
    const { level, reason } = req.body
    const result = await protectionRuleService.setProtectionLevel(
      req.params.id,
      level,
      reason
    )
    return res.json({ ok: true, data: result })
  })

  // 查询变更历史
  r.get('/api/changes/history', rbacGuard('changes', 'read'), async (req, res) => {
    const history = await changeManagementService.getChangeHistory(req.query)
    return res.json({ ok: true, data: history })
  })

  // Schema 快照
  r.post('/api/schemas/:viewId/snapshot', rbacGuard('schemas', 'write'), async (req, res) => {
    const userId = (req as any).user?.id
    const result = await schemaSnapshotService.createSchemaSnapshot(req.params.viewId, userId)
    return res.json({ ok: true, data: result })
  })

  // Schema 对比
  r.get('/api/schemas/diff', rbacGuard('schemas', 'read'), async (req, res) => {
    const diff = await schemaSnapshotService.diffSchemas(
      String(req.query.schema1),
      String(req.query.schema2)
    )
    return res.json({ ok: true, data: diff })
  })

  return r
}
```

---

### 6. 指标体系

```typescript
// 新增指标
const changeRequestsCreatedTotal = new Counter({
  name: 'metasheet_change_requests_created_total',
  help: 'Total change requests created',
  labelNames: ['change_type', 'environment']
})

const changeApprovalsTotal = new Counter({
  name: 'metasheet_change_approvals_total',
  help: 'Total change approvals',
  labelNames: ['decision']
})

const changeDeploymentsTotal = new Counter({
  name: 'metasheet_change_deployments_total',
  help: 'Total change deployments',
  labelNames: ['result']
})

const changeDeploymentDuration = new Histogram({
  name: 'metasheet_change_deployment_seconds',
  help: 'Change deployment duration',
  buckets: [1, 5, 10, 30, 60, 120, 300]
})

const changeRollbacksTotal = new Counter({
  name: 'metasheet_change_rollbacks_total',
  help: 'Total change rollbacks'
})

const protectionRuleBlocksTotal = new Counter({
  name: 'metasheet_protection_rule_blocks_total',
  help: 'Operations blocked by protection rules',
  labelNames: ['rule_name', 'operation']
})

const schemaSnapshotsCreatedTotal = new Counter({
  name: 'metasheet_schema_snapshots_created_total',
  help: 'Total schema snapshots created'
})

const breakingSchemaChangesTotal = new Counter({
  name: 'metasheet_breaking_schema_changes_total',
  help: 'Total breaking schema changes detected'
})
```

---

## 🚦 Feature Flags & Rollback Strategy

### Feature Flags 设计

为确保新功能可安全回滚，所有 Sprint 2/3 功能都需要 Feature Flag 控制：

```typescript
// src/config/feature-flags.ts

interface FeatureFlags {
  // Sprint 2: Snapshot 标签
  enableSnapshotLabels: boolean
  enableProtectionRules: boolean
  enablePluginHealthMonitoring: boolean
  enableSLOManager: boolean

  // Sprint 3: 变更管理
  enableChangeManagement: boolean
  enableSchemaSnapshots: boolean
  enableAutoChangeNotes: boolean
  enableRiskAssessment: boolean

  // 子功能开关
  changeManagementMode: 'disabled' | 'readonly' | 'full'
  snapshotLabelMode: 'disabled' | 'readonly' | 'full'
}

const DEFAULT_FLAGS: FeatureFlags = {
  // Sprint 2 - 默认关闭，逐步启用
  enableSnapshotLabels: false,
  enableProtectionRules: false,
  enablePluginHealthMonitoring: false,
  enableSLOManager: false,

  // Sprint 3 - 默认关闭
  enableChangeManagement: false,
  enableSchemaSnapshots: false,
  enableAutoChangeNotes: false,
  enableRiskAssessment: false,

  // 模式控制
  changeManagementMode: 'disabled',
  snapshotLabelMode: 'disabled'
}

class FeatureFlagService {
  private flags: FeatureFlags

  constructor() {
    this.flags = this.loadFromConfig()
  }

  isEnabled(flag: keyof FeatureFlags): boolean {
    return !!this.flags[flag]
  }

  getMode(flag: 'changeManagementMode' | 'snapshotLabelMode'): string {
    return this.flags[flag]
  }

  // 运行时更新 (无需重启)
  updateFlag(flag: keyof FeatureFlags, value: any): void {
    this.flags[flag] = value
    this.persistToConfig()
    metrics.featureFlagChangedTotal.labels(flag, String(value)).inc()
  }
}
```

### 各功能关闭后行为

| 功能 | Feature Flag | 关闭后行为 |
|------|--------------|------------|
| **Snapshot 标签** | enableSnapshotLabels | tags 字段被忽略，API 正常但不处理标签 |
| **保护规则** | enableProtectionRules | 所有操作被允许，不检查保护规则 |
| **变更管理** | enableChangeManagement | 直接操作 API，不创建变更请求 |
| **Schema 快照** | enableSchemaSnapshots | Schema 变更不自动创建快照 |
| **风险评估** | enableRiskAssessment | 跳过风险评估，直接允许操作 |

### 模式详解

**changeManagementMode**:
- `disabled`: 完全禁用，API 隐藏，直接操作
- `readonly`: 只记录变更请求，不强制审批
- `full`: 完整流程，强制审批

**snapshotLabelMode**:
- `disabled`: 忽略所有标签操作
- `readonly`: 可以查看标签，不能修改
- `full`: 完整标签功能

### 数据库兼容性策略

所有新表/新字段必须向后兼容：

```sql
-- 新字段使用 DEFAULT 值，不破坏现有查询
ALTER TABLE snapshots
ADD COLUMN tags TEXT[] DEFAULT '{}',
ADD COLUMN protection_level TEXT DEFAULT 'normal';

-- 新表可以为空，不影响现有功能
CREATE TABLE IF NOT EXISTS change_requests (...);

-- 索引延迟创建，不阻塞写入
CREATE INDEX CONCURRENTLY idx_snapshots_tags ON snapshots USING GIN(tags);
```

### 回滚脚本

每个迁移都有对应的回滚脚本：

```sql
-- migrations/rollback/remove_snapshot_labels.sql
ALTER TABLE snapshots
DROP COLUMN IF EXISTS tags,
DROP COLUMN IF EXISTS protection_level;

DROP INDEX IF EXISTS idx_snapshots_tags;
DROP INDEX IF EXISTS idx_snapshots_protection;

-- 不删除数据，只删除结构
```

### 回滚检查清单

**场景: Sprint 2 功能回滚**

1. 更新 Feature Flags:
```bash
# 禁用所有 Sprint 2 功能
curl -X POST /api/admin/feature-flags \
  -d '{"enableSnapshotLabels": false, "enableProtectionRules": false}'
```

2. 验证系统行为:
```bash
# 确认 API 正常工作
curl /api/snapshots  # 应该正常返回，但没有 tags 字段
curl /api/plugins/health  # 返回 404 或 feature disabled
```

3. 如果需要完全移除:
```bash
# 运行回滚迁移 (可选)
pnpm db:migrate:rollback --to 20250116_snapshot_labels
```

4. 监控指标:
- 确认无错误率上升
- 确认性能恢复到基线
- 确认用户功能正常

**场景: Sprint 3 变更管理回滚**

```typescript
// 1. 切换到 readonly 模式 (保留记录但不强制)
featureFlagService.updateFlag('changeManagementMode', 'readonly')

// 2. 如果需要完全禁用
featureFlagService.updateFlag('enableChangeManagement', false)

// 3. 恢复直接操作 API
// 用户可以绕过变更请求直接操作
```

### 渐进式启用策略

**Week 1: 内部测试**
```typescript
// 只对内部用户启用
if (user.isInternalTester) {
  flags.enableSnapshotLabels = true
}
```

**Week 2: 小范围用户**
```typescript
// 10% 用户启用
if (hash(user.id) % 100 < 10) {
  flags.enableChangeManagement = true
}
```

**Week 3: 全量启用**
```typescript
// 默认启用，但保留快速回滚能力
flags.enableChangeManagement = true
flags.changeManagementMode = 'full'
```

### 监控和告警

```typescript
// Feature Flag 变更告警
const featureFlagChangedTotal = new Counter({
  name: 'metasheet_feature_flag_changed_total',
  help: 'Feature flag changes',
  labelNames: ['flag_name', 'new_value']
})

// 功能使用情况
const featureUsageTotal = new Counter({
  name: 'metasheet_feature_usage_total',
  help: 'Feature usage count',
  labelNames: ['feature', 'enabled']
})

// 回滚事件
const featureRollbackTotal = new Counter({
  name: 'metasheet_feature_rollback_total',
  help: 'Feature rollback events',
  labelNames: ['feature', 'reason']
})
```

---

## 📅 实施计划

### Phase A: 基础设施 (2-3 天)
- [ ] 数据库迁移脚本
- [ ] 标签和保护级别字段
- [ ] 变更请求表和审批表

### Phase B: 核心服务 (3-4 天)
- [ ] ChangeManagementService 基础实现
- [ ] ProtectionRuleService
- [ ] 风险评估和影响分析

### Phase C: API 和集成 (2-3 天)
- [ ] REST API 端点
- [ ] 通知集成 (Slack/Email)
- [ ] 审计日志记录

### Phase D: Schema 管理 (2-3 天)
- [ ] SchemaSnapshotService
- [ ] Schema diff 和验证
- [ ] 自动备份钩子

### Phase E: 指标和文档 (1-2 天)
- [ ] Prometheus 指标注册
- [ ] Grafana Dashboard
- [ ] 用户文档和操作手册

**总预估**: 10-15 天

---

## ✅ 验收标准

1. **变更可追溯**
   - 所有生产变更有变更请求记录
   - 完整的审批链
   - 自动生成变更说明

2. **快速回滚**
   - < 5 分钟恢复到稳定版本
   - 一键回滚操作可用
   - 回滚有完整审计

3. **保护机制**
   - 危险操作需要审批
   - 保护规则自动应用
   - 权限分级控制

4. **合规就绪**
   - SOC2 审计日志格式
   - ISO 27001 变更管理流程
   - 完整的证据链

---

## 🔮 未来扩展

- **多环境审批策略** - 不同环境不同审批人数
- **自动化测试集成** - 部署前自动运行测试套件
- **金丝雀发布** - 分阶段部署支持
- **合规报告生成** - 自动生成审计报告
- **变更日历** - 可视化变更计划

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
