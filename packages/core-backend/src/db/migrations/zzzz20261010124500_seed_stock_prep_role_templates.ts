import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { checkTableExists } from './_patterns'

/**
 * S5a of ADR adr-stock-prep-project-sheets-20261008 (§11.2, §11.3; decision register R-39) — seed the
 * four built-in 备料 role templates, ZERO members.
 *
 * WHY HERE AND NOT IN S0. The ADR first put this seed in S0 (`zzzz20261008120000`); S0 shipped the
 * `stock-prep:pull` catalogue row only. Between the two, R63 tells the demo-server operator to
 * create `stock-prep_puller` by hand right after the upgrade (the role editor refuses a code the
 * catalogue does not hold, so it could not be created earlier). This migration therefore has to
 * COEXIST with a role that already carries one of its ids — and with any other site role.
 *
 * THE COEXISTENCE RULES (an upgrade must not fail because of site data):
 *   1. ADOPT, NEVER MODIFY. A template whose id already exists in `roles` is left exactly as found:
 *      no rename, no code added or removed, no member touched. The adoption is logged by id, plus
 *      whether the adopted role's code set equals the template's (yes / no and two counts — never a
 *      code name, a member or a display name; the ids are this file's own literals).
 *   2. DISPLAY-NAME CLASH → SUFFIX. If a DIFFERENT role (another id) already uses the template's
 *      display name (compared after trimming), the template is created under the name suffixed
 *      `（内置）`. A name clash never skips a template: G1
 *      (`MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`) and the S5b members page address
 *      these four ids, so each id should exist after the upgrade. The other role is not touched.
 *   3. A template this migration CREATES gets exactly its template codes and no member, and its id is
 *      recorded in `stock_prep_role_template_seeds`. That ledger is how `down()` tells a role it
 *      created from a role it adopted; the e-learning precedent
 *      (`zzzz20260826140000_add_elearning_role_templates.ts`) has an inert `down()` and needed no
 *      ledger, but it also fails the upgrade on any id conflict, which this migration must not do.
 *   4. ORPHAN ROWS → SKIP (the one case where a template id stays absent). On a database built by the
 *      Kysely migration set, `user_roles.role_id` and `role_permissions.role_id` carry NO foreign key
 *      to `roles` (033_create_rbac_core is a superseded no-op, `migration-provider.ts`), and
 *      `DELETE /api/roles/:id` deletes only the `roles` row. So a template id that someone created
 *      by hand, gave members or codes, and then deleted can still have `user_roles` /
 *      `role_permissions` rows with no `roles` row. Permission resolution joins `user_roles` →
 *      `role_permissions` without `roles` (`rbac/service.ts`), so creating the role and binding its
 *      codes would silently hand those leftover members the template's codes (for `stock-prep_admin`:
 *      `stock-prep:admin`). Before creating a template whose id is absent from `roles`, the leftover
 *      rows in BOTH tables are counted; if either count is non-zero the template is skipped entirely
 *      (no role row, no code bound, not in the ledger), one line with the id and the two counts is
 *      logged, and the upgrade carries on. The leftover rows are neither deleted nor changed: who
 *      they belong to is the site's call (they are invisible in 角色管理, which lists `roles` rows).
 *      Once they are dealt with, the role can be created by hand under the same id.
 *   5. LEFTOVER GRANT ROWS → LOG ONLY. Rows in the role-subject grant tables (ROLE_SUBJECT_GRANT_TABLES)
 *      that already name a template id this migration then CREATES are left as found and do not
 *      skip the template (no behaviour change); one line with the id and per-table counts is logged
 *      so the site can review them before assigning anyone the role.
 *
 * THE IDS ARE LITERALS (ADR §11.2-2). `buildPluginRoleId` would turn `stock-prep` into
 * `stock_prep_<kind>`, which matches neither `roleIdMatchesNamespace('stock-prep', …)` (delegated
 * assignment) nor the G1 grant pattern. Exactly ONE id ends with `_admin` (ADR §11.2-3):
 * `deriveDelegatedAdminNamespace` reads only that suffix, so `stock-prep_data_admin` would make its
 * holders delegated admins of a namespace `stock-prep_data`. `assertStockPrepRoleTemplateShape`
 * re-checks all of this before any statement runs.
 *
 * THE CODES. `stock-prep_admin` holds `stock-prep:admin` alone (the plugin ladder short-circuits it
 * into pull / operate / read). `stock-prep_developer` holds `stock-prep:read` alone: its table-level
 * `spreadsheet:write` comes from G1 / table grants, never from a global `multitable:*` code, because
 * a global multitable code has no tenant boundary (ADR §11.3). No platform code appears here.
 *
 * R-11 「零持有者」 still holds: nothing here writes `user_roles`.
 *
 * ROLLBACK. `down()` acts only on ids in the ledger that are also template ids. It refuses (throws)
 * while any of them has a member or is the subject of a role-subject grant row (a deleted role id
 * whose grant rows stay behind would hand those grants to whoever later re-creates the id); otherwise
 * it deletes their `role_permissions` rows and `roles` rows and drops the ledger. Adopted roles are
 * never touched in either direction.
 */

