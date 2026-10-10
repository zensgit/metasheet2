/**
 * #6163 S6 — routes/admin-directory.ts (mounted at /api/admin/directory): no 5xx body carries caught error
 * text, and the status of a directory-sync failure comes from the error's TYPE, not from a regex over its text.
 *
 * WHAT IS PINNED
 *   - Every catch clause in the route file is listed below (CATCH_SITES: `catch (x)`; BARE_CATCH_SITES:
 *     `catch {`), in source order, and the lists are compared with the file's AST — each clause named by the
 *     router registration or request helper that encloses it — and with the plain `catch (` count. A new catch
 *     without a case reds this file; so does a sendDirectoryFailure call the table does not know.
 *   - Untyped failure at every clause: the awaited service rejects with `Error('MARKER_x7q_<n>')`. A 5xx answer
 *     carries the route's own code and its FIXED sentence; neither the body nor any header contains the marker;
 *     where the route logs, the marker reached logger.warn (the text moved to the log, it did not vanish). The
 *     five literal-400 echo sites (provider, transport or database-driver text) are 4xx, outside that rule: they are pinned as they are (400,
 *     the route's code, the caught text), so changing them is a visible decision.
 *   - The three typed directory-sync errors through every sendDirectoryFailure site: 400 / 404 / 409 with the
 *     typed sentence and the route's code; the specific branches in front of the helper still win; a batch
 *     that commits nothing answers by the TYPE of its first failure.
 *   - The deprovision coded refusals keep their exact mapping after the move to literal statuses.
 *
 * HOW: handlers are invoked straight off the router stack with a response stub (never request(app), the CI
 * tripwire); the services are mocked at their module seams while the REAL error classes are kept.
 */
import type { Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const syncMocks = vi.hoisted(() => ({
  acknowledgeDirectorySyncAlert: vi.fn(),
  admitDirectoryAccountUser: vi.fn(),
  batchAdmitDirectoryAccountUsers: vi.fn(),
  batchBindDirectoryAccounts: vi.fn(),
  batchUnbindDirectoryAccounts: vi.fn(),
  bindDirectoryAccount: vi.fn(),
  createDirectoryIntegration: vi.fn(),
  getDirectoryAccountSummary: vi.fn(),
  getDirectoryReviewItem: vi.fn(),
  getDirectorySyncRun: vi.fn(),
  getDirectorySyncScheduleSnapshot: vi.fn(),
  listDirectoryIntegrationAccounts: vi.fn(),
  listDirectoryIntegrationDepartments: vi.fn(),
  listDirectoryIntegrations: vi.fn(),
  listDirectoryReviewItems: vi.fn(),
  listDirectorySyncAlerts: vi.fn(),
  listDirectorySyncRuns: vi.fn(),
  previewDirectorySyncIntegration: vi.fn(),
  syncDirectoryIntegration: vi.fn(),
  testDirectoryIntegration: vi.fn(),
  unbindDirectoryAccount: vi.fn(),
  updateDirectoryIntegration: vi.fn(),
}))

const alertDeliveryMocks = vi.hoisted(() => ({
  getDirectoryInactiveLinkedMetric: vi.fn(),
  getDirectoryManagerBindingCoverage: vi.fn(),
}))

const workNotificationMocks = vi.hoisted(() => ({
  getDingTalkWorkNotificationRuntimeStatusFromStore: vi.fn(),
  saveDingTalkWorkNotificationAgentId: vi.fn(),
  testDingTalkWorkNotificationAgentId: vi.fn(),
}))

const approvalCardMocks = vi.hoisted(() => ({
  generateApprovalCardLinkSecret: vi.fn(),
  getApprovalCardConfigStatus: vi.fn(),
  saveApprovalCardPublicAppUrl: vi.fn(),
}))

const evidenceMocks = vi.hoisted(() => ({
  compensateSupersededDenyGrant: vi.fn(),
  listDeprovisionEffects: vi.fn(),
  listDeprovisionEvents: vi.fn(),
  previewDeprovisionForUser: vi.fn(),
  readDeprovisionRuntimeFlags: vi.fn(),
  restoreDeprovisionEvent: vi.fn(),
}))

const schedulerMocks = vi.hoisted(() => ({
  refreshDirectoryIntegrationSchedule: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/directory/directory-sync', async (importOriginal) => {
  // The REAL module, so the error classes the route checks with `instanceof` are the production ones;
  // only the service functions the router awaits are replaced.
  const actual = await importOriginal<typeof import('../../src/directory/directory-sync')>()
  return { ...actual, ...syncMocks }
})
vi.mock('../../src/directory/directory-sync-alert-delivery', () => alertDeliveryMocks)
vi.mock('../../src/integrations/dingtalk/work-notification-settings', () => workNotificationMocks)
vi.mock('../../src/integrations/dingtalk/approval-card-config', () => approvalCardMocks)
vi.mock('../../src/directory/deprovision-evidence-api', () => evidenceMocks)
vi.mock('../../src/directory/directory-sync-scheduler', () => schedulerMocks)
vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))
vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))

