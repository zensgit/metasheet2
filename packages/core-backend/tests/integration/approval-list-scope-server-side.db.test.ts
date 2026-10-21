import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalBridgeService } from '../../src/services/ApprovalBridgeService'
import { IPLMAdapter } from '../../src/di/identifiers'

/**
 * P0-A — `GET /api/approvals` determines its visibility scope SERVER-SIDE.
 *
 * WHAT THIS SUITE GATES. `ApprovalBridgeService.listApprovals` conjoins
 * `buildApprovalListScopeCondition` into every list query (count and page alike), unconditionally
 * and independently of every client-supplied parameter. `tab` is a FILTER WITHIN that scope:
 * absent/empty ⇒ `APPROVAL_LIST_DEFAULT_TAB` ('pending'), a known value ⇒ honoured, anything else
 * ⇒ 400 `APPROVAL_TAB_INVALID` in the existing error envelope. ONE EXCEPTION, test (6b): an absent
 * tab on a request that carries its own `status` filter is served NO tab conjunct, so the response
 * is the scope intersected with that filter rather than an empty page produced by the default tab's
 * `status = 'pending'` colliding with the caller's own status.
 *
 * FIXTURE DISCIPLINE. Every positive assertion is paired with a row that must be ABSENT and that
 * the tab filter alone would have admitted — same org, same source system, same status, seeded to a
 * different requester and a different seat. Without that row an empty scope condition would satisfy
 * the positive half of every test here and the mutation probes could not go red.
 *
 * WHY THE ADMIN, ROLE AND ORG TESTS CALL THE SERVICE DIRECTLY RATHER THAN THE ROUTE. All five tab
 * filters are themselves actor-scoped (each one narrows to the actor's seat / request / action /
 * CC), so no tab exposes an admin's org-wide reach over the HTTP surface — an admin console would
 * need a surface of its own, which is a product decision, not this fix's. Calling `listApprovals`
 * with NO tab isolates the scope condition, which is exactly what those tests are about. The
 * route-level tests cover the HTTP surface end to end.
 *
 * TAB COVERAGE. All five tabs are exercised over HTTP in ALL FOUR `sourceSystem` modes — absent,
 * `all`, `platform` by test (11), and `plm` by test (16). CORRECTING THIS FILE'S EARLIER CLAIM: an
 * earlier revision said `sourceSystem=plm` "answers 503 PLM_APPROVAL_BRIDGE_UNAVAILABLE without a
 * configured PLM adapter, and no adapter is configurable from this harness". The first half is
 * true; the second is FALSE, and it foreclosed the gap rather than merely acknowledging it — the
 * sibling suite in this same evidence lane configures one in eleven lines
 * (`approval-wp2-source-filter.api.test.ts`: `injector.get(IPLMAdapter).connect()`), which is what
 * `beforeAll` now does. `mine`, `cc` and `processed` answered 500 on real PostgreSQL at the
 * merge-base — measured there with these changes reverted — because the tab block bound the actor
 * id, roles and permissions eagerly while those three branches reference only some of them; that is
 * fixed here (parameters are allocated on first reference) and (11)/(16) are its gates.
 *
 * THE OTHER LIST-SHAPED READ ON THIS ROUTER. `GET /api/approvals/pending` is the same router and
 * the same `rbacGuard('approvals','read')`, returns full `approval_instances` rows plus a total,
 * and had no per-caller condition at all. It now applies the SAME scope condition, in both its page
 * and its count query, plus the same dormant org pin — tests (14) and (15). Of the TWO surfaces
 * that conjoin this condition it is also the one where the scope's DB-backed administrator arm is
 * observable, because it applies no tab to AND against the scope; test (18) pins that arm there, in
 * both pin states, with a claim-only identity as its discriminating negative.
 *
 * ORG PIN. The org half of the scope reads the SAME `APPROVAL_S1_ORG_PIN_ENABLED` flag and the SAME
 * `viewerActiveOrgIds` definition `approval-instance-readability.ts` uses, and ships with the same
 * default (OFF). The pin-OFF test asserts the STATUS QUO — a DB-backed admin's reach is not
 * org-bounded while the pin is dormant — rather than asserting away a behaviour this fix has no
 * authority to change; the pin-ON tests force the flag on in-process around single assertions (the
 * shape `approval-instance-readability-s1.db.test.ts`'s G-S1-3/G-S1-10 use) to prove the org
 * conjunct's own correctness while it ships dormant. `afterEach` always RESTORES whatever value the
 * runner handed this file (usually none), so a thrown expectation cannot carry an override into a
 * later test and this file cannot clear a flag it did not set.
 *
 * WHAT THIS SUITE DOES NOT GATE, so a green run is not over-read. The `source_queue` sub-arm of the
 * seat arm binds CLAIM-derived permissions (`options.actorPermissions`, which the route fills from
 * the request's `permissions` / `perms`), not DB-derived ones — the same binding the tab filters
 * use, pre-existing and untouched here. Test (12b) pins that the sub-arm WORKS; it does not, and
 * cannot, pin that the permission set is trustworthy, because on this harness it is supplied by the
 * caller. On the production login path the claim is itself DB-derived (`resolveRbacProfile` fills
 * `permissions` from `listUserPermissions`), which is where that property actually lives.
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

type ListResponse = { data: Array<{ id: string }>; total: number }

describeIfDatabase('P0-A — approval list scope is determined server-side', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  // A17: captured once, before any test can touch it, so `afterEach` restores what the runner
  // handed this file instead of asserting the flag was unset.
  const orgPinBeforeSuite = process.env.APPROVAL_S1_ORG_PIN_ENABLED
  const pool = () => poolManager.get()

  const suffix = randomUUID().slice(0, 8)
  const orgA = `p0a-org-a-${suffix}`
  const orgB = `p0a-org-b-${suffix}`
  // A role that exists ONLY as a `user_roles` row — never as a token claim, never as `users.role`.
  const dbOnlyRoleId = `p0a-role-${suffix}`
  // A SECOND DB-only role, used exclusively by the role-typed CC sub-arm's fixture. It is separate
  // from `dbOnlyRoleId` on purpose: sharing one role would put the CC row inside test (9)'s
  // exhaustive expectations, and a mutation of the CC sub-arm would then red (9) as well as its own
  // test — "reds exactly its test" is the property these two sub-arm gates exist to have.
  const ccOnlyRoleId = `p0a-ccrole-${suffix}`
  // The permission string a `source_queue` seat stores. `= ANY(...)` is exact equality, so the
  // suite's ordinary `*:*` tokens never match it.
  const queuePermission = `p0a:queue:${suffix}`

  const participantId = `p0a-participant-${suffix}`
  const strangerId = `p0a-stranger-${suffix}`
  const adminInOrgAId = `p0a-admin-a-${suffix}`
  const adminInOrgBId = `p0a-admin-b-${suffix}`
  // Deliberately NEVER inserted into `users`: the discriminating negative for the admin arm, which
  // is DB-backed. An identity that merely CLAIMS the admin role must not widen the feed.
  const claimedAdminId = `p0a-claimed-admin-${suffix}`
  const otherRequesterId = `p0a-other-requester-${suffix}`
  const otherSeatId = `p0a-other-seat-${suffix}`
  // The A2 pair: identical in every respect EXCEPT where the role comes from.
  const dbRoleHolderId = `p0a-db-role-${suffix}`
  const claimRoleHolderId = `p0a-claim-role-${suffix}`
  // A12's two identities. `ccRoleHolderId` holds `ccOnlyRoleId` through a `user_roles` row and has
  // no other link to the CC row; `queueHolderId` holds nothing at all in the DB and reaches the
  // queue row only through the permission string its token carries.
  const ccRoleHolderId = `p0a-cc-role-${suffix}`
  const queueHolderId = `p0a-queue-holder-${suffix}`

  const seatInstanceId = `p0a_seat_${suffix}`
  const mineInstanceId = `p0a_mine_${suffix}`
  const actedInstanceId = `p0a_acted_${suffix}`
  const ccInstanceId = `p0a_cc_${suffix}`
  const inactiveSeatInstanceId = `p0a_inactive_seat_${suffix}`
  const roleSeatInstanceId = `p0a_role_seat_${suffix}`
  const otherOrgSeatInstanceId = `p0a_other_org_seat_${suffix}`
  const foreignPendingId = `p0a_foreign_pending_${suffix}`
  const foreignDoneId = `p0a_foreign_done_${suffix}`
  // TWO non-platform rows, because they answer two different questions and one row cannot answer
  // both: `plmSeatedId` is the participant's OWN seat on a mirror (so it is reachable through arm 2
  // as well as arm 6), and `plmForeignId` belongs to somebody else entirely (so arm 6 is the ONLY
  // thing that can admit it — which is what makes test (12)'s mutation discriminating).
  const plmSeatedId = `plm:p0a_plm_seated_${suffix}`
  const plmForeignId = `plm:p0a_plm_foreign_${suffix}`
  // A14's non-pending mirror: the participant's OWN plm request, which they also acted on and were
  // CC'd on. One row makes four of the five `sourceSystem=plm` tabs (mine / cc / completed /
  // processed) non-empty; `pending` is already covered by the two mirrors above. Without it those
  // four tabs would answer `200 []`, and a 200 carrying zero rows cannot tell "correctly empty"
  // from "the query quietly matched nothing".
  const plmDoneId = `plm:p0a_plm_done_${suffix}`
  // A12's two rows. Each is reachable through EXACTLY ONE scope sub-arm, which is what lets a
  // mutation of that sub-arm red exactly one test.
  const queueSeatInstanceId = `p0a_queue_seat_${suffix}`
  const ccRoleInstanceId = `p0a_cc_role_${suffix}`
  const seededInstanceIds = [
    seatInstanceId,
    mineInstanceId,
    actedInstanceId,
    ccInstanceId,
    inactiveSeatInstanceId,
    roleSeatInstanceId,
    otherOrgSeatInstanceId,
    foreignPendingId,
    foreignDoneId,
    plmSeatedId,
    plmForeignId,
    plmDoneId,
    queueSeatInstanceId,
    ccRoleInstanceId,
  ]
  const seededUserIds = [
    participantId,
    strangerId,
    adminInOrgAId,
    adminInOrgBId,
    otherRequesterId,
    otherSeatId,
    dbRoleHolderId,
    claimRoleHolderId,
    ccRoleHolderId,
    queueHolderId,
  ]

  /** Every non-platform row. Arm 6 admits these to ANY resolved actor, so they are the floor of
   *  every scope set in this suite — including a stranger's and a claim-only identity's. */
  const nonPlatformIds = [plmSeatedId, plmForeignId, plmDoneId]

  /** Everything the participant's SCOPE admits while the org pin is OFF (the shipped default). */
  const participantScopeAll = [
    seatInstanceId,
    mineInstanceId,
    actedInstanceId,
    ccInstanceId,
    inactiveSeatInstanceId,
    otherOrgSeatInstanceId,
    plmSeatedId,
    plmForeignId,
    plmDoneId,
  ]

  /** The participant's PENDING PLATFORM rows — what `GET /api/approvals/pending` must answer with,
   *  since that endpoint hard-codes `status = 'pending'` and platform-only and applies no tab. */
  const participantPendingPlatform = [
    seatInstanceId,
    mineInstanceId,
    ccInstanceId,
    otherOrgSeatInstanceId,
  ]

  /** EVERY seeded row `GET /api/approvals/pending` can return — status `pending`, source system
   *  `platform` — regardless of who is asking. This is what the DB-backed administrator arm reaches
   *  while the org pin is dormant, and seven of the eight belong to other people. */
  const seededPendingPlatform = [
    seatInstanceId,
    mineInstanceId,
    ccInstanceId,
    roleSeatInstanceId,
    otherOrgSeatInstanceId,
    foreignPendingId,
    queueSeatInstanceId,
    ccRoleInstanceId,
  ]

  async function authToken(userId: string, roles = 'viewer', perms = '*:*'): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function listRaw(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  }

  /** Returns ONLY this suite's own seeded ids, in feed order — the shared integration DB carries
   *  rows from every other suite, so a bare length assertion would be meaningless. */
  async function listOwnIds(path: string, token: string): Promise<string[]> {
    const response = await listRaw(path, token)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as ListResponse
    return payload.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id))
  }

  /** Same as `listOwnIds` but order-insensitive, for the set-shaped assertions. */
  async function listOwnIdSet(path: string, token: string): Promise<string[]> {
    return (await listOwnIds(path, token)).slice().sort()
  }

  /** The scope condition in isolation: no `tab`, so no tab filter is assembled and the only thing
   *  that can exclude a row is the scope. */
  async function scopeOnlyIds(actor: {
    actorId?: string
    actorRoles?: string[]
    actorPermissions?: string[]
  }): Promise<string[]> {
    const result = await new ApprovalBridgeService().listApprovals({ limit: 500, ...actor })
    return result.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)).sort()
  }

  async function seedUser(userId: string, role: string): Promise<void> {
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', $2, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, is_admin = FALSE`,
      [userId, role],
    )
  }

  async function seedOrgMembership(userId: string, orgId: string): Promise<void> {
    await pool().query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
      [userId, orgId],
    )
  }

  async function seedInstance(
    id: string,
    requesterId: string,
    status: string,
    orgId: string | null,
    sourceSystem = 'platform',
  ): Promise<void> {
    await pool().query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, org_id, created_at, updated_at)
       VALUES ($1, $2, 0, $8, $3, $4, $5, $6::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 'ok', $7, now(), now())`,
      [
        id,
        status,
        `p0a-wf-${suffix}`,
        `p0a:${id}`,
        `P0A ${id}`,
        JSON.stringify({ id: requesterId, name: requesterId }),
        orgId,
        sourceSystem,
      ],
    )
  }

  async function seedAssignment(
    instanceId: string,
    assigneeId: string,
    options: { assignmentType?: string; isActive?: boolean } = {},
  ): Promise<void> {
    await pool().query(
      `INSERT INTO approval_assignments
         (id, instance_id, assignment_type, assignee_id, source_step, is_active, metadata, created_at, updated_at)
       VALUES ($1, $2, $4, $3, 0, $5, '{}'::jsonb, now(), now())`,
      [randomUUID(), instanceId, assigneeId, options.assignmentType ?? 'user', options.isActive ?? true],
    )
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()

    await seedUser(participantId, 'viewer')
    await seedUser(strangerId, 'viewer')
    await seedUser(otherRequesterId, 'viewer')
    await seedUser(otherSeatId, 'viewer')
    await seedUser(dbRoleHolderId, 'viewer')
    await seedUser(claimRoleHolderId, 'viewer')
    await seedUser(ccRoleHolderId, 'viewer')
    await seedUser(queueHolderId, 'viewer')
    // DB-backed approval admins, via the `users.role = 'admin'` half of the admin arm. Their
    // identities are used with `roles=viewer` claims below, so nothing here can pass on a role claim.
    await seedUser(adminInOrgAId, 'admin')
    await seedUser(adminInOrgBId, 'admin')

    // The A2 discriminator: `dbRoleHolderId` holds `dbOnlyRoleId` through a `user_roles` row and
    // nothing else; `claimRoleHolderId` holds it through nothing at all and will assert it as a
    // request claim instead. Both carry the same `users.role` ('viewer'), so the ONLY difference
    // between them is where the role-seat's role can be found.
    await pool().query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [dbRoleHolderId, dbOnlyRoleId],
    )
    // A12's CC-role holder: a SECOND DB-only role, held by a SECOND identity, so the role-typed CC
    // sub-arm's witness is disjoint from the role-typed SEAT sub-arm's.
    await pool().query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [ccRoleHolderId, ccOnlyRoleId],
    )

    await seedOrgMembership(participantId, orgA)
    await seedOrgMembership(strangerId, orgA)
    await seedOrgMembership(adminInOrgAId, orgA)
    await seedOrgMembership(adminInOrgBId, orgB)
    await seedOrgMembership(dbRoleHolderId, orgA)
    await seedOrgMembership(claimRoleHolderId, orgA)
    await seedOrgMembership(ccRoleHolderId, orgA)
    await seedOrgMembership(queueHolderId, orgA)

    // Participant's seat (pending + active user assignment) — the `pending` tab's own row.
    await seedInstance(seatInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(seatInstanceId, participantId)

    // Participant's own request, pending but UNSEATED. Visible to the requester arm, and
    // deliberately NOT on the `pending` tab — which is what discriminates "the default tab is
    // `pending`" from "the default is no tab condition at all". Also the `mine` tab's own row.
    await seedInstance(mineInstanceId, participantId, 'pending', orgA)

    // Participant acted on this one and it has since completed — the past-actor arm, and the
    // `completed` / `processed` tabs' own row.
    await seedInstance(actedInstanceId, otherRequesterId, 'approved', orgA)
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, to_status, occurred_at)
       VALUES ($1, 'approve', $2, 'approved', now())`,
      [actedInstanceId, participantId],
    )

    // CC'd to the participant by somebody else — the CC arm, and the `cc` tab's own row. The
    // participant is neither its requester nor its seat, so the CC record is the only way in.
    await seedInstance(ccInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(ccInstanceId, otherSeatId)
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, to_status, metadata, occurred_at)
       VALUES ($1, 'cc', $2, 'pending', $3::jsonb, now())`,
      [ccInstanceId, otherSeatId, JSON.stringify({ targetType: 'user', targetId: participantId })],
    )

    // A DEACTIVATED seat and NOTHING else: no requester match, no `approval_records` row, no CC.
    // The scope's seat arm is deliberately `is_active`-INSENSITIVE (a seat deactivates the moment
    // its holder acts on it), and this row is the only witness for that property — it is
    // deliberately NOT given a record row, because a record row would let the past-actor arm admit
    // it and the property would go ungated again.
    await seedInstance(inactiveSeatInstanceId, otherRequesterId, 'approved', orgA)
    await seedAssignment(inactiveSeatInstanceId, participantId, { isActive: false })

    // A ROLE-typed seat for a role that exists only in `user_roles`. The participant does not hold
    // it; `dbRoleHolderId` does, through the DB; `claimRoleHolderId` will only claim it.
    await seedInstance(roleSeatInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(roleSeatInstanceId, dbOnlyRoleId, { assignmentType: 'role' })

    // The participant's seat on a row belonging to a SECOND org — the org pin's own discriminator:
    // reachable while the pin is dormant, denied once it is on.
    await seedInstance(otherOrgSeatInstanceId, otherRequesterId, 'pending', orgB)
    await seedAssignment(otherOrgSeatInstanceId, participantId)

    // The should-NOT-see rows: same org, same source system, one per status the tab filters below
    // reach, each seeded to someone else's request and someone else's seat.
    await seedInstance(foreignPendingId, otherRequesterId, 'pending', orgA)
    await seedAssignment(foreignPendingId, otherSeatId)
    await seedInstance(foreignDoneId, otherRequesterId, 'approved', orgA)
    await seedAssignment(foreignDoneId, otherSeatId)

    // NON-PLATFORM mirrors. `plmSeatedId` is `seatInstanceId`'s twin — same status, same org, the
    // same ACTIVE user seat for the participant, differing ONLY in `source_system`, which is what
    // makes test (8) an isolated measurement of the source conjunct.
    await seedInstance(plmSeatedId, otherRequesterId, 'pending', orgA, 'plm')
    await seedAssignment(plmSeatedId, participantId)
    // `plmForeignId` carries a NULL `org_id`, which is what `plm:` mirrors carry in production BY
    // DESIGN (migration `zzzz20260821100000`: "Class 5 (`plm:` mirrors) … `org_id` stays NULL there
    // permanently"). It is the org pin's non-platform witness AND arm 6's only witness.
    await seedInstance(plmForeignId, otherRequesterId, 'pending', null, 'plm')
    await seedAssignment(plmForeignId, otherSeatId)

    // A14's non-pending mirror. `org_id` NULL for the same by-design reason `plmForeignId` carries
    // one. The participant is its requester, recorded an action on it, and is a CC target on it —
    // three links, so the four non-`pending` tabs each have a row under `sourceSystem=plm`.
    await seedInstance(plmDoneId, participantId, 'approved', null, 'plm')
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, to_status, occurred_at)
       VALUES ($1, 'approve', $2, 'approved', now())`,
      [plmDoneId, participantId],
    )
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, to_status, metadata, occurred_at)
       VALUES ($1, 'cc', $2, 'approved', $3::jsonb, now())`,
      [plmDoneId, otherSeatId, JSON.stringify({ targetType: 'user', targetId: participantId })],
    )

    // A12-1: a `source_queue` seat and NOTHING else. Its `assignee_id` is a PERMISSION string, and
    // the only caller that can reach it is one whose request carries that permission — which is the
    // asymmetry the scope docblock's PERMISSION SOURCE paragraph names. `queueHolderId` is not its
    // requester, holds no user- or role-typed seat on it, recorded no action, is not a CC target
    // and is not a DB-backed admin, so the `source_queue` disjunct of the seat arm is the ONLY
    // thing that can admit it.
    await seedInstance(queueSeatInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(queueSeatInstanceId, queuePermission, { assignmentType: 'source_queue' })

    // A12-2: a ROLE-typed CC record and nothing else. `ccRoleHolderId` reaches it only through the
    // role half of the CC arm, and only because a `user_roles` row backs `ccOnlyRoleId`. Its own
    // requester and its ACTIVE seat both belong to other people, and no `approval_records` row
    // names `ccRoleHolderId` as an actor.
    await seedInstance(ccRoleInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(ccRoleInstanceId, otherSeatId)
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, to_status, metadata, occurred_at)
       VALUES ($1, 'cc', $2, 'pending', $3::jsonb, now())`,
      [ccRoleInstanceId, otherSeatId, JSON.stringify({ targetType: 'role', targetId: ccOnlyRoleId })],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address && typeof address === 'object' ? address.port : undefined).toBeTruthy()
    baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`

    // A14: connect the PLM adapter so `sourceSystem=plm` is reachable over HTTP. This is the same
    // eleven lines the sibling suite in this evidence lane already uses
    // (`approval-wp2-source-filter.api.test.ts`). No PLM URL is configured in the test environment,
    // so `connect()` puts the adapter in mock mode: `getApprovals` returns an empty list, the
    // route's force-sync becomes a no-op, and the seeded `plm:` rows are left untouched — asserted
    // by test (16)'s row-set expectations, which would change if the sync had upserted anything.
    const injector = (server as unknown as { injector?: { get: (id: unknown) => unknown } }).injector
    expect(injector, 'the PLM adapter must be reachable for the sourceSystem=plm tabs').toBeTruthy()
    const plmAdapter = injector!.get(IPLMAdapter) as { connect?: () => Promise<void> }
    expect(typeof plmAdapter.connect, 'IPLMAdapter must expose connect()').toBe('function')
    await plmAdapter.connect!()
  })

  // A17: RESTORE the previous value rather than deleting it. Deleting is only equivalent while no
  // outer runner sets the flag; if one ever does, an unconditional `delete` here silently clears it
  // for every later file in the same worker, which is a suite reaching outside its own scope.
  afterEach(() => {
    if (orgPinBeforeSuite === undefined) {
      delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
    } else {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = orgPinBeforeSuite
    }
  })

  afterAll(async () => {
    try {
      await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM user_roles WHERE role_id = ANY($1::text[])', [[dbOnlyRoleId, ccOnlyRoleId]])
      await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [seededUserIds])
      await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
    } finally {
      await server?.stop()
    }
  })

  it('(1) a non-participant reaches none of the seeded instances, over the route and through the scope alone', async () => {
    const strangerToken = await authToken(strangerId)
    expect(await listOwnIds('/api/approvals?tab=pending&limit=200', strangerToken)).toEqual([])
    expect(await listOwnIds('/api/approvals?tab=completed&limit=200', strangerToken)).toEqual([])

    // Positive control for the SAME request shapes: the rows exist and those tabs reach them — the
    // empty results above are not an empty fixture or a broken query.
    const participantToken = await authToken(participantId)
    expect(await listOwnIdSet('/api/approvals?tab=pending&limit=200', participantToken))
      .toEqual([otherOrgSeatInstanceId, seatInstanceId].sort())
    expect(await listOwnIdSet('/api/approvals?tab=completed&limit=200', participantToken))
      .toEqual([actedInstanceId, inactiveSeatInstanceId].sort())

    // WHICH MECHANISM IS BEING MEASURED, stated because the two route assertions above cannot tell
    // them apart: every tab filter is ITSELF actor-scoped, so on a request that carries a valid tab
    // the tab filter alone already excludes a non-participant's rows. The scope-only pair below is
    // what makes THIS test an assertion about the scope condition — no tab is supplied, so the
    // scope is the only thing that can exclude anything. The stranger nonetheless reaches the two
    // non-platform mirrors, because arm 6 admits every non-platform row to any RESOLVED actor —
    // pre-existing phase-1 visibility, asserted here rather than left implied.
    expect(await scopeOnlyIds({ actorId: strangerId })).toEqual(nonPlatformIds.slice().sort())
    expect(await scopeOnlyIds({ actorId: participantId })).toEqual(participantScopeAll.slice().sort())
  })

  it('(2) a participant sees their own instances only', async () => {
    const token = await authToken(participantId)

    const pendingIds = await listOwnIdSet('/api/approvals?tab=pending&limit=200', token)
    expect(pendingIds).toEqual([otherOrgSeatInstanceId, seatInstanceId].sort())
    expect(pendingIds).not.toContain(foreignPendingId)

    const completedIds = await listOwnIdSet('/api/approvals?tab=completed&limit=200', token)
    expect(completedIds).toEqual([actedInstanceId, inactiveSeatInstanceId].sort())
    expect(completedIds).not.toContain(foreignDoneId)

    // Same discrimination note as (1): with no tab supplied, the scope condition is the only thing
    // standing between this participant and the foreign rows, which are same-org, same-source,
    // one per status, and each carry an ACTIVE seat belonging to someone else.
    const scopedIds = await scopeOnlyIds({ actorId: participantId })
    expect(scopedIds).toEqual(participantScopeAll.slice().sort())
    expect(scopedIds).not.toContain(foreignPendingId)
    expect(scopedIds).not.toContain(foreignDoneId)
    expect(scopedIds).not.toContain(roleSeatInstanceId)

  })

  // TWO DOORS COVER THIS ONE, stated so a green run is not over-read: the scope condition AND the
  // tab default each independently prevent `assignee` from surfacing another user's platform rows,
  // so reverting either alone leaves this test green. It reds only when BOTH are removed — verified
  // with a compound mutation (scope condition replaced by a tautology AND the route's tab default
  // returned to `undefined`), which is the merge-base shape this test's claim is about.
  it('(2b) the assignee filter narrows within the scope and cannot widen it', async () => {
    const token = await authToken(participantId)

    // `assignee` is the one query parameter whose VALUE is somebody else's identity, so it is the
    // obvious candidate for widening the set, and at the merge-base it did: naming another user
    // returned that user's instances to an unrelated caller. It is a filter WITHIN the scope like
    // any other now, which this asserts in the shape the claim is actually made in — for every
    // base request, adding `&assignee=<somebody else>` must produce a SUBSET of what the same
    // request returns without it, and in particular must never surface the platform rows that user
    // is seated on. Stated as a subset rather than as "returns nothing", because a caller may
    // legitimately still see non-platform rows the parameter did not add (phase-1 visibility).
    for (const base of [
      '/api/approvals?limit=200',
      '/api/approvals?tab=pending&limit=200',
      '/api/approvals?tab=completed&limit=200',
      '/api/approvals?sourceSystem=all&limit=200',
    ]) {
      const without = await listOwnIdSet(base, token)
      const withAssignee = await listOwnIdSet(`${base}&assignee=${encodeURIComponent(otherSeatId)}`, token)
      for (const id of withAssignee) {
        expect(without, `${base} + assignee must not widen`).toContain(id)
      }
      expect(withAssignee, base).not.toContain(foreignPendingId)
      expect(withAssignee, base).not.toContain(foreignDoneId)
    }

    // Positive control on the SAME parameter: naming the caller's own identity returns the caller's
    // own seated rows, so the subset results above are the scope holding rather than `assignee`
    // being ignored or matching nothing at all.
    expect(await listOwnIdSet(`/api/approvals?assignee=${encodeURIComponent(participantId)}&limit=200`, token))
      .toEqual([otherOrgSeatInstanceId, plmSeatedId, seatInstanceId].sort())
  })

  it('(3a) org pin OFF: a DB-backed admin from a second org still reaches the first org (shipped status quo)', async () => {
    expect(process.env.APPROVAL_S1_ORG_PIN_ENABLED).toBeUndefined()
    expect(await scopeOnlyIds({ actorId: adminInOrgBId })).toContain(foreignPendingId)
  })

  it('(3b) org pin ON: the same second-org admin reaches no PLATFORM row from the first org', async () => {
    process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'

    // Every org-A PLATFORM row is gone. What survives is org B's own platform row (this admin is
    // active in org B — the positive half of the same conjunct) and the two non-platform mirrors,
    // which survive because the org conjunct governs platform rows alone — see test (10), which is
    // where that carve-out is gated.
    const orgBAdminIds = await scopeOnlyIds({ actorId: adminInOrgBId })
    expect(orgBAdminIds).not.toContain(foreignPendingId)
    expect(orgBAdminIds).not.toContain(seatInstanceId)
    expect(orgBAdminIds).toEqual([otherOrgSeatInstanceId, ...nonPlatformIds].sort())

    // Positive control under the SAME flag: an admin whose active membership IS org A still reads
    // org A's rows, so the empty platform half above is the org conjunct, not the pin denying
    // everyone.
    expect(await scopeOnlyIds({ actorId: adminInOrgAId })).toContain(foreignPendingId)

    // And a participant is still org-bounded on the same flag: their own rows stay readable,
    // because the writer stamped them into the org the participant is active in.
    expect(await scopeOnlyIds({ actorId: participantId })).toContain(seatInstanceId)
  })

  // This test measures the TAB DEFAULT, not the scope condition — reverting the default makes it
  // red, removing the scope condition does not (with a tab in play, the tab filter is itself
  // actor-scoped). The scope's own gates are (1), (2), (6), (7), (9), (12) and (13).
  it('(4) a request with no tab is served the default tab AND stays participant-bound', async () => {
    const participantToken = await authToken(participantId)
    const ownIds = await listOwnIdSet('/api/approvals?limit=200', participantToken)

    // Default tab is `pending`: the participant's seated rows are in, their own UNSEATED pending
    // request is out. A default of "no tab condition at all" would have returned both.
    expect(ownIds).toEqual([otherOrgSeatInstanceId, plmSeatedId, seatInstanceId].sort())
    expect(ownIds).not.toContain(mineInstanceId)
    expect(ownIds).not.toContain(foreignPendingId)

    const strangerToken = await authToken(strangerId)
    // The stranger reaches nothing at all — including the two non-platform mirrors that the SCOPE
    // alone would admit to them (test (1)'s scope-only assertion). The default `pending` tab's own
    // filter requires an ACTIVE seat, and the stranger holds none, so the tab narrows further than
    // the scope here rather than widening anything.
    expect(await listOwnIdSet('/api/approvals?limit=200', strangerToken)).toEqual([])
  })

  it('(5) an unknown tab is a 400 in the existing envelope; an EMPTY tab is absent, not invalid', async () => {
    const token = await authToken(participantId)

    const rejected = await listRaw('/api/approvals?tab=everything&limit=200', token)
    expect(rejected.status).toBe(400)
    const payload = (await rejected.json()) as { ok?: boolean; error?: { code?: string } }
    expect(payload.error?.code).toBe('APPROVAL_TAB_INVALID')
    expect(payload.ok).toBe(false)

    // A cleared filter chip degrades to the default rather than 400ing — the same treatment
    // `sourceSystem` / `templateId` / the created-at window already give an empty value. It is
    // treated as ABSENT in every respect, including the source conjunct: the mixed feed below is
    // the same one test (8) pins for a request that omits `tab` entirely.
    expect(await listOwnIdSet('/api/approvals?tab=&limit=200', token))
      .toEqual([otherOrgSeatInstanceId, plmSeatedId, seatInstanceId].sort())
  })

  // TITLE IS DELIBERATELY NOT "sees the whole org": under the SHIPPED default (org pin OFF, which
  // is what this test runs with) the admin arm is not org-bounded at all — test (3a) asserts that
  // status quo directly. Bounding it to the org is what the pin does, and the pin's activation is
  // its own owner-gated step.
  it('(6) a DB-backed approval admin is not participant-bound; a merely-claimed admin role is', async () => {
    // The admin participates in NONE of these — requester, seat, actor and CC are all other people.
    const adminIds = await scopeOnlyIds({ actorId: adminInOrgAId })
    for (const id of seededInstanceIds) {
      expect(adminIds).toContain(id)
    }

    // Discriminating negative: an identity with NO `users` row, carrying the admin ROLE claim the
    // route would derive from a token. The admin arm is DB-backed, so this reaches no platform row.
    // (The two non-platform mirrors are arm 6's pre-existing phase-1 visibility, not admin reach —
    // test (7) is where an actor that does not resolve at all is shown to reach even those.)
    expect(await scopeOnlyIds({ actorId: claimedAdminId, actorRoles: ['admin'], actorPermissions: ['*:*'] }))
      .toEqual(nonPlatformIds.slice().sort())

    // And an ordinary member of the same org is not admitted org-wide either.
    expect(await scopeOnlyIds({ actorId: strangerId })).toEqual(nonPlatformIds.slice().sort())

    // OVER THE ROUTE the same admin sees no more than anybody else, because every tab narrows to
    // the caller's own participation and is ANDed with the scope. This is the assertion behind the
    // OpenAPI sentence "an administrator's response is the same as any other caller's" — without it
    // the published contract would be making a claim nothing measures.
    const adminToken = await authToken(adminInOrgAId)
    for (const path of [
      '/api/approvals?limit=200',
      '/api/approvals?tab=pending&limit=200',
      '/api/approvals?tab=completed&limit=200',
      '/api/approvals?tab=pending&sourceSystem=all&limit=200',
    ]) {
      const adminRouteIds = await listOwnIdSet(path, adminToken)
      expect(adminRouteIds, `${path} must not widen for an admin`).not.toContain(foreignPendingId)
      expect(adminRouteIds, `${path} must not widen for an admin`).not.toContain(seatInstanceId)
    }
  })

  it('(6b) a tab-less request carries the default tab\'s status condition ONLY when it brings no status filter of its own', async () => {
    const token = await authToken(participantId)

    // RETRACTION, gated. An earlier revision of this test asserted `[]` here and the published
    // description said a tab-less `status=approved` "returns nothing". That was the tab DEFAULT
    // colliding with the caller's own filter: `pending` pushes `status = 'pending'`, the caller
    // pushed `status = 'approved'`, and the contradictory pair emptied a page the caller was
    // entitled to — their OWN approved rows, not merely other people's. The rule is now: an absent
    // tab means pending semantics UNLESS a status filter is given, in which case only the server
    // scope and that status filter apply.
    //
    // So this returns the participant's own approved rows across BOTH source systems (no tab means
    // no legacy "a tab implies the platform feed" conjunct either — the same rule test (8) pins for
    // the tab-less feed generally).
    expect(await listOwnIdSet('/api/approvals?status=approved&limit=200', token))
      .toEqual([actedInstanceId, inactiveSeatInstanceId, plmDoneId].sort())

    // THE NARROWING HALF, which is what makes the assertion above a scope measurement rather than
    // a return to the merge-base's unscoped feed: `foreignDoneId` is approved, platform, same org,
    // and belongs to somebody else. At the merge-base this exact request returned it (the shape had
    // no scope at all); it must not appear now.
    expect(await listOwnIdSet('/api/approvals?status=approved&limit=200', token))
      .not.toContain(foreignDoneId)

    // A NON-PARTICIPANT on the identical shape reaches only the non-platform floor arm 6 admits to
    // every resolved actor — `plmDoneId` is the one approved mirror. NOT the empty set: arm 6 is
    // pre-existing phase-1 visibility (test (12) is its own gate), and asserting `[]` here would be
    // asserting away a behaviour this change has no authority to remove. The platform half IS
    // empty, which is the property this pair exists to show.
    const strangerToken = await authToken(strangerId)
    expect(await listOwnIdSet('/api/approvals?status=approved&limit=200', strangerToken))
      .toEqual([plmDoneId])
    expect(await listOwnIdSet('/api/approvals?status=approved&sourceSystem=platform&limit=200', strangerToken))
      .toEqual([])
    // …and on that same platform-restricted shape the participant still reaches their own approved
    // platform rows, so the empty set above is the scope denying a stranger rather than the filter
    // combination matching nothing for anybody.
    expect(await listOwnIdSet('/api/approvals?status=approved&sourceSystem=platform&limit=200', token))
      .toEqual([actedInstanceId, inactiveSeatInstanceId].sort())

    // AN EXPLICIT TAB IS NEVER SUPPRESSED. `?tab=pending&status=approved` keeps the two conditions
    // the caller named — the merge-base semantics, measured there with these four source files
    // reverted — so it stays empty. The rule only governs a tab the SERVER supplied.
    expect(await listOwnIdSet('/api/approvals?tab=pending&status=approved&limit=200', token)).toEqual([])
    expect(await listOwnIdSet('/api/approvals?tab=completed&status=approved&limit=200', token))
      .toEqual([actedInstanceId, inactiveSeatInstanceId].sort())

    // AN EMPTY `status=` IS ABSENT, NOT A FILTER — the same treatment `tab=`, `sourceSystem=`,
    // `templateId=` and the created-at window already get. The default tab must survive it, or a
    // cleared status chip would silently widen the tab-less inbox from `pending` to the caller's
    // whole scope while adding no filter in its place. This is the mixed feed test (4) pins.
    expect(await listOwnIdSet('/api/approvals?status=&limit=200', token))
      .toEqual([otherOrgSeatInstanceId, plmSeatedId, seatInstanceId].sort())

    // `status=pending` IS a status filter, so it too suppresses the default tab: the response is
    // the caller's whole pending scope, which is WIDER than the `pending` tab's own ACTIVE-seat
    // feed (their unseated own request and their CC'd row are in it). Still a narrowing against the
    // merge-base, where this shape returned every pending row in the table.
    expect(await listOwnIdSet('/api/approvals?status=pending&limit=200', token))
      .toEqual([ccInstanceId, mineInstanceId, otherOrgSeatInstanceId, plmForeignId, plmSeatedId, seatInstanceId].sort())
    expect(await listOwnIdSet('/api/approvals?status=pending&limit=200', token))
      .not.toContain(foreignPendingId)
  })

  it('(7) a list call with no resolvable actor reaches NOTHING, non-platform rows included', async () => {
    // The non-platform arm is the one arm that names no actor column. Emitting it for a request
    // whose actor did not resolve would hand every external mirror to a caller the request could
    // not identify, so it is emitted only when the actor resolved — which is what makes these three
    // assertions about the seeded `plm:` rows and not merely about the platform ones.
    expect(await scopeOnlyIds({})).toEqual([])
    expect(await scopeOnlyIds({ actorId: '   ' })).toEqual([])
    // Role / permission claims without a resolvable actor id must not admit anything either.
    expect(await scopeOnlyIds({ actorRoles: ['admin'], actorPermissions: ['*:*'] })).toEqual([])

    // Positive control: the identical call WITH an actor reaches the participant's rows INCLUDING
    // both non-platform mirrors, so the empty results above are the scope condition denying an
    // unresolvable actor rather than the service-level call being wired wrong or the mirrors being
    // unreachable for some other reason.
    const withActor = await scopeOnlyIds({ actorId: participantId })
    expect(withActor).toEqual(participantScopeAll.slice().sort())
    expect(withActor).toContain(plmForeignId)
  })

  it('(8) a tab-less request keeps the mixed platform+plm feed; an explicit tab=pending does not', async () => {
    const token = await authToken(participantId)

    // ISOLATION: `seatInstanceId` and `plmSeatedId` are the same row twice over — same status
    // (pending), same org, same requester shape, the same ACTIVE user seat for this caller — and
    // differ ONLY in `source_system`. So whichever way these two assertions come out, the source
    // conjunct is the only thing that can explain the difference.
    const tabless = await listOwnIdSet('/api/approvals?limit=200', token)
    expect(tabless).toContain(seatInstanceId)
    expect(tabless).toContain(plmSeatedId)

    // PINNED TO A MEASUREMENT, not to a preference: at the merge-base (these source files reverted,
    // same DB, same fixture shape) a tab-less request returned BOTH source systems and an explicit
    // `?tab=pending` returned the platform row only. Both still do. The tab default must not
    // silently convert the first shape into the second.
    const explicitPending = await listOwnIdSet('/api/approvals?tab=pending&limit=200', token)
    expect(explicitPending).toContain(seatInstanceId)
    expect(explicitPending).not.toContain(plmSeatedId)

    // `sourceSystem`'s own semantics are untouched by the above: `all` still returns the mixed feed
    // for an explicit tab, and `platform` still narrows a tab-less request.
    expect(await listOwnIdSet('/api/approvals?tab=pending&sourceSystem=all&limit=200', token))
      .toContain(plmSeatedId)
    expect(await listOwnIdSet('/api/approvals?sourceSystem=platform&limit=200', token))
      .not.toContain(plmSeatedId)
  })

  it('(9) the scope binds DB-derived roles: a user_roles row admits, a role claim alone does not', async () => {
    // POSITIVE: the role reaches this viewer only through a `user_roles` row — never through
    // `users.role` (which is 'viewer' for both of them) and never through a claim, since no
    // `actorRoles` is passed at all.
    const dbRoleIds = await scopeOnlyIds({ actorId: dbRoleHolderId })
    expect(dbRoleIds).toContain(roleSeatInstanceId)

    // NEGATIVE, and this is the discriminating half: the same role, asserted as a request claim by
    // a viewer who holds no `user_roles` row for it. The scope reads roles from the DB
    // (`viewerRoles`, the same definition `canReadApprovalInstance` uses), so the claim buys
    // nothing.
    const claimRoleIds = await scopeOnlyIds({ actorId: claimRoleHolderId, actorRoles: [dbOnlyRoleId] })
    expect(claimRoleIds).not.toContain(roleSeatInstanceId)

    // Control that the two viewers are otherwise identical: both reach exactly the non-platform
    // mirrors and nothing else, so the difference above is the role source and not some other
    // asymmetry between the two identities.
    expect(claimRoleIds).toEqual(nonPlatformIds.slice().sort())
    expect(dbRoleIds).toEqual([...nonPlatformIds, roleSeatInstanceId].sort())
  })

  it('(10) org pin ON: the org conjunct governs platform rows only, so mirrors are not blacked out', async () => {
    process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'

    const pinned = await scopeOnlyIds({ actorId: participantId })

    // A `plm:` mirror whose `org_id` is NULL BY DESIGN stays visible. `canReadApprovalInstance`
    // refuses a `plm:` id before it ever consults the pin, so the pin has no say over a
    // non-platform row there either; an unqualified org conjunct here would instead empty the
    // unified inbox of every mirror the moment the flag is switched on, with no backfill able to
    // fix it.
    expect(pinned).toContain(plmForeignId)
    expect(pinned).toContain(plmSeatedId)

    // Platform rows of a SECOND org are hidden, which is what the pin is for. The participant holds
    // an ACTIVE seat on this row, so nothing but the org conjunct can be excluding it.
    expect(pinned).not.toContain(otherOrgSeatInstanceId)

    // Positive control on the same flag, same call: the participant's own-org platform rows are
    // still there, so the exclusion above is the org conjunct and not the pin denying everyone.
    expect(pinned).toEqual(
      participantScopeAll.filter((id) => id !== otherOrgSeatInstanceId).sort(),
    )

    // And with the flag cleared the second-org row comes back — the pin is the only variable.
    delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
    expect(await scopeOnlyIds({ actorId: participantId })).toContain(otherOrgSeatInstanceId)
  })

  it('(11) all five tabs answer 200 with the expected rows, in every reachable sourceSystem mode', async () => {
    const token = await authToken(participantId)
    // `sourceSystem=plm` is not here: it answers 503 PLM_APPROVAL_BRIDGE_UNAVAILABLE without a
    // configured adapter, and none is configurable from this harness.
    const sourceModes = ['', '&sourceSystem=all', '&sourceSystem=platform'] as const
    const expectedByTab: Record<string, Record<string, string[]>> = {
      pending: {
        '': [otherOrgSeatInstanceId, seatInstanceId],
        '&sourceSystem=all': [otherOrgSeatInstanceId, plmForeignId, plmSeatedId, seatInstanceId],
        '&sourceSystem=platform': [otherOrgSeatInstanceId, seatInstanceId],
      },
      // `&sourceSystem=all` routes to the `includeExternalTabSources` branch, which pushes NO
      // source conjunct — so `plmDoneId` (the participant's own non-pending mirror, which they also
      // acted on and were CC'd on) joins these four tabs there and only there. The `''` and
      // `platform` modes both carry `COALESCE(source_system,'platform') = 'platform'`.
      mine: {
        '': [mineInstanceId],
        '&sourceSystem=all': [mineInstanceId, plmDoneId],
        '&sourceSystem=platform': [mineInstanceId],
      },
      cc: {
        '': [ccInstanceId],
        '&sourceSystem=all': [ccInstanceId, plmDoneId],
        '&sourceSystem=platform': [ccInstanceId],
      },
      completed: {
        '': [actedInstanceId, inactiveSeatInstanceId],
        '&sourceSystem=all': [actedInstanceId, inactiveSeatInstanceId, plmDoneId],
        '&sourceSystem=platform': [actedInstanceId, inactiveSeatInstanceId],
      },
      processed: {
        '': [actedInstanceId],
        '&sourceSystem=all': [actedInstanceId, plmDoneId],
        '&sourceSystem=platform': [actedInstanceId],
      },
    }

    for (const tab of ['pending', 'mine', 'cc', 'completed', 'processed']) {
      for (const mode of sourceModes) {
        const path = `/api/approvals?tab=${tab}${mode}&limit=200`
        const response = await listRaw(path, token)
        expect(response.status, `${path} must answer 200`).toBe(200)
        const payload = (await response.json()) as ListResponse
        const own = payload.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)).sort()
        // NON-EMPTY on every one of the fifteen combinations: a 200 carrying zero rows cannot tell
        // "correctly empty" apart from "the query quietly matched nothing".
        expect(own.length, `${path} must return rows`).toBeGreaterThan(0)
        expect(own, `${path} row set`).toEqual(expectedByTab[tab][mode].slice().sort())
      }
    }
  })

  it('(12) the non-platform arm is load-bearing: a foreign mirror reaches a participant through it alone', async () => {
    // `plmForeignId` has somebody else's requester, somebody else's ACTIVE seat, no record, no CC,
    // and this caller is not a DB admin — so arm 6 is the ONLY arm that can admit it. Deleting that
    // arm reds this assertion; nothing else in the fixture does the job, which is why this row
    // exists separately from `plmSeatedId` (which the seat arm would keep admitting).
    const scoped = await scopeOnlyIds({ actorId: participantId })
    expect(scoped).toContain(plmForeignId)

    // The same row over the route, on the shape the shipped inbox actually sends.
    const token = await authToken(participantId)
    expect(await listOwnIdSet('/api/approvals?tab=pending&sourceSystem=all&limit=200', token))
      .toContain(plmForeignId)
  })

  it('(13) the seat arm is is_active-INSENSITIVE, so a processed seat keeps its instance readable', async () => {
    // `inactiveSeatInstanceId` carries a DEACTIVATED seat for this caller and nothing else — no
    // requester match, no `approval_records` row, no CC, not a mirror. So the seat arm's
    // insensitivity is the only thing that can admit it, and adding `is_active = TRUE` to that arm
    // reds this assertion. Measured through the SCOPE rather than over `?tab=completed`, because
    // the completed tab's own assignment sub-arm is separately `is_active`-insensitive and would
    // keep the row visible even with the scope arm mutated.
    const scoped = await scopeOnlyIds({ actorId: participantId })
    expect(scoped).toContain(inactiveSeatInstanceId)

    // Control: an active seat on a comparable row is admitted too, so the assertion above is not
    // reading a fixture where every seat happens to be inactive.
    expect(scoped).toContain(seatInstanceId)
  })

  it('(12b) the source_queue sub-arm of the seat arm is load-bearing', async () => {
    // `queueSeatInstanceId` carries a `source_queue` seat whose `assignee_id` is a PERMISSION
    // string, and nothing else: somebody else's requester, no user- or role-typed seat for this
    // caller, no `approval_records` row, no CC, and `queueHolderId` is not a DB-backed admin. So
    // the `source_queue` disjunct is the ONLY arm that can admit it, and appending `AND FALSE` to
    // that disjunct reds this test and no other.
    const withPermission = await scopeOnlyIds({
      actorId: queueHolderId,
      actorPermissions: [queuePermission],
    })
    expect(withPermission).toContain(queueSeatInstanceId)

    // DISCRIMINATING NEGATIVE, same identity, same row, one variable: without the permission the
    // seat admits nothing. `= ANY(...)` is exact equality, so the suite's ordinary `*:*` token does
    // not match either — asserted rather than assumed.
    expect(await scopeOnlyIds({ actorId: queueHolderId })).not.toContain(queueSeatInstanceId)
    expect(await scopeOnlyIds({ actorId: queueHolderId, actorPermissions: ['*:*'] }))
      .not.toContain(queueSeatInstanceId)

    // Over the ROUTE, on the `pending` tab the shipped inbox sends: a token carrying the permission
    // reaches the row, the same identity's ordinary token does not. The two tokens differ by
    // EXACTLY ONE permission string, so the permission is the only variable. (`*:*` rides along in
    // both because `rbacGuard('approvals','read')` gates this endpoint on its own and a token
    // carrying only the queue string answers 403 — measured, and the reason it is spelled out here
    // rather than left as a one-element `perms`.)
    const queueToken = await authToken(queueHolderId, 'viewer', `*:*,${queuePermission}`)
    expect(await listOwnIdSet('/api/approvals?tab=pending&limit=200', queueToken))
      .toContain(queueSeatInstanceId)
    expect(await listOwnIdSet('/api/approvals?tab=pending&limit=200', await authToken(queueHolderId)))
      .not.toContain(queueSeatInstanceId)
  })

  it('(12c) the role-typed sub-arm of the CC arm is load-bearing, and binds DB roles', async () => {
    // `ccRoleInstanceId` carries a ROLE-typed CC record for `ccOnlyRoleId` and nothing else:
    // somebody else's requester, somebody else's ACTIVE seat, no `approval_records` actor row for
    // this caller, not a mirror, and `ccRoleHolderId` is not a DB-backed admin. The role half of
    // the CC arm is the ONLY arm that can admit it, so appending `AND FALSE` to that disjunct reds
    // this test and no other.
    const ccRoleIds = await scopeOnlyIds({ actorId: ccRoleHolderId })
    expect(ccRoleIds).toContain(ccRoleInstanceId)

    // DISCRIMINATING NEGATIVE, and it pins the role SOURCE at the same time: the identical role,
    // asserted as a request claim by a viewer with no `user_roles` row for it, reaches nothing. The
    // arm reads `viewerRoles` from the DB, so the claim buys nothing.
    expect(await scopeOnlyIds({ actorId: claimRoleHolderId, actorRoles: [ccOnlyRoleId] }))
      .not.toContain(ccRoleInstanceId)

    // Control that the two identities are otherwise comparable: the claim-only viewer still reaches
    // the non-platform floor, so the exclusion above is the CC arm and not that viewer being denied
    // outright.
    expect(await scopeOnlyIds({ actorId: claimRoleHolderId, actorRoles: [ccOnlyRoleId] }))
      .toEqual(nonPlatformIds.slice().sort())
    expect(ccRoleIds).toEqual([...nonPlatformIds, ccRoleInstanceId].sort())
  })

  it('(13b) the scope is conjoined into the COUNT query, not only the page query', async () => {
    // MEASURED ON A TAB-LESS SHAPE ON PURPOSE. With a tab in play the tab filter is itself
    // actor-scoped, so a count that ignored the scope would still report the tab's own narrowed
    // number and this test could not tell the two apart — the "two doors" problem test (2b)
    // records. `listApprovals` with no `tab` assembles NO tab filter, so the scope condition is the
    // only thing that can narrow either query, and `workflowKey` restricts both to this suite's own
    // rows so `total` is an exact, assertable number on a shared database.
    const service = new ApprovalBridgeService()
    const workflowKey = `p0a-wf-${suffix}`

    const participantResult = await service.listApprovals({
      actorId: participantId,
      workflowKey,
      limit: 500,
    })
    // The COUNT must equal the scoped row count — not the number of rows carrying this workflow
    // key, which is every seeded instance.
    expect(participantResult.total).toBe(participantScopeAll.length)
    expect(participantResult.data).toHaveLength(participantResult.total)
    expect(participantResult.total).toBeLessThan(seededInstanceIds.length)

    // A caller with no relationship reaches only the non-platform floor, and their COUNT says so.
    const strangerResult = await service.listApprovals({ actorId: strangerId, workflowKey, limit: 500 })
    expect(strangerResult.total).toBe(nonPlatformIds.length)
    expect(strangerResult.data).toHaveLength(strangerResult.total)

    // An unresolvable actor's count is exactly zero, with the page to match.
    const unresolvedResult = await service.listApprovals({ workflowKey, limit: 500 })
    expect(unresolvedResult.total).toBe(0)
    expect(unresolvedResult.data).toEqual([])
  })

  it('(14) GET /api/approvals/pending applies the same server-determined scope, count included', async () => {
    // The same router, the same `rbacGuard('approvals','read')`, and list-shaped: full
    // `approval_instances` rows plus a total. It applies no tab at all, so the scope condition is
    // the ONLY thing standing between a caller and the pending platform table — which makes both
    // numbers below exact rather than bounded.
    const strangerToken = await authToken(strangerId)
    const strangerResponse = await listRaw('/api/approvals/pending?limit=200', strangerToken)
    expect(strangerResponse.status).toBe(200)
    const strangerPayload = (await strangerResponse.json()) as ListResponse
    expect(strangerPayload.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)))
      .toEqual([])
    // EXACTLY ZERO, GLOBALLY — not merely "none of this suite's rows", and the only two global
    // count assertions in this file. WHY THEY ARE SAFE ON A SHARED DATABASE, spelled out because
    // every other assertion here filters to `seededInstanceIds` and the next reader will otherwise
    // copy a bare `toBe(n)` onto a surface where it is not true. `total` is unfiltered, so it sees
    // every other suite's rows too. Arms 1-4 are actor-bound and this identity's id carries a fresh
    // per-run suffix, so no residue can reach them. Arm 5 (DB-backed admin) and arm 6
    // (non-platform, which names no actor column) are NOT suffix-protected in principle — they are
    // inert HERE for two specific reasons: this identity is seeded with `users.role = 'viewer'` and
    // `is_admin = FALSE`, and this endpoint hard-filters to platform rows, which excludes every row
    // arm 6 could admit. Change either and this number stops being exact.
    expect(strangerPayload.total).toBe(0)

    // Positive control on the identical shape: the rows exist and the endpoint reaches them.
    const participantToken = await authToken(participantId)
    const participantResponse = await listRaw('/api/approvals/pending?limit=200', participantToken)
    expect(participantResponse.status).toBe(200)
    const participantPayload = (await participantResponse.json()) as ListResponse
    const participantIds = participantPayload.data
      .map((row) => row.id)
      .filter((id) => seededInstanceIds.includes(id))
      .sort()
    expect(participantIds).toEqual(participantPendingPlatform.slice().sort())
    expect(participantIds).not.toContain(foreignPendingId)
    // Global count again, exact for the same reasons as the stranger's above: this participant is
    // seeded non-admin (so arm 5 adds nothing), arm 6's rows are excluded by the platform-only
    // conjunct, and arms 1-4 can only reach the suffixed fixture. So `total` is this fixture's own
    // four pending platform rows and nothing another suite left behind.
    expect(participantPayload.total).toBe(participantPendingPlatform.length)

    // COUNT CONSISTENCY with the badge endpoint, stated as the containment it actually is rather
    // than as an equality it is not: `pending-count` counts ACTIVE user- / role- / source_queue-
    // typed assignments, which is a SUBSET of the scope's arms (the scope also admits a requester,
    // a past actor, a CC target and a DB-backed admin). So every instance the badge counts must be
    // reachable in the scoped list, and a caller the list denies entirely must have a zero badge.
    const pendingCount = async (token: string): Promise<{ count: number }> => {
      const response = await fetch(`${baseUrl}/api/approvals/pending-count?sourceSystem=platform`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { count: number }
    }
    // The participant's two ACTIVE platform seats — both present in the scoped list above.
    expect(participantIds).toContain(seatInstanceId)
    expect(participantIds).toContain(otherOrgSeatInstanceId)
    const participantBadge = await pendingCount(participantToken)
    expect(participantBadge.count).toBe(2)
    expect(participantBadge.count).toBeLessThanOrEqual(participantPayload.total)
    // And the stranger: zero badge, zero list, zero total — consistent at the bottom too.
    expect((await pendingCount(strangerToken)).count).toBe(0)
  })

  it('(15) GET /api/approvals/pending carries the same dormant org pin as the list feed', async () => {
    const participantToken = await authToken(participantId)
    const ownPendingIds = async (): Promise<string[]> => {
      const response = await listRaw('/api/approvals/pending?limit=200', participantToken)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as ListResponse
      return payload.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)).sort()
    }

    // Shipped default (OFF): the participant's seat in a SECOND org is reachable, which is the
    // status quo this fix has no authority to change.
    expect(process.env.APPROVAL_S1_ORG_PIN_ENABLED).toBeUndefined()
    expect(await ownPendingIds()).toContain(otherOrgSeatInstanceId)

    // Forced ON in-process, exactly as tests (3b) and (10) do it on the list feed: the second-org
    // row goes, the participant's own-org rows stay. Without the org conjunct on this endpoint the
    // flag would mean one thing on `GET /api/approvals` and another on `GET /api/approvals/pending`
    // the day it is switched on.
    process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
    const pinned = await ownPendingIds()
    expect(pinned).not.toContain(otherOrgSeatInstanceId)
    expect(pinned).toEqual(
      participantPendingPlatform.filter((id) => id !== otherOrgSeatInstanceId).sort(),
    )
  })

  it('(18) GET /api/approvals/pending is where the DB-backed administrator arm is observable, and the pin bounds it', async () => {
    // WHY THIS ENDPOINT AND NOT `GET /api/approvals`. Arm 5 (the `users.is_active AND (is_admin OR
    // role = 'admin')` predicate) is in the SAME scope condition on both surfaces, but on the list
    // feed every `tab` is itself participation-bound and is ANDed with the scope, so an
    // administrator's response there is the same as anybody else's — test (6) asserts exactly that
    // over four route shapes. This endpoint applies NO tab, so arm 5's reach is visible here and
    // not on the other surface this condition is conjoined into — those two surfaces being the
    // whole population; the per-instance predicate has an admin arm of its own, which is not this
    // one. Before this test the widest arm of the newly-added scope had no gate on the surface
    // where a change to it would show.
    //
    // `adminInOrgBId` participates in NONE of the seeded rows: it is nobody's requester, holds no
    // seat, recorded no action, and is no CC target. Its token carries `roles=viewer`, so nothing
    // here can pass on a role CLAIM — the arm being measured is the database's.
    const adminToken = await authToken(adminInOrgBId)
    const ownPendingIds = async (token: string): Promise<string[]> => {
      const response = await listRaw('/api/approvals/pending?limit=200', token)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as ListResponse
      return payload.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)).sort()
    }

    // SHIPPED DEFAULT (pin OFF): the whole pending platform set, seven rows of which are org A's
    // and none of which this identity participates in.
    expect(process.env.APPROVAL_S1_ORG_PIN_ENABLED).toBeUndefined()
    const unpinned = await ownPendingIds(adminToken)
    expect(unpinned).toEqual(seededPendingPlatform.slice().sort())
    expect(unpinned).toContain(foreignPendingId)

    // DISCRIMINATING NEGATIVE on the same endpoint and the same shape: a real user whose token
    // CLAIMS the admin role while the database records `role = 'viewer'`. If the arm read claims,
    // this would match the set above; it reaches nothing, because arm 5 is DB-backed. (Test (14)
    // covers the same identity with viewer claims; this is the claim-only half.)
    expect(await ownPendingIds(await authToken(strangerId, 'admin'))).toEqual([])

    // PIN FORCED ON in-process, the shape tests (3b), (10) and (15) use: the administrator's reach
    // collapses to the one row stamped with the org it is active in. Nothing here changes the
    // shipped default — `afterEach` restores whatever the runner handed this file.
    process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
    const pinned = await ownPendingIds(adminToken)
    expect(pinned).toEqual([otherOrgSeatInstanceId])
    expect(pinned).not.toContain(foreignPendingId)

    // POSITIVE CONTROL UNDER THE SAME FLAG: the org-A administrator still reaches org A's rows, so
    // the collapse above is the org conjunct and not the pin denying every administrator.
    const orgAAdminPinned = await ownPendingIds(await authToken(adminInOrgAId))
    expect(orgAAdminPinned).toEqual(
      seededPendingPlatform.filter((id) => id !== otherOrgSeatInstanceId).sort(),
    )

    // NO GLOBAL `total` ASSERTION HERE, deliberately, and the reason is the one test (14) states in
    // place: `total` is unfiltered, and for an ADMIN identity arm 5 is live and carries no
    // per-run suffix, so every other suite's pending platform rows are inside this caller's count.
    // Test (14)'s stranger/participant counts are exact only because arm 5 is inert for them. The
    // count query's own scope is gated there; this test gates the arm.
  })

  it('(16) all five tabs answer 200 with the expected rows under sourceSystem=plm', async () => {
    // The fourth source mode, and the one this suite previously claimed was unreachable from this
    // harness. `beforeAll` connects the adapter the way the sibling wp2 suite does; the route's
    // force-sync then runs in mock mode (empty upstream list), so the seeded mirrors below are the
    // only rows in play — an upsert would change these sets.
    const token = await authToken(participantId)
    const expectedByTab: Record<string, string[]> = {
      pending: [plmForeignId, plmSeatedId],
      mine: [plmDoneId],
      cc: [plmDoneId],
      completed: [plmDoneId],
      processed: [plmDoneId],
    }

    for (const tab of ['pending', 'mine', 'cc', 'completed', 'processed']) {
      const path = `/api/approvals?tab=${tab}&sourceSystem=plm&limit=200`
      const response = await listRaw(path, token)
      expect(response.status, `${path} must answer 200`).toBe(200)
      const payload = (await response.json()) as ListResponse
      const own = payload.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)).sort()
      // NON-EMPTY on all five: a 200 carrying zero rows cannot tell "correctly empty" from "the
      // query quietly matched nothing", which is why `plmDoneId` exists in the fixture.
      expect(own.length, `${path} must return rows`).toBeGreaterThan(0)
      expect(own, `${path} row set`).toEqual(expectedByTab[tab].slice().sort())
      // Every row is a mirror: the explicit `plm` filter is doing its job and the scope's other
      // arms admit no platform row into this response.
      for (const id of own) {
        expect(nonPlatformIds, `${path} must return mirrors only`).toContain(id)
      }
    }
  })

  it('(17) a repeated, array or bracketed tab is a 400, never a silent default', async () => {
    const token = await authToken(participantId)

    // Express 4's default query parser (`extended`/qs, never overridden by this server) turns each
    // of these into an ARRAY under the key `tab`. `typeof x === 'string'` rejects an array, so each
    // shape used to fall through to "no tab supplied" and be answered on the DEFAULT tab — a
    // request that named a tab was served a different one, silently. All three are now refused in
    // the existing error envelope, with the same code an unrecognised value gets.
    for (const shape of ['tab=pending&tab=mine', 'tab[]=pending', 'tab=pending&tab=pending']) {
      const response = await listRaw(`/api/approvals?${shape}&limit=200`, token)
      expect(response.status, shape).toBe(400)
      const payload = (await response.json()) as { ok?: boolean; error?: { code?: string } }
      expect(payload.error?.code, shape).toBe('APPROVAL_TAB_INVALID')
      expect(payload.ok, shape).toBe(false)
    }

    // POSITIVE CONTROLS on the same parameter, so the 400s above are the array check and not this
    // endpoint refusing `tab` generally: the single-valued form is honoured, an EMPTY value is
    // still absent (the default tab), and an omitted key is still absent.
    expect(await listOwnIdSet('/api/approvals?tab=pending&limit=200', token))
      .toEqual([otherOrgSeatInstanceId, seatInstanceId].sort())
    expect(await listOwnIdSet('/api/approvals?tab=&limit=200', token))
      .toEqual([otherOrgSeatInstanceId, plmSeatedId, seatInstanceId].sort())
    expect(await listOwnIdSet('/api/approvals?limit=200', token))
      .toEqual([otherOrgSeatInstanceId, plmSeatedId, seatInstanceId].sort())
  })
})
