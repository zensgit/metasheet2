/**
 * Snapshot Protection System E2E Tests
 * Sprint 2: Tests for snapshot labeling, protection rules, and SafetyGuard integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { snapshotService } from '../../src/services/SnapshotService'
import { protectionRuleService } from '../../src/services/ProtectionRuleService'
import net from 'net'
import type { ProtectionRule } from '../../src/services/ProtectionRuleService'

describe('Snapshot Protection System E2E', () => {
  let server: MetaSheetServer
  let baseUrl = ''
  const testUserId = 'test-user-snapshot-protection'
  let testSnapshotId: string
  let testRuleId: string

  beforeAll(async () => {
    // Check if port is available
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return

    // Start test server
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1'
    })
    await server.start()
    const address = server.getAddress()
    if (!address || !address.port) return
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    // Cleanup test data
    if (testSnapshotId) {
      try {
        await snapshotService.deleteSnapshot(testSnapshotId)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (testRuleId) {
      try {
        await protectionRuleService.deleteRule(testRuleId)
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  beforeEach(async () => {
    // Create a test snapshot for each test
    if (!testSnapshotId) {
      const snapshot = await snapshotService.createSnapshot({
        view_id: 'test-view-protection',
        name: 'Test Snapshot for Protection',
        description: 'Snapshot for testing protection features',
        snapshot_data: { test: 'data' },
        created_by: testUserId,
        tags: [],
        protection_level: 'normal'
      })
      testSnapshotId = snapshot.id
    }
  })

  describe('Snapshot Labeling API', () => {
    it('should add tags to snapshot', async () => {
      if (!baseUrl || !testSnapshotId) return

      const response = await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/tags`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          add: ['production', 'v1.0.0', 'stable']
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshot.tags).toContain('production')
      expect(result.snapshot.tags).toContain('v1.0.0')
      expect(result.snapshot.tags).toContain('stable')
    })

    it('should remove tags from snapshot', async () => {
      if (!baseUrl || !testSnapshotId) return

      // First add some tags
      await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/tags`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          add: ['temp', 'testing', 'removable']
        })
      })

      // Then remove one
      const response = await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/tags`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          remove: ['removable']
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshot.tags).not.toContain('removable')
      expect(result.snapshot.tags).toContain('temp')
      expect(result.snapshot.tags).toContain('testing')
    })

    it('should set protection level to protected', async () => {
      if (!baseUrl || !testSnapshotId) return

      const response = await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/protection`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          level: 'protected'
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshot.protection_level).toBe('protected')
    })

    it('should set protection level to critical', async () => {
      if (!baseUrl || !testSnapshotId) return

      const response = await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/protection`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          level: 'critical'
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshot.protection_level).toBe('critical')
    })

    it('should reject invalid protection level', async () => {
      if (!baseUrl || !testSnapshotId) return

      const response = await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/protection`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          level: 'invalid-level'
        })
      })

      expect(response.status).toBe(400)
      const result = await response.json()
      expect(result.success).toBe(false)
    })

    it('should set release channel', async () => {
      if (!baseUrl || !testSnapshotId) return

      const response = await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/release-channel`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          channel: 'stable'
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshot.release_channel).toBe('stable')
    })

    it('should query snapshots by tags', async () => {
      if (!baseUrl || !testSnapshotId) return

      // Add specific tags
      await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/tags`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          add: ['query-test', 'findable']
        })
      })

      const response = await fetch(`${baseUrl}/api/snapshots?tags=query-test,findable`, {
        headers: {
          'x-user-id': testUserId
        }
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshots.length).toBeGreaterThan(0)
      expect(result.snapshots.some((s: any) => s.id === testSnapshotId)).toBe(true)
    })

    it('should query snapshots by protection level', async () => {
      if (!baseUrl || !testSnapshotId) return

      // Set protection level
      await fetch(`${baseUrl}/api/snapshots/${testSnapshotId}/protection`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({ level: 'critical' })
      })

      const response = await fetch(`${baseUrl}/api/snapshots?protection_level=critical`, {
        headers: { 'x-user-id': testUserId }
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.snapshots.some((s: any) => s.id === testSnapshotId)).toBe(true)
    })
  })

  describe('Protection Rules API', () => {
    it('should create a protection rule', async () => {
      if (!baseUrl) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          rule_name: 'Block Production Snapshot Deletion',
          description: 'Prevent deletion of snapshots tagged as production',
          target_type: 'snapshot',
          conditions: {
            type: 'all',
            conditions: [
              {
                field: 'tags',
                operator: 'contains',
                value: 'production'
              }
            ]
          },
          effects: {
            action: 'block',
            message: 'Cannot delete production snapshots'
          },
          priority: 100,
          is_active: true
        })
      })

      expect(response.status).toBe(201)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rule).toBeDefined()
      expect(result.rule.rule_name).toBe('Block Production Snapshot Deletion')
      testRuleId = result.rule.id
    })

    it('should list protection rules', async () => {
      if (!baseUrl) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules`, {
        headers: { 'x-user-id': testUserId }
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(Array.isArray(result.rules)).toBe(true)
    })

    it('should filter rules by target_type', async () => {
      if (!baseUrl) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules?target_type=snapshot`, {
        headers: { 'x-user-id': testUserId }
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rules.every((r: any) => r.target_type === 'snapshot')).toBe(true)
    })

    it('should get a single protection rule', async () => {
      if (!baseUrl || !testRuleId) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules/${testRuleId}`, {
        headers: { 'x-user-id': testUserId }
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rule.id).toBe(testRuleId)
    })

    it('should update a protection rule', async () => {
      if (!baseUrl || !testRuleId) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules/${testRuleId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          description: 'Updated description for production snapshot protection',
          priority: 200
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rule.description).toBe('Updated description for production snapshot protection')
      expect(result.rule.priority).toBe(200)
    })

    it('should deactivate a protection rule', async () => {
      if (!baseUrl || !testRuleId) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules/${testRuleId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          is_active: false
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rule.is_active).toBe(false)
    })

    it('should evaluate rules (dry-run)', async () => {
      if (!baseUrl || !testRuleId) return

      // First reactivate the rule
      await fetch(`${baseUrl}/api/admin/safety/rules/${testRuleId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({ is_active: true })
      })

      // Evaluate rule against a snapshot with production tag
      const response = await fetch(`${baseUrl}/api/admin/safety/rules/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          entity_type: 'snapshot',
          entity_id: testSnapshotId,
          operation: 'delete',
          properties: {
            tags: ['production', 'v1.0.0'],
            protection_level: 'protected'
          }
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.result.matched).toBe(true)
      expect(result.result.effects.action).toBe('block')
    })

    it('should not match when conditions are not met', async () => {
      if (!baseUrl || !testRuleId) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          entity_type: 'snapshot',
          entity_id: testSnapshotId,
          operation: 'delete',
          properties: {
            tags: ['development', 'testing'],
            protection_level: 'normal'
          }
        })
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      // Should not match because no 'production' tag
      expect(result.result.matched).toBe(false)
    })
  })

  describe('Protected Snapshot Cleanup', () => {
    it('should skip protected snapshots during cleanup', async () => {
      if (!testSnapshotId) return

      // Set snapshot to protected
      await snapshotService.setProtectionLevel(testSnapshotId, 'protected', testUserId)

      // Mark snapshot as expired
      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      await snapshotService.updateSnapshot(testSnapshotId, {
        expires_at: yesterday
      })

      // Run cleanup
      const result = await snapshotService.cleanupExpired()

      // Verify protected snapshot was skipped
      expect(result.skipped).toBeGreaterThan(0)

      // Verify snapshot still exists
      const snapshot = await snapshotService.getSnapshot(testSnapshotId)
      expect(snapshot).toBeDefined()
      expect(snapshot.protection_level).toBe('protected')
    })

    it('should skip critical snapshots during cleanup', async () => {
      if (!testSnapshotId) return

      // Set snapshot to critical
      await snapshotService.setProtectionLevel(testSnapshotId, 'critical', testUserId)

      // Mark snapshot as expired
      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      await snapshotService.updateSnapshot(testSnapshotId, {
        expires_at: yesterday
      })

      // Run cleanup
      const result = await snapshotService.cleanupExpired()

      // Verify critical snapshot was skipped
      expect(result.skipped).toBeGreaterThan(0)

      // Verify snapshot still exists
      const snapshot = await snapshotService.getSnapshot(testSnapshotId)
      expect(snapshot).toBeDefined()
      expect(snapshot.protection_level).toBe('critical')
    })
  })

  describe('SafetyGuard Integration', () => {
    it('should block operations based on protection rules', async () => {
      if (!testSnapshotId || !testRuleId) return

      // Add production tag to snapshot
      await snapshotService.addTags(testSnapshotId, ['production'], testUserId)

      // Ensure rule is active
      await protectionRuleService.updateRule(testRuleId, { is_active: true })

      // Attempt to evaluate the rule through protection service
      const result = await protectionRuleService.evaluateRules({
        entity_type: 'snapshot',
        entity_id: testSnapshotId,
        operation: 'delete',
        properties: {
          tags: ['production']
        }
      })

      expect(result.matched).toBe(true)
      expect(result.effects?.action).toBe('block')
      expect(result.rule_name).toBe('Block Production Snapshot Deletion')
    })

    it('should create risk elevation rule', async () => {
      if (!baseUrl) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          rule_name: 'Elevate Risk for Beta Snapshots',
          description: 'Require confirmation for beta snapshot operations',
          target_type: 'snapshot',
          conditions: {
            type: 'all',
            conditions: [
              {
                field: 'release_channel',
                operator: 'eq',
                value: 'beta'
              }
            ]
          },
          effects: {
            action: 'elevate_risk',
            risk_level: 'high',
            message: 'Beta snapshots require extra caution'
          },
          priority: 50,
          is_active: true
        })
      })

      expect(response.status).toBe(201)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rule.effects.action).toBe('elevate_risk')
      expect(result.rule.effects.risk_level).toBe('high')

      // Cleanup
      if (result.rule?.id) {
        await protectionRuleService.deleteRule(result.rule.id)
      }
    })

    it('should create approval requirement rule', async () => {
      if (!baseUrl) return

      const response = await fetch(`${baseUrl}/api/admin/safety/rules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': testUserId
        },
        body: JSON.stringify({
          rule_name: 'Require Approval for Critical Snapshots',
          description: 'Critical snapshots need double confirmation',
          target_type: 'snapshot',
          conditions: {
            type: 'all',
            conditions: [
              {
                field: 'protection_level',
                operator: 'eq',
                value: 'critical'
              }
            ]
          },
          effects: {
            action: 'require_approval',
            approval_level: 'admin',
            message: 'This operation requires admin approval'
          },
          priority: 150,
          is_active: true
        })
      })

      expect(response.status).toBe(201)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.rule.effects.action).toBe('require_approval')
      expect(result.rule.effects.approval_level).toBe('admin')

      // Cleanup
      if (result.rule?.id) {
        await protectionRuleService.deleteRule(result.rule.id)
      }
    })
  })
})
