import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'

import { useLocale } from '../src/composables/useLocale'
import ScaleFormattingDialog from '../src/multitable/components/ScaleFormattingDialog.vue'
import type { ConditionalFormattingScaleRule, MetaField } from '../src/multitable/types'
import { sanitizeScaleRule } from '../src/multitable/utils/conditional-formatting'

const fields: MetaField[] = [
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {} },
  { id: 'fld_price', name: 'Price', type: 'currency', property: {} },
  { id: 'fld_rate', name: 'Rate', type: 'percent', property: {} },
  { id: 'fld_stars', name: 'Stars', type: 'rating', property: {} },
  { id: 'fld_title', name: 'Title', type: 'string', property: {} },
  { id: 'fld_due', name: 'Due', type: 'date', property: {} },
  {
    id: 'fld_status',
    name: 'Status',
    type: 'select',
    options: [{ value: 'Pending' }, { value: 'Done' }],
    property: {},
  },
]

function dataBarRule(partial: Partial<ConditionalFormattingScaleRule> = {}): ConditionalFormattingScaleRule {
  return {
    id: 'scr_bar',
    order: 0,
    fieldId: 'fld_amount',
    kind: 'dataBar',
    enabled: true,
    range: { mode: 'auto' },
    dataBar: { color: '#3b82f6' },
    ...partial,
  }
}

function colorScaleRule(partial: Partial<ConditionalFormattingScaleRule> = {}): ConditionalFormattingScaleRule {
  return {
    id: 'scr_cs',
    order: 1,
    fieldId: 'fld_price',
    kind: 'colorScale',
    enabled: true,
    range: { mode: 'auto' },
    colorScale: {
      stops: [
        { at: 'min', color: '#f8696b' },
        { at: 'mid', color: '#ffeb84' },
        { at: 'max', color: '#63be7b' },
      ],
    },
    ...partial,
  }
}

function iconSetRule(partial: Partial<ConditionalFormattingScaleRule> = {}): ConditionalFormattingScaleRule {
  return {
    id: 'scr_icon',
    order: 2,
    fieldId: 'fld_rate',
    kind: 'iconSet',
    enabled: true,
    range: { mode: 'auto' },
    iconSet: { set: 'arrows3', thresholds: [10, 20] },
    ...partial,
  }
}

function mountDialog(propsOverride: Partial<{
  visible: boolean
  fields: MetaField[]
  viewConfig: Record<string, unknown>
  onClose: () => void
  onSave: (rules: ConditionalFormattingScaleRule[]) => void
  'onUpdate:dirty': (dirty: boolean) => void
}> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const props = {
    visible: true,
    fields,
    viewConfig: {
      conditionalFormattingScaleRules: [dataBarRule(), colorScaleRule(), iconSetRule()],
    },
    onClose: vi.fn(),
    onSave: vi.fn(),
    'onUpdate:dirty': vi.fn(),
    ...propsOverride,
  }
  const app: App = createApp({ render: () => h(ScaleFormattingDialog, props) })
  app.mount(container)
  return { app, container, props }
}

async function flush() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll('.scf-dlg__footer .scf-dlg__btn'))
    .find((b) => b.textContent?.includes('Save')) as HTMLButtonElement
}

