import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { createApp, h, nextTick, reactive, ref, type App as VueApp, type Ref } from 'vue'
import { createRequire } from 'node:module'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceConfigPanel from '../src/components/integration/IntegrationReadSourceConfigPanel.vue'
import {
  buildReadSourceConfigPayload,
  createK3WiseMaterialListB4Draft,
  createK3WiseBomListByMaterialDraft,
  isK3WiseMaterialListB4Draft,
  createReadSourceConfigDraft,
  isCoarseSafeRelativeReadPath,
  normalizeReadSourceProbeEvidence,
  validateReadSourceDraft,
  type ReadSourceConfigDraft,
} from '../src/services/integration/readSourceConfigs'
import type { WorkbenchExternalSystem } from '../src/services/integration/workbench'

const require = createRequire(import.meta.url)
const b4Contract = require('../../../plugins/plugin-integration-core/lib/read-source-k3-material-list-b4-contract.cjs') as {
  buildK3WiseMaterialListB4Config: (input: { systemId: string }) => Record<string, unknown>
}

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
    // R3: a valid resolver_lookup needs resolverRule + exactly one fieldMap target. Base = exactly_one
    // (the simplest rule — no multiplicityRuleField / sortDirection / discriminatorValue).
    if (mode === 'resolver_lookup') {
      draft.resolverRule = 'exactly_one'
      draft.fieldMap = [{ source: 'FItemID', target: 'item_id' }]
    }
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

    const missingRule = validDraft('resolver_lookup')
    missingRule.resolverRule = ''
    expect(validateReadSourceDraft(missingRule).some((p) => p.includes('resolverRule'))).toBe(true)

    const halfFieldMap = validDraft('single_record')
    halfFieldMap.fieldMap = [{ source: 'FName', target: '' }]
    expect(validateReadSourceDraft(halfFieldMap).some((p) => p.includes('fieldMap'))).toBe(true)
  })

  it('R3 resolver_lookup: per-rule required/forbidden validation + rule-specific payload shaping', () => {
    // exactly_one (from validDraft) is valid with just resolverRule + one fieldMap target; sends none of
    // the three rule-specific keys.
    const one = validDraft('resolver_lookup')
    expect(validateReadSourceDraft(one)).toEqual([])
    const onePayload = buildReadSourceConfigPayload(one)
    expect(onePayload.resolverRule).toBe('exactly_one')
    expect(onePayload.multiplicityRuleField).toBeUndefined()
    expect(onePayload.resolverSortDirection).toBeUndefined()
    expect(onePayload.resolverDiscriminatorValue).toBeUndefined()

    // first_when_sorted: needs sort field + direction; forbids discriminatorValue (not sent even if set).
    const sorted = validDraft('resolver_lookup')
    sorted.resolverRule = 'first_when_sorted'
    expect(validateReadSourceDraft(sorted).some((p) => p.includes('multiplicityRuleField'))).toBe(true)
    sorted.multiplicityRuleField = 'FVersion'
    expect(validateReadSourceDraft(sorted).some((p) => p.includes('resolverSortDirection'))).toBe(true)
    sorted.resolverSortDirection = 'desc'
    sorted.resolverDiscriminatorValue = 'STRAY' // set but forbidden for this rule
    expect(validateReadSourceDraft(sorted)).toEqual([])
    const sortedPayload = buildReadSourceConfigPayload(sorted)
    expect(sortedPayload).toMatchObject({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FVersion', resolverSortDirection: 'desc' })
    expect(sortedPayload.resolverDiscriminatorValue).toBeUndefined() // forbidden field never rides along

    // field_equals: needs discriminator field + bounded token value; forbids sortDirection.
    const eq = validDraft('resolver_lookup')
    eq.resolverRule = 'field_equals'
    eq.multiplicityRuleField = 'FIsCurrent'
    expect(validateReadSourceDraft(eq).some((p) => p.includes('resolverDiscriminatorValue'))).toBe(true)
    eq.resolverDiscriminatorValue = 'has space' // not a bounded token
    expect(validateReadSourceDraft(eq).some((p) => p.includes('token'))).toBe(true)
    eq.resolverDiscriminatorValue = 'Y'
    eq.resolverSortDirection = 'asc' // set but forbidden for this rule
    expect(validateReadSourceDraft(eq)).toEqual([])
    const eqPayload = buildReadSourceConfigPayload(eq)
    expect(eqPayload).toMatchObject({ resolverRule: 'field_equals', multiplicityRuleField: 'FIsCurrent', resolverDiscriminatorValue: 'Y' })
    expect(eqPayload.resolverSortDirection).toBeUndefined()

    // resolver_lookup requires exactly one fieldMap target.
    const twoTargets = validDraft('resolver_lookup')
    twoTargets.fieldMap = [{ source: 'FItemID', target: 'a' }, { source: 'FName', target: 'b' }]
    expect(validateReadSourceDraft(twoTargets).some((p) => p.includes('fieldMap'))).toBe(true)
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

    // value-carrying strings fall back to the coarse defaults
    const hostile = normalizeReadSourceProbeEvidence({
      ok: false,
      object: 'material',
      mode: 'list_page',
      boundedSmoke: false,
      errorCode: 'FAILED M-001 https://k3host',
      errorType: 'Error<script>',
    })
    expect(hostile?.errorCode).toBe('READ_SOURCE_PROBE_FAILED')
    expect(hostile?.errorType).toBe('Error')

    // enum-SHAPED but outside the frozen S2-a vocabularies → fallback, never rendered verbatim
    for (const [errorCode, errorType] of [
      ['MATERIAL_2024_SECRET', 'AdapterValidationError'],
      ['READ_SOURCE_PROBE_BOGUS', 'SecretLeakError'],
    ]) {
      const nonVocabulary = normalizeReadSourceProbeEvidence({
        ok: false,
        object: 'material',
        mode: 'list_page',
        boundedSmoke: false,
        errorCode,
        errorType,
      })
      expect(nonVocabulary?.errorCode).toBe('READ_SOURCE_PROBE_FAILED')
      expect(nonVocabulary?.errorType).toBe('Error')
      const text = JSON.stringify(nonVocabulary)
      expect(text.includes(errorCode)).toBe(false)
      expect(text.includes(errorType)).toBe(false)
    }

    // R0 (#1709): the 9 resolver codes + resolver evidence keys render; non-vocabulary codes/rule drop.
    const resolver = normalizeReadSourceProbeEvidence({
      ok: false,
      object: 'material',
      mode: 'resolver_lookup',
      boundedSmoke: false,
      errorCode: 'READ_SOURCE_RESOLVER_AMBIGUOUS',
      errorType: 'ReadSourceResolverError',
      candidateCount: 2,
      matchedCount: 2,
      ambiguous: true,
      resolved: false,
      rule: 'field_equals',
    })
    expect(resolver).toMatchObject({
      errorCode: 'READ_SOURCE_RESOLVER_AMBIGUOUS',
      errorType: 'ReadSourceResolverError',
      candidateCount: 2,
      matchedCount: 2,
      ambiguous: true,
      resolved: false,
      rule: 'field_equals',
    })
    // a resolver-looking-but-unregistered code + a raw rule string fall back / drop (no prefix match).
    const bogusResolver = normalizeReadSourceProbeEvidence({
      ok: false,
      object: 'material',
      mode: 'resolver_lookup',
      boundedSmoke: false,
      errorCode: 'READ_SOURCE_RESOLVER_SECRET_MAT-001',
      rule: 'take_the_first_row',
    })
    expect(bogusResolver?.errorCode).toBe('READ_SOURCE_PROBE_FAILED')
    expect('rule' in (bogusResolver ?? {})).toBe(false)
    const bogusText = JSON.stringify(bogusResolver)
    expect(bogusText.includes('MAT-001')).toBe(false)
    expect(bogusText.includes('take_the_first_row')).toBe(false)
  })

  it('payload assembly normalizes readPath to carry the leading slash (server byte-normalization mirror)', () => {
    const draft = validDraft('list_page')
    draft.readPath = 'K3API/Material/GetList'
    expect(buildReadSourceConfigPayload(draft).readPath).toBe('/K3API/Material/GetList')
    draft.readPath = '/K3API/Material/GetList'
    expect(buildReadSourceConfigPayload(draft).readPath).toBe('/K3API/Material/GetList')
  })

  it('B4 seed payload equals the real frozen backend contract for a selected K3 system', () => {
    const payload = buildReadSourceConfigPayload(createK3WiseMaterialListB4Draft('sys_1'))
    expect(payload).toEqual(b4Contract.buildK3WiseMaterialListB4Config({ systemId: 'sys_1' }))
    expect(buildReadSourceConfigPayload(createReadSourceConfigDraft()).actionProfileVersion).toBeUndefined()
    const drifted = createK3WiseMaterialListB4Draft('sys_1')
    drifted.fieldMap[0].target = 'otherUnit'
    expect(isK3WiseMaterialListB4Draft(drifted)).toBe(false)
    expect(validateReadSourceDraft(drifted)).toContain('K3 B4 受审配置已变化，请重新选择模板')
    const hiddenDrift = createK3WiseMaterialListB4Draft('sys_1')
    hiddenDrift.keyField = 'FNumber'
    expect(isK3WiseMaterialListB4Draft(hiddenDrift)).toBe(false)
    expect(validateReadSourceDraft(hiddenDrift)).toContain('K3 B4 受审配置已变化，请重新选择模板')
  })
})

