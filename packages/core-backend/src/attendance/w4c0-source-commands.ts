/**
 * W4C-0 (#4556) Stage C — strict source-command validators + envelope
 * normalization (lock section 4.1: "The public source-command union is not an
 * open callback or `unknown` payload. W4C-0 defines strict schemas with
 * unknown-key rejection and this exact variant matrix").
 *
 * NO route is cut over: nothing parses request JSON through this module yet.
 * The exact per-kind payload KEY SETS below are the W4C-0 closed reading of the
 * section 4.1 variant table's prose (recorded in HANDOFF-W4C0.md as a 呈裁点);
 * unknown keys, unknown kinds, and non-closed enum values fail before any DML.
 *
 * The boundary strict-parses into null-prototype objects, deep-copies and
 * recursively freezes the normalized envelope, and computes its
 * command/item-sequence/item-set fingerprints synchronously — before any async
 * adapter call — so prototype replacement or mutation of the caller-owned
 * object after entry cannot alter the claimed command.
 *
 * Identity discipline: `operationId`/`batchCommandId`/run identifiers pass
 * through the section 4.1 canonical UUID parser only; the emitted 36 bytes are
 * the only identity bytes that reach the registry layer. `correlationId` and
 * the identity position itself are EXCLUDED from the command fingerprint (a
 * response-loss retry must stay congruent); everything else normalized here is
 * fingerprinted.
 *
 * Business-time note: `occurredAt` values are transported as opaque non-empty
 * strings at this layer. The strict-IANA/offset business-time split (lock 4.1
 * migration split + section 5) belongs to prepare in W4C-1/2 — the validator
 * must NOT reject an offset-less legacy value that the shadow branch is
 * contractually required to accept-and-review.
 */
import {
  ATTENDANCE_SOURCE_ENTRYPOINTS_V1,
  parseCanonicalAttendanceOrgKeyV1,
  parseCanonicalAttendanceUserIdV1,
  parseCanonicalAttendanceWorkDateV1,
  type AttendanceSourceEntrypointV1,
} from './w4c0-identity'
import { computeAttendanceCommandFingerprintV1 } from './w4c0-fingerprints'
import type {
  AttendanceOperationCommandInputV1,
  AttendanceResultOperationEnvelopeInputV1,
} from './w4c0-operation-registry'

export class AttendanceW4CommandError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4CommandError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4CommandError(code)
}

const INVALID = 'W4C0_SOURCE_COMMAND_INVALID'

// ---------------------------------------------------------------------------
// Strict primitives.
// ---------------------------------------------------------------------------

const UUID_SYNTAX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const LOWER_HEX_64 = /^[0-9a-f]{64}$/

function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID_SYNTAX.test(value)) fail(INVALID)
  return value.toLowerCase()
}

function parseUuidOrNull(value: unknown): string | null {
  return value === null ? null : parseUuid(value)
}

function parseNonEmptyString(value: unknown, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail(INVALID)
  return value
}

function parseStringOrNull(value: unknown, maxLength = 2000): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > maxLength) fail(INVALID)
  return value
}

function parseHex64(value: unknown): string {
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) fail(INVALID)
  return value
}

function parseIntInRange(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(INVALID)
  return value
}

function parseIntOrNull(value: unknown, min: number): number | null {
  return value === null ? null : parseIntInRange(value, min)
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(INVALID)
  return value as T
}

function requireExactKeys(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(INVALID)
  const obj = input as Record<string, unknown>
  if (Object.getOwnPropertySymbols(obj).length > 0) fail(INVALID)
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== keys.length) fail(INVALID)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(INVALID)
    const descriptor = Object.getOwnPropertyDescriptor(obj, key)
    if (!descriptor || !('value' in descriptor)) fail(INVALID)
  }
  return obj
}

/** Deep-copy plain JSON data into recursively frozen null-prototype structures. */
function deepFreezeCopy(value: unknown, depth = 0): unknown {
  if (depth > 16) fail(INVALID)
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value)) fail(INVALID)
      return value
    case 'object':
      break
    default:
      fail(INVALID)
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeCopy(entry, depth + 1)))
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) fail(INVALID)
  if (Object.getOwnPropertySymbols(value as object).length > 0) fail(INVALID)
  const out = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry === undefined) fail(INVALID)
    out[key] = deepFreezeCopy(entry, depth + 1)
  }
  return Object.freeze(out)
}

function parsePlainObjectOrNull(value: unknown): unknown {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) fail(INVALID)
  return deepFreezeCopy(value)
}

