/**
 * OD-6 scanner self-tests — the defeat-then-fix proof.
 *
 * The #4227 draft's scanner (line-by-line, case-sensitive `MUTATION_RE`) was proven defeatable on the
 * LIVE guard: an unmarked UPPERCASE `UPDATE meta_records` reds it, but the lowercase twin passes 11/11
 * undetected, and a verb/table split across lines is invisible to a per-line test. Every fixture below
 * is fed straight to `enumerateSites` — no disk writes — and each "evasion" fixture is asserted RED
 * (site found, `disposition: null`), proving the NEW scanner catches exactly what the old one missed.
 */
import { describe, expect, test } from 'vitest'

import { enumerateSites, findEnclosingAnchor, hashSite, stripComments } from './lib/multitable-revision-disposition-scanner'

describe('OD-6 scanner — case-insensitive + multiline mutation detection (blocker #1 fix)', () => {
  test('uppercase unmarked multiline UPDATE is detected (positive control — proves the harness works)', () => {
    const src = [
      'async function doThing(query: any) {',
      '  const x = await query(',
      '    `UPDATE meta_records',
      '     SET data = $1',
      '     WHERE id = $2`,',
      '    [a, b],',
      '  )',
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: lowercase unmarked multiline update — the #4227 evasion — is now detected', () => {
    const src = [
      'async function doThing(query: any) {',
      '  const x = await query(',
      '    `update meta_records',
      '     set data = $1',
      '     where id = $2`,',
      '    [a, b],',
      '  )',
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: mixed-case unmarked single-line DELETE is detected', () => {
    const src = "async function drop(query: any) {\n  await query('Delete From meta_records WHERE id = $1', [id])\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: verb and table name split across separate lines (multiline INSERT) is detected', () => {
    const src = [
      'async function create(query: any) {',
      '  await query(',
      '    `INSERT',
      '     INTO',
      '     meta_records (id, sheet_id, data, version)',
      '     VALUES ($1, $2, $3::jsonb, 1)`,',
      '  )',
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('a comment-only mention of the SQL text is NOT flagged as a mutation site (no over-match)', () => {
    const src = [
      '// Historical note: this handler used to run UPDATE meta_records directly before D-1c.',
      '/* Multi-line block comment mentioning DELETE FROM meta_records for context. */',
      'function unrelated() { return 1 }',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(0)
  })

  test('Kysely builder forms (updateTable/deleteFrom/insertInto) are also matched, case-insensitively', () => {
    const src = "async function k(db: any) {\n  await db.UPDATETABLE('meta_records').set({ x: 1 }).execute()\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
  })

  test('meta_records_trash is NOT matched (word-boundary check on the table name)', () => {
    const src = "async function t(query: any) {\n  await query('DELETE FROM meta_records_trash WHERE id = $1', [id])\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(0)
  })
})

describe('OD-6 scanner — gate P3-1: schema-qualified / double-quoted meta_records no longer evades detection', () => {
  test('DEFEAT PROOF: schema-qualified unmarked UPDATE (public.meta_records) is now detected', () => {
    const src = "async function u(query: any) {\n  await query('UPDATE public.meta_records SET data = $1 WHERE id = $2', [a, b])\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: double-quoted unmarked UPDATE ("meta_records") is now detected', () => {
    const src = 'async function u(query: any) {\n  await query(\'UPDATE "meta_records" SET data = $1 WHERE id = $2\', [a, b])\n}\n'
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: schema-qualified AND double-quoted unmarked DELETE (public."meta_records") is now detected', () => {
    const src = 'async function d(query: any) {\n  await query(\'DELETE FROM public."meta_records" WHERE id = $1\', [id])\n}\n'
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: quoted schema AND quoted table unmarked INSERT ("public"."meta_records") is now detected', () => {
    const src = 'async function c(query: any) {\n  await query(\'INSERT INTO "public"."meta_records" (id, data) VALUES ($1, $2)\', [a, b])\n}\n'
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('DEFEAT PROOF: schema-qualified Kysely builder form (updateTable(\'public.meta_records\')) is now detected', () => {
    const src = "async function k(db: any) {\n  await db.updateTable('public.meta_records').set({ x: 1 }).execute()\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBeNull()
  })

  test('a marked schema-qualified site is still correctly classified (widening did not break marker classification)', () => {
    const src = [
      'function doThing(query: any) {',
      '  // revision-emitted: test fixture, schema-qualified',
      "  const x = query('UPDATE public.meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(1)
    expect(sites[0].disposition).toBe('EMITTED')
  })

  test('sibling table meta_records_trash, SCHEMA-QUALIFIED, is still NOT matched (no over-widening)', () => {
    const src = "async function t(query: any) {\n  await query('UPDATE public.meta_records_trash SET x = 1', [])\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(0)
  })

  test('sibling table meta_records_trash, DOUBLE-QUOTED, is still NOT matched (no over-widening)', () => {
    const src = 'async function t(query: any) {\n  await query(\'UPDATE "meta_records_trash" SET x = 1\', [])\n}\n'
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(0)
  })

  test('sibling table meta_record_revisions (singular "record") is still NOT matched', () => {
    const src = "async function t(query: any) {\n  await query('UPDATE public.meta_record_revisions SET x = 1', [])\n}\n"
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(0)
  })

  test('sibling table meta_records_xyz, DOUBLE-QUOTED, is still NOT matched', () => {
    const src = 'async function t(query: any) {\n  await query(\'DELETE FROM "meta_records_xyz" WHERE id = $1\', [id])\n}\n'
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(0)
  })
})

describe('OD-6 scanner — marker window discipline (mirrors rank-8 MARKER_WINDOW=3)', () => {
  test('a revision-emitted marker within the 3-line window is recognized', () => {
    const src = [
      'function doThing(query: any) {',
      '  // revision-emitted: test fixture',
      "  const x = query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites[0].disposition).toBe('EMITTED')
  })

  test('a revision-exempt marker within the window is recognized', () => {
    const src = [
      'function doThing(query: any) {',
      '  // revision-exempt: system recompute, no user actor',
      "  const x = query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites[0].disposition).toBe('EXEMPT')
  })

  test('a revision-pending marker within the window is recognized', () => {
    const src = [
      'function doThing(query: any) {',
      '  // revision-pending: owner-ruled MUST-WRITE, not yet implemented — see KNOWN_REVISION_GAPS',
      "  const x = query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites[0].disposition).toBe('PENDING')
  })

  test('a marker 4 lines above (outside the 3-line window) does NOT count — guard stays red', () => {
    const src = [
      'function doThing(query: any) {',
      '  // revision-emitted: too far away to count',
      '  const pad1 = 1',
      '  const pad2 = 2',
      '  const pad3 = 3',
      "  const x = query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites[0].disposition).toBeNull()
  })

  test('a malformed marker (missing the colon) is not accepted', () => {
    const src = [
      'function doThing(query: any) {',
      '  // revision-emitted no colon here',
      "  const x = query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites[0].disposition).toBeNull()
  })
})

describe('OD-6 scanner — stable site IDs (blocker #2 fix)', () => {
  const markedSite = (padding: string[]) =>
    [
      ...padding,
      'function foo(query: any) {',
      '  // revision-emitted: x',
      "  const r = query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')

  test('siteId is UNCHANGED when unrelated lines are inserted ABOVE the site (the #4227 failure mode)', () => {
    const before = enumerateSites('fixture.ts', markedSite([]))
    const after = enumerateSites(
      'fixture.ts',
      markedSite(['// unrelated new comment line 1', '// unrelated new comment line 2', '// unrelated new comment line 3']),
    )
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(1)
    // line number DID shift...
    expect(after[0].line).toBe(before[0].line + 3)
    // ...but the stable id did NOT.
    expect(after[0].siteId).toBe(before[0].siteId)
  })

  test('two byte-identical statements in the SAME function get DIFFERENT stable ids (occurrence index)', () => {
    const src = [
      'function foo(query: any) {',
      '  // revision-emitted: a',
      "  query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '  // revision-emitted: b',
      "  query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])",
      '}',
    ].join('\n')
    const sites = enumerateSites('fixture.ts', src)
    expect(sites).toHaveLength(2)
    expect(sites[0].siteId).not.toBe(sites[1].siteId)
  })

  test('the SAME statement in a DIFFERENT enclosing function gets a DIFFERENT stable id', () => {
    const a = enumerateSites(
      'fixture.ts',
      "function foo(query: any) {\n  // revision-emitted: x\n  query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])\n}\n",
    )
    const b = enumerateSites(
      'fixture.ts',
      "function bar(query: any) {\n  // revision-emitted: x\n  query('UPDATE meta_records SET data = $1 WHERE id = $2', [a, b])\n}\n",
    )
    expect(a[0].siteId).not.toBe(b[0].siteId)
  })

  test('hashSite is a pure function of its inputs (deterministic, not time/random based)', () => {
    expect(hashSite('f.ts', 'anchor', 'fp', 0)).toBe(hashSite('f.ts', 'anchor', 'fp', 0))
    expect(hashSite('f.ts', 'anchor', 'fp', 0)).not.toBe(hashSite('f.ts', 'anchor', 'fp', 1))
  })
})

describe('OD-6 scanner — anchor detection', () => {
  test('finds the nearest named function above the site', () => {
    const src = 'async function patchRecord(query: any) {\n  // revision-emitted: x\n  query(\'UPDATE meta_records SET data=$1 WHERE id=$2\', [a,b])\n}\n'
    const lines = stripComments(src).split('\n')
    expect(findEnclosingAnchor(lines, 2)).toBe('patchRecord')
  })

  test('falls back to a route: anchor for an anonymous route handler', () => {
    const src = [
      "router.post('/views/:viewId/submit', async (req, res) => {",
      '  // revision-emitted: x',
      "  query('UPDATE meta_records SET data=$1 WHERE id=$2', [a,b])",
      '})',
    ].join('\n')
    const lines = stripComments(src).split('\n')
    expect(findEnclosingAnchor(lines, 2)).toBe('route:post:/views/:viewId/submit')
  })
})

describe('OD-6 scanner — comment stripping preserves line structure', () => {
  test('stripped text has the same length and the same number of lines as the input', () => {
    const src = "// a comment\n/* block\n   comment */\nconst x = 'a string // not a comment /* also not */'\n"
    const stripped = stripComments(src)
    expect(stripped.length).toBe(src.length)
    expect(stripped.split('\n').length).toBe(src.split('\n').length)
  })

  test('string/template literal content survives verbatim (SQL text is never stripped)', () => {
    const src = "const q = `UPDATE meta_records SET data = $1` // trailing comment\n"
    const stripped = stripComments(src)
    expect(stripped).toContain('UPDATE meta_records SET data = $1')
    expect(stripped).not.toContain('trailing comment')
  })
})
