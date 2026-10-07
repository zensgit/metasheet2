import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __resetRecoveryWriterStateColumnProbe,
  assertNoActiveWriterBlock,
  canonicalSheetFenceKey,
  fenceWriterEntry,
  isWriterFenceEnabled,
  SheetWriterBlockedError,
  WRITER_BLOCK_STATES,
  type FenceQuery,
} from '../../src/multitable/canonical-sheet-fence'

const ARCHIVE_FLAG = 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED'
const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const SHEET = 'synthetic_sheet'
const PROBE_SQL = `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'meta_sheets' AND column_name = 'recovery_writer_state' LIMIT 1`
const LEGACY_STATE_SQL = 'SELECT recovery_writer_state FROM meta_sheets WHERE id = $1'
const FRESH_STATE_SQL = 'SELECT recovery_writer_state FROM public.meta_sheets WHERE id = $1'
const ISOLATION_SQL = 'SHOW transaction_isolation'
const XID_SQL = 'SELECT pg_current_xact_id()::text AS xid'
const FRESH_CALLS = [
  [ISOLATION_SQL], [XID_SQL, undefined], [XID_SQL, undefined], [FRESH_STATE_SQL, [SHEET]],
]

function flags(archive: string | undefined, fence: string | undefined): void {
  if (archive === undefined) delete process.env[ARCHIVE_FLAG]
  else process.env[ARCHIVE_FLAG] = archive
  if (fence === undefined) delete process.env[FENCE_FLAG]
  else process.env[FENCE_FLAG] = fence
}

function database(input: {
  column?: boolean
  rows?: unknown[]
  isolationRows?: unknown[]
  xidRows?: unknown[][]
  failureSql?: string
} = {}) {
  let xidCalls = 0
  const query = vi.fn<Parameters<FenceQuery>, ReturnType<FenceQuery>>(async (sql) => {
    if (sql === input.failureSql) throw new Error('SENSITIVE_NATIVE_DATABASE_VALUE')
    if (sql === ISOLATION_SQL) return { rows: input.isolationRows ?? [{ transaction_isolation: 'read committed' }] }
    if (sql === XID_SQL) return { rows: input.xidRows?.[xidCalls++] ?? [{ xid: 'SENSITIVE_SYNTHETIC_XID' }] }
    if (sql === PROBE_SQL) return { rows: input.column === false ? [] : [{ '?column?': 1 }] }
    if (sql === FRESH_STATE_SQL || sql === LEGACY_STATE_SQL) return { rows: input.rows ?? [{ recovery_writer_state: null }] }
    if (sql === 'SELECT pg_advisory_xact_lock(hashtext($1))') return { rows: [{}] }
    throw new Error('UNEXPECTED_UNIT_SQL')
  })
  return query
}

async function expectBlocked(query: FenceQuery, state: (typeof WRITER_BLOCK_STATES)[number] | null): Promise<void> {
  const result = await assertNoActiveWriterBlock(query, SHEET).then(
    () => ({ error: null }), (error: unknown) => ({ error }),
  )
  expect(result.error).toBeInstanceOf(SheetWriterBlockedError)
  expect(result.error).toMatchObject({
    name: 'SheetWriterBlockedError', code: 'SHEET_WRITER_BLOCKED', sheetId: SHEET, state,
    message: 'Sheet is temporarily locked for writes by a recovery operation',
  })
  const error = result.error as Error
  expect(`${error.message}\n${error.stack ?? ''}`).not.toMatch(/SENSITIVE_|xid .* then|UNEXPECTED_UNIT_SQL/)
  expect(Object.keys(error).sort()).toEqual(['code', 'name', 'sheetId', 'state'])
}

