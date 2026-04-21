import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsPersistenceAdapter } from '../../src/collab/yjs-persistence-adapter'

/** Wrap raw sync protocol bytes with a MSG_SYNC varuint prefix */
function wrapSyncMessage(syncData: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0) // MSG_SYNC
  encoding.writeUint8Array(enc, syncData)
  return encoding.toUint8Array(enc)
}

// ── Mock persistence adapter ────────────────────────────────────────
function createMockPersistence(): YjsPersistenceAdapter & {
  _loadDocResult: Uint8Array | null
  _storedUpdates: { recordId: string; update: Uint8Array }[]
} {
  const mock = {
    _loadDocResult: null as Uint8Array | null,
    _storedUpdates: [] as { recordId: string; update: Uint8Array }[],
    loadDoc: vi.fn(async () => mock._loadDocResult),
    storeUpdate: vi.fn(async (recordId: string, update: Uint8Array) => {
      mock._storedUpdates.push({ recordId, update })
    }),
    storeSnapshot: vi.fn(async () => {}),
  } as any
  return mock
}

// ── Mock Kysely for persistence adapter tests ───────────────────────
function createMockDb() {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue([]),
    values: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockReturnThis(),
    column: vi.fn().mockReturnThis(),
    doUpdateSet: vi.fn().mockReturnThis(),
  }
  return {
    selectFrom: vi.fn(() => mockChain),
    insertInto: vi.fn(() => mockChain),
    _chain: mockChain,
  }
}

// ═══════════════════════════════════════════════════════════════════
// YjsSyncService tests
// ═══════════════════════════════════════════════════════════════════
describe('YjsSyncService', () => {
  let persistence: ReturnType<typeof createMockPersistence>
  let service: YjsSyncService

  beforeEach(() => {
    persistence = createMockPersistence()
    service = new YjsSyncService(persistence)
  })

  afterEach(() => {
    service.destroy()
  })

  it('getOrCreateDoc returns a Y.Doc', async () => {
    const doc = await service.getOrCreateDoc('rec-1')
    expect(doc).toBeInstanceOf(Y.Doc)
  })

  it('getOrCreateDoc returns the same doc for the same recordId', async () => {
    const doc1 = await service.getOrCreateDoc('rec-1')
    const doc2 = await service.getOrCreateDoc('rec-1')
    expect(doc1).toBe(doc2)
  })

  it('getOrCreateDoc returns different docs for different recordIds', async () => {
    const doc1 = await service.getOrCreateDoc('rec-1')
    const doc2 = await service.getOrCreateDoc('rec-2')
    expect(doc1).not.toBe(doc2)
  })

  it('releaseDoc snapshots and removes the doc from cache', async () => {
    await service.getOrCreateDoc('rec-1')
    expect(service.size).toBe(1)
    await service.releaseDoc('rec-1')
    expect(service.size).toBe(0)
    expect(persistence.storeSnapshot).toHaveBeenCalledWith('rec-1', expect.anything())
  })

  it('cleanupIdleDocs removes docs idle longer than threshold', async () => {
    await service.getOrCreateDoc('rec-1')
    expect(service.size).toBe(1)

    // Use a very short threshold so the doc is considered idle immediately
    // We need to wait a tiny bit for lastAccess to be in the past
    const originalNow = Date.now
    Date.now = () => originalNow() + 120_000 // simulate 120s into the future
    try {
      await service.cleanupIdleDocs(60_000)
      expect(service.size).toBe(0)
    } finally {
      Date.now = originalNow
    }
  })

  it('doc update triggers persistence storeUpdate', async () => {
    const doc = await service.getOrCreateDoc('rec-1')
    const text = doc.getText('test')
    text.insert(0, 'hello')

    // storeUpdate is called asynchronously; wait a tick
    await new Promise((r) => setTimeout(r, 10))
    expect(persistence.storeUpdate).toHaveBeenCalled()
    const call = persistence.storeUpdate.mock.calls[0]
    expect(call[0]).toBe('rec-1')
    expect(call[1]).toBeInstanceOf(Uint8Array)
  })

  it('loads persisted state when creating doc', async () => {
    // Create a doc with some content and encode it
    const sourceDoc = new Y.Doc()
    sourceDoc.getText('test').insert(0, 'persisted')
    const state = Y.encodeStateAsUpdate(sourceDoc)
    sourceDoc.destroy()

    persistence._loadDocResult = state

    const doc = await service.getOrCreateDoc('rec-2')
    expect(doc.getText('test').toString()).toBe('persisted')
  })
})

