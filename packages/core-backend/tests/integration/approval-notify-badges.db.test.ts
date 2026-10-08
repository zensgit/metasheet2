import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { IPLMAdapter } from '../../src/di/identifiers'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * Test report 2026-10-08 — the approval center's tab read-state badges, on real PostgreSQL.
 *
 * T3 (抄送我的): `GET /api/approvals/cc-unread-count` + the list's per-row `ccUnread`, behind
 * APPROVAL_CC_UNREAD_BADGE_ENABLED (default OFF, exact 'true').
 * T6 (我发起的): `GET /api/approvals/mine-outcomes/unseen-count` + the list's per-row
 * `outcomeUnseen`, behind APPROVAL_MINE_OUTCOME_BADGE_ENABLED (default OFF, exact 'true').
 *
 * WHAT IS GATED, and the mutation each case exists to catch:
 *   - the unread RULE is a time comparison against the newest CC row, not "has a read row":
 *     opened-before-being-CC'd ⇒ still unread; re-CC'd after a read ⇒ unread again
 *     (drop the `read_at >= MAX(occurred_at)` comparison ⇒ red);
 *   - the read row is the VIEWER's: another person's later read leaves it unread
 *     (drop `cc_read.user_id = $n` ⇒ red);
 *   - count == the rows the 抄送我的 list marks `ccUnread`, and ≤ that list's total, for EACH
 *     `sourceSystem` value (a count that read `sourceSystem` differently from the list ⇒ red);
 *   - role-typed CC: counted for the role holder the list shows it to, not for a token-only or a
 *     user_roles-only holder the list does not show it to — and CLEARED once that holder opens it:
 *     the role arm decides "read" on the count AND on the row (a count or a row annotation that
 *     matched user-typed CC rows only would never clear it ⇒ red);
 *   - todo-center lock B: a viewer who is ONLY a CC target has `/pending-count` {0,0} and
 *     `/api/todo/count` 0 while their CC count is positive (fold a CC arm into the pending query ⇒
 *     red); this is the class the lock's A0 fixtures do not contain;
 *   - switch OFF: 404 with the feature's own code, and list rows carry no `ccUnread` key.
 *   - T6: the outcome is the newest audit row that moved the request INTO its current terminal
 *     status — self-decided outcomes (own revoke, own approval followed by the system `sign` row
 *     or by an auto-approval row repeating the status, own cancellation after someone else's
 *     approval) are not badged (drop "actor ≠ viewer", the `sign` exclusion or
 *     `from_status IS DISTINCT FROM to_status` ⇒ red); a later comment does not re-light a seen
 *     outcome; opened-while-pending is still unseen (drop the time comparison ⇒ red); another
 *     person's read does not count (drop the user test ⇒ red); a timeout jump and a terminal
 *     return (which emits no completion event) are badged. Two shape guards no production writer
 *     exercises today are pinned with synthetic rows: a request still in review whose latest entry
 *     into pending was written by someone else is not counted (drop the terminal-status test ⇒
 *     red); a terminal request whose current status no audit row explains — a PLM sync after a
 *     bridge decision — is not counted (drop `to_status = status` ⇒ red).
 *   - each per-row flag stays on its own tab: with both switches on, 待我处理 rows carry neither
 *     key, 抄送我的 rows no `outcomeUnseen`, 我发起的 rows no `ccUnread` (drop either annotation's
 *     tab test ⇒ red).
 *
 * FIXTURE DISCIPLINE. Every id is suffixed per run and every identity's role claim is unique, so
 * the shared integration database's other rows cannot reach these counts. Timestamps are written
 * explicitly (minutes in the past) so no case depends on wall-clock ordering inside the test.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Anti-skip-green sentinel: the evidence lane sets EXPECT_DB=1, so a missing/broken DATABASE_URL
// there REDS the run instead of reporting the whole file as silently skipped-green.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

type ListRow = { id: string; ccUnread?: boolean }
type ListResponse = { data: ListRow[]; total: number }

