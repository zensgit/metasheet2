/**
 * SHEET LIVENESS on the three DIRECT-EXECUTE lanes (#5803).
 *
 * The record lane, the scheduled lane, the template-keyed approval loaders (#5801) and the approval bridge
 * continuation (#5804) all refuse a soft-deleted sheet. Three more lanes hand ONE already-loaded rule to the
 * executor themselves and passed none of those checks:
 *   · INBOUND WEBHOOK  `handleInboundWebhook` → `executeRule` (driven by an EXTERNAL system)
 *   · ADMIN RETRY      `retryExecution`       → `executeRule`
 *   · ADMIN RESUME     `resumeExecution`      → `executor.continueExecution` / `continueBranchExecution`
 * The executor's same-sheet fast path never reads `meta_sheets`, so a same-sheet `create_record` INSERTed into
 * the deleted sheet and `send_webhook` kept pushing data out.
 *
 * What is pinned here, per lane:
 *   1. deleted sheet → nothing runs; the refusal is as designed:
 *        webhook: the SAME uniform `401 { ok:false }` as an unknown rule / a disabled rule / a bad signature
 *                 (asserted over HTTP against the real router), reason `sheet_deleted` only in metric + log;
 *        retry:   coded 409 `SHEET_DELETED` with an admin-facing, values-free reason; nothing persisted and
 *                 the one-shot first-retry marker NOT spent;
 *        resume:  coded 409 `SHEET_DELETED`; the single-use token NOT claimed, the record NOT re-read,
 *                 nothing persisted.
 *   2. live sheet   → unchanged.
 *   3. absent sheet → passes (`=== 'deleted'`, the comparison every other lane makes).
 *   4. lookup THROWS → FAIL-OPEN (the run proceeds), observable as a values-free WARN (class + driver code).
 *   5. webhook NO-ORACLE: a bad / missing / stale signature on a deleted sheet gets the SIGNATURE refusal, and
 *      the liveness lookup is never even issued for an unauthenticated delivery.
 *   6. one definition: every lane goes through `dropRulesOnDeletedSheets` with exactly its one rule.
 *   7. NO NARROWING of the check (each has a live-sheet control, so the refusal is not a fixture artifact):
 *        · resume: a `condition_branch` cursor is refused like a top-level one — before the claim, and
 *          `continueBranchExecution` never runs;
 *        · webhook + retry: an EGRESS-ONLY rule (`[send_webhook]`, no write to the dead sheet) is refused too —
 *          the push would still carry the deleted sheet's data out;
 *        · webhook: the sheet checked is the RULE's; a `sheetId` inside the signed body steers nothing, in
 *          either direction.
 *
 * Zero-DB: liveness and every other statement go through a fake queryFn that RECORDS what it is sent.
 * The item-7 cases (except resume, whose tail is stubbed as elsewhere) run the REAL executor behind a recording
 * fetch, so a narrowed check fails as the INSERT into the deleted sheet / the outbound push it really causes.
 * HTTP cases use the pinned-server transport (`request(pinned.url())`), never `request(app)` (CI #4154).
 */
import express from 'express'
import pg from 'pg'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Logger } from '../../src/core/logger'
import { EventBus } from '../../src/integration/events/event-bus'
import { metrics } from '../../src/metrics/metrics'
import {
  INBOUND_WEBHOOK_SIGNATURE_HEADER,
  INBOUND_WEBHOOK_TIMESTAMP_HEADER,
  signInboundWebhookBody,
} from '../../src/multitable/automation-inbound-webhook'
import {
  AutomationService,
  RESUME_SHEET_DELETED_MESSAGE,
  RETRY_SHEET_DELETED_MESSAGE,
  toExecutorRule,
} from '../../src/multitable/automation-service'
import type { AutomationExecution } from '../../src/multitable/automation-executor'
import { computeActionFingerprint } from '../../src/multitable/automation-suspension-service'
import { SHEET_DELETED_CODE } from '../../src/multitable/sheet-liveness'
import { automationWebhookJsonParser, createAutomationRoutes } from '../../src/routes/automation'
import { usePinnedServer } from '../utils/pinned-server'

// The admin routes are gated by requireAdminRole(); pass it through (an admin id is injected below) so the
// handler's refusal mapping is what is under test. Same approach as automation-runs-api.test.ts.
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

