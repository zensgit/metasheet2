/**
 * Pure planning for admin user batch create / update / disable / delete.
 * Routes apply the rows; this module does not touch the database.
 *
 * Permanent deletion is intentionally not planned as a write. Accounts are referenced by
 * attendance, audit, and directory history, and `users` has no recycle column. The hard-delete
 * request is validated (including the typed confirmation) and then refused with
 * HARD_DELETE_UNSUPPORTED so the follow-up (soft-delete + later purge) has a stable contract.
 */

export const ADMIN_USER_BATCH_LIMIT = 100
export const DISABLE_CONFIRM_TEXT = '停用'
export const HARD_DELETE_CONFIRM_TEXT = '永久删除'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type BatchItemResult = {
  index: number
  ok: boolean
  email: string | null
  userId: string | null
  code: string | null
  message: string
  temporaryPassword?: string
  changes?: Array<{ field: string; before: string | null; after: string | null }>
}

export type PlannedCreateRow = {
  index: number
  email: string
  name: string
  roleId: string | null
  department: string | null
}

export type KnownBatchUser = {
  id: string
  email: string | null
  name: string | null
  role: string
  department: string | null
  isActive: boolean
}

export type PlannedUpdate = {
  index: number
  userId: string
  email: string | null
  name?: string
  department?: string | null
  roleId?: string
  isActive?: boolean
  changes: Array<{ field: string; before: string | null; after: string | null }>
}

type PlanOk<T> = { ok: true; rows: T[]; failures: BatchItemResult[] }
type PlanErr = { ok: false; status: number; code: string; message: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/[<>'"&;]/g, '').slice(0, max)
}

function cleanEmail(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().slice(0, 255)
}

function cleanRoleId(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 64)
}

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || ''
  const cleaned = local.replace(/[<>'"&;]/g, '').slice(0, 100)
  return cleaned.length >= 2 ? cleaned : ''
}

function readItems(input: unknown): { items: unknown[] } | PlanErr {
  const body = asRecord(input) ?? {}
  const items = body.items
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, code: 'BATCH_EMPTY', message: '请至少提交一行' }
  }
  if (items.length > ADMIN_USER_BATCH_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: 'BATCH_LIMIT_EXCEEDED',
      message: `一次最多 ${ADMIN_USER_BATCH_LIMIT} 行`,
    }
  }
  return { items }
}

export function planCreateBatch(input: {
  body: unknown
  existingEmails: ReadonlySet<string>
  knownRoleIds: ReadonlySet<string>
}): PlanOk<PlannedCreateRow> | PlanErr {
  const read = readItems(input.body)
  if (!('items' in read)) return read

  const seen = new Set<string>()
  const rows: PlannedCreateRow[] = []
  const failures: BatchItemResult[] = []

  read.items.forEach((raw, index) => {
    const record = asRecord(raw) ?? {}
    const email = cleanEmail(record.email)
    const explicitName = cleanText(record.name, 100)
    const name = explicitName || nameFromEmail(email)
    const roleId = cleanRoleId(record.roleId)
    const department = cleanText(record.department, 100) || null

    const fail = (code: string, message: string) => {
      failures.push({ index, ok: false, email: email || null, userId: null, code, message })
    }

    if (!email || !EMAIL_PATTERN.test(email)) {
      fail('INVALID_EMAIL', '邮箱格式不正确')
      return
    }
    if (seen.has(email)) {
      fail('DUPLICATE_EMAIL_IN_BATCH', '本批中邮箱重复')
      return
    }
    seen.add(email)
    if (input.existingEmails.has(email)) {
      fail('EMAIL_ALREADY_EXISTS', '邮箱已存在')
      return
    }
    if (name.length < 2 || name.length > 100) {
      fail('INVALID_NAME', '姓名需为 2–100 个字符；粘贴邮箱时会用邮箱名作为姓名')
      return
    }
    if (roleId && !input.knownRoleIds.has(roleId)) {
      fail('ROLE_NOT_FOUND', '角色不存在')
      return
    }
    rows.push({ index, email, name, roleId: roleId || null, department })
  })

  return { ok: true, rows, failures }
}