describe('ScaleFormattingDialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('hydrates a draft row per kind from the view config', async () => {
    const { app, container } = mountDialog()
    await flush()

    const rules = container.querySelectorAll('.scf-dlg__rule')
    expect(rules).toHaveLength(3)
    // each kind's distinctive control is present
    expect(container.textContent).toContain('Bar color') // dataBar
    expect(container.textContent).toContain('Lower threshold') // iconSet
    expect(container.querySelector('.scf-dlg__preview-bar')).toBeTruthy() // colorScale gradient preview
    app.unmount()
  })

  it('authors a dataBar rule (added from scratch) that round-trips through the sanitizer unchanged', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [] },
    })
    await flush()

    // adding a rule makes the draft dirty (default kind = dataBar)
    const addBtn = Array.from(container.querySelectorAll('.scf-dlg__body > .scf-dlg__btn'))
      .find((b) => b.textContent?.includes('Add scale rule')) as HTMLButtonElement
    addBtn.click()
    await flush()

    expect(getSaveButton(container).disabled).toBe(false)
    getSaveButton(container).click()
    await flush()

    expect(props.onSave).toHaveBeenCalledTimes(1)
    const emitted = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as ConditionalFormattingScaleRule[]
    expect(emitted).toHaveLength(1)
    const sane = sanitizeScaleRule(emitted[0])
    expect(sane).not.toBeNull()
    // wire-vs-fixture-drift guard: emitted shape survives the contract verbatim
    expect(sane).toEqual(emitted[0])
    expect(emitted[0].kind).toBe('dataBar')
    expect(emitted[0].dataBar?.color).toBe('#3b82f6')
    app.unmount()
  })

  it('authors a colorScale rule (3-stop) that the sanitizer accepts', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [colorScaleRule()] },
    })
    await flush()

    // edit the min stop's hex
    const hex = container.querySelector('.scf-dlg__hex') as HTMLInputElement
    hex.value = '#112233'
    hex.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    getSaveButton(container).click()
    await flush()

    const emitted = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as ConditionalFormattingScaleRule[]
    const sane = sanitizeScaleRule(emitted[0])
    expect(sane).not.toBeNull()
    expect(sane).toEqual(emitted[0])
    expect(emitted[0].kind).toBe('colorScale')
    const stops = emitted[0].colorScale?.stops ?? []
    expect(stops.map((s) => s.at).sort()).toEqual(['max', 'mid', 'min'])
    expect(stops.find((s) => s.at === 'min')?.color).toBe('#112233')
    app.unmount()
  })

  it('drops the mid stop into a valid 2-stop colorScale', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [colorScaleRule()] },
    })
    await flush()

    const dropBtn = Array.from(container.querySelectorAll('.scf-dlg__btn--ghost'))
      .find((b) => b.textContent?.includes('Remove midpoint')) as HTMLButtonElement
    expect(dropBtn).toBeTruthy()
    dropBtn.click()
    await flush()

    getSaveButton(container).click()
    await flush()

    const emitted = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as ConditionalFormattingScaleRule[]
    const sane = sanitizeScaleRule(emitted[0])
    expect(sane).not.toBeNull()
    const stops = emitted[0].colorScale?.stops ?? []
    expect(stops.map((s) => s.at).sort()).toEqual(['max', 'min'])
    app.unmount()
  })

  it('authors an iconSet rule with t0<t1 that the sanitizer accepts', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [iconSetRule()] },
    })
    await flush()

    // edit the upper threshold (10 < 25) so the draft is dirty and still valid
    const minis = Array.from(container.querySelectorAll('.scf-dlg__input--mini')) as HTMLInputElement[]
    minis[1].value = '25'
    minis[1].dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    expect(getSaveButton(container).disabled).toBe(false)
    getSaveButton(container).click()
    await flush()

    const emitted = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as ConditionalFormattingScaleRule[]
    const sane = sanitizeScaleRule(emitted[0])
    expect(sane).not.toBeNull()
    expect(sane).toEqual(emitted[0])
    expect(emitted[0].iconSet?.thresholds).toEqual([10, 25])
    app.unmount()
  })

  it('blocks save and shows an error when iconSet t0 >= t1', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [iconSetRule({ iconSet: { set: 'arrows3', thresholds: [5, 9] } })] },
    })
    await flush()

    const numberInputs = Array.from(container.querySelectorAll('.scf-dlg__input--mini')) as HTMLInputElement[]
    // first two minis on an iconSet rule are lower/upper threshold
    const upper = numberInputs[1]
    upper.value = '3' // now lower(5) >= upper(3)
    upper.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    expect(container.textContent).toContain('Lower threshold must be less than the upper threshold.')
    expect(getSaveButton(container).disabled).toBe(true)

    getSaveButton(container).click()
    await flush()
    expect(props.onSave).not.toHaveBeenCalled()
    app.unmount()
  })

  it('blocks save when a fixed range has min == max', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [dataBarRule()] },
    })
    await flush()

    // switch range to fixed
    const fixedRadio = Array.from(container.querySelectorAll('.scf-dlg__radio input[type=radio]'))[1] as HTMLInputElement
    fixedRadio.checked = true
    fixedRadio.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    const minis = Array.from(container.querySelectorAll('.scf-dlg__input--mini')) as HTMLInputElement[]
    // dataBar has no thresholds, so the two minis here are the fixed min/max
    minis[0].value = '5'
    minis[0].dispatchEvent(new Event('input', { bubbles: true }))
    minis[1].value = '5'
    minis[1].dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    expect(container.textContent).toContain('Min and max must differ.')
    expect(getSaveButton(container).disabled).toBe(true)
    app.unmount()
  })

  it('emits a canonical fixed range (min<=max) even when entered reversed', async () => {
    const { app, container, props } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [dataBarRule()] },
    })
    await flush()

    const fixedRadio = Array.from(container.querySelectorAll('.scf-dlg__radio input[type=radio]'))[1] as HTMLInputElement
    fixedRadio.checked = true
    fixedRadio.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    const minis = Array.from(container.querySelectorAll('.scf-dlg__input--mini')) as HTMLInputElement[]
    minis[0].value = '20' // min input
    minis[0].dispatchEvent(new Event('input', { bubbles: true }))
    minis[1].value = '10' // max input (reversed)
    minis[1].dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    // min != max → save allowed
    expect(getSaveButton(container).disabled).toBe(false)
    getSaveButton(container).click()
    await flush()

    const emitted = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as ConditionalFormattingScaleRule[]
    expect(emitted[0].range).toEqual({ mode: 'fixed', min: 10, max: 20 })
    // and it equals what the sanitizer produces (no non-canonical wire)
    expect(sanitizeScaleRule(emitted[0])).toEqual(emitted[0])
    app.unmount()
  })

  it('lists only numeric fields in the field selector', async () => {
    const { app, container } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [dataBarRule()] },
    })
    await flush()

    const fieldSelect = container.querySelector('.scf-dlg__rule select') as HTMLSelectElement
    const optionTexts = Array.from(fieldSelect.options).map((o) => o.textContent ?? '')
    expect(optionTexts).toContain('Amount')
    expect(optionTexts).toContain('Price')
    expect(optionTexts).toContain('Rate')
    expect(optionTexts).toContain('Stars')
    expect(optionTexts).not.toContain('Title')
    expect(optionTexts).not.toContain('Due')
    expect(optionTexts).not.toContain('Status')
    app.unmount()
  })

  it('prevents a second scale rule on a field already used by another rule', async () => {
    // amount is used by the existing dataBar rule; add a new rule and confirm
    // the amount option is disabled for it.
    const { app, container } = mountDialog({
      viewConfig: { conditionalFormattingScaleRules: [dataBarRule()] },
    })
    await flush()

    const addBtn = Array.from(container.querySelectorAll('.scf-dlg__body > .scf-dlg__btn'))
      .find((b) => b.textContent?.includes('Add scale rule')) as HTMLButtonElement
    addBtn.click()
    await flush()

    const ruleEls = container.querySelectorAll('.scf-dlg__rule')
    expect(ruleEls).toHaveLength(2)
    // the second rule's field select must have Amount disabled (used by rule 1)
    const secondSelect = ruleEls[1].querySelector('select') as HTMLSelectElement
    const amountOption = Array.from(secondSelect.options).find((o) => o.textContent === 'Amount')
    expect(amountOption?.disabled).toBe(true)
    app.unmount()
  })

  it('disables Add when all numeric fields already have a scale rule', async () => {
    const { app, container } = mountDialog({
      viewConfig: {
        conditionalFormattingScaleRules: [
          dataBarRule({ id: 'a', fieldId: 'fld_amount' }),
          dataBarRule({ id: 'b', fieldId: 'fld_price' }),
          dataBarRule({ id: 'c', fieldId: 'fld_rate' }),
          dataBarRule({ id: 'd', fieldId: 'fld_stars' }),
        ],
      },
    })
    await flush()

    const addBtn = Array.from(container.querySelectorAll('.scf-dlg__body > .scf-dlg__btn'))
      .find((b) => b.textContent?.includes('Add scale rule')) as HTMLButtonElement
    expect(addBtn.disabled).toBe(true)
    expect(container.textContent).toContain('Every numeric field already has a scale rule.')
    app.unmount()
  })

  it('renders chrome and icon-set names in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const { app, container } = mountDialog()
    await flush()

    expect(container.querySelector('.scf-dlg')?.getAttribute('aria-label')).toBe('色阶格式规则')
    expect(container.textContent).toContain('色阶格式')
    expect(container.textContent).toContain('数据条')
    expect(container.textContent).toContain('色阶')
    expect(container.textContent).toContain('图标集')
    expect(container.textContent).toContain('下阈值')
    expect(container.textContent).toContain('保存规则')
    app.unmount()
  })

  it('renders English chrome by default', async () => {
    const { app, container } = mountDialog()
    await flush()

    expect(container.querySelector('.scf-dlg')?.getAttribute('aria-label')).toBe('Scale formatting rules')
    expect(container.textContent).toContain('Scale formatting')
    expect(container.textContent).toContain('Data bar')
    expect(container.textContent).toContain('Icon set')
    app.unmount()
  })

  it('shows the no-numeric-fields hint when no eligible fields exist', async () => {
    const { app, container } = mountDialog({
      fields: [{ id: 'fld_title', name: 'Title', type: 'string', property: {} }],
      viewConfig: { conditionalFormattingScaleRules: [] },
    })
    await flush()

    expect(container.textContent).toContain('Add a numeric field')
    app.unmount()
  })
})
