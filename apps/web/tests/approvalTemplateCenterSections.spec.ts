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
 * while leaving the section order exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type { ApprovalTemplateGroupDTO, ApprovalTemplateGroupReorderResultDTO } from '../src/types/approval'

const listApprovalTemplateGroupsSpy = vi.fn<[], Promise<ApprovalTemplateGroupDTO[]>>()
const listTemplateCategoriesSpy = vi.fn<[], Promise<string[]>>()
const listTemplatesBySectionSpy = vi.fn()
const reorderApprovalTemplateGroupsSpy = vi.fn<[string[]], Promise<ApprovalTemplateGroupReorderResultDTO[]>>()

vi.mock('../src/approvals/api', () => ({
  listApprovalTemplateGroups: () => listApprovalTemplateGroupsSpy(),
  listTemplateCategories: () => listTemplateCategoriesSpy(),
  listTemplatesBySection: (params: unknown) => listTemplatesBySectionSpy(params),
  reorderApprovalTemplateGroups: (groupIds: string[]) => reorderApprovalTemplateGroupsSpy(groupIds),
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
    listTemplatesBySectionSpy.mockImplementation(({ section }: { section: string }) => {
      if (section === 'group:atg_a') {
        return Promise.resolve({ data: [template('tpl_1', 'Onboarding form')], total: 1 })
      }
      return Promise.resolve({ data: [], total: 0 })
    })

    await mountView()

    const groupSection = container!.querySelector('[data-testid="template-group-section-group:atg_a"]')!
    expect(groupSection.textContent).toContain('Group A')
    expect(groupSection.textContent).toContain('Onboarding form')
    expect(groupSection.querySelector('[data-testid="template-group-section-count"]')?.textContent?.trim()).toBe('1')

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
})
