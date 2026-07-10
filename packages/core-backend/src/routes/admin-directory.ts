import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import {
  DirectorySyncInProgressError,
  acknowledgeDirectorySyncAlert,
  admitDirectoryAccountUser,
  batchAdmitDirectoryAccountUsers,
  batchBindDirectoryAccounts,
  batchUnbindDirectoryAccounts,
  bindDirectoryAccount,
  createDirectoryIntegration,
  getDirectorySyncScheduleSnapshot,
  getDirectoryAccountSummary,
  getDirectoryReviewItem,
  listDirectoryIntegrationAccounts,
  listDirectoryIntegrationDepartments,
  listDirectoryIntegrations,
  listDirectoryReviewItems,
  listDirectorySyncAlerts,
  listDirectorySyncRuns,
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
  testDirectoryIntegration,
  unbindDirectoryAccount,
  updateDirectoryIntegration,
} from '../directory/directory-sync'
import { getDirectoryManagerBindingCoverage } from '../directory/directory-sync-alert-delivery'
import {
  getDingTalkWorkNotificationRuntimeStatusFromStore,
  saveDingTalkWorkNotificationAgentId,
  testDingTalkWorkNotificationAgentId,
} from '../integrations/dingtalk/work-notification-settings'
import {
  generateApprovalCardLinkSecret,
  getApprovalCardConfigStatus,
  saveApprovalCardPublicAppUrl,
} from '../integrations/dingtalk/approval-card-config'
import { refreshDirectoryIntegrationSchedule } from '../directory/directory-sync-scheduler'
import { isAdmin as isRbacAdmin } from '../rbac/service'
// Roadmap §7.8 "Validate cron at save time" — see `isDirectoryScheduleCronValid` below for why this is
// `SimpleCronExpression` (the SAME class `directory-sync-scheduler.ts` uses to actually run the job) rather
// than the multitable automation scheduler's own cron parser.
import { SimpleCronExpression } from '../services/SchedulerService'
import { jsonError, jsonOk, parsePagination } from '../util/response'

const logger = new Logger('AdminDirectoryRoutes')

function normalizeAlertFilter(value: unknown): 'all' | 'pending' | 'acknowledged' {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized === 'pending' || normalized === 'acknowledged') return normalized
  return 'all'
}

function normalizeReviewFilter(value: unknown): 'all' | 'pending_binding' | 'inactive_linked' | 'missing_identifier' {
  const normalized = typeof value === 'string' ? value.trim() : ''
  switch (normalized) {
    case 'pending_binding':
    case 'inactive_linked':
    case 'missing_identifier':
      return normalized
    case 'needs_binding':
      return 'pending_binding'
    case 'missing_identity':
      return 'missing_identifier'
    default:
      return 'all'
  }
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}

// Mirrors `directory-sync.ts`'s private `normalizeText` so the save-time gate below sees exactly the same
// "is this actually empty" verdict the persistence layer will compute from the same field (empty/null/
// undefined/non-string junk all normalize to '' = "no schedule", which stays allowed).
function normalizeScheduleCronInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

/**
 * Roadmap §7.8 "Validate cron at save time": `schedule_cron` used to flow straight from the request body
 * into `directory_integrations.schedule_cron` with no validator anywhere on this path. An invalid or
 * unschedulable expression was silently accepted by the DB write, then silently swallowed again later —
 * `directory-sync-scheduler.ts`'s `applySchedule` calls `scheduler.schedule()`/`reschedule()`, which throws
 * on a bad expression; the catch block just does `logger.warn(...)` and leaves the job unscheduled. The
 * admin believes they scheduled a sync and nothing ever runs, with no error surfaced anywhere.
 *
 * DELIBERATELY uses `SimpleCronExpression` (`services/SchedulerService.ts`) rather than the multitable
 * automation scheduler's own cron parser (`multitable/automation-scheduler.ts`'s `parseCronExpression` /
 * `cronHasNoMatchingDay`). Both parse the standard 5-field grammar, but they are two INDEPENDENT
 * implementations that disagree on day-of-month + day-of-week combination semantics: the multitable parser
 * uses standard cron OR-semantics (either restriction can match), while `SimpleCronExpression.matches()`
 * ANDs every field. E.g. `0 0 30 2 1` (a Monday in February) is schedulable under OR-semantics but is
 * IMPOSSIBLE under `SimpleCronExpression`'s AND-semantics (no February ever has a 30th, so `hasNext()` never
 * finds a match) — `directory-sync-scheduler.ts` runs on `SimpleCronExpression`, so validating against the
 * multitable parser would have let that expression save as "valid" while the scheduler silently dropped it
 * forever, defeating the entire point of this gate. Reusing `SimpleCronExpression` itself — already the
 * underlying lib the directory scheduler depends on (`directory-sync-scheduler.ts` → `SchedulerServiceImpl`
 * → `SimpleCronExpression`) — guarantees byte-for-byte parity with what will actually be scheduled, at the
 * cost of a bounded scan (up to ~366 days of minutes; ~40ms worst case, measured) instead of an O(1) check.
 *
 * TIMEZONE: the directory sync scheduler always runs `schedule_cron` in UTC — `directory-sync-scheduler.ts`
 * hardcodes `timezone: 'UTC'` at `applySchedule`, and this validates with the same fixed `'UTC'`. There is
 * no per-integration timezone yet (roadmap §7.8 "Add timezone support" is a separate, not-yet-built
 * follow-up); a `schedule_cron` saved here is UTC wall-clock time, not the admin's local timezone.
 */
