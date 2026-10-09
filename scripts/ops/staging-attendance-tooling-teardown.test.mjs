#!/usr/bin/env node
// Contracts for the shared staging attendance cleanup helper.
//
// Every test here runs without a database, except one opt-in test against a real PostgreSQL
// database (at the end of this file). It runs only when TEARDOWN_REAL_PG_DATABASE_URL names a
// migrated database, for example a throwaway database migrated from packages/core-backend with
// the standard MIGRATION_EXCLUDE list:
//
//   TEARDOWN_REAL_PG_DATABASE_URL=postgresql://USER@HOST:5432/DBNAME \
//     node --test scripts/ops/staging-attendance-tooling-teardown.test.mjs
//
// It never reads DATABASE_URL, so a CI step that sets DATABASE_URL does not arm it. It works on
// one connection inside a transaction that it rolls back at the end, so it commits nothing.
// Without the variable it is reported as skipped, with the reason.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN_TOKEN,
  assertToolingOnlyNonW4FixtureTeardownAllowed,
  classifyStagingAttendanceCleanup,
  cleanupStagingAttendanceScope,
  countW4ImmutableAttendanceRows,
  createAuthenticatedOpsRetirementExecutor,
  runStagingAttendanceRecordTeardown,
} from './staging-attendance-tooling-teardown.mjs'

const opsDir = path.dirname(fileURLToPath(import.meta.url))
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test('tooling-only guard requires zero W4 immutable rows and closed token', () => {
  assert.doesNotThrow(() =>
    assertToolingOnlyNonW4FixtureTeardownAllowed({
      purpose: 'tooling_only_non_w4_fixture_teardown',
      explicitGuardToken: ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN_TOKEN,
      w4ImmutableRowCount: 0,
    }),
  )
  assert.throws(
    () =>
      assertToolingOnlyNonW4FixtureTeardownAllowed({
        purpose: 'tooling_only_non_w4_fixture_teardown',
        explicitGuardToken: ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN_TOKEN,
        w4ImmutableRowCount: 1,
      }),
    /ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN/,
  )
})

test('authenticated retirement executor requires baseUrl, token, and stable command seed', () => {
  assert.throws(
    () => createAuthenticatedOpsRetirementExecutor({ baseUrl: '', token: '', commandSeed: '' }),
    /ATTENDANCE_STAGING_RETIREMENT_EXECUTOR_INVALID/,
  )
  assert.doesNotThrow(() =>
    createAuthenticatedOpsRetirementExecutor({
      baseUrl: 'http://127.0.0.1:8900',
      token: 't',
      commandSeed: '11111111-1111-4111-8111-111111111111',
    }),
  )
})

