/**
 * #5842 — cancel then immediately commit: the SERVER is authoritative about who may still send.
 *
 * Before the fix the commit phase re-used the `running` status, which is also the status the
 * worker generates in. A commit issued right after a cancel therefore flipped the header
 * `rejected` → `running`, the worker's next-row check saw "still running", and rows the user had
 * cancelled kept going to the model provider and being billed (BJ-2 charge-on-generation is never
 * released). The worker's own wrap-up then flipped the commit's `running` → `suspended`, so a
 * SECOND commit could be claimed for the same job — breaking BJ-10's "a job is committed once".
 *
 * What this suite pins, driven through the REAL worker (`runJob`), the REAL provider choke
 * (`runShortcutCore`, an injected fetch spy — no HTTP) and the REAL state helpers:
 *  (a) cancel while row 1 is at the provider, then an immediate commit claim → NOTHING further is
 *      sent and NOTHING further is reserved/billed;
 *  (b) two concurrent commit claims → exactly one wins, and the worker's wrap-up cannot re-open
 *      the claim afterwards;
 *  (c) the claim never puts a job back into a GENERATING status, and `committing` / `resolved` /
 *      `queued` / `running` cannot be claimed at all;
 *  (d) a row that was at the provider when the cancel landed is NOT marked `generated` — it is
 *      `failure`/`cancelled_after_charge`: charged (the money is real and visible), not
 *      confirmable (the user cancelled it).
 *
 * The database is an in-memory model that applies each statement's OWN predicates (it reads the
 * `AND state = 'pending'` / `WHERE status IN (…)` clauses out of the SQL it is handed), so a
 * product change that dropped a guard would be executed unguarded here and these cases would go
 * red. Every handler yields once before applying its effect, so a select-then-update claim would
 * interleave and both claimants would win.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AI_BULK_JOB_ROWS_TABLE,
  AI_BULK_JOB_TABLE,
  BULK_JOB_COMMIT_CLAIM_STALE_MS,
  BULK_ROW_CANCELLED_AFTER_CHARGE,
  BULK_ROW_INTERRUPTED_AFTER_CHARGE,
  BulkFillJobService,
  cancelBulkJob,
  claimBulkJobCommit,
  finishBulkJobCommit,
  heartbeatBulkJobCommit,
  isCommittableBulkJobStatus,
  isGeneratingBulkJobStatus,
  readGeneratedRows,
  releaseBulkJobCommitClaim,
  type BulkJobGenerationPlan,
  type BulkJobStatus,
} from '../../src/services/ai-bulk-job-service'
import type { PoolLike } from '../../src/services/ai-bulk-shared'
import type { AiUsageQueryFn } from '../../src/services/ai-usage-ledger'
import { AI_ROUTING_FIXTURE_ENV_KEYS, armLocalAiRoutingPolicy } from '../utils/ai-routing-policy-fixture'

const JOB_ID = 'aibulkjob_cancel_commit_unit'
const SHEET_ID = 'sheet_bulk_cc'
const FIELD_ID = 'fld_bulk_cc_target'
const ACTOR = 'user_bulk_cc_actor'
const ROW_IDS = ['rec_1', 'rec_2', 'rec_3'] as const
const promptFor = (recordId: string) => `Summarize this record. Notes: confidential-content-of-${recordId}`

const ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
  ...AI_ROUTING_FIXTURE_ENV_KEYS,
]
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.MULTITABLE_AI_ENABLED = '1'
  process.env.MULTITABLE_AI_PROVIDER = 'openai'
  process.env.MULTITABLE_AI_API_KEY = 'sk-bulk-cancel-commit-test'
  process.env.MULTITABLE_AI_MODEL = 'gpt-4o-mini'
  process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'
  armLocalAiRoutingPolicy()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

interface RowModel {
  state: string
  reason: string | null
  usageTokens: number
  costUsd: number
  proposed: string | null
}

/**
 * In-memory model of the header + job-rows + ledger reservations the worker and the commit
 * helpers touch. Statuses are applied EXACTLY as each statement's WHERE says, so the guards under
 * test are the product's, not the fixture's.
 */
