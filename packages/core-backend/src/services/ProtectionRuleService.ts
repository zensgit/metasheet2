/**
 * Protection Rule Service
 * Sprint 2: Snapshot Protection System
 *
 * Provides rule-based protection evaluation engine with:
 * - CRUD operations for protection rules
 * - Condition matching (tags_contain, protection_level, etc.)
 * - Effect application (block, elevate_risk, require_approval)
 * - Priority-based rule execution
 * - Audit logging for rule evaluations
 */

import { db } from '../db/db'
import { sql } from 'kysely'
import type { ProtectionRulesTable } from '../db/types'
import type { Selectable } from 'kysely'
import { Logger } from '../core/logger'
import { metrics } from '../metrics/metrics'
import crypto from 'crypto'

// ============================================
// TYPE DEFINITIONS
// ============================================

// Type for database row from protection_rules table
type ProtectionRuleRow = Selectable<ProtectionRulesTable>

export interface ProtectionRule {
  id: string
  rule_name: string
  description?: string
  target_type: 'snapshot' | 'plugin' | 'schema' | 'workflow'
  conditions: RuleConditions
  effects: RuleEffects
  priority: number
  is_active: boolean
  version: number
  created_by: string
  created_at: Date
  updated_at: Date
  last_evaluated_at?: Date
  evaluation_count: number
}

export interface RuleConditions {
  all?: RuleCondition[]  // AND logic
  any?: RuleCondition[]  // OR logic
  not?: RuleCondition    // NOT logic
}

export interface RuleCondition {
  field: string
  operator: 'eq' | 'ne' | 'contains' | 'not_contains' | 'in' | 'not_in' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists' | 'not_exists'
  value?: unknown
}

export interface RuleEffects {
  action: 'allow' | 'block' | 'elevate_risk' | 'require_approval'
  risk_level?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  message?: string
  require_typed_confirmation?: boolean
  confirmation_text?: string
  metadata?: Record<string, unknown>
}

export interface RuleEvaluationContext {
  entity_type: 'snapshot' | 'plugin' | 'schema' | 'workflow'
  entity_id: string
  operation: string
  properties: Record<string, unknown>
  user_id?: string
}

export interface RuleEvaluationResult {
  matched: boolean
  rule_id?: string
  rule_name?: string
  effects?: RuleEffects
  execution_time_ms: number
}

export interface CreateRuleOptions {
  rule_name: string
  description?: string
  target_type: 'snapshot' | 'plugin' | 'schema' | 'workflow'
  conditions: RuleConditions
  effects: RuleEffects
  priority?: number
  is_active?: boolean
  created_by: string
}

export interface UpdateRuleOptions {
  rule_name?: string
  description?: string
  conditions?: RuleConditions
  effects?: RuleEffects
  priority?: number
  is_active?: boolean
}

// Type guard to check if value is a JSON string
function isJsonString(value: unknown): value is string {
  return typeof value === 'string'
}

// Type guard for RuleConditions
function isRuleConditions(value: unknown): value is RuleConditions {
  return typeof value === 'object' && value !== null
}

// Type guard for RuleEffects
function isRuleEffects(value: unknown): value is RuleEffects {
  return typeof value === 'object' && value !== null && 'action' in value
}

// Helper to parse JSON if needed
function parseJsonField<T>(value: unknown): T {
  if (isJsonString(value)) {
    return JSON.parse(value) as T
  }
  return value as T
}

// ============================================
// SERVICE IMPLEMENTATION
// ============================================

export class ProtectionRuleService {
  private logger: Logger

  constructor() {
    this.logger = new Logger('ProtectionRuleService')
  }

