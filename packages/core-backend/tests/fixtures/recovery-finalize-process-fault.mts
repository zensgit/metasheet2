import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import type { FinalizeProcessInput } from '../utils/recovery-finalize-process-faults'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
const require = createRequire(import.meta.url)
let pool: Pool | undefined
let closeRuntime: (() => Promise<void>) | undefined
let macKey: Buffer | undefined
try {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.ok(process.env.DATABASE_URL && process.env.DATABASE_URL === process.env.TEST_DATABASE_URL)
  const [input] = await once(process, 'message') as [FinalizeProcessInput]
  const { createRecoveryArchiveManualFinalization, createRecoveryArchiveManualCommand } = require('../../src/routes/univer-meta.ts') as typeof import('../../src/routes/univer-meta')
  const { poolManager } = require('../../src/integration/db/connection-pool.ts') as typeof import('../../src/integration/db/connection-pool')
  const { messageBus } = require('../../src/integration/messaging/message-bus.ts') as typeof import('../../src/integration/messaging/message-bus')
  closeRuntime = async () => { await messageBus.shutdown(); await poolManager.close() }
  const { createRecoveryArchiveFileStoreProvider } = require('../../src/multitable/recovery-archive-file-store.ts') as typeof import('../../src/multitable/recovery-archive-file-store')
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  macKey = Buffer.from(input.macKey, 'base64')
  let depth = 0, macCalls = 0, custodyCalls = 0, providerCalls = 0, sourceReads = 0
  const barrier = async (stage: string, backendPid: number, leaseLive?: boolean) => {
    process.send!({ stage, backendPid, pid: process.pid, depth, macCalls, leaseLive })
    const [message] = await once(process, 'message')
    assert.equal(message, 'commit')
  }
  const transaction = async <T,>(work: (query: SealQuery) => Promise<T>) => {
    const client = await pool!.connect()
    let published = false
    try {
      await client.query('BEGIN'); depth++
      const backendPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      const result = await work(async (statement, params) => {
        if (statement.includes('AS attachment_candidates')) sourceReads++
        const value = await client.query(statement, params)
        if (statement.startsWith("UPDATE meta_recovery_archives SET state='verified'")) {
          assert.equal(value.rows.length, 1); assert.equal(macCalls, 1)
          published = true
          await barrier('cas-before-commit', backendPid)
        }
        return value
      })
      await client.query('COMMIT'); depth--
      if (published) {
        const leaseLive = (await client.query('SELECT lease_expires_at>clock_timestamp() AS live FROM meta_recovery_archives WHERE generation_id=$1::uuid', [input.owner.generationId])).rows[0].live
        assert.equal(leaseLive, true, 'COMMITTED_LEASE_MUST_STILL_BE_LIVE')
        await barrier('committed-before-response', backendPid, leaseLive)
      }
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { depth = 0; client.release() }
  }
  const forbiddenCustody = async (): Promise<never> => { custodyCalls++; throw new Error('UNEXPECTED_RECAPTURE') }
  const custody = { produceGenerationDek: forbiddenCustody, unwrapGenerationDek: forbiddenCustody,
    deriveDekFingerprint: forbiddenCustody, macManifestRoot: forbiddenCustody,
    async verifyManifestRootMac({ preimage, mac }: { preimage: Uint8Array; mac: Uint8Array }) {
      assert.equal(depth, 0); macCalls++
      return createHmac('sha256', macKey!).update(preimage).digest().equals(Buffer.from(mac))
    } }
  const transactionDepth = { currentTransactionDepth: () => depth }
  if (input.action === 'finalize') {
    await createRecoveryArchiveManualFinalization(transaction)({ identity: input.identity, owner: input.owner,
      key: { keyId: input.policy.keyId, expectedRowVersion: input.policy.keyRowVersion }, keyCustody: custody, transactionDepth })
    throw new Error('FINALIZE_RESPONSE_SHOULD_BE_KILLED')
  } else {
    const provider = await createRecoveryArchiveFileStoreProvider({ ...input.options, transactionDepth })
    const store = { ...provider }
    for (const verb of ['put', 'head', 'get', 'pin', 'unpin', 'deleteExpired'] as const) {
      Object.defineProperty(store, verb, { value: async () => { providerCalls++; throw new Error('UNEXPECTED_PROVIDER_IO') } })
    }
    const result = await createRecoveryArchiveManualCommand(transaction,
      { keyCustody: custody, objectStore: store, transactionDepth }, input.policy).capture(input.identity)
    assert.deepEqual(result, { requestId: input.identity.requestId, generationId: input.owner.generationId, state: 'recoverable' })
    assert.deepEqual({ providerCalls, custodyCalls, macCalls, sourceReads }, { providerCalls: 0, custodyCalls: 0, macCalls: 0, sourceReads: 0 })
    process.send!({ stage: 'retry-complete', result, providerCalls, custodyCalls, macCalls, sourceReads, pid: process.pid })
  }
} catch (error) {
  process.send?.({ stage: 'failed', code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : error instanceof Error ? error.name : 'Error' })
  process.exitCode = 1
} finally {
  macKey?.fill(0)
  await pool?.end(); await closeRuntime?.()
  if (process.connected) process.disconnect()
}
