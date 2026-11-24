import { describe, expect, it, vi } from 'vitest'
import type { ListenerState } from '../../src/realtime-authz/admission'
import { DATABASE_IDENTITY_SQL, compareDatabaseIdentity, readDatabaseIdentity, type DatabaseIdentity } from '../../src/realtime-authz/database-identity'
import { createRealtimeDiagnostics } from '../../src/realtime-authz/diagnostics'
import {
  REALTIME_INVALIDATION_CHANNEL,
  aggregateInvalidationTargets,
  decodeInvalidationPayload,
  encodeInvalidationPayload,
  invalidationRef,
  notifyRealtimeInvalidation,
  notifyRealtimeInvalidations,
  type InvalidationTarget,
} from '../../src/realtime-authz/invalidation-notify'
import { PgInvalidationListener, type ListenerClient } from '../../src/realtime-authz/pg-invalidation-listener'
import type { InvalidationScope } from '../../src/realtime-authz/protection'

const IDENTITY: DatabaseIdentity = { systemIdentifier: '7000000000000000001', databaseOid: '16384', timelineId: '1', inRecovery: false }

function identityRow(identity: DatabaseIdentity): Record<string, unknown> {
  return { system_identifier: identity.systemIdentifier, database_oid: identity.databaseOid, timeline_id: identity.timelineId, in_recovery: identity.inRecovery }
}

class FakeClient implements ListenerClient {
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  statements: string[] = []
  ended = false
  connectResult: 'ok' | 'fail' | 'hang' = 'ok'
  /** When set, every query hangs: a session whose peer silently went away. */
  hung = false
  identity: DatabaseIdentity = IDENTITY

  async connect(): Promise<void> {
    if (this.connectResult === 'fail') throw new Error('connect ECONNREFUSED')
    if (this.connectResult === 'hang') await new Promise(() => undefined)
  }
  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.statements.push(sql)
    if (this.hung) await new Promise(() => undefined)
    if (sql === DATABASE_IDENTITY_SQL) return { rows: [identityRow(this.identity)] }
    return { rows: [] }
  }
  on(event: string, handler: (...args: never[]) => void): this {
    (this.handlers[event] ??= []).push(handler as (...args: unknown[]) => void)
    return this
  }
  removeAllListeners(event?: string): this {
    if (event) delete this.handlers[event]
    else this.handlers = {}
    return this
  }
  async end(): Promise<void> { this.ended = true }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers[event] ?? [])]) handler(...args)
  }
}

function setup(options: { poolIdentity?: () => Promise<DatabaseIdentity>; configure?: (client: FakeClient, index: number) => void } = {}) {
  const clients: FakeClient[] = []
  const states: ListenerState[] = []
  const notices: InvalidationScope[] = []
  const diagnostics = createRealtimeDiagnostics()
  let poolHandler: ((query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>) => void) | null = null
  let poolHandlerRemoved = false
  const pool = { identity: IDENTITY as DatabaseIdentity | Error }
  const listener = new PgInvalidationListener({
    createClient: () => {
      const client = new FakeClient()
      options.configure?.(client, clients.length)
      clients.push(client)
      return client
    },
    readPoolIdentity: options.poolIdentity ?? (async () => {
      if (pool.identity instanceof Error) throw pool.identity
      return pool.identity
    }),
    onPoolConnection: (handler) => {
      poolHandler = handler
      return () => { poolHandlerRemoved = true }
    },
    diagnostics,
    probeIntervalMs: 100,
    probeTimeoutMs: 50,
    connectTimeoutMs: 80,
    reconnectMinMs: 20,
    reconnectMaxMs: 80,
  })
  listener.onStateChange((state) => states.push(state))
  listener.onNotice((scope) => notices.push(scope))
  return {
    listener, clients, states, notices, diagnostics, pool,
    newPoolConnection: (identity: DatabaseIdentity) => poolHandler?.(async () => ({ rows: [identityRow(identity)] })),
    poolHandlerRegistered: () => poolHandler !== null,
    poolHandlerRemoved: () => poolHandlerRemoved,
  }
}

