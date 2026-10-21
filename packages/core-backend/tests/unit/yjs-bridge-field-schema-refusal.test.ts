/**
 * Field retype slice 3b — what the realtime (Yjs) bridge does with a write the database refused because the
 * column changed type while the flush was waiting (409 FIELD_SCHEMA_CHANGED).
 *
 * Design lock: docs/development/multitable-field-retype-first-batch-adr-20260926.md 增补 C.
 *
 * Three layers, each with its own reason to exist:
 *   1. `YjsRecordBridge.setRefusalHandler` — the seam. With no handler the bridge behaves exactly as before.
 *   2. `createFieldSchemaRefusalHandler` — the decision: only `FieldSchemaChangedError`, only with BOTH flags on.
 *   3. src/index.ts — the wiring. It cannot be executed in a test (it lives inside the server's start-up), so its
 *      text is pinned: a handler that is never attached would leave layers 1 and 2 green and the product silent.
 * The end-to-end proof (real bridge, real socket, real database, the real conversion) is in
 * tests/integration/multitable-field-retype-convert-realdb.cases.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFieldSchemaRefusalHandler, createYjsInvalidator } from '../../src/collab/yjs-invalidation'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { SheetWriterBlockedError } from '../../src/multitable/canonical-sheet-fence'
import { FieldSchemaChangedError } from '../../src/multitable/field-schema-fence-recheck'

const CONVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'
const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const RECORD = 'rec_1'
const FIELD = 'fld_1'

function makePersistence() {
  return {
    loadDoc: vi.fn(async () => null),
    storeUpdate: vi.fn(async () => {}),
    storeSnapshot: vi.fn(async () => {}),
    compactDoc: vi.fn(async () => {}),
    purgeRecords: vi.fn(async () => {}),
  }
}

function makeBridge(patchRecords: () => Promise<unknown>) {
  const persistence = makePersistence()
  const syncService = new YjsSyncService(persistence as never, async () => ({ [FIELD]: 'before' }))
  const recordWriteService = { patchRecords: vi.fn(patchRecords) }
  const bridge = new YjsRecordBridge(
    syncService as never,
    recordWriteService as never,
    async () => ({
      sheetId: 'sh_1',
      changesByRecord: new Map(),
      actorId: 'user_1',
      fields: [],
      visiblePropertyFields: [],
      visiblePropertyFieldIds: new Set(),
      attachmentFields: [],
      fieldById: new Map(),
      capabilities: {} as never,
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
    }) as never,
    { mergeWindowMs: 5, maxDelayMs: 10 },
  )
  return { bridge, syncService, persistence, recordWriteService }
}

/** One realtime edit: a remote client appends to the text cell. Returns once the flush has settled. */
async function editAndFlush(parts: ReturnType<typeof makeBridge>): Promise<void> {
  const doc = await parts.syncService.getOrCreateDoc(RECORD)
  parts.bridge.observe(RECORD, doc)
  doc.transact(() => {
    const text = doc.getMap('fields').get(FIELD) as Y.Text
    text.insert(text.length, ' edited')
  }, 'socket-1')
  await vi.waitFor(() => expect(parts.recordWriteService.patchRecords).toHaveBeenCalledTimes(1))
  // the failure branch, then the handler's own microtask
  await vi.waitFor(() => {
    const m = parts.bridge.getMetrics()
    expect(m.flushSuccessCount + m.flushFailureCount).toBe(1)
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const SAVED: Record<string, string | undefined> = {}
let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  for (const name of [CONVERT_FLAG, FENCE_FLAG]) SAVED[name] = process.env[name]
  process.env[CONVERT_FLAG] = 'true'
  process.env[FENCE_FLAG] = 'true'
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const name of [CONVERT_FLAG, FENCE_FLAG]) {
    if (SAVED[name] === undefined) delete process.env[name]
    else process.env[name] = SAVED[name]
  }
  errorLog.mockRestore()
})

