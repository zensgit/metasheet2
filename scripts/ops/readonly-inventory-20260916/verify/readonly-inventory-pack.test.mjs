// ============================================================================
// readonly-inventory-pack.test.mjs — `node --test` layer over run-verify.mjs
// ============================================================================
// LAYER 1 (hermetic, no database): static contract checks on the four pack
//   files — every file includes _preamble.sql, ends with an INVENTORY_RESULT
//   statement, contains no write statements, (F3) no longer carries the
//   textual `"url":"http://` predicate, and (F6) computes its ACTIONABLE
//   http:// count from the executor's read paths only, keeping the old `$.**`
//   sweep alongside as an explicitly-labelled upper bound.
// LAYER 2 (DATABASE_URL-gated): the full synthetic-PostgreSQL verification —
//   modern + legacy fixtures, F3/F4 positive+negative cases, and the
//   abort-⇒-incomplete evidence. Skipped LOUDLY without DATABASE_URL; when
//   METASHEET_REAL_DB_TEST_STEP=1 a missing DATABASE_URL or a missing `psql`
//   binary FAILS instead of skipping (fail-not-skip, same discipline as
//   scripts/ops/approval-s1-evidence-replay-gate.test.mjs).
//
// The database this needs is a THROWAWAY, SYNTHETIC one (the harness creates
// and drops its own `inventory_fixture_*` schemas). It must never be pointed at
// a production database.
//
// Suggested CI lane: a small standalone `postgres:16` service job modelled on
// .github/workflows/approval-s1-evidence-replay-gate-realdb.yml (no app deps —
// this test uses only Node built-ins plus the runner's psql), path-filtered on
// scripts/ops/readonly-inventory-20260916/**. Wiring is left to the coordinator.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTERNAL_TARGET_CASES, psqlAvailable, verifyAll } from './run-verify.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
const FILES = [
  '01-cred06-secret-keys.sql',
  '02-trg04-http-targets.sql',
  '03-adm08-wildcard-permissions.sql',
  '04-adm13-declared-admins.sql', '05-trg04-webhook-target-totals.sql', '06-trg04-button-webhook-totals.sql', '07-bpmn-table-totals.sql',
]

// ── LAYER 1 — hermetic ──────────────────────────────────────────────────────

test('every pack file includes the shared preamble (single execution mode, ON_ERROR_STOP)', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(PACK, f), 'utf8')
    assert.match(src, /^\\ir _preamble\.sql$/m, `${f} must \\ir _preamble.sql`)
  }
  const pre = fs.readFileSync(path.join(PACK, '_preamble.sql'), 'utf8')
  assert.match(pre, /\\set ON_ERROR_STOP on/)
  assert.match(pre, /SET default_transaction_read_only = on;/)
  assert.match(pre, /SET statement_timeout/)
  assert.match(pre, /SET lock_timeout/)
})

test('every pack file ends with its INVENTORY_RESULT completion statement (F5)', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(PACK, f), 'utf8')
    assert.match(src, new RegExp(`INVENTORY_RESULT file=${f.replace(/\./g, '\\.')} status=`),
      `${f} must print its own INVENTORY_RESULT line`)
    const tail = src.trimEnd().split('\n').slice(-1)[0]
    assert.match(tail, /(\) p|END AS inventory_result);$/, `${f}'s last statement must be the completion query`)
  }
})

test('the pack is read-only (no write statements anywhere)', () => {
  const forbidden = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|SCHEMA)|DROP\s+|ALTER\s+|TRUNCATE|GRANT\s|REVOKE\s)/i
  for (const f of [...FILES, '_preamble.sql']) {
    for (const [i, line] of fs.readFileSync(path.join(PACK, f), 'utf8').split('\n').entries()) {
      if (/^\s*--/.test(line)) continue
      assert.ok(!forbidden.test(line), `${f}:${i + 1} looks like a write statement: ${line.trim()}`)
    }
  }
})

test('F3: the broken textual http predicate is gone and the semantic one is in', () => {
  const src = fs.readFileSync(path.join(PACK, '02-trg04-http-targets.sql'), 'utf8')
  const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  assert.ok(!/ILIKE\s*'%"url":"http/.test(code),
    'the space-sensitive `%"url":"http://%` text scan must not be used any more')
  assert.match(code, /jsonb_path_query\(\s*ar\.actions,\s*'\$\.\*\*'\s*\)/)
  assert.match(code, /jsonb_each_text/)
})

