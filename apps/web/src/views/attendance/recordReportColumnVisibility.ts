export const RECORD_REPORT_COLUMN_PREFS_STORAGE_KEY = 'metasheet_attendance_report_record_columns'

/** Date and name stay on screen. They are the sticky columns of the records table. */
export const RECORD_REPORT_PINNED_COLUMN_CODES = ['work_date', 'employee_name'] as const

/**
 * Calm default for the ~49-field catalog: who, the day's punches, and the headline result.
 * Everything else stays available from 「显示字段」.
 */
export const RECORD_REPORT_DEFAULT_VISIBLE_CODES = [
  'work_date',
  'employee_name',
  'department',
  'attendance_group',
  'punch_times',
  'attendance_result',
  'work_duration',
  'late_duration',
  'early_leave_duration',
  'leave_duration',
  'overtime_approval_duration',
] as const

export type RecordReportColumnMode = 'default' | 'all' | 'custom'

export interface RecordReportColumnPrefs {
  mode: RecordReportColumnMode
  visibleCodes: string[]
}

export function defaultRecordReportColumnPrefs(): RecordReportColumnPrefs {
  return { mode: 'default', visibleCodes: [] }
}

export function loadRecordReportColumnPrefs(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): RecordReportColumnPrefs {
  if (!storage) return defaultRecordReportColumnPrefs()
  try {
    const raw = storage.getItem(RECORD_REPORT_COLUMN_PREFS_STORAGE_KEY)
    if (!raw) return defaultRecordReportColumnPrefs()
    const parsed = JSON.parse(raw) as Partial<RecordReportColumnPrefs>
    const mode = parsed.mode === 'all' || parsed.mode === 'custom' || parsed.mode === 'default'
      ? parsed.mode
      : 'default'
    const visibleCodes = Array.isArray(parsed.visibleCodes)
      ? parsed.visibleCodes.map(code => String(code || '').trim()).filter(Boolean)
      : []
    return { mode, visibleCodes }
  } catch {
    return defaultRecordReportColumnPrefs()
  }
}

export function saveRecordReportColumnPrefs(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  prefs: RecordReportColumnPrefs,
): void {
  if (!storage) return
  try {
    storage.setItem(RECORD_REPORT_COLUMN_PREFS_STORAGE_KEY, JSON.stringify({
      mode: prefs.mode,
      visibleCodes: prefs.visibleCodes,
    }))
  } catch {
    // Private mode and quota failures keep the in-memory choice.
  }
}

function isPinned(code: string): boolean {
  return (RECORD_REPORT_PINNED_COLUMN_CODES as readonly string[]).includes(code)
}

function pinnedPresent(available: readonly string[]): string[] {
  return RECORD_REPORT_PINNED_COLUMN_CODES.filter(code => available.includes(code))
}

export function resolveVisibleRecordReportCodes(
  available: readonly string[],
  prefs: RecordReportColumnPrefs,
): string[] {
  if (prefs.mode === 'all') return [...available]
  const allowed = prefs.mode === 'custom'
    ? new Set([...pinnedPresent(available), ...prefs.visibleCodes])
    : new Set<string>([...RECORD_REPORT_DEFAULT_VISIBLE_CODES, ...pinnedPresent(available)])
  return available.filter(code => allowed.has(code))
}

export function toggleRecordReportColumn(
  available: readonly string[],
  prefs: RecordReportColumnPrefs,
  code: string,
  visible: boolean,
): RecordReportColumnPrefs {
  if (isPinned(code)) return prefs
  const next = new Set(resolveVisibleRecordReportCodes(available, prefs))
  if (visible) next.add(code)
  else next.delete(code)
  for (const pinned of pinnedPresent(available)) next.add(pinned)
  return {
    mode: 'custom',
    visibleCodes: available.filter(item => next.has(item)),
  }
}

export function showAllRecordReportColumns(): RecordReportColumnPrefs {
  return { mode: 'all', visibleCodes: [] }
}

export function resetRecordReportColumns(): RecordReportColumnPrefs {
  return defaultRecordReportColumnPrefs()
}
