/**
 * Record-level submit-for-approval — the no-DB unit battery (design §6 row 1).
 *
 * Pure + fake-query only: NO supertest `request(app)` (the #4154 tripwire), no live Postgres. The
 * end-to-end route behaviour is proven by tests/integration/multitable-record-approval-realdb.test.ts.
 *
 * What is proven here, and what each test would catch:
 *   - the in-flight uniqueness CONTRACT is the same on both sides: the migration's partial index
 *     predicate and the service's `RECORD_APPROVAL_IN_FLIGHT_STATUSES` (drop the WHERE clause, or widen
 *     one side only → red);
 *   - the three-step state machine: the durable `creating` claim happens BEFORE `createApproval`, a
 *     23505 on the in-flight index becomes 409 WITHOUT creating an approval, a createApproval throw
 *     lands `failed` with a values-free CODE, and the promote to `pending` is guarded on `creating`;
 *   - completion is IDEMPOTENT by the `WHERE status = 'pending'` guard: a redelivery updates zero rows
 *     and therefore sends NO second notification and publishes NO second invalidation (remove the guard
 *     or the zero-row early return → red);
 *   - drift returns FIELD IDS ONLY, masked by the caller's field-permission read set, never values;
 *   - the list page: `?limit=` is CLAMPED to [1,100], `hasMore` comes from a limit+1 probe row that is
 *     never returned, and the two directory names are resolved by EXACTLY TWO batched IN-queries per
 *     response no matter how many rows come back (drop the batching or the +1 fetch → red);
 *   - the ORDERING failures the 2026-09-15 adversarial review found, each against a Postgres-shaped row
 *     store (partial unique index + the real WHERE guards emulated), not against SQL strings:
 *       * an auto-approving template completes INSIDE createApproval and its completion is delivered
 *         while the row is still ('creating', instance NULL) → the promote must write the TERMINAL state,
 *         not 'pending' (otherwise the row is stranded and the pair is 409-bricked forever);
 *       * an instance that goes terminal between COMMIT and the promote is caught by the one-shot
 *         post-promote status probe;
 *       * a `creating` claim is reclaimable after a TTL (it is not an absorbing state), and a 5xx
 *         createApproval throw KEEPS the claim (an instance may exist) instead of freeing the slot;
 *       * the terminal UPDATE + the notification INSERT are ONE transaction, so a failed notification
 *         rolls the terminal write back and the retry redoes both;
 *   - the manifest v2 consumer universe and the durable handler key agree;
 *   - the two `deriveCapabilities` copies (access.ts / sheet-capabilities.ts) agree on canSubmitApproval.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, test, vi } from 'vitest'

import {
  applyRecordApprovalCompletion,
  clampRecordApprovalListLimit,
  computeRecordApprovalDrift,
  createPoolTransactionRunner,
  listRecordApprovalSubmissions,
  RECORD_APPROVAL_LIST_DEFAULT_LIMIT,
  RECORD_APPROVAL_LIST_MAX_LIMIT,
  mapCreateApprovalFailure,
  recordApprovalCompletionOutcome,
  RECORD_APPROVAL_CREATING_CLAIM_TTL_MS,
  RECORD_APPROVAL_ERROR_CODES,
  RECORD_APPROVAL_IN_FLIGHT_INDEX,
  RECORD_APPROVAL_IN_FLIGHT_STATUSES,
  RECORD_APPROVAL_ROW_ERROR_CODES,
  RECORD_APPROVAL_SUBMISSIONS_TABLE,
  RecordApprovalError,
  submitRecordApproval,
  subscribeRecordApprovalCompletionBus,
  createRecordApprovalCompletionSink,
  terminalOutcomeOf,
} from '../../src/multitable/record-approval-submission-service'
import { DURABLE_CONSUMER_KEYS } from '../../src/multitable/automation-durable-activation'
import {
  CURRENT_ROUTING_MANIFEST,
  expandConsumerKeysForEvent,
  manifestConsumerKeys,
} from '../../src/multitable/automation-routing-manifest'
import { deriveCapabilities as deriveCapabilitiesRest } from '../../src/multitable/access'
import { deriveCapabilities as deriveCapabilitiesBridge } from '../../src/multitable/sheet-capabilities'
import type { ApprovalCompletionEventV1 } from '../../src/services/ApprovalCompletionEvent'

const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260915120000_create_multitable_record_approval_submissions.ts',
)
const migrationSource = fs.readFileSync(MIGRATION_PATH, 'utf-8')

type Call = { sql: string; params: unknown[] }

/** A fake query fn: records every statement and answers from a fragment → result table. */
function fakeQuery(
  handlers: Array<{ match: string; rows?: unknown[]; rowCount?: number; throws?: unknown }>,
): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>; calls: Call[] } {
  const calls: Call[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    const handler = handlers.find((h) => sql.includes(h.match))
    if (handler?.throws) throw handler.throws
    return { rows: handler?.rows ?? [], rowCount: handler?.rowCount ?? (handler?.rows?.length ?? 0) }
  }
  return { query, calls }
}

const SHEET = 'sht_unit_1'
const RECORD = 'rec_unit_1'
const TEMPLATE = 'tpl_unit_1'
const USER = 'u_unit_1'

const submissionRow = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  sheet_id: SHEET,
  record_id: RECORD,
  template_id: TEMPLATE,
  approval_instance_id: null,
  approval_request_no: null,
  status: 'pending',
  outcome: null,
  submitted_by: USER,
  record_version_at_submit: 3,
  error: null,
  created_at: '2026-09-15T00:00:00.000Z',
  completed_at: null,
  ...over,
})

const uniqueViolation = (constraint: string) =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint })

const completionEvent = (over: Partial<ApprovalCompletionEventV1> = {}): ApprovalCompletionEventV1 =>
  ({
    version: 1,
    eventId: 'approval:inst_1:2:approval.approved',
    eventType: 'approval.approved',
    occurredAt: '2026-09-15T01:00:00.000Z',
    source: 'approval-product',
    approval: {
      instanceId: 'inst_1',
      requestNo: 'AP-1',
      templateId: TEMPLATE,
      templateVersionId: null,
      publishedDefinitionId: null,
      businessKey: null,
      workflowKey: null,
    },
    transition: { action: 'approve', fromStatus: 'pending', toStatus: 'approved', fromVersion: 1, toVersion: 2, nodeKey: 'n1' },
    actor: { id: 'u_approver', name: null },
    requester: { id: USER },
    ...over,
  }) as ApprovalCompletionEventV1

// ── the in-flight uniqueness contract (code ↔ migration) ──────────────────────

describe('in-flight uniqueness: the partial unique index IS the rule', () => {
  test('the migration creates a PARTIAL unique index whose predicate equals RECORD_APPROVAL_IN_FLIGHT_STATUSES', () => {
    expect(migrationSource).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${RECORD_APPROVAL_IN_FLIGHT_INDEX}`)
    expect(migrationSource).toContain(
      `ON ${RECORD_APPROVAL_SUBMISSIONS_TABLE} (sheet_id, record_id, template_id)`,
    )
    // The WHERE clause is the load-bearing half: WITHOUT it a rejected/approved submission would block
    // every future submission of the same (record, template) forever. Extracted from the INDEX STATEMENT
    // ITSELF (not from anywhere in the file — a prose mention of the predicate in the header must not be
    // able to satisfy this assertion) and compared to the code's status list, so neither side can drift.
    expect(RECORD_APPROVAL_IN_FLIGHT_INDEX).toBe('uniq_mt_record_approval_in_flight')
    const statement =
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt_record_approval_in_flight[\s\S]*?`\.execute/.exec(migrationSource)
    expect(statement).not.toBeNull()
    const predicate = /WHERE status IN \(([^)]*)\)/.exec(statement![0])
    expect(predicate).not.toBeNull()
    const statuses = predicate![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    expect(statuses).toEqual([...RECORD_APPROVAL_IN_FLIGHT_STATUSES])
    expect(statuses).not.toContain('approved')
    expect(statuses).not.toContain('rejected')
    expect(statuses).not.toContain('failed')
  })

  test('the migration also declares the by-instance unique index the completion consumer looks up on', () => {
    expect(migrationSource).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt_record_approval_instance')
    expect(migrationSource).toContain('WHERE approval_instance_id IS NOT NULL')
    expect(migrationSource).toContain('CREATE INDEX IF NOT EXISTS idx_mt_record_approval_record_created')
  })
})

// ── the three-step state machine ──────────────────────────────────────────────

