import { databaseConnectionConfig } from '../integration/db/connection-config'
import { SecurityEventRepository, CANDIDATE_RETENTION } from './repository'
import { EventConnections, W1Capacity } from './runtime'
import { EventRetryBuffer } from './retry-buffer'

export const eventRetries = new EventRetryBuffer()
let repository: Promise<SecurityEventRepository> | undefined

/** All producers share one process budget, retention policy and repository boot identity. */
export function eventRepository(): Promise<SecurityEventRepository> {
  repository ??= import('../security/SecretManager').then(({ secretManager }) => {
    const { connectionString, ssl, max } = databaseConnectionConfig(secretManager)
    // Match the pool driver's effective maximum for zero or nonnumeric configuration.
    return new SecurityEventRepository(new EventConnections({ connectionString, ssl }), new W1Capacity(max || 10), CANDIDATE_RETENTION)
  }).catch(error => { repository = undefined; throw error })
  return repository
}
