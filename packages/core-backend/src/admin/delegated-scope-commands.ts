import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { query } from '../db/pg'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { deriveDelegatedAdminNamespace } from '../rbac/namespace-admission'
import { assertConfiguredActiveDelegation, initializeDelegationActivation } from './delegated-scope-activation'
import { PlatformActorAuthorityLost } from './platform-actor-authority'
import {
  isDelegatedScopeExactDepartmentEnabled,
  resolveDelegatedIncludeChildrenWrite,
} from './delegated-scope-rollout'

export type DelegatedScopeAction = 'assign' | 'unassign'

export type DelegatedScopeIncludeChildrenIntent =
  | { readonly kind: 'omitted' }
  | { readonly kind: 'explicit'; readonly value: boolean }

export type WriteDelegatedAdminScopeCommandInput = {
  actorId: string
  userId: string
  action: DelegatedScopeAction
  namespace: string
  directoryDepartmentId: string
  includeChildrenIntent: DelegatedScopeIncludeChildrenIntent
}

export type WriteDelegatedAdminScopeCommandResult =
  | { refused: 'namespace'; adminNamespaces: readonly string[] }
  | { refused: 'exact'; adminNamespaces: readonly string[] }
  | { refused: false; adminNamespaces: readonly string[]; persisted: true | false | null }

export type WriteDelegatedAdminMemberGroupsCommandInput = {
  actorId: string
  userId: string
  action: DelegatedScopeAction
  namespace: string
  groupId: string
}

export type WriteDelegatedAdminMemberGroupsCommandResult =
  | { refused: true; adminNamespaces: readonly string[] }
  | { refused: false; adminNamespaces: readonly string[] }

export type DelegatedScopeTemplateMode = 'replace' | 'merge'

export type ApplyDelegatedScopeTemplateCommandInput = {
  actorId: string
  userId: string
  namespace: string
  templateId: string
  mode: DelegatedScopeTemplateMode
}

export type DelegatedScopeTemplateDepartment = {
  readonly directoryDepartmentId: string
  readonly includeChildren: true | false
}

export type DelegatedScopeTemplateMemberGroup = {
  readonly id: string
}

export type ApplyDelegatedScopeTemplateCommandResult =
  | { refused: 'namespace'; adminNamespaces: readonly string[] }
  | { refused: 'missing-template'; adminNamespaces: readonly string[] }
  | { refused: 'empty'; adminNamespaces: readonly string[] }
  | { refused: 'exact'; adminNamespaces: readonly string[] }
  | {
      refused: false
      adminNamespaces: readonly string[]
      departments: readonly DelegatedScopeTemplateDepartment[]
      memberGroups: readonly DelegatedScopeTemplateMemberGroup[]
    }

type ScopeRequest = Readonly<{
  actorId: string
  userId: string
  action: DelegatedScopeAction
  namespace: string
  directoryDepartmentId: string
  includeChildrenIntent: DelegatedScopeIncludeChildrenIntent
}>

type GroupRequest = Readonly<{
  actorId: string
  userId: string
  action: DelegatedScopeAction
  namespace: string
  groupId: string
}>

type TemplateRequest = Readonly<{
  actorId: string
  userId: string
  namespace: string
  templateId: string
  mode: DelegatedScopeTemplateMode
}>

type DelegatedScopeContext = Readonly<{
  actorId: string
  userId: string
  rawRoleIds: readonly string[]
  roleIds: readonly string[]
  subjects: readonly string[]
  plan: AuthorizationInputPlan
}>

type ScopeContext = ScopeRequest & DelegatedScopeContext
type GroupContext = GroupRequest & DelegatedScopeContext
type TemplateContext = TemplateRequest & DelegatedScopeContext

const PLAN_KEYS = new Set(['intent', 'roleIds', 'userIds', 'admissionUserIds', 'witness'])
const WITNESS_KEYS = new Set(['userIds', 'admissionUserIds'])
const RAW_ROLE_SQL = `SELECT role_id
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role_id ASC`

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalidContext(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500,
    retryable: false,
    reason: 'delegated_scope_context',
    message: 'Authorization input plan is invalid',
  })
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && right.every((id, index) => left[index] === id)
}

function exactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every((key) => typeof key === 'string' && expected.has(key))
}

function literalBoolean(value: boolean): true | false {
  return value ? true : false
}

