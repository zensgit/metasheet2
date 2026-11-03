#!/usr/bin/env node
// ============================================================================
// run-verify.mjs — synthetic-PostgreSQL verification of the 2026-09-16
//                  read-only inventory pack (review repairs F3 / F4 / F5)
// ============================================================================
// WHAT IT PROVES (all on throwaway schemas full of obviously fake values —
// this harness must never be pointed at a production database):
//
//   F3  02-trg04's http:// detection is JSON-SEMANTIC. Positives: top-level
//       action, nested condition_branch action, space-laid-out JSON, upper-case
//       key + upper-case scheme. Negatives: https, HTTPS, and a decoy string
//       that merely CONTAINS the literal `"url":"http://…`. The harness also
//       runs the OLD textual predicate on the same fixture and asserts it gets
//       a DIFFERENT, wrong answer — that is the "remove the fix and the test
//       goes red" evidence.
//   F4  01-cred06's count and id list come from one shared `hit` predicate:
//       the clean connection row stays out of BOTH, the matching rows are in
//       BOTH, and |ids| == count. The harness also runs the OLD id predicate
//       (shape-only) and asserts it returns MORE rows than the count.
//   F5  One execution mode (whole file, `psql -f`), automatic schema dispatch,
//       ON_ERROR_STOP, and an explicit INVENTORY_RESULT completion line:
//         * modern schema  → status=complete for all four files
//         * legacy schema  → status=incomplete reason=missing-column:… for the
//                            files whose columns are absent (never a zero)
//         * lock timeout   → psql aborts, NO INVENTORY_RESULT line at all
//         * permission denied → same abort shape
//   F6  02-trg04's ACTIONABLE http:// count matches only the jsonpaths the
//       executor dereferences (`config.url` at the top level and one branch
//       level down). A user-authored `body.callbackUrl` and a mis-cased
//       `config.URL` are proven to be OUT of that count while still visible in
//       the labelled upper-bound column, and the pre-narrowing `$.**`
//       predicate is re-run standalone to show it returned the larger number.
//
// USAGE
//   DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/scratch node run-verify.mjs
//   (PSQL=/path/to/psql if the binary is not on PATH)
// ============================================================================

import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
export const PSQL = process.env.PSQL || 'psql'

export function psqlAvailable() {
  const r = spawnSync(PSQL, ['--version'], { encoding: 'utf8' })
  return r.status === 0
}

