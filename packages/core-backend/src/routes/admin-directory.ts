import type { Request, Response } from 'express'
import { Router } from 'express'
import type {
  DirectoryActivityResourceType,
  DirectoryDeprovisionPolicy,
  DirectoryLinkStatus,
  DirectoryMatchStrategy,
} from '../directory/directory-sync'
import { DirectorySyncError, directorySyncService } from '../directory/directory-sync'
import { authenticate } from '../middleware/auth'
import { isAdmin as isRbacAdmin } from '../rbac/service'
import { readErrorMessage } from '../utils/error'
import { jsonError, jsonOk, parsePagination } from '../util/response'

type DirectoryAccountListRequestFilters = {
  q: string | null
  linkStatus: DirectoryLinkStatus | null
  isActive: boolean | null
  matchStrategy: DirectoryMatchStrategy | null
  dingtalkAuthEnabled: boolean | null
  isBound: boolean | null
  departmentId: string | null
}

type DirectoryActivityRequestFilters = {
  q: string | null
  action: string | null
  resourceType: DirectoryActivityResourceType | null
  accountId: string | null
  from: string | null
  to: string | null
}

type AuditRangeBoundaryMode = 'start' | 'end'

function getRequestUserId(req: Request): string {
  const raw = req.user as Record<string, unknown> | undefined
  const userId = raw?.id ?? raw?.userId ?? raw?.sub
  return typeof userId === 'string' ? userId.trim() : ''
}

function hasLegacyAdminClaim(req: Request): boolean {
  const raw = req.user as Record<string, unknown> | undefined
  if (!raw) return false
  if (raw.role === 'admin') return true
  if (Array.isArray(raw.roles) && raw.roles.includes('admin')) return true
  if (Array.isArray(raw.perms) && (raw.perms.includes('*:*') || raw.perms.includes('admin:all'))) return true
  return false
}

async function ensurePlatformAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = getRequestUserId(req)
  if (!userId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null
  }

  const allowed = hasLegacyAdminClaim(req) || await isRbacAdmin(userId)
  if (!allowed) {
    jsonError(res, 403, 'FORBIDDEN', 'Admin access required')
    return null
  }

  return userId
}

function normalizeLinkStatus(value: unknown): DirectoryLinkStatus | null {
  if (value === 'linked' || value === 'conflict' || value === 'ignored' || value === 'pending') {
    return value
  }
  return null
}

function normalizeMatchStrategy(value: unknown): DirectoryMatchStrategy | null {
  if (value === 'external_identity' || value === 'email_exact' || value === 'mobile_exact' || value === 'manual') {
    return value
  }
  return null
}

function normalizeDeprovisionPolicy(value: unknown): DirectoryDeprovisionPolicy | null {
  if (Array.isArray(value)) {
    const normalized = Array.from(new Set(
      value.filter((item): item is DirectoryDeprovisionPolicy[number] =>
        item === 'mark_inactive' || item === 'disable_dingtalk_auth' || item === 'disable_local_user',
      ),
    ))
    return normalized.length === value.length ? normalized : null
  }

  if (value === 'mark_inactive' || value === 'disable_dingtalk_auth' || value === 'disable_local_user') {
    return [value]
  }
  return null
}

function parseIsActiveFilter(value: unknown): boolean | null {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return null
}

function parseBooleanFilter(value: unknown): boolean | null {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return null
}

