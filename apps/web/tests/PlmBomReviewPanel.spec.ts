import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef, type App as VueApp } from 'vue'

const getContextMock = vi.fn()
const updateLineMock = vi.fn()
const ecoIntentMock = vi.fn()
vi.mock('../src/services/integration/workbench', () => ({
  getPlmBomMultitableContext: (...args: unknown[]) => getContextMock(...args),
  updatePlmBomMultitableLine: (...args: unknown[]) => updateLineMock(...args),
  requestPlmBomEcoRevisionIntent: (...args: unknown[]) => ecoIntentMock(...args),
}))

import PlmBomReviewPanel from '../src/components/plm/PlmBomReviewPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

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

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  getContextMock.mockReset()
  updateLineMock.mockReset()
  ecoIntentMock.mockReset()
  vi.unstubAllGlobals()
})

function cloneContext() {
  return JSON.parse(JSON.stringify(CONTEXT))
}

describe('PlmBomReviewPanel (P3-C BOM review + governed write-back)', () => {
  it('is idle and does NOT call the service on mount', async () => {
    mountPanel()
    await flushUi()
    expect(getContextMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('idle')
  })

  it('loads + renders the read-only table with stable row keys, hierarchy, qty + provenance', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    expect(getContextMock).toHaveBeenCalledWith('plm-ds', 'P1')
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
    expect(container.textContent).toContain('不可写')
    save.click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('写回成功。')
  })

  it('on a 412 conflict reloads the fresh context, surfaces the conflict, sends write_etag verbatim, and re-mints the key', async () => {
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

    // the strong ETag rode as the 6th arg VERBATIM (literal quotes preserved -> byte round-trip)
    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    // 412 -> reloaded fresh context, surfaced the conflict, did NOT report success
    expect(getContextMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('已被他人修改')
    expect(container.textContent).not.toContain('写回成功。')

    // re-submit after the reload mints a FRESH key (the stale one was dropped) -> no cached replay
    const refdes2 = container.querySelector('[data-testid="plm-bom-review-refdes-input"]') as HTMLInputElement
    refdes2.value = 'R9'
    refdes2.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-2', '"bom-line:etag-r1"')
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

  it('on reason idempotency_conflict mints a FRESH key for the next submit (burned key never replayed)', async () => {
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
    expect(container.textContent).toContain('更换新的提交键')
    save.click()
    await flushUi()

    expect(updateLineMock).toHaveBeenNthCalledWith(1, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-1', '"bom-line:etag-r1"')
    // the burned key was dropped -> the retry minted submit-key-2 instead of replaying it
    expect(updateLineMock).toHaveBeenNthCalledWith(2, 'plm-ds', 'P1', 'R1', { refdes: 'R9' }, 'submit-key-2', '"bom-line:etag-r1"')
    expect(randomUUID).toHaveBeenCalledTimes(2)
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

    expect(ecoIntentMock).toHaveBeenCalledWith('plm-ds', 'P1')
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

  it('not_locked outcome: resets the reactive lock, hides the button, KEEPS the explanation visible', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'submit-key-1' })
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
  })

  it('eco_intent_rejected outcome: retry-able message, button back to idle', async () => {
    getContextMock.mockResolvedValue(lockedContextResult())
    ecoIntentMock.mockResolvedValue({ ok: false, status: 409, reason: 'eco_intent_rejected', message: 'race' })
    mountPanel('plm-ds', { ecoIntentEnabled: true })
    await flushUi()
    await setPartAndLoad('P1')
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent-message"]')?.textContent).toContain('被拒')
    expect((container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).disabled).toBe(false)
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


describe('BOM collaboration entry session boundary', () => {
  beforeEach(() => localStorage.setItem('auth_token', 'account-a'))
  afterEach(() => localStorage.removeItem('auth_token'))
  it('offers sharing only after an explicit successful BOM load', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel()
    expect(container.querySelector('[data-testid="plm-bom-collaboration-open"]')).toBeNull()
    await setPartAndLoad('P1')
    expect(container.querySelector('[data-testid="plm-bom-collaboration-open"]')).not.toBeNull()
  })
  it('clears the previous account BOM and sharing entry on a session switch', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel()
    await setPartAndLoad('P1')
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'account-b')
    await flushUi()
    expect(stateOf()).toBe('idle')
    expect(container.textContent).not.toContain('Assembly')
    expect(container.querySelector('[data-testid="plm-bom-collaboration-open"]')).toBeNull()
    expect(getContextMock).toHaveBeenCalledTimes(1)
  })
  it('does not restore a late BOM response after switching sessions', async () => {
    let resolve!: (value: unknown) => void
    getContextMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    mountPanel()
    await setPartAndLoad('P1')
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'account-b')
    resolve({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    await flushUi()
    expect(stateOf()).toBe('idle')
    expect(container.textContent).not.toContain('Assembly')
    expect(container.querySelector('[data-testid="plm-bom-collaboration-open"]')).toBeNull()
  })
})

describe('BOM return link prefill', () => {
  it('prefills a Part without loading until the explicit button is pressed', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    mountPanel('plm-ds', { initialPartId: 'P1' })
    await flushUi()
    expect((container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('P1')
    expect(getContextMock).not.toHaveBeenCalled()
    ;(container.querySelector('[data-testid="plm-bom-review-load"]') as HTMLButtonElement).click()
    await flushUi()
    expect(getContextMock).toHaveBeenCalledWith('plm-ds', 'P1')
    expect(container.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Assembly')
  })

  it('clears an already visible result when the source target changes, with no automatic fetch', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    const target = shallowRef({ dataSourceId: 'plm-ds', initialPartId: 'P1' })
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({ render: () => h(PlmBomReviewPanel, target.value) }); app.mount(container)
    await setPartAndLoad('P1')
    expect(container.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Assembly')
    target.value = { dataSourceId: 'other-ds', initialPartId: 'P2' }
    await flushUi()
    expect(container.querySelector('[data-testid="plm-bom-review-part"]')).toBeNull()
    expect(getContextMock).toHaveBeenCalledTimes(1)
  })

  it.each([412, 409])('BOM return link ignores an old pending PATCH %s after switching Part', async (status) => {
    let resolve!: (value: unknown) => void
    updateLineMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const oldContext = cloneContext()
    const nextContext = cloneContext(); nextContext.part.part_id = 'P2'
    getContextMock.mockResolvedValueOnce({ data_source_id: 'plm-ds', available: true, entitled: true, context: oldContext })
      .mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: nextContext })
    const target = shallowRef({ dataSourceId: 'plm-ds', initialPartId: 'P1', ecoIntentEnabled: true })
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({ render: () => h(PlmBomReviewPanel, target.value) }); app.mount(container)
    await setPartAndLoad('P1')
    const quantity = container.querySelector('[data-testid="plm-bom-review-quantity-input"]') as HTMLInputElement
    quantity.value = '6'; quantity.dispatchEvent(new Event('input', { bubbles: true })); await flushUi()
    ;(container.querySelector('[data-testid="plm-bom-review-save"]') as HTMLButtonElement).click(); await flushUi()
    expect(updateLineMock).toHaveBeenCalledTimes(1)
    target.value = { ...target.value, initialPartId: 'P2' }; await flushUi()
    if (status === 409) await setPartAndLoad('P2')
    resolve({ ok: false, status, reason: status === 409 ? 'lifecycle_locked' : 'stale' }); await flushUi()
    expect(getContextMock).toHaveBeenCalledTimes(status === 409 ? 2 : 1)
    if (status === 412) {
      expect(stateOf()).toBe('idle')
      await setPartAndLoad('P2')
    }
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent"]')).toBeNull()
    expect(container.textContent).not.toContain('此行已被他人修改')
  })

  it.each(['success', 'error'])('BOM return link ignores an old pending ECO %s after switching Part', async (outcome) => {
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    ecoIntentMock.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    const oldContext = cloneContext(); oldContext.part.state = 'Released'
    const nextContext = cloneContext(); nextContext.part.part_id = 'P2'
    getContextMock.mockResolvedValueOnce({ data_source_id: 'plm-ds', available: true, entitled: true, context: oldContext })
      .mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: nextContext })
    const target = shallowRef({ dataSourceId: 'plm-ds', initialPartId: 'P1', ecoIntentEnabled: true })
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({ render: () => h(PlmBomReviewPanel, target.value) }); app.mount(container)
    await setPartAndLoad('P1')
    ;(container.querySelector('[data-testid="plm-bom-review-eco-intent-cta"]') as HTMLButtonElement).click(); await flushUi()
    expect(ecoIntentMock).toHaveBeenCalledWith('plm-ds', 'P1')
    target.value = { ...target.value, initialPartId: 'P2' }; await flushUi()
    await setPartAndLoad('P2')
    if (outcome === 'success') resolve({ ok: true, eco_id: 'OLD-ECO', attached: false })
    else reject(new Error('old request failed'))
    await flushUi()
    expect(container.querySelector('[data-testid="plm-bom-review-eco-intent"]')).toBeNull()
    expect(container.textContent).not.toContain('OLD-ECO')
    expect(getContextMock).toHaveBeenCalledTimes(2)
  })

  it('clears the previous result and ignores an in-flight old-source answer when the target changes', async () => {
    let resolve!: (value: unknown) => void
    getContextMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const target = shallowRef({ dataSourceId: 'plm-ds', initialPartId: 'P1' })
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({ render: () => h(PlmBomReviewPanel, target.value) }); app.mount(container)
    await setPartAndLoad('P1')
    target.value = { dataSourceId: 'other-ds', initialPartId: 'P2' }
    await flushUi()
    resolve({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    await flushUi()
    expect((container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('P2')
    expect(container.querySelector('[data-testid="plm-bom-review-part"]')).toBeNull()
    expect(getContextMock).toHaveBeenCalledTimes(1)
  })
})

describe('BOM query target invalidation', () => {
  it('discards an old in-flight BOM when the typed Part changes and lets the new explicit load proceed', async () => {
    let resolve!: (value: unknown) => void
    getContextMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    mountPanel()
    await setPartAndLoad('P1')
    const input = container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement
    input.value = 'P2'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    resolve({ data_source_id: 'plm-ds', available: true, entitled: true, context: cloneContext() })
    await flushUi()
    expect(stateOf()).toBe('idle')
    expect(container.querySelector('[data-testid="plm-bom-collaboration-open"]')).toBeNull()
    const next = cloneContext(); next.part.part_id = 'P2'
    getContextMock.mockResolvedValueOnce({ data_source_id: 'plm-ds', available: true, entitled: true, context: next })
    await setPartAndLoad('P2')
    expect(getContextMock).toHaveBeenLastCalledWith('plm-ds', 'P2')
    expect(getContextMock).toHaveBeenCalledTimes(2)
    expect(stateOf()).toBe('table')
  })
})
