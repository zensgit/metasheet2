export function hasDirectoryDepartmentCycle(
  departments: ReadonlyMap<string, { parentId: string | null }>,
): boolean {
  const resolved = new Set<string>()
  for (const id of departments.keys()) {
    const chain = new Set<string>()
    let current: string | null | undefined = id
    while (current && departments.has(current) && !resolved.has(current)) {
      if (chain.has(current)) return true
      chain.add(current)
      current = departments.get(current)?.parentId
    }
    for (const visited of chain) resolved.add(visited)
  }
  return false
}
