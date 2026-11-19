/**
 * D21 x refute [1] — DIRECTORY SYNC takes every subject version row its run can touch in ONE sorted statement,
 * against real PostgreSQL (slice Y5a follow-up).
 *
 * Before: the local-apply transaction took version rows in two statements — the mutex inventory
 * (directory-sync.ts lockDirectorySyncAccessGraphUsers), then the member-group projection's removal bump
 * (syncProjectedDepartmentMemberGroupsInTransaction) for a member the inventory never read: any user an
 * administrator added to a projected group. #6924's exception writers bump actor + target in one sorted statement,
 * so with the target sorting before the actor: the sync holds the actor's row, the writer holds the target's and
 * waits on the actor's, the sync's projection then bumps the target -> 40P01 (one side rolled back). After: the
 * inventory's candidate query reads the projected groups' current members, so its one sorted statement already
 * holds the target; a member who joins after that read is refused fail-closed by the projection, never bumped late.
 *
 *   DS-01  the cycle the refuter witnessed, through the REAL inventory, the REAL projection and #6924's REAL
 *          writeLegacyAuthorizationException: the writer parks behind the sync (observed through
 *          pg_blocking_pids), the projection finishes without waiting, the sync commits, the writer then
 *          commits — no 40P01 on either side; the member row is gone and the writer's grant landed;
 *   DS-02  a member added to the projected group AFTER the inventory read: the projection answers the typed
 *          DirectoryConflictError (retry the run) before any version-row statement on that member — the
 *          member's row stays free (a NOWAIT probe from another connection takes it).
 *
 * Witnessed red (PR body / evidence y5a-r2): with the inventory's projected-group arm removed, DS-01 ends in
 * 40P01 (the writer's AuthorizationInputBusyError busyReason=deadlock, or the sync's own 40P01); with the
 * projection's held-set check removed, DS-02 bumps the late member instead of refusing.
 *
 * A CASES MODULE, registered from the already-wired real-DB file tests/integration/authz-version-protocol.db.test.ts
 * (excluded from the no-DB runner, run whole-file in the approval real-DB step) — do NOT list a standalone file.
 * Values-free: every id is synthetic and per-run.
 */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { writeLegacyAuthorizationException } from '../../src/admin/authorization-exception-compat'
import { DirectoryConflictError, __directorySyncInternalsForTests } from '../../src/directory/directory-sync'
import { SUBJECT_AUTHORIZATION_VERSIONS_TABLE } from '../../src/multitable/authz-version-protocol'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const P = `y5ads_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`

type Outcome = { result: 'proceeded' | string; ms: number }
const settle = async (work: () => Promise<unknown>): Promise<Outcome> => {
  const started = Date.now()
  try {
    await work()
    return { result: 'proceeded', ms: Date.now() - started }
  } catch (error) {
    const e = error as { code?: unknown; busyReason?: unknown; cause?: { code?: unknown }; name?: unknown }
    const code = typeof e?.busyReason === 'string'
      ? `${String(e.name)} busyReason=${e.busyReason} cause=${String(e.cause?.code ?? '')}`
      : typeof e?.code === 'string' ? `sqlstate=${e.code}` : String(e?.name ?? 'Error')
    return { result: code, ms: Date.now() - started }
  }
}