describe('invalidation notices', () => {
  it('encodes a versioned payload with an opaque reference and nothing else', () => {
    expect(encodeInvalidationPayload({ kind: 'global' })).toBe('{"v":1,"k":"g"}')
    const user = JSON.parse(encodeInvalidationPayload({ kind: 'user', userId: 'user-42@example.test' }))
    expect(Object.keys(user)).toEqual(['v', 'k', 'r'])
    expect(user).toMatchObject({ v: 1, k: 'u' })
    expect(user.r).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(user)).not.toContain('user-42')
    expect(JSON.stringify(user)).not.toContain('example.test')
    const organization = JSON.parse(encodeInvalidationPayload({ kind: 'organization', organizationId: 'org-secret-name' }))
    expect(organization).toMatchObject({ v: 1, k: 'o' })
    expect(JSON.stringify(organization)).not.toContain('org-secret-name')
    expect(invalidationRef('user', 'a')).toBe(invalidationRef('user', 'a'))
    expect(invalidationRef('user', 'a')).not.toBe(invalidationRef('organization', 'a'))
    expect(invalidationRef('user', 'a')).not.toBe(invalidationRef('user', 'b'))
  })

  it('keeps every payload far below the notification size limit, whatever the id', () => {
    const payload = encodeInvalidationPayload({ kind: 'user', userId: '用户'.repeat(20000) })
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(100)
  })

  it('decodes its own payloads and reads anything else as a global hint', () => {
    const ref = invalidationRef('user', 'u1')
    expect(decodeInvalidationPayload(encodeInvalidationPayload({ kind: 'user', userId: 'u1' }))).toEqual({ kind: 'user', ref })
    expect(decodeInvalidationPayload(encodeInvalidationPayload({ kind: 'organization', organizationId: 'o1' }))).toEqual({ kind: 'organization', ref: invalidationRef('organization', 'o1') })
    for (const payload of [undefined, null, '', 'not json', '{}', '{"v":2,"k":"u","r":"' + ref + '"}', '{"v":1,"k":"u"}', '{"v":1,"k":"u","r":"short"}', '{"v":1,"k":"x","r":"' + ref + '"}', '{"v":1,"k":"g"}', '[1]', 'null']) {
      expect(decodeInvalidationPayload(payload), String(payload)).toEqual({ kind: 'global' })
    }
  })

  it('aggregates the hints of one transaction: duplicates collapse, many users are promoted', () => {
    const user = (id: string): InvalidationTarget => ({ kind: 'user', userId: id })
    expect(aggregateInvalidationTargets([])).toEqual([])
    expect(aggregateInvalidationTargets([user('a'), user('a')])).toEqual([user('a')])
    expect(aggregateInvalidationTargets([user('a'), user('b')])).toEqual([{ kind: 'global' }])
    expect(aggregateInvalidationTargets([user('a'), user('b')], { coveringOrganizationId: 'o1' })).toEqual([{ kind: 'organization', organizationId: 'o1' }])
    expect(aggregateInvalidationTargets([user('a'), { kind: 'global' }])).toEqual([{ kind: 'global' }])
    expect(aggregateInvalidationTargets([{ kind: 'organization', organizationId: 'o1' }, { kind: 'organization', organizationId: 'o2' }])).toEqual([{ kind: 'global' }])
    expect(aggregateInvalidationTargets([{ kind: 'organization', organizationId: 'o1' }, user('a')])).toEqual([{ kind: 'organization', organizationId: 'o1' }, user('a')])
    const twoHundred = Array.from({ length: 200 }, (_unused, index) => user(`u${index}`))
    expect(aggregateInvalidationTargets(twoHundred, { coveringOrganizationId: 'o1' })).toHaveLength(1)
    expect(aggregateInvalidationTargets(twoHundred)).toEqual([{ kind: 'global' }])
  })

  it('sends each notice on the client it is given, on the fixed channel, as one parameterized statement', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = { query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }) } }
    await notifyRealtimeInvalidation(client, { kind: 'user', userId: 'u1' })
    const sent = await notifyRealtimeInvalidations(client, Array.from({ length: 200 }, (_unused, index) => ({ kind: 'user', userId: `u${index}` }) as InvalidationTarget))
    expect(sent).toEqual([{ kind: 'global' }])
    expect(calls).toEqual([
      { sql: 'SELECT pg_catalog.pg_notify($1, $2)', params: [REALTIME_INVALIDATION_CHANNEL, encodeInvalidationPayload({ kind: 'user', userId: 'u1' })] },
      { sql: 'SELECT pg_catalog.pg_notify($1, $2)', params: [REALTIME_INVALIDATION_CHANNEL, '{"v":1,"k":"g"}'] },
    ])
    expect(REALTIME_INVALIDATION_CHANNEL).toBe('metasheet_realtime_invalidation_v1')
  })
})

