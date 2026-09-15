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
 *   - the manifest v2 consumer universe and the durable handler key agree;
 *   - the two `deriveCapabilities` copies (access.ts / sheet-capabilities.ts) agree on canSubmitApproval.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, test, vi } from 'vitest'

import {
  applyRecordApprovalCompletion,
  computeRecordApprovalDrift,
  listRecordApprovalSubmissions,
  mapCreateApprovalFailure,
  recordApprovalCompletionOutcome,
  RECORD_APPROVAL_ERROR_CODES,
  RECORD_APPROVAL_IN_FLIGHT_INDEX,
  RECORD_APPROVAL_IN_FLIGHT_STATUSES,
  RECORD_APPROVAL_SUBMISSIONS_TABLE,
  RecordApprovalError,
  submitRecordApproval,
  subscribeRecordApprovalCompletionBus,
  createRecordApprovalCompletionSink,
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
    expect(calls[1]!.sql).toContain("status = 'pending'")
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
    const rows = await listRecordApprovalSubmissions(query, {
      sheetId: SHEET,
      recordId: RECORD,
      readableFieldIds: new Set<string>(),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.drift).toEqual({ changed: true, changedFieldIds: [] })
    expect(JSON.stringify(rows)).not.toContain('snapshot-value')
    expect(JSON.stringify(rows)).not.toContain('current')
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
  test('the eventBus leg subscribes exactly the four completion families, routed into the sink', async () => {
    const subscribed: string[] = []
    const handlers: Array<(payload: unknown) => void> = []
    const bus = {
      subscribe: (eventType: string, handler: (payload: never) => void) => {
        subscribed.push(eventType)
        handlers.push(handler as (payload: unknown) => void)
        return `sub_${subscribed.length}`
      },
    }
    const seen: unknown[] = []
    const ids = subscribeRecordApprovalCompletionBus(bus, {
      handleApprovalCompletion: async (event) => {
        seen.push(event)
      },
    })
    expect(subscribed).toEqual(['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled'])
    expect(ids).toHaveLength(4)
    handlers[0]!(completionEvent())
    await Promise.resolve()
    expect(seen).toHaveLength(1)
  })

  test('the sink built for the durable leg runs the SAME idempotent UPDATE', async () => {
    const { query, calls } = fakeQuery([{ match: 'UPDATE', rows: [] }])
    const sinkObj = createRecordApprovalCompletionSink(query)
    await expect(sinkObj.handleApprovalCompletion(completionEvent())).resolves.toBeUndefined()
    expect(calls[0]!.sql).toContain("status = 'pending'")
  })

  test('manifest v2 routes the four completion families to multitable-record-approval AND a handler key exists', () => {
    for (const eventType of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      expect(expandConsumerKeysForEvent(eventType)).toContain('multitable-record-approval')
    }
    expect(CURRENT_ROUTING_MANIFEST.version).toBe(2)
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
