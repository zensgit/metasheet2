#!/usr/bin/env node
/**
 * Attendance Windows-native QA v2 — SINGLE-INSTANCE probe (owner scope ruling B).
 *
 * Draft/HOLD. Synthetic ids only. NO database — this probe proves module-identity, not behavior.
 *
 * WHAT IT PROVES: the `w4c0-identity` instance the harness pipeline loads is the SAME instance the
 * product's own graph loads. w4c0-identity guards its witnesses with module-PRIVATE WeakSets, so a
 * witness minted by one instance is rejected by any other with W4C0_OPERATION_WITNESS_REQUIRED —
 * exactly the dual-instance failure the old ESM-`import()` route produced on Node 20 + tsx (tsx
 * materialises an ESM-imported CJS-package .ts as an inline data:-URL CommonJS translation that
 * does not share the plain require cache).
 *
 * HOW: mint an operation witness DB-free (rehydrated org witness + derived scheduled source
 * tuple) via the harness pipeline's `w4c0-identity`, then hand it to the product's
 * `recordAttendanceScheduledRunTargetOutcomeV1` with a sentinel-throwing dummy trx:
 *   - the witness check PASSES  -> the sentinel throw is reached  -> SINGLE instance (exit 0)
 *   - the witness check REJECTS -> W4C0_OPERATION_WITNESS_REQUIRED -> DUAL instance   (exit 1)
 * No DML can occur: the dummy trx throws on first use.
 *
 * `--dual-route` is the discriminating-power NEGATIVE CONTROL: it deliberately re-creates the OLD
 * broken route (ESM dynamic import of the identity module by file URL, bypassing importProduct's
 * single CJS pipeline). Under the tsx loader on Node 18/20 this MUST be rejected — proving this
 * probe can actually detect a dual instance (a probe that cannot fail proves nothing).
 */
import { pathToFileURL } from 'node:url'
import { importProduct, productModuleMode, resolveProductModule } from './qa-runtime.mjs'

const dualRoute = process.argv.includes('--dual-route')
const mode = productModuleMode()

const { recordAttendanceScheduledRunTargetOutcomeV1 } = await importProduct('attendance/w4c2-scheduled-run')

let identity
if (dualRoute) {
  // OLD broken route (negative control): ESM dynamic import by file URL.
  identity = await import(pathToFileURL(resolveProductModule('attendance/w4c0-identity')).href)
} else {
  // The harness pipeline (one CJS require cache — what every harness uses via importProduct).
  identity = await importProduct('attendance/w4c0-identity')
}

const org = identity.rehydrateVerifiedAttendanceOrgIdentityV1({
  orgId: '11111111-1111-4111-8111-111111111111',
  acceptedWritePosture: 'shadow',
})
const witness = identity.createVerifiedAttendanceOperationIdentityV1({
  org,
  kind: 'item',
  entrypoint: 'scheduled',
  source: {
    sourceKind: 'scheduled',
    scheduledRunId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    workDate: '2026-01-05',
  },
})

const SENTINEL = 'QA_SINGLETON_PROBE_TRX_REACHED'
let verdict
try {
  await recordAttendanceScheduledRunTargetOutcomeV1(
    { query: async () => { throw new Error(SENTINEL) } },
    witness,
    { terminalOutcome: 'completed' },
  )
  verdict = 'unexpected-complete'
} catch (error) {
  verdict = error && error.message === SENTINEL ? 'single-instance' : `rejected:${error?.message ?? error}`
}

console.log(JSON.stringify({ mode, dualRoute, verdict }))
process.exit(verdict === 'single-instance' ? 0 : 1)
