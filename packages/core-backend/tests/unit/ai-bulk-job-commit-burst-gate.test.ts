/**
 * #5842 / PR #5915 — WHICH gate answers 429 on the bulk-job commit route, and why the real-DB
 * case `commit re-gate: a row that goes stale …` got 429 where it asserts 200.
 *
 * The refuter's reading was that the job must have been left in `committing` by an earlier commit
 * in the same case (a leaked claim), i.e. that 429 is how the route reports an in-progress commit.
 * It is not. The commit route answers, in this order (src/routes/multitable-ai.ts):
 *
 *   · :1413  E-10 burst cap exceeded ....... 429 `RATE_LIMITED` / status `rate_limited`
 *            (the limiter itself responds — BEFORE the job header is even read)
 *   · :1437  header status not committable .. 409 `BULK_JOB_NOT_COMMITTABLE`
 *            (a LIVE `committing` claim lands here — 409, never 429)
 *   · :1477  conditional claim lost the race  409 `BULK_JOB_COMMIT_IN_PROGRESS`
 *
 * So the only 429 a commit can produce is the burst cap, and the burst cap is per AUTHENTICATED
 * user id over a fixed 60s window (src/middleware/rate-limiter.ts `count > max`), resolved ONCE at
 * router construction from MULTITABLE_AI_TENANT_BURST_RPM (default 30). The real-DB suite spends
 * that budget on its own bulk-preview (:669) + commit (:1413) calls: request #31 in the window was
 * the stale-case commit, and it never reached the job at all.
 *
 * This suite pins all three facts without a database (mock pool, real router, pinned HTTP server):
 *  (a) with the budget spent, a PERFECTLY COMMITTABLE job is refused 429 `RATE_LIMITED` and the
 *      DB is never asked (zero queries for that request, header untouched, no claim) — the exact
 *      shape of the CI red, reproduced in-process;
 *  (b) a LIVE `committing` claim answers 409 `BULK_JOB_NOT_COMMITTABLE`, never 429;
 *  (c) BUDGET GUARD: the real-DB suite must pin its burst cap above its own request count, before
 *      it constructs the router — the regression that produced the red.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AI_BULK_JOB_TABLE, type BulkJobStatus } from '../../src/services/ai-bulk-job-service'
import { armLocalAiRoutingPolicy, AI_ROUTING_FIXTURE_ENV_KEYS } from '../utils/ai-routing-policy-fixture'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_burst_gate'
const JOB_ID = 'aibulkjob_burst_gate'
const FIELD_ID = 'fld_burst_gate_target'
const ACTOR = 'user_burst_gate_actor'
const COMMIT_URL = `/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${JOB_ID}/commit`

const ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  ...AI_ROUTING_FIXTURE_ENV_KEYS,
]
let savedEnv: Record<string, string | undefined> = {}

/**
 * In-memory stand-in for the ONE table the commit route reads before its gates: the job header.
 * Every statement is recorded, so "the DB was never asked" is an observation, not an assumption.
 * Anything past the gates would hit `unexpected` and fail the test loudly instead of silently
 * returning empty rows.
 */
function makeWorld(status: BulkJobStatus) {
  const world = {
    status: status as string,
    claimId: null as string | null,
    queries: [] as string[],
    unexpected: [] as string[],
  }
  const query = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    world.queries.push(sql)
    if (sql === `SELECT * FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`) {
      if (String(params[0]) !== JOB_ID) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            job_id: JOB_ID,
            actor_id: ACTOR,
            sheet_id: SHEET_ID,
            field_id: FIELD_ID,
            scope_fingerprint: 'sheet:all',
            status: world.status,
            total: 2,
            generated: 2,
            settled_cost: 0.01,
            quota_paused: false,
            aggregate: null,
            suspend_reason: world.status === 'suspended' ? 'manual_task' : null,
            commit_claim_id: world.claimId,
            created_at: new Date('2026-09-19T10:00:00Z'),
            updated_at: new Date('2026-09-19T10:01:00Z'),
            expires_at: null,
          },
        ],
        rowCount: 1,
      }
    }
    world.unexpected.push(sql)
    return { rows: [], rowCount: 0 }
  })
  const pool = { query, transaction: vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query })) }
  return { world, pool }
}

function buildApp(pool: unknown): Express {
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    next()
  })
  app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: (async () => new Response('{}')) as unknown as typeof fetch }))
  return app
}

