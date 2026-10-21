/**
 * #5838 — the INLINE AI bulk-preview loop stops sending once its sheet is no longer live.
 *
 * `POST /sheets/:sheetId/ai/shortcut/bulk-preview` refuses a non-live sheet ONCE at entry, then (at or
 * below the inline cap, default 200 rows, operator-raisable) loops over the gated rows sending each
 * row's record content to the provider inside the SAME HTTP request — minutes of outbound traffic with
 * no further look at `meta_sheets`. Before the fix, soft-deleting the sheet mid-request did not stop a
 * single one of the remaining rows. Same class as #5832 (the async worker), other lane.
 *
 * Driven through the REAL router (`createMultitableAiRoutes`), the real permission service and the real
 * provider choke (`runShortcutCore`); the provider is an injected fetch spy (no real HTTP) and the
 * database is an in-memory model of the rows the route touches — so "provider called N times" is counted
 * at the outbound seam itself, and the sheet is deleted from INSIDE the first provider call.
 *
 * Decisions pinned here (the inline twin of the #5832 verdict):
 *  · `deleted` AND `absent` both stop, and so does a FAILED lookup (fail-closed on an egress path);
 *  · what was already generated is KEPT — charged, cached, returned, committable once the sheet is live
 *    again (bulk-commit refuses a non-live sheet on its own) — because an outright refusal would hide a
 *    real, already-settled spend from the caller;
 *  · the stopping row is reported `skipped: sheet_not_live` (UNCHARGED, never sent) and the response is
 *    `capped: true` — the partial-preview signal the UI already renders;
 *  · but when the stop came BEFORE the first provider call there is no spend to keep, so the partial
 *    justification is empty and the module rule stands: the request is refused 404 (SHEET_DELETED keeps
 *    its restore hint) instead of answering 200 with `rows: []`;
 *  · the stop is logged values-free: a reason, an error class + driver code, never record content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { usePinnedServer } from '../utils/pinned-server'
import { AI_ROUTING_FIXTURE_ENV_KEYS, armLocalAiRoutingPolicy } from '../utils/ai-routing-policy-fixture'

const SHEET_ID = 'sheet_inline_bulk'
const FLD_TARGET = 'fld_target'
const FLD_SRC = 'fld_src'
const ACTOR = { id: 'u_inline_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const ROW_IDS = ['rec_1', 'rec_2', 'rec_3'] as const
/** Distinctive per-row record content: what the provider must NOT receive after the delete. */
const contentOf = (recordId: string) => `confidential-content-of-${recordId}`
const LOOKUP_ERROR_TEXT = 'connection to db-internal.example:5432 lost while reading sheet_inline_bulk'

const AI_ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_BASE_URL',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP',
  'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP',
  'MULTITABLE_AI_BULK_MAX_ROWS',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
  ...AI_ROUTING_FIXTURE_ENV_KEYS,
] as const

class LookupFailure extends Error {
  code = '57P01'
}

type SheetState = { deleted_at: Date | null }

