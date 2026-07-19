/**
 * Approval attachments — upload + auth-proxied download + unbound delete routes
 * (#4195, flag-gated OFF by default).
 *
 * Wire paths match the ratified lock §4: `/api/approvals/attachments` (plural "approvals").
 *
 *   - REGISTERS NOTHING unless `APPROVAL_ATTACHMENTS_ENABLED === 'true'`.
 *   - POST requires the SAME create capability as `POST /api/approvals` (approvals:write) PLUS
 *     template visibility + published + attachment-typed field — not authenticate-only.
 *   - scanHook seam (default pass-through); scan_state=infected never binds/downloads.
 */
import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import multer from 'multer'

import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { APPROVAL_ATTACHMENT_LIMITS, validateApprovalAttachments } from '../services/approval-attachment-validation'
import {
  authorizeAttachmentDownload,
  deriveStorageKey,
  type ApprovalAttachmentStore,
  type DownloadAuthChecks,
} from '../services/approval-attachment-storage'
import {
  defaultPassThroughScanHook,
  isScanStateDownloadable,
  runScanHook,
  type ScanHook,
} from '../services/approval-attachment-scan'
import type { UploadTargetAuth, UploadVisibilityActor } from '../services/approval-attachment-runtime'

/** Canonical wire prefix — ratified lock §4.1/§4.2/§4.3 (`/api/approvals/attachments`). */
export const APPROVAL_ATTACHMENTS_PATH_PREFIX = '/api/approvals/attachments'

