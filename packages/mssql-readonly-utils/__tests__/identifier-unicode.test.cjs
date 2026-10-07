'use strict'

// G52 — SQL Server identifier handling is Unicode, and STILL not an injection surface.
//
// Design: docs/development/mssql-unicode-identifiers-design-20260910.md
// Verification: docs/development/mssql-unicode-identifiers-verification-20260910.md
//
// The contract this file pins has exactly TWO outcomes and no third one. For ANY input string,
// `quoteSqlServerIdentifier` either
//   (a) REFUSES it with code SQLSERVER_IDENTIFIER_INVALID, or
//   (b) returns text that is PROVABLY a dot-joined sequence of closed bracket tokens in which every
//       interior `]` is doubled, and that reads back as the exact input.
// "Returns something that merely looks fine" is not an outcome: every accepted case below is re-scanned
// by `assertBracketShape` — an INDEPENDENT scanner written in this file, not the helper's own — so the
// helper cannot certify itself.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const helper = require('..')

const helperRuntime = path.join(__dirname, '..', 'index.cjs')

// C0/C1 controls plus the two Unicode line separators — written as code points so this file itself
// stays free of the characters it is about.
function hasControlCharacter(text) {
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) return true
  }
  return false
}

// ── independent verifier ─────────────────────────────────────────────────────
// Walks quoted text the way SQL Server's parser does and asserts the shape. Deliberately does NOT call
// into the module under test: if the helper's escaping and its own unquote were both wrong in the same
// direction, this would still catch it.
function assertBracketShape(quoted, label) {
  assert.equal(typeof quoted, 'string', `${label}: quoted output must be a string`)
  let i = 0
  let tokens = 0
  while (i < quoted.length) {
    assert.equal(quoted[i], '[', `${label}: segment ${tokens} must open with [`)
    i += 1
    let closed = false
    while (i < quoted.length) {
      if (quoted[i] === ']') {
        if (quoted[i + 1] === ']') { i += 2; continue } // doubled -> literal ], stays inside
        i += 1
        closed = true
        break
      }
      // Nothing else can end a delimited identifier — assert the characters we let through are the
      // ones we think they are (no newline can split a log line, no NUL can truncate a C string).
      const code = quoted.codePointAt(i)
      assert.ok(
        !(code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)),
        `${label}: control character U+${code.toString(16)} inside a quoted identifier`,
      )
      i += quoted[i] >= '\ud800' && quoted[i] <= '\udbff' ? 2 : 1
    }
    assert.ok(closed, `${label}: segment ${tokens} never closed`)
    tokens += 1
    if (i === quoted.length) break
    assert.equal(quoted[i], '.', `${label}: segments must be separated by a single dot`)
    i += 1
    assert.ok(i < quoted.length, `${label}: trailing dot`)
  }
  assert.ok(tokens >= 1 && tokens <= 3, `${label}: expected 1..3 segments, got ${tokens}`)
  return tokens
}

// Every case funnels through here, so "the helper returned something weird" cannot pass unnoticed.
function classify(value, label) {
  let quoted
  try {
    quoted = helper.quoteSqlServerIdentifier(value)
  } catch (error) {
    assert.equal(error && error.code, 'SQLSERVER_IDENTIFIER_INVALID', `${label}: refusal must use the registered code`)
    assert.ok(error.details && typeof error.details.reason === 'string', `${label}: refusal must say why`)
    // A refusal must never carry the rejected value into the message: it is arbitrary text by
    // definition (that is why it was rejected), and this message ends up in a log line.
    assert.equal(
      hasControlCharacter(error.message),
      false,
      `${label}: refusal message must stay on one line and free of control characters`,
    )
    if (value.length >= 6) {
      assert.equal(error.message.includes(value), false, `${label}: refusal message must not carry the raw value`)
    }
    return { outcome: 'refused', reason: error.details.reason }
  }
  assertBracketShape(quoted, label)
  assert.equal(helper.unquoteSqlServerIdentifier(quoted), value.trim(), `${label}: must read back as the input`)
  return { outcome: 'quoted', quoted }
}

const CJK = '订单' // 订单
const SUPPLEMENTARY = '\u{20BB7}' // 𠮷 — ONE code point, TWO UTF-16 units

