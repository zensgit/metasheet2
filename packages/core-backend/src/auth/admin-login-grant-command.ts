import { assertPlatformActorAuthority } from '../admin/platform-actor-authority'
import { query } from '../db/pg'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import type { AuthorizationInputQueryable } from '../rbac/authorization-input-brand'
import { withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'
import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { discoverPrivilegeRolePlan, revalidatePrivilegeRolePlan } from '../rbac/authorization-privilege-witness-plan'
import type { PrivilegeRolePlan } from '../rbac/authorization-privilege-witness-plan'
import {
  adminGrantBrowserStatements,
  assertAdminGrantBrowserContext,
  createAdminGrantBrowserContext,
} from './admin-grant-browser-context'
import type { AdminGrantBrowserContext, AdminGrantBrowserService } from './admin-grant-browser-context'
import { encodeAdminGrantIntent, hashAdminGrantIntent, normalizeAdminGrantIntent } from './admin-login-grant-intent'
import type { AdminGrantIntent } from './admin-login-grant-intent'
import {
  AdminGrantProofError,
  createAdminGrantProofService,
  retainAdminGrantBrowserContext,
} from './admin-grant-proof'
import type { AdminGrantProofService } from './admin-grant-proof'
import { resolveAdminGrantInstallSchema } from './admin-grant-local-credential'
import { assertAuthenticatedSessionContext } from './security-action-proof'
import type { AuthenticatedSessionContext } from './security-action-proof'
import { STRICT_LOGIN_GRANT_RECEIPT_TABLE } from '../db/migrations/zzzz20261118120000_strict_login_grant_scope'
import {
  commandKeyFor,
  grantIdsFor,
  readStrictLoginInstallation,
  STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS,
  StrictLoginGrantError,
} from './strict-login-grant-store'
import type { StrictLoginGrantBundle } from './strict-login-grant-store'
import { insertConsumedGrantBundle } from './strict-login-grant-bundle'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const COMMAND_CODES = [
  'ADMIN_LOGIN_GRANT_COMMAND_REFUSED',
  'ADMIN_LOGIN_GRANT_COMMAND_CONFLICT',
] as const

export type AdminLoginGrantCommandCode = (typeof COMMAND_CODES)[number]

const COMMAND_MESSAGES: Readonly<Record<AdminLoginGrantCommandCode, string>> = {
  ADMIN_LOGIN_GRANT_COMMAND_REFUSED: 'Admin login grant command refused',
  ADMIN_LOGIN_GRANT_COMMAND_CONFLICT: 'Admin login grant command conflict',
}

export class AdminLoginGrantCommandError extends Error {
  readonly code: AdminLoginGrantCommandCode

  constructor(code: AdminLoginGrantCommandCode) {
    super(COMMAND_MESSAGES[code])
    this.name = 'AdminLoginGrantCommandError'
    this.code = code
  }
}

export type AdminLoginGrantCommandGrant = {
  readonly grantId: string
  readonly ordinal: number
  readonly userId: string
}

export type AdminLoginGrantCommandReceipt = {
  readonly commandKey: string
  readonly proofId: string
  readonly commandId: string
  readonly actorId: string
  readonly orgId: string
  readonly targetCount: number
  readonly canonicalIntent: string
  readonly intentDigest: string
  readonly grants: readonly AdminLoginGrantCommandGrant[]
}

export type AdminLoginGrantCommandRead =
  | { readonly status: 'committed'; readonly receipt: AdminLoginGrantCommandReceipt }
  | { readonly status: 'absent' }
  | { readonly status: 'uncertain'; readonly commandKey: string }

export type AdminLoginGrantCommandExecution =
  | { readonly status: 'committed'; readonly receipt: AdminLoginGrantCommandReceipt }
  | { readonly status: 'uncertain'; readonly commandKey: string }

export type AdminLoginGrantCommandReadInput = {
  readonly publicOrigin: string
  readonly context: AuthenticatedSessionContext
  readonly browser: AdminGrantBrowserContext
  readonly intent: AdminGrantIntent
}

export type AdminLoginGrantCommandEnableInput = AdminLoginGrantCommandReadInput & {
  readonly proof: string
}

type BoundServices = {
  readonly origin: string
  readonly proof: AdminGrantProofService
  readonly browser: AdminGrantBrowserService
}

let boundServices: BoundServices | null = null

function refuse(code: AdminLoginGrantCommandCode): never {
  throw new AdminLoginGrantCommandError(code)
}

function bindServices(publicOrigin: string): BoundServices {
  if (boundServices) {
    if (boundServices.origin !== publicOrigin) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
    return boundServices
  }
  const proof = createAdminGrantProofService({ publicOrigin })
  const browser = createAdminGrantBrowserContext({ publicOrigin })
  if (browser.publicOrigin !== publicOrigin) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  boundServices = { origin: publicOrigin, proof, browser }
  return boundServices
}

function asQueryable(tx: AuthorizationInputTx): Queryable {
  return {
    query: async (sql, params) => {
      const result = await tx.query(sql, params)
      return { rows: result.rows, rowCount: result.rowCount ?? null }
    },
  }
}

function signalsUnknownCommit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { rollbackAcked?: unknown; outcomeUnknown?: unknown }
  return record.rollbackAcked === false || record.outcomeUnknown === true
}