import { Logger } from '../../src/core/logger'
import {
  DirectoryConflictError,
  DirectoryNotFoundError,
  DirectorySyncFrozenByTransferError,
  DirectorySyncInProgressError,
  DirectoryTenantChangeBlockedError,
  DirectoryValidationError,
} from '../../src/directory/directory-sync'
import {
  RECOVERY_CONFLICT_HTTP_CODE,
  RECOVERY_CONFLICT_HTTP_MESSAGE,
  RecoveryConflictError,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { DingTalkCorpNotAllowedError } from '../../src/integrations/dingtalk/runtime-policy'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_SOURCE = fs.readFileSync(path.resolve(HERE, '../../src/routes/admin-directory.ts'), 'utf8')

const MARKER = 'MARKER_x7q'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_UUID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'

type Method = 'get' | 'post' | 'put'
interface Call {
  method: Method
  path: string
  params?: Record<string, string>
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}
type Outcome =
  /** sendDirectoryFailure: the typed errors answer 400 / 404 / 409, anything else 500 with `fallback`. */
  | { kind: 'helper'; code: string; fallback: string }
  /** A fixed 5xx sentence written in the handler itself. */
  | { kind: 'fixed'; status: number; code: string; message: string; logged: boolean }
  /** A literal-400 echo site (provider, transport or database-driver text) left as it is: it still echoes (4xx, outside the 5xx rule). */
  | { kind: 'echo400'; code: string }
interface Site {
  /** `VERB /path` of the router registration, or `fn:<name>` of the request helper, enclosing the clause. */
  owner: string
  /** Which clause, when a handler has two. */
  clause?: string
  calls: Call[]
  /** Make the service this clause awaits fail with `error`. */
  fail: (error: unknown) => void
  outcome: Outcome
}
interface NoResponseCatch {
  owner: string
  /** Why this clause is not a response sink. */
  noResponse: string
}

const rejectWith = (fn: ReturnType<typeof vi.fn>) => (error: unknown) => {
  fn.mockRejectedValue(error)
}
const helper = (code: string, fallback: string): Outcome => ({ kind: 'helper', code, fallback })
const fixed500 = (code: string, message: string): Outcome => ({ kind: 'fixed', status: 500, code, message, logged: false })

const INTEGRATION = { integrationId: 'd1000000-0000-4000-8000-000000000001' }
const ACCOUNT = { accountId: 'ac000000-0000-4000-8000-000000000001' }

/** Every `catch (x)` clause of routes/admin-directory.ts, in source order. */
const CATCH_SITES: Site[] = [
  {
    owner: 'GET /dingtalk/work-notification',
    calls: [{ method: 'get', path: '/dingtalk/work-notification' }],
    fail: rejectWith(workNotificationMocks.getDingTalkWorkNotificationRuntimeStatusFromStore),
    outcome: helper('DINGTALK_WORK_NOTIFICATION_STATUS_FAILED', 'Failed to load DingTalk work notification status'),
  },
  {
    owner: 'POST /dingtalk/work-notification/test',
    calls: [{ method: 'post', path: '/dingtalk/work-notification/test', body: {} }],
    fail: rejectWith(workNotificationMocks.testDingTalkWorkNotificationAgentId),
    outcome: { kind: 'echo400', code: 'DINGTALK_WORK_NOTIFICATION_TEST_FAILED' },
  },
  {
    owner: 'PUT /dingtalk/work-notification',
    calls: [{ method: 'put', path: '/dingtalk/work-notification', body: {} }],
    fail: rejectWith(workNotificationMocks.saveDingTalkWorkNotificationAgentId),
    outcome: { kind: 'echo400', code: 'DINGTALK_WORK_NOTIFICATION_SAVE_FAILED' },
  },
  {
    owner: 'GET /integrations',
    calls: [{ method: 'get', path: '/integrations' }],
    fail: rejectWith(syncMocks.listDirectoryIntegrations),
    outcome: helper('DIRECTORY_LIST_FAILED', 'Failed to load directory integrations'),
  },
  {
    owner: 'POST /integrations',
    calls: [{ method: 'post', path: '/integrations', body: {} }],
    fail: rejectWith(syncMocks.createDirectoryIntegration),
    outcome: helper('DIRECTORY_CREATE_FAILED', 'Failed to create directory integration'),
  },
  {
    owner: 'PUT /integrations/:integrationId',
    clause: 'saved-timezone read',
    // A cron with no scheduleTimezone key makes the route read the saved zone before validating.
    calls: [{ method: 'put', path: '/integrations/:integrationId', params: INTEGRATION, body: { scheduleCron: '0 2 * * *' } }],
    fail: rejectWith(syncMocks.getDirectorySyncScheduleSnapshot),
    outcome: {
      kind: 'fixed',
      status: 503,
      code: 'DIRECTORY_SCHEDULE_CONFIG_UNREADABLE',
      message: 'Could not read the integration\'s saved schedule timezone, so scheduleCron cannot be validated against the zone it will run in. No change was made; retry.',
      logged: true,
    },
  },
  {
    owner: 'PUT /integrations/:integrationId',
    clause: 'update',
    calls: [{ method: 'put', path: '/integrations/:integrationId', params: INTEGRATION, body: {} }],
    fail: rejectWith(syncMocks.updateDirectoryIntegration),
    outcome: helper('DIRECTORY_UPDATE_FAILED', 'Failed to update directory integration'),
  },
  {
    owner: 'GET /integrations/:integrationId/approval-card-config',
    calls: [{ method: 'get', path: '/integrations/:integrationId/approval-card-config', params: INTEGRATION }],
    fail: rejectWith(approvalCardMocks.getApprovalCardConfigStatus),
    outcome: helper('APPROVAL_CARD_CONFIG_STATUS_FAILED', 'Failed to load approval card config status'),
  },
  {
    owner: 'POST /integrations/:integrationId/approval-card-config/secret/generate',
    calls: [{ method: 'post', path: '/integrations/:integrationId/approval-card-config/secret/generate', params: INTEGRATION }],
    fail: rejectWith(approvalCardMocks.generateApprovalCardLinkSecret),
    outcome: { kind: 'echo400', code: 'APPROVAL_CARD_SECRET_GENERATE_FAILED' },
  },
  {
    owner: 'PUT /integrations/:integrationId/approval-card-config',
    calls: [{ method: 'put', path: '/integrations/:integrationId/approval-card-config', params: INTEGRATION, body: { publicAppUrl: '' } }],
    fail: rejectWith(approvalCardMocks.saveApprovalCardPublicAppUrl),
    outcome: { kind: 'echo400', code: 'APPROVAL_CARD_CONFIG_SAVE_FAILED' },
  },
  {
    owner: 'POST /integrations/test',
    calls: [{ method: 'post', path: '/integrations/test', body: {} }],
    fail: rejectWith(syncMocks.testDirectoryIntegration),
    outcome: { kind: 'echo400', code: 'DIRECTORY_TEST_FAILED' },
  },
  {
    owner: 'POST /integrations/:integrationId/sync',
    clause: 'async start, before the run row exists',
    calls: [{ method: 'post', path: '/integrations/:integrationId/sync', params: INTEGRATION, body: { async: true } }],
    fail: rejectWith(syncMocks.syncDirectoryIntegration),
    outcome: helper('DIRECTORY_SYNC_FAILED', 'Failed to start directory sync'),
  },
  {
    owner: 'POST /integrations/:integrationId/sync',
    clause: 'synchronous run',
    calls: [{ method: 'post', path: '/integrations/:integrationId/sync', params: INTEGRATION, body: {} }],
    fail: rejectWith(syncMocks.syncDirectoryIntegration),
    outcome: helper('DIRECTORY_SYNC_FAILED', 'Failed to sync directory integration'),
  },
  {
    owner: 'POST /integrations/:integrationId/sync/preview',
    calls: [{ method: 'post', path: '/integrations/:integrationId/sync/preview', params: INTEGRATION }],
    fail: rejectWith(syncMocks.previewDirectorySyncIntegration),
    outcome: helper('DIRECTORY_SYNC_PREVIEW_FAILED', 'Failed to preview directory sync'),
  },
  {
    owner: 'GET /integrations/:integrationId/runs',
    calls: [{ method: 'get', path: '/integrations/:integrationId/runs', params: INTEGRATION }],
    fail: rejectWith(syncMocks.listDirectorySyncRuns),
    outcome: helper('DIRECTORY_RUNS_FAILED', 'Failed to load sync runs'),
  },
  {
    owner: 'GET /integrations/:integrationId/runs/:runId',
    calls: [{ method: 'get', path: '/integrations/:integrationId/runs/:runId', params: { ...INTEGRATION, runId: RUN_ID } }],
    fail: rejectWith(syncMocks.getDirectorySyncRun),
    outcome: helper('DIRECTORY_RUN_FAILED', 'Failed to load sync run'),
  },
  {
    owner: 'GET /integrations/:integrationId/schedule',
    calls: [{ method: 'get', path: '/integrations/:integrationId/schedule', params: INTEGRATION }],
    fail: rejectWith(syncMocks.getDirectorySyncScheduleSnapshot),
    outcome: helper('DIRECTORY_SCHEDULE_FAILED', 'Failed to load directory schedule'),
  },
  {
    owner: 'GET /integrations/:integrationId/alerts',
    calls: [{ method: 'get', path: '/integrations/:integrationId/alerts', params: INTEGRATION }],
    fail: rejectWith(syncMocks.listDirectorySyncAlerts),
    outcome: helper('DIRECTORY_ALERTS_FAILED', 'Failed to load directory alerts'),
  },
  {
    owner: 'GET /integrations/:integrationId/review-items',
    calls: [{ method: 'get', path: '/integrations/:integrationId/review-items', params: INTEGRATION }],
    fail: rejectWith(syncMocks.listDirectoryReviewItems),
    outcome: helper('DIRECTORY_REVIEW_ITEMS_FAILED', 'Failed to load directory review items'),
  },
  {
    owner: 'GET /integrations/:integrationId/accounts',
    calls: [{ method: 'get', path: '/integrations/:integrationId/accounts', params: INTEGRATION }],
    fail: rejectWith(syncMocks.listDirectoryIntegrationAccounts),
    outcome: helper('DIRECTORY_ACCOUNTS_FAILED', 'Failed to load directory accounts'),
  },
  {
    owner: 'GET /integrations/:integrationId/departments',
    calls: [{ method: 'get', path: '/integrations/:integrationId/departments', params: INTEGRATION }],
    fail: rejectWith(syncMocks.listDirectoryIntegrationDepartments),
    outcome: helper('DIRECTORY_DEPARTMENTS_FAILED', 'Failed to load directory departments'),
  },
  {
    owner: 'GET /integrations/:integrationId/manager-coverage',
    calls: [{ method: 'get', path: '/integrations/:integrationId/manager-coverage', params: INTEGRATION }],
    fail: rejectWith(alertDeliveryMocks.getDirectoryManagerBindingCoverage),
    outcome: helper('DIRECTORY_MANAGER_COVERAGE_FAILED', 'Failed to load directory manager binding coverage'),
  },
  {
    owner: 'GET /integrations/:integrationId/inactive-linked',
    calls: [{ method: 'get', path: '/integrations/:integrationId/inactive-linked', params: INTEGRATION }],
    fail: rejectWith(alertDeliveryMocks.getDirectoryInactiveLinkedMetric),
    outcome: helper('DIRECTORY_INACTIVE_LINKED_FAILED', 'Failed to load directory inactive-linked metric'),
  },
  {
    owner: 'GET /accounts/:accountId',
    calls: [{ method: 'get', path: '/accounts/:accountId', params: ACCOUNT }],
    fail: rejectWith(syncMocks.getDirectoryAccountSummary),
    outcome: helper('DIRECTORY_ACCOUNT_FAILED', 'Failed to load directory account'),
  },
  {
    owner: 'GET /accounts/:accountId/review-item',
    calls: [{ method: 'get', path: '/accounts/:accountId/review-item', params: ACCOUNT }],
    fail: rejectWith(syncMocks.getDirectoryReviewItem),
    outcome: helper('DIRECTORY_REVIEW_ITEM_FAILED', 'Failed to load directory review item'),
  },
  {
    owner: 'POST /accounts/:accountId/bind',
    calls: [{ method: 'post', path: '/accounts/:accountId/bind', params: ACCOUNT, body: { localUserRef: 'user-1' } }],
    fail: rejectWith(syncMocks.bindDirectoryAccount),
    outcome: helper('DIRECTORY_BIND_FAILED', 'Failed to bind directory account'),
  },
  {
    owner: 'POST /accounts/:accountId/admit-user',
    calls: [{ method: 'post', path: '/accounts/:accountId/admit-user', params: ACCOUNT, body: { name: 'New User', email: 'new@example.com' } }],
    fail: rejectWith(syncMocks.admitDirectoryAccountUser),
    outcome: helper('DIRECTORY_ADMISSION_FAILED', 'Failed to create and bind local user for directory account'),
  },
  {
    owner: 'POST /accounts/batch-bind',
    calls: [{ method: 'post', path: '/accounts/batch-bind', body: { bindings: [{ accountId: 'ac000000-0000-4000-8000-000000000001', localUserRef: 'user-1' }] } }],
    fail: rejectWith(syncMocks.batchBindDirectoryAccounts),
    outcome: helper('DIRECTORY_BATCH_BIND_FAILED', 'Failed to batch bind directory accounts'),
  },
  {
    owner: 'POST /accounts/batch-admit-users',
    calls: [{ method: 'post', path: '/accounts/batch-admit-users', body: { accountIds: ['ac000000-0000-4000-8000-000000000001'] } }],
    fail: rejectWith(syncMocks.batchAdmitDirectoryAccountUsers),
    outcome: helper('DIRECTORY_BATCH_ADMISSION_FAILED', 'Failed to batch create and bind local users for directory accounts'),
  },
  {
    owner: 'POST /accounts/:accountId/unbind',
    calls: [{ method: 'post', path: '/accounts/:accountId/unbind', params: ACCOUNT, body: {} }],
    fail: rejectWith(syncMocks.unbindDirectoryAccount),
    outcome: helper('DIRECTORY_UNBIND_FAILED', 'Failed to unbind directory account'),
  },
  {
    owner: 'POST /accounts/batch-unbind',
    calls: [{ method: 'post', path: '/accounts/batch-unbind', body: { accountIds: ['ac000000-0000-4000-8000-000000000001'] } }],
    fail: rejectWith(syncMocks.batchUnbindDirectoryAccounts),
    outcome: helper('DIRECTORY_BATCH_UNBIND_FAILED', 'Failed to batch unbind directory accounts'),
  },
  {
    owner: 'POST /alerts/:alertId/ack',
    calls: [{ method: 'post', path: '/alerts/:alertId/ack', params: { alertId: 'a1000000-0000-4000-8000-000000000001' } }],
    fail: rejectWith(syncMocks.acknowledgeDirectorySyncAlert),
    outcome: helper('DIRECTORY_ALERT_ACK_FAILED', 'Failed to acknowledge directory alert'),
  },
  {
    owner: 'fn:restoreDeprovisionEventForRequest',
    calls: [
      { method: 'post', path: '/deprovision/events/:eventId/restore', params: { eventId: EVENT_ID }, body: { mode: 'rehire' } },
      { method: 'post', path: '/deprovision-events/:eventId/reactivate', params: { eventId: EVENT_ID }, body: {} },
      { method: 'post', path: '/deprovision-events/:eventId/force-reactivate', params: { eventId: EVENT_ID }, body: {} },
    ],
    fail: rejectWith(evidenceMocks.restoreDeprovisionEvent),
    outcome: fixed500('DEPROVISION_RESTORE_FAILED', 'Restore failed'),
  },
  {
    owner: 'fn:compensateSupersededDenyGrantForRequest',
    calls: [{ method: 'post', path: '/deprovision-events/:eventId/compensate-orphan-deny', params: { eventId: EVENT_ID }, body: { confirm: true, note: 'orphan deny row' } }],
    fail: rejectWith(evidenceMocks.compensateSupersededDenyGrant),
    outcome: fixed500('DEPROVISION_COMPENSATION_FAILED', 'Deny-row compensation failed'),
  },
  {
    owner: 'GET /deprovision/preview/:userId',
    calls: [{ method: 'get', path: '/deprovision/preview/:userId', params: { userId: 'user-1' }, query: { integrationId: INTEGRATION_UUID } }],
    fail: rejectWith(evidenceMocks.previewDeprovisionForUser),
    outcome: fixed500('DEPROVISION_PREVIEW_FAILED', 'Preview failed'),
  },
]

/** Every `catch {` clause (no binding: nothing caught can be echoed), in source order. */
const BARE_CATCH_SITES: Array<Site | NoResponseCatch> = [
  { owner: 'fn:isDirectoryScheduleCronValid', noResponse: 'returns false; the handler answers 400 DIRECTORY_SCHEDULE_CRON_INVALID itself' },
  { owner: 'fn:isDirectoryScheduleCronParseable', noResponse: 'returns false; the handler answers 400 DIRECTORY_SCHEDULE_CRON_INVALID itself' },
  {
    owner: 'fn:listDeprovisionEventsForRequest',
    calls: [
      { method: 'get', path: '/deprovision/events' },
      { method: 'get', path: '/integrations/:integrationId/deprovision-events', params: { integrationId: INTEGRATION_UUID } },
    ],
    fail: rejectWith(evidenceMocks.listDeprovisionEvents),
    outcome: fixed500('DEPROVISION_EVENTS_FAILED', 'List events failed'),
  },
  {
    owner: 'fn:listDeprovisionEffectsForRequest',
    calls: [
      { method: 'get', path: '/deprovision-events/:eventId/effects', params: { eventId: EVENT_ID } },
      { method: 'get', path: '/deprovision/events/:eventId/effects', params: { eventId: EVENT_ID } },
    ],
    fail: rejectWith(evidenceMocks.listDeprovisionEffects),
    outcome: fixed500('DEPROVISION_EFFECTS_FAILED', 'List effects failed'),
  },
]

const isSite = (entry: Site | NoResponseCatch): entry is Site => 'calls' in entry
const RESPONDING_SITES: Site[] = [...CATCH_SITES, ...BARE_CATCH_SITES.filter(isSite)]
const HELPER_SITES = CATCH_SITES.filter((site) => site.outcome.kind === 'helper')
const ECHO_400_SITES = CATCH_SITES.filter((site) => site.outcome.kind === 'echo400')
const siteName = (site: Site): string => (site.clause ? `${site.owner} (${site.clause})` : site.owner)

/** A batch route whose service resolved with every item failed (nothing committed). */
interface NothingCommitted {
  call: Call
  resolve: (failure: unknown, failureText: string) => void
  code: string
  fallback: string
}
const NOTHING_COMMITTED: NothingCommitted[] = [
  {
    call: CATCH_SITES.find((s) => s.owner === 'POST /accounts/batch-bind')!.calls[0],
    resolve: (failure, failureText) => {
      syncMocks.batchBindDirectoryAccounts.mockResolvedValue({
        succeeded: [],
        failed: [{ accountId: 'ac000000-0000-4000-8000-000000000001', error: failureText }],
        failedErrors: [failure],
      })
    },
    code: 'DIRECTORY_BATCH_BIND_FAILED',
    fallback: 'Failed to batch bind directory accounts',
  },
  {
    call: CATCH_SITES.find((s) => s.owner === 'POST /accounts/batch-admit-users')!.calls[0],
    resolve: (failure, failureText) => {
      syncMocks.batchAdmitDirectoryAccountUsers.mockResolvedValue({
        succeeded: [],
        failed: [{ accountId: 'ac000000-0000-4000-8000-000000000001', error: failureText }],
        failedErrors: [failure],
      })
    },
    code: 'DIRECTORY_BATCH_ADMISSION_FAILED',
    fallback: 'Failed to batch create and bind local users for directory accounts',
  },
  {
    call: CATCH_SITES.find((s) => s.owner === 'POST /accounts/batch-unbind')!.calls[0],
    resolve: (failure, failureText) => {
      syncMocks.batchUnbindDirectoryAccounts.mockResolvedValue({
        succeeded: [],
        failed: [{ accountId: 'ac000000-0000-4000-8000-000000000001', error: failureText }],
        failedErrors: [failure],
      })
    },
    code: 'DIRECTORY_BATCH_UNBIND_FAILED',
    fallback: 'Failed to batch unbind directory accounts',
  },
]

const TYPED = [
  { name: 'DirectoryValidationError', make: (m: string) => new DirectoryValidationError(m), status: 400, message: 'integrationId is required' },
  { name: 'DirectoryNotFoundError', make: (m: string) => new DirectoryNotFoundError(m), status: 404, message: 'Directory account not found' },
  { name: 'DirectoryConflictError', make: (m: string) => new DirectoryConflictError(m), status: 409, message: 'Directory account binding changed; retry the operation' },
] as const

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────

interface StubResponse {
  statusCode: number
  body: unknown
  headers: Record<string, string>
}

function stubResponse(): StubResponse & Record<string, unknown> {
  const headers: Record<string, string> = {}
  const record = (name: unknown, value: unknown) => {
    headers[String(name).toLowerCase()] = String(value)
  }
  return {
    statusCode: 200,
    body: undefined,
    headers,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
    send(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
    setHeader(name: string, value: unknown) {
      record(name, value)
      return this
    },
    set(field: string | Record<string, unknown>, value?: unknown) {
      if (typeof field === 'string') record(field, value)
      else for (const [name, v] of Object.entries(field)) record(name, v)
      return this
    },
    header(field: string, value: unknown) {
      record(field, value)
      return this
    },
    getHeader(name: string) {
      return headers[String(name).toLowerCase()]
    },
  }
}

type RouteLayer = {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
  }
}

async function invoke(call: Call): Promise<StubResponse> {
  const router = adminDirectoryRouter() as unknown as { stack: RouteLayer[] }
  const layer = router.stack.find((entry) => entry.route?.path === call.path && entry.route?.methods?.[call.method])
  if (!layer?.route) throw new Error(`Route ${call.method.toUpperCase()} ${call.path} not found`)
  const res = stubResponse()
  const req = {
    method: call.method.toUpperCase(),
    url: call.path,
    headers: {},
    params: call.params ?? {},
    query: call.query ?? {},
    body: call.body ?? {},
    // The legacy admin claim short-circuits the module-local ensurePlatformAdmin's RBAC read.
    user: { id: 'admin-1', role: 'admin' },
  } as unknown as Request
  let forwarded: unknown
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res as unknown as Response, (err?: unknown) => {
    forwarded = err
  })
  if (forwarded) throw forwarded
  return res
}

