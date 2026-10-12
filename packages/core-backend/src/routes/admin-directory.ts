import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import {
  DirectoryConflictError,
  DirectoryNotFoundError,
  DirectorySyncFrozenByTransferError,
  DirectorySyncInProgressError,
  DirectorySyncRunReplayError,
  DirectoryTenantChangeBlockedError,
  DirectoryValidationError,
  acknowledgeDirectorySyncAlert,
  admitDirectoryAccountUser,
  batchAdmitDirectoryAccountUsers,
  batchBindDirectoryAccounts,
  batchUnbindDirectoryAccounts,
  bindDirectoryAccount,
  createDirectoryIntegration,
  getDirectorySyncScheduleSnapshot,
  getDirectorySyncRun,
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
import { getDirectoryInactiveLinkedMetric, getDirectoryManagerBindingCoverage } from '../directory/directory-sync-alert-delivery'
import { classifyDirectoryFailureText, type FixedSentenceErrorClass } from '../directory/directory-failure-text'
import { isDingTalkOutcomeUnknown } from '../integrations/dingtalk/client'
import { DingTalkConfigValidationError } from '../integrations/dingtalk/config-validation-error'
import { DingTalkCorpNotAllowedError } from '../integrations/dingtalk/runtime-policy'
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
import {
  compensateSupersededDenyGrant,
  listDeprovisionEffects,
  listDeprovisionEvents,
  previewDeprovisionForUser,
  readDeprovisionRuntimeFlags,
  restoreDeprovisionEvent,
} from '../directory/deprovision-evidence-api'
import { sendIfRecoveryConflict } from '../db/recovery-conflict'
import { LoginNameRuleError } from '../auth/login-name-rule'
import { PasswordPolicyError } from '../auth/password-policy-error'
// NOT a directory error: thrown by the alias claim inside admission (directory-sync.ts) with a fixed sentence.
import { LoginAliasClaimError } from '../auth/login-alias-service'
import { isAdmin as isRbacAdmin } from '../rbac/service'
// R-41: values-free by design (names the env vars, never their values) — shown as it is on the config routes.
import { EncryptionMaterialError } from '../security/encrypted-secrets'
// Roadmap §7.8 "Validate cron at save time" — see `isDirectoryScheduleCronValid` below for why this is
// `SimpleCronExpression` (the SAME class `directory-sync-scheduler.ts` uses to actually run the job) rather
// than the multitable automation scheduler's own cron parser.
import { SimpleCronExpression } from '../services/SchedulerService'
// Roadmap §7.8 "Add timezone support" — SAME validity gate the scheduler and CRUD layer resolve with.
import { isValidDirectoryScheduleTimezone, resolveDirectoryScheduleTimezone } from '../directory/directory-sync-timezone'
import { jsonError, jsonOk, parsePagination } from '../util/response'

const logger = new Logger('AdminDirectoryRoutes')
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

const DEFAULT_INACTIVE_LINKED_DAYS = 30
const MAX_INACTIVE_LINKED_DAYS = 3650

function normalizeInactiveLinkedDays(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return DEFAULT_INACTIVE_LINKED_DAYS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_INACTIVE_LINKED_DAYS
  return Math.min(parsed, MAX_INACTIVE_LINKED_DAYS)
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}

/**
 * Admission claims the new user's email / username / mobile as login aliases; one already claimed by another
 * account is a conflict the admin can resolve, not a server fault. Same status and code as POST
 * /api/admin/users. The message is the alias service's own fixed sentence (LoginAliasClaimError never carries
 * driver text). A failed claim WRITE (`ALIAS_WRITE_FAILED`) is not handled here: it stays the route's fixed 500.
 */
function sendIfLoginAliasConflict(res: Response, error: unknown): boolean {
  if (!(error instanceof LoginAliasClaimError) || error.code !== 'ALIAS_CONFLICT') return false
  jsonError(res, 409, 'LOGIN_ALIAS_CONFLICT', error.message)
  return true
}

/**
 * #6163 S6: the failure responder the directory handlers below share. The status comes from the error's
 * TYPE, never from a regex over its text: the three typed directory-sync errors answer 400 / 404 / 409 with
 * their own developer-authored sentence (see their classes in directory-sync.ts). Anything else is
 * unexpected — its text goes to the log only, and the 500 body carries the route's fixed `fallbackMessage`
 * (a literal at every call site), so no driver, provider or transport text reaches a 5xx body. A handler's
 * specific branches (sync lease / freeze, recovery conflict, login-name and password rules, login-alias conflict,
 * tenant change, corp allowlist) run before it; every call keeps the route's own error code.
 */
function sendDirectoryFailure(res: Response, error: unknown, code: string, fallbackMessage: string): void {
  if (error instanceof DirectoryValidationError) {
    jsonError(res, 400, code, error.message)
    return
  }
  if (error instanceof DirectoryNotFoundError) {
    jsonError(res, 404, code, error.message)
    return
  }
  if (error instanceof DirectoryConflictError) {
    jsonError(res, 409, code, error.message)
    return
  }
  logger.warn(fallbackMessage, { error: readErrorMessage(error, 'unknown error') })
  jsonError(res, 500, code, fallbackMessage)
}

/**
 * R-41: the literal-400 failure responder of the DingTalk work-notification, approval-card config and
 * directory-test routes. These used to answer 400 with the caught text — DingTalk's errmsg, a socket error
 * naming the peer, a driver sentence. Now the body never carries caught text, whatever the status:
 *   - an instance of one of the classes the call site lists (developer-authored sentences thrown typed) shows
 *     its own sentence, so input feedback ("DingTalk Agent ID must be 1-32 numeric characters") survives;
 *   - a typed DingTalk failure shows the route's fixed sentence plus DingTalk's numeric errcode or HTTP status;
 *   - anything else shows the route's literal `fallbackMessage`.
 * The caught text of the last two goes to the log. Status and code stay the route's own (a literal 400).
 */
function sendDirectoryConfigFailure(
  res: Response,
  error: unknown,
  code: string,
  fallbackMessage: string,
  fixedSentenceClasses: readonly FixedSentenceErrorClass[],
): void {
  const failure = classifyDirectoryFailureText(error, { fallback: fallbackMessage, fixedSentenceClasses })
  if (failure.kind !== 'fixed_sentence') {
    logger.warn(fallbackMessage, {
      error: readErrorMessage(error, 'unknown error'),
      ...(failure.providerCode !== undefined
        ? { providerCode: failure.providerCode, providerCodeKind: failure.providerCodeKind }
        : {}),
    })
  }
  jsonError(res, 400, code, failure.text)
}

/**
 * R-41: the developer-authored sentences the DingTalk work-notification and approval-card config routes show.
 * EncryptionMaterialError: production refusing to encrypt / decrypt the stored Agent ID or link secret because
 * ENCRYPTION_KEY / ENCRYPTION_SALT are unset or the built-in defaults — the operator's next step, named without
 * any value.
 */
const DINGTALK_CONFIG_FIXED_SENTENCES: readonly FixedSentenceErrorClass[] = [DingTalkConfigValidationError, EncryptionMaterialError]
/**
 * R-41: the developer-authored sentences the directory-test route shows (input, missing integration, corp
 * allowlist, and the stored appSecret it cannot decrypt for want of encryption material).
 */
const DIRECTORY_TEST_FIXED_SENTENCES: readonly FixedSentenceErrorClass[] = [
  DirectoryValidationError,
  DirectoryNotFoundError,
  DirectoryConflictError,
  DingTalkCorpNotAllowedError,
  EncryptionMaterialError,
]

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
 * TIMEZONE (roadmap §7.8 "Add timezone support", LANDED): reachability is NOT timezone-invariant, and an
 * earlier revision of this comment asserted that it was. Review P3-3, verified by construction: `30 2 8 3 *`
 * (02:30 on Mar 8) is reachable in `Asia/Shanghai` but NOT in `America/New_York` when the next Mar 8 is
 * that zone's DST spring-forward Sunday (e.g. 2026-03-08) — 02:00–03:00 local does not exist that day, so
 * the zoned scan finds no match within its ~1-year window and `hasNext()` is false. Same expression,
 * opposite verdicts, decided purely by the zone.
 *
 * (Whether a given annual expression is unreachable also depends on WHICH year the next candidate lands in,
 * since DST moves — that is a property of the example, not of the principle. The principle is what matters
 * here: we cannot validate in one zone and run in another.)
 *
 * Validating with a fixed `'UTC'` would therefore let an expression that can NEVER fire in the integration's
 * configured zone save as "valid", after which the scheduler silently drops it forever — the EXACT failure
 * this gate exists to prevent, arriving via the timezone rather than via a mismatched parser. So we validate
 * against the zone the cron will actually run in: same expression class, same zone as
 * `directory-sync-scheduler.ts` will construct. The zone string itself is validated separately
 * (`isValidDirectoryScheduleTimezone`) BEFORE this runs, so a garbage zone is rejected on its own terms
 * rather than being laundered into a confusing cron error.
 */
function isDirectoryScheduleCronValid(cron: string, timezone: string): boolean {
  try {
    return new SimpleCronExpression(cron, resolveDirectoryScheduleTimezone(timezone)).hasNext()
  } catch {
    return false
  }
}

/**
 * STRUCTURE only — zone-independent, and cheap. A malformed expression (`60 25 * * *`, wrong field
 * count, out-of-range value) is malformed in EVERY zone, so it must be rejected without first going to
 * the database for the integration's saved timezone: the zone lookup exists to answer "can this cron
 * ever fire THERE", which is a question a broken expression never gets to ask. Keeping the two checks
 * separate also means a DB hiccup can never turn a plainly-invalid cron into a 503.
 */
function isDirectoryScheduleCronParseable(cron: string): boolean {
  try {
    new SimpleCronExpression(cron, 'UTC')
    return true
  } catch {
    return false
  }
}

const DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE =
  'scheduleCron is not a valid schedule. Expected a standard 5-field cron expression ' +
  '(minute hour dayOfMonth month dayOfWeek — e.g. "0 2 * * *") that resolves to at least one execution ' +
  'within the next year (day-of-month and day-of-week restrictions combine with AND, so e.g. a day-of-month ' +
  'that never falls on the requested weekday is rejected). DingTalk directory sync runs in the ' +
  'integration\'s configured scheduleTimezone (UTC by default). Leave scheduleCron empty to disable ' +
  'the scheduled sync.'

// Mirrors `normalizeScheduleCronInput` above: absent/null/undefined/non-string all normalize to '' = "no
// configured timezone" (the scheduler default), which is always allowed.
function normalizeScheduleTimezoneInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

/**
 * Roadmap §7.8 "Add timezone support" save-time gate: fail-closed on an invalid IANA zone. Reuses the SAME
 * `isValidDirectoryScheduleTimezone` the scheduler's runtime resolver falls back through — an invalid zone
 * must be REJECTED here rather than silently degrading to UTC at runtime (that would let an admin believe a
 * zone was saved that was quietly dropped). '' / 'UTC' / 'Etc/UTC' are always valid (= use the default).
 */
const DIRECTORY_SCHEDULE_TIMEZONE_ERROR_MESSAGE =
  'scheduleTimezone is not a valid IANA timezone (e.g. "Asia/Shanghai"). Leave it empty, or set it to ' +
  '"UTC", to run scheduleCron on UTC wall-clock time.'

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

/**
 * Exported so sibling directory admin route modules (e.g. `admin-directory-local.ts`, Canonical
 * Org MVP B2) share the SAME platform-admin gate rather than re-implementing the legacy-claim /
 * RBAC check — duplicated auth guards drift, which is a security-relevant divergence.
 */
export async function ensurePlatformAdmin(req: Request, res: Response): Promise<string | null> {
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

  // Every id below is a uuid column (gen_random_uuid()). A malformed one in the path used to reach Postgres as
  // `$1::uuid`, fail with 22P02 and, since the status is decided by error TYPE (#6163 S6), answer the route's
  // generic 500. It is the caller's mistake: 400, with the same shape check and wording the runId / eventId
  // routes below already use, placed AFTER the admin gate so a non-admin still sees 401 / 403 first.
  const ID_PARAM_INVALID = {
    integrationId: { code: 'DIRECTORY_INTEGRATION_ID_INVALID', message: 'integrationId must be a UUID' },
    accountId: { code: 'DIRECTORY_ACCOUNT_ID_INVALID', message: 'accountId must be a UUID' },
    alertId: { code: 'DIRECTORY_ALERT_ID_INVALID', message: 'alertId must be a UUID' },
  } as const

  function validateIdParam(req: Request, res: Response, name: keyof typeof ID_PARAM_INVALID): boolean {
    if (UUID_SHAPE_RE.test(String(req.params[name] ?? ''))) return true
    jsonError(res, 400, ID_PARAM_INVALID[name].code, ID_PARAM_INVALID[name].message)
    return false
  }

  router.get('/dingtalk/work-notification', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    // Optional filter: blank means "the preferred integration" (the service trims it); anything else must be a
    // uuid, like the path ids above, or it reaches `WHERE id = $1` and fails with 22P02.
    const requestedIntegrationId = typeof req.query.integrationId === 'string' ? req.query.integrationId.trim() : ''
    if (requestedIntegrationId && !UUID_SHAPE_RE.test(requestedIntegrationId)) {
      jsonError(res, 400, ID_PARAM_INVALID.integrationId.code, ID_PARAM_INVALID.integrationId.message)
      return
    }

    try {
      const integrationId = typeof req.query.integrationId === 'string' ? req.query.integrationId : undefined
      const status = await getDingTalkWorkNotificationRuntimeStatusFromStore(integrationId)
      jsonOk(res, { status })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DINGTALK_WORK_NOTIFICATION_STATUS_FAILED', 'Failed to load DingTalk work notification status')
    }
  })

  router.post('/dingtalk/work-notification/test', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await testDingTalkWorkNotificationAgentId(req.body as never)
      jsonOk(res, { result })
    } catch (error) {
      // #4046 send-tier: network error/timeout/5xx/malformed-2xx on the actual send carries the
      // transport's isDingTalkOutcomeUnknown marker — DingTalk may well have delivered the test
      // message even though this request saw no (usable) response. Folding that into the generic
      // "failed" code below would tell an admin their Agent ID is broken when the message may in
      // fact have arrived. This is the interactive test-send path — there is no ledger row to mark
      // outcome_unknown on (by design), so the ambiguity is surfaced directly to the caller instead.
      if (isDingTalkOutcomeUnknown(error)) {
        // #6163 S6: a fixed sentence. The transport's own text (a timeout, a socket error naming the peer)
        // goes to the log, not into this 5xx body.
        logger.warn('DingTalk test send outcome unknown', { error: readErrorMessage(error, 'unknown error') })
        jsonError(
          res,
          502,
          'DINGTALK_TEST_SEND_OUTCOME_UNKNOWN',
          'DingTalk did not confirm the outcome. The test message may still have been delivered — check the test message on the device before retrying.',
        )
        return
      }
      sendDirectoryConfigFailure(res, error, 'DINGTALK_WORK_NOTIFICATION_TEST_FAILED', 'Failed to test DingTalk work notification Agent ID', DINGTALK_CONFIG_FIXED_SENTENCES)
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
      sendDirectoryConfigFailure(res, error, 'DINGTALK_WORK_NOTIFICATION_SAVE_FAILED', 'Failed to save DingTalk work notification Agent ID', DINGTALK_CONFIG_FIXED_SENTENCES)
    }
  })

  router.get('/integrations', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const items = await listDirectoryIntegrations()
      jsonOk(res, { items })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_LIST_FAILED', 'Failed to load directory integrations')
    }
  })

  router.post('/integrations', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    // Review P3-3: the ZONE is validated FIRST, then the cron is validated IN THAT ZONE. Reachability is
    // not timezone-invariant (see isDirectoryScheduleCronValid), so a fixed-UTC cron check would let an
    // expression that can never fire in the configured zone save as "valid" and then silently never run.
    const scheduleTimezoneInput = normalizeScheduleTimezoneInput((req.body as Record<string, unknown> | undefined)?.scheduleTimezone)
    if (scheduleTimezoneInput && !isValidDirectoryScheduleTimezone(scheduleTimezoneInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_TIMEZONE_INVALID', DIRECTORY_SCHEDULE_TIMEZONE_ERROR_MESSAGE)
      return
    }

    const scheduleCronInput = normalizeScheduleCronInput((req.body as Record<string, unknown> | undefined)?.scheduleCron)
    // Structure first (zone-independent), then reachability in the zone it will run in.
    if (scheduleCronInput && !isDirectoryScheduleCronParseable(scheduleCronInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_CRON_INVALID', DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE)
      return
    }
    if (scheduleCronInput && !isDirectoryScheduleCronValid(scheduleCronInput, scheduleTimezoneInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_CRON_INVALID', DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE)
      return
    }

    try {
      const integration = await createDirectoryIntegration(req.body as Record<string, unknown> as never)
      await refreshDirectoryIntegrationSchedule(integration.id)
      jsonOk(res, { integration })
    } catch (error) {
      // The corp allowlist refusing the submitted corpId is a policy verdict on the caller's input, typed by
      // its own class: it keeps the 400 (and its sentence) it always had.
      if (error instanceof DingTalkCorpNotAllowedError) {
        jsonError(res, 400, 'DIRECTORY_CREATE_FAILED', error.message)
        return
      }
      sendDirectoryFailure(res, error, 'DIRECTORY_CREATE_FAILED', 'Failed to create directory integration')
    }
  })

  router.put('/integrations/:integrationId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    // Zone first, then the cron IN the zone it will actually run in.
    //
    // Owner review P2 (2026-07-12) — this must be decided by FIELD PRESENCE, not by truthiness. An
    // earlier revision collapsed "key absent" and "key present but empty" into the same `''`, which was
    // wrong in BOTH directions:
    //   * `scheduleTimezone: ''` (an explicit CLEAR) was treated as absent, so the cron was validated
    //     against the OLD saved zone — while the write cleared the zone to UTC. Validated in one zone,
    //     saved in another.
    //   * when the saved zone could not be read, it silently GUESSED UTC — so a cron that can never
    //     fire in the zone actually being PRESERVED could sail through the gate.
    // Presence is the truth: absent = keep the saved zone; present (including '') = this is the zone.
    // And if we cannot read the config we must PRESERVE, we refuse the update — we do not guess.
    const putBody = req.body as Record<string, unknown> | undefined
    const timezoneKeyPresent = !!putBody && Object.prototype.hasOwnProperty.call(putBody, 'scheduleTimezone')
    const scheduleTimezoneInput = normalizeScheduleTimezoneInput(putBody?.scheduleTimezone)
    if (timezoneKeyPresent && scheduleTimezoneInput && !isValidDirectoryScheduleTimezone(scheduleTimezoneInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_TIMEZONE_INVALID', DIRECTORY_SCHEDULE_TIMEZONE_ERROR_MESSAGE)
      return
    }

    const scheduleCronInput = normalizeScheduleCronInput(putBody?.scheduleCron)
    // Malformed in every zone ⇒ reject WITHOUT reading the saved timezone. A broken expression must not
    // depend on a DB round-trip, and a DB hiccup must never turn a plainly-invalid cron into a 503.
    if (scheduleCronInput && !isDirectoryScheduleCronParseable(scheduleCronInput)) {
      jsonError(res, 400, 'DIRECTORY_SCHEDULE_CRON_INVALID', DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE)
      return
    }
    if (scheduleCronInput) {
      let effectiveTimezone: string
      if (timezoneKeyPresent) {
        // Explicitly supplied — including '' meaning "clear to UTC". This IS what will be persisted,
        // so it is exactly the zone to validate the cron against.
        effectiveTimezone = scheduleTimezoneInput
      } else {
        // Absent ⇒ the saved zone is preserved, so THAT is the zone this cron will run in.
        let snapshot: Awaited<ReturnType<typeof getDirectorySyncScheduleSnapshot>>
        try {
          snapshot = await getDirectorySyncScheduleSnapshot(req.params.integrationId)
        } catch (error) {
          // Cannot read the zone we are about to preserve ⇒ we cannot honestly validate the cron in it.
          // Refuse; do NOT fall back to UTC and let a never-firing schedule through. The read error's text
          // goes to the log; the 503 body is the fixed sentence (#6163 S6).
          logger.warn('Could not read the saved schedule timezone to validate scheduleCron', { error: readErrorMessage(error, 'unknown error') })
          jsonError(
            res,
            503,
            'DIRECTORY_SCHEDULE_CONFIG_UNREADABLE',
            'Could not read the integration\'s saved schedule timezone, so scheduleCron cannot be validated against the zone it will run in. No change was made; retry.',
          )
          return
        }
        if (!snapshot) {
          jsonError(res, 404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
          return
        }
        effectiveTimezone = snapshot.scheduleTimezone ?? ''
      }
      if (!isDirectoryScheduleCronValid(scheduleCronInput, effectiveTimezone)) {
        jsonError(res, 400, 'DIRECTORY_SCHEDULE_CRON_INVALID', DIRECTORY_SCHEDULE_CRON_ERROR_MESSAGE)
        return
      }
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
      // R-41: the class's own developer-authored sentence (its one thrower interpolates only the path's
      // integration id), never a caught text read generically.
      if (error instanceof DirectoryTenantChangeBlockedError) {
        jsonError(
          res,
          409,
          'DIRECTORY_TENANT_CHANGE_BLOCKED',
          classifyDirectoryFailureText(error, { fallback: 'Tenant change blocked', fixedSentenceClasses: [DirectoryTenantChangeBlockedError] }).text,
        )
        return
      }
      // Same corp-allowlist verdict as on create: the caller's input, typed by its own class — 400 as before.
      if (error instanceof DingTalkCorpNotAllowedError) {
        jsonError(res, 400, 'DIRECTORY_UPDATE_FAILED', error.message)
        return
      }
      sendDirectoryFailure(res, error, 'DIRECTORY_UPDATE_FAILED', 'Failed to update directory integration')
    }
  })

  // CFG-2 (card-config lock §3.2): approval-card self-service config. The secret is generated
  // server-side, stored encrypted, and NEVER echoed — responses carry presence booleans only.
  router.get('/integrations/:integrationId/approval-card-config', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    try {
      const status = await getApprovalCardConfigStatus(req.params.integrationId)
      if (!status) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      jsonOk(res, { status })
    } catch (error) {
      sendDirectoryFailure(res, error, 'APPROVAL_CARD_CONFIG_STATUS_FAILED', 'Failed to load approval card config status')
    }
  })

  router.post('/integrations/:integrationId/approval-card-config/secret/generate', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

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
      sendDirectoryConfigFailure(res, error, 'APPROVAL_CARD_SECRET_GENERATE_FAILED', 'Failed to generate approval card link secret', DINGTALK_CONFIG_FIXED_SENTENCES)
    }
  })

  router.put('/integrations/:integrationId/approval-card-config', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

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
      sendDirectoryConfigFailure(res, error, 'APPROVAL_CARD_CONFIG_SAVE_FAILED', 'Failed to save approval card config', DINGTALK_CONFIG_FIXED_SENTENCES)
    }
  })

  router.post('/integrations/test', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await testDirectoryIntegration(req.body as Record<string, unknown> as never)
      jsonOk(res, result)
    } catch (error) {
      sendDirectoryConfigFailure(res, error, 'DIRECTORY_TEST_FAILED', 'Failed to test directory integration', DIRECTORY_TEST_FIXED_SENTENCES)
    }
  })

  router.post('/integrations/:integrationId/sync', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    // DT-OPS-02: async is OPT-IN. The synchronous response carries the auto-admission
    // onboarding packets (one-time temporary passwords), which are never persisted — a
    // 202 would silently throw them away. Callers that do not need them (large tenants,
    // where the pull outlives any sane request timeout) ask for 202 + runId and poll the
    // runs endpoint.
    if (req.body?.async === true) {
      const requestedRunId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : ''
      if (requestedRunId && !UUID_SHAPE_RE.test(requestedRunId)) {
        jsonError(res, 400, 'DIRECTORY_SYNC_RUN_ID_INVALID', 'runId must be a UUID')
        return
      }
      try {
        const runId = await new Promise<string>((resolve, reject) => {
          syncDirectoryIntegration(req.params.integrationId, adminUserId, 'manual', {
            onRunStarted: resolve,
            requestedRunId: requestedRunId || undefined,
          })
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
        if (error instanceof DirectorySyncRunReplayError) {
          res.status(202)
          jsonOk(res, {
            accepted: true,
            runId: error.runId,
            integrationId: req.params.integrationId,
            replayed: true,
          })
          return
        }
        // DT-HARDEN-05: the lease conflict is thrown by the claim, BEFORE onRunStarted
        // ever fires, so it always lands in this catch — and it is the same benign
        // "already running" state as in the non-async branch below. Map it identically:
        // 409 with the active runId, never a 500 "sync failed" that monitoring pages on.
        // (409 is written as a literal at every lease / freeze branch: both classes declare
        // `statusCode = 409`, and a literal 4xx is what the values-free scan can see.)
        if (error instanceof DirectorySyncInProgressError) {
          jsonError(res, 409, error.code, error.message, { activeRunId: error.activeRunId })
          return
        }
        // T2 (§12.2): an active org transfer freezes this source integration's sync — a
        // deliberate admin-visible state, not a failure. 409 + the transfer id.
        if (error instanceof DirectorySyncFrozenByTransferError) {
          jsonError(res, 409, error.code, error.message, { transferId: error.transferId })
          return
        }
        // O2-S2: marker 40001 from the sync's local-apply transaction → retryable 409.
        if (sendIfRecoveryConflict(res, error)) return
        sendDirectoryFailure(res, error, 'DIRECTORY_SYNC_FAILED', 'Failed to start directory sync')
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
        jsonError(res, 409, error.code, error.message, { activeRunId: error.activeRunId })
        return
      }
      // T2 (§12.2): same deliberate frozen state as the async branch above.
      if (error instanceof DirectorySyncFrozenByTransferError) {
        jsonError(res, 409, error.code, error.message, { transferId: error.transferId })
        return
      }
      // O2-S2: marker 40001 from the sync's local-apply transaction → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_SYNC_FAILED', 'Failed to sync directory integration')
    }
  })

  // DT-OPS-02: look before you leap. Pulls the DingTalk directory exactly as a sync does
  // and reports what would change — writing nothing at all.
  router.post('/integrations/:integrationId/sync/preview', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    try {
      const preview = await previewDirectorySyncIntegration(req.params.integrationId)
      jsonOk(res, { preview })
    } catch (error) {
      // DT-HARDEN-05 / R3: a real sync holds the lease — same benign "already running" state
      // as the two sync-trigger branches above, mapped identically (409 + the active runId,
      // never a 500 that monitoring pages on).
      if (error instanceof DirectorySyncInProgressError) {
        jsonError(res, 409, error.code, error.message, { activeRunId: error.activeRunId })
        return
      }
      sendDirectoryFailure(res, error, 'DIRECTORY_SYNC_PREVIEW_FAILED', 'Failed to preview directory sync')
    }
  })

  router.get('/integrations/:integrationId/runs', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

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
      sendDirectoryFailure(res, error, 'DIRECTORY_RUNS_FAILED', 'Failed to load sync runs')
    }
  })

  router.get('/integrations/:integrationId/runs/:runId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return
    if (!UUID_SHAPE_RE.test(req.params.runId)) {
      jsonError(res, 400, 'DIRECTORY_SYNC_RUN_ID_INVALID', 'runId must be a UUID')
      return
    }

    try {
      const run = await getDirectorySyncRun(req.params.integrationId, req.params.runId)
      if (!run) {
        jsonError(res, 404, 'DIRECTORY_RUN_NOT_FOUND', 'Directory sync run not found')
        return
      }
      jsonOk(res, { run })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_RUN_FAILED', 'Failed to load sync run')
    }
  })

  router.get('/integrations/:integrationId/schedule', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    try {
      const snapshot = await getDirectorySyncScheduleSnapshot(req.params.integrationId)
      if (!snapshot) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      jsonOk(res, { snapshot })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_SCHEDULE_FAILED', 'Failed to load directory schedule')
    }
  })

  router.get('/integrations/:integrationId/alerts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

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
      sendDirectoryFailure(res, error, 'DIRECTORY_ALERTS_FAILED', 'Failed to load directory alerts')
    }
  })

  router.get('/integrations/:integrationId/review-items', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

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
      sendDirectoryFailure(res, error, 'DIRECTORY_REVIEW_ITEMS_FAILED', 'Failed to load directory review items')
    }
  })

  router.get('/integrations/:integrationId/accounts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

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
      sendDirectoryFailure(res, error, 'DIRECTORY_ACCOUNTS_FAILED', 'Failed to load directory accounts')
    }
  })

  router.get('/integrations/:integrationId/departments', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    try {
      const result = await listDirectoryIntegrationDepartments(req.params.integrationId)
      jsonOk(res, {
        items: result.items,
        total: result.total,
      })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_DEPARTMENTS_FAILED', 'Failed to load directory departments')
    }
  })

  // DT-OPS-03 (§7.4): approval-routing health. Coverage is a read-only derived metric —
  // no write path, same admin gate and error-handling shape as the sibling GET routes above.
  router.get('/integrations/:integrationId/manager-coverage', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    try {
      const coverage = await getDirectoryManagerBindingCoverage(req.params.integrationId)
      jsonOk(res, { coverage })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_MANAGER_COVERAGE_FAILED', 'Failed to load directory manager binding coverage')
    }
  })

  // §7.1 offboarding blind-spot metric: directory accounts that went inactive (DingTalk
  // removal / deactivation sweep) at least `days` ago while still linked to a LOCAL user
  // that is still active. Read-only derived metric — no write path, same admin gate and
  // error-handling shape as the sibling GET routes (mirrors /manager-coverage above).
  router.get('/integrations/:integrationId/inactive-linked', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'integrationId')) return

    try {
      const thresholdDays = normalizeInactiveLinkedDays(req.query.days)
      const metric = await getDirectoryInactiveLinkedMetric(req.params.integrationId, thresholdDays)
      jsonOk(res, { metric })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_INACTIVE_LINKED_FAILED', 'Failed to load directory inactive-linked metric')
    }
  })

  router.get('/accounts/:accountId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'accountId')) return

    try {
      const account = await getDirectoryAccountSummary(req.params.accountId)
      if (!account) {
        jsonError(res, 404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
        return
      }
      jsonOk(res, { account })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_ACCOUNT_FAILED', 'Failed to load directory account')
    }
  })

  router.get('/accounts/:accountId/review-item', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'accountId')) return

    try {
      const item = await getDirectoryReviewItem(req.params.accountId)
      if (!item) {
        jsonError(res, 404, 'DIRECTORY_REVIEW_ITEM_NOT_FOUND', 'Directory review item not found')
        return
      }
      jsonOk(res, { item })
    } catch (error) {
      sendDirectoryFailure(res, error, 'DIRECTORY_REVIEW_ITEM_FAILED', 'Failed to load directory review item')
    }
  })

  router.post('/accounts/:accountId/bind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'accountId')) return

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
      // O2-S2: named retryable RecoveryConflictError from the bind write → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_BIND_FAILED', 'Failed to bind directory account')
    }
  })

  router.post('/accounts/:accountId/admit-user', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'accountId')) return

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
            activationStatus: result.activationStatus,
            enableDingTalkGrantApplied: result.enableDingTalkGrantApplied,
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
            activationStatus: result.activationStatus,
            enableDingTalkGrantApplied: result.enableDingTalkGrantApplied,
          },
        }),
      ])

      jsonOk(res, {
        account: result.account,
        user: result.user,
        temporaryPassword: result.temporaryPassword,
        inviteToken: result.inviteToken,
        // Null when pending — do not invent login/temp-password messaging.
        onboarding: result.onboarding,
        activationStatus: result.activationStatus,
        enableDingTalkGrantApplied: result.enableDingTalkGrantApplied,
      })
    } catch (error) {
      // O2-S2: named retryable RecoveryConflictError from the admission write → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      // #6259: input-rule failures are recognised by TYPE (not by matching their English prose) and
      // answered 400 with the same stable codes POST /api/admin/users uses. The login-name sentence
      // matched none of the message patterns this catch used to have and fell through to 500.
      if (error instanceof LoginNameRuleError) {
        jsonError(res, 400, error.code, error.message, { rule: error.rule })
        return
      }
      if (error instanceof PasswordPolicyError) {
        jsonError(res, 400, error.code, error.message, { details: [...error.errors] })
        return
      }
      if (sendIfLoginAliasConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_ADMISSION_FAILED', 'Failed to create and bind local user for directory account')
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

      // Nothing committed → answer like the single-item route: rethrow the first item's error AS
      // THROWN (#6163 S6), so the catch below picks the status from its type. Otherwise a partial
      // failure is a normal batch result the caller can act on per item.
      if (outcome.succeeded.length === 0 && outcome.failed.length > 0) {
        throw outcome.failedErrors[0]
      }

      jsonOk(res, {
        items: outcome.succeeded.map((result) => result.account),
        updatedCount: outcome.succeeded.length,
        failedCount: outcome.failed.length,
        failed: outcome.failed,
      })
    } catch (error) {
      // O2-S2: named retryable RecoveryConflictError from a bind write → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_BATCH_BIND_FAILED', 'Failed to batch bind directory accounts')
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
            activationStatus: result.activationStatus,
            enableDingTalkGrantApplied: result.enableDingTalkGrantApplied,
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
            // Actual applied value (pending forces false), not the request echo.
            enableDingTalkGrant: result.enableDingTalkGrantApplied,
            enableDingTalkGrantApplied: result.enableDingTalkGrantApplied,
            activationStatus: result.activationStatus,
            mode: 'bulk_manual_admission',
            selectionSize: accountIds.length,
          },
        }),
      ]))

      // Nothing committed → rethrow the first item's error as thrown (see batch-bind above).
      if (outcome.succeeded.length === 0 && outcome.failed.length > 0) {
        throw outcome.failedErrors[0]
      }

      // Report applied grant (truthful); request may have been forced off in pending mode.
      const enableDingTalkGrantApplied = outcome.succeeded[0]?.enableDingTalkGrantApplied
        ?? false

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
          // Null when pending — no "管理员单独告知" / login URL packet.
          onboarding: result.onboarding,
          activationStatus: result.activationStatus,
          enableDingTalkGrantApplied: result.enableDingTalkGrantApplied,
        })),
        updatedCount: outcome.succeeded.length,
        failedCount: outcome.failed.length,
        failed: outcome.failed,
        enableDingTalkGrantRequested: enableDingTalkGrant,
        enableDingTalkGrant: enableDingTalkGrantApplied,
        enableDingTalkGrantApplied,
      })
    } catch (error) {
      // O2-S2: named retryable RecoveryConflictError from an admission write → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      if (sendIfLoginAliasConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_BATCH_ADMISSION_FAILED', 'Failed to batch create and bind local users for directory accounts')
    }
  })

  router.post('/accounts/:accountId/unbind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'accountId')) return

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
      // O2-S2: named retryable RecoveryConflictError from the unbind write → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_UNBIND_FAILED', 'Failed to unbind directory account')
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

      // Nothing committed → rethrow the first item's error as thrown (see batch-bind above).
      if (outcome.succeeded.length === 0 && outcome.failed.length > 0) {
        throw outcome.failedErrors[0]
      }

      jsonOk(res, {
        items: outcome.succeeded.map((result) => result.account),
        updatedCount: outcome.succeeded.length,
        failedCount: outcome.failed.length,
        failed: outcome.failed,
        disableDingTalkGrant,
      })
    } catch (error) {
      // O2-S2: named retryable RecoveryConflictError from an unbind write → retryable 409.
      if (sendIfRecoveryConflict(res, error)) return
      sendDirectoryFailure(res, error, 'DIRECTORY_BATCH_UNBIND_FAILED', 'Failed to batch unbind directory accounts')
    }
  })

  router.post('/alerts/:alertId/ack', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateIdParam(req, res, 'alertId')) return

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
      sendDirectoryFailure(res, error, 'DIRECTORY_ALERT_ACK_FAILED', 'Failed to acknowledge directory alert')
    }
  })

  // ── D7 evidence chain: flags / plan preview / events / restore ────────────

  type DeprovisionEventStatus =
    | 'applied'
    | 'fully_resolved'
    | 'superseded'

  function readDeprovisionEventStatus(
    value: unknown,
  ): DeprovisionEventStatus | undefined | null {
    if (value === undefined || value === null || value === '') return undefined
    if (
      value === 'applied'
      || value === 'fully_resolved'
      || value === 'superseded'
    ) {
      return value
    }
    return null
  }

  function readDeprovisionEventLimit(value: unknown): number | null {
    if (value === undefined) return 50
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed <= 200 ? parsed : null
  }

  function readCompatibilityRestoreMode(
    value: unknown,
  ): 'rehire' | 'admin_force' | null {
    if (value === undefined) return 'rehire'
    if (typeof value !== 'string') return null
    const mode = value.trim()
    return mode === 'rehire' || mode === 'admin_force' ? mode : null
  }

  function validateDeprovisionEventId(req: Request, res: Response): boolean {
    if (UUID_SHAPE_RE.test(req.params.eventId)) return true
    jsonError(res, 400, 'DEPROVISION_EVENT_ID_INVALID', 'eventId must be a UUID')
    return false
  }

  async function listDeprovisionEventsForRequest(
    req: Request,
    res: Response,
    integrationId?: string,
  ): Promise<void> {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    const status = readDeprovisionEventStatus(req.query.status)
    if (status === null) {
      jsonError(
        res,
        400,
        'DEPROVISION_EVENT_STATUS_INVALID',
        'status must be applied, fully_resolved, or superseded',
      )
      return
    }
    const queryIntegrationId = req.query.integrationId
    if (
      queryIntegrationId !== undefined
      && (
        typeof queryIntegrationId !== 'string'
        || !UUID_SHAPE_RE.test(queryIntegrationId)
      )
    ) {
      jsonError(
        res,
        400,
        'DEPROVISION_INTEGRATION_ID_INVALID',
        'integrationId must be a UUID',
      )
      return
    }
    if (
      integrationId !== undefined
      && queryIntegrationId !== undefined
      && queryIntegrationId !== integrationId
    ) {
      jsonError(
        res,
        400,
        'DEPROVISION_INTEGRATION_ID_MISMATCH',
        'integrationId query must match the route integrationId',
      )
      return
    }
    const rawIntegrationId = integrationId ?? queryIntegrationId
    if (
      rawIntegrationId !== undefined
      && (
        typeof rawIntegrationId !== 'string'
        || !UUID_SHAPE_RE.test(rawIntegrationId)
      )
    ) {
      jsonError(
        res,
        400,
        'DEPROVISION_INTEGRATION_ID_INVALID',
        'integrationId must be a UUID',
      )
      return
    }
    const requestedIntegrationId = typeof rawIntegrationId === 'string'
      ? rawIntegrationId
      : undefined
    const limit = readDeprovisionEventLimit(req.query.limit)
    if (limit === null) {
      jsonError(
        res,
        400,
        'DEPROVISION_EVENT_LIMIT_INVALID',
        'limit must be an integer between 1 and 200',
      )
      return
    }
    try {
      const items = await listDeprovisionEvents({
        integrationId: requestedIntegrationId,
        localUserId:
          typeof req.query.userId === 'string'
            ? req.query.userId
            : undefined,
        limit,
        status,
      })
      jsonOk(res, { items, flags: readDeprovisionRuntimeFlags() })
    } catch {
      jsonError(
        res,
        500,
        'DEPROVISION_EVENTS_FAILED',
        'List events failed',
      )
    }
  }

  async function restoreDeprovisionEventForRequest(
    req: Request,
    res: Response,
    mode: 'rehire' | 'admin_force',
  ): Promise<void> {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    const requestedMode = req.body?.mode
    if (
      requestedMode !== undefined
      && (
        typeof requestedMode !== 'string'
        || requestedMode.trim() !== mode
      )
    ) {
      jsonError(
        res,
        400,
        'RESTORE_MODE_INVALID',
        `mode must match the ${mode} route`,
      )
      return
    }
    if (!validateDeprovisionEventId(req, res)) return
    try {
      const result = await restoreDeprovisionEvent({
        eventId: req.params.eventId,
        mode,
        adminUserId,
        confirm: req.body?.confirm === true,
        note:
          typeof req.body?.note === 'string'
            ? req.body.note
            : undefined,
      })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'directory-deprovision-event',
        resourceId: req.params.eventId,
        meta: {
          restoreMode: mode,
          restoredEffectCount: result.restoredEffectCount,
          localUserId: result.localUserId,
          noteLength: result.note ? result.note.length : 0,
        },
      })
      jsonOk(res, result)
    } catch (error) {
      // O2-S2: restoreDeprovisionEvent re-raises a marker 40001 as the named retryable
      // RecoveryConflictError → uniform retryable 409. Every coded mapping below is
      // unchanged (RECOVERY_AUTHORITY_BUSY is not in its lists, so it previously fell
      // to the unclassified 500).
      if (sendIfRecoveryConflict(res, error)) return
      // #6163 S6: the same coded mapping, one literal status per branch (a status chosen at run time is
      // held to the 5xx rule by the values-free scan). A coded refusal carries the sentence its service
      // set next to the code; anything else is the fixed 500.
      const errorCode = (error as { code?: unknown })?.code
      const code = typeof errorCode === 'string' ? errorCode : ''
      if (code === 'EVENT_NOT_FOUND' || code === 'USER_NOT_FOUND') {
        jsonError(res, 404, code, (error as Error)?.message || 'Restore failed')
        return
      }
      if (
        code === 'DRIFT_CONFLICT'
        || code === 'SOURCE_INACTIVE'
        || code === 'NO_EFFECTS'
        || code === 'NOT_APPLIED'
        || code === 'EVENT_NOT_APPLIED'
      ) {
        jsonError(res, 409, code, (error as Error)?.message || 'Restore failed')
        return
      }
      if (code === 'FORCE_CONFIRM_REQUIRED' || code === 'FORCE_NOTE_REQUIRED') {
        jsonError(res, 400, code, (error as Error)?.message || 'Restore failed')
        return
      }
      jsonError(res, 500, 'DEPROVISION_RESTORE_FAILED', 'Restore failed')
    }
  }

  async function listDeprovisionEffectsForRequest(
    req: Request,
    res: Response,
  ): Promise<void> {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!validateDeprovisionEventId(req, res)) return
    try {
      const items = await listDeprovisionEffects(req.params.eventId)
      jsonOk(res, { items })
    } catch {
      jsonError(
        res,
        500,
        'DEPROVISION_EFFECTS_FAILED',
        'List effects failed',
      )
    }
  }

  async function compensateSupersededDenyGrantForRequest(
    req: Request,
    res: Response,
  ): Promise<void> {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!UUID_SHAPE_RE.test(req.params.eventId)) {
      jsonError(res, 400, 'COMPENSATION_EVENT_ID_INVALID', 'eventId must be a UUID')
      return
    }
    try {
      const result = await compensateSupersededDenyGrant({
        eventId: req.params.eventId,
        adminUserId,
        confirm: req.body?.confirm === true,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'directory-deprovision-event',
        resourceId: req.params.eventId,
        meta: {
          compensationMode: result.compensationMode,
          effectId: result.effectId,
          localUserId: result.localUserId,
          grantRow: result.grantRow,
          alreadyCompensated: result.alreadyCompensated,
          noteLength: result.note.length,
        },
      })
      jsonOk(res, result)
    } catch (error) {
      // O2-S2: compensateSupersededDenyGrant re-raises a marker 40001 as the named
      // retryable RecoveryConflictError → uniform retryable 409; mappings below unchanged.
      if (sendIfRecoveryConflict(res, error)) return
      // #6163 S6: the same coded mapping, one literal status per branch (see the restore catch above).
      const errorCode =
        (error as { code?: string })?.code
        || 'DEPROVISION_COMPENSATION_FAILED'
      if (errorCode === 'EVENT_NOT_FOUND' || errorCode === 'USER_NOT_FOUND') {
        jsonError(res, 404, errorCode, (error as Error)?.message || 'Deny-row compensation failed')
        return
      }
      if (
        errorCode === 'COMPENSATION_CONFIRM_REQUIRED'
        || errorCode === 'COMPENSATION_NOTE_REQUIRED'
        || errorCode === 'COMPENSATION_ACTOR_REQUIRED'
      ) {
        jsonError(res, 400, errorCode, (error as Error)?.message || 'Deny-row compensation failed')
        return
      }
      if (
        errorCode === 'DRIFT_CONFLICT'
        || errorCode === 'COMPENSATION_EVENT_NOT_SUPERSEDED'
        || errorCode === 'COMPENSATION_NOT_APPLICABLE'
        || errorCode === 'COMPENSATION_USER_INACTIVE'
        || errorCode === 'COMPENSATION_SOURCE_INACTIVE'
        || errorCode === 'COMPENSATION_SOURCE_BUSY'
        || errorCode === 'COMPENSATION_MEMBERSHIP_INACTIVE'
        || errorCode === 'COMPENSATION_LIVE_EVIDENCE'
      ) {
        jsonError(res, 409, errorCode, (error as Error)?.message || 'Deny-row compensation failed')
        return
      }
      jsonError(res, 500, 'DEPROVISION_COMPENSATION_FAILED', 'Deny-row compensation failed')
    }
  }

  router.get('/deprovision/flags', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    jsonOk(res, readDeprovisionRuntimeFlags())
  })

  router.get('/deprovision/preview/:userId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    try {
      const integrationId = typeof req.query.integrationId === 'string'
        ? req.query.integrationId.trim()
        : ''
      if (!integrationId) {
        jsonError(res, 400, 'INTEGRATION_ID_REQUIRED', 'integrationId is required')
        return
      }
      if (!UUID_SHAPE_RE.test(integrationId)) {
        jsonError(
          res,
          400,
          'DEPROVISION_INTEGRATION_ID_INVALID',
          'integrationId must be a UUID',
        )
        return
      }
      const data = await previewDeprovisionForUser(req.params.userId, integrationId)
      jsonOk(res, data)
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === 'USER_NOT_FOUND' || code === 'INTEGRATION_NOT_FOUND') {
        jsonError(res, 404, code, (error as Error).message)
        return
      }
      jsonError(res, 500, 'DEPROVISION_PREVIEW_FAILED', 'Preview failed')
    }
  })

  router.get('/deprovision/events', async (req: Request, res: Response) => {
    await listDeprovisionEventsForRequest(req, res)
  })

  router.get(
    '/integrations/:integrationId/deprovision-events',
    async (req: Request, res: Response) => {
      await listDeprovisionEventsForRequest(
        req,
        res,
        req.params.integrationId,
      )
    },
  )

  router.get(
    '/deprovision-events/:eventId/effects',
    async (req: Request, res: Response) => {
      await listDeprovisionEffectsForRequest(req, res)
    },
  )

  router.get('/deprovision/events/:eventId/effects', async (req: Request, res: Response) => {
    await listDeprovisionEffectsForRequest(req, res)
  })

  router.post('/deprovision/events/:eventId/restore', async (req: Request, res: Response) => {
    const mode = readCompatibilityRestoreMode(req.body?.mode)
    if (mode === null) {
      const adminUserId = await ensurePlatformAdmin(req, res)
      if (!adminUserId) return
      jsonError(
        res,
        400,
        'RESTORE_MODE_INVALID',
        'mode must be rehire or admin_force',
      )
      return
    }
    await restoreDeprovisionEventForRequest(req, res, mode)
  })

  router.post(
    '/deprovision-events/:eventId/reactivate',
    async (req: Request, res: Response) => {
      await restoreDeprovisionEventForRequest(req, res, 'rehire')
    },
  )

  router.post(
    '/deprovision-events/:eventId/force-reactivate',
    async (req: Request, res: Response) => {
      await restoreDeprovisionEventForRequest(req, res, 'admin_force')
    },
  )

  router.post(
    '/deprovision-events/:eventId/compensate-orphan-deny',
    async (req: Request, res: Response) => {
      await compensateSupersededDenyGrantForRequest(req, res)
    },
  )

  return router
}
