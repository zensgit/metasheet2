import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { apiPathEquals, apiPathHasPrefix, isApiPath } from '../auth/api-path-policy'
import { Logger, getLogContext } from '../core/logger'
import { query } from '../db/pg'
import { TokenBucketRateLimiter } from '../integration/rate-limiting/token-bucket'
import {
  attendanceApiErrorsTotal,
  attendanceImportElapsedSeconds,
  attendanceImportFailedRowsTotal,
  attendanceImportProcessedRowsTotal,
  attendanceImportUploadBytesTotal,
  attendanceImportUploadRowsTotal,
  attendanceOperationFailuresTotal,
  attendanceOperationLatencySeconds,
  attendanceOperationRequestsTotal,
  attendanceRateLimitedTotal,
} from '../metrics/attendance-metrics'

type AttendanceSettings = {
  ipAllowlist: string[]
}

const logger = new Logger('AttendanceProduction')

// The two API subtrees these middlewares govern. Declared once and compared through the shared policy
// (`apiPathHasPrefix`) so the audit trail, the IP allowlist and the rate limiter recognise the same
// requests as the session gate does.
const ATTENDANCE_PREFIX = '/api/attendance'
const ATTENDANCE_ADMIN_PREFIX = '/api/attendance-admin'
const ATTENDANCE_IMPORT_PREFIX = '/api/attendance/import'

const SETTINGS_KEY = 'attendance.settings'
const SETTINGS_CACHE_TTL_MS = 10_000

let settingsCache: { loadedAt: number; value: AttendanceSettings } = {
  loadedAt: 0,
  value: { ipAllowlist: [] },
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((v) => String(v || '').trim()).filter(Boolean)
}

async function loadAttendanceSettings(): Promise<AttendanceSettings> {
  if (Date.now() - settingsCache.loadedAt < SETTINGS_CACHE_TTL_MS) return settingsCache.value
  try {
    const { rows } = await query<{ value: string }>(
      'SELECT value FROM system_configs WHERE key = $1',
      [SETTINGS_KEY],
    )
    if (!rows.length) {
      settingsCache = { loadedAt: Date.now(), value: { ipAllowlist: [] } }
      return settingsCache.value
    }
    const parsed = JSON.parse(rows[0].value || '{}')
    const next: AttendanceSettings = {
      ipAllowlist: toStringArray((parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>).ipAllowlist : []),
    }
    settingsCache = { loadedAt: Date.now(), value: next }
    return next
  } catch (error) {
    // Fail open: allow traffic if settings cannot be loaded.
    logger.warn('Failed to load attendance.settings; continuing without allowlist enforcement', error as Error)
    settingsCache = { loadedAt: Date.now(), value: { ipAllowlist: [] } }
    return settingsCache.value
  }
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const raw = header ? String(header).split(',')[0]?.trim() : req.ip
  if (!raw) return ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function isIpAllowed(ip: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true
  const normalized = ip.trim()
  return allowlist.some((entry) => {
    if (!entry) return false
    const rule = entry.trim()
    if (!rule) return false
    if (rule.endsWith('*')) {
      const prefix = rule.slice(0, -1)
      return normalized.startsWith(prefix)
    }
    if (rule.includes('/')) {
      const [base, mask] = rule.split('/')
      if (mask === '32') return normalized === base
      if (mask === '24') {
        const prefix = base.split('.').slice(0, 3).join('.') + '.'
        return normalized.startsWith(prefix)
      }
      return normalized === base
    }
    return normalized === rule
  })
}

function normalizeRouteForLabels(pathname: string): string {
  // Replace UUID-like segments and numeric segments with :id for low-cardinality labels.
  // Case-folded first, for the same reason the shared path policy is case-insensitive: the router
  // treats path case as insignificant, so two spellings of one route must produce ONE label (and one
  // audit `route` value) rather than two.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return (pathname || '')
    .toLowerCase()
    .split('/')
    .map((seg) => {
      if (!seg) return seg
      if (uuidRe.test(seg)) return ':id'
      if (/^\d+$/.test(seg)) return ':id'
      return seg
    })
    .join('/')
}

function normalizeFailureReason(errorCode: string | null, statusCode: number): string {
  const source = errorCode && errorCode.trim() ? errorCode : `HTTP_${statusCode}`
  const normalized = source
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!normalized) return 'UNKNOWN'
  return normalized.slice(0, 64)
}

function statusClassOf(statusCode: number): string {
  if (!Number.isFinite(statusCode)) return 'unknown'
  return `${Math.floor(statusCode / 100)}xx`
}

