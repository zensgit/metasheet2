export type FixedScheduleWriteAction = 'apply' | 'rebuild' | 'clear'

export type FixedScheduleWrites = {
  apply: boolean
  rebuild: boolean
  clear: boolean
}

export type AttendanceCatalogScope = 'org' | 'managed' | 'unknown'

const CLOSED_WRITES: FixedScheduleWrites = { apply: false, rebuild: false, clear: false }
const OPEN_WRITES: FixedScheduleWrites = { apply: true, rebuild: true, clear: true }

/** Org admins keep write buttons. Managed owners and an unknown catalog stay closed. */
export function fixedScheduleWritesForCatalog(scope: AttendanceCatalogScope): FixedScheduleWrites {
  return scope === 'org' ? { ...OPEN_WRITES } : { ...CLOSED_WRITES }
}

/** Missing or non-boolean grants fail closed. Only exact `true` enables a write. */
export function readFixedScheduleWrites(value: unknown): FixedScheduleWrites {
  if (!value || typeof value !== 'object') return { ...CLOSED_WRITES }
  const record = value as Record<string, unknown>
  return {
    apply: record.apply === true,
    rebuild: record.rebuild === true,
    clear: record.clear === true,
  }
}

type Translate = (en: string, zh: string) => string

export function fixedScheduleScopeForbiddenCopy(action: FixedScheduleWriteAction, tr: Translate): string {
  if (action === 'rebuild') {
    return tr(
      'Preview only. This account does not have permission to rebuild managed rows.',
      '仅可预览，没有重建已管理排班的权限。',
    )
  }
  if (action === 'clear') {
    return tr(
      'Preview only. This account does not have permission to clear managed rows.',
      '仅可预览，没有清除已管理排班的权限。',
    )
  }
  return tr(
    'Preview only. This account does not have permission to apply the fixed schedule.',
    '仅可预览，没有应用固定排班的权限。',
  )
}
