import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import {
  provisionPlmRecordBinding,
  disablePlmRecordBinding,
  type PlmPool,
} from '../src/multitable/plm-record-ingress-binding'

// Deployment operator only. Existing mst_ token ID, never its secret, belongs in the explicit JSON file.
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const disable = args[0] === 'disable'
  if (
    !(disable ? args.length === 2 : args.length === 2 && ['--dry-run', '--apply'].includes(args[1]))
  ) {
    throw new Error(
      'usage: tsx scripts/plm-record-ingress-provision.ts CONFIG.json --dry-run|--apply; or disable BINDING_UUID',
    )
  }
  if (!process.env.DATABASE_URL) throw new Error('explicit DATABASE_URL required')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const adapter: PlmPool = {
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({ query: client.query.bind(client) })
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
  }
  try {
    if (disable) {
      await disablePlmRecordBinding(adapter, args[1])
      console.log(JSON.stringify({ result: 'disabled' }))
    } else {
      await provisionPlmRecordBinding(adapter, JSON.parse(await readFile(args[0], 'utf8')), {
        apply: args[1] === '--apply',
      })
      console.log(JSON.stringify({ result: args[1] === '--apply' ? 'provisioned' : 'validated' }))
    }
  } finally {
    await pool.end()
  }
}
main().catch(() => {
  console.error(
    'PLM ingress provisioning refused; verify configuration, current token permissions and required runtime/schema.',
  )
  process.exitCode = 1
})
