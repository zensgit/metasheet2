import { sql, type Kysely } from 'kysely'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { up as addApprovalTables } from '../../src/db/migrations/20250924105000_create_approval_tables'
import { up as addNamespaceAdmissions } from '../../src/db/migrations/zzzz20260411120000_create_user_namespace_admissions'
import { up as addExecutionSnapshot } from '../../src/db/migrations/zzzz20260527120000_add_automation_execution_snapshot_fields'
import { up as addRetry } from '../../src/db/migrations/zzzz20260529120000_add_automation_retry_attempt_fields'
import { up as addJobs } from '../../src/db/migrations/zzzz20260530120000_create_automation_jobs_and_execution_mode'
import { up as addSuspensions } from '../../src/db/migrations/zzzz20260603130000_create_automation_suspensions'
import { up as addBridges } from '../../src/db/migrations/zzzz20260610150000_create_automation_approval_bridges'
import { up as addResumeCursor } from '../../src/db/migrations/zzzz20260615120000_add_automation_suspension_resume_cursor'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addClaims } from '../../src/db/migrations/zzzz20260716100000_create_automation_action_applied'
import { up as addOutbound } from '../../src/db/migrations/zzzz20260716110000_create_automation_outbound_intent'
import { up as addBridgeLease } from '../../src/db/migrations/zzzz20260717120000_approval_bridge_lease'
import { up as addExecutionFingerprint } from '../../src/db/migrations/zzzz20260716160000_add_execution_rule_fingerprint'
import { up as addMetricsTimeout } from '../../src/db/migrations/zzzz20260630100000_add_node_timeout_to_approval_metrics'
import { up as addMetricsCalendar } from '../../src/db/migrations/zzzz20260703140000_add_calendar_sla_to_approval_metrics'
import { up as addFirstRetry } from '../../src/db/migrations/zzzz20260830200000_add_automation_first_retry_attempt'
import { up as addContinuation } from '../../src/db/migrations/zzzz20260830220000_add_automation_continuation_ledger_identity'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addMaterial } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import { up as addImages } from '../../src/db/migrations/zzzz20261001138000_automation_record_after_image'
import { up as addSchemaRevision } from '../../src/db/migrations/zzzz20261001139000_automation_record_schema_revision'

