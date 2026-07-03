import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalMetricsService } from '../../src/services/ApprovalMetricsService'
import {
  registerWorkdayCalendarProvider,
  unregisterWorkdayCalendarProvider,
  type WorkdayCalendarPort,
  type WorkdayCalendar,
} from '../../src/core/workday-calendar-port'

/**
 * T3-2 — business/work-day calendar wired to approval SLA (real DB, real approval-start + metrics SQL).
 *
 * The deadline is asserted THROUGH the real approval start + recordNodeActivation metrics path with a
 * registered FAKE WorkdayCalendarPort provider — never a hand-built deadline. Fail-first contrast:
 *   RED-before (no provider bound) → sla_due_at is the naive elapsed instant;
 *   GREEN (weekend-non-working provider) → sla_due_at is pushed strictly past the naive instant.
 * Plus fail-open (absent / throwing / null-org), snapshot (calendar edit after activation), the 366-day
 * cap, and the legacy sla_hours path staying byte-identical + index-served.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const AFTER_MINUTES = 6 * 1440 // 6 business days — a run of 6 working days always crosses ≥1 weekend.
const DAY_MS = 86_400_000

type MetricsRow = {
  started_at: string
  current_node_deadline_at: string | null
  sla_due_at: string | null
  sla_timezone: string | null
  sla_calendar_org_id: string | null
  sla_unit: string | null
  sla_hours: number | null
}

function weekendCalendar(tz = 'UTC'): WorkdayCalendar {
  return {
    timezone: tz,
    isWorkingDay: (dayIso: string) => ![0, 6].includes(new Date(`${dayIso}T00:00:00Z`).getUTCDay()),
    nonCountingWindows: [],
  }
}

function allNonWorkingCalendar(tz = 'UTC'): WorkdayCalendar {
  return { timezone: tz, isWorkingDay: () => false, nonCountingWindows: [] }
}

const weekendProvider: WorkdayCalendarPort = { resolve: async () => weekendCalendar() }
const throwingProvider: WorkdayCalendarPort = { resolve: async () => { throw new Error('provider boom') } }
const nullProvider: WorkdayCalendarPort = { resolve: async () => null }
const allNonWorkingProvider: WorkdayCalendarPort = { resolve: async () => allNonWorkingCalendar() }

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function buildFormSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] }
}

// Single business-unit approval node — the INITIAL node, activated through recordInstanceStart.
function buildBusinessSlaGraph(unit: 'business' | 'wall_clock') {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'node_a',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a'],
          approvalMode: 'single',
          timeout: { afterMinutes: AFTER_MINUTES, effect: 'remind', unit },
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-a', source: 'start', target: 'node_a' },
      { key: 'edge-a-end', source: 'node_a', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval T3-2 business-calendar SLA — real DB', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  function rawQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    return poolManager.get().query<T>(sql, params) as unknown as Promise<{ rows: T[]; rowCount?: number | null }>
  }

  async function fetchMetrics(instanceId: string): Promise<MetricsRow | null> {
    const result = await rawQuery<MetricsRow>(
      `SELECT started_at, current_node_deadline_at, sla_due_at, sla_timezone,
              sla_calendar_org_id, sla_unit, sla_hours
         FROM approval_metrics WHERE instance_id = $1`,
      [instanceId],
    )
    return result.rows[0] ?? null
  }

  // recordInstanceStart is a post-commit best-effort write — poll until the metrics row satisfies `ready`.
  async function waitForMetrics(instanceId: string, ready: (row: MetricsRow) => boolean): Promise<MetricsRow> {
    for (let attempt = 0; attempt < 80; attempt++) {
      const row = await fetchMetrics(instanceId)
      if (row && ready(row)) return row
      await new Promise((r) => setTimeout(r, 50))
    }
    const row = await fetchMetrics(instanceId)
    throw new Error(`metrics row not ready for ${instanceId}: ${JSON.stringify(row)}`)
  }

  async function createTemplate(adminToken: string, approvalGraph: object): Promise<Response> {
    const templateKey = `approval-t32-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    return jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'T3-2 Business Calendar SLA Template',
        description: 'T3-2 business-calendar SLA integration',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
  }

  async function publishGraphTemplate(adminToken: string, approvalGraph: object): Promise<string> {
    const templateResponse = await createTemplate(adminToken, approvalGraph)
    expect(templateResponse.status).toBe(201)
    const template = await templateResponse.json() as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status).toBe(200)
    return template.id
  }

  async function startApproval(requesterToken: string, templateId: string): Promise<string> {
    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'business calendar sla' } },
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as { id: string }
    createdApprovalIds.add(created.id)
    return created.id
  }

  async function seedInstance(id: string, currentNodeKey: string): Promise<void> {
    await rawQuery(
      `INSERT INTO approval_instances (id, status, current_node_key)
       VALUES ($1, 'pending', $2) ON CONFLICT (id) DO NOTHING`,
      [id, currentNodeKey],
    )
    createdApprovalIds.add(id)
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(() => {
    unregisterWorkdayCalendarProvider()
  })

  afterAll(async () => {
    unregisterWorkdayCalendarProvider()
    const pool = poolManager.get()
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
    } catch {
      // best-effort cleanup
    }
    if (server) await server.stop()
  })

  it('has DATABASE_URL configured (sentinel — never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('GREEN: a weekend-non-working provider pushes sla_due_at strictly past the naive elapsed instant', async () => {
    registerWorkdayCalendarProvider(weekendProvider)
    const admin = await authToken(baseUrl, 't32-admin')
    const templateId = await publishGraphTemplate(admin, buildBusinessSlaGraph('business'))
    const requester = await authToken(baseUrl, 't32-requester')
    const instanceId = await startApproval(requester, templateId)

    const row = await waitForMetrics(instanceId, (r) => r.sla_due_at !== null)
    expect(row.sla_unit).toBe('business')
    expect(row.sla_timezone).toBe('UTC')
    expect(row.sla_calendar_org_id).toBe('default')

    const startedMs = new Date(row.started_at).getTime()
    const naiveMs = startedMs + AFTER_MINUTES * 60_000
    const dueMs = new Date(row.sla_due_at as string).getTime()
    // Business time skips at least one weekend → strictly later than the naive elapsed instant.
    expect(dueMs).toBeGreaterThan(naiveMs)
    expect(dueMs - naiveMs).toBeGreaterThanOrEqual(DAY_MS) // ≥1 full skipped day
    // The node-timeout effect deadline tracks the business due instant (so `remind` fires at business time).
    expect(new Date(row.current_node_deadline_at as string).getTime()).toBe(dueMs)
  })

  it('RED / fail-open: with NO provider bound, sla_due_at is the naive elapsed instant (creation still succeeds)', async () => {
    // No provider registered (afterEach unbinds). This is the RED-before contrast to the GREEN case.
    const admin = await authToken(baseUrl, 't32-admin')
    const templateId = await publishGraphTemplate(admin, buildBusinessSlaGraph('business'))
    const requester = await authToken(baseUrl, 't32-requester')
    const instanceId = await startApproval(requester, templateId)

    const row = await waitForMetrics(instanceId, (r) => r.sla_due_at !== null)
    expect(row.sla_unit).toBe('business')
    expect(row.sla_timezone).toBe('UTC') // APP_TIMEZONE unset → UTC fallback
    expect(row.sla_calendar_org_id).toBe('default')

    const startedMs = new Date(row.started_at).getTime()
    const naiveMs = startedMs + AFTER_MINUTES * 60_000
    const dueMs = new Date(row.sla_due_at as string).getTime()
    // Fail-open = natural elapsed arithmetic (activatedAt + afterMinutes) — no weekend push.
    expect(Math.abs(dueMs - naiveMs)).toBeLessThan(2_000)
  })

  it('fail-open: a throwing provider falls back to elapsed arithmetic; approval creation is not blocked', async () => {
    registerWorkdayCalendarProvider(throwingProvider)
    const admin = await authToken(baseUrl, 't32-admin')
    const templateId = await publishGraphTemplate(admin, buildBusinessSlaGraph('business'))
    const requester = await authToken(baseUrl, 't32-requester')
    const instanceId = await startApproval(requester, templateId)

    const row = await waitForMetrics(instanceId, (r) => r.sla_due_at !== null)
    expect(row.sla_unit).toBe('business')
    const naiveMs = new Date(row.started_at).getTime() + AFTER_MINUTES * 60_000
    expect(Math.abs(new Date(row.sla_due_at as string).getTime() - naiveMs)).toBeLessThan(2_000)
  })

  it('fail-open: a provider that resolves null (unmapped / foreign org) falls back to elapsed arithmetic', async () => {
    registerWorkdayCalendarProvider(nullProvider)
    const admin = await authToken(baseUrl, 't32-admin')
    const templateId = await publishGraphTemplate(admin, buildBusinessSlaGraph('business'))
    const requester = await authToken(baseUrl, 't32-requester')
    const instanceId = await startApproval(requester, templateId)

    const row = await waitForMetrics(instanceId, (r) => r.sla_due_at !== null)
    const naiveMs = new Date(row.started_at).getTime() + AFTER_MINUTES * 60_000
    expect(Math.abs(new Date(row.sla_due_at as string).getTime() - naiveMs)).toBeLessThan(2_000)
  })

  it('366-day cap: an all-non-working calendar clamps sla_due_at to the horizon (creation succeeds)', async () => {
    registerWorkdayCalendarProvider(allNonWorkingProvider)
    const admin = await authToken(baseUrl, 't32-admin')
    const templateId = await publishGraphTemplate(admin, buildBusinessSlaGraph('business'))
    const requester = await authToken(baseUrl, 't32-requester')
    const instanceId = await startApproval(requester, templateId)

    const row = await waitForMetrics(instanceId, (r) => r.sla_due_at !== null)
    expect(row.sla_unit).toBe('business')
    const startedMs = new Date(row.started_at).getTime()
    const dueMs = new Date(row.sla_due_at as string).getTime()
    // Clamped to ~366 days out (no working time ever found).
    expect(dueMs - startedMs).toBeGreaterThan(365 * DAY_MS)
  })

  it('snapshot: a calendar edit AFTER activation does not move an already-armed sla_due_at', async () => {
    // A mutable provider — instance A arms under the weekend calendar; then we flip the provider to
    // all-non-working. Instance A's armed deadline must NOT move (resolved asOf activation), while a
    // NEW instance B armed after the edit reflects the change (proving the mutation actually took effect).
    let working = true
    const mutableProvider: WorkdayCalendarPort = {
      resolve: async () => (working ? weekendCalendar() : allNonWorkingCalendar()),
    }
    registerWorkdayCalendarProvider(mutableProvider)
    const admin = await authToken(baseUrl, 't32-admin')
    const templateId = await publishGraphTemplate(admin, buildBusinessSlaGraph('business'))
    const requester = await authToken(baseUrl, 't32-requester')

    const instanceA = await startApproval(requester, templateId)
    const armedA = await waitForMetrics(instanceA, (r) => r.sla_due_at !== null)
    const armedDueA = new Date(armedA.sla_due_at as string).getTime()

    // Edit the calendar after A is armed.
    working = false

    // Re-read A repeatedly — its armed deadline is a snapshot and must be stable.
    for (let i = 0; i < 5; i++) {
      const again = await fetchMetrics(instanceA)
      expect(new Date(again!.sla_due_at as string).getTime()).toBe(armedDueA)
      await new Promise((r) => setTimeout(r, 30))
    }

    // A fresh instance armed AFTER the edit sees the new (all-non-working → clamped) calendar.
    const instanceB = await startApproval(requester, templateId)
    const armedB = await waitForMetrics(instanceB, (r) => r.sla_due_at !== null)
    const startedB = new Date(armedB.started_at).getTime()
    expect(new Date(armedB.sla_due_at as string).getTime() - startedB).toBeGreaterThan(365 * DAY_MS)
  })

  it('recordNodeActivation SQL path: a business calendarSla arms sla_due_at past naive; foreign org fails open', async () => {
    registerWorkdayCalendarProvider(weekendProvider)
    const metrics = new ApprovalMetricsService(rawQuery)
    const instanceId = `t32-activation-${Date.now()}`
    await seedInstance(instanceId, 'approval_2')
    await metrics.recordInstanceStart({ instanceId, templateId: null, startedAt: new Date(), slaHours: null, initialNodeKey: null })

    const activatedAt = new Date()
    await metrics.recordNodeActivation({
      instanceId,
      nodeKey: 'approval_2',
      activatedAt,
      timeoutEffect: 'remind',
      calendarSla: { afterMinutes: AFTER_MINUTES, orgId: 'default' },
    })
    const row = await fetchMetrics(instanceId)
    expect(row?.sla_unit).toBe('business')
    expect(row?.sla_calendar_org_id).toBe('default')
    const naiveMs = activatedAt.getTime() + AFTER_MINUTES * 60_000
    expect(new Date(row!.sla_due_at as string).getTime()).toBeGreaterThan(naiveMs)
    // current_node_deadline_at tracks the business due (effect fires at business time).
    expect(new Date(row!.current_node_deadline_at as string).getTime())
      .toBe(new Date(row!.sla_due_at as string).getTime())

    // Foreign org: a provider that owns no calendar for that org → null → fail-open naive.
    registerWorkdayCalendarProvider({ resolve: async (orgId) => (orgId === 'home' ? weekendCalendar() : null) })
    const foreignId = `t32-foreign-${Date.now()}`
    await seedInstance(foreignId, 'approval_2')
    await metrics.recordInstanceStart({ instanceId: foreignId, templateId: null, startedAt: new Date(), slaHours: null, initialNodeKey: null })
    const foreignActivatedAt = new Date()
    await metrics.recordNodeActivation({
      instanceId: foreignId,
      nodeKey: 'approval_2',
      activatedAt: foreignActivatedAt,
      timeoutEffect: 'remind',
      calendarSla: { afterMinutes: AFTER_MINUTES, orgId: 'foreign' },
    })
    const foreignRow = await fetchMetrics(foreignId)
    const foreignNaive = foreignActivatedAt.getTime() + AFTER_MINUTES * 60_000
    expect(Math.abs(new Date(foreignRow!.sla_due_at as string).getTime() - foreignNaive)).toBeLessThan(2_000)
  })

  it('breach scan (§6): a past sla_due_at row is marked breached through the real checkSlaBreaches UPDATE', async () => {
    // Real-DB proof of the calendar branch (not just the mock unit test): a calendar row whose
    // business-time sla_due_at is in the past — and NO sla_hours (so the legacy branch cannot match it) —
    // must be flagged by the sla_due_at UPDATE.
    const metrics = new ApprovalMetricsService(rawQuery)
    const instanceId = `t32-breach-${Date.now()}`
    await seedInstance(instanceId, 'approval_1')
    await rawQuery(
      `INSERT INTO approval_metrics
         (instance_id, template_id, tenant_id, started_at, sla_hours, sla_due_at, sla_unit, node_breakdown)
       VALUES ($1, NULL, 'default', now() - INTERVAL '2 hours', NULL,
               now() - INTERVAL '1 minute', 'business', '[]'::jsonb)`,
      [instanceId],
    )
    const breached = await metrics.checkSlaBreaches(new Date())
    expect(breached).toContain(instanceId)
    const row = await rawQuery<{ sla_breached: boolean; sla_breached_at: string | null }>(
      `SELECT sla_breached, sla_breached_at FROM approval_metrics WHERE instance_id = $1`,
      [instanceId],
    )
    expect(row.rows[0]?.sla_breached).toBe(true)
    expect(row.rows[0]?.sla_breached_at).not.toBeNull()
  })

  it('analytics denominator (review P2): a business-calendar breached row (sla_hours NULL) counts as an SLA CANDIDATE, not just a breach', async () => {
    // Before the fix, the candidate denominators counted only `sla_hours IS NOT NULL`, so a calendar row
    // (sla_hours NULL, sla_due_at set, sla_breached TRUE) inflated the breach numerator while the candidate
    // denominator stayed 0 → a >100% (or divide-by-near-zero) breach rate. The predicate now counts
    // `sla_hours IS NOT NULL OR sla_due_at IS NOT NULL`. Isolated by a unique tenant.
    const metrics = new ApprovalMetricsService(rawQuery)
    const tenantId = `t32-denom-${Date.now()}`
    const instanceId = `${tenantId}-i1`
    await seedInstance(instanceId, 'approval_1')
    await rawQuery(
      `INSERT INTO approval_metrics
         (instance_id, template_id, tenant_id, started_at, sla_hours, sla_due_at, sla_unit,
          sla_breached, sla_breached_at, node_breakdown)
       VALUES ($1, NULL, $2, now() - INTERVAL '2 hours', NULL, now() - INTERVAL '1 minute', 'business',
               TRUE, now(), '[]'::jsonb)`,
      [instanceId, tenantId],
    )
    const summary = await metrics.getMetricsSummary({ tenantId })
    expect(summary.slaBreachCount).toBe(1)
    // The calendar row IS a candidate — denominator includes it (was 0 before the fix → inflated rate).
    expect(summary.slaCandidateCount).toBe(1)
  })

  it('legacy sla_hours path is byte-identical (no calendar columns) and still index-served', async () => {
    const metrics = new ApprovalMetricsService(rawQuery)
    const instanceId = `t32-legacy-${Date.now()}`
    await seedInstance(instanceId, 'approval_1')
    // A legacy row: sla_hours set, NO calendar SLA → sla_due_at / sla_unit stay NULL.
    await rawQuery(
      `INSERT INTO approval_metrics (instance_id, template_id, tenant_id, started_at, sla_hours, node_breakdown)
       VALUES ($1, NULL, 'default', now() - INTERVAL '10 hours', 1, '[]'::jsonb)`,
      [instanceId],
    )
    const seeded = await fetchMetrics(instanceId)
    expect(seeded?.sla_hours).toBe(1)
    expect(seeded?.sla_due_at).toBeNull()
    expect(seeded?.sla_unit).toBeNull()

    // Legacy breach scan flags it (started_at + 1h elapsed) — unchanged behavior.
    const breached = await metrics.checkSlaBreaches(new Date())
    expect(breached).toContain(instanceId)

    // The LEGACY fallback predicate must stay INDEX-SERVED (task: "assert the fallback predicate uses an
    // index; do not drop the current scan index"). On a pinned session with seqscan disabled the planner
    // picks idx_approval_metrics_sla_scan for the legacy predicate.
    const client = await poolManager.get().getInternalPool().connect()
    let legacyText = ''
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      const legacyPlan = await client.query(
        `EXPLAIN SELECT instance_id FROM approval_metrics
          WHERE terminal_at IS NULL AND sla_hours IS NOT NULL AND sla_breached = FALSE
            AND started_at + (sla_hours * interval '1 hour') < now()`,
      )
      await client.query('COMMIT')
      legacyText = legacyPlan.rows.map((r) => r['QUERY PLAN']).join('\n')
    } finally {
      client.release()
    }
    expect(legacyText).toContain('idx_approval_metrics_sla_scan')

    // Both partial indexes exist: the preserved legacy scan index AND the new calendar-scan index for
    // sla_due_at. (Exact plan choice for the calendar predicate varies with table stats on a tiny test
    // table, so servability is proven by the legacy plan above + the index's existence here.)
    const idx = await rawQuery<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'approval_metrics'
        AND indexname IN ('idx_approval_metrics_sla_scan', 'idx_approval_metrics_sla_due_scan')`,
    )
    const idxNames = idx.rows.map((r) => r.indexname)
    expect(idxNames).toContain('idx_approval_metrics_sla_scan')
    expect(idxNames).toContain('idx_approval_metrics_sla_due_scan')
  })
})