function snapshotIntent(intent: DelegatedScopeIncludeChildrenIntent): DelegatedScopeIncludeChildrenIntent {
  if (intent.kind === 'explicit') {
    return Object.freeze({ kind: 'explicit', value: literalBoolean(intent.value) })
  }
  if (intent.kind === 'omitted') return Object.freeze({ kind: 'omitted' })
  return invalidContext()
}

function snapshotScope(input: WriteDelegatedAdminScopeCommandInput): ScopeRequest {
  return Object.freeze({
    actorId: input.actorId,
    userId: input.userId,
    action: input.action,
    namespace: input.namespace,
    directoryDepartmentId: input.directoryDepartmentId,
    includeChildrenIntent: snapshotIntent(input.includeChildrenIntent),
  })
}

function snapshotGroup(input: WriteDelegatedAdminMemberGroupsCommandInput): GroupRequest {
  return Object.freeze({
    actorId: input.actorId,
    userId: input.userId,
    action: input.action,
    namespace: input.namespace,
    groupId: input.groupId,
  })
}

function snapshotTemplate(input: ApplyDelegatedScopeTemplateCommandInput): TemplateRequest {
  return Object.freeze({
    actorId: input.actorId,
    userId: input.userId,
    namespace: input.namespace,
    templateId: input.templateId,
    mode: input.mode,
  })
}

async function readRawRoleIds(
  runQuery: (sql: string, params?: unknown[]) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>,
  userId: string,
): Promise<readonly string[]> {
  const result = await runQuery(RAW_ROLE_SQL, [userId])
  return Object.freeze(result.rows.map((row) => row.role_id).filter((roleId): roleId is string => Boolean(roleId)))
}

function deriveNamespaces(roleIds: readonly string[]): readonly string[] {
  return Object.freeze(Array.from(new Set(
    roleIds
      .map((roleId) => deriveDelegatedAdminNamespace(roleId))
      .filter((namespace): namespace is string => Boolean(namespace)),
  )).sort(compareCodeUnits))
}

function canonicalParentRoleIds(rawRoleIds: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const accepted: string[] = []
  for (const roleId of rawRoleIds) {
    if (roleId.length === 0 || roleId.trim() !== roleId) continue
    if (deriveDelegatedAdminNamespace(roleId) === null) continue
    if (seen.has(roleId)) continue
    seen.add(roleId)
    accepted.push(roleId)
  }
  accepted.sort(compareCodeUnits)
  return Object.freeze([...accepted])
}

function ownedContext<T extends { actorId: string; userId: string }>(
  request: T,
  rawRoleIds: readonly string[],
): T & DelegatedScopeContext {
  const roleIds = canonicalParentRoleIds(rawRoleIds)
  const subjects = Object.freeze([...new Set([request.actorId, request.userId])].sort(compareCodeUnits))
  const plan = Object.freeze({
    intent: 'SET_DELEGATED_SCOPE' as const,
    roleIds,
    userIds: subjects,
    admissionUserIds: subjects,
    witness: Object.freeze({
      userIds: subjects,
      admissionUserIds: subjects,
    }),
  })
  return Object.freeze({
    ...request,
    rawRoleIds,
    roleIds,
    subjects,
    plan,
  })
}

function assertStructural(
  tx: AuthorizationInputTx,
  context: DelegatedScopeContext,
  nested: readonly object[] = [],
): void {
  assertAuthorizationInputTx(tx, { client: tx, userId: context.userId })
  const plan = context.plan
  if (
    tx.plan !== plan
    || tx.world !== 'shared'
    || plan.intent !== 'SET_DELEGATED_SCOPE'
    || !Object.isFrozen(context)
    || !Object.isFrozen(context.rawRoleIds)
    || !Object.isFrozen(context.roleIds)
    || !Object.isFrozen(context.subjects)
    || !Object.isFrozen(plan)
    || !Object.isFrozen(plan.roleIds)
    || !Object.isFrozen(plan.userIds)
    || !Object.isFrozen(plan.admissionUserIds)
    || plan.witness === undefined
    || !Object.isFrozen(plan.witness)
    || !Object.isFrozen(plan.witness.userIds)
    || !Object.isFrozen(plan.witness.admissionUserIds)
    || !exactKeys(plan, PLAN_KEYS)
    || !exactKeys(plan.witness, WITNESS_KEYS)
    || !sameIds(plan.roleIds, context.roleIds)
    || !sameIds(plan.userIds, context.subjects)
    || !sameIds(plan.admissionUserIds, context.subjects)
    || !sameIds(plan.witness.userIds, context.subjects)
    || !sameIds(plan.witness.admissionUserIds, context.subjects)
    || nested.some((value) => !Object.isFrozen(value))
  ) invalidContext()
}

