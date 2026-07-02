import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceConfigPanel from '../src/components/integration/IntegrationReadSourceConfigPanel.vue'
import {
  buildReadSourceConfigPayload,
  createReadSourceConfigDraft,
  isCoarseSafeRelativeReadPath,
  normalizeReadSourceProbeEvidence,
  validateReadSourceDraft,
  type ReadSourceConfigDraft,
} from '../src/services/integration/readSourceConfigs'
import type { WorkbenchExternalSystem } from '../src/services/integration/workbench'

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, code: string, reason: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'coarse', details: { reason } } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitUntil(condition: () => boolean, label: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

// --- pure helper tests (DOM-free) -------------------------------------------

describe('readSourceConfigs pure helpers', () => {
  function validDraft(mode: ReadSourceConfigDraft['mode'] = 'single_record'): ReadSourceConfigDraft {
    const draft = createReadSourceConfigDraft()
    draft.systemId = 'sys_1'
    draft.requiredKind = 'erp:k3-wise-webapi'
    draft.object = 'material'
    draft.mode = mode
    draft.readPath = '/K3API/Material/GetDetail'
    draft.readMethod = 'POST'
    if (mode === 'single_record' || mode === 'resolver_lookup') {
      draft.keyField = 'FNumber'
      draft.containerPaths = 'Data'
    }
    if (mode === 'resolver_lookup') draft.multiplicityRuleField = 'FIsCurrent'
    if (mode === 'list_page') draft.containerPaths = 'Data.Data, Data.DATA'
    if (mode === 'detail_with_lines') {
      draft.headerContainerPaths = 'Data.Page1'
      draft.lineContainerPaths = 'Data.Page2'
    }
    return draft
  }

  it('per-mode required fields gate validation', () => {
    expect(validateReadSourceDraft(validDraft('single_record'))).toEqual([])
    expect(validateReadSourceDraft(validDraft('list_page'))).toEqual([])
    expect(validateReadSourceDraft(validDraft('detail_with_lines'))).toEqual([])
    expect(validateReadSourceDraft(validDraft('resolver_lookup'))).toEqual([])

    const missingKey = validDraft('single_record')
    missingKey.keyField = ''
    expect(validateReadSourceDraft(missingKey).some((p) => p.includes('keyField'))).toBe(true)

    const missingContainers = validDraft('list_page')
    missingContainers.containerPaths = ' '
    expect(validateReadSourceDraft(missingContainers).some((p) => p.includes('containerPaths'))).toBe(true)

    const missingLines = validDraft('detail_with_lines')
    missingLines.lineContainerPaths = ''
    expect(validateReadSourceDraft(missingLines).some((p) => p.includes('lineContainerPaths'))).toBe(true)

    const missingMultiplicity = validDraft('resolver_lookup')
    missingMultiplicity.multiplicityRuleField = ''
    expect(validateReadSourceDraft(missingMultiplicity).some((p) => p.includes('multiplicityRuleField'))).toBe(true)

    const halfFieldMap = validDraft('single_record')
    halfFieldMap.fieldMap = [{ source: 'FName', target: '' }]
    expect(validateReadSourceDraft(halfFieldMap).some((p) => p.includes('fieldMap'))).toBe(true)
  })

  it('coarse relative-path guard mirrors the server reject classes', () => {
    expect(isCoarseSafeRelativeReadPath('/K3API/Material/GetDetail')).toBe(true)
    expect(isCoarseSafeRelativeReadPath('K3API/Material/GetList')).toBe(true)
    for (const bad of ['https://evil.example.com/x', '//evil.example.com/x', '/a/%2e%2e/x', '/a/../x', '\\\\host\\share', '', '   ', 'javascript:alert(1)']) {
      expect(isCoarseSafeRelativeReadPath(bad), bad).toBe(false)
    }
  })

  it('payload assembly pins operations to [read], keeps only mode-relevant fields, drops empties', () => {
    const single = buildReadSourceConfigPayload(validDraft('single_record'))
    expect(single).toEqual({
      version: 1,
      systemId: 'sys_1',
      requiredKind: 'erp:k3-wise-webapi',
      object: 'material',
      mode: 'single_record',
      readPath: '/K3API/Material/GetDetail',
      readMethod: 'POST',
      operations: ['read'],
      keyField: 'FNumber',
      containerPaths: ['Data'],
    })

    const detail = validDraft('detail_with_lines')
    detail.containerPaths = 'ShouldBe.Dropped'
    detail.keyField = 'FBillNo'
    const detailPayload = buildReadSourceConfigPayload(detail)
    expect(detailPayload.containerPaths).toBeUndefined()
    expect(detailPayload.headerContainerPaths).toEqual(['Data.Page1'])
    expect(detailPayload.lineContainerPaths).toEqual(['Data.Page2'])
    expect(detailPayload.keyField).toBe('FBillNo')

    const list = validDraft('list_page')
    list.keyField = 'ShouldBeDropped'
    list.multiplicityRuleField = 'AlsoDropped'
    const listPayload = buildReadSourceConfigPayload(list)
    expect(listPayload.keyField).toBeUndefined()
    expect(listPayload.multiplicityRuleField).toBeUndefined()
    expect(listPayload.containerPaths).toEqual(['Data.Data', 'Data.DATA'])

    const mapped = validDraft('single_record')
    mapped.fieldMap = [
      { source: ' FName ', target: ' material_name ' },
      { source: '', target: '' },
    ]
    expect(buildReadSourceConfigPayload(mapped).fieldMap).toEqual([{ source: 'FName', target: 'material_name' }])
    const emptyMap = validDraft('single_record')
    emptyMap.fieldMap = [{ source: '', target: '' }]
    expect(buildReadSourceConfigPayload(emptyMap).fieldMap).toBeUndefined()
  })

  it('evidence normalizer is an allowlist: illegal fields (row values) are dropped', () => {
    const evidence = normalizeReadSourceProbeEvidence({
      ok: true,
      object: 'material',
      mode: 'single_record',
      boundedSmoke: true,
      containers: {
        primary: { type: 'array', arrayLength: 3, firstRowValue: 'LEAKY-VALUE' },
        header: { type: 'nonsense' },
        bogusAlias: { type: 'array', arrayLength: 1 },
      },
      containerLocated: true,
      boundedSmokeExecuted: true,
      recordCount: 3,
      capReached: false,
      rows: [{ FName: 'SECRET-ROW-VALUE' }],
      firstRowValue: 'LEAKY-VALUE',
      message: 'secret M-001 at https://k3host',
    })
    expect(evidence).toEqual({
      ok: true,
      object: 'material',
      mode: 'single_record',
      boundedSmoke: true,
      containers: { primary: { type: 'array', arrayLength: 3 } },
      containerLocated: true,
      boundedSmokeExecuted: true,
      recordCount: 3,
      capReached: false,
    })
    const text = JSON.stringify(evidence)
    for (const leak of ['SECRET-ROW-VALUE', 'LEAKY-VALUE', 'M-001', 'k3host', 'bogusAlias', 'nonsense']) {
      expect(text.includes(leak), leak).toBe(false)
    }
  })

  it('evidence normalizer keeps only enum-shaped error codes/types and only when not ok', () => {
    const failed = normalizeReadSourceProbeEvidence({
      ok: false,
      object: 'material',
      mode: 'list_page',
      boundedSmoke: false,
      errorCode: 'READ_SOURCE_PROBE_TIMEOUT',
      errorType: 'TimeoutError',
      timeoutReached: true,
    })
    expect(failed).toMatchObject({ ok: false, errorCode: 'READ_SOURCE_PROBE_TIMEOUT', errorType: 'TimeoutError', timeoutReached: true })

    const hostile = normalizeReadSourceProbeEvidence({
      ok: false,
      object: 'material',
      mode: 'list_page',
      boundedSmoke: false,
      errorCode: 'FAILED M-001 https://k3host',
      errorType: 'Error<script>',
    })
    expect(hostile?.errorCode).toBeUndefined()
    expect(hostile?.errorType).toBeUndefined()
  })
})

// --- component tests ---------------------------------------------------------

const SYSTEMS: WorkbenchExternalSystem[] = [
  { id: 'sys_1', tenantId: 'default', workspaceId: null, name: 'K3 WISE', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
  { id: 'sys_http', tenantId: 'default', workspaceId: null, name: 'Generic HTTP', kind: 'http', role: 'source', status: 'active' },
]

describe('IntegrationReadSourceConfigPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalConfirm: typeof window.confirm | undefined
  let confirmMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    apiFetchMock.mockReset()
    originalConfirm = window.confirm
    confirmMock = vi.fn(() => true)
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirmMock })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(window, 'confirm', { configurable: true, value: originalConfirm })
    app = null
    container = null
  })

  function mountPanel(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationReadSourceConfigPanel, {
        scope: { tenantId: 'default', workspaceId: null },
        systems: SYSTEMS,
      }),
    })
    app.mount(container)
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testid: string): T {
    const el = root.querySelector<T>(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`missing [data-testid=${testid}]`)
    return el
  }

  function setInput(root: HTMLElement, testid: string, value: string): void {
    const input = q<HTMLInputElement>(root, testid)
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  function setSelect(root: HTMLElement, testid: string, value: string): void {
    const select = q<HTMLSelectElement>(root, testid)
    select.value = value
    select.dispatchEvent(new Event('change'))
  }

  function mockListOnly(rows: unknown[] = []): void {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/integration/read-source-configs')) {
        return jsonResponse(rows)
      }
      return jsonResponse(null)
    })
  }

  async function fillValidSingleRecordDraft(root: HTMLElement): Promise<void> {
    setSelect(root, 'rsc-system', 'sys_1')
    await flushUi()
    setInput(root, 'rsc-object', 'material')
    setInput(root, 'rsc-read-path', '/K3API/Material/GetDetail')
    setInput(root, 'rsc-key-field', 'FNumber')
    setInput(root, 'rsc-container-paths', 'Data')
    await flushUi()
  }

  it('renders list rows with status badges; approve only on draft, retire only on approved', async () => {
    mockListOnly([
      { id: 'cfg_draft', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'ck1', createdBy: 'op', updatedAt: '2026-07-01' },
      { id: 'cfg_appr', systemId: 'sys_1', object: 'material', mode: 'list_page', version: 2, status: 'approved', contentKey: 'ck2', createdBy: 'op', updatedAt: '2026-07-01' },
      { id: 'cfg_ret', systemId: 'sys_http', object: 'order', mode: 'list_page', version: 1, status: 'retired', contentKey: 'ck3', createdBy: 'op', updatedAt: '2026-07-01' },
    ])
    const root = mountPanel()
    await flushUi()

    expect(q(root, 'rsc-status-cfg_draft').textContent).toContain('草稿')
    expect(q(root, 'rsc-status-cfg_appr').textContent).toContain('已审批')
    expect(q(root, 'rsc-status-cfg_ret').textContent).toContain('已停用')
    expect(root.querySelector('[data-testid="rsc-approve-cfg_draft"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-retire-cfg_draft"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-approve-cfg_appr"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-retire-cfg_appr"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-approve-cfg_ret"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-retire-cfg_ret"]')).toBeNull()
  })

  it('gates fields per mode and blocks probe/save until required fields are present', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()

    // single_record (default): keyField + containerPaths visible; probe disabled while invalid
    expect(root.querySelector('[data-testid="rsc-key-field"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-container-paths"]')).not.toBeNull()
    expect(q<HTMLButtonElement>(root, 'rsc-probe').disabled).toBe(true)
    expect(q<HTMLButtonElement>(root, 'rsc-save').disabled).toBe(true)
    expect(q(root, 'rsc-validation').textContent).toContain('keyField')

    // list_page: keyField hidden
    setSelect(root, 'rsc-mode', 'list_page')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-key-field"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-container-paths"]')).not.toBeNull()

    // detail_with_lines: header/line inputs replace containerPaths
    setSelect(root, 'rsc-mode', 'detail_with_lines')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-container-paths"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-header-container-paths"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-line-container-paths"]')).not.toBeNull()

    // resolver_lookup: multiplicity field appears
    setSelect(root, 'rsc-mode', 'resolver_lookup')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-multiplicity-field"]')).not.toBeNull()

    // valid single_record enables the buttons
    setSelect(root, 'rsc-mode', 'single_record')
    await fillValidSingleRecordDraft(root)
    expect(q(root, 'rsc-required-kind').getAttribute('value') ?? q<HTMLInputElement>(root, 'rsc-required-kind').value).toContain('erp:k3-wise-webapi')
    expect(root.querySelector('[data-testid="rsc-validation"]')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'rsc-probe').disabled).toBe(false)
    expect(q<HTMLButtonElement>(root, 'rsc-save').disabled).toBe(false)
  })

  it('probe posts the exact contract body (config + boundedSmoke + inputs.key) and renders values-free evidence', async () => {
    const probeBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems/sys_1/read-source-probe')) {
        probeBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
        return jsonResponse({
          ok: true,
          object: 'material',
          mode: 'single_record',
          boundedSmoke: true,
          containers: { primary: { type: 'object', arrayLength: null } },
          containerLocated: true,
          boundedSmokeExecuted: true,
          recordCount: 1,
          capReached: false,
          timeoutReached: false,
          rows: [{ FName: 'SECRET-ROW-VALUE' }],
          firstRowValue: 'LEAKY-VALUE',
        })
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)

    const smoke = q<HTMLInputElement>(root, 'rsc-bounded-smoke')
    smoke.checked = true
    smoke.dispatchEvent(new Event('change'))
    await flushUi()
    setInput(root, 'rsc-probe-key', ' M-001 ')
    await flushUi()

    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await flushUi()

    expect(probeBodies).toHaveLength(1)
    expect(probeBodies[0]).toEqual({
      config: {
        version: 1,
        systemId: 'sys_1',
        requiredKind: 'erp:k3-wise-webapi',
        object: 'material',
        mode: 'single_record',
        readPath: '/K3API/Material/GetDetail',
        readMethod: 'POST',
        operations: ['read'],
        keyField: 'FNumber',
        containerPaths: ['Data'],
      },
      boundedSmoke: true,
      inputs: { key: 'M-001' },
    })

    const evidence = q(root, 'rsc-probe-evidence')
    expect(evidence.textContent).toContain('ok: true')
    expect(q(root, 'rsc-evidence-container-primary').textContent).toContain('type=object')
    expect(q(root, 'rsc-evidence-record-count').textContent).toContain('recordCount: 1')

    // leak guard: illegal fields in the response never reach the DOM
    for (const leak of ['SECRET-ROW-VALUE', 'LEAKY-VALUE']) {
      expect(root.innerHTML.includes(leak), leak).toBe(false)
    }
  })

  it('probe with declared keyField but empty key fail-closes client-side (no fetch)', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    apiFetchMock.mockClear()

    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await flushUi()

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(q(root, 'rsc-error').textContent).toContain('keyField')
  })

  it('renders coarse failure evidence codes', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      if (url.includes('/read-source-probe')) {
        return jsonResponse({
          ok: false,
          object: 'material',
          mode: 'single_record',
          boundedSmoke: false,
          errorCode: 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND',
          errorType: 'ReadSourceProbeRuntimeError',
          containers: { primary: { type: 'missing', arrayLength: null } },
          containerLocated: false,
        })
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    setInput(root, 'rsc-probe-key', 'M-001')
    await flushUi()

    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await flushUi()

    expect(q(root, 'rsc-evidence-error-code').textContent).toContain('READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
    expect(q(root, 'rsc-evidence-error-type').textContent).toContain('ReadSourceProbeRuntimeError')
    expect(q(root, 'rsc-evidence-located').textContent).toContain('false')
  })

  it('surfaces contract 400 as coarse code/reason without echoing values', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      if (url.includes('/read-source-probe')) {
        return errorResponse(400, 'READ_SOURCE_PROBE_CONTRACT_INVALID', 'unexpected_field')
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    setInput(root, 'rsc-probe-key', 'M-001')
    await flushUi()

    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await flushUi()

    const message = q(root, 'rsc-error').textContent ?? ''
    expect(message).toContain('READ_SOURCE_PROBE_CONTRACT_INVALID')
    expect(message).toContain('unexpected_field')
    expect(message.includes('M-001')).toBe(false)
  })

  it('save renders 已保存新版本 vs 已复用现有版本 and refreshes the list', async () => {
    let saved = false
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        const reused = saved
        saved = true
        return jsonResponse({ id: 'cfg_1', version: 3, status: 'draft', reused, contentKey: 'ck' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)

    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => (root.querySelector('[data-testid="rsc-save-result"]')?.textContent ?? '').includes('已保存新版本'), 'first save settles')
    expect(q(root, 'rsc-save-result').textContent).toContain('已保存新版本 v3')

    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => (root.querySelector('[data-testid="rsc-save-result"]')?.textContent ?? '').includes('已复用'), 'second save settles')
    expect(q(root, 'rsc-save-result').textContent).toContain('已复用现有版本 v3')
  })

  it('approve requires confirm; cancel means no API call', async () => {
    const approveCalls: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/approve') && init?.method === 'POST') {
        approveCalls.push(url)
        return jsonResponse({ id: 'cfg_draft', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'approved', contentKey: 'ck1' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) {
        return jsonResponse([
          { id: 'cfg_draft', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'ck1' },
        ])
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()

    confirmMock.mockReturnValueOnce(false)
    q<HTMLButtonElement>(root, 'rsc-approve-cfg_draft').click()
    await flushUi()
    expect(approveCalls).toHaveLength(0)

    confirmMock.mockReturnValueOnce(true)
    q<HTMLButtonElement>(root, 'rsc-approve-cfg_draft').click()
    await flushUi()
    expect(approveCalls).toHaveLength(1)
    expect(approveCalls[0]).toContain('/api/integration/read-source-configs/cfg_draft/approve')
  })

  it('audit toggle loads values-free audit rows', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/audit')) {
        return jsonResponse([
          { action: 'save_version', actor: 'consultant_1', detail: { status: 'draft' }, createdAt: '2026-07-01T00:00:00Z' },
          { action: 'status_change', actor: 'admin_1', detail: { from: 'draft', to: 'approved' }, createdAt: '2026-07-02T00:00:00Z' },
        ])
      }
      if (url.startsWith('/api/integration/read-source-configs')) {
        return jsonResponse([
          { id: 'cfg_1', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'approved', contentKey: 'ck1' },
        ])
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()

    q<HTMLButtonElement>(root, 'rsc-audit-toggle-cfg_1').click()
    await flushUi()

    const audit = q(root, 'rsc-audit-list')
    expect(audit.textContent).toContain('保存新版本')
    expect(audit.textContent).toContain('状态变更')
    expect(audit.textContent).toContain('consultant_1')
  })
})