describe('submitRecordApproval — three steps, durable claim FIRST', () => {
  const input = {
    sheetId: SHEET,
    recordId: RECORD,
    templateId: TEMPLATE,
    formData: { f1: 'never-logged' },
    submittedBy: USER,
    recordVersion: 3,
    recordSnapshot: { fld_a: 'secret-value' },
  }
  const actor = { userId: USER, permissions: ['approvals:write'] }

  test('happy path: INSERT creating → createApproval → UPDATE pending guarded on creating', async () => {
    const { query, calls } = fakeQuery([
      { match: 'UPDATE', rows: [submissionRow({ approval_instance_id: 'inst_1', approval_request_no: 'AP-1' })] },
    ])
    const createApproval = vi.fn(async () => ({ id: 'inst_1', requestNo: 'AP-1' }))
    const row = await submitRecordApproval(query, input, actor, { createApproval })

    expect(calls[0]!.sql).toContain(`INSERT INTO ${RECORD_APPROVAL_SUBMISSIONS_TABLE}`)
    expect(calls[0]!.sql).toContain("'creating'")
    // the claim is written BEFORE the approval instance exists — that ordering is what makes the
    // partial unique index able to refuse a concurrent duplicate at all
    expect(createApproval).toHaveBeenCalledTimes(1)
    expect(createApproval.mock.invocationCallOrder[0]).toBeGreaterThan(0)
    expect(calls[1]!.sql).toContain('UPDATE')
    // The promoted status is a PARAMETER now, because an approval that was already terminal when it was
    // created must be written terminal here (see the auto-approval describe below). A non-terminal create
    // still promotes to exactly 'pending' with a null outcome.
    expect(calls[1]!.params[3]).toBe('pending')
    expect(calls[1]!.params[4]).toBeNull()
    expect(calls[1]!.sql).toContain("WHERE id = $1 AND status = 'creating'")
    expect(row.status).toBe('pending')
    expect(row.approvalInstanceId).toBe('inst_1')
    expect(row.approvalRequestNo).toBe('AP-1')
  })

  test('duplicate: a 23505 on the in-flight index is 409 RECORD_APPROVAL_IN_FLIGHT and NO approval is created', async () => {
    const { query, calls } = fakeQuery([
      { match: 'INSERT INTO', throws: uniqueViolation(RECORD_APPROVAL_IN_FLIGHT_INDEX) },
      { match: 'SELECT id, sheet_id', rows: [submissionRow({ approval_instance_id: 'inst_existing', approval_request_no: 'AP-9' })] },
    ])
    const createApproval = vi.fn(async () => ({ id: 'inst_new' }))
    const error = await submitRecordApproval(query, input, actor, { createApproval }).catch((e) => e)

    expect(error).toBeInstanceOf(RecordApprovalError)
    expect(error.statusCode).toBe(409)
    expect(error.code).toBe(RECORD_APPROVAL_ERROR_CODES.inFlight)
    // the response points at the EXISTING instance (ids only)
    expect(error.details).toMatchObject({ approvalInstanceId: 'inst_existing', requestNo: 'AP-9', status: 'pending' })
    expect(createApproval).not.toHaveBeenCalled()
    // the in-flight lookup filters on exactly the index's status set
    expect(calls[1]!.params[3]).toEqual([...RECORD_APPROVAL_IN_FLIGHT_STATUSES])
  })

  test('a 23505 on a DIFFERENT index is NOT swallowed as 409 (no blanket unique-violation catch)', async () => {
    const { query } = fakeQuery([{ match: 'INSERT INTO', throws: uniqueViolation('some_other_unique_index') }])
    const error = await submitRecordApproval(query, input, actor, {
      createApproval: async () => ({ id: 'inst_1' }),
    }).catch((e) => e)
    expect(error).not.toBeInstanceOf(RecordApprovalError)
    expect((error as { code?: string }).code).toBe('23505')
  })

  test('createApproval 403 → row marked failed with a values-free CODE, surfaced as PERMISSION_DENIED', async () => {
    const { query, calls } = fakeQuery([])
    const createApproval = async () => {
      throw Object.assign(new Error('requester lacks approvals:write on row value 12345'), {
        statusCode: 403,
        code: 'APPROVAL_PERMISSION_DENIED',
      })
    }
    const error = await submitRecordApproval(query, input, actor, { createApproval }).catch((e) => e)
    expect(error).toBeInstanceOf(RecordApprovalError)
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe(RECORD_APPROVAL_ERROR_CODES.permissionDenied)

    const failedUpdate = calls.find((c) => c.sql.includes("status = 'failed'"))
    expect(failedUpdate).toBeDefined()
    expect(failedUpdate!.sql).toContain("WHERE id = $1 AND status = 'creating'")
    // VALUES-FREE: the persisted error is the identifier, never the upstream message.
    expect(failedUpdate!.params[1]).toBe(RECORD_APPROVAL_ERROR_CODES.permissionDenied)
    expect(JSON.stringify(failedUpdate!.params)).not.toContain('12345')
  })

  test('createApproval 4xx passes the upstream CODE through (sanitized); 5xx becomes 502 CREATE_FAILED', async () => {
    const validation = mapCreateApprovalFailure(
      Object.assign(new Error('Approval form data is invalid: field x = 42'), { statusCode: 400, code: 'VALIDATION_ERROR' }),
    )
    expect(validation.statusCode).toBe(400)
    expect(validation.code).toBe('VALIDATION_ERROR')
    expect(validation.message).not.toContain('42')

    const org = mapCreateApprovalFailure(Object.assign(new Error('x'), { statusCode: 422, code: 'APPROVAL_ORG_UNRESOLVED' }))
    expect(org.statusCode).toBe(422)
    expect(org.code).toBe('APPROVAL_ORG_UNRESOLVED')

    const boom = mapCreateApprovalFailure(new Error('Database not available'))
    expect(boom.statusCode).toBe(502)
    expect(boom.code).toBe(RECORD_APPROVAL_ERROR_CODES.createFailed)

    // a hostile "code" that is really a message cannot ride out through the seam
    const hostile = mapCreateApprovalFailure(
      Object.assign(new Error('x'), { statusCode: 400, code: 'record value: 张三 13800000000' }),
    )
    expect(hostile.code).toBe(RECORD_APPROVAL_ERROR_CODES.createFailed)
  })
})

// ── drift ─────────────────────────────────────────────────────────────────────

