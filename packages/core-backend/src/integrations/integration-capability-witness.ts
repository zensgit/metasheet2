/** Pure witness encoding shared by the approved capability entry points; it grants no authority. */
import { createHash } from 'node:crypto'
import type { IntegrationCapability, IntegrationScope } from './provider-capability-registry'

/** PostgreSQL and application shape of the SHA-256 hexadecimal witness. */
export const CAPABILITY_WITNESS_SHAPE = '^[0-9a-f]{64}$'

/** The version string that opens every witness encoding. */
const CAPABILITY_WITNESS_VERSION = 'metasheet.directory-integration-capability-witness.v1'

/** The fields a witness covers, in encoding order after the version string. */
export interface CapabilityWitnessFields {
  /** Organization source marker fixed by the authoritative entry point. */
  orgSource: string
  integrationId: string
  orgId: string
  provider: string
  status: string
  capability: IntegrationCapability
  revision: number
  anchor: IntegrationScope
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([length, bytes])
}

/**
 * Domain-separated SHA-256 (lowercase hex) over the length-prefixed UTF-8 encoding of the version
 * string and each field. Server side only: it is never sent to a browser.
 */
export function computeIntegrationCapabilityWitness(fields: CapabilityWitnessFields): string {
  const parts = [
    CAPABILITY_WITNESS_VERSION,
    fields.orgSource,
    fields.integrationId,
    fields.orgId,
    fields.provider,
    fields.status,
    fields.capability,
    String(fields.revision),
    fields.anchor.tenant,
    fields.anchor.appScope,
  ]
  const hash = createHash('sha256')
  for (const part of parts) hash.update(lengthPrefixed(part))
  return hash.digest('hex')
}
