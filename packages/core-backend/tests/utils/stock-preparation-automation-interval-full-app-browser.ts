import { isDeepStrictEqual } from 'node:util'
import type { Page, Response } from '@playwright/test'
import type { AutomationApiKey, AutomationBrowserCapabilities, ConfiguredAutomationBrowserResult } from './stock-preparation-automation-full-app-browser'

const prefix = '/api/integration/automation-read'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
type ObjectValue = Record<string, unknown>
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`APP_BROWSER_INTERVAL_${code}`) }
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: unknown, keys: string[]): value is ObjectValue {
  return object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}
type EditorStep = 'MANAGER_OPEN' | 'ADVANCED_OPEN' | 'VISIBLE' | 'NAME_INPUT' | 'TRIGGER_OPEN'
  | 'TRIGGER_INTERVAL' | 'INTERVAL_INPUT' | 'ACTION_OPEN' | 'ACTION_READ_PREVIEW' | 'SAVE_CLICK'
  | 'CLOSED_AFTER_SAVE' | 'SAVED_RULE_VISIBLE' | 'RETURN_ROUTE' | 'RETURN_INSTALL'
  | 'RETURN_BOARD_OPEN' | 'RETURN_BOARD_READ' | 'RETURN_BOARD_VISIBLE'
  | 'RETURN_HOME_OPEN' | 'RETURN_HOME_VISIBLE'
async function editorStep<T>(step: EditorStep, action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) {
    if (error instanceof Error && /^APP_BROWSER_[A-Z_]+$/.test(error.message)) throw error
    // Only fixed step names escape; Playwright errors may contain URLs or DOM values.
    throw new Error(`APP_BROWSER_INTERVAL_EDITOR_${step}_FAILED`)
  }
}
type IntervalAuthoringCapabilities = Omit<AutomationBrowserCapabilities, 'waitApi'> & {
  waitApi(key: AutomationApiKey | 'yidaBoard' | 'handoff', method?: string, pathname?: string): Promise<Response>
  /** Private observation of an actual same-session HTTP response; never a UI input. */
  observedHomeDirectory(): { responseCount: number; data: ObjectValue } | undefined
}

