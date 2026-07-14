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
//
// OWNER P2 FOLLOW-UP: the three docker-logs match-count probes (ALERTMANAGER_ERROR_COUNT,
// BRIDGE_NOTIFY_COUNT, BRIDGE_RESOLVED_COUNT) had the SAME subshell-assignment bug PLUS a second,
// worse one: `docker logs ... 2>&1 | grep ... | wc -l` masks a `docker logs` failure (container
// missing) as a successful zero count, because `wc -l` always exits 0 regardless of what fed it — so
// even a correctly-placed parent-shell fallback would never fire. State 4 below pins the fix: a
// metasheet-alert-webhook docker-logs probe failure must still defer, even with :9093 reachable and
// the webhook configured. The pipeline strings themselves are built by the sourced
// dingtalk-oauth-stability-log-probe-cmds.sh; a dedicated block further down runs those EXACT strings
// under bash with a stubbed `docker` on PATH (no ssh layer at all) to prove the fail-honest contract
// for real, since the ssh-shim states below only ever see a canned exit code, never the actual pipe.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const realCheckScriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-check.sh')
const realCheckScriptSource = readFileSync(realCheckScriptPath, 'utf8')
const logProbeCmdsLibPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-log-probe-cmds.sh')
const logProbeCmdsLibSource = readFileSync(logProbeCmdsLibPath, 'utf8')