const LIVENESS_BATCH_SQL = /SELECT\s+id,\s*deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*ANY/i
const LIVENESS_ONE_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i
const RECORD_READ_SQL = /SELECT\s+data\s+FROM\s+meta_records\s+WHERE\s+id\s*=\s*\$1\s+AND\s+sheet_id\s*=\s*\$2/i
const FIRST_RETRY_MARKER_SQL = /first_retry_attempted_at\s+IS\s+NULL/i
const WRITE_SQL = /^\s*(WITH\b[\s\S]*\b)?(UPDATE|INSERT|DELETE)\b/i
const RECORD_INSERT_SQL = /^\s*INSERT\s+INTO\s+meta_records\s*\(/i

type SheetState = 'live' | 'deleted' | 'absent' | 'throws'
/** Per-sheet answers, for the cases where two sheets must answer differently; an unlisted id is absent. */
type SheetLivenessMap = Readonly<Record<string, 'live' | 'deleted'>>

interface HarnessOptions {
  /**
   * Run the REAL executor: `executeRule` stays a pass-through spy and outbound pushes go to a recording fetch,
   * so a regression shows as the INSERT / the push it would really cause, not only as a stub call.
   */
  realExecutor?: boolean
}

const SECRET = 'fixture-inbound-secret'
const SHEET = 'sheet_dx'
/** A sheet a webhook SENDER names in its body — never the rule's. */
const BODY_SHEET = 'sheet_named_in_body'
const RESUME_TOKEN = 'fixture-resume-token-value'
const OUTBOUND_URL = 'https://hooks.example.invalid/out'
/** An egress-only rule: nothing is written to the sheet, but its data still leaves the system. */
const EGRESS_ONLY = {
  action_type: 'send_webhook',
  action_config: { url: OUTBOUND_URL },
  actions: [{ type: 'send_webhook', config: { url: OUTBOUND_URL } }],
}

/** A REAL node-postgres server error, as the driver builds it; its text must never reach a log. */
function pgStatementTimeout(): Error {
  const err = new pg.DatabaseError('canceling statement due to statement timeout: host=db.internal', 120, 'error')
  err.code = '57014'
  return err
}

function ruleRow(over: Record<string, unknown> = {}) {
  return {
    id: 'atr_dx',
    sheet_id: SHEET,
    name: 'Direct-execute rule',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'create_record',
    action_config: {},
    enabled: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    created_by: 'u_author',
    conditions: null,
    // A same-sheet write (the executor fast path skips the base lookup) followed by an outbound push.
    actions: [
      { type: 'create_record', config: { fields: { fld_title: 'from automation' } } },
      { type: 'send_webhook', config: { url: 'https://hooks.example.invalid/out' } },
    ],
    execution_mode: null,
    ...over,
  }
}

function webhookRuleRow(over: Record<string, unknown> = {}) {
  return ruleRow({
    id: 'atr_wh',
    trigger_type: 'webhook.received',
    trigger_config: { secret: SECRET },
    ...over,
  })
}

function resumeRuleRow() {
  return ruleRow({
    id: 'atr_rs',
    execution_mode: 'workflow_job_v1',
    actions: [
      { type: 'wait_for_callback', config: {} },
      { type: 'create_record', config: { fields: { fld_title: 'after wait' } } },
      { type: 'send_webhook', config: { url: 'https://hooks.example.invalid/out' } },
    ],
  })
}

/** A rule whose only top-level action is a `condition_branch`; branch `b1` waits, then writes and pushes. */
function branchResumeRuleRow() {
  return ruleRow({
    id: 'atr_br',
    execution_mode: 'workflow_job_v1',
    actions: [
      {
        type: 'condition_branch',
        config: {
          branches: [
            {
              key: 'b1',
              actions: [
                { type: 'wait_for_callback', config: {} },
                { type: 'create_record', config: { fields: { fld_title: 'after branch wait' } } },
                { type: 'send_webhook', config: { url: OUTBOUND_URL } },
              ],
            },
          ],
        },
      },
    ],
  })
}

/** The cursor of a suspension on `b1`'s wait — consistent with every pre-claim branch gate of `resumeExecution`. */
function branchResumeCursor(rule: Record<string, unknown>) {
  const parent = toExecutorRule(rule as never).actions[0].config as { branches: Array<{ actions: unknown[] }> }
  return {
    kind: 'condition_branch' as const,
    cursor: {
      kind: 'condition_branch' as const,
      parentStepIndex: 0,
      branchKey: 'b1',
      branchActionIndex: 0,
      branchActionFingerprint: computeActionFingerprint(parent.branches[0].actions as never),
      stepKey: '0.branch.b1.0',
      parentJobId: 'axe_susp:job:0',
      branchJobId: 'axe_susp:job:0:branch:b1:0',
      upstreamJobId: 'axe_susp:job:0',
    },
  }
}

function execution(over: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    id: 'axe_orig',
    ruleId: 'atr_dx',
    triggeredBy: 'event',
    triggeredAt: new Date().toISOString(),
    status: 'failed',
    steps: [],
    sheetId: SHEET,
    triggerEvent: { recordId: 'rec_1', data: { fld_title: 't' } },
    ...over,
  }
}

interface Harness {
  service: AutomationService
  internals: Record<string, unknown>
  /** Every statement sent through queryFn, classified. */
  sql: string[]
  livenessIds: string[][]
  /** `sheet_id` of every `INSERT INTO meta_records` (only a real executor issues any). */
  recordInserts: string[]
  /** URL of every outbound push (only a real executor makes any). */
  outbound: string[]
  executeRule: ReturnType<typeof vi.spyOn>
  dropSpy: ReturnType<typeof vi.spyOn>
}

