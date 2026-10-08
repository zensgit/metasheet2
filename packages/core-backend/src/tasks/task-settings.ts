/**
 * Task feature — per-user task settings (`task_user_settings`, §13-7): `badge_scope` parsing, the
 * badge-scope → pending-scope bridge, and a whole-patch validator. PURE, no I/O.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-settings.ts`
 * Lock:   task-feature-design-lock-20260917.md §13-4 `:741` (`badge_scope` closed set, already-decided
 *         direction), §13-7 `:750` (`task_user_settings`, suggested)
 *
 * Each `ASSUMPTION(task-d)` comment below names the ruling item it implements. The owner ruled the
 * R and N items on 2026-10-07 (values and R12's narrowed form: PR-3a design §11).
 */
import { validateViewerTimeZoneHeader } from './task-dates'
import { parseRemindPolicy, type TaskRemindPolicy } from './task-reminders'
import type { TaskPendingScope } from './task-access'

// ── badge_scope (lock §13-4 `:741`, already-decided direction) ───────────────────────────────────

export const TASK_BADGE_SCOPES = ['off', 'overdue', 'overdue_or_today'] as const
export type TaskBadgeScope = (typeof TASK_BADGE_SCOPES)[number]

/** Default when a user has no `task_user_settings` row at all (lock §13-4). */
export const TASK_DEFAULT_BADGE_SCOPE: TaskBadgeScope = 'overdue'

export type ParseBadgeScopeReason = 'invalid_badge_scope'
export type ParseBadgeScopeResult = { ok: true; scope: TaskBadgeScope } | { ok: false; reason: ParseBadgeScopeReason }

/** Missing row/value ⇒ `overdue` (the default). Any non-matching value ⇒ 422 `invalid_badge_scope`. */
export function parseBadgeScope(raw: unknown): ParseBadgeScopeResult {
  if (raw === null || raw === undefined) {
    return { ok: true, scope: TASK_DEFAULT_BADGE_SCOPE }
  }
  if (typeof raw === 'string' && (TASK_BADGE_SCOPES as readonly string[]).includes(raw)) {
    return { ok: true, scope: raw as TaskBadgeScope }
  }
  return { ok: false, reason: 'invalid_badge_scope' }
}

// ASSUMPTION(task-d): [D5] `badge_scope === 'off'` ⇒ `null`, and the CALLER short-circuits
// (`/pending-count` returns `{count:0, badgeScope:'off'}` without querying `task_assignees`/`tasks`
// at all — D5 requires that no query is sent).
/**
 * `'overdue'`/`'overdue_or_today'` map 1:1 onto `task-access.ts`'s `TaskPendingScope` (they are
 * literal string supersets of each other's values, by design — badge scope is a SUBSET of pending
 * scope, `'all_open'` is pending-only and never a badge value, §13-4).
 */
export function pendingScopeForBadge(scope: TaskBadgeScope): TaskPendingScope | null {
  if (scope === 'off') return null
  if (scope === 'overdue' || scope === 'overdue_or_today') return scope
  throw new TypeError(`pendingScopeForBadge: unknown scope "${String(scope)}"`)
}

// ASSUMPTION(task-d): [R02] `badgeScope`/`dailyReminderEnabled`/`defaultRemindPolicy` (and the
// `task_user_settings` table itself) take R02's value; the owner ruled R02 on 2026-10-07 (the lock
// lists the table itself as a suggestion, `:750`).
// ASSUMPTION(task-d): [R07] `timeZone` belongs to R07, not R02: the column exists only because
// `task-reminders.ts`'s daily digest needs the recipient's own zone,
// not because of anything in R02's `default_remind_policy`/`badge_scope` shape. The DDL CHECK
// `daily_reminder_enabled=false OR time_zone IS NOT NULL` is R07's, enforced here at the
// application layer (`daily_reminder_requires_time_zone` below).
// ── Whole-settings-row patch (R02 + R07) ──────────────────────────────────────────────────────

export interface TaskUserSettings {
  badgeScope: TaskBadgeScope
  dailyReminderEnabled: boolean
  defaultRemindPolicy: TaskRemindPolicy
  /** R07 (not R02 — see the ASSUMPTION note above the interface). Regular (canonical) IANA name,
   * or `null`. */
  timeZone: string | null
}

export interface TaskUserSettingsPatch {
  badgeScope?: unknown
  dailyReminderEnabled?: unknown
  defaultRemindPolicy?: unknown
  timeZone?: unknown
}

