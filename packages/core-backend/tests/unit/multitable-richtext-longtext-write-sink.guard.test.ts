/**
 * DURABLE STRUCTURAL GUARD — "a new `meta_records.data` writer must route rich `longText`
 * through the sanitizer chokepoint by construction".
 *
 * The rich-`longText` write sanitizer (`validateLongTextValue` / `sanitizeRichLongText`) is the
 * authoritative server-side stored-XSS defense: a `{rich:true}` value must be stored INERT no
 * matter which write boundary it arrives on. The threat is MULTI-SINK and the history is
 * whack-a-mole — TWO sinks were missed in review rounds:
 *
 *   1. automation `update_record` / `create_record` write `meta_records.data` via BARE SQL,
 *      bypassing the 5 record-write validators (covered by `sanitizeRichLongTextInWritePayload`).
 *   2. the plugin-SDK `records.ts` `createRecord` / `patchRecord` normalize through
 *      `normalizeFieldValue`, which had NO `longText` case → a rich value was stored RAW
 *      (the REQUEST-CHANGES blocker; now routed through `validateLongTextValue`).
 *
 * This guard prevents a THIRD silent miss: it enumerates EVERY runtime `src` file that writes
 * `meta_records.data` (an `INSERT INTO meta_records` / `UPDATE meta_records ... SET ... data`)
 * and compares it against a FROZEN, documented allowlist. A NEW or removed writer file fails the
 * test until a contributor classifies it:
 *
 *   CHOKEPOINT — the file references the rich-`longText` sanitizer (`validateLongTextValue` or
 *                `sanitizeRichLongText`), i.e. user-supplied field values flow through it.
 *   SAFE       — the file only writes NON-user-content columns (auto-number / computed formula
 *                keys / schema repair), so no rich-`longText` carrier can be present. Reason inline.
 *
 * If this test fails you almost certainly added a record-data writer. If it carries arbitrary
 * field values, route them through `validateLongTextValue(value, fieldId, field.property)` (or the
 * shared `sanitizeRichLongText` for bare-SQL payloads); then add the file to ALLOWLIST below with
 * its disposition. This is the structural complement to the per-sink canaries in
 * `richtext-longtext-sanitizer.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')

/** Recursively list every runtime `.ts` file under `src/` (paths `/`-separated, relative to `src/`),
 *  excluding build output, tests, and `node_modules`. The migration tree IS included (a migration that
 *  back-fills `meta_records.data` is itself a writer worth classifying). */
function listRuntimeTsFiles(): string[] {
  const out: string[] = []
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue
      out.push(relative(SRC, abs).split(sep).join('/'))
    }
  }
  walk(SRC)
  return out.sort()
}

/**
 * FROZEN allowlist of every `src` file that writes `meta_records.data`, keyed by `src`-relative path.
 *   CHOKEPOINT — references `validateLongTextValue` / `sanitizeRichLongText` (this is asserted, not assumed).
 *   SAFE       — writes only non-user-content columns; a rich-`longText` value can never appear.
 */
const ALLOWLIST: Record<string, { disposition: 'CHOKEPOINT' | 'SAFE'; reason: string }> = {
  'multitable/records.ts': {
    disposition: 'CHOKEPOINT',
    reason: 'plugin-SDK createRecord/patchRecord → normalizeFieldValue routes longText through validateLongTextValue',
  },
  'multitable/record-service.ts': {
    disposition: 'CHOKEPOINT',
    reason: 'createRecord/patch validate longText via validateLongTextValue(field.property)',
  },
  'multitable/record-write-service.ts': {
    disposition: 'CHOKEPOINT',
    reason: 'bulk-PATCH validate/patch route longText through validateLongTextValue',
  },
  'multitable/automation-executor.ts': {
    disposition: 'CHOKEPOINT',
    reason: 'update_record/create_record bare-SQL writes route through sanitizeRichLongTextInWritePayload (sanitizeRichLongText)',
  },
  'routes/univer-meta.ts': {
    disposition: 'CHOKEPOINT',
    reason: 'HTTP form-submit / import-xlsx / record routes validate longText via validateLongTextValue',
  },
  'multitable/auto-number-service.ts': {
    disposition: 'SAFE',
    reason: 'writes ONLY auto-number columns (numeric sequence values) — never a user-supplied longText carrier',
  },
  'multitable/formula-engine.ts': {
    disposition: 'SAFE',
    reason: 'writes ONLY computed formula-result keys — derived server-side, never raw user HTML',
  },
}

/** A file is a `meta_records.data` writer iff it contains an INSERT/UPDATE touching `meta_records`
 *  and (for UPDATE) sets `data`. Tight enough to ignore reads/locks/deletes, loose enough that a new
 *  data writer trips RED. */
function writesRecordData(src: string): boolean {
  if (/INSERT\s+INTO\s+meta_records/i.test(src)) return true
  // UPDATE meta_records ... SET ... data — match an UPDATE block that assigns `data`.
  const updates = src.match(/UPDATE\s+meta_records[\s\S]{0,400}?(?=RETURNING|WHERE|;|`)/gi) ?? []
  return updates.some((block) => /\bdata\s*=/.test(block) || /\bdata\b/.test(block))
}

const SANITIZER_REF = /\bvalidateLongTextValue\b|\bsanitizeRichLongText\b/

describe('rich-longText write-sink — durable structural guard', () => {
  const writerFiles = listRuntimeTsFiles().filter((rel) => writesRecordData(readFileSync(join(SRC, rel), 'utf8')))

  test('every meta_records.data writer file is in the audited allowlist', () => {
    expect(writerFiles.length).toBeGreaterThan(0)
    const unaudited = writerFiles.filter((rel) => ALLOWLIST[rel] === undefined)
    expect(
      unaudited,
      `RICH-LONGTEXT WRITE-SINK GUARD: ${unaudited.length} unaudited meta_records.data writer file(s):\n` +
        unaudited.map((rel) => `  - ${rel}`).join('\n') +
        `\n\nYou likely added a record-data writer. If it carries arbitrary field values, route them ` +
        `through validateLongTextValue(value, fieldId, field.property) (or sanitizeRichLongText for ` +
        `bare-SQL payloads), then add the file to ALLOWLIST with its disposition (CHOKEPOINT / SAFE+reason).`,
    ).toEqual([])
  })

  test('every CHOKEPOINT-classified writer actually references the rich-longText sanitizer', () => {
    const lying = writerFiles.filter(
      (rel) => ALLOWLIST[rel]?.disposition === 'CHOKEPOINT' && !SANITIZER_REF.test(readFileSync(join(SRC, rel), 'utf8')),
    )
    expect(
      lying,
      `These files are marked CHOKEPOINT but do NOT reference validateLongTextValue/sanitizeRichLongText ` +
        `(the sanitizer was removed or never wired):\n` +
        lying.map((rel) => `  - ${rel}`).join('\n'),
    ).toEqual([])
  })

  test('no allowlisted file went stale (every audited entry is still a writer)', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => !writerFiles.includes(rel))
    expect(
      stale,
      `These ALLOWLIST entries are no longer meta_records.data writers — remove them so the allowlist ` +
        `stays an exact census:\n` + stale.map((rel) => `  - ${rel}`).join('\n'),
    ).toEqual([])
  })
})
