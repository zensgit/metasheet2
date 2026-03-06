export type ViewOption = {
  id: string
  name: string
  type?: string
  sheetId?: string
}

export type ViewTypeFilter = 'all' | 'grid' | 'kanban' | 'calendar' | 'gallery' | 'form' | 'other'

export const VIEW_TYPE_FILTER_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'grid', label: 'Grid' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'form', label: 'Form' },
  { id: 'other', label: 'Other' },
] as const satisfies ReadonlyArray<{ id: ViewTypeFilter; label: string }>

const KNOWN_VIEW_TYPES = new Set<ViewTypeFilter>([
  'all',
  'grid',
  'kanban',
  'calendar',
  'gallery',
  'form',
  'other',
])

export function normalizeViewType(type?: string): Exclude<ViewTypeFilter, 'all'> {
  if (!type || !KNOWN_VIEW_TYPES.has(type as ViewTypeFilter) || type === 'all') {
    return 'other'
  }

  return type as Exclude<ViewTypeFilter, 'all'>
}

export function getViewTypeLabel(type?: string) {
  switch (normalizeViewType(type)) {
    case 'grid':
      return 'Grid'
    case 'kanban':
      return 'Kanban'
    case 'calendar':
      return 'Calendar'
    case 'gallery':
      return 'Gallery'
    case 'form':
      return 'Form'
    default:
      return 'Other'
  }
}

export function filterViews(views: ViewOption[], search: string, filter: ViewTypeFilter) {
  const needle = search.trim().toLowerCase()

  return views.filter((view) => {
    const viewType = normalizeViewType(view.type)
    if (filter !== 'all' && viewType !== filter) {
      return false
    }

    if (!needle) {
      return true
    }

    const haystack = `${view.name ?? ''} ${view.id}`.toLowerCase()
    return haystack.includes(needle)
  })
}

export function groupViews(views: ViewOption[]) {
  const groups = new Map<string, ViewOption[]>()

  views.forEach((view) => {
    const type = normalizeViewType(view.type)
    const list = groups.get(type) ?? []
    list.push(view)
    groups.set(type, list)
  })

  return Array.from(groups.entries())
    .map(([type, list]) => ({
      type,
      label: getViewTypeLabel(type),
      views: list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
