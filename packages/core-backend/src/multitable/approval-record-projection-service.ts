/**
 * T3-6 — Approval data as first-class multitable records (read-model projection).
 *
 * Design-lock: docs/development/t3-6-approvals-as-multitable-records-design-lock-20260703.md
 *
 * The approval engine stays the system of record. This service materializes each approval instance
 * as ONE row in a system-managed multitable sheet so 飞书-grade reporting / dashboards / views /
 * formulas come for free over the existing multitable analytics — a one-way projection, never a
 * write-back (editing the projected record never mutates the approval).
 *
 * Load-bearing invariants (all enforced by `reconcile`, the single materialization core shared by the
 * create hook, the terminal completion-event subscription, the leader-gated sweep, and the on-demand
 * reconcile):
 *
 *  §6a EVENT-SILENT — the projected write is a direct SQL materialization on `meta_records`. It does
 *  NOT go through the automation event bus, so it emits NO `record.created`/`record.updated` and can
 *  never fire a `record.*` automation rule on the system sheet (no projection→automation loop). This
 *  is why we do not reuse `RecordService.createRecord` (which emits): the strongest event-silence
 *  guarantee is a path that never touches `eventBus`.
 *
 *  §4 IDEMPOTENT — every path re-reads the AUTHORITATIVE state from `approval_instances` (+
 *  `approval_records`) and upserts guarded by `projected_version` = `approval_instances.version`
 *  (monotonic; `transition.toVersion === instance.version` post-transition). A redelivered create/
 *  terminal event whose source version is not strictly newer is a no-op — never a duplicate row.
 *
 *  §6b DETERMINISTIC RECONCILE / never-clobber — a per-instance advisory lock serializes concurrent
 *  reconciles (the auto-approve create-hook↔completion-event race, and sweep↔live-terminal). Under the
 *  lock we re-check the stored version and write BOTH `meta_records` and the mapping row only when the
 *  source is strictly newer; a stale reconcile writes NEITHER table (so it cannot clobber a live
 *  terminal record body while the mapping refuses the version downgrade). `projected_version` /
 *  `last_projected_at` / `last_error` make a lost write observable and healable on the next sweep.
 *
 *  BEST-EFFORT — a projection failure never fails the parent approval flow (the create hook and the
 *  event subscription both swallow errors; only the observability columns record them).
 *
 *  §5 SYSTEM SHEET — one system-owned base + one sheet per template family, provisioned lazily and
 *  idempotently (ON CONFLICT) on first projection, with a fixed system-authored §3 column set. The
 *  base carries a reserved system owner and no per-sheet share is minted, so it is governed by the
 *  standard multitable capability gate (per-row visibility_scope inheritance is a separate slice).
 */

import type { PoolClient } from 'pg'

import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import type { EventBus } from '../integration/events/event-bus'
import type { ApprovalCompletionEventV1 } from '../services/ApprovalCompletionEvent'

const logger = new Logger('ApprovalRecordProjection')

/** The system-owned base that holds every per-template-family projection sheet (§5). Single source of
 *  truth lives in the side-effect-free `approval-projection-constants` (imported by the permission path);
 *  re-exported here for existing importers. */
export { APPROVAL_PROJECTION_BASE_ID } from './approval-projection-constants'
import { APPROVAL_PROJECTION_BASE_ID } from './approval-projection-constants'
/** Reserved owner/actor for the system-managed base + record rows (not a real user). */
export const APPROVAL_PROJECTION_SYSTEM_OWNER = 'system:approval-projection'

/** Terminal approval outcomes projected to the neutral read-model (Q9). */
const TERMINAL_STATUSES = new Set(['approved', 'rejected', 'revoked', 'cancelled'])

/** Approval-record actions that represent a decider (so `approverId` excludes the auto-approve create row). */
const DECISION_ACTIONS = ['approve', 'reject', 'revoke', 'sign']

/** Completion event types this service subscribes to for the terminal projection trigger. */
export const APPROVAL_COMPLETION_EVENT_TYPES = [
  'approval.approved',
  'approval.rejected',
  'approval.revoked',
  'approval.cancelled',
] as const

/**
 * The §3 allowlist — value-constrained system columns only, NEVER `form_snapshot` (a separate
 * PII-redaction review gates any form projection). Order is the sheet's field order.
 */
interface ProjectionColumn {
  key: string
  name: string
  type: 'text' | 'dateTime'
}

