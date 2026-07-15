/**
 * W2 S1 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §7 S1, §8.2): MetaRecordFieldsPanel.vue standalone coverage. This is the NEW component-level safety
 * net for the panel extracted from MetaRecordDrawer.vue's `details` tab body — the pre-existing
 * drawer specs (multitable-record-drawer*.spec.ts, meta-record-drawer-*.spec.ts,
 * multitable-ai-shortcut-drawer.spec.ts, multitable-{barcode,datetime,location,multiselect,
 * qrcode}-field.spec.ts) already re-verify byte-for-byte behavior equivalence through the drawer
 * (frozen-baseline discipline — the P2-2a pattern). This file instead pins the panel's OWN public
 * contract in isolation: props in -> fields render (incl. the load-bearing visibleFields mask), and
 * each of the panel's 7 emits fires upward with the exact payload shape the drawer relays unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordFieldsPanel from '../src/multitable/components/MetaRecordFieldsPanel.vue'
import type { AiShortcutState } from '../src/multitable/composables/useAiShortcut'
import type { MetaField, MetaFieldPermission, MetaRecord, MetaRowActions } from '../src/multitable/types'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const AI_CONFIG = { kind: 'summarize', sourceFieldIds: ['fld_src'] }

interface HarnessOptions {
  record?: MetaRecord
  fields?: MetaField[]
  canEdit?: boolean
  canComment?: boolean
  fieldPermissions?: Record<string, MetaFieldPermission>
  rowActions?: MetaRowActions | null
  aiShortcut?: AiShortcutState | null
  onPatch?: (fieldId: string, value: unknown) => void
  onAiPreview?: (field: MetaField) => void
  onAiRun?: (field: MetaField) => void
  onCommentField?: (field: MetaField) => void
  onOpenLinkPicker?: (field: MetaField) => void
  onOpenPersonPicker?: (field: MetaField) => void
  onRunButton?: (payload: { recordId: string; field: MetaField }) => void
}

const DEFAULT_RECORD = { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } } as unknown as MetaRecord
const DEFAULT_FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]

function mountPanel(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordFieldsPanel, {
        record: 'record' in options ? options.record : DEFAULT_RECORD,
        fields: options.fields ?? DEFAULT_FIELDS,
        canEdit: options.canEdit ?? true,
        canComment: options.canComment ?? false,
        fieldPermissions: options.fieldPermissions,
        rowActions: options.rowActions,
        aiShortcut: options.aiShortcut ?? null,
        ...(options.onPatch ? { onPatch: options.onPatch } : {}),
        ...(options.onAiPreview ? { onAiPreview: options.onAiPreview } : {}),
        ...(options.onAiRun ? { onAiRun: options.onAiRun } : {}),
        ...(options.onCommentField ? { onCommentField: options.onCommentField } : {}),
        ...(options.onOpenLinkPicker ? { onOpenLinkPicker: options.onOpenLinkPicker } : {}),
        ...(options.onOpenPersonPicker ? { onOpenPersonPicker: options.onOpenPersonPicker } : {}),
        ...(options.onRunButton ? { onRunButton: options.onRunButton } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

describe('MetaRecordFieldsPanel (W2 S1 extraction)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('props in -> fields render', () => {
    it('renders a visible field label + editable control from record/fields/fieldPermissions', async () => {
      const { container, app } = mountPanel()
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__label')?.textContent).toBe('Title')
      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement | null
      expect(input).not.toBeNull()
      expect(input?.value).toBe('Alpha')
      app.unmount()
    })

    it('masks a property-hidden field out of visibleFields (load-bearing — mirrors the server visible mask)', async () => {
      const fields = [
        { id: 'fld_shown', name: 'Shown', type: 'string' },
        { id: 'fld_hidden', name: 'Hidden', type: 'string' },
      ] as unknown as MetaField[]
      const record = { id: 'rec_mask', version: 1, data: { fld_shown: 'a', fld_hidden: 'b' } } as unknown as MetaRecord
      const { container, app } = mountPanel({
        record,
        fields,
        fieldPermissions: {
          fld_shown: { visible: true, readOnly: false },
          fld_hidden: { visible: false, readOnly: false },
        },
      })
      await flushUi()
      expect(container.textContent).toContain('Shown')
      expect(container.textContent).not.toContain('Hidden')
      app.unmount()
    })

    it('renders a readOnly field as display-only text, not an editable control', async () => {
      const { container, app } = mountPanel({
        fieldPermissions: { fld_title: { visible: true, readOnly: true } },
      })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__input')).toBeNull()
      expect(container.querySelector('.meta-record-drawer__text')?.textContent).toContain('Alpha')
      app.unmount()
    })

    it('renders nothing when record is absent (root v-if="record" guard)', async () => {
      const { container, app } = mountPanel({ record: undefined })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__fields')).toBeNull()
      app.unmount()
    })
  })

  describe('emit parity — exact event name + payload shape, relayed upward unchanged by the drawer', () => {
    it('emits patch(fieldId, value) on a string field change', async () => {
      const patchSpy = vi.fn()
      const { container, app } = mountPanel({ onPatch: patchSpy })
      await flushUi()
      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement
      input.value = 'Beta'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('fld_title', 'Beta')
      app.unmount()
    })

    it('emits ai-preview(field) and ai-run(field) with the full MetaField object', async () => {
      const previewSpy = vi.fn()
      const runSpy = vi.fn()
      const fields = [{ id: 'fld_ai', name: 'Summary', type: 'string', property: { aiShortcut: AI_CONFIG } }] as unknown as MetaField[]
      const record = { id: 'rec_ai', version: 1, data: { fld_ai: 'v' } } as unknown as MetaRecord
      const { container, app } = mountPanel({
        record,
        fields,
        onAiPreview: previewSpy,
        onAiRun: runSpy,
      })
      await flushUi()
      ;(container.querySelector('[data-ai-preview="fld_ai"]') as HTMLButtonElement).click()
      ;(container.querySelector('[data-ai-run="fld_ai"]') as HTMLButtonElement).click()
      expect(previewSpy).toHaveBeenCalledTimes(1)
      expect(previewSpy).toHaveBeenCalledWith(fields[0])
      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(runSpy).toHaveBeenCalledWith(fields[0])
      app.unmount()
    })

    it('emits comment-field(field) when the per-field comment anchor is clicked', async () => {
      const commentSpy = vi.fn()
      const { container, app } = mountPanel({ canComment: true, onCommentField: commentSpy })
      await flushUi()
      const anchor = container.querySelector('[data-comment-field="fld_title"]') as HTMLButtonElement
      expect(anchor).not.toBeNull()
      anchor.click()
      await flushUi()
      expect(commentSpy).toHaveBeenCalledTimes(1)
      expect(commentSpy).toHaveBeenCalledWith(DEFAULT_FIELDS[0])
      app.unmount()
    })

    it('does not render the comment anchor when resolvedCanComment is false (rowActions overrides canComment)', async () => {
      const { container, app } = mountPanel({
        canComment: true,
        rowActions: { canEdit: true, canDelete: true, canComment: false },
      })
      await flushUi()
      expect(container.querySelector('[data-comment-field="fld_title"]')).toBeNull()
      app.unmount()
    })

    it('emits open-link-picker(field) when a link field button is clicked', async () => {
      const linkSpy = vi.fn()
      const fields = [{ id: 'fld_link', name: 'Vendor', type: 'link' }] as unknown as MetaField[]
      const record = { id: 'rec_link', version: 1, data: { fld_link: [] } } as unknown as MetaRecord
      const { container, app } = mountPanel({ record, fields, onOpenLinkPicker: linkSpy })
      await flushUi()
      ;(container.querySelector('.meta-record-drawer__link-btn') as HTMLButtonElement).click()
      await flushUi()
      expect(linkSpy).toHaveBeenCalledTimes(1)
      expect(linkSpy).toHaveBeenCalledWith(fields[0])
      app.unmount()
    })

    it('emits open-person-picker(field) (not open-link-picker) when a person field button is clicked', async () => {
      const linkSpy = vi.fn()
      const personSpy = vi.fn()
      const fields = [{ id: 'fld_owner', name: 'Owner', type: 'person' }] as unknown as MetaField[]
      const record = { id: 'rec_person', version: 1, data: { fld_owner: [] } } as unknown as MetaRecord
      const { container, app } = mountPanel({
        record,
        fields,
        onOpenLinkPicker: linkSpy,
        onOpenPersonPicker: personSpy,
      })
      await flushUi()
      ;(container.querySelector('[data-test="drawer-person-picker-open"]') as HTMLButtonElement).click()
      await flushUi()
      expect(personSpy).toHaveBeenCalledTimes(1)
      expect(personSpy).toHaveBeenCalledWith(fields[0])
      expect(linkSpy).not.toHaveBeenCalled()
      app.unmount()
    })

    it('emits run-button({ recordId, field }) for a button field, matching the grid\'s payload shape', async () => {
      const runButtonSpy = vi.fn()
      const fields = [{ id: 'fld_run', name: 'Run', type: 'button', property: {} }] as unknown as MetaField[]
      const record = { id: 'rec_button', version: 1, data: {} } as unknown as MetaRecord
      const { container, app } = mountPanel({ record, fields, onRunButton: runButtonSpy })
      await flushUi()
      ;(container.querySelector('[data-test="drawer-button"]') as HTMLButtonElement).click()
      await flushUi()
      expect(runButtonSpy).toHaveBeenCalledTimes(1)
      expect(runButtonSpy).toHaveBeenCalledWith({ recordId: 'rec_button', field: fields[0] })
      app.unmount()
    })
  })

  describe('HI-1 — zero new data paths', () => {
    it('makes no fetch calls of its own (pure presentation over props already on the drawer)', async () => {
      // The panel accepts no apiClient prop at all (TS contract) — this test documents/pins that
      // absence at runtime too: mounting and interacting never touches window.fetch.
      const originalFetch = (globalThis as any).fetch
      const fetchCalls: unknown[] = []
      ;(globalThis as any).fetch = (...args: unknown[]) => {
        fetchCalls.push(args)
        return Promise.reject(new Error('unexpected fetch in MetaRecordFieldsPanel'))
      }
      const { container, app } = mountPanel({ canComment: true })
      await flushUi()
      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement
      input.value = 'Gamma'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(fetchCalls).toHaveLength(0)
      ;(globalThis as any).fetch = originalFetch
      app.unmount()
    })
  })
})