// ---------------------------------------------------------------------------
// Closed per-kind payload schemas (section 4.1 variant matrix reading).
// ---------------------------------------------------------------------------

export const ATTENDANCE_IMPORT_TRANSPORT_KINDS_V1 = Object.freeze([
  'rows',
  'csv_text',
  'csv_upload',
  'xlsx_client_converted_csv',
] as const)

const DIRECTION = ['check_in', 'check_out'] as const
const DECISION_ACTION = ['approve', 'reject'] as const
const DECISION_CHANNEL = ['web', 'verified_delivery'] as const
const RECOMPUTE_POLICY = ['frozen_prior', 'current_policy'] as const
const MANUAL_EDIT_OPS = ['set', 'unset'] as const

type PayloadParser = (payload: unknown) => Record<string, unknown>

const PAYLOAD_PARSERS: Readonly<Record<string, PayloadParser>> = Object.freeze({
  live_punch: (payload) => {
    const p = requireExactKeys(payload, ['eventType', 'occurredAt', 'timezone', 'source', 'location', 'meta', 'photoFileRef'])
    return {
      eventType: parseEnum(p.eventType, DIRECTION),
      occurredAt: parseNonEmptyString(p.occurredAt, 64),
      timezone: parseNonEmptyString(p.timezone, 64),
      source: parseNonEmptyString(p.source, 64),
      location: parsePlainObjectOrNull(p.location),
      meta: parsePlainObjectOrNull(p.meta),
      photoFileRef: parseStringOrNull(p.photoFileRef, 512),
    }
  },
  request_create: (payload) => {
    const p = requireExactKeys(payload, ['requestType', 'requestWrite'])
    const write = p.requestWrite
    if (write === null || typeof write !== 'object' || Array.isArray(write)) fail(INVALID)
    return {
      requestType: parseNonEmptyString(p.requestType, 64),
      requestWrite: deepFreezeCopy(write),
    }
  },
  request_pending_edit: (payload) => {
    const p = requireExactKeys(payload, ['requestId', 'expectedSnapshotVersion', 'expectedSnapshotHash', 'patch'])
    const patch = p.patch
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) fail(INVALID)
    return {
      requestId: parseUuid(p.requestId),
      expectedSnapshotVersion: parseIntInRange(p.expectedSnapshotVersion, 1),
      expectedSnapshotHash: parseHex64(p.expectedSnapshotHash),
      patch: deepFreezeCopy(patch),
    }
  },
  request_decision: (payload) => {
    const p = requireExactKeys(payload, [
      'requestId',
      'approvalRef',
      'expectedApprovalVersion',
      'expectedApprovalNode',
      'action',
      'decisionChannel',
      'comment',
      'meta',
    ])
    return {
      requestId: parseUuid(p.requestId),
      approvalRef: parseNonEmptyString(p.approvalRef, 128),
      expectedApprovalVersion: parseIntInRange(p.expectedApprovalVersion, 0),
      expectedApprovalNode: parseNonEmptyString(p.expectedApprovalNode, 128),
      action: parseEnum(p.action, DECISION_ACTION),
      decisionChannel: parseEnum(p.decisionChannel, DECISION_CHANNEL),
      comment: parseStringOrNull(p.comment),
      meta: parsePlainObjectOrNull(p.meta),
    }
  },
  request_cancel: (payload) => {
    const p = requireExactKeys(payload, ['requestId', 'approvalRef', 'expectedSnapshotVersion', 'expectedSnapshotHash', 'reason', 'meta'])
    return {
      requestId: parseUuid(p.requestId),
      approvalRef: parseStringOrNull(p.approvalRef, 128),
      expectedSnapshotVersion: parseIntInRange(p.expectedSnapshotVersion, 1),
      expectedSnapshotHash: parseHex64(p.expectedSnapshotHash),
      reason: parseStringOrNull(p.reason),
      meta: parsePlainObjectOrNull(p.meta),
    }
  },
  scheduled: (payload) => {
    const p = requireExactKeys(payload, ['scheduledRunId', 'userId', 'workDate', 'expectedRunVersion', 'scheduledAbsenceSource'])
    return {
      scheduledRunId: parseUuid(p.scheduledRunId),
      userId: parseCanonicalAttendanceUserIdV1(p.userId) as string,
      workDate: parseCanonicalAttendanceWorkDateV1(p.workDate) as string,
      expectedRunVersion: parseIntInRange(p.expectedRunVersion, 1),
      scheduledAbsenceSource: parseNonEmptyString(p.scheduledAbsenceSource, 128),
    }
  },
  manual_edit: (payload) => {
    const p = requireExactKeys(payload, ['recordId', 'expectedCalculationId', 'expectedCalculationVersion', 'operations', 'reason', 'evidence'])
    if (!Array.isArray(p.operations) || p.operations.length === 0) fail(INVALID)
    const operations = p.operations.map((entry) => {
      const op = requireExactKeys(entry, ['op', 'field', 'value'])
      const kind = parseEnum(op.op, MANUAL_EDIT_OPS)
      if (kind === 'unset' && op.value !== null) fail(INVALID)
      return Object.freeze(
        Object.assign(Object.create(null), {
          op: kind,
          field: parseNonEmptyString(op.field, 64),
          value: kind === 'unset' ? null : deepFreezeCopy(op.value),
        }),
      )
    })
    return {
      recordId: parseUuid(p.recordId),
      expectedCalculationId: parseUuidOrNull(p.expectedCalculationId),
      expectedCalculationVersion: parseIntOrNull(p.expectedCalculationVersion, 1),
      operations: Object.freeze(operations),
      reason: parseNonEmptyString(p.reason, 2000),
      evidence: parsePlainObjectOrNull(p.evidence),
    }
  },
  recompute: (payload) => {
    const p = requireExactKeys(payload, ['recordId', 'expectedCalculationId', 'expectedCalculationVersion', 'policy'])
    return {
      recordId: parseUuid(p.recordId),
      expectedCalculationId: parseUuidOrNull(p.expectedCalculationId),
      expectedCalculationVersion: parseIntOrNull(p.expectedCalculationVersion, 1),
      policy: parseEnum(p.policy, RECOMPUTE_POLICY),
    }
  },
  import_rollback: (payload) => {
    const p = requireExactKeys(payload, ['batchId', 'expectedBatchState', 'expectedBatchFingerprint'])
    return {
      batchId: parseUuid(p.batchId),
      expectedBatchState: parseNonEmptyString(p.expectedBatchState, 64),
      expectedBatchFingerprint: parseHex64(p.expectedBatchFingerprint),
    }
  },
  ops_retirement: (payload) => {
    const p = requireExactKeys(payload, ['recordId', 'expectedCalculationId', 'expectedCalculationVersion', 'reason', 'ticket'])
    return {
      recordId: parseUuid(p.recordId),
      expectedCalculationId: parseUuidOrNull(p.expectedCalculationId),
      expectedCalculationVersion: parseIntOrNull(p.expectedCalculationVersion, 1),
      reason: parseNonEmptyString(p.reason, 2000),
      ticket: parseNonEmptyString(p.ticket, 128),
    }
  },
})