// F6 read paths, transcribed from the code that dereferences them:
//   automation-executor.ts:4199  (config.url, via the dispatch at :2591)
//   automation-executor.ts:2348, :2378        (config.branches[*].actions)
//   automation-executor.ts:2342, :2372-2373   (config.defaultBranch.actions)
//   automation-executor.ts:2247               (parallel config.branches[*].actions)
// Save-time validation forbids a third level (automation-service.ts:874, :877,
// :902, :905), so this list is exhaustive.
const NARROW_READ_PATHS = [
  "'$[*].config.url'",
  "'$[*].config.branches[*].actions[*].config.url'",
  "'$[*].config.defaultBranch.actions[*].config.url'",
]

/**
 * Body of every `EXISTS ( … ) AS <alias>` predicate, matched from the alias
 * BACKWARDS to its own `EXISTS` (a forward non-greedy scan would run from one
 * predicate's opening paren into the NEXT predicate's alias and mix the two).
 */
function predicateBodies(code, alias) {
  const bodies = []
  const re = new RegExp('\\)\\s*AS\\s+' + alias, 'g')
  let m
  while ((m = re.exec(code)) !== null) {
    const start = code.lastIndexOf('EXISTS', m.index)
    assert.ok(start >= 0, `no EXISTS opens the ${alias} predicate at offset ${m.index}`)
    bodies.push(code.slice(start, m.index))
  }
  return bodies
}

test('F6: the actionable http predicate matches read paths only; $.** survives as the labelled upper bound', () => {
  const src = fs.readFileSync(path.join(PACK, '02-trg04-http-targets.sql'), 'utf8')
  const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

  for (const p of NARROW_READ_PATHS) {
    assert.ok(code.includes(p), `narrow predicate must address ${p}`)
  }

  // Every `narrow_hit` definition must be recursion-free …
  const narrow = predicateBodies(code, 'narrow_hit')
  assert.ok(narrow.length >= 3, `expected >=3 narrow_hit predicates, found ${narrow.length}`)
  for (const body of narrow) {
    assert.ok(!body.includes('$.**'),
      'a narrow predicate must not recurse into user-authored body/headers with $.**')
    assert.ok(!/weburl|webhookurl|endpointurl|targeturl|callbackurl/.test(body),
      'the never-read key aliases must not be back in the actionable predicate')
  }

  // … and every `upper_bound_hit` definition must still BE the old wide sweep,
  // so narrowing never silently drops the number owner used to see.
  const bound = predicateBodies(code, 'upper_bound_hit')
  assert.ok(bound.length >= 3, `expected >=3 upper_bound_hit predicates, found ${bound.length}`)
  for (const body of bound) {
    assert.ok(body.includes('$.**'), 'the upper bound must keep the wide recursion')
    assert.ok(body.includes('callbackurl'), 'the upper bound must keep the old key allowlist')
  }

  // Both numbers must reach the operator.
  assert.match(code, /AS\s+http_rules,/)
  assert.match(code, /AS\s+http_rules_upper_bound/)
})

test('F4 (not regressed): 02-trg04 count and ids come from one identical hit CTE', () => {
  const src = fs.readFileSync(path.join(PACK, '02-trg04-http-targets.sql'), 'utf8')
  const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  // Q2 (count) and Q3 (ids) must define the SAME `hit` CTE, character for
  // character, and Q3 must filter on the CTE's booleans — not on some other
  // row shape. That is what makes |ids| == count an assertable invariant.
  const ctes = [...code.matchAll(/WITH hit AS \(([\s\S]*?)\n\)\n/g)].map(m => m[1])
  const rulesCtes = ctes.filter(c => c.includes('FROM automation_rules ar'))
  assert.equal(rulesCtes.length, 3, 'Q2 + Q3 + Q4 each define their own hit CTE')
  assert.equal(rulesCtes[0], rulesCtes[1], 'Q2 and Q3 must share a character-identical hit CTE')
  assert.match(code, /FROM hit\n WHERE narrow_hit OR upper_bound_hit/,
    'the id query must filter on the shared CTE booleans')
})