// ── the matrix ───────────────────────────────────────────────────────────────
// [label, input, expected outcome, expected quoted text (when accepted)]
const MATRIX = [
  // Accepted — the G52 gap itself.
  ['ascii unchanged', 'orders', 'quoted', '[orders]'],
  ['chinese table', CJK, 'quoted', `[${CJK}]`],
  ['chinese schema + table', `dbo.${CJK}`, 'quoted', `[dbo].[${CJK}]`],
  ['chinese schema too', `仓库.${CJK}`, 'quoted', `[仓库].[${CJK}]`],
  ['inner spaces', 'sales order 2024', 'quoted', '[sales order 2024]'],
  ['chinese with space', `销售 ${CJK}`, 'quoted', `[销售 ${CJK}]`],
  ['ideographic space', `a　b`, 'quoted', '[a　b]'],
  ['hangul', '물품', 'quoted', '[물품]'],
  ['cyrillic', 'товары', 'quoted', '[товары]'],
  ['combining marks', 'cáfé', 'quoted', '[cáfé]'],
  ['leading digit', '2024_orders', 'quoted', '[2024_orders]'],
  ['three parts (cross-database, pre-existing)', 'tenant.dbo.orders', 'quoted', '[tenant].[dbo].[orders]'],
  ['128 UTF-16 units', 'x'.repeat(128), 'quoted', `[${'x'.repeat(128)}]`],
  ['64 supplementary = 128 units', SUPPLEMENTARY.repeat(64), 'quoted', `[${SUPPLEMENTARY.repeat(64)}]`],

  // Accepted — and ESCAPED. These are the cases the `]]` doubling exists for.
  ['embedded right bracket', 'a]b', 'quoted', '[a]]b]'],
  ['already-doubled right bracket is data too', 'a]]b', 'quoted', '[a]]]]b]'],
  ['bracket at the end', 'orders]', 'quoted', '[orders]]]'],
  ['INJECTION: bracket + write verb', 'a] DROP TABLE x', 'quoted', '[a]] DROP TABLE x]'],
  ['INJECTION: bracket + batch separator attempt', `${CJK}] SELECT 1`, 'quoted', `[${CJK}]] SELECT 1]`],

  // OUTER TRIM — DISCARDED, NOT REFUSED. The rules are per SEGMENT, and `requiredString` ->
  // `String#trim()` runs on the whole value before it is split, so at the two OUTER edges every JS
  // WhiteSpace/LineTerminator — spaces, tab, LF, CR, U+2028, U+2029 and U+FEFF — is dropped silently.
  // Inherited from main (`'orders '` has always been accepted); newly REACHABLE here because a
  // Unicode/spaced name now gets far enough to be trimmed at all. Pinned so it cannot drift: the
  // segment-level rule and the M5 probe both look only INSIDE a segment and would stay green if the
  // outer behaviour changed.
  ['OUTER TRIM: trailing space discarded', `${CJK} `, 'quoted', `[${CJK}]`],
  ['OUTER TRIM: trailing newline discarded', 'a\n', 'quoted', '[a]'],
  ['OUTER TRIM: leading BOM discarded', '\ufefforders', 'quoted', '[orders]'],
  ['OUTER TRIM: leading spaces discarded', '  a', 'quoted', '[a]'],
  // …and the contrast that proves the trim is JS-whitespace, not "anything invisible": a NUL at the
  // very same edge is NOT whitespace, so it is still refused.
  ['OUTER EDGE NUL is not whitespace — still refused', '\u0000a', 'refused'],
  ['OUTER EDGE BEL is not whitespace — still refused', 'a\u0007', 'refused'],

  // Refused.
  ['INJECTION: bracket + write verb + line comment', 'a] DROP TABLE x --', 'refused'],
  ['INJECTION: semicolon batch', 'a;DROP TABLE x', 'refused'],
  ['INJECTION: quote + union', "a' UNION SELECT 1 --", 'refused'],
  ['INJECTION: block comment', 'a/*x*/b', 'refused'],
  ['INJECTION: pre-bracketed, as pasted from SSMS', `[dbo].[${CJK}]`, 'refused'],
  ['INJECTION: lone opening bracket', 'a[b', 'refused'],
  ['four parts (LINKED SERVER)', 'srv.tenant.dbo.orders', 'refused'],
  ['five parts', 'a.b.c.d.e', 'refused'],
  ['empty', '', 'refused'],
  ['whitespace only', '   ', 'refused'],
  ['empty middle segment', 'tenant..orders', 'refused'],
  ['trailing dot', 'dbo.', 'refused'],
  ['leading dot', '.orders', 'refused'],
  ['inner segment leading space', `dbo. ${CJK}`, 'refused'],
  ['newline', 'a\nb', 'refused'],
  ['carriage return', 'a\rb', 'refused'],
  ['tab', 'a\tb', 'refused'],
  ['NUL', 'a\u0000b', 'refused'],
  ['bell', 'a\u0007b', 'refused'],
  ['DEL', 'a\u007fb', 'refused'],
  ['C1 control', 'a\u0085b', 'refused'],
  ['zero-width space', 'a\u200bb', 'refused'],
  ['zero-width joiner', 'a\u200db', 'refused'],
  ['RTL override (spoofing)', 'a\u202eb', 'refused'],
  ['BOM', 'a\ufeffb', 'refused'],
  ['line separator U+2028', 'a\u2028b', 'refused'],
  ['paragraph separator U+2029', 'a\u2029b', 'refused'],
  ['lone high surrogate', 'a\ud800b', 'refused'],
  ['hyphen', 'bad-name', 'refused'],
  ['dollar placeholder collision', 'amount$1', 'refused'],
  ['at sign', 'a@b', 'refused'],
  ['percent', 'a%b', 'refused'],
  ['backslash', 'a\\b', 'refused'],
  ['double quote', 'a"b', 'refused'],
  ['129 UTF-16 units', 'x'.repeat(129), 'refused'],
  ['65 supplementary = 130 units', SUPPLEMENTARY.repeat(65), 'refused'],
  ['128 code points but 256 units', SUPPLEMENTARY.repeat(128), 'refused'],
  ['long segment inside a qualified name', `dbo.${'x'.repeat(129)}`, 'refused'],
]

