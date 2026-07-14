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
//
// DT-CLOSE-02B: the six DINGTALK_DELIVERY_RETENTION_* keys below are the approval-card /
// person delivery retention family (dingtalk-card-person-delivery-retention.ts + its
// -scheduler.ts sibling, #4142) — a SEPARATE, already-implemented control plane from the
// DINGTALK_GROUP_DELIVERY_RETENTION_* family above (that one only touches
// dingtalk_group_deliveries; this one touches dingtalk_approval_card_deliveries +
// dingtalk_person_deliveries). Same NOT-included-here note applies to its own compiled-in
// constants: DINGTALK_DELIVERY_RETENTION_DEFAULT_DAYS (=90), _MIN_DAYS (=7), and
// _DEFAULT_BATCH (=5000) are exported `const` values, never read via `process.env` — they
// are documented as prose in the template DANGER comment, not enforced as settable keys.
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
  'DINGTALK_DELIVERY_RETENTION_DAYS',
  'DINGTALK_DELIVERY_RETENTION_DISABLED',
  'DINGTALK_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS',
  'ENABLE_DINGTALK_DELIVERY_RETENTION_LEADER_LOCK',
  'DINGTALK_DELIVERY_RETENTION_LEADER_LOCK_TTL_MS',
  'DINGTALK_DELIVERY_RETENTION_LEADER_LOCK_RETRY_MS',
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

// The three switches that are DANGEROUS if a template ships them turned ON: the deploy would
// enable mass-deprovision / re-infer every primary department / start the Stream client on the
// next redeploy. Presence alone is not enough for these — a live `KEY=true` in a template is a
// footgun. If the key is present as a LIVE (non-commented) assignment, it MUST be an off value.
// (Numeric defaults like MAX_BATCH=25 are intentionally NOT pinned to the code value here: the
// code defaults are computed IIFE/Math expressions, not extractable literals, so a source-vs-
// template numeric equality check would be brittle. Numeric-value drift is covered by the
// DT-CLOSE-04 switch-ruling ledger + review, not this contract — this test locks the one class
// that is both cheap to check and genuinely dangerous: a dangerous switch shipped ON.)
const MUST_BE_OFF_IF_LIVE = [
  'DIRECTORY_DEPROVISION_ENABLED',
  'DIRECTORY_PRIMARY_DEPT_FROM_ORDER',
  'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED',
]
const OFF_VALUES = new Set(['false', '0', 'no', 'off', ''])

for (const { label, path } of TEMPLATES) {
  test(`${label} template never ships a dangerous closeout switch turned ON`, () => {
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const key of MUST_BE_OFF_IF_LIVE) {
      // A LIVE assignment = the line is NOT commented out.
      const liveRe = new RegExp(`^\\s*${key}=(.*)$`)
      for (const line of lines) {
        const m = line.match(liveRe)
        if (!m) continue
        const value = m[1].trim().toLowerCase()
        assert.ok(
          OFF_VALUES.has(value),
          `${key} is shipped LIVE as '${m[1].trim()}' in ${path} — this switch must stay OFF ` +
            'by default (a deploy applying this template would enable a dangerous behavior). ' +
            'Ship it commented-out or =false.',
        )
      }
    }
  })
}

// DT-CLOSE-02B: DINGTALK_DELIVERY_RETENTION_DAYS is the ENABLE switch for the approval-card /
// person delivery retention sweep (dingtalk-card-person-delivery-retention.ts
// resolveDingTalkDeliveryRetentionConfig — a finite positive value is the ONLY thing that
// flips `disabled` to false; unset/blank/non-numeric/<=0 stays disabled). It mirrors the
// MUST_BE_OFF_IF_LIVE class above but with a stricter rule than "off": unlike a boolean
// switch, THIS key's off-state is the EMPTY string specifically — any live non-empty value
// (including '0' or a negative number) is a template drift from the intended "ship it blank"
// posture, and any live POSITIVE value silently auto-enables destructive/expiring behavior on
// the next deploy that applies this template.
for (const { label, path } of TEMPLATES) {
  test(`${label} template ships DINGTALK_DELIVERY_RETENTION_DAYS blank when live (never auto-enabling card/person retention)`, () => {
    const lines = readFileSync(path, 'utf8').split('\n')
    const liveRe = /^\s*DINGTALK_DELIVERY_RETENTION_DAYS=(.*)$/
    for (const line of lines) {
      const m = line.match(liveRe)
      if (!m) continue
      const value = m[1].trim()
      assert.equal(
        value,
        '',
        `DINGTALK_DELIVERY_RETENTION_DAYS is shipped LIVE with value '${value}' in ${path} — ` +
          'a positive value auto-ENABLES the approval-card/person delivery retention sweep ' +
          '(dingtalk_approval_card_deliveries + dingtalk_person_deliveries) on the next deploy ' +
          'applying this template. Ship it commented-out or blank so it stays disabled-by-' +
          'default until an operator explicitly opts in.',
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
