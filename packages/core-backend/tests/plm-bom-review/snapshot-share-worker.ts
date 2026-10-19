/** Fresh-process idempotent publication retry; input is an owned synthetic fixture. */
import { readFileSync } from 'node:fs'
import type { Request } from 'express'
import { poolManager } from '../../src/integration/db/connection-pool'
import { PlmManagedSnapshotShareFlow } from '../../src/services/plm-managed-snapshot-share-flow'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'

async function main() {
  const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const req = { user: { id: data.actor }, authenticatedTenantId: data.tenant,
    headers: data.headers, body: data.body, get: (key: string) => data.headers[key.toLowerCase()] } as unknown as Request
  const flow = new PlmManagedSnapshotShareFlow({ pool: poolManager.get(),
    dataSourceManager: { getDataSource() { throw new Error('shared adapter must not be used') } } })
  try {
    const result = await managedRequestContext.run({ userId: data.actor, sessionId: data.session, conflict: false }, () => flow.complete(req))
    console.log(JSON.stringify(result))
  } finally { await poolManager.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
