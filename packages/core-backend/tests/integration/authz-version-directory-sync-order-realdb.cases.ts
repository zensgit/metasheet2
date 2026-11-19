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
 *          member's row stays free (a NOWAIT probe from another connection takes it);
 *   DS-03  the same cycle shape through the REAL syncDirectoryIntegration (only the DingTalk HTTP client is
 *          mocked, by the registering file): a barrier connection holds LOCK TABLE user_external_identities IN
 *          SHARE ROW EXCLUSIVE MODE, so the run parks at its own identical LOCK right after the inventory and
 *          before the projection; the projected member's and the admin's version rows are held by the run;
 *          #6924's exception writer is observed waiting on the run at a version-row statement; on release both
 *          commit — no 40P01 — the member row is gone and the grant landed.
 *
 * Witnessed reds (evidence y5a-r2, real PG14):
 *   - before the fix (f78f65def plus only the test export of the projection): DS-01 ends in 40P01 — the writer's
 *     AuthorizationInputBusyError busyReason=deadlock — and DS-02 bumps the late member instead of refusing;
 *   - with only the inventory's projected-group arm removed: DS-01 fails on the sync's DirectoryConflictError
 *     (the held-set guard turns the cycle into a typed refusal; the arm is what lets the run proceed);
 *   - with only the projection's held-set check removed: DS-02 bumps the late member instead of refusing;
 *   - DS-03 (evidence y5a-final, real PG14), with only the inventory's projected-group arm removed: the parked
 *     run does not hold T's row ('free', not 'held'); with that probe also dropped (WSL copy only) the outcome is
 *     the run's DirectoryConflictError instead of both proceeding. DS-03 is green on fc76f5f66 itself — it adds
 *     the orchestration-level coverage (the real syncDirectoryIntegration), not a new behaviour.
 *
 * A CASES MODULE, registered from the already-wired real-DB file tests/integration/authz-version-protocol.db.test.ts
 * (excluded from the no-DB runner, run whole-file in the approval real-DB step) — do NOT list a standalone file.
 * Values-free: every id is synthetic and per-run.
 */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { writeLegacyAuthorizationException } from '../../src/admin/authorization-exception-compat'