const SSH_SHIM = `#!/usr/bin/env bash
# Mock ssh for the DT-CLOSE-01B full-script test. Ignores connection flags (-i/-o/host); dispatches
# on the trailing remote-command argument, which is where dingtalk-oauth-stability-check.sh's ssh_cmd()
# puts the actual remote command string. MOCK_BRIDGE_LOGS_UP (default true) controls whether the
# metasheet-alert-webhook docker-logs probes (BRIDGE_NOTIFY_COUNT / BRIDGE_RESOLVED_COUNT) succeed;
# 'false' simulates a "No such container" docker failure for BOTH (they target the same container).
# This shim only ever returns a canned exit code/output for the whole remote command — it does not
# actually execute the pipeline, so it cannot by itself prove the pipeline is fail-honest; that is
# proven separately, below, by running the real pipeline strings under bash with a stubbed docker.
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
  *resolved*)
    # BRIDGE_RESOLVED_COUNT's pipeline (the two-grep chain) is the only one whose remote command
    # string contains "resolved" — must be matched BEFORE the generic metasheet-alert-webhook case
    # below, since both target that same container name.
    if [ "\${MOCK_BRIDGE_LOGS_UP:-true}" = "true" ]; then
      printf '%s\\n' '1'
      exit 0
    fi
    echo "Error: No such container: metasheet-alert-webhook" >&2
    exit 1
    ;;
  *metasheet-alert-webhook*)
    if [ "\${MOCK_BRIDGE_LOGS_UP:-true}" = "true" ]; then
      printf '%s\\n' '2'
      exit 0
    fi
    echo "Error: No such container: metasheet-alert-webhook" >&2
    exit 1
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

function makeSandbox({ checkScriptSource = realCheckScriptSource, logProbeCmdsSource = logProbeCmdsLibSource } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dingtalk-oauth-stability-fullscript-'))
  const opsDir = path.join(tmp, 'scripts', 'ops')
  const binDir = path.join(tmp, 'bin')
  mkdirSync(opsDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  const checkScriptDest = path.join(opsDir, 'dingtalk-oauth-stability-check.sh')
  writeFileSync(checkScriptDest, checkScriptSource)
  chmodSync(checkScriptDest, 0o755)

  // dingtalk-oauth-stability-check.sh `source`s this lib (via ROOT_DIR, which resolves to `tmp` in
  // the sandbox) to build the log-probe pipeline strings — without a sandbox copy, `set -euo pipefail`
  // would abort the whole script on the failed `source`, killing every test in this file, not just the
  // log-probe ones.
  const logProbeCmdsDest = path.join(opsDir, 'dingtalk-oauth-stability-log-probe-cmds.sh')
  writeFileSync(logProbeCmdsDest, logProbeCmdsSource)
  chmodSync(logProbeCmdsDest, 0o755)

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

test('state 3: full topology (:9093 reachable AND webhook configured) => observed, log-probe counts reflect successful reads', () => {
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, { MOCK_9093_UP: 'true', STUB_WEBHOOK_CONFIGURED: 'true' })
    const report = parseReport(result)
    assert.equal(report.webhookConfig.configured, true)
    assert.equal(report.webhookConfig.host, 'hooks.slack.com')
    assert.equal(report.alertDeliveryObservability, 'observed', 'only the full topology may report observed')
    assert.equal(report.oauthMetricsPresent, true)
    assert.equal(report.healthy, true)
    // 'observed' must mean the docker-logs probes actually succeeded, not just that :9093 answered and
    // the webhook is configured — pin the shim's distinct, non-zero counts through to the report so a
    // regression that stops threading these counts through (e.g. reverting to the old `|| printf 0`
    // fallback path) would surface here even though it wouldn't flip alertDeliveryObservability itself.
    assert.equal(report.alertmanager.notifyErrorsLastWindow, 0)
    assert.equal(report.bridge.notifyEventsLastWindow, 2)
    assert.equal(report.bridge.resolvedEventsLastWindow, 1)
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('state 4: :9093 reachable + webhook configured, but the metasheet-alert-webhook docker-logs probe FAILS => deferred, healthy stays true', () => {
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, {
      MOCK_9093_UP: 'true',
      STUB_WEBHOOK_CONFIGURED: 'true',
      MOCK_BRIDGE_LOGS_UP: 'false',
    })
    const report = parseReport(result)
    assert.equal(report.webhookConfig.configured, true, ':9093 and the webhook config are both fine — only the log probe itself failed')
    assert.equal(
      report.alertDeliveryObservability,
      'deferred',
      'a docker-logs probe failure ("No such container") for the alert-webhook bridge must defer, not read as observed',
    )
    assert.equal(report.bridge.notifyEventsLastWindow, 0, 'a failed probe must fall back to 0, not report a fabricated count')
    assert.equal(report.bridge.resolvedEventsLastWindow, 0)
    assert.equal(report.oauthMetricsPresent, true)
    assert.equal(report.healthy, true, 'the metrics-only verdict must stay healthy when only the bridge log probe is down')
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('mutation: removing the ALERT_TOPOLOGY_DEFERRED="true" assignments desensitizes the :9093-refused case', () => {
  // There are now SIX such assignment lines (the 3 original status/alerts/webhook probes plus the 3
  // log-probe else-branches added for the docker-logs masking fix). This test's SCENARIO (:9093
  // refused, webhook configured=true, log probes left succeeding via the ssh-shim defaults) only ever
  // exercises the two :9093 branches — it does NOT, by itself, prove the three NEW log-probe branches
  // are load-bearing; that is what the dedicated "state 4" bridge-down test above guards permanently,
  // and what the one-time OWNER P2 mutation proof (see PR description) demonstrated directly on the
  // live script. This test only asserts that blanket-removing every occurrence of the marker
  // assignment (all 6) still desensitizes the :9093-refused path, as a regression tripwire on the
  // marker text itself.
  const assignmentLine = /^[ \t]*ALERT_TOPOLOGY_DEFERRED="true"[ \t]*\n/m
  assert.match(realCheckScriptSource, assignmentLine, 'sanity: the assignment line must exist in the real script before mutating')

  let mutated = realCheckScriptSource
  let removedCount = 0
  while (assignmentLine.test(mutated)) {
    mutated = mutated.replace(assignmentLine, '')
    removedCount += 1
  }
  assert.equal(removedCount, 6, 'expected exactly the 6 known ALERT_TOPOLOGY_DEFERRED="true" assignment lines to be removed')
  assert.doesNotMatch(mutated, /ALERT_TOPOLOGY_DEFERRED="true"/, 'mutation must fully remove the marker assignment')
  // The JSON/text fallbacks (ALERTMANAGER_STATUS_JSON='{}' etc.), WEBHOOK_STATUS="configured=false",
  // and the three log-probe count fallbacks must survive the mutation untouched — this proves the
  // redness below comes from the missing MARKER, not from a downstream JSON parse crash or a missing
  // fallback value.
  assert.match(mutated, /ALERTMANAGER_STATUS_JSON='\{\}'/)
  assert.match(mutated, /ALERTS_JSON='\[\]'/)
  assert.match(mutated, /WEBHOOK_STATUS="configured=false"/)
  assert.match(mutated, /ALERTMANAGER_ERROR_COUNT="0"/)
  assert.match(mutated, /BRIDGE_NOTIFY_COUNT="0"/)
  assert.match(mutated, /BRIDGE_RESOLVED_COUNT="0"/)

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

// ---------------------------------------------------------------------------------------------
// Raw pipeline-string tests: no ssh layer at all. These run the EXACT string
// dingtalk-oauth-stability-log-probe-cmds.sh's builder functions produce, under real bash, against a
// stubbed `docker` on PATH. This is what actually proves the FAIL-HONEST contract closes the masking
// gap for real — the ssh-shim states above only ever see a canned exit code for the whole remote
// command (set by this test file), so they cannot by themselves distinguish "the pipeline is
// fail-honest" from "the shim happened to hard-code the right exit code".
// ---------------------------------------------------------------------------------------------

const DOCKER_STUB = `#!/usr/bin/env bash
# Stub docker for the raw pipeline-string tests. Purely env-var driven so one stub script can serve
# every fixture without per-probe variants.
if [ "\${MOCK_DOCKER_EXIT:-0}" != "0" ]; then
  echo "Error: No such container" >&2
  exit "\${MOCK_DOCKER_EXIT}"