const describeCall = (call: Call): string => `${call.method.toUpperCase()} ${call.path}`
const bodyAndHeaders = (res: StubResponse): string => JSON.stringify(res.body) + JSON.stringify(res.headers)
const markerError = (): Error & { code: string } =>
  Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })

let warnSpy: ReturnType<typeof vi.spyOn>
/** Every string handed to logger.warn (message and meta values), unescaped. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}
const loggedTexts = (): string => collectStrings(warnSpy.mock.calls).join('\n')

beforeEach(() => {
  for (const group of [syncMocks, alertDeliveryMocks, workNotificationMocks, approvalCardMocks, evidenceMocks, schedulerMocks, auditMocks]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  evidenceMocks.readDeprovisionRuntimeFlags.mockReturnValue({})
  auditMocks.auditLog.mockResolvedValue(undefined)
  // Silences the route's warn logs and lets a probe check that the caught text reached the log.
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

// ── enumeration ──────────────────────────────────────────────────────────────────────────────────────

/** Each catch clause in `text`, named by the `router.<verb>('<path>', …)` call or function declaration enclosing it. */
function catchClausesIn(text: string): Array<{ owner: string; binding: boolean }> {
  const sf = ts.createSourceFile('admin-directory.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const ownerOf = (node: ts.Node): string => {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (
        ts.isCallExpression(cur)
        && ts.isPropertyAccessExpression(cur.expression)
        && ts.isIdentifier(cur.expression.expression)
        && cur.expression.expression.text === 'router'
        && cur.arguments.length > 0
        && ts.isStringLiteralLike(cur.arguments[0])
      ) {
        return `${cur.expression.name.text.toUpperCase()} ${cur.arguments[0].text}`
      }
      if (ts.isFunctionDeclaration(cur) && cur.name) return `fn:${cur.name.text}`
    }
    return '<module>'
  }
  const out: Array<{ owner: string; binding: boolean }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) out.push({ owner: ownerOf(node), binding: node.variableDeclaration !== undefined })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('routes/admin-directory.ts — every catch clause is enumerated (#6163 S6)', () => {
  it('CATCH_SITES lists every `catch (x)` clause and BARE_CATCH_SITES every `catch {`, in source order', () => {
    const clauses = catchClausesIn(ROUTE_SOURCE)
    expect(clauses.filter((c) => c.binding).map((c) => c.owner)).toEqual(CATCH_SITES.map((s) => s.owner))
    expect(clauses.filter((c) => !c.binding).map((c) => c.owner)).toEqual(BARE_CATCH_SITES.map((s) => s.owner))
    // The plain-text count, so a clause the AST walk could misread still has to be listed.
    expect(ROUTE_SOURCE.split('catch (').length - 1).toBe(CATCH_SITES.length)
    expect(CATCH_SITES.length).toBe(35)
  })

  it('every sendDirectoryFailure call in the route is a helper site of the table, with its code and literal fallback', () => {
    const calls = [...ROUTE_SOURCE.matchAll(/sendDirectoryFailure\(res, error, '([A-Z_]+)', '([^']+)'\)/g)]
      .map((m) => `${m[1]} | ${m[2]}`)
    const listed = HELPER_SITES.map((s) => (s.outcome.kind === 'helper' ? `${s.outcome.code} | ${s.outcome.fallback}` : ''))
    // Every call passes literals (the regex would not match anything else), and the two lists agree.
    expect(ROUTE_SOURCE.split('sendDirectoryFailure(').length - 1).toBe(calls.length + 1) // + the declaration
    expect(calls).toEqual(listed)
  })

  it('the five literal-400 echo sites (provider, transport or database-driver text) are the only echo sites left', () => {
    expect(ECHO_400_SITES.map((s) => s.outcome.kind === 'echo400' && s.outcome.code)).toEqual([
      'DINGTALK_WORK_NOTIFICATION_TEST_FAILED',
      'DINGTALK_WORK_NOTIFICATION_SAVE_FAILED',
      'APPROVAL_CARD_SECRET_GENERATE_FAILED',
      'APPROVAL_CARD_CONFIG_SAVE_FAILED',
      'DIRECTORY_TEST_FAILED',
    ])
  })
})

// ── untyped failures: fixed 5xx sentence, no caught text ────────────────────────────────────────────

let markerProbesRun = 0
const EXPECTED_MARKER_PROBES =
  RESPONDING_SITES.filter((s) => s.outcome.kind !== 'echo400').reduce((n, s) => n + s.calls.length, 0)
  + NOTHING_COMMITTED.length
  + 1 // the test-send outcome-unknown 502

describe('an untyped failure at every catch clause answers a fixed 5xx sentence — never the caught text', () => {
  RESPONDING_SITES.forEach((site, index) => {
    const outcome = site.outcome
    if (outcome.kind === 'echo400') return
    const status = outcome.kind === 'helper' ? 500 : outcome.status
    const message = outcome.kind === 'helper' ? outcome.fallback : outcome.message
    const logged = outcome.kind === 'helper' ? true : outcome.logged
    for (const call of site.calls) {
      it(`${siteName(site)} via ${describeCall(call)} → ${status} ${outcome.code}`, async () => {
        const marker = `${MARKER}_${index} connect ECONNREFUSED`
        site.fail(new Error(marker))
        const res = await invoke(call)
        expect(res.statusCode).toBe(status)
        expect(res.body).toEqual({ ok: false, error: { code: outcome.code, message, details: undefined } })
        expect(bodyAndHeaders(res)).not.toContain(MARKER)
        if (logged) expect(loggedTexts()).toContain(marker)
        markerProbesRun += 1
      })
    }
  })

  it('POST /dingtalk/work-notification/test: an outcome-unknown send answers 502 with a fixed sentence, the transport text logged', async () => {
    const marker = `${MARKER}_502 DingTalk request timed out after 10000ms`
    workNotificationMocks.testDingTalkWorkNotificationAgentId.mockRejectedValue(
      Object.assign(new Error(marker), { outcomeUnknown: true }),
    )
    const res = await invoke({ method: 'post', path: '/dingtalk/work-notification/test', body: {} })
    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DINGTALK_TEST_SEND_OUTCOME_UNKNOWN',
        message: 'DingTalk did not confirm the outcome. The test message may still have been delivered — check the test message on the device before retrying.',
        details: undefined,
      },
    })
    expect(bodyAndHeaders(res)).not.toContain(MARKER)
    expect(loggedTexts()).toContain(marker)
    markerProbesRun += 1
  })

  for (const batch of NOTHING_COMMITTED) {
    it(`${describeCall(batch.call)}: a batch that commits nothing on an untyped failure → 500 ${batch.code}, fixed sentence`, async () => {
      const marker = `${MARKER}_batch relation "users" does not exist`
      batch.resolve(new Error(marker), marker)
      const res = await invoke(batch.call)
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({ ok: false, error: { code: batch.code, message: batch.fallback, details: undefined } })
      expect(bodyAndHeaders(res)).not.toContain(MARKER)
      expect(loggedTexts()).toContain(marker)
      markerProbesRun += 1
    })
  }
})

