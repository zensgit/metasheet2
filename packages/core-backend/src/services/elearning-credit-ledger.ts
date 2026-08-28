/**
 * Internal L4-A credit-ledger orchestration. Persistence stays behind a port
 * so a later SQL adapter can land without changing award semantics.
 */
import { randomUUID } from 'node:crypto'

import {
  ELEARNING_INCENTIVE_ENABLED,
  isElearningEnabled,
  isElearningFlagEnabled,
} from '../elearning/feature-flags'
import {
  computeElearningCreditAward,
  elearningCreditDay,
  ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  ElearningCreditPolicyError,
  hashElearningCreditEffect,
  normalizeElearningCreditBehavior,
  normalizeElearningCreditOccurredAt,
  normalizeElearningCreditRuleSnapshot,
  type ElearningCreditBehavior,
  type ElearningCreditEffectInput,
  type ElearningCreditRuleSnapshot,
  type ElearningCreditRuleSnapshotInput,
} from './elearning-credit-policy'

export type ElearningCreditLedgerErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'invalid_behavior'
  | 'unsupported_behavior'
  | 'conflict'
  | 'rule_unavailable'
  | 'unavailable'

export type ElearningCreditDecisionStatus = 'awarded' | 'capped' | 'exhausted'

export class ElearningCreditLedgerError extends Error {
  constructor(readonly code: ElearningCreditLedgerErrorCode) {
    super(code)
    this.name = 'ElearningCreditLedgerError'
  }
}

export type ClaimElearningCreditInput = ElearningCreditEffectInput

export interface ElearningCreditClaimResult {
  decisionId: string
  awardedPoints: number
  status: ElearningCreditDecisionStatus
  duplicate: boolean
}

export interface ElearningCreditEffectIdentity {
  orgId: string
  userId: string
  behavior: ElearningCreditBehavior
  effectKey: string
}

export interface ElearningCreditExistingEffect {
  id: string
  requestHash: string
  requestHashVersion: number
  awardedPoints: number
  status: ElearningCreditDecisionStatus
}

export interface ElearningCreditEffectClaimInput extends ElearningCreditEffectIdentity {
  decisionId: string
  requestHash: string
  requestHashVersion: number
}

export type ElearningCreditEffectClaimResult =
  | { kind: 'claimed' }
  | { kind: 'existing'; effect: ElearningCreditExistingEffect }

export interface ElearningCreditDecisionRow {
  id: string
  orgId: string
  userId: string
  behavior: ElearningCreditBehavior
  effectKey: string
  requestHash: string
  requestHashVersion: number
  occurredAt: string
  localDay: string
  rule: ElearningCreditRuleSnapshot
  requestedPoints: number
  awardedPoints: number
  remainingDailyCap: number | null
  status: ElearningCreditDecisionStatus
}

export interface ElearningCreditLedgerTx {
  claimEffect(input: ElearningCreditEffectClaimInput): Promise<ElearningCreditEffectClaimResult>
  resolveActiveRule(input: {
    orgId: string
    behavior: ElearningCreditBehavior
  }): Promise<ElearningCreditRuleSnapshotInput | null>
  lockBucket(input: {
    orgId: string
    userId: string
    behavior: ElearningCreditBehavior
    localDay: string
  }): Promise<void>
  sumPositiveAwards(input: {
    orgId: string
    userId: string
    behavior: ElearningCreditBehavior
    localDay: string
  }): Promise<number>
  appendDecision(row: ElearningCreditDecisionRow): Promise<void>
  applyBalanceDelta(input: {
    orgId: string
    userId: string
    delta: number
  }): Promise<void>
}

export interface ElearningCreditLedgerStore {
  transaction<T>(handler: (tx: ElearningCreditLedgerTx) => Promise<T>): Promise<T>
}

function fail(code: ElearningCreditLedgerErrorCode): never {
  throw new ElearningCreditLedgerError(code)
}

export function isElearningCreditSurfaceEnabled(env: NodeJS.ProcessEnv): boolean {
  return isElearningEnabled(env) && isElearningFlagEnabled(ELEARNING_INCENTIVE_ENABLED, env)
}

function asDecisionStatus(value: unknown): ElearningCreditDecisionStatus | null {
  return value === 'awarded' || value === 'capped' || value === 'exhausted' ? value : null
}

function closeExisting(
  existing: ElearningCreditExistingEffect,
  requestHash: string,
): ElearningCreditClaimResult {
  if (
    typeof existing.id !== 'string'
    || existing.id.trim() === ''
    || typeof existing.requestHash !== 'string'
    || existing.requestHash.trim() === ''
  ) fail('unavailable')
  if (
    existing.requestHash !== requestHash
    || existing.requestHashVersion !== ELEARNING_CREDIT_EFFECT_HASH_VERSION
  ) {
    fail('conflict')
  }
  const status = asDecisionStatus(existing.status)
  if (
    !status
    || !Number.isSafeInteger(existing.awardedPoints)
    || existing.awardedPoints < 0
    || (status === 'exhausted' && existing.awardedPoints !== 0)
    || (status !== 'exhausted' && existing.awardedPoints === 0)
  ) fail('unavailable')
  return {
    awardedPoints: existing.awardedPoints,
    decisionId: existing.id,
    duplicate: true,
    status,
  }
}

