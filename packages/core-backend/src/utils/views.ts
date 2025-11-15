export interface ViewDef {
  id: string
  name: string
  component?: string
}

export function sanitizeViews(input: any): ViewDef[] {
  if (!Array.isArray(input)) return []
  const out: ViewDef[] = []
  for (const v of input) {
    if (!v || typeof v.id !== 'string' || typeof v.name !== 'string') continue
    const item: ViewDef = {
      id: v.id,
      name: v.name
    }
    if (typeof v.component === 'string') item.component = v.component
    out.push(item)
  }
  return out
}

