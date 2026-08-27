import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  RECOVERY_WRITER_BLOCK_STATES,
  SheetWriterBlockedError,
  claimDurableWriterBlock,
  isWriterFenceEnabled,
  setRecoveryWriterState,
  type FenceQuery,
} from '../../src/multitable/canonical-sheet-fence'
import {
  ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL,
  ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS,
  ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS,
  ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT,
  ARCHIVE_WRITER_BLOCK_TAKEOVER_SQL,
  ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL,
  ArchiveWriterBlockError,
  checkArchiveWriterBlockOwnerExact,
  claimArchiveWriterBlock,
  composeArchiveWriterBlockSchemaFingerprint,
  heartbeatArchiveWriterBlock,
  releaseArchiveWriterBlock,
  type ArchiveWriterBlockSnapshot,
  type ArchiveWriterBlockTransactionRunner,
} from '../../src/multitable/recovery-archive-writer-block'

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const ARCHIVE_FLAG = 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED'
const LEASE = '2099-01-01T00:00:00.000Z'
const UPDATED = '2026-08-27T00:00:00.000Z'

type QueryLog = { sql: string; params?: unknown[] }

function expectedSnapshot(overrides: Partial<ArchiveWriterBlockSnapshot> = {}): ArchiveWriterBlockSnapshot {
  return {
    state: 'archiving',
    ownerKind: 'archive_generation',
    ownerId: 'owner-token',
    fence: '9007199254740993',
    leaseUntil: LEASE,
    updatedAt: UPDATED,
    ...overrides,
  }
}

function mockPreparedRunner(
  log: QueryLog[],
  terminal: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number | null },
): ArchiveWriterBlockTransactionRunner {
  return async <T>(work: (query: FenceQuery) => Promise<T>): Promise<T> => {
    const query: FenceQuery = async (sql, params) => {
      log.push({ sql, params })
      if (sql === ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL) {
        return { rows: [{ xid: '42', isolation: 'read committed' }] }
      }
      if (sql === 'SELECT pg_current_xact_id()::text AS xid') return { rows: [{ xid: '42' }] }
      if (sql.includes('attribute.attname AS column_name')) {
        return { rows: ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS.map((row) => ({ ...row })) }
      }
      if (sql.includes('constraint_row.conname AS constraint_name')) {
        return { rows: ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map((row) => ({ ...row })) }
      }
      return terminal(sql, params)
    }
    return work(query)
  }
}

function rendered(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
}

function enableArchiveWriterBlock(): void {
  process.env[ARCHIVE_FLAG] = 'true'
  process.env[FLAG] = 'true'
}

afterEach(() => {
  delete process.env[ARCHIVE_FLAG]
  delete process.env[FLAG]
})