describe('drift: ids only, version-anchored, masked by the caller field-permission set', () => {
  const readable = new Set(['fld_a', 'fld_b'])

  test('no version bump → changed=false and NO field ids (even if the snapshot differs)', () => {
    const drift = computeRecordApprovalDrift({
      snapshot: { fld_a: 'one' },
      current: { fld_a: 'two' },
      recordVersion: 3,
      recordVersionAtSubmit: 3,
      readableFieldIds: readable,
    })
    expect(drift).toEqual({ changed: false, changedFieldIds: [] })
  })

  test('version bump → the changed READABLE field ids, sorted; values never appear', () => {
    const drift = computeRecordApprovalDrift({
      snapshot: { fld_b: 'old-b', fld_a: 'same', fld_secret: 'old-secret' },
      current: { fld_b: 'new-b', fld_a: 'same', fld_secret: 'new-secret' },
      recordVersion: 5,
      recordVersionAtSubmit: 3,
      readableFieldIds: readable,
    })
    expect(drift.changed).toBe(true)
    // fld_secret changed too, but it is NOT in the caller's read mask → invisible, not even as an id
    expect(drift.changedFieldIds).toEqual(['fld_b'])
    const serialized = JSON.stringify(drift)
    for (const value of ['old-b', 'new-b', 'old-secret', 'new-secret', 'same']) {
      expect(serialized).not.toContain(value)
    }
  })

  test('added / removed keys count as changes; key ORDER and undefined-vs-missing do not', () => {
    const added = computeRecordApprovalDrift({
      snapshot: { fld_a: { x: 1, y: 2 } },
      current: { fld_a: { y: 2, x: 1 }, fld_b: 'new' },
      recordVersion: 4,
      recordVersionAtSubmit: 3,
      readableFieldIds: readable,
    })
    expect(added.changedFieldIds).toEqual(['fld_b'])

    const removed = computeRecordApprovalDrift({
      snapshot: { fld_a: 'v', fld_b: 'w' },
      current: { fld_a: 'v' },
      recordVersion: 4,
      recordVersionAtSubmit: 3,
      readableFieldIds: readable,
    })
    expect(removed.changedFieldIds).toEqual(['fld_b'])

    const nulled = computeRecordApprovalDrift({
      snapshot: { fld_a: null },
      current: {},
      recordVersion: 4,
      recordVersionAtSubmit: 3,
      readableFieldIds: readable,
    })
    expect(nulled.changedFieldIds).toEqual([])
  })

  test('an EMPTY read mask masks every id (fail closed), and the list route never echoes the snapshot', async () => {
    const { query } = fakeQuery([
      { match: 'FROM meta_records', rows: [{ version: 9, data: { fld_a: 'current' } }] },
      {
        match: `FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE}`,
        rows: [submissionRow({ record_snapshot: { fld_a: 'snapshot-value' } })],
      },
    ])
    const { submissions: rows } = await listRecordApprovalSubmissions(query, {
      sheetId: SHEET,
      recordId: RECORD,
      readableFieldIds: new Set<string>(),
      viewerUserId: USER,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.drift).toEqual({ changed: true, changedFieldIds: [] })
    expect(JSON.stringify(rows)).not.toContain('snapshot-value')
    expect(JSON.stringify(rows)).not.toContain('current')
  })
})

// ── the list page: names, limit, hasMore ──────────────────────────────────────

/**
 * The fake the list battery answers from: the record probe, the page, the THREE template-gate statements
 * (`approvals:read` codes + the viewer's users row + the role union) and the two directory IN-queries.
 *
 * The gate statements are answered here, not stubbed away, because the name lookup is only correct if it
 * actually runs them: a caller without `approvals:read` must get NO template query at all.
 */
function listQuery(options: {
  submissions: Array<Record<string, unknown>>
  templates?: Array<Record<string, unknown>>
  users?: Array<Record<string, unknown>>
  templatesThrow?: unknown
  usersThrow?: unknown
  /** the viewer's permission codes — the default holds `approvals:read` */
  permissionCodes?: string[]
  /** null = the viewer's `users` row is gone or deactivated, so no visibility actor can be built */
  viewerRow?: { role?: string | null; department?: string | null; is_admin?: boolean | null } | null
  /** when true the fake ENFORCES visibility: a template query that carries the filter's params matches nothing */
  visibilityHidesEverything?: boolean
}) {
  const calls: Call[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('FROM meta_records')) return { rows: [{ version: 3, data: {} }], rowCount: 1 }
    if (sql.includes('FROM user_permissions')) {
      const codes = (options.permissionCodes ?? ['approvals:read', 'multitable:read']).map((code) => ({ permission_code: code }))
      return { rows: codes, rowCount: codes.length }
    }
    if (sql.includes('FROM user_roles')) return { rows: [], rowCount: 0 }
    if (sql.includes('is_active = TRUE')) {
      const viewer = options.viewerRow === undefined ? { role: 'user', department: null, is_admin: false } : options.viewerRow
      return { rows: viewer ? [viewer] : [], rowCount: viewer ? 1 : 0 }
    }
    if (sql.includes('FROM approval_templates')) {
      if (options.templatesThrow) throw options.templatesThrow
      // params = [ids] plus the visibility filter's three params when the actor is not a template manager
      if (options.visibilityHidesEverything && params.length > 1) return { rows: [], rowCount: 0 }
      return { rows: options.templates ?? [], rowCount: (options.templates ?? []).length }
    }
    if (sql.includes('FROM users WHERE id = ANY')) {
      if (options.usersThrow) throw options.usersThrow
      return { rows: options.users ?? [], rowCount: (options.users ?? []).length }
    }
    if (sql.includes(`FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE}`)) {
      // the service asks for limit + 1; the fake honours that bound so `hasMore` is derived, not asserted
      // into existence (params[2] IS the limit+1 the service computed).
      const bound = Number(params[2] ?? options.submissions.length)
      const rows = options.submissions.slice(0, bound)
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }
  /** the two DIRECTORY lookups only — the gate statements below are counted separately */
  const lookups = () =>
    calls.filter((c) => c.sql.includes('FROM approval_templates') || c.sql.includes('FROM users WHERE id = ANY'))
  const gateCalls = () =>
    calls.filter(
      (c) => c.sql.includes('FROM user_permissions') || c.sql.includes('FROM user_roles') || c.sql.includes('is_active = TRUE'),
    )
  const pageCall = () => calls.find((c) => c.sql.includes(`FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE}`))!
  const pageLimitParam = () => Number(pageCall().params[2])
  return { query: query as never, calls, lookups, gateCalls, pageCall, pageLimitParam }
}

const READ_ALL = new Set<string>(['fld_a'])

/** Every list call carries the viewer: the template-name gate has no default subject. */
const listInput = (over: Record<string, unknown> = {}) => ({
  sheetId: SHEET,
  recordId: RECORD,
  readableFieldIds: READ_ALL,
  viewerUserId: USER,
  ...over,
})

describe('list page: directory names come from TWO batched lookups, never N+1', () => {
  const TPL_A = 'e7b1f0c2-0000-4000-8000-00000000000a'
  const TPL_B = 'E7B1F0C2-0000-4000-8000-00000000000B' // stored UPPERCASE: uuid::text is lowercase
  const TPL_GONE = 'e7b1f0c2-0000-4000-8000-0000000000ff'

  const page = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      submissionRow({
        id: `sub_${i}`,
        template_id: i % 2 === 0 ? TPL_A : TPL_B,
        submitted_by: `u_${i % 3}`,
        created_at: `2026-09-1${i}T00:00:00.000Z`,
      }),
    )

  const directory = {
    templates: [
      { id: TPL_A, name: '记录送审模板A' },
      { id: TPL_B.toLowerCase(), name: 'Template B' },
    ],
    users: [
      { id: 'u_0', name: '张三', username: 'zhangsan', email: 'zhangsan@example.test' },
      { id: 'u_1', name: null, username: 'lisi', email: 'lisi@example.test' },
      { id: 'u_2', name: '   ', username: null, email: 'wangwu@example.test' },
    ],
  }

  test('5 rows, 2 templates, 3 users → EXACTLY two lookup queries, and the names land on the right rows', async () => {
    const fake = listQuery({ submissions: page(5), ...directory })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    expect(submissions).toHaveLength(5)
    expect(fake.lookups()).toHaveLength(2)
    // the template GATE is derived ONCE for the whole response too (codes + users row + roles), never per row
    expect(fake.gateCalls()).toHaveLength(3)
    // one IN-query per directory: the DISTINCT ids only (2 templates, 3 users), not one call per row
    const [templateCall, userCall] = fake.lookups()
    expect(templateCall!.params[0]).toEqual([TPL_A, TPL_B.toLowerCase()])
    expect(userCall!.params[0]).toEqual(['u_0', 'u_1', 'u_2'])
    // ...and that ONE template query carries the VISIBILITY predicate (the gate is in the SQL, not a
    // post-filter): ids + the filter's user/dept/role params.
    expect(templateCall!.sql).toContain('visibility_scope')
    expect(templateCall!.params).toHaveLength(4)
    expect(templateCall!.params[1]).toBe(USER)

    expect(submissions[0]!.templateName).toBe('记录送审模板A')
    // case-insensitive join: the row stores the id uppercase, the uuid column renders it lowercase
    expect(submissions[1]!.templateName).toBe('Template B')
    expect(submissions[0]!.submittedByName).toBe('张三') // name wins
    expect(submissions[1]!.submittedByName).toBe('lisi') // no name → username
    expect(submissions[2]!.submittedByName).toBe('wangwu') // blank name, no username → the email LOCAL part
    // the local part only: a full address is never handed out by this list
    expect(JSON.stringify(submissions)).not.toContain('@example.test')
  })

  test('ONE row needs the same two lookups — and ZERO rows needs none (not even the gate)', async () => {
    const one = listQuery({ submissions: page(1), ...directory })
    await listRecordApprovalSubmissions(one.query, listInput())
    expect(one.lookups()).toHaveLength(2)

    const none = listQuery({ submissions: [], ...directory })
    const empty = await listRecordApprovalSubmissions(none.query, listInput())
    expect(empty).toEqual({ submissions: [], hasMore: false })
    expect(none.lookups()).toHaveLength(0)
    expect(none.gateCalls()).toHaveLength(0)
  })

  test('a template that is GONE and a user that is GONE are null, never an id wearing a name', async () => {
    const fake = listQuery({
      submissions: [submissionRow({ id: 'sub_gone', template_id: TPL_GONE, submitted_by: 'u_deleted' })],
      templates: [],
      users: [],
    })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    expect(submissions[0]!.templateName).toBeNull()
    expect(submissions[0]!.submittedByName).toBeNull()
    // the ids themselves are untouched, so the client can still fall back to them
    expect(submissions[0]!.templateId).toBe(TPL_GONE)
    expect(submissions[0]!.submittedBy).toBe('u_deleted')
  })

  test('a caller WITHOUT approvals:read gets NO templateName and issues NO template query (the submitter name still resolves)', async () => {
    // THE HOLE THIS CLOSES (review round 2): `canRead` on a sheet comes from multitable:read/write/admin
    // alone. Without this gate a plain grid viewer would learn the display NAME of a template that the
    // same router refuses it on POST (RECORD_APPROVAL_TEMPLATE_FORBIDDEN) and that /api/approval-templates
    // refuses it too.
    const fake = listQuery({ submissions: page(1), ...directory, permissionCodes: ['multitable:read'] })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    expect(submissions[0]!.templateName).toBeNull()
    expect(submissions[0]!.submittedByName).toBe('张三') // the submitter name is NOT approval-gated
    expect(fake.calls.filter((c) => c.sql.includes('FROM approval_templates'))).toHaveLength(0)
    // the row itself still lists, with the id it always had
    expect(submissions[0]!.templateId).toBe(TPL_A)
  })

  test('a template hidden by its visibility_scope resolves to null, not to its name', async () => {
    const fake = listQuery({ submissions: page(1), ...directory, visibilityHidesEverything: true })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    expect(submissions[0]!.templateName).toBeNull()
    expect(submissions[0]!.submittedByName).toBe('张三')
    // the query WAS issued (the caller holds approvals:read) and it carried the filter that hid the row
    const templateCall = fake.calls.find((c) => c.sql.includes('FROM approval_templates'))!
    expect(templateCall.params.length).toBeGreaterThan(1)
  })

  test('a viewer whose users row is gone/inactive resolves no template name at all (fail-closed actor)', async () => {
    const fake = listQuery({ submissions: page(1), ...directory, viewerRow: null })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    expect(submissions[0]!.templateName).toBeNull()
    expect(fake.calls.filter((c) => c.sql.includes('FROM approval_templates'))).toHaveLength(0)

    // ...and so does an EMPTY viewer id (a caller that forgot the subject gets no names, never all names)
    const anonymous = listQuery({ submissions: page(1), ...directory })
    const result = await listRecordApprovalSubmissions(anonymous.query, listInput({ viewerUserId: '' }))
    expect(result.submissions[0]!.templateName).toBeNull()
    expect(anonymous.calls.filter((c) => c.sql.includes('FROM approval_templates'))).toHaveLength(0)
  })

  test('an ABSENT directory TABLE (42P01) degrades to null names; a missing COLUMN (42703) and any other error RETHROW', async () => {
    const missing = listQuery({
      submissions: page(1),
      templatesThrow: Object.assign(new Error('relation "approval_templates" does not exist'), { code: '42P01' }),
      usersThrow: Object.assign(new Error('relation "users" does not exist'), { code: '42P01' }),
    })
    const { submissions } = await listRecordApprovalSubmissions(missing.query, listInput())
    expect(submissions[0]!.templateName).toBeNull()
    expect(submissions[0]!.submittedByName).toBeNull()

    // 42703 is NOT swallowed any more: every column these lookups read exists by migration, so tolerating
    // undefined_column would only hide a future rename (the roles.description shape) behind null names.
    const renamed = listQuery({
      submissions: page(1),
      usersThrow: Object.assign(new Error('column "username" does not exist'), { code: '42703' }),
    })
    await expect(listRecordApprovalSubmissions(renamed.query, listInput())).rejects.toMatchObject({ code: '42703' })

    const broken = listQuery({
      submissions: page(1),
      usersThrow: Object.assign(new Error('connection terminated'), { code: '08006' }),
    })
    await expect(listRecordApprovalSubmissions(broken.query, listInput())).rejects.toMatchObject({ code: '08006' })
  })

  test('PADDED stored ids still resolve: both maps are read exactly the way their IN-list was built', async () => {
    const fake = listQuery({
      submissions: [submissionRow({ id: 'sub_ws', template_id: ' E7B1F0C2-0000-4000-8000-00000000000A ', submitted_by: ' u_0 ' })],
      ...directory,
    })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    const [templateCall, userCall] = fake.lookups()
    // the queries asked for the TRIMMED ids and the directory answered...
    expect(templateCall!.params[0]).toEqual([TPL_A])
    expect(userCall!.params[0]).toEqual(['u_0'])
    // ...so reading the map with the raw padded value (the old bug) must not lose the name
    expect(submissions[0]!.templateName).toBe('记录送审模板A')
    expect(submissions[0]!.submittedByName).toBe('张三')
  })

  test('the existing submission fields are untouched by the two new keys', async () => {
    const fake = listQuery({ submissions: page(1), ...directory })
    const { submissions } = await listRecordApprovalSubmissions(fake.query, listInput())
    expect(submissions[0]).toMatchObject({
      id: 'sub_0',
      sheetId: SHEET,
      recordId: RECORD,
      templateId: TPL_A,
      approvalInstanceId: null,
      approvalRequestNo: null,
      status: 'pending',
      outcome: null,
      submittedBy: 'u_0',
      recordVersionAtSubmit: 3,
      error: null,
      completedAt: null,
    })
  })
})

