/**
 * Witnesses and address normalization.
 *
 * A witness is the SHA-256 of a domain label and the canonical JSON of a payload. The endpoint row
 * stores the witnesses taken when the endpoint was made or refreshed; a later re-derivation is compared
 * with them. Address and tenant-address witnesses are equality oracles for anyone who holds a candidate
 * identifier, so they are compared on the server only and never appear in a response, a log or an
 * audit record.
 */
import { createHash } from 'node:crypto'
import {
  FORBID_CONTROL,
  FORBID_WHITESPACE,
  type AddressKind,
  type ProviderTransportDescriptor,
} from './provider-notification-registry'

export const WITNESS_DOMAINS = Object.freeze({
  proof: 'mx.notif.proof.v1',
  address: 'mx.notif.addr.v1',
  tenantAddress: 'mx.notif.addr.tenant.v1',
  eventKey: 'mx.notif.key.v1',
} as const)

export const WITNESS_SHAPE = /^[0-9a-f]{64}$/

/** Canonical JSON: object keys sorted, no whitespace; arrays keep their order. Rejects undefined and non-finite numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
      const record = value as Record<string, unknown>
      const parts = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      return `{${parts.join(',')}}`
    }
    default:
      throw new TypeError('canonicalJson: unsupported value')
  }
}

export function sha256Hex(domain: string, payload: unknown): string {
  return createHash('sha256').update(`${domain}\n${canonicalJson(payload)}`, 'utf8').digest('hex')
}

export interface DirectoryLinkProofState {
  proofId: string
  localUserId: string
  accountId: string
  connectionId: string
  orgId: string
  linkStatus: string
  accountActive: boolean
  accountProvider: string
  accountCorpId: string | null
  /** Part of the digest even when null: a change of union id can mean the identifier now belongs to someone else. */
  accountUnionId: string | null
}

export function directoryLinkProofWitness(state: DirectoryLinkProofState): string {
  return sha256Hex(WITNESS_DOMAINS.proof, {
    kind: 'directory_link',
    proofId: state.proofId,
    localUserId: state.localUserId,
    accountId: state.accountId,
    connectionId: state.connectionId,
    orgId: state.orgId,
    linkStatus: state.linkStatus,
    accountActive: state.accountActive,
    accountProvider: state.accountProvider,
    accountCorpId: state.accountCorpId,
    accountUnionId: state.accountUnionId,
  })
}

export interface ExternalIdentityProofState {
  identityId: string
  localUserId: string
  connectionId: string
  bindingRevision: number
  subjectType: string
  establishedBy: string
  verified: boolean
  revoked: boolean
}

export function externalIdentityProofWitness(state: ExternalIdentityProofState): string {
  return sha256Hex(WITNESS_DOMAINS.proof, {
    kind: 'external_identity',
    identityId: state.identityId,
    localUserId: state.localUserId,
    connectionId: state.connectionId,
    bindingRevision: state.bindingRevision,
    subjectType: state.subjectType,
    establishedBy: state.establishedBy,
    verified: state.verified,
    revoked: state.revoked,
  })
}

export function addressWitness(input: { connectionId: string; addressKind: AddressKind | string; address: string }): string {
  return sha256Hex(WITNESS_DOMAINS.address, {
    connectionId: input.connectionId,
    addressKind: input.addressKind,
    address: input.address,
  })
}

export function tenantAddressWitness(input: {
  provider: string
  boundTenant: string
  addressKind: AddressKind | string
  address: string
}): string {
  return sha256Hex(WITNESS_DOMAINS.tenantAddress, {
    provider: input.provider,
    boundTenant: input.boundTenant,
    addressKind: input.addressKind,
    address: input.address,
  })
}

export type NormalizedAddress =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly code: 'address_missing' | 'address_unusable' }

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
const WHITESPACE_CHARACTER = /\s/u

/**
 * One recipient per provider call: a value that could name several recipients (a separator, a
 * broadcast keyword, whitespace, a control character) or is too long is not an address. Surrounding
 * whitespace is removed; the rest is kept as is (no case change).
 */
export function normalizeAddress(
  descriptor: Pick<ProviderTransportDescriptor, 'forbiddenInAddress' | 'maxAddressLength'>,
  raw: unknown,
): NormalizedAddress {
  if (typeof raw !== 'string') return { ok: false, code: 'address_missing' }
  const address = raw.trim()
  if (address === '') return { ok: false, code: 'address_missing' }
  if (address.length > descriptor.maxAddressLength) return { ok: false, code: 'address_unusable' }
  for (const forbidden of descriptor.forbiddenInAddress) {
    if (forbidden === FORBID_CONTROL) {
      if (CONTROL_CHARACTER.test(address)) return { ok: false, code: 'address_unusable' }
    } else if (forbidden === FORBID_WHITESPACE) {
      if (WHITESPACE_CHARACTER.test(address)) return { ok: false, code: 'address_unusable' }
    } else if (forbidden !== '' && address.includes(forbidden)) {
      return { ok: false, code: 'address_unusable' }
    }
  }
  return { ok: true, address }
}
