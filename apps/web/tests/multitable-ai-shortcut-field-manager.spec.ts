/**
 * A3 MetaFieldManager aiShortcut config section — matrix legs A3-T1 (render/
 * hydrate/save shape/constraint mirrors) / A3-T1b (clobber regression) /
 * A3-T1c (removal round-trip) / A3-T2 (config-time preview) / A3-T7 (admin
 * usage card render + 403 session-cache hiding).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App, type Ref } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { resetAiUsageSummarySessionCache } from '../src/multitable/composables/useAiShortcut'
import type { MetaField } from '../src/multitable/types'

const AI_CONFIG = {
  kind: 'classify',
  sourceFieldIds: ['fld_src'],
  params: { options: ['A', 'B'], instruction: 'pick one' },
}

function baseFields(): MetaField[] {
  return [
    {
      id: 'fld_target',
      name: 'Summary',
      type: 'string',
      property: { aiShortcut: structuredClone(AI_CONFIG), validation: [{ type: 'required' }] },
    } as unknown as MetaField,
    { id: 'fld_src', name: 'Notes', type: 'string', property: {} } as unknown as MetaField,
    { id: 'fld_formula', name: 'Calc', type: 'formula', property: { expression: '=1' } } as unknown as MetaField,
    { id: 'fld_plain', name: 'Plain', type: 'string', property: {} } as unknown as MetaField,
  ]
}

interface HarnessOptions {
  fields?: MetaField[]
  currentRecordId?: string | null
  aiPreviewFn?: (params: { recordId: string; config: unknown }) => Promise<unknown>
  aiPreviewBusy?: boolean
  aiUsageSummaryFn?: () => Promise<unknown>
  onUpdateField?: (fieldId: string, input: Record<string, unknown>) => void
}

function mountManager(options: HarnessOptions = {}): { container: HTMLElement; app: App; fields: Ref<MetaField[]> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const fields = ref<MetaField[]>(options.fields ?? baseFields())

  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: true,
        sheetId: 'sheet_1',
        sheets: [],
        fields: fields.value,
        currentRecordId: options.currentRecordId ?? null,
        ...(options.aiPreviewFn ? { aiPreviewFn: options.aiPreviewFn } : {}),
        ...(options.aiPreviewBusy !== undefined ? { aiPreviewBusy: options.aiPreviewBusy } : {}),
        ...(options.aiUsageSummaryFn ? { aiUsageSummaryFn: options.aiUsageSummaryFn } : {}),
        ...(options.onUpdateField ? { onUpdateField: options.onUpdateField } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app, fields }
}

async function openConfigFor(container: HTMLElement, fieldName: string): Promise<void> {
  const row = Array.from(container.querySelectorAll('.meta-field-mgr__row'))
    .find((candidate) => candidate.querySelector('.meta-field-mgr__name')?.textContent === fieldName)
  expect(row, `field row for ${fieldName}`).toBeTruthy()
  ;(row!.querySelector('[title="Configure"]') as HTMLButtonElement).click()
  await nextTick()
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('.meta-field-mgr__btn-add'))
    .find((candidate) => candidate.textContent?.includes('Save field settings'))
  expect(button, 'save button').toBeTruthy()
  return button as HTMLButtonElement
}

function setInput(el: Element | null, value: string): void {
  expect(el, 'input element').toBeTruthy()
  ;(el as HTMLInputElement).value = value
  el!.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Drain ALL pending microtasks (multi-hop async chains) + a render tick. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('MetaFieldManager aiShortcut config section (A3)', () => {
  beforeEach(() => {
    resetAiUsageSummarySessionCache()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('A3-T1: hydrates the existing aiShortcut into the draft (toggle/kind/sources/params)', async () => {
    const { container, app } = mountManager()
    await openConfigFor(container, 'Summary')

    const section = container.querySelector('[data-test="ai-shortcut-section"]')
    expect(section).toBeTruthy()
    expect((container.querySelector('[data-test="ai-shortcut-enable"]') as HTMLInputElement).checked).toBe(true)
    expect((container.querySelector('[data-test="ai-shortcut-kind"]') as HTMLSelectElement).value).toBe('classify')
    expect((container.querySelector('[data-test="ai-shortcut-source-fld_src"]') as HTMLInputElement).checked).toBe(true)
    // Constraint mirror: computed fields and the target itself are NOT candidates.
    expect(container.querySelector('[data-test="ai-shortcut-source-fld_formula"]')).toBeNull()
    expect(container.querySelector('[data-test="ai-shortcut-source-fld_target"]')).toBeNull()
    const optionInputs = Array.from(container.querySelectorAll('[data-test="ai-shortcut-option-input"]')) as HTMLInputElement[]
    expect(optionInputs.map((input) => input.value)).toEqual(['A', 'B'])
    const instruction = container.querySelector('[data-test="ai-shortcut-instruction"]') as HTMLTextAreaElement
    expect(instruction.value).toBe('pick one')
    // Constraint mirrors as hard input caps.
    expect(instruction.maxLength).toBe(500)

    app.unmount()
  })

  it('A3-T1: save emits the update-field property with the canonical aiShortcut shape', async () => {
    const updateSpy = vi.fn()
    const { container, app } = mountManager({ onUpdateField: updateSpy })
    await openConfigFor(container, 'Summary')

    setInput(container.querySelector('[data-test="ai-shortcut-instruction"]'), 'edited instruction')
    saveButton(container).click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [fieldId, input] = updateSpy.mock.calls[0] as [string, { property: Record<string, unknown> }]
    expect(fieldId).toBe('fld_target')
    expect(input.property.aiShortcut).toEqual({
      kind: 'classify',
      sourceFieldIds: ['fld_src'],
      params: { options: ['A', 'B'], instruction: 'edited instruction' },
    })
    // Hydrated validation rules ride along (no reverse clobber of validation).
    expect(input.property.validation).toEqual([{ type: 'required' }])

    app.unmount()
  })

  it('A3-T1b CLOBBER GUARD: a validation-only save re-emits the existing aiShortcut untouched', async () => {
    const updateSpy = vi.fn()
    const { container, app } = mountManager({ onUpdateField: updateSpy })
    await openConfigFor(container, 'Summary')

    // Touch ONLY the validation panel (uncheck `required`) — never the AI section.
    const requiredToggle = container.querySelector('[data-rule-toggle="required"]') as HTMLInputElement
    requiredToggle.checked = false
    requiredToggle.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    saveButton(container).click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [, input] = updateSpy.mock.calls[0] as [string, { property: Record<string, unknown> }]
    // Wire-shape assertion: the persisted config survives byte-identically.
    expect(input.property.aiShortcut).toEqual(AI_CONFIG)

    app.unmount()
  })

  it('A3-T1c REMOVAL ROUND-TRIP: unchecking the toggle saves a property WITHOUT the key; reopen shows未配置', async () => {
    const updateSpy = vi.fn()
    const { container, app, fields } = mountManager({ onUpdateField: updateSpy })
    await openConfigFor(container, 'Summary')

    const enable = container.querySelector('[data-test="ai-shortcut-enable"]') as HTMLInputElement
    enable.checked = false
    enable.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    saveButton(container).click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [, input] = updateSpy.mock.calls[0] as [string, { property: Record<string, unknown> }]
    // Removal = KEY OMISSION (never aiShortcut:null — the backend 400s null).
    expect('aiShortcut' in input.property).toBe(false)

    // Round-trip: parent persists the keyless property → reopen hydrates as未配置.
    fields.value = fields.value.map((field) => field.id === 'fld_target'
      ? ({ ...field, property: { validation: [{ type: 'required' }] } } as unknown as MetaField)
      : field)
    await nextTick()
    await openConfigFor(container, 'Summary')
    expect((container.querySelector('[data-test="ai-shortcut-enable"]') as HTMLInputElement).checked).toBe(false)

    app.unmount()
  })

  it('A3-T1: enabling with zero source fields blocks the save with an inline error (constraint mirror)', async () => {
    const updateSpy = vi.fn()
    const { container, app } = mountManager({ onUpdateField: updateSpy })
    await openConfigFor(container, 'Plain')

    const enable = container.querySelector('[data-test="ai-shortcut-enable"]') as HTMLInputElement
    enable.checked = true
    enable.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    saveButton(container).click()
    await nextTick()

    expect(updateSpy).not.toHaveBeenCalled()
    expect(container.querySelector('.meta-field-mgr__error')?.textContent).toContain('source field')

    app.unmount()
  })

  it('A3-T1: translate kind exposes a targetLang input capped at 32 chars', async () => {
    const { container, app } = mountManager()
    await openConfigFor(container, 'Summary')

    const kind = container.querySelector('[data-test="ai-shortcut-kind"]') as HTMLSelectElement
    kind.value = 'translate'
    kind.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const targetLang = container.querySelector('[data-test="ai-shortcut-target-lang"]') as HTMLInputElement
    expect(targetLang).toBeTruthy()
    expect(targetLang.maxLength).toBe(32)

    app.unmount()
  })

  it('A3-T2: preview button posts the inline DRAFT config with the current record id', async () => {
    const previewSpy = vi.fn(async () => ({
      data: {
        status: 'succeeded', action: 'preview', output: 'DRAFT PREVIEW',
        usage: { promptTokens: 5, completionTokens: 7 }, estimatedCostUsd: 0.0001,
        provider: 'anthropic', model: 'claude-sonnet-4-6',
      },
    }))
    const { container, app } = mountManager({ currentRecordId: 'rec_cur', aiPreviewFn: previewSpy })
    await openConfigFor(container, 'Summary')

    // Edit the draft BEFORE previewing — the call must carry the DRAFT, not the persisted config.
    setInput(container.querySelector('[data-test="ai-shortcut-instruction"]'), 'draft instruction')

    const previewBtn = container.querySelector('[data-test="ai-shortcut-preview-btn"]') as HTMLButtonElement
    expect(previewBtn.disabled).toBe(false)
    previewBtn.click()
    await flush()

    expect(previewSpy).toHaveBeenCalledWith({
      recordId: 'rec_cur',
      config: {
        kind: 'classify',
        sourceFieldIds: ['fld_src'],
        params: { options: ['A', 'B'], instruction: 'draft instruction' },
      },
    })
    const result = container.querySelector('[data-test="ai-shortcut-preview-result"]')
    expect(result?.textContent).toContain('DRAFT PREVIEW')
    expect(result?.textContent).toContain('12 tokens')

    app.unmount()
  })

  it('A3-T2: no current record → preview disabled with the record hint; quota/draft copy is shown', async () => {
    const previewSpy = vi.fn()
    const { container, app } = mountManager({ currentRecordId: null, aiPreviewFn: previewSpy })
    await openConfigFor(container, 'Summary')

    const previewBtn = container.querySelector('[data-test="ai-shortcut-preview-btn"]') as HTMLButtonElement
    expect(previewBtn.disabled).toBe(true)
    previewBtn.click()
    await nextTick()
    expect(previewSpy).not.toHaveBeenCalled()

    const sectionText = container.querySelector('[data-test="ai-shortcut-section"]')?.textContent ?? ''
    expect(sectionText).toContain('Select a record')
    // Locked copy: REAL call consuming quota + validates the DRAFT.
    expect(sectionText).toContain('real AI call')
    expect(sectionText).toContain('draft')

    app.unmount()
  })

  it('review F3: shared AI busy (countdown / in-flight elsewhere) disables the preview button — no silent no-op click', async () => {
    const previewSpy = vi.fn()
    const { container, app } = mountManager({ currentRecordId: 'rec_cur', aiPreviewFn: previewSpy, aiPreviewBusy: true })
    await openConfigFor(container, 'Summary')

    const previewBtn = container.querySelector('[data-test="ai-shortcut-preview-btn"]') as HTMLButtonElement
    expect(previewBtn.disabled).toBe(true)
    // Even a forced (synthetic) click must be refused by the runAiPreview guard.
    previewBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(previewSpy).not.toHaveBeenCalled()

    app.unmount()
  })

  it('A3-T2: a server-side config rejection lands in the existing fieldConfigError inline', async () => {
    const previewSpy = vi.fn(async () => ({
      error: { code: 'VALIDATION_ERROR', message: 'aiShortcut.sourceFieldIds entries must be non-empty', status: 400 },
    }))
    const { container, app } = mountManager({ currentRecordId: 'rec_cur', aiPreviewFn: previewSpy })
    await openConfigFor(container, 'Summary')

    ;(container.querySelector('[data-test="ai-shortcut-preview-btn"]') as HTMLButtonElement).click()
    await flush()

    expect(container.querySelector('.meta-field-mgr__error')?.textContent).toContain('sourceFieldIds')

    app.unmount()
  })

  it('A3-T2: AI-state errors (e.g. quota) use the §2.3 copy in the preview area', async () => {
    const previewSpy = vi.fn(async () => ({
      error: { code: 'AI_QUOTA_EXHAUSTED', message: 'AI usage quota exhausted (user_daily_tokens).', status: 429 },
    }))
    const { container, app } = mountManager({ currentRecordId: 'rec_cur', aiPreviewFn: previewSpy })
    await openConfigFor(container, 'Summary')

    ;(container.querySelector('[data-test="ai-shortcut-preview-btn"]') as HTMLButtonElement).click()
    await flush()

    expect(container.querySelector('[data-test="ai-shortcut-preview-error"]')?.textContent)
      .toContain('quota')

    app.unmount()
  })

  it('A3-T7: admin usage card renders the summary numbers (automation stats card styling family)', async () => {
    const summaryFn = vi.fn(async () => ({
      callerDayTokens: 123, callerWeekTokens: 456, instanceDayUsd: 7.89,
      caps: { tenantDailyTokenCap: 111000, tenantWeeklyTokenCap: 555000, accountDailyUsdCap: 12 },
    }))
    const { container, app } = mountManager({ aiUsageSummaryFn: summaryFn })
    await openConfigFor(container, 'Summary')
    await flush()

    const card = container.querySelector('[data-test="ai-usage-card"]')
    expect(card).toBeTruthy()
    expect(card?.textContent).toContain('123')
    expect(card?.textContent).toContain('456')
    expect(card?.textContent).toContain('7.89')
    expect(card?.textContent).toContain('111000')

    app.unmount()
  })

  it('A3-T7: a 403 probe hides the card silently and is cached for the session (no re-probe)', async () => {
    const summaryFn = vi.fn(async () => {
      throw Object.assign(new Error('Insufficient permissions'), { status: 403 })
    })
    const first = mountManager({ aiUsageSummaryFn: summaryFn })
    await openConfigFor(first.container, 'Summary')
    await flush()
    expect(first.container.querySelector('[data-test="ai-usage-card"]')).toBeNull()
    expect(summaryFn).toHaveBeenCalledTimes(1)
    first.app.unmount()
    document.body.innerHTML = ''

    const second = mountManager({ aiUsageSummaryFn: summaryFn })
    await openConfigFor(second.container, 'Summary')
    await flush()
    expect(second.container.querySelector('[data-test="ai-usage-card"]')).toBeNull()
    expect(summaryFn).toHaveBeenCalledTimes(1) // session cache — never re-probed
    second.app.unmount()
  })
})