function assertActual(tx: AuthorizationInputTx, context: DelegatedScopeContext): void {
  const parents = [...tx.roleRows.keys()].sort(compareCodeUnits)
  const witnessedUsers = [...tx.witnessed.userIds].sort(compareCodeUnits)
  const witnessedAdmissions = [...tx.witnessed.admissionUserIds].sort(compareCodeUnits)
  const lockedIds = [...tx.locked.keys()].sort(compareCodeUnits)
  const statesMatch = context.roleIds.every((roleId) => {
    const state = tx.roleRows.get(roleId)
    return state === 'held' || state === 'missing'
  })
  if (
    !statesMatch
    || !sameIds(parents, context.roleIds)
    || !sameIds(witnessedUsers, context.subjects)
    || !sameIds(witnessedAdmissions, context.subjects)
    || !sameIds(lockedIds, context.subjects)
  ) invalidContext()
}

function assertBeforeDml(
  tx: AuthorizationInputTx,
  context: DelegatedScopeContext,
  nested: readonly object[] = [],
): void {
  assertStructural(tx, context, nested)
  assertActual(tx, context)
}

function requireWritableTarget(tx: AuthorizationInputTx, targetId: string): void {
  const target = tx.locked.get(targetId)
  if (!target) throw new AccessGraphUserUnavailableError('NOT_FOUND')
  if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')
}

async function shareAdminChild(tx: AuthorizationInputTx, actorId: string): Promise<boolean> {
  const saved = await tx.query(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS),
    String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS),
  ])
  const membership = await tx.query(
    "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE",
    [actorId],
  )
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(saved.rows[0]?.lock_timeout ?? '0'),
    String(saved.rows[0]?.statement_timeout ?? '0'),
  ])
  return membership.rows.length > 0
}

async function assertActorS0(tx: AuthorizationInputTx, actorId: string): Promise<void> {
  const actor = tx.locked.get(actorId)
  if (!actor || actor.deletedAt || actor.purgedAt || actor.isActive !== true || actor.activationStatus !== 'activated') {
    throw new PlatformActorAuthorityLost()
  }
  if (actor.role === 'admin') return
  if (!await shareAdminChild(tx, actorId)) throw new PlatformActorAuthorityLost()
}

async function freshNamespaces(tx: AuthorizationInputTx, userId: string): Promise<readonly string[]> {
  return deriveNamespaces(await readRawRoleIds(tx.query, userId))
}

async function readStoredScopeIncludeChildren(
  tx: AuthorizationInputTx,
  userId: string,
  namespace: string,
  directoryDepartmentId: string,
): Promise<true | false | null> {
  const current = await tx.query(
    `SELECT include_children
     FROM delegated_role_admin_scopes
     WHERE admin_user_id = $1
       AND namespace = $2
       AND directory_department_id = $3`,
    [userId, namespace, directoryDepartmentId],
  )
  if (!current.rows.length) return null
  const value = current.rows[0]?.include_children
  if (value === true) return true
  if (value === false) return false
  return null
}

async function lockDelegatedScopeTemplate(tx: AuthorizationInputTx, templateId: string): Promise<boolean> {
  const locked = await tx.query(
    `SELECT id
     FROM delegated_role_scope_templates
     WHERE id = $1
     FOR UPDATE`,
    [templateId],
  )
  return locked.rows.length > 0
}

async function readTemplateDepartments(
  tx: AuthorizationInputTx,
  templateId: string,
): Promise<readonly DelegatedScopeTemplateDepartment[]> {
  const result = await tx.query(
    `SELECT
        td.template_id,
        d.id AS directory_department_id,
        td.include_children,
        d.integration_id,
        i.name AS integration_name,
        i.provider,
        i.corp_id,
        d.external_department_id,
        d.name AS department_name,
        d.full_path AS department_full_path,
        d.is_active AS department_is_active
     FROM delegated_role_scope_template_departments td
     JOIN directory_departments d ON d.id = td.directory_department_id
     JOIN directory_integrations i ON i.id = d.integration_id
     WHERE td.template_id = $1
     ORDER BY i.name ASC, COALESCE(d.full_path, d.name) ASC`,
    [templateId],
  )
  return Object.freeze(result.rows.map((row) => Object.freeze({
    directoryDepartmentId: String(row.directory_department_id),
    includeChildren: row.include_children === false ? false : true,
  })))
}

