import { describe, it, expect, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

// Catalog caching (perf: sheet-open request diet). listBases/listTemplates were
// refetched by every mounting surface (workbench, home, field dialogs, template
// views) — these tests pin the per-instance cache, in-flight dedup, mutation
// invalidation, and the copy-on-return guard.

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function basesPayload(ids: string[]) {
  return { ok: true, data: { bases: ids.map((id) => ({ id, name: `Base ${id}` })) } }
}

function templatesPayload(ids: string[]) {
  return { ok: true, data: { templates: ids.map((id) => ({ id, name: `Template ${id}` })) } }
}

describe('MultitableApiClient catalog cache', () => {
  it('serves listBases from cache after the first fetch', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(basesPayload(['b1'])))
    const client = new MultitableApiClient({ fetchFn })

    const first = await client.listBases()
    const second = await client.listBases()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(second.bases.map((b) => b.id)).toEqual(['b1'])
    expect(first.bases).not.toBe(second.bases)
  })

  it('dedupes concurrent listBases calls into one request', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchFn = vi.fn(async () => {
      await gate
      return jsonResponse(basesPayload(['b1']))
    })
    const client = new MultitableApiClient({ fetchFn })

    const inflight = Promise.all([client.listBases(), client.listBases()])
    release?.()
    const [first, second] = await inflight

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(first.bases.map((b) => b.id)).toEqual(['b1'])
    expect(second.bases.map((b) => b.id)).toEqual(['b1'])
  })

  it('mutating a returned array does not pollute the cache', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(basesPayload(['b1'])))
    const client = new MultitableApiClient({ fetchFn })

    const first = await client.listBases()
    first.bases.length = 0
    const second = await client.listBases()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(second.bases.map((b) => b.id)).toEqual(['b1'])
  })

  it('createBase invalidates the bases cache', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ ok: true, data: { base: { id: 'b2', name: 'Base b2' } } })
      }
      return jsonResponse(basesPayload(fetchFn.mock.calls.length > 2 ? ['b1', 'b2'] : ['b1']))
    })
    const client = new MultitableApiClient({ fetchFn })

    await client.listBases()
    await client.createBase({ name: 'Base b2' })
    const after = await client.listBases()

    expect(fetchFn.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2)
    expect(after.bases.map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('installTemplate invalidates the bases cache', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ ok: true, data: { baseId: 'b2' } })
      }
      return jsonResponse(basesPayload(['b1']))
    })
    const client = new MultitableApiClient({ fetchFn })

    await client.listBases()
    await client.installTemplate('tpl_1')
    await client.listBases()

    expect(fetchFn.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2)
  })

  it('caches listTemplates and refetches with force', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(templatesPayload(['t1'])))
    const client = new MultitableApiClient({ fetchFn })

    await client.listTemplates()
    await client.listTemplates()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await client.listTemplates({ force: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('a failed fetch does not poison the cache', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(jsonResponse(basesPayload(['b1'])))
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.listBases()).rejects.toThrow('network down')
    const retry = await client.listBases()

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(retry.bases.map((b) => b.id)).toEqual(['b1'])
  })
})
