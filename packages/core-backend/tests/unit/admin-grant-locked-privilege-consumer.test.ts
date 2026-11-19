/**
 * Actor-witness boundary for the existing receiving reader.
 * Malformed expectations do no query. The source gate reads the real owner body.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  AdminGrantReceivingRefusal,
  assertPreparedAdminGrantConsume,
  resolveAdminGrantTargetSet,
} from '../../src/auth/admin-grant-receiving-reader'
import type { AdminGrantReceivingPhase } from '../../src/auth/admin-grant-receiving-reader'
import {
  AUTHORIZATION_INPUT_CONSUMERS,
  hasPendingConsumers,
} from '../../src/rbac/authorization-input-consumers'
import type { AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import type { PrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'
import { enclosingFunctionAt } from '../helpers/authorization-input-scan'

const READER = 'packages/core-backend/src/auth/admin-grant-receiving-reader.ts'
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DUMMY_WITNESS = 'ab'.repeat(32)
const SECRET = 'SECRET_DRIVER_VALUE'

const baseIntent = {
  purpose: 'admin_login_grant_enable',
  commandId: 'cmd-boundary',
  actorId: 'actor-boundary',
  orgId: 'org-boundary',
  provider: 'dingtalk',
  connectionId: 'abcdefab-2345-6789-abcd-abcdef012345',
  applicationRevision: '4',
  targets: [{
    userId: 'target-boundary',
    identityId: 'abcdefab-0123-4567-89ab-abcdef012345',
    bindingRevision: '7',
    evidenceId: 'ev-boundary',
    evidenceWitness: 'wit-boundary',
    accessGeneration: '3',
    privilegeWitness: DUMMY_WITNESS,
  }],
}

type ActorFields = { userId: string; orgId: string; privilegeWitness: string }

const validActor = (): ActorFields => ({
  userId: 'actor-boundary',
  orgId: 'org-boundary',
  privilegeWitness: DUMMY_WITNESS,
})

function readerSource(): string {
  return fs.readFileSync(path.join(REPO_ROOT, READER), 'utf8')
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(READER, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function functionByName(file: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return file.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined
  ))
}

function isOptional(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionLike(current)) return false
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)) return true
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken) return true
    }
    current = current.parent
  }
  return false
}

function walkDirect(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    visit(node)
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(root, walk)
}

function walkAll(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(root, walk)
}

function calleeText(node: ts.CallExpression, file: ts.SourceFile): string {
  return node.expression.getText(file)
}

function awaited(node: ts.CallExpression): boolean {
  return node.parent !== undefined && ts.isAwaitExpression(node.parent)
}

function enclosingTry(node: ts.Node): ts.TryStatement | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isTryStatement(current)) return current
    if (ts.isFunctionLike(current)) return undefined
    current = current.parent
  }
  return undefined
}

function callsNamed(root: ts.Node, file: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walkAll(root, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name) found.push(node)
  })
  return found
}

function hasStrictInequality(node: ts.Node): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      found = true
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function directRefuse(statement: ts.Statement, file: ts.SourceFile, expectedArgument: string): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isIfStatement(node)
      || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)) return
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken) return
    }
    if (ts.isCallExpression(node) && calleeText(node, file) === 'refuse'
      && node.arguments.some((argument) => argument.getText(file) === expectedArgument)) {
      found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(statement)
  return found
}

function reflectionCatchProblems(source: string): string[] {
  const file = parse(source)
  const problems: string[] = []
  const expectedCatches: Record<string, number> = {
    copyActorExpectation: 3,
    readActorExpectation: 1,
  }
  for (const name of Object.keys(expectedCatches)) {
    const owner = functionByName(file, name)
    if (!owner?.body) {
      problems.push(`${name}_missing`)
      continue
    }
    const body = owner.body.getText(file)
    if (body.includes('instanceof')) problems.push(`${name}_instanceof`)
    const catches: ts.CatchClause[] = []
    walkAll(owner.body, (node) => {
      if (ts.isCatchClause(node)) catches.push(node)
    })
    if (catches.length !== expectedCatches[name]) problems.push(`${name}_catch_count`)
    if (catches.some((clause) => clause.variableDeclaration !== undefined)) problems.push(`${name}_binding`)
    if (name === 'copyActorExpectation') {
      const representable = body.lastIndexOf('refuseUnrepresentableString')
      const lastCatch = body.lastIndexOf('catch')
      if (representable < 0 || representable < lastCatch) problems.push('representable_inside_catch')
      let firstTry: ts.TryStatement | undefined
      walkAll(owner.body, (node) => {
        if (!firstTry && ts.isTryStatement(node)) firstTry = node
      })
      const arrayCalls = callsNamed(owner.body, file, 'Array.isArray')
      const prototypeCalls = callsNamed(owner.body, file, 'Object.getPrototypeOf')
      if (!firstTry || arrayCalls.length !== 1 || prototypeCalls.length !== 1
        || enclosingTry(arrayCalls[0]) !== firstTry
        || enclosingTry(prototypeCalls[0]) !== firstTry) {
        problems.push('array_probe_outside')
      } else {
        const reflectionTry = firstTry
        let validated = false
        walkAll(owner.body, (node) => {
          if (!ts.isIfStatement(node) || node.getStart(file) <= reflectionTry.getEnd()) return
          const condition = node.expression.getText(file)
          if (condition.includes('array') && condition.includes('prototype')
            && directRefuse(node.thenStatement, file, "'actor_privilege_expectation_invalid'")) {
            validated = true
          }
        })
        if (!validated) problems.push('array_validation_inside_catch')
      }
    }
    if (name === 'readActorExpectation') {
      const copyAt = body.indexOf('copyActorExpectation(')
      const catchAt = body.indexOf('catch')
      if (copyAt < 0 || catchAt < 0 || copyAt < catchAt) problems.push('copy_inside_catch')
    }
  }
  return problems
}

function ownerProblems(source: string): string[] {
  const file = parse(source)
  const problems: string[] = []
  const resolve = functionByName(file, 'resolveAdminGrantTargetSet')
  const target = functionByName(file, 'readPreparedTarget')
  const consume = functionByName(file, 'assertPreparedAdminGrantConsume')
  if (!resolve?.body || !target?.body || !consume?.body) {
    problems.push('owner_missing')
    return problems
  }
  const identity: number[] = []
  const revalidate: number[] = []
  const subject: number[] = []
  const assess: number[] = []
  const witness: number[] = []
  const integration: number[] = []
  const brand: number[] = []
  let firstAwait = Number.POSITIVE_INFINITY
  walkDirect(resolve.body, (node) => {
    if (ts.isAwaitExpression(node)) firstAwait = Math.min(firstAwait, node.getStart(file))
    if (ts.isIfStatement(node) && !isOptional(node)
      && node.expression.getText(file).includes('privilegePlan.subjectIds')
      && node.expression.getText(file).includes('expectedSubjects')
      && hasStrictInequality(node.expression)
      && directRefuse(node.thenStatement, file, "'subject_set_mismatch'")) {
      subject.push(node.getStart(file))
    }
    if (!ts.isCallExpression(node) || isOptional(node)) return
    const name = calleeText(node, file)
    if (name === 'tx.requireIdentityRead' && node.arguments[0]?.getText(file) === '[normalized.connectionId]') {
      identity.push(node.getStart(file))
    }
    if (name === 'revalidatePrivilegeRolePlan' && awaited(node)
      && node.arguments.map((argument) => argument.getText(file)).join(',') === 'tx,privilegePlan') {
      revalidate.push(node.getStart(file))
    }
    if (name === 'assessSecurityActionPrivilege' && awaited(node)
      && node.arguments[1]?.getText(file) === 'normalized.actorId'
      && (node.arguments[0]?.getText(file).includes('tx.query') ?? false)) {
      assess.push(node.getStart(file))
    }
    if (name === 'oneRow' && node.arguments[1]?.getText(file) === 'INTEGRATION_LOCK') integration.push(node.getStart(file))
    if (name === 'preparedBrands.set') {
      const text = node.getText(file)
      if (text.includes('privilegePlan') && text.includes('actorPrivilege')) brand.push(node.getStart(file))
    }
  })
  walkDirect(resolve.body, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return
    const left = node.left.getText(file)
    const right = node.right.getText(file)
    if (left !== 'actorAssessment.witness' || right !== 'actorPrivilege.privilegeWitness') return
    const owner = node.parent
    if (!owner || !ts.isIfStatement(owner) || owner.expression !== node || isOptional(owner)) return
    if (!directRefuse(owner.thenStatement, file, "'actor_privilege_witness_mismatch'")) return
    witness.push(node.getStart(file))
  })
  if (identity.length !== 1) problems.push('identity_read')
  if (revalidate.length !== 1) problems.push('revalidate_await')
  if (subject.length !== 1) problems.push('subject_set')
  if (assess.length !== 1) problems.push('actor_assess')
  if (witness.length !== 1) problems.push('witness_compare')
  if (integration.length !== 1) problems.push('before_r6')
  if (brand.length !== 1) problems.push('brand')
  if (problems.length === 0) {
    const order = [identity[0], revalidate[0], subject[0], assess[0], witness[0], integration[0], brand[0]]
    if (order.some((position, index) => index > 0 && position <= order[index - 1])) problems.push('order')
  }
  walkAll(resolve.body, (node) => {
    if (ts.isIdentifier(node) && node.text === 'context' && node.getStart(file) > firstAwait) problems.push('context_reread')
  })
  const assessOwners: string[] = []
  walkAll(file, (node) => {
    if (!ts.isCallExpression(node) || calleeText(node, file) !== 'assessSecurityActionPrivilege') return
    assessOwners.push(enclosingFunctionAt(READER, source, node.getStart(file))?.name ?? '<missing>')
  })
  if (assessOwners.join('|') !== 'readPreparedTarget|resolveAdminGrantTargetSet') problems.push('assess_owners')
  let targetAssess = 0
  walkDirect(target.body, (node) => {
    if (!ts.isCallExpression(node) || isOptional(node) || !awaited(node)) return
    if (calleeText(node, file) === 'assessSecurityActionPrivilege'
      && node.arguments[1]?.getText(file) === 'target.userId'
      && (node.arguments[0]?.getText(file).includes('tx.query') ?? false)) targetAssess += 1
  })
  if (targetAssess !== 1) problems.push('target_assess')
  const consumeText = consume.body.getText(file)
  let consumeAwait = false
  let consumeQuery = false
  walkAll(consume.body, (node) => {
    if (ts.isAwaitExpression(node)) consumeAwait = true
    if (ts.isCallExpression(node)) {
      const name = calleeText(node, file)
      if (name === 'assessSecurityActionPrivilege' || name === 'tx.query' || name.endsWith('.query')) consumeQuery = true
    }
  })
  if (consumeAwait || consumeQuery) problems.push('consume_sync')
  const actorCopy = consumeText.indexOf('readActorExpectation(context)')
  const token = consumeText.indexOf('assertOpenToken(tx, client)')
  const intentMismatch = consumeText.indexOf("'intent_mismatch'")
  const planIdentity = consumeText.indexOf('privilegePlan !== brand.privilegePlan')
  const lockDeref = consumeText.indexOf('brand.privilegePlan.lockPlan')
  const actorMismatch = consumeText.indexOf("'actor_expectation_mismatch'")
  if (actorCopy < 0 || token < actorCopy || intentMismatch < token || planIdentity < intentMismatch
    || lockDeref < planIdentity || actorMismatch < lockDeref
    || consumeText.includes('actor_privilege_subject_mismatch')) {
    problems.push('consume_order')
  }
  return problems
}

function harness(): { tx: AuthorizationInputTx; plan: PrivilegeRolePlan; events: string[] } {
  const events: string[] = []
  const tx = {
    query: async () => {
      events.push('query')
      throw new Error('query was called')
    },
    requireIdentityRead: () => {
      events.push('identity')
    },
    plan: { marker: 'plan' },
  } as unknown as AuthorizationInputTx
  const plan = { subjectIds: [], lockPlan: { marker: 'plan' } } as unknown as PrivilegeRolePlan
  return { tx, plan, events }
}

async function refusal(promise: Promise<unknown>): Promise<AdminGrantReceivingRefusal> {
  try {
    await promise
    throw new Error('expected the operation to be rejected')
  } catch (error) {
    expect(error).toBeInstanceOf(AdminGrantReceivingRefusal)
    const refusalError = error as AdminGrantReceivingRefusal
    expect(refusalError.message).toBe('Admin grant receiving refused')
    expect(refusalError.message.includes(SECRET)).toBe(false)
    expect(refusalError.reason.includes(SECRET)).toBe(false)
    expect(refusalError.cause).toBeUndefined()
    expect(Object.hasOwn(refusalError, 'cause')).toBe(false)
    return refusalError
  }
}

describe('admin grant locked privilege consumer', () => {
  it('keeps K-02 pending and the prepared snapshot non-authorizing', () => {
    const source = readerSource()
    expect(hasPendingConsumers()).toBe(true)
    expect(AUTHORIZATION_INPUT_CONSUMERS.find((entry) => entry.id === 'K-02')).toEqual({
      id: 'K-02',
      file: 'packages/core-backend/src/auth/security-action-proof.ts',
      symbol: 'consume',
      call: 'assessSecurityActionPrivilege',
      count: 1,
      mode: 'PENDING_LOCKED',
      slice: 'AIS-3b',
    })
    expect(source.includes('productionAvailable: true')).toBe(false)
    expect(source.includes('productionAvailable: false as const')).toBe(true)
    expect(source.includes('authorizes: false as const')).toBe(true)
  })

  it('pins the real owner body and rejects comments, nesting, optional calls, and late context reads', () => {
    const source = readerSource()
    expect(ownerProblems(source)).toEqual([])
    const faults = [
      source.replace(
        'tx.requireIdentityRead([normalized.connectionId])',
        '/* tx.requireIdentityRead([normalized.connectionId]) */ undefined',
      ),
      source.replace(
        'tx.requireIdentityRead([normalized.connectionId])',
        '(() => { tx.requireIdentityRead([normalized.connectionId]) })()',
      ),
      source.replace('tx.requireIdentityRead([normalized.connectionId])', 'other.requireIdentityRead([normalized.connectionId])'),
      source.replace(
        'await revalidatePrivilegeRolePlan(tx, privilegePlan)',
        'void revalidatePrivilegeRolePlan(tx, privilegePlan)',
      ),
      source.replace(
        'actorAssessment.witness !== actorPrivilege.privilegeWitness',
        'actorAssessment.witness === actorPrivilege.privilegeWitness',
      ),
      source.replace(
        'actorAssessment = await assessSecurityActionPrivilege(',
        'actorAssessment = false && await assessSecurityActionPrivilege(',
      ),
      source.replace(
        'const integration = await oneRow(tx, INTEGRATION_LOCK, [normalized.connectionId], \'integration_missing\')',
        'const integration = await oneRow(tx, INTEGRATION_LOCK, [normalized.connectionId], \'integration_missing\')\n  void context.privilegePlan',
      ),
      source.replace('privilegePlan,\n    actorPrivilege,', 'actorPrivilege,'),
      source.replace('brand.privilegePlan.lockPlan', 'privilegePlan.lockPlan'),
      `${source}\nasync function unusedHelper(tx: AuthorizationInputTx) {\n  await assessSecurityActionPrivilege(tx, 'u1')\n}\n`,
      source.replace(
        'if (actorAssessment.witness !== actorPrivilege.privilegeWitness) refuse(\'actor_privilege_witness_mismatch\')',
        'void (actorAssessment.witness !== actorPrivilege.privilegeWitness)',
      ),
      source.replace(
        'refuse(\'role_plan_invalid\', \'subject_set_mismatch\')',
        'void privilegePlan.subjectIds',
      ),
    ]
    for (const fault of faults) expect(ownerProblems(fault).length).toBeGreaterThan(0)
    const duplicated = source.replace(
      '}, normalized.actorId)',
      '}, normalized.actorId)\n    await assessSecurityActionPrivilege({ query: async (statement: string, params?: unknown[]) => { const result = await tx.query(statement, params); return { rows: result.rows, rowCount: result.rowCount ?? null } } }, normalized.actorId)',
    )
    expect(ownerProblems(duplicated)).toContain('actor_assess')
  })

  it('refuses a closed actor record before any query and keeps the caller container unfrozen', async () => {
    const { tx, plan, events } = harness()
    const phase = 'consume' satisfies AdminGrantReceivingPhase
    const contextFor = <T>(actorPrivilege: T) => ({ client: tx, privilegePlan: plan, actorPrivilege })
    const invalid: unknown[] = [
      undefined,
      null,
      'actor',
      1,
      [],
      new Date(),
      { userId: 'actor-boundary', orgId: 'org-boundary' },
      { ...validActor(), extra: 'no' },
      Object.create({ userId: 'actor-boundary', orgId: 'org-boundary', privilegeWitness: DUMMY_WITNESS }),
      { ...validActor(), [Symbol('extra')]: 1 },
      { ...validActor(), userId: 1 },
      { ...validActor(), orgId: null },
      { ...validActor(), privilegeWitness: DUMMY_WITNESS.slice(0, 63) },
      { ...validActor(), privilegeWitness: DUMMY_WITNESS.toUpperCase() },
      { ...validActor(), privilegeWitness: `${DUMMY_WITNESS}\n` },
      { ...validActor(), privilegeWitness: `${DUMMY_WITNESS.slice(0, 63)}\n` },
    ]
    const hidden = { ...validActor() }
    Object.defineProperty(hidden, 'hidden', { value: 'x', enumerable: false })
    invalid.push(hidden)
    let accessorReads = 0
    const accessor = { orgId: 'org-boundary', privilegeWitness: DUMMY_WITNESS }
    Object.defineProperty(accessor, 'userId', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'actor-boundary'
      },
    })
    invalid.push(accessor)
    class ActorBox {
      userId = 'actor-boundary'
      orgId = 'org-boundary'
      privilegeWitness = DUMMY_WITNESS
    }
    invalid.push(new ActorBox())
    for (const candidate of invalid) {
      const error = await refusal(resolveAdminGrantTargetSet(tx, contextFor(candidate) as never, baseIntent, phase))
      expect(error.code).toBe('actor_privilege_expectation_invalid')
      expect(error.reason).toBe('actor_privilege_expectation_invalid')
    }
    expect(accessorReads).toBe(0)
    const throwing = [
      new Proxy({ ...validActor() }, { ownKeys() { throw new Error(SECRET) } }),
      new Proxy({ ...validActor() }, { getPrototypeOf() { throw new Error(SECRET) } }),
      new Proxy({ ...validActor() }, { getOwnPropertyDescriptor() { throw new Error(SECRET) } }),
    ]
    for (const candidate of throwing) {
      const error = await refusal(resolveAdminGrantTargetSet(tx, contextFor(candidate) as never, baseIntent, phase))
      expect(error.code).toBe('actor_privilege_expectation_invalid')
    }
    let contextReads = 0
    const context = { client: tx, privilegePlan: plan }
    Object.defineProperty(context, 'actorPrivilege', {
      enumerable: true,
      get() {
        contextReads += 1
        throw new Error(SECRET)
      },
    })
    const contextError = await refusal(resolveAdminGrantTargetSet(tx, context as never, baseIntent, phase))
    expect(contextError.code).toBe('actor_privilege_expectation_invalid')
    expect(contextReads).toBe(0)
    const caller = validActor()
    const token = await refusal(resolveAdminGrantTargetSet(tx, contextFor(caller), baseIntent, phase))
    expect(token.code).toBe('token_rejected')
    expect(Object.isFrozen(caller)).toBe(false)
    caller.userId = 'changed-after-entry'
    const nullPrototype = Object.assign(Object.create(null), validActor()) as ActorFields
    const nullPrototypeError = await refusal(resolveAdminGrantTargetSet(tx, contextFor(nullPrototype), baseIntent, phase))
    expect(nullPrototypeError.code).toBe('token_rejected')
    expect(Object.isFrozen(nullPrototype)).toBe(false)
    expect(events).toEqual([])
  })

  it('keeps intent and phase ahead of actor shape, then subject mismatch ahead of IO', async () => {
    const { tx, plan, events } = harness()
    const phase = 'consume' satisfies AdminGrantReceivingPhase
    const bare = { client: tx, privilegePlan: plan } as never
    const intentError = await refusal(resolveAdminGrantTargetSet(
      tx,
      bare,
      { ...baseIntent, purpose: 'nope' },
      phase,
    ))
    expect(intentError.code).toBe('intent_invalid')
    const phaseError = await refusal(resolveAdminGrantTargetSet(tx, bare, baseIntent, 'later' as AdminGrantReceivingPhase))
    expect(phaseError.code).toBe('phase_invalid')
    const nul = await refusal(resolveAdminGrantTargetSet(
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: { ...validActor(), userId: 'actor\u0000boundary' } },
      baseIntent,
      phase,
    ))
    expect(nul.code).toBe('unrepresentable_string')
    const surrogate = await refusal(resolveAdminGrantTargetSet(
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: { ...validActor(), orgId: 'org\uD800boundary' } },
      baseIntent,
      phase,
    ))
    expect(surrogate.code).toBe('unrepresentable_string')
    const user = await refusal(resolveAdminGrantTargetSet(
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: { ...validActor(), userId: 'other-actor' } },
      baseIntent,
      phase,
    ))
    expect(user.code).toBe('actor_privilege_subject_mismatch')
    expect(user.reason).toBe('actor_privilege_subject_mismatch')
    const org = await refusal(resolveAdminGrantTargetSet(
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: { ...validActor(), orgId: 'other-org' } },
      baseIntent,
      phase,
    ))
    expect(org.code).toBe('actor_privilege_subject_mismatch')
    expect(events).toEqual([])
  })

  it('copies the actor expectation before consume brand checks and does not query', async () => {
    const { tx, plan, events } = harness()
    const phaseContext = {
      client: tx,
      privilegePlan: plan,
      actorPrivilege: validActor(),
    }
    const malformed = await refusal(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: { userId: 'actor-boundary' } } as never,
      baseIntent,
    )))
    expect(malformed.code).toBe('actor_privilege_expectation_invalid')
    const unrepresentable = await refusal(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: { ...validActor(), orgId: 'org\u0000boundary' } },
      baseIntent,
    )))
    expect(unrepresentable.code).toBe('unrepresentable_string')
    const intent = await refusal(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      phaseContext,
      { ...baseIntent, purpose: 'nope' },
    )))
    expect(intent.code).toBe('intent_invalid')
    const token = await refusal(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      phaseContext,
      baseIntent,
    )))
    expect(token.code).toBe('token_rejected')
    const caller = validActor()
    await refusal(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: caller },
      baseIntent,
    )))
    expect(Object.isFrozen(caller)).toBe(false)
    expect(events).toEqual([])
  })

  it('maps caller reflection traps to a fixed actor refusal and leaves representability outside', async () => {
    expect(reflectionCatchProblems(readerSource())).toEqual([])
    const { tx, plan, events } = harness()
    const phase = 'consume' satisfies AdminGrantReceivingPhase
    const sentinel = new AdminGrantReceivingRefusal('read_failed', SECRET)
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error(SECRET)
      },
    })
    const ordinary = new Error('ORDINARY_REFLECTION_FAILURE')
    const thrownValues = [sentinel, hostile, ordinary]
    const actorReads = { count: 0 }
    const contextReads = { count: 0 }
    const actorProxy = (trap: 'getPrototypeOf' | 'ownKeys' | 'getOwnPropertyDescriptor', thrown: unknown) => {
      const target = validActor()
      Object.defineProperty(target, 'userId', {
        enumerable: true,
        get() {
          actorReads.count += 1
          return 'actor-boundary'
        },
      })
      return new Proxy(target, {
        getPrototypeOf(inner) {
          if (trap === 'getPrototypeOf') throw thrown
          return Reflect.getPrototypeOf(inner)
        },
        ownKeys(inner) {
          if (trap === 'ownKeys') throw thrown
          return Reflect.ownKeys(inner)
        },
        getOwnPropertyDescriptor(inner, key) {
          if (trap === 'getOwnPropertyDescriptor') throw thrown
          return Reflect.getOwnPropertyDescriptor(inner, key)
        },
      })
    }
    const contextProxy = (thrown: unknown) => {
      const actor = validActor()
      Object.defineProperty(actor, 'userId', {
        enumerable: true,
        get() {
          contextReads.count += 1
          return 'actor-boundary'
        },
      })
      return new Proxy({ client: tx, privilegePlan: plan, actorPrivilege: actor }, {
        getOwnPropertyDescriptor(inner, key) {
          if (key === 'actorPrivilege') throw thrown
          return Reflect.getOwnPropertyDescriptor(inner, key)
        },
      })
    }
    const fixed = async (promise: Promise<unknown>) => {
      const error = await refusal(promise)
      expect(error.code).toBe('actor_privilege_expectation_invalid')
      expect(error.reason).toBe('actor_privilege_expectation_invalid')
      expect(error.message.includes('ORDINARY_REFLECTION_FAILURE')).toBe(false)
      expect(error.message.includes('read_failed')).toBe(false)
    }
    for (const thrown of thrownValues) {
      for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
        const actor = actorProxy(trap, thrown)
        await fixed(resolveAdminGrantTargetSet(tx, { client: tx, privilegePlan: plan, actorPrivilege: actor } as never, baseIntent, phase))
        await fixed(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
          { marker: 'unbranded' },
          tx,
          { client: tx, privilegePlan: plan, actorPrivilege: actor } as never,
          baseIntent,
        )))
      }
      const context = contextProxy(thrown)
      await fixed(resolveAdminGrantTargetSet(tx, context as never, baseIntent, phase))
      await fixed(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
        { marker: 'unbranded' },
        tx,
        context as never,
        baseIntent,
      )))
    }
    const revokedTarget = validActor()
    Object.defineProperty(revokedTarget, 'userId', {
      enumerable: true,
      get() {
        actorReads.count += 1
        return 'actor-boundary'
      },
    })
    const revokedActor = Proxy.revocable(revokedTarget, {})
    revokedActor.revoke()
    await fixed(resolveAdminGrantTargetSet(
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: revokedActor.proxy } as never,
      baseIntent,
      phase,
    ))
    await fixed(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: revokedActor.proxy } as never,
      baseIntent,
    )))
    const copiedNul = { ...validActor(), privilegeWitness: `ab\u0000${'cd'.repeat(31)}` }
    const resolveNul = await refusal(resolveAdminGrantTargetSet(
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: copiedNul },
      baseIntent,
      phase,
    ))
    expect(resolveNul.code).toBe('unrepresentable_string')
    expect(resolveNul.reason).toBe('unrepresentable_string')
    const consumeNul = await refusal(Promise.resolve().then(() => assertPreparedAdminGrantConsume(
      { marker: 'unbranded' },
      tx,
      { client: tx, privilegePlan: plan, actorPrivilege: copiedNul },
      baseIntent,
    )))
    expect(consumeNul.code).toBe('unrepresentable_string')
    expect(consumeNul.reason).toBe('unrepresentable_string')
    expect(actorReads.count).toBe(0)
    expect(contextReads.count).toBe(0)
    expect(events).toEqual([])
  })
})
