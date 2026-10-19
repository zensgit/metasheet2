/**
 * Attendance settlement coordination — the approval service's handed-over mode on a real PostgreSQL
 * (P1-1 acceptance A10 lifecycle, A07 retry ownership and A01's "only tests assemble it"; S3).
 *
 * Every leg assembles the mode by hand: a coordinator over its own `pg.Pool`, the coordinated-
 * transaction port, and the suspended-method bridge that turns the service's own COMMIT into a wait
 * on the port. Nothing in production builds this (the static inertness guard pins that).
 *
 * Fully formed rounds (a real template published through the running server, the original approved
 * over HTTP, the cancel round created in-process — the corpus's own fixture shape):
 *  - M06 creation handed over: the port commits once; the service sends no BEGIN / COMMIT / ROLLBACK
 *    and releases nothing; the request number is read on the handed-over connection and not on the
 *    main pool; the work after the service's COMMIT (projection, read-back) runs after release, with
 *    no quota held and no coordination context;
 *  - M08 reject and revoke handed over: the same lifecycle, and the round reaches its terminal outcome;
 *  - a refusal inside the handed-over dispatch is rethrown unchanged after the port's ROLLBACK, and
 *    the row is untouched.
 *
 * Attendance-sourced rounds (rows inserted directly, as the lock-order census does; the round is
 * half-formed, which carries everything up to and including the post-lock recheck):
 *  - a stale coordinated requirement is caught by the recheck under the row lock: the service asks
 *    the port for a restart instead of answering 409, the next attempt receives the requirement read
 *    under the lock, and three disagreements answer the entry's registered conflict code;
 *  - a canonical org: the backend holds class-00 at transaction level from S2 and the service's own
 *    class-00 call sends nothing;
 *  - a wait past the handed-over lock timeout (55P03) answers the existing 503 contention code, for a
 *    canonical and for a legacy org; without a coordinated requirement the raw 55P03 passes through;
 *  - a legacy org handed over never parses the W4 org key, while the default path on the same round
 *    still fails in the key parser (the pre-existing behaviour the design's §15 E-f records, which
 *    P1-3 retires by routing legacy rounds through this mode).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { MetaSheetServer } from '../../src/index'
import { pool as mainPool } from '../../src/db/pg'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, ensureLocalUserRow, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import {
  ApprovalProductService,
  resolveCancelRoundRolloutLockRequirementV1,
  type ApprovalSettlementCoordinationHandoverV1,
  type CancelRoundRolloutLockRequirementV1,
} from '../../src/services/ApprovalProductService'
import { CancelRoundOutletForbiddenError } from '../../src/services/ApprovalBridgeService'
import { APPROVAL_POLICY_DENIED_ACTION, type ApprovalActionRequest } from '../../src/types/approval-product'
import { CANCEL_ROUND_APPROVAL_NODE_KEY, CANCEL_ROUND_PUBLISHED_DEFINITION_ID } from '../../src/db/seeds/approval-cancel-round-published-definition'
import { W4_TRANSACTION_LOCK_TIMEOUT_MS } from '../../src/attendance/w4c0-operation-contract'
import { isCancelRoundInstance } from '../../src/attendance/w4c3b-central-approval-hooks'
import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import { currentSettlementCoordinationContextV1 } from '../../src/attendance/coordination/settlement-coordination-context'
import { planSettlementCoordinationV1 } from '../../src/attendance/coordination/settlement-coordination-handover'
import {
  coordinatedTransactionV1,
  handOverToSuspendedMethodV1,
  type SettlementCoordinationBodyContextV1,
} from '../../src/attendance/coordination/settlement-coordination-port'
import {
  SettlementCoordinationScopeChangedError,
  createSettlementCoordinatorV1,
  type SettlementCoordinationUnitRequestV1,
  type SettlementCoordinatorV1,
} from '../../src/attendance/coordination/settlement-coordinator'
import { advisoryLocksOf, backendPid, isBigintLock } from '../helpers/settlement-coordination-db'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const DESTROY = new Error('test: never hand a test connection to the next test')
const ATTENDANCE_WORKFLOW_KEY = 'attendance.request'
const CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'
/** The class-00 helper's own statement (w4c0-identity); the service must never send it when handed over. */
const CLASS_ZERO_SHARED = 'SELECT pg_advisory_xact_lock_shared($1::bigint)'
const TRANSACTION_CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i
const PROBE_ACTOR = { userId: 'wi-handover-probe-actor', userName: 'handover probe', roles: [] as string[] }

const READ_COMMITTED: SettlementCoordinationUnitRequestV1 = {
  needsClassZero: false,
  quotaClass: 'short',
  handover: { isolation: 'READ COMMITTED', timeouts: { kind: 'none' }, entryLabel: 'test.m06-m08' },
}
/**
 * The M07 unit request. `needsClassZero` is the entry's dependency, not the org's kind: the planner
 * takes class-00 for a canonical org and leaves it out for a legacy one, attempt by attempt, so an
 * org that changes kind on a recheck restart is coordinated correctly either way (Codex S3 §4 C).
 */
function m07(lockTimeoutMs?: number): SettlementCoordinationUnitRequestV1 {
  return {
    needsClassZero: true,
    quotaClass: 'short',
    handover: {
      isolation: 'SERIALIZABLE',
      // r6.1 §3.2 step 6: M07's S2 sets only lock_timeout (W4_TRANSACTION_LOCK_TIMEOUT_MS by default) and
      // keeps the session's statement_timeout.
      timeouts: { kind: 'lock-timeout-only', lockTimeoutMs: lockTimeoutMs ?? W4_TRANSACTION_LOCK_TIMEOUT_MS },
      entryLabel: 'test.m07',
    },
  }
}
const CANONICAL_ORG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface AttemptRecord {
  attempt: number
  org: string
  recheck: unknown
  /** Statements the service sent on the handed-over connection. */
  method: string[]
  /** Statements sent once the service asked to commit, or after it settled: the port's. */
  port: string[]
  releases: number
  /** What the service saw when its COMMIT returned. */
  resumed: { context: unknown; held: number; idle: number; total: number } | null
}

interface World {
  coordinator: SettlementCoordinatorV1
  pool: Pool
  attempts: AttemptRecord[]
}

function statementText(text: unknown): string {
  return typeof text === 'string' ? text : String((text as { text?: unknown } | null)?.text ?? text)
}

/**
 * Runs `method` in handed-over mode on the attempt's connection and records what the service did
 * with it: the statements it sent (its own, then the port's once it asked to commit), the releases
 * it caused, and what it saw when its COMMIT returned.
 */