function isDirectoryScheduleCronValid(cron: string): boolean {
  try {
    return new SimpleCronExpression(cron, 'UTC').hasNext()
  } catch {
    return false
  }
}

const DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE =
  'scheduleCron is not a valid schedule. Expected a standard 5-field cron expression ' +
  '(minute hour dayOfMonth month dayOfWeek — e.g. "0 2 * * *") that resolves to at least one execution ' +
  'within the next year (day-of-month and day-of-week restrictions combine with AND, so e.g. a day-of-month ' +
  'that never falls on the requested weekday is rejected). DingTalk directory sync always runs on UTC ' +
  'wall-clock time — per-integration timezones are not supported yet. Leave scheduleCron empty to disable ' +
  'the scheduled sync.'

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
  if (Array.isArray(raw.permissions) && raw.permissions.includes('*:*')) return true
  if (Array.isArray(raw.perms) && raw.perms.includes('*:*')) return true
  return false
}

async function ensurePlatformAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = getRequestUserId(req)
  if (!userId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null
  }

  if (hasLegacyAdminClaim(req) || await isRbacAdmin(userId)) {
    return userId
  }

  jsonError(res, 403, 'FORBIDDEN', 'Admin access required')
  return null
}

export function adminDirectoryRouter(): Router {
  const router = Router()

  router.get('/dingtalk/work-notification', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integrationId = typeof req.query.integrationId === 'string' ? req.query.integrationId : undefined
      const status = await getDingTalkWorkNotificationRuntimeStatusFromStore(integrationId)
      jsonOk(res, { status })
    } catch (error) {
      jsonError(res, 500, 'DINGTALK_WORK_NOTIFICATION_STATUS_FAILED', readErrorMessage(error, 'Failed to load DingTalk work notification status'))
    }
  })

  router.post('/dingtalk/work-notification/test', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await testDingTalkWorkNotificationAgentId(req.body as never)
      jsonOk(res, { result })
    } catch (error) {
      jsonError(res, 400, 'DINGTALK_WORK_NOTIFICATION_TEST_FAILED', readErrorMessage(error, 'Failed to test DingTalk work notification Agent ID'))
    }
  })

  router.put('/dingtalk/work-notification', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await saveDingTalkWorkNotificationAgentId(req.body as never)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'dingtalk-work-notification-config',
        resourceId: result.integration.id,
        meta: {
          integrationId: result.integration.id,
          integrationName: result.integration.name,
          agentIdLength: result.agentId.length,
          agentIdValuePrinted: false,
          accessTokenVerified: result.accessTokenVerified,
          notificationSent: result.notificationSent,
        },
      })
      jsonOk(res, { result })
    } catch (error) {
      jsonError(res, 400, 'DINGTALK_WORK_NOTIFICATION_SAVE_FAILED', readErrorMessage(error, 'Failed to save DingTalk work notification Agent ID'))
    }
  })

  router.get('/integrations', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const items = await listDirectoryIntegrations()
      jsonOk(res, { items })
    } catch (error) {
      jsonError(res, 500, 'DIRECTORY_LIST_FAILED', readErrorMessage(error, 'Failed to load directory integrations'))
    }
  })

  router.post('/integrations', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    const scheduleCronInput = normalizeScheduleCronInput((req.body as Record<string, unknown> | undefined)?.scheduleCron)
    if (scheduleCronInput && !isDirectoryScheduleCronValid(scheduleCronInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_CRON_INVALID', DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE)
      return
    }

    try {
      const integration = await createDirectoryIntegration(req.body as Record<string, unknown> as never)
      await refreshDirectoryIntegrationSchedule(integration.id)
      jsonOk(res, { integration })
    } catch (error) {
      jsonError(res, 400, 'DIRECTORY_CREATE_FAILED', readErrorMessage(error, 'Failed to create directory integration'))
    }
  })

  router.put('/integrations/:integrationId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    const scheduleCronInput = normalizeScheduleCronInput((req.body as Record<string, unknown> | undefined)?.scheduleCron)
    if (scheduleCronInput && !isDirectoryScheduleCronValid(scheduleCronInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_CRON_INVALID', DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE)
      return
    }

    try {
      const integration = await updateDirectoryIntegration(req.params.integrationId, req.body as Record<string, unknown> as never)
      if (!integration) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      await refreshDirectoryIntegrationSchedule(integration.id)
      jsonOk(res, { integration })
    } catch (error) {
      jsonError(res, 400, 'DIRECTORY_UPDATE_FAILED', readErrorMessage(error, 'Failed to update directory integration'))
    }
  })

  // CFG-2 (card-config lock §3.2): approval-card self-service config. The secret is generated
  // server-side, stored encrypted, and NEVER echoed — responses carry presence booleans only.
  router.get('/integrations/:integrationId/approval-card-config', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const status = await getApprovalCardConfigStatus(req.params.integrationId)
      if (!status) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      jsonOk(res, { status })
    } catch (error) {
      jsonError(res, 500, 'APPROVAL_CARD_CONFIG_STATUS_FAILED', readErrorMessage(error, 'Failed to load approval card config status'))
    }
  })

  router.post('/integrations/:integrationId/approval-card-config/secret/generate', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const status = await generateApprovalCardLinkSecret(req.params.integrationId)
      if (!status) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'approval-card-config',
        resourceId: status.integration.id,
        meta: {
          integrationId: status.integration.id,
          operation: 'generate_link_secret',
          valuePrinted: false,
          envOverrideActive: status.linkSecret.envOverrideActive,
        },
      })
      jsonOk(res, { status })
    } catch (error) {
      jsonError(res, 400, 'APPROVAL_CARD_SECRET_GENERATE_FAILED', readErrorMessage(error, 'Failed to generate approval card link secret'))
    }
  })

  router.put('/integrations/:integrationId/approval-card-config', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      // Explicit contract: clearing requires an explicit '' — a missing field is a caller bug,
      // never a silent clear.
      if (typeof body.publicAppUrl !== 'string') {
        jsonError(res, 400, 'APPROVAL_CARD_CONFIG_SAVE_FAILED', 'publicAppUrl is required (send "" to clear)')
        return
      }
      const status = await saveApprovalCardPublicAppUrl(req.params.integrationId, body.publicAppUrl)
      if (!status) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'approval-card-config',
        resourceId: status.integration.id,
        meta: {
          integrationId: status.integration.id,
          operation: 'save_public_app_url',
          publicAppUrl: status.publicAppUrl.storedValue,
        },
      })
      jsonOk(res, { status })
    } catch (error) {
      jsonError(res, 400, 'APPROVAL_CARD_CONFIG_SAVE_FAILED', readErrorMessage(error, 'Failed to save approval card config'))
    }
  })

  router.post('/integrations/test', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await testDirectoryIntegration(req.body as Record<string, unknown> as never)
      jsonOk(res, result)
    } catch (error) {
      jsonError(res, 400, 'DIRECTORY_TEST_FAILED', readErrorMessage(error, 'Failed to test directory integration'))
    }
  })

  router.post('/integrations/:integrationId/sync', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    // DT-OPS-02: async is OPT-IN. The synchronous response carries the auto-admission
    // onboarding packets (one-time temporary passwords), which are never persisted — a
    // 202 would silently throw them away. Callers that do not need them (large tenants,
    // where the pull outlives any sane request timeout) ask for 202 + runId and poll the
    // runs endpoint.
    if (req.body?.async === true) {
      try {
        const runId = await new Promise<string>((resolve, reject) => {
          syncDirectoryIntegration(req.params.integrationId, adminUserId, 'manual', { onRunStarted: resolve })
            .then((result) => {
              logger.info(`Async directory sync finished for ${req.params.integrationId} (run ${result.run.id})`)
            })
            .catch((error) => {
              // If this fires before the run row exists the promise rejects and we answer
              // an error; afterwards `resolve` has already won and this only logs, because
              // the failure is recorded on the run row and its alert.
              logger.warn(`Async directory sync failed for ${req.params.integrationId}: ${readErrorMessage(error, 'unknown error')}`)
              reject(error)
            })
        })
        res.status(202)
        jsonOk(res, { accepted: true, runId, integrationId: req.params.integrationId })
        return
      } catch (error) {
        // DT-HARDEN-05: the lease conflict is thrown by the claim, BEFORE onRunStarted
        // ever fires, so it always lands in this catch — and it is the same benign
        // "already running" state as in the non-async branch below. Map it identically:
        // 409 with the active runId, never a 500 "sync failed" that monitoring pages on.
        if (error instanceof DirectorySyncInProgressError) {
          jsonError(res, error.statusCode, error.code, error.message, { activeRunId: error.activeRunId })
          return
        }
        const message = readErrorMessage(error, 'Failed to start directory sync')
        jsonError(res, /not found/i.test(message) ? 404 : 500, 'DIRECTORY_SYNC_FAILED', message)
        return
      }
    }

    try {
      const result = await syncDirectoryIntegration(req.params.integrationId, adminUserId)
      jsonOk(res, result)
    } catch (error) {
      // DT-HARDEN-05: another sync already holds the lease. Return the active run so the
      // admin UI can jump straight to it instead of re-triggering a duplicate API pull.
      if (error instanceof DirectorySyncInProgressError) {
        jsonError(res, error.statusCode, error.code, error.message, { activeRunId: error.activeRunId })
        return
      }
      const message = readErrorMessage(error, 'Failed to sync directory integration')
      jsonError(res, /not found/i.test(message) ? 404 : 500, 'DIRECTORY_SYNC_FAILED', message)
    }
  })

  // DT-OPS-02: look before you leap. Pulls the DingTalk directory exactly as a sync does
  // and reports what would change — writing nothing at all.
  router.post('/integrations/:integrationId/sync/preview', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const preview = await previewDirectorySyncIntegration(req.params.integrationId)
      jsonOk(res, { preview })
    } catch (error) {
      // DT-HARDEN-05 / R3: a real sync holds the lease — same benign "already running" state
      // as the two sync-trigger branches above, mapped identically (409 + the active runId,
      // never a 500 that monitoring pages on).
      if (error instanceof DirectorySyncInProgressError) {
        jsonError(res, error.statusCode, error.code, error.message, { activeRunId: error.activeRunId })
        return
      }
      const message = readErrorMessage(error, 'Failed to preview directory sync')
      jsonError(res, /not found/i.test(message) ? 404 : 500, 'DIRECTORY_SYNC_PREVIEW_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/runs', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })
      const result = await listDirectorySyncRuns(req.params.integrationId, { limit: pageSize, offset })
      jsonOk(res, {
        items: result.items,
        total: result.total,
        page,
        pageSize,
      })
    } catch (error) {
      jsonError(res, 500, 'DIRECTORY_RUNS_FAILED', readErrorMessage(error, 'Failed to load sync runs'))
    }
  })

  router.get('/integrations/:integrationId/schedule', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const snapshot = await getDirectorySyncScheduleSnapshot(req.params.integrationId)
      if (!snapshot) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      jsonOk(res, { snapshot })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory schedule')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_SCHEDULE_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/alerts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })
      const filter = normalizeAlertFilter(req.query.ack ?? req.query.filter)
      const result = await listDirectorySyncAlerts(
        req.params.integrationId,
        { limit: pageSize, offset },
        filter,
      )
      jsonOk(res, {
        items: result.items,
        counts: result.counts,
        total: result.total,
        page,
        pageSize,
        filter,
        ack: filter,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory alerts')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_ALERTS_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/review-items', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 100,
        maxPageSize: 200,
      })
      const filter = normalizeReviewFilter(req.query.queue ?? req.query.filter)
      const result = await listDirectoryReviewItems(
        req.params.integrationId,
        { limit: pageSize, offset },
        filter,
      )
      jsonOk(res, {
        items: result.items,
        total: result.total,
        page,
        pageSize,
        filter,
        queue: filter,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory review items')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_REVIEW_ITEMS_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/accounts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 50,
        maxPageSize: 100,
      })
      const search = typeof req.query.q === 'string' ? req.query.q : undefined
      const result = await listDirectoryIntegrationAccounts(req.params.integrationId, { limit: pageSize, offset }, search)
      jsonOk(res, {
        items: result.items,
        total: result.total,
        page,
        pageSize,
        query: search?.trim() || '',
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory accounts')
      jsonError(res, /required|invalid/i.test(message) ? 400 : 500, 'DIRECTORY_ACCOUNTS_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/departments', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await listDirectoryIntegrationDepartments(req.params.integrationId)
      jsonOk(res, {
        items: result.items,
        total: result.total,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory departments')
      jsonError(res, /required|invalid/i.test(message) ? 400 : 500, 'DIRECTORY_DEPARTMENTS_FAILED', message)
    }
  })

  // DT-OPS-03 (§7.4): approval-routing health. Coverage is a read-only derived metric —
  // no write path, same admin gate and error-handling shape as the sibling GET routes above.
  router.get('/integrations/:integrationId/manager-coverage', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const coverage = await getDirectoryManagerBindingCoverage(req.params.integrationId)
      jsonOk(res, { coverage })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory manager binding coverage')
      jsonError(res, /required|invalid/i.test(message) ? 400 : 500, 'DIRECTORY_MANAGER_COVERAGE_FAILED', message)
    }
  })

  router.get('/accounts/:accountId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const account = await getDirectoryAccountSummary(req.params.accountId)
      if (!account) {
        jsonError(res, 404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
        return
      }
      jsonOk(res, { account })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory account')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_ACCOUNT_FAILED', message)
    }
  })

  router.get('/accounts/:accountId/review-item', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const item = await getDirectoryReviewItem(req.params.accountId)
      if (!item) {
        jsonError(res, 404, 'DIRECTORY_REVIEW_ITEM_NOT_FOUND', 'Directory review item not found')
        return
      }
      jsonOk(res, { item })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory review item')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_REVIEW_ITEM_FAILED', message)
    }
  })

  router.post('/accounts/:accountId/bind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const localUserRef = typeof req.body?.localUserRef === 'string' ? req.body.localUserRef : ''
      const enableDingTalkGrant = typeof req.body?.enableDingTalkGrant === 'boolean'
        ? req.body.enableDingTalkGrant
        : true

      const result = await bindDirectoryAccount(req.params.accountId, {
        localUserRef,
        adminUserId,
        enableDingTalkGrant,
      })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'bind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          localUserId: result.account.localUser?.id ?? null,
          localUserEmail: result.account.localUser?.email ?? null,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          enableDingTalkGrant,
        },
      })
      jsonOk(res, { account: result.account })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to bind directory account')
      const statusCode = /not found/i.test(message)
        ? 404
        : /already bound|already linked/i.test(message)
          ? 409
          : /required|cannot be pre-bound|missing DingTalk openId/i.test(message)
            ? 400
            : 500
      jsonError(res, statusCode, 'DIRECTORY_BIND_FAILED', message)
    }
  })

  router.post('/accounts/:accountId/admit-user', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const username = typeof req.body?.username === 'string' && req.body.username.trim().length > 0
        ? req.body.username
        : undefined
      const result = await admitDirectoryAccountUser(req.params.accountId, {
        adminUserId,
        name: typeof req.body?.name === 'string' ? req.body.name : '',
        email: typeof req.body?.email === 'string' ? req.body.email : '',
        ...(username ? { username } : {}),
        mobile: typeof req.body?.mobile === 'string' ? req.body.mobile : null,
        password: typeof req.body?.password === 'string' ? req.body.password : '',
        enableDingTalkGrant: typeof req.body?.enableDingTalkGrant === 'boolean' ? req.body.enableDingTalkGrant : true,
      })

      await Promise.all([
        auditLog({
          actorId: adminUserId,
          actorType: 'user',
          action: 'create',
          resourceType: 'user',
          resourceId: result.user.id,
          meta: {
            adminUserId,
            source: 'directory_manual_admission',
            directoryAccountId: result.account.id,
            integrationId: result.account.integrationId,
            email: result.user.email,
            username: result.user.username,
            name: result.user.name,
            mobile: result.user.mobile,
            generatedPassword: typeof result.temporaryPassword === 'string',
          },
        }),
        auditLog({
          actorId: adminUserId,
          actorType: 'user',
          action: 'bind',
          resourceType: 'directory-account-link',
          resourceId: result.account.id,
          meta: {
            adminUserId,
            directoryAccountId: result.account.id,
            integrationId: result.account.integrationId,
            previousLocalUserId: result.previousLocalUser?.id ?? null,
            previousLocalUserEmail: result.previousLocalUser?.email ?? null,
            localUserId: result.user.id,
            localUserEmail: result.user.email,
            localUserUsername: result.user.username,
            externalUserId: result.account.externalUserId,
            corpId: result.account.corpId,
            mode: 'manual_admission',
          },
        }),
      ])

      jsonOk(res, {
        account: result.account,
        user: result.user,
        temporaryPassword: result.temporaryPassword,
        inviteToken: result.inviteToken,
        onboarding: result.onboarding,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to create and bind local user for directory account')
      const statusCode = /not found/i.test(message)
        ? 404
        : /already exists|already bound|already linked/i.test(message)
          ? 409
          : /required|invalid|password|cannot be pre-bound|missing DingTalk openId/i.test(message)
            ? 400
            : 500
      jsonError(res, statusCode, 'DIRECTORY_ADMISSION_FAILED', message)
    }
  })

  router.post('/accounts/batch-bind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const rawBindings = Array.isArray(req.body?.bindings) ? req.body.bindings : []
      const bindings = rawBindings
        .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
          localUserRef: typeof entry.localUserRef === 'string' ? entry.localUserRef : '',
          enableDingTalkGrant: typeof entry.enableDingTalkGrant === 'boolean' ? entry.enableDingTalkGrant : true,
        }))

      const outcome = await batchBindDirectoryAccounts(bindings, { adminUserId })
      // DT-HARDEN-04: audit every COMMITTED item, even when a later item failed. The
      // batch used to fail fast, so items already committed lost their audit trail.
      await Promise.all(outcome.succeeded.map((result) => auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'bind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          localUserId: result.account.localUser?.id ?? null,
          localUserEmail: result.account.localUser?.email ?? null,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          mode: 'bulk',
          selectionSize: bindings.length,
        },
      })))

      // Nothing committed → keep the historical error mapping. Otherwise a partial
      // failure is a normal batch result the caller can act on per item.
      if (outcome.succeeded.length === 0 && outcome.failed.length > 0) {
        throw new Error(outcome.failed[0].error)
      }

      jsonOk(res, {
        items: outcome.succeeded.map((result) => result.account),
        updatedCount: outcome.succeeded.length,
        failedCount: outcome.failed.length,
        failed: outcome.failed,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to batch bind directory accounts')
      const statusCode = /not found/i.test(message)
        ? 404
        : /already bound|already linked/i.test(message)
          ? 409
          : /required|cannot be pre-bound|missing DingTalk openId/i.test(message)
            ? 400
            : 500
      jsonError(res, statusCode, 'DIRECTORY_BATCH_BIND_FAILED', message)
    }
  })

  router.post('/accounts/batch-admit-users', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const rawAccountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : []
      const accountIds = rawAccountIds.filter((value): value is string => typeof value === 'string')
      const enableDingTalkGrant = req.body?.enableDingTalkGrant === true
      const outcome = await batchAdmitDirectoryAccountUsers(accountIds, {
        adminUserId,
        enableDingTalkGrant,
      })

      await Promise.all(outcome.succeeded.flatMap((result) => [
        auditLog({
          actorId: adminUserId,
          actorType: 'user',
          action: 'create',
          resourceType: 'user',
          resourceId: result.user.id,
          meta: {
            adminUserId,
            source: 'directory_bulk_manual_admission',
            directoryAccountId: result.account.id,
            integrationId: result.account.integrationId,
            email: result.user.email,
            username: result.user.username,
            name: result.user.name,
            mobile: result.user.mobile,
            generatedPassword: typeof result.temporaryPassword === 'string',
            mode: 'bulk_manual_admission',
            selectionSize: accountIds.length,
          },
        }),
        auditLog({
          actorId: adminUserId,
          actorType: 'user',
          action: 'bind',
          resourceType: 'directory-account-link',
          resourceId: result.account.id,
          meta: {
            adminUserId,
            directoryAccountId: result.account.id,
            integrationId: result.account.integrationId,
            previousLocalUserId: result.previousLocalUser?.id ?? null,
            previousLocalUserEmail: result.previousLocalUser?.email ?? null,
            localUserId: result.user.id,
            localUserEmail: result.user.email,
            localUserUsername: result.user.username,
            externalUserId: result.account.externalUserId,
            corpId: result.account.corpId,
            enableDingTalkGrant,
            mode: 'bulk_manual_admission',
            selectionSize: accountIds.length,
          },
        }),
      ]))

      if (outcome.succeeded.length === 0 && outcome.failed.length > 0) {
        throw new Error(outcome.failed[0].error)
      }

      jsonOk(res, {
        items: outcome.succeeded.map((result) => result.account),
        users: outcome.succeeded.map((result) => result.user),
        onboardingPackets: outcome.succeeded.map((result) => ({
          userId: result.user.id,
          name: result.user.name,
          email: result.user.email,
          username: result.user.username,
          mobile: result.user.mobile,
          temporaryPassword: result.temporaryPassword ?? '',
          onboarding: result.onboarding,
        })),
        updatedCount: outcome.succeeded.length,
        failedCount: outcome.failed.length,
        failed: outcome.failed,
        enableDingTalkGrant,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to batch create and bind local users for directory accounts')
      const statusCode = /not found/i.test(message)
        ? 404
        : /already exists|already bound|already linked/i.test(message)
          ? 409
          : /required|invalid|password|cannot be pre-bound|missing DingTalk openId/i.test(message)
            ? 400
            : 500
      jsonError(res, statusCode, 'DIRECTORY_BATCH_ADMISSION_FAILED', message)
    }
  })

  router.post('/accounts/:accountId/unbind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const disableDingTalkGrant = req.body?.disableDingTalkGrant === true
      const result = await unbindDirectoryAccount(req.params.accountId, {
        adminUserId,
        disableDingTalkGrant,
      })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'unbind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          disableDingTalkGrant,
        },
      })
      jsonOk(res, { account: result.account })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to unbind directory account')
      const statusCode = /not found/i.test(message)
        ? 404
        : /required/i.test(message)
          ? 400
          : 500
      jsonError(res, statusCode, 'DIRECTORY_UNBIND_FAILED', message)
    }
  })

  router.post('/accounts/batch-unbind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const rawAccountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : []
      const accountIds = rawAccountIds.filter((value): value is string => typeof value === 'string')
      const disableDingTalkGrant = req.body?.disableDingTalkGrant === true
      const outcome = await batchUnbindDirectoryAccounts(accountIds, {
        adminUserId,
        disableDingTalkGrant,
      })
      // DT-HARDEN-04: audit every COMMITTED item, even when a later item failed.
      await Promise.all(outcome.succeeded.map((result) => auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'unbind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          disableDingTalkGrant,
          mode: 'bulk',
          selectionSize: accountIds.length,
        },
      })))

      if (outcome.succeeded.length === 0 && outcome.failed.length > 0) {
        throw new Error(outcome.failed[0].error)
      }

      jsonOk(res, {
        items: outcome.succeeded.map((result) => result.account),
        updatedCount: outcome.succeeded.length,
        failedCount: outcome.failed.length,
        failed: outcome.failed,
        disableDingTalkGrant,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to batch unbind directory accounts')
      const statusCode = /not found/i.test(message)
        ? 404
        : /required/i.test(message)
          ? 400
          : 500
      jsonError(res, statusCode, 'DIRECTORY_BATCH_UNBIND_FAILED', message)
    }
  })

  router.post('/alerts/:alertId/ack', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const alert = await acknowledgeDirectorySyncAlert(req.params.alertId, adminUserId)
      if (!alert) {
        jsonError(res, 404, 'DIRECTORY_ALERT_NOT_FOUND', 'Directory alert not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'acknowledge',
        resourceType: 'directory-sync-alert',
        resourceId: alert.id,
        meta: {
          adminUserId,
          alertId: alert.id,
          integrationId: alert.integrationId,
          runId: alert.runId,
          code: alert.code,
          level: alert.level,
          acknowledgedAt: alert.acknowledgedAt,
        },
      })
      jsonOk(res, { alert })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to acknowledge directory alert')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_ALERT_ACK_FAILED', message)
    }
  })

  return router
}
