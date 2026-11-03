export const USER_IMPORT_HEADERS = ['name', 'email', 'roleId', 'department'] as const
export const USER_UPDATE_HEADERS = ['userId', 'email', 'name', 'roleId', 'department', 'isActive'] as const
export const ADMIN_USER_BATCH_LIMIT = 100

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ImportPreviewRow = {
  index: number
  name: string
  email: string
  roleId: string
  department: string
  ok: boolean
  message: string
}

export type UpdatePreviewRow = {
  index: number
  userId: string
  email: string
  name: string
  roleId: string
  department: string
  isActive: string
  ok: boolean
  message: string
  changes: Array<{ field: string; before: string; after: string }>
}

export function buildImportTemplateCsv(): string {
  const rows = [
    USER_IMPORT_HEADERS.join(','),
    '林岚,linlan@example.com,user,装配车间',
  ]
  return `\ufeff${rows.join('\n')}\n`
}

export function buildUpdateExportCsv(users: Array<{
  id: string
  email: string | null
  name: string | null
  role: string
  department?: string | null
  is_active: boolean
}>): string {
  const lines = [USER_UPDATE_HEADERS.join(',')]
  for (const user of users) {
    lines.push([
      user.id,
      user.email || '',
      user.name || '',
      user.role || '',
      user.department || '',
      user.is_active ? 'true' : 'false',
    ].map(escapeCsv).join(','))
  }
  return `\ufeff${lines.join('\n')}\n`
}

export function parsePastedEmails(text: string): string[] {
  const found = text.split(/[\s,;，；]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)
  return [...new Set(found)]
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const cleaned = text.replace(/^\ufeff/, '').trim()
  if (!cleaned) return []
  const table = parseCsvTable(cleaned)
  if (table.length === 0) return []
  const headers = table[0].map((cell) => cell.trim())
  return table.slice(1).filter((line) => line.some((cell) => cell.trim())).map((line) => {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = (line[index] || '').trim()
    })
    return record
  })
}

export function validateImportRows(rows: Array<Record<string, string>>, knownRoleIds: ReadonlySet<string>): ImportPreviewRow[] {
  const seen = new Set<string>()
  return rows.map((row, index) => {
    const email = (row.email || '').trim().toLowerCase()
    const name = (row.name || '').trim()
    const roleId = (row.roleId || '').trim()
    const department = (row.department || '').trim()
    let message = '可以导入'
    let ok = true
    if (!EMAIL_PATTERN.test(email)) {
      ok = false
      message = '邮箱格式不正确'
    } else if (seen.has(email)) {
      ok = false
      message = '本批中邮箱重复'
    } else if (roleId && !knownRoleIds.has(roleId)) {
      ok = false
      message = '角色不存在'
    } else if (name && (name.length < 2 || name.length > 100)) {
      ok = false
      message = '姓名需为 2–100 个字符'
    }
    if (email) seen.add(email)
    return { index, name, email, roleId, department, ok, message }
  })
}

export function previewUpdateRows(
  rows: Array<Record<string, string>>,
  users: Array<{ id: string; email: string | null; name: string | null; role: string; department?: string | null; is_active: boolean }>,
  knownRoleIds: ReadonlySet<string>,
): UpdatePreviewRow[] {
  const byId = new Map(users.map((user) => [user.id, user]))
  const byEmail = new Map(users.filter((user) => user.email).map((user) => [String(user.email).toLowerCase(), user]))
  return rows.map((row, index) => {
    const userId = (row.userId || '').trim()
    const email = (row.email || '').trim().toLowerCase()
    const roleId = (row.roleId || '').trim()
    const department = row.department ?? ''
    const isActive = (row.isActive || '').trim()
    const changes: UpdatePreviewRow['changes'] = []
    const idUser = userId ? byId.get(userId) : undefined
    const emailUser = email ? byEmail.get(email) : undefined
    const identitiesDisagree = Boolean(userId && email && (
      (idUser && (idUser.email || '').toLowerCase() !== email)
      || (!idUser && emailUser && emailUser.id !== userId)
    ))
    if (identitiesDisagree) {
      return {
        index,
        userId,
        email,
        name: row.name || '',
        roleId,
        department,
        isActive,
        ok: false,
        message: '用户 ID 与邮箱不是同一个人',
        changes,
      }
    }
    const user = idUser || emailUser || null
    if (!user) {
      return {
        index, userId, email, name: row.name || '', roleId, department, isActive,
        ok: Boolean(userId || email),
        message: userId || email ? '当前列表里没有此人，提交时按邮箱或用户 ID 再匹配' : '需要用户 ID 或邮箱',
        changes,
      }
    }
    if (roleId && !knownRoleIds.has(roleId)) {
      return {
        index, userId: user.id, email: user.email || email, name: row.name || user.name || '', roleId, department, isActive,
        ok: false, message: '角色不存在', changes,
      }
    }
    if (department !== '' && department !== (user.department || '')) {
      changes.push({ field: '部门', before: user.department || '', after: department })
    }
    if (roleId && roleId !== user.role) {
      changes.push({ field: '角色', before: user.role, after: roleId })
    }
    if (isActive === 'true' || isActive === 'false') {
      const next = isActive === 'true'
      if (next !== user.is_active) changes.push({ field: '状态', before: user.is_active ? '启用' : '停用', after: next ? '启用' : '停用' })
    }
    return {
      index,
      userId: user.id,
      email: user.email || email,
      name: row.name || user.name || '',
      roleId,
      department,
      isActive,
      ok: true,
      message: changes.length ? '将更新' : '没有变化',
      changes,
    }
  })
}

function escapeCsv(value: string): string {
  if (!/[",\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function parseCsvTable(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      row.push(cell)
      cell = ''
      continue
    }
    if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    if (char !== '\r') cell += char
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
