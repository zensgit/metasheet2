import type { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { up as revisions } from '../../src/db/migrations/zzzz20260430172000_create_meta_record_revisions'
import { up as batches } from '../../src/db/migrations/zzzz20260619120000_add_meta_record_revisions_batch_id'
import { up as markers } from '../../src/db/migrations/zzzz20260713150000_create_meta_record_version_markers'
import { up as seq } from '../../src/db/migrations/zzzz20260715160000_add_meta_record_chain_seq'
import { up as operations } from '../../src/db/migrations/zzzz20260715210000_create_meta_record_history_operations'
import { up as outbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as audit } from '../../src/db/migrations/zzzz20260628130000_create_oapi_write_audit'
import { up as ingress } from '../../src/db/migrations/zzzz20261015030000_create_plm_record_ingress'

// Isolated test database ONLY: minimal predecessor catalog; the eight feature migrations are real.
// This is not evidence for a fresh-install complete repository migration chain.
export async function bootstrapPlmIngressTestDb(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY,is_active boolean,role text,activation_status text,local_password_set boolean,permissions text[]);
    CREATE TABLE roles(id text PRIMARY KEY,name text);
    CREATE TABLE user_roles(user_id text,role_id text);
    CREATE TABLE role_permissions(role_id text,permission_code text);
    CREATE TABLE user_permissions(user_id text,permission_code text);
    CREATE TABLE platform_member_group_members(user_id text,group_id uuid);
    CREATE TABLE spreadsheet_permissions(sheet_id text,subject_type text,subject_id text,perm_code text);
    CREATE TABLE field_permissions(sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean);
    CREATE TABLE record_permissions(id bigserial PRIMARY KEY,sheet_id text,record_id text,subject_type text,subject_id text,access_level text);
    CREATE TABLE meta_bases(id text PRIMARY KEY,owner_id text,deleted_at timestamptz);
    CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text REFERENCES meta_bases(id),deleted_at timestamptz,recovery_writer_state text,row_level_read_permissions_enabled boolean DEFAULT false);
    CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text REFERENCES meta_sheets(id),type text,property jsonb);
    CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text NOT NULL REFERENCES meta_sheets(id),data jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,
      created_by text REFERENCES users(id),modified_by text REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),locked boolean DEFAULT false,locked_by text);
    CREATE TABLE multitable_api_tokens(id text PRIMARY KEY,token_hash text UNIQUE,token_prefix text,name text,scopes jsonb,created_by text REFERENCES users(id),revoked boolean DEFAULT false,expires_at timestamptz,base_ids text[],sheet_ids text[],created_at timestamptz DEFAULT now(),last_used_at timestamptz);
  `)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  for (const up of [revisions, batches, markers, seq, operations, outbox, audit, ingress])
    await up(db)
}