function makeHarness(sheet: SheetState | SheetLivenessMap, opts: HarnessOptions = {}): Harness {
  const sql: string[] = []
  const livenessIds: string[][] = []
  const recordInserts: string[] = []
  const outbound: string[] = []
  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (LIVENESS_BATCH_SQL.test(sqlText)) {
      const ids = [...((params?.[0] as string[]) ?? [])]
      sql.push('liveness')
      livenessIds.push(ids)
      if (typeof sheet === 'object') {
        const rows = ids
          .filter((id) => id in sheet)
          .map((id) => ({ id, deleted_at: sheet[id] === 'deleted' ? new Date('2026-09-10T00:00:00Z') : null }))
        return { rows, rowCount: rows.length }
      }
      if (sheet === 'throws') throw pgStatementTimeout()
      if (sheet === 'absent') return { rows: [], rowCount: 0 }
      const deletedAt = sheet === 'deleted' ? new Date('2026-09-10T00:00:00Z') : null
      return { rows: ids.map((id) => ({ id, deleted_at: deletedAt })), rowCount: ids.length }
    }
    if (LIVENESS_ONE_SQL.test(sqlText)) {
      // Not expected on these lanes (they use the batched helper); recorded so a fourth spelling shows up.
      sql.push('liveness-one')
      return { rows: [], rowCount: 0 }
    }
    if (RECORD_READ_SQL.test(sqlText)) {
      sql.push('record-read')
      // A soft delete does not cascade: the record is still there — exactly why the read cannot be the stop.
      return { rows: [{ data: { fld_title: 't' } }], rowCount: 1 }
    }
    if (FIRST_RETRY_MARKER_SQL.test(sqlText)) {
      sql.push('first-retry-marker')
      return { rows: [{ first_retry_attempt: true }], rowCount: 1 }
    }
    if (RECORD_INSERT_SQL.test(sqlText)) recordInserts.push(String(params?.[1]))
    const head = sqlText.trim().split(/\s+/).slice(0, 3).join(' ')
    sql.push(WRITE_SQL.test(sqlText) ? `write:${head}` : `other:${head}`)
    return { rows: [], rowCount: 0 }
  })
  const fetchFn = vi.fn(async (url: unknown) => {
    outbound.push(String(url))
    return new Response('{}', { status: 200 })
  })

  const service = new AutomationService(new EventBus(), {} as never, queryFn as never, fetchFn as never)
  const internals = service as never as Record<string, unknown>
  // Fire-and-forget housekeeping on the retry lane; not what this suite is about.
  internals.sweepAutomationRetryLedger = vi.fn(async () => 0)
  internals.approvalBridgeService = { hasCreatedApprovalForAnyExecution: vi.fn(async () => false) }
  let executeRule: ReturnType<typeof vi.spyOn>
  if (opts.realExecutor) {
    // The executor's write path runs inside `deps.transaction`, which the constructor wires to the real pool:
    // route it through the recording queryFn. Persisting the run's log row is not what is under test.
    ;(internals.executor as { deps: { transaction?: unknown } }).deps.transaction = async (
      handler: (tx: { query: unknown }) => Promise<unknown>,
    ) => handler({ query: queryFn })
    vi.spyOn(service.logs, 'record').mockResolvedValue(undefined)
    vi.spyOn(service.logs, 'updateRecordedExecution').mockResolvedValue(undefined)
    executeRule = vi.spyOn(service, 'executeRule') as ReturnType<typeof vi.spyOn>
  } else {
    executeRule = vi.spyOn(service, 'executeRule').mockImplementation(
      async (rule) => execution({ id: 'axe_new', ruleId: rule.id, status: 'success' }),
    ) as ReturnType<typeof vi.spyOn>
  }
  const dropSpy = vi.spyOn(
    internals as never as { dropRulesOnDeletedSheets: (...args: unknown[]) => Promise<unknown[]> },
    'dropRulesOnDeletedSheets',
  ) as ReturnType<typeof vi.spyOn>
  return { service, internals, sql, livenessIds, recordInserts, outbound, executeRule, dropSpy }
}

let warn: ReturnType<typeof vi.spyOn>
let allLogs: ReturnType<typeof vi.spyOn>[] = []

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>
  allLogs = [
    warn,
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>,
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>,
    vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>,
    vi.spyOn(console, 'warn').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>,
    vi.spyOn(console, 'error').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>,
  ]
})

afterEach(() => {
  vi.restoreAllMocks()
})

const reasonWarns = (reason: string) =>
  warn.mock.calls.filter((call) => (call[1] as { reason?: string } | undefined)?.reason === reason)

/** Everything any logger was handed, flattened — for the values-free assertions. */
function loggedText(): string {
  return JSON.stringify(allLogs.flatMap((spy) => spy.mock.calls), (_k, v) => (v instanceof Error ? `${v.name}:${v.message}` : v))
}

function expectFailOpenWarn(channel: string, extra: Record<string, unknown> = {}) {
  const [message, meta] = reasonWarns('liveness_lookup_failed')[0] ?? []
  expect(reasonWarns('liveness_lookup_failed'), 'the fail-open keep must be observable').toHaveLength(1)
  expect(String(message)).toContain(channel)
  expect(meta).toMatchObject({
    channel,
    reason: 'liveness_lookup_failed',
    ruleCount: 1,
    errorClass: 'DatabaseError',
    errorCode: '57014',
    ...extra,
  })
  const text = loggedText()
  expect(text, 'the error TEXT (it can carry connection details) must never be logged').not.toContain('db.internal')
  expect(text).not.toContain('statement timeout')
}

// ── INBOUND WEBHOOK ──────────────────────────────────────────────────────────────────────────────

function signed(body: unknown, nowMs: number, secret = SECRET) {
  const rawBody = Buffer.from(JSON.stringify(body))
  const ts = Math.floor(nowMs / 1000)
  return {
    rawBody,
    parsed: body,
    headers: {
      [INBOUND_WEBHOOK_TIMESTAMP_HEADER]: String(ts),
      [INBOUND_WEBHOOK_SIGNATURE_HEADER]: signInboundWebhookBody(rawBody, secret, ts),
    } as Record<string, unknown>,
  }
}

