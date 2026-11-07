import { attendancePersonnelLabel, type AttendancePersonnelIdentity } from './attendancePersonnelIdentity'

/** Only an identity captured for this ID may supply the primary label. */
export function formatAnnualBalanceSubject(
  userId: string | null | undefined,
  identity: AttendancePersonnelIdentity | null | undefined,
  tr: (en: string, zh: string) => string = (en) => en,
): string {
  return attendancePersonnelLabel(String(userId || '').trim(), identity, tr)
}