describe('list page: ?limit is clamped and hasMore is a limit+1 PROBE row', () => {
  test('clampRecordApprovalListLimit: default for garbage, up to 1, down to the max', () => {
    expect(clampRecordApprovalListLimit(undefined)).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit('abc')).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit(Number.NaN)).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit(Number.POSITIVE_INFINITY)).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit(0)).toBe(1)
    expect(clampRecordApprovalListLimit(-7)).toBe(1)
    expect(clampRecordApprovalListLimit(0.5)).toBe(1)
    expect(clampRecordApprovalListLimit('3')).toBe(3)
    expect(clampRecordApprovalListLimit(RECORD_APPROVAL_LIST_MAX_LIMIT)).toBe(RECORD_APPROVAL_LIST_MAX_LIMIT)
    expect(clampRecordApprovalListLimit(RECORD_APPROVAL_LIST_MAX_LIMIT + 1)).toBe(RECORD_APPROVAL_LIST_MAX_LIMIT)
    expect(clampRecordApprovalListLimit(1e9)).toBe(RECORD_APPROVAL_LIST_MAX_LIMIT)
  })

  test('a BLANK ?limit= is ABSENT, not zero: it gets the default page, never a one-row page', async () => {
    // `GET ...approvals?limit=` hands the route `''`, `?limit=%20` hands it `' '`, and a repeated empty
    // `?limit=&limit=` hands it `[]`. `Number('')` is 0 — finite — so the clamp used to raise all three to
    // ONE row with hasMore, i.e. a caller that said nothing got a 1-row page.
    expect(clampRecordApprovalListLimit('')).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit('   ')).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit([])).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    expect(clampRecordApprovalListLimit(['2', '3'])).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
    // an explicit 0 is still the task's clamp-UP case, not the default
    expect(clampRecordApprovalListLimit('0')).toBe(1)

    const rows = Array.from({ length: 200 }, (_, i) => submissionRow({ id: `sub_${i}` }))
    const fake = listQuery({ submissions: rows })
    const result = await listRecordApprovalSubmissions(fake.query, listInput({ limit: '' as never }))
    expect(fake.pageLimitParam()).toBe(RECORD_APPROVAL_LIST_DEFAULT_LIMIT + 1)
    expect(result.submissions).toHaveLength(RECORD_APPROVAL_LIST_DEFAULT_LIMIT)
  })

  test('the page SELECT asks for limit + 1, and the clamp decides that limit', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => submissionRow({ id: `sub_${i}` }))
    for (const [requested, expectedFetch] of [
      [undefined, RECORD_APPROVAL_LIST_DEFAULT_LIMIT + 1],
      [2, 3],
      [0, 2],
      [-5, 2],
      [1000, RECORD_APPROVAL_LIST_MAX_LIMIT + 1],
    ] as Array<[number | undefined, number]>) {
      const fake = listQuery({ submissions: rows })
      const result = await listRecordApprovalSubmissions(fake.query, listInput({ limit: requested }))
      expect(fake.pageLimitParam()).toBe(expectedFetch)
      // the probe row is never returned: the page is exactly the clamped limit
      expect(result.submissions).toHaveLength(expectedFetch - 1)
      expect(result.hasMore).toBe(true)
    }
  })

  test('hasMore is FALSE when the probe row does not come back (and the page is complete)', async () => {
    const exact = listQuery({ submissions: Array.from({ length: 2 }, (_, i) => submissionRow({ id: `sub_${i}` })) })
    const result = await listRecordApprovalSubmissions(exact.query, listInput({ limit: 2 }))
    expect(exact.pageLimitParam()).toBe(3)
    expect(result.submissions).toHaveLength(2)
    expect(result.hasMore).toBe(false)

    const under = listQuery({ submissions: [submissionRow({ id: 'sub_only' })] })
    const small = await listRecordApprovalSubmissions(under.query, listInput({ limit: 2 }))
    expect(small.submissions).toHaveLength(1)
    expect(small.hasMore).toBe(false)
  })

  test('hasMore TRUE hides the probe row: exactly `limit` rows, newest-first order preserved', async () => {
    const fake = listQuery({
      submissions: [
        submissionRow({ id: 'sub_newest', created_at: '2026-09-15T03:00:00.000Z' }),
        submissionRow({ id: 'sub_middle', created_at: '2026-09-15T02:00:00.000Z' }),
        submissionRow({ id: 'sub_probe', created_at: '2026-09-15T01:00:00.000Z' }),
      ],
    })
    const result = await listRecordApprovalSubmissions(fake.query, listInput({ limit: 2 }))
    expect(result.submissions.map((row) => row.id)).toEqual(['sub_newest', 'sub_middle'])
    expect(result.hasMore).toBe(true)
  })

  test('the page ORDER BY is a TOTAL order, so which row is the discarded probe is deterministic', async () => {
    const fake = listQuery({ submissions: [submissionRow({ id: 'sub_only' })] })
    await listRecordApprovalSubmissions(fake.query, listInput({ limit: 1 }))
    // `created_at` alone ties (two submissions can share a timestamp); the id tiebreaker is what makes the
    // limit+1 probe row well-defined for any future cursor page.
    expect(fake.pageCall().sql.replace(/\s+/g, ' ')).toContain('ORDER BY created_at DESC, id DESC')
  })
})

