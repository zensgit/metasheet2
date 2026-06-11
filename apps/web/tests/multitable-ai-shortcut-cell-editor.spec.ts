/**
 * A3 MetaCellEditor edit-mode run button — matrix leg A3-T6. The button's
 * RBAC safety relies on the upstream invariant that the editor only opens for
 * editable cells (LOCKED §2.2 — invariant documented in the component).
 *
 * Review F3: the RATE_LIMITED countdown (busy) disables this surface exactly
 * like the drawer's aiBusy, and the MetaGridTable host must NOT close the
 * edit session for a click the composable guard would silently refuse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

const AI_FIELD = {
  id: 'fld_t',
  name: 'Summary',
  type: 'string',
  property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_src'] } },
} as unknown as MetaField

const PLAIN_FIELD = { id: 'fld_p', name: 'Plain', type: 'string', property: {} } as unknown as MetaField

interface HarnessOptions {
  field?: MetaField
  aiRunState?: { pending: boolean; busy: boolean } | null
  onAiRun?: () => void
}

function mountEditor(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaCellEditor, {
        field: options.field ?? AI_FIELD,
        modelValue: 'text',
        aiRunState: options.aiRunState ?? null,
        ...(options.onAiRun ? { onAiRun: options.onAiRun } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

describe('MetaCellEditor AI run button (A3-T6)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders in edit mode for an aiShortcut-configured string field when the host opts in', async () => {
    const runSpy = vi.fn()
    const { container, app } = mountEditor({ aiRunState: { pending: false, busy: false }, onAiRun: runSpy })
    await nextTick()

    const button = container.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(false)
    button.click()
    expect(runSpy).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('pending state disables the button (reentrancy at the entry point)', async () => {
    const { container, app } = mountEditor({ aiRunState: { pending: true, busy: true } })
    await nextTick()
    expect((container.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement).disabled).toBe(true)
    app.unmount()
  })

  it('review F3: RATE_LIMITED countdown (busy, not pending) disables the button — click never fires', async () => {
    useLocale().setLocale('en')
    const runSpy = vi.fn()
    const { container, app } = mountEditor({ aiRunState: { pending: false, busy: true }, onAiRun: runSpy })
    await nextTick()

    const button = container.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    // Countdown is NOT a running request — the label must not lie.
    expect(button.textContent).toBe('Run AI')
    button.click() // disabled → activation suppressed, no emit
    expect(runSpy).not.toHaveBeenCalled()
    app.unmount()
  })

  it('absent without host opt-in (aiRunState null) — bulk-edit and other hosts stay untouched', async () => {
    const { container, app } = mountEditor({ aiRunState: null })
    await nextTick()
    expect(container.querySelector('[data-test="cell-ai-run"]')).toBeNull()
    app.unmount()
  })

  it('absent for fields without a persisted aiShortcut config', async () => {
    const { container, app } = mountEditor({ field: PLAIN_FIELD, aiRunState: { pending: false, busy: false } })
    await nextTick()
    expect(container.querySelector('[data-test="cell-ai-run"]')).toBeNull()
    app.unmount()
  })
})

// --- Review F3: grid-level guard — a busy click must NOT destroy the edit session ---

function mountGrid(options: { aiRunBusy: boolean; onAiRun?: (recordId: string, field: MetaField) => void }): {
  container: HTMLElement
  app: App
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaGridTable, {
        rows: [{ id: 'rec_1', version: 1, data: { fld_t: 'text' } }],
        visibleFields: [AI_FIELD],
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        searchText: '',
        rowDensity: 'normal',
        aiRunEnabled: true,
        aiRunPending: false,
        aiRunBusy: options.aiRunBusy,
        ...(options.onAiRun ? { onAiRun: options.onAiRun } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

async function openCellEditor(container: HTMLElement): Promise<HTMLButtonElement> {
  const cell = container.querySelector('.meta-grid__cell') as HTMLElement
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await nextTick()
  const button = container.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement
  expect(button, 'cell AI run button after entering edit mode').toBeTruthy()
  return button
}

describe('MetaGridTable AI run during countdown (review F3)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('busy (countdown): button disabled; even a forced click keeps the edit session open and emits nothing', async () => {
    const runSpy = vi.fn()
    const { container, app } = mountGrid({ aiRunBusy: true, onAiRun: runSpy })
    const button = await openCellEditor(container)

    expect(button.disabled).toBe(true)
    // dispatchEvent bypasses the disabled activation suppression — the host
    // guard must still refuse without calling cancelEdit().
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(runSpy).not.toHaveBeenCalled()
    // Edit session survives — the editor (and its run button) is still mounted.
    expect(container.querySelector('[data-test="cell-ai-run"]')).toBeTruthy()
    app.unmount()
  })

  it('not busy: click closes the edit session first, then emits ai-run (stale-draft hazard stays closed)', async () => {
    const runSpy = vi.fn()
    const { container, app } = mountGrid({ aiRunBusy: false, onAiRun: runSpy })
    const button = await openCellEditor(container)

    expect(button.disabled).toBe(false)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(runSpy.mock.calls[0][0]).toBe('rec_1')
    expect(container.querySelector('[data-test="cell-ai-run"]')).toBeNull() // editor closed before the run
    app.unmount()
  })
})
