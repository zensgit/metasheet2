import type { LocalDepartment } from '../../services/localOrganizationClient'

// Project the one canonical tree. Orphans/cycles remain visible and cannot loop.
export function departmentRows(departments: LocalDepartment[]): Array<{ department: LocalDepartment; depth: number }> {
  const sorted = [...departments].sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name))
  const ids = new Set(sorted.map(d => d.id))
  const visited = new Set<string>()
  const rows: Array<{ department: LocalDepartment; depth: number }> = []
  function walk(department: LocalDepartment, depth: number) {
    if (visited.has(department.id)) return
    visited.add(department.id)
    rows.push({ department, depth })
    sorted.filter(d => d.parentDepartmentId === department.id).forEach(d => walk(d, depth + 1))
  }
  sorted.filter(d => !d.parentDepartmentId || !ids.has(d.parentDepartmentId)).forEach(d => walk(d, 0))
  sorted.forEach(d => walk(d, 0))
  return rows
}
export function parentOptions(departments: LocalDepartment[], selectedId: string): LocalDepartment[] {
  const excluded = new Set([selectedId])
  let changed = true
  while (changed) {
    changed = false
    for (const d of departments) {
      if (d.parentDepartmentId && excluded.has(d.parentDepartmentId) && !excluded.has(d.id)) {
        excluded.add(d.id)
        changed = true
      }
    }
  }
  return departments.filter(d => d.isActive && !excluded.has(d.id))
}
