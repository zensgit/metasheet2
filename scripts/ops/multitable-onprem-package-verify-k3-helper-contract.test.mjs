import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const verifyScript = fs.readFileSync(path.join(repoRoot, 'scripts/ops/multitable-onprem-package-verify.sh'), 'utf8')
const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts/ops/multitable-onprem-package-build.sh'), 'utf8')

test('on-prem verifier follows the helper-backed K3 SQL Server executor seam', () => {
  assert.match(
    buildScript,
    /"packages\/mssql-readonly-utils"/,
    'the deploy package must include the shared helper package that plugin workspace symlinks resolve to',
  )
  assert.match(
    verifyScript,
    /pnpm-workspace\.yaml.*packages\/\*/s,
    'the verifier must lock the workspace package glob used during deploy dependency refresh',
  )
  assert.match(
    verifyScript,
    /pnpm-lock\.yaml.*link:\.\.\/\.\.\/packages\/mssql-readonly-utils/s,
    'the verifier must lock the plugin workspace dependency link for frozen deploy installs',
  )
  assert.match(
    verifyScript,
    /core-backend package\.json.*@metasheet\/mssql-readonly-utils/s,
    'the verifier must lock the backend runtime helper dependency',
  )
  assert.match(
    verifyScript,
    /pnpm-lock\.yaml.*link:\.\.\/mssql-readonly-utils/s,
    'the verifier must lock the core-backend workspace dependency link for frozen deploy installs',
  )
  assert.match(
    verifyScript,
    /packages\/mssql-readonly-utils\/package\.json/,
    'the verifier must inspect the packaged helper manifest, not only index.cjs',
  )
  assert.match(
    verifyScript,
    /"main": "index\.cjs"/,
    'the packaged helper manifest must point runtime resolution at index.cjs',
  )
  assert.match(
    verifyScript,
    /"@metasheet\/mssql-readonly-utils"/,
    'the packaged plugin must carry the helper as a runtime dependency',
  )
  assert.match(
    verifyScript,
    /buildSharedSimpleSelectQuery/,
    'the K3 executor should be verified through its call into the shared bounded-select helper',
  )
  assert.match(
    verifyScript,
    /function buildSimpleSelectQuery/,
    'the package must contain the helper bounded-select builder',
  )
  assert.match(
    verifyScript,
    /SELECT TOP.*mssql_helper/s,
    'bounded SELECT evidence should come from the packaged helper, not stale executor-local SQL text',
  )
  assert.match(
    verifyScript,
    /SQLSERVER_WRITE_EXECUTOR_DISABLED/,
    'K3 built-in writes must remain explicitly disabled',
  )
})
