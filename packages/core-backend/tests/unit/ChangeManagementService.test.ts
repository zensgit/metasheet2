import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChangeManagementService } from '../../src/services/ChangeManagementService'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow: vi.fn(),
    executeTakeFirst: vi.fn(),
    execute: vi.fn(),
    selectFrom: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  }
}))

vi.mock('../../src/services/SnapshotService', () => ({
  SnapshotService: vi.fn().mockImplementation(() => ({
    getSnapshot: vi.fn(),
    getSnapshotItems: vi.fn(),
    restoreSnapshot: vi.fn()
  }))
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn()
}))

vi.mock('../../src/services/NotificationService', () => ({
  notificationService: {
    send: vi.fn()
  }
}))

describe('ChangeManagementService', () => {
  let service: ChangeManagementService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let snapshotServiceMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new ChangeManagementService()
    const { db } = await import('../../src/db/db')
    dbMock = db
    snapshotServiceMock = (service as any).snapshotService
  })

  it('should create a change request', async () => {
    snapshotServiceMock.getSnapshot.mockResolvedValue({ id: 'snap-1', tags: [] })
    snapshotServiceMock.getSnapshotItems.mockResolvedValue([])
    
    dbMock.executeTakeFirstOrThrow.mockResolvedValue({
      id: 'cr-1',
      status: 'pending'
    })

    const result = await service.createChangeRequest({
      snapshotId: 'snap-1',
      title: 'Test Change',
      changeType: 'feature',
      targetEnvironment: 'dev',
      requestedBy: 'user-1'
    })

    expect(result.changeRequest.id).toBe('cr-1')
    expect(dbMock.insertInto).toHaveBeenCalledWith('change_requests')
  })

  it('should approve a change request', async () => {
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: 'cr-1',
      status: 'pending',
      current_approvals: 0,
      required_approvals: 1,
      approvers: []
    })
    // Mock check for existing approval
    dbMock.executeTakeFirst.mockResolvedValueOnce(undefined)

    const result = await service.approveChangeRequest('cr-1', 'approver-1')

    expect(result.approved).toBe(true)
    expect(result.readyToDeploy).toBe(true)
    expect(dbMock.insertInto).toHaveBeenCalledWith('change_approvals')
    expect(dbMock.updateTable).toHaveBeenCalledWith('change_requests')
  })

  it('should deploy a change request', async () => {
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: 'cr-1',
      status: 'approved',
      snapshot_id: 'snap-1'
    })
    
    snapshotServiceMock.restoreSnapshot.mockResolvedValue({ success: true })

    const result = await service.deployChange('cr-1', 'deployer-1')

    expect(result.success).toBe(true)
    expect(snapshotServiceMock.restoreSnapshot).toHaveBeenCalled()
    expect(dbMock.updateTable).toHaveBeenCalledWith('change_requests')
  })

  it('should rollback a change request', async () => {
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: 'cr-1',
      status: 'deployed',
      snapshot_id: 'snap-1'
    })
    
    snapshotServiceMock.getSnapshot.mockResolvedValue({
      id: 'snap-1',
      parent_snapshot_id: 'snap-parent'
    })
    
    snapshotServiceMock.restoreSnapshot.mockResolvedValue({ success: true })

    const result = await service.rollbackChange('cr-1', 'user-1', 'Bad bug')

    expect(result.success).toBe(true)
    expect(snapshotServiceMock.restoreSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: 'snap-parent'
    }))
  })
})