  /**
   * Create a new protection rule
   */
  async createRule(options: CreateRuleOptions): Promise<ProtectionRule> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Creating protection rule: ${options.rule_name}`)

    try {
      // Avoid double JSON stringify: if client accidentally sends stringified JSON, parse first
      const normalizedConditions = isJsonString(options.conditions)
        ? JSON.parse(options.conditions)
        : options.conditions
      const normalizedEffects = isJsonString(options.effects)
        ? JSON.parse(options.effects)
        : options.effects

      if (!isRuleConditions(normalizedConditions)) {
        throw new Error('conditions must be a JSON object')
      }
      if (!isRuleEffects(normalizedEffects)) {
        throw new Error('effects must be a JSON object')
      }

      const rule = await db
        .insertInto('protection_rules')
        .values({
          id: crypto.randomUUID(),
          rule_name: options.rule_name,
          description: options.description || null,
          target_type: options.target_type,
          conditions: JSON.stringify(normalizedConditions),
          effects: JSON.stringify(normalizedEffects),
          priority: options.priority || 100,
          is_active: options.is_active !== undefined ? options.is_active : true,
          version: 1,
          created_by: options.created_by,
          evaluation_count: 0
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      this.logger.info(`Protection rule created: ${rule.id}`)

      // conditions/effects now stored as JSONB; if driver returns object keep as-is
      const parsedConditions = parseJsonField<RuleConditions>(rule.conditions)
      const parsedEffects = parseJsonField<RuleEffects>(rule.effects)

      return {
        ...rule,
        conditions: parsedConditions,
        effects: parsedEffects,
        created_at: new Date(rule.created_at),
        updated_at: new Date(rule.updated_at),
        last_evaluated_at: rule.last_evaluated_at ? new Date(rule.last_evaluated_at) : undefined
      } as ProtectionRule
    } catch (error) {
      this.logger.error('Failed to create protection rule', error as Error)
      throw error
    }
  }

  /**
   * Update an existing protection rule
   */
  async updateRule(ruleId: string, options: UpdateRuleOptions): Promise<ProtectionRule> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Updating protection rule: ${ruleId}`)

    try {
      // Get current rule to increment version
      const currentRule = await this.getRule(ruleId)
      if (!currentRule) {
        throw new Error(`Rule not found: ${ruleId}`)
      }

      // Type for database update payload - conditions/effects are JSON strings for insert/update
      type UpdateData = {
        updated_at: Date
        rule_name?: string
        description?: string | undefined
        conditions?: string  // JSONColumnType expects string for insert/update
        version?: number
        effects?: string     // JSONColumnType expects string for insert/update
        priority?: number
        is_active?: boolean
      }

      const updateData: UpdateData = {
        updated_at: new Date()
      }

      if (options.rule_name !== undefined) updateData.rule_name = options.rule_name
      if (options.description !== undefined) updateData.description = options.description
      if (options.conditions !== undefined) {
        const normalizedConditions = isJsonString(options.conditions)
          ? JSON.parse(options.conditions)
          : options.conditions
        updateData.conditions = JSON.stringify(normalizedConditions)
        updateData.version = currentRule.version + 1
      }
      if (options.effects !== undefined) {
        const normalizedEffects = isJsonString(options.effects)
          ? JSON.parse(options.effects)
          : options.effects
        updateData.effects = JSON.stringify(normalizedEffects)
      }
      if (options.priority !== undefined) updateData.priority = options.priority
      if (options.is_active !== undefined) updateData.is_active = options.is_active

      const rule = await db
        .updateTable('protection_rules')
        .set(updateData)
        .where('id', '=', ruleId)
        .returningAll()
        .executeTakeFirstOrThrow()

      this.logger.info(`Protection rule updated: ${rule.id}`)

      const parsedConditions = parseJsonField<RuleConditions>(rule.conditions)
      const parsedEffects = parseJsonField<RuleEffects>(rule.effects)

      return {
        ...rule,
        conditions: parsedConditions,
        effects: parsedEffects,
        created_at: new Date(rule.created_at),
        updated_at: new Date(rule.updated_at),
        last_evaluated_at: rule.last_evaluated_at ? new Date(rule.last_evaluated_at) : undefined
      } as ProtectionRule
    } catch (error) {
      this.logger.error('Failed to update protection rule', error as Error)
      throw error
    }
  }

  /**
   * Delete a protection rule
   */
  async deleteRule(ruleId: string): Promise<void> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Deleting protection rule: ${ruleId}`)

    try {
      await db
        .deleteFrom('protection_rules')
        .where('id', '=', ruleId)
        .executeTakeFirstOrThrow()

      this.logger.info(`Protection rule deleted: ${ruleId}`)
    } catch (error) {
      this.logger.error('Failed to delete protection rule', error as Error)
      throw error
    }
  }

  /**
   * Get a single protection rule by ID
   */
  async getRule(ruleId: string): Promise<ProtectionRule | null> {
    if (!db) {
      throw new Error('Database not available')
    }

    try {
      const rule = await db
        .selectFrom('protection_rules')
        .selectAll()
        .where('id', '=', ruleId)
        .executeTakeFirst()

      if (!rule) {
        return null
      }

      // Parse JSON fields - they may be returned as strings or objects depending on driver
      const parsedConditions = parseJsonField<RuleConditions>(rule.conditions)
      const parsedEffects = parseJsonField<RuleEffects>(rule.effects)

      return {
        ...rule,
        conditions: parsedConditions,
        effects: parsedEffects,
        created_at: new Date(rule.created_at),
        updated_at: new Date(rule.updated_at),
        last_evaluated_at: rule.last_evaluated_at ? new Date(rule.last_evaluated_at) : undefined
      } as ProtectionRule
    } catch (error) {
      this.logger.error('Failed to get protection rule', error as Error)
      throw error
    }
  }

  /**
   * List all protection rules with optional filtering
   */
  async listRules(options?: {
    target_type?: string
    is_active?: boolean
  }): Promise<ProtectionRule[]> {
    if (!db) {
      throw new Error('Database not available')
    }

    try {
      let query = db
        .selectFrom('protection_rules')
        .selectAll()
        .orderBy('priority', 'desc')
        .orderBy('created_at', 'desc')

      if (options?.target_type) {
        query = query.where('target_type', '=', options.target_type as 'snapshot' | 'plugin' | 'schema' | 'workflow')
      }

      if (options?.is_active !== undefined) {
        query = query.where('is_active', '=', options.is_active)
      }

      const rules = await query.execute()

      return rules.map((rule: ProtectionRuleRow) => {
        const parsedConditions = parseJsonField<RuleConditions>(rule.conditions)
        const parsedEffects = parseJsonField<RuleEffects>(rule.effects)

        // Convert Timestamp (from Kysely) to Date - Timestamp is Date at runtime
        const createdAt = rule.created_at instanceof Date ? rule.created_at : new Date(String(rule.created_at))
        const updatedAt = rule.updated_at instanceof Date ? rule.updated_at : new Date(String(rule.updated_at))
        const lastEvaluatedAt = rule.last_evaluated_at
          ? (rule.last_evaluated_at instanceof Date ? rule.last_evaluated_at : new Date(String(rule.last_evaluated_at)))
          : undefined

        return {
          ...rule,
          conditions: parsedConditions,
          effects: parsedEffects,
          created_at: createdAt,
          updated_at: updatedAt,
          last_evaluated_at: lastEvaluatedAt
        }
      }) as ProtectionRule[]
    } catch (error) {
      this.logger.error('Failed to list protection rules', error as Error)
      throw error
    }
  }

  /**
   * Evaluate protection rules against a context
   * Returns the first matching rule with highest priority
   */
  async evaluateRules(context: RuleEvaluationContext): Promise<RuleEvaluationResult> {
    const startTime = Date.now()

    if (!db) {
      throw new Error('Database not available')
    }

    try {
      // Get active rules for this entity type, ordered by priority
      const rules = await this.listRules({
        target_type: context.entity_type,
        is_active: true
      })

      this.logger.debug(`Evaluating ${rules.length} rules for ${context.entity_type} ${context.entity_id}`)

      // Evaluate rules in priority order (already sorted in listRules)
      for (const rule of rules) {
        const matched = this.evaluateConditions(rule.conditions, context.properties)

        // Log execution
        await this.logRuleExecution({
          rule_id: rule.id,
          rule_version: rule.version,
          entity_type: context.entity_type,
          entity_id: context.entity_id,
          operation: context.operation,
          matched,
          effect_applied: matched ? rule.effects : null,
          execution_time_ms: Date.now() - startTime
        })

        // Update rule evaluation stats
        await this.updateRuleStats(rule.id)

        if (matched) {
          const executionTime = Date.now() - startTime

          // Record metrics
          try {
            metrics.protectionRuleEvaluationsTotal
              .labels(rule.rule_name, matched ? 'matched' : 'not_matched')
              .inc()

            if (rule.effects.action === 'block') {
              metrics.protectionRuleBlocksTotal
                .labels(rule.rule_name, context.operation)
                .inc()
            }
          } catch { /* metrics unavailable */ }

          this.logger.info(
            `Rule matched: ${rule.rule_name} (${rule.id}) for ${context.entity_type} ${context.entity_id}, action: ${rule.effects.action}`
          )

          return {
            matched: true,
            rule_id: rule.id,
            rule_name: rule.rule_name,
            effects: rule.effects,
            execution_time_ms: executionTime
          }
        }
      }

      const executionTime = Date.now() - startTime

      // No rules matched
      this.logger.debug(`No rules matched for ${context.entity_type} ${context.entity_id}`)

      return {
        matched: false,
        execution_time_ms: executionTime
      }
    } catch (error) {
      this.logger.error('Failed to evaluate protection rules', error as Error)
      throw error
    }
  }

  /**
   * Evaluate rule conditions against entity properties
   */
  private evaluateConditions(conditions: RuleConditions, properties: Record<string, unknown>): boolean {
    // Handle composite conditions
    if (conditions.all) {
      return conditions.all.every(condition => this.evaluateCondition(condition, properties))
    }

    if (conditions.any) {
      return conditions.any.some(condition => this.evaluateCondition(condition, properties))
    }

    if (conditions.not) {
      return !this.evaluateCondition(conditions.not, properties)
    }

    return false
  }

  /**
   * Evaluate a single condition
   */
  private evaluateCondition(condition: RuleCondition, properties: Record<string, unknown>): boolean {
    const fieldValue = properties[condition.field]

    switch (condition.operator) {
      case 'eq':
        return fieldValue === condition.value

      case 'ne':
        return fieldValue !== condition.value

      case 'contains':
        if (Array.isArray(fieldValue)) {
          return fieldValue.includes(condition.value)
        }
        if (typeof fieldValue === 'string') {
          return fieldValue.includes(condition.value as string)
        }
        return false

      case 'not_contains':
        if (Array.isArray(fieldValue)) {
          return !fieldValue.includes(condition.value)
        }
        if (typeof fieldValue === 'string') {
          return !fieldValue.includes(condition.value as string)
        }
        return true

      case 'in':
        if (!Array.isArray(condition.value)) {
          return false
        }
        return condition.value.includes(fieldValue)

      case 'not_in':
        if (!Array.isArray(condition.value)) {
          return true
        }
        return !condition.value.includes(fieldValue)

      case 'gt':
        if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
          return fieldValue > condition.value
        }
        return false

      case 'lt':
        if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
          return fieldValue < condition.value
        }
        return false

      case 'gte':
        if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
          return fieldValue >= condition.value
        }
        return false

      case 'lte':
        if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
          return fieldValue <= condition.value
        }
        return false

      case 'exists':
        return fieldValue !== undefined && fieldValue !== null

      case 'not_exists':
        return fieldValue === undefined || fieldValue === null

      default:
        this.logger.warn(`Unknown operator: ${condition.operator}`)
        return false
    }
  }

  /**
   * Log rule execution to audit table
   */
  private async logRuleExecution(data: {
    rule_id: string
    rule_version: number
    entity_type: string
    entity_id: string
    operation: string
    matched: boolean
    effect_applied: RuleEffects | null
    execution_time_ms: number
  }): Promise<void> {
    if (!db) {
      return
    }

    try {
      // For JSONColumnType, insert expects string. For null, we still need to pass the value
      // but the type system expects string. Use type assertion for null case.
      const effectAppliedValue = data.effect_applied
        ? JSON.stringify(data.effect_applied)
        : (null as unknown as string)

      await db
        .insertInto('rule_execution_log')
        .values({
          id: crypto.randomUUID(),
          rule_id: data.rule_id,
          rule_version: data.rule_version,
          entity_type: data.entity_type,
          entity_id: data.entity_id,
          operation: data.operation,
          matched: data.matched,
          effect_applied: effectAppliedValue,
          execution_time_ms: data.execution_time_ms
        })
        .execute()
    } catch (error) {
      this.logger.error('Failed to log rule execution', error as Error)
      // Don't throw - logging failure shouldn't break rule evaluation
    }
  }

  /**
   * Update rule evaluation statistics
   */
  private async updateRuleStats(ruleId: string): Promise<void> {
    if (!db) {
      return
    }

    try {
      await db
        .updateTable('protection_rules')
        .set({
          last_evaluated_at: new Date(),
          // Use sql template for incrementing the evaluation count
          evaluation_count: sql`evaluation_count + 1`
        })
        .where('id', '=', ruleId)
        .execute()
    } catch (error) {
      this.logger.error('Failed to update rule stats', error as Error)
      // Don't throw - stats update failure shouldn't break rule evaluation
    }
  }
}

// Export singleton instance
export const protectionRuleService = new ProtectionRuleService()
