import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ApprovalProductService,
  __setApprovalDepartureTransferTestBarrierForTests,
} from '../../src/services/ApprovalProductService'
import { ServiceError } from '../../src/services/ApprovalBridgeService'
import type { ApprovalGraph, FormSchema } from '../../src/types/approval-product'
import { grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-4 (docs/development/approval-lock4-flow-policies-20260817.md) F4-E — 离职自动转上级,
 * OD-L4-9(a). REAL-DB acceptance for `ApprovalProductService.applyApprovalDepartureTransfer`, the
 * out-of-band departure fallback (NOT in-resolver). Covers gates E-1/E-2/E-3 verbatim, each with
 * its stated positive/negative control, plus a REAL two-connection concurrency race (a departure
 * racing a concurrent decide on the same seat) — TOCTOU claims are constructed here, not argued.
 *
 * This suite invokes the service method DIRECTLY (no HTTP layer, no directory-sync wiring): P3-A
 * slice scope is "an explicit test-visible entry point (no directory wiring)" per the Lock-4 P3-A
 * briefs — the `user_changed` deprovision consumer wiring (OD-L4-8a) is a separate slice. The
 * suite's fixtures independently reconstruct the ONE precondition that consumer will eventually
 * supply: a departed user id.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

// TOP-LEVEL, outside describeIfDatabase (mirrors approval-dedup-return-round-scoping.db.test.ts
// :45-46). The in-describe-block sentinel further down is NOT the anti-skip-green sentinel — that
// one is skipped along with the rest of the suite the moment DATABASE_URL is absent, so it can
// never fire. approval-realdb-departure-transfer.yml sets EXPECT_DB=1: in THAT lane a missing or
// broken DATABASE_URL must go RED, never silently report the whole file as skipped.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const REQ = `dep-req-${TS}`
const U = `dep-u-${TS}` // E-1: departed user WITH a resolvable manager
const MGR = `dep-mgr-${TS}` // U's (and U2's, U3's) manager — leader of DEPT1
const OTHER = `dep-other-${TS}` // E-1 control: co-assignee at the same node, must stay untouched
const U2 = `dep-u2-${TS}` // E-2 positive control: a resolvable-manager departure in the same fixture
const NOMGR = `dep-nomgr-${TS}` // E-2 negative: no directory link at all → no manager resolvable
const U3 = `dep-u3-${TS}` // concurrency race: sole assignee, resolvable manager
const U4 = `dep-u4-${TS}` // P26: departed user on an attendance-central instance (must skip, not move)
const U5 = `dep-u5-${TS}` // self-approval guard: U5's manager (MGR) is ALSO the requester of U5's instance
const DELEGATOR = `dep-delegator-${TS}` // E-3: delegates away, then departs
const DELEGATEE = `dep-delegatee-${TS}` // E-3: holds the substituted seat, then departs
const DELEGATEE_MGR = `dep-delegatee-mgr-${TS}` // leader of DEPT2

const DEPT1 = `dep-dept1-${TS}`
const DEPT2 = `dep-dept2-${TS}`

const FORM_SCHEMA: FormSchema = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }
const WINDOW = { startAt: new Date(Date.now() - 3600_000), endAt: new Date(Date.now() + 3600_000) }

function graph(userIds: string[]): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: 'a',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds }],
          approvalMode: userIds.length > 1 ? 'all' : 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }
}

type AssignmentRow = {
  id: string
  assignee_id: string
  node_key: string | null
  is_active: boolean
  entry_epoch: number | null
  metadata: Record<string, unknown>
}
type RecordRow = {
  action: string
  actor_id: string
  actor_name: string
  from_status: string
  to_status: string
  from_version: number
  to_version: number
  metadata: Record<string, unknown>
  target_user_id: string | null
}

