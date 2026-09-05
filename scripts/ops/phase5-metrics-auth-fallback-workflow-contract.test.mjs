import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const workflowPaths = [
  '.github/workflows/phase5-nightly-validation-regression.yml',
  '.github/workflows/phase5-nightly-validation.yml',
  '.github/workflows/phase5-nightly.yml',
]

function readWorkflow(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

for (const workflowPath of workflowPaths) {
  test(`${workflowPath} derives app metrics auth from deploy-host METRICS_SCRAPE_TOKEN`, () => {
    const raw = readWorkflow(workflowPath)

    assert.match(raw, /DEPLOY_HOST:\s+\$\{\{\s*secrets\.DEPLOY_HOST\s*\}\}/)
    assert.match(raw, /DEPLOY_USER:\s+\$\{\{\s*secrets\.DEPLOY_USER\s*\}\}/)
    assert.match(raw, /DEPLOY_SSH_KEY_B64:\s+\$\{\{\s*secrets\.DEPLOY_SSH_KEY_B64\s*\}\}/)
    assert.match(raw, /METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED=false DEPLOY_KNOWN_HOSTS="\$\{DEPLOY_KNOWN_HOSTS\}" bash scripts\/ops\/resolve-metrics-scrape-token\.sh/)
    assert.match(raw, /AUTH_HEADER="Authorization: Bearer \$metrics_token"/)
    assert.match(raw, /METRICS_AUTH_HEADER=\$AUTH_HEADER/)
    assert.match(raw, /\$\{METASHEET_BASE_URL%\/\}\/metrics\/prom/)
    assert.doesNotMatch(raw, /\/api\/metrics\/prom/)
    assert.doesNotMatch(raw, /ATTENDANCE_ADMIN_JWT/)
    assert.doesNotMatch(raw, /Authorization: Bearer \$ATTENDANCE_ADMIN_JWT/)
  })
}

test('regression workflow uploads deploy-host metrics token fallback diagnostics', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /\/tmp\/phase5-metrics-token-fallback\.log/)
})

test('regression workflow resolves a valid nightly PR branch name', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /id: nightly_date/)
  assert.match(raw, /echo "date=\$\(date -u '\+%Y%m%d'\)" >> "\$GITHUB_OUTPUT"/)
  assert.match(raw, /branch: chore\/phase5-nightly-\$\{\{ steps\.nightly_date\.outputs\.date \}\}/)
  assert.doesNotMatch(raw, /branch: chore\/phase5-nightly-\$\(date/)
})

test('regression workflow can write nightly artifact pull requests', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /\npermissions:\n  contents: write\n  pull-requests: write\n/)
  assert.match(raw, /uses: peter-evans\/create-pull-request@v5/)
})

test('regression workflow limits nightly artifact PR contents', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /add-paths:\s+\|\n\s+results\/nightly\/\*\.json\n\s+claudedocs\/PHASE5_WEEKLY_TREND\.md\n\s+claudedocs\/PHASE5_SLO_SUGGESTIONS\.json/)
  assert.doesNotMatch(raw, /add-paths:[\s\S]*node_modules/)
  assert.doesNotMatch(raw, /add-paths:[\s\S]*package\.json/)
})

test('baseline rotation workflow pins pnpm before installing dependencies', () => {
  const raw = readWorkflow('.github/workflows/phase5-baseline-rotation.yml')

  assert.match(raw, /node-version:\s+'18'/)
  assert.match(raw, /corepack enable/)
  assert.match(raw, /corepack prepare pnpm@10\.16\.1 --activate/)
  assert.match(raw, /pnpm install --frozen-lockfile/)
})

test('attendance remote metrics reuses metrics scrape auth fallback', () => {
  const raw = readWorkflow('.github/workflows/attendance-remote-metrics-prod.yml')

  assert.match(raw, /uses: actions\/checkout@v4/)
  assert.match(raw, /METRICS_AUTH_HEADER_SECRET:\s+\$\{\{\s*secrets\.METRICS_AUTH_HEADER\s*\}\}/)
  assert.match(raw, /DEPLOY_COMPOSE_FILE:\s+\$\{\{\s*secrets\.DEPLOY_COMPOSE_FILE\s*\}\}/)
  assert.match(raw, /METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED=false DEPLOY_KNOWN_HOSTS="\$\{DEPLOY_KNOWN_HOSTS\}" bash scripts\/ops\/resolve-metrics-scrape-token\.sh/)
  assert.match(raw, /METRICS_AUTH_HEADER="Authorization: Bearer \$metrics_token"/)
  assert.match(raw, /METRICS_AUTH_HEADER=\$\(quote_for_remote "\$\{METRICS_AUTH_HEADER\}"\)/)
  assert.match(raw, /METRICS_AUTH_HEADER="\$\{METRICS_AUTH_HEADER\}" scripts\/ops\/attendance-check-metrics\.sh/)
  assert.match(raw, /metrics_auth_configured/)
  assert.doesNotMatch(raw, /ATTENDANCE_ADMIN_JWT/)
})

