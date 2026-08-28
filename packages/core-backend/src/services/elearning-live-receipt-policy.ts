/**
 * Pure L6 live-provider receipt policy. Receipts are adapter-verified,
 * internally normalized provider evidence, never raw client claims. This
 * module performs no provider I/O and is intentionally unreachable from HTTP.
 * Persistence, adapters, and routes stay outside this policy boundary.
 */

const MAX_KEY_LENGTH = 512

const POLICY_KEYS = [
  'completionMode',
  'liveRequiredSeconds',
  'policyRevision',
  'replayRequiredSeconds',
] as const

const CONTEXT_KEYS = [
  'courseVersionId',
  'itemKey',
  'orgId',
  'policyRevision',
  'providerEventKey',
  'providerKey',
  'userId',
] as const

const RECEIPT_KEYS = [
  'courseVersionId',
  'itemKey',
  'observedAt',
  'orgId',
  'policyRevision',
  'providerEventKey',
  'providerKey',
  'providerReceiptKey',
  'source',
  'userId',
  'measuredSeconds',
] as const

const EVALUATION_KEYS = ['expectedContext', 'receipts'] as const

export type ElearningLiveReceiptCompletionMode = 'live_only' | 'live_or_replay'
export type ElearningLiveReceiptSource = 'live' | 'replay'

export type ElearningLiveReceiptPolicyErrorCode =
  | 'duplicate_provider_receipt_key'
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_receipt'
  | 'policy_mismatch'
  | 'receipt_context_mismatch'

export class ElearningLiveReceiptPolicyError extends Error {
  constructor(readonly code: ElearningLiveReceiptPolicyErrorCode) {
    super(code)
    this.name = 'ElearningLiveReceiptPolicyError'
  }
}

export interface ElearningLiveReceiptPolicy {
  readonly completionMode: ElearningLiveReceiptCompletionMode
  readonly liveRequiredSeconds: number
  readonly policyRevision: string
  readonly replayRequiredSeconds: number
}

export interface ElearningLiveReceiptContext {
  readonly courseVersionId: string
  readonly itemKey: string
  readonly orgId: string
  readonly policyRevision: string
  readonly providerEventKey: string
  readonly providerKey: string
  readonly userId: string
}

/** Normalized evidence produced by a trusted external-provider adapter. */
export interface ElearningAdapterVerifiedLiveReceipt extends ElearningLiveReceiptContext {
  readonly measuredSeconds: number
  readonly observedAt: string
  readonly providerReceiptKey: string
  readonly source: ElearningLiveReceiptSource
}

export type ElearningLiveReceiptCompletionReason =
  | 'below_threshold'
  | 'completed'
  | 'no_receipt'

export interface ElearningLiveReceiptCompletionDecision {
  readonly completed: boolean
  readonly measuredSeconds: number
  readonly policyRevision: string
  readonly providerReceiptKey: string | null
  readonly reason: ElearningLiveReceiptCompletionReason
  readonly requiredSeconds: number
  readonly source: ElearningLiveReceiptSource | null
}

function fail(code: ElearningLiveReceiptPolicyErrorCode): never {
  throw new ElearningLiveReceiptPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningLiveReceiptPolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const ownKeys = Reflect.ownKeys(input)
    if (ownKeys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const keys = (ownKeys as string[]).sort()
    const expected = [...expectedKeys].sort()
    if (
      keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])
    ) fail(code)
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningLiveReceiptPolicyError) throw error
    fail(code)
  }
}

function readDenseArray(input: unknown): readonly unknown[] {
  if (!Array.isArray(input)) fail('invalid_input')
  try {
    const length = input.length
    const ownKeys = Reflect.ownKeys(input)
    if (
      ownKeys.length !== length + 1
      || !ownKeys.includes('length')
      || ownKeys.some((key) => (
        key !== 'length'
        && (typeof key !== 'string' || !/^\d+$/.test(key))
      ))
    ) fail('invalid_input')
    const values: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail('invalid_input')
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningLiveReceiptPolicyError) throw error
    fail('invalid_input')
  }
}

function assertSupportedText(value: string, code: ElearningLiveReceiptPolicyErrorCode): void {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point === 0) fail(code)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(code)
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail(code)
    }
  }
}

