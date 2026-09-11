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
 * WHERE THIS RUNS (disputed in review, so it is pinned as an assertion, not prose — see the `wiring:`
 * test at the bottom of this file). This guard is executed by `pnpm --filter @metasheet/core-backend
 * test` — the "Run core-backend tests" step of `.github/workflows/plugin-tests.yml`'s `test` job, which
 * carries no `paths:` filter on `pull_request` and therefore runs on every PR. That script is a bare
 * `vitest`, `vitest.config.ts` declares no `include:` key, and this file is not in its `exclude:` list,
 * so the default include collects it. It is NOT named file-by-file in any workflow, and it does not need
 * to be: "named in a workflow" and "executed by CI" are different questions, and only the second one
 * decides whether a guard gates anything.
 *
 * SCOPE OF THE "FULL SET" CLAIM — read this before quoting the green (2026-09-11, corrected the same
 * day). This lock is a full set WITHIN ITS OWN SCOPE, and the scope is: the three MODULES that expose a
 * record-write API — `RecordWriteService`, `RecordService`, `multitable/records.ts`. Within them it is
 * exhaustive: EVERY member is discovered from the TypeScript AST of the surface (so property-assigned
 * functions, `static` members, accessors, computed names and value re-exports are all seen — the earlier
 * line-regex discovery saw only method syntax and a mutation probe landed a new write member on a fully
 * green run), and EVERY call site of every value-bearing member is scanned across the whole `src` tree.
 * The remaining, stated limit of the member scan is that it is SYNTACTIC: a member attached at runtime
 * (`Object.assign(this, …)`, a mixin) is not a declaration and no source enumeration can see it.
 * It does NOT claim those three modules are the only code that
 * can put a field VALUE into `meta_records.data`: raw-SQL writers live outside them
 * (`multitable/automation-executor.ts`, `multitable/derived-write-fence.ts`,
 * `multitable/exact-anchor-recovery-execute.ts`, the approval / e-learning projections, …). Those are
 * OUT OF SCOPE for the layer-3 question asked here; they are instead pinned by the chokepoint test at
 * the bottom of this file, which freezes the FILE SET allowed to run raw `INSERT/UPDATE meta_records`
 * — within `packages/core-backend/src` minus `db/migrations` (both exclusions are named in that test's
 * doc comment, with the two migrations that do write the table listed by filename), and matching every
 * Postgres spelling of the table name rather than one literal — so that a brand-new write spine in that
 * tree cannot appear unnoticed. Anyone who needs "every write to
 * meta_records.data is gated" must treat those files as an open, separate case — they are named to the
 * owner in the PR body, not silently covered here.
 *
 * Until this revision the file enumerated only the two `pat…`-prefixed members (`patchRecords` /
 * `patchRecord`) — a hand-picked SAMPLE of the write surface. Three more value-bearing ports existed
 * and were invisible to it:
 *   - `RecordService.createRecord` — a create carries field VALUES, so a column the actor may not
 *     write is reachable at create time.
 *   - `RecordService.restoreRecord` — re-materializes a trashed row's values.
 *   - `multitable/records.ts`'s OWN `patchRecord`/`createRecord`, which callers reach as BARE function
 *     calls under whatever local name their own `import` clause chose: `patchRecord as
 *     patchMultitableRecord` in `index.ts`, plain `patchRecord` in
 *     `attendance/attendance-multitable-cleaning-authority.ts`. A `.patchRecord(`-shaped scan can never
 *     see those (there is no dot) — and pinning ONE alias literal (`patchMultitableRecord`) misses every
 *     other importer, which is exactly how the attendance call site stayed invisible to the FIRST cut of
 *     this lock. The scan is therefore IMPORT-BINDING-RESOLVED: per file we parse the
 *     import clause, RESOLVE its module specifier against the importing file's own directory (so a
 *     sibling inside `multitable/` spelling it `'./records'` is seen too — matching the literal
 *     `multitable/records` misses exactly that case, verified with a mutation probe), take the LOCAL
 *     name bound to the exported member (aliased or not), and count bare calls of THAT name. Namespace
 *     imports, re-exports and `require()` of that module are separately forbidden, since any of them
 *     would reopen an alias lane no scan can resolve.
 * So the port list itself is now DERIVED from the source of the three write surfaces
 * (`RecordWriteService`, `RecordService`, `multitable/records.ts`) and cross-checked against a frozen
 * classification: a new/renamed/removed member on ANY of those surfaces trips RED, and a port that is
 * classified as a field-value write but carries no allowlist trips RED. Deleting a port from the
 * enumeration can no longer pass silently — which is what "全集断言" means here, with the module scope
 * above as its explicit boundary.
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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import ts from 'typescript'
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
 * A raw `INSERT INTO` / `UPDATE` naming the `meta_records` TABLE, in any spelling Postgres accepts for
 * it: optional (optionally quoted) schema qualifier, optional `ONLY`, optional double quotes, any
 * whitespace or newline between the keywords, any case. Used by the scope-boundary chokepoint at the
 * bottom of this file — see that test's doc comment for why the normalisation exists and for the
 * over-approximation it accepts on purpose. `meta_records_trash` must never match.
 */
