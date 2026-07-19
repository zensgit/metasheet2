/**
 * Approval attachments — production runtime wiring (boot slice).
 *
 *   - Shared participant predicate + `collectHiddenFieldIds` download auth (G6/G7)
 *   - Flag-gated lifecycle workers: unbound TTL sweep, purge-intent drain, prefix-scoped reconciler
 *   - Shutdown cleanup via returned stop handle
 *   - Create-time helpers: extract attachment id arrays from form data for same-txn bind
 *
 * All of this is a no-op while `APPROVAL_ATTACHMENTS_ENABLED` is OFF (default).
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { Logger } from '../core/logger'
import {
  collectActiveNodeKeys,
  collectHiddenFieldIds,
  type RedactableRuntimeGraph,
} from './approval-form-redaction'
import {
  drainPurgeIntents,
  sweepUnboundAttachments,
  UNBOUND_ATTACHMENT_TTL_HOURS,
} from './approval-attachment-gc'
import { reconcileBucket, type ReconcilerBlob } from './approval-attachment-reconciler'
import {
  resolveApprovalAttachmentStore,
  type ApprovalAttachmentStore,
  type ApprovalAttachmentStoreListable,
  type AttachmentViewerContext,
  type DownloadAuthChecks,
  type ResolvedApprovalAttachmentStore,
} from './approval-attachment-storage'
import { isApprovalAttachmentsEnabled } from '../routes/approval-attachments'
import type { FormSchema } from '../types/approval-product'

const logger = new Logger('ApprovalAttachmentRuntime')

export function isApprovalAttachmentsEnabledEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return isApprovalAttachmentsEnabled(env)
}

/**
 * Shared participant predicate for download auth (§4.2 gate 1).
 *
 * Recognizes: requester, user assignee, role assignee (viewer.roles), historical actor,
 * CC user (approval_records.action='cc' + metadata.targetType/targetId — actor_id is 'system'),
 * CC role, and admin (participation bypass only — caller still runs hidden-field gate).
 */
export async function isApprovalInstanceParticipant(
  db: Queryable,
  viewer: AttachmentViewerContext | string,
  instanceId: string,
  actorRoles: readonly string[] = [],
): Promise<boolean> {
  const ctx: AttachmentViewerContext =
    typeof viewer === 'string' ? { id: viewer, roles: actorRoles, isAdmin: false } : viewer
  if (ctx.isAdmin) return true // participation bypass only

  const roles = ctx.roles.length > 0 ? [...ctx.roles] : ['__none__']
  const { rows } = await db.query(
    `SELECT EXISTS(
      SELECT 1 FROM approval_instances i
      WHERE i.id = $1 AND (
        COALESCE(i.requester_snapshot->>'id', '') = $2
        OR EXISTS(
          SELECT 1 FROM approval_assignments a
          WHERE a.instance_id = i.id
            AND (
              (a.assignment_type = 'user' AND a.assignee_id = $2)
              OR (a.assignment_type = 'role' AND a.assignee_id = ANY($3::text[]))
            )
        )
        OR EXISTS(
          SELECT 1 FROM approval_records r
          WHERE r.instance_id = i.id AND r.actor_id = $2
        )
        -- CC lives in records with actor_id='system'; the target is in metadata (user or role).
        OR EXISTS(
          SELECT 1 FROM approval_records r
          WHERE r.instance_id = i.id
            AND r.action = 'cc'
            AND (
              (COALESCE(r.metadata->>'targetType', '') = 'user' AND COALESCE(r.metadata->>'targetId', '') = $2)
              OR (COALESCE(r.metadata->>'targetType', '') = 'role' AND COALESCE(r.metadata->>'targetId', '') = ANY($3::text[]))
            )
        )
      )
    ) AS exists`,
    [instanceId, ctx.id, roles],
  )
  return Boolean(rows[0]?.exists)
}

/**
 * Production download-auth checks: participant predicate + active-node hidden set via the SAME
 * `collectHiddenFieldIds` the snapshot redaction uses (G7 — no drift). Admin participation
 * bypass is inside isApprovalInstanceParticipant; hidden still applies to admin.
 */
export function createDownloadAuthChecks(db: Queryable): DownloadAuthChecks {
  return {
    async isInstanceParticipant(viewer, instanceId) {
      return isApprovalInstanceParticipant(db, viewer, instanceId)
    },
    async isFieldHiddenAtActiveNode(instanceId, fieldId) {
      const { rows } = await db.query(
        `SELECT i.current_node_key, i.metadata, pd.runtime_graph
           FROM approval_instances i
           LEFT JOIN approval_published_definitions pd ON pd.id = i.published_definition_id
          WHERE i.id = $1`,
        [instanceId],
      )
      if (rows.length === 0) return true // fail-closed
      const row = rows[0] as {
        current_node_key: string | null
        metadata: Record<string, unknown> | null
        runtime_graph: RedactableRuntimeGraph | null
      }
      const active = collectActiveNodeKeys(row.current_node_key, row.metadata)
      const hidden = collectHiddenFieldIds(row.runtime_graph, active)
      return hidden.has(fieldId)
    },
  }
}