describe('inbound webhook — sheet liveness (#5803)', () => {
  const NOW = Date.parse('2026-09-16T08:00:00.000Z')
  const BODY = { orderNo: 'fixture-1', qty: 2 }

  function withRule(h: Harness, rule: Record<string, unknown> | null = webhookRuleRow()) {
    vi.spyOn(h.service, 'getRule').mockResolvedValue(rule as never)
  }

  it('deleted sheet + VALID signature → rejected as `sheet_deleted`; executeRule never called; metric + WARN say why', async () => {
    const h = makeHarness('deleted')
    withRule(h)
    const labels = vi.spyOn(metrics.automationWebhookRejectedTotal, 'labels')
    const req = signed(BODY, NOW)

    const result = await h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW)

    expect(result).toEqual({ accepted: false, reason: 'sheet_deleted' })
    expect(h.executeRule, 'nothing may run for a soft-deleted sheet').not.toHaveBeenCalled()
    expect(h.sql, 'the ONLY statement is the liveness read — no INSERT into the deleted sheet').toEqual(['liveness'])
    expect(h.livenessIds).toEqual([[SHEET]])
    expect(labels).toHaveBeenCalledWith('sheet_deleted')
    expect(reasonWarns('sheet_deleted')).toHaveLength(1)
    expect(reasonWarns('sheet_deleted')[0][1]).toEqual({
      channel: 'webhook.received',
      sheetId: SHEET,
      reason: 'sheet_deleted',
      ruleCount: 1,
      ruleIds: ['atr_wh'],
    })
    expect(warn.mock.calls.some((c) => String(c[0]) === 'webhook.received rejected rule=atr_wh reason=sheet_deleted')).toBe(true)
  })

  it('live sheet → unchanged: executeRule runs once with the synthetic trigger event', async () => {
    const h = makeHarness('live')
    withRule(h)
    const req = signed(BODY, NOW)

    const result = await h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW)

    expect(result).toMatchObject({ accepted: true, execution: { id: 'axe_new' } })
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expect(h.executeRule.mock.calls[0][1]).toEqual({
      sheetId: SHEET,
      recordId: '',
      data: BODY,
      actorId: null,
      _triggeredBy: 'webhook.received',
      webhook: { body: BODY },
    })
    expect(reasonWarns('sheet_deleted')).toHaveLength(0)
  })

  it('absent sheet → passes (`=== deleted`, not `!== live`)', async () => {
    const h = makeHarness('absent')
    withRule(h)
    const req = signed(BODY, NOW)

    await expect(h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW))
      .resolves.toMatchObject({ accepted: true })
    expect(h.executeRule).toHaveBeenCalledTimes(1)
  })

  it('lookup THROWS → FAIL-OPEN: the delivery runs, and the keep is a values-free WARN', async () => {
    const h = makeHarness('throws')
    withRule(h)
    const req = signed(BODY, NOW)

    await expect(h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW))
      .resolves.toMatchObject({ accepted: true })
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expectFailOpenWarn('webhook.received')
  })

  it('NO ORACLE: a bad / missing / stale signature on a DELETED sheet gets the signature refusal, and liveness is never looked up', async () => {
    const cases: Array<{ name: string; headers: (h: Record<string, unknown>) => Record<string, unknown>; reason: string }> = [
      { name: 'wrong secret', headers: () => signed(BODY, NOW, 'not-the-secret').headers, reason: 'bad_signature' },
      {
        name: 'missing signature',
        headers: (hd) => ({ [INBOUND_WEBHOOK_TIMESTAMP_HEADER]: hd[INBOUND_WEBHOOK_TIMESTAMP_HEADER] }),
        reason: 'missing_signature',
      },
      { name: 'stale timestamp', headers: () => signed(BODY, NOW - 3_600_000).headers, reason: 'stale_timestamp' },
    ]
    for (const c of cases) {
      const h = makeHarness('deleted')
      withRule(h)
      const good = signed(BODY, NOW)
      const result = await h.service.handleInboundWebhook('atr_wh', good.rawBody, good.parsed, c.headers(good.headers), NOW)
      expect(result, c.name).toEqual({ accepted: false, reason: c.reason })
      expect(h.sql, `${c.name}: an unauthenticated delivery must not trigger the liveness lookup`).toEqual([])
      expect(h.executeRule).not.toHaveBeenCalled()
    }
  })

  it('NO ORACLE (control): the same bad signature on a LIVE sheet is refused identically', async () => {
    const results: unknown[] = []
    const statements: string[][] = []
    for (const state of ['live', 'deleted', 'absent', 'throws'] as const) {
      const h = makeHarness(state)
      withRule(h)
      const bad = signed(BODY, NOW, 'not-the-secret')
      results.push(await h.service.handleInboundWebhook('atr_wh', bad.rawBody, bad.parsed, bad.headers, NOW))
      statements.push(h.sql)
    }
    expect(results).toEqual(Array(4).fill({ accepted: false, reason: 'bad_signature' }))
    expect(statements).toEqual([[], [], [], []])
  })

  it('one definition: the lane asks `dropRulesOnDeletedSheets` about exactly its one rule', async () => {
    const h = makeHarness('live')
    withRule(h)
    const req = signed(BODY, NOW)
    await h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW)
    expect(h.dropSpy).toHaveBeenCalledTimes(1)
    const [rules, channel] = h.dropSpy.mock.calls[0] as [Array<{ id: string }>, string]
    expect(rules.map((r) => r.id)).toEqual(['atr_wh'])
    expect(channel).toBe('webhook.received')
    expect(h.sql).not.toContain('liveness-one')
  })

  it('EGRESS-ONLY rule (`[send_webhook]` only) + deleted sheet → refused all the same; nothing is pushed out (real executor)', async () => {
    const h = makeHarness('deleted', { realExecutor: true })
    withRule(h, webhookRuleRow(EGRESS_ONLY))
    const req = signed(BODY, NOW)

    const result = await h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW)

    expect(result).toEqual({ accepted: false, reason: 'sheet_deleted' })
    expect(h.executeRule, 'no write action is no exemption: the push still carries data out').not.toHaveBeenCalled()
    expect(h.outbound).toEqual([])
    expect(h.sql).toEqual(['liveness'])
  })

  it('EGRESS-ONLY rule + LIVE sheet (control) → the real executor pushes exactly once, so the zero above is the refusal', async () => {
    const h = makeHarness('live', { realExecutor: true })
    withRule(h, webhookRuleRow(EGRESS_ONLY))
    const req = signed(BODY, NOW)

    await expect(h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW))
      .resolves.toMatchObject({ accepted: true })
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expect(h.outbound).toEqual([OUTBOUND_URL])
    expect(h.recordInserts).toEqual([])
  })

  it('a `sheetId` in the SIGNED body cannot steer the check: rule sheet deleted, body names a LIVE sheet → still `sheet_deleted` (real executor)', async () => {
    const h = makeHarness({ [SHEET]: 'deleted', [BODY_SHEET]: 'live' }, { realExecutor: true })
    withRule(h)
    const req = signed({ ...BODY, sheetId: BODY_SHEET }, NOW)

    const result = await h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW)

    expect(result).toEqual({ accepted: false, reason: 'sheet_deleted' })
    expect(h.executeRule).not.toHaveBeenCalled()
    expect(h.livenessIds, "the sheet asked about is the RULE's, never one the sender names").toEqual([[SHEET]])
    expect(h.recordInserts).toEqual([])
    expect(h.outbound).toEqual([])
  })

  it("… nor the other way (control): rule sheet LIVE, body names a DELETED sheet → accepted, and the write lands on the rule's sheet", async () => {
    const h = makeHarness({ [SHEET]: 'live', [BODY_SHEET]: 'deleted' }, { realExecutor: true })
    withRule(h)
    const req = signed({ ...BODY, sheetId: BODY_SHEET }, NOW)

    await expect(h.service.handleInboundWebhook('atr_wh', req.rawBody, req.parsed, req.headers, NOW))
      .resolves.toMatchObject({ accepted: true })
    expect(h.livenessIds).toEqual([[SHEET]])
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expect(h.executeRule.mock.calls[0][1]).toMatchObject({ sheetId: SHEET })
    expect(h.recordInserts).toEqual([SHEET])
    expect(h.outbound).toEqual([OUTBOUND_URL])
  })

  describe('over HTTP (real router + raw-body parser, pinned server)', () => {
    const pinned = usePinnedServer()
    let h: Harness
    let getRule: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      h = makeHarness('deleted')
      getRule = vi.spyOn(h.service, 'getRule') as ReturnType<typeof vi.spyOn>
      const app = express()
      // Mirrors production mounting (index.ts): the raw-body parser owns this prefix.
      app.use('/api/multitable/automation/webhooks', automationWebhookJsonParser)
      app.use(express.json())
      app.use('/api/multitable', createAutomationRoutes(h.service))
      pinned.setApp(app)
    })

    async function post(ruleId: string, secret = SECRET) {
      const body = JSON.stringify(BODY)
      const ts = Math.floor(Date.now() / 1000)
      const res = await request(pinned.url())
        .post(`/api/multitable/automation/webhooks/${ruleId}`)
        .set('Content-Type', 'application/json')
        .set(INBOUND_WEBHOOK_TIMESTAMP_HEADER, String(ts))
        .set(INBOUND_WEBHOOK_SIGNATURE_HEADER, signInboundWebhookBody(body, secret, ts))
        .send(body)
      return { status: res.status, body: res.body, contentType: res.headers['content-type'], length: res.headers['content-length'] }
    }

    it('a deleted sheet is INDISTINGUISHABLE from an unknown rule, a disabled rule and a bad signature', async () => {
      getRule.mockImplementation(async (id: string) => {
        if (id === 'atr_unknown') return null
        if (id === 'atr_disabled') return webhookRuleRow({ id, enabled: false })
        return webhookRuleRow({ id })
      })

      const deletedSheet = await post('atr_deleted_sheet')
      const unknownRule = await post('atr_unknown')
      const disabledRule = await post('atr_disabled')
      const badSignature = await post('atr_bad_sig', 'not-the-secret')

      expect(deletedSheet).toEqual({ status: 401, body: { ok: false }, contentType: expect.stringContaining('application/json'), length: '12' })
      expect(unknownRule).toEqual(deletedSheet)
      expect(disabledRule).toEqual(deletedSheet)
      expect(badSignature).toEqual(deletedSheet)
      expect(h.executeRule).not.toHaveBeenCalled()
    })

    it('control: the same request on a LIVE sheet is accepted (202), so the 401 above is the liveness refusal', async () => {
      const live = makeHarness('live')
      vi.spyOn(live.service, 'getRule').mockResolvedValue(webhookRuleRow({ id: 'atr_live_http' }) as never)
      const app = express()
      app.use('/api/multitable/automation/webhooks', automationWebhookJsonParser)
      app.use(express.json())
      app.use('/api/multitable', createAutomationRoutes(live.service))
      pinned.setApp(app)

      const res = await post('atr_live_http')

      expect(res.status).toBe(202)
      expect(res.body).toEqual({ ok: true, executionId: 'axe_new', status: 'success' })
      expect(live.executeRule).toHaveBeenCalledTimes(1)
    })
  })
})

