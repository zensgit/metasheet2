/**
 * Provider notification descriptors: for a provider's transport, what kind of recipient identifier it
 * uses, which proof it can be derived from, how the identifier is protected against injection, and
 * which failures are certain non-delivery. A static, frozen table; the production entry point takes
 * only a provider name, and the lookup used by tests takes the registry explicitly.
 * 'local' and every provider that is not listed are intentionally absent.
 */
export type AddressKind = 'dingtalk_userid' | 'wecom_userid' | 'feishu_open_id'
export type ProofKind = 'directory_link' | 'external_identity'
export const PROOF_KINDS: readonly ProofKind[] = Object.freeze(['directory_link', 'external_identity'] as const)

/** Reserved entries of `forbiddenInAddress`: a class of characters instead of a literal substring. */
export const FORBID_WHITESPACE = '<whitespace>'
export const FORBID_CONTROL = '<control>'

export type DirectoryAccountColumn = 'external_user_id' | 'union_id' | 'open_id'

export type ProofRule =
  | {
      readonly from: 'directory_account'
      readonly column: DirectoryAccountColumn
      readonly issuerWitness?: 'connection_sync'
    }
  | { readonly from: 'identity_subject'; readonly subjectType: string }

export interface ProviderTransportDescriptor {
  /** Exactly equal to directory_integrations.provider. */
  readonly provider: string
  /** Name shown to people in connection labels. */
  readonly displayName: string
  readonly transport: string
  readonly addressKind: AddressKind
  /** null: the proof kind cannot be turned into an address for this transport. */
  readonly proofRules: Readonly<Record<ProofKind, ProofRule | null>>
  /** Scope in which the identifier is issued. */
  readonly idScope: 'tenant' | 'app' | 'developer'
  /** Literal substrings, plus the reserved class entries, that make an identifier unusable. */
  readonly forbiddenInAddress: readonly string[]
  readonly maxAddressLength: number
  /** Configuration keys the scope anchor is read from; the resolver loads only these. */
  readonly scopeConfigKeys: readonly string[]
  /** Fields of a provider's success response that say a recipient was not accepted. */
  readonly recipientLevelNonAcceptanceFields: readonly string[]
  readonly providerDedupe: 'none' | { readonly kind: 'duplicate_check_window' | 'request_uuid'; readonly windowMs: number }
  /** Whole codes that mean certain non-delivery. */
  readonly fallbackEligibleCodes: readonly string[]
}

const DINGTALK: ProviderTransportDescriptor = Object.freeze({
  provider: 'dingtalk',
  displayName: '钉钉',
  transport: 'work_notification',
  addressKind: 'dingtalk_userid',
  proofRules: Object.freeze({
    directory_link: Object.freeze({ from: 'directory_account', column: 'external_user_id' } as const),
    external_identity: null,
  }),
  idScope: 'tenant',
  forbiddenInAddress: Object.freeze([',', FORBID_WHITESPACE, FORBID_CONTROL]),
  maxAddressLength: 128,
  scopeConfigKeys: Object.freeze(['appKey']),
  recipientLevelNonAcceptanceFields: Object.freeze([]),
  providerDedupe: 'none',
  fallbackEligibleCodes: Object.freeze([]),
})

const PRODUCTION_REGISTRY: readonly ProviderTransportDescriptor[] = Object.freeze([DINGTALK])

export function productionProviderNotificationRegistry(): readonly ProviderTransportDescriptor[] {
  return PRODUCTION_REGISTRY
}

/** Production entry point: bound to the production registry, accepts no registry argument. */
export function resolveProviderNotificationDescriptor(provider: string): ProviderTransportDescriptor | null {
  return lookupProviderNotificationDescriptor(PRODUCTION_REGISTRY, provider)
}

/** Lookup against an explicit registry. */
export function lookupProviderNotificationDescriptor(
  registry: readonly ProviderTransportDescriptor[],
  provider: string,
): ProviderTransportDescriptor | null {
  for (const descriptor of registry) {
    if (descriptor.provider === provider) return descriptor
  }
  return null
}

/**
 * Throws for a duplicate provider (a repeated identical object is ignored), and for an application-scoped
 * identifier read from the directory without an issuer witness: such a column can be filled by a login
 * through a different application, so it proves nothing about the connection's own application.
 */
export function assertProviderNotificationRegistryWellFormed(registry: readonly ProviderTransportDescriptor[]): void {
  const seen = new Map<string, ProviderTransportDescriptor>()
  for (const descriptor of registry) {
    const previous = seen.get(descriptor.provider)
    if (previous !== undefined) {
      if (previous === descriptor) continue
      throw new Error('provider notification registry: duplicate provider entry')
    }
    seen.set(descriptor.provider, descriptor)
    if (descriptor.idScope === 'app') {
      for (const kind of PROOF_KINDS) {
        const rule = descriptor.proofRules[kind]
        if (rule !== null && rule.from === 'directory_account' && rule.issuerWitness === undefined) {
          throw new Error('provider notification registry: application-scoped identifier without issuer witness')
        }
      }
    }
  }
}

assertProviderNotificationRegistryWellFormed(PRODUCTION_REGISTRY)

/** Label of a connection as shown to a person: provider name and integration name, never an identifier. */
export function connectionLabel(provider: string, integrationName: string): string {
  const display = resolveProviderNotificationDescriptor(provider)?.displayName ?? provider
  return `${display} · ${integrationName}`
}