/**
 * Operation labels, keyed by (method, normalized route). Routes are compared through the shared policy
 * (`apiPathEquals`) so this table recognises the same routes as the gate and the limiter.
 * §7.6 `notification_redeliver` is a send-triggering, platform-admin-only mutation — it gets a
 * first-class label instead of the `other` bucket so the audit trail (and metrics) name the action.
 */
const ATTENDANCE_OPERATION_LABELS: readonly { method: string; route: string; operation: string }[] = [
  { method: 'POST', route: `${ATTENDANCE_IMPORT_PREFIX}/preview`, operation: 'import_preview' },
  { method: 'POST', route: `${ATTENDANCE_IMPORT_PREFIX}/preview-async`, operation: 'import_preview_async' },
  { method: 'POST', route: `${ATTENDANCE_IMPORT_PREFIX}/upload`, operation: 'import_upload' },
  { method: 'POST', route: `${ATTENDANCE_IMPORT_PREFIX}/upload-artifact`, operation: 'import_artifact_upload' },
  { method: 'POST', route: `${ATTENDANCE_IMPORT_PREFIX}/commit`, operation: 'import_commit' },
  { method: 'POST', route: `${ATTENDANCE_IMPORT_PREFIX}/commit-async`, operation: 'import_commit_async' },
  { method: 'GET', route: `${ATTENDANCE_IMPORT_PREFIX}/jobs/:id`, operation: 'import_job_poll' },
  { method: 'GET', route: `${ATTENDANCE_IMPORT_PREFIX}/batches/:id/export.csv`, operation: 'import_export_csv' },
  { method: 'POST', route: `${ATTENDANCE_PREFIX}/requests`, operation: 'request_create' },
  { method: 'POST', route: `${ATTENDANCE_PREFIX}/requests/:id/approve`, operation: 'request_approve' },
  { method: 'POST', route: `${ATTENDANCE_PREFIX}/requests/:id/reject`, operation: 'request_reject' },
  { method: 'POST', route: `${ATTENDANCE_PREFIX}/punch`, operation: 'punch' },
  { method: 'POST', route: `${ATTENDANCE_ADMIN_PREFIX}/users/batch/roles/assign`, operation: 'admin_batch_assign' },
  { method: 'POST', route: `${ATTENDANCE_ADMIN_PREFIX}/users/batch/roles/unassign`, operation: 'admin_batch_unassign' },
  { method: 'POST', route: `${ATTENDANCE_ADMIN_PREFIX}/notification-deliveries/:id/redeliver`, operation: 'notification_redeliver' },
]

function resolveAttendanceOperation(req: Request, normalizedRoute: string): string {
  const method = req.method.toUpperCase()
  const hit = ATTENDANCE_OPERATION_LABELS.find(
    (entry) => entry.method === method && apiPathEquals(normalizedRoute, entry.route),
  )
  return hit ? hit.operation : 'other'
}

const importTelemetryOperations = new Set([
  'import_preview',
  'import_preview_async',
  'import_commit',
  'import_commit_async',
  'import_job_poll',
])

function parseNonNegativeNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  return numeric
}

function normalizeImportEngine(value: unknown): 'standard' | 'bulk' | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'standard' || normalized === 'bulk') return normalized
  return null
}

/**
 * The chokepoint for BOTH attendance middlewares: `attendanceAuditMiddleware` (the audit trail) and
 * `attendanceSecurityMiddleware` (the IP allowlist + the rate limiter) each return early when this is
 * false. It therefore has to recognise exactly the same attendance requests the router will route —
 * which is why it goes through the shared API path policy rather than testing path literals itself.
 */
function shouldAudit(req: Request): boolean {
  if (!isApiPath(req.path)) return false
  if (apiPathHasPrefix(req.path, ATTENDANCE_PREFIX)) return true
  if (apiPathHasPrefix(req.path, ATTENDANCE_ADMIN_PREFIX)) return true
  return false
}

function shouldLogAuditForRequest(req: Request): boolean {
  // Default to write operations + exports. Avoid logging high-volume reads.
  if (req.method !== 'GET') return true
  const path = (req.path || '').toLowerCase()
  return path.endsWith('.csv') || path.includes('/export')
}

