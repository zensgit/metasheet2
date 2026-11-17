import { describe, expect, it } from 'vitest'
import { AUTHORIZATION_OPERATION_FENCE_LOCK_SQL, AUTHORIZATION_OPERATION_FENCE_TABLES, AUTHORIZATION_OPERATION_SCHEMA_PROFILE, inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'

describe('authorization operation schema profile', () => {
  it('requires the exact known digest and ordinary tables', () => {
    for (const digest of [
      AUTHORIZATION_OPERATION_SCHEMA_PROFILE,
      '94de1430caedfb986f98cea97e6231e78a0395a38264b923fb397c558a366587',
      '85b365bcf6a9ddaee891ede0c3f8eead2c66d52cf28f314ae35d4a4279513fe0',
    ]) {
      expect(isSupportedAuthorizationOperationSchema({ ordinary: true, digest })).toBe(true)
      expect(isSupportedAuthorizationOperationSchema({ ordinary: false, digest })).toBe(false)
    }
    expect(isSupportedAuthorizationOperationSchema({ ordinary:true, digest:'unknown' })).toBe(false)
  })
  it('locks the closed table set, qualified and without waiting', () => {
    expect(AUTHORIZATION_OPERATION_FENCE_TABLES).toHaveLength(21)
    expect(new Set(AUTHORIZATION_OPERATION_FENCE_TABLES).size).toBe(21)
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
