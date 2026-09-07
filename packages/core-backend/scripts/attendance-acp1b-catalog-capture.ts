import { randomUUID, createHash } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up } from '../src/db/migrations/zzzz20260907110000_create_attendance_report_projection_anchors'

// Temporary synthetic-only diagnostic. Never log connection URLs or raw errors.
// Reference is the unmodified migration's native PG16.15/C catalog capture.
const reference: Record<string, unknown> = {"columns":[["projection_record_id","text",true,null,"","",["pg_catalog","default","d",true]],["org_id","text",true,null,"","",["pg_catalog","default","d",true]],["canonical_record_id","uuid",true,null,"","",null],["source_selector","text",true,null,"","",["pg_catalog","default","d",true]],["source_calculation_id","uuid",true,null,"","",null],["source_calculation_version","integer",true,null,"","",null],["canonical_source_digest","character(64)",true,null,"","",["pg_catalog","default","d",true]],["source_fingerprint","character(40)",true,null,"","",["pg_catalog","default","d",true]],["created_at","timestamp with time zone",true,"now()","","",null],["updated_at","timestamp with time zone",true,"now()","","",null]],"indexes":[[true,false,true,true,"2 3","0 0",null,null,"btree",[["pg_catalog","text_ops"],["pg_catalog","uuid_ops"]],[["pg_catalog","default","d",true],[null,null,null,null]]],[true,true,true,true,"1","0",null,null,"btree",[["pg_catalog","text_ops"]],[["pg_catalog","default","d",true]]]],"relation":["r","p",false,false],"triggers":[["trg_attendance_report_projection_anchor_identity",19,"O","","",null,"attendance_report_projection_anchor_identity_guard","public","\n    BEGIN\n      IF NEW.projection_record_id IS DISTINCT FROM OLD.projection_record_id\n        OR NEW.org_id IS DISTINCT FROM OLD.org_id\n        OR NEW.canonical_record_id IS DISTINCT FROM OLD.canonical_record_id\n        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN\n        RAISE EXCEPTION 'ATTENDANCE_CLEANING_ANCHOR_IDENTITY_IMMUTABLE';\n      END IF;\n      RETURN NEW;\n    END;\n    ",false,"v",null,"plpgsql","","trigger"]],"constraints":[["c",true,false,false,"CHECK (((org_id = btrim(org_id)) AND (org_id <> ''::text)))"],["c",true,false,false,"CHECK (((projection_record_id = btrim(projection_record_id)) AND (projection_record_id <> ''::text)))"],["c",true,false,false,"CHECK ((canonical_source_digest ~ '^[0-9a-f]{64}$'::text))"],["c",true,false,false,"CHECK ((source_calculation_version >= 1))"],["c",true,false,false,"CHECK ((source_fingerprint ~ '^[0-9a-f]{40}$'::text))"],["c",true,false,false,"CHECK ((source_selector = ANY (ARRAY['current_calculation'::text, 'latest_completed_calculation'::text])))"],["f",true,false,false,"FOREIGN KEY (canonical_record_id, org_id) REFERENCES attendance_records(id, org_id) ON UPDATE RESTRICT ON DELETE RESTRICT"],["f",true,false,false,"FOREIGN KEY (projection_record_id) REFERENCES meta_records(id) ON UPDATE RESTRICT ON DELETE CASCADE"],["f",true,false,false,"FOREIGN KEY (source_calculation_id, canonical_record_id, org_id) REFERENCES attendance_record_calculations(id, attendance_record_id, org_id) ON UPDATE RESTRICT ON DELETE RESTRICT"],["p",true,false,false,"PRIMARY KEY (projection_record_id)"],["u",true,false,false,"UNIQUE (org_id, canonical_record_id)"]]}

async function capture(): Promise<void> {
  if (process.env.ACP_CATALOG_DIAGNOSTIC !== 'true') throw new Error('ACP_DIAGNOSTIC_DISABLED')
  const url = new URL(process.env.DATABASE_URL || '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^(metasheet_recovery_|attendance_acp_)[a-z0-9_]+$/.test(url.pathname.slice(1))
    || !url.username) throw new Error('ACP_DIAGNOSTIC_TARGET_REFUSED')
  const options = { max: 1, connectionTimeoutMillis: 5000, query_timeout: 10000 }
  const admin = new Pool({ connectionString: url.toString(), ...options })
  const name = 'attendance_acp_capture_' + randomUUID().replaceAll('-', '')
  let created = false
  let pool: Pool | undefined
  let db: Kysely<unknown> | undefined
  try {
    const result = await admin.query<{
      version: string; encoding: string; collate: string; ctype: string; provider: string
    }>(`SELECT current_setting('server_version') AS version,
      pg_encoding_to_char(encoding) AS encoding, datcollate AS collate,
      datctype AS ctype, datlocprovider AS provider
      FROM pg_database WHERE datname = current_database()`)
    const settings = result.rows[0]
    if (!settings || settings.encoding !== 'UTF8' || settings.provider !== 'c'
      || !/^[A-Za-z0-9_.@-]+$/.test(settings.collate)
      || !/^[A-Za-z0-9_.@-]+$/.test(settings.ctype)) throw new Error('ACP_DIAGNOSTIC_LOCALE_REFUSED')
    console.log(JSON.stringify({ diagnostic: 'environment', platform: process.platform,
      arch: process.arch, ...settings }))
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'
      LC_COLLATE '${settings.collate}' LC_CTYPE '${settings.ctype}' LOCALE_PROVIDER libc`)
    created = true
    url.pathname = '/' + name
    pool = new Pool({ connectionString: url.toString(), ...options })
    db = new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [{
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        const shape = result.rows[0]?.shape as Record<string, unknown> | undefined
        if (shape) {
          const changedFields = [...new Set([...Object.keys(reference), ...Object.keys(shape)])]
            .filter(key => JSON.stringify(reference[key]) !== JSON.stringify(shape[key]))
          console.log(JSON.stringify({ diagnostic: 'closed_synthetic_catalog',
            fingerprint: createHash('sha256').update(JSON.stringify(shape)).digest('hex'),
            changedFields, shape }))
        }
        return result
      },
    }] })
    await pool.query(`CREATE TABLE meta_records(id text PRIMARY KEY);
      CREATE TABLE attendance_records(id uuid, org_id text, UNIQUE(id, org_id));
      CREATE TABLE attendance_record_calculations(id uuid, attendance_record_id uuid, org_id text,
        UNIQUE(id, attendance_record_id, org_id));`)
    try {
      await up(db)
      console.log(JSON.stringify({ migrationOutcome: 'passed' }))
    } catch {
      console.log(JSON.stringify({ migrationOutcome: 'failed', errorCode: 'ACP_DIAGNOSTIC_MIGRATION_FAILED' }))
      process.exitCode = 1
    }
  } finally {
    try {
      if (db) await db.destroy()
      else if (pool) await pool.end()
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${name}"`)
          const residue = await admin.query('SELECT count(*)::int AS count FROM pg_database WHERE datname = $1', [name])
          if (residue.rows[0].count !== 0) throw new Error('ACP_DIAGNOSTIC_CLEANUP_FAILED')
          console.log(JSON.stringify({ diagnostic: 'cleanup', ownedDatabaseResidue: 0 }))
        }
      } finally { await admin.end() }
    }
  }
}
capture().catch(() => {
  console.error('ACP_DIAGNOSTIC_FAILED')
  process.exitCode = 1
})

