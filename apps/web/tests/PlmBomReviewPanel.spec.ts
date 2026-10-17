import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { BOM_WRITE_PENDING_STORAGE_KEY, commitFrozenBomWrite } from '../src/services/plm/plmBomWritePending'

const getContextMock = vi.fn()
const updateLineMock = vi.fn()
const ecoIntentMock = vi.fn()
vi.mock('../src/services/integration/workbench', () => ({
  getPlmBomMultitableContext: (...args: unknown[]) => getContextMock(...args),
  updatePlmBomMultitableLine: (...args: unknown[]) => updateLineMock(...args),
  requestPlmBomEcoRevisionIntent: (...args: unknown[]) => ecoIntentMock(...args),
}))

const listBindingsMock = vi.fn()
const managementUrlMock = vi.fn()
const bindGrantMock = vi.fn()
const unbindMock = vi.fn()
const retryRevokeMock = vi.fn()
vi.mock('../src/services/plm/plmBomWriteBindings', () => ({
  listPlmBomWriteBindings: (...args: unknown[]) => listBindingsMock(...args),
  getPlmBomWriteManagementUrl: (...args: unknown[]) => managementUrlMock(...args),
  bindPlmBomWriteGrant: (...args: unknown[]) => bindGrantMock(...args),
  unbindPlmBomWriteBinding: (...args: unknown[]) => unbindMock(...args),
  retryPlmBomWriteRetiredRevocations: (...args: unknown[]) => retryRevokeMock(...args),
  PlmBomWriteBindingError: class PlmBomWriteBindingError extends Error {
    readonly code: string
    constructor(code: string) {
      super('绑定操作未完成。')
      this.code = code
    }
  },
}))

import PlmBomReviewPanel from '../src/components/plm/PlmBomReviewPanel.vue'

const BOUND = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-1',
  metaTenantId: 'tenant-1',
  dataSourceId: 'plm-ds',
  connectionId: 'conn-1',
  subjectId: 'person-1',
  targetOrigin: 'https://plm.example',
  yuantusTenantId: 'yt-1',
  yuantusOrgId: 'yo-1',
  workspaceId: null,
  scopeKind: 'workspace',
  grantId: 'abc123',
  generation: 1,
  expiresAt: '2026-12-01T00:00:00.000Z',
  bound: true,
  remoteRevokeState: null,
  previousGrantRevokeState: null,
}

const CONTEXT = {
  // Root part state 'Draft': the write specs below model the provider's Draft fast-path (200 on
  // write). A locked root (Released/Suspended/Obsolete) now advisory-pre-gates editing entirely —
  // covered by the dedicated ECO Phase 0 pre-gate specs, not the write-path specs. (The old
  // 'Released' fixture value contradicted the provider, which 409s writes under a locked root.)
  part: { part_id: 'P1', item_number: 'P-001', name: 'Assembly', state: 'Draft', generation: 3 },
  lines: [
    { bom_line_id: 'R1', part_id: 'C1', write_etag: '"bom-line:etag-r1"', item_number: 'C-001', name: 'Bracket', state: 'Draft', generation: 1, quantity: 2, uom: 'EA', find_num: '10', refdes: 'R1,R2', level: 1, path: ['P1'], path_labels: ['P-001'], source_version: 1, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
    { bom_line_id: 'R2', part_id: 'D1', item_number: 'D-001', name: 'Screw', state: 'Released', generation: 2, quantity: 4, uom: 'EA', find_num: '20', refdes: 'R3', level: 2, path: ['P1', 'C1'], path_labels: ['P-001', 'C-001'], source_version: 2, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
  ],
  source_version: 3,
  source_updated_at: '2026-06-05T00:00:00',
  sync_status: 'snapshot',
  template_key: 'bom_review',
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let app: VueApp | null = null
let container: HTMLDivElement

function mountPanel(dataSourceId = 'plm-ds', extraProps: Record<string, unknown> = {}): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(PlmBomReviewPanel, { dataSourceId, ...extraProps })
  app.mount(container)
}

function stateOf(): string | null {
  return container.querySelector('[data-testid="plm-bom-review-state"]')?.getAttribute('data-state') ?? null
}

async function setPartAndLoad(partId: string): Promise<void> {
  const input = container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement
  input.value = partId
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
  ;(container.querySelector('[data-testid="plm-bom-review-load"]') as HTMLButtonElement).click()
  await flushUi()
}

beforeEach(() => {
  listBindingsMock.mockResolvedValue([{ ...BOUND }])
  managementUrlMock.mockResolvedValue('https://plm.example/personal-approval-grants#bom-write')
  bindGrantMock.mockResolvedValue({ ...BOUND })
  unbindMock.mockResolvedValue({ ...BOUND, bound: false, remoteRevokeState: 'pending' })
  retryRevokeMock.mockResolvedValue(undefined)
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  getContextMock.mockReset()
  updateLineMock.mockReset()
  ecoIntentMock.mockReset()
  listBindingsMock.mockReset()
  managementUrlMock.mockReset()
  bindGrantMock.mockReset()
  unbindMock.mockReset()
  retryRevokeMock.mockReset()
  clearPendingStorage()
  localStorage.removeItem('auth_token')
  vi.unstubAllGlobals()
})

function pendingStored(): string {
  const chunks: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const name = localStorage.key(index)
    if (name?.startsWith(`${BOM_WRITE_PENDING_STORAGE_KEY}.`)) chunks.push(localStorage.getItem(name) ?? '')
  }
  return chunks.join('\n')
}

function clearPendingStorage(): void {
  const names: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const name = localStorage.key(index)
    if (name === BOM_WRITE_PENDING_STORAGE_KEY || name?.startsWith(`${BOM_WRITE_PENDING_STORAGE_KEY}.`)) names.push(name)
  }
  for (const name of names) localStorage.removeItem(name)
}