function makeWorld(seed: Partial<Record<(typeof ROW_IDS)[number], string>> = {}) {
  const world = {
    status: 'queued' as string,
    /** header.commit_claim_id — WHICH commit request holds the `committing` claim (#5842). */
    claimId: null as string | null,
    /**
     * Virtual clock for NOW() (ms) + the header's `updated_at`. The staleness disjuncts in the
     * claim / cancel SQL are evaluated against THESE, so a test can age a claim (advance `now`)
     * without sleeping, and a heartbeat genuinely moves the header out of the window.
     */
    now: 1_000_000,
    updatedAt: 1_000_000,
    /**
     * The job's own sheet (#5832 liveness). Live by default; a test flips it mid-run to reach
     * `errored` — the ONE committable status this suite can enter without a cancel.
     */
    sheetDeletedAt: null as string | null,
    progress: { generated: 0, settledCost: 0 },
    aggregate: null as unknown,
    rows: new Map<string, RowModel>(
      ROW_IDS.map((id) => [
        id as string,
        { state: seed[id] ?? 'pending', reason: null, usageTokens: 0, costUsd: 0, proposed: null },
      ]),
    ),
    reservations: 0,
    unexpected: [] as string[],
  }

  /** `updated_at = NOW()` — every header write the product makes carries it. */
  const touch = () => {
    world.updatedAt = world.now
  }
  /** `updated_at < NOW() - ($n::int * INTERVAL '1 second')`, read off the statement's own param. */
  const isStale = (secondsParam: unknown) => world.updatedAt < world.now - Number(secondsParam) * 1000

  const query = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    // Every statement yields before it applies: a select-then-update claim would interleave here.
    await Promise.resolve()

    if (sql === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') {
      return { rows: [{ deleted_at: world.sheetDeletedAt }], rowCount: 1 }
    }
    if (sql === `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'running', updated_at = NOW() WHERE job_id = $1 AND status = 'queued'`) {
      if (world.status !== 'queued') return { rows: [], rowCount: 0 }
      world.status = 'running'
      return { rows: [], rowCount: 1 }
    }
    if (sql === `SELECT status FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`) {
      return { rows: [{ status: world.status }], rowCount: 1 }
    }
    if (sql === `SELECT state FROM ${AI_BULK_JOB_ROWS_TABLE} WHERE job_id = $1 AND record_id = $2`) {
      const row = world.rows.get(String(params[1]))
      return { rows: row ? [{ state: row.state }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = 'generated'`)) {
      const row = world.rows.get(String(params[1]))!
      if (/AND state = 'pending'$/.test(sql) && row.state !== 'pending') return { rows: [], rowCount: 0 }
      row.state = 'generated'
      row.proposed = String(params[3])
      row.usageTokens = Number(params[5])
      row.costUsd = Number(params[6])
      return { rows: [], rowCount: 1 }
    }
    // Charged-but-not-offered: the reason is a PARAMETER ($5), because the worker picks
    // cancelled_ vs interrupted_after_charge from the header status — recorded here verbatim.
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = 'failure', reason = $5`)) {
      const row = world.rows.get(String(params[1]))!
      const allowed = /AND state IN \('pending', 'pending_not_generated'\)$/.test(sql)
        ? ['pending', 'pending_not_generated'].includes(row.state)
        : true
      if (!allowed) return { rows: [], rowCount: 0 }
      row.state = 'failure'
      row.reason = String(params[4])
      row.usageTokens = Number(params[2])
      row.costUsd = Number(params[3])
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = $3, reason = $4`)) {
      const row = world.rows.get(String(params[1]))!
      row.state = String(params[2])
      row.reason = params[3] == null ? null : String(params[3])
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = 'pending_not_generated'`)) {
      let n = 0
      for (const row of world.rows.values()) {
        if (row.state === 'pending') {
          row.state = 'pending_not_generated'
          n += 1
        }
      }
      return { rows: [], rowCount: n }
    }
    if (sql.startsWith(`SELECT record_id, ordinal, state, current_value, preview_version, proposed_value`)) {
      const rows = [...world.rows]
        .filter(([, r]) => r.state === 'generated')
        .map(([recordId, r], i) => ({
          record_id: recordId,
          ordinal: i,
          state: r.state,
          current_value: null,
          preview_version: 1,
          proposed_value: r.proposed,
          masked: false,
          reason: r.reason,
          usage_tokens: r.usageTokens,
          cost_usd: r.costUsd,
        }))
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET generated = $2, settled_cost = $3`)) {
      world.progress = { generated: Number(params[1]), settledCost: Number(params[2]) }
      touch()
      return { rows: [], rowCount: 1 }
    }
    const guardedFlip = /^UPDATE multitable_ai_bulk_job SET status = '(suspended|errored)'.* WHERE job_id = \$1 AND status = '(running|committing)'$/.exec(sql)
    if (guardedFlip) {
      if (world.status !== guardedFlip[2]) return { rows: [], rowCount: 0 }
      world.status = guardedFlip[1]!
      touch()
      return { rows: [], rowCount: 1 }
    }
    // CANCEL — active statuses, plus a `committing` claim that has stopped heartbeating (the
    // user's exit from a commit request that died mid-write).
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET status = 'rejected'`)) {
      const guard = /WHERE job_id = \$1 AND \(status IN \((.*?)\) OR \(status = 'committing' AND updated_at < NOW\(\) - \(\$2::int \* INTERVAL '1 second'\)\)\)$/.exec(sql)
      if (!guard) return unexpected(sql)
      const set = guard[1]!.split(',').map((s) => s.trim().replace(/'/g, ''))
      const allowed = set.includes(world.status) || (world.status === 'committing' && isStale(params[1]))
      if (!allowed) return { rows: [], rowCount: 0 }
      world.status = 'rejected'
      world.claimId = null
      touch()
      return { rows: [], rowCount: 1 }
    }
    // The commit CLAIM — ONE conditional UPDATE … RETURNING: the committable set, OR a
    // `committing` header whose claim went stale. Stamps the claimant's id.
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET status = 'committing', commit_claim_id = $2`)) {
      const guard = /WHERE job_id = \$1 AND \(status IN \((.*?)\) OR \(status = 'committing' AND updated_at < NOW\(\) - \(\$3::int \* INTERVAL '1 second'\)\)\) RETURNING job_id$/.exec(sql)
      if (!guard) return unexpected(sql)
      const set = guard[1]!.split(',').map((s) => s.trim().replace(/'/g, ''))
      const allowed = set.includes(world.status) || (world.status === 'committing' && isStale(params[2]))
      if (!allowed) return { rows: [], rowCount: 0 }
      world.status = 'committing'
      world.claimId = params[1] == null ? null : String(params[1])
      touch()
      return { rows: [{ job_id: String(params[0]) }], rowCount: 1 }
    }
    // HEARTBEAT — updated_at only, guarded on the caller's own claim.
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET updated_at = NOW()`)) {
      if (!/WHERE job_id = \$1 AND status = 'committing' AND commit_claim_id = \$2 RETURNING job_id$/.test(sql)) return unexpected(sql)
      if (world.status !== 'committing' || world.claimId !== String(params[1])) return { rows: [], rowCount: 0 }
      touch()
      return { rows: [{ job_id: String(params[0]) }], rowCount: 1 }
    }
    // The commit FINISH — guarded on `committing` AND our own claim id.
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET aggregate = $2::jsonb, status = 'resolved'`)) {
      if (!/WHERE job_id = \$1 AND status = 'committing' AND commit_claim_id = \$3 RETURNING job_id$/.test(sql)) return unexpected(sql)
      if (world.status !== 'committing' || world.claimId !== String(params[2])) return { rows: [], rowCount: 0 }
      world.status = 'resolved'
      world.claimId = null
      world.aggregate = JSON.parse(String(params[1]))
      touch()
      return { rows: [{ job_id: String(params[0]) }], rowCount: 1 }
    }
    // RELEASE a failed commit — `committing` → `errored`, guarded on our own claim id.
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET status = 'errored', suspend_reason = NULL, commit_claim_id = NULL`)) {
      if (!/WHERE job_id = \$1 AND status = 'committing' AND commit_claim_id = \$2 RETURNING job_id$/.test(sql)) return unexpected(sql)
      if (world.status !== 'committing' || world.claimId !== String(params[1])) return { rows: [], rowCount: 0 }
      world.status = 'errored'
      world.claimId = null
      touch()
      return { rows: [{ job_id: String(params[0]) }], rowCount: 1 }
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('multitable_ai_usage_ledger')) {
      if (sql.startsWith('INSERT') && params.includes('in_flight')) world.reservations += 1
      return { rows: [], rowCount: 1 }
    }
    return unexpected(sql)
  })

  /**
   * A statement this model does not recognise is a HARD failure, never a silent pass: the guards
   * under test live in the WHERE clauses, so a product statement whose shape drifted must not be
   * applied by a looser fallback handler.
   */
  function unexpected(sql: string): never {
    world.unexpected.push(sql)
    throw new Error(`unexpected SQL in the bulk-job cancel/commit test: ${sql.slice(0, 200)}`)
  }

  const pool = {
    query,
    transaction: async <T>(handler: (client: { query: typeof query }) => Promise<T>): Promise<T> => handler({ query }),
  }
  return { world, pool: pool as unknown as PoolLike, query: query as unknown as AiUsageQueryFn }
}

