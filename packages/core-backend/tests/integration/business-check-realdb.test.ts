import express from 'express'
import * as jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { pool } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import { rbacGuard, rbacGuardAll } from '../../src/rbac/rbac'
import { mountPermissionLifecyclePreflight } from '../utils/permission-lifecycle-preflight'
import { approvalsRouter } from '../../src/routes/approvals'
import { permissionsRouter } from '../../src/routes/permissions'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { deriveElearningProjectionBaseId, deriveElearningProjectionSheetId } from '../../src/multitable/elearning-projection-constants'

const schema = process.env.PERMISSION_CHECK_TEST_SCHEMA
if ((schema && !/^permission_check_[a-z0-9_]+$/.test(schema)) || (process.env.EXPECT_DB === '1' && (!schema || !pool))) throw new Error('isolated permission check database is required')
const describeIfDatabase = schema && pool ? describe : describe.skip
const db = pool!
let schemaCreated = false
const app = express()
app.use(express.json())
app.use(permissionsRouter())
app.use(approvalsRouter())
app.use('/api/attendance', authenticate)
app.use(attendanceAdminRouter())
app.use('/api/multitable', authenticate, univerMetaRouter())
// There is no production rbacGuardAll route at the frozen revision: exercise the guard itself here.
app.get('/test/guard-all', authenticate, rbacGuardAll(['approvals:read', 'approvals:write']), (_req, res) => res.json({ ok: true }))
app.get('/test/guard-stock', authenticate, rbacGuard('stock-prep:read'), (_req, res) => res.json({ ok: true }))
mountPermissionLifecyclePreflight(app)
const single = { subject: { kind: 'self' }, policyId: 'approval-templates.list', mode: 'single', permissions: ['approvals:read'] }
const any = { subject: { kind: 'self' }, policyId: 'approval-templates.directory.roles', mode: 'any', permissions: ['approval-templates:manage', 'approvals:admin-templates'] }
const tokens: Record<string, string> = {}

