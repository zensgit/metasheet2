/**
 * Approval attachments — production runtime boot (#4195 §7/§9): flag-gated route mount + workers.
 *
 * This is the ONE wiring point that turns the inert pipeline modules (validation core, storage,
 * routes, GC/purge worker, reconciler, bind) into a running feature — everything stays a byte-level
 * no-op while `APPROVAL_ATTACHMENTS_ENABLED` is OFF (`bootApprovalAttachmentRuntime` returns null).
 *
 * Flag ON:
 *   - STORAGE (owner-DECIDED O3): production REQUIRES an S3-compatible object store; none is
 *     implemented yet (explicitly-named follow-up), so in `NODE_ENV=production` the resolution is
 *     `s3-required` — the routes mount with `storageAvailable:false` and upload/download return a
 *     values-free 503 (the ratified prod fail-close; approval blobs never land on the deploy host's
 *     local filesystem). Dev/test resolve a `LocalFsApprovalAttachmentStore` under a DEDICATED root
 *     and PROBE it (put→delete) — a failed probe THROWS, and the caller aborts startup (fail-closed
 *     boot doctrine, mirroring `durableBootFailureDisposition`: flag ON means a storage-less boot is
 *     an outage, not a degrade).
 *   - ROUTES: `authenticate` guards the `/api/approval/attachments` prefix; the DI seams are backed
 *     by the REAL predicates (participant visibility, `collectHiddenFieldIds` for the byte-path
 *     redaction gate, `applyTemplateVisibilityFilter` for the §4.1 template-access gate, template
 *     form-schema field-type resolve).
 *   - WORKERS (`startWorkers()`): GC unbound-TTL sweep + purge-intent drain + bucket reconciler on
 *     flag-gated timers (same start/stop shape as `startMultitableAttachmentBlobPurge`); the caller
 *     registers the returned stop in `MetaSheetServer.stop()`. Workers are NOT started when the
 *     storage resolution is `s3-required` (there is no store to purge from — and no upload can have
 *     succeeded); the reconciler lists ONLY this store's dedicated root (scope containment, G15).
 */
import type { Request, Router as ExpressRouter } from 'express'
import { Router } from 'express'
import * as path from 'node:path'

import { authenticate } from '../middleware/auth'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { createApprovalAttachmentRouter, isApprovalAttachmentsEnabled } from '../routes/approval-attachments'
import { resolveApprovalTemplateVisibilityActor } from '../routes/approvals'
import { applyTemplateVisibilityFilter } from './ApprovalProductService'
import { collectActiveNodeKeys, collectHiddenFieldIds, type RedactableRuntimeGraph } from './approval-form-redaction'
import { drainPurgeIntents, sweepUnboundAttachments, UNBOUND_ATTACHMENT_TTL_HOURS } from './approval-attachment-gc'
import { reconcileBucket } from './approval-attachment-reconciler'
import { LocalFsApprovalAttachmentStore, type ApprovalAttachmentStore } from './approval-attachment-storage'

export type ApprovalAttachmentStorageResolution =
  | { kind: 'local-fs'; store: LocalFsApprovalAttachmentStore; rootDir: string }
  /** production without an S3-compatible provider — the ratified O3 fail-close (503) posture. */
  | { kind: 's3-required'; store: null }

/**
 * O3 storage decision (§7/§9): production = S3-compatible object store ONLY; the S3 adapter is an
 * explicitly-named follow-up, so today `NODE_ENV=production` always resolves `s3-required`
 * (fail-closed 503 uploads — never a local write on the deploy host, issue #159). Dev/test resolve
 * a local-FS store under `APPROVAL_ATTACHMENT_STORAGE_DIR` (default `<cwd>/storage/approval-attachments`,
 * a DEDICATED root — the reconciler's scope containment rests on this directory holding approval
 * blobs and nothing else).
 */
export function resolveApprovalAttachmentStorage(env: NodeJS.ProcessEnv = process.env): ApprovalAttachmentStorageResolution {
  if (String(env.NODE_ENV ?? '').trim() === 'production') {
    return { kind: 's3-required', store: null }
  }
  const configured = typeof env.APPROVAL_ATTACHMENT_STORAGE_DIR === 'string' ? env.APPROVAL_ATTACHMENT_STORAGE_DIR.trim() : ''
  const rootDir = configured || path.resolve(process.cwd(), 'storage', 'approval-attachments')
  return { kind: 'local-fs', store: new LocalFsApprovalAttachmentStore(rootDir), rootDir }
}