const DIRECT_SOURCE_KIND: Readonly<Record<string, string>> = Object.freeze({
  live_punch: 'direct_live_punch',
  request_create: 'direct_request_create',
  request_pending_edit: 'direct_request_pending_edit',
  request_decision: 'direct_request_decision',
  request_cancel: 'direct_request_cancel',
  manual_edit: 'direct_manual_edit',
  recompute: 'direct_recompute',
  import_rollback: 'direct_import_rollback',
  ops_retirement: 'direct_ops_retirement',
})

// ---------------------------------------------------------------------------
// Envelope normalization.
// ---------------------------------------------------------------------------

export interface NormalizedAttendanceSourceCommandV1 {
  readonly kind: AttendanceSourceEntrypointV1
  readonly subjectUserId: string
  readonly operationId: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly commandFingerprint: string
}

export interface NormalizedAttendanceSourceOperationEnvelopeV1 {
  readonly schemaVersion: 1
  readonly orgId: string
  readonly correlationId: string
  readonly entrypoint: AttendanceSourceEntrypointV1
  readonly commands: readonly NormalizedAttendanceSourceCommandV1[]
  readonly batch: {
    readonly batchCommandId: string
    readonly items: readonly NormalizedAttendanceSourceCommandV1[]
    readonly batchPayload: Readonly<Record<string, unknown>>
    readonly commandFingerprint: string
  } | null
  /** Registry-shaped input for `attendanceResultOperationPreflightV1`. */
  readonly registryInput: AttendanceResultOperationEnvelopeInputV1
}

function fingerprintCommand(kind: string, subjectUserId: string, payload: Record<string, unknown>): string {
  // Identity position (operationId/batchCommandId) and correlationId are excluded;
  // the requested action/payload always participates (lock 4.1: reusing one
  // delivery ID for a different action conflicts via this fingerprint).
  return computeAttendanceCommandFingerprintV1({ kind, subjectUserId, payload })
}

