/**
 * O2-S1 — registration atomicity (real Postgres).
 *
 * AuthService.register() creates the user AND assigns the attendance self-service role in
 * ONE transaction, with bounded WHOLE-transaction retry on recovery-authority-busy (40001).
 * Before this slice, createUser() committed first and assignUserRoles() ran in a separate
 * transaction — a persistently busy lease then threw UserRoleAssignmentRecoveryBusyError
 * while the users / user_login_aliases / user_permissions rows stayed committed (P23
 * residue). This suite proves the residue is gone:
 *
 *  1. Failure injection (narrowly scoped per repo convention — the injected trigger fires
 *     ONLY for this run's `${NS}-inject-` email namespace, so concurrent suites sharing the
 *     DB never see it) makes the user_roles insert raise SQLSTATE 40001 with the real
 *     RECOVERY_AUTHORITY_BUSY_MARKER. Retries exhaust → register rejects with the named
 *     error AND all four tables (users, user_login_aliases, user_permissions, user_roles)
 *     hold ZERO rows for that registration; a subsequent register with the SAME email then
 *     succeeds.
 *  2. Retry unit is the WHOLE transaction: a non-transactional sequence counts trigger
 *     firings. After a 40001 the open transaction is aborted (any further statement fails
 *     25P02 and cannot fire a BEFORE INSERT trigger), so N firings require N fresh
 *     transactions in which the users insert succeeded again — the counter equaling
 *     USER_ROLE_ASSIGNMENT_RETRY_LIMIT proves whole-transaction retry, not per-statement.
 *  3. Positive control / scope proof: with the injection trigger ACTIVE, an email outside
 *     the injection namespace registers successfully and its role row exists — the
 *     zero-residue queries above are proven able to see rows by the same helpers here.
 *  4. resolveRbacProfile call path (standalone assignUserRoles backfill) stays contained:
 *     a busy lease during the read-path backfill must not fail login and must not fabricate
 *     unpersisted attendance permissions — and the sequence delta proves the injection
 *     genuinely fired on that path (not vacuous).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as bcrypt from 'bcryptjs'
import {
  AuthService,
  USER_ROLE_ASSIGNMENT_RETRY_LIMIT,
  UserRoleAssignmentRecoveryBusyError,
} from '../../src/auth/AuthService'
import { normalizeLoginIdentifier } from '../../src/auth/login-identifier'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { query } from '../../src/db/pg'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const NS = `o2s1-${Date.now()}`
const INJECT_EMAIL_PREFIX = `${NS}-inject-`
const SEQ = `o2s1_busy_fire_seq_${Date.now()}`
const FN = `o2s1_user_roles_busy_inject_${Date.now()}`
const TRIGGER = `trg_${FN}`

const createdUserIds: string[] = []
const createdEmails: string[] = []

async function cleanupRows() {
  for (const uid of createdUserIds.splice(0, createdUserIds.length)) {
    await query(`DELETE FROM user_sessions WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_permissions WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_roles WHERE user_id = $1`, [uid])
    await query(`DELETE FROM users WHERE id = $1`, [uid])
  }
  for (const email of createdEmails.splice(0, createdEmails.length)) {
    // Residue sweep by email in case a failure path left rows without a captured id.
    const rows = await query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email])
    for (const row of rows.rows) {
      await query(`DELETE FROM user_sessions WHERE user_id = $1`, [row.id])
      await query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [row.id])
      await query(`DELETE FROM user_permissions WHERE user_id = $1`, [row.id])
      await query(`DELETE FROM user_roles WHERE user_id = $1`, [row.id])
      await query(`DELETE FROM users WHERE id = $1`, [row.id])
    }
    const normalized = normalizeLoginIdentifier(email)
    if (normalized) {
      await query(`DELETE FROM user_login_aliases WHERE normalized_value = $1`, [normalized])
    }
  }
}

/** Row counts across the four registration-owned tables, keyed by user id + email. */
async function residueCounts(userId: string, email: string) {
  const normalized = normalizeLoginIdentifier(email)
  const [users, aliasesById, aliasesByValue, permissions, roles] = await Promise.all([
    query(`SELECT 1 FROM users WHERE id = $1 OR lower(email) = lower($2)`, [userId, email]),
    query(`SELECT 1 FROM user_login_aliases WHERE user_id = $1`, [userId]),
    query(`SELECT 1 FROM user_login_aliases WHERE normalized_value = $1`, [normalized]),
    query(`SELECT 1 FROM user_permissions WHERE user_id = $1`, [userId]),
    query(`SELECT 1 FROM user_roles WHERE user_id = $1`, [userId]),
  ])
  return {
    users: users.rows.length,
    aliases: aliasesById.rows.length + aliasesByValue.rows.length,
    permissions: permissions.rows.length,
    roles: roles.rows.length,
  }
}

async function triggerFireCount(): Promise<number> {
  const result = await query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value, is_called FROM ${SEQ}`,
  )
  const row = result.rows[0]
  if (!row) throw new Error(`sequence ${SEQ} missing`)
  return row.is_called ? Number(row.last_value) : 0
}

async function createInjectionTrigger() {
  // Narrow scope: fires only when the user being granted a role has an email in THIS run's
  // inject namespace. Raises the exact production marker + SQLSTATE so
  // isRecoveryAuthorityBusyError classifies it identically to a real busy lease.
  await query(
    `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger AS $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM users u
         WHERE u.id = NEW.user_id
           AND u.email LIKE '${INJECT_EMAIL_PREFIX}%'
       ) THEN
         PERFORM nextval('${SEQ}');
         RAISE EXCEPTION '${RECOVERY_AUTHORITY_BUSY_MARKER}' USING ERRCODE = '40001';
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
  )
  await query(
    `CREATE TRIGGER ${TRIGGER}
     BEFORE INSERT ON user_roles
     FOR EACH ROW EXECUTE FUNCTION ${FN}()`,
  )
}