beforeEach(() => {
  __resetRecoveryWriterStateColumnProbe()
  vi.stubEnv(ARCHIVE_FLAG, 'true')
  vi.stubEnv(FENCE_FLAG, 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
  __resetRecoveryWriterStateColumnProbe()
})

describe('G4 fresh ordinary-writer admission', () => {
  test('selected admission bypasses a false column cache after deployment without resetting it', async () => {
    flags('false', 'true')
    const missing = database({ column: false })
    await assertNoActiveWriterBlock(missing, SHEET)
    expect(missing.mock.calls).toEqual([[PROBE_SQL]])

    flags('true', 'true')
    const claimed = database({ rows: [{ recovery_writer_state: 'archiving' }] })
    await expectBlocked(claimed, 'archiving')
    expect(claimed.mock.calls).toEqual(FRESH_CALLS)

    flags('false', 'true')
    const legacy = database({ rows: [{ recovery_writer_state: 'archiving' }] })
    await assertNoActiveWriterBlock(legacy, SHEET)
    expect(legacy).not.toHaveBeenCalled()
  })

  test('selected admission permits exactly one present NULL authority row without legacy probing', async () => {
    const query = database()
    await expect(assertNoActiveWriterBlock(query, SHEET)).resolves.toBeUndefined()
    expect(query.mock.calls).toEqual(FRESH_CALLS)
  })

  test('selected admission neither seeds nor changes the legacy true cache', async () => {
    flags('false', 'true')
    const warm = database()
    await assertNoActiveWriterBlock(warm, SHEET)
    expect(warm.mock.calls).toEqual([[PROBE_SQL], [LEGACY_STATE_SQL, [SHEET]]])
    flags('true', 'true')
    await assertNoActiveWriterBlock(database(), SHEET)
    flags('false', 'true')
    const legacy = database({ column: false })
    await assertNoActiveWriterBlock(legacy, SHEET)
    expect(legacy.mock.calls).toEqual([[LEGACY_STATE_SQL, [SHEET]]])
  })

  test('selected admission does not seed a previously unprobed legacy cache', async () => {
    await assertNoActiveWriterBlock(database(), SHEET)
    flags('false', 'true')
    const legacy = database({ column: false })
    await assertNoActiveWriterBlock(legacy, SHEET)
    expect(legacy.mock.calls).toEqual([[PROBE_SQL]])
  })

  test('selected fence entry retains canonical fence before fresh admission with no transaction normalization', async () => {
    const query = database()
    await fenceWriterEntry(query, SHEET)
    expect(query.mock.calls).toEqual([
      ['SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)]], ...FRESH_CALLS,
    ])
  })

  test.each(WRITER_BLOCK_STATES)('selected recognized %s authority always refuses', async (state) => {
    const query = database({ rows: [{ recovery_writer_state: state }] })
    await expectBlocked(query, state)
    expect(query.mock.calls).toEqual(FRESH_CALLS)
  })

  test('selected expired archiving authority still refuses without owner or lease exceptions', async () => {
    const query = database({ rows: [{ recovery_writer_state: 'archiving', recovery_writer_lease_until: '2000-01-01' }] })
    await expectBlocked(query, 'archiving')
    expect(query.mock.calls).toEqual(FRESH_CALLS)
  })

  test.each([
    [], [{ }], [null], [undefined], ['archiving'], [[]],
    [{ recovery_writer_state: null }, { recovery_writer_state: null }],
    [{ recovery_writer_state: undefined }], [{ recovery_writer_state: 'unknown' }],
    [{ recovery_writer_state: '' }], [{ recovery_writer_state: 'ARCHIVING' }],
    [{ recovery_writer_state: ' archiving ' }], [{ recovery_writer_state: false }],
    [{ recovery_writer_state: 0 }], [{ recovery_writer_state: [] }],
    [{ recovery_writer_state: { state: 'archiving' } }],
  ].map((rows) => ({ rows })))('selected missing or malformed authority refuses coarsely (%#)', async ({ rows }) => {
    const query = database({ rows })
    await expectBlocked(query, null)
    expect(query.mock.calls).toEqual(FRESH_CALLS)
  })

  test.each([
    [], [{}], [{ transaction_isolation: 'repeatable read' }],
    [{ transaction_isolation: 'serializable' }], [{ transaction_isolation: 'READ COMMITTED' }],
    [{ transaction_isolation: null }], [{ transaction_isolation: 'read committed' }, { transaction_isolation: 'read committed' }],
  ].map((isolationRows) => ({ isolationRows })))('selected actual non-RC or malformed isolation refuses before state (%#)', async ({ isolationRows }) => {
    const query = database({ isolationRows })
    await expectBlocked(query, null)
    expect(query.mock.calls).toEqual([[ISOLATION_SQL]])
  })

  test.each([
    [[{ xid: 'SENSITIVE_FIRST_XID' }], [{ xid: 'SENSITIVE_SECOND_XID' }]],
    [[], []], [[{}], [{}]], [[{ xid: '' }], [{ xid: '' }]],
    [[{ xid: 42 }], [{ xid: 42 }]], [[{ xid: null }], [{ xid: null }]],
    [[{ xid: 'SENSITIVE_FIRST_XID' }], []],
  ].map((xidRows) => ({ xidRows })))('selected autocommit or unusable transaction handle refuses without xid leakage (%#)', async ({ xidRows }) => {
    const query = database({ xidRows })
    await expectBlocked(query, null)
    expect(query.mock.calls[0]).toEqual([ISOLATION_SQL])
    expect(query.mock.calls.some(([sql]) => sql === FRESH_STATE_SQL || sql === PROBE_SQL)).toBe(false)
  })

  test.each([ISOLATION_SQL, XID_SQL, FRESH_STATE_SQL])('selected native query failure closes values-free (%#)', async (failureSql) => {
    const query = database({ failureSql })
    await expectBlocked(query, null)
    expect(query.mock.calls.at(-1)?.[0]).toBe(failureSql)
    expect(query.mock.calls.some(([sql]) => sql === PROBE_SQL)).toBe(false)
  })

  const spellings = [undefined, '', 'false', 'TRUE', ' true ', 'true']
  const matrix = spellings.flatMap((archive) => spellings.map((fence) => ({ archive, fence })))
  test.each(matrix)('exact-literal flag matrix retains original unselected query bytes/order (%#)', async ({ archive, fence }) => {
    flags(archive, fence)
    const query = database()
    await assertNoActiveWriterBlock(query, SHEET)
    expect(query.mock.calls).toEqual(archive === 'true' && fence === 'true'
      ? FRESH_CALLS : [[PROBE_SQL], [LEGACY_STATE_SQL, [SHEET]]])
    expect(isWriterFenceEnabled()).toBe(String(fence ?? '').trim().toLowerCase() === 'true')
  })

  test.each(matrix.filter(({ archive, fence }) => archive !== 'true' || fence !== 'true'))(
    'unselected false-cache behavior remains query-free for every flag spelling (%#)', async ({ archive, fence }) => {
      flags('false', 'true')
      await assertNoActiveWriterBlock(database({ column: false }), SHEET)
      flags(archive, fence)
      const query = database({ rows: [{ recovery_writer_state: 'archiving' }] })
      await assertNoActiveWriterBlock(query, SHEET)
      expect(query).not.toHaveBeenCalled()
    },
  )

  test('unselected existing block error and native error propagation retain original behavior', async () => {
    flags('false', 'true')
    const blocked = database({ rows: [{ recovery_writer_state: 'applying' }] })
    await expectBlocked(blocked, 'applying')
    expect(blocked.mock.calls).toEqual([[PROBE_SQL], [LEGACY_STATE_SQL, [SHEET]]])
    const failing = database({ failureSql: LEGACY_STATE_SQL })
    await expect(assertNoActiveWriterBlock(failing, SHEET)).rejects.toThrow('SENSITIVE_NATIVE_DATABASE_VALUE')
    expect(failing.mock.calls).toEqual([[LEGACY_STATE_SQL, [SHEET]]])
  })
})
