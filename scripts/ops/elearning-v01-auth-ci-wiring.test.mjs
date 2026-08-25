import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  extractStepById,
  parseYamlDocument,
  stepHasEnvDatabaseUrl,
  stepRunsOnNode20Matrix,
  vitestInvocations,
} from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const DEDICATED_CFG = join(repoRoot, 'packages/core-backend/vitest.elearning-pilot-auth.config.ts')
const SETUP = join(repoRoot, 'packages/core-backend/tests/elearning-pilot-auth/setup.ts')
const GATE = join(
  repoRoot,
  'packages/core-backend/tests/elearning-pilot-auth/elearning-pilot-auth-gate.ts',
)
const WIRING = 'scripts/ops/elearning-v01-auth-ci-wiring.test.mjs'
const STEP_ID = 'elearning-v01-auth-tenant-rbac-gate'
const FILE = 'tests/elearning-pilot-auth/elearning-pilot-auth-gate.ts'
const SETUP_REL = 'tests/elearning-pilot-auth/setup.ts'
const CFG_REL = 'vitest.elearning-pilot-auth.config.ts'
const PLUGIN_HANDLER = 'plugins/plugin-elearning/index.cjs'

function uncommentedLines(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

function refusesNameFilters(run, label) {
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, `${label} must not use a -t filter`)
  assert.equal(run.includes('--testNamePattern'), false, `${label} must not use --testNamePattern`)
  assert.equal(/\s--name(?:\s|=|$)/.test(run), false, `${label} must not use a --name filter`)
}

function refusesSkipShapedGreen(text, label) {
  const executable = uncommentedLines(text)
  assert.equal(executable.includes('continue-on-error'), false, `${label} must not set continue-on-error`)
  assert.equal(/\|\|\s*true\b/.test(executable), false, `${label} must not swallow vitest failures with || true`)
  assert.doesNotMatch(executable, /if:\s*false\b/, `${label} must not disable itself with if: false`)
}

function argsUseDedicatedAuthConfig(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    let value = null
    if (arg === '--config' || arg === '-c') value = args[i + 1]
    else if (arg.startsWith('--config=')) value = arg.slice('--config='.length)
    if (value == null) continue
    if (/(?:^|\/)vitest\.elearning-pilot-auth\.config\.[tj]s$/.test(value)) return true
  }
  return false
}

function envString(env, key) {
  if (!env || typeof env !== 'object') return undefined
  const value = env[key]
  return typeof value === 'string' ? value : undefined
}

test('dedicated auth config, setup, and whole-file gate exist and stay isolated', () => {
  assert.ok(existsSync(DEDICATED_CFG), 'vitest.elearning-pilot-auth.config.ts must exist')
  assert.ok(existsSync(SETUP), 'elearning-pilot-auth/setup.ts must exist')
  assert.ok(existsSync(GATE), 'elearning-pilot-auth-gate.ts must exist')
  assert.ok(existsSync(join(repoRoot, PLUGIN_HANDLER)), 'plugin-elearning handler must exist')

  const cfg = readFileSync(DEDICATED_CFG, 'utf8')
  assert.match(cfg, /include:\s*\[\s*'tests\/elearning-pilot-auth\/elearning-pilot-auth-gate\.ts'\s*,?\s*\]/)
  assert.match(cfg, /setupFiles:\s*\[\s*'\.\/tests\/elearning-pilot-auth\/setup\.ts'\s*,?\s*\]/)
  assert.match(cfg, /RBAC_BYPASS:\s*'false'/)
  assert.match(cfg, /RBAC_TOKEN_TRUST:\s*'false'/)
  assert.match(cfg, /PRODUCT_MODE:\s*'plm-workbench'/)
  assert.equal(cfg.includes('vitest.integration.config'), false)
  assert.equal(cfg.includes('--testNamePattern'), false)
  assert.equal(cfg.includes('describe.skip'), false)
  assert.equal(cfg.includes("setupFiles: ['./tests/setup.integration.ts']"), false)
  assert.equal(cfg.includes("setupFiles: ['tests/setup.integration.ts']"), false)

  const setup = readFileSync(SETUP, 'utf8')
  assert.match(setup, /process\.env\.RBAC_BYPASS = 'false'/)
  assert.match(setup, /process\.env\.RBAC_TOKEN_TRUST = 'false'/)
  assert.match(setup, /process\.env\.PRODUCT_MODE = 'plm-workbench'/)
  assert.match(setup, /if \(!process\.env\.DATABASE_URL\)/)
  assert.match(setup, /refusing skip-shaped green/)
  assert.equal(setup.includes('describe.skip'), false)
  assert.equal(setup.includes('.skip('), false)

  const gate = readFileSync(GATE, 'utf8')
  assert.match(gate, /plugin-elearning\/index\.cjs/)
  assert.match(gate, /CANONICAL_PATH/)
  assert.match(gate, /ORG_CONTEXT_REQUIRED/)
  assert.match(gate, /x-tenant-id/)
  assert.match(gate, /RBAC_BYPASS !== 'false'/)
  assert.match(gate, /RBAC_TOKEN_TRUST !== 'false'/)
  assert.equal(gate.includes('describe.skip'), false)
  assert.equal(gate.includes('.skip('), false)
  assert.equal(gate.includes('.catch(() => undefined)'), false)
  assert.match(gate, /residue/)
})

