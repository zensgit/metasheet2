import type { Kysely, RawBuilder } from 'kysely'
import { sql } from 'kysely'

import { checkTableExists } from './_patterns'

/**
 * Owner ruling 2026-10-12 (decision register R-39; ADR adr-stock-prep-project-sheets-20261008 §8
 * step 3, §11.2-1, §11.3): the built-in floor role `stock-prep_frontline` and the demo server's
 * legacy floor role `stock-prep-operator` are merged at the R66 deploy (R65 = 6d4e9fc38 shipped
 * without this merge, owner: 「R65 = main 原样，不等其他」), and the built-in role's
 * display name becomes 「操作人员」 (was 「一线填写」, seeded by
 * zzzz20261010124500_seed_stock_prep_role_templates — that migration already ran at R64 and is not
 * edited). The role ID stays `stock-prep_frontline`: G1, the members page and the move script
 * address the id, never the name.
 *
 * COMPARE-AND-SET. `up()` renames only a role whose id is `stock-prep_frontline` AND whose display
 * name is still exactly the seeded 「一线填写」; `down()` is the mirror (「操作人员」 → 「一线填写」).
 * A role that was renamed by hand, created with the seed's `（内置）` clash suffix, or is absent is
 * left exactly as found (a missing role is a no-op, never created here).
 *
 * WHEN THE RENAME IS SKIPPED (logged, the upgrade carries on; the site renames by hand in 角色管理
 * once it has decided), because a display name is not inert:
 *   1. another role already carries the new name (compared after trimming) — two roles would show
 *      the same name in 角色管理 and in every appoint list;
 *   2. role-typed approval seats in ANY state, or role-targeted approval CC records, already name the
 *      new name — approval-instance read access matches a member's roles by id AND by trimmed
 *      display name (approval-instance-readability.ts `viewerRoles` / `canReadApprovalInstance`), so
 *      the role's members would silently GAIN read access to those instances;
 *   3. such seats or CC records name the OLD name while the role has members — those members would
 *      LOSE read access to them;
 *   4. approval templates whose visibility scope is role-typed (`visibility_scope.type = 'role'`)
 *      list the new name (members would GAIN the template — 记录送审 and the automation creator path
 *      match a user's roles by id AND trimmed display name, automation-approval-template-access.ts
 *      `loadApprovalTemplateReader` → ApprovalProductService visibility condition), or list the old
 *      name while the role has members (they would LOSE it);
 *   5. approval template versions or published definitions whose graph names the new name — or the
 *      old name while the role has members — in one of the five role-reference shapes the legacy
 *      move script's designer census reads (role approver / handler, empty-assignee fallback, role
 *      CC target, 提交人自选 role scope). A seat or CC record created from such a graph carries
 *      that entry as its key, and the read arm above matches it by display name, so future
 *      instances would start (or stop) being readable by the role's members;
 *   6. attendance: scheduler scopes (`attendance_scheduler_scopes`: a `role` / `role_tag`
 *      subject, or a `roles` / `roleTags` target list in `scope`) and the attendance settings
 *      (`system_configs` key `attendance.settings`: any `roles` / `role` / `position` /
 *      `jobTitle` / `roleTags` / `role_tags` / `tags` entry at any depth — holiday and calendar
 *      overrides) naming the new name, or the old name while the role has members. The attendance
 *      plugin puts each of a user's role ids AND display names into both its role and role-tag
 *      context (plugin-attendance `loadAttendanceScopeContextForUser`), so those scopes would
 *      grant or drop scheduler / export / approve authority, and those overrides would switch the
 *      members' work calendar. Compared trimmed and case-insensitively (the plugin's override
 *      matcher lower-cases; counting more is the safe side). Settings that do not parse as JSON
 *      count nothing — the plugin then runs on its defaults as well.
 * Checks 1 and the compare-and-set itself are ONE UPDATE statement — the only decision; a read
 * after it merely words the log line. 2–6 are counted just before it in the same migration
 * transaction.
 *
 * VALUES-FREE LOG: the role id (this file's literal), the direction, counts. Never a member, never a
 * display name read from the database.
 */