/** Navigate through the existing board button and author using the production editor. */
export async function authorConfiguredIntervalRule(page: Page,
  input: { sheetId: string; viewId: string; projectNo: 'SYN-YIDA-PREVIEW'; tenantId: string },
  capabilities: IntervalAuthoringCapabilities): Promise<string> {
  const { checkpoint, waitApi, data, settled, armWrite } = capabilities
  check(new URL(page.url()).pathname === '/stock-prep', 'BOARD_ROUTE_REQUIRED')
  const boardUrl = page.url()
  check(new URL(boardUrl).searchParams.get('projectNo') === input.projectNo, 'RETURN_PROJECT_CONTEXT_REQUIRED')
  await checkpoint({ phase: 'interval-before-authoring' })
  const contextResponse = waitApi('editorContext'), viewResponse = waitApi('editorView')
  await page.getByTestId('stock-prep-project-board-open-multitable').click()
  await page.waitForURL(url => url.pathname === `/multitable/${encodeURIComponent(input.sheetId)}/${encodeURIComponent(input.viewId)}` && !url.search)
  const context = await data(await contextResponse), view = await data(await viewResponse)
  check(object(context.capabilities) && context.capabilities.canManageAutomation === true, 'REAL_CAPABILITY_REQUIRED')
  check(Array.isArray(view.rows) && view.rows.length === 0 && object(view.view) && view.view.id === input.viewId,
    'EMPTY_REAL_FILL_VIEW_REQUIRED')
  await settled()
  const rulesResponse = waitApi('editorRules')
  await editorStep('MANAGER_OPEN', () => page.getByRole('button', { name: /^(自动化|Automations)$/ }).click())
  const rules = await data(await rulesResponse)
  check(Array.isArray(rules.rules) && rules.rules.length === 0, 'EMPTY_RULE_MANAGER_REQUIRED')
  await settled()
  await editorStep('ADVANCED_OPEN', () => page.locator('[data-automation-new-rule="advanced"]').click())
  const editor = page.locator('.meta-rule-editor')
  await editorStep('VISIBLE', () => editor.waitFor())
  await settled()
  // ElInput disables inheritAttrs and applies data-field to the native input.
  await editorStep('NAME_INPUT', () => editor.locator('input[data-field="name"]').fill('Synthetic full-app interval read'))
  await editorStep('TRIGGER_OPEN', () => editor.locator('[data-field="triggerType"]').click())
  await editorStep('TRIGGER_INTERVAL', () => page.locator('[data-value="schedule.interval"]:visible').click())
  await editorStep('INTERVAL_INPUT', () => editor.locator('input[data-field="intervalSeconds"]').fill('30'))
  check(await editor.locator('[data-action-index]').count() === 1, 'SINGLE_ACTION_REQUIRED')
  await editorStep('ACTION_OPEN', () => editor.locator('[data-action-index="0"] .meta-rule-editor__action-header .el-select').click())
  await editorStep('ACTION_READ_PREVIEW', () => page.locator('[data-value="integration_read_preview"]:visible').click())
  const action = { type: 'integration_read_preview', config: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false } }
  const payload = { name: 'Synthetic full-app interval read', triggerType: 'schedule.interval', triggerConfig: { intervalMs: 30000 },
    trigger: { type: 'schedule.interval', config: { intervalMs: 30000 } }, actions: [action], actionType: action.type,
    actionConfig: action.config, executionMode: null }
  armWrite('editorRules', `/api/multitable/sheets/${encodeURIComponent(input.sheetId)}/automations`, payload)
  const savedResponse = waitApi('editorRules', 'POST')
  await editorStep('SAVE_CLICK', () => editor.locator('[data-action="save"]').click())
  const saved = await data(await savedResponse)
  check(object(saved.rule) && typeof saved.rule.id === 'string' && saved.rule.id.length > 0, 'RULE_SAVE_RECEIPT_REQUIRED')
  const ruleId = saved.rule.id
  await editorStep('CLOSED_AFTER_SAVE', () => editor.waitFor({ state: 'detached' }))
  await editorStep('SAVED_RULE_VISIBLE', () => page.locator(`[data-automation-rule="${ruleId}"]`).waitFor())
  await settled()
  await checkpoint({ phase: 'interval-authored', ruleId })
  // Browser history returns through the actual router; no injected auth/role/query.
  await editorStep('RETURN_ROUTE', async () => {
    await page.goBack()
    await page.waitForURL(url => url.href === boardUrl)
  })
  // Shell tab clicks intentionally do not rewrite the original ?tab=install.
  // A fresh route mount returns to that real install panel, then the user opens
  // the existing board tab again; do not wait for an unmounted former panel.
  await editorStep('RETURN_INSTALL', () => page.locator('[data-testid="stock-prep-panel"][data-active="install"]').waitFor())
  // The remounted board captures its URL project before awaiting its directory.
  // Wait for that real board/handoff load before the caller changes project scope;
  // an already-idle SPA document alone does not establish this read barrier.
  const returningBoardResponse = waitApi('yidaBoard', 'GET',
    `/api/integration/stock-preparation/projects/${input.projectNo}/board`)
  const returningHandoffResponse = waitApi('handoff')
  await editorStep('RETURN_BOARD_OPEN', () => page.getByTestId('stock-prep-tab-project-board').click())
  await editorStep('RETURN_BOARD_READ', async () => {
    const returningBoard = await data(await returningBoardResponse)
    const returningHandoff = await data(await returningHandoffResponse)
    check(returningBoard.projectNo === input.projectNo && returningBoard.tenantId === input.tenantId
      && returningBoard.pullTargetReady === true && returningBoard.pulledRowCount === 1
      && returningBoard.activePulledRowCount === 0 && returningBoard.archivedSnapshotPresent === false
      && object(returningBoard.fillTarget) && returningBoard.fillTarget.sheetId === input.sheetId
      && returningBoard.fillTarget.viewId === input.viewId, 'RETURN_SAME_SYNTHETIC_BOARD_REQUIRED')
    check(returningHandoff.configured === false, 'RETURN_UNCONFIGURED_HANDOFF_REQUIRED')
  })
  await editorStep('RETURN_BOARD_VISIBLE', () => page.getByTestId('stock-prep-project-board-title').filter({ hasText: input.projectNo }).waitFor())
  check(await page.getByTestId('stock-prep-project-board-error').count() === 0, 'RETURN_BOARD_ERROR_ABSENT_REQUIRED')
  await settled()
  // A project-seeded mount reads the ordinary directory, which omits fillTarget.
  // The real home transition opts into includePullTargets before the later 404
  // needs that directory fallback. Production may reuse its real 5s Promise cache.
  // Retain observed HTTP evidence without resetting that cache or claiming to
  // inspect it; the home link and later exact options GET prove the actual UI path.
  check(await page.getByTestId('stock-prep-project-board-back-home').isEnabled(), 'RETURN_HOME_CONTROL_DISABLED')
  const beforeHome = capabilities.observedHomeDirectory()
  check(beforeHome && beforeHome.responseCount > 0, 'RETURN_HOME_HTTP_EVIDENCE_REQUIRED')
  await editorStep('RETURN_HOME_OPEN', () => page.getByTestId('stock-prep-project-board-back-home').click())
  await editorStep('RETURN_HOME_VISIBLE', async () => {
    await page.getByTestId('stock-prep-operator-home').waitFor()
    await page.getByTestId('stock-prep-operator-home-open-multitable').waitFor()
    await page.waitForURL(url => url.pathname === '/stock-prep' && !url.searchParams.has('projectNo'))
  })
  await settled()
  const afterHome = capabilities.observedHomeDirectory()
  check(afterHome && afterHome.responseCount >= beforeHome.responseCount, 'RETURN_HOME_HTTP_EVIDENCE_LOST')
  const directory = afterHome.data
  check(directory.tenantId === input.tenantId && directory.pullTargetReady === true
    && directory.directoryMayBeIncomplete === false && directory.pullTargetScanCapped === false
    && object(directory.fillTarget) && directory.fillTarget.sheetId === input.sheetId
    && directory.fillTarget.viewId === input.viewId, 'RETURN_HOME_REAL_TARGET_REQUIRED')
  console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-interval-home-directory',
    observedResponses: afterHome.responseCount,
    newResponseObserved: afterHome.responseCount > beforeHome.responseCount,
    priorResponseEvidenceRetained: afterHome.responseCount === beforeHome.responseCount,
    realHomeTargetVisible: true, observedTargetMatched: true, cacheInspected: false,
  }))
  return ruleId
}

