#!/usr/bin/env node
/**
 * stock-preparation-migrate-legacy-operator-role.mjs — move the demo server's legacy floor role
 * `stock-prep-operator` (hyphen) onto the built-in `stock-prep_frontline` (ADR
 * adr-stock-prep-project-sheets-20261008 §11.2-1, §8 step 3; decision register R-39).
 *
 * WHY. The legacy id does not match `stock-prep_…`, so a `stock-prep_admin` (the delegated admin of
 * the `stock-prep` namespace) can neither see nor assign it (`roleIdMatchesNamespace`). The S5a
 * migration (zzzz20261010124500_seed_stock_prep_role_templates) creates `stock-prep_frontline`; this
 * script moves the people and the table grants across.
 *
 * OWNER ACTION. Running this script against ANY server database — with or without `--apply` — is an
 * owner action (先批后动). It only ever reads or writes the database named by DATABASE_URL; it makes
 * no network call of its own.
 *
 * WHAT `--apply` DOES, in ONE transaction (all or nothing):
 *   1. every `user_roles` row of `stock-prep-operator` is re-pointed to `stock-prep_frontline`
 *      (one statement: DELETE … RETURNING feeds INSERT … ON CONFLICT DO NOTHING, so the set removed
 *      is exactly the set added — a member already in the target is simply not duplicated);
 *   2. every `spreadsheet_permissions` row whose subject is the ROLE `stock-prep-operator` is
 *      re-pointed to the role `stock-prep_frontline` the same way (same sheet, same level, same
 *      created_at). Rows with a user or member-group subject, and rows of any other role, are never
 *      written;
 *   3. with the separate, exact flag `--delete-empty-old-role` only: if the old role is then left
 *      with zero members and zero role-subject rows anywhere this script knows of, its
 *      `role_permissions` rows and its `roles` row are deleted. Without that flag the (empty) old role
 *      stays.
 * Without `--apply` nothing is written: the dry run opens a READ ONLY transaction, prints counts and
 * the verdict `--apply` would reach, and rolls back.
 *
 * WHEN `--apply` REFUSES (exit 2, nothing written) — each is a case where moving the members would
 * silently change what someone may do, which is the owner's call, not this script's:
 *   - `stock-prep_frontline` does not exist (the S5a migration has not run yet);
 *   - the old role holds permission codes the target role does not, while it still has members (they
 *     would lose those codes — e.g. approval codes granted to the old role by hand). Resolve in
 *     角色管理 first: grant the codes to the target role, or remove them from the old role;
 *   - the old role is the subject of rows this script does not move (view / field / record
 *     permissions, history-audit grants) — moving the members would drop those rows' effect;
 *   - the old role has active role-assigned approval tasks — moving the members would strand them;
 *   - the target role already has members who are not in the old role while there are table grants
 *     to move — the moved grants would extend to them.
 *
 * VALUES-FREE OUTPUT: role ids (this file's own literals), table names, counts, and permission codes
 * (platform vocabulary). Never a user id, a name, a sheet id, a host or a credential. Database errors
 * are reported by their code (SQLSTATE / errno) only, because PostgreSQL error text can quote row
 * values; an unknown argument is reported by position, never echoed. No audit row is written — the
 * printed counts are the record of the run.
 *
 * Usage:
 *   DATABASE_URL=… node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs            # dry run
 *   DATABASE_URL=… node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs --apply    # owner action
 *   … --apply --delete-empty-old-role                                                            # owner action
 *   --root <install root>  load `pg` from <root>/packages/core-backend and, if DATABASE_URL is not
 *                          set, read it from <root>/docker/app.env (never printed)
 *
 * Exit codes: 0 done (dry run, apply, or nothing to do) · 1 usage or execution failure · 2 refused.
 * Permission caches: the backend caches effective permissions for up to 60 s; a moved member sees
 * the change after that, on page refresh.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const OLD_ROLE_ID = 'stock-prep-operator'
export const TARGET_ROLE_ID = 'stock-prep_frontline'
export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_REFUSED = 2

/** Role-subject tables this script does NOT move. Any row of the old role there blocks --apply. */
export const UNMOVED_ROLE_SUBJECT_TABLES = Object.freeze([
  'meta_view_permissions',
  'field_permissions',
  'record_permissions',
  'meta_history_audit_grants',
])

