/**
 * Shared fixtures for the M4 task real-DB files (design task-m4-pr3a-backend-design-20260930.md
 * §10.1). Not a `task-*.db.test.ts` file, so it is not part of the three-set enumeration.
 *
 * - seedTaskActor: permissions (ON CONFLICT DO NOTHING), roles, role_permissions, users,
 *   user_roles, user_orgs, optional namespace admission and direct grants, and a signed JWT.
 * - seedOrgMembers: users + user_orgs only.
 * - orgMemberSeeds: seedOrgMembers with a per-file record and its own cleanup, for the M2/M3 files
 *   (S9, [N2]).
 * - dropTaskM4Fixtures: org-prefix cleanup of task rows (FK cascades take list items, group
 *   items, events and comments), lists (cascade members, list-scope groups, list events),
 *   user-scope groups, settings, outbox rows, then the identity rows.
 * - runSourceMutant: rewrites one source file in place, runs a tsx child, restores the file and
 *   asserts it is byte-identical. Only for a throwaway checkout (CI or the implementer's own
 *   worktree), never a worktree another agent is using.
 * - whileStructureLockHeld: holds an org's structure lock on its own connection while one request
 *   (or `waiters` requests) queue on it, and returns the holder's `clock_timestamp()` reading taken
 *   just before commit.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { acquireTaskStructureLock } from '../../src/db/task-advisory-locks'
import { poolManager } from '../../src/integration/db/connection-pool'

export const TASK_PERMISSION_CODES = ['tasks:read', 'tasks:write', 'tasks:admin'] as const

export interface SeededTaskActor {
  userId: string
  roleId: string
  bearer: string
}

export interface SeedTaskActorOptions {
  /** Short label, unique within one `stamp`. */
  label: string
  /** Shared per-file suffix; every seeded id ends with `_${stamp}` so cleanup can match it. */
  stamp: string
  orgId: string
  /** Codes granted through a role (role_permissions). */
  codes: string[]
  /** Insert `user_namespace_admissions(user_id, 'tasks', enabled = true)`. */
  admission: boolean
  /** Codes granted directly (user_permissions). */
  direct?: string[]
  /** `user_orgs.is_active`; defaults to true. */
  activeInOrg?: boolean
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('task-m4-fixtures requires JWT_SECRET (>= 32 chars)')
  }
  return secret
}

export function signTaskToken(userId: string, roleId: string, orgId: string): string {
  return jwt.sign({
    userId,
    sub: userId,
    email: `${userId}@tasks-m4.test`,
    role: 'user',
    roles: [roleId],
    tenantId: orgId,
  }, jwtSecret(), { expiresIn: '1h' })
}

export async function ensureTaskPermissions(): Promise<void> {
  await poolManager.get().query(
    `INSERT INTO permissions (code, name, description) VALUES
       ('tasks:read', 'Tasks Read', 'read'),
       ('tasks:write', 'Tasks Write', 'write'),
       ('tasks:admin', 'Tasks Admin', 'admin')
     ON CONFLICT (code) DO NOTHING`,
  )
}

