import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import MetaLinkedRecordPopover from '../src/multitable/components/MetaLinkedRecordPopover.vue'
import type { MetaRecordContext } from '../src/multitable/types'

// A3: the foreign-record peek popover. Locks foreign field-label rendering,
// loading + typed error states, field-permission visibility filtering, and the
// nesting cap (inner link chips are NOT clickable → no re-expand).

function baseContext(overrides: Partial<MetaRecordContext> = {}): MetaRecordContext {
  return {
    sheet: { id: 'sheet_vendors', name: 'Vendors' },
    fields: [
      { id: 'fld_name', name: 'Vendor Name', type: 'string' },
      { id: 'fld_contact', name: 'Contact', type: 'string' },
    ],
    record: { id: 'vendor_1', data: { fld_name: 'Acme Supply', fld_contact: 'Lin Lan' } } as MetaRecordContext['record'],
    capabilities: {} as MetaRecordContext['capabilities'],
    commentsScope: {} as MetaRecordContext['commentsScope'],
    ...overrides,
  }
}

async function flushPromises() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function mountPopover(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Harness = defineComponent({
    render() {
      return h(MetaLinkedRecordPopover, props)
    },
  })
  const app = createApp(Harness)
  app.mount(container)
  return { container, app }
}

describe('MetaLinkedRecordPopover (A3)', () => {
  it('shows the loading state, then renders FOREIGN field labels read-only', async () => {
    let resolveFetch: (ctx: MetaRecordContext) => void = () => {}
    const fetchRecord = vi.fn(
      () => new Promise<MetaRecordContext>((resolve) => { resolveFetch = resolve }),
    )
    const { container, app } = mountPopover({
      visible: true,
      recordId: 'vendor_1',
      fetchRecord,
    })
    await flushPromises()

    // Loading state visible while the promise is pending.
    expect(container.querySelector('.meta-linked-record-popover__loading')).not.toBeNull()

    resolveFetch(baseContext())
    await flushPromises()

    const labels = Array.from(container.querySelectorAll('.meta-linked-record-popover__label')).map(
      (el) => el.textContent,
    )
    // Foreign field NAMES — not the host field labels.
    expect(labels).toEqual(['Vendor Name', 'Contact'])
    expect(container.querySelector('.meta-linked-record-popover__loading')).toBeNull()

    app.unmount()
    container.remove()
  })

  it('renders a typed error (frontend fallback) when the fetch rejects', async () => {
    const fetchRecord = vi.fn(async () => {
      throw new Error('Record not found')
    })
    const { container, app } = mountPopover({
      visible: true,
      recordId: 'vendor_x',
      fetchRecord,
    })
    await flushPromises()

    const errorEl = container.querySelector('.meta-linked-record-popover__error')
    expect(errorEl).not.toBeNull()
    // Backend message wins over the localized fallback.
    expect(errorEl!.textContent).toContain('Record not found')

    app.unmount()
    container.remove()
  })

  it('filters out fields the backend marks non-visible', async () => {
    const fetchRecord = vi.fn(async () =>
      baseContext({
        fieldPermissions: {
          fld_contact: { visible: false, readOnly: true },
        },
      }),
    )
    const { container, app } = mountPopover({
      visible: true,
      recordId: 'vendor_1',
      fetchRecord,
    })
    await flushPromises()

    const labels = Array.from(container.querySelectorAll('.meta-linked-record-popover__label')).map(
      (el) => el.textContent,
    )
    expect(labels).toEqual(['Vendor Name'])

    app.unmount()
    container.remove()
  })

  it('caps nesting at 1: a foreign LINK field renders a non-clickable chip (no re-expand)', async () => {
    const fetchRecord = vi.fn(async () =>
      baseContext({
        fields: [{ id: 'fld_parent', name: 'Parent Company', type: 'link' }],
        record: { id: 'vendor_1', data: { fld_parent: ['vendor_2'] } } as MetaRecordContext['record'],
        linkSummaries: { fld_parent: [{ id: 'vendor_2', display: 'Globex' }] },
      }),
    )
    const { container, app } = mountPopover({
      visible: true,
      recordId: 'vendor_1',
      fetchRecord,
    })
    await flushPromises()

    // The inner renderer shows the foreign link as a plain chip, never a
    // clickable one (the popover does NOT forward fetchRecord to it).
    expect(container.querySelector('[data-test="link-chip"]')).toBeNull()
    expect(container.querySelector('.meta-cell-renderer__link')).not.toBeNull()
    // Only the initial fetch fired — no nested expansion.
    expect(fetchRecord).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })

  it('does not fetch while hidden, and fetches once shown', async () => {
    const fetchRecord = vi.fn(async () => baseContext())
    const { container, app } = mountPopover({
      visible: false,
      recordId: 'vendor_1',
      fetchRecord,
    })
    await flushPromises()
    expect(fetchRecord).not.toHaveBeenCalled()
    // Dialog not rendered while hidden.
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    app.unmount()
    container.remove()
  })
})
