import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChangeManagementService } from '../../src/services/ChangeManagementService'
import { notificationService } from '../../src/services/NotificationService'

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

describe('Change Management Simulation', () => {
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

  it('Full Lifecycle: Create -> Approve -> Deploy -> Rollback', async () => {
    // 1. Setup Data
    const snapshotId = 'snap-123'
    const changeRequestId = 'cr-456'
    const userId = 'user-admin'
    const approverId = 'user-approver'

    snapshotServiceMock.getSnapshot.mockResolvedValue({ 
      id: snapshotId, 
      tags: ['stable'],
      parent_snapshot_id: 'snap-parent'
    })
    snapshotServiceMock.getSnapshotItems.mockResolvedValue([
      { item_type: 'row', id: '1' },
      { item_type: 'column', id: '2' }
    ])

    // 2. Create Change Request
    dbMock.executeTakeFirstOrThrow.mockResolvedValue({
      id: changeRequestId,
      status: 'pending',
      required_approvals: 1,
      current_approvals: 0,
      approvers: []
    })

    const createResult = await service.createChangeRequest({
      snapshotId,
      title: 'Deploy V2',
      changeType: 'feature',
      targetEnvironment: 'production',
      requestedBy: userId
    })

    expect(createResult.changeRequest.id).toBe(changeRequestId)
    expect(notificationService.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('New Change Request')
    }))

    // 3. Approve Change Request
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: changeRequestId,
      status: 'pending',
      required_approvals: 1,
      current_approvals: 0,
      approvers: [],
      requested_by: userId,
      title: 'Deploy V2'
    })
    // Mock check for existing approval
    dbMock.executeTakeFirst.mockResolvedValueOnce(undefined)

    const approveResult = await service.approveChangeRequest(changeRequestId, approverId)
    
    expect(approveResult.approved).toBe(true)
    expect(approveResult.readyToDeploy).toBe(true)
    expect(notificationService.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Change Request Approved')
    }))

    // 4. Deploy Change
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: changeRequestId,
      status: 'approved',
      snapshot_id: snapshotId,
      target_environment: 'production',
      requested_by: userId,
      title: 'Deploy V2'
    })
    snapshotServiceMock.restoreSnapshot.mockResolvedValue({ success: true })

    const deployResult = await service.deployChange(changeRequestId, userId)

    expect(deployResult.success).toBe(true)
    expect(notificationService.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Change Deployed')
    }))

    // 5. Rollback Change
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: changeRequestId,
      status: 'deployed',
      snapshot_id: snapshotId,
      requested_by: userId,
      title: 'Deploy V2'
    })
    snapshotServiceMock.restoreSnapshot.mockResolvedValue({ success: true })

    const rollbackResult = await service.rollbackChange(changeRequestId, userId, 'Critical Bug Found')

    expect(rollbackResult.success).toBe(true)
    expect(rollbackResult.parentSnapshotId).toBe('snap-parent')
    expect(notificationService.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Change Rolled Back')
    }))
  })
})
