/**
 * AI routes × sheet liveness — the four handlers whose SHEET-LEVEL gate resolved capabilities and
 * ignored the liveness that came back:
 *
 *   POST /sheets/:sheetId/ai/shortcut/bulk-preview       (scope read over the sheet's records, the
 *   POST /sheets/:sheetId/ai/shortcut/bulk-commit         active-job lookup and the cap/quota decision
 *   POST /sheets/:sheetId/ai/shortcut/bulk-job/:id/commit all ran against a deleted sheet; only the
 *                                                         per-row read gate stopped the generation)
 *   POST /sheets/:sheetId/ai/suggest-formula             (a deleted sheet's schema went to the provider)
 *
 * Real router, real permission-service, mock pool (the multitable-ai-suggest-formula-routes.test.ts
 * harness). Each route: capability 403 first (identical for live and deleted), then 404 SHEET_DELETED /
 * NOT_FOUND, and nothing past the gate is touched — no field or record read, no ledger row, no job
 * state change, no provider call. A live sheet goes past the gate (positive control).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { sheetAddressedRouteKeys } from '../utils/sheet-liveness-route-scan'
import { AI_ROUTING_FIXTURE_ENV_KEYS, armLocalAiRoutingPolicy } from '../utils/ai-routing-policy-fixture'
import { SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from '../../src/multitable/sheet-liveness'

const SHEET_ID = 'sheet_ai_liveness'
const JOB_ID = 'aijob_liveness_1'
const WRITER = { id: 'u_ai_writer', roles: ['member'], perms: ['multitable:write', 'multitable:manage-schema'] }
const READER = { id: 'u_ai_writer', roles: ['member'], perms: ['multitable:read'] }

const AI_ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_BASE_URL',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
  ...AI_ROUTING_FIXTURE_ENV_KEYS,
] as const

let liveness: 'live' | 'deleted' | 'absent' = 'live'
let currentUser: typeof WRITER | undefined
let pastGate: string[]
let fetchSpy: ReturnType<typeof vi.fn>

function createMockPool() {
  const query = vi.fn(async (sql: string) => {
    if (/SELECT deleted_at FROM meta_sheets WHERE id = \$1/.test(sql)) {
      if (liveness === 'absent') return { rows: [] }
      return { rows: [{ deleted_at: liveness === 'deleted' ? new Date('2026-09-01T00:00:00Z') : null }] }
    }
    if (/SELECT \* FROM multitable_ai_bulk_job WHERE job_id = \$1/.test(sql)) {
      // The job header is read BEFORE the sheet gate (owner + cross-sheet check) — allowed.
      return {
        rows: [{
          job_id: JOB_ID, actor_id: WRITER.id, sheet_id: SHEET_ID, field_id: 'fld_target',
          scope_fingerprint: 'fp', status: 'suspended', total: 1, generated: 1, settled_cost: 0,
          quota_paused: false, aggregate: null, suspend_reason: null,
          created_at: new Date(), updated_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
        }],
      }
    }
    if (/\b(meta_fields|meta_records|meta_views|multitable_ai_usage_ledger|multitable_ai_bulk_preview)\b/.test(sql)
      || /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)) {
      pastGate.push(sql.replace(/\s+/g, ' ').trim().slice(0, 80))
    }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function buildApp() {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as any)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (currentUser) (req as any).user = currentUser
    next()
  })
  app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchSpy as unknown as typeof fetch }))
  return app
}

type Agent = ReturnType<typeof request>
const BASE = `/api/multitable/sheets/${SHEET_ID}/ai`
const ROUTES: Array<{ name: string; send: (a: Agent) => request.Test; forbidden: string }> = [
  {
    name: 'POST /sheets/:sheetId/ai/shortcut/bulk-preview',
    send: (a) => a.post(`${BASE}/shortcut/bulk-preview`).send({ fieldId: 'fld_target', scope: 'sheet' }),
    forbidden: 'Insufficient permissions',
  },
  {
    name: 'POST /sheets/:sheetId/ai/shortcut/bulk-commit',
    send: (a) => a.post(`${BASE}/shortcut/bulk-commit`).send({ runId: 'aibulk_run_1', recordIds: ['rec_1'] }),
    forbidden: 'Insufficient permissions',
  },
  {
    name: 'POST /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/commit',
    send: (a) => a.post(`${BASE}/shortcut/bulk-job/${JOB_ID}/commit`).send({ recordIds: ['rec_1'] }),
    forbidden: 'Insufficient permissions',
  },
  {
    name: 'POST /sheets/:sheetId/ai/suggest-formula',
    send: (a) => a.post(`${BASE}/suggest-formula`).send({ instruction: 'price times tax' }),
    forbidden: 'You cannot manage fields on this sheet',
  },
]

/**
 * The other sheet-addressed routes of routes/multitable-ai.ts, each with why it has no row above. The
 * table plus this list must equal the closed-world scan, so a new AI route reds here until it is placed.
 */
