import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// 无法装载 / 重新输入凭据 (#6079): a source that EXISTS but the server could not load — typically
// because ENCRYPTION_KEY changed and its stored password no longer decrypts. The server now lists it
// as a SIBLING `data.loadFailed` of `data.items`, and PUT /:id/credentials can re-seal it in place.
//
// This file mocks the LOWEST seam (`utils/api`), so the real api client, the real store and the
// real panel all run: what is pinned is the wire → screen path, and the two consumer contracts that
// must NOT change — `listDataSources()` still returns `data.items` only (the workbench bridge picker
// treats every entry as usable), and the 备料 registry never counts a load-failed entry.
const apiGetMock = vi.hoisted(() => vi.fn())
const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({
  apiGet: apiGetMock,
  apiFetch: apiFetchMock,
}))

import DataSourcesPanel from '../src/components/data-sources/DataSourcesPanel.vue'
import { listDataSources, parseLoadFailedEntries, rotateDataSourceCredentials } from '../src/data-sources/api'
import {
  canResealLoadFailed,
  loadFailedBadgeText,
  RESEAL_RESTART_REQUIRED_NOTICE,
} from '../src/data-sources/loadFailedCopy'
import { DATA_SOURCE_LOAD_STATES } from '../src/data-sources/types'
import { stockPrepDataSourceRegistryFromPayload } from '../src/services/integration/stockPreparation/dataSourceRegistry'

const LOADED = { id: 'erp-ok', name: '已装载库', type: 'postgres', connected: false, referenceCount: 0 }
const CRED = { id: 'plm-cred', name: '凭据坏了的库', type: 'sqlserver', loadState: 'credentials_unreadable', ownerId: 'u1' }
const TYPE = { id: 'odd-type', name: '类型不支持', type: 'oracle', loadState: 'unsupported_type', ownerId: 'u1' }
const OTHER = { id: 'bad-row', name: '坏行', type: 'postgres', loadState: 'load_failed', ownerId: 'u1' }
// A state this client does not know (a newer server): listed, never hidden, but with no re-seal action.
const FUTURE = { id: 'future-src', name: '新状态', type: 'sqlserver', loadState: 'some_future_state', ownerId: 'u1' }

function listEnvelope(items: unknown[], loadFailed?: unknown) {
  return { ok: true, data: { items, total: items.length, ...(loadFailed === undefined ? {} : { loadFailed }) } }
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response
}

function errorResponse(status: number, body: unknown): Response {
  return { ok: false, status, statusText: 'Bad Request', json: async () => body } as unknown as Response
}

let listResponse: unknown = listEnvelope([])

beforeEach(() => {
  listResponse = listEnvelope([])
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/data-sources') return listResponse
    // GET /:id answers 404 for a load-failed source; the panel must never need it for a re-seal.
    throw new Error(`unexpected apiGet ${url}`)
  })
})

afterEach(() => {
  apiGetMock.mockReset()
  apiFetchMock.mockReset()
})

