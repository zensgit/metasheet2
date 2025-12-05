/**
 * ProtectionRuleService CRUD Tests
 * Sprint 2: Testing rule creation, update, deletion, and listing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProtectionRuleService } from '../../src/services/ProtectionRuleService'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn(),
    execute: vi.fn(),
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow: vi.fn(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    deleteFrom: vi.fn().mockReturnThis(),
  }
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    protectionRuleEvaluations: { labels: () => ({ inc: vi.fn() }) },
    protectionRuleBlocks: { labels: () => ({ inc: vi.fn() }) },
    protectionRuleEvaluationDuration: { labels: () => ({ observe: vi.fn() }) },
  }
}))

describe('ProtectionRuleService - CRUD Operations', () => {
  let service: ProtectionRuleService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new ProtectionRuleService()
    const { db } = await import('../../src/db/db')
    dbMock = db
  })

  describe('createRule', () => {
    it('should create a new protection rule', async () => {
      const mockRule = {
        id: 'rule-123',
        rule_name: 'Block Critical Deletes',
        target_type: 'snapshot',
        conditions: JSON.stringify({ all: [{ field: 'protection_level', operator: 'eq', value: 'critical' }] }),
        effects: JSON.stringify({ action: 'block', message: 'Cannot delete critical snapshots' }),
        priority: 100,
        is_active: true,
        version: 1,
        created_by: 'admin',
        created_at: new Date(),
        updated_at: new Date(),
        evaluation_count: 0
      }
      dbMock.executeTakeFirstOrThrow.mockResolvedValue(mockRule)

      const result = await service.createRule({
        rule_name: 'Block Critical Deletes',
        target_type: 'snapshot',
        conditions: { all: [{ field: 'protection_level', operator: 'eq', value: 'critical' }] },
        effects: { action: 'block', message: 'Cannot delete critical snapshots' },
        created_by: 'admin'
      })

      expect(result.rule_name).toBe('Block Critical Deletes')
      expect(dbMock.insertInto).toHaveBeenCalledWith('protection_rules')
    })

    it('should set default priority to 100 if not provided', async () => {
      const mockRule = {
        id: 'rule-123',
        rule_name: 'Test Rule',
        target_type: 'snapshot',
        conditions: JSON.stringify({ all: [] }),
        effects: JSON.stringify({ action: 'allow' }),
        priority: 100,
        is_active: true,
        version: 1,
        created_by: 'admin',
        created_at: new Date(),
        updated_at: new Date(),
        evaluation_count: 0
      }
      dbMock.executeTakeFirstOrThrow.mockResolvedValue(mockRule)

      await service.createRule({
        rule_name: 'Test Rule',
        target_type: 'snapshot',
        conditions: { all: [] },
        effects: { action: 'allow' },
        created_by: 'admin'
      })

      expect(dbMock.values).toHaveBeenCalledWith(expect.objectContaining({
        priority: 100
      }))
    })
  })

  describe('getRule', () => {
    it('should return a rule by id', async () => {
      const mockRule = {
        id: 'rule-123',
        rule_name: 'Test Rule',
        target_type: 'snapshot',
        conditions: JSON.stringify({ all: [{ field: 'tags', operator: 'contains', value: 'stable' }] }),
        effects: JSON.stringify({ action: 'block' }),
        priority: 50,
        is_active: true,
        version: 1,
        created_by: 'admin',
        created_at: new Date(),
        updated_at: new Date(),
        evaluation_count: 5
      }
      dbMock.executeTakeFirst.mockResolvedValue(mockRule)

      const result = await service.getRule('rule-123')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('rule-123')
      expect(result?.conditions).toEqual({ all: [{ field: 'tags', operator: 'contains', value: 'stable' }] })
    })

    it('should return null for non-existent rule', async () => {
      dbMock.executeTakeFirst.mockResolvedValue(null)

      const result = await service.getRule('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('updateRule', () => {
    it('should update rule properties', async () => {
      const existingRule = {
        id: 'rule-123',
        rule_name: 'Old Name',
        target_type: 'snapshot',
        conditions: JSON.stringify({ all: [] }),
        effects: JSON.stringify({ action: 'allow' }),
        priority: 10,
        is_active: true,
        version: 1,
        created_by: 'admin',
        created_at: new Date(),
        updated_at: new Date(),
        evaluation_count: 0
      }
      dbMock.executeTakeFirst.mockResolvedValue(existingRule)

      const updatedRule = { ...existingRule, rule_name: 'New Name', version: 2 }
      dbMock.executeTakeFirstOrThrow.mockResolvedValue(updatedRule)

      const result = await service.updateRule('rule-123', {
        rule_name: 'New Name'
      })

      expect(result.rule_name).toBe('New Name')
      expect(result.version).toBe(2)
    })

    it('should increment version on update', async () => {
      const existingRule = {
        id: 'rule-123',
        rule_name: 'Test',
        target_type: 'snapshot',
        conditions: JSON.stringify({ all: [] }),
        effects: JSON.stringify({ action: 'allow' }),
        priority: 10,
        is_active: true,
        version: 3,
        created_by: 'admin',
        created_at: new Date(),
        updated_at: new Date(),
        evaluation_count: 0
      }
      dbMock.executeTakeFirst.mockResolvedValue(existingRule)
      dbMock.executeTakeFirstOrThrow.mockResolvedValue({ ...existingRule, version: 4 })

      const result = await service.updateRule('rule-123', { priority: 20 })

      expect(result.version).toBe(4)
    })

    it('should throw error if rule not found', async () => {
      dbMock.executeTakeFirst.mockResolvedValue(null)

      await expect(service.updateRule('nonexistent', { rule_name: 'New Name' }))
        .rejects.toThrow('Rule not found')
    })
  })

  describe('deleteRule', () => {
    it('should delete an existing rule', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.deleteRule('rule-123')

      expect(dbMock.deleteFrom).toHaveBeenCalledWith('protection_rules')
      expect(dbMock.where).toHaveBeenCalledWith('id', '=', 'rule-123')
    })
  })

  describe('listRules', () => {
    it('should return all rules with default options', async () => {
      const mockRules = [
        {
          id: 'rule-1',
          rule_name: 'Rule 1',
          target_type: 'snapshot',
          conditions: JSON.stringify({ all: [] }),
          effects: JSON.stringify({ action: 'allow' }),
          priority: 100,
          is_active: true,
          version: 1,
          created_by: 'admin',
          created_at: new Date(),
          updated_at: new Date(),
          evaluation_count: 10
        },
        {
          id: 'rule-2',
          rule_name: 'Rule 2',
          target_type: 'snapshot',
          conditions: JSON.stringify({ all: [] }),
          effects: JSON.stringify({ action: 'block' }),
          priority: 50,
          is_active: true,
          version: 1,
          created_by: 'admin',
          created_at: new Date(),
          updated_at: new Date(),
          evaluation_count: 5
        }
      ]
      dbMock.execute.mockResolvedValue(mockRules)

      const result = await service.listRules()

      expect(result).toHaveLength(2)
      expect(dbMock.orderBy).toHaveBeenCalledWith('priority', 'desc')
    })

    it('should filter by target_type', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.listRules({ target_type: 'plugin' })

      expect(dbMock.where).toHaveBeenCalledWith('target_type', '=', 'plugin')
    })

    it('should filter by is_active', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.listRules({ is_active: true })

      expect(dbMock.where).toHaveBeenCalledWith('is_active', '=', true)
    })

    it('should return empty array when no rules exist', async () => {
      dbMock.execute.mockResolvedValue([])

      const result = await service.listRules()

      expect(result).toEqual([])
      expect(dbMock.selectFrom).toHaveBeenCalledWith('protection_rules')
    })
  })
})

describe('ProtectionRuleService - Rule Evaluation', () => {
  let service: ProtectionRuleService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new ProtectionRuleService()
    const { db } = await import('../../src/db/db')
    dbMock = db
  })

  describe('evaluateRules', () => {
    it('should return matched: false when no rules match', async () => {
      dbMock.execute.mockResolvedValue([])

      const result = await service.evaluateRules({
        entity_type: 'snapshot',
        entity_id: 'snap-1',
        operation: 'delete',
        properties: { tags: ['test'], protection_level: 'normal' }
      })

      expect(result.matched).toBe(false)
    })

    it('should return matched: true with effects when rule matches', async () => {
      const mockRule = {
        id: 'rule-1',
        rule_name: 'Block Critical',
        target_type: 'snapshot',
        conditions: JSON.stringify({ all: [{ field: 'protection_level', operator: 'eq', value: 'critical' }] }),
        effects: JSON.stringify({ action: 'block', message: 'Cannot modify critical snapshots' }),
        priority: 100,
        is_active: true,
        version: 1,
        created_by: 'admin',
        created_at: new Date(),
        updated_at: new Date(),
        evaluation_count: 0
      }
      dbMock.execute.mockResolvedValue([mockRule])

      const result = await service.evaluateRules({
        entity_type: 'snapshot',
        entity_id: 'snap-1',
        operation: 'delete',
        properties: { protection_level: 'critical' }
      })

      expect(result.matched).toBe(true)
      expect(result.rule_name).toBe('Block Critical')
      expect(result.effects?.action).toBe('block')
    })

    it('should respect rule priority (higher priority evaluated first)', async () => {
      const mockRules = [
        {
          id: 'rule-low',
          rule_name: 'Low Priority Allow',
          target_type: 'snapshot',
          conditions: JSON.stringify({ all: [{ field: 'tags', operator: 'contains', value: 'test' }] }),
          effects: JSON.stringify({ action: 'allow' }),
          priority: 10,
          is_active: true,
          version: 1,
          created_by: 'admin',
          created_at: new Date(),
          updated_at: new Date(),
          evaluation_count: 0
        },
        {
          id: 'rule-high',
          rule_name: 'High Priority Block',
          target_type: 'snapshot',
          conditions: JSON.stringify({ all: [{ field: 'tags', operator: 'contains', value: 'test' }] }),
          effects: JSON.stringify({ action: 'block' }),
          priority: 100,
          is_active: true,
          version: 1,
          created_by: 'admin',
          created_at: new Date(),
          updated_at: new Date(),
          evaluation_count: 0
        }
      ]
      // Mock returns rules ordered by priority desc (100 first)
      dbMock.execute.mockResolvedValue([mockRules[1], mockRules[0]])

      const result = await service.evaluateRules({
        entity_type: 'snapshot',
        entity_id: 'snap-1',
        operation: 'delete',
        properties: { tags: ['test'] }
      })

      expect(result.rule_name).toBe('High Priority Block')
      expect(result.effects?.action).toBe('block')
    })

    it('should only evaluate active rules', async () => {
      // Mock returns only active rules (DB already filters)
      dbMock.execute.mockResolvedValue([])

      await service.evaluateRules({
        entity_type: 'snapshot',
        entity_id: 'snap-1',
        operation: 'delete',
        properties: {}
      })

      expect(dbMock.where).toHaveBeenCalledWith('is_active', '=', true)
    })
  })
})
