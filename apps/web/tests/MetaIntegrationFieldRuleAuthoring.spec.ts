import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import MetaIntegrationFieldRuleAuthoring from '../src/components/integration/MetaIntegrationFieldRuleAuthoring.vue'
import {
  DF_T3_REFERENCE_DOMAINS,
  fieldRuleEditability,
  setFieldRuleReplace,
  setFieldRulePreserve,
  setFieldRuleFromReferenceTable,
  setFieldRuleReferencePreserve,
  type IntegrationFieldRule,
} from '../src/services/integration/workbench'

// --- pure helper unit tests (DOM-independent) ---
describe('fieldRuleEditability + setters (DF-T2b / DF-T3b-2d)', () => {
  it('scalar editable; reference is reference-EDITABLE (DF-T3b-2d, not locked); gated locked & wins', () => {
    expect(fieldRuleEditability({ targetField: 'FNumber', shape: 'scalar' })).toMatchObject({ editable: true, reason: null, isReference: false })
    // DF-T3b-2d: a reference is now editable (preserve ↔ from_reference_table), NOT locked.
    expect(fieldRuleEditability({ targetField: 'FUnitID', shape: 'object-passthrough' })).toMatchObject({ editable: true, locked: false, reason: 'reference', isReference: true })
    expect(fieldRuleEditability({ targetField: 'FErpClsID', shape: 'by-fid' })).toMatchObject({ editable: true, reason: 'reference', isReference: true })
    // gated WINS over reference-editability — a gated REFERENCE stays locked (FBaseUnitID stays closed).
    expect(fieldRuleEditability({ targetField: 'FBaseUnitID', shape: 'object-passthrough' }, ['FBaseUnitID'])).toMatchObject({ editable: false, locked: true, reason: 'gated' })
    expect(fieldRuleEditability({ targetField: 'FBaseUnitID', shape: 'scalar' }, ['FBaseUnitID'])).toMatchObject({ editable: false, reason: 'gated' })
  })

  it('a preserved SCALAR stays editable (lock keys on shape, not sourceType)', () => {
    expect(fieldRuleEditability({ targetField: 'FModel', shape: 'scalar' })).toMatchObject({ editable: true, isReference: false })
  })

  it('scalar setters keep shape scalar and only flip the mode (+ drop domain)', () => {
    const replaced = setFieldRuleReplace({ targetField: 'FNumber', sourceType: 'preserve_template', shape: 'scalar' }, 'materialCode')
    expect(replaced).toMatchObject({ sourceType: 'from_staging', shape: 'scalar', sourceField: 'materialCode' })
    const preserved = setFieldRulePreserve({ targetField: 'FNumber', sourceType: 'from_staging', shape: 'scalar', sourceField: 'x' })
    expect(preserved).toMatchObject({ sourceType: 'preserve_template', shape: 'scalar' })
    expect(preserved.sourceField).toBeUndefined()
  })

  it('DF-T3b-2d reference setters keep SHAPE + completeness, flip preserve ↔ from_reference_table(+domain), never scalar', () => {
    const ref: IntegrationFieldRule = { targetField: 'FUnitID', sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname' }
    const mapped = setFieldRuleFromReferenceTable(ref, 'unit')
    expect(mapped).toMatchObject({ targetField: 'FUnitID', sourceType: 'from_reference_table', shape: 'object-passthrough', completeness: 'require-fnumber-fname', domain: 'unit' })
    // half-state: empty domain → from_reference_table with domain ABSENT (backend fail-closes on it)
    const halfState = setFieldRuleFromReferenceTable(ref, '')
    expect(halfState).toMatchObject({ sourceType: 'from_reference_table', shape: 'object-passthrough' })
    expect(halfState.domain).toBeUndefined()
    // back to preserve drops domain, keeps the reference shape
    const back = setFieldRuleReferencePreserve(mapped)
    expect(back).toMatchObject({ sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname' })
    expect(back.domain).toBeUndefined()
  })

  it('DF_T3_REFERENCE_DOMAINS pins the exact 12-domain set (mirrors the backend templates)', () => {
    expect([...DF_T3_REFERENCE_DOMAINS].sort()).toEqual([
      'account', 'category', 'inspection-level', 'inspection-mode', 'manager', 'order-strategy',
      'planning-strategy', 'track', 'unit', 'unit-group', 'use-state', 'warehouse',
    ])
  })
})

// --- component render / emit / lock tests ---
describe('MetaIntegrationFieldRuleAuthoring (DF-T2b)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function draft(): IntegrationFieldRule[] {
    return [
      { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', shape: 'scalar', required: false },
      { targetField: 'FUnitID', sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname' },
    ]
  }

  function mount(modelValue: IntegrationFieldRule[], gatedFields: string[] = []): IntegrationFieldRule[][] {
    const updates: IntegrationFieldRule[][] = []
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(MetaIntegrationFieldRuleAuthoring, {
        modelValue,
        gatedFields,
        'onUpdate:modelValue': (rules: IntegrationFieldRule[]) => updates.push(rules),
      }),
    })
    app.mount(container)
    return updates
  }

  it('renders a row per rule + a locked gated section', async () => {
    mount(draft(), ['FBaseUnitID'])
    await nextTick()
    expect(container!.querySelector('[data-testid="field-rule-FNumber"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="field-rule-FUnitID"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="field-rule-gated-FBaseUnitID"]')).not.toBeNull()
    // no customer values rendered — only field names + shapes
    expect(container!.textContent).toContain('object-passthrough')
  })

  it('a scalar field toggles preserve→replace and edits its sourceField (emits each time)', async () => {
    const updates = mount(draft())
    await nextTick()
    const mode = container!.querySelector('[data-testid="field-rule-mode-FNumber"]') as HTMLSelectElement
    expect(mode.tagName).toBe('SELECT')
    mode.value = 'preserve'
    mode.dispatchEvent(new Event('change'))
    await nextTick()
    expect(updates.at(-1)![0]).toMatchObject({ targetField: 'FNumber', sourceType: 'preserve_template', shape: 'scalar' })
    expect(updates.at(-1)![0].sourceField).toBeUndefined()

    mode.value = 'replace'
    mode.dispatchEvent(new Event('change'))
    await nextTick()
    const source = container!.querySelector('[data-testid="field-rule-source-FNumber"]') as HTMLInputElement
    expect(source).not.toBeNull()
    source.value = 'materialCode'
    source.dispatchEvent(new Event('input'))
    await nextTick()
    expect(updates.at(-1)![0]).toMatchObject({ targetField: 'FNumber', sourceType: 'from_staging', shape: 'scalar', sourceField: 'materialCode' })
  })

  it('DF-T3b-2d: a REFERENCE field is editable (preserve↔mapping), never scalar; switch→mapping emits the half-state', async () => {
    const updates = mount(draft()) // FUnitID = preserve_template object-passthrough
    await nextTick()
    // reference row now has an editable mode <select>, NOT a locked label
    const mode = container!.querySelector('[data-testid="field-rule-mode-FUnitID"]') as HTMLSelectElement
    expect(mode.tagName).toBe('SELECT')
    expect(container!.querySelector('[data-testid="field-rule-locked-FUnitID"]')).toBeNull()
    // no scalar source input on a reference — cannot downgrade to scalar replace
    expect(container!.querySelector('[data-testid="field-rule-source-FUnitID"]')).toBeNull()
    // switch to mapping → emits from_reference_table, SHAPE + completeness kept, NO domain yet (half-state)
    mode.value = 'mapping'
    mode.dispatchEvent(new Event('change'))
    await nextTick()
    const emitted = updates.at(-1)![1]
    expect(emitted).toMatchObject({ targetField: 'FUnitID', sourceType: 'from_reference_table', shape: 'object-passthrough', completeness: 'require-fnumber-fname' })
    expect(emitted.domain).toBeUndefined()
  })

  it('DF-T3b-2d: a from_reference_table reference shows the domain picker + "需选择 domain"; picking emits the domain', async () => {
    const updates = mount([
      { targetField: 'FUnitID', sourceType: 'from_reference_table', shape: 'object-passthrough', completeness: 'require-fnumber-fname' },
    ])
    await nextTick()
    const domainSel = container!.querySelector('[data-testid="field-rule-domain-FUnitID"]') as HTMLSelectElement
    expect(domainSel.tagName).toBe('SELECT')
    expect(container!.querySelector('[data-testid="field-rule-domain-required-FUnitID"]')).not.toBeNull()
    // offers the 12 domains + the placeholder option
    expect(domainSel.querySelectorAll('option').length).toBe(DF_T3_REFERENCE_DOMAINS.length + 1)
    domainSel.value = 'unit'
    domainSel.dispatchEvent(new Event('change'))
    await nextTick()
    expect(updates.at(-1)![0]).toMatchObject({ targetField: 'FUnitID', sourceType: 'from_reference_table', shape: 'object-passthrough', completeness: 'require-fnumber-fname', domain: 'unit' })
  })

  it('DF-T3b-2d: a GATED reference stays locked (gated wins over reference-editability)', async () => {
    const updates = mount([
      { targetField: 'FBaseUnitID', sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname' },
    ], ['FBaseUnitID'])
    await nextTick()
    expect(container!.querySelector('[data-testid="field-rule-locked-FBaseUnitID"]')).not.toBeNull()
    const mode = container!.querySelector('[data-testid="field-rule-mode-FBaseUnitID"]') as HTMLElement
    expect(mode.tagName).not.toBe('SELECT') // locked label, not the reference mode select
    expect(container!.querySelector('[data-testid="field-rule-domain-FBaseUnitID"]')).toBeNull() // no domain picker
    expect(updates).toHaveLength(0)
  })

  it('a GATED field present in modelValue renders locked (no select, no source input, no emit)', async () => {
    // Defensive: even a scalar-shaped rule is locked when its field is gated — it must render as a
    // locked label, not an inert-but-editable-looking select (the DF-T2b gated contract).
    const withGated: IntegrationFieldRule[] = [
      ...draft(),
      { targetField: 'FBaseUnitID', sourceType: 'preserve_template', shape: 'scalar' },
    ]
    const updates = mount(withGated, ['FBaseUnitID'])
    await nextTick()
    expect(container!.querySelector('[data-testid="field-rule-locked-FBaseUnitID"]')).not.toBeNull()
    const mode = container!.querySelector('[data-testid="field-rule-mode-FBaseUnitID"]') as HTMLElement
    expect(mode).not.toBeNull()
    expect(mode.tagName).not.toBe('SELECT') // locked label, not an editable control
    expect(container!.querySelector('[data-testid="field-rule-source-FBaseUnitID"]')).toBeNull()
    expect(updates).toHaveLength(0) // no editable control → no emit
  })
})