function testIdentifierMatrix() {
  for (const [label, input, expected, expectedQuoted] of MATRIX) {
    const result = classify(input, label)
    assert.equal(result.outcome, expected, `${label}: expected ${expected}, got ${result.outcome}`)
    if (expected === 'quoted' && expectedQuoted !== undefined) {
      assert.equal(result.quoted, expectedQuoted, `${label}: exact quoted text`)
    }
  }
  // No case in the matrix is silently missing an expectation.
  assert.equal(MATRIX.every(([, , expected]) => expected === 'quoted' || expected === 'refused'), true)
}

// ── round-trip property ──────────────────────────────────────────────────────
// A deterministic PRNG so a failure is reproducible from the seed printed below.
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const ALPHABET = [
  'a', 'Z', '0', '9', '_', ' ', ']',
  '订', '单', '仓', // CJK
  '물', 'т', 'é', 'ก', // Hangul / Cyrillic / Latin-1 / Thai
  '　', // ideographic space
  SUPPLEMENTARY,
]

function testRoundTripProperty() {
  const seed = 20260910
  const random = makeRandom(seed)
  let checked = 0
  for (let i = 0; i < 400; i += 1) {
    const parts = []
    const partCount = 1 + Math.floor(random() * 3)
    for (let p = 0; p < partCount; p += 1) {
      let part = ''
      const target = 1 + Math.floor(random() * 12)
      while (part.length < target) part += ALPHABET[Math.floor(random() * ALPHABET.length)]
      // Edge spaces are refused by rule; the property is about ACCEPTED identifiers.
      part = part.replace(/^[\s　]+|[\s　]+$/g, 'q')
      parts.push(part)
    }
    const value = parts.join('.')
    if (parts.some((part) => part.length === 0 || part.length > 128)) continue
    const quoted = helper.quoteSqlServerIdentifier(value, `property[${i}]`)
    assertBracketShape(quoted, `property[${i}] ${JSON.stringify(value)}`)
    assert.equal(helper.unquoteSqlServerIdentifier(quoted), value, `property[${i}] seed=${seed} round-trip`)
    // The escape rule, counted independently of the parser: each segment contributes its own two
    // delimiters plus TWO brackets for every `]` in the name.
    const expectedBrackets = parts.reduce((sum, part) => sum + 1 + 2 * (part.split(']').length - 1), 0)
    assert.equal(
      quoted.split(']').length - 1,
      expectedBrackets,
      `property[${i}] seed=${seed}: ] count must be 2*literal + 1 per segment`,
    )
    checked += 1
  }
  assert.ok(checked > 300, `property test must actually exercise cases (checked ${checked})`)
}

