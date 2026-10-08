import type { Pool, PoolClient } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { captureRecoveryArchiveBoundedDatabaseSource } from '../../src/multitable/recovery-archive-capture-executor'

const clock = vi.hoisted(() => ({ value: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.value } }))
const scope = { workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' }
const limits = { maxBytes: 4096, timeoutMs: 40 }
const code = 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function ownedPool(stall?: string, lateRestore = false) {
  const gate = deferred<{ rows: unknown[] }>()
  const pendingClient = deferred<PoolClient>()
  const release = vi.fn()
  let stalled = false
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const stage = sql.startsWith('BEGIN') ? 'begin' : sql === 'COMMIT' ? 'commit'
      : sql.startsWith('SELECT set_config') ? params[0] === '30s' ? 'restore' : 'install'
        : sql.startsWith('WITH scope') ? 'source' : sql.includes(' AS present') ? 'scope' : 'prelude'
    if (stage === 'restore' && lateRestore) clock.value = 41
    if (stage === stall && !stalled) { stalled = true; return gate.promise }
    if (stage === 'begin' || stage === 'commit') return { rows: [] }
    if (stage === 'restore' || stage === 'install') return { rows: [{ set_config: params[0] }] }
    if (stage === 'scope') return { rows: [{ xid: '42', present: true }] }
    if (stage === 'source') return { rows: [{ xid: '42', entity_key: null, payload_bytes: null, payload: null }] }
    return { rows: [{ xid: '42', isolation: 'repeatable read', statement_timeout: '30s', advisory_held: false }] }
  })
  const client = { query, release } as unknown as PoolClient
  const connect = vi.fn(() => stall === 'connect' ? pendingClient.promise : Promise.resolve(client))
  const pool = { connect, options: { connectionTimeoutMillis: 10 } } as unknown as Pick<Pool, 'connect' | 'options'>
  return { pool, query, release, gate, pendingClient, client }
}

beforeEach(() => { clock.value = 0 })

describe('private connection-owned capture lifecycle', () => {
  it('returns detached metadata only after confirmed COMMIT and one healthy release', async () => {
    const owned = ownedPool()
    await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits)).resolves.toEqual({
      sections: { schema: [], records: [], links: [], field_value_tombstones: [],
        link_tombstones: [], auto_number: [], views_config: [] }, attachmentCandidates: [],
    })
    expect(owned.query.mock.calls[0]).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', []])
    expect(owned.query.mock.calls.at(-1)).toEqual(['COMMIT', []])
    expect(owned.release.mock.calls).toEqual([[]])
  })

  it.each(['begin', 'prelude', 'install', 'scope', 'source', 'restore', 'commit'])
   ('stalled %s destroys exactly once and the losing continuation sends no later SQL', async (stage) => {
      const owned = ownedPool(stage)
      await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits))
        .rejects.toMatchObject({ code, message: code })
      expect(owned.release.mock.calls).toEqual([[true]])
      const statements = owned.query.mock.calls.length
      owned.gate.resolve({ rows: [{ xid: '42', present: true }] })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(owned.query).toHaveBeenCalledTimes(statements)
      expect(owned.release.mock.calls).toEqual([[true]])
    })

  it('a late acquired connection is discarded before BEGIN and is never returned healthy', async () => {
    const owned = ownedPool('connect')
    await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits))
      .rejects.toMatchObject({ code })
    expect(owned.query).not.toHaveBeenCalled()
    expect(owned.release).not.toHaveBeenCalled()
    owned.pendingClient.resolve(owned.client)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(owned.query).not.toHaveBeenCalled()
    expect(owned.release.mock.calls).toEqual([[true]])
  })

  it('a restoration completing beyond the budget rejects instead of returning a snapshot', async () => {
    const owned = ownedPool(undefined, true)
    await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits))
      .rejects.toMatchObject({ code })
    expect(owned.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
    expect(owned.release.mock.calls).toEqual([[true]])
  })

  it('completion beyond the budget cannot return a snapshot after healthy COMMIT and release', async () => {
    const owned = ownedPool()
    owned.release.mockImplementation(() => { clock.value = 41 })
    await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits))
      .rejects.toMatchObject({ code })
    expect(owned.query.mock.calls.at(-1)).toEqual(['COMMIT', []])
    expect(owned.release.mock.calls).toEqual([[]])
  })

  it.each([undefined, 0, -1, 1.5, Infinity, 41])('requires finite declared native acquisition policy %#', async (value) => {
    const owned = ownedPool()
    owned.pool.options.connectionTimeoutMillis = value
    await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID' })
    expect(owned.pool.connect).not.toHaveBeenCalled()
    expect(owned.query).not.toHaveBeenCalled()
  })

  it('contains native errors and discards the failed connection', async () => {
    const owned = ownedPool()
    owned.query.mockRejectedValueOnce(new Error('private-native-value'))
    await expect(captureRecoveryArchiveBoundedDatabaseSource(owned.pool, scope, limits))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE', message: 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE' })
    expect(owned.release.mock.calls).toEqual([[true]])
  })
})