describe('database identity', () => {
  it('reads a complete identity and rejects an incomplete one', async () => {
    expect(await readDatabaseIdentity(async () => ({ rows: [identityRow(IDENTITY)] }))).toEqual(IDENTITY)
    for (const rows of [[], [identityRow(IDENTITY), identityRow(IDENTITY)], [{ ...identityRow(IDENTITY), system_identifier: null }], [{ ...identityRow(IDENTITY), timeline_id: '' }], [{ ...identityRow(IDENTITY), in_recovery: null }], [{ ...identityRow(IDENTITY), database_oid: 16384 }]]) {
      await expect(readDatabaseIdentity(async () => ({ rows }))).rejects.toThrow('database identity not readable')
    }
  })

  it('compares against the pinned identity field by field', () => {
    expect(compareDatabaseIdentity(IDENTITY, { ...IDENTITY })).toBeNull()
    expect(compareDatabaseIdentity(IDENTITY, { ...IDENTITY, inRecovery: true })).toBe('in-recovery')
    expect(compareDatabaseIdentity(IDENTITY, { ...IDENTITY, systemIdentifier: '7000000000000000002' })).toBe('system-identifier-changed')
    expect(compareDatabaseIdentity(IDENTITY, { ...IDENTITY, databaseOid: '16385' })).toBe('database-changed')
    expect(compareDatabaseIdentity(IDENTITY, { ...IDENTITY, timelineId: '2' })).toBe('timeline-changed')
  })
})

