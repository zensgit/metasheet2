import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SK_SENTINEL = `sk-${'gate1234'.repeat(4)}`
const URL_PASSWORD_SENTINEL = 'GateS3cretPw'

const READY_ENV = {
  MULTITABLE_AI_ENABLED: '1',
  MULTITABLE_AI_PROVIDER: 'anthropic',
  MULTITABLE_AI_API_KEY: 'test-key-placeholder',
  MULTITABLE_AI_MODEL: 'claude-sonnet-4-6',
}

function cleanEnv(overrides) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('MULTITABLE_AI_')) delete env[key]
  }
  return { ...env, ...overrides }
}

function runGate(overrides, extraArgs = []) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-ai-readiness-'))
  const result = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/ops/multitable-ai-readiness-gate.ts', '--output-dir', outputDir, ...extraArgs],
    {
      cwd: repoRoot,
      env: cleanEnv(overrides),
      encoding: 'utf8',
    },
  )
  const jsonPath = path.join(outputDir, 'report.json')
  const mdPath = path.join(outputDir, 'report.md')
  return {
    ...result,
    jsonPath,
    mdPath,
    json: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null,
    markdown: fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '',
  }
}

test('A1-T9: gate exits 2 (BLOCKED, never 1) in the default disabled deployment and writes artifacts', () => {
  const result = runGate({})

  assert.equal(result.status, 2)
  assert.ok(result.json, 'report.json must exist')
  assert.equal(result.json.status, 'disabled')
  assert.equal(result.json.ok, false)
  assert.match(result.markdown, /Status: `disabled`/)
})

test('A1-T9: gate exits 2 when enabled but blocked', () => {
  const result = runGate({
    MULTITABLE_AI_ENABLED: '1',
    MULTITABLE_AI_PROVIDER: 'azure-openai',
  })

  assert.equal(result.status, 2)
  assert.equal(result.json.status, 'blocked')
  assert.doesNotMatch(result.stdout + result.stderr, /azure-openai/)
})

test('A1-T9: gate exits 0 when fully configured (declarative ready, no provider call)', () => {
  const result = runGate(READY_ENV)

  assert.equal(result.status, 0)
  assert.equal(result.json.status, 'ready')
  assert.equal(result.json.ok, true)
  assert.match(result.markdown, /Status: `ready`/)
})

test('A1-T6 (gate leg): sk-shaped and URL-embedded sentinels never reach stdout/stderr/JSON/MD artifacts', () => {
  const result = runGate({
    ...READY_ENV,
    MULTITABLE_AI_API_KEY: SK_SENTINEL,
    MULTITABLE_AI_BASE_URL: `https://ops:${URL_PASSWORD_SENTINEL}@proxy.example.com/v1`,
  })

  assert.equal(result.status, 0)
  const combined = [
    result.stdout,
    result.stderr,
    result.markdown,
    JSON.stringify(result.json),
  ].join('\n')
  assert.ok(!combined.includes(SK_SENTINEL), 'sk-shaped sentinel leaked into gate output')
  assert.ok(!combined.includes(URL_PASSWORD_SENTINEL), 'URL-embedded password sentinel leaked into gate output')
})

test('A1-T9: unknown argument is a script error (exit 1, not BLOCKED)', () => {
  const result = runGate({}, ['--bogus-flag'])

  assert.equal(result.status, 1)
})