fi
printf '%s' "\${MOCK_DOCKER_STDOUT:-}"
exit 0
`

function generateLogProbeCmd(fnName) {
  const result = spawnSync('bash', ['-c', `source ${JSON.stringify(logProbeCmdsLibPath)}; LOG_WINDOW=24h ${fnName}`], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `failed to generate ${fnName}: ${result.stderr}`)
  assert.ok(result.stdout.length > 0, `${fnName} produced an empty command string`)
  return result.stdout
}

function runLogProbeCmd(cmd, { dockerExit = '0', dockerStdout = '' } = {}) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'dingtalk-oauth-stability-docker-stub-'))
  const dockerDest = path.join(binDir, 'docker')
  writeFileSync(dockerDest, DOCKER_STUB)
  chmodSync(dockerDest, 0o755)
  try {
    return spawnSync('bash', ['-c', cmd], {
      env: {
        PATH: `${binDir}:${process.env.PATH || ''}`,
        MOCK_DOCKER_EXIT: dockerExit,
        MOCK_DOCKER_STDOUT: dockerStdout,
      },
      encoding: 'utf8',
      timeout: 15000,
    })
  } finally {
    rmSync(binDir, { recursive: true, force: true })
  }
}

const LOG_PROBE_CMD_CASES = [
  {
    fn: 'alertmanager_error_count_cmd',
    matchingLine: '2026-07-13T00:00:00Z ERROR Notify for alerts failed: dial tcp timeout',
    nonMatchingLine: '2026-07-13T00:00:00Z INFO heartbeat ok',
  },
  {
    fn: 'bridge_notify_count_cmd',
    matchingLine: '{"path": "/notify", "status": "ok"}',
    nonMatchingLine: '{"path": "/health", "status": "ok"}',
  },
  {
    fn: 'bridge_resolved_count_cmd',
    matchingLine: '{"path": "/notify", "status": "resolved"}',
    nonMatchingLine: '{"path": "/notify", "status": "ok"}',
  },
]

for (const { fn, matchingLine, nonMatchingLine } of LOG_PROBE_CMD_CASES) {
  test(`log-probe pipeline string (${fn}): docker logs failure => NON-ZERO pipeline exit (the masking gap, closed)`, () => {
    const cmd = generateLogProbeCmd(fn)
    const result = runLogProbeCmd(cmd, { dockerExit: '1' })
    assert.notEqual(
      result.status,
      0,
      `a docker-logs failure must make the pipeline exit non-zero; got status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${result.stderr}`,
    )
  })

  test(`log-probe pipeline string (${fn}): docker ok + zero matches => exit 0, prints "0"`, () => {
    const cmd = generateLogProbeCmd(fn)
    const result = runLogProbeCmd(cmd, { dockerExit: '0', dockerStdout: `${nonMatchingLine}\n` })
    assert.equal(result.status, 0, `stderr=${result.stderr}`)
    assert.equal(result.stdout.trim(), '0')
  })

  test(`log-probe pipeline string (${fn}): docker ok + N matching lines => exit 0, prints "N"`, () => {
    const cmd = generateLogProbeCmd(fn)
    const dockerStdout = `${matchingLine}\n${nonMatchingLine}\n${matchingLine}\n`
    const result = runLogProbeCmd(cmd, { dockerExit: '0', dockerStdout })
    assert.equal(result.status, 0, `stderr=${result.stderr}`)
    assert.equal(result.stdout.trim(), '2')
  })
}
