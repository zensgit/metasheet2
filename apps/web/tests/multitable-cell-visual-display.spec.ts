import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaCellRenderer, props)
    },
  })
  app.mount(container)
  return { container, app }
}

describe('MetaCellRenderer percent gauge', () => {
  it('renders an inline progress bar whose fill width tracks the percent value', async () => {
    const { container, app } = mount({
      field: { id: 'fld_pct', name: 'Progress', type: 'percent' },
      value: 65,
    })
    await nextTick()

    const fill = container.querySelector('.meta-cell-renderer__gauge-fill') as HTMLElement | null
    expect(fill).not.toBeNull()
    expect(fill?.style.width).toBe('65%')
    // numeric label is preserved alongside the bar (default 1-decimal percent format)
    expect(container.textContent).toContain('65.0%')

    app.unmount()
    container.remove()
  })

  it('clamps the bar fill width to 0..100 for out-of-range percent values', async () => {
    const over = mount({
      field: { id: 'fld_pct', name: 'Progress', type: 'percent' },
      value: 140,
    })
    await nextTick()
    const overFill = over.container.querySelector('.meta-cell-renderer__gauge-fill') as HTMLElement | null
    expect(overFill?.style.width).toBe('100%')
    over.app.unmount()
    over.container.remove()

    const under = mount({
      field: { id: 'fld_pct', name: 'Progress', type: 'percent' },
      value: -20,
    })
    await nextTick()
    const underFill = under.container.querySelector('.meta-cell-renderer__gauge-fill') as HTMLElement | null
    expect(underFill?.style.width).toBe('0%')
    under.app.unmount()
    under.container.remove()
  })

  it('does not render a gauge fill for a non-numeric percent value', async () => {
    const { container, app } = mount({
      field: { id: 'fld_pct', name: 'Progress', type: 'percent' },
      value: '',
    })
    await nextTick()
    expect(container.querySelector('.meta-cell-renderer__gauge-fill')).toBeNull()
    app.unmount()
    container.remove()
  })
})

describe('MetaCellRenderer rating segments', () => {
  it('renders filled and empty rating segments tracking the value and max', async () => {
    const { container, app } = mount({
      field: { id: 'fld_rate', name: 'Quality', type: 'rating', property: { max: 5 } },
      value: 3,
    })
    await nextTick()

    const segments = container.querySelectorAll('.meta-cell-renderer__rating-segment')
    expect(segments.length).toBe(5)
    const filled = container.querySelectorAll('.meta-cell-renderer__rating-segment--filled')
    expect(filled.length).toBe(3)

    app.unmount()
    container.remove()
  })

  it('honors a custom rating max', async () => {
    const { container, app } = mount({
      field: { id: 'fld_rate', name: 'Quality', type: 'rating', property: { max: 8 } },
      value: 6,
    })
    await nextTick()
    expect(container.querySelectorAll('.meta-cell-renderer__rating-segment').length).toBe(8)
    expect(container.querySelectorAll('.meta-cell-renderer__rating-segment--filled').length).toBe(6)
    app.unmount()
    container.remove()
  })
})

describe('MetaCellRenderer person avatar chip', () => {
  it('renders an avatar chip with an initial and name for a person-type field', async () => {
    // Native person (人员, design 2026-06-16): the value is a userId[] and display resolves from
    // personSummaries (NOT linkSummaries — a native person has none). userId 'user_1' → 'Jamie Park'.
    const { container, app } = mount({
      field: { id: 'fld_assignee', name: 'Assignee', type: 'person' },
      value: ['user_1'],
      personSummaries: [{ id: 'user_1', display: 'Jamie Park' }],
    })
    await nextTick()

    const chip = container.querySelector('.meta-cell-renderer__person-chip') as HTMLElement | null
    expect(chip).not.toBeNull()
    const avatar = container.querySelector('.meta-cell-renderer__person-avatar') as HTMLElement | null
    expect(avatar?.textContent?.trim()).toBe('J')
    expect(container.textContent).toContain('Jamie Park')

    app.unmount()
    container.remove()
  })

  it('renders an avatar chip for a user link field (refKind=user)', async () => {
    const { container, app } = mount({
      field: {
        id: 'fld_owner',
        name: 'Owner',
        type: 'link',
        property: { refKind: 'user', limitSingleRecord: true },
      },
      value: ['user_2'],
      linkSummaries: [{ id: 'user_2', display: 'Sofia' }],
    })
    await nextTick()

    const avatar = container.querySelector('.meta-cell-renderer__person-avatar') as HTMLElement | null
    expect(avatar?.textContent?.trim()).toBe('S')
    expect(container.textContent).toContain('Sofia')

    app.unmount()
    container.remove()
  })

  it('keeps a plain link chip (no avatar) for non-person link fields', async () => {
    const { container, app } = mount({
      field: { id: 'fld_vendor', name: 'Vendor', type: 'link' },
      value: ['rec_1'],
      linkSummaries: [{ id: 'rec_1', display: 'Acme Supply' }],
    })
    await nextTick()
    expect(container.querySelector('.meta-cell-renderer__person-avatar')).toBeNull()
    expect(container.querySelector('.meta-cell-renderer__link')).not.toBeNull()
    expect(container.textContent).toContain('Acme Supply')
    app.unmount()
    container.remove()
  })
})
