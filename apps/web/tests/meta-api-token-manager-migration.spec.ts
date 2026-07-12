import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaApiTokenManager from '../src/multitable/components/MetaApiTokenManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'
import type { ApiToken, DingTalkGroupDestination, Webhook } from '../src/multitable/types'

// UI-P2-1c T5 batch-1 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T5, RATIFIED):
// MetaApiTokenManager's shared `.meta-api-mgr__btn` base class had 22 sharers across the tokens /
// webhooks / dingtalk-groups tabs — every one is migrated in this batch (lock's step (a): "纯文本
// action → MtButton"; primary/danger map to MtButton's own `variant`, everything else stays the
// default ghost). The header close-× (`.meta-api-mgr__close`, T1 pattern) is also migrated to
// MtIconButton. Bespoke hardcoded-hex CSS for both classes is removed outright in the same PR (all
// sharers migrated together — no double-styling risk); the old class names stay on the elements only
// for selector stability (existing `multitable-api-token-manager.spec.ts` queries many of them via
// `data-*` attributes, which are untouched).
//
// Stateful-toggle finding (lock §2-T5's "需 owner 定...stateful toggle 映射"): audited every one of
// the 22 sharers — NONE binds a dynamic/active CSS class or `aria-pressed` to the button itself (only
// the *label text* is data-driven, e.g. webhook/DingTalk-group "Enable"/"Disable" — same one-shot
// async-action shape as the copy/copied token button, not a persistent pressed-state control like
// MetaRecordDrawer's watch/watching toggle). So every sharer falls into step (a) (plain text action);
// none required step (b) (MtIconButton + preserved active class/aria-pressed). This is verified below
// by asserting `aria-pressed` stays absent and no `active`-shaped class appears before/after toggling.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  useLocale().setLocale('en')
})

