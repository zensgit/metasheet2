import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// DT-CLOSE-01C regression guard — the ARG_MAX / E2BIG failure of the scheduled
// "DingTalk OAuth Stability Recording (Lite)" workflow.
//
// THE BUG. dingtalk-oauth-stability-check.sh handed the scraped payloads to its embedded verdict
// python as environment variables:
//
//     WEBHOOK_STATUS_INPUT="${WEBHOOK_STATUS}" \
//     HEALTH_JSON_INPUT="${HEALTH_JSON}" \
//     METRICS_TEXT_INPUT="${METRICS_TEXT}" \
//     ...
//     python3 - <<'EOF'
//
// A process's argv and envp share ONE kernel budget (ARG_MAX; on Linux each individual string is
// additionally capped at MAX_ARG_STRLEN = 128 KiB, which `getconf` does not report). METRICS_TEXT is
// a full `/metrics/prom` scrape — unbounded, and it grows with the deploy host's metric cardinality.
// Once it crossed the limit, `execve()` returned E2BIG, which bash surfaces as:
//
//     scripts/ops/dingtalk-oauth-stability-check.sh: line 126: /usr/bin/python3: Argument list too long
//
// exiting 126. Every scheduled run then failed at the COMMAND level ("stability check command
// failed: rc=126") — a broken monitor, not an unhealthy host.
//
// THE FIX. The payloads are written into a `mktemp -d` scratch dir (removed by an EXIT trap) and
// passed as <NAME>_FILE paths. A path is a fixed ~40 bytes regardless of payload size.
//
// WHAT THIS TEST DOES. It drives the REAL script end to end against a mocked `ssh` whose
// `/metrics/prom` response is larger than the machine's actual `getconf ARG_MAX`, and asserts the run
// still succeeds. The closing block then REVERTS the fix on a copy of the script (rewriting the
// METRICS_TEXT_FILE line back to METRICS_TEXT_INPUT) and asserts the same scenario dies with a
// non-zero exit AND the literal "Argument list too long" on stderr — so the redness is provably
// E2BIG and not some unrelated crash. A small-payload control run of that same mutated script proves
// the redness comes from the payload SIZE, not from the mutation being malformed.
//
// Hermetic: no network, no deploy host, no docker. Everything is a PATH shim in a temp dir.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const realCheckScriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-check.sh')
const realCheckScriptSource = readFileSync(realCheckScriptPath, 'utf8')
const logProbeCmdsLibPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-log-probe-cmds.sh')
const logProbeCmdsLibSource = readFileSync(logProbeCmdsLibPath, 'utf8')

// The marker sample the verdict looks for; keep the count of these tiny so report assertions stay
// crisp even though the payload as a whole is multi-megabyte.
const OAUTH_SAMPLE = 'metasheet_dingtalk_oauth_state_operations_total{result="ok"} 42'

/** The machine's real ARG_MAX, read at runtime rather than hard-coded (it differs per platform). */
function resolveArgMax() {
  const probe = spawnSync('getconf', ['ARG_MAX'], { encoding: 'utf8' })
  const parsed = Number.parseInt((probe.stdout || '').trim(), 10)
  if (probe.status === 0 && Number.isFinite(parsed) && parsed > 0) {
    return { argMax: parsed, source: 'getconf ARG_MAX' }
  }
  // Fallback only if getconf is unavailable; 4 MiB exceeds every mainstream ARG_MAX.
  return { argMax: 4 * 1024 * 1024, source: 'fallback constant (getconf unavailable)' }
}

