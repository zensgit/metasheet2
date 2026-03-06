import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IntelligentRestorePlugin, {
  CompressionService,
  IntelligentRestoreView,
  IntelligentStorageService,
  OperationClassifier,
} from '../src/index'

function createMockContext() {
  const eventEmit = vi.fn()

  const context = {
    core: {
      events: {
        emit: eventEmit,
      },
    },
  } as any

  return {
    context,
    eventEmit,
  }
}

describe('plugin-intelligent-restore smoke', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers the view, services, and commands against the current plugin context contract', () => {
    const { context, eventEmit } = createMockContext()

    IntelligentRestorePlugin.activate(context)

    expect(eventEmit).toHaveBeenCalledWith(
      'plugin:component:register',
      expect.objectContaining({
        name: 'intelligent-restore-view',
        component: IntelligentRestoreView,
        title: '智能恢复系统',
      }),
    )
    expect(eventEmit).toHaveBeenCalledWith(
      'plugin:service:register',
      expect.objectContaining({
        name: 'intelligent-storage',
        service: IntelligentStorageService,
      }),
    )
    expect(eventEmit).toHaveBeenCalledWith(
      'plugin:service:register',
      expect.objectContaining({
        name: 'compression-service',
        service: CompressionService,
      }),
    )
    expect(eventEmit).toHaveBeenCalledWith(
      'plugin:service:register',
      expect.objectContaining({
        name: 'operation-classifier',
        service: OperationClassifier,
      }),
    )

    const registeredCommands = eventEmit.mock.calls
      .filter(([eventName]) => eventName === 'plugin:command:register')
      .map(([, payload]) => payload.id)

    expect(registeredCommands).toEqual([
      'restore.smart',
      'restore.column',
      'restore.snapshot',
    ])

    const restoreCommand = eventEmit.mock.calls.find((call) => {
      return call[0] === 'plugin:command:register' && call[1].id === 'restore.smart'
    })?.[1]

    restoreCommand.handler({ spreadsheetId: 'sheet-1' })
    expect(console.log).toHaveBeenCalledWith('智能恢复命令执行', { spreadsheetId: 'sheet-1' })
    expect(() => IntelligentRestorePlugin.deactivate()).not.toThrow()
  })

  it('stores and restores records through the intelligent storage service', async () => {
    const storage = new IntelligentStorageService()

    const fullDetailResult = await storage.storeHistoryRecord({
      spreadsheetId: 'sheet-1',
      operationType: 'cell_edit',
      operatorName: 'Alice',
      description: 'Edited A1',
      changes: [{ cell: 'A1', value: 'done' }],
    })

    expect(fullDetailResult.storageStrategy).toBe('FULL_DETAIL')

    const compressedDetailResult = await storage.storeHistoryRecord({
      spreadsheetId: 'sheet-1',
      operationType: 'cell_format',
      operatorName: 'Bob',
      description: 'Updated formatting',
      changes: Array.from({ length: 12 }, (_, index) => ({
        cell: `A${index + 1}`,
        style: 'bold',
        note: 'x'.repeat(2000),
      })),
    })

    expect(compressedDetailResult.storageStrategy).toBe('COMPRESSED_DETAIL')

    const snapshotOnlyResult = await storage.storeHistoryRecord({
      spreadsheetId: 'sheet-1',
      operationType: 'import_data',
      operatorName: 'Carol',
      description: 'Imported source data',
      changes: Array.from({ length: 1200 }, (_, index) => ({
        row: index + 1,
        value: `record-${index + 1}`,
      })),
      snapshot: { rows: 1200 },
    })

    expect(snapshotOnlyResult.storageStrategy).toBe('SNAPSHOT_ONLY')
    expect(snapshotOnlyResult.snapshotId).toBeDefined()

    await expect(storage.retrieveHistoryRecord(fullDetailResult.historyId)).resolves.toEqual(
      expect.objectContaining({
        operationType: 'cell_edit',
        changes: [{ cell: 'A1', value: 'done' }],
      }),
    )
    await expect(storage.retrieveHistoryRecord(compressedDetailResult.historyId)).resolves.toEqual(
      expect.objectContaining({
        operationType: 'cell_format',
        changes: expect.arrayContaining([
          expect.objectContaining({ cell: 'A1', style: 'bold' }),
        ]),
      }),
    )
    await expect(storage.retrieveHistoryRecord(snapshotOnlyResult.historyId)).resolves.toEqual(
      expect.objectContaining({
        operationType: 'import_data',
        snapshot: expect.objectContaining({
          id: snapshotOnlyResult.snapshotId,
          spreadsheetId: 'sheet-1',
        }),
      }),
    )

    expect(storage.getStorageStats()).toEqual(
      expect.objectContaining({
        totalRecords: 3,
        strategies: {
          full: 1,
          compressed: 1,
          snapshot: 1,
        },
      }),
    )
  })
})
