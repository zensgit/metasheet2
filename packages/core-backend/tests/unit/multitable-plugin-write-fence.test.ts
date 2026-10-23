import { describe, expect, it, vi } from 'vitest'

import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
import {
  PLUGIN_WRITE_FENCE_ALLOW_LIST,
  PLUGIN_WRITE_FENCE_CODES,
  PluginWriteFenceError,
  assertPluginWriteFence,
  refusePluginWriteFenceOnUnfencedSurface,
  resolvePluginWriteFence,
} from '../../src/multitable/plugin-write-fence'

// PR #6501 (Codex review P1-a): the host half of a plugin's fenced record write. Every value is synthetic.

const PLUGIN = 'plugin-integration-core'
const LOCK = 'integration_stock_prep_project_write_lock'
const FENCE_SQL = 'SELECT 1 FROM integration_stock_prep_project_write_lock'
  + ' WHERE scope_key = $1 AND lease_id = $2 AND fencing_epoch = $3 AND generation_token = $4'
  + ' FOR SHARE'

function fence(overrides: Record<string, unknown> = {}) {
  return {
    lock: LOCK,
    scopeKey: 'spw2:syn-swl-host',
    leaseId: 'lease-syn-swl-host',
    fencingEpoch: 4,
    generationToken: 'gen-syn-swl-host',
    ...overrides,
  }
}

function expectFenceError(error: unknown, code: string, status: number, reason?: string) {
  expect(error).toBeInstanceOf(PluginWriteFenceError)
  const fenceError = error as PluginWriteFenceError
  expect(fenceError.code).toBe(code)
  expect(fenceError.status).toBe(status)
  if (reason !== undefined) expect(fenceError.details.reason).toBe(reason)
}

function catchSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('plugin write fence: the hard-coded allow-list', () => {
  it('names exactly one plugin, its one lease table, and a fixed FOR SHARE statement', () => {
    expect(Object.keys(PLUGIN_WRITE_FENCE_ALLOW_LIST)).toEqual([PLUGIN])
    expect(PLUGIN_WRITE_FENCE_ALLOW_LIST[PLUGIN]).toEqual({ lock: LOCK, sql: FENCE_SQL })
    expect(Object.isFrozen(PLUGIN_WRITE_FENCE_ALLOW_LIST)).toBe(true)
    expect(Object.isFrozen(PLUGIN_WRITE_FENCE_ALLOW_LIST[PLUGIN])).toBe(true)
    expect(PLUGIN_WRITE_FENCE_CODES).toEqual({
      NOT_ALLOWED: 'PLUGIN_WRITE_FENCE_NOT_ALLOWED',
      REJECTED: 'PLUGIN_WRITE_FENCE_REJECTED',
      UNAVAILABLE: 'PLUGIN_WRITE_FENCE_UNAVAILABLE',
      UNSUPPORTED: 'PLUGIN_WRITE_FENCE_UNSUPPORTED',
    })
  })
})

