/**
 * W7-4 (#4556) — READ-SIDE TRACE LABELING: the design-lock §4.4 slice that makes
 * group-derived evidence distinguishable from legacy-derived evidence on the
 * existing closed W4 enums, by emitting the W7-owned provenance values.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (blob `f7acf1da3be791bb2d77dbe58ca1078055828521`). Draft/HOLD slice — every
 * Ready/merge/flag/env/enablement step is separately owner-gated.
 *
 * `[OWNER-CONFIRM]` forks:
 *   D-1  slot numbering (whether this slice is "W7-4" or "W7-5") — OPEN; no
 *        deliverable here changes under either ruling.
 *   D-2  O-8's scoping half — RULED, no longer open: the W7 ratification
 *        addendum (#4556 comment 5302425091, owner first-person confirmation
 *        5302459230, 2026-08-15T13:32:20Z, prospective from confirmation)
 *        rules "O-8 = 归 W7-4" — emission belongs to this read-side slice, and
 *        the emission conditions on the CONTEXT'S selector, never the org
 *        posture (the ruling names that condition verbatim; the implementation
 *        below matches it word for word). The O-8 *technical* half (field
 *        threading, not a new surface: no new SQL, no DML, no lock) was an
 *        orchestration adjudication of scope and is now subsumed by the ruling.
 *   D-3  `posture: 'undeterminable'` being unreachable for `w4_group` — OPEN;
 *        asserted below as an invariant consequence, not as a ruling.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE-SHAPE RULE (the slice's specific trap, brief §5.0)
 * ---------------------------------------------------------------------------
 * Every leg claiming something about a group-derived trace runs against a REAL
 * persisted calculation whose `context_snapshot` is a `selector:
 * 'group_effective'` V2 produced by the 1b issuance seam through a REAL punch,
 * read back through the REAL loaders and routes. No hand-built evidence object
 * anywhere: a synthetic `AttendanceW4TraceEvidence` would bypass
 * `parseTraceProjection`'s shape gate — the exact gate that was this slice's
 * landing-order blocker — and would green-assert the opposite of the truth.
 *
 * ---------------------------------------------------------------------------
 * THE T-K1 BASE-CAPTURE MECHANIC (same discipline as the W7-R3 legacy-arm
 * golden, `attendance-w7-1b-legacy-arm-golden.db.test.ts`)
 * ---------------------------------------------------------------------------
 * The legacy-org golden vectors in
 * `fixtures/w7-4-legacy-trace-golden-vectors.json` were captured by running
 * THIS FILE, byte-identical, at the W7-4 base commit recorded inside the file
 * (the frozen 1b head), before any W7-4 behavioural change existed. A golden
 * generated from the post-change tree proves only that the code equals itself.
 * The vector file records this harness's own SHA-256; the digest leg re-hashes
 * this file at run time and compares.
 *
 * Normalization: run-varying VALUES (UUIDs, ISO instants, calendar dates) are
 * replaced by typed tags; keys are NEVER dropped or added, numbers and every
 * other string travel verbatim. The legacy fixture is built deterministic on
 * purpose (a 1439-minute grace on a 00:00–23:59 UTC shift makes every minute
 * field 0 and the status punch-time-independent), so the golden pins the full
 * label/shape surface: key sets, `kind`, `ref`, postures, confidence, statuses
 * and all numeric values.
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import Ajv from 'ajv'
import type { MetaSheetServer } from '../../src/index'
// T-K11: the assertions below compare the WIRE VALUES against the IMPORTED
// W7-0 constants, never against re-typed literals, so a spelling drift between
// the emitter and the ratified record cannot pass.
import {
  ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,
  ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,
} from '../../src/attendance/w7-read-side-provenance-amendment'
// W7-3 (#4918) landed a BEFORE-ROW transition guard + NOT NULL writer columns
// on the posture table; a bare (org_id, state, scope) seed is now rejected.
// This shared helper is THE one legal fixture path: bootstrap at 'off', then
// walk the ratified legal ladder to the target state, asserting it landed.
import { seedAttendanceW7ContextSourcePostureV1 } from '../utils/w7-context-source-posture-fixture'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTOR_PATH = path.join(HERE, 'fixtures', 'w7-4-legacy-trace-golden-vectors.json')

/** Set to (re)capture the T-K1 vectors — ONLY at the recorded base commit, on a
 *  tree with no W7-4 behavioural change. `W7_4_GOLDEN_BASE_SHA` names it. */
const EMIT = String(process.env.W7_4_EMIT_GOLDEN || '').trim() === '1'

const requireCjs = createRequire(import.meta.url)
/* eslint-disable @typescript-eslint/no-var-requires */
const { buildAttendanceGroupFixedScheduleProducerKey } = requireCjs(
  '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
)

const TRACE_CATEGORIES = ['today_status', 'late_early', 'missing_punch'] as const

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
        res.on('data', (c) => {
          data += c
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

// ---------------------------------------------------------------------------
// Golden normalization: values only, keys never. Deterministic key order.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function normalizeVolatileValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeVolatileValues)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = normalizeVolatileValues((value as Record<string, unknown>)[key])
    }
    return out
  }
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return '<uuid>'
    if (INSTANT_RE.test(value)) return '<instant>'
    if (DATE_RE.test(value)) return '<date>'
  }
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The nested key structure of a JSON value — the T-K2 exactness instrument.
 *  Arrays contribute the union of their members' key trees. */
function keyTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    const merged: Record<string, unknown> = {}
    for (const member of value) {
      const tree = keyTree(member)
      if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
        for (const [k, v] of Object.entries(tree as Record<string, unknown>)) merged[k] = v
      }
    }
    return [merged]
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = keyTree((value as Record<string, unknown>)[key])
    }
    return out
  }
  return null
}

/** OpenAPI 3.0 `nullable: true` → JSON Schema `anyOf [null, schema]`, so ajv
 *  can enforce the REST of the schema (including `additionalProperties: false`)
 *  faithfully. Structural, applied to every subschema; nothing else moves. */
function convertNullable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(convertNullable)
  if (!schema || typeof schema !== 'object') return schema
  const src = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'nullable') continue
    out[k] = convertNullable(v)
  }
  if (src.nullable === true) {
    return { anyOf: [{ type: 'null' }, out] }
  }
  return out
}