async function insertUser(userId: string, name: string): Promise<void> {
  await poolManager.get().query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, activation_status, local_password_set, must_change_password
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE
     )`,
    [userId, `${userId}@tasks-m4.test`, name],
  )
}

export async function seedTaskActor(opts: SeedTaskActorOptions): Promise<SeededTaskActor> {
  const userId = `usr_${opts.label}_${opts.stamp}`
  const roleId = `role_${opts.label}_${opts.stamp}`
  const db = poolManager.get()
  await ensureTaskPermissions()
  await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
  for (const code of opts.codes) {
    await db.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, code])
  }
  await insertUser(userId, opts.label)
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
  await db.query(
    'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)',
    [userId, opts.orgId, opts.activeInOrg ?? true],
  )
  if (opts.admission) {
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [userId],
    )
  }
  for (const code of opts.direct ?? []) {
    await db.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [userId, code])
  }
  return { userId, roleId, bearer: signTaskToken(userId, roleId, opts.orgId) }
}

/** Seeds `users` + `user_orgs` only (no role, no admission). `active` defaults to true. */
export async function seedOrgMembers(
  orgId: string,
  userIds: string[],
  opts: { active?: boolean } = {},
): Promise<void> {
  const db = poolManager.get()
  for (const userId of userIds) {
    await insertUser(userId, userId)
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)',
      [userId, orgId, opts.active ?? true],
    )
  }
}

/**
 * seedOrgMembers with a per-file record, for the M2/M3 real-DB files and the auth gate, whose own
 * cleanup deletes task rows only (design §4.6, [N2]: an assignee or follower someone else writes
 * must be an active member of the org). `seed` runs seedOrgMembers for ids this record has not
 * seen; an id it already seeded (the same user in a second org) gets only the `user_orgs` row.
 * `drop` deletes exactly the recorded ids' `user_orgs` and `users` rows and forgets them, so a file
 * with several `afterAll` hooks can call it in each.
 */
export function orgMemberSeeds(): {
  seed: (orgId: string, userIds: string[]) => Promise<void>
  drop: () => Promise<void>
} {
  const seeded = new Set<string>()
  return {
    async seed(orgId, userIds) {
      const fresh = userIds.filter((userId) => !seeded.has(userId))
      const known = userIds.filter((userId) => seeded.has(userId))
      await seedOrgMembers(orgId, fresh)
      for (const userId of fresh) seeded.add(userId)
      for (const userId of known) {
        await poolManager.get().query(
          'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
          [userId, orgId],
        )
      }
    },
    async drop() {
      const userIds = [...seeded]
      if (userIds.length === 0) return
      const db = poolManager.get()
      await db.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [userIds])
      await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
      seeded.clear()
    },
  }
}

/**
 * Removes everything an M4 file seeded. `orgPrefix` is matched literally against the start of
 * `org_id` (no LIKE wildcards: `_` and `%` in the prefix are plain characters); `userIds` /
 * `roleIds` are exact ids (callers usually collect them from seedTaskActor / seedOrgMembers).
 */
export async function dropTaskM4Fixtures(opts: {
  orgPrefix: string
  userIds?: string[]
  roleIds?: string[]
}): Promise<void> {
  if (!opts.orgPrefix || opts.orgPrefix.length < 6) {
    throw new Error('dropTaskM4Fixtures: refusing a short org prefix')
  }
  const db = poolManager.get()
  const prefix = opts.orgPrefix
  const users = opts.userIds ?? []
  const roles = opts.roleIds ?? []
  for (const table of ['tasks', 'task_lists', 'task_groups', 'task_user_settings', 'task_notification_deliveries']) {
    await db.query(`DELETE FROM ${table} WHERE left(org_id, length($1)) = $1`, [prefix])
  }
  if (users.length > 0) {
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [users])
  }
  if (roles.length > 0) {
    await db.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [roles])
    await db.query('DELETE FROM roles WHERE id = ANY($1::text[])', [roles])
  }
}

/**
 * Holds `orgId`'s structure lock on a connection of its own and starts `start()`, a request that
 * must queue on that lock (or several: `start` may return `Promise.all` of them, and `waiters` says
 * how many must be queued). Once this database shows that many ungranted advisory locks (locks of
 * other databases on the same server are not counted), runs `beforeCommit` on the holder (a write
 * that commits while the request waits), reads `clock_timestamp()` on the holder, commits, and
 * returns the request's result with that reading as text (microseconds kept). A write of the
 * request that is stamped after the lock is held is later than `holderAt`; one stamped at its
 * transaction start is earlier.
 */
export async function whileStructureLockHeld<T>(
  orgId: string,
  start: () => Promise<T>,
  beforeCommit?: (holder: pg.Client) => Promise<void>,
  waiters = 1,
): Promise<{ result: T; holderAt: string }> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  let committed = false
  try {
    await holder.query('BEGIN')
    await acquireTaskStructureLock((sql, params) => holder.query(sql, params), orgId)
    const pending = start()
    pending.catch(() => undefined)
    const deadline = Date.now() + 15000
    for (;;) {
      const waiting = await holder.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      )
      if (waiting.rows[0].n >= waiters) break
      if (Date.now() > deadline) throw new Error(`fewer than ${waiters} request(s) queued on the structure lock`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (beforeCommit) await beforeCommit(holder)
    const holderAt = String((await holder.query('SELECT clock_timestamp()::text AS at')).rows[0].at)
    await holder.query('COMMIT')
    committed = true
    return { result: await pending, holderAt }
  } finally {
    if (!committed) await holder.query('ROLLBACK').catch(() => undefined)
    await holder.end()
  }
}

/**
 * Asserts `file` contains `needle` (exactly once when `unique` is set), backs it up, writes the
 * mutant, runs `script` (an .mts body) under tsx with `env`, then restores the file and asserts
 * it is byte-identical to the original. Rethrows the child's failure after restoring.
 * `all` rewrites every occurrence instead of the first; `count` asserts how many there are.
 */
export function runSourceMutant(
  file: string,
  needle: string,
  replacement: string,
  script: string,
  env: Record<string, string> = {},
  opts: { unique?: boolean; timeoutMs?: number; all?: boolean; count?: number } = {},
): void {
  const original = readFileSync(file)
  const text = original.toString('utf8')
  const occurrences = text.split(needle).length - 1
  if (occurrences < 1) throw new Error(`runSourceMutant: needle not found in ${file}`)
  if (opts.unique && occurrences !== 1) {
    throw new Error(`runSourceMutant: needle occurs ${occurrences} times in ${file}`)
  }
  if (opts.count !== undefined && occurrences !== opts.count) {
    throw new Error(`runSourceMutant: needle occurs ${occurrences} times in ${file}, expected ${opts.count}`)
  }
  const backup = join(tmpdir(), `task-m4-mutant-${randomUUID()}.bak`)
  const probe = join(tmpdir(), `task-m4-probe-${randomUUID()}.mts`)
  copyFileSync(file, backup)
  let failed: unknown
  try {
    writeFileSync(file, opts.all ? text.split(needle).join(replacement) : text.replace(needle, replacement))
    writeFileSync(probe, script)
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    const at = file.lastIndexOf('/src/')
    execFileSync(process.execPath, [tsx, probe], {
      cwd: at >= 0 ? file.slice(0, at) : process.cwd(),
      env: { ...process.env, ...env },
      stdio: 'inherit',
      timeout: opts.timeoutMs ?? 120000,
    })
  } catch (err) {
    failed = err
  } finally {
    copyFileSync(backup, file)
    for (const path of [probe, backup]) {
      try { unlinkSync(path) } catch { /* already removed */ }
    }
  }
  if (!readFileSync(file).equals(original)) {
    throw new Error(`runSourceMutant: ${file} was not restored byte-identically`)
  }
  if (failed) throw failed
}
