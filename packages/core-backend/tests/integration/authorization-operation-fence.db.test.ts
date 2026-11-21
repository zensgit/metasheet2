import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTHORIZATION_INPUT_STATEMENTS, withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'
import type { AuthorizationInputTransactionRunner } from '../../src/rbac/authorization-input-lock'
import { AUTHORIZATION_OPERATION_FENCE_TABLES, assertAuthorizationOperationReadReady, assertAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'

const url = process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_fence_test') throw new Error('isolated migrated loopback fixture required')
}
const suite = url ? describe : describe.skip
suite('authorization operation table fence on a migrated synthetic database', () => {
  const actor = randomUUID(), target = randomUUID()
  let pool: Pool, other: Client
  let run: AuthorizationInputTransactionRunner
  const plan = () => ({ intent: 'AUTHORIZATION_OPERATION' as const, operation: { actorId: actor, clientOperationId: randomUUID() }, userIds: [actor,target], admissionUserIds: [actor,target], roleIds: ['admin'] })
  beforeAll(async () => {
    pool = new Pool({ connectionString:url }); other = new Client({ connectionString:url }); await other.connect()
    await other.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'actor','synthetic','admin',true),($3,$4,'target','synthetic','user',false)", [actor,`${actor}@example.test`,target,`${target}@example.test`])
    await other.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')", [actor])
    run = async handler => {
      const raw = await pool.connect()
      try {
        await raw.query('BEGIN')
        const result = await handler({ query: (sql,params) => raw.query(sql,params), __rawClient:raw })
        await raw.query('COMMIT')
        return result
      } catch (error) {
        try { await raw.query('ROLLBACK') } catch { /* a timed-out connection is discarded */ }
        throw error
      } finally { raw.release() }
    }
  })
  afterAll(async () => {
    await other.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])', [[actor,target]])
    await other.query('DELETE FROM users WHERE id=ANY($1::text[])', [[actor,target]])
    await other.end(); await pool.end()
  })
  it('holds every attested table in EXCLUSIVE mode and leaves work timeouts active', async () => {
    await withAuthorizationInputTransaction(plan(), async tx => {
      const locks = await tx.query(`SELECT c.relname, l.mode FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid=l.relation JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND n.nspname='public' AND c.relname=ANY($1::text[]) AND l.mode='ExclusiveLock' ORDER BY c.relname`, [[...AUTHORIZATION_OPERATION_FENCE_TABLES]])
      expect(locks.rows.map(row => row.relname)).toEqual([...AUTHORIZATION_OPERATION_FENCE_TABLES])
      const timeout = await tx.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")
      expect(timeout.rows[0]).toEqual({ lock_timeout:'500ms', statement_timeout:'2500ms' })
      await other.query('BEGIN')
      try { await expect(other.query('LOCK TABLE public.role_permissions IN ROW EXCLUSIVE MODE NOWAIT')).rejects.toMatchObject({ code:'55P03' }) }
      finally { await other.query('ROLLBACK') }
    }, { transaction:run })
  })
  it('returns retryable busy without waiting when an old writer holds a table', async () => {
    await other.query('BEGIN'); await other.query('LOCK TABLE public.role_permissions IN ROW EXCLUSIVE MODE')
    let worked = false; const start = Date.now()
    try {
      await expect(withAuthorizationInputTransaction(plan(), async () => { worked=true }, { transaction:run })).rejects.toMatchObject({ code:'AUTHORIZATION_INPUT_BUSY', status:409 })
      expect(worked).toBe(false); expect(Date.now()-start).toBeLessThan(2000)
    } finally { await other.query('ROLLBACK') }
  })
  it('rejects an unknown trigger/function before work and releases all locks', async () => {
    await other.query(`CREATE FUNCTION permission_command_unknown_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`)
    await other.query('CREATE TRIGGER permission_command_unknown BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION permission_command_unknown_trigger()')
    let worked = false
    try {
      await expect(withAuthorizationInputTransaction(plan(), async () => { worked=true }, { transaction:run })).rejects.toMatchObject({ code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE', status:503 })
      expect(worked).toBe(false)
    } finally { await other.query('DROP TRIGGER permission_command_unknown ON user_roles'); await other.query('DROP FUNCTION permission_command_unknown_trigger()') }
    await other.query('BEGIN'); try { await other.query('LOCK TABLE public.user_roles IN ROW EXCLUSIVE MODE NOWAIT') } finally { await other.query('ROLLBACK') }
  })
  it('validates preview readiness inside a read-only repeatable-read transaction', async () => {
    await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try { expect(await assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).toBe(true) }
    finally { await other.query('ROLLBACK') }
  })
  it('rolls back a prior write after a server-side work statement timeout', async () => {
    const started=Date.now(), id=randomUUID()
    await expect(withAuthorizationInputTransaction(plan(), async tx => {
      await tx.query(`INSERT INTO authorization_operation_receipts(actor_id,client_operation_id,request_digest,expected_version,target_user_id,action,receipt) VALUES ($1,$2::uuid,'digest','version',$3,'{}','{}')`, [actor,id,target])
      await tx.query('SELECT pg_sleep(4)')
    }, { transaction:run })).rejects.toMatchObject({ code:'AUTHORIZATION_INPUT_BUSY',status:409,busyReason:'statement_timeout' })
    expect(Date.now()-started).toBeLessThan(4500)
    expect((await other.query('SELECT count(*)::int AS n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
    await other.query('BEGIN'); try { await other.query('LOCK TABLE public.user_roles IN ROW EXCLUSIVE MODE NOWAIT') } finally { await other.query('ROLLBACK') }
  }, 10000)
  it.each([
    { name:'RLS', up:'ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY', down:'ALTER TABLE public.roles DISABLE ROW LEVEL SECURITY' },
    { name:'default', up:"ALTER TABLE public.users ALTER COLUMN email SET DEFAULT 'synthetic-drift'", down:'ALTER TABLE public.users ALTER COLUMN email DROP DEFAULT' },
    { name:'generated column', up:"ALTER TABLE public.roles ADD COLUMN permission_command_drift text GENERATED ALWAYS AS ('x'::text) STORED", down:'ALTER TABLE public.roles DROP COLUMN permission_command_drift' },
    { name:'index', up:'CREATE INDEX permission_command_drift_index ON public.roles(id)', down:'DROP INDEX public.permission_command_drift_index' },
    { name:'rule', up:'CREATE RULE permission_command_drift_rule AS ON UPDATE TO public.roles DO ALSO NOTHING', down:'DROP RULE permission_command_drift_rule ON public.roles' },
    { name:'policy', up:'CREATE POLICY permission_command_drift_policy ON public.roles USING (true)', down:'DROP POLICY permission_command_drift_policy ON public.roles' },
  ])('refuses unknown $name schema drift in a read-only readiness check', async ({up,down}) => {
    await other.query(up)
    try {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try { await expect(assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).rejects.toMatchObject({code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE'}) }
      finally { await other.query('ROLLBACK') }
    } finally { await other.query(down) }
    await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try { expect(await assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).toBe(true) }
    finally { await other.query('ROLLBACK') }
  })
  it('does not wait for an exclusive schema mutation gate in read-only readiness', async () => {
    const holder=await pool.connect(); await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(20261106,1)')
    const started=Date.now(); await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try { expect(await assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).toBe(false); expect(Date.now()-started).toBeLessThan(1000) }
    finally { await other.query('ROLLBACK'); await holder.query('ROLLBACK'); holder.release() }
  })
  it('bounds client wait during slow COMMIT and treats the later result as unknown', async () => {
    const id=randomUUID(), started=Date.now()
    let caught: unknown
    try {
      try {
        await withAuthorizationInputTransaction(plan(), async tx => {
          // PG16 disables statement_timeout before firing deferred COMMIT triggers. This DDL
          // exists only in the isolated fixture and demonstrates the ambiguous outcome.
          await tx.query(`CREATE FUNCTION public.permission_command_delay_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(8); RETURN NEW; END $$`)
          await tx.query('CREATE CONSTRAINT TRIGGER permission_command_delay_commit AFTER INSERT ON authorization_operation_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.permission_command_delay_commit()')
          await tx.query(`INSERT INTO authorization_operation_receipts(actor_id,client_operation_id,request_digest,expected_version,target_user_id,action,receipt) VALUES ($1,$2::uuid,'digest','version',$3,'{}','{}')`, [actor,id,target])
        }, { transaction:run })
      } catch (error) { caught=error }
      expect(caught).toBeDefined()
      expect((caught as {code?:string}).code).not.toBe('AUTHORIZATION_INPUT_BUSY')
      expect(Date.now()-started).toBeLessThan(7500)
      let count=0
      const until=Date.now()+6000
      while (Date.now()<until) {
        count=(await other.query('SELECT count(*)::int AS n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2', [actor,id])).rows[0].n
        if (count === 1) break
        await new Promise(resolve => setTimeout(resolve,50))
      }
      // The intentionally delayed server transaction can commit after the caller disconnected.
      expect(count).toBe(1)
    } finally {
      await other.query('DROP TRIGGER IF EXISTS permission_command_delay_commit ON public.authorization_operation_receipts')
      await other.query('DROP FUNCTION IF EXISTS public.permission_command_delay_commit()')
      await other.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2', [actor,id])
    }
  },15000)
  it.each(['world','operation','platform-admin','admission'])('never waits for a contended $ lock', async kind => {
    const request = plan()
    await other.query('BEGIN')
    if (kind === 'world') await other.query('SELECT pg_advisory_xact_lock(20261106,1)')
    if (kind === 'operation') await other.query("SELECT pg_advisory_xact_lock(hashtextextended('authorization-operation:' || $1,0))", [JSON.stringify([actor,request.operation.clientOperationId])])
    if (kind === 'platform-admin') await other.query("SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin',0))")
    if (kind === 'admission') await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`namespace-admission:${actor}`])
    const started=Date.now(); let worked=false
    try {
      await expect(withAuthorizationInputTransaction(request,async () => {worked=true},{transaction:run})).rejects.toMatchObject({code:'AUTHORIZATION_INPUT_BUSY',status:409})
      expect(worked).toBe(false); expect(Date.now()-started).toBeLessThan(1500)
    } finally { await other.query('ROLLBACK') }
  })
  it('refuses an unknown cross-table foreign-key dependency', async () => {
    await other.query('CREATE TABLE public.permission_command_extra_dependency(id text PRIMARY KEY)')
    await other.query('ALTER TABLE public.user_roles ADD CONSTRAINT permission_command_extra_fk FOREIGN KEY(role_id) REFERENCES public.permission_command_extra_dependency(id) NOT VALID')
    try {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try { await expect(assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).rejects.toMatchObject({code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE'}) }
      finally { await other.query('ROLLBACK') }
    } finally { await other.query('ALTER TABLE public.user_roles DROP CONSTRAINT permission_command_extra_fk'); await other.query('DROP TABLE public.permission_command_extra_dependency') }
  })

  it('accepts the registered N78 inbound foreign key with the integrated B2 profile', async () => {
    await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      await other.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
      const foreignKeys = await other.query(`SELECT conname FROM pg_catalog.pg_constraint
        WHERE conrelid='public.notification_connection_verifications'::regclass
          AND confrelid='public.directory_integrations'::regclass AND contype='f'`)
      expect(foreignKeys.rows).toEqual([{ conname: 'ncv_conn_fk' }])
      await assertAuthorizationOperationSchema((sql, params) => other.query(sql, params))
    } finally { await other.query('ROLLBACK') }
  })

  for (const { name, ddl } of [
    { name: 'unregistered inbound foreign key', ddl: 'CREATE TABLE public.permission_command_inbound_dependency(id text REFERENCES public.roles(id))' },
    { name: 'renamed N78 foreign key', ddl: 'ALTER TABLE public.notification_connection_verifications RENAME CONSTRAINT ncv_conn_fk TO ncv_drift_fk' },
    { name: 'deferrable N78 foreign key', ddl: 'ALTER TABLE public.notification_connection_verifications ALTER CONSTRAINT ncv_conn_fk DEFERRABLE INITIALLY DEFERRED' },
    { name: 'unvalidated N78 foreign key', ddl: `ALTER TABLE public.notification_connection_verifications DROP CONSTRAINT ncv_conn_fk,
        ADD CONSTRAINT ncv_conn_fk FOREIGN KEY (connection_id, provider) REFERENCES public.directory_integrations(id, provider) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID` },
    { name: 'changed N78 delete action', ddl: `ALTER TABLE public.notification_connection_verifications DROP CONSTRAINT ncv_conn_fk,
        ADD CONSTRAINT ncv_conn_fk FOREIGN KEY (connection_id, provider) REFERENCES public.directory_integrations(id, provider) ON UPDATE RESTRICT ON DELETE CASCADE` },
    { name: 'additional foreign key from the registered N78 source', ddl: `ALTER TABLE public.notification_connection_verifications
        ADD CONSTRAINT ncv_extra_fk FOREIGN KEY (connection_id) REFERENCES public.directory_integrations(id)` },
  ]) it(`refuses ${name} without weakening the original profile`, async () => {
    const query = (sql: string, params?: unknown[]) => other.query(sql, params)
    await other.query('BEGIN')
    try {
      await other.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
      await assertAuthorizationOperationSchema(query)
      await other.query('SAVEPOINT original_profile')
      await other.query(ddl)
      await expect(assertAuthorizationOperationSchema(query)).rejects.toMatchObject({ code: 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE' })
      await other.query('ROLLBACK TO SAVEPOINT original_profile')
      await assertAuthorizationOperationSchema(query)
    } finally { await other.query('ROLLBACK') }
  })

  it('does not let a session temporary table shadow the fenced public users table', async () => {
    const raw=await pool.connect()
    await raw.query('CREATE TEMP TABLE users(id text PRIMARY KEY, name text)')
    await raw.query("INSERT INTO pg_temp.users VALUES ($1,'shadow')", [actor])
    const processId=(await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    raw.release()
    try {
      await withAuthorizationInputTransaction(plan(), async tx => {
        expect((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(processId)
        expect((await tx.query('SELECT name FROM users WHERE id=$1',[actor])).rows[0].name).toBe('actor')
      }, { transaction:run })
    } finally {
      const cleanup=await pool.connect(); try { await cleanup.query('DROP TABLE IF EXISTS pg_temp.users') } finally { cleanup.release() }
    }
  })

  it('refuses a non-public schema before acquiring or reading a fence', async () => {
    await other.query('CREATE SCHEMA permission_command_wrong_schema')
    try {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        await other.query('SET LOCAL search_path=permission_command_wrong_schema,public')
        await expect(assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).rejects.toMatchObject({ code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE' })
      } finally { await other.query('ROLLBACK') }
    } finally { await other.query('DROP SCHEMA permission_command_wrong_schema') }
  })
  it('refuses an unknown public function even without an attached trigger', async () => {
    await other.query("CREATE FUNCTION public.permission_command_unknown_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'")
    try {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try { await expect(assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).rejects.toMatchObject({ code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE' }) }
      finally { await other.query('ROLLBACK') }
    } finally { await other.query('DROP FUNCTION public.permission_command_unknown_function()') }
  })
  it('rejects a changed body on a known public function', async () => {
    await other.query('BEGIN')
    try {
      await other.query(`CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`)
      await expect(assertAuthorizationOperationReadReady(
        (sql, params) => other.query(sql, params),
        AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry,
      )).rejects.toMatchObject({ code: 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE' })
    } finally {
      await other.query('ROLLBACK')
    }
  })

  it('keeps pg_temp behind public for read-only readiness too', async () => {
    await other.query('CREATE TEMP TABLE users(id text PRIMARY KEY,name text)')
    await other.query("INSERT INTO pg_temp.users VALUES ($1,'shadow')",[actor])
    await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      expect(await assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).toBe(true)
      expect((await other.query('SELECT name FROM users WHERE id=$1',[actor])).rows[0].name).toBe('actor')
    } finally { await other.query('ROLLBACK'); await other.query('DROP TABLE pg_temp.users') }
  })

  it('rejects uncontrolled schema CREATE grants and unrelated object owners', async () => {
    const role=`permission_command_untrusted_${randomUUID().replaceAll('-','')}`
    const check=async () => {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try { await expect(assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).rejects.toMatchObject({code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE'}) }
      finally { await other.query('ROLLBACK') }
    }
    await other.query(`CREATE ROLE "${role}" NOLOGIN`)
    try {
      await other.query(`GRANT CREATE ON SCHEMA public TO "${role}"`)
      await check()
      await other.query(`REVOKE CREATE ON SCHEMA public FROM "${role}"`)
      await other.query(`ALTER TABLE public.roles OWNER TO "${role}"`)
      try { await check() } finally { await other.query('ALTER TABLE public.roles OWNER TO CURRENT_USER') }
      await other.query(`ALTER FUNCTION public.guard_repaired_directory_link() OWNER TO "${role}"`)
      try { await check() } finally { await other.query('ALTER FUNCTION public.guard_repaired_directory_link() OWNER TO CURRENT_USER') }
    } finally { await other.query(`REVOKE CREATE ON SCHEMA public FROM "${role}"`); await other.query(`DROP ROLE "${role}"`) }
  })

  it('refuses a non-public schema in the write transaction before work', async () => {
    await other.query('CREATE SCHEMA permission_command_wrong_schema')
    const raw=await pool.connect(); await raw.query('SET search_path=permission_command_wrong_schema,public')
    const runner: AuthorizationInputTransactionRunner = async handler => {
      try { await raw.query('BEGIN'); const result=await handler({query:(sql,params)=>raw.query(sql,params),__rawClient:raw}); await raw.query('COMMIT'); return result }
      catch (error) { await raw.query('ROLLBACK'); throw error }
    }
    let worked=false
    try { await expect(withAuthorizationInputTransaction(plan(),async()=>{worked=true},{transaction:runner})).rejects.toMatchObject({code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE'}); expect(worked).toBe(false) }
    finally { await raw.query('RESET search_path'); raw.release(); await other.query('DROP SCHEMA permission_command_wrong_schema') }
  })

  it('refuses an unknown trigger even when it calls an already-known function', async () => {
    await other.query('CREATE TRIGGER permission_command_extra_link BEFORE INSERT ON public.directory_account_links FOR EACH ROW EXECUTE FUNCTION public.guard_repaired_directory_link()')
    try {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try { await expect(assertAuthorizationOperationReadReady((sql,params) => other.query(sql,params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)).rejects.toMatchObject({code:'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE'}) }
      finally { await other.query('ROLLBACK') }
    } finally { await other.query('DROP TRIGGER permission_command_extra_link ON public.directory_account_links') }
  })

})
