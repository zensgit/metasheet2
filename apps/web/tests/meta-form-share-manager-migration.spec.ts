// UI-P2-1c T4 (docs/development/multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T4,
// RATIFIED) — MetaFormShareManager's close-× and two GENERIC action buttons are migrated:
//   - `.meta-form-share__close` (header ×, no pre-existing aria-label — none added, byte-equivalent) → MtIconButton
//   - Copy-link (`data-form-share-copy`) → MtButton variant="primary"
//   - Preview  (`data-form-share-preview`) → MtButton
//
// Red line (design-lock §2-T4): MetaFormShareManager is a permission-adjacent component (it
// controls WHO can open a public form). Regenerate (`data-form-share-regenerate`, rotates the
// public access token) and Clear-expiry (`data-form-share-clear-expiry`, removes the access-window
// restriction) both mutate access-control state and are explicitly NOT migrated — nor is anything
// touching the allowlist (add/remove subject, access-mode select, enabled toggle). Copy and Preview
// are the only two GENERIC (no permission mutation — clipboard copy / read-only window.open)
// buttons in this manager. This spec asserts the untouched buttons stay untouched (still native
// <button>, still carrying the shared `.meta-form-share__btn` class) alongside proving the migrated
// ones and the sharer-class split documented in the component's own CSS comment.
//
// Uses the UI-P2-1c T4 harness (`tests/helpers/mount-behind-flow.ts`) `createRoutedApiClient()` path
// — MetaFormShareManager takes a `client: MultitableApiClient` PROP (unlike TrashModal's singleton-
// composable shape, covered by the sibling `trash-modal-migration.spec.ts` via
// `patchMultitableClient()`) — driving the manager from its initial loading state to its post-load,
// button-bearing phase with zero business-logic changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import MetaFormShareManager from '../src/multitable/components/MetaFormShareManager.vue'
import { useLocale } from '../src/composables/useLocale'
import { cleanupBehindFlowMounts, createRoutedApiClient, flushBehindFlow, mountBehindFlow } from './helpers/mount-behind-flow'

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    publicToken: 'tok_abc123',
    expiresAt: null,
    status: 'active',
    accessMode: 'public',
    allowedUserIds: [],
    allowedUsers: [],
    allowedMemberGroupIds: [],
    allowedMemberGroups: [],
    ...overrides,
  }
}

function shareClient(config = fakeConfig()) {
  return createRoutedApiClient((method, url) => {
    if (method === 'GET' && url.includes('/form-share-candidates')) return { items: [], total: 0, limit: 20, query: '' }
    if (method === 'GET' && url.includes('/form-share')) return config
    if (method === 'PATCH' && url.includes('/form-share')) return config
    if (method === 'POST' && url.includes('/regenerate')) return { publicToken: 'tok_new456' }
    return undefined
  })
}

afterEach(() => {
  cleanupBehindFlowMounts()
  useLocale().setLocale('en')
})

async function mountLoaded(client: ReturnType<typeof shareClient>['client'], props: Record<string, unknown> = {}) {
  const mount = mountBehindFlow(MetaFormShareManager, { visible: true, sheetId: 'sh_1', viewId: 'v_1', client, ...props })
  await flushBehindFlow()
  return mount
}

