import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { AUTHORIZATION_OPERATION_FENCE_LOCK_SQL, AUTHORIZATION_OPERATION_FENCE_TABLES, AUTHORIZATION_OPERATION_SCHEMA_PROFILE, authorizationOperationD21AdditionDigest, authorizationOperationYidaLayoutAdditionDigest, inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'

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
      expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest, d21Ready: true })).toBe(true)
      expect(isSupportedAuthorizationOperationSchema({ ordinary: false, digest, d21Ready: true })).toBe(false)
    }
    expect(isSupportedAuthorizationOperationSchema({ ordinary: false, digest: '20f8e9ab60e9a48287fd6c6034629bc0c2f1cf2eb4de7dd2059ec1c7e94ae534', d21Ready: true })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({ ordinary:true, digest:'unknown', d21Ready: true })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest: 'df64c6b5d2f1d1441bd5ce0fde9c63979123af3009cea573753b3b016f3f0925', d21Ready: true })).toBe(false)
  })

  it('accepts only the full measured armed PG15 Alpine staging profile', () => {
    const digest = '49ffece37de8bb24ce108156bb1803170fe96c6ccf64a7c8b3ea3183add50d34'
    const baseDigest = 'e68f86e512384bede332535e0d51b8b164d1e880aadba5c0f439f5b9d2b8b2b9'
    expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest })).toBe(true)
    expect(isSupportedAuthorizationOperationSchema({ ordinary: false, digest })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest: baseDigest })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({
      ordinary: true,
      digest: 'unknown',
      baseDigest,
    })).toBe(false)
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
    const versionTable = () => [
      [{ relname: 'subject_authorization_versions', relkind: 'r', owner_trusted: true }],
      [{ relname: 'subject_authorization_versions', attname: 'subject_id', type: 'text', attnotnull: true }],
      [{ source: 'subject_authorization_versions', conname: 'subject_authorization_versions_pkey', contype: 'p', definition: 'PRIMARY KEY (subject_id)' }],
      [{ table_name: 'subject_authorization_versions', index_name: 'subject_authorization_versions_pkey', indisunique: true }],
      [], [], [],
    ] as Array<Array<Record<string, unknown>>>
    const original = authorizationOperationD21AdditionDigest(catalog(), versionTable())
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
      expect(authorizationOperationD21AdditionDigest(rows, versionTable())).toBe(original)
    }
    // Every one of its own rows does, including a missing one.
    for (const [section, index] of [[4, 2], [4, 3], [4, 4], [4, 5], [4, 6], [4, 7], [7, 0], [7, 1]] as const) {
      const changed = catalog(); changed[section][index] = { ...changed[section][index], tgenabled: 'D', definition: 'changed' }
      expect(authorizationOperationD21AdditionDigest(changed, versionTable()), `${section}:${index}`).not.toBe(original)
      const missing = catalog(); missing[section].splice(index, 1)
      expect(authorizationOperationD21AdditionDigest(missing, versionTable()), `${section}:${index} missing`).not.toBe(original)
    }
  })
  it('hashes the Y6 layout addition from exactly its one guard function', () => {
    const rows = (definition: string) => {
      const catalog: Array<Array<Record<string, unknown>>> = Array.from({ length: 8 }, () => [])
      catalog[4].push({ relname: 'users', tgname: 'trg_users_zz_authz_subject_version_update' })
      catalog[7].push({ proname: 'integration_yida_generated_layout_immutable_guard', definition })
      catalog[7].push({ proname: 'metasheet_authz_bump_subject_authorization_version', definition: 'd21' })
      return catalog
    }
    const original = authorizationOperationYidaLayoutAdditionDigest(rows('guard'))
    expect(authorizationOperationYidaLayoutAdditionDigest(rows('changed'))).not.toBe(original)
    const other = rows('guard'); other[7][1].definition = 'changed'; other[4][0].tgenabled = 'D'
    expect(authorizationOperationYidaLayoutAdditionDigest(other)).toBe(original)
    const missing = rows('guard'); missing[7].splice(0, 1)
    expect(authorizationOperationYidaLayoutAdditionDigest(missing)).not.toBe(original)
  })

  it('folds the D21 version table profile into the D21 addition, and refuses a schema whose D21 addition does not match', () => {
    const catalog = () => { const rows: Array<Array<Record<string, unknown>>> = Array.from({ length: 8 }, () => []); rows[4].push({ tgname: 'trg_user_roles_zz_authz_subject_version' }); return rows }
    const table = (pk: boolean) => [
      [{ relname: 'subject_authorization_versions', relkind: 'r' }],
      [{ attname: 'subject_id', type: 'text' }],
      pk ? [{ conname: 'subject_authorization_versions_pkey', contype: 'p', definition: 'PRIMARY KEY (subject_id)' }] : [],
      pk ? [{ index_name: 'subject_authorization_versions_pkey', indisunique: true }] : [],
      [], [], [],
    ] as Array<Array<Record<string, unknown>>>
    const original = authorizationOperationD21AdditionDigest(catalog(), table(true))
    expect(authorizationOperationD21AdditionDigest(catalog(), table(false))).not.toBe(original)
    expect(authorizationOperationD21AdditionDigest(catalog(), [])).not.toBe(original)
    const retyped = table(true); retyped[1][0].type = 'character varying'
    expect(authorizationOperationD21AdditionDigest(catalog(), retyped)).not.toBe(original)
    // An exact known profile alone no longer suffices: this code needs D21 on every path.
    expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest: AUTHORIZATION_OPERATION_SCHEMA_PROFILE, d21Ready: false })).toBe(false)
    expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest: AUTHORIZATION_OPERATION_SCHEMA_PROFILE, d21Ready: true })).toBe(true)
    // Required, and only a literal true passes: an omitted or non-boolean value refuses at runtime too.
    for (const loose of [{}, { d21Ready: undefined }, { d21Ready: 'true' }, { d21Ready: 1 }]) {
      expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest: AUTHORIZATION_OPERATION_SCHEMA_PROFILE, ...loose } as never), JSON.stringify(loose)).toBe(false)
    }
  })
})

