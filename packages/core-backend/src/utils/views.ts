export interface ViewDef {
  id: string
  name: string
  component?: string
}

export function sanitizeViews(input: unknown): ViewDef[] {
  if (!Array.isArray(input)) return []
  const out: ViewDef[] = []
  for (const v of input) {
    if (!v || typeof v !== 'object') continue
    const view = v as Record<string, unknown>
    if (typeof view.id !== 'string' || typeof view.name !== 'string') continue
    const item: ViewDef = {
      id: view.id,
      name: view.name
    }
    if (typeof view.component === 'string') item.component = view.component
    out.push(item)
  }
  return out
}