// ═══════════════════════════════════════════════════════════════════
// YjsPersistenceAdapter tests (with mock Kysely)
// ═══════════════════════════════════════════════════════════════════
describe('YjsPersistenceAdapter', () => {
  it('loadDoc returns null when no state exists', async () => {
    const mockDb = createMockDb()
    const adapter = new YjsPersistenceAdapter(mockDb as any)

    const result = await adapter.loadDoc('nonexistent')
    expect(result).toBeNull()
  })

  it('loadDoc applies snapshot and incremental updates', async () => {
    // Create a base doc
    const baseDoc = new Y.Doc()
    baseDoc.getText('name').insert(0, 'base')
    const baseState = Y.encodeStateAsUpdate(baseDoc)

    // Create an incremental update
    const updateDoc = new Y.Doc()
    Y.applyUpdate(updateDoc, baseState)
    updateDoc.getText('name').insert(4, '-ext')
    // Capture just the latest update by encoding state diff
    const fullState = Y.encodeStateAsUpdate(updateDoc)

    const mockDb = createMockDb()
    // First call (selectFrom meta_record_yjs_states) returns snapshot
    mockDb._chain.executeTakeFirst.mockResolvedValueOnce({
      doc_state: Buffer.from(baseState),
    })
    // Second call (selectFrom meta_record_yjs_updates) returns incremental
    // Since mock chain is shared, we need to handle the second execute call
    const incrUpdate = Y.encodeStateAsUpdate(updateDoc, Y.encodeStateVector(baseDoc))
    mockDb._chain.execute.mockResolvedValueOnce([
      { update_data: Buffer.from(incrUpdate) },
    ])

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const result = await adapter.loadDoc('rec-1')

    expect(result).not.toBeNull()
    // Verify the merged doc contains both base + incremental
    const verifyDoc = new Y.Doc()
    Y.applyUpdate(verifyDoc, result!)
    expect(verifyDoc.getText('name').toString()).toBe('base-ext')
    verifyDoc.destroy()

    baseDoc.destroy()
    updateDoc.destroy()
  })

  it('storeUpdate inserts into yjs_updates table', async () => {
    const mockDb = createMockDb()
    mockDb._chain.execute.mockResolvedValueOnce([])

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const update = new Uint8Array([1, 2, 3])
    await adapter.storeUpdate('rec-1', update)

    expect(mockDb.insertInto).toHaveBeenCalledWith('meta_record_yjs_updates')
    expect(mockDb._chain.values).toHaveBeenCalled()
    const valuesArg = mockDb._chain.values.mock.calls[0][0]
    expect(valuesArg.record_id).toBe('rec-1')
    expect(Buffer.isBuffer(valuesArg.update_data)).toBe(true)
  })

  it('storeSnapshot upserts into yjs_states table', async () => {
    const mockDb = createMockDb()
    // Chain mock for onConflict
    mockDb._chain.onConflict.mockImplementation((fn: any) => {
      fn({ column: vi.fn().mockReturnValue({ doUpdateSet: vi.fn().mockReturnValue(mockDb._chain) }) })
      return mockDb._chain
    })

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const doc = new Y.Doc()
    doc.getText('test').insert(0, 'hello')

    await adapter.storeSnapshot('rec-1', doc)

    expect(mockDb.insertInto).toHaveBeenCalledWith('meta_record_yjs_states')
    expect(mockDb._chain.values).toHaveBeenCalled()
    const valuesArg = mockDb._chain.values.mock.calls[0][0]
    expect(valuesArg.record_id).toBe('rec-1')
    expect(Buffer.isBuffer(valuesArg.doc_state)).toBe(true)
    expect(Buffer.isBuffer(valuesArg.state_vector)).toBe(true)
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Yjs sync protocol integration tests
// ═══════════════════════════════════════════════════════════════════
describe('Yjs sync protocol', () => {
  it('two Y.Docs can sync via encoded messages', () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    doc1.getText('field').insert(0, 'hello')

    // Sync step 1: doc2 sends its state vector to doc1
    const sv2 = Y.encodeStateVector(doc2)
    // doc1 computes the diff and sends it to doc2
    const diff = Y.encodeStateAsUpdate(doc1, sv2)
    Y.applyUpdate(doc2, diff)

    expect(doc2.getText('field').toString()).toBe('hello')

    doc1.destroy()
    doc2.destroy()
  })

  it('update from one doc applied to another via binary exchange', () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    // Initial sync
    const sv2 = Y.encodeStateVector(doc2)
    const diff1 = Y.encodeStateAsUpdate(doc1, sv2)
    Y.applyUpdate(doc2, diff1)

    // doc1 makes a change
    doc1.getText('field').insert(0, 'world')
    const update = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2))
    Y.applyUpdate(doc2, update)

    expect(doc2.getText('field').toString()).toBe('world')

    doc1.destroy()
    doc2.destroy()
  })

  it('concurrent edits from two docs merge correctly', () => {
    const doc1 = new Y.Doc({ gc: false })
    const doc2 = new Y.Doc({ gc: false })

    // Both start empty, sync first
    const sv1 = Y.encodeStateVector(doc1)
    const sv2 = Y.encodeStateVector(doc2)
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, sv2))
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, sv1))

    // Concurrent edits (simulating offline)
    doc1.getText('field').insert(0, 'AAA')
    doc2.getText('field').insert(0, 'BBB')

    // Now sync both ways
    const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2))
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1))
    Y.applyUpdate(doc2, update1)
    Y.applyUpdate(doc1, update2)

    // Both should converge to the same text
    expect(doc1.getText('field').toString()).toBe(doc2.getText('field').toString())
    // Content should have both edits (6 chars)
    expect(doc1.getText('field').toString()).toHaveLength(6)

    doc1.destroy()
    doc2.destroy()
  })

  it('reconnection: doc with pending changes syncs correctly after gap', () => {
    const serverDoc = new Y.Doc()
    const clientDoc = new Y.Doc()

    // Initial sync
    serverDoc.getText('field').insert(0, 'initial')
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(clientDoc)))

    expect(clientDoc.getText('field').toString()).toBe('initial')

    // Client goes offline and makes changes
    clientDoc.getText('field').insert(7, ' offline')

    // Server also receives changes from another client
    serverDoc.getText('field').insert(7, ' server')

    // Client reconnects and syncs
    const clientToServer = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDoc))
    const serverToClient = Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(clientDoc))

    Y.applyUpdate(serverDoc, clientToServer)
    Y.applyUpdate(clientDoc, serverToClient)

    // Both should converge
    const serverText = serverDoc.getText('field').toString()
    const clientText = clientDoc.getText('field').toString()
    expect(serverText).toBe(clientText)
    // Both "offline" and "server" should be present
    expect(serverText).toContain('initial')
    expect(serverText).toContain('offline')
    expect(serverText).toContain('server')

    serverDoc.destroy()
    clientDoc.destroy()
  })

  it('y-protocols readSyncMessage handles full sync handshake', () => {
    const serverDoc = new Y.Doc()
    const clientDoc = new Y.Doc()

    serverDoc.getText('field').insert(0, 'from-server')

    // Server sends sync step 1 (its state vector)
    const s1Enc = encoding.createEncoder()
    syncProtocol.writeSyncStep1(s1Enc, serverDoc)
    const step1Msg = encoding.toUint8Array(s1Enc)

    // Client processes step 1 via readSyncMessage (wrapping with MSG_SYNC type)
    const wrappedStep1 = wrapSyncMessage(step1Msg)
    const clientReplyEnc = encoding.createEncoder()
    encoding.writeVarUint(clientReplyEnc, 0) // MSG_SYNC
    const decoder1 = decoding.createDecoder(wrappedStep1)
    decoding.readVarUint(decoder1) // skip MSG_SYNC
    syncProtocol.readSyncMessage(decoder1, clientReplyEnc, clientDoc, 'server')

    // Client's reply contains sync step 2 (the update data)
    const clientReply = encoding.toUint8Array(clientReplyEnc)

    // Server sends sync step 2 to client (the actual doc state)
    const s2Enc = encoding.createEncoder()
    syncProtocol.writeSyncStep2(s2Enc, serverDoc)
    const step2Msg = encoding.toUint8Array(s2Enc)

    // Client processes step 2 via readSyncMessage
    const wrappedStep2 = wrapSyncMessage(step2Msg)
    const dummyEnc = encoding.createEncoder()
    encoding.writeVarUint(dummyEnc, 0)
    const decoder2 = decoding.createDecoder(wrappedStep2)
    decoding.readVarUint(decoder2)
    syncProtocol.readSyncMessage(decoder2, dummyEnc, clientDoc, 'server')

    expect(clientDoc.getText('field').toString()).toBe('from-server')

    serverDoc.destroy()
    clientDoc.destroy()
  })
})