describe('dedicated listening session', () => {
  it('opens nothing until it is started, then exactly one session that listens on the channel', async () => {
    const s = setup()
    expect(s.clients).toHaveLength(0)
    expect(s.listener.state()).toBe('not-started')
    expect(s.poolHandlerRegistered()).toBe(false)
    await s.listener.start()
    await s.listener.start()
    expect(s.clients).toHaveLength(1)
    expect(s.listener.openedSessions()).toBe(1)
    expect(s.clients[0].statements[0]).toBe('LISTEN metasheet_realtime_invalidation_v1')
    expect(s.listener.state()).toBe('ready')
    expect(s.states).toEqual(['not-ready', 'ready'])
    expect(s.listener.pinnedIdentity()).toEqual(IDENTITY)
    await s.listener.stop()
    expect(s.clients[0].ended).toBe(true)
    expect(s.poolHandlerRemoved()).toBe(true)
  })

  it('hands notices of its channel to the runtime and ignores other channels', async () => {
    const s = setup()
    await s.listener.start()
    s.clients[0].emit('notification', { channel: REALTIME_INVALIDATION_CHANNEL, payload: encodeInvalidationPayload({ kind: 'user', userId: 'u1' }) })
    s.clients[0].emit('notification', { channel: 'another_channel', payload: '{"v":1,"k":"g"}' })
    s.clients[0].emit('notification', { channel: REALTIME_INVALIDATION_CHANNEL, payload: 'garbage' })
    expect(s.notices).toEqual([{ kind: 'user', ref: invalidationRef('user', 'u1') }, { kind: 'global' }])
    await s.listener.stop()
  })

  it('is not ready from the moment its session is lost until a new session listens, and backs off between attempts', async () => {
    vi.useFakeTimers()
    try {
      const s = setup({ configure: (client, index) => { if (index === 1 || index === 2) client.connectResult = 'fail' } })
      await s.listener.start()
      s.clients[0].emit('end')
      expect(s.listener.state()).toBe('not-ready')
      // A notice on the lost session is not delivered.
      s.clients[0].emit('notification', { channel: REALTIME_INVALIDATION_CHANNEL, payload: '{"v":1,"k":"g"}' })
      expect(s.notices).toEqual([])
      await vi.advanceTimersByTimeAsync(20)
      expect(s.clients).toHaveLength(2)
      expect(s.listener.state()).toBe('not-ready')
      await vi.advanceTimersByTimeAsync(39)
      expect(s.clients).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(s.clients).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(80)
      expect(s.clients).toHaveLength(4)
      expect(s.listener.state()).toBe('ready')
      expect(s.states).toEqual(['not-ready', 'ready', 'not-ready', 'ready'])
      expect(s.clients[3].statements[0]).toBe('LISTEN metasheet_realtime_invalidation_v1')
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a session that stops answering as lost: the liveness probe has a deadline', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await s.listener.start()
      s.clients[0].hung = true
      await vi.advanceTimersByTimeAsync(100)
      expect(s.listener.state()).toBe('ready')
      await vi.advanceTimersByTimeAsync(50)
      expect(s.listener.state()).toBe('not-ready')
      await vi.advanceTimersByTimeAsync(20)
      expect(s.listener.state()).toBe('ready')
      expect(s.clients).toHaveLength(2)
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not ready when the first session cannot be opened in time, and keeps trying', async () => {
    vi.useFakeTimers()
    try {
      const s = setup({ configure: (client, index) => { if (index === 0) client.connectResult = 'hang' } })
      const starting = s.listener.start()
      await vi.advanceTimersByTimeAsync(80)
      await starting
      expect(s.listener.state()).toBe('not-ready')
      await vi.advanceTimersByTimeAsync(20)
      expect(s.listener.state()).toBe('ready')
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not ready while the business pool cannot be read, and ready again once it can', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      s.pool.identity = new Error('pool down')
      await s.listener.start()
      expect(s.listener.state()).toBe('not-ready')
      expect(s.listener.isolation()).toBeNull()
      s.pool.identity = IDENTITY
      await vi.advanceTimersByTimeAsync(20)
      expect(s.listener.state()).toBe('ready')
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['the listening session and the pool are attached to different databases', { ...IDENTITY, systemIdentifier: '7000000000000000009' }, IDENTITY, 'listener-and-pool-differ'],
    ['the listening session is attached to a server in recovery', { ...IDENTITY, inRecovery: true }, IDENTITY, 'in-recovery'],
    ['the pool is attached to a server in recovery', IDENTITY, { ...IDENTITY, inRecovery: true }, 'in-recovery'],
  ])('isolates at start when %s', async (_label, listenerIdentity, poolIdentity, reason) => {
    const s = setup({ configure: (client) => { client.identity = listenerIdentity }, poolIdentity: async () => poolIdentity })
    await s.listener.start()
    expect(s.listener.state()).toBe('not-ready')
    expect(s.listener.isolation()).toBe(reason)
    expect(s.diagnostics.snapshot().events.map((event) => event.code)).toContain('database-identity-changed')
    await s.listener.stop()
  })

  it.each([
    ['a different cluster', { ...IDENTITY, systemIdentifier: '7000000000000000002' }, 'system-identifier-changed'],
    ['a different database', { ...IDENTITY, databaseOid: '99999' }, 'database-changed'],
    ['a new timeline', { ...IDENTITY, timelineId: '2' }, 'timeline-changed'],
    ['a server in recovery', { ...IDENTITY, inRecovery: true }, 'in-recovery'],
  ])('isolates when both the session and the pool later show %s, and does not reconnect by itself', async (_label, changed, reason) => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await s.listener.start()
      expect(s.listener.state()).toBe('ready')
      s.clients[0].identity = changed
      s.pool.identity = changed
      await vi.advanceTimersByTimeAsync(100)
      expect(s.listener.state()).toBe('not-ready')
      expect(s.listener.isolation()).toBe(reason)
      await vi.advanceTimersByTimeAsync(5000)
      expect(s.clients).toHaveLength(1)
      expect(s.listener.state()).toBe('not-ready')
      // A notice after isolation is not delivered.
      s.clients[0].emit('notification', { channel: REALTIME_INVALIDATION_CHANNEL, payload: '{"v":1,"k":"g"}' })
      expect(s.notices).toEqual([])
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates when the pool moved to another database while the listening session never dropped', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await s.listener.start()
      s.pool.identity = { ...IDENTITY, systemIdentifier: '7000000000000000002' }
      await vi.advanceTimersByTimeAsync(100)
      expect(s.listener.isolation()).toBe('listener-and-pool-differ')
      expect(s.listener.state()).toBe('not-ready')
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates when a new connection of the pool is attached to another database', async () => {
    const s = setup()
    await s.listener.start()
    s.newPoolConnection(IDENTITY)
    await Promise.resolve()
    await Promise.resolve()
    expect(s.listener.state()).toBe('ready')
    s.newPoolConnection({ ...IDENTITY, timelineId: '2' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(s.listener.isolation()).toBe('timeline-changed')
    expect(s.listener.state()).toBe('not-ready')
    await s.listener.stop()
  })

  it('a reconnect to the same database is not isolation; a reconnect to another one is', async () => {
    vi.useFakeTimers()
    try {
      const s = setup({ configure: (client, index) => { if (index === 2) client.identity = { ...IDENTITY, systemIdentifier: '7000000000000000002' } } })
      await s.listener.start()
      s.clients[0].emit('error', new Error('socket hang up'))
      await vi.advanceTimersByTimeAsync(20)
      expect(s.listener.state()).toBe('ready')
      expect(s.listener.isolation()).toBeNull()
      s.clients[1].emit('end')
      s.pool.identity = { ...IDENTITY, systemIdentifier: '7000000000000000002' }
      await vi.advanceTimersByTimeAsync(20)
      expect(s.listener.state()).toBe('not-ready')
      expect(s.listener.isolation()).toBe('system-identifier-changed')
      await s.listener.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