// ── completion: idempotent by the pending guard ───────────────────────────────

describe('applyRecordApprovalCompletion — exactly-once effects', () => {
  const sink = (rows: unknown[]) => {
    const { query, calls } = fakeQuery([{ match: 'UPDATE', rows }])
    const insertNotifications = vi.fn(async () => ({ inserted: 1 }))
    const publishRealtime = vi.fn()
    return { query, calls, insertNotifications, publishRealtime }
  }

  test('first delivery: terminal UPDATE guarded on pending, ONE notification (values-free), ONE invalidation', async () => {
    const { query, calls, insertNotifications, publishRealtime } = sink([
      { id: 'sub_1', sheet_id: SHEET, record_id: RECORD, submitted_by: USER },
    ])
    const result = await applyRecordApprovalCompletion(query, completionEvent(), {
      insertNotifications: insertNotifications as never,
      publishRealtime,
    })
    expect(result).toEqual({ applied: true, submissionId: 'sub_1' })

    const update = calls[0]!
    // THE idempotency guard. Without `AND status = 'pending'` a redelivery would re-notify.
    expect(update.sql).toContain("WHERE approval_instance_id = $1 AND status = 'pending'")
    expect(update.sql).toContain('SET status = $2, outcome = $2, completed_at = NOW()')
    expect(update.params).toEqual(['inst_1', 'approved'])

    expect(insertNotifications).toHaveBeenCalledTimes(1)
    const notification = insertNotifications.mock.calls[0]![1] as Record<string, unknown>
    expect(notification).toMatchObject({
      userIds: [USER],
      sheetId: SHEET,
      recordId: RECORD,
      eventType: 'notification.sent',
    })
    expect(notification.message).toBe('记录送审已通过')
    expect(publishRealtime).toHaveBeenCalledTimes(1)
    expect(publishRealtime).toHaveBeenCalledWith({ sheetId: SHEET, recordId: RECORD })
  })

  test('redelivery: the guarded UPDATE matches ZERO rows → no notification, no invalidation, applied=false', async () => {
    const { query, insertNotifications, publishRealtime } = sink([])
    const result = await applyRecordApprovalCompletion(query, completionEvent(), {
      insertNotifications: insertNotifications as never,
      publishRealtime,
    })
    expect(result).toEqual({ applied: false })
    expect(insertNotifications).not.toHaveBeenCalled()
    expect(publishRealtime).not.toHaveBeenCalled()
  })

  test('BEHAVIOURAL redelivery: against a Postgres-shaped row store, the SECOND delivery notifies nobody', async () => {
    // The fake models what Postgres actually does with the guarded UPDATE: it matches a row ONLY while the
    // stored status is still `pending` when the statement carries the guard. Remove `AND status =
    // 'pending'` from the service and this fake matches on the redelivery too → a SECOND notification →
    // red. (The same claim is proven against a REAL rowcount by the realdb suite's G5.)
    let storedStatus = 'pending'
    const notified: string[] = []
    const query = async (sql: string, params: unknown[] = []) => {
      if (!sql.trimStart().startsWith('UPDATE')) return { rows: [], rowCount: 0 }
      const guarded = sql.includes("status = 'pending'") // only the WHERE clause can spell this
      if (guarded && storedStatus !== 'pending') return { rows: [], rowCount: 0 }
      storedStatus = String(params[1])
      return { rows: [{ id: 'sub_1', sheet_id: SHEET, record_id: RECORD, submitted_by: USER }], rowCount: 1 }
    }
    const deps = {
      insertNotifications: (async (_q: unknown, input: { message?: string | null }) => {
        notified.push(String(input.message))
        return { inserted: 1 }
      }) as never,
      publishRealtime: () => undefined,
    }

    expect(await applyRecordApprovalCompletion(query, completionEvent(), deps)).toMatchObject({ applied: true })
    expect(await applyRecordApprovalCompletion(query, completionEvent(), deps)).toEqual({ applied: false })
    expect(notified).toEqual(['记录送审已通过'])
    expect(storedStatus).toBe('approved')
  })

  test('an approval with NO record submission row is an ACK (no throw, no writes beyond the miss)', async () => {
    const { query, calls, insertNotifications, publishRealtime } = sink([])
    await expect(
      applyRecordApprovalCompletion(query, completionEvent({ approval: { ...completionEvent().approval, instanceId: 'inst_foreign' } }), {
        insertNotifications: insertNotifications as never,
        publishRealtime,
      }),
    ).resolves.toEqual({ applied: false })
    expect(calls).toHaveLength(1)
  })

  test('each outcome writes its OWN terminal status + its own values-free message', async () => {
    for (const [eventType, outcome, message] of [
      ['approval.rejected', 'rejected', '记录送审已驳回'],
      ['approval.revoked', 'revoked', '记录送审已撤销'],
      ['approval.cancelled', 'cancelled', '记录送审已取消'],
    ] as const) {
      const { query, calls, insertNotifications, publishRealtime } = sink([
        { id: 'sub_1', sheet_id: SHEET, record_id: RECORD, submitted_by: USER },
      ])
      await applyRecordApprovalCompletion(
        query,
        completionEvent({
          eventType,
          transition: { action: 'reject', fromStatus: 'pending', toStatus: outcome, fromVersion: 1, toVersion: 2, nodeKey: null },
        } as never),
        { insertNotifications: insertNotifications as never, publishRealtime },
      )
      expect(calls[0]!.params[1]).toBe(outcome)
      expect((insertNotifications.mock.calls[0]![1] as Record<string, unknown>).message).toBe(message)
    }
  })

  test('a non-completion / malformed event is a no-op (never a terminal write on a guess)', async () => {
    const { query, calls } = sink([])
    expect(await applyRecordApprovalCompletion(query, completionEvent({ approval: { ...completionEvent().approval, instanceId: '' } }))).toEqual({ applied: false })
    expect(
      await applyRecordApprovalCompletion(
        query,
        completionEvent({ eventType: 'approval.task_created', transition: undefined } as never),
      ),
    ).toEqual({ applied: false })
    expect(calls).toHaveLength(0)
  })

  test('outcome derivation prefers the transition, falls back to the event type, refuses anything else', () => {
    expect(recordApprovalCompletionOutcome(completionEvent())).toBe('approved')
    expect(
      recordApprovalCompletionOutcome({ eventType: 'approval.revoked', transition: undefined } as never),
    ).toBe('revoked')
    expect(recordApprovalCompletionOutcome({ eventType: 'approval.task_created' } as never)).toBeNull()
    expect(recordApprovalCompletionOutcome(null)).toBeNull()
  })
})

// ── two legs, one handler ─────────────────────────────────────────────────────

describe('completion wiring: durable consumer + eventBus fallback share ONE idempotent handler', () => {
  test('the eventBus leg owns, detaches, and drains exactly its four completion subscriptions', async () => {
    const subscribed: string[] = []
    const handlers: Array<(payload: unknown) => void> = []
    const unsubscribe = vi.fn(() => true)
    const bus = {
      subscribe: (eventType: string, handler: (payload: never) => void) => {
        subscribed.push(eventType)
        handlers.push(handler as (payload: unknown) => void)
        return `sub_${subscribed.length}`
      },
      unsubscribe,
    }
    const seen: unknown[] = []
    let release!: () => void
    const subscription = subscribeRecordApprovalCompletionBus(bus, {
      handleApprovalCompletion: async (event) => new Promise<void>((resolve) => {
        seen.push(event)
        release = resolve
      }),
    })
    expect(subscribed).toEqual(['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled'])
    expect(subscription.ids).toEqual(['sub_1', 'sub_2', 'sub_3', 'sub_4'])
    handlers[0]!(completionEvent())
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    subscription.detach()
    subscription.detach()
    expect(unsubscribe.mock.calls).toEqual([
      ['sub_1'],
      ['sub_2'],
      ['sub_3'],
      ['sub_4'],
    ])

    let drained = false
    const drain = subscription.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await drain
    expect(drained).toBe(true)
  })

  test('a partial subscription failure precisely rolls back the ids already registered', () => {
    const unsubscribe = vi.fn(() => true)
    let attempts = 0
    const bus = {
      subscribe: () => {
        attempts += 1
        if (attempts === 3) throw new Error('subscription sentinel')
        return `sub_${attempts}`
      },
      unsubscribe,
    }

    expect(() => subscribeRecordApprovalCompletionBus(bus, {
      handleApprovalCompletion: async () => undefined,
    })).toThrow('subscription sentinel')
    expect(unsubscribe.mock.calls).toEqual([['sub_1'], ['sub_2']])
  })

  test('the sink built for the durable leg runs the SAME idempotent UPDATE', async () => {
    const { query, calls } = fakeQuery([{ match: 'UPDATE', rows: [] }])
    const sinkObj = createRecordApprovalCompletionSink(query)
    await expect(sinkObj.handleApprovalCompletion(completionEvent())).resolves.toBeUndefined()
    expect(calls[0]!.sql).toContain("status = 'pending'")
  })

  test('the CURRENT manifest still routes the four completion families to multitable-record-approval AND a handler key exists', () => {
    for (const eventType of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      expect(expandConsumerKeysForEvent(eventType)).toContain('multitable-record-approval')
    }
    // v3 since the dingtalk-todo-mirror consumer landed; this consumer's OWN route is version-independent
    // (it must survive every future manifest bump), so the assertion above is a `toContain`, not an
    // exact set - the exact per-version sets are pinned in automation-routing-manifest.test.ts.
    expect(CURRENT_ROUTING_MANIFEST.version).toBe(3)
    expect(manifestConsumerKeys()).toContain('multitable-record-approval')
    // the other direction: a routed key with no registered adapter would park rows forever
    expect([...DURABLE_CONSUMER_KEYS]).toContain('multitable-record-approval')
    expect([...DURABLE_CONSUMER_KEYS].sort()).toEqual(manifestConsumerKeys().sort())
  })
})

