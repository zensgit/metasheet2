// Isolated rehearsal child: recover only the supplied durable event from its test DB.
import { Pool } from 'pg'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { PlmBomReviewService, type BomReviewPool } from '../../src/multitable/plm-bom-review-service'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const tx: BomReviewPool = {
  query: pool.query.bind(pool),
  async transaction(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn({ query: client.query.bind(client) })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  },
}
async function main() {
  try {
    if (!process.env.DATABASE_URL || !process.argv[2]) throw new Error('missing rehearsal input')
    const adapter = new PLMAdapter({ get: () => undefined } as never,
      { info: () => {}, warn: () => {}, error: () => {} } as never)
    const service = new PlmBomReviewService({ pool: tx, dataSourceManager: { getDataSource: () => adapter as never } })
    const result = await service.deliverCompletion(process.argv[2])
    console.log('RECOVERY_RESULT=' + JSON.stringify(result))
  } catch (error) {
    console.error('RECOVERY_ERROR=' + (error instanceof Error ? error.name : 'unknown'))
    process.exitCode = 1
  } finally {
    await pool.end()
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    await poolManager.close()
  }
}
void main()
