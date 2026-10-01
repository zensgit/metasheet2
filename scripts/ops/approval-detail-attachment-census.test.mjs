// Self-test for scripts/ops/approval-detail-attachment-census.sql (approval-detail-leaf-
// attachment-pin-20260904, gate F6).
//
// STATIC-ONLY (hermetic: no database, no network). Unlike the O2 observation kit's self-test
// (scripts/ops/multitable-o2-observation.test.mjs), this file's SQL has no operator EDIT-ME
// VALUES lists and is never handed untrusted or interactively-edited input, so a simple
// line-comment-aware `;`-split is a faithful census here — verified by inspection that the file's
// only string literals are the jsonpath predicate strings, none of which contain a literal `--`
// or `;`. If this file ever grows a string literal containing either, this test's split will
// silently misclassify — the O2 kit's fuller string/dollar-quote-aware scanner is the pattern to
// upgrade to if that happens (see its file header for why simpler scanners are unsafe in general).
//
// What this proves: every top-level statement is a SELECT or a `WITH … SELECT` (never an INSERT/
// UPDATE/DELETE/MERGE or DDL) — i.e. the file is read-only by construction. It does NOT execute
// the file against a real database (no DATABASE_URL wiring here); correctness of the jsonpath
// predicate itself was verified by hand against a scratch PostgreSQL 15 instance during authoring
// (see the branch's commit message) and is out of scope for a hermetic static test.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL_PATH = resolve(HERE, 'approval-detail-attachment-census.sql')
const sqlText = readFileSync(SQL_PATH, 'utf8')

/** Strip `-- …` line comments (this file's only comment style — no /* block comments used). */
function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

function statementHeads(sql) {
  const stripped = stripLineComments(sql)
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split(/\s+/)[0].toUpperCase())
}

test('positive control: this file contains no /* block comments (the simple stripper assumption holds)', () => {
  assert.ok(!sqlText.includes('/*'), 'file uses /* block comments — upgrade stripLineComments before trusting this census')
})

test('positive control: the two jsonpath string literals used contain no bare -- or ; (the split assumption holds)', () => {
  const jsonpathLiterals = [...sqlText.matchAll(/'(\$\.fields[^']*)'/g)].map((m) => m[1])
  assert.ok(jsonpathLiterals.length >= 3, `expected at least 3 jsonpath predicate occurrences, found ${jsonpathLiterals.length}`)
  for (const literal of jsonpathLiterals) {
    assert.ok(!literal.includes('--'), `jsonpath literal unexpectedly contains --: ${literal}`)
    assert.ok(!literal.includes(';'), `jsonpath literal unexpectedly contains ;: ${literal}`)
  }
})

test('every top-level statement head is SELECT or WITH — the file is read-only by construction', () => {
  const heads = statementHeads(sqlText)
  assert.ok(heads.length >= 4, `expected at least 4 statements (a, b, c, c-detail), found ${heads.length}`)
  for (const head of heads) {
    assert.ok(
      head === 'SELECT' || head === 'WITH',
      `non-SELECT/WITH statement head found: ${head} — this file must stay read-only`,
    )
  }
})

test('negative control: a deliberately mutated copy WITH an INSERT is caught by the same check', () => {
  const mutated = `${sqlText}\nINSERT INTO approval_templates (key) VALUES ('should-be-caught');\n`
  const heads = statementHeads(mutated)
  assert.ok(heads.includes('INSERT'), 'mutation harness itself is broken: INSERT head not detected')
})

test('the three JSON-path predicate strings are byte-identical across (a), (b), and (c) — no silent drift between counts', () => {
  const literals = [...sqlText.matchAll(/'(\$\.fields\[\*\] \? \(@\.type == "detail"\) \.columns\[\*\] \? \(@\.type == "attachment"\))'/g)].map((m) => m[1])
  assert.ok(literals.length >= 3, `expected the exact predicate string at least 3 times (a/b/c), found ${literals.length}`)
  const unique = new Set(literals)
  assert.strictEqual(unique.size, 1, `predicate string drifted between call sites: ${[...unique].join(' | ')}`)
})

test('no forbidden write/DDL keywords appear anywhere in the file (belt-and-suspenders over the statement-head check)', () => {
  const stripped = stripLineComments(sqlText).toUpperCase()
  for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'CREATE ']) {
    assert.ok(!stripped.includes(keyword), `forbidden keyword "${keyword.trim()}" found in census SQL`)
  }
})
