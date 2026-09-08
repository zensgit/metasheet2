/**
 * Local-only toolbar pin preferences.
 * Storage key (QA can clear): metasheet.toolbar-pins.v1
 */

export const TOOLBAR_PINS_STORAGE_KEY = 'metasheet.toolbar-pins.v1'
export const TOOLBAR_PIN_CAP = 8
export const TOOLBAR_PIN_ANONYMOUS = 'anonymous'

export const NATIVE_PIN_COMMAND_IDS = [
  'row-height',
  'fit',
  'print',
  'import',
  'export-csv',
  'export-xlsx',
] as const

export const OVERFLOW_PIN_COMMAND_IDS = [
  'comment-inbox',
  'fields',
  'access',
  'views',
  'workflow',
  'automations',
  'templates',
  'dashboard',
  'share-form',
  'api',
  'trash',
  'history',
  'config-history',
  'archive-recovery',
] as const

export const TOOLBAR_PIN_COMMAND_IDS = [
  ...NATIVE_PIN_COMMAND_IDS,
  ...OVERFLOW_PIN_COMMAND_IDS,
] as const

export type NativePinCommandId = (typeof NATIVE_PIN_COMMAND_IDS)[number]
export type OverflowPinCommandId = (typeof OVERFLOW_PIN_COMMAND_IDS)[number]
export type ToolbarPinCommandId = (typeof TOOLBAR_PIN_COMMAND_IDS)[number]

const PIN_ID_SET = new Set<string>(TOOLBAR_PIN_COMMAND_IDS)

export const TOOLBAR_PIN_TITLES: Record<ToolbarPinCommandId, { zh: string; en: string }> = {
  'row-height': { zh: '行高', en: 'Row height' },
  fit: { zh: '适应列宽', en: 'Fit columns' },
  print: { zh: '打印', en: 'Print' },
  import: { zh: '导入', en: 'Import' },
  'export-csv': { zh: '导出 CSV', en: 'Export CSV' },
  'export-xlsx': { zh: '导出 Excel', en: 'Export Excel' },
  'comment-inbox': { zh: '评论收件箱', en: 'Comment inbox' },
  fields: { zh: '字段', en: 'Fields' },
  access: { zh: '权限', en: 'Access' },
  views: { zh: '视图', en: 'Views' },
  workflow: { zh: '工作流', en: 'Workflow' },
  automations: { zh: '自动化', en: 'Automations' },
  templates: { zh: '模板', en: 'Templates' },
  dashboard: { zh: '仪表盘', en: 'Dashboard' },
  'share-form': { zh: '分享表单', en: 'Share form' },
  api: { zh: 'API', en: 'API' },
  trash: { zh: '回收站', en: 'Trash' },
  history: { zh: '历史', en: 'History' },
  'config-history': { zh: '配置历史', en: 'Config history' },
  'archive-recovery': { zh: '归档恢复', en: 'Archive recovery' },
}

export function isToolbarPinCommandId(value: string): value is ToolbarPinCommandId {
  return PIN_ID_SET.has(value)
}

export function isNativePinCommandId(value: string): value is NativePinCommandId {
  return (NATIVE_PIN_COMMAND_IDS as readonly string[]).includes(value)
}

export function isOverflowPinCommandId(value: string): value is OverflowPinCommandId {
  return (OVERFLOW_PIN_COMMAND_IDS as readonly string[]).includes(value)
}

export function toolbarPinScope(userId?: string | null, sheetId?: string | null): string {
  const user = (userId ?? '').trim() || TOOLBAR_PIN_ANONYMOUS
  const sheet = (sheetId ?? '').trim() || '_'
  return `${user}::${sheet}`
}

export function sanitizeToolbarPins(ids: unknown): ToolbarPinCommandId[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<ToolbarPinCommandId>()
  const next: ToolbarPinCommandId[] = []
  for (const raw of ids) {
    if (typeof raw !== 'string' || !isToolbarPinCommandId(raw) || seen.has(raw)) continue
    seen.add(raw)
    next.push(raw)
    if (next.length >= TOOLBAR_PIN_CAP) break
  }
  return next
}

type PinStore = Record<string, string[]>

function readStore(): PinStore {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(TOOLBAR_PINS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as PinStore
  } catch {
    return {}
  }
}

function writeStore(store: PinStore): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(TOOLBAR_PINS_STORAGE_KEY, JSON.stringify(store))
}

export function readToolbarPins(scope: string): ToolbarPinCommandId[] {
  return sanitizeToolbarPins(readStore()[scope])
}

export function writeToolbarPins(scope: string, ids: readonly string[]): ToolbarPinCommandId[] {
  const next = sanitizeToolbarPins(ids)
  const store = readStore()
  if (next.length === 0) {
    delete store[scope]
  } else {
    store[scope] = next
  }
  writeStore(store)
  return next
}

export function resetToolbarPins(scope: string): ToolbarPinCommandId[] {
  return writeToolbarPins(scope, [])
}

export function pinToolbarCommand(
  current: readonly string[],
  id: string,
): ToolbarPinCommandId[] {
  if (!isToolbarPinCommandId(id)) return sanitizeToolbarPins(current)
  const sanitized = sanitizeToolbarPins(current)
  if (sanitized.includes(id) || sanitized.length >= TOOLBAR_PIN_CAP) return sanitized
  return [...sanitized, id]
}

export function unpinToolbarCommand(
  current: readonly string[],
  id: string,
): ToolbarPinCommandId[] {
  return sanitizeToolbarPins(current).filter((item) => item !== id)
}

export function moveToolbarPin(
  current: readonly string[],
  id: string,
  delta: -1 | 1,
): ToolbarPinCommandId[] {
  const next = sanitizeToolbarPins(current)
  const index = next.indexOf(id as ToolbarPinCommandId)
  if (index < 0) return next
  const target = index + delta
  if (target < 0 || target >= next.length) return next
  const copy = [...next]
  const [item] = copy.splice(index, 1)
  copy.splice(target, 0, item)
  return copy
}

export function reorderToolbarPins(
  current: readonly string[],
  fromId: string,
  toId: string,
): ToolbarPinCommandId[] {
  const next = sanitizeToolbarPins(current)
  if (fromId === toId) return next
  const from = next.indexOf(fromId as ToolbarPinCommandId)
  const to = next.indexOf(toId as ToolbarPinCommandId)
  if (from < 0 || to < 0) return next
  const copy = [...next]
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item)
  return copy
}