// ── segment-level primitive ──────────────────────────────────────────────────
function testSegmentPrimitive() {
  // A dot is NOT a separator here — the single-segment entry point treats it as an ordinary character
  // and refuses it, so a caller that already split cannot smuggle a second segment past the cap.
  assert.equal(helper.quoteSqlServerIdentifierPart(CJK), `[${CJK}]`)
  assert.equal(helper.quoteSqlServerIdentifierPart('a]b'), '[a]]b]')
  assert.throws(
    () => helper.quoteSqlServerIdentifierPart('dbo.orders'),
    (error) => error.code === 'SQLSERVER_IDENTIFIER_INVALID',
  )
  assert.equal(helper.assertSqlServerIdentifierPart(`销售 ${CJK}`), `销售 ${CJK}`)

  // `assertSqlServerIdentifier` enforces the SAME rule as the quoter — one gate, two exits, no seam
  // where a value could be "validated" by one and rejected only by the other.
  for (const [, input, expected] of MATRIX) {
    let asserted = true
    try { helper.assertSqlServerIdentifier(input) } catch { asserted = false }
    let quotedOk = true
    try { helper.quoteSqlServerIdentifier(input) } catch { quotedOk = false }
    assert.equal(asserted, quotedOk, `assertSqlServerIdentifier and quoteSqlServerIdentifier disagree on ${JSON.stringify(input)} (${expected})`)
  }

  // …and it hands back NOTHING. The removed `normalizeIdentifier` returned the trimmed original, which
  // under the G52 rule may carry spaces, `]` and whole SQL keyword sequences — a string shaped like a
  // sanitized value but safe only inside brackets. Nothing to interpolate is the guarantee.
  assert.equal(helper.assertSqlServerIdentifier(`dbo.${CJK}`), undefined)
  assert.equal(helper.assertSqlServerIdentifier('a]b'), undefined)
  assert.equal('normalizeIdentifier' in helper, false, 'the value-returning entry point must be gone, not shadowed')

  // The strict reader refuses anything that is not well-formed bracketed text.
  for (const bad of ['orders', '[a', 'a]', '[a]b', '[a].', '[a]..[b]', '', '[a]x[b]']) {
    assert.throws(
      () => helper.unquoteSqlServerIdentifier(bad),
      (error) => error.code === 'SQLSERVER_IDENTIFIER_INVALID',
      `unquote must refuse ${JSON.stringify(bad)}`,
    )
  }
}

// ── the builders that consume the quoter ─────────────────────────────────────
function testBuildersQuoteUnicode() {
  const inputs = []
  const request = { input(name, value) { inputs.push([name, value]); return request } }
  const sql = helper.buildSimpleSelectQuery({
    request,
    table: `dbo.${CJK}`,
    columns: ['物料编码', 'a]b'],
    limit: 5,
    filters: { '供应商 名称': 'ACME' },
    orderBy: '物料编码',
  })
  assert.equal(
    sql,
    `SELECT TOP 5 [物料编码], [a]]b] FROM [dbo].[${CJK}]` +
      ' WHERE [供应商 名称] = @filter_0' +
      ' ORDER BY [物料编码]',
  )
  // The VALUE never travels in the statement text — only a bound parameter name does.
  assert.deepEqual(inputs, [['filter_0', 'ACME']])
  assert.equal(sql.includes('ACME'), false)

  const where = helper.buildGenericWhereClause({ [`状态`]: 'open', 'a]b': 1 })
  assert.equal(where.sql, 'WHERE [状态] = $1 AND [a]]b] = $2')
  assert.deepEqual(where.params, ['open', 1])

  // An identifier the rule refuses stops the whole statement — it is never partially built.
  assert.throws(
    () => helper.buildSimpleSelectQuery({ request, table: 'dbo.t', columns: ['a;DROP TABLE x'] }),
    (error) => error.code === 'SQLSERVER_IDENTIFIER_INVALID',
  )
}

// ── mutation probes (in memory; nothing is written to disk) ──────────────────
// Each probe removes ONE guard from a private copy of the runtime and shows the assertions above go
// red. A guard whose removal changes nothing is decoration, not a guard.
function loadMutatedHelper(label, mutate) {
  const source = fs.readFileSync(helperRuntime, 'utf8')
  const mutated = mutate(source)
  assert.notEqual(mutated, source, `${label}: the mutation must actually change the source`)
  const sandbox = new Module(`${helperRuntime}#${label}`, module)
  sandbox.filename = helperRuntime
  sandbox.paths = Module._nodeModulePaths(path.dirname(helperRuntime))
  sandbox._compile(mutated, helperRuntime)
  return sandbox.exports
}