function pickUserId(req: Request): string | null {
  const user = req.user as Record<string, unknown> | undefined
  const raw = user?.id ?? user?.sub ?? user?.userId
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

function extractResourceId(req: Request, captured: { batchId?: string; requestId?: string; targetUserId?: string }): string | null {
  const uploadFileId = (captured as { uploadFileId?: string }).uploadFileId
  if (uploadFileId) return uploadFileId
  if (captured.batchId) return captured.batchId
  if (captured.requestId) return captured.requestId
  if (captured.targetUserId) return captured.targetUserId
  const parts = String(req.path || '').split('/').filter(Boolean)
  // Try common patterns:
  // /api/attendance/import/batches/:id/...
  const batchIdx = parts.indexOf('batches')
  if (batchIdx >= 0 && parts[batchIdx + 1]) return parts[batchIdx + 1]
  // /api/attendance/requests/:id/...
  const reqIdx = parts.indexOf('requests')
  if (reqIdx >= 0 && parts[reqIdx + 1]) return parts[reqIdx + 1]
  // /api/attendance-admin/users/:userId/...
  const usersIdx = parts.indexOf('users')
  if (usersIdx >= 0 && parts[usersIdx + 1]) return parts[usersIdx + 1]
  // /api/attendance-admin/notification-deliveries/:deliveryId/redeliver — extract the delivery id so
  // the §7.6 redelivery audit row is keyed to the exact row acted on, not NULL.
  const ndIdx = parts.indexOf('notification-deliveries')
  if (ndIdx >= 0 && parts[ndIdx + 1]) return parts[ndIdx + 1]
  return null
}

function sanitizeErrorMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null
  const trimmed = message.trim().replace(/[\r\n]+/g, ' ')
  if (!trimmed) return null
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed
}

function redactBodyKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const keys = Object.keys(input as Record<string, unknown>)
  const redacted = new Set(['token', 'auth', 'authorization', 'commitToken', 'csvText'])
  return keys.filter((k) => !redacted.has(k)).slice(0, 50)
}

