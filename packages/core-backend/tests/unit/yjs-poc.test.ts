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
    const mockGetWriteInput = vi.fn().mockImplementation(async (recordId: string, patch: Record<string, unknown>) => ({
      sheetId: 'sheet1',
      changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]),
      actorId: 'yjs-bridge',
      fields: [],
      visiblePropertyFields: [],
      visiblePropertyFieldIds: new Set<string>(),
      attachmentFields: [],
      fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
      capabilities: { canEditRecord: true } as any,
      access: { userId: 'yjs-bridge', permissions: [], isAdminRole: false },
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

    expect(mockGetWriteInput).toHaveBeenCalledWith('rec1', { fld_name: 'hello' })
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
    const mockGetWriteInput = vi.fn().mockImplementation(async (recordId: string, patch: Record<string, unknown>) => ({
      sheetId: 'sheet1',
      changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]),
      actorId: 'yjs-bridge',
      fields: [],
      visiblePropertyFields: [],
      visiblePropertyFieldIds: new Set<string>(),
      attachmentFields: [],
      fieldById: new Map([['fld_name', { type: 'string', readOnly: false, hidden: false }]]),
      capabilities: { canEditRecord: true } as any,
      access: { userId: 'yjs-bridge', permissions: [], isAdminRole: false },
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
    expect(mockGetWriteInput).toHaveBeenCalledWith('rec1', { fld_name: 'abc' })

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
