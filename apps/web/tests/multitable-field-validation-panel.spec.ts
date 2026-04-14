import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { FieldValidationRule } from '../src/multitable/types'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

import MetaFieldValidationPanel from '../src/multitable/components/MetaFieldValidationPanel.vue'

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const emitted: FieldValidationRule[][] = []
  const app = createApp({
    render: () =>
      h(MetaFieldValidationPanel, {
        ...props,
        'onUpdate:rules': (rules: FieldValidationRule[]) => emitted.push(rules),
      }),
  })
  app.mount(container)
  return { container, app, emitted }
}

describe('MetaFieldValidationPanel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders required toggle for all field types', async () => {
    mount({ fieldId: 'f1', fieldType: 'text', rules: [] })
    await flushPromises()

    const requiredToggle = document.querySelector('[data-rule-toggle="required"]')
    expect(requiredToggle).toBeTruthy()
  })

  it('shows text-specific rules for text fields', async () => {
    mount({ fieldId: 'f1', fieldType: 'text', rules: [] })
    await flushPromises()

    expect(document.querySelector('[data-rule-type="minLength"]')).toBeTruthy()
    expect(document.querySelector('[data-rule-type="maxLength"]')).toBeTruthy()
    expect(document.querySelector('[data-rule-type="pattern"]')).toBeTruthy()
    // number rules should not appear
    expect(document.querySelector('[data-rule-type="min"]')).toBeNull()
    expect(document.querySelector('[data-rule-type="max"]')).toBeNull()
  })

  it('shows number-specific rules for number fields', async () => {
    mount({ fieldId: 'f1', fieldType: 'number', rules: [] })
    await flushPromises()

    expect(document.querySelector('[data-rule-type="min"]')).toBeTruthy()
    expect(document.querySelector('[data-rule-type="max"]')).toBeTruthy()
    // text rules should not appear
    expect(document.querySelector('[data-rule-type="minLength"]')).toBeNull()
    expect(document.querySelector('[data-rule-type="pattern"]')).toBeNull()
  })

  it('shows enum rule for select fields', async () => {
    mount({
      fieldId: 'f1',
      fieldType: 'select',
      rules: [],
      options: [{ value: 'A' }, { value: 'B' }],
    })
    await flushPromises()

    expect(document.querySelector('[data-rule-type="enum"]')).toBeTruthy()
  })

  it('toggles required rule and emits update', async () => {
    const { emitted } = mount({ fieldId: 'f1', fieldType: 'text', rules: [] })
    await flushPromises()

    const toggle = document.querySelector('[data-rule-toggle="required"]') as HTMLInputElement
    toggle.click()
    await flushPromises()

    expect(emitted.length).toBeGreaterThan(0)
    const lastRules = emitted[emitted.length - 1]
    expect(lastRules.some((r) => r.type === 'required')).toBe(true)
  })

  it('removes a rule and emits update', async () => {
    const initialRules: FieldValidationRule[] = [{ type: 'required' }, { type: 'minLength', value: 3 }]
    const { emitted } = mount({ fieldId: 'f1', fieldType: 'text', rules: initialRules })
    await flushPromises()

    const removeBtn = document.querySelector('[data-rule-remove="minLength"]') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    removeBtn.click()
    await flushPromises()

    expect(emitted.length).toBeGreaterThan(0)
    const lastRules = emitted[emitted.length - 1]
    expect(lastRules.some((r) => r.type === 'minLength')).toBe(false)
    expect(lastRules.some((r) => r.type === 'required')).toBe(true)
  })

  it('shows preview when rules exist', async () => {
    mount({
      fieldId: 'f1',
      fieldType: 'text',
      rules: [{ type: 'required' }, { type: 'minLength', value: 5 }],
    })
    await flushPromises()

    const preview = document.querySelector('[data-validation-preview]')
    expect(preview).toBeTruthy()
  })

  it('shows pattern preset selector for text fields', async () => {
    mount({ fieldId: 'f1', fieldType: 'text', rules: [] })
    await flushPromises()

    const presetSelect = document.querySelector('[data-rule-pattern-preset]')
    expect(presetSelect).toBeTruthy()
  })

  it('shows enum values when enum rule is active for select field', async () => {
    const initialRules: FieldValidationRule[] = [{ type: 'enum', value: ['A', 'B'] }]
    mount({
      fieldId: 'f1',
      fieldType: 'select',
      rules: initialRules,
      options: [{ value: 'A' }, { value: 'B' }],
    })
    await flushPromises()

    const enumValues = document.querySelector('[data-rule-enum-values]')
    expect(enumValues).toBeTruthy()
    const chips = enumValues?.querySelectorAll('.meta-field-validation__enum-chip')
    expect(chips?.length).toBe(2)
  })
})