/** In-memory model of the rows the bulk-preview route reads and writes. */
function makeWorld() {
  const world = {
    sheets: new Map<string, SheetState>([[SHEET_ID, { deleted_at: null }]]),
    /** Every `SELECT deleted_at FROM meta_sheets` the request made, with its params. */
    livenessAsked: [] as unknown[][],
    /** Armed from inside a provider call: the NEXT liveness lookup throws, once. */
    failNextLiveness: false,
    /** Called with the 1-based number of the liveness lookup ABOUT TO be answered — the seam for a
     *  delete that commits before the loop's FIRST check, when no row has been generated or charged. */
    onLiveness: null as null | ((n: number) => void),
    /** in_flight ledger reservations = provider calls that were admitted by the quota. */
    reservations: 0,
    /** Cached outputs, the only thing bulk-commit can ever write. */
    cached: [] as string[],
    unexpected: [] as string[],
  }

  const query = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    if (sql === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') {
      world.livenessAsked.push(params)
      world.onLiveness?.(world.livenessAsked.length)
      if (world.failNextLiveness) {
        world.failNextLiveness = false
        throw new LookupFailure(LOOKUP_ERROR_TEXT)
      }
      const sheet = world.sheets.get(String(params[0]))
      return { rows: sheet ? [{ deleted_at: sheet.deleted_at }] : [], rowCount: sheet ? 1 : 0 }
    }
    if (/^SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = \$1/.test(sql)) {
      return {
        rows: [
          { id: FLD_SRC, name: 'Notes', type: 'string', property: {}, order: 1 },
          {
            id: FLD_TARGET,
            name: 'Summary',
            type: 'string',
            property: { aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } },
            order: 2,
          },
        ],
        rowCount: 2,
      }
    }
    if (sql === 'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC') {
      return {
        rows: ROW_IDS.map((id, i) => ({ id, version: i + 1, data: { [FLD_SRC]: contentOf(id) } })),
        rowCount: ROW_IDS.length,
      }
    }
    if (sql === 'SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2') {
      const id = String(params[0])
      const i = ROW_IDS.indexOf(id as (typeof ROW_IDS)[number])
      if (i < 0) return { rows: [], rowCount: 0 }
      return { rows: [{ id, version: i + 1, data: { [FLD_SRC]: contentOf(id) }, created_by: ACTOR.id }], rowCount: 1 }
    }
    // The per-row READ gate's existence check (requireRecordReadable, routes/univer-meta.ts).
    if (sql === 'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2') {
      const id = String(params[0])
      const known = (ROW_IDS as readonly string[]).includes(id) && String(params[1]) === SHEET_ID
      return { rows: known ? [{ id, sheet_id: SHEET_ID }] : [], rowCount: known ? 1 : 0 }
    }
    if (sql.startsWith('INSERT INTO multitable_ai_bulk_preview_cache')) {
      world.cached.push(String(params[1]))
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('multitable_ai_usage_ledger')) {
      if (sql.startsWith('INSERT') && params.includes('in_flight')) world.reservations += 1
      return { rows: [], rowCount: 1 }
    }
    // Permission / view / job-header lookups: no rows = no denial, no active job (the live baseline).
    if (/\b(meta_sheets|meta_views|sheet_permissions|field_permissions|multitable_ai_bulk_job|bases|users|user_roles|role_permissions|user_permissions|departments|user_departments|record_permissions|meta_record|approval)\b/i.test(sql)
      || /^SELECT/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    world.unexpected.push(sql.slice(0, 160))
    return { rows: [], rowCount: 0 }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { world, pool: { query, transaction } }
}

/** The provider: counts calls and records which record's content each outbound body carried. */
function makeProvider(onCall?: (n: number) => void | Promise<void>) {
  const sent: string[] = []
  const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body ?? '')
    sent.push(ROW_IDS.find((id) => body.includes(contentOf(id))) ?? '<unknown body>')
    await onCall?.(sent.length)
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: `AI OUT ${sent.length}` }], usage: { input_tokens: 5, output_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return { fetchFn, sent }
}

const pinned = usePinnedServer()
const savedEnv = new Map<string, string | undefined>()
let env: ReturnType<typeof makeWorld>
let provider: ReturnType<typeof makeProvider>

async function arm(onCall?: (n: number) => void | Promise<void>) {
  env = makeWorld()
  provider = makeProvider(onCall)
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  vi.spyOn(poolManager, 'get').mockReturnValue(env.pool as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { user: typeof ACTOR }).user = ACTOR
    next()
  })
  app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: provider.fetchFn as unknown as typeof fetch }))
  pinned.setApp(app)
}

