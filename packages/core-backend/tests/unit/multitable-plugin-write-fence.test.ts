import { describe, expect, it, vi } from 'vitest'

import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
import {
  PLUGIN_WRITE_FENCE_ALLOW_LIST,
  PLUGIN_WRITE_FENCE_CODES,
  PluginWriteFenceError,
  assertPluginWriteFence,
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