describe('YjsRecordBridge — the refusal seam', () => {
  it('a refused flush reaches the handler with the record id and the error as thrown; the failure is still counted and logged', async () => {
    const refused = new FieldSchemaChangedError()
    const parts = makeBridge(async () => { throw refused })
    const told: Array<[string, unknown]> = []
    parts.bridge.setRefusalHandler((recordId, error) => { told.push([recordId, error]) })

    await editAndFlush(parts)

    expect(told).toEqual([[RECORD, refused]])
    expect(told[0][1]).toBe(refused)
    expect(parts.bridge.getMetrics()).toMatchObject({ flushSuccessCount: 0, flushFailureCount: 1 })
    expect(errorLog).toHaveBeenCalledTimes(1)
  })

  it('a flush that lands never reaches the handler', async () => {
    const parts = makeBridge(async () => ({ updated: [{ recordId: RECORD, version: 2 }] }))
    const told: unknown[] = []
    parts.bridge.setRefusalHandler((recordId) => { told.push(recordId) })

    await editAndFlush(parts)

    expect(told).toEqual([])
    expect(parts.bridge.getMetrics()).toMatchObject({ flushSuccessCount: 1, flushFailureCount: 0 })
  })

  it('no handler attached: a refused flush is counted and logged, nothing else happens (the behaviour before this slice)', async () => {
    const parts = makeBridge(async () => { throw new FieldSchemaChangedError() })

    await editAndFlush(parts)

    expect(parts.bridge.getMetrics()).toMatchObject({ flushSuccessCount: 0, flushFailureCount: 1 })
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(parts.persistence.purgeRecords).not.toHaveBeenCalled()
    expect(parts.syncService.getDoc(RECORD)).toBeDefined()
  })

  it('a handler that throws, or rejects, is logged and changes nothing about the flush outcome', async () => {
    for (const handler of [
      () => { throw new Error('handler threw') },
      async () => { throw new Error('handler rejected') },
    ]) {
      errorLog.mockClear()
      const parts = makeBridge(async () => { throw new FieldSchemaChangedError() })
      parts.bridge.setRefusalHandler(handler)

      await editAndFlush(parts)

      expect(parts.bridge.getMetrics()).toMatchObject({ flushSuccessCount: 0, flushFailureCount: 1 })
      expect(errorLog.mock.calls.map((call) => String(call[0]))).toEqual([
        `[yjs-bridge] Failed to flush patch for record ${RECORD}:`,
        `[yjs-bridge] Refusal handler failed for record ${RECORD}:`,
      ])
    }
  })

  it('detaching the handler (null) restores the silent behaviour', async () => {
    const parts = makeBridge(async () => { throw new FieldSchemaChangedError() })
    const told: unknown[] = []
    parts.bridge.setRefusalHandler((recordId) => { told.push(recordId) })
    parts.bridge.setRefusalHandler(null)

    await editAndFlush(parts)

    expect(told).toEqual([])
  })
})

describe('createFieldSchemaRefusalHandler — which refusals invalidate the document', () => {
  const invalidated: string[][] = []
  const handler = createFieldSchemaRefusalHandler(async (ids) => { invalidated.push([...ids]) })
  beforeEach(() => { invalidated.length = 0 })

  it('both flags on + FieldSchemaChangedError ⇒ that record, and only that record, is invalidated', async () => {
    await handler(RECORD, new FieldSchemaChangedError())
    expect(invalidated).toEqual([[RECORD]])
  })

  it('every other refusal is left as it was: validation, a recovery in progress, a plain error, a look-alike object', async () => {
    const lookAlike = Object.assign(new Error('A field this write touches changed type or options while the write was waiting; reload and retry'), { code: 'FIELD_SCHEMA_CHANGED', statusCode: 409 })
    for (const error of [new Error('Invalid select option'), new SheetWriterBlockedError('sh_1', 'applying'), lookAlike, 'a string', null, undefined]) {
      await handler(RECORD, error)
    }
    expect(invalidated).toEqual([])
  })

  it('either flag off ⇒ nothing, even when handed the error itself', async () => {
    for (const [convert, fence] of [['false', 'true'], ['true', 'false'], [undefined, 'true'], ['true', undefined], ['TRUE', 'true'], ['1', 'true'], [undefined, undefined]] as const) {
      if (convert === undefined) delete process.env[CONVERT_FLAG]
      else process.env[CONVERT_FLAG] = convert
      if (fence === undefined) delete process.env[FENCE_FLAG]
      else process.env[FENCE_FLAG] = fence
      await handler(RECORD, new FieldSchemaChangedError())
    }
    expect(invalidated).toEqual([])
  })
})