describe('resolvePluginWriteFence (plugin-scope half)', () => {
  it('passes "no fence" through as undefined', () => {
    expect(resolvePluginWriteFence(PLUGIN, undefined)).toBeUndefined()
  })

  it('resolves the allow-listed shape into a frozen, host-owned object', () => {
    const resolved = resolvePluginWriteFence(PLUGIN, fence())
    expect(resolved).toEqual({ pluginName: PLUGIN, ...fence() })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('refuses any other plugin, any other lock and any other shape', () => {
    expectFenceError(catchSync(() => resolvePluginWriteFence('plugin-after-sales', fence())), PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403, 'plugin_not_allowed')
    expectFenceError(catchSync(() => resolvePluginWriteFence('__proto__', fence())), PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403, 'plugin_not_allowed')
    expectFenceError(catchSync(() => resolvePluginWriteFence(PLUGIN, fence({ lock: 'meta_records' }))), PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403, 'lock_not_allowed')
    const shapes: unknown[] = [
      null,
      'fence',
      [fence()],
      { ...fence(), extra: 1 },
      (() => { const f: Record<string, unknown> = fence(); delete f.generationToken; return f })(),
      fence({ fencingEpoch: -1 }),
      fence({ fencingEpoch: 1.5 }),
      fence({ fencingEpoch: '4' }),
      fence({ scopeKey: '' }),
      fence({ leaseId: 7 }),
      fence({ generationToken: 'x'.repeat(201) }),
    ]
    for (const shape of shapes) {
      expectFenceError(catchSync(() => resolvePluginWriteFence(PLUGIN, shape)), PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403)
    }
  })

  // Review round 6 (N5): read-once. A getter that answers a VALID value to the validation and another
  // value afterwards must not get the other value into the resolved fence (nor past the validation).
  it('reads every field exactly once: a getter cannot show the validation one value and the host another', () => {
    const reads: Record<string, number> = { lock: 0, scopeKey: 0, leaseId: 0, fencingEpoch: 0, generationToken: 0 }
    const first = fence()
    const later = { lock: 'meta_records', scopeKey: 'spw2:syn-other', leaseId: 'lease-syn-other', fencingEpoch: -1, generationToken: 'gen-syn-other' }
    const shifty: Record<string, unknown> = {}
    for (const key of Object.keys(first) as Array<keyof typeof first>) {
      Object.defineProperty(shifty, key, {
        enumerable: true,
        get() {
          reads[key] += 1
          return reads[key] === 1 ? first[key] : later[key]
        },
      })
    }
    const resolved = resolvePluginWriteFence(PLUGIN, shifty)
    expect(resolved).toEqual({ pluginName: PLUGIN, ...first })
    expect(reads).toEqual({ lock: 1, scopeKey: 1, leaseId: 1, fencingEpoch: 1, generationToken: 1 })
  })
})

// Review round 6 (S2): "a writeFence is never silently ignored" — the surfaces that implement no fence
// REFUSE an input carrying one (501, distinct code, nothing written) instead of dropping it.
describe('refusePluginWriteFenceOnUnfencedSurface', () => {
  it('passes an input without a fence (absent or undefined) and refuses any present value, naming the surface', () => {
    expect(() => refusePluginWriteFenceOnUnfencedSurface({ sheetId: 'sheet_syn', recordId: 'rec_1' }, 'records.deleteRecord')).not.toThrow()
    expect(() => refusePluginWriteFenceOnUnfencedSurface({ sheetId: 'sheet_syn', writeFence: undefined }, 'records.deleteRecord')).not.toThrow()
    expect(() => refusePluginWriteFenceOnUnfencedSurface(undefined, 'records.deleteRecord')).not.toThrow()
    expect(() => refusePluginWriteFenceOnUnfencedSurface(null, 'records.deleteRecord')).not.toThrow()
    for (const value of [fence(), null, false, 0, '', {}, 'fence']) {
      const error = catchSync(() => refusePluginWriteFenceOnUnfencedSurface({ sheetId: 'sheet_syn', recordId: 'rec_1', writeFence: value }, 'records.deleteRecord'))
      expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.UNSUPPORTED, 501)
      expect((error as PluginWriteFenceError).details).toEqual({ surface: 'records.deleteRecord' })
    }
  })
})

describe('every plugin-facing write surface without fencing refuses a fence (plugin-scope)', () => {
  function build(pluginName = PLUGIN) {
    const records = {
      queryRecords: vi.fn(async () => []),
      createRecord: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rec_1', sheetId: input.sheetId, version: 1, data: {} })),
      patchRecord: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rec_1', sheetId: input.sheetId, version: 2, data: {} })),
      deleteRecord: vi.fn(async () => ({ id: 'rec_1', sheetId: 'sheet_syn', version: 2 })),
      supportsWriteFence: true,
    }
    const assertSheetScope = vi.fn(async () => {})
    const uowRecords = {
      queryRecords: vi.fn(async () => []),
      createRecord: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rec_u', sheetId: input.sheetId, version: 1, data: {} })),
      patchRecord: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rec_u', sheetId: input.sheetId, version: 2, data: {} })),
    }
    const runStockPreparationPersistUnitOfWork = vi.fn(async (_input: unknown, operation: (records: typeof uowRecords) => Promise<unknown>) => operation(uowRecords))
    const scoped = createPluginScopedMultitableApi(
      { provisioning: {}, records } as never,
      pluginName,
      { assertSheetScope, runStockPreparationPersistUnitOfWork } as never,
    )
    return { records, uowRecords, scoped, assertSheetScope, runStockPreparationPersistUnitOfWork }
  }
  const unsupported = async (promise: Promise<unknown>, surface: string) => {
    await promise.then(() => { throw new Error('expected a refusal') }, (error) => {
      expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.UNSUPPORTED, 501)
      expect((error as PluginWriteFenceError).details).toEqual({ surface })
    })
  }

  it('deleteRecord: a fence is refused before any scope or host work; without one the delete runs as before', async () => {
    const { records, scoped, assertSheetScope } = build()
    await unsupported(scoped.records.deleteRecord({ sheetId: 'sheet_syn', recordId: 'rec_1', writeFence: fence() } as never), 'records.deleteRecord')
    expect(assertSheetScope).not.toHaveBeenCalled()
    expect(records.deleteRecord).not.toHaveBeenCalled()
    await scoped.records.deleteRecord({ sheetId: 'sheet_syn', recordId: 'rec_1' })
    expect(records.deleteRecord).toHaveBeenCalledWith({ sheetId: 'sheet_syn', recordId: 'rec_1' })
  })

  it('the stock-preparation overview port: create / patch / delete refuse a fence before the sheet is derived', async () => {
    const { records, scoped } = build()
    const port = scoped.records.stockPreparationOverview!
    expect(port).toBeDefined()
    await unsupported(port.createRecord({ projectId: 'tenant_syn:integration-core', data: {}, writeFence: fence() } as never), 'records.stockPreparationOverview.createRecord')
    await unsupported(port.patchRecord({ projectId: 'tenant_syn:integration-core', recordId: 'rec_1', changes: {}, writeFence: fence() } as never), 'records.stockPreparationOverview.patchRecord')
    await unsupported(port.deleteRecord({ projectId: 'tenant_syn:integration-core', recordId: 'rec_1', writeFence: fence() } as never), 'records.stockPreparationOverview.deleteRecord')
    expect(records.createRecord).not.toHaveBeenCalled()
    expect(records.patchRecord).not.toHaveBeenCalled()
    expect(records.deleteRecord).not.toHaveBeenCalled()
  })

  it('the persist unit of work: its create / patch refuse a fence before the sheet check and the host write', async () => {
    const { uowRecords, scoped } = build()
    const sheetIds = ['sheet_syn_a', 'sheet_syn_b', 'sheet_syn_c', 'sheet_syn_d']
    const input = { tenantId: 'tenant_syn', sheetIds, project: { sheetId: 'sheet_syn_a', projectId: 'tenant_syn:integration-core' }, batch: { sheetId: 'sheet_syn_b', snapshotBatchId: 'batch_syn' } }
    await unsupported(
      scoped.records.runStockPreparationPersistUnitOfWork(input as never, async (uow) => uow.createRecord({ sheetId: 'sheet_syn_a', data: {}, writeFence: fence() } as never)),
      'runStockPreparationPersistUnitOfWork.createRecord',
    )
    await unsupported(
      scoped.records.runStockPreparationPersistUnitOfWork(input as never, async (uow) => uow.patchRecord({ sheetId: 'sheet_syn_a', recordId: 'rec_u', changes: {}, writeFence: fence() } as never)),
      'runStockPreparationPersistUnitOfWork.patchRecord',
    )
    // a fence on a sheet OUTSIDE the unit is refused as a fence first (the refusal precedes the sheet check)
    await unsupported(
      scoped.records.runStockPreparationPersistUnitOfWork(input as never, async (uow) => uow.createRecord({ sheetId: 'sheet_syn_elsewhere', data: {}, writeFence: fence() } as never)),
      'runStockPreparationPersistUnitOfWork.createRecord',
    )
    expect(uowRecords.createRecord).not.toHaveBeenCalled()
    expect(uowRecords.patchRecord).not.toHaveBeenCalled()
    // without a fence the unit writes as before
    await scoped.records.runStockPreparationPersistUnitOfWork(input as never, async (uow) => uow.createRecord({ sheetId: 'sheet_syn_a', data: { k: 1 } }))
    expect(uowRecords.createRecord).toHaveBeenCalledWith({ sheetId: 'sheet_syn_a', data: { k: 1 } })
  })
})