const PROJECTION_COLUMNS: readonly ProjectionColumn[] = [
  { key: 'requestNo', name: 'Request No', type: 'text' },
  { key: 'templateId', name: 'Template Id', type: 'text' },
  { key: 'templateName', name: 'Template Name', type: 'text' },
  { key: 'status', name: 'Status', type: 'text' },
  { key: 'outcome', name: 'Outcome', type: 'text' },
  { key: 'requesterId', name: 'Requester Id', type: 'text' },
  { key: 'approverId', name: 'Approver Id', type: 'text' },
  { key: 'createdAt', name: 'Created At', type: 'dateTime' },
  { key: 'completedAt', name: 'Completed At', type: 'dateTime' },
  { key: 'currentNodeKey', name: 'Current Node Key', type: 'text' },
]

export function deriveProjectionSheetId(templateId: string): string {
  return `sht_apr_proj_${templateId}`
}

export function deriveProjectionFieldId(sheetId: string, columnKey: string): string {
  return `${sheetId}__${columnKey}`
}

export function deriveProjectionRecordId(instanceId: string): string {
  return `rec_apr_${instanceId}`
}

export type ProjectionOutcome =
  | { status: 'projected'; version: number }
  | { status: 'noop'; version: number; storedVersion: number }
  | { status: 'absent' }
  | { status: 'skipped'; reason: 'no-pool' | 'no-template' }

interface AuthoritativeInstance {
  id: string
  status: string
  version: number
  requestNo: string | null
  templateId: string | null
  templateName: string | null
  requesterId: string | null
  currentNodeKey: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

interface TerminalDecision {
  approverId: string | null
  completedAt: Date | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNullableString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value : null
  return null
}

function toNullableDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }
  return null
}

function toIsoOrEmpty(value: Date | null): string {
  return value ? value.toISOString() : ''
}

/**
 * The projection service. All state lives in Postgres, so a fresh instance behaves identically to the
 * shared singleton (integration tests can construct their own against the same pool).
 */
export class ApprovalRecordProjectionService {
  private readonly subscriptionIds: string[] = []

