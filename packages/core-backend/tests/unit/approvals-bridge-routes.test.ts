import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

import type { ApprovalBridgePlmAdapter } from '../../src/services/approval-bridge-types'
import { APPROVAL_LIST_SCOPE_NO_MATCH } from '../../src/services/ApprovalBridgeService'

type ApprovalFixture = {
  id: string
  request_type: string
  title: string
  requester_id: string
  requester_name: string
  status: 'pending' | 'approved' | 'rejected'
  version?: number
  created_at: string
  updated_at?: string
  product_id?: string
  product_number?: string
  product_name?: string
}

type ApprovalHistoryFixture = {
  id: string
  eco_id?: string
  stage_id?: string
  approval_type?: string
  required_role?: string
  user_id?: string | null
  status?: string
  comment?: string | null
  approved_at?: string | null
  created_at?: string | null
}

type InstanceRow = {
  id: string
  status: string
  version: number
  source_system: string
  external_approval_id: string | null
  workflow_key: string | null
  business_key: string | null
  title: string | null
  requester_snapshot: Record<string, unknown>
  subject_snapshot: Record<string, unknown>
  policy_snapshot: Record<string, unknown>
  metadata: Record<string, unknown>
  current_step: number
  total_steps: number
  source_updated_at: Date | null
  last_synced_at: Date | null
  sync_status: string
  sync_error: string | null
  // B3-03 (模板/时间筛选): optional so every pre-existing `baseInstance()` call keeps compiling
  // unchanged; only tests that exercise the templateId filter set it.
  template_id?: string | null
  created_at: Date
  updated_at: Date
}