export type StockPrepRoleTemplate = {
  readonly id: string
  readonly name: string
  readonly permissions: readonly string[]
}

export const STOCK_PREP_ROLE_NAMESPACE = 'stock-prep'
export const STOCK_PREP_DELEGATED_ADMIN_ROLE_ID = 'stock-prep_admin'
export const STOCK_PREP_ROLE_TEMPLATE_NAME_CLASH_SUFFIX = '（内置）'
export const STOCK_PREP_ROLE_TEMPLATE_LEDGER = 'stock_prep_role_template_seeds'

/** The only codes a template may carry: the four `stock-prep` codes (0830 seed + S0). */
export const STOCK_PREP_ROLE_TEMPLATE_ALLOWED_CODES: readonly string[] = Object.freeze([
  'stock-prep:read',
  'stock-prep:operate',
  'stock-prep:pull',
  'stock-prep:admin',
])

export const STOCK_PREP_ROLE_TEMPLATES: readonly StockPrepRoleTemplate[] = Object.freeze([
  Object.freeze({
    id: 'stock-prep_admin',
    name: '备料主管理员',
    permissions: Object.freeze(['stock-prep:admin']),
  }),
  Object.freeze({
    id: 'stock-prep_puller',
    name: '数据管理员（拉取人员）',
    permissions: Object.freeze(['stock-prep:pull', 'stock-prep:operate', 'stock-prep:read']),
  }),
  Object.freeze({
    id: 'stock-prep_developer',
    name: '开发成员',
    permissions: Object.freeze(['stock-prep:read']),
  }),
  Object.freeze({
    id: 'stock-prep_frontline',
    name: '一线填写',
    permissions: Object.freeze(['stock-prep:read', 'stock-prep:operate']),
  }),
])

export const STOCK_PREP_ROLE_TEMPLATE_IDS: readonly string[] = Object.freeze(
  STOCK_PREP_ROLE_TEMPLATES.map((template) => template.id),
)

export const STOCK_PREP_ROLE_TEMPLATE_DOWN_ASSIGNED =
  'cannot remove stock-prep role templates created by this migration while they have members'
export const STOCK_PREP_ROLE_TEMPLATE_DOWN_GRANTED =
  'cannot remove stock-prep role templates created by this migration while they are the subject of grant rows'