describe('MetaFormShareManager — header close-× MtIconButton migration (UI-P2-1c T4)', () => {
  it('renders the close control as a native <button> (MtIconButton), no aria-label (byte-equivalent: none pre-existed)', async () => {
    const { client } = shareClient()
    const { container } = await mountLoaded(client)
    const btn = container.querySelector('.meta-form-share__close') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.hasAttribute('aria-label')).toBe(false)
    expect(btn.textContent?.trim()).toBe('×')
  })

  it('clicking close emits `close` with no payload (unchanged from the pre-migration @click)', async () => {
    const { client } = shareClient()
    const onClose = vi.fn()
    const { container } = await mountLoaded(client, { onClose })
    ;(container.querySelector('.meta-form-share__close') as HTMLButtonElement).click()
    await nextTick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})

describe('MetaFormShareManager — Copy-link MtButton (variant=primary) migration (UI-P2-1c T4)', () => {
  it('renders as a native <button> (MtButton primary), keeping the data-form-share-copy hook', async () => {
    const { client } = shareClient()
    const { container } = await mountLoaded(client)
    const btn = container.querySelector('[data-form-share-copy]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--primary')).toBe(true)
    expect(btn.textContent?.trim()).toBe('Copy')
    // Migrated off the old shared class (avoids double-styling the still-bespoke Regenerate/Clear-expiry
    // siblings that keep it — see the component's own `.meta-form-share__btn` CSS comment).
    expect(btn.classList.contains('meta-form-share__btn')).toBe(false)
    expect(btn.classList.contains('meta-form-share__btn--primary')).toBe(false)
  })

  it('clicking Copy still calls navigator.clipboard.writeText with the public link (unchanged @click)', async () => {
    const { client } = shareClient()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = await mountLoaded(client)
    ;(container.querySelector('[data-form-share-copy]') as HTMLButtonElement).click()
    await nextTick()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('tok_abc123')
  })

  it('the copied-label swap (copy → copied) still renders through the migrated control', async () => {
    const { client } = shareClient()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { container } = await mountLoaded(client)
    const btn = container.querySelector('[data-form-share-copy]') as HTMLButtonElement
    btn.click()
    await nextTick()
    expect(btn.textContent?.trim()).toBe('Copied!')
  })
})

describe('MetaFormShareManager — Preview MtButton migration (UI-P2-1c T4)', () => {
  it('renders as a native <button> (MtButton ghost), keeping the data-form-share-preview hook', async () => {
    const { client } = shareClient()
    const { container } = await mountLoaded(client)
    const btn = container.querySelector('[data-form-share-preview]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--ghost')).toBe(true)
    expect(btn.textContent?.trim()).toBe('Preview')
    expect(btn.classList.contains('meta-form-share__btn')).toBe(false)
  })

  it('clicking Preview still calls window.open with the public link (unchanged @click)', async () => {
    const { client } = shareClient()
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const { container } = await mountLoaded(client)
    ;(container.querySelector('[data-form-share-preview]') as HTMLButtonElement).click()
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0][0]).toContain('tok_abc123')
    expect(openSpy.mock.calls[0][1]).toBe('_blank')
    openSpy.mockRestore()
  })
})

describe('MetaFormShareManager — red line: Regenerate/Clear-expiry stay untouched native buttons (UI-P2-1c T4)', () => {
  it('Regenerate is still a bespoke native <button> carrying the shared .meta-form-share__btn class', async () => {
    const { client } = shareClient()
    const { container } = await mountLoaded(client)
    const btn = container.querySelector('[data-form-share-regenerate]') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-form-share__btn')).toBe(true)
    expect(btn.classList.contains('mt-button')).toBe(false)
  })

  it('Clear-expiry is still a bespoke native <button> carrying the shared .meta-form-share__btn class', async () => {
    const { client } = shareClient(fakeConfig({ expiresAt: '2026-08-01T00:00:00Z' }))
    const { container } = await mountLoaded(client)
    const btn = container.querySelector('[data-form-share-clear-expiry]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-form-share__btn')).toBe(true)
    expect(btn.classList.contains('mt-button')).toBe(false)
  })

  it('Regenerate click still calls the regenerate endpoint (business logic untouched)', async () => {
    const { client, fetchFn } = shareClient()
    const { container } = await mountLoaded(client)
    ;(container.querySelector('[data-form-share-regenerate]') as HTMLButtonElement).click()
    await flushBehindFlow()
    const regenerateCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/regenerate'),
    )
    expect(regenerateCalls.length).toBe(1)
  })
})