function openaiOk(text: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** The provider seam: counts calls and records WHICH record's content each call carried. */
function makeProvider(onCall?: (n: number) => void | Promise<void>) {
  const sent: string[] = []
  const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body ?? '')
    sent.push(ROW_IDS.find((id) => body.includes(promptFor(id))) ?? '<unknown body>')
    await onCall?.(sent.length)
    return openaiOk(`AI OUT ${sent.length}`)
  })
  return { fetchFn, sent }
}

function planFor(): BulkJobGenerationPlan {
  return {
    actorId: ACTOR,
    sheetId: SHEET_ID,
    fieldId: FIELD_ID,
    rows: ROW_IDS.map((recordId, i) => ({ recordId, prompt: promptFor(recordId), version: i + 1, masked: false })),
  }
}

async function run(env: ReturnType<typeof makeWorld>, provider: ReturnType<typeof makeProvider>) {
  const service = new BulkFillJobService({ pool: env.pool, fetchFn: provider.fetchFn as unknown as typeof fetch })
  service.registerPlan(JOB_ID, planFor())
  await service.runJob(JOB_ID)
}

const rowStates = (world: ReturnType<typeof makeWorld>['world']) =>
  Object.fromEntries([...world.rows].map(([id, r]) => [id, r.state]))

describe('AI bulk job — cancel vs commit: the commit phase has its own status (#5842)', () => {
  it('CANCEL then IMMEDIATE COMMIT: nothing further is sent or billed, and the commit is claimed exactly once', async () => {
    const env = makeWorld()
    let firstClaim: boolean | null = null
    const provider = makeProvider(async (n) => {
      if (n === 1) {
        // The user cancels while row 1 is at the provider, then immediately hits "commit" on the
        // review page — the exact sequence the issue reports.
        await cancelBulkJob(env.query, JOB_ID)
        firstClaim = await claimBulkJobCommit(env.query, JOB_ID, 'claim_first')
      }
    })
    await run(env, provider)

    // THE BILLING CLAIM: rows 2 and 3 — the ones the user cancelled — never reach the provider and
    // never reserve quota. Before the fix all three were sent and charged.
    expect(provider.sent).toEqual(['rec_1'])
    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(env.world.reservations).toBe(1)

    // The commit claim was taken, and the worker's wrap-up cannot hand it back: the header is
    // still `committing`, so a second commit is refused (BJ-10 "committed once").
    expect(firstClaim).toBe(true)
    expect(env.world.status).toBe('committing')
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_second')).toBe(false)

    // Row states: the cancelled remainder stays visibly un-generated and UNCHARGED; the row that
    // was mid-flight is charged and NOT confirmable (see the dedicated case below).
    expect(rowStates(env.world)).toEqual({ rec_1: 'failure', rec_2: 'pending_not_generated', rec_3: 'pending_not_generated' })
    expect(await readGeneratedRows(env.query, JOB_ID)).toEqual([])
    expect(env.world.progress.generated).toBe(0)
    expect(env.world.unexpected).toEqual([])
  })

  it('a row cancelled WHILE AT THE PROVIDER is never marked generated: it is charged-but-not-confirmable, and the rest stay un-generated', async () => {
    const env = makeWorld()
    const provider = makeProvider(async (n) => {
      // The cancel lands during row 2 — row 1 is already recorded, row 2 is in flight.
      if (n === 2) await cancelBulkJob(env.query, JOB_ID)
    })
    await run(env, provider)

    expect(provider.sent).toEqual(['rec_1', 'rec_2'])
    expect(env.world.reservations).toBe(2)
    expect(env.world.status).toBe('rejected')

    // Row 1 finished before the cancel → generated (charged, committable).
    expect(env.world.rows.get('rec_1')).toMatchObject({ state: 'generated', usageTokens: 7, proposed: 'AI OUT 1' })
    // Row 2 was at the provider when the cancel landed → NOT resurrected as generated. The charge
    // is real, so it is recorded on the row (never shown as an uncharged row), but no proposed
    // value is offered and it is not in the committable set.
    expect(env.world.rows.get('rec_2')).toMatchObject({
      state: 'failure',
      reason: BULK_ROW_CANCELLED_AFTER_CHARGE,
      usageTokens: 7,
      proposed: null,
    })
    // Row 3 was never sent.
    expect(env.world.rows.get('rec_3')).toMatchObject({ state: 'pending_not_generated', usageTokens: 0 })
    const committable = await readGeneratedRows(env.query, JOB_ID)
    expect(committable.map((r) => r.recordId)).toEqual(['rec_1'])
    // Truthful money: every charged row is visible as charged; no charged row is shown as
    // `pending_not_generated` (the keystone invariant), and the header carries both charges.
    for (const [, r] of env.world.rows) {
      expect(r.state === 'pending_not_generated' ? r.usageTokens : 0).toBe(0)
    }
    expect(env.world.progress.settledCost).toBeGreaterThan(0)
  })

  it('a row charged while at the provider that NOBODY cancelled reads `interrupted_after_charge`, not `cancelled_after_charge`', async () => {
    // Same money shape as the case above, DIFFERENT provenance: here an orphan reconcile (or any
    // other path that flips still-pending rows) took the row out of `pending` while it was at the
    // provider — the header is NOT `rejected`, nobody cancelled anything. The reason is
    // user-visible provenance for a real charge, so it must not tell the user they cancelled a
    // row they did not.
    const env = makeWorld()
    const provider = makeProvider(async (n) => {
      // The row leaves `pending` under the worker WITHOUT a cancel (the header stays `running`).
      if (n === 1) env.world.rows.get('rec_1')!.state = 'pending_not_generated'
    })
    await run(env, provider)

    expect(env.world.status).toBe('suspended') // no cancel happened
    expect(env.world.rows.get('rec_1')).toMatchObject({
      state: 'failure',
      reason: BULK_ROW_INTERRUPTED_AFTER_CHARGE,
      usageTokens: 7,
      proposed: null,
    })
    expect(env.world.rows.get('rec_1')!.reason).not.toBe(BULK_ROW_CANCELLED_AFTER_CHARGE)
    // The rest of the run is unaffected — only the interrupted row is not offered.
    const committable = await readGeneratedRows(env.query, JOB_ID)
    expect(committable.map((r) => r.recordId)).toEqual(['rec_2', 'rec_3'])
    expect(env.world.progress.generated).toBe(2)
    expect(env.world.unexpected).toEqual([])
  })

  it('TWO CONCURRENT COMMIT CLAIMS on the same job: exactly one wins, the loser sees the job already committing', async () => {
    const env = makeWorld()
    await run(env, makeProvider())
    expect(env.world.status).toBe('suspended')

    // Both claims are in flight before either resolves: a select-then-update claim would let both
    // through (the fixture yields inside every statement).
    const [a, b] = await Promise.all([
      claimBulkJobCommit(env.query, JOB_ID, 'claim_a'),
      claimBulkJobCommit(env.query, JOB_ID, 'claim_b'),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(env.world.status).toBe('committing')

    // A third, later claim is refused too, and ONLY THE HOLDER can finish the job: the loser's
    // claim id is stamped on nothing, so its finish is a no-op even though the job IS committing.
    const winner = a ? 'claim_a' : 'claim_b'
    const loser = a ? 'claim_b' : 'claim_a'
    expect(env.world.claimId).toBe(winner)
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_c')).toBe(false)
    expect(await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 3, attempted: 3, counts: {} }, loser)).toBe(false)
    expect(env.world.status).toBe('committing')
    expect(await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 3, attempted: 3, counts: {} }, winner)).toBe(true)
    expect(env.world.status).toBe('resolved')
    expect(env.world.claimId).toBeNull()
    // Terminal: a commit after the job resolved is refused (no double-commit), and a second
    // finish cannot re-write the aggregate.
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_d')).toBe(false)
    expect(await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 1, attempted: 1, counts: {} }, winner)).toBe(false)
  })

  it('the commit claim never returns a job to a GENERATING status, and queued/running/committing/resolved cannot be claimed', async () => {
    // The committable set is unchanged (BJ-4/BJ-5: a cancelled or errored job's generated rows
    // stay committable) — what changed is WHERE the claim puts them.
    for (const status of ['suspended', 'errored', 'rejected'] as const) {
      const env = makeWorld()
      env.world.status = status
      expect(isCommittableBulkJobStatus(status)).toBe(true)
      expect(await claimBulkJobCommit(env.query, JOB_ID, `claim_${status}`)).toBe(true)
      expect(env.world.status).toBe('committing')
      expect(env.world.claimId).toBe(`claim_${status}`)
      // THE #5842 POINT: the claimed status is not one the worker may generate in.
      expect(isGeneratingBulkJobStatus(env.world.status as BulkJobStatus)).toBe(false)
      expect(env.world.status).not.toBe('running')
    }
    for (const status of ['queued', 'running', 'committing', 'resolved'] as const) {
      const env = makeWorld()
      env.world.status = status
      expect(isCommittableBulkJobStatus(status)).toBe(false)
      expect(await claimBulkJobCommit(env.query, JOB_ID, `claim_no_${status}`)).toBe(false)
      expect(env.world.status).toBe(status) // unchanged
    }
    // `running` is the ONLY status the worker generates in.
    for (const status of ['queued', 'suspended', 'rejected', 'errored', 'committing', 'resolved'] as const) {
      expect(isGeneratingBulkJobStatus(status as BulkJobStatus)).toBe(false)
    }
    expect(isGeneratingBulkJobStatus('running')).toBe(true)
  })

  it('the ERRORED entry into the commit phase: a sheet-liveness stop mid-run leaves the job committable, and the claim moves it to `committing` without re-arming the worker', async () => {
    // The cancel-free path into the committable set, which the cases above cannot reach: the
    // job's own sheet is deleted while row 1 is at the provider, so the worker stops at the next
    // row with the header `errored` (BJ-5: the persisted partial stays committable, #5832). The
    // claim must accept THAT status too — and must not hand the job back to the worker.
    const env = makeWorld()
    const provider = makeProvider(async (n) => {
      if (n === 1) env.world.sheetDeletedAt = '2026-09-19T00:00:00.000Z'
    })
    await run(env, provider)

    // The worker stopped on its own, at the liveness gate, before row 2's provider call.
    expect(provider.sent).toEqual(['rec_1'])
    expect(env.world.status).toBe('errored')
    expect(isCommittableBulkJobStatus(env.world.status as BulkJobStatus)).toBe(true)
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'pending_not_generated', rec_3: 'pending_not_generated' })

    // `errored` is claimable exactly once, and the claim lands on a NON-generating status.
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_after_error')).toBe(true)
    expect(env.world.status).toBe('committing')
    expect(env.world.claimId).toBe('claim_after_error')
    expect(isGeneratingBulkJobStatus(env.world.status as BulkJobStatus)).toBe(false)
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_second')).toBe(false)
    // Only the holder resolves it.
    expect(await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 1 }, 'claim_after_error')).toBe(true)
    expect(env.world.status).toBe('resolved')
    expect(env.world.unexpected).toEqual([])
  })

  it('a commit claimed MID-RUN (between rows) stops the worker at the next row instead of re-arming it', async () => {
    const env = makeWorld()
    let claimed: boolean | null = null
    const provider = makeProvider(async (n) => {
      if (n === 1) {
        // The cancel lands, then a commit claims the cancelled job — the exact #5842 sequence,
        // asserted here for the WORKER's side: the claim must not put it back to work.
        await cancelBulkJob(env.query, JOB_ID)
        claimed = await claimBulkJobCommit(env.query, JOB_ID, 'claim_midrun')
      }
    })
    await run(env, provider)
    expect(claimed).toBe(true)
    expect(provider.sent).toEqual(['rec_1'])
    expect(env.world.status).toBe('committing')
  })

  it('a row that already left `pending` is skipped WITHOUT a provider call (the per-row send check)', async () => {
    // rec_2 is already generated (a re-driven plan / reconciled row): sending it again would
    // re-charge a row that already has a proposal.
    const env = makeWorld({ rec_2: 'generated' })
    const provider = makeProvider()
    await run(env, provider)

    expect(provider.sent).toEqual(['rec_1', 'rec_3'])
    expect(env.world.reservations).toBe(2)
    expect(env.world.status).toBe('suspended')
    // The skip must not make the HEADER lie: rec_2 is still a generated, committable row, so the
    // header's counter is 3, not the 2 this run happened to send. (A skip that forgot to count it
    // would leave the header under-reporting rows the rows table really holds.)
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'generated', rec_3: 'generated' })
    expect(env.world.progress.generated).toBe(3)
  })

  it('a row skipped for a NON-offered state (cancelled mid-flight) is NOT counted as generated', async () => {
    // The twin of the case above: `pending_not_generated` is uncharged and not committable, so
    // counting it would over-report what the user can write. Only `generated` counts.
    const env = makeWorld({ rec_2: 'pending_not_generated' })
    const provider = makeProvider()
    await run(env, provider)

    expect(provider.sent).toEqual(['rec_1', 'rec_3'])
    expect(env.world.progress.generated).toBe(2)
    expect(env.world.rows.get('rec_2')!.state).toBe('pending_not_generated')
    expect(env.world.unexpected).toEqual([])
  })

  it('a released claim is committable again, and the release cannot touch a job it does not hold', async () => {
    const env = makeWorld()
    await run(env, makeProvider())
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_1')).toBe(true)
    // A request that does NOT hold the claim cannot release it: a status-only guard would let a
    // request whose claim was reclaimed flip the CURRENT holder's live claim to `errored`, and a
    // third commit could then start while the second is still writing.
    expect(await releaseBulkJobCommitClaim(env.query, JOB_ID, 'claim_other')).toBe(false)
    expect(env.world.status).toBe('committing')
    expect(env.world.claimId).toBe('claim_1')
    // The commit request threw: hand OUR claim back as `errored` so the generated rows are not
    // stranded until the next orphan sweep.
    expect(await releaseBulkJobCommitClaim(env.query, JOB_ID, 'claim_1')).toBe(true)
    expect(env.world.status).toBe('errored')
    expect(env.world.claimId).toBeNull()
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_2')).toBe(true)
    // Guarded: a release aimed at a job that is NOT committing leaves it alone.
    await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 0, attempted: 0, counts: {} }, 'claim_2')
    expect(env.world.status).toBe('resolved')
    expect(await releaseBulkJobCommitClaim(env.query, JOB_ID, 'claim_2')).toBe(false)
    expect(env.world.status).toBe('resolved')
  })

  // ── `committing` must never be a DEAD END (#5842 refuter, race lens) ──────────
  it('a commit request that DIES holding the claim is reclaimed by the next commit and by the user cancel — no restart, and the zombie cannot come back', async () => {
    const env = makeWorld()
    await run(env, makeProvider())
    expect(env.world.status).toBe('suspended')

    // The claim is taken and the request then dies (pod restart / OOM / SIGKILL): its catch never
    // runs, so neither finish nor release fires.
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_dead')).toBe(true)
    // While the claim is FRESH nothing may touch it — a commit really may be writing records.
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_heir')).toBe(false)
    expect(await cancelBulkJob(env.query, JOB_ID)).toBe(false)
    expect(env.world.status).toBe('committing')

    // It stops heartbeating. Past the window the NEXT COMMIT heals the job in place …
    env.world.now += BULK_JOB_COMMIT_CLAIM_STALE_MS + 1_000
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_heir')).toBe(true)
    expect(env.world.claimId).toBe('claim_heir')
    // … and the zombie waking up can neither resolve, release nor refresh the claim it lost.
    expect(await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 3, attempted: 3, counts: {} }, 'claim_dead')).toBe(false)
    expect(await releaseBulkJobCommitClaim(env.query, JOB_ID, 'claim_dead')).toBe(false)
    expect(await heartbeatBulkJobCommit(env.query, JOB_ID, 'claim_dead')).toBe(false)
    expect(env.world.status).toBe('committing')
    expect(env.world.claimId).toBe('claim_heir')

    // If the heir dies too, the USER still has an exit: a stale `committing` IS cancellable, so
    // the job never sits in a status that is neither cancellable nor claimable while holding the
    // BJ-7 active slot (before this it took a process restart + 10 minutes to escape).
    env.world.now += BULK_JOB_COMMIT_CLAIM_STALE_MS + 1_000
    expect(await cancelBulkJob(env.query, JOB_ID)).toBe(true)
    expect(env.world.status).toBe('rejected')
    expect(env.world.claimId).toBeNull()
  })

  it('a LIVE commit heartbeat keeps the claim out of every staleness window (the reclaim can only reach a dead request)', async () => {
    const env = makeWorld()
    await run(env, makeProvider())
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_beating')).toBe(true)

    // A long commit (BJ-10 chunks up to 5000 rows) beats once per chunk.
    env.world.now += BULK_JOB_COMMIT_CLAIM_STALE_MS + 1_000
    expect(await heartbeatBulkJobCommit(env.query, JOB_ID, 'claim_beating')).toBe(true)

    // So neither reclaim can reach it, and a request that does not hold the claim cannot keep it
    // alive on its behalf either.
    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_thief')).toBe(false)
    expect(await cancelBulkJob(env.query, JOB_ID)).toBe(false)
    expect(await heartbeatBulkJobCommit(env.query, JOB_ID, 'claim_thief')).toBe(false)
    expect(env.world.status).toBe('committing')
    expect(env.world.claimId).toBe('claim_beating')
  })

  it('UNCHANGED happy path: no cancel → every row is generated, the job suspends, the commit claims once and resolves', async () => {
    const env = makeWorld()
    const provider = makeProvider()
    await run(env, provider)

    expect(provider.sent).toEqual(['rec_1', 'rec_2', 'rec_3'])
    expect(env.world.status).toBe('suspended')
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'generated', rec_3: 'generated' })
    expect(env.world.progress.generated).toBe(3)
    expect(env.world.reservations).toBe(3)

    expect(await claimBulkJobCommit(env.query, JOB_ID, 'claim_happy')).toBe(true)
    expect(env.world.status).toBe('committing')
    expect(await finishBulkJobCommit(env.query, JOB_ID, { confirmed: 3, attempted: 3, counts: { committed: 3 } }, 'claim_happy')).toBe(true)
    expect(env.world.status).toBe('resolved')
    expect(env.world.aggregate).toEqual({ confirmed: 3, attempted: 3, counts: { committed: 3 } })
    expect(env.world.unexpected).toEqual([])
  })
})
