import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// DT-CLOSE-01 contract guard. `/metrics/prom` is token-gated (metrics.ts
// createMetricsAuthMiddleware requires METRICS_SCRAPE_TOKEN), so the OAuth-stability
// recording must scrape it WITH the token or go blind on HTTP 401. This test pins the
// authenticated-scrape shape so that removing the auth (the exact regression that broke
// the recording) turns this test red — a load-bearing mutation guard, not decoration.

const __dirname = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(__dirname, 'dingtalk-oauth-stability-check.sh'), 'utf8')

test('the /metrics/prom scrape goes through the authed helper, not a bare unauthenticated curl', () => {
  // The metrics scrape must use the token-resolving helper.
  assert.match(
    script,
    /METRICS_TEXT="\$\(remote_authed_curl "http:\/\/127\.0\.0\.1:8900\/metrics\/prom"\)"/,
    'metrics scrape must call remote_authed_curl (regression: a bare ssh_cmd curl 401s)',
  )
  // And it must NOT be the old unauthenticated form.
  assert.doesNotMatch(
    script,
    /METRICS_TEXT="\$\(ssh_cmd "curl -fsS http:\/\/127\.0\.0\.1:8900\/metrics\/prom"\)"/,
    'metrics scrape must not revert to the unauthenticated ssh_cmd curl',
  )
})

test('the authed helper attaches the x-metrics-token header from the backend runtime token', () => {
  assert.match(script, /remote_authed_curl\(\)/, 'remote_authed_curl helper must exist')
  // Token is read from the backend container runtime env (same source as resolve-metrics-scrape-token.sh).
  assert.match(
    script,
    /exec -T backend sh -lc 'printf "%s" "\$\{METRICS_SCRAPE_TOKEN:-\}"'/,
    'token must be read from the backend container runtime METRICS_SCRAPE_TOKEN',
  )
  // The header must be applied when a token exists.
  assert.match(
    script,
    /curl -fsS -H "x-metrics-token: \$\{token\}" "\$\{URL\}"/,
    'a resolved token must be sent as the x-metrics-token header',
  )
})

test('secret-safe: the token is resolved on the remote and never printed or echoed', () => {
  // The token is only ever used inside the remote heredoc; it must not be echoed anywhere.
  assert.doesNotMatch(script, /echo[^\n]*\$\{?token\}?/i, 'token must never be echoed')
  assert.doesNotMatch(script, /printf[^\n]*token[^\n]*>&2/i, 'token must never be printed to stderr')
  // The remote heredoc quoting must be single-quoted so the token stays remote (not interpolated
  // by the runner-side shell into the ssh argv).
  assert.match(script, /bash -s" <<'REMOTE'/, 'remote token resolution must run in a quoted heredoc (token stays on the host)')
})

test('unauthenticated fallback only when the backend has no token (auth disabled)', () => {
  assert.match(
    script,
    /else\s*\n\s*# No token configured on the backend[^\n]*\n\s*curl -fsS "\$\{URL\}"/,
    'the bare curl must be reachable ONLY in the no-token branch',
  )
})
