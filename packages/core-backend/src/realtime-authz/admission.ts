/**
 * The realtime admission table, as a pure function.
 *
 * Inputs are facts only: the two local switches read byte-exactly, the two installation generations
 * read from the authoritative database, and the state of the invalidation listener of this instance. The
 * output says how this instance treats an ordinary handshake, a strict handshake and the connections
 * it already holds.
 *
 * Precedence, highest first:
 *   1. an installation generation that cannot be decided, or revalidation ON without a ready
 *      listener: established protected traffic is suspended until a later read succeeds. With
 *      revalidation ON a protected handshake is refused. With revalidation OFF it is held: the
 *      connection is kept and served nothing, and it is admitted by the row a later read decides;
 *   2. revalidation OFF while the database carries a committed login scope or any enablement
 *      purpose: protected handshakes are refused and established protected connections end;
 *   3. revalidation OFF, both generations decidable, no scope and no enablement purpose: baseline;
 *   4. revalidation ON and ready: every boundary is re-checked; a strict handshake is admitted only
 *      when a committed login scope exists.
 *
 * A configuration conflict by itself (the credential-chain switch ON locally while the environment
 * is certainly not enabled for it, or a switch set to a value that only resembles 'true') never
 * changes a policy. It is reported as a notice for the authenticated administrator diagnostics.
 */
import type { ExactSwitchReading } from './revalidation-flag'
import type { RealtimeInstallationFacts } from './installation-probe'

export type ListenerState = 'not-started' | 'ready' | 'not-ready'

export interface AdmissionInput {
  readonly revalidation: ExactSwitchReading
  readonly credentialChain: ExactSwitchReading
  readonly facts: RealtimeInstallationFacts
  readonly listener: ListenerState
}

export type AdmissionRow =
  | 'undetermined'
  | 'off-enabled-environment'
  | 'off-baseline'
  | 'on-without-scope'
  | 'on-with-scope'

/**
 * `hold`: the connection is neither refused nor served. It waits, connected and unserved, for the
 * next decision; nothing about its credential is concluded meanwhile.
 */
export type HandshakePolicy = 'baseline' | 'revalidate' | 'refuse' | 'hold'
export type EstablishedPolicy = 'baseline' | 'revalidate' | 'suspend' | 'terminate'

export type AdmissionNotice =
  | 'INSTALLATION_UNDETERMINED'
  | 'LISTENER_NOT_READY'
  | 'REVALIDATION_OFF_IN_ENABLED_ENVIRONMENT'
  | 'CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED'
  | 'REVALIDATION_SWITCH_RESEMBLES_TRUE'
  | 'CREDENTIAL_CHAIN_SWITCH_RESEMBLES_TRUE'
  | 'ENABLEMENT_RECORD_NOT_READABLE_BY_THIS_BUILD'

export interface AdmissionDecision {
  readonly row: AdmissionRow
  readonly ordinaryHandshake: HandshakePolicy
  readonly strictHandshake: HandshakePolicy
  readonly established: EstablishedPolicy
  /** Whether this instance must hold its dedicated listening connection. */
  readonly listenerRequired: boolean
  readonly notices: readonly AdmissionNotice[]
}

function configurationNotices(input: AdmissionInput): AdmissionNotice[] {
  const notices: AdmissionNotice[] = []
  const { facts } = input
  if (input.revalidation === 'near-true') notices.push('REVALIDATION_SWITCH_RESEMBLES_TRUE')
  if (input.credentialChain === 'near-true') notices.push('CREDENTIAL_CHAIN_SWITCH_RESEMBLES_TRUE')
  if (facts.enablement.state === 'never-installed' && !facts.enablement.definedInThisBuild) {
    notices.push('ENABLEMENT_RECORD_NOT_READABLE_BY_THIS_BUILD')
  }
  const chainEnabled = facts.enablement.state === 'installed' && facts.enablement.purposes.includes('credential-chain')
  if (input.credentialChain === 'on' && facts.enablement.state !== 'unknown' && !chainEnabled) {
    notices.push('CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED')
  }
  return notices
}

export function decideRealtimeAdmission(input: AdmissionInput): AdmissionDecision {
  const { facts } = input
  const revalidationOn = input.revalidation === 'on'
  const notices = configurationNotices(input)

  if (facts.strictScope.state === 'unknown' || facts.enablement.state === 'unknown') {
    // Revalidation OFF: an instance that would run the baseline once the read answers does not
    // turn new connections away for one read that did not answer; it holds them unserved.
    const handshake: HandshakePolicy = revalidationOn ? 'refuse' : 'hold'
    return Object.freeze({
      row: 'undetermined',
      ordinaryHandshake: handshake,
      strictHandshake: handshake,
      established: 'suspend',
      listenerRequired: revalidationOn,
      notices: Object.freeze(['INSTALLATION_UNDETERMINED', ...notices] as AdmissionNotice[]),
    })
  }

  const hasScope = facts.strictScope.state === 'installed' && facts.strictScope.hasScope
  const hasEnablement = facts.enablement.state === 'installed' && facts.enablement.purposes.length > 0

  if (!revalidationOn) {
    if (hasScope || hasEnablement) {
      return Object.freeze({
        row: 'off-enabled-environment',
        ordinaryHandshake: 'refuse',
        strictHandshake: 'refuse',
        established: 'terminate',
        listenerRequired: false,
        notices: Object.freeze(['REVALIDATION_OFF_IN_ENABLED_ENVIRONMENT', ...notices] as AdmissionNotice[]),
      })
    }
    return Object.freeze({
      row: 'off-baseline',
      ordinaryHandshake: 'baseline',
      strictHandshake: 'baseline',
      established: 'baseline',
      listenerRequired: false,
      notices: Object.freeze(notices),
    })
  }

  if (input.listener !== 'ready') {
    return Object.freeze({
      row: 'undetermined',
      ordinaryHandshake: 'refuse',
      strictHandshake: 'refuse',
      established: 'suspend',
      listenerRequired: true,
      notices: Object.freeze(['LISTENER_NOT_READY', ...notices] as AdmissionNotice[]),
    })
  }

  return Object.freeze({
    row: hasScope ? 'on-with-scope' : 'on-without-scope',
    ordinaryHandshake: 'revalidate',
    strictHandshake: hasScope ? 'revalidate' : 'refuse',
    established: 'revalidate',
    listenerRequired: true,
    notices: Object.freeze(notices),
  })
}

/** The decision an instance holds before its first successful read: nothing protected is served. */
export const ADMISSION_BEFORE_FIRST_READ: AdmissionDecision = Object.freeze({
  row: 'undetermined',
  ordinaryHandshake: 'refuse',
  strictHandshake: 'refuse',
  established: 'suspend',
  listenerRequired: false,
  notices: Object.freeze(['INSTALLATION_UNDETERMINED'] as AdmissionNotice[]),
})
