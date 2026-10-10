import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), permissions: ['integration:admin'] as string[], locale: 'zh-CN' }))
vi.mock('../src/utils/api', () => ({ apiFetch: h.apiFetch }))
vi.mock('../src/composables/useLocale', () => ({ useLocale: () => ({ locale: ref(h.locale) }) }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getAccessSnapshot: () => ({ roles: [], isAdmin: false, permissions: h.permissions }) }),
}))

import SourceBindingPanel from '../src/components/integration/stockPreparation/StockPreparationSourceBindingPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { compileSourcePlanDraft, createSyntheticSourcePlanDraft } from '../src/services/integration/stockPreparation/sourcePlanDraft'
import {
  SOURCE_PLAN_SAMPLE_FIELDS,
  SOURCE_PLAN_VERSIONS_ROUTE,
  SourcePlanVersionsError,
  confirmSourcePlanVersionSample,
  listSourcePlanVersions,
  validateSourcePlanVersionSample,
} from '../src/services/integration/stockPreparation/sourcePlanVersions'

const SYSTEM = 'sys_synthetic_owned'
const OTHER = 'sys_other_owned'
const ACTION = 'plm.stock-preparation.pull-bom.v1'
const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const READ_PLAN = compileSourcePlanDraft(createSyntheticSourcePlanDraft()).envelope!.readPlan
const SCOPE = { tenantId: 'synthetic_tenant', workspaceId: 'synthetic_workspace' }
const EXPIRES = '2099-01-01T00:00:00.000Z'
const CONFIRMED_AT = '2098-12-01T00:00:00.000Z'
const FIELDS = [
  'componentSourceId', 'parentSourceId', 'path', 'depth', 'componentCode', 'componentName',
  'material', 'sourceVersion', 'orderBomVersion', 'rawQuantity', 'totalQuantity', 'active', 'spec', 'sortLine',
] as const
const POISON = 'PRIVATE_SCHEMA_CREDENTIAL authorityCode appKey SYN_PHYSICAL_TABLE'
const DIAGNOSTICS = [
  { status: 422, code: 'READ_PLAN_VALIDATION_CATALOG_UNVERIFIED', operation: 'validate', zh: '物理列核对未通过', en: 'Physical column verification did not pass', nextZh: '修正并保存', nextEn: 'correct and save' },
  { status: 409, code: 'READ_PLAN_VALIDATION_INCOMPLETE', operation: 'validate', zh: '这不代表零数据或读取成功', en: 'does not mean zero data or a successful read', nextZh: '读取限制', nextEn: 'read limits' },
  { status: 504, code: 'READ_PLAN_VALIDATION_TIMEOUT', operation: 'validate', zh: '超时不代表已取消', en: 'timeout does not mean cancellation', nextZh: '再决定何时手动', nextEn: 'before deciding when' },
  { status: 502, code: 'READ_PLAN_VALIDATION_SOURCE_FAILED', operation: 'validate', zh: '来源读取失败', en: 'The source read failed', nextZh: '读取权限', nextEn: 'read permissions' },
  { status: 409, code: 'READ_PLAN_VALIDATION_EXPIRED', operation: 'confirm-sample', zh: '样本回执已过期', en: 'The sample receipt expired', nextZh: '确认新样本', nextEn: 'confirm a new sample' },
  { status: 409, code: 'READ_PLAN_VALIDATION_REQUIRED', operation: 'confirm-sample', zh: '缺少当前已确认的样本回执', en: 'A current confirmed sample receipt is required', nextZh: '手动核对并确认', nextEn: 'manually check and confirm' },
  { status: 409, code: 'READ_PLAN_VALIDATION_SUPERSEDED', operation: 'confirm-sample', zh: '样本回执已被后续核对替代', en: 'A later check replaced', nextZh: '确认当前样本', nextEn: 'confirm the current sample' },
  { status: 409, code: 'READ_PLAN_VALIDATION_SOURCE_CHANGED', operation: 'confirm-sample', zh: '来源配置已变化', en: 'The source configuration changed', nextZh: '确认来源', nextEn: 'check the source' },
  { status: 409, code: 'READ_PLAN_VALIDATION_IN_PROGRESS', operation: 'validate', zh: '已有样本核对进行中', en: 'A sample check is already in progress', nextZh: '等待该次核对结束', nextEn: 'Wait for it to finish' },
  { status: 409, code: 'READ_PLAN_GENERATION_CONFLICT', operation: 'activate', zh: '激活记录已被其他操作更新', en: 'Another operation updated the activation record', nextZh: '激活状态', nextEn: 'activation status' },
] as const

function diagnosticRefusal(status: number, code: string, ok: unknown = false) {
  return new Response(JSON.stringify({ ok, error: { code, message: POISON, details: { object: POISON }, stack: POISON } }), { status })
}

