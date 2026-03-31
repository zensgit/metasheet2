import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const dbErrorMocks = vi.hoisted(() => ({
  isDatabaseSchemaError: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
}))

vi.mock('../../src/utils/database-errors', () => ({
  isDatabaseSchemaError: dbErrorMocks.isDatabaseSchemaError,
}))

import {
  getDirectorySyncStatus,
  acknowledgeAlert,
  recordSyncRun,
  getDirectorySyncHistory,
} from '../../src/directory/DirectorySyncService'

import {
  recordDeprovision,
  listDeprovisions,
  getDeprovision,
  rollbackDeprovision,
} from '../../src/directory/deprovision-ledger'

describe('DirectorySyncService', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    dbErrorMocks.isDatabaseSchemaError.mockReset()
  })

  describe('getDirectorySyncStatus', () => {
    it('returns status from database', async () => {
      pgMocks.query.mockResolvedValue({
        rows: [{
          last_sync_at: '2026-03-30T10:00:00.000Z',
          next_sync_at: '2026-03-30T11:00:00.000Z',
          status: 'completed',
          has_alert: false,
          alert_message: null,
          alert_acknowledged_at: null,
          alert_acknowledged_by: null,
        }],
      })

      const result = await getDirectorySyncStatus()

      expect(result).toEqual({
        lastSyncAt: '2026-03-30T10:00:00.000Z',
        nextSyncAt: '2026-03-30T11:00:00.000Z',
        status: 'completed',
        hasAlert: false,
        alertMessage: null,
        alertAcknowledgedAt: null,
        alertAcknowledgedBy: null,
      })
    })

    it('returns defaults when no rows exist', async () => {
      pgMocks.query.mockResolvedValue({ rows: [] })

      const result = await getDirectorySyncStatus()

      expect(result.status).toBe('idle')
      expect(result.hasAlert).toBe(false)
    })

    it('returns defaults when table does not exist', async () => {
      const error = new Error('relation "directory_sync_status" does not exist')
      pgMocks.query.mockRejectedValue(error)
      dbErrorMocks.isDatabaseSchemaError.mockReturnValue(true)

      const result = await getDirectorySyncStatus()

      expect(result.status).toBe('idle')
    })

    it('throws on non-schema errors', async () => {
      const error = new Error('Connection refused')
      pgMocks.query.mockRejectedValue(error)
      dbErrorMocks.isDatabaseSchemaError.mockReturnValue(false)

      await expect(getDirectorySyncStatus()).rejects.toThrow('Connection refused')
    })
  })

  describe('acknowledgeAlert', () => {
    it('acknowledges and returns updated status', async () => {
      pgMocks.query.mockResolvedValue({
        rows: [{
          last_sync_at: '2026-03-30T10:00:00.000Z',
          next_sync_at: null,
          status: 'failed',
          has_alert: false,
          alert_message: 'Sync failed',
          alert_acknowledged_at: '2026-03-30T10:05:00.000Z',
          alert_acknowledged_by: 'admin-1',
        }],
      })

      const result = await acknowledgeAlert('admin-1')

      expect(result.hasAlert).toBe(false)
      expect(result.alertAcknowledgedBy).toBe('admin-1')
      expect(pgMocks.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE directory_sync_status'),
        ['admin-1'],
      )
    })

    it('returns defaults when no alert to acknowledge', async () => {
      pgMocks.query.mockResolvedValue({ rows: [] })

      const result = await acknowledgeAlert('admin-1')

      expect(result.status).toBe('idle')
    })
  })

  describe('recordSyncRun', () => {
    it('inserts history and updates status', async () => {
      pgMocks.query.mockResolvedValue({ rows: [] })

      await recordSyncRun({ status: 'completed', syncedCount: 10, failedCount: 0 })

      expect(pgMocks.query).toHaveBeenCalledTimes(2)
      expect(pgMocks.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO directory_sync_history'),
        expect.arrayContaining(['completed']),
      )
    })

    it('sets alert when status is failed', async () => {
      pgMocks.query.mockResolvedValue({ rows: [] })

      await recordSyncRun({ status: 'failed', message: 'Timeout' })

      expect(pgMocks.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE directory_sync_status'),
        expect.arrayContaining(['failed', true, 'Timeout']),
      )
    })

    it('silently returns when table missing', async () => {
      const error = new Error('relation does not exist')
      pgMocks.query.mockRejectedValue(error)
      dbErrorMocks.isDatabaseSchemaError.mockReturnValue(true)

      await expect(recordSyncRun({ status: 'completed' })).resolves.toBeUndefined()
    })
  })

  describe('getDirectorySyncHistory', () => {
    it('returns paginated history', async () => {
      pgMocks.query
        .mockResolvedValueOnce({ rows: [{ c: 2 }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'h-1', status: 'completed', message: null, synced_count: 10, failed_count: 0, created_at: '2026-03-30T10:00:00.000Z' },
          ],
        })

      const result = await getDirectorySyncHistory({ page: 1, pageSize: 10 })

      expect(result.total).toBe(2)
      expect(result.items).toHaveLength(1)
      expect(result.items[0].syncedCount).toBe(10)
    })

    it('returns empty when table missing', async () => {
      const error = new Error('relation does not exist')
      pgMocks.query.mockRejectedValue(error)
      dbErrorMocks.isDatabaseSchemaError.mockReturnValue(true)

      const result = await getDirectorySyncHistory({ page: 1, pageSize: 10 })

      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })
  })
})

