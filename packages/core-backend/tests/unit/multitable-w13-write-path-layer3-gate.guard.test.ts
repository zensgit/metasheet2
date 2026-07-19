/**
 * W1-3 GW7 — durable structural guard: every write path that reaches `RecordWriteService.patchRecords` /
 * `RecordService.patchRecord` is enumerated against a FROZEN, disposition-tagged allowlist ("has a
 * layer-3 per-subject field_permissions gate" / "GATED_BY_CALLER" / "EXEMPT with a one-line reason"). A
 * NEW (or removed) call site anywhere in the backend `src` tree changes that file's call-site COUNT and
 * trips this test RED — forcing a contributor to add the gate (or classify an explicit exemption) instead
 * of silently landing a new side door, the way the Yjs bridge and the single-record PATCH route once did
 * (design-lock docs/development/multitable-per-subject-field-write-gate-w13-designlock-20260705.md §1).
 * Same discipline as `multitable-stored-data-taint-chokepoint.guard.test.ts`.
 *
 * GROUNDING (verified at line level while implementing this lock, re-confirm before editing this file):
 * this is a MORE COMPLETE enumeration than the design-lock doc's own "six route sites" — that count named
 * only the direct grid/restore/revert family. Two more independent write spines exist:
 *   - `routes/multitable-ai.ts` (AI shortcut run + AI bulk-fill commit) — EACH already applies its OWN
 *     pre-existing `#2106 F3` per-subject `fieldPermissions` pre-check (independently discovered; not
 *     mentioned by the design-lock doc, but genuinely gated).
 *   - `routes/univer-meta.ts`'s cross-base mirror write-through — gated by a BESPOKE per-subject
 *     `field_permissions` scope check on the semantic field being edited (not the shared
 *     `isFieldWriteForbidden` helper), thrown from inside its `preWriteGuard` callback before
 *     `patchRecords`' internal write.
 *   - `multitable/plugin-scope.ts`'s two `records.patchRecord` wrappers textually match the `.patchRecord(`
 *     call-site scan but call COMPLETELY DIFFERENT functions (the regular plugin records API and the
 *     transaction-scoped records API, not `RecordService.patchRecord`) — actor-less plugin-SDK write
 *     paths with no per-subject identity to gate against. Classified EXEMPT, not GATED.
 * This refines (does not contradict) the design-lock: the bridge and the single-record PATCH route remain
 * the only two paths that were actually ungated; the true existing-gated count is higher than "six".
 *
 * If this test fails: you added, removed, or moved a `.patchRecords(`/`.patchRecord(` call site. Add a
 * layer-3 per-subject `field_permissions` gate before it (reusing `isFieldWriteForbidden` from
 * `multitable/permission-derivation.ts` where the shape fits), or — only if writing on behalf of an
 * actor-less/system path where no subject identity applies — classify it EXEMPT with a one-line reason,
 * then update the allowlist below so the frozen count matches again.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Recursively list every runtime `.ts` file under `src/` (paths relative to `src/`, `/`-separated),
 *  excluding the migration tree, tests, and build output. Same whole-`src` walk the taint-chokepoint
 *  guard uses. */
function listRuntimeTsFiles(): string[] {
  const out: string[] = []
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'migrations') continue
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

const RUNTIME_FILES = listRuntimeTsFiles()

/**
 * Count every non-definition, non-comment `.patchRecords(` / `.patchRecord(` CALL site in `src`. A method
 * DEFINITION (`async patchRecords(input: RecordPatchInput) {` / `async patchRecord(input...) {`) has no
 * leading dot and is never matched. `.patchRecord(` can never match as a substring inside `.patchRecords(`
 * — the character immediately after `patchRecord` there is `s`, not `(` — so the two counts never
 * double-count each other. A line whose only-preceding-content (after trim) is `//` or `*` is treated as a
 * comment mention (JSDoc / line-comment), matching the taint-chokepoint guard's comment-skip.
 */
function countCallSites(src: string, methodName: 'patchRecords' | 'patchRecord'): number {
  const needle = `.${methodName}(`
  let count = 0
  let from = 0
  for (;;) {
    const idx = src.indexOf(needle, from)
    if (idx === -1) break
    from = idx + needle.length
    const lineStart = src.lastIndexOf('\n', idx) + 1
    const linePrefix = src.slice(lineStart, idx).trimStart()
    if (linePrefix.startsWith('//') || linePrefix.startsWith('*')) continue
    count += 1
  }
  return count
}

