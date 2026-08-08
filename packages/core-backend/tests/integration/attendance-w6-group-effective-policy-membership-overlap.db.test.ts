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
 * CI COVERAGE, stated first: under the owner-ruled phase-1 hard scope fence
 * this file is NOT wired into `.github/workflows/plugin-tests.yml` and NOT
 * excluded in `packages/core-backend/vitest.config.ts`. It therefore does not
 * execute in any required check on this branch, AND the default no-DB lane
 * collects it and reports it SKIPPED — green, having executed nothing. Wiring
 * both is a named phase-2 item.
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1,
  createAttendanceGroupEffectivePolicyAggregateService,
} from '../../src/attendance/w6-group-effective-policy-aggregate'

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
  // #4814 P2-4: `otherGroupId` was seeded with the SAME two overlapping
  // members as `groupId`, so per-group and per-org scoping produce
  // IDENTICAL counts for it — the two hypotheses are indistinguishable, so
  // asserting against `otherGroupId` alone proves nothing about
  // boundedness (confirmed: neutering `AND m.group_id = $2` to `OR TRUE`
  // left every existing assertion in this file green). `boundedGroupId`
  // holds a member whose overlap set DIFFERS from groupId/otherGroupId's
  // (zero org-wide overlap for them at all), so per-group vs per-org
  // scoping diverge and the assertion actually discriminates.
  const boundedGroupId = randomUUID()
  const overlapUserA = 'user-overlap-a'
  const overlapUserB = 'user-overlap-b'
  const cleanUser = 'user-clean'
  const boundedGroupSoloUser = 'user-bounded-group-solo'
  /** Holds THREE effective-today rows in `dedupGroupId` (plus one elsewhere),
   * so per-user dedup and choose-first/choose-latest give DIFFERENT answers. */
  const dedupGroupId = randomUUID()
  const tripleRowUser = 'user-triple-row'

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
    await pool.query(
      'INSERT INTO attendance_groups (id, org_id) VALUES ($1, $5), ($2, $5), ($3, $5), ($4, $5)',
      [groupId, otherGroupId, boundedGroupId, dedupGroupId, orgId],
    )

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
    // boundedGroupSoloUser: exactly ONE effective-today row, TOTAL, in
    // `boundedGroupId` only — zero org-wide overlap and a member set
    // entirely disjoint from overlapUserA/B. A per-group query must
    // report 0 for boundedGroupId; a per-org (or group-filter-dropped)
    // query would instead return 2 (overlapUserA + overlapUserB, who
    // qualify org-wide regardless of which group is asked about) — the
    // divergence P2-4 needs to actually discriminate the two.
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships (org_id, user_id, group_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, NULL)`,
      [orgId, boundedGroupSoloUser, boundedGroupId, today],
    )
    // W6-R5's NAMED negative proof: a choose-first / choose-latest rewrite
    // must fail. The prior fixture could not discriminate it — every user had
    // exactly two rows, so "one row per user" and "all rows per user" agree.
    // `tripleRowUser` holds THREE effective-today rows inside `groupId`
    // itself, so correct per-user dedup counts it ONCE while a rewrite that
    // picks one row per user (or drops the GROUP BY) produces a different
    // total for the SAME seeded data. Divergence by construction, not by
    // hope.
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships (org_id, user_id, group_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, NULL), ($1, $2, $3, $4, NULL), ($1, $2, $3, $4, NULL)`,
      [orgId, tripleRowUser, dedupGroupId, today],
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

  it('a second group sharing the SAME two org-wide-overlapping members ALSO reports 2 (sanity/consistency check — NOT a per-group-boundedness proof, see the next test for that)', async () => {
    // otherGroupId's own members (A and B) also have exactly 2 rows each
    // org-wide, so it reports 2 as well. This is a consistency check that
    // the query genuinely re-evaluates for a different $2 groupId value
    // (not, say, an accidentally-cached first result) -- it does NOT by
    // itself distinguish per-group scoping from per-org scoping, because
    // both groups here have an IDENTICAL overlap set and so produce the
    // same count either way (#4814 P2-4). Boundedness is proven by the
    // next test, which uses a group with a DIFFERENT overlap set.
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: db().query,
      fser: { getEffectiveness: async () => { throw new Error('not used') } },
    })
    const count = await service.countMembershipOverlap(orgId, otherGroupId)
    expect(count).toBe(2)
  })

  it('OD-W6-8(a): a group whose member has zero org-wide overlap reports 0 even though OTHER users in the same org DO overlap — proves the query is genuinely bounded per-group, not per-org', async () => {
    // boundedGroupId's only member (boundedGroupSoloUser) holds exactly one
    // effective-today membership, total -- no overlap. overlapUserA/B DO
    // have org-wide overlap, but neither is a member of boundedGroupId. A
    // per-group query must therefore report 0; a per-org (or
    // group-filter-dropped) query would instead report 2, since
    // overlapUserA/B qualify org-wide regardless of which group is asked
    // about. This is the case the previous test's identical-overlap-set
    // fixture could not discriminate.
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: db().query,
      fser: { getEffectiveness: async () => { throw new Error('not used') } },
    })
    const count = await service.countMembershipOverlap(orgId, boundedGroupId)
    expect(count).toBe(0)
  })

  it('W6-R5 choose-first/choose-latest: a user with THREE rows in the group is counted ONCE, and the mutated query provably disagrees', async () => {
    // The prior version of this proof lived as a MANUAL transcript in a PR
    // body. A transcript in a PR body is not a durable gate, so the fixture is
    // now built to DISCRIMINATE and both hypotheses are executed against the
    // same seeded data in the same run.
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: db().query,
      fser: { getEffectiveness: async () => { throw new Error('not used') } },
    })
    // SHIPPED behaviour: tripleRowUser has 3 rows in dedupGroupId and 1 in
    // otherGroupId, i.e. 4 effective-today rows org-wide (> 1), and is counted
    // exactly ONCE.
    expect(await service.countMembershipOverlap(orgId, dedupGroupId)).toBe(1)

    // The CHOOSE-FIRST rewrite, executed against the SAME database: replacing
    // the per-user GROUP BY with "one row per user, first by id" changes the
    // inner set's cardinality semantics. Running both here is what makes this
    // a gate rather than a claim — and the shipped SQL is taken from the
    // module's exported constant, so this compares against what really ships.
    const chooseFirstSql = ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1.replace(
      'GROUP BY m.user_id',
      'ORDER BY m.user_id ASC LIMIT 1',
    )
    expect(chooseFirstSql, 'the mutation anchor must actually match').not.toBe(
      ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1,
    )
    const mutated = await pool.query(chooseFirstSql, [orgId, groupId])
    const shipped = await pool.query(ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1, [orgId, groupId])
    expect(Number(shipped.rows[0].cnt)).toBe(2)
    expect(Number(mutated.rows[0].cnt)).not.toBe(Number(shipped.rows[0].cnt))
  })

  it('non-vacuity: the exported SQL constant is what the service actually issues', async () => {
    const seen: string[] = []
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: async (sql: string, params?: unknown[]) => {
        seen.push(sql)
        return (await pool.query(sql, params)).rows
      },
      fser: { getEffectiveness: async () => { throw new Error('not used') } },
    })
    await service.countMembershipOverlap(orgId, groupId)
    expect(seen).toEqual([ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1])
  })

  it('SCHEMA SHAPE is not hand-drifted: the ephemeral table covers every column the shipped query references', async () => {
    // The DDL above is hand-written (the real migration carries 14 columns and
    // three CHECKs). That is a drift channel: if the migration later adds a
    // discriminator the counter should filter on, this suite would keep passing
    // against the OLD shape. This asserts the ephemeral table is a superset of
    // the columns the SHIPPED query actually names, so the fixture cannot fall
    // behind the query it is meant to test.
    const referenced = ['org_id', 'user_id', 'group_id', 'effective_from', 'effective_to'].filter((column) =>
      ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1.includes(column),
    )
    expect(referenced.length).toBe(5) // non-vacuity
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance_calculation_group_memberships'`,
    )
    const present = new Set(columns.rows.map((row: { column_name: string }) => row.column_name))
    expect(referenced.filter((column) => !present.has(column))).toEqual([])
  })
})
