import { isDeepStrictEqual } from 'node:util'
import type { Page, Response } from '@playwright/test'

export type AutomationCheckpoint = {
  phase: 'before-grant' | 'after-grant' | 'completed' | 'refreshed' | 'revoked'
  grantId?: string
  requestId?: string
} | { phase: 'observe-begin'; grantId: string; requestId: string; poll: number }
  | { phase: 'observe-end'; grantId: string; requestId: string; poll: number; httpStatus: number }
  | { phase: 'await-completed'; grantId: string; requestId: string }
  | { phase: 'interval-before-authoring' }
  | { phase: 'interval-authored' | 'interval-preactivation-tick'; ruleId: string }
  | { phase: 'interval-activated' | 'interval-admitted'; ruleId: string; activationId: string; grantId: string }
  | { phase: 'interval-completed' | 'interval-budget-tick' | 'interval-refreshed' | 'interval-revoked';
      ruleId: string; activationId: string; grantId: string; requestId: string }
export type AutomationCheckpointReply = { requestId: string } | void
export type AutomationScenario = 'manual' | 'interval'
export interface ConfiguredAutomationBrowserResult {
  /** Opaque verification handles, consumed only by the local parent. */
  ruleId: string
  grantId: string
  requestId: string
  evidence: Record<string, boolean | number>
}
export type AutomationApiKey = 'automationOptions' | 'automationGrants' | 'automationGrantDetail'
  | 'automationRequests' | 'automationRequestDetail' | 'automationRevoke'
  | 'automationScheduleActivation' | 'editorRules' | 'editorContext' | 'editorView' | 'editorFields'
type JsonObject = Record<string, unknown>
export interface AutomationBrowserCapabilities {
  armWrite(key: AutomationApiKey, pathname: string, body: unknown): void
  waitApi(key: AutomationApiKey, method?: string, pathname?: string): Promise<Response>
  data(response: Response, status?: number): Promise<JsonObject>
  settled(): Promise<void>
  checkpoint(command: AutomationCheckpoint): Promise<AutomationCheckpointReply>
  refreshDetail(grantId: string, requestId: string, poll: number, fromHistory?: boolean): Promise<JsonObject | null>
}
const prefix = '/api/integration/automation-read'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`APP_BROWSER_AUTOMATION_${code}`) }
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: unknown, keys: string[]): value is JsonObject {
  return object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}

