/**
 * #5832 — the AI bulk-fill job worker stops sending once its sheet is no longer live.
 *
 * The job's plan holds prompts assembled from the sheet's record content when the job started, and
 * nothing downstream of the generate loop reads the sheet again. Before the fix, deleting the sheet
 * did not stop an in-flight job: it kept sending that sheet's rows to the model, row by row, and only
 * a cancel could stop it. The worker now asks the shared liveness helper
 * (multitable/sheet-liveness.ts) about the JOB'S OWN sheet before every provider call.
 *
 * Driven through the real worker (`runJob`) and the real provider choke (`runShortcutCore`); the
 * provider is an injected fetch spy (no real HTTP), and the database is an in-memory model of the
 * rows the worker touches — so "provider called N times" is counted at the outbound seam itself.
 *
 * Decisions pinned here:
 *  · `deleted` AND `absent` both stop (the in-memory prompts would otherwise still go out);
 *  · a failed lookup stops too (fail-closed on an egress path), logged values-free;
 *  · the stop leaves the job `errored` — a terminal state the UI already renders and the commit route
 *    already accepts — with generated rows kept (charged, committable) and the remainder
 *    `pending_not_generated` (uncharged, never sent);
 *  · a cancel is still checked first and still wins (`rejected` is never overwritten).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AI_BULK_JOB_ROWS_TABLE,
  AI_BULK_JOB_TABLE,
  BulkFillJobService,
  cancelBulkJob,
  type BulkJobGenerationPlan,
} from '../../src/services/ai-bulk-job-service'
import type { PoolLike } from '../../src/services/ai-bulk-shared'
import type { AiUsageQueryFn } from '../../src/services/ai-usage-ledger'
import { AI_ROUTING_FIXTURE_ENV_KEYS, armLocalAiRoutingPolicy } from '../utils/ai-routing-policy-fixture'

const JOB_ID = 'aibulkjob_liveness_unit'
const SHEET_ID = 'sheet_bulk_own'
const OTHER_SHEET_ID = 'sheet_bulk_other'
const FIELD_ID = 'fld_bulk_target'
const ACTOR = 'user_bulk_actor'
const ROW_IDS = ['rec_1', 'rec_2', 'rec_3'] as const
const promptFor = (recordId: string) => `Summarize this record. Notes: confidential-content-of-${recordId}`
const LOOKUP_ERROR_TEXT = 'connection to db-internal.example:5432 lost while reading sheet_bulk_own'

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
  process.env.MULTITABLE_AI_API_KEY = 'sk-bulk-liveness-test'
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

class LookupFailure extends Error {
  code = '57P01'
}

type SheetState = { deleted_at: Date | null }

/** In-memory model of the rows the worker reads and writes. */
function makeWorld() {
  const world = {
    status: 'queued',
    progress: { generated: 0, settledCost: 0 },
    rows: new Map(ROW_IDS.map((id) => [id as string, { state: 'pending', usageTokens: 0, proposed: null as string | null }])),
    sheets: new Map<string, SheetState>([
      [SHEET_ID, { deleted_at: null }],
      // A DELETED neighbour: a check that asked about the wrong sheet would stop a live job.
      [OTHER_SHEET_ID, { deleted_at: new Date('2026-09-01T00:00:00Z') }],
    ]),
    livenessAsked: [] as unknown[][],
    failLivenessOnCall: 0,
    reservations: 0,
    unexpected: [] as string[],
  }

  const query = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    if (sql === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') {
      world.livenessAsked.push(params)
      if (world.livenessAsked.length === world.failLivenessOnCall) throw new LookupFailure(LOOKUP_ERROR_TEXT)
      const sheet = world.sheets.get(String(params[0]))
      return { rows: sheet ? [sheet] : [], rowCount: sheet ? 1 : 0 }
    }
    if (sql === `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'running', updated_at = NOW() WHERE job_id = $1 AND status = 'queued'`) {
      if (world.status !== 'queued') return { rows: [], rowCount: 0 }
      world.status = 'running'
      return { rows: [], rowCount: 1 }
    }
    if (sql === `SELECT status FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`) {
      return { rows: [{ status: world.status }], rowCount: 1 }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = 'generated'`)) {
      const row = world.rows.get(String(params[1]))!
      row.state = 'generated'
      row.proposed = String(params[3])
      row.usageTokens = Number(params[5])
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = 'pending_not_generated'`)) {
      let n = 0
      for (const row of world.rows.values()) {
        if (row.state === 'pending') { row.state = 'pending_not_generated'; n += 1 }
      }
      return { rows: [], rowCount: n }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET generated = $2, settled_cost = $3`)) {
      world.progress = { generated: Number(params[1]), settledCost: Number(params[2]) }
      return { rows: [], rowCount: 1 }
    }
    const guardedFlip = /^UPDATE multitable_ai_bulk_job SET status = '(suspended|errored)'.* WHERE job_id = \$1 AND status = 'running'$/.exec(sql)
    if (guardedFlip) {
      if (world.status !== 'running') return { rows: [], rowCount: 0 }
      world.status = guardedFlip[1]!
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith(`UPDATE ${AI_BULK_JOB_TABLE} SET status = 'rejected'`)) {
      if (!['queued', 'running', 'suspended'].includes(world.status)) return { rows: [], rowCount: 0 }
      world.status = 'rejected'
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('multitable_ai_usage_ledger')) {
      if (sql.startsWith('INSERT') && params.includes('in_flight')) world.reservations += 1
      return { rows: [], rowCount: 1 }
    }
    world.unexpected.push(sql)
    throw new Error(`unexpected SQL in the bulk-job liveness test: ${sql.slice(0, 120)}`)
  })

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

/** The provider: counts calls and records which record's content each call carried. */
function makeProvider(onCall?: (n: number) => void | Promise<void>) {
  const sent: string[] = []
  const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body ?? '')
    sent.push(ROW_IDS.find((id) => body.includes(promptFor(id))) ?? `<unknown body>`)
    await onCall?.(sent.length)
    return openaiOk(`AI OUT ${sent.length}`)
  })
  return { fetchFn, sent }
}

function planFor(sheetId = SHEET_ID): BulkJobGenerationPlan {
  return {
    actorId: ACTOR,
    sheetId,
    fieldId: FIELD_ID,
    rows: ROW_IDS.map((recordId, i) => ({ recordId, prompt: promptFor(recordId), version: i + 1, masked: false })),
  }
}

async function run(world: ReturnType<typeof makeWorld>, provider: ReturnType<typeof makeProvider>) {
  const service = new BulkFillJobService({ pool: world.pool, fetchFn: provider.fetchFn as unknown as typeof fetch })
  service.registerPlan(JOB_ID, planFor())
  await service.runJob(JOB_ID)
}

const rowStates = (world: ReturnType<typeof makeWorld>['world']) => Object.fromEntries([...world.rows].map(([id, r]) => [id, r.state]))
const logged = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls)

describe('AI bulk job worker — sheet liveness before every provider call (#5832)', () => {
  it('LIVE sheet: unchanged — every row is sent once, the job suspends for review, and each check asked about the job’s own sheet', async () => {
    const env = makeWorld()
    const provider = makeProvider()
    await run(env, provider)

    expect(provider.fetchFn).toHaveBeenCalledTimes(3)
    expect(provider.sent).toEqual(['rec_1', 'rec_2', 'rec_3'])
    expect(env.world.status).toBe('suspended')
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'generated', rec_3: 'generated' })
    expect(env.world.progress.generated).toBe(3)
    expect(env.world.reservations).toBe(3)
    // One check per provider call, each about THIS job's sheet — never another id.
    expect(env.world.livenessAsked).toEqual([[SHEET_ID], [SHEET_ID], [SHEET_ID]])
    expect(env.world.unexpected).toEqual([])
  })

  it('sheet DELETED while row 1 is generating: the provider is called exactly once; row 1 stays generated (charged), rows 2–3 are never sent, the job ends errored', async () => {
    const env = makeWorld()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = makeProvider((n) => {
      if (n === 1) env.world.sheets.set(SHEET_ID, { deleted_at: new Date() })
    })
    await run(env, provider)

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(provider.sent).toEqual(['rec_1'])
    expect(env.world.status).toBe('errored')
    // BJ-5 semantics for what was already generated: kept, charged, committable.
    expect(env.world.rows.get('rec_1')).toEqual({ state: 'generated', usageTokens: 7, proposed: 'AI OUT 1' })
    // The rest: visibly not generated, uncharged, no proposal (the state the review UI renders).
    expect(env.world.rows.get('rec_2')).toEqual({ state: 'pending_not_generated', usageTokens: 0, proposed: null })
    expect(env.world.rows.get('rec_3')).toEqual({ state: 'pending_not_generated', usageTokens: 0, proposed: null })
    expect(env.world.progress.generated).toBe(1)
    expect(env.world.reservations).toBe(1)
    expect(env.world.livenessAsked).toEqual([[SHEET_ID], [SHEET_ID]])
    // Logged values-free: the reason, never record content.
    expect(logged(warn)).toContain('sheet_deleted')
    expect(logged(warn)).not.toContain('confidential-content-of')
    expect(env.world.unexpected).toEqual([])
  })

  it('sheet deleted BEFORE the worker starts: nothing is sent, no quota is reserved, the job ends errored with every row not generated', async () => {
    const env = makeWorld()
    env.world.sheets.set(SHEET_ID, { deleted_at: new Date() })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = makeProvider()
    await run(env, provider)

    expect(provider.fetchFn).not.toHaveBeenCalled()
    expect(env.world.reservations).toBe(0)
    expect(env.world.status).toBe('errored')
    expect(rowStates(env.world)).toEqual({ rec_1: 'pending_not_generated', rec_2: 'pending_not_generated', rec_3: 'pending_not_generated' })
    expect(env.world.livenessAsked).toEqual([[SHEET_ID]])
  })

  it('sheet row GONE (absent) mid-run: treated like deleted — the in-memory prompts are not sent', async () => {
    const env = makeWorld()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = makeProvider((n) => {
      if (n === 1) env.world.sheets.delete(SHEET_ID)
    })
    await run(env, provider)

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(env.world.status).toBe('errored')
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'pending_not_generated', rec_3: 'pending_not_generated' })
    expect(logged(warn)).toContain('sheet_absent')
  })

  it('liveness LOOKUP FAILS before row 2: fail-closed — nothing more is sent, the job ends errored, and the log carries no error text or record content', async () => {
    const env = makeWorld()
    env.world.failLivenessOnCall = 2
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider = makeProvider()
    await run(env, provider)

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(env.world.status).toBe('errored')
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'pending_not_generated', rec_3: 'pending_not_generated' })
    expect(env.world.reservations).toBe(1)
    // Values-free: error class + driver code only.
    const lines = error.mock.calls.filter((c) => String(c[0]).includes('sheet liveness lookup failed'))
    expect(lines).toHaveLength(1)
    expect(lines[0]![1]).toEqual({ reason: 'liveness_lookup_failed', errorClass: 'LookupFailure', errorCode: '57P01' })
    expect(logged(error)).not.toContain('db-internal.example')
    expect(logged(error)).not.toContain(SHEET_ID)
    expect(logged(error)).not.toContain('confidential-content-of')
  })

  it('CANCEL still wins: a cancel during row 1 (on a sheet deleted at the same time) leaves the job rejected, and the worker stops on the status check without asking again', async () => {
    const env = makeWorld()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = makeProvider(async (n) => {
      if (n === 1) {
        env.world.sheets.set(SHEET_ID, { deleted_at: new Date() })
        await cancelBulkJob(env.query, JOB_ID)
      }
    })
    await run(env, provider)

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(env.world.status).toBe('rejected')
    expect(rowStates(env.world)).toEqual({ rec_1: 'generated', rec_2: 'pending_not_generated', rec_3: 'pending_not_generated' })
    // The status check comes first: a cancelled job is not even asked about its sheet again.
    expect(env.world.livenessAsked).toEqual([[SHEET_ID]])
  })
})
