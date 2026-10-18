import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { canonicalAttendanceJsonV1, computeAttendanceSemanticInputFingerprintV1 } from '../../src/attendance/w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../../src/attendance/w4c1-fingerprints'
import { __computeAttendanceOuterAttributionValueForTestsV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'
import { assertLegacyPunchResponseGoldenShapeResolvedV1 } from './attendance-w4c2-golden-response'

// Real HTTP JSON and persisted JSON snapshots retain the existing suite shape;
// assertions below validate the complete error bodies and calculation/hash fields.
type Response = { status: number; body?: any; raw: string }
type Outer = Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]
type SeamContext = { outerResolution: Outer['resolution']; outerContext: Outer['context'] }
type Shape = 'parity' | 'day' | 'anchor' | 'overnight' | 'eday1' | 'eday2' | 'null_context'

// New HTTP contract tests stay separate from the historical legacy boundary guards.
export function registerCanonicalTimezoneHttpContracts(deps: {
  pool: () => Pool
  baseUrl: () => string
  requestJson: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>
  mintToken: (userId: string) => Promise<string>
  seedUser: (userId: string, orgId: string) => Promise<void>
  cleanupUsers: string[]
}) {
  describe('HTTP effective-timezone authority contract', () => {
    const plugin = () => createRequire(import.meta.url)('../../../../plugins/plugin-attendance/index.cjs') as {
      __setAttendanceW4LivePunchPreBoundarySeamForTests: (seam: ((ctx: SeamContext) => Promise<void>) | null) => void
    }
    afterAll(() => plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(null))

    async function seed(shape: Shape, legacy = false) {
      const orgId = randomUUID(), userId = randomUUID(), shiftA = randomUUID(), shiftB = randomUUID()
      deps.cleanupUsers.push(userId)
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED += ',' + orgId
      await deps.seedUser(userId, orgId)
      await deps.pool().query(`INSERT INTO attendance_calculation_rollout_state
        (org_id,state,engine_version,reason_code,actor_id,version,prior_state)
        VALUES ($1,$2,'canonical-http','TEST_FIXTURE','canonical-http-fixture',1,NULL)`, [orgId, legacy ? 'legacy' : 'shadow'])
      const overnight = ['overnight', 'eday1', 'eday2'].includes(shape)
      const dayA = '2026-07-19', dayB = shape === 'anchor' ? '2026-07-18' : dayA
      const timesA = shape === 'parity' ? ['20:00', '23:00'] : shape === 'anchor' ? ['00:00', '04:00'] : overnight ? ['22:00', '06:00'] : ['09:00', '17:00']
      const timesB = shape === 'parity' ? timesA : shape === 'anchor' ? ['22:00', '06:00'] : overnight ? ['21:00', '07:00'] : ['08:00', '18:00']
      await deps.pool().query(`INSERT INTO attendance_shifts
        (id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days)
        VALUES ($1,$3,'HTTP-A','UTC',$4,$5,$8,'[0,1,2,3,4,5,6]'::jsonb),
               ($2,$3,'HTTP-B','UTC',$6,$7,$9,'[0,1,2,3,4,5,6]'::jsonb)`,
      [shiftA, shiftB, orgId, ...timesA, ...timesB, overnight, overnight || shape === 'anchor'])
      const assignment = randomUUID()
      await deps.pool().query(`INSERT INTO attendance_shift_assignments
        (id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index)
        VALUES ($1,$2,$3,$4,$5,$5,true,'published',1)`, [assignment, orgId, userId, shiftA, dayA])
      if (shape === 'null_context') {
        for (const shift of [shiftA, shiftB]) await deps.pool().query(`INSERT INTO attendance_shift_segments
          (id,org_id,shift_id,segment_index,start_time,end_time,start_day_offset,end_day_offset)
          VALUES ($1,$2,$3,1,'09:00','17:00',0,0)`, [randomUUID(), orgId, shift])
      }
      const instant = shape === 'parity' ? '2026-07-19T22:00:00.000Z' : shape === 'anchor' ? '2026-07-19T02:00:00.000Z'
        : overnight ? (shape === 'eday2' ? '2026-07-20T03:00:00.000Z' : '2026-07-20T02:00:00.000Z') : '2026-07-19T10:00:00.000Z'
      return { orgId, userId, shiftA, shiftB, dayA, dayB, assignment, instant }
    }
    type Fixture = Awaited<ReturnType<typeof seed>>
    async function punch(f: Fixture, timezone = 'UTC') {
      const token = await deps.mintToken(f.userId)
      return deps.requestJson(deps.baseUrl() + '/api/attendance/punch', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: f.orgId, eventType: 'check_in', occurredAt: f.instant, timezone, operationId: randomUUID() }),
      })
    }
    async function counts(f: Fixture) {
      const { rows } = await deps.pool().query(`SELECT
        (SELECT count(*)::int FROM attendance_events WHERE org_id=$1) AS events,
        (SELECT count(*)::int FROM attendance_records WHERE org_id=$1) AS records,
        (SELECT count(*)::int FROM attendance_result_operations WHERE org_id=$1) AS operations,
        (SELECT count(*)::int FROM attendance_record_calculations WHERE org_id=$1) AS calculations,
        (SELECT count(*)::int FROM attendance_record_segments s JOIN attendance_record_calculations c ON c.id=s.calculation_id WHERE c.org_id=$1) AS segments,
        (SELECT count(*)::int FROM attendance_result_event_outbox WHERE org_id=$1) AS outbox,
        (SELECT count(*)::int FROM attendance_timezone_context_companions WHERE org_id=$1) AS companions`, [f.orgId])
      return rows[0]
    }
    const zero = { events: 0, records: 0, operations: 0, calculations: 0, segments: 0, outbox: 0, companions: 0 }
    async function calculation(f: Fixture) {
      const { rows } = await deps.pool().query('SELECT * FROM attendance_record_calculations WHERE org_id=$1 ORDER BY version', [f.orgId])
      expect(rows).toHaveLength(1)
      return rows[0]
    }
    function assertHashes(c: Record<string, any>) {
      expect(c.semantic_input_fingerprint).toBe(computeAttendanceSemanticInputFingerprintV1({
        attribution: c.attribution_snapshot, context: c.context_snapshot, evidence: c.evidence_snapshot,
        approvedFacts: c.approved_facts_snapshot, manualOverride: c.manual_override_snapshot, mergePolicy: c.merge_policy,
        calculationTier: c.calculation_tier, engineVersion: c.engine_version, snapshotSchemaVersion: c.snapshot_schema_version,
      }))
      expect(c.source_definition_fingerprint).toBe(computeAttendanceSourceDefinitionFingerprintV1({ attribution: c.attribution_snapshot, context: c.context_snapshot }))
      expect(c.source_definition_fingerprint).not.toBe(c.semantic_input_fingerprint)
    }
    function assertError(response: Response, status: number, code: string) {
      expect(response.status, response.raw).toBe(status)
      expect(response.body).toEqual({ ok: false, error: { code, message: code } })
    }

    it('HTTP L1/L4: Tokyo conflicts with authority UTC with zero writes; legal UTC preserves legacy parity and independent hashes', async () => {
      const f = await seed('parity'), ref = await seed('parity', true)
      expect(await counts(f)).toEqual(zero)
      assertError(await punch(f, 'Asia/Tokyo'), 409, 'ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT')
      expect(await counts(f)).toEqual(zero)
      const legacy = await punch(ref), response = await punch(f)
      expect(legacy.status, legacy.raw).toBe(200)
      expect(response.status, response.raw).toBe(200)
      assertLegacyPunchResponseGoldenShapeResolvedV1(response.body.data, {
        userId: f.userId, status: 'partial', workMinutes: 0, lateMinutes: 0,
        firstInAt: f.instant, lastOutAt: null, calendarWorkDate: f.dayA,
        reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT', shiftId: f.shiftA, resolvedWorkDate: f.dayA, matchingCount: 1,
      })
      const c = await calculation(f)
      expect(c.outcome).toBe('completed')
      expect(c.attribution_snapshot.posture).toBe('resolved_v2')
      expect(c.attribution_snapshot.value.workDate).toBe(f.dayA)
      expect(c.attribution_snapshot.value.reasonCode).toBe('CURRENT_DAY_CONTAINING_SHIFT')
      expect(c.attribution_snapshot.value.absoluteWindow).toEqual(legacy.body.data.workDateResolution.evidenceSnapshot.winner.absoluteWindow)
      expect(c.attribution_snapshot.value.attributionWindow.startAt).toBe(c.attribution_snapshot.value.absoluteWindow.startAt)
      expect(c.attribution_snapshot.value.attributionWindow.endAt).toBe(new Date(Date.parse(c.attribution_snapshot.value.absoluteWindow.endAt) + c.attribution_snapshot.value.attributionTailMinutes * 60_000).toISOString())
      expect(c.context_snapshot.timezone).toBe('UTC')
      assertHashes(c)
    })

    for (const shape of ['anchor', 'day', 'overnight'] as const) {
      it(`HTTP authority race ${shape}: exact CONTEXT_CHANGED and seven-table zero delta; disarmed same fixture succeeds`, async () => {
        const f = await seed(shape), before = await counts(f)
        expect(before).toEqual(zero)
        let reached = false
        plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(async () => {
          reached = true
          await deps.pool().query('UPDATE attendance_shift_assignments SET is_active=false WHERE id=$1', [f.assignment])
          await deps.pool().query(`INSERT INTO attendance_shift_assignments
            (id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index)
            VALUES ($1,$2,$3,$4,$5,$5,true,'published',1)`, [randomUUID(), f.orgId, f.userId, f.shiftB, f.dayB])
        })
        let response: Response
        try { response = await punch(f) } finally { plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(null) }
        expect(reached).toBe(true)
        assertError(response, 409, 'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED')
        expect(await counts(f)).toEqual(before)
        const control = await punch(f)
        expect(control.status, control.raw).toBe(200)
        const c = await calculation(f)
        expect(c.outcome).toBe('completed')
        expect(c.attribution_snapshot.value.shiftId).toBe(f.shiftB)
        expect(c.attribution_snapshot.value.workDate).toBe(f.dayB)
        expect(c.context_snapshot.timezone).toBe('UTC')
        assertHashes(c)
      })
    }

    it('HTTP L6/OD53: changing only shift timezone cannot override effective UTC', async () => {
      const f = await seed('day')
      let reached = false
      plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(async () => {
        reached = true
        await deps.pool().query("UPDATE attendance_shifts SET timezone='Asia/Kolkata' WHERE id=$1", [f.shiftA])
      })
      let response: Response
      try { response = await punch(f) } finally { plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(null) }
      expect(reached).toBe(true)
      expect(response.status, response.raw).toBe(200)
      const c = await calculation(f)
      expect(c.outcome).toBe('completed')
      expect(c.attribution_snapshot.value.shiftId).toBe(f.shiftA)
      expect(c.context_snapshot.timezone).toBe('UTC')
      assertHashes(c)
    })

    for (const shape of ['eday1', 'eday2', 'overnight'] as const) {
      it(`HTTP E/F/F2 ${shape}: legal UTC frame keeps reasonCode stable and exact drift set {resolvedAt}`, async () => {
        const f = await seed(shape)
        const captured: SeamContext[] = []
        plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(async ctx => { captured.push(ctx) })
        let response: Response
        try { response = await punch(f) } finally { plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(null) }
        expect(response.status, response.raw).toBe(200)
        expect(captured).toHaveLength(1)
        const outer = __computeAttendanceOuterAttributionValueForTestsV1({
          orgId: f.orgId, userId: f.userId, source: 'live_resolution', nowIso: new Date().toISOString(),
          resolution: captured[0]!.outerResolution, context: captured[0]!.outerContext,
        })!
        const c = await calculation(f), inner = c.attribution_snapshot.value
        expect(c.outcome).toBe('completed')
        expect(outer.reasonCode).toBe('PREVIOUS_NIGHT_CONTAINING_SHIFT')
        expect(inner.reasonCode).toBe(outer.reasonCode)
        const keys = new Set([...Object.keys(outer), ...Object.keys(inner)])
        expect([...keys].filter(key => canonicalAttendanceJsonV1(outer[key]) !== canonicalAttendanceJsonV1(inner[key])).sort()).toEqual(['resolvedAt'])
        expect(c.context_snapshot.timezone).toBe('UTC')
        assertHashes(c)
      })
    }

    it('HTTP Group G: malformed source refuses before boundary seam, armed and disarmed, with seven-table zero writes', async () => {
      const f = await seed('null_context')
      expect(await counts(f)).toEqual(zero)
      let reached = false
      plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(async () => { reached = true })
      let response: Response
      try { response = await punch(f) } finally { plugin().__setAttendanceW4LivePunchPreBoundarySeamForTests(null) }
      assertError(response, 503, 'ATTENDANCE_TIMEZONE_CALCULATION_SOURCE_INVALID')
      expect(reached).toBe(false)
      expect(await counts(f)).toEqual(zero)
      assertError(await punch(f), 503, 'ATTENDANCE_TIMEZONE_CALCULATION_SOURCE_INVALID')
      expect(await counts(f)).toEqual(zero)
    })
  })
}