// ── ADMIN RETRY ──────────────────────────────────────────────────────────────────────────────────

describe('admin retry — sheet liveness (#5803)', () => {
  function retryHarness(state: SheetState, ruleOver: Record<string, unknown> = {}, opts: HarnessOptions = {}) {
    const h = makeHarness(state, opts)
    const original = execution()
    vi.spyOn(h.service.logs, 'getById').mockResolvedValue(original)
    const record = vi.spyOn(h.service.logs, 'record').mockResolvedValue(undefined)
    const update = vi.spyOn(h.service.logs, 'updateRecordedExecution').mockResolvedValue(undefined)
    vi.spyOn(h.service, 'getRule').mockResolvedValue(ruleRow(ruleOver) as never)
    return { ...h, original, record, update }
  }

  it('deleted sheet → 409 SHEET_DELETED with the admin reason; nothing runs, nothing is persisted, the first-retry marker is NOT spent', async () => {
    const h = retryHarness('deleted')

    const result = await h.service.retryExecution('axe_orig', 'admin1')

    expect(result).toEqual({ status: 409, code: SHEET_DELETED_CODE, message: RETRY_SHEET_DELETED_MESSAGE })
    expect(h.executeRule).not.toHaveBeenCalled()
    expect(h.sql, 'only the liveness read — the one-shot marker CAS must survive for the post-restore retry').toEqual(['liveness'])
    expect(h.record).not.toHaveBeenCalled()
    expect(h.update).not.toHaveBeenCalled()
    expect(reasonWarns('sheet_deleted')).toHaveLength(1)
    expect(reasonWarns('sheet_deleted')[0][1]).toEqual({
      executionId: 'axe_orig',
      channel: 'automation.retry',
      sheetId: SHEET,
      reason: 'sheet_deleted',
      ruleCount: 1,
      ruleIds: ['atr_dx'],
    })
  })

  it('the admin reason is coded, actionable and values-free', () => {
    expect(RETRY_SHEET_DELETED_MESSAGE.startsWith(`${SHEET_DELETED_CODE}:`)).toBe(true)
    expect(RETRY_SHEET_DELETED_MESSAGE).toMatch(/not retried/)
    expect(RETRY_SHEET_DELETED_MESSAGE).toMatch(/restore the sheet/)
    for (const id of ['axe_orig', 'atr_dx', SHEET, 'admin1']) expect(RETRY_SHEET_DELETED_MESSAGE).not.toContain(id)
  })

  it('live sheet → unchanged: marker claimed, executeRule runs with the stored event + provenance', async () => {
    const h = retryHarness('live')

    const result = await h.service.retryExecution('axe_orig', 'admin1')

    expect(result).toMatchObject({ execution: { id: 'axe_new' } })
    expect(h.sql).toEqual(['liveness', 'first-retry-marker'])
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expect(h.executeRule.mock.calls[0][1]).toEqual(h.original.triggerEvent)
    expect(h.executeRule.mock.calls[0][2]).toEqual({ rerunOfExecutionId: 'axe_orig', initiatedBy: 'admin1', rootExecutionId: 'axe_orig' })
    expect(reasonWarns('sheet_deleted')).toHaveLength(0)
  })

  it('EGRESS-ONLY rule (`[send_webhook]` only) + deleted sheet → the same 409; nothing runs or is pushed, the marker is NOT spent (real executor)', async () => {
    const h = retryHarness('deleted', EGRESS_ONLY, { realExecutor: true })

    const result = await h.service.retryExecution('axe_orig', 'admin1')

    expect(result).toEqual({ status: 409, code: SHEET_DELETED_CODE, message: RETRY_SHEET_DELETED_MESSAGE })
    expect(h.executeRule, 'no write action is no exemption: the push still carries data out').not.toHaveBeenCalled()
    expect(h.outbound).toEqual([])
    expect(h.sql).toEqual(['liveness'])
    expect(h.record).not.toHaveBeenCalled()
  })

  it('EGRESS-ONLY rule + LIVE sheet (control) → the retry really pushes once, so the zero above is the refusal', async () => {
    const h = retryHarness('live', EGRESS_ONLY, { realExecutor: true })

    await expect(h.service.retryExecution('axe_orig', 'admin1')).resolves.toHaveProperty('execution')

    expect(h.sql.slice(0, 2)).toEqual(['liveness', 'first-retry-marker'])
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expect(h.outbound).toEqual([OUTBOUND_URL])
    expect(h.recordInserts).toEqual([])
  })

  it('absent sheet → passes', async () => {
    const h = retryHarness('absent')
    await expect(h.service.retryExecution('axe_orig', 'admin1')).resolves.toHaveProperty('execution')
    expect(h.executeRule).toHaveBeenCalledTimes(1)
  })

  it('lookup THROWS → FAIL-OPEN: the retry runs, and the keep is a values-free WARN naming the execution', async () => {
    const h = retryHarness('throws')
    await expect(h.service.retryExecution('axe_orig', 'admin1')).resolves.toHaveProperty('execution')
    expect(h.executeRule).toHaveBeenCalledTimes(1)
    expectFailOpenWarn('automation.retry', { executionId: 'axe_orig' })
  })

  it('earlier refusals still win and never reach the lookup (rule missing)', async () => {
    const h = retryHarness('deleted')
    vi.spyOn(h.service, 'getRule').mockResolvedValue(null)
    await expect(h.service.retryExecution('axe_orig', 'admin1')).resolves.toMatchObject({ status: 409, code: 'RULE_MISSING_OR_DISABLED' })
    expect(h.sql).toEqual([])
  })

  it('one definition: the lane asks `dropRulesOnDeletedSheets` about exactly its one rule', async () => {
    const h = retryHarness('live')
    await h.service.retryExecution('axe_orig', 'admin1')
    expect(h.dropSpy).toHaveBeenCalledTimes(1)
    const [rules, channel, ctx] = h.dropSpy.mock.calls[0] as [Array<{ id: string }>, string, unknown]
    expect(rules.map((r) => r.id)).toEqual(['atr_dx'])
    expect(channel).toBe('automation.retry')
    expect(ctx).toEqual({ executionId: 'axe_orig' })
  })
})