describe('createYjsInvalidator — the order is the contract', () => {
  const calls: string[] = []
  const parts = (invalidateDocs: () => Promise<void>) => ({
    bridge: { cancelPending: (ids: string[]) => { calls.push(`cancelPending ${ids.join(',')}`) } },
    syncService: { invalidateDocs: async (ids: string[]) => { calls.push(`invalidateDocs ${ids.join(',')}`); await invalidateDocs() } },
    adapter: { notifyInvalidated: (ids: string[]) => { calls.push(`notifyInvalidated ${ids.join(',')}`) } },
  })
  beforeEach(() => { calls.length = 0 })

  it('pending flushes are cancelled first, the documents dropped, the editors told', async () => {
    await createYjsInvalidator(parts(async () => {}))(['a', 'b'])
    expect(calls).toEqual(['cancelPending a,b', 'invalidateDocs a,b', 'notifyInvalidated a,b'])
  })

  it('the editors are told even when dropping the persisted state failed; the failure reaches the caller', async () => {
    await expect(createYjsInvalidator(parts(async () => { throw new Error('purge failed') }))(['a'])).rejects.toThrow('purge failed')
    expect(calls).toEqual(['cancelPending a', 'invalidateDocs a', 'notifyInvalidated a'])
  })

  it('no record ⇒ nothing is called', async () => {
    await createYjsInvalidator(parts(async () => {}))([])
    expect(calls).toEqual([])
  })
})

describe('the bridge, the handler and the invalidator together (no database)', () => {
  it('a FIELD_SCHEMA_CHANGED refusal drops the record document and its persisted state, and tells the room once', async () => {
    const parts = makeBridge(async () => { throw new FieldSchemaChangedError() })
    const notified: string[][] = []
    const invalidate = createYjsInvalidator({
      bridge: parts.bridge,
      syncService: parts.syncService,
      adapter: { notifyInvalidated: (ids) => { notified.push([...ids]) } },
    })
    parts.bridge.setRefusalHandler(createFieldSchemaRefusalHandler(invalidate))

    await editAndFlush(parts)

    expect(notified).toEqual([[RECORD]])
    expect(parts.persistence.purgeRecords).toHaveBeenCalledWith([RECORD])
    expect(parts.syncService.getDoc(RECORD)).toBeUndefined()
    // a reopened document is seeded again from the record, not from the refused edit
    const reopened = await parts.syncService.getOrCreateDoc(RECORD)
    expect(String(reopened.getMap('fields').get(FIELD))).toBe('before')
  })

  it('a validation refusal on the same bridge is NOT turned into an invalidation (unchanged behaviour, stated)', async () => {
    const parts = makeBridge(async () => { throw new Error('Invalid select option') })
    const notified: string[][] = []
    const invalidate = createYjsInvalidator({
      bridge: parts.bridge,
      syncService: parts.syncService,
      adapter: { notifyInvalidated: (ids) => { notified.push([...ids]) } },
    })
    parts.bridge.setRefusalHandler(createFieldSchemaRefusalHandler(invalidate))

    await editAndFlush(parts)

    expect(notified).toEqual([])
    expect(parts.syncService.getDoc(RECORD)).toBeDefined()
    expect(parts.bridge.getMetrics()).toMatchObject({ flushFailureCount: 1 })
  })
})

describe('src/index.ts wires it (text pin — the start-up code cannot be executed here)', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('the invalidator handed to the routes and to the post-commit hooks is the one built by createYjsInvalidator, from the live bridge, sync service and socket adapter', () => {
    expect(source.split('const yjsInvalidate = createYjsInvalidator({ bridge: yjsBridge, syncService: yjsSyncService, adapter: yjsWsAdapter })')).toHaveLength(2)
    expect(source.split('const yjsInvalidate = ')).toHaveLength(2)
    expect(source).toContain('createYjsInvalidationPostCommitHook(yjsInvalidate),')
    expect(source).toContain('univerMetaModule.setYjsInvalidatorForRoutes(yjsInvalidate)')
  })

  it('the refusal handler is attached to the live bridge, with that same invalidator, after the bridge is built', () => {
    const attach = 'yjsBridge.setRefusalHandler(createFieldSchemaRefusalHandler(yjsInvalidate))'
    expect(source.split(attach)).toHaveLength(2)
    expect(source.indexOf('const yjsBridge = new YjsRecordBridge(')).toBeGreaterThan(-1)
    expect(source.indexOf(attach)).toBeGreaterThan(source.indexOf('const yjsBridge = new YjsRecordBridge('))
    expect(source.indexOf(attach)).toBeGreaterThan(source.indexOf('const yjsInvalidate = createYjsInvalidator('))
    expect(source).toContain("const { createYjsInvalidator, createFieldSchemaRefusalHandler } = await import('./collab/yjs-invalidation')")
  })
})
