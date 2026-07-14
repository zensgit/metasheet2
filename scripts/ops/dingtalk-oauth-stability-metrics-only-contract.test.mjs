import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// DT-CLOSE-01B contract guard — the OAuth-stability recording is METRICS-ONLY.
//
// The verdict (`report['healthy']`) previously required the alert-DELIVERY topology (webhook
// configured, Slack host, alertmanager notify errors == 0). That topology is not deployable from
// main, so every scheduled run failed with `curl (7) :9093` — the OAuth monitor going blind on an
// unrelated, undeployed concern. This test pins the decoupling BEHAVIORALLY (it runs the embedded
// verdict Python), so re-coupling the verdict to the alert topology, or removing the OAuth-metrics
// signal from it, turns red.

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, 'dingtalk-oauth-stability-check.sh')
const script = readFileSync(scriptPath, 'utf8')

function extractVerdictPython() {
  const m = script.match(/python3 - <<'EOF'\n([\s\S]*?)\nEOF/)
  assert.ok(m, 'could not find the embedded verdict python block')
  return m[1]
}

function runVerdict(env) {
  const base = {
    WEBHOOK_STATUS_INPUT: 'configured=false',
    HEALTH_JSON_INPUT: '{"status":"ok","ok":true,"plugins":5,"dbPool":{}}',
    METRICS_TEXT_INPUT: 'metasheet_dingtalk_oauth_state_operations_total{result="ok"} 42',
    ALERTMANAGER_STATUS_JSON_INPUT: '{}',
    ALERTS_JSON_INPUT: '[]',
    ALERTMANAGER_ERROR_COUNT_INPUT: '0',
    BRIDGE_NOTIFY_COUNT_INPUT: '0',
    BRIDGE_RESOLVED_COUNT_INPUT: '0',
    ROOT_DF_LINE_INPUT: '100 39 61 39%',
    SSH_USER_HOST_INPUT: 'test@host',
    LOG_WINDOW_INPUT: '24h',
    MAX_ROOT_USE_PERCENT_INPUT: '95',
    JSON_OUTPUT_INPUT: 'true',
    ALERT_TOPOLOGY_DEFERRED_INPUT: 'false',
  }
  const r = spawnSync('python3', ['-c', extractVerdictPython()], {
    env: { ...base, ...env },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `verdict python aborted: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('healthy OAuth + DEFERRED alert topology => healthy=true (verdict does not require the topology)', () => {
  const report = runVerdict({ ALERT_TOPOLOGY_DEFERRED_INPUT: 'true', WEBHOOK_STATUS_INPUT: 'configured=false' })
  assert.equal(report.healthy, true, 'a healthy OAuth signal must pass even when the alert topology is absent')
  assert.equal(report.alertDeliveryObservability, 'deferred')
  assert.equal(report.oauthMetricsPresent, true)
})

test('positive control: NO OAuth operation metrics => healthy=false', () => {
  const report = runVerdict({ METRICS_TEXT_INPUT: 'some_other_metric 1' })
  assert.equal(report.oauthMetricsPresent, false)
  assert.equal(report.healthy, false, 'the verdict must actually depend on the OAuth metrics being present')
})

test('storage over max => healthy=false (storage headroom still gates)', () => {
  const report = runVerdict({ ROOT_DF_LINE_INPUT: '100 97 3 97%' })
  assert.equal(report.healthy, false)
})

test('a broken/absent Slack webhook does NOT fail the verdict (decoupled)', () => {
  // Explicitly the regression this fixes: no webhook, notify errors present -> still healthy if OAuth is.
  const report = runVerdict({
    ALERT_TOPOLOGY_DEFERRED_INPUT: 'true',
    WEBHOOK_STATUS_INPUT: 'configured=false',
    ALERTMANAGER_ERROR_COUNT_INPUT: '99',
  })
  assert.equal(report.healthy, true, 'alert-delivery failures must NOT drag down the OAuth-stability verdict')
})

test('source guard: the verdict expression references OAuth metrics, not the alert topology', () => {
  const verdict = script.match(/report\['healthy'\] = \(([\s\S]*?)\)/)
  assert.ok(verdict, 'could not find the report[healthy] assignment')
  const expr = verdict[1]
  assert.match(expr, /oauth_metrics_present/, 'verdict must gate on the OAuth metrics signal')
  assert.doesNotMatch(expr, /webhookConfig|alertmanager|hooks\.slack\.com/, 'verdict must NOT re-couple to the alert-delivery topology')
})

test('the alert-topology probes are soft (a failure marks deferred via a PARENT-SHELL if/else, never aborts under set -e)', () => {
  // Regression guard for the subshell bug: `WEBHOOK_STATUS="$(cmd || { ALERT_TOPOLOGY_DEFERRED=true; ... })"`
  // sets the marker INSIDE the `$( ... )` command substitution (a subshell), so the assignment is lost and
  // the parent-shell ALERT_TOPOLOGY_DEFERRED silently stays "false" even when the probe failed. The fix
  // must use a parent-shell `if <probe>; then :; else ALERT_TOPOLOGY_DEFERRED="true"; ... fi` for every
  // probe that marks deferred, so the assignment actually propagates.
  assert.doesNotMatch(
    script,
    /\$\([^)]*ALERT_TOPOLOGY_DEFERRED="true"[^)]*\)/,
    'ALERT_TOPOLOGY_DEFERRED must never be assigned inside a $( ... ) command substitution (subshell) — the assignment would be lost',
  )
  for (const probe of [
    'ALERTMANAGER_STATUS_JSON',
    'ALERTS_JSON',
    'WEBHOOK_STATUS',
    // The three docker-logs match-count probes are held to the same parent-shell if/else shape —
    // they were the second instance of the subshell-assignment bug (plus wc -l masking the docker
    // failure entirely; see dingtalk-oauth-stability-log-probe-cmds.sh for that half of the fix).
    'ALERTMANAGER_ERROR_COUNT',
    'BRIDGE_NOTIFY_COUNT',
    'BRIDGE_RESOLVED_COUNT',
  ]) {
    const re = new RegExp(
      `if ${probe}="\\$\\([^\\n]*"; then\\n\\s*:\\n\\s*else\\n\\s*ALERT_TOPOLOGY_DEFERRED="true"\\n\\s*${probe}=`,
    )
    assert.match(script, re, `${probe} must set ALERT_TOPOLOGY_DEFERRED from a parent-shell if/else on failure`)
  }
})

test('three-state alertDeliveryObservability: observed requires BOTH no probe failure AND webhook configured', () => {
  // (1) probe failure alone (webhook happens to report configured=true) => deferred.
  const probeFailed = runVerdict({
    ALERT_TOPOLOGY_DEFERRED_INPUT: 'true',
    WEBHOOK_STATUS_INPUT: 'configured=true\nscheme=https\nhost=hooks.slack.com\npath_length=10',
  })
  assert.equal(probeFailed.webhookConfig.configured, true)
  assert.equal(probeFailed.alertDeliveryObservability, 'deferred', 'a failed alert-topology probe must defer even if the webhook is configured')

  // (2) probes all succeeded, but the webhook is reachable-and-UNCONFIGURED (config script exits 0,
  // prints configured=false) => deferred. This is the owner-required three-state case: a successful
  // exit code from the config probe is NOT the same as having delivery observability.
  const unconfigured = runVerdict({
    ALERT_TOPOLOGY_DEFERRED_INPUT: 'false',
    WEBHOOK_STATUS_INPUT: 'configured=false',
  })
  assert.equal(unconfigured.webhookConfig.configured, false)
  assert.equal(unconfigured.alertDeliveryObservability, 'deferred', 'a reachable-but-unconfigured webhook must NOT read as observed')

  // (3) full topology: no probe failure AND webhook configured => observed.
  const full = runVerdict({
    ALERT_TOPOLOGY_DEFERRED_INPUT: 'false',
    WEBHOOK_STATUS_INPUT: 'configured=true\nscheme=https\nhost=hooks.slack.com\npath_length=10',
  })
  assert.equal(full.webhookConfig.configured, true)
  assert.equal(full.alertDeliveryObservability, 'observed', 'observed requires BOTH no probe failure and a configured webhook')
})