async function readTemplateMemberGroups(
  tx: AuthorizationInputTx,
  templateId: string,
): Promise<readonly DelegatedScopeTemplateMemberGroup[]> {
  const result = await tx.query(
    `SELECT
        tg.template_id,
        g.id AS group_id,
        g.name AS group_name,
        g.description AS group_description,
        COUNT(gm.user_id)::int AS member_count
     FROM delegated_role_scope_template_member_groups tg
     JOIN platform_member_groups g ON g.id = tg.group_id
     LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
     WHERE tg.template_id = $1
     GROUP BY tg.template_id, g.id, g.name, g.description
     ORDER BY g.name ASC`,
    [templateId],
  )
  return Object.freeze(result.rows.map((row) => Object.freeze({
    id: String(row.group_id),
  })))
}

async function writeDelegatedAdminScopeOnTx(
  tx: AuthorizationInputTx,
  context: ScopeContext,
): Promise<WriteDelegatedAdminScopeCommandResult> {
  const nested = [context.includeChildrenIntent]
  assertStructural(tx, context, nested)
  requireWritableTarget(tx, context.userId)
  await assertActorS0(tx, context.actorId)
  const adminNamespaces = await freshNamespaces(tx, context.userId)
  if (context.action === 'assign' && !adminNamespaces.includes(context.namespace)) {
    return { refused: 'namespace', adminNamespaces }
  }
  const stored = await readStoredScopeIncludeChildren(
    tx,
    context.userId,
    context.namespace,
    context.directoryDepartmentId,
  )
  if (context.action === 'assign') {
    const exactDepartmentEnabled = isDelegatedScopeExactDepartmentEnabled()
    const decision = resolveDelegatedIncludeChildrenWrite({
      intent: context.includeChildrenIntent,
      existingIncludeChildren: exactDepartmentEnabled ? null : stored,
      exactDepartmentEnabled,
    })
    if (decision.outcome === 'refuse') return { refused: 'exact', adminNamespaces }
    assertBeforeDml(tx, context, nested)
    await initializeDelegationActivation(tx.query, context.userId, context.namespace)
    const includeChildren = literalBoolean(decision.includeChildren)
    await tx.query(
      `INSERT INTO delegated_role_admin_scopes (
         admin_user_id, namespace, directory_department_id, include_children, created_by, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (admin_user_id, namespace, directory_department_id)
       DO UPDATE SET
         include_children = EXCLUDED.include_children,
         created_by = EXCLUDED.created_by,
         updated_at = NOW()`,
      [context.userId, context.namespace, context.directoryDepartmentId, includeChildren, context.actorId],
    )
    return { refused: false, adminNamespaces, persisted: includeChildren }
  }
  assertBeforeDml(tx, context, nested)
  const active = adminNamespaces.includes(context.namespace)
    && await initializeDelegationActivation(tx.query, context.userId, context.namespace)
  await tx.query(
    `DELETE FROM delegated_role_admin_scopes
     WHERE admin_user_id = $1
       AND namespace = $2
       AND directory_department_id = $3`,
    [context.userId, context.namespace, context.directoryDepartmentId],
  )
  await assertConfiguredActiveDelegation(tx.query, context.userId, context.namespace, active)
  return { refused: false, adminNamespaces, persisted: stored }
}

async function writeDelegatedAdminMemberGroupsOnTx(
  tx: AuthorizationInputTx,
  context: GroupContext,
): Promise<WriteDelegatedAdminMemberGroupsCommandResult> {
  assertStructural(tx, context)
  requireWritableTarget(tx, context.userId)
  await assertActorS0(tx, context.actorId)
  const adminNamespaces = await freshNamespaces(tx, context.userId)
  if (context.action === 'assign' && !adminNamespaces.includes(context.namespace)) {
    return { refused: true, adminNamespaces }
  }
  assertBeforeDml(tx, context)
  const active = adminNamespaces.includes(context.namespace)
    && await initializeDelegationActivation(tx.query, context.userId, context.namespace)
  if (context.action === 'assign') {
    await tx.query(
      `INSERT INTO delegated_role_admin_member_groups (
         admin_user_id, namespace, group_id, created_by, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (admin_user_id, namespace, group_id)
       DO UPDATE SET
         created_by = EXCLUDED.created_by,
         updated_at = NOW()`,
      [context.userId, context.namespace, context.groupId, context.actorId],
    )
  } else {
    await tx.query(
      `DELETE FROM delegated_role_admin_member_groups
       WHERE admin_user_id = $1
         AND namespace = $2
         AND group_id = $3`,
      [context.userId, context.namespace, context.groupId],
    )
    await assertConfiguredActiveDelegation(tx.query, context.userId, context.namespace, active)
  }
  return { refused: false, adminNamespaces }
}

