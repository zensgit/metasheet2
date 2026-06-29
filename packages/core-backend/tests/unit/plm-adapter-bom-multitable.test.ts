import { describe, it, expect, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const createAdapter = (mode: 'yuantus' | 'legacy' | 'mock') => {
  const configService = { get: vi.fn().mockResolvedValue(undefined) }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const adapter = new PLMAdapter(configService as never, logger as never)
  ;(adapter as never as { apiMode: string }).apiMode = mode === 'mock' ? 'yuantus' : mode
  ;(adapter as never as { mockMode: boolean }).mockMode = mode === 'mock'
  return adapter
}

const PROVIDER_CONTEXT = {
  part: { part_id: 'P1', item_number: 'P-001', name: 'Assembly', state: 'Released', generation: 3 },
  lines: [
    { bom_line_id: 'R1', part_id: 'C1', item_number: 'C-001', name: 'Bracket', state: 'Draft', generation: 1, quantity: 2, uom: 'EA', find_num: '10', refdes: 'R1,R2', level: 1, path: ['P1'], path_labels: ['P-001'], source_version: 1, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
  ],
  source_version: 3,
  source_updated_at: '2026-06-05T00:00:00',
  sync_status: 'snapshot',
  template_key: 'bom_review',
}

describe('PLMAdapter.getBomMultitableContext (PLM-COLLAB P3-C)', () => {
  it('yuantus + entitled: relays the provider context', async () => {
    const adapter = createAdapter('yuantus')
    const query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: PROVIDER_CONTEXT }],
    })
    ;(adapter as never as { query: unknown }).query = query

    const result = await adapter.getBomMultitableContext('P1')

    expect(query).toHaveBeenCalledWith('/api/v1/bom/multitable/P1/context')
    expect(result.entitled).toBe(true)
    expect(result.upgrade).toEqual({ available: false })
    expect(result.context).toEqual(PROVIDER_CONTEXT)
  })

  it('yuantus + provider unentitled: entitled:false, null context, upgrade available', async () => {
    const adapter = createAdapter('yuantus')
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: false, upgrade: { available: true }, context: null }],
    })

    const result = await adapter.getBomMultitableContext('P1')

    expect(result.entitled).toBe(false)
    expect(result.context).toBeNull()
    expect(result.upgrade).toEqual({ available: true })
  })

  it('yuantus + entitled:true but no context: nulls the context (defensive)', async () => {
    const adapter = createAdapter('yuantus')
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: null }],
    })

    const result = await adapter.getBomMultitableContext('P1')

    expect(result.entitled).toBe(true)
    expect(result.context).toBeNull()
  })

  it('yuantus + empty/odd response: safe unentitled affordance (no data)', async () => {
    const adapter = createAdapter('yuantus')
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({ data: [] })

    const result = await adapter.getBomMultitableContext('P1')

    expect(result).toEqual({ feature_key: 'bom_multitable', entitled: false, upgrade: { available: true }, context: null })
  })

  it('legacy mode: unentitled affordance WITHOUT a fetch (no such surface)', async () => {
    const adapter = createAdapter('legacy')
    const query = vi.fn()
    ;(adapter as never as { query: unknown }).query = query

    const result = await adapter.getBomMultitableContext('P1')

    expect(result.entitled).toBe(false)
    expect(result.context).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('mock mode: returns a demoable entitled context (so the panel renders locally)', async () => {
    const adapter = createAdapter('mock')
    const result = await adapter.getBomMultitableContext('P9')

    expect(result.entitled).toBe(true)
    expect(result.context).not.toBeNull()
    expect(result.context?.part.part_id).toBe('P9')
    expect(result.context?.lines.length).toBeGreaterThan(0)
    // the stable row key + hierarchy are present in the mock too
    expect(result.context?.lines[0].bom_line_id).toBeTruthy()
    expect(result.context?.template_key).toBe('bom_review')
  })

  it('yuantus + entitled but MALFORMED context (a required line field renamed/removed): THROWS so the relay degrades to a visible error, not silent corrupt rows', async () => {
    const adapter = createAdapter('yuantus')
    // the silent-corruption scenario: the stable row key `bom_line_id` is renamed away
    const drifted = {
      ...PROVIDER_CONTEXT,
      lines: [{ ...PROVIDER_CONTEXT.lines[0], bom_line_id: undefined, bomLineId: 'R1' }],
    }
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: drifted }],
    })

    await expect(adapter.getBomMultitableContext('P1')).rejects.toThrow(/malformed/i)
  })

  it('yuantus + entitled with EXTRA unknown fields: still relays (benign provider additions do not trip the guard)', async () => {
    const adapter = createAdapter('yuantus')
    const withExtra = {
      ...PROVIDER_CONTEXT,
      some_new_top_level_field: true,
      lines: [{ ...PROVIDER_CONTEXT.lines[0], some_new_line_field: 'x' }],
    }
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: withExtra }],
    })

    const result = await adapter.getBomMultitableContext('P1')

    expect(result.entitled).toBe(true)
    expect(result.context).toEqual(withExtra)
  })

  it('yuantus + entitled but a DISPLAYED field drifts (quantity renamed -> qty): THROWS (display drift is the same failure class as a missing row key)', async () => {
    const adapter = createAdapter('yuantus')
    const drifted = {
      ...PROVIDER_CONTEXT,
      lines: [{ ...PROVIDER_CONTEXT.lines[0], quantity: undefined, qty: 2 }],
    }
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: drifted }],
    })

    await expect(adapter.getBomMultitableContext('P1')).rejects.toThrow(/malformed/i)
  })

  it('yuantus + entitled with legitimate null cells (quantity/uom/source_updated_at = null): relays (null is a valid value, not drift)', async () => {
    const adapter = createAdapter('yuantus')
    const withNulls = {
      ...PROVIDER_CONTEXT,
      source_version: null,
      source_updated_at: null,
      lines: [{ ...PROVIDER_CONTEXT.lines[0], quantity: null, uom: null, item_number: null, source_version: null, source_updated_at: null }],
    }
    ;(adapter as never as { query: unknown }).query = vi.fn().mockResolvedValue({
      data: [{ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: withNulls }],
    })

    const result = await adapter.getBomMultitableContext('P1')

    expect(result.entitled).toBe(true)
    expect(result.context).toEqual(withNulls)
  })
})

