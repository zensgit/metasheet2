import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { Logger, getLogContext } from '../core/logger'
import { query } from '../db/pg'
import { TokenBucketRateLimiter } from '../integration/rate-limiting/token-bucket'
import {
  attendanceApiErrorsTotal,
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
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return pathname
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

function resolveAttendanceOperation(req: Request, normalizedRoute: string): string {
  const method = req.method.toUpperCase()
  if (method === 'POST' && normalizedRoute === '/api/attendance/import/preview') return 'import_preview'
  if (method === 'POST' && normalizedRoute === '/api/attendance/import/preview-async') return 'import_preview_async'
  if (method === 'POST' && normalizedRoute === '/api/attendance/import/upload') return 'import_upload'
  if (method === 'POST' && normalizedRoute === '/api/attendance/import/commit') return 'import_commit'
  if (method === 'POST' && normalizedRoute === '/api/attendance/import/commit-async') return 'import_commit_async'
  if (method === 'GET' && normalizedRoute === '/api/attendance/import/jobs/:id') return 'import_job_poll'
  if (method === 'GET' && normalizedRoute === '/api/attendance/import/batches/:id/export.csv') return 'import_export_csv'
  if (method === 'POST' && normalizedRoute === '/api/attendance/requests') return 'request_create'
  if (method === 'POST' && normalizedRoute === '/api/attendance/requests/:id/approve') return 'request_approve'
  if (method === 'POST' && normalizedRoute === '/api/attendance/requests/:id/reject') return 'request_reject'
  if (method === 'POST' && normalizedRoute === '/api/attendance/punch') return 'punch'
  if (method === 'POST' && normalizedRoute === '/api/attendance-admin/users/batch/roles/assign') return 'admin_batch_assign'
  if (method === 'POST' && normalizedRoute === '/api/attendance-admin/users/batch/roles/unassign') return 'admin_batch_unassign'
  return 'other'
}

function shouldAudit(req: Request): boolean {
  if (!req.path.startsWith('/api/')) return false
  if (req.path.startsWith('/api/attendance/')) return true
  if (req.path.startsWith('/api/attendance-admin/')) return true
  return false
}

function shouldLogAuditForRequest(req: Request): boolean {
  // Default to write operations + exports. Avoid logging high-volume reads.
  if (req.method !== 'GET') return true
  return req.path.endsWith('.csv') || req.path.includes('/export')
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
    const captured: { batchId?: string; requestId?: string; targetUserId?: string; uploadFileId?: string; uploadBytes?: number; uploadRows?: number } = {}

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
        const meta = {
          ok: responseOk,
          error: errorCode ? { code: errorCode, message: errorMessage } : null,
          request: {
            method,
            route: normalizedRoute,
            path: req.path,
            queryKeys: Object.keys(req.query || {}).slice(0, 50),
            bodyKeys: redactBodyKeys(req.body),
          },
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

function pickLimiter(req: Request): { limiter: TokenBucketRateLimiter; keyPrefix: string } | null {
  const path = req.path
  if (!path.startsWith('/api/')) return null

  if (path === '/api/attendance/import/prepare' && req.method === 'POST') {
    return { limiter: importPrepareLimiter, keyPrefix: 'attendance_import_prepare' }
  }
  if (path === '/api/attendance/import/preview' && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_preview' }
  }
  if (path === '/api/attendance/import/preview-async' && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_preview_async' }
  }
  if (path === '/api/attendance/import/upload' && req.method === 'POST') {
    return { limiter: importPreviewLimiter, keyPrefix: 'attendance_import_upload' }
  }
  if (path === '/api/attendance/import/commit' && req.method === 'POST') {
    return { limiter: importCommitLimiter, keyPrefix: 'attendance_import_commit' }
  }
  if (path === '/api/attendance/import/commit-async' && req.method === 'POST') {
    return { limiter: importCommitLimiter, keyPrefix: 'attendance_import_commit_async' }
  }
  if (path === '/api/attendance/export' && req.method === 'GET') {
    return { limiter: exportLimiter, keyPrefix: 'attendance_export' }
  }
  if (path.endsWith('/export.csv') && req.method === 'GET') {
    return { limiter: exportLimiter, keyPrefix: 'attendance_export_csv' }
  }
  if (path.startsWith('/api/attendance-admin/') && req.method !== 'GET') {
    return { limiter: attendanceAdminWriteLimiter, keyPrefix: 'attendance_admin_write' }
  }
  return null
}

function shouldEnforceAllowlist(req: Request): boolean {
  const path = req.path
  if (path.startsWith('/api/attendance/import/')) return true
  if (path.startsWith('/api/attendance-admin/')) return true
  if (path === '/api/attendance/export') return true
  if (path.endsWith('/export.csv')) return true
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