describe('api client — the sibling list is opt-in and validated', () => {
  it('listDataSources() still returns data.items ONLY (the bridge picker contract)', async () => {
    listResponse = listEnvelope([LOADED], [CRED, TYPE])
    const items = await listDataSources()
    expect(items).toEqual([LOADED])
  })

  it('onLoadFailed receives the validated sibling list; malformed entries are dropped, an unknown state is shown as load_failed', async () => {
    listResponse = listEnvelope([LOADED], [
      CRED,
      { ...TYPE, name: '' },
      { id: 'x', name: 'x', type: 'postgres', loadState: 'something_new', ownerId: 'u1' },
      { name: 'no id', loadState: 'load_failed' },
      null,
      'nope',
    ])
    let seen: unknown = null
    const items = await listDataSources({ onLoadFailed: (entries) => { seen = entries } })
    expect(items).toEqual([LOADED])
    expect(seen).toEqual([CRED, { ...TYPE, name: TYPE.id }, { id: 'x', name: 'x', type: 'postgres', loadState: 'load_failed', ownerId: 'u1' }])
    expect(parseLoadFailedEntries(undefined)).toEqual([])
    expect(parseLoadFailedEntries({ not: 'an array' })).toEqual([])
  })

  it('rotateDataSourceCredentials reports restartRequired only when the server says exactly true', async () => {
    apiFetchMock.mockResolvedValueOnce(okResponse({ ok: true, data: { id: 'a', resealed: true, restartRequired: true } }))
    await expect(rotateDataSourceCredentials('a', { credentials: { password: 'p' } })).resolves.toEqual({ restartRequired: true })
    apiFetchMock.mockResolvedValueOnce(okResponse({ ok: true, data: { id: 'a', restartRequired: 'true' } }))
    await expect(rotateDataSourceCredentials('a', { credentials: { password: 'p' } })).resolves.toEqual({ restartRequired: false })
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('no body') } } as unknown as Response)
    await expect(rotateDataSourceCredentials('a', { credentials: { password: 'p' } })).resolves.toEqual({ restartRequired: false })
  })
})

describe('备料 registry never counts a load-failed entry as a registered source', () => {
  it('a payload whose only SQL source is in loadFailed reads as absent, not present', () => {
    const registry = stockPrepDataSourceRegistryFromPayload(listEnvelope([], [CRED, OTHER]).data)
    expect(registry).toEqual({ state: 'absent', sqlCount: 0, totalCount: 0, status: null })
  })
})

describe('copy — which states get a re-seal action', () => {
  it('only credentials_unreadable is re-sealable; every state has a badge', () => {
    expect(DATA_SOURCE_LOAD_STATES).toEqual(['credentials_unreadable', 'unsupported_type', 'load_failed'])
    expect(DATA_SOURCE_LOAD_STATES.filter(canResealLoadFailed)).toEqual(['credentials_unreadable'])
    expect(loadFailedBadgeText('credentials_unreadable')).toBe('凭据无法解密，请重新输入')
    expect(loadFailedBadgeText('unsupported_type')).toBe('无法装载，请联系管理员')
    expect(loadFailedBadgeText('load_failed')).toBe('无法装载，请联系管理员')
  })
})

