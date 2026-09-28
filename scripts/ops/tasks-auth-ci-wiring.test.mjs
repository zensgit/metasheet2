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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const DEDICATED_CFG = join(repoRoot, 'packages/core-backend/vitest.tasks-auth.config.ts')
const SETUP = join(repoRoot, 'packages/core-backend/tests/tasks-auth/setup.ts')
const GATE = join(repoRoot, 'packages/core-backend/tests/tasks-auth/tasks-auth-gate.ts')
const UNIT_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WIRING = 'scripts/ops/tasks-auth-ci-wiring.test.mjs'
const UNIT_WIRING = 'tests/unit/tasks-auth-ci-wiring.test.ts'
const STEP_ID = 'tasks-auth-gate'
const FILE = 'tests/tasks-auth/tasks-auth-gate.ts'
const CFG_REL = 'vitest.tasks-auth.config.ts'

const GUARDS = [
  "if (process.env.RBAC_BYPASS !== 'false')",
  "if (process.env.RBAC_TOKEN_TRUST !== 'false')",
  "if (process.env.PRODUCT_MODE !== 'plm-workbench')",
  "if (process.env.RBAC_OPTIONAL === '1')",
  "if (process.env.TASKS_ENABLED !== 'true')",
]

function countLiteral(text, literal) {
  const pattern = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return [...text.matchAll(pattern)].length
}

function uncommentedLines(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

test('tasks auth config, setup, and gate stay pinned', () => {
  assert.equal(existsSync(DEDICATED_CFG), true)
  assert.equal(existsSync(SETUP), true)
  assert.equal(existsSync(GATE), true)
  assert.equal(existsSync(join(repoRoot, 'packages/core-backend', UNIT_WIRING)), true)

  const cfg = readFileSync(DEDICATED_CFG, 'utf8')
  assert.equal(countLiteral(cfg, "include: ['tests/tasks-auth/tasks-auth-gate.ts']"), 1)
  assert.equal(countLiteral(cfg, "setupFiles: ['./tests/tasks-auth/setup.ts']"), 1)
  assert.equal(countLiteral(cfg, "RBAC_BYPASS: 'false'"), 1)
  assert.equal(countLiteral(cfg, "RBAC_TOKEN_TRUST: 'false'"), 1)
  assert.equal(countLiteral(cfg, "PRODUCT_MODE: 'plm-workbench'"), 1)
  assert.equal(countLiteral(cfg, "RBAC_OPTIONAL: ''"), 1)
  assert.equal(countLiteral(cfg, "TASKS_ENABLED: 'true'"), 1)
  assert.equal(cfg.includes("setupFiles: ['./tests/setup.integration.ts']"), false)
  assert.equal(cfg.includes("setupFiles: ['tests/setup.integration.ts']"), false)
  assert.equal(cfg.includes('describe.skip'), false)

  const setup = readFileSync(SETUP, 'utf8')
  const assignedAt = setup.indexOf("process.env.TASKS_ENABLED = 'true'")
  assert.ok(assignedAt >= 0, 'setup must assign TASKS_ENABLED before the guards')
  for (const guard of GUARDS) {
    assert.equal(countLiteral(setup, guard), 1, guard)
    assert.ok(setup.indexOf(guard) > assignedAt, `${guard} must follow the assignments`)
  }
  assert.equal(countLiteral(setup, "process.env.RBAC_BYPASS = 'false'"), 1)
  assert.equal(countLiteral(setup, "process.env.RBAC_TOKEN_TRUST = 'false'"), 1)
  assert.equal(countLiteral(setup, "process.env.PRODUCT_MODE = 'plm-workbench'"), 1)
  assert.match(setup, /if \(!process\.env\.DATABASE_URL\)/)
  assert.match(setup, /refusing skip-shaped green/)
  assert.equal(setup.includes('describe.skip'), false)

  const gate = readFileSync(GATE, 'utf8')
  assert.match(gate, /tasksRouter\(/)
  assert.match(gate, /Missing Bearer token/)
  assert.match(gate, /Insufficient permissions/)
  assert.match(gate, /\/api\/tasks\/context/)
  assert.match(gate, /perms: \['tasks:read'\]/)
  assert.equal(gate.includes('describe.skip'), false)
  assert.equal(gate.includes('.skip('), false)

  const unitCfg = readFileSync(UNIT_CFG, 'utf8')
  assert.equal(unitCfg.includes(UNIT_WIRING), false, 'unit vitest exclude must not drop the wiring test')
})

test('plugin-tests.yml executes the tasks auth wiring contract before install', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  const token = `node --test ${WIRING}`
  const at = wf.indexOf(token)
  assert.ok(at >= 0, `plugin-tests.yml must execute ${token}`)
  assert.equal(wf.indexOf(token, at + token.length), -1, `${WIRING} must appear exactly once`)
  const installAt = wf.indexOf('pnpm install --frozen-lockfile')
  assert.ok(installAt >= 0)
  assert.ok(at < installAt, 'tasks auth wiring contract must run before pnpm install')
  const around = uncommentedLines(wf.slice(at - 200, at + token.length + 80))
  assert.equal(around.includes('continue-on-error'), false)
  assert.equal(/\|\|\s*true\b/.test(around), false)
})

test('plugin-tests.yml runs the tasks auth gate as a 20.x whole-file step after migrate', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  parseYamlDocument(wf)
  const step = extractStepById(wf, STEP_ID)
  assert.ok(step, `real-DB step id "${STEP_ID}" must exist`)
  assert.equal(stepRunsOnNode20Matrix(step), true)
  assert.equal(stepHasEnvDatabaseUrl(step), true)
  const env = step.env && typeof step.env === 'object' ? step.env : {}
  assert.equal(env.RBAC_BYPASS, 'false')
  assert.equal(env.RBAC_TOKEN_TRUST, 'false')
  assert.equal(env.PRODUCT_MODE, 'plm-workbench')
  assert.equal(env.TASKS_ENABLED, 'true')

  const run = typeof step.run === 'string' ? step.run : ''
  assert.match(run, /DATABASE_URL:\?/)
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, 'tasks auth gate must not use a -t filter')
  assert.equal(run.includes('--testNamePattern'), false, 'tasks auth gate must not use --testNamePattern')
  assert.equal(/\s--name(?:\s|=|$)/.test(run), false, 'tasks auth gate must not use a --name filter')
  assert.equal(/\|\|\s*true\b/.test(uncommentedLines(run)), false, 'tasks auth gate must not swallow failures with || true')
  assert.equal(run.includes('vitest.integration.config'), false)
  assert.equal(run.includes(CFG_REL), true)
  assert.equal(run.includes(FILE), true)
  const invocations = vitestInvocations(step).filter((inv) => inv.args.some((arg) => arg.includes(CFG_REL) || arg === CFG_REL))
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].args.includes(FILE), true)

  assert.equal(countLiteral(wf, FILE), 1, `${FILE} must appear exactly once`)
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = wf.indexOf(`id: ${STEP_ID}`)
  assert.ok(migrateAt >= 0)
  assert.ok(stepAt > migrateAt, 'tasks auth gate step must appear after db:migrate')
})