const GENERIC_FAILURES = [
  { label: 'unknown code', status: 409, respond: () => diagnosticRefusal(409, POISON) },
  { label: 'wrong status', status: 409, respond: () => diagnosticRefusal(409, 'READ_PLAN_VALIDATION_CATALOG_UNVERIFIED') },
  { label: 'ok true', status: 409, respond: () => diagnosticRefusal(409, 'READ_PLAN_VALIDATION_INCOMPLETE', true) },
  { label: 'ok string', status: 409, respond: () => diagnosticRefusal(409, 'READ_PLAN_VALIDATION_INCOMPLETE', 'false') },
  { label: '2xx refusal', status: 200, respond: () => diagnosticRefusal(200, 'READ_PLAN_VALIDATION_INCOMPLETE') },
  { label: 'contradictory 2xx success and error', status: 200, respond: () => new Response(JSON.stringify({ ok: true, data: sampleResult(), error: { code: 'READ_PLAN_VALIDATION_TIMEOUT', message: POISON } }), { status: 200 }) },
  { label: '2xx success with null error', status: 200, respond: () => new Response(JSON.stringify({ ok: true, data: sampleResult(), error: null }), { status: 200 }) },
  { label: 'malformed success data', status: 0, respond: () => envelope({ ...sampleResult(), error: { code: 'READ_PLAN_VALIDATION_INCOMPLETE', message: POISON } }) },
  { label: 'parser failure', status: 0, respond: () => new Response(POISON, { status: 504 }) },
  { label: 'transport failure', status: 0, respond: () => { throw new Error(POISON) } },
] as const

function counts(sampleCount = 1, readCount = 2, objectCount = 3) {
  return { sampleCount, readCount, objectCount }
}
function receipt(status: 'pending' | 'passed' | 'confirmed' | 'failed', validationId = 'validation_sample', sampleCount = 1) {
  return {
    validationId, status,
    counts: status === 'passed' || status === 'confirmed' ? counts(sampleCount) : null,
    expiresAt: EXPIRES,
    confirmedAt: status === 'confirmed' ? CONFIRMED_AT : null,
  }
}
function sampleRow(index = 0, extra: Record<string, unknown> = {}) {
  return {
    componentSourceId: `SYN-${index}`, parentSourceId: index === 0 ? null : 'SYN-0', path: `SYN-0/SYN-${index}`,
    depth: index === 0 ? 0 : 1, componentCode: `CODE-${index}`, componentName: `Name ${index}`, material: false,
    sourceVersion: 'P1', rawQuantity: 0, totalQuantity: index, active: true, spec: null, sortLine: 0, ...extra,
  }
}
// HTTP fixtures deliberately include invalid cell values for parser refusals.
function sampleResult(rows: Array<Record<string, unknown>> = [sampleRow()], totalRows = rows.length, validationId = 'validation_sample') {
  return {
    validation: receipt('passed', validationId, totalRows),
    sample: { rows, totalRows, displayedRows: rows.length, truncated: totalRows > rows.length },
    catalog: { status: 'matched', validation: 'physical-columns-only', authorizesExecution: false, issues: [] },
    canApply: false, tokenIssued: false, authorizesExecution: false,
  }
}
function version(status: 'draft' | 'approved' | 'retired' = 'draft', id = 'version_1', contentKey = HASH) {
  return {
    id, tenantId: SCOPE.tenantId, workspaceId: null, actionId: ACTION, schemaVersion: 1,
    systemId: SYSTEM, version: 1, status, contentKey,
    config: { schemaVersion: 1, systemId: SYSTEM, actionId: ACTION, readPlan: READ_PLAN },
  }
}
function activation(status: 'active' | 'disabled' = 'active', generation = 1, versionId = 'version_1') {
  return { versionId, systemId: SYSTEM, actionId: ACTION, workspaceId: null, status, generation, contentKey: HASH }
}
function envelope(data: unknown) { return new Response(JSON.stringify({ ok: true, data })) }
function refusal() {
  return new Response(JSON.stringify({ ok: false, error: { code: 'PRIVATE_UNTRUSTED_TOKEN', message: 'PRIVATE_SCHEMA_CREDENTIAL' } }), { status: 409 })
}
function deferred() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null
let container: HTMLDivElement
let versions: ReturnType<typeof version>[]
let pointer: ReturnType<typeof activation> | null
let nextSample = sampleResult()
const receipts = new Map<string, ReturnType<typeof receipt> | null>()
let delay: { path: string; method: string; response: ReturnType<typeof deferred> } | null
let deny = false

