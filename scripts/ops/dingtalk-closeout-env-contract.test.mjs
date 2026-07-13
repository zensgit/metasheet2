import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// DT-CLOSE-02 contract guard.
//
// The DingTalk directory-sync / interactive-card closeout switches (deprovision, primary-dept
// inference, OAuth shared-state store, interactive-card Stream, group-delivery retention,
// directory-sync alerting/heartbeat/lease, corp allowlist, container login) are read straight
// from process.env with NO other reproducible record of what a production/staging deploy is
// running. If a deploy template silently drops one of these, the next redeploy resets it to
// the code default with no operator warning — exactly the failure mode DT-CLOSE-01 hit for
// the OAuth-stability metrics scrape.
//
// This test pins that every key below appears in BOTH docker/app.env.example (production) and
// docker/app.staging.env.example (staging), each preceded by an explanatory comment line, so a
// deployment stays reproducible. It intentionally does NOT require a specific value — templates
// are allowed to ship the safe/conservative default (commented or live `KEY=value`); the point
// is that the key + its guidance exist at all.
//
// CANONICAL KEY LIST — keep this in sync with packages/core-backend/src (grep for
// `process.env.DIRECTORY_*` / `process.env.DINGTALK_*` under directory/ and
// integrations/dingtalk/ + auth/dingtalk-oauth.ts + services/dingtalk-group-delivery-retention*).
//
// NOT included here on purpose: DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS (=7) and
// DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS (=90) are exported `const` values in
// dingtalk-group-delivery-retention.ts, never read via `process.env` — adding them as `KEY=`
// template lines would be a template an operator could "set" that the code silently ignores.
// They are documented as prose in the DINGTALK_GROUP_DELIVERY_RETENTION_DAYS comment block
// instead (see the second test below), not enforced as settable keys.
const CLOSEOUT_ENV_KEYS = [
  'DIRECTORY_DEPROVISION_ENABLED',
  'DIRECTORY_DEPROVISION_MAX_BATCH',
  'DIRECTORY_PRIMARY_DEPT_FROM_ORDER',
  'DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE',
  'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED',
  'DINGTALK_GROUP_DELIVERY_RETENTION_DAYS',
  'DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED',
  'DINGTALK_GROUP_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS',
  'DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK_TTL_MS',
  'DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK_RETRY_MS',
  'DIRECTORY_INACTIVE_LINKED_ALERT_DAYS',
  'DIRECTORY_SYNC_ALERT_WEBHOOK',
  'DIRECTORY_SYNC_ALERT_WEBHOOK_SECRET',
  'DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS',
  'DIRECTORY_SYNC_LEASE_STALE_MINUTES',
  'DINGTALK_ALLOWED_CORP_IDS',
  'DINGTALK_CONTAINER_LOGIN_ENABLED',
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const TEMPLATES = [
  { label: 'production', path: join(REPO_ROOT, 'docker', 'app.env.example') },
  { label: 'staging', path: join(REPO_ROOT, 'docker', 'app.staging.env.example') },
]

/**
 * Locate the (possibly commented-out) assignment line for `key` and return its 0-based line
 * index, or -1 if absent. Anchored so `DIRECTORY_SYNC_ALERT_WEBHOOK=` never matches the
 * `DIRECTORY_SYNC_ALERT_WEBHOOK_SECRET=` line: the literal `=` must follow the key immediately.
 */
function findAssignmentLineIndex(lines, key) {
  const re = new RegExp(`^#?\\s*${key}=`)
  return lines.findIndex((line) => re.test(line))
}

/** The nearest non-blank line above `index`, or null if none / file start. */
function nearestPrecedingNonBlankLine(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

for (const { label, path } of TEMPLATES) {
  test(`${label} deploy template documents every DingTalk closeout env key`, () => {
    const text = readFileSync(path, 'utf8')
    const lines = text.split('\n')

    for (const key of CLOSEOUT_ENV_KEYS) {
      const lineIndex = findAssignmentLineIndex(lines, key)
      assert.notEqual(
        lineIndex,
        -1,
        `${key} is missing from ${path} — every DingTalk directory-sync/interactive-card ` +
          'closeout switch must appear in the deploy template so a deployment is reproducible.',
      )

      const precedingLine = nearestPrecedingNonBlankLine(lines, lineIndex)
      assert.ok(
        precedingLine !== null && precedingLine.startsWith('#'),
        `${key} in ${path} has no preceding comment line explaining what it does / the ` +
          'danger of mis-setting it.',
      )
    }
  })
}

test('production and staging templates both carry the closeout switches header', () => {
  for (const { path } of TEMPLATES) {
    const text = readFileSync(path, 'utf8')
    assert.match(
      text,
      /# --- DingTalk directory-sync & interactive-card closeout switches ---/,
      `${path} is missing the DT-CLOSE-02 closeout switches section header`,
    )
  }
})

test('the RETENTION_DAYS entry documents that MIN_DAYS/DEFAULT_DAYS are NOT env-settable', () => {
  // Guards against someone "helpfully" turning the disclaimer into a fake env line, or
  // deleting it and letting an operator believe MIN_DAYS/DEFAULT_DAYS do something.
  for (const { path } of TEMPLATES) {
    const text = readFileSync(path, 'utf8')
    assert.match(
      text,
      /DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS.*_MIN_DAYS.*COMPILED-IN CONSTANTS|DEFAULT_DAYS \/ _MIN_DAYS[\s\S]{0,200}COMPILED-IN CONSTANTS/,
      `${path} must document that RETENTION_MIN_DAYS/DEFAULT_DAYS are compiled-in constants, not env vars`,
    )
    assert.doesNotMatch(
      text,
      /^#?\s*DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS=/m,
      `${path} must NOT define DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS as a settable env line — it is a compiled-in constant the code never reads from process.env`,
    )
    assert.doesNotMatch(
      text,
      /^#?\s*DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS=/m,
      `${path} must NOT define DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS as a settable env line — it is a compiled-in constant the code never reads from process.env`,
    )
  }
})