function wrapPolicy(error: unknown, onPolicy: ElearningCreditLedgerErrorCode): never {
  if (error instanceof ElearningCreditLedgerError) throw error
  if (error instanceof ElearningCreditPolicyError) {
    fail(error.code === 'invalid_behavior' ? 'invalid_behavior' : onPolicy)
  }
  fail('unavailable')
}

interface PreparedElearningCreditClaim {
  behavior: ElearningCreditBehavior
  effectKey: string
  occurredAt: string
  orgId: string
  requestHash: string
  userId: string
}

function prepareClaim(input: ClaimElearningCreditInput): PreparedElearningCreditClaim {
  let behavior: ElearningCreditBehavior
  try {
    behavior = normalizeElearningCreditBehavior(input.behavior)
  } catch (error) {
    wrapPolicy(error, 'invalid_input')
  }
  if (behavior === 'manual_adjust') fail('unsupported_behavior')

  try {
    return {
      behavior,
      effectKey: input.effectKey.trim(),
      occurredAt: normalizeElearningCreditOccurredAt(input.occurredAt),
      orgId: input.orgId.trim(),
      requestHash: hashElearningCreditEffect(input),
      userId: input.userId.trim(),
    }
  } catch (error) {
    wrapPolicy(error, 'invalid_input')
  }
}

async function claimPreparedElearningCredit(
  tx: ElearningCreditLedgerTx,
  claimInput: PreparedElearningCreditClaim,
): Promise<ElearningCreditClaimResult> {
  const { behavior, effectKey, occurredAt, orgId, requestHash, userId } = claimInput
  const identity: ElearningCreditEffectIdentity = { behavior, effectKey, orgId, userId }
  const decisionId = randomUUID()

  const claim = await tx.claimEffect({
    ...identity,
    decisionId,
    requestHash,
    requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  })
  if (claim.kind === 'existing') return closeExisting(claim.effect, requestHash)

  const rawRule = await tx.resolveActiveRule({ behavior, orgId })
  if (!rawRule) fail('rule_unavailable')

  let rule: ElearningCreditRuleSnapshot
  try {
    rule = normalizeElearningCreditRuleSnapshot(behavior, rawRule)
  } catch (error) {
    wrapPolicy(error, 'rule_unavailable')
  }

  const localDay = elearningCreditDay(occurredAt, rule.timeZone)
  await tx.lockBucket({ behavior, localDay, orgId, userId })

  const awardedToday = await tx.sumPositiveAwards({
    behavior,
    localDay,
    orgId,
    userId,
  })
  if (!Number.isSafeInteger(awardedToday) || awardedToday < 0) fail('unavailable')

  const award = computeElearningCreditAward({
    awardedToday,
    behavior,
    dailyCap: rule.dailyCap,
    requestedPoints: rule.points,
  })
  const status = asDecisionStatus(award.status)
  if (!status) fail('unavailable')

  await tx.appendDecision({
    awardedPoints: award.awardedPoints,
    behavior,
    effectKey,
    id: decisionId,
    localDay,
    occurredAt,
    orgId,
    remainingDailyCap: award.remainingDailyCap,
    requestHash,
    requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
    requestedPoints: award.requestedPoints,
    rule,
    status,
    userId,
  })
  if (award.awardedPoints !== 0) {
    await tx.applyBalanceDelta({ delta: award.awardedPoints, orgId, userId })
  }
  return {
    awardedPoints: award.awardedPoints,
    decisionId,
    duplicate: false,
    status,
  }
}

export async function claimElearningCreditInTransaction(
  tx: ElearningCreditLedgerTx,
  input: ClaimElearningCreditInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningCreditClaimResult> {
  const prepared = prepareClaim(input)
  if (!isElearningCreditSurfaceEnabled(env)) fail('disabled')
  try {
    return await claimPreparedElearningCredit(tx, prepared)
  } catch (error) {
    if (error instanceof ElearningCreditLedgerError) throw error
    fail('unavailable')
  }
}

export async function claimElearningCredit(
  store: ElearningCreditLedgerStore,
  input: ClaimElearningCreditInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningCreditClaimResult> {
  const prepared = prepareClaim(input)
  if (!isElearningCreditSurfaceEnabled(env)) fail('disabled')

  try {
    return await store.transaction((tx) => claimPreparedElearningCredit(tx, prepared))
  } catch (error) {
    if (error instanceof ElearningCreditLedgerError) throw error
    fail('unavailable')
  }
}