function countCallSitesByFile(methodName: 'patchRecords' | 'patchRecord'): Map<string, number> {
  const byFile = new Map<string, number>()
  for (const file of RUNTIME_FILES) {
    const n = countCallSites(read(file), methodName)
    if (n > 0) byFile.set(file, n)
  }
  return byFile
}

type Disposition = 'GATED' | 'GATED_BY_CALLER' | 'EXEMPT'
const PATCHRECORDS_ALLOWLIST: Record<string, Array<{ disposition: Disposition; reason: string }>> = {
  'collab/yjs-record-bridge.ts': [
    {
      disposition: 'GATED_BY_CALLER',
      reason:
        'W1-3: the write-input BUILDER (index.ts, injected into the YjsRecordBridge constructor) applies ' +
        'the layer-3 gate and THROWS FieldWritePermissionDeniedError before ever returning a forbidden ' +
        'input, so this call site never runs on a denied flush. The gate has no local marker in THIS file ' +
        'because it lives in the caller — see the separate index.ts smoke-check below.',
    },
  ],
  'routes/univer-meta.ts': [
    { disposition: 'GATED', reason: 'grid POST /patch, partialSuccess=true branch — forbiddenWriteFieldIds pre-check (isFieldWriteForbidden) runs before the branch' },
    { disposition: 'GATED', reason: 'grid POST /patch, default/all-or-nothing branch — same forbiddenWriteFieldIds pre-check' },
    { disposition: 'GATED', reason: 'records/:recordId/restore (single, preview+apply) — hasForbidden/layer3Ok pre-check (isFieldWriteForbidden)' },
    { disposition: 'GATED', reason: 'records/:recordId/restore-execute (single) — hasForbidden/layer3Ok pre-check (isFieldWriteForbidden)' },
    { disposition: 'GATED', reason: 'sheets/:sheetId/restore-batch-execute, all-or-nothing branch — recordIsForbidden pre-check (isFieldWriteForbidden)' },
    { disposition: 'GATED', reason: 'sheets/:sheetId/restore-batch-execute, PARTIAL per-record loop branch — same recordIsForbidden pre-check' },
    { disposition: 'GATED', reason: 'T8-1 revert-execute — per-record hasForbidden pre-check (isFieldWriteForbidden)' },
    {
      disposition: 'GATED',
      reason:
        'cross-base bidirectional-mirror write-through (forward-field write materializing a mirror-field ' +
        'edit) — bespoke per-subject gate: preWriteGuard loads field_permissions scope directly for the ' +
        'SEMANTIC field (the mirror field M_B the actor is really editing) and throws MirrorOpDeniedError ' +
        "(\"FIELD_POLICY_DENIED\") before patchRecords' internal write. Not the shared isFieldWriteForbidden " +
        'helper (a different, narrower per-op shape), but a genuine per-subject field_permissions check.',
    },
  ],
  'routes/multitable-ai.ts': [
    { disposition: 'GATED', reason: 'AI shortcut run (single target field) — targetPermission pre-check via buildRecordPatchContext.fieldPermissions (pre-existing #2106 F3 enforcement point)' },
    { disposition: 'GATED', reason: 'AI bulk-fill commitOneRecord (shared by bulk-commit B-2 and the B-4 job-commit phase) — targetPermission pre-check via patchContext.fieldPermissions (pre-existing #2106 F3 enforcement point)' },
  ],
}

const PATCHRECORD_ALLOWLIST: Record<string, Array<{ disposition: Disposition; reason: string }>> = {
  'routes/univer-meta.ts': [
    {
      disposition: 'GATED',
      reason:
        'W1-3 (this lock): PATCH /records/:recordId — forbiddenWriteFieldIds pre-check via ' +
        'buildRecordPatchContext(...).fieldPermissions + isFieldWriteForbidden, sendForbidden(...) BEFORE ' +
        'recordService.patchRecord. Covers BOTH mst_ token and session/JWT callers (apiTokenAuth next()s ' +
        'non-mst_ requests through to this same handler).',
    },
  ],
  'multitable/plugin-scope.ts': [
    {
      disposition: 'EXEMPT',
      reason:
        "Regular records wrapper: delegates to multitable/records.ts's OWN patchRecord (raw SQL " +
        "'UPDATE meta_records SET data = ...'), NOT RecordService.patchRecord — a structurally actor-less " +
        'plugin-SDK write path (guardRecordNotLockedForPlugin is called with actor=null). There is no ' +
        'per-subject identity for field_permissions to gate against on this path.',
    },
    {
      disposition: 'EXEMPT',
      reason:
        'P4 transaction-scoped records wrapper: delegates to the host-owned unit-of-work patchRecord, ' +
        'NOT RecordService.patchRecord. It remains actor-less and is additionally constrained to the ' +
        'four sheets declared by the stock-preparation persist operation.',
    },
  ],
}