function okResponse(body: unknown) {
  return new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function noContentResponse() {
  return new Response(null, { status: 204 })
}

function fakeToken(overrides: Partial<ApiToken> = {}): ApiToken {
  return { id: 'tok_1', name: 'Test token', prefix: 'mst_abc', scopes: [], createdAt: '2026-04-01T00:00:00Z', lastUsedAt: null, expiresAt: null, ...overrides }
}
function fakeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return { id: 'wh_1', name: 'Test webhook', url: 'https://example.com/hook', events: ['record.created'], active: true, secret: null, failureCount: 0, createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z', ...overrides }
}
function fakeGroup(overrides: Partial<DingTalkGroupDestination> = {}): DingTalkGroupDestination {
  return {
    id: 'dt_1', name: 'Ops group', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t', hasSecret: false,
    enabled: true, scope: 'sheet', sheetId: 'sheet_1', createdBy: 'u1', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
    lastTestedAt: undefined, lastTestStatus: undefined, lastTestError: undefined, ...overrides,
  }
}

function mockClient(opts: { tokens?: ApiToken[]; webhooks?: Webhook[]; groups?: DingTalkGroupDestination[] } = {}) {
  const tokens = opts.tokens ?? [fakeToken()]
  const webhooks = opts.webhooks ?? [fakeWebhook()]
  const groups = opts.groups ?? [fakeGroup()]
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/tokens')) return okResponse({ tokens })
    if (method === 'POST' && url.includes('/tokens') && !url.includes('/rotate')) return okResponse({ token: fakeToken(), plaintext: 'plain_new' })
    if (method === 'POST' && url.includes('/rotate')) return okResponse({ token: fakeToken(), plaintext: 'plain_rotated' })
    if (method === 'DELETE' && url.includes('/tokens/')) return noContentResponse()
    if (method === 'GET' && url.includes('/webhooks') && !url.includes('/deliveries')) return okResponse({ webhooks })
    if (method === 'GET' && url.includes('/webhooks/') && url.includes('/deliveries')) return okResponse({ deliveries: [] })
    if (method === 'PATCH' && url.includes('/webhooks/')) return okResponse(webhooks[0] ?? {})
    if (method === 'DELETE' && url.includes('/webhooks/')) return noContentResponse()
    if (method === 'GET' && url.includes('/dingtalk-groups/') && url.includes('/deliveries')) return okResponse({ deliveries: [] })
    if (method === 'GET' && url.includes('/dingtalk-groups') && !url.includes('/test-send')) return okResponse({ destinations: groups })
    if (method === 'POST' && url.includes('/dingtalk-groups') && url.includes('/test-send')) return noContentResponse()
    if (method === 'POST' && url.includes('/dingtalk-groups')) return okResponse({ id: 'dt_new', createdBy: 'u1', createdAt: '2026-04-01T00:00:00Z' })
    if (method === 'PATCH' && url.includes('/dingtalk-groups/')) return okResponse(groups[0] ?? {})
    if (method === 'DELETE' && url.includes('/dingtalk-groups/')) return noContentResponse()
    return okResponse({})
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaApiTokenManager, { visible: true, sheetId: 'sheet_1', ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('MetaApiTokenManager — shared-class MtButton/MtIconButton migration (UI-P2-1c T5 batch-1)', () => {
  it('close-× renders as native <button> (MtIconButton), keeps class; click still emits close (unchanged)', async () => {
    const { client } = mockClient()
    const onClose = vi.fn()
    mount({ client }, { onClose })
    await flush()

    const btn = document.querySelector('.meta-api-mgr__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-api-mgr__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph preserved via MtIconButton's default-slot fallback
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('all 22 former .meta-api-mgr__btn sharers render as native <button class="mt-button ..."> with the correct variant + the old class kept', async () => {
    const { client } = mockClient()
    mount({ client })
    await flush()

    // token tab: default (ghost), primary, danger, and the '-add' layout class survive together
    const tokenNew = document.querySelector('[data-token-new]') as HTMLButtonElement
    expect(tokenNew.tagName).toBe('BUTTON')
    expect(tokenNew.classList.contains('mt-button')).toBe(true)
    expect(tokenNew.classList.contains('mt-button--primary')).toBe(true)
    expect(tokenNew.classList.contains('meta-api-mgr__btn')).toBe(true)
    expect(tokenNew.classList.contains('meta-api-mgr__btn--primary')).toBe(true)
    expect(tokenNew.classList.contains('meta-api-mgr__btn-add')).toBe(true)

    const rotate = document.querySelector('[data-token-rotate]') as HTMLButtonElement
    expect(rotate.classList.contains('mt-button--ghost')).toBe(true)
    expect(rotate.classList.contains('meta-api-mgr__btn')).toBe(true)
    expect(rotate.classList.contains('mt-button--primary')).toBe(false)

    const revoke = document.querySelector('[data-token-revoke]') as HTMLButtonElement
    expect(revoke.classList.contains('mt-button--danger')).toBe(true)
    expect(revoke.classList.contains('meta-api-mgr__btn--danger')).toBe(true)

    // webhooks tab
    document.querySelectorAll('[role="tab"]')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    const whToggle = document.querySelector('[data-webhook-toggle]') as HTMLButtonElement
    expect(whToggle.tagName).toBe('BUTTON')
    expect(whToggle.classList.contains('mt-button')).toBe(true)

    // dingtalk tab
    document.querySelectorAll('[role="tab"]')[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    const dtDelete = document.querySelector('[data-dingtalk-group-delete]') as HTMLButtonElement
    expect(dtDelete.classList.contains('mt-button--danger')).toBe(true)
    expect(dtDelete.classList.contains('meta-api-mgr__btn--danger')).toBe(true)
  })

  it(':disabled propagates through MtButton (token-create disabled until a name is entered)', async () => {
    const { client } = mockClient()
    mount({ client })
    await flush()

    const newBtn = document.querySelector('[data-token-new]') as HTMLButtonElement
    newBtn.click()
    await flush()

    const createBtn = document.querySelector('[data-token-create]') as HTMLButtonElement
    expect(createBtn.disabled).toBe(true) // :disabled="!tokenDraft.name.trim() || busy" — name still empty

    const nameInput = document.querySelector('[data-token-name]') as HTMLInputElement
    nameInput.value = 'My token'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    expect(createBtn.disabled).toBe(false)
  })

  it('v-if survives the swap: data-token-new hides while the create form is open', async () => {
    const { client } = mockClient()
    mount({ client })
    await flush()

    expect(document.querySelector('[data-token-new]')).toBeTruthy()
    ;(document.querySelector('[data-token-new]') as HTMLButtonElement).click()
    await flush()
    expect(document.querySelector('[data-token-new]')).toBeNull() // v-if="!showTokenForm"
    expect(document.querySelector('[data-token-create]')).toBeTruthy()
  })

  it('org-scope DingTalk group: v-if on mutate-only MtButtons still hides them (readonly stays readonly)', async () => {
    const { client } = mockClient({ groups: [fakeGroup({ scope: 'org', sheetId: undefined, orgId: 'org_1' })] })
    mount({ client })
    await flush()
    document.querySelectorAll('[role="tab"]')[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(document.querySelector('[data-dingtalk-group-edit]')).toBeNull()
    expect(document.querySelector('[data-dingtalk-group-toggle]')).toBeNull()
    expect(document.querySelector('[data-dingtalk-group-test-send]')).toBeNull()
    expect(document.querySelector('[data-dingtalk-group-delete]')).toBeNull()
    // deliveries has no v-if guard — still renders for org-scope groups
    expect(document.querySelector('[data-dingtalk-group-deliveries]')).toBeTruthy()
  })

  it('text-action click: revoke token still issues the SAME DELETE call as pre-migration (unchanged handler)', async () => {
    const { client, fetchFn } = mockClient()
    mount({ client })
    await flush()

    const revokeBtn = document.querySelector('[data-token-revoke]') as HTMLButtonElement
    revokeBtn.click()
    await flush()

    const deleteCalls = fetchFn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE' && String(c[0]).includes('/tokens/'))
    expect(deleteCalls.length).toBe(1)
  })

  it('"toggle"-labeled webhook button has NO active class / aria-pressed (data-driven label only, not a stateful toggle) — click still flips the SAME `active` field via PATCH', async () => {
    const { client, fetchFn } = mockClient({ webhooks: [fakeWebhook({ active: true })] })
    mount({ client })
    await flush()
    document.querySelectorAll('[role="tab"]')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    const toggleBtn = document.querySelector('[data-webhook-toggle]') as HTMLButtonElement
    expect(toggleBtn.textContent?.trim()).toBe('Disable') // active:true → apiToggleLabel → "Disable"
    expect(toggleBtn.getAttribute('aria-pressed')).toBeNull()
    expect(Array.from(toggleBtn.classList).some((c) => /active/i.test(c))).toBe(false)

    toggleBtn.click()
    await flush()

    const patchCalls = fetchFn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH' && String(c[0]).includes('/webhooks/'))
    expect(patchCalls.length).toBe(1)
    expect(JSON.parse((patchCalls[0][1] as RequestInit).body as string)).toEqual({ active: false }) // flips the SAME active:true→false, unchanged from pre-migration onToggleWebhook
    // still no active/pressed affordance after the click resolves
    expect(toggleBtn.getAttribute('aria-pressed')).toBeNull()
    expect(Array.from(toggleBtn.classList).some((c) => /active/i.test(c))).toBe(false)
  })

  it('"toggle"-labeled DingTalk-group button: same no-active-class finding + click still flips the SAME `enabled` field via PATCH', async () => {
    const { client, fetchFn } = mockClient({ groups: [fakeGroup({ enabled: true })] })
    mount({ client })
    await flush()
    document.querySelectorAll('[role="tab"]')[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    const toggleBtn = document.querySelector('[data-dingtalk-group-toggle]') as HTMLButtonElement
    expect(toggleBtn.textContent?.trim()).toBe('Disable')
    expect(toggleBtn.getAttribute('aria-pressed')).toBeNull()

    toggleBtn.click()
    await flush()

    const patchCalls = fetchFn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH' && String(c[0]).includes('/dingtalk-groups/'))
    expect(patchCalls.length).toBe(1)
    expect(JSON.parse((patchCalls[0][1] as RequestInit).body as string)).toMatchObject({ enabled: false })
  })
})
