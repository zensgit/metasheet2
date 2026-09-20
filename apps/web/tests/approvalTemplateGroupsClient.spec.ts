import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApprovalApiError,
  archiveApprovalTemplateGroup,
  createApprovalTemplateGroup,
  linkApprovalTemplateToGroup,
  listApprovalTemplateGroups,
  renameApprovalTemplateGroup,
  unarchiveApprovalTemplateGroup,
  unlinkApprovalTemplateFromGroup,
} from '../src/approvals/api'

/**
 * A-2 slice 2 (approval form grouping lock v2.13 §6 phase 1 front-end client, 2026-09-18) — unit
 * coverage for the seven group-endpoint client functions added to `approvals/api.ts`.
 *
 * These functions carry no `USE_MOCK` gate (unlike most of this file — see the module doc), so
 * they always take the real `apiFetch` path here, unlike `createApproval`/`dispatchAction`
 * elsewhere in this file which `approvalApiErrorSurfacing.spec.ts` documents as unreachable under
 * Vitest (`import.meta.env.DEV` is always true there). `api.spec.ts` establishes the same
 * `vi.stubGlobal('fetch', ...)` pattern (no `resetModules`/`stubEnv` needed) for exactly this
 * reason: a function with no mock branch has nothing to bypass.
 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() { return this },
  } as unknown as Response
}

const SAMPLE_GROUP = {
  id: 'atg_1',
  orgId: 'org_1',
  name: 'Finance',
  sortOrder: 1,
  createdBy: 'user_1',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
  archivedAt: null,
}

const SAMPLE_LINK = {
  orgId: 'org_1',
  templateId: 'tpl_1',
  groupId: 'atg_1',
  linkedBy: 'user_1',
  linkedAt: '2026-09-18T00:00:00.000Z',
  unlinkedAt: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('approval template group client (design lock v2.13 §6 phase 1)', () => {
  it('listApprovalTemplateGroups: GETs the list endpoint and unwraps { groups }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { groups: [SAMPLE_GROUP] }))
    vi.stubGlobal('fetch', fetchMock)

    const groups = await listApprovalTemplateGroups()

    expect(groups).toEqual([SAMPLE_GROUP])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/approval-template-groups')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('createApprovalTemplateGroup: POSTs { name } and unwraps { group }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { group: SAMPLE_GROUP }))
    vi.stubGlobal('fetch', fetchMock)

    const group = await createApprovalTemplateGroup('Finance')

    expect(group).toEqual(SAMPLE_GROUP)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/approval-template-groups')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Finance' })
    // A‴: the client must never send an orgId — the server derives it from the session.
    expect(JSON.parse(init.body as string)).not.toHaveProperty('orgId')
  })

  it('renameApprovalTemplateGroup: PATCHes /:id with { name }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { group: { ...SAMPLE_GROUP, name: 'Finance 2' } }))
    vi.stubGlobal('fetch', fetchMock)

    const group = await renameApprovalTemplateGroup('atg_1', 'Finance 2')

    expect(group.name).toBe('Finance 2')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/approval-template-groups/atg_1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Finance 2' })
  })

  it('archiveApprovalTemplateGroup / unarchiveApprovalTemplateGroup: POST the /:id/(un)archive legs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { group: SAMPLE_GROUP }))
    vi.stubGlobal('fetch', fetchMock)

    await archiveApprovalTemplateGroup('atg_1')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/approval-template-groups/atg_1/archive')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')

    await unarchiveApprovalTemplateGroup('atg_1')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/approval-template-groups/atg_1/unarchive')
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST')
  })

  it('linkApprovalTemplateToGroup: POSTs /api/approval-templates/:id/group with { groupId }, unwraps { link }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { link: SAMPLE_LINK }))
    vi.stubGlobal('fetch', fetchMock)

    const link = await linkApprovalTemplateToGroup('tpl_1', 'atg_1')

    expect(link).toEqual(SAMPLE_LINK)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/approval-templates/tpl_1/group')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ groupId: 'atg_1' })
  })

  it('unlinkApprovalTemplateFromGroup: DELETEs /api/approval-templates/:id/group, resolves on 204 with no body read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body') } })
    vi.stubGlobal('fetch', fetchMock)

    await expect(unlinkApprovalTemplateFromGroup('tpl_1')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/approval-templates/tpl_1/group')
    expect(init?.method).toBe('DELETE')
  })

  it('acceptance J: a 403 SESSION_ORG_REQUIRED throws ApprovalApiError with the code intact (not collapsed to a generic message)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, { error: { code: 'SESSION_ORG_REQUIRED', message: 'An authenticated session organization is required' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await listApprovalTemplateGroups()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApprovalApiError)
    const error = caught as ApprovalApiError
    expect(error.status).toBe(403)
    expect(error.code).toBe('SESSION_ORG_REQUIRED')
  })

  it('every write endpoint surfaces its failure code the same way (not just the list endpoint)', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['createApprovalTemplateGroup', () => createApprovalTemplateGroup('x')],
      ['renameApprovalTemplateGroup', () => renameApprovalTemplateGroup('atg_1', 'x')],
      ['archiveApprovalTemplateGroup', () => archiveApprovalTemplateGroup('atg_1')],
      ['unarchiveApprovalTemplateGroup', () => unarchiveApprovalTemplateGroup('atg_1')],
      ['linkApprovalTemplateToGroup', () => linkApprovalTemplateToGroup('tpl_1', 'atg_1')],
      ['unlinkApprovalTemplateFromGroup', () => unlinkApprovalTemplateFromGroup('tpl_1')],
    ]

    for (const [label, call] of cases) {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(403, { error: { code: 'SESSION_ORG_REQUIRED', message: 'nope' } }),
      )
      vi.stubGlobal('fetch', fetchMock)

      let caught: unknown
      try {
        await call()
      } catch (err) {
        caught = err
      }

      expect(caught, `${label} should throw ApprovalApiError`).toBeInstanceOf(ApprovalApiError)
      expect((caught as ApprovalApiError).code, `${label} should carry the code`).toBe('SESSION_ORG_REQUIRED')
      vi.unstubAllGlobals()
    }
  })
})

/**
 * A-4 × A-2 合流收口 round 2 (gate `impl-gate-A4-on-A2-merge-fix-round1-20260920.md` P2-1,
 * 2026-09-20) — line-level coverage for the two client functions that the phase-3 sections lane
 * (A-4) contributes and that have NO A-2 counterpart: `listTemplatesBySection` and
 * `reorderApprovalTemplateGroups`. Before this block the whole required web lane
 * (`run-required-web-tests.sh`'s single exec line) stayed green with both functions emptied out:
 * `approvalTemplateCenterSections.spec.ts` `vi.mock`s the entire `../src/approvals/api` module, so
 * it cannot see them by construction, and the backend `approval-template-groups-{sections,reorder}`
 * db tests cover the ROUTE, not the client's wire logic (query-string keys, response unwrapping).
 *
 * Why these two cases do NOT reuse the plain `vi.stubGlobal('fetch', …)` fixture above verbatim:
 * unlike the seven §6 phase-1 group functions, these two open with `if (USE_MOCK) return …`, and
 * `USE_MOCK` is `__APPROVAL_MOCK__ === true || (import.meta.env.DEV && __APPROVAL_MOCK__ !== false)`
 * (`api.ts`) — `DEV` is always true under Vitest, so a bare fetch stub is VACUOUS here: measured,
 * the stub records 0 calls and the function returns its mock value without ever building a URL.
 * The `__APPROVAL_MOCK__ = false` override is the escape hatch `api.ts`'s own comment documents for
 * "a mounted browser harness" (see `apps/web/verification/approval-instance-consistency-race-harness.ts:31`
 * and `approval-form-builder-mounted-harness.ts:39` for the in-repo precedent); it is a
 * module-load-time const, so the override must be set BEFORE a fresh `import()` of the module.
 *
 * Consequence to keep in mind when extending this block: the dynamically re-imported module has its
 * OWN `ApprovalApiError` class identity, so `toBeInstanceOf(ApprovalApiError)` against the
 * statically imported binding at the top of this file would silently stop meaning what it says.
 * These two cases therefore assert on the REQUEST (url / method / body) and the RESPONSE unwrapping
 * only, never on error-class identity; the error-surfacing contract stays covered by the static
 * cases above.
 */
