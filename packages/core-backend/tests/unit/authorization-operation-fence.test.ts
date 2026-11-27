import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { AUTHORIZATION_OPERATION_FENCE_LOCK_SQL, AUTHORIZATION_OPERATION_FENCE_TABLES, AUTHORIZATION_OPERATION_SCHEMA_PROFILE, inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'

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

async function inspectCatalog(database: CatalogRow, rows: CatalogRow[][]) {
  let calls = 0
  const result = await inspectAuthorizationOperationSchema(async () => ({ rows: calls++ === 0 ? [database] : rows[calls - 2] }))
  expect(calls).toBe(9)
  return result
}

function withoutPartition(snapshot: { rows: CatalogRow[][] }, partition: CatalogRow[][]): CatalogRow[][] {
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
    const result = await inspectCatalog(snapshot.database, snapshot.rows)
    expect(result.digest).toBe(snapshot.inspection.digest)
    expect(result.baseDigest).toBe(snapshot.digests.base)
    expect(result.ordinary).toBe(true)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(true)
  })

  it(`preserves original and B2-only historical profiles (PG${major})`, async () => {
    for (const rows of [snapshot.partitions.base, withoutPartition(snapshot, snapshot.partitions.n78)]) {
      const result = await inspectCatalog(snapshot.database, rows)
      expect(result.baseDigest ?? result.digest).toBe(snapshot.digests.base)
      expect(isSupportedAuthorizationOperationSchema(result)).toBe(true)
    }
  })

  it('rejects N78 without the complete B2 addition', async () => {
    const result = await inspectCatalog(snapshot.database, withoutPartition(snapshot, snapshot.partitions.b2))
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(false)
  })

  it.each([
    ['source_schema', 'unregistered'], ['source', 'unregistered_inbound_dependency'],
    ['conname', 'ncv_drift_fk'], ['contype', 'c'], ['convalidated', false],
    ['condeferrable', true], ['condeferred', true], ['connoinherit', false],
    ['target_schema', 'unregistered'], ['target', 'roles'],
    ['definition', 'FOREIGN KEY (connection_id, provider) REFERENCES directory_integrations(id, provider) ON UPDATE RESTRICT ON DELETE CASCADE'],
  ])(`rejects changed N78 %s despite the registered source (PG${major})`, async (field, value) => {
    const rows = structuredClone(snapshot.rows)
    const n78 = rows[2].find(row => row.source === 'notification_connection_verifications')!
    n78[String(field)] = value
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each([
    ['registered N78', 'notification_connection_verifications'],
    ['unregistered', 'unregistered_inbound_dependency'],
  ])(`rejects an extra inbound foreign key from the %s source (PG${major})`, async (_name, source) => {
    const rows = structuredClone(snapshot.rows)
    rows[2].push({ ...snapshot.partitions.n78[2][0], source, conname: 'ncv_extra_fk' })
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each(['base', 'b2'] as const)('still rejects %s drift when N78 is valid', async partition => {
    const rows = structuredClone(snapshot.rows)
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
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(database, snapshot.rows))).toBe(false)
  })
})

type RoutingCatalogSnapshot = {
  database: CatalogRow
  rows: CatalogRow[][]
  status: string
  errors: unknown[]
  actual: { digest: string }
  actualSupported: boolean
  routingAddition: CatalogRow[][]
  routingAdditionDigest: string
  withoutRouting: { digest: string; baseDigest: string }
  withoutRoutingSupported: boolean
}
const routingFixtureRoot = new URL('routing/', fixtureRoot)
const routingManifest: typeof manifest = JSON.parse(readFileSync(new URL('manifest.json', routingFixtureRoot), 'utf8'))