test('authenticated retirement executor freezes the selected calculation identity and version', async () => {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true })
      },
    }
  }
  try {
    const retireRecord = createAuthenticatedOpsRetirementExecutor({
      baseUrl: 'http://127.0.0.1:8900',
      token: 'token',
      commandSeed: '11111111-1111-4111-8111-111111111111',
    })
    await retireRecord({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_calculation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      current_calculation_version: '7',
      latest_calculation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      latest_calculation_version: '8',
    })
    await retireRecord({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      current_calculation_id: null,
      current_calculation_version: null,
      latest_calculation_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      latest_calculation_version: '9',
    })

    assert.equal(requests.length, 2)
    const firstBody = JSON.parse(requests[0].init.body)
    assert.equal(firstBody.expectedCalculationId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    assert.equal(firstBody.expectedCalculationVersion, 7)
    const secondBody = JSON.parse(requests[1].init.body)
    assert.equal(secondBody.expectedCalculationId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    assert.equal(secondBody.expectedCalculationVersion, 9)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('retirement inventory qualifies record columns after calculation joins', async () => {
  const source = fs.readFileSync(path.join(opsDir, 'staging-attendance-tooling-teardown.mjs'), 'utf8')
  assert.match(source, /SELECT record\.id::text AS id/)
  assert.match(source, /record\.current_calculation_id::text AS current_calculation_id/)
  assert.match(source, /record\.projection_owner/)
  assert.match(source, /WHERE \$\{listedFilter\}/)
})

test('every staging retirement commandSeed is a unique valid UUID', () => {
  const seeds = []
  for (const filename of fs.readdirSync(opsDir).filter((name) => /^staging-attendance-.*-smoke\.mjs$/.test(name))) {
    const source = fs.readFileSync(path.join(opsDir, filename), 'utf8')
    for (const match of source.matchAll(/commandSeed:\s*['"]([^'"]+)['"]/g)) {
      assert.match(match[1], uuidPattern, `${filename} has an invalid retirement commandSeed`)
      seeds.push({ filename, seed: match[1].toLowerCase() })
    }
  }
  assert.ok(seeds.length >= 10, 'expected the complete staging retirement seed census')
  assert.equal(
    new Set(seeds.map((entry) => entry.seed)).size,
    seeds.length,
    `staging retirement commandSeed values must be unique: ${JSON.stringify(seeds)}`,
  )
})

test('cleanupStagingAttendanceScope refuses W4-backed rows without retireRecord (no swallow)', async () => {
  const rows = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user_id: 'u1',
      work_date: '2026-08-01',
      current_calculation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projection_owner: 'w4',
      visibility_state: 'active',
      visibility_reason: 'active',
    },
  ]
  const db = {
    async query(sql) {
      if (/FROM attendance_records/.test(sql) && /SELECT record\.id::text/.test(sql)) {
        return { rows }
      }
      if (/attendance_record_calculations/.test(sql) && /COUNT/.test(sql)) {
        return { rows: [{ n: 1 }] }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
  await assert.rejects(
    () => cleanupStagingAttendanceScope(db, {
      orgId: 'org',
      recordIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    }),
    (error) => {
      assert.equal(error.code, 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
      assert.match(String(error.message), /retireRecord|ops_retirement/)
      return true
    },
  )
})

test('mutation: swallowed cleanup would hide W4-backed residue — helper throws instead', async () => {
  let deleted = false
  const db = {
    async query(sql) {
      if (/COUNT\(\*\)/.test(sql) && /attendance_records/.test(sql)) {
        return { rows: [{ n: 1 }] }
      }
      if (/DELETE FROM attendance_records/.test(sql)) {
        deleted = true
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
  await assert.rejects(
    () =>
      runStagingAttendanceRecordTeardown(db, {
        orgId: 'org',
        recordIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      }),
    /ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN/,
  )
  assert.equal(deleted, false, 'must not physically delete when W4 immutable rows exist')
})

test('tooling DELETE repeats every W4 exclusion inside the destructive statement', async () => {
  let deleteSql = ''
  let immutableCounts = 0
  const db = {
    async query(sql) {
      if (/COUNT\(\*\)/.test(sql) && /attendance_records/.test(sql)) {
        immutableCounts += 1
        return { rows: [{ n: 0 }] }
      }
      if (/DELETE FROM attendance_records/.test(sql)) {
        deleteSql = sql
        return { rows: [] }
      }
      return { rows: [{ n: 0 }] }
    },
  }

  await runStagingAttendanceRecordTeardown(db, {
    orgId: 'org',
    recordIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  })

  assert.equal(immutableCounts, 3, 'classify, immediate proof, and residue proof must all run')
  assert.match(deleteSql, /current_calculation_id IS NULL/)
  assert.match(deleteSql, /projection_owner IS NOT DISTINCT FROM 'legacy_untracked'/)
  assert.match(deleteSql, /NOT EXISTS\s*\(\s*SELECT 1 FROM attendance_record_calculations c/)
  assert.match(deleteSql, /c\.attendance_record_id = attendance_records\.id/)
  assert.match(deleteSql, /c\.org_id = attendance_records\.org_id/)
})

test('count + classify expose W4-backed vs tooling-only paths', async () => {
  const db = {
    async query(sql) {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] }
      return { rows: [] }
    },
  }
  const n = await countW4ImmutableAttendanceRows(db, { orgId: 'org' })
  assert.equal(n, 0)
  const c = await classifyStagingAttendanceCleanup(db, { orgId: 'org' })
  assert.equal(c.allowedDelete, true)
  assert.equal(c.purpose, 'tooling_only_non_w4_fixture_teardown')
})

test('destructive cleanup rejects an org-only unbounded scope before SQL', async () => {
  let queried = false
  const db = {
    async query() {
      queried = true
      return { rows: [] }
    },
  }
  await assert.rejects(
    () => cleanupStagingAttendanceScope(db, { orgId: 'org' }),
    (error) => error?.code === 'ATTENDANCE_STAGING_CLEANUP_SCOPE_UNBOUNDED',
  )
  await assert.rejects(
    () => runStagingAttendanceRecordTeardown(db, { orgId: 'org' }),
    (error) => error?.code === 'ATTENDANCE_STAGING_CLEANUP_SCOPE_UNBOUNDED',
  )
  assert.equal(queried, false, 'unbounded destructive scope must fail before any SQL')
})

test('mixed W4 cleanup success: retire W4 rows then tooling-delete non-W4; residue only retired', async () => {
  const w4Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const toolingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const retired = new Set()
  const deleted = new Set()
  const db = {
    async query(sql, params) {
      // Residue proof query (narrow columns).
      if (/SELECT id::text AS id, visibility_reason/.test(sql)) {
        const rows = []
        if (retired.has(w4Id) && !deleted.has(w4Id)) {
          rows.push({ id: w4Id, visibility_reason: 'operator_retirement' })
        }
        return { rows }
      }
      // Initial listing of scope rows.
      if (/SELECT record\.id::text AS id/.test(sql) && /FROM attendance_records/.test(sql)) {
        return {
          rows: [
            {
              id: w4Id,
              user_id: 'u1',
              work_date: '2026-08-01',
              current_calculation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              projection_owner: 'w4',
              visibility_state: 'active',
              visibility_reason: 'active',
            },
            {
              id: toolingId,
              user_id: 'u2',
              work_date: '2026-08-01',
              current_calculation_id: null,
              projection_owner: 'legacy_untracked',
              visibility_state: 'active',
              visibility_reason: 'active',
            },
          ].filter((row) => !deleted.has(row.id)),
        }
      }
      if (/attendance_record_calculations/.test(sql) && /COUNT/.test(sql)) {
        const id = params?.[0]
        return { rows: [{ n: id === w4Id && !retired.has(w4Id) ? 1 : 0 }] }
      }
      if (/DELETE FROM attendance_records/.test(sql)) {
        const ids = params?.[1]
        if (Array.isArray(ids)) {
          for (const id of ids) deleted.add(id)
        }
        return { rows: [] }
      }
      if (/SELECT COUNT\(\*\)/.test(sql) && /attendance_records/.test(sql)) {
        if (/current_calculation_id IS NOT NULL/.test(sql)) {
          // Tooling-only scope for non-W4 ids must report zero W4 immutable rows.
          return { rows: [{ n: 0 }] }
        }
        // Post-delete residue count for tooling-only path.
        return { rows: [{ n: 0 }] }
      }
      return { rows: [] }
    },
  }
  const result = await cleanupStagingAttendanceScope(
    db,
    { orgId: 'org', recordIds: [w4Id, toolingId] },
    {
      retireRecord: async (row) => {
        retired.add(row.id)
      },
    },
  )
  assert.equal(result.retiredCount, 1)
  assert.equal(result.toolingDeletedCount, 1)
  assert.deepEqual(result.retired, [w4Id])
  assert.deepEqual(result.toolingDeleted, [toolingId])
  assert.ok(retired.has(w4Id))
  assert.ok(deleted.has(toolingId))
})

test('missing/invalid executor fails closed before direct record cleanup', async () => {
  assert.throws(
    () => createAuthenticatedOpsRetirementExecutor({ baseUrl: '', token: 't', commandSeed: '11111111-1111-4111-8111-111111111111' }),
    /ATTENDANCE_STAGING_RETIREMENT_EXECUTOR_INVALID/,
  )
  assert.throws(
    () => createAuthenticatedOpsRetirementExecutor({
      baseUrl: 'http://127.0.0.1:8900',
      token: 't',
      commandSeed: 'not-a-uuid',
    }),
    /ATTENDANCE_STAGING_RETIREMENT_EXECUTOR_INVALID/,
  )
  const rows = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user_id: 'u1',
      work_date: '2026-08-01',
      current_calculation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projection_owner: 'w4',
      visibility_state: 'active',
      visibility_reason: 'active',
    },
  ]
  let deleted = false
  const db = {
    async query(sql) {
      if (/FROM attendance_records/.test(sql) && /SELECT record\.id::text/.test(sql)) return { rows }
      if (/attendance_record_calculations/.test(sql) && /COUNT/.test(sql)) return { rows: [{ n: 1 }] }
      if (/DELETE FROM attendance_records/.test(sql)) {
        deleted = true
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
  await assert.rejects(
    () => cleanupStagingAttendanceScope(db, {
      orgId: 'org',
      recordIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    }, { retireRecord: undefined }),
    (error) => {
      assert.equal(error.code, 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
      assert.match(String(error.message), /retireRecord|ops_retirement|W4-backed/)
      return true
    },
  )
  assert.equal(deleted, false)
})

test('non-swallowed retirement errors propagate (no silent residue hide)', async () => {
  const w4Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let deleted = false
  const db = {
    async query(sql) {
      if (/FROM attendance_records/.test(sql) && /SELECT record\.id::text/.test(sql)) {
        return {
          rows: [
            {
              id: w4Id,
              user_id: 'u1',
              work_date: '2026-08-01',
              current_calculation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              projection_owner: 'w4',
              visibility_state: 'active',
              visibility_reason: 'active',
            },
          ],
        }
      }
      if (/attendance_record_calculations/.test(sql) && /COUNT/.test(sql)) return { rows: [{ n: 1 }] }
      if (/DELETE FROM attendance_records/.test(sql)) {
        deleted = true
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
  await assert.rejects(
    () =>
      cleanupStagingAttendanceScope(
        db,
        { orgId: 'org', recordIds: [w4Id] },
        {
          retireRecord: async () => {
            const error = new Error('ops_retirement HTTP 503')
            error.code = 'HTTP_503'
            throw error
          },
        },
      ),
    /ops_retirement HTTP 503|HTTP_503/,
  )
  assert.equal(deleted, false, 'must not fall through to DELETE after retirement failure')
})

test('residue proof fails when non-retired rows remain after cleanup', async () => {
  const w4Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const db = {
    async query(sql) {
      if (/SELECT record\.id::text AS id/.test(sql)) {
        return {
          rows: [
            {
              id: w4Id,
              user_id: 'u1',
              work_date: '2026-08-01',
              current_calculation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              projection_owner: 'w4',
              visibility_state: 'active',
              visibility_reason: 'active',
            },
          ],
        }
      }
      if (/attendance_record_calculations/.test(sql) && /COUNT/.test(sql)) return { rows: [{ n: 1 }] }
      if (/SELECT id::text AS id, visibility_reason/.test(sql)) {
        // Fake a residual active W4 row after a no-op retire.
        return { rows: [{ id: w4Id, visibility_reason: 'active' }] }
      }
      return { rows: [] }
    },
  }
  await assert.rejects(
    () =>
      cleanupStagingAttendanceScope(
        db,
        { orgId: 'org', recordIds: [w4Id] },
        { retireRecord: async () => undefined },
      ),
    /ATTENDANCE_STAGING_CLEANUP_RESIDUE/,
  )
})

// --- userIdPrefix filter: statement pins (no database) ---------------------------------------
//
// The prefix filter binds ONE text parameter twice: as the comparison value and, through
// length(), as left()'s length. A placeholder passed straight to left() as its length is typed
// integer by PostgreSQL, so using it again as the comparison value fails the statement with 42883
// (text = integer); before this pin every scope with a userIdPrefix failed on its first statement.
// These tests fix the exact text and parameters of every statement for the scopes the four
// window smokes pass (ae4, otbank-v18, mp6, hmr5), through cleanupStagingAttendanceScope and
// through the three functions that build the filter themselves, and check the placeholder rule
// on every statement, so that class of error turns red without a database.

const sqlText = (sql) => String(sql).replace(/\s+/g, ' ').trim()

const W4_BACKED = "( current_calculation_id IS NOT NULL OR projection_owner IS DISTINCT FROM 'legacy_untracked' OR EXISTS ( SELECT 1 FROM attendance_record_calculations c WHERE c.attendance_record_id = attendance_records.id AND c.org_id = attendance_records.org_id ) )"
const TEARDOWN_SQL = {
  countW4: (where) => `SELECT COUNT(*)::int AS n FROM attendance_records WHERE ${where} AND ${W4_BACKED}`,
  deleteNonW4: (where) => `/* tooling_only_non_w4_fixture_teardown */ DELETE FROM attendance_records WHERE ${where} AND current_calculation_id IS NULL AND projection_owner IS NOT DISTINCT FROM 'legacy_untracked' AND NOT EXISTS ( SELECT 1 FROM attendance_record_calculations c WHERE c.attendance_record_id = attendance_records.id AND c.org_id = attendance_records.org_id )`,
  count: (where) => `SELECT COUNT(*)::int AS n FROM attendance_records WHERE ${where}`,
  listed: (where) => `SELECT record.id::text AS id, record.user_id::text AS user_id, record.work_date::text AS work_date, record.current_calculation_id::text AS current_calculation_id, current_calc.version AS current_calculation_version, latest_calc.id::text AS latest_calculation_id, latest_calc.version AS latest_calculation_version, record.projection_owner, record.visibility_state, record.visibility_reason FROM attendance_records record LEFT JOIN attendance_record_calculations current_calc ON current_calc.id = record.current_calculation_id AND current_calc.attendance_record_id = record.id AND current_calc.org_id = record.org_id LEFT JOIN LATERAL ( SELECT calculation.id, calculation.version FROM attendance_record_calculations calculation WHERE calculation.attendance_record_id = record.id AND calculation.org_id = record.org_id AND calculation.outcome = 'completed' ORDER BY calculation.version DESC LIMIT 1 ) latest_calc ON TRUE WHERE ${where}`,
  childCount: 'SELECT COUNT(*)::int AS n FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid AND org_id = $2',
  finalResidue: (where) => `SELECT id::text AS id, visibility_reason FROM attendance_records WHERE ${where}`,
}

// The query wrapper all four smokes pass at their call sites, and each smoke's scope argument,
// as source text. The pins below and the real-PostgreSQL test use exactly these scopes.
const SMOKE_QUERY_WRAPPER = [
  '{ query: async (sql, params) => {',
  "    const r = await (typeof q === 'function' ? q(sql, params) : pool.query(sql, params))",
  '    return { rows: r?.rows ?? (Array.isArray(r) ? r : []) }',
  '  } }',
].join('\n')
const SMOKE_CALL_SITES = [
  { smoke: 'ae4', file: 'staging-attendance-ae4-result-edit-smoke.mjs', scope: '{ orgId: ORG_ID, userIdPrefix: USER_PREFIX, recordIds: ids }' },
  { smoke: 'otbank-v18', file: 'staging-attendance-overtime-bank-v18-smoke.mjs', scope: '{ orgId: ORG_ID, userIdPrefix: USER_PREFIX }' },
  { smoke: 'mp6', file: 'staging-attendance-makeup-punch-mp6-smoke.mjs', scope: '{ orgId: ORG_ID, userIdPrefix: USER_PREFIX }' },
  { smoke: 'hmr5', file: 'staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs', scope: '{ orgId: ORG_ID, userIdPrefix: (typeof USER_PREFIX !== "undefined" ? USER_PREFIX : undefined), userIds: (typeof ALL_USERS !== "undefined" ? ALL_USERS : undefined) }' },
]

// The scopes those call sites build: ORG_ID defaults to `default` (hmr5: its own disposable
// `<stamp>-org`), USER_PREFIX is `<stamp>-`, ae4's ids are the three record ids it seeds, and
// hmr5 declares no ALL_USERS, so its userIds is undefined.
const AE4_RECORD_IDS = [
  'a4a4a4a4-0000-4000-8000-000000000001',
  'a4a4a4a4-0000-4000-8000-000000000002',
  'a4a4a4a4-0000-4000-8000-000000000003',
]
const PREFIX_SCOPES = [
  { smoke: 'ae4', scope: { orgId: 'default', userIdPrefix: 'ae4-smoke-t1-', recordIds: AE4_RECORD_IDS } },
  { smoke: 'otbank-v18', scope: { orgId: 'default', userIdPrefix: 'otbank-v18-smoke-t1-' } },
  { smoke: 'mp6', scope: { orgId: 'default', userIdPrefix: 'mp6-smoke-t1-' } },
  { smoke: 'hmr5', scope: { orgId: 'hmr5-smoke-t1-org', userIdPrefix: 'hmr5-smoke-t1-', userIds: undefined } },
]

// WHERE clauses and parameters each scope must produce: `own` is the filter the functions build
// on attendance_records, `listed` the one cleanupStagingAttendanceScope's listing uses (columns
// qualified with `record.`).
function expectedPrefixFilter({ orgId, userIdPrefix, recordIds }) {
  if (recordIds) {
    return {
      own: 'org_id = $1 AND id = ANY($2::uuid[]) AND left(user_id, length($3::text)) = $3::text',
      listed: 'record.org_id = $1 AND record.id = ANY($2::uuid[]) AND left(record.user_id, length($3::text)) = $3::text',
      params: [orgId, recordIds, userIdPrefix],
    }
  }
  return {
    own: 'org_id = $1 AND left(user_id, length($2::text)) = $2::text',
    listed: 'record.org_id = $1 AND left(record.user_id, length($2::text)) = $2::text',
    params: [orgId, userIdPrefix],
  }
}

// A db that records every statement (normalized text and a copy of its parameters). The listing
// answers `listed`, every COUNT answers 0, everything else no rows.
function recordingDb({ listed = [] } = {}) {
  const statements = []
  return {
    statements,
    async query(sql, params) {
      const text = sqlText(sql)
      statements.push({ text, params: structuredClone(params ?? []) })
      if (text.startsWith('SELECT record.id::text AS id')) return { rows: listed }
      if (text.startsWith('SELECT COUNT(*)::int AS n')) return { rows: [{ n: 0 }] }
      return { rows: [] }
    },
  }
}

// The 42883 class, checked on any statement: a placeholder passed straight to left() as its
// length is typed integer, so it must be bound to an integer and appear nowhere else in the
// statement; a prefix compared through left(col, length($n::text)) = $n::text is bound to text.
function assertLeftPlaceholders(statement) {
  for (const match of statement.text.matchAll(/left\(\s*[\w.]+\s*,\s*\$(\d+)\s*\)/g)) {
    const n = Number(match[1])
    const uses = statement.text.match(new RegExp(`\\$${n}(?!\\d)`, 'g')) || []
    assert.equal(uses.length, 1, `$${n} is left()'s length and is used again in the same statement (PostgreSQL types it integer, so the comparison fails with 42883): ${statement.text}`)
    assert.ok(Number.isSafeInteger(statement.params[n - 1]), `$${n} is left()'s length and must be bound to an integer, got ${JSON.stringify(statement.params[n - 1])}: ${statement.text}`)
  }
  for (const match of statement.text.matchAll(/left\(\s*[\w.]+\s*,\s*length\(\$(\d+)::text\)\s*\)\s*=\s*\$(\d+)::text/g)) {
    assert.equal(match[1], match[2], `the prefix's length and the compared prefix must be the same parameter: ${statement.text}`)
    assert.equal(typeof statement.params[Number(match[1]) - 1], 'string', `the compared prefix must be bound to a string: ${statement.text}`)
  }
}

test('userIdPrefix pin: the four window smokes pass these exact scopes through the same query wrapper', () => {
  for (const site of SMOKE_CALL_SITES) {
    const source = fs.readFileSync(path.join(opsDir, site.file), 'utf8')
    const call = `await cleanupStagingAttendanceScope(${SMOKE_QUERY_WRAPPER}, ${site.scope}, { retireRecord: opsRetirementExecutor })`
    assert.equal(source.split(call).length - 1, 1, `${site.smoke}: expected exactly one cleanup call with this wrapper and scope:\n${call}`)
    assert.equal(source.split('cleanupStagingAttendanceScope(').length - 1, 1, `${site.smoke}: one call to the helper`)
    assert.match(source, /^const q = \(text, params = \[\]\) => pool\.query\(text, params\)\.then\(result => result\.rows\)$/m, `${site.smoke}: q answers result.rows`)
  }
  const hmr5 = fs.readFileSync(path.join(opsDir, 'staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs'), 'utf8')
  assert.doesNotMatch(hmr5, /\b(?:const|let|var)\s+ALL_USERS\b/, 'hmr5 declares no ALL_USERS, so its scope carries userIds: undefined')
})

test('userIdPrefix pin: cleanupStagingAttendanceScope issues these exact statements and parameters for each window smoke scope', async () => {
  const listedId = 'b5b5b5b5-0000-4000-8000-000000000001'
  for (const { smoke, scope } of PREFIX_SCOPES) {
    const db = recordingDb({ listed: [{ id: listedId, user_id: `${scope.userIdPrefix}x`, current_calculation_id: null, projection_owner: 'legacy_untracked', visibility_state: 'active', visibility_reason: 'active' }] })
    const result = await cleanupStagingAttendanceScope(db, scope, { retireRecord: async () => assert.fail('no W4-backed row was listed') })
    const filter = expectedPrefixFilter(scope)
    const byId = 'org_id = $1 AND id = ANY($2::uuid[])'
    const byIdParams = [scope.orgId, [listedId]]
    assert.deepEqual(db.statements, [
      { text: TEARDOWN_SQL.listed(filter.listed), params: filter.params },
      { text: TEARDOWN_SQL.childCount, params: [listedId, scope.orgId] },
      { text: TEARDOWN_SQL.countW4(byId), params: byIdParams },
      { text: TEARDOWN_SQL.countW4(byId), params: byIdParams },
      { text: TEARDOWN_SQL.deleteNonW4(byId), params: byIdParams },
      { text: TEARDOWN_SQL.count(byId), params: byIdParams },
      { text: TEARDOWN_SQL.finalResidue(filter.own), params: filter.params },
    ], `${smoke}: statements, text and parameters`)
    for (const statement of db.statements) assertLeftPlaceholders(statement)
    assert.deepEqual(result, { retiredCount: 0, toolingDeletedCount: 1, retired: [], toolingDeleted: [listedId] })
  }
})

test('userIdPrefix pin: count, classify and record teardown build the same filter themselves', async () => {
  for (const { smoke, scope } of PREFIX_SCOPES) {
    const filter = expectedPrefixFilter(scope)
    const counted = recordingDb()
    assert.equal(await countW4ImmutableAttendanceRows(counted, scope), 0)
    assert.deepEqual(counted.statements, [{ text: TEARDOWN_SQL.countW4(filter.own), params: filter.params }], `${smoke}: countW4ImmutableAttendanceRows`)

    const classified = recordingDb()
    assert.equal((await classifyStagingAttendanceCleanup(classified, scope)).allowedDelete, true)
    assert.deepEqual(classified.statements, [{ text: TEARDOWN_SQL.countW4(filter.own), params: filter.params }], `${smoke}: classifyStagingAttendanceCleanup`)

    const tornDown = recordingDb()
    await runStagingAttendanceRecordTeardown(tornDown, scope)
    assert.deepEqual(tornDown.statements, [
      { text: TEARDOWN_SQL.countW4(filter.own), params: filter.params },
      { text: TEARDOWN_SQL.countW4(filter.own), params: filter.params },
      { text: TEARDOWN_SQL.deleteNonW4(filter.own), params: filter.params },
      { text: TEARDOWN_SQL.count(filter.own), params: filter.params },
    ], `${smoke}: runStagingAttendanceRecordTeardown`)
    for (const statement of [...counted.statements, ...classified.statements, ...tornDown.statements]) assertLeftPlaceholders(statement)
  }
})

test('userIdPrefix pin: the placeholder rule rejects the 42883 shape and accepts the fixed one', () => {
  const shared = { text: 'SELECT 1 FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $2', params: ['default', 'mp6-smoke-t1-'] }
  assert.throws(() => assertLeftPlaceholders(shared), /\$2 is left\(\)'s length and is used again/)
  const textLength = { text: 'SELECT 1 FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3', params: ['default', 'mp6-smoke-t1-', 'mp6-smoke-t1-'] }
  assert.throws(() => assertLeftPlaceholders(textLength), /must be bound to an integer/)
  assert.doesNotThrow(() => assertLeftPlaceholders({ text: 'SELECT 1 FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3', params: ['default', 13, 'mp6-smoke-t1-'] }))
  assert.doesNotThrow(() => assertLeftPlaceholders({ text: 'SELECT 1 FROM attendance_records WHERE org_id = $1 AND left(user_id, length($2::text)) = $2::text', params: ['default', 'mp6-smoke-t1-'] }))
  assert.throws(
    () => assertLeftPlaceholders({ text: 'SELECT 1 FROM attendance_records WHERE org_id = $1 AND left(user_id, length($2::text)) = $3::text', params: ['default', 'a-', 'b-'] }),
    /must be the same parameter/,
  )
})

// --- opt-in: real PostgreSQL (TEARDOWN_REAL_PG_DATABASE_URL; see the header comment) ----------
//
// Seeds, inside one transaction that is rolled back at the end, attendance_records rows with the
// smokes' own INSERT column list: for each of the four window smoke scopes, rows stamped with that
// smoke's user prefix and canaries that must survive (a user without the prefix in the same org,
// another run of the same smoke family, a near miss that extends the stamp by one character, the
// prefix in the middle of a user id, the bare stamp, and a prefixed user in another org; for ae4,
// whose scope is the prefix AND its record ids, also a prefixed user's row outside those ids).
// It then runs cleanupStagingAttendanceScope for each scope in turn, through the smokes' query
// wrapper, and checks by the seeded ids (never by the predicate under test) that each scope
// removed exactly its own stamped rows, that every other scope's stamped rows and every canary
// were still there, and that the helper reported exactly those ids. The {orgId, userIds} and
// {orgId, recordIds} scopes other smokes pass, and the three functions that build the prefix
// filter themselves, run the same way. Every row is legacy (no calculation), so retireRecord
// must never be called.

const REAL_PG_ENV = 'TEARDOWN_REAL_PG_DATABASE_URL'
const REAL_PG_URL = process.env[REAL_PG_ENV] || ''

// Row, scope and canary layout for one real-PostgreSQL run; `run` makes every id unique.
function realPgFixture(run) {
  let day = 0
  const workDate = () => {
    day += 1
    return new Date(Date.UTC(2001, 0, 1) + day * 86_400_000).toISOString().slice(0, 10)
  }
  const row = (userId, orgId, label) => ({ id: randomUUID(), userId, orgId, workDate: workDate(), label })
  const otherOrg = `tdpg-${run}-other-org`
  const groups = []
  const smokeGroup = (smoke, family, users, orgFor) => {
    const stamp = `${family}-smoke-pg${run}`
    const prefix = `${stamp}-`
    const orgId = orgFor(stamp)
    const stamped = users.map((user) => row(`${prefix}${user}`, orgId, 'stamped'))
    const canaries = [
      row(`tdpg-${run}-${smoke}-unstamped`, orgId, 'same org, no prefix'),
      row(`${family}-smoke-pgzz${run}-${users[0]}`, orgId, 'another run of the same smoke family'),
      row(`${stamp}2-${users[0]}`, orgId, 'near miss: the stamp extended by one character'),
      row(`x-${prefix}${users[0]}`, orgId, 'the prefix in the middle of the user id'),
      row(stamp, orgId, 'the bare stamp, shorter than the prefix'),
      row(`${prefix}${users[0]}`, orgId === 'default' ? otherOrg : 'default', 'a prefixed user in another org'),
    ]
    return { name: smoke, prefix, orgId, stamped, canaries }
  }
  const ae4 = smokeGroup('ae4', 'ae4', ['notify', 'skip', 'closed'], () => 'default')
  ae4.canaries.push(row(`${ae4.prefix}notify`, 'default', 'a prefixed user, record id outside ae4 recordIds'))
  ae4.scope = { orgId: 'default', userIdPrefix: ae4.prefix, recordIds: ae4.stamped.map((r) => r.id) }
  const otbank = smokeGroup('otbank-v18', 'otbank-v18', ['case1', 'case2', 'mustpay'], () => 'default')
  otbank.scope = { orgId: 'default', userIdPrefix: otbank.prefix }
  const mp6 = smokeGroup('mp6', 'mp6', ['subject', 'subject'], () => 'default')
  mp6.scope = { orgId: 'default', userIdPrefix: mp6.prefix }
  const hmr5 = smokeGroup('hmr5', 'hmr5', ['worker', 'outside', 'scoped'], (stamp) => `${stamp}-org`)
  hmr5.scope = { orgId: hmr5.orgId, userIdPrefix: hmr5.prefix, userIds: undefined }
  groups.push(ae4, otbank, mp6, hmr5)

  // The shapes the other attendance smokes pass (a2, t6, o6, s2-3, report-sync-a2: userIds).
  const idsOrg = `tdpg-${run}-ids-org`
  const byUser = { name: 'userIds', orgId: idsOrg, stamped: [row(`tdpg-${run}-u1`, idsOrg, 'stamped'), row(`tdpg-${run}-u2`, idsOrg, 'stamped')], canaries: [row(`tdpg-${run}-u3`, idsOrg, 'same org, another user'), row(`tdpg-${run}-u1`, otherOrg, 'a listed user in another org')] }
  byUser.scope = { orgId: idsOrg, userIds: [`tdpg-${run}-u1`, `tdpg-${run}-u2`] }
  const recOrg = `tdpg-${run}-rec-org`
  const byRecord = { name: 'recordIds', orgId: recOrg, stamped: [row(`tdpg-${run}-r1`, recOrg, 'stamped'), row(`tdpg-${run}-r2`, recOrg, 'stamped')], canaries: [row(`tdpg-${run}-r1`, recOrg, 'same user, record id not listed')] }
  byRecord.scope = { orgId: recOrg, recordIds: byRecord.stamped.map((r) => r.id) }
  groups.push(byUser, byRecord)

  // Direct calls of the three functions that build the prefix filter themselves.
  const directOrg = `tdpg-${run}-direct-org`
  const directPrefix = `tdpg-${run}-direct-`
  const direct = { name: 'direct', orgId: directOrg, stamped: [row(`${directPrefix}a`, directOrg, 'stamped'), row(`${directPrefix}b`, directOrg, 'stamped')], canaries: [row(`tdpg-${run}-direct`, directOrg, 'the prefix without its dash'), row(`${directPrefix}a`, otherOrg, 'a prefixed user in another org')] }
  direct.scope = { orgId: directOrg, userIdPrefix: directPrefix }
  return { groups, direct }
}

test(`REAL PG (opt-in, ${REAL_PG_ENV}): each window smoke's cleanup scope removes its own stamped rows and leaves every canary`, { skip: REAL_PG_URL ? false : `set ${REAL_PG_ENV} to a migrated database to run (see the header comment)` }, async (t) => {
  const pg = createRequire(new URL('../../packages/core-backend/package.json', import.meta.url))('pg')
  const client = new pg.Client({ connectionString: REAL_PG_URL })
  await client.connect()
  // The smokes' q and query wrapper (see SMOKE_QUERY_WRAPPER), on this test's one connection.
  const q = (text, params = []) => client.query(text, params).then((result) => result.rows)
  const db = { query: async (sql, params) => {
    const r = await q(sql, params)
    return { rows: r?.rows ?? (Array.isArray(r) ? r : []) }
  } }
  const retired = []
  const retireRecord = async (row) => { retired.push(row.id) }
  try {
    await client.query('BEGIN')
    const [ready] = await q(`SELECT
        to_regclass('public.attendance_records') IS NOT NULL AS records,
        to_regclass('public.attendance_record_calculations') IS NOT NULL AS calculations,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'attendance_records' AND column_name = 'visibility_reason') AS w4_columns`)
    assert.ok(ready?.records && ready?.calculations && ready?.w4_columns, `${REAL_PG_ENV} must name a migrated database (attendance_records with the W4 columns, and attendance_record_calculations): ${JSON.stringify(ready)}`)

    const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
    const { groups, direct } = realPgFixture(run)
    const allGroups = [...groups, direct]
    for (const row of allGroups.flatMap((group) => [...group.stamped, ...group.canaries])) {
      await q(
        `INSERT INTO attendance_records
           (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
            work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
            source_batch_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'UTC', NULL, NULL, 0, 0, 0, 'absent', true, $5::jsonb, NULL, now(), now())`,
        [row.id, row.userId, row.orgId, row.workDate, JSON.stringify({ seed: 'teardown-real-pg', label: row.label })],
      )
    }
    const present = async (rows) => {
      const found = await q('SELECT id::text AS id FROM attendance_records WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)])
      return found.length
    }
    const canaries = allGroups.flatMap((group) => group.canaries)

    const failures = []
    for (const [index, group] of groups.entries()) {
      const before = { stamped: await present(group.stamped), canaries: await present(group.canaries) }
      await client.query('SAVEPOINT teardown_scope')
      let result = null
      try {
        result = await cleanupStagingAttendanceScope(db, group.scope, { retireRecord })
        await client.query('RELEASE SAVEPOINT teardown_scope')
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT teardown_scope')
        failures.push(`${group.name}: ${error?.code || ''} ${error?.message || error}`)
      }
      const after = { stamped: await present(group.stamped), canaries: await present(group.canaries) }
      t.diagnostic(`${group.name}: stamped ${before.stamped} -> ${after.stamped}, canaries ${before.canaries} -> ${after.canaries}, result ${JSON.stringify(result && { retiredCount: result.retiredCount, toolingDeletedCount: result.toolingDeletedCount })}`)
      if (result === null) continue
      assert.equal(after.stamped, 0, `${group.name}: every stamped row is removed`)
      assert.deepEqual([...result.toolingDeleted].sort(), group.stamped.map((r) => r.id).sort(), `${group.name}: the helper deleted exactly the stamped rows`)
      assert.equal(result.retiredCount, 0, `${group.name}: no row was W4-backed`)
      for (const later of groups.slice(index + 1)) {
        assert.equal(await present(later.stamped), later.stamped.length, `${group.name}: ${later.name}'s stamped rows are untouched`)
      }
      assert.equal(await present(canaries), canaries.length, `${group.name}: every canary survives`)
    }
    assert.deepEqual(failures, [], 'every scope must clean up without an error')

    // The three functions that build the prefix filter themselves, called with a prefix scope.
    assert.equal(await countW4ImmutableAttendanceRows(db, direct.scope), 0)
    assert.equal((await classifyStagingAttendanceCleanup(db, direct.scope)).allowedDelete, true)
    await runStagingAttendanceRecordTeardown(db, direct.scope)
    assert.equal(await present(direct.stamped), 0, 'direct: the record teardown removes the prefixed rows')
    assert.equal(await present(canaries), canaries.length, 'direct: every canary survives')
    t.diagnostic(`direct: stamped ${direct.stamped.length} -> 0, canaries ${canaries.length} kept`)

    assert.deepEqual(retired, [], 'retireRecord is never called for legacy rows')
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end().catch(() => undefined)
  }
})