describe('the host\'s own unfenced surfaces refuse a fence too (src/index.ts, source pins)', () => {
  it('deleteRecord and the persist unit of work\'s inner create / patch call refusePluginWriteFenceOnUnfencedSurface before their work', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8').split(String.fromCharCode(13)).join('')
    // deleteRecord: the refusal precedes the transaction.
    const deleteHead = source.indexOf('          deleteRecord: async (input) => {')
    expect(deleteHead).toBeGreaterThan(-1)
    const deleteBody = source.slice(deleteHead, source.indexOf('deleteMultitableRecord({', deleteHead))
    const deleteRefusal = deleteBody.indexOf("refusePluginWriteFenceOnUnfencedSurface(input, 'records.deleteRecord')")
    expect(deleteRefusal).toBeGreaterThan(-1)
    expect(deleteRefusal).toBeLessThan(deleteBody.indexOf('poolManager.get().transaction('))
    // the unit of work: each inner write refuses before its records.ts call.
    const uowHead = source.indexOf('runStockPreparationPersistUnitOfWork: async (')
    expect(uowHead).toBeGreaterThan(-1)
    const uowBody = source.slice(uowHead, source.indexOf('pluginBaseCoreApi', uowHead))
    for (const [surface, write] of [['createRecord', 'createMultitableRecord({'], ['patchRecord', 'patchMultitableRecord({']] as const) {
      const refusal = uowBody.indexOf(`refusePluginWriteFenceOnUnfencedSurface(recordInput, 'runStockPreparationPersistUnitOfWork.${surface}')`)
      expect(refusal, surface).toBeGreaterThan(-1)
      expect(refusal).toBeLessThan(uowBody.indexOf(write, refusal))
    }
  })
})

