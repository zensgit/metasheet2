import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.authorization-operation-realdb.config'

// Mutations are test-process-only; production source and schema stay unchanged.
export default mergeConfig(base, defineConfig({
  test: { include: ['tests/integration/authorization-operation-*.db.test.ts','tests/unit/authorization-input-migration-rules.guard.test.ts'] },
  plugins: [{ name:'role-provenance-mutation', enforce:'pre', transform(source,id) {
    const file=id.replaceAll('\\\\','/'), mutation=process.env.PERMISSION_PROVENANCE_MUTANT
    if (file.endsWith('/tests/helpers/authorization-input-migration-judge.ts') && (mutation==='lock_judge_missing' || mutation==='lock_judge_wide')) {
      const anchor="head === 'LOCK' && tokens.length === 7 && isKeyword(tokens[1], 'TABLE') && isKeyword(tokens[2], 'USER_ROLES') && isKeyword(tokens[3], 'IN') && isKeyword(tokens[4], 'ACCESS') && isKeyword(tokens[5], 'EXCLUSIVE') && isKeyword(tokens[6], 'MODE')"
      if(!source.includes(anchor))throw new Error('missing lock judge mutation anchor')
      return source.replace(anchor,mutation==='lock_judge_missing' ? 'false' : "head === 'LOCK'")
    }
    let transformed=source
    if (file.endsWith('/src/db/migrations/zzzz20261117130000_add_user_role_assignment_source.ts') && process.env.PERMISSION_PROVENANCE_TEST_LOCK_RACE==='1') {
      const anchor="  if (Number(result.rows[0]?.count ?? 0)>0)"
      if(!transformed.includes(anchor))throw new Error('missing down race injection anchor')
      transformed=transformed.replace(anchor, "  await sql`SELECT pg_sleep(2)`.execute(db)\n"+anchor)
    }
    const rules: Record<string,[string,string,string]>={
      conflict:['/src/rbac/role-assignment.ts','ON CONFLICT DO NOTHING','ON CONFLICT (user_id, role_id) DO UPDATE SET assignment_source=EXCLUDED.assignment_source'],
      constraint:['/src/db/migrations/zzzz20261117130000_add_user_role_assignment_source.ts',"CHECK (assignment_source IN ('manual', 'creation'))",'CHECK (true)'],
      down_lock:['/src/db/migrations/zzzz20261117130000_add_user_role_assignment_source.ts','await sql`LOCK TABLE user_roles IN ACCESS EXCLUSIVE MODE`.execute(db)','void db'],
      down:['/src/db/migrations/zzzz20261117130000_add_user_role_assignment_source.ts','if (Number(result.rows[0]?.count ?? 0)>0)','if (false)'],
      unknown:['/src/routes/admin-users.ts',"row.assignment_source : 'unknown'","row.assignment_source : 'manual'"],
      create:['/src/admin/admin-user-birth-command.ts',"assignmentSource: 'creation',","assignmentSource: 'manual',"],
      manual:['/src/admin/platform-role-assign-command.ts',"assignmentSource: 'manual',",''],
      attendance_single:['/src/admin/attendance-role-commands.ts',"assignmentSource: 'manual',",''],
      attendance_batch:['/src/admin/attendance-role-commands.ts',"assignmentSource: 'manual',",''],
      delegated_manual:['/src/routes/admin-users.ts',"roleId, assignmentSource: 'manual', scope: activeScope",'roleId, scope: activeScope'],
      batch_create:['/src/admin/admin-user-batch-birth-command.ts',"assignmentSource: 'creation',","assignmentSource: undefined,"],
      batch_update:['/src/routes/admin-user-batch.ts',"assignmentSource: 'manual',","assignmentSource: undefined,"],
      delegated_view:['/src/routes/admin-users.ts',"snapshot.roleAssignments.filter(assignment => revocable.some(role => role.id === assignment.roleId))",'snapshot.roleAssignments'],
      command:['/src/admin/authorization-operation-service.ts',"roleId, assignmentSource: 'manual', scope: access.kind",'roleId, scope: access.kind'],
      register:['/src/auth/AuthService.ts',"this.insertUserRolesOnce(client, userId, selfServiceRoleIds, 'creation')",'this.insertUserRolesOnce(client, userId, selfServiceRoleIds)'],
      backfill:['/src/auth/AuthService.ts','this.insertUserRolesOnce(client, userId, roleIds)','this.insertUserRolesOnce(client, userId, roleIds, \'creation\')'],
    }
    const rule=mutation ? rules[mutation] : undefined
    if(!rule || !file.endsWith(rule[0]))return transformed===source ? null : transformed
    if(!transformed.includes(rule[1]))throw new Error(`missing provenance mutation anchor: ${mutation}`)
    return transformed.replace(rule[1],rule[2])
  }}],
}))
