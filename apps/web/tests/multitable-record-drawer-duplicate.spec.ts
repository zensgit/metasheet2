/**
 * Duplicate / clone record (design 2026-06-16) — MetaRecordDrawer Duplicate button.
 * The button is gated on `canCreate` (a duplicate is a create; the server re-enforces it) and emits
 * `duplicate`. Hidden when canCreate is false or when there's no record to duplicate.
 *
 * Record inspector v3 (2026-09-05, PR-A §1.2): Duplicate moved from a standalone header button into
 * an `<MtMenuItem>` row inside the new kebab menu, which Teleports its open content to
 * `document.body` (NOT a descendant of `container`) — every test below opens the kebab first
 * (`openKebabMenu`) and queries `document.body`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
async function openKebabMenu(root: HTMLElement) {
  const trigger = root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')
  trigger?.click()
  await flushUi()
}

const FIELDS = [{ id: 'fld_t', name: 'Title', type: 'string', property: {} }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 1, data: { fld_t: 'v' } } as unknown as MetaRecord

interface HarnessOptions {
  canCreate?: boolean
  record?: MetaRecord | null
  onDuplicate?: () => void
}

function mountDrawer(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordDrawer, {
        visible: true,
        record: 'record' in options ? options.record : RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        canCreate: options.canCreate ?? false,
        ...(options.onDuplicate ? { onDuplicate: options.onDuplicate } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

const dupBtn = () => document.querySelector('.meta-record-drawer__btn--duplicate') as HTMLButtonElement | null

describe('MetaRecordDrawer duplicate button', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('renders the Duplicate button when canCreate and a record is present', async () => {
    const { container } = mountDrawer({ canCreate: true })
    await openKebabMenu(container)
    const btn = dupBtn()
    expect(btn).not.toBeNull()
    expect((btn!.textContent ?? '').trim()).toBe('Duplicate')
  })

  it('localizes the Duplicate label in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountDrawer({ canCreate: true })
    await openKebabMenu(container)
    expect((dupBtn()!.textContent ?? '').trim()).toBe('复制')
  })

  it('hides the Duplicate button when canCreate is false (capability gate)', async () => {
    const { container } = mountDrawer({ canCreate: false })
    await openKebabMenu(container)
    expect(dupBtn()).toBeNull()
  })

  it('hides the Duplicate button when there is no record (nothing to clone)', async () => {
    const { container } = mountDrawer({ canCreate: true, record: null })
    await openKebabMenu(container)
    expect(dupBtn()).toBeNull()
  })

  it('emits duplicate on click', async () => {
    const onDuplicate = vi.fn()
    const { container } = mountDrawer({ canCreate: true, onDuplicate })
    await openKebabMenu(container)
    dupBtn()!.click()
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })
})

// Customer feedback 2026-10-27: on a sheet whose rows a plugin maintains, /context sends
// `recordDuplicateBlocked` and the workbench passes the reason down. The entry stays VISIBLE (people can see
// why) but DISABLED, with the reason rendered inline — a disabled button's tooltip is unreliable. Mounted on
// MetaRecordInspector directly: the workbench renders it, and the MetaRecordDrawer shell above is a deprecated
// compat wrapper that does not forward the new prop.
describe('MetaRecordInspector duplicate entry on a plugin-maintained sheet (duplicateBlockedReason)', () => {
  const REASON = 'Rows on this sheet are maintained by the stock-preparation plugin (PLM pull) and cannot be duplicated.'
  let mounted: App | null = null

  afterEach(() => {
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  function mountInspector(options: { duplicateBlockedReason?: string | null; onDuplicate?: () => void }): HTMLElement {
    const container = document.createElement('div')
    document.body.appendChild(container)
    mounted = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: RECORD,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          canCreate: true,
          ...('duplicateBlockedReason' in options ? { duplicateBlockedReason: options.duplicateBlockedReason } : {}),
          ...(options.onDuplicate ? { onDuplicate: options.onDuplicate } : {}),
        })
      },
    })
    mounted.mount(container)
    return container
  }

  const reasonEl = () => document.querySelector('[data-testid="record-inspector-duplicate-blocked-reason"]')

  it('with a reason: the entry is visible, disabled, shows the reason, and a click emits nothing', async () => {
    const onDuplicate = vi.fn()
    const container = mountInspector({ duplicateBlockedReason: REASON, onDuplicate })
    await openKebabMenu(container)
    const btn = dupBtn()
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)
    expect(btn!.getAttribute('title')).toBe(REASON)
    expect((reasonEl()?.textContent ?? '').trim()).toBe(REASON)
    btn!.click()
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onDuplicate).not.toHaveBeenCalled()
  })

  it.each([
    ['null', { duplicateBlockedReason: null }],
    ['absent', {}],
  ])('without a reason (%s): unchanged — enabled, no reason, a click emits duplicate', async (_label, options) => {
    const onDuplicate = vi.fn()
    const container = mountInspector({ ...options, onDuplicate })
    await openKebabMenu(container)
    const btn = dupBtn()
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)
    expect(btn!.getAttribute('title')).toBe('Duplicate this record')
    expect(reasonEl()).toBeNull()
    btn!.click()
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })
})
