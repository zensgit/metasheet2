import { describe, expect, it } from 'vitest'
import { AUTHORIZATION_OPERATION_FENCE_LOCK_SQL, AUTHORIZATION_OPERATION_FENCE_TABLES, AUTHORIZATION_OPERATION_SCHEMA_PROFILE, authorizationOperationD21AdditionDigest, inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'

describe('authorization operation schema profile', () => {
  it('requires the exact known digest and ordinary tables', () => {
    for (const digest of [
      AUTHORIZATION_OPERATION_SCHEMA_PROFILE,
      '1f2b2c96c6854cc87d374bf136f43f1b441a8dc8ed563cdd25a8a8fd0175adb1',
      '619f688920f9dfd66bd7a4bb3b4fd093251878409c82e66ef0f56b45c2420740',
      '19ef5b595d055ebd269bf58a4b8cd4312d95d022f4a2dcb9285c55d82346607d',
      'f29f6b75a23223a5784ea86ad9dac74deeb02ffbe17e89af3dff87ce799f7f02',
      '052c717a45feea6acd4cf5f2711917f4b1e59eef8d1c31aa3bb82c6c1a3e037f',
    ]) {
      expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest })).toBe(true)
      expect(isSupportedAuthorizationOperationSchema({ ordinary: false, digest })).toBe(false)
    }
    expect(isSupportedAuthorizationOperationSchema({ ordinary: false, digest: '20f8e9ab60e9a48287fd6c6034629bc0c2f1cf2eb4de7dd2059ec1c7e94ae534' })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({ ordinary:true, digest:'unknown' })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest: 'df64c6b5d2f1d1441bd5ce0fde9c63979123af3009cea573753b3b016f3f0925' })).toBe(false)
  })
  it('locks the closed table set, qualified and without waiting', () => {
    expect(AUTHORIZATION_OPERATION_FENCE_TABLES).toHaveLength(22)
    expect(new Set(AUTHORIZATION_OPERATION_FENCE_TABLES).size).toBe(22)
    expect(AUTHORIZATION_OPERATION_FENCE_LOCK_SQL.endsWith(' IN EXCLUSIVE MODE NOWAIT')).toBe(true)
    for (const table of AUTHORIZATION_OPERATION_FENCE_TABLES) expect(AUTHORIZATION_OPERATION_FENCE_LOCK_SQL).toContain(`"public"."${table}"`)
  })
  it('rejects missing tables, nonordinary relations, row security and untrusted ownership', async () => {
    const regular = () => AUTHORIZATION_OPERATION_FENCE_TABLES.map(relname => ({ relname, relkind:'r', relpersistence:'p', relispartition:false, relhassubclass:false, relrowsecurity:false, relforcerowsecurity:false, owner_trusted:true }))
    const inspect = async (tables: Array<Record<string, unknown>>, schemaTrusted=true, functionTrusted=true) => {
      let call=0
      return inspectAuthorizationOperationSchema(async () => {
        const index=call++
        return { rows: index===0 ? [{version:16,schema:'pg_catalog',schema_create_trusted:schemaTrusted}] : index===1 ? tables : index===8 ? [{owner_trusted:functionTrusted}] : [] }
      })
    }
    expect((await inspect(regular())).ordinary).toBe(true)
    expect((await inspect(regular().slice(1))).ordinary).toBe(false)
    for (const change of [{relkind:'v'},{relpersistence:'u'},{relispartition:true},{relhassubclass:true},{relrowsecurity:true},{relforcerowsecurity:true},{owner_trusted:false}]) {
      const tables=regular(); Object.assign(tables[0],change)
      expect((await inspect(tables)).ordinary, JSON.stringify(change)).toBe(false)
    }
    expect((await inspect(regular(),false)).ordinary).toBe(false)
    expect((await inspect(regular(),true,false)).ordinary).toBe(false)
  })

  it('hashes the D21 addition from exactly its six fenced-table triggers and two functions', () => {
    const d21Triggers = [
      'trg_platform_member_group_members_zz_authz_subject_version', 'trg_user_namespace_admissions_zz_authz_subject_version',
      'trg_user_permissions_zz_authz_subject_version', 'trg_user_roles_zz_authz_subject_version',
      'trg_users_zz_authz_subject_version_lifecycle', 'trg_users_zz_authz_subject_version_update',
    ]
    const catalog = () => {
      const rows: Array<Array<Record<string, unknown>>> = Array.from({ length: 8 }, () => [])
      rows[1].push({ relname: 'users', attname: 'role' })
      rows[4].push({ relname: 'users', tgname: 'trg_users_recovery_authority_lock_update', tgenabled: 'D' })
      rows[4].push({ relname: 'users', tgname: 'admin_grant_local_credential_version', tgenabled: 'O' })
      for (const tgname of d21Triggers) rows[4].push({ relname: 'x', tgname, tgenabled: 'O' })
      rows[7].push({ proname: 'metasheet_authz_bump_sheet_permission_version', definition: 'a' })
      rows[7].push({ proname: 'metasheet_authz_bump_subject_authorization_version', definition: 'b' })
      rows[7].push({ proname: 'admin_grant_local_credential_establishment_guard', definition: 'c' })
      rows[7].push({ proname: 'guard_repaired_directory_link', definition: 'd' })
      return rows
    }
    const original = authorizationOperationD21AdditionDigest(catalog())
    // Rows outside the addition (base and B2) do not move it.
    for (const edit of [
      (rows: ReturnType<typeof catalog>) => { rows[1][0].attname = 'is_admin' },
      (rows: ReturnType<typeof catalog>) => { rows[4][0].tgenabled = 'O' },
      (rows: ReturnType<typeof catalog>) => { rows[4][1].tgenabled = 'D' },
      (rows: ReturnType<typeof catalog>) => { rows[7][2].definition = 'changed' },
      (rows: ReturnType<typeof catalog>) => { rows[7][3].definition = 'changed' },
      (rows: ReturnType<typeof catalog>) => { rows[4].push({ relname: 'user_roles', tgname: 'trg_user_roles_zz_authz_subject_version_extra' }) },
    ]) {
      const rows = catalog(); edit(rows)
      expect(authorizationOperationD21AdditionDigest(rows)).toBe(original)
    }
    // Every one of its own rows does, including a missing one.
    for (const [section, index] of [[4, 2], [4, 3], [4, 4], [4, 5], [4, 6], [4, 7], [7, 0], [7, 1]] as const) {
      const changed = catalog(); changed[section][index] = { ...changed[section][index], tgenabled: 'D', definition: 'changed' }
      expect(authorizationOperationD21AdditionDigest(changed), `${section}:${index}`).not.toBe(original)
      const missing = catalog(); missing[section].splice(index, 1)
      expect(authorizationOperationD21AdditionDigest(missing), `${section}:${index} missing`).not.toBe(original)
    }
  })
})
