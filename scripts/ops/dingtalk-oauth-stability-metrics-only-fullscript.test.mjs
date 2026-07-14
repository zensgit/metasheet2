import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// DT-CLOSE-01B full-script regression guard.
//
// The metrics-only contract test (dingtalk-oauth-stability-metrics-only-contract.test.mjs) only
// exercises the EMBEDDED VERDICT PYTHON by injecting *_INPUT env vars directly — it never runs the
// shell probes that are supposed to *produce* ALERT_TOPOLOGY_DEFERRED. That left a real subshell bug
// invisible: `WEBHOOK_STATUS="$(cmd || { ALERT_TOPOLOGY_DEFERRED="true"; ... })"` sets the marker
// INSIDE the `$( ... )` command substitution — a SUBSHELL — so the assignment never reaches the
// parent shell and ALERT_TOPOLOGY_DEFERRED silently stayed "false" even when :9093 was unreachable.
// Repro: `X=false; Y=$(false || { X=true; echo z; }); echo $X` prints `false`.
//
// This test runs the WHOLE script (real bash, real embedded python) against a mocked `ssh` (PATH
// shim) and a stubbed `set-dingtalk-onprem-alertmanager-webhook-config.sh`, pinning all three states
// of the owner-required THREE-STATE contract:
//   (1) :9093 refused (probe failure)                         => alertDeliveryObservability=deferred
//   (2) :9093 reachable, webhook UNCONFIGURED (probe succeeds,
//       script exits 0 and prints configured=false)           => alertDeliveryObservability=deferred
//   (3) full topology: :9093 reachable AND webhook configured => alertDeliveryObservability=observed
// In every state `healthy` stays true — the metrics-only verdict must never depend on the topology.
//
// A closing MUTATION test removes the `ALERT_TOPOLOGY_DEFERRED="true"` assignment lines from a copy
// of the script and re-runs scenario (1); if the marker is not load-bearing, the mutated script would
// still (wrongly) report the same 'deferred' result the assignment is supposed to produce.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const realCheckScriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-check.sh')
const realCheckScriptSource = readFileSync(realCheckScriptPath, 'utf8')

const SSH_SHIM = `#!/usr/bin/env bash
# Mock ssh for the DT-CLOSE-01B full-script test. Ignores connection flags (-i/-o/host); dispatches
# on the trailing remote-command argument, which is where dingtalk-oauth-stability-check.sh's ssh_cmd()
# puts the actual remote command string.
args=("$@")
last_idx=$(( \${#args[@]} - 1 ))
cmd="\${args[$last_idx]}"

case "$cmd" in
  *127.0.0.1:8900/health*)
    printf '%s\\n' '{"status":"ok","ok":true,"plugins":5,"dbPool":{}}'
    exit 0
    ;;
  *127.0.0.1:8900/metrics/prom*)
    printf '%s\\n' 'metasheet_dingtalk_oauth_state_operations_total{result="ok"} 42'
    exit 0
    ;;
  *127.0.0.1:9093/api/v2/status*)
    if [ "\${MOCK_9093_UP:-true}" = "true" ]; then
      printf '%s\\n' '{"uptime":"1h2m"}'
      exit 0
    fi
    echo "ssh: connect to host 127.0.0.1 port 9093: Connection refused" >&2
    exit 7
    ;;
  *127.0.0.1:9093/api/v2/alerts*)
    if [ "\${MOCK_9093_UP:-true}" = "true" ]; then
      printf '%s\\n' '[]'
      exit 0
    fi
    echo "ssh: connect to host 127.0.0.1 port 9093: Connection refused" >&2
    exit 7
    ;;
  *metasheet-alertmanager*)
    printf '%s\\n' '0'
    exit 0
    ;;
  *metasheet-alert-webhook*)
    printf '%s\\n' '0'
    exit 0
    ;;
  *"df -P /"*)
    printf '%s\\n' '100 39 61 39%'
    exit 0
    ;;
  *)
    echo "mock-ssh: unrecognized remote command: $cmd" >&2
    exit 99
    ;;
esac
`

const WEBHOOK_CONFIG_STUB = `#!/usr/bin/env bash
# Stub for set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status, controlled per-scenario
# by STUB_WEBHOOK_CONFIGURED. Mirrors the real script's contract: it exits 0 in BOTH the configured and
# the reachable-but-unconfigured cases (only a missing/unreadable config *file* is "not configured" —
# that is still a clean, successful probe, not a probe failure).
if [ "\${1:-}" = "--print-status" ]; then
  if [ "\${STUB_WEBHOOK_CONFIGURED:-false}" = "true" ]; then
    printf '%s\\n' 'configured=true'
    printf '%s\\n' 'scheme=https'
    printf '%s\\n' 'host=hooks.slack.com'
    printf '%s\\n' 'path_length=10'
  else
    printf '%s\\n' 'configured=false'
  fi
  exit 0
fi
echo "unsupported mode: \${1:-}" >&2
exit 1
`

