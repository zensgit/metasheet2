/**
 * Approval attachments — upload + auth-proxied download + unbound delete routes
 * (#4195, flag-gated OFF by default).
 *
 * Dependency-injected router factory (db/store/auth seams) so the wiring point is one line at app boot and
 * everything is testable with supertest. Contracts:
 *   - REGISTERS NOTHING unless `APPROVAL_ATTACHMENTS_ENABLED === 'true'` — the factory returns null while
 *     the flag is OFF (the field stays honestly disabled; no dormant routes).
 *   - POST /api/approval/attachments — single file (multer memory, hard byte cap), reject-by-default
 *     validation, SERVER-derived key, blob put THEN row insert (`unbound`). Production with local /
 *     missing / misconfigured store → values-free 503 (O3).
 *   - GET /api/approval/attachments/:id/download — loads the row, recomputes authorization on EVERY hit,
 *     streams via the server (no public/signed URLs in v1), values-free error codes + safe headers (G8).
 *   - DELETE /api/approval/attachments/:id — uploader-only unbound doom: soft-delete + purge intent in
 *     the same txn; bound rows are refused (bound deletion only via instance cascade).
 *   - Uploader identity comes from the app's authenticated request (injected extractor) — never from the body.
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
   * Is `fieldId` an `attachment`-typed field in `templateId`'s form schema? (§4.1 / G2.) The production
   * wiring loads the template's form schema and checks the field's `type`; returns false for an unknown
   * template, an unknown field, or a non-attachment field. A false result fails the upload closed (400) —
   * an upload can never land against a non-attachment (or non-existent) field.
   */
  resolveAttachmentField(templateId: string, fieldId: string): Promise<boolean>
  env?: NodeJS.ProcessEnv
  /**
   * When true, upload/delete fail-closed with values-free 503 (production local/missing/misconfigured
   * store — O3). Download still auth-gates but may also 503 if the store cannot serve.
   */
  storeUnavailable?: boolean
  /**
   * Optional auth middleware applied ONLY to attachment routes (never global). Production wiring
   * passes `authenticate`; unit tests omit it and inject viewerId/orgId directly.
   */
  authenticate?: RequestHandler
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

  router.post('/api/approval/attachments', ...auth, runUpload, asyncHandler(async (req: Request, res: Response) => {
    // O3: production with local/missing/misconfigured provider fail-closes (never writes to deploy disk).
    if (deps.storeUnavailable) {
      return res.status(503).json({ error: 'storage_unavailable' })
    }
    const uploaderId = deps.viewerId(req)
    if (!uploaderId) return res.status(401).json({ error: 'unauthenticated' })
    const orgId = deps.orgId(req) // server-derived from the principal — never the body (no cross-tenant forgery)
    if (!orgId) return res.status(403).json({ error: 'no_org' })
    const f = (req as Request & { file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } }).file
    if (!f) return res.status(400).json({ error: 'file_required' })
    const fieldId = typeof req.body?.fieldId === 'string' && /[!-~]/.test(req.body.fieldId) ? req.body.fieldId : null
    const templateId = typeof req.body?.templateId === 'string' && /[!-~]/.test(req.body.templateId) ? req.body.templateId : null
    if (!fieldId || !templateId) return res.status(400).json({ error: 'template_and_field_required' })
    // G2: the target field MUST be an attachment-typed field in the template's form schema — else 400.
    if (!(await deps.resolveAttachmentField(templateId, fieldId))) {
      return res.status(400).json({ error: 'not_an_attachment_field' })
    }
    const verdict = validateApprovalAttachments([{ fileName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, content: f.buffer }]) as {
      ok: boolean
      rejected?: Array<{ fileName: string; code: string }>
    }
    if (!verdict.ok) return res.status(422).json({ error: 'rejected', rejected: verdict.rejected ?? [] }) // values-free codes
    const storageKey = deriveStorageKey(f.mimetype.toLowerCase().trim())
    const id = `att_${randomUUID()}`
    // blob first, row second: a crash between leaves an orphan BLOB (reconciler sweeps), never a dangling row.
    await deps.store.put(storageKey, f.buffer)
    await deps.db.query(
      `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unbound')`,
      [id, orgId, uploaderId, fieldId, storageKey, f.originalname.slice(0, 255), f.mimetype.toLowerCase().trim(), f.size],
    )
    return res.status(201).json({ id, sizeBytes: f.size })
  }))

  router.get('/api/approval/attachments/:id/download', ...auth, asyncHandler(async (req: Request, res: Response) => {
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    const { rows } = await deps.db.query(
      `SELECT status, uploader_id, instance_id, field_id, storage_key, file_name, mime_type FROM approval_attachments WHERE id=$1`,
      [String(req.params.id)],
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
    const row = rows[0] as { status: 'unbound' | 'bound' | 'deleted'; uploader_id: string; instance_id: string | null; field_id: string; storage_key: string; file_name: string; mime_type: string }
    const auth = (await authorizeAttachmentDownload(
      { status: row.status, uploaderId: row.uploader_id, instanceId: row.instance_id, fieldId: row.field_id },
      viewerId,
      deps.authChecks,
    )) as { ok: boolean; code?: 'gone' | 'not_uploader' | 'not_participant' | 'hidden' }
    if (!auth.ok) {
      // gone → 410; authorization failures → 404 (no existence oracle for outsiders)
      return auth.code === 'gone' ? res.status(410).json({ error: 'gone' }) : res.status(404).json({ error: 'not_found' })
    }
    if (deps.storeUnavailable) {
      return res.status(503).json({ error: 'storage_unavailable' })
    }
    const blob = await deps.store.get(row.storage_key)
    // G8: safe serving headers — attachment disposition, nosniff, locked CSP; never expose storage keys.
    res.setHeader('Content-Type', row.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    return res.status(200).send(blob)
  }))

  /**
   * DELETE unbound — uploader only. Atomically dooms the row (status=deleted) and enqueues a purge
   * intent in the SAME statement-transaction (claim-then-enqueue; never blob-delete inline). Bound
   * rows are refused — sanctioned bound deletion is only via instance cascade (trigger + worker).
   */
  router.delete('/api/approval/attachments/:id', ...auth, asyncHandler(async (req: Request, res: Response) => {
    if (deps.storeUnavailable) {
      return res.status(503).json({ error: 'storage_unavailable' })
    }
    const viewerId = deps.viewerId(req)
    if (!viewerId) return res.status(401).json({ error: 'unauthenticated' })
    const id = String(req.params.id)
    // Conditional claim: only unbound + owned by viewer. Bound / foreign / missing → 0 rows.
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
      // Distinguish: missing / not uploader / bound — all 404 (no existence oracle for bound rows of live instances).
      return res.status(404).json({ error: 'not_found' })
    }
    return res.status(204).send()
  }))

  return router
}