/** Major version of the `bash` that will run the script under test. */
function resolveBashMajorVersion() {
  const probe = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' })
  const parsed = Number.parseInt((probe.stdout || '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

const BASH_MAJOR_VERSION = resolveBashMajorVersion()
const { argMax: ARG_MAX, source: ARG_MAX_SOURCE } = resolveArgMax()
// Comfortably past the total budget on both Linux (~2 MiB) and macOS (1 MiB). On Linux the 128 KiB
// per-string MAX_ARG_STRLEN cap makes this fire far earlier still — either way, it fires.
const OVERSIZED_PAYLOAD_BYTES = ARG_MAX + 1024 * 1024

/**
 * Build a Prometheus-shaped payload of at least `targetBytes`. Padding uses a metric name that does
 * NOT match any prefix the verdict selects on, so `operationsSamples` stays at exactly one entry.
 */
function buildMetricsPayload(targetBytes) {
  const parts = [OAUTH_SAMPLE]
  let size = OAUTH_SAMPLE.length + 1
  let i = 0
  while (size < targetBytes) {
    const line = `metasheet_argmax_filler_bucket_total{series="padding",idx="${i}"} ${i}`
    parts.push(line)
    size += line.length + 1
    i += 1
  }
  return `${parts.join('\n')}\n`
}

const SSH_SHIM = `#!/usr/bin/env bash
# Mock ssh. Dispatches on the trailing remote-command argument (where ssh_cmd() puts the remote
# command string). The /metrics/prom response is streamed from MOCK_METRICS_FILE with cat, so the
# oversized payload never itself passes through an argv.
args=("$@")
last_idx=$(( \${#args[@]} - 1 ))
cmd="\${args[$last_idx]}"

case "$cmd" in
  *127.0.0.1:8900/health*)
    printf '%s\\n' '{"status":"ok","ok":true,"plugins":5,"dbPool":{}}'
    exit 0
    ;;
  *127.0.0.1:8900/metrics/prom*)
    cat "\${MOCK_METRICS_FILE}"
    exit 0
    ;;
  *127.0.0.1:9093/api/v2/status*)
    printf '%s\\n' '{"uptime":"1h2m"}'
    exit 0
    ;;
  *127.0.0.1:9093/api/v2/alerts*)
    printf '%s\\n' '[]'
    exit 0
    ;;
  *metasheet-alertmanager*)
    printf '%s\\n' '0'
    exit 0
    ;;
  *resolved*)
    printf '%s\\n' '1'
    exit 0
    ;;
  *metasheet-alert-webhook*)
    printf '%s\\n' '2'
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

// remote_authed_curl's heredoc runs `docker compose ... exec -T backend` on the REMOTE, i.e. inside
// the ssh shim above — which never executes it — so no docker stub is needed here.

const WEBHOOK_CONFIG_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = "--print-status" ]; then
  printf '%s\\n' 'configured=true'
  printf '%s\\n' 'scheme=https'
  printf '%s\\n' 'host=hooks.slack.com'
  printf '%s\\n' 'path_length=10'
  exit 0
fi
echo "unsupported mode: \${1:-}" >&2
exit 1
`

function makeSandbox({ checkScriptSource = realCheckScriptSource } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dingtalk-oauth-stability-argmax-'))
  const opsDir = path.join(tmp, 'scripts', 'ops')
  const binDir = path.join(tmp, 'bin')
  // The script's own scratch dir is created under TMPDIR; pointing TMPDIR at a dedicated, initially
  // empty directory lets us assert afterwards that the EXIT trap actually cleaned it up.
  const scratchDir = path.join(tmp, 'script-tmpdir')
  mkdirSync(opsDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(scratchDir, { recursive: true })

  const checkScriptDest = path.join(opsDir, 'dingtalk-oauth-stability-check.sh')
  writeFileSync(checkScriptDest, checkScriptSource)
  chmodSync(checkScriptDest, 0o755)

  const logProbeCmdsDest = path.join(opsDir, 'dingtalk-oauth-stability-log-probe-cmds.sh')
  writeFileSync(logProbeCmdsDest, logProbeCmdsLibSource)
  chmodSync(logProbeCmdsDest, 0o755)

  const webhookStubDest = path.join(opsDir, 'set-dingtalk-onprem-alertmanager-webhook-config.sh')
  writeFileSync(webhookStubDest, WEBHOOK_CONFIG_STUB)
  chmodSync(webhookStubDest, 0o755)

  const sshShimDest = path.join(binDir, 'ssh')
  writeFileSync(sshShimDest, SSH_SHIM)
  chmodSync(sshShimDest, 0o755)

  return { tmp, checkScriptDest, binDir, scratchDir }
}

function cleanupSandbox(sandbox) {
  rmSync(sandbox.tmp, { recursive: true, force: true })
}

function runScript(sandbox, metricsPayload) {
  const metricsFile = path.join(sandbox.tmp, 'metrics.prom')
  writeFileSync(metricsFile, metricsPayload)
  return spawnSync('bash', [sandbox.checkScriptDest], {
    env: {
      PATH: `${sandbox.binDir}:${process.env.PATH || ''}`,
      HOME: sandbox.tmp,
      TMPDIR: sandbox.scratchDir,
      MOCK_METRICS_FILE: metricsFile,
      SSH_USER_HOST: 'mock@example.test',
      SSH_KEY: path.join(sandbox.tmp, 'fake-deploy-key'),
      JSON_OUTPUT: 'true',
      LOG_WINDOW: '24h',
      MAX_ROOT_USE_PERCENT: '95',
      DEPLOY_PATH: 'metasheet2',
      DEPLOY_COMPOSE_FILE: 'docker-compose.app.yml',
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  })
}

test(`a /metrics/prom payload LARGER than ARG_MAX (${OVERSIZED_PAYLOAD_BYTES} bytes > ${ARG_MAX} from ${ARG_MAX_SOURCE}) still produces a verdict`, () => {
  const payload = buildMetricsPayload(OVERSIZED_PAYLOAD_BYTES)
  assert.ok(
    payload.length > ARG_MAX,
    `sanity: the fixture must exceed ARG_MAX (payload=${payload.length}, ARG_MAX=${ARG_MAX})`,
  )

  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, payload)
    assert.equal(
      result.status,
      0,
      `an oversized metrics scrape must not fail the script (this is the rc=126 regression). ` +
        `status=${result.status} stderr=${result.stderr}`,
    )
    assert.doesNotMatch(
      result.stderr,
      /Argument list too long/,
      'the payload must never reach execve() as an argument or environment string',
    )

    const report = JSON.parse(result.stdout)
    assert.equal(report.oauthMetricsPresent, true, 'the OAuth sample inside the huge payload must still be found')
    assert.deepEqual(
      report.metrics.operationsSamples,
      [OAUTH_SAMPLE],
      'the verdict must parse the real sample out of the padding, not just survive',
    )
    assert.equal(report.healthy, true)
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('values-free: the oversized payload body is never echoed to stdout or stderr', () => {
  const payload = buildMetricsPayload(OVERSIZED_PAYLOAD_BYTES)
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, payload)
    assert.equal(result.status, 0, `stderr=${result.stderr}`)
    // The report legitimately contains the selected OAuth sample lines; what must NOT happen is the
    // raw scrape (padding included) being dumped into the logs the workflow uploads.
    assert.doesNotMatch(result.stdout, /metasheet_argmax_filler_bucket_total/, 'raw scrape must not be echoed to stdout')
    assert.doesNotMatch(result.stderr, /metasheet_argmax_filler_bucket_total/, 'raw scrape must not be echoed to stderr')
    assert.ok(result.stdout.length < payload.length, 'the report must be a projection, not a copy of the scrape')
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('the scratch payload dir is removed by the EXIT trap (no plaintext scrape left behind)', () => {
  const sandbox = makeSandbox()
  try {
    const result = runScript(sandbox, buildMetricsPayload(OVERSIZED_PAYLOAD_BYTES))
    assert.equal(result.status, 0, `stderr=${result.stderr}`)

    const leftovers = readdirSync(sandbox.scratchDir)
    assert.deepEqual(
      leftovers,
      [],
      `the mktemp scratch dir must be removed by the EXIT trap; found leftovers: ${JSON.stringify(leftovers)}`,
    )
    // And it must never be written under output/, which the recording workflow uploads as an artifact.
    assert.doesNotMatch(
      realCheckScriptSource,
      /PAYLOAD_DIR="\$\(mktemp -d "?\$\{?ROOT_DIR/,
      'the scratch dir must not live under the repo/output tree',
    )
    assert.equal(statSync(sandbox.scratchDir).isDirectory(), true)
  } finally {
    cleanupSandbox(sandbox)
  }
})

// -------------------------------------------------------------------------------------------------
// RED-UNDER-REVERT. Mutate the real script back to the pre-fix env-var handoff and prove the
// oversized scenario dies with E2BIG. If someone reverts the fix, the first test above goes red;
// this block proves that redness is caused by the env-var handoff specifically.
// -------------------------------------------------------------------------------------------------

const FIXED_METRICS_HANDOFF = 'METRICS_TEXT_FILE="${PAYLOAD_DIR}/metrics.prom" \\\n'
const REVERTED_METRICS_HANDOFF = 'METRICS_TEXT_INPUT="${METRICS_TEXT}" \\\n'

function revertFixToEnvVarHandoff() {
  assert.ok(
    realCheckScriptSource.includes(FIXED_METRICS_HANDOFF),
    'sanity: the script must pass METRICS_TEXT by file path before we can revert it',
  )
  const mutated = realCheckScriptSource.replace(FIXED_METRICS_HANDOFF, REVERTED_METRICS_HANDOFF)
  assert.ok(mutated.includes(REVERTED_METRICS_HANDOFF), 'mutation must apply')
  assert.ok(!mutated.includes(FIXED_METRICS_HANDOFF), 'mutation must remove the file-path handoff')
  return mutated
}

test('mutation: reverting METRICS_TEXT to an env var makes the oversized payload die with E2BIG', (t) => {
  const sandbox = makeSandbox({ checkScriptSource: revertFixToEnvVarHandoff() })
  try {
    const result = runScript(sandbox, buildMetricsPayload(OVERSIZED_PAYLOAD_BYTES))
    // Emitted so the CI step log PROVES whether the version-gated rc==126 pin executed on this
    // machine. `node --test` reports the same "pass" either way, so without this line a reader
    // cannot tell an applied pin from a skipped one.
    t.diagnostic(
      `bash_major=${BASH_MAJOR_VERSION} reverted_rc=${result.status} ` +
        `rc126_pin=${BASH_MAJOR_VERSION >= 4 ? 'APPLIED' : 'SKIPPED (bash < 4 collapses set -e aborts to 1)'}`,
    )
    assert.notEqual(result.status, 0, 'the reverted script must fail on an oversized payload')
    assert.match(
      result.stderr,
      /Argument list too long/,
      `the failure must be E2BIG specifically, not an unrelated crash. status=${result.status} stderr=${result.stderr}`,
    )
    // The exact production signature. bash maps a command it could not execute to 126, and under
    // `set -e` bash >= 4 propagates that 126 as the script's own exit status — which is precisely the
    // `STABILITY_RC: 126` the failing scheduled runs reported. bash 3.2 (the stock macOS bash) is the
    // outlier: it collapses every `set -e` abort to 1, so pin 126 only where it is meaningful. The
    // CI runner is Linux/bash 5, so this assertion is live in CI.
    if (BASH_MAJOR_VERSION >= 4) {
      assert.equal(
        result.status,
        126,
        `bash ${BASH_MAJOR_VERSION}.x must surface the failed execve as rc=126 — the exact rc the scheduled runs showed`,
      )
    }
  } finally {
    cleanupSandbox(sandbox)
  }
})

test('control: the SAME reverted script succeeds on a small payload — the redness above is caused by SIZE, not by a malformed mutation', () => {
  const sandbox = makeSandbox({ checkScriptSource: revertFixToEnvVarHandoff() })
  try {
    const result = runScript(sandbox, `${OAUTH_SAMPLE}\n`)
    assert.equal(
      result.status,
      0,
      `the reverted script must still work on a small payload, proving the mutation is well-formed. stderr=${result.stderr}`,
    )
    const report = JSON.parse(result.stdout)
    assert.equal(report.oauthMetricsPresent, true)
    assert.equal(report.healthy, true)
  } finally {
    cleanupSandbox(sandbox)
  }
})
