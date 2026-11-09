import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { scenarios, withReviewFixture } from './attendance-punch-review-public-native'
import { calculateAttendanceSegmentsV1 } from '../../src/attendance/w4c1-segment-calculator'
import { computeAttendanceWindowEvidenceFingerprintV1,
  ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1 } from '../../src/attendance/w4c2-frozen-attribution'

type Cursor = { approvalId: string; version: number; node: string }
type Dependencies = Parameters<typeof withReviewFixture>[0] & {
  loadApprovalCursor(requestId: string): Promise<Cursor>
  assignApprovalUser(cursor: Cursor, userId: string): Promise<void>
  frozenCanonicalCalculation(orgId: string, calculationId: string): Promise<unknown>
}
const data = (reply: { body: unknown }) => (reply.body as { data: Record<string, unknown> }).data

/** L0/O1 review closure only; the four import transports and completed folds stay in their original cases. */
export function registerEp01DstReviewCallerNativeCases(deps: Dependencies) {
  it.each(scenarios)('EP01_DST_REVIEW_CALLERS_$id', async scenario => {
    const ownedEnv = {
      ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    }
    let receipt: Record<string, string | number | boolean> | undefined
    try {
      process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = 'false'
      await withReviewFixture(deps, scenario, async f => {
        const pool = deps.pool()
        const call = (path: string, body: Record<string, unknown>) => deps.request(deps.baseUrl() + path,
          { method: 'POST', headers: f.headers, body })
        const punches = scenario.instants.map((clock, index) => ({
          direction: index % 2 === 0 ? 'check_in' : 'check_out', occurredAt: scenario.day + 'T' + clock + ':00.000Z',
        }))
        const shifts = (await pool.query('SELECT id FROM attendance_shifts WHERE org_id=$1', [f.orgId])).rows
        expect(shifts).toHaveLength(1)
        const context = {
          schemaVersion: 1, selector: 'legacy', orgId: f.orgId, userId: f.userId, workDate: scenario.day,
          timezone: 'America/New_York', shiftId: shifts[0].id, isWorkday: true, holidayKind: null,
          calculationGroupId: null, roundingMinutes: 1, severeLateThresholdMinutes: 30, absenceLateThresholdMinutes: 60,
          segments: scenario.clocks.map(([startTime, endTime], index) => ({
            index, startTime, endTime, startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
          })),
        }
        const absoluteWindow = { startAt: punches[0].occurredAt, endAt: punches[3].occurredAt }
        const attributionWindow = { startAt: absoluteWindow.startAt,
          endAt: new Date(Date.parse(absoluteWindow.endAt) + 120 * 60000).toISOString() }
        // Both outer boundaries are unique. Only the internal segment boundary is a gap/shared fold.
        const attribution = (resolvedAt: string, source: 'live_resolution' | 'request_creation') => ({
          posture: 'resolved_v2', value: {
            schemaVersion: 2, resolverVersion: ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1,
            orgId: f.orgId, userId: f.userId, workDate: scenario.day, shiftId: shifts[0].id,
            reasonCode: source === 'live_resolution' ? 'CURRENT_DAY_CONTAINING_SHIFT' : 'SINGLE_MATCHING_CANDIDATE',
            resolvedAt, absoluteWindow, attributionWindow,
            attributionTailMinutes: 120, extendedByApprovedOvertime: false,
            windowEvidenceFingerprint: computeAttendanceWindowEvidenceFingerprintV1({
              attributionTailMinutes: 120, approvedOvertimeWindows: [],
            }), source,
          },
        })
        async function readReview(eventCount: number, adjustmentCount = 0) {
          const parents = (await pool.query(`SELECT r.*,r.work_date::text AS record_work_date_text FROM attendance_records r
            WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date`, [f.orgId, f.userId, scenario.day])).rows
          expect(parents, 'EP01_DST_REVIEW_ONE_PARENT').toHaveLength(1)
          const { record_work_date_text: workDate, ...parent } = parents[0]
          expect(workDate).toBe(scenario.day)
          expect(parent).toMatchObject({ org_id: f.orgId, user_id: f.userId,
            timezone: 'America/New_York', is_workday: true, status: 'normal', projection_owner: 'legacy_untracked',
            current_calculation_id: null, visibility_state: 'retired', visibility_reason: 'review_placeholder',
            first_in_at: null, last_out_at: null, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0 })
          expect((await pool.query('SELECT id FROM attendance_records WHERE org_id=$1', [f.orgId])).rows)
            .toEqual([{ id: parent.id }])
          const calculations = (await pool.query(`SELECT * FROM attendance_record_calculations
            WHERE org_id=$1 AND attendance_record_id=$2 ORDER BY version`, [f.orgId, parent.id])).rows
          expect((await pool.query('SELECT id FROM attendance_record_segments WHERE org_id=$1', [f.orgId])).rows)
            .toEqual([])
          const allEvents = (await pool.query(`SELECT e.*,e.work_date::text AS event_work_date_text
            FROM attendance_events e WHERE org_id=$1 AND user_id=$2 ORDER BY occurred_at,id`, [f.orgId, f.userId])).rows
          const events = allEvents.filter(row => row.event_type === 'check_in' || row.event_type === 'check_out')
          const adjustments = allEvents.filter(row => row.event_type !== 'check_in' && row.event_type !== 'check_out')
          expect(adjustments.map(row => row.event_type), 'EP01_DST_REVIEW_EXACT_AUDIT_EVENT_COUNT')
            .toEqual(Array.from({ length: adjustmentCount }, () => 'adjustment'))
          expect(events.map(row => ({ direction: row.event_type, occurredAt: row.occurred_at.toISOString() })))
            .toEqual(punches.slice(0, eventCount))
          expect(events.map(row => [row.event_work_date_text, row.timezone]))
            .toEqual(events.map(() => [scenario.day, 'America/New_York']))
          return { parent, calculations, events, adjustments }
        }
        function assertReview(row: Awaited<ReturnType<typeof readReview>>['calculations'][number],
          evidence: unknown, entrypoint: 'live' | 'approved_overtime', version: number, operationId: string) {
          expect(row.outcome_reason_code, entrypoint === 'live'
            ? 'EP01_DST_REVIEW_LIVE_TYPED_REASON' : 'EP01_DST_REVIEW_OVERTIME_TYPED_REASON').toBe(scenario.reason)
          expect(row).toMatchObject({ org_id: f.orgId, version, calculation_kind: 'calculation', mode: 'authoritative',
            entrypoint, operation_id: operationId, outcome: 'review_required', outcome_reason_code: scenario.reason,
            projection_effect: 'none', expected_segment_count: 0,
            supersedes_calculation_id: null, restores_calculation_id: null, source_batch_id: null,
            context_snapshot: context, evidence_snapshot: evidence, manual_override_snapshot: null,
            projected_status: null, projected_first_in_at: null, projected_last_out_at: null,
            projected_work_minutes: null, projected_late_minutes: null, projected_early_leave_minutes: null,
            projected_daily_fingerprint: null })
          // Both selected writers are authoritative and dispatch to writeReviewRow; shadow live uses another shape.
          expect(row.segment_snapshot, 'EP01_DST_REVIEW_AUTHORITATIVE_SEGMENT_SNAPSHOT').toEqual([])
          expect(row.context_snapshot, 'EP01_DST_REVIEW_LITERAL_CONTEXT').toEqual(context)
          expect(row.evidence_snapshot, 'EP01_DST_REVIEW_COMPLETE_EVIDENCE').toEqual(evidence)
          expect(calculateAttendanceSegmentsV1({ attribution: row.attribution_snapshot, context: row.context_snapshot,
            evidence: row.evidence_snapshot, approvedFacts: row.approved_facts_snapshot }), 'EP01_DST_REVIEW_TYPED_RESULT')
            .toEqual({ outcome: 'review_required', outcomeReasonCode: scenario.reason, segments: [], dailyProjection: null })
        }
        async function assertOperation(operationId: string, entrypoint: 'live_punch' | 'request_decision',
          row: Awaited<ReturnType<typeof readReview>>['calculations'][number], requestId: string | null) {
          const operations = (await pool.query(`SELECT state,resolved_record_id::text,resolved_calculation_id::text,
            resolved_request_id::text,result_semantic_fingerprint,result_provenance_fingerprint
            FROM attendance_result_operations WHERE org_id=$1 AND operation_id=$2 AND entrypoint=$3`,
          [f.orgId, operationId, entrypoint])).rows
          expect(operations, 'EP01_DST_REVIEW_SEALED_OPERATION').toEqual([{ state: 'completed',
            resolved_record_id: row.attendance_record_id, resolved_calculation_id: row.id, resolved_request_id: requestId,
            result_semantic_fingerprint: row.semantic_input_fingerprint, result_provenance_fingerprint: row.provenance_fingerprint }])
        }
        const frozenHistory: Array<{ id: string; frozen: unknown }> = []
        let l0: Awaited<ReturnType<typeof readReview>> | undefined
        for (const [index, punch] of punches.entries()) {
          const operationId = randomUUID()
          const before = Date.now()
          // The existing driver injects only punch time and restores it; authoritative resolvedAt uses real new Date().
          const response = await call('/api/attendance/punch', { orgId: f.orgId, eventType: punch.direction,
            operationId, occurredAt: punch.occurredAt, timezone: 'America/New_York' })
          const after = Date.now()
          expect(response.status, 'EP01_DST_REVIEW_LIVE_HTTP_PENDING_NATIVE').toBe(200)
          l0 = await readReview(index + 1)
          expect(l0.calculations).toHaveLength(index + 1)
          const row = l0.calculations[index]
          const evidence = l0.events.map(event => ({ kind: 'punch', ref: event.id, direction: event.event_type,
            occurredAt: event.occurred_at.toISOString(), source: 'attendance_event' }))
          assertReview(row, evidence, 'live', index + 1, operationId)
          expect(row.approved_facts_snapshot).toEqual([])
          const resolvedAt = row.attribution_snapshot.value.resolvedAt
          expect(new Date(resolvedAt).toISOString()).toBe(resolvedAt)
          expect(Date.parse(resolvedAt)).toBeGreaterThanOrEqual(before)
          expect(Date.parse(resolvedAt)).toBeLessThanOrEqual(after)
          expect(row.attribution_snapshot, 'EP01_DST_REVIEW_LITERAL_LIVE_SOURCE').toEqual(attribution(resolvedAt, 'live_resolution'))
          expect(data(response).record).toEqual(JSON.parse(JSON.stringify(l0.parent)))
          expect(data(response).event).toMatchObject({ id: l0.events[index].id, event_type: punch.direction,
            occurred_at: punch.occurredAt })
          await assertOperation(operationId, 'live_punch', row, null)
          for (const prior of frozenHistory) {
            expect(await deps.frozenCanonicalCalculation(f.orgId, prior.id), 'EP01_DST_REVIEW_LIVE_HISTORY_IMMUTABLE').toEqual(prior.frozen)
          }
          frozenHistory.push({ id: row.id, frozen: await deps.frozenCanonicalCalculation(f.orgId, row.id) })
        }
        if (!l0) throw new Error('EP01_DST_REVIEW_L0_REQUIRED')
        expect(l0.events).toHaveLength(4)
        const evidence = l0.calculations[3].evidence_snapshot
        const overtimeRuleId = randomUUID()
        await pool.query('INSERT INTO attendance_overtime_rules (id,org_id,name,rounding_minutes) VALUES ($1,$2,$3,1)',
          [overtimeRuleId, f.orgId, 'EP01_DST_REVIEW_' + overtimeRuleId])
        // Local 00:30-01:00 is wholly inside segment zero on both fixed days; the OT endpoints are explicit UTC instants.
        const otStart = punches[0].occurredAt
        const otEnd = new Date(Date.parse(otStart) + 30 * 60000).toISOString()
        const created = await call('/api/attendance/requests', { operationId: randomUUID(), orgId: f.orgId,
          workDate: scenario.day, requestType: 'overtime', overtimeRuleId, requestedInAt: otStart, requestedOutAt: otEnd,
          minutes: 30, reason: 'EP01 DST review synthetic bounded interval' })
        expect(created.status, 'EP01_DST_REVIEW_OT_CREATE_PENDING_NATIVE').toBe(201)
        const requestId = (data(created).request as { id: string }).id
        const snapshots = (await pool.query(`SELECT * FROM attendance_request_calculation_snapshots
          WHERE org_id=$1 AND request_id=$2 ORDER BY version`, [f.orgId, requestId])).rows
        expect(snapshots).toHaveLength(1)
        const snapshot = snapshots[0]
        expect(snapshot).toMatchObject({ org_id: f.orgId, request_id: requestId, version: 1,
          request_type: 'overtime', subject_user_id: f.userId, created_by: f.userId })
        expect(data(created).requestSnapshot).toEqual({ version: 1, fingerprint: snapshot.payload_fingerprint })
        expect(snapshot.context_snapshot, 'EP01_DST_REVIEW_REQUEST_ORIGINAL_CONTEXT').toEqual(context)
        const requestResolvedAt = snapshot.attribution_snapshot.value.resolvedAt
        expect(new Date(requestResolvedAt).toISOString()).toBe(requestResolvedAt)
        expect(snapshot.attribution_snapshot).toEqual(attribution(requestResolvedAt, 'request_creation'))
        expect(snapshot.payload).toMatchObject({ workDate: scenario.day, requestedInAt: otStart, requestedOutAt: otEnd, minutes: 30 })
        const cursor = await deps.loadApprovalCursor(requestId)
        await deps.assignApprovalUser(cursor, f.userId)
        const operationId = randomUUID()
        const approved = await call('/api/attendance/requests/' + requestId + '/approve', {
          operationId, expectedApprovalVersion: cursor.version, expectedApprovalNode: cursor.node,
          comment: 'EP01 DST review synthetic decision',
        })
        expect(approved.status, 'EP01_DST_REVIEW_OT_APPROVE_PENDING_NATIVE').toBe(200)
        const o1 = await readReview(4, 1)
        expect(o1.calculations).toHaveLength(5)
        // Authoritative review bypasses the legacy parent upsert; companion binding never updates parent metadata.
        expect(o1.parent, 'EP01_DST_REVIEW_NO_PARENT_PROJECTION_CHANGE').toEqual(l0.parent)
        expect(o1.events, 'EP01_DST_REVIEW_ALL_FOUR_RAW_EVENTS_RETAINED').toEqual(l0.events)
        const row = o1.calculations[4]
        assertReview(row, evidence, 'approved_overtime', 5, operationId)
        expect(row.attribution_snapshot).toEqual(snapshot.attribution_snapshot)
        expect(row.context_snapshot).toEqual(snapshot.context_snapshot)
        const requests = (await pool.query(`SELECT *,work_date::text AS request_work_date_text
          FROM attendance_requests WHERE org_id=$1 AND id=$2`, [f.orgId, requestId])).rows
        expect(requests).toHaveLength(1)
        const request = requests[0]
        expect(o1.adjustments[0], 'EP01_DST_REVIEW_OT_AUDIT_EVENT').toMatchObject({
          org_id: f.orgId, user_id: f.userId, event_work_date_text: scenario.day, event_type: 'adjustment',
          source: 'request', timezone: 'America/New_York', location: {}, occurred_at: request.resolved_at,
        })
        expect(o1.adjustments[0].meta, 'EP01_DST_REVIEW_OT_AUDIT_BINDING').toEqual({
          requestId, requestType: 'overtime', minutes: 30, leaveType: null,
          overtimeRule: request.metadata.overtimeRule ?? null, requested_in_at: otStart, requested_out_at: otEnd,
        })
        const terminal = (await pool.query(`SELECT ar.id::text,ar.instance_id,ar.actor_id,ar.action,ar.from_version,ar.to_version,
          ar.to_status,ai.status AS instance_status,ai.version AS instance_version FROM approval_records ar
          JOIN approval_instances ai ON ai.id=ar.instance_id WHERE ar.instance_id=$1 AND ar.to_version=$2
          AND ar.action='approve' AND ar.to_status='approved'`, [cursor.approvalId, cursor.version + 1])).rows
        expect(terminal, 'EP01_DST_REVIEW_INDEPENDENT_TERMINAL_APPROVAL').toHaveLength(1)
        expect(terminal[0]).toEqual({ id: terminal[0].id, instance_id: cursor.approvalId, actor_id: f.userId,
          action: 'approve', from_version: cursor.version, to_version: cursor.version + 1, to_status: 'approved',
          instance_status: 'approved', instance_version: cursor.version + 1 })
        expect(terminal[0].id).toMatch(/^[1-9][0-9]*$/)
        expect(request.metadata.w4RequestSnapshotTerminalBinding).toEqual({ schemaVersion: 1,
          kind: 'w4c3b_request_snapshot_terminal_binding', orgId: f.orgId, requestId, requestType: 'overtime',
          subjectUserId: f.userId, requestSnapshotVersion: snapshot.version, requestSnapshotFingerprint: snapshot.payload_fingerprint,
          approvalVersion: terminal[0].to_version, approvalRecordId: terminal[0].id, action: 'approve', bindingPosture: 'bound' })
        expect(request).toMatchObject({ id: requestId, org_id: f.orgId, user_id: f.userId,
          request_type: 'overtime', status: 'approved', approval_instance_id: cursor.approvalId })
        expect(request.request_work_date_text).toBe(scenario.day)
        expect(request.metadata.approvalFlow?.steps ?? []).toEqual([])
        expect(approved.body).toEqual({ ok: true, data: { requestId, status: 'approved', record: null,
          orgId: null, userId: f.userId, approvalStep: { index: 0, total: 0 } } })
        expect(row.approved_facts_snapshot).toEqual([{ kind: 'overtime', requestId,
          requestSnapshotVersion: snapshot.version, requestSnapshotFingerprint: snapshot.payload_fingerprint,
          approvalVersion: terminal[0].to_version, approvalRecordId: terminal[0].id,
          coverage: { kind: 'bounded_interval', startAt: otStart, endAt: otEnd, minutes: 30 } }])
        expect(row.input_provenance.priorCalculations).toEqual(l0.calculations.map(prior => ({
          id: prior.id, semanticFingerprint: prior.semantic_input_fingerprint, provenanceFingerprint: prior.provenance_fingerprint,
        })))
        await assertOperation(operationId, 'request_decision', row, requestId)
        for (const prior of frozenHistory) {
          expect(await deps.frozenCanonicalCalculation(f.orgId, prior.id), 'EP01_DST_REVIEW_OT_HISTORY_IMMUTABLE').toEqual(prior.frozen)
        }
        expect((await pool.query(`SELECT * FROM attendance_request_calculation_snapshots
          WHERE org_id=$1 AND request_id=$2 ORDER BY version`, [f.orgId, requestId])).rows).toEqual(snapshots)
        const tables = ['attendance_records', 'attendance_record_calculations', 'attendance_record_segments', 'attendance_events',
          'attendance_requests', 'attendance_request_calculation_snapshots', 'attendance_import_batches', 'attendance_import_items',
          'attendance_result_operation_batches', 'attendance_result_operations', 'attendance_result_event_outbox',
          'attendance_timezone_context_companions']
        async function businessSnapshot() {
          const result: unknown[] = []
          for (const table of tables) result.push((await pool.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [f.orgId])).rows)
          return result
        }
        const beforeRefusal = await businessSnapshot()
        const refused = await call('/api/attendance/records/' + o1.parent.id + '/recompute', {
          orgId: f.orgId, operationId: randomUUID(), policy: 'frozen_prior',
          expectedCalculationId: null, expectedCalculationVersion: null,
        })
        expect(refused.status, 'EP01_DST_REVIEW_RETIRED_RECOMPUTE_409').toBe(409)
        expect((refused.body as { error: { code: string } }).error.code).toBe('ATTENDANCE_RECORD_RETIRED')
        expect(await businessSnapshot(), 'EP01_DST_REVIEW_REFUSAL_UNCHANGED_BUSINESS_TABLES').toEqual(beforeRefusal)
        receipt = { scenarioId: scenario.id, liveTypedReason: l0.calculations[3].outcome_reason_code,
          approvedOvertimeTypedReason: row.outcome_reason_code, physicalEvents: o1.events.length,
          currentPointers: 0, children: 0, priorImmutable: true, recomputeRefused: true,
          businessSnapshotUnchanged: true, fixtureAuthBypass: true, realRedis: false, fullEP01: false }
      })
    } finally {
      for (const [key, value] of Object.entries(ownedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(receipt, 'EP01_DST_REVIEW_RECEIPT_READY').toBeDefined()
    console.log('EP01_DST_REVIEW_CALLERS_RECEIPT ' + JSON.stringify(receipt))
  }, 120000)
}
