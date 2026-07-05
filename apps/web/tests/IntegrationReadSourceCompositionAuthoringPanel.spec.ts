import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceCompositionAuthoringPanel from '../src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}
function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: { code, message, details } }), { status, headers: { 'Content-Type': 'application/json' } })
}

function deferredResponse(): { promise: Promise<Response>; resolve: (data: unknown, status?: number) => void } {
  let resolvePromise: (response: Response) => void = () => undefined
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (data: unknown, status = 200) => resolvePromise(jsonResponse(data, status)),
  }
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitUntil(condition: () => boolean, label: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

const APPROVED_RESOLVER_ROWS = [
  { id: 'rsc_material_lookup', systemId: 'sys_k3', object: 'material', mode: 'resolver_lookup', version: 1, status: 'approved', contentKey: 'ck1', createdBy: null, updatedAt: '2026-07-05' },
  { id: 'rsc_bom_lookup', systemId: 'sys_k3', object: 'bom', mode: 'resolver_lookup', version: 1, status: 'approved', contentKey: 'ck2', createdBy: null, updatedAt: '2026-07-05' },
  // Same status (approved) but the WRONG mode — must never appear in the pickers.
  { id: 'rsc_list_page', systemId: 'sys_k3', object: 'material_list', mode: 'list_page', version: 1, status: 'approved', contentKey: 'ck3', createdBy: null, updatedAt: '2026-07-05' },
  // A draft resolver_lookup row — the mock mirrors the real server's status=approved query filter (see
  // routeApiFetch below), so this row never reaches the component at all; it documents that the picker's
  // approved-only guarantee comes from the query, while the mode filter below is the component's own.
  { id: 'rsc_draft_resolver', systemId: 'sys_k3', object: 'other', mode: 'resolver_lookup', version: 1, status: 'draft', contentKey: 'ck4', createdBy: null, updatedAt: '2026-07-05' },
]

function routeApiFetch(handlers: {
  save?: (init?: RequestInit) => Response | Promise<Response>
  approve?: (id: string) => Response | Promise<Response>
  retire?: (id: string) => Response | Promise<Response>
  audit?: (id: string) => Response | Promise<Response>
} = {}): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/integration/read-source-configs')) {
      return jsonResponse(APPROVED_RESOLVER_ROWS.filter((row) => row.status === 'approved'))
    }
    const approveMatch = /\/api\/integration\/read-source-compositions\/([^/?]+)\/approve/.exec(url)
    if (approveMatch) return handlers.approve ? handlers.approve(approveMatch[1]) : jsonResponse({})
    const retireMatch = /\/api\/integration\/read-source-compositions\/([^/?]+)\/retire/.exec(url)
    if (retireMatch) return handlers.retire ? handlers.retire(retireMatch[1]) : jsonResponse({})
    const auditMatch = /\/api\/integration\/read-source-compositions\/([^/?]+)\/audit/.exec(url)
    if (auditMatch) return handlers.audit ? handlers.audit(auditMatch[1]) : jsonResponse([])
    if (url.startsWith('/api/integration/read-source-compositions')) {
      return handlers.save ? handlers.save(init) : jsonResponse({})
    }
    throw new Error(`unexpected URL ${url}`)
  }
}

