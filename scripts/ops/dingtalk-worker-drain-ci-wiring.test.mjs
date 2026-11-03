import { requiredSuiteJobBody } from './plugin-tests-workflow-contract.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')

test('test matrix runs the worker-drain behavior suite on the required Node 20 leg', () => {
  const requiredTestJob = requiredSuiteJobBody(workflow, 'contracts')
  // The 18.x leg was dropped on 2026-10-07 (Node 18 is EOL; it was never a required check).
  assert.match(requiredTestJob, /node-version:\s*\[20\.x\]/)
  assert.match(
    requiredTestJob,
    /node --test scripts\/ops\/dingtalk-staging-deploy-identity\.test\.mjs/,
  )
})

test('test matrix runs this wiring guard beside the behavior suite', () => {
  const requiredTestJob = requiredSuiteJobBody(workflow, 'contracts')
  assert.match(
    requiredTestJob,
    /node --test scripts\/ops\/dingtalk-worker-drain-ci-wiring\.test\.mjs/,
  )
})
