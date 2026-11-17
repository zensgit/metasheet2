import { createInterface } from 'node:readline'
import { listUserPermissions } from '../../src/rbac/service'
import { poolManager } from '../../src/integration/db/connection-pool'

async function main(): Promise<void> {
  const userId = process.env.PERMISSION_COMMAND_PROBE_USER
  if (!userId) throw new Error('synthetic probe identity required')
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (line === 'read') {
      const codes = await listUserPermissions(userId)
      process.stdout.write(`PERMISSION_PROBE ${JSON.stringify(codes)}\n`)
    } else if (line === 'quit') break
  }
  await poolManager.close()
}
void main().catch(() => { process.stderr.write('synthetic permission probe failed\n'); process.exitCode = 1 })
