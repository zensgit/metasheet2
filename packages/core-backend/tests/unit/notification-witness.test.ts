import { describe, expect, it } from 'vitest'
import {
  WITNESS_DOMAINS,
  WITNESS_SHAPE,
  addressWitness,
  canonicalJson,
  directoryLinkProofWitness,
  externalIdentityProofWitness,
  sha256Hex,
  tenantAddressWitness,
  type DirectoryLinkProofState,
  type ExternalIdentityProofState,
} from '../../src/notifications/witness'

const directory: DirectoryLinkProofState = {
  proofId: 'p1',
  localUserId: 'u1',
  accountId: 'a1',
  connectionId: 'c1',
  orgId: 'org',
  linkStatus: 'linked',
  accountActive: true,
  accountProvider: 'dingtalk',
  accountCorpId: 'CorpOne',
  accountUnionId: null,
}

const identity: ExternalIdentityProofState = {
  identityId: 'i1',
  localUserId: 'u1',
  connectionId: 'c1',
  bindingRevision: 3,
  subjectType: 'userid',
  establishedBy: 'self_authenticated',
  verified: true,
  revoked: false,
}

describe('canonical JSON', () => {
  it('sorts keys at every depth and ignores insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('writes no whitespace and keeps array order', () => {
    expect(canonicalJson([2, 1, 'x y'])).toBe('[2,1,"x y"]')
  })

  it('rejects values that have no canonical form', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow()
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => canonicalJson(() => 1)).toThrow()
  })
})

describe('witness digests', () => {
  it('are 64 lower-case hexadecimal characters', () => {
    for (const value of [
      directoryLinkProofWitness(directory),
      externalIdentityProofWitness(identity),
      addressWitness({ connectionId: 'c1', addressKind: 'dingtalk_userid', address: 'x' }),
      tenantAddressWitness({ provider: 'dingtalk', boundTenant: 'T', addressKind: 'dingtalk_userid', address: 'x' }),
    ]) {
      expect(value).toMatch(WITNESS_SHAPE)
    }
  })

  it('differ across domains for the same payload', () => {
    const payload = { a: 1 }
    const digests = Object.values(WITNESS_DOMAINS).map((domain) => sha256Hex(domain, payload))
    expect(new Set(digests).size).toBe(digests.length)
  })

  it('change with any single input of a directory proof, including a union id going from null to a value', () => {
    const base = directoryLinkProofWitness(directory)
    const variants: Array<Partial<DirectoryLinkProofState>> = [
      { proofId: 'p2' },
      { localUserId: 'u2' },
      { accountId: 'a2' },
      { connectionId: 'c2' },
      { orgId: 'other' },
      { linkStatus: 'pending' },
      { accountActive: false },
      { accountProvider: 'wecom' },
      { accountCorpId: 'CorpTwo' },
      { accountCorpId: null },
      { accountUnionId: 'union-1' },
    ]
    for (const variant of variants) {
      expect(directoryLinkProofWitness({ ...directory, ...variant }), JSON.stringify(variant)).not.toBe(base)
    }
    expect(directoryLinkProofWitness({ ...directory, accountUnionId: null })).toBe(base)
  })

  it('change with any single input of an identity proof', () => {
    const base = externalIdentityProofWitness(identity)
    const variants: Array<Partial<ExternalIdentityProofState>> = [
      { identityId: 'i2' },
      { localUserId: 'u2' },
      { connectionId: 'c2' },
      { bindingRevision: 4 },
      { subjectType: 'open_id' },
      { establishedBy: 'association' },
      { verified: false },
      { revoked: true },
    ]
    for (const variant of variants) {
      expect(externalIdentityProofWitness({ ...identity, ...variant }), JSON.stringify(variant)).not.toBe(base)
    }
  })

  it('the address digest depends on the connection and the tenant digest does not', () => {
    const one = { addressKind: 'dingtalk_userid', address: 'same' }
    expect(addressWitness({ connectionId: 'c1', ...one })).not.toBe(addressWitness({ connectionId: 'c2', ...one }))
    const tenant = { provider: 'dingtalk', boundTenant: 'T', ...one }
    expect(tenantAddressWitness(tenant)).toBe(tenantAddressWitness({ ...tenant }))
    expect(tenantAddressWitness(tenant)).not.toBe(tenantAddressWitness({ ...tenant, boundTenant: 'U' }))
    expect(tenantAddressWitness(tenant)).not.toBe(tenantAddressWitness({ ...tenant, provider: 'wecom' }))
    expect(tenantAddressWitness(tenant)).not.toBe(tenantAddressWitness({ ...tenant, address: 'other' }))
  })

  it('never contain the address or any input in clear', () => {
    const digest = addressWitness({ connectionId: 'connection-xyz', addressKind: 'dingtalk_userid', address: 'person-address' })
    expect(digest).not.toContain('person')
    expect(digest).not.toContain('connection')
  })
})