function workflowStep(raw, name) {
  const marker = `      - name: ${name}\n`
  const start = raw.indexOf(marker)
  assert.ok(start >= 0, name)
  const next = raw.indexOf('\n      - name:', start + marker.length)
  return raw.slice(start, next < 0 ? undefined : next)
}

function stepRun(raw, name) {
  const step = workflowStep(raw, name)
  const multiline = step.split('        run: |\n')[1]
  if (multiline) return multiline.split('\n').map(line => line.replace(/^          /, '')).join('\n')
  const single = step.match(/^        run: (.+)$/m)
  assert.ok(single, name)
  return single[1]
}

test('nightly pins Node and pnpm before the frozen-lockfile install without alternative installers', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly.yml')
  const node = workflowStep(raw, 'Set up Node')
  const pnpm = workflowStep(raw, 'Set up pnpm')
  const install = workflowStep(raw, 'Install deps')
  assert.match(node, /node-version: '20'/)
  assert.match(pnpm, /uses: pnpm\/action-setup@v4/)
  assert.match(pnpm, /version: 10\.16\.1/)
  assert.ok(raw.indexOf(node) < raw.indexOf(pnpm) && raw.indexOf(pnpm) < raw.indexOf(install))
  assert.match(install, /run: pnpm install --frozen-lockfile/)
  assert.doesNotMatch(install, /npm ci|yarn|\|\|/)
  const condition = /        if: (.+)/
  assert.equal(pnpm.match(condition)?.[1], install.match(condition)?.[1])
  assert.equal(node.match(condition)?.[1], install.match(condition)?.[1])
})

test('actual install block invokes only frozen pnpm and propagates installation failure', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'phase5-install-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const events = path.join(dir, 'events')
  for (const command of ['npm', 'pnpm', 'yarn']) {
    writeFileSync(path.join(bin, command), `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.TEST_EVENTS, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)])+'\\n'); process.exit(Number(process.env.TEST_INSTALL_EXIT));\n`, { mode: 0o755 })
  }
  try {
    const run = stepRun(readWorkflow('.github/workflows/phase5-nightly.yml'), 'Install deps')
    for (const code of [0, 7]) {
      writeFileSync(events, '')
      const result = spawnSync('bash', ['-e', '-c', run], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_EVENTS: events, TEST_INSTALL_EXIT: String(code) }, encoding: 'utf8' })
      assert.equal(result.status, code, result.stderr)
      assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['pnpm', 'install', '--frozen-lockfile']])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const [file, notification, gate] of [
  ['.github/workflows/phase5-nightly.yml', 'Slack notify on failure', 'Fail on non-pass summary'],
  ['.github/workflows/phase5-nightly-validation.yml', 'Notify Slack on failure', 'Gate on PASS'],
]) {
  test(`${file} calls optional Slack only when configured and cannot weaken the validation gate`, () => {
    const raw = readWorkflow(file)
    assert.match(raw, /    env:\n      SLACK_WEBHOOK_CONFIGURED: \$\{\{ secrets\.SLACK_WEBHOOK_URL != '' \}\}/)
    const step = workflowStep(raw, notification)
    assert.match(step, /if: failure\(\) && env\.SLACK_WEBHOOK_CONFIGURED == 'true'/)
    assert.match(step, /SLACK_WEBHOOK(?:_URL)?: \$\{\{ secrets\.SLACK_WEBHOOK_URL \}\}/)
    assert.doesNotMatch(workflowStep(raw, gate), /SLACK_WEBHOOK_CONFIGURED|continue-on-error|\|\| true/)
    assert.ok(raw.indexOf(workflowStep(raw, gate)) < raw.indexOf(step))
  })

  test(`${file} actual PASS gate refuses fail, unknown, missing and malformed evidence`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phase5-pass-gate-'))
    const json = path.join(dir, 'phase5.json')
    const run = stepRun(readWorkflow(file), gate).replaceAll('/tmp/phase5.json', json)
    try {
      for (const [body, expected] of [
        [JSON.stringify({ summary: { overall_status: 'pass' } }), 0],
        [JSON.stringify({ summary: { overall_status: 'fail' } }), 1],
        [JSON.stringify({ summary: { overall_status: 'na' } }), 1],
        ['{}', 1], ['not-json', 1], [null, 1],
      ]) {
        if (body === null) rmSync(json, { force: true })
        else writeFileSync(json, body)
        const result = spawnSync('bash', ['-e', '-c', run], { encoding: 'utf8' })
        assert.equal(result.status === 0 ? 0 : 1, expected, result.stdout + result.stderr)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('phase5 workflow contract is executed by the existing stable SSH required lane', () => {
  const raw = readWorkflow('.github/workflows/ssh-hostkey-pin-contract.yml')
  assert.match(raw, /  pull_request:\n  push:/)
  assert.match(raw, /name: ssh host-key pin contract \(fail-closed known_hosts\)/)
  assert.match(raw, /run: node --test scripts\/ops\/phase5-metrics-auth-fallback-workflow-contract\.test\.mjs/)
  assert.match(raw, /      - 'scripts\/ops\/phase5-metrics-auth-fallback-workflow-contract\.test\.mjs'/)
})
