import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EventConnections, verifyEventReadScope, type EventReadSnapshot, type VerifiedEventReadScope, type EventClient } from '../../src/security-events/runtime'
import { readScopedEvent, readScopedDeliveries } from '../../src/security-events/repository'

afterEach(() => { expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
function fixture(present = true) {
  const client: EventClient = {
    connect: vi.fn(async () => {}), end: vi.fn(async () => {}), on: vi.fn(),
    query: vi.fn(async (text: string) => ({ rows: text.includes('SELECT EXISTS') ? [{ present }] : [] })) as EventClient['query'],
  }
  return { client, connections: new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => client) }
}
it('T22 rejects caller-built scopes and main/business connections before issuing SQL', async () => {
  const { connections, client } = fixture()
  const selection = { scope_kind: 'organization' as const, org_id: 'B' }
  await connections.readTransaction(performance.now(), async snapshot => {
    expect(Object.keys(snapshot)).toEqual([])
    expect(snapshot).not.toHaveProperty('query')
    const scope = await verifyEventReadScope(snapshot, selection)
    const count = vi.mocked(client.query).mock.calls.length
    // @ts-expect-error plain scopes have no issuer brand
    await expect(readScopedEvent(snapshot, selection, randomUUID())).rejects.toThrow('E1_QUERY_UNAVAILABLE')
    await expect(readScopedDeliveries(snapshot, { ...scope }, randomUUID())).rejects.toThrow('E1_QUERY_UNAVAILABLE')
    for (const connection of [client, { sql: client, settledAndReleased: Promise.resolve() }]) {
      // @ts-expect-error neither a main connection nor a business transaction is a read snapshot
      await expect(readScopedEvent(connection, scope, randomUUID())).rejects.toThrow('E1_QUERY_UNAVAILABLE')
      // @ts-expect-error issuer also refuses foreign connections
      await expect(verifyEventReadScope(connection, selection)).rejects.toThrow('E1_QUERY_UNAVAILABLE')
    }
    expect(vi.mocked(client.query).mock.calls).toHaveLength(count)
  })
})
it('T22 verifies organization in the same snapshot and retains scoped event/delivery predicates', async () => {
  const { connections, client } = fixture()
  await connections.readTransaction(performance.now(), async snapshot => {
    const selection = { scope_kind: 'organization' as const, org_id: 'B' }
    const scope = await verifyEventReadScope(snapshot, selection)
    selection.org_id = 'A'
    expect(Object.isFrozen(scope)).toBe(true)
    const id = randomUUID()
    expect(await readScopedEvent(snapshot, scope, id)).toBeNull()
    expect(await readScopedDeliveries(snapshot, scope, id)).toEqual([])
    const calls = vi.mocked(client.query).mock.calls
    expect(calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const scoped = calls.filter(([text]) => text.includes('IS NOT DISTINCT FROM'))
    expect(scoped).toHaveLength(2)
    for (const [, params] of scoped) expect(params).toEqual(['organization', 'B', id])
    expect(calls.find(([text]) => text.includes('SELECT EXISTS'))?.[1]).toEqual(['B'])
  })
  const missing = fixture(false)
  await expect(missing.connections.readTransaction(performance.now(), snapshot => verifyEventReadScope(snapshot, { scope_kind: 'organization', org_id: 'missing' }))).rejects.toThrow('E1_QUERY_UNAVAILABLE')
})
it('T22 scopes cannot cross snapshots, survive completion or be copied', async () => {
  const a = fixture(), b = fixture()
  let oldSnapshot!: EventReadSnapshot, oldScope!: VerifiedEventReadScope
  await a.connections.readTransaction(performance.now(), async snapshot => {
    oldSnapshot = snapshot
    oldScope = await verifyEventReadScope(snapshot, { scope_kind: 'system', org_id: null })
    await b.connections.readTransaction(performance.now(), async other => {
      await expect(readScopedEvent(other, oldScope, randomUUID())).rejects.toThrow('E1_QUERY_UNAVAILABLE')
    })
    expect(await readScopedEvent(snapshot, oldScope, randomUUID())).toBeNull()
  })
  await expect(readScopedDeliveries(oldSnapshot, oldScope, randomUUID())).rejects.toThrow('E1_QUERY_UNAVAILABLE')
  await expect(verifyEventReadScope(oldSnapshot, { scope_kind: 'system', org_id: null })).rejects.toThrow('E1_QUERY_UNAVAILABLE')
})
it('T22 a timed-out callback cannot keep a live read snapshot', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const { connections } = fixture()
  let snapshot!: EventReadSnapshot, scope!: VerifiedEventReadScope, release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const pending = connections.readTransaction(performance.now(), async current => {
    snapshot = current; scope = await verifyEventReadScope(current, { scope_kind: 'system', org_id: null }); await hold
  })
  const rejected = expect(pending).rejects.toThrow('E1_QUERY_UNAVAILABLE')
  try {
    await vi.advanceTimersByTimeAsync(2000); await rejected
    await expect(readScopedEvent(snapshot, scope, randomUUID())).rejects.toThrow('E1_QUERY_UNAVAILABLE')
  } finally { release(); vi.useRealTimers() }
})
it('T22 scope issuer has no production consumers before the query authorization slice', () => {
  const root = path.resolve(__dirname, '../../src')
  const matches: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && /\bverifyEventReadScope\b/.test(readFileSync(file, 'utf8'))) matches.push(path.relative(root, file))
    }
  }
  walk(root)
  expect(matches).toEqual(['security-events/runtime.ts'])
})