async function drive<T>(
  context: SettlementCoordinationBodyContextV1,
  world: World,
  fields: Pick<ApprovalSettlementCoordinationHandoverV1, 'rolloutLock' | 'canonicalOrg'>,
  method: (handover: ApprovalSettlementCoordinationHandoverV1) => Promise<T>,
  faults: { readonly commitSerializationFailure?: boolean } = {},
) {
  const client = context.client as unknown as PoolClient
  const record: AttemptRecord = {
    attempt: context.attempt,
    org: context.orgLexical,
    recheck: context.recheck,
    method: [],
    port: [],
    releases: 0,
    resumed: null,
  }
  world.attempts.push(record)
  let phase: 'method' | 'port' = 'method'
  // The prototype's query: a wrapper left by an earlier attempt on this pooled connection is replaced, not stacked.
  const realQuery = (Object.getPrototypeOf(client) as { query: (...args: unknown[]) => unknown }).query
  let commitFaulted = false
  Object.defineProperty(client, 'query', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      const text = statementText(args[0])
      ;(phase === 'method' ? record.method : record.port).push(text)
      if (phase === 'port' && text.trim() === 'COMMIT' && faults.commitSerializationFailure && !commitFaulted) {
        // What a real 40001 at COMMIT leaves behind: the server has rolled the transaction back.
        commitFaulted = true
        return (async () => {
          await realQuery.call(client, 'ROLLBACK')
          throw Object.assign(new Error('could not serialize access due to read/write dependencies among transactions'), { code: '40001' })
        })()
      }
      return realQuery.apply(client, args)
    },
  })
  const realRelease = client.release
  Object.defineProperty(client, 'release', {
    configurable: true,
    writable: true,
    value: (error?: Error | boolean) => {
      record.releases += 1
      // The attempt's connection goes back to the pool here: stop recording, so that the next
      // attempt's S1 / BEGIN / S2 on the same pooled connection are not booked to this attempt.
      delete (client as { query?: unknown }).query
      return realRelease.call(client, error)
    },
  })
  return handOverToSuspendedMethodV1(context, async (commit) => {
    const handover: ApprovalSettlementCoordinationHandoverV1 = {
      client: client as unknown as ApprovalSettlementCoordinationHandoverV1['client'],
      ...fields,
      commit: async () => {
        phase = 'port'
        await commit()
        record.resumed = {
          context: currentSettlementCoordinationContextV1(),
          held: world.coordinator.deps.quota.snapshot().global.short.held,
          idle: world.pool.idleCount,
          total: world.pool.totalCount,
        }
      },
    }
    try {
      return await method(handover)
    } finally {
      phase = 'port'
    }
  })
}

function coordinatorOn(pool: Pool): SettlementCoordinatorV1 {
  return createSettlementCoordinatorV1({
    pool: { connect: () => pool.connect() },
    capacity: deriveSettlementCoordinationCapacityV1({ poolMax: 20 }),
    connectTimeoutMs: 10_000,
  })
}

function expectBaseline(coordinator: SettlementCoordinatorV1): void {
  const { quota, ledger } = coordinator.deps
  expect(quota.snapshot()).toEqual({ global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] })
  expect(ledger.snapshot().holding).toEqual([])
  expect(ledger.snapshot().inFlight).toEqual({ short: 0, long: 0 })
  expect(ledger.selfCheck(quota.snapshot())).toEqual([])
}

function world(): World & { end(): Promise<void> } {
  const pool = new Pool({ connectionString: dbUrl, max: 1 })
  return { coordinator: coordinatorOn(pool), pool, attempts: [], end: () => pool.end() }
}

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

const mintedUserIds = new Set<string>()

async function authToken(baseUrl: string, userId: string): Promise<string> {
  await ensureLocalUserRow(userId)
  mintedUserIds.add(userId)
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { token: string }
  return payload.token
}

