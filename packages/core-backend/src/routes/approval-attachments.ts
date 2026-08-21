/**
 * Approval attachments — slice ⑤: upload + auth-proxied download routes (#4195, flag-gated OFF).
 *
 * Dependency-injected router factory (db/store/auth seams) so the wiring point is one line at app boot and
 * everything is testable with supertest. Contracts:
 *   - REGISTERS NOTHING unless `APPROVAL_ATTACHMENTS_ENABLED === 'true'` — the factory returns null while
 *     the flag is OFF (the field stays honestly disabled; no dormant routes).
 *   - POST /api/approval/attachments — single file (multer memory, hard byte cap), reject-by-default
 *     validation (slice ①), SERVER-derived key (slice ④; client filename never a path), blob put THEN row
 *     insert (`unbound`). A crash between put and insert leaves an orphan blob — that is the bucket
 *     reconciler's sweep target (slice ⑥), never a dangling row.
 *   - GET /api/approval/attachments/:id/download — loads the row, recomputes authorization on EVERY hit
 *     (slice ④ gate), streams via the server (no public/signed URLs in v1), values-free error codes.
 *   - Uploader identity comes from the app's authenticated request (injected extractor) — never from the body.
 */
import { randomUUID } from 'node:crypto'
import { json, Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'

import type { Queryable } from '../multitable/automation-durable-dispatcher'
import {
  runApprovalAttachmentScan,
  type ApprovalAttachmentScanHook,
} from '../services/approval-attachment-scan'
import {
  APPROVAL_ATTACHMENT_LIMITS,
  httpStatusForAttachmentRejects,
  validateApprovalAttachments,
} from '../services/approval-attachment-validation'
import {
  ApprovalProcessAttachmentBindError,
  assertProcessUploadBudget,
} from '../services/approval-process-attachment-bind'
import {
  authorizeAttachmentDownload,
  deriveStorageKey,
  type ApprovalAttachmentStore,
  type DownloadAuthChecks,
} from '../services/approval-attachment-storage'

export interface ApprovalAttachmentRouteDeps {
  db: Queryable
  store: ApprovalAttachmentStore
  authChecks: DownloadAuthChecks
  /** authenticated viewer/uploader id from the request (session/JWT middleware) — never the body. */
  viewerId(req: Request): string | null
  /**
   * The authenticated principal's org id, derived SERVER-SIDE from the session/JWT — NEVER the body.
   * A body-supplied org_id is a cross-tenant attribution forgery into the durable row; the org that
   * owns the attachment is a property of the caller's identity, not a client-writable field.
   */
  orgId(req: Request): string | null
  /**
   * Bound list/download gate: does the authenticated principal hold `approvals:read` (or an admin
   * wildcard)? Revoked/missing read fails closed as values-free 404 — never an existence oracle.
   */
  hasApprovalsRead(req: Request): boolean
  /**
   * Draft upload gate: does the authenticated principal hold `approvals:write` (or an admin
   * wildcard)? Checked BEFORE Multer/body ingestion so a principal without write never has their
   * multipart body buffered into memory or written to blob/row storage.
   */
  hasApprovalsWrite(req: Request): boolean
  /**
   * Lock-9 OD-L9-3(a) — process-attachment upload gate: does the authenticated principal hold
   * `approvals:act` (or an admin wildcard)? Deliberately DIFFERENT from `hasApprovalsWrite`'s
   * `approvals:write` — process uploads are an ACTING-approver surface, not a form-fill surface.
   *
   * OPTIONAL (not required): every existing `createApprovalAttachmentRouter({...})` call site in
   * approval-attachment-storage.test.ts / approval-attachment-routes.test.ts predates this field.
   * An absent dep is treated as DENY (`deps.hasApprovalsAct?.(req) ?? false`) — fail-closed, so
   * omission never widens who may upload a process attachment.
   */
  hasApprovalsAct?(req: Request): boolean
  /**
   * Lock-9 OD-L9-3(a) §5.2 — FAIL-FAST-ONLY seat check (NOT the authority; see
   * ApprovalProductService.actorHasActiveSeatAtInstance's own docblock for the parallel-region
   * fidelity gap this deliberately does not close). Absent ⇒ deny (fail-closed), same discipline
   * as `hasApprovalsAct`.
   */
  actorHasActiveSeat?(req: Request, instanceId: string): Promise<boolean>
  /**
   * Is `fieldId` an `attachment`-typed field in `templateId`'s form schema? (§4.1 / G2.) The production
   * wiring loads the template's form schema and checks the field's `type`; returns false for an unknown
   * template, an unknown field, or a non-attachment field. A false result fails the upload closed (400) —
   * an upload can never land against a non-attachment (or non-existent) field.
   */
  resolveAttachmentField(templateId: string, fieldId: string): Promise<boolean>
  /**
   * Template-access gate (§4.1 authorization): can the AUTHENTICATED requester INITIATE the template
   * the upload targets — active, published, and visible — EXACTLY like approval creation? The production
   * wiring evaluates the same visibility filter + published/active definition gates create uses.
   * `false` (or a throw — fail-closed) yields a values-free 404, indistinguishable from a non-existent
   * template (no template-enumeration oracle). Checked BEFORE `resolveAttachmentField`.
   */
  templateVisible(req: Request, templateId: string): Promise<boolean>
  /**
   * O3 storage disposition (§7/§9): `false` = no usable blob store is configured (production without an
   * S3-compatible provider — the ratified prod fail-close). Upload AND download then return a values-free
   * 503 instead of ever touching a local-FS path in production. Default `true` (a store was injected).
   */
  storageAvailable?: boolean
  /** §6 scan seam; production uses the default no-op pass-through unless the scan flag is ON. */
  scanHook?: ApprovalAttachmentScanHook
  env?: NodeJS.ProcessEnv
}

/** Hard bound on one `/refs` batch — a submission can carry at most 10 files/field (O1), so this is
 *  generous for any legitimate form while capping the work an authenticated caller can request. */
export const MAX_REF_BATCH = 200
export const MAX_REF_BODY_BYTES = 64 * 1024

const approvalAttachmentRefsJson = json({ limit: MAX_REF_BODY_BYTES })

/** Parse `/refs` JSON with a fixed values-free error contract. Also mounted before the global parser. */
export function approvalAttachmentRefsJsonParser(req: Request, res: Response, next: NextFunction): void {
  approvalAttachmentRefsJson(req, res, (error?: unknown) => {
    if (!error) return next()
    const parseError = error as { status?: unknown; type?: unknown }
    if (parseError.status === 413 || parseError.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    res.status(400).json({ error: 'invalid_body' })
  })
}

export function isApprovalAttachmentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_ATTACHMENTS_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/** Returns null while the flag is OFF — nothing is registered, byte-for-byte no-op. */
export function createApprovalAttachmentRouter(deps: ApprovalAttachmentRouteDeps): Router | null {
  if (!isApprovalAttachmentsEnabled(deps.env ?? process.env)) return null
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: APPROVAL_ATTACHMENT_LIMITS.maxFileBytes, files: 1 },
  })
  const router = Router()

  /**
   * Run multer, mapping its limit errors to the values-free reject contract instead of letting them
   * reach Express's default handler (a 500 with a stack). No filename, no limit value is echoed.
   * ONLY reached after identity + approvals:write — a no-write principal never hits body ingestion.
   */
  const runUpload = (req: Request, res: Response, next: NextFunction): void => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      const mErr = err as { name?: unknown; code?: unknown }
      if (mErr.name === 'MulterError') {
        const code =
          mErr.code === 'LIMIT_FILE_SIZE'
            ? 'file_too_large'
            : mErr.code === 'LIMIT_FILE_COUNT' || mErr.code === 'LIMIT_UNEXPECTED_FILE'
              ? 'too_many_files'
              : 'upload_rejected'
        res.status(code === 'upload_rejected' ? 400 : 413).json({ error: 'rejected', rejected: [{ code }] })
        return
      }
      res.status(400).json({ error: 'upload_failed' }) // any other parse error, values-free
    })
  }

  /**
   * Wrap an async handler so a db/store rejection becomes a values-free 500 instead of an unhandled
   * promise rejection (which under Express 4 hangs the request / can crash the process — a DoS lever).
   */
  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    }

  /**
   * Identity + approvals:write BEFORE Multer. A principal without write (or unauthenticated / no org)
   * never reaches body ingestion — no multipart buffer, no blob put, no row insert.
   */
  const requireUploadAuth = (req: Request, res: Response, next: NextFunction): void => {
    const uploaderId = deps.viewerId(req)
    if (!uploaderId) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    const orgId = deps.orgId(req)
    if (!orgId) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    if (!deps.hasApprovalsWrite(req)) {
      // values-free 403 — no existence oracle, and Multer never runs (negative proves no blob/row).
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }

  /** O3 must refuse before Multer allocates or parses any multipart bytes. */
  const requireStorageAvailable = (_req: Request, res: Response, next: NextFunction): void => {
    if (deps.storageAvailable === false) {
      res.status(503).json({ error: 'storage_unavailable' })
      return
    }
    next()
  }

  router.post(
    '/api/approval/attachments',
    requireUploadAuth,
    requireStorageAvailable,
    runUpload,
    asyncHandler(async (req: Request, res: Response) => {
      // Identity already verified by requireUploadAuth; re-read for the durable row stamps.
      const uploaderId = deps.viewerId(req)!
      const orgId = deps.orgId(req)! // server-derived from the principal — never the body
      const f = (req as Request & { file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } }).file
      if (!f) return res.status(400).json({ error: 'file_required' })
      const fieldId = typeof req.body?.fieldId === 'string' && /[!-~]/.test(req.body.fieldId) ? req.body.fieldId : null
      const templateId = typeof req.body?.templateId === 'string' && /[!-~]/.test(req.body.templateId) ? req.body.templateId : null
      if (!fieldId || !templateId) return res.status(400).json({ error: 'template_and_field_required' })
      // §4.1 authorization: the uploader must be able to SEE the target template (the same visibility_scope
      // predicate the create path enforces). Fail-closed to a values-free 404 (no template-existence oracle),
      // and BEFORE the field-type resolve so an outsider cannot probe a hidden template's schema.
      const visible = await deps.templateVisible(req, templateId).catch(() => false)
      if (!visible) return res.status(404).json({ error: 'not_found' })
      // G2: the target field MUST be an attachment-typed field in the template's form schema — else 400.
      if (!(await deps.resolveAttachmentField(templateId, fieldId))) {
        return res.status(400).json({ error: 'not_an_attachment_field' })
      }
      const verdict = validateApprovalAttachments([{ fileName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, content: f.buffer }]) as {
        ok: boolean
        rejected?: Array<{ fileName: string; code: string }>
      }
      if (!verdict.ok) {
        // §5/G3: type/signature mismatch → 415; per-file/per-field/per-submission caps → 413.
        const rejected = verdict.rejected ?? []
        return res.status(httpStatusForAttachmentRejects(rejected)).json({ error: 'rejected', rejected })
      }
      const mime = f.mimetype.toLowerCase().trim()
      // §6 scan seam (default no-op pass-through while APPROVAL_ATTACHMENT_SCAN_ENABLED is OFF).
      const scanState = await runApprovalAttachmentScan(
        { fileName: f.originalname, mimeType: mime, sizeBytes: f.size, content: f.buffer },
        { env: deps.env ?? process.env, scanHook: deps.scanHook },
      )
      // Infected uploads are refused before any blob write — never a bindable/downloadable row.
      if (scanState === 'infected') {
        return res.status(422).json({ error: 'rejected', rejected: [{ code: 'infected' }] })
      }
      const storageKey = deriveStorageKey(mime)
      const id = `att_${randomUUID()}`
      // Blob first, row second. A process crash still leaves a reconciler-visible orphan; an ordinary
      // INSERT rejection is cleaned up immediately on a best-effort basis before the error propagates.
      await deps.store.put(storageKey, f.buffer)
      try {
        await deps.db.query(
          `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, scan_state, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unbound')`,
          [id, orgId, uploaderId, fieldId, storageKey, f.originalname.slice(0, 255), mime, f.size, scanState],
        )
      } catch (error) {
        await deps.store.delete(storageKey).catch(() => false)
        throw error
      }
      return res.status(201).json({ id, sizeBytes: f.size })
    }),
  )

  /**
   * Lock-9 (approver process attachments) — POST /api/approval/attachments/process.
   *
   * Because this factory returns null while `APPROVAL_ATTACHMENTS_ENABLED` is OFF (line ~112
   * above), this route is NEVER registered under the OFF posture — G-12(a)'s "no process-upload
   * route registers" holds by the SAME mechanism the shipped form-upload route already relies on.
   *
   * Scope is `approvals:act` (OD-L9-3(a)), deliberately DIFFERENT from the form-upload route's
   * `approvals:write` — a process attachment is an ACTING-approver surface, not a form-fill
   * surface. `fieldId`/`templateId` are explicitly REJECTED if supplied (a process attachment has
   * no field to bind against) rather than silently ignored. `staged_instance_id` is required and
   * NEVER trusts a client-supplied `instance_id` — the row commits to an instance only at bind time
   * (§5.4), and stays uploader-only-readable until then (`storage.ts`'s `!row.instanceId` branch,
   * OD-L9-5/G7 — unchanged by this route, by construction: this INSERT never writes `instance_id`).
   */
  const requireProcessUploadAuth = (req: Request, res: Response, next: NextFunction): void => {
    const uploaderId = deps.viewerId(req)
    if (!uploaderId) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    const orgId = deps.orgId(req)
    if (!orgId) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    if (!(deps.hasApprovalsAct?.(req) ?? false)) {
      // values-free 403 — fail-closed on an absent dep too (no existence oracle; Multer never runs).
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }

  router.post(
    '/api/approval/attachments/process',
    requireProcessUploadAuth,
    requireStorageAvailable,
    runUpload,
    asyncHandler(async (req: Request, res: Response) => {
      const uploaderId = deps.viewerId(req)!
      const orgId = deps.orgId(req)! // server-derived — never the body
      const f = (req as Request & { file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } }).file
      if (!f) return res.status(400).json({ error: 'file_required' })
      // A process attachment has no field — reject rather than silently ignore a supplied one.
      if (typeof req.body?.fieldId === 'string' || typeof req.body?.templateId === 'string') {
        return res.status(400).json({ error: 'process_attachment_has_no_field' })
      }
      const stagedInstanceId =
        typeof req.body?.stagedInstanceId === 'string' && /[!-~]/.test(req.body.stagedInstanceId)
          ? req.body.stagedInstanceId
          : null
      if (!stagedInstanceId) return res.status(400).json({ error: 'staged_instance_id_required' })
      // §5.2: fail-fast-only seat check (NOT the authority — see ApprovalProductService's
      // actorHasActiveSeatAtInstance docblock). Absent dep ⇒ deny, fail-closed.
      const canAct = await (deps.actorHasActiveSeat?.(req, stagedInstanceId) ?? Promise.resolve(false))
      if (!canAct) return res.status(403).json({ error: 'forbidden' })
      // OD-L9-8 upload-time budget pre-check (fail-fast; the authoritative re-check is at bind).
      try {
        await assertProcessUploadBudget(deps.db, { uploaderId, orgId, stagedInstanceId, incomingBytes: f.size })
      } catch (error) {
        const status = error instanceof ApprovalProcessAttachmentBindError ? error.httpStatus : 400
        return res.status(status).json({ error: 'rejected', rejected: [{ code: status === 413 ? 'too_many_files' : 'upload_rejected' }] })
      }
      // OD-L9-9(a): reuse the validation core VERBATIM — same 20MB/file cap, same v1 MIME
      // allowlist, same extension⇄MIME cross-check, same magic-byte signature check.
      const verdict = validateApprovalAttachments([{ fileName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, content: f.buffer }]) as {
        ok: boolean
        rejected?: Array<{ fileName: string; code: string }>
      }
      if (!verdict.ok) {
        const rejected = verdict.rejected ?? []
        return res.status(httpStatusForAttachmentRejects(rejected)).json({ error: 'rejected', rejected })
      }
      const mime = f.mimetype.toLowerCase().trim()
      const scanState = await runApprovalAttachmentScan(
        { fileName: f.originalname, mimeType: mime, sizeBytes: f.size, content: f.buffer },
        { env: deps.env ?? process.env, scanHook: deps.scanHook },
      )
      if (scanState === 'infected') {
        return res.status(422).json({ error: 'rejected', rejected: [{ code: 'infected' }] })
      }
      const storageKey = deriveStorageKey(mime)
      const id = `att_${randomUUID()}`
      // Blob first, row second — same crash-safety ordering as the form-upload route above.
      await deps.store.put(storageKey, f.buffer)
      try {
        await deps.db.query(
          `INSERT INTO approval_attachments
             (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, scan_state, status, bind_kind, staged_instance_id)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,'unbound','process',$9)`,
          [id, orgId, uploaderId, storageKey, f.originalname.slice(0, 255), mime, f.size, scanState, stagedInstanceId],
        )
      } catch (error) {
        await deps.store.delete(storageKey).catch(() => false)
        throw error
      }
      return res.status(201).json({ id, sizeBytes: f.size })
    }),
  )

  router.get('/api/approval/attachments/:id/download', asyncHandler(async (req: Request, res: Response) => {
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    // Bound list/download enforce approvals:read; revoked/missing → values-free 404 (no existence oracle).
    if (!deps.hasApprovalsRead(req)) return res.status(404).json({ error: 'not_found' })
    const orgId = deps.orgId(req)
    if (!orgId) return res.status(404).json({ error: 'not_found' })
    const { rows } = await deps.db.query(
      `SELECT status, uploader_id, org_id, instance_id, field_id, storage_key, file_name, mime_type, scan_state, bind_kind
         FROM approval_attachments WHERE id=$1`,
      [String(req.params.id)],
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
    const row = rows[0] as {
      status: 'unbound' | 'bound' | 'deleted'
      uploader_id: string
      org_id: string
      instance_id: string | null
      field_id: string | null
      storage_key: string
      file_name: string
      mime_type: string
      scan_state: string | null
      bind_kind: string
    }
    const auth = await authorizeAttachmentDownload(
      {
        status: row.status,
        uploaderId: row.uploader_id,
        instanceId: row.instance_id,
        fieldId: row.field_id,
        orgId: row.org_id,
        scanState: row.scan_state,
        bindKind: row.bind_kind,
      },
      viewerId,
      orgId,
      deps.authChecks,
    )
    if (auth.ok === false) {
      // gone/infected → 410 only after authz; authorization failures → 404 (no existence oracle)
      return auth.code === 'gone' || auth.code === 'infected'
        ? res.status(410).json({ error: 'gone' })
        : res.status(404).json({ error: 'not_found' })
    }
    // O3: with no usable store (prod without S3) the byte path is honestly unavailable — 503, values-free.
    // Emitted only after the viewer authorized (no storage-posture oracle for outsiders).
    if (deps.storageAvailable === false) return res.status(503).json({ error: 'storage_unavailable' })
    const blob = await deps.store.get(row.storage_key)
    res.setHeader('Content-Type', row.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // §4.2/G8: locked-down CSP on EVERY byte served. `default-src 'none'` neutralises any active
    // content a stored file might carry if a browser is ever coaxed into rendering it despite the
    // attachment disposition + nosniff — the third leg of the no-inline-rendering posture, and the
    // reason an allowlisted-but-still-markup-ish body cannot become a stored-XSS vector.
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    return res.status(200).send(blob)
  }))

  /**
   * §4.3 DELETE — the uploader retracts their own STAGED (unbound) upload before submitting.
   *
   * The row transition and the durable purge intent are ONE statement (a CTE), and the intent is
   * gated on the conditional claim's non-empty `RETURNING` — the identical shape the GC sweep uses,
   * which is what preserves the §7 bind↔GC symmetry BY CONSTRUCTION: an id that a concurrent submit
   * already bound no longer matches `status='unbound'`, so this claims 0 rows, writes NO intent, and
   * the bound blob is never enqueued. It never blob-deletes inline, so a crash after the commit
   * leaves a durable pending intent the purge worker completes on restart (crash window iv, G14).
   *
   * Authorization is the uploader's own row only, org-scoped from the authenticated principal. Every
   * non-claim outcome — unknown id, another uploader's row, another org's row, an already-bound row,
   * an already-deleted row — collapses to the SAME values-free 404 (G6: no existence, ownership or
   * lifecycle oracle; a probe cannot distinguish "exists but not yours" from "does not exist").
   */
  router.delete('/api/approval/attachments/:id', asyncHandler(async (req: Request, res: Response) => {
    const uploaderId = deps.viewerId(req)
    if (!uploaderId) return res.status(401).json({ error: 'unauthenticated' })
    const orgId = deps.orgId(req)
    if (!orgId) return res.status(403).json({ error: 'no_org' })
    const { rows } = await deps.db.query(
      `WITH claimed AS (
         UPDATE approval_attachments
            SET status = 'deleted'
          WHERE id = $1 AND uploader_id = $2 AND org_id = $3 AND status = 'unbound'
        RETURNING id, storage_key
       ),
       intent AS (
         INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
         SELECT 'pi_' || c.id, c.storage_key, 'row_deleted' FROM claimed c
         ON CONFLICT (storage_key) DO NOTHING
         RETURNING id
       )
       SELECT id FROM claimed`,
      [String(req.params.id), uploaderId, orgId],
    )
    // 0 claimed rows ⇒ the same 404 for every reason (no oracle). The blob is NEVER deleted here.
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
    return res.status(204).end()
  }))

  /**
   * §8 batched reference resolution — ONE endpoint, two modes, both fail-closed and values-free.
   *
   *   - `{ ids }`               → **draft stale-check** (G13/O2). Uploader-scoped: an id that is not
   *                               (live AND still `unbound` AND uploaded by THIS viewer AND in THIS
   *                               org) comes back `stale:true`. A swept/deleted/foreign/unknown id is
   *                               reported identically, so the answer discloses nothing the viewer did
   *                               not already own — and a restored draft can drop the dangling refs
   *                               instead of carrying them into a create that would fail closed.
   *   - `{ instanceId, ids }`   → **bound metadata** for detail/history rendering (§8/G5). Gated by the
   *                               SAME two predicates the byte path uses — `isInstanceParticipant`
   *                               (the DI seam name; backed by Lock-10's `canReadApprovalInstance`,
   *                               OD-S1-16), then `isFieldHiddenAtActiveNode` — so the rendered
   *                               metadata and the served bytes cannot drift on visibility or on
   *                               "hidden" (G7). A non-participant gets the values-free 404 the
   *                               download gate gives them.
   *
   * Resolution is BY THE FROZEN ID and scoped to the instance the caller named: an id that does not
   * resolve to a live row bound to THAT instance renders as a `tombstone` (the §8 "附件已删除" contract)
   * — never a silent swap to a different file, and never a leak of another instance's attachment.
   */
  const handleRefs = asyncHandler(async (req: Request, res: Response) => {
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    const orgId = deps.orgId(req)
    if (!orgId) return res.status(403).json({ error: 'no_org' })
    const rawIds = (req.body as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(rawIds)) return res.status(400).json({ error: 'ids_required' })
    if (rawIds.length > MAX_REF_BATCH) return res.status(413).json({ error: 'too_many_ids' })
    // Drop non-string/blank ids before they reach a query parameter; oversized input is rejected
    // above rather than silently truncating and misclassifying the omitted tail as healthy.
    const ids = [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && /[!-~]/.test(id)))]
    if (ids.length === 0) return res.status(200).json({ attachments: [] })
    const rawInstanceId = (req.body as { instanceId?: unknown } | undefined)?.instanceId
    const instanceId = typeof rawInstanceId === 'string' && /[!-~]/.test(rawInstanceId) ? rawInstanceId : null

    if (instanceId === null) {
      // Draft stale-check: uploader-scoped, unbound-only, non-infected. Anything that does not come back live is stale.
      const { rows } = await deps.db.query(
        `SELECT id, file_name, size_bytes, mime_type FROM approval_attachments
          WHERE id = ANY($1) AND uploader_id = $2 AND org_id = $3 AND status = 'unbound'
            AND scan_state <> 'infected'`,
        [ids, viewerId, orgId],
      )
      const live = new Map(
        (rows as Array<{ id: string; file_name: string; size_bytes: string | number; mime_type: string }>).map((r) => [r.id, r]),
      )
      return res.status(200).json({
        attachments: ids.map((id) => {
          const row = live.get(id)
          return row
            ? { id, stale: false, fileName: row.file_name, sizeBytes: Number(row.size_bytes), mimeType: row.mime_type }
            : { id, stale: true }
        }),
      })
    }

    // Bound metadata is an approval read surface. Draft stale-checks above remain uploader-scoped
    // because an initiator may legitimately upload before they have instance-read permission.
    if (!deps.hasApprovalsRead(req)) return res.status(404).json({ error: 'not_found' })

    // Bound metadata: gate 1 — participant (same predicate as §4.2 download; OD-S1-16). `orgId`
    // is NOT passed here any more — the predicate derives org server-side (OD-S1-9(f)); this
    // route's own `orgId` variable still scopes the metadata SELECT below to the caller's org.
    const participant = await deps.authChecks.isInstanceParticipant(viewerId, instanceId).catch(() => false)
    if (!participant) return res.status(404).json({ error: 'not_found' })
    const { rows } = await deps.db.query(
      `SELECT id, field_id, file_name, size_bytes, mime_type, status, scan_state, bind_kind FROM approval_attachments
        WHERE id = ANY($1) AND instance_id = $2 AND org_id = $3`,
      [ids, instanceId, orgId],
    )
    const byId = new Map(
      (rows as Array<{
        id: string
        field_id: string | null
        file_name: string
        size_bytes: string | number
        mime_type: string
        status: string
        scan_state: string
        bind_kind: string
      }>).map((r) => [r.id, r]),
    )
    // Gate 2 (G7 / Lock-9 OD-L9-4) — hidden-at-active-node is resolved ONCE per distinct FORM field
    // and fail-closed: a field the echoed snapshot would strip yields NO metadata either (a filename
    // is form content too). Process rows (`bind_kind==='process'`) carry no `field_id` and are
    // EXPLICITLY excluded from this set (G15) — this is an EXTEND, not a reuse: `/refs` does not
    // route through `authorizeAttachmentDownload`, so its own gate-2 loop needs the same explicit
    // skip storage.ts's gate 2 carries, or `hidden.has(null) === false` would render `fileName` for a
    // process row by the same accidental pass the byte path condemns (a verified leak).
    const hiddenByField = new Map<string, boolean>()
    for (const fieldId of new Set(
      [...byId.values()].filter((r) => r.bind_kind !== 'process' && r.field_id != null).map((r) => r.field_id as string),
    )) {
      const hidden = await deps.authChecks.isFieldHiddenAtActiveNode(instanceId, fieldId).catch(() => true)
      hiddenByField.set(fieldId, hidden)
    }
    return res.status(200).json({
      attachments: ids.flatMap((id) => {
        const row = byId.get(id)
        // Not bound to THIS instance, soft-deleted, or infected ⇒ tombstone (never a swap, never a leak).
        if (!row || row.status === 'deleted' || row.scan_state === 'infected') return [{ id, tombstone: true }]
        // Lock-9 OD-L9-4 / G15: a process attachment has no hidden-field gate to consult at all —
        // render it BEFORE the hiddenByField lookup so a process row's absent field_id never reaches
        // (and is never accidentally waved through by) the form-field hidden check below.
        if (row.bind_kind === 'process') {
          return [{
            id,
            tombstone: false,
            fieldId: null,
            fileName: row.file_name,
            sizeBytes: Number(row.size_bytes),
            mimeType: row.mime_type,
            downloadUrl: `/api/approval/attachments/${encodeURIComponent(id)}/download`,
          }]
        }
        if (row.field_id == null || hiddenByField.get(row.field_id) === true) return [] // hidden ⇒ absent, exactly as the snapshot echo
        return [{
          id,
          tombstone: false,
          fieldId: row.field_id,
          fileName: row.file_name,
          sizeBytes: Number(row.size_bytes),
          mimeType: row.mime_type,
          // the approval-scoped auth-proxied URL ONLY — the raw storage key/url is never echoed (§2/G8).
          downloadUrl: `/api/approval/attachments/${encodeURIComponent(id)}/download`,
        }]
      }),
    })
  })
  router.post(
    '/api/approval/attachments/refs',
    approvalAttachmentRefsJsonParser,
    handleRefs,
  )

  return router
}