export function planUpdateBatch(input: {
  body: unknown
  usersById: ReadonlyMap<string, KnownBatchUser>
  usersByEmail: ReadonlyMap<string, KnownBatchUser>
  knownRoleIds: ReadonlySet<string>
}): PlanOk<PlannedUpdate> | PlanErr {
  const read = readItems(input.body)
  if (!('items' in read)) return read

  const rows: PlannedUpdate[] = []
  const failures: BatchItemResult[] = []

  read.items.forEach((raw, index) => {
    const record = asRecord(raw) ?? {}
    const userId = typeof record.userId === 'string' ? record.userId.trim() : ''
    const email = cleanEmail(record.email)
    const hasDepartment = Object.prototype.hasOwnProperty.call(record, 'department') && record.department !== undefined
    const hasRole = Object.prototype.hasOwnProperty.call(record, 'roleId') && cleanRoleId(record.roleId) !== ''
    const hasActive = typeof record.isActive === 'boolean'
    const hasName = typeof record.name === 'string' && cleanText(record.name, 100) !== ''

    const fail = (code: string, message: string, id: string | null = null) => {
      failures.push({ index, ok: false, email: email || null, userId: id, code, message })
    }

    if (!userId && !email) {
      fail('MATCH_KEY_REQUIRED', '需要用户 ID 或邮箱才能匹配')
      return
    }

    const byId = userId ? input.usersById.get(userId) : undefined
    const byEmail = email ? input.usersByEmail.get(email) : undefined
    if (userId && !byId) {
      fail('USER_NOT_FOUND', '找不到该用户', userId)
      return
    }
    if (!userId && email && !byEmail) {
      fail('USER_NOT_FOUND', '找不到该邮箱对应的用户')
      return
    }
    if (byId && byEmail && byId.id !== byEmail.id) {
      fail('AMBIGUOUS_MATCH', '用户 ID 与邮箱不是同一个人', byId.id)
      return
    }
    const user = byId || byEmail
    if (!user) {
      fail('USER_NOT_FOUND', '找不到该用户')
      return
    }

    const roleId = cleanRoleId(record.roleId)
    if (hasRole && !input.knownRoleIds.has(roleId)) {
      fail('ROLE_NOT_FOUND', '角色不存在', user.id)
      return
    }

    const changes: PlannedUpdate['changes'] = []
    const planned: PlannedUpdate = { index, userId: user.id, email: user.email, changes }

    if (hasDepartment) {
      const next = cleanText(record.department, 100) || null
      if ((user.department || null) !== next) {
        planned.department = next
        changes.push({ field: 'department', before: user.department, after: next })
      }
    }
    if (hasName) {
      const nextName = cleanText(record.name, 100)
      if (nextName.length < 2) {
        fail('INVALID_NAME', '姓名需为 2–100 个字符', user.id)
        return
      }
      if ((user.name || '') !== nextName) {
        planned.name = nextName
        changes.push({ field: 'name', before: user.name, after: nextName })
      }
    }
    if (hasRole && user.role !== roleId) {
      planned.roleId = roleId
      changes.push({ field: 'roleId', before: user.role, after: roleId })
    }
    if (hasActive && user.isActive !== record.isActive) {
      planned.isActive = record.isActive as boolean
      changes.push({
        field: 'isActive',
        before: user.isActive ? 'true' : 'false',
        after: (record.isActive as boolean) ? 'true' : 'false',
      })
    }

    if (changes.length === 0) {
      failures.push({
        index,
        ok: true,
        email: user.email,
        userId: user.id,
        code: 'UNCHANGED',
        message: '没有变化',
        changes: [],
      })
      return
    }
    rows.push(planned)
  })

  return { ok: true, rows, failures }
}

export function planStatusBatch(input: {
  userIds: unknown
  isActive: unknown
  actorId: string
  knownIds: ReadonlySet<string>
}): PlanOk<{ index: number; userId: string }> | PlanErr {
  if (typeof input.isActive !== 'boolean') {
    return { ok: false, status: 400, code: 'STATUS_REQUIRED', message: '需要 isActive 布尔值' }
  }
  if (!Array.isArray(input.userIds) || input.userIds.length === 0) {
    return { ok: false, status: 400, code: 'BATCH_EMPTY', message: '请至少选择一名用户' }
  }
  const ids = input.userIds
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    return { ok: false, status: 400, code: 'BATCH_EMPTY', message: '请至少选择一名用户' }
  }
  if (ids.length > ADMIN_USER_BATCH_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: 'BATCH_LIMIT_EXCEEDED',
      message: `一次最多 ${ADMIN_USER_BATCH_LIMIT} 人`,
    }
  }

  const rows: Array<{ index: number; userId: string }> = []
  const failures: BatchItemResult[] = []
  ids.forEach((userId, index) => {
    if (!input.knownIds.has(userId)) {
      failures.push({
        index,
        ok: false,
        email: null,
        userId,
        code: 'USER_NOT_FOUND',
        message: '找不到该用户',
      })
      return
    }
    if (input.isActive === false && userId === input.actorId) {
      failures.push({
        index,
        ok: false,
        email: null,
        userId,
        code: 'SELF_DISABLE_FORBIDDEN',
        message: '不能停用自己的账号',
      })
      return
    }
    rows.push({ index, userId })
  })
  return { ok: true, rows, failures }
}

export function planDeleteBatch(input: {
  userIds: unknown
  mode: unknown
  confirmText: unknown
  actorId: string
  knownIds: ReadonlySet<string>
}): PlanOk<{ index: number; userId: string }> | PlanErr | { ok: false; status: number; code: 'HARD_DELETE_UNSUPPORTED'; message: string; userIds: string[] } {
  const mode = input.mode === 'hard' ? 'hard' : input.mode === 'disable' ? 'disable' : ''
  if (!mode) {
    return { ok: false, status: 400, code: 'DELETE_MODE_REQUIRED', message: 'mode 只能是 disable 或 hard' }
  }
  const expected = mode === 'hard' ? HARD_DELETE_CONFIRM_TEXT : DISABLE_CONFIRM_TEXT
  if (input.confirmText !== expected) {
    return { ok: false, status: 400, code: 'CONFIRM_TEXT_MISMATCH', message: `请输入「${expected}」以确认` }
  }
  if (mode === 'hard') {
    const ids = Array.isArray(input.userIds)
      ? input.userIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    return {
      ok: false,
      status: 409,
      code: 'HARD_DELETE_UNSUPPORTED',
      message: '永久删除尚未开放。账号被考勤、审计和目录引用，请改用停用；回收站与延期清理记为后续项。',
      userIds: ids.slice(0, ADMIN_USER_BATCH_LIMIT),
    }
  }
  return planStatusBatch({
    userIds: input.userIds,
    isActive: false,
    actorId: input.actorId,
    knownIds: input.knownIds,
  })
}