function parseAuditRangeBoundary(value: unknown, mode: AuditRangeBoundaryMode): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}${mode === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
    : trimmed

  const timestamp = Date.parse(normalized)
  if (Number.isNaN(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function normalizeDirectoryActivityResourceType(value: unknown): DirectoryActivityResourceType | null {
  if (
    value === 'directory-integration'
    || value === 'directory-account'
    || value === 'directory-sync-alert'
    || value === 'directory-template-center'
  ) {
    return value
  }
  return null
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function parseAccountListFilters(req: Request): DirectoryAccountListRequestFilters {
  return {
    q: typeof req.query.q === 'string' ? req.query.q : null,
    linkStatus: normalizeLinkStatus(req.query.linkStatus),
    isActive: parseIsActiveFilter(req.query.isActive),
    matchStrategy: normalizeMatchStrategy(req.query.matchStrategy),
    dingtalkAuthEnabled: parseBooleanFilter(req.query.dingtalkAuthEnabled),
    isBound: parseBooleanFilter(req.query.isBound),
    departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : null,
  }
}

function parseActivityFilters(req: Request): DirectoryActivityRequestFilters {
  return {
    q: typeof req.query.q === 'string' ? req.query.q.trim() || null : null,
    action: typeof req.query.action === 'string' ? req.query.action.trim() || null : null,
    resourceType: normalizeDirectoryActivityResourceType(req.query.resourceType),
    accountId: typeof req.query.accountId === 'string' ? req.query.accountId.trim() || null : null,
    from: parseAuditRangeBoundary(req.query.from, 'start'),
    to: parseAuditRangeBoundary(req.query.to, 'end'),
  }
}

function handleDirectoryError(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string) {
  if (error instanceof DirectorySyncError) {
    return jsonError(res, error.status, error.code, error.message, error.details)
  }
  return jsonError(res, 500, fallbackCode, readErrorMessage(error, fallbackMessage))
}

async function ensureAccountBelongsToIntegration(integrationId: string, accountId: string): Promise<void> {
  const account = await directorySyncService.getAccount(accountId)
  if (account.integrationId !== integrationId) {
    throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
  }
}

export function adminDirectoryRouter(): Router {
  const r = Router()

  r.get('/api/admin/directory/integrations', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : null
      const items = await directorySyncService.listIntegrations(orgId)
      return jsonOk(res, { items, actorId: adminUserId })
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_INTEGRATIONS_LOAD_FAILED', 'Failed to load directory integrations')
    }
  })

  r.post('/api/admin/directory/integrations', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integration = await directorySyncService.createIntegration(req.body || {}, adminUserId)
      return jsonOk(res, integration)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_INTEGRATION_CREATE_FAILED', 'Failed to create directory integration')
    }
  })

  r.patch('/api/admin/directory/integrations/:integrationId', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const integration = await directorySyncService.updateIntegration(integrationId, req.body || {}, adminUserId)
      return jsonOk(res, integration)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_INTEGRATION_UPDATE_FAILED', 'Failed to update directory integration')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/test', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const result = await directorySyncService.testIntegration(integrationId, adminUserId)
      return jsonOk(res, result)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_INTEGRATION_TEST_FAILED', 'Failed to test directory integration')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/sync', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const run = await directorySyncService.syncIntegration(integrationId, adminUserId, { source: 'manual' })
      return jsonOk(res, run)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_SYNC_FAILED', 'Failed to run directory sync')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/runs', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const items = await directorySyncService.listRuns(integrationId)
      return jsonOk(res, { items, actorId: adminUserId })
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_RUNS_LOAD_FAILED', 'Failed to load directory sync runs')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/activity', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const { page, pageSize } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 10,
        maxPageSize: 100,
      })
      const filters = parseActivityFilters(req)
      const data = await directorySyncService.listActivity(integrationId, {
        page,
        pageSize,
        ...filters,
      })
      return jsonOk(res, data)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_ACTIVITY_LOAD_FAILED', 'Failed to load directory activity')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/activity/export.csv', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }

      const filters = parseActivityFilters(req)
      const rawLimit = Number(req.query.limit || 5000)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 10000) : 5000
      const pageSize = 100
      let page = 1
      let total = 0
      const rows: Array<Awaited<ReturnType<typeof directorySyncService.listActivity>>['items'][number]> = []

      while (rows.length < limit) {
        const result = await directorySyncService.listActivity(integrationId, {
          page,
          pageSize: Math.min(pageSize, limit - rows.length),
          ...filters,
        })
        if (page === 1) {
          total = result.total
        }
        rows.push(...result.items)
        if (!result.hasNextPage) break
        page += 1
      }

      const exportedRows = rows.slice(0, limit)
      const truncated = total > exportedRows.length
      const filename = `directory-activity-${integrationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('X-Export-Total', String(total))
      res.setHeader('X-Export-Returned', String(exportedRows.length))
      res.setHeader('X-Export-Truncated', truncated ? 'true' : 'false')
      res.write('\uFEFF')
      res.write('id,created_at,resource_type,resource_id,action,event_type,event_severity,integration_id,integration_name,account_id,account_name,account_email,actor_user_id,actor_name,actor_email,error_code,action_details\n')

      for (const item of exportedRows) {
        const line = [
          item.id,
          item.createdAt,
          item.resourceType,
          item.resourceId || '',
          item.action,
          item.eventType,
          item.eventSeverity,
          item.integrationId || '',
          item.integrationName || '',
          item.accountId || '',
          item.accountName || '',
          item.accountEmail || '',
          item.actorUserId || '',
          item.actorName || '',
          item.actorEmail || '',
          item.errorCode || '',
          JSON.stringify(item.actionDetails || {}),
        ].map(csvCell).join(',')
        res.write(`${line}\n`)
      }

      return res.end()
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_ACTIVITY_EXPORT_FAILED', 'Failed to export directory activity')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/schedule-status', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const status = await directorySyncService.getIntegrationOperationsStatus(integrationId)
      return jsonOk(res, status)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_SCHEDULE_STATUS_LOAD_FAILED', 'Failed to load directory schedule status')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/template-center', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const center = await directorySyncService.getTemplateCenter(integrationId)
      return jsonOk(res, center)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_TEMPLATE_CENTER_LOAD_FAILED', 'Failed to load directory template center')
    }
  })

  r.patch('/api/admin/directory/integrations/:integrationId/template-center', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const center = await directorySyncService.saveTemplateCenter(integrationId, req.body || {}, adminUserId)
      return jsonOk(res, center)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_TEMPLATE_CENTER_SAVE_FAILED', 'Failed to save directory template center')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/template-center/versions', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const rawLimit = Number(req.query.limit || 10)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 10
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const items = await directorySyncService.listTemplateCenterVersions(integrationId, limit)
      return jsonOk(res, { items, actorId: adminUserId })
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_TEMPLATE_CENTER_VERSIONS_LOAD_FAILED', 'Failed to load template center versions')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/template-center/versions/:versionId/restore', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const versionId = String(req.params.versionId || '').trim()
      if (!integrationId || !versionId) {
        return jsonError(res, 400, 'DIRECTORY_TEMPLATE_CENTER_VERSION_REQUIRED', 'integrationId and versionId are required')
      }
      const center = await directorySyncService.restoreTemplateCenterVersion(integrationId, versionId, adminUserId)
      return jsonOk(res, center)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_TEMPLATE_CENTER_RESTORE_FAILED', 'Failed to restore template center version')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/template-center/report', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const report = await directorySyncService.buildTemplateGovernanceReport(integrationId)
      return jsonOk(res, report)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_TEMPLATE_GOVERNANCE_REPORT_FAILED', 'Failed to build directory template governance report')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/template-center/report.csv', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }

      const report = await directorySyncService.buildTemplateGovernanceReport(integrationId)
      const filename = `directory-template-governance-${integrationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.write('\uFEFF')
      res.write('output_mode,preset_id,name,tags,favorite,pinned,use_count,last_used_at,ignored_field_count,usage_bucket\n')
      for (const preset of report.presets) {
        const line = [
          preset.outputMode,
          preset.id,
          preset.name,
          preset.tags.join(' | '),
          preset.favorite ? 'true' : 'false',
          preset.pinned ? 'true' : 'false',
          preset.useCount,
          preset.lastUsedAt || '',
          preset.ignoredFieldCount,
          preset.usageBucket,
        ].map(csvCell).join(',')
        res.write(`${line}\n`)
      }
      return res.end()
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_TEMPLATE_GOVERNANCE_EXPORT_FAILED', 'Failed to export directory template governance report')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/alerts', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const rawLimit = Number(req.query.limit || 20)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const items = await directorySyncService.listSyncAlerts(integrationId, limit)
      return jsonOk(res, { items, actorId: adminUserId })
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_SYNC_ALERTS_LOAD_FAILED', 'Failed to load directory sync alerts')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/alerts/:alertId/ack', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const alertId = String(req.params.alertId || '').trim()
      if (!integrationId || !alertId) {
        return jsonError(res, 400, 'DIRECTORY_SYNC_ALERT_ID_REQUIRED', 'integrationId and alertId are required')
      }
      const alert = await directorySyncService.acknowledgeSyncAlert(integrationId, alertId, adminUserId)
      return jsonOk(res, alert)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_SYNC_ALERT_ACK_FAILED', 'Failed to acknowledge directory sync alert')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/departments', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const items = await directorySyncService.listDepartments(integrationId)
      return jsonOk(res, { items, actorId: adminUserId })
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_DEPARTMENTS_LOAD_FAILED', 'Failed to load directory departments')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/accounts', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }
      const { page, pageSize } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })
      const filters = parseAccountListFilters(req)
      const data = await directorySyncService.listAccounts(integrationId, {
        page,
        pageSize,
        ...filters,
      })
      return jsonOk(res, data)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_ACCOUNTS_LOAD_FAILED', 'Failed to load directory accounts')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/accounts/export.csv', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      if (!integrationId) {
        return jsonError(res, 400, 'DIRECTORY_INTEGRATION_ID_REQUIRED', 'integrationId is required')
      }

      const filters = parseAccountListFilters(req)
      const rawLimit = Number(req.query.limit || 5000)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 10000) : 5000
      const pageSize = 100
      let page = 1
      let total = 0
      const rows: Array<Awaited<ReturnType<typeof directorySyncService.listAccounts>>['items'][number]> = []

      while (rows.length < limit) {
        const result = await directorySyncService.listAccounts(integrationId, {
          page,
          pageSize: Math.min(pageSize, limit - rows.length),
          ...filters,
        })
        if (page === 1) total = result.total
        rows.push(...result.items)
        if (!result.hasNextPage) break
        page += 1
      }

      const exportedRows = rows.slice(0, limit)
      const truncated = total > exportedRows.length
      const filename = `directory-accounts-${integrationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('X-Export-Total', String(total))
      res.setHeader('X-Export-Returned', String(exportedRows.length))
      res.setHeader('X-Export-Truncated', truncated ? 'true' : 'false')
      res.write('\uFEFF')
      res.write('external_user_id,name,nick,email,mobile,job_number,title,link_status,match_strategy,dingtalk_auth_enabled,is_bound,is_active,linked_user_id,linked_user_email,linked_user_name,deprovision_policy,departments,review_note\n')

      for (const item of exportedRows) {
        const line = [
          item.externalUserId,
          item.name || '',
          item.nick || '',
          item.email || '',
          item.mobile || '',
          item.jobNumber || '',
          item.title || '',
          item.linkStatus,
          item.matchStrategy || '',
          item.dingtalkAuthEnabled ? 'true' : 'false',
          item.isBound ? 'true' : 'false',
          item.isActive ? 'true' : 'false',
          item.linkedUser?.id || '',
          item.linkedUser?.email || '',
          item.linkedUser?.name || '',
          item.effectiveDeprovisionPolicy.join(' | '),
          item.departmentNames.join(' | '),
          item.reviewNote || '',
        ].map(csvCell).join(',')
        res.write(`${line}\n`)
      }

      return res.end()
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_ACCOUNTS_EXPORT_FAILED', 'Failed to export directory accounts')
    }
  })

  r.get('/api/admin/directory/integrations/:integrationId/accounts/:accountId', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      const account = await directorySyncService.getAccount(accountId)
      if (account.integrationId !== integrationId) {
        return jsonError(res, 404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
      }
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_ACCOUNT_LOAD_FAILED', 'Failed to load directory account')
    }
  })

  r.post('/api/admin/directory/accounts/:accountId/link-existing', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const accountId = String(req.params.accountId || '').trim()
      const userId = String(req.body?.userId || '').trim()
      if (!accountId || !userId) {
        return jsonError(res, 400, 'DIRECTORY_LINK_INPUT_REQUIRED', 'accountId and userId are required')
      }
      const account = await directorySyncService.linkExistingAccount(accountId, userId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_LINK_FAILED', 'Failed to link directory account')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/link-existing', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      const userId = String(req.body?.userId || '').trim()
      if (!integrationId || !accountId || !userId) {
        return jsonError(res, 400, 'DIRECTORY_LINK_INPUT_REQUIRED', 'integrationId, accountId and userId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const account = await directorySyncService.linkExistingAccount(accountId, userId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_LINK_FAILED', 'Failed to link directory account')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/auto-link-by-email', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const account = await directorySyncService.autoLinkExistingAccountByEmail(accountId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_AUTO_LINK_FAILED', 'Failed to auto-link directory account by email')
    }
  })

  r.post('/api/admin/directory/accounts/:accountId/provision-user', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const accountId = String(req.params.accountId || '').trim()
      if (!accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'accountId is required')
      }
      const result = await directorySyncService.provisionUser(accountId, {
        email: typeof req.body?.email === 'string' ? req.body.email : undefined,
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        password: typeof req.body?.password === 'string' ? req.body.password : undefined,
        authorizeDingTalk: req.body?.authorizeDingTalk === true,
        isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
      }, adminUserId)
      return jsonOk(res, result)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_PROVISION_FAILED', 'Failed to provision MetaSheet user from directory account')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/provision-user', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const result = await directorySyncService.provisionUser(accountId, {
        email: typeof req.body?.email === 'string' ? req.body.email : undefined,
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        password: typeof req.body?.password === 'string' ? req.body.password : undefined,
        authorizeDingTalk: req.body?.authorizeDingTalk === true,
        isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
      }, adminUserId)
      return jsonOk(res, result)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_PROVISION_FAILED', 'Failed to provision MetaSheet user from directory account')
    }
  })

  r.post('/api/admin/directory/accounts/:accountId/authorize-dingtalk', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const accountId = String(req.params.accountId || '').trim()
      if (!accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'accountId is required')
      }
      const enabled = req.body?.enabled !== false
      const account = await directorySyncService.authorizeDingTalk(accountId, adminUserId, enabled)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_AUTHORIZE_FAILED', 'Failed to update DingTalk authorization for directory account')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/authorize-dingtalk', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const enabled = req.body?.enabled !== false
      const account = await directorySyncService.authorizeDingTalk(accountId, adminUserId, enabled)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_AUTHORIZE_FAILED', 'Failed to update DingTalk authorization for directory account')
    }
  })

  r.post('/api/admin/directory/accounts/:accountId/ignore', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const accountId = String(req.params.accountId || '').trim()
      if (!accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'accountId is required')
      }
      const account = await directorySyncService.ignoreAccount(accountId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_IGNORE_FAILED', 'Failed to ignore directory account')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/ignore', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const account = await directorySyncService.ignoreAccount(accountId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_IGNORE_FAILED', 'Failed to ignore directory account')
    }
  })

  r.post('/api/admin/directory/accounts/:accountId/unlink', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const accountId = String(req.params.accountId || '').trim()
      if (!accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'accountId is required')
      }
      const account = await directorySyncService.unlinkAccount(accountId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_UNLINK_FAILED', 'Failed to unlink directory account')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/unlink', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const account = await directorySyncService.unlinkAccount(accountId, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_UNLINK_FAILED', 'Failed to unlink directory account')
    }
  })

  r.post('/api/admin/directory/accounts/:accountId/deprovision-policy', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const accountId = String(req.params.accountId || '').trim()
      if (!accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'accountId is required')
      }
      const policy = req.body?.policy === null ? null : normalizeDeprovisionPolicy(req.body?.policy)
      if (req.body?.policy !== null && !policy) {
        return jsonError(res, 400, 'DIRECTORY_DEPROVISION_POLICY_INVALID', 'Invalid deprovision policy')
      }
      const account = await directorySyncService.updateDeprovisionPolicy(accountId, policy, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_DEPROVISION_POLICY_FAILED', 'Failed to update deprovision policy')
    }
  })

  r.post('/api/admin/directory/integrations/:integrationId/accounts/:accountId/deprovision-policy', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = String(req.params.integrationId || '').trim()
      const accountId = String(req.params.accountId || '').trim()
      if (!integrationId || !accountId) {
        return jsonError(res, 400, 'DIRECTORY_ACCOUNT_ID_REQUIRED', 'integrationId and accountId are required')
      }
      await ensureAccountBelongsToIntegration(integrationId, accountId)
      const policy = req.body?.policy === null ? null : normalizeDeprovisionPolicy(req.body?.policy)
      if (req.body?.policy !== null && !policy) {
        return jsonError(res, 400, 'DIRECTORY_DEPROVISION_POLICY_INVALID', 'Invalid deprovision policy')
      }
      const account = await directorySyncService.updateDeprovisionPolicy(accountId, policy, adminUserId)
      return jsonOk(res, account)
    } catch (error) {
      return handleDirectoryError(res, error, 'DIRECTORY_DEPROVISION_POLICY_FAILED', 'Failed to update deprovision policy')
    }
  })

  return r
}

export async function initializeAdminDirectorySchedules(): Promise<void> {
  await directorySyncService.initializeSchedules()
}

export async function shutdownAdminDirectorySchedules(): Promise<void> {
  await directorySyncService.shutdown()
}