// ── the two capability derivations agree ──────────────────────────────────────

describe('canSubmitApproval: the REST and Yjs/OAPI derivations cannot drift', () => {
  const matrix: Array<[string[], boolean]> = [
    [[], false],
    [['multitable:read'], false],
    [['multitable:write'], false],
    [['multitable:manage-schema'], false],
    [['workflow:all'], false],
    [['multitable:submit-approval'], true],
    [['multitable:*'], true],
    [['*:*'], true],
    [['approvals:write'], false],
  ]

  test('both copies derive the SAME canSubmitApproval for every permission shape (non-admin)', () => {
    for (const [permissions, expected] of matrix) {
      expect(deriveCapabilitiesRest(permissions, false).canSubmitApproval).toBe(expected)
      expect(deriveCapabilitiesBridge(permissions, false).canSubmitApproval).toBe(expected)
    }
  })

  test('both copies short-circuit for the admin role, and agree on the WHOLE capability object', () => {
    for (const [permissions] of matrix) {
      expect(deriveCapabilitiesRest(permissions, true).canSubmitApproval).toBe(true)
      expect(deriveCapabilitiesBridge(permissions, true).canSubmitApproval).toBe(true)
      expect(deriveCapabilitiesRest(permissions, false)).toEqual(deriveCapabilitiesBridge(permissions, false))
      expect(deriveCapabilitiesRest(permissions, true)).toEqual(deriveCapabilitiesBridge(permissions, true))
    }
  })
})


// ── ordering + recovery (adversarial review 2026-09-15) ───────────────────────

/**
 * A Postgres-SHAPED row store: it enforces the partial unique index and evaluates the statements' WHERE
 * guards instead of matching SQL text. That is what makes the tests below mutation-sensitive — delete
 * `AND status = 'pending'` (or `AND status = 'creating'`, or the staleness predicate) from the service and
 * this fake starts matching rows it should not, which is exactly what the assertions catch.
 */
function createRowStore(options: { now?: () => number } = {}) {
  const rows: Array<Record<string, unknown>> = []
  const nowFn = options.now ?? (() => Date.parse('2026-09-15T12:00:00.000Z'))
  const iso = () => new Date(nowFn()).toISOString()
  const inFlight = (r: Record<string, unknown>) => r.status === 'creating' || r.status === 'pending'
  const clone = (r: Record<string, unknown>) => ({ ...r })

  const seen: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    seen.push(text)

    if (text.startsWith(`INSERT INTO ${RECORD_APPROVAL_SUBMISSIONS_TABLE}`)) {
      const [id, sheetId, recordId, templateId, submittedBy, version, snapshot] = params as string[]
      const collides = rows.some(
        (r) => inFlight(r) && r.sheet_id === sheetId && r.record_id === recordId && r.template_id === templateId,
      )
      if (collides) {
        throw Object.assign(new Error(`duplicate key value violates unique constraint "${RECORD_APPROVAL_IN_FLIGHT_INDEX}"`), {
          code: '23505',
          constraint: RECORD_APPROVAL_IN_FLIGHT_INDEX,
        })
      }
      rows.push({
        id,
        sheet_id: sheetId,
        record_id: recordId,
        template_id: templateId,
        approval_instance_id: null,
        approval_request_no: null,
        status: 'creating',
        outcome: null,
        submitted_by: submittedBy,
        record_version_at_submit: Number(version),
        record_snapshot: snapshot,
        error: null,
        created_at: iso(),
        completed_at: null,
      })
      return { rows: [], rowCount: 1 }
    }

    if (text.startsWith(`UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}`)) {
      const where = text.slice(text.indexOf(' WHERE '))
      let candidates = rows
      if (/WHERE id = \$1/.test(where)) candidates = candidates.filter((r) => r.id === params[0])
      if (/WHERE approval_instance_id = \$1/.test(where)) candidates = candidates.filter((r) => r.approval_instance_id === params[0])
      if (/status = 'creating'/.test(where)) candidates = candidates.filter((r) => r.status === 'creating')
      if (/status = 'pending'/.test(where)) candidates = candidates.filter((r) => r.status === 'pending')
      if (/created_at < NOW\(\)/.test(where)) {
        const ttlMs = Number(params[2] ?? 0)
        candidates = candidates.filter((r) => Date.parse(String(r.created_at)) < nowFn() - ttlMs)
      }
      for (const row of candidates) {
        if (/SET status = 'failed'/.test(text)) {
          row.status = 'failed'
          row.error = /COALESCE\(error, \$2\)/.test(text) ? (row.error ?? params[1]) : params[1]
          row.completed_at = iso()
        } else if (/SET status = \$2, outcome = \$2/.test(text)) {
          row.status = params[1]
          row.outcome = params[1]
          row.completed_at = iso()
        } else if (/SET status = \$4, outcome = \$5/.test(text)) {
          row.status = params[3]
          row.outcome = params[4] ?? null
          row.approval_instance_id = params[1]
          row.approval_request_no = params[2] ?? null
          // COALESCE($6::text, error): null on every normal promote, a values-free code on the
          // compensating replay — the fake evaluates it the way Postgres would.
          if (/error = COALESCE\(\$6::text, error\)/.test(text) && params[5] != null) row.error = params[5]
          if (params[4]) row.completed_at = iso()
        } else if (/SET error = \$2/.test(text)) {
          row.error = params[1]
        }
      }
      return { rows: candidates.map(clone), rowCount: candidates.length }
    }

    if (text.includes('status = ANY($4::text[])')) {
      const [sheetId, recordId, templateId, statuses] = params as [string, string, string, string[]]
      const found = rows.filter(
        (r) => r.sheet_id === sheetId && r.record_id === recordId && r.template_id === templateId && statuses.includes(String(r.status)),
      )
      return { rows: found.map(clone), rowCount: found.length }
    }
    if (text.includes(`FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE} WHERE id = $1`)) {
      const found = rows.filter((r) => r.id === params[0])
      return { rows: found.map(clone), rowCount: found.length }
    }
    return { rows: [], rowCount: 0 }
  }

  return { query: query as never, rows, snapshot: () => rows.map(clone), statements: () => [...seen] }
}

function notificationRecorder() {
  const sent: Array<{ userIds: string[]; message: string | null }> = []
  const insertNotifications = (async (_q: unknown, input: { userIds: string[]; message?: string | null }) => {
    sent.push({ userIds: input.userIds, message: input.message ?? null })
    return { inserted: input.userIds.length }
  }) as never
  return { sent, deps: { insertNotifications, publishRealtime: () => undefined } }
}

const submitInput = (over: Record<string, unknown> = {}) => ({
  sheetId: SHEET,
  recordId: RECORD,
  templateId: TEMPLATE,
  formData: { f1: 'never-logged' },
  submittedBy: USER,
  recordVersion: 3,
  recordSnapshot: { fld_a: 'secret-value' },
  ...over,
})

const ACTOR = { userId: USER, permissions: ['approvals:write'] }