/**
 * Upload-target authorization result.
 *   - ok: template is visible, published, and fieldId is attachment-typed
 *   - not_found: template missing OR not visible to the actor (anti-enumeration — same shape)
 *   - not_published: template exists/visible but not published
 *   - not_attachment_field: field missing or wrong type
 */
export type UploadTargetAuth =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'not_published' | 'not_attachment_field' }

export interface UploadVisibilityActor {
  userId: string
  departmentIds?: readonly string[]
  roles?: readonly string[]
  permissions?: readonly string[]
  /** template managers bypass visibility scope — MUST match createApproval's isTemplateManager. */
  isTemplateManager?: boolean
}

/**
 * Authorize an upload against the SAME template visibility + published gate createApproval uses,
 * plus the attachment-field type check. An arbitrary authenticated user must NOT be able to burn
 * storage against an inaccessible template (field-existence alone is not enough).
 */
export async function authorizeUploadTarget(
  db: Queryable,
  templateId: string,
  fieldId: string,
  actor: UploadVisibilityActor,
): Promise<UploadTargetAuth> {
  // Mirror applyTemplateVisibilityFilter SQL (create path) — manager bypasses scope.
  const params: unknown[] = [templateId]
  let visibilitySql = ''
  if (!actor.isTemplateManager) {
    params.push(actor.userId)
    const userParam = params.length
    params.push(actor.departmentIds && actor.departmentIds.length > 0 ? [...actor.departmentIds] : ['__approval_template_no_dept__'])
    const deptParam = params.length
    params.push(actor.roles && actor.roles.length > 0 ? [...actor.roles] : ['__approval_template_no_role__'])
    const roleParam = params.length
    visibilitySql = `AND (
      COALESCE(t.visibility_scope->>'type', 'all') = 'all'
      OR (
        t.visibility_scope->>'type' = 'user'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS visible_ids(id)
          WHERE visible_ids.id = $${userParam}
        )
      )
      OR (
        t.visibility_scope->>'type' = 'dept'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS visible_ids(id)
          WHERE visible_ids.id = ANY($${deptParam}::text[])
        )
      )
      OR (
        t.visibility_scope->>'type' = 'role'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS visible_ids(id)
          WHERE visible_ids.id = ANY($${roleParam}::text[])
        )
      )
    )`
  }

  const { rows } = await db.query(
    `SELECT t.status AS template_status,
            v.form_schema,
            pd.id AS published_id,
            pd.is_active AS published_active
       FROM approval_templates t
       JOIN approval_template_versions v ON v.id = COALESCE(t.active_version_id, t.latest_version_id)
       LEFT JOIN approval_published_definitions pd
         ON pd.template_id = t.id AND pd.is_active = TRUE
      WHERE t.id = $1
      ${visibilitySql}
      LIMIT 1`,
    params,
  )
  if (rows.length === 0) return { ok: false, code: 'not_found' }
  const row = rows[0] as {
    template_status: string
    form_schema: FormSchema | null
    published_id: string | null
    published_active: boolean | null
  }
  if (row.template_status !== 'published' || !row.published_id || row.published_active !== true) {
    return { ok: false, code: 'not_published' }
  }
  const fields = row.form_schema?.fields
  if (!Array.isArray(fields)) return { ok: false, code: 'not_attachment_field' }
  const field = fields.find((f) => f && typeof f === 'object' && (f as { id?: string }).id === fieldId)
  if (!field || (field as { type?: string }).type !== 'attachment') {
    return { ok: false, code: 'not_attachment_field' }
  }
  return { ok: true }
}

/**
 * @deprecated Prefer authorizeUploadTarget — field existence alone is not sufficient authorization.
 * Kept as a thin wrapper for older call sites that only need the type check (tests with pre-authorized actors).
 */
export async function resolveTemplateAttachmentField(
  db: Queryable,
  templateId: string,
  fieldId: string,
): Promise<boolean> {
  const r = await authorizeUploadTarget(db, templateId, fieldId, {
    userId: '__system__',
    isTemplateManager: true, // type-check only; does not grant real users a bypass
  })
  return r.ok
}