import {
  DirectoryConflictError,
  __directorySyncInternalsForTests,
  createDirectoryIntegration,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
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

/** The synthetic directory DS-03's mocked DingTalk client serves (the registering file owns the vi.mock). */
export type DirectorySyncDingTalkStub = {
  departments: Array<{ id: string; parentId: string; name: string }>
  users: Array<{ userId: string; name: string; email: string; unionId: string; openId: string; departmentIds: string[] }>
}

export function defineAuthzVersionDirectorySyncOrderRealDbCases(dingtalk?: DirectorySyncDingTalkStub): void {
  describeIfDatabase.sequential('D21 directory sync — one sorted version-row statement per run (refute [1], real PostgreSQL)', () => {
    let pool: Pool
    let sync: PoolClient
    let inspector: PoolClient
    const created: { users: string[]; groups: string[]; perms: string[]; integrations: string[] } = {
      users: [], groups: [], perms: [], integrations: [],
    }
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

    // DS-03: the pid of the backend that waits on `holderPid` while running a statement that matches `statement`.
    async function waitForBlocked(holderPid: number, statement: RegExp, timeoutMs = 15000): Promise<number> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const { rows } = await inspector.query(
          `SELECT pid, query FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        )
        const match = rows.find((row) => statement.test(String(row.query ?? '')))
        if (match) return Number(match.pid)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`timed out waiting for a backend blocked by pid ${holderPid} at ${statement.source}`)
    }

    // DS-03: is the subject's (committed) version row held by another transaction? 'held' | 'free' | 'no-row'.
    async function versionRowState(subjectId: string): Promise<string> {
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        const { rows } = await probe.query(
          `SELECT subject_id FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id = $1 FOR UPDATE NOWAIT`, [subjectId])
        return rows.length > 0 ? 'free' : 'no-row'
      } catch (error) {
        return (error as { code?: string }).code === '55P03' ? 'held' : `error:${String((error as { code?: string }).code)}`
      } finally {
        await probe.query('ROLLBACK').catch(() => undefined)
        probe.release()
      }
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
      sync = await pool.connect()
      inspector = await pool.connect()
      await sync.query("SET statement_timeout = '20s'")
    })

    afterAll(async () => {
      await sync?.query('ROLLBACK').catch(() => undefined)
      // DS-03's real runs: the directory rows they wrote, in FK order (the same order as
      // directory-sync-orchestration.db.test.ts's cleanupIntegration).
      for (const integrationId of created.integrations) {
        for (const sql of [
          'DELETE FROM directory_sync_alerts WHERE integration_id = $1',
          `DELETE FROM directory_deprovision_effects WHERE event_id IN
             (SELECT id FROM directory_deprovision_events WHERE integration_id = $1::uuid)`,
          'DELETE FROM directory_deprovision_events WHERE integration_id = $1::uuid',
          'DELETE FROM directory_sync_runs WHERE integration_id = $1',
          'DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)',
          'DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)',
          'DELETE FROM directory_accounts WHERE integration_id = $1',
          'DELETE FROM directory_departments WHERE integration_id = $1',
          'DELETE FROM directory_integrations WHERE id = $1',
        ]) await q(sql, [integrationId]).catch(() => undefined)
      }
      for (const sql of [
        'DELETE FROM user_invites WHERE user_id = ANY($1::text[])',
        'DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])',
        'DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])',
      ]) await q(sql, [created.users]).catch(() => undefined)
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

    test('DS-03 through the REAL syncDirectoryIntegration: parked after its inventory, the run holds the projected member\'s row; the exception writer waits on the run at a version row, then both commit — no 40P01', async () => {
      if (!dingtalk) throw new Error('DS-03 needs the DingTalk client stub from the registering file')
      const f = await fixture('ds03')
      // The group the fixture made carries a marker for a random integration; DS-03 lets the real run create its own.
      const integration = await createDirectoryIntegration({
        name: `${P}_ds03_int`, corpId: `${P}_ds03_corp`, appKey: `${P}_ds03_app`, appSecret: 'synthetic-only',
        admissionMode: 'manual_only',
        memberGroupSyncMode: 'sync_scoped_departments', memberGroupDepartmentIds: [f.department],
      })
      const integrationId = String(integration.id)
      created.integrations.push(integrationId)
      dingtalk.departments = [{ id: f.department, parentId: '1', name: `${P}_ds03_dept` }]
      // The admin is a payload member matched by email: the inventory reaches it through the email arm.
      dingtalk.users = [{
        userId: `${f.A}_ext`, name: 'y5a ds03 admin', email: `${f.A}@example.test`,
        unionId: `${f.A}_union`, openId: `${f.A}_open`, departmentIds: [f.department],
      }]
      // Pass 0 creates the run's projected group; an administrator then puts T into it (no account links T).
      await syncDirectoryIntegration(integrationId, 'system:y5a-ds03', 'manual')
      const marker = `dingtalk-sync-group:${integrationId}:${f.department}`
      const groups = await q('SELECT id::text AS id FROM platform_member_groups WHERE description = $1', [marker])
      expect(groups.rows).toHaveLength(1)
      const runGroupId = String(groups.rows[0].id)
      created.groups.push(runGroupId)
      await q('INSERT INTO platform_member_group_members (group_id, user_id, created_at) VALUES ($1::uuid, $2, now())', [runGroupId, f.T])

      // The barrier: the run takes this same table lock right after its inventory, so it parks there holding the
      // inventory's version rows and before its projection.
      const barrier = await pool.connect()
      let barrierOpen = false
      try {
        const barrierPid = Number((await barrier.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await barrier.query('BEGIN')
        barrierOpen = true
        await barrier.query('LOCK TABLE user_external_identities IN SHARE ROW EXCLUSIVE MODE')
        const run = settle(() => syncDirectoryIntegration(integrationId, 'system:y5a-ds03', 'manual'))
        const runPid = await waitForBlocked(barrierPid, /LOCK TABLE user_external_identities/)
        // Parked after the inventory: T's row is held by the run (a NOWAIT probe answers 55P03).
        expect(await versionRowState(f.T)).toBe('held')
        expect(await versionRowState(f.A)).toBe('held')
        // #6924's exception writer: actor A grants T — its one sorted bump waits on the run, at a version row.
        const writer = settle(() => writeLegacyAuthorizationException({ actorId: f.A, userId: f.T, action: { kind: 'direct.grant', code: f.perm } }))
        await waitForBlocked(runPid, new RegExp(SUBJECT_AUTHORIZATION_VERSIONS_TABLE))
        await barrier.query('ROLLBACK')
        barrierOpen = false
        const [runSide, writerSide] = await Promise.all([run, writer])
        expect({ run: runSide.result, writer: writerSide.result }).toEqual({ run: 'proceeded', writer: 'proceeded' })
      } finally {
        if (barrierOpen) await barrier.query('ROLLBACK').catch(() => undefined)
        barrier.release()
      }
      const members = await q('SELECT 1 FROM platform_member_group_members WHERE group_id = $1::uuid AND user_id = $2', [runGroupId, f.T])
      expect(members.rows).toHaveLength(0)
      const grant = await q('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [f.T, f.perm])
      expect(grant.rows).toHaveLength(1)
    }, 60_000)
  })
}