describe('IntegrationReadSourceCompositionAuthoringPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalConfirm: typeof window.confirm

  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
    originalConfirm = window.confirm
    window.confirm = vi.fn(() => true)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    window.confirm = originalConfirm
  })

  function mountPanel(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationReadSourceCompositionAuthoringPanel, {
        scope: { tenantId: 'default', workspaceId: null },
      }),
    })
    app.mount(container)
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testid: string): T {
    const el = root.querySelector<T>(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`missing [data-testid=${testid}]`)
    return el
  }

  function setInput(root: HTMLElement, testid: string, value: string): void {
    const input = q<HTMLInputElement>(root, testid)
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  function setSelect(root: HTMLElement, testid: string, value: string): void {
    const select = q<HTMLSelectElement>(root, testid)
    select.value = value
    select.dispatchEvent(new Event('change'))
  }

  async function fillValidDraft(root: HTMLElement): Promise<void> {
    await waitUntil(() => root.querySelector('option[value="rsc_material_lookup"]') !== null, 'pickers load')
    setSelect(root, 'rscauth-step1', 'rsc_material_lookup')
    setSelect(root, 'rscauth-step2', 'rsc_bom_lookup')
    setInput(root, 'rscauth-name', 'material_to_bom_v1')
    setInput(root, 'rscauth-source-target', 'internal_id')
    await flushUi()
  }

  it('lists ONLY approved resolver_lookup configs in both pickers', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rsc_material_lookup"]') !== null, 'pickers load')

    const step1Options = Array.from(q<HTMLSelectElement>(root, 'rscauth-step1').querySelectorAll('option')).map((o) => o.value)
    const step2Options = Array.from(q<HTMLSelectElement>(root, 'rscauth-step2').querySelectorAll('option')).map((o) => o.value)
    for (const options of [step1Options, step2Options]) {
      expect(options).toContain('rsc_material_lookup')
      expect(options).toContain('rsc_bom_lookup')
      expect(options).not.toContain('rsc_list_page')
      expect(options).not.toContain('rsc_draft_resolver')
    }
  })

  it('write-tier gating: without integration:write the save/approve action is disabled even with a valid draft', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:read']))
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await fillValidDraft(root)

    expect(q<HTMLButtonElement>(root, 'rscauth-save').disabled).toBe(true)
    expect(q(root, 'rscauth-permission-hint')).toBeTruthy()

    q<HTMLButtonElement>(root, 'rscauth-save').click()
    await flushUi()
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes('/read-source-compositions?'))).toBe(false)
  })

  it('save POSTs exactly { config } with the pinned payload — an extra draft field never rides into the body', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:write']))
    let sentBody: Record<string, unknown> | undefined
    apiFetchMock.mockImplementation(routeApiFetch({
      save: (init) => {
        sentBody = JSON.parse(String(init?.body || '{}'))
        return jsonResponse({ id: 'rscc_1', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201)
      },
    }))
    const root = mountPanel()
    await fillValidDraft(root)

    q<HTMLButtonElement>(root, 'rscauth-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rscauth-saved"]') !== null, 'saved row appears')

    // The pinned shape: version/operations/step ids/toInput/fromStep are fixed constants that only the
    // shared service builder assembles — this component never rebuilds the payload itself, so a smuggled
    // extra draft field (already proven unreachable at the service layer in
    // readSourceCompositions.service.spec.ts) can never reach the body via this component either.
    expect(Object.keys(sentBody as object)).toEqual(['config'])
    const config = (sentBody as { config: Record<string, unknown> }).config
    expect(Object.keys(config)).toEqual(['version', 'name', 'operations', 'steps'])
    expect(config).toEqual({
      version: 1,
      name: 'material_to_bom_v1',
      operations: ['read'],
      steps: [
        { id: 'step-1', readSourceConfigId: 'rsc_material_lookup' },
        { id: 'step-2', readSourceConfigId: 'rsc_bom_lookup', input: { fromStep: 'step-1', sourceTarget: 'internal_id', toInput: 'key' } },
      ],
    })

    expect(q(root, 'rscauth-saved').textContent).toContain('rscc_1')
    expect(q(root, 'rscauth-saved').textContent).toContain('新版本')
  })

  it('400 CONFIG_INVALID renders clamped fieldErrors — a business-value triple is dropped whole', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:write']))
    apiFetchMock.mockImplementation(routeApiFetch({
      save: () => errorResponse(400, 'READ_SOURCE_COMPOSITION_CONFIG_INVALID', 'composition config is invalid', {
        errors: [
          { code: 'READ_SOURCE_COMPOSITION_NAME_INVALID', field: 'name', reason: 'invalid_identifier' },
          // business-value field (space + business token) → dropped whole by the clamp.
          { code: 'READ_SOURCE_COMPOSITION_STEP_REF_INVALID', field: 'MAT-001 SECRET', reason: 'invalid_reference' },
        ],
      }),
    }))
    const root = mountPanel()
    await fillValidDraft(root)

    q<HTMLButtonElement>(root, 'rscauth-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rscauth-field-errors"]') !== null, 'field errors render')

    const text = q(root, 'rscauth-field-errors').textContent ?? ''
    expect(text).toContain('READ_SOURCE_COMPOSITION_NAME_INVALID')
    expect(text).toContain('invalid_identifier')
    // Sentinel scan across the whole rendered surface, not just the field-errors block.
    expect(root.innerHTML).not.toContain('MAT-001 SECRET')
    expect(root.querySelector('[data-testid="rscauth-saved"]')).toBeNull()
  })

  it('approve/retire happy path transitions the saved row; a 409 renders a coarse message with no value echo', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:write']))
    let status = 'draft'
    apiFetchMock.mockImplementation(routeApiFetch({
      save: () => jsonResponse({ id: 'rscc_1', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201),
      approve: () => {
        status = 'approved'
        return jsonResponse({ id: 'rscc_1', name: 'material_to_bom_v1', version: 1, status, contentKey: 'ck', updatedAt: '2026-07-05' })
      },
      retire: () => errorResponse(409, 'READ_SOURCE_COMPOSITION_CONFIG_STATUS_CONFLICT', 'status conflict MAT-001 SECRET'),
    }))
    const root = mountPanel()
    await fillValidDraft(root)
    q<HTMLButtonElement>(root, 'rscauth-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rscauth-saved"]') !== null, 'saved row appears')

    expect(root.querySelector('[data-testid="rscauth-approve"]')).toBeTruthy()
    q<HTMLButtonElement>(root, 'rscauth-approve').click()
    await waitUntil(() => q(root, 'rscauth-saved').textContent?.includes('已审批') === true, 'row becomes approved')
    expect(root.querySelector('[data-testid="rscauth-retire"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="rscauth-approve"]')).toBeNull()

    q<HTMLButtonElement>(root, 'rscauth-retire').click()
    await waitUntil(() => root.querySelector('[data-testid="rscauth-error"]') !== null, 'retire error appears')
    const message = q(root, 'rscauth-error').textContent ?? ''
    expect(message).toContain('READ_SOURCE_COMPOSITION_CONFIG_STATUS_CONFLICT')
    expect(message).not.toContain('MAT-001 SECRET')
    // The row stays approved (retire failed) — a 409 must not optimistically flip local status.
    expect(q(root, 'rscauth-saved').textContent).toContain('已审批')
  })

  it('stale-response guard: changing the selection mid-flight drops the eventual save response', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:write']))
    const deferred = deferredResponse()
    apiFetchMock.mockImplementation(routeApiFetch({
      save: () => deferred.promise,
    }))
    const root = mountPanel()
    await fillValidDraft(root)

    q<HTMLButtonElement>(root, 'rscauth-save').click()
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'rscauth-save').textContent).toContain('保存中')

    // Change the step-2 selection while the save is still in flight — the pending response describes a
    // composition that no longer matches the visible form.
    setSelect(root, 'rscauth-step2', 'rsc_material_lookup') // NOTE: now duplicates step1, but that only
    // matters for a NEW save attempt; the point here is the draft signature changed underneath the
    // in-flight request.
    await flushUi()

    deferred.resolve({ id: 'rscc_1', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201)
    await flushUi(10)

    expect(root.querySelector('[data-testid="rscauth-saved"]')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'rscauth-save').textContent).not.toContain('保存中')
  })
})
