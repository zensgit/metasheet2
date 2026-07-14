/**
 * Global History — D-1c, W0 slice ④ (RATIFIED design-lock, see
 * `docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`,
 * §0.5 OD-1..OD-3, §0/§7a site A7):
 *
 *   A7  approval `resultWriteback` — `packages/core-backend/src/multitable/automation-service.ts:2818`
 *       (the shared `applyResultWritebackPatch` tail used by BOTH the same-base (`:2696`) and cross-base
 *       (`:2762`) resultWriteback call sites)
 *
 * The bare UPDATE mutated `meta_records` with NO `meta_record_revisions` row, so `reconstructRecordsAtT`
 * (the primitive under the PIT view / revert / reset) derived existence+data PURELY from revisions and
 * could never see an approval resultWriteback — the same "PIT lie" class slices ①/②/③ closed for
 * form-submit, plugin-SDK, and automation, just triggered by an approval completion instead.
 *
 * Fix = emit `recordRecordRevision(...)` inside ONE transaction with the lock-check SELECT and the UPDATE
 * (now `RETURNING version, data`) — this path was NOT previously transactional (no `RETURNING`/rowCount
 * check existed at all before this slice; D-1 "偏差1" caution, re-verified here, not assumed). A new
 * private `withTransaction` helper on `AutomationService` wires this the SAME way the constructor already
 * hard-wires `deps.transaction` for the executor: a real `poolManager.get().transaction(...)`.
 * `source='approval'` (OD-2 — names the write entry point). `actorId=opts.chainActorId ?? null` (OD-3 —
 * identical to `opts.lockActorId` at BOTH call sites: the approval actor for same-base, the TRIGGER actor
 * for cross-base; never a fabricated system actor).
 *
 * ZERO-ROW FAIL-CLOSED DETERMINATION (per-slice obligation): the lock-check SELECT takes NO row lock (no
 * `FOR UPDATE`), so a concurrent DELETE of the target record between that SELECT and the UPDATE is
 * reachable — nothing pins a record in place during an in-flight approval
 * (`handleApprovalCompletionEvent`'s own "Record no longer exists" guard on the SOURCE record proves the
 * authors already expect mid-flight deletes on this exact path). The PRE-EXISTING contract for a 0-row
 * UPDATE here (proven by the total absence of any RETURNING/rowCount check before this slice) was SILENT
 * SUCCESS — the automation-lane contract (slice ③), NOT the plugin-lane throw contract (slice ②).
 * Regressing that into a thrown error would be an unrelated behavior change outside this slice's mandate.
 * So the guard below fails closed on the REVISION ONLY: a 0-row UPDATE still reports success (unchanged),
 * but writes NO spurious revision for a record it never touched. Proven below with a GENUINE
 * two-connection Postgres lock race (never a sleep heuristic).
 *
 * OD-3 NULL-ACTOR SCOPE NOTE (stated honestly, not glossed over): `ApprovalProductService` builds exactly
 * ONE completion event with `actor: null` in the entire file (`ApprovalProductService.ts:3974`) — the
 * createApproval()-TIME auto-approval of the FIRST node, before any human ever dispatches an action. That
 * specific path structurally BYPASSES `writeApprovalResultBack` entirely
 * (`AutomationApprovalBridgeService.startApproval`'s synchronous terminal-at-creation shortcut resolves
 * the step via `stepResultForApproval` and never emits through `handleApprovalCompletionEvent`). Every
 * completion that DOES reach `handleApprovalCompletionEvent` → `writeApprovalResultBack` originates from a
 * `dispatchAction(...)` call, whose `actor` parameter is a required (non-optional) field — so
 * `event.actor` is always populated on the path THIS slice touches, and a null-actor golden against the
 * real entry point is not constructible without bypassing this exact site. The code still defensively
 * writes `opts.chainActorId ?? null` (never fabricating a value) — proven by source, not by a golden here.
 *
 * §0.6-FIXTURE NOTE: `seedRecordWithCreateRevision` below inserts a legitimate `action:'create'` revision
 * alongside the raw seed `meta_records` row — without it the seeded record would itself carry A6's
 * uncaptured-CREATE fingerprint (zero revisions), making a "PIT before the writeback" assertion
 * meaningless (reconstructRecordsAtT would report it ABSENT at every T). This is a FIXTURE for the seed,
 * not a claim that this file proves the form/plugin/automation CREATE sites — ①/②/③ already do,
 * independently. PIT-correctness here is proven via a DIRECT `reconstructRecordsAtT` call, never through
 * the §0.6-gated revert/reset preview routes, so this file adds no fixture obligation against §0.6.
 *
 * Out of scope, untouched: form-submit (A1/A6, slice ①), plugin-SDK (A2/A5, slice ②), automation
 * create_record/update_record (A3/A4, slice ③, `automation-executor.ts` — ZERO diff in this PR),
 * attachment-delete (A8, slice ⑤), the OD-6 revision-disposition guard (#4227), and §0.6
 * `HISTORY_INCOMPLETE` (already landed, #4234).
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { db } from '../../src/db/db'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { recordRecordRevision } from '../../src/multitable/record-history-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const REQUESTER = `u_d1c4_requester_${TS}`
const APPROVER = `u_d1c4_approver_${TS}`

const BASE = `base_d1c4_${TS}`
const SHEET = `sheet_d1c4_${TS}`
const SHEET_FAIL = `sheet_d1c4_fail_${TS}`
const SHEET_RACE = `sheet_d1c4_race_${TS}`
const XB_BASE = `base_d1c4_xb_${TS}`
const XB_SHEET = `sheet_d1c4_xb_${TS}`

const RECORD = `rec_d1c4_${TS}`
const RECORD_PIT = `rec_d1c4_pit_${TS}`
const RECORD_FAIL = `rec_d1c4_fail_${TS}`
const RECORD_RACE = `rec_d1c4_race_${TS}`
const RECORD_XB_SRC = `rec_d1c4_xbsrc_${TS}`
const XB_RECORD = `rec_d1c4_xbtgt_${TS}`

const FLD_TITLE = `fld_d1c4_title_${TS}`
const FLD_STATUS = `fld_d1c4_status_${TS}`
const FLD_APPROVER = `fld_d1c4_approver_${TS}`
const FLD_COMPLETED = `fld_d1c4_completed_${TS}`

const FLD_PIT_TITLE = `fld_d1c4_pittitle_${TS}`
const FLD_PIT_STATUS = `fld_d1c4_pitstatus_${TS}`

const FLD_FAIL_TITLE = `fld_d1c4_failtitle_${TS}`
const FLD_FAIL_STATUS = `fld_d1c4_failstatus_${TS}`

const FLD_RACE_TITLE = `fld_d1c4_racetitle_${TS}`
const FLD_RACE_STATUS = `fld_d1c4_racestatus_${TS}`

const FLD_XB_SRC_TITLE = `fld_d1c4_xbsrctitle_${TS}`
const FLD_XB_STATUS = `fld_d1c4_xbstatus_${TS}`
const FLD_XB_APPROVER = `fld_d1c4_xbapprover_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const executionIds: string[] = []
const ruleIds: string[] = []
const templateIds: string[] = []
const approvalIds: string[] = []
let templateSeq = 0

/** The REAL production AutomationService wiring — real `pool.query.bind(pool)` queryFn, the SHARED
 * process-wide `eventBus` (the same singleton `emitApprovalCompletionEvent` publishes to), and `init()`
 * wiring the `approval.approved`/etc subscriptions that drive `handleApprovalCompletionEvent`. Never a
 * hand-rolled query calling `applyResultWritebackPatch` directly — this is what makes the atomicity +
 * transaction-boundary proofs, and the fully-real dispatch → event-bus → resume chain, real. */