function requireKey(value: unknown, code: 'invalid_context' | 'invalid_policy' | 'invalid_receipt'): string {
  if (typeof value !== 'string') fail(code)
  const key = value.trim()
  if (key === '' || key.length > MAX_KEY_LENGTH) fail(code)
  assertSupportedText(key, code)
  return key
}

function requirePositiveSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_policy')
  }
  return value
}

function requireMeasuredSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid_receipt')
  }
  return value
}

function normalizeInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-/.test(value)) fail('invalid_receipt')
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) fail('invalid_receipt')
  try {
    if (new Date(instant).toISOString() !== value) fail('invalid_receipt')
  } catch {
    fail('invalid_receipt')
  }
  return value
}

function normalizePolicy(input: unknown): ElearningLiveReceiptPolicy {
  const values = readExactObject(input, POLICY_KEYS, 'invalid_input')
  if (values.completionMode !== 'live_only' && values.completionMode !== 'live_or_replay') {
    fail('invalid_policy')
  }
  const liveRequiredSeconds = requirePositiveSeconds(values.liveRequiredSeconds)
  const policyRevision = requireKey(values.policyRevision, 'invalid_policy')
  const replayRequiredSeconds = requirePositiveSeconds(values.replayRequiredSeconds)
  return Object.freeze({
    completionMode: values.completionMode,
    liveRequiredSeconds,
    policyRevision,
    replayRequiredSeconds,
  })
}

function normalizeContext(input: unknown): ElearningLiveReceiptContext {
  const values = readExactObject(input, CONTEXT_KEYS, 'invalid_context')
  return Object.freeze({
    courseVersionId: requireKey(values.courseVersionId, 'invalid_context'),
    itemKey: requireKey(values.itemKey, 'invalid_context'),
    orgId: requireKey(values.orgId, 'invalid_context'),
    policyRevision: requireKey(values.policyRevision, 'invalid_context'),
    providerEventKey: requireKey(values.providerEventKey, 'invalid_context'),
    providerKey: requireKey(values.providerKey, 'invalid_context'),
    userId: requireKey(values.userId, 'invalid_context'),
  })
}

/**
 * Adapter trust-boundary normalizer. It validates the closed internal row but
 * does not verify a provider signature or API response. Call it only after a
 * provider-specific adapter has authenticated the receipt; never on client JSON.
 */
export function normalizeElearningAdapterVerifiedLiveReceipt(
  input: unknown,
): ElearningAdapterVerifiedLiveReceipt {
  const values = readExactObject(input, RECEIPT_KEYS, 'invalid_receipt')
  if (values.source !== 'live' && values.source !== 'replay') fail('invalid_receipt')
  return Object.freeze({
    courseVersionId: requireKey(values.courseVersionId, 'invalid_receipt'),
    itemKey: requireKey(values.itemKey, 'invalid_receipt'),
    measuredSeconds: requireMeasuredSeconds(values.measuredSeconds),
    observedAt: normalizeInstant(values.observedAt),
    orgId: requireKey(values.orgId, 'invalid_receipt'),
    policyRevision: requireKey(values.policyRevision, 'invalid_receipt'),
    providerEventKey: requireKey(values.providerEventKey, 'invalid_receipt'),
    providerKey: requireKey(values.providerKey, 'invalid_receipt'),
    providerReceiptKey: requireKey(values.providerReceiptKey, 'invalid_receipt'),
    source: values.source,
    userId: requireKey(values.userId, 'invalid_receipt'),
  })
}

export function normalizeElearningLiveReceiptPolicy(
  input: unknown,
): ElearningLiveReceiptPolicy {
  return normalizePolicy(input)
}

function assertReceiptContext(
  receipt: ElearningAdapterVerifiedLiveReceipt,
  context: ElearningLiveReceiptContext,
): void {
  for (const key of CONTEXT_KEYS) {
    if (receipt[key] !== context[key]) fail('receipt_context_mismatch')
  }
}

function betterReceipt(
  current: ElearningAdapterVerifiedLiveReceipt | null,
  candidate: ElearningAdapterVerifiedLiveReceipt,
): ElearningAdapterVerifiedLiveReceipt {
  if (current === null) return candidate
  if (candidate.measuredSeconds !== current.measuredSeconds) {
    return candidate.measuredSeconds > current.measuredSeconds ? candidate : current
  }
  if (candidate.observedAt !== current.observedAt) {
    return candidate.observedAt > current.observedAt ? candidate : current
  }
  return candidate.providerReceiptKey < current.providerReceiptKey ? candidate : current
}