function cloneContext() {
  return JSON.parse(JSON.stringify(CONTEXT))
}

describe('PlmBomReviewPanel (P3-C BOM review + governed write-back)', () => {
  it('is idle and does NOT call the BOM or binding services on mount', async () => {
    mountPanel()
    await flushUi()
    expect(getContextMock).not.toHaveBeenCalled()
    expect(listBindingsMock).not.toHaveBeenCalled()
    expect(managementUrlMock).not.toHaveBeenCalled()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('idle')
    expect(container.querySelector('[data-testid="plm-bom-write-bindings"]')).toBeNull()
  })

  it('loads + renders the read-only table with stable row keys, hierarchy, qty + provenance', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    expect(getContextMock).toHaveBeenCalledWith('plm-ds', 'P1', expect.any(AbortSignal))
    expect(listBindingsMock).not.toHaveBeenCalled()
    expect(managementUrlMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('table')
    const rows = container.querySelectorAll('[data-testid="plm-bom-review-row"]')
    expect(rows.length).toBe(2)
    // bom_line_id is the STABLE row key; level encodes the hierarchy
    expect((rows[0] as HTMLElement).dataset.bomLineId).toBe('R1')
    expect((rows[1] as HTMLElement).dataset.bomLineId).toBe('R2')
    expect((rows[1] as HTMLElement).dataset.level).toBe('2')
    // quantity + uom are editable in the standalone workbench panel
    expect((container.querySelector('[data-testid="plm-bom-review-quantity-input"]') as HTMLInputElement).value).toBe('2')
    expect((container.querySelector('[data-testid="plm-bom-review-uom-input"]') as HTMLInputElement).value).toBe('EA')
    expect(container.textContent).toContain('2026-06-05T00:00:00')
  })

  it('submits editable cells with a UI-owned Idempotency-Key and updates the row on success', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: true, bom_line_id: 'R1' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    const quantity = container.querySelector('[data-testid="plm-bom-review-quantity-input"]') as HTMLInputElement
    quantity.value = '6'
    quantity.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateLineMock).toHaveBeenCalledWith('plm-ds', 'P1', 'R1', { quantity: 6 }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(container.textContent).toContain('写回成功。')
    expect(quantity.value).toBe('6')
  })

  it('uses the projected write_etag for the next distinct edit after an accepted line receipt', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('submit-key-1')
      .mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    const projected = cloneContext()
    projected.lines[0].write_etag = '"bom-line:etag-r2"'
    getContextMock
      .mockResolvedValueOnce({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
      .mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: projected })
    updateLineMock.mockResolvedValue({ ok: true, bom_line_id: 'R1' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    const quantity = container.querySelector('[data-testid="plm-bom-review-quantity-input"]') as HTMLInputElement
    quantity.value = '6'
    quantity.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { quantity: 6 }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(getContextMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', expect.any(AbortSignal))
    expect(container.textContent).toContain('写回成功。')
    expect(quantity.value).toBe('6')
    expect(pendingStored()).not.toContain('submit-key-1')

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-2', '"bom-line:etag-r2"')
    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(quantity.value).toBe('6')
    const row = container.querySelector('[data-testid="plm-bom-review-row"][data-bom-line-id="R1"]')
    expect(row?.textContent).toContain('写回成功。')
    expect(row?.textContent).not.toContain('结果尚未确认')
  })

  it('keeps an accepted line success when the etag refresh fails and leaves other unknown snapshots', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('submit-key-1')
      .mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    commitFrozenBomWrite({
      clientKey: 'unknown-key-9',
      operationKind: 'line',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: 'R9',
      patch: { refdes: 'KEEP' },
      ifMatch: '"bom-line:etag-old"',
      identity: {
        ownerId: 'owner-1',
        metaTenantId: 'tenant-1',
        dataSourceId: 'plm-ds',
        connectionId: 'conn-1',
        subjectId: 'person-1',
        targetOrigin: 'https://plm.example',
        yuantusTenantId: 'yt-1',
        yuantusOrgId: 'yo-1',
        workspaceId: null,
        scopeKind: 'workspace',
      },
    })
    const loaded = { data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() }
    getContextMock
      .mockResolvedValueOnce(loaded)
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue(loaded)
    updateLineMock.mockResolvedValue({ ok: true, bom_line_id: 'R1' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    const quantity = container.querySelector('[data-testid="plm-bom-review-quantity-input"]') as HTMLInputElement
    quantity.value = '6'
    quantity.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    const row = container.querySelector('[data-testid="plm-bom-review-row"][data-bom-line-id="R1"]')
    expect(row?.textContent).toContain('写回成功。')
    expect(row?.textContent).not.toContain('结果尚未确认')
    expect(quantity.value).toBe('6')
    expect(getContextMock).toHaveBeenCalledTimes(2)
    expect(pendingStored()).not.toContain('submit-key-1')
    expect(pendingStored()).toContain('unknown-key-9')
    expect(pendingStored()).toContain('KEEP')

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R8'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R8' }, 'submit-key-2', '"bom-line:etag-r1"')
    expect(pendingStored()).toContain('unknown-key-9')
    expect(pendingStored()).not.toContain('submit-key-1')
  })

  it('does not paint a late etag refresh after the captured target is no longer current', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    commitFrozenBomWrite({
      clientKey: 'unknown-key-9',
      operationKind: 'line',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: 'R9',
      patch: { refdes: 'KEEP' },
      ifMatch: '"bom-line:etag-old"',
      identity: {
        ownerId: 'owner-1',
        metaTenantId: 'tenant-1',
        dataSourceId: 'plm-ds',
        connectionId: 'conn-1',
        subjectId: 'person-1',
        targetOrigin: 'https://plm.example',
        yuantusTenantId: 'yt-1',
        yuantusOrgId: 'yo-1',
        workspaceId: null,
        scopeKind: 'workspace',
      },
    })
    const source = ref('plm-ds')
    let resolveRefresh: (value: unknown) => void = () => {}
    getContextMock.mockImplementation(() => {
      if (getContextMock.mock.calls.length === 1) {
        return Promise.resolve({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
      }
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    })
    updateLineMock.mockResolvedValue({ ok: true, bom_line_id: 'R1' })
    const Harness = defineComponent({
      name: 'BomEtagSourceHarness',
      setup() {
        return () => h(PlmBomReviewPanel, { dataSourceId: source.value })
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(Harness)
    app.mount(container)
    await flushUi()
    await setPartAndLoad('P1')

    const quantity = container.querySelector('[data-testid="plm-bom-review-quantity-input"]') as HTMLInputElement
    quantity.value = '6'
    quantity.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()
    expect(getContextMock).toHaveBeenCalledTimes(2)
    expect(updateLineMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('写回成功。')

    source.value = 'other-ds'
    await flushUi()
    const stale = cloneContext()
    stale.part.name = 'stale-projection'
    stale.lines[0].write_etag = '"bom-line:etag-invented"'
    resolveRefresh({ data_source_id: 'plm-ds', available: true, entitled: true, context: stale })
    await flushUi()

    expect(container.textContent).not.toContain('stale-projection')
    expect(container.textContent).not.toContain('Assembly')
    expect(container.textContent).not.toContain('写回成功')
    expect(stateOf()).toBe('idle')
    expect(pendingStored()).not.toContain('submit-key-1')
    expect(pendingStored()).toContain('unknown-key-9')
    expect(pendingStored()).toContain('KEEP')
  })

  it('keeps a failed submit actionable so the user can retry the same logical edit', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('submit-key-1')
      .mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock
      .mockResolvedValueOnce({ ok: false, status: 409, reason: 'provider-rejected', message: 'locked' })
      .mockResolvedValueOnce({ ok: true, bom_line_id: 'R1' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    const save = container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement
    save.click()
    await flushUi()
    expect(container.textContent).toContain('不要更换提交键')
    save.click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('写回成功。')
  })

  it('on a 412 conflict keeps the frozen key, body, and If-Match and does not reload', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('submit-key-1')
      .mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock
      .mockResolvedValueOnce({ ok: false, status: 412, reason: 'precondition-failed', message: 'stale etag' })
      .mockResolvedValueOnce({ ok: true, bom_line_id: 'R1' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(getContextMock).toHaveBeenCalledTimes(1)

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('原 If-Match')
    expect(container.textContent).not.toContain('写回成功。')

    const refdes2 = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes2.value = 'R10'
    refdes2.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('写回成功。')
  })

  // --- ECO Phase 0: discriminated-409 handling + advisory locked pre-gate -----------------------

  it('renders the distinct ECO guidance when the write is rejected with reason lifecycle_locked', async () => {
    // The residual race: the advisory pre-gate saw an editable state, but the provider's
    // authoritative lock rejected the write with the discriminated code.
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({
      ok: false,
      status: 409,
      reason: 'lifecycle_locked',
      message: "Item is locked in state 'Released'",
    })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container.textContent).toContain('ECO')
    expect(container.textContent).toContain('生命周期锁定')
    // NOT the generic conflated 409 copy
    expect(container.textContent).not.toContain('提交键已用于不同写入')
  })

  it('on reason idempotency_conflict replays the same frozen key instead of minting a new one', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('submit-key-1')
      .mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        reason: 'idempotency_conflict',
        message: 'Idempotency-Key reused for a different write',
      })
      .mockResolvedValueOnce({ ok: true, bom_line_id: 'R1' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    const save = container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement
    save.click()
    await flushUi()
    expect(container.textContent).toContain('不要更换提交键')
    expect(container.textContent).not.toContain('更换新的提交键')
    save.click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('写回成功。')
  })

  it('advisory-pre-gates editing (banner + no inputs) when the ROOT part is in a locked state', async () => {
    const locked = cloneContext()
    locked.part.state = 'Released'
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: locked })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    expect(stateOf()).toBe('table')
    // rows still render (read-only review stays useful) ...
    expect(container.querySelectorAll('[data-testid="plm-bom-review-row"]').length).toBe(2)
    // ... but no cell is editable and the ECO guidance banner shows
    expect(container.querySelector('[data-testid="plm-bom-review-quantity-input"]')).toBeNull()
    expect(container.querySelector('[data-testid="plm-bom-review-locked-hint"]')).not.toBeNull()
    expect(container.textContent).toContain('ECO')
  })

  it('does NOT pre-gate on a locked per-line CHILD state (the gate keys on the root part only)', async () => {
    // line R2's child state is 'Released' in the shared fixture while the root is 'Draft' --
    // per-line state is the CHILD part's state and must not disable editing.
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    expect(container.querySelector('[data-testid="plm-bom-review-locked-hint"]')).toBeNull()
    expect(container.querySelector('[data-testid="plm-bom-review-quantity-input"]')).not.toBeNull()
  })

  it('shows the upgrade affordance (no table) when supported but not entitled', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: false, context: null })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('upgrade')
    expect(container.querySelector('[data-testid="plm-bom-review-row"]')).toBeNull()
  })

  it('degrades to unavailable when the relay reports no support (old PLM)', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: false, reason: 'unsupported' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('unavailable')
  })

  it('shows empty state when entitled but the context is null with NO reason (part not found)', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: null })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('empty')
    expect(container.querySelector('[data-testid="plm-bom-review-error"]')).toBeNull()
  })

  it('shows a transient ERROR (not empty) when entitled + null context carries reason:unavailable', async () => {
    // a transient provider fetch failure must read as "temporarily unavailable, retry", NOT
    // as "this part has no BOM".
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: null, reason: 'unavailable' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('error')
    expect(container.querySelector('[data-testid="plm-bom-review-error"]')).not.toBeNull()
  })
})

