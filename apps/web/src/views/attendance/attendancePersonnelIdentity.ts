type Translate = (en: string, zh: string) => string

export interface AttendancePersonnelIdentity { id: string; name: string }
interface PersonnelSource {
  id: string
  name?: string | null
  email?: string | null
  role?: string
  created_at?: string
}

export function isRetainedPersonnelValue(user: PersonnelSource): boolean {
  return user.name === null && user.email === user.id && !user.role && user.created_at === ''
}

/** Trust supplied identity fields, never the synthetic retained-value email. */
export function attendancePersonnelName(user: PersonnelSource | null | undefined): string {
  if (!user || isRetainedPersonnelValue(user)) return ''
  const name = user.name?.trim() || ''
  const email = user.email?.trim() || ''
  if (name && email && name !== email) return `${name} · ${email}`
  return name || email
}

export function attendancePersonnelLabel(id: string, identity: AttendancePersonnelIdentity | null | undefined, tr: Translate): string {
  const name = identity?.id === id ? identity.name.trim() : ''
  return `${name || tr('Unnamed employee', '未命名员工')}（ID: ${id}）`
}