type CatalogRow = Record<string, unknown>
type CatalogSnapshot = {
  database: CatalogRow
  inspection: { digest: string }
  rows: CatalogRow[][]
  partitions: { base: CatalogRow[][]; b2: CatalogRow[][]; n78: CatalogRow[][] }
  digests: { base: string; b2: string; n78: string }
}
const fixtureRoot = new URL('../fixtures/authorization-operation-catalog/', import.meta.url)
const manifest: { snapshots: Array<{ major: number; sha256: string }> } = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8'))
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// The captures above predate the YiDa stack. A database this code supports also carries D21 (six
// triggers on fenced tables, two functions, the version table) and the Y6 generated-layout guard, so
// every replay below adds those rows as measured; see the fixture README.
type StackAdditions = {
  d21: { digest: string; rows: CatalogRow[][]; versionTable: CatalogRow[][] }
  yidaLayout: { digest: string; rows: CatalogRow[][] }
}
const stack: StackAdditions = JSON.parse(readFileSync(new URL('stack-additions.json', fixtureRoot), 'utf8'))
const D21_DIGEST = '829ae23e6dab95d660cb84902adcafe02dc982109568f23b1e0627760f73bb76'
const YIDA_LAYOUT_DIGEST = 'bcd3224cc13d9701dc2da0f16b708e7ba012b4c22efc57f73d694b3b0ccf9432'

function withStack(rows: CatalogRow[][], parts: ReadonlyArray<'d21' | 'yidaLayout'> = ['d21', 'yidaLayout']): CatalogRow[][] {
  return rows.map((section, index) => [...section, ...parts.flatMap(part => stack[part].rows[index])])
}

async function inspectCatalog(database: CatalogRow, rows: CatalogRow[][], versionTable: CatalogRow[][] = stack.d21.versionTable) {
  let calls = 0
  const result = await inspectAuthorizationOperationSchema(async () => {
    const index = calls++
    return { rows: index === 0 ? [database] : index <= 8 ? rows[index - 1] : versionTable[index - 9] ?? [] }
  })
  // The database row, the eight catalog sections, then the seven table-scoped sections again for the D21 version table.
  expect(calls).toBe(16)
  return result
}