/** Boot probe: prove the store can round-trip a blob (put→delete). Throws on failure (fail-closed boot). */
export async function probeApprovalAttachmentStore(store: ApprovalAttachmentStore): Promise<void> {
  const probeKey = `approval/boot-probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`
  await store.put(probeKey, Buffer.from('approval-attachment boot probe'))
  await store.delete(probeKey)
}

/** DB-rebuilt viewer roles (users.role + user_roles ids/names) — for role-typed assignment/CC matching. */
async function viewerRoles(db: Queryable, viewerId: string): Promise<string[]> {
  const roles = new Set<string>()
  const userResult = await db.query(`SELECT role FROM users WHERE id = $1 AND is_active = TRUE`, [viewerId])
  const role = (userResult.rows[0] as { role?: string | null } | undefined)?.role
  if (typeof role === 'string' && role.trim()) roles.add(role.trim())
  const roleRows = await db.query(
    `SELECT ur.role_id, r.name FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [viewerId],
  )
  for (const row of roleRows.rows as Array<{ role_id?: string | null; name?: string | null }>) {
    if (typeof row.role_id === 'string' && row.role_id.trim()) roles.add(row.role_id.trim())
    if (typeof row.name === 'string' && row.name.trim()) roles.add(row.name.trim())
  }
  return [...roles]
}

/**
 * Instance-visibility predicate for the auth-proxied download (§4.2 gate 1): initiator, current-or-past
 * assignee (user- or role-typed), past actor, CC recipient (user- or role-typed), or admin — the SAME
 * membership sources the bridge list tabs (`todo`/`mine`/`cc`/`completed`) read. Fail-closed: any
 * lookup error denies (the route maps a throw to the values-free 404 via `authorizeAttachmentDownload`).
 */
export async function isInstanceParticipant(db: Queryable, viewerId: string, instanceId: string): Promise<boolean> {
  const roles = await viewerRoles(db, viewerId)
  const rolesParam = roles.length > 0 ? roles : ['__approval_attachment_no_role__']
  const result = await db.query(
    `SELECT 1 FROM approval_instances i
      WHERE i.id = $1
        AND (
          i.requester_snapshot->>'id' = $2
          OR EXISTS (
            SELECT 1 FROM approval_assignments a
             WHERE a.instance_id = i.id
               AND ((a.assignment_type = 'user' AND a.assignee_id = $2)
                 OR (a.assignment_type = 'role' AND a.assignee_id = ANY($3::text[])))
          )
          OR EXISTS (SELECT 1 FROM approval_records r WHERE r.instance_id = i.id AND r.actor_id = $2)
          OR EXISTS (
            SELECT 1 FROM approval_records r
             WHERE r.instance_id = i.id AND r.action = 'cc'
               AND ((r.metadata->>'targetType' = 'user' AND r.metadata->>'targetId' = $2)
                 OR (r.metadata->>'targetType' = 'role' AND r.metadata->>'targetId' = ANY($3::text[])))
          )
          OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.is_active = TRUE AND (u.is_admin = TRUE OR u.role = 'admin'))
        )
      LIMIT 1`,
    [instanceId, viewerId, rolesParam],
  )
  return result.rows.length > 0
}

/**
 * Byte-path hidden gate (§4.2 gate 2 / G7): backed by the SAME `collectHiddenFieldIds` +
 * `collectActiveNodeKeys` derivation the snapshot redaction uses — the echoed snapshot and the
 * download byte path cannot drift on what "hidden" means. Fail-closed: an unloadable instance/graph
 * reports hidden (the storage-auth layer already treats a throw as hidden too).
 */
export async function isFieldHiddenAtActiveNode(db: Queryable, instanceId: string, fieldId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT i.current_node_key, i.metadata, d.runtime_graph
       FROM approval_instances i
       LEFT JOIN approval_published_definitions d ON d.id = i.published_definition_id
      WHERE i.id = $1`,
    [instanceId],
  )
  if (result.rows.length === 0) return true // fail-closed: unknown instance serves no bytes
  const row = result.rows[0] as {
    current_node_key: string | null
    metadata: Record<string, unknown> | null
    runtime_graph: RedactableRuntimeGraph | null
  }
  const hidden = collectHiddenFieldIds(row.runtime_graph ?? null, collectActiveNodeKeys(row.current_node_key, row.metadata))
  return hidden.has(fieldId)
}

