/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4):
 * `TemplateGroupSections.vue` (TemplateCenterView.vue's additive "分组视图").
 *
 * Mounts the component IN ISOLATION (not the whole TemplateCenterView.vue) — it has no dependency
 * on the template store, permissions, or vue-router (item clicks emit a bare template id, the
 * PARENT owns navigation), so this spec only needs to mock `../src/approvals/api`'s two read
 * functions.
 *
 * Covers: (1) active-group + `ungrouped` bucket enumeration, archived groups excluded and groups
 * requested in `sortOrder` order; (2) per-section item rendering + the section's own `total` count
 * (not a client-reconstructed one); (3) an empty section renders the empty-state text, not zero
 * rows silently; (4) "load more" appends page 2 without re-fetching page 1; (5) clicking an item
 * emits `select` with the template id; (6) a failed group fetch surfaces the top-level error state
 * rather than rendering an empty section list; (7)-(8) `category:<name>` candidates from
 * `listTemplateCategories()` are fetched as sections after `group:`/`ungrouped`, and a candidate
 * whose own bucket total is 0 is dropped from what renders (unlike `group:`/`ungrouped`, which
 * always render, empty state included) — that name list is global/org-agnostic (§Q5 undecided),
 * so not every name it returns resolves to a real section in this org; (9)-(13) group-order
 * move-up/move-down (§3 I3 / §4 acceptance E phase-3 leg): the request sends the org's FULL
 * active-group permutation (never leaking `ungrouped`/`category:<name>` tokens into it), a
 * successful reorder re-sorts the rendered sections by the response's `sortOrder` WITHOUT
 * re-fetching each section's already-loaded rows, boundary buttons are disabled at each end and
 * `ungrouped` never gets move controls, and a failed reorder surfaces a non-blocking inline error
 * while leaving the section order exactly as it was; (14)-(19) item-level move-to-group (§6 表第 3
 * 行 "拖拽归组", a `<select>` substitution for native drag — see the component's own header
 * comment): "未分组" is offered only from a `group:<id>` section (never from `ungrouped` or
 * `category:<name>`, where unlinking is a no-op per I2′), a successful move removes the row from
 * its section and bumps the target section's own count without re-fetching either, moving the
 * LAST row out of a `category:<name>` section drops that section entirely (same 0-total rule as
 * the candidate-enumeration tests above), and a failed move surfaces a non-blocking inline error
 * leaving the row exactly where it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, ref, type App as VueApp } from 'vue'
import { ApprovalApiError } from '../src/approvals/api'
import { useAuth } from '../src/composables/useAuth'
import { useLocale } from '../src/composables/useLocale'
import type { ApprovalTemplateGroupDTO, ApprovalTemplateGroupReorderResultDTO } from '../src/types/approval'

const listApprovalTemplateGroupsSpy = vi.fn<[], Promise<ApprovalTemplateGroupDTO[]>>()
const listTemplateCategoriesSpy = vi.fn<[], Promise<string[]>>()
const listTemplatesBySectionSpy = vi.fn()
const reorderApprovalTemplateGroupsSpy = vi.fn<[string[]], Promise<ApprovalTemplateGroupReorderResultDTO[]>>()
const linkApprovalTemplateToGroupSpy = vi.fn<[string, string], Promise<void>>()
const unlinkApprovalTemplateFromGroupSpy = vi.fn<[string], Promise<void>>()

// D3-1 (gate `impl-gate-A4-on-A2-merge-fix-round1-20260920.md` §6, 2026-09-20): `ApprovalApiError`
// is re-exported from the REAL module rather than hand-rolled here. The component branches on
// `err instanceof ApprovalApiError`, which is a class-IDENTITY check — a look-alike class defined
// in this factory would make the branch pass against a shape this file invented, not against the
// class `approvals/api.ts` actually throws. `importActual` keeps the two the same object; the
// `.code`-carrying contract of that class is separately pinned, on the real fetch path, by
// `approvalTemplateGroupsClient.spec.ts`'s 403 cases.
vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ApprovalApiError: actual.ApprovalApiError,
    listApprovalTemplateGroups: () => listApprovalTemplateGroupsSpy(),
    listTemplateCategories: () => listTemplateCategoriesSpy(),
    listTemplatesBySection: (params: unknown) => listTemplatesBySectionSpy(params),
    linkApprovalTemplateToGroup: (templateId: string, groupId: string) =>
      linkApprovalTemplateToGroupSpy(templateId, groupId),
    unlinkApprovalTemplateFromGroup: (templateId: string) => unlinkApprovalTemplateFromGroupSpy(templateId),
    reorderApprovalTemplateGroups: (groupIds: string[]) => reorderApprovalTemplateGroupsSpy(groupIds),
  }
})

// The session-org half of acceptance J runs through the REAL `useSessionOrg`/`useAuth`
// composables (same seam `ApprovalTemplateGroupsPanel.spec.ts` uses for the A-2 half) — only the
// shared HTTP module is stubbed, so the D3-1 case below exercises the component's own branch and
// the composable's own request/replay wiring rather than a mocked composable. `apiGet`/`apiPost`
// are stubbed too because `importActual` above loads the real `approvals/api.ts`, which imports
// all three from this module; nothing in this file routes through them.
const httpMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))
vi.mock('../src/utils/api', () => ({
  apiFetch: httpMocks.apiFetch,
  apiGet: httpMocks.apiGet,
  apiPost: httpMocks.apiPost,
  getApiBase: () => '',
}))

function group(overrides: Partial<ApprovalTemplateGroupDTO>): ApprovalTemplateGroupDTO {
  return {
    id: 'atg_1',
    orgId: 'org_1',
    name: 'Group 1',
    sortOrder: 1,
    createdBy: 'user_1',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    archivedAt: null,
    ...overrides,
  }
}