describe('D2e archive writer-block transaction runner', () => {
  test('exact archive flag is stricter while the existing fence flag remains case-insensitive', async () => {
    process.env[ARCHIVE_FLAG] = 'true'
    const values = [undefined, 'false', 'TRUE', ' true ', 'true ', '1']
    for (const value of values) {
      if (value === undefined) delete process.env[FLAG]
      else process.env[FLAG] = value
      expect(isWriterFenceEnabled()).toBe(
        String(value ?? '').trim().toLowerCase() === 'true',
      )
      let entered = false
      const runner: ArchiveWriterBlockTransactionRunner = async () => {
        entered = true
        throw new Error('must_not_enter')
      }
      await expect(
        claimArchiveWriterBlock(runner, 'sheet-token', {
          ownerKind: 'archive_generation',
          ownerId: 'owner-token',
          leaseUntil: LEASE,
        }),
      ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_DISABLED' })
      expect(entered).toBe(false)
    }

    process.env[FLAG] = 'true'
    for (const value of values) {
      if (value === undefined) delete process.env[ARCHIVE_FLAG]
      else process.env[ARCHIVE_FLAG] = value
      let entered = false
      const runner: ArchiveWriterBlockTransactionRunner = async () => {
        entered = true
        throw new Error('must_not_enter')
      }
      await expect(
        claimArchiveWriterBlock(runner, 'sheet-token', {
          ownerKind: 'archive_generation',
          ownerId: 'owner-token',
          leaseUntil: LEASE,
        }),
      ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_DISABLED' })
      expect(entered).toBe(false)
    }
  })

  test('inputs are validated before entering the injected transaction runner', async () => {
    enableArchiveWriterBlock()
    let entered = false
    const runner: ArchiveWriterBlockTransactionRunner = async () => {
      entered = true
      throw new Error('must_not_enter')
    }
    await expect(
      claimArchiveWriterBlock(runner, ' ', {
        ownerKind: 'archive_generation',
        ownerId: 'owner-token',
        leaseUntil: LEASE,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_INVALID_INPUT' })
    await expect(
      claimArchiveWriterBlock(runner, 'sheet-token', {
        ownerKind: 'foreign' as 'archive_generation',
        ownerId: 'owner-token',
        leaseUntil: LEASE,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_INVALID_INPUT' })
    await expect(
      claimArchiveWriterBlock(runner, 'sheet-token', {
        ownerKind: 'archive_generation',
        ownerId: '',
        leaseUntil: 'not-a-time',
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_INVALID_INPUT' })
    expect(entered).toBe(false)
  })

  test('claim callback first query is source-free fence+xid+isolation, then same-xid, schema, CAS', async () => {
    enableArchiveWriterBlock()
    const log: QueryLog[] = []
    const snapshot = expectedSnapshot()
    const runner = mockPreparedRunner(log, (sql) => {
      expect(sql).toBe(ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL)
      return {
        rows: [{
          state: snapshot.state,
          owner_kind: snapshot.ownerKind,
          owner_id: snapshot.ownerId,
          fence: snapshot.fence,
          lease_until: snapshot.leaseUntil,
          updated_at: snapshot.updatedAt,
        }],
        rowCount: 1,
      }
    })
    await expect(
      claimArchiveWriterBlock(runner, 'sheet-token', {
        ownerKind: snapshot.ownerKind,
        ownerId: snapshot.ownerId,
        leaseUntil: snapshot.leaseUntil,
      }),
    ).resolves.toEqual(snapshot)

    expect(log[0]?.sql).toBe(ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL)
    expect(log[0]?.sql).toContain('pg_advisory_xact_lock')
    expect(log[0]?.sql).toContain('pg_current_xact_id')
    expect(log[0]?.sql).toContain("current_setting('transaction_isolation')")
    expect(log[0]?.sql).not.toMatch(/meta_sheets|meta_records|recovery_writer_state/)
    expect(log[1]?.sql).toBe('SELECT pg_current_xact_id()::text AS xid')
    expect(log.findIndex(({ sql }) => sql.includes('pg_constraint'))).toBeGreaterThan(1)
    expect(log.at(-1)?.sql).toBe(ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL)
  })

  test('autocommit/different xid and non-READ-COMMITTED runners fail before schema or CAS', async () => {
    enableArchiveWriterBlock()
    for (const mutation of ['xid', 'isolation'] as const) {
      const statements: string[] = []
      const runner: ArchiveWriterBlockTransactionRunner = async (work) =>
        work(async (sql) => {
          statements.push(sql)
          if (sql === ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL) {
            return {
              rows: [{
                xid: '42',
                isolation: mutation === 'isolation' ? 'repeatable read' : 'read committed',
              }],
            }
          }
          if (sql === 'SELECT pg_current_xact_id()::text AS xid') {
            return { rows: [{ xid: mutation === 'xid' ? '43' : '42' }] }
          }
          throw new Error('must_not_reach_schema')
        })
      await expect(
        claimArchiveWriterBlock(runner, 'sheet-token', {
          ownerKind: 'archive_generation',
          ownerId: 'owner-token',
          leaseUntil: LEASE,
        }),
      ).rejects.toMatchObject({
        code:
          mutation === 'isolation'
            ? 'ARCHIVE_WRITER_BLOCK_ISOLATION_INVALID'
            : 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION',
      })
      expect(statements).not.toContain(ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL)
    }
  })

  test('takeover, heartbeat, and release CAS the exact full current tuple', async () => {
    enableArchiveWriterBlock()
    const previous = expectedSnapshot({ fence: '9007199254740992' })
    const claimed = expectedSnapshot()
    const claimLog: QueryLog[] = []
    await claimArchiveWriterBlock(
      mockPreparedRunner(claimLog, (sql, params) => {
        expect(sql).toBe(ARCHIVE_WRITER_BLOCK_TAKEOVER_SQL)
        expect(params?.slice(4)).toEqual([
          previous.ownerKind,
          previous.ownerId,
          previous.fence,
          previous.leaseUntil,
          previous.updatedAt,
        ])
        return {
          rows: [{
            state: claimed.state,
            owner_kind: claimed.ownerKind,
            owner_id: claimed.ownerId,
            fence: claimed.fence,
            lease_until: claimed.leaseUntil,
            updated_at: claimed.updatedAt,
          }],
        }
      }),
      'sheet-token',
      {
        ownerKind: claimed.ownerKind,
        ownerId: claimed.ownerId,
        leaseUntil: claimed.leaseUntil,
        previous,
      },
    )
    expect(ARCHIVE_WRITER_BLOCK_TAKEOVER_SQL).toContain('recovery_writer_lease_until = $8::timestamptz')
    expect(ARCHIVE_WRITER_BLOCK_TAKEOVER_SQL).toContain('recovery_writer_updated_at = $9::timestamptz')

    const heartbeatLog: QueryLog[] = []
    const heartbeat = expectedSnapshot({ updatedAt: '2026-08-27T00:01:00.000Z' })
    await heartbeatArchiveWriterBlock(
      mockPreparedRunner(heartbeatLog, (sql, params) => {
        expect(sql).toContain('recovery_writer_lease_until = $5::timestamptz')
        expect(sql).toContain('recovery_writer_updated_at = $6::timestamptz')
        expect(params?.slice(1, 6)).toEqual([
          claimed.ownerKind,
          claimed.ownerId,
          claimed.fence,
          claimed.leaseUntil,
          claimed.updatedAt,
        ])
        return {
          rows: [{
            state: heartbeat.state,
            owner_kind: heartbeat.ownerKind,
            owner_id: heartbeat.ownerId,
            fence: heartbeat.fence,
            lease_until: heartbeat.leaseUntil,
            updated_at: heartbeat.updatedAt,
          }],
        }
      }),
      'sheet-token',
      claimed,
      heartbeat.leaseUntil,
    )

    const releaseLog: QueryLog[] = []
    await releaseArchiveWriterBlock(
      mockPreparedRunner(releaseLog, (sql, params) => {
        expect(sql).toContain('recovery_writer_owner_fence = $4::bigint')
        expect(sql).toContain('recovery_writer_lease_until = $5::timestamptz')
        expect(sql).toContain('recovery_writer_updated_at = $6::timestamptz')
        expect(params?.slice(1)).toEqual([
          heartbeat.ownerKind,
          heartbeat.ownerId,
          heartbeat.fence,
          heartbeat.leaseUntil,
          heartbeat.updatedAt,
        ])
        return { rows: [], rowCount: 1 }
      }),
      'sheet-token',
      heartbeat,
    )
  })
})

describe('D2e schema and compatibility contracts', () => {
  test('fingerprint requires exact owned columns, names, validation and definitions', () => {
    expect(ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT).toBeTruthy()
    expect(
      composeArchiveWriterBlockSchemaFingerprint(
        ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS,
        ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS,
      ),
    ).toBe(ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT)
    expect(
      composeArchiveWriterBlockSchemaFingerprint(
        ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS,
        ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.slice(1),
      ),
    ).toBeNull()
    expect(
      composeArchiveWriterBlockSchemaFingerprint(
        ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS,
        ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map((row, index) =>
          index === 0 ? { ...row, definition: 'CHECK (true)' } : row,
        ),
      ),
    ).toBeNull()
    const source = readFileSync(
      path.resolve(__dirname, '../../src/multitable/recovery-archive-writer-block.ts'),
      'utf8',
    )
    expect(source).toContain('constraint_row.conname = ANY($1::text[])')
    expect(source).not.toContain("conname LIKE 'chk_meta_sheets_recovery_writer_%'")
  })

  test('ordinary recovery helpers recognize archiving while state-only setter cannot write it', async () => {
    const queries: string[] = []
    const query: FenceQuery = async (sql) => {
      queries.push(sql)
      if (sql.includes('information_schema.columns')) return { rows: [{ present: 1 }] }
      if (sql.includes('SELECT recovery_writer_state')) {
        return { rows: [{ recovery_writer_state: 'archiving' }] }
      }
      return { rows: [], rowCount: 1 }
    }
    await expect(claimDurableWriterBlock(query, 'sheet-token')).rejects.toBeInstanceOf(
      SheetWriterBlockedError,
    )
    expect(queries.some((sql) => sql.includes("SET recovery_writer_state = 'applying'"))).toBe(false)

    let setterQueried = false
    await expect(
      setRecoveryWriterState(
        async () => {
          setterQueried = true
          return { rows: [], rowCount: 1 }
        },
        'sheet-token',
        'archiving' as never,
      ),
    ).rejects.toThrow('RECOVERY_WRITER_STATE_INVALID')
    expect(setterQueried).toBe(false)
    expect(RECOVERY_WRITER_BLOCK_STATES).toEqual(['fencing', 'applying', 'paused_retryable'])
  })

  test('low-level exact-owner check is honestly named and enforces unexpired full tuple', async () => {
    const expected = expectedSnapshot()
    const calls: QueryLog[] = []
    await expect(
      checkArchiveWriterBlockOwnerExact(async (sql, params) => {
        calls.push({ sql, params })
        return {
          rows: [{
            state: expected.state,
            owner_kind: expected.ownerKind,
            owner_id: expected.ownerId,
            fence: expected.fence,
            lease_until: expected.leaseUntil,
            updated_at: expected.updatedAt,
          }],
        }
      }, 'sheet-token', expected),
    ).resolves.toEqual(expected)
    expect(calls[0]?.sql).toContain('recovery_writer_lease_until > clock_timestamp()')
    expect(calls[0]?.sql).not.toContain('pg_advisory_xact_lock')
  })

  test('all module errors are values-free', async () => {
    enableArchiveWriterBlock()
    const sensitive = ['sheet-secret', 'owner-secret', 'archiving', '2099-01-01']
    let error: unknown
    try {
      await claimArchiveWriterBlock(
        mockPreparedRunner([], () => ({ rows: [], rowCount: 0 })),
        sensitive[0],
        {
          ownerKind: 'archive_generation',
          ownerId: sensitive[1],
          leaseUntil: LEASE,
        },
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ArchiveWriterBlockError)
    expect(error).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_CLAIM_CONFLICT' })
    for (const value of sensitive) expect(rendered(error)).not.toContain(value)
  })

  test('migration name/order and fail-loud parent/down contracts are fixed', () => {
    const source = readFileSync(
      path.resolve(
        __dirname,
        '../../src/db/migrations/zzzz20260826123000_add_archive_writer_block_ownership.ts',
      ),
      'utf8',
    )
    expect(source).toContain("'archive_generation', 'restore_job'")
    expect(source).toContain('archive_writer_block_source_schema_mismatch')
    expect(source).toContain('archive_writer_block_object_conflict')
    expect(source).toContain('archive_writer_block_down_nonempty')
    expect(source).toContain('recovery_writer_owner_fence IS NOT NULL')
    expect(source).not.toMatch(/ADD COLUMN IF NOT EXISTS|DROP COLUMN IF EXISTS/)
  })
})