// --- component tests ---------------------------------------------------------

const SYSTEMS: WorkbenchExternalSystem[] = [
  { id: 'sys_1', tenantId: 'default', workspaceId: null, name: 'K3 WISE', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
  { id: 'sys_k3_other', tenantId: 'default', workspaceId: null, name: 'K3 WISE 2', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
  { id: 'sys_http', tenantId: 'default', workspaceId: null, name: 'Generic HTTP', kind: 'http', role: 'source', status: 'active' },
]

describe('IntegrationReadSourceConfigPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalConfirmDescriptor: PropertyDescriptor | undefined
  let confirmMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    apiFetchMock.mockReset()
    originalConfirmDescriptor = Object.getOwnPropertyDescriptor(window, 'confirm')
    confirmMock = vi.fn(() => true)
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirmMock })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalConfirmDescriptor) Object.defineProperty(window, 'confirm', originalConfirmDescriptor)
    else Reflect.deleteProperty(window, 'confirm')
    app = null
    container = null
  })

  function mountPanel(scope = { tenantId: 'default', workspaceId: null as string | null }, rerender?: Ref<number>, hasIntegrationAdmin = false): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => {
        void rerender?.value
        return h(IntegrationReadSourceConfigPanel, {
          scope: rerender ? { ...scope } : scope,
          systems: SYSTEMS,
          hasIntegrationAdmin,
          // IU-3 (design-lock integration-iu3-read-source-wizard-design-lock-20260707.md): the panel
          // now defaults its new-config surface to the four-step wizard; every assertion in this file
          // targets the pre-existing expert flat form's testids, so pin the panel to expert mode via
          // the new prop. PROP ADDITION ONLY — no existing assertion in this file changed (design-lock
          // §2 既有测试不变量). The wizard surface + the wizard↔expert toggle are covered by
          // IntegrationReadSourceWizard.spec.ts, which mounts this same panel in its default mode.
          initialViewMode: 'expert' as const,
        })
      },
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

  it('offers an explicit B4 path without automatically probing or saving', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()
    apiFetchMock.mockClear()
    q<HTMLButtonElement>(root, 'rsc-b4-enter').click()
    await flushUi()
    expect(q(root, 'rsc-b4-panel').textContent).toContain('k3wise.material_list.v1')
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('B4 resets inherited smoke state and exposes bounded evidence without row values', async () => {
    const probeBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/read-source-probe')) {
        probeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return jsonResponse({
          ok: false,
          object: 'material',
          mode: 'list_page',
          boundedSmoke: true,
          boundedSmokeExecuted: true,
          containerLocated: false,
          containers: { primary: { type: 'missing' } },
          errorCode: 'READ_SOURCE_PROBE_TIMEOUT',
          rows: [{ FNumber: 'SECRET-ROW-VALUE' }],
        })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    const ordinarySmoke = q<HTMLInputElement>(root, 'rsc-bounded-smoke')
    ordinarySmoke.checked = true
    ordinarySmoke.dispatchEvent(new Event('change'))
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-enter').click()
    await flushUi()
    expect(q<HTMLInputElement>(root, 'rsc-b4-bounded-smoke').checked).toBe(false)
    setSelect(root, 'rsc-b4-system', 'sys_1')
    await flushUi()
    const b4Smoke = q<HTMLInputElement>(root, 'rsc-b4-bounded-smoke')
    b4Smoke.checked = true
    b4Smoke.dispatchEvent(new Event('change'))
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-probe').click()
    await waitUntil(() => probeBodies.length === 1, 'B4 probe POST starts')
    await waitUntil(() => root.querySelector('[data-testid="rsc-b4-evidence"]') !== null, 'B4 evidence appears')
    expect(probeBodies[0]).toEqual({
      config: b4Contract.buildK3WiseMaterialListB4Config({ systemId: 'sys_1' }),
      boundedSmoke: true,
    })
    expect(q(root, 'rsc-b4-evidence').textContent).toContain('boundedSmokeExecuted=true')
    expect(q(root, 'rsc-b4-evidence').textContent).toContain('READ_SOURCE_PROBE_TIMEOUT')
    expect(q(root, 'rsc-b4-evidence').textContent).not.toContain('SECRET-ROW-VALUE')
  })

  it('B4 selects only K3 systems and saves the exact frozen contract with a store-minted version', async () => {
    const savedBodies: Array<{ config: Record<string, unknown> }> = []
    const approvedIds: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/approve') && init?.method === 'POST') {
        approvedIds.push(url)
        return jsonResponse({ id: 'cfg_b4', version: 7, status: 'approved' })
      }
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        savedBodies.push(JSON.parse(String(init.body)) as { config: Record<string, unknown> })
        return jsonResponse({ id: 'cfg_b4', version: 7, status: 'draft', reused: false, contentKey: 'ck_b4' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-enter').click()
    await flushUi()
    expect(q<HTMLSelectElement>(root, 'rsc-b4-system').querySelector('option[value="sys_http"]')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'rsc-b4-save').disabled).toBe(true)
    setSelect(root, 'rsc-b4-system', 'sys_k3_other')
    await flushUi()
    expect(q(root, 'rsc-b4-fixed').textContent).toContain('/K3API/Material/GetList')
    expect(q(root, 'rsc-b4-fixed').textContent).toContain('Data.DATA')
    expect(q(root, 'rsc-b4-fixed').textContent).toContain('FUnitID → baseUnit')
    expect(q(root, 'rsc-b4-fixed').querySelector('input')).toBeNull()
    q<HTMLButtonElement>(root, 'rsc-b4-save').click()
    await waitUntil(() => savedBodies.length === 1, 'B4 save POST starts')
    await waitUntil(() => root.querySelector('[data-testid="rsc-b4-save-result"]')?.textContent?.includes('v7') === true, 'minted version appears')
    expect(savedBodies[0].config).toEqual(b4Contract.buildK3WiseMaterialListB4Config({ systemId: 'sys_k3_other' }))
    expect(q(root, 'rsc-b4-panel').textContent).toContain('保存后须单独审批')
    q<HTMLButtonElement>(root, 'rsc-b4-approve').click()
    await waitUntil(() => approvedIds.length === 1, 'existing approval POST starts')
    expect(approvedIds[0]).toContain('/api/integration/read-source-configs/cfg_b4/approve')
    await waitUntil(() => root.querySelector('[data-testid="rsc-b4-approve"]') === null, 'approved result settles')
    expect(q(root, 'rsc-b4-save-result').textContent).toContain('已审批')
  })

  it('exiting B4 clears its profile identity and returns to editable ordinary config', async () => {
    const savedBodies: Array<{ config: Record<string, unknown> }> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        savedBodies.push(JSON.parse(String(init.body)) as { config: Record<string, unknown> })
        return jsonResponse({ id: 'cfg_plain', version: 2, status: 'draft', reused: false, contentKey: 'ck' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-enter').click()
    await flushUi()
    setSelect(root, 'rsc-b4-system', 'sys_1')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-exit').click()
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-b4-panel"]')).toBeNull()
    await fillValidSingleRecordDraft(root)
    expect(q<HTMLInputElement>(root, 'rsc-read-path').readOnly).toBe(false)
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => savedBodies.length === 1, 'ordinary save POST starts')
    expect(savedBodies[0].config.actionProfileVersion).toBeUndefined()
  })

  it('does not resurrect B4 save results after system edit or scope switch', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    let saveCount = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        saveCount += 1
        return saveCount === 1 ? first.promise : second.promise
      }
      if (url.startsWith('/api/integration/read-source-configs')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse(null))
    })
    const scope = reactive({ tenantId: 'tenant_a', workspaceId: null as string | null })
    const root = mountPanel(scope)
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-enter').click()
    await flushUi()
    setSelect(root, 'rsc-b4-system', 'sys_1')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-save').click()
    await waitUntil(() => saveCount === 1, 'first B4 save starts')
    setSelect(root, 'rsc-b4-system', 'sys_k3_other')
    await flushUi()
    first.resolve(jsonResponse({ id: 'old', version: 4, status: 'draft', reused: false }))
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-b4-save-result"]')).toBeNull()
    q<HTMLButtonElement>(root, 'rsc-b4-save').click()
    await waitUntil(() => saveCount === 2, 'second B4 save starts')
    scope.tenantId = 'tenant_b'
    await flushUi()
    second.resolve(jsonResponse({ id: 'old_scope', version: 5, status: 'draft', reused: false }))
    await flushUi()
    expect(q<HTMLSelectElement>(root, 'rsc-b4-system').value).toBe('')
    expect(root.querySelector('[data-testid="rsc-b4-save-result"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-b4-approve"]')).toBeNull()
  })

  it('keeps B4 saved identity on an equal-value parent scope rerender', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        return jsonResponse({ id: 'cfg_b4', version: 9, status: 'draft', reused: false, contentKey: 'ck_b4' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const renderTick = ref(0)
    const root = mountPanel({ tenantId: 'default', workspaceId: null }, renderTick)
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-enter').click()
    await flushUi()
    setSelect(root, 'rsc-b4-system', 'sys_1')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-b4-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rsc-b4-save-result"]')?.textContent?.includes('v9') === true, 'B4 save settles')
    const before = apiFetchMock.mock.calls.length
    renderTick.value += 1
    await flushUi()
    expect(q<HTMLSelectElement>(root, 'rsc-b4-system').value).toBe('sys_1')
    expect(q(root, 'rsc-b4-save-result').textContent).toContain('v9')
    expect(apiFetchMock.mock.calls.length).toBe(before)
  })

  async function fillValidSingleRecordDraft(root: HTMLElement): Promise<void> {
    setSelect(root, 'rsc-system', 'sys_1')
    await flushUi()
    setInput(root, 'rsc-object', 'material')
    setInput(root, 'rsc-read-path', 'K3API/Material/GetDetail')
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

  function approvedRunRow(id: string, kind: 'b4' | 'bl2' = 'b4') {
    const config = buildReadSourceConfigPayload(kind === 'b4'
      ? createK3WiseMaterialListB4Draft('sys_1')
      : createK3WiseBomListByMaterialDraft('sys_1'))
    return { id, systemId: 'sys_1', object: config.object, mode: config.mode,
      version: 1, status: 'approved', contentKey: `synthetic-${id}`, config }
  }

  async function runControls(root: HTMLElement, id: string, kind: 'b4' | 'bl2' = 'b4'): Promise<HTMLButtonElement[]> {
    const child = q(root, `k3-${kind}-run-${id}`)
    if (kind === 'bl2') {
      // The real BL2 child clears its input when availability/generation changes.
      setInput(child, 'k3-bl2-key', '31415')
      await flushUi()
      return [q<HTMLButtonElement>(child, 'k3-bl2-read')]
    }
    return Array.from(child.querySelectorAll<HTMLButtonElement>('button'))
  }

  it.each(['b4', 'bl2'] as const)('releases %s controls after a failed retirement superseded by canceled approval, never while pending', async (kind) => {
    const pending = deferred<Response>()
    const row = approvedRunRow('cfg_pending', kind)
    const draftRow = { id: 'cfg_draft', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'synthetic-draft' }
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/cfg_pending/retire') && init?.method === 'POST') return pending.promise
      if (url.startsWith('/api/integration/read-source-configs?') && !init?.method) {
        listCalls += 1
        return Promise.resolve(jsonResponse([row, draftRow]))
      }
      throw new Error('Unexpected synthetic request')
    })
    const root = mountPanel(undefined, undefined, true)
    await waitUntil(() => root.querySelector(`[data-testid="k3-${kind}-run-cfg_pending"]`) !== null, 'real child mounts')
    const initialControls = await runControls(root, row.id, kind)
    expect(initialControls).toHaveLength(kind === 'b4' ? 2 : 1)
    expect(initialControls.every(button => !button.disabled)).toBe(true)

    q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending').click()
    await flushUi()
    confirmMock.mockReturnValueOnce(false)
    q<HTMLButtonElement>(root, 'rsc-approve-cfg_draft').click()
    await flushUi()
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).includes('/approve'))).toHaveLength(0)
    expect((await runControls(root, row.id, kind)).every(button => button.disabled)).toBe(true)

    q<HTMLButtonElement>(root, 'rsc-refresh').click()
    await flushUi(20)
    await waitUntil(() => listCalls === 2 && !q<HTMLButtonElement>(root, 'rsc-refresh').disabled, 'pending retirement list refresh settles')
    expect(q(root, 'rsc-status-cfg_pending').textContent).toContain('已审批')
    const pendingControls = await runControls(root, row.id, kind)
    expect(pendingControls.every(button => button.disabled)).toBe(true)
    for (const button of pendingControls) button.click()
    expect(apiFetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)

    pending.resolve(errorResponse(409, 'READ_SOURCE_REQUEST_FAILED', 'synthetic_retire_failure'))
    await flushUi(20)
    q<HTMLButtonElement>(root, 'rsc-refresh').click()
    await flushUi(20)
    await waitUntil(() => listCalls === 3 && !q<HTMLButtonElement>(root, 'rsc-refresh').disabled, 'failed retirement list refresh settles')
    expect(q(root, 'rsc-status-cfg_pending').textContent).toContain('已审批')
    expect(root.querySelector('[data-testid="rsc-error"]')).toBeNull()
    expect((await runControls(root, row.id, kind)).every(button => !button.disabled)).toBe(true)
  })

  it('keeps one retirement per row through refresh and equal-value parent rerenders', async () => {
    const pending = deferred<Response>()
    const row = approvedRunRow('cfg_pending')
    const renderTick = ref(0)
    let retireCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/retire') && init?.method === 'POST') {
        retireCalls += 1
        return pending.promise
      }
      return Promise.resolve(jsonResponse([row]))
    })
    const root = mountPanel(undefined, renderTick)
    await waitUntil(() => root.querySelector('[data-testid="k3-b4-run-cfg_pending"]') !== null, 'real child mounts')
    expect(root.querySelector('[data-testid="k3-b4-sync"]')).toBeNull()
    const retireButton = q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending')
    retireButton.click()
    // Dispatch directly before DOM updates to exercise the handler guard as well as :disabled.
    retireButton.dispatchEvent(new Event('click'))
    renderTick.value += 1
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-refresh').click()
    await flushUi(20)
    expect(retireCalls).toBe(1)
    expect(q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending').disabled).toBe(true)
    expect((await runControls(root, row.id)).every(button => button.disabled)).toBe(true)
    pending.resolve(errorResponse(409, 'READ_SOURCE_REQUEST_FAILED', 'synthetic_retire_failure'))
    await flushUi(20)
    expect(q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending').disabled).toBe(false)
    expect((await runControls(root, row.id)).every(button => !button.disabled)).toBe(true)
  })

  it.each(['older-first', 'newer-first'] as const)('releases concurrent retirement rows independently (%s) and keeps the latest action error', async (order) => {
    const older = deferred<Response>()
    const newer = deferred<Response>()
    const rows = [approvedRunRow('cfg_a'), approvedRunRow('cfg_b')]
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return url.includes('/cfg_a/') ? older.promise : newer.promise
      return Promise.resolve(jsonResponse(rows))
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="k3-b4-run-cfg_b"]') !== null, 'two real children mount')
    q<HTMLButtonElement>(root, 'rsc-retire-cfg_a').click()
    q<HTMLButtonElement>(root, 'rsc-retire-cfg_b').click()
    await flushUi()
    expect((await runControls(root, 'cfg_a')).every(button => button.disabled)).toBe(true)
    expect((await runControls(root, 'cfg_b')).every(button => button.disabled)).toBe(true)
    const first = order === 'older-first' ? { pending: older, id: 'cfg_a', reason: 'older_failure' } : { pending: newer, id: 'cfg_b', reason: 'newer_failure' }
    const second = order === 'older-first' ? { pending: newer, id: 'cfg_b', reason: 'newer_failure' } : { pending: older, id: 'cfg_a', reason: 'older_failure' }
    first.pending.resolve(errorResponse(409, 'READ_SOURCE_REQUEST_FAILED', first.reason))
    await flushUi(20)
    expect((await runControls(root, first.id)).every(button => !button.disabled)).toBe(true)
    expect((await runControls(root, second.id)).every(button => button.disabled)).toBe(true)
    second.pending.resolve(errorResponse(409, 'READ_SOURCE_REQUEST_FAILED', second.reason))
    await flushUi(20)
    expect((await runControls(root, second.id)).every(button => !button.disabled)).toBe(true)
    expect(q(root, 'rsc-error').textContent).toContain('newer_failure')
    expect(q(root, 'rsc-error').textContent).not.toContain('older_failure')
  })

  it('refreshes a successful retirement even after another approval is canceled, holding controls until the list settles', async () => {
    const pending = deferred<Response>()
    const afterRetire = deferred<Response>()
    const row = approvedRunRow('cfg_pending')
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/retire') && init?.method === 'POST') return pending.promise
      listCalls += 1
      if (listCalls > 1) return afterRetire.promise
      return Promise.resolve(jsonResponse([row, { ...row, id: 'cfg_draft', status: 'draft' }]))
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="k3-b4-run-cfg_pending"]') !== null, 'real child mounts')
    q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending').click()
    confirmMock.mockReturnValueOnce(false)
    q<HTMLButtonElement>(root, 'rsc-approve-cfg_draft').click()
    pending.resolve(jsonResponse({ ...row, status: 'retired' }))
    await flushUi(20)
    expect(listCalls).toBe(2)
    expect(q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending').disabled).toBe(true)
    expect((await runControls(root, row.id)).every(button => button.disabled)).toBe(true)
    afterRetire.resolve(jsonResponse([{ ...row, status: 'retired' }]))
    await flushUi(20)
    expect(q(root, 'rsc-status-cfg_pending').textContent).toContain('已停用')
    expect(root.querySelector('[data-testid="k3-b4-run-cfg_pending"]')).toBeNull()
  })

  it.each([
    ['scope', 'success'], ['scope', 'failure'], ['session', 'success'], ['session', 'failure'],
  ] as const)('ignores stale retirement %s/%s without clearing a newer same-ID slot', async (change, outcome) => {
    const oldRetire = deferred<Response>()
    const newRetire = deferred<Response>()
    const row = approvedRunRow('cfg_shared')
    const scope = reactive({ tenantId: 'tenant_old', workspaceId: null as string | null })
    let retireCalls = 0
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/retire') && init?.method === 'POST') return ++retireCalls === 1 ? oldRetire.promise : newRetire.promise
      listCalls += 1
      return Promise.resolve(jsonResponse([row]))
    })
    const root = mountPanel(scope)
    await waitUntil(() => root.querySelector('[data-testid="k3-b4-run-cfg_shared"]') !== null, 'old child mounts')
    q<HTMLButtonElement>(root, 'rsc-retire-cfg_shared').click()
    await flushUi()
    if (change === 'scope') scope.tenantId = 'tenant_new'
    else {
      // A reset signal also invalidates work when the token text is unchanged.
      notifyAuthPrincipalChange()
      await flushUi()
      q<HTMLButtonElement>(root, 'rsc-refresh').click()
    }
    await flushUi(20)
    q<HTMLButtonElement>(root, 'rsc-retire-cfg_shared').click()
    await flushUi()
    expect(retireCalls).toBe(2)
    const listsBeforeOld = listCalls
    oldRetire.resolve(outcome === 'success' ? jsonResponse({ ...row, status: 'retired' }) : errorResponse(409, 'READ_SOURCE_REQUEST_FAILED', 'old_context'))
    await flushUi(20)
    expect(listCalls).toBe(listsBeforeOld)
    expect(root.querySelector('[data-testid="rsc-error"]')).toBeNull()
    expect(q(root, 'rsc-status-cfg_shared').textContent).toContain('已审批')
    expect((await runControls(root, row.id)).every(button => button.disabled)).toBe(true)
    expect(q<HTMLButtonElement>(root, 'rsc-retire-cfg_shared').disabled).toBe(true)
    newRetire.resolve(errorResponse(409, 'READ_SOURCE_REQUEST_FAILED', 'new_context'))
    await flushUi(20)
    expect(q(root, 'rsc-error').textContent).toContain('new_context')
    expect((await runControls(root, row.id)).every(button => !button.disabled)).toBe(true)
  })

  it('does not refresh or render a retirement completion after unmount', async () => {
    const pending = deferred<Response>()
    const row = approvedRunRow('cfg_pending')
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/retire') && init?.method === 'POST') return pending.promise
      listCalls += 1
      return Promise.resolve(jsonResponse([row]))
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="k3-b4-run-cfg_pending"]') !== null, 'real child mounts')
    q<HTMLButtonElement>(root, 'rsc-retire-cfg_pending').click()
    await flushUi()
    app?.unmount()
    app = null
    pending.resolve(jsonResponse({ ...row, status: 'retired' }))
    await flushUi(20)
    expect(listCalls).toBe(1)
    expect(root.textContent).toBe('')
  })

  // IU-6a (design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md
  // #3739): the saved-configs empty state must guide, not just say "nothing here" — one line for
  // "what is this list" and one line for "what's the first step".
  it('renders a guided empty state (what-this-is + first-step) when there are no saved configs', async () => {
    mockListOnly([])
    const root = mountPanel()
    await flushUi()

    const empty = q(root, 'rsc-empty')
    expect(empty).not.toBeNull()
    const what = q(root, 'rsc-empty-what')
    const firstStep = q(root, 'rsc-empty-first-step')
    expect(what.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(firstStep.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    // Default test-env locale is 'en' (see localstorage.ts setup) — assert the guidance actually
    // mentions the concrete first action (probe → save), not a generic "no data" placeholder.
    expect(firstStep.textContent).toMatch(/probe/i)
    expect(firstStep.textContent).toMatch(/save version/i)

    // zh variant coverage (quality-gate finding on IU-6: the en assertions above never see the zh
    // copy, so it could rot to a generic placeholder unnoticed). Switch locale via the composable's
    // setter (the module-level ref is resolved once at import — localStorage alone won't flip it),
    // remount, and assert the concrete first action is mentioned in zh too.
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockListOnly([])
      const zhRoot = mountPanel()
      await flushUi()
      const zhFirstStep = q(zhRoot, 'rsc-empty-first-step')
      expect(zhFirstStep.textContent).toContain('定位容器探测')
      expect(zhFirstStep.textContent).toContain('保存版本')
    } finally {
      setLocale('en')
    }
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

    // resolver_lookup R3: resolverRule select appears; per-rule inputs show/hide.
    setSelect(root, 'rsc-mode', 'resolver_lookup')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-resolver-rule"]')).not.toBeNull()
    // exactly_one: none of the three rule-specific inputs render.
    setSelect(root, 'rsc-resolver-rule', 'exactly_one')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-resolver-sort-field"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-sort-direction"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-discriminator-field"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-discriminator-value"]')).toBeNull()
    // first_when_sorted: sort field + direction, NO discriminator value.
    setSelect(root, 'rsc-resolver-rule', 'first_when_sorted')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-resolver-sort-field"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-sort-direction"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-discriminator-value"]')).toBeNull()
    // field_equals: discriminator field + value, NO sort direction.
    setSelect(root, 'rsc-resolver-rule', 'field_equals')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-resolver-discriminator-field"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-discriminator-value"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-resolver-sort-direction"]')).toBeNull()

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

    // IU-1: the humanized label renders prominently; the raw code is still present (demoted) for
    // expert troubleshooting. Test environment defaults useLocale() to 'en'.
    expect(q(root, 'rsc-evidence-error-label').textContent).toContain('The target data container could not be found.')
    expect(q(root, 'rsc-evidence-error-code').textContent).toContain('READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
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

  it('does not restore a saved version for an edited draft after an older save completes', async () => {
    const pendingSave = deferred<Response>()
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') return pendingSave.promise
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)

    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => apiFetchMock.mock.calls.some(([url, init]) => String(url).startsWith('/api/integration/read-source-configs') && init?.method === 'POST'), 'save starts')
    setInput(root, 'rsc-object', 'new-material')
    await flushUi()

    pendingSave.resolve(jsonResponse({ id: 'cfg_old', version: 1, status: 'draft', reused: false, contentKey: 'ck' }))
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-save-result"]')).toBeNull()
  })

  it('keeps the new scope list when an older scope refresh completes late', async () => {
    const oldList = deferred<Response>()
    const scope = reactive({ tenantId: 'tenant_old', workspaceId: null as string | null })
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('tenantId=tenant_old')) return oldList.promise
      if (url.includes('tenantId=tenant_new')) return Promise.resolve(jsonResponse([
        { id: 'cfg_new', systemId: 'sys_1', object: 'new-material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'new' },
      ]))
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel(scope)
    await waitUntil(() => apiFetchMock.mock.calls.some(([url]) => String(url).includes('tenantId=tenant_old')), 'old list starts')

    scope.tenantId = 'tenant_new'
    await waitUntil(() => apiFetchMock.mock.calls.some(([url]) => String(url).includes('tenantId=tenant_new')), 'new list starts')
    await waitUntil(() => root.querySelector('[data-testid="rsc-row-cfg_new"]') !== null, 'new list renders')

    oldList.resolve(jsonResponse([
      { id: 'cfg_old', systemId: 'sys_1', object: 'old-material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'old' },
    ]))
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-row-cfg_old"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-row-cfg_new"]')).not.toBeNull()
  })

  it('ignores an old probe failure after the key changes and keeps the newer probe busy', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const probeBodies: string[] = []
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/read-source-probe')) {
        probeBodies.push(String(init?.body))
        return probeBodies.length === 1 ? first.promise : second.promise
      }
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    setInput(root, 'rsc-probe-key', 'M-OLD')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await waitUntil(() => probeBodies.length === 1, 'first probe starts')

    setInput(root, 'rsc-probe-key', 'M-NEW')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await waitUntil(() => probeBodies.length === 2, 'second probe starts')
    first.resolve(errorResponse(400, 'READ_SOURCE_PROBE_CONTRACT_INVALID', 'old_request'))
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'rsc-probe').disabled).toBe(true)
    expect(root.querySelector('[data-testid="rsc-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-probe-evidence"]')).toBeNull()

    second.resolve(jsonResponse({ ok: true, object: 'material', mode: 'single_record', boundedSmoke: false, containers: {}, containerLocated: true }))
    await waitUntil(() => root.querySelector('[data-testid="rsc-probe-evidence"]') !== null, 'new probe appears')
    expect(JSON.parse(probeBodies[0]).inputs.key).toBe('M-OLD')
    expect(JSON.parse(probeBodies[1]).inputs.key).toBe('M-NEW')
    expect(q(root, 'rsc-evidence-ok').textContent).toContain('true')
  })

  it('keeps a saved version when only probe inputs change', async () => {
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'cfg_saved', version: 2, status: 'draft', reused: false, contentKey: 'ck' }))
      }
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rsc-save-result"]') !== null, 'saved version appears')

    setInput(root, 'rsc-probe-key', 'M-NEW')
    const smoke = q<HTMLInputElement>(root, 'rsc-bounded-smoke')
    smoke.checked = true
    smoke.dispatchEvent(new Event('change'))
    await flushUi()
    expect(q(root, 'rsc-save-result').textContent).toContain('v2')
  })

  it('keeps results when a parent rerenders with an equal new scope object', async () => {
    const rerender = ref(0)
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'cfg_saved', version: 2, status: 'draft', reused: false, contentKey: 'ck' }))
      }
      if (url.includes('/read-source-probe')) {
        return Promise.resolve(jsonResponse({ ok: true, object: 'material', mode: 'single_record', boundedSmoke: false, containers: {}, containerLocated: true }))
      }
      if (url.startsWith('/api/integration/read-source-configs')) listCalls += 1
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel({ tenantId: 'default', workspaceId: null }, rerender)
    await flushUi()
    await fillValidSingleRecordDraft(root)
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rsc-save-result"]') !== null, 'save appears')
    setInput(root, 'rsc-probe-key', 'M-001')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await waitUntil(() => root.querySelector('[data-testid="rsc-probe-evidence"]') !== null, 'probe appears')
    const listsBefore = listCalls

    rerender.value += 1
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-save-result"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="rsc-probe-evidence"]')).not.toBeNull()
    expect(listCalls).toBe(listsBefore)
  })

  it('keeps the newer save busy and prevents an old completion from refreshing the list', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const saveBodies: string[] = []
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        saveBodies.push(String(init.body))
        return saveBodies.length === 1 ? first.promise : second.promise
      }
      if (url.startsWith('/api/integration/read-source-configs')) listCalls += 1
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => saveBodies.length === 1, 'first save starts')

    setInput(root, 'rsc-object', 'new-material')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => saveBodies.length === 2, 'second save starts')
    const listsBeforeOld = listCalls
    first.resolve(jsonResponse({ id: 'cfg_old', version: 1, status: 'draft', reused: false, contentKey: 'old' }))
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'rsc-save').disabled).toBe(true)
    expect(root.querySelector('[data-testid="rsc-save-result"]')).toBeNull()
    expect(listCalls).toBe(listsBeforeOld)

    second.resolve(jsonResponse({ id: 'cfg_new', version: 2, status: 'draft', reused: false, contentKey: 'new' }))
    await waitUntil(() => (root.querySelector('[data-testid="rsc-save-result"]')?.textContent ?? '').includes('v2'), 'new save appears')
    expect(JSON.parse(saveBodies[0]).config.object).toBe('material')
    expect(JSON.parse(saveBodies[1]).config.object).toBe('new-material')
    expect(listCalls).toBe(listsBeforeOld + 1)
  })

  it('clears old scope audit and ignores its delayed failure', async () => {
    const oldAudit = deferred<Response>()
    const scope = reactive({ tenantId: 'tenant_old', workspaceId: null as string | null })
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/audit')) return oldAudit.promise
      if (url.includes('tenantId=tenant_old')) return Promise.resolve(jsonResponse([
        { id: 'cfg_old', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'old' },
      ]))
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel(scope)
    await waitUntil(() => root.querySelector('[data-testid="rsc-row-cfg_old"]') !== null, 'old row appears')
    q<HTMLButtonElement>(root, 'rsc-audit-toggle-cfg_old').click()
    await waitUntil(() => apiFetchMock.mock.calls.some(([url]) => String(url).includes('/audit')), 'audit starts')

    scope.tenantId = 'tenant_new'
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-row-cfg_old"]')).toBeNull()
    oldAudit.resolve(errorResponse(400, 'READ_SOURCE_REQUEST_FAILED', 'old_scope'))
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-audit-list"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-error"]')).toBeNull()
  })

  it('keeps the latest audit row when an earlier audit request completes late', async () => {
    const oldAudit = deferred<Response>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/cfg_a/audit')) return oldAudit.promise
      if (url.includes('/cfg_b/audit')) return Promise.resolve(jsonResponse([
        { action: 'save_version', actor: 'actor_b', detail: {}, createdAt: '2026-07-01T00:00:00Z' },
      ]))
      return Promise.resolve(jsonResponse([
        { id: 'cfg_a', systemId: 'sys_1', object: 'a', mode: 'single_record', version: 1, status: 'draft', contentKey: 'a' },
        { id: 'cfg_b', systemId: 'sys_1', object: 'b', mode: 'single_record', version: 1, status: 'draft', contentKey: 'b' },
      ]))
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="rsc-row-cfg_b"]') !== null, 'rows appear')
    q<HTMLButtonElement>(root, 'rsc-audit-toggle-cfg_a').click()
    await waitUntil(() => apiFetchMock.mock.calls.some(([url]) => String(url).includes('/cfg_a/audit')), 'first audit starts')
    q<HTMLButtonElement>(root, 'rsc-audit-toggle-cfg_b').click()
    await waitUntil(() => (root.querySelector('[data-testid="rsc-audit-list"]')?.textContent ?? '').includes('actor_b'), 'second audit appears')

    oldAudit.resolve(jsonResponse([{ action: 'save_version', actor: 'actor_a', detail: {}, createdAt: '2026-07-01T00:00:00Z' }]))
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-audit-cfg_a"]')).toBeNull()
    expect(q(root, 'rsc-audit-cfg_b').textContent).toContain('actor_b')
    expect(q(root, 'rsc-audit-cfg_b').textContent).not.toContain('actor_a')
  })

  it('does not start a new-scope refresh after an old-scope approval settles', async () => {
    const oldApprove = deferred<Response>()
    const scope = reactive({ tenantId: 'tenant_old', workspaceId: null as string | null })
    const urls: string[] = []
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      urls.push(url)
      if (url.includes('/approve') && init?.method === 'POST') return oldApprove.promise
      if (url.includes('tenantId=tenant_old')) return Promise.resolve(jsonResponse([
        { id: 'cfg_old', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'draft', contentKey: 'old' },
      ]))
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel(scope)
    await waitUntil(() => root.querySelector('[data-testid="rsc-approve-cfg_old"]') !== null, 'old row appears')
    q<HTMLButtonElement>(root, 'rsc-approve-cfg_old').click()
    await waitUntil(() => urls.some((url) => url.includes('/approve')), 'approval starts')
    expect(urls.find((url) => url.includes('/approve'))).toContain('tenantId=tenant_old')

    scope.tenantId = 'tenant_new'
    await waitUntil(() => urls.some((url) => url.includes('tenantId=tenant_new')), 'new scope list starts')
    const newScopeListCount = urls.filter((url) => url.startsWith('/api/integration/read-source-configs?') && url.includes('tenantId=tenant_new')).length
    oldApprove.resolve(jsonResponse({ id: 'cfg_old', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'approved', contentKey: 'old' }))
    await flushUi()
    expect(urls.filter((url) => url.startsWith('/api/integration/read-source-configs?') && url.includes('tenantId=tenant_new'))).toHaveLength(newScopeListCount)
    expect(root.querySelector('[data-testid="rsc-row-cfg_old"]')).toBeNull()
  })

  it('does not refresh after an in-flight save settles following unmount', async () => {
    const pendingSave = deferred<Response>()
    let listCalls = 0
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') return pendingSave.promise
      if (url.startsWith('/api/integration/read-source-configs')) listCalls += 1
      return Promise.resolve(jsonResponse([]))
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => apiFetchMock.mock.calls.some(([url, init]) => String(url).startsWith('/api/integration/read-source-configs') && init?.method === 'POST'), 'save starts')
    const listsBeforeUnmount = listCalls
    app?.unmount()
    app = null
    pendingSave.resolve(jsonResponse({ id: 'cfg_old', version: 1, status: 'draft', reused: false, contentKey: 'old' }))
    await flushUi()
    expect(listCalls).toBe(listsBeforeUnmount)
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

  it('switching the external system clears stale probe evidence and save state', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      if (url.includes('/read-source-probe')) {
        return jsonResponse({
          ok: true,
          object: 'material',
          mode: 'single_record',
          boundedSmoke: false,
          containers: { primary: { type: 'object', arrayLength: null } },
          containerLocated: true,
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
    await waitUntil(() => root.querySelector('[data-testid="rsc-probe-evidence"]') !== null, 'probe evidence appears')

    setSelect(root, 'rsc-system', 'sys_http')
    await flushUi()
    expect(root.querySelector('[data-testid="rsc-probe-evidence"]')).toBeNull()
    expect(root.querySelector('[data-testid="rsc-save-result"]')).toBeNull()
  })

  it('clamps hostile top-level error code/reason before they can reach the DOM', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      if (url.includes('/read-source-probe')) {
        return errorResponse(400, 'FAILED M-001 https://k3host', 'Value M-001 leaked')
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)
    setInput(root, 'rsc-probe-key', 'M-001')
    await flushUi()

    q<HTMLButtonElement>(root, 'rsc-probe').click()
    await waitUntil(() => root.querySelector('[data-testid="rsc-error"]') !== null, 'error appears')

    const message = q(root, 'rsc-error').textContent ?? ''
    expect(message).toContain('READ_SOURCE_REQUEST_FAILED')
    for (const leak of ['M-001', 'k3host', 'leaked']) {
      expect(root.innerHTML.includes(leak), leak).toBe(false)
    }
  })

  it('save 400 renders a coarse per-field list and drops hostile tuples', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: false,
          error: {
            code: 'READ_SOURCE_CONFIG_INVALID',
            message: 'coarse',
            details: {
              errors: [
                { code: 'READ_SOURCE_ENDPOINT_NOT_RELATIVE', field: 'readPath', reason: 'not_safe_relative_path' },
                { code: 'READ_SOURCE_KEY_FIELD_INVALID', field: 'keyField', reason: 'invalid_identifier' },
                { code: 'READ_SOURCE_X', field: '<img src=x> M-001', reason: 'bad reason with spaces' },
                { code: 'lower_case_code M-001', field: 'object', reason: 'ok_reason' },
              ],
            },
          },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fillValidSingleRecordDraft(root)

    q<HTMLButtonElement>(root, 'rsc-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rsc-error"]') !== null, 'save error appears')

    const message = q(root, 'rsc-error').textContent ?? ''
    expect(message).toContain('READ_SOURCE_CONFIG_INVALID')
    expect(message).toContain('readPath: not_safe_relative_path')
    expect(message).toContain('keyField: invalid_identifier')
    for (const leak of ['<img', 'M-001', 'bad reason with spaces', 'lower_case_code']) {
      expect(root.innerHTML.includes(leak), leak).toBe(false)
    }
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