  /** Subscribe the terminal projection trigger to the completion bus (best-effort per event). */
  subscribe(eventBus: EventBus): void {
    for (const eventType of APPROVAL_COMPLETION_EVENT_TYPES) {
      const id = eventBus.subscribe<ApprovalCompletionEventV1>(eventType, (payload) => {
        const instanceId = payload?.approval?.instanceId
        if (typeof instanceId !== 'string' || instanceId.length === 0) return
        this.reconcile(instanceId).catch((error) => {
          logger.warn(
            `terminal projection for ${instanceId} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      })
      this.subscriptionIds.push(id)
    }
    logger.info('ApprovalRecordProjectionService subscribed to approval completion bus')
  }

  unsubscribe(eventBus: EventBus): void {
    for (const id of this.subscriptionIds.splice(0)) eventBus.unsubscribe(id)
  }

  /**
   * Reconcile ONE instance: re-derive the §3 columns from authoritative state and idempotently upsert
   * the projected record + mapping row, guarded by `projected_version`. The single core shared by the
   * create hook, the completion-event subscription, the sweep, and the on-demand path.
   */
  async reconcile(instanceId: string): Promise<ProjectionOutcome> {
    if (!pool) return { status: 'skipped', reason: 'no-pool' }

    const instance = await this.loadAuthoritativeInstance(instanceId)
    if (!instance) return { status: 'absent' }
    if (!instance.templateId) return { status: 'skipped', reason: 'no-template' }

    const terminal = TERMINAL_STATUSES.has(instance.status)
    const decision = terminal ? await this.loadTerminalDecision(instanceId, instance.status) : null
    const sheetId = deriveProjectionSheetId(instance.templateId)
    const recordId = deriveProjectionRecordId(instanceId)
    const data = this.buildRecordData(sheetId, instance, terminal, decision)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize every reconcile for THIS instance (auto-approve create-hook↔event, sweep↔terminal).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`approval-projection:${instanceId}`])

      const existing = await client.query<{ projected_version: number }>(
        'SELECT projected_version FROM approval_record_projection WHERE instance_id = $1',
        [instanceId],
      )
      const storedVersion = existing.rows[0]?.projected_version
      if (storedVersion !== undefined && instance.version <= storedVersion) {
        // Stale/redelivered — never clobber a newer live projection (§6b). Write NEITHER table.
        await client.query('COMMIT')
        return { status: 'noop', version: instance.version, storedVersion }
      }

      // Provision base→sheet→fields (idempotent) BEFORE the record upsert so the meta_records→meta_sheets
      // FK is satisfied even for a concurrent first-projection of a brand-new template family.
      await this.ensureSystemBase(client)
      await this.ensureFamilySheet(client, sheetId, instance.templateId, instance.templateName)

      // revision-exempt: derived projection into the system approval base; regenerable by sweep/reconcile;
      // authoritative history lives in the approval domain (approval_instances), not here (audit §2/§4).
      await client.query(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
         VALUES ($1, $2, $3::jsonb, 1, $4, $4)
         ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data,
               version = meta_records.version + 1,
               modified_by = EXCLUDED.modified_by,
               updated_at = now()`,
        [recordId, sheetId, JSON.stringify(data), APPROVAL_PROJECTION_SYSTEM_OWNER],
      )

      await client.query(
        `INSERT INTO approval_record_projection
           (instance_id, base_id, sheet_id, record_id, projected_version, last_projected_at, last_error)
         VALUES ($1, $2, $3, $4, $5, now(), NULL)
         ON CONFLICT (instance_id) DO UPDATE
           SET base_id = EXCLUDED.base_id,
               sheet_id = EXCLUDED.sheet_id,
               record_id = EXCLUDED.record_id,
               projected_version = EXCLUDED.projected_version,
               last_projected_at = now(),
               last_error = NULL`,
        [instanceId, APPROVAL_PROJECTION_BASE_ID, sheetId, recordId, instance.version],
      )

      await client.query('COMMIT')
      return { status: 'projected', version: instance.version }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      await this.recordLastError(instanceId, error)
      throw error
    } finally {
      client.release()
    }
  }

  /** On-demand: reconcile every instance of a template family (best-effort per instance). */
  async reconcileTemplateFamily(templateId: string): Promise<{ scanned: number; reconciled: number }> {
    if (!pool) return { scanned: 0, reconciled: 0 }
    const rows = await pool.query<{ id: string }>(
      'SELECT id FROM approval_instances WHERE template_id = $1 ORDER BY updated_at ASC',
      [templateId],
    )
    return this.reconcileEach(rows.rows.map((row) => row.id))
  }

  /**
   * Leader-gated sweep: find instances whose authoritative version is ahead of their projection (or
   * that have no mapping row at all — a lost create write) and reconcile them. Bounded by `limit`.
   */
  async sweep(options: { limit?: number } = {}): Promise<{ scanned: number; reconciled: number }> {
    if (!pool) return { scanned: 0, reconciled: 0 }
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
    const rows = await pool.query<{ id: string }>(
      `SELECT i.id
         FROM approval_instances i
         LEFT JOIN approval_record_projection pr ON pr.instance_id = i.id
        WHERE i.template_id IS NOT NULL
          AND (pr.instance_id IS NULL OR i.version > pr.projected_version)
        ORDER BY i.updated_at ASC
        LIMIT $1`,
      [limit],
    )
    return this.reconcileEach(rows.rows.map((row) => row.id))
  }

  private async reconcileEach(instanceIds: string[]): Promise<{ scanned: number; reconciled: number }> {
    let reconciled = 0
    for (const instanceId of instanceIds) {
      try {
        const outcome = await this.reconcile(instanceId)
        if (outcome.status === 'projected') reconciled += 1
      } catch (error) {
        logger.warn(
          `sweep/reconcile for ${instanceId} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { scanned: instanceIds.length, reconciled }
  }

  private async loadAuthoritativeInstance(instanceId: string): Promise<AuthoritativeInstance | null> {
    if (!pool) return null
    const result = await pool.query<Record<string, unknown>>(
      `SELECT i.id, i.status, i.version, i.request_no, i.template_id, i.current_node_key,
              i.requester_snapshot, i.created_at, i.updated_at, t.name AS template_name
         FROM approval_instances i
         LEFT JOIN approval_templates t ON t.id = i.template_id
        WHERE i.id = $1`,
      [instanceId],
    )
    const row = result.rows[0]
    if (!row) return null
    const requesterSnapshot = isRecord(row.requester_snapshot) ? row.requester_snapshot : {}
    return {
      id: String(row.id),
      status: String(row.status),
      version: Number(row.version ?? 0),
      requestNo: toNullableString(row.request_no),
      templateId: toNullableString(row.template_id),
      templateName: toNullableString(row.template_name),
      requesterId: toNullableString(requesterSnapshot.id),
      currentNodeKey: toNullableString(row.current_node_key),
      createdAt: toNullableDate(row.created_at),
      updatedAt: toNullableDate(row.updated_at),
    }
  }

  /**
   * The approver + completion time of a TERMINAL instance: the most recent decider record matching the
   * terminal status. The auto-approve-at-create row is action `created` (not a decision), so it is
   * excluded — `approverId` stays null for auto-approve, matching the completion event's `actor: null`.
   */
  private async loadTerminalDecision(instanceId: string, terminalStatus: string): Promise<TerminalDecision> {
    if (!pool) return { approverId: null, completedAt: null }
    const result = await pool.query<Record<string, unknown>>(
      `SELECT actor_id, occurred_at
         FROM approval_records
        WHERE instance_id = $1
          AND action = ANY($2::text[])
          AND to_status = $3
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [instanceId, DECISION_ACTIONS, terminalStatus],
    )
    const row = result.rows[0]
    if (!row) return { approverId: null, completedAt: null }
    return {
      approverId: toNullableString(row.actor_id),
      completedAt: toNullableDate(row.occurred_at),
    }
  }

  private buildRecordData(
    sheetId: string,
    instance: AuthoritativeInstance,
    terminal: boolean,
    decision: TerminalDecision | null,
  ): Record<string, string> {
    const values: Record<string, string> = {
      requestNo: instance.requestNo ?? '',
      templateId: instance.templateId ?? '',
      templateName: instance.templateName ?? '',
      status: instance.status,
      outcome: terminal ? instance.status : '',
      requesterId: instance.requesterId ?? '',
      approverId: terminal ? (decision?.approverId ?? '') : '',
      createdAt: toIsoOrEmpty(instance.createdAt),
      completedAt: terminal ? toIsoOrEmpty(decision?.completedAt ?? instance.updatedAt) : '',
      currentNodeKey: instance.currentNodeKey ?? '',
    }
    const data: Record<string, string> = {}
    for (const column of PROJECTION_COLUMNS) {
      data[deriveProjectionFieldId(sheetId, column.key)] = values[column.key] ?? ''
    }
    return data
  }

  private async ensureSystemBase(client: PoolClient): Promise<void> {
    await client.query(
      `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
       VALUES ($1, $2, 'table', '#5b8def', $3, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [APPROVAL_PROJECTION_BASE_ID, 'Approval Records (system)', APPROVAL_PROJECTION_SYSTEM_OWNER],
    )
  }

  private async ensureFamilySheet(
    client: PoolClient,
    sheetId: string,
    templateId: string,
    templateName: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO meta_sheets (id, base_id, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        sheetId,
        APPROVAL_PROJECTION_BASE_ID,
        `Approval · ${templateName ?? templateId}`,
        'System-managed approval read-model projection (T3-6)',
      ],
    )
    for (let order = 0; order < PROJECTION_COLUMNS.length; order += 1) {
      const column = PROJECTION_COLUMNS[order]
      await client.query(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
         ON CONFLICT (id) DO NOTHING`,
        [deriveProjectionFieldId(sheetId, column.key), sheetId, column.name, column.type, order],
      )
    }
  }

  /** Best-effort observability: stamp the failure onto the mapping row when one already exists. */
  private async recordLastError(instanceId: string, error: unknown): Promise<void> {
    if (!pool) return
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    try {
      await pool.query(
        `UPDATE approval_record_projection
            SET last_error = $2, last_projected_at = now()
          WHERE instance_id = $1`,
        [instanceId, message],
      )
    } catch {
      // Observability is best-effort — never mask the original failure.
    }
  }
}

let sharedProjectionService: ApprovalRecordProjectionService | null = null

export function getApprovalRecordProjectionService(): ApprovalRecordProjectionService {
  if (!sharedProjectionService) sharedProjectionService = new ApprovalRecordProjectionService()
  return sharedProjectionService
}

/** Test seam — override or clear the shared singleton. */
export function setApprovalRecordProjectionServiceForTests(
  service: ApprovalRecordProjectionService | null,
): void {
  sharedProjectionService = service
}
