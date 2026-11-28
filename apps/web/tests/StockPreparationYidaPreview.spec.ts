import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import StockPreparationYidaPreviewPanel from '../src/components/integration/stockPreparation/StockPreparationYidaPreviewPanel.vue'
import { parseYidaRuleTemplate } from '../../../plugins/plugin-integration-core/lib/yida-rule-template.mjs'
import { buildYidaSetupConfig, defaultMappingRows, STOCK_PREP_YIDA_SOURCE_FIELDS } from '../src/services/integration/yidaSetupMapping'

// 宜搭表单配置（四步，T-13）. Mocked HTTP/jsdom only: synthetic identifiers and credentials, no real JWT,
// deployment anchor, DingTalk call or database. The server guards are covered by the backend suites.
const endpoint = '/api/integration/yida-owner-send/initialization'
const ids = { command: '11111111-1111-4111-8111-111111111111', target: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444', row: '55555555-5555-4555-8555-555555555555' }
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU4tT1dORVIiLCJ0ZW5hbnRJZCI6IlNZTi1PUkcifQ.c3ludGhldGlj'
const secrets = { appKey: 'SYN-KEY', appSecret: 'SYN-SECRET', systemToken: 'SYN-SYSTEM-TOKEN', userId: 'SYN-USER' }
const yidaFields = [
  { fieldId: 'textField_proj', label: '项目号', componentName: 'TextField', parentId: null },
  { fieldId: 'textField_code', label: '图号', componentName: 'TextField', parentId: null },
  { fieldId: 'textField_name', label: '名称', componentName: 'TextField', parentId: null },
  { fieldId: 'textField_spec', label: '规格', componentName: 'TextField', parentId: null },
  { fieldId: 'textField_mat', label: '材质', componentName: 'TextField', parentId: null },
  { fieldId: 'textField_ver', label: '版本', componentName: 'TextField', parentId: null },
  { fieldId: 'textField_parent', label: '父组件图号', componentName: 'TextField', parentId: null },
  { fieldId: 'numberField_qty', label: '数量', componentName: 'NumberField', parentId: null },
  { fieldId: 'selectField_pri', label: '优先级', componentName: 'SelectField', parentId: null },
  { fieldId: 'dateField_due', label: '交期', componentName: 'DateField', parentId: null },
]
function metadata() { return { targetRef: ids.target, operationId: ids.operation, status: 'unverified', identityKind: 'local-unverified',
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: 2,
  rows: [{ rowKey: ids.row, index: 0 }, { rowKey: '66666666-6666-4666-8666-666666666666', index: 1 }], reused: false } }
function ready(options: { test?: boolean; fields?: boolean; send?: boolean } = {}) {
  return { commandId: ids.command, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false,
    sendEnabled: options.send === true, ...(options.test !== false ? { connectionTestEnabled: true } : {}),
    ...(options.fields !== false ? { formFieldsReadEnabled: true } : {}) }
}
function initialized(options: { send?: boolean } = {}) { return { ...ready({ send: options.send }), status: 'initialized', draft: metadata() } }
const probeView = (outcome = 'ok', formRead?: unknown) => ({ commandId: ids.command, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
  tokenRetained: false, externalWriteAttempted: false, canSend: false, ...(formRead === undefined ? {} : { formRead }) })
function json(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }) }
function failure(code: string, status = 503) { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: { 'Content-Type': 'application/json' } }) }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); await nextTick() }