function maximumReceipt(
  receipts: readonly ElearningAdapterVerifiedLiveReceipt[],
  source: ElearningLiveReceiptSource,
): ElearningAdapterVerifiedLiveReceipt | null {
  let maximum: ElearningAdapterVerifiedLiveReceipt | null = null
  for (const receipt of receipts) {
    if (receipt.source === source) maximum = betterReceipt(maximum, receipt)
  }
  return maximum
}

interface SelectedReceipt {
  readonly receipt: ElearningAdapterVerifiedLiveReceipt
  readonly requiredSeconds: number
  readonly source: ElearningLiveReceiptSource
}

function selectIncompleteReceipt(
  policy: ElearningLiveReceiptPolicy,
  live: ElearningAdapterVerifiedLiveReceipt | null,
  replay: ElearningAdapterVerifiedLiveReceipt | null,
): SelectedReceipt | null {
  if (live === null && replay === null) return null
  if (replay === null) {
    return { receipt: live as ElearningAdapterVerifiedLiveReceipt, requiredSeconds: policy.liveRequiredSeconds, source: 'live' }
  }
  if (live === null) {
    return { receipt: replay, requiredSeconds: policy.replayRequiredSeconds, source: 'replay' }
  }
  const liveRatio = BigInt(live.measuredSeconds) * BigInt(policy.replayRequiredSeconds)
  const replayRatio = BigInt(replay.measuredSeconds) * BigInt(policy.liveRequiredSeconds)
  return liveRatio >= replayRatio
    ? { receipt: live, requiredSeconds: policy.liveRequiredSeconds, source: 'live' }
    : { receipt: replay, requiredSeconds: policy.replayRequiredSeconds, source: 'replay' }
}

export function evaluateElearningLiveReceiptCompletion(
  policyInput: unknown,
  input: unknown,
): ElearningLiveReceiptCompletionDecision {
  const policy = normalizePolicy(policyInput)
  const values = readExactObject(input, EVALUATION_KEYS, 'invalid_input')
  const context = normalizeContext(values.expectedContext)
  if (context.policyRevision !== policy.policyRevision) fail('policy_mismatch')
  const receiptInputs = readDenseArray(values.receipts)
  const receipts = receiptInputs.map((receiptInput) => (
    normalizeElearningAdapterVerifiedLiveReceipt(receiptInput)
  ))
  const receiptKeys = new Set<string>()
  for (const receipt of receipts) {
    if (receiptKeys.has(receipt.providerReceiptKey)) fail('duplicate_provider_receipt_key')
    receiptKeys.add(receipt.providerReceiptKey)
    assertReceiptContext(receipt, context)
  }

  const live = maximumReceipt(receipts, 'live')
  const replay = policy.completionMode === 'live_or_replay'
    ? maximumReceipt(receipts, 'replay')
    : null
  const liveComplete = live !== null && live.measuredSeconds >= policy.liveRequiredSeconds
  const replayComplete = replay !== null && replay.measuredSeconds >= policy.replayRequiredSeconds
  const selected = liveComplete
    ? { receipt: live as ElearningAdapterVerifiedLiveReceipt, source: 'live' as const }
    : replayComplete
      ? { receipt: replay as ElearningAdapterVerifiedLiveReceipt, source: 'replay' as const }
      : null

  if (selected !== null) {
    return Object.freeze({
      completed: true,
      measuredSeconds: selected.receipt.measuredSeconds,
      policyRevision: policy.policyRevision,
      providerReceiptKey: selected.receipt.providerReceiptKey,
      reason: 'completed' as const,
      requiredSeconds: selected.source === 'live'
        ? policy.liveRequiredSeconds
        : policy.replayRequiredSeconds,
      source: selected.source,
    })
  }

  const selectedIncomplete = selectIncompleteReceipt(policy, live, replay)
  return Object.freeze({
    completed: false,
    measuredSeconds: selectedIncomplete?.receipt.measuredSeconds ?? 0,
    policyRevision: policy.policyRevision,
    providerReceiptKey: selectedIncomplete?.receipt.providerReceiptKey ?? null,
    reason: selectedIncomplete === null ? 'no_receipt' as const : 'below_threshold' as const,
    requiredSeconds: selectedIncomplete?.requiredSeconds ?? policy.liveRequiredSeconds,
    source: selectedIncomplete?.source ?? null,
  })
}