type AssignmentRow = {
  id: string
  instance_id: string
  assignment_type: string
  assignee_id: string
  source_step: number
  is_active: boolean
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

type ApprovalRecordRow = {
  id: number
  instance_id: string
  action: string
  actor_id: string | null
  actor_name: string | null
  comment: string | null
  reason: string | null
  from_status: string | null
  to_status: string
  from_version: number | null
  to_version: number
  metadata: Record<string, unknown>
  occurred_at: Date
  created_at: Date
}

const routeState = vi.hoisted(() => {
  const plmApprovals: ApprovalFixture[] = [
    {
      id: 'eco-1',
      request_type: 'eco',
      title: 'ECO-1',
      requester_id: 'user-1',
      requester_name: 'Alice',
      status: 'pending',
      version: 7,
      created_at: '2026-04-04T00:00:00.000Z',
      updated_at: '2026-04-04T00:05:00.000Z',
      product_id: 'prod-1',
      product_number: 'PN-1',
      product_name: 'Motor Housing',
    },
  ]

  const plmHistory: ApprovalHistoryFixture[] = [
    {
      id: 'hist-1',
      eco_id: 'eco-1',
      stage_id: 'review',
      approval_type: 'mandatory',
      required_role: 'reviewer',
      user_id: 'reviewer-1',
      status: 'approved',
      comment: 'LGTM',
      approved_at: '2026-04-04T00:10:00.000Z',
      created_at: '2026-04-04T00:09:00.000Z',
    },
  ]

  const state = {
    instances: new Map<string, InstanceRow>(),
    assignments: new Map<string, AssignmentRow>(),
    records: [] as ApprovalRecordRow[],
    recordId: 1,
    // B3-02 (行级未读): `${userId} ${instanceId}` membership set standing in for an
    // `approval_reads` row — presence means "read".
    reads: new Set<string>(),
    // P0-A: the list scope reads the viewer's roles from the DB (`viewerRoles` in
    // `approval-instance-readability.ts`) rather than from the request's claims, so the fake pool
    // has to answer that lookup's two queries. Both default to EMPTY, which is the honest shape
    // here: this file's mocked identity has no `users` row and no `user_roles` rows, so its
    // DB-derived role set is empty and the scope's role-typed arms match nothing — exactly what a
    // claim-only identity gets in production.
    users: new Map<string, { role: string | null; is_active: boolean }>(),
    userRoles: [] as Array<{ user_id: string; role_id: string; name: string | null }>,
    // P0-A (A15): when true, BOTH `viewerRoles` lookups reject. The list surfaces wrap that call in
    // `viewerRolesFailClosed`, so the failure must narrow the role arms (an empty role set, bound
    // as the no-match sentinel) instead of surfacing as a list 500.
    failViewerRoles: false,
  }

  const now = () => new Date('2026-04-04T08:00:00.000Z')

  const baseInstance = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
    id: 'local-1',
    status: 'pending',
    version: 0,
    source_system: 'platform',
    external_approval_id: null,
    workflow_key: null,
    business_key: null,
    title: 'Local approval',
    requester_snapshot: {},
    subject_snapshot: {},
    policy_snapshot: {},
    metadata: {},
    current_step: 0,
    total_steps: 0,
    source_updated_at: null,
    last_synced_at: null,
    sync_status: 'ok',
    sync_error: null,
    created_at: now(),
    updated_at: now(),
    ...overrides,
  })

  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  const parseJson = (value: unknown): Record<string, unknown> => {
    if (!value) return {}
    if (typeof value === 'string') {
      return JSON.parse(value) as Record<string, unknown>
    }
    return value as Record<string, unknown>
  }

  const filterDynamicInstances = (sql: string, params: unknown[]) => {
    let rows = Array.from(state.instances.values())
    let index = 0

    if (sql.includes('source_system = $')) {
      const value = String(params[index++])
      rows = rows.filter((row) => row.source_system === value)
    }
    if (sql.includes('status = $')) {
      const value = String(params[index++])
      rows = rows.filter((row) => row.status === value)
    }
    // `completed`/`processed`'s own literal (non-parameterized) status conditions — no `$` bind
    // param, so no `index` consumption; this is what actually distinguishes `processed` (ANY
    // status) from `completed` (`status <> 'pending'` only) at the mock level.
    if (sql.includes("status = 'pending'")) {
      rows = rows.filter((row) => row.status === 'pending')
    }
    if (sql.includes("status <> 'pending'")) {
      rows = rows.filter((row) => row.status !== 'pending')
    }
    if (sql.includes('workflow_key = $')) {
      rows = rows.filter((row) => row.workflow_key === String(params[index++]))
    }
    if (sql.includes('business_key = $')) {
      rows = rows.filter((row) => row.business_key === String(params[index++]))
    }
    // B3-03 (模板/时间筛选)
    if (sql.includes('template_id = $')) {
      const value = String(params[index++])
      rows = rows.filter((row) => row.template_id === value)
    }
    if (sql.includes('created_at >= $')) {
      const cutoff = new Date(String(params[index++])).getTime()
      rows = rows.filter((row) => row.created_at.getTime() >= cutoff)
    }
    if (sql.includes('created_at <= $')) {
      const cutoff = new Date(String(params[index++])).getTime()
      rows = rows.filter((row) => row.created_at.getTime() <= cutoff)
    }
    // ORDER IS LOAD-BEARING: `index` walks the bind array positionally, so the blocks here must
    // follow the SERVICE's push order, not the order the conditions happen to appear in the SQL
    // text. The service pushes `templateId` / `createdFrom` / `createdTo` BEFORE the tab block's
    // actor parameters, so these two tab-driven subquery readers must come after the three above.
    // (They used to sit before them; nothing caught it because no test combined a template/date
    // filter with a tab — P0-A's tab default made every tab-less request combine them.)
    if (sql.includes('SELECT instance_id FROM approval_assignments')) {
      const assigneeId = String(params[index++])
      const assignedInstanceIds = new Set(
        Array.from(state.assignments.values())
          .filter((row) => row.assignee_id === assigneeId && row.is_active)
          .map((row) => row.instance_id),
      )
      rows = rows.filter((row) => assignedInstanceIds.has(row.id))
    }
    // B3-01 (我已处理): reverse lookup on approval_records.actor_id, ANY status.
    if (sql.includes('SELECT instance_id FROM approval_records WHERE actor_id = $')) {
      const actorId = String(params[index++])
      const actedInstanceIds = new Set(
        state.records.filter((record) => record.actor_id === actorId).map((record) => record.instance_id),
      )
      rows = rows.filter((row) => actedInstanceIds.has(row.id))
    }

    return { rows, index }
  }

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = normalize(sql)

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }

    // P0-A (A9): `GET /api/approvals/pending` now conjoins the SAME server-determined scope the
    // list feed applies, so its SQL lost the `ai` alias (the shipped scope condition qualifies its
    // columns with `approval_instances.`, and PostgreSQL forbids qualifying by table name once the
    // table is aliased) and gained three leading bind parameters (actor, DB-derived roles,
    // permissions) ahead of LIMIT/OFFSET. LIMIT/OFFSET are therefore read off the SQL TEXT's own
    // `$N` placeholders — the same shape the dynamic-instance handler below already uses — rather
    // than off fixed positions 0/1, which is what made this handler positional and brittle.
    //
    // DISCLOSED, so a green run here is not over-read: this fake pool does NOT interpret the scope
    // condition's SQL, exactly as it does not interpret the list query's. Mutating the scope
    // condition therefore leaves this file green; the real gate for A9 is the real-PostgreSQL
    // suite `tests/integration/approval-list-scope-server-side.db.test.ts`.
    if (normalized.startsWith('SELECT approval_instances.* FROM approval_instances WHERE approval_instances.status = \'pending\'')) {
      const limitOffsetMatch = normalized.match(/LIMIT \$(\d+) OFFSET \$(\d+)/)
      const rows = Array.from(state.instances.values())
        .filter((row) => row.status === 'pending' && row.source_system === 'platform')
      const limit = limitOffsetMatch ? Number(params[Number(limitOffsetMatch[1]) - 1]) : rows.length
      const offset = limitOffsetMatch ? Number(params[Number(limitOffsetMatch[2]) - 1]) : 0
      const sliced = rows.slice(offset, offset + limit)
      return { rows: sliced, rowCount: sliced.length }
    }

    if (normalized.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances WHERE approval_instances.status = \'pending\'')) {
      const count = Array.from(state.instances.values())
        .filter((row) => row.status === 'pending' && row.source_system === 'platform').length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances')) {
      const { rows } = filterDynamicInstances(normalized, params)
      return { rows: [{ count: String(rows.length) }], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE id = $1 AND COALESCE(source_system, \'platform\') = \'platform\' FOR UPDATE')) {
      const row = state.instances.get(String(params[0]))
      const rows = row && row.source_system === 'platform' ? [row] : []
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE')) {
      const row = state.instances.get(String(params[0]))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
      const row = state.instances.get(String(params[0]))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE')) {
      const { rows } = filterDynamicInstances(normalized, params)
      // LIMIT/OFFSET's own `$N` placeholders are read directly off the SQL text rather than off
      // `filterDynamicInstances`'s returned `index` — some tabs (e.g. `mine` / `processed`) push
      // actorRoles/actorPermissions params that are never referenced by that tab's own condition
      // text, so a naive "params consumed so far" counter under-counts and would slice against the
      // wrong array positions once a tab stops referencing every pre-pushed param.
      const limitOffsetMatch = normalized.match(/LIMIT \$(\d+) OFFSET \$(\d+)/)
      const limit = limitOffsetMatch ? Number(params[Number(limitOffsetMatch[1]) - 1]) : rows.length
      const offset = limitOffsetMatch ? Number(params[Number(limitOffsetMatch[2]) - 1]) : 0
      const sorted = rows.sort((left, right) => {
        const leftPrimary = (left.source_updated_at ?? left.updated_at).getTime()
        const rightPrimary = (right.source_updated_at ?? right.updated_at).getTime()
        if (leftPrimary !== rightPrimary) {
          return rightPrimary - leftPrimary
        }
        if (left.updated_at.getTime() !== right.updated_at.getTime()) {
          return right.updated_at.getTime() - left.updated_at.getTime()
        }
        return right.id.localeCompare(left.id)
      })
      const sliced = sorted.slice(offset, offset + limit)
      return { rows: sliced, rowCount: sliced.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances ORDER BY COALESCE(source_updated_at, updated_at) DESC')) {
      const limit = Number(params[0])
      const offset = Number(params[1])
      const rows = Array.from(state.instances.values())
      const sorted = rows.sort((left, right) => {
        const leftPrimary = (left.source_updated_at ?? left.updated_at).getTime()
        const rightPrimary = (right.source_updated_at ?? right.updated_at).getTime()
        if (leftPrimary !== rightPrimary) {
          return rightPrimary - leftPrimary
        }
        if (left.updated_at.getTime() !== right.updated_at.getTime()) {
          return right.updated_at.getTime() - left.updated_at.getTime()
        }
        return right.id.localeCompare(left.id)
      })
      const sliced = sorted.slice(offset, offset + limit)
      return { rows: sliced, rowCount: sliced.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_assignments WHERE instance_id = ANY($1)')) {
      const ids = new Set((params[0] as string[]) || [])
      const rows = Array.from(state.assignments.values()).filter((row) => ids.has(row.instance_id))
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT DISTINCT assignee_id FROM approval_assignments')) {
      const rows = Array.from(state.assignments.values())
        .filter((row) => (
          row.instance_id === String(params[0])
          && row.is_active
          && row.assignment_type === 'user'
        ))
        .map((row) => ({ assignee_id: row.assignee_id }))
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT id, action, actor_id, actor_name, comment, from_status, to_status, metadata, occurred_at FROM approval_records')) {
      const rows = state.records
        .filter((row) => row.instance_id === String(params[0]))
        .sort((left, right) => right.occurred_at.getTime() - left.occurred_at.getTime())
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('INSERT INTO approval_instances')) {
      const [
        id,
        status,
        sourceSystem,
        externalApprovalId,
        workflowKey,
        businessKey,
        title,
        requesterSnapshot,
        subjectSnapshot,
        policySnapshot,
        metadata,
        sourceUpdatedAt,
      ] = params
      const existing = Array.from(state.instances.values()).find(
        (row) => row.source_system === sourceSystem && row.external_approval_id === externalApprovalId,
      )
      const preserved = existing || state.instances.get(String(id))
      const timestamp = now()
      const nextRow: InstanceRow = {
        ...(preserved || baseInstance({ id: String(id) })),
        id: preserved?.id || String(id),
        status: String(status),
        source_system: String(sourceSystem),
        external_approval_id: externalApprovalId == null ? null : String(externalApprovalId),
        workflow_key: workflowKey == null ? null : String(workflowKey),
        business_key: businessKey == null ? null : String(businessKey),
        title: title == null ? null : String(title),
        requester_snapshot: parseJson(requesterSnapshot),
        subject_snapshot: parseJson(subjectSnapshot),
        policy_snapshot: parseJson(policySnapshot),
        metadata: parseJson(metadata),
        current_step: 0,
        total_steps: 0,
        source_updated_at: sourceUpdatedAt ? new Date(String(sourceUpdatedAt)) : null,
        last_synced_at: timestamp,
        sync_status: 'ok',
        sync_error: null,
        created_at: preserved?.created_at || timestamp,
        updated_at: timestamp,
      }
      state.instances.set(nextRow.id, nextRow)
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO approval_assignments')) {
      const instanceId = String(params[0])
      const key = `${instanceId}:source_queue:plm:source-owned:0`
      const timestamp = now()
      const existing = state.assignments.get(key)
      state.assignments.set(key, {
        id: existing?.id || `assign-${state.assignments.size + 1}`,
        instance_id: instanceId,
        assignment_type: 'source_queue',
        assignee_id: 'plm:source-owned',
        source_step: 0,
        is_active: Boolean(params[1]),
        metadata: parseJson(params[2]),
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_assignments')) {
      const instanceId = String(params[0])
      const key = `${instanceId}:source_queue:plm:source-owned:0`
      const existing = state.assignments.get(key)
      if (!existing || !existing.is_active) {
        return { rows: [], rowCount: 0 }
      }
      state.assignments.set(key, {
        ...existing,
        source_step: 0,
        is_active: Boolean(params[1]),
        metadata: parseJson(params[2]),
        updated_at: now(),
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET sync_status = \'error\'')) {
      const row = state.instances.get(String(params[1]))
      if (row) {
        row.sync_status = 'error'
        row.sync_error = String(params[0])
        row.last_synced_at = now()
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET status = $1,')) {
      const row = state.instances.get(String(params[2]))
      const expectedVersion = Number(params[3])
      const expectedStatus = String(params[4])
      if (row && row.version === expectedVersion && row.status === expectedStatus) {
        row.status = String(params[0])
        row.version = Number(params[1])
        row.sync_status = 'ok'
        row.sync_error = null
        row.last_synced_at = now()
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
      Array.from(state.assignments.values())
        .filter((row) => row.instance_id === String(params[0]) && row.is_active)
        .forEach((row) => {
          row.is_active = false
          row.updated_at = now()
        })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET status = \'approved\'')) {
      const row = state.instances.get(String(params[1]))
      if (row) {
        row.status = 'approved'
        row.version = Number(params[0])
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET status = \'rejected\'')) {
      const row = state.instances.get(String(params[1]))
      if (row) {
        row.status = 'rejected'
        row.version = Number(params[0])
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('INSERT INTO approval_records')) {
      let record: ApprovalRecordRow

      if (normalized.includes("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")) {
        record = {
          id: state.recordId++,
          instance_id: String(params[0]),
          action: String(params[1]),
          actor_id: params[2] == null ? null : String(params[2]),
          actor_name: params[3] == null ? null : String(params[3]),
          comment: params[4] == null ? null : String(params[4]),
          reason: null,
          from_status: params[5] == null ? null : String(params[5]),
          to_status: String(params[6]),
          from_version: params[7] == null ? null : Number(params[7]),
          to_version: Number(params[8]),
          metadata: parseJson(params[9]),
          occurred_at: now(),
          created_at: now(),
        }
      } else if (normalized.includes("VALUES ($1, 'approve'")) {
        record = {
          id: state.recordId++,
          instance_id: String(params[0]),
          action: 'approve',
          actor_id: params[1] == null ? null : String(params[1]),
          actor_name: params[2] == null ? null : String(params[2]),
          comment: params[3] == null ? null : String(params[3]),
          reason: null,
          from_status: params[4] == null ? null : String(params[4]),
          to_status: 'approved',
          from_version: params[5] == null ? null : Number(params[5]),
          to_version: Number(params[6]),
          metadata: parseJson(params[7]),
          occurred_at: now(),
          created_at: now(),
        }
      } else {
        record = {
          id: state.recordId++,
          instance_id: String(params[0]),
          action: 'reject',
          actor_id: params[1] == null ? null : String(params[1]),
          actor_name: params[2] == null ? null : String(params[2]),
          reason: params[3] == null ? null : String(params[3]),
          comment: params[4] == null ? null : String(params[4]),
          from_status: params[5] == null ? null : String(params[5]),
          to_status: 'rejected',
          from_version: params[6] == null ? null : Number(params[6]),
          to_version: Number(params[7]),
          metadata: parseJson(params[8]),
          occurred_at: now(),
          created_at: now(),
        }
      }

      state.records.push(record)
      return { rows: [{ id: record.id }], rowCount: 1 }
    }

    // B3-02 (行级未读): the pending-tab list issues a per-actor approval_reads lookup after the
    // main query. Absence from `state.reads` means unread — mirrors the real LEFT JOIN ... IS NULL
    // predicate for an actor who has not opened a given row.
    //
    // REVIEW P2 HARDENING: the handler is keyed on the FULL predicate text, not just the SELECT
    // prefix — a prefix-only match let the mock re-implement the per-user filter and shadow the
    // real SQL (mutating `user_id = $1` away in the service stayed green). Now a predicate edit
    // in the service falls through to the unhandled-SQL throw below and the suite goes red.
    if (
      normalized.startsWith('SELECT instance_id FROM approval_reads')
      && normalized.includes('WHERE user_id = $1')
      && normalized.includes('instance_id = ANY($2::text[])')
    ) {
      const userId = String(params[0])
      const ids = new Set((params[1] as string[]) || [])
      const rows = Array.from(state.reads)
        .map((key) => key.split(' '))
        .filter(([readUser, readInstance]) => readUser === userId && ids.has(readInstance))
        .map(([, readInstance]) => ({ instance_id: readInstance }))
      return { rows, rowCount: rows.length }
    }

    // P0-A: `viewerRoles(db, viewerId)`'s two lookups, keyed on the FULL predicate text for the
    // same reason the `approval_reads` handler above is — a prefix-only match would let the mock
    // re-implement the predicate and shadow the real SQL. An `is_active = FALSE` user contributes
    // no `users.role`, and `user_roles` rows contribute both `role_id` and the joined `roles.name`,
    // mirroring the real function including its deliberate is_active asymmetry.
    if (
      normalized.startsWith('SELECT role FROM users')
      && normalized.includes('WHERE id = $1')
      && normalized.includes('is_active = TRUE')
    ) {
      if (state.failViewerRoles) throw new Error('viewer role lookup unavailable')
      const user = state.users.get(String(params[0]))
      const rows = user && user.is_active ? [{ role: user.role }] : []
      return { rows, rowCount: rows.length }
    }
    if (
      normalized.startsWith('SELECT ur.role_id, r.name FROM user_roles ur')
      && normalized.includes('LEFT JOIN roles r ON r.id = ur.role_id')
      && normalized.includes('WHERE ur.user_id = $1')
    ) {
      if (state.failViewerRoles) throw new Error('viewer role lookup unavailable')
      const rows = state.userRoles
        .filter((row) => row.user_id === String(params[0]))
        .map((row) => ({ role_id: row.role_id, name: row.name }))
      return { rows, rowCount: rows.length }
    }

    throw new Error(`Unhandled SQL in approvals bridge test: ${normalized}`)
  })

  const pool = {
    query,
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  }

  const reset = () => {
    state.instances.clear()
    state.assignments.clear()
    state.records = []
    state.recordId = 1
    state.reads.clear()
    state.users.clear()
    state.userRoles = []
    state.failViewerRoles = false
    plmApprovals.splice(1)
    plmHistory.splice(1)
    plmApprovals[0].status = 'pending'
    plmApprovals[0].version = 7
    plmHistory[0].approved_at = '2026-04-04T00:10:00.000Z'
    plmHistory[0].created_at = '2026-04-04T00:09:00.000Z'
    state.instances.set('local-1', baseInstance())
    query.mockClear()
    pool.connect.mockClear()
  }

  return {
    state,
    pool,
    reset,
    plmApprovals,
    plmHistory,
  }
})

vi.mock('../../src/db/pg', () => ({
  pool: routeState.pool,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'test-user',
      sub: 'test-user',
      name: 'Test User',
      email: 'test@example.com',
      permissions: ['*:*', 'attendance:approve'],
      roles: ['admin'],
    } as never
    next()
  },
}))

import { approvalsRouter } from '../../src/routes/approvals'
import { approvalHistoryRouter } from '../../src/routes/approval-history'

function createPlmAdapterMock(): ApprovalBridgePlmAdapter & {
  getApprovals: ReturnType<typeof vi.fn>
  getApprovalById: ReturnType<typeof vi.fn>
  getApprovalHistory: ReturnType<typeof vi.fn>
  approveApproval: ReturnType<typeof vi.fn>
  rejectApproval: ReturnType<typeof vi.fn>
} {
  const selectApprovals = (options?: { status?: string; limit?: number; offset?: number }) => {
    const filtered = routeState.plmApprovals.filter((approval) => !options?.status || approval.status === options.status)
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? filtered.length
    return {
      data: filtered.slice(offset, offset + limit),
      totalCount: filtered.length,
    }
  }

  return {
    getApprovals: vi.fn(async (options?: { status?: string; limit?: number; offset?: number }) => {
      const result = selectApprovals(options)
      return {
        data: result.data,
        metadata: { totalCount: result.totalCount },
      }
    }),
    getApprovalById: vi.fn(async (approvalId: string) => ({
      data: routeState.plmApprovals.filter((approval) => approval.id === approvalId),
      metadata: { totalCount: routeState.plmApprovals.filter((approval) => approval.id === approvalId).length },
    })),
    getApprovalHistory: vi.fn(async () => ({
      data: routeState.plmHistory,
      metadata: { totalCount: routeState.plmHistory.length },
    })),
    approveApproval: vi.fn(async (approvalId: string, version: number, comment?: string) => {
      const approval = routeState.plmApprovals.find((item) => item.id === approvalId)
      if (approval) {
        approval.status = 'approved'
        if (typeof approval.version === 'number') {
          approval.version += 1
        }
      }
      return {
        data: [{ id: approvalId, version, comment: comment || null }],
        metadata: { totalCount: 1 },
      }
    }),
    rejectApproval: vi.fn(async (approvalId: string, version: number, comment: string) => {
      const approval = routeState.plmApprovals.find((item) => item.id === approvalId)
      if (approval) {
        approval.status = 'rejected'
        if (typeof approval.version === 'number') {
          approval.version += 1
        }
      }
      return {
        data: [{ id: approvalId, version, comment }],
        metadata: { totalCount: 1 },
      }
    }),
  }
}

function createApp(plmAdapter?: ApprovalBridgePlmAdapter) {
  const app = express()
  app.use(express.json())
  app.use(approvalsRouter({ plmAdapter }))
  app.use(approvalHistoryRouter({ plmAdapter }))
  return app
}

const pinned = usePinnedServer()

/**
 * P0-A re-pin helper. `GET /api/approvals` now (a) serves a request carrying NO `tab` on the
 * documented default tab (`pending`) instead of applying no tab condition at all, and (b) conjoins
 * a server-determined scope condition into every list query. The mocked identity in this file is
 * `test-user`, so a platform fixture row is reachable by a tab-less request only when it carries
 * that identity's ACTIVE seat. Every test below that previously relied on a seat-less row being
 * returned for a tab-less request seeds the seat explicitly through this helper.
 *
 * SCOPE OF THE EVIDENCE THIS FILE CAN CARRY, stated so a green run here is not over-read: the
 * fake pool interprets the query by matching SQL substrings, and it does not implement the scope
 * condition at all — so the scope's own behaviour is neither exercised nor gated here. The real-DB
 * suite `tests/integration/approval-list-scope-server-side.db.test.ts` is where that lives; these
 * assertions only pin the tab-defaulting half.
 */
function seedActorSeatForDefaultTab(instanceId: string, assigneeId = 'test-user'): void {
  const timestamp = new Date('2026-04-04T08:00:00.000Z')
  routeState.state.assignments.set(`${instanceId}:${assigneeId}`, {
    id: `assign-${instanceId}-${assigneeId}`,
    instance_id: instanceId,
    assignment_type: 'user',
    assignee_id: assigneeId,
    source_step: 0,
    is_active: true,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
  })
}

describe('approval bridge routes', () => {
  beforeEach(() => {
    routeState.reset()
  })

  it('syncs PLM approvals on unified list reads', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals?sourceSystem=plm&status=pending')
      .expect(200)

    expect(plmAdapter.getApprovals).toHaveBeenCalledWith({
      status: 'pending',
      productId: undefined,
      requesterId: undefined,
      limit: 50,
      offset: 0,
    })
    expect(routeState.state.instances.has('plm:eco-1')).toBe(true)
    expect(routeState.state.instances.get('plm:eco-1')?.metadata.source_version).toBe(7)
    expect(response.body.total).toBe(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'plm:eco-1',
      sourceSystem: 'plm',
      externalApprovalId: 'eco-1',
      workflowKey: 'plm-eco-review',
      businessKey: 'plm:product:prod-1',
      status: 'pending',
      assignments: [
        {
          type: 'source_queue',
          assigneeId: 'plm:source-owned',
          sourceStep: 0,
          isActive: true,
        },
      ],
    })
  })

  it('syncs enough PLM pages to satisfy later paginated unified list reads', async () => {
    routeState.plmApprovals.push({
      id: 'eco-2',
      request_type: 'eco',
      title: 'ECO-2',
      requester_id: 'user-2',
      requester_name: 'Bob',
      status: 'pending',
      version: 3,
      created_at: '2026-04-04T00:01:00.000Z',
      updated_at: '2026-04-04T00:06:00.000Z',
      product_id: 'prod-2',
      product_number: 'PN-2',
      product_name: 'Drive Shaft',
    })

    const plmAdapter = createPlmAdapterMock()
    pinned.setApp(createApp(plmAdapter))
    const response = await request(pinned.url())
      .get('/api/approvals?sourceSystem=plm&limit=1&offset=1')
      .expect(200)

    expect(plmAdapter.getApprovals).toHaveBeenNthCalledWith(1, {
      status: undefined,
      productId: undefined,
      requesterId: undefined,
      limit: 50,
      offset: 0,
    })
    expect(response.body.total).toBe(2)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'plm:eco-1',
      externalApprovalId: 'eco-1',
    })
  })

  it('lists platform approvals without requiring a configured PLM bridge', async () => {
    routeState.state.assignments.set('local-1:user-1', {
      id: 'assign-1',
      instance_id: 'local-1',
      assignment_type: 'user',
      assignee_id: 'user-1',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: new Date('2026-04-04T08:00:00.000Z'),
      updated_at: new Date('2026-04-04T08:00:00.000Z'),
    })

    pinned.setApp(createApp())
    const response = await request(pinned.url())
      .get('/api/approvals?assignee=user-1')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-1')
  })

  it('clamps oversized unified list limits before syncing PLM approvals', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    pinned.setApp(app)
    await request(pinned.url())
      .get('/api/approvals?sourceSystem=plm&limit=999')
      .expect(200)

    expect(plmAdapter.getApprovals).toHaveBeenCalledWith({
      status: undefined,
      productId: undefined,
      requesterId: undefined,
      limit: 50,
      offset: 0,
    })
  })

  it('skips PLM sync work when the requested unified list limit is zero', async () => {
    const plmAdapter = createPlmAdapterMock()
    pinned.setApp(createApp(plmAdapter))
    const response = await request(pinned.url())
      .get('/api/approvals?sourceSystem=plm&limit=0')
      .expect(200)

    expect(plmAdapter.getApprovals).not.toHaveBeenCalled()
    expect(response.body.total).toBe(0)
    expect(response.body.data).toEqual([])
  })

  it('rejects PLM assignee filtering in phase 1', async () => {
    const app = createApp(createPlmAdapterMock())

    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals?sourceSystem=plm&assignee=me')
      .expect(400)

    expect(response.body.error.code).toBe('ASSIGNEE_FILTER_UNSUPPORTED')
  })

  it('returns a controlled unavailable response when the PLM adapter is not connected', async () => {
    const plmAdapter = createPlmAdapterMock()
    plmAdapter.getApprovals.mockRejectedValueOnce(new Error('HTTP client not initialized'))

    pinned.setApp(createApp(plmAdapter))
    const response = await request(pinned.url())
      .get('/api/approvals?sourceSystem=plm')
      .expect(503)

    expect(response.body.error.code).toBe('PLM_APPROVAL_BRIDGE_UNAVAILABLE')
  })

  // RE-PINNED (P0-A). This test used to prove that a tab-less list read returns a platform row the
  // caller has no relationship to — which is exactly the behaviour being removed: the scope is now
  // decided server-side and a tab-less request is served the default (`pending`) tab. Its SUBJECT is
  // unchanged and still worth pinning: the platform feed answers without a PLM adapter attached, and
  // returns platform rows rather than 503ing on the missing bridge. What changed is the fixture —
  // `local-1` now carries the mocked identity's own active seat, so the row is reachable on the
  // default tab.
  it('lists platform approvals without requiring a PLM adapter', async () => {
    seedActorSeatForDefaultTab('local-1')
    pinned.setApp(createApp())
    const response = await request(pinned.url())
      .get('/api/approvals')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'local-1',
      sourceSystem: 'platform',
    })
  })

  // ---------------------------------------------------------------------------
  // P0-A (A15): `viewerRoles` is TWO queries (`users`, then `user_roles LEFT JOIN roles`), and both
  // list surfaces now depend on two tables they did not previously read. `viewerRolesFailClosed`
  // wraps that call so a lookup failure NARROWS the role-typed arms instead of answering 500.
  // ---------------------------------------------------------------------------
  it('P0-A: a failing viewer-role lookup denies the role arms instead of failing the list', async () => {
    // CONTROL FIRST, on the same fixture: with the lookups healthy the list answers 200 and the
    // role parameter carries the (empty ⇒ sentinel) DB-derived set. Establishes that the 200 below
    // is not "this request would have been 200 anyway for some unrelated reason".
    seedActorSeatForDefaultTab('local-1')
    pinned.setApp(createApp())
    await request(pinned.url()).get('/api/approvals').expect(200)

    routeState.pool.query.mockClear()
    routeState.state.failViewerRoles = true

    // BOTH halves are asserted, because either alone is weak: a status check alone cannot tell a
    // fail-closed 200 from a `degraded` fallback rendering as 200, and a parameter check alone
    // cannot tell the request completed.
    const listResponse = await request(pinned.url()).get('/api/approvals').expect(200)
    expect(listResponse.body.degraded).toBeUndefined()

    // The list page query's own SQL names the roles placeholder inside the scope condition's seat
    // arm. Read the number out of the SQL TEXT and check what was bound at that position, so the
    // assertion follows the shipped condition rather than a hand-counted offset.
    const listCall = routeState.pool.query.mock.calls.find(([sql]) => (
      String(sql).includes('SELECT * FROM approval_instances')
      && String(sql).includes('scope_seat.assignee_id = ANY($')
    ))
    expect(listCall, 'the list page query must have been issued').toBeTruthy()
    const rolesPlaceholder = String(listCall![0]).match(/scope_seat\.assignee_id = ANY\(\$(\d+)::text\[\]\)/)
    expect(rolesPlaceholder, 'the scope condition must bind a roles parameter').toBeTruthy()
    expect((listCall![1] as unknown[])[Number(rolesPlaceholder![1]) - 1])
      .toEqual([APPROVAL_LIST_SCOPE_NO_MATCH])

    // The SAME property on the other list-shaped read of this router, whose scope condition binds
    // the roles array at $2.
    routeState.pool.query.mockClear()
    const pendingResponse = await request(pinned.url()).get('/api/approvals/pending').expect(200)
    expect(pendingResponse.body.degraded).toBeUndefined()
    const pendingCall = routeState.pool.query.mock.calls.find(([sql]) => (
      String(sql).includes('SELECT approval_instances.* FROM approval_instances')
    ))
    expect(pendingCall, 'the pending page query must have been issued').toBeTruthy()
    expect((pendingCall![1] as unknown[])[1]).toEqual([APPROVAL_LIST_SCOPE_NO_MATCH])
  })

  // ---------------------------------------------------------------------------
  // P0-A (A19): ABSENT TAB ⇒ PENDING SEMANTICS UNLESS A STATUS FILTER IS GIVEN. The tab default is
  // what closes the tab-less family, but `pending` carries its own `status = 'pending'` conjunct,
  // so a tab-less request that also named `status=approved` reached the query with a contradictory
  // status pair and answered an empty page — the caller's OWN approved rows included. The default
  // tab is therefore not applied when the request supplies a status filter of its own.
  //
  // NO-DB GATE, on the emitted SQL rather than on rows, because this fake pool does not interpret
  // the scope condition (see the query mock's own note): the property under test is which
  // CONJUNCTS the statement carries. The real-PostgreSQL gate is test (6b) in
  // tests/integration/approval-list-scope-server-side.db.test.ts.
  // ---------------------------------------------------------------------------
  it('P0-A (A19): an absent tab plus a status filter drops the default tab conjunct and keeps the scope', async () => {
    routeState.state.instances.set('local-approved', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-approved',
      status: 'approved',
    })
    seedActorSeatForDefaultTab('local-1')
    pinned.setApp(createApp())

    const listPageSql = (): string => {
      const call = routeState.pool.query.mock.calls.find(([sql]) => (
        String(sql).includes('SELECT * FROM approval_instances')
      ))
      expect(call, 'the list page query must have been issued').toBeTruthy()
      return String(call![0]).replace(/\s+/g, ' ')
    }

    // (a) TAB-LESS + STATUS: no tab conjunct at all — neither the `pending` tab's literal status
    // condition nor its ACTIVE-seat subquery — but the caller's own status filter is bound and THE
    // SCOPE IS STILL THERE. That last assertion is the one that keeps this a filter change: the
    // scope condition is conjoined by `listApprovals` independently of `tab`, so dropping the tab
    // must not drop it.
    routeState.pool.query.mockClear()
    const withStatus = await request(pinned.url()).get('/api/approvals?status=approved').expect(200)
    const withStatusSql = listPageSql()
    expect(withStatusSql).not.toContain("status = 'pending'")
    expect(withStatusSql).not.toContain('SELECT instance_id FROM approval_assignments')
    expect(withStatusSql).toContain('scope_seat.assignee_id = ANY($')
    expect(withStatusSql).toMatch(/status = \$\d+/)
    expect(withStatus.body.data.map((row: { id: string }) => row.id)).toEqual(['local-approved'])

    // (b) POSITIVE CONTROL — the same request WITHOUT a status filter still gets the default tab,
    // so (a) is the status filter suppressing it and not the tab default having been removed.
    routeState.pool.query.mockClear()
    const tabless = await request(pinned.url()).get('/api/approvals').expect(200)
    const tablessSql = listPageSql()
    expect(tablessSql).toContain("status = 'pending'")
    expect(tablessSql).toContain('SELECT instance_id FROM approval_assignments')
    expect(tabless.body.data.map((row: { id: string }) => row.id)).toEqual(['local-1'])

    // (c) AN EMPTY `status=` IS ABSENT, NOT A FILTER — `listApprovals` pushes its status conjunct
    // under a truthiness check, so suppressing the default tab on an empty value would widen a
    // cleared chip's request while adding no filter in its place.
    routeState.pool.query.mockClear()
    await request(pinned.url()).get('/api/approvals?status=').expect(200)
    expect(listPageSql()).toContain("status = 'pending'")

    // (d) AN EXPLICIT TAB IS NEVER SUPPRESSED: both conditions survive, which is the merge-base
    // semantics for a caller that named both halves itself.
    routeState.pool.query.mockClear()
    const explicit = await request(pinned.url()).get('/api/approvals?tab=pending&status=approved').expect(200)
    const explicitSql = listPageSql()
    expect(explicitSql).toContain("status = 'pending'")
    expect(explicitSql).toMatch(/status = \$\d+/)
    expect(explicitSql).toContain('SELECT instance_id FROM approval_assignments')
    expect(explicit.body.data).toEqual([])
  })

  it('filters non-PLM approvals by active assignee assignments', async () => {
    const local = routeState.state.instances.get('local-1')!
    routeState.state.instances.set('local-2', {
      ...local,
      id: 'local-2',
      title: 'Assigned approval',
      updated_at: new Date('2026-04-04T09:00:00.000Z'),
    })

    routeState.state.assignments.set('local-1:user-1', {
      id: 'assign-1',
      instance_id: 'local-1',
      assignment_type: 'user',
      assignee_id: 'user-1',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: new Date('2026-04-04T08:00:00.000Z'),
      updated_at: new Date('2026-04-04T08:00:00.000Z'),
    })
    routeState.state.assignments.set('local-2:user-2', {
      id: 'assign-2',
      instance_id: 'local-2',
      assignment_type: 'user',
      assignee_id: 'user-2',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: new Date('2026-04-04T09:00:00.000Z'),
      updated_at: new Date('2026-04-04T09:00:00.000Z'),
    })

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals?assignee=user-2')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'local-2',
      title: 'Assigned approval',
      assignments: [
        {
          type: 'user',
          assigneeId: 'user-2',
          isActive: true,
        },
      ],
    })
  })

  it('refreshes PLM details on demand', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals/plm:eco-1')
      .expect(200)

    expect(plmAdapter.getApprovalById).toHaveBeenCalledWith('eco-1')
    expect(response.body).toMatchObject({
      id: 'plm:eco-1',
      sourceSystem: 'plm',
      title: 'ECO-1',
      status: 'pending',
    })
  })

  it('maps PLM history to unified history DTOs', async () => {
    const app = createApp(createPlmAdapterMock())

    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals/plm:eco-1/history?page=1&pageSize=1')
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      data: {
        page: 1,
        pageSize: 1,
        total: 1,
      },
    })
    expect(response.body.data.items[0]).toMatchObject({
      id: 'hist-1',
      action: 'approve',
      actorId: 'reviewer-1',
      toStatus: 'approved',
      comment: 'LGTM',
    })
  })

  it('paginates PLM history through the canonical history route', async () => {
    routeState.plmHistory.push({
      id: 'hist-2',
      eco_id: 'eco-1',
      stage_id: 'approval',
      approval_type: 'mandatory',
      required_role: 'manager',
      user_id: 'reviewer-2',
      status: 'rejected',
      comment: 'needs changes',
      approved_at: '2026-04-04T00:11:00.000Z',
      created_at: '2026-04-04T00:11:00.000Z',
    })

    pinned.setApp(createApp(createPlmAdapterMock()))
    const response = await request(pinned.url())
      .get('/api/approvals/plm:eco-1/history?page=2&pageSize=1')
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      data: {
        page: 2,
        pageSize: 1,
        total: 2,
      },
    })
    expect(response.body.data.items).toHaveLength(1)
    expect(response.body.data.items[0].id).toBe('hist-1')
  })

  it('returns null occurredAt when PLM history has no timestamps', async () => {
    routeState.plmHistory[0].approved_at = null
    routeState.plmHistory[0].created_at = null
    const app = createApp(createPlmAdapterMock())

    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals/plm:eco-1/history')
      .expect(200)

    expect(response.body.data.items[0].occurredAt).toBeNull()
  })

  it('requires a reject comment on unified actions', async () => {
    const app = createApp(createPlmAdapterMock())

    pinned.setApp(app)
    const response = await request(pinned.url())
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'reject' })
      .expect(400)

    expect(response.body.error.code).toBe('REJECT_COMMENT_REQUIRED')
  })

  it('dispatches PLM approve actions and writes local audit state', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    pinned.setApp(app)
    const response = await request(pinned.url())
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(200)

    expect(plmAdapter.approveApproval).toHaveBeenCalledWith('eco-1', 7, 'Ship it')
    expect(response.body).toMatchObject({
      id: 'plm:eco-1',
      status: 'approved',
    })

    const mirrored = routeState.state.instances.get('plm:eco-1')
    expect(mirrored?.status).toBe('approved')
    expect(routeState.state.records).toHaveLength(1)
    expect(routeState.state.records[0]).toMatchObject({
      instance_id: 'plm:eco-1',
      action: 'approve',
      to_status: 'approved',
    })
    expect(mirrored?.version).toBe(1)
    expect(Array.from(routeState.state.assignments.values())[0]?.is_active).toBe(false)
  })

  it('fails PLM actions when the source version remains unavailable', async () => {
    routeState.state.instances.set('plm:legacy', {
      ...routeState.state.instances.get('local-1')!,
      id: 'plm:legacy',
      source_system: 'plm',
      external_approval_id: 'legacy',
      workflow_key: 'plm-eco-review',
      business_key: 'plm:approval:legacy',
      title: 'Legacy PLM approval',
      metadata: {},
    })

    const plmAdapter = createPlmAdapterMock()
    plmAdapter.getApprovalById.mockResolvedValueOnce({
      data: [],
      error: new Error('refresh failed'),
    })

    pinned.setApp(createApp(plmAdapter))
    const response = await request(pinned.url())
      .post('/api/approvals/plm:legacy/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(502)

    expect(plmAdapter.approveApproval).not.toHaveBeenCalled()
    expect(response.body).toMatchObject({
      error: {
        code: 'SOURCE_ACTION_FAILED',
        message: 'PLM source version is unavailable',
      },
    })
  })

  it('keeps merged PLM history sorting deterministic when upstream timestamps are invalid', async () => {
    routeState.plmHistory[0].approved_at = 'not-a-date'
    routeState.plmHistory[0].created_at = 'still-not-a-date'

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(200)

    const response = await request(pinned.url())
      .get('/api/approvals/plm:eco-1/history')
      .expect(200)

    expect(response.body.data.items[0]).toMatchObject({
      action: 'approve',
      actorId: 'test-user',
      comment: 'Ship it',
    })
    expect(response.body.data.items[1].id).toBe('hist-1')
  })

  it('merges local audit records into PLM history responses', async () => {
    const app = createApp(createPlmAdapterMock())

    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(200)

    const history = await request(pinned.url())
      .get('/api/approvals/plm:eco-1/history')
      .expect(200)

    expect(history.body.data.total).toBe(2)
    expect(history.body.data.items[0]).toMatchObject({
      action: 'approve',
      actorId: 'test-user',
      comment: 'Ship it',
      metadata: {
        sourceSystem: 'plm',
      },
    })
  })

  it('returns structured errors when PLM history fetch fails', async () => {
    const plmAdapter = createPlmAdapterMock()
    plmAdapter.getApprovalHistory.mockResolvedValueOnce({
      data: [],
      error: new Error('upstream boom'),
    })

    pinned.setApp(createApp(plmAdapter))
    const response = await request(pinned.url())
      .get('/api/approvals/plm:eco-1/history')
      .expect(502)

    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'SOURCE_ACTION_FAILED',
        message: 'Failed to fetch PLM approval history',
      },
    })
    expect(String(response.body.error.details.upstream)).toContain('upstream boom')
  })

  it('filters non-PLM approvals by active assignee from approval_assignments', async () => {
    const now = new Date('2026-04-04T08:00:00.000Z')
    // Add a second platform instance that should NOT be returned
    routeState.state.instances.set('local-2', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-2',
      title: 'Local approval 2',
    })

    // Assign local-1 to user-assignee (active)
    routeState.state.assignments.set('local-1:source_queue:user-assignee:0', {
      id: 'assign-a1',
      instance_id: 'local-1',
      assignment_type: 'source_queue',
      assignee_id: 'user-assignee',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: now,
      updated_at: now,
    })

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals?assignee=user-assignee')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-1')
  })

  it('lets source-queue approvals match the actor permission set for the pending tab', async () => {
    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    await request(pinned.url())
      .get('/api/approvals?tab=pending&sourceSystem=platform')
      .expect(200)

    const listCall = routeState.pool.query.mock.calls.find(([sql]) => (
      String(sql).includes('SELECT * FROM approval_instances')
      && String(sql).includes("assignment_type = 'source_queue'")
    ))
    expect(listCall).toBeTruthy()
    expect(listCall?.[1]).toContainEqual(['*:*', 'attendance:approve'])
  })

  it('keeps legacy pending approvals scoped to platform-owned rows', async () => {
    routeState.state.instances.set('plm:eco-1', {
      ...routeState.state.instances.get('local-1')!,
      id: 'plm:eco-1',
      source_system: 'plm',
      external_approval_id: 'eco-1',
      workflow_key: 'plm-eco-review',
      business_key: 'plm:product:prod-1',
      title: 'ECO-1',
    })

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals/pending').expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-1')
  })

  // ---------------------------------------------------------------------------
  // B3-01 (我已处理 5th tab): reverse lookup on approval_records.actor_id — every instance the
  // actor recorded ANY action on, regardless of the instance's CURRENT status. This is deliberately
  // NOT the same predicate as `completed` (which requires `status <> 'pending'`).
  // ---------------------------------------------------------------------------
  it('B3-01: tab=processed reverse-looks-up every instance the actor acted on, regardless of current status', async () => {
    const now = new Date('2026-04-04T08:00:00.000Z')
    // local-1 (default, pending, no approval_records row) stays OUT — the actor never acted on it.
    routeState.state.instances.set('local-2', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-2',
      status: 'approved',
      title: 'Approved by the actor',
    })
    routeState.state.instances.set('local-3', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-3',
      status: 'pending',
      title: 'Still pending after the actor transferred it away',
    })
    routeState.state.instances.set('local-4', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-4',
      status: 'approved',
      title: 'Approved by someone else entirely',
    })
    routeState.state.records.push(
      {
        id: 1,
        instance_id: 'local-2',
        action: 'approve',
        actor_id: 'test-user',
        actor_name: 'Test User',
        comment: null,
        reason: null,
        from_status: 'pending',
        to_status: 'approved',
        from_version: 0,
        to_version: 1,
        metadata: {},
        occurred_at: now,
        created_at: now,
      },
      {
        id: 2,
        instance_id: 'local-3',
        action: 'transfer',
        actor_id: 'test-user',
        actor_name: 'Test User',
        comment: null,
        reason: null,
        from_status: 'pending',
        to_status: 'pending',
        from_version: 0,
        to_version: 1,
        metadata: {},
        occurred_at: now,
        created_at: now,
      },
      {
        id: 3,
        instance_id: 'local-4',
        action: 'approve',
        actor_id: 'someone-else',
        actor_name: 'Someone Else',
        comment: null,
        reason: null,
        from_status: 'pending',
        to_status: 'approved',
        from_version: 0,
        to_version: 1,
        metadata: {},
        occurred_at: now,
        created_at: now,
      },
    )

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals?tab=processed').expect(200)

    expect(response.body.total).toBe(2)
    expect(response.body.data.map((row: { id: string }) => row.id).sort()).toEqual(['local-2', 'local-3'])

    // SECURITY: the reverse lookup is scoped to the AUTHENTICATED actor (req.user) only — a
    // request-supplied actorId/userId param must not re-target it to another user's history.
    // Same authenticated test-user, hostile params claiming someone-else: the result set is
    // byte-identical to the un-parameterized call above; someone-else's local-4 never leaks.
    const overrideAttempt = await request(pinned.url())
      .get('/api/approvals?tab=processed&actorId=someone-else&userId=someone-else')
      .expect(200)
    expect(overrideAttempt.body.total).toBe(2)
    expect(overrideAttempt.body.data.map((row: { id: string }) => row.id).sort()).toEqual(['local-2', 'local-3'])
    expect(overrideAttempt.body.data.map((row: { id: string }) => row.id)).not.toContain('local-4')
  })

  // ---------------------------------------------------------------------------
  // B3-02 (行级未读): isRead resolves ONLY on the pending tab, mirroring the pending-count badge's
  // own unread predicate exactly — a row is unread iff the actor has no approval_reads row for it.
  // ---------------------------------------------------------------------------
  it('B3-02: pending tab resolves isRead per row from approval_reads; other tabs leave it unset', async () => {
    const now = new Date('2026-04-04T08:00:00.000Z')
    routeState.state.assignments.set('local-1:user:test-user:0', {
      id: 'assign-read-1',
      instance_id: 'local-1',
      assignment_type: 'user',
      assignee_id: 'test-user',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: now,
      updated_at: now,
    })
    routeState.state.instances.set('local-2', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-2',
      title: 'Second pending row',
    })
    routeState.state.assignments.set('local-2:user:test-user:0', {
      id: 'assign-read-2',
      instance_id: 'local-2',
      assignment_type: 'user',
      assignee_id: 'test-user',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: now,
      updated_at: now,
    })
    // Only local-1 has an approval_reads row FOR THE ACTOR — local-2 stays unread. someone-else's
    // own read of local-2 must NOT mark it read for test-user (the predicate is per-user:
    // user_id = actor AND instance_id match, never instance-wide).
    routeState.state.reads.add('test-user local-1')
    routeState.state.reads.add('someone-else local-2')

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const pendingResponse = await request(pinned.url()).get('/api/approvals?tab=pending').expect(200)
    const byId = new Map(pendingResponse.body.data.map((row: { id: string }) => [row.id, row]))
    expect((byId.get('local-1') as { isRead?: boolean } | undefined)?.isRead).toBe(true)
    expect((byId.get('local-2') as { isRead?: boolean } | undefined)?.isRead).toBe(false)

    // Scoping: a non-pending tab never sets isRead — undefined (omitted key), never a guessed value.
    const mineResponse = await request(pinned.url()).get('/api/approvals?tab=mine').expect(200)
    for (const row of mineResponse.body.data as Array<{ isRead?: boolean }>) {
      expect(row.isRead).toBeUndefined()
    }
  })

  // ---------------------------------------------------------------------------
  // B3-03 (模板/时间筛选): templateId + createdFrom/createdTo — additive filters on GET /api/approvals.
  // ---------------------------------------------------------------------------
  it('B3-03: filters the list by templateId', async () => {
    routeState.state.instances.set('local-2', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-2',
      template_id: 'tpl-a',
    })
    routeState.state.instances.set('local-3', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-3',
      template_id: 'tpl-b',
    })
    // RE-PINNED (P0-A): a tab-less read is now served the default (`pending`) tab, so BOTH
    // candidate rows get the mocked identity's seat — `local-3` must be excluded by the
    // `templateId` filter, which is this test's subject, and not by the scope or the tab.
    seedActorSeatForDefaultTab('local-2')
    seedActorSeatForDefaultTab('local-3')

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals?templateId=tpl-a').expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-2')
  })

  it('B3-03: filters the list by a createdFrom/createdTo window', async () => {
    // Default local-1 created_at (2026-04-04T08:00:00.000Z) sits BEFORE the window below.
    routeState.state.instances.set('local-2', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-2',
      created_at: new Date('2026-06-01T00:00:00.000Z'),
    })
    routeState.state.instances.set('local-3', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-3',
      created_at: new Date('2026-08-01T00:00:00.000Z'),
    })
    // RE-PINNED (P0-A): same reason as the templateId test above — all three rows carry the mocked
    // identity's seat so the created-at window is the only thing that can exclude `local-1` and
    // `local-3`.
    seedActorSeatForDefaultTab('local-1')
    seedActorSeatForDefaultTab('local-2')
    seedActorSeatForDefaultTab('local-3')

    const app = createApp(createPlmAdapterMock())
    pinned.setApp(app)
    const response = await request(pinned.url())
      .get('/api/approvals?createdFrom=2026-05-01T00:00:00Z&createdTo=2026-06-30T23:59:59Z')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-2')
  })

  it('B3-03: rejects a malformed createdFrom/createdTo with 400', async () => {
    const app = createApp(createPlmAdapterMock())

    pinned.setApp(app)
    const badFrom = await request(pinned.url()).get('/api/approvals?createdFrom=not-a-date').expect(400)
    expect(badFrom.body.error.code).toBe('APPROVAL_DATE_FILTER_INVALID')

    const badTo = await request(pinned.url()).get('/api/approvals?createdTo=also-not-a-date').expect(400)
    expect(badTo.body.error.code).toBe('APPROVAL_DATE_FILTER_INVALID')
  })
})