async function dropInjectionTrigger() {
  await query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON user_roles`)
}

const originalProductMode = process.env.PRODUCT_MODE

describeIfDatabase('O2-S1 registration atomicity (real Postgres)', () => {
  beforeAll(async () => {
    // attendance / platform both enable self-service role assignment; pin one explicitly.
    process.env.PRODUCT_MODE = 'attendance'
    await query(`CREATE SEQUENCE ${SEQ}`)
    await createInjectionTrigger()
  })

  afterAll(async () => {
    await dropInjectionTrigger()
    await query(`DROP FUNCTION IF EXISTS ${FN}()`)
    await query(`DROP SEQUENCE IF EXISTS ${SEQ}`)
    await cleanupRows()
    if (originalProductMode === undefined) {
      delete process.env.PRODUCT_MODE
    } else {
      process.env.PRODUCT_MODE = originalProductMode
    }
  })

  it('positive control + injection scope: an email OUTSIDE the inject namespace registers fully while the trigger is active', async () => {
    const email = `${NS}-clean@atomicity.example`
    createdEmails.push(email)

    const firesBefore = await triggerFireCount()
    const auth = new AuthService()
    const user = await auth.register(email, 'AtomicPass9A!', 'Clean Register')
    expect(user).toBeTruthy()
    createdUserIds.push(user!.id)

    // All four tables hold rows — this is the positive control proving the SAME queries used
    // for the zero-residue assertion below are capable of seeing rows.
    const counts = await residueCounts(user!.id, email)
    expect(counts.users).toBeGreaterThan(0)
    expect(counts.aliases).toBeGreaterThan(0)
    expect(counts.permissions).toBeGreaterThan(0)
    expect(counts.roles).toBeGreaterThan(0)

    const role = await query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'attendance_employee'`,
      [user!.id],
    )
    expect(role.rows.length).toBe(1)

    // Scope proof: the active injection trigger did not fire for this out-of-namespace email.
    expect(await triggerFireCount()).toBe(firesBefore)
  })

  it('resolveRbacProfile backfill path stays contained under a busy lease: read succeeds, no fabricated permissions, injection genuinely fired', async () => {
    const email = `${INJECT_EMAIL_PREFIX}backfill@atomicity.example`
    const userId = `${NS}-backfill-user`
    createdUserIds.push(userId)
    createdEmails.push(email)
    const passwordHash = await bcrypt.hash('BackfillPass9A!', 4)
    await query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, created_at, updated_at
       ) VALUES ($1, $2, 'Backfill User', $3, 'user', '[]'::jsonb,
                 TRUE, 'activated', TRUE, NOW(), NOW())`,
      [userId, email, passwordHash],
    )

    const firesBefore = await triggerFireCount()
    const auth = new AuthService()
    const result = await auth.login(email, 'BackfillPass9A!')

    // Contained: the busy backfill must not turn a valid login into a failure...
    expect(result).toBeTruthy()
    expect(result!.user.id).toBe(userId)
    // ...and must not fabricate the unpersisted attendance permissions.
    expect(result!.user.permissions).not.toContain('attendance:read')
    expect(result!.user.permissions).not.toContain('attendance:write')
    const roles = await query(`SELECT 1 FROM user_roles WHERE user_id = $1`, [userId])
    expect(roles.rows.length).toBe(0)

    // Not vacuous: the standalone assignUserRoles bounded retry really hit the injection —
    // exactly the configured number of attempts.
    expect(await triggerFireCount()).toBe(firesBefore + USER_ROLE_ASSIGNMENT_RETRY_LIMIT)
  })

  it('injection exhaustion leaves ZERO residue across users/login_aliases/user_permissions/user_roles, and the same email then registers successfully', async () => {
    const email = `${INJECT_EMAIL_PREFIX}register@atomicity.example`
    createdEmails.push(email)

    const firesBefore = await triggerFireCount()
    const auth = new AuthService()
    let thrown: unknown
    try {
      await auth.register(email, 'AtomicPass9A!', 'Busy Register')
      expect.unreachable('register must reject when whole-transaction retries exhaust')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UserRoleAssignmentRecoveryBusyError)
    const busy = thrown as UserRoleAssignmentRecoveryBusyError
    expect(busy.retryable).toBe(true)
    expect(busy.roleIds).toContain('attendance_employee')

    // Whole-transaction retry, bounded: each firing requires a FRESH transaction in which
    // the users insert succeeded again (after 40001 the prior transaction is aborted — a
    // retry inside it would fail 25P02 without reaching this BEFORE INSERT trigger).
    expect(await triggerFireCount()).toBe(firesBefore + USER_ROLE_ASSIGNMENT_RETRY_LIMIT)

    // ZERO residue for the failed registration, in all four tables (the error carries the
    // exact userId every rolled-back attempt used).
    const counts = await residueCounts(busy.userId, email)
    expect(counts).toEqual({ users: 0, aliases: 0, permissions: 0, roles: 0 })

    // With the injection removed, the SAME email registers successfully — nothing latent
    // (alias claim, unique index, permissions) was left behind to block it.
    await dropInjectionTrigger()
    const user = await auth.register(email, 'AtomicPass9A!', 'Recovered Register')
    expect(user).toBeTruthy()
    createdUserIds.push(user!.id)
    const after = await residueCounts(user!.id, email)
    expect(after.users).toBeGreaterThan(0)
    expect(after.aliases).toBeGreaterThan(0)
    expect(after.permissions).toBeGreaterThan(0)
    expect(after.roles).toBeGreaterThan(0)
  })
})