export function attendanceAuditMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!shouldAudit(req)) return next()

    const startNs = process.hrtime.bigint()
    const normalizedRoute = normalizeRouteForLabels(req.path)
    const method = req.method
    const ip = getClientIp(req)
    const userAgent = String(req.headers['user-agent'] || '')
    const requestId = getLogContext()?.requestId ?? String(req.headers['x-request-id'] || '')
    const actorId = pickUserId(req)

    let responseOk: boolean | null = null
    let errorCode: string | null = null
    let errorMessage: string | null = null
    const captured: {
      batchId?: string
      requestId?: string
      targetUserId?: string
      uploadFileId?: string
      uploadBytes?: number
      uploadRows?: number
      importEngine?: string
      importProcessedRows?: number
      importFailedRows?: number
      importElapsedMs?: number
    } = {}

    const originalJson = res.json.bind(res)
    res.json = (body: unknown) => {
      try {
        if (body && typeof body === 'object') {
          const obj = body as Record<string, unknown>
          if (typeof obj.ok === 'boolean') responseOk = obj.ok
          const err = obj.error as Record<string, unknown> | undefined
          if (err && typeof err === 'object') {
            if (typeof err.code === 'string' && err.code.trim()) errorCode = err.code.trim()
            errorMessage = sanitizeErrorMessage(err.message)
          }
          const data = obj.data as Record<string, unknown> | undefined
          if (data && typeof data === 'object') {
            if (typeof data.batchId === 'string') captured.batchId = data.batchId
            if (typeof data.fileId === 'string') captured.uploadFileId = data.fileId
            if (typeof data.bytes === 'number' && Number.isFinite(data.bytes)) captured.uploadBytes = data.bytes
            if (typeof data.rowCount === 'number' && Number.isFinite(data.rowCount)) captured.uploadRows = data.rowCount
            const telemetrySource = (data.job && typeof data.job === 'object')
              ? (data.job as Record<string, unknown>)
              : data
            const engine = normalizeImportEngine(telemetrySource.engine)
            const processedRows = parseNonNegativeNumber(telemetrySource.processedRows)
            const failedRows = parseNonNegativeNumber(telemetrySource.failedRows)
            const elapsedMs = parseNonNegativeNumber(telemetrySource.elapsedMs)
            if (engine) captured.importEngine = engine
            if (processedRows !== null) captured.importProcessedRows = processedRows
            if (failedRows !== null) captured.importFailedRows = failedRows
            if (elapsedMs !== null) captured.importElapsedMs = elapsedMs
          }
        }
      } catch {
        // ignore capture errors
      }
      return originalJson(body)
    }

    res.on('finish', async () => {
      try {
        if (!shouldLogAuditForRequest(req)) return

        const durMs = Number(process.hrtime.bigint() - startNs) / 1e6
        const statusCode = res.statusCode
        const op = resolveAttendanceOperation(req, normalizedRoute)
        const requestResult = (statusCode >= 400 || responseOk === false) ? 'error' : 'ok'

        attendanceOperationRequestsTotal.inc({ operation: op, result: requestResult })
        attendanceOperationLatencySeconds.observe(
          { operation: op, result: requestResult },
          Math.max(0, durMs / 1000),
        )

        if (op === 'import_upload' && requestResult === 'ok') {
          if (typeof captured.uploadBytes === 'number' && captured.uploadBytes >= 0) {
            attendanceImportUploadBytesTotal.inc(captured.uploadBytes)
          }
          if (typeof captured.uploadRows === 'number' && captured.uploadRows >= 0) {
            attendanceImportUploadRowsTotal.inc(captured.uploadRows)
          }
        }
        if (importTelemetryOperations.has(op) && requestResult === 'ok') {
          const engine = normalizeImportEngine(captured.importEngine)
          if (engine) {
            if (typeof captured.importProcessedRows === 'number' && captured.importProcessedRows >= 0) {
              attendanceImportProcessedRowsTotal.inc(
                { operation: op, engine },
                captured.importProcessedRows,
              )
            }
            if (typeof captured.importFailedRows === 'number' && captured.importFailedRows >= 0) {
              attendanceImportFailedRowsTotal.inc(
                { operation: op, engine },
                captured.importFailedRows,
              )
            }
            if (typeof captured.importElapsedMs === 'number' && captured.importElapsedMs >= 0) {
              attendanceImportElapsedSeconds.observe(
                { operation: op, engine },
                Math.max(0, captured.importElapsedMs / 1000),
              )
            }
          }
        }

        // Metrics: record only error responses, avoid unbounded series.
        if (statusCode >= 400 || responseOk === false) {
          const code = errorCode || `HTTP_${statusCode}`
          attendanceApiErrorsTotal.inc({
            route: normalizedRoute,
            method,
            status: String(statusCode),
            error_code: code,
          })
          attendanceOperationFailuresTotal.inc({
            operation: op,
            reason: normalizeFailureReason(errorCode, statusCode),
            status_class: statusClassOf(statusCode),
          })
        }

        const action = `attendance_http:${method}:${normalizedRoute}`
        const resourceType = 'attendance'
        const resourceId = extractResourceId(req, captured)
        // Values-free per-operation audit extras a handler may attach via res.locals (e.g. the §7.6
        // redelivery route records org_id / channel / old_status / result). Never PII by contract —
        // the handler is responsible for putting only enums/ids-of-scope here, no recipient/body.
        const auditExtra = (res.locals && typeof res.locals.attendanceAuditExtra === 'object' && res.locals.attendanceAuditExtra !== null)
          ? res.locals.attendanceAuditExtra as Record<string, unknown>
          : null
        const meta = {
          ok: responseOk,
          operation: op,
          error: errorCode ? { code: errorCode, message: errorMessage } : null,
          request: {
            method,
            route: normalizedRoute,
            path: req.path,
            queryKeys: Object.keys(req.query || {}).slice(0, 50),
            bodyKeys: redactBodyKeys(req.body),
          },
          ...(auditExtra ? { redelivery: auditExtra } : {}),
        }

        // Best effort insert; do not block the request lifecycle on audit issues.
        await query(
          `INSERT INTO operation_audit_logs (
            actor_id,
            actor_type,
            action,
            resource_type,
            resource_id,
            request_id,
            ip,
            user_agent,
            route,
            status_code,
            latency_ms,
            meta,
            occurred_at,
            created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now(), now())`,
          [
            actorId,
            actorId ? 'user' : null,
            action,
            resourceType,
            resourceId,
            requestId || null,
            ip || null,
            userAgent || null,
            normalizedRoute,
            statusCode,
            Math.round(durMs),
            JSON.stringify(meta),
          ],
        )
      } catch (error) {
        logger.warn('Attendance audit insert failed', error as Error)
      }
    })

    next()
  }
}

function makeLimiter(perMinuteDefault: number): TokenBucketRateLimiter {
  const perMinRaw = Number.isFinite(Number(perMinuteDefault)) ? Number(perMinuteDefault) : 60
  const perMin = Math.max(1, perMinRaw)
  const tokensPerSecond = perMin / 60
  return new TokenBucketRateLimiter({
    tokensPerSecond,
    bucketCapacity: Math.max(2, Math.ceil(perMin / 6)), // ~10s burst by default
    enableMetrics: false,
  })
}

