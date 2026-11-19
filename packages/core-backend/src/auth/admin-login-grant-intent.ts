import { createHash } from 'node:crypto'

export type AdminGrantPurpose = 'admin_login_grant_enable'

export type AdminGrantTargetPin = Readonly<{
  userId: string
  identityId: string
  bindingRevision: string
  evidenceId: string
  evidenceWitness: string
  accessGeneration: string
  privilegeWitness: string
}>

export type AdminGrantIntent = Readonly<{
  purpose: AdminGrantPurpose
  commandId: string
  actorId: string
  orgId: string
  provider: 'dingtalk'
  connectionId: string
  applicationRevision: string
  targets: readonly AdminGrantTargetPin[]
}>

export const ADMIN_GRANT_PURPOSE_REGISTRY = Object.freeze({
  admin_login_grant_enable: Object.freeze({
    targetKind: 'confirmed_identity_set',
    actorMethod: 'local_password',
    targetClass: 'standard',
    productionAvailable: false,
  }),
})

export const ADMIN_GRANT_INTENT_HASH_DOMAIN = 'metasheet:admin-login-grant-intent:v1|'

const INTENT_FIELDS = [
  'purpose', 'commandId', 'actorId', 'orgId', 'provider',
  'connectionId', 'applicationRevision', 'targets',
] as const
const TARGET_FIELDS = [
  'userId', 'identityId', 'bindingRevision', 'evidenceId',
  'evidenceWitness', 'accessGeneration', 'privilegeWitness',
] as const
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\s\S])/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?![\s\S])/
const PRIVILEGE_WITNESS_PATTERN = /^[0-9a-f]{64}(?![\s\S])/
const PG_BIGINT_MAX = '9223372036854775807'

export class AdminGrantIntentError extends Error {
  readonly code = 'ADMIN_LOGIN_GRANT_INTENT_INVALID'

  constructor() {
    super('Invalid admin login grant intent')
    this.name = 'AdminGrantIntentError'
  }
}

function refuse(): never {
  throw new AdminGrantIntentError()
}

function closedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== fields.length) refuse()
  return Object.fromEntries(fields.map((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, field)?.value as PropertyDescriptor | undefined
    if (!descriptor || !('value' in descriptor)) refuse()
    return [field, descriptor.value]
  }))
}

function opaqueString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) refuse()
  return value
}

function uuidString(value: unknown): string {
  const uuid = opaqueString(value)
  if (!UUID_PATTERN.test(uuid)) refuse()
  return uuid.toLowerCase()
}

function decimalString(value: unknown, bounded = false): string {
  const decimal = opaqueString(value)
  if (!DECIMAL_PATTERN.test(decimal)) refuse()
  if (bounded && (decimal.length > PG_BIGINT_MAX.length
    || (decimal.length === PG_BIGINT_MAX.length && decimal > PG_BIGINT_MAX))) refuse()
  return decimal
}

function targetPin(value: unknown): AdminGrantTargetPin {
  const target = closedRecord(value, TARGET_FIELDS)
  const privilegeWitness = opaqueString(target.privilegeWitness)
  if (!PRIVILEGE_WITNESS_PATTERN.test(privilegeWitness)) refuse()
  return Object.freeze({
    userId: opaqueString(target.userId),
    identityId: uuidString(target.identityId),
    bindingRevision: decimalString(target.bindingRevision, true),
    evidenceId: opaqueString(target.evidenceId),
    evidenceWitness: opaqueString(target.evidenceWitness),
    accessGeneration: decimalString(target.accessGeneration, true),
    privilegeWitness,
  })
}

function targetPins(value: unknown, actorId: string): readonly AdminGrantTargetPin[] {
  if (!Array.isArray(value) || ![Array.prototype, null].includes(Object.getPrototypeOf(value))) refuse()
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  const length: unknown = descriptors.length?.value
  if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0
    || Reflect.ownKeys(descriptors).length !== length + 1) refuse()
  const targets: AdminGrantTargetPin[] = []
  const userIds = new Set<string>()
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor)) refuse()
    const target = targetPin(descriptor.value)
    if (target.userId === actorId || userIds.has(target.userId)) refuse()
    userIds.add(target.userId)
    targets.push(target)
  }
  targets.sort((first, second) => first.userId < second.userId ? -1 : first.userId > second.userId ? 1 : 0)
  return Object.freeze(targets)
}

export function normalizeAdminGrantIntent(value: unknown): AdminGrantIntent {
  try {
    const intent = closedRecord(value, INTENT_FIELDS)
    if (intent.purpose !== 'admin_login_grant_enable' || intent.provider !== 'dingtalk') refuse()
    const actorId = opaqueString(intent.actorId)
    return Object.freeze({
      purpose: 'admin_login_grant_enable',
      commandId: opaqueString(intent.commandId),
      actorId,
      orgId: opaqueString(intent.orgId),
      provider: 'dingtalk',
      connectionId: uuidString(intent.connectionId),
      applicationRevision: decimalString(intent.applicationRevision),
      targets: targetPins(intent.targets, actorId),
    })
  } catch {
    throw new AdminGrantIntentError()
  }
}

export function encodeAdminGrantIntent(value: unknown): string {
  const intent = normalizeAdminGrantIntent(value)
  return JSON.stringify({
    purpose: intent.purpose,
    commandId: intent.commandId,
    actorId: intent.actorId,
    orgId: intent.orgId,
    provider: intent.provider,
    connectionId: intent.connectionId,
    applicationRevision: intent.applicationRevision,
    targetCount: intent.targets.length,
    targets: intent.targets,
  })
}

export function hashAdminGrantIntent(value: unknown): string {
  return createHash('sha256')
    .update(ADMIN_GRANT_INTENT_HASH_DOMAIN, 'utf8')
    .update(encodeAdminGrantIntent(value), 'utf8')
    .digest('hex')
}
