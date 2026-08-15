/**
 * W7-1b (#4556) — the ISSUANCE SEAM against a real host and a real DB.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * This suite boots the REAL `MetaSheetServer` with the REAL plugin, so the seam
 * it exercises is the one `activate()` wired into the production mirror — not a
 * re-assembled copy of it. A seam suite that constructs its own deps would pass
 * while the production wiring was broken.
 *
 * ---------------------------------------------------------------------------
 * NO SKIP-WHEN-UNREACHABLE
 * ---------------------------------------------------------------------------
 * The seam export's presence is asserted UNCONDITIONALLY. An earlier draft
 * guarded it with `if (!seam) return`, which at the 1b head would have let a
 * seam that failed to export self-skip GREEN — the green-test-against-nothing
 * shape this codebase has been burned by. The pre-1b base run legitimately
 * lacked the export; the record of that is the vector file's
 * `capturedAtBaseSha`, not a skip in this file.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIXTURES ARE, AND WHY THE HEAVY ONE IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * Ruling 7's control (T-M1) requires the group arm to have actually PRODUCED a
 * context — "a registry-witnessed V2 with `selector: 'group_effective'` and a
 * non-empty `calculationGroupId`", not merely "not the legacy shape". A fixture
 * whose group is not fully effective fails the facts resolver closed and yields
 * a NULL context, which satisfies neither conjunct. So `groupOrg` below is
 * seeded to FULL effectiveness — W1 membership + a `fixed_shift` group + a
 * fixed-schedule config + a published managed assignment whose producer key
 * matches the config — using the REAL exported FSER derivation and the REAL
 * canonical producer-key builder, never a stub. A stubbed predicate would make
 * every `effective` assertion here a test of the stub.
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { canonicalAttendanceJsonV1 } from '../../src/attendance/w4c0-fingerprints'
import { isCoreIssuedGroupEffectiveContextV2 } from '../../src/attendance/w7-resolver/w7-group-effective-context-issuance'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'
const WORK_DATE = '2026-01-05'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTOR_PATH = path.join(HERE, 'fixtures', 'w7-1b-legacy-arm-golden-vectors.json')

const requireCjs = createRequire(import.meta.url)
/* eslint-disable @typescript-eslint/no-var-requires */
const { buildAttendanceGroupFixedScheduleProducerKey } = requireCjs(
  '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
)

type SeamResult = {
  arm: 'legacy' | 'group'
  context: Record<string, unknown> | null
  reason: string | null
}
type SeamFn = (
  trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
  args: Record<string, unknown>,
) => Promise<SeamResult>

function loadSeam(): SeamFn {
  const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
    __attendanceW7IssuanceSeamForTests?: { issueAttendanceFrozenContextV1: SeamFn | null }
  }
  const ref = plugin.__attendanceW7IssuanceSeamForTests
  // UNCONDITIONAL. See the header — a presence guard here is a self-disarming
  // gate, and `activate()` not having run is exactly the failure it would hide.
  expect(ref, 'the plugin must export the W7-1b issuance seam reference').toBeTruthy()
  expect(
    typeof ref?.issueAttendanceFrozenContextV1,
    'the seam must be POPULATED by activate() — a null ref means the host port ' +
      'was not wired, which is precisely what this suite exists to catch',
  ).toBe('function')
  return ref!.issueAttendanceFrozenContextV1 as SeamFn
}

function pluginTrx(pool: Pool) {
  return { query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows }
}

/** Same redaction + canonicalisation the golden harness uses, so the two
 *  instruments compare the same object. Duplicated deliberately rather than
 *  imported: the harness must keep ZERO dependency on anything 1b added, and
 *  importing a shared helper from here into it would break that. */
