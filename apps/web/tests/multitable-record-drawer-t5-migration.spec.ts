// UI-P2-1c · T5-safe (owner-ratified 2026-07-13, docs/development/multitable-ui-p2-1c-t5-recorddrawer-decision-brief-20260712.md):
// originally migrated MetaRecordDrawer's watch / workflow / permissions / duplicate / delete /
// unlock buttons from bespoke `<button class="meta-record-drawer__btn ...">` to the shared
// `<MtButton>` primitive.
//
// Record inspector v3 (2026-09-05, PR-A §1.2) re-hosts watch / workflow / permissions / duplicate /
// delete a SECOND time — from standalone `<MtButton>` header buttons into `<MtMenuItem>` rows inside
// the new kebab menu (`data-testid="record-inspector-menu"`, `<MtMenu>` on `<MtPopover>`, which
// Teleports its open content to `document.body`). Unlock is UNCHANGED (lock banner, still
// `<MtButton>`, no menu involved). Every gate/emit/payload/class-anchor this file originally pinned
// is still asserted below — only (a) each helper now opens the kebab first and queries
// `document.body` instead of `container`, and (b) watch's `aria-pressed` became `aria-checked` +
// `role="menuitemcheckbox"` (a menu item has no native `pressed` state; a toggleable menu item is
// exactly what `menuitemcheckbox` is for, per APG).
//
// Deliberately OUT of scope (OD-T5b, split to its own governance ticket): the COMMENT button. It
// stays a bespoke `<button>` wrapping `<MetaCommentActionChip>`, byte-identical, in the toolbar (NOT
// moved into the kebab — comment-affordance lock, §4 item 8). This file's last test proves that
// boundary empirically (comment button carries no `mt-button` class).
//
// The one new a11y surface the ORIGINAL T5 migration added was `aria-pressed` on the watch toggle
// (OD-T5a option A); PR-A's re-host supersedes it with `aria-checked` (see above). The
// `--watching`/`--danger` CSS class anchors are kept as stable spec/test anchors across BOTH
// migrations, even though neither carries the bespoke background rule it originally fought (T5
// removed that fight for `--danger`; PR-A's `.meta-record-drawer__btn--danger`/`--watching` rules —
// see MetaRecordInspector.vue's own `<style>` — are now this file's sole source of that styling).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [{ id: 'fld_t', name: 'Title', type: 'string', property: {} }] as unknown as MetaField[]

function baseRecord(overrides: Partial<MetaRecord> = {}): MetaRecord {
  return {
    id: 'rec_1',
    version: 1,
    data: { fld_t: 'v' },
    ...overrides,
  } as unknown as MetaRecord
}