/** Same actual production app/page/session as the preceding PLM/K3/SA04 journey. */
export async function runConfiguredAutomationBrowser(page: Page,
  input: { ruleId: string; sheetId: string; projectNo: string }, capabilities: AutomationBrowserCapabilities): Promise<ConfiguredAutomationBrowserResult> {
  const { armWrite, waitApi, data, settled, checkpoint, refreshDetail } = capabilities
  check(new URL(page.url()).pathname === '/stock-prep', 'REAL_APP_ROUTE_REQUIRED')
  await page.getByTestId('automation-read-panel').waitFor()
  await checkpoint({ phase: 'before-grant' })
  check(await page.getByTestId('automation-read-load').isEnabled(), 'REAL_TARGET_CONTEXT_REQUIRED')
  const optionsResponse = waitApi('automationOptions')
  await page.getByTestId('automation-read-load').click()
  const options = await data(await optionsResponse)
  check(Array.isArray(options.items) && options.items.length === 1 && object(options.items[0]), 'ONE_RULE_OPTION_REQUIRED')
  const option = options.items[0]
  check(object(option.selector) && option.selector.ruleId === input.ruleId && object(option.budget)
    && Array.isArray(option.allowedTriggers) && option.allowedTriggers.includes('manual'), 'MANUAL_RULE_OPTION_REQUIRED')
  await settled()
  await page.getByTestId('automation-read-option').selectOption(input.ruleId)
  check(await page.getByTestId('automation-read-mode').inputValue() === 'manual', 'MANUAL_DEFAULT_REQUIRED')
  check(await page.getByTestId('automation-read-project').innerText() === input.projectNo, 'FIXED_PROJECT_REQUIRED')
  await page.getByTestId('automation-read-ttl').fill('15')
  await page.getByTestId('automation-read-executions').fill('1')
  const budget = option.budget
  for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']) {
    check(Number.isSafeInteger(budget[key]) && Number(budget[key]) > 0, 'FINITE_BUDGET_REQUIRED')
    await page.getByTestId(`automation-read-budget-${key}`).fill(String(budget[key]))
  }
  check(await page.getByTestId('automation-read-create-grant').isDisabled(), 'EXPLICIT_CONSENT_REQUIRED')
  await page.getByTestId('automation-read-grant-confirm').check()
  const started = Date.now()
  armWrite('automationGrants', prefix + '/grants', (body: unknown) => exact(body,
    ['selector', 'projects', 'triggers', 'budget', 'expiresAt', 'maxExecutions'])
    && isDeepStrictEqual(body.selector, option.selector) && isDeepStrictEqual(body.projects, [input.projectNo])
    && isDeepStrictEqual(body.triggers, ['manual']) && isDeepStrictEqual(body.budget, budget)
    && body.maxExecutions === 1 && typeof body.expiresAt === 'string'
    && Date.parse(body.expiresAt) >= started + 15 * 60000 && Date.parse(body.expiresAt) <= started + 15 * 60000 + 15000)
  const grantResponse = waitApi('automationGrants', 'POST')
  await page.getByTestId('automation-read-create-grant').click()
  const granted = await data(await grantResponse, 201)
  check(typeof granted.grantId === 'string' && uuid.test(granted.grantId), 'GRANT_ID_REQUIRED')
  const grantId = granted.grantId
  await page.getByTestId('automation-read-current-grant').filter({ has: page.getByTestId('automation-read-submit') }).waitFor()
  await settled()
  check(await page.getByTestId('automation-read-current-grant').getAttribute('data-grant-id') === grantId, 'GRANT_DOM_REQUIRED')
  await checkpoint({ phase: 'after-grant', grantId })

  armWrite('automationRequests', prefix + '/requests', (body: unknown) => exact(body, ['grantId', 'invocationId', 'projectNo'])
    && body.grantId === grantId && body.projectNo === input.projectNo && typeof body.invocationId === 'string' && uuid.test(body.invocationId))
  const submitResponse = waitApi('automationRequests', 'POST')
  await page.getByTestId('automation-read-submit').click()
  const submitted = await data(await submitResponse, 202)
  check(typeof submitted.requestId === 'string' && uuid.test(submitted.requestId)
    && submitted.status === 'queued', 'DURABLE_ADMISSION_REQUIRED')
  const requestId = submitted.requestId
  await settled()
  let detail: JsonObject | undefined
  let detailPolls = 0, verifiedBusyPolls = 0, fixtureCompletionWaits = 0, historyRecoveries = 0
  let fromHistory = false
  const detailDeadline = performance.now() + 90000
  // Reserve one of the same 60 observed GETs for the final no-reread refresh.
  for (let attempt = 0; attempt < 59 && performance.now() < detailDeadline; attempt += 1) {
    detailPolls += 1
    const observed = await refreshDetail(grantId, requestId, detailPolls, fromHistory)
    if (observed === null) {
      verifiedBusyPolls += 1
      check(fixtureCompletionWaits === 0 && !fromHistory, 'RECOVERY_BOUND_EXCEEDED')
      // Fixture synchronization only: this does not claim history can be
      // reopened while the worker still owns its source-mirror lock.
      await checkpoint({ phase: 'await-completed', grantId, requestId })
      fixtureCompletionWaits += 1
      const grantsResponse = waitApi('automationGrants')
      const requestsResponse = waitApi('automationRequests')
      await page.getByTestId('automation-read-history-only').click()
      const grants = await data(await grantsResponse)
      const requests = await data(await requestsResponse)
      check(Array.isArray(grants.items) && grants.items.length === 1 && object(grants.items[0])
        && grants.items[0].grantId === grantId, 'RECOVERY_ORIGINAL_GRANT_REQUIRED')
      check(Array.isArray(requests.items) && requests.items.length === 1 && object(requests.items[0])
        && requests.items[0].requestId === requestId, 'RECOVERY_ORIGINAL_REQUEST_REQUIRED')
      await settled()
      const grantResponse = waitApi('automationGrantDetail', 'GET', `${prefix}/grants/${grantId}`)
      await page.getByTestId('automation-read-open-grant').and(page.locator(`[data-grant-id="${grantId}"]`)).click()
      const originalGrant = await data(await grantResponse)
      check(originalGrant.grantId === grantId, 'RECOVERY_GRANT_DETAIL_REQUIRED')
      await settled()
      check(await page.getByTestId('automation-read-current-grant').getAttribute('data-grant-id') === grantId,
        'RECOVERY_GRANT_DOM_REQUIRED')
      fromHistory = true
      continue
    }
    if (fromHistory) { historyRecoveries += 1; fromHistory = false }
    detail = observed
    if (detail.status === 'succeeded') break
    check(detail.status === 'queued' || detail.status === 'running', 'READ_FAILED_OR_UNKNOWN')
    await page.waitForTimeout(500)
  }
  check(detail?.status === 'succeeded' && isDeepStrictEqual(detail.result, { status: 'ready', canApply: false,
    counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }), 'READONLY_COUNTS_REQUIRED')
  await page.getByTestId('automation-read-result').waitFor()
  check((await page.getByTestId('automation-read-status').innerText()).includes('succeeded'), 'SUCCESS_DOM_REQUIRED')
  check((await page.getByTestId('automation-read-result').innerText()).includes('3 / 0 / 0 / 0 / 0'), 'COUNTS_DOM_REQUIRED')
  await checkpoint({ phase: 'completed', grantId, requestId })
  detailPolls += 1
  check(performance.now() < detailDeadline, 'DETAIL_DEADLINE_EXCEEDED')
  check(isDeepStrictEqual(await refreshDetail(grantId, requestId, detailPolls), detail), 'REFRESH_CHANGED_RESULT')
  const grantsResponse = waitApi('automationGrants')
  const requestsResponse = waitApi('automationRequests')
  await page.getByTestId('automation-read-refresh-history').click()
  await data(await grantsResponse)
  await data(await requestsResponse)
  await settled()
  await checkpoint({ phase: 'refreshed', grantId, requestId })
  armWrite('automationRevoke', `${prefix}/grants/${grantId}/revoke`, undefined)
  const revokedResponse = waitApi('automationRevoke', 'POST')
  await page.getByTestId('automation-read-revoke').click()
  check(isDeepStrictEqual(await data(await revokedResponse), { grantId, status: 'revoked' }), 'REVOKED_RECEIPT_REQUIRED')
  await settled()
  check(await page.getByTestId('automation-read-submit').isDisabled()
    && await page.getByTestId('automation-read-revoke').isDisabled(), 'REVOKED_DOM_REQUIRED')
  await checkpoint({ phase: 'revoked', grantId, requestId })
  check(await page.getByTestId('automation-read-error').count() === 0, 'NO_ERROR_REQUIRED')
  return { ruleId: input.ruleId, grantId, requestId, evidence: { realFullAppOwnerPanel: true,
    explicitManualConsent: true, grantCreatedThroughDom: true, submitThroughDom: true,
    durableQueuedObserved: true, succeededCountsRendered: true, canApplyFalse: true,
    refreshThroughDom: true, revokeThroughDom: true, manualOnly: true, ruleEditorDomVerified: false,
    responseStubs: 0, storageInjections: 0, detailPolls, verifiedBusyPolls, fixtureCompletionWaits, historyRecoveries,
    recoveryAfterFixtureCompletionOnly: true,
    detailRefreshBounded: true, temporaryRefusalsRequestCorrelated: true } }
}