function frozenCommand(
  kind: AttendanceSourceEntrypointV1,
  subjectUserId: string,
  operationId: string | null,
  payload: Record<string, unknown>,
): NormalizedAttendanceSourceCommandV1 {
  const frozenPayload = deepFreezeCopy(payload) as Readonly<Record<string, unknown>>
  return Object.freeze(
    Object.assign(Object.create(null), {
      kind,
      subjectUserId,
      operationId,
      payload: frozenPayload,
      commandFingerprint: fingerprintCommand(kind, subjectUserId, frozenPayload as Record<string, unknown>),
    }),
  ) as NormalizedAttendanceSourceCommandV1
}

function parseSingleCommand(input: unknown): {
  command: NormalizedAttendanceSourceCommandV1
  registry: AttendanceOperationCommandInputV1
} {
  const fields = requireExactKeys(input, ['schemaVersion', 'kind', 'subjectUserId', 'operationId', 'payload'])
  if (fields.schemaVersion !== 1) fail(INVALID)
  const kind = parseEnum(fields.kind, ATTENDANCE_SOURCE_ENTRYPOINTS_V1)
  if (kind === 'import_batch' || kind === 'integration_batch') fail(INVALID) // batch kinds use the batch envelope
  const subjectUserId = parseNonEmptyString(fields.subjectUserId, 128)
  const parser = PAYLOAD_PARSERS[kind]
  if (!parser) fail(INVALID)
  const payload = parser(fields.payload)

  if (kind === 'scheduled') {
    if (fields.operationId !== null) fail(INVALID) // scheduled identity is derived, never caller-supplied
    const command = frozenCommand(kind, subjectUserId, null, payload)
    return {
      command,
      registry: {
        source: {
          sourceKind: 'scheduled',
          scheduledRunId: payload.scheduledRunId,
          userId: payload.userId,
          workDate: payload.workDate,
        },
        commandFingerprint: command.commandFingerprint,
      },
    }
  }

  const operationId = parseUuidOrNull(fields.operationId)
  if (kind === 'request_decision' && payload.decisionChannel === 'verified_delivery') {
    // Verified channel action: the canonical delivery-ledger UUID IS the identity.
    if (operationId === null) fail(INVALID)
    const command = frozenCommand(kind, subjectUserId, operationId, payload)
    return {
      command,
      registry: {
        source: { sourceKind: 'verified_delivery', deliveryLedgerId: operationId },
        commandFingerprint: command.commandFingerprint,
      },
    }
  }

  const command = frozenCommand(kind, subjectUserId, operationId, payload)
  const sourceKind = DIRECT_SOURCE_KIND[kind]
  return {
    command,
    registry: {
      source: operationId === null ? null : { sourceKind, clientOperationId: operationId },
      commandFingerprint: command.commandFingerprint,
    },
  }
}

interface BatchParseResult {
  batchCommandId: string
  items: NormalizedAttendanceSourceCommandV1[]
  batchPayload: Record<string, unknown>
  commandFingerprint: string
  registryBatch: NonNullable<AttendanceResultOperationEnvelopeInputV1['batch']>
}

