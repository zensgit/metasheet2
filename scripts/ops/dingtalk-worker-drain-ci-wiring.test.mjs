import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')

function jobBlock(jobId) {
  const marker = `\n  ${jobId}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow job ${jobId}`)
  const bodyStart = start + marker.length
  const nextJob = workflow.slice(bodyStart).search(/\n  [a-z0-9_-]+:\n/)
  return nextJob === -1
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + nextJob)
}

test('test matrix runs the worker-drain behavior suite on Node 18 and 20', () => {
  const requiredTestJob = jobBlock('test')
  assert.match(requiredTestJob, /node-version:\s*\[18\.x,\s*20\.x\]/)
  assert.match(
    requiredTestJob,
    /node --test scripts\/ops\/dingtalk-staging-deploy-identity\.test\.mjs/,
  )
})

test('test matrix runs this wiring guard beside the behavior suite', () => {
  const requiredTestJob = jobBlock('test')
  assert.match(
    requiredTestJob,
    /node --test scripts\/ops\/dingtalk-worker-drain-ci-wiring\.test\.mjs/,
  )
})