export async function runConfiguredIntervalBrowser(page: Page,
  input: { ruleId: string; sheetId: string; projectNo: string }, capabilities: AutomationBrowserCapabilities): Promise<ConfiguredAutomationBrowserResult> {
  const { checkpoint, waitApi, data, settled, armWrite, refreshDetail } = capabilities
  check(new URL(page.url()).pathname === '/stock-prep', 'OWNER_ROUTE_REQUIRED')
  const panel = page.getByTestId('automation-read-panel')
  const load = page.getByTestId('automation-read-load')
  const history = page.getByTestId('automation-read-history-only')
  const controls = {
    panelPresent: await panel.count() === 1,
    loadPresent: await load.count() === 1,
    historyPresent: await history.count() === 1,
    loadEnabled: await load.count() === 1 && await load.isEnabled(),
    historyEnabled: await history.count() === 1 && await history.isEnabled(),
    signedOutMessage: await panel.getByText('请先登录。', { exact: true }).isVisible(),
    missingContextMessage: await panel.getByText('打开项目并选择有效的备料目标表后，才能查看可授权规则。', { exact: true }).isVisible(),
    unresolvedRecovery: await page.getByTestId('automation-read-recovery').count() > 0
      || await page.getByTestId('automation-read-activation-recovery').count() > 0
      || await page.getByTestId('automation-read-retry-recovery').count() > 0,
    errorPresent: await page.getByTestId('automation-read-error').count() > 0,
  }
  console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-interval-owner-controls', ...controls }))
  check(controls.panelPresent && controls.loadPresent && controls.historyPresent, 'OWNER_CONTROLS_MISSING')
  check(!controls.signedOutMessage, 'OWNER_SIGNED_OUT')
  check(!controls.missingContextMessage, 'OWNER_TARGET_CONTEXT_UNAVAILABLE')
  check(!controls.unresolvedRecovery && !controls.errorPresent, 'OWNER_UNRESOLVED_OR_ERROR')
  check(controls.historyEnabled, 'OWNER_HISTORY_DISABLED')
  check(controls.loadEnabled, 'OWNER_LOAD_DISABLED')
  const optionsResponse = waitApi('automationOptions')
  await load.click()
  const options = await data(await optionsResponse)
  check(Array.isArray(options.items) && options.items.length === 1 && object(options.items[0]), 'ONE_OPTION_REQUIRED')
  const option = options.items[0]
  check(object(option.selector) && option.selector.ruleId === input.ruleId && object(option.budget)
    && isDeepStrictEqual(option.allowedTriggers, ['schedule']) && option.scheduleActivationEligible === true
    && typeof option.scheduleRuleRevision === 'string' && uuid.test(option.scheduleRuleRevision)
    && object(option.scheduleDefinition) && option.scheduleDefinition.triggerType === 'schedule.interval'
    && option.scheduleDefinition.intervalMs === 30000 && Number.isSafeInteger(option.scheduleDefinition.anchorMs), 'EXACT_SCHEDULE_OPTION_REQUIRED')
  await settled()
  check(await page.getByTestId('automation-read-mode').inputValue() === 'manual', 'MANUAL_DEFAULT_REQUIRED')
  await page.getByTestId('automation-read-mode').selectOption('schedule')
  await page.getByTestId('automation-read-option').selectOption(input.ruleId)
  check(await page.getByTestId('automation-read-project').innerText() === input.projectNo, 'FIXED_PROJECT_REQUIRED')
  check(await page.getByTestId('automation-read-schedule-definition').getAttribute('data-schedule-trigger-type') === 'schedule.interval'
    && (await page.getByTestId('automation-read-schedule-definition').innerText()).includes('30000')
    && (await page.getByTestId('automation-read-schedule-revision').innerText()).includes(option.scheduleRuleRevision), 'CONSENT_CONFIG_RENDERED_REQUIRED')
  await page.getByTestId('automation-read-ttl').fill('15')
  await page.getByTestId('automation-read-executions').fill('1')
  for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']) {
    check(Number.isSafeInteger(option.budget[key]) && Number(option.budget[key]) > 0, 'FINITE_BUDGET_REQUIRED')
    await page.getByTestId(`automation-read-budget-${key}`).fill(String(option.budget[key]))
  }
  check(Number(option.budget.timeoutMs) <= 25000, 'PRODUCTION_TIME_BUDGET_REQUIRED')
  // Wait for a NEW natural unauthorised tick after the controls are ready.
  // This leaves one actual 30s phase for the explicit consent, without resetting
  // the scheduler phase or making activation race the lengthy navigation.
  await checkpoint({ phase: 'interval-preactivation-tick', ruleId: input.ruleId })
  check(await page.getByTestId('automation-read-activate-schedule').isDisabled(), 'EXPLICIT_CONSENT_REQUIRED')
  await page.getByTestId('automation-read-schedule-confirm').check()
  const started = Date.now()
  armWrite('automationScheduleActivation', prefix + '/schedule-activations', (value: unknown) => exact(value,
    ['activationKey', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions', 'expectedRuleRevision'])
    && typeof value.activationKey === 'string' && uuid.test(value.activationKey)
    && isDeepStrictEqual(value.selector, option.selector) && value.projectNo === input.projectNo
    && isDeepStrictEqual(value.budget, option.budget) && value.maxExecutions === 1
    && value.expectedRuleRevision === option.scheduleRuleRevision && typeof value.expiresAt === 'string'
    && Date.parse(value.expiresAt) >= started + 15 * 60000 && Date.parse(value.expiresAt) <= started + 15 * 60000 + 15000)
  const activationResponse = waitApi('automationScheduleActivation', 'POST')
  await page.getByTestId('automation-read-activate-schedule').click()
  const activated = await data(await activationResponse, 201)
  check(typeof activated.activationId === 'string' && uuid.test(activated.activationId)
    && typeof activated.grantId === 'string' && uuid.test(activated.grantId), 'ACTIVATION_RECEIPT_REQUIRED')
  const activationId = activated.activationId, grantId = activated.grantId
  await settled()
  check(await page.getByTestId('automation-read-current-grant').getAttribute('data-grant-id') === grantId,
    'GRANT_DOM_REQUIRED')
  check(await page.getByTestId('automation-read-submit').isDisabled(), 'AUTOMATIC_GRANT_MUST_NOT_ALLOW_MANUAL')
  const handles = { ruleId: input.ruleId, activationId, grantId }
  await checkpoint({ phase: 'interval-activated', ...handles })
  const admitted = await checkpoint({ phase: 'interval-admitted', ...handles })
  check(admitted && uuid.test(admitted.requestId), 'NATURAL_REQUEST_REQUIRED')
  const requestId = admitted.requestId
  await checkpoint({ phase: 'interval-completed', ...handles, requestId })
  // This separately bounded phase proves the budget gate while the grant stays
  // active. It is not part of the later detail-GET 90s window.
  await checkpoint({ phase: 'interval-budget-tick', ...handles, requestId })
  const grantsResponse = waitApi('automationGrants'), requestsResponse = waitApi('automationRequests')
  await page.getByTestId('automation-read-history-only').click()
  const grants = await data(await grantsResponse), requests = await data(await requestsResponse)
  check(Array.isArray(grants.items) && grants.items.length === 1 && object(grants.items[0]) && grants.items[0].grantId === grantId,
    'ORIGINAL_HISTORY_GRANT_REQUIRED')
  check(Array.isArray(requests.items) && requests.items.length === 1 && object(requests.items[0])
    && requests.items[0].requestId === requestId && requests.items[0].status === 'succeeded', 'ORIGINAL_HISTORY_REQUEST_REQUIRED')
  await settled()
  const grantResponse = waitApi('automationGrantDetail', 'GET', `${prefix}/grants/${grantId}`)
  await page.getByTestId('automation-read-open-grant').and(page.locator(`[data-grant-id="${grantId}"]`)).click()
  check((await data(await grantResponse)).grantId === grantId, 'ORIGINAL_GRANT_DETAIL_REQUIRED')
  await settled()
  const detail = await refreshDetail(grantId, requestId, 1, true)
  check(detail?.status === 'succeeded' && isDeepStrictEqual(detail.result, { status: 'ready', canApply: false,
    counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }), 'READONLY_COUNTS_REQUIRED')
  check((await page.getByTestId('automation-read-result').innerText()).includes('3 / 0 / 0 / 0 / 0'), 'COUNTS_DOM_REQUIRED')
  check(isDeepStrictEqual(await refreshDetail(grantId, requestId, 2), detail), 'REFRESH_SAME_RESULT_REQUIRED')
  await checkpoint({ phase: 'interval-refreshed', ...handles, requestId })
  armWrite('automationRevoke', `${prefix}/grants/${grantId}/revoke`, undefined)
  const revokedResponse = waitApi('automationRevoke', 'POST')
  await page.getByTestId('automation-read-revoke').click()
  check(isDeepStrictEqual(await data(await revokedResponse), { grantId, status: 'revoked' }), 'REVOKED_RECEIPT_REQUIRED')
  await settled()
  check(await page.getByTestId('automation-read-revoke').isDisabled() && await page.getByTestId('automation-read-submit').isDisabled(),
    'REVOKED_DOM_REQUIRED')
  await checkpoint({ phase: 'interval-revoked', ...handles, requestId })
  check(await page.getByTestId('automation-read-error').count() === 0, 'NO_ERROR_REQUIRED')
  return { ruleId: input.ruleId, grantId, requestId, evidence: {
    realFullAppOwnerPanel: true, realBoardWorkbenchNavigation: true, ruleEditorDomVerified: true,
    realEmptyFillView: true, explicitScheduleConsent: true, activationThroughDom: true, manualSubmitAbsent: true,
    naturalRequestObserved: true, succeededCountsRendered: true, canApplyFalse: true,
    historyAfterFixtureCompletionOnly: true, refreshThroughDom: true, revokeThroughDom: true,
    boundedBudgetTickBeforeRevoke: true, responseStubs: 0, storageInjections: 0, detailPolls: 2,
    verifiedBusyPolls: 0, automaticActivations: 1, intervalMs: 30000,
  } }
}
