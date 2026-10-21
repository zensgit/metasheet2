import { isDeepStrictEqual } from 'node:util'
import type { Page, Response } from '@playwright/test'

export interface ConfiguredK3BrowserInput {
  systemId: string
  uniqueMaterialId: string
  ambiguousMaterialId: string
}

export interface ConfiguredK3BrowserResult {
  /** Private child-to-parent handles; never serialize these into evidence. */
  b4ConfigId: string
  bl2ConfigId: string
  b4Version: number
  bl2Version: number
  evidence: Record<string, boolean | number>
}

type K3ApiKey = 'readSourceConfigs' | 'k3Approve' | 'k3Read'
type JsonObject = Record<string, unknown>
interface K3BrowserCapabilities {
  armWrite(key: K3ApiKey, pathname: string, body: unknown): void
  waitApi(key: K3ApiKey, method?: string, pathname?: string): Promise<Response>
  data(response: Response, status?: number): Promise<unknown>
  settled(): Promise<void>
  /** Parent-owned same-principal check and one real Workbench document reload. */
  reloadSameSession(): Promise<void>
}

const configsPath = '/api/integration/read-source-configs'

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`APP_BROWSER_K3_${code}`)
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reuses the caller's real login, production bundle, page and single-use write firewall. */
export async function runConfiguredK3Browser(page: Page, input: ConfiguredK3BrowserInput,
  capabilities: K3BrowserCapabilities): Promise<ConfiguredK3BrowserResult> {
  check(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.systemId)
    && /^[0-9]{1,20}$/.test(input.uniqueMaterialId) && /^[0-9]{1,20}$/.test(input.ambiguousMaterialId)
    && input.uniqueMaterialId !== input.ambiguousMaterialId, 'SYNTHETIC_INPUT_REQUIRED')
  check(new URL(page.url()).pathname === '/integrations/workbench', 'REAL_WORKBENCH_REQUIRED')
  const { armWrite, waitApi, data, settled, reloadSameSession } = capabilities
  await page.getByTestId('integration-rail-read-source').click()
  await page.getByTestId('read-source-panel').waitFor()
  await settled()

  const refresh = async (): Promise<JsonObject[]> => {
    const response = waitApi('readSourceConfigs')
    await page.getByTestId('rsc-refresh').click()
    const rows = await data(await response)
    check(Array.isArray(rows) && rows.every(object), 'CONFIG_LIST_REQUIRED')
    await settled()
    check(await page.getByTestId('rsc-list-error').count() === 0, 'CONFIG_LIST_FAILED')
    return rows as JsonObject[]
  }
  check((await refresh()).length === 0, 'FRESH_CONFIG_LIST_REQUIRED')

  const saveAndApprove = async (kind: 'b4' | 'bl2'): Promise<JsonObject> => {
    await page.getByTestId(`rsc-${kind}-enter`).click()
    await page.getByTestId(`rsc-${kind}-system`).selectOption(input.systemId)
    check(await page.getByTestId(`rsc-${kind}-bounded-smoke`).isChecked() === false,
      'NO_IMPLICIT_PROBE_REQUIRED')
    const config = kind === 'b4' ? {
      version: 1, systemId: input.systemId, requiredKind: 'erp:k3-wise-webapi', object: 'material',
      mode: 'list_page', readPath: '/K3API/Material/GetList', readMethod: 'POST', operations: ['read'],
      actionProfileVersion: 'k3wise.material_list.v1', containerPaths: ['Data.DATA'],
      fieldMap: [{ source: 'FUnitID', target: 'baseUnit' }],
    } : {
      version: 1, systemId: input.systemId, requiredKind: 'erp:k3-wise-webapi', object: 'material-bom-list',
      mode: 'resolver_lookup', readPath: '/K3API/BOM/GetList', readMethod: 'POST', operations: ['read'],
      keyField: 'FPercentItemID', keyEncoding: 'numeric_id', resolverRule: 'exactly_one',
      containerPaths: ['Data.DATA'], fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }],
    }
    const savedResponse = waitApi('readSourceConfigs', 'POST', configsPath)
    const savedList = waitApi('readSourceConfigs')
    armWrite('readSourceConfigs', configsPath, { config })
    await page.getByTestId(`rsc-${kind}-save`).click()
    const saved = await data(await savedResponse, 201)
    check(object(saved) && typeof saved.id === 'string' && /^[A-Za-z0-9_-]+$/.test(saved.id)
      && saved.version === 1 && saved.status === 'draft' && saved.reused === false, 'FRESH_DRAFT_REQUIRED')
    const beforeApproval = await data(await savedList)
    check(Array.isArray(beforeApproval), 'DRAFT_LIST_REQUIRED')
    const draft = beforeApproval.find(row => object(row) && row.id === saved.id)
    check(object(draft) && draft.status === 'draft' && isDeepStrictEqual(draft.config, config),
      'EXACT_DRAFT_READBACK_REQUIRED')
    await page.getByTestId(`rsc-status-${saved.id}`).filter({ hasText: '草稿' }).waitFor()
    await settled()
    check(await page.getByTestId(`k3-${kind}-run-${saved.id}`).count() === 0,
      'UNAPPROVED_RUN_VISIBLE')
    const approvePath = `${configsPath}/${saved.id}/approve`
    const approvalResponse = waitApi('k3Approve', 'POST', approvePath)
    const approvedList = waitApi('readSourceConfigs')
    const dialog = page.waitForEvent('dialog')
    const click = page.getByTestId(`rsc-${kind}-approve`).click()
    const confirmation = await dialog
    check(confirmation.type() === 'confirm'
      && confirmation.message() === `审批后运行时即可选用该读取源(${config.object} v1)。确认审批?`,
    'EXACT_APPROVAL_CONFIRM_REQUIRED')
    armWrite('k3Approve', approvePath, {})
    await confirmation.accept()
    await click
    const approved = await data(await approvalResponse)
    check(object(approved) && approved.id === saved.id && approved.version === saved.version
      && approved.status === 'approved' && isDeepStrictEqual(approved.config, config), 'EXACT_APPROVAL_REQUIRED')
    const rows = await data(await approvedList)
    check(Array.isArray(rows) && rows.some(row => object(row) && row.id === saved.id
      && row.status === 'approved' && row.version === saved.version
      && isDeepStrictEqual(row.config, config)), 'APPROVED_READBACK_REQUIRED')
    await page.getByTestId(`rsc-status-${saved.id}`).filter({ hasText: '已审批' }).waitFor()
    await settled()
    return approved
  }

  const b4 = await saveAndApprove('b4')
  const b4ConfigId = String(b4.id)
  const b4Panel = page.getByTestId(`k3-b4-run-${b4ConfigId}`)
  await b4Panel.locator('summary').click()
  check(await b4Panel.getByTestId('k3-b4-preview').isEnabled(), 'B4_APPROVED_PREVIEW_DISABLED')
  const b4Path = `${configsPath}/${b4ConfigId}/read`
  const b4Response = waitApi('k3Read', 'POST', b4Path)
  const b4Dialog = page.waitForEvent('dialog')
  const b4Click = b4Panel.getByTestId('k3-b4-preview').click()
  const b4Confirmation = await b4Dialog
  check(b4Confirmation.type() === 'confirm' && b4Confirmation.message().includes('不写内部缓存'),
    'B4_READ_CONFIRM_REQUIRED')
  armWrite('k3Read', b4Path, { inputs: {}, rowSource: 'adapter_records' })
  await b4Confirmation.accept()
  await b4Click
  const b4Read = await data(await b4Response)
  check(object(b4Read) && object(b4Read.evidence) && b4Read.evidence.ok === true
    && b4Read.evidence.recordCount === 2 && b4Read.evidence.boundedSmokeExecuted === true
    && b4Read.evidence.capReached === false && object(b4Read.data)
    && object(b4Read.data.containers) && object(b4Read.data.containers.primary)
    && Array.isArray(b4Read.data.containers.primary.records)
    && b4Read.data.containers.primary.records.length === 2, 'B4_REAL_TWO_ROW_PAGE_REQUIRED')
  const records = b4Read.data.containers.primary.records
  check(records.every(object) && records[0].FItemID === input.uniqueMaterialId
    && records[1].FItemID === input.ambiguousMaterialId
    && records.every(row => row.baseUnit === 'PCS'), 'B4_PROJECTED_SYNTHETIC_ROWS_REQUIRED')
  await b4Panel.getByTestId('k3-b4-preview-result').filter({ hasText: '本次单页 2 行' }).waitFor()
  const renderedRows = b4Panel.getByTestId('k3-b4-preview-table').locator('tbody tr')
  check(await renderedRows.count() === 2
    && await renderedRows.nth(0).locator('td').first().innerText() === input.uniqueMaterialId
    && await renderedRows.nth(1).locator('td').first().innerText() === input.ambiguousMaterialId
    && await b4Panel.getByTestId('k3-b4-sync-result').count() === 0, 'B4_PREVIEW_ONLY_DOM_REQUIRED')
  await settled()

  const bl2 = await saveAndApprove('bl2')
  const bl2ConfigId = String(bl2.id)
  const bl2Panel = page.getByTestId(`k3-bl2-run-${bl2ConfigId}`)
  await bl2Panel.locator('summary').click()
  const bl2Path = `${configsPath}/${bl2ConfigId}/read`
  const readBom = async (key: string): Promise<JsonObject> => {
    await bl2Panel.getByTestId('k3-bl2-key').fill(key)
    check(await bl2Panel.getByTestId('k3-bl2-read').isEnabled(), 'BL2_NUMERIC_KEY_DISABLED')
    const response = waitApi('k3Read', 'POST', bl2Path)
    const dialog = page.waitForEvent('dialog')
    const click = bl2Panel.getByTestId('k3-bl2-read').click()
    const confirmation = await dialog
    check(confirmation.type() === 'confirm' && confirmation.message().includes('不会写 K3 或内部缓存'),
      'BL2_READ_CONFIRM_REQUIRED')
    armWrite('k3Read', bl2Path, { inputs: { key } })
    await confirmation.accept()
    await click
    const result = await data(await response)
    check(object(result) && object(result.evidence), 'BL2_REAL_RESPONSE_REQUIRED')
    return result
  }
  const unique = await readBom(input.uniqueMaterialId)
  check(object(unique.evidence) && unique.evidence.ok === true && unique.evidence.resolved === true
    && unique.evidence.rule === 'exactly_one' && unique.evidence.candidateCount === 1
    && unique.evidence.matchedCount === 1 && object(unique.data) && object(unique.data.resolver)
    && unique.data.resolver.target === 'bom_number' && unique.data.resolver.value === 'SYN-BOM-UNIQUE',
  'BL2_UNIQUE_RESOLUTION_REQUIRED')
  await bl2Panel.getByTestId('k3-bl2-value').filter({ hasText: 'SYN-BOM-UNIQUE' }).waitFor()
  check(await bl2Panel.getByTestId('k3-bl2-error').count() === 0, 'BL2_UNIQUE_DOM_FAILED')
  await settled()
  const ambiguous = await readBom(input.ambiguousMaterialId)
  check(object(ambiguous.evidence) && ambiguous.evidence.ok === false
    && ambiguous.evidence.errorCode === 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'
    && ambiguous.evidence.candidateCount === 2 && ambiguous.data === null, 'BL2_AMBIGUITY_REQUIRED')
  await bl2Panel.getByTestId('k3-bl2-error').filter({ hasText: '不能自动选取 BOM' }).waitFor()
  check(await bl2Panel.getByTestId('k3-bl2-value').count() === 0
    && await bl2Panel.getByTestId('k3-bl2-result').count() === 0
    && !(await bl2Panel.innerText()).includes('SYN-BOM-FIRST')
    && !(await bl2Panel.innerText()).includes('SYN-BOM-SECOND'), 'BL2_NO_CANDIDATE_SELECTED_REQUIRED')
  await settled()

  await reloadSameSession()
  await page.getByTestId('integration-rail-read-source').click()
  const persisted = await refresh()
  check(persisted.length === 2 && [b4, bl2].every(expected => persisted.some(row => row.id === expected.id
    && row.version === expected.version && row.status === 'approved'
    && row.contentKey === expected.contentKey && isDeepStrictEqual(row.config, expected.config))),
  'RELOAD_EXACT_PERSISTED_VERSIONS_REQUIRED')
  for (const row of [b4, bl2]) {
    await page.getByTestId(`rsc-status-${row.id}`).filter({ hasText: '已审批' }).waitFor()
    check((await page.getByTestId(`rsc-row-${row.id}`).innerText()).includes(`v${row.version}`),
      'RELOAD_PERSISTED_VERSION_DOM_REQUIRED')
  }
  check(await page.getByTestId('k3-b4-preview-result').count() === 0
    && await page.getByTestId('k3-b4-sync-result').count() === 0
    && await page.getByTestId('k3-bl2-result').count() === 0, 'RELOAD_MUST_CLEAR_READ_RESULTS')
  await settled()
  return { b4ConfigId, bl2ConfigId, b4Version: Number(b4.version), bl2Version: Number(bl2.version),
    evidence: { b4SavedAndApproved: true, b4PreviewOnly: true, bl2SavedAndApproved: true,
      uniqueBomRead: true, ambiguousBomRejected: true, reloadVersionsPersisted: true,
      reloadDidNotReadK3: true, realBundleJourney: true, responseStubs: 0, storageInjections: 0 } }
}