describe('DataSourcesPanel — 无法装载 group and 重新输入凭据', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function flush(turns = 4): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
  }

  async function mountPanel(): Promise<HTMLElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(DataSourcesPanel as Component)
    app.use(createPinia())
    app.mount(container)
    await flush(6)
    return container
  }

  function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
    return root.querySelector(selector) as T | null
  }

  function loadFailedRow(root: HTMLElement, id: string): HTMLElement {
    const row = q<HTMLElement>(root, `[data-testid="ds-load-failed-row"][data-ds-id="${id}"]`)
    expect(row, `load-failed row ${id}`).not.toBeNull()
    return row as HTMLElement
  }

  it('renders load-failed sources in their own group, apart from the loaded table', async () => {
    listResponse = listEnvelope([LOADED], [CRED, TYPE, OTHER, FUTURE])
    const el = await mountPanel()

    const loadedRows = Array.from(el.querySelectorAll('[data-testid="ds-row"]')).map((r) => r.getAttribute('data-ds-id'))
    expect(loadedRows).toEqual(['erp-ok'])

    const group = q(el, '[data-testid="ds-load-failed"]')
    expect(group).not.toBeNull()
    expect(group?.textContent).toContain('无法装载')
    const failedRows = Array.from(el.querySelectorAll('[data-testid="ds-load-failed-row"]')).map((r) => r.getAttribute('data-ds-id'))
    expect(failedRows).toEqual(['plm-cred', 'odd-type', 'bad-row', 'future-src'])

    const badge = (id: string) => q(loadFailedRow(el, id), '[data-testid="ds-load-failed-badge"]')?.textContent?.trim()
    expect(badge('plm-cred')).toBe('凭据无法解密，请重新输入')
    expect(badge('odd-type')).toBe('无法装载，请联系管理员')
    expect(badge('bad-row')).toBe('无法装载，请联系管理员')
    expect(badge('future-src')).toBe('无法装载，请联系管理员')

    // Re-seal only where a credential can help; test/edit/delete present but disabled everywhere.
    expect(q(loadFailedRow(el, 'plm-cred'), '[data-testid="ds-reseal"]')).not.toBeNull()
    expect(q(loadFailedRow(el, 'odd-type'), '[data-testid="ds-reseal"]')).toBeNull()
    expect(q(loadFailedRow(el, 'bad-row'), '[data-testid="ds-reseal"]')).toBeNull()
    expect(q(loadFailedRow(el, 'future-src'), '[data-testid="ds-reseal"]')).toBeNull()
    for (const id of ['plm-cred', 'odd-type', 'bad-row', 'future-src']) {
      const row = loadFailedRow(el, id)
      for (const testid of ['ds-load-failed-test', 'ds-load-failed-edit', 'ds-load-failed-delete']) {
        const button = q<HTMLButtonElement>(row, `[data-testid="${testid}"]`)
        expect(button, `${id} ${testid}`).not.toBeNull()
        expect(button?.disabled, `${id} ${testid}`).toBe(true)
      }
      // None of the loaded-row controls leak into the load-failed group.
      for (const testid of ['ds-test', 'ds-edit', 'ds-credentials', 'ds-delete', 'ds-schema', 'ds-preview']) {
        expect(q(row, `[data-testid="${testid}"]`), `${id} ${testid}`).toBeNull()
      }
    }
  })

  it('does not claim "no data sources" when every visible source failed to load', async () => {
    listResponse = listEnvelope([], [CRED])
    const el = await mountPanel()
    expect(q(el, '[data-testid="ds-empty"]')).toBeNull()
    expect(q(el, '[data-testid="ds-load-failed-row"]')).not.toBeNull()
  })

  it('a response without loadFailed renders exactly as before (no group)', async () => {
    listResponse = listEnvelope([LOADED])
    const el = await mountPanel()
    expect(q(el, '[data-testid="ds-load-failed"]')).toBeNull()
    expect(el.querySelectorAll('[data-testid="ds-row"]')).toHaveLength(1)
  })

  it('重新输入凭据 opens the credential form WITHOUT a detail fetch and PUTs credentials only', async () => {
    listResponse = listEnvelope([LOADED], [CRED])
    const el = await mountPanel()
    apiGetMock.mockClear()

    ;(q<HTMLButtonElement>(loadFailedRow(el, 'plm-cred'), '[data-testid="ds-reseal"]') as HTMLButtonElement).click()
    await flush()

    // No GET /api/data-sources/:id — it is a 404 for a load-failed source.
    expect(apiGetMock).not.toHaveBeenCalled()
    expect(q(el, '[data-testid="ds-credential-fields"]')).not.toBeNull()
    expect(q(el, '[data-testid="ds-reseal-note"]')).not.toBeNull()
    expect(q<HTMLInputElement>(el, '[data-testid="ds-field-id"]')?.value).toBe('plm-cred')
    expect(q<HTMLInputElement>(el, '[data-testid="ds-field-id"]')?.disabled).toBe(true)
    expect(q(el, '[data-testid="ds-field-host"]')).toBeNull()

    const password = q<HTMLInputElement>(el, '[data-testid="ds-field-password"]') as HTMLInputElement
    password.value = 'fresh-secret'
    password.dispatchEvent(new Event('input'))
    await flush()
    // The client holds no connection for this source: a draft test could only false-fail.
    expect(q(el, '[data-testid="ds-test-draft"]')).toBeNull()

    apiFetchMock.mockResolvedValueOnce(okResponse({ ok: true, data: { id: 'plm-cred', resealed: true, restartRequired: false } }))
    listResponse = listEnvelope([LOADED, { id: 'plm-cred', name: CRED.name, type: 'sqlserver', connected: false }])
    ;(q<HTMLButtonElement>(el, '[data-testid="ds-submit"]') as HTMLButtonElement).click()
    await flush(8)

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = apiFetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe('/api/data-sources/plm-cred/credentials')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ credentials: { password: 'fresh-secret' } })

    // Refetched: the source is now an ordinary loaded row, the group is gone, no restart notice.
    expect(Array.from(el.querySelectorAll('[data-testid="ds-row"]')).map((r) => r.getAttribute('data-ds-id')))
      .toEqual(['erp-ok', 'plm-cred'])
    expect(q(el, '[data-testid="ds-load-failed"]')).toBeNull()
    expect(q(el, '[data-testid="ds-notice"]')).toBeNull()
    expect(q(el, '[data-testid="ds-create-form"]')).toBeNull()
  })

  it('restartRequired:true → the panel says a restart is needed for it to take effect', async () => {
    listResponse = listEnvelope([], [CRED])
    const el = await mountPanel()
    ;(q<HTMLButtonElement>(loadFailedRow(el, 'plm-cred'), '[data-testid="ds-reseal"]') as HTMLButtonElement).click()
    await flush()
    const password = q<HTMLInputElement>(el, '[data-testid="ds-field-password"]') as HTMLInputElement
    password.value = 'fresh-secret'
    password.dispatchEvent(new Event('input'))
    await flush()

    apiFetchMock.mockResolvedValueOnce(okResponse({ ok: true, data: { id: 'plm-cred', resealed: true, restartRequired: true } }))
    // Saved but not live: the server now lists it as load_failed (an administrator's restart).
    listResponse = listEnvelope([], [{ ...CRED, loadState: 'load_failed' }])
    ;(q<HTMLButtonElement>(el, '[data-testid="ds-submit"]') as HTMLButtonElement).click()
    await flush(8)

    expect(q(el, '[data-testid="ds-notice"]')?.textContent?.trim()).toBe(RESEAL_RESTART_REQUIRED_NOTICE)
    expect(q(loadFailedRow(el, 'plm-cred'), '[data-testid="ds-load-failed-badge"]')?.textContent?.trim())
      .toBe('无法装载，请联系管理员')
    expect(q(loadFailedRow(el, 'plm-cred'), '[data-testid="ds-reseal"]')).toBeNull()
    expect(q(el, '[data-testid="ds-create-form"]')).toBeNull()
  })

  it('a CREDENTIALS_REQUIRED refusal is shown and the form stays open', async () => {
    listResponse = listEnvelope([], [CRED])
    const el = await mountPanel()
    ;(q<HTMLButtonElement>(loadFailedRow(el, 'plm-cred'), '[data-testid="ds-reseal"]') as HTMLButtonElement).click()
    await flush()
    const password = q<HTMLInputElement>(el, '[data-testid="ds-field-password"]') as HTMLInputElement
    password.value = 'fresh-secret'
    password.dispatchEvent(new Event('input'))
    await flush()

    apiFetchMock.mockResolvedValueOnce(errorResponse(400, {
      ok: false,
      error: {
        code: 'CREDENTIALS_REQUIRED',
        message: '以下已存凭据无法用当前密钥解密，请一并重新输入：apiKey',
        details: { missingCredentialKeys: ['apiKey'] },
      },
    }))
    ;(q<HTMLButtonElement>(el, '[data-testid="ds-submit"]') as HTMLButtonElement).click()
    await flush(8)

    expect(q(el, '[data-testid="ds-error"]')?.textContent).toContain('apiKey')
    expect(q(el, '[data-testid="ds-create-form"]')).not.toBeNull()
    expect(q(el, '[data-testid="ds-notice"]')).toBeNull()
  })
})
