/**
 * W1-3 GW7 — durable structural guard: every write path that reaches the record-write surface is
 * enumerated against a FROZEN, disposition-tagged allowlist ("has a layer-3 per-subject
 * field_permissions gate" / "GATED_BY_CALLER" / "EXEMPT with a one-line reason" /
 * "UNGATED_CHARACTERIZED"). A NEW (or removed) call site anywhere in the backend `src` tree changes
 * that file's call-site COUNT and trips this test RED — forcing a contributor to add the gate (or
 * classify an explicit exemption) instead of silently landing a new side door, the way the Yjs bridge
 * and the single-record PATCH route once did (design-lock
 * docs/development/multitable-per-subject-field-write-gate-w13-designlock-20260705.md §1).
 * Same discipline as `multitable-stored-data-taint-chokepoint.guard.test.ts`.
 *
 * THE ENUMERATION IS A FULL SET, NOT A SAMPLE (2026-09-11). Until this revision the file enumerated
 * only the two `pat…`-prefixed members (`patchRecords` / `patchRecord`) — a hand-picked SAMPLE of the
 * write surface. Three more value-bearing ports existed and were invisible to it:
 *   - `RecordService.createRecord` — a create carries field VALUES, so a column the actor may not
 *     write is reachable at create time.
 *   - `RecordService.restoreRecord` — re-materializes a trashed row's values.
 *   - the plugin lane's real entry points in `index.ts`, which call `multitable/records.ts`'s OWN
 *     `patchRecord`/`createRecord` through the IMPORT ALIASES `patchMultitableRecord` /
 *     `createMultitableRecord`. A `.patchRecord(`-shaped scan can never see those: there is no dot and
 *     the name differs.
 * So the port list itself is now DERIVED from the source of the three write surfaces
 * (`RecordWriteService`, `RecordService`, `multitable/records.ts`) and cross-checked against a frozen
 * classification: a new/renamed/removed member on ANY of those surfaces trips RED, and a port that is
 * classified as a field-value write but carries no allowlist trips RED. Deleting a port from the
 * enumeration can no longer pass silently — which is what "全集断言" means here.
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
 *   - `multitable/plugin-scope.ts`'s `records.patchRecord` / `records.createRecord` wrappers textually
 *     match the method scan but call COMPLETELY DIFFERENT functions (the regular plugin records API and
 *     the transaction-scoped records API, not `RecordService`'s) — actor-less plugin-SDK write paths
 *     with no per-subject identity to gate against. Classified EXEMPT, not GATED.
 * This refines (does not contradict) the design-lock: the bridge and the single-record PATCH route remain
 * the only two paths that were actually ungated ON THE PATCH FAMILY; the true existing-gated count is
 * higher than "six".
 *
 * WHAT `UNGATED_CHARACTERIZED` MEANS. It is NOT an endorsement. It records a write path that reaches
 * field values with NO layer-3 per-subject gate, pinned deliberately so that adding OR removing a gate
 * there becomes a RED test instead of a silent change. The plugin-lane entries are the subject of the
 * real-DB golden
 *   packages/core-backend/tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts
 *   → describe '备料 列权限墙不在插件写路径上 — 特征化 golden(网格红 / 插件绿)'
 * which proves the same column is 403 through the grid and writable through the production plugin SDK.
 * The create-path entries are a SECOND, separate leg (create-time layer-3 is absent; only the
 * copy-record site filters its payload) — reported to the owner, NOT fixed in this wave.
 *
 * If this test fails: you added, removed, or moved a call site on one of the enumerated write ports, or
 * you changed the member list of one of the three write surfaces. Add a layer-3 per-subject
 * `field_permissions` gate before the new call site (reusing `isFieldWriteForbidden` from
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

/** A line whose only-preceding-content (after trim) is `//` or `*` is a comment mention (JSDoc /
 *  line-comment), matching the taint-chokepoint guard's comment-skip. */
