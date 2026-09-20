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
import { psqlAvailable, verifyAll } from './run-verify.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
const FILES = [
  '01-cred06-secret-keys.sql',
  '02-trg04-http-targets.sql',
  '03-adm08-wildcard-permissions.sql',
  '04-adm13-declared-admins.sql',
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
    assert.match(tail, /\) p;$/, `${f}'s last statement must be the completion query`)
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
  test('synthetic PostgreSQL: F3 / F4 / F5 / F6 on both schema shapes', async () => {
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
  })
}
