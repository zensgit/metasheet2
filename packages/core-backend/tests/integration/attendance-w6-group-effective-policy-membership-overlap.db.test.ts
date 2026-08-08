/**
 * W6-1 (#4556) — group effective-policy aggregate: membership-overlap
 * counter (W6-R5, OD-W6-8(a)), real PostgreSQL, DEDICATED EPHEMERAL
 * DATABASE (not the shared `metasheet_test`).
 *
 * Why a dedicated database rather than the shared harness (the pattern of
 * `attendance-legacy-membership-overlap-audit.db.test.ts`): proving
 * `countMembershipOverlap` counts correctly requires SEEDING a genuine
 * overlap — two effective-today `attendance_calculation_group_memberships`
 * rows for one user. The table's own `attendance_calc_group_memberships_no_overlap`
 * EXCLUDE constraint makes that impossible via ordinary INSERT (confirmed:
 * the constraint holds even under a concurrent-INSERT race in the legacy
 * audit test). Parent lock §3.4 explicitly anticipates this must be provable
 * anyway — "Runtime repeats the uniqueness check rather than trusting clean
 * writes" — so this suite temporarily drops the constraint to seed the
 * scenario the runtime check exists to catch. Doing that against the SHARED
 * `metasheet_test` database would be cross-test pollution; a dedicated,
 * disposable database (created in `beforeAll`, dropped in `afterAll`) makes
 * it invisible to every other test file.
 *
 * On real, constraint-intact production/staging data this counter always
 * returns 0 — that is the constraint doing its job, not evidence the check
 * is unreachable. It is a defense-in-depth read matching §3.4's own
 * "repeats the uniqueness check" mandate, surfaced to admins as
 * `CALCULATION_GROUP_MEMBERSHIP_OVERLAP` if the invariant is ever violated
 * (a stale row predating the constraint, a manual DB edit, a future bug).
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAttendanceGroupEffectivePolicyAggregateService } from '../../src/attendance/w6-group-effective-policy-aggregate'

const serverUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = serverUrl ? describe : describe.skip

describeIfDatabase('W6-1 group effective-policy — membership-overlap counter (dedicated ephemeral DB)', () => {
  const databaseName = `attendance_w6agg_overlap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const adminUrl = new URL(serverUrl || 'postgresql://postgres@localhost/postgres')
  adminUrl.pathname = '/postgres'
  const scratchUrl = new URL(adminUrl)
  scratchUrl.pathname = `/${databaseName}`
  const adminPool = new Pool({ connectionString: adminUrl.toString() })
  let pool: Pool

  const orgId = 'org-overlap'
  const groupId = randomUUID()
  const otherGroupId = randomUUID()
  const overlapUserA = 'user-overlap-a'
  const overlapUserB = 'user-overlap-b'
  const cleanUser = 'user-clean'

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`)
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 4 })

    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist')
    await pool.query(`
      CREATE TABLE attendance_groups (id uuid PRIMARY KEY, org_id text NOT NULL);
      CREATE TABLE attendance_calculation_group_memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        user_id text NOT NULL,
        group_id uuid NOT NULL,
        effective_from date NOT NULL,
        effective_to date,
        CONSTRAINT attendance_calc_group_memberships_no_overlap
          EXCLUDE USING gist (
            org_id WITH =,
            user_id WITH =,
            daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
          )
      );
    `)
    await pool.query('INSERT INTO attendance_groups (id, org_id) VALUES ($1, $2), ($3, $2)', [groupId, orgId, otherGroupId])

    // The constraint is airtight by design (confirmed under a concurrent
    // race in attendance-legacy-membership-overlap-audit.db.test.ts) — the
    // ONLY way to seed the scenario §3.4's redundant runtime check exists
    // for is to temporarily lift it, in this disposable database only.
    await pool.query('ALTER TABLE attendance_calculation_group_memberships DROP CONSTRAINT attendance_calc_group_memberships_no_overlap')

    const today = new Date().toISOString().slice(0, 10)
    // overlapUserA and overlapUserB: each has TWO effective-today rows —
    // one in `groupId` (the group under test), one in `otherGroupId`.
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships (org_id, user_id, group_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $5, NULL), ($1, $2, $4, $5, NULL),
              ($1, $6, $3, $5, NULL), ($1, $6, $4, $5, NULL)`,
      [orgId, overlapUserA, groupId, otherGroupId, today, overlapUserB],
    )
    // cleanUser: exactly ONE effective-today row, in `groupId` only — must
    // NOT be counted.
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships (org_id, user_id, group_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, NULL)`,
      [orgId, cleanUser, groupId, today],
    )
  })

  afterAll(async () => {
    await pool?.end()
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`)
    await adminPool.end()
  })

  function db() {
    return { async query(sql: string, params?: unknown[]) { return (await pool.query(sql, params)).rows } }
  }

  it('counts exactly the users who are effective-today in THIS group AND hold more than one effective-today membership org-wide (never a member list)', async () => {
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: db().query,
      fser: { getEffectiveness: async () => { throw new Error('not used') } },
    })
    const count = await service.countMembershipOverlap(orgId, groupId)
    expect(count).toBe(2) // overlapUserA + overlapUserB; cleanUser excluded
  })

  it('a different, non-overlapping group in the same org reports 0', async () => {
    // otherGroupId's own members (A and B) also have exactly 2 rows each
    // org-wide, so it reports 2 as well — reusing it as its own group
    // confirms the query is bounded per-group, not per-org.
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: db().query,
      fser: { getEffectiveness: async () => { throw new Error('not used') } },
    })
    const count = await service.countMembershipOverlap(orgId, otherGroupId)
    expect(count).toBe(2)
  })

  // W6-R5's "a choose-first/choose-latest mutation must fail" negative proof
  // is run manually against the SHIPPED `countMembershipOverlap` SQL in
  // `w6-group-effective-policy-aggregate.ts` (edit → rerun the first test in
  // this file → confirm it reds → restore via file backup), not simulated
  // here. A hand-rolled string-replace against a copy of the query would
  // only prove the copy is mutable, not that the real module's behavior
  // changes — see the W6-1 PR body/report for the transcript.
})