const DROP_ESCAPE = (source) => source.replace(".replace(/]/g, ']]')", '')
const DROP_ROUNDTRIP_PROOF = (source) =>
  source.replace(
    "  if (!parsed || parsed.end !== quoted.length || parsed.value !== safe) {",
    '  if (false) {',
  )

function testMutationProbes() {
  // M1 — remove the `]` doubling. The quoter's own round-trip proof catches it and REFUSES, so the
  // matrix row that pins `[a]] DROP TABLE x]` goes red either way.
  {
    const mutated = loadMutatedHelper('no-escape', DROP_ESCAPE)
    assert.throws(
      () => mutated.quoteSqlServerIdentifier('a] DROP TABLE x'),
      (error) => error.code === 'SQLSERVER_IDENTIFIER_INVALID' && /losslessly/.test(error.message),
      'M1: without the escape the quoter must refuse rather than emit',
    )
  }

  // M1b — remove the doubling AND the proof, i.e. the pre-G52 quoting shape. NOW the injection lands:
  // the emitted text ends the identifier early and the rest of the name becomes SQL. Our independent
  // scanner sees it, which is what makes the matrix rows above load-bearing rather than cosmetic.
  {
    const mutated = loadMutatedHelper('no-escape-no-proof', (source) => DROP_ROUNDTRIP_PROOF(DROP_ESCAPE(source)))
    const emitted = mutated.quoteSqlServerIdentifier('a] DROP TABLE x')
    assert.equal(emitted, '[a] DROP TABLE x]', 'M1b: the unescaped emission is the injection')
    assert.notEqual(emitted, '[a]] DROP TABLE x]')
    assert.throws(
      () => assertBracketShape(emitted, 'M1b'),
      /segments must be separated by a single dot/,
      'M1b: the independent shape scanner must reject the unescaped emission',
    )
  }

  // M2 — widen the character rule to admit `\p{C}` (controls, format/bidi, surrogates). The rejection
  // rows for newline / NUL / zero-width / RTL-override go red.
  {
    const mutated = loadMutatedHelper('allow-control', (source) =>
      source.replace('/^[\\p{L}\\p{M}\\p{N}_\\p{Zs}\\]]+$/u', '/^[\\p{L}\\p{M}\\p{N}_\\p{Zs}\\]\\p{C}]+$/u'))
    assert.equal(mutated.quoteSqlServerIdentifier('a\nb'), '[a\nb]', 'M2: control characters now pass')
    assert.equal(mutated.quoteSqlServerIdentifier('a\u0000b'), '[a\u0000b]')
    assert.throws(() => assertBracketShape(mutated.quoteSqlServerIdentifier('a\u0000b'), 'M2'), /control character/)
  }

  // M3 — remove the four-part cap. The LINKED SERVER row goes red.
  {
    const mutated = loadMutatedHelper('no-part-cap', (source) =>
      source.replace('const IDENTIFIER_MAX_PARTS = 3', 'const IDENTIFIER_MAX_PARTS = 99'))
    assert.equal(
      mutated.quoteSqlServerIdentifier('srv.tenant.dbo.orders'),
      '[srv].[tenant].[dbo].[orders]',
      'M3: without the cap a linked-server name is emitted',
    )
  }

  // M4 — remove the length cap. The 129-unit row goes red.
  {
    const mutated = loadMutatedHelper('no-length-cap', (source) =>
      source.replace('const IDENTIFIER_MAX_CODE_UNITS = 128', 'const IDENTIFIER_MAX_CODE_UNITS = 100000'))
    assert.equal(mutated.quoteSqlServerIdentifier('x'.repeat(129)), `[${'x'.repeat(129)}]`, 'M4: over-long names now pass')
  }

  // M5 — remove the edge-space rule. The `dbo. 订单` row goes red.
  {
    const mutated = loadMutatedHelper('no-edge-space', (source) =>
      source.replace('/^\\p{Zs}|\\p{Zs}$/u', '/(?!)/u'))
    assert.equal(mutated.quoteSqlServerIdentifier(`dbo. ${CJK}`), `[dbo].[ ${CJK}]`, 'M5: an invisible edge space now passes')
  }

  // The unmutated module is untouched by all of the above.
  assert.equal(helper.quoteSqlServerIdentifier('a] DROP TABLE x'), '[a]] DROP TABLE x]')
}

testIdentifierMatrix()
testRoundTripProperty()
testSegmentPrimitive()
testBuildersQuoteUnicode()
testMutationProbes()

console.log('[mssql-readonly-utils] unicode identifier tests passed')