describe('an approval that is ALREADY TERMINAL when created is not stranded in pending', () => {
  test('auto-approval at create: the completion fires before the id is bound, yet the row lands approved + ONE notification, and the pair stays submittable', async () => {
    const store = createRowStore()
    const notifier = notificationRecorder()
    const sink = createRecordApprovalCompletionSink(store.query, notifier.deps)

    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      // PRODUCTION ORDERING: ApprovalProductService emits the completion event between COMMIT and
      // `return approval` when the template auto-approves. At this instant our row is still
      // ('creating', approval_instance_id = NULL), so the instance-keyed UPDATE matches nothing.
      createApproval: async () => {
        await sink.handleApprovalCompletion(
          completionEvent({ approval: { ...completionEvent().approval, instanceId: 'inst_auto' } } as never),
        )
        return { id: 'inst_auto', requestNo: 'AP-AUTO', status: 'approved' }
      },
      completion: notifier.deps,
    })

    expect(submission.status).toBe('approved')
    expect(submission.outcome).toBe('approved')
    expect(submission.approvalInstanceId).toBe('inst_auto')
    expect(submission.completedAt).not.toBeNull()
    // exactly one bell: the dropped delivery sent none, the promote sent one
    expect(notifier.sent).toEqual([{ userIds: [USER], message: '记录送审已通过' }])

    // and the (record, template) pair is NOT bricked — the terminal row is outside the index predicate
    const next = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_next', requestNo: 'AP-NEXT', status: 'pending' }),
    })
    expect(next.status).toBe('pending')
  })

  test('a redelivery of that same completion afterwards changes nothing (no second bell)', async () => {
    const store = createRowStore()
    const notifier = notificationRecorder()
    const sink = createRecordApprovalCompletionSink(store.query, notifier.deps)
    await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_auto', status: 'approved' }),
      completion: notifier.deps,
    })
    await sink.handleApprovalCompletion(
      completionEvent({ approval: { ...completionEvent().approval, instanceId: 'inst_auto' } } as never),
    )
    expect(notifier.sent).toHaveLength(1)
    expect(store.snapshot()[0]!.status).toBe('approved')
  })

  test('post-promote probe: an instance that went terminal in the COMMIT→promote window is finalized', async () => {
    const store = createRowStore()
    const notifier = notificationRecorder()
    const probe = vi.fn(async () => 'rejected')
    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_race', requestNo: 'AP-RACE', status: 'pending' }),
      loadApprovalStatus: probe,
      completion: notifier.deps,
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('inst_race')
    expect(submission.status).toBe('rejected')
    expect(submission.outcome).toBe('rejected')
    expect(notifier.sent).toEqual([{ userIds: [USER], message: '记录送审已驳回' }])
  })

  test('the probe is a RECONCILE, not an override: a still-running instance stays pending with no bell', async () => {
    const store = createRowStore()
    const notifier = notificationRecorder()
    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_live', status: 'pending' }),
      loadApprovalStatus: async () => 'pending',
      completion: notifier.deps,
    })
    expect(submission.status).toBe('pending')
    expect(notifier.sent).toHaveLength(0)
    // a probe that throws must never fail the submission
    const store2 = createRowStore()
    const ok = await submitRecordApproval(store2.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_live2', status: 'pending' }),
      loadApprovalStatus: async () => {
        throw new Error('probe boom')
      },
    })
    expect(ok.status).toBe('pending')
  })

  test('terminalOutcomeOf accepts exactly the four terminal statuses', () => {
    for (const status of ['approved', 'rejected', 'revoked', 'cancelled']) {
      expect(terminalOutcomeOf(status)).toBe(status)
    }
    for (const status of ['pending', 'draft', '', null, undefined, 42]) {
      expect(terminalOutcomeOf(status)).toBeNull()
    }
  })
})

describe('`creating` is not an absorbing state', () => {
  test('a claim older than the TTL is reclaimed by the next submit (and marked with a values-free code)', async () => {
    let clock = Date.parse('2026-09-15T12:00:00.000Z')
    const store = createRowStore({ now: () => clock })
    // a claim whose process died: it never reached step 3 and nothing else will ever clear it
    await store.query(
      `INSERT INTO ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
         (id, sheet_id, record_id, template_id, status, submitted_by, record_version_at_submit, record_snapshot)
       VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7::jsonb)`,
      ['sub_stale', SHEET, RECORD, TEMPLATE, USER, 1, '{}'],
    )
    clock += RECORD_APPROVAL_CREATING_CLAIM_TTL_MS + 1000

    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_after_reclaim', status: 'pending' }),
    })
    expect(submission.status).toBe('pending')
    const stale = store.snapshot().find((r) => r.id === 'sub_stale')!
    expect(stale.status).toBe('failed')
    expect(stale.error).toBe(RECORD_APPROVAL_ROW_ERROR_CODES.claimExpired)
    expect(store.snapshot().filter((r) => r.status === 'creating' || r.status === 'pending')).toHaveLength(1)
  })

  test('a FRESH claim is NOT reclaimed — the in-flight rule still holds (409, no approval created)', async () => {
    let clock = Date.parse('2026-09-15T12:00:00.000Z')
    const store = createRowStore({ now: () => clock })
    await store.query(
      `INSERT INTO ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
         (id, sheet_id, record_id, template_id, status, submitted_by, record_version_at_submit, record_snapshot)
       VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7::jsonb)`,
      ['sub_fresh', SHEET, RECORD, TEMPLATE, USER, 1, '{}'],
    )
    clock += 1000
    const createApproval = vi.fn(async () => ({ id: 'inst_never', status: 'pending' }))
    const error = await submitRecordApproval(store.query, submitInput(), ACTOR, { createApproval }).catch((e) => e)
    expect(error).toBeInstanceOf(RecordApprovalError)
    expect(error.statusCode).toBe(409)
    expect(createApproval).not.toHaveBeenCalled()
    expect(store.snapshot().find((r) => r.id === 'sub_fresh')!.status).toBe('creating')
  })

  test('the 409 details expose the stuck claim as a CODE (no instance link to offer)', async () => {
    const store = createRowStore()
    await store.query(
      `INSERT INTO ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
         (id, sheet_id, record_id, template_id, status, submitted_by, record_version_at_submit, record_snapshot)
       VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7::jsonb)`,
      ['sub_stuck', SHEET, RECORD, TEMPLATE, USER, 1, '{}'],
    )
    const error = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'x', status: 'pending' }),
    }).catch((e) => e)
    expect(error.details).toMatchObject({ submissionId: 'sub_stuck', approvalInstanceId: null, status: 'creating' })
    expect(JSON.stringify(error.details)).not.toContain('secret-value')
  })
})

describe('a createApproval throw only frees the in-flight slot when it PROVES nothing was created', () => {
  test('4xx (pre-commit refusal) releases the claim: the next submit is accepted', async () => {
    const store = createRowStore()
    const denied = Object.assign(new Error('requester lacks approvals:write'), { statusCode: 403, code: 'APPROVAL_PERMISSION_DENIED' })
    await expect(
      submitRecordApproval(store.query, submitInput(), ACTOR, {
        createApproval: async () => {
          throw denied
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: RECORD_APPROVAL_ERROR_CODES.permissionDenied })
    expect(store.snapshot()[0]!.status).toBe('failed')

    const retry = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_retry', status: 'pending' }),
    })
    expect(retry.status).toBe('pending')
  })

  test('5xx (AMBIGUOUS: createApproval commits before its post-commit tail) KEEPS the claim', async () => {
    const store = createRowStore()
    await expect(
      submitRecordApproval(store.query, submitInput(), ACTOR, {
        createApproval: async () => {
          // e.g. ApprovalProductService's post-COMMIT `getApproval` miss → 500 APPROVAL_CREATE_FAILED,
          // by which time an approval_instances row DOES exist.
          throw Object.assign(new Error('Approval not found after creation'), { statusCode: 500, code: 'APPROVAL_CREATE_FAILED' })
        },
      }),
    ).rejects.toMatchObject({ statusCode: 502, code: RECORD_APPROVAL_ERROR_CODES.createFailed })

    const claim = store.snapshot()[0]!
    expect(claim.status).toBe('creating')
    expect(claim.error).toBe(RECORD_APPROVAL_ROW_ERROR_CODES.unverified)

    // and the very next submit must NOT be allowed to create a SECOND live approval for this record
    const createApproval = vi.fn(async () => ({ id: 'inst_duplicate', status: 'pending' }))
    await expect(submitRecordApproval(store.query, submitInput(), ACTOR, { createApproval })).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(createApproval).not.toHaveBeenCalled()
  })

  test('a promote that fails does NOT mark the row failed (the instance exists) and does not leak driver text', async () => {
    const store = createRowStore()
    const boom = Object.assign(new Error('terminating connection due to administrator command value=13800000000'), { code: '57P01' })
    const query = (async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SET status = $4, outcome = $5")) throw boom
      return store.query(sql, params)
    }) as never
    const error = await submitRecordApproval(query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_orphan', status: 'pending' }),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(RecordApprovalError)
    expect(error.statusCode).toBe(502)
    expect(error.code).toBe(RECORD_APPROVAL_ERROR_CODES.createFailed)
    expect(error.message).not.toContain('13800000000')
    // the claim survives (it is the only thing standing between this and a duplicate live approval)
    expect(store.snapshot()[0]!.status).toBe('creating')
  })
})