export const STOCK_PREP_FRONTLINE_ROLE_ID = 'stock-prep_frontline'
/** The display name zzzz20261010124500 seeded. */
export const STOCK_PREP_FRONTLINE_SEEDED_NAME = '一线填写'
/** The display name the owner ruled on 2026-10-12. */
export const STOCK_PREP_FRONTLINE_NAME = '操作人员'

const MIGRATION = 'zzzz20261012090000_rename_stock_prep_frontline_display_name'

function log(message: string): void {
  console.log(`[${MIGRATION}] ${message}`)
}

async function countRows(db: Kysely<unknown>, table: string, query: RawBuilder<{ count: number }>): Promise<number> {
  if (!(await checkTableExists(db, table))) return 0
  const result = await query.execute(db)
  return Number(result.rows[0]?.count ?? 0)
}

/** Role-typed approval seats (any state) naming `name` — the read arm matches the exact key. */
function approvalSeatsNaming(name: string) {
  return sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM approval_assignments
     WHERE assignment_type = 'role'
       AND assignee_id = ${name}
  `
}

/** Role-targeted approval CC records naming `name`. */
function approvalCcRecordsNaming(name: string) {
  return sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM approval_records
     WHERE action = 'cc'
       AND metadata->>'targetType' = 'role'
       AND metadata->>'targetId' = ${name}
  `
}

/** Approval templates whose role-typed visibility scope lists `name` (the visibility arm compares the exact list entry). */
function approvalTemplatesVisibleTo(name: string) {
  return sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM approval_templates t
     WHERE t.visibility_scope->>'type' = 'role'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS visible(id)
          WHERE visible.id = ${name}
       )
  `
}

// The five role-reference shapes of an approval graph — the same jsonpath set as the legacy move
// script's designer census (scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs
// GRAPH_NAMES_ROLE), with the key bound as the jsonpath variable `$k`.
function graphNamesRole(column: 'v.approval_graph' | 'd.runtime_graph', name: string) {
  const graph = sql.raw(column)
  const vars = sql`jsonb_build_object('k', ${name}::text)`
  return sql`(
       jsonb_path_exists(${graph}, '$.nodes[*].config ? (@.assigneeType == "role").assigneeIds[*] ? (@ == $k)', ${vars})
    OR jsonb_path_exists(${graph}, '$.nodes[*].config.assigneeSources[*] ? (@.kind == "static_role").roleIds[*] ? (@ == $k)', ${vars})
    OR jsonb_path_exists(${graph}, '$.nodes[*].config.emptyAssigneeFallback.roleIds[*] ? (@ == $k)', ${vars})
    OR jsonb_path_exists(${graph}, '$.nodes[*].config ? (@.targetType == "role").targetIds[*] ? (@ == $k)', ${vars})
    OR jsonb_path_exists(${graph}, '$.nodes[*].config.assigneeSources[*] ? (@.kind == "requester_choice").scope ? (@.type == "role").roleIds[*] ? (@ == $k)', ${vars})
  )`
}

/** Approval template versions whose graph names `name` as a role reference. */
function approvalTemplateVersionsNaming(name: string) {
  return sql<{ count: number }>`
    SELECT count(*)::int AS count FROM approval_template_versions v WHERE ${graphNamesRole('v.approval_graph', name)}
  `
}

/** Approval published definitions (active or not) whose runtime graph names `name` as a role reference. */
function approvalPublishedDefinitionsNaming(name: string) {
  return sql<{ count: number }>`
    SELECT count(*)::int AS count FROM approval_published_definitions d WHERE ${graphNamesRole('d.runtime_graph', name)}
  `
}

/** A jsonb array's elements compared trimmed and case-insensitively to `name`; a non-array is empty. */
function jsonbListNames(list: RawBuilder<unknown>, name: string) {
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${list}) = 'array' THEN ${list} ELSE '[]'::jsonb END) AS entry(value)
     WHERE lower(btrim(entry.value)) = lower(btrim(${name}::text))
  )`
}