describe('#5842 bulk-job commit: 429 is the burst cap, 409 is the claim', () => {
  const pinned = usePinnedServer()

  beforeEach(() => {
    savedEnv = {}
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'openai'
    process.env.MULTITABLE_AI_API_KEY = 'sk-burst-gate-test'
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

  it('the budget spent earlier in the window refuses a COMMITTABLE job 429 rate_limited BEFORE the header is read (the #5915 real-DB shape)', async () => {
    // A two-request budget, resolved at construction — the suite-scale version of the default 30.
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '2'
    // The job is NOT committable yet while the budget is being spent, so those two requests cost
    // one header read each and nothing else (no claim, no writes) — exactly like the real-DB
    // suite's earlier cases, which spend the budget on OTHER jobs.
    const { world, pool } = makeWorld('running')
    pinned.setApp(buildApp(pool))

    for (const _ of [1, 2]) {
      const spend = await request(pinned.url()).post(COMMIT_URL).send({ recordIds: ['rec_1'] })
      expect(spend.status).toBe(409)
      expect(spend.body.error.code).toBe('BULK_JOB_NOT_COMMITTABLE')
    }

    // Now the job reaches the state the stale case commits in: generated, awaiting review, NO
    // claim held by anyone. A commit here is legitimate and the case asserts 200.
    world.status = 'suspended'
    const queriesBefore = world.queries.length

    const commit = await request(pinned.url()).post(COMMIT_URL).send({ recordIds: ['rec_1'] })

    // …but the window's budget is gone, so the limiter answers first.
    expect(commit.status).toBe(429)
    expect(commit.body.status).toBe('rate_limited')
    expect(commit.body.error.code).toBe('RATE_LIMITED')
    expect(commit.headers['retry-after']).toBeTruthy()

    // The refusal is NOT the claim and NOT the status gate: the route never touched the database
    // for this request, and the job is still `suspended` with no claim on it.
    expect(world.queries.length).toBe(queriesBefore)
    expect(world.status).toBe('suspended')
    expect(world.claimId).toBeNull()
    expect(world.unexpected).toEqual([])
  })

  it('a LIVE `committing` claim answers 409 BULK_JOB_NOT_COMMITTABLE — a commit in progress is NEVER reported as 429', async () => {
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '1000' // budget out of the way
    const { world, pool } = makeWorld('committing')
    world.claimId = 'claim_of_another_request'
    pinned.setApp(buildApp(pool))

    const refused = await request(pinned.url()).post(COMMIT_URL).send({ recordIds: ['rec_1'] })

    expect(refused.status).toBe(409)
    expect(refused.status).not.toBe(429)
    expect(refused.body.error.code).toBe('BULK_JOB_NOT_COMMITTABLE')
    expect(refused.body.error.message).toContain('committing')
    // The other request's claim is untouched (no steal, no release).
    expect(world.claimId).toBe('claim_of_another_request')
    expect(world.status).toBe('committing')
    expect(world.unexpected).toEqual([])
  })

  // ── BUDGET GUARD (the regression itself) ──────────────────────────────────
  // The real-DB suite shares ONE per-user burst budget across every bulk-preview and commit it
  // makes. It grew past the default 30/min in this PR (three new ROUTE cases) and the 31st call —
  // a commit that asserts 200 — came back 429. A suite that drives that endpoint at scale must
  // pin the cap above its own request count, BEFORE it constructs the router (caps are read once,
  // at construction). Removing the pin from the real-DB file turns this red.
  it('the real-DB bulk-job suite pins its burst cap above its own request budget, before constructing the router', () => {
    const source = readFileSync(join(__dirname, '../integration/multitable-ai-bulk-job.test.ts'), 'utf8').replace(/\r\n/g, '\n')

    const pinMatch = /process\.env\.MULTITABLE_AI_TENANT_BURST_RPM\s*=\s*'(\d+)'/.exec(source)
    expect(pinMatch, 'the real-DB bulk-job suite must pin MULTITABLE_AI_TENANT_BURST_RPM').not.toBeNull()
    const pinnedCap = Number(pinMatch![1])

    // Every call site that SPENDS the burst budget: bulk-preview and bulk-job commit, through the
    // suite's helpers or raw. Over-counting only makes the guard stricter.
    const spendingCalls = (source.match(/bulkPreview\(|commitJob\(|shortcut\/bulk-preview|shortcut\/bulk-commit/g) ?? []).length
    expect(spendingCalls).toBeGreaterThan(30) // the suite really is past the default cap
    expect(pinnedCap).toBeGreaterThan(spendingCalls)
    expect(pinnedCap).toBeGreaterThanOrEqual(200) // headroom for the next cases, not a hair's breadth

    // Caps resolve at createMultitableAiRoutes construction, so a pin set afterwards is a no-op.
    expect(source.indexOf('MULTITABLE_AI_TENANT_BURST_RPM =')).toBeGreaterThan(-1)
    expect(source.indexOf('MULTITABLE_AI_TENANT_BURST_RPM =')).toBeLessThan(source.indexOf('createMultitableAiRoutes('))

    // …and it must be saved/restored like every other AI env the suite touches.
    expect(source).toContain("'MULTITABLE_AI_TENANT_BURST_RPM',")
  })
})
