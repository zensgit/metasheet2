// @vitest-environment jsdom
/**
 * T6-3 — RestorePreviewDialog: the confirm panel for the preview→confirm→execute restore chain. The load-bearing
 * UI safety is `canConfirm`: the actor can only commit a real, executable, non-empty change set — never a
 * schema-drift conflict or a no-op. Mounted via createApp + a jsdom container; the dialog Teleports to body, so
 * we query document.body. `onConfirm`/`onCancel` props capture the component's emits.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import RestorePreviewDialog from '../src/multitable/components/RestorePreviewDialog.vue'
import type { RestorePreviewChange } from '../src/multitable/api/client'

type Props = {
  visible: boolean
  loading: boolean
  changes: RestorePreviewChange[]
  schemaDrift: boolean
  executable: boolean
  fieldName: (id: string) => string
  isZh: boolean
  onConfirm: () => void
  onCancel: () => void
}

const mounted: Array<{ unmount: () => void }> = []
function mountDialog(overrides: Partial<Props>) {
  const props: Props = {
    visible: true, loading: false, changes: [], schemaDrift: false, executable: false,
    fieldName: (id) => `name:${id}`, isZh: false, onConfirm: vi.fn(), onCancel: vi.fn(), ...overrides,
  }
  const app = createApp(RestorePreviewDialog, props as unknown as Record<string, unknown>)
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  mounted.push(app)
  return props
}
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null

afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

describe('RestorePreviewDialog — T6-3 confirm panel', () => {
  it('renders the masked changes and ENABLES confirm when executable + non-empty', async () => {
    const props = mountDialog({ executable: true, changes: [{ fieldId: 'f1', op: 'set', value: 'hello' }, { fieldId: 'f2', op: 'unset', value: null }] })
    await nextTick()
    expect(q('[data-test="restore-preview-changes"]')).toBeTruthy()
    expect(document.body.textContent).toContain('name:f1') // field name resolved
    expect(document.body.textContent).toContain('hello') // set value shown
    const confirm = q('[data-test="restore-preview-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    confirm.click()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows the conflict and BLOCKS confirm under schema drift (not executable)', async () => {
    const props = mountDialog({ executable: false, schemaDrift: true, changes: [{ fieldId: 'f1', op: 'set', value: 'x' }] })
    await nextTick()
    expect(q('[data-test="restore-preview-conflict"]')).toBeTruthy()
    const confirm = q('[data-test="restore-preview-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    confirm.click()
    expect(props.onConfirm).not.toHaveBeenCalled() // a conflict can never be "confirmed"
  })

  it('shows no-changes and BLOCKS confirm on an empty (no-op) diff', async () => {
    mountDialog({ executable: true, changes: [] })
    await nextTick()
    expect(q('[data-test="restore-preview-empty"]')).toBeTruthy()
    expect((q('[data-test="restore-preview-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the loading state and blocks confirm while the preview loads', async () => {
    mountDialog({ loading: true, executable: true, changes: [{ fieldId: 'f1', op: 'set', value: 'x' }] })
    await nextTick()
    expect(q('[data-test="restore-preview-loading"]')).toBeTruthy()
    expect((q('[data-test="restore-preview-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('emits cancel from the cancel button', async () => {
    const props = mountDialog({ executable: true, changes: [{ fieldId: 'f1', op: 'set', value: 'x' }] })
    await nextTick()
    const cancel = document.body.querySelectorAll('.restore-preview__btn')[0] as HTMLButtonElement
    cancel.click()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
