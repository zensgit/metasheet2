/**
 * Approval / automation closeout acceptance — composite rehearsal head (2026-07-19).
 *
 * Purpose
 * -------
 * One focused real-DB acceptance surface for the eight named closeout scenarios (A1–A8).
 * It does NOT re-host the multi-thousand-line FWB/attachment fixture stacks.
 *
 * Honesty contract
 * ----------------
 * - "Pin" entries below are STATIC evidence only: this file asserts the pinned path exists
 *   and still contains the named positive + discriminating titles. It does NOT exec those
 *   files. CI runs each pinned file as a WHOLE FILE in the real-DB lane (two-point wiring).
 * - "Composed" tests below exercise production HTTP/service seams for genuinely cross-feature
 *   contracts that no single older file fully owns (complex condition+parallel authoring +
 *   restore against today's shared authoring-definition gate).
 *
 * Flags
 * -----
 * This file never flips production defaults. Composed authoring/restore paths do not need
 * APPROVAL_FWB_RUNTIME_ENABLED / APPROVAL_ATTACHMENTS_ENABLED. FWB/attachment scenarios are
 * pinned to suites that set flags only inside their own process scope.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEGRATION_DIR = HERE

type ScenarioPin = {
  id: 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8'
  title: string
  /** Relative to packages/core-backend/ */
  primaryFile: string
  /** Additional whole-file CI pins that complete the scenario. */
  supportingFiles?: string[]
  /** Substrings that MUST appear in primary (or supporting) file bodies — positive controls. */
  positiveMarkers: string[]
  /** Substrings that MUST appear — discriminating negatives / invariants. */
  negativeMarkers: string[]
  /** How CI proves this scenario (honest wording). */
  ciProof: string
}

/**
 * Closeout scenario → existing real-DB evidence map.
 * Keep this table in lockstep with plugin-tests.yml real-DB whole-file lists.
 */