const IDENTITY_KEYS = new Set(['orgId', 'userId', 'workDate', 'shiftId'])
function redactIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactIdentity)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = IDENTITY_KEYS.has(key)
        ? `<redacted:${key}>`
        : redactIdentity((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
const canonicalOf = (context: unknown) => canonicalAttendanceJsonV1(redactIdentity(context))

type HttpResponse = { status: number; body?: any; raw: string }
function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describeDb('W7-1b — issuance seam, mirror gate and ruling-7 controls (real host, real DB)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let seam: SeamFn
  let vectors: { entries: Record<string, { context: string }> }

  // Env snapshots. vitest leaks `process.env` across files; without exact
  // save/restore the W4-unset premise of T-M1 becomes vacuous.
  let priorW4: string | undefined
  let priorW7: string | undefined

  // --- fixtures ---
  // The legacy corpus mirrors the golden harness's, so the seam can be compared
  // against the base vectors fixture-for-fixture.
  const legacy = {
    workday: { orgId: randomUUID(), userId: randomUUID(), shiftId: randomUUID() },
    multi_segment: { orgId: randomUUID(), userId: randomUUID(), shiftId: randomUUID() },
  }
  // The FULLY EFFECTIVE group fixture (T-M1 / T-R1).
  const groupOrg = randomUUID()
  const groupUser = randomUUID()
  const groupShift = randomUUID()
  const groupId = randomUUID()
  // A group org whose W1 membership is ABSENT — the O-9 fail-closed fixture.
  const gapOrg = randomUUID()
  const gapUser = randomUUID()
  const gapShift = randomUUID()
  // Inert negative-control orgs.
  const allowlistOnlyOrg = randomUUID()
  const rowOnlyOrg = randomUUID()
  const shadowOrg = randomUUID()
  // A plain org for the arm-A half of the disjunction leg (no posture row).
  const legacyPunchOrg = randomUUID()
  const legacyPunchUser = randomUUID()
  const legacyPunchShift = randomUUID()

  let baseUrl = ''
  const mintToken = async (userId: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  const allOrgs = () => [
    legacy.workday.orgId,
    legacy.multi_segment.orgId,
    groupOrg,
    gapOrg,
    allowlistOnlyOrg,
    rowOnlyOrg,
    shadowOrg,
    legacyPunchOrg,
  ]

  async function insertShift(
    orgId: string,
    shiftId: string,
    name: string,
    segments: readonly { start: string; end: string; endDayOffset?: 0 | 1 }[],
    // Wall-clock window of the SHIFT row. Legs that punch the real route at
    // `new Date()` (T-M1 route) must use a FULL-DAY window: with 09:00-18:00
    // Asia/Shanghai (+120min tail) the candidate stops resolving after
    // 12:00 UTC, so the leg was green or red depending on the WALL CLOCK of
    // the run — green in every CI run before 10:40 UTC, red at 13:22 UTC on
    // both matrix legs with no code change. Time-of-day is not an input a
    // test may depend on. The cutover e2e's fixtures are full-day for the
    // same reason (safe at midnight since the h24 hourCycle fix).
    workWindow: { start: string; end: string } = { start: '09:00', end: '18:00' },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, $3, 'Asia/Shanghai', $4, $5, false, '[0,1,2,3,4,5,6]'::jsonb,
               5, 7, 15, 'strict')`,
      [shiftId, orgId, name, workWindow.start, workWindow.end],
    )
    for (let i = 0; i < segments.length; i += 1) {
      await pool.query(
        `INSERT INTO attendance_shift_segments
           (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
        [randomUUID(), orgId, shiftId, i, segments[i].start, segments[i].end, segments[i].endDayOffset ?? 0],
      )
    }
  }

  /** `attendance_calculation_group_memberships` carries a plpgsql guard
   *  (`attendance_calc_group_membership_user_org_required`) that refuses a
   *  membership whose user is not an ACTIVE member of the org. Seeding the user
   *  is therefore part of the fixture, not incidental setup. */
  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W7-1b seam fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w7-1b.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  /** A group that the facts resolver will accept as FULLY EFFECTIVE. Every
   *  component is required; omitting any one of them silently converts T-M1
   *  into a fail-closed leg that still says "the group arm ran". */
  async function seedEffectiveGroup(orgId: string, userId: string, shiftId: string, gid: string) {
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
       VALUES ($1, $2, $3, 'fixed_shift', 'Asia/Shanghai')`,
      [gid, orgId, `w7-1b group ${gid}`],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 1, 'w7-1b-fixture')`,
      [orgId, gid, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
      [orgId, gid, userId],
    )
    const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
      groupId: gid,
      shiftId,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active,
          producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', true,
               'attendance_group_fixed_schedule', $4, $5, $6, 'published')`,
      [orgId, userId, shiftId, gid, producerKey, randomUUID()],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships
         (org_id, user_id, group_id, effective_from, effective_to,
          assigned_by, assigned_reason, assigned_correlation_id)
       VALUES ($1, $2, $3, '2026-01-01', NULL, 'w7-1b-fixture', 'seed', $4)`,
      [orgId, userId, gid, `w7-1b-corr-${gid}`],
    )
  }

  const setPosture = (orgId: string, state: string) =>
    pool.query(
      `INSERT INTO ${POSTURE_TABLE} (org_id, state, scope) VALUES ($1, $2, 'synthetic_staging')`,
      [orgId.toLowerCase(), state],
    )

  const issue = (orgId: string, userId: string, shiftId: string, purpose: 'persist' | 'mirror' = 'persist') =>
    seam(pluginTrx(pool), {
      orgId,
      userId,
      workDate: WORK_DATE,
      timezone: 'Asia/Shanghai',
      isWorkday: true,
      holidayKind: null,
      shiftId,
      purpose,
    })

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W7-1b seam suite needs a loopback port + DATABASE_URL')

    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    delete process.env[W4_ENV]
    delete process.env[W7_ENV]

    const repoRoot = path.join(HERE, '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`

    pool = new Pool({ connectionString: dbUrl })
    seam = loadSeam()
    vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'))

    await insertShift(legacy.workday.orgId, legacy.workday.shiftId, 'w7-1b legacy workday', [
      { start: '09:00', end: '18:00' },
    ])
    await insertShift(legacy.multi_segment.orgId, legacy.multi_segment.shiftId, 'w7-1b legacy multi', [
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
    ])
    // FULL-DAY window: this org's T-M1 route leg punches at `new Date()`, and
    // its candidate must resolve at ANY wall-clock hour (see insertShift note).
    await insertShift(
      groupOrg,
      groupShift,
      'w7-1b group shift',
      [{ start: '00:00', end: '23:59' }],
      { start: '00:00', end: '23:59' },
    )
    await insertActiveUser(groupUser, groupOrg)
    await seedEffectiveGroup(groupOrg, groupUser, groupShift, groupId)
    await insertShift(gapOrg, gapShift, 'w7-1b gap shift', [{ start: '09:00', end: '18:00' }])
    await insertActiveUser(gapUser, gapOrg)
    // Arm-A fixture: an ordinary org with a published assignment, NO posture row.
    await insertShift(legacyPunchOrg, legacyPunchShift, 'w7-1b legacy punch', [
      { start: '09:00', end: '18:00' },
    ])
    await insertActiveUser(legacyPunchUser, legacyPunchOrg)
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', true, 'published', 1)`,
      [legacyPunchOrg, legacyPunchUser, legacyPunchShift],
    )
    // gapOrg deliberately has NO W1 membership -> `membership-absent`.
  }, 180_000)

  afterAll(async () => {
    const orgs = allOrgs()
    for (const table of [
      'attendance_calculation_group_memberships',
      'attendance_shift_assignments',
      'attendance_group_fixed_schedule_configs',
      'attendance_group_members',
      'attendance_groups',
      'attendance_shift_segments',
      'attendance_shifts',
    ]) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    }
    await pool
      ?.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [
        orgs.map((o) => o.toLowerCase()),
      ])
      .catch(() => undefined)
    await pool?.query(`DELETE FROM user_orgs WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    await pool
      ?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[groupUser, gapUser]])
      .catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

  // -------------------------------------------------------------------------
  // T-B2 (seam) / T-B3 — W7-R3 structural parity, measured by ONE instrument.
  // -------------------------------------------------------------------------

  it('T-B2 (seam): with the posture table empty the seam reproduces the pre-1b golden EXACTLY', async () => {
    expect(process.env[W4_ENV], 'the W4 env must be unset for this leg').toBeUndefined()
    for (const [id, fx] of Object.entries(legacy)) {
      const result = await issue(fx.orgId, fx.userId, fx.shiftId)
      // Positive equality on the arm — `notEqual('group')` could not tell
      // "took the legacy arm" from "failed for another reason".
      expect(result.arm, `${id}: arm`).toBe('legacy')
      expect(result.reason, `${id}: reason`).toBeNull()
      expect(canonicalOf(result.context), `${id}: seam-routed context bytes`).toBe(
        vectors.entries[id].context,
      )
    }
  })

  it('T-B3 (paired POSITIVE control): a group-postured sibling MOVES the golden in the same run', async () => {
    // Without this leg, "the golden did not move" is equally consistent with
    // "the branch is correct", "the branch is dead code" and "the branch was
    // never wired". The discriminator must be the SAME instrument, same run.
    await setPosture(groupOrg, 'group_authoritative')
    process.env[W7_ENV] = groupOrg.toLowerCase()
    try {
      const moved = await issue(groupOrg, groupUser, groupShift)
      expect(moved.arm).toBe('group')
      expect(moved.context, 'the group arm must have PRODUCED a context').not.toBeNull()
      expect(
        canonicalOf(moved.context),
        'the group arm must not reproduce a legacy golden — if it does, the ' +
          'branch is dead code and T-B2 is measuring nothing',
      ).not.toBe(vectors.entries.workday.context)

      // ...while the no-row sibling in the SAME run is still byte-identical.
      const untouched = await issue(
        legacy.multi_segment.orgId,
        legacy.multi_segment.userId,
        legacy.multi_segment.shiftId,
      )
      expect(untouched.arm).toBe('legacy')
      expect(canonicalOf(untouched.context)).toBe(vectors.entries.multi_segment.context)
    } finally {
      delete process.env[W7_ENV]
    }
  })

  // -------------------------------------------------------------------------
  // T-M1 — RULING 7's REQUIRED POSITIVE CONTROL.
  // -------------------------------------------------------------------------

  it('T-M1: W4 var OFF + persisted group_authoritative + capability + EXACT allowlist => the group arm PRODUCES a registry-witnessed V2', async () => {
    // The W4 variable is asserted unset INSIDE the test, not assumed: vitest
    // env leakage across files would otherwise make this leg vacuous.
    expect(process.env[W4_ENV]).toBeUndefined()
    process.env[W7_ENV] = groupOrg.toLowerCase()
    try {
      const result = await issue(groupOrg, groupUser, groupShift)

      // (i) the group arm RAN AND PRODUCED — asserted as the registry witness
      // plus the two discriminants, not as "not the legacy shape". A null
      // context or an object literal would satisfy neither.
      expect(result.arm).toBe('group')
      expect(result.reason).toBeNull()
      expect(
        isCoreIssuedGroupEffectiveContextV2(result.context),
        'the context must carry op(i)’s module-private origin witness — a ' +
          'caller-fabricated literal is deliberately not in the registry',
      ).toBe(true)
      expect((result.context as Record<string, unknown>).schemaVersion).toBe(2)
      expect((result.context as Record<string, unknown>).selector).toBe('group_effective')
      expect((result.context as Record<string, unknown>).calculationGroupId).toBe(groupId)
      expect(
        String((result.context as Record<string, unknown>).calculationGroupId || ''),
      ).not.toBe('')
    } finally {
      delete process.env[W7_ENV]
    }
  })

  it('T-M1 (ROUTE LEVEL, ruling 7’s literal conjunction): W4 var OFF => the mirror’s group arm runs AND the outer fingerprint is NON-NULL, in ONE leg', async () => {
    // This is the half W7-1a named as UNMET by design of the split. It must be
    // ONE leg asserting BOTH conjuncts: two passing tests do not prove the two
    // can hold at once, and the ruling's hazard is precisely that the group arm
    // runs while the outer fingerprint is null, silently breaking the
    // source-definition conjunct on every punch.
    expect(process.env[W4_ENV], 'W4 var must be UNSET — asserted, not assumed').toBeUndefined()
    process.env[W7_ENV] = groupOrg.toLowerCase()

    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __setAttendanceW4LivePunchPreBoundarySeamForTests: (
        seam: ((ctx: Record<string, unknown>) => Promise<void>) | null,
      ) => void
    }
    const observed: Record<string, unknown>[] = []
    plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(async (ctx) => {
      observed.push(ctx)
    })
    try {
      const token = await mintToken(groupUser)
      const res = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: groupOrg, eventType: 'check_in', timezone: 'Asia/Shanghai' }),
      })
      // Non-vacuity first: an unhit probe and a dead gate look identical.
      expect(observed.length, `pre-boundary seam never fired: status=${res.status} body=${res.raw}`).toBeGreaterThan(0)
      const ctx = observed[observed.length - 1]

      // Conjunct (i): the mirror's GROUP arm ran — asserted as the registry
      // witness plus the discriminants, not "not the legacy shape".
      expect(ctx.w7MirrorEffectiveState).toBe('group_authoritative')
      expect(ctx.w7MirrorSelectsGroupArm).toBe(true)
      expect(
        isCoreIssuedGroupEffectiveContextV2(ctx.outerContext),
        'the mirror must have hashed a CORE-ISSUED group-effective V2 context',
      ).toBe(true)
      expect((ctx.outerContext as Record<string, unknown>).selector).toBe('group_effective')
      expect(String((ctx.outerContext as Record<string, unknown>).calculationGroupId || '')).not.toBe('')

      // Conjunct (ii): and the outer fingerprint is NON-NULL in that same run.
      // Type first: `typeof null === 'object'`, so asserting the shape alone
      // turns "the mirror never ran" into a TypeError that reads like a
      // producer type bug.
      expect(
        typeof ctx.outerSourceDefinitionFingerprint,
        'ruling 7 conjunct (ii) FAILED: the mirror produced no fingerprint at all',
      ).toBe('string')
      expect(ctx.outerSourceDefinitionFingerprint).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
      delete process.env[W7_ENV]
    }
  })

  it('T-M4 arm A: with the posture table effectively OFF for this org, the W4-env arm alone still governs (the disjunction is not collapsed)', async () => {
    // The `A || B` gate is short-circuit-blind under the default fixture: with
    // no group-postured org, B is always false, so deleting arm B is green
    // everywhere. The B-arm mutation is therefore run against the
    // `group_authoritative` fixture (T-M1 above IS that mutation's target);
    // this leg is its symmetric partner for arm A.
    expect(process.env[W4_ENV]).toBeUndefined()
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __setAttendanceW4LivePunchPreBoundarySeamForTests: (
        seam: ((ctx: Record<string, unknown>) => Promise<void>) | null,
      ) => void
    }
    const observed: Record<string, unknown>[] = []
    plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(async (ctx) => {
      observed.push(ctx)
    })
    try {
      const token = await mintToken(legacyPunchUser)
      await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: legacyPunchOrg, eventType: 'check_in', timezone: 'Asia/Shanghai' }),
      })
      expect(observed.length, 'the pre-boundary seam never fired').toBeGreaterThan(0)
      const ctx = observed[observed.length - 1]
      // Both arms false => the mirror does not run at all, exactly as before 1b.
      expect(ctx.w7MirrorEffectiveState).toBe('off')
      expect(ctx.w7MirrorSelectsGroupArm).toBe(false)
      expect(ctx.outerSourceDefinitionFingerprint).toBeNull()
    } finally {
      plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
    }
  })

  // -------------------------------------------------------------------------
  // T-M2 / T-M3 / T-M3b — the inert negative controls.
  //
  // `off`, `group_shadow`, `group_eligible` and `suspended` ALL take the legacy
  // arm, so "the legacy arm ran" is true under FOUR postures and would pass
  // with the two-part rule broken. Each leg therefore asserts the EXACT
  // effective state, and T-M3b keeps "off" and "not yet cut over"
  // distinguishable.
  // -------------------------------------------------------------------------

  it('T-M2: allowlist-only (no persisted row) => effectiveState is EXACTLY off, legacy arm', async () => {
    process.env[W7_ENV] = allowlistOnlyOrg.toLowerCase()
    try {
      const port = await resolveArm(allowlistOnlyOrg)
      expect(port.effectiveState).toBe('off')
      expect(port.selectsGroupArm).toBe(false)
      // Paired positive control: the env really parses — an entry that DOES
      // match a group_authoritative org yields the group arm in the same run,
      // so `off` is not being produced by a mis-parsed variable.
      process.env[W7_ENV] = `${allowlistOnlyOrg.toLowerCase()},${groupOrg.toLowerCase()}`
      const matching = await resolveArm(groupOrg)
      expect(matching.effectiveState).toBe('group_authoritative')
      expect(matching.selectsGroupArm).toBe(true)
    } finally {
      delete process.env[W7_ENV]
    }
  })

  it('T-M3: row-only (no allowlist entry) => effectiveState is EXACTLY off, legacy arm', async () => {
    await setPosture(rowOnlyOrg, 'group_authoritative')
    delete process.env[W7_ENV]
    const port = await resolveArm(rowOnlyOrg)
    expect(port.effectiveState).toBe('off')
    expect(port.selectsGroupArm).toBe(false)
    // Paired positive control, same run: adding the exact entry flips it.
    process.env[W7_ENV] = rowOnlyOrg.toLowerCase()
    try {
      const withEntry = await resolveArm(rowOnlyOrg)
      expect(withEntry.effectiveState).toBe('group_authoritative')
      expect(withEntry.selectsGroupArm).toBe(true)
    } finally {
      delete process.env[W7_ENV]
    }
  })

  it('T-M3b (the discriminator): persisted group_shadow + exact allowlist => EXACTLY group_shadow, still the legacy arm', async () => {
    // Without this leg, "off" and "not yet cut over" are indistinguishable and
    // a resolver that collapsed every non-authoritative state to `off` would
    // pass T-M2 and T-M3.
    await setPosture(shadowOrg, 'group_shadow')
    process.env[W7_ENV] = shadowOrg.toLowerCase()
    try {
      const port = await resolveArm(shadowOrg)
      expect(port.effectiveState).toBe('group_shadow')
      expect(port.selectsGroupArm).toBe(false)
    } finally {
      delete process.env[W7_ENV]
    }
  })

  it('OD-W7-4(a): a SUSPENDED org is BLOCKED — no calculation produced, NOT a legacy fallback', async () => {
    // Routing a suspended org to the LEGACY producer would be a legacy fallback
    // by another name, and OD-W7-4(a) is ratified against exactly that: no
    // legacy fallback from the group posture — suspend/resume only, one producer
    // per work date. The W4 precedent it names is explicit
    // (`POSTURE_TABLE.suspended.writePosture = 'blocked'`): suspension STOPS the
    // writer rather than redirecting it.
    //
    // [OWNER-CONFIRM] counter-reading recorded in the seam header: 「suspended
    // 读态合法且无消费者，legacy 臂即『无变化』」. The ratified default is BLOCKED.
    const suspendedOrg = randomUUID()
    const suspendedUser = randomUUID()
    const suspendedShift = randomUUID()
    await insertShift(suspendedOrg, suspendedShift, 'w7-1b suspended', [{ start: '09:00', end: '18:00' }])
    await insertActiveUser(suspendedUser, suspendedOrg)
    await setPosture(suspendedOrg, 'suspended')
    const priorW7Env = process.env[W7_ENV]
    process.env[W7_ENV] = suspendedOrg.toLowerCase()
    try {
      // The posture really is `suspended` — not `off` — so this is not the
      // inert path wearing a different name.
      const arm = await resolveArm(suspendedOrg)
      expect(arm.effectiveState).toBe('suspended')
      expect(arm.selectsGroupArm).toBe(false)

      const result = await issue(suspendedOrg, suspendedUser, suspendedShift)
      // POSITIVE equalities on all three. `arm: 'blocked'` is a DISTINCT arm, not
      // a null context — precisely so a caller cannot unwrap it into a durable
      // `review('missing_frozen_context')` row, which would BE a produced
      // calculation.
      expect(result.arm).toBe('blocked')
      expect(result.context).toBeNull()
      expect(result.reason).toBe('suspended')

      // NEVER-EVADABLE: removing the allowlist entry does NOT downgrade a
      // persisted `suspended` row to `off`. That is 1a's ratified priority and
      // the same doctrine W4 applies to its own suspended posture, so it is
      // asserted here rather than assumed.
      delete process.env[W7_ENV]
      expect((await resolveArm(suspendedOrg)).effectiveState).toBe('suspended')
      expect((await issue(suspendedOrg, suspendedUser, suspendedShift)).arm).toBe('blocked')

      // ...and the LEGACY arm CAN build a perfectly good context from this
      // fixture's data — proven by removing the POSTURE ROW, which is the only
      // thing that makes the org `off`. That is what makes `blocked` a
      // deliberate refusal rather than an absence of data.
      await pool.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = $1`, [suspendedOrg.toLowerCase()])
      const asLegacy = await issue(suspendedOrg, suspendedUser, suspendedShift)
      expect(asLegacy.arm).toBe('legacy')
      expect(asLegacy.context).not.toBeNull()
    } finally {
      if (priorW7Env === undefined) delete process.env[W7_ENV]
      else process.env[W7_ENV] = priorW7Env
      for (const table of ['attendance_shift_segments', 'attendance_shifts', 'user_orgs']) {
        await pool.query(`DELETE FROM ${table} WHERE org_id = $1`, [suspendedOrg]).catch(() => undefined)
      }
      await pool.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = $1`, [suspendedOrg.toLowerCase()]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [suspendedUser]).catch(() => undefined)
    }
  })

  // -------------------------------------------------------------------------
  // T-R2 — O-9's fail-closed shape, asserted as a POSITIVE equality.
  // -------------------------------------------------------------------------

  it('T-R2: facts-resolver {ok:false} NEVER falls back to legacy — it reviews out with its own reason', async () => {
    await setPosture(gapOrg, 'group_authoritative')
    process.env[W7_ENV] = gapOrg.toLowerCase()
    try {
      const result = await issue(gapOrg, gapUser, gapShift)
      // POSITIVE equalities on all three, never "did not produce a legacy
      // context": a `notEqual` cannot distinguish "failed closed correctly"
      // from "failed for another reason".
      expect(result.arm).toBe('group')
      expect(result.context).toBeNull()
      expect(result.reason).toBe('membership-absent')
      // And the fail-close is NOT a legacy fallback: a legacy context for this
      // org would be a perfectly valid V1 object, which is exactly the silent
      // degrade rulings 5/6/11 chose against.
      const legacyShape = await (async () => {
        delete process.env[W7_ENV]
        return issue(gapOrg, gapUser, gapShift)
      })()
      expect(legacyShape.arm).toBe('legacy')
      expect(legacyShape.context, 'the legacy arm CAN build a context here — which is ' +
        'what makes the group arm’s null a deliberate fail-close rather than an ' +
        'absence of data').not.toBeNull()
    } finally {
      delete process.env[W7_ENV]
    }
  })

  // -------------------------------------------------------------------------
  // Non-vacuity on the suite itself.
  // -------------------------------------------------------------------------

  it('non-vacuity: the seam is the PRODUCTION one and the vectors really were read', () => {
    expect(typeof seam).toBe('function')
    expect(Object.keys(vectors.entries).length).toBeGreaterThanOrEqual(8)
    expect(vectors.entries.workday.context).toContain('"selector":"legacy"')
  })

  async function resolveArm(orgId: string): Promise<{ effectiveState: string; selectsGroupArm: boolean }> {
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW7ArmSelectionForTests?: {
        resolveAttendanceW7GroupArmSelectionV1:
          | ((trx: unknown, orgId: string) => Promise<{ effectiveState: string; selectsGroupArm: boolean }>)
          | null
      }
    }
    const ref = plugin.__attendanceW7ArmSelectionForTests
    expect(ref, 'the plugin must export the W7 arm-selection reference').toBeTruthy()
    expect(typeof ref?.resolveAttendanceW7GroupArmSelectionV1).toBe('function')
    return ref!.resolveAttendanceW7GroupArmSelectionV1!(
      { query: async (sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows }) },
      orgId,
    )
  }
})
