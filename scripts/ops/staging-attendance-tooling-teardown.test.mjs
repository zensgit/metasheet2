#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