describe('ECO Phase 3: locked-BOM revision-intent CTA', () => {
  function lockedContextResult() {
    const locked = cloneContext()
    locked.part.state = 'Released'
    return { data_source_id: 'plm-ds', available: true, entitled: true, context: locked }
  }

  it('CTA hidden on a locked part when the capability pre-gate is OFF (prop absent)', async () => {
    getContextMock.mockResolvedValue(lockedContextResult())
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(container.querySelector('[data-testid="plm-bom-review-locked-hint"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent"]')).toBeNull()
  })

  it('CTA shown at the advisory-locked banner when the capability pre-gate is ON', async () => {
    getContextMock.mockResolvedValue(lockedContextResult())
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]')).not.toBeNull()
  })

  it('CTA surfaces REACTIVELY after a write-back lifecycle_locked 409 (advisory gate missed the lock)', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 409, reason: 'lifecycle_locked', message: 'locked' })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    // root is Draft -> no CTA up front
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent"]')).toBeNull()

    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]')).not.toBeNull()
  })

  it('create outcome: done message carries the new ECO id and the button disables', async () => {
    getContextMock.mockResolvedValue(lockedContextResult())
    ecoIntentMock.mockResolvedValue({ ok: true, eco_id: 'ECO-77', state: 'progress', attached: false })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click()
    await flushUi()

    expect(ecoIntentMock.mock.calls[0]?.[0]).toBe('plm-ds')
    expect(ecoIntentMock.mock.calls[0]?.[1]).toBe('P1')
    expect(ecoIntentMock.mock.calls[0]?.[2]).toEqual(expect.any(String))
    expect(String(ecoIntentMock.mock.calls[0]?.[2]).length).toBeGreaterThan(8)
    const msg = container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')
    expect(msg?.textContent).toContain('ECO-77')
    expect(msg?.textContent).toContain('已发起 ECO 修订')
    expect((container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('attach outcome: message names the EXISTING open ECO (anti-sprawl surfaced honestly)', async () => {
    getContextMock.mockResolvedValue(lockedContextResult())
    ecoIntentMock.mockResolvedValue({ ok: true, eco_id: 'ECO-OLD', state: 'draft', attached: true })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click()
    await flushUi()

    const msg = container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')
    expect(msg?.textContent).toContain('ECO-OLD')
    expect(msg?.textContent).toContain('已挂接')
  })

  it('not_locked outcome: resets the reactive lock, hides the button, KEEPS the explanation and the frozen retry', async () => {
    const randomUUID = vi.fn().mockReturnValue('submit-key-1')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 409, reason: 'lifecycle_locked', message: 'locked' })
    ecoIntentMock.mockResolvedValue({ ok: false, status: 409, reason: 'not_locked', message: 'editable' })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = 'R9'
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]')).toBeNull()
    const msg = container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')
    expect(msg?.textContent).toContain('未处于锁定状态')
    const retry = container.querySelector('[data-testid="plm-bom-write-retry"][data-operation="eco-intent"]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    const firstKey = ecoIntentMock.mock.calls[0]?.[2]
    retry.click()
    await flushUi()
    expect(ecoIntentMock.mock.calls[1]?.[2]).toBe(firstKey)
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })

  it('eco_intent_rejected outcome: retry-able message, button back to idle, same key', async () => {
    const randomUUID = vi.fn().mockReturnValue('eco-key-1')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue(lockedContextResult())
    ecoIntentMock.mockResolvedValue({ ok: false, status: 409, reason: 'eco_intent_rejected', message: 'race' })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    const button = container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement
    button.click()
    await flushUi()

    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')?.textContent).toContain('被拒')
    expect((container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).disabled).toBe(false)
    button.click()
    await flushUi()
    expect(ecoIntentMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'eco-key-1')
    expect(ecoIntentMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'eco-key-1')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('a fresh load resets the CTA state machine (message + done state cleared)', async () => {
    getContextMock.mockResolvedValue(lockedContextResult())
    ecoIntentMock.mockResolvedValue({ ok: true, eco_id: 'ECO-77', state: 'progress', attached: false })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')).not.toBeNull()

    await setPartAndLoad('P1')
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')).toBeNull()
    expect((container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('personal BOM frozen retry', () => {
  function installFailingStorage(): void {
    const current = localStorage
    const failing = {
      getItem: (key: string) => current.getItem(key),
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: (key: string) => current.removeItem(key),
      clear: () => current.clear(),
      key: (index: number) => current.key(index),
      get length() {
        return current.length
      },
    }
    Object.defineProperty(globalThis, 'localStorage', { value: failing, configurable: true, writable: true })
    Object.defineProperty(window, 'localStorage', { value: failing, configurable: true, writable: true })
  }

  async function editRefdes(value: string): Promise<void> {
    const refdes = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes.value = value
    refdes.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }

  function clickSave(): void {
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
  }

  it('fetches binding metadata only after the management CTA is opened', async () => {
    mountPanel()
    await flushUi()
    expect(listBindingsMock).not.toHaveBeenCalled()
    ;(container.querySelector('[data-testid="plm-bom-write-bindings-open"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container.querySelector('[data-testid="plm-bom-write-bindings"]')).not.toBeNull()
    expect(listBindingsMock).toHaveBeenCalled()
    expect(managementUrlMock).toHaveBeenCalledWith('plm-ds', expect.anything())
    const link = container.querySelector('[data-testid="plm-bom-write-management-link"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://plm.example/personal-approval-grants#bom-write')
    expect(link.hash).toBe('#bom-write')
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(getContextMock).not.toHaveBeenCalled()
  })

  it('keeps an unknown line write frozen across refresh and ignores a later edit', async () => {
    const randomUUID = vi.fn().mockReturnValueOnce('submit-key-1').mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 503, reason: 'unknown', message: 'hidden' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    await editRefdes('R10')
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)

    app?.unmount()
    container.remove()
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    const save = container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const retry = container.querySelector('[data-testid="plm-bom-write-retry"][data-bom-line-id="R1"]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    retry.click()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(3, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(pendingStored()).toContain('submit-key-1')
    expect(pendingStored()).not.toContain('R10')
  })

  it('replays a frozen ECO with the same key after remount', async () => {
    const randomUUID = vi.fn().mockReturnValue('eco-key-9')
    vi.stubGlobal('crypto', { randomUUID })
    const locked = cloneContext()
    locked.part.state = 'Released'
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: locked })
    ecoIntentMock.mockResolvedValue({ ok: false, status: 503, reason: 'unknown', message: 'hidden' })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click()
    await flushUi()
    app?.unmount()
    container.remove()
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    expect(container.textContent).toContain('未确认')
    ;(container.querySelector('[data-testid="plm-bom-write-retry"][data-operation="eco-intent"]') as HTMLButtonElement).click()
    await flushUi()
    expect(ecoIntentMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'eco-key-9')
    expect(ecoIntentMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'eco-key-9')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    const stored = pendingStored()
    expect(stored).toContain('eco-key-9')
    expect(stored).toContain('"patch":null')
  })

  it('keeps both 403 histories pending and does not mint a new key', async () => {
    const randomUUID = vi.fn().mockReturnValue('submit-key-1')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({
      ok: false,
      status: 403,
      reason: 'provider-rejected',
      message: 'hidden',
      attemptOutcome: 'refused',
      operationMayHaveApplied: true,
      retryPolicy: 'same-operation',
    })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    clickSave()
    await flushUi()
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(3)
    for (const call of updateLineMock.mock.calls) {
      expect(call).toEqual(['plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"'])
    }
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('可能已经生效')
    expect(container.textContent).not.toContain('无写回授权')
    expect(pendingStored()).toContain('submit-key-1')
  })

  it('allows same-person grant rotation and refuses a changed person without refreezing', async () => {
    const randomUUID = vi.fn().mockReturnValueOnce('submit-key-1').mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 503, reason: 'unknown', message: 'x' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    listBindingsMock.mockResolvedValue([{ ...BOUND, grantId: 'rotated', generation: 4 }])
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')

    listBindingsMock.mockResolvedValue([{ ...BOUND, subjectId: 'person-2', grantId: 'other', generation: 9 }])
    await editRefdes('R10')
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(2)
    expect(randomUUID).toHaveBeenCalledTimes(1)
    const stored = pendingStored()
    expect(stored).toContain('person-1')
    expect(stored).toContain('R9')
    expect(stored).not.toContain('person-2')
    expect(stored).not.toContain('R10')
    expect(container.textContent).toContain('另一身份')
  })

  it('sends no write when the snapshot cannot be stored', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    installFailingStorage()
    await editRefdes('R9')
    clickSave()
    await flushUi()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('无法保存可恢复的提交快照')
  })

  it('does not apply an in-flight success after the session changes', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    let resolveWrite: (value: unknown) => void = () => {}
    updateLineMock.mockReturnValue(new Promise((resolve) => {
      resolveWrite = resolve
    }))
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(1)
    localStorage.setItem('auth_token', 'next-session')
    notifyAuthPrincipalChange()
    await Promise.resolve()
    await Promise.resolve()
    resolveWrite({ ok: true, bom_line_id: 'R1' })
    await flushUi()
    expect(container.textContent).not.toContain('写回成功')
    expect(pendingStored()).toContain('submit-key-1')
  })

  it('does not apply an in-flight success onto a different part or source', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockImplementation(async (_dataSourceId: string, part: string) => {
      const context = cloneContext()
      context.part.part_id = part
      return { data_source_id: 'plm-ds', available: true, entitled: true, context }
    })
    let resolveWrite: (value: unknown) => void = () => {}
    updateLineMock.mockReturnValue(new Promise((resolve) => {
      resolveWrite = resolve
    }))
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    await setPartAndLoad('P2')
    resolveWrite({ ok: true, bom_line_id: 'R1' })
    await flushUi()
    expect(container.textContent).not.toContain('写回成功')
    expect(pendingStored()).not.toContain('submit-key-1')

    app?.unmount()
    container.remove()
    const source = ref('plm-ds')
    const Harness = defineComponent({
      name: 'BomSourceHarness',
      setup() {
        return () => h(PlmBomReviewPanel, { dataSourceId: source.value })
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(Harness)
    app.mount(container)
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    let resolveSource: (value: unknown) => void = () => {}
    updateLineMock.mockReturnValue(new Promise((resolve) => {
      resolveSource = resolve
    }))
    clickSave()
    await flushUi()
    source.value = 'other-ds'
    await flushUi()
    resolveSource({ ok: true, bom_line_id: 'R1' })
    await flushUi()
    expect(container.textContent).not.toContain('写回成功')
    expect(updateLineMock.mock.calls.at(-1)?.[0]).toBe('plm-ds')
  })

  it('shows frozen-context separately from a native lock and keeps the pending row', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 409, reason: 'frozen-context', message: 'hidden' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    expect(container.textContent).toContain('没有发出新的写入')
    expect(container.textContent).not.toContain('生命周期锁定')
    expect(pendingStored()).toContain('submit-key-1')
  })

  it('keeps a 412 snapshot and sends an explicit new operation beside it', async () => {
    const randomUUID = vi.fn().mockReturnValueOnce('submit-key-1').mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock
      .mockResolvedValueOnce({ ok: false, status: 412, reason: 'precondition-failed', message: 'stale' })
      .mockResolvedValueOnce({ ok: false, status: 422, reason: 'invalid', message: 'bad' })
      .mockResolvedValueOnce({ ok: false, status: 503, reason: 'unknown', message: 'x' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    expect(container.querySelector('[data-testid="plm-bom-write-separate"]')).not.toBeNull()
    await editRefdes('R10')
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    ;(container.querySelector('[data-testid="plm-bom-write-separate"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(3, 'plm-ds', 'P1', 'R1', { refdes: 'R10' }, 'submit-key-2', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(2)
    const stored = pendingStored()
    expect(stored).toContain('submit-key-1')
    expect(stored).toContain('submit-key-2')
    expect(stored).toContain('R9')
    expect(stored).toContain('R10')
  })

  it('keeps the other identity snapshot and sends an explicit current-identity operation', async () => {
    const randomUUID = vi.fn().mockReturnValueOnce('submit-key-1').mockReturnValueOnce('submit-key-2')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 503, reason: 'unknown', message: 'x' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    listBindingsMock.mockResolvedValue([{ ...BOUND, subjectId: 'person-2', grantId: 'other', generation: 9 }])
    await editRefdes('R10')
    clickSave()
    await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(1)
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(pendingStored()).not.toContain('person-2')
    const separate = container.querySelector('[data-testid="plm-bom-write-separate-identity"]') as HTMLButtonElement
    expect(separate).not.toBeNull()
    separate.click()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R10' }, 'submit-key-2', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(2)
    const stored = pendingStored()
    expect(stored).toContain('person-1')
    expect(stored).toContain('person-2')
    expect(stored).toContain('R9')
    expect(stored).toContain('R10')
  })

  function contextNamed(part: string, name: string) {
    const context = cloneContext()
    context.part.part_id = part
    context.part.name = name
    return { data_source_id: 'plm-ds', available: true, entitled: true, context }
  }

  function mountSource(source: { value: string }): void {
    const Harness = defineComponent({
      name: 'BomSourceHarness',
      setup() {
        return () => h(PlmBomReviewPanel, { dataSourceId: source.value })
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(Harness)
    app.mount(container)
  }

  it('drops a delayed context when the data source changes', async () => {
    const source = ref('plm-ds-a')
    let resolveContext: (value: unknown) => void = () => {}
    getContextMock.mockImplementation(() => new Promise((resolve) => {
      resolveContext = resolve
    }))
    mountSource(source)
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('loading')
    source.value = 'plm-ds-b'
    await flushUi()
    const signal = getContextMock.mock.calls[0]?.[2] as AbortSignal
    expect(signal.aborted).toBe(true)
    resolveContext(contextNamed('P1', 'from-source-a'))
    await flushUi()
    expect(container.textContent).not.toContain('from-source-a')
    expect(stateOf()).toBe('idle')
    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(getContextMock.mock.calls[0]?.[0]).toBe('plm-ds-a')
  })

  it('drops delayed part contexts across part A then B then A', async () => {
    const queued: Array<(value: unknown) => void> = []
    getContextMock.mockImplementation((_dataSourceId: string, part: string) => new Promise((resolve) => {
      queued.push((value) => resolve(value ?? contextNamed(part, `unused-${part}`)))
    }))
    mountPanel()
    await flushUi()
    await setPartAndLoad('PA')
    await setPartAndLoad('PB')
    await setPartAndLoad('PA')
    expect(queued).toHaveLength(3)
    expect((getContextMock.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true)
    expect((getContextMock.mock.calls[1]?.[2] as AbortSignal).aborted).toBe(true)
    expect((getContextMock.mock.calls[2]?.[2] as AbortSignal).aborted).toBe(false)
    queued[0]?.(contextNamed('PA', 'stale-alpha'))
    await flushUi()
    expect(container.textContent).not.toContain('stale-alpha')
    expect(stateOf()).toBe('loading')
    queued[1]?.(contextNamed('PB', 'mid-beta'))
    await flushUi()
    expect(container.textContent).not.toContain('mid-beta')
    expect(stateOf()).toBe('loading')
    queued[2]?.(contextNamed('PA', 'fresh-gamma'))
    await flushUi()
    expect(container.textContent).toContain('fresh-gamma')
    expect(container.textContent).not.toContain('stale-alpha')
    expect(container.textContent).not.toContain('mid-beta')
    expect(stateOf()).toBe('table')
    expect(getContextMock.mock.calls.map((call) => call[1])).toEqual(['PA', 'PB', 'PA'])
  })

  it('sends no write when the source, part, or session changes during binding lookup', async () => {
    getContextMock.mockImplementation((_dataSourceId: string, part: string) => Promise.resolve(contextNamed(part, part === 'P1' ? 'Assembly' : 'Part-Beta')))
    const source = ref('plm-ds')
    let resolveBindings: (value: unknown) => void = () => {}
    listBindingsMock.mockImplementation(() => new Promise((resolve) => {
      resolveBindings = resolve
    }))
    mountSource(source)
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    expect(updateLineMock).not.toHaveBeenCalled()
    source.value = 'other-ds'
    await flushUi()
    expect((listBindingsMock.mock.calls.at(-1)?.[0] as AbortSignal).aborted).toBe(true)
    resolveBindings([{ ...BOUND }])
    await flushUi()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('idle')
    expect(container.textContent).not.toContain('Assembly')
    expect(pendingStored()).not.toContain('R9')

    app?.unmount()
    container.remove()
    resolveBindings = () => {}
    listBindingsMock.mockImplementation(() => new Promise((resolve) => {
      resolveBindings = resolve
    }))
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    await setPartAndLoad('P2')
    expect((listBindingsMock.mock.calls.at(-1)?.[0] as AbortSignal).aborted).toBe(true)
    resolveBindings([{ ...BOUND }])
    await flushUi()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Part-Beta')
    expect(container.textContent).not.toContain('写回成功')
    expect(pendingStored()).not.toContain('R9')

    app?.unmount()
    container.remove()
    resolveBindings = () => {}
    listBindingsMock.mockImplementation(() => new Promise((resolve) => {
      resolveBindings = resolve
    }))
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    await editRefdes('R9')
    clickSave()
    await flushUi()
    localStorage.setItem('auth_token', 'next-session')
    notifyAuthPrincipalChange()
    await flushUi()
    expect((listBindingsMock.mock.calls.at(-1)?.[0] as AbortSignal).aborted).toBe(true)
    resolveBindings([{ ...BOUND }])
    await flushUi()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('写回成功')
    expect(container.textContent).toContain('Assembly')
    expect(pendingStored()).not.toContain('R9')
  })

  it('shows only the verified owner pending rows and keeps the other owner stored', async () => {
    const ownerIdentity = {
      metaTenantId: 'tenant-1',
      dataSourceId: 'plm-ds',
      connectionId: 'conn-1',
      targetOrigin: 'https://plm.example',
      yuantusTenantId: 'yt-1',
      yuantusOrgId: 'yo-1',
      workspaceId: null,
      scopeKind: 'workspace',
    }
    commitFrozenBomWrite({
      clientKey: 'owner-key-1',
      operationKind: 'line',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: 'R1',
      patch: { refdes: 'OWN-1' },
      ifMatch: '"bom-line:etag-r1"',
      identity: { ...ownerIdentity, ownerId: 'owner-1', subjectId: 'person-1' },
    })
    commitFrozenBomWrite({
      clientKey: 'owner-key-2',
      operationKind: 'line',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: 'R9',
      patch: { refdes: 'OWN-2' },
      ifMatch: '"bom-line:etag-r1"',
      identity: { ...ownerIdentity, ownerId: 'owner-2', subjectId: 'person-2' },
    })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 503, reason: 'unknown', message: 'x' })
    listBindingsMock.mockResolvedValue([{ ...BOUND }])
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    const lineIds = () => [...container.querySelectorAll('[data-testid="plm-bom-write-retry"]')]
      .map((node) => (node as HTMLElement).dataset.bomLineId)
    expect(lineIds()).toEqual(['R1'])
    expect(container.textContent).not.toContain('OWN-2')
    expect(pendingStored()).toContain('OWN-1')
    expect(pendingStored()).toContain('OWN-2')
    expect(pendingStored()).toContain('owner-2')

    listBindingsMock.mockResolvedValue([{ ...BOUND, ownerId: 'owner-2', subjectId: 'person-2', grantId: 'other' }])
    localStorage.setItem('auth_token', 'next-owner')
    notifyAuthPrincipalChange()
    await flushUi()
    expect(lineIds()).toEqual(['R9'])
    expect(container.textContent).not.toContain('OWN-1')
    expect(pendingStored()).toContain('owner-key-1')
    expect(pendingStored()).toContain('owner-key-2')
    ;(container.querySelector('[data-testid="plm-bom-write-retry"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(1)
    expect(updateLineMock).toHaveBeenCalledWith('plm-ds', 'P1', 'R9', { refdes: 'OWN-2' }, 'owner-key-2', '"bom-line:etag-r1"')
    expect(pendingStored()).toContain('OWN-1')
    expect(pendingStored()).toContain('owner-key-1')
  })

  it('hides a foreign scope line and still offers identity recovery', async () => {
    const foreign = {
      ownerId: 'owner-1',
      metaTenantId: 'tenant-old',
      dataSourceId: 'plm-ds',
      connectionId: 'conn-1',
      subjectId: 'person-old',
      targetOrigin: 'https://old.example',
      yuantusTenantId: 'yt-1',
      yuantusOrgId: 'yo-1',
      workspaceId: null,
      scopeKind: 'workspace',
    }
    commitFrozenBomWrite({
      clientKey: 'scope-key-old',
      operationKind: 'line',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: 'OLD-1',
      patch: { refdes: 'FOREIGN-PATCH' },
      ifMatch: '"bom-line:etag-old"',
      identity: foreign,
    })
    commitFrozenBomWrite({
      clientKey: 'scope-key-r1',
      operationKind: 'line',
      dataSourceId: 'plm-ds',
      partId: 'P1',
      bomLineId: 'R1',
      patch: { refdes: 'SLOT-PATCH' },
      ifMatch: '"bom-line:etag-old"',
      identity: foreign,
    })
    const randomUUID = vi.fn().mockReturnValue('submit-key-b')
    vi.stubGlobal('crypto', { randomUUID })
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    updateLineMock.mockResolvedValue({ ok: false, status: 503, reason: 'unknown', message: 'x' })
    listBindingsMock.mockResolvedValue([{ ...BOUND }])
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    const retryIds = () => [...container.querySelectorAll('[data-testid="plm-bom-write-retry"]')]
      .map((node) => (node as HTMLElement).dataset.bomLineId)
    expect(retryIds()).toEqual([])
    expect(container.textContent).not.toContain('OLD-1')
    expect(container.textContent).not.toContain('FOREIGN-PATCH')
    expect(container.textContent).not.toContain('SLOT-PATCH')
    expect(container.textContent).not.toContain('重试未确认的行写入')
    expect(pendingStored()).toContain('scope-key-old')
    expect(pendingStored()).toContain('FOREIGN-PATCH')
    expect(pendingStored()).toContain('person-old')
    expect(pendingStored()).toContain('tenant-old')
    expect(pendingStored()).toContain('https://old.example')

    await editRefdes('R10')
    clickSave()
    await flushUi()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(retryIds()).toEqual([])
    expect(container.querySelector('[data-testid="plm-bom-write-separate-identity"]')).not.toBeNull()
    expect(container.textContent).toContain('另一身份')
    expect(container.textContent).not.toContain('OLD-1')
    expect(container.textContent).not.toContain('FOREIGN-PATCH')
    expect(container.textContent).not.toContain('SLOT-PATCH')
    expect(pendingStored()).not.toContain('submit-key-b')

    ;(container.querySelector('[data-testid="plm-bom-write-separate-identity"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(1)
    expect(updateLineMock).toHaveBeenCalledWith('plm-ds', 'P1', 'R1', { refdes: 'R10' }, 'submit-key-b', '"bom-line:etag-r1"')
    expect(retryIds()).toEqual(['R1'])
    expect(container.textContent).not.toContain('OLD-1')
    expect(container.textContent).not.toContain('FOREIGN-PATCH')
    expect(container.textContent).not.toContain('SLOT-PATCH')
    const stored = pendingStored()
    expect(stored).toContain('scope-key-old')
    expect(stored).toContain('scope-key-r1')
    expect(stored).toContain('submit-key-b')
    expect(stored).toContain('FOREIGN-PATCH')
    expect(stored).toContain('SLOT-PATCH')
    expect(stored).toContain('person-old')
    expect(stored).toContain('person-1')
  })
})

describe('initialPartId', () => {
  it('reads once on mount when a nonblank part is supplied and does not mutate', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel('plm-ds', { initialPartId: '  P1  ' })
    await flushUi()

    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(getContextMock).toHaveBeenCalledWith('plm-ds', 'P1', expect.any(AbortSignal))
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(listBindingsMock).not.toHaveBeenCalled()
    expect((container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('P1')
    expect(stateOf()).toBe('table')
  })

  it('keeps manual mode when initialPartId is blank', async () => {
    mountPanel('plm-ds', { initialPartId: '   ' })
    await flushUi()

    expect(getContextMock).not.toHaveBeenCalled()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(listBindingsMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('idle')
    expect((container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('')
  })

  it('does not autostart when initialPartId changes after mount', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    const initialPartId = ref('')
    const Harness = defineComponent({
      name: 'InitialPartHarness',
      setup() {
        return () => h(PlmBomReviewPanel, {
          dataSourceId: 'plm-ds',
          initialPartId: initialPartId.value || undefined,
        })
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(Harness)
    app.mount(container)
    await flushUi()

    initialPartId.value = 'P9'
    await flushUi()

    expect(getContextMock).not.toHaveBeenCalled()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('idle')
  })
})