function replayConstraint(error: unknown): boolean {
  return error instanceof StrictLoginGrantError
    && error.code === 'STRICT_LOGIN_GRANT_UNIQUE_CONFLICT'
    && typeof error.constraint === 'string'
    && STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS.some((name) => name === error.constraint)
}

function consumeStale(error: unknown): boolean {
  return error instanceof AdminGrantProofError && error.code === 'ADMIN_GRANT_PROOF_INVALID'
}

function quoteIdent(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  return `"${identifier}"`
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  return value
}

function storedGrants(value: unknown): readonly AdminLoginGrantCommandGrant[] {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 1 || keys[0] !== 'grants' || !Array.isArray(record.grants)) {
    refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
  }
  const grants: AdminLoginGrantCommandGrant[] = []
  for (const element of record.grants) {
    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
    }
    const item = element as Record<string, unknown>
    const itemKeys = Object.keys(item).sort()
    if (itemKeys.join(',') !== 'grantId,ordinal,userId') refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
    if (typeof item.grantId !== 'string' || typeof item.userId !== 'string' || typeof item.ordinal !== 'number') {
      refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
    }
    if (!Number.isInteger(item.ordinal)) refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
    grants.push({ grantId: item.grantId, ordinal: item.ordinal, userId: item.userId })
  }
  return grants
}

function sameGrants(left: readonly AdminLoginGrantCommandGrant[], right: readonly AdminLoginGrantCommandGrant[]): boolean {
  return left.length === right.length && left.every((grant, index) => {
    const other = right[index]
    return other !== undefined
      && grant.grantId === other.grantId
      && grant.ordinal === other.ordinal
      && grant.userId === other.userId
  })
}

async function authorizeActor(
  tx: AuthorizationInputTx,
  browserService: AdminGrantBrowserService,
  context: AuthenticatedSessionContext,
  browser: AdminGrantBrowserContext,
  intent: AdminGrantIntent,
  plan: PrivilegeRolePlan,
): Promise<void> {
  await revalidatePrivilegeRolePlan(tx, plan)
  await assertPlatformActorAuthority(tx, tx.locked.get(context.userId))
  const membership = await tx.query(
    `SELECT user_id FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active IS TRUE FOR SHARE`,
    [context.userId, intent.orgId],
  )
  if (membership.rows.length !== 1 || membership.rows[0]?.user_id !== context.userId) {
    refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  }
  const schemaName = await resolveAdminGrantInstallSchema(asQueryable(tx), 'ADMIN_GRANT_BROWSER_UNAVAILABLE')
  const statements = adminGrantBrowserStatements(schemaName)
  const watermark = await tx.query(statements.lockWatermark, [context.userId])
  if (watermark.rows.length !== 1) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  const session = await tx.query(statements.lockSession, [context.sessionId])
  if (session.rows.length !== 1) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  const binding = await tx.query(statements.lockBinding, [context.sessionId])
  if (binding.rows.length !== 1) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  await browserService.assertCurrent(asQueryable(tx), browser)
  if (context.userId !== intent.actorId) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  if (context.orgId !== null && context.orgId !== intent.orgId) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
}

