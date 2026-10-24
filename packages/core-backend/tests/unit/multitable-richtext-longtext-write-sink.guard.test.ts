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
import ts from 'typescript'

import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
  parseEcoCollaborationSource,
} from '../../src/multitable/plm-collaboration-snapshot-wire'
import { RECORDS_WRITE_RE } from '../utils/fence-holder-census'

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
 *   DELEGATED  — does not call the sanitizer directly; routes user-content scalars through a named
 *                helper file that IS a CHOKEPOINT (asserted: writer refs helper symbol + helper refs sanitizer).
 *   SAFE       — writes only non-user-content columns; a rich-`longText` value can never appear.
 */
const ALLOWLIST: Record<
  string,
  { disposition: 'CHOKEPOINT' | 'DELEGATED' | 'SAFE'; reason: string; through?: string; throughSymbol?: string }
> = {
  'multitable/exact-anchor-recovery-execute.ts': {
    disposition: 'DELEGATED',
    through: 'multitable/exact-anchor-restore-validate.ts',
    throughSymbol: 'assertExactRestorableScalarValue',
    reason:
      'L8 exact-anchor apply delegates changed restorable scalars through assertExactRestorableScalarValue ' +
      '(exact-anchor-restore-validate.ts), which directly references validateLongTextValue for rich longText; ' +
      'fail-closed value-invalid — no redundant production sanitizer call in execute just to satisfy a scanner',
  },
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
  'multitable/plm-record-ingress-service.ts': {
    disposition: 'SAFE',
    reason: 'Fixed binding maps four validated text cells only to existing string fields locked FOR SHARE; the database source-field guard forbids retyping. Local rich-text cells are not patched.',
  },
  'multitable/plm-bom-review-service.ts': {
    disposition: 'SAFE',
    reason: 'Owner-authorized snapshot sync writes only SOURCE_FIELDS created as string; the database field guard forbids retyping/deleting them. Local rich-text fields are never in the patch.',
  },
  'multitable/plm-collaboration-snapshot-service.ts': {
    disposition: 'SAFE',
    reason: 'Strict eleven string/null ECO cells map only to readOnly string source fields. Immutable 11+3 binding maps and DB field guards reject retype/readonly drift; source-sync guards prohibit locals/extras. Same-query canonical fence, current authority/record lock, nonnull mint, canonical history and seal precede commit. Local review_note longText stays on canonical CRUD.',
  },
  'multitable/auto-number-service.ts': {
    disposition: 'SAFE',
    reason: 'writes ONLY auto-number columns (numeric sequence values) — never a user-supplied longText carrier',
  },
  'multitable/approval-record-projection-service.ts': {
    disposition: 'SAFE',
    reason: 'T3-6 read-model projection writes ONLY the fixed system columns (requestNo/templateId/name/status/outcome/requesterId/approverId/timestamps/currentNodeKey) derived from approval_instances+approval_records — never form_snapshot or a user-supplied rich-longText carrier',
  },
  'multitable/derived-write-fence.ts': {
    disposition: 'SAFE',
    reason:
      'the SHARED flag-gated fence+UPDATE seam for derived-value materializations (formula engine + the univer-meta relation-agg resolvers route through it since the #4438 post-merge follow-up) — writes ONLY computed formula/relation-agg result keys, derived server-side, never raw user HTML',
  },
  'multitable/automation-service.ts': {
    disposition: 'SAFE',
    reason: 'W7-1 approval-result backwrite writes ONLY system outcome values (status enum / approver id / ISO timestamp) — never user-supplied longText',
  },
  'multitable/field-retype-convert-execute.ts': {
    disposition: 'SAFE',
    reason:
      'Field retype convert / whole-column undo (ADR multitable-field-retype-first-batch-adr-20260926 §3). It writes ONE column, and only between `string` and `select` / `multiSelect`: the pair is re-checked under the field row lock (a `longText` source or target, rich or not, is refused 422 pair_not_in_first_batch), and the undo restores the source type recorded on the job row, which is that same `string`. No request-supplied value is written — the convert moves the text ALREADY stored in the cell into its option shape, the undo writes back the pre-image of that same cell — so no rich-longText carrier can arrive through this file.',
  },
  'services/elearning-stats-multitable-projection.ts': {
    disposition: 'SAFE',
    reason:
      'writes only the fixed aggregate projection columns (department identity/date/counts/rates/credits/timestamps); suppressed groups contain no metric values and no rich-longText field exists in the system-owned schema',
  },
  'multitable/side-door-delete-trash.ts': {
    disposition: 'SAFE',
    reason:
      'D-2 side-door delete recoverability. Writes NO meta_records row at all — it is caught by `writesRecordData` only because its sole INSERT targets meta_records_TRASH, whose name shares the `meta_records` prefix the regex matches. The `data` it copies is the deleted row\'s own snapshot, read verbatim out of meta_records microseconds earlier inside the same txn, so it is content that ALREADY passed the ingress chokepoint on its original write — this module adds no new user-content ingress and cannot introduce an unvalidated rich-longText value (identical in kind to the trash INSERT record-service.ts has always done on the UI delete path).',
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

// The ECO SAFE verdict is conditional on these fixed-source boundaries, not on its filename.
const ECO_SERVICE = readFileSync(join(SRC, 'multitable/plm-collaboration-snapshot-service.ts'), 'utf8').replace(/\r\n/g, '\n')
const ECO_DB = readFileSync(join(SRC, 'db/migrations/zzzz20261024010000_create_plm_collaboration_snapshots.ts'), 'utf8').replace(/\r\n/g, '\n')
const ECO_BOUNDARIES = [
  ['source-only projection', 'service', 'for (const key of ECO_COLLABORATION_ECO_FIELDS) data[fields[key]] = snapshot.eco[key]\n  return data'],
  ['string source descriptors', 'service', "type: 'string' as const,\n        order,\n        property: { readOnly: true, plmCollaborationSnapshot: { source: true, key } }"],
  ['writer flag', 'service', "if (!isWriterFenceEnabled()) fail(503, 'ECO_RUNTIME_UNAVAILABLE')"],
  ['provision canonical fence', 'service', 'await fenceWriterEntry(query, sheetId)\n    const sheet = await createSheet({ query, sheetId,'],
  ['append canonical fence', 'service', 'await fenceWriterEntry(query, binding.sheet_id)\n    await this.authorizeSheet(query, actor, binding, true)\n    const stored = await this.readStoredRow(query, binding.id, preview.row_key)'],
  ['refresh canonical fence', 'service', 'await fenceWriterEntry(query, binding.sheet_id)\n    await this.authorizeSheet(query, actor, binding, true)\n    const source = await this.admit(query, actor, binding.data_source_id, mode)'],
  ['nonnull operation', 'service', "const ledger = await mintOperation(query, binding.sheet_id)\n    if (ledger.operationId === null) fail(503, 'ECO_RUNTIME_UNAVAILABLE')"],
  ['successful seal', 'service', "if (!(await sealOperation(query, ledger))) fail(503, 'ECO_RUNTIME_UNAVAILABLE')"],
  ['canonical revision history', 'service', 'await recordRecordRevision(query, {\n      sheetId,\n      recordId,\n      version,\n      action,\n      source: \'system_sync\''],
  ['history keeps minted ledger', 'service', 'changedFieldIds,\n      patch,\n      snapshot,\n      ledger,\n    })'],
  ['commit before success', 'service', 'return await this.deps.pool.transaction(async ({ query }) => fn(query))'],
  ['exact source keys', 'db', "source_fields - ARRAY[${SOURCE_KEY_SQL}] = '{}'::jsonb\n          AND source_fields ?& ARRAY[${SOURCE_KEY_SQL}]"],
  ['exact local keys', 'db', "local_fields - ARRAY[${LOCAL_KEY_SQL}] = '{}'::jsonb\n          AND local_fields ?& ARRAY[${LOCAL_KEY_SQL}]"],
  ['immutable binding maps', 'db', "mutable text[] := ARRAY['version', 'status', 'updated_at', 'last_failure_code', 'last_failure_at'];"],
  ['binding immutability enforced', 'db', 'IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable)'],
  ['mapped field lock', 'db', "SELECT id, sheet_id, type, property INTO field FROM ${s}.meta_fields WHERE id = pair.value FOR UPDATE;"],
  ['mapped source type and readonly', 'db', "IF field.type IS DISTINCT FROM 'string'\n         OR field.property -> 'readOnly' IS DISTINCT FROM 'true'::jsonb"],
  ['field type cannot drift', 'db', 'NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR NEW.type IS DISTINCT FROM OLD.type'],
  ['source readonly cannot drift', 'db', "NEW.type IS DISTINCT FROM 'string'\n       OR NEW.property -> 'readOnly' IS DISTINCT FROM 'true'::jsonb"],
  ['source sync forbids extras', 'db', "(entry.value -> 'data') - physical_ids <> '{}'::jsonb\n       OR NOT ((entry.value -> 'data') ?& physical_ids)"],
  ['receipt row and postimage identity', 'db', "OR new_source IS DISTINCT FROM (accepted.patch -> 'data')\n       OR (accepted.patch -> 'row_key') IS DISTINCT FROM mapped_key"],
  ['source sync forbids local insert', 'db', 'OR EXISTS (SELECT 1 FROM jsonb_each(NEW.data) cell WHERE cell.key = ANY(local_ids))'],
  ['source sync forbids local update', 'db', 'IF new_local IS DISTINCT FROM old_local\n         OR NEW.modified_by IS DISTINCT FROM accepted.actor_id'],
] as const

// Enumerate literal writes across the WHOLE already-SAFE service, not just references to `cells`.
// This finite source contract deliberately requires review of any new SQL or builder write port.
function ecoRecordWriteSites(service: string): string[][] {
  const source = ts.createSourceFile('eco-service.ts', service, ts.ScriptTarget.Latest, true)
  const writes: string[][] = []
  const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && (RECORDS_WRITE_RE.test(node.text)
      || /\bMERGE\s+INTO\s+(?:"?public"?\.)?"?meta_records"?(?![\w])/i.test(node.text))) {
      let owner: ts.Node | undefined = node.parent
      while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      const call = node.parent
      writes.push([
        owner && (ts.isMethodDeclaration(owner) || ts.isFunctionDeclaration(owner))
          ? owner.name?.getText(source) ?? '<outside method>' : '<outside method>',
        ts.isCallExpression(call) ? call.expression.getText(source) : '<indirect SQL>',
        normalized(node.text),
        ts.isCallExpression(call) && call.arguments[0] === node ? normalized(call.arguments[1]?.getText(source) ?? '') : '',
      ])
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['insertInto', 'updateTable', 'mergeInto', 'deleteFrom'].includes(node.expression.name.text)) {
      const table = node.arguments[0]
      if (table && ts.isStringLiteralLike(table) && /^(?:"?public"?\.)?"?meta_records"?$/i.test(table.text)) {
        writes.push(['<builder>', node.expression.name.text, table.text, ''])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return writes
}

const ECO_RECORD_WRITE_SITES = [
  ['writeGuardedRow', 'query',
    'INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by, locked_at) VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, NULL, NULL)',
    '[recordId, binding.sheet_id, JSON.stringify(cells), actor]'],
  ['writeGuardedRow', 'query',
    'UPDATE meta_records SET data = data || $1::jsonb, version = version + 1, modified_by=$2, updated_at=now() WHERE id=$3 AND sheet_id=$4 AND version=$5 RETURNING version, data',
    '[JSON.stringify(cells), actor, recordId, binding.sheet_id, current.version]'],
]

function ecoBoundaryFailures(service: string, db: string): string[] {
  const failures = ECO_BOUNDARIES.filter(([_name, file, anchor]) => !(file === 'service' ? service : db).includes(anchor))
    .map(([name]) => String(name))
  const sourceCells = service.slice(service.indexOf('function sourceCells('), service.indexOf('\nfunction previewFrom('))
  if (sourceCells.trim() !== [
    'function sourceCells(snapshot: EcoCollaborationSource, fields: Record<string, string>): Record<string, string | null> {',
    '  const data: Record<string, string | null> = {}',
    '  for (const key of ECO_COLLABORATION_ECO_FIELDS) data[fields[key]] = snapshot.eco[key]',
    '  return data',
    '}',
  ].join('\n')) failures.push('source-only projection')
  if (JSON.stringify(ecoRecordWriteSites(service)) !== JSON.stringify(ECO_RECORD_WRITE_SITES)) failures.push('exact source write sites')
  return [...new Set(failures)]
}

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

  test('ECO ingress: SAFE requires the exact eleven string/null keys and three canonical local field types', () => {
    expect(ECO_COLLABORATION_ECO_FIELDS).toEqual([
      'id', 'name', 'eco_type', 'product_id', 'source_version_id', 'target_version_id',
      'stage_id', 'state', 'kanban_state', 'priority', 'updated_at',
    ])
    expect(ECO_COLLABORATION_LOCAL_FIELDS).toEqual([
      { key: 'collaboration_owner', type: 'person' },
      { key: 'followup_due_at', type: 'dateTime' },
      { key: 'review_note', type: 'longText' },
    ])
    const anchor = { tenantId: 'tenant', orgId: 'org', itemId: 'item', ecoId: 'eco', currentVersionId: null }
    const dto = {
      projection_contract: 'eco_collaboration_source.v1', feature_key: 'collaboration_source_read', entitled: true,
      source: { tenant_id: 'tenant', org_id: 'org', item_id: 'item', current_version_id: null },
      snapshot_at: '2026-10-24T01:02:03.000000Z',
      eco: {
        id: 'eco', name: '<b>plain source text</b>', eco_type: 'design', product_id: 'item',
        source_version_id: null, target_version_id: null, stage_id: null, state: null,
        kanban_state: null, priority: null, updated_at: null,
      },
    }
    const parsed = parseEcoCollaborationSource(dto, anchor)
    expect(Object.keys(parsed.eco)).toEqual([...ECO_COLLABORATION_ECO_FIELDS])
    expect(Object.values(parsed.eco).every((value) => value === null || typeof value === 'string')).toBe(true)
    for (const eco of [
      { ...dto.eco, review_note: 'local must use canonical CRUD' },
      { ...dto.eco, unexpected: 'extra' },
      { ...dto.eco, name: { rich: true, html: '<img onerror=alert(1)>' } },
      { ...dto.eco, name: ['text'] },
    ]) expect(() => parseEcoCollaborationSource({ ...dto, eco }, anchor)).toThrow('ECO_SOURCE_REJECTED')
  })

  test('ECO ingress: fixed-source exemption keeps source-only payload, immutable schema and transaction guards', () => {
    expect(ecoBoundaryFailures(ECO_SERVICE, ECO_DB)).toEqual([])
    const writer = ECO_SERVICE.slice(ECO_SERVICE.indexOf('  private async writeGuardedRow('), ECO_SERVICE.indexOf('  private async history('))
    expect(writer.split('\n').filter((line) => /\bcells\b/.test(line)).map((line) => line.trim())).toEqual([
      'const cells = sourceCells(snapshot, binding.source_fields)',
      'data: cells,',
      '[recordId, binding.sheet_id, JSON.stringify(cells), actor],',
      "await this.history(query, actor, binding.sheet_id, recordId, 1, 'create', Object.values(binding.source_fields), cells, cells, ledger)",
      'const changed = Object.values(binding.source_fields).filter((id) => JSON.stringify(current.data[id] ?? null) !== JSON.stringify(cells[id] ?? null))',
      '[JSON.stringify(cells), actor, recordId, binding.sheet_id, current.version],',
      'const postimage = { ...current.data, ...cells }',
      "await this.history(query, actor, binding.sheet_id, recordId, Number(updated.rows[0].version), 'update', changed, cells, postimage, ledger)",
    ])
    const ordered = [
      'this.requireWriterFence()', 'const cells = sourceCells(snapshot, binding.source_fields)',
      'await mintOperation(query, binding.sheet_id)', 'if (ledger.operationId === null)',
      'INSERT INTO meta_plm_collaboration_syncs', 'INSERT INTO meta_records',
      'await this.history(query,', 'await sealOperation(query, ledger)',
    ].map((token) => writer.indexOf(token))
    expect(ordered.every((offset) => offset >= 0)).toBe(true)
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
    for (const [method, next] of [['provision', 'appendEcoSnapshot'], ['appendEcoSnapshot', 'publishRow'], ['loadRefresh', 'sourceFieldBlocked']]) {
      const body = ECO_SERVICE.slice(ECO_SERVICE.indexOf(`  private async ${method}(`), ECO_SERVICE.indexOf(`  private async ${next}(`))
      const fence = body.indexOf('await fenceWriterEntry(query,')
      const use = body.indexOf(method === 'loadRefresh' ? 'await this.fieldAndLock(query,' : 'await this.publishRow(query,')
      expect(fence, method).toBeGreaterThanOrEqual(0)
      expect(use, method).toBeGreaterThan(fence)
    }
    expect(ECO_SERVICE).toContain('await recordRecordRevision(query, {')
    expect(ECO_SERVICE).toContain('SET data = data || $1::jsonb')
    expect(ECO_SERVICE).toContain('const postimage = { ...current.data, ...cells }')
  })

  test.each(ECO_BOUNDARIES)('ECO ingress mutation: removing %s invalidates SAFE', (name, file, anchor) => {
    const service = file === 'service' ? ECO_SERVICE.replace(anchor, '') : ECO_SERVICE
    const db = file === 'db' ? ECO_DB.replace(anchor, '') : ECO_DB
    expect(ecoBoundaryFailures(service, db)).toContain(name)
  })

  test('ECO ingress mutation: adding a local cell to the source projection invalidates SAFE', () => {
    const anchor = '  for (const key of ECO_COLLABORATION_ECO_FIELDS) data[fields[key]] = snapshot.eco[key]'
    const service = ECO_SERVICE.replace(anchor, `${anchor}\n  data[fields.review_note] = 'local write'`)
    expect(ecoBoundaryFailures(service, ECO_DB)).toContain('source-only projection')
  })

  test.each(['inside', 'outside'])('ECO additive writer: alternate payload %s writeGuardedRow invalidates SAFE', (location) => {
    const statement = "    await query('UPDATE meta_records SET data = $1::jsonb WHERE id = $2', [payload, recordId])"
    const anchor = location === 'inside'
      ? "    await query(`SELECT set_config('metasheet.plm_collaboration_sync', '', true)`, [])"
      : '  private async history('
    const replacement = location === 'inside'
      ? `${anchor}\n${statement}`
      : `  private async alternateWriter(query: EcoQuery, payload: unknown, recordId: string) {\n${statement}\n  }\n\n${anchor}`
    expect(ECO_SERVICE).toContain(anchor)
    const service = ECO_SERVICE.replace(anchor, replacement)
    expect(writesRecordData(service)).toBe(true)
    expect(ecoBoundaryFailures(service, ECO_DB)).toContain('exact source write sites')
  })

  test.each([
    '[recordId, binding.sheet_id, JSON.stringify(cells), actor]',
    '[JSON.stringify(cells), actor, recordId, binding.sheet_id, current.version]',
  ])('ECO additive writer: changing a reviewed source payload in %s invalidates SAFE', (parameters) => {
    expect(ECO_SERVICE).toContain(parameters)
    const service = ECO_SERVICE.replace(parameters, parameters.replace('JSON.stringify(cells)', 'JSON.stringify(payload)'))
    expect(ecoBoundaryFailures(service, ECO_DB)).toContain('exact source write sites')
  })

  test.each(['insertInto', 'updateTable', 'mergeInto'])('ECO additive writer: a new literal %s builder port invalidates SAFE', (method) => {
    const anchor = '  private async history('
    const service = ECO_SERVICE.replace(anchor,
      `  private async alternateBuilder(db: DB, payload: unknown) {\n    return db.${method}('meta_records').values(payload)\n  }\n\n${anchor}`)
    expect(ecoBoundaryFailures(service, ECO_DB)).toContain('exact source write sites')
  })

  test('ECO additive writer: SQL mentioned only in a comment creates no write site', () => {
    const service = `${ECO_SERVICE}\n// await query('UPDATE meta_records SET data = $1::jsonb', [payload])\n`
    expect(ecoRecordWriteSites(service)).toEqual(ECO_RECORD_WRITE_SITES)
    expect(ecoBoundaryFailures(service, ECO_DB)).toEqual([])
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

  test('every DELEGATED writer routes through a named helper that itself references the sanitizer', () => {
    const failures: string[] = []
    for (const rel of writerFiles) {
      const entry = ALLOWLIST[rel]
      if (entry?.disposition !== 'DELEGATED') continue
      const through = entry.through
      const symbol = entry.throughSymbol
      if (!through || !symbol) {
        failures.push(`${rel}: DELEGATED entry missing through/throughSymbol`)
        continue
      }
      const writerSrc = readFileSync(join(SRC, rel), 'utf8')
      if (!new RegExp(`\\b${symbol}\\b`).test(writerSrc)) {
        failures.push(`${rel}: does not reference delegated symbol ${symbol}`)
      }
      const helperPath = join(SRC, through)
      let helperSrc: string
      try {
        helperSrc = readFileSync(helperPath, 'utf8')
      } catch {
        failures.push(`${rel}: delegated helper ${through} is missing`)
        continue
      }
      if (!new RegExp(`\\b${symbol}\\b`).test(helperSrc)) {
        failures.push(`${through}: does not define/export ${symbol}`)
      }
      if (!SANITIZER_REF.test(helperSrc)) {
        failures.push(
          `${through}: delegated helper does NOT reference validateLongTextValue/sanitizeRichLongText`,
        )
      }
    }
    expect(
      failures,
      `DELEGATED write-sink guard failures:\n` + failures.map((f) => `  - ${f}`).join('\n'),
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