// ---------------------------------------------------------------------------
// YjsRecordBridge
// ---------------------------------------------------------------------------

describe('YjsRecordBridge', () => {
  it('flushes Y.Text changes as a patch via RecordWriteService', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const doc = new Y.Doc()
    const fields = doc.getMap('fields')
    const textField = new Y.Text()
    fields.set('fld_name', textField)

    let capturedInput: any = null
    const mockPatchRecords = vi.fn().mockImplementation(async (input: any) => {
      capturedInput = input
      return { updated: [{ recordId: 'rec1', version: 2 }] }
    })

    const mockRecordWriteService = { patchRecords: mockPatchRecords } as any
    const mockSyncService = {} as any
    const mockGetWriteInput = vi.fn().mockImplementation(async (recordId: string, patch: Record<string, unknown>, actorId: string, _allActorIds?: string[]) => ({
      sheetId: 'sheet1',
      changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]),
      actorId: actorId || 'unknown',
      fields: [],
      visiblePropertyFields: [],
      visiblePropertyFieldIds: new Set<string>(),
      attachmentFields: [],
      fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
      capabilities: { canEditRecord: true } as any,
      access: { userId: actorId || 'unknown', permissions: [], isAdminRole: false },
    }))

    const bridge = new YjsRecordBridge(mockSyncService, mockRecordWriteService, mockGetWriteInput, {
      mergeWindowMs: 10,
      maxDelayMs: 50,
    })

    bridge.observe('rec1', doc)

    // Simulate a Yjs client editing the text field
    textField.insert(0, 'hello')

    // Wait for debounce flush
    await new Promise((r) => setTimeout(r, 50))

    expect(mockGetWriteInput).toHaveBeenCalledWith('rec1', { fld_name: 'hello' }, 'unknown', ['unknown'])
    expect(mockPatchRecords).toHaveBeenCalledTimes(1)

    bridge.destroy()
    doc.destroy()
  })

  it('merges rapid consecutive edits into single patch', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const doc = new Y.Doc()
    const fields = doc.getMap('fields')
    const textField = new Y.Text()
    fields.set('fld_name', textField)

    const mockPatchRecords = vi.fn().mockResolvedValue({ updated: [] })
    const mockGetWriteInput = vi.fn().mockImplementation(async (recordId: string, patch: Record<string, unknown>, actorId: string, _allActorIds?: string[]) => ({
      sheetId: 'sheet1',
      changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]),
      actorId: actorId || 'unknown',
      fields: [],
      visiblePropertyFields: [],
      visiblePropertyFieldIds: new Set<string>(),
      attachmentFields: [],
      fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
      capabilities: { canEditRecord: true } as any,
      access: { userId: actorId || 'unknown', permissions: [], isAdminRole: false },
    }))

    const bridge = new YjsRecordBridge({} as any, { patchRecords: mockPatchRecords } as any, mockGetWriteInput, {
      mergeWindowMs: 30,
      maxDelayMs: 200,
    })

    bridge.observe('rec1', doc)

    // Rapid edits
    textField.insert(0, 'a')
    textField.insert(1, 'b')
    textField.insert(2, 'c')

    // Wait for single merged flush
    await new Promise((r) => setTimeout(r, 80))

    expect(mockPatchRecords).toHaveBeenCalledTimes(1)
    expect(mockGetWriteInput).toHaveBeenCalledWith('rec1', { fld_name: 'abc' }, 'unknown', ['unknown'])

    bridge.destroy()
    doc.destroy()
  })

  it('skips changes with rest origin to avoid loops', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const doc = new Y.Doc()
    const fields = doc.getMap('fields')
    const textField = new Y.Text()
    fields.set('fld_name', textField)

    const mockPatchRecords = vi.fn().mockResolvedValue({ updated: [] })
    const mockGetWriteInput = vi.fn().mockResolvedValue(null)

    const bridge = new YjsRecordBridge({} as any, { patchRecords: mockPatchRecords } as any, mockGetWriteInput, {
      mergeWindowMs: 10,
      maxDelayMs: 50,
    })

    bridge.observe('rec1', doc)

    // Edit with 'rest' origin — should be skipped
    doc.transact(() => {
      textField.insert(0, 'from-rest')
    }, 'rest')

    await new Promise((r) => setTimeout(r, 50))

    expect(mockGetWriteInput).not.toHaveBeenCalled()
    expect(mockPatchRecords).not.toHaveBeenCalled()

    bridge.destroy()
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Sheet capabilities: write-own record enforcement
// ═══════════════════════════════════════════════════════════════════
describe('sheet-capabilities write-own', () => {
  it('canWriteRecord returns true for creator when write-own policy active', async () => {
    const { canWriteRecord } = await import('../../src/multitable/sheet-capabilities')

    const caps = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true }
    // write-own scope: hasAssignments + canWriteOwn + NOT canWrite
    const scope = { hasAssignments: true, canRead: true, canWrite: false, canWriteOwn: true, canAdmin: false }

    // Creator editing own record → allowed
    expect(canWriteRecord(caps, scope, false, 'user-a', 'user-a')).toBe(true)
  })

  it('canWriteRecord returns false for non-creator when write-own policy active', async () => {
    const { canWriteRecord } = await import('../../src/multitable/sheet-capabilities')

    const caps = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true }
    const scope = { hasAssignments: true, canRead: true, canWrite: false, canWriteOwn: true, canAdmin: false }

    // Non-creator editing someone else's record → denied
    expect(canWriteRecord(caps, scope, false, 'user-b', 'user-a')).toBe(false)
  })

  it('canWriteRecord returns true for any user when full write scope', async () => {
    const { canWriteRecord } = await import('../../src/multitable/sheet-capabilities')

    const caps = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true }
    // Full write scope: canWrite = true
    const scope = { hasAssignments: true, canRead: true, canWrite: true, canWriteOwn: false, canAdmin: false }

    // Non-creator can edit when full write is granted
    expect(canWriteRecord(caps, scope, false, 'user-b', 'user-a')).toBe(true)
  })

  it('ensureRecordWriteAllowed denies non-creator edit under write-own', async () => {
    const { ensureRecordWriteAllowed } = await import('../../src/multitable/sheet-capabilities')

    const caps = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true }
    const scope = { hasAssignments: true, canRead: true, canWrite: false, canWriteOwn: true, canAdmin: false }
    const access = { userId: 'user-b', permissions: [], isAdminRole: false }

    // user-b tries to edit user-a's record → denied
    expect(ensureRecordWriteAllowed(caps, scope, access, 'user-a', 'edit')).toBe(false)
    // user-a edits own record → allowed
    expect(ensureRecordWriteAllowed(caps, scope, { ...access, userId: 'user-a' }, 'user-a', 'edit')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// YjsPersistenceAdapter: crash recovery (updates-only, no snapshot)
// ═══════════════════════════════════════════════════════════════════
describe('YjsPersistenceAdapter crash recovery', () => {
  it('loadDoc recovers from updates-only when no snapshot exists', async () => {
    // Simulate crash: updates were persisted but storeSnapshot never ran
    const { YjsPersistenceAdapter } = await import('../../src/collab/yjs-persistence-adapter')

    // Create a Y.Doc and encode an update
    const srcDoc = new Y.Doc()
    srcDoc.getText('field').insert(0, 'crash-test')
    const update = Y.encodeStateAsUpdate(srcDoc)
    srcDoc.destroy()

    // Mock DB: no snapshot, but one update row
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue(null), // no snapshot
      execute: vi.fn().mockResolvedValue([{ update_data: Buffer.from(update) }]), // one update
    }
    const mockDb = {
      selectFrom: vi.fn(() => mockChain),
    }

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const result = await adapter.loadDoc('rec-crash')

    expect(result).not.toBeNull()

    // Verify the recovered doc has the right content
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, result!)
    expect(recovered.getText('field').toString()).toBe('crash-test')
    recovered.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════
// YjsRecordBridge: multi-actor merge window
// ═══════════════════════════════════════════════════════════════════
describe('YjsRecordBridge multi-actor', () => {
  it('tracks all actorIds in merge window, not just the last one', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const doc = new Y.Doc()
    const fields = doc.getMap('fields')
    const textField = new Y.Text()
    fields.set('fld_name', textField)

    let capturedAllActorIds: string[] | undefined
    const mockPatchRecords = vi.fn().mockResolvedValue({ updated: [] })
    const mockGetWriteInput = vi.fn().mockImplementation(
      async (_recordId: string, _patch: Record<string, unknown>, _primaryActorId: string, allActorIds?: string[]) => {
        capturedAllActorIds = allActorIds
        return {
          sheetId: 'sheet1',
          changesByRecord: new Map(),
          actorId: _primaryActorId,
          fields: [],
          visiblePropertyFields: [],
          visiblePropertyFieldIds: new Set<string>(),
          attachmentFields: [],
          fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
          capabilities: { canEditRecord: true } as any,
          access: { userId: _primaryActorId, permissions: [], isAdminRole: false },
        }
      },
    )

    // actorResolver: map socket ids to user ids
    const actorResolver = (socketId: string) => socketId === 'sock-a' ? 'user-a' : socketId === 'sock-b' ? 'user-b' : undefined

    const bridge = new YjsRecordBridge(
      {} as any,
      { patchRecords: mockPatchRecords } as any,
      mockGetWriteInput,
      { mergeWindowMs: 50, maxDelayMs: 200 },
      actorResolver,
    )

    bridge.observe('rec1', doc)

    // Two different users edit within the merge window
    doc.transact(() => { textField.insert(0, 'a') }, 'sock-a')
    doc.transact(() => { textField.insert(1, 'b') }, 'sock-b')

    await new Promise((r) => setTimeout(r, 100))

    expect(mockGetWriteInput).toHaveBeenCalledTimes(1)
    // Both actors should be tracked
    expect(capturedAllActorIds).toContain('user-a')
    expect(capturedAllActorIds).toContain('user-b')
    expect(capturedAllActorIds).toHaveLength(2)

    bridge.destroy()
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Regression: YjsRecordBridge re-observes when Y.Doc is recreated
// ═══════════════════════════════════════════════════════════════════
// This reproduces the Run 2 bug from yjs-node-client-validation-20260420.md:
// after a Y.Doc is destroyed by idle cleanup and recreated on next subscribe,
// bridge.observe() used to early-return because observedDocs still had the
// recordId entry, leaving the new doc unobserved → edits silently skipped.
describe('YjsRecordBridge doc lifecycle', () => {
  it('re-registers observer when Y.Doc instance changes for the same record', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const mockPatch = vi.fn().mockResolvedValue({ updated: [] })
    const mockGetInput = vi.fn().mockImplementation(
      async (recordId: string, patch: Record<string, unknown>, pAid: string, allAids: string[]) => ({
        sheetId: 'sheet1',
        changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]),
        actorId: pAid,
        fields: [],
        visiblePropertyFields: [],
        visiblePropertyFieldIds: new Set<string>(),
        attachmentFields: [],
        fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
        capabilities: { canEditRecord: true } as any,
        access: { userId: pAid, permissions: [], isAdminRole: false },
      }),
    )

    const bridge = new YjsRecordBridge(
      {} as any,
      { patchRecords: mockPatch } as any,
      mockGetInput,
      { mergeWindowMs: 20, maxDelayMs: 100 },
    )

    // First doc: simulates first subscribe cycle
    const doc1 = new Y.Doc()
    const text1 = new Y.Text()
    doc1.getMap('fields').set('fld_name', text1)
    bridge.observe('rec1', doc1)
    text1.insert(0, 'first')
    await new Promise((r) => setTimeout(r, 60))
    expect(mockPatch).toHaveBeenCalledTimes(1)

    // Simulate cleanup: destroy doc1 (but don't call unobserve — matches
    // real sync-service behavior where idle cleanup nukes the Y.Doc without
    // notifying the bridge).
    doc1.destroy()

    // Second doc: simulates resubscribe after idle release. Fresh Y.Doc,
    // fresh Y.Text. Previous bug: observe() early-returned and this edit
    // never reached the bridge.
    const doc2 = new Y.Doc()
    const text2 = new Y.Text()
    doc2.getMap('fields').set('fld_name', text2)
    bridge.observe('rec1', doc2)
    text2.insert(0, 'second')
    await new Promise((r) => setTimeout(r, 60))

    // With the fix: observer is re-registered on doc2, so this edit flushes.
    expect(mockPatch).toHaveBeenCalledTimes(2)
    expect(mockGetInput).toHaveBeenLastCalledWith('rec1', { fld_name: 'second' }, 'unknown', ['unknown'])

    bridge.destroy()
    doc2.destroy()
  })

  it('does not re-register when observe() is called with the same Y.Doc', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const mockPatch = vi.fn().mockResolvedValue({ updated: [] })
    const mockGetInput = vi.fn().mockImplementation(
      async (recordId: string, patch: Record<string, unknown>, pAid: string) => ({
        sheetId: 'sheet1',
        changesByRecord: new Map([[recordId, [{ fieldId: 'fld_name', value: (patch as any).fld_name }]]]),
        actorId: pAid,
        fields: [],
        visiblePropertyFields: [],
        visiblePropertyFieldIds: new Set<string>(),
        attachmentFields: [],
        fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
        capabilities: { canEditRecord: true } as any,
        access: { userId: pAid, permissions: [], isAdminRole: false },
      }),
    )

    const bridge = new YjsRecordBridge(
      {} as any,
      { patchRecords: mockPatch } as any,
      mockGetInput,
      { mergeWindowMs: 20, maxDelayMs: 100 },
    )

    const doc = new Y.Doc()
    const text = new Y.Text()
    doc.getMap('fields').set('fld_name', text)

    bridge.observe('rec1', doc)
    bridge.observe('rec1', doc) // idempotent second call — same doc instance
    bridge.observe('rec1', doc)

    text.insert(0, 'hello')
    await new Promise((r) => setTimeout(r, 60))

    // Expected: ONE flush (not 3). If observer was registered 3 times we'd
    // see 3 flushes.
    expect(mockPatch).toHaveBeenCalledTimes(1)

    bridge.destroy()
    doc.destroy()
  })
})