describe('deprovision-ledger', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    dbErrorMocks.isDatabaseSchemaError.mockReset()
  })

  describe('recordDeprovision', () => {
    it('inserts and returns record', async () => {
      pgMocks.query.mockResolvedValue({
        rows: [{
          id: 'dp-1',
          target_user_id: 'user-99',
          performed_by: 'admin-1',
          reason: 'Left company',
          user_snapshot: { email: 'user@example.com' },
          status: 'executed',
          rolled_back_by: null,
          rolled_back_at: null,
          created_at: '2026-03-30T10:00:00.000Z',
          updated_at: '2026-03-30T10:00:00.000Z',
        }],
      })

      const result = await recordDeprovision({
        userId: 'admin-1',
        targetUserId: 'user-99',
        reason: 'Left company',
        snapshot: { email: 'user@example.com' },
      })

      expect(result).toMatchObject({ id: 'dp-1', status: 'executed', targetUserId: 'user-99' })
    })

    it('returns null when table missing', async () => {
      const error = new Error('relation does not exist')
      pgMocks.query.mockRejectedValue(error)
      dbErrorMocks.isDatabaseSchemaError.mockReturnValue(true)

      const result = await recordDeprovision({
        userId: 'admin-1',
        targetUserId: 'user-99',
        reason: 'test',
        snapshot: {},
      })

      expect(result).toBeNull()
    })
  })

  describe('listDeprovisions', () => {
    it('returns paginated results', async () => {
      pgMocks.query
        .mockResolvedValueOnce({ rows: [{ c: 1 }] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'dp-1',
            target_user_id: 'user-99',
            performed_by: 'admin-1',
            reason: 'Left',
            user_snapshot: {},
            status: 'executed',
            rolled_back_by: null,
            rolled_back_at: null,
            created_at: '2026-03-30T10:00:00.000Z',
            updated_at: '2026-03-30T10:00:00.000Z',
          }],
        })

      const result = await listDeprovisions({ page: 1, pageSize: 10 })

      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
    })

    it('applies search filter', async () => {
      pgMocks.query
        .mockResolvedValueOnce({ rows: [{ c: 0 }] })
        .mockResolvedValueOnce({ rows: [] })

      await listDeprovisions({ page: 1, pageSize: 10, q: 'user-99' })

      expect(pgMocks.query).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%user-99%']),
      )
    })
  })

  describe('getDeprovision', () => {
    it('returns record by id', async () => {
      pgMocks.query.mockResolvedValue({
        rows: [{
          id: 'dp-1',
          target_user_id: 'user-99',
          performed_by: 'admin-1',
          reason: 'Left',
          user_snapshot: { email: 'test@test.com' },
          status: 'executed',
          rolled_back_by: null,
          rolled_back_at: null,
          created_at: '2026-03-30T10:00:00.000Z',
          updated_at: '2026-03-30T10:00:00.000Z',
        }],
      })

      const result = await getDeprovision('dp-1')

      expect(result).toMatchObject({ id: 'dp-1' })
    })

    it('returns null when not found', async () => {
      pgMocks.query.mockResolvedValue({ rows: [] })

      const result = await getDeprovision('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('rollbackDeprovision', () => {
    it('updates status and returns snapshot', async () => {
      pgMocks.query.mockResolvedValue({
        rows: [{
          id: 'dp-1',
          target_user_id: 'user-99',
          performed_by: 'admin-1',
          reason: 'Left',
          user_snapshot: { email: 'test@test.com', role: 'user' },
          status: 'rolled-back',
          rolled_back_by: 'admin-1',
          rolled_back_at: '2026-03-30T11:00:00.000Z',
          created_at: '2026-03-30T10:00:00.000Z',
          updated_at: '2026-03-30T11:00:00.000Z',
        }],
      })

      const result = await rollbackDeprovision('dp-1', 'admin-1')

      expect(result.record?.status).toBe('rolled-back')
      expect(result.snapshot).toMatchObject({ email: 'test@test.com' })
    })

    it('returns nulls when record not found or already rolled back', async () => {
      pgMocks.query.mockResolvedValue({ rows: [] })

      const result = await rollbackDeprovision('dp-1', 'admin-1')

      expect(result.record).toBeNull()
      expect(result.snapshot).toBeNull()
    })
  })
})
