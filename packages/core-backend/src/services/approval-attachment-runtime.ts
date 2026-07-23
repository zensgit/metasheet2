/**
 * Approval attachments — production runtime boot (#4195 §7/§9): flag-gated route mount + workers.
 *
 * This is the ONE wiring point that turns the inert pipeline modules (validation core, storage,
 * routes, GC/purge worker, reconciler, bind) into a running feature — everything stays a byte-level
 * no-op while `APPROVAL_ATTACHMENTS_ENABLED` is OFF (`bootApprovalAttachmentRuntime` returns null).
 *
 * Flag ON:
 *   - STORAGE (owner-DECIDED O3): production REQUIRES the built-in official-SDK S3 adapter,
 *     selected only by a complete
 *     `APPROVAL_ATTACHMENT_S3_BUCKET` + `APPROVAL_ATTACHMENT_S3_REGION` configuration; deployments
 *     cannot satisfy this boundary with a caller-declared local/non-local provider. Without complete
 *     configuration, `NODE_ENV=production` resolves `s3-required` —
 *     the routes mount with `storageAvailable:false` and upload/download return a values-free 503 (the
 *     ratified prod fail-close; approval blobs never land on the deploy host's local filesystem).
 *     Dev/test resolve a `LocalFsApprovalAttachmentStore` under a DEDICATED root. Every resolved store
 *     is PROBED (put→delete) — a failed probe THROWS and the caller aborts startup (fail-closed boot
 *     doctrine, mirroring `durableBootFailureDisposition`: flag ON means a storage-less boot is an
 *     outage, not a degrade).
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
import {
  reconcileBucket,
  type ReconcileCursor,
  type ReconcilerBlobSource,
} from './approval-attachment-reconciler'
import {
  APPROVAL_STORAGE_PREFIX,
  LocalFsApprovalAttachmentStore,
  ObjectStoreApprovalAttachmentStore,
  type ApprovalAttachmentStore,
} from './approval-attachment-storage'
import { createApprovalAttachmentS3Provider, type S3CommandSender } from './approval-attachment-s3'
import {
  assertApprovalAttachmentScannerConfigured,
  type ApprovalAttachmentScanHook,
} from './approval-attachment-scan'

export type ApprovalAttachmentStorageResolution =
  | {
      kind: 'local-fs'
      store: LocalFsApprovalAttachmentStore
      rootDir: string
      reconcileSource: ReconcilerBlobSource
    }
  /** production with the built-in official-SDK S3-compatible provider. */
  | {
      kind: 'object-store'
      store: ObjectStoreApprovalAttachmentStore
      reconcileSource: ReconcilerBlobSource
    }
  /** production without an S3-compatible provider — the ratified O3 fail-close (503) posture. */
  | { kind: 's3-required'; store: null }

/**
 * O3 storage decision (§7/§9): production = S3-compatible object store ONLY.
 *
 *   - production + complete approval S3 config ⇒ `object-store`.
 *   - production + incomplete config ⇒ **`s3-required`**: the routes
 *     mount with `storageAvailable:false` and upload/download return a values-free 503. This is the
 *     ratified fail-close; no caller-declared provider can bypass it (issue #159).
 *   - dev/test ⇒ a local-FS store under `APPROVAL_ATTACHMENT_STORAGE_DIR` (default
 *     `<cwd>/storage/approval-attachments`), a DEDICATED root — the reconciler's scope containment
 *     rests on that directory holding approval blobs and nothing else.
 */