export const CLOSEOUT_SCENARIO_MANIFEST: readonly ScenarioPin[] = [
  {
    id: 'A1',
    title: 'Complex approval authoring accepts and round-trips condition + parallel topology',
    primaryFile: 'tests/integration/approval-automation-closeout-acceptance.realdb.test.ts',
    supportingFiles: [
      'tests/integration/approval-wp1-parallel-gateway.api.test.ts',
      'tests/integration/approval-common-template-presets.api.test.ts',
    ],
    positiveMarkers: [
      'A1 composed: create→publish→GET round-trips a condition+parallel graph',
      'forks two branches and joins only after all branches complete',
      'amount-tier formula conditions round-trip through create→normalize',
    ],
    negativeMarkers: [
      'A1 composed: empty-rules condition branch is rejected at create (no template write)',
      'parallel conflict: two USER-resolving branches that resolve to the SAME user are hard-rejected',
    ],
    ciProof:
      'Composed A1 tests in THIS file run under the closeout acceptance whole-file entry; parallel runtime + amount-tier authoring pins are separate whole-file CI entries.',
  },
  {
    id: 'A2',
    title: 'Template version restore creates a new draft, preserves active version, rejects invalid historical snapshots',
    primaryFile: 'tests/integration/approval-template-authoring-uat.api.test.ts',
    supportingFiles: [
      'tests/integration/approval-automation-closeout-acceptance.realdb.test.ts',
    ],
    positiveMarkers: [
      'restores a valid historical snapshot as a new draft without changing the active version (positive control)',
      'restores a historical version into one new draft under concurrent requests without changing the active version',
      'A2 composed: restore of a condition+parallel published version creates a draft without flipping active',
    ],
    negativeMarkers: [
      'rejects restoring a historical empty-rules condition branch (400, no write)',
      'rejects restoring a historical invalid decisionFieldId (400, no write)',
      'rejects restoring a historical snapshot that violates the current authoring contract (400, no write)',
      'A2 composed: restore rejects empty-rules historical snapshot under full authoring contract (no write)',
    ],
    ciProof:
      'authoring-uat.api.test.ts is whole-file wired in the approval real-DB step; composed A2 tests live in this closeout file (also whole-file wired).',
  },
  {
    id: 'A3',
    title: 'Approved independent form values create a multitable record via write_approval_form_values with claim+record+revision+outbox atomicity',
    primaryFile: 'tests/integration/multitable-fwb-write-action-realdb.test.ts',
    supportingFiles: ['tests/integration/multitable-fwb-production-e2e-realdb.test.ts'],
    positiveMarkers: [
      'applied: claim + record + outbox commit TOGETHER; duplicate rerun writes nothing new',
      'approve → writeback creates record + claim + durable outbox (same-txn path)',
    ],
    negativeMarkers: [
      'ATOMICITY: rollback after a successful execute erases claim + record + outbox together',
      'gate-fail and mapping-fail reject BEFORE the claim (no ledger row, nothing written)',
      'negative control: FWB flag OFF rejects execution without write',
    ],
    ciProof:
      'Both FWB real-DB files are whole-file wired in the multitable real-DB step. This closeout file does not re-execute them.',
  },
  {
    id: 'A4',
    title: 'Server-pinned record-link updates the selected existing record; permission/lock failure is fail-closed',
    primaryFile: 'tests/integration/multitable-fwb-runtime-modes-realdb.test.ts',
    supportingFiles: ['tests/integration/multitable-fwb-production-e2e-realdb.test.ts'],
    positiveMarkers: [
      'record-link submit enforces row-level read deny with a readable positive control',
      'update: FOR UPDATE lock race — concurrent lock between check and write fails closed (values-free)',
    ],
    negativeMarkers: [
      'permission revocation: zero write',
      'actual FOR UPDATE interleaving: second writer sees first transaction hold and fails closed',
      'source visibility revocation at execute: canReadTemplate false → permanent reject',
    ],
    ciProof:
      'FWB runtime-modes + production-e2e whole-file wired in multitable real-DB step. This closeout file pins titles only.',
  },
  {
    id: 'A5',
    title: 'Approver decision values freeze at the resolving node round and write back without re-entry duplication',
    primaryFile: 'tests/integration/multitable-fwb-production-e2e-realdb.test.ts',
    supportingFiles: ['tests/integration/multitable-fwb-runtime-modes-realdb.test.ts'],
    positiveMarkers: [
      'approve → writeback creates record + claim + durable outbox (same-txn path)',
      'FWB-3: freeze epoch 1 then re-entry epoch 2; cascade deletes with instance',
    ],
    negativeMarkers: [
      'non-approve action never freezes supplied decisionData',
    ],
    ciProof:
      'FWB production-e2e freezes decisionData on approve and drives writeback; runtime-modes proves epoch re-entry freeze rows. Whole-file CI; pin only here.',
  },
  {
    id: 'A6',
    title: 'Durable redelivery of the same approval completion event is idempotent (no second business write)',
    primaryFile: 'tests/integration/multitable-fwb-write-action-realdb.test.ts',
    supportingFiles: ['tests/integration/multitable-fwb-runtime-modes-realdb.test.ts'],
    positiveMarkers: [
      'applied: claim + record + outbox commit TOGETHER; duplicate rerun writes nothing new',
      'V1 concurrent duplicate: two open transactions race the actual executor',
    ],
    negativeMarkers: [
      'D9 W1–W4: injection windows + concurrent duplicate dispatch',
      'Q6 ack is atomic — concurrent duplicate ack: exactly one succeeds',
    ],
    ciProof:
      'Ledger claim UNIQUE + already_applied path is whole-file proven in FWB write-action/runtime-modes real-DB suites. Pin only here.',
  },
  {
    id: 'A7',
    title: 'Clean attachment upload/submit bind/download authorization works; hidden/outsider access fails closed',
    primaryFile: 'tests/integration/approval-attachment-create-bind-realdb.test.ts',
    supportingFiles: [
      'tests/integration/approval-attachment-participant-realdb.test.ts',
      'tests/integration/approval-attachment-bind-reconcile-realdb.test.ts',
    ],
    positiveMarkers: [
      'clean uploader-owned attachment: createApproval commits instance + freezes ids + binds row',
      'matrix: requester/user-assignee/role-assignee/CC-user/CC-role/admin yes; outsider no',
      'hidden field refuses even admin; non-hidden admin ok (positive control)',
    ],
    negativeMarkers: [
      'outsider no',
      'hidden field refuses even admin',
    ],
    ciProof:
      'create-bind + participant + bind-reconcile whole-file wired in multitable real-DB step. This closeout file pins titles only.',
  },
  {
    id: 'A8',
    title: 'Infected/foreign/stale-or-GC attachment paths do not create a dangling approval or disclose bytes/existence',
    primaryFile: 'tests/integration/approval-attachment-create-bind-realdb.test.ts',
    supportingFiles: [
      'tests/integration/approval-attachment-bind-reconcile-realdb.test.ts',
      'tests/integration/approval-attachment-gc-realdb.test.ts',
    ],
    positiveMarkers: [
      // positive control that clean path still works (same suite) — scenario requires both sides
      'clean uploader-owned attachment: createApproval commits instance + freezes ids + binds row',
      'TTL sweep: only EXPIRED unbound rows flip to deleted + intent; bound and fresh rows untouched',
    ],
    negativeMarkers: [
      'infected attachment: create rejects 400 values-free; no instance; row stays unbound/infected',
      'foreign uploader attachment: create rejects; attachment remains unbound; zero new instance',
      'bind: submitter-owned unbound rows freeze to bound+instance; a FOREIGN row fails the WHOLE submission (rollback)',
      'GC↔bind race (G11): (i) bind wins → blob survives, no intent; (ii) GC wins → bind fails closed',
      'SAFETY: a blob still referenced by a live row is NEVER deleted — skipped and surfaced',
    ],
    ciProof:
      'create-bind infected/foreign + bind-reconcile foreign/GC race + GC safety whole-file wired. Pin only here.',
  },
] as const