// ── ADMIN RESUME ─────────────────────────────────────────────────────────────────────────────────

describe('admin resume — sheet liveness (#5803)', () => {
  function resumeHarness(state: SheetState, cursorKind: 'top_level' | 'condition_branch' = 'top_level') {
    const h = makeHarness(state)
    const rule = cursorKind === 'condition_branch' ? branchResumeRuleRow() : resumeRuleRow()
    vi.spyOn(h.service, 'getRule').mockResolvedValue(rule as never)
    const resumeCursor = cursorKind === 'condition_branch' ? branchResumeCursor(rule) : { kind: 'top_level' as const }
    const suspension = {
      id: 'asp_1',
      executionId: 'axe_susp',
      rootExecutionId: 'axe_susp',
      ledgerKind: 'execution',
      ruleId: rule.id,
      sheetId: SHEET,
      recordId: 'rec_1',
      stepIndex: 0,
      resumeToken: RESUME_TOKEN,
      reason: 'wait_for_callback',
      actionFingerprint: computeActionFingerprint(toExecutorRule(rule as never).actions),
      triggerEvent: { recordId: 'rec_1', actorId: 'u_actor' },
      resumeCursor,
      status: 'pending',
    }
    const claim = vi.fn(async () => true)
    h.internals.suspensionService = { findByToken: vi.fn(async () => suspension), claim }
    const onSettled = vi.fn(async () => {})
    h.internals.jobService = {
      lifecycleFor: vi.fn(() => ({ onStart: vi.fn(async () => {}), onSettled, onSkipped: vi.fn(async () => {}) })),
    }
    const getById = vi.spyOn(h.service.logs, 'getById').mockResolvedValue(
      execution({ id: 'axe_susp', ruleId: rule.id, status: 'running', steps: [] }),
    )
    const update = vi.spyOn(h.service.logs, 'updateRecordedExecution').mockResolvedValue(undefined)
    const executor = h.internals.executor as {
      continueExecution: (...args: unknown[]) => Promise<unknown>
      continueBranchExecution: (...args: unknown[]) => Promise<unknown>
    }
    const cont = vi.spyOn(executor, 'continueExecution').mockImplementation(
      async (exec: unknown) => ({ ...(exec as object), status: 'success' }),
    )
    const contBranch = vi.spyOn(executor, 'continueBranchExecution').mockImplementation(
      async (exec: unknown) => ({ ...(exec as object), status: 'success' }),
    )
    return { ...h, resumeCursor, claim, getById, update, cont, contBranch, onSettled }
  }

  it('deleted sheet → 409 SHEET_DELETED; token NOT claimed, record NOT re-read, tail NOT run, nothing persisted', async () => {
    const h = resumeHarness('deleted')

    const result = await h.service.resumeExecution(RESUME_TOKEN, 'admin1')

    expect(result).toEqual({ status: 409, code: SHEET_DELETED_CODE, message: RESUME_SHEET_DELETED_MESSAGE })
    expect(h.claim, 'the single-use token must stay pending so the resume works after a restore').not.toHaveBeenCalled()
    expect(h.cont).not.toHaveBeenCalled()
    expect(h.contBranch).not.toHaveBeenCalled()
    expect(h.executeRule).not.toHaveBeenCalled()
    expect(h.sql, 'the record re-read (which a soft delete does not stop) must not be reached').toEqual(['liveness'])
    expect(h.getById).not.toHaveBeenCalled()
    expect(h.update).not.toHaveBeenCalled()
    expect(h.onSettled).not.toHaveBeenCalled()
    expect(reasonWarns('sheet_deleted')).toHaveLength(1)
    expect(reasonWarns('sheet_deleted')[0][1]).toEqual({
      executionId: 'axe_susp',
      channel: 'automation.resume',
      sheetId: SHEET,
      reason: 'sheet_deleted',
      ruleCount: 1,
      ruleIds: ['atr_rs'],
    })
    expect(loggedText(), 'the resume token is a capability and must never be logged').not.toContain(RESUME_TOKEN)
  })

  it('the admin reason is coded, actionable and values-free', () => {
    expect(RESUME_SHEET_DELETED_MESSAGE.startsWith(`${SHEET_DELETED_CODE}:`)).toBe(true)
    expect(RESUME_SHEET_DELETED_MESSAGE).toMatch(/not resumed/)
    expect(RESUME_SHEET_DELETED_MESSAGE).toMatch(/token was not consumed/)
    for (const v of ['axe_susp', 'atr_rs', SHEET, RESUME_TOKEN, 'admin1']) expect(RESUME_SHEET_DELETED_MESSAGE).not.toContain(v)
  })

  it('live sheet → unchanged: record re-read, token claimed, tail continued, execution persisted', async () => {
    const h = resumeHarness('live')

    const result = await h.service.resumeExecution(RESUME_TOKEN, 'admin1')

    expect(result).toMatchObject({ execution: { id: 'axe_susp', status: 'success' } })
    expect(h.sql).toEqual(['liveness', 'record-read'])
    expect(h.claim).toHaveBeenCalledWith(RESUME_TOKEN)
    expect(h.cont).toHaveBeenCalledTimes(1)
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(reasonWarns('sheet_deleted')).toHaveLength(0)
  })

  it('`condition_branch` cursor + deleted sheet → the same 409 before the claim; continueBranchExecution NOT run', async () => {
    const h = resumeHarness('deleted', 'condition_branch')

    const result = await h.service.resumeExecution(RESUME_TOKEN, 'admin1')

    expect(result).toEqual({ status: 409, code: SHEET_DELETED_CODE, message: RESUME_SHEET_DELETED_MESSAGE })
    expect(h.claim, 'a branch suspension keeps its token too').not.toHaveBeenCalled()
    expect(h.contBranch, 'the branch tail must not slip past the check').not.toHaveBeenCalled()
    expect(h.cont).not.toHaveBeenCalled()
    expect(h.sql).toEqual(['liveness'])
    expect(h.getById).not.toHaveBeenCalled()
    expect(h.update).not.toHaveBeenCalled()
    expect(reasonWarns('sheet_deleted')).toHaveLength(1)
    expect(reasonWarns('sheet_deleted')[0][1]).toMatchObject({ executionId: 'axe_susp', channel: 'automation.resume', ruleIds: ['atr_br'] })
  })

  it('`condition_branch` cursor + LIVE sheet (control) → passes every branch gate, claims the token and continues the BRANCH tail', async () => {
    const h = resumeHarness('live', 'condition_branch')

    const result = await h.service.resumeExecution(RESUME_TOKEN, 'admin1')

    expect(result).toMatchObject({ execution: { id: 'axe_susp', status: 'success' } })
    expect(h.sql).toEqual(['liveness', 'record-read'])
    expect(h.claim).toHaveBeenCalledWith(RESUME_TOKEN)
    expect(h.contBranch).toHaveBeenCalledTimes(1)
    expect(h.contBranch.mock.calls[0][3]).toEqual((h.resumeCursor as ReturnType<typeof branchResumeCursor>).cursor)
    expect(h.cont).not.toHaveBeenCalled()
  })

  it('absent sheet → passes', async () => {
    const h = resumeHarness('absent')
    await expect(h.service.resumeExecution(RESUME_TOKEN, 'admin1')).resolves.toHaveProperty('execution')
    expect(h.claim).toHaveBeenCalledTimes(1)
    expect(h.cont).toHaveBeenCalledTimes(1)
  })

  it('lookup THROWS → FAIL-OPEN: the resume proceeds, and the keep is a values-free WARN naming the execution (never the token)', async () => {
    const h = resumeHarness('throws')
    await expect(h.service.resumeExecution(RESUME_TOKEN, 'admin1')).resolves.toHaveProperty('execution')
    expect(h.claim).toHaveBeenCalledTimes(1)
    expect(h.cont).toHaveBeenCalledTimes(1)
    expectFailOpenWarn('automation.resume', { executionId: 'axe_susp' })
    expect(loggedText()).not.toContain(RESUME_TOKEN)
  })

  it('one definition: the lane asks `dropRulesOnDeletedSheets` about exactly its one rule', async () => {
    const h = resumeHarness('live')
    await h.service.resumeExecution(RESUME_TOKEN, 'admin1')
    expect(h.dropSpy).toHaveBeenCalledTimes(1)
    const [rules, channel, ctx] = h.dropSpy.mock.calls[0] as [Array<{ id: string }>, string, unknown]
    expect(rules.map((r) => r.id)).toEqual(['atr_rs'])
    expect(channel).toBe('automation.resume')
    expect(ctx).toEqual({ executionId: 'axe_susp' })
  })
})