describe('completion is ATOMIC: the terminal UPDATE and the notification commit together', () => {
  /** A transaction runner that behaves like BEGIN/ROLLBACK over the fake store's rows. */
  function transactionalStore() {
    const store = createRowStore()
    const runInTransaction = async <T>(fn: (q: never) => Promise<T>): Promise<T> => {
      const before = store.snapshot()
      try {
        return await fn(store.query)
      } catch (error) {
        store.rows.length = 0
        store.rows.push(...before)
        throw error
      }
    }
    return { store, runInTransaction: runInTransaction as never }
  }

  test('a notification INSERT that throws rolls the terminal write back, so the RETRY delivers both exactly once', async () => {
    const { store, runInTransaction } = transactionalStore()
    await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_txn', requestNo: 'AP-TXN', status: 'pending' }),
    })

    const sent: string[] = []
    let failNext = true
    const deps = {
      runInTransaction,
      publishRealtime: () => undefined,
      insertNotifications: (async (_q: unknown, input: { message?: string | null }) => {
        if (failNext) {
          failNext = false
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
        }
        sent.push(String(input.message))
        return { inserted: 1 }
      }) as never,
    }
    const event = completionEvent({ approval: { ...completionEvent().approval, instanceId: 'inst_txn' } } as never)

    // first delivery: the durable adapter sees a throw → retryable adapter_error
    await expect(applyRecordApprovalCompletion(store.query, event, deps)).rejects.toMatchObject({ code: '40P01' })
    expect(sent).toHaveLength(0)
    // ROLLED BACK: the row is still pending, so the redelivery can (and must) find it
    expect(store.snapshot()[0]!.status).toBe('pending')

    await expect(applyRecordApprovalCompletion(store.query, event, deps)).resolves.toMatchObject({ applied: true })
    expect(sent).toEqual(['记录送审已通过'])
    expect(store.snapshot()[0]!.status).toBe('approved')

    // ...and a third delivery still changes nothing
    await expect(applyRecordApprovalCompletion(store.query, event, deps)).resolves.toEqual({ applied: false })
    expect(sent).toHaveLength(1)
  })

  test('the notification INSERT runs on the TRANSACTION query, never on the pool one', async () => {
    const store = createRowStore()
    await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_q', status: 'pending' }),
    })
    const txQuery = (async (sql: string, params: unknown[] = []) => store.query(sql, params)) as never
    const seen: unknown[] = []
    await applyRecordApprovalCompletion(
      store.query,
      completionEvent({ approval: { ...completionEvent().approval, instanceId: 'inst_q' } } as never),
      {
        runInTransaction: (async (fn: (q: unknown) => Promise<unknown>) => fn(txQuery)) as never,
        publishRealtime: () => undefined,
        insertNotifications: (async (q: unknown) => {
          seen.push(q)
          return { inserted: 1 }
        }) as never,
      },
    )
    expect(seen).toEqual([txQuery])
  })

  test('the AUTO-APPROVE promotion runs INSIDE the same runInTransaction dep, on the transaction query', async () => {
    const store = createRowStore()
    const seen: unknown[] = []
    const runInTransaction = vi.fn(async (fn: (q: never) => Promise<unknown>) => fn(store.query))
    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_auto_txn', requestNo: 'AP-AUTO-TXN', status: 'approved' }),
      completion: {
        runInTransaction: runInTransaction as never,
        publishRealtime: () => undefined,
        insertNotifications: (async (q: unknown) => {
          seen.push(q)
          return { inserted: 1 }
        }) as never,
      },
    })
    expect(submission.status).toBe('approved')
    // the promote + the bell are ONE transactional unit, and the bell runs on the TRANSACTION query
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([store.query])
    expect(store.snapshot()[0]!.status).toBe('approved')
  })

  test('a NON-terminal submit never opens that transaction (the pending path is unchanged)', async () => {
    const store = createRowStore()
    const runInTransaction = vi.fn(async (fn: (q: never) => Promise<unknown>) => fn(store.query))
    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_pending_txn', status: 'pending' }),
      completion: { runInTransaction: runInTransaction as never, publishRealtime: () => undefined },
    })
    expect(submission.status).toBe('pending')
    expect(runInTransaction).not.toHaveBeenCalled()
  })

  test('a failing bell never commits HALF the pair: the atomic write rolls back, then the promote is COMPENSATED', async () => {
    // WHY NOT "rolled back, end of story" (review round 2): the consumer path may stop at a rollback
    // because its delivery is RETRIED. Nothing retries a submit. A bare rollback would leave the row
    // `creating` while the instance is already TERMINAL — and the instance-keyed UPDATE only ever matches
    // `pending`, so that binding would be lost forever, the TTL reclaim would stamp the row `failed` for
    // an APPROVED approval, and the next submit would create a SECOND instance.
    const { store, runInTransaction } = transactionalStore()
    const runner = vi.fn(runInTransaction as never)
    const promotes = () => store.statements().filter((sql) => /SET status = \$4, outcome = \$5/.test(sql))
    const submission = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_auto_boom', requestNo: 'AP-BOOM', status: 'approved' }),
      completion: {
        runInTransaction: runner as never,
        publishRealtime: () => undefined,
        insertNotifications: (async () => {
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
        }) as never,
      },
    })

    // ATOMIC FIRST: the pair was attempted inside the transaction and rolled back (two promote
    // statements: the one that rolled back, and the compensating replay).
    expect(runner).toHaveBeenCalledTimes(1)
    expect(promotes()).toHaveLength(2)

    // DEGRADED SECOND: the terminal truth is committed, and the missing bell is VISIBLE, not silent.
    expect(submission.status).toBe('approved')
    expect(submission.approvalInstanceId).toBe('inst_auto_boom')
    const row = store.snapshot()[0]!
    expect(row.status).toBe('approved')
    expect(row.outcome).toBe('approved')
    expect(row.approval_instance_id).toBe('inst_auto_boom')
    expect(row.error).toBe(RECORD_APPROVAL_ROW_ERROR_CODES.notificationFailed)

    // the completion that was already ACKed upstream can never re-deliver this outcome — which is exactly
    // why the compensation had to write it: a later delivery matches nothing and changes nothing.
    await expect(
      applyRecordApprovalCompletion(
        store.query,
        completionEvent({ approval: { ...completionEvent().approval, instanceId: 'inst_auto_boom' } } as never),
        { publishRealtime: () => undefined, insertNotifications: (async () => ({ inserted: 0 })) as never },
      ),
    ).resolves.toEqual({ applied: false })
    expect(store.snapshot()[0]!.status).toBe('approved')

    // ...and the pair is NOT bricked: the submission is terminal, so it holds no in-flight slot.
    const next = await submitRecordApproval(store.query, submitInput(), ACTOR, {
      createApproval: async () => ({ id: 'inst_after', status: 'pending' }),
    })
    expect(next.status).toBe('pending')
  })

  test('when the COMPENSATING promote fails too there is nothing honest to write: 502, claim KEPT', async () => {
    const { store, runInTransaction } = transactionalStore()
    // every promote fails (the bind UPDATE itself is broken, not just the bell)
    const brokenQuery = (async (sql: string, params: unknown[] = []) => {
      if (/SET status = \$4, outcome = \$5/.test(sql)) throw Object.assign(new Error('boom'), { code: '08006' })
      return store.query(sql, params)
    }) as never
    const brokenRunner = (async (fn: (q: never) => Promise<unknown>) =>
      runInTransaction(((q: never) => fn(brokenQuery)) as never)) as never

    await expect(
      submitRecordApproval(brokenQuery, submitInput(), ACTOR, {
        createApproval: async () => ({ id: 'inst_auto_dead', status: 'approved' }),
        completion: { runInTransaction: brokenRunner, publishRealtime: () => undefined },
      }),
    ).rejects.toMatchObject({ statusCode: 502, code: RECORD_APPROVAL_ERROR_CODES.createFailed })

    // the row is untouched — `creating`, unbound — and the claim is KEPT (an instance exists upstream), so
    // a duplicate cannot slip in before the TTL reclaim.
    const row = store.snapshot()[0]!
    expect(row.status).toBe('creating')
    expect(row.approval_instance_id).toBeNull()
    await expect(
      submitRecordApproval(store.query, submitInput(), ACTOR, {
        createApproval: async () => ({ id: 'inst_dupe', status: 'pending' }),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: RECORD_APPROVAL_ERROR_CODES.inFlight })
  })

  test('createPoolTransactionRunner delegates to the pool\u2019s own transaction() and propagates throws', async () => {
    const calls: string[] = []
    const client = { query: async (sql: string) => ({ rows: [], rowCount: 0, sql }) as never }
    const pool = {
      transaction: async <T>(handler: (c: typeof client) => Promise<T>): Promise<T> => {
        calls.push('begin')
        try {
          const result = await handler(client)
          calls.push('commit')
          return result
        } catch (error) {
          calls.push('rollback')
          throw error
        }
      },
    }
    const run = createPoolTransactionRunner(pool as never)
    await expect(run(async (q) => {
      await q('SELECT 1')
      return 'ok'
    })).resolves.toBe('ok')
    expect(calls).toEqual(['begin', 'commit'])

    await expect(run(async () => {
      throw new Error('inner')
    })).rejects.toThrow('inner')
    expect(calls).toEqual(['begin', 'commit', 'begin', 'rollback'])
  })
})