/** Same anchored shape the G1 grant port accepts (stock-preparation-project-sheet-grant-contract.ts). */
const ROLE_ID_SHAPE = /^stock-prep(?:_[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$/

/**
 * Tables whose rows grant something to a `role` subject. A role created here may have been granted
 * project sheets by G1 (spreadsheet_permissions) or anything else by an operator since; down()
 * refuses rather than leave those rows pointing at a deleted id.
 */
const ROLE_SUBJECT_GRANT_TABLES = Object.freeze([
  'spreadsheet_permissions',
  'meta_view_permissions',
  'field_permissions',
  'record_permissions',
  'meta_history_audit_grants',
])

/** Throws unless the template list has the shape ADR §11.2 requires. Pure; exported for the tests. */
export function assertStockPrepRoleTemplateShape(templates: readonly StockPrepRoleTemplate[]): void {
  const ids = new Set<string>()
  const adminSuffixed: string[] = []
  for (const template of templates) {
    if (!ROLE_ID_SHAPE.test(template.id)) {
      throw new Error(`stock-prep role template id has the wrong shape: ${template.id}`)
    }
    if (!(template.id === STOCK_PREP_ROLE_NAMESPACE || template.id.startsWith(`${STOCK_PREP_ROLE_NAMESPACE}_`))) {
      throw new Error(`stock-prep role template id is outside the namespace: ${template.id}`)
    }
    if (ids.has(template.id)) throw new Error(`stock-prep role template id is duplicated: ${template.id}`)
    ids.add(template.id)
    if (template.id.endsWith('_admin')) adminSuffixed.push(template.id)
    if (typeof template.name !== 'string' || template.name.trim().length === 0) {
      throw new Error(`stock-prep role template has no display name: ${template.id}`)
    }
    if (template.permissions.length === 0) {
      throw new Error(`stock-prep role template has no permission code: ${template.id}`)
    }
    if (new Set(template.permissions).size !== template.permissions.length) {
      throw new Error(`stock-prep role template repeats a permission code: ${template.id}`)
    }
    for (const code of template.permissions) {
      if (!STOCK_PREP_ROLE_TEMPLATE_ALLOWED_CODES.includes(code)) {
        throw new Error(`stock-prep role template carries a code outside stock-prep: ${template.id}`)
      }
    }
  }
  if (adminSuffixed.length !== 1 || adminSuffixed[0] !== STOCK_PREP_DELEGATED_ADMIN_ROLE_ID) {
    throw new Error('only stock-prep_admin may end with _admin')
  }
}

function log(message: string): void {
  console.log(`[zzzz20261010124500_seed_stock_prep_role_templates] ${message}`)
}

async function requireRbacTables(db: Kysely<unknown>): Promise<void> {
  for (const table of ['roles', 'permissions', 'role_permissions', 'user_roles']) {
    if (!(await checkTableExists(db, table))) {
      throw new Error('stock-prep role templates require the RBAC tables')
    }
  }
}

async function requireCatalogueCodes(db: Kysely<unknown>): Promise<void> {
  const codes = Array.from(new Set(STOCK_PREP_ROLE_TEMPLATES.flatMap((template) => template.permissions)))
  const present = await sql<{ code: string }>`
    SELECT code
      FROM permissions
     WHERE code IN (${sql.join(codes.map((code) => sql`${code}`))})
  `.execute(db)
  if (present.rows.length !== codes.length) {
    throw new Error('stock-prep role templates require every stock-prep permission code in the catalogue')
  }
}

async function ensureLedger(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS stock_prep_role_template_seeds (
      role_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
}

async function roleExists(db: Kysely<unknown>, roleId: string): Promise<boolean> {
  const found = await sql<{ present: number }>`
    SELECT 1 AS present
      FROM roles
     WHERE id = ${roleId}
  `.execute(db)
  return found.rows.length > 0
}

/**
 * Rows that already reference a role id with no `roles` row (rule 4). Both tables are counted: a
 * leftover member would gain the codes this migration binds, and a leftover code would reach whoever
 * is later assigned the role this migration would have created.
 */
async function countOrphanRows(db: Kysely<unknown>, roleId: string): Promise<{ members: number; codes: number }> {
  const counted = await sql<{ members: number; codes: number }>`
    SELECT (SELECT count(*)::int FROM user_roles WHERE role_id = ${roleId}) AS members,
           (SELECT count(*)::int FROM role_permissions WHERE role_id = ${roleId}) AS codes
  `.execute(db)
  const row = counted.rows[0]
  return { members: Number(row?.members ?? 0), codes: Number(row?.codes ?? 0) }
}

/** Rule 1's log line: the id, and whether the adopted role's codes equal the template's (counts only). */
async function logAdoption(db: Kysely<unknown>, template: StockPrepRoleTemplate): Promise<void> {
  const held = await sql<{ permission_code: string }>`
    SELECT permission_code
      FROM role_permissions
     WHERE role_id = ${template.id}
  `.execute(db)
  const heldCodes = new Set(held.rows.map((row) => row.permission_code))
  const missing = template.permissions.filter((code) => !heldCodes.has(code)).length
  const extra = [...heldCodes].filter((code) => !template.permissions.includes(code)).length
  const equal = missing === 0 && extra === 0
  log(
    `role ${template.id} already exists; adopted unchanged (no rename, no code change, no member change); `
    + `code set equals the template: ${equal ? 'yes' : 'no'} (template codes missing: ${missing}, extra codes: ${extra})`,
  )
}

/** Rule 5's log line: role-subject grant rows already naming a just-created id (counts only). */
async function logLeftoverGrantRows(db: Kysely<unknown>, roleId: string): Promise<void> {
  const counts: string[] = []
  for (const table of ROLE_SUBJECT_GRANT_TABLES) {
    if (!(await checkTableExists(db, table))) continue
    const counted = await sql<{ count: number }>`
      SELECT count(*)::int AS count
        FROM ${sql.table(table)}
       WHERE subject_type = 'role'
         AND subject_id = ${roleId}
    `.execute(db)
    const rows = Number(counted.rows[0]?.count ?? 0)
    if (rows > 0) counts.push(`${table}: ${rows}`)
  }
  if (counts.length === 0) return
  log(
    `role ${roleId} created, but role-subject grant row(s) already name this id (left behind by a deleted role; `
    + `left as found, and they apply to whoever is given the role) — ${counts.join(', ')}; review them before assigning anyone`,
  )
}

async function displayNameTakenByAnotherRole(db: Kysely<unknown>, template: StockPrepRoleTemplate): Promise<boolean> {
  const clash = await sql<{ taken: number }>`
    SELECT 1 AS taken
      FROM roles
     WHERE id <> ${template.id}
       AND btrim(name) = ${template.name}
     LIMIT 1
  `.execute(db)
  return clash.rows.length > 0
}

export async function up(db: Kysely<unknown>): Promise<void> {
  assertStockPrepRoleTemplateShape(STOCK_PREP_ROLE_TEMPLATES)
  await requireRbacTables(db)
  await requireCatalogueCodes(db)
  await ensureLedger(db)

  for (const template of STOCK_PREP_ROLE_TEMPLATES) {
    if (await roleExists(db, template.id)) {
      // Rule 1: the role already exists (e.g. created by hand at R63). Left exactly as found.
      await logAdoption(db, template)
      continue
    }

    // Rule 4: rows left behind by a deleted role under this id → skip the template, touch nothing.
    const orphans = await countOrphanRows(db, template.id)
    if (orphans.members > 0 || orphans.codes > 0) {
      log(
        `role ${template.id} NOT created: ${orphans.members} user_roles row(s) and ${orphans.codes} role_permissions row(s) `
        + 'already reference this id with no roles row (left behind by a deleted role); creating it would hand them '
        + 'the template codes, so it is skipped and those rows are left as found for the site to resolve; the role can then be created by hand under this id',
      )
      continue
    }

    const nameTaken = await displayNameTakenByAnotherRole(db, template)
    const name = nameTaken ? `${template.name}${STOCK_PREP_ROLE_TEMPLATE_NAME_CLASH_SUFFIX}` : template.name

    const created = await sql<{ id: string }>`
      INSERT INTO roles (id, name)
      VALUES (${template.id}, ${name})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `.execute(db)

    if (created.rows.length === 0) {
      // Created concurrently between the existence read and this insert: rule 1 again.
      await logAdoption(db, template)
      continue
    }

    for (const permissionCode of template.permissions) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_code)
        VALUES (${template.id}, ${permissionCode})
        ON CONFLICT (role_id, permission_code) DO NOTHING
      `.execute(db)
    }
    await sql`
      INSERT INTO stock_prep_role_template_seeds (role_id)
      VALUES (${template.id})
      ON CONFLICT (role_id) DO NOTHING
    `.execute(db)
    log(
      nameTaken
        ? `role ${template.id} created with ${template.permissions.length} code(s); its display name was already used by another role, so it carries the ${STOCK_PREP_ROLE_TEMPLATE_NAME_CLASH_SUFFIX} suffix`
        : `role ${template.id} created with ${template.permissions.length} code(s)`,
    )
    await logLeftoverGrantRows(db, template.id)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, STOCK_PREP_ROLE_TEMPLATE_LEDGER))) return

  const recorded = await sql<{ role_id: string }>`
    SELECT role_id
      FROM stock_prep_role_template_seeds
     ORDER BY role_id
  `.execute(db)
  // Only ids this migration both recorded AND defines; anything else in the ledger is not ours.
  const createdIds = recorded.rows
    .map((row) => row.role_id)
    .filter((id) => STOCK_PREP_ROLE_TEMPLATE_IDS.includes(id))

  if (createdIds.length > 0) {
    const idList = sql.join(createdIds.map((id) => sql`${id}`))
    const assigned = await sql<{ assigned: boolean }>`
      SELECT EXISTS (
        SELECT 1
          FROM user_roles
         WHERE role_id IN (${idList})
      ) AS assigned
    `.execute(db)
    if (assigned.rows[0]?.assigned === true) {
      throw new Error(STOCK_PREP_ROLE_TEMPLATE_DOWN_ASSIGNED)
    }

    for (const table of ROLE_SUBJECT_GRANT_TABLES) {
      if (!(await checkTableExists(db, table))) continue
      const granted = await sql<{ granted: boolean }>`
        SELECT EXISTS (
          SELECT 1
            FROM ${sql.table(table)}
           WHERE subject_type = 'role'
             AND subject_id IN (${idList})
        ) AS granted
      `.execute(db)
      if (granted.rows[0]?.granted === true) {
        throw new Error(STOCK_PREP_ROLE_TEMPLATE_DOWN_GRANTED)
      }
    }

    await sql`
      DELETE FROM role_permissions
       WHERE role_id IN (${idList})
    `.execute(db)
    await sql`
      DELETE FROM roles
       WHERE id IN (${idList})
    `.execute(db)
  }

  await sql`DROP TABLE IF EXISTS stock_prep_role_template_seeds`.execute(db)
}