describe('assertPluginWriteFence (core write-path half)', () => {
  it('runs nothing for an unfenced write', async () => {
    const query = vi.fn()
    await assertPluginWriteFence(query, undefined)
    expect(query).not.toHaveBeenCalled()
  })

  it('refuses a fence that plugin-scope did not resolve, before any query', async () => {
    const query = vi.fn()
    const lookalike = { pluginName: PLUGIN, ...fence() }
    await assertPluginWriteFence(query, lookalike).then(() => { throw new Error('expected a refusal') }, (error) => {
      expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403, 'fence_unresolved')
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('share-locks the allow-listed row with the fixed statement and the four parameters', async () => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }))
    await assertPluginWriteFence(query, resolvePluginWriteFence(PLUGIN, fence()))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(FENCE_SQL, ['spw2:syn-swl-host', 'lease-syn-swl-host', 4, 'gen-syn-swl-host'])
  })

  it('refuses the write when the row no longer matches (409, nothing written)', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await assertPluginWriteFence(query, resolvePluginWriteFence(PLUGIN, fence())).then(() => { throw new Error('expected a refusal') }, (error) => {
      expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.REJECTED, 409)
    })
  })

  it('fails closed (503) when the fence cannot be checked, naming only the SQLSTATE', async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error('deadlock detected on host-syn'), { code: '40P01' }) })
    await assertPluginWriteFence(query, resolvePluginWriteFence(PLUGIN, fence())).then(() => { throw new Error('expected a refusal') }, (error) => {
      expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.UNAVAILABLE, 503)
      expect((error as PluginWriteFenceError).details).toEqual({ sqlState: '40P01' })
    })
  })
})