/** Resolve frozen attachment ids for detail/tombstone rendering (§8 / G5). */
export async function resolveAttachmentSummaries(
  db: Queryable,
  ids: readonly string[],
): Promise<Array<{ id: string; fileName: string; status: 'live' | 'deleted' | 'missing'; scanState: string }>> {
  if (ids.length === 0) return []
  const { rows } = await db.query(
    `SELECT id, file_name, status, COALESCE(scan_state, 'unscanned') AS scan_state
       FROM approval_attachments WHERE id = ANY($1)`,
    [[...ids]],
  )
  const byId = new Map(
    (rows as Array<{ id: string; file_name: string; status: string; scan_state: string }>).map((r) => [r.id, r]),
  )
  return ids.map((id) => {
    const row = byId.get(id)
    if (!row) return { id, fileName: '', status: 'missing' as const, scanState: 'unscanned' }
    if (row.status === 'deleted' || row.scan_state === 'infected') {
      return { id, fileName: row.file_name, status: 'deleted' as const, scanState: row.scan_state }
    }
    return { id, fileName: row.file_name, status: 'live' as const, scanState: row.scan_state }
  })
}

/**
 * Extract attachment-id arrays from submitted form data for fields declared `type: attachment`.
 * Values must already be string[] of attachment ids (server ids only — never filenames/keys).
 */
export function extractAttachmentIdsByField(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const field of formSchema.fields ?? []) {
    if (field.type !== 'attachment') continue
    const raw = formData[field.id]
    if (raw === undefined || raw === null) {
      out[field.id] = []
      continue
    }
    if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && /[!-~]/.test(id))) {
      throw new RangeError(`field ${field.id}: attachment value must be an array of attachment ids`)
    }
    out[field.id] = raw as string[]
  }
  return out
}

/** Strip attachment-typed keys (flag-OFF honest path — B2-28). */
export function stripAttachmentFormData(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
): Record<string, unknown> {
  const attachmentIds = new Set(
    (formSchema.fields ?? []).filter((f) => f.type === 'attachment').map((f) => f.id),
  )
  if (attachmentIds.size === 0) return formData
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(formData)) {
    if (!attachmentIds.has(k)) next[k] = v
  }
  return next
}

export interface ApprovalAttachmentLifecycleOptions {
  db: Queryable
  store: ApprovalAttachmentStore & Partial<ApprovalAttachmentStoreListable>
  env?: NodeJS.ProcessEnv
  /** Override intervals for tests (ms). */
  intervalMs?: number
  ttlHours?: number
  logger?: Pick<Logger, 'info' | 'warn'>
}

/**
 * Schedule unbound TTL sweep + purge-intent drain + prefix-scoped reconciler.
 * Returns a stop() that clears all timers. No-op when flag is OFF.
 */
export function startApprovalAttachmentLifecycle(
  options: ApprovalAttachmentLifecycleOptions,
): () => void {
  const env = options.env ?? process.env
  if (!isApprovalAttachmentsEnabled(env)) return () => {}

  const log = options.logger ?? logger
  const intervalMs = options.intervalMs
    ?? Math.min(Math.max(Number(env.APPROVAL_ATTACHMENT_GC_INTERVAL_MS) || 60_000, 10_000), 3_600_000)
  const ttlHours = options.ttlHours
    ?? Math.min(Math.max(Number(env.APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS) || UNBOUND_ATTACHMENT_TTL_HOURS, 1), 8760)
  const listBlobs = async (): Promise<ReconcilerBlob[]> => {
    if (typeof options.store.list === 'function') {
      return options.store.list()
    }
    return []
  }

  let stopped = false

  async function runOnce(): Promise<void> {
    if (stopped) return
    try {
      await sweepUnboundAttachments(options.db, ttlHours)
    } catch {
      log.warn('approval attachment unbound TTL sweep failed (values-free)')
    }
    try {
      await drainPurgeIntents(options.db, async (key) => options.store.delete(key), {
        onDeadLetter: () => {
          log.warn('approval attachment purge intent dead_letter (values-free)')
        },
      })
    } catch {
      log.warn('approval attachment purge drain failed (values-free)')
    }
    try {
      await reconcileBucket(options.db, listBlobs)
    } catch {
      log.warn('approval attachment reconciler failed (values-free)')
    }
  }

  void runOnce()
  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)
  timer.unref?.()
  log.info(`approval attachment lifecycle workers started (intervalMs=${intervalMs}, ttlHours=${ttlHours})`)

  return () => {
    stopped = true
    clearInterval(timer)
    log.info('approval attachment lifecycle workers stopped')
  }
}

export function resolveStoreForBoot(env: NodeJS.ProcessEnv = process.env): ResolvedApprovalAttachmentStore {
  return resolveApprovalAttachmentStore(env)
}