export interface ApprovalAttachmentRouteDeps {
  db: Queryable
  store: ApprovalAttachmentStore
  authChecks: DownloadAuthChecks
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  /**
   * Upload target gate: visibility + published + attachment field (same bar as createApproval).
   * Replaces bare field-existence checks so inaccessible templates cannot burn storage.
   */
  authorizeUploadTarget(
    templateId: string,
    fieldId: string,
    actor: UploadVisibilityActor,
  ): Promise<UploadTargetAuth>
  /** Build the visibility actor from the authenticated principal (server-side only). */
  uploadActor(req: Request): UploadVisibilityActor | null
  /**
   * Same capability as POST /api/approvals create. Production wires rbacGuard('approvals','write');
   * unit tests inject true/false. Fail-closed when omitted/false.
   */
  canCreateApproval(req: Request): boolean | Promise<boolean>
  env?: NodeJS.ProcessEnv
  storeUnavailable?: boolean
  authenticate?: RequestHandler
  /** Optional AV scan hook; defaults to pass-through (v1, no engine). */
  scanHook?: ScanHook
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
  const scanHook = deps.scanHook ?? defaultPassThroughScanHook

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
      res.status(400).json({ error: 'upload_failed' })
    })
  }

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          const code = (err as { code?: unknown } | null)?.code
          if (code === 'storage_unavailable' || code === 'misconfigured' || code === 'local_in_production') {
            res.status(503).json({ error: 'storage_unavailable' })
            return
          }
          res.status(500).json({ error: 'internal_error' })
        }
      })
    }

  const auth = deps.authenticate ? [deps.authenticate] : []

  router.post(APPROVAL_ATTACHMENTS_PATH_PREFIX, ...auth, runUpload, asyncHandler(async (req: Request, res: Response) => {
    if (deps.storeUnavailable) {
      return res.status(503).json({ error: 'storage_unavailable' })
    }
    const uploaderId = deps.viewerId(req)
    if (!uploaderId) return res.status(401).json({ error: 'unauthenticated' })
    // Same capability as createApproval (POST /api/approvals) — not authenticate-only.
    if (!(await deps.canCreateApproval(req))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const orgId = deps.orgId(req)
    if (!orgId) return res.status(403).json({ error: 'no_org' })
    const actor = deps.uploadActor(req)
    if (!actor) return res.status(401).json({ error: 'unauthenticated' })
    const f = (req as Request & { file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } }).file
    if (!f) return res.status(400).json({ error: 'file_required' })
    const fieldId = typeof req.body?.fieldId === 'string' && /[!-~]/.test(req.body.fieldId) ? req.body.fieldId : null
    const templateId = typeof req.body?.templateId === 'string' && /[!-~]/.test(req.body.templateId) ? req.body.templateId : null
    if (!fieldId || !templateId) return res.status(400).json({ error: 'template_and_field_required' })

    const target = await deps.authorizeUploadTarget(templateId, fieldId, actor)
    if (target.ok === false) {
      // not_found and not_published both 404 (no existence oracle for invisible templates)
      if (target.code === 'not_attachment_field') {
        return res.status(400).json({ error: 'not_an_attachment_field' })
      }
      return res.status(404).json({ error: 'not_found' })
    }

    const verdict = validateApprovalAttachments([{ fileName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, content: f.buffer }]) as {
      ok: boolean
      rejected?: Array<{ fileName: string; code: string }>
    }
    if (!verdict.ok) return res.status(422).json({ error: 'rejected', rejected: verdict.rejected ?? [] })

    const scanState = await runScanHook(scanHook, {
      mimeType: f.mimetype.toLowerCase().trim(),
      sizeBytes: f.size,
      content: f.buffer,
      fileName: f.originalname,
    })
    // Infected uploads still persist the row (audit evidence) but never bind/download.
    const storageKey = deriveStorageKey(f.mimetype.toLowerCase().trim())
    const id = `att_${randomUUID()}`
    await deps.store.put(storageKey, f.buffer)
    await deps.db.query(
      `INSERT INTO approval_attachments
         (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, scan_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unbound',$9)`,
      [id, orgId, uploaderId, fieldId, storageKey, f.originalname.slice(0, 255), f.mimetype.toLowerCase().trim(), f.size, scanState],
    )
    if (scanState === 'infected') {
      // Refuse to hand the client a usable id for binding; row+blob remain for GC/audit.
      return res.status(422).json({ error: 'rejected', rejected: [{ code: 'infected' }] })
    }
    return res.status(201).json({ id, sizeBytes: f.size })
  }))

  // Metadata for detail/tombstone resolution — same auth as download, no bytes (never storage keys).
  router.get(`${APPROVAL_ATTACHMENTS_PATH_PREFIX}/:id`, ...auth, asyncHandler(async (req: Request, res: Response) => {
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    const { rows } = await deps.db.query(
      `SELECT status, uploader_id, instance_id, field_id, file_name, mime_type, size_bytes,
              COALESCE(scan_state, 'unscanned') AS scan_state
         FROM approval_attachments WHERE id=$1`,
      [String(req.params.id)],
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
    const row = rows[0] as {
      status: 'unbound' | 'bound' | 'deleted'
      uploader_id: string
      instance_id: string | null
      field_id: string
      file_name: string
      mime_type: string
      size_bytes: number
      scan_state: string
    }
    const gate = await authorizeAttachmentDownload(
      { status: row.status, uploaderId: row.uploader_id, instanceId: row.instance_id, fieldId: row.field_id },
      viewerId,
      deps.authChecks,
    )
    if (gate.ok === false) {
      return gate.code === 'gone' ? res.status(410).json({ error: 'gone' }) : res.status(404).json({ error: 'not_found' })
    }
    const live = row.status !== 'deleted' && isScanStateDownloadable(row.scan_state)
    return res.status(200).json({
      id: String(req.params.id),
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      status: live ? row.status : 'deleted',
      scanState: row.scan_state,
      // Tombstone signal for detail UI — never storage keys.
      tombstone: !live,
    })
  }))

  router.get(`${APPROVAL_ATTACHMENTS_PATH_PREFIX}/:id/download`, ...auth, asyncHandler(async (req: Request, res: Response) => {
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    const { rows } = await deps.db.query(
      `SELECT status, uploader_id, instance_id, field_id, storage_key, file_name, mime_type,
              COALESCE(scan_state, 'unscanned') AS scan_state
         FROM approval_attachments WHERE id=$1`,
      [String(req.params.id)],
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
    const row = rows[0] as {
      status: 'unbound' | 'bound' | 'deleted'
      uploader_id: string
      instance_id: string | null
      field_id: string
      storage_key: string
      file_name: string
      mime_type: string
      scan_state: string
    }
    const authz = await authorizeAttachmentDownload(
      { status: row.status, uploaderId: row.uploader_id, instanceId: row.instance_id, fieldId: row.field_id },
      viewerId,
      deps.authChecks,
    )
    if (authz.ok === false) {
      return authz.code === 'gone' ? res.status(410).json({ error: 'gone' }) : res.status(404).json({ error: 'not_found' })
    }
    // Infected never downloadable (§6) — same 404 shape as hidden (no oracle for outsiders who already passed auth).
    if (!isScanStateDownloadable(row.scan_state)) {
      return res.status(404).json({ error: 'not_found' })
    }
    if (deps.storeUnavailable) {
      return res.status(503).json({ error: 'storage_unavailable' })
    }
    const blob = await deps.store.get(row.storage_key)
    res.setHeader('Content-Type', row.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    return res.status(200).send(blob)
  }))

  router.delete(`${APPROVAL_ATTACHMENTS_PATH_PREFIX}/:id`, ...auth, asyncHandler(async (req: Request, res: Response) => {
    if (deps.storeUnavailable) {
      return res.status(503).json({ error: 'storage_unavailable' })
    }
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    const id = String(req.params.id)
    const resQ = await deps.db.query(
      `WITH doomed AS (
         UPDATE approval_attachments
            SET status = 'deleted'
          WHERE id = $1 AND status = 'unbound' AND uploader_id = $2
          RETURNING id, storage_key
       )
       INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
       SELECT 'pi_del_' || d.id, d.storage_key, 'unbound_delete' FROM doomed d
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, viewerId],
    )
    if (Number(resQ.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'not_found' })
    }
    return res.status(204).send()
  }))

  return router
}