describeIfDatabase('business check against actual JWT business guards in isolated PostgreSQL', () => {
beforeAll(async () => {
  await db.query(`CREATE SCHEMA ${schema}`)
  schemaCreated = true
  await db.query(`CREATE TABLE users (id text PRIMARY KEY, email text, username text, mobile text, name text, role text, permissions jsonb,
    password_hash text, access_generation int DEFAULT 0, is_active boolean, must_change_password boolean DEFAULT false,
    activation_status text, local_password_set boolean DEFAULT true, deleted_at timestamptz, purged_at timestamptz,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`)
  await db.query('CREATE TABLE user_roles (user_id text, role_id text)')
  await db.query('CREATE TABLE roles (id text, name text)')
  await db.query('CREATE TABLE role_permissions (role_id text, permission_code text)')
  await db.query('CREATE TABLE user_permissions (user_id text, permission_code text)')
  await db.query('CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean, source text, granted_by text, updated_by text, created_at timestamptz, updated_at timestamptz)')
  await db.query('CREATE TABLE user_session_revocations (user_id text, revoked_after timestamptz, updated_at timestamptz, updated_by text, reason text)')
  await db.query('CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean)')
  await db.query('CREATE TABLE plugin_multitable_object_registry (sheet_id text, object_id text, plugin_name text)')
  await db.query('CREATE TABLE elearning_stats_multitable_sheets (sheet_id text, base_id text, org_id text)')
  await db.query('CREATE TABLE user_sessions (id text, user_id text, revoked_at timestamptz)')
  await db.query('CREATE TABLE meta_bases (id text PRIMARY KEY, name text, icon text, color text, owner_id text, workspace_id text, deleted_at timestamptz)')
  await db.query('CREATE TABLE meta_sheets (id text PRIMARY KEY, base_id text, name text, description text, deleted_at timestamptz, created_at timestamptz DEFAULT now(), row_level_read_permissions_enabled boolean DEFAULT false, conditional_read_rules jsonb DEFAULT NULL, system_kind text, grid_export_closure text)')
  await db.query('CREATE TABLE spreadsheet_permissions (sheet_id text, perm_code text, subject_type text, subject_id text)')
  await db.query('CREATE TABLE platform_member_group_members (user_id text, group_id text)')
  await db.query('CREATE TABLE meta_views (id text, sheet_id text, name text, type text, filter_info jsonb, sort_info jsonb, group_info jsonb, hidden_field_ids jsonb, config jsonb, created_at timestamptz DEFAULT now())')
  await db.query('CREATE TABLE meta_view_permissions (view_id text, permission text, subject_type text, subject_id text)')
  await db.query('CREATE TABLE meta_fields (id text, sheet_id text, name text, type text, property jsonb, "order" int)')
  await db.query('CREATE TABLE meta_records (id text, sheet_id text, data jsonb, version int DEFAULT 1, created_by text, locked boolean DEFAULT false, locked_by text, locked_at timestamptz)')
  await db.query('CREATE TABLE record_permissions (sheet_id text, record_id text, subject_type text, subject_id text, access_level text)')
  await db.query('CREATE TABLE field_permissions (sheet_id text, field_id text, subject_type text, subject_id text, visible boolean, read_only boolean)')
  await db.query("INSERT INTO meta_bases (id,name) VALUES ('base1','Base'),('base2','Other')")
  await db.query("INSERT INTO meta_sheets (id,base_id,name) VALUES ('sheet1','base1','Sheet'),('sheet2','base2','Other')")
  await db.query("INSERT INTO spreadsheet_permissions VALUES ('sheet1','spreadsheet:read','user','sheetreader')")
  await db.query("INSERT INTO meta_views (id,sheet_id,name,type) VALUES ('view1','sheet1','View','grid'),('view2','sheet2','Other','grid')")
  await db.query("INSERT INTO meta_fields VALUES ('field1','sheet1','Status','select','{}',1),('field2','sheet2','Other','text','{}',1)")
  await db.query("INSERT INTO meta_records (id,sheet_id,data,created_by) VALUES ('record1','sheet1','{\"field1\":\"secret\"}','sheetreader'),('record2','sheet2','{}','sheetother')")
  for (const [id, role] of [['user', 'user'], ['actor', 'user'], ['rawadmin', 'admin'], ['target', 'user'], ['sheetreader', 'user'], ['sheetother', 'user'], ['admitted', 'user'], ['tenantreader', 'user'], ['revoked', 'user'], ['wildcard', 'user'], ['optout', 'user'], ['unassigned', 'user']]) {
    await db.query('INSERT INTO users (id,email,name,role,permissions,password_hash,is_active,activation_status) VALUES ($1,$2,$1,$3,$4,$5,true,$6)', [id, `${id}@invalid.test`, role, '[]', 'x', 'activated'])
    tokens[id] = authService.createToken({ id, email: `${id}@invalid.test`, name: id, role, permissions: [], created_at: new Date(), updated_at: new Date() })
  }
  await db.query("INSERT INTO user_roles VALUES ('actor','admin')")
  await db.query("INSERT INTO roles VALUES ('admin','admin'), ('approver','approver')")
})
afterAll(async () => { if (schemaCreated) await db.query(`DROP SCHEMA ${schema} CASCADE`) })
function post(user: string, body: unknown) { return request(app).post('/api/permissions/v2/business-check').set('Authorization', `Bearer ${tokens[user]}`).send(body) }
function get(user: string, path: string) { return request(app).get(path).set('Authorization', `Bearer ${tokens[user]}`) }

  it('single guard follows direct and role changes for the same JWT', async () => {
    expect((await post('user', single)).body.result).toBe('deny')
    expect((await get('user', '/api/approval-templates?section=invalid')).status).toBe(403)
    await db.query("INSERT INTO user_permissions VALUES ('user','approvals:read')")
    expect((await post('user', single)).body.result).toBe('allow')
    expect((await get('user', '/api/approval-templates?section=invalid')).status).toBe(400)
    await db.query("DELETE FROM user_permissions WHERE user_id='user'")
    await db.query("INSERT INTO user_roles VALUES ('user','approver')")
    await db.query("INSERT INTO role_permissions VALUES ('approver','approvals:read')")
    expect((await post('user', single)).body.result).toBe('allow')
    expect((await get('user', '/api/approval-templates?section=invalid')).status).toBe(400)
    await db.query("DELETE FROM user_roles WHERE user_id='user'")
  })

  it('any guard matches real directory route and rejects reordered client codes', async () => {
    expect((await post('user', any)).body.result).toBe('deny')
    expect((await get('user', '/api/approval-templates/directory/roles')).status).toBe(403)
    await db.query("INSERT INTO user_permissions VALUES ('user','approvals:admin-templates')")
    expect((await post('user', any)).body.result).toBe('allow')
    expect((await get('user', '/api/approval-templates/directory/roles')).status).toBe(200)
    expect((await post('user', { ...any, permissions: [...any.permissions].reverse() })).status).toBe(400)
    await db.query("DELETE FROM user_permissions WHERE user_id='user'")
  })

  it('checks target from live data and rejects a raw-only admin actor', async () => {
    const target = { ...single, subject: { kind: 'target', userId: 'target' } }
    expect((await post('rawadmin', target)).status).toBe(403)
    expect((await post('actor', target)).body.result).toBe('deny')
    await db.query("UPDATE users SET permissions='[\"approvals:*\"]'::jsonb WHERE id='target'")
    expect((await post('actor', target)).body.result).toBe('allow')
    expect((await get('target', '/api/approval-templates?section=invalid')).status).toBe(400)
    await db.query("UPDATE users SET is_active=false WHERE id='target'")
    expect((await post('actor', target)).body.result).toBe('unknown')
  })

  it('all guard accepts a resolved wildcard and has no registered production policy', async () => {
    await db.query("UPDATE users SET permissions='[\"approvals:*\"]'::jsonb WHERE id='user'")
    expect((await get('user', '/test/guard-all')).status).toBe(200)
    expect((await post('user', { subject: { kind: 'self' }, policyId: 'unregistered', mode: 'all', permissions: ['approvals:read', 'approvals:write'] })).body.result).toBe('unknown')
  })
  it('compares sheet-only grant to real context without a global code', async () => {
    const input = { subject: { kind: 'self' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1' } }
    const checked = await post('sheetreader', input)
    expect(checked.body.result).toBe('allow')
    expect(checked.body.layers).toEqual([{ layer: 'resource_visibility', result: 'allow' }, { layer: 'resource_context', result: 'allow' }])
    expect((await get('sheetreader', '/api/multitable/context?baseId=base1&sheetId=sheet1')).status).toBe(200)
    expect((await post('actor', { ...input, subject: { kind: 'target', userId: 'sheetreader' } })).body.result).toBe('allow')
    expect((await post('actor', { ...input, subject: { kind: 'target', userId: 'sheetother' } })).body.result).toBe('deny')
    expect((await get('sheetother', '/api/multitable/context?baseId=base1&sheetId=sheet1')).status).toBe(403)
  })

  it('collapses hidden, missing, cross-base, deleted and missing ACL into unknown', async () => {
    const input = { subject: { kind: 'self' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1' } }
    const hidden = await post('sheetother', input)
    const missing = await post('sheetother', { ...input, resource: { ...input.resource, sheetId: 'missing' } })
    const crossed = await post('sheetreader', { ...input, resource: { ...input.resource, baseId: 'base2' } })
    expect(hidden.body.layers).toEqual(missing.body.layers)
    expect(crossed.body.result).toBe('unknown')
    await db.query("UPDATE meta_sheets SET deleted_at=now() WHERE id='sheet1'")
    expect((await post('sheetreader', input)).body.result).toBe('unknown')
    await db.query("UPDATE meta_sheets SET deleted_at=NULL WHERE id='sheet1'")
    await db.query('ALTER TABLE spreadsheet_permissions RENAME TO spreadsheet_permissions_unavailable')
    expect((await post('sheetreader', input)).body.result).toBe('unknown')
    await db.query('ALTER TABLE spreadsheet_permissions_unavailable RENAME TO spreadsheet_permissions')
  })

  it('record checks match the row deny flag and conditional rules', async () => {
    const input = { subject: { kind: 'target', userId: 'sheetreader' }, policyId: 'multitable.record.read', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1', recordId: 'record1' } }
    expect((await post('actor', input)).body.result).toBe('allow')
    expect((await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')).status).toBe(200)
    await db.query("INSERT INTO record_permissions VALUES ('sheet1','record1','user','sheetreader','none')")
    await db.query("UPDATE meta_sheets SET row_level_read_permissions_enabled=true WHERE id='sheet1'")
    expect((await post('actor', input)).body.result).toBe('deny')
    expect((await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')).status).toBe(403)
    await db.query("UPDATE meta_sheets SET row_level_read_permissions_enabled=false WHERE id='sheet1'")
    expect((await post('actor', input)).body.result).toBe('allow')
    await db.query("DELETE FROM record_permissions")
    const rules = [{ id: 'r1', fieldId: 'field1', operator: 'eq', value: 'secret', effect: 'deny_read' }]
    await db.query("UPDATE meta_sheets SET row_level_read_permissions_enabled=true, conditional_read_rules=$1 WHERE id='sheet1'", [JSON.stringify(rules)])
    expect((await post('actor', input)).body.result).toBe('deny')
    expect((await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')).status).toBe(403)
    expect((await post('actor', { ...input, resource: { ...input.resource, recordId: 'record2' } })).body.result).toBe('unknown')
  })

  it('bounds a blocked resource query and leaves the read transaction without side effects', async () => {
    const input = { subject: { kind: 'self' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1' } }
    const locker = await db.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE spreadsheet_permissions IN ACCESS EXCLUSIVE MODE')
      expect((await post('sheetreader', input)).body.result).toBe('unknown')
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }
    await db.query('CREATE TABLE side_effect_probe (value text)')
    await db.query(`CREATE FUNCTION try_write_on_read(v text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
      BEGIN INSERT INTO side_effect_probe VALUES (v); RETURN v; END $$`)
    await db.query('ALTER TABLE spreadsheet_permissions RENAME TO spreadsheet_permissions_real')
    await db.query(`CREATE VIEW spreadsheet_permissions AS
      SELECT sheet_id, try_write_on_read(perm_code) AS perm_code, subject_type, subject_id FROM spreadsheet_permissions_real`)
    try {
      expect((await post('sheetreader', input)).body.result).toBe('unknown')
      expect((await db.query('SELECT COUNT(*)::int AS n FROM side_effect_probe')).rows[0].n).toBe(0)
    } finally {
      await db.query('DROP VIEW spreadsheet_permissions')
      await db.query('ALTER TABLE spreadsheet_permissions_real RENAME TO spreadsheet_permissions')
    }
  })

  it('enforces admission against the requested namespace despite a legacy global wildcard', async () => {
    const check = { subject: { kind: 'self' }, policyId: 'attendance.decision-trace', mode: 'single', permissions: ['attendance:read'] }
    await db.query("UPDATE users SET permissions='[\"*:*\"]'::jsonb WHERE id='admitted'")
    await db.query("INSERT INTO user_roles VALUES ('admitted','attendance_employee')")
    await db.query("INSERT INTO role_permissions VALUES ('attendance_employee','attendance:read')")
    await db.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ('admitted','attendance',false)")
    expect((await post('admitted', check)).body.result).toBe('deny')
    expect((await get('admitted', '/api/attendance/decision-trace?userId=ignored')).status).toBe(403)
    await db.query("UPDATE user_namespace_admissions SET enabled=true WHERE user_id='admitted' AND namespace='attendance'")
    expect((await post('admitted', check)).body.result).toBe('allow')
    expect((await get('admitted', '/api/attendance/decision-trace?userId=ignored')).status).toBe(400)
    expect((await post('actor', { ...check, subject: { kind: 'target', userId: 'admitted' } })).body.result).toBe('allow')
    await db.query("UPDATE user_namespace_admissions SET enabled=false WHERE user_id='admitted' AND namespace='attendance'")
    expect((await post('actor', { ...check, subject: { kind: 'target', userId: 'admitted' } })).body.result).toBe('deny')
  })

  it('view metadata follows the actual context capability and sheet parent', async () => {
    const input = { subject: { kind: 'target', userId: 'sheetreader' }, policyId: 'multitable.context.view-access', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1', viewId: 'view1' } }
    await db.query("INSERT INTO meta_view_permissions VALUES ('view1','read','user','actor')")
    expect((await post('actor', input)).body.result).toBe('deny')
    const before = await get('sheetreader', '/api/multitable/context?baseId=base1&sheetId=sheet1&viewId=view1')
    expect(before.status).toBe(200)
    expect(before.body.data.viewPermissions.view1.canAccess).toBe(false)
    await db.query("INSERT INTO meta_view_permissions VALUES ('view1','read','user','sheetreader')")
    expect((await post('actor', input)).body.result).toBe('allow')
    const after = await get('sheetreader', '/api/multitable/context?baseId=base1&sheetId=sheet1&viewId=view1')
    expect(after.body.data.viewPermissions.view1.canAccess).toBe(true)
    expect((await post('actor', { ...input, resource: { ...input.resource, viewId: 'view2' } })).body.result).toBe('unknown')
  })

  it('record field mask follows real data visibility and refuses unmodelled formula fields', async () => {
    const input = { subject: { kind: 'target', userId: 'sheetreader' }, policyId: 'multitable.record.field-read', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1', recordId: 'record1', fieldId: 'field1' } }
    await db.query("UPDATE meta_sheets SET row_level_read_permissions_enabled=false, conditional_read_rules='[]' WHERE id='sheet1'")
    expect((await post('actor', input)).body.result).toBe('allow')
    const before = await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')
    expect(before.status).toBe(200)
    expect(Object.keys(before.body.data.record.data)).toContain('field1')
    await db.query("INSERT INTO field_permissions VALUES ('sheet1','field1','user','sheetreader',false,false)")
    expect((await post('actor', input)).body.result).toBe('deny')
    const after = await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')
    expect(Object.keys(after.body.data.record.data)).not.toContain('field1')
    await db.query("DELETE FROM field_permissions")
    await db.query("UPDATE meta_fields SET type='formula' WHERE id='field1'")
    expect((await post('actor', input)).body.result).toBe('unknown')
    await db.query("UPDATE meta_fields SET type='select' WHERE id='field1'")
    expect((await post('actor', { ...input, resource: { ...input.resource, fieldId: 'missing' } })).body.result).toBe('unknown')
    expect((await post('actor', { ...input, resource: { ...input.resource, fieldId: 'field2' } })).body.result).toBe('unknown')
  })

  it('uses the target group and role grants with direct-grant precedence', async () => {
    const input = { subject: { kind: 'target', userId: 'sheetother' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1' } }
    await db.query("INSERT INTO platform_member_group_members VALUES ('sheetother','group1')")
    await db.query("INSERT INTO spreadsheet_permissions VALUES ('sheet1','spreadsheet:read','member-group','group1')")
    expect((await post('actor', input)).body.result).toBe('allow')
    expect((await get('sheetother', '/api/multitable/context?baseId=base1&sheetId=sheet1')).status).toBe(200)
    await db.query("INSERT INTO spreadsheet_permissions VALUES ('sheet1','spreadsheet:invalid','user','sheetother')")
    expect((await post('actor', input)).body.result).toBe('deny')
    expect((await get('sheetother', '/api/multitable/context?baseId=base1&sheetId=sheet1')).status).toBe(403)
    await db.query("DELETE FROM spreadsheet_permissions WHERE subject_id IN ('sheetother','group1')")
    await db.query("INSERT INTO user_roles VALUES ('sheetother','sheetrole')")
    await db.query("INSERT INTO spreadsheet_permissions VALUES ('sheet1','spreadsheet:read','role','sheetrole')")
    expect((await post('actor', input)).body.result).toBe('allow')
    expect((await get('sheetother', '/api/multitable/context?baseId=base1&sheetId=sheet1')).status).toBe(200)
  })

  it('uses the actual global JWT gate without bootstrap writes in platform and attendance modes', async () => {
    const { MetaSheetServer } = await import('../../src/index')
    const server = new MetaSheetServer({ port: 0, pluginDirs: [], manageProcessSignals: false })
    const globalApp = (server as unknown as { app: express.Express }).app
    globalApp.post('/api/admin/authorization-operations', (_req, res) => res.json({ ok: true }))
    globalApp.post('/api/admin/authorization-operations/preview', (_req, res) => res.json({ ok: true }))
    globalApp.get('/api/admin/authorization-operations/:id', (_req, res) => res.json({ ok: true }))
    await db.query("DELETE FROM user_roles WHERE user_id='admitted'")
    await db.query("DELETE FROM role_permissions WHERE role_id='attendance_employee'")
    await db.query("DELETE FROM user_namespace_admissions WHERE user_id='admitted'")
    await db.query("INSERT INTO user_roles VALUES ('admitted','attendance_employee')")
    await db.query("INSERT INTO role_permissions VALUES ('attendance_employee','attendance:read')")
    await db.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ('admitted','attendance',true)")
    await db.query("INSERT INTO user_session_revocations (user_id,revoked_after) VALUES ('revoked',now() + interval '1 minute')")
    await db.query("INSERT INTO user_permissions VALUES ('optout','approvals:read'),('unassigned','approvals:read')")
    await db.query("INSERT INTO spreadsheet_permissions VALUES ('sheet1','spreadsheet:read','user','optout'),('sheet1','spreadsheet:read','user','unassigned')")
    await db.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled,source) VALUES ('optout','attendance',false,'manual'),('unassigned','attendance',true,'role_unassigned')")
    await db.query('CREATE SEQUENCE write_attempt_probe')
    await db.query(`CREATE FUNCTION reject_test_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('write_attempt_probe'); RAISE EXCEPTION 'unexpected write during permission check'; END $$`)
    for (const table of ['users', 'user_roles', 'user_permissions', 'user_namespace_admissions', 'roles', 'role_permissions', 'user_orgs', 'user_sessions', 'user_session_revocations']) {
      await db.query(`CREATE TRIGGER check_no_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_test_write()`)
    }
    const oldMode = process.env.PRODUCT_MODE
    const input = { subject: { kind: 'self' }, policyId: 'attendance.decision-trace', mode: 'single', permissions: ['attendance:read'] }
    try {
      expect((await request(globalApp).post('/api/admin/authorization-operations/preview').set('Authorization', 'Bearer invalid-jwt').send({})).status).toBe(401)
      expect((await request(globalApp).post('/api/permissions/v2/business-check').set('Authorization', 'Bearer mst_invalid').send(input)).status).toBe(401)
      for (const mode of ['platform', 'attendance']) {
        process.env.PRODUCT_MODE = mode
        const admitted = await request(globalApp).post('/api/permissions/v2/business-check').set('Authorization', `Bearer ${tokens.admitted}`).send(input)
        expect(admitted.status).toBe(200)
        expect(admitted.body.result).toBe('allow')
        expect((await request(globalApp).post('/api/admin/authorization-operations/preview').set('Authorization', `Bearer ${tokens.revoked}`).send({})).status).toBe(401)
        for (const path of ['/api/admin/authorization-operations', '/api/admin/authorization-operations/preview']) {
          expect((await request(globalApp).post(path).set('Authorization', `Bearer ${tokens.sheetreader}`).send({})).status).toBe(200)
        }
        const receipt = '/api/admin/authorization-operations/12345678-1234-1234-1234-123456789abc'
        expect((await request(globalApp).get(receipt).set('Authorization', `Bearer ${tokens.sheetreader}`)).status).toBe(200)
        expect((await request(globalApp).head(receipt).set('Authorization', `Bearer ${tokens.sheetreader}`)).status).toBe(200)
        const encodedReceipt = '/API/ADMIN/AUTHORIZATION-OPERATIONS/%312345678-1234-1234-1234-123456789abc/'
        expect((await request(globalApp).get(encodedReceipt).set('Authorization', `Bearer ${tokens.sheetreader}`)).status).toBe(200)
        expect((await request(globalApp).head(encodedReceipt).set('Authorization', `Bearer ${tokens.sheetreader}`)).status).toBe(200)
        for (const optedOut of ['optout', 'unassigned']) {
          const approval = await request(globalApp).post('/api/permissions/v2/business-check').set('Authorization', `Bearer ${tokens[optedOut]}`).send(single)
          expect(approval.body.result).toBe('allow')
          const context = { subject: { kind: 'self' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1' } }
          expect((await request(globalApp).post('/api/permissions/v2/business-check').set('Authorization', `Bearer ${tokens[optedOut]}`).send(context)).body.result).toBe('allow')
        }
        const needsBootstrap = await request(globalApp).post('/api/permissions/v2/business-check').set('Authorization', `Bearer ${tokens.sheetreader}`).send(input)
        expect(needsBootstrap.status).toBe(200)
        expect(needsBootstrap.body.result).toBe('unknown')
        expect((await db.query("SELECT 1 FROM user_roles WHERE user_id='sheetreader' AND role_id='attendance_employee'")).rows).toHaveLength(0)
        expect((await db.query('SELECT is_called FROM write_attempt_probe')).rows[0].is_called).toBe(false)
      }
      await db.query('ALTER TABLE user_sessions RENAME TO user_sessions_unavailable')
      try {
        expect((await request(globalApp).post('/api/admin/authorization-operations/preview').set('Authorization', `Bearer ${tokens.admitted}`).send({})).status).toBe(503)
      } finally {
        await db.query('ALTER TABLE user_sessions_unavailable RENAME TO user_sessions')
      }
    } finally {
      process.env.PRODUCT_MODE = oldMode
      for (const table of ['users', 'user_roles', 'user_permissions', 'user_namespace_admissions', 'roles', 'role_permissions', 'user_orgs', 'user_sessions', 'user_session_revocations']) {
        await db.query(`DROP TRIGGER check_no_write ON ${table}`)
      }
    }
  })

  it('does not synthesize a development admin for a missing principal', async () => {
    const token = authService.createToken({ id: 'missing-user', email: 'missing@invalid.test', name: 'missing', role: 'user', permissions: [], created_at: new Date(), updated_at: new Date() })
    expect(await authService.verifyToken(token, { readOnlyPermissionCheck: true })).toBeNull()
  })

  it('enforces approval projection participation on sheets and individual rows', async () => {
    await db.query("INSERT INTO meta_bases (id,name) VALUES ('base_apr_projection','Projection')")
    await db.query("INSERT INTO meta_sheets (id,base_id,name) VALUES ('projection_sheet','base_apr_projection','Projection')")
    await db.query("INSERT INTO spreadsheet_permissions VALUES ('projection_sheet','spreadsheet:read','user','sheetreader')")
    const input = { subject: { kind: 'target', userId: 'sheetreader' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'base_apr_projection', sheetId: 'projection_sheet' } }
    expect((await post('actor', input)).body.result).toBe('deny')
    await db.query("INSERT INTO meta_records (id,sheet_id,data) VALUES ('projection_own','projection_sheet',$1),('projection_other','projection_sheet',$2)", [JSON.stringify({ projection_sheet__requesterId: 'sheetreader' }), JSON.stringify({ projection_sheet__requesterId: 'sheetother' })])
    expect((await post('actor', input)).body.result).toBe('allow')
    expect((await get('sheetreader', '/api/multitable/context?baseId=base_apr_projection&sheetId=projection_sheet')).status).toBe(200)
    const record = { ...input, policyId: 'multitable.record.read', resource: { ...input.resource, recordId: 'projection_other' } }
    expect((await post('actor', record)).body.result).toBe('deny')
    expect((await get('sheetreader', '/api/multitable/records/projection_other?sheetId=projection_sheet')).status).toBe(403)
    expect((await post('actor', { ...record, resource: { ...record.resource, recordId: 'projection_own' } })).body.result).toBe('allow')
  })

  it('uses the authenticated tenant for an e-learning projection and cannot infer a target tenant', async () => {
    const org = 'tenant-a'
    const baseId = deriveElearningProjectionBaseId(org)
    const sheetId = deriveElearningProjectionSheetId(org)
    await db.query("UPDATE users SET permissions='[\"*:*\"]'::jsonb WHERE id='tenantreader'")
    await db.query("INSERT INTO user_orgs VALUES ('tenantreader',$1,true)", [org])
    await db.query('INSERT INTO meta_bases (id,name) VALUES ($1,$2)', [baseId, 'Projection'])
    await db.query('INSERT INTO meta_sheets (id,base_id,name,system_kind) VALUES ($1,$2,$3,$4)', [sheetId, baseId, 'Projection', 'elearning_projection'])
    await db.query('INSERT INTO elearning_stats_multitable_sheets VALUES ($1,$2,$3)', [sheetId, baseId, org])
    tokens.tenantreader = authService.createToken({ id: 'tenantreader', email: 'tenantreader@invalid.test', name: 'tenantreader', role: 'user', permissions: [], tenantId: org, created_at: new Date(), updated_at: new Date() })
    const input = { subject: { kind: 'self' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId, sheetId } }
    expect((await post('tenantreader', input)).body.result).toBe('allow')
    expect((await get('tenantreader', `/api/multitable/context?baseId=${baseId}&sheetId=${sheetId}`)).status).toBe(200)
    expect((await post('actor', { ...input, subject: { kind: 'target', userId: 'tenantreader' } })).body.result).toBe('unknown')
    await db.query("UPDATE user_orgs SET is_active=false WHERE user_id='tenantreader'")
    expect((await post('tenantreader', input)).body.result).toBe('unknown')
    expect((await get('tenantreader', `/api/multitable/context?baseId=${baseId}&sheetId=${sheetId}`)).status).toBe(404)
  })

  it('keeps stock-preparation overview and grid closure clamps without inferring write permission', async () => {
    const sheetId = 'sheet_000000000000000000000001'
    await db.query("INSERT INTO meta_bases (id,name) VALUES ('stockbase','Stock')")
    await db.query("INSERT INTO meta_sheets (id,base_id,name,system_kind,grid_export_closure) VALUES ($1,'stockbase','Overview','stock_prep_overview','closed')", [sheetId])
    await db.query("INSERT INTO spreadsheet_permissions VALUES ($1,'spreadsheet:read','user','sheetreader')", [sheetId])
    const input = { subject: { kind: 'self' }, policyId: 'multitable.context.sheet', resource: { kind: 'sheet', baseId: 'stockbase', sheetId } }
    expect((await post('sheetreader', input)).body.result).toBe('allow')
    const actual = await get('sheetreader', `/api/multitable/context?baseId=stockbase&sheetId=${sheetId}`)
    expect(actual.status).toBe(200)
    expect(actual.body.data.capabilities.canRead).toBe(true)
    expect(actual.body.data.capabilities.canExport).toBe(false)
    expect((await post('sheetreader', { subject: { kind: 'self' }, policyId: 'unregistered-write', mode: 'single', permissions: ['multitable:write'] })).body.result).toBe('unknown')
  })

  it.skipIf(process.env.RBAC_TOKEN_TRUST !== 'true')('matches actual guards for a trusted JWT and refuses target-token inference', async () => {
    const token = jwt.sign({ userId: 'user', role: 'user', roles: ['user'], perms: ['approvals:read', 'attendance:*'] }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    tokens.user = token
    expect((await post('user', single)).body.result).toBe('allow')
    expect((await get('user', '/api/approval-templates?section=invalid')).status).toBe(400)
    const attendance = { subject: { kind: 'self' }, policyId: 'attendance.decision-trace', mode: 'single', permissions: ['attendance:read'] }
    await db.query("INSERT INTO user_roles VALUES ('user','attendance_employee')")
    await db.query("INSERT INTO role_permissions VALUES ('attendance_employee','attendance:read')")
    await db.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ('user','attendance',false)")
    expect((await post('user', attendance)).body.result).toBe('deny')
    expect((await get('user', '/api/attendance/decision-trace?userId=ignored')).status).toBe(403)
    await db.query("UPDATE user_namespace_admissions SET enabled=true WHERE user_id='user' AND namespace='attendance'")
    expect((await post('user', attendance)).body.result).toBe('allow')
    expect((await get('user', '/api/attendance/decision-trace?userId=ignored')).status).toBe(400)
    expect((await post('actor', { ...single, subject: { kind: 'target', userId: 'user' } })).body.result).toBe('unknown')
  })

  it('retains the legacy wildcard preflight, guard probe and real stock business difference', async () => {
    await db.query("UPDATE users SET permissions='[\"stock-prep:*\"]'::jsonb WHERE id='wildcard'")
    await db.query("INSERT INTO user_roles VALUES ('wildcard','stock-prep_holder')")
    await db.query("INSERT INTO role_permissions VALUES ('stock-prep_holder','stock-prep:other')")
    await db.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ('wildcard','stock-prep',true)")
    expect((await get('wildcard', '/test/guard-stock')).status).toBe(200)
    const preflight = await request(app).post('/api/permissions/check').set('Authorization', `Bearer ${tokens.wildcard}`).send({ permission: 'stock-prep:read' })
    expect(preflight.status).toBe(200)
    expect(preflight.body.allowed).toBe(true)
    expect((await get('wildcard', '/api/integration/stock-preparation/preflight')).status).toBe(403)
    const unsupported = { subject: { kind: 'self' }, policyId: 'stock-preparation.preflight', mode: 'single', permissions: ['stock-prep:read'] }
    expect((await post('wildcard', unsupported)).body.result).toBe('unknown')
  })

  it('matches serialized JSON-string field properties and normalized scalar types', async () => {
    const input = { subject: { kind: 'target', userId: 'sheetreader' }, policyId: 'multitable.record.field-read', resource: { kind: 'sheet', baseId: 'base1', sheetId: 'sheet1', recordId: 'record1', fieldId: 'field1' } }
    await db.query("UPDATE meta_sheets SET row_level_read_permissions_enabled=false, conditional_read_rules='[]' WHERE id='sheet1'")
    await db.query("DELETE FROM field_permissions WHERE field_id='field1'")
    for (const property of [{ hidden: true }, { visible: false }]) {
      await db.query('UPDATE meta_fields SET property=$1::jsonb WHERE id=$2', [JSON.stringify(JSON.stringify(property)), 'field1'])
      expect((await post('actor', input)).body.result).toBe('unknown')
      const actual = await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')
      expect(actual.status).toBe(200)
      expect(Object.keys(actual.body.data.record.data)).not.toContain('field1')
    }
    for (const type of ['string', 'boolean']) {
      await db.query('UPDATE meta_fields SET property=$1::jsonb, type=$2 WHERE id=$3', ['{}', type, 'field1'])
      expect((await post('actor', input)).body.result).toBe('allow')
      const actual = await get('sheetreader', '/api/multitable/records/record1?sheetId=sheet1')
      expect(actual.status).toBe(200)
      expect(Object.keys(actual.body.data.record.data)).toContain('field1')
    }
    await db.query("UPDATE meta_fields SET type='select' WHERE id='field1'")
  })

  it.skipIf(process.env.RBAC_TOKEN_TRUST !== 'true')('treats dev trusted admin as token guard context, not database delegation authority', async () => {
    const token = jwt.sign({ userId: 'wildcard', role: 'user', roles: ['admin'], perms: [] }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    tokens.wildcard = token
    expect((await db.query("SELECT role FROM users WHERE id='wildcard'")).rows[0].role).toBe('user')
    expect((await db.query("SELECT 1 FROM user_roles WHERE user_id='wildcard' AND role_id='admin'")).rows).toHaveLength(0)
    expect((await post('wildcard', single)).body.result).toBe('allow')
    expect((await get('wildcard', '/api/approval-templates?section=invalid')).status).toBe(400)
    expect((await post('wildcard', { ...single, subject: { kind: 'target', userId: 'target' } })).status).toBe(403)
  })

})