function run(args, { input } = {}) {
  const r = spawnSync(PSQL, ['-d', process.env.DATABASE_URL, '--no-psqlrc', ...args], {
    encoding: 'utf8',
    input,
    // PGCLIENTENCODING is pinned because every file in this pack (SQL + fixtures)
    // is UTF-8, while psql otherwise derives `client_encoding` from the console
    // code page. On a Chinese-locale Windows host that is GBK, and loading
    // fixture-modern.sql then dies with
    // `character with byte sequence 0x80 0xe2 in encoding "GBK"` on the em dashes
    // in its comments — an environment-dependent flake, not a pack defect.
    env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** Run one SQL statement, return the single scalar as a string. */
export function scalar(sql) {
  const r = run(['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${sql}`)
  return r.stdout.trim()
}

export function exec(sql) {
  const r = run(['-v', 'ON_ERROR_STOP=1', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${sql}`)
  return r.stdout
}

export function execFile(file, schema) {
  const r = run(['-v', 'ON_ERROR_STOP=1', '-q', '-v', `schema=${schema}`, '-f', file])
  if (r.status !== 0) throw new Error(`psql -f ${file} failed: ${r.stderr}`)
  return r.stdout
}

/** Run one of the pack's four files exactly the way the runbook says to. */
export function runPackFile(name, schema, extraVars = []) {
  const args = ['-A', '-v', `schema=${schema}`, ...extraVars, '-f', path.join(PACK, name)]
  return run(args)
}

/** Split psql -A output into result blocks using the `(N rows)` footers. */
export function parseBlocks(stdout) {
  const blocks = []
  let buf = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const m = /^\((\d+) rows?\)$/.exec(line)
    if (m) {
      const n = Number(m[1])
      const slice = buf.slice(buf.length - (n + 1))
      blocks.push({ header: slice[0], rows: slice.slice(1) })
      buf = []
      continue
    }
    buf.push(line)
  }
  return blocks
}

export function block(stdout, header) {
  const found = parseBlocks(stdout).filter(b => b.header === header)
  if (found.length === 0) {
    throw new Error(`no result block with header "${header}" in:\n${stdout}`)
  }
  return found
}

export function resultLine(stdout, file) {
  const line = stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.startsWith(`INVENTORY_RESULT file=${file}`))
  return line || null
}

// ── fixture lifecycle ───────────────────────────────────────────────────────

export function createFixture(prefix, fixtureSql) {
  const schema = `${prefix}_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE SCHEMA "${schema}"`)
  const r = run([
    '-v', 'ON_ERROR_STOP=1', '-q',
    '-c', `SET search_path = "${schema}"`,
    '-f', path.join(HERE, fixtureSql),
  ])
  if (r.status !== 0) {
    exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    throw new Error(`fixture load failed: ${r.stderr}`)
  }
  return schema
}

export function dropFixture(schema) {
  try { exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* best effort */ }
}

// ── the checks ──────────────────────────────────────────────────────────────

/** F4 evidence: the pre-repair id predicate (shape only, no key match). */
export const OLD_ID_PREDICATE_SQL = schema => `
  SET search_path = "${schema}";
  SELECT count(*)::int FROM data_sources ds
   WHERE jsonb_typeof(ds.config #> '{connection}') = 'object'
      OR jsonb_typeof(ds.config #> '{connection,headers}') = 'object'`

/** F3 evidence: the pre-repair textual predicate. */
export const OLD_HTTP_PREDICATE_SQL = schema => `
  SET search_path = "${schema}";
  SELECT count(*)::int FROM automation_rules
   WHERE actions::text ILIKE '%"url":"http://%'`

/**
 * F6 evidence: the pre-narrowing WIDE predicate, run standalone. It is the
 * `$.**` recursion plus the seven-name key allowlist — i.e. exactly what
 * 02-trg04 used to count as "http egress targets". The pack still reports this
 * number, but now as an explicitly-labelled UPPER BOUND, never as the number
 * that sizes the breakage. Asserting `wide > narrow` on the same fixture is the
 * measurement that the narrowing actually removed something.
 */
export const OLD_WIDE_HTTP_PREDICATE_SQL = schema => `
  SET search_path = "${schema}";
  SELECT count(*)::int FROM automation_rules ar
   WHERE EXISTS (
           SELECT 1
             FROM jsonb_path_query(ar.actions, '$.**') AS node
             CROSS JOIN LATERAL jsonb_each_text(
                   CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
                 ) AS m(key, val)
            WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                  IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
              AND btrim(m.val) ILIKE 'http://%'
         )`

// ── F7 (2026-09-27): Q7's internal-target host set ──────────────────────────
// 02-trg04's three Q7 predicates used to carry a PREFIX literal narrower than
// the runtime guard (packages/core-backend/src/multitable/webhook-ssrf-guard.ts).
// They now share ONE \gset'd pattern, transcribed class by class from the
// guard. The case table below is that transcription as data; the harness runs
// the real file and then matches every case in the SAME psql session, so the
// pattern under test is the file's own, not a copy. Every non-'floor' `want`
// is the guard's own verdict on the URL (internal literal / internal name);
// 'floor' rows are ones the guard refuses but the pack deliberately does not
// count (spellings the URL parser normalises) — misses, never extras.

/** F7 evidence: the pre-repair Q7 literal (prefix test, narrow host list). */
export const OLD_Q7_HOST_RE =
  String.raw`^https?://(127[.]|10[.]|192[.]168[.]|169[.]254[.]|0[.]0[.]0[.]0|localhost|\[::1\])`

export const OLD_Q7_WEBHOOK_SQL = schema => `
  SET search_path = "${schema}";
  SELECT count(*)::int FROM multitable_webhooks WHERE btrim(url) ~* '${OLD_Q7_HOST_RE}'`

/** [url, counted by Q7?, 'floor' when the guard refuses it but Q7 does not count it] */
export const INTERNAL_TARGET_CASES = [
  // IPv4 literal — guard :32-37 (0/8, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16)
  ['https://0.0.0.0/', true],
  ['https://0.1.2.3/', true],
  ['http://127.0.0.1:9999/hook', true],
  ['https://127.255.255.255/', true],
  ['https://10.0.0.0/', true],
  ['https://10.255.255.255/x', true],
  ['https://172.16.0.0/', true],
  ['https://172.24.8.1/', true],
  ['https://172.31.255.255/', true],
  ['https://192.168.0.1/', true],
  ['https://169.254.169.254/latest/meta-data', true],
  ['https://10.0.0.1./', true],
  ['https://172.15.255.255/', false],
  ['https://172.32.0.0/', false],
  ['https://172.3.0.1/', false],
  ['https://172.160.0.1/', false],
  ['https://172.016.0.1/', false], // octal: the parser reads 172.14.0.1
  ['https://11.0.0.1/', false],
  ['https://126.255.255.255/', false],
  ['https://128.0.0.1/', false],
  ['https://192.169.0.1/', false],
  ['https://169.253.0.1/', false],
  ['https://1.0.0.0/', false],
  ['https://10.0.0.256/', false], // not a URL at all
  ['https://10.0.0.1../', false], // a DNS name, not an IPv4 literal
  // DNS names that only START like an internal literal (the old prefix test counted them)
  ['https://10.fake.invalid/', false],
  ['https://127.0.0.1.fake.invalid/', false],
  ['https://192.168.fake.invalid/', false],
  ['https://localhost.fake.invalid/', false],
  ['https://localhostfake.invalid/', false],
  // name — guard :78-83 (localhost, *.localhost, *.internal, *.local; one trailing dot)
  ['https://localhost/', true],
  ['https://LOCALHOST:8080/', true],
  ['https://localhost./', true],
  ['https://api.localhost/', true],
  ['https://fake-svc.internal/x', true],
  ['https://fake-svc.ns.INTERNAL:443/', true],
  ['https://printer.local', true],
  ['https://fake-svc.local?x=1', true],
  ['https://localhost../', false],
  ['https://internal/', false],
  ['https://local/', false],
  ['https://fake-local.invalid/', false],
  ['https://fake-svc.internal.fake.invalid/', false],
  ['https://fake-svc.locals/', false],
  // IPv6 literal — guard :43-69 (::1, ::, ::ffff:<internal v4>, fc00::/7, fe80::/10)
  ['https://[::1]/', true],
  ['https://[::1]:8443/x', true],
  ['https://[0:0:0:0:0:0:0:1]/', true],
  ['https://[::]/', true],
  ['https://[::ffff:127.0.0.1]/', true],
  ['https://[::ffff:10.0.0.1]/', true],
  ['https://[::FFFF:AC10:0]/', true], // 172.16.0.0
  ['https://[::ffff:ac1f:ffff]/', true], // 172.31.255.255
  ['https://[::ffff:c0a8:1]/', true],
  ['https://[::ffff:a9fe:a9fe]/', true],
  ['https://[0:0:0:0:0:ffff:7f00:1]/', true],
  ['https://[::ffff:0:0]/', true], // 0.0.0.0
  ['https://[fc00::1]/', true],
  ['https://[fd12:3456:789a:1::1]:8443/', true],
  ['https://[FDFF:FFFF::]/', true],
  ['https://[fe80::1]/', true],
  ['https://[febf:ffff::1]/', true],
  ['https://[::2]/', false],
  ['https://[::ffff:ac0f:ffff]/', false], // 172.15.255.255
  ['https://[::ffff:ac20:0]/', false], // 172.32.0.0
  ['https://[::ffff:1.2.3.4]/', false],
  ['https://[::7f00:1]/', false], // IPv4-compatible, not mapped: the guard lets it through
  ['https://[fbff::1]/', false],
  ['https://[fe00::1]/', false],
  ['https://[fe7f::1]/', false],
  ['https://[fec0::1]/', false],
  ['https://[2001:db8::1]/', false],
  ['https://[fc0::1]/', false], // first piece 0x0fc0
  ['https://[fd00:::1]/', false], // not an IPv6
  ['https://[fd00:1:2:3:4:5:6:7:8]/', false], // nine pieces
  // 2026-09-27 (#6104 gap): a leading-zero octet inside an embedded IPv4 tail
  // makes the WHATWG IPv6 parser reject the whole literal outright (confirmed:
  // `new URL('https://[fc00::01.2.3.4]/')` throws — unlike a leading zero in a
  // PLAIN IPv4 host, which the top-level parser tolerates; see the `floor`
  // 127.000.000.001 case below). An address the parser rejects is out of
  // scope like the nine-piece case above, not a floor miss.
  ['https://[fc00::01.2.3.4]/', false],
  // Same family: one hex group more than the compressed-form bound allows,
  // with (mutation target {0,7}->{0,8}) / without (mutation target
  // {0,5}->{0,6}) a dotted tail — both invalid (isIP() rejects both), and
  // both happen to start with the ULA prefix so a relaxed bound would flip
  // them to counted.
  ['https://[fd00:1:2:3:4:5:6::7]/', false], // 8 explicit groups + `::`
  ['https://[fd00:1:2:3:4:5::6.7.8.9]/', false], // 6 groups + `::` + dotted tail
  // 2026-09-27 (#6104 independent-verifier mutation gap): ::ffff: hex-form
  // boundaries one step past each of c0a8 / a9fe / 7f / 0a — an exhaustive
  // mutant scan of the mapped-hex alternative found these undetected because
  // no case sat exactly on the wrong side of each literal. isInternalIpv4
  // on the unwrapped embedded address is false for all four (192.169.0.0,
  // 11.0.0.0, 126.255.0.1, 169.255.0.1 — none is a real private/link-local
  // range), so none may be counted.
  ['https://[::ffff:c0a9:0]/', false], // 192.169.0.0 (one past 192.168/16)
  ['https://[::ffff:b00:1]/', false], // 11.0.0.1 (one past 10/8 in the 0a-prefixed hex alt)
  ['https://[::ffff:7eff:1]/', false], // 126.255.0.1 (one past 7f/127 in the 7f-prefixed hex alt)
  ['https://[::ffff:a9ff:1]/', false], // 169.255.0.1 (one past a9fe/169.254 exactly)
  // A real IPv6 with an extra leading group before the mapped prefix is NOT
  // an IPv4-mapped address at all (RFC 4291's ::ffff:0:0/96 prefix requires
  // exactly 80 zero bits first) — isInternalIpv6('1::ffff:7f00:1') is false.
  // Only `[0:]*ffff:` (zeros/colons only) may precede the mapped form.
  ['https://[1::ffff:7f00:1]/', false],
  // URL shapes around the host: userinfo (last @ wins), case, port, separators
  ['https://fake-user:fake-pass@10.0.0.1/', true],
  ['https://a@b@172.16.0.1/', true],
  // A backslash inside what looks like userinfo ends the authority section for
  // a special scheme (WHATWG URL state machine, same as `/`) BEFORE the `@` is
  // reached, so the real parser's hostname is "x" (10.0.0.1 lands in the path,
  // confirmed via `new URL(...).hostname`) — not an internal target at all.
  ['https://x\\@10.0.0.1/', false],
  ['https://10.0.0.1@fake.invalid/', false],
  ['https://127.0.0.1:80@fake.invalid/', false],
  ['HTTPS://192.168.0.1/', true],
  ['HtTp://LocalHost/', true],
  ['https://10.0.0.1:/x', true],
  ['https://10.0.0.1:0065535/', true],
  ['https://10.0.0.1:65536/', false],
  ['https://10.0.0.1:80:90/', false],
  ['https:10.0.0.1/', true],
  ['https:\\\\10.0.0.1\\x', true],
  ['https://10.0.0.1?q=1', true],
  ['https://10.0.0.1#frag', true],
  ['https://10.0.0.1 /x', false],
  ['ftp://10.0.0.1/', false],
  ['ws://localhost/', false],
  // floor — the guard refuses these, Q7 deliberately does not count them
  ['https://127.1/', false, 'floor'],
  ['https://2130706433/', false, 'floor'],
  ['https://0x7f.0.0.1/', false, 'floor'],
  ['https://127.000.000.001/', false, 'floor'],
  ['https://[::0.0.0.1]/', false, 'floor'],
  // 2026-09-27 (#6104 gap, "去 xn-- 排除" mutation): isInternalHostname is a
  // plain suffix check with no punycode decoding, so it flags any
  // "xn--...".local name as internal once it reaches that check. The label
  // here must be VALID punycode ('bücher' → 'xn--bcher-kva'): `new URL()`
  // decodes/validates the label first, and an invalid one (e.g. plain
  // 'xn--a') throws there — confirmed with `new URL('https://xn--a.local/')`
  // on Node 20 — so checkWebhookTargetUrl would return 'URL is malformed'
  // before isInternalHostname ever runs, landing it in the parser-rejection
  // class instead (same as `[fd00:::1]` / `[fc00::01.2.3.4]` above). With a
  // valid label the URL parses, isInternalHostname sees the `.local` suffix
  // and the guard returns 'target host is internal' — confirmed the same
  // way. Q7's negative lookahead deliberately excludes every `xn--`-bearing
  // name (header §"STILL A FLOOR": "xn-- labels — are not counted"), so
  // *this* case is a genuine floor miss, not a parser-rejection case.
  ['https://xn--bcher-kva.local/', false, 'floor'],
]

/**
 * F7: run 02-trg04 exactly as the runbook says, then — same psql session, so
 * the file's own `inv_internal_target_re` is what gets tested — match every
 * case against it and against the old literal.
 */
export function checkInternalTargetCases(schema) {
  const values = INTERNAL_TARGET_CASES
    .map(([url], i) => `(${i}, '${url.replace(/'/g, "''")}')`)
    .join(',\n')
  const caseSql = `SELECT c.i, c.u ~* :'inv_internal_target_re' AS hit, c.u ~* '${OLD_Q7_HOST_RE}' AS old_hit
  FROM (VALUES ${values}) AS c(i, u)
 ORDER BY c.i;
`
  const o = run(['-A', '-v', `schema=${schema}`,
    '-f', path.join(PACK, '02-trg04-http-targets.sql'), '-f', '-'], { input: caseSql })
  assert.equal(o.status, 0, `02 + case table exited ${o.status}: ${o.stderr}`)
  const rows = block(o.stdout, 'i|hit|old_hit')[0].rows.map(r => r.split('|'))
  assert.equal(rows.length, INTERNAL_TARGET_CASES.length)
  const wrong = []
  let oldMissed = 0
  let oldExtra = 0
  for (const [i, hit, oldHit] of rows) {
    const [url, want] = INTERNAL_TARGET_CASES[Number(i)]
    if ((hit === 't') !== want) wrong.push(`${url}: got ${hit}, want ${want ? 't' : 'f'}`)
    if (want && oldHit !== 't') oldMissed++
    if (!want && oldHit === 't') oldExtra++
  }
  assert.deepEqual(wrong, [], 'Q7 host set must match every guard-derived case')
  return {
    cases: rows.length,
    counted: INTERNAL_TARGET_CASES.filter(c => c[1]).length,
    floor: INTERNAL_TARGET_CASES.filter(c => c[2] === 'floor').length,
    oldMissed,
    oldExtra,
  }
}

export function checkModern(schema) {
  const out = {}

  // ── 01 / F4 ──────────────────────────────────────────────────────────────
  const o1 = runPackFile('01-cred06-secret-keys.sql', schema)
  assert.equal(o1.status, 0, `01 exited ${o1.status}: ${o1.stderr}`)
  const count01 = Number(block(o1.stdout, 'affected_rows')[0].rows[0])
  const ids01 = block(o1.stdout, 'id|matched_top_level|matched_headers')[0].rows
    .map(r => r.split('|')[0])
  assert.equal(count01, 2, 'modern 01: expected ds-top + ds-headers')
  assert.deepEqual(ids01.sort(), ['ds-headers', 'ds-top'])
  assert.equal(ids01.length, count01, 'F4 invariant: |ids| == count')
  assert.ok(!ids01.includes('ds-clean'), 'F4: clean connection must NOT be listed')
  const oldIdRows = Number(scalar(OLD_ID_PREDICATE_SQL(schema)))
  assert.equal(oldIdRows, 3, 'F4 evidence: the old shape-only id predicate over-lists')
  assert.ok(oldIdRows > count01, 'F4 evidence: old id set was strictly larger than the count')
  // key census is opt-in
  assert.ok(!/connection_key/.test(o1.stdout), 'key census must be off by default')
  const o1c = runPackFile('01-cred06-secret-keys.sql', schema, ['-v', 'census=1'])
  assert.ok(/connection_key/.test(o1c.stdout), '-v census=1 must enable the key census')
  out.f4 = { count: count01, ids: ids01, oldIdRows }
  out.r01 = resultLine(o1.stdout, '01-cred06-secret-keys.sql')
  assert.match(out.r01, /status=complete shapes=A /)

  // ── 02 / F3 + F6 ─────────────────────────────────────────────────────────
  const o2 = runPackFile('02-trg04-http-targets.sql', schema)
  assert.equal(o2.status, 0, `02 exited ${o2.status}: ${o2.stderr}`)
  const [httpRules, httpRulesBound] = block(o2.stdout, 'http_rules|http_rules_upper_bound')[0]
    .rows[0].split('|').map(Number)
  const ruleRows = block(o2.stdout, 'id|sheet_id|narrow_hit|upper_bound_hit')[0].rows
    .map(r => r.split('|'))
    .map(([id, sheetId, n, u]) => ({ id, sheetId, narrow: n === 't', bound: u === 't' }))
  const narrowIds = ruleRows.filter(r => r.narrow).map(r => r.id).sort()
  const listedIds = ruleRows.map(r => r.id).sort()

  // F3 (kept): layout and VALUE case must not change the answer.
  assert.deepEqual(narrowIds,
    ['r-default', 'r-internal', 'r-nested', 'r-spaced', 'r-top', 'r-upper'],
    'narrow set must be exactly the six read-path http:// rows')
  assert.equal(httpRules, 6)
  assert.equal(narrowIds.length, httpRules, 'F4 invariant: |narrow ids| == narrow count')

  // F6 (the narrowing): a user-authored `body.callbackUrl` and a mis-cased
  // `config.URL` member are NOT egress targets — they must be OUT of the
  // narrow set and IN the upper bound, so no information is lost.
  for (const fp of ['r-body-callback', 'r-keycase']) {
    assert.ok(!narrowIds.includes(fp), `F6: false positive leaked into the narrow set: ${fp}`)
    assert.ok(listedIds.includes(fp), `F6: ${fp} must still be visible as upper-bound-only`)
    const row = ruleRows.find(r => r.id === fp)
    assert.equal(row.narrow, false)
    assert.equal(row.bound, true)
  }
  assert.equal(httpRulesBound, 8, 'upper bound = narrow 6 + the two non-target http:// strings')
  assert.equal(listedIds.length, httpRulesBound,
    'F4 invariant: |listed ids| == upper-bound count (narrow is a subset)')
  assert.ok(httpRules < httpRulesBound, 'F6: the narrowing must actually remove rows')

  // Negatives: neither reading may count https, HTTPS or the text decoy.
  for (const neg of ['r-https', 'r-https-upper', 'r-decoy']) {
    assert.ok(!listedIds.includes(neg), `negative leaked in: ${neg}`)
  }

  const oldHttp = Number(scalar(OLD_HTTP_PREDICATE_SQL(schema)))
  // THE F3 BUG, measured: the pre-repair textual predicate reports ZERO on a
  // fixture that holds six genuine http:// targets — jsonb re-renders members
  // as `"url": "http://…"` (with a space), so `'%"url":"http://%'` never hits.
  assert.equal(oldHttp, 0, 'F3 evidence: the old text pattern under-reports to zero')
  assert.notEqual(oldHttp, httpRules, 'F3 evidence: old vs new predicates disagree')
  // THE F6 BUG, measured: the pre-narrowing wide predicate, run standalone,
  // returns the upper bound — i.e. two rows more than the number that actually
  // breaks. Same number the pack still reports, now correctly labelled.
  const oldWideHttp = Number(scalar(OLD_WIDE_HTTP_PREDICATE_SQL(schema)))
  assert.equal(oldWideHttp, httpRulesBound, 'F6 evidence: the wide reading IS the upper bound')
  assert.ok(oldWideHttp > httpRules,
    'F6 evidence: the pre-narrowing predicate over-counted the breakage')

  const [legacyCol, legacyColBound] = block(
    o2.stdout, 'http_rules_legacy_column|http_rules_legacy_column_upper_bound',
  )[0].rows[0].split('|').map(Number)
  assert.equal(legacyCol, 2, 'legacy action_config: $.url + branch-nested config.url')
  assert.equal(legacyColBound, 3, 'legacy upper bound also counts the body callbackUrl row')

  const q7 = block(o2.stdout, 'source|internal_target_rows|internal_target_rows_upper_bound')[0]
    .rows[0].split('|')
  assert.equal(q7[0], 'automation_rules')
  assert.equal(Number(q7[1]), 2, 'Q7 narrow: r-internal + the branch-nested *.internal r-internal-name')
  assert.equal(Number(q7[2]), 2)
  // F7: the webhook half, on the same host set. 172.31.255.255 and a mapped
  // 172.16.0.1 behind userinfo + port are in; 172.32.0.0 and a DNS name that
  // merely starts with `10.` are out. The old prefix literal got both wrong.
  const q7wh = block(o2.stdout, 'source|internal_target_rows')[0].rows[0].split('|')
  assert.equal(q7wh[0], 'multitable_webhooks')
  assert.equal(Number(q7wh[1]), 3, 'Q7 webhooks: w-internal + w-internal-172 + w-internal-v6')
  const oldQ7Webhooks = Number(scalar(OLD_Q7_WEBHOOK_SQL(schema)))
  assert.equal(oldQ7Webhooks, 2, 'F7 evidence: the old literal counted w-internal + w-prefix-decoy')
  out.f7 = { q7Narrow: Number(q7[1]), q7Webhooks: Number(q7wh[1]), oldQ7Webhooks }

  const wh = block(o2.stdout, 'active|http_webhooks')[0].rows.map(r => r.split('|'))
  const whTotal = wh.reduce((a, r) => a + Number(r[1]), 0)
  const whIds = block(o2.stdout, 'id|active|created_by')[0].rows.map(r => r.split('|')[0]).sort()
  assert.deepEqual(whIds, ['w-http', 'w-http-off', 'w-http-upper', 'w-internal'])
  assert.equal(whIds.length, whTotal, 'webhook count/ids invariant')
  out.f3 = { httpRules, narrowIds, oldHttp, legacyCol, whTotal, whIds }
  out.f6 = { httpRules, httpRulesBound, listedIds, oldWideHttp, legacyCol, legacyColBound }
  out.r02 = resultLine(o2.stdout, '02-trg04-http-targets.sql')
  assert.match(out.r02, /status=complete scope=automation_rules\+multitable_webhooks/)

  // ── 03 ───────────────────────────────────────────────────────────────────
  const o3 = runPackFile('03-adm08-wildcard-permissions.sql', schema)
  assert.equal(o3.status, 0, `03 exited ${o3.status}: ${o3.stderr}`)
  assert.equal(Number(block(o3.stdout, 'wildcard_users')[0].rows[0]), 1)
  assert.equal(Number(block(o3.stdout, 'wildcard_direct_grants')[0].rows[0]), 1)
  assert.equal(Number(block(o3.stdout, 'wildcard_roles')[0].rows[0]), 1)
  assert.equal(Number(block(o3.stdout, 'wildcard_via_role_users')[0].rows[0]), 1)
  out.r03 = resultLine(o3.stdout, '03-adm08-wildcard-permissions.sql')
  assert.match(out.r03, /status=complete shape=A\(jsonb\)/)

  // ── 04 ───────────────────────────────────────────────────────────────────
  const o4 = runPackFile('04-adm13-declared-admins.sql', schema)
  assert.equal(o4.status, 0, `04 exited ${o4.status}: ${o4.stderr}`)
  const declared = Number(block(o4.stdout, 'declared_admin_not_in_user_roles')[0].rows[0])
  const declaredIds = block(o4.stdout, 'id|role_says_admin|is_admin_flag|is_active')[0]
    .rows.map(r => r.split('|')[0]).sort()
  assert.equal(declared, 2)
  assert.deepEqual(declaredIds, ['u-flag', 'u-role'])
  assert.ok(!declaredIds.includes('u-consistent'), 'user WITH a user_roles admin row must not be listed')
  out.r04 = resultLine(o4.stdout, '04-adm13-declared-admins.sql')
  assert.match(out.r04, /status=complete predicate=is_admin-or-role/)
  out.modernDeclared = { declared, declaredIds }

  return out
}

export function checkLegacy(schema) {
  const out = {}

  const o1 = runPackFile('01-cred06-secret-keys.sql', schema)
  assert.equal(o1.status, 0, `01 legacy exited ${o1.status}: ${o1.stderr}`)
  const count01 = Number(block(o1.stdout, 'affected_rows')[0].rows[0])
  const ids01 = block(o1.stdout, 'id|matched_top_level|matched_headers')[0].rows
    .map(r => r.split('|')[0])
  assert.equal(count01, 1)
  assert.deepEqual(ids01, ['ds-b-hit'])
  assert.equal(ids01.length, count01)
  out.r01 = resultLine(o1.stdout, '01-cred06-secret-keys.sql')
  assert.match(out.r01, /status=complete shapes=B /, 'legacy must auto-dispatch to Shape B')

  // F5: the missing `actions` column must be reported as INCOMPLETE, not zero.
  const o2 = runPackFile('02-trg04-http-targets.sql', schema)
  assert.equal(o2.status, 0, `02 legacy exited ${o2.status}: ${o2.stderr}`)
  out.r02 = resultLine(o2.stdout, '02-trg04-http-targets.sql')
  assert.match(out.r02, /status=incomplete reason=missing-column:automation_rules\.actions/)
  assert.ok(!/http_rules\|http_rules_upper_bound/.test(o2.stdout),
    'Q2 must be skipped, not silently zero')
  // F6 on the old schema: `action_config` IS the executed config here (no
  // `actions` column ⇒ toExecutorRule's fallback always applies), so Q4's
  // narrow number is the one that breaks; the body-callbackUrl row shows up
  // only in the upper bound.
  const [legacyCol, legacyColBound] = block(
    o2.stdout, 'http_rules_legacy_column|http_rules_legacy_column_upper_bound',
  )[0].rows[0].split('|').map(Number)
  assert.equal(legacyCol, 1, 'legacy narrow: only r-b-legacy is on a read path')
  assert.equal(legacyColBound, 2, 'legacy upper bound also counts r-b-body')
  out.f6Legacy = { legacyCol, legacyColBound }
  const whIds = block(o2.stdout, 'id|active|created_by')[0].rows.map(r => r.split('|')[0])
  assert.deepEqual(whIds, ['w-b-http'], 'the webhook half still runs')
  // F7: the host pattern is \gset OUTSIDE the `\if :has_rules_actions` block,
  // so the webhook half of Q7 still has it on a schema without `actions`.
  const q7wh = block(o2.stdout, 'source|internal_target_rows')[0].rows[0].split('|')
  assert.deepEqual(q7wh, ['multitable_webhooks', '1'], 'legacy Q7 webhooks: w-b-internal')

  const o3 = runPackFile('03-adm08-wildcard-permissions.sql', schema)
  assert.equal(o3.status, 0, `03 legacy exited ${o3.status}: ${o3.stderr}`)
  assert.equal(Number(block(o3.stdout, 'wildcard_users')[0].rows[0]), 1)
  out.r03 = resultLine(o3.stdout, '03-adm08-wildcard-permissions.sql')
  assert.match(out.r03, /status=complete shape=B\(text\[\]\)/)

  // F5: BOTH missing columns (is_admin AND is_active — the gap the old prose
  // fallback missed) are handled, and the run is reported incomplete.
  const o4 = runPackFile('04-adm13-declared-admins.sql', schema)
  assert.equal(o4.status, 0, `04 legacy exited ${o4.status}: ${o4.stderr}`)
  const roleOnly = Number(block(o4.stdout, 'declared_admin_not_in_user_roles_role_only')[0].rows[0])
  assert.equal(roleOnly, 1, 'u-b-role only (u-b-ok has the user_roles row)')
  out.r04 = resultLine(o4.stdout, '04-adm13-declared-admins.sql')
  assert.match(out.r04, /status=incomplete reason=missing-column:users\.is_admin users\.is_active/)
  assert.match(out.r04, /note=role-only-lower-bound/)

  return out
}

/** F5: an aborted run prints NO completion line (must never read as zero). */
export async function checkLockTimeoutIsIncomplete(schema) {
  const holder = spawn(PSQL, [
    '-d', process.env.DATABASE_URL, '--no-psqlrc', '-q',
    '-c', `BEGIN; SET search_path = "${schema}"; LOCK TABLE data_sources IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;`,
  ], { stdio: 'ignore' })
  try {
    await new Promise(r => setTimeout(r, 1500))
    const o = runPackFile('01-cred06-secret-keys.sql', schema)
    assert.notEqual(o.status, 0, 'a lock timeout must make psql exit non-zero (ON_ERROR_STOP)')
    assert.match(o.stderr, /lock timeout|canceling statement/i)
    assert.equal(resultLine(o.stdout, '01-cred06-secret-keys.sql'), null,
      'an aborted run must print NO INVENTORY_RESULT line')
    assert.ok(!/affected_rows/.test(o.stdout) || !/^0$/m.test(o.stdout),
      'an aborted run must not look like a zero-hit run')
    return { exit: o.status, stderr: o.stderr.trim().split(/\r?\n/)[0] }
  } finally {
    holder.kill()
  }
}

/** F5: a permission error aborts the same way (no completion line). */
export function checkPermissionDeniedIsIncomplete(schema) {
  const role = `inv_verify_ro_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE ROLE "${role}" LOGIN PASSWORD 'fake-verify-only'`)
  try {
    exec(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`)
    // deliberately NO grant on data_sources
    const url = new URL(process.env.DATABASE_URL)
    url.username = role
    url.password = 'fake-verify-only'
    const r = spawnSync(PSQL, [
      '-d', url.toString(), '--no-psqlrc', '-A',
      '-v', `schema=${schema}`, '-f', path.join(PACK, '01-cred06-secret-keys.sql'),
    ], { encoding: 'utf8' })
    // A role without SELECT on data_sources cannot even SEE the table in
    // information_schema (the catalog views are privilege-filtered), so the
    // probe finds nothing. The contract that matters is the same one: the run
    // must NOT look like a clean zero-hit inventory.
    const line = resultLine(r.stdout || '', '01-cred06-secret-keys.sql')
    if (r.status === 0) {
      assert.ok(line, 'a completed run must print an INVENTORY_RESULT line')
      assert.match(line, /status=incomplete reason=missing-table:data_sources/,
        'an unprivileged run must report incomplete, never a zero-hit "complete"')
      assert.ok(!/affected_rows/.test(r.stdout || ''), 'no count may be printed at all')
    } else {
      assert.match(r.stderr || '', /permission denied/i)
      assert.equal(line, null, 'an aborted run must print NO INVENTORY_RESULT line')
    }
    return { exit: r.status, resultLine: line, stderr: (r.stderr || '').trim().split(/\r?\n/)[0] }
  } finally {
    try { exec(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${role}"`) } catch {}
    try { exec(`DROP ROLE IF EXISTS "${role}"`) } catch {}
  }
}

export async function verifyAll() {
  const modern = createFixture('inventory_fixture_modern', 'fixture-modern.sql')
  const legacy = createFixture('inventory_fixture_legacy', 'fixture-legacy.sql')
  try {
    const report = {
      modern: checkModern(modern),
      legacy: checkLegacy(legacy),
      internalTargets: checkInternalTargetCases(modern),
      lockTimeout: await checkLockTimeoutIsIncomplete(modern),
      permissionDenied: checkPermissionDeniedIsIncomplete(modern),
    }
    return report
  } finally {
    dropFixture(modern)
    dropFixture(legacy)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (point it at a LOCAL/CONTAINER scratch PostgreSQL)')
    process.exit(2)
  }
  if (!psqlAvailable()) {
    console.error('psql not found on PATH (set PSQL=/path/to/psql)')
    process.exit(2)
  }
  verifyAll().then(r => {
    console.log(JSON.stringify(r, null, 2))
    console.log('\nALL CHECKS PASSED (synthetic fixtures only; nothing was run against a real database).')
  }).catch(e => {
    console.error(e)
    process.exit(1)
  })
}