async function createPublishedInstance(
  service: ApprovalProductService,
  key: string,
  userIds: string[],
  requesterId: string = REQ,
): Promise<string> {
  const template = await service.createTemplate({
    key,
    name: key,
    formSchema: FORM_SCHEMA,
    approvalGraph: graph(userIds),
  })
  await service.publishTemplate(template.id, { policy: { allowRevoke: true } })
  const approval = await service.createApproval(
    { templateId: template.id, formData: { reason: 'r' } },
    { userId: requesterId, userName: requesterId },
  )
  return approval.id
}

describeIfDatabase('F4-E departure fallback (离职自动转上级) — Lock-4 gates E-1/E-2/E-3 real-DB', () => {
  const service = new ApprovalProductService()
  const pool = poolManager.get()
  let integrationId = ''
  const templateKeys: string[] = []

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1,$2,'x'),($3,$4,'x'),($5,$6,'x'),($7,$8,'x'),($9,$10,'x'),($11,$12,'x'),
              ($13,$14,'x'),($15,$16,'x'),($17,$18,'x'),($19,$20,'x'),($21,$22,'x')`,
      [
        REQ, `${REQ}@example.test`,
        U, `${U}@example.test`,
        MGR, `${MGR}@example.test`,
        OTHER, `${OTHER}@example.test`,
        U2, `${U2}@example.test`,
        U3, `${U3}@example.test`,
        DELEGATOR, `${DELEGATOR}@example.test`,
        DELEGATEE, `${DELEGATEE}@example.test`,
        DELEGATEE_MGR, `${DELEGATEE_MGR}@example.test`,
        U4, `${U4}@example.test`,
        U5, `${U5}@example.test`,
      ],
    )
    // NOMGR deliberately gets a `users` row (so the target-active check on a hypothetical resolve
    // would pass) but NO directory account/link at all — resolveApprovalRequesterOrgRelations must
    // return `{}` for it, proving E-2's fail-closed path is driven by absence-of-manager, not
    // absence-of-user.
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x')`, [NOMGR, `${NOMGR}@example.test`])
    await grantApprovalWriteForIntegrationActor(REQ)
    // MGR also acts as a REQUESTER for the self-approval-guard test below (MGR is both U5's manager
    // and the requester of U5's own instance there).
    await grantApprovalWriteForIntegrationActor(MGR)

    integrationId = (
      await pool.query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dep-int-${TS}`, `dep-corp-${TS}`],
      )
    ).rows[0].id

    const dept1Id = (
      await pool.query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, 'Eng', true, '{}'::jsonb) RETURNING id`,
        [integrationId, DEPT1],
      )
    ).rows[0].id
    const dept2Id = (
      await pool.query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, 'Sales', true, '{}'::jsonb) RETURNING id`,
        [integrationId, DEPT2],
      )
    ).rows[0].id

    const makeAccount = async (extId: string, name: string, leaderOfDept?: string): Promise<string> => {
      const raw = leaderOfDept ? JSON.stringify({ leader_in_dept: [{ dept_id: leaderOfDept, leader: true }] }) : '{}'
      return (
        await pool.query<{ id: string }>(
          `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
          [integrationId, `ext-${extId}`, `key-${extId}`, name, raw],
        )
      ).rows[0].id
    }
    const link = async (accountId: string, localUserId: string): Promise<void> => {
      await pool.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, 'linked', 'manual')`,
        [accountId, localUserId],
      )
    }
    const primaryOf = async (accountId: string, deptId: string): Promise<void> => {
      await pool.query(
        `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
         VALUES ($1, $2, true)`,
        [accountId, deptId],
      )
    }

    // DEPT1: MGR is leader; U, U2, U3, U4, U5 are ordinary members (all managed by MGR).
    const accMgr = await makeAccount(MGR, 'MGR', DEPT1)
    await link(accMgr, MGR)
    await primaryOf(accMgr, dept1Id)
    for (const [extId, localId] of [[U, U] as const, [U2, U2] as const, [U3, U3] as const, [U4, U4] as const, [U5, U5] as const]) {
      const acc = await makeAccount(extId, extId, undefined)
      await link(acc, localId)
      await primaryOf(acc, dept1Id)
    }

    // DEPT2: DELEGATEE_MGR is leader; DELEGATEE is an ordinary member.
    const accDelMgr = await makeAccount(DELEGATEE_MGR, 'DELMGR', DEPT2)
    await link(accDelMgr, DELEGATEE_MGR)
    await primaryOf(accDelMgr, dept2Id)
    const accDelegatee = await makeAccount(DELEGATEE, DELEGATEE, undefined)
    await link(accDelegatee, DELEGATEE)
    await primaryOf(accDelegatee, dept2Id)

    // DELEGATOR -> DELEGATEE, active, scope 'all' (mirrors approval-delegation-api.db.test.ts).
    await pool.query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', $4, $5, TRUE)`,
      [`dep-deleg-${TS}`, DELEGATOR, DELEGATEE, WINDOW.startAt, WINDOW.endAt],
    )
  })

  afterAll(async () => {
    try {
      if (templateKeys.length > 0) {
        const tids = (await pool.query<{ id: string }>(`SELECT id FROM approval_templates WHERE key = ANY($1)`, [templateKeys])).rows.map((r) => r.id)
        if (tids.length > 0) {
          const iids = (await pool.query<{ id: string }>(`SELECT id FROM approval_instances WHERE template_id = ANY($1)`, [tids])).rows.map((r) => r.id)
          if (iids.length > 0) {
            await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
            await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
            await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
          }
          await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [tids])
          await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
        }
      }
      await pool.query(`DELETE FROM approval_delegations WHERE delegator_user_id = $1`, [DELEGATOR])
      if (integrationId) {
        await pool.query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await pool.query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [
        [REQ, U, MGR, OTHER, U2, NOMGR, U3, U4, U5, DELEGATOR, DELEGATEE, DELEGATEE_MGR],
      ])
    } catch {
      /* best effort */
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it(
    "E-1 'F4-E transfer': a departure signal moves the departed user's active seats to the resolved manager, same epoch, " +
      "with the system:approval-departure sentinel and an audit row | a non-departed assignee's seats are untouched in the same run",
    async () => {
      const key = `dep-e1-${TS}`
      templateKeys.push(key)
      const instanceId = await createPublishedInstance(service, key, [U, OTHER])

      const before = (
        await pool.query<AssignmentRow>(
          `SELECT id, assignee_id, node_key, is_active, entry_epoch, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceId],
        )
      ).rows
      const uBefore = before.find((r) => r.assignee_id === U)!
      const otherBefore = before.find((r) => r.assignee_id === OTHER)!
      expect(uBefore).toBeDefined()
      expect(otherBefore).toBeDefined()
      expect(uBefore.entry_epoch).toBe(1) // initial activation epoch (bumpNodeActivationSeq at create)

      const instBefore = (
        await pool.query<{ node_activation_seq: number; version: number }>(
          `SELECT node_activation_seq, version FROM approval_instances WHERE id = $1`,
          [instanceId],
        )
      ).rows[0]

      const result = await service.applyApprovalDepartureTransfer(U)
      expect(result.transferred).toContain(instanceId)
      expect(result.noManagerResolved).not.toContain(instanceId)

      const after = (
        await pool.query<AssignmentRow>(
          `SELECT id, assignee_id, node_key, is_active, entry_epoch, metadata FROM approval_assignments WHERE instance_id = $1`,
          [instanceId],
        )
      ).rows

      // U's original seat is deactivated (never deleted — append-only history).
      const uRowAfter = after.find((r) => r.id === uBefore.id)!
      expect(uRowAfter.is_active).toBe(false)

      // MGR now holds an ACTIVE seat at the SAME node, with the SAME entry_epoch as the seat it replaced.
      const mgrRow = after.find((r) => r.assignee_id === MGR && r.is_active)!
      expect(mgrRow).toBeDefined()
      expect(mgrRow.node_key).toBe(uBefore.node_key)
      expect(mgrRow.entry_epoch).toBe(uBefore.entry_epoch)
      expect(mgrRow.metadata).toMatchObject({ departureTransfer: true, reassignedFrom: U })

      // Control: OTHER's seat (same node, same run) is byte-identical — untouched.
      const otherRowAfter = after.find((r) => r.id === otherBefore.id)!
      expect(otherRowAfter.is_active).toBe(true)
      expect(otherRowAfter.assignee_id).toBe(OTHER)
      expect(otherRowAfter.entry_epoch).toBe(otherBefore.entry_epoch)

      // "same epoch": node_activation_seq NEVER bumped by the departure transfer.
      const instAfter = (
        await pool.query<{ node_activation_seq: number; version: number }>(
          `SELECT node_activation_seq, version FROM approval_instances WHERE id = $1`,
          [instanceId],
        )
      ).rows[0]
      expect(Number(instAfter.node_activation_seq)).toBe(Number(instBefore.node_activation_seq))
      expect(Number(instAfter.version)).toBe(Number(instBefore.version))

      // Audit row: sentinel actor, 'reassign' verb (NOT 'transfer' — see revoke-window hazard note).
      const audit = (
        await pool.query<RecordRow>(
          `SELECT action, actor_id, actor_name, from_status, to_status, from_version, to_version, metadata, target_user_id
             FROM approval_records WHERE instance_id = $1 AND action = 'reassign' ORDER BY created_at DESC LIMIT 1`,
          [instanceId],
        )
      ).rows[0]
      expect(audit).toBeDefined()
      expect(audit.actor_id).toBe('system:approval-departure')
      expect(audit.actor_name).toBe('system:approval-departure')
      expect(audit.target_user_id).toBe(MGR)
      expect(audit.metadata).toMatchObject({ departureTransfer: true, outcome: 'transferred', fromUserId: U, toUserId: MGR })
    },
  )

  it(
    "E-2 'F4-E fail-closed': with no manager resolvable the assignment is UNCHANGED; no approval, rejection, or drop occurs | " +
      'the resolvable case in the same fixture DOES transfer',
    async () => {
      const keyNoMgr = `dep-e2-nomgr-${TS}`
      const keyResolvable = `dep-e2-resolvable-${TS}`
      templateKeys.push(keyNoMgr, keyResolvable)
      const instanceNoMgr = await createPublishedInstance(service, keyNoMgr, [NOMGR])
      const instanceResolvable = await createPublishedInstance(service, keyResolvable, [U2])

      const noMgrSeatBefore = (
        await pool.query<AssignmentRow>(
          `SELECT id, assignee_id, node_key, is_active, entry_epoch, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceNoMgr],
        )
      ).rows[0]
      const instNoMgrBefore = (
        await pool.query<{ status: string; version: number }>(`SELECT status, version FROM approval_instances WHERE id = $1`, [instanceNoMgr])
      ).rows[0]

      // Negative: NOMGR has zero directory linkage → no manager resolvable → fail-closed.
      const resultNoMgr = await service.applyApprovalDepartureTransfer(NOMGR)
      expect(resultNoMgr.noManagerResolved).toContain(instanceNoMgr)
      expect(resultNoMgr.transferred).not.toContain(instanceNoMgr)

      const noMgrSeatAfter = (
        await pool.query<AssignmentRow>(`SELECT id, assignee_id, is_active FROM approval_assignments WHERE id = $1`, [noMgrSeatBefore.id])
      ).rows[0]
      // UNCHANGED: same active row, same assignee, no approval/rejection/drop.
      expect(noMgrSeatAfter.is_active).toBe(true)
      expect(noMgrSeatAfter.assignee_id).toBe(NOMGR)
      const instNoMgrAfter = (
        await pool.query<{ status: string; version: number }>(`SELECT status, version FROM approval_instances WHERE id = $1`, [instanceNoMgr])
      ).rows[0]
      expect(instNoMgrAfter.status).toBe(instNoMgrBefore.status)
      expect(Number(instNoMgrAfter.version)).toBe(Number(instNoMgrBefore.version))

      // The fail-closed outcome is itself audited + warned, never silent.
      const noMgrAudit = (
        await pool.query<RecordRow>(
          `SELECT action, actor_id, from_status, to_status, from_version, to_version, metadata
             FROM approval_records WHERE instance_id = $1 AND action = 'reassign' ORDER BY created_at DESC LIMIT 1`,
          [instanceNoMgr],
        )
      ).rows[0]
      expect(noMgrAudit).toBeDefined()
      expect(noMgrAudit.actor_id).toBe('system:approval-departure')
      expect(noMgrAudit.from_status).toBe(noMgrAudit.to_status)
      expect(Number(noMgrAudit.from_version)).toBe(Number(noMgrAudit.to_version))
      expect(noMgrAudit.metadata).toMatchObject({ departureTransfer: true, outcome: 'no_manager_resolved', fromUserId: NOMGR })

      // Positive control (SAME fixture/run): U2 DOES resolve (same manager MGR as E-1) → DOES transfer.
      const resultResolvable = await service.applyApprovalDepartureTransfer(U2)
      expect(resultResolvable.transferred).toContain(instanceResolvable)
      const resolvedSeat = (
        await pool.query<AssignmentRow>(
          `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceResolvable],
        )
      ).rows[0]
      expect(resolvedSeat.assignee_id).toBe(MGR)
    },
  )

  it(
    "E-3 'F4-E delegation': a seat already substituted by delegation is not transferred again on the delegator's departure | " +
      "the delegatee's OWN departure does transfer that seat",
    async () => {
      const key = `dep-e3-${TS}`
      templateKeys.push(key)
      const instanceId = await createPublishedInstance(service, key, [DELEGATOR])

      // Bake→resolve substituted the seat to DELEGATEE (delegation frozen at create).
      const seatAfterCreate = (
        await pool.query<AssignmentRow>(
          `SELECT assignee_id, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceId],
        )
      ).rows[0]
      expect(seatAfterCreate.assignee_id).toBe(DELEGATEE)
      expect(seatAfterCreate.metadata).toMatchObject({ delegatedFrom: DELEGATOR })

      // Negative half: the DELEGATOR's departure must NOT move this seat — it is not the delegator's
      // seat anymore (assignee_id is DELEGATEE, not DELEGATOR) — asserted on the seat's CURRENT
      // assignee, not the departed id.
      const resultDelegatorDeparture = await service.applyApprovalDepartureTransfer(DELEGATOR)
      expect(resultDelegatorDeparture.transferred).not.toContain(instanceId)
      expect(resultDelegatorDeparture.noManagerResolved).not.toContain(instanceId)
      const seatAfterDelegatorDeparture = (
        await pool.query<AssignmentRow>(
          `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceId],
        )
      ).rows[0]
      expect(seatAfterDelegatorDeparture.assignee_id).toBe(DELEGATEE)
      expect(seatAfterDelegatorDeparture.is_active).toBe(true)

      // Positive half: the DELEGATEE's OWN departure DOES transfer that seat (to DELEGATEE's manager).
      const resultDelegateeDeparture = await service.applyApprovalDepartureTransfer(DELEGATEE)
      expect(resultDelegateeDeparture.transferred).toContain(instanceId)
      const seatAfterDelegateeDeparture = (
        await pool.query<AssignmentRow>(
          `SELECT assignee_id, is_active, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceId],
        )
      ).rows[0]
      expect(seatAfterDelegateeDeparture.assignee_id).toBe(DELEGATEE_MGR)
      expect(seatAfterDelegateeDeparture.metadata).toMatchObject({ departureTransfer: true, reassignedFrom: DELEGATEE })

      const delegateeAudit = (
        await pool.query<RecordRow>(
          `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'reassign' ORDER BY created_at DESC LIMIT 1`,
          [instanceId],
        )
      ).rows[0]
      expect(delegateeAudit.metadata).toMatchObject({ outcome: 'transferred', fromUserId: DELEGATEE, toUserId: DELEGATEE_MGR })
    },
  )

  it(
    'P26: an attendance-central instance is skipped, not moved — the departed user\'s seat on it is byte-identical after the call, ' +
      "and a genuinely non-attendance instance in the SAME run for the SAME user DOES transfer",
    async () => {
      const keyAttendance = `dep-p26-attendance-${TS}`
      const keyPlatform = `dep-p26-platform-${TS}`
      templateKeys.push(keyAttendance, keyPlatform)
      const attendanceInstanceId = await createPublishedInstance(service, keyAttendance, [U4])
      const platformInstanceId = await createPublishedInstance(service, keyPlatform, [U4])

      // Mark ONLY the first instance attendance-central, mirroring the sole classification signal
      // `classifyAndLockAttendanceRequestForInstance` reads (workflow_key === 'attendance.request')
      // — no attendance_requests row is needed for the classification itself to fire.
      await pool.query(`UPDATE approval_instances SET workflow_key = 'attendance.request' WHERE id = $1`, [attendanceInstanceId])

      const attendanceSeatBefore = (
        await pool.query<AssignmentRow>(`SELECT id, assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`, [attendanceInstanceId])
      ).rows[0]

      const result = await service.applyApprovalDepartureTransfer(U4)

      // Negative: the attendance-central instance is neither transferred nor silently no-manager'd
      // — it is a DISTINCT skip reason, and the seat is UNCHANGED.
      expect(result.transferred).not.toContain(attendanceInstanceId)
      expect(result.noManagerResolved).not.toContain(attendanceInstanceId)
      expect(result.skipped).toContainEqual({ id: attendanceInstanceId, reason: 'attendance-central-unsupported' })
      const attendanceSeatAfter = (
        await pool.query<AssignmentRow>(`SELECT id, assignee_id, is_active FROM approval_assignments WHERE id = $1`, [attendanceSeatBefore.id])
      ).rows[0]
      expect(attendanceSeatAfter).toEqual(attendanceSeatBefore)
      // No 'reassign' audit row (the ROLLBACK inside the P26 guard discards any partial write) — the
      // instance still carries only its original 'created' row from createApproval.
      const attendanceReassignCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_records WHERE instance_id = $1 AND action = 'reassign'`,
        [attendanceInstanceId],
      )
      expect(Number(attendanceReassignCount.rows[0].count)).toBe(0)

      // Positive control (SAME run, SAME departed user): the genuinely non-attendance instance DOES transfer.
      expect(result.transferred).toContain(platformInstanceId)
      const platformSeat = (
        await pool.query<AssignmentRow>(`SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`, [platformInstanceId])
      ).rows[0]
      expect(platformSeat.assignee_id).toBe(MGR)
    },
  )

  it(
    "self-approval guard: the resolved manager is skipped (not seated) when they are ALSO the instance's own requester, " +
      'mirroring bulkReassignApprovals target-is-requester',
    async () => {
      const key = `dep-self-approve-${TS}`
      templateKeys.push(key)
      // MGR (U5's manager) is the REQUESTER of this specific instance.
      const instanceId = await createPublishedInstance(service, key, [U5], MGR)

      const seatBefore = (
        await pool.query<AssignmentRow>(`SELECT id, assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`, [instanceId])
      ).rows[0]

      const result = await service.applyApprovalDepartureTransfer(U5)
      expect(result.transferred).not.toContain(instanceId)
      expect(result.noManagerResolved).not.toContain(instanceId)
      expect(result.skipped).toContainEqual({ id: instanceId, reason: 'target-is-requester' })

      const seatAfter = (
        await pool.query<AssignmentRow>(`SELECT id, assignee_id, is_active FROM approval_assignments WHERE id = $1`, [seatBefore.id])
      ).rows[0]
      expect(seatAfter).toEqual(seatBefore)
    },
  )

  it(
    'concurrency (constructed, not argued): a departure racing a concurrent decide on the same seat resolves via the ' +
      "instance FOR UPDATE lock — the blocked decide re-reads post-transfer state and is rejected as not-assigned, and exactly one reassign audit row exists (no double-move)",
    async () => {
      const key = `dep-race-${TS}`
      templateKeys.push(key)
      const instanceId = await createPublishedInstance(service, key, [U3])

      let releaseBarrier: () => void = () => {}
      let resolveBarrierHit: () => void = () => {}
      const barrierHit = new Promise<void>((resolve) => {
        resolveBarrierHit = resolve
      })
      const barrierGate = new Promise<void>((resolve) => {
        releaseBarrier = resolve
      })
      __setApprovalDepartureTransferTestBarrierForTests(async (point, info) => {
        if (point === 'after_instance_lock' && info.instanceId === instanceId) {
          resolveBarrierHit()
          await barrierGate
        }
      })

      try {
        // Start the departure transfer — it acquires the instance FOR UPDATE lock, then pauses at
        // the barrier (still holding the lock, not yet committed).
        const departurePromise = service.applyApprovalDepartureTransfer(U3)
        await barrierHit

        // Start a concurrent decide by the SAME (still-active-as-of-this-instant) assignee. This
        // issues its own `SELECT ... FOR UPDATE` on the instance row and REAL-blocks in Postgres
        // (not simulated) until the departure txn above commits or rolls back.
        const decidePromise = service.dispatchAction(instanceId, { action: 'approve' }, { userId: U3, userName: U3 })

        // Prove REAL blocking, not merely "not yet awaited": race decidePromise against a timer
        // WHILE the departure txn still holds the instance FOR UPDATE lock (barrier not yet
        // released). If Postgres were not serialising these two writers, decidePromise would settle
        // before the timer and this assertion would flip — this is the assertion that dies if the
        // lock stops doing its job, unlike asserting only the post-release outcome below.
        const STILL_BLOCKED = Symbol('still-blocked')
        const raceOutcome = await Promise.race([
          decidePromise.then(
            () => 'settled' as const,
            () => 'settled' as const,
          ),
          new Promise<typeof STILL_BLOCKED>((resolve) => setTimeout(() => resolve(STILL_BLOCKED), 300)),
        ])
        expect(raceOutcome).toBe(STILL_BLOCKED)

        releaseBarrier()
        const [departureOutcome, decideOutcome] = await Promise.allSettled([departurePromise, decidePromise])

        expect(departureOutcome.status).toBe('fulfilled')
        if (departureOutcome.status === 'fulfilled') {
          expect(departureOutcome.value.transferred).toContain(instanceId)
        }

        // The decide call — unblocked only AFTER the departure committed — re-reads current state
        // and finds U3 no longer an active assignee: rejected, not a lost/duplicated decision.
        expect(decideOutcome.status).toBe('rejected')
        if (decideOutcome.status === 'rejected') {
          expect(decideOutcome.reason).toBeInstanceOf(ServiceError)
          expect((decideOutcome.reason as ServiceError).code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
        }

        // No double-move: exactly one reassign audit row for this instance.
        const auditCount = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM approval_records WHERE instance_id = $1 AND action = 'reassign'`,
          [instanceId],
        )
        expect(Number(auditCount.rows[0].count)).toBe(1)

        // The node's active seat is the resolved manager exactly once (not U3, not double-approved).
        const finalSeats = (
          await pool.query<AssignmentRow>(`SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`, [instanceId])
        ).rows
        expect(finalSeats).toHaveLength(1)
        expect(finalSeats[0].assignee_id).toBe(MGR)
      } finally {
        __setApprovalDepartureTransferTestBarrierForTests(null)
      }
    },
  )
})