describe('the five literal-400 echo sites (provider, transport or database-driver text) still echo (4xx, outside the 5xx rule) — pinned so a change is visible', () => {
  for (const site of ECHO_400_SITES) {
    const outcome = site.outcome
    if (outcome.kind !== 'echo400') continue
    it(`${siteName(site)}: an untyped failure answers a literal 400 ${outcome.code} carrying the caught text`, async () => {
      const text = `${MARKER}_echo provider diagnostic`
      site.fail(new Error(text))
      const res = await invoke(site.calls[0])
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code: outcome.code, message: text, details: undefined } })
    })
  }
})

// ── typed failures: the status comes from the type ──────────────────────────────────────────────────

describe('the typed directory-sync errors answer by TYPE at every sendDirectoryFailure site', () => {
  for (const site of HELPER_SITES) {
    const outcome = site.outcome
    if (outcome.kind !== 'helper') continue
    for (const typed of TYPED) {
      it(`${siteName(site)}: ${typed.name} → ${typed.status} ${outcome.code} with the typed sentence`, async () => {
        site.fail(typed.make(typed.message))
        const res = await invoke(site.calls[0])
        expect(res.statusCode).toBe(typed.status)
        expect(res.body).toEqual({ ok: false, error: { code: outcome.code, message: typed.message, details: undefined } })
        // A typed failure is an answer, not an incident: the helper's 500 log line is not written.
        expect(warnSpy).not.toHaveBeenCalledWith(outcome.fallback, expect.anything())
      })
    }
  }

  for (const batch of NOTHING_COMMITTED) {
    for (const typed of TYPED) {
      it(`${describeCall(batch.call)}: a batch that commits nothing on a ${typed.name} → ${typed.status} with the typed sentence`, async () => {
        batch.resolve(typed.make(typed.message), typed.message)
        const res = await invoke(batch.call)
        expect(res.statusCode).toBe(typed.status)
        expect(res.body).toEqual({ ok: false, error: { code: batch.code, message: typed.message, details: undefined } })
      })
    }
    it(`${describeCall(batch.call)}: a batch that commits nothing on a recovery conflict → the uniform retryable 409 (the first error is rethrown as thrown)`, async () => {
      const conflict = new RecoveryConflictError(markerError())
      batch.resolve(conflict, conflict.message)
      const res = await invoke(batch.call)
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: { code: RECOVERY_CONFLICT_HTTP_CODE, message: RECOVERY_CONFLICT_HTTP_MESSAGE, details: { retryable: true } },
      })
    })
  }

  it('the type decides, not the prose: the same not-found sentence untyped is the fixed 500', async () => {
    syncMocks.bindDirectoryAccount.mockRejectedValue(new Error('Directory account not found'))
    const res = await invoke({ method: 'post', path: '/accounts/:accountId/bind', params: ACCOUNT, body: { localUserRef: 'user-1' } })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'DIRECTORY_BIND_FAILED', message: 'Failed to bind directory account', details: undefined } })
  })
})