/** Assert an allowlist's per-file entry count exactly matches the real call-site count, with a clear
 *  message on any drift (new file, removed file, or a count mismatch within a known file). */
function assertAllowlistMatchesReality(
  methodName: 'patchRecords' | 'patchRecord',
  allowlist: Record<string, Array<{ disposition: Disposition; reason: string }>>,
): void {
  const actualByFile = countCallSitesByFile(methodName)
  const expectedFiles = Object.keys(allowlist)
  const actualFiles = [...actualByFile.keys()]

  const newFiles = actualFiles.filter((f) => !expectedFiles.includes(f))
  expect(
    newFiles,
    `GW7 GUARD: .${methodName}( is now called from ${newFiles.length} file(s) NOT in the allowlist: ` +
      `${newFiles.join(', ')}. A NEW write path must apply the layer-3 per-subject field_permissions gate ` +
      '(or be classified EXEMPT with a one-line reason) and be added to the allowlist in this test file.',
  ).toEqual([])

  const goneFiles = expectedFiles.filter((f) => !actualFiles.includes(f))
  expect(
    goneFiles,
    `GW7 GUARD: the allowlist references file(s) with NO .${methodName}( call site anymore: ` +
      `${goneFiles.join(', ')}. Remove the stale entry from the allowlist in this test file.`,
  ).toEqual([])

  for (const file of expectedFiles) {
    const expectedCount = allowlist[file].length
    const actualCount = actualByFile.get(file) ?? 0
    expect(
      actualCount,
      `GW7 GUARD: ${file} has ${actualCount} .${methodName}( call site(s), but the allowlist documents ` +
        `${expectedCount}. A call site was added, removed, or moved — reclassify it and update the ` +
        'allowlist in this test file (each entry documents ONE call site\'s disposition + reason).',
    ).toBe(expectedCount)
  }
}

describe('W1-3 GW7 — durable structural guard: every patchRecords/patchRecord call site is gated or exempt', () => {
  test('every RecordWriteService.patchRecords call site (whole-src) matches the frozen, disposition-tagged allowlist', () => {
    assertAllowlistMatchesReality('patchRecords', PATCHRECORDS_ALLOWLIST)
  })

  test('every RecordService.patchRecord call site (whole-src) matches the frozen, disposition-tagged allowlist', () => {
    assertAllowlistMatchesReality('patchRecord', PATCHRECORD_ALLOWLIST)
  })

  test('smoke: the Yjs bridge write-input builder (index.ts) textually contains the GATED_BY_CALLER gate the allowlist above relies on', () => {
    const indexTs = read('index.ts')
    expect(indexTs).toContain('loadFieldPermissionScopeMap(')
    expect(indexTs).toContain('isFieldWriteForbidden(')
    expect(indexTs).toContain('FieldWritePermissionDeniedError')
    // Positioned within the Yjs write-input-builder region: after real-capability resolution, before the
    // callback's `return { sheetId, ... }` (the shape patchRecords ultimately receives as its input).
    expect(indexTs).toMatch(
      /resolveSheetCapabilitiesForUser\(pool\.query\.bind\(pool\), sheetId, actorId\)[\s\S]{0,1500}isFieldWriteForbidden\([\s\S]{0,900}return \{\s*\n\s*sheetId,/,
    )
  })

  test('smoke: the single-record PATCH handler (univer-meta.ts) gates BEFORE calling recordService.patchRecord', () => {
    const univerMeta = read('routes/univer-meta.ts')
    expect(univerMeta).toMatch(
      /isFieldWriteForbidden\(patchContext\.fieldPermissions\[fid\]\)[\s\S]{0,600}sendForbidden\(res, `Field\(s\) not writable[\s\S]{0,3000}recordService\.patchRecord\(\{/,
    )
  })
})