test('F4: 01-cred06 filters ids on the hit predicate, not on object shape', () => {
  const src = fs.readFileSync(path.join(PACK, '01-cred06-secret-keys.sql'), 'utf8')
  const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  const idFilters = code.match(/WHERE matched_top_level OR matched_headers/g) || []
  assert.equal(idFilters.length, 4, 'two counts + two id queries share one filter')
  assert.ok(!/^\s*WHERE jsonb_typeof\(ds\.(config|connection)/m.test(code),
    'the shape-only row filter that over-listed ids must be gone')
})

// ── LAYER 2 — synthetic PostgreSQL ──────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
const REAL_DB_STEP = process.env.METASHEET_REAL_DB_TEST_STEP === '1'

test('sentinel: the DB-backed step must have DATABASE_URL and psql (fail-not-skip)', () => {
  if (REAL_DB_STEP && !DATABASE_URL) {
    assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is missing — this must FAIL, not skip')
  }
  if (REAL_DB_STEP && !psqlAvailable()) {
    assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but `psql` is not on PATH — cannot run the synthetic proof')
  }
})

if (!DATABASE_URL || !psqlAvailable()) {
  test('SYNTHETIC-DB LAYER SKIPPED — no DATABASE_URL / psql', { skip: true }, () => {})
  process.stderr.write(
    '\n*** readonly-inventory-pack: synthetic-PostgreSQL layer SKIPPED (no DATABASE_URL or no psql). ' +
      'Point DATABASE_URL at a THROWAWAY local/container Postgres to run it. ***\n'
  )
} else {
  test('synthetic PostgreSQL: F3 / F4 / F5 / F6 / F7 on both schema shapes', async () => {
    const r = await verifyAll()
    // F3 — the repaired predicate finds every shape of http target on a read
    // path (top level, branch, defaultBranch, spaced layout, HTTP:// value) …
    assert.equal(r.modern.f3.httpRules, 6)
    // … and the pre-repair textual predicate found NONE of them.
    assert.equal(r.modern.f3.oldHttp, 0)
    // F6 — the narrowed count is strictly smaller than the wide reading, the
    // wide reading is still reported (as the upper bound), and the two rows in
    // the gap are the non-target http:// strings.
    assert.equal(r.modern.f6.httpRulesBound, 8)
    assert.equal(r.modern.f6.oldWideHttp, r.modern.f6.httpRulesBound)
    assert.ok(r.modern.f6.httpRules < r.modern.f6.httpRulesBound)
    assert.equal(r.modern.f6.listedIds.length, r.modern.f6.httpRulesBound)
    assert.equal(r.legacy.f6Legacy.legacyCol, 1)
    assert.equal(r.legacy.f6Legacy.legacyColBound, 2)
    // F4 — ids == count, and the pre-repair id predicate over-listed.
    assert.equal(r.modern.f4.ids.length, r.modern.f4.count)
    assert.ok(r.modern.f4.oldIdRows > r.modern.f4.count)
    // F5 — complete on the modern schema, incomplete (not zero) on the legacy one.
    for (const line of [r.modern.r01, r.modern.r02, r.modern.r03, r.modern.r04]) {
      assert.match(line, /status=complete/)
    }
    assert.match(r.legacy.r02, /status=incomplete reason=missing-column:automation_rules\.actions/)
    assert.match(r.legacy.r04, /status=incomplete reason=missing-column:users\.is_admin users\.is_active/)
    // F5 — an aborted run leaves no completion line behind.
    assert.notEqual(r.lockTimeout.exit, 0)
    assert.match(r.permissionDenied.resultLine ?? '', /status=incomplete/)
    // F7 — Q7's host set agrees with every guard-derived case (asserted case
    // by case inside checkInternalTargetCases), end to end on both fixtures,
    // and the old prefix literal was wrong in BOTH directions on the same table.
    assert.equal(r.internalTargets.cases, INTERNAL_TARGET_CASES.length)
    assert.ok(r.internalTargets.oldMissed > 0, 'the old literal missed guard-refused hosts')
    assert.ok(r.internalTargets.oldExtra > 0, 'the old literal counted hosts the guard lets through')
    assert.equal(r.modern.f7.q7Webhooks, 3)
    assert.notEqual(r.modern.f7.oldQ7Webhooks, r.modern.f7.q7Webhooks)
  })
}

// ── LAYER 1 (cont.) — F7, hermetic ──────────────────────────────────────────
// Placed after LAYER 2 so the line numbers ops-sql-pack-verify.yml cites for
// the sentinel above stay where they are.

test('F7: all three Q7 predicates use ONE \\gset host pattern, defined outside any \\if', () => {
  const src = fs.readFileSync(path.join(PACK, '02-trg04-http-targets.sql'), 'utf8').replace(/\r\n/g, '\n')
  const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  const defs = [...code.matchAll(/AS inv_internal_target_re\n\s*FROM v6\n\\gset$/gm)]
  assert.equal(defs.length, 1, 'exactly one definition of the Q7 host pattern')
  const use = "~* :'inv_internal_target_re'"
  assert.equal(code.split(use).length - 1, 3, 'Q7 narrow, Q7 upper bound and Q7 webhooks all use it')
  assert.ok(!/~\*\s*'/.test(code), 'no inline host regex literal may sit beside it')
  // The webhook half of Q7 also runs on schemas where the automation_rules
  // half is skipped, so the definition must precede every use and sit at
  // \if depth 0.
  const before = code.slice(0, defs[0].index)
  assert.ok(!before.includes(use), 'the pattern must be defined before its first use')
  const depth = (before.match(/^\\if /gm) || []).length - (before.match(/^\\endif\b/gm) || []).length
  assert.equal(depth, 0, 'the \\gset must not sit inside an \\if block')
})

test('F7: the guard-derived case table covers every host class at its exact edges', () => {
  const counted = new Set(INTERNAL_TARGET_CASES.filter(c => c[1]).map(c => c[0]))
  const skipped = new Set(INTERNAL_TARGET_CASES.filter(c => !c[1]).map(c => c[0]))
  for (const u of ['https://172.16.0.0/', 'https://172.31.255.255/', 'https://fake-svc.internal/x',
    'https://printer.local', 'https://api.localhost/', 'https://[fc00::1]/', 'https://[febf:ffff::1]/',
    'https://[::ffff:ac1f:ffff]/', 'https://a@b@172.16.0.1/', 'https://10.0.0.1:0065535/']) {
    assert.ok(counted.has(u), `case table must count ${u}`)
  }
  for (const u of ['https://172.15.255.255/', 'https://172.32.0.0/', 'https://[::ffff:ac0f:ffff]/',
    'https://[::ffff:ac20:0]/', 'https://[fec0::1]/', 'https://10.fake.invalid/', 'https://10.0.0.1:65536/',
    // 2026-09-27 (#6104 gap): the ::ffff: hex-form boundary one step past
    // each of c0a8 / a9fe / 7f / 0a must stay out too.
    'https://[::ffff:c0a9:0]/', 'https://[::ffff:b00:1]/', 'https://[::ffff:7eff:1]/',
    'https://[::ffff:a9ff:1]/']) {
    assert.ok(skipped.has(u), `case table must NOT count ${u}`)
  }
})

// ── 05 / 06 (2026-11-05): webhook-target totals ─────────────────────────────
// 05-trg04-webhook-target-totals.sql counts EVERY send_webhook target and
// subscription in four buckets (url_missing / not_https /
// https_internal_literal / https_other). It is the same SQL that ran on site
// on 2026-11-05 under the name 03-webhook-target-totals.sql.
// 06-trg04-button-webhook-totals.sql counts button fields whose action is
// send_webhook, in one row of six counts (https_hostname is the number that
// matters for R81). FILES above makes the preamble / INVENTORY_RESULT /
// read-only tests cover both.
// Imported here rather than at the top so the sentinel line numbers that
// ops-sql-pack-verify.yml cites stay put (import declarations are hoisted).
import {
  checkInternalTargetCases,
  checkWebhookTotalsReadOnly,
  checkButtonWebhookTotalsReadOnly,
  runWebhookTotals,
  runButtonWebhookTotals,
  withFixture,
  WEBHOOK_TOTALS_FIXTURE,
  BUTTON_WEBHOOKS_FIXTURE,
} from './run-verify.mjs'

const FILE_05 = '05-trg04-webhook-target-totals.sql'
const FILE_06 = '06-trg04-button-webhook-totals.sql'

/** A pack file's internal-host block: from `WITH atom AS (` through its `\gset`. */
function hostSetBlock(file) {
  const src = fs.readFileSync(path.join(PACK, file), 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf('WITH atom AS (')
  assert.ok(start >= 0, `${file}: no WITH atom AS ( block`)
  assert.equal(src.indexOf('WITH atom AS (', start + 1), -1, `${file}: more than one WITH atom AS ( block`)
  const endMarker = '\n\\gset\n'
  const end = src.indexOf(endMarker, start)
  assert.ok(end > start, `${file}: the host block has no \\gset`)
  return src.slice(start, end + endMarker.length)
}

/** Non-comment source of a pack file (CRLF-normalised). */
function packCode(file) {
  const src = fs.readFileSync(path.join(PACK, file), 'utf8').replace(/\r\n/g, '\n')
  return src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
}

for (const [tag, file] of [['05', FILE_05], ['06', FILE_06]]) {
  test(`${tag}: the internal-host regex block is byte-equal to 02 (drift guard)`, () => {
    const b02 = hostSetBlock('02-trg04-http-targets.sql')
    const b = hostSetBlock(file)
    assert.match(b, /AS inv_internal_target_re\n\s*FROM v6\n\\gset\n$/)
    assert.equal(b, b02, `${tag} must flag exactly the internal hosts 02 flags: copy the block, do not edit it`)
  })

  test(`${tag}: SET transaction_read_only = on; comes right after \\ir _preamble.sql`, () => {
    const code = packCode(file).split('\n').filter(l => l.trim() !== '')
    assert.equal(code[0], '\\ir _preamble.sql', 'the preamble include is the first statement')
    assert.equal(code[1], 'SET transaction_read_only = on;',
      'the open transaction (psql -1 / AUTOCOMMIT off) must be made read-only before anything else runs')
    assert.equal(code.filter(l => /transaction_read_only/.test(l)).length, 1)
  })
}

/** The last statement of a pack file must be its own INVENTORY_RESULT SELECT. */
function assertResultIsLast(file) {
  const code = packCode(file)
  const lastStmt = code.slice(code.trimEnd().slice(0, -1).lastIndexOf(';') + 1)
  assert.ok(lastStmt.includes(`SELECT 'INVENTORY_RESULT file=${file} status='`),
    `${file}: the INVENTORY_RESULT query must be the last statement`)
}

test('05: values-free selects and the INVENTORY_RESULT query is the last statement', () => {
  assertResultIsLast(FILE_05)
  const code = packCode(FILE_05)
  // Values-free: the two result queries select the flag plus counts, nothing else.
  for (const flag of ['enabled', 'active']) {
    const m = code.match(new RegExp(`\\nSELECT s\\.${flag},\\n([\\s\\S]*?)\\n  FROM \\(VALUES \\(true\\), \\(false\\)\\)`))
    assert.ok(m, `05: no result query keyed on s.${flag}`)
    for (const line of m[1].split('\n')) {
      assert.match(line, /^\s+count\(/, `05: the s.${flag} result query may select counts only: ${line.trim()}`)
    }
  }
})

test('06: values-free selects and the INVENTORY_RESULT query is the last statement', () => {
  assertResultIsLast(FILE_06)
  const code = packCode(FILE_06)
  // Values-free: the B1 result query selects counts, nothing else.
  const m = code.match(/\nSELECT (count\(\*\)[\s\S]*?)\n {2}FROM target;/)
  assert.ok(m, '06: no B1 result query over `target`')
  for (const line of m[1].split('\n')) {
    assert.match(line.trim(), /^count\(/, `06: the B1 result query may select counts only: ${line.trim()}`)
  }
})

/** Shared assertions for the one-transaction read-only witness (05 and 06). */
function assertReadOnlyWitness({ before, single, autocommitOff, control }) {
  for (const [mode, o] of [['-1', single], ['AUTOCOMMIT=off', autocommitOff]]) {
    assert.notEqual(o.exit, 0, `${mode}: an injected UPDATE must abort the run`)
    assert.match(o.stderr, /\b25006\b/, `${mode}: the abort must be read_only_sql_transaction (25006)`)
    assert.equal(o.result, null, `${mode}: an aborted run must print NO INVENTORY_RESULT line`)
    assert.equal(o.nameAfter, before, `${mode}: the row must be unchanged`)
  }
  // Control: with the SET line replaced by the same UPDATE, the write commits
  // under -1 even though the preamble set default_transaction_read_only.
  assert.equal(control.exit, 0, `control run exited ${control.exit}: ${control.stderr}`)
  assert.match(control.result ?? '', /status=complete/)
  assert.equal(control.nameAfter, 'witness', 'without the SET, the preamble alone does not stop the write')
}

// Each DB test builds and drops its own throwaway schema, so one red check
// cannot take the others down with it.
const onTotalsFixture = fn => withFixture('inventory_fixture_totals', WEBHOOK_TOTALS_FIXTURE, fn)
const onButtonsFixture = fn => withFixture('inventory_fixture_buttons', BUTTON_WEBHOOKS_FIXTURE, fn)

if (!DATABASE_URL || !psqlAvailable()) {
  test('05/06 SYNTHETIC-DB CHECKS SKIPPED — no DATABASE_URL / psql', { skip: true }, () => {})
} else {
  test('synthetic PostgreSQL: 05 sorts every target into the four buckets (modern shape)', () => {
    const r = { totals: onTotalsFixture(runWebhookTotals) }
    // enabled | webhook_rules | targets | url_missing | not_https | https_internal_literal | https_other
    assert.deepEqual(r.totals.rules, ['t|10|10|3|3|3|1', 'f|2|3|1|1|0|1'])
    // active | webhooks | url_missing | not_https | https_internal_literal | https_other
    assert.deepEqual(r.totals.webhooks, ['t|4|0|1|2|1', 'f|2|1|0|1|0'])
    assert.equal(r.totals.result,
      'INVENTORY_RESULT file=05-trg04-webhook-target-totals.sql status=complete scope=automation_rules+multitable_webhooks')
  })

  test('synthetic PostgreSQL: 05 reports missing columns as incomplete, never as zero', () => {
    const r = {
      legacy: withFixture('inventory_fixture_legacy', 'fixture-legacy.sql', runWebhookTotals),
      modern: withFixture('inventory_fixture_modern', 'fixture-modern.sql', runWebhookTotals),
      empty: withFixture('inventory_fixture_empty', null, runWebhookTotals),
    }
    // fixture-legacy.sql: automation_rules has neither `actions` nor `enabled`.
    // Its three subscriptions: http (not_https), https public, https [fe80::1].
    assert.equal(r.legacy.rules, null, 'R1 must be skipped, not printed as zeros')
    assert.deepEqual(r.legacy.webhooks, ['t|3|0|1|1|1', 'f|0|0|0|0|0'])
    assert.equal(r.legacy.result,
      'INVENTORY_RESULT file=05-trg04-webhook-target-totals.sql status=incomplete reason=missing-columns:automation_rules scope=multitable_webhooks-only')
    // fixture-modern.sql's hand subset also lacks `automation_rules.enabled`, so
    // its rules are not counted either. Its nine subscriptions: active 8 =
    // 3 not_https (w-http, w-http-upper, w-internal is http://) + 2 internal
    // (w-internal-172, w-internal-v6, the same two https rows 02's Q7 counts)
    // + 3 other (w-https, w-public-172, w-prefix-decoy); inactive 1 = w-http-off.
    assert.equal(r.modern.rules, null)
    assert.deepEqual(r.modern.webhooks, ['t|8|0|3|2|3', 'f|1|0|1|0|0'])
    assert.match(r.modern.result, /status=incomplete reason=missing-columns:automation_rules scope=multitable_webhooks-only$/)
    // An empty schema: both halves skipped.
    assert.equal(r.empty.rules, null)
    assert.equal(r.empty.webhooks, null)
    assert.match(r.empty.result,
      /status=incomplete reason=missing-columns:automation_rules\+multitable_webhooks scope=none$/)
  })

  test('synthetic PostgreSQL: 05 host pattern agrees with every guard-derived case (same table as 02)', () => {
    // checkInternalTargetCases runs 05 itself, then matches the F7 case table
    // against 05's own \gset pattern in the same session (asserting each case).
    const r = onTotalsFixture(s => checkInternalTargetCases(s, FILE_05))
    assert.equal(r.cases, INTERNAL_TARGET_CASES.length)
  })

  test('synthetic PostgreSQL: 05 stays read-only inside one transaction (psql -X -1, AUTOCOMMIT=off)', () => {
    const r = onTotalsFixture(checkWebhookTotalsReadOnly)
    assert.equal(r.before, '<null>')
    assertReadOnlyWitness(r)
  })

  test('synthetic PostgreSQL: 06 sorts every button webhook into its bucket', () => {
    const r = onButtonsFixture(runButtonWebhookTotals)
    // button_webhooks | url_missing | refused_both | https_ip_literal | https_hostname | unclassified
    // (no other fixture here creates meta_fields; the row breakdown is in the fixture header)
    assert.deepEqual(r.buttons, ['14|3|4|2|3|2'])
    assert.equal(r.result, 'INVENTORY_RESULT file=06-trg04-button-webhook-totals.sql status=complete scope=meta_fields')
  })

  test('synthetic PostgreSQL: 06 reports a missing meta_fields as incomplete, never as zero', () => {
    const r = withFixture('inventory_fixture_empty', null, runButtonWebhookTotals)
    assert.equal(r.buttons, null, 'B1 must be skipped, not printed as zeros')
    assert.equal(r.result,
      'INVENTORY_RESULT file=06-trg04-button-webhook-totals.sql status=incomplete reason=missing-columns:meta_fields scope=none')
  })

  test('synthetic PostgreSQL: 06 host pattern agrees with every guard-derived case (same table as 02)', () => {
    const r = onButtonsFixture(s => checkInternalTargetCases(s, FILE_06))
    assert.equal(r.cases, INTERNAL_TARGET_CASES.length)
  })

  test('synthetic PostgreSQL: 06 stays read-only inside one transaction (psql -X -1, AUTOCOMMIT=off)', () => {
    const r = onButtonsFixture(checkButtonWebhookTotalsReadOnly)
    assert.equal(r.before, 'n')
    assertReadOnlyWitness(r)
  })
}

// ── 07 (2026-11-06): row counts of the 11 legacy BPMN tables ────────────────
// 07-bpmn-table-totals.sql is the BPMN-removal pre-check (owner ruling
// 2026-11-06: approvals and automation do not use BPMN; runtime and designer
// are deprecated). It prints one row per bpmn_* table (name + count(*)) and
// its INVENTORY_RESULT line. FILES above makes the preamble / INVENTORY_RESULT
// / read-only tests cover it.
import {
  runBpmnTableTotals,
  runBpmnTableTotalsAsLimitedRole,
  checkBpmnTableTotalsReadOnly,
  exec,
  BPMN_TABLES_FIXTURE,
} from './run-verify.mjs'

const FILE_07 = '07-bpmn-table-totals.sql'

// The tables packages/core-backend/src/db/migrations/zz20251231_create_bpmn_tables.ts
// creates, in 07's B1 order. Typed here rather than read from the migration so
// this suite keeps reading nothing outside its own pack directory.
const BPMN_TABLES = [
  'bpmn_process_definitions', 'bpmn_process_instances', 'bpmn_activity_instances',
  'bpmn_user_tasks', 'bpmn_timer_jobs', 'bpmn_message_events', 'bpmn_signal_events',
  'bpmn_variables', 'bpmn_incidents', 'bpmn_external_tasks', 'bpmn_audit_log',
]

test('07: SET transaction_read_only = on; comes right after \\ir _preamble.sql', () => {
  const code = packCode(FILE_07).split('\n').filter(l => l.trim() !== '')
  assert.equal(code[0], '\\ir _preamble.sql', 'the preamble include is the first statement')
  assert.equal(code[1], 'SET transaction_read_only = on;',
    'the open transaction (psql -1 / AUTOCOMMIT off) must be made read-only before anything else runs')
  assert.equal(code.filter(l => /transaction_read_only/.test(l)).length, 1)
})

test('07: probe and B1 cover exactly the 11 core bpmn_* tables plus the optional bpmn_deployments, B1 selects only name + count(*), INVENTORY_RESULT is last', () => {
  assertResultIsLast(FILE_07)
  const code = packCode(FILE_07)

  // Probe: the IN (...) list is the same 11 names, and the threshold is 11.
  const probe = code.match(/AND table_name IN \(([\s\S]*?)\)\n\\gset/)
  assert.ok(probe, '07: no probe over information_schema.tables')
  const probed = [...probe[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...probed].sort(), [...BPMN_TABLES].sort(), '07: the probe must list exactly the 11 tables')
  assert.match(code, /SELECT :bpmn_tables_present = 11 AS has_all/)
  assert.match(code, /'complete scope=bpmn_tables:11'/)
  assert.match(code, /'incomplete reason=missing-tables:' \|\| \(11 - :bpmn_tables_present\)/)

  // B1: values-free. The outer query selects the literal name and the count;
  // every branch is `SELECT <ord>, '<table>', count(*) FROM <same table>`.
  const b1 = code.match(/\nSELECT table_name, row_count FROM \(\n([\s\S]*?)\n\) t ORDER BY ord;/)
  assert.ok(b1, '07: no B1 query of the form SELECT table_name, row_count FROM (...) t ORDER BY ord')
  const branch = /^\s*(?:UNION ALL )?SELECT\s+(\d+)(?: AS ord)?, '(bpmn_[a-z_]+)'(?: AS table_name)?,\s+count\(\*\)(?:::bigint AS row_count)? FROM (bpmn_[a-z_]+)$/
  const lines = b1[1].split('\n')
  assert.equal(lines.length, BPMN_TABLES.length + 1, '07: B1 must have one branch per core table plus the optional slot')
  assert.equal(lines.pop(), '  :bpmn_deployments_branch', '07: the last B1 line is the optional bpmn_deployments slot')
  lines.forEach((line, i) => {
    const m = branch.exec(line)
    assert.ok(m, `07: B1 branch ${i + 1} may select only its ordinal, its own name and count(*): ${line.trim()}`)
    assert.equal(Number(m[1]), i + 1, `07: B1 branch ${i + 1} ordinal`)
    assert.equal(m[2], BPMN_TABLES[i], `07: B1 branch ${i + 1} label`)
    assert.equal(m[3], m[2], `07: B1 branch ${i + 1} must count the table it names`)
  })

  // Optional 12th table: its own probe (not part of has_all), and the slot is
  // either the same values-free branch shape (ordinal 12) or empty plus an \echo.
  const opt = code.match(/\nSELECT count\(\*\) > 0 AS has_deployments\n([\s\S]*?)\n\\gset\n\\if :has_deployments\n\\set bpmn_deployments_branch '(.*)'\n\\else\n\\set bpmn_deployments_branch ''\n\\echo '(.*)'\n\\endif\n/)
  assert.ok(opt, '07: no optional bpmn_deployments probe + \\if/\\set/\\echo block')
  assert.match(opt[1], /table_schema = ANY \(current_schemas\(false\)\)\n\s+AND table_name = 'bpmn_deployments'$/)
  const m12 = branch.exec(opt[2].replace(/''/g, "'"))
  assert.ok(m12, `07: the optional branch may select only its ordinal, its name and count(*): ${opt[2]}`)
  assert.deepEqual([Number(m12[1]), m12[2], m12[3]], [12, 'bpmn_deployments', 'bpmn_deployments'])
  assert.equal(opt[3], '-- bpmn_deployments not present (optional; only created by legacy 049)')
  assert.ok(code.indexOf('AS has_deployments') > code.indexOf('AS has_all'))
  assert.ok(!/has_deployments/.test(code.slice(code.lastIndexOf("SELECT 'INVENTORY_RESULT"))),
    '07: completeness must not depend on the optional table')
})

if (!DATABASE_URL || !psqlAvailable()) {
  test('07 SYNTHETIC-DB CHECKS SKIPPED — no DATABASE_URL / psql', { skip: true }, () => {})
} else {
  const onBpmnFixture = fn => withFixture('inventory_fixture_bpmn', BPMN_TABLES_FIXTURE, fn)
  const EXPECTED_07_ROWS = [
    'bpmn_process_definitions|3', 'bpmn_process_instances|2', 'bpmn_activity_instances|0',
    'bpmn_user_tasks|1', 'bpmn_timer_jobs|0', 'bpmn_message_events|0', 'bpmn_signal_events|0',
    'bpmn_variables|7', 'bpmn_incidents|0', 'bpmn_external_tasks|0', 'bpmn_audit_log|4',
  ]
  const OPTIONAL_07_ROW = 'bpmn_deployments|5'
  const OPTIONAL_07_ABSENT = '-- bpmn_deployments not present (optional; only created by legacy 049)'
  const COMPLETE_07 = 'INVENTORY_RESULT file=07-bpmn-table-totals.sql status=complete scope=bpmn_tables:11'

  test('synthetic PostgreSQL: 07 prints the exact count of every bpmn_* table (plain and psql -1)', () => {
    const r = onBpmnFixture(s => ({ plain: runBpmnTableTotals(s), single: runBpmnTableTotals(s, ['-1']) }))
    for (const [mode, o] of [['plain', r.plain], ['-1', r.single]]) {
      assert.deepEqual(o.rows, [...EXPECTED_07_ROWS, OPTIONAL_07_ROW], `${mode}: row counts (11 core + optional)`)
      assert.equal(o.result, COMPLETE_07, `${mode}: result line`)
      assert.ok(!o.stdout.includes(OPTIONAL_07_ABSENT), `${mode}: no "not present" line when the table exists`)
    }
  })

  test('synthetic PostgreSQL: 07 without the optional bpmn_deployments is still complete', () => {
    const r = onBpmnFixture(s => {
      exec(`DROP TABLE "${s}".bpmn_deployments`)
      return { plain: runBpmnTableTotals(s), single: runBpmnTableTotals(s, ['-1']) }
    })
    for (const [mode, o] of [['plain', r.plain], ['-1', r.single]]) {
      assert.deepEqual(o.rows, EXPECTED_07_ROWS, `${mode}: the 11 core rows only, no bpmn_deployments row`)
      assert.ok(o.stdout.split(/\r?\n/).includes(OPTIONAL_07_ABSENT), `${mode}: the optional line is printed`)
      assert.equal(o.result, COMPLETE_07, `${mode}: completeness depends on the 11 core tables only`)
    }
  })

  test('synthetic PostgreSQL: 07 reports a missing bpmn_* table as incomplete, never as zero', () => {
    const r = {
      oneMissing: onBpmnFixture(s => {
        exec(`DROP TABLE "${s}".bpmn_signal_events`)
        return runBpmnTableTotals(s)
      }),
      empty: withFixture('inventory_fixture_empty', null, runBpmnTableTotals),
    }
    assert.equal(r.oneMissing.rows, null, 'B1 must be skipped, not printed with zeros')
    assert.match(r.oneMissing.stdout, /B1 skipped/)
    assert.equal(r.oneMissing.result,
      'INVENTORY_RESULT file=07-bpmn-table-totals.sql status=incomplete reason=missing-tables:1 scope=none')
    assert.equal(r.empty.rows, null)
    assert.ok(r.empty.stdout.split(/\r?\n/).includes(OPTIONAL_07_ABSENT))
    assert.equal(r.empty.result,
      'INVENTORY_RESULT file=07-bpmn-table-totals.sql status=incomplete reason=missing-tables:11 scope=none')
  })

  test('synthetic PostgreSQL: 07 run by a role that can read one table is incomplete, never zero', () => {
    const r = onBpmnFixture(s => runBpmnTableTotalsAsLimitedRole(s, ['bpmn_process_definitions']))
    assert.equal(r.exit, 0, `limited-role run exited ${r.exit}: ${r.stderr}`)
    assert.equal(r.rows, null, 'no count may be printed for tables the role cannot read')
    assert.equal(r.result,
      'INVENTORY_RESULT file=07-bpmn-table-totals.sql status=incomplete reason=missing-tables:10 scope=none')
  })

  test('synthetic PostgreSQL: 07 stays read-only inside one transaction (psql -X -1, AUTOCOMMIT=off)', () => {
    const r = onBpmnFixture(checkBpmnTableTotalsReadOnly)
    assert.equal(r.before, 'fake-def-1')
    assertReadOnlyWitness(r)
  })
}