function fakeApiClient(overrides: Record<string, unknown> = {}) {
  return {
    getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    subscribeRecord: vi.fn().mockResolvedValue({
      subscribed: true,
      subscription: { id: 'sub_1', sheetId: 'sheet_1', recordId: 'rec_1', userId: 'u_1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }),
    unsubscribeRecord: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    listRecordPermissions: vi.fn().mockResolvedValue([]),
    listSheetPermissions: vi.fn().mockResolvedValue([]),
    listSheetPermissionCandidates: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

interface HarnessOptions {
  record?: MetaRecord | null
  canCreate?: boolean
  canDelete?: boolean
  canManageAutomation?: boolean
  canManageRecordPermissions?: boolean
  sheetId?: string
  apiClient?: Record<string, unknown>
  onDuplicate?: () => void
  onDelete?: () => void
  onOpenAutomation?: () => void
  onToggleLock?: (payload: { recordId: string; locked: boolean }) => void
}

function mountDrawer(options: HarnessOptions = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render() {
      return h(MetaRecordDrawer, {
        visible: true,
        record: 'record' in options ? options.record : baseRecord(),
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: options.canDelete ?? false,
        canCreate: options.canCreate ?? false,
        canManageAutomation: options.canManageAutomation ?? false,
        canManageRecordPermissions: options.canManageRecordPermissions ?? false,
        sheetId: options.sheetId,
        apiClient: options.apiClient as any,
        ...(options.onDuplicate ? { onDuplicate: options.onDuplicate } : {}),
        ...(options.onDelete ? { onDelete: options.onDelete } : {}),
        ...(options.onOpenAutomation ? { onOpenAutomation: options.onOpenAutomation } : {}),
        ...(options.onToggleLock ? { onToggleLock: options.onToggleLock } : {}),
      })
    },
  })
  app.mount(container)
  return container
}

// Record inspector v3 (2026-09-05, PR-A §1.2): watch/workflow/permissions/duplicate/delete moved
// from standalone header buttons into the kebab menu (`data-testid="record-inspector-menu"`), which
// is `<MtMenu>`-on-`<MtPopover>` and Teleports its open content to `document.body` — NOT a
// descendant of `container` — so every helper below (a) opens the menu first and (b) queries
// `document.body`, not `root`/`container`. Unlock stays on the lock banner (untouched) and is still
// found inside `container` with no menu interaction, unchanged from before.
async function openKebabMenu(root: HTMLElement) {
  const trigger = root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')
  // N3 (2026-09-05, round 3): fail HERE, by name, if the kebab is missing — not later as a null-deref
  // on whichever menu-item helper the calling test happens to read next.
  expect(trigger).not.toBeNull()
  // N3 root cause (2026-09-05, round 3). Symptom: "delete button renders as an MtMenuItem row" failed
  // 1/8 sibling-set runs; with the strict settle below in place the SAME failure reproduced ~1 in 5
  // full-file runs as "menu never opened" — in `duplicate button > hides when there is no record`,
  // which the old lenient helper (`trigger?.click(); await flushUi()`) let pass VACUOUSLY, since
  // `dupBtn()` is trivially null when the menu never opened at all. Nothing in the open path is
  // timer-driven (MtPopover / MtMenu / the inspector use no setTimeout or rAF; ResizeObserver is
  // absent in jsdom), so there was no "missing await" to add. The only millisecond-resolution
  // nondeterminism on the path is Vue's own DOM event invoker (@vue/runtime-dom `createInvoker`,
  // Vue 3.5.24): each handler is stamped `attached = Date.now()` when patched; the FIRST Vue handler
  // an event meets stamps the event `_vts = Date.now()`; any OUTER handler then DROPS the event when
  // `_vts <= attached`. The kebab is MtIconButton → MtButton, whose root `<button @click>` is that
  // first handler, and MtPopover's `.mt-popover__trigger` `@click` — the one that actually opens the
  // menu — is the outer one. So whenever `mountDrawer` + `flushUi()` + this click all land inside ONE
  // millisecond (routine once the JIT is warm, i.e. for the late tests in this file), the opening
  // click is silently discarded. (The overlays spec's plain `<button>` trigger has no inner Vue
  // handler, so it never hits this.) Reproduced deterministically with a Date.now()-pinned
  // micro-repro (same stamp → outer handler skipped while the inner one runs; +1ms → both run; run
  // and deleted, see the round-3 commit body). Fix: let ≥1ms of REAL time elapse after mount before
  // the click, so `Date.now()` has moved past every `attached` stamp. (No test in this file uses fake
  // timers, so a real-timer wait is safe here.) Round 4 (2026-09-05, NIT): an EXACT wait — spin (1ms
  // timer per round, capped at 50) until `Date.now()` has actually advanced past the value it held
  // here, i.e. past every `attached` stamp written during mount — rather than a fixed `setTimeout(2)`
  // that only makes the advance likely.
  const start = Date.now()
  for (let i = 0; i < 50 && Date.now() <= start; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
  trigger!.click()
  await flushUi()
  // Bounded settle, kept alongside the fix: wait until the Teleported `.mt-menu` is actually in
  // `document.body` (hard cap of 10 further rounds), then ASSERT it is — so any future "menu never
  // opened" reports by name HERE, not as a downstream null-deref, and can never again pass a
  // `hides when …` test vacuously.
  for (let i = 0; i < 10 && !document.querySelector('.mt-menu'); i += 1) await flushUi()
  expect(document.querySelector('.mt-menu')).not.toBeNull()
}
const watchBtn = () => document.querySelector('.meta-record-drawer__btn--watch') as HTMLButtonElement | null
const workflowBtn = () => document.querySelector('button[title="Open workflow designer"]') as HTMLButtonElement | null
const permissionsBtn = () => document.querySelector('button[title="Record Permissions"]') as HTMLButtonElement | null
const dupBtn = () => document.querySelector('.meta-record-drawer__btn--duplicate') as HTMLButtonElement | null
const deleteBtn = () => document.querySelector('.meta-record-drawer__btn--danger') as HTMLButtonElement | null
const unlockBtn = (root: HTMLElement) => root.querySelector('[data-test="record-unlock-action"]') as HTMLButtonElement | null

describe('MetaRecordDrawer T5-safe MtButton migration', () => {
  // ---- watch / watching (OD-T5a) ----
  describe('watch button', () => {
    it('renders as a native <button class="mt-button ..."> carrying the old classes, aria-pressed=false, not disabled once loaded', async () => {
      // A manually-controlled promise (not fakeApiClient's default mockResolvedValue) so the
      // "still loading" assertion below can be observed deterministically — opening the kebab
      // itself needs an `await flushUi()` for MtMenu's Teleport to paint (see `openKebabMenu`'s own
      // comment), which would otherwise race the mocked fetch's own microtask resolution.
      let resolveStatus: ((v: { subscribed: boolean; subscription: null }) => void) | undefined
      const client = fakeApiClient({
        getRecordSubscriptionStatus: vi.fn(() => new Promise((resolve) => { resolveStatus = resolve })),
      })
      mountDrawer({ sheetId: 'sheet_1', apiClient: client })
      await openKebabMenu(container!)
      const btnDuringLoad = watchBtn()
      expect(btnDuringLoad).not.toBeNull()
      expect(btnDuringLoad!.disabled).toBe(true) // subscriptionLoading starts true while the status fetch is in flight

      resolveStatus!({ subscribed: false, subscription: null })
      await flushUi()

      const btn = watchBtn()!
      expect(btn.tagName).toBe('BUTTON')
      expect(btn.classList.contains('mt-menu-item')).toBe(true)
      expect(btn.classList.contains('meta-record-drawer__btn')).toBe(true)
      expect(btn.classList.contains('meta-record-drawer__btn--watch')).toBe(true)
      expect(btn.classList.contains('meta-record-drawer__btn--watching')).toBe(false)
      expect(btn.disabled).toBe(false)
      expect(btn.getAttribute('aria-pressed')).toBeNull() // menuitemcheckbox now — see aria-checked below
      expect(btn.getAttribute('role')).toBe('menuitemcheckbox')
      expect(btn.getAttribute('aria-checked')).toBe('false')
      expect(btn.getAttribute('title')).toBe('Watch this record')
      expect(btn.textContent?.trim()).toBe('Watch')
    })

    it('click subscribes via the SAME apiClient call, flips aria-checked to true, adds --watching, swaps label to Watching', async () => {
      const client = fakeApiClient()
      mountDrawer({ sheetId: 'sheet_1', apiClient: client })
      await flushUi()
      await openKebabMenu(container!)

      watchBtn()!.click()
      await flushUi()

      expect(client.subscribeRecord).toHaveBeenCalledWith('sheet_1', 'rec_1')
      // Selecting a menu item auto-closes the menu (MtMenuItem's own `closeMenu()` call) — reopen to
      // read the post-click state.
      await openKebabMenu(container!)
      const btn = watchBtn()!
      expect(btn.getAttribute('aria-checked')).toBe('true')
      expect(btn.classList.contains('meta-record-drawer__btn--watching')).toBe(true)
      expect(btn.getAttribute('title')).toBe('Unwatch this record')
      expect(btn.textContent?.trim()).toBe('Watching')
    })

    it('click again unsubscribes via the SAME apiClient call and aria-checked reverts to false', async () => {
      const client = fakeApiClient()
      mountDrawer({ sheetId: 'sheet_1', apiClient: client })
      await flushUi()
      await openKebabMenu(container!)
      watchBtn()!.click()
      await flushUi()

      await openKebabMenu(container!)
      watchBtn()!.click()
      await flushUi()

      expect(client.unsubscribeRecord).toHaveBeenCalledWith('sheet_1', 'rec_1')
      await openKebabMenu(container!)
      const btn = watchBtn()!
      expect(btn.getAttribute('aria-checked')).toBe('false')
      expect(btn.classList.contains('meta-record-drawer__btn--watching')).toBe(false)
    })

    it('hides when there is nothing to subscribe to (no apiClient/sheetId) — v-if survives the swap', async () => {
      mountDrawer({})
      await flushUi()
      await openKebabMenu(container!)
      expect(watchBtn()).toBeNull()
    })
  })

  // ---- workflow / permissions (OD-T5c: glyph stays inline text in the slot) ----
  describe('workflow button', () => {
    it('renders the gear glyph + label as slot text, fires open-automation on click, hidden when canManageAutomation is false', async () => {
      const onOpenAutomation = vi.fn()
      mountDrawer({ canManageAutomation: true, onOpenAutomation })
      await flushUi()
      await openKebabMenu(container!)

      const btn = workflowBtn()!
      expect(btn).not.toBeNull()
      expect(btn.classList.contains('mt-menu-item')).toBe(true)
      expect(btn.textContent?.trim()).toBe('⚙ Workflow')

      btn.click()
      await flushUi()
      expect(onOpenAutomation).toHaveBeenCalledTimes(1)
    })

    it('hides when canManageAutomation is false', async () => {
      mountDrawer({ canManageAutomation: false })
      await flushUi()
      await openKebabMenu(container!)
      expect(workflowBtn()).toBeNull()
    })
  })

  describe('permissions button', () => {
    it('renders the lock glyph + label as slot text, click opens MetaRecordPermissionManager, hidden when the flag is false', async () => {
      const client = fakeApiClient()
      mountDrawer({ canManageRecordPermissions: true, sheetId: 'sheet_1', apiClient: client })
      await flushUi()
      await openKebabMenu(container!)

      const btn = permissionsBtn()!
      expect(btn).not.toBeNull()
      expect(btn.classList.contains('mt-menu-item')).toBe(true)
      expect(btn.textContent?.trim()).toBe('\u{1F512} Permissions')
      expect(container!.querySelector('.meta-record-perm__overlay')).toBeNull()

      btn.click()
      await flushUi()
      expect(container!.querySelector('.meta-record-perm__overlay')).not.toBeNull()
    })

    it('hides when canManageRecordPermissions is false', async () => {
      mountDrawer({ canManageRecordPermissions: false })
      await flushUi()
      await openKebabMenu(container!)
      expect(permissionsBtn()).toBeNull()
    })
  })

  // ---- duplicate / delete / unlock (OD-T5d) ----
  describe('duplicate button', () => {
    it('renders, carries the old selector-stability class, and emits duplicate on click', async () => {
      const onDuplicate = vi.fn()
      mountDrawer({ canCreate: true, onDuplicate })
      await flushUi()
      await openKebabMenu(container!)

      const btn = dupBtn()!
      expect(btn).not.toBeNull()
      expect(btn.classList.contains('mt-menu-item')).toBe(true)
      expect(btn.textContent?.trim()).toBe('Duplicate')

      btn.click()
      expect(onDuplicate).toHaveBeenCalledTimes(1)
    })

    it('hides when canCreate is false', async () => {
      mountDrawer({ canCreate: false })
      await flushUi()
      await openKebabMenu(container!)
      expect(dupBtn()).toBeNull()
    })

    it('hides when there is no record', async () => {
      mountDrawer({ canCreate: true, record: null })
      await flushUi()
      await openKebabMenu(container!)
      expect(dupBtn()).toBeNull()
    })
  })

  describe('delete button', () => {
    it('renders as an MtMenuItem row, carries the old --danger class, emits delete on click', async () => {
      const onDelete = vi.fn()
      mountDrawer({ canDelete: true, onDelete })
      await flushUi()
      await openKebabMenu(container!)

      const btn = deleteBtn()!
      expect(btn).not.toBeNull()
      expect(btn.classList.contains('mt-menu-item')).toBe(true)
      expect(btn.classList.contains('meta-record-drawer__btn--danger')).toBe(true)
      expect(btn.textContent?.trim()).toBe('Delete')

      btn.click()
      expect(onDelete).toHaveBeenCalledTimes(1)
    })

    it('hides when canDelete is false', async () => {
      mountDrawer({ canDelete: false })
      await flushUi()
      await openKebabMenu(container!)
      expect(deleteBtn()).toBeNull()
    })
  })

  describe('unlock button', () => {
    it('keeps data-test="record-unlock-action" and emits the SAME toggle-lock payload on click', async () => {
      const onToggleLock = vi.fn()
      mountDrawer({ record: baseRecord({ locked: true, canUnlock: true }), onToggleLock })
      await flushUi()

      const btn = unlockBtn(container!)!
      expect(btn).not.toBeNull()
      expect(btn.classList.contains('mt-button')).toBe(true)
      expect(btn.getAttribute('data-test')).toBe('record-unlock-action')

      btn.click()
      expect(onToggleLock).toHaveBeenCalledTimes(1)
      expect(onToggleLock).toHaveBeenCalledWith({ recordId: 'rec_1', locked: false })
    })

    it('hides when the record cannot be unlocked', async () => {
      mountDrawer({ record: baseRecord({ locked: true, canUnlock: false }) })
      await flushUi()
      expect(unlockBtn(container!)).toBeNull()
    })
  })

  // ---- OD-T5b boundary proof: comment button was NOT touched ----
  it('leaves the comment button bespoke (NOT migrated to MtButton) — OD-T5b split to separate governance', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: baseRecord(),
          fields: FIELDS,
          canEdit: true,
          canComment: true,
          canDelete: false,
        })
      },
    })
    app.mount(container)
    await flushUi()

    const commentBtn = container.querySelector('.meta-record-drawer__btn--comment') as HTMLButtonElement | null
    expect(commentBtn).not.toBeNull()
    expect(commentBtn!.tagName).toBe('BUTTON')
    expect(commentBtn!.classList.contains('mt-button')).toBe(false)
  })
})