const importPrepareLimiter = makeLimiter(Number(process.env.ATTENDANCE_RATE_LIMIT_IMPORT_PREPARE_PER_MIN ?? 120))
const importPreviewLimiter = makeLimiter(Number(process.env.ATTENDANCE_RATE_LIMIT_IMPORT_PREVIEW_PER_MIN ?? 60))
const importCommitLimiter = makeLimiter(Number(process.env.ATTENDANCE_RATE_LIMIT_IMPORT_COMMIT_PER_MIN ?? 10))
const exportLimiter = makeLimiter(Number(process.env.ATTENDANCE_RATE_LIMIT_EXPORT_PER_MIN ?? 60))
const attendanceAdminWriteLimiter = makeLimiter(Number(process.env.ATTENDANCE_RATE_LIMIT_ADMIN_WRITE_PER_MIN ?? 120))

/** True for a GET whose path ends in the CSV export suffix, compared case-insensitively like the router. */
function isCsvExportPath(path: string): boolean {
  return (path || '').toLowerCase().endsWith('/export.csv')
}

function pickLimiter(req: Request): { limiter: TokenBucketRateLimiter; keyPrefix: string } | null {
  const path = req.path
  if (!isApiPath(path)) return null

  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/prepare`) && req.method === 'POST') {
    return { limiter: importPrepareLimiter, keyPrefix: 'attendance_import_prepare' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/preview`) && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_preview' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/preview-async`) && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_preview_async' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/upload`) && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_upload' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/upload-artifact`) && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_artifact_upload' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/commit`) && req.method === 'POST') {
    return { limiter: importCommitLimiter, keyPrefix: 'attendance_import_commit' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/commit-async`) && req.method === 'POST') {
    return { limiter: importCommitLimiter, keyPrefix: 'attendance_import_commit_async' }
  }
  if (apiPathEquals(path, `${ATTENDANCE_PREFIX}/export`) && req.method === 'GET') {
    return { limiter: exportLimiter, keyPrefix: 'attendance_export' }
  }
  if (isCsvExportPath(path) && req.method === 'GET') {
    return { limiter: exportLimiter, keyPrefix: 'attendance_export_csv' }
  }
  if (apiPathHasPrefix(path, ATTENDANCE_ADMIN_PREFIX) && req.method !== 'GET') {
    return { limiter: attendanceAdminWriteLimiter, keyPrefix: 'attendance_admin_write' }
  }
  return null
}

function shouldEnforceAllowlist(req: Request): boolean {
  const path = req.path
  if (apiPathHasPrefix(path, ATTENDANCE_IMPORT_PREFIX)) return true
  if (apiPathHasPrefix(path, ATTENDANCE_ADMIN_PREFIX)) return true
  if (apiPathEquals(path, `${ATTENDANCE_PREFIX}/export`)) return true
  if (isCsvExportPath(path)) return true
  return false
}

export function attendanceSecurityMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!shouldAudit(req)) return next()

    // IP allowlist
    if (shouldEnforceAllowlist(req)) {
      const settings = await loadAttendanceSettings()
      if (settings.ipAllowlist.length > 0) {
        const ip = getClientIp(req)
        if (!isIpAllowed(ip, settings.ipAllowlist)) {
          res.status(403).json({ ok: false, error: { code: 'IP_RESTRICTED', message: 'Request not allowed from this IP' } })
          return
        }
      }
    }

    // Rate limiting (enabled by default in production; can be forced off).
    const enabled = process.env.ATTENDANCE_RATE_LIMIT_ENABLED
      ? process.env.ATTENDANCE_RATE_LIMIT_ENABLED === 'true'
      : process.env.NODE_ENV === 'production'
    if (!enabled) return next()

    const picked = pickLimiter(req)
    if (!picked) return next()

    const userId = pickUserId(req) || 'anonymous'
    const ip = getClientIp(req) || 'unknown'
    const key = `${picked.keyPrefix}:${userId}:${ip}`
    const result = picked.limiter.consume(key, 1)
    if (result.allowed) return next()

    const routeLabel = normalizeRouteForLabels(req.path)
    attendanceRateLimitedTotal.inc({ route: routeLabel, method: req.method })
    res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
    res.status(429).json({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please retry later.',
        retryAfterMs: result.retryAfterMs,
      },
    })
  }
}
