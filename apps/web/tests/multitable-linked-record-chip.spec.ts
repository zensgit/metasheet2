import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import type { MetaField, MetaRecordContext } from '../src/multitable/types'

// A3: clickable linked-record chips. These specs lock the chip-click behavior
// in MetaCellRenderer's NON-person link branch, the sentinel/summary gate (no
// getRecord for the __link_summary__ fallback), the @click.stop guard against
// the cell's own select-record, and the person-exclusion.

const linkField: MetaField = {
  id: 'fld_vendor',
  name: 'Vendor',
  type: 'link',
}

// A user-refKind link is a person field — it must keep the avatar chip and never
// reach the clickable link branch (76-82).
const personField: MetaField = {
  id: 'fld_owner',
  name: 'Owner',
  type: 'link',
  property: { refKind: 'user' },
}

function foreignContext(recordId: string): MetaRecordContext {
  return {
    sheet: { id: 'sheet_vendors', name: 'Vendors' },
    fields: [{ id: 'fld_name', name: 'Vendor Name', type: 'string' }],
    record: { id: recordId, data: { fld_name: 'Acme Supply' } } as MetaRecordContext['record'],
    capabilities: {} as MetaRecordContext['capabilities'],
    commentsScope: {} as MetaRecordContext['commentsScope'],
  }
}

async function flushPromises() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

// Mount MetaCellRenderer inside a parent that wires a select-record @click on
// an ancestor — mirroring MetaGridTable's real binding (the <td> uses
// @click.stop="onCellClick(...)" which emits select-record). The chip's own
// @click.stop must keep this ancestor handler from firing.
function mountCell(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const selectRecordSpy = vi.fn()
  const Harness = defineComponent({
    setup() {
      return () =>
        h(
          'div',
          { class: 'cell-host', onClick: () => selectRecordSpy() },
          [h(MetaCellRenderer, props)],
        )
    },
  })
  const app = createApp(Harness)
  app.mount(container)
  return { container, app, selectRecordSpy }
}

describe('MetaCellRenderer linked-record chips (A3)', () => {
  it('renders a clickable chip that opens the popover and fetches the foreign record', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const { container, app } = mountCell({
      field: linkField,
      value: ['vendor_1'],
      linkSummaries: [{ id: 'vendor_1', display: 'Acme Supply' }],
      fetchRecord,
    })

    const chip = container.querySelector<HTMLButtonElement>('[data-test="link-chip"]')
    expect(chip).not.toBeNull()
    chip!.click()
    await flushPromises()

    expect(fetchRecord).toHaveBeenCalledTimes(1)
    expect(fetchRecord).toHaveBeenCalledWith('vendor_1')
    // Popover dialog renders the foreign record once loaded.
    expect(document.querySelector('.meta-linked-record-popover [role="dialog"]')).not.toBeNull()

    app.unmount()
    container.remove()
  })

  it('does NOT make a chip clickable (and never fetches) when no fetchRecord prop is supplied', async () => {
    const { container, app } = mountCell({
      field: linkField,
      value: ['vendor_1'],
      linkSummaries: [{ id: 'vendor_1', display: 'Acme Supply' }],
      // no fetchRecord → no affordance (keeps the renderer pure for reuse views)
    })

    expect(container.querySelector('[data-test="link-chip"]')).toBeNull()
    // The chip is still rendered as plain text.
    expect(container.querySelector('.meta-cell-renderer__link')).not.toBeNull()

    app.unmount()
    container.remove()
  })

  it('does NOT fetch for the __link_summary__ sentinel chip (no real id → would 404)', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    // No linkSummaries → linkItems falls back to a single summary chip whose id
    // is the __link_summary__ sentinel.
    const { container, app } = mountCell({
      field: linkField,
      value: ['vendor_1'],
      fetchRecord,
    })

    // The sentinel chip is NOT clickable.
    expect(container.querySelector('[data-test="link-chip"]')).toBeNull()
    const summaryChip = container.querySelector<HTMLElement>('.meta-cell-renderer__link')
    expect(summaryChip).not.toBeNull()
    summaryChip!.click()
    await flushPromises()
    expect(fetchRecord).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('chip @click.stop prevents the ancestor select-record click from firing', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const { container, app, selectRecordSpy } = mountCell({
      field: linkField,
      value: ['vendor_1'],
      linkSummaries: [{ id: 'vendor_1', display: 'Acme Supply' }],
      fetchRecord,
    })

    const chip = container.querySelector<HTMLButtonElement>('[data-test="link-chip"]')
    chip!.click()
    await flushPromises()

    expect(fetchRecord).toHaveBeenCalledTimes(1)
    // The select-record click on the host ancestor must NOT have fired.
    expect(selectRecordSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('person (user-refKind) link fields render avatar chips and never the clickable link chip', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const { container, app } = mountCell({
      field: personField,
      value: ['user_1'],
      linkSummaries: [{ id: 'user_1', display: 'Lin Lan' }],
      fetchRecord,
    })

    expect(container.querySelector('.meta-cell-renderer__person-chip')).not.toBeNull()
    expect(container.querySelector('[data-test="link-chip"]')).toBeNull()
    expect(fetchRecord).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('opening the same chip twice fetches once (per-id cache via popover) but a re-open is allowed', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const { container, app } = mountCell({
      field: linkField,
      value: ['vendor_1'],
      linkSummaries: [{ id: 'vendor_1', display: 'Acme Supply' }],
      fetchRecord,
    })

    const chip = container.querySelector<HTMLButtonElement>('[data-test="link-chip"]')
    chip!.click()
    await flushPromises()
    // Close the popover.
    document.querySelector<HTMLButtonElement>('.meta-linked-record-popover__close')!.click()
    await flushPromises()
    // Re-open the same chip → served from the popover's per-id cache.
    chip!.click()
    await flushPromises()

    expect(fetchRecord).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })
})