describeIfDatabase('test report 2026-10-08 — tab read-state badges (real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const ccSwitchBeforeSuite = process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED

  const suffix = randomUUID().slice(0, 8)
  const ccRole = `nb-ccrole-${suffix}`
  const viewerId = `nb-viewer-${suffix}`
  const otherId = `nb-other-${suffix}`
  const requesterId = `nb-requester-${suffix}`
  const approverId = `nb-approver-${suffix}`
  const roleHolderId = `nb-roleholder-${suffix}`
  const claimOnlyHolderId = `nb-claimonly-${suffix}`
  const userRolesOnlyHolderId = `nb-urolesonly-${suffix}`
  const ccOnlyId = `nb-cconly-${suffix}`
  // T6: the requester whose own requests are counted, and the people who decide them.
  const requester2Id = `nb-requester2-${suffix}`
  const deciderId = `nb-decider-${suffix}`
  // A role claim nobody seats or CCs: identities that must not hold any role-typed match carry it.
  const inertRole = `nb-inert-${suffix}`
  // The cc-only identity's own role (users.role AND its token claim), targeted by one role-typed CC.
  const ccOnlyRole = `nb-cconlyrole-${suffix}`

  const ids = {
    fresh: `nb_cc_fresh_${suffix}`,
    openedAfter: `nb_cc_opened_after_${suffix}`,
    openedBefore: `nb_cc_opened_before_${suffix}`,
    otherRead: `nb_cc_other_read_${suffix}`,
    toOther: `nb_cc_to_other_${suffix}`,
    reCc: `nb_cc_recc_${suffix}`,
    role: `nb_cc_role_${suffix}`,
    plm: `plm:nb_cc_plm_${suffix}`,
    ccOnlyUser: `nb_cc_only_user_${suffix}`,
    ccOnlyRole: `nb_cc_only_role_${suffix}`,
  }
  const outcomeIds = {
    rejectedNew: `nb_out_rejected_new_${suffix}`,
    approvedSeen: `nb_out_approved_seen_${suffix}`,
    openedWhilePending: `nb_out_opened_pending_${suffix}`,
    selfRevoked: `nb_out_self_revoked_${suffix}`,
    selfApprovedWithSign: `nb_out_self_approved_${suffix}`,
    selfApprovedThenAuto: `nb_out_self_approved_auto_${suffix}`,
    timeoutJump: `nb_out_timeout_jump_${suffix}`,
    stillPending: `nb_out_pending_${suffix}`,
    notMine: `nb_out_not_mine_${suffix}`,
    otherRead: `nb_out_other_read_${suffix}`,
    selfCancelledAfterApproval: `nb_out_self_cancelled_${suffix}`,
    terminalReturn: `nb_out_terminal_return_${suffix}`,
    laterComment: `nb_out_later_comment_${suffix}`,
    plm: `plm:nb_out_plm_${suffix}`,
    pendingEnteredByOther: `nb_out_pending_by_other_${suffix}`,
    plmStatusResynced: `plm:nb_out_plm_resynced_${suffix}`,
  }
  const seededInstanceIds = [...Object.values(ids), ...Object.values(outcomeIds)]
  const seededUserIds = [
    viewerId, otherId, requesterId, approverId, roleHolderId, claimOnlyHolderId, userRolesOnlyHolderId, ccOnlyId,
    requester2Id, deciderId,
  ]
  const outcomeSwitchBeforeSuite = process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED

  async function seedUser(userId: string, role: string): Promise<void> {
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', $2, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, is_admin = FALSE`,
      [userId, role],
    )
  }

  async function seedInstance(id: string, status: string, sourceSystem = 'platform', requester = requesterId): Promise<void> {
    await pool().query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 'ok', now(), now())`,
      [
        id,
        status,
        sourceSystem,
        `nb-wf-${suffix}`,
        `nb:${id}`,
        `NB ${id}`,
        JSON.stringify({ id: requester, name: requester }),
      ],
    )
  }

  /** One audit row, `minutesAgo` in the past — a decision, a bookkeeping row or a comment. */
  async function seedRecord(
    instanceId: string,
    action: string,
    actorId: string,
    fromStatus: string | null,
    toStatus: string,
    minutesAgo: number,
  ): Promise<void> {
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, metadata, occurred_at)
       VALUES ($1, $2, $3, $3, $4, $5, '{}'::jsonb, now() - ($6::text || ' minutes')::interval)`,
      [instanceId, action, actorId, fromStatus, toStatus, String(minutesAgo)],
    )
  }

  async function seedSeat(instanceId: string, assigneeId: string): Promise<void> {
    await pool().query(
      `INSERT INTO approval_assignments
         (id, instance_id, assignment_type, assignee_id, source_step, is_active, metadata, created_at, updated_at)
       VALUES ($1, $2, 'user', $3, 0, TRUE, '{}'::jsonb, now(), now())`,
      [randomUUID(), instanceId, assigneeId],
    )
  }

  /** A CC row written the way the graph executor's CC node writes it, `minutesAgo` in the past. */
  async function seedCc(instanceId: string, targetType: 'user' | 'role', targetId: string, minutesAgo: number): Promise<void> {
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, metadata, occurred_at)
       VALUES ($1, 'cc', 'system', 'System', 'pending', 'pending', $2::jsonb, now() - ($3::text || ' minutes')::interval)`,
      [instanceId, JSON.stringify({ nodeKey: 'cc_node', targetType, targetId }), String(minutesAgo)],
    )
  }

  async function seedRead(userId: string, instanceId: string, minutesAgo: number): Promise<void> {
    await pool().query(
      `INSERT INTO approval_reads (user_id, instance_id, read_at)
       VALUES ($1, $2, now() - ($3::text || ' minutes')::interval)
       ON CONFLICT (user_id, instance_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
      [userId, instanceId, String(minutesAgo)],
    )
  }

  async function token(userId: string, roles: string): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent('*:*')}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function getJson(path: string, bearer: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${bearer}` } })
    return { status: response.status, body: await response.json() }
  }

  async function ccUnreadCount(bearer: string, sourceSystem = 'all'): Promise<number> {
    const { status, body } = await getJson(`/api/approvals/cc-unread-count?sourceSystem=${sourceSystem}`, bearer)
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['count'])
    return body.count as number
  }

  /** This suite's own rows of the 抄送我的 feed (the shared DB carries other suites' rows). */
  async function ccTab(bearer: string, sourceSystem = 'all'): Promise<{ rows: ListRow[]; total: number }> {
    const { status, body } = await getJson(`/api/approvals?tab=cc&sourceSystem=${sourceSystem}&limit=200`, bearer)
    expect(status).toBe(200)
    const payload = body as ListResponse
    return { rows: payload.data.filter((row) => seededInstanceIds.includes(row.id)), total: payload.total }
  }

  async function outcomeCount(bearer: string, sourceSystem = 'all'): Promise<number> {
    const { status, body } = await getJson(`/api/approvals/mine-outcomes/unseen-count?sourceSystem=${sourceSystem}`, bearer)
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['count'])
    return body.count as number
  }

  /** This suite's own rows of the 我发起的 feed. */
  async function mineTab(bearer: string, sourceSystem = 'all'): Promise<{ rows: Array<{ id: string; outcomeUnseen?: boolean }>; total: number }> {
    const { status, body } = await getJson(`/api/approvals?tab=mine&sourceSystem=${sourceSystem}&limit=200`, bearer)
    expect(status).toBe(200)
    const payload = body as { data: Array<{ id: string; outcomeUnseen?: boolean }>; total: number }
    return { rows: payload.data.filter((row) => seededInstanceIds.includes(row.id)), total: payload.total }
  }

  /** This suite's own rows of any tab's feed, with every key exactly as the server sent it. */
  async function feedRows(bearer: string, tab: string, sourceSystem = 'all'): Promise<Array<{ id: string } & Record<string, unknown>>> {
    const { status, body } = await getJson(`/api/approvals?tab=${tab}&sourceSystem=${sourceSystem}&limit=200`, bearer)
    expect(status).toBe(200)
    const payload = body as { data: Array<{ id: string } & Record<string, unknown>> }
    return payload.data.filter((row) => seededInstanceIds.includes(row.id))
  }

  async function markRead(bearer: string, instanceId: string): Promise<number> {
    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}/mark-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    return response.status
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()

    for (const id of [viewerId, otherId, requesterId, approverId, claimOnlyHolderId, ccOnlyId, requester2Id, deciderId]) {
      await seedUser(id, 'viewer')
    }
    // Production shape of "holds the role": `users.role` is what both the request's role set and
    // the list scope's DB role set carry for an ordinary login.
    await seedUser(roleHolderId, ccRole)
    // Holds the role ONLY through a `user_roles` row: the scope sees it, the tab filter (request
    // roles) does not — the list does not show the row, so the count must not count it.
    await seedUser(userRolesOnlyHolderId, 'viewer')
    await pool().query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userRolesOnlyHolderId, ccRole],
    )

    // fresh — CC'd 10 min ago, never opened ⇒ unread.
    await seedInstance(ids.fresh, 'pending')
    await seedCc(ids.fresh, 'user', viewerId, 10)
    // openedAfter — CC'd 10 min ago, opened 5 min ago ⇒ read.
    await seedInstance(ids.openedAfter, 'pending')
    await seedCc(ids.openedAfter, 'user', viewerId, 10)
    await seedRead(viewerId, ids.openedAfter, 5)
    // openedBefore — opened 20 min ago (e.g. as approver), CC'd 10 min ago ⇒ unread.
    await seedInstance(ids.openedBefore, 'pending')
    await seedRead(viewerId, ids.openedBefore, 20)
    await seedCc(ids.openedBefore, 'user', viewerId, 10)
    // otherRead — CC'd 10 min ago; SOMEONE ELSE read it 5 min ago ⇒ still unread for the viewer.
    await seedInstance(ids.otherRead, 'approved')
    await seedCc(ids.otherRead, 'user', viewerId, 10)
    await seedRead(otherId, ids.otherRead, 5)
    // toOther — CC'd to someone else only ⇒ not in the viewer's feed at all.
    await seedInstance(ids.toOther, 'pending')
    await seedCc(ids.toOther, 'user', otherId, 10)
    // reCc — CC'd 30 min ago, opened 20 min ago, CC'd AGAIN 10 min ago ⇒ unread.
    await seedInstance(ids.reCc, 'pending')
    await seedCc(ids.reCc, 'user', viewerId, 30)
    await seedRead(viewerId, ids.reCc, 20)
    await seedCc(ids.reCc, 'user', viewerId, 10)
    // role — role-typed CC to `ccRole`.
    await seedInstance(ids.role, 'pending')
    await seedCc(ids.role, 'role', ccRole, 10)
    // plm — a non-platform mirror carrying a user CC to the viewer: present under `all` and `plm`,
    // absent under `platform` — the source mapping's own discriminator.
    await seedInstance(ids.plm, 'pending', 'plm')
    await seedCc(ids.plm, 'user', viewerId, 10)
    // lock B witnesses: ONLY CC rows for the cc-only identity — one user-typed, one role-typed (to
    // the role it holds both as `users.role` and as its claim) — and no seat of its own. Each
    // instance carries an ACTIVE seat for SOMEONE ELSE, as a real pending instance does: without it
    // the pending query's seat join would yield no row at all, and a CC arm wrongly folded into that
    // query could not show up in the counts this case asserts.
    await seedInstance(ids.ccOnlyUser, 'pending')
    await seedSeat(ids.ccOnlyUser, approverId)
    await seedCc(ids.ccOnlyUser, 'user', ccOnlyId, 10)
    await seedInstance(ids.ccOnlyRole, 'pending')
    await seedSeat(ids.ccOnlyRole, approverId)
    await seedCc(ids.ccOnlyRole, 'role', ccOnlyRole, 10)
    await seedUser(ccOnlyId, ccOnlyRole)

    // ---- T6 fixtures: requests of `requester2Id`. ----
    // rejectedNew — rejected by the decider 10 min ago, never opened since ⇒ new.
    await seedInstance(outcomeIds.rejectedNew, 'rejected', 'platform', requester2Id)
    await seedRecord(outcomeIds.rejectedNew, 'created', requester2Id, null, 'pending', 30)
    await seedRecord(outcomeIds.rejectedNew, 'reject', deciderId, 'pending', 'rejected', 10)
    // approvedSeen — approved 10 min ago, opened 5 min ago ⇒ seen.
    await seedInstance(outcomeIds.approvedSeen, 'approved', 'platform', requester2Id)
    await seedRecord(outcomeIds.approvedSeen, 'approve', deciderId, 'pending', 'approved', 10)
    await seedRead(requester2Id, outcomeIds.approvedSeen, 5)
    // openedWhilePending — opened 20 min ago while pending, rejected 10 min ago ⇒ new.
    await seedInstance(outcomeIds.openedWhilePending, 'rejected', 'platform', requester2Id)
    await seedRead(requester2Id, outcomeIds.openedWhilePending, 20)
    await seedRecord(outcomeIds.openedWhilePending, 'reject', deciderId, 'pending', 'rejected', 10)
    // selfRevoked — the requester withdrew it ⇒ not news to them.
    await seedInstance(outcomeIds.selfRevoked, 'revoked', 'platform', requester2Id)
    await seedRecord(outcomeIds.selfRevoked, 'revoke', requester2Id, 'pending', 'revoked', 10)
    // selfApprovedWithSign — the requester approved the final node themselves; the system's
    // aggregate-cancellation `sign` row follows in the same transaction (same time, higher id) ⇒
    // not news. Without the `sign` exclusion the outcome would read as decided by `system`.
    await seedInstance(outcomeIds.selfApprovedWithSign, 'approved', 'platform', requester2Id)
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, metadata, occurred_at)
       VALUES ($1, 'approve', $2, $2, 'pending', 'approved', '{}'::jsonb, now() - interval '10 minutes'),
              ($1, 'sign', 'system', 'System', 'pending', 'approved', '{"autoCancelled":true}'::jsonb, now() - interval '10 minutes')`,
      [outcomeIds.selfApprovedWithSign, requester2Id],
    )
    // selfApprovedThenAuto — the requester approved a node themselves and a following auto-approval
    // node wrote its own `approve` row in the same transaction, REPEATING the final status
    // (from = to = approved, actor `system`, same time, higher id) ⇒ not news. Only the
    // `from_status IS DISTINCT FROM to_status` test keeps that repeat from being read as the outcome.
    await seedInstance(outcomeIds.selfApprovedThenAuto, 'approved', 'platform', requester2Id)
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, metadata, occurred_at)
       VALUES ($1, 'approve', $2, $2, 'pending', 'approved', '{}'::jsonb, now() - interval '10 minutes'),
              ($1, 'approve', 'system', 'System', 'approved', 'approved', '{"autoApproved":true}'::jsonb, now() - interval '10 minutes')`,
      [outcomeIds.selfApprovedThenAuto, requester2Id],
    )
    // timeoutJump — the scheduler's timeout effect moved it to approved ⇒ new.
    await seedInstance(outcomeIds.timeoutJump, 'approved', 'platform', requester2Id)
    await seedRecord(outcomeIds.timeoutJump, 'jump', 'system:approval-timeout', 'pending', 'approved', 10)
    // stillPending — not finished ⇒ never counted (but listed in 我发起的).
    await seedInstance(outcomeIds.stillPending, 'pending', 'platform', requester2Id)
    await seedRecord(outcomeIds.stillPending, 'created', requester2Id, null, 'pending', 10)
    // notMine — someone else's request the requester2 decided ⇒ not in 我发起的 at all.
    await seedInstance(outcomeIds.notMine, 'rejected', 'platform', requesterId)
    await seedRecord(outcomeIds.notMine, 'reject', requester2Id, 'pending', 'rejected', 10)
    // otherRead — rejected 10 min ago; someone ELSE opened it 5 min ago ⇒ still new.
    await seedInstance(outcomeIds.otherRead, 'rejected', 'platform', requester2Id)
    await seedRecord(outcomeIds.otherRead, 'reject', deciderId, 'pending', 'rejected', 10)
    await seedRead(otherId, outcomeIds.otherRead, 5)
    // selfCancelledAfterApproval — approved by the decider 20 min ago, then the requester's own
    // cancellation moved it approved → cancelled 10 min ago: the outcome is the cancellation, theirs.
    await seedInstance(outcomeIds.selfCancelledAfterApproval, 'cancelled', 'platform', requester2Id)
    await seedRecord(outcomeIds.selfCancelledAfterApproval, 'approve', deciderId, 'pending', 'approved', 20)
    await seedRecord(outcomeIds.selfCancelledAfterApproval, 'revoke', requester2Id, 'approved', 'cancelled', 10)
    // terminalReturn — a return that ended the flow as rejected (that path emits no completion
    // event; the audit row is enough) ⇒ new.
    await seedInstance(outcomeIds.terminalReturn, 'rejected', 'platform', requester2Id)
    await seedRecord(outcomeIds.terminalReturn, 'return', deciderId, 'pending', 'rejected', 10)
    // laterComment — rejected 20 min ago, opened 15 min ago, then someone commented 10 min ago
    // (a comment repeats the status) ⇒ seen: a comment is not a new outcome.
    await seedInstance(outcomeIds.laterComment, 'rejected', 'platform', requester2Id)
    await seedRecord(outcomeIds.laterComment, 'reject', deciderId, 'pending', 'rejected', 20)
    await seedRead(requester2Id, outcomeIds.laterComment, 15)
    await seedRecord(outcomeIds.laterComment, 'comment', deciderId, 'rejected', 'rejected', 10)
    // plm — a mirrored request of requester2 rejected through the bridge ⇒ new under `all` / `plm`.
    await seedInstance(outcomeIds.plm, 'rejected', 'plm', requester2Id)
    await seedRecord(outcomeIds.plm, 'reject', deciderId, 'pending', 'rejected', 10)
    // pendingEnteredByOther — STILL IN REVIEW, and the newest row that moved it INTO `pending` was
    // written by someone else (a submission on the requester's behalf). No production writer does
    // this today — the only entry into pending with from ≠ to is the requester's own `created` — so
    // this is a synthetic shape guard: only a TERMINAL current status is an outcome ⇒ not counted
    // (drop the terminal-status test ⇒ red).
    await seedInstance(outcomeIds.pendingEnteredByOther, 'pending', 'platform', requester2Id)
    await seedRecord(outcomeIds.pendingEnteredByOther, 'created', otherId, null, 'pending', 10)
    // plmStatusResynced — a PLM mirror the decider approved through the bridge 20 min ago (the
    // bridge writes an audit row; the requester never opened it since), whose status a later PLM
    // sync then moved to `rejected` — the mirror upsert writes NO audit row. The bridge row did not
    // bring the request into its CURRENT status, so it is not the outcome, and no row did ⇒ not
    // counted: the documented "no audit trail ⇒ never badged" (a decision taken inside PLM never
    // badges). Drop `to_status = status` ⇒ the stale bridge approval is read as the outcome ⇒ red.
    await seedInstance(outcomeIds.plmStatusResynced, 'rejected', 'plm', requester2Id)
    await seedRecord(outcomeIds.plmStatusResynced, 'approve', deciderId, 'pending', 'approved', 20)

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address && typeof address === 'object' ? address.port : undefined).toBeTruthy()
    baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`

    // `sourceSystem=plm` on the LIST needs a connected PLM adapter (mock mode: no PLM URL here, so
    // the route's force-sync is a no-op and the seeded `plm:` row is left untouched). The count
    // route never syncs and never needs it.
    const injector = (server as unknown as { injector?: { get: (id: unknown) => unknown } }).injector
    const plmAdapter = injector!.get(IPLMAdapter) as { connect?: () => Promise<void> }
    await plmAdapter.connect!()
  })

  afterEach(() => {
    if (ccSwitchBeforeSuite === undefined) delete process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED
    else process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = ccSwitchBeforeSuite
    if (outcomeSwitchBeforeSuite === undefined) delete process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED
    else process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = outcomeSwitchBeforeSuite
  })

  afterAll(async () => {
    try {
      await pool().query('DELETE FROM approval_reads WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [seededUserIds])
      await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
    } finally {
      await server?.stop()
    }
  })

  describe('T3 — 抄送我的 unread badge', () => {
    it('switch OFF: the count answers 404 with its own code and the 抄送我的 rows carry no ccUnread key', async () => {
      delete process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED
      const viewer = await token(viewerId, inertRole)
      const off = await getJson('/api/approvals/cc-unread-count?sourceSystem=all', viewer)
      expect(off.status).toBe(404)
      expect(off.body?.error?.code).toBe('APPROVAL_CC_UNREAD_BADGE_DISABLED')

      const { rows } = await ccTab(viewer)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(Object.prototype.hasOwnProperty.call(row, 'ccUnread')).toBe(false)
    })

    it('the rule: opened-before-CC and re-CC are unread, opened-after-CC is read, another person\'s read does not count', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      const viewer = await token(viewerId, inertRole)
      const { rows } = await ccTab(viewer)
      const verdict = Object.fromEntries(rows.map((row) => [row.id, row.ccUnread]))

      expect(verdict).toEqual({
        [ids.fresh]: true,
        [ids.openedAfter]: false,
        [ids.openedBefore]: true,
        [ids.otherRead]: true,
        [ids.reCc]: true,
        [ids.plm]: true,
      })
      expect(verdict[ids.toOther]).toBeUndefined()
      expect(await ccUnreadCount(viewer)).toBe(5)
    })

    it('count == the rows 抄送我的 marks unread, and ≤ its total, for every sourceSystem value', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      const viewer = await token(viewerId, inertRole)
      const expected: Record<string, { unread: number; rows: number }> = {
        all: { unread: 5, rows: 6 },
        platform: { unread: 4, rows: 5 },
        plm: { unread: 1, rows: 1 },
      }
      for (const [sourceSystem, want] of Object.entries(expected)) {
        const { rows, total } = await ccTab(viewer, sourceSystem)
        const count = await ccUnreadCount(viewer, sourceSystem)
        expect(rows.length, sourceSystem).toBe(want.rows)
        expect(rows.filter((row) => row.ccUnread === true).length, sourceSystem).toBe(count)
        expect(count, sourceSystem).toBe(want.unread)
        expect(count, sourceSystem).toBeLessThanOrEqual(total)
      }
    })

    it('opening an item through the real mark-read endpoint drops it from the count and flips its row', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      const viewer = await token(viewerId, inertRole)
      const before = await ccUnreadCount(viewer)

      expect(await markRead(viewer, ids.fresh)).toBe(200)

      expect(await ccUnreadCount(viewer)).toBe(before - 1)
      const { rows } = await ccTab(viewer)
      expect(rows.find((row) => row.id === ids.fresh)?.ccUnread).toBe(false)
      // restore the fixture for any later case
      await pool().query('DELETE FROM approval_reads WHERE user_id = $1 AND instance_id = $2', [viewerId, ids.fresh])
    })

    it('role-typed CC: counted for the holder the list shows it to; not for a token-only or a user_roles-only holder', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'

      const holder = await token(roleHolderId, ccRole)
      expect((await ccTab(holder)).rows.map((row) => row.id)).toEqual([ids.role])
      expect(await ccUnreadCount(holder)).toBe(1)

      // Claims the role in the token but no DB row backs it: the list scope (DB roles) hides the row.
      const claimOnly = await token(claimOnlyHolderId, ccRole)
      expect((await ccTab(claimOnly)).rows).toEqual([])
      expect(await ccUnreadCount(claimOnly)).toBe(0)

      // Holds it only through user_roles: the tab filter (request roles) does not match.
      const userRolesOnly = await token(userRolesOnlyHolderId, inertRole)
      expect((await ccTab(userRolesOnly)).rows).toEqual([])
      expect(await ccUnreadCount(userRolesOnly)).toBe(0)
    })

    it('role-typed CC: once the holder opens it through the real mark-read endpoint, the count AND the row clear', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      const holder = await token(roleHolderId, ccRole)

      // Before: unread on both sides.
      expect(await ccUnreadCount(holder)).toBe(1)
      expect((await ccTab(holder)).rows.find((row) => row.id === ids.role)?.ccUnread).toBe(true)

      // The ONLY CC row that targets the holder here is role-typed. The read must be compared with
      // THAT row's time on both sides: a count, or a per-row annotation, that matched user-typed CC
      // rows only would compare the read with no CC row at all (NULL) and keep the item unread
      // forever — the badge would never clear for a role-typed CC.
      try {
        expect(await markRead(holder, ids.role)).toBe(200)
        expect(await ccUnreadCount(holder)).toBe(0)
        expect((await ccTab(holder)).rows.find((row) => row.id === ids.role)?.ccUnread).toBe(false)
      } finally {
        await pool().query('DELETE FROM approval_reads WHERE user_id = $1 AND instance_id = $2', [roleHolderId, ids.role])
      }
    })

    it('lock B: a viewer who is ONLY a CC target has zero pending and zero todo, while their CC count is positive', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      const ccOnly = await token(ccOnlyId, ccOnlyRole)

      expect(await ccUnreadCount(ccOnly)).toBe(2)
      const pending = await getJson('/api/approvals/pending-count?sourceSystem=all', ccOnly)
      expect(pending.status).toBe(200)
      expect(pending.body).toEqual({ count: 0, unreadCount: 0 })
      const todo = await getJson('/api/todo/count', ccOnly)
      expect(todo.status).toBe(200)
      expect(todo.body?.count).toBe(0)
    })

    it('an unknown sourceSystem is a 400 in the shared envelope', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      const viewer = await token(viewerId, inertRole)
      const bad = await getJson('/api/approvals/cc-unread-count?sourceSystem=elsewhere', viewer)
      expect(bad.status).toBe(400)
      expect(bad.body?.error?.code).toBe('APPROVAL_SOURCE_SYSTEM_INVALID')
    })
  })

  describe('T6 — 我发起的 new-outcome badge', () => {
    it('switch OFF: the count answers 404 with its own code and the 我发起的 rows carry no outcomeUnseen key', async () => {
      delete process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED
      const requester2 = await token(requester2Id, inertRole)
      const off = await getJson('/api/approvals/mine-outcomes/unseen-count?sourceSystem=all', requester2)
      expect(off.status).toBe(404)
      expect(off.body?.error?.code).toBe('APPROVAL_MINE_OUTCOME_BADGE_DISABLED')

      const { rows } = await mineTab(requester2)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(Object.prototype.hasOwnProperty.call(row, 'outcomeUnseen')).toBe(false)
    })

    it('the rule: decided by someone else and not opened since ⇒ new; self-decided, seen, still pending, merely commented or unexplained by any audit row ⇒ not', async () => {
      process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = 'true'
      const requester2 = await token(requester2Id, inertRole)
      const { rows } = await mineTab(requester2)
      const verdict = Object.fromEntries(rows.map((row) => [row.id, row.outcomeUnseen]))

      expect(verdict).toEqual({
        [outcomeIds.rejectedNew]: true,
        [outcomeIds.approvedSeen]: false,
        [outcomeIds.openedWhilePending]: true,
        [outcomeIds.selfRevoked]: false,
        [outcomeIds.selfApprovedWithSign]: false,
        [outcomeIds.selfApprovedThenAuto]: false,
        [outcomeIds.timeoutJump]: true,
        [outcomeIds.stillPending]: false,
        [outcomeIds.otherRead]: true,
        [outcomeIds.selfCancelledAfterApproval]: false,
        [outcomeIds.terminalReturn]: true,
        [outcomeIds.laterComment]: false,
        [outcomeIds.plm]: true,
        [outcomeIds.pendingEnteredByOther]: false,
        [outcomeIds.plmStatusResynced]: false,
      })
      expect(verdict[outcomeIds.notMine]).toBeUndefined()
      expect(await outcomeCount(requester2)).toBe(6)
    })

    it('count == the rows 我发起的 marks new, and ≤ its total, for every sourceSystem value', async () => {
      process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = 'true'
      const requester2 = await token(requester2Id, inertRole)
      const expected: Record<string, { unseen: number; rows: number }> = {
        all: { unseen: 6, rows: 15 },
        platform: { unseen: 5, rows: 13 },
        plm: { unseen: 1, rows: 2 },
      }
      for (const [sourceSystem, want] of Object.entries(expected)) {
        const { rows, total } = await mineTab(requester2, sourceSystem)
        const count = await outcomeCount(requester2, sourceSystem)
        expect(rows.length, sourceSystem).toBe(want.rows)
        expect(rows.filter((row) => row.outcomeUnseen === true).length, sourceSystem).toBe(count)
        expect(count, sourceSystem).toBe(want.unseen)
        expect(count, sourceSystem).toBeLessThanOrEqual(total)
      }
    })

    it('opening the outcome through the real mark-read endpoint drops it from the count and flips its row', async () => {
      process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = 'true'
      const requester2 = await token(requester2Id, inertRole)
      const before = await outcomeCount(requester2)

      expect(await markRead(requester2, outcomeIds.rejectedNew)).toBe(200)

      expect(await outcomeCount(requester2)).toBe(before - 1)
      const { rows } = await mineTab(requester2)
      expect(rows.find((row) => row.id === outcomeIds.rejectedNew)?.outcomeUnseen).toBe(false)
      await pool().query('DELETE FROM approval_reads WHERE user_id = $1 AND instance_id = $2', [requester2Id, outcomeIds.rejectedNew])
    })

    it('the decider sees none of it: their own decisions on someone else\'s requests are not "my outcomes"', async () => {
      process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = 'true'
      const decider = await token(deciderId, inertRole)
      expect(await outcomeCount(decider)).toBe(0)
      expect((await mineTab(decider)).rows).toEqual([])
    })

    it('lock B: the outcome badge leaves the requester\'s pending and todo counts at zero', async () => {
      process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = 'true'
      const requester2 = await token(requester2Id, inertRole)
      expect(await outcomeCount(requester2)).toBeGreaterThan(0)
      const pending = await getJson('/api/approvals/pending-count?sourceSystem=all', requester2)
      expect(pending.body).toEqual({ count: 0, unreadCount: 0 })
      const todo = await getJson('/api/todo/count', requester2)
      expect(todo.body?.count).toBe(0)
    })
  })

  describe('both switches ON — each per-row flag stays on its own tab', () => {
    it('待我处理 rows carry neither flag, 抄送我的 rows no outcomeUnseen, 我发起的 rows no ccUnread', async () => {
      process.env.APPROVAL_CC_UNREAD_BADGE_ENABLED = 'true'
      process.env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED = 'true'
      const has = (row: object, key: string): boolean => Object.prototype.hasOwnProperty.call(row, key)

      // 待我处理: the approver's own active seats (the lock-B witnesses' instances). The list route
      // asks for both annotations whenever their switches are on; only the service's tab test keeps
      // them (and their extra queries) off this tab.
      const approver = await token(approverId, inertRole)
      const pendingRows = await feedRows(approver, 'pending')
      expect(pendingRows.map((row) => row.id)).toEqual(expect.arrayContaining([ids.ccOnlyUser, ids.ccOnlyRole]))
      for (const row of pendingRows) {
        expect(has(row, 'ccUnread'), row.id).toBe(false)
        expect(has(row, 'outcomeUnseen'), row.id).toBe(false)
      }

      // 抄送我的: its own flag on every row, never the 我发起的 one.
      const viewer = await token(viewerId, inertRole)
      const ccRows = await feedRows(viewer, 'cc')
      expect(ccRows.length).toBeGreaterThan(0)
      for (const row of ccRows) {
        expect(has(row, 'ccUnread'), row.id).toBe(true)
        expect(has(row, 'outcomeUnseen'), row.id).toBe(false)
      }

      // 我发起的: likewise the other way round.
      const requester2 = await token(requester2Id, inertRole)
      const mineRows = await feedRows(requester2, 'mine')
      expect(mineRows.length).toBeGreaterThan(0)
      for (const row of mineRows) {
        expect(has(row, 'outcomeUnseen'), row.id).toBe(true)
        expect(has(row, 'ccUnread'), row.id).toBe(false)
      }
    })
  })
})