export function defineAuthzVersionDirectorySyncOrderRealDbCases(): void {
  describeIfDatabase.sequential('D21 directory sync — one sorted version-row statement per run (refute [1], real PostgreSQL)', () => {
    let pool: Pool
    let sync: PoolClient
    let inspector: PoolClient
    const created: { users: string[]; groups: string[]; perms: string[] } = { users: [], groups: [], perms: [] }
    const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)

    async function fixture(tag: string) {
      // Code-unit order: the target sorts BEFORE the admin, so the exception writer's one sorted bump takes the
      // target's row first and then waits on the admin's (the refuter's C2 shape).
      const T = `${P}_${tag}_a_target`
      const A = `${P}_${tag}_b_admin`
      for (const id of [T, A]) {
        await q(
          `INSERT INTO users (id, email, password_hash, role, is_active, activation_status, is_admin, permissions)
           VALUES ($1, $1 || '@example.test', 'x', 'user', TRUE, 'activated', FALSE, '[]'::jsonb)`,
          [id],
        )
        created.users.push(id)
      }
      await q(`INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING`)
      await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [A])
      const perm = `${P}_${tag}:read`
      await q(`INSERT INTO permissions (code, name) VALUES ($1, 'y5a directory-sync order permission')`, [perm])
      created.perms.push(perm)
      const integrationId = randomUUID()
      const department = `${P}_${tag}_dept`
      const marker = `dingtalk-sync-group:${integrationId}:${department}`
      const groupId = String((await q(
        `INSERT INTO platform_member_groups (name, description) VALUES ($1, $2) RETURNING id::text AS id`,
        [`${P}_${tag}_group`, marker],
      )).rows[0].id)
      created.groups.push(groupId)
      // T is in the group now (an administrator put it there); no directory account links it to this integration.
      await q('INSERT INTO platform_member_group_members (group_id, user_id, created_at) VALUES ($1::uuid, $2, now())', [groupId, T])
      return { T, A, perm, integrationId, department, marker, groupId }
    }

    // The inventory as the orchestration calls it: the admin reaches it through the email arm (a payload member),
    // the target only as a current member of the projected group.
    const inventory = (f: Awaited<ReturnType<typeof fixture>>) => __directorySyncInternalsForTests.lockDirectorySyncAccessGraphUsers(sync, {
      integrationId: f.integrationId,
      provider: 'dingtalk',
      users: [{ userId: `${f.A}_ext`, name: 'y5a', email: `${f.A}@example.test`, departmentIds: [], source: {} }],
      projectedGroupMarkers: [f.marker],
    })
    const projection = (f: Awaited<ReturnType<typeof fixture>>, held: Set<string>, memberUserIds: string[] = []) =>
      __directorySyncInternalsForTests.syncProjectedDepartmentMemberGroupsInTransaction(
        sync,
        [{ externalDepartmentId: f.department, name: `${f.groupId}_renamed`, marker: f.marker, memberUserIds }],
        { defaultRoleIds: [], defaultNamespaces: [], heldUserIds: held },
        'system:y5a-test',
      )

    async function waitUntilSomeoneBlockedBy(holderPid: number, timeoutMs = 8000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const { rows } = await inspector.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        )
        if (rows.length > 0) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`timed out waiting for a backend to block on pid ${holderPid}`)
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
      sync = await pool.connect()
      inspector = await pool.connect()
      await sync.query("SET statement_timeout = '20s'")
    })

    afterAll(async () => {
      await sync?.query('ROLLBACK').catch(() => undefined)
      for (const groupId of created.groups) await q('DELETE FROM platform_member_groups WHERE id = $1::uuid', [groupId]).catch(() => undefined)
      for (const userId of created.users) {
        await q('DELETE FROM user_permissions WHERE user_id = $1', [userId]).catch(() => undefined)
        await q('DELETE FROM user_roles WHERE user_id = $1', [userId]).catch(() => undefined)
      }
      for (const code of created.perms) await q('DELETE FROM permissions WHERE code = $1', [code]).catch(() => undefined)
      for (const userId of created.users) await q('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
      await q(`DELETE FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id = ANY($1::text[])`, [created.users]).catch(() => undefined)
      sync?.release()
      inspector?.release()
      await pool?.end()
    })

    test('DS-01 the projection\'s removal bump re-takes a row the inventory already holds: the exception writer parks behind the sync, no 40P01 on either side', async () => {
      const f = await fixture('ds01')
      const syncPid = Number((await sync.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await sync.query('BEGIN')
      await sync.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const held = await inventory(f)
      // #6924's legacy exception writer: actor A grants T a direct code — its mutex bumps [T, A] in one statement.
      const writer = settle(() => writeLegacyAuthorizationException({ actorId: f.A, userId: f.T, action: { kind: 'direct.grant', code: f.perm } }))
      await waitUntilSomeoneBlockedBy(syncPid)
      // The projection no longer wants T: bump T (already held -> no wait), then DELETE the member row.
      const syncSide = await settle(async () => {
        await projection(f, held.lockedUserIds)
        await sync.query('COMMIT')
      })
      if (syncSide.result !== 'proceeded') await sync.query('ROLLBACK').catch(() => undefined)
      const writerSide = await writer
      expect({ sync: syncSide.result, writer: writerSide.result }).toEqual({ sync: 'proceeded', writer: 'proceeded' })
      // The sync never waited on the writer (a re-take of its own row), far below deadlock_timeout.
      expect(syncSide.ms).toBeLessThan(900)
      // Why: the inventory's one sorted statement held the projected member as well as the admin.
      expect(held.lockedUserIds.has(f.A)).toBe(true)
      expect(held.lockedUserIds.has(f.T)).toBe(true)
      const members = await q('SELECT 1 FROM platform_member_group_members WHERE group_id = $1::uuid AND user_id = $2', [f.groupId, f.T])
      expect(members.rows).toHaveLength(0)
      const grant = await q('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [f.T, f.perm])
      expect(grant.rows).toHaveLength(1)
    })

    test('DS-02 a member who joins the projected group after the inventory read is refused (DirectoryConflictError) before any version-row statement on that member', async () => {
      const f = await fixture('ds02')
      // Only the admin is a member when the inventory reads; the target joins afterwards.
      await q('DELETE FROM platform_member_group_members WHERE group_id = $1::uuid', [f.groupId])
      await sync.query('BEGIN')
      await sync.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const held = await inventory(f)
      expect(held.lockedUserIds.has(f.T)).toBe(false)
      // An administrator adds T to the group and commits (its own trigger bump, on a row the sync does not hold).
      await q('INSERT INTO platform_member_group_members (group_id, user_id, created_at) VALUES ($1::uuid, $2, now())', [f.groupId, f.T])
      const outcome = await projection(f, held.lockedUserIds, [f.A]).then(() => null, (error: unknown) => error)
      expect(outcome).toBeInstanceOf(DirectoryConflictError)
      // The sync issued no version-row statement on T: another connection takes T's row NOWAIT.
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        const locked = await probe.query(`SELECT subject_id FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id = $1 FOR UPDATE NOWAIT`, [f.T])
        expect(locked.rows).toHaveLength(1)
      } finally {
        await probe.query('ROLLBACK').catch(() => undefined)
        probe.release()
      }
      await sync.query('ROLLBACK')
    })
  })
}
