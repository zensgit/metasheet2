/**
 * 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §3.3, §3.7, §8 「B3」 3–4) — the record inspector (drawer):
 *
 *   I-01 「复制为新行」 is offered only when the workbench says so (`manualCopyAvailable`, decided from /context's block),
 *        and selecting it emits `manual-copy`;
 *   I-02 N2: a row's `manualSupplement` mark alone never offers it;
 *   I-03 the 「人工补充」 label in the title block follows the mark (display only, every reader);
 *   I-04 the fillable columns the workbench lifted (field permission `readOnly: false` on a manual row) render as editors
 *        and emit `patch` — the workbench routes that patch to PATCH …/manual-fields; a column it did not lift stays text.
 *
 * Collected by the required web gate through the existing `multitable-record-inspector` token. Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaFieldPermission, MetaRecord, MetaRowActions } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
async function openKebabMenu(root: HTMLElement) {
  root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')?.click()
  await flushUi()
}

const LOCK = { humanWriteLock: 'plm_system' }
const FIELDS: MetaField[] = [
  { id: 'fld_ins_code', name: '图号', type: 'string', property: { ...LOCK } },
  { id: 'fld_ins_spec', name: '组件规格', type: 'string', property: { ...LOCK } },
  { id: 'fld_ins_key', name: '唯一键', type: 'string', property: { ...LOCK } },
]
const RECORD: MetaRecord = { id: 'rec_ins_manual', version: 2, data: { fld_ins_code: 'SYN-CODE', fld_ins_spec: 'SYN-SPEC', fld_ins_key: 'manual:v1:rec_ins_manual' } }
const MANUAL: MetaRowActions = { canEdit: true, canDelete: true, canComment: false, manualSupplement: true }
const LOCKED_PERMS: Record<string, MetaFieldPermission> = {
  fld_ins_code: { visible: true, readOnly: true },
  fld_ins_spec: { visible: true, readOnly: true },
  fld_ins_key: { visible: true, readOnly: true },
}

let mounted: App | null = null

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

function mountInspector(props: Record<string, unknown>): HTMLElement {
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
        canCreate: false,
        rowActions: MANUAL,
        fieldPermissions: LOCKED_PERMS,
        ...props,
      })
    },
  })
  mounted.mount(container)
  return container
}

const copyItem = () => document.querySelector<HTMLButtonElement>('[data-testid="record-inspector-manual-copy"]')

describe('MetaRecordInspector on a project sheet with manual rows', () => {
  it('I-01 「复制为新行」 shows when the workbench offers it (zh label) and emits manual-copy', async () => {
    useLocale().setLocale('zh-CN')
    const onManualCopy = vi.fn()
    const container = mountInspector({ manualCopyAvailable: true, onManualCopy })
    await openKebabMenu(container)
    const item = copyItem()
    expect(item).not.toBeNull()
    expect(item!.textContent?.trim()).toBe('复制为新行')
    item!.click()
    expect(onManualCopy).toHaveBeenCalledTimes(1)
  })

  it('I-02 N2: the row mark alone does not offer it (default false), nor does canCreate', async () => {
    const container = mountInspector({ canCreate: true })
    await openKebabMenu(container)
    expect(copyItem()).toBeNull()
  })

  it('I-03 the 「人工补充」 label follows the row mark — and only the mark', async () => {
    useLocale().setLocale('zh-CN')
    mountInspector({})
    await flushUi()
    expect(document.querySelector('[data-testid="record-inspector-manual-supplement-tag"]')?.textContent?.trim()).toBe('人工补充')
    mounted?.unmount(); mounted = null; document.body.innerHTML = ''
    mountInspector({ rowActions: { canEdit: true, canDelete: true, canComment: false } })
    await flushUi()
    expect(document.querySelector('[data-testid="record-inspector-manual-supplement-tag"]')).toBeNull()
  })

  it('I-03b the label reaches a pure READER too (no edit, delete or create — OQ3: every actor who can read the row)', async () => {
    useLocale().setLocale('zh-CN')
    mountInspector({
      canEdit: false,
      canDelete: false,
      canCreate: false,
      rowActions: { canEdit: false, canDelete: false, canComment: false, manualSupplement: true },
    })
    await flushUi()
    expect(document.querySelector('[data-testid="record-inspector-manual-supplement-tag"]')?.textContent?.trim()).toBe('人工补充')
  })

  it('I-04 the lifted fillable column renders an editor and emits patch; the unlifted locked column stays plain text', async () => {
    const onPatch = vi.fn()
    mountInspector({
      onPatch,
      // The workbench lifts the lock's read-only on the fillable columns of a manual row (and only those).
      fieldPermissions: { ...LOCKED_PERMS, fld_ins_spec: { visible: true, readOnly: false } },
    })
    await flushUi()
    const editable = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find((input) => input.value === 'SYN-SPEC')
    expect(editable, 'the lifted 组件规格 column must render an input').toBeTruthy()
    editable!.value = 'SYN-SPEC-2'
    editable!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(onPatch).toHaveBeenCalledWith('fld_ins_spec', 'SYN-SPEC-2')
    // 唯一键 was not lifted: no input carries its value.
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input')).some((input) => input.value === 'manual:v1:rec_ins_manual')).toBe(false)
  })
})