function makeSandbox({ checkScriptSource = realCheckScriptSource } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dingtalk-oauth-stability-fullscript-'))
  const opsDir = path.join(tmp, 'scripts', 'ops')
  const binDir = path.join(tmp, 'bin')
  mkdirSync(opsDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  const checkScriptDest = path.join(opsDir, 'dingtalk-oauth-stability-check.sh')
  writeFileSync(checkScriptDest, checkScriptSource)
  chmodSync(checkScriptDest, 0o755)

  const webhookStubDest = path.join(opsDir, 'set-dingtalk-onprem-alertmanager-webhook-config.sh')
  writeFileSync(webhookStubDest, WEBHOOK_CONFIG_STUB)
  chmodSync(webhookStubDest, 0o755)

  const sshShimDest = path.join(binDir, 'ssh')
  writeFileSync(sshShimDest, SSH_SHIM)
  chmodSync(sshShimDest, 0o755)

  return { tmp, checkScriptDest, binDir }
}

function cleanupSandbox(sandbox) {
  rmSync(sandbox.tmp, { recursive: true, force: true })
}

function runScript(sandbox, scenarioEnv) {
  const result = spawnSync('bash', [sandbox.checkScriptDest], {
    env: {
      PATH: `${sandbox.binDir}:${process.env.PATH || ''}`,
      HOME: sandbox.tmp,
      SSH_USER_HOST: 'mock@example.test',
      SSH_KEY: path.join(sandbox.tmp, 'fake-deploy-key'),
      JSON_OUTPUT: 'true',
      LOG_WINDOW: '24h',
      MAX_ROOT_USE_PERCENT: '95',
      DEPLOY_PATH: 'metasheet2',
      DEPLOY_COMPOSE_FILE: 'docker-compose.app.yml',
      ...scenarioEnv,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  })
  return result
}

function parseReport(result) {
  assert.equal(result.status, 0, `script exited non-zero: status=${result.status} stderr=${result.stderr}`)
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(`could not parse JSON stdout: ${err.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return report
}

test('state 1: :9093 refused (alert-topology probe failure) => deferred, healthy stays true', () => {
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, { MOCK_9093_UP: 'false', STUB_WEBHOOK_CONFIGURED: 'true' })
    const report = parseReport(result)
    assert.equal(report.alertDeliveryObservability, 'deferred', 'a refused :9093 probe must defer, even with a configured webhook')
    assert.equal(report.webhookConfig.configured, true)
    assert.equal(report.oauthMetricsPresent, true)
    assert.equal(report.healthy, true, 'the metrics-only verdict must stay healthy when only the alert topology is down')
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('state 2: :9093 reachable, webhook UNCONFIGURED (probe succeeds, configured=false) => deferred, healthy stays true', () => {
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, { MOCK_9093_UP: 'true', STUB_WEBHOOK_CONFIGURED: 'false' })
    const report = parseReport(result)
    assert.equal(report.webhookConfig.configured, false)
    assert.equal(
      report.alertDeliveryObservability,
      'deferred',
      'a successful-but-unconfigured webhook probe must NOT read as observed',
    )
    assert.equal(report.oauthMetricsPresent, true)
    assert.equal(report.healthy, true)
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('state 3: full topology (:9093 reachable AND webhook configured) => observed', () => {
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, { MOCK_9093_UP: 'true', STUB_WEBHOOK_CONFIGURED: 'true' })
    const report = parseReport(result)
    assert.equal(report.webhookConfig.configured, true)
    assert.equal(report.webhookConfig.host, 'hooks.slack.com')
    assert.equal(report.alertDeliveryObservability, 'observed', 'only the full topology may report observed')
    assert.equal(report.oauthMetricsPresent, true)
    assert.equal(report.healthy, true)
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('mutation: removing the ALERT_TOPOLOGY_DEFERRED="true" assignments desensitizes the :9093-refused case', () => {
  const assignmentLine = /^[ \t]*ALERT_TOPOLOGY_DEFERRED="true"[ \t]*\n/m
  assert.match(realCheckScriptSource, assignmentLine, 'sanity: the assignment line must exist in the real script before mutating')

  let mutated = realCheckScriptSource
  let removedCount = 0
  while (assignmentLine.test(mutated)) {
    mutated = mutated.replace(assignmentLine, '')
    removedCount += 1
  }
  assert.equal(removedCount, 3, 'expected exactly the 3 known ALERT_TOPOLOGY_DEFERRED="true" assignment lines to be removed')
  assert.doesNotMatch(mutated, /ALERT_TOPOLOGY_DEFERRED="true"/, 'mutation must fully remove the marker assignment')
  // The JSON/text fallbacks (ALERTMANAGER_STATUS_JSON='{}' etc.) and WEBHOOK_STATUS="configured=false"
  // must survive the mutation untouched — this proves the redness below comes from the missing MARKER,
  // not from a downstream JSON parse crash on an empty/garbage fallback value.
  assert.match(mutated, /ALERTMANAGER_STATUS_JSON='\{\}'/)
  assert.match(mutated, /ALERTS_JSON='\[\]'/)
  assert.match(mutated, /WEBHOOK_STATUS="configured=false"/)

  const sandbox = makeSandbox({ checkScriptSource: mutated })
  try {
    // Same scenario as "state 1" above: :9093 refused, webhook configured=true.
    const result = runScript(sandbox, { MOCK_9093_UP: 'false', STUB_WEBHOOK_CONFIGURED: 'true' })
    const report = parseReport(result)
    assert.notEqual(
      report.alertDeliveryObservability,
      'deferred',
      'with the marker assignment removed, a refused :9093 probe must NOT be caught anymore — proving the assignment is load-bearing',
    )
    assert.equal(report.alertDeliveryObservability, 'observed', 'without the marker, the script wrongly reports observed despite the refused probe')
  } finally {
    cleanupSandbox(sandbox)
  }
})