const HELP_TEXT = `stock-preparation-migrate-legacy-operator-role.mjs — move ${OLD_ROLE_ID} onto ${TARGET_ROLE_ID}.

OWNER ACTION: running this against any server database requires the owner's go-ahead (R-39).

Usage:
  node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs [--apply] [--delete-empty-old-role] [--root <install root>]

  (no flag)                 dry run: READ ONLY transaction, counts and verdict only, nothing written
  --apply                   move memberships and role-subject table grants in one transaction
  --delete-empty-old-role   with --apply: also delete ${OLD_ROLE_ID} once it has no member and no grant
  --root <install root>     load pg from <root>/packages/core-backend; DATABASE_URL fallback from <root>/docker/app.env
  --help                    this text

Reads DATABASE_URL from the environment. Exit: 0 done · 1 usage/execution failure · 2 refused.
`

// Every statement this script can issue. Parameters: $1 is always OLD_ROLE_ID; $2, where present,
// is always TARGET_ROLE_ID. Nothing else is ever bound.
export const SQL = Object.freeze({
  begin: 'BEGIN',
  readOnly: 'SET TRANSACTION READ ONLY',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  tableExists: `SELECT count(*)::int AS count
  FROM information_schema.tables
 WHERE table_schema = current_schema()
   AND table_name = $1`,
  rolesRead: `SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id`,
  rolesLock: `SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
  oldMembers: `SELECT count(*)::int AS count FROM user_roles WHERE role_id = $1`,
  sharedMembers: `SELECT count(*)::int AS count
  FROM user_roles o
 WHERE o.role_id = $1
   AND EXISTS (SELECT 1 FROM user_roles t WHERE t.role_id = $2 AND t.user_id = o.user_id)`,
  targetOnlyMembers: `SELECT count(*)::int AS count
  FROM user_roles t
 WHERE t.role_id = $2
   AND NOT EXISTS (SELECT 1 FROM user_roles o WHERE o.role_id = $1 AND o.user_id = t.user_id)`,
  oldCodesMissingOnTarget: `SELECT o.permission_code
  FROM role_permissions o
 WHERE o.role_id = $1
   AND NOT EXISTS (SELECT 1 FROM role_permissions t WHERE t.role_id = $2 AND t.permission_code = o.permission_code)
 ORDER BY o.permission_code`,
  oldCodeCount: `SELECT count(*)::int AS count FROM role_permissions WHERE role_id = $1`,
  oldSheetGrants: `SELECT count(*)::int AS count
  FROM spreadsheet_permissions
 WHERE subject_type = 'role'
   AND subject_id = $1`,
  sharedSheetGrants: `SELECT count(*)::int AS count
  FROM spreadsheet_permissions o
 WHERE o.subject_type = 'role'
   AND o.subject_id = $1
   AND EXISTS (
     SELECT 1 FROM spreadsheet_permissions t
      WHERE t.subject_type = 'role' AND t.subject_id = $2
        AND t.sheet_id = o.sheet_id AND t.perm_code = o.perm_code
   )`,
  unmovedRoleRows: (table) => `SELECT count(*)::int AS count FROM ${table} WHERE subject_type = 'role' AND subject_id = $1`,
  activeRoleApprovals: `SELECT count(*)::int AS count
  FROM approval_assignments
 WHERE assignment_type = 'role'
   AND assignee_id = $1
   AND is_active = TRUE`,
  // ONE statement per move: the DELETE's RETURNING set IS the inserted set, so a membership or a
  // grant committed concurrently between two statements cannot be deleted without being moved.
  moveMembers: `WITH moved AS (
  DELETE FROM user_roles WHERE role_id = $1 RETURNING user_id
), inserted AS (
  INSERT INTO user_roles (user_id, role_id)
  SELECT user_id, $2 FROM moved
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted`,
  moveSheetGrants: `WITH moved AS (
  DELETE FROM spreadsheet_permissions
   WHERE subject_type = 'role'
     AND subject_id = $1
  RETURNING sheet_id, perm_code, created_at
), inserted AS (
  INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code, created_at)
  SELECT sheet_id, NULL, 'role', $2, perm_code, created_at FROM moved
  ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING
  RETURNING 1
)
SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted`,
  deleteOldRoleCodes: `DELETE FROM role_permissions WHERE role_id = $1`,
  deleteOldRole: `DELETE FROM roles WHERE id = $1`,
})

const BOTH = Object.freeze([OLD_ROLE_ID, TARGET_ROLE_ID])
const OLD = Object.freeze([OLD_ROLE_ID])

export class UsageError extends Error {}
/** A refusal or precondition stated in this file's own values-free words. */
export class ScriptError extends Error {}

export function parseArgs(argv) {
  const flags = { apply: false, deleteEmptyOldRole: false, root: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') flags.apply = true
    else if (arg === '--delete-empty-old-role') flags.deleteEmptyOldRole = true
    else if (arg === '--help') flags.help = true
    else if (arg === '--root') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new UsageError('--root needs a directory')
      flags.root = value
      index += 1
    } else {
      // The argument itself is not echoed: a mistyped invocation could carry a connection string.
      throw new UsageError(`unknown argument at position ${index + 1} (flags are exact; see --help)`)
    }
  }
  if (flags.deleteEmptyOldRole && !flags.apply) {
    throw new UsageError('--delete-empty-old-role only acts together with --apply')
  }
  return flags
}

async function count(client, text, params) {
  const result = await client.query(text, params)
  return Number(result.rows[0]?.count ?? 0)
}

async function tableExists(client, table) {
  return (await count(client, SQL.tableExists, [table])) > 0
}

/** Everything the decision needs, read inside the caller's transaction. Never writes. */
export async function readCensus(client, { lock }) {
  for (const table of ['roles', 'user_roles', 'role_permissions']) {
    if (!(await tableExists(client, table))) throw new ScriptError(`required table missing: ${table}`)
  }
  const roleRows = await client.query(lock ? SQL.rolesLock : SQL.rolesRead, BOTH)
  const ids = new Set(roleRows.rows.map((row) => row.id))
  const census = {
    oldRoleExists: ids.has(OLD_ROLE_ID),
    targetRoleExists: ids.has(TARGET_ROLE_ID),
    oldMembers: await count(client, SQL.oldMembers, OLD),
    sharedMembers: await count(client, SQL.sharedMembers, BOTH),
    targetOnlyMembers: await count(client, SQL.targetOnlyMembers, BOTH),
    oldCodeCount: await count(client, SQL.oldCodeCount, OLD),
    oldCodesMissingOnTarget: (await client.query(SQL.oldCodesMissingOnTarget, BOTH)).rows.map((row) => row.permission_code),
    oldSheetGrants: 0,
    sharedSheetGrants: 0,
    unmoved: {},
    activeRoleApprovals: 0,
  }
  if (await tableExists(client, 'spreadsheet_permissions')) {
    census.oldSheetGrants = await count(client, SQL.oldSheetGrants, OLD)
    census.sharedSheetGrants = await count(client, SQL.sharedSheetGrants, BOTH)
  }
  for (const table of UNMOVED_ROLE_SUBJECT_TABLES) {
    census.unmoved[table] = (await tableExists(client, table)) ? await count(client, SQL.unmovedRoleRows(table), OLD) : 0
  }
  if (await tableExists(client, 'approval_assignments')) {
    census.activeRoleApprovals = await count(client, SQL.activeRoleApprovals, OLD)
  }
  return census
}

/** The verdict `--apply` reaches on this census. Pure. */
export function decide(census) {
  const refusals = []
  if (!census.targetRoleExists) {
    refusals.push(`${TARGET_ROLE_ID} does not exist — run the S5a migration (the upgrade) first`)
    return { refusals, moveMembers: false, moveSheetGrants: false }
  }
  if (census.oldMembers > 0 && census.oldCodesMissingOnTarget.length > 0) {
    refusals.push(
      `${OLD_ROLE_ID} holds ${census.oldCodesMissingOnTarget.length} code(s) ${TARGET_ROLE_ID} does not `
      + `(${census.oldCodesMissingOnTarget.join(', ')}); its ${census.oldMembers} member(s) would lose them — `
      + 'decide in 角色管理 first (grant them to the target role, or remove them from the old role)',
    )
  }
  for (const [table, rows] of Object.entries(census.unmoved)) {
    if (rows > 0) refusals.push(`${OLD_ROLE_ID} is the subject of ${rows} row(s) in ${table}, which this script does not move`)
  }
  if (census.activeRoleApprovals > 0) {
    refusals.push(`${OLD_ROLE_ID} has ${census.activeRoleApprovals} active role-assigned approval task(s)`)
  }
  if (census.oldSheetGrants > 0 && census.targetOnlyMembers > 0) {
    refusals.push(
      `${TARGET_ROLE_ID} already has ${census.targetOnlyMembers} member(s) outside ${OLD_ROLE_ID}; `
      + `moving ${census.oldSheetGrants} table grant(s) would extend them to those members`,
    )
  }
  return { refusals, moveMembers: census.oldMembers > 0, moveSheetGrants: census.oldSheetGrants > 0 }
}

function oldRoleIsEmpty(census) {
  return census.oldMembers === 0
    && census.oldSheetGrants === 0
    && census.activeRoleApprovals === 0
    && Object.values(census.unmoved).every((rows) => rows === 0)
}

function describeCensus(census, write) {
  write(`roles: ${OLD_ROLE_ID} ${census.oldRoleExists ? 'exists' : 'absent'}; ${TARGET_ROLE_ID} ${census.targetRoleExists ? 'exists' : 'absent'}`)
  write(`members of ${OLD_ROLE_ID}: ${census.oldMembers} (already also in ${TARGET_ROLE_ID}: ${census.sharedMembers})`)
  write(`members only in ${TARGET_ROLE_ID}: ${census.targetOnlyMembers}`)
  write(`codes on ${OLD_ROLE_ID}: ${census.oldCodeCount}; not held by ${TARGET_ROLE_ID}: ${census.oldCodesMissingOnTarget.length}`)
  write(`role-subject table grants of ${OLD_ROLE_ID}: ${census.oldSheetGrants} (already on ${TARGET_ROLE_ID}: ${census.sharedSheetGrants})`)
  for (const [table, rows] of Object.entries(census.unmoved)) write(`role-subject rows in ${table}: ${rows}`)
  write(`active role-assigned approval tasks: ${census.activeRoleApprovals}`)
}

/**
 * One run against an open client. `manageTransaction: false` runs inside the CALLER's transaction
 * (the real-database test wraps a run in its own BEGIN … ROLLBACK); the CLI always manages its own.
 */
export async function run({ client, apply = false, deleteEmptyOldRole = false, manageTransaction = true, write = () => {} }) {
  const summary = { mode: apply ? 'apply' : 'dry-run', exitCode: EXIT_OK, refusals: [], membersMoved: 0, sheetGrantsMoved: 0, oldRoleDeleted: false }
  if (manageTransaction) {
    await client.query(SQL.begin)
    if (!apply) await client.query(SQL.readOnly)
  }
  let committed = false
  try {
    const census = await readCensus(client, { lock: apply })
    summary.census = census
    describeCensus(census, write)
    const verdict = decide(census)
    summary.refusals = verdict.refusals
    if (verdict.refusals.length > 0) {
      for (const reason of verdict.refusals) write(`${apply ? 'REFUSED' : '--apply would refuse'}: ${reason}`)
      summary.exitCode = EXIT_REFUSED
      return summary
    }
    const nothingToMove = !verdict.moveMembers && !verdict.moveSheetGrants
    if (!apply) {
      write(nothingToMove ? 'dry run: nothing to move' : `dry run: --apply would move ${census.oldMembers} membership(s) and ${census.oldSheetGrants} table grant(s)`)
      if (census.oldRoleExists) write(`dry run: with --apply --delete-empty-old-role, ${OLD_ROLE_ID} would then be deleted`)
      write('dry run: nothing written')
      return summary
    }

    if (verdict.moveMembers) {
      const moved = await client.query(SQL.moveMembers, BOTH)
      summary.membersMoved = Number(moved.rows[0]?.moved ?? 0)
    }
    if (verdict.moveSheetGrants) {
      const moved = await client.query(SQL.moveSheetGrants, BOTH)
      summary.sheetGrantsMoved = Number(moved.rows[0]?.moved ?? 0)
    }

    if (deleteEmptyOldRole && census.oldRoleExists) {
      // Re-read after the move, under the same transaction: delete only what is provably empty now.
      const after = await readCensus(client, { lock: true })
      if (!oldRoleIsEmpty(after)) {
        summary.refusals = [`${OLD_ROLE_ID} is not empty after the move; nothing was changed`]
        write(`REFUSED: ${summary.refusals[0]}`)
        summary.exitCode = EXIT_REFUSED
        return summary
      }
      await client.query(SQL.deleteOldRoleCodes, OLD)
      await client.query(SQL.deleteOldRole, OLD)
      summary.oldRoleDeleted = true
    }

    if (manageTransaction) {
      await client.query(SQL.commit)
      committed = true
    }
    write(nothingToMove && !summary.oldRoleDeleted
      ? 'apply: nothing to move; nothing written'
      : `apply: moved ${summary.membersMoved} membership(s) and ${summary.sheetGrantsMoved} table grant(s); ${OLD_ROLE_ID} ${summary.oldRoleDeleted ? 'deleted' : 'kept'}`)
    return summary
  } finally {
    if (manageTransaction && !committed) {
      try {
        await client.query(SQL.rollback)
      } catch {
        // The connection is already gone; PostgreSQL discards the open transaction with it.
      }
    }
  }
}

function readDatabaseUrlFromAppEnv(root) {
  const envPath = path.join(root, 'docker', 'app.env')
  if (!fs.existsSync(envPath)) return ''
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^DATABASE_URL=(.*)$/.exec(line)
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return ''
}

function loadPg(root) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const backendDir = root ? path.join(path.resolve(root), 'packages', 'core-backend') : path.resolve(here, '..', '..', 'packages', 'core-backend')
  return createRequire(path.join(backendDir, 'package.json'))('pg')
}

export async function main(argv, env, { createClient, out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    err(error instanceof UsageError ? error.message : 'invalid arguments')
    err(HELP_TEXT)
    return EXIT_FAILURE
  }
  if (flags.help) {
    out(HELP_TEXT)
    return EXIT_OK
  }
  const databaseUrl = env.DATABASE_URL || (flags.root ? readDatabaseUrlFromAppEnv(flags.root) : '')
  if (!databaseUrl) {
    err('DATABASE_URL is required (environment, or --root <install root> with docker/app.env)')
    return EXIT_FAILURE
  }
  out(`OWNER ACTION (R-39): ${flags.apply ? 'APPLY' : 'dry run'} — ${OLD_ROLE_ID} → ${TARGET_ROLE_ID}`)

  let client
  try {
    client = createClient
      ? await createClient(databaseUrl)
      : new (loadPg(flags.root).Client)({ connectionString: databaseUrl })
    if (typeof client.connect === 'function') await client.connect()
    const summary = await run({ client, apply: flags.apply, deleteEmptyOldRole: flags.deleteEmptyOldRole, write: out })
    return summary.exitCode
  } catch (error) {
    if (error instanceof ScriptError) {
      err(`failed: ${error.message}; nothing was written`)
      return EXIT_FAILURE
    }
    // PostgreSQL error text can quote row values; only the SQLSTATE / errno code is printed.
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown'
    err(`failed (code ${code}); the transaction was rolled back and nothing was written`)
    return EXIT_FAILURE
  } finally {
    if (client && typeof client.end === 'function') await client.end().catch(() => undefined)
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code
  })
}
