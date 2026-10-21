import { isDeepStrictEqual } from 'node:util'
import type { Page } from '@playwright/test'

export interface ConfiguredYidaBrowserResult {
  evidence: Record<string, boolean | number>
  counts: Record<string, number>
}

export interface YidaLocalWindowCounts {
  apiRequests: number
  backgroundHubOverviewGets: number
  nonBackgroundApiRequests: number
  businessPostRequests: number
  externalRequests: number
}

interface YidaBrowserCapabilities {
  settled(): Promise<void>
  localWindowCounts(): YidaLocalWindowCounts
}

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`APP_BROWSER_YIDA_${code}`)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Drives only the already-open real project board; it has no API write or token capability. */
export async function runConfiguredYidaBrowser(page: Page, projectNo: string,
  capabilities: YidaBrowserCapabilities): Promise<ConfiguredYidaBrowserResult> {
  check(projectNo === 'SYN-YIDA-PREVIEW' && new URL(page.url()).pathname === '/stock-prep',
    'SYNTHETIC_BOARD_REQUIRED')
  await page.getByTestId('stock-prep-project-board-title').filter({ hasText: projectNo }).waitFor()
  const preparationEntry = page.getByTestId('stock-prep-project-board-yida')
  const toggle = page.getByTestId('stock-prep-project-board-yida-preview-toggle')
  check(await preparationEntry.isEnabled() && (await preparationEntry.innerText()).includes('默认关闭'),
    'PREPARATION_ENTRY_MUST_STATE_DEFAULT_OFF')
  const storage = async () => page.evaluate(() => ({
    local: Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]),
    session: Object.keys(sessionStorage).sort().map(key => [key, sessionStorage.getItem(key)]),
  }))
  const storageBefore = await storage()
  await preparationEntry.click()
  const panel = page.getByTestId('stock-prep-yida-preview-panel')
  await panel.waitFor()
  check(await page.getByTestId('stock-prep-yida-owner-send-panel').count() === 0,
    'PREPARATION_ENTRY_MUST_NOT_MOUNT_OWNER_SEND')
  let localRuns = 0
  let acceptedPreviews = 0
  let rejectedPreviews = 0
  const quiet = async () => {
    await capabilities.settled()
    const counts = capabilities.localWindowCounts()
    check(counts.nonBackgroundApiRequests === 0 && counts.businessPostRequests === 0 && counts.externalRequests === 0
      && counts.apiRequests === counts.backgroundHubOverviewGets, 'LOCAL_PREVIEW_REQUESTED_API')
    check(await preparationEntry.isEnabled() && await page.getByTestId('stock-prep-yida-owner-send-panel').count() === 0,
      'LOCAL_PREVIEW_MUST_NOT_MOUNT_OWNER_SEND')
  }
  const run = async () => {
    await panel.getByTestId('sp-yida-run').click()
    localRuns += 1
    await quiet()
  }
  const summary = async (rows: number, created: number, updated: number, invalid = 0, duplicate = 0) => {
    await panel.getByTestId('sp-yida-summary').waitFor()
    check(await panel.getByTestId('sp-yida-summary').innerText()
      === `共 ${rows} 行；计划创建 ${created}；计划更新 ${updated}；无效 ${invalid}；本地重复键 ${duplicate}。`,
    'EXACT_LOCAL_COUNTS_REQUIRED')
    check((await panel.getByTestId('sp-yida-no-apply').innerText()).includes('canApply=false'),
      'LOCAL_PLAN_MUST_NOT_APPLY')
  }
  const payload = async (index: number): Promise<Record<string, unknown>> => {
    const value: unknown = JSON.parse(await panel.getByTestId(`sp-yida-payload-${index}`).innerText())
    check(object(value), 'LOCAL_PAYLOAD_REQUIRED')
    return value
  }
  const rows = async (): Promise<Array<Record<string, unknown>>> => {
    const value: unknown = JSON.parse(await panel.getByTestId('sp-yida-rows').inputValue())
    check(Array.isArray(value) && value.every(object), 'SYNTHETIC_ROWS_REQUIRED')
    return value as Array<Record<string, unknown>>
  }
  const resultsCleared = async () => {
    check(await panel.getByTestId('sp-yida-result').count() === 0
      && await panel.getByTestId('sp-yida-allocation-result').count() === 0
      && await panel.getByTestId('sp-yida-error').count() === 0, 'EDIT_MUST_CLEAR_RESULTS')
  }

  await panel.getByTestId('sp-yida-example-primary').click()
  await run()
  await summary(2, 2, 0)
  check(isDeepStrictEqual(await payload(0), { project: 'DEMO-P1', line: 'LINE-1', component: 'DEMO-PART-A', qty: 2, enabled: true })
    && isDeepStrictEqual(await payload(1), { project: 'DEMO-P1', line: 'LINE-2', component: 'DEMO-PART-A', qty: 0, enabled: false })
    && await panel.getByTestId('sp-yida-protocol-0').count() === 0, 'V1_CREATE_PAYLOAD_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-example-renamed').click()
  await resultsCleared()
  check(await panel.getByTestId('sp-yida-map-source-0').inputValue() === '项目号', 'RENAMED_MAPPING_REQUIRED')
  await run()
  await summary(2, 2, 0)
  check((await payload(0)).qty === 2 && (await payload(1)).enabled === false, 'RENAMED_V1_PAYLOAD_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-preview-mode').selectOption('protocol')
  await panel.getByTestId('sp-yida-protocol-example-primary').click()
  const protocolRows = await rows()
  await run()
  await summary(2, 2, 0)
  const createDto: unknown = JSON.parse(await panel.getByTestId('sp-yida-protocol-data-0').innerText())
  check(object(createDto) && isDeepStrictEqual(Object.keys(createDto).sort(), ['appType', 'formDataJson', 'formUuid'])
    && createDto.appType === 'synthetic_stock_app' && createDto.formUuid === 'synthetic_stock_form'
    && typeof createDto.formDataJson === 'string'
    && isDeepStrictEqual(JSON.parse(createDto.formDataJson), await payload(0))
    && (await payload(0)).qty === 0 && !Object.hasOwn(await payload(0), 'parentCode'), 'V2_CREATE_DATA_ONLY_REQUIRED')
  check((await panel.getByTestId('sp-yida-protocol-0').innerText()).includes('dingtalk-yida-1.0-data-only'),
    'V2_PROTOCOL_CONTRACT_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-intent').selectOption('update')
  await panel.getByTestId('sp-yida-instance-id-field').fill('syntheticInstanceId')
  await run()
  await summary(2, 0, 0, 2)
  check((await panel.getByTestId('sp-yida-result-row-0').innerText()).includes('INSTANCE_ID_MISSING')
    && await panel.getByTestId('sp-yida-protocol-data-0').count() === 0, 'UPDATE_WITHOUT_EXPLICIT_INSTANCE_REJECTED')
  rejectedPreviews += 1
  await panel.getByTestId('sp-yida-rows').fill(JSON.stringify(protocolRows.map((row, index) => ({
    ...row, syntheticInstanceId: `SYN-INSTANCE-${index + 1}`,
  }))))
  await run()
  await summary(2, 0, 2)
  const updateDto: unknown = JSON.parse(await panel.getByTestId('sp-yida-protocol-data-0').innerText())
  check(object(updateDto) && isDeepStrictEqual(Object.keys(updateDto).sort(), ['appType', 'formInstanceId', 'updateFormDataJson'])
    && updateDto.formInstanceId === 'SYN-INSTANCE-1' && typeof updateDto.updateFormDataJson === 'string'
    && isDeepStrictEqual(JSON.parse(updateDto.updateFormDataJson), await payload(0)), 'V2_EXPLICIT_UPDATE_DATA_ONLY_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-protocol-example-renamed').click()
  await run()
  await summary(2, 2, 0)
  check(await panel.getByTestId('sp-yida-map-source-0').inputValue() === '项目号'
    && (await payload(1)).qty === 3 && (await payload(1)).parentCode === 'PARENT-1', 'RENAMED_V2_PAYLOAD_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-protocol-example-primary').click()
  // Both defects are outside this example's business key. Keep the original
  // duplicate-key guard exercised, and prove same-code errors identify the
  // actual configured source/target fields without echoing rejected values.
  const invalidFields = { ...protocolRows[0], quantity: 'synthetic-private-invalid-quantity', priority: 123 }
  await panel.getByTestId('sp-yida-rows').fill(JSON.stringify([invalidFields, invalidFields]))
  await run()
  await summary(2, 0, 0, 2, 2)
  check((await panel.getByTestId('sp-yida-result-row-0').innerText()).includes('DUPLICATE_LOCAL_KEY')
    && await panel.getByTestId('sp-yida-payload-0').count() === 0
    && await panel.getByTestId('sp-yida-protocol-data-0').count() === 0, 'DUPLICATE_ROWS_MUST_NOT_GENERATE_DTO')
  for (const index of [0, 1]) {
    const quantityIssue = await panel.getByTestId(`sp-yida-row-issue-${index}-0`).innerText()
    const priorityIssue = await panel.getByTestId(`sp-yida-row-issue-${index}-1`).innerText()
    check(quantityIssue === 'FIELD_TYPE（字段类型不符）；quantity → qty（期望数字）'
      && priorityIssue === 'FIELD_TYPE（字段类型不符）；priority → priority（期望文本）',
    'LOCAL_FIELD_ISSUES_MUST_IDENTIFY_EXACT_MAPPING')
    check(!(await panel.getByTestId(`sp-yida-result-row-${index}`).innerText()).includes('synthetic-private-invalid-quantity')
      && await panel.getByTestId(`sp-yida-payload-${index}`).count() === 0,
    'REJECTED_FIELD_VALUES_MUST_NOT_RENDER')
  }
  rejectedPreviews += 1
  // Keep the deliberately unrepresentable number as JSON text: converting it
  // through a JS number first would erase the precision error this UI must reject.
  await panel.getByTestId('sp-yida-rows').fill(JSON.stringify([protocolRows[0]]).replace('"quantity":0', '"quantity":9007199254740993'))
  await run()
  check(await panel.getByTestId('sp-yida-error').innerText() === 'YIDA_STATIC_ROWS_INVALID'
    && await panel.getByTestId('sp-yida-result').count() === 0, 'INVALID_NUMBER_MUST_NOT_GENERATE_PLAN')
  rejectedPreviews += 1

  await panel.getByTestId('sp-yida-example-primary').click()
  await panel.getByTestId('sp-yida-allocation-mode').selectOption('equal_integer')
  await panel.getByTestId('sp-yida-allocation-projects').fill('SYN-PROJECT-01\nSYN-PROJECT-02')
  await panel.getByTestId('sp-yida-allocation-project-field').selectOption('projectNo')
  await panel.getByTestId('sp-yida-allocation-quantity-field').selectOption('quantity')
  await run()
  await summary(4, 4, 0)
  check((await panel.getByTestId('sp-yida-allocation-analysis-0').innerText()).includes('原总量 2；项目数 2；每项目 1；分配合计 2；差额 0')
    && (await payload(0)).project === 'SYN-PROJECT-01' && (await payload(0)).qty === 1
    && (await payload(1)).project === 'SYN-PROJECT-02' && (await payload(1)).qty === 1
    && (await payload(2)).qty === 0 && (await payload(3)).qty === 0, 'EXACT_INTEGER_ALLOCATION_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-preview-mode').selectOption('protocol')
  await panel.getByTestId('sp-yida-protocol-example-primary').click()
  await panel.getByTestId('sp-yida-allocation-mode').selectOption('equal_decimal_exact')
  await panel.getByTestId('sp-yida-allocation-projects').fill('SYN-PROJECT-01\nSYN-PROJECT-02')
  await panel.getByTestId('sp-yida-allocation-project-field').selectOption('projectNo')
  await panel.getByTestId('sp-yida-allocation-quantity-field').selectOption('quantity')
  await run()
  await summary(4, 4, 0)
  check((await panel.getByTestId('sp-yida-allocation-analysis-1').innerText()).includes('原总量 3；项目数 2；每项目 1.5；分配合计 3；差额 0')
    && (await payload(2)).project === 'SYN-PROJECT-01' && (await payload(2)).qty === 1.5
    && (await payload(3)).project === 'SYN-PROJECT-02' && (await payload(3)).qty === 1.5, 'EXACT_DECIMAL_ALLOCATION_REQUIRED')
  acceptedPreviews += 1

  await panel.getByTestId('sp-yida-rule-export').click()
  await resultsCleared()
  const exportedText = await panel.getByTestId('sp-yida-rule-export-text').inputValue()
  const exported: unknown = JSON.parse(exportedText)
  check(object(exported) && isDeepStrictEqual(Object.keys(exported).sort(), ['allocation', 'formatVersion', 'kind', 'rules', 'status'])
    && exported.formatVersion === 1 && exported.status === 'local-unverified'
    && object(exported.rules) && exported.rules.version === 2 && !Object.hasOwn(exported.rules, 'target')
    && object(exported.allocation) && isDeepStrictEqual(exported.allocation,
      { mode: 'equal_decimal_exact', projectField: 'projectNo', quantityField: 'quantity' })
    && !['synthetic_stock_app', 'synthetic_stock_form', 'SYN-PROJECT-01', 'DEMO-P1', 'DEMO-PART-A'].some(value => exportedText.includes(value)),
  'RULE_EXPORT_MUST_EXCLUDE_TARGET_AND_DATA')
  await panel.getByTestId('sp-yida-rule-import-text').fill(exportedText)
  await panel.getByTestId('sp-yida-rule-import').click()
  await panel.getByTestId('sp-yida-rule-import-notice').waitFor()
  check(await panel.getByTestId('sp-yida-app-type').inputValue() === ''
    && await panel.getByTestId('sp-yida-form-uuid').inputValue() === ''
    && await panel.getByTestId('sp-yida-rows').inputValue() === ''
    && await panel.getByTestId('sp-yida-allocation-projects').inputValue() === ''
    && await panel.getByTestId('sp-yida-preview-mode').inputValue() === 'protocol'
    && await panel.getByTestId('sp-yida-map-source-0').inputValue() === 'projectNo'
    && await panel.getByTestId('sp-yida-catalog-id-0').inputValue() === 'project', 'RULE_IMPORT_MUST_CLEAR_TARGET_AND_ROWS')
  await resultsCleared()
  await panel.getByTestId('sp-yida-app-type').fill('synthetic_stock_app')
  await panel.getByTestId('sp-yida-form-uuid').fill('synthetic_stock_form')
  await panel.getByTestId('sp-yida-rows').fill(JSON.stringify(protocolRows))
  await panel.getByTestId('sp-yida-allocation-projects').fill('SYN-PROJECT-01\nSYN-PROJECT-02')
  await run()
  await summary(4, 4, 0)
  check((await payload(2)).qty === 1.5, 'IMPORTED_RULES_MUST_PREVIEW_AGAIN')
  acceptedPreviews += 1
  await panel.getByTestId('sp-yida-map-target-0').fill('synthetic_changed_project_field')
  await resultsCleared()
  await quiet()

  await toggle.click()
  await panel.waitFor({ state: 'detached' })
  await toggle.click()
  await panel.waitFor()
  check(await panel.getByTestId('sp-yida-app-type').inputValue() === ''
    && await panel.getByTestId('sp-yida-form-uuid').inputValue() === ''
    && await panel.getByTestId('sp-yida-rows').inputValue() === ''
    && await panel.getByTestId('sp-yida-preview-mode').inputValue() === 'mapping'
    && await panel.getByTestId('sp-yida-map-source-0').inputValue() === ''
    && await panel.getByTestId('sp-yida-rule-import-text').inputValue() === ''
    && await panel.getByTestId('sp-yida-rule-export-text').inputValue() === '', 'CLOSE_REOPEN_MUST_CLEAR_CONTENT')
  await resultsCleared()
  await quiet()
  check(isDeepStrictEqual(storageBefore, await storage()), 'LOCAL_PREVIEW_STORAGE_CHANGED')
  check(localRuns === 11 && acceptedPreviews === 8 && rejectedPreviews === 3, 'EXACT_LOCAL_CASE_COUNTS_REQUIRED')
  const network = capabilities.localWindowCounts()
  return { evidence: { realProjectBoardNavigation: true, v1CreatePreview: true, v2CreatePreview: true,
    explicitInstanceUpdatePreview: true, renamedLayoutPreview: true, exactProjectAllocation: true,
    duplicateRowsRejected: true, invalidNumberRejected: true, ruleExportImportClearsInputs: true,
    editsClearResults: true, closeReopenClearsInputs: true, preparationEntryOpensOnlyLocalPreview: true,
    noBusinessRequests: true, storageSnapshotUnchanged: true, responseStubs: 0, storageInjections: 0 },
    counts: { previewRuns: localRuns, acceptedPreviews, rejectedPreviews,
      localApiRequests: network.nonBackgroundApiRequests, backgroundOverviewRequests: network.backgroundHubOverviewGets,
      externalRequests: network.externalRequests } }
}