function withReceipt(row: ReturnType<typeof version>) {
  const validation = receipts.get(row.id) ?? null
  return { ...row, validationId: validation?.validationId ?? null, validation }
}
function routes() {
  h.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/source-binding')) return envelope({
      actionId: ACTION, effectiveExternalSystemId: 'sys_bound_workspace', effectiveSourceKind: 'data-source:sql-readonly',
      origin: 'deploy_default', persistedBinding: null, effectiveSourceProblem: null,
      takesEffectWithoutRestart: true, eligibleSources: [],
    })
    const parsed = new URL(url, 'https://synthetic.invalid')
    const path = parsed.pathname.slice(SOURCE_PLAN_VERSIONS_ROUTE.length)
    const method = init?.method || 'GET'
    if (delay && delay.path === path && delay.method === method) return delay.response.promise
    if (deny) return refusal()
    if (method === 'GET') return envelope({ versions: versions.map(withReceipt), activation: pointer })
    const id = path.split('/')[1] || ''
    if (path.endsWith('/validate')) {
      receipts.set(id, nextSample.validation)
      return envelope(nextSample)
    }
    if (path.endsWith('/confirm-sample')) {
      const body = JSON.parse(String(init?.body)) as { validationId: string }
      const validation = { ...(receipts.get(id) || nextSample.validation), status: 'confirmed' as const, confirmedAt: CONFIRMED_AT, validationId: body.validationId }
      receipts.set(id, validation)
      return envelope(validation)
    }
    if (!path) { const row = version(); versions = [row]; return envelope(row) }
    if (path.endsWith('/approve')) {
      versions = versions.map((row) => row.id === id ? { ...row, status: 'approved' as const } : row)
      return envelope(withReceipt(versions.find((row) => row.id === id)!))
    }
    if (path.endsWith('/activate')) {
      pointer = activation('active', (pointer?.generation ?? 0) + 1, id)
      return envelope(pointer)
    }
    if (path === '/deactivate') { pointer = activation('disabled', (pointer?.generation ?? 0) + 1, pointer?.versionId || id); return envelope(pointer) }
    throw new Error(`unexpected synthetic route ${method} ${path}`)
  })
}
function element(id: string): HTMLElement { return container.querySelector(`[data-testid="stock-prep-${id}"]`)! }
async function click(id: string) { element(id).click(); await flush() }
async function input(id: string, value: string) {
  const node = element(id) as HTMLInputElement
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}
function calls() { return h.apiFetch.mock.calls.filter(([url]) => String(url).startsWith(SOURCE_PLAN_VERSIONS_ROUTE)) }
function posts(fragment: string) { return calls().filter(([url, init]) => init?.method === 'POST' && String(url).includes(fragment)) }
async function mount() {
  app = createApp(SourceBindingPanel, { scope: SCOPE })
  app.mount(container)
  await flush()
}
async function manage() {
  await click('plan-management-toggle')
  await input('plan-system', SYSTEM)
  await click('plan-refresh')
}
async function choose(id = 'version_1', project = 'SYN-PROJECT') {
  await click(`plan-version-${id}`)
  await input('plan-project', project)
}

