import { describe, it, expect, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import {
  getFieldRequiredWhenRule,
  isFieldConditionallyRequired,
} from '../src/multitable/utils/field-visibility'
import type { MetaField } from '../src/multitable/types'

// Conditional-REQUIRED ("required-IF", A4): a field with
// `property.requiredWhen { fieldId: Y, operator: 'eq', value: 'Z' }` is required
// in the public form ONLY when Y === Z; otherwise optional. A field hidden by a
// visibility rule is NEVER conditionally required (you can't fill an invisible
// field, so it must not block submit). The rule REUSES the visibility-rule shape
// + operator vocabulary (the "equals" token is `eq`).

// Status drives both Reason's required-IF and Detail's visibility.
const STATUS_FIELD: MetaField = {
  id: 'fld_status',
  name: 'Status',
  type: 'select',
  options: [{ value: 'open' }, { value: 'rejected' }],
}
// `Reason` is required only when Status === 'rejected'. Always visible.
const REASON_FIELD: MetaField = {
  id: 'fld_reason',
  name: 'Reason',
  type: 'string',
  property: { requiredWhen: { fieldId: 'fld_status', operator: 'eq', value: 'rejected' } },
}
// `Detail` is HIDDEN unless Status === 'open', AND required-when Status ===
// 'rejected'. The two conditions are mutually exclusive on purpose: whenever the
// requiredWhen condition holds (Status === 'rejected'), the field is hidden — so
// it must never block submit.
const HIDDEN_BUT_REQUIRED_FIELD: MetaField = {
  id: 'fld_detail',
  name: 'Detail',
  type: 'string',
  property: {
    visibilityRule: { fieldId: 'fld_status', operator: 'eq', value: 'open' },
    requiredWhen: { fieldId: 'fld_status', operator: 'eq', value: 'rejected' },
  },
}
const PLAIN_FIELD: MetaField = { id: 'fld_plain', name: 'Plain', type: 'string' }

const FIELDS_BY_ID: Record<string, MetaField | undefined> = {
  [STATUS_FIELD.id]: STATUS_FIELD,
  [REASON_FIELD.id]: REASON_FIELD,
  [HIDDEN_BUT_REQUIRED_FIELD.id]: HIDDEN_BUT_REQUIRED_FIELD,
  [PLAIN_FIELD.id]: PLAIN_FIELD,
}

describe('getFieldRequiredWhenRule', () => {
  it('reads a well-formed requiredWhen rule off the property (round-trip shape)', () => {
    expect(getFieldRequiredWhenRule(REASON_FIELD)).toEqual({
      fieldId: 'fld_status',
      operator: 'eq',
      value: 'rejected',
    })
  })

  it('returns null for a field without a requiredWhen rule', () => {
    expect(getFieldRequiredWhenRule(PLAIN_FIELD)).toBeNull()
  })

  it('returns null for a malformed rule (missing fieldId / bad operator)', () => {
    expect(getFieldRequiredWhenRule({ id: 'x', name: 'X', type: 'string', property: { requiredWhen: { operator: 'eq' } } })).toBeNull()
    expect(getFieldRequiredWhenRule({ id: 'x', name: 'X', type: 'string', property: { requiredWhen: { fieldId: 'y', operator: 'frob' } } })).toBeNull()
  })

  it('does not confuse visibilityRule for requiredWhen', () => {
    const visOnly: MetaField = {
      id: 'fld_v',
      name: 'V',
      type: 'string',
      property: { visibilityRule: { fieldId: 'fld_status', operator: 'eq', value: 'open' } },
    }
    expect(getFieldRequiredWhenRule(visOnly)).toBeNull()
  })
})

describe('isFieldConditionallyRequired — evaluator', () => {
  it('no requiredWhen rule ⇒ not conditionally required', () => {
    expect(isFieldConditionallyRequired(PLAIN_FIELD, { fld_status: 'rejected' }, FIELDS_BY_ID)).toBe(false)
  })

  it('condition TRUE ⇒ conditionally required', () => {
    expect(isFieldConditionallyRequired(REASON_FIELD, { fld_status: 'rejected' }, FIELDS_BY_ID)).toBe(true)
  })

  it('condition FALSE ⇒ not conditionally required', () => {
    expect(isFieldConditionallyRequired(REASON_FIELD, { fld_status: 'open' }, FIELDS_BY_ID)).toBe(false)
    expect(isFieldConditionallyRequired(REASON_FIELD, {}, FIELDS_BY_ID)).toBe(false)
  })

  it('dangling dependency reference ⇒ not required (does not silently force required)', () => {
    const orphan: MetaField = {
      id: 'fld_o',
      name: 'O',
      type: 'string',
      property: { requiredWhen: { fieldId: 'fld_missing', operator: 'eq', value: 'x' } },
    }
    expect(isFieldConditionallyRequired(orphan, { fld_missing: 'x' }, {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Component-level: the form's submit gate actually honours required-IF and the
// hidden-field exemption. This is the feature proof (not just the evaluator).
// ---------------------------------------------------------------------------

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mountForm(onSubmit: (data: Record<string, unknown>) => void): { app: VueApp; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(MetaFormView, {
    fields: [STATUS_FIELD, REASON_FIELD, HIDDEN_BUT_REQUIRED_FIELD, PLAIN_FIELD],
    record: null,
    loading: false,
    onSubmit,
  })
  app.mount(container)
  return { app, container }
}

function clickSubmit(container: HTMLElement) {
  const form = container.querySelector('form') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
}

function setStatus(container: HTMLElement, value: string) {
  const select = container.querySelector('#field_fld_status') as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change'))
}

describe('MetaFormView — conditional-required (required-IF) submit gate', () => {
  it('condition TRUE → empty conditionally-required field BLOCKS submit', async () => {
    const onSubmit = vi.fn()
    const { app, container } = mountForm(onSubmit)
    try {
      await flushUi()
      // Status = rejected ⇒ Reason is now required; it is empty.
      setStatus(container, 'rejected')
      await flushUi()

      // aria-required reflects the active conditional requirement.
      expect(container.querySelector('#field_fld_reason')?.getAttribute('aria-required')).toBe('true')

      clickSubmit(container)
      await flushUi()

      // Submit is blocked: no emit, and an inline required error appears on Reason.
      expect(onSubmit).not.toHaveBeenCalled()
      expect(container.querySelector('#error_fld_reason')).not.toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('condition TRUE but field FILLED → submit allowed', async () => {
    const onSubmit = vi.fn()
    const { app, container } = mountForm(onSubmit)
    try {
      await flushUi()
      setStatus(container, 'rejected')
      await flushUi()
      const reason = container.querySelector('#field_fld_reason') as HTMLInputElement
      reason.value = 'Not a fit'
      reason.dispatchEvent(new Event('input'))
      await flushUi()

      clickSubmit(container)
      await flushUi()

      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onSubmit.mock.calls[0][0]).toMatchObject({ fld_status: 'rejected', fld_reason: 'Not a fit' })
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('condition FALSE → conditionally-required field is OPTIONAL (empty submit allowed)', async () => {
    const onSubmit = vi.fn()
    const { app, container } = mountForm(onSubmit)
    try {
      await flushUi()
      // Status = open ⇒ Reason's requiredWhen condition is FALSE; leave it empty.
      setStatus(container, 'open')
      await flushUi()

      // aria-required is absent while the condition does not hold.
      expect(container.querySelector('#field_fld_reason')?.getAttribute('aria-required')).toBeNull()

      clickSubmit(container)
      await flushUi()

      expect(onSubmit).toHaveBeenCalledTimes(1)
      // Reason was empty and NOT included as a blocking error.
      expect(container.querySelector('#error_fld_reason')).toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('HIDDEN field with requiredWhen → NOT required (does not block submit)', async () => {
    const onSubmit = vi.fn()
    const { app, container } = mountForm(onSubmit)
    try {
      await flushUi()
      // Status = rejected ⇒ Detail's requiredWhen holds BUT Detail's visibility
      // rule (visible only when Status === 'open') hides it. A hidden field must
      // never be conditionally required.
      setStatus(container, 'rejected')
      await flushUi()

      // Detail is hidden from the DOM entirely.
      expect(container.querySelector('#field_fld_detail')).toBeNull()
      // Fill the visible required-IF field so ONLY the hidden one could block.
      const reason = container.querySelector('#field_fld_reason') as HTMLInputElement
      reason.value = 'Reason given'
      reason.dispatchEvent(new Event('input'))
      await flushUi()

      clickSubmit(container)
      await flushUi()

      // Submit succeeds: the hidden requiredWhen field did not block it.
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(container.querySelector('#error_fld_detail')).toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('static required still blocks regardless of any requiredWhen', async () => {
    // Sanity: backward-compat — a statically required field with no requiredWhen
    // behaves exactly as today.
    const onSubmit = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const STATIC_REQ: MetaField = { id: 'fld_req', name: 'Req', type: 'string', required: true }
    const app = createApp(MetaFormView, {
      fields: [STATIC_REQ],
      record: null,
      loading: false,
      onSubmit,
    })
    app.mount(container)
    try {
      await flushUi()
      expect(container.querySelector('#field_fld_req')?.getAttribute('aria-required')).toBe('true')
      clickSubmit(container)
      await flushUi()
      expect(onSubmit).not.toHaveBeenCalled()
      expect(container.querySelector('#error_fld_req')).not.toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })
})