describe('the specific branches in front of sendDirectoryFailure still win', () => {
  const syncCalls: Call[] = [
    { method: 'post', path: '/integrations/:integrationId/sync', params: INTEGRATION, body: { async: true } },
    { method: 'post', path: '/integrations/:integrationId/sync', params: INTEGRATION, body: {} },
  ]
  for (const call of syncCalls) {
    const label = call.body?.async ? 'async start' : 'synchronous run'
    it(`sync (${label}): a held lease → 409 DIRECTORY_SYNC_IN_PROGRESS with the active run`, async () => {
      syncMocks.syncDirectoryIntegration.mockRejectedValue(new DirectorySyncInProgressError('run-live-1'))
      const res = await invoke(call)
      expect(res.statusCode).toBe(409)
      expect(res.body).toMatchObject({ ok: false, error: { code: 'DIRECTORY_SYNC_IN_PROGRESS', details: { activeRunId: 'run-live-1' } } })
    })
    it(`sync (${label}): an active org transfer → 409 DIRECTORY_SYNC_FROZEN_BY_TRANSFER with the transfer`, async () => {
      syncMocks.syncDirectoryIntegration.mockRejectedValue(new DirectorySyncFrozenByTransferError('transfer-1'))
      const res = await invoke(call)
      expect(res.statusCode).toBe(409)
      expect(res.body).toMatchObject({ ok: false, error: { code: 'DIRECTORY_SYNC_FROZEN_BY_TRANSFER', details: { transferId: 'transfer-1' } } })
    })
  }

  it('preview: a held lease → 409 DIRECTORY_SYNC_IN_PROGRESS', async () => {
    syncMocks.previewDirectorySyncIntegration.mockRejectedValue(new DirectorySyncInProgressError('run-live-2'))
    const res = await invoke({ method: 'post', path: '/integrations/:integrationId/sync/preview', params: INTEGRATION })
    expect(res.statusCode).toBe(409)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'DIRECTORY_SYNC_IN_PROGRESS', details: { activeRunId: 'run-live-2' } } })
  })

  it('update: a blocked tenant change → 409 DIRECTORY_TENANT_CHANGE_BLOCKED', async () => {
    syncMocks.updateDirectoryIntegration.mockRejectedValue(new DirectoryTenantChangeBlockedError('corp_id is immutable'))
    const res = await invoke({ method: 'put', path: '/integrations/:integrationId', params: INTEGRATION, body: {} })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ ok: false, error: { code: 'DIRECTORY_TENANT_CHANGE_BLOCKED', message: 'corp_id is immutable', details: undefined } })
  })

  const corpCalls: Array<{ call: Call; fn: ReturnType<typeof vi.fn>; code: string }> = [
    { call: { method: 'post', path: '/integrations', body: {} }, fn: syncMocks.createDirectoryIntegration, code: 'DIRECTORY_CREATE_FAILED' },
    { call: { method: 'put', path: '/integrations/:integrationId', params: INTEGRATION, body: {} }, fn: syncMocks.updateDirectoryIntegration, code: 'DIRECTORY_UPDATE_FAILED' },
  ]
  for (const { call, fn, code } of corpCalls) {
    it(`${describeCall(call)}: the corp allowlist refusing the submitted corpId keeps its 400 ${code}`, async () => {
      const sentence = 'Directory integration corpId is required when DINGTALK_ALLOWED_CORP_IDS is configured'
      fn.mockRejectedValue(new DingTalkCorpNotAllowedError(sentence, null))
      const res = await invoke(call)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code, message: sentence, details: undefined } })
    })
  }
})

