/**
 * SnapshotService Labels & Protection Tests
 * Sprint 2: Testing tag management, protection levels, and release channels
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SnapshotService } from '../../src/services/SnapshotService'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
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

vi.mock('../../src/services/ProtectionRuleService', () => ({
  protectionRuleService: {
    evaluateRules: vi.fn().mockResolvedValue({ matched: false })
  }
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn()
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    snapshotOperationDuration: { labels: () => ({ observe: vi.fn() }) },
    snapshotCreateTotal: { labels: () => ({ inc: vi.fn() }) },
    snapshotRestoreTotal: { labels: () => ({ inc: vi.fn() }) },
    snapshotTagsTotal: { labels: () => ({ inc: vi.fn() }) },
    snapshotProtectionLevel: { labels: () => ({ set: vi.fn() }) },
    snapshotReleaseChannel: { labels: () => ({ set: vi.fn() }) },
  }
}))

describe('SnapshotService - Labels & Protection', () => {
  let service: SnapshotService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new SnapshotService()
    const { db } = await import('../../src/db/db')
    dbMock = db
  })

  describe('addTags', () => {
    it('should add tags to a snapshot without existing tags', async () => {
      // Mock getSnapshot returning snapshot with no tags
      dbMock.executeTakeFirst.mockResolvedValue({
        id: 'snap-1',
        view_id: 'view-1',
        tags: null
      })
      dbMock.execute.mockResolvedValue([])

      const result = await service.addTags('snap-1', ['stable', 'production'], 'user-1')

      expect(result).toBe(true)
      expect(dbMock.updateTable).toHaveBeenCalled()
      expect(dbMock.set).toHaveBeenCalledWith({ tags: ['stable', 'production'] })
    })

    it('should merge tags without duplicates', async () => {
      dbMock.executeTakeFirst.mockResolvedValue({
        id: 'snap-1',
        view_id: 'view-1',
        tags: ['existing', 'stable']
      })
      dbMock.execute.mockResolvedValue([])

      await service.addTags('snap-1', ['stable', 'new-tag'], 'user-1')

      // Should merge and dedupe: ['existing', 'stable', 'new-tag']
      expect(dbMock.set).toHaveBeenCalledWith({
        tags: expect.arrayContaining(['existing', 'stable', 'new-tag'])
      })
    })

    it('should throw error if snapshot not found', async () => {
      dbMock.executeTakeFirst.mockResolvedValue(null)

      await expect(service.addTags('nonexistent', ['tag'], 'user-1'))
        .rejects.toThrow('Snapshot not found')
    })
  })

  describe('removeTags', () => {
    it('should remove specified tags', async () => {
      dbMock.executeTakeFirst.mockResolvedValue({
        id: 'snap-1',
        view_id: 'view-1',
        tags: ['stable', 'production', 'keep-me']
      })
      dbMock.execute.mockResolvedValue([])

      await service.removeTags('snap-1', ['stable', 'production'], 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ tags: ['keep-me'] })
    })

    it('should handle removing tags that do not exist', async () => {
      dbMock.executeTakeFirst.mockResolvedValue({
        id: 'snap-1',
        view_id: 'view-1',
        tags: ['existing']
      })
      dbMock.execute.mockResolvedValue([])

      await service.removeTags('snap-1', ['nonexistent'], 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ tags: ['existing'] })
    })

    it('should handle empty tag array', async () => {
      dbMock.executeTakeFirst.mockResolvedValue({
        id: 'snap-1',
        view_id: 'view-1',
        tags: null
      })
      dbMock.execute.mockResolvedValue([])

      await service.removeTags('snap-1', ['any'], 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ tags: [] })
    })
  })

  describe('setProtectionLevel', () => {
    it('should set protection level to normal', async () => {
      dbMock.execute.mockResolvedValue([])

      const result = await service.setProtectionLevel('snap-1', 'normal', 'user-1')

      expect(result).toBe(true)
      expect(dbMock.set).toHaveBeenCalledWith({ protection_level: 'normal' })
    })

    it('should set protection level to protected', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.setProtectionLevel('snap-1', 'protected', 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ protection_level: 'protected' })
    })

    it('should set protection level to critical', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.setProtectionLevel('snap-1', 'critical', 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ protection_level: 'critical' })
    })
  })

  describe('setReleaseChannel', () => {
    it('should set release channel to stable', async () => {
      dbMock.execute.mockResolvedValue([])

      const result = await service.setReleaseChannel('snap-1', 'stable', 'user-1')

      expect(result).toBe(true)
      expect(dbMock.set).toHaveBeenCalledWith({ release_channel: 'stable' })
    })

    it('should set release channel to canary', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.setReleaseChannel('snap-1', 'canary', 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ release_channel: 'canary' })
    })

    it('should clear release channel with null', async () => {
      dbMock.execute.mockResolvedValue([])

      await service.setReleaseChannel('snap-1', null, 'user-1')

      expect(dbMock.set).toHaveBeenCalledWith({ release_channel: null })
    })
  })

  describe('getByTags', () => {
    it('should return snapshots matching any of the tags', async () => {
      const mockSnapshots = [
        { id: 'snap-1', view_id: 'view-1', tags: ['stable', 'production'] },
        { id: 'snap-2', view_id: 'view-2', tags: ['stable'] }
      ]
      dbMock.execute.mockResolvedValue(mockSnapshots)

      const result = await service.getByTags(['stable'])

      expect(result).toHaveLength(2)
      expect(dbMock.selectFrom).toHaveBeenCalledWith('snapshots')
    })

    it('should return empty array when no matches', async () => {
      dbMock.execute.mockResolvedValue([])

      const result = await service.getByTags(['nonexistent'])

      expect(result).toEqual([])
    })
  })

  describe('getByProtectionLevel', () => {
    it('should return snapshots with specified protection level', async () => {
      const mockSnapshots = [
        { id: 'snap-1', view_id: 'view-1', protection_level: 'critical' }
      ]
      dbMock.execute.mockResolvedValue(mockSnapshots)

      const result = await service.getByProtectionLevel('critical')

      expect(result).toHaveLength(1)
      expect(result[0].protection_level).toBe('critical')
    })
  })

  describe('getByReleaseChannel', () => {
    it('should return snapshots with specified release channel', async () => {
      const mockSnapshots = [
        { id: 'snap-1', view_id: 'view-1', release_channel: 'stable' },
        { id: 'snap-2', view_id: 'view-2', release_channel: 'stable' }
      ]
      dbMock.execute.mockResolvedValue(mockSnapshots)

      const result = await service.getByReleaseChannel('stable')

      expect(result).toHaveLength(2)
      expect(result.every(s => s.release_channel === 'stable')).toBe(true)
    })
  })
})
