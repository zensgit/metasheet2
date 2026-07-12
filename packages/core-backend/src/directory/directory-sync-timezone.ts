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

function normalizeRawText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * True iff `raw` is "UTC or absent" — the fast path that MUST stay byte-identical to
 * pre-§7.8 behavior (every existing integration has `schedule_timezone IS NULL`).
 */
export function isDirectoryScheduleDefaultTimezone(raw: unknown): boolean {
  const tz = normalizeRawText(raw)
  return tz.length === 0 || tz === 'UTC' || tz === 'Etc/UTC'
}

/**
 * Save-time validity gate (fail-closed): empty/absent/UTC/Etc-UTC is always valid (= use the
 * default). Anything else must be a real IANA zone the platform `Intl` recognizes; junk is
 * REJECTED here rather than silently degrading to UTC — degrading-on-save would defeat the
 * whole point of a per-integration timezone (the admin would believe a zone was saved that
 * was quietly dropped). Mirrors `automation-service.ts`'s `schedule.cron` timezone gate.
 */
export function isValidDirectoryScheduleTimezone(raw: unknown): boolean {
  if (isDirectoryScheduleDefaultTimezone(raw)) return true
  return isValidIanaTimeZone(normalizeRawText(raw))
}

/**
 * Resolve the EFFECTIVE timezone string to hand to `SimpleCronExpression` / the scheduler's
 * `ScheduleOptions.timezone`. Absent/empty/UTC/Etc-UTC → the literal `'UTC'` (byte-identical
 * to every pre-§7.8 call site, which all hardcoded that same literal). A persisted value that
 * is somehow invalid (e.g. a direct-DB write bypassing the save validator) also falls back to
 * `'UTC'` here — this function NEVER throws; the write-boundary gate is what actually blocks
 * bad input (Q6-style runtime defense, matching `automation-scheduler.ts`'s `resolveCronTimeZone`).
 */
export function resolveDirectoryScheduleTimezone(raw: unknown): string {
  if (isDirectoryScheduleDefaultTimezone(raw)) return DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE
  const tz = normalizeRawText(raw)
  return isValidIanaTimeZone(tz) ? tz : DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE
}