function parseBatchCommand(input: unknown): BatchParseResult {
  const fields = requireExactKeys(input, ['schemaVersion', 'kind', 'items', 'payload'])
  if (fields.schemaVersion !== 1) fail(INVALID)
  const kind = parseEnum(fields.kind, ['import_batch', 'integration_batch'] as const)
  const isImport = kind === 'import_batch'
  const batchFields = isImport
    ? requireExactKeys(fields.payload, ['batchCommandId', 'transportKind', 'batchFingerprint'])
    : requireExactKeys(fields.payload, ['syncRunId', 'integrationRef', 'sourceFingerprint'])
  const rootId = parseUuid(isImport ? batchFields.batchCommandId : batchFields.syncRunId)
  const batchPayload: Record<string, unknown> = isImport
    ? {
        transportKind: parseEnum(batchFields.transportKind, ATTENDANCE_IMPORT_TRANSPORT_KINDS_V1),
        batchFingerprint: parseHex64(batchFields.batchFingerprint),
      }
    : {
        integrationRef: parseNonEmptyString(batchFields.integrationRef, 256),
        sourceFingerprint: parseHex64(batchFields.sourceFingerprint),
      }

  if (!Array.isArray(fields.items) || fields.items.length === 0) fail(INVALID)
  const items: NormalizedAttendanceSourceCommandV1[] = []
  const registryItems: AttendanceOperationCommandInputV1[] = []
  fields.items.forEach((entry, index) => {
    const item = requireExactKeys(entry, ['ordinal', 'subjectUserId', 'semanticFingerprint', 'normalizedBusinessInput'])
    const ordinal = parseIntInRange(item.ordinal, 0)
    if (ordinal !== index) fail('W4C0_BATCH_ITEM_ORDINAL_MISMATCH') // amendment 1.3: ordinal === index
    const subjectUserId = parseNonEmptyString(item.subjectUserId, 128)
    const semanticFingerprint = parseHex64(item.semanticFingerprint)
    const business = item.normalizedBusinessInput
    if (business === null || typeof business !== 'object' || Array.isArray(business)) fail(INVALID)
    const payload: Record<string, unknown> = {
      ordinal,
      semanticFingerprint,
      normalizedBusinessInput: deepFreezeCopy(business),
    }
    const command = frozenCommand(kind, subjectUserId, null, payload)
    items.push(command)
    registryItems.push({
      source: isImport
        ? { sourceKind: 'import_item', batchCommandId: rootId, ordinal: String(ordinal), semanticFingerprint }
        : { sourceKind: 'integration_item', syncRunId: rootId, ordinal: String(ordinal), semanticFingerprint },
      commandFingerprint: command.commandFingerprint,
      normalizedBusinessInputSnapshot: payload.normalizedBusinessInput,
    })
  })

  const batchFingerprint = fingerprintCommand(kind, 'batch', batchPayload)
  return {
    batchCommandId: rootId,
    items,
    batchPayload: deepFreezeCopy(batchPayload) as Record<string, unknown>,
    commandFingerprint: batchFingerprint,
    registryBatch: {
      source: isImport ? { sourceKind: 'import_batch', batchCommandId: rootId } : { sourceKind: 'integration_batch', syncRunId: rootId },
      commandFingerprint: batchFingerprint,
      items: registryItems,
    },
  }
}

/**
 * Strict envelope parse + freeze + fingerprint. Exactly one of `command` /
 * `batch` must be present. The returned structure shares nothing with the
 * caller-owned input object.
 */
export function normalizeAttendanceSourceOperationEnvelopeV1(
  input: unknown,
): NormalizedAttendanceSourceOperationEnvelopeV1 {
  const fields = requireExactKeys(input, ['schemaVersion', 'orgId', 'correlationId', 'command', 'batch'])
  if (fields.schemaVersion !== 1) fail(INVALID)
  const orgId = parseCanonicalAttendanceOrgKeyV1(fields.orgId) as string
  const correlationId = parseNonEmptyString(fields.correlationId, 128)
  const hasCommand = fields.command !== null
  const hasBatch = fields.batch !== null
  if (hasCommand === hasBatch) fail(INVALID)

  if (hasCommand) {
    const { command, registry } = parseSingleCommand(fields.command)
    return Object.freeze(
      Object.assign(Object.create(null), {
        schemaVersion: 1 as const,
        orgId,
        correlationId,
        entrypoint: command.kind,
        commands: Object.freeze([command]),
        batch: null,
        registryInput: Object.freeze(
          Object.assign(Object.create(null), {
            orgId,
            entrypoint: command.kind,
            batch: null,
            commands: Object.freeze([registry]),
          }),
        ) as AttendanceResultOperationEnvelopeInputV1,
      }),
    ) as NormalizedAttendanceSourceOperationEnvelopeV1
  }

  const batch = parseBatchCommand(fields.batch)
  const entrypoint = (batch.registryBatch.source as { sourceKind: string }).sourceKind as AttendanceSourceEntrypointV1
  return Object.freeze(
    Object.assign(Object.create(null), {
      schemaVersion: 1 as const,
      orgId,
      correlationId,
      entrypoint,
      commands: Object.freeze([]),
      batch: Object.freeze(
        Object.assign(Object.create(null), {
          batchCommandId: batch.batchCommandId,
          items: Object.freeze(batch.items),
          batchPayload: batch.batchPayload,
          commandFingerprint: batch.commandFingerprint,
        }),
      ),
      registryInput: Object.freeze(
        Object.assign(Object.create(null), {
          orgId,
          entrypoint,
          batch: Object.freeze(batch.registryBatch),
          commands: Object.freeze([]),
        }),
      ) as AttendanceResultOperationEnvelopeInputV1,
    }),
  ) as NormalizedAttendanceSourceOperationEnvelopeV1
}