const COVERED_ELSEWHERE: Record<string, string> = {
  'POST /sheets/:sheetId/ai/shortcut/preview': 'per-record gate requireRecordReadable (routes/univer-meta.ts), vetted by the closed-world guard under the route order rule (403 before 404); behaviour in multitable-record-gate-capability-before-liveness.test.ts',
  'POST /sheets/:sheetId/ai/shortcut/run': 'per-record gate requireRecordReadable, as preview',
  'GET /sheets/:sheetId/ai/shortcut/bulk-job/:jobId': 'exempt by name in the closed-world guard: the caller-owned job, kept readable after a delete',
  'GET /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/rows': 'exempt by name in the closed-world guard: the caller-owned job rows',
  'POST /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/cancel': 'exempt by name in the closed-world guard: cancel must work on a deleted sheet',
}

const pinned = usePinnedServer()
const savedEnv = new Map<string, string | undefined>()

describe('AI sheet-level gates refuse a non-live sheet', () => {
  beforeEach(async () => {
    for (const key of AI_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = `sk-${'livenesstest'.repeat(3)}`
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '1000'
    process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'
    armLocalAiRoutingPolicy()
    liveness = 'live'
    currentUser = WRITER
    pastGate = []
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '=1' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    pinned.setApp(await buildApp())
  })

  afterEach(() => {
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
  })

  it('covers every sheet-addressed route the closed-world scan finds in routes/multitable-ai.ts (a row or a named reason)', () => {
    const placed = [...ROUTES.map((r) => r.name), ...Object.keys(COVERED_ELSEWHERE)]
    expect(new Set(placed).size).toBe(placed.length)
    expect(placed.sort()).toEqual(sheetAddressedRouteKeys('routes/multitable-ai.ts').sort())
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('soft-deleted sheet → 404 SHEET_DELETED; nothing past the gate runs', async () => {
        liveness = 'deleted'
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
        expect(pastGate).toEqual([])
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('absent sheet → 404 NOT_FOUND; nothing past the gate runs', async () => {
        liveness = 'absent'
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } })
        expect(pastGate).toEqual([])
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('capability first: an actor without the capability gets the same 403 for a live and a deleted sheet', async () => {
        currentUser = READER
        liveness = 'live'
        const live = await route.send(request(pinned.url()))
        liveness = 'deleted'
        const deleted = await route.send(request(pinned.url()))
        expect(live.status).toBe(403)
        expect(deleted.status).toBe(403)
        expect(deleted.body).toEqual(live.body)
        expect(live.body.error.message).toBe(route.forbidden)
        expect(pastGate).toEqual([])
      })

      it('live sheet → the request goes past the gate (positive control)', async () => {
        liveness = 'live'
        const res = await route.send(request(pinned.url()))
        expect(res.body?.error?.code).not.toBe(SHEET_DELETED_CODE)
        expect(pastGate.some((sql) => /meta_fields/.test(sql))).toBe(true)
      })
    })
  }
})
