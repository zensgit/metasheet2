import type { Kysely, RawBuilder } from 'kysely'
import { sql } from 'kysely'

import { checkTableExists } from './_patterns'

/**
 * Owner ruling 2026-10-12 (decision register R-39; ADR adr-stock-prep-project-sheets-20261008 §8
 * step 3, §11.2-1, §11.3): the built-in floor role `stock-prep_frontline` and the demo server's
 * legacy floor role `stock-prep-operator` are merged at the R65 deploy, and the built-in role's
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
 *      LOSE read access to them.
 * Checks 1 and the compare-and-set itself are ONE UPDATE statement — the only decision; a read
 * after it merely words the log line. 2 and 3 are counted just before it in the same migration
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

export async function renameFrontlineDisplayName(
  db: Kysely<unknown>,
  from: string,
  to: string,
  direction: 'up' | 'down',
): Promise<'renamed' | 'absent' | 'not-seeded-name' | 'name-taken' | 'approval-keys'> {
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
  if (seatsTo + ccTo > 0 || seatsFrom + ccFrom > 0) {
    log(
      `${direction}: role ${STOCK_PREP_FRONTLINE_ROLE_ID} NOT renamed — approval read access matches roles by display name: `
      + `${seatsTo} role-typed seat(s) and ${ccTo} role-targeted CC record(s) already name the new name (its ${members} member(s) would gain read access); `
      + `${seatsFrom} seat(s) and ${ccFrom} CC record(s) name the current name while it has members (they would lose it); `
      + 'left as found — rename it by hand in 角色管理 once the site has decided',
    )
    return 'approval-keys'
  }

  // The compare-and-set and the name-clash check in ONE statement.
  const renamed = await sql<{ id: string }>`
    UPDATE roles
       SET name = ${to}
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