beforeEach(() => {
  localStorage.clear()
  h.permissions = ['integration:admin']
  h.locale = 'zh-CN'
  h.apiFetch.mockReset()
  versions = []
  pointer = null
  nextSample = sampleResult()
  receipts.clear()
  delay = null
  deny = false
  app = null
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => { app?.unmount(); container.remove(); localStorage.clear(); vi.restoreAllMocks() })

describe('explicit PLM sample contract', () => {
  it('keeps status-only construction compatible', () => {
    expect(new SourcePlanVersionsError(409)).toMatchObject({ status: 409, code: undefined, message: 'PLM read plan request failed (409)' })
    expect(new SourcePlanVersionsError(502, 'READ_PLAN_VALIDATION_TIMEOUT').code).toBeUndefined()
  })

  it.each(DIAGNOSTICS)('retains only the fixed $status/$code diagnostic', async ({ status, code }) => {
    h.apiFetch.mockResolvedValueOnce(diagnosticRefusal(status, code))
    const failure = await validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SourcePlanVersionsError)
    expect(failure).toMatchObject({ status, code, message: `PLM read plan request failed (${status})` })
    expect(JSON.stringify(failure)).not.toContain(POISON)
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it.each(DIAGNOSTICS)('rejects a wrong status for $code', async ({ status, code }) => {
    const wrongStatus = status === 409 ? 422 : 409
    h.apiFetch.mockResolvedValueOnce(diagnosticRefusal(wrongStatus, code))
    await expect(validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT')).rejects.toMatchObject({ status: wrongStatus, code: undefined })
  })

  it.each(GENERIC_FAILURES)('keeps $label generic without leaking response or exception text', async ({ status, respond }) => {
    h.apiFetch.mockImplementationOnce(respond)
    const failure = await validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SourcePlanVersionsError)
    expect(failure).toMatchObject({ status, code: undefined, message: `PLM read plan request failed (${status})` })
    expect(JSON.stringify(failure)).not.toContain(POISON)
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the fixed business-cell whitelist and closed false caps', () => {
    expect([...SOURCE_PLAN_SAMPLE_FIELDS]).toEqual([...FIELDS])
  })

  it('parses one saved-version sample and confirmation without keeping raw fields', async () => {
    const secret = 'PRIVATE_SCHEMA_CREDENTIAL'
    const row = sampleRow(0)
    row.componentName = 'N'.repeat(4096)
    h.apiFetch.mockResolvedValueOnce(envelope(sampleResult([row])))
    const result = await validateSourcePlanVersionSample(SYSTEM, 'version_1', '  SYN-PROJECT  ')
    expect(JSON.parse(h.apiFetch.mock.calls[0][1].body)).toEqual({ managementScope: 'tenant', systemId: SYSTEM, projectNo: 'SYN-PROJECT' })
    expect(h.apiFetch.mock.calls[0][1].omitHeaders).toEqual(['x-tenant-id', 'x-workspace-id'])
    expect(result.canApply).toBe(false)
    expect(result.tokenIssued).toBe(false)
    expect(result.authorizesExecution).toBe(false)
    expect(result.catalog).toEqual({ status: 'matched', validation: 'physical-columns-only', authorizesExecution: false, issues: [] })
    expect(result.sample.rows[0].componentName).toHaveLength(4096)
    expect(Object.keys(result.sample.rows[0]).sort()).toEqual(FIELDS.filter(field => field !== 'orderBomVersion').sort())
    expect(Object.prototype.hasOwnProperty.call(result.sample.rows[0], 'orderBomVersion')).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    h.apiFetch.mockResolvedValueOnce(envelope(receipt('confirmed')))
    await expect(confirmSourcePlanVersionSample(SYSTEM, 'version_1', 'validation_sample')).resolves.toMatchObject({ status: 'confirmed', validationId: 'validation_sample' })
    expect(JSON.parse(h.apiFetch.mock.calls[1][1].body)).toEqual({ managementScope: 'tenant', systemId: SYSTEM, validationId: 'validation_sample' })
  })

  it.each([
    ['blank project', () => validateSourcePlanVersionSample(SYSTEM, 'version_1', '   '), false],
    ['control project', () => validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN\nPROJECT'), false],
    ['long project', () => validateSourcePlanVersionSample(SYSTEM, 'version_1', 'P'.repeat(129)), false],
  ])('rejects %s before fetch', async (_label, run, called) => {
    await expect(run()).rejects.toMatchObject({ status: 0, message: 'PLM read plan request failed (0)' })
    expect(h.apiFetch).toHaveBeenCalledTimes(called ? 1 : 0)
  })

  it.each([
    ['extra cell', () => sampleResult([sampleRow(0, { authorityCode: 'PRIVATE_SCHEMA_CREDENTIAL' })])],
    ['raw row', () => sampleResult([sampleRow(0, { rawRow: { secret: 'PRIVATE_SCHEMA_CREDENTIAL' } })])],
    ['hidden business key', () => sampleResult([sampleRow(0, { projectNo: 'SYN-PROJECT', idempotencyKey: 'PRIVATE_SCHEMA_CREDENTIAL' })])],
    ['long cell', () => sampleResult([sampleRow(0, { componentName: 'N'.repeat(4097) })])],
    ['string quantity', () => sampleResult([{ ...sampleRow(0), rawQuantity: '0' }])],
    ['object cell', () => sampleResult([sampleRow(0, { spec: { secret: 'PRIVATE_SCHEMA_CREDENTIAL' } })])],
    ['depth 21', () => sampleResult([{ ...sampleRow(0), depth: 21 }])],
    ['active string', () => sampleResult([{ ...sampleRow(0), active: 'true' }])],
    ['apply cap', () => ({ ...sampleResult(), canApply: true })],
    ['token cap', () => ({ ...sampleResult(), tokenIssued: true })],
    ['execution cap', () => ({ ...sampleResult(), authorizesExecution: true })],
    ['catalog meaning', () => ({ ...sampleResult(), catalog: { ...sampleResult().catalog, validation: 'business-meaning' } })],
    ['catalog issue', () => ({ ...sampleResult(), catalog: { ...sampleResult().catalog, issues: [{ path: 'part', code: 'PRIVATE_SCHEMA_CREDENTIAL' }] } })],
    ['raw rows bag', () => ({ ...sampleResult(), sample: { ...sampleResult().sample, rawRows: ['PRIVATE_SCHEMA_CREDENTIAL'] } })],
    ['too many displayed rows', () => sampleResult(Array.from({ length: 21 }, (_, index) => sampleRow(index)), 21)],
    ['truncated flag', () => ({ ...sampleResult([sampleRow()], 4), sample: { rows: [sampleRow()], totalRows: 4, displayedRows: 1, truncated: false } })],
    ['count mismatch', () => ({ ...sampleResult(), validation: { ...receipt('passed'), counts: counts(9) } })],
    ['pending sample', () => ({ ...sampleResult(), validation: receipt('pending') })],
    ['evidence bag', () => ({ ...sampleResult(), evidence: { secret: 'PRIVATE_SCHEMA_CREDENTIAL' } })],
  ])('rejects a sample payload with %s and does not echo it', async (_label, build) => {
    h.apiFetch.mockResolvedValue(envelope(build()))
    await expect(validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT')).rejects.toMatchObject({ status: 0, message: 'PLM read plan request failed (0)' })
  })

  it('accepts the 20-row display boundary and measured zero cells', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => sampleRow(index))
    h.apiFetch.mockResolvedValue(envelope(sampleResult(rows, 25)))
    const result = await validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT')
    expect(result.sample.displayedRows).toBe(20)
    expect(result.sample.totalRows).toBe(25)
    expect(result.sample.truncated).toBe(true)
    expect(result.sample.rows).toHaveLength(20)
    expect(result.sample.rows[1].rawQuantity).toBe(0)
    expect(result.sample.rows[1].material).toBe(false)
    expect(result.validation.counts).toEqual(counts(25))
  })

  it.each(['ORDER-B2', 0])('preserves optional order-requested BOM version %s without filling absent descendants', async orderBomVersion => {
    h.apiFetch.mockResolvedValueOnce(envelope(sampleResult([
      sampleRow(0, { sourceVersion: 'MATERIAL-V9', orderBomVersion }),
      sampleRow(1, { sourceVersion: 'MATERIAL-V3' }),
    ])))
    const result = await validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT')
    expect(result.sample.rows[0].orderBomVersion).toBe(orderBomVersion)
    expect(result.sample.rows[0].sourceVersion).toBe('MATERIAL-V9')
    expect(Object.prototype.hasOwnProperty.call(result.sample.rows[1], 'orderBomVersion')).toBe(false)
    expect(result.sample.rows[1].sourceVersion).toBe('MATERIAL-V3')
    expect(result.validation).toEqual(receipt('passed', 'validation_sample', 2))
  })

  it.each([{ secret: POISON }, 'N'.repeat(4097)])('rejects an undisplayable order BOM version %#', async orderBomVersion => {
    h.apiFetch.mockResolvedValueOnce(envelope(sampleResult([sampleRow(0, { orderBomVersion })])))
    await expect(validateSourcePlanVersionSample(SYSTEM, 'version_1', 'SYN-PROJECT')).rejects.toMatchObject({ status: 0 })
  })

  it.each([
    ['null summary', { versions: [{ ...version(), validationId: null, validation: null }], activation: null }],
    ['omitted summary', { versions: [version()], activation: null }],
    ['passed summary', { versions: [{ ...version(), ...{ validationId: 'validation_sample', validation: receipt('passed') } }], activation: null }],
    ['failed summary', { versions: [{ ...version('approved'), validationId: 'validation_failed', validation: receipt('failed', 'validation_failed') }], activation: null }],
  ])('accepts a list %s without sample rows', async (_label, data) => {
    h.apiFetch.mockResolvedValue(envelope(data))
    const listed = await listSourcePlanVersions(SYSTEM)
    expect(listed.versions).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('CODE-0')
  })

  it('rejects a summary that disagrees with its id or carries rows', async () => {
    h.apiFetch.mockResolvedValueOnce(envelope({ versions: [{ ...version(), validationId: 'validation_a', validation: receipt('passed', 'validation_b') }], activation: null }))
    await expect(listSourcePlanVersions(SYSTEM)).rejects.toMatchObject({ status: 0 })
    h.apiFetch.mockResolvedValueOnce(envelope(receipt('passed')))
    await expect(confirmSourcePlanVersionSample(SYSTEM, 'version_1', 'validation_sample')).rejects.toMatchObject({ status: 0, message: 'PLM read plan request failed (0)' })
    h.apiFetch.mockResolvedValueOnce(envelope({ ...receipt('confirmed'), rows: [sampleRow()] }))
    await expect(confirmSourcePlanVersionSample(SYSTEM, 'version_1', 'validation_sample')).rejects.toMatchObject({ status: 0 })
  })
})

describe('explicit sample confirmation in the source-binding editor', () => {
  beforeEach(routes)

  it.each(['zh-CN', 'en-US'])('distinguishes material and order BOM versions and preserves absent cells in %s', async locale => {
    h.locale = locale
    versions = [version()]
    nextSample = sampleResult([
      sampleRow(0, { sourceVersion: 'MATERIAL-V9', orderBomVersion: 0 }),
      sampleRow(1, { depth: 0, parentSourceId: null, sourceVersion: 'MATERIAL-V4', orderBomVersion: 'ORDER-B2' }),
      sampleRow(2, { sourceVersion: 'MATERIAL-V3' }),
    ])
    await mount()
    await manage()
    await choose()
    await click('plan-validate')
    expect(element('plan-sample-table').textContent).toContain(locale === 'zh-CN' ? '物料来源版本' : 'Material source version')
    expect(element('plan-sample-table').textContent).toContain(locale === 'zh-CN' ? '订单指定 BOM 版本' : 'Order-requested BOM version')
    expect(element('plan-sample-0-orderBomVersion').textContent).toBe('0')
    expect(element('plan-sample-1-orderBomVersion').textContent).toBe('ORDER-B2')
    expect(element('plan-sample-2-orderBomVersion').textContent).toBe('')
    expect(element('plan-sample-2-sourceVersion').textContent).toBe('MATERIAL-V3')
    expect(element('plan-sample-version-note').textContent).toContain(locale === 'zh-CN' ? '来源未提供' : 'not supplied')
    expect(element('plan-sample-version-note').textContent).toContain(locale === 'zh-CN' ? '不表示与物料来源版本相同' : 'not that it matches the material source version')
    expect(posts('/validate')).toHaveLength(1)
    expect(posts('/confirm-sample')).toHaveLength(0)
  })

  it.each(['zh-CN', 'en-US'].flatMap(locale => DIAGNOSTICS.map(diagnostic => ({ ...diagnostic, locale }))))('shows a fixed next action for $code in $locale without automatic requests', async ({ status, code, operation, zh, en, nextZh, nextEn, locale }) => {
    h.locale = locale
    versions = [version(operation === 'activate' ? 'approved' : 'draft')]
    if (operation === 'activate') {
      receipts.set('version_1', receipt('confirmed'))
      pointer = activation()
    }
    await mount()
    await manage()
    await choose()
    if (operation === 'confirm-sample') await click('plan-validate')
    if (operation === 'activate') await click('plan-activate')
    const before = calls().length
    h.apiFetch.mockResolvedValueOnce(diagnosticRefusal(status, code))
    await click(operation === 'activate' ? 'plan-confirm-submit' : `plan-${operation}`)
    const text = element('plan-error').textContent!
    expect(text).toContain(locale === 'zh-CN' ? zh : en)
    expect(text).toContain(locale === 'zh-CN' ? nextZh : nextEn)
    expect(text.toLowerCase()).toContain(locale === 'zh-CN' ? '重新读取版本' : 'reload the versions')
    expect(text).toContain(`HTTP ${status}`)
    expect(text).not.toContain(code)
    expect(container.textContent).not.toContain(POISON)
    expect(container.textContent).not.toContain('authorityCode')
    expect(container.textContent).not.toContain('appKey')
    expect(element('plan-sample')).toBeNull()
    expect(element('plan-versions')).toBeNull()
    expect(element('plan-confirm')).toBeNull()
    expect((element('plan-refresh') as HTMLButtonElement).disabled).toBe(false)
    await flush()
    expect(calls()).toHaveLength(before + 1)
    expect(posts('/approve')).toHaveLength(0)
    expect(posts('/validate')).toHaveLength(operation === 'activate' ? 0 : 1)
    expect(posts('/confirm-sample')).toHaveLength(operation === 'confirm-sample' ? 1 : 0)
    expect(posts('/activate')).toHaveLength(operation === 'activate' ? 1 : 0)
  })

  it.each(GENERIC_FAILURES)('shows only generic guidance for $label', async ({ status, respond }) => {
    versions = [version()]
    await mount()
    await manage()
    await choose()
    h.apiFetch.mockImplementationOnce(respond)
    await click('plan-validate')
    expect(element('plan-error').textContent).toContain(status === 409 ? '版本、激活或样本回执已变化' : '读取或保存计划失败')
    expect(element('plan-error').textContent).toContain(`HTTP ${status}`)
    expect(container.textContent).not.toContain(POISON)
    expect(container.textContent).not.toContain('READ_PLAN_')
    expect(element('plan-sample')).toBeNull()
    await flush()
    expect(posts('/validate')).toHaveLength(1)
    expect(posts('/confirm-sample')).toHaveLength(0)
    expect(posts('/approve')).toHaveLength(0)
    expect(posts('/activate')).toHaveLength(0)
  })

  it('removes an old diagnostic on refresh, target replacement and session reset', async () => {
    versions = [version()]
    await mount()
    await manage()
    await choose()
    h.apiFetch.mockResolvedValueOnce(diagnosticRefusal(504, 'READ_PLAN_VALIDATION_TIMEOUT'))
    await click('plan-validate')
    expect(element('plan-error').textContent).toContain('超时不代表已取消')
    await click('plan-refresh')
    expect(element('plan-error')).toBeNull()
    await choose()
    h.apiFetch.mockResolvedValueOnce(refusal())
    await click('plan-validate')
    expect(element('plan-error').textContent).toContain('版本、激活或样本回执已变化')
    expect(element('plan-error').textContent).not.toContain('超时')
    await input('plan-system', OTHER)
    expect(element('plan-error')).toBeNull()
    await input('plan-system', SYSTEM)
    await click('plan-refresh')
    await choose()
    h.apiFetch.mockResolvedValueOnce(diagnosticRefusal(409, 'READ_PLAN_VALIDATION_INCOMPLETE'))
    await click('plan-validate')
    expect(element('plan-error').textContent).toContain('这不代表零数据或读取成功')
    notifyAuthPrincipalChange()
    await flush()
    expect(element('plan-error')).toBeNull()
    expect(container.textContent).not.toContain('这不代表零数据或读取成功')
    expect(posts('/validate')).toHaveLength(3)
  })

  it('ignores a late failure diagnostic after the project or session changes', async () => {
    versions = [version()]
    await mount()
    await manage()
    await choose()
    const response = deferred()
    delay = { path: '/version_1/validate', method: 'POST', response }
    await click('plan-validate')
    await input('plan-project', 'SYN-OTHER')
    response.resolve(diagnosticRefusal(504, 'READ_PLAN_VALIDATION_TIMEOUT'))
    await flush()
    expect(element('plan-error')).toBeNull()
    const next = deferred()
    delay = { path: '/version_1/validate', method: 'POST', response: next }
    await click('plan-validate')
    notifyAuthPrincipalChange()
    await flush()
    next.resolve(diagnosticRefusal(409, 'READ_PLAN_VALIDATION_INCOMPLETE'))
    await flush()
    expect(element('plan-error')).toBeNull()
    expect(container.textContent).not.toContain('零数据')
    expect(posts('/validate')).toHaveLength(2)
  })

  it('checks only the selected saved version and never reads on load, save, approve, or activate', async () => {
    receipts.set('version_1', receipt('confirmed', 'validation_1'))
    versions = [version(), version('approved', 'version_2')]
    pointer = activation('active', 1, 'version_active')
    await mount()
    expect(element('plan-validation')).toBeNull()
    expect(calls().some(([url]) => String(url).includes('/validate'))).toBe(false)
    await click('source-plan-draft-synthetic')
    await input('source-plan-draft-input-pathExAttr-object', 'SYN_NEW_LOCAL')
    await manage()
    await click('plan-save')
    await choose('version_1')
    expect(element('plan-validation-target').textContent).toContain('version_1')
    expect(element('plan-validation-target').textContent).toContain('不会读取本地未保存草稿')
    expect(element('source-plan-draft-note').textContent).toContain('物理列')
    expect(element('source-plan-draft-note').textContent).toContain('业务含义')
    expect(element('source-plan-draft-note').textContent).toContain('只检查结构')
    expect((element('plan-confirm-sample') as HTMLButtonElement).disabled).toBe(true)
    expect((element('plan-approve') as HTMLButtonElement).disabled).toBe(false)
    await click('plan-approve')
    expect(element('plan-confirm').textContent).toContain('物理列')
    expect(element('plan-confirm').textContent).toContain('业务含义')
    expect(element('plan-confirm').textContent).not.toContain('代次')
    await click('plan-confirm-submit')
    await click('plan-activate')
    await click('plan-confirm-submit')
    expect(calls().some(([url]) => String(url).includes('/validate') || String(url).includes('/confirm-sample'))).toBe(false)
    expect(posts('/approve').map(([, init]) => JSON.parse(init.body))).toEqual([{ managementScope: 'tenant', systemId: SYSTEM }])
    expect(posts('/activate').map(([, init]) => JSON.parse(init.body))).toEqual([{ managementScope: 'tenant', systemId: SYSTEM, expectedGeneration: 1 }])
  })

  it('shows the fixed sample for the selected version and confirms only that received receipt', async () => {
    versions = [version(), version('approved', 'version_2')]
    pointer = activation('active', 2, 'version_2')
    const rows = Array.from({ length: 20 }, (_, index) => sampleRow(index))
    nextSample = sampleResult(rows, 25, 'validation_rows')
    await mount()
    await manage()
    await choose('version_1', '  SYN-PROJECT  ')
    expect((element('plan-validate') as HTMLButtonElement).disabled).toBe(false)
    await click('plan-validate')
    expect(posts('/validate')).toHaveLength(1)
    expect(String(posts('/validate')[0][0])).toContain('/version_1/validate')
    expect(String(posts('/validate')[0][0])).not.toContain('version_2')
    expect(JSON.parse(posts('/validate')[0][1].body)).toEqual({ managementScope: 'tenant', systemId: SYSTEM, projectNo: 'SYN-PROJECT' })
    expect(JSON.stringify(posts('/validate')[0][1].body)).not.toContain('readPlan')
    const table = element('plan-sample-table')
    expect(table.querySelectorAll('th')).toHaveLength(FIELDS.length)
    expect(table.querySelectorAll('tbody tr')).toHaveLength(20)
    expect(table.textContent).toContain('componentCode')
    expect(table.textContent).toContain('组件编码')
    expect(table.textContent).not.toContain('idempotencyKey')
    expect(table.textContent).not.toContain('nameAndSpec')
    expect(element('plan-sample-meta').textContent).toContain('已显示 20 行，共 25 行')
    expect(element('plan-sample-meta').textContent).toContain('未显示的行不在这里展开')
    expect(element('plan-sample-0-rawQuantity').textContent).toBe('0')
    expect(element('plan-sample-0-material').textContent).toBe('否')
    expect(element('plan-sample-0-active').textContent).toBe('是')
    expect(element('plan-sample-0-spec').textContent).toBe('')
    expect(container.textContent).not.toContain('tokenIssued')
    expect(container.textContent).not.toContain('canApply')
    expect((element('plan-approve') as HTMLButtonElement).disabled).toBe(true)
    expect((element('plan-confirm-sample') as HTMLButtonElement).disabled).toBe(false)
    await click('plan-confirm-sample')
    expect(JSON.parse(posts('/confirm-sample')[0][1].body)).toEqual({ managementScope: 'tenant', systemId: SYSTEM, validationId: 'validation_rows' })
    expect((element('plan-confirm-sample') as HTMLButtonElement).disabled).toBe(true)
    expect((element('plan-approve') as HTMLButtonElement).disabled).toBe(false)
    expect(element('plan-sample')).not.toBeNull()
  })

  it('does not treat a reloaded passed summary as confirmation', async () => {
    versions = [version()]
    receipts.set('version_1', receipt('passed'))
    await mount()
    await manage()
    await choose()
    expect(element('plan-validation-version_1').textContent).toContain('尚未确认')
    expect(element('plan-sample')).toBeNull()
    expect((element('plan-confirm-sample') as HTMLButtonElement).disabled).toBe(true)
    expect((element('plan-approve') as HTMLButtonElement).disabled).toBe(true)
    await click('plan-confirm-sample')
    await click('plan-approve')
    expect(posts('/confirm-sample')).toHaveLength(0)
    expect(posts('/approve')).toHaveLength(0)
    await click('plan-validate')
    expect(element('plan-sample')).not.toBeNull()
    await click('plan-refresh')
    expect(element('plan-sample')).toBeNull()
    expect(element('plan-validation-version_1').textContent).toContain('尚未确认')
    expect((element('plan-confirm-sample') as HTMLButtonElement).disabled).toBe(true)
    expect(posts('/confirm-sample')).toHaveLength(0)
  })

  it('drops a late sample when the project, selection, content, source, session, or connection changes', async () => {
    versions = [version(), version('draft', 'version_2')]
    await mount()
    await manage()
    await choose()
    const response = deferred()
    delay = { path: '/version_1/validate', method: 'POST', response }
    await click('plan-validate')
    await input('plan-project', 'SYN-OTHER')
    response.resolve(envelope(sampleResult([sampleRow(0, { componentCode: 'LATE_SAMPLE_CODE' })])))
    await flush()
    delay = null
    expect(container.textContent).not.toContain('LATE_SAMPLE_CODE')
    expect(element('plan-sample')).toBeNull()
    expect((element('plan-refresh') as HTMLButtonElement).disabled).toBe(false)

    nextSample = sampleResult([sampleRow(0, { componentCode: 'SEEN-CODE' })], 1, 'validation_seen')
    await input('plan-project', 'SYN-PROJECT')
    await click('plan-validate')
    expect(element('plan-sample').textContent).toContain('SEEN-CODE')
    await click('plan-version-version_2')
    expect(element('plan-sample')).toBeNull()
    expect(container.textContent).not.toContain('SEEN-CODE')

    await click('plan-version-version_1')
    await click('plan-validate')
    versions = [version('draft', 'version_1', OTHER_HASH)]
    await click('plan-refresh')
    expect(element('plan-sample')).toBeNull()
    expect((element('plan-confirm-sample') as HTMLButtonElement).disabled).toBe(true)

    await click('plan-validate')
    await input('plan-system', OTHER)
    expect(element('plan-validation')).toBeNull()
    expect(container.textContent).not.toContain('SEEN-CODE')

    await input('plan-system', SYSTEM)
    await click('plan-refresh')
    await choose()
    await click('plan-validate')
    await click('source-refresh')
    expect(element('plan-sample')).toBeNull()
    expect(posts('/validate')).toHaveLength(5)

    await click('plan-validate')
    expect(element('plan-sample')).not.toBeNull()
    notifyAuthPrincipalChange()
    await flush()
    expect(element('plan-management')).toBeNull()
    expect(container.textContent).not.toContain('SEEN-CODE')
  })

  it('ignores a validate reply that arrives after the plan context is replaced', async () => {
    versions = [version()]
    await mount()
    await manage()
    await choose()
    const response = deferred()
    delay = { path: '/version_1/validate', method: 'POST', response }
    await click('plan-validate')
    await input('plan-system', OTHER)
    response.resolve(envelope(sampleResult([sampleRow(0, { componentCode: 'LATE_SAMPLE_CODE' })])))
    await flush()
    expect(container.textContent).not.toContain('LATE_SAMPLE_CODE')
    expect(element('plan-versions')).toBeNull()
    expect(element('plan-error')).toBeNull()
  })

  it('guards a second click while validate or confirmation is outstanding', async () => {
    versions = [version()]
    await mount()
    await manage()
    await choose()
    const validating = deferred()
    delay = { path: '/version_1/validate', method: 'POST', response: validating }
    element('plan-validate').click()
    element('plan-validate').click()
    await flush()
    expect(posts('/validate')).toHaveLength(1)
    expect((element('plan-version-version_1') as HTMLInputElement).disabled).toBe(true)
    validating.resolve(envelope(nextSample))
    await flush()
    const confirming = deferred()
    delay = { path: '/version_1/confirm-sample', method: 'POST', response: confirming }
    element('plan-confirm-sample').click()
    element('plan-confirm-sample').click()
    await flush()
    expect(posts('/confirm-sample')).toHaveLength(1)
    confirming.resolve(envelope({ ...nextSample.validation, status: 'confirmed', confirmedAt: CONFIRMED_AT }))
    await flush()
    expect((element('plan-approve') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps save and disable, and blocks approve or activate without a current confirmed receipt', async () => {
    versions = [version('approved')]
    pointer = activation()
    await mount()
    await click('source-plan-draft-synthetic')
    await manage()
    await click('plan-save')
    expect(posts('/validate')).toHaveLength(0)
    versions = [version('approved')]
    pointer = activation()
    await click('plan-refresh')
    await choose()
    expect((element('plan-activate') as HTMLButtonElement).disabled).toBe(true)
    expect((element('plan-deactivate') as HTMLButtonElement).disabled).toBe(false)
    await click('plan-activate')
    expect(element('plan-confirm')).toBeNull()
    await click('plan-deactivate')
    await click('plan-confirm-submit')
    expect(posts('/deactivate')).toHaveLength(1)
    expect(JSON.parse(posts('/deactivate')[0][1].body)).toEqual({ managementScope: 'tenant', systemId: SYSTEM, expectedGeneration: 1 })

    receipts.set('version_1', { ...receipt('confirmed', 'validation_old'), expiresAt: '2000-01-01T00:00:00.000Z', confirmedAt: '1999-12-01T00:00:00.000Z' })
    versions = [version()]
    await click('plan-refresh')
    await click('plan-version-version_1')
    expect(element('plan-receipt').textContent).toContain('15 分钟')
    expect(element('plan-receipt').textContent).toContain('不会使已经激活的计划停止读取')
    expect((element('plan-approve') as HTMLButtonElement).disabled).toBe(true)
    await click('plan-approve')
    expect(posts('/approve')).toHaveLength(0)
  })

  it('does not submit approval after the receipt window closes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:00.000Z'))
    receipts.set('version_1', {
      validationId: 'validation_clock', status: 'confirmed', counts: counts(),
      expiresAt: '2026-10-01T00:15:00.000Z', confirmedAt: '2026-10-01T00:01:00.000Z',
    })
    versions = [version()]
    await mount()
    await manage()
    await click('plan-version-version_1')
    await click('plan-approve')
    expect(element('plan-confirm')).not.toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:15:00.000Z'))
    await click('plan-confirm-submit')
    expect(posts('/approve')).toHaveLength(0)
    expect(element('plan-error')).toBeNull()
  })

  it('refuses a sample that carries an undisplayable field and a retired version', async () => {
    versions = [version(), version('retired', 'version_retired')]
    nextSample = sampleResult([sampleRow(0, { authorityCode: 'PRIVATE_SCHEMA_CREDENTIAL' })])
    await mount()
    await manage()
    await choose()
    await click('plan-validate')
    expect(element('plan-error').textContent).toContain('HTTP 0')
    expect(element('plan-sample')).toBeNull()
    expect(container.textContent).not.toContain('PRIVATE_SCHEMA_CREDENTIAL')
    expect(container.textContent).not.toContain('authorityCode')
    versions = [version('retired', 'version_retired')]
    await click('plan-refresh')
    await click('plan-version-version_retired')
    await input('plan-project', 'SYN-PROJECT')
    expect((element('plan-validate') as HTMLButtonElement).disabled).toBe(true)
    await click('plan-validate')
    expect(posts('/validate')).toHaveLength(1)
  })
})
