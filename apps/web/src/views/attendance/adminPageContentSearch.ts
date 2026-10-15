export const ADMIN_PAGE_SEARCH_HIDDEN_ATTR = 'data-admin-page-search-hidden'
export const ADMIN_PAGE_SEARCH_HIT_CLASS = 'attendance__page-search-hit'
const PRIOR_DISPLAY_ATTR = 'data-admin-page-search-prior-display'

export const ADMIN_PAGE_SEARCH_UNIT_SELECTOR = [
  '.attendance__field',
  '.attendance__form-card',
  '.attendance__admin-section-header',
  '.attendance__admin-task-group',
  '.attendance__admin-task-action',
  '.attendance__admin-shortcut',
  'tbody > tr',
  'li',
].join(',')

export interface AdminPageSearchResult {
  matched: number
  hidden: number
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}

function elementDepth(element: HTMLElement): number {
  let depth = 0
  let current: HTMLElement | null = element
  while (current) {
    depth += 1
    current = current.parentElement
  }
  return depth
}

function isInClosedSection(element: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current && current !== root) {
    if (current.getAttribute(ADMIN_PAGE_SEARCH_HIDDEN_ATTR) === 'true') return true
    if (current.style.display === 'none') return true
    current = current.parentElement
  }
  return false
}

export function clearAdminPageContentSearch(root: ParentNode): void {
  const marked = root.querySelectorAll<HTMLElement>(
    `[${ADMIN_PAGE_SEARCH_HIDDEN_ATTR}], .${ADMIN_PAGE_SEARCH_HIT_CLASS}`,
  )
  marked.forEach((element) => {
    if (element.getAttribute(ADMIN_PAGE_SEARCH_HIDDEN_ATTR) === 'true') {
      const prior = element.getAttribute(PRIOR_DISPLAY_ATTR) ?? ''
      element.style.removeProperty('display')
      if (prior) element.style.display = prior
      element.removeAttribute(ADMIN_PAGE_SEARCH_HIDDEN_ATTR)
      element.removeAttribute(PRIOR_DISPLAY_ATTR)
    }
    element.classList.remove(ADMIN_PAGE_SEARCH_HIT_CLASS)
    element.style.removeProperty('outline')
    element.style.removeProperty('outline-offset')
  })
}

export function applyAdminPageContentSearch(root: HTMLElement, query: string): AdminPageSearchResult {
  clearAdminPageContentSearch(root)
  const needle = normalizeSearchText(query)
  if (!needle) return { matched: 0, hidden: 0 }

  const units = Array.from(root.querySelectorAll<HTMLElement>(ADMIN_PAGE_SEARCH_UNIT_SELECTOR))
    .filter((element) => !element.closest('[data-admin-current-section], [data-admin-page-search]'))
    .filter((element) => !isInClosedSection(element, root))
    .sort((left, right) => elementDepth(right) - elementDepth(left))

  const hasMatch = units.some((unit) => normalizeSearchText(unit.textContent ?? '').includes(needle))
  if (!hasMatch) return { matched: 0, hidden: 0 }

  let matched = 0
  let hidden = 0
  for (const unit of units) {
    if (unit.closest(`[${ADMIN_PAGE_SEARCH_HIDDEN_ATTR}="true"]`)) continue
    const text = normalizeSearchText(unit.textContent ?? '')
    if (text.includes(needle)) {
      if (!unit.querySelector(`.${ADMIN_PAGE_SEARCH_HIT_CLASS}`)) {
        unit.classList.add(ADMIN_PAGE_SEARCH_HIT_CLASS)
        unit.style.setProperty('outline', '2px solid #2563eb')
        unit.style.setProperty('outline-offset', '1px')
        matched += 1
      }
    } else {
      unit.setAttribute(PRIOR_DISPLAY_ATTR, unit.style.display || '')
      unit.style.setProperty('display', 'none', 'important')
      unit.setAttribute(ADMIN_PAGE_SEARCH_HIDDEN_ATTR, 'true')
      hidden += 1
    }
  }
  return { matched, hidden }
}