/** Attendance scheduler scopes (active or not) naming `name` as a role / role-tag subject or target. */
function attendanceSchedulerScopesNaming(name: string) {
  return sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM attendance_scheduler_scopes s
     WHERE (s.subject_type IN ('role', 'role_tag') AND lower(btrim(s.subject_ref)) = lower(btrim(${name}::text)))
        OR ${jsonbListNames(sql`s.scope->'roles'`, name)}
        OR ${jsonbListNames(sql`s.scope->'roleTags'`, name)}
  `
}

/** The attendance plugin's settings key (plugin-attendance SETTINGS_KEY). */
const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'
/** Every key the attendance plugin reads a role / role-tag filter from (holiday overrides read the aliases). */
const ATTENDANCE_ROLE_FILTER_KEYS = new Set(['roles', 'role', 'position', 'jobTitle', 'roleTags', 'role_tags', 'tags'])

/** Role-filter entries naming `name` anywhere in a parsed attendance settings value (plugin ensureStringArray shape). */
export function countAttendanceSettingsRoleEntries(settings: unknown, name: string): number {
  const key = name.trim().toLowerCase()
  let count = 0
  const entries = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((item) => String(item))
    if (typeof value === 'string') return value.split(',')
    return []
  }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [field, value] of Object.entries(node as Record<string, unknown>)) {
      if (ATTENDANCE_ROLE_FILTER_KEYS.has(field)) {
        count += entries(value).filter((entry) => entry.trim().toLowerCase() === key).length
      }
      walk(value)
    }
  }
  walk(settings)
  return count
}

async function attendanceSettingsNaming(db: Kysely<unknown>, name: string): Promise<number> {
  if (!(await checkTableExists(db, 'system_configs'))) return 0
  const rows = (await sql<{ value: string | null }>`
    SELECT value FROM system_configs WHERE key = ${ATTENDANCE_SETTINGS_KEY}
  `.execute(db)).rows
  let count = 0
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(row.value ?? ''))
    } catch {
      continue
    }
    count += countAttendanceSettingsRoleEntries(parsed, name)
  }
  return count
}

export async function renameFrontlineDisplayName(
  db: Kysely<unknown>,
  from: string,
  to: string,
  direction: 'up' | 'down',
): Promise<'renamed' | 'absent' | 'not-seeded-name' | 'name-taken' | 'approval-keys' | 'attendance-keys'> {
  if (!(await checkTableExists(db, 'roles'))) {
    log(`${direction}: no roles table; nothing to rename`)
    return 'absent'
  }
  const present = await sql<{ id: string }>`
    SELECT id FROM roles WHERE id = ${STOCK_PREP_FRONTLINE_ROLE_ID}
  `.execute(db)
  if (present.rows.length === 0) {
    log(`${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} absent; nothing to rename`)
    return 'absent'
  }

  const seatsTo = await countRows(db, 'approval_assignments', approvalSeatsNaming(to))
  const ccTo = await countRows(db, 'approval_records', approvalCcRecordsNaming(to))
  const members = Number((await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM user_roles WHERE role_id = ${STOCK_PREP_FRONTLINE_ROLE_ID}
  `.execute(db)).rows[0]?.count ?? 0)
  const seatsFrom = members > 0 ? await countRows(db, 'approval_assignments', approvalSeatsNaming(from)) : 0
  const ccFrom = members > 0 ? await countRows(db, 'approval_records', approvalCcRecordsNaming(from)) : 0
  const templatesTo = await countRows(db, 'approval_templates', approvalTemplatesVisibleTo(to))
  const templatesFrom = members > 0 ? await countRows(db, 'approval_templates', approvalTemplatesVisibleTo(from)) : 0
  const graphsTo = await countRows(db, 'approval_template_versions', approvalTemplateVersionsNaming(to))
    + await countRows(db, 'approval_published_definitions', approvalPublishedDefinitionsNaming(to))
  const graphsFrom = members > 0
    ? await countRows(db, 'approval_template_versions', approvalTemplateVersionsNaming(from))
      + await countRows(db, 'approval_published_definitions', approvalPublishedDefinitionsNaming(from))
    : 0
  if (seatsTo + ccTo + templatesTo + graphsTo > 0 || seatsFrom + ccFrom + templatesFrom + graphsFrom > 0) {
    log(
      `${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} NOT renamed — approval read access, template visibility and approval graphs match roles by display name: `
      + `${seatsTo} role-typed seat(s), ${ccTo} role-targeted CC record(s), ${templatesTo} role-scoped template visibility list(s) and ${graphsTo} template version / published definition graph(s) already name the new name (its ${members} member(s) would gain them); `
      + `${seatsFrom} seat(s), ${ccFrom} CC record(s), ${templatesFrom} template visibility list(s) and ${graphsFrom} graph(s) name the current name while it has members (they would lose them); `
      + 'left as found — rename it by hand in 角色管理 once the site has decided',
    )
    return 'approval-keys'
  }

  const attendanceTo = await countRows(db, 'attendance_scheduler_scopes', attendanceSchedulerScopesNaming(to))
    + await attendanceSettingsNaming(db, to)
  const attendanceFrom = members > 0
    ? await countRows(db, 'attendance_scheduler_scopes', attendanceSchedulerScopesNaming(from))
      + await attendanceSettingsNaming(db, from)
    : 0
  if (attendanceTo + attendanceFrom > 0) {
    log(
      `${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} NOT renamed — attendance matches users by role display name: `
      + `${attendanceTo} scheduler scope / settings role entr(ies) already name the new name (its ${members} member(s) would gain them); `
      + `${attendanceFrom} name the current name while it has members (they would lose them); `
      + 'left as found — rename it by hand in 角色管理 once the site has decided',
    )
    return 'attendance-keys'
  }

  // The compare-and-set and the name-clash check in ONE statement. `updated_at` moves with the name:
  // it is the optimistic-concurrency token of PUT /api/roles/:id (routes/roles.ts compares the
  // client's `expectedUpdatedAt` with it and answers 409 ROLE_MODIFIED on a mismatch), so a 角色管理
  // tab loaded before the upgrade cannot save the old name back silently.
  const renamed = await sql<{ id: string }>`
    UPDATE roles
       SET name = ${to}, updated_at = now()
     WHERE id = ${STOCK_PREP_FRONTLINE_ROLE_ID}
       AND name = ${from}
       AND NOT EXISTS (
         SELECT 1 FROM roles other
          WHERE other.id <> ${STOCK_PREP_FRONTLINE_ROLE_ID}
            AND btrim(other.name) = ${to}
       )
    RETURNING id
  `.execute(db)
  if (renamed.rows.length === 0) {
    // Only to word the log line: the UPDATE above is the decision.
    const current = await sql<{ name: string | null }>`
      SELECT name FROM roles WHERE id = ${STOCK_PREP_FRONTLINE_ROLE_ID}
    `.execute(db)
    if (current.rows[0]?.name !== from) {
      log(`${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} does not carry the expected display name; left as found`)
      return 'not-seeded-name'
    }
    log(`${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} NOT renamed — another role already carries the new display name; left as found`)
    return 'name-taken'
  }
  log(`${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} display name updated (${renamed.rows.length} row)`)
  return 'renamed'
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await renameFrontlineDisplayName(db, STOCK_PREP_FRONTLINE_SEEDED_NAME, STOCK_PREP_FRONTLINE_NAME, 'up')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await renameFrontlineDisplayName(db, STOCK_PREP_FRONTLINE_NAME, STOCK_PREP_FRONTLINE_SEEDED_NAME, 'down')
}
