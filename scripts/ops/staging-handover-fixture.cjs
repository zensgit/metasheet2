const { Client } = require('pg')
const bcrypt = require('bcryptjs')
const { randomUUID } = require('node:crypto')
const { listUserPermissions } = require('/app/packages/core-backend/dist/src/rbac/service.js')
const { approvalPendingSource } = require('/app/packages/core-backend/dist/src/services/approval-pending-source.js')

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  const q = (sql, args) => db.query(sql, args)
  const users = ['candidate-admin', 'candidate-a', 'candidate-b']
  if (process.env.FIXTURE_ACTION === 'seed') {
    const password = await bcrypt.hash(process.env.SYNTHETIC_PASSWORD, 10)
    for (const id of users) {
      await q(`INSERT INTO users(id,username,email,name,password_hash,role,is_admin,is_active,must_change_password,activation_status,local_password_set)
        VALUES($1,$1,$1||'@synthetic.invalid',$1,$2,$3,$4,true,false,'activated',true)`,
      [id, password, id === users[0] ? 'admin' : 'user', id === users[0]])
      await q(`INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,'default',true)
        ON CONFLICT(user_id,org_id) DO UPDATE SET is_active=true`, [id])
    }
    await q("INSERT INTO roles(id,name) VALUES('admin','admin') ON CONFLICT DO NOTHING")
    await q("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin') ON CONFLICT DO NOTHING", [users[0]])
    const integrations = [randomUUID(), randomUUID(), randomUUID()]
    const enterprise = ['synthetic-corp-a', 'synthetic-corp-a', 'synthetic-corp-b']
    for (let i = 0; i < 3; i++) {
      const corpName = i === 2 ? 'Synthetic Other Enterprise' : 'Synthetic Information Team'
      const appName = i === 0 ? 'SyntheticSheet' : i === 1 ? 'SyntheticCanary' : 'SyntheticUAT'
      const appCorpId = i === 0 ? enterprise[2] : enterprise[i]
      const config = { appKey: `synthetic-app-${i}`, appSecret: 'synthetic-only-secret',
        corpName, appName, admissionMode: 'manual_only', memberGroupSyncMode: 'disabled',
        identityVerification: { source: 'admin_console', corpId: enterprise[i], appKey: `synthetic-app-${i}`,
          corpName, appName, appCorpId, appCorpName: i === 0 ? 'Synthetic Other Enterprise' : corpName,
          checkedBy: users[0], checkedAt: '2026-11-01T00:00:00Z' } }
      await q(`INSERT INTO directory_integrations(id,org_id,provider,name,corp_id,config,sync_enabled)
        VALUES($1,'default','dingtalk',$2,$3,$4,false)`, [integrations[i], ['Synthetic E4', 'Synthetic Canary', 'Synthetic UAT'][i], enterprise[i], config])
    }
    const departments = []
    for (let i = 1; i <= 7; i++) {
      const id = randomUUID(); departments.push(id)
      await q(`INSERT INTO directory_departments(id,integration_id,external_department_id,external_parent_department_id,name,full_path)
        VALUES($1,$2,$3,$4,$5,$5)`, [id, integrations[0], String(i), i === 1 ? null : '1', `Synthetic Department ${i}`])
    }
    for (let i = 0; i < 5; i++) {
      const id = randomUUID()
      await q(`INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,union_id,open_id,external_key,name)
        VALUES($1,$2,$3,$4,$5,$6,$5,$4)`, [id, integrations[0], enterprise[0], `synthetic-employee-${i}`, `synthetic-union-${i}`, `synthetic-open-${i}`])
      await q(`INSERT INTO directory_account_departments(directory_account_id,directory_department_id,is_primary,is_manager)
        VALUES($1,$2,true,$3)`, [id, departments[1], i === 0])
      if (i >= 2) continue
      const user = users[i + 1]
      await q(`INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy)
        VALUES($1,$2,'linked','manual_admin')`, [id, user])
      await q(`INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_union_id,provider_open_id,bound_by)
        VALUES('dingtalk',$1,$2,$3,$4,$5,$6)`, [`${enterprise[0]}:synthetic-open-${i}`, user, enterprise[0], `synthetic-union-${i}`, `synthetic-open-${i}`, users[0]])
      await q(`INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES('dingtalk',$1,true)`, [user])
      for (let j = 0; j < (i === 0 ? 2 : 1); j++) {
        const role = `candidate-role-${i}-${j}`
        await q('INSERT INTO roles(id,name) VALUES($1,$1)', [role])
        await q('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [user, role])
        for (const code of ['approvals:read', 'approvals:act']) {
          await q('INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [code])
          await q('INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)', [role, code])
        }
      }
      for (let j = 0; j < (i === 0 ? 5 : 4); j++) {
        const instance = `candidate-approval-${i}-${j}`
        await q(`INSERT INTO approval_instances(id,status,current_node_key,title,org_id)
          VALUES($1,'pending','approve',$1,'default')`, [instance])
        await q(`INSERT INTO approval_assignments(instance_id,assignment_type,assignee_id,node_key,entry_epoch,is_active)
          VALUES($1,'user',$2,'approve',1,true)`, [instance, user])
      }
    }
    console.log('QA_RESULT=' + JSON.stringify({ sourceIntegrationId: integrations[0], targetIntegrationId: integrations[1], actorId: users[0] }))
  } else if (process.env.FIXTURE_ACTION === 'graph') {
    const result = {}
    for (const [table, key] of [['users','id'], ['user_roles','user_id'], ['user_permissions','user_id'], ['user_orgs','user_id'], ['user_external_identities','local_user_id'], ['user_external_auth_grants','local_user_id']]) {
      const rows = (await q(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [users])).rows.map(x => x.row)
      result[table] = rows.map(({ last_login_at, updated_at, profile, ...row }) => row)
    }
    result.links = (await q('SELECT to_jsonb(t) AS row FROM directory_account_links t WHERE local_user_id=ANY($1::text[]) ORDER BY directory_account_id', [users])).rows
    result.approvals = (await q("SELECT to_jsonb(t) AS row FROM approval_instances t WHERE id LIKE 'candidate-approval-%' ORDER BY id")).rows
    result.assignments = (await q("SELECT to_jsonb(t) AS row FROM approval_assignments t WHERE instance_id LIKE 'candidate-approval-%' ORDER BY id")).rows
    result.todo = []
    for (const user of users.slice(1)) {
      const permissions = await listUserPermissions(user, q)
      const roles = (await q('SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id', [user])).rows.map(r => r.role_id)
      const items = await approvalPendingSource.listPendingForUser({ actorId: user, roles, permissions })
      result.todo.push({ roles, permissions: permissions.sort(), items: items.map(i => ({ id: i.id, actionable: i.actionable })).sort((a,b) => a.id.localeCompare(b.id)) })
    }
    console.log('QA_RESULT=' + JSON.stringify(result))
  } else throw Error('UNKNOWN_FIXTURE_ACTION')
  await db.end()
  process.exit(0)
}
main().catch(() => { console.error('SYNTHETIC_FIXTURE_FAILED'); process.exit(1) })
