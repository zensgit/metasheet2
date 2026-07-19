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
  type DownloadAuthChecks,
  type ResolvedApprovalAttachmentStore,
} from './approval-attachment-storage'
import { isApprovalAttachmentsEnabled } from '../routes/approval-attachments'
import type { FormSchema } from '../types/approval-product'

const logger = new Logger('ApprovalAttachmentRuntime')

export function isApprovalAttachmentsEnabledEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return isApprovalAttachmentsEnabled(env)
}

/** Shared participant predicate used by download auth (mirrors approval-metrics ACL shape). */
export async function isApprovalInstanceParticipant(
  db: Queryable,
  viewerId: string,
  instanceId: string,
  actorRoles: readonly string[] = [],
): Promise<boolean> {
  const roles = actorRoles.length > 0 ? [...actorRoles] : ['__none__']
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
      )
    ) AS exists`,
    [instanceId, viewerId, roles],
  )
  return Boolean(rows[0]?.exists)
}

/**
 * Production download-auth checks: participant predicate + active-node hidden set via the SAME
 * `collectHiddenFieldIds` the snapshot redaction uses (G7 — no drift).
 */
export function createDownloadAuthChecks(
  db: Queryable,
  resolveViewerRoles: (viewerId: string) => Promise<readonly string[]> = async () => [],
): DownloadAuthChecks {
  return {
    async isInstanceParticipant(viewerId, instanceId) {
      const roles = await resolveViewerRoles(viewerId)
      return isApprovalInstanceParticipant(db, viewerId, instanceId, roles)
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

/** Is `fieldId` an attachment-typed field on the template's (published/latest) form schema? */
export async function resolveTemplateAttachmentField(
  db: Queryable,
  templateId: string,
  fieldId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT v.form_schema
       FROM approval_templates t
       JOIN approval_template_versions v ON v.template_id = t.id
       LEFT JOIN approval_published_definitions pd
         ON pd.template_id = t.id AND pd.is_active = TRUE
      WHERE t.id = $1
      ORDER BY CASE WHEN pd.template_version_id = v.id THEN 0 ELSE 1 END, v.version DESC
      LIMIT 1`,
    [templateId],
  )
  if (rows.length === 0) return false
  const schema = rows[0].form_schema as FormSchema | null
  const fields = schema?.fields
  if (!Array.isArray(fields)) return false
  const field = fields.find((f) => f && typeof f === 'object' && (f as { id?: string }).id === fieldId)
  return Boolean(field && (field as { type?: string }).type === 'attachment')
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