test('plugin-tests.yml executes this no-DB wiring contract before install', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  const token = `node --test ${WIRING}`
  const at = wf.indexOf(token)
  assert.ok(at >= 0, `plugin-tests.yml must execute ${token}`)
  assert.equal(wf.indexOf(token, at + token.length), -1, `${WIRING} must appear exactly once`)
  const installAt = wf.indexOf('pnpm install --frozen-lockfile')
  assert.ok(installAt >= 0, 'workflow must contain pnpm install --frozen-lockfile')
  assert.ok(at < installAt, 'auth wiring contract must run before pnpm install')
  refusesSkipShapedGreen(wf.slice(at - 200, at + token.length + 80), 'auth wiring contract step')
})

test('plugin-tests.yml runs the dedicated auth gate as an exact whole-file 20.x real-DB step', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  parseYamlDocument(wf)
  const step = extractStepById(wf, STEP_ID)
  assert.ok(step, `real-DB step id "${STEP_ID}" must exist`)
  assert.equal(stepRunsOnNode20Matrix(step), true, `${STEP_ID} must run on matrix.node-version == '20.x'`)
  assert.equal(stepHasEnvDatabaseUrl(step), true, `${STEP_ID} must carry a literal DATABASE_URL`)

  const env = step.env && typeof step.env === 'object' ? step.env : {}
  assert.equal(envString(env, 'RBAC_BYPASS'), 'false', `${STEP_ID} must set RBAC_BYPASS: 'false'`)
  assert.equal(envString(env, 'RBAC_TOKEN_TRUST'), 'false', `${STEP_ID} must set RBAC_TOKEN_TRUST: 'false'`)
  assert.equal(envString(env, 'PRODUCT_MODE'), 'plm-workbench', `${STEP_ID} must set PRODUCT_MODE: plm-workbench`)

  const run = typeof step.run === 'string' ? step.run : ''
  assert.match(run, /DATABASE_URL:\?/, `${STEP_ID} must fail closed if DATABASE_URL is unset`)
  refusesNameFilters(run, STEP_ID)
  refusesSkipShapedGreen(run, STEP_ID)
  assert.equal(run.includes('vitest.integration.config'), false, `${STEP_ID} must not use the integration config`)
  assert.equal(run.includes(CFG_REL), true, `${STEP_ID} must name ${CFG_REL}`)
  assert.equal(run.includes(FILE), true, `${STEP_ID} must name ${FILE}`)
  assert.equal(run.includes(SETUP_REL), false, `${STEP_ID} must not pass setup.ts as a vitest file arg`)

  const invocations = vitestInvocations(step)
  const dedicated = invocations.filter((inv) => argsUseDedicatedAuthConfig(inv.args))
  assert.equal(dedicated.length, 1, `${STEP_ID} must have exactly one dedicated-config vitest invocation`)
  assert.equal(
    dedicated[0].args.includes(FILE),
    true,
    `${STEP_ID} must pass ${FILE} as a whole-file vitest arg of the dedicated config`,
  )
  assert.equal(
    dedicated[0].args.some((arg) => arg.includes('--testNamePattern') || arg === '-t' || arg.startsWith('-t=')),
    false,
    `${STEP_ID} dedicated invocation must not name-filter`,
  )

  const hits = []
  for (let from = 0; ;) {
    const at = wf.indexOf(FILE, from)
    if (at < 0) break
    hits.push(at)
    from = at + FILE.length
  }
  assert.equal(hits.length, 1, `${FILE} must appear exactly once in plugin-tests.yml`)
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = wf.indexOf(`id: ${STEP_ID}`)
  assert.ok(migrateAt >= 0, 'workflow must contain db:migrate')
  assert.ok(stepAt > migrateAt, 'auth gate step must appear after db:migrate')
})
