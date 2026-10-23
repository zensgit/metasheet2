import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up as m0 } from '../../src/db/migrations/zzzz20260114090000_create_attendance_tables'
import { up as m1 } from '../../src/db/migrations/zzzz20260114100000_add_attendance_org_id'
import { up as m2 } from '../../src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables'
import { up as m3 } from '../../src/db/migrations/zzzz20260120114000_create_attendance_rotation_tables'
import { up as m4 } from '../../src/db/migrations/zzzz20260128120000_create_attendance_rule_sets_and_payroll'
import { up as m5 } from '../../src/db/migrations/zzzz20260131160000_create_attendance_import_tables'
import { up as m6 } from '../../src/db/migrations/zzzz20260204123000_create_attendance_groups'
import { up as m7 } from '../../src/db/migrations/zzzz20260207150000_create_attendance_import_tokens'
import { up as m8 } from '../../src/db/migrations/zzzz20260208120000_add_attendance_import_idempotency_key'
import { up as m9 } from '../../src/db/migrations/zzzz20260210120000_create_attendance_import_jobs'
import { up as m10 } from '../../src/db/migrations/zzzz20260323153000_add_attendance_shift_overnight'
import { up as m11 } from '../../src/db/migrations/zzzz20260528200000_add_attendance_shift_assignment_provenance'
import { up as m12 } from '../../src/db/migrations/zzzz20260609120000_add_attendance_shift_assignment_slot_index'
import { up as m13 } from '../../src/db/migrations/zzzz20260610120000_add_attendance_schedule_publish_status'
import { up as m14 } from '../../src/db/migrations/zzzz20260610130000_add_attendance_temporary_shift_metadata'
import { up as m15 } from '../../src/db/migrations/zzzz20260622000000_add_attendance_late_tier_thresholds'
import { up as m16 } from '../../src/db/migrations/zzzz20260724120000_create_attendance_shift_segments'
import { up as m17 } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as m18 } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import { up as m19 } from '../../src/db/migrations/zzzz20260731120000_w4c3a_import_rollback_foundation'
import { up as m20 } from '../../src/db/migrations/zzzz20260814120000_w7_attendance_context_source_posture_state'
import { up as m21 } from '../../src/db/migrations/zzzz20261012100000_create_attendance_timezone_policy'
import { up as m22 } from '../../src/db/migrations/zzzz20261012120000_create_attendance_timezone_context_companions'
import { up as m23 } from '../../src/db/migrations/zzzz20261013090000_create_attendance_business_trips'
import { up as m24 } from '../../src/db/migrations/zzzz20260520020000_add_origin_to_attendance_holidays'
import { up as m25 } from '../../src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups'
import { up as m26 } from '../../src/db/migrations/zzzz20260202093000_create_attendance_integrations'
import { up as m27 } from '../../src/db/migrations/zzzz20260208100000_create_roles_table'
export async function migrate(pool: Pool) {
  await pool.query(`CREATE TABLE users (
    id text PRIMARY KEY, name text, email text, username text, mobile text, employee_no text,
    role text NOT NULL DEFAULT 'user',
    department text, position text, hire_date date, is_active boolean NOT NULL DEFAULT true,
    activation_status text NOT NULL DEFAULT 'activated', permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`)
  await pool.query(`CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean DEFAULT true, PRIMARY KEY(user_id,org_id))`)
  await pool.query(`CREATE TABLE user_permissions (user_id text, permission_code text, PRIMARY KEY(user_id,permission_code))`)
  await pool.query(`CREATE TABLE user_roles (user_id text, role_id text, PRIMARY KEY(user_id,role_id))`)
  await pool.query(`CREATE TABLE role_permissions (role_id text, permission_code text, PRIMARY KEY(role_id,permission_code))`)
  await pool.query(`CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean DEFAULT false, PRIMARY KEY(user_id,namespace))`)
  await pool.query(`CREATE TABLE system_configs (key text PRIMARY KEY, value jsonb, is_encrypted boolean DEFAULT false, updated_at timestamptz DEFAULT now())`)
  await pool.query(`CREATE TABLE approval_instances (id text PRIMARY KEY)` )
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  for (const migration of [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18, m19, m20, m21, m22, m23, m24, m25, m26, m27]) await migration(db)
}