describe('宜搭表单配置 — four operator steps', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  const fetchSpy = vi.fn()
  beforeEach(() => { localStorage.setItem('auth_token', token); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

  async function mount(first: Response = json(ready())) {
    fetchSpy.mockResolvedValueOnce(first)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(StockPreparationYidaPreviewPanel); app.mount(root)
    await flush()
  }
  function q<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = root?.querySelector<T>(`[data-testid="sp-yida-${id}"]`)
    if (!node) throw new Error(`MISSING ${id}`)
    return node
  }
  const absent = (id: string) => root?.querySelector(`[data-testid="sp-yida-${id}"]`) === null
  async function type(id: string, value: string) { const node = q<HTMLInputElement>(id); node.value = value; node.dispatchEvent(new Event('input')); await flush() }
  async function choose(id: string, value: string) { const node = q<HTMLSelectElement>(id); node.value = value; node.dispatchEvent(new Event('change')); await flush() }
  async function check(id: string) { const node = q<HTMLInputElement>(id); node.checked = true; node.dispatchEvent(new Event('change')); await flush() }
  async function click(id: string) { q<HTMLButtonElement>(id).click(); await flush() }
  async function fillStep1() {
    await type('app-type', 'APP_SYN01'); await type('form-uuid', 'FORM-SYN-01'); await type('organization', 'SYN-ORG')
    for (const [key, value] of Object.entries(secrets)) await type(key, key === 'userId' ? value : `${value}\n`)
  }
  async function testOk() {
    fetchSpy.mockResolvedValueOnce(json(probeView('ok', { outcome: 'ok', fields: yidaFields })))
    await click('connection-test')
  }
  const sentBody = (call: number) => JSON.parse(fetchSpy.mock.calls[call][1].body as string)

  it('reads the server status by itself on open, shows four steps and no internal step, and marks all seven inputs required', async () => {
    await mount()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe(endpoint)
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect([1, 2, 3, 4].map(n => q(`step-${n}`).textContent)).toEqual(['1 表单信息与测试连接（当前）', '2 字段映射', '3 预演', '4 保存启用'])
    const text = root!.textContent ?? ''
    for (const gone of ['手动 GET', '选合同', '生成并存档规则草稿', '打开本地初始化']) expect(text).not.toContain(gone)
    expect(absent('preview-mode')).toBe(true)
    for (const id of ['app-type', 'form-uuid', 'organization', 'appKey', 'appSecret', 'systemToken', 'userId']) {
      expect(q<HTMLInputElement>(id).required).toBe(true)
      expect(q<HTMLInputElement>(id).closest('label')?.textContent).toContain('*')
    }
    expect(q('status').textContent).toContain('服务器已就绪')
    expect(absent('status-retry')).toBe(true)
  })

  it('a failed status read is retried automatically, then offers one retry button; nothing is POSTed', async () => {
    vi.useFakeTimers()
    await mount(failure('YIDA_INITIALIZATION_UNAVAILABLE'))
    expect(q('status').textContent).toContain('未确认')
    for (const delay of [2000, 5000, 10000]) {
      fetchSpy.mockResolvedValueOnce(failure('YIDA_INITIALIZATION_UNAVAILABLE'))
      await vi.advanceTimersByTimeAsync(delay); await flush()
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(fetchSpy.mock.calls.every(call => call[1].method === 'GET')).toBe(true)
    expect(q('status-retry')).toBeTruthy()
    fetchSpy.mockResolvedValueOnce(json(ready())); await click('status-retry')
    expect(q('status').textContent).toContain('服务器已就绪')
  })

  it('测试连接 sends the pair and the named form, then the YiDa fields fill the mapping by label', async () => {
    await mount(); await fillStep1()
    expect(q('connection-test').textContent).toContain('并读取表单字段')
    await testOk()
    const body = sentBody(1)
    expect(fetchSpy.mock.calls[1][0]).toBe(`${endpoint}/connection-test`)
    expect(body).toEqual({ commandId: ids.command, mode: 'candidate', material: { appKey: 'SYN-KEY', appSecret: 'SYN-SECRET' },
      form: { appType: 'APP_SYN01', formUuid: 'FORM-SYN-01', systemToken: 'SYN-SYSTEM-TOKEN', userId: 'SYN-USER' } })
    expect(q('connection-result').textContent).toContain('appKey/appSecret 有效')
    expect(q('form-read-result').textContent).toContain('10 个字段（可映射 9 个）')
    expect(q('step-1').textContent).toContain('已完成')
    // Auto-matched by label; the date field is never offered.
    expect(q<HTMLSelectElement>('map-target-0').value).toBe('textField_proj')
    expect(q<HTMLSelectElement>('map-target-7').value).toBe('numberField_qty')
    expect([...q<HTMLSelectElement>('map-target-0').options].map(option => option.value)).not.toContain('dateField_due')
    // The number source offers only number fields.
    expect([...q<HTMLSelectElement>('map-target-7').options].map(option => option.value)).toEqual(['', 'numberField_qty'])
    // The select field asks for its options.
    expect(q('map-options-8')).toBeTruthy()
    expect(q('map-issues').textContent).toContain('优先级')
  })

  it('with the form read switch off: only the pair is tested and the mapping takes typed component IDs', async () => {
    await mount(json(ready({ fields: false }))); await fillStep1()
    expect(q('fields-manual').textContent).toContain('手动填写')
    fetchSpy.mockResolvedValueOnce(json(probeView('ok'))); await click('connection-test')
    expect(Object.keys(sentBody(1))).toEqual(['commandId', 'mode', 'material'])
    expect(q<HTMLInputElement>('map-target-0').tagName).toBe('INPUT')
    expect(q('step-1').textContent).toContain('已完成')
  })

  it('a rejected form read says why in plain words and leaves the mapping manual', async () => {
    await mount(); await fillStep1()
    fetchSpy.mockResolvedValueOnce(json(probeView('ok', { outcome: 'upstream_rejected', fields: [] }))); await click('connection-test')
    expect(q('form-read-result').textContent).toContain('宜搭表单数据读权限')
    expect(q('step-1').textContent).not.toContain('已完成')
    expect(q<HTMLInputElement>('map-target-0').tagName).toBe('INPUT')
  })

  it('mapping → preview → 保存启用: one POST with the v2 seven-key contract, trimmed credentials and an auto-archived rule draft', async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() }))
    await mount(); await fillStep1(); await testOk()
    const options = q<HTMLTextAreaElement>('map-options-8'); options.value = 'normal\nrush'; options.dispatchEvent(new Event('input')); await flush()
    expect(absent('map-issues')).toBe(true)
    expect(q<HTMLButtonElement>('run').disabled).toBe(false)
    await click('run')
    expect(q('summary').textContent).toContain('计划创建 2')
    expect(q('step-3').textContent).toContain('已完成')
    expect(q<HTMLButtonElement>('save-submit').disabled).toBe(true)
    await type('review', 'SYN-REVIEW'); await check('ack')
    expect(absent('save-blocked')).toBe(true)
    fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await click('save-submit')
    const body = sentBody(2)
    expect(fetchSpy.mock.calls[2][0]).toBe(endpoint)
    expect(Object.keys(body)).toEqual(['commandId', 'material', 'draft', 'attestation'])
    expect(body.material).toEqual(secrets)
    expect(body.attestation).toEqual({ kind: 'owner-reviewed-target', reviewRef: 'SYN-REVIEW', organizationId: 'SYN-ORG', executionIdentity: 'SYN-USER' })
    expect(body.draft.config).toMatchObject({ version: 2, intent: 'create', target: { appType: 'APP_SYN01', formUuid: 'FORM-SYN-01' },
      businessKey: ['projectNo', 'componentCode', 'componentName', 'specification', 'material', 'version', 'parentCode'], emptyKeyFields: ['parentCode'] })
    expect(body.draft.allocation).toEqual({ mode: 'original' })
    // The rule draft was archived automatically: rules only, no target or credential.
    expect(download).toHaveBeenCalledTimes(1)
    const archive = q<HTMLTextAreaElement>('rule-archive-text').value
    expect(parseYidaRuleTemplate(archive).rules).toMatchObject({ version: 2, intent: 'create' })
    for (const leaked of ['APP_SYN01', 'FORM-SYN-01', 'SYN-KEY', 'SYN-SECRET', 'SYN-SYSTEM-TOKEN']) expect(archive).not.toContain(leaked)
    expect(q('archived').textContent).toContain('yida-rule-draft-FORM-SYN-01-')
    expect(q('initialized').textContent).toContain('canSend=false')
    expect(q('step-4').textContent).toContain('已完成')
    // Inputs no longer hold the credentials.
    for (const key of ['organization', ...Object.keys(secrets)]) expect(q<HTMLInputElement>(key).value).toBe('')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('an edit after the preview drops it (no save from a stale preview); credentials typed first are kept', async () => {
    await mount(); await fillStep1(); await testOk()
    const options = q<HTMLTextAreaElement>('map-options-8'); options.value = 'normal\nrush'; options.dispatchEvent(new Event('input')); await flush()
    await click('run'); expect(q('step-3').textContent).toContain('已完成')
    await choose('map-target-0', '')
    expect(absent('result')).toBe(true)
    expect(q('step-3').textContent).not.toContain('已完成')
    // jsdom strips the line break from a password box's value; the typed text itself is kept.
    expect(q<HTMLInputElement>('appKey').value).toBe('SYN-KEY')
  })

  it('a changed appKey after an ok test blocks saving until a re-test or the owner override', async () => {
    await mount(); await fillStep1(); await testOk()
    const options = q<HTMLTextAreaElement>('map-options-8'); options.value = 'normal\nrush'; options.dispatchEvent(new Event('input')); await flush()
    await click('run'); await type('review', 'SYN-REVIEW'); await check('ack')
    await type('appKey', 'SYN-KEY-2')
    expect(q('connection-mismatch')).toBeTruthy()
    expect(q<HTMLButtonElement>('save-submit').disabled).toBe(true)
    await check('connection-override')
    expect(q<HTMLButtonElement>('save-submit').disabled).toBe(false)
  })

  it('a lost save reply is never re-POSTed: the page re-reads the status until it is known', async () => {
    vi.useFakeTimers()
    await mount(); await fillStep1(); await testOk()
    const options = q<HTMLTextAreaElement>('map-options-8'); options.value = 'normal\nrush'; options.dispatchEvent(new Event('input')); await flush()
    await click('run'); await type('review', 'SYN-REVIEW'); await check('ack')
    fetchSpy.mockRejectedValueOnce(new TypeError('synthetic network loss'))
    fetchSpy.mockResolvedValueOnce(failure('YIDA_INITIALIZATION_UNAVAILABLE'))
    await click('save-submit'); await flush()
    expect(q('status').textContent).toContain('未确认')
    expect(q<HTMLButtonElement>('save-submit').disabled).toBe(true)
    fetchSpy.mockResolvedValueOnce(json(initialized(), 200))
    await vi.advanceTimersByTimeAsync(2000); await flush()
    expect(q('initialized')).toBeTruthy()
    expect(fetchSpy.mock.calls.filter(call => call[1].method === 'POST' && call[0] === endpoint)).toHaveLength(1)
  })

  it('an initialized slot permits a fresh local preview without reopening credentials or saving again', async () => {
    await mount(json(initialized({ send: true })))
    expect(q('initialized')).toBeTruthy()
    for (const key of ['organization', ...Object.keys(secrets)]) expect(q<HTMLInputElement>(key).disabled).toBe(true)
    expect(q<HTMLButtonElement>('connection-test').disabled).toBe(true)
    expect(absent('save')).toBe(true)
    expect(q<HTMLButtonElement>('owner-open').disabled).toBe(true)
    await type('app-type', 'APP_SYN01'); await type('form-uuid', 'FORM-SYN-01')
    for (const index of STOCK_PREP_YIDA_SOURCE_FIELDS.keys()) await type(`map-target-${index}`, `manual-${index}`)
    await click('run')
    expect(q('summary').textContent).toContain('计划创建 2')
    expect(q<HTMLButtonElement>('owner-open').disabled).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a DENIED test clears every private input and closes the session', async () => {
    await mount(); await fillStep1()
    fetchSpy.mockResolvedValueOnce(failure('YIDA_CONNECTION_TEST_DENIED', 403)); await click('connection-test')
    for (const key of ['organization', ...Object.keys(secrets)]) expect(q<HTMLInputElement>(key).value).toBe('')
    expect(q('status').textContent).toContain('不是宜搭锚点 owner')
  })

  it('never writes typed credentials to browser storage or the console', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem'), log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn')
    await mount(); await fillStep1(); await testOk()
    for (const spy of [set, log, warn]) {
      for (const call of spy.mock.calls) for (const value of Object.values(secrets)) expect(JSON.stringify(call)).not.toContain(value)
    }
  })
})