const bulkPreview = () =>
  request(pinned.url())
    .post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`)
    .send({ fieldId: FLD_TARGET, scope: 'sheet' })

const logged = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls)

describe('AI inline bulk-preview — sheet liveness before every provider call (#5838)', () => {
  beforeEach(() => {
    for (const key of AI_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = `sk-${'inlinelive'.repeat(3)}`
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '1000'
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1000000'
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = '5000000'
    process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'
    armLocalAiRoutingPolicy()
  })

  afterEach(() => {
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
  })

  it('LIVE sheet: unchanged — every row is sent once, and each check asked about THIS sheet', async () => {
    await arm()
    const res = await bulkPreview()

    expect(res.status).toBe(200)
    expect(provider.fetchFn).toHaveBeenCalledTimes(3)
    expect(provider.sent).toEqual(['rec_1', 'rec_2', 'rec_3'])
    expect(res.body.rows.map((r: { recordId: string }) => r.recordId)).toEqual([...ROW_IDS])
    expect(res.body.skipped).toEqual([])
    expect(res.body.capped).toBe(false)
    expect(env.world.cached).toEqual([...ROW_IDS])
    expect(env.world.reservations).toBe(3)
    // One per-row check on top of the entry gate, each about THIS sheet — never another id.
    expect(env.world.livenessAsked).toEqual(Array(env.world.livenessAsked.length).fill([SHEET_ID]))
    // 1 entry gate + 1 per row-read gate (requireRecordReadable) + 1 per provider call.
    expect(env.world.livenessAsked).toHaveLength(1 + ROW_IDS.length + ROW_IDS.length)
    expect(env.world.unexpected).toEqual([])
  })

  it('sheet DELETED while row 1 is generating: the provider is called EXACTLY ONCE; rows 2–3 never leave the process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await arm((n) => {
      if (n === 1) env.world.sheets.set(SHEET_ID, { deleted_at: new Date('2026-09-19T00:00:00Z') })
    })
    const res = await bulkPreview()

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(provider.sent).toEqual(['rec_1'])
    // Nothing of rec_2 / rec_3 reached the outbound seam.
    expect(provider.fetchFn.mock.calls.map((c) => String((c[1] as { body?: unknown } | undefined)?.body ?? '')).join('\n'))
      .not.toContain(contentOf('rec_2'))

    expect(res.status).toBe(200)
    // The already-generated row is KEPT: charged, cached, committable once the sheet is live again.
    expect(res.body.rows).toEqual([
      { recordId: 'rec_1', version: 1, currentValue: null, proposed: 'AI OUT 1', masked: false, writable: true },
    ])
    expect(env.world.cached).toEqual(['rec_1'])
    expect(env.world.reservations).toBe(1)
    // The stopping row: UNCHARGED, never sent, truthfully named. The un-reached remainder is not listed.
    expect(res.body.skipped).toEqual([{ recordId: 'rec_2', reason: 'sheet_not_live' }])
    expect(res.body.failures).toEqual([])
    expect(res.body.capped).toBe(true)
    // Values-free log: the reason, never record content.
    expect(logged(warn)).toContain('sheet_deleted')
    expect(logged(warn)).not.toContain('confidential-content-of')
    expect(env.world.unexpected).toEqual([])
  })

  it('sheet row GONE (absent) mid-run: treated like deleted — the captured prompts are not sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await arm((n) => {
      if (n === 1) env.world.sheets.delete(SHEET_ID)
    })
    const res = await bulkPreview()

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.skipped).toEqual([{ recordId: 'rec_2', reason: 'sheet_not_live' }])
    expect(res.body.capped).toBe(true)
    expect(logged(warn)).toContain('sheet_absent')
  })

  it('liveness LOOKUP FAILS before row 2: fail-closed — nothing more is sent, and the log carries no error text, sheet id or record content', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Armed from inside row 1's provider call, so the lookup that throws is row 2's — whatever the
    // number of lookups the gates ahead of the loop made.
    await arm((n) => {
      if (n === 1) env.world.failNextLiveness = true
    })
    const res = await bulkPreview()

    expect(provider.fetchFn).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.skipped).toEqual([{ recordId: 'rec_2', reason: 'sheet_not_live' }])
    expect(res.body.capped).toBe(true)
    expect(env.world.reservations).toBe(1)
    const lines = error.mock.calls.filter((c) => String(c[0]).includes('sheet liveness lookup failed'))
    expect(lines).toHaveLength(1)
    expect(lines[0]![1]).toEqual({ reason: 'liveness_lookup_failed', errorClass: 'LookupFailure', errorCode: '57P01' })
    expect(logged(error)).not.toContain('db-internal.example')
    expect(logged(error)).not.toContain(SHEET_ID)
    expect(logged(error)).not.toContain('confidential-content-of')
  })

  it('sheet DELETED before the FIRST provider call: nothing was generated, so the request is REFUSED (404), not answered with an empty partial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await arm()
    // The generation loop's FIRST liveness check: after the entry gate and the per-row read gates
    // (same arithmetic the LIVE case pins). Deleting here means the loop breaks on row 1 — zero rows
    // generated, zero charged, nothing cached — so there is no settled spend a 404 could hide.
    env.world.onLiveness = (n) => {
      if (n === 1 + ROW_IDS.length + 1) env.world.sheets.set(SHEET_ID, { deleted_at: new Date('2026-09-19T00:00:00Z') })
    }
    const res = await bulkPreview()

    expect(provider.fetchFn).not.toHaveBeenCalled()
    expect(env.world.reservations).toBe(0)
    expect(env.world.cached).toEqual([])
    // The module rule, not a 200 with `rows: []`: `deleted` keeps its actionable restore hint.
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('SHEET_DELETED')
    expect(res.body.error.message).toContain('restored')
    // Values-free: the refusal never echoes the id back (no existence oracle).
    expect(JSON.stringify(res.body)).not.toContain(SHEET_ID)
    expect(logged(warn)).toContain('sheet_deleted')
    expect(env.world.unexpected).toEqual([])
  })

  it('sheet deleted BEFORE the request: the entry gate answers 404 SHEET_DELETED and nothing is sent', async () => {
    await arm()
    env.world.sheets.set(SHEET_ID, { deleted_at: new Date('2026-09-19T00:00:00Z') })
    const res = await bulkPreview()

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('SHEET_DELETED')
    expect(provider.fetchFn).not.toHaveBeenCalled()
    expect(env.world.reservations).toBe(0)
  })
})