describe('measured YiDa stack additions', () => {
  it('carry exactly the pinned D21 and Y6 layout digests', () => {
    expect(stack.d21.rows.map(section => section.length)).toEqual([0, 0, 0, 0, 6, 0, 0, 2])
    expect(stack.yidaLayout.rows.map(section => section.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(stack.d21.versionTable).toHaveLength(7)
    expect(authorizationOperationD21AdditionDigest(stack.d21.rows, stack.d21.versionTable)).toBe(D21_DIGEST)
    expect(authorizationOperationYidaLayoutAdditionDigest(stack.yidaLayout.rows)).toBe(YIDA_LAYOUT_DIGEST)
    expect([stack.d21.digest, stack.yidaLayout.digest]).toEqual([D21_DIGEST, YIDA_LAYOUT_DIGEST])
  })
})

function withoutPartition(snapshot: CatalogSnapshot, partition: CatalogRow[][]): CatalogRow[][] {
  return snapshot.rows.map((rows, section) => {
    const removed = new Set(partition[section].map(row => JSON.stringify(row)))
    return rows.filter(row => !removed.has(JSON.stringify(row)))
  })
}

describe.each(manifest.snapshots)('measured PostgreSQL $major authorization catalog', ({ major, sha256 }) => {
  const bytes = gunzipSync(readFileSync(new URL(`pg${major}.json.gz`, fixtureRoot)))
  const snapshot: CatalogSnapshot = JSON.parse(bytes.toString('utf8'))

  it('preserves measured catalog bytes and independent partition digests', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
    expect(snapshot.database.version).toBe(major)
    expect(digest({ database: snapshot.database, rows: snapshot.rows })).toBe(snapshot.inspection.digest)
    expect(digest({ database: snapshot.database, rows: snapshot.partitions.base })).toBe(snapshot.digests.base)
    expect(digest(snapshot.partitions.b2)).toBe('c8b8994bc64060dde36280a452662854741816a88091d1b2280d7f3f1ca0f743')
    expect(digest(snapshot.partitions.n78)).toBe('ebb4eb31cb35209de3785b867c41c17093032eaf2eccc7ebd3912f56f0b3f515')
  })

  it(`accepts measured N78 and B2 additions with the original exact profile (PG${major})`, async () => {
    const result = await inspectCatalog(snapshot.database, withStack(snapshot.rows))
    expect(result.baseDigest).toBe(snapshot.digests.base)
    expect(result.ordinary).toBe(true)
    expect(result.d21Ready).toBe(true)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(true)
  })

  it(`replays the capture byte for byte and refuses it without the stack additions (PG${major})`, async () => {
    const captured = await inspectCatalog(snapshot.database, snapshot.rows, [])
    expect(captured.digest).toBe(snapshot.inspection.digest)
    expect(captured.ordinary).toBe(true)
    expect(captured.d21Ready).toBe(false)
    expect(isSupportedAuthorizationOperationSchema(captured)).toBe(false)
  })

  it(`refuses a catalog that lacks the D21 addition, its version table or the Y6 layout guard (PG${major})`, async () => {
    const noD21 = await inspectCatalog(snapshot.database, withStack(snapshot.rows, ['yidaLayout']))
    expect(noD21.baseDigest).toBe(snapshot.digests.base)
    expect(noD21.d21Ready).toBe(false)
    expect(isSupportedAuthorizationOperationSchema(noD21)).toBe(false)
    const noVersionTable = await inspectCatalog(snapshot.database, withStack(snapshot.rows), [])
    expect(noVersionTable.d21Ready).toBe(false)
    expect(isSupportedAuthorizationOperationSchema(noVersionTable)).toBe(false)
    const noLayout = await inspectCatalog(snapshot.database, withStack(snapshot.rows, ['d21']))
    expect(noLayout.d21Ready).toBe(true)
    expect(noLayout.baseDigest).toBeUndefined()
    expect(isSupportedAuthorizationOperationSchema(noLayout)).toBe(false)
  })

  it(`preserves the B2-only historical profile; the pre-B2 profile cannot carry D21 (PG${major})`, async () => {
    const b2Only = await inspectCatalog(snapshot.database, withStack(withoutPartition(snapshot, snapshot.partitions.n78)))
    expect(b2Only.baseDigest).toBe(snapshot.digests.base)
    expect(isSupportedAuthorizationOperationSchema(b2Only)).toBe(true)
    // The exact pre-B2 profile still hashes to its known digest, but it has no D21, and this code
    // bumps D21's version rows in every authorization write.
    const original = await inspectCatalog(snapshot.database, snapshot.partitions.base, [])
    expect(original.digest).toBe(snapshot.digests.base)
    expect(original.d21Ready).toBe(false)
    expect(isSupportedAuthorizationOperationSchema(original)).toBe(false)
    // With D21 added its digest is no longer the exact one, and the base path keeps B2 mandatory.
    const originalWithStack = await inspectCatalog(snapshot.database, withStack(snapshot.partitions.base))
    expect(originalWithStack.d21Ready).toBe(true)
    expect(originalWithStack.baseDigest).toBeUndefined()
    expect(isSupportedAuthorizationOperationSchema(originalWithStack)).toBe(false)
  })

  // The cases above show that a missing stack addition is refused. These show that a changed one is:
  // every row of D21, of its version table and of the Y6 guard is compared by content, and a row that
  // only resembles a registered one is not set aside with them.
  it.each([
    ['a disabled D21 trigger', (rows: CatalogRow[][]) => { rows[4].find(row => row.tgname === 'trg_user_roles_zz_authz_subject_version')!.tgenabled = 'D' }],
    ['a changed D21 trigger definition', (rows: CatalogRow[][]) => { const row = rows[4].find(r => r.tgname === 'trg_users_zz_authz_subject_version_update')!; row.definition = `${String(row.definition)} ` }],
    ['a changed D21 function body', (rows: CatalogRow[][]) => { const row = rows[7].find(r => r.proname === 'metasheet_authz_bump_subject_authorization_version')!; row.definition = `${String(row.definition)}\n` }],
    ['a D21 function made SECURITY DEFINER', (rows: CatalogRow[][]) => { rows[7].find(row => row.proname === 'metasheet_authz_bump_sheet_permission_version')!.prosecdef = true }],
    ['a registered D21 trigger name on another table', (rows: CatalogRow[][]) => { rows[4].push({ ...rows[4].find(row => row.tgname === 'trg_user_roles_zz_authz_subject_version')!, relname: 'roles' }) }],
  ] as Array<[string, (rows: CatalogRow[][]) => void]>)(`refuses %s (PG${major})`, async (_name, change) => {
    const rows = structuredClone(withStack(snapshot.rows))
    change(rows)
    const result = await inspectCatalog(snapshot.database, rows)
    // B2, N78, the Y6 guard and the base are untouched: D21 alone refuses it.
    expect(result.baseDigest).toBe(snapshot.digests.base)
    expect(result.d21Ready).toBe(false)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(false)
  })

  it.each([
    ['a retyped key column', (table: CatalogRow[][]) => { table[1].find(row => row.attname === 'subject_id')!.type = 'character varying' }],
    ['a nullable version column', (table: CatalogRow[][]) => { table[1].find(row => row.attname === 'version')!.attnotnull = false }],
    ['no primary key', (table: CatalogRow[][]) => { table[2].length = 0; table[3].length = 0 }],
    ['a trigger of its own', (table: CatalogRow[][]) => { table[4].push({ relname: 'subject_authorization_versions', tgname: 'unregistered_trigger', tgenabled: 'O' }) }],
    ['row security', (table: CatalogRow[][]) => { table[0][0].relrowsecurity = true }],
  ] as Array<[string, (table: CatalogRow[][]) => void]>)(`refuses a D21 version table with %s (PG${major})`, async (_name, change) => {
    const versionTable = structuredClone(stack.d21.versionTable)
    change(versionTable)
    const result = await inspectCatalog(snapshot.database, withStack(snapshot.rows), versionTable)
    expect(result.baseDigest).toBe(snapshot.digests.base)
    expect(result.d21Ready).toBe(false)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(false)
  })

  it.each([
    ['a changed Y6 guard body', true, (rows: CatalogRow[][]) => { const row = rows[7].find(r => r.proname === 'integration_yida_generated_layout_immutable_guard')!; row.definition = `${String(row.definition)}\n` }],
    ['a Y6 guard owned by an untrusted role', false, (rows: CatalogRow[][]) => { rows[7].find(row => row.proname === 'integration_yida_generated_layout_immutable_guard')!.owner_trusted = false }],
    ['a trigger that only resembles D21', true, (rows: CatalogRow[][]) => { rows[4].push({ ...rows[4].find(row => row.tgname === 'trg_user_roles_zz_authz_subject_version')!, tgname: 'trg_user_roles_zz_authz_subject_version_extra' }) }],
    ['a function that only resembles D21', true, (rows: CatalogRow[][]) => { rows[7].push({ ...rows[7].find(row => row.proname === 'metasheet_authz_bump_subject_authorization_version')!, proname: 'metasheet_authz_bump_subject_authorization_version_v2' }) }],
    ['a function that only resembles the Y6 guard', true, (rows: CatalogRow[][]) => { rows[7].push({ ...rows[7].find(row => row.proname === 'integration_yida_generated_layout_immutable_guard')!, proname: 'integration_yida_generated_layout_immutable_guard_v2' }) }],
  ] as Array<[string, boolean, (rows: CatalogRow[][]) => void]>)(`refuses %s although D21 is intact (PG${major})`, async (_name, ordinary, change) => {
    const rows = structuredClone(withStack(snapshot.rows))
    change(rows)
    const result = await inspectCatalog(snapshot.database, rows)
    // D21 still matches. An untrusted owner is caught by the ownership check and by the Y6 digest,
    // each on its own; every other row by the Y6 digest or the base digest alone.
    expect(result.d21Ready).toBe(true)
    expect(result.ordinary).toBe(ordinary)
    expect(result.baseDigest).not.toBe(snapshot.digests.base)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(false)
  })

  it('rejects N78 without the complete B2 addition', async () => {
    const result = await inspectCatalog(snapshot.database, withStack(withoutPartition(snapshot, snapshot.partitions.b2)))
    expect(result.d21Ready).toBe(true)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(false)
  })

  it.each([
    ['source_schema', 'unregistered'], ['source', 'unregistered_inbound_dependency'],
    ['conname', 'ncv_drift_fk'], ['contype', 'c'], ['convalidated', false],
    ['condeferrable', true], ['condeferred', true], ['connoinherit', false],
    ['target_schema', 'unregistered'], ['target', 'roles'],
    ['definition', 'FOREIGN KEY (connection_id, provider) REFERENCES directory_integrations(id, provider) ON UPDATE RESTRICT ON DELETE CASCADE'],
  ])(`rejects changed N78 %s despite the registered source (PG${major})`, async (field, value) => {
    const rows = structuredClone(withStack(snapshot.rows))
    const n78 = rows[2].find(row => row.source === 'notification_connection_verifications')!
    n78[String(field)] = value
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each([
    ['registered N78', 'notification_connection_verifications'],
    ['unregistered', 'unregistered_inbound_dependency'],
  ])(`rejects an extra inbound foreign key from the %s source (PG${major})`, async (_name, source) => {
    const rows = structuredClone(withStack(snapshot.rows))
    rows[2].push({ ...snapshot.partitions.n78[2][0], source, conname: 'ncv_extra_fk' })
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each(['base', 'b2'] as const)('still rejects %s drift when N78 is valid', async partition => {
    const rows = structuredClone(withStack(snapshot.rows))
    const original = snapshot.partitions[partition][2][0]
    const changed = rows[2].find(row => row.source === original.source && row.conname === original.conname)!
    changed.conname = 'unregistered_constraint'
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each([
    ['version', 18], ['datcollate', 'unregistered'], ['datctype', 'unregistered'],
    ['datlocprovider', 'unregistered'], ['schema_create_trusted', false],
  ])('rejects unqualified database %s with valid additions', async (field, value) => {
    const database = { ...snapshot.database, [String(field)]: value }
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(database, withStack(snapshot.rows)))).toBe(false)
  })
})