async function withRealFetchPath<T>(run: (api: typeof import('../src/approvals/api')) => Promise<T>): Promise<T> {
  const globalScope = globalThis as { __APPROVAL_MOCK__?: boolean }
  const previous = globalScope.__APPROVAL_MOCK__
  globalScope.__APPROVAL_MOCK__ = false
  vi.resetModules()
  try {
    const api = await import('../src/approvals/api')
    return await run(api)
  } finally {
    if (previous === undefined) delete globalScope.__APPROVAL_MOCK__
    else globalScope.__APPROVAL_MOCK__ = previous
    vi.resetModules()
  }
}

describe('approval template sections/reorder client (design lock v2.13 §6 phase 3, A-4 half)', () => {
  it('listTemplatesBySection: builds the section= query string verbatim and never sends category', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 'tpl_1' }], total: 7 }),
    )

    const result = await withRealFetchPath(async (api) => {
      vi.stubGlobal('fetch', fetchMock)
      return api.listTemplatesBySection({
        section: 'group:atg_1',
        status: 'published',
        search: 'ré',
        page: 2,
        pageSize: 20,
      })
    })

    // Unwrapping: the route's own per-bucket `total` is passed through untouched (§4 row C).
    expect(result).toEqual({ data: [{ id: 'tpl_1' }], total: 7 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    const requested = new URL(String(url), 'http://localhost')
    expect(requested.pathname).toBe('/api/approval-templates')
    // Key order + encoding are asserted verbatim, not key-by-key: a typo'd key
    // (`sections=`/`per_page=`) or a dropped paging param is exactly the class of wire bug this
    // case exists to catch, and a per-key `toContain` would miss a dropped one.
    expect(requested.search).toBe('?section=group%3Aatg_1&status=published&search=r%C3%A9&page=2&pageSize=20')
    // §4 row C / row J: `section=` and `category=` on the same request 400 server-side
    // (`APPROVAL_TEMPLATE_SECTION_CATEGORY_CONFLICT`), so the client must never emit `category`.
    expect(requested.searchParams.has('category')).toBe(false)
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('reorderApprovalTemplateGroups: POSTs the full { groupIds } permutation, unwraps { groups }, and falls back to [] when the key is absent', async () => {
    const withGroups = vi.fn().mockResolvedValue(
      jsonResponse(200, { groups: [{ id: 'atg_2', sortOrder: 1 }, { id: 'atg_1', sortOrder: 2 }] }),
    )

    const ordered = await withRealFetchPath(async (api) => {
      vi.stubGlobal('fetch', withGroups)
      return api.reorderApprovalTemplateGroups(['atg_2', 'atg_1'])
    })

    expect(ordered).toEqual([{ id: 'atg_2', sortOrder: 1 }, { id: 'atg_1', sortOrder: 2 }])
    expect(withGroups).toHaveBeenCalledTimes(1)
    const [url, init] = withGroups.mock.calls[0]
    expect(String(url)).toContain('/api/approval-template-groups/reorder')
    expect(init?.method).toBe('POST')
    // §3 I3: the FULL active-group permutation goes up, in caller order, under `groupIds` — not a
    // delta and not a bare array body.
    expect(JSON.parse(init.body as string)).toEqual({ groupIds: ['atg_2', 'atg_1'] })

    // Same call, a response missing the `groups` key: the unwrapper must yield [] rather than
    // leaking `undefined` into `applyGroupOrder`'s `results.map(...)`.
    const withoutGroups = vi.fn().mockResolvedValue(jsonResponse(200, { result: [{ id: 'atg_2', sortOrder: 1 }] }))
    const fallback = await withRealFetchPath(async (api) => {
      vi.stubGlobal('fetch', withoutGroups)
      return api.reorderApprovalTemplateGroups(['atg_2'])
    })
    expect(fallback).toEqual([])
    expect(withoutGroups).toHaveBeenCalledTimes(1)
  })
})
