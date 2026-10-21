import { createHash, randomUUID } from 'node:crypto'

import { isElearningCreditSurfaceEnabled } from './elearning-credit-ledger'

export const ELEARNING_CREDIT_ADJUSTMENT_REQUEST_DOMAIN =
  'elearning.credit.adjustment.request.v1' as const
export const ELEARNING_CREDIT_ADJUSTMENT_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_CREDIT_INT4_MAX = 2_147_483_647 as const

const TEXT_MAX = 512
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningCreditAdjustmentErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'conflict'
  | 'not_found'
  | 'unavailable'

export class ElearningCreditAdjustmentError extends Error {
  constructor(readonly code: ElearningCreditAdjustmentErrorCode) {
    super(code)
    this.name = 'ElearningCreditAdjustmentError'
  }
}

export interface AdjustElearningCreditInput {
  orgId: unknown
  actorId: unknown
  requestId: unknown
  userId: unknown
  points: unknown
  reason: unknown
}

export interface ElearningCreditAdjustmentResult {
  adjustmentId: string
  userId: string
  points: number
  balancePoints: number
  createdAt: string
  duplicate: boolean
}

export interface ElearningCreditAdjustmentExisting {
  adjustmentId: string
  requestHash: string
  requestHashVersion: number
  userId: string
  points: number
  balancePoints: number
  createdAt: string
}

export interface ElearningCreditAdjustmentTx {
  lockRequest(input: { orgId: string; requestId: string }): Promise<void>
  loadRequest(input: {
    orgId: string
    requestId: string
  }): Promise<ElearningCreditAdjustmentExisting | null>
  hasActiveMembership(input: { orgId: string; userId: string }): Promise<boolean>
  lockBalance(input: { orgId: string; userId: string }): Promise<number>
  setBalance(input: {
    orgId: string
    userId: string
    previousBalance: number
    balancePoints: number
  }): Promise<void>
  appendAdjustment(input: {
    adjustmentId: string
    orgId: string
    actorId: string
    requestId: string
    requestHash: string
    requestHashVersion: number
    userId: string
    points: number
    reason: string
    balancePoints: number
  }): Promise<{ createdAt: string }>
}

interface PreparedAdjustment {
  orgId: string
  actorId: string
  requestId: string
  userId: string
  points: number
  reason: string
  requestHash: string
}

function fail(code: ElearningCreditAdjustmentErrorCode): never {
  throw new ElearningCreditAdjustmentError(code)
}

function hasMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (
    text === ''
    || text.length > TEXT_MAX
    || text.includes('\0')
    || hasMalformedUnicode(text)
  ) fail('invalid_input')
  return text
}

function requirePoints(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value === 0
    || value < -ELEARNING_CREDIT_INT4_MAX
    || value > ELEARNING_CREDIT_INT4_MAX
  ) fail('invalid_input')
  return value
}

function canonicalize(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))
}

export function hashElearningCreditAdjustmentRequest(input: {
  actorId: string
  userId: string
  points: number
  reason: string
}): string {
  return createHash('sha256')
    .update(canonicalize({
      actorId: input.actorId,
      domain: ELEARNING_CREDIT_ADJUSTMENT_REQUEST_DOMAIN,
      points: input.points,
      reason: input.reason,
      userId: input.userId,
      version: ELEARNING_CREDIT_ADJUSTMENT_REQUEST_HASH_VERSION,
    }), 'utf8')
    .digest('hex')
}

function prepare(input: AdjustElearningCreditInput): PreparedAdjustment {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const requestId = requireText(input.requestId)
  const userId = requireText(input.userId)
  const points = requirePoints(input.points)
  const reason = requireText(input.reason)
  return {
    orgId,
    actorId,
    requestId,
    userId,
    points,
    reason,
    requestHash: hashElearningCreditAdjustmentRequest({
      actorId,
      userId,
      points,
      reason,
    }),
  }
}

function storedInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(parsed) ? parsed : null
}

function replay(
  existing: ElearningCreditAdjustmentExisting,
  prepared: PreparedAdjustment,
): ElearningCreditAdjustmentResult {
  if (
    existing.requestHash !== prepared.requestHash
    || existing.requestHashVersion !== ELEARNING_CREDIT_ADJUSTMENT_REQUEST_HASH_VERSION
  ) fail('conflict')
  const points = storedInt(existing.points)
  const balancePoints = storedInt(existing.balancePoints)
  const createdAt = new Date(existing.createdAt)
  if (
    typeof existing.adjustmentId !== 'string'
    || !UUID_RE.test(existing.adjustmentId)
    || existing.userId !== prepared.userId
    || points === null
    || points !== prepared.points
    || balancePoints === null
    || balancePoints < 0
    || balancePoints > ELEARNING_CREDIT_INT4_MAX
    || !Number.isFinite(createdAt.getTime())
  ) fail('unavailable')
  return {
    adjustmentId: existing.adjustmentId.toLowerCase(),
    userId: existing.userId,
    points,
    balancePoints,
    createdAt: createdAt.toISOString(),
    duplicate: true,
  }
}

export async function adjustElearningCreditInTransaction(
  tx: ElearningCreditAdjustmentTx,
  input: AdjustElearningCreditInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningCreditAdjustmentResult> {
  const prepared = prepare(input)
  if (!isElearningCreditSurfaceEnabled(env)) fail('disabled')

  try {
    await tx.lockRequest({ orgId: prepared.orgId, requestId: prepared.requestId })
    const existing = await tx.loadRequest({
      orgId: prepared.orgId,
      requestId: prepared.requestId,
    })
    if (existing) return replay(existing, prepared)

    if (!await tx.hasActiveMembership({ orgId: prepared.orgId, userId: prepared.actorId })) {
      fail('not_found')
    }
    if (!await tx.hasActiveMembership({ orgId: prepared.orgId, userId: prepared.userId })) {
      fail('not_found')
    }

    const previousBalance = await tx.lockBalance({
      orgId: prepared.orgId,
      userId: prepared.userId,
    })
    if (
      !Number.isSafeInteger(previousBalance)
      || previousBalance < 0
      || previousBalance > ELEARNING_CREDIT_INT4_MAX
    ) fail('unavailable')
    const balancePoints = previousBalance + prepared.points
    if (
      !Number.isSafeInteger(balancePoints)
      || balancePoints < 0
      || balancePoints > ELEARNING_CREDIT_INT4_MAX
    ) fail('conflict')

    await tx.setBalance({
      orgId: prepared.orgId,
      userId: prepared.userId,
      previousBalance,
      balancePoints,
    })
    const adjustmentId = randomUUID()
    const inserted = await tx.appendAdjustment({
      adjustmentId,
      orgId: prepared.orgId,
      actorId: prepared.actorId,
      requestId: prepared.requestId,
      requestHash: prepared.requestHash,
      requestHashVersion: ELEARNING_CREDIT_ADJUSTMENT_REQUEST_HASH_VERSION,
      userId: prepared.userId,
      points: prepared.points,
      reason: prepared.reason,
      balancePoints,
    })
    const createdAt = new Date(inserted.createdAt)
    if (!Number.isFinite(createdAt.getTime())) fail('unavailable')
    return {
      adjustmentId,
      userId: prepared.userId,
      points: prepared.points,
      balancePoints,
      createdAt: createdAt.toISOString(),
      duplicate: false,
    }
  } catch (error) {
    if (error instanceof ElearningCreditAdjustmentError) throw error
    fail('unavailable')
  }
}