// ── deprovision coded refusals: same mapping, literal statuses ──────────────────────────────────────

describe('deprovision coded refusals keep their exact mapping (one literal status per branch)', () => {
  const RESTORE: Array<[string, number]> = [
    ['EVENT_NOT_FOUND', 404], ['USER_NOT_FOUND', 404],
    ['DRIFT_CONFLICT', 409], ['SOURCE_INACTIVE', 409], ['NO_EFFECTS', 409], ['NOT_APPLIED', 409], ['EVENT_NOT_APPLIED', 409],
    ['FORCE_CONFIRM_REQUIRED', 400], ['FORCE_NOTE_REQUIRED', 400],
    // A code from the compensation lists is not a restore refusal.
    ['COMPENSATION_SOURCE_BUSY', 500],
  ]
  const COMPENSATION: Array<[string, number]> = [
    ['EVENT_NOT_FOUND', 404], ['USER_NOT_FOUND', 404],
    ['COMPENSATION_CONFIRM_REQUIRED', 400], ['COMPENSATION_NOTE_REQUIRED', 400], ['COMPENSATION_ACTOR_REQUIRED', 400],
    ['DRIFT_CONFLICT', 409], ['COMPENSATION_EVENT_NOT_SUPERSEDED', 409], ['COMPENSATION_NOT_APPLICABLE', 409],
    ['COMPENSATION_USER_INACTIVE', 409], ['COMPENSATION_SOURCE_INACTIVE', 409], ['COMPENSATION_SOURCE_BUSY', 409],
    ['COMPENSATION_MEMBERSHIP_INACTIVE', 409], ['COMPENSATION_LIVE_EVIDENCE', 409],
    // A code from the restore lists is not a compensation refusal.
    ['NO_EFFECTS', 500],
  ]
  const restoreCall: Call = { method: 'post', path: '/deprovision/events/:eventId/restore', params: { eventId: EVENT_ID }, body: { mode: 'rehire' } }
  const compensateCall: Call = { method: 'post', path: '/deprovision-events/:eventId/compensate-orphan-deny', params: { eventId: EVENT_ID }, body: { confirm: true, note: 'orphan deny row' } }

  const cases = [
    { label: 'restore', call: restoreCall, fn: evidenceMocks.restoreDeprovisionEvent, table: RESTORE, code500: 'DEPROVISION_RESTORE_FAILED', fallback: 'Restore failed' },
    { label: 'compensate', call: compensateCall, fn: evidenceMocks.compensateSupersededDenyGrant, table: COMPENSATION, code500: 'DEPROVISION_COMPENSATION_FAILED', fallback: 'Deny-row compensation failed' },
  ]
  for (const { label, call, fn, table, code500, fallback } of cases) {
    for (const [code, status] of table) {
      it(`${label}: code ${code} → ${status}`, async () => {
        const sentence = `${MARKER}_coded refusal sentence`
        fn.mockRejectedValue(Object.assign(new Error(sentence), { code }))
        const res = await invoke(call)
        expect(res.statusCode).toBe(status)
        expect(res.body).toEqual(
          status === 500
            ? { ok: false, error: { code: code500, message: fallback, details: undefined } }
            : { ok: false, error: { code, message: sentence, details: undefined } },
        )
      })
    }
    it(`${label}: a coded refusal with an empty message falls back to the fixed sentence`, async () => {
      const [code, status] = table[0]
      fn.mockRejectedValue(Object.assign(new Error(''), { code }))
      const res = await invoke(call)
      expect(res.statusCode).toBe(status)
      expect(res.body).toEqual({ ok: false, error: { code, message: fallback, details: undefined } })
    })
  }
})

describe('non-vacuity', () => {
  it('the marker probes ran, one per responding call plus the 502 and the nothing-committed batches', () => {
    expect(markerProbesRun).toBeGreaterThan(0)
    expect(markerProbesRun).toBe(EXPECTED_MARKER_PROBES)
  })
})