describe.each(routingManifest.snapshots)('measured PostgreSQL $major routing catalog', ({ major, sha256 }) => {
  const bytes = gunzipSync(readFileSync(new URL(`pg${major}.json.gz`, routingFixtureRoot)))
  const snapshot: RoutingCatalogSnapshot = JSON.parse(bytes.toString('utf8'))
  const routingSource = 'org_notification_topic_policies'
  const definition = 'FOREIGN KEY (default_connection_id, org_id) REFERENCES directory_integrations(id, org_id) ON UPDATE RESTRICT ON DELETE RESTRICT'

  it('preserves the original measured routing capture and digest', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
    expect(snapshot.status).toBe('passed')
    expect(snapshot.errors).toEqual([])
    expect(snapshot.database.version).toBe(major)
    expect(snapshot.actualSupported).toBe(false)
    expect(snapshot.withoutRoutingSupported).toBe(true)
    expect(digest({ database: snapshot.database, rows: snapshot.rows })).toBe(snapshot.actual.digest)
    expect(snapshot.routingAddition.map(rows => rows.length)).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(snapshot.routingAddition[2][0].definition).toBe(definition)
    expect(digest(snapshot.routingAddition)).toBe(snapshot.routingAdditionDigest)
    expect(snapshot.routingAdditionDigest).toBe('c7b4ab678e7c9bc25ecd9a24bef2de5e5f4e21af818d18aba573c9cd367f4564')
  })

  it(`accepts measured routing with N78 and B2 using the original profile (PG${major})`, async () => {
    const result = await inspectCatalog(snapshot.database, snapshot.rows)
    expect(result.digest).toBe(snapshot.actual.digest)
    expect(result.baseDigest).toBe(snapshot.withoutRouting.baseDigest)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(true)
  })

  it(`accepts the empty routing partition as pre-M06c history (PG${major})`, async () => {
    // The sole FK being deleted is indistinguishable from M06c never having run.
    const result = await inspectCatalog(snapshot.database, withoutPartition(snapshot, snapshot.routingAddition))
    expect(result.digest).toBe(snapshot.withoutRouting.digest)
    expect(result.baseDigest).toBe(snapshot.withoutRouting.baseDigest)
    expect(isSupportedAuthorizationOperationSchema(result)).toBe(true)
  })

  it.each([
    ['source_schema', 'unregistered'], ['source', 'unregistered_inbound_dependency'],
    ['conname', 'ontp_drift_fk'], ['contype', 'c'], ['convalidated', false],
    ['condeferrable', true], ['condeferred', true], ['connoinherit', false],
    ['target_schema', 'unregistered'], ['target', 'roles'],
  ])(`rejects changed routing %s despite the registered source (PG${major})`, async (field, value) => {
    const rows = structuredClone(snapshot.rows)
    rows[2].find(row => row.source === routingSource)![String(field)] = value
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each([
    ['delete action', definition.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE')],
    ['update action', definition.replace('ON UPDATE RESTRICT', 'ON UPDATE CASCADE')],
    ['target table', definition.replace('directory_integrations', 'roles')],
    ['target column', definition.replace('REFERENCES directory_integrations(id, org_id)', 'REFERENCES directory_integrations(id, provider)')],
    ['source column', definition.replace('default_connection_id', 'other_connection_id')],
    ['missing key column', 'FOREIGN KEY (default_connection_id) REFERENCES directory_integrations(id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ])(`rejects changed routing %s definition (PG${major})`, async (_name, value) => {
    const rows = structuredClone(snapshot.rows)
    rows[2].find(row => row.source === routingSource)!.definition = value
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each([routingSource, 'unregistered_inbound_dependency'])(`rejects an extra routing foreign key from %s (PG${major})`, async source => {
    const rows = structuredClone(snapshot.rows)
    rows[2].push({ ...snapshot.routingAddition[2][0], source, conname: 'ontp_extra_fk' })
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each(['users', 'user_external_identity_evidence', 'directory_connection_login_scope'])(`rejects a missing constraint from %s with valid routing (PG${major})`, async source => {
    const rows = structuredClone(snapshot.rows)
    const index = rows[2].findIndex(row => row.source === source)
    expect(index).toBeGreaterThanOrEqual(0)
    rows[2].splice(index, 1)
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })

  it.each(['users', 'user_external_identity_evidence', 'notification_connection_verifications'])(`rejects changed constraint from %s with valid routing (PG${major})`, async source => {
    const rows = structuredClone(snapshot.rows)
    rows[2].find(row => row.source === source)!.conname = 'unregistered_constraint'
    expect(isSupportedAuthorizationOperationSchema(await inspectCatalog(snapshot.database, rows))).toBe(false)
  })
})
