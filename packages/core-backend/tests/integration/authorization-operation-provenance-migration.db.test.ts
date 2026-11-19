import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261117130000_add_user_role_assignment_source'

const url=process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if(url) {const u=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.pathname!=='/permission_command_fence_test') throw new Error('isolated synthetic database required')}
const suite=url?describe:describe.skip
suite('role assignment source migration',()=>{
  const schema=`provenance_${randomUUID().replaceAll('-','')}`
  const control=new Client({connectionString:url})
  let db:Kysely<unknown>
  beforeAll(async()=>{
    await control.connect();await control.query(`CREATE SCHEMA "${schema}"`)
    await control.query(`CREATE TABLE "${schema}".user_roles(user_id text,role_id text,PRIMARY KEY(user_id,role_id)); INSERT INTO "${schema}".user_roles VALUES ('old','ordinary')`)
    db=new Kysely({dialect:new PostgresDialect({pool:new Pool({connectionString:url,options:`-c search_path=${schema}`})})})
  })
  afterAll(async()=>{if(db)await db.destroy();await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await control.end()})
  it('leaves old records unknown, constrains new values and refuses lossy down',async()=>{
    await db.transaction().execute(tx=>up(tx))
    expect((await control.query(`SELECT assignment_source FROM "${schema}".user_roles WHERE user_id='old'`)).rows[0].assignment_source).toBeNull()
    await expect(control.query(`INSERT INTO "${schema}".user_roles VALUES ('invalid','ordinary','invented')`)).rejects.toMatchObject({code:'23514'})
    await control.query(`INSERT INTO "${schema}".user_roles VALUES ('new','ordinary','creation')`)
    await expect(db.transaction().execute(tx=>down(tx))).rejects.toThrow('USER_ROLE_ASSIGNMENT_PROVENANCE_PRESENT')
    expect((await control.query(`SELECT assignment_source FROM "${schema}".user_roles WHERE user_id='new'`)).rows[0].assignment_source).toBe('creation')
    await control.query(`UPDATE "${schema}".user_roles SET assignment_source=NULL`)
    await db.transaction().execute(tx=>down(tx))
    expect((await control.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',[schema,'user_roles','assignment_source'])).rows).toEqual([])
  })
  ;(process.env.PERMISSION_PROVENANCE_TEST_LOCK_RACE==='1' ? it : it.skip)('holds a table lock through the down evidence check and excludes a concurrent insert',async()=>{
    await db.transaction().execute(tx=>up(tx))
    const dropping=db.transaction().execute(async tx=>down(tx))
    try {
      let active=false
      for(let attempt=0;attempt<50 && !active;attempt++) {
        const found=await control.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE '%pg_sleep(2)%') AS active")
        active=found.rows[0]?.active===true
        if(!active)await new Promise(resolve=>setTimeout(resolve,25))
      }
      expect(active).toBe(true)
      await control.query("SET lock_timeout='100ms'")
      try { await expect(control.query(`INSERT INTO "${schema}".user_roles VALUES ('racing','role','manual')`)).rejects.toMatchObject({code:'55P03'}) }
      finally { await control.query('RESET lock_timeout') }
    } finally {await dropping}
  })
})
