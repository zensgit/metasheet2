/**
 * Roadmap §7.8 "Add timezone support" — per-integration timezone for the directory sync
 * scheduler, PURE and dependency-free.
 *
 * `directory_integrations.schedule_timezone` sits alongside `schedule_cron` (same column
 * shape, same table) and is NULL for every pre-existing row. This module is the single
 * place that decides "what timezone does this integration's cron run in" so the save-time
 * validator (`admin-directory.ts`), the runtime scheduler (`directory-sync-scheduler.ts`),
 * and the read-only schedule snapshot (`directory-sync.ts`) can never disagree.
 *
 * IANA validity (`isValidIanaTimeZone`) and wall-clock math (`getZonedParts`) are imported
 * from `multitable/automation-timezone.ts` rather than re-implemented — that module already
 * mirrors the proven `plugins/plugin-attendance` zoned-time pattern (T2-5) and its own
 * docstring invites reuse so the codebase keeps ONE shape for this math. No new dependency.
 */
import { isValidIanaTimeZone } from '../multitable/automation-timezone'

/** Absent / null / '' / 'UTC' / 'Etc/UTC' are all the SAME "no configured timezone" state. */
export const DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE = 'UTC'

/**
 * True iff `raw` is "UTC or absent" — the fast path that MUST stay byte-identical to
 * pre-§7.8 behavior (every existing integration has `schedule_timezone IS NULL`).
 *
 * `undefined`/`null` (a genuinely absent field) count as the default state. Any other
 * non-string value (a number, object, array, boolean — malformed input the API layer would
 * never itself produce, but this is a PUBLIC pure function) does NOT — it is neither "the
 * default" nor collapsed to '' the way a real absent field is, so `isValidDirectoryScheduleTimezone`
 * below correctly rejects it instead of silently waving it through as "use the default".
 */
export function isDirectoryScheduleDefaultTimezone(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true
  if (typeof raw !== 'string') return false
  const tz = raw.trim()
  return tz.length === 0 || tz === 'UTC' || tz === 'Etc/UTC'
}

/**
 * Save-time validity gate (fail-closed): empty/absent/UTC/Etc-UTC is always valid (= use the
 * default). A non-string value (malformed input) is REJECTED outright. Anything else must be
 * a real IANA zone the platform `Intl` recognizes; junk is REJECTED here rather than silently
 * degrading to UTC — degrading-on-save would defeat the whole point of a per-integration
 * timezone (the admin would believe a zone was saved that was quietly dropped). Mirrors
 * `automation-service.ts`'s `schedule.cron` timezone gate.
 */
export function isValidDirectoryScheduleTimezone(raw: unknown): boolean {
  if (isDirectoryScheduleDefaultTimezone(raw)) return true
  if (typeof raw !== 'string') return false
  return isValidIanaTimeZone(raw.trim())
}

/**
 * Resolve the EFFECTIVE timezone string to hand to `SimpleCronExpression` / the scheduler's
 * `ScheduleOptions.timezone`. Absent/empty/UTC/Etc-UTC → the literal `'UTC'` (byte-identical
 * to every pre-§7.8 call site, which all hardcoded that same literal). A persisted value that
 * is somehow invalid or not even a string (e.g. a direct-DB write bypassing the save
 * validator) also falls back to `'UTC'` here — this function NEVER throws; the write-boundary
 * gate (`isValidDirectoryScheduleTimezone`) is what actually blocks bad input (Q6-style
 * runtime defense, matching `automation-scheduler.ts`'s `resolveCronTimeZone`).
 */
export function resolveDirectoryScheduleTimezone(raw: unknown): string {
  if (isDirectoryScheduleDefaultTimezone(raw)) return DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE
  if (typeof raw !== 'string') return DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE
  const tz = raw.trim()
  return isValidIanaTimeZone(tz) ? tz : DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE
}
