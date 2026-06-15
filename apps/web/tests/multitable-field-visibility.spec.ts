import { describe, it, expect } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import { getFieldVisibilityRule, isFieldVisible } from '../src/multitable/utils/field-visibility'
import type { MetaField } from '../src/multitable/types'

// Conditional field-VISIBILITY MVP (2026-06-14): a field with a
// `property.visibilityRule { fieldId: Y, operator: 'eq', value: 'Z' }` is HIDDEN
// in the form when Y !== Z, SHOWN when Y === Z; no rule ⇒ always shown.
// NOTE: the reused conditional-formatting operator token for "equals" is `eq`.

const STATUS_FIELD: MetaField = {
  id: 'fld_status',
  name: 'Status',
  type: 'select',
  options: [{ value: 'open' }, { value: 'closed' }],
}
// `Reason` is visible only when Status === 'closed'.
const REASON_FIELD: MetaField = {
  id: 'fld_reason',
  name: 'Reason',
  type: 'string',
  property: { visibilityRule: { fieldId: 'fld_status', operator: 'eq', value: 'closed' } },
}
const PLAIN_FIELD: MetaField = { id: 'fld_plain', name: 'Plain', type: 'string' }

const FIELDS_BY_ID: Record<string, MetaField | undefined> = {
  [STATUS_FIELD.id]: STATUS_FIELD,
  [REASON_FIELD.id]: REASON_FIELD,
  [PLAIN_FIELD.id]: PLAIN_FIELD,
}

describe('getFieldVisibilityRule', () => {
  it('reads a well-formed rule off the property', () => {
    expect(getFieldVisibilityRule(REASON_FIELD)).toEqual({
      fieldId: 'fld_status',
      operator: 'eq',
      value: 'closed',
    })
  })

  it('returns null for a field without a rule', () => {
    expect(getFieldVisibilityRule(PLAIN_FIELD)).toBeNull()
  })

  it('returns null for a malformed rule (missing fieldId / bad operator)', () => {
    expect(getFieldVisibilityRule({ id: 'x', name: 'X', type: 'string', property: { visibilityRule: { operator: 'eq' } } })).toBeNull()
    expect(getFieldVisibilityRule({ id: 'x', name: 'X', type: 'string', property: { visibilityRule: { fieldId: 'y', operator: 'frob' } } })).toBeNull()
  })
})

describe('isFieldVisible — evaluator', () => {
  it('no rule ⇒ always visible', () => {
    expect(isFieldVisible(PLAIN_FIELD, {}, FIELDS_BY_ID)).toBe(true)
    expect(isFieldVisible(PLAIN_FIELD, { anything: 1 }, FIELDS_BY_ID)).toBe(true)
  })

  it('HIDDEN when dependency value !== rule value (Y != Z)', () => {
    expect(isFieldVisible(REASON_FIELD, { fld_status: 'open' }, FIELDS_BY_ID)).toBe(false)
    expect(isFieldVisible(REASON_FIELD, {}, FIELDS_BY_ID)).toBe(false)
  })

  it('SHOWN when dependency value === rule value (Y == Z)', () => {
    expect(isFieldVisible(REASON_FIELD, { fld_status: 'closed' }, FIELDS_BY_ID)).toBe(true)
  })

  it('dangling dependency reference ⇒ hidden (does not silently force visible)', () => {
    const orphan: MetaField = {
      id: 'fld_o',
      name: 'O',
      type: 'string',
      property: { visibilityRule: { fieldId: 'fld_missing', operator: 'eq', value: 'x' } },
    }
    expect(isFieldVisible(orphan, { fld_missing: 'x' }, {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Component-level: the form actually shows/hides the field live as the user
// edits the dependency. This is the feature proof (not just the evaluator).
// ---------------------------------------------------------------------------

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mountForm(): { app: VueApp; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(MetaFormView, {
    fields: [STATUS_FIELD, REASON_FIELD, PLAIN_FIELD],
    record: null,
    loading: false,
  })
  app.mount(container)
  return { app, container }
}

describe('MetaFormView — conditional field visibility (live)', () => {
  it('hides the rule-gated field until its dependency satisfies the condition', async () => {
    const { app, container } = mountForm()
    try {
      await flushUi()

      // Status (dependency) + Plain (no rule) always present; Reason hidden initially.
      expect(container.querySelector('#field_fld_status')).not.toBeNull()
      expect(container.querySelector('#field_fld_plain')).not.toBeNull()
      expect(container.querySelector('#field_fld_reason')).toBeNull()

      // User picks Status = 'closed' → Reason appears.
      const select = container.querySelector('#field_fld_status') as HTMLSelectElement
      select.value = 'closed'
      select.dispatchEvent(new Event('change'))
      await flushUi()
      expect(container.querySelector('#field_fld_reason')).not.toBeNull()

      // User switches Status back to 'open' → Reason disappears again.
      select.value = 'open'
      select.dispatchEvent(new Event('change'))
      await flushUi()
      expect(container.querySelector('#field_fld_reason')).toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })
})
