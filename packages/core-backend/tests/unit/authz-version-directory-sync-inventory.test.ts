/**
 * D21 (slice Y5a) x refute [1]: directory sync takes every subject version row its run can touch in
 * ONE sorted statement, before its first bump. The local-apply transaction used to take them in two:
 * the mutex inventory, then the member-group projection's removal bump for a member the inventory
 * never read (any user an administrator added to a projected group). On real PG14 that second
 * statement closed a 40P01 cycle against #6924's exception writers and #6934's activation route, which
 * bump actor + target in one sorted statement (real-DB witness: DS-01 in
 * tests/integration/authz-version-directory-sync-order-realdb.cases.ts).
 *
 * Pinned here with a recording client, no database:
 *   I-01  the inventory's candidate query reads the current members of the run's projected groups
 *         (one arm, the markers bound as $8), and the inventory issues exactly ONE version-row
 *         statement, sorted, covering that member, before its first users row lock;
 *   I-02  the markers the inventory reads are a superset of the markers the plans write, and empty
 *         when projection is off;
 *   I-03  the projection refuses a membership change for a subject the transaction does not hold,
 *         before that plan's version-row statement or DML (per plan: with several plans, an earlier
 *         plan's bump and DML have already run and roll back with the throw); a held subject gets
 *         one bump, then the DELETE;
 *   I-04  the orchestration passes both: the markers from the run's config (only the configured
 *         departments this run fetched, so a department absent from the payload locks nobody), the
 *         held set from the inventory plus the users it admitted;
 *   I-05  the projected default roles are taken FOR KEY SHARE, sorted, in one statement, after the
 *         freeze lock and before the inventory's bump (the writer rule: locks outside the holder's
 *         set first). Witnessed on real PG14 with the legacy 033 FK added by hand to a throwaway
 *         database (out of CI on purpose: adding that FK to the shared CI database would change the
 *         schema every other real-DB file sees).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

import {
  DirectoryConflictError,
  __directorySyncInternalsForTests,
  buildDirectoryProjectedMemberGroupMarkers,
  buildDirectoryProjectedMemberGroupPlans,
} from '../../src/directory/directory-sync'

type Recorded = { sql: string; params: unknown[] }

const BUMP = /INSERT INTO subject_authorization_versions/
const USERS_LOCK = /FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/
const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000d1'
const TARGET = 'y5ar2-a-target'
const ADMIN = 'y5ar2-b-admin'

function recordingClient(answer: (sql: string, params: unknown[]) => Array<Record<string, unknown>>) {
  const calls: Recorded[] = []
  return {
    calls,
    client: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params })
        return { rows: answer(sql, params), rowCount: 0 }
      },
    },
  }
}

describe('D21 directory sync takes its version rows in one sorted statement (refute [1])', () => {
  it('I-01 the inventory reads the projected groups\' current members and bumps them in its one sorted statement, before the users rows', async () => {
    const markers = buildDirectoryProjectedMemberGroupMarkers({
      integrationId: INTEGRATION_ID,
      memberGroupSyncMode: 'sync_scoped_departments',
      memberGroupDepartmentIds: ['d-1'],
    })
    const { calls, client } = recordingClient((sql) => {
      if (sql.includes('SELECT DISTINCT candidate.local_user_id')) return [{ local_user_id: ADMIN }, { local_user_id: TARGET }]
      if (USERS_LOCK.test(sql)) return [{ id: 'row' }]
      return []
    })

    const inventory = await __directorySyncInternalsForTests.lockDirectorySyncAccessGraphUsers(client as never, {
      integrationId: INTEGRATION_ID,
      provider: 'dingtalk',
      users: [],
      projectedGroupMarkers: markers,
    })

    const candidates = calls.find((call) => call.sql.includes('SELECT DISTINCT candidate.local_user_id'))
    expect(candidates?.sql).toMatch(/SELECT projected_member\.user_id\s+FROM platform_member_group_members projected_member\s+JOIN platform_member_groups projected_group\s+ON projected_group\.id = projected_member\.group_id\s+WHERE projected_group\.description = ANY\(\$8::text\[\]\)/)
    expect(candidates?.params[7]).toEqual([`dingtalk-sync-group:${INTEGRATION_ID}:d-1`])
    const bumps = calls.filter((call) => BUMP.test(call.sql))
    expect(bumps).toHaveLength(1)
    expect(bumps[0]!.params[0]).toEqual([TARGET, ADMIN].sort())
    const bumpAt = calls.indexOf(bumps[0]!)
    const firstUsersLockAt = calls.findIndex((call) => USERS_LOCK.test(call.sql))
    expect(firstUsersLockAt).toBeGreaterThan(bumpAt)
    expect(calls.slice(0, bumpAt).some((call) => /FOR UPDATE|INSERT INTO|DELETE FROM/.test(call.sql))).toBe(false)
    expect(inventory.lockedUserIds).toEqual(new Set([ADMIN, TARGET]))
  })

  it('I-02 the inventory\'s markers are a superset of the plans\' markers, and empty when projection is off', () => {
    const departments = new Map([
      ['d-1', { id: 'd-1', parentId: null, name: 'One' }],
      ['d-2', { id: 'd-2', parentId: 'd-1', name: 'Two' }],
    ])
    const common = {
      integrationId: INTEGRATION_ID,
      memberGroupDepartmentIds: [' d-2 ', 'd-1', 'd-missing', '', 'd-1'],
    }
    const plans = buildDirectoryProjectedMemberGroupPlans({
      ...common,
      integrationName: 'n',
      memberGroupSyncMode: 'sync_scoped_departments',
      departments: departments as never,
      departmentPathMap: new Map(),
      userDepartmentIdsByExternalUserId: new Map(),
      linkedUserIdByExternalUserId: new Map(),
    })
    const markers = buildDirectoryProjectedMemberGroupMarkers({ ...common, memberGroupSyncMode: 'sync_scoped_departments' })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) expect(markers).toContain(plan.marker)
    expect(markers).toEqual([...new Set(markers)].sort())
    expect(markers).toHaveLength(3)
    expect(buildDirectoryProjectedMemberGroupMarkers({ ...common, memberGroupSyncMode: 'disabled' })).toEqual([])
  })

  const projectionClient = () => recordingClient((sql) => {
    if (sql.includes('FROM platform_member_groups') && sql.includes('description = ANY')) return [{ id: 'g-1', description: `dingtalk-sync-group:${INTEGRATION_ID}:d-1` }]
    if (sql.includes('SELECT user_id') && sql.includes('FROM platform_member_group_members')) return [{ user_id: TARGET }]
    return []
  })
  const plan = { externalDepartmentId: 'd-1', name: 'n', marker: `dingtalk-sync-group:${INTEGRATION_ID}:d-1`, memberUserIds: [ADMIN] }

  it('I-03a the projection refuses a change for a subject the transaction does not hold, before any version-row statement or DML', async () => {
    const { calls, client } = projectionClient()
    await expect(__directorySyncInternalsForTests.syncProjectedDepartmentMemberGroupsInTransaction(
      client as never, [plan], { defaultRoleIds: [], defaultNamespaces: [], heldUserIds: new Set([ADMIN]) }, 'system:test',
    )).rejects.toBeInstanceOf(DirectoryConflictError)
    expect(calls.some((call) => BUMP.test(call.sql))).toBe(false)
    expect(calls.some((call) => /DELETE FROM platform_member_group_members|INSERT INTO platform_member_group_members/.test(call.sql))).toBe(false)
  })

  it('I-03b a held subject: one sorted bump over the removed and added members, then the DELETE', async () => {
    const { calls, client } = projectionClient()
    await __directorySyncInternalsForTests.syncProjectedDepartmentMemberGroupsInTransaction(
      client as never, [plan], { defaultRoleIds: [], defaultNamespaces: [], heldUserIds: new Set([ADMIN, TARGET]) }, 'system:test',
    )
    const bumps = calls.filter((call) => BUMP.test(call.sql))
    expect(bumps).toHaveLength(1)
    expect(bumps[0]!.params[0]).toEqual([TARGET, ADMIN].sort())
    const deleteAt = calls.findIndex((call) => call.sql.includes('DELETE FROM platform_member_group_members'))
    expect(deleteAt).toBeGreaterThan(calls.indexOf(bumps[0]!))
  })

  it('I-04 the orchestration passes the run\'s markers to the inventory and the held set to the projection', () => {
    const source = readFileSync(path.join(__dirname, '../../src/directory/directory-sync.ts'), 'utf8')
    // The markers come only from configured departments this run fetched (the plans' marker set exactly).
    expect(source).toMatch(/const projectedGroupMarkers = buildDirectoryProjectedMemberGroupMarkers\(\{\s*integrationId,\s*memberGroupSyncMode: config\.memberGroupSyncMode,\s*memberGroupDepartmentIds: config\.memberGroupDepartmentIds\.filter\(\(id\) => departments\.has\(normalizeText\(id\)\)\),\s*\}\)/)
    expect(source).toMatch(/const syncAccess = await lockDirectorySyncAccessGraphUsers\(client, \{\s*integrationId,\s*provider: integration\.provider,\s*users: Array\.from\(users\.values\(\)\),\s*projectedGroupMarkers,\s*\}\)/)
    expect(source).toMatch(/syncProjectedDepartmentMemberGroupsInTransaction\(\s*client,\s*memberGroupPlans,\s*\{\s*defaultRoleIds: config\.memberGroupDefaultRoleIds,\s*defaultNamespaces: config\.memberGroupDefaultNamespaces,\s*heldUserIds: new Set\(\[\.\.\.syncAccess\.lockedUserIds, \.\.\.newlyAdmittedUserIds\]\),\s*\},/)
    // The projection builds its plans from the same config the markers come from.
    expect(source).toMatch(/buildDirectoryProjectedMemberGroupPlans\(\{\s*integrationId,\s*integrationName: integration\.name,\s*memberGroupSyncMode: config\.memberGroupSyncMode,\s*memberGroupDepartmentIds: config\.memberGroupDepartmentIds,/)
  })

  it('I-05 the projected default roles are taken FOR KEY SHARE (sorted, one statement) after the freeze lock and before the inventory, only when something is projected', () => {
    const source = readFileSync(path.join(__dirname, '../../src/directory/directory-sync.ts'), 'utf8')
    const freezeAt = source.indexOf('await acquireSourceSyncFreezeLock(client, integrationId)')
    const freezeCheckAt = source.indexOf('await assertDirectorySyncNotFrozenByTransfer(integrationId, client as FreezeCheckClient)', freezeAt)
    const rolesAt = source.indexOf("'SELECT id FROM roles WHERE id = ANY($1::text[]) ORDER BY id FOR KEY SHARE'", freezeCheckAt)
    const inventoryAt = source.indexOf('const syncAccess = await lockDirectorySyncAccessGraphUsers(client, {', freezeCheckAt)
    expect(freezeAt).toBeGreaterThan(0)
    expect(freezeCheckAt).toBeGreaterThan(freezeAt)
    expect(rolesAt).toBeGreaterThan(freezeCheckAt)
    expect(inventoryAt).toBeGreaterThan(rolesAt)
    // Exactly one such statement in the module: the governance path takes no other role lock of its own.
    expect(source.split('ORDER BY id FOR KEY SHARE').length - 1).toBe(1)
    // Gated: no statement unless the run projects a group and a default role is configured.
    const between = source.slice(freezeCheckAt, inventoryAt)
    expect(between).toMatch(/const projectedDefaultRoleIds = projectedGroupMarkers\.length > 0\s*\? normalizeMemberGroupDefaultRoleIds\(config\.memberGroupDefaultRoleIds\)\s*: \[\]\s*if \(projectedDefaultRoleIds\.length > 0\) \{\s*await client\.query\(\s*'SELECT id FROM roles WHERE id = ANY\(\$1::text\[\]\) ORDER BY id FOR KEY SHARE',\s*\[projectedDefaultRoleIds\],\s*\)\s*\}/)
  })
})