export type TaskUserSettingsPatchReason =
  | 'invalid_badge_scope'
  | 'invalid_daily_reminder_enabled'
  | 'invalid_policy'
  | 'invalid_time_zone'
  | 'daily_reminder_requires_time_zone'

export type ParseSettingsPatchResult =
  | { ok: true; settings: TaskUserSettings }
  | { ok: false; reason: TaskUserSettingsPatchReason }

// ASSUMPTION(task-d): [R07] the CHECK constraint `daily_reminder_enabled = false OR time_zone IS
// NOT NULL` is enforced here at the application layer as `daily_reminder_requires_time_zone` — this
// is checked against the MERGED result (current row + this patch applied), not just the fields the
// caller happened to touch, so e.g. flipping `dailyReminderEnabled` to `true` on a row whose
// `timeZone` is still `null` from an EARLIER write is rejected even though this patch itself never
// mentions `timeZone`. Only `undefined` means "not present in the patch, keep current value" — an
// explicit `timeZone: null` in the patch clears the zone (and will trip the CHECK if
// `dailyReminderEnabled` ends up `true`).
// ASSUMPTION(task-d): [D7] `timeZone` is normalized via `task-dates.ts`'s
// `validateViewerTimeZoneHeader` so a WRITTEN zone is normalized THE SAME WAY a READ viewer-tz
// header is: only the normalized name is ever written.
/**
 * Merges `patch` onto `current` field-by-field (each field validated independently — closed sets
 * via `parseBadgeScope`/`parseRemindPolicy`), then enforces the daily-reminder-needs-a-zone
 * invariant on the MERGED result.
 */
export function parseSettingsPatch(patch: TaskUserSettingsPatch, current: TaskUserSettings): ParseSettingsPatchResult {
  // ASSUMPTION(task-d, own choice — not ruling-derived, fixing a real bug found in independent
  // review): `parseBadgeScope`/`parseRemindPolicy` treat a `null` VALUE as "missing, use default" —
  // that reading is correct for a ROW being read back (a `NULL` column really does mean "no value
  // was ever set, fall back"), but it is WRONG for a PATCH: a PATCH's only "leave it alone" spelling
  // is an ABSENT key (`undefined`, handled by the `!== undefined` checks below); an explicit `null`
  // in a patch body is a malformed request (there is no "reset this field to its default via PATCH"
  // semantics defined anywhere in this module) and must 422, not silently reset the field. This is
  // deliberately narrower than `timeZone`'s explicit `null` handling a few lines down, which DOES
  // have defined PATCH semantics ("clear the zone") — `badgeScope`/`defaultRemindPolicy` have no
  // such "clear" concept (a badge scope or remind policy is never simply "absent" on a live row).
  let badgeScope = current.badgeScope
  if (patch.badgeScope !== undefined) {
    if (patch.badgeScope === null) return { ok: false, reason: 'invalid_badge_scope' }
    const parsed = parseBadgeScope(patch.badgeScope)
    if (!parsed.ok) return { ok: false, reason: 'invalid_badge_scope' }
    badgeScope = parsed.scope
  }

  let dailyReminderEnabled = current.dailyReminderEnabled
  if (patch.dailyReminderEnabled !== undefined) {
    if (typeof patch.dailyReminderEnabled !== 'boolean') {
      return { ok: false, reason: 'invalid_daily_reminder_enabled' }
    }
    dailyReminderEnabled = patch.dailyReminderEnabled
  }

  let defaultRemindPolicy = current.defaultRemindPolicy
  if (patch.defaultRemindPolicy !== undefined) {
    if (patch.defaultRemindPolicy === null) return { ok: false, reason: 'invalid_policy' }
    const parsed = parseRemindPolicy(patch.defaultRemindPolicy)
    if (!parsed.ok) return { ok: false, reason: 'invalid_policy' }
    defaultRemindPolicy = parsed.policy
  }

  let timeZone = current.timeZone
  if (patch.timeZone !== undefined) {
    if (patch.timeZone === null) {
      timeZone = null
    } else {
      const validated = validateViewerTimeZoneHeader(patch.timeZone)
      if (validated === null) return { ok: false, reason: 'invalid_time_zone' }
      timeZone = validated
    }
  }

  if (dailyReminderEnabled && timeZone === null) {
    return { ok: false, reason: 'daily_reminder_requires_time_zone' }
  }

  return { ok: true, settings: { badgeScope, dailyReminderEnabled, defaultRemindPolicy, timeZone } }
}
