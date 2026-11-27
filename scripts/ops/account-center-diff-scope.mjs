import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Path membership only; shared-file contents are checked separately.
export const ALLOWED_FILES = {
  '06a-C': [
    'packages/core-backend/src/auth/account-center-readers.ts',
    'packages/core-backend/src/routes/me-external-identities.ts',
    'packages/core-backend/src/index.ts',
    'packages/openapi/src/paths/me-external-identities.yml',
    'packages/openapi/dist/combined.openapi.yml',
    'packages/openapi/dist/openapi.yaml',
    'packages/openapi/dist/openapi.json',
    'packages/openapi/dist-sdk/index.d.ts',
    'packages/core-backend/tests/unit/account-center-route.test.ts',
    'packages/core-backend/tests/unit/account-center-boundary.guard.test.ts',
    'packages/core-backend/tests/integration/account-center-readers.db.test.ts',
    'packages/core-backend/tests/integration/account-center-partition.db.test.ts',
    'packages/core-backend/vitest.account-center-realdb.config.ts',
    'packages/core-backend/vitest.config.ts',
    '.github/workflows/account-center-realdb.yml',
    'packages/core-backend/tests/unit/account-center-realdb-wiring.guard.test.ts',
    'scripts/ops/account-center-openapi-contract.test.mjs',
    '.github/workflows/account-center-contract-guard.yml',
    'packages/core-backend/tests/unit/account-center-contract-wiring.guard.test.ts',
  ],
  '06a-M': [
    'packages/core-backend/src/account-center/read-model.ts',
    'packages/core-backend/src/account-center/read-flag.ts',
    'apps/web/src/account/accountCenterContract.ts',
    'apps/web/src/account/useAccountCenterRead.ts',
    'scripts/ops/global-history-flag-manifest.mjs',
    'scripts/ops/global-history-flag-manifest.test.mjs',
    '.env.example',
    'packages/core-backend/tests/unit/account-center-model.test.ts',
    'packages/core-backend/tests/unit/account-center-flag.test.ts',
    'apps/web/tests/accountCenterRead.spec.ts',
    'apps/web/scripts/run-required-web-tests.sh',
    'apps/web/scripts/run-required-web-tests.tokens',
    '.github/workflows/account-center-web-guard.yml',
  ],
  '06a-U': [
    'apps/web/src/views/AccountCenterView.vue',
    'apps/web/src/account/accountCenterParser.ts',
    'apps/web/src/account/accountCenterLabels.ts',
    'apps/web/src/router/appRoutes.ts',
    'apps/web/src/views/SessionCenterView.vue',
    'apps/web/tests/accountCenterView.spec.ts',
    'apps/web/tests/accountCenterParser.spec.ts',
    'apps/web/tests/accountCenterLabels.spec.ts',
    'apps/web/tests/sessionCenterView.spec.ts',
    'apps/web/scripts/run-required-web-tests.sh',
    'apps/web/scripts/run-required-web-tests.tokens',
    '.github/workflows/account-center-web-guard.yml',
  ],
  '06f-U': [
    'apps/web/src/components/AuthorizationAuditFeed.vue',
    'apps/web/tests/authorizationAuditFeed.spec.ts',
    'apps/web/tests/adminAuditView.spec.ts',
    'apps/web/scripts/run-required-web-tests.sh',
    'apps/web/scripts/run-required-web-tests.tokens',
    '.github/workflows/account-center-web-guard.yml',
  ],
  '06f-D': [
    'docs/operations/account-center-readonly.md',
    'packages/core-backend/tests/unit/account-center-docs.guard.test.ts',
  ],
  coordination: [
    'packages/core-backend/tests/unit/account-center-web-wiring.guard.test.ts',
    'scripts/ops/account-center-diff-scope.mjs',
    'scripts/ops/account-center-diff-scope.test.mjs',
  ],
}

