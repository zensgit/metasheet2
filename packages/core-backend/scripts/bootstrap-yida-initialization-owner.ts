import { open } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { provisionYidaInitializationAnchor } from '../src/integration/yida-initialization-bootstrap'

/** Operator-only local database bootstrap. This is NOT an HTTP role-grant,
 * sender, migration runner, or first-admin-wins fallback. Production execution
 * and the real owner/tenant must be separately authorized by the deployment
 * owner. Never pass credentials or database URLs on the command line. */
type Manifest = Readonly<{ ownerId: string; tenantId: string }>
type Summary = Readonly<{ ok: boolean; status: 'provisioned' | 'unconfirmed' }>
type Dependencies = Readonly<{
  read(path: string): Promise<string>
  provision(manifest: Manifest): Promise<unknown>
}>
const LIMIT = 4096

function argumentsFor(argv: string[]): string {
  if (argv.length !== 3 || argv[0] !== '--input' || argv[2] !== '--apply'
    || !argv[1] || !path.isAbsolute(argv[1])) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_INPUT')
  return argv[1]
}
function manifestFor(text: string): Manifest {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMIT) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_INPUT')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_INPUT')
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).length !== 2 || ['ownerId', 'tenantId'].some(key => {
    const property = properties[key]
    return !property?.enumerable || !Object.hasOwn(property, 'value') || typeof property.value !== 'string'
      || !property.value || property.value.length > 128 || property.value.trim() !== property.value
      || /[\u0000-\u001f\u007f]/u.test(property.value)
  })) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_INPUT')
  return Object.freeze({ ownerId: properties.ownerId.value as string, tenantId: properties.tenantId.value as string })
}
async function readBounded(inputPath: string): Promise<string> {
  const handle = await open(inputPath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_INPUT')
    // Limit the actual read too: a concurrently growing file cannot defeat stat.
    const buffer = Buffer.alloc(LIMIT + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > LIMIT) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_INPUT')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally { await handle.close() }
}
async function provisionLocal(manifest: Manifest): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_UNAVAILABLE')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 10000 })
  // A pool background failure is never printed with host/URL/identity values.
  pool.on('error', () => undefined)
  try {
    await provisionYidaInitializationAnchor({ database: { transaction: async work => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        const result = await work({ query: (sql, params) => client.query(sql, params) })
        await client.query('COMMIT')
        return result
      } catch {
        try { await client.query('ROLLBACK') } catch { /* The result remains unconfirmed. */ }
        throw new Error('YIDA_INITIALIZATION_BOOTSTRAP_UNCONFIRMED')
      } finally { client.release() }
    } } }, manifest)
  } finally { await pool.end() }
}

export async function runYidaInitializationBootstrapCli(argv: string[],
  dependencies: Dependencies = { read: readBounded, provision: provisionLocal }): Promise<Summary> {
  try {
    const inputPath = argumentsFor(argv)
    const manifest = manifestFor(await dependencies.read(inputPath))
    await dependencies.provision(manifest)
    return Object.freeze({ ok: true, status: 'provisioned' })
  } catch {
    // Includes COMMIT-reply loss. No claim that the database was unchanged,
    // no automatic retry, and no inspection/coercion of a foreign rejection.
    return Object.freeze({ ok: false, status: 'unconfirmed' })
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entry === import.meta.url) {
  void runYidaInitializationBootstrapCli(process.argv.slice(2)).then(summary => {
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    process.exitCode = summary.ok ? 0 : 1
  })
}