export function resolveApprovalAttachmentStorage(
  env: NodeJS.ProcessEnv = process.env,
  s3Sender?: S3CommandSender,
): ApprovalAttachmentStorageResolution {
  if (String(env.NODE_ENV ?? '').trim() === 'production') {
    const builtInS3 = createApprovalAttachmentS3Provider(env, s3Sender)
    if (builtInS3) {
      return {
        kind: 'object-store',
        store: new ObjectStoreApprovalAttachmentStore(builtInS3),
        reconcileSource: {
          listPage: (cursor, limit) => builtInS3.listApprovalBlobsPage(cursor, limit),
          hasBlob: (storageKey) => builtInS3.hasApprovalBlob(storageKey),
        },
      }
    }
    return { kind: 's3-required', store: null }
  }
  const configured = typeof env.APPROVAL_ATTACHMENT_STORAGE_DIR === 'string' ? env.APPROVAL_ATTACHMENT_STORAGE_DIR.trim() : ''
  const rootDir = configured || path.resolve(process.cwd(), 'storage', 'approval-attachments')
  const store = new LocalFsApprovalAttachmentStore(rootDir)
  return {
    kind: 'local-fs',
    store,
    rootDir,
    // Local FS is dev/test only. It adapts the existing directory walk to the same keyset contract;
    // production S3 uses one native ListObjectsV2 request per page above.
    reconcileSource: {
      listPage: async (cursor, limit) => {
        const remaining = (await store.list())
          .filter((blob) => cursor === undefined || blob.key > cursor)
          .sort((a, b) => a.key.localeCompare(b.key))
        const blobs = remaining.slice(0, limit)
        return {
          blobs,
          ...(remaining.length > limit && blobs.length > 0 ? { nextCursor: blobs[blobs.length - 1].key } : {}),
        }
      },
      hasBlob: async (storageKey) => {
        try {
          await store.get(storageKey)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
    },
  }
}

/**
 * Boot probe: prove the store can put, get exact bytes, run a bounded prefix list, HEAD, then delete.
 * Throws on failure (fail-closed boot). The probe key MUST live under the approval scope prefix — the
 * object-store adapter refuses anything outside it, so a probe key outside the partition would make
 * every object-store boot fail closed for the wrong reason (a scope refusal misread as unreachable).
 *
 * VALUES-FREE: any underlying storage error (hosts, buckets, credentials, stack text) is swallowed and
 * rethrown as a fixed message so production probe/boot logs never echo raw provider errors.
 */
export async function probeApprovalAttachmentStore(
  store: ApprovalAttachmentStore,
  reconcileSource?: ReconcilerBlobSource,
): Promise<void> {
  const payload = Buffer.from('approval-attachment boot probe')
  const probeKey = `${APPROVAL_STORAGE_PREFIX}boot-probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`
  try {
    await store.put(probeKey, payload)
    const got = await store.get(probeKey)
    if (!Buffer.isBuffer(got) || !got.equals(payload)) {
      throw new Error('probe get mismatch')
    }
    // Production reconciliation capabilities are probed without aggregating the bucket: one bounded
    // LIST request proves prefix access, and HEAD proves the just-written object is visible.
    if (reconcileSource) {
      await reconcileSource.listPage(undefined, 1)
      if (!(await reconcileSource.hasBlob(probeKey))) throw new Error('probe head miss')
    } else if (typeof store.list === 'function') {
      const listed = await store.list()
      if (!listed.some((entry) => entry.key === probeKey)) {
        throw new Error('probe list miss')
      }
    }
    await store.delete(probeKey)
  } catch {
    // Best-effort cleanup so a failed mid-probe leave-behind does not accumulate.
    await store.delete(probeKey).catch(() => false)
    throw new Error('Approval attachment storage probe failed')
  }
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
 * membership sources the bridge list tabs (`todo`/`mine`/`cc`/`completed`) read. **Org-pinned**: the
 * caller's org must match the attachment row's org (passed as `orgId`); a cross-org stale membership
 * fails closed. Fail-closed: any lookup error denies (the route maps a throw to the values-free 404
 * via `authorizeAttachmentDownload`).
 */
export async function isInstanceParticipant(
  db: Queryable,
  viewerId: string,
  instanceId: string,
  orgId: string,
): Promise<boolean> {
  if (!orgId || !/[!-~]/.test(orgId)) return false
  const roles = await viewerRoles(db, viewerId)
  const rolesParam = roles.length > 0 ? roles : ['__approval_attachment_no_role__']
  // Org pin: require at least one attachment on this instance stamped with the caller's org —
  // INCLUDING deleted/tombstoned rows. A deleted-only bound attachment must still let an authorized
  // participant/admin reach the lifecycle 410 (gone), while an outsider/cross-org stays 404. Filtering
  // `status <> 'deleted'` here would turn a pure-tombstone instance into a false not_participant and
  // leak a 404 instead of the authorized 410. Cross-org stale relations (viewer still appears on
  // assignments from another tenant's instance while their principal org differs) still fail closed.
  const result = await db.query(
    `SELECT 1 FROM approval_instances i
      WHERE i.id = $1
        AND EXISTS (
          SELECT 1 FROM approval_attachments att
           WHERE att.instance_id = i.id AND att.org_id = $4
        )
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
    [instanceId, viewerId, rolesParam, orgId],
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

/**
 * G2 field resolve: is `fieldId` an `attachment`-typed field in the template's ACTIVE *published*
 * form schema? Draft/latest-only versions are never upload targets — same freeze the create path uses.
 */
export async function isAttachmentFieldInTemplate(db: Queryable, templateId: string, fieldId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT v.form_schema
       FROM approval_templates t
       JOIN approval_template_versions v ON v.id = t.active_version_id
       JOIN approval_published_definitions pd
         ON pd.template_version_id = v.id AND pd.is_active = TRUE
      WHERE t.id = $1 AND t.status = 'published'`,
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
 * §4.1 template-access gate — EXACTLY like approval creation: the template must be visible to the
 * requester AND published with an active published definition. No actor, no matching row, draft /
 * archived / inactive-definition → false (values-free 404 at the route; no existence leakage).
 *
 * Uses the unaliased `approval_templates` relation so `applyTemplateVisibilityFilter`'s bare
 * `visibility_scope` / subquery `id` references stay valid without fragile string rewriting.
 */
export async function templateVisibleToRequester(db: Queryable, req: Request, templateId: string): Promise<boolean> {
  const actor = resolveApprovalTemplateVisibilityActor(req)
  if (!actor) return false
  const conditions: string[] = [
    'id = $1',
    `status = 'published'`,
    'active_version_id IS NOT NULL',
    `EXISTS (
       SELECT 1 FROM approval_published_definitions pd
        WHERE pd.template_id = approval_templates.id
          AND pd.template_version_id = approval_templates.active_version_id
          AND pd.is_active = TRUE
     )`,
  ]
  const params: unknown[] = [templateId]
  applyTemplateVisibilityFilter(conditions, params, 2, actor)
  const result = await db.query(
    `SELECT 1 FROM approval_templates WHERE ${conditions.join(' AND ')} LIMIT 1`,
    params,
  )
  return result.rows.length > 0
}

function principalPermissionCodes(req: Request): Set<string> | 'admin' | null {
  const user = req.user
  if (!user) return null
  if (user.role === 'admin' || (Array.isArray(user.roles) && user.roles.includes('admin'))) return 'admin'
  const codes = new Set<string>()
  if (Array.isArray(user.permissions)) {
    for (const p of user.permissions) if (typeof p === 'string' && p.trim()) codes.add(p.trim())
  }
  const tokenPerms = (user as { perms?: unknown }).perms
  if (Array.isArray(tokenPerms)) {
    for (const p of tokenPerms) if (typeof p === 'string' && p.trim()) codes.add(p.trim())
  }
  return codes
}

/** Bound list/download RBAC: approvals:read (or admin / approvals:* / *:* wildcards). Fail-closed. */
export function principalHasApprovalsRead(req: Request): boolean {
  const codes = principalPermissionCodes(req)
  if (codes === null) return false
  if (codes === 'admin') return true
  return codes.has('approvals:read') || codes.has('approvals:*') || codes.has('*:*')
}

/** Draft upload RBAC: approvals:write (or admin / approvals:* / *:* wildcards). Fail-closed. */
export function principalHasApprovalsWrite(req: Request): boolean {
  const codes = principalPermissionCodes(req)
  if (codes === null) return false
  if (codes === 'admin') return true
  return codes.has('approvals:write') || codes.has('approvals:*') || codes.has('*:*')
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
  /**
   * Start the flag-gated GC sweep + purge drain + bucket reconciler timers.
   * Returns an async stop that clears timers AND awaits any in-flight tick so shutdown does not
   * race a half-finished sweep/drain against a closing pool.
   */
  startWorkers(): () => Promise<void>
}

export interface ApprovalAttachmentRuntimeOptions {
  db: Queryable
  logger: ApprovalAttachmentRuntimeLogger
  env?: NodeJS.ProcessEnv
  /** test seams — production uses the env-derived defaults. */
  intervals?: {
    gcSweepMs?: number
    purgeDrainMs?: number
    reconcileMs?: number
    reconcileContinuationMs?: number
  }
  /** test seam for the built-in S3 provider; production constructs the official SDK client. */
  s3Sender?: S3CommandSender
  /**
   * Real AV scanner for the §6 scan seam. Required when `APPROVAL_ATTACHMENT_SCAN_ENABLED=true`;
   * absent under that flag aborts boot (fail-closed). When the scan flag is OFF this is ignored.
   * Production index currently does not inject one — leave the scan flag OFF until a real engine is wired.
   */
  scanHook?: ApprovalAttachmentScanHook
}

export const APPROVAL_ATTACHMENT_RECONCILE_CONTINUATION_MS = 1_000
export const APPROVAL_ATTACHMENT_RECONCILE_CONTINUATION_MAX_MS = 60_000

function readReconcileContinuationMs(value: number | undefined): number {
  if (value === undefined) return APPROVAL_ATTACHMENT_RECONCILE_CONTINUATION_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > APPROVAL_ATTACHMENT_RECONCILE_CONTINUATION_MAX_MS) {
    throw new RangeError(
      `reconcileContinuationMs must be a safe integer in [1, ${APPROVAL_ATTACHMENT_RECONCILE_CONTINUATION_MAX_MS}]`,
    )
  }
  return value
}

/**
 * Flag OFF → null (nothing mounts, nothing ticks, byte-identical startup — D5/G1).
 * Flag ON → throws when the resolved store fails its probe (caller aborts startup, fail-closed).
 */
export async function bootApprovalAttachmentRuntime(opts: ApprovalAttachmentRuntimeOptions): Promise<ApprovalAttachmentRuntime | null> {
  const env = opts.env ?? process.env
  if (!isApprovalAttachmentsEnabled(env)) return null
  const { db, logger } = opts
  const reconcileContinuationMs = readReconcileContinuationMs(opts.intervals?.reconcileContinuationMs)

  // §6 scan fail-closed: flag ON without a real injected scanner is a misconfiguration outage, not a
  // degrade-to-clean. Values-free throw (assert message carries no paths/credentials/filenames).
  assertApprovalAttachmentScannerConfigured(env, opts.scanHook)

  const storage = resolveApprovalAttachmentStorage(env, opts.s3Sender)
  if (storage.kind === 'local-fs') {
    // Fail-closed boot: flag ON with an unusable store is an outage, not a degrade — throw so the
    // caller aborts startup (the durableBootFailureDisposition doctrine; nothing was started yet).
    // Values-free: never log the root path or raw probe error (probe already wraps provider errors).
    await probeApprovalAttachmentStore(storage.store, storage.reconcileSource)
    logger.info('Approval attachment storage: local-fs (dev/test only — O3 prod requires S3; probe ok)')
  } else if (storage.kind === 'object-store') {
    // Same fail-closed boot probe as local-fs: an S3-compatible provider that cannot round-trip a blob
    // is an outage. Values-free log — never the bucket/endpoint/credentials or raw storage error text.
    await probeApprovalAttachmentStore(storage.store, storage.reconcileSource)
    logger.info('Approval attachment storage: built-in S3 object-store provider (probe ok)')
  } else {
    logger.warn(
      'Approval attachment storage: incomplete S3 configuration in production — uploads/downloads fail closed (503) per the ratified O3 decision',
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
      isInstanceParticipant: (viewerId, instanceId, orgId) => isInstanceParticipant(db, viewerId, instanceId, orgId),
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
    hasApprovalsRead: (req) => principalHasApprovalsRead(req),
    hasApprovalsWrite: (req) => principalHasApprovalsWrite(req),
    resolveAttachmentField: (templateId, fieldId) => isAttachmentFieldInTemplate(db, templateId, fieldId),
    templateVisible: (req, templateId) => templateVisibleToRequester(db, req, templateId),
    // Only present after the startup assert above; never a clean-by-default stand-in.
    scanHook: opts.scanHook,
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

  const startWorkers = (): (() => Promise<void>) => {
    if (storage.kind === 's3-required') {
      // O3 fail-closed posture: no store ⇒ no blobs can exist ⇒ nothing to sweep/purge/reconcile.
      logger.warn('Approval attachment workers NOT started (no usable store — O3 prod fail-close)')
      return async () => {}
    }
    const store = storage.store
    const reconcileSource = storage.reconcileSource
    // G15 object enumeration is mandatory for every accepted store. Both the local store and the
    // built-in S3 adapter implement it; there is no production provider-registration escape hatch.
    let stopped = false
    let reconcileCursor: ReconcileCursor | undefined
    let reconcileRunning = false
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined
    /** In-flight tick promises — stop() awaits these so shutdown never races a half-finished drain. */
    const activeTicks = new Set<Promise<unknown>>()
    const safeTick = (name: string, run: () => Promise<unknown>) => (): void => {
      if (stopped) return
      const tick = run()
        .catch(() => {
          // Values-free by construction: driver and object-store errors can contain hosts, buckets,
          // endpoints, or credentials. Operators get the worker name; detailed values stay out of logs.
          logger.warn(`Approval attachment ${name} tick failed`)
        })
        .finally(() => {
          activeTicks.delete(tick)
        })
      activeTicks.add(tick)
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
    const scheduleReconcile = (delayMs: number): void => {
      if (stopped) return
      reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined
        reconcileTick()
      }, delayMs)
      reconcileTimer.unref?.()
    }
    const reconcileTick = safeTick('bucket reconcile', async () => {
      if (reconcileRunning) return
      reconcileRunning = true
      let nextDelayMs = reconcileMs
      try {
        const r = await reconcileBucket(db, reconcileSource, { cursor: reconcileCursor })
        reconcileCursor = r.nextCursor
        nextDelayMs = r.nextCursor ? reconcileContinuationMs : reconcileMs
        if (r.missingBlobs.length > 0) {
          // values-free count only — a live row whose blob vanished is an alert, never an auto-delete.
          logger.error(`Approval attachment reconciler: ${r.missingBlobs.length} live row(s) missing their blob`)
        }
      } finally {
        reconcileRunning = false
        // One page per tick. A cursor schedules another bounded page after a short delay; a completed
        // cycle returns to the normal cadence. Failures also back off to the normal cadence.
        scheduleReconcile(nextDelayMs)
      }
    })
    gcTick()
    drainTick()
    // NOTE: no initial reconcile tick — the first reconcile runs after a full interval, so a boot
    // never races an in-flight upload younger than the grace window under a cold cache (G15 is
    // age-guarded anyway; this just avoids pointless full-bucket lists on every boot loop).
    const timers = [setInterval(gcTick, gcSweepMs), setInterval(drainTick, purgeDrainMs)]
    for (const t of timers) t.unref?.()
    scheduleReconcile(reconcileMs)
    logger.info(`Approval attachment workers started (gcSweepMs=${gcSweepMs}, purgeDrainMs=${purgeDrainMs}, reconcileMs=${reconcileMs}, reconcileContinuationMs=${reconcileContinuationMs}, ttlHours=${ttlHours})`)
    return async () => {
      stopped = true
      for (const t of timers) clearInterval(t)
      if (reconcileTimer) clearTimeout(reconcileTimer)
      // Await every in-flight tick before returning — stop must not leave a dangling claim/delete.
      await Promise.allSettled([...activeTicks])
      logger.info('Approval attachment workers stopped')
    }
  }

  return { router, storage, startWorkers }
}