describe('PLMAdapter.updateBomMultitableLine (PLM-COLLAB P3 — thin success-only write-back)', () => {
  it('empty patch ({}): returns an error AND issues NO request (rejected before any network/mock branch)', async () => {
    const adapter = createAdapter('yuantus')
    const select = vi.fn()
    ;(adapter as never as { select: unknown }).select = select

    const result = await adapter.updateBomMultitableLine('P4', 'R8', {})

    expect(result.data).toEqual([])
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toBe('updateBomMultitableLine requires at least one of quantity, uom, find_num, refdes')
    expect(select).not.toHaveBeenCalled()
  })

  it('only-undefined patch: same as empty — error, no request', async () => {
    const adapter = createAdapter('yuantus')
    const select = vi.fn()
    ;(adapter as never as { select: unknown }).select = select

    const result = await adapter.updateBomMultitableLine('P4', 'R8', { quantity: undefined, uom: undefined })

    expect(result.error).toBeInstanceOf(Error)
    expect(select).not.toHaveBeenCalled()
  })

  it('unknown keys are stripped: only whitelisted cells reach select', async () => {
    const adapter = createAdapter('yuantus')
    const select = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R8' }], metadata: { totalCount: 1 } })
    ;(adapter as never as { select: unknown }).select = select

    await adapter.updateBomMultitableLine('P4', 'R8', {
      quantity: 6,
      // a non-whitelisted key the caller should never be able to write
      eco_id: 'E9',
      applied: true,
    } as never)

    expect(select).toHaveBeenCalledTimes(1)
    const [, options] = select.mock.calls[0]
    expect(options.method).toBe('PATCH')
    // only the whitelisted, defined keys survive — eco_id/applied are gone
    expect(Object.keys(options.data).sort()).toEqual(['quantity'])
    expect(options.data).toEqual({ quantity: 6 })
  })

  it('valid patch in yuantus mode: select called once with PATCH + the line path + only whitelisted keys', async () => {
    const adapter = createAdapter('yuantus')
    const select = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R8' }], metadata: { totalCount: 1 } })
    ;(adapter as never as { select: unknown }).select = select

    const result = await adapter.updateBomMultitableLine('P4', 'R8', {
      quantity: 6,
      uom: 'ea',
      find_num: '20',
      refdes: 'B2',
    })

    expect(select).toHaveBeenCalledTimes(1)
    const [path, options] = select.mock.calls[0]
    expect(path).toBe('/api/v1/bom/multitable/P4/lines/R8')
    expect(options.method).toBe('PATCH')
    expect(options.data).toEqual({ quantity: 6, uom: 'ea', find_num: '20', refdes: 'B2' })
    expect(result.data?.[0]).toEqual({ ok: true, bom_line_id: 'R8' })
  })

  it('mints a FRESH per-edit Idempotency-Key header on each governed write (two successive writes generate DIFFERENT keys)', async () => {
    const adapter = createAdapter('yuantus')
    const select = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R8' }], metadata: { totalCount: 1 } })
    ;(adapter as never as { select: unknown }).select = select

    await adapter.updateBomMultitableLine('P4', 'R8', { quantity: 6 })
    await adapter.updateBomMultitableLine('P4', 'R8', { quantity: 7 })

    expect(select).toHaveBeenCalledTimes(2)
    const [, firstOptions] = select.mock.calls[0]
    const [, secondOptions] = select.mock.calls[1]
    const firstKey = firstOptions.headers['Idempotency-Key']
    const secondKey = secondOptions.headers['Idempotency-Key']

    // present and NON-EMPTY on each call (the per-edit governed-write seam)
    expect(typeof firstKey).toBe('string')
    expect(firstKey.length).toBeGreaterThan(0)
    expect(typeof secondKey).toBe('string')
    expect(secondKey.length).toBeGreaterThan(0)

    // per-edit generation: a retried/second write must NOT reuse the same key
    expect(firstKey).not.toBe(secondKey)
  })

  it('null cell is a real "clear" edit, not empty: kept in payload, request issued', async () => {
    const adapter = createAdapter('yuantus')
    const select = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R8' }], metadata: { totalCount: 1 } })
    ;(adapter as never as { select: unknown }).select = select

    await adapter.updateBomMultitableLine('P4', 'R8', { refdes: null })

    expect(select).toHaveBeenCalledTimes(1)
    const [, options] = select.mock.calls[0]
    expect(options.data).toEqual({ refdes: null })
  })

  it('mock mode: returns a demoable { ok, bom_line_id } without a network call', async () => {
    const adapter = createAdapter('mock')
    const select = vi.fn()
    ;(adapter as never as { select: unknown }).select = select

    const result = await adapter.updateBomMultitableLine('P4', 'R8', { quantity: 6 })

    expect(select).not.toHaveBeenCalled()
    expect(result.data?.[0]).toEqual({ ok: true, bom_line_id: 'R8' })
  })

  it('legacy mode: unsupported affordance WITHOUT a request', async () => {
    const adapter = createAdapter('legacy')
    const select = vi.fn()
    ;(adapter as never as { select: unknown }).select = select

    const result = await adapter.updateBomMultitableLine('P4', 'R8', { quantity: 6 })

    expect(result.data).toEqual([])
    expect(result.error).toBeInstanceOf(Error)
    expect(select).not.toHaveBeenCalled()
  })
})
