import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export const REQUIRED_SUITES = Object.freeze([
  'contracts', 'permissions', 'unit', 'checkpoint',
  'runtime-db', 'multitable-db', 'approval-db', 'attendance-db',
])

export function requireSuccessfulSuites(results) {
  assert.ok(results && typeof results === 'object' && !Array.isArray(results), 'Missing suite results')
  assert.deepEqual(Object.keys(results).sort(), [...REQUIRED_SUITES].sort(), 'Incomplete suite results')
  for (const suite of REQUIRED_SUITES) {
    assert.equal(results[suite]?.result, 'success', `${suite} did not succeed`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireSuccessfulSuites(JSON.parse(process.env.PLUGIN_TEST_RESULTS ?? 'null'))
    console.log('All 8 Node 20 suites succeeded; test (20.x) passed')
  } catch {
    // Do not echo the input environment or provider values into the check log.
    console.error('Parallel suite gate refused incomplete or unsuccessful results')
    process.exitCode = 1
  }
}