describeDb('W7-4 — read-side trace labeling (real host, real DB, real routes)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let priorW4: string | undefined
  let priorW7: string | undefined
  let harnessDigest = ''

  // GROUP org: both machines ON, punch freezes a group_effective V2 context and
  // a `w4_group`-owned authoritative calculation (T-K3/T-K4B/T-K6/T-K12..15/T-K19/T-K20).
  const groupOrg = randomUUID()
  const groupUser = randomUUID()
  const groupShift = randomUUID()
  const groupGroup = randomUUID()
  // LEGACY org: W4-authoritative, plain assignment, NO posture row. Deterministic
  // shape (grace 1439) — the T-K1 golden / T-K2 exactness / T-K5 parity subject.
  const legacyOrg = randomUUID()
  const legacyUser = randomUUID()
  const legacyShift = randomUUID()
  // PRE-GROUP org (T-K4 half A): record frozen under the LEGACY producer, org
  // postured group AFTERWARDS — the label must stay 'snapshot'.
  const preGroupOrg = randomUUID()
  const preGroupUser = randomUUID()
  const preGroupShift = randomUUID()
  // SHADOW org (T-K7): W4 rollout at `shadow`, W7 posture `group_authoritative`
  // — the punch persists a mode='shadow' calculation whose context the SEAM
  // issued (group arm), so the shadow evidence is genuinely group-derived.
  const shadowOrg = randomUUID()
  const shadowUser = randomUUID()
  const shadowShift = randomUUID()
  const shadowGroup = randomUUID()
  // LEGACY-SHADOW org (T-K7b, the SHADOW arm's legacy-selector negative case):
  // a legacy org (NO W7 posture row, NOT W7-allowlisted) at W4 rollout
  // `shadow` — its completed shadow calculation carries a legacy-built v1
  // context (`selector: 'legacy'`). This is a reachable production posture
  // inside W7-R3's protected population; without this fixture the shadow
  // emission's legacy branch has zero coverage (a widening of the shadow
  // ternary to also emit the group kind for `'legacy'` would leave every other
  // leg green — gate probe G3).
  const legacyShadowOrg = randomUUID()
  const legacyShadowUser = randomUUID()
  const legacyShadowShift = randomUUID()
  // REVIEW org (T-K10): shadow rollout + group posture, punched into a
  // NON-COMPLETED latest shadow calculation → `contextSelector` null → 'snapshot'.
  const reviewOrg = randomUUID()
  const reviewUser = randomUUID()
  const reviewShift = randomUUID()
  const reviewGroup = randomUUID()
  // CORRUPT org (T-K9): the persisted-evidence chain is IMMUTABLE
  // (`attendance_w4_deny_mutation`), so "corrupted storage" is represented the
  // way the OD-W7-10 suite seeds history: a REAL seam-produced group shadow
  // calculation first, then a directly-INSERTED higher-version shadow row whose
  // context is that REAL context minus `selector`. The shadow trace loader
  // reads `version DESC`, so the corrupt row is what the surface meets — and it
  // must fail CLOSED (unavailable basis), never default the selector to
  // 'legacy', never label group.
  const corruptOrg = randomUUID()
  const corruptUser = randomUUID()
  const corruptShift = randomUUID()
  const corruptGroup = randomUUID()

  const workDates: Record<string, string> = {}

  const allOrgs = () => [groupOrg, legacyOrg, preGroupOrg, shadowOrg, legacyShadowOrg, reviewOrg, corruptOrg]
  const w4Allowlist = () => allOrgs().map((o) => o.toLowerCase()).join(',')
  const w7Allowlist = () =>
    [groupOrg, shadowOrg, reviewOrg, corruptOrg].map((o) => o.toLowerCase()).join(',')

  const mintToken = async (userId: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W7-4 fixture user', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w7-4-labeling.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  /** Walks the W4 rollout machine's LEGAL edges (direct authoritative insert is
   *  trigger-denied). */
  async function seedRollout(orgId: string, target: 'shadow' | 'authoritative'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w7-4-labeling', 'TEST_FIXTURE', 'w7-4-actor', 1, NULL)`,
      [orgId],
    )
    const walk: ReadonlyArray<readonly [string, string, number]> =
      target === 'shadow'
        ? [['shadow', 'legacy', 2]]
        : [
            ['shadow', 'legacy', 2],
            ['eligible', 'shadow', 3],
            ['authoritative', 'eligible', 4],
          ]
    for (const [state, prior, version] of walk) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [orgId, state, prior, version],
      )
    }
  }

  async function insertShift(orgId: string, shiftId: string, grace: number): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, $3, 'UTC', '00:00', '23:59', false, '[0,1,2,3,4,5,6]'::jsonb, $4, $4, 15, 'strict')`,
      [shiftId, orgId, `w7-4-labeling ${shiftId}`, grace],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
  }

  /** The full group fixture the 1b cutover e2e proved out: shift + segment +
   *  group + fixed-schedule config + producer-keyed assignment + W1 membership
   *  + a posture row. */
  async function seedEffectiveGroup(
    orgId: string,
    userId: string,
    shiftId: string,
    groupId: string,
    postureState: string,
  ): Promise<void> {
    await insertShift(orgId, shiftId, 5)
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
       VALUES ($1, $2, $3, 'fixed_shift', 'UTC')`,
      [groupId, orgId, `w7-4-labeling group ${groupId}`],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', 1, 'w7-4-labeling')`,
      [orgId, groupId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
      [orgId, groupId, userId],
    )
    const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
      groupId,
      shiftId,
      startDate: '2026-01-01',
      endDate: '2027-12-31',
    })
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active,
          producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true,
               'attendance_group_fixed_schedule', $4, $5, $6, 'published')`,
      [orgId, userId, shiftId, groupId, producerKey, randomUUID()],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships
         (org_id, user_id, group_id, effective_from, effective_to,
          assigned_by, assigned_reason, assigned_correlation_id)
       VALUES ($1, $2, $3, '2026-01-01', NULL, 'w7-4-labeling', 'seed', $4)`,
      [orgId, userId, groupId, `w7-4-labeling-${groupId}`],
    )
    // W7-3 transition-writer schema: seeded via the shared legal-ladder helper
    // (bootstrap at 'off', walk to the target), never a bare INSERT.
    await seedAttendanceW7ContextSourcePostureV1(pool, orgId, postureState)
  }

  async function seedPlainAssignment(
    orgId: string,
    userId: string,
    shiftId: string,
    grace: number,
  ): Promise<void> {
    await insertShift(orgId, shiftId, grace)
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
    // Deterministic-fixture rule: with a 1439-minute grace, the CODE-default
    // severe/absence thresholds (30/60) would violate the frozen-context
    // nesting rule (`severe > 0 && severe < maxLateGrace` fails closed as
    // `input_schema_invalid`). An org-scoped default rule with both tiers
    // DISABLED (0) keeps the frozen context valid and the fixture
    // punch-time-independent.
    await pool.query(
      `INSERT INTO attendance_rules
         (name, timezone, work_start_time, work_end_time, late_grace_minutes, early_grace_minutes,
          rounding_minutes, working_days, is_default, org_id,
          severe_late_threshold_minutes, absence_late_threshold_minutes)
       VALUES ('w7-4 deterministic', 'UTC', '00:00', '23:59', $2, $2, 15, '[0,1,2,3,4,5,6]'::jsonb, true, $1, 0, 0)`,
      [orgId, grace],
    )
  }

  function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
    const prior = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(vars)) {
      prior.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const restore = () => {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    return body().then(
      (result) => {
        restore()
        return result
      },
      (error) => {
        restore()
        throw error
      },
    )
  }

  const BOTH_ENV = () => ({ [W4_ENV]: w4Allowlist(), [W7_ENV]: w7Allowlist() })

  const punch = async (userId: string, orgId: string, eventType: 'check_in' | 'check_out') =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orgId, eventType, timezone: 'UTC', operationId: randomUUID() }),
    })

  const punchAt = async (
    userId: string,
    orgId: string,
    eventType: 'check_in' | 'check_out',
    occurredAt: Date,
  ) =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        eventType,
        timezone: 'UTC',
        operationId: randomUUID(),
        occurredAt: occurredAt.toISOString(),
      }),
    })

  const workDateOf = async (userId: string): Promise<string> =>
    (
      await pool.query(
        `SELECT to_char(work_date, 'YYYY-MM-DD') AS wd FROM attendance_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
    ).rows[0].wd

  const adminTrace = async (orgId: string, userId: string, category: string, workDate: string) =>
    requestJson(
      `${baseUrl}/api/attendance-admin/decision-trace?orgId=${orgId}&userId=${userId}&category=${category}&workDate=${workDate}`,
      { headers: { Authorization: `Bearer ${await mintToken(userId)}` } },
    )

  const selfTrace = async (orgId: string, userId: string, category: string, workDate: string) =>
    requestJson(
      `${baseUrl}/api/attendance/decision-trace?orgId=${orgId}&category=${category}&workDate=${workDate}`,
      { headers: { Authorization: `Bearer ${await mintToken(userId)}` } },
    )

  const latestCalc = async (userId: string) =>
    (
      await pool.query(
        `SELECT c.id::text AS id, c.mode, c.outcome, c.outcome_reason_code,
                c.snapshot_schema_version, c.context_snapshot
           FROM attendance_record_calculations c
           JOIN attendance_records r ON r.id = c.attendance_record_id
          WHERE r.user_id = $1
          ORDER BY c.version DESC
          LIMIT 1`,
        [userId],
      )
    ).rows[0]

  const recordOf = async (userId: string) =>
    (
      await pool.query(
        `SELECT id::text AS id, projection_owner, current_calculation_id::text AS current_calculation_id
           FROM attendance_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
    ).rows[0]

  /** The basis env whose `ref` names the calculation table, from a trace body. */
  const calcBasisEnv = (body: any, refSuffix: 'authoritative' | 'shadow') => {
    const basis: Array<{ source: { kind: string; ref: string } }> = body?.data?.basis ?? []
    return basis.find((env) => env.source.ref === `attendance_record_calculations:${refSuffix}`)
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W7-4 labeling suite needs a loopback port + DATABASE_URL')

    harnessDigest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex')

    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // Boot-time registration needs the allowlists BEFORE server.start() (some
    // attendance machinery is env-gated at registration); per-leg `withEnv`
    // still installs them hermetically for every env-dependent leg.
    process.env[W4_ENV] = w4Allowlist()
    process.env[W7_ENV] = w7Allowlist()

    const repoRoot = path.join(HERE, '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    // ---- GROUP org ---------------------------------------------------------
    await insertActiveUser(groupUser, groupOrg)
    await seedRollout(groupOrg, 'authoritative')
    await seedEffectiveGroup(groupOrg, groupUser, groupShift, groupGroup, 'group_authoritative')

    // ---- LEGACY org (deterministic golden fixture) -------------------------
    await insertActiveUser(legacyUser, legacyOrg)
    await seedRollout(legacyOrg, 'authoritative')
    await seedPlainAssignment(legacyOrg, legacyUser, legacyShift, 1439)

    // ---- PRE-GROUP org (frozen legacy FIRST; postured group AFTER) ---------
    await insertActiveUser(preGroupUser, preGroupOrg)
    await seedRollout(preGroupOrg, 'authoritative')
    await seedPlainAssignment(preGroupOrg, preGroupUser, preGroupShift, 1439)

    // ---- SHADOW org --------------------------------------------------------
    await insertActiveUser(shadowUser, shadowOrg)
    await seedRollout(shadowOrg, 'shadow')
    await seedEffectiveGroup(shadowOrg, shadowUser, shadowShift, shadowGroup, 'group_authoritative')

    // ---- LEGACY-SHADOW org (T-K7b) -----------------------------------------
    await insertActiveUser(legacyShadowUser, legacyShadowOrg)
    await seedRollout(legacyShadowOrg, 'shadow')
    await seedPlainAssignment(legacyShadowOrg, legacyShadowUser, legacyShadowShift, 1439)

    // ---- REVIEW org --------------------------------------------------------
    await insertActiveUser(reviewUser, reviewOrg)
    await seedRollout(reviewOrg, 'shadow')
    await seedEffectiveGroup(reviewOrg, reviewUser, reviewShift, reviewGroup, 'group_authoritative')

    // ---- CORRUPT org -------------------------------------------------------
    await insertActiveUser(corruptUser, corruptOrg)
    await seedRollout(corruptOrg, 'shadow')
    await seedEffectiveGroup(corruptOrg, corruptUser, corruptShift, corruptGroup, 'group_authoritative')

    // ---- Punches (the REAL producers; every context below is seam-issued or
    // legacy-built by the production tree, never hand-persisted) -------------
    await withEnv(BOTH_ENV(), async () => {
      for (const [user, org] of [
        [groupUser, groupOrg],
        [legacyUser, legacyOrg],
        [preGroupUser, preGroupOrg],
        [shadowUser, shadowOrg],
        [legacyShadowUser, legacyShadowOrg],
        [corruptUser, corruptOrg],
      ] as const) {
        const res = await punch(user, org, 'check_in')
        if (res.status !== 200) throw new Error(`fixture punch failed for ${org}: ${res.raw}`)
      }
      // REVIEW org: first a completed group shadow calc, then a DUPLICATE
      // check_in, which the W4 engine records as a review_required shadow
      // calculation (`duplicate_check_in`) — the real non-completed path.
      // Both punches are REAL route punches; the first carries an explicit
      // same-UTC-day `occurredAt` ~9 minutes earlier so the legacy
      // `PUNCH_TOO_SOON` interval guard (min 1 minute) admits the second.
      // The midnight-adjacent clamps keep both instants on the same UTC work
      // date and ≥90s apart under every clock position (the future-punch guard
      // allows up to +5 minutes, which the clamp stays far inside).
      const nowMs = Date.now()
      const t1 = new Date(nowMs - 9 * 60 * 1000)
      let t2 = new Date(nowMs)
      if (t1.getUTCDate() !== t2.getUTCDate()) {
        t1.setTime(Date.UTC(t2.getUTCFullYear(), t2.getUTCMonth(), t2.getUTCDate(), 0, 0, 30))
      }
      if (t2.getTime() - t1.getTime() < 90_000) t2 = new Date(t1.getTime() + 90_000)
      const first = await punchAt(reviewUser, reviewOrg, 'check_in', t1)
      if (first.status !== 200) throw new Error(`review first punch failed: ${first.raw}`)
      const second = await punchAt(reviewUser, reviewOrg, 'check_in', t2)
      if (second.status !== 200) throw new Error(`review duplicate punch failed: ${second.raw}`)
    })

    for (const [key, user] of [
      ['group', groupUser],
      ['legacy', legacyUser],
      ['preGroup', preGroupUser],
      ['shadow', shadowUser],
      ['legacyShadow', legacyShadowUser],
      ['review', reviewUser],
      ['corrupt', corruptUser],
    ] as const) {
      workDates[key] = await workDateOf(user)
    }

    // PRE-GROUP org becomes group-postured only AFTER its record was frozen
    // under the legacy producer (T-K4 half A's premise).
    await seedAttendanceW7ContextSourcePostureV1(pool, preGroupOrg, 'group_authoritative')

    // CORRUPT org: seed the corrupt shadow row ABOVE the real one. The context
    // is the REAL seam-issued group context minus `selector`; the row satisfies
    // every calculation-table CHECK and the deferred segment-count trigger so
    // the read path reaches exactly the context shape gate and nothing earlier.
    const realCorruptCalc = await latestCalc(corruptUser)
    if ((realCorruptCalc.context_snapshot as Record<string, unknown>).selector !== 'group_effective') {
      throw new Error('corrupt-org premise: the seam must have produced a group context first')
    }
    const corruptContext = { ...(realCorruptCalc.context_snapshot as Record<string, unknown>) }
    delete corruptContext.selector
    const corruptRecord = await recordOf(corruptUser)
    const corruptCalcId = randomUUID()
    const seedClient = await pool.connect()
    try {
      await seedClient.query('BEGIN')
      await seedClient.query(
        `INSERT INTO attendance_record_calculations
           (id, attendance_record_id, org_id, version,
            calculation_kind, mode, entrypoint, engine_version, snapshot_schema_version,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, segment_snapshot, evidence_snapshot, approved_facts_snapshot,
            input_provenance, merge_policy, calculation_tier,
            outcome, outcome_reason_code, projection_effect, expected_segment_count,
            actor_id, correlation_id, operation_id,
            projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            context_snapshot, created_at)
         VALUES ($1,$2,$3,(SELECT max(version) + 1 FROM attendance_record_calculations WHERE attendance_record_id = $2::uuid),
                 'calculation','shadow','live','w7-4-corrupt',1,
                 $5,$6,$7,
                 $8::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 '{}'::jsonb,'append','legacy_shadow',
                 'completed','shadow_only','none',1,
                 'w7-4-corrupt-actor','w7-4-corrupt',$9::uuid,
                 'normal',0,0,0,
                 $4::jsonb, now())`,
        [
          corruptCalcId,
          corruptRecord.id,
          corruptOrg,
          JSON.stringify(corruptContext),
          crypto.createHash('sha256').update('w7-4-corrupt-semantic').digest('hex'),
          crypto.createHash('sha256').update('w7-4-corrupt-provenance').digest('hex'),
          crypto.createHash('sha256').update('w7-4-corrupt-sourcedef').digest('hex'),
          JSON.stringify({
            posture: 'resolved_v2',
            value: { orgId: corruptOrg, userId: corruptUser, workDate: await workDateOf(corruptUser), shiftId: corruptShift },
          }),
          randomUUID(),
        ],
      )
      await seedClient.query(
        `INSERT INTO attendance_record_segments
           (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
            work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
            matched_evidence_refs, unmatched_evidence_refs)
         VALUES ($1,$2::uuid,$3::uuid,0,$4::timestamptz,$5::timestamptz,0,0,0,'normal','["within_window"]'::jsonb,'[]'::jsonb,'[]'::jsonb)`,
        [
          corruptOrg,
          corruptRecord.id,
          corruptCalcId,
          `${await workDateOf(corruptUser)}T00:00:00Z`,
          `${await workDateOf(corruptUser)}T23:59:00Z`,
        ],
      )
      await seedClient.query('COMMIT')
    } catch (error) {
      await seedClient.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      seedClient.release()
    }
  }, 240_000)

  afterAll(async () => {
    const orgs = allOrgs()
    for (const table of [
      'attendance_record_segments',
      'attendance_record_calculations',
      'attendance_records',
      'attendance_events',
      'attendance_calculation_group_memberships',
      'attendance_shift_assignments',
      'attendance_group_fixed_schedule_configs',
      'attendance_group_members',
      'attendance_groups',
      'attendance_shift_segments',
      'attendance_shifts',
      'attendance_rules',
      'attendance_calculation_rollout_state',
      'user_orgs',
    ]) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    }
    await pool
      ?.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [
        [...orgs, preGroupOrg].map((o) => o.toLowerCase()),
      ])
      .catch(() => undefined)
    await pool
      ?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
        [groupUser, legacyUser, preGroupUser, shadowUser, legacyShadowUser, reviewUser, corruptUser],
      ])
      .catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

  // -------------------------------------------------------------------------
  // Premises first (T-K19 non-vacuity + T-K20): the fixtures really are what
  // the legs claim they are, asserted from the DB before any label assertion.
  // -------------------------------------------------------------------------

  it('T-K19/T-K20 premises: the group calculation is REAL — seam-issued V2 context on a schema-version-1 calculation row', async () => {
    const calc = await latestCalc(groupUser)
    expect(calc.mode).toBe('authoritative')
    expect(calc.outcome).toBe('completed')
    expect(calc.outcome_reason_code).toBe('calculated')
    const ctx = calc.context_snapshot as Record<string, unknown>
    // T-K19: the selector asserted BEFORE any label assertion relies on it.
    expect(ctx.selector).toBe('group_effective')
    expect(ctx.schemaVersion).toBe(2)
    expect(ctx.calculationGroupId).toBe(groupGroup)
    // T-K20: the CALCULATION-ROW schema version and the frozen-context
    // schemaVersion are DISTINCT domains — the row stays 1 while the context
    // says 2, which is exactly why the `!== 1` hard gates at the read surfaces
    // pass for group rows and this slice inherits no gate-widening obligation.
    expect(Number(calc.snapshot_schema_version)).toBe(1)
    const record = await recordOf(groupUser)
    expect(record.projection_owner).toBe(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1)
    expect(typeof record.current_calculation_id).toBe('string')

    const legacyCalc = await latestCalc(legacyUser)
    expect(legacyCalc.mode).toBe('authoritative')
    expect(legacyCalc.outcome).toBe('completed')
    expect((legacyCalc.context_snapshot as Record<string, unknown>).selector).toBe('legacy')
    const preGroupCalc = await latestCalc(preGroupUser)
    expect((preGroupCalc.context_snapshot as Record<string, unknown>).selector).toBe('legacy')
  })

  // -------------------------------------------------------------------------
  // T-K6 + T-K11: authoritative group evidence labels, on BOTH routes, with
  // ref UNCHANGED — both conjuncts asserted, values compared to the IMPORTED
  // constant.
  // -------------------------------------------------------------------------

  it('T-K6: authoritative group evidence => kind is the imported group value AND ref stays attendance_record_calculations:authoritative (admin + self routes, all three categories)', async () => {
    for (const category of TRACE_CATEGORIES) {
      const admin = await adminTrace(groupOrg, groupUser, category, workDates.group)
      expect(admin.status, `admin ${category}: ${admin.raw}`).toBe(200)
      const env = calcBasisEnv(admin.body, 'authoritative')
      expect(env, `admin ${category}: no authoritative basis env`).toBeDefined()
      expect(env!.source.kind).toBe(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
      expect(env!.source.ref).toBe('attendance_record_calculations:authoritative')
      expect((env as any).version.posture).toBe('snapshot_frozen')
      expect(admin.body.data.confidence).toBe('grounded')

      const self = await selfTrace(groupOrg, groupUser, category, workDates.group)
      expect(self.status, `self ${category}: ${self.raw}`).toBe(200)
      const selfEnv = calcBasisEnv(self.body, 'authoritative')
      expect(selfEnv, `self ${category}: no authoritative basis env`).toBeDefined()
      expect(selfEnv!.source.kind).toBe(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
      expect(selfEnv!.source.ref).toBe('attendance_record_calculations:authoritative')
    }
  })

  // -------------------------------------------------------------------------
  // T-K1 golden (with T-K3 as its in-run positive control, so "bytes unchanged"
  // can never be satisfied by "nothing ran").
  // -------------------------------------------------------------------------

  // DIGEST HISTORY (the honest record, because the digest below has ONCE been
  // re-pinned without a re-capture): the `entries` were captured at
  // `capturedAtBaseSha` (the frozen pre-W7-4 1b head, which PREDATES the W7-3
  // posture-fixture helper — a literal re-capture there cannot even import it).
  // When the W7-3 rebase forced this file's posture seeds onto the shared
  // helper (landing-gate P1-1), the fixture-only edit provably did not move
  // the trace bytes (the T-K1 leg below passed against the UNCHANGED entries
  // before the digest was touched), so the sanctioned fix was a DIGEST-ONLY
  // re-pin under a programmatic assertion that `entries` and
  // `capturedAtBaseSha` stayed byte-identical. That is the ONLY legal repin
  // shape: if any `entries` value moves, the edit was behavioural and the
  // whole capture-vs-verify argument must be rebuilt at a helper-bearing base.
  it('harness digest: the committed T-K1 vectors were produced by THIS EXACT FILE', () => {
    if (EMIT) return
    const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'))
    expect(
      vectors.harnessSha256,
      'Vectors were pinned against a DIFFERENT version of this harness. Either ' +
        're-capture at a helper-bearing base with W7_4_EMIT_GOLDEN=1, or — ONLY ' +
        'if the harness edit provably does not move the entries (T-K1 must pass ' +
        'against the unchanged entries first) — re-pin the digest alone, ' +
        'asserting entries and capturedAtBaseSha are byte-identical.',
    ).toBe(harnessDigest)
    expect(vectors.capturedAtBaseSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('T-K1: the legacy-org trace responses are IDENTICAL (normalized canonical bytes) to the pre-W7-4 base capture, for all three categories', async () => {
    const captured: Record<string, string> = {}
    for (const category of TRACE_CATEGORIES) {
      const res = await adminTrace(legacyOrg, legacyUser, category, workDates.legacy)
      expect(res.status, `${category}: ${res.raw}`).toBe(200)
      // Non-vacuity inside the golden: the W4 authoritative arm REALLY ran —
      // a fixture drift that made the response `frozen_evidence_unavailable`
      // would otherwise still "match" a baseline captured with the same drift.
      const env = calcBasisEnv(res.body, 'authoritative')
      expect(env, `${category}: the legacy fixture must produce authoritative evidence`).toBeDefined()
      expect(env!.source.kind).toBe('snapshot')
      captured[category] = canonicalJson(normalizeVolatileValues(res.body))
    }
    if (EMIT) {
      fs.mkdirSync(path.dirname(VECTOR_PATH), { recursive: true })
      fs.writeFileSync(
        VECTOR_PATH,
        `${JSON.stringify(
          {
            _README:
              'CAPTURED AT THE PRE-W7-4 BASE (the frozen 1b head). Do not regenerate ' +
              'from a tree that already carries the W7-4 emitter — a golden generated ' +
              'from the post-change code proves only that the code equals itself.',
            capturedAtBaseSha: String(process.env.W7_4_GOLDEN_BASE_SHA || '').trim(),
            harnessSha256: harnessDigest,
            entries: captured,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      return
    }
    const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'))
    for (const category of TRACE_CATEGORIES) {
      expect(captured[category], `${category}: legacy trace bytes moved vs the base capture`).toBe(
        vectors.entries[category],
      )
    }
    expect(Object.keys(vectors.entries).sort()).toEqual([...TRACE_CATEGORIES].sort())
  })

  it('T-K3 (positive control for T-K1/T-K2): a group-derived record in the SAME run moves the label to the group kind', async () => {
    const res = await adminTrace(groupOrg, groupUser, 'today_status', workDates.group)
    expect(res.status).toBe(200)
    const env = calcBasisEnv(res.body, 'authoritative')
    expect(env!.source.kind).toBe(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
  })

  // -------------------------------------------------------------------------
  // T-K2: exact key sets, every level — and the GROUP response carries the
  // IDENTICAL key tree (the threaded selector must never surface as a key).
  // -------------------------------------------------------------------------

  it('T-K2: the legacy trace response key tree is exact, on admin AND self routes — and the group response key tree is IDENTICAL to it', async () => {
    // The W4-authoritative today_status shape: a SINGLE basis env carrying
    // exactly {source:{kind,ref}, version:{asOf,posture,snapshotVersion}} —
    // no auditRef on this arm, and no selector key anywhere. Asserted in both
    // directions by deep equality: a key gained OR lost reds.
    const expectedTodayStatusTree = {
      data: {
        basis: [
          {
            source: { kind: null, ref: null },
            version: { asOf: null, posture: null, snapshotVersion: null },
          },
        ],
        category: null,
        conclusion: {
          earlyLeaveMinutes: null,
          isWorkday: null,
          lateMinutes: null,
          status: null,
          workDate: null,
          workMinutes: null,
        },
        confidence: null,
        reasonCode: null,
      },
      ok: null,
    }
    const adminLegacy = await adminTrace(legacyOrg, legacyUser, 'today_status', workDates.legacy)
    expect(adminLegacy.status).toBe(200)
    const selfLegacy = await selfTrace(legacyOrg, legacyUser, 'today_status', workDates.legacy)
    expect(selfLegacy.status).toBe(200)
    const adminGroup = await adminTrace(groupOrg, groupUser, 'today_status', workDates.group)
    expect(adminGroup.status).toBe(200)

    // NOTE on the basis array: keyTree unions array members, and the legacy
    // authoritative today_status basis is exactly ONE env (`[w4.basis]`), so
    // the union IS that env's exact key set.
    expect((adminLegacy.body.data.basis as unknown[]).length).toBe(1)
    expect(keyTree(adminLegacy.body)).toEqual(expectedTodayStatusTree)
    expect(keyTree(selfLegacy.body)).toEqual(expectedTodayStatusTree)
    // The group response: SAME key tree — labeling changes a VALUE, never a key.
    expect((adminGroup.body.data.basis as unknown[]).length).toBe(1)
    expect(keyTree(adminGroup.body)).toEqual(expectedTodayStatusTree)
    // And the basis env's source object is exactly {kind, ref} on both.
    expect(Object.keys((adminLegacy.body.data.basis as any[])[0].source).sort()).toEqual(['kind', 'ref'])
    expect(Object.keys((adminGroup.body.data.basis as any[])[0].source).sort()).toEqual(['kind', 'ref'])
  })

  // -------------------------------------------------------------------------
  // T-K5: byte parity across the three W7-R3 read-side posture states for a
  // LEGACY-frozen record — raw HTTP bytes, same run, so no normalization at all.
  // -------------------------------------------------------------------------

  it('T-K5: for a legacy-frozen record the RAW trace bytes are identical under no-posture, group_shadow and group_eligible', async () => {
    const under = async (label: string): Promise<Record<string, string>> => {
      const out: Record<string, string> = {}
      for (const category of TRACE_CATEGORIES) {
        const res = await adminTrace(legacyOrg, legacyUser, category, workDates.legacy)
        expect(res.status, `${label}/${category}`).toBe(200)
        out[category] = res.raw
      }
      return out
    }
    const noPosture = await under('no-posture')
    // Under group_shadow / group_eligible the org is REALLY postured for the
    // read (row present AND allowlisted), yet a legacy-frozen record's bytes
    // must not move — the emitter reads the CONTEXT, not the posture.
    const withLegacyAllowlisted = {
      [W4_ENV]: w4Allowlist(),
      [W7_ENV]: `${w7Allowlist()},${legacyOrg.toLowerCase()}`,
    }
    await seedAttendanceW7ContextSourcePostureV1(pool, legacyOrg, 'group_shadow')
    try {
      const shadowPosture = await withEnv(withLegacyAllowlisted, () => under('group_shadow'))
      // Rebuild at 'group_eligible' via the helper (the sanctioned idiom for a
      // state flip: the ladder is deliberately not strongly connected, and the
      // state table carries no append-only trigger).
      await seedAttendanceW7ContextSourcePostureV1(pool, legacyOrg, 'group_eligible')
      const eligiblePosture = await withEnv(withLegacyAllowlisted, () => under('group_eligible'))
      for (const category of TRACE_CATEGORIES) {
        expect(shadowPosture[category], `group_shadow/${category} bytes moved`).toBe(noPosture[category])
        expect(eligiblePosture[category], `group_eligible/${category} bytes moved`).toBe(noPosture[category])
      }
    } finally {
      await pool.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = $1`, [legacyOrg.toLowerCase()])
    }
  })

  // -------------------------------------------------------------------------
  // T-K4: the emitter conditions on the CALCULATION'S context selector, never
  // the org's posture — both halves, each with its premise pinned first.
  // -------------------------------------------------------------------------

  it('T-K4a: a GROUP-POSTURED org whose record was frozen under the LEGACY producer still labels snapshot', async () => {
    // Premise: the org IS group-postured NOW (row + allowlist)...
    const posture = await pool.query(`SELECT state FROM ${POSTURE_TABLE} WHERE org_id = $1`, [
      preGroupOrg.toLowerCase(),
    ])
    expect(posture.rows[0]?.state).toBe('group_authoritative')
    // ...and the record was frozen legacy (asserted in the premise leg too).
    const calc = await latestCalc(preGroupUser)
    expect((calc.context_snapshot as Record<string, unknown>).selector).toBe('legacy')

    await withEnv(
      { [W4_ENV]: w4Allowlist(), [W7_ENV]: `${w7Allowlist()},${preGroupOrg.toLowerCase()}` },
      async () => {
        const res = await adminTrace(preGroupOrg, preGroupUser, 'today_status', workDates.preGroup)
        expect(res.status).toBe(200)
        const env = calcBasisEnv(res.body, 'authoritative')
        expect(env, 'authoritative basis env must exist').toBeDefined()
        expect(env!.source.kind).toBe('snapshot')
      },
    )
  })

  it('T-K4b: a NON-group-postured org whose record was frozen under the GROUP producer still labels group_policy_snapshot', async () => {
    // Flip the org's read-time posture OFF two ways at once: posture row state
    // 'off' (rebuilt via the shared legal-ladder helper) AND the org removed
    // from the W7 allowlist.
    await seedAttendanceW7ContextSourcePostureV1(pool, groupOrg, 'off')
    try {
      await withEnv(
        {
          [W4_ENV]: w4Allowlist(),
          [W7_ENV]: [shadowOrg, reviewOrg, corruptOrg].map((o) => o.toLowerCase()).join(','),
        },
        async () => {
          const posture = await pool.query(`SELECT state FROM ${POSTURE_TABLE} WHERE org_id = $1`, [
            groupOrg.toLowerCase(),
          ])
          expect(posture.rows[0]?.state).toBe('off')
          const allowlisted = String(process.env[W7_ENV] || '')
            .split(',')
            .map((v) => v.trim())
          expect(allowlisted.includes(groupOrg.toLowerCase())).toBe(false)

          const res = await adminTrace(groupOrg, groupUser, 'today_status', workDates.group)
          expect(res.status).toBe(200)
          const env = calcBasisEnv(res.body, 'authoritative')
          expect(env, 'authoritative basis env must exist').toBeDefined()
          expect(env!.source.kind).toBe(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
        },
      )
    } finally {
      await seedAttendanceW7ContextSourcePostureV1(pool, groupOrg, 'group_authoritative')
    }
  })

  // -------------------------------------------------------------------------
  // T-K7: SHADOW group evidence labels too — the seam issued the shadow row's
  // context, so labeling holds for the shadow loader with the same emitter.
  // -------------------------------------------------------------------------

  it('T-K7: shadow group evidence => the group kind with ref attendance_record_calculations:shadow', async () => {
    // Premise from the DB first: the latest calc really is a COMPLETED shadow
    // calculation carrying a seam-issued group context.
    const calc = await latestCalc(shadowUser)
    expect(calc.mode).toBe('shadow')
    expect(calc.outcome).toBe('completed')
    const ctx = calc.context_snapshot as Record<string, unknown>
    expect(ctx.selector).toBe('group_effective')
    expect(ctx.schemaVersion).toBe(2)
    expect(Number(calc.snapshot_schema_version)).toBe(1)

    const res = await adminTrace(shadowOrg, shadowUser, 'today_status', workDates.shadow)
    expect(res.status).toBe(200)
    const env = calcBasisEnv(res.body, 'shadow')
    expect(env, 'shadow basis env must exist').toBeDefined()
    expect(env!.source.kind).toBe(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
    expect(env!.source.ref).toBe('attendance_record_calculations:shadow')
    expect((env as any).version.posture).toBe('current_live_no_history')
  })

  it('T-K7b: LEGACY-selector completed shadow evidence stays snapshot — the shadow arm negative case', async () => {
    // Premise from the DB first: a COMPLETED shadow calculation whose context
    // is the legacy-built v1 (`selector: 'legacy'`), in an org with NO posture
    // row — the exact W7-R3-protected shape the shadow arm must never relabel.
    const calc = await latestCalc(legacyShadowUser)
    expect(calc.mode).toBe('shadow')
    expect(calc.outcome).toBe('completed')
    const ctx = calc.context_snapshot as Record<string, unknown>
    expect(ctx.selector).toBe('legacy')
    expect(ctx.schemaVersion).toBe(1)
    const posture = await pool.query(`SELECT state FROM ${POSTURE_TABLE} WHERE org_id = $1`, [
      legacyShadowOrg.toLowerCase(),
    ])
    expect(posture.rowCount).toBe(0)

    const res = await adminTrace(legacyShadowOrg, legacyShadowUser, 'today_status', workDates.legacyShadow)
    expect(res.status).toBe(200)
    const env = calcBasisEnv(res.body, 'shadow')
    expect(env, 'shadow basis env must exist').toBeDefined()
    // The POSITIVE non-group equality: a widening of the shadow ternary that
    // also emits the group kind for `'legacy'` (gate probe G3) reds exactly
    // this line while every other leg stays green.
    expect(env!.source.kind).toBe('snapshot')
    expect(env!.source.ref).toBe('attendance_record_calculations:shadow')
    expect((env as any).version.posture).toBe('current_live_no_history')
  })

  // -------------------------------------------------------------------------
  // T-K8 + T-K9: the unavailable/fail-closed emissions stay 'snapshot' even
  // for group-postured orgs — positive equalities on the exact env shape.
  // -------------------------------------------------------------------------

  it('T-K8: a group-postured org with NO evidence for the day gets exactly the frozen_evidence_unavailable env, kind snapshot', async () => {
    const res = await adminTrace(groupOrg, groupUser, 'today_status', '2020-01-01')
    expect(res.status).toBe(200)
    expect(res.body.data.basis).toEqual([
      {
        source: { kind: 'snapshot', ref: 'frozen_evidence_unavailable' },
        version: { posture: 'undeterminable' },
      },
    ])
    expect(res.body.data.confidence).toBe('undeterminable')
  })

  it('T-K9: a REAL group calculation whose persisted context LACKS selector fails CLOSED — unavailable basis, never a legacy default, never a group label', async () => {
    // Premise: the context really lacks the selector, and it really was a group
    // row before the corruption (calculationGroupId still present).
    const calc = await latestCalc(corruptUser)
    const ctx = calc.context_snapshot as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(ctx, 'selector')).toBe(false)
    expect(typeof ctx.calculationGroupId).toBe('string')

    const res = await adminTrace(corruptOrg, corruptUser, 'today_status', workDates.corrupt)
    expect(res.status).toBe(200)
    expect(res.body.data.basis).toEqual([
      {
        source: { kind: 'snapshot', ref: 'frozen_evidence_unavailable' },
        version: { posture: 'undeterminable' },
      },
    ])
    expect(res.body.data.confidence).toBe('undeterminable')
    expect(res.body.data.conclusion.status).toBe(null)
  })

  // -------------------------------------------------------------------------
  // T-K10: null contextSelector occurs on the non-completed path and labels
  // 'snapshot' — proven on a REAL review_required shadow row in a group org.
  // -------------------------------------------------------------------------

  it('T-K10: a NON-COMPLETED latest shadow calculation in a group-postured org labels snapshot (null selector path)', async () => {
    // Premise: the latest shadow calc is really non-completed, and an EARLIER
    // COMPLETED group calc exists on the same day — so 'snapshot' here is
    // discriminating (a posture-conditioned or a latest-group-anything
    // implementation would label group).
    const calc = await latestCalc(reviewUser)
    expect(calc.mode).toBe('shadow')
    expect(calc.outcome).toBe('review_required')
    const earlier = await pool.query(
      `SELECT c.outcome, c.context_snapshot
         FROM attendance_record_calculations c
         JOIN attendance_records r ON r.id = c.attendance_record_id
        WHERE r.user_id = $1
        ORDER BY c.version ASC
        LIMIT 1`,
      [reviewUser],
    )
    expect(earlier.rows[0].outcome).toBe('completed')
    expect((earlier.rows[0].context_snapshot as Record<string, unknown>).selector).toBe('group_effective')

    const res = await adminTrace(reviewOrg, reviewUser, 'today_status', workDates.review)
    expect(res.status).toBe(200)
    const env = calcBasisEnv(res.body, 'shadow')
    expect(env, 'shadow basis env must exist').toBeDefined()
    expect(env!.source.kind).toBe('snapshot')
  })

  // -------------------------------------------------------------------------
  // Domain A acceptance (T-K12..T-K15): the detail surface, through the real
  // routes, against the already-widened OpenAPI schema.
  // -------------------------------------------------------------------------

  it('T-K12: the ADMIN detail route returns projectionOwner w4_group for the group-owned parent, 200, posture authoritative', async () => {
    const record = await recordOf(groupUser)
    const res = await requestJson(
      `${baseUrl}/api/attendance-admin/records/${record.id}/calculation-detail?orgId=${groupOrg}`,
      { headers: { Authorization: `Bearer ${await mintToken(groupUser)}` } },
    )
    expect(res.status, res.raw).toBe(200)
    expect(res.body.data.current.projectionOwner).toBe(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1)
    // T-K15 (D-3, recorded OPEN): `w4_group` inherits the non-NULL pointer, and
    // posture derives from the pointed calculation's mode — asserted as the
    // POSITIVE value, so 'undeterminable' is excluded by equality, not negation.
    expect(res.body.data.current.posture).toBe('authoritative')
    expect(res.body.data.current.visibilityState).toBe('active')
    expect(res.body.data.calculation.outcome).toBe('completed')
  })

  it('T-K13: the SELF detail route returns the same value, and a userId param is rejected with the closed code', async () => {
    const record = await recordOf(groupUser)
    const token = await mintToken(groupUser)
    const ok = await requestJson(
      `${baseUrl}/api/attendance/records/${record.id}/calculation-detail?orgId=${groupOrg}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(ok.status, ok.raw).toBe(200)
    expect(ok.body.data.current.projectionOwner).toBe(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1)

    const rejected = await requestJson(
      `${baseUrl}/api/attendance/records/${record.id}/calculation-detail?orgId=${groupOrg}&userId=${groupUser}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.code).toBe('USER_ID_NOT_ACCEPTED')
  })

  it('T-K14: the 200 group detail body VALIDATES against the already-widened OpenAPI schema under additionalProperties:false — with a live negative control', async () => {
    const record = await recordOf(groupUser)
    const res = await requestJson(
      `${baseUrl}/api/attendance-admin/records/${record.id}/calculation-detail?orgId=${groupOrg}`,
      { headers: { Authorization: `Bearer ${await mintToken(groupUser)}` } },
    )
    expect(res.status).toBe(200)

    const openapiPath = path.join(HERE, '../../../../packages/openapi/dist/openapi.json')
    const doc = JSON.parse(fs.readFileSync(openapiPath, 'utf8'))
    const schemas = convertNullable(doc.components.schemas) as Record<string, unknown>
    const ajv = new Ajv({ strict: false, allErrors: true })
    ajv.addFormat('uuid', UUID_RE)
    ajv.addFormat('date-time', INSTANT_RE)
    ajv.addFormat('date', DATE_RE)
    ajv.addSchema({ $id: 'doc', components: { schemas } })
    const validate = ajv.compile({ $ref: 'doc#/components/schemas/AttendanceW4CalculationDetail' })

    const body = res.body.data
    const valid = validate(body)
    expect(
      valid,
      `schema errors: ${JSON.stringify(validate.errors)}`,
    ).toBe(true)
    // The value passed WITHOUT any schema change: the enum member really is
    // present in the DIST artifact this validated against.
    const ownerEnum = (doc.components.schemas.AttendanceW4CalculationDetail as any).properties.current
      .properties.projectionOwner.enum
    expect(ownerEnum).toContain(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1)
    // NEGATIVE CONTROL: additionalProperties enforcement is LIVE in this
    // harness — an injected extra key must fail, on the top level and on
    // `current` (where a leaked contextSelector would land).
    const extraTop = structuredClone(body)
    ;(extraTop as Record<string, unknown>).contextSelector = 'group_effective'
    expect(validate(extraTop)).toBe(false)
    const extraCurrent = structuredClone(body)
    ;(extraCurrent as any).current.contextSelector = 'group_effective'
    expect(validate(extraCurrent)).toBe(false)
  })

  it('T-K15: the DB pointer-pair CHECK rejects NULLing the w4_group pointer — the invariant behind posture never being undeterminable', async () => {
    const record = await recordOf(groupUser)
    let sqlstate = ''
    let constraint = ''
    try {
      await pool.query(`UPDATE attendance_records SET current_calculation_id = NULL WHERE id = $1::uuid`, [
        record.id,
      ])
    } catch (error) {
      sqlstate = String((error as { code?: string }).code ?? '')
      constraint = String((error as { constraint?: string }).constraint ?? '')
    }
    expect(sqlstate).toBe('23514')
    expect(constraint).toBe('chk_ar_owner_pointer_pair')
    // And the row is untouched: the pointer survived the refused write.
    const after = await recordOf(groupUser)
    expect(typeof after.current_calculation_id).toBe('string')
    expect(after.projection_owner).toBe(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1)
  })
})