const RAW_META_RECORDS_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE)\s+(?:ONLY\s+)?(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s*\.\s*)?"?meta_records"?(?![A-Za-z0-9_$])/gi

/**
 * How a port is reached from a caller.
 *  - `method`   — `.name(`.
 *  - `importBinding` — a BARE call of whatever LOCAL name the calling file bound the exported member
 *    to in its `import { … } from '…/multitable/records'` clause. NEVER a hard-coded alias literal:
 *    that was the hole (see file header) that hid `attendance-multitable-cleaning-authority.ts`.
 */
type Scan =
  | { mode: 'method'; needle: string }
  /** `needle` is the name EXPORTED by the module, not any caller's local name. `module` is the target
   *  path RELATIVE TO `src/`, without extension. */
  | { mode: 'importBinding'; module: string; needle: string }

/** The plugin-lane module, as a path relative to `src/`. */
const RECORDS_MODULE = 'multitable/records'

/**
 * Resolve a relative module specifier as written INSIDE `fromFile` (itself relative to `src/`) to a
 * `src/`-relative module path. `routes/univer-meta.ts` + `'../multitable/records'` → `multitable/records`;
 * `multitable/sheet-liveness.ts` + `'./records'` → `multitable/records`. Resolving (rather than
 * pattern-matching the literal) is what makes a SIBLING importer inside `multitable/` visible — a
 * `/multitable\/records$/`-shaped regex silently misses `'./records'`.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const slash = fromFile.lastIndexOf('/')
  const parts = slash === -1 ? [] : fromFile.slice(0, slash).split('/')
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/').replace(/\.(ts|js)$/, '')
}

/** Count BARE identifier calls `name(` whose preceding char is neither an identifier char nor a dot.
 *  A function DEFINITION line (`export async function patchRecord(`) IS bare — but no file both defines
 *  and imports the same member, and the scan only runs on files that import it. The name inside an
 *  `import { … }` clause is never matched because no `(` follows it there. */
