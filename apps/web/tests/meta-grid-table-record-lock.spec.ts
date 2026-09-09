/**
 * LR-T9 — record-lock indicator + action visibility in MetaGridTable (design #2278 follow-up).
 *
 * Asserts:
 *  - a locked row renders the lock indicator (read-only visual)
 *  - the lock/unlock action visibility follows the server-authoritative `canUnlock` per row:
 *      · locked row + canUnlock=true  → unlock action shown
 *      · locked row + canUnlock=false → no unlock action
 *      · unlocked row + canEdit       → lock action shown
 *  - toggling the action emits `toggle-lock` with the inverse locked state
 *  - a locked row's cells are not editable (no edit cell on dblclick)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
let emitted: Array<{ recordId: string; locked: boolean }> = []

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  emitted = []
  useLocale().setLocale('en')
})

const TITLE_FIELD: MetaField = { id: 'title', name: 'Title', type: 'string' }

function mountGrid(rows: MetaRecord[], props: Record<string, unknown> = {}) {
  // Tear down any prior mount so a test that mounts twice (e.g. canUnlock true vs false) does not leak
  // a stale container that pollutes the next querySelector.
  app?.unmount()
  container?.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  emitted = []
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows,
        visibleFields: [TITLE_FIELD],
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        canDelete: true,
        canBulkEdit: true,
        enableMultiSelect: true,
        searchText: '',
        rowDensity: 'normal',
        canComment: true,
        'onToggle-lock': (payload: { recordId: string; locked: boolean }) => emitted.push(payload),
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaGridTable record locking (LR-T9)', () => {
  it('renders a lock indicator on a locked row', () => {
    const rows: MetaRecord[] = [{ id: 'r1', version: 1, data: { title: 'Locked' }, locked: true, lockedBy: 'u1', canUnlock: false }]
    const root = mountGrid(rows)
    expect(root.querySelector('[data-test="row-lock-indicator"]')).toBeTruthy()
    expect(root.querySelector('.meta-grid__row-num-lock-slot')).toBeTruthy()
  })

  it('keeps expand, index, and lock as sibling gutter slots on a locked row', () => {
    const rows: MetaRecord[] = [{ id: 'r1', version: 1, data: { title: 'Locked' }, locked: true, lockedBy: 'u1', canUnlock: false }]
    const root = mountGrid(rows)
    const gutter = root.querySelector('tbody .meta-grid__row-num') as HTMLElement
    const expand = gutter.querySelector('.meta-grid__expand-btn')
    const index = gutter.querySelector('.meta-grid__row-num-index')
    const lock = gutter.querySelector('.meta-grid__row-num-lock-slot')
    const indicator = gutter.querySelector('[data-test="row-lock-indicator"]')
    expect(expand?.parentElement).toBe(gutter)
    expect(index?.parentElement).toBe(gutter)
    expect(lock?.parentElement).toBe(gutter)
    expect(index?.textContent?.trim()).toBe('1')
    expect(lock?.contains(indicator)).toBe(true)
    expect(index?.contains(indicator)).toBe(false)
    expect(expand?.contains(indicator)).toBe(false)
  })

  it('does NOT render a lock indicator on an unlocked row', () => {
    const rows: MetaRecord[] = [{ id: 'r1', version: 1, data: { title: 'Open' } }]
    const root = mountGrid(rows)
    expect(root.querySelector('[data-test="row-lock-indicator"]')).toBeNull()
  })

  it('shows the unlock action only when canUnlock is true on a locked row', () => {
    const canUnlock = mountGrid([
      { id: 'r1', version: 1, data: { title: 'L' }, locked: true, lockedBy: 'me', canUnlock: true },
    ])
    expect(canUnlock.querySelector('[data-test="row-lock-action"]')).toBeTruthy()

    const cannotUnlock = mountGrid([
      { id: 'r1', version: 1, data: { title: 'L' }, locked: true, lockedBy: 'other', canUnlock: false },
    ])
    expect(cannotUnlock.querySelector('[data-test="row-lock-action"]')).toBeNull()
  })

  it('shows the lock action on an unlocked editable row as a muted outline, not a gold padlock', () => {
    const root = mountGrid([{ id: 'r1', version: 1, data: { title: 'Open' } }])
    const action = root.querySelector('[data-test="row-lock-action"]') as HTMLButtonElement | null
    expect(action).toBeTruthy()
    expect(action!.classList.contains('meta-grid__lock-action--idle')).toBe(true)
    expect(action!.textContent).not.toMatch(/🔒|🔓|\u{1F512}/u)
    expect(action!.querySelector('svg')).toBeTruthy()
  })

  it('emits toggle-lock with the inverse locked state when clicked', async () => {
    const root = mountGrid([{ id: 'r1', version: 1, data: { title: 'L' }, locked: true, canUnlock: true }])
    const btn = root.querySelector('[data-test="row-lock-action"]') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    btn!.click()
    await nextTick()
    expect(emitted).toEqual([{ recordId: 'r1', locked: false }])
  })

  it('does not start a cell edit on a locked row (read-only visual)', async () => {
    const root = mountGrid([{ id: 'r1', version: 1, data: { title: 'L' }, locked: true, canUnlock: false }])
    const cell = root.querySelector('tbody tr .meta-grid__cell') as HTMLElement | null
    expect(cell).toBeTruthy()
    cell!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    // no editor mounted → the read-only class stays and no <input>/editor appears in the cell
    expect(cell!.querySelector('.meta-grid__cell--editing')).toBeNull()
    expect(cell!.classList.contains('meta-grid__cell--readonly')).toBe(true)
  })
})