async function applyDelegatedScopeTemplateOnTx(
  tx: AuthorizationInputTx,
  context: TemplateContext,
): Promise<ApplyDelegatedScopeTemplateCommandResult> {
  assertStructural(tx, context)
  requireWritableTarget(tx, context.userId)
  await assertActorS0(tx, context.actorId)
  const adminNamespaces = await freshNamespaces(tx, context.userId)
  if (!adminNamespaces.includes(context.namespace)) return { refused: 'namespace', adminNamespaces }
  const templateHeld = await lockDelegatedScopeTemplate(tx, context.templateId)
  if (!templateHeld) return { refused: 'missing-template', adminNamespaces }
  const departments = await readTemplateDepartments(tx, context.templateId)
  const memberGroups = await readTemplateMemberGroups(tx, context.templateId)
  if (departments.length === 0 && memberGroups.length === 0) return { refused: 'empty', adminNamespaces }
  if (
    !isDelegatedScopeExactDepartmentEnabled()
    && departments.some((department) => department.includeChildren === false)
  ) {
    return { refused: 'exact', adminNamespaces }
  }
  assertBeforeDml(tx, context)
  const active = await initializeDelegationActivation(tx.query, context.userId, context.namespace)
  if (context.mode === 'replace') {
    await tx.query(
      `DELETE FROM delegated_role_admin_scopes
       WHERE admin_user_id = $1
         AND namespace = $2`,
      [context.userId, context.namespace],
    )
    await tx.query(
      `DELETE FROM delegated_role_admin_member_groups
       WHERE admin_user_id = $1
         AND namespace = $2`,
      [context.userId, context.namespace],
    )
  }
  for (const department of departments) {
    await tx.query(
      `INSERT INTO delegated_role_admin_scopes (
         admin_user_id, namespace, directory_department_id, include_children, created_by, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (admin_user_id, namespace, directory_department_id)
       DO UPDATE SET
         include_children = EXCLUDED.include_children,
         created_by = EXCLUDED.created_by,
         updated_at = NOW()`,
      [context.userId, context.namespace, department.directoryDepartmentId, department.includeChildren, context.actorId],
    )
  }
  for (const group of memberGroups) {
    await tx.query(
      `INSERT INTO delegated_role_admin_member_groups (
         admin_user_id, namespace, group_id, created_by, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (admin_user_id, namespace, group_id)
       DO UPDATE SET
         created_by = EXCLUDED.created_by,
         updated_at = NOW()`,
      [context.userId, context.namespace, group.id, context.actorId],
    )
  }
  await assertConfiguredActiveDelegation(tx.query, context.userId, context.namespace, active)
  return { refused: false, adminNamespaces, departments, memberGroups }
}

export async function writeDelegatedAdminScopeCommand(
  input: WriteDelegatedAdminScopeCommandInput,
): Promise<WriteDelegatedAdminScopeCommandResult> {
  const request = snapshotScope(input)
  const rawRoleIds = await readRawRoleIds(query, request.userId)
  const context = ownedContext(request, rawRoleIds)
  return withAuthorizationInputTransaction(context.plan, async (tx) => writeDelegatedAdminScopeOnTx(tx, context))
}

export async function writeDelegatedAdminMemberGroupsCommand(
  input: WriteDelegatedAdminMemberGroupsCommandInput,
): Promise<WriteDelegatedAdminMemberGroupsCommandResult> {
  const request = snapshotGroup(input)
  const rawRoleIds = await readRawRoleIds(query, request.userId)
  const context = ownedContext(request, rawRoleIds)
  return withAuthorizationInputTransaction(context.plan, async (tx) => writeDelegatedAdminMemberGroupsOnTx(tx, context))
}

export async function applyDelegatedScopeTemplateCommand(
  input: ApplyDelegatedScopeTemplateCommandInput,
): Promise<ApplyDelegatedScopeTemplateCommandResult> {
  const request = snapshotTemplate(input)
  const rawRoleIds = await readRawRoleIds(query, request.userId)
  const context = ownedContext(request, rawRoleIds)
  return withAuthorizationInputTransaction(context.plan, async (tx) => applyDelegatedScopeTemplateOnTx(tx, context))
}