/** G2 field resolve: is `fieldId` an `attachment`-typed field in the template's ACTIVE form schema? */
export async function isAttachmentFieldInTemplate(db: Queryable, templateId: string, fieldId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT v.form_schema
       FROM approval_templates t
       JOIN approval_template_versions v ON v.id = COALESCE(t.active_version_id, t.latest_version_id)
      WHERE t.id = $1`,
    [templateId],
  )
  const schema = (result.rows[0] as { form_schema?: unknown } | undefined)?.form_schema
  const fields = (schema as { fields?: unknown } | null | undefined)?.fields
  if (!Array.isArray(fields)) return false
  return fields.some((field) => {
    const f = field as { id?: unknown; type?: unknown } | null
    return f !== null && f?.id === fieldId && f?.type === 'attachment'
  })
}

/**
 * §4.1 template-access gate: the request-derived visibility actor (the SAME derivation the approvals
 * router uses) evaluated through `applyTemplateVisibilityFilter` — the exact predicate the template
 * list/detail/create paths enforce. No actor (unauthenticated shape) or no matching row ⇒ false.
 */
export async function templateVisibleToRequester(db: Queryable, req: Request, templateId: string): Promise<boolean> {
  const actor = resolveApprovalTemplateVisibilityActor(req)
  if (!actor) return false
  const conditions: string[] = ['id = $1']
  const params: unknown[] = [templateId]
  applyTemplateVisibilityFilter(conditions, params, 2, actor)
  const result = await db.query(`SELECT 1 FROM approval_templates WHERE ${conditions.join(' AND ')} LIMIT 1`, params)
  return result.rows.length > 0
}

function parsePositiveIntMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

export interface ApprovalAttachmentRuntimeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: Error): void
}

export interface ApprovalAttachmentRuntime {
  router: ExpressRouter
  storage: ApprovalAttachmentStorageResolution
  /** Start the flag-gated GC sweep + purge drain + bucket reconciler timers; returns the stop fn. */
  startWorkers(): () => void
}

export interface ApprovalAttachmentRuntimeOptions {
  db: Queryable
  logger: ApprovalAttachmentRuntimeLogger
  env?: NodeJS.ProcessEnv
  /** test seams — production uses the env-derived defaults. */
  intervals?: { gcSweepMs?: number; purgeDrainMs?: number; reconcileMs?: number }
}

/**
 * Flag OFF → null (nothing mounts, nothing ticks, byte-identical startup — D5/G1).
 * Flag ON → throws when the resolved store fails its probe (caller aborts startup, fail-closed).
 */
export async function bootApprovalAttachmentRuntime(opts: ApprovalAttachmentRuntimeOptions): Promise<ApprovalAttachmentRuntime | null> {
  const env = opts.env ?? process.env
  if (!isApprovalAttachmentsEnabled(env)) return null
  const { db, logger } = opts

  const storage = resolveApprovalAttachmentStorage(env)
  if (storage.kind === 'local-fs') {
    // Fail-closed boot: flag ON with an unusable store is an outage, not a degrade — throw so the
    // caller aborts startup (the durableBootFailureDisposition doctrine; nothing was started yet).
    await probeApprovalAttachmentStore(storage.store)
    logger.info(`Approval attachment storage: local-fs at ${storage.rootDir} (dev/test only — O3 prod requires S3)`)
  } else {
    logger.warn(
      'Approval attachment storage: NO S3-compatible provider configured in production — uploads/downloads fail closed (503) per the ratified O3 decision; the S3 adapter is the named follow-up',
    )
  }

  // A never-usable store for the s3-required posture: the routes short-circuit on storageAvailable=false
  // before touching it; if a code path ever reached it anyway, it throws (asyncHandler → values-free 500).
  const unavailableStore: ApprovalAttachmentStore = {
    put: async () => {
      throw new Error('approval attachment store unavailable (O3 prod fail-close)')
    },
    get: async () => {
      throw new Error('approval attachment store unavailable (O3 prod fail-close)')
    },
    delete: async () => {
      throw new Error('approval attachment store unavailable (O3 prod fail-close)')
    },
  }

  const inner = createApprovalAttachmentRouter({
    db,
    store: storage.store ?? unavailableStore,
    storageAvailable: storage.store != null,
    authChecks: {
      isInstanceParticipant: (viewerId, instanceId) => isInstanceParticipant(db, viewerId, instanceId),
      isFieldHiddenAtActiveNode: (instanceId, fieldId) => isFieldHiddenAtActiveNode(db, instanceId, fieldId),
    },
    viewerId: (req) => {
      const candidate = req.user?.id ?? req.user?.userId ?? (req.user as { sub?: unknown } | undefined)?.sub
      return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
    },
    // server-derived org: the principal's tenant, defaulting to the platform's 'default' org (the same
    // convention the directory/admin routes use) — never a body value.
    orgId: (req) => {
      const tenant = req.user?.tenantId
      return typeof tenant === 'string' && tenant.trim() ? tenant.trim() : 'default'
    },
    resolveAttachmentField: (templateId, fieldId) => isAttachmentFieldInTemplate(db, templateId, fieldId),
    templateVisible: (req, templateId) => templateVisibleToRequester(db, req, templateId),
    env,
  })
  if (!inner) return null // unreachable (flag checked above) — kept for type narrowing

  const router = Router()
  router.use('/api/approval/attachments', authenticate)
  router.use(inner)

  const gcSweepMs = opts.intervals?.gcSweepMs ?? parsePositiveIntMs(env.APPROVAL_ATTACHMENT_GC_INTERVAL_MS, 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000)
  const purgeDrainMs = opts.intervals?.purgeDrainMs ?? parsePositiveIntMs(env.APPROVAL_ATTACHMENT_PURGE_INTERVAL_MS, 5 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000)
  const reconcileMs = opts.intervals?.reconcileMs ?? parsePositiveIntMs(env.APPROVAL_ATTACHMENT_RECONCILE_INTERVAL_MS, 6 * 60 * 60 * 1000, 1_000, 7 * 24 * 60 * 60 * 1000)
  const ttlHours = parsePositiveIntMs(env.APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS, UNBOUND_ATTACHMENT_TTL_HOURS, 1, 8760)

  const startWorkers = (): (() => void) => {
    if (storage.kind !== 'local-fs') {
      // O3 fail-closed posture: no store ⇒ no blobs can exist ⇒ nothing to sweep/purge/reconcile.
      logger.warn('Approval attachment workers NOT started (no usable store — O3 prod fail-close)')
      return () => {}
    }
    const store = storage.store
    let stopped = false
    const safeTick = (name: string, run: () => Promise<unknown>) => (): void => {
      if (stopped) return
      void run().catch((err) => {
        logger.warn(`Approval attachment ${name} tick error: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    const gcTick = safeTick('GC sweep', async () => {
      await sweepUnboundAttachments(db, ttlHours)
    })
    const drainTick = safeTick('purge drain', async () => {
      const r = await drainPurgeIntents(db, (key) => store.delete(key), {
        onDeadLetter: (intentId, _storageKey, errCode) => {
          // alert seam (values-free): a purge intent exhausted its bounded attempts — operator action needed.
          logger.error(`Approval attachment purge intent ${intentId} dead-lettered (${errCode})`)
        },
      })
      if (r.skippedStillReferenced.length > 0) {
        logger.warn(`Approval attachment purge drain: ${r.skippedStillReferenced.length} intent(s) still referenced by live rows — left for the reconciler`)
      }
    })
    const reconcileTick = safeTick('bucket reconcile', async () => {
      const r = await reconcileBucket(db, () => store.list())
      if (r.missingBlobs.length > 0) {
        // values-free count only — a live row whose blob vanished is an alert, never an auto-delete.
        logger.error(`Approval attachment reconciler: ${r.missingBlobs.length} live row(s) missing their blob`)
      }
    })
    gcTick()
    drainTick()
    // NOTE: no initial reconcile tick — the first reconcile runs after a full interval, so a boot
    // never races an in-flight upload younger than the grace window under a cold cache (G15 is
    // age-guarded anyway; this just avoids pointless full-bucket lists on every boot loop).
    const timers = [setInterval(gcTick, gcSweepMs), setInterval(drainTick, purgeDrainMs), setInterval(reconcileTick, reconcileMs)]
    for (const t of timers) t.unref?.()
    logger.info(`Approval attachment workers started (gcSweepMs=${gcSweepMs}, purgeDrainMs=${purgeDrainMs}, reconcileMs=${reconcileMs}, ttlHours=${ttlHours})`)
    return () => {
      stopped = true
      for (const t of timers) clearInterval(t)
      logger.info('Approval attachment workers stopped')
    }
  }

  return { router, storage, startWorkers }
}
