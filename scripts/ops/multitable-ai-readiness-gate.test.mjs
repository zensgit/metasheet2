import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const AI_ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_BASE_URL',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_REQUEST_TIMEOUT_MS',
  'MULTITABLE_AI_MAX_OUTPUT_TOKENS',
  'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
]

function withCleanAiEnv(env = {}) {
  const next = { ...process.env }
  for (const key of AI_ENV_KEYS) next[key] = ''
  return { ...next, ...env }
}

function runReadiness(env = {}, extraArgs = []) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-ai-readiness-'))
  const jsonPath = path.join(tmpRoot, 'report.json')
  const mdPath = path.join(tmpRoot, 'report.md')
  const result = spawnSync('pnpm', [
    'exec',
    'tsx',
    'scripts/ops/multitable-ai-readiness-gate.ts',
    '--output-json',
    jsonPath,
    '--output-md',
    mdPath,
    ...extraArgs,
  ], {
    cwd: repoRoot,
    env: withCleanAiEnv(env),
    encoding: 'utf8',
  })

  return {
    ...result,
    jsonPath,
    mdPath,
    json: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null,
    markdown: fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '',
  }
}

test('AI readiness script exits 2 in default disabled mode', () => {
  const result = runReadiness()

  assert.equal(result.status, 2)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.status, 'disabled')
  assert.match(result.markdown, /Status: `disabled`/)
})

test('AI readiness script exits 0 when declarative provider env is ready', () => {
  const result = runReadiness({
    MULTITABLE_AI_ENABLED: '1',
    MULTITABLE_AI_PROVIDER: 'anthropic',
    MULTITABLE_AI_API_KEY: 'sk-ready-secret-abcdefghijklmnopqrstuvwxyz',
    MULTITABLE_AI_MODEL: 'claude-3-5-sonnet-latest',
  })

  assert.equal(result.status, 0)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.status, 'ready')
  assert.match(result.markdown, /declarative readiness only/)
})

test('AI readiness script redacts API keys and endpoint credentials from artifacts', () => {
  const skSecret = 'sk-artifact-secret-abcdefghijklmnopqrstuvwxyz'
  const urlSecret = 'url-password-secret'
  const result = runReadiness({
    MULTITABLE_AI_ENABLED: '1',
    MULTITABLE_AI_PROVIDER: 'openai',
    MULTITABLE_AI_API_KEY: skSecret,
    MULTITABLE_AI_MODEL: 'gpt-4o-mini',
    MULTITABLE_AI_BASE_URL: `https://user:${urlSecret}@gateway.example.com`,
  })

  assert.equal(result.status, 0)
  const combined = [
    result.stdout,
    result.stderr,
    result.markdown,
    JSON.stringify(result.json),
  ].join('\n')
  assert.doesNotMatch(combined, new RegExp(skSecret))
  assert.doesNotMatch(combined, new RegExp(urlSecret))
  assert.doesNotMatch(combined, /user:url-password-secret/)
})

test('AI readiness script redacts secret-shaped output paths in stdout', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-ai-readiness-path-'))
  const secretSegment = 'sk-path-secret-abcdefghijklmnopqrstuvwxyz'
  const jsonPath = path.join(tmpRoot, secretSegment, 'report.json')
  const mdPath = path.join(tmpRoot, secretSegment, 'report.md')
  const result = spawnSync('pnpm', [
    'exec',
    'tsx',
    'scripts/ops/multitable-ai-readiness-gate.ts',
  ], {
    cwd: repoRoot,
    env: withCleanAiEnv({
      AI_READINESS_JSON: jsonPath,
      AI_READINESS_MD: mdPath,
    }),
    encoding: 'utf8',
  })

  assert.equal(result.status, 2)
  assert.equal(fs.existsSync(jsonPath), true)
  assert.equal(fs.existsSync(mdPath), true)
  assert.doesNotMatch(result.stdout, new RegExp(secretSegment))
  assert.match(result.stdout, /sk-<redacted>/)
})

test('AI readiness script exits 1 on script usage errors', () => {
  const result = spawnSync('pnpm', [
    'exec',
    'tsx',
    'scripts/ops/multitable-ai-readiness-gate.ts',
    '--bogus',
  ], {
    cwd: repoRoot,
    env: withCleanAiEnv(),
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown option: --bogus/)
})

test('AI readiness script can be launched through package script', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-ai-readiness-script-'))
  const jsonPath = path.join(tmpRoot, 'report.json')
  const mdPath = path.join(tmpRoot, 'report.md')

  execFileSync('pnpm', [
    'verify:multitable-ai:readiness',
    '--output-json',
    jsonPath,
    '--output-md',
    mdPath,
  ], {
    cwd: repoRoot,
    env: withCleanAiEnv({
      MULTITABLE_AI_ENABLED: '1',
      MULTITABLE_AI_PROVIDER: 'openai',
      MULTITABLE_AI_API_KEY: 'sk-package-secret-abcdefghijklmnopqrstuvwxyz',
      MULTITABLE_AI_MODEL: 'gpt-4o-mini',
    }),
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(report.status, 'ready')
})
