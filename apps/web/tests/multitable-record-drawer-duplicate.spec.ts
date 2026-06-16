/**
 * Duplicate / clone record (design 2026-06-16) — MetaRecordDrawer Duplicate button.
 * The button is gated on `canCreate` (a duplicate is a create; the server re-enforces it) and emits
 * `duplicate`. Hidden when canCreate is false or when there's no record to duplicate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

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

const dupBtn = (root: HTMLElement) => root.querySelector('.meta-record-drawer__btn--duplicate') as HTMLButtonElement | null

describe('MetaRecordDrawer duplicate button', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('renders the Duplicate button when canCreate and a record is present', () => {
    const { container } = mountDrawer({ canCreate: true })
    const btn = dupBtn(container)
    expect(btn).not.toBeNull()
    expect((btn!.textContent ?? '').trim()).toBe('Duplicate')
  })

  it('localizes the Duplicate label in zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountDrawer({ canCreate: true })
    expect((dupBtn(container)!.textContent ?? '').trim()).toBe('复制')
  })

  it('hides the Duplicate button when canCreate is false (capability gate)', () => {
    const { container } = mountDrawer({ canCreate: false })
    expect(dupBtn(container)).toBeNull()
  })

  it('hides the Duplicate button when there is no record (nothing to clone)', () => {
    const { container } = mountDrawer({ canCreate: true, record: null })
    expect(dupBtn(container)).toBeNull()
  })

  it('emits duplicate on click', () => {
    const onDuplicate = vi.fn()
    const { container } = mountDrawer({ canCreate: true, onDuplicate })
    dupBtn(container)!.click()
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })
})