function isCommentMention(src: string, idx: number): boolean {
  const lineStart = src.lastIndexOf('\n', idx) + 1
  const linePrefix = src.slice(lineStart, idx).trimStart()
  return linePrefix.startsWith('//') || linePrefix.startsWith('*')
}

/**
 * Count every non-definition, non-comment CALL site of one port in one file.
 *
 * `method` mode counts `.name(`. A method DEFINITION (`async patchRecords(input: RecordPatchInput) {`)
 * has no leading dot and is never matched. `.patchRecord(` can never match as a substring inside
 * `.patchRecords(` — the character immediately after `patchRecord` there is `s`, not `(` — so the two
 * counts never double-count each other.
 *
 * `function` mode counts a BARE identifier call `name(` whose preceding character is not an identifier
 * char and not a dot, which is how the plugin lane actually calls `multitable/records.ts` (imported
 * under an alias: `patchRecord as patchMultitableRecord`). The alias line in the `import { … }` block
 * is never matched because no `(` follows the name there.
 */
function countCallSites(src: string, scan: { mode: 'method' | 'function'; needle: string }): number {
  if (scan.mode === 'method') {
    const needle = `.${scan.needle}(`
    let count = 0
    let from = 0
    for (;;) {
      const idx = src.indexOf(needle, from)
      if (idx === -1) break
      from = idx + needle.length
      if (isCommentMention(src, idx)) continue
      count += 1
    }
    return count
  }
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${scan.needle}\\(`, 'g')
  let count = 0
  for (;;) {
    const m = re.exec(src)
    if (m === null) break
    const idx = m.index + m[1].length
    if (isCommentMention(src, idx)) continue
    count += 1
  }
  return count
}

function countCallSitesByFile(scan: { mode: 'method' | 'function'; needle: string }): Map<string, number> {
  const byFile = new Map<string, number>()
  for (const file of RUNTIME_FILES) {
    const n = countCallSites(read(file), scan)
    if (n > 0) byFile.set(file, n)
  }
  return byFile
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE WRITE SURFACES — the three modules whose members can put a field VALUE into `meta_records.data`.
// The member list of each is DISCOVERED from source below; the classification beside it is frozen.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const SURFACES = {
  RecordWriteService: 'multitable/record-write-service.ts',
  RecordService: 'multitable/record-service.ts',
  'records.ts': 'multitable/records.ts',
} as const
type SurfaceName = keyof typeof SURFACES

/** Public members declared on a class body that runs to end-of-file (both record services do — verified:
 *  `export class RecordService {` at record-service.ts and `export class RecordWriteService {` at
 *  record-write-service.ts are each the LAST top-level declaration in their file). `constructor` is not
 *  a member of the write surface. */
function discoverClassMembers(file: string, className: string): string[] {
  const src = read(file)
  const at = src.indexOf(`export class ${className} {`)
  expect(at, `write-surface discovery: 'export class ${className} {' not found in ${file}`).toBeGreaterThan(-1)
  const body = src.slice(at)
  const out = new Set<string>()
  for (const line of body.split('\n')) {
    const m = /^ {2}(?:public |private |protected )?(?:async )?([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line)
    if (!m) continue
    if (m[1] === 'constructor') continue
    out.add(m[1])
  }
  return [...out].sort()
}

/** Exported functions of `multitable/records.ts` — the plugin lane's module surface. */
function discoverExportedFunctions(file: string): string[] {
  const src = read(file)
  const out = new Set<string>()
  const re = /^export (?:async )?function ([A-Za-z_][A-Za-z0-9_]*)\(/gm
  for (;;) {
    const m = re.exec(src)
    if (m === null) break
    out.add(m[1])
  }
  return [...out].sort()
}

function discoverSurfaceMembers(surface: SurfaceName): string[] {
  return surface === 'records.ts'
    ? discoverExportedFunctions(SURFACES[surface])
    : discoverClassMembers(SURFACES[surface], surface)
}

/**
 * FROZEN classification of every discovered member. `FIELD_VALUE_WRITE` members MUST each carry a
 * call-site allowlist below (asserted); everything else carries a one-line reason why no per-field gate
 * question arises there.
 */
const MEMBER_CLASSIFICATION: Record<SurfaceName, Record<string, 'FIELD_VALUE_WRITE' | string>> = {
  RecordWriteService: {
    patchRecords: 'FIELD_VALUE_WRITE',
    validateChanges: 'read-only pre-flight validation; writes nothing',
    setPostCommitHooks: 'boot-time wiring; takes no record and no field value',
    setYjsInvalidator: 'boot-time wiring; back-compat shim over setPostCommitHooks',
  },
  RecordService: {
    patchRecord: 'FIELD_VALUE_WRITE',
    createRecord: 'FIELD_VALUE_WRITE',
    restoreRecord: 'FIELD_VALUE_WRITE',
    deleteRecord: 'row-level delete; carries no field value, so there is nothing PER-FIELD to gate (row/ownership gates live in the service: canDeleteRecord + ensureRecordWriteAllowed)',
    listDeletedRecords: 'read path (recycle bin listing)',
    setPostCommitHooks: 'boot-time wiring; takes no record and no field value',
    setFormulaRecalcHook: 'boot-time wiring; takes no record and no field value',
    setYjsInvalidator: 'boot-time wiring; back-compat shim over setPostCommitHooks',
  },
  'records.ts': {
    patchRecord: 'FIELD_VALUE_WRITE',
    createRecord: 'FIELD_VALUE_WRITE',
    deleteRecord: 'row-level delete on the plugin lane; carries no field value (the lock guard runs with actor=null)',
    getRecord: 'read path',
    listRecords: 'read path',
    queryRecords: 'read path',
    queryRecordsWithCursor: 'read path',
  },
}

type Disposition = 'GATED' | 'GATED_BY_CALLER' | 'EXEMPT' | 'UNGATED_CHARACTERIZED'
type SiteEntry = { disposition: Disposition; reason: string }
type PortId = `${SurfaceName}.${string}`
type Port = {
  surface: SurfaceName
  member: string
  /** How this port is actually CALLED in `src` — a method call, or a bare (aliased) function call. */
  scan: { mode: 'method' | 'function'; needle: string }
  sites: Record<string, SiteEntry[]>
}

const WRITE_PORTS: Record<PortId, Port> = {
  'RecordWriteService.patchRecords': {
    surface: 'RecordWriteService',
    member: 'patchRecords',
    scan: { mode: 'method', needle: 'patchRecords' },
    sites: {
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
    },
  },

  'RecordService.patchRecord': {
    surface: 'RecordService',
    member: 'patchRecord',
    scan: { mode: 'method', needle: 'patchRecord' },
    sites: {
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
            'per-subject identity for field_permissions to gate against on this path. The write it delegates ' +
            'to is enumerated as its own port below (records.ts.patchRecord).',
        },
        {
          disposition: 'EXEMPT',
          reason:
            'P4 transaction-scoped records wrapper: delegates to the host-owned unit-of-work patchRecord, ' +
            'NOT RecordService.patchRecord. It remains actor-less and is additionally constrained to the ' +
            'four sheets declared by the stock-preparation persist operation.',
        },
      ],
    },
  },

  'RecordService.createRecord': {
    surface: 'RecordService',
    member: 'createRecord',
    scan: { mode: 'method', needle: 'createRecord' },
    sites: {
      'routes/univer-meta.ts': [
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'POST /records — the create write gate is LAYER-2 ONLY (RecordService.createRecord checks ' +
            'isFieldAlwaysReadOnly + capabilities, never a per-subject field_permissions row), and the route ' +
            'passes the caller-supplied `data` through unfiltered. A column that is read_only for THIS actor ' +
            "is therefore writable AT CREATE TIME. The route's own comment says so in one line (#2106 F4: " +
            '"the create write gate is layer-2 only"). SECOND LEG — reported to the owner, not fixed here.',
        },
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'POST /sheets/:sheetId/import-xlsx — same layer-2-only create gate; the imported rows are built ' +
            'from the XLSX column mapping with no per-subject field_permissions filter. SECOND LEG.',
        },
        {
          disposition: 'GATED_BY_CALLER',
          reason:
            'copy-record — the ONLY create site that filters: copyData is built field-by-field from ' +
            'deriveFieldPermissions(..., { allowCreateOnly: true, fieldScopeMap }) with the per-subject scope ' +
            'map loaded by loadFieldPermissionScopeMap, skipping any field whose perm is !visible || readOnly. ' +
            'This is the proof that the create-time layer-3 question was known and answered at exactly one ' +
            'of the three create sites.',
        },
      ],
      'multitable/plugin-scope.ts': [
        {
          disposition: 'EXEMPT',
          reason:
            "Regular records wrapper: delegates to multitable/records.ts's OWN createRecord, NOT " +
            'RecordService.createRecord — actor-less plugin-SDK path, no per-subject identity to gate ' +
            'against. Enumerated as its own port below (records.ts.createRecord).',
        },
        {
          disposition: 'EXEMPT',
          reason:
            'P4 transaction-scoped records wrapper: delegates to the host-owned unit-of-work createRecord, ' +
            'NOT RecordService.createRecord; actor-less and constrained to the declared sheet set.',
        },
      ],
    },
  },

  'RecordService.restoreRecord': {
    surface: 'RecordService',
    member: 'restoreRecord',
    scan: { mode: 'method', needle: 'restoreRecord' },
    sites: {
      'routes/univer-meta.ts': [
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'POST /records/:recordId/restore-deleted — re-materializes the TRASHED row (its own snapshot; ' +
            'the caller authors no field value). Guarded at ROW level only: canDeleteRecord + ' +
            'ensureRecordWriteAllowed + the conditional-rule trash check. No per-field gate, so a restore ' +
            'can resurrect a value in a column the actor may not write. Narrow, and no caller-controlled ' +
            'payload — characterized here, not fixed in this wave.',
        },
      ],
    },
  },

  // ── THE PLUGIN LANE — invisible to any `.patchRecord(`-shaped scan (aliased bare-function calls) ──
  'records.ts.patchRecord': {
    surface: 'records.ts',
    member: 'patchRecord',
    scan: { mode: 'function', needle: 'patchMultitableRecord' },
    sites: {
      'index.ts': [
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'createCoreAPI().multitable.records.patchRecord — THE plugin-SDK write entry point. Wraps ' +
            'poolManager.get().transaction(...) around records.ts patchRecord and passes {sheetId, recordId, ' +
            'changes}. No actor is threaded through this boundary at all, so no field_permissions row is ever ' +
            'consulted: the column-level wall is NOT on this path. Characterized (NOT endorsed) by the ' +
            'real-DB golden in stock-preparation-fieldperm-write-gate-realdb.test.ts — see the file header.',
        },
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'the stock-preparation persist unit-of-work records API (P4) — same records.ts patchRecord inside ' +
            'the host-owned transaction, additionally constrained to the declared sheet set. Still actor-less, ' +
            'still no per-subject field_permissions read.',
        },
      ],
    },
  },

  'records.ts.createRecord': {
    surface: 'records.ts',
    member: 'createRecord',
    scan: { mode: 'function', needle: 'createMultitableRecord' },
    sites: {
      'index.ts': [
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'createCoreAPI().multitable.records.createRecord — plugin-SDK create entry point; actor-less, no ' +
            'per-subject field_permissions read, same lane as the patch entry above.',
        },
        {
          disposition: 'UNGATED_CHARACTERIZED',
          reason:
            'the stock-preparation persist unit-of-work records API (P4) createRecord — same function inside ' +
            'the host-owned transaction, constrained to the declared sheet set.',
        },
      ],
    },
  },
}

/** Assert one port's per-file entry count exactly matches the real call-site count, with a clear
 *  message on any drift (new file, removed file, or a count mismatch within a known file). */
function assertAllowlistMatchesReality(portId: PortId): void {
  const port = WRITE_PORTS[portId]
  const actualByFile = countCallSitesByFile(port.scan)
  const expectedFiles = Object.keys(port.sites)
  const actualFiles = [...actualByFile.keys()]

  const newFiles = actualFiles.filter((f) => !expectedFiles.includes(f))
  expect(
    newFiles,
    `GW7 GUARD: ${portId} is now called from ${newFiles.length} file(s) NOT in the allowlist: ` +
      `${newFiles.join(', ')}. A NEW write path must apply the layer-3 per-subject field_permissions gate ` +
      '(or be classified EXEMPT with a one-line reason) and be added to the allowlist in this test file.',
  ).toEqual([])

  const goneFiles = expectedFiles.filter((f) => !actualFiles.includes(f))
  expect(
    goneFiles,
    `GW7 GUARD: the ${portId} allowlist references file(s) with NO call site anymore: ` +
      `${goneFiles.join(', ')}. Remove the stale entry from the allowlist in this test file.`,
  ).toEqual([])

  for (const file of expectedFiles) {
    const expectedCount = port.sites[file].length
    const actualCount = actualByFile.get(file) ?? 0
    expect(
      actualCount,
      `GW7 GUARD: ${file} has ${actualCount} ${portId} call site(s), but the allowlist documents ` +
        `${expectedCount}. A call site was added, removed, or moved — reclassify it and update the ` +
        'allowlist in this test file (each entry documents ONE call site\'s disposition + reason).',
    ).toBe(expectedCount)
  }
}

describe('W1-3 GW7 — durable structural guard: every record write port is enumerated, and every call site gated or exempt', () => {
  // ── THE FULL-SET LAYER: the PORT LIST itself is derived, not hand-picked ────────────────────────
  test.each(Object.keys(SURFACES) as SurfaceName[])(
    'the %s write surface has exactly the members this file classifies (a new/renamed member trips red)',
    (surface) => {
      const discovered = discoverSurfaceMembers(surface)
      const classified = Object.keys(MEMBER_CLASSIFICATION[surface]).sort()
      expect(
        discovered,
        `GW7 FULL-SET: ${SURFACES[surface]} declares members this file does not classify (or the file ` +
          'classifies members that no longer exist). Classify each new member as FIELD_VALUE_WRITE (and give ' +
          'it a call-site allowlist) or give it a one-line reason why no per-field gate question arises.',
      ).toEqual(classified)
    },
  )

  test('every member classified FIELD_VALUE_WRITE has a call-site allowlist, and every allowlist names such a member', () => {
    const shouldBeEnumerated: PortId[] = []
    for (const surface of Object.keys(SURFACES) as SurfaceName[]) {
      for (const [member, classification] of Object.entries(MEMBER_CLASSIFICATION[surface])) {
        if (classification === 'FIELD_VALUE_WRITE') shouldBeEnumerated.push(`${surface}.${member}`)
      }
    }
    expect(
      Object.keys(WRITE_PORTS).sort(),
      'GW7 FULL-SET: the enumerated write ports must be EXACTLY the members classified FIELD_VALUE_WRITE. ' +
        'A port dropped from WRITE_PORTS (or added without a classification) is precisely the "sample, not a ' +
        'full set" failure this layer exists to catch.',
    ).toEqual(shouldBeEnumerated.sort())

    // …and each port must actually describe ITS OWN member, so a copy-paste cannot make two ports scan
    // the same thing.
    for (const [portId, port] of Object.entries(WRITE_PORTS)) {
      expect(`${port.surface}.${port.member}`, `GW7 FULL-SET: port id ${portId} disagrees with its surface/member`).toBe(portId)
    }
  })

  test('no enumerated port is a dead scan — every port has at least one real call site in src', () => {
    for (const [portId, port] of Object.entries(WRITE_PORTS)) {
      const total = [...countCallSitesByFile(port.scan).values()].reduce((a, b) => a + b, 0)
      expect(
        total,
        `GW7 GUARD: ${portId} scans for ${port.scan.mode === 'method' ? '.' : ''}${port.scan.needle}( and found ` +
          'NOTHING in src. Either the port was renamed (fix the scan) or the write path is gone (drop the port).',
      ).toBeGreaterThan(0)
    }
  })

  // ── THE PER-SITE LAYER: every call site of every port is classified ─────────────────────────────
  test.each(Object.keys(WRITE_PORTS) as PortId[])(
    'every %s call site (whole-src) matches the frozen, disposition-tagged allowlist',
    (portId) => {
      assertAllowlistMatchesReality(portId)
    },
  )

  // ── THE SMOKE LAYER: the dispositions that point AWAY from the call site must still hold ────────
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

  test('smoke: the copy-record create site (univer-meta.ts) really filters its payload by the per-subject scope map', () => {
    const univerMeta = read('routes/univer-meta.ts')
    expect(univerMeta).toMatch(
      /copyFieldScopeMap = await loadFieldPermissionScopeMap\([\s\S]{0,800}allowCreateOnly: true[\s\S]{0,900}recordService\.createRecord\(\{/,
    )
  })

  /**
   * THE CHARACTERIZATION SMOKE — the counterpart of the real-DB golden, runnable with no database.
   *
   * It pins the NEGATIVE fact the UNGATED_CHARACTERIZED plugin-lane entries assert: the whole plugin
   * write chain (`plugin-scope.ts` → `records.ts`, plus the P4 unit of work) mentions nothing from the
   * per-subject field-permission vocabulary at all, and the plugin-SDK wiring window in `index.ts`
   * between the SDK method head and the `records.ts` call contains no gate either.
   *
   * THIS GREEN IS NOT AN ENDORSEMENT. If it goes RED, somebody put a column-level gate on the plugin
   * write path: that is a behaviour change for 备料's write chain — go update the real-DB golden's
   * plugin leg (stock-preparation-fieldperm-write-gate-realdb.test.ts) and §10 of
   * docs/development/takeover-beiliao-20260821/stock-preparation-overall-plan-20260902.md in the same PR.
   */
  test('characterization: the plugin write chain carries NO per-subject field_permissions vocabulary (the column wall is NOT here)', () => {
    const GATE_VOCABULARY = [
      'field_permissions',
      'fieldPermissions',
      'isFieldWriteForbidden',
      'loadFieldPermissionScopeMap',
      'deriveFieldPermissions',
    ]
    for (const file of ['multitable/records.ts', 'multitable/plugin-scope.ts', 'multitable/stock-preparation-persist-unit-of-work.ts']) {
      const src = read(file)
      for (const token of GATE_VOCABULARY) {
        expect(
          src.includes(token),
          `${file} now mentions '${token}'. If a per-subject column gate was added to the plugin write ` +
            'path, this characterization (and the real-DB golden it pairs with) must be rewritten — see this test\'s doc comment.',
        ).toBe(false)
      }
    }

    // The wiring window in index.ts: from the plugin-SDK patchRecord method head to the records.ts call.
    const indexTs = read('index.ts')
    const head = indexTs.indexOf('patchRecord: async ({ sheetId, recordId, changes, expectedVersion }) => {')
    expect(head, 'index.ts no longer wires the plugin-SDK patchRecord in the shape this characterization reads').toBeGreaterThan(-1)
    const call = indexTs.indexOf('return patchMultitableRecord({', head)
    expect(call, 'index.ts plugin-SDK patchRecord no longer reaches records.ts patchRecord').toBeGreaterThan(head)
    const window = indexTs.slice(head, call)
    for (const token of GATE_VOCABULARY) {
      expect(
        window.includes(token),
        `the plugin-SDK patchRecord wiring window in index.ts now mentions '${token}' — a gate appeared on ` +
          'the plugin lane; update the real-DB golden and the design doc, then rewrite this characterization.',
      ).toBe(false)
    }
    // …and the window really is the wiring (not an empty slice that would make the loop vacuous).
    expect(window).toContain('poolManager.get().transaction(')
  })
})
