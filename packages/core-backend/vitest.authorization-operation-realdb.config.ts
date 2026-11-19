import { defineConfig } from 'vitest/config'

/**
 * Isolated synthetic PG only. By default this tests the real fail-closed gate.
 * PERMISSION_COMMAND_TEST_UNFENCED_FIXTURE=1 bypasses the fence IN MEMORY for
 * small synthetic-schema logic fixtures only; it is not a serialization proof.
 */
export default defineConfig({
  plugins: [{
    name: 'authorization-operation-unfenced-fixture',
    enforce: 'pre',
    transform(source, id) {
      const file = id.replaceAll('\\', '/')
      const unfenced = process.env.PERMISSION_COMMAND_TEST_UNFENCED_FIXTURE === '1'
      if (file.endsWith('/src/rbac/authorization-input-lock.ts') && unfenced) {
        const anchor = 'await acquireAuthorizationOperationFence(query)'
        if (!source.includes(anchor)) throw new Error('fixture fence anchor missing')
        return source.replace(anchor, 'void query')
      }
      if (file.endsWith('/src/admin/authorization-operation-validation.ts') && process.env.PERMISSION_COMMAND_TEST_MUTATION === 'exception_parser_reason') {
        const anchor="if ((operationAction.kind==='direct.grant' || operationAction.kind==='template.apply') && reason===undefined)"
        if(!source.includes(anchor)) throw new Error('exception reason parser mutation anchor missing')
        return source.replace(anchor,'if (false)')
      }
      if (file.endsWith('/src/admin/authorization-operation-snapshot.ts') && process.env.PERMISSION_COMMAND_TEST_MUTATION === 'exception_catalog_witness') {
        const anchor='SELECT code, xmin::text AS row_version, to_jsonb(p) AS definition FROM permissions p'
        if(!source.includes(anchor)) throw new Error('exception catalog witness mutation anchor missing')
        return source.replace(anchor,'SELECT code, NULL AS row_version, NULL AS definition FROM permissions p')
      }
      if (file.endsWith('/src/admin/authorization-operation-snapshot.ts') && process.env.PERMISSION_COMMAND_TEST_MUTATION === 'role_version') {
        const anchor = 'SELECT id::text AS id, xmin::text AS row_version, updated_at::text AS updated_at FROM roles'
        if (!source.includes(anchor)) throw new Error('fixture mutation anchor missing')
        return source.replace(anchor, 'SELECT id::text AS id, NULL AS row_version, updated_at::text AS updated_at FROM roles')
      }
      if (file.endsWith('/src/admin/authorization-operation-snapshot.ts') && process.env.PERMISSION_COMMAND_TEST_MUTATION === 'delegated_activation_filter') {
        const anchor = 'excludeDisabledDelegationNamespaces(heldNamespaces, delegationActivations.filter(row => row.admin_user_id === actorId))'
        if (!source.includes(anchor)) throw new Error('delegation activation filter mutation anchor missing')
        return source.replace(anchor, 'heldNamespaces')
      }
      if (file.endsWith('/src/admin/authorization-operation-snapshot.ts') && process.env.PERMISSION_COMMAND_TEST_MUTATION === 'delegated_activation_revision') {
        const anchor = 'SELECT admin_user_id, namespace, enabled, revision::text AS revision FROM delegated_role_admin_activation'
        if (!source.includes(anchor)) throw new Error('delegation activation revision mutation anchor missing')
        return source.replace(anchor, 'SELECT admin_user_id, namespace, enabled, NULL AS revision FROM delegated_role_admin_activation')
      }
      if (!file.endsWith('/src/admin/authorization-operation-service.ts')) return null
      let transformed = source
      const mutation=process.env.PERMISSION_COMMAND_TEST_MUTATION
      const delegatedMutants: Record<string,[string,string]> = {
        delegated_audience: ['item.namespace===namespace && item.allowed','item.allowed'],
        delegated_role_scope: ["isRoleAssignable(roleId,{kind:'namespaces',namespaces:[ns]})",'true'],
        delegated_role_codes: ["!delegatedRoleCodeRefusal(reviewDelegatedRoleCodes(roleId,codes,[ns]),input.action.kind==='role.assign'?'assign':'unassign')",'true'],
        delegated_redaction: ['impact.effectiveBefore.filter(visible)','impact.effectiveBefore.filter(()=>true)'],
        delegated_active: ["actor.is_active !== true || ",''],
        delegated_pre_auth: ['evaluateAuthorizationOperationAccess(snapshot,actorId,input,explicitImpact(input))','void snapshot'],
        delegated_implicit: ['const access=evaluateAuthorizationOperationAccess(snapshot,actorId,input,impact)','const access=evaluateAuthorizationOperationAccess(snapshot,actorId,input,explicitImpact(input))'],
        delegated_receipt: ['const access=evaluateAuthorizationOperationAccess(snapshot,actorId,row.action,row.receipt.impact)',"const access={kind:'platform' as const}"],
        delegated_replay: ['const access=evaluateAuthorizationOperationAccess(snapshot,actorId,checked,impact)',"const access=stored ? {kind:'platform' as const} : evaluateAuthorizationOperationAccess(snapshot,actorId,checked,impact)"],
        delegated_activation_lookup: ['(await filterEnabledDelegationNamespaces(run, actorId, namespaces)).length', 'namespaces.length'],
        exception_rbac: ["if (isExceptionAction(input.action) && !roles.some(row=>row.role_id==='admin'))",'if (false)'],
        exception_self: ["input.action.kind === 'direct.grant' || input.action.kind === 'template.apply' || ",''],
        exception_catalog: ["if ((input.action.kind==='template.apply' || input.action.kind==='direct.grant') && canonicalOperationValue(snapshot.permissionCatalog.map(row=>row.code))!==canonicalOperationValue(snapshot.requestedCodes))",'if (false)'],
        exception_core_reason: ["if ((input.action.kind==='direct.grant' || input.action.kind==='template.apply') && !input.reason?.trim())",'if (false)'],
        exception_legacy_filter: ["AND request_digest <> 'legacy'",''],
        exception_collision: ["if (collision.rows.length) return deny(409,'IDEMPOTENCY_CONFLICT')",'void collision'],
        exception_legacy_integrity: ["if (canonicalOperationValue(expectedLegacy)!==canonicalOperationValue(after.target?.permissions))",'if (false)'],
      }
      if(mutation && delegatedMutants[mutation]) {
        const [before,after]=delegatedMutants[mutation]
        if(!transformed.includes(before)) throw new Error('delegated mutation anchor missing')
        transformed=transformed.replace(before,after)
      }
      if (unfenced) {
        const readAnchor = "if (!await assertAuthorizationOperationReadReady(run, AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)) throw new AuthorizationInputBusyError('lock_timeout')"
        if (!transformed.includes(readAnchor)) throw new Error('fixture readiness anchor missing')
        transformed = transformed.replace(readAnchor, 'void run')
      }
      if (process.env.PERMISSION_COMMAND_TEST_SLOW_PLAN === '1') {
        const readAnchor = `const rows = await run("SELECT target_user_id, action, request_digest, receipt FROM authorization_operation_receipts WHERE actor_id = $1 AND client_operation_id = $2::uuid AND request_digest <> 'legacy'", [actorId, id])`
        if (!transformed.includes(readAnchor)) throw new Error('fixture slow-plan anchor missing')
        transformed = transformed.replace(readAnchor, () => "await run('SELECT pg_sleep(6)')\n  " + readAnchor)
      }
      if (process.env.PERMISSION_COMMAND_TEST_FAULT==='legacy_corrupt') {
        const anchor='        const after = await readOperationSnapshot(tx.query, actorId, request)'
        if(!transformed.includes(anchor)) throw new Error('legacy corruption anchor missing')
        transformed=transformed.replace(anchor, () => `        await tx.query("UPDATE users SET permissions = permissions || '[null]'::jsonb WHERE id=$1",[request.targetUserId])\n${anchor}`)
      }
      const fault = process.env.PERMISSION_COMMAND_TEST_FAULT
      if (fault && fault!=='legacy_corrupt') {
        const anchors: Record<string, string> = {
          admission: '        for (const change of request.admissionChanges) await writeUserNamespaceAdmission',
          audit: '        await tx.query(`INSERT INTO authorization_operation_audit',
          cleanup: '            await disableNamespaceAdmissionsWithoutRoles',
        }
        const faultAnchor = anchors[fault]
        if (!faultAnchor || !transformed.includes(faultAnchor)) throw new Error('fixture fault anchor missing')
        transformed = transformed.replace(faultAnchor, () => `        await tx.query('SELECT 1/0')\n${faultAnchor}`)
      }
      if (process.env.PERMISSION_COMMAND_TEST_DELAY_COMMIT === '1') {
        const auditAnchor = '        await tx.query(`INSERT INTO authorization_operation_audit'
        if (!transformed.includes(auditAnchor)) throw new Error('fixture delayed-commit anchor missing')
        const injected = [
          "        await tx.query('CREATE TEMP TABLE permission_command_commit_probe (x integer)')",
          "        await tx.query(`CREATE FUNCTION pg_temp.permission_command_commit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(8); RETURN NEW; END $$`)",
          "        await tx.query('CREATE CONSTRAINT TRIGGER permission_command_commit_delay AFTER INSERT ON pg_temp.permission_command_commit_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.permission_command_commit_delay()')",
          "        await tx.query('INSERT INTO pg_temp.permission_command_commit_probe VALUES (1)')",
        ].join('\n')
        transformed = transformed.replace(auditAnchor, () => `${injected}\n${auditAnchor}`)
      }
      return transformed === source ? null : transformed
    },
  }],
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['tests/integration/authorization-operation-*.db.test.ts', 'tests/integration/authorization-exception-write.db.test.ts', 'tests/unit/authorization-operation-deadline.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    maxWorkers: 3,
    minWorkers: 1,
  },
})