describe('plugin-scope forwards only host-resolved fences', () => {
  function build(pluginName = PLUGIN, declares = true) {
    const records = {
      queryRecords: vi.fn(async () => []),
      createRecord: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rec_1', sheetId: input.sheetId, version: 1, data: {} })),
      patchRecord: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rec_1', sheetId: input.sheetId, version: 2, data: {} })),
      ...(declares ? { supportsWriteFence: true } : {}),
    }
    const assertSheetScope = vi.fn(async () => {})
    const scoped = createPluginScopedMultitableApi({ provisioning: {}, records } as never, pluginName, { assertSheetScope } as never)
    return { records, scoped, assertSheetScope }
  }

  it('forwards supportsWriteFence only when the wrapped host declares it', () => {
    expect(build(PLUGIN, true).scoped.records.supportsWriteFence).toBe(true)
    expect(build(PLUGIN, false).scoped.records.supportsWriteFence).toBeUndefined()
  })

  it('hands the core write path the RESOLVED fence (which it honours) for create and patch', async () => {
    const { records, scoped } = build()
    await scoped.records.createRecord({ sheetId: 'sheet_syn', data: { k: 1 }, writeFence: fence() } as never)
    await scoped.records.patchRecord({ sheetId: 'sheet_syn', recordId: 'rec_1', changes: { k: 2 }, writeFence: fence() } as never)
    for (const call of [records.createRecord.mock.calls[0][0], records.patchRecord.mock.calls[0][0]]) {
      const forwarded = (call as { writeFence?: unknown }).writeFence
      expect(forwarded).toEqual({ pluginName: PLUGIN, ...fence() })
      const query = vi.fn(async () => ({ rows: [{}] }))
      await assertPluginWriteFence(query, forwarded)
      expect(query).toHaveBeenCalledTimes(1)
    }
  })

  it('forwards no fence key for an unfenced write', async () => {
    const { records, scoped } = build()
    await scoped.records.createRecord({ sheetId: 'sheet_syn', data: { k: 1 } } as never)
    expect(Object.prototype.hasOwnProperty.call(records.createRecord.mock.calls[0][0], 'writeFence')).toBe(false)
  })

  it('refuses a fence from a plugin outside the allow-list, or of the wrong shape, before any scope or host work', async () => {
    for (const [pluginName, value] of [['plugin-after-sales', fence()], [PLUGIN, fence({ lock: 'meta_records' })], [PLUGIN, { ...fence(), sql: 'DROP' }]] as const) {
      const { records, scoped, assertSheetScope } = build(pluginName)
      await scoped.records.createRecord({ sheetId: 'sheet_syn', data: {}, writeFence: value } as never).then(() => { throw new Error('expected a refusal') }, (error) => {
        expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403)
      })
      await scoped.records.patchRecord({ sheetId: 'sheet_syn', recordId: 'rec_1', changes: {}, writeFence: value } as never).then(() => { throw new Error('expected a refusal') }, (error) => {
        expectFenceError(error, PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 403)
      })
      expect(assertSheetScope).not.toHaveBeenCalled()
      expect(records.createRecord).not.toHaveBeenCalled()
      expect(records.patchRecord).not.toHaveBeenCalled()
    }
  })
})

describe('the core records API checks the fence FIRST inside the write transaction (src/index.ts)', () => {
  it('create and patch both run assertPluginWriteFence(txQuery, writeFence) before the record write, and declare support', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8').split(String.fromCharCode(13)).join('')
    expect(source).toMatch(/supportsWriteFence: true,/)
    for (const [hook, write] of [['createRecord', 'createMultitableRecord'], ['patchRecord', 'patchMultitableRecord']] as const) {
      const start = source.indexOf(`          ${hook}: async ({`)
      expect(start).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf(`${write}({`, start))
      expect(body).toMatch(/writeFence \}\) => \{/)
      expect(body).toContain('poolManager.get().transaction(async ({ query }) => {')
      expect(body).toContain('await assertPluginWriteFence(txQuery, writeFence)')
      // nothing between the fence and the record write
      expect(body.trimEnd().endsWith('await assertPluginWriteFence(txQuery, writeFence)\n              return')).toBe(true)
    }
  })
})