const SCOPE_SHA256 = '37d4cb4ae58a8913d4546ff4086d7416e3758891e05ea25d140a510ad7218587'
const SOURCE = fileURLToPath(import.meta.url)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function parseArgs(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    if (!['--base', '--head', '--slice'].includes(key) || Object.hasOwn(result, key.slice(2))) {
      throw new Error('Expected each of --base, --head and --slice exactly once')
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    result[key.slice(2)] = value
  }
  for (const key of ['base', 'head']) {
    if (!/^[0-9a-f]{40}$/.test(result[key] ?? '') || /^0{40}$/.test(result[key])) {
      throw new Error(`${key} must be a nonzero lowercase full commit SHA`)
    }
  }
  if (!Object.hasOwn(ALLOWED_FILES, result.slice ?? '')) throw new Error('Missing or unknown slice')
  return result
}

export function parseNameStatus(input) {
  const text = Buffer.isBuffer(input) ? new TextDecoder('utf-8', { fatal: true }).decode(input) : input
  if (text === '') return []
  if (!text.endsWith('\0')) throw new Error('Truncated name-status stream')
  const fields = text.slice(0, -1).split('\0')
  const records = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!/^(?:[AMDT]|[RC][0-9]{1,3})$/.test(status) || (/^[RC]/.test(status) && Number(status.slice(1)) > 100)) {
      throw new Error(`Unknown name-status: ${JSON.stringify(status)}`)
    }
    const count = /^[RC]/.test(status) ? 2 : 1
    const paths = fields.slice(index, index + count)
    if (paths.length !== count || paths.some((path) => path === '')) {
      throw new Error('Missing name-status path')
    }
    records.push({ status, paths })
    index += count
  }
  return records
}

export function violationsFor(records, slice) {
  if (!Object.hasOwn(ALLOWED_FILES, slice)) throw new Error('Unknown slice')
  const allowed = new Set(ALLOWED_FILES[slice])
  const violations = []
  for (const record of records) {
    for (const path of record.paths) {
      if (!allowed.has(path)) violations.push({ path, reason: 'outside slice' })
      if (record.status === 'D') violations.push({ path, reason: 'deletion is not allowed' })
    }
  }
  return violations
}

export function main(args) {
  const receipt = {
    base: null, head: null, slice: null, changes: [],
    scopeSha256: SCOPE_SHA256,
    allowedFilesSha256: sha256(JSON.stringify(ALLOWED_FILES)),
    checkerSha256: sha256(readFileSync(SOURCE)),
  }
  try {
    Object.assign(receipt, parseArgs(args))
    const git = (args, cwd = process.cwd()) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    })
    const root = git(['rev-parse', '--show-toplevel']).trim()
    for (const key of ['base', 'head']) {
      git(['cat-file', '-e', `${receipt[key]}^{commit}`], root)
    }
    git(['merge-base', '--is-ancestor', receipt.base, receipt.head], root)
    const diff = execFileSync('git', [
      'diff', '--name-status', '-z', '--find-renames', receipt.base, receipt.head, '--',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    receipt.changes = parseNameStatus(diff)
    receipt.violations = violationsFor(receipt.changes, receipt.slice)
    receipt.exitCode = receipt.violations.length ? 1 : 0
    receipt.result = receipt.exitCode ? 'OUT_OF_SCOPE' : receipt.changes.length ? 'IN_SCOPE' : 'EMPTY (not a completion proof)'
  } catch (error) {
    receipt.exitCode = 2
    receipt.result = 'INPUT_ERROR'
    receipt.error = error.message
  }
  console.log(JSON.stringify(receipt, null, 2))
  return receipt.exitCode
}

// Compare real paths so a call through a symlinked path still runs the checker.
function invokedAsMain() {
  if (!process.argv[1]) return false
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(SOURCE) } catch { return false }
}
if (invokedAsMain()) process.exitCode = main(process.argv.slice(2))
