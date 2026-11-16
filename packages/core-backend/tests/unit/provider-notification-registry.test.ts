import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FORBID_CONTROL,
  FORBID_WHITESPACE,
  assertProviderNotificationRegistryWellFormed,
  connectionLabel,
  lookupProviderNotificationDescriptor,
  productionProviderNotificationRegistry,
  resolveProviderNotificationDescriptor,
  type ProviderTransportDescriptor,
} from '../../src/notifications/provider-notification-registry'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'

const SOURCE = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'notifications', 'provider-notification-registry.ts'), 'utf8')

const base = (over: Partial<ProviderTransportDescriptor>): ProviderTransportDescriptor => ({
  provider: 'sample',
  displayName: 'Sample',
  transport: 'message',
  addressKind: 'wecom_userid',
  proofRules: { directory_link: { from: 'directory_account', column: 'external_user_id' }, external_identity: null },
  idScope: 'tenant',
  forbiddenInAddress: [],
  maxAddressLength: 64,
  scopeConfigKeys: [],
  recipientLevelNonAcceptanceFields: [],
  providerDedupe: 'none',
  fallbackEligibleCodes: [],
  ...over,
})

describe('production provider notification registry', () => {
  it('is exactly the DingTalk work notification row, every column pinned', () => {
    expect(productionProviderNotificationRegistry()).toEqual([
      {
        provider: 'dingtalk',
        displayName: '钉钉',
        transport: 'work_notification',
        addressKind: 'dingtalk_userid',
        proofRules: { directory_link: { from: 'directory_account', column: 'external_user_id' }, external_identity: null },
        idScope: 'tenant',
        forbiddenInAddress: [',', FORBID_WHITESPACE, FORBID_CONTROL],
        maxAddressLength: 128,
        scopeConfigKeys: ['appKey'],
        recipientLevelNonAcceptanceFields: [],
        providerDedupe: 'none',
        fallbackEligibleCodes: [],
      },
    ])
  })

  it('answers null for the local provider and for any unknown provider', () => {
    for (const provider of ['local', 'wecom', 'feishu', '', 'DingTalk', 'constructor']) {
      expect(resolveProviderNotificationDescriptor(provider), provider).toBeNull()
    }
    expect(resolveProviderNotificationDescriptor('dingtalk')?.provider).toBe('dingtalk')
  })

  it('is frozen, entry by entry', () => {
    expect(Object.isFrozen(productionProviderNotificationRegistry())).toBe(true)
    const [dingtalk] = productionProviderNotificationRegistry()
    expect(Object.isFrozen(dingtalk)).toBe(true)
    expect(Object.isFrozen(dingtalk.proofRules)).toBe(true)
    expect(Object.isFrozen(dingtalk.forbiddenInAddress)).toBe(true)
    expect(Object.isFrozen(dingtalk.scopeConfigKeys)).toBe(true)
  })

  it('the configuration keys it declares give the same scope as the whole configuration', () => {
    const [dingtalk] = productionProviderNotificationRegistry()
    const capability = resolveProviderCapabilityDescriptor('dingtalk')!
    const full = { appKey: ' AppOne ', appSecret: 'secret', baseUrl: 'https://example.invalid', other: [1, 2] }
    const projected = Object.fromEntries(Object.entries(full).filter(([key]) => dingtalk.scopeConfigKeys.includes(key)))
    expect(capability.scopeOf({ corp_id: 'CorpOne', config: projected })).toEqual(capability.scopeOf({ corp_id: 'CorpOne', config: full }))
    expect(capability.scopeOf({ corp_id: 'CorpOne', config: projected })).toEqual({ tenant: 'CorpOne', appScope: 'AppOne' })
  })

  it('has no way to replace an entry outside a test', () => {
    expect(SOURCE).not.toMatch(/replace|ForTests/)
  })

  it('labels a connection with the provider name and the integration name', () => {
    expect(connectionLabel('dingtalk', 'HQ')).toBe('钉钉 · HQ')
    expect(connectionLabel('unlisted', 'HQ')).toBe('unlisted · HQ')
  })
})

describe('registry shape checks', () => {
  it('ignores the same object registered twice and rejects a different object for the same provider', () => {
    const entry = base({})
    expect(() => assertProviderNotificationRegistryWellFormed([entry, entry])).not.toThrow()
    expect(() => assertProviderNotificationRegistryWellFormed([entry, base({})])).toThrow(/duplicate provider/)
  })

  it('refuses an application-scoped identifier read from the directory without an issuer witness', () => {
    const rule = { from: 'directory_account', column: 'open_id' } as const
    expect(() => assertProviderNotificationRegistryWellFormed([base({ idScope: 'app', proofRules: { directory_link: rule, external_identity: null } })])).toThrow(
      /issuer witness/,
    )
    expect(() =>
      assertProviderNotificationRegistryWellFormed([
        base({ idScope: 'app', proofRules: { directory_link: { ...rule, issuerWitness: 'connection_sync' }, external_identity: null } }),
      ]),
    ).not.toThrow()
    expect(() =>
      assertProviderNotificationRegistryWellFormed([
        base({ idScope: 'app', proofRules: { directory_link: null, external_identity: { from: 'identity_subject', subjectType: 'open_id' } } }),
      ]),
    ).not.toThrow()
  })

  it('looks up in an explicit registry', () => {
    const entry = base({})
    expect(lookupProviderNotificationDescriptor([entry], 'sample')).toBe(entry)
    expect(lookupProviderNotificationDescriptor([entry], 'other')).toBeNull()
  })
})