function realService(): AutomationService {
  const pool = poolManager.get()
  // Stub fetchFn for the tail send_webhook action — this file asserts on meta_records/meta_record_revisions,
  // not on outbound webhook delivery, so a real network call would only add flakiness (mirrors the shared
  // multitable-automation-start-approval.test.ts's makeAutomationService(fetchFn) pattern).
  const fetchFn = (async () => new Response('OK', { status: 200 })) as unknown as typeof fetch
  const svc = new AutomationService(eventBus, db as never, pool.query.bind(pool), fetchFn)
  svc.init()
  return svc
}

async function seedUsers(): Promise<void> {
  await q(
    `INSERT INTO permissions (code, name, description)
     VALUES ('approvals:write', 'Approvals Write', 'Start approvals from D1C4 tests')
     ON CONFLICT (code) DO NOTHING`,
  )
  for (const [id, email] of [
    [REQUESTER, `${REQUESTER}@example.test`],
    [APPROVER, `${APPROVER}@example.test`],
  ]) {
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE, email = EXCLUDED.email, name = EXCLUDED.name`,
      [id, email],
    )
  }
  await q(
    `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`,
    [REQUESTER],
  )
}

async function makeBase(id: string, name: string, ownerId?: string): Promise<void> {
  await q(`INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)`, [id, name, ownerId ?? null])
}
async function makeSheet(id: string, baseId: string, name: string): Promise<void> {
  await q(`INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)`, [id, baseId, name])
}
async function makeField(id: string, sheetId: string, name: string, type = 'string', property: Record<string, unknown> = {}, order = 0): Promise<void> {
  await q(
    `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [id, sheetId, name, type, JSON.stringify(property), order],
  )
}
async function seedWritebackFields(sheetId: string, status: string, approver: string, completed: string): Promise<void> {
  await makeField(status, sheetId, 'Approval Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 10)
  await makeField(approver, sheetId, 'Approved By', 'string', {}, 11)
  await makeField(completed, sheetId, 'Approved At', 'dateTime', {}, 12)
}

/** §0.6-fixture note (see file header): a raw seed INSERT alone leaves the record with ZERO revisions
 * (the A6 uncaptured-create fingerprint) — reconstructRecordsAtT would report it ABSENT at every T. This
 * inserts a legitimate capture-complete action='create' revision matching the seeded row so PIT-before
 * assertions are meaningful. FIXTURE ONLY — not a claim this file proves the CREATE sites. */
async function seedRecordWithCreateRevision(recordId: string, sheetId: string, data: Record<string, unknown>): Promise<void> {
  await q(
    `INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)`,
    [recordId, sheetId, JSON.stringify(data), REQUESTER],
  )
  await recordRecordRevision(q, {
    sheetId,
    recordId,
    version: 1,
    action: 'create',
    source: 'rest',
    actorId: REQUESTER,
    changedFieldIds: Object.keys(data),
    patch: data,
    snapshot: data,
  })
}

function approvalTemplateRequest(key: string) {
  return {
    key,
    name: 'D1C4 Approval',
    visibilityScope: { type: 'all', ids: [] },
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'e-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

async function createPublishedTemplate(key: string): Promise<string> {
  const approvals = new ApprovalProductService()
  const template = await approvals.createTemplate(approvalTemplateRequest(key) as never)
  templateIds.push(template.id)
  await approvals.publishTemplate(template.id, { policy: { allowRevoke: true } } as never)
  return template.id
}

async function createStartApprovalRule(
  svc: AutomationService,
  sheetId: string,
  templateId: string,
  resultWriteback: Record<string, string | boolean>,
): Promise<string> {
  const config = {
    templateId,
    formDataMapping: { summary: 'Record {{record.title}} needs approval' },
    requester: { mode: 'trigger_actor' },
    resultWriteback,
  }
  const created = await svc.createRule(sheetId, {
    name: 'D1C4 start approval',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'start_approval',
    actionConfig: config,
    actions: [
      { type: 'start_approval', config },
      { type: 'send_webhook', config: { url: 'https://example.test/d1c4-tail' } },
    ] as never,
    executionMode: 'workflow_job_v1',
    createdBy: REQUESTER,
  })
  ruleIds.push(created.id)
  return created.id
}

async function waitForExecutionStatus(svc: AutomationService, id: string, status: string) {
  await vi.waitFor(async () => {
    const execution = await svc.logs.getById(id)
    expect(execution?.status, JSON.stringify(execution)).toBe(status)
  }, { timeout: 5000, interval: 50 })
  return (await svc.logs.getById(id))!
}

/** Drives the REAL chain: executeRule(start_approval) -> ApprovalProductService.createApproval -> bridge
 * row + suspended job -> ApprovalProductService.dispatchAction(approve) -> approval completion event (the
 * SHARED process eventBus) -> AutomationService.handleApprovalCompletionEvent -> writeApprovalResultBack
 * -> applyResultWritebackPatch (the site under test). */
async function executeAndApprove(
  svc: AutomationService,
  sheetId: string,
  recordId: string,
  templateKey: string,
  resultWriteback: Record<string, string | boolean>,
  title: string,
): Promise<{ executionId: string; approvalInstanceId: string }> {
  const templateId = await createPublishedTemplate(templateKey)
  const ruleId = await createStartApprovalRule(svc, sheetId, templateId, resultWriteback)
  const execRule = {
    id: ruleId,
    name: 'D1C4 start approval',
    sheetId,
    trigger: { type: 'record.created', config: {} },
    actions: [
      { type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback } },
      { type: 'send_webhook', config: { url: 'https://example.test/d1c4-tail' } },
    ],
    enabled: true,
    createdBy: REQUESTER,
    createdAt: new Date(TS).toISOString(),
    executionMode: 'workflow_job_v1',
  }
  const execution = await svc.executeRule(execRule as never, { sheetId, recordId, data: { title }, actorId: REQUESTER })
  executionIds.push(execution.id)
  const bridge = await q(
    `SELECT approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`,
    [execution.id],
  )
  const approvalInstanceId = bridge.rows[0].approval_instance_id as string
  approvalIds.push(approvalInstanceId)
  const approvals = new ApprovalProductService()
  await approvals.dispatchAction(approvalInstanceId, { action: 'approve', comment: 'go' }, { userId: APPROVER, userName: APPROVER })
  await waitForExecutionStatus(svc, execution.id, 'success')
  return { executionId: execution.id, approvalInstanceId }
}

const revisionsOf = async (
  recordId: string,
): Promise<
  Array<{
    action: string
    source: string
    actor_id: string | null
    version: number
    snapshot: Record<string, unknown> | null
    changed_field_ids: string[]
  }>
> =>
  (
    await q(
      `SELECT action, source, actor_id, version, snapshot, changed_field_ids
         FROM meta_record_revisions WHERE record_id = $1 ORDER BY created_at ASC, version ASC`,
      [recordId],
    )
  ).rows as never[]

const recordRow = async (
  recordId: string,
): Promise<{ id: string; data: Record<string, unknown>; version: number } | undefined> =>
  (await q('SELECT id, data, version FROM meta_records WHERE id = $1', [recordId])).rows[0] as
    | { id: string; data: Record<string, unknown>; version: number }
    | undefined

async function cutoffAfter(recordId: string, version: number): Promise<string> {
  const res = await q(
    `SELECT (created_at + interval '1 microsecond')::text AS as_of
       FROM meta_record_revisions WHERE record_id = $1 AND version = $2
       ORDER BY created_at DESC LIMIT 1`,
    [recordId, version],
  )
  expect(res.rows).toHaveLength(1)
  return String((res.rows[0] as { as_of: string }).as_of)
}

/** Genuine Postgres-level failure injection (never a JS-level mock/stub). */
async function injectTrigger(
  name: string,
  spec: { table: string; timing: string; when: string; errcode: string; message: string },
): Promise<void> {
  await q(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $fn$
           BEGIN
             RAISE EXCEPTION '${spec.message}' USING ERRCODE = '${spec.errcode}';
           END $fn$ LANGUAGE plpgsql`)
  await q(`CREATE TRIGGER ${name}_trg BEFORE ${spec.timing} ON ${spec.table}
           FOR EACH ROW WHEN (${spec.when}) EXECUTE FUNCTION ${name}()`)
}
async function dropTrigger(name: string, table: string): Promise<void> {
  await q(`DROP TRIGGER IF EXISTS ${name}_trg ON ${table}`).catch(() => {})
  await q(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => {})
}

/**
 * Block until a backend is GENUINELY waiting on the `meta_records` row lock held by THIS test's holder
 * connection — same technique as slice ③'s `waitUntilBlockedOnRecordLock`. Correlated to the holder's OWN
 * backend pid via `pg_blocking_pids(pid)` so an unrelated lock-waiter elsewhere in this shared integration
 * database can never satisfy the probe. Throws (never silently returns) if it never blocks.
 */
async function waitUntilBlockedOnRecordLock(blockerPid: number, queryLike: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await q(
      `SELECT COUNT(*)::int AS c FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query ILIKE $2`,
      [blockerPid, queryLike],
    )
    if ((r.rows[0] as { c: number }).c >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `approval resultWriteback's UPDATE never blocked on the meta_records row lock HELD BY THIS TEST (pid ${blockerPid}) — interleaving did not occur`,
  )
}

describeIfDatabase('D-1c slice ④ — approval resultWriteback writes approval revisions (real DB)', () => {
  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    await seedUsers()
    await makeBase(BASE, 'D1C4 Base', REQUESTER)
    await makeSheet(SHEET, BASE, 'D1C4 Main')
    await makeSheet(SHEET_FAIL, BASE, 'D1C4 Fail')
    await makeSheet(SHEET_RACE, BASE, 'D1C4 Race')
    await makeBase(XB_BASE, 'D1C4 XB Target Base', REQUESTER)
    await makeSheet(XB_SHEET, XB_BASE, 'D1C4 XB Target Sheet')

    await makeField(FLD_TITLE, SHEET, 'Title', 'string', {}, 1)
    await seedWritebackFields(SHEET, FLD_STATUS, FLD_APPROVER, FLD_COMPLETED)
    await makeField(FLD_PIT_TITLE, SHEET, 'PIT Title', 'string', {}, 2)
    await makeField(FLD_PIT_STATUS, SHEET, 'PIT Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 3)
    await makeField(FLD_FAIL_TITLE, SHEET_FAIL, 'Title', 'string', {}, 1)
    await makeField(FLD_FAIL_STATUS, SHEET_FAIL, 'Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 2)
    await makeField(FLD_RACE_TITLE, SHEET_RACE, 'Title', 'string', {}, 1)
    await makeField(FLD_RACE_STATUS, SHEET_RACE, 'Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 2)
    await makeField(FLD_XB_SRC_TITLE, SHEET, 'XB Src Title', 'string', {}, 4)
    await makeField(FLD_XB_STATUS, XB_SHEET, 'XB Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 10)
    await makeField(FLD_XB_APPROVER, XB_SHEET, 'XB Approved By', 'string', {}, 11)

    await seedRecordWithCreateRevision(RECORD, SHEET, { [FLD_TITLE]: 'Q4 plan' })
    await seedRecordWithCreateRevision(RECORD_PIT, SHEET, { [FLD_PIT_TITLE]: 'pit-v1' })
    await seedRecordWithCreateRevision(RECORD_FAIL, SHEET_FAIL, { [FLD_FAIL_TITLE]: 'fail-pre' })
    await seedRecordWithCreateRevision(RECORD_RACE, SHEET_RACE, { [FLD_RACE_TITLE]: 'race-v1' })
    await seedRecordWithCreateRevision(RECORD_XB_SRC, SHEET, { [FLD_XB_SRC_TITLE]: 'xb source' })
    await q(`INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,'{}'::jsonb,1)`, [XB_RECORD, XB_SHEET])
  })

  afterAll(async () => {
    for (const id of executionIds) {
      await q('DELETE FROM multitable_automation_approval_bridges WHERE execution_id = $1', [id])
      await q('DELETE FROM multitable_automation_suspensions WHERE execution_id = $1', [id])
      await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id])
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
    }
    for (const id of approvalIds) {
      await q('DELETE FROM approval_records WHERE instance_id = $1', [id])
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [id])
      await q('DELETE FROM approval_instances WHERE id = $1', [id])
    }
    for (const id of ruleIds) {
      await q('DELETE FROM automation_rules WHERE id = $1', [id])
    }
    for (const sheet of [SHEET, SHEET_FAIL, SHEET_RACE, XB_SHEET]) {
      await q(
        'DELETE FROM meta_record_revisions WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)',
        [sheet],
      ).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [XB_BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G1: approved same-base resultWriteback writes a revision: action=update source=approval actorId=<approver>, FULL merged snapshot (G4 merge-trap)', async () => {
    const svc = realService()
    try {
      const RW = { statusField: FLD_STATUS, approverField: FLD_APPROVER, completedAtField: FLD_COMPLETED }
      await executeAndApprove(svc, SHEET, RECORD, `d1c4-g1-${TS}`, RW, 'Q4 plan')

      const row = await recordRow(RECORD)
      expect(row?.version).toBe(2)
      expect(row?.data[FLD_TITLE]).toBe('Q4 plan') // untouched field survives on the LIVE row too
      expect(row?.data[FLD_STATUS]).toBe('approved')
      expect(row?.data[FLD_APPROVER]).toBe(APPROVER)

      const revs = await revisionsOf(RECORD)
      expect(revs).toHaveLength(2) // create (v1, fixture) + update (v2, the writeback)
      const updateRev = revs.find((r) => r.action === 'update')!
      expect(updateRev.source).toBe('approval')
      expect(updateRev.actor_id).toBe(APPROVER)
      expect(updateRev.version).toBe(2)
      expect(new Set(updateRev.changed_field_ids)).toEqual(new Set([FLD_STATUS, FLD_APPROVER, FLD_COMPLETED]))

      // G4 THE MERGE TRAP: the writeback patch touches ONLY 3 keys (statusField/approverField/
      // completedAtField) — FLD_TITLE is untouched. A naive `snapshot: patch` would DROP it; the FULL
      // post-merge row must carry it.
      expect(updateRev.snapshot?.[FLD_TITLE]).toBe('Q4 plan')
      expect(updateRev.snapshot?.[FLD_STATUS]).toBe('approved')
      expect(updateRev.snapshot?.[FLD_APPROVER]).toBe(APPROVER)
      expect(typeof updateRev.snapshot?.[FLD_COMPLETED]).toBe('string')
    } finally {
      svc.shutdown()
    }
  })

  test('reconstructRecordsAtT(after writeback) returns the NEW value+version (was the PIT LIE before the fix); asOf BEFORE the writeback still returns the pre-writeback value', async () => {
    const svc = realService()
    try {
      const RW = { statusField: FLD_PIT_STATUS }
      const beforeCutoff = await cutoffAfter(RECORD_PIT, 1)

      await executeAndApprove(svc, SHEET, RECORD_PIT, `d1c4-pit-${TS}`, RW, 'pit-v1')
      const afterCutoff = await cutoffAfter(RECORD_PIT, 2)

      // asOf STRICTLY BEFORE the writeback must still report the pre-writeback value — the new revision
      // must not corrupt earlier T.
      const beforeState = await reconstructRecordsAtT(q, SHEET, beforeCutoff, [RECORD_PIT])
      expect(beforeState.get(RECORD_PIT)).toMatchObject({
        exists: true,
        version: 1,
        data: { [FLD_PIT_TITLE]: 'pit-v1' },
      })

      // The headline golden: asOf AFTER the writeback must report the NEW value+version. Before the fix
      // this returned {version:1, data without approval fields} FOREVER (the A7 PIT lie) because no v2
      // revision existed for reconstructRecordsAtT to see.
      const afterState = await reconstructRecordsAtT(q, SHEET, afterCutoff, [RECORD_PIT])
      expect(afterState.get(RECORD_PIT)).toMatchObject({
        exists: true,
        version: 2,
        data: { [FLD_PIT_TITLE]: 'pit-v1', [FLD_PIT_STATUS]: 'approved' },
      })
    } finally {
      svc.shutdown()
    }
  })

  test('ATOMICITY + TRANSACTION-BOUNDARY: a failing revision INSERT rolls back the writeback UPDATE too — record stays at its ORIGINAL pre-writeback value', async () => {
    const svc = realService()
    const trg = `d1c4_fail_trg_${TS}`
    try {
      await injectTrigger(trg, {
        table: 'meta_record_revisions',
        timing: 'INSERT',
        when: `NEW.source = 'approval' AND NEW.sheet_id = '${SHEET_FAIL}'`,
        errcode: 'P0001',
        message: 'D1C4 injected approval-revision failure',
      })

      const RW = { statusField: FLD_FAIL_STATUS }
      const { executionId } = await executeAndApprove(svc, SHEET_FAIL, RECORD_FAIL, `d1c4-fail-${TS}`, RW, 'fail-pre')

      // The resume swallows a backwrite failure (tryWriteApprovalResultBack's try/catch) so the overall
      // execution still completes 'success' — but the step output surfaces the skip, and (the
      // discriminating assertion) NOTHING about the record actually changed: the whole txn rolled back.
      const execution = (await svc.logs.getById(executionId))!
      const startStep = execution.steps.find((s) => s.actionType === 'start_approval')
      expect(startStep?.output).toMatchObject({ backwriteSkipped: expect.stringContaining('injected approval-revision failure') })

      const row = await recordRow(RECORD_FAIL)
      expect(row).toMatchObject({ version: 1, data: { [FLD_FAIL_TITLE]: 'fail-pre' } })

      const revs = await revisionsOf(RECORD_FAIL)
      expect(revs).toHaveLength(1) // only the fixture create — no spurious update was left behind
      expect(revs[0]).toMatchObject({ action: 'create', version: 1 })
    } finally {
      await dropTrigger(trg, 'meta_record_revisions')
      svc.shutdown()
    }
  })

  // ── THE ZERO-ROW FAIL-CLOSED GOLDEN ─────────────────────────────────────────────────────────────
  // GENUINE two-connection lock race (never a sleep heuristic): Connection A (this test's "holder") opens
  // its own dedicated raw client, BEGINs, and DELETEs the source record — an uncommitted, row-locking
  // delete. Connection B is the REAL dispatchAction(...) -> event-bus -> handleApprovalCompletionEvent ->
  // applyResultWritebackPatch chain: its plain reads (the recordData hydration SELECT, the lock-check
  // SELECT) succeed immediately under MVCC (they see the pre-delete committed snapshot), but the
  // writeback's UPDATE — the first point that actually needs the row lock — blocks behind the holder's
  // uncommitted DELETE. Only once `waitUntilBlockedOnRecordLock` deterministically confirms B is genuinely
  // parked behind A's lock does A COMMIT. B's UPDATE then resumes under READ COMMITTED semantics,
  // discovers the row was concurrently deleted, and affects ZERO rows.
  test('CONCURRENT-DELETE golden: a DELETE that commits WHILE the writeback UPDATE is blocked on the row lock produces a zero-row UPDATE — resume still reports SUCCESS (pre-existing leniency preserved) and writes NO spurious revision', async () => {
    const svc = realService()
    try {
      const RW = { statusField: FLD_RACE_STATUS }
      const templateId = await createPublishedTemplate(`d1c4-race-${TS}`)
      const ruleId = await createStartApprovalRule(svc, SHEET_RACE, templateId, RW)
      const execRule = {
        id: ruleId,
        name: 'D1C4 start approval',
        sheetId: SHEET_RACE,
        trigger: { type: 'record.created', config: {} },
        actions: [
          { type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } },
          { type: 'send_webhook', config: { url: 'https://example.test/d1c4-race-tail' } },
        ],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }
      const execution = await svc.executeRule(execRule as never, { sheetId: SHEET_RACE, recordId: RECORD_RACE, data: { title: 'race-v1' }, actorId: REQUESTER })
      executionIds.push(execution.id)
      const bridge = await q(`SELECT approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`, [execution.id])
      const approvalInstanceId = bridge.rows[0].approval_instance_id as string
      approvalIds.push(approvalInstanceId)

      const rawPool = poolManager.get().getInternalPool()
      const holder = await rawPool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('DELETE FROM meta_records WHERE id = $1', [RECORD_RACE])
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

        const approvals = new ApprovalProductService()
        const dispatchPromise = approvals.dispatchAction(
          approvalInstanceId,
          { action: 'approve', comment: 'go' },
          { userId: APPROVER, userName: APPROVER },
        )
        // dispatchAction itself only touches approval_* tables and returns once its own txn commits +
        // the completion event is emitted (fire-and-forget) — it does NOT wait for the resume.
        await dispatchPromise

        // Barrier: block until the resume's writeback UPDATE is deterministically confirmed parked
        // behind the holder's lock on THIS record.
        await waitUntilBlockedOnRecordLock(holderPid, '%UPDATE meta_records%')

        // A commits ⇒ the row is truly gone ⇒ B's UPDATE unblocks and sees ZERO matching rows.
        await holder.query('COMMIT')
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        holder.release()
      }

      await waitForExecutionStatus(svc, execution.id, 'success')

      // THE discriminating assertion: exactly the original fixture create revision — no spurious `update`.
      const revs = await revisionsOf(RECORD_RACE)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')

      // Genuine concurrent DELETE — no live row left to compare against.
      expect(await recordRow(RECORD_RACE)).toBeUndefined()
    } finally {
      svc.shutdown()
    }
  }, 15000)

  test('CROSS-BASE spot check: approved cross-base resultWriteback writes a revision on the TARGET record (actorId=TRIGGER actor, not the approver); SOURCE record gets no extra revision', async () => {
    const svc = realService()
    try {
      const RW = { statusField: FLD_XB_STATUS, approverField: FLD_XB_APPROVER, targetBaseId: XB_BASE, targetSheetId: XB_SHEET, targetRecordId: XB_RECORD }
      const templateId = await createPublishedTemplate(`d1c4-xb-${TS}`)
      const ruleId = await createStartApprovalRule(svc, SHEET, templateId, RW)
      const execRule = {
        id: ruleId,
        name: 'D1C4 start approval',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          { type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } },
          { type: 'send_webhook', config: { url: 'https://example.test/d1c4-xb-tail' } },
        ],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }
      // REQUESTER is the TRIGGER actor (owns XB_BASE — authorizes the cross-base write) AND the human who
      // later approves is APPROVER (a DIFFERENT identity) — this is what proves the revision's actorId
      // follows the TRIGGER actor, not the approval actor, on the cross-base branch.
      const execution = await svc.executeRule(execRule as never, { sheetId: SHEET, recordId: RECORD_XB_SRC, data: { title: 'xb source' }, actorId: REQUESTER })
      executionIds.push(execution.id)
      const bridge = await q(`SELECT approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`, [execution.id])
      const approvalInstanceId = bridge.rows[0].approval_instance_id as string
      approvalIds.push(approvalInstanceId)
      const approvals = new ApprovalProductService()
      await approvals.dispatchAction(approvalInstanceId, { action: 'approve', comment: 'go' }, { userId: APPROVER, userName: APPROVER })
      await waitForExecutionStatus(svc, execution.id, 'success')

      const tgtRow = await recordRow(XB_RECORD)
      expect(tgtRow?.version).toBe(2)
      const tgtRevs = await revisionsOf(XB_RECORD)
      expect(tgtRevs).toHaveLength(1) // this record started at a bare INSERT-only v1 fixture with no revision — only the writeback revision exists
      expect(tgtRevs[0]).toMatchObject({ action: 'update', source: 'approval', actor_id: REQUESTER, version: 2 })
      expect(tgtRevs[0]!.snapshot?.[FLD_XB_STATUS]).toBe('approved')
      expect(tgtRevs[0]!.snapshot?.[FLD_XB_APPROVER]).toBe(APPROVER) // the VALUE is still the approval actor — only actorId provenance differs

      // Anti-misroute: the SOURCE record gets NO extra revision from the cross-base backwrite.
      const srcRevs = await revisionsOf(RECORD_XB_SRC)
      expect(srcRevs).toHaveLength(1)
      expect(srcRevs[0]).toMatchObject({ action: 'create' })
    } finally {
      svc.shutdown()
    }
  })
})