function template(id: string, name: string) {
  return {
    id,
    key: `TPL-${id}`,
    name,
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    status: 'published',
    activeVersionId: 'ver_1',
    latestVersionId: 'ver_1',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  }
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function selectMoveTarget(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

describe('TemplateGroupSections — lock v2.13 §6 phase 3 (A-4) grouped view', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let selectSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    listApprovalTemplateGroupsSpy.mockReset()
    listTemplateCategoriesSpy.mockReset()
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockReset()
    reorderApprovalTemplateGroupsSpy.mockReset()
    linkApprovalTemplateToGroupSpy.mockReset()
    linkApprovalTemplateToGroupSpy.mockResolvedValue(undefined)
    unlinkApprovalTemplateFromGroupSpy.mockReset()
    unlinkApprovalTemplateFromGroupSpy.mockResolvedValue(undefined)
    selectSpy = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountView(props: Record<string, unknown> = {}) {
    const { default: TemplateGroupSections } = await import('../src/views/approval/TemplateGroupSections.vue')
    const Host = defineComponent({
      setup() {
        return () => h(TemplateGroupSections as any, { ...props, onSelect: selectSpy })
      },
    })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  it('fetches active groups (sorted by sortOrder, archived excluded) plus the ungrouped bucket', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
      group({ id: 'atg_archived', name: 'Old Group', sortOrder: null, archivedAt: '2026-09-05T00:00:00Z' }),
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
    ])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })

    await mountView()

    expect(listApprovalTemplateGroupsSpy).toHaveBeenCalledTimes(1)
    // Two active groups + ungrouped = three section fetches; the archived group is never queried.
    expect(listTemplatesBySectionSpy).toHaveBeenCalledTimes(3)
    const sectionArg = (i: number) => listTemplatesBySectionSpy.mock.calls[i]?.[0] as { section: string }
    expect(sectionArg(0).section).toBe('group:atg_a')
    expect(sectionArg(1).section).toBe('group:atg_b')
    expect(sectionArg(2).section).toBe('ungrouped')

    const sections = container!.querySelectorAll('[data-testid^="template-group-section-"]')
    // 3 section elements + their nested "count"/"item"/"more" testids also start with the same
    // prefix, so scope to the section ROOT nodes specifically.
    const sectionRoots = Array.from(sections).filter((el) =>
      /^template-group-section-(group:|ungrouped$)/.test(el.getAttribute('data-testid') ?? ''),
    )
    expect(sectionRoots).toHaveLength(3)
  })

  it('renders per-section items and the section-own total (not a client-reconstructed count)', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    // gate impl-gate-A4-round1-20260918.md §2 P2-2: the fixture MUST make `total !== data.length`
    // (page 1 of a larger section — one row returned, seven total) so a client-reconstructed count
    // (`res.data.length`) and the server-given one (`res.total`) are DISTINGUISHABLE. The prior
    // fixture (`data:[1 row], total:1`) made the two implementations observationally identical —
    // mutating `loadAll()` to read `total: res.data.length` left this test's badge assertion green
    // (18/18, including this very test) because 1 === 1 either way. Verified by re-running that
    // exact mutation against THIS fixture (cp backup → edit → run → restore → cmp byte-identical):
    // the badge assertion goes red (`expected '1' to be '7'`) before this fix, and passes after.
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') {
        return Promise.resolve({ data: [template('tpl_1', 'Onboarding form')], total: 7 })
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()

    const groupSection = container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!
    expect(groupSection.textContent).toContain('Group A')
    expect(groupSection.textContent).toContain('Onboarding form')
    // The server-given total (7), NOT the client-reconstructed row count (1 — this page has only
    // one row because six more are on later pages).
    expect(groupSection.querySelector('[data-testid="template-group-section-count"]')?.textContent?.trim()).toBe('7')

    const ungroupedSection = container!.querySelector('[data-testid="template-group-section-ungrouped"]')!
    // No item in `ungrouped` — the empty-state text renders, not a silently blank list.
    expect(ungroupedSection.textContent).toContain('此分组暂无表单')
  })

  it('shows "load more" only when more rows remain, and appends page 2 without dropping page 1', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplatesBySectionSpy.mockImplementation(({ section, page }: { section: string; page: number }) => {
      if (section !== 'group:atg_a') return Promise.resolve({ data: [], total: 0 })
      if (page === 1) return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 2 })
      return Promise.resolve({ data: [template('tpl_2', 'Row 2')], total: 2 })
    })

    await mountView()

    const moreButton = container!.querySelector(
      '[data-testid="template-group-section-more-group:atg_a"]',
    ) as HTMLButtonElement | null
    expect(moreButton).toBeTruthy()

    moreButton!.click()
    await flushUi()

    expect(listTemplatesBySectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'group:atg_a', page: 2 }),
    )
    const groupSection = container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!
    expect(groupSection.textContent).toContain('Row 1')
    expect(groupSection.textContent).toContain('Row 2')
    // Both rows now loaded (total 2 of 2) — "load more" must be gone.
    expect(
      container!.querySelector('[data-testid="template-group-section-more-group:atg_a"]'),
    ).toBeNull()
  })

  it('emits select with the template id when an item is clicked', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') {
        return Promise.resolve({ data: [template('tpl_9', 'Click me')], total: 1 })
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()

    const item = container!.querySelector(
      '[data-testid="template-group-section-item-tpl_9"]',
    ) as HTMLLIElement
    item.click()
    await flushUi()

    expect(selectSpy).toHaveBeenCalledTimes(1)
    expect(selectSpy).toHaveBeenCalledWith('tpl_9')
  })

  it('renders the top-level error state when the group fetch rejects, not an empty section list', async () => {
    listApprovalTemplateGroupsSpy.mockRejectedValue(new Error('network down'))

    await mountView()

    expect(listTemplatesBySectionSpy).not.toHaveBeenCalled()
    const errorEl = container!.querySelector('[data-testid="template-group-sections-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toContain('network down')
    expect(container!.querySelectorAll('[data-testid^="template-group-section-"]')).toHaveLength(0)
  })

  it('passes status/search props through to every section fetch', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })

    await mountView({ status: 'published', search: 'travel' })

    expect(listTemplatesBySectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'ungrouped', status: 'published', search: 'travel', page: 1 }),
    )
  })

  it('fetches one category:<name> section per listTemplateCategories() name, after group/ungrouped', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplateCategoriesSpy.mockResolvedValue(['报销', '采购'])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })

    await mountView()

    expect(listTemplateCategoriesSpy).toHaveBeenCalledTimes(1)
    // group:atg_a, ungrouped, category:报销, category:采购 — in that order.
    expect(listTemplatesBySectionSpy).toHaveBeenCalledTimes(4)
    const sectionArg = (i: number) => listTemplatesBySectionSpy.mock.calls[i]?.[0] as { section: string }
    expect(sectionArg(0).section).toBe('group:atg_a')
    expect(sectionArg(1).section).toBe('ungrouped')
    expect(sectionArg(2).section).toBe('category:报销')
    expect(sectionArg(3).section).toBe('category:采购')
  })

  it('drops a category:<name> candidate with zero rows in this org, but keeps one with rows and still renders the always-empty ungrouped bucket', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    listTemplateCategoriesSpy.mockResolvedValue(['报销', '采购'])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'category:采购') {
        return Promise.resolve({ data: [template('tpl_1', 'Purchase form')], total: 1 })
      }
      // 'ungrouped' and 'category:报销' both resolve empty — only the category one is a dropped
      // candidate; 'ungrouped' is always a real section (see header comment / SectionState.alwaysShow).
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()

    expect(
      container!.querySelector('[data-testid="template-group-section-category:报销"]'),
    ).toBeNull()
    const purchaseSection = container!.querySelector(
      '[data-testid="template-group-section-category:采购"]',
    )
    expect(purchaseSection).toBeTruthy()
    expect(purchaseSection!.textContent).toContain('Purchase form')
    expect(
      container!.querySelector('[data-testid="template-group-section-ungrouped"]'),
    ).toBeTruthy()
  })

  it('sends the adjacent-swapped, org-scoped active-group permutation when moving a group down (no ungrouped/category token leaks into it)', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
      group({ id: 'atg_c', name: 'Group C', sortOrder: 3 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue(['报销'])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    reorderApprovalTemplateGroupsSpy.mockResolvedValue([
      { id: 'atg_b', sortOrder: 1 },
      { id: 'atg_a', sortOrder: 2 },
      { id: 'atg_c', sortOrder: 3 },
    ])

    await mountView()

    const moveDownA = container!.querySelector(
      '[data-testid="template-group-section-move-down-group:atg_a"]',
    ) as HTMLButtonElement
    moveDownA.click()
    await flushUi()

    // Exactly A/B swapped — C, `ungrouped`, and the `category:报销` candidate never appear in the
    // permutation the request carries, even though they were all rendered sections.
    expect(reorderApprovalTemplateGroupsSpy).toHaveBeenCalledTimes(1)
    expect(reorderApprovalTemplateGroupsSpy).toHaveBeenCalledWith(['atg_b', 'atg_a', 'atg_c'])
  })

  it('re-sorts rendered group sections by the response sortOrder WITHOUT re-fetching any section', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') return Promise.resolve({ data: [template('tpl_a', 'From A')], total: 1 })
      if (section === 'group:atg_b') return Promise.resolve({ data: [template('tpl_b', 'From B')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })
    reorderApprovalTemplateGroupsSpy.mockResolvedValue([
      { id: 'atg_b', sortOrder: 1 },
      { id: 'atg_a', sortOrder: 2 },
    ])

    await mountView()
    const fetchCountBeforeReorder = listTemplatesBySectionSpy.mock.calls.length

    const moveDownA = container!.querySelector(
      '[data-testid="template-group-section-move-down-group:atg_a"]',
    ) as HTMLButtonElement
    moveDownA.click()
    await flushUi()

    // Reordering changes POSITION, not membership or content — no additional fetch.
    expect(listTemplatesBySectionSpy).toHaveBeenCalledTimes(fetchCountBeforeReorder)

    const tokensInOrder = Array.from(
      container!.querySelectorAll('[data-testid^="template-group-section-"]'),
    )
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter((id) => /^template-group-section-(group:|ungrouped$)/.test(id))
      .map((id) => id.replace('template-group-section-', ''))
    expect(tokensInOrder).toEqual(['group:atg_b', 'group:atg_a', 'ungrouped'])

    // Each section's own previously-loaded rows travelled WITH it, not re-fetched or swapped.
    expect(
      container!.querySelector('[data-testid="template-group-section-group:atg_b"]')!.textContent,
    ).toContain('From B')
    expect(
      container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!.textContent,
    ).toContain('From A')
  })

  it('disables move-up on the first group and move-down on the last group; `ungrouped` never gets move controls', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })

    await mountView()

    const upA = container!.querySelector(
      '[data-testid="template-group-section-move-up-group:atg_a"]',
    ) as HTMLButtonElement
    const downA = container!.querySelector(
      '[data-testid="template-group-section-move-down-group:atg_a"]',
    ) as HTMLButtonElement
    const upB = container!.querySelector(
      '[data-testid="template-group-section-move-up-group:atg_b"]',
    ) as HTMLButtonElement
    const downB = container!.querySelector(
      '[data-testid="template-group-section-move-down-group:atg_b"]',
    ) as HTMLButtonElement

    expect(upA.disabled).toBe(true)
    expect(downA.disabled).toBe(false)
    expect(upB.disabled).toBe(false)
    expect(downB.disabled).toBe(true)

    expect(
      container!.querySelector('[data-testid="template-group-section-move-up-ungrouped"]'),
    ).toBeNull()
    expect(
      container!.querySelector('[data-testid="template-group-section-move-down-ungrouped"]'),
    ).toBeNull()
  })

  it('surfaces a non-blocking inline error and leaves the section order unchanged when the reorder request fails', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    reorderApprovalTemplateGroupsSpy.mockRejectedValue(new Error('conflict'))

    await mountView()

    const moveDownA = container!.querySelector(
      '[data-testid="template-group-section-move-down-group:atg_a"]',
    ) as HTMLButtonElement
    moveDownA.click()
    await flushUi()

    const errorEl = container!.querySelector('[data-testid="template-group-sections-reorder-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toContain('conflict')

    // The failed swap must not have been applied client-side either.
    const tokensInOrder = Array.from(
      container!.querySelectorAll('[data-testid^="template-group-section-"]'),
    )
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter((id) => /^template-group-section-(group:|ungrouped$)/.test(id))
      .map((id) => id.replace('template-group-section-', ''))
    expect(tokensInOrder).toEqual(['group:atg_a', 'group:atg_b', 'ungrouped'])
  })

  it('offers every OTHER active group plus 未分组 as move targets from a group: section, and moving to another group calls link + updates both counts without re-fetching either section', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    const fetchCountBeforeMove = listTemplatesBySectionSpy.mock.calls.length

    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_1"]',
    ) as HTMLSelectElement
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    // Placeholder, then 未分组 (this row's section IS a `group:` section), then the ONE other
    // active group — never `atg_a` itself, never `ungrouped`/`category:<name>` tokens.
    expect(optionValues).toEqual(['', 'ungrouped', 'group:atg_b'])

    await selectMoveTarget(select, 'group:atg_b')

    expect(linkApprovalTemplateToGroupSpy).toHaveBeenCalledTimes(1)
    expect(linkApprovalTemplateToGroupSpy).toHaveBeenCalledWith('tpl_1', 'atg_b')
    expect(unlinkApprovalTemplateFromGroupSpy).not.toHaveBeenCalled()
    // Moving changes membership, not either section's already-loaded content — no re-fetch.
    expect(listTemplatesBySectionSpy).toHaveBeenCalledTimes(fetchCountBeforeMove)

    const sourceSection = container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!
    const targetSection = container!.querySelector('[data-testid="template-group-section-group:atg_b"]')!
    expect(sourceSection.querySelector('[data-testid="template-group-section-item-tpl_1"]')).toBeNull()
    // P2-3 fix (groups-daily-ops-real-browser-acceptance-20260920.md): the moved row must now be
    // RENDERED in the target, not merely counted — the pre-fix version bumped `total` without
    // ever inserting it into `target.items`, which is exactly the phantom-"load more" defect this
    // fix closes. `container`-wide absence is no longer the right assertion (the row legitimately
    // reappears, just under `atg_b`); scoping the two checks to their own sections is what tells
    // "moved" apart from "vanished".
    expect(targetSection.querySelector('[data-testid="template-group-section-item-tpl_1"]')).not.toBeNull()
    expect(
      sourceSection.querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim(),
    ).toBe('0')
    expect(
      targetSection.querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim(),
    ).toBe('1')
  })

  it('moving an item to 未分组 calls unlink (never link) and bumps the ungrouped section total', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_1"]',
    ) as HTMLSelectElement
    await selectMoveTarget(select, 'ungrouped')

    expect(unlinkApprovalTemplateFromGroupSpy).toHaveBeenCalledTimes(1)
    expect(unlinkApprovalTemplateFromGroupSpy).toHaveBeenCalledWith('tpl_1')
    expect(linkApprovalTemplateToGroupSpy).not.toHaveBeenCalled()
    expect(
      container!.querySelector('[data-testid="template-group-section-ungrouped"]')!
        .querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim(),
    ).toBe('1')
  })

  it('never offers 未分组 as a move target from `ungrouped` or `category:<name>` sections (unlinking a never-linked row is a no-op, I2′)', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplateCategoriesSpy.mockResolvedValue(['报销'])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'ungrouped') return Promise.resolve({ data: [template('tpl_u', 'Ungrouped row')], total: 1 })
      if (section === 'category:报销') return Promise.resolve({ data: [template('tpl_c', 'Category row')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()

    const optionValuesOf = (testid: string) => {
      const select = container!.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement
      return Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    }

    expect(optionValuesOf('template-group-section-move-tpl_u')).toEqual(['', 'group:atg_a'])
    expect(optionValuesOf('template-group-section-move-tpl_c')).toEqual(['', 'group:atg_a'])
  })

  it('drops an emptied `category:<name>` section entirely once its last row is moved out (same 0-total rule as candidate enumeration)', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplateCategoriesSpy.mockResolvedValue(['报销'])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'category:报销') return Promise.resolve({ data: [template('tpl_c', 'Category row')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    expect(container!.querySelector('[data-testid="template-group-section-category:报销"]')).toBeTruthy()

    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_c"]',
    ) as HTMLSelectElement
    await selectMoveTarget(select, 'group:atg_a')

    expect(container!.querySelector('[data-testid="template-group-section-category:报销"]')).toBeNull()
    expect(
      container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!
        .querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim(),
    ).toBe('1')
  })

  it('surfaces a non-blocking inline error and leaves the row exactly in place when a move request fails', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })
    linkApprovalTemplateToGroupSpy.mockRejectedValue(new Error('archived'))

    await mountView()
    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_1"]',
    ) as HTMLSelectElement
    await selectMoveTarget(select, 'group:atg_b')

    const errorEl = container!.querySelector('[data-testid="template-group-sections-move-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toContain('archived')

    expect(container!.querySelector('[data-testid="template-group-section-item-tpl_1"]')).toBeTruthy()
    expect(
      container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!
        .querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim(),
    ).toBe('1')
    expect(
      container!.querySelector('[data-testid="template-group-section-group:atg_b"]')!
        .querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim(),
    ).toBe('0')
  })

  it('clicking the move-to-group select does not also emit the item-selection event (click stays contained)', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_a', name: 'Group A', sortOrder: 1 }),
      group({ id: 'atg_b', name: 'Group B', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_1"]',
    ) as HTMLSelectElement
    select.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(selectSpy).not.toHaveBeenCalled()

    // The item's own click (on the `<li>`, unrelated to the select) still works.
    const item = container!.querySelector(
      '[data-testid="template-group-section-item-tpl_1"]',
    ) as HTMLLIElement
    item.click()
    await flushUi()
    expect(selectSpy).toHaveBeenCalledWith('tpl_1')
  })

  // ── P2-3 (groups-daily-ops-real-browser-acceptance-20260920.md) ──────────────────────────────
  // `applyItemMove` used to only bump `target.total` without ever touching `target.items`, so a
  // target section that already held its COMPLETE row set (the common case: `hasMore` false
  // because `items.length === total`) went to `items.length < total` = true right after a move —
  // a phantom "load more" that fetches an out-of-range page and comes back empty forever (P1/P2/P3
  // in the acceptance report's scenario P). The SAME shape exists symmetrically on the SOURCE side
  // when it was ALREADY paginated before the move (advisor review, this fix round): decrementing
  // `total` without knowing the true row now sitting at the freed slot leaves `loadMore`'s
  // page-number offset pointing past the end.
  it('P2-3 (target, common case): moving into a section that already holds its full loaded set keeps count === rendered rows and shows no phantom "load more"', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_leave', name: 'Leave', sortOrder: 1 }),
      group({ id: 'atg_purchase', name: 'Purchase', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_leave') return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
      // Purchase already holds its COMPLETE set: 2 rows loaded, total 2 — `hasMore` is false
      // before the move (this is the report's exact repro shape).
      if (section === 'group:atg_purchase') {
        return Promise.resolve({
          data: [template('tpl_p1', 'P1'), template('tpl_p2', 'P2')],
          total: 2,
        })
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    const fetchCountBeforeMove = listTemplatesBySectionSpy.mock.calls.length

    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_1"]',
    ) as HTMLSelectElement
    await selectMoveTarget(select, 'group:atg_purchase')

    const purchaseSection = container!.querySelector('[data-testid="template-group-section-group:atg_purchase"]')!
    expect(purchaseSection.querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim()).toBe('3')
    // The moved row is actually RENDERED — not just counted — and no "load more" button appears.
    expect(purchaseSection.querySelectorAll('[data-testid^="template-group-section-item-"]').length).toBe(3)
    expect(purchaseSection.querySelector('[data-testid="template-group-section-more-group:atg_purchase"]')).toBeNull()
    // The common case needs zero extra network round-trips — same invariant the sibling "no
    // re-fetch" test above pins for the already-empty-target case.
    expect(listTemplatesBySectionSpy.mock.calls.length).toBe(fetchCountBeforeMove)

    // Negative control: clicking "load more" would be exactly the bug (a request against an
    // out-of-range page that always comes back empty) — assert the button is simply absent rather
    // than asserting a click is a no-op, which is the stronger, more direct claim.
  })

  it('P2-3 (source, symmetric case): moving OUT of an already-paginated section re-syncs its loaded range instead of leaving a stale, permanently-empty "load more"', async () => {
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_leave', name: 'Leave', sortOrder: 1 }),
      group({ id: 'atg_purchase', name: 'Purchase', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    // Leave starts ALREADY paginated: page 1 has 10 of 11 rows loaded (`hasMore` true) — same
    // shape as the acceptance report's `Leave` fixture (11 rows, PAGE_SIZE=10).
    const leavePage1 = Array.from({ length: 10 }, (_, i) => template(`tpl_L${i}`, `Leave ${i}`))
    listTemplatesBySectionSpy.mockImplementation(({ section, page }: { section: string; page: number }) => {
      if (section === 'group:atg_leave') {
        if (page === 1) return Promise.resolve({ data: leavePage1, total: 11 })
        // After the move, the section has shrunk to 10 rows total — an unrefreshed page-1 request
        // would still legitimately return the SAME 10 rows (minus the moved one, plus whichever
        // row now fills the tail) — model that as one row fewer, to prove the refresh actually
        // re-read page 1 rather than reusing stale client state.
        throw new Error(`unexpected page ${page} requested for group:atg_leave`)
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    expect(
      container!.querySelector('[data-testid="template-group-section-more-group:atg_leave"]'),
    ).not.toBeNull()
    const fetchCountBeforeMove = listTemplatesBySectionSpy.mock.calls.length

    // After the move, the backend's page 1 for this bucket has only 9 rows now (10 - the one that
    // moved out) and total 10 — modelling "the section shrank below one full page" so the fix's
    // refresh can be asserted precisely (`hasMore` must flip to false, not stay stuck true).
    listTemplatesBySectionSpy.mockImplementation(({ section, page }: { section: string; page: number }) => {
      if (section === 'group:atg_leave' && page === 1) {
        return Promise.resolve({ data: leavePage1.slice(0, 9), total: 9 })
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_L0"]',
    ) as HTMLSelectElement
    await selectMoveTarget(select, 'group:atg_purchase')

    const leaveSection = container!.querySelector('[data-testid="template-group-section-group:atg_leave"]')!
    expect(leaveSection.querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim()).toBe('9')
    expect(leaveSection.querySelectorAll('[data-testid^="template-group-section-item-"]').length).toBe(9)
    // The section was fully re-synced (9 == 9, no more unfetched rows) — the stale "load more"
    // from before the move must be gone, not stuck showing forever.
    expect(container!.querySelector('[data-testid="template-group-section-more-group:atg_leave"]')).toBeNull()
    // Exactly one refresh round-trip (page 1) — not a silent no-op, and not an unbounded re-fetch
    // of every page the section ever had.
    expect(listTemplatesBySectionSpy.mock.calls.length).toBe(fetchCountBeforeMove + 1)
  })

  // P2-B (impl-gate-A5-daily-ops-round1-20260920.md): of `applyItemMove`'s three post-move
  // branches, the two above cover "target already complete" and "source already paginated". The
  // THIRD — target already paginated — shipped with no case at all, and the gate's mutation M2
  // (revert `:582` to the pre-fix `target.hasMore = target.items.length < target.total`) survived
  // the whole 22-case file. The mirror of the source test does NOT discriminate it: with page 1 =
  // 10 of 11 and one row moved in, the pre-fix line also computes `hasMore = 10 < 12 = true` and
  // the rendered count is `12` either way. The two observables that separate them are the target's
  // page-1 REFRESH REQUEST (fix: exactly one; pre-fix: none) and the server's post-move page 1
  // actually being RENDERED (fix: the moved row is in it; pre-fix: the stale ten rows stand).
  it('P2-3 (target, already-paginated case): moving INTO an already-paginated section re-reads its loaded range instead of guessing where the new row landed', async () => {
    const purchasePage1 = Array.from({ length: 10 }, (_, i) => template(`tpl_P${i}`, `Purchase ${i}`))
    listApprovalTemplateGroupsSpy.mockResolvedValue([
      group({ id: 'atg_leave', name: 'Leave', sortOrder: 1 }),
      group({ id: 'atg_purchase', name: 'Purchase', sortOrder: 2 }),
    ])
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockImplementation(({ section, page }: { section: string; page: number }) => {
      // Source: one row, complete — so the source side contributes ZERO requests and every
      // request counted below belongs to the target branch under test.
      if (section === 'group:atg_leave') return Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
      // Target: 10 of 11 loaded before the move — `hasMore` true, i.e. ALREADY paginated.
      if (section === 'group:atg_purchase') {
        if (page === 1) return Promise.resolve({ data: purchasePage1, total: 11 })
        throw new Error(`unexpected page ${page} requested for group:atg_purchase`)
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()
    // Pre-state sanity: the target really is in the paginated branch. If it were complete, the
    // sibling case above would be the one exercised and this test would assert nothing new.
    expect(
      container!.querySelector('[data-testid="template-group-section-more-group:atg_purchase"]'),
    ).not.toBeNull()
    const fetchCountBeforeMove = listTemplatesBySectionSpy.mock.calls.length

    // After the move the backend's page 1 for this bucket CHANGES: the moved row sorts into it and
    // pushes the old page 1's last row down to page 2. A client cannot derive that from a local
    // `total` bump — which is exactly why the fix re-reads the loaded range.
    listTemplatesBySectionSpy.mockImplementation(({ section, page }: { section: string; page: number }) => {
      if (section === 'group:atg_leave') return Promise.resolve({ data: [], total: 0 })
      if (section === 'group:atg_purchase') {
        if (page === 1) {
          return Promise.resolve({ data: [template('tpl_1', 'Row 1'), ...purchasePage1.slice(0, 9)], total: 12 })
        }
        throw new Error(`unexpected page ${page} requested for group:atg_purchase`)
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    const select = container!.querySelector(
      '[data-testid="template-group-section-move-tpl_1"]',
    ) as HTMLSelectElement
    await selectMoveTarget(select, 'group:atg_purchase')

    const purchaseSection = container!.querySelector('[data-testid="template-group-section-group:atg_purchase"]')!
    // (1) The moved row is RENDERED inside the target, not merely counted.
    expect(purchaseSection.querySelector('[data-testid="template-group-section-item-tpl_1"]')).not.toBeNull()
    // (2) Exactly one extra round-trip, and it is the target's page 1.
    expect(listTemplatesBySectionSpy.mock.calls.length).toBe(fetchCountBeforeMove + 1)
    expect(listTemplatesBySectionSpy.mock.calls.at(-1)![0]).toMatchObject({
      section: 'group:atg_purchase',
      page: 1,
    })
    // (3) Count, rendered rows and the remaining-rows affordance all agree with the server after
    //     the refresh: 12 in the bucket, 10 loaded, more genuinely available.
    expect(purchaseSection.querySelector('[data-testid="template-group-section-count"]')!.textContent!.trim()).toBe('12')
    expect(purchaseSection.querySelectorAll('[data-testid^="template-group-section-item-"]').length).toBe(10)
    expect(
      container!.querySelector('[data-testid="template-group-section-more-group:atg_purchase"]'),
    ).not.toBeNull()
  })
})

/**
 * D3-1 (gate `impl-gate-A4-on-A2-merge-fix-round1-20260920.md` §6 owner item, 2026-09-20) —
 * acceptance J's PAGE-LEVEL entry, which the A-2 × A-4 convergence had narrowed.
 *
 * Component-level acceptance J never regressed (`ApprovalTemplateGroupsPanel.spec.ts` covers the
 * panel's own 403 → selector → retry loop). What the convergence changed is the FIRST hop: after
 * the merge the grouped view became the primary surface and the A-2 panel a disclosure-gated
 * manager, so a multi-org member who had not picked a session organization hit
 * `TemplateGroupSections`'s generic `loadError` string first and had to find 「管理分组」 on their
 * own to reach the selector. These cases pin the reinstated first-hop path.
 *
 * Isolation note: this block drives the REAL `useSessionOrg`/`useAuth` composables over the stubbed
 * `apiFetch` (see the module mocks at the top), so a mutation of the component's own
 * `SESSION_ORG_REQUIRED` branch is what these cases are sensitive to — not a mocked composable's
 * say-so.
 */
describe('TemplateGroupSections — acceptance J page-level entry (design lock v2.13 §4 / §2)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  const jwt = (org: string) =>
    `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`

  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    localStorage.clear()
    listApprovalTemplateGroupsSpy.mockReset()
    listTemplateCategoriesSpy.mockReset()
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockReset()
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    httpMocks.apiFetch.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountView() {
    const { default: TemplateGroupSections } = await import('../src/views/approval/TemplateGroupSections.vue')
    app = createApp(defineComponent({ setup: () => () => h(TemplateGroupSections as any, {}) }))
    app.mount(container!)
    await flushUi()
  }

  // Drains both the api await chain and Vue's scheduler across macrotask turns — `flushUi`'s
  // microtask-only loop is empirically short of the session-org switch settling (same reason
  // `ApprovalTemplateGroupsPanel.spec.ts` has its own `settle`).
  async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  it('a 403 SESSION_ORG_REQUIRED on the first load shows the shared selector instead of the generic error, and picking an org replays the blocked load', async () => {
    useAuth().setToken(jwt('org-a'))
    let listAttempts = 0
    listApprovalTemplateGroupsSpy.mockImplementation(async () => {
      listAttempts += 1
      if (listAttempts === 1) {
        throw new ApprovalApiError('An authenticated session organization is required', 403, 'SESSION_ORG_REQUIRED')
      }
      return [group({ id: 'atg_a', name: '法务组', sortOrder: 1 })]
    })
    httpMocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/auth/session-orgs') {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: null } })
      }
      if (path === '/api/auth/session-org' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })

    await mountView()
    await settle()

    // First hop: selector present, and the generic top-level error NOT rendered in its place.
    expect(listAttempts).toBe(1)
    expect(container!.querySelector('[data-testid="session-org-switcher"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
    expect(container!.textContent).not.toContain('法务组')

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(8)

    expect(listAttempts).toBe(2)
    expect(container!.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
    expect(container!.textContent).toContain('法务组')
  })

  it('a single-org member never sees the selector, and any OTHER failure still renders the generic error', async () => {
    // Two negative controls in one case, both aimed at the branch this slice added: it must key on
    // the CODE, not on "a load failed" (which would put the selector in front of every outage) and
    // not on "the view mounted" (which would show it to single-org members, contradicting §4 J).
    useAuth().setToken(jwt('org-a'))
    listApprovalTemplateGroupsSpy.mockRejectedValueOnce(new ApprovalApiError('模板分组服务暂不可用', 503, 'UPSTREAM_UNAVAILABLE'))

    await mountView()
    await settle()

    expect(container!.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
    const error = container!.querySelector('[data-testid="template-group-sections-error"]')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('模板分组服务暂不可用')
    // The reactive-not-proactive rule: no session-org lookup is made for a non-J failure.
    expect(httpMocks.apiFetch).not.toHaveBeenCalled()
  })
})

/**
 * P1-A (impl-gate-A5-daily-ops-round1-20260920.md) — HOSTED mode.
 *
 * Every case above mounts this view standalone, where it keeps its own `useSessionOrg()` instance,
 * draws its own switcher and replays its own blocked `loadAll()` (the D3-1 block below pins that
 * whole loop, and acceptance J's "remove the handling of that code" mutation is red there). Inside
 * TemplateCenterView a host now provides the page's single instance, and this view must then draw
 * NOTHING of its own — a second live `useSessionOrg()` instance is not a cosmetic duplicate: the
 * composable's `onAuthPrincipalChange` empties `orgs` on every instance that did not perform the
 * switch, so a real browser measured the page dropping to ZERO switchers when the admin happened
 * to use the sections view's copy instead of the page's.
 */
describe('TemplateGroupSections — hosted session-org entry (P1-A)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let notifySessionOrgRequired: ReturnType<typeof vi.fn>
  const sectionsRef = ref<{ loadAll: () => Promise<void> } | null>(null)

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    useAuth().setToken(
      `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: 'org-a', exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`,
    )
    listApprovalTemplateGroupsSpy.mockReset()
    listTemplateCategoriesSpy.mockReset()
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockReset()
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    httpMocks.apiFetch.mockReset()
    httpMocks.apiFetch.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/auth/session-orgs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: null } }),
        }
      }
      throw new Error(`unexpected call: ${path}`)
    })
    notifySessionOrgRequired = vi.fn()
    sectionsRef.value = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountHosted() {
    const { default: TemplateGroupSections } = await import('../src/views/approval/TemplateGroupSections.vue')
    const { SessionOrgHostKey } = await import('../src/components/SessionOrgSwitcher.vue')
    const { useSessionOrg } = await import('../src/composables/useSessionOrg')
    const Host = defineComponent({
      setup() {
        // The real composable — the host's single instance, exactly as TemplateCenterView builds
        // it, plus the host's own one fetch of the org list. Populating `orgs` is what makes "this
        // view draws no switcher" discriminating: `SessionOrgSwitcher`'s own `v-if` hides it while
        // `orgs` is empty, so a view that FAILED to defer would still render nothing here and the
        // case would pass vacuously.
        const sessionOrg = useSessionOrg()
        void sessionOrg.loadSessionOrgs()
        provide(SessionOrgHostKey, { sessionOrg, notifySessionOrgRequired })
        return () => h(TemplateGroupSections as any, { ref: sectionsRef, onSelect: vi.fn() })
      },
    })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  function sessionOrgRequired(): ApprovalApiError {
    return new ApprovalApiError(
      'An authenticated session organization is required',
      403,
      'SESSION_ORG_REQUIRED',
    )
  }

  it('a 403 SESSION_ORG_REQUIRED draws NO switcher here, makes no session-org lookup of its own, and reports the code to the host exactly once', async () => {
    listApprovalTemplateGroupsSpy.mockRejectedValue(sessionOrgRequired())

    await mountHosted()

    const sessionOrgLookups = () =>
      httpMocks.apiFetch.mock.calls.filter(([path]) => String(path).startsWith('/api/auth/session-org')).length
    // Sanity: the host's instance holds two orgs, so anything that rendered a switcher here would
    // actually be visible (the component hides itself while `orgs` is empty).
    expect(sessionOrgLookups()).toBe(1)

    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
    expect(notifySessionOrgRequired).toHaveBeenCalledTimes(1)
    // No SECOND lookup: the one `/api/auth/session-orgs` call belongs to the host.
    expect(sessionOrgLookups()).toBe(1)
    // The generic load error is NOT what is shown for this code — that regression is what D3-1
    // fixed and it must survive hosting.
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
  })

  it('the host replaying loadAll() after its switch brings the sections back', async () => {
    listApprovalTemplateGroupsSpy.mockRejectedValueOnce(sessionOrgRequired())
    listApprovalTemplateGroupsSpy.mockResolvedValue([group({ id: 'atg_a', name: 'Group A', sortOrder: 1 })])
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) =>
      section === 'group:atg_a'
        ? Promise.resolve({ data: [template('tpl_1', 'Row 1')], total: 1 })
        : Promise.resolve({ data: [], total: 0 }),
    )

    await mountHosted()
    expect(container!.querySelector('[data-testid="template-group-section-group:atg_a"]')).toBeNull()

    // This is literally what TemplateCenterView.onPageSessionOrgChange calls on a successful switch.
    await sectionsRef.value!.loadAll()
    await flushUi()

    expect(container!.querySelector('[data-testid="template-group-section-group:atg_a"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="template-group-section-item-tpl_1"]')).not.toBeNull()
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
  })
})

/**
 * (ii) Request-algebra guard (impl-gate-A5-daily-ops-round2-20260920.md, additional load-bearing
 * scenario asked for alongside P2-C/P3-D): `TemplateCenterView.onPageSessionOrgChange` calls
 * `groupSectionsRef.value?.loadAll()` after EVERY successful switch. Two rapid, back-to-back
 * switches therefore fire two overlapping `loadAll()` calls — this drives that directly, at the
 * component level, by controlling exactly when each call's underlying `listApprovalTemplateGroups`
 * promise settles, rather than trying to race real timers.
 */
describe('TemplateGroupSections — request algebra guard (rapid org switch)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const sectionsRef = ref<{ loadAll: () => Promise<void> } | null>(null)

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    listApprovalTemplateGroupsSpy.mockReset()
    listTemplateCategoriesSpy.mockReset()
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockReset()
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    sectionsRef.value = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountView() {
    const { default: TemplateGroupSections } = await import('../src/views/approval/TemplateGroupSections.vue')
    const Host = defineComponent({
      setup() {
        return () => h(TemplateGroupSections as any, { ref: sectionsRef, onSelect: vi.fn() })
      },
    })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  it('(ii) a stale loadAll() answer that arrives AFTER a newer one must not overwrite the newer org\'s rendered sections', async () => {
    const resolvers: Array<(groups: ApprovalTemplateGroupDTO[]) => void> = []
    listApprovalTemplateGroupsSpy.mockImplementation(
      () => new Promise<ApprovalTemplateGroupDTO[]>((resolve) => { resolvers.push(resolve) }),
    )

    await mountView()
    // onMounted's own loadAll() is the first call — let it settle cleanly before the race below.
    expect(resolvers.length).toBe(1)
    resolvers[0]([])
    await flushUi()

    // Two rapid successive org switches: TemplateCenterView.onPageSessionOrgChange calls
    // `loadAll()` again on EACH switch, before either has necessarily returned.
    const stale = sectionsRef.value!.loadAll() // fired for the org being switched AWAY from
    const fresh = sectionsRef.value!.loadAll() // fired for the org just switched TO
    await flushUi(1)
    expect(resolvers.length).toBe(3)

    // Resolve OUT OF ORDER: the request fired SECOND (the org now current) answers first — a
    // slower network round trip for the org the admin has already left answers last.
    resolvers[2]([group({ id: 'atg_fresh', name: 'Fresh Org Group', sortOrder: 1 })])
    await flushUi()
    resolvers[1]([group({ id: 'atg_stale', name: 'Stale Org Group', sortOrder: 1 })])
    await Promise.all([stale, fresh])
    await flushUi()

    expect(container!.textContent).toContain('Fresh Org Group')
    expect(container!.textContent).not.toContain('Stale Org Group')
  })

  // ── Boundary ③ of the round-3 acceptance — sibling of `ApprovalTemplateGroupsPanel.spec.ts`'s
  // pair. `loadAll()`'s guard has three exits and the case above drives only the first; these two
  // delay the stale request into its CATCH and into its FINALLY respectively.

  it('(③ catch exit) a stale loadAll() FAILURE landing after a newer one must not replace the new org\'s sections with the previous org\'s error', async () => {
    const resolvers: Array<(groups: ApprovalTemplateGroupDTO[]) => void> = []
    const rejecters: Array<(err: Error) => void> = []
    listApprovalTemplateGroupsSpy.mockImplementation(
      () => new Promise<ApprovalTemplateGroupDTO[]>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      }),
    )

    await mountView()
    expect(resolvers.length).toBe(1)
    resolvers[0]([])
    await flushUi()

    const stale = sectionsRef.value!.loadAll() // the org being switched AWAY from
    const fresh = sectionsRef.value!.loadAll() // the org just switched TO
    await flushUi(1)
    expect(resolvers.length).toBe(3)

    // The new org answers first and renders; THEN the abandoned org's request fails.
    resolvers[2]([group({ id: 'atg_fresh', name: 'Fresh Org Group', sortOrder: 1 })])
    await flushUi()
    expect(container!.textContent).toContain('Fresh Org Group')
    rejecters[1](new Error('stale org boom'))
    await Promise.all([stale, fresh])
    await flushUi()

    // The error branch also does `sections.value = []`, so an unguarded stale failure does not
    // merely add a banner — it wipes the organization the admin is actually looking at.
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
    expect(container!.textContent).toContain('Fresh Org Group')
    expect(container!.textContent).not.toContain('stale org boom')
  })

  it('(③ finally exit) a stale loadAll() settling while the newer one is STILL in flight must not clear the newer request\'s loading state', async () => {
    const resolvers: Array<(groups: ApprovalTemplateGroupDTO[]) => void> = []
    listApprovalTemplateGroupsSpy.mockImplementation(
      () => new Promise<ApprovalTemplateGroupDTO[]>((resolve) => { resolvers.push(resolve) }),
    )

    await mountView()
    expect(resolvers.length).toBe(1)
    resolvers[0]([])
    await flushUi()
    // Positive control for the selector asserted below: once a load has settled, the loading
    // state is GONE, so its presence later is genuinely "still loading" and not a leftover.
    expect(container!.querySelector('[data-testid="template-group-sections-loading"]')).toBeNull()

    const stale = sectionsRef.value!.loadAll()
    const fresh = sectionsRef.value!.loadAll()
    await flushUi(1)
    expect(resolvers.length).toBe(3)
    expect(container!.querySelector('[data-testid="template-group-sections-loading"]')).not.toBeNull()

    // Only the ABANDONED org's request answers. The current org's is still on the wire.
    resolvers[1]([group({ id: 'atg_stale', name: 'Stale Org Group', sortOrder: 1 })])
    await stale
    await flushUi()

    // Without the guard on the `finally`, the stale call lowers `loadingGroups` and this view
    // drops out of its loading state into the (empty) settled render for an organization it has
    // not heard from yet.
    expect(container!.querySelector('[data-testid="template-group-sections-loading"]')).not.toBeNull()
    expect(container!.textContent).not.toContain('Stale Org Group')

    resolvers[2]([group({ id: 'atg_fresh', name: 'Fresh Org Group', sortOrder: 1 })])
    await fresh
    await flushUi()
    expect(container!.querySelector('[data-testid="template-group-sections-loading"]')).toBeNull()
    expect(container!.textContent).toContain('Fresh Org Group')
  })

  // ── Boundary ① at the component that OWNS the state ────────────────────────────────────────
  // Sibling of `ApprovalTemplateGroupsPanel.spec.ts`'s case. The sections are this view's own
  // per-organization state; a change of identity must drop them, and the read that was already on
  // the wire for the previous identity must not be able to paint them back.
  it('(①) an external principal change drops the rendered sections, and the load in flight for the previous identity cannot commit afterwards', async () => {
    const resolvers: Array<(groups: ApprovalTemplateGroupDTO[]) => void> = []
    listApprovalTemplateGroupsSpy.mockImplementation(
      () => new Promise<ApprovalTemplateGroupDTO[]>((resolve) => { resolvers.push(resolve) }),
    )

    await mountView()
    expect(resolvers.length).toBe(1)
    resolvers[0]([group({ id: 'atg_a', name: 'Previous Identity Group', sortOrder: 1 })])
    await flushUi()
    expect(container!.textContent).toContain('Previous Identity Group')

    const inFlight = sectionsRef.value!.loadAll()
    await flushUi(1)
    expect(resolvers.length).toBe(2)

    useAuth().setToken(`header.${btoa(JSON.stringify({ userId: 'other', tenantId: 'org-z', exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`)
    await flushUi(4)

    expect(container!.textContent).not.toContain('Previous Identity Group')

    resolvers[1]([group({ id: 'atg_a', name: 'Previous Identity Group', sortOrder: 1 })])
    await inFlight
    await flushUi()
    expect(container!.textContent).not.toContain('Previous Identity Group')
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
  })
})
