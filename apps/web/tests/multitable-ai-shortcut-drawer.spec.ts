/**
 * A3 MetaRecordDrawer AI buttons — matrix leg A3-T3 (RBAC three-state:
 * readable→preview / editable→run / invisible→nothing) + per-run tokens
 * display + pending/countdown states (§2.2 / §2.4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { AiShortcutState } from '../src/multitable/composables/useAiShortcut'
import type { MetaField, MetaFieldPermission, MetaRecord } from '../src/multitable/types'

const AI_CONFIG = { kind: 'summarize', sourceFieldIds: ['fld_src'] }

const FIELDS = [
  { id: 'fld_t', name: 'Summary', type: 'string', property: { aiShortcut: AI_CONFIG } },
  { id: 'fld_ro', name: 'Summary RO', type: 'string', property: { aiShortcut: AI_CONFIG } },
  { id: 'fld_hidden', name: 'Hidden', type: 'string', property: { aiShortcut: AI_CONFIG } },
  { id: 'fld_plain', name: 'Plain', type: 'string', property: {} },
] as unknown as MetaField[]

const RECORD = { id: 'rec_1', version: 1, data: { fld_t: 'v', fld_ro: 'v', fld_plain: 'v' } } as unknown as MetaRecord

interface HarnessOptions {
  aiShortcut?: AiShortcutState | null
  fieldPermissions?: Record<string, MetaFieldPermission>
  onAiPreview?: (field: MetaField) => void
  onAiRun?: (field: MetaField) => void
}

function mountDrawer(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordDrawer, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        fieldPermissions: options.fieldPermissions ?? {
          fld_ro: { visible: true, readOnly: true },
          fld_hidden: { visible: false, readOnly: false },
        },
        aiShortcut: options.aiShortcut ?? null,
        ...(options.onAiPreview ? { onAiPreview: options.onAiPreview } : {}),
        ...(options.onAiRun ? { onAiRun: options.onAiRun } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

describe('MetaRecordDrawer AI shortcut buttons (A3-T3)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('editable field with aiShortcut → BOTH preview and run buttons', async () => {
    const { container, app } = mountDrawer()
    await nextTick()
    expect(container.querySelector('[data-ai-preview="fld_t"]')).toBeTruthy()
    expect(container.querySelector('[data-ai-run="fld_t"]')).toBeTruthy()
    app.unmount()
  })

  it('read-only field with aiShortcut → preview ONLY (run gated by canEditField)', async () => {
    const { container, app } = mountDrawer()
    await nextTick()
    expect(container.querySelector('[data-ai-preview="fld_ro"]')).toBeTruthy()
    expect(container.querySelector('[data-ai-run="fld_ro"]')).toBeNull()
    app.unmount()
  })

  it('invisible field → no field row, no buttons; field without aiShortcut → no buttons', async () => {
    const { container, app } = mountDrawer()
    await nextTick()
    expect(container.querySelector('[data-ai-preview="fld_hidden"]')).toBeNull()
    expect(container.querySelector('[data-ai-run="fld_hidden"]')).toBeNull()
    expect(container.querySelector('[data-ai-preview="fld_plain"]')).toBeNull()
    expect(container.querySelector('[data-ai-run="fld_plain"]')).toBeNull()
    app.unmount()
  })

  it('clicking the buttons emits ai-preview / ai-run with the field', async () => {
    const previewSpy = vi.fn()
    const runSpy = vi.fn()
    const { container, app } = mountDrawer({ onAiPreview: previewSpy, onAiRun: runSpy })
    await nextTick()

    ;(container.querySelector('[data-ai-preview="fld_t"]') as HTMLButtonElement).click()
    ;(container.querySelector('[data-ai-run="fld_t"]') as HTMLButtonElement).click()
    expect(previewSpy).toHaveBeenCalledTimes(1)
    expect(previewSpy.mock.calls[0][0].id).toBe('fld_t')
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(runSpy.mock.calls[0][0].id).toBe('fld_t')
    app.unmount()
  })

  it('pending state disables the buttons and shows in-progress copy for the active field', async () => {
    const { container, app } = mountDrawer({
      aiShortcut: {
        pending: { kind: 'run', recordId: 'rec_1', fieldId: 'fld_t' },
        result: null,
        error: null,
        retryRemainingMs: null,
      },
    })
    await nextTick()
    expect((container.querySelector('[data-ai-preview="fld_t"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-ai-run="fld_t"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-ai-preview="fld_ro"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-ai-status="fld_t"]')?.textContent).toContain('AI')
    app.unmount()
  })

  it('per-run tokens are displayed for the field a run succeeded on (T7 user-visibility leg)', async () => {
    const { container, app } = mountDrawer({
      aiShortcut: {
        pending: null,
        result: {
          kind: 'run', recordId: 'rec_1', fieldId: 'fld_t', output: 'AI OUT',
          promptTokens: 21, completionTokens: 13, totalTokens: 34, merged: true, refreshHint: false,
        },
        error: null,
        retryRemainingMs: null,
      },
    })
    await nextTick()
    expect(container.querySelector('[data-ai-status="fld_t"]')?.textContent).toContain('34 tokens')
    app.unmount()
  })

  it('drift-skipped merge shows the SAME refresh recovery copy as 409', async () => {
    const { container, app } = mountDrawer({
      aiShortcut: {
        pending: null,
        result: {
          kind: 'run', recordId: 'rec_1', fieldId: 'fld_t', output: 'AI OUT',
          promptTokens: 21, completionTokens: 13, totalTokens: 34, merged: false, refreshHint: true,
        },
        error: null,
        retryRemainingMs: null,
      },
    })
    await nextTick()
    expect(container.querySelector('[data-ai-status="fld_t"]')?.textContent).toContain('Refresh')
    app.unmount()
  })

  it('RATE_LIMITED error renders the §2.3 copy with the countdown; quota copy has no countdown', async () => {
    const limited = mountDrawer({
      aiShortcut: {
        pending: null,
        result: null,
        error: { code: 'RATE_LIMITED', message: 'raw', recordId: 'rec_1', fieldId: 'fld_t', retryAfterMs: 5000 },
        retryRemainingMs: 5000,
      },
    })
    await nextTick()
    const limitedText = limited.container.querySelector('[data-ai-status="fld_t"]')?.textContent ?? ''
    expect(limitedText).toContain('Retry in 5s')
    limited.app.unmount()
    document.body.innerHTML = ''

    const quota = mountDrawer({
      aiShortcut: {
        pending: null,
        result: null,
        error: { code: 'AI_QUOTA_EXHAUSTED', message: 'raw', recordId: 'rec_1', fieldId: 'fld_t' },
        retryRemainingMs: null,
      },
    })
    await nextTick()
    const quotaText = quota.container.querySelector('[data-ai-status="fld_t"]')?.textContent ?? ''
    expect(quotaText).toContain('quota')
    expect(quotaText).not.toContain('Retry in')
    quota.app.unmount()
  })
})
