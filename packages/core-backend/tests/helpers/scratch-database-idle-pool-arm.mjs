/**
 * #4820 dual-arm child — real-PG proof that an idle Pool receiving admin-termination
 * emits unowned 57P01 without a handler, and that attachOwnedPoolTerminationHandler owns it.
 *
 * Env: ARM=uncaught|owned, SCRATCH_URL, ADMIN_URL, DATNAME
 * Exit: 0 owned+absorbed; 17 uncaught 57P01; 18 owned without absorb; 19 uncaught arm no event; 1 other
 */
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const arm = process.env.ARM
const scratchUrl = process.env.SCRATCH_URL
const adminUrl = process.env.ADMIN_URL
const datname = process.env.DATNAME

if (!arm || !scratchUrl || !adminUrl || !datname) {
  console.error('SCRATCH_IDLE_POOL_ARM_MISSING_ENV')
  process.exit(1)
}

const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), 'scratch-database.ts')
const helper = await import(pathToFileURL(helperPath).href)
const { attachOwnedPoolTerminationHandler, isAdministratorTerminationError } = helper

const pool = new Pool({
  connectionString: scratchUrl,
  max: 1,
  application_name: `ms2-drain-child-${arm}`,
})
const admin = new Pool({ connectionString: adminUrl, max: 1 })

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      console.error(`SCRATCH_IDLE_POOL_ARM_TIMEOUT: ${label}`)
      return false
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  return true
}

let uncaughtTerm = false
process.on('uncaughtException', (err) => {
  if (isAdministratorTerminationError(err)) {
    uncaughtTerm = true
    process.exit(17)
  }
  console.error('UNEXPECTED_UNCAUGHT', err)
  process.exit(1)
})

try {
  await pool.query('SELECT 1')
  let handler = null
  if (arm === 'owned') {
    handler = attachOwnedPoolTerminationHandler(pool)
  }
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [datname],
  )

  if (arm === 'owned') {
    const observed = await waitUntil(() => (handler?.absorbed() ?? 0) > 0, 5_000, 'owned 57P01 absorb')
    await admin.end().catch(() => undefined)
    const absorbed = handler ? handler.absorbed() : 0
    if (handler) handler.detach()
    await pool.end().catch(() => undefined)
    if (uncaughtTerm) process.exit(17)
    if (!observed || absorbed < 1) process.exit(18)
    process.exit(0)
  }

  // The uncaughtException handler exits 17 as soon as the real Pool emits 57P01. Keep the
  // process alive for a bounded interval instead of assuming a fixed number of event-loop turns.
  await new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
  await admin.end().catch(() => undefined)
  await pool.end().catch(() => undefined)
  process.exit(uncaughtTerm ? 17 : 19)
} catch (err) {
  console.error(err)
  process.exit(1)
}