function countBareCalls(src: string, name: string): number {
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\(`, 'g')
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

/**
 * The LOCAL names one file binds to one exported member of a module — `patchRecord` binds to
 * `patchRecord`, `patchRecord as patchMultitableRecord` binds to `patchMultitableRecord`. Returns an
 * empty array when the file does not import that member at all.
 */
function resolveImportBindings(file: string, src: string, module: string, exported: string): string[] {
  const out = new Set<string>()
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (;;) {
    const m = re.exec(src)
    if (m === null) break
    if (isCommentMention(src, m.index)) continue
    if (resolveSpecifier(file, m[2]) !== module) continue
    for (const raw of m[1].split(',')) {
      const spec = raw.trim()
      if (spec === '') continue
      const parsed = /^(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(spec)
      if (parsed === null || parsed[1] !== exported) continue
      out.add(parsed[2] ?? parsed[1])
    }
  }
  return [...out]
}

/**
 * Count every non-definition, non-comment CALL site of one port in one file.
 *
 * `method` mode counts `.name(`. A method DEFINITION (`async patchRecords(input: RecordPatchInput) {`)
 * has no leading dot and is never matched. `.patchRecord(` can never match as a substring inside
 * `.patchRecords(` — the character immediately after `patchRecord` there is `s`, not `(` — so the two
 * counts never double-count each other.
 */
function countCallSites(file: string, src: string, scan: Scan): number {
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
  let count = 0
  for (const local of resolveImportBindings(file, src, scan.module, scan.needle)) {
    count += countBareCalls(src, local)
  }
  return count
}

function countCallSitesByFile(scan: Scan): Map<string, number> {
  const byFile = new Map<string, number>()
  for (const file of RUNTIME_FILES) {
    const n = countCallSites(file, read(file), scan)
    if (n > 0) byFile.set(file, n)
  }
  return byFile
}

/** Files that IMPORT one exported member of `multitable/records.ts` — call or no call. An importer that
 *  binds the member but calls it in a shape the counter misses would otherwise be invisible. */
function importerFiles(exported: string): string[] {
  return RUNTIME_FILES.filter((file) => resolveImportBindings(file, read(file), RECORDS_MODULE, exported).length > 0)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE WRITE SURFACES IN SCOPE OF THIS LOCK — the three modules that expose a record-write API.
// NOT "the only modules that can put a field VALUE into `meta_records.data`": raw-SQL writers exist
// outside them and are pinned separately by RAW_META_RECORDS_SQL_WRITERS at the bottom of this file.
// The member list of each surface is DISCOVERED from source below; the classification beside it is
// frozen.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const SURFACES = {
  RecordWriteService: 'multitable/record-write-service.ts',
  RecordService: 'multitable/record-service.ts',
  'records.ts': 'multitable/records.ts',
} as const
type SurfaceName = keyof typeof SURFACES

function parseTs(file: string): ts.SourceFile {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

/**
 * EVERY member a class declares — enumerated from the TypeScript AST, NOT from a line regex.
 *
 * WHY THE AST (2026-09-11 adversarial review, r2 tests-ci ②). The previous implementation matched
 * `/^ {2}(?:public |private |protected )?(?:async )?(name)\(/` — i.e. ONLY method syntax, with a
 * hand-listed modifier set. Three real member shapes were invisible to it, and a mutation probe proved
 * each one lands GREEN on a file whose header claims a full set:
 *   - a property-assigned function: `  patchRecordUnchecked = async (input) => { … }`
 *   - a `static` member (`static` was not in the modifier list at all)
 *   - `get`/`set` accessors
 * Any of those is a perfectly good new write port. The AST sees every `ClassElement` regardless of
 * syntax, so "the member list is DISCOVERED from source" is now true of the shapes, not just of the one
 * shape the author happened to think of. Computed names (`[Symbol.x]() {}`) and static blocks are
 * surfaced under bracketed synthetic labels rather than dropped, so they cannot hide inside the green
 * either — they simply fail the frozen classification until someone writes a line about them.
 *
 * `constructor` is not a member of the write surface (its parameter properties are constructor
 * arguments, not callable ports). The class must still be EXPORTED — a surface that stops being
 * exported stops being a surface, and that is a change worth a red.
 */
function discoverClassMembers(file: string, className: string): string[] {
  const sourceFile = parseTs(file)
  const found: string[] = []
  let seenExported = false
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.name.text === className) {
      seenExported = seenExported || isExported(node)
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) || ts.isSemicolonClassElement(member)) continue
        if (ts.isClassStaticBlockDeclaration(member)) {
          found.push('[static-block]')
          continue
        }
        const name = member.name
        if (name === undefined) {
          found.push(`[unnamed:${ts.SyntaxKind[member.kind]}]`)
          continue
        }
        if (
          ts.isIdentifier(name) ||
          ts.isPrivateIdentifier(name) ||
          ts.isStringLiteral(name) ||
          ts.isNumericLiteral(name)
        ) {
          found.push(name.text)
          continue
        }
        found.push(`[computed:${name.getText(sourceFile)}]`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  expect(
    seenExported,
    `write-surface discovery: 'export class ${className}' not found in ${file} (renamed, moved, or no ` +
      'longer exported — this lock cannot enumerate a surface it cannot find).',
  ).toBe(true)
  return [...new Set(found)].sort()
}

/**
 * EVERY VALUE another module can import from `multitable/records.ts` — the plugin lane's module
 * surface, enumerated from the AST for the same reason as the class members above.
 *
 * The previous implementation matched `/^export (?:async )?function name\(/m`, so an exported
 * `const patchRecordUnchecked = async (…) => {}` — an importable, callable write port — was invisible,
 * and so was every value RE-EXPORT (`export { x } from './y'`), which importers reach through this
 * module exactly as if it were declared here. Type-only exports (`export type`, `isTypeOnly`
 * specifiers) are not part of the value surface and are excluded; a bare `export * from` or an
 * `export default` is surfaced under a bracketed label so it cannot silently widen the surface.
 */
function discoverModuleValueExports(file: string): string[] {
  const sourceFile = parseTs(file)
  const found: string[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name !== undefined) {
      found.push(statement.name.text)
    } else if (ts.isClassDeclaration(statement) && isExported(statement) && statement.name !== undefined) {
      found.push(statement.name.text)
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) found.push(declaration.name.text)
        else found.push(`[destructured-export:${declaration.name.getText(sourceFile)}]`)
      }
    } else if (ts.isExportAssignment(statement)) {
      found.push('[export-default]')
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (statement.exportClause === undefined) {
        found.push(`[export-star:${statement.moduleSpecifier?.getText(sourceFile) ?? '?'}]`)
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) found.push(element.name.text)
        }
      } else {
        found.push(`[namespace-export:${statement.exportClause.name.text}]`)
      }
    }
  }
  return [...new Set(found)].sort()
}

function discoverSurfaceMembers(surface: SurfaceName): string[] {
  return surface === 'records.ts'
    ? discoverModuleValueExports(SURFACES[surface])
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
    // Only visible since the AST rewrite of discoverClassMembers (it is a PropertyDeclaration, not a
    // method — the old line regex could not see it, which is the hole r2 tests-ci ② named).
    formulaRecalcHook: 'private state slot holding the injected recalc hook; not a callable port of the surface (its only setter, setFormulaRecalcHook, is classified below)',
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
    // ── VALUE RE-EXPORTS ─────────────────────────────────────────────────────────────────────────
    // Only visible since discoverModuleValueExports moved to the AST. They are declared in another
    // module but are importable FROM records.ts, so they are part of this module's value surface and
    // must each carry a reason — otherwise `export { somethingThatWrites } from './x'` would be a
    // silent new plugin-lane port.
    buildRecordsCacheKey: 're-export from ./query-service; builds a read-cache key string, writes nothing',
    decodeRecordCursor: 're-export from ./query-service; read-path cursor codec',
    encodeRecordCursor: 're-export from ./query-service; read-path cursor codec',
    MultitableRecordDeleteCapExceededError: 're-export from ./record-errors; an Error class, carries no field value',
    MultitableRecordNotFoundError: 're-export from ./record-errors; an Error class, carries no field value',
    MultitableRecordValidationError: 're-export from ./record-errors; an Error class, carries no field value',
    MultitableRecordVersionConflictError: 're-export from ./record-errors; an Error class, carries no field value',
    MultitableSideDoorDeleteNonTransactionalError: 're-export from ./side-door-delete-trash; an Error class, carries no field value',
  },
}

type Disposition = 'GATED' | 'GATED_BY_CALLER' | 'EXEMPT' | 'UNGATED_CHARACTERIZED'
type SiteEntry = { disposition: Disposition; reason: string }
type PortId = `${SurfaceName}.${string}`
type Port = {
  surface: SurfaceName
  member: string
  /** How this port is actually CALLED in `src` — a method call, or a bare call of the local name each
   *  importer bound the exported member to. */
  scan: Scan
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

  // ── THE BARE-CALL LANE — invisible to any `.patchRecord(`-shaped scan, and invisible to a scan that
  //    pins ONE alias literal. Resolved per file from the caller's own import clause. ───────────────
  'records.ts.patchRecord': {
    surface: 'records.ts',
    member: 'patchRecord',
    scan: { mode: 'importBinding', module: RECORDS_MODULE, needle: 'patchRecord' },
    sites: {
      'attendance/attendance-multitable-cleaning-authority.ts': [
        {
          disposition: 'GATED_BY_CALLER',
          reason:
            'cleanupAttendanceCleaningProposal — imports records.ts patchRecord under its PLAIN name (no ' +
            'alias), which is why the first cut of this lock could not see it. It is NOT a second ungated ' +
            'leg: the per-subject field gate runs in the lock chain it must pass through first — ' +
            'cleanupAttendanceCleaningProposal → lockAttendanceCleaningSource → ' +
            'lockAttendanceCleaningProjectionAccess, whose tail does loadFieldPermissionScopeMap + ' +
            'deriveFieldPermissions and throws (unavailable()) if isFieldWriteForbidden holds for EITHER of ' +
            'the exact two field ids (cleaning_requested / cleaning_reason) this call site then writes. ' +
            'Enforced, not asserted in prose: see the attendance smoke test below.',
        },
      ],
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
    scan: { mode: 'importBinding', module: RECORDS_MODULE, needle: 'createRecord' },
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
        `GW7 GUARD: ${portId} scans for ${port.scan.mode === 'method' ? '.' : 'import-bound '}${port.scan.needle}( and found ` +
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

  // ── THE IMPORTER LAYER: for the bare-call lane, binding the member is already enough to be on the
  //    hook. This catches an importer whose call shape the counter misses (destructured into a local,
  //    passed as a callback, re-bound, …) — it would otherwise be a silent, invisible write path. ──
  test.each(
    (Object.keys(WRITE_PORTS) as PortId[]).filter((id) => WRITE_PORTS[id].scan.mode === 'importBinding'),
  )('every file that IMPORTS %s from multitable/records.ts is in its allowlist (binding it is enough)', (portId) => {
    const port = WRITE_PORTS[portId]
    const scan = port.scan
    if (scan.mode !== 'importBinding') throw new Error('unreachable')
    expect(
      importerFiles(scan.needle).sort(),
      `GW7 IMPORTER LAYER: the set of src files importing '${scan.needle}' from multitable/records.ts no ` +
        `longer equals the ${portId} allowlist. A file that imports this write function is a write path ` +
        'even if the call-site counter cannot see its call shape — classify it (gate / GATED_BY_CALLER / ' +
        'EXEMPT / UNGATED_CHARACTERIZED) and add it to the allowlist.',
    ).toEqual(Object.keys(port.sites).sort())
  })

  test('no namespace import, re-export, or require() of multitable/records.ts exists (each would reopen an alias lane no scan can resolve)', () => {
    // Each pattern captures the module SPECIFIER; it is then RESOLVED against the importing file, so a
    // sibling inside multitable/ spelling it `'./records'` is caught too.
    const shapes = [
      ['namespace import', /import\s+\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*\s+from\s*['"]([^'"]+)['"]/g],
      ['re-export', /export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g],
      ['require()', /require\(\s*['"]([^'"]+)['"]\s*\)/g],
    ] as const
    for (const file of RUNTIME_FILES) {
      const src = read(file)
      for (const [label, pattern] of shapes) {
        const re = new RegExp(pattern.source, 'g')
        for (;;) {
          const m = re.exec(src)
          if (m === null) break
          expect(
            resolveSpecifier(file, m[1]),
            `GW7 IMPORTER LAYER: ${file} reaches multitable/records.ts through a ${label}. The import-binding ` +
              'scan above resolves named imports only; a namespace/re-export/require lane would hide write ' +
              'call sites from it. Convert it to a named import, or teach this guard to resolve the new shape.',
          ).not.toBe(RECORDS_MODULE)
        }
      }
    }
  })

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

  test('smoke: the attendance cleanup site reaches records.ts patchRecord ONLY through the lock chain that runs the per-field gate', () => {
    const file = 'attendance/attendance-multitable-cleaning-authority.ts'
    const src = read(file)
    /** Slice one exported function's body: from its head to the next top-level `export`. */
    const sliceExported = (name: string): string => {
      const head = src.indexOf(`export async function ${name}(`)
      expect(head, `${file} no longer exports '${name}' in the shape this smoke reads`).toBeGreaterThan(-1)
      const next = src.indexOf('\nexport ', head + 1)
      return src.slice(head, next === -1 ? undefined : next)
    }

    // 1. The writer reaches patchRecord only AFTER awaiting the lock chain.
    const cleanup = sliceExported('cleanupAttendanceCleaningProposal')
    const lockAt = cleanup.indexOf('await lockAttendanceCleaningSource(')
    const writeAt = cleanup.indexOf('await patchRecord({')
    expect(lockAt, 'cleanupAttendanceCleaningProposal no longer awaits lockAttendanceCleaningSource').toBeGreaterThan(-1)
    expect(writeAt, 'cleanupAttendanceCleaningProposal no longer calls records.ts patchRecord').toBeGreaterThan(lockAt)

    // 2. …and that lock chain unconditionally passes through the access lock.
    expect(sliceExported('lockAttendanceCleaningSource')).toContain('await lockAttendanceCleaningProjectionAccess(query, input)')

    // 3. …whose tail is a real per-subject field gate on the SAME two field ids the write then sets.
    const access = sliceExported('lockAttendanceCleaningProjectionAccess')
    expect(access).toContain('loadFieldPermissionScopeMap(')
    expect(access).toContain('deriveFieldPermissions(')
    expect(
      access,
      'the attendance per-field gate (the reason this call site is GATED_BY_CALLER, not a second ungated ' +
        'leg) is gone or reshaped — reclassify the allowlist entry before touching this assertion.',
    ).toContain('if (Object.values(fieldIds).some(id => isFieldWriteForbidden(permissions[id]))) unavailable()')
    // The gated ids and the written ids are the same two.
    expect(access).toMatch(/fieldIds = \{\s*\n\s*requested:[\s\S]{0,400}reason:/)
    expect(cleanup).toContain('changes: { [locked.fieldIds.requested]: false, [locked.fieldIds.reason]: null },')
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

  /**
   * THE SCOPE-BOUNDARY CHOKEPOINT — what this lock does NOT cover, pinned so it cannot grow silently.
   *
   * The three write SURFACES above are not the only code that can put a value into `meta_records.data`:
   * several modules run raw `INSERT INTO meta_records` / `UPDATE meta_records … SET data = …` directly.
   * Those bypass the surfaces entirely, so the layer-3 per-site question above never reaches them. This
   * test does not pretend to classify their gates — it FREEZES THE FILE SET, so that a NEW module taking
   * up raw record SQL (a brand-new write spine) trips red and gets a decision instead of landing quietly.
   *
   * `meta_records_trash` is a different table (soft-delete archive) and is deliberately not matched.
   *
   * TABLE-REFERENCE NORMALISATION (2026-09-11, r2 tests-ci ③). The first cut matched the bare literal
   * `/(INSERT INTO|UPDATE)\s+meta_records/` with no `i` flag, so three spellings that Postgres accepts
   * for the SAME table walked straight past it — proven with mutation probes, each of which landed a new
   * raw write spine on a fully GREEN guard:
   *   `UPDATE public.meta_records …`  ·  `UPDATE ONLY meta_records …`  ·  `UPDATE Public."META_RECORDS" …`
   * The matcher below therefore tolerates an optional (optionally quoted) schema qualifier, an optional
   * `ONLY`, optional double quotes around the table, arbitrary whitespace/newlines between the keywords,
   * and is case-insensitive. It DELIBERATELY OVER-APPROXIMATES: in Postgres a quoted `"META_RECORDS"` is
   * a *different* relation from `meta_records`, and `otherschema.meta_records` is a different table — but
   * a guard whose job is "no new write spine appears unnoticed" should red on those and be argued down in
   * review, not miss them. `meta_records_trash` stays unmatched in every one of those spellings (the
   * `(?![A-Za-z0-9_$])` tail is applied after the optional closing quote).
   *
   * TWO DISCLOSED EXCLUSIONS — do not read this green as "nothing else in the repo writes meta_records":
   *   1. `src/db/migrations/**` is outside `RUNTIME_FILES` by construction (see `listRuntimeTsFiles`), and
   *      two migrations DO run raw `UPDATE meta_records`:
   *      `zzzz20260430163000_add_meta_record_modified_by.ts` and
   *      `zzzz20260516113000_repair_onprem_multitable_record_create.ts`. They are one-shot schema/data
   *      repairs on a different lifecycle (no actor, no request), not write spines, so freezing them here
   *      would be noise — but they are named rather than silently dropped.
   *   2. Only the `core-backend` `src` tree is walked. SQL issued from other packages or from plugin
   *      code is not seen by this chokepoint at all.
   */
  test('chokepoint: the set of files running raw INSERT/UPDATE on meta_records is frozen (a new write spine outside the three surfaces trips red)', () => {
    const RAW_META_RECORDS_SQL_WRITERS: Record<string, string> = {
      // ── IN SCOPE of this lock: these ARE the three write surfaces ────────────────────────────────
      'multitable/record-write-service.ts': 'IN SCOPE — the RecordWriteService surface itself (patchRecords).',
      'multitable/record-service.ts': 'IN SCOPE — the RecordService surface itself (patch/create/restore/delete).',
      'multitable/records.ts': 'IN SCOPE — the plugin-lane module surface itself.',
      // ── OUT OF SCOPE: raw-SQL writers the surface-level enumeration above can never see ──────────
      'routes/univer-meta.ts':
        'OUT OF SCOPE for the surface enumeration (route-level raw SQL: field-value cleanup on field delete, ' +
        'row lock/unlock, seed/import inserts). Its per-field-gated writes go through the surfaces and ARE ' +
        'enumerated above; these raw statements are a separate question.',
      'multitable/automation-executor.ts':
        'OUT OF SCOPE — automation action writes ("SET data = COALESCE(data, \'{}\'::jsonb) || $1::jsonb" plus ' +
        'row INSERTs) carry field VALUES and never consult field_permissions. Named to the owner as an open ' +
        'write spine; NOT covered by this lock.',
      'multitable/automation-service.ts':
        'OUT OF SCOPE — same shape as the executor (merge-patch of data) on the service side.',
      'multitable/derived-write-fence.ts':
        'OUT OF SCOPE — derived/formula write-back ("SET data = data || $1::jsonb"); system-authored values, no actor.',
      'multitable/exact-anchor-recovery-execute.ts':
        'OUT OF SCOPE — recovery replay writes a whole data document back under a version CAS.',
      'multitable/auto-number-service.ts':
        'OUT OF SCOPE — auto-number backfill (jsonb_set of one system-generated column).',
      'multitable/approval-record-projection-service.ts':
        'OUT OF SCOPE — approval projection INSERTs a system-authored row.',
      'services/elearning-stats-multitable-projection.ts':
        'OUT OF SCOPE — e-learning stats projection INSERTs a system-authored row.',
    }
    const raw = RAW_META_RECORDS_WRITE
    const actual: string[] = []
    for (const file of RUNTIME_FILES) {
      const src = read(file)
      raw.lastIndex = 0
      for (;;) {
        const m = raw.exec(src)
        if (m === null) break
        if (isCommentMention(src, m.index)) continue
        actual.push(file)
        break
      }
    }
    expect(
      actual.sort(),
      'GW7 SCOPE BOUNDARY: the set of files running raw INSERT/UPDATE on meta_records changed. A file that ' +
        'writes meta_records directly bypasses RecordWriteService / RecordService / records.ts, so NONE of the ' +
        'per-site layer-3 assertions above apply to it. Decide what gate it needs, then record it here with a ' +
        'one-line IN SCOPE / OUT OF SCOPE reason. (meta_records_trash is a different table and is not matched.)',
    ).toEqual(Object.keys(RAW_META_RECORDS_SQL_WRITERS).sort())
  })

  /**
   * The chokepoint above is only as strong as its table matcher, and the matcher is the thing that was
   * silently weak: three accepted spellings of the SAME table slipped past the original literal
   * (r2 tests-ci ③). Freezing the matcher's behaviour on a positive/negative table makes the evasion an
   * EXECUTABLE fact instead of a comment — if someone narrows the regex back, this reds immediately,
   * without needing a new raw write spine to exist first.
   */
  test('chokepoint matcher: every Postgres spelling of the meta_records table is matched, and meta_records_trash is not', () => {
    const hits = (sql: string): boolean => {
      RAW_META_RECORDS_WRITE.lastIndex = 0
      return RAW_META_RECORDS_WRITE.test(sql)
    }

    // MUST match — each of these is a real write to the real table, and each of the last four walked
    // past the pre-2026-09-11 literal matcher.
    for (const sql of [
      "UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2",
      "INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3)",
      "UPDATE public.meta_records SET data = $1 WHERE id = $2",
      "UPDATE ONLY meta_records SET data = $1",
      'UPDATE Public."META_RECORDS" SET data = $1',
      'insert\n  into "public"."meta_records" (id) values ($1)',
    ]) {
      expect(hits(sql), `chokepoint matcher no longer sees a raw meta_records write: ${sql}`).toBe(true)
    }

    // MUST NOT match — a different table (soft-delete archive), in the same spellings.
    for (const sql of [
      'UPDATE meta_records_trash SET restored_at = now()',
      'INSERT INTO meta_records_trash (id) VALUES ($1)',
      'UPDATE public."meta_records_trash" SET restored_at = now()',
      'update only meta_records_trash set restored_at = now()',
    ]) {
      expect(hits(sql), `chokepoint matcher now matches the TRASH table, which is a different table: ${sql}`).toBe(false)
    }
  })

  /**
   * WIRING — the "守卫没接线" check, applied to THIS FILE.
   *
   * A structural lock that no CI job collects is a paper guarantee, and this repo has landed exactly that
   * mistake before (see the `node --test scripts/ops/...` steps in plugin-tests.yml, each of which exists
   * because a suite landed dark). The r2 review disputed BOTH directions for this file, so the answer is
   * pinned here as an assertion rather than argued in a PR body:
   *
   *   this file IS collected — by `pnpm --filter @metasheet/core-backend test` (the "Run core-backend
   *   tests" step of plugin-tests.yml's `test` job, which has no `paths:` filter on `pull_request` and so
   *   runs for every PR). That script is a bare `vitest`; `vitest.config.ts` declares NO `include:` key,
   *   so the vitest default include collects `tests/unit/**.test.ts`, and this file is not in the ~400-line
   *   `exclude:` list. Being named file-by-file in a workflow is a DIFFERENT question from being executed;
   *   only the second one decides whether the guard gates anything.
   *
   * The real-DB golden this guard characterises is wired the OTHER way (excluded from the no-DB default
   * job so `describeIfDatabase` cannot skip-green it, and named whole-file into the real-DB step), so both
   * halves of the pair are asserted here.
   */
  test('wiring: this guard is collected by the core-backend suite CI runs on every PR, and the real-DB golden is wired to the real-DB step', () => {
    const repoRoot = join(__dirname, '../../../..')
    const selfRel = 'tests/unit/multitable-w13-write-path-layer3-gate.guard.test.ts'
    const goldenRel = 'tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts'
    expect(existsSync(join(repoRoot, 'packages/core-backend', selfRel))).toBe(true)
    expect(existsSync(join(repoRoot, 'packages/core-backend', goldenRel))).toBe(true)

    // 1. The package `test` script is a bare vitest run over the default config — no `--config`, no
    //    explicit path list that could leave this file out.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/core-backend/package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const testScript = pkg.scripts.test
    expect(testScript, 'core-backend `test` script is gone').toBeTruthy()
    expect(
      /^vitest(\s|$)/.test(testScript) && !testScript.includes('--config') && !/\btests\//.test(testScript),
      `core-backend "test" script is now ${JSON.stringify(testScript)} — it no longer collects the whole ` +
        'default suite, so this guard may have gone dark. Re-verify what runs it before touching this assertion.',
    ).toBe(true)

    // 2. The default config collects by vitest's default include (no `include:` key) and does not exclude
    //    this file.
    const vitestConfig = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    expect(
      /^\s*include\s*:/m.test(vitestConfig),
      'vitest.config.ts grew an `include:` key. The default include is what collects this guard — check it ' +
        'is still collected, then update this assertion.',
    ).toBe(false)
    expect(
      vitestConfig.includes(selfRel),
      'vitest.config.ts now names this guard file (almost certainly in `exclude:`) — that would make it dark ' +
        'in the no-DB job that is its only executor.',
    ).toBe(false)

    // 3. …and the step that invokes that script exists, unconditionally, in the PR gate.
    const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    expect(workflow).toContain('pnpm --filter @metasheet/core-backend test\n')

    // 4. The paired real-DB golden: excluded from the no-DB lane exactly once, named exactly once in the
    //    real-DB step that sets DATABASE_URL and METASHEET_REAL_DB_TEST_STEP.
    expect(vitestConfig.split(`'${goldenRel}'`).length - 1).toBe(1)
    const stepAt = workflow.indexOf('        id: multitable-real-db-integration')
    expect(stepAt, 'the multitable real-DB step is gone — the golden has no executor').toBeGreaterThanOrEqual(0)
    const stepEnd = workflow.indexOf('\n      - name:', stepAt)
    const step = workflow.slice(stepAt, stepEnd === -1 ? undefined : stepEnd)
    expect(step).toContain("METASHEET_REAL_DB_TEST_STEP: '1'")
    expect(step.split(goldenRel).length - 1).toBe(1)
  })
})