function resolvePinPath(relFromCoreBackend: string): string {
  // This file lives in tests/integration → package root is ../..
  return join(HERE, '..', '..', relFromCoreBackend)
}

function readPinBody(relFromCoreBackend: string): string {
  const abs = resolvePinPath(relFromCoreBackend)
  expect(existsSync(abs), `missing pin file ${relFromCoreBackend}`).toBe(true)
  return readFileSync(abs, 'utf8')
}

// ── Static pin catalog (no production side effects) ───────────────────────────
describe('Approval/automation closeout acceptance — static scenario pins (A1–A8)', () => {
  it('manifest covers A1–A8 exactly once each', () => {
    const ids = CLOSEOUT_SCENARIO_MANIFEST.map((s) => s.id)
    expect(ids).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'])
  })

  it('every pinned path exists and retains its positive + discriminating markers', () => {
    for (const scenario of CLOSEOUT_SCENARIO_MANIFEST) {
      const bodies = [scenario.primaryFile, ...(scenario.supportingFiles ?? [])].map((f) => ({
        file: f,
        body: readPinBody(f),
      }))
      const joined = bodies.map((b) => b.body).join('\n')
      for (const marker of scenario.positiveMarkers) {
        expect(
          joined.includes(marker),
          `${scenario.id} missing positive marker ${JSON.stringify(marker)} across ${bodies.map((b) => b.file).join(', ')}`,
        ).toBe(true)
      }
      for (const marker of scenario.negativeMarkers) {
        expect(
          joined.includes(marker),
          `${scenario.id} missing negative/invariant marker ${JSON.stringify(marker)} across ${bodies.map((b) => b.file).join(', ')}`,
        ).toBe(true)
      }
    }
  })

  it('does not claim this file executed sibling real-DB suites (honesty tripwire)', () => {
    // Guard against a future edit that pretends pin = exec.
    const self = readFileSync(join(INTEGRATION_DIR, 'approval-automation-closeout-acceptance.realdb.test.ts'), 'utf8')
    expect(self).toContain('does NOT exec those')
    expect(self).toContain('Pin only here')
    expect(self).not.toMatch(/vitest\.run|spawnSync\(['"]pnpm|execFileSync\(['"]vitest/)
  })
})

// ── Composed real-DB scenarios (production seams) ─────────────────────────────
const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await realFetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  return await realFetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function closeoutFormSchema() {
  return {
    fields: [
      { id: 'amount', type: 'number', label: 'Amount', required: true },
      { id: 'reason', type: 'text', label: 'Reason', required: true },
    ],
  }
}

/** Condition gate + parallel high path + linear default path (tree-authoring complex shape). */
function conditionPlusParallelGraph(opts?: { emptyRules?: boolean }) {
  const highRules = opts?.emptyRules
    ? []
    : [{ fieldId: 'amount', operator: 'gte', value: 1000 }]
  return {
    nodes: [
      { key: 'start', type: 'start', name: 'Start', config: {} },
      {
        key: 'route',
        type: 'condition',
        name: 'Amount route',
        config: {
          branches: [{ edgeKey: 'edge-high', rules: highRules }],
          defaultEdgeKey: 'edge-low',
        },
      },
      {
        key: 'parallel_fork',
        type: 'parallel',
        name: 'High fork',
        config: {
          branches: ['edge-fork-a', 'edge-fork-b'],
          joinMode: 'all',
          joinNodeKey: 'join_review',
        },
      },
      {
        key: 'branch_a',
        type: 'approval',
        name: 'Branch A',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: ['closeout-legal'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'branch_b',
        type: 'approval',
        name: 'Branch B',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: ['closeout-compliance'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'join_review',
        type: 'approval',
        name: 'Join',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: ['closeout-finance'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'low_review',
        type: 'approval',
        name: 'Low',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: ['closeout-low'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: 'End', config: {} },
    ],
    edges: [
      { key: 'edge-start-route', source: 'start', target: 'route' },
      { key: 'edge-high', source: 'route', target: 'parallel_fork' },
      { key: 'edge-low', source: 'route', target: 'low_review' },
      { key: 'edge-fork-a', source: 'parallel_fork', target: 'branch_a' },
      { key: 'edge-fork-b', source: 'parallel_fork', target: 'branch_b' },
      { key: 'edge-a-join', source: 'branch_a', target: 'join_review' },
      { key: 'edge-b-join', source: 'branch_b', target: 'join_review' },
      { key: 'edge-join-end', source: 'join_review', target: 'end' },
      { key: 'edge-low-end', source: 'low_review', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval/automation closeout acceptance — composed real-DB (A1/A2)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken = ''
  const createdTemplateIds = new Set<string>()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`
    adminToken = await authToken(baseUrl, 'closeout-admin')
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      const templateIds = [...createdTemplateIds]
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

  it('sentinel: DATABASE_URL set (DB-backed closeout lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A1 composed: create→publish→GET round-trips a condition+parallel graph', async () => {
    const graph = conditionPlusParallelGraph()
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `closeout-a1-${Date.now()}`,
        name: 'Closeout A1 complex graph',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: closeoutFormSchema(),
        approvalGraph: graph,
      },
    })
    expect(createResp.status, await createResp.clone().text()).toBe(201)
    const created = (await createResp.json()) as {
      id: string
      latestVersionId: string
      approvalGraph: { nodes: Array<{ key: string; type: string; config: Record<string, unknown> }> }
    }
    createdTemplateIds.add(created.id)

    const condition = created.approvalGraph.nodes.find((n) => n.type === 'condition')
    const parallel = created.approvalGraph.nodes.find((n) => n.type === 'parallel')
    expect(condition?.key).toBe('route')
    expect(parallel?.config).toMatchObject({
      joinMode: 'all',
      joinNodeKey: 'join_review',
    })
    expect(parallel?.config.branches).toEqual(['edge-fork-a', 'edge-fork-b'])

    const publishResp = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResp.status, await publishResp.clone().text()).toBe(200)

    const detailResp = await jsonRequest(
      baseUrl,
      `/api/approval-templates/${created.id}/versions/${created.latestVersionId}`,
      adminToken,
    )
    expect(detailResp.status).toBe(200)
    const detail = (await detailResp.json()) as {
      approvalGraph: { nodes: Array<{ type: string; config: Record<string, unknown> }> }
    }
    expect(detail.approvalGraph.nodes.some((n) => n.type === 'condition')).toBe(true)
    expect(detail.approvalGraph.nodes.some((n) => n.type === 'parallel')).toBe(true)
  })

  it('A1 composed: empty-rules condition branch is rejected at create (no template write)', async () => {
    const pool = poolManager.get()
    const before = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM approval_templates WHERE key LIKE 'closeout-a1-empty-%'`,
    )
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `closeout-a1-empty-${Date.now()}`,
        name: 'Closeout A1 empty rules',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: closeoutFormSchema(),
        approvalGraph: conditionPlusParallelGraph({ emptyRules: true }),
      },
    })
    expect(createResp.status).toBe(400)
    const payload = (await createResp.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_CONDITION_BRANCH_RULES_EMPTY')
    const after = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM approval_templates WHERE key LIKE 'closeout-a1-empty-%'`,
    )
    expect(after.rows[0].c).toBe(before.rows[0].c)
  })

  it('A2 composed: restore of a condition+parallel published version creates a draft without flipping active', async () => {
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `closeout-a2-${Date.now()}`,
        name: 'Closeout A2 complex restore',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: closeoutFormSchema(),
        approvalGraph: conditionPlusParallelGraph(),
      },
    })
    expect(createResp.status, await createResp.clone().text()).toBe(201)
    const created = (await createResp.json()) as { id: string; latestVersionId: string }
    createdTemplateIds.add(created.id)
    const v1Id = created.latestVersionId

    expect(
      (
        await jsonRequest(baseUrl, `/api/approval-templates/${created.id}/publish`, adminToken, {
          method: 'POST',
          body: { policy: { allowRevoke: true } },
        })
      ).status,
    ).toBe(200)

    // New draft diverges the latest pointer while keeping active = v1.
    const linear = {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Solo',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: ['closeout-solo'] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const updateResp = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}`, adminToken, {
      method: 'PATCH',
      body: { approvalGraph: linear },
    })
    expect(updateResp.status, await updateResp.clone().text()).toBe(200)
    const updated = (await updateResp.json()) as { latestVersionId: string }
    expect(updated.latestVersionId).not.toBe(v1Id)

    const restoreResp = await jsonRequest(
      baseUrl,
      `/api/approval-templates/${created.id}/versions/${v1Id}/restore`,
      adminToken,
      { method: 'POST', body: { expectedLatestVersionId: updated.latestVersionId } },
    )
    expect(restoreResp.status, await restoreResp.clone().text()).toBe(201)
    const restored = (await restoreResp.json()) as {
      id: string
      version: number
      status: string
      restoredFromVersionId: string
      approvalGraph: { nodes: Array<{ type: string }> }
    }
    expect(restored).toMatchObject({
      status: 'draft',
      restoredFromVersionId: v1Id,
    })
    expect(restored.approvalGraph.nodes.some((n) => n.type === 'condition')).toBe(true)
    expect(restored.approvalGraph.nodes.some((n) => n.type === 'parallel')).toBe(true)

    const pool = poolManager.get()
    const row = await pool.query<{ active_version_id: string; latest_version_id: string; status: string }>(
      `SELECT active_version_id, latest_version_id, status FROM approval_templates WHERE id = $1`,
      [created.id],
    )
    expect(row.rows[0]).toEqual({
      active_version_id: v1Id,
      latest_version_id: restored.id,
      status: 'published',
    })
  })

  it('A2 composed: restore rejects empty-rules historical snapshot under full authoring contract (no write)', async () => {
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `closeout-a2-neg-${Date.now()}`,
        name: 'Closeout A2 empty-rules restore neg',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: closeoutFormSchema(),
        approvalGraph: conditionPlusParallelGraph(),
      },
    })
    expect(createResp.status).toBe(201)
    const created = (await createResp.json()) as { id: string; latestVersionId: string }
    createdTemplateIds.add(created.id)
    const v1Id = created.latestVersionId

    const pool = poolManager.get()
    // SQL-insert a drifted historical graph create/update would refuse (empty rules).
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO approval_template_versions (template_id, version, status, form_schema, approval_graph)
       VALUES ($1, 2, 'draft', $2, $3)
       RETURNING id`,
      [created.id, JSON.stringify(closeoutFormSchema()), JSON.stringify(conditionPlusParallelGraph({ emptyRules: true }))],
    )
    const invalidId = inserted.rows[0].id

    const restoreResp = await jsonRequest(
      baseUrl,
      `/api/approval-templates/${created.id}/versions/${invalidId}/restore`,
      adminToken,
      { method: 'POST', body: { expectedLatestVersionId: v1Id } },
    )
    expect(restoreResp.status).toBe(400)
    const payload = (await restoreResp.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_CONDITION_BRANCH_RULES_EMPTY')

    const versions = await pool.query<{ version: number }>(
      `SELECT version FROM approval_template_versions WHERE template_id = $1 ORDER BY version`,
      [created.id],
    )
    expect(versions.rows.map((r) => r.version)).toEqual([1, 2])
    const latest = await pool.query<{ latest_version_id: string }>(
      `SELECT latest_version_id FROM approval_templates WHERE id = $1`,
      [created.id],
    )
    expect(latest.rows[0].latest_version_id).toBe(v1Id)
  })
})