describe('宜搭表单配置 — mapping rules (pure)', () => {
  it('auto-matches only unambiguous labels with a compatible control', () => {
    const rows = defaultMappingRows([
      { fieldId: 'a', label: '项目号', componentName: 'TextField', parentId: null },
      { fieldId: 'b', label: '项目号', componentName: 'TextField', parentId: null },
      { fieldId: 'c', label: '数量', componentName: 'TextField', parentId: null },
      { fieldId: 'd', label: '名称', componentName: 'TextField', parentId: 'tableField_x' },
    ])
    expect(rows.find(row => row.source === 'projectNo')?.target).toBe('')
    expect(rows.find(row => row.source === 'quantity')?.target).toBe('')
    expect(rows.find(row => row.source === 'componentName')?.target).toBe('')
  })
  it('requires the seven identity fields and quantity, refuses duplicates and number/text mismatches', () => {
    const rows = defaultMappingRows([])
    const empty = buildYidaSetupConfig({ appType: 'APP_A', formUuid: 'FORM-A', rows })
    expect(empty.ok).toBe(false)
    const filled = STOCK_PREP_YIDA_SOURCE_FIELDS.map((field, index) => ({ source: field.source, target: `f_${index}`,
      control: field.type === 'number' ? 'number' as const : 'text' as const, optionsText: '', yidaRequired: field.required }))
    const built = buildYidaSetupConfig({ appType: 'APP_A', formUuid: 'FORM-A', rows: filled })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.config.businessKey).toHaveLength(7)
    expect(buildYidaSetupConfig({ appType: 'APP_A', formUuid: 'FORM-A', rows: [...filled, { ...filled[0], target: 'f_x' }] }).ok).toBe(false)
    expect(buildYidaSetupConfig({ appType: 'APP_A', formUuid: 'FORM-A', rows: filled.map((row, index) => index === 7 ? { ...row, control: 'text' as const } : row) }).ok).toBe(false)
    expect(buildYidaSetupConfig({ appType: 'APP/A', formUuid: 'FORM-A', rows: filled }).ok).toBe(false)
    // A required YiDa parent field is no longer an empty-key field.
    const strictParent = buildYidaSetupConfig({ appType: 'APP_A', formUuid: 'FORM-A', rows: filled.map(row => row.source === 'parentCode' ? { ...row, yidaRequired: true } : row) })
    expect(strictParent.ok && strictParent.config.emptyKeyFields).toEqual([])
  })
})