// ── ADMIN ROUTES: the refusal reaches the admin (not a silent success) ───────────────────────────

describe('admin routes surface the SHEET_DELETED refusal verbatim (#5803)', () => {
  const pinned = usePinnedServer()

  function mount(service: AutomationService) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user: unknown }).user = { id: 'admin1' }
      next()
    })
    app.use('/api/multitable', createAutomationRoutes(service))
    pinned.setApp(app)
  }

  it('POST /automation-executions/:id/retry → 409 { ok:false, error: { code: SHEET_DELETED, message } }', async () => {
    const h = makeHarness('deleted')
    vi.spyOn(h.service.logs, 'getById').mockResolvedValue(execution())
    vi.spyOn(h.service, 'getRule').mockResolvedValue(ruleRow() as never)
    mount(h.service)

    const res = await request(pinned.url())
      .post('/api/multitable/automation-executions/axe_orig/retry')
      .send({ confirmSideEffects: true })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: RETRY_SHEET_DELETED_MESSAGE } })
    expect(h.executeRule).not.toHaveBeenCalled()
  })

  it('POST /automation/resume → 409 { ok:false, error: { code: SHEET_DELETED, message } }', async () => {
    const h = makeHarness('deleted')
    const rule = resumeRuleRow()
    vi.spyOn(h.service, 'getRule').mockResolvedValue(rule as never)
    const claim = vi.fn(async () => true)
    h.internals.suspensionService = {
      findByToken: vi.fn(async () => ({
        id: 'asp_1',
        executionId: 'axe_susp',
        rootExecutionId: 'axe_susp',
        ledgerKind: 'execution',
        ruleId: rule.id,
        sheetId: SHEET,
        recordId: 'rec_1',
        stepIndex: 0,
        resumeToken: RESUME_TOKEN,
        reason: 'wait_for_callback',
        actionFingerprint: computeActionFingerprint(toExecutorRule(rule as never).actions),
        triggerEvent: { recordId: 'rec_1' },
        resumeCursor: { kind: 'top_level' },
        status: 'pending',
      })),
      claim,
    }
    mount(h.service)

    const res = await request(pinned.url())
      .post('/api/multitable/automation/resume')
      .send({ resumeToken: RESUME_TOKEN, confirmSideEffects: true })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: RESUME_SHEET_DELETED_MESSAGE } })
    expect(claim).not.toHaveBeenCalled()
  })
})