async function selectReceipt(
  tx: AuthorizationInputTx,
  intent: AdminGrantIntent,
): Promise<AdminLoginGrantCommandRead> {
  const installation = await readStrictLoginInstallation(tx)
  if (installation.installation !== 'installed') {
    throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  }
  const schemaName = await resolveAdminGrantInstallSchema(asQueryable(tx), 'ADMIN_GRANT_BROWSER_UNAVAILABLE')
  const commandKey = commandKeyFor(intent.actorId, intent.orgId, intent.commandId)
  const receipts = `${quoteIdent(schemaName)}.${quoteIdent(STRICT_LOGIN_GRANT_RECEIPT_TABLE)}`
  const rows = await tx.query(
    `SELECT command_key, purpose, actor_id, org_id, command_id, intent_digest, canonical_intent,
            result, proof_id::text AS proof_id, target_count, outcome
       FROM ${receipts}
      WHERE command_key = $1`,
    [commandKey],
  )
  if (rows.rows.length === 0) return { status: 'absent' }
  if (rows.rows.length !== 1) throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  const row = rows.rows[0] ?? {}
  const canonicalIntent = encodeAdminGrantIntent(intent)
  const intentDigest = hashAdminGrantIntent(intent)
  const expected = grantIdsFor(commandKey, intent.targets.map((target) => target.userId))
  const grants = storedGrants(row.result)
  const targetCount = row.target_count
  const proofId = requiredText(row, 'proof_id')
  if (
    requiredText(row, 'command_key') !== commandKey
    || requiredText(row, 'purpose') !== 'admin_login_grant_enable'
    || requiredText(row, 'outcome') !== 'enabled'
    || requiredText(row, 'actor_id') !== intent.actorId
    || requiredText(row, 'org_id') !== intent.orgId
    || requiredText(row, 'command_id') !== intent.commandId
    || requiredText(row, 'intent_digest') !== intentDigest
    || requiredText(row, 'canonical_intent') !== canonicalIntent
    || !UUID_TEXT.test(proofId)
    || typeof targetCount !== 'number'
    || !Number.isInteger(targetCount)
    || targetCount !== intent.targets.length
    || !sameGrants(grants, expected)
  ) {
    refuse('ADMIN_LOGIN_GRANT_COMMAND_CONFLICT')
  }
  return {
    status: 'committed',
    receipt: {
      commandKey,
      proofId,
      commandId: intent.commandId,
      actorId: intent.actorId,
      orgId: intent.orgId,
      targetCount,
      canonicalIntent,
      intentDigest,
      grants,
    },
  }
}

function actorPlanReader(): AuthorizationInputQueryable {
  return {
    query: async (sql, params) => {
      const result = await query(sql, params)
      const rows: Array<Record<string, unknown>> = []
      for (const row of result.rows) {
        const copy: Record<string, unknown> = {}
        for (const key of Object.keys(row)) copy[key] = row[key]
        rows.push(copy)
      }
      return { rows, rowCount: result.rowCount }
    },
  }
}

const COMMAND_INPUT_FIELDS = ['publicOrigin', 'context', 'browser', 'intent'] as const

type CapturedCommand = {
  readonly bound: BoundServices
  readonly context: AuthenticatedSessionContext
  readonly browser: AdminGrantBrowserContext
  readonly intent: AdminGrantIntent
  readonly proof: string | undefined
}

function captureCommandInput(input: AdminLoginGrantCommandReadInput): {
  publicOrigin: unknown
  context: unknown
  browser: unknown
  intent: unknown
  proof: unknown
} {
  if (typeof input !== 'object' || input === null) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(input)
  } catch {
    refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  }
  if (prototype !== Object.prototype && prototype !== null) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  let descriptors: PropertyDescriptorMap
  try {
    descriptors = Object.getOwnPropertyDescriptors(input)
  } catch {
    refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  }
  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(descriptors)
  } catch {
    refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  }
  const allowsProof = keys.length === COMMAND_INPUT_FIELDS.length + 1
  if (keys.length !== COMMAND_INPUT_FIELDS.length && !allowsProof) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  const expected: readonly string[] = allowsProof ? [...COMMAND_INPUT_FIELDS, 'proof'] : COMMAND_INPUT_FIELDS
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  }
  const captured: Record<string, unknown> = {}
  for (const field of expected) {
    const descriptor = descriptors[field]
    if (descriptor === undefined || !('value' in descriptor)) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
    captured[field] = descriptor.value
  }
  return {
    publicOrigin: captured.publicOrigin,
    context: captured.context,
    browser: captured.browser,
    intent: captured.intent,
    proof: allowsProof ? captured.proof : undefined,
  }
}

function captureCommand(input: AdminLoginGrantCommandReadInput): CapturedCommand {
  const captured = captureCommandInput(input)
  if (typeof captured.publicOrigin !== 'string') refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  const bound = bindServices(captured.publicOrigin)
  const context = captured.context
  const browser = captured.browser
  assertAuthenticatedSessionContext(context)
  assertAdminGrantBrowserContext(browser, bound.origin)
  if (browser.session !== context) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
  let proof: string | undefined
  if (captured.proof !== undefined) {
    if (typeof captured.proof !== 'string') refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
    proof = captured.proof
  }
  return {
    bound,
    context,
    browser,
    intent: normalizeAdminGrantIntent(captured.intent),
    proof,
  }
}