type Query = (statement: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

/** Test storage only. Callers must forward poolManager and db/pg to this same real owned schema.
 * Existing authority fixtures retain their exact membership table layouts. No public-schema repair,
 * data reset, production startup, customer access or permission substitute is performed here.
 */
export async function bootstrapOwnedApprovalAfterImageSchema(input: {
  db: Kysely<unknown>
  query: Query
  mode: 'empty' | 'existing'
}): Promise<void> {
  const { db, query } = input
  const schema = (await query('SELECT current_schema() AS schema')).rows[0]?.schema
  if (typeof schema !== 'string' || !/^automation_(?:approval_image|authority)_[a-f0-9]{16}$/u.test(schema)) {
    throw new Error('AUTOMATION_APPROVAL_FIXTURE_SCHEMA_NOT_OWNED')
  }
  if (input.mode === 'empty') {
    await query(`CREATE TABLE meta_bases(id text PRIMARY KEY,name text,owner_id text,deleted_at timestamptz);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,name text,deleted_at timestamptz,
        row_level_read_permissions_enabled boolean DEFAULT false,conditional_read_rules jsonb DEFAULT '[]');
      CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text,name text,type text,property jsonb,"order" int);
      CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text,data jsonb NOT NULL DEFAULT '{}',version int NOT NULL,
        created_by text,modified_by text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        locked boolean NOT NULL DEFAULT false,locked_by text);
      CREATE TABLE meta_record_revisions(id uuid PRIMARY KEY,sheet_id text,record_id text,version int,action text,source text,
        actor_id text,changed_field_ids text[],patch jsonb,snapshot jsonb,batch_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE users(id text PRIMARY KEY,email text,name text,password_hash text,role text DEFAULT 'user',
        permissions jsonb DEFAULT '[]',is_active boolean DEFAULT true,is_admin boolean DEFAULT false,
        activation_status text DEFAULT 'activated',department text);
      CREATE TABLE permissions(code text PRIMARY KEY,name text,description text);
      CREATE TABLE user_permissions(user_id text,permission_code text,PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean DEFAULT true,PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_roles(user_id text,role_id text);
      CREATE TABLE roles(id text PRIMARY KEY,name text,approval_usable boolean DEFAULT false);
      CREATE TABLE role_permissions(role_id text,permission_code text);
      CREATE TABLE platform_member_group_members(user_id text,group_id uuid);
      CREATE TABLE spreadsheet_permissions(sheet_id text,subject_type text,subject_id text,perm_code text);
      CREATE TABLE field_permissions(sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean);
      CREATE TABLE record_permissions(sheet_id text,record_id text,subject_type text,subject_id text,access_level text);
      CREATE TABLE plugin_multitable_object_registry(sheet_id text PRIMARY KEY,project_id text,object_id text,plugin_name text);
      CREATE TABLE integration_stock_prep_pack_installs(id text PRIMARY KEY,tenant_id text,project_id text,object_id text);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,name text,trigger_type text NOT NULL,
        trigger_config jsonb DEFAULT '{}',action_type text NOT NULL,action_config jsonb DEFAULT '{}',enabled boolean DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by text,
        conditions jsonb,actions jsonb,execution_mode text);`)
  }
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS email text, ADD COLUMN IF NOT EXISTS password_hash text,
      ADD COLUMN IF NOT EXISTS username text,
      ADD COLUMN IF NOT EXISTS department text,
      ADD COLUMN IF NOT EXISTS activation_status text DEFAULT 'activated', ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;
    ALTER TABLE meta_fields ADD COLUMN IF NOT EXISTS "order" int;
    ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS created_by text,
      ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS locked_by text,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    CREATE TABLE IF NOT EXISTS permissions(code text PRIMARY KEY,name text,description text);
    CREATE TABLE IF NOT EXISTS roles(id text PRIMARY KEY,name text,approval_usable boolean DEFAULT false);
    CREATE TABLE IF NOT EXISTS multitable_automation_executions(id text PRIMARY KEY,rule_id text NOT NULL,
      triggered_by text NOT NULL DEFAULT 'event',triggered_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'running',steps jsonb NOT NULL DEFAULT '[]',error text,duration int,
      created_at timestamptz NOT NULL DEFAULT now());`)
  const admissions = (await query("SELECT to_regclass('user_namespace_admissions') IS NOT NULL AS present")).rows[0]?.present
  if (admissions !== true) await db.transaction().execute(addNamespaceAdmissions)
  // Preserve production BIGSERIAL audit ordinals before the shared helper converges extra columns.
  await db.transaction().execute(addApprovalTables)
  await ensureApprovalSchemaReady()
  for (const migration of [addExecutionSnapshot, addRetry, addJobs, addSuspensions, addBridges,
    addResumeCursor, addBridgeLease, addExecutionFingerprint, addFirstRetry, addContinuation, addOutbound,
    addMetricsTimeout, addMetricsCalendar]) await db.transaction().execute(migration)
  await db.transaction().execute(addClaims)
  // Existing authority schemas have already installed these journal-owned migrations.
  if (input.mode === 'empty') {
    // Ordinary approval logs always write this nullable column. The independent owned fixture has
    // no integration-read requests, admission or audit links; their actual migration belongs to the
    // authority suite, which installs it before calling existing mode.
    await query('ALTER TABLE multitable_automation_executions ADD COLUMN integration_read jsonb')
    for (const migration of [addOutbox, addRuleRevision, addMaterial, addImages, addSchemaRevision]) {
      await db.transaction().execute(migration)
    }
  } else {
    const proof = await sql<{ ready: boolean }>`SELECT
      to_regclass('meta_automation_outbox') IS NOT NULL AND
      to_regclass('meta_automation_record_after_images') IS NOT NULL AND
      to_regclass('automation_read_material_epochs') IS NOT NULL AS ready`.execute(db)
    if (proof.rows[0]?.ready !== true) throw new Error('AUTOMATION_APPROVAL_FIXTURE_PREREQUISITES_MISSING')
  }
}