async function jsonRequest(baseUrl: string, path: string, token: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function oneNodeGraph(approverId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

describeIfDatabase('attendance settlement coordination — the approval service handed over (real database)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let observer: Pool
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRoundIds = new Set<string>()
  const grantedUserIds = new Set<string>()
  const rawInstanceIds: string[] = []
  const rawRequestIds: string[] = []
  const rawRoundIds: string[] = []

  const main = () => poolManager.get()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    observer = new Pool({ connectionString: dbUrl, max: 3 })
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  }, 120_000)

  afterAll(async () => {
    try {
      if (rawRoundIds.length > 0) await observer.query('DELETE FROM approval_rounds WHERE id = ANY($1::text[])', [rawRoundIds])
      if (rawRequestIds.length > 0) await observer.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [rawRequestIds])
      if (rawInstanceIds.length > 0) await observer.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [rawInstanceIds])
      const approvalIds = [...createdApprovalIds]
      const roundIds = [...createdRoundIds]
      const templateIds = [...createdTemplateIds]
      if (roundIds.length > 0) await main().query('DELETE FROM approval_rounds WHERE id = ANY($1::text[])', [roundIds])
      if (approvalIds.length > 0) {
        await main().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await main().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await main().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await main().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await main().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await main().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await main().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (mintedUserIds.size > 0) {
        await main().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...mintedUserIds]])
        mintedUserIds.clear()
      }
      if (grantedUserIds.size > 0) await main().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedUserIds]])
    } finally {
      await observer?.end()
      await server?.stop()
    }
  }, 60_000)

  // ── fully formed rounds, through the running server ───────────────────────────────────────────

  async function publishTemplate(adminToken: string, graph: unknown, label: string): Promise<string> {
    const templateKey = `wi-handover-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'settlement handover cancel-round fixture',
        description: 'attendance-coordination-approval-handover.db.test.ts',
        formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
        approvalGraph: graph,
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = (await create.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return template.id
  }

  async function approvedDocument(label: string): Promise<{ documentId: string; requesterId: string; approverId: string }> {
    const suffix = `${label}-${TS}-${Math.floor(Math.random() * 1e6)}`
    const approverId = `wi-handover-apr-${suffix}`
    const requesterId = `wi-handover-req-${suffix}`
    grantedUserIds.add(requesterId)
    await grantApprovalWriteForIntegrationActor(requesterId)
    const adminToken = await authToken(baseUrl, `wi-handover-admin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)
    const templateId = await publishTemplate(adminToken, oneNodeGraph(approverId), label)
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)
    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, approverToken, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)
    return { documentId, requesterId, approverId }
  }

  async function trackRound(engineInstanceId: string): Promise<void> {
    const row = await main().query<{ id: string }>('SELECT id FROM approval_rounds WHERE engine_instance_id = $1', [engineInstanceId])
    for (const round of row.rows) createdRoundIds.add(round.id)
  }

  async function pendingCancelRound(label: string) {
    const doc = await approvedDocument(label)
    const dto = await new ApprovalProductService().createCancelRoundInstance(doc.documentId, { userId: doc.requesterId })
    createdApprovalIds.add(dto.id)
    await trackRound(dto.id)
    const row = await main().query('SELECT * FROM approval_instances WHERE id = $1', [dto.id])
    expect(isCancelRoundInstance(row.rows[0])).toBe(true)
    return { ...doc, roundInstanceId: dto.id }
  }

  async function roundOutcome(engineInstanceId: string): Promise<string | null> {
    const row = await main().query<{ outcome: string }>('SELECT outcome FROM approval_rounds WHERE engine_instance_id = $1', [engineInstanceId])
    return row.rows[0]?.outcome ?? null
  }

  async function instanceState(id: string): Promise<{ status: string; version: number } | null> {
    const row = await main().query<{ status: string; version: number }>('SELECT status, version FROM approval_instances WHERE id = $1', [id])
    return row.rows[0] ?? null
  }

  function expectOneCommittedAttempt(attempts: AttemptRecord[]): AttemptRecord {
    expect(attempts).toHaveLength(1)
    const [run] = attempts
    expect(run.method.filter((s) => TRANSACTION_CONTROL.test(s))).toEqual([])
    expect(run.port.map((s) => s.trim())).toEqual(['COMMIT'])
    expect(run.releases).toBe(1)
    expect(run.resumed).toEqual({ context: null, held: 0, idle: 1, total: 1 })
    return run
  }

  function expectOneRolledBackAttempt(attempts: AttemptRecord[]): AttemptRecord {
    expect(attempts).toHaveLength(1)
    const [run] = attempts
    expect(run.method.filter((s) => TRANSACTION_CONTROL.test(s))).toEqual([])
    expect(run.port.map((s) => s.trim())).toEqual(['ROLLBACK'])
    expect(run.releases).toBe(1)
    expect(run.resumed).toBeNull()
    return run
  }

  it('M06 handed over: the port owns the transaction, the request number is read on the handed-over connection, and the work after the service COMMIT runs after release', async () => {
    const doc = await approvedDocument('m06')
    const w = world()
    const mainQueries = vi.spyOn(mainPool as unknown as { query: (...args: unknown[]) => unknown }, 'query')
    try {
      const dto = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, w, {}, (handover) =>
            new ApprovalProductService().createCancelRoundInstance(doc.documentId, { userId: doc.requesterId }, { settlementCoordinationHandover: handover }),
          ),
      })
      createdApprovalIds.add(dto.id)
      await trackRound(dto.id)
      const run = expectOneCommittedAttempt(w.attempts)
      expect(run.method.some((s) => s.includes('approval_request_no_seq'))).toBe(true)
      expect(mainQueries.mock.calls.some(([text]) => statementText(text).includes('approval_request_no_seq'))).toBe(false)
      expect(dto.status).toBe('pending')
      expect((await instanceState(dto.id))?.status).toBe('pending')
      expect(await roundOutcome(dto.id)).toBe('pending')
      expect(w.pool.idleCount).toBe(1)
      expectBaseline(w.coordinator)
    } finally {
      mainQueries.mockRestore()
      await w.end()
    }
  }, 60_000)

  it('M06 handed over and refused: a second round on a document that has one pending is rethrown unchanged after the port rolls back', async () => {
    const round = await pendingCancelRound('m06-dup')
    const w = world()
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, w, {}, (handover) =>
            new ApprovalProductService().createCancelRoundInstance(round.documentId, { userId: round.requesterId }, { settlementCoordinationHandover: handover }),
          ),
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toMatchObject({ statusCode: 409, code: 'CANCEL_ROUND_ALREADY_PENDING' })
      expect(await roundOutcome(round.roundInstanceId)).toBe('pending')
      expectOneRolledBackAttempt(w.attempts)
      expect(w.pool.idleCount).toBe(1)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 60_000)

  it('M08 reject handed over: the round ends rejected; the service sends no transaction control and releases nothing', async () => {
    const round = await pendingCancelRound('reject')
    const w = world()
    try {
      const dto = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, w, { rolloutLock: { kind: 'none' } }, (handover) =>
            new ApprovalProductService().dispatchAction(
              round.roundInstanceId,
              { action: 'reject', comment: 'handed-over reject' } as ApprovalActionRequest,
              { userId: round.approverId, userName: 'handed-over approver', roles: [] },
              handover,
            ),
          ),
      })
      expect(dto.status).toBe('rejected')
      expect(await roundOutcome(round.roundInstanceId)).toBe('rejected')
      expect((await instanceState(round.roundInstanceId))?.status).toBe('rejected')
      expectOneCommittedAttempt(w.attempts)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 60_000)

  it('M08 revoke handed over: the requester withdraws the round through the port', async () => {
    const round = await pendingCancelRound('revoke')
    const w = world()
    try {
      const dto = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, w, { rolloutLock: { kind: 'none' } }, (handover) =>
            new ApprovalProductService().dispatchAction(
              round.roundInstanceId,
              { action: 'revoke' } as ApprovalActionRequest,
              { userId: round.requesterId, userName: 'handed-over requester', roles: [] },
              handover,
            ),
          ),
      })
      expect(dto.status).toBe('revoked')
      expect(await roundOutcome(round.roundInstanceId)).toBe('withdrawn')
      expectOneCommittedAttempt(w.attempts)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 60_000)

  it('a refusal inside the handed-over dispatch is rethrown unchanged after the port rolls back, and the row is untouched', async () => {
    const round = await pendingCancelRound('refusal')
    const before = await instanceState(round.roundInstanceId)
    const w = world()
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, w, { rolloutLock: { kind: 'none' } }, (handover) =>
            new ApprovalProductService().dispatchAction(
              round.roundInstanceId,
              { action: 'handle' } as ApprovalActionRequest,
              { userId: round.approverId, userName: 'handed-over approver', roles: [] },
              handover,
            ),
          ),
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toMatchObject({ statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' })
      expect(await instanceState(round.roundInstanceId)).toEqual(before)
      expect(await roundOutcome(round.roundInstanceId)).toBe('pending')
      expectOneRolledBackAttempt(w.attempts)
      expect(w.pool.idleCount).toBe(1)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 60_000)

  // ── attendance-sourced rounds, rows inserted directly ─────────────────────────────────────────

  async function seedAttendanceCancelRound(requestOrg: string): Promise<{
    roundInstanceId: string
    originalInstanceId: string
    requestId: string
    requestOrg: string
  }> {
    const instanceOrg = crypto.randomUUID()
    const originalInstanceId = `wi-handover-original-${crypto.randomUUID()}`
    await observer.query(`INSERT INTO approval_instances (id, status, workflow_key, org_id) VALUES ($1, 'approved', $2, $3)`, [
      originalInstanceId,
      ATTENDANCE_WORKFLOW_KEY,
      instanceOrg,
    ])
    rawInstanceIds.push(originalInstanceId)
    const requestId = crypto.randomUUID()
    await observer.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
       VALUES ($1, $2, CURRENT_DATE, 'leave', 'approved', $3, $4, $5)`,
      [requestId, crypto.randomUUID(), requestOrg, originalInstanceId, ATTENDANCE_WORKFLOW_KEY],
    )
    rawRequestIds.push(requestId)
    const roundInstanceId = `wi-handover-round-${crypto.randomUUID()}`
    await observer.query(`INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id) VALUES ($1, 'pending', $2, $3, $4)`, [
      roundInstanceId,
      CANCEL_ROUND_WORKFLOW_KEY,
      originalInstanceId,
      instanceOrg,
    ])
    rawInstanceIds.push(roundInstanceId)
    const roundId = `wi-handover-roundrow-${crypto.randomUUID()}`
    await observer.query(
      `INSERT INTO approval_rounds (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
       VALUES ($1, $2, 'cancel', $3, $4, 'pending', '{}'::jsonb)`,
      [roundId, originalInstanceId, roundInstanceId, `wi-handover-requester-${crypto.randomUUID()}`],
    )
    rawRoundIds.push(roundId)
    return { roundInstanceId, originalInstanceId, requestId, requestOrg }
  }

  /** What the production pre-read says for this round — the port's candidate in P1-3. */
  async function productionRequirement(roundInstanceId: string): Promise<CancelRoundRolloutLockRequirementV1> {
    const client = await observer.connect()
    try {
      return await resolveCancelRoundRolloutLockRequirementV1(
        client as unknown as Parameters<typeof resolveCancelRoundRolloutLockRequirementV1>[0],
        roundInstanceId,
        'approve',
      )
    } finally {
      client.release()
    }
  }

  function approveHandedOver(w: World, roundInstanceId: string, fields: Pick<ApprovalSettlementCoordinationHandoverV1, 'rolloutLock' | 'canonicalOrg'>) {
    return (context: SettlementCoordinationBodyContextV1) =>
      drive(context, w, fields, (handover) =>
        new ApprovalProductService().dispatchAction(roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR, handover),
      )
  }

  async function holdingRowLock<T>(roundInstanceId: string, body: () => Promise<T>): Promise<T> {
    const rival = await observer.connect()
    try {
      await rival.query('BEGIN')
      await rival.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [roundInstanceId])
      return await body()
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined)
      rival.release(DESTROY)
    }
  }

  it('a stale coordinated requirement is caught under the row lock: the service asks for a restart, the next attempt receives the requirement read under the lock; the canonical class-00 call sends nothing while S2 holds the key', async () => {
    const seeded = await seedAttendanceCancelRound(crypto.randomUUID())
    const real = await productionRequirement(seeded.roundInstanceId)
    expect(real).toEqual({ kind: 'required', orgId: seeded.requestOrg, documentId: seeded.originalInstanceId, requestId: seeded.requestId })
    const classZeroKey = planSettlementCoordinationV1(seeded.requestOrg, { needsClassZero: true }).classZeroKey as bigint
    const w = world()
    let classZeroHeld: boolean | null = null
    try {
      const result = await coordinatedTransactionV1<unknown>({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: m07(),
        candidate: { org: seeded.requestOrg },
        body: async (context) => {
          if (context.attempt > 1) return { restarted: true, org: context.orgLexical, recheck: context.recheck }
          const pid = await backendPid(context.client as unknown as PoolClient)
          classZeroHeld = (await advisoryLocksOf(observer, pid)).some((row) => isBigintLock(row, classZeroKey) && row.granted && row.mode === 'ShareLock')
          // The same org, another request id: the prefix lock finds no row, the row lock is taken, the recheck disagrees.
          return drive(context, w, { rolloutLock: { ...real, requestId: crypto.randomUUID() } as CancelRoundRolloutLockRequirementV1, canonicalOrg: true }, (handover) =>
            new ApprovalProductService().dispatchAction(seeded.roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR, handover),
          )
        },
      })
      expect(w.attempts).toHaveLength(1)
      const [first] = w.attempts
      expect(result).toEqual({ restarted: true, org: first.org, recheck: real })
      expect(classZeroHeld).toBe(true)
      expect(first.method.some((s) => s.includes(CLASS_ZERO_SHARED))).toBe(false)
      expect(first.method.some((s) => /FOR UPDATE/i.test(s))).toBe(true)
      expect(first.method.filter((s) => TRANSACTION_CONTROL.test(s))).toEqual([])
      expect(first.port.map((s) => s.trim())).toEqual(['ROLLBACK'])
      expect(first.releases).toBe(1)
      expect(first.resumed).toBeNull()
      expect(await productionRequirement(seeded.roundInstanceId)).toEqual(real)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 30_000)

  it("three disagreements answer the entry's registered conflict code, each attempt rolled back and released", async () => {
    const seeded = await seedAttendanceCancelRound(crypto.randomUUID())
    const real = await productionRequirement(seeded.roundInstanceId)
    const w = world()
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: m07(),
        candidate: { org: seeded.requestOrg },
        body: (context) =>
          drive(context, w, { rolloutLock: { ...real, requestId: crypto.randomUUID() } as CancelRoundRolloutLockRequirementV1, canonicalOrg: true }, (handover) =>
            new ApprovalProductService().dispatchAction(seeded.roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR, handover),
          ),
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toBeInstanceOf(SettlementCoordinationScopeChangedError)
      expect((failure as SettlementCoordinationScopeChangedError).code).toBe('CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED')
      expect(w.attempts).toHaveLength(3)
      for (const run of w.attempts) {
        expect(run.port.map((s) => s.trim())).toEqual(['ROLLBACK'])
        expect(run.releases).toBe(1)
        expect(run.resumed).toBeNull()
      }
      expect(w.pool.idleCount).toBe(1)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 30_000)

  it('a wait past the handed-over lock timeout answers the existing contention code (canonical org, class-00 not re-sent)', async () => {
    const seeded = await seedAttendanceCancelRound(crypto.randomUUID())
    const real = await productionRequirement(seeded.roundInstanceId)
    const w = world()
    try {
      const failure = await holdingRowLock(seeded.roundInstanceId, () =>
        coordinatedTransactionV1({
          transactionDepth: () => 0,
          coordinator: w.coordinator,
          request: m07(300),
          candidate: { org: seeded.requestOrg },
          body: approveHandedOver(w, seeded.roundInstanceId, { rolloutLock: real, canonicalOrg: true }),
        }).then(
          () => null,
          (error) => error,
        ),
      )
      expect(failure).toMatchObject({ statusCode: 503, code: 'CANCEL_ROUND_DISPATCH_CONTENDED' })
      const run = expectOneRolledBackAttempt(w.attempts)
      expect(run.method.some((s) => s.includes(CLASS_ZERO_SHARED))).toBe(false)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 30_000)

  it('without a coordinated requirement the raw lock-timeout error passes through unchanged', async () => {
    const seeded = await seedAttendanceCancelRound(crypto.randomUUID())
    const w = world()
    try {
      const failure = await holdingRowLock(seeded.roundInstanceId, () =>
        coordinatedTransactionV1({
          transactionDepth: () => 0,
          coordinator: w.coordinator,
          request: {
            needsClassZero: false,
            quotaClass: 'short',
            handover: { isolation: 'READ COMMITTED', timeouts: { kind: 'lock-timeout-only', lockTimeoutMs: 300 }, entryLabel: 'test.control' },
          },
          candidate: { org: crypto.randomUUID() },
          body: approveHandedOver(w, seeded.roundInstanceId, { rolloutLock: { kind: 'none' } }),
        }).then(
          () => null,
          (error) => error,
        ),
      )
      expect((failure as { code?: unknown }).code).toBe('55P03')
      expect((failure as { statusCode?: unknown }).statusCode).toBeUndefined()
      expectOneRolledBackAttempt(w.attempts)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 30_000)

  it('a legacy org handed over: no class-00, no org-key parse, and the same contention code; the default path on the same round still fails in the key parser', async () => {
    const legacyOrg = `legacy-org-${TS}-${Math.floor(Math.random() * 1e6)}`
    const seeded = await seedAttendanceCancelRound(legacyOrg)
    const real = await productionRequirement(seeded.roundInstanceId)
    expect(real).toMatchObject({ kind: 'required', orgId: legacyOrg })
    const w = world()
    try {
      const failure = await holdingRowLock(seeded.roundInstanceId, () =>
        coordinatedTransactionV1({
          transactionDepth: () => 0,
          coordinator: w.coordinator,
          request: m07(300),
          candidate: { org: legacyOrg },
          body: approveHandedOver(w, seeded.roundInstanceId, { rolloutLock: real, canonicalOrg: false }),
        }).then(
          () => null,
          (error) => error,
        ),
      )
      expect(failure).toMatchObject({ statusCode: 503, code: 'CANCEL_ROUND_DISPATCH_CONTENDED' })
      const run = expectOneRolledBackAttempt(w.attempts)
      expect(run.method.some((s) => s.includes(CLASS_ZERO_SHARED))).toBe(false)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }

    // Control — the default path (not handed over) on the same legacy round: SERIALIZABLE BEGIN, then
    // the class-00 acquisition parses the org key and refuses it (design §15 E-f, pre-existing). What
    // this pins is that the default path is unchanged by S3; P1-3 retires E-f by routing legacy rounds
    // through the handed-over mode and flips this control in the same commit.
    const control = await new ApprovalProductService()
      .dispatchAction(seeded.roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR)
      .then(
        () => null,
        (error) => error,
      )
    expect(control).toBeInstanceOf(Error)
    const described = `${String((control as { code?: unknown }).code)} ${String((control as Error).message)}`
    expect(described).toContain('W4C0_ROLLOUT_ORG_KEY_INVALID')
  }, 30_000)

  // ── review round 1 (Codex S3 §4 B / C): kind changes, cancel-round only, the M07 COMMIT mapping ──

  it('a recheck that moves the round from a canonical to a legacy org: attempt 2 runs the whole dispatch under the legacy org (no class-00, no key parse) and ends with the method\'s own outcome', async () => {
    const legacyOrg = `legacy-org-${TS}-${Math.floor(Math.random() * 1e6)}`
    const seeded = await seedAttendanceCancelRound(legacyOrg)
    const real = await productionRequirement(seeded.roundInstanceId)
    const staleCanonical = { ...real, orgId: crypto.randomUUID() } as CancelRoundRolloutLockRequirementV1
    const w = world()
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: m07(),
        candidate: { org: (staleCanonical as { orgId: string }).orgId },
        body: (context) =>
          drive(context, w, { rolloutLock: (context.recheck as CancelRoundRolloutLockRequirementV1 | null) ?? staleCanonical, canonicalOrg: CANONICAL_ORG.test(context.orgLexical) }, (handover) =>
            new ApprovalProductService().dispatchAction(seeded.roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR, handover),
          ),
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toMatchObject({ statusCode: 409, code: 'APPROVAL_RUNTIME_UNSUPPORTED' })
      expect(w.attempts.map((run) => run.org)).toEqual([(staleCanonical as { orgId: string }).orgId, legacyOrg])
      expect(w.attempts[1].recheck).toEqual(real)
      for (const run of w.attempts) {
        expect(run.method.some((sql) => sql.includes(CLASS_ZERO_SHARED))).toBe(false)
        expect(run.method.filter((sql) => TRANSACTION_CONTROL.test(sql))).toEqual([])
        expect(run.port.map((sql) => sql.trim())).toEqual(['ROLLBACK'])
        expect(run.releases).toBe(1)
      }
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 30_000)

  it('a recheck that moves the round from a legacy to a canonical org: attempt 2 holds class-00 from S2, the class-00 call sends nothing, and the dispatch runs to the method\'s own outcome', async () => {
    const seeded = await seedAttendanceCancelRound(crypto.randomUUID())
    const real = await productionRequirement(seeded.roundInstanceId)
    const staleLegacy = { ...real, orgId: `legacy-org-${TS}-${Math.floor(Math.random() * 1e6)}` } as CancelRoundRolloutLockRequirementV1
    const classZeroKey = planSettlementCoordinationV1(seeded.requestOrg, { needsClassZero: true }).classZeroKey as bigint
    const held: boolean[] = []
    const w = world()
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: m07(),
        candidate: { org: (staleLegacy as { orgId: string }).orgId },
        body: async (context) => {
          const pid = await backendPid(context.client as unknown as PoolClient)
          held.push((await advisoryLocksOf(observer, pid)).some((row) => isBigintLock(row, classZeroKey) && row.granted && row.mode === 'ShareLock'))
          return drive(context, w, { rolloutLock: (context.recheck as CancelRoundRolloutLockRequirementV1 | null) ?? staleLegacy, canonicalOrg: CANONICAL_ORG.test(context.orgLexical) }, (handover) =>
            new ApprovalProductService().dispatchAction(seeded.roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR, handover),
          )
        },
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toMatchObject({ statusCode: 409, code: 'APPROVAL_RUNTIME_UNSUPPORTED' })
      expect(w.attempts.map((run) => run.org)).toEqual([(staleLegacy as { orgId: string }).orgId, seeded.requestOrg])
      expect(held).toEqual([false, true])
      expect(w.attempts[1].method.some((sql) => sql.includes(CLASS_ZERO_SHARED))).toBe(false)
      for (const run of w.attempts) expect(run.port.map((sql) => sql.trim())).toEqual(['ROLLBACK'])
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 30_000)

  it('an ordinary (non-cancel-round) instance is refused in handed-over mode before any write; the row is untouched', async () => {
    const doc = await approvedDocument('ordinary')
    const before = await instanceState(doc.documentId)
    const w = world()
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, w, { rolloutLock: { kind: 'none' } }, (handover) =>
            new ApprovalProductService().dispatchAction(
              doc.documentId,
              { action: 'comment', comment: 'handed-over comment' } as ApprovalActionRequest,
              { userId: doc.requesterId, userName: 'handed-over requester', roles: [] },
              handover,
            ),
          ),
      }).then(
        () => null,
        (error) => error,
      )
      expect((failure as Error).message).toBe('settlement coordination: only a cancel-round instance is dispatched handed over')
      expect(await instanceState(doc.documentId)).toEqual(before)
      expectOneRolledBackAttempt(w.attempts)
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 60_000)

  it('the M07 COMMIT mapping: a 40001 at the port\'s COMMIT is answered by the entry\'s own error, never a restart; one body, one COMMIT attempt, the method wakes abandoned, nothing persists', async () => {
    const round = await pendingCancelRound('commit-40001')
    const w = world()
    const contended = Object.assign(new Error('test: entry mapping'), { statusCode: 503, code: 'CANCEL_ROUND_DISPATCH_CONTENDED' })
    try {
      const failure = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: w.coordinator,
        request: m07(),
        candidate: { org: crypto.randomUUID() },
        onRetryableCommit: () => contended,
        body: (context) =>
          drive(
            context,
            w,
            { rolloutLock: { kind: 'none' } },
            (handover) =>
              new ApprovalProductService().dispatchAction(
                round.roundInstanceId,
                { action: 'reject', comment: 'handed-over reject' } as ApprovalActionRequest,
                { userId: round.approverId, userName: 'handed-over approver', roles: [] },
                handover,
              ),
            { commitSerializationFailure: true },
          ),
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toBe(contended)
      expect(w.attempts).toHaveLength(1)
      expect(w.attempts[0].port.map((sql) => sql.trim())).toEqual(['COMMIT'])
      expect(w.attempts[0].releases).toBe(1)
      expect(w.attempts[0].resumed).toBeNull()
      expect(await roundOutcome(round.roundInstanceId)).toBe('pending')
      expect((await instanceState(round.roundInstanceId))?.status).toBe('pending')
      expectBaseline(w.coordinator)
    } finally {
      await w.end()
    }
  }, 60_000)

  // ── review round 1, Opus findings: the default path's 55P03, and A10 ①② on a real cancel round ──

  async function policyDenials(instanceId: string): Promise<number> {
    const rows = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM approval_records WHERE instance_id = $1 AND action = $2', [
      instanceId,
      APPROVAL_POLICY_DENIED_ACTION,
    ])
    return rows.rows[0]?.n ?? 0
  }

  it('the default path keeps the raw 55P03: a row-lock wait past the class-00 helper\'s lock timeout is not mapped to 503 (Opus P2-2)', async () => {
    const seeded = await seedAttendanceCancelRound(crypto.randomUUID())
    const failure = await holdingRowLock(seeded.roundInstanceId, () =>
      new ApprovalProductService().dispatchAction(seeded.roundInstanceId, { action: 'approve' } as ApprovalActionRequest, PROBE_ACTOR).then(
        () => null,
        (error) => error,
      ),
    )
    expect((failure as { code?: unknown }).code).toBe('55P03')
    expect((failure as { statusCode?: unknown }).statusCode).toBeUndefined()
  }, 60_000)

  async function recordCount(instanceId: string, action: string): Promise<number> {
    const rows = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM approval_records WHERE instance_id = $1 AND action = $2', [instanceId, action])
    return rows.rows[0]?.n ?? 0
  }

  // Opus S3 closure P3-N4: handed over, the policy branch fails closed before COMMIT and the port rolls
  // its denial row back, so "no policy_denied row" alone cannot tell whether the branch ran. Each
  // action's own result is asserted instead; a dispatch that entered the branch ends in the plain
  // "unreachable when handed over" error and fails both (oscl_19).
  it('A10 ①: a handed-over comment commits its one record and a handed-over approve reaches its own refusal past the policy gate; neither enters the node-operation policy branch (kills oscl_19)', async () => {
    const round = await pendingCancelRound('a10-allowed')
    expect(await recordCount(round.roundInstanceId, 'comment')).toBe(0)
    const commenting = world()
    const approving = world()
    try {
      const commented = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: commenting.coordinator,
        request: READ_COMMITTED,
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, commenting, { rolloutLock: { kind: 'none' } }, (handover) =>
            new ApprovalProductService().dispatchAction(
              round.roundInstanceId,
              { action: 'comment', comment: 'handed-over comment' } as ApprovalActionRequest,
              { userId: round.approverId, userName: 'handed-over approver', roles: [] },
              handover,
            ),
          ),
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      // The comment branch's own result: the round's DTO back, one comment record, committed by the
      // port in exactly one attempt; the round stays pending.
      expect(commented).toMatchObject({ value: { id: round.roundInstanceId, status: 'pending' } })
      expectOneCommittedAttempt(commenting.attempts)
      expect(await recordCount(round.roundInstanceId, 'comment')).toBe(1)
      const afterComment = await instanceState(round.roundInstanceId)
      expect(afterComment?.status).toBe('pending')
      expect(await roundOutcome(round.roundInstanceId)).toBe('pending')
      expectBaseline(commenting.coordinator)

      const approved = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator: approving.coordinator,
        request: m07(),
        candidate: { org: crypto.randomUUID() },
        body: (context) =>
          drive(context, approving, { rolloutLock: { kind: 'none' } }, (handover) =>
            new ApprovalProductService().dispatchAction(
              round.roundInstanceId,
              { action: 'approve' } as ApprovalActionRequest,
              { userId: round.approverId, userName: 'handed-over approver', roles: [] },
              handover,
            ),
          ),
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      // The approve's own result on a round whose original document has no attendance request behind
      // it: the terminal approve reaches the in-lock final evaluation (after the policy gate) and is
      // refused there with 409 CANCEL_ROUND_BUSINESS_TARGET_MISSING (the same refusal the default
      // path gives in approval-cancel-round-redemption.db.test.ts); the port rolls back in one attempt.
      expect(approved).toMatchObject({ error: { statusCode: 409, code: 'CANCEL_ROUND_BUSINESS_TARGET_MISSING' } })
      expectOneRolledBackAttempt(approving.attempts)
      expect(await instanceState(round.roundInstanceId)).toEqual(afterComment)
      expect(await roundOutcome(round.roundInstanceId)).toBe('pending')
      expect(await recordCount(round.roundInstanceId, 'comment')).toBe(1)
      expect(await policyDenials(round.roundInstanceId)).toBe(0)
      expectBaseline(approving.coordinator)
    } finally {
      await commenting.end()
      await approving.end()
    }
  }, 60_000)

  it('A10 ②: every action outside the cancel-round set is refused by the cancel-round gate before the policy check, with nothing written', async () => {
    const round = await pendingCancelRound('a10-forbidden')
    const before = await instanceState(round.roundInstanceId)
    const requests: ApprovalActionRequest[] = [
      { action: 'transfer', targetUserId: `wi-handover-target-${TS}`, comment: 'transfer' } as ApprovalActionRequest,
      { action: 'add_sign', targetUserIds: [`wi-handover-target-${TS}`], comment: 'add sign' } as ApprovalActionRequest,
      { action: 'reduce_sign', targetAssignmentUserId: round.approverId, comment: 'reduce sign' } as ApprovalActionRequest,
      { action: 'return', targetNodeKey: 'start', comment: 'return' } as ApprovalActionRequest,
    ]
    for (const request of requests) {
      const w = world()
      try {
        const failure = await coordinatedTransactionV1({
          transactionDepth: () => 0,
          coordinator: w.coordinator,
          request: READ_COMMITTED,
          candidate: { org: crypto.randomUUID() },
          body: (context) =>
            drive(context, w, { rolloutLock: { kind: 'none' } }, (handover) =>
              new ApprovalProductService().dispatchAction(
                round.roundInstanceId,
                request,
                { userId: round.approverId, userName: 'handed-over approver', roles: [] },
                handover,
              ),
            ),
        }).then(
          () => null,
          (error) => error,
        )
        expect({ action: request.action, failure }).toMatchObject({ action: request.action, failure: { statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' } })
        expectOneRolledBackAttempt(w.attempts)
        expectBaseline(w.coordinator)
      } finally {
        await w.end()
      }
    }
    expect(await instanceState(round.roundInstanceId)).toEqual(before)
    expect(await policyDenials(round.roundInstanceId)).toBe(0)
  }, 120_000)

  // ── S5 G4 (A10-P6): A10 ② as the record specified ─────────────────────────────────────────────
  //
  // DELTA-REVIEW §8 O-2 ② / TEST-MATRIX A10: the round's node carries all four `allow*` switches
  // explicitly false, and transfer / add_sign / reduce_sign / return must STILL be refused by the
  // cancel-round gate, with zero `policy_denied` rows and zero business writes. The leg above runs on
  // the seed graph, whose node leaves the switches unset (absent ≡ allowed), so swapping the gate and
  // the node-operation policy check is invisible there; here the policy check would refuse too, and
  // only the gate's own refusal is accepted.
  //
  // How the switches get there. A cancel round's runtime graph is the seeded published definition
  // that every cancel round shares (nothing in production authors it), so it is NOT edited here: a
  // concurrent suite would read the edit. Instead a fixture template whose single approval node has
  // the round's node key and the four switches false is published through the running server (the
  // production authoring path, so the stored policy is what the server's own normaliser wrote), and
  // THIS round's `published_definition_id` is pointed at it. Production never re-points a round; the
  // re-point is the fixture construct, stated as such. The service reads the policy the way it always
  // does — the instance's `published_definition_id` → `approval_published_definitions.runtime_graph`
  // — and the positive control below reads it back through the same service (`getApproval`'s
  // `nodeOperations`, built from the predicate the policy check uses) before any action is sent.

  const ALL_SWITCHES_OFF = {
    allowTransfer: false,
    allowAddSign: false,
    allowReduceSign: false,
    allowReturn: false,
    commentRequired: 'reject_only',
  } as const

  function cancelNodeSwitchesOffGraph(approverId: string) {
    return {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: CANCEL_ROUND_APPROVAL_NODE_KEY,
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'all', nodeOperationPolicy: { ...ALL_SWITCHES_OFF } },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-cancel', source: 'start', target: CANCEL_ROUND_APPROVAL_NODE_KEY },
        { key: 'e-cancel-end', source: CANCEL_ROUND_APPROVAL_NODE_KEY, target: 'end' },
      ],
    }
  }

  async function recordRows(instanceId: string): Promise<Array<{ id: string; action: string }>> {
    const rows = await observer.query<{ id: string; action: string }>(
      'SELECT id::text AS id, action FROM approval_records WHERE instance_id = $1 ORDER BY id',
      [instanceId],
    )
    return rows.rows
  }

  async function seatRows(instanceId: string): Promise<Array<{ id: string; assignee_id: string; node_key: string | null; is_active: boolean }>> {
    const rows = await observer.query<{ id: string; assignee_id: string; node_key: string | null; is_active: boolean }>(
      'SELECT id::text AS id, assignee_id, node_key, is_active FROM approval_assignments WHERE instance_id = $1 ORDER BY id',
      [instanceId],
    )
    return rows.rows
  }

  function gateRefusalOf(action: string, failure: unknown) {
    const error = failure as { name?: unknown; message?: unknown; statusCode?: unknown; code?: unknown; details?: unknown } | null
    return {
      action,
      isGateError: failure instanceof CancelRoundOutletForbiddenError,
      name: error?.name,
      message: error?.message,
      statusCode: error?.statusCode,
      code: error?.code,
      details: error?.details,
    }
  }

  function expectedGateRefusal(action: string) {
    return {
      action,
      isGateError: true,
      name: 'CancelRoundOutletForbiddenError',
      message: `Cancel-round instances do not accept action "${action}"`,
      statusCode: 409,
      code: 'CANCEL_ROUND_OUTLET_FORBIDDEN',
      details: undefined,
    }
  }

  it('A10 ② all four allow switches false: transfer, add_sign, reduce_sign and return are refused by the cancel-round gate, handed over and on the default path, with no policy_denied row and nothing written', async () => {
    const round = await pendingCancelRound('a10-switches-off')
    const service = new ApprovalProductService()

    // The round as created: the shared seed definition, stopped at the seed's node, switches unset.
    const created = await observer.query<{ published_definition_id: string; current_node_key: string }>(
      'SELECT published_definition_id::text AS published_definition_id, current_node_key FROM approval_instances WHERE id = $1',
      [round.roundInstanceId],
    )
    expect(created.rows).toEqual([{ published_definition_id: CANCEL_ROUND_PUBLISHED_DEFINITION_ID, current_node_key: CANCEL_ROUND_APPROVAL_NODE_KEY }])
    expect((await service.getApproval(round.roundInstanceId, round.approverId, []))?.nodeOperations).toEqual({
      allowTransfer: true,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'reject_only',
    })

    // The fixture definition, published through the server; the stored node policy is the four
    // switches false (the normaliser kept every key).
    const adminToken = await authToken(baseUrl, `wi-handover-admin-a10-off-${TS}-${Math.floor(Math.random() * 1e6)}`)
    const fixtureTemplateId = await publishTemplate(adminToken, cancelNodeSwitchesOffGraph(round.approverId), 'a10-switches-off')
    const definitions = await observer.query<{ id: string; runtime_graph: { nodes?: Array<{ key?: string; config?: Record<string, unknown> }> } }>(
      'SELECT id::text AS id, runtime_graph FROM approval_published_definitions WHERE template_id = $1 AND is_active = TRUE',
      [fixtureTemplateId],
    )
    expect(definitions.rows).toHaveLength(1)
    const fixtureDefinition = definitions.rows[0]
    const storedNode = (fixtureDefinition.runtime_graph.nodes ?? []).find((node) => node?.key === CANCEL_ROUND_APPROVAL_NODE_KEY)
    expect(storedNode?.config?.nodeOperationPolicy).toEqual(ALL_SWITCHES_OFF)

    const repointed = await observer.query(
      'UPDATE approval_instances SET published_definition_id = $2::uuid WHERE id = $1',
      [round.roundInstanceId, fixtureDefinition.id],
    )
    expect(repointed.rowCount).toBe(1)

    // POSITIVE CONTROL: the service now resolves all four switches false for this round's seat, so the
    // node-operation policy check WOULD refuse each of the four actions below if it ran first.
    expect((await service.getApproval(round.roundInstanceId, round.approverId, []))?.nodeOperations).toEqual(ALL_SWITCHES_OFF)

    const before = await instanceState(round.roundInstanceId)
    const recordsBefore = await recordRows(round.roundInstanceId)
    const seatsBefore = await seatRows(round.roundInstanceId)
    expect(before?.status).toBe('pending')
    expect(seatsBefore.filter((seat) => seat.is_active).map((seat) => ({ assignee_id: seat.assignee_id, node_key: seat.node_key }))).toEqual([
      { assignee_id: round.approverId, node_key: CANCEL_ROUND_APPROVAL_NODE_KEY },
    ])

    const requests: ApprovalActionRequest[] = [
      { action: 'transfer', targetUserId: `wi-handover-target-${TS}`, comment: 'transfer' } as ApprovalActionRequest,
      { action: 'add_sign', targetUserIds: [`wi-handover-target-${TS}`], comment: 'add sign' } as ApprovalActionRequest,
      { action: 'reduce_sign', targetAssignmentUserId: round.approverId, comment: 'reduce sign' } as ApprovalActionRequest,
      { action: 'return', targetNodeKey: 'start', comment: 'return' } as ApprovalActionRequest,
    ]
    for (const request of requests) {
      // Handed over (the A10 mode).
      const w = world()
      try {
        const handedOverFailure = await coordinatedTransactionV1({
          coordinator: w.coordinator,
          request: READ_COMMITTED,
          candidate: { org: crypto.randomUUID() },
          transactionDepth: () => 0,
          body: (context) =>
            drive(context, w, { rolloutLock: { kind: 'none' } }, (handover) =>
              new ApprovalProductService().dispatchAction(
                round.roundInstanceId,
                request,
                { userId: round.approverId, userName: 'handed-over approver', roles: [] },
                handover,
              ),
            ),
        }).then(
          () => null,
          (error) => error,
        )
        expect(gateRefusalOf(request.action, handedOverFailure)).toEqual(expectedGateRefusal(request.action))
        expectOneRolledBackAttempt(w.attempts)
        expectBaseline(w.coordinator)
      } finally {
        await w.end()
      }

      // The default path on the same round. Here a policy refusal would COMMIT its `policy_denied`
      // row before answering, so the zero-row assertion below discriminates on this path.
      const defaultFailure = await new ApprovalProductService()
        .dispatchAction(round.roundInstanceId, request, { userId: round.approverId, userName: 'default-path approver', roles: [] })
        .then(
          () => null,
          (error) => error,
        )
      expect(gateRefusalOf(request.action, defaultFailure)).toEqual(expectedGateRefusal(request.action))
    }

    expect(await policyDenials(round.roundInstanceId)).toBe(0)
    expect(await instanceState(round.roundInstanceId)).toEqual(before)
    expect(await recordRows(round.roundInstanceId)).toEqual(recordsBefore)
    expect(await seatRows(round.roundInstanceId)).toEqual(seatsBefore)
    expect(await roundOutcome(round.roundInstanceId)).toBe('pending')
  }, 180_000)
})