async function openActorRoot<T>(
  captured: CapturedCommand,
  work: (tx: AuthorizationInputTx, plan: PrivilegeRolePlan) => Promise<T>,
): Promise<T> {
  const plan = await discoverPrivilegeRolePlan(actorPlanReader(), [captured.context.userId])
  return withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
    await authorizeActor(tx, captured.bound.browser, captured.context, captured.browser, captured.intent, plan)
    return work(tx, plan)
  })
}

async function readCaptured(captured: CapturedCommand): Promise<AdminLoginGrantCommandRead> {
  const commandKey = commandKeyFor(captured.intent.actorId, captured.intent.orgId, captured.intent.commandId)
  let finished = false
  try {
    const read = await openActorRoot(captured, async (tx) => {
      const selected = await selectReceipt(tx, captured.intent)
      finished = true
      return selected
    })
    return read
  } catch (error) {
    if (finished || signalsUnknownCommit(error)) return { status: 'uncertain', commandKey }
    throw error
  }
}

export async function readAdminLoginGrantCommandReceipt(
  input: AdminLoginGrantCommandReadInput,
): Promise<AdminLoginGrantCommandRead> {
  return readCaptured(captureCommand(input))
}

async function insertCommandAudit(tx: AuthorizationInputTx, bundle: StrictLoginGrantBundle): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO audit_logs (
       event_type, event_category, event_severity,
       resource_type, resource_id, action, action_details
     ) VALUES (
       'UPDATE', 'USER', 'INFO',
       'admin_login_grant_command', NULL, 'admin_login_grant_enable',
       jsonb_build_object(
         'outcome', 'enabled'::text,
         'targetCount', $1::int,
         'commandKey', $2::text
       )
     )
     RETURNING id`,
    [bundle.targetCount, bundle.commandKey],
  )
  if (inserted.rows.length !== 1) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
}

function receiptFromBundle(bundle: StrictLoginGrantBundle, intent: AdminGrantIntent): AdminLoginGrantCommandReceipt {
  return {
    commandKey: bundle.commandKey,
    proofId: bundle.proofId,
    commandId: bundle.commandId,
    actorId: intent.actorId,
    orgId: intent.orgId,
    targetCount: bundle.targetCount,
    canonicalIntent: encodeAdminGrantIntent(intent),
    intentDigest: hashAdminGrantIntent(intent),
    grants: bundle.grants.map((grant) => ({
      grantId: grant.grantId,
      ordinal: grant.ordinal,
      userId: grant.userId,
    })),
  }
}

export async function executeAdminLoginGrantEnable(
  input: AdminLoginGrantCommandEnableInput,
): Promise<AdminLoginGrantCommandExecution> {
  const captured = captureCommand(input)
  const existing = await readCaptured(captured)
  if (existing.status !== 'absent') return existing
  const intent = captured.intent
  const commandKey = commandKeyFor(intent.actorId, intent.orgId, intent.commandId)
  retainAdminGrantBrowserContext(captured.bound.origin, captured.context, captured.browser)
  let committedWork = false
  try {
    if (captured.proof === undefined) refuse('ADMIN_LOGIN_GRANT_COMMAND_REFUSED')
    const prepared = await captured.bound.proof.prepareConsume(captured.context, { intent, proof: captured.proof })
    const bundle = await withAuthorizationInputTransaction(prepared.privilegePlan.lockPlan, async (tx) => {
      await revalidatePrivilegeRolePlan(tx, prepared.privilegePlan)
      const consumed = await captured.bound.proof.consumeOnTx(tx, captured.context, prepared)
      const inserted = await insertConsumedGrantBundle(tx, {
        publicOrigin: captured.bound.origin,
        context: captured.context,
        consumed,
        intent,
        grantedBy: captured.context.userId,
      })
      await insertCommandAudit(tx, inserted)
      committedWork = true
      return inserted
    })
    return { status: 'committed', receipt: receiptFromBundle(bundle, intent) }
  } catch (error) {
    if (error instanceof StrictLoginGrantError && error.code === 'STRICT_LOGIN_GRANT_GRANT_OCCUPIED') throw error
    const unknown = committedWork || signalsUnknownCommit(error)
    if (!unknown && !replayConstraint(error) && !consumeStale(error)) throw error
    try {
      const again = await readCaptured(captured)
      if (again.status === 'committed') return again
      if (unknown || again.status === 'uncertain') return { status: 'uncertain', commandKey }
      throw error
    } catch (reconcileError) {
      if (
        reconcileError instanceof AdminLoginGrantCommandError
        && reconcileError.code === 'ADMIN_LOGIN_GRANT_COMMAND_CONFLICT'
      ) {
        throw reconcileError
      }
      if (unknown || signalsUnknownCommit(reconcileError)) return { status: 'uncertain', commandKey }
      throw error
    }
  }
}
