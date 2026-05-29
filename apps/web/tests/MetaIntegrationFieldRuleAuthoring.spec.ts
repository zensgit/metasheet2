import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import MetaIntegrationFieldRuleAuthoring from '../src/components/integration/MetaIntegrationFieldRuleAuthoring.vue'
import {
  fieldRuleEditability,
  setFieldRuleReplace,
  setFieldRulePreserve,
  type IntegrationFieldRule,
} from '../src/services/integration/workbench'

// --- pure helper unit tests (DOM-independent) ---
describe('fieldRuleEditability (DF-T2b)', () => {
  it('scalar is editable; a non-scalar (reference) shape is locked to preserve; gated is locked', () => {
    expect(fieldRuleEditability({ targetField: 'FNumber', shape: 'scalar' })).toMatchObject({ editable: true, reason: null, isReference: false })
    expect(fieldRuleEditability({ targetField: 'FUnitID', shape: 'object-passthrough' })).toMatchObject({ editable: false, locked: true, reason: 'reference', isReference: true })
    expect(fieldRuleEditability({ targetField: 'FErpClsID', shape: 'by-fid' })).toMatchObject({ reason: 'reference' })
    expect(fieldRuleEditability({ targetField: 'FBaseUnitID', shape: 'scalar' }, ['FBaseUnitID'])).toMatchObject({ editable: false, reason: 'gated' })
  })

  it('a preserved SCALAR stays editable (lock keys on shape, not sourceType)', () => {
    // preserve_template + scalar shape = a scalar the operator chose to preserve — still editable.
    expect(fieldRuleEditability({ targetField: 'FModel', shape: 'scalar' })).toMatchObject({ editable: true })
  })

  it('setters keep shape scalar and only flip the mode', () => {
    const replaced = setFieldRuleReplace({ targetField: 'FNumber', sourceType: 'preserve_template', shape: 'scalar' }, 'materialCode')
    expect(replaced).toMatchObject({ sourceType: 'from_staging', shape: 'scalar', sourceField: 'materialCode' })
    const preserved = setFieldRulePreserve({ targetField: 'FNumber', sourceType: 'from_staging', shape: 'scalar', sourceField: 'x' })
    expect(preserved).toMatchObject({ sourceType: 'preserve_template', shape: 'scalar' })
    expect(preserved.sourceField).toBeUndefined()
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

  it('a REFERENCE field is locked to preserve — no editable control (v1: cannot downgrade to scalar replace)', async () => {
    mount(draft())
    await nextTick()
    // the reference row shows the locked label + hint...
    expect(container!.querySelector('[data-testid="field-rule-locked-FUnitID"]')).not.toBeNull()
    // ...and its "mode" element is a locked span, NOT an editable <select> — so there is no UI
    // path to set replace on a reference field.
    const refMode = container!.querySelector('[data-testid="field-rule-mode-FUnitID"]') as HTMLElement
    expect(refMode).not.toBeNull()
    expect(refMode.tagName).not.toBe('SELECT')
    expect(container!.querySelector('[data-testid="field-rule-source-FUnitID"]')).toBeNull()
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
