/**
 * Per-user task settings (`task_user_settings`, keyed by user and org). Rules come from
 * `src/tasks/task-settings.ts`; this module only reads and writes the caller's own row.
 *
 * RULED(2026-10-07): [R02] the table and `GET/PATCH /api/task-settings`; [R07] the `timeZone`
 * field is stored only (nothing in this PR reads it for scheduling).
 *
 * Import note: `task-records.ts` imports `loadBadgeScope` from here and this module imports
 * `fail` from there. Neither module uses the other at top level, so the cycle is inert.
 */
import { query, transaction } from '../db/pg'
import {
  parseBadgeScope,
  parseSettingsPatch,
  toTaskUserSettings,
  type TaskBadgeScope,
  type TaskUserSettings,
  type TaskUserSettingsPatch,
  type TaskUserSettingsRow,
} from '../tasks/task-settings'
import type { TaskRemindPolicy } from '../tasks/task-reminders'
import { fail } from './task-records'

const SETTINGS_COLUMNS = 'badge_scope, daily_reminder_enabled, default_remind_policy, time_zone'

/** The caller's badge scope in this org; no row ⇒ the default ('overdue'). */
export async function loadBadgeScope(input: { orgId: string; actorId: string }): Promise<TaskBadgeScope> {
  const result = await query<{ badge_scope: unknown }>(
    'SELECT badge_scope FROM task_user_settings WHERE user_id = $1 AND org_id = $2',
    [input.actorId, input.orgId],
  )
  const parsed = parseBadgeScope(result.rows[0]?.badge_scope)
  if (!parsed.ok) throw new TypeError('loadBadgeScope: stored badge_scope is outside the closed set')
  return parsed.scope
}

/**
 * The user's `default_remind_policy` in this org, mapped through `toTaskUserSettings` (no row ⇒
 * `{ mode: 'default' }`). `db` is the caller's client, so a create that holds the org structure lock
 * reads it on the same transaction; this is a plain read of another table, not a new lock.
 */
export async function loadRemindPolicy(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  input: { orgId: string; actorId: string },
): Promise<TaskRemindPolicy> {
  const result = await db.query(
    `SELECT ${SETTINGS_COLUMNS} FROM task_user_settings WHERE user_id = $1 AND org_id = $2`,
    [input.actorId, input.orgId],
  )
  return toTaskUserSettings(result.rows[0] as TaskUserSettingsRow | undefined).defaultRemindPolicy
}

/** The caller's settings in this org; no row ⇒ the defaults. Never writes. */
export async function getTaskSettings(input: { orgId: string; actorId: string }): Promise<TaskUserSettings> {
  const result = await query<TaskUserSettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM task_user_settings WHERE user_id = $1 AND org_id = $2`,
    [input.actorId, input.orgId],
  )
  return toTaskUserSettings(result.rows[0])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sameSettings(left: TaskUserSettings, right: TaskUserSettings): boolean {
  return left.badgeScope === right.badgeScope
    && left.dailyReminderEnabled === right.dailyReminderEnabled
    && left.defaultRemindPolicy.mode === right.defaultRemindPolicy.mode
    && left.timeZone === right.timeZone
}

// ASSUMPTION(task-m4): [own-04] the settings write is the one M4 write that does not take the org
// structure lock: it touches only the caller's own row, so a row lock is enough. The placeholder
// insert plus `FOR UPDATE` serializes two concurrent PATCHes of one user, so neither overwrites a
// field the other set. A merge that changes nothing skips the UPDATE (`updated_at` unchanged).
/**
 * Merges `body` onto the caller's current settings (unknown keys ignored) and returns the merged
 * settings. 422 `INVALID_SETTINGS` when the body is not a plain object; otherwise the validator's
 * reason upper-cased. A 422 rolls the transaction back, so it leaves no row behind.
 */
export async function patchTaskSettings(input: {
  orgId: string
  actorId: string
  body: unknown
}): Promise<TaskUserSettings> {
  if (!isPlainObject(input.body)) fail(422, 'INVALID_SETTINGS')
  const body = input.body
  const patch: TaskUserSettingsPatch = {
    badgeScope: body.badgeScope,
    dailyReminderEnabled: body.dailyReminderEnabled,
    defaultRemindPolicy: body.defaultRemindPolicy,
    timeZone: body.timeZone,
  }
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await client.query(
      `INSERT INTO task_user_settings (user_id, org_id) VALUES ($1, $2)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [input.actorId, input.orgId],
    )
    const locked = await client.query(
      `SELECT ${SETTINGS_COLUMNS} FROM task_user_settings WHERE user_id = $1 AND org_id = $2 FOR UPDATE`,
      [input.actorId, input.orgId],
    )
    const current = toTaskUserSettings(locked.rows[0] as TaskUserSettingsRow)
    const merged = parseSettingsPatch(patch, current)
    if (merged.ok === false) fail(422, merged.reason.toUpperCase())
    const next = merged.settings
    if (!sameSettings(current, next)) {
      await client.query(
        `UPDATE task_user_settings
         SET badge_scope = $3, daily_reminder_enabled = $4, default_remind_policy = $5::jsonb,
             time_zone = $6, updated_at = now()
         WHERE user_id = $1 AND org_id = $2`,
        [
          input.actorId,
          input.orgId,
          next.badgeScope,
          next.dailyReminderEnabled,
          JSON.stringify(next.defaultRemindPolicy),
          next.timeZone,
        ],
      )
    }
    return next
  })
}
