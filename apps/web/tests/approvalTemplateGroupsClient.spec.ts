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
