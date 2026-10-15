import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import StockPreparationYidaPreviewPanel from '../src/components/integration/stockPreparation/StockPreparationYidaPreviewPanel.vue'
import type { YidaRuleTemplateEnvelope } from '../../../plugins/plugin-integration-core/lib/yida-rule-template.mjs'

describe('StockPreparationYidaPreviewPanel', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  const fetchSpy = vi.fn()
  const xhrSpy = vi.fn()
  const beaconSpy = vi.fn()
  const socketSpy = vi.fn()
  const indexedDbOpenSpy = vi.fn()
  const indexedDbDeleteSpy = vi.fn()
  const clipboardReadSpy = vi.fn()
  const clipboardWriteSpy = vi.fn()
  const fileReaderSpy = vi.fn()
  let anchorClickSpy: MockInstance<[], void>
  let storageGetSpy: MockInstance<[key: string], string | null>
  let storageSetSpy: MockInstance<[key: string, value: string], void>
  let storageRemoveSpy: MockInstance<[key: string], void>
  let storageClearSpy: MockInstance<[], void>
  beforeEach(() => {
    fetchSpy.mockReset(); xhrSpy.mockReset(); beaconSpy.mockReset(); socketSpy.mockReset()
    indexedDbOpenSpy.mockReset(); indexedDbDeleteSpy.mockReset()
    clipboardReadSpy.mockReset(); clipboardWriteSpy.mockReset(); fileReaderSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy); vi.stubGlobal('XMLHttpRequest', xhrSpy); vi.stubGlobal('WebSocket', socketSpy)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beaconSpy, clipboard: { readText: clipboardReadSpy, writeText: clipboardWriteSpy } })
    vi.stubGlobal('FileReader', fileReaderSpy)
    vi.stubGlobal('indexedDB', { open: indexedDbOpenSpy, deleteDatabase: indexedDbDeleteSpy })
    storageGetSpy = vi.spyOn(Storage.prototype, 'getItem')
    storageSetSpy = vi.spyOn(Storage.prototype, 'setItem')
    storageRemoveSpy = vi.spyOn(Storage.prototype, 'removeItem')
    storageClearSpy = vi.spyOn(Storage.prototype, 'clear')
    anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    root = document.createElement('div'); document.body.appendChild(root); app = createApp(StockPreparationYidaPreviewPanel); app.mount(root)
  })
  afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
  async function flush(): Promise<void> { await nextTick(); await Promise.resolve(); await nextTick() }
  function q<T extends HTMLElement = HTMLElement>(testid: string): T { const node = root?.querySelector<T>(`[data-testid="${testid}"]`); if (!node) throw new Error(`missing ${testid}`); return node }
  function edit(testid: string, value: string): void { const node = q<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(testid); node.value = value; node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input')) }
  async function example(kind: 'primary' | 'renamed'): Promise<void> { q<HTMLButtonElement>(`sp-yida-example-${kind}`).click(); await flush() }
  async function preview(): Promise<void> { q<HTMLButtonElement>('sp-yida-run').click(); await flush() }
  function rows(): Array<Record<string, unknown>> { return JSON.parse(q<HTMLTextAreaElement>('sp-yida-rows').value) as Array<Record<string, unknown>> }
  function payloads(): Array<Record<string, unknown>> { return Array.from(root?.querySelectorAll('pre[data-testid^="sp-yida-payload-"]') ?? []).map((node) => JSON.parse(node.textContent ?? '') as Record<string, unknown>) }
  function protocolData(): Array<Record<string, unknown>> { return Array.from(root?.querySelectorAll('pre[data-testid^="sp-yida-protocol-data-"]') ?? []).map((node) => JSON.parse(node.textContent ?? '') as Record<string, unknown>) }
  function check(testid: string, value: boolean): void { const node = q<HTMLInputElement>(testid); node.checked = value; node.dispatchEvent(new Event('change')) }
  async function protocolExample(kind: 'primary' | 'renamed' = 'primary'): Promise<void> { edit('sp-yida-preview-mode', 'protocol'); await flush(); q<HTMLButtonElement>(`sp-yida-protocol-example-${kind}`).click(); await flush() }
  async function setAllocation(mode: 'equal_integer' | 'equal_decimal_exact', projects = 'SYN-PROJECT-01\nSYN-PROJECT-02'): Promise<void> { edit('sp-yida-allocation-mode', mode); await flush(); edit('sp-yida-allocation-projects', projects); edit('sp-yida-allocation-project-field', 'projectNo'); edit('sp-yida-allocation-quantity-field', 'quantity') }
  async function exportRules(): Promise<string> { q<HTMLButtonElement>('sp-yida-rule-export').click(); await flush(); return q<HTMLTextAreaElement>('sp-yida-rule-export-text').value }
  async function importRules(text: string): Promise<void> { edit('sp-yida-rule-import-text', text); await flush(); q<HTMLButtonElement>('sp-yida-rule-import').click(); await flush() }
  async function remount(): Promise<void> { app?.unmount(); app = createApp(StockPreparationYidaPreviewPanel); app.mount(root!); await flush() }
  function editorValues(): Array<{ id: string; value: string; checked: boolean | undefined }> {
    return Array.from(root!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select'))
      .filter((node) => !node.dataset.testid?.startsWith('sp-yida-rule-'))
      .map((node) => ({ id: node.dataset.testid ?? '', value: node.value, checked: node instanceof HTMLInputElement ? node.checked : undefined }))
  }
  function expectNoIo(): void {
    for (const spy of [fetchSpy, xhrSpy, beaconSpy, socketSpy, storageGetSpy, storageSetSpy, storageRemoveSpy, storageClearSpy,
      indexedDbOpenSpy, indexedDbDeleteSpy, clipboardReadSpy, clipboardWriteSpy, fileReaderSpy, anchorClickSpy]) expect(spy).not.toHaveBeenCalled()
    expect(root?.querySelector('input[type="file"],a[download]')).toBeNull()
  }

  it('field diagnostics distinguish repeated mapping failures, aggregate missing keys and expire on input edits without I/O', async () => {
    await example('primary')
    // A rejected mapped value can also be in the legacy local business key.
    check('sp-yida-map-key-3', true)
    const input = rows()
    delete input[0].projectNo; delete input[0].sourceRowId; delete input[0].componentCode; delete input[0].active
    input[1].componentCode = 17; input[1].quantity = '<img src=x onerror=syntheticRejected()>'; input[1].active = 'synthetic-private-rejected'
    edit('sp-yida-rows', JSON.stringify(input)); await preview()
    const missing = q('sp-yida-result-row-0').textContent ?? ''
    expect(missing).toContain('KEY_MISSING（业务键缺失）')
    expect(missing.match(/KEY_MISSING/g)).toHaveLength(1)
    for (const field of ['projectNo → project', 'sourceRowId → line', 'componentCode → component', 'active → enabled']) expect(missing).toContain(field)
    expect(missing.match(/FIELD_REQUIRED/g)).toHaveLength(2)
    expect(q('sp-yida-row-issue-0-1').textContent).toBe('FIELD_REQUIRED（必填字段缺失）；componentCode → component（期望文本）')
    expect(q('sp-yida-row-issue-0-2').textContent).toBe('FIELD_REQUIRED（必填字段缺失）；active → enabled（期望布尔值）')
    const typed = q('sp-yida-result-row-1').textContent ?? ''
    expect(typed.match(/FIELD_TYPE/g)).toHaveLength(3)
    for (const field of ['componentCode → component（期望文本）', 'quantity → qty（期望数字）', 'active → enabled（期望布尔值）']) expect(typed).toContain(field)
    expect(q('sp-yida-row-issue-1-0').textContent).toBe('FIELD_TYPE（字段类型不符）；componentCode → component（期望文本）')
    expect(q('sp-yida-row-issue-1-1').textContent).toBe('FIELD_TYPE（字段类型不符）；quantity → qty（期望数字）')
    expect(q('sp-yida-row-issue-1-2').textContent).toBe('FIELD_TYPE（字段类型不符）；active → enabled（期望布尔值）')
    expect(typed).toContain('字段类型不符')
    expect(q('sp-yida-result').textContent).not.toMatch(/synthetic-private|<img|onerror/)
    expect(root?.querySelector('img,[onerror]')).toBeNull()
    expect(payloads()).toEqual([]); expect(protocolData()).toEqual([])
    expect(q('sp-yida-summary').textContent).toContain('无效 2')
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    edit('sp-yida-map-target-3', 'newQty'); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    await example('primary'); await preview()
    expect(payloads()[1]).toMatchObject({ qty: 0, enabled: false })
    expect(q('sp-yida-result').textContent).not.toContain('FIELD_TYPE')
    expectNoIo()
  })

  it('field diagnostics locate repeated v2 required and type failures in ordinary previews without rejected values', async () => {
    await protocolExample('renamed')
    check('sp-yida-map-required-8', true); check('sp-yida-catalog-required-8', true)
    const input = rows()
    delete input[0]['项目号']; delete input[0]['物料名称']; delete input[0]['件数']; delete input[0]['优先级']
    input[1]['件数'] = '<img src=x onerror=syntheticRejected()>'; input[1]['优先级'] = 123
    edit('sp-yida-rows', JSON.stringify(input)); await preview()
    expect(q('sp-yida-row-issue-0-0').textContent).toBe('KEY_MISSING（业务键缺失）；项目号 → project（期望文本）；物料名称 → componentName（期望文本）')
    expect(q('sp-yida-row-issue-0-1').textContent).toBe('FIELD_REQUIRED（必填字段缺失）；件数 → qty（期望数字）')
    expect(q('sp-yida-row-issue-0-2').textContent).toBe('FIELD_REQUIRED（必填字段缺失）；优先级 → priority（期望文本）')
    expect(q('sp-yida-row-issue-1-0').textContent).toBe('FIELD_TYPE（字段类型不符）；件数 → qty（期望数字）')
    expect(q('sp-yida-row-issue-1-1').textContent).toBe('FIELD_TYPE（字段类型不符）；优先级 → priority（期望文本）')
    expect(q('sp-yida-result').textContent).not.toMatch(/<img|onerror|123/)
    expect(root?.querySelector('img,[onerror]')).toBeNull()
    expect(payloads()).toEqual([]); expect(protocolData()).toEqual([])
    expect(q('sp-yida-summary').textContent).toContain('无效 2')
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    expectNoIo()
  })

  it('field diagnostics bind v2 allocation candidates to their actual planner columns without exposing rejected options', async () => {
    await protocolExample()
    q<HTMLButtonElement>('sp-yida-catalog-add').click(); q<HTMLButtonElement>('sp-yida-map-add').click(); await flush()
    edit('sp-yida-catalog-id-9', 'note'); edit('sp-yida-map-source-9', 'sourceNote'); edit('sp-yida-map-target-9', 'note'); check('sp-yida-map-required-9', true)
    const input = rows(); input[0].quantity = 6; input[1].quantity = 0
    input[1].priority = '<img src=x onerror=syntheticRejected()>'
    edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_integer'); await preview()
    for (const [index, project] of [[2, 'SYN-PROJECT-01'], [3, 'SYN-PROJECT-02']] as const) {
      const diagnostic = q(`sp-yida-allocation-candidate-${index}`).textContent ?? ''
      expect(diagnostic).toContain(`源行 2；项目 ${project}`)
      expect(diagnostic).toContain('FIELD_OPTION_INVALID（选项不符，须使用配置的合法选项）')
      expect(diagnostic).toContain('priority → priority（期望文本）')
      expect(diagnostic).toContain('FIELD_REQUIRED（必填字段缺失）')
      expect(diagnostic).toContain('sourceNote → note（期望文本）')
      expect(q(`sp-yida-result-row-${index}`).textContent).toContain('priority → priority')
      expect(q(`sp-yida-row-issue-${index}-0`).textContent).toBe('FIELD_OPTION_INVALID（选项不符，须使用配置的合法选项）；priority → priority（期望文本）')
      expect(diagnostic).not.toMatch(/<img|onerror|normal|rush/)
    }
    expect(q('sp-yida-result').textContent).not.toMatch(/<img|onerror/)
    expect(root?.querySelector('img,[onerror]')).toBeNull()
    expect(payloads()).toEqual([]); expect(protocolData()).toEqual([])
    expect(q('sp-yida-allocation-evidence').textContent).toContain('无效来源 2')
    expect(q('sp-yida-summary').textContent).toContain('无效 4')
    edit('sp-yida-rows', JSON.stringify(input.map(row => ({ ...row, priority: 'normal', sourceNote: 'SYN-NOTE' })))); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
    await preview(); expect(payloads()).toHaveLength(4); expect(protocolData()).toHaveLength(4)
    expect(payloads().map(row => row.qty)).toEqual([3, 3, 0, 0])
    expect(q('sp-yida-result').textContent).not.toContain('FIELD_OPTION_INVALID')
    expectNoIo()
  })

  it('field diagnostics hide rejected allocation project values in both labels and keep valid projects when another field fails', async () => {
    await protocolExample()
    edit('sp-yida-catalog-control-0', 'select'); await flush()
    edit('sp-yida-catalog-options-0', 'SYN-ALLOWED')
    await setAllocation('equal_integer', 'SYN-REJECTED'); await preview()
    expect(q('sp-yida-summary').textContent).toContain('无效 2')
    for (const index of [0, 1]) {
      const candidate = q(`sp-yida-allocation-candidate-${index}`).textContent ?? ''
      const row = q(`sp-yida-result-row-${index}`).textContent ?? ''
      expect(candidate.includes('SYN-REJECTED')).toBe(false)
      expect(row.includes('SYN-REJECTED')).toBe(false)
      expect(candidate).toContain('项目字段未通过校验')
      expect(row).toContain(`源行 ${index + 1}；项目字段未通过校验`)
      expect(q(`sp-yida-row-issue-${index}-0`).textContent).toBe('FIELD_OPTION_INVALID（选项不符，须使用配置的合法选项）；projectNo → project（期望文本）')
    }
    expect(payloads()).toEqual([]); expect(protocolData()).toEqual([])
    const input = rows(); input[1].priority = 'synthetic-private-rejected-option'
    edit('sp-yida-rows', JSON.stringify(input)); edit('sp-yida-catalog-options-0', 'SYN-REJECTED'); await preview()
    expect(q('sp-yida-summary').textContent).toContain('计划创建 1')
    expect(q('sp-yida-summary').textContent).toContain('无效 1')
    for (const index of [0, 1]) {
      expect(q(`sp-yida-allocation-candidate-${index}`).textContent).toContain('项目 SYN-REJECTED')
      expect(q(`sp-yida-result-row-${index}`).textContent).toContain(`源行 ${index + 1}；项目 SYN-REJECTED`)
      expect(q(`sp-yida-allocation-candidate-${index}`).textContent).not.toContain('项目字段未通过校验')
    }
    expect(q('sp-yida-result').textContent).not.toContain('synthetic-private-rejected-option')
    expect(payloads()).toHaveLength(1); expect(protocolData()).toHaveLength(1)
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    expectNoIo()
  })

  it('retains the original per-form mode by default and clears allocation output when examples load', async () => {
    await example('primary')
    expect(q<HTMLSelectElement>('sp-yida-allocation-mode').value).toBe('original')
    await preview()
    expect(payloads()).toHaveLength(2)
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
    await example('renamed')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(q<HTMLSelectElement>('sp-yida-allocation-mode').value).toBe('original')
  })

  it('uses real integer allocation, keeps zero, and renders its analysis and candidate payloads', async () => {
    await example('primary')
    const input = rows(); input[0].quantity = 6; input[1].quantity = 0
    edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_integer'); await preview()
    expect(q('sp-yida-allocation-evidence').textContent).toContain('展开 4')
    expect(q('sp-yida-allocation-analysis-0').textContent).toContain('每项目 3')
    expect(q('sp-yida-allocation-analysis-1').textContent).toContain('每项目 0')
    expect(payloads().map((payload) => payload.qty)).toEqual([3, 3, 0, 0])
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
  })

  it.each([
    { version: 1, defect: 'required', code: 'FIELD_REQUIRED' },
    { version: 1, defect: 'type', code: 'FIELD_TYPE' },
    { version: 2, defect: 'required', code: 'FIELD_REQUIRED' },
    { version: 2, defect: 'type', code: 'FIELD_TYPE' },
    { version: 2, defect: 'option', code: 'FIELD_OPTION_INVALID' },
  ])('maps v$version $defect candidate failures to the second original source and project while preserving the first source', async ({ version, defect, code }) => {
    if (version === 1) await example('primary')
    else {
      await protocolExample()
      check('sp-yida-map-required-8', true)
      check('sp-yida-catalog-required-8', true)
    }
    const input = rows(); input[0].quantity = 6; input[1].quantity = 0
    if (version === 1 && defect === 'required') delete input[1].componentCode
    if (version === 1 && defect === 'type') input[1].active = 'synthetic-private-rejected-type'
    if (version === 2 && defect === 'required') delete input[1].priority
    if (version === 2 && defect === 'type') input[1].priority = 123
    if (version === 2 && defect === 'option') input[1].priority = 'synthetic-private-rejected-option'
    edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_integer'); await preview()
    expect(q('sp-yida-allocation-evidence').textContent).toContain('来源行 2')
    expect(q('sp-yida-allocation-evidence').textContent).toContain('展开 4')
    expect(q('sp-yida-allocation-evidence').textContent).toContain('无效来源 1')
    expect(q('sp-yida-summary').textContent).toContain('计划创建 2')
    expect(q('sp-yida-summary').textContent).toContain('无效 2')
    expect(q('sp-yida-allocation-analysis-1').textContent).toContain('原总量 0')
    expect(q('sp-yida-allocation-analysis-1').textContent).toContain('分配合计 0；差额 0')
    expect(q('sp-yida-allocation-analysis-0').textContent).not.toContain('拒因')
    for (const [index, project] of [[2, 'SYN-PROJECT-01'], [3, 'SYN-PROJECT-02']] as const) {
      const diagnostic = q(`sp-yida-allocation-candidate-${index}`).textContent
      expect(diagnostic).toContain('源行 2')
      expect(diagnostic).toContain(`项目 ${project}`)
      expect(diagnostic).toContain(code)
      expect(diagnostic).not.toContain('synthetic-private-rejected')
      expect(q(`sp-yida-result-row-${index}`).textContent).toContain(`源行 2；项目 ${project}`)
      expect(root?.querySelector(`[data-testid="sp-yida-payload-${index}"]`)).toBeNull()
      expect(root?.querySelector(`[data-testid="sp-yida-protocol-data-${index}"]`)).toBeNull()
    }
    expect(q('sp-yida-result-row-0').textContent).toContain('源行 1；项目 SYN-PROJECT-01')
    expect(payloads().map((payload) => [payload.project, payload.qty])).toEqual([
      ['SYN-PROJECT-01', 3], ['SYN-PROJECT-02', 3],
    ])
    if (version === 2) expect(protocolData().map((dto) => JSON.parse(String(dto.formDataJson)).qty)).toEqual([3, 3])
    else expect(protocolData()).toEqual([])
    expect(root?.querySelector('[data-testid="sp-yida-allocation-issues"]')).toBeNull()
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    expectNoIo()
  })

  it.each([1, 2])('counts both v%s duplicate source origins once and displays source-major project membership from the real planner', async (version) => {
    if (version === 1) await example('primary'); else await protocolExample()
    const first = rows()[0]
    edit('sp-yida-rows', JSON.stringify([{ ...first, quantity: 6 }, { ...first, quantity: 0 }]))
    await setAllocation('equal_integer'); await preview()
    expect(q('sp-yida-allocation-evidence').textContent).toContain('无效来源 2')
    expect(q('sp-yida-summary').textContent).toContain('本地重复键 4')
    for (const [index, source, project] of [
      [0, 1, 'SYN-PROJECT-01'], [1, 1, 'SYN-PROJECT-02'],
      [2, 2, 'SYN-PROJECT-01'], [3, 2, 'SYN-PROJECT-02'],
    ] as const) {
      const diagnostic = q(`sp-yida-allocation-candidate-${index}`).textContent
      expect(diagnostic).toContain(`源行 ${source}；项目 ${project}`)
      expect(diagnostic).toContain('DUPLICATE_LOCAL_KEY（本地业务键重复）')
      expect(q(`sp-yida-result-row-${index}`).textContent).toContain(`源行 ${source}；项目 ${project}`)
    }
    expect(q('sp-yida-allocation-analysis-0').textContent).toContain('分配合计 6；差额 0')
    expect(q('sp-yida-allocation-analysis-1').textContent).toContain('分配合计 0；差额 0')
    expect(payloads()).toEqual([])
    expect(protocolData()).toEqual([])
    expect(root?.querySelector('[data-testid="sp-yida-allocation-issues"]')).toBeNull()
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    expectNoIo()
  })

  it('uses real exact-decimal allocation without rounding and refuses one-third', async () => {
    await example('primary')
    const input = rows(); input[0].quantity = 5; edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_decimal_exact'); await preview()
    expect(q('sp-yida-allocation-analysis-0').textContent).toContain('每项目 2.5')
    expect(payloads().map((payload) => payload.qty)).toEqual([2.5, 2.5, 0, 0])
    input[0].quantity = 1; edit('sp-yida-rows', JSON.stringify(input)); edit('sp-yida-allocation-projects', 'SYN-PROJECT-01\nSYN-PROJECT-02\nSYN-PROJECT-03'); await preview()
    expect(q('sp-yida-allocation-issues').textContent).toContain('QUANTITY_NOT_DIVISIBLE')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(q('sp-yida-allocation-evidence').textContent).toContain('无效来源 1')
    expect(root?.querySelector('[data-testid^="sp-yida-allocation-candidate-"]')).toBeNull()
    expect(q('sp-yida-allocation-analysis-1').textContent).toContain('差额 0')
    expectNoIo()
  })

  it('shows integer non-divisibility and duplicate project rejection', async () => {
    await example('primary')
    const input = rows(); input[0].quantity = 5; edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_integer'); await preview()
    expect(q('sp-yida-allocation-issues').textContent).toContain('QUANTITY_NOT_DIVISIBLE')
    edit('sp-yida-allocation-projects', 'SYN-PROJECT-01\nSYN-PROJECT-01'); await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_ALLOCATION_PROJECTS_INVALID')
  })

  it('produces identical candidate payloads for fully renamed layouts', async () => {
    await example('primary')
    const primaryRows = rows(); primaryRows[0].quantity = 4; edit('sp-yida-rows', JSON.stringify(primaryRows)); await setAllocation('equal_integer'); await preview()
    const primary = payloads()
    await example('renamed')
    const renamedRows = rows(); renamedRows[0]['件数'] = 4; edit('sp-yida-rows', JSON.stringify(renamedRows)); edit('sp-yida-allocation-mode', 'equal_integer'); await flush(); edit('sp-yida-allocation-projects', 'SYN-PROJECT-01\nSYN-PROJECT-02'); edit('sp-yida-allocation-project-field', '项目号'); edit('sp-yida-allocation-quantity-field', '件数'); await preview()
    expect(payloads()).toEqual(primary)
    expect(q('sp-yida-allocation-analysis-0').textContent).toContain('每项目 2')
  })

  it('shows output cap and roles rejection from the core', async () => {
    await example('primary')
    const input = Array.from({ length: 6 }, (_, index) => ({ ...rows()[0], sourceRowId: `LINE-${index}`, quantity: 2 }))
    edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_integer', Array.from({ length: 20 }, (_, index) => `SYN-PROJECT-${index}`).join('\n')); await preview()
    expect(q('sp-yida-allocation-issues').textContent).toContain('EXPANDED_ROWS_LIMIT')
    edit('sp-yida-allocation-project-field', 'componentCode'); await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_ALLOCATION_FIELDS_INVALID')
  })

  it('rejects raw precision loss and project control characters without trimming them away', async () => {
    await example('primary'); await setAllocation('equal_integer')
    const row = rows()[0]
    const raw = JSON.stringify({ ...row, quantity: 6 }).replace('"quantity":6', '"quantity":6.00000000000000001')
    expect(raw).toContain('6.00000000000000001')
    edit('sp-yida-rows', raw.startsWith('[') ? raw : `[${raw}]`); await preview()
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(root?.textContent).toMatch(/QUANTITY_|YIDA_ALLOCATION_/)
    edit('sp-yida-rows', JSON.stringify([{ ...row, quantity: 6 }]))
    edit('sp-yida-allocation-projects', 'SYN-PROJECT-01\nSYN-PROJECT-02\t'); await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_ALLOCATION_PROJECTS_INVALID')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
  })

  it('clears both successful outputs for every configuration group', async () => {
    const edits = [
      ['sp-yida-app-type', 'changed-app'], ['sp-yida-form-uuid', 'changed-form'],
      ['sp-yida-allocation-mode', 'equal_decimal_exact'], ['sp-yida-allocation-projects', 'NEW-PROJECT'],
      ['sp-yida-allocation-project-field', 'componentCode'], ['sp-yida-allocation-quantity-field', 'componentCode'],
      ['sp-yida-map-target-0', 'changed-target'], ['sp-yida-rows', '[]'], ['sp-yida-intent', 'update'],
    ]
    for (const [field, value] of edits) {
      await example('primary'); await setAllocation('equal_integer'); expect(await exportRules()).not.toBe(''); await preview()
      expect(q('sp-yida-result').textContent).toContain('计划创建')
      expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).not.toBeNull()
      edit(field, value); await flush()
      expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
      expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
      expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').value).toBe('')
    }
  })

  it('blocks update fan-out and opens no transport after a real click', async () => {
    await example('primary'); await setAllocation('equal_integer'); await preview()
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).not.toBeNull()
    edit('sp-yida-allocation-projects', 'SYN-PROJECT-01\nSYN-PROJECT-03'); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    edit('sp-yida-intent', 'update'); await flush(); edit('sp-yida-instance-id-field', 'instanceId'); expect(q('sp-yida-allocation-update-blocked').textContent).toContain('禁止更新扇出'); await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_ALLOCATION_INTENT_INVALID')
    await example('primary'); await setAllocation('equal_integer'); await preview(); expect(q('sp-yida-result').textContent).toContain('计划创建')
    expect(fetchSpy).not.toHaveBeenCalled(); expect(xhrSpy).not.toHaveBeenCalled(); expect(beaconSpy).not.toHaveBeenCalled(); expect(socketSpy).not.toHaveBeenCalled()
  })

  it('keeps v1 default and requires an explicitly supplied catalog when switching to v2', async () => {
    expect(q<HTMLSelectElement>('sp-yida-preview-mode').value).toBe('mapping')
    expect(root?.querySelector('[data-testid="sp-yida-catalog"]')).toBeNull()
    await example('primary'); await preview()
    expect(protocolData()).toEqual([])
    edit('sp-yida-preview-mode', 'protocol'); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(root?.querySelectorAll('[data-testid^="sp-yida-catalog-row-"]')).toHaveLength(0)
    await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_STATIC_CONFIG_INVALID')
    expect(protocolData()).toEqual([])
  })

  it('renders seven-field identity and exact data-only create DTOs, preserving numeric zero', async () => {
    await protocolExample(); await preview()
    const expected = {
      project: 'DEMO-P1', componentCode: 'DEMO-PART-A', componentName: '示例物料', specification: 'SPEC-1',
      material: 'MAT-1', version: 'V1', qty: 0, priority: 'normal',
    }
    expect(payloads()).toEqual([expected, { ...expected, parentCode: 'PARENT-1', qty: 3, priority: 'rush' }])
    const dtos = protocolData()
    expect(dtos).toHaveLength(2)
    expect(dtos[0]).toEqual({ appType: 'synthetic_stock_app', formUuid: 'synthetic_stock_form', formDataJson: JSON.stringify(expected) })
    expect(Object.keys(dtos[0]).sort()).toEqual(['appType', 'formDataJson', 'formUuid'])
    expect(JSON.parse(String(dtos[0].formDataJson)).qty).toBe(0)
    expect(q('sp-yida-protocol-0').textContent).toContain('dingtalk-yida-1.0-data-only')
    expect(q('sp-yida-protocol-0').textContent).toContain('data_fields_only')
    expect(q('sp-yida-protocol-warning').textContent).toContain('不含认证、令牌或执行用户')
    expect(q('sp-yida-protocol-warning').textContent).toContain('不证明远端幂等')
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    expect(Array.from(root!.querySelectorAll<HTMLInputElement>('[data-testid^="sp-yida-map-key-"]')).filter((node) => node.checked)).toHaveLength(7)
  })

  it('gives the same payload, identity and protocol for a fully renamed source layout', async () => {
    await protocolExample(); await preview()
    const expectedPayloads = payloads()
    const expectedProtocol = protocolData()
    const keyText = q('sp-yida-result-row-0').querySelector('span')?.textContent
    await protocolExample('renamed'); await preview()
    expect(payloads()).toEqual(expectedPayloads)
    expect(protocolData()).toEqual(expectedProtocol)
    expect(q('sp-yida-result-row-0').querySelector('span')?.textContent).toEqual(keyText)
    expect(q<HTMLInputElement>('sp-yida-map-source-0').value).toBe('项目号')
    expect(q<HTMLInputElement>('sp-yida-map-source-6').value).toBe('父图号')
  })

  it('includes each of seven components in duplicate identity', async () => {
    await protocolExample()
    const first = rows()[0]
    for (const field of ['projectNo', 'componentCode', 'componentName', 'specification', 'material', 'version', 'parentCode']) {
      edit('sp-yida-rows', JSON.stringify([first, { ...first, [field]: 'SYNTHETIC-DISTINCT' }]))
      await preview()
      expect(q('sp-yida-summary').textContent, field).toContain('计划创建 2')
      expect(protocolData(), field).toHaveLength(2)
    }
  })

  it.each(['empty', 'missing'] as const)('treats opted-in parent null and %s as the same identity without emitting empty fields', async (kind) => {
    await protocolExample()
    const first = rows()[0]
    edit('sp-yida-rows', JSON.stringify([first])); await preview()
    expect(payloads()[0]).not.toHaveProperty('parentCode')
    expect(JSON.parse(String(protocolData()[0].formDataJson))).not.toHaveProperty('parentCode')
    const duplicate = { ...first, parentCode: '' } as Record<string, unknown>
    if (kind === 'missing') delete duplicate.parentCode
    edit('sp-yida-rows', JSON.stringify([first, duplicate])); await preview()
    expect(q('sp-yida-summary').textContent).toContain('本地重复键 2')
    expect(payloads()).toEqual([])
    expect(protocolData()).toEqual([])
    expect(q('sp-yida-result-row-0').textContent).toContain('DUPLICATE_LOCAL_KEY')
    check('sp-yida-map-empty-key-6', false); await preview()
    expect(q('sp-yida-result-row-0').textContent).toContain('KEY_MISSING')
    expect(protocolData()).toEqual([])
  })

  it('rejects whitespace-only parent keys and does not trim distinct nonempty keys into duplicates', async () => {
    await protocolExample()
    const first = rows()[0]
    edit('sp-yida-rows', JSON.stringify([{ ...first, parentCode: '   ' }]))
    await preview()
    expect(q('sp-yida-result-row-0').textContent).toContain('KEY_MISSING')
    expect(protocolData()).toEqual([])
    edit('sp-yida-rows', JSON.stringify([{ ...first, parentCode: 'PARENT' }, { ...first, parentCode: 'PARENT ' }]))
    await preview()
    expect(q('sp-yida-summary').textContent).toContain('计划创建 2')
    expect(payloads().map((row) => row.parentCode)).toEqual(['PARENT', 'PARENT '])
  })

  it('requires explicit local instance ids and renders only update data fields', async () => {
    await protocolExample()
    edit('sp-yida-intent', 'update'); await flush(); edit('sp-yida-instance-id-field', 'instanceId')
    await preview()
    expect(q('sp-yida-result-row-0').textContent).toContain('INSTANCE_ID_MISSING')
    expect(protocolData()).toEqual([])
    const input = rows().map((row, index) => ({ ...row, instanceId: `SYN-INSTANCE-${index}` }))
    edit('sp-yida-rows', JSON.stringify(input)); await preview()
    expect(q('sp-yida-summary').textContent).toContain('计划更新 2')
    const dtos = protocolData()
    expect(dtos).toHaveLength(2)
    expect(dtos[0]).toEqual({ appType: 'synthetic_stock_app', formInstanceId: 'SYN-INSTANCE-0', updateFormDataJson: JSON.stringify(payloads()[0]) })
    expect(Object.keys(dtos[0]).sort()).toEqual(['appType', 'formInstanceId', 'updateFormDataJson'])
    expect(dtos[0]).not.toHaveProperty('formUuid')
    expect(dtos[0]).not.toHaveProperty('formDataJson')
    expect(dtos[0]).not.toHaveProperty('systemToken')
    expect(dtos[0]).not.toHaveProperty('userId')
  })

  it.each(['missing-target', 'catalog-type', 'map-type', 'required-map', 'required-catalog', 'duplicate-id', 'options-empty', 'options-duplicate'] as const)('rejects real editable catalog/mapping defect: %s', async (kind) => {
    await protocolExample()
    if (kind === 'missing-target') edit('sp-yida-map-target-0', 'not_in_catalog')
    if (kind === 'catalog-type') edit('sp-yida-catalog-control-7', 'text')
    if (kind === 'map-type') edit('sp-yida-map-type-7', 'string')
    if (kind === 'required-map') check('sp-yida-map-required-7', false)
    if (kind === 'required-catalog') check('sp-yida-catalog-required-6', true)
    if (kind === 'duplicate-id') edit('sp-yida-catalog-id-0', 'componentCode')
    if (kind === 'options-empty') edit('sp-yida-catalog-options-8', 'normal\n')
    if (kind === 'options-duplicate') edit('sp-yida-catalog-options-8', 'normal\nnormal')
    await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_STATIC_CONFIG_INVALID')
    expect(q('sp-yida-config-issues').textContent).not.toBe('')
    expect(protocolData()).toEqual([])
  })

  it('supports explicit add/remove catalog controls without inventing missing mapped or required fields', async () => {
    await protocolExample()
    q<HTMLButtonElement>('sp-yida-catalog-remove-0').click(); await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_STATIC_CONFIG_INVALID')
    await protocolExample()
    q<HTMLButtonElement>('sp-yida-catalog-add').click(); await flush()
    edit('sp-yida-catalog-id-9', 'newRequiredField'); check('sp-yida-catalog-required-9', true)
    await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_STATIC_CONFIG_INVALID')
    expect(protocolData()).toEqual([])
  })

  it('checks exact options against rows and refuses string values for numeric controls', async () => {
    await protocolExample()
    edit('sp-yida-catalog-options-8', 'normal'); await preview()
    expect(protocolData()).toHaveLength(1)
    expect(q('sp-yida-result-row-1').textContent).toContain('无效')
    await protocolExample()
    const input = rows(); input[0].quantity = '0'
    edit('sp-yida-rows', JSON.stringify(input)); await preview()
    expect(q('sp-yida-result-row-0').textContent).toContain('FIELD_TYPE')
    expect(root?.querySelector('[data-testid="sp-yida-protocol-0"]')).toBeNull()
    expect(protocolData()).toHaveLength(1)
  })

  it('keeps v2 DTOs through real exact allocation to two projects, including zero', async () => {
    await protocolExample()
    const input = rows(); input[0].quantity = 5; input[1].quantity = 0
    edit('sp-yida-rows', JSON.stringify(input)); await setAllocation('equal_decimal_exact'); await preview()
    expect(q('sp-yida-allocation-evidence').textContent).toContain('展开 4')
    expect(q('sp-yida-allocation-analysis-0').textContent).toContain('每项目 2.5')
    expect(payloads().map((row) => row.qty)).toEqual([2.5, 2.5, 0, 0])
    const dtos = protocolData()
    expect(dtos).toHaveLength(4)
    expect(dtos.map((dto) => JSON.parse(String(dto.formDataJson)))).toEqual(payloads())
    expect(payloads().map((row) => row.project)).toEqual(['SYN-PROJECT-01', 'SYN-PROJECT-02', 'SYN-PROJECT-01', 'SYN-PROJECT-02'])
    edit('sp-yida-intent', 'update'); await flush(); edit('sp-yida-instance-id-field', 'instanceId'); await preview()
    expect(q('sp-yida-error').textContent).toContain('YIDA_ALLOCATION_INTENT_INVALID')
    expect(protocolData()).toEqual([])
  })

  it.each(['9007199254740993', '6.00000000000000001', '1e-400'])('rejects raw numeric loss %s through the ordinary v1 click without retaining stale output', async (token) => {
    await example('primary'); await preview()
    expect(payloads()).toHaveLength(2)
    const raw = JSON.stringify([{ ...rows()[0], quantity: '__RAW_NUMBER__' }]).replace('"__RAW_NUMBER__"', token)
    expect(raw).toContain(token)
    edit('sp-yida-rows', raw); await preview()
    expect(root?.querySelector('[data-testid="sp-yida-error"]')?.textContent).toBe('YIDA_STATIC_ROWS_INVALID')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(payloads()).toEqual([])
    expect(protocolData()).toEqual([])
    expectNoIo()
  })

  it.each(['original', 'equal_integer'] as const)('rejects duplicate decoded JSON keys in the v1 %s path', async (mode) => {
    await example('primary')
    if (mode === 'equal_integer') await setAllocation(mode)
    const raw = JSON.stringify([{ ...rows()[0], quantity: 6 }]).replace('"quantity":6', '"quantity":6,"\\u0071uantity":6')
    expect(raw).toContain('"\\u0071uantity":6')
    edit('sp-yida-rows', raw); await preview()
    expect(root?.querySelector('[data-testid="sp-yida-error"]')?.textContent).toBe(mode === 'original' ? 'YIDA_STATIC_ROWS_INVALID' : 'YIDA_ALLOCATION_ROWS_INVALID')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(payloads()).toEqual([])
    expectNoIo()
  })

  it.each(['original', 'equal_integer'] as const)('checks numeric business keys outside quantity in the real v1 %s path', async (mode) => {
    await example('primary')
    edit('sp-yida-map-type-2', 'number'); check('sp-yida-map-key-2', true)
    if (mode === 'equal_integer') await setAllocation(mode)
    const input = [{ ...rows()[0], quantity: 6, componentCode: 9007199254740992 }]
    edit('sp-yida-rows', JSON.stringify(input)); await preview()
    expect(payloads()).toHaveLength(mode === 'original' ? 1 : 2)
    expect(payloads().every((payload) => payload.component === 9007199254740992)).toBe(true)
    const raw = JSON.stringify(input).replace('"componentCode":9007199254740992', '"componentCode":9007199254740993')
    expect(raw).toContain('"componentCode":9007199254740993')
    edit('sp-yida-rows', raw); await preview()
    expect(root?.querySelector('[data-testid="sp-yida-error"]')?.textContent).toBe(mode === 'original' ? 'YIDA_STATIC_ROWS_INVALID' : 'YIDA_ALLOCATION_ROWS_INVALID')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(payloads()).toEqual([])
    expectNoIo()
  })

  it.each(['-1.25', '0.1234567', '1e-300', '0.100e0', '1e20'])('preserves v1 numeric domain for exact decimal spelling %s', async (token) => {
    await example('primary')
    const raw = JSON.stringify([{ ...rows()[0], quantity: '__RAW_NUMBER__' }]).replace('"__RAW_NUMBER__"', token)
    edit('sp-yida-rows', raw); await preview()
    expect(payloads()).toHaveLength(1)
    expect(payloads()[0].qty).toBe(Number(token))
    expect(protocolData()).toEqual([])
    expect(root?.querySelector('[data-testid="sp-yida-error"]')).toBeNull()
    expectNoIo()
  })

  it.each(['9007199254740993', '9007199254740991.1', '1e-400', '-0', '6.00000000000000001'])('rejects raw numeric lexical loss %s through the ordinary v2 click', async (token) => {
    await protocolExample()
    const raw = JSON.stringify([{ ...rows()[0], quantity: '__RAW_NUMBER__' }]).replace('"__RAW_NUMBER__"', token)
    expect(raw).toContain(token)
    edit('sp-yida-rows', raw); await preview()
    expect(q('sp-yida-error').textContent).toBe('YIDA_STATIC_ROWS_INVALID')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(protocolData()).toEqual([])
  })

  it('accepts ordinary v2 decimals and zero while rejecting lexical loss in allocation', async () => {
    await protocolExample()
    const input = rows(); input[0].quantity = 0; input[1].quantity = 2.5
    edit('sp-yida-rows', JSON.stringify(input)); await preview()
    expect(protocolData().map((dto) => JSON.parse(String(dto.formDataJson)).qty)).toEqual([0, 2.5])
    const raw = JSON.stringify([{ ...input[0], quantity: '__RAW_NUMBER__' }]).replace('"__RAW_NUMBER__"', '9007199254740991.1')
    edit('sp-yida-rows', raw); await setAllocation('equal_decimal_exact'); await preview()
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(q('sp-yida-error').textContent).toBe('YIDA_ALLOCATION_ROWS_INVALID')
    expect(protocolData()).toEqual([])
  })

  it.each([-1.25, 1e-20, 1e-300])('preserves generic numeric control value %s outside allocation quantity policy', async (value) => {
    await protocolExample()
    edit('sp-yida-map-target-7', 'measurement')
    edit('sp-yida-catalog-id-7', 'measurement')
    edit('sp-yida-rows', JSON.stringify([{ ...rows()[0], quantity: value }]))
    await preview()
    expect(q<HTMLSelectElement>('sp-yida-allocation-mode').value).toBe('original')
    expect(protocolData()).toHaveLength(1)
    expect(JSON.parse(String(protocolData()[0].formDataJson)).measurement).toBe(value)
    expect(payloads()[0].measurement).toBe(value)
  })

  it('clears protocol, payload and allocation outputs on mode, catalog and identity edits', async () => {
    for (const change of ['mode', 'catalog-id', 'catalog-control', 'catalog-options', 'catalog-required', 'empty-key', 'business-key', 'map-source', 'map-required', 'catalog-add', 'catalog-remove']) {
      await protocolExample(); await setAllocation('equal_integer')
      // Make both rows divisible before checking successful-output invalidation.
      const input = rows(); input[1].quantity = 4; edit('sp-yida-rows', JSON.stringify(input)); expect(await exportRules()).not.toBe(''); await preview()
      expect(protocolData()).toHaveLength(4)
      if (change === 'mode') edit('sp-yida-preview-mode', 'mapping')
      if (change === 'catalog-id') edit('sp-yida-catalog-id-0', 'changed')
      if (change === 'catalog-control') edit('sp-yida-catalog-control-8', 'radio')
      if (change === 'catalog-options') edit('sp-yida-catalog-options-8', 'changed')
      if (change === 'catalog-required') check('sp-yida-catalog-required-8', true)
      if (change === 'empty-key') check('sp-yida-map-empty-key-6', false)
      if (change === 'business-key') check('sp-yida-map-key-6', false)
      if (change === 'map-source') edit('sp-yida-map-source-0', 'changed')
      if (change === 'map-required') check('sp-yida-map-required-8', true)
      if (change === 'catalog-add') q<HTMLButtonElement>('sp-yida-catalog-add').click()
      if (change === 'catalog-remove') q<HTMLButtonElement>('sp-yida-catalog-remove-0').click()
      await flush()
      expect(protocolData(), change).toEqual([])
      expect(root?.querySelector('[data-testid="sp-yida-result"]'), change).toBeNull()
      expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]'), change).toBeNull()
      expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').value, change).toBe('')
    }
  })

  it('keeps all transports and storage unused across v2 create, update and allocation clicks', async () => {
    await protocolExample(); await preview(); expect(protocolData()).toHaveLength(2)
    edit('sp-yida-intent', 'update'); await flush(); edit('sp-yida-instance-id-field', 'instanceId')
    edit('sp-yida-rows', JSON.stringify(rows().map((row, index) => ({ ...row, instanceId: `SYN-INSTANCE-${index}` })))); await preview()
    expect(q('sp-yida-summary').textContent).toContain('计划更新 2')
    await protocolExample('renamed'); edit('sp-yida-allocation-mode', 'equal_decimal_exact'); await flush()
    edit('sp-yida-allocation-projects', 'SYN-PROJECT-01\nSYN-PROJECT-02')
    edit('sp-yida-allocation-project-field', '项目号'); edit('sp-yida-allocation-quantity-field', '件数'); await preview()
    expect(protocolData()).toHaveLength(4)
    expect(fetchSpy).not.toHaveBeenCalled(); expect(xhrSpy).not.toHaveBeenCalled(); expect(beaconSpy).not.toHaveBeenCalled(); expect(socketSpy).not.toHaveBeenCalled()
    expect(storageGetSpy).not.toHaveBeenCalled(); expect(storageSetSpy).not.toHaveBeenCalled(); expect(storageRemoveSpy).not.toHaveBeenCalled(); expect(storageClearSpy).not.toHaveBeenCalled()
    expect(indexedDbOpenSpy).not.toHaveBeenCalled(); expect(indexedDbDeleteSpy).not.toHaveBeenCalled()
  })

  it.each(([1, 2] as const).flatMap((version) => (['primary', 'renamed'] as const).flatMap((layout) =>
    (['create', 'update'] as const).map((intent) => ({ version, layout, intent })))))('round-trips v$version $layout $intent through export, unmount, paste and the real planner', async ({ version, layout, intent }) => {
    if (version === 1) await example(layout); else await protocolExample(layout)
    edit('sp-yida-app-type', 'SYN-OLD-TARGET-APP'); edit('sp-yida-form-uuid', 'SYN-OLD-TARGET-FORM')
    if (intent === 'update') { edit('sp-yida-intent', 'update'); await flush(); edit('sp-yida-instance-id-field', 'localInstance') }
    const data = rows().map((row, index) => ({ ...row, ...(intent === 'update' ? { localInstance: `SYN-ROW-ONLY-INSTANCE-${index}` } : {}) }))
    edit('sp-yida-rows', JSON.stringify(data)); await preview()
    const expected = payloads()
    expect(expected).toHaveLength(2)
    const text = await exportRules()
    const artifact = JSON.parse(text) as YidaRuleTemplateEnvelope
    expect(Object.keys(artifact).sort()).toEqual(['allocation', 'formatVersion', 'kind', 'rules', 'status'])
    expect(artifact.status).toBe('local-unverified'); expect(artifact.rules.version).toBe(version)
    expect(artifact.rules.intent).toBe(intent); expect(artifact.rules).not.toHaveProperty('target')
    expect(artifact.allocation).toEqual({ mode: 'original' })
    expect(text).not.toMatch(/SYN-OLD-TARGET|SYN-ROW-ONLY-INSTANCE|SYN-PROJECT-01|LOCAL_SCHEMA_ONLY/)
    for (const name of ['rows', 'projects', 'payload', 'token', 'accessToken', 'systemToken', 'userId', 'authorization', 'canApply']) expect(artifact).not.toHaveProperty(name)
    expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').readOnly).toBe(true)
    expect(q<HTMLTextAreaElement>('sp-yida-rule-import-text').value).toBe('')
    await remount()
    expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').value).toBe('')
    expect(q<HTMLTextAreaElement>('sp-yida-rule-import-text').value).toBe('')
    await importRules(text)
    expect(q('sp-yida-rule-import-notice').textContent).toContain('仅本地规则，目标和数据待填写')
    expect(q<HTMLInputElement>('sp-yida-app-type').value).toBe('')
    expect(q<HTMLInputElement>('sp-yida-form-uuid').value).toBe('')
    expect(q<HTMLTextAreaElement>('sp-yida-rows').value).toBe('')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
    if (intent === 'update') expect(q<HTMLInputElement>('sp-yida-instance-id-field').value).toBe('localInstance')
    expect(JSON.parse(await exportRules())).toEqual(artifact) // Export does not require a real target or data.
    edit('sp-yida-app-type', 'SYN-NEW-APP'); edit('sp-yida-form-uuid', 'SYN-NEW-FORM'); edit('sp-yida-rows', JSON.stringify(data)); await preview()
    expect(payloads()).toEqual(expected)
    expect(q('sp-yida-summary').textContent).toContain(intent === 'create' ? '计划创建 2' : '计划更新 2')
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    if (version === 2) {
      expect(protocolData()).toHaveLength(2)
      expect(protocolData()[0]).toEqual(intent === 'create'
        ? { appType: 'SYN-NEW-APP', formUuid: 'SYN-NEW-FORM', formDataJson: JSON.stringify(expected[0]) }
        : { appType: 'SYN-NEW-APP', formInstanceId: 'SYN-ROW-ONLY-INSTANCE-0', updateFormDataJson: JSON.stringify(expected[0]) })
    } else expect(protocolData()).toEqual([])
    expectNoIo()
  })

  it.each(([1, 2] as const).flatMap((version) => (['primary', 'renamed'] as const).flatMap((layout) =>
    (['equal_integer', 'equal_decimal_exact'] as const).map((mode) => ({ version, layout, mode })))))('reuses v$version $layout $mode roles without carrying project lists or row quantities', async ({ version, layout, mode }) => {
    if (version === 1) await example(layout); else await protocolExample(layout)
    const projectField = layout === 'primary' ? 'projectNo' : '项目号'
    const quantityField = layout === 'primary' ? 'quantity' : '件数'
    const data = rows(); data[0][quantityField] = mode === 'equal_integer' ? 4 : 5; data[1][quantityField] = 0
    edit('sp-yida-rows', JSON.stringify(data)); edit('sp-yida-allocation-mode', mode); await flush()
    edit('sp-yida-allocation-projects', 'SYN-REUSE-P1\nSYN-REUSE-P2'); edit('sp-yida-allocation-project-field', projectField); edit('sp-yida-allocation-quantity-field', quantityField); await preview()
    const expected = payloads(); expect(expected).toHaveLength(4)
    const text = await exportRules()
    expect((JSON.parse(text) as YidaRuleTemplateEnvelope).allocation).toEqual({ mode, projectField, quantityField })
    expect(text).not.toContain('SYN-REUSE-P')
    await remount(); await importRules(text)
    expect(q<HTMLSelectElement>('sp-yida-allocation-mode').value).toBe(mode)
    expect(q<HTMLTextAreaElement>('sp-yida-allocation-projects').value).toBe('')
    expect(q<HTMLSelectElement>('sp-yida-allocation-project-field').value).toBe(projectField)
    expect(q<HTMLSelectElement>('sp-yida-allocation-quantity-field').value).toBe(quantityField)
    expect(q<HTMLTextAreaElement>('sp-yida-rows').value).toBe('')
    edit('sp-yida-app-type', 'SYN-REFILLED-APP'); edit('sp-yida-form-uuid', 'SYN-REFILLED-FORM'); edit('sp-yida-rows', JSON.stringify(data)); await preview()
    expect(q('sp-yida-error').textContent).toBe('YIDA_ALLOCATION_PROJECTS_INVALID')
    expect(payloads()).toEqual([])
    edit('sp-yida-allocation-projects', 'SYN-REUSE-P1\nSYN-REUSE-P2'); await preview()
    expect(payloads()).toEqual(expected)
    expect(q('sp-yida-allocation-evidence').textContent).toContain('展开 4')
    expect(q('sp-yida-no-apply').textContent).toContain('canApply=false')
    expectNoIo()
  })

  it('restores duplicate v1 source mappings with only the first key checked and preserves reversed key order', async () => {
    await example('primary')
    const data = rows()
    const text = await exportRules()
    const artifact = JSON.parse(text) as YidaRuleTemplateEnvelope
    artifact.rules.fieldMap.push({ ...artifact.rules.fieldMap[0], target: 'projectAlias' })
    artifact.rules.businessKey.reverse()
    await remount(); await importRules(JSON.stringify(artifact))
    const source = artifact.rules.fieldMap[0].source
    const matching = artifact.rules.fieldMap.map((entry, index) => entry.source === source ? index : -1).filter((index) => index >= 0)
    expect(matching).toHaveLength(2)
    expect(matching.map((index) => q<HTMLInputElement>(`sp-yida-map-key-${index}`).checked)).toEqual([true, false])
    expect(JSON.parse(await exportRules())).toEqual(artifact)
    edit('sp-yida-app-type', 'SYN-NEW-APP'); edit('sp-yida-form-uuid', 'SYN-NEW-FORM'); edit('sp-yida-rows', JSON.stringify(data)); await preview()
    expect(payloads()).toHaveLength(2)
    expect(payloads()[0].projectAlias).toBe(data[0][source])
    expect(q('sp-yida-summary').textContent).toContain('本地重复键 0')
    const beforeFailure = editorValues()
    await importRules('{"formatVersion":2}')
    expect(editorValues()).toEqual(beforeFailure)
    expect(JSON.parse(await exportRules())).toEqual(artifact)
    await example('renamed')
    const reset = JSON.parse(await exportRules()) as YidaRuleTemplateEnvelope
    expect(reset.rules.businessKey).not.toContain(source)
    expect(reset.rules.businessKey[0]).toBe('项目号')
    expectNoIo()
  })

  it('successful import replaces populated editors and clears actual old target, rows, projects and outputs', async () => {
    await protocolExample('renamed'); edit('sp-yida-allocation-mode', 'equal_decimal_exact'); await flush()
    edit('sp-yida-allocation-project-field', '项目号'); edit('sp-yida-allocation-quantity-field', '件数')
    const replacement = await exportRules()
    await example('primary'); await setAllocation('equal_integer', 'SYN-OLD-P1\nSYN-OLD-P2')
    edit('sp-yida-app-type', 'SYN-OLD-APP'); edit('sp-yida-form-uuid', 'SYN-OLD-FORM')
    edit('sp-yida-rule-import-text', replacement)
    expect(await exportRules()).not.toBe(''); await preview()
    expect(payloads()).toHaveLength(4)
    expect(q<HTMLTextAreaElement>('sp-yida-rows').value).not.toBe('')
    expect(q<HTMLTextAreaElement>('sp-yida-allocation-projects').value).toBe('SYN-OLD-P1\nSYN-OLD-P2')
    q<HTMLButtonElement>('sp-yida-rule-import').click(); await flush()
    expect(q<HTMLInputElement>('sp-yida-app-type').value).toBe('')
    expect(q<HTMLInputElement>('sp-yida-form-uuid').value).toBe('')
    expect(q<HTMLTextAreaElement>('sp-yida-rows').value).toBe('')
    expect(q<HTMLTextAreaElement>('sp-yida-allocation-projects').value).toBe('')
    expect(q<HTMLSelectElement>('sp-yida-preview-mode').value).toBe('protocol')
    expect(q<HTMLSelectElement>('sp-yida-allocation-mode').value).toBe('equal_decimal_exact')
    expect(q<HTMLInputElement>('sp-yida-map-source-0').value).toBe('项目号')
    expect(q<HTMLSelectElement>('sp-yida-allocation-project-field').value).toBe('项目号')
    expect(q<HTMLSelectElement>('sp-yida-allocation-quantity-field').value).toBe('件数')
    expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').value).toBe('')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
    expect(q('sp-yida-rule-import-notice').textContent).toContain('仅本地规则')
    expect(JSON.parse(await exportRules())).toEqual(JSON.parse(replacement))
    expectNoIo()
  })

  it.each(['primary', 'renamed'] as const)('preserves multiline, Unicode and backslash catalog options through JSON-array reuse: %s', async (layout) => {
    await protocolExample(layout)
    const options = ['normal\n第二行', '引号"与\\反斜杠💡', '  edge whitespace  ']
    edit('sp-yida-catalog-options-mode-8', 'json'); edit('sp-yida-catalog-options-8', JSON.stringify(options))
    const priorityField = q<HTMLInputElement>('sp-yida-map-source-8').value
    const data = rows(); data[0][priorityField] = options[0]; data[1][priorityField] = options[1]
    edit('sp-yida-rows', JSON.stringify(data)); await preview()
    expect(payloads().map((row) => row.priority)).toEqual(options.slice(0, 2))
    const text = await exportRules(); await remount(); await importRules(text)
    expect(q<HTMLSelectElement>('sp-yida-catalog-options-mode-8').value).toBe('json')
    expect(JSON.parse(q<HTMLTextAreaElement>('sp-yida-catalog-options-8').value)).toEqual(options)
    expect(JSON.parse(await exportRules())).toEqual(JSON.parse(text))
    edit('sp-yida-app-type', 'SYN-NEW-APP'); edit('sp-yida-form-uuid', 'SYN-NEW-FORM'); edit('sp-yida-rows', JSON.stringify(data)); await preview()
    expect(payloads().map((row) => row.priority)).toEqual(options.slice(0, 2))
    expect(protocolData().map((dto) => JSON.parse(String(dto.formDataJson)).priority)).toEqual(options.slice(0, 2))
    await protocolExample(layout)
    expect(q<HTMLSelectElement>('sp-yida-catalog-options-mode-8').value).toBe('lines')
    edit('sp-yida-catalog-options-8', 'normal\nrush'); await preview()
    expect(payloads()).toHaveLength(2)
    expectNoIo()
  })

  it.each(['{', '{}', '["normal",]', '{"option":"synthetic-private"}', '[1]', '[null]'])('catches malformed JSON-array option edits in preview and export without exposing input: %s', async (text) => {
    await protocolExample(); await preview(); expect(protocolData()).toHaveLength(2)
    edit('sp-yida-catalog-options-mode-8', 'json'); edit('sp-yida-catalog-options-8', text); await preview()
    expect(q('sp-yida-error').textContent).toBe('YIDA_STATIC_CONFIG_INVALID')
    expect(payloads()).toEqual([]); expect(protocolData()).toEqual([])
    expect(await exportRules()).toBe('')
    expect(q('sp-yida-error').textContent).toBe('YIDA_RULE_TEMPLATE_CONFIG')
    expectNoIo()
  })

  it.each(['syntax', 'target', 'rows', 'projects', 'authority', 'mapping', 'allocation', 'duplicate', 'version-rounding'] as const)('fails import atomically and clears stale output without disclosing rejected %s data', async (defect) => {
    await protocolExample(); await setAllocation('equal_decimal_exact')
    const clean = await exportRules()
    const artifact = JSON.parse(clean) as unknown as Record<string, unknown>
    const rules = artifact.rules as Record<string, unknown>
    if (defect === 'target') rules.target = { appType: 'synthetic-private-rejected', formUuid: 'synthetic-private-rejected' }
    if (defect === 'rows') artifact.rows = [{ value: 'synthetic-private-rejected' }]
    if (defect === 'projects') (artifact.allocation as Record<string, unknown>).projects = ['synthetic-private-rejected']
    if (defect === 'authority') artifact.approved = 'synthetic-private-rejected'
    if (defect === 'mapping') rules.fieldMap = [{ source: 'synthetic-private-rejected' }]
    if (defect === 'allocation') artifact.allocation = { mode: 'equal_integer', projectField: 'synthetic-private-rejected', quantityField: 'quantity' }
    let invalid = JSON.stringify(artifact)
    if (defect === 'syntax') invalid = '{"synthetic-private-rejected":'
    if (defect === 'duplicate') invalid = invalid.replace('"formatVersion":1', '"formatVersion":1,"\\u0066ormatVersion":1')
    if (defect === 'version-rounding') invalid = invalid.replace('"formatVersion":1', '"formatVersion":1.0000000000000001')
    edit('sp-yida-rule-import-text', invalid); await flush()
    const current = editorValues()
    expect(await exportRules()).not.toBe(''); await preview()
    expect(protocolData()).toHaveLength(4)
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).not.toBeNull()
    q<HTMLButtonElement>('sp-yida-rule-import').click(); await flush()
    expect(editorValues()).toEqual(current)
    expect(q('sp-yida-error').textContent).toMatch(/^YIDA_RULE_TEMPLATE_(INPUT|TEXT|LIMIT|CONFIG|ALLOCATION)$/)
    expect(q('sp-yida-error').textContent).not.toContain('synthetic-private')
    expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').value).toBe('')
    expect(root?.querySelector('[data-testid="sp-yida-result"]')).toBeNull()
    expect(root?.querySelector('[data-testid="sp-yida-allocation-result"]')).toBeNull()
    expect(root?.querySelector('[data-testid="sp-yida-rule-import-notice"]')).toBeNull()
    expect(protocolData()).toEqual([])
    expectNoIo()
  })

  it('invalidates export, plan and errors on paste/option representation/instance edits and repeated samples', async () => {
    for (const change of ['paste', 'options-mode', 'instance-role', 'same-sample', 'mapping-add', 'mapping-remove']) {
      await protocolExample()
      if (change === 'instance-role') {
        edit('sp-yida-intent', 'update'); await flush(); edit('sp-yida-instance-id-field', 'localInstance')
        edit('sp-yida-rows', JSON.stringify(rows().map((row, index) => ({ ...row, localInstance: `SYN-${index}` }))))
      }
      expect(await exportRules()).not.toBe(''); await preview(); expect(protocolData()).toHaveLength(2)
      if (change === 'paste') edit('sp-yida-rule-import-text', '{}')
      if (change === 'options-mode') edit('sp-yida-catalog-options-mode-8', 'json')
      if (change === 'instance-role') edit('sp-yida-instance-id-field', 'newInstance')
      if (change === 'same-sample') q<HTMLButtonElement>('sp-yida-protocol-example-primary').click()
      if (change === 'mapping-add') q<HTMLButtonElement>('sp-yida-map-add').click()
      if (change === 'mapping-remove') q<HTMLButtonElement>('sp-yida-map-remove-0').click()
      await flush()
      expect(q<HTMLTextAreaElement>('sp-yida-rule-export-text').value, change).toBe('')
      expect(root?.querySelector('[data-testid="sp-yida-result"]'), change).toBeNull()
      expect(protocolData(), change).toEqual([])
    }
    await importRules('{')
    expect(q('sp-yida-error').textContent).toBe('YIDA_RULE_TEMPLATE_TEXT')
    edit('sp-yida-rule-import-text', '{}'); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-error"]')).toBeNull()
    expectNoIo()
  })
})
