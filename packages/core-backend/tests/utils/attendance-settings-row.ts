import type { Pool } from 'pg'

/**
 * Exact save-and-restore isolation for the ONE deployment-wide `system_configs` row
 * (key `attendance.settings`).
 *
 * Why this exists (W4 wave-verification finding, docs/development/
 * attendance-vnext-wave4-w40-w42-development-verification-20260722.md §7.5): `plugin-tests.yml`'s
 * attendance step runs MANY integration suites against ONE shared Postgres
 * (`vitest.integration.config.ts` pins `fileParallelism: false`, so files run serially in the same
 * DB). Eight suites write this row through `PUT /api/attendance/settings`; any test that fails —
 * or forgets — to put the row back poisons every later settings-sensitive assertion in the run
 * (proven leak: `attendance-plugin.test.ts` shiftCompliance state bleeding into
 * `attendance-schedule-dispatch.test.ts`, and the W4-0 readiness ④ posture reads this exact row).
 * Suites therefore snapshot the row ONCE in `beforeAll` and restore the EXACT prior state in
 * `afterEach`: upsert the original value back, or DELETE the row if it did not exist.
 *
 * Why `value::text` and not bare `value`: the `value` column is `JSONB` on databases built by
 * migration 038 but legacy `TEXT` on older bootstraps. On the JSONB schema node-pg auto-parses a
 * bare `value` into a JS object — `String(object)` is `'[object Object]'`, which can never be
 * `JSON.parse`d or written back verbatim. `value::text` is the one representation that reads AND
 * restores exactly on BOTH schemas (a jsonb column's `::text` is its canonical JSON text, and the
 * plain-string INSERT parameter is implicitly cast back to jsonb; on the TEXT schema both casts
 * are identity).
 */
export const ATTENDANCE_SETTINGS_CONFIG_KEY = 'attendance.settings'

/** `null` ⇔ the row did not exist at snapshot time (restore then DELETEs it). */
export type AttendanceSettingsRowSnapshot = { valueText: string } | null

export async function snapshotAttendanceSettingsRow(pool: Pool): Promise<AttendanceSettingsRowSnapshot> {
  const r = await pool.query<{ value_text: string }>(
    `SELECT value::text AS value_text FROM system_configs WHERE key = $1`,
    [ATTENDANCE_SETTINGS_CONFIG_KEY],
  )
  return r.rows[0] ? { valueText: r.rows[0].value_text } : null
}

/**
 * Restores the exact snapshot state. `undefined` (snapshot never taken, e.g. `beforeAll` threw
 * before reaching the snapshot) is a deliberate no-op so an `afterEach`/`afterAll` hook can call
 * this unconditionally without inventing state. Restore covers `value` (the only column the
 * attendance suites' write path — the plugin's `saveSettings` upsert — ever changes) plus
 * `updated_at`, matching that write path's own `SET value = …, updated_at = now()`.
 */
export async function restoreAttendanceSettingsRow(
  pool: Pool,
  snapshot: AttendanceSettingsRowSnapshot | undefined,
): Promise<void> {
  if (snapshot === undefined) return
  if (snapshot === null) {
    await pool.query(`DELETE FROM system_configs WHERE key = $1`, [ATTENDANCE_SETTINGS_CONFIG_KEY])
    return
  }
  await pool.query(
    `INSERT INTO system_configs (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ATTENDANCE_SETTINGS_CONFIG_KEY, snapshot.valueText],
  )
}
