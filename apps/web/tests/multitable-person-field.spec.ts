import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import { isLinkField, isNativePersonField, isPersonField } from '../src/multitable/utils/link-fields'
import { isPersonSingleRecordField } from '../src/multitable/utils/person-fields'
import { formatFieldDisplay } from '../src/multitable/utils/field-display'
import type { MetaField } from '../src/multitable/types'

// Native person field (人员, design 2026-06-16) — COEXISTENCE FE specs.
//
// Two representations must both render as people chips:
//   - NATIVE: type='person', value = userId[], display from personSummaries (NO linkSummaries).
//   - LEGACY: type='link' + refKind:'user', value = recordId[], display from linkSummaries.

const nativePersonField: MetaField = { id: 'fld_owner', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }
const legacyPersonField: MetaField = { id: 'fld_assignee', name: 'Assignee', type: 'link', property: { refKind: 'user' } }
const plainLinkField: MetaField = { id: 'fld_vendor', name: 'Vendor', type: 'link' }

function mountCell(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaCellRenderer, props) })
  app.mount(container)
  return { container, app }
}

describe('person field helpers (coexistence)', () => {
  it('isNativePersonField is true ONLY for type=person', () => {
    expect(isNativePersonField(nativePersonField)).toBe(true)
    expect(isNativePersonField(legacyPersonField)).toBe(false)
    expect(isNativePersonField(plainLinkField)).toBe(false)
  })

  it('isLinkField is FALSE for native person (decoupled), TRUE for legacy person + plain link', () => {
    expect(isLinkField(nativePersonField)).toBe(false)
    expect(isLinkField(legacyPersonField)).toBe(true)
    expect(isLinkField(plainLinkField)).toBe(true)
  })

  it('isPersonField is true for BOTH native and legacy person, false for plain link', () => {
    expect(isPersonField(nativePersonField)).toBe(true)
    expect(isPersonField(legacyPersonField)).toBe(true)
    expect(isPersonField(plainLinkField)).toBe(false)
  })

  it('isPersonSingleRecordField defaults to TRUE (undefined), false only when explicitly false', () => {
    expect(isPersonSingleRecordField({ id: 'f', name: 'F', type: 'person' })).toBe(true)
    expect(isPersonSingleRecordField({ id: 'f', name: 'F', type: 'person', property: { limitSingleRecord: false } })).toBe(false)
    expect(isPersonSingleRecordField({ id: 'f', name: 'F', type: 'person', property: { limitSingleRecord: true } })).toBe(true)
  })
})

describe('formatFieldDisplay — native person resolves userId → display', () => {
  it('joins resolved member display names, falling back to userId when no summary', () => {
    const out = formatFieldDisplay({
      field: nativePersonField,
      value: ['u1', 'u_unknown'],
      personSummaries: [{ id: 'u1', display: 'Alice' }],
    })
    expect(out).toBe('Alice, u_unknown')
  })

  it('renders — for an empty native person value', () => {
    expect(formatFieldDisplay({ field: nativePersonField, value: [] })).toBe('—')
  })
})

describe('MetaCellRenderer — person chips (coexistence)', () => {
  it('NATIVE person renders chips from personSummaries (no linkSummaries needed)', async () => {
    const { container, app } = mountCell({
      field: nativePersonField,
      value: ['u1', 'u2'],
      personSummaries: [
        { id: 'u1', display: 'Alice' },
        { id: 'u2', display: 'Bob' },
      ],
    })
    await nextTick()
    const chips = container.querySelectorAll('.meta-cell-renderer__person-chip')
    expect(chips.length).toBe(2)
    const names = Array.from(container.querySelectorAll('.meta-cell-renderer__person-name')).map((n) => n.textContent)
    expect(names).toEqual(['Alice', 'Bob'])
    const initials = Array.from(container.querySelectorAll('.meta-cell-renderer__person-avatar')).map((n) => n.textContent)
    expect(initials).toEqual(['A', 'B'])
    app.unmount()
    container.remove()
  })

  it('NATIVE person falls back to the userId when a summary is missing', async () => {
    const { container, app } = mountCell({
      field: nativePersonField,
      value: ['u_ghost'],
      personSummaries: [],
    })
    await nextTick()
    const names = Array.from(container.querySelectorAll('.meta-cell-renderer__person-name')).map((n) => n.textContent)
    expect(names).toEqual(['u_ghost'])
    app.unmount()
    container.remove()
  })

  it('LEGACY link-backed person STILL renders chips from linkSummaries (coexistence regression)', async () => {
    const { container, app } = mountCell({
      field: legacyPersonField,
      value: ['rec_1'],
      linkSummaries: [{ id: 'rec_1', display: 'Carol' }],
    })
    await nextTick()
    const chips = container.querySelectorAll('.meta-cell-renderer__person-chip')
    expect(chips.length).toBe(1)
    expect(container.querySelector('.meta-cell-renderer__person-name')?.textContent).toBe('Carol')
    app.unmount()
    container.remove()
  })

  it('empty native person renders no chips', async () => {
    const { container, app } = mountCell({ field: nativePersonField, value: [], personSummaries: [] })
    await nextTick()
    expect(container.querySelectorAll('.meta-cell-renderer__person-chip').length).toBe(0)
    app.unmount()
    container.remove()
  })
})
