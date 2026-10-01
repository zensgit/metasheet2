/**
 * Field retype slice 3a — STRUCTURAL guard for the §3.11 invariant (design lock
 * docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11 "结构守卫", rows 1–35 incl. 增补 A).
 *
 * THE INVARIANT. Every path that holds the canonical per-sheet fence and writes `meta_records.data` with a field
 * snapshot taken BEFORE the fence must call `assertFieldSchemaUnchangedAfterFence` (the derived-merge path:
 * `assertDerivedMergeTargetsStillDerived`) after the fence-acquisition branch and before its first `meta_records`
 * write / `FOR UPDATE` row lock, on the SAME query the fence was taken on. A field type conversion holds that
 * fence while it rewrites a column; a writer that only re-validated before the fence would land a value checked
 * against the old type.
 *
 * WHY STRUCTURAL. The behaviour suites pin the writers that exist today. They cannot see the next one. This
 * guard re-derives the complete holder set from the LOCK PRIMITIVE (tests/utils/fence-holder-census.ts: seeds →
 * first-order acquirers → entry/seam closure → holders; SQL functions and triggers included), then:
 *   A. every holder is classified in the ledger below — by name, with a verdict and a reason — and the ledger
 *      carries no stale entry (a count per key, so a second site under an existing key is also new);
 *   B. every 必接 (must-wire) holder calls its helper after the fence, with the fenced query, before the first
 *      write / row lock (seam call sites: inside the handler LITERAL — ADR "回调缝规则");
 *   C. every 非数据写入者 holder has no `meta_records.data` write statement after the fence in its own region
 *      (writes made by a callee are the ledger's stated reason, e.g. "covered by row 2");
 *   D. the probes (seed without a primitive), the SQL acquirers and trigger tables, and the ADR's named seams
 *      are pinned, so a change in how the fence is taken cannot silently shrink the census.
 * Falsifiability: the analyzer is run against SYNTHETIC sources at the end of this file — a new unclassified
 * holder, a wrapper one call away, an aliased import, a seam with a literal handler, a SQL function and its
 * trigger, a probe, and comments that must produce nothing. Without those pairs a scanner that silently matched
 * nothing would report a clean bill of health forever (#3365).
 *
 * Deliberate differences from the ADR's text census (`census-r5.sh`), recorded here so a reader can map rows:
 *  - the holder is the call site where the fence STOPS propagating (the transaction owner), so a function whose
 *    fence escapes to its caller's connection (it takes the fence on a query it was handed and writes no
 *    `meta_records` row itself) is an ENTRY and its callers are the holders. Consequences: row 13's non-scoped
 *    holder is the fence call inside `applyFencedDerivedDataMerge` (not its three callers); row 14's is the call
 *    inside `backfillAutoNumberField`; provisioning (row 26) surfaces at its callers (plugin host / template
 *    install); the w4c0 attendance transaction (row 32) is a seam and every caller is a holder.
 *  - an entry with NO caller in this tree (a host port a plugin calls, ADR rows 30 / 31) is a holder of its own.
 *  - fix round: entries are keyed by DECLARATION (file + qualified name), calls resolve through import bindings,
 *    re-exports and `this.` methods (C1-F1); a seam that fences on the caller's connection checks the caller's
 *    continuation too (C1-F2); writes made through callees, followed two levels, must be named in the ledger
 *    (`writesVia`, C1-F4).
 *  - slice 3b: the body of the entry / seam a holder calls is followed too (`entryWritesVia`, C2-F1) — a holder's
 *    region starts where the entry call ends, so a write the entry made through a callee was never looked at;
 *    and the conversion's own two transactions are 免检 on a reason the guard checks (guard E, `lockedFieldRead`).
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkHelperBeforeFirstWrite,
  checkLockedFieldReadBeforeFirstDataWrite,
  directRecordDataWritesAfterFence,
  loadCensusSources,
  runFenceHolderCensus,
  type Census,
  type CensusSource,
  type FenceHolder,
} from '../utils/fence-holder-census'

const SRC = join(__dirname, '..', '..', 'src')

const HELPER = 'assertFieldSchemaUnchangedAfterFence'
const DERIVED_HELPER = 'assertDerivedMergeTargetsStillDerived'

type Verdict = 'must-wire' | 'exempt' | 'non-data-writer'
type LedgerEntry = {
  key: string
  count: number
  /** ADR §3.11 row(s) this site belongs to ('new' = not in the ADR table; reason says why). */
  row: string
  verdict: Verdict
  helper?: typeof HELPER | typeof DERIVED_HELPER
  reason: string
  /** A non-data-writer whose region is not a transaction body (construction-time wiring) — reason required. */
  regionCheck?: false
  /**
   * C1-F4: the callees (qualified names) through which this site writes `meta_records.data`, as the census finds
   * them (precise resolution, two levels). Checked for EQUALITY on every exempt / non-data-writer entry, so a new
   * write reached through a helper function reds the guard until it is named here with a reason.
   */
  writesVia?: readonly string[]
  /**
   * Slice 3b: this 免检 verdict rests on "the field row is read under a row lock AFTER the fence, before the first
   * data write". Guard E checks exactly that on the holder's own statements, so the reason is not prose only.
   */
  lockedFieldRead?: true
  /**
   * C2-F1 (slice 3b): the callees through which the BODY of the entry / seam this site calls writes
   * `meta_records.data`, as the census finds them (`entry>callee`). Checked for EQUALITY on EVERY entry, whatever
   * its verdict — a 必接 site's helper sits in the handler, so a write the seam itself makes is outside its reach.
   */
  entryWritesVia?: readonly string[]
}

const MUST =(key: string, row: string, reason: string, helper: LedgerEntry['helper'] = HELPER, count = 1): LedgerEntry =>
  ({ key, count, row, verdict: 'must-wire', helper, reason })
const EXEMPT = (key: string, row: string, reason: string, count = 1): LedgerEntry =>
  ({ key, count, row, verdict: 'exempt', reason })
const NONWRITER = (key: string, row: string, reason: string, count = 1, regionCheck?: false): LedgerEntry =>
  ({ key, count, row, verdict: 'non-data-writer', reason, ...(regionCheck === false ? { regionCheck } : {}) })
const VIA = (entry: LedgerEntry, writesVia: readonly string[]): LedgerEntry => ({ ...entry, writesVia })
const LOCKED_READ = (entry: LedgerEntry): LedgerEntry => ({ ...entry, lockedFieldRead: true })
const ENTRY_VIA = (entry: LedgerEntry, entryWritesVia: readonly string[]): LedgerEntry => ({ ...entry, entryWritesVia })

const CONVERT_EXECUTE_KEY = 'multitable/field-retype-convert-execute.ts :: executeFieldRetypeConvert :: enterFence'
const CONVERT_UNDO_KEY = 'multitable/field-retype-convert-execute.ts :: undoFieldRetypeConvert :: enterFence'

const W4C0 = 'runAttendanceResultOperationTransactionV1'
const W4C0_REASON =
  'w4c0 attendance operation transaction (a seam). It takes the canonical fence only when handed attendanceCleaningSheetIds '
  + '(one caller: w4c3c execute); attendance/ has no meta_records data-write statement — its only data write is the '
  + 'cleaning-proposal replay through the plugin SDK patchRecord, covered by row 2.'

/**
 * THE LEDGER — every fence holder in packages/core-backend/src, by key `file :: scope :: callee`, with the number
 * of sites under that key. Verdicts follow ADR §3.11 (必接 / 免检 / 非数据写入者).
 */
const FENCE_HOLDER_LEDGER: readonly LedgerEntry[] = [
  // ── 必接 (rows 1–7, row 13 non-scoped) ─────────────────────────────────────────────────────────────
  MUST('multitable/record-write-service.ts :: RecordWriteService.patchRecords :: enterLinkWriterFencePlan', '1', '`fieldById` loaded + validated before the fence (bulk / AI / OAPI batch / record-version restore).'),
  MUST('multitable/record-write-service.ts :: RecordWriteService.patchRecords :: fenceWriterEntry', '1', 'same transaction, the non-link branch of the fence if/else.'),
  MUST('multitable/records.ts :: patchRecord :: enterLinkWriterFencePlan', '2', 'plugin SDK patch: fields may come from the request-scoped metadata cache (pre-fence).'),
  MUST('multitable/records.ts :: patchRecord :: fenceWriterEntry', '2', 'same transaction, non-link branch.'),
  MUST('multitable/records.ts :: createRecord :: enterLinkWriterFencePlan', '3', 'plugin SDK create: same cached-snapshot hazard as row 2.'),
  MUST('multitable/records.ts :: createRecord :: acquireAutoNumberSheetWriteLock', '3', 'same transaction, non-link branch.'),
  MUST('multitable/record-service.ts :: RecordService.patchRecord :: enterLinkWriterFencePlan', '4', 'REST + OAPI single-record PATCH: `fieldById` loaded through the pool before the transaction.'),
  MUST('multitable/record-service.ts :: RecordService.patchRecord :: fenceWriterEntry', '4', 'same transaction, non-link branch.'),
  MUST('routes/univer-meta.ts :: POST /views/:viewId/submit :: enterLinkWriterFencePlan', '5', 'form submit EDIT + CREATE (incl. public forms): `fieldById` loaded before the transaction.'),
  MUST('routes/univer-meta.ts :: POST /views/:viewId/submit :: acquireAutoNumberSheetWriteLock', '5', 'same transaction, non-link branch; one helper call covers both EDIT and CREATE.'),
  MUST('multitable/automation-executor.ts :: AutomationExecutor.executeUpdateRecord :: withTransaction', '6', 'automation update_record: no type validation; a flag-gated pre-fence snapshot is re-compared in the handler.'),
  MUST('multitable/automation-executor.ts :: AutomationExecutor.executeCreateRecord :: withTransaction', '6', 'automation create_record: as update_record.'),
  MUST('multitable/automation-service.ts :: AutomationService.applyResultWritebackPatch :: withTransaction', '7', 'approval resultWriteback: the type / option check (assertResultWritebackFields) runs before the fence.'),
  MUST('multitable/derived-write-fence.ts :: applyFencedDerivedDataMerge :: fenceWriterEntry', '13', 'non-scoped derived merge: `updates` computed outside the fence; derived-type re-check, refusal is a SheetWriterBlockedError subclass.', DERIVED_HELPER),

  // ── 免检 ────────────────────────────────────────────────────────────────────────────────────────────
  EXEMPT('multitable/record-service.ts :: RecordService.createRecord :: enterLinkWriterFencePlan', '8', 'fields are read inside the transaction after the fence (`SELECT id, name, type, property FROM meta_fields`), no cache.'),
  EXEMPT('multitable/record-service.ts :: RecordService.createRecord :: acquireCanonicalSheetFence', '8', 'as above, non-link branch.'),
  EXEMPT('multitable/automation-executor.ts :: AutomationExecutor.executeWriteApprovalFormValuesCreateAction :: withTransaction', '9', 'FWB create: resolveFwbRuntimeMappings reads id/type/property FOR SHARE after the fence and rejects a changed type or empty option intersection.'),
  EXEMPT('multitable/automation-executor.ts :: AutomationExecutor.executeWriteApprovalFormValuesUpdateAction :: withTransaction', '9', 'FWB update: as create.'),
  EXEMPT('multitable/automation-executor.ts :: AutomationExecutor.executeDeleteRecord :: withTransaction', '10', 'automation delete_record: DELETE, writes no value.'),
  EXEMPT('multitable/automation-executor.ts :: AutomationExecutor.executeLockRecord :: withTransaction', '10', 'automation lock / unlock: writes only the locked* columns.', 2),
  EXEMPT('multitable/record-service.ts :: RecordService.deleteRecord :: enterRecordLinkDeleteFencePlan', '11', 'REST delete: DELETE + trash row, no value written by field type.'),
  EXEMPT('multitable/record-service.ts :: RecordService.deleteRecord :: fenceWriterEntry', '11', 'as above, non-link branch.'),
  EXEMPT('multitable/record-service.ts :: RecordService.restoreRecord :: enterRecordLinkRestoreFencePlan', '11', 'restore re-INSERTs the trashed snapshot verbatim (no type-dependent value); conversion preview blocks trashed values, undo ②b blocks trashed post-state; same fence serialises it with convert / undo.'),
  EXEMPT('multitable/record-service.ts :: RecordService.restoreRecord :: fenceWriterEntry', '11', 'as above, non-link branch.'),
  EXEMPT('multitable/records.ts :: deleteRecord :: enterRecordLinkDeleteFencePlan', '12', 'plugin SDK delete: writes no data value.'),
  EXEMPT('multitable/records.ts :: deleteRecord :: fenceWriterEntry', '12', 'as above.'),
  EXEMPT('multitable/records.ts :: deleteRecordWithRecoverability :: enterRecordLinkDeleteFencePlan', '12', 'plugin SDK recoverable delete: writes no data value.'),
  EXEMPT('multitable/records.ts :: deleteRecordWithRecoverability :: fenceWriterEntry', '12', 'as above.'),
  EXEMPT('multitable/recovery-archive-derived-processor.ts :: runRecoveryArchiveDerivedTransaction :: withFencedDerivedTransaction', '13 (scoped)', 'scoped derived path: reads, computes and merges inside the same fenced transaction (the seam hands the fenced query to this literal handler).'),
  EXEMPT('multitable/auto-number-service.ts :: backfillAutoNumberField :: acquireCanonicalSheetFence', '14', 'writes only the autoNumber field it is creating / reconfiguring (ROW_NUMBER() integers); autoNumber is an excluded retype type; both callers read the field after their own fence.'),
  VIA(EXEMPT('routes/univer-meta.ts :: POST /sheets/:sheetId/config-restore-execute :: fenceWriterEntry', '15 / 16 / 27 / 28', 'four branches of one handler: lossy retype-revert cell rewrite (row 15, reads the field after the fence + preview baseline hash), un-create cascade (row 16, deletes a key), generic config revert (row 27, no data write), field undelete (row 28, the field provably does not exist under the fence); convert / undo revisions are refused 422 before these branches.', 4), ['applyLossyRetypeCellRewrite','dropFieldCascade','recreateFieldFromConfig']),
  VIA(EXEMPT('routes/univer-meta.ts :: POST /sheets/:sheetId/config-restore-execute :: enterFieldLinkDropFencePlan', '16', 'un-create of a link field: removes the key, writes no value.'), ['dropFieldCascade']),
  VIA(EXEMPT('routes/univer-meta.ts :: POST /sheets/:sheetId/config-restore-execute :: enterFieldLinkRestoreFencePlan', '28', 'undelete of a link field: the field row does not exist under the fence (409 ID_COLLISION otherwise), so no conversion can target it.'), ['recreateFieldFromConfig']),
  VIA(EXEMPT('routes/univer-meta.ts :: DELETE /fields/:fieldId :: enterFieldLinkDropFencePlan', '16', 'field delete cascade: `data - fieldId`, removes the key.'), ['dropFieldCascade']),
  VIA(EXEMPT('routes/univer-meta.ts :: DELETE /fields/:fieldId :: fenceWriterEntry', '16', 'as above, non-link branch.'), ['dropFieldCascade']),
  EXEMPT('routes/univer-meta.ts :: DELETE /attachments/:attachmentId :: fenceWriterEntry', '17', 'strips an attachment id from an attachment cell (FOR UPDATE, then only removes ids); attachment is an excluded retype type.'),
  EXEMPT('multitable/exact-anchor-recovery-execute.ts :: applyExactAnchorRecoveryAttempt :: acquireCanonicalSheetFencesInOrder', '18', 'exact-anchor recovery re-reads the whole sheet schema after the fence and refuses schema-drift against the token hash — stronger than the helper.'),
  ENTRY_VIA(EXEMPT('multitable/recovery-archive-restore-worker.ts :: executeChunk :: executeRecoveryArchiveAsyncRestoreChunk', '18 / 29', 'async archive restore chunk: the chunk seam hands a non-literal apply; writes go through applyExactAnchorRecoveryAttempt (row 18 schema hash). C2-F1: the write sits in the BODY of the entry this site calls — its apply callback calls applyMaterializedExactArchiveRecoveryAsyncChunkInternal, which hands the schema hash of the chunk to applyExactAnchorRecoveryAttempt; a live schema hash that differs refuses the whole chunk (schema-drift).'), ['executeRecoveryArchiveAsyncRestoreChunk>applyMaterializedExactArchiveRecoveryAsyncChunkInternal']),
  EXEMPT('multitable/recovery-archive-restore-jobs.ts :: runRecoveryArchiveRestoreChunkTestOnly :: <no in-tree call>', '29', 'test-only export of the chunk seam; same writes as executeChunk.'),
  EXEMPT('multitable/recovery-archive-restore-jobs.ts :: runRecoveryArchiveRestoreL8ChunkTestOnly :: <no in-tree call>', '29', 'test-only export of the chunk seam; same writes as executeChunk.'),
  EXEMPT('multitable/approval-record-projection-service.ts :: ApprovalRecordProjectionService.reconcile :: fenceWriterEntry', '19', 'approval projection: hard-coded values into a system_kind sheet; convert refuses 422 (system_managed_sheet / approval_projection_sheet).'),
  EXEMPT('routes/univer-meta.ts :: ensurePeopleSheetPreset :: fenceWriterEntry', '19', 'People preset: system_kind sheet, convert refuses 422.'),
  EXEMPT('services/elearning-stats-multitable-projection.ts :: projectElearningStatsToMultitable :: fenceWriterEntry', '19', 'learning-stats projection: system_kind sheet, convert refuses 422.'),
  EXEMPT('routes/univer-meta.ts :: run :: fenceWriterEntry', '20', 'createSeededSheet: every written key is a field id minted in the same transaction.'),
  EXEMPT('multitable/copy-sheet-service.ts :: install :: copyInsideTransaction', '34', 'copy-sheet: writes only the new sheet, created in the same transaction; source fields and records are read after fence(S) (增补 A).'),
  // Slice 3b — the conversion itself and its whole-column undo. They are the transactions the re-check exists to
  // protect the OTHER writers from; they carry no field snapshot across the fence. Checked by guard E.
  LOCKED_READ(EXEMPT(CONVERT_EXECUTE_KEY, 'new (slice 3b execute)', 'the conversion: takes no field snapshot before the fence. After the fence it reads the field row FOR UPDATE, re-checks the type pair on that row, locks every live and recycle-bin row of the sheet, recomputes the plan hash over type + property + every cell and refuses 409 PLAN_DRIFT unless it equals the hash the preview signed; every value written is derived from the cells read under those locks. Writes only the converted field\'s key.')),
  LOCKED_READ(EXEMPT(CONVERT_UNDO_KEY, 'new (slice 3b undo)', 'whole-column undo: takes no field snapshot before the fence. After the fence it locks the conversion row and its pre-image rows, reads the field row FOR UPDATE and refuses 409 UNDO_PRECONDITION_FAILED unless type and property equal (jsonb) what the conversion wrote; every value written comes from a pre-image row read under the fence, only into cells still equal to the conversion\'s post value. Writes only the converted field\'s key.')),

  // ── 非数据写入者 ──────────────────────────────────────────────────────────────────────────────────────
  NONWRITER('index.ts :: refresh :: refreshAttendanceReportProjectionAnchor', '21', 'attendance cleaning authority: locks projection rows, writes attendance_report_projection_anchors only.'),
  VIA(NONWRITER('index.ts :: cleanupProposal :: <no in-tree call>', '21', 'host port the attendance plugin calls with its own transaction; its data write (two keys) goes through the plugin SDK patchRecord — covered by row 2.'), ['cleanupAttendanceCleaningProposal']),
  VIA(NONWRITER('index.ts :: runStockPreparationPersistUnitOfWork :: acquireStockPreparationPersistUnitOfWorkLocks', '22', 'stock-prep unit of work only locks; the writes go through the plugin SDK (rows 2 / 3) on plugin-registered sheets (convert refuses 422).'), ['createRecord','patchRecord']),
  NONWRITER('index.ts :: ensureObjectInScope :: ensureObject', '26', 'plugin provisioning: writes meta_sheets / meta_fields / meta_views.'),
  NONWRITER('index.ts :: ensureObject :: ensureObject', '26', 'C1-F1: host-API provisioning port — opens its own transaction and calls provisioning ensureObject (meta_sheets / meta_fields / meta_views); no meta_records statement, nothing reached through callees.'),
  NONWRITER('index.ts :: ensureMissingObjectFields :: ensureMissingObjectFields', '26', 'C1-F1: host-API provisioning port (own transaction) → provisioning ensureMissingObjectFields: meta_fields only.'),
  NONWRITER('index.ts :: ensureObjectDefaultView :: ensureObjectDefaultView', '26', 'C1-F1: host-API provisioning port (own transaction) → provisioning ensureObjectDefaultView: meta_views only.'),
  NONWRITER('index.ts :: ensureView :: ensureView', '26', 'C1-F1: host-API provisioning port (own transaction) → provisioning ensureView: meta_views only.'),
  NONWRITER('index.ts :: patchObjectFieldProperty :: patchObjectFieldProperty', '26', 'C1-F1: host-API provisioning port (own transaction) → provisioning patchObjectFieldProperty: meta_fields.property only.'),
  NONWRITER('index.ts :: lockSource :: <no in-tree call>', '21', 'C1-F1: attendance cleaning port the plugin calls inside its w4c3c transaction; lockAttendanceCleaningSource → lockAttendanceCleaningProjectionAccess → lockDailyProjectionGroup takes the fence and only locks / reads (FOR UPDATE / FOR SHARE); no data write reached.'),
  NONWRITER('multitable/provisioning.ts :: ensureMissingObjectFields :: ensureMissingObjectFields', '26', 'C1-F1: the repair-transaction surface (buildObjectFieldsRepairSurface) forwards the caller\'s transaction query to ensureMissingObjectFields: meta_fields only.'),
  NONWRITER('multitable/attachment-orphan-retention.ts :: claimAttachmentBlobPurge :: fenceWriterEntry', '25', 'writes multitable_attachments only.'),
  NONWRITER('multitable/attachment-orphan-retention.ts :: claimOrphanAttachmentForPurge :: fenceWriterEntry', '25', 'writes multitable_attachments only.'),
  NONWRITER('multitable/attachment-purge-claim.ts :: claimDirectAttachmentPurge :: fenceWriterEntry', '25', 'writes multitable_attachments only.'),
  NONWRITER('routes/univer-meta.ts :: POST /sheets/:sheetId/trust-checkpoint-activate :: acquireCanonicalSheetFence', '24', 'writes checkpoint / baseline tables.'),
  NONWRITER('routes/univer-meta.ts :: PUT /sheets/:sheetId/row-level-read-deny :: fenceWriterEntry', '27', 'sheet_config access-control write.'),
  NONWRITER('routes/univer-meta.ts :: PUT /sheets/:sheetId/conditional-rules :: fenceWriterEntry', '27', 'sheet_config access-control write.'),
  VIA(NONWRITER('routes/univer-meta.ts :: POST /fields :: fenceWriterEntry', '27', 'CREATE FIELD; its only data write is the autoNumber backfill (row 14).'), ['backfillAutoNumberField']),
  VIA(NONWRITER('routes/univer-meta.ts :: PATCH /fields/:fieldId :: fenceWriterEntry', '27', 'PATCH FIELD; its only data write is the autoNumber backfill (row 14).'), ['backfillAutoNumberField']),
  NONWRITER('routes/univer-meta.ts :: POST /views :: fenceWriterEntry', '27', 'view create.'),
  NONWRITER('routes/univer-meta.ts :: GET /views :: fenceWriterEntry', '27', 'lazily inserts the default meta_views row.'),
  NONWRITER('routes/univer-meta.ts :: PATCH /views/:viewId :: fenceWriterEntry', '27', 'view update.'),
  NONWRITER('routes/univer-meta.ts :: DELETE /views/:viewId :: fenceWriterEntry', '27', 'view delete.'),
  NONWRITER('routes/univer-meta.ts :: PATCH /sheets/:sheetId/views/:viewId/form-share :: fenceWriterEntry', '27', 'form-share config.'),
  NONWRITER('routes/univer-meta.ts :: POST /sheets/:sheetId/views/:viewId/form-share/regenerate :: fenceWriterEntry', '27', 'form-share token.'),
  NONWRITER('routes/univer-meta.ts :: DELETE /sheets/:sheetId :: enterSheetLinkDeleteFencePlan', '27', 'sheet soft delete.'),
  NONWRITER('routes/univer-meta.ts :: POST /sheets/:sheetId/restore :: fenceWriterEntry', '27', 'sheet restore.'),
  NONWRITER('routes/univer-meta.ts :: PATCH /sheets/:sheetId :: fenceWriterEntry', '27', 'sheet rename / update.'),
  VIA(NONWRITER('routes/univer-meta.ts :: POST /sheets :: fenceWriterEntry', '27 / 20', 'sheet create; with seed=true it calls createSeededSheet in the same transaction, which writes records of the sheet created in that transaction, keyed only by field ids minted in it (ADR row 20).'), ['createSeededSheet']),
  NONWRITER('routes/univer-meta.ts :: POST /records/:recordId/lock :: fenceWriterEntry', '27', 'record lock / unlock: writes only the locked* columns.', 2),
  NONWRITER('routes/univer-meta.ts :: POST /templates/:templateId/install :: runInstall', 'new (26-like)', 'template install: provisioning only (base / sheets / fields / views); template-library.ts has no meta_records statement.'),
  NONWRITER('routes/univer-meta.ts :: install :: runInstall', 'new (26-like)', 'the dedupe-replay leg of the same template install.'),
  NONWRITER('multitable/object-display-name-relabel.ts :: runRelabelObjectDisplayNamesWith :: relabelObjectDisplayNames', '35', 'relabel writes meta_fields.name / meta_sheets.name only (增补 A).'),
  NONWRITER('multitable/recovery-archive-manual-admission.ts :: bindRecoveryArchiveManualAttachmentRead :: recheckManualSource', '23', 'manual admission re-check (non-literal handler); writes meta_recovery_archive_* only.', 3),
  NONWRITER('multitable/recovery-archive-manual-admission.ts :: bindRecoveryArchiveManualManifestBinding :: recheckManualSource', '23', 'as above.'),
  NONWRITER('multitable/recovery-archive-manual-admission.ts :: bindRecoveryArchiveManualNonceReservation :: recheckManualSource', '23', 'as above.'),
  NONWRITER('multitable/recovery-archive-manual-admission.ts :: bindRecoveryArchiveManualSectionPlan :: recheckManualSource', '23', 'as above.'),
  NONWRITER('multitable/recovery-archive-manual-admission.ts :: bindRecoveryArchiveManualSourceRecheck :: recheckManualSource', '23', 'as above.'),
  NONWRITER('routes/univer-meta.ts :: createRecoveryArchiveManualAdmission :: <no in-tree call>', '23', 'manual admission factory (passed by value); writes meta_recovery_archive_* only.'),
  NONWRITER('multitable/recovery-archive-manual-command.ts :: read :: acquireCanonicalSheetFence', '23', 'manual command read.'),
  NONWRITER('multitable/recovery-archive-manual-finalization.ts :: bindRecoveryArchiveManualFinalization :: readAdmitted', '23', 'manual finalization.'),
  NONWRITER('multitable/recovery-archive-expired-builder.ts :: abandonExpiredRecoveryArchiveBuilder :: admitExpiredBuilder', 'new (23-like)', 'D-L scope/key/writer-block admission and generation CAS recheck exact authority, owner/fence and actual lease expiry; changes only archive build_status, never meta_records.data.'),
  NONWRITER('multitable/recovery-archive-abandoned-object-cleanup.ts :: claimRecoveryArchiveAbandonedObjectCleanup :: admit', 'new (23-like)', 'D-L fence/key/writer-block admission rechecks scope, expired owner/fence and complete staging bindings; claim changes only meta_recovery_archives cleanup ownership.'),
  NONWRITER('multitable/recovery-archive-abandoned-object-cleanup.ts :: cleanupRecoveryArchiveAbandonedObjects :: admit', 'new (23-like)', 'Five short fenced admission checks surround outside-transaction provider IO; writes only staging terminal receipts and exact-owner source-pin references, never meta_records.data.', 5),
  NONWRITER('multitable/recovery-archive-manual-continuation.ts :: bindManualObjectUpload :: authorizedPayload', 'new (23-like)', 'Three fenced transactions recheck authority, live owner/key and durable prepared payload before registration/PUT and after IO; writes only archive staging/bindings/upload receipts.', 3),
  NONWRITER('routes/univer-meta.ts :: univerMetaRouter :: createRecoveryArchiveManualCommand', '23', 'construction-time factory call at router level, not a transaction body; the transactions it runs later are its own (row 23).', 1, false),
  NONWRITER('routes/univer-meta.ts :: univerMetaRouter :: acceptFrozenRecoveryArchiveRestoreJob', '23', 'restore job accept (route adapter).'),
  NONWRITER('routes/univer-meta.ts :: univerMetaRouter :: cancelRecoveryArchiveRestoreJob', '23', 'restore job cancel (seam, non-literal handler).'),
  NONWRITER('routes/univer-meta.ts :: resume :: resumeRecoveryArchiveRestoreJob', '23', 'restore job resume (seam, non-literal handler).'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: prepareRecoveryArchiveRestorePlan :: acquireCanonicalSheetFence', '23', 'plan registration.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: claimRecoveryArchiveRestoreJob :: prepareArchiveWriterBlockTransaction', '23', 'job claim.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: renewRecoveryArchiveRestoreJobLease :: prepareArchiveWriterBlockTransaction', '23', 'lease renewal.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: pauseRecoveryArchiveRestoreJob :: prepareArchiveWriterBlockTransaction', '23', 'job pause.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: finalizeRecoveryArchiveRestoreJob :: prepareArchiveWriterBlockTransaction', '23', 'job finalize.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: abandonRecoveryArchiveRestoreJob :: prepareArchiveWriterBlockTransaction', '23', 'job abandon.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: sweepExpiredRecoveryArchiveRestoreJobs :: prepareArchiveWriterBlockCleanupTransaction', '23', 'expired-job sweep.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: pruneEligibleRecoveryTokenBurns :: acquireCanonicalSheetFence', '23', 'token burn prune.'),
  NONWRITER('multitable/recovery-archive-restore-jobs.ts :: pruneEligibleRecoveryTokenBurns :: sql:meta_recovery_token_burn_delete_authorize', '33', 'SQL function re-entering the fence already held above; writes meta_recovery_token_burns only.'),
  NONWRITER('multitable/recovery-archive-writer-block.ts :: claimArchiveWriterBlock :: prepareArchiveWriterBlockTransaction', '30', 'writes meta_sheets.recovery_writer_* only.'),
  NONWRITER('multitable/recovery-archive-writer-block.ts :: heartbeatArchiveWriterBlock :: <no in-tree call>', '30', 'no in-tree caller; writes meta_sheets.recovery_writer_* only.'),
  NONWRITER('multitable/recovery-archive-writer-block.ts :: releaseArchiveWriterBlock :: <no in-tree call>', '30', 'no in-tree caller; writes meta_sheets.recovery_writer_* only.'),
  NONWRITER('multitable/recovery-archive-legal-holds.ts :: placeRecoveryArchiveLegalHold :: <no in-tree call>', '31', 'no in-tree caller; writes legal-hold tables only.'),
  NONWRITER('multitable/recovery-archive-legal-holds.ts :: releaseRecoveryArchiveLegalHold :: <no in-tree call>', '31', 'no in-tree caller; writes legal-hold tables only.'),
  NONWRITER('multitable/recovery-archive-legal-holds.ts :: expireRecoveryArchiveAfterLegalHoldCheck :: <no in-tree call>', '31', 'no in-tree caller; writes meta_recovery_archives only.'),
  NONWRITER('multitable/recovery-archive-legal-holds.ts :: <module> :: sql:meta_recovery_archive_legal_hold_release_authorize', '33', 'module-level SQL constant; the function re-enters a fence the TS caller already holds; no meta_records statement.'),
  NONWRITER('multitable/recovery-archive-legal-holds.ts :: <module> :: sql:meta_recovery_archive_expiry_authorize', '33', 'as above.'),
  NONWRITER('multitable/recovery-archive-legal-holds.ts :: <module> :: sql-dml:meta_recovery_archive_legal_holds', '33', 'DML on the legal-hold table fires the guard_row trigger (a SQL acquirer); no meta_records statement.', 2),
  NONWRITER(`attendance/w4c2-live-scheduled-boundary.ts :: executeLivePunch :: ${W4C0}`, '32', W4C0_REASON),
  NONWRITER(`attendance/w4c2-live-scheduled-boundary.ts :: executeScheduledRunInternal :: ${W4C0}`, '32', W4C0_REASON, 5),
  NONWRITER(`attendance/w4c2-scheduled-run-ops-worker.ts :: abandonScheduledRunOnceV1 :: ${W4C0}`, '32', W4C0_REASON),
  NONWRITER(`attendance/w4c2-scheduled-run-ops-worker.ts :: sweepAttendanceScheduledRunsOnceV1 :: ${W4C0}`, '32', W4C0_REASON, 2),
  NONWRITER(`attendance/w4c3a-import-rollback-boundary.ts :: rollbackImportBatchV1 :: ${W4C0}`, '32', W4C0_REASON),
  NONWRITER(`attendance/w4c3a-legacy-plan-processor.ts :: runSerializable :: ${W4C0}`, '32', `${W4C0_REASON} Handler is the non-literal \`work\`.`),
  NONWRITER(`attendance/w4c3a-legacy-plan-reservation-host.ts :: reserveLegacyImportPlanV1 :: ${W4C0}`, '32', W4C0_REASON),
  NONWRITER(`attendance/w4c3a-sync-import-host.ts :: commitSyncImportPlanV1 :: ${W4C0}`, '32', W4C0_REASON),
  NONWRITER(`attendance/w4c3b-request-operation-boundary.ts :: execute :: ${W4C0}`, '32', W4C0_REASON),
  NONWRITER(`attendance/w4c3c-record-operation-boundary.ts :: execute :: ${W4C0}`, '32', `${W4C0_REASON} THIS is the caller that passes attendanceCleaningSheetIds (session-level fence).`),
  NONWRITER('attendance/w4c3a-import-rollback.ts :: rollbackAttendanceImportV1 :: <no in-tree call>', '32', `${W4C0_REASON} Host entry with no in-tree caller.`),
  NONWRITER('attendance/w4c3a-rollout-control.ts :: closeLegacyRollbackWindowV1 :: <no in-tree call>', '32', `${W4C0_REASON} Host entry with no in-tree caller.`),
  NONWRITER('attendance/w4c3a-rollout-control.ts :: transitionAttendanceCalculationRolloutV1 :: <no in-tree call>', '32', `${W4C0_REASON} Host entry with no in-tree caller.`),
  NONWRITER('attendance/w7-context-source-transition.ts :: transitionAttendanceW7ContextSourceV1 :: <no in-tree call>', '32', `${W4C0_REASON} Host entry with no in-tree caller.`),
]

/** Seed-bearing functions that take NO lock (ADR "只查 pg_locks 的探针 … 不入键集", and the key constructor). */
const PROBE_LEDGER = new Map<string, string>([
  ['multitable/canonical-sheet-fence.ts#canonicalSheetFenceKey', 'the key constructor itself'],
  ['multitable/recovery-archive-writer-block.ts#requirePreparedTransaction', 'reads pg_locks to prove the fence is already held'],
  ['sql:meta_recovery_token_burn_d5_guard_row', 'SQL trigger that reads pg_locks to prove the fence is held'],
])

/** ADR §3.11 row 33: the migration SQL functions that take the same key, plus the closure through triggers. */
const SQL_ACQUIRERS = [
  'meta_recovery_archive_expiry_authorize',
  'meta_recovery_archive_legal_hold_guard_row',
  'meta_recovery_archive_legal_hold_release_authorize',
  'meta_recovery_token_burn_delete_authorize',
  'meta_recovery_token_burn_delete_request_row',
]
const TRIGGER_TABLES = ['meta_recovery_archive_legal_holds', 'meta_recovery_token_burn_delete_requests']

/** ADR "回调缝规则": the five seams it names must be derived as seams (the census may find more). */
const ADR_SEAMS = [
  'multitable/automation-executor.ts#AutomationExecutor.withTransaction',
  'multitable/automation-service.ts#AutomationService.withTransaction',
  'multitable/derived-write-fence.ts#withFencedDerivedTransaction',
  'multitable/recovery-archive-restore-jobs.ts#runRecoveryArchiveRestoreChunkCore',
  'attendance/w4c0-operation-registry.ts#runAttendanceResultOperationTransactionV1',
]

/** Rows the ADR classifies 必接 — each must be carried by at least one must-wire ledger key. */
const MUST_WIRE_ROWS = ['1', '2', '3', '4', '5', '6', '7', '13']

// ── ledger evaluation (pure, so the synthetic legs can reuse it) ─────────────────────────────────────

function countsByKey(holders: readonly FenceHolder[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const h of holders) out.set(h.key, (out.get(h.key) ?? 0) + 1)
  return out
}

function unclassified(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const known = new Set(ledger.map((e) => e.key))
  return [...countsByKey(census.holders).keys()].filter((k) => !known.has(k))
}

function countMismatches(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const counts = countsByKey(census.holders)
  return ledger
    .filter((e) => (counts.get(e.key) ?? 0) !== e.count)
    .map((e) => `${e.key}: ledger ${e.count}, census ${counts.get(e.key) ?? 0}`)
}

function mustWireViolations(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const out: string[] = []
  for (const e of ledger) {
    if (e.verdict !== 'must-wire') continue
    for (const h of census.holders.filter((x) => x.key === e.key)) {
      const verdict = checkHelperBeforeFirstWrite(h, e.helper ?? HELPER)
      if (verdict.ok === false) out.push(`${h.key} (line ${h.line}): ${verdict.reason}`)
    }
  }
  return out
}

function nonWriterViolations(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const out: string[] = []
  for (const e of ledger) {
    if (e.verdict !== 'non-data-writer' || e.regionCheck === false) continue
    for (const h of census.holders.filter((x) => x.key === e.key)) {
      const writes = directRecordDataWritesAfterFence(h)
      if (writes.length > 0) out.push(`${h.key} (line ${h.line}) writes meta_records.data after the fence: ${writes.join(' | ')}`)
    }
  }
  return out
}

function writesViaMismatches(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const out: string[] = []
  for (const e of ledger) {
    if (e.verdict === 'must-wire' || e.regionCheck === false) continue
    const found = [...new Set(census.holders.filter((h) => h.key === e.key).flatMap((h) => h.writesVia))].sort()
    const named = [...(e.writesVia ?? [])].sort()
    if (JSON.stringify(found) !== JSON.stringify(named)) out.push(`${e.key}: writes meta_records.data via [${found.join(', ')}], ledger names [${named.join(', ')}]`)
  }
  return out
}

function entryWritesViaMismatches(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const out: string[] = []
  for (const e of ledger) {
    const found = [...new Set(census.holders.filter((h) => h.key === e.key).flatMap((h) => h.entryWritesVia))].sort()
    const named = [...(e.entryWritesVia ?? [])].sort()
    if (JSON.stringify(found) !== JSON.stringify(named)) out.push(`${e.key}: the entry body writes meta_records.data via [${found.join(', ')}], ledger names [${named.join(', ')}]`)
  }
  return out
}

function lockedFieldReadViolations(census: Census, ledger: readonly LedgerEntry[]): string[] {
  const out: string[] = []
  for (const e of ledger) {
    if (e.lockedFieldRead !== true) continue
    if (e.verdict !== 'exempt') out.push(`${e.key}: lockedFieldRead is a reason for a 免检 verdict only`)
    const holders = census.holders.filter((x) => x.key === e.key)
    if (holders.length === 0) out.push(`${e.key}: no such holder`)
    for (const h of holders) {
      const verdict = checkLockedFieldReadBeforeFirstDataWrite(h)
      if (verdict.ok === false) out.push(`${h.key} (line ${h.line}): ${verdict.reason}`)
    }
  }
  return out
}

// ── the real tree ─────────────────────────────────────────────────────────────────────────────────────

const REAL_SOURCES = loadCensusSources(SRC)
const REAL = runFenceHolderCensus(REAL_SOURCES)

describe('field retype slice 3a — §3.11 fence-holder census (real tree)', () => {
  it('finds the fence at all (anti-vacuity): seeds, the core acquirer, its wrappers, and a floor of holders', () => {
    expect(REAL.seedCount).toBeGreaterThanOrEqual(5)
    expect(REAL.firstOrderAcquirers).toEqual([
      'attendance/w4c0-operation-registry.ts#acquireCleaningSessionFences',
      'multitable/canonical-sheet-fence.ts#acquireCanonicalSheetFence',
      'multitable/recovery-archive-legal-holds.ts#acquireFence',
      'multitable/recovery-archive-writer-block.ts#prepareTransaction',
    ])
    expect(REAL.entries).toEqual(expect.arrayContaining([
      'multitable/canonical-sheet-fence.ts#fenceWriterEntry', 'multitable/canonical-sheet-fence.ts#fenceWriterEntriesInOrder',
      'multitable/canonical-sheet-fence.ts#acquireCanonicalSheetFencesInOrder', 'multitable/auto-number-service.ts#acquireAutoNumberSheetWriteLock',
      'multitable/link-writer-fence.ts#enterLinkWriterFencePlan', 'multitable/recovery-archive-writer-block.ts#prepareArchiveWriterBlockTransaction',
    ]))
    expect(REAL.holders.length).toBeGreaterThanOrEqual(100)
  })

  it('A. every holder is classified by name — a new fence holder reds here until it is ledgered with a verdict', () => {
    expect(unclassified(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('A. no stale or miscounted ledger entry — a second site under an existing key is new too', () => {
    expect(countMismatches(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
    const keys = FENCE_HOLDER_LEDGER.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('A. every ledger entry carries an ADR row and a reason', () => {
    for (const e of FENCE_HOLDER_LEDGER) {
      expect(e.row.length, e.key).toBeGreaterThan(0)
      expect(e.reason.length, e.key).toBeGreaterThanOrEqual(8)
      if (e.regionCheck === false) expect(e.verdict, e.key).toBe('non-data-writer')
    }
  })

  it('B. every 必接 holder calls its helper after the fence, on the fenced query, before the first write / row lock', () => {
    expect(mustWireViolations(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('B. the ADR 必接 rows are all carried (rows 1–7 and row 13 non-scoped) — none was downgraded', () => {
    const carried = new Set(FENCE_HOLDER_LEDGER.filter((e) => e.verdict === 'must-wire').map((e) => e.row))
    expect([...carried].sort()).toEqual([...MUST_WIRE_ROWS].sort())
  })

  it('C. every 非数据写入者 holder writes no meta_records.data value after the fence in its own region', () => {
    expect(nonWriterViolations(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('C1-F4. writes reached through callees (two levels) are exactly the ledgered `writesVia` of every exempt / non-data-writer site', () => {
    expect(writesViaMismatches(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('C2-F1. writes made inside the BODY of the entry / seam a site calls, through a callee, are exactly the ledgered `entryWritesVia` — every verdict', () => {
    expect(entryWritesViaMismatches(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
    // anti-vacuity: the follow-through finds the one entry of the real tree that does write through a callee
    expect(REAL.holders.filter((h) => h.entryWritesVia.length > 0).map((h) => h.key)).toEqual([
      'multitable/recovery-archive-restore-worker.ts :: executeChunk :: executeRecoveryArchiveAsyncRestoreChunk',
    ])
  })

  it('C1-F5. the attachment stage ledger\'s private lockSource (a FOR SHARE row lock, no fence) is not a holder', () => {
    expect(REAL.holders.filter((h) => h.rel === 'multitable/recovery-archive-attachment-stage-ledger.ts')).toEqual([])
  })

  it('E. slice 3b: the conversion and its undo are 免检 because they read the field row under a lock after the fence — and they do', () => {
    expect(FENCE_HOLDER_LEDGER.filter((e) => e.lockedFieldRead === true).map((e) => e.key)).toEqual([CONVERT_EXECUTE_KEY, CONVERT_UNDO_KEY])
    expect(lockedFieldReadViolations(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
    // Each holder writes meta_records.data with exactly ONE statement of its own, through no callee. The count is
    // pinned: an exempt verdict covers the writes that were read when it was given, not the next one (C2-F4 —
    // closed for these two rows; every other exempt row of the ledger still accepts a new direct write).
    for (const key of [CONVERT_EXECUTE_KEY, CONVERT_UNDO_KEY]) {
      const holders = REAL.holders.filter((h) => h.key === key)
      expect(holders, key).toHaveLength(1)
      expect(directRecordDataWritesAfterFence(holders[0]), key).toHaveLength(1)
      expect(holders[0].writesVia, key).toEqual([])
      expect(holders[0].entryWritesVia, key).toEqual([])
    }
  })

  it('D. the probes (seed, no lock) are exactly the ledgered ones', () => {
    expect(REAL.probes).toEqual([...PROBE_LEDGER.keys()].sort())
  })

  it('D. the SQL acquirers and trigger tables are pinned (ADR row 33)', () => {
    expect(REAL.sqlAcquirers).toEqual(SQL_ACQUIRERS)
    expect(REAL.triggerTables).toEqual(TRIGGER_TABLES)
  })

  it('D. the five seams the ADR names are derived as seams (their call sites are checked on the handler literal)', () => {
    expect(REAL.seams).toEqual(expect.arrayContaining(ADR_SEAMS))
  })
})

// ── falsifiability: synthetic sources ───────────────────────────────────────────────────────────────

const FENCE_MODULE: CensusSource = {
  rel: 'multitable/canonical-sheet-fence.ts',
  text: [
    "export function canonicalSheetFenceKey(sheetId: string): string { return `meta:auto-number:sheet:${sheetId}` }",
    "export async function acquireCanonicalSheetFence(query: Q, sheetId: string): Promise<void> {",
    "  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(sheetId)])",
    '}',
    'export async function fenceWriterEntry(query: Q, sheetId: string): Promise<void> {',
    '  await acquireCanonicalSheetFence(query, sheetId)',
    '}',
  ].join('\n'),
}

const src = (rel: string, lines: string[]): CensusSource => ({ rel, text: lines.join('\n') })

function synthetic(...extra: CensusSource[]): Census {
  return runFenceHolderCensus([FENCE_MODULE, ...extra])
}

/** Holder keys outside the synthetic fence module (whose wrappers have no in-tree caller in a lone fixture). */
const keysOf = (c: Census): string[] =>
  c.holders.filter((h) => h.rel !== FENCE_MODULE.rel).map((h) => h.key)

describe('field retype slice 3a — the census analyzer on synthetic sources', () => {
  it('derives the acquirer and the wrapper from the lock primitive; the key constructor is a probe', () => {
    const c = synthetic()
    expect(c.firstOrderAcquirers).toEqual(['multitable/canonical-sheet-fence.ts#acquireCanonicalSheetFence'])
    expect(c.entries).toEqual(expect.arrayContaining(['multitable/canonical-sheet-fence.ts#acquireCanonicalSheetFence', 'multitable/canonical-sheet-fence.ts#fenceWriterEntry']))
    expect(c.probes).toEqual(['multitable/canonical-sheet-fence.ts#canonicalSheetFenceKey'])
  })

  const WRITER = src('multitable/sneaky-writer.ts', [
    "import { fenceWriterEntry } from './canonical-sheet-fence'",
    'export async function sneakyWriter(pool: P, sheetId: string) {',
    '  await pool.transaction(async ({ query }) => {',
    '    await fenceWriterEntry(query, sheetId)',
    "    await query('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [{}, 'r'])",
    '  })',
    '}',
  ])

  it('a NEW fence holder is derived and is unclassified against the real ledger (the guard goes red)', () => {
    const c = runFenceHolderCensus([...REAL_SOURCES, WRITER])
    expect(unclassified(c, FENCE_HOLDER_LEDGER)).toEqual(['multitable/sneaky-writer.ts :: sneakyWriter :: fenceWriterEntry'])
    expect(unclassified(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('a second site under an EXISTING key reds the count check', () => {
    const recordsTs = REAL_SOURCES.find((s) => s.rel === 'multitable/records.ts')!
    const anchor = '  // Field retype slice 3a (ADR §3.11 row 2)'
    const original = recordsTs.text.replace(/\r\n/g, '\n')
    expect(original.split(anchor)).toHaveLength(2)
    const doubled = { rel: recordsTs.rel, text: original.replace(anchor, `  await fenceWriterEntry(query, input.sheetId)\n${anchor}`) }
    const c = runFenceHolderCensus(REAL_SOURCES.map((s) => (s.rel === recordsTs.rel ? doubled : s)))
    expect(countMismatches(c, FENCE_HOLDER_LEDGER)).toEqual([
      'multitable/records.ts :: patchRecord :: fenceWriterEntry: ledger 1, census 2',
    ])
  })

  it('a wrapper one call away is an entry; its caller is the holder (closure, not a hand list)', () => {
    const c = synthetic(src('multitable/wrapped.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      'export async function lockIt(query: Q, sheetId: string) { await fenceWriterEntry(query, sheetId) }',
      'export async function writer(pool: P) {',
      '  await pool.transaction(async ({ query }) => {',
      "    await lockIt(query, 's')",
      "    await query('INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3)', [])",
      '  })',
      '}',
    ]))
    expect(c.entries).toContain('multitable/wrapped.ts#lockIt')
    expect(keysOf(c)).toEqual(['multitable/wrapped.ts :: writer :: lockIt'])
  })

  it('an aliased import is resolved to the original name', () => {
    const c = synthetic(src('multitable/aliased.ts', [
      "import { fenceWriterEntry as fwe } from './canonical-sheet-fence'",
      'export async function aliasedWriter(pool: P) {',
      "  await pool.transaction(async ({ query }) => { await fwe(query, 's') })",
      '}',
    ]))
    expect(keysOf(c)).toEqual(['multitable/aliased.ts :: aliasedWriter :: fenceWriterEntry'])
  })

  const MUST_WIRE_LEDGER = (key: string): LedgerEntry[] => [MUST(key, '1', 'synthetic')]

  it('B. 必接 without the helper is rejected; with it after the fence and before the write it passes', () => {
    const key = 'multitable/sneaky-writer.ts :: sneakyWriter :: fenceWriterEntry'
    expect(mustWireViolations(synthetic(WRITER), MUST_WIRE_LEDGER(key))).toEqual([
      `${key} (line 4): ${HELPER} is not called after the fence`,
    ])
    const fixed = src(WRITER.rel, WRITER.text.split('\n').flatMap((l) =>
      l.includes('fenceWriterEntry(query, sheetId)') ? [l, `    await ${HELPER}(query, sheetId, snapshot, ['f'])`] : [l]))
    expect(mustWireViolations(synthetic(fixed), MUST_WIRE_LEDGER(key))).toEqual([])
  })

  it('B. a helper placed AFTER the write, or BEFORE the fence, is rejected — order is the whole point', () => {
    const key = 'multitable/sneaky-writer.ts :: sneakyWriter :: fenceWriterEntry'
    const afterWrite = src(WRITER.rel, WRITER.text.split('\n').flatMap((l) =>
      l.includes('UPDATE meta_records') ? [l, `    await ${HELPER}(query, sheetId, snapshot, ['f'])`] : [l]))
    expect(mustWireViolations(synthetic(afterWrite), MUST_WIRE_LEDGER(key))).toEqual([
      `${key} (line 4): ${HELPER} runs after the first meta_records write / row lock`,
    ])
    const beforeFence = src(WRITER.rel, WRITER.text.split('\n').flatMap((l) =>
      l.includes('fenceWriterEntry(query, sheetId)') ? [`    await ${HELPER}(query, sheetId, snapshot, ['f'])`, l] : [l]))
    expect(mustWireViolations(synthetic(beforeFence), MUST_WIRE_LEDGER(key))).toEqual([
      `${key} (line 5): ${HELPER} is not called after the fence`,
    ])
  })

  it('B. a helper handed the POOL (another connection) is rejected — the re-read must be on the fenced query', () => {
    const key = 'multitable/sneaky-writer.ts :: sneakyWriter :: fenceWriterEntry'
    const pooled = src(WRITER.rel, WRITER.text.split('\n').flatMap((l) =>
      l.includes('fenceWriterEntry(query, sheetId)') ? [l, `    await ${HELPER}(pool.query.bind(pool), sheetId, snapshot, ['f'])`] : [l]))
    expect(mustWireViolations(synthetic(pooled), MUST_WIRE_LEDGER(key))).toEqual([
      `${key} (line 4): ${HELPER} is called with pool.query.bind(pool) instead of the fenced query query`,
    ])
  })

  it('B. a seam call site is checked on its handler LITERAL; a non-literal handler cannot pass', () => {
    const seamSrc = src('multitable/seamed.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      'export class Exec {',
      '  private async withTx<T>(sheetId: string, handler: (q: Q) => Promise<T>): Promise<T> {',
      '    return this.pool.transaction(async ({ query }) => {',
      '      await fenceWriterEntry(query, sheetId)',
      '      return handler(query)',
      '    })',
      '  }',
      '  async write(): Promise<void> {',
      '    await this.withTx(\'s\', async (query) => {',
      "      await query('UPDATE meta_records SET data = $1 WHERE id = $2', [])",
      '    })',
      '  }',
      '  async writeVia(work: (q: Q) => Promise<void>): Promise<void> {',
      "    await this.withTx('s', work)",
      '  }',
      '}',
    ])
    const c = synthetic(seamSrc)
    expect(c.seams).toContain('multitable/seamed.ts#Exec.withTx')
    expect(c.ownTransactionSeams).toContain('multitable/seamed.ts#Exec.withTx')
    const keys = keysOf(c)
    expect(keys).toEqual(['multitable/seamed.ts :: Exec.write :: withTx', 'multitable/seamed.ts :: Exec.writeVia :: withTx'])
    expect(mustWireViolations(c, MUST_WIRE_LEDGER(keys[0]))).toEqual([`${keys[0]} (line 10): ${HELPER} is not called after the fence`])
    expect(mustWireViolations(c, MUST_WIRE_LEDGER(keys[1]))[0]).toContain('not a literal')
    const wired = src(seamSrc.rel, seamSrc.text.split('\n').flatMap((l) =>
      l.includes("UPDATE meta_records SET data = $1") ? [`      await ${HELPER}(query, 's', snapshot, ['f'])`, l] : [l]))
    expect(mustWireViolations(synthetic(wired), MUST_WIRE_LEDGER(keys[0]))).toEqual([])
  })

  it('C. a non-data-writer that does write meta_records.data after the fence is caught; a lock-column UPDATE is not a data write', () => {
    const key = 'multitable/sneaky-writer.ts :: sneakyWriter :: fenceWriterEntry'
    const ledger = [NONWRITER(key, '27', 'synthetic')]
    expect(nonWriterViolations(synthetic(WRITER), ledger)).toHaveLength(1)
    const lockOnly = { rel: WRITER.rel, text: WRITER.text.replace('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', 'UPDATE meta_records SET locked = true, locked_by = $1 WHERE id = $2') }
    expect(nonWriterViolations(synthetic(lockOnly), ledger)).toEqual([])
  })

  it('SQL: a migration function holding the key + a primitive is an acquirer; its trigger table and src call sites are holders', () => {
    const migration = src('db/migrations/zz_synthetic.ts', [
      'export async function up(db: D) {',
      '  await sql`',
      '    CREATE FUNCTION public.synthetic_guard_row() RETURNS trigger LANGUAGE plpgsql AS $$',
      '    BEGIN',
      "      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('meta:auto-number:sheet:' || NEW.sheet_id));",
      '      RETURN NEW;',
      '    END $$;',
      '    CREATE TRIGGER trg_synthetic BEFORE INSERT ON public.synthetic_holds FOR EACH ROW EXECUTE FUNCTION public.synthetic_guard_row();',
      '    CREATE FUNCTION public.synthetic_probe() RETURNS boolean LANGUAGE sql AS $$',
      "      SELECT EXISTS (SELECT 1 FROM pg_locks WHERE objid = hashtext('meta:auto-number:sheet:' || 'x'))",
      '    $$;',
      '  `.execute(db)',
      '}',
    ])
    const caller = src('multitable/holds.ts', [
      'export async function placeHold(query: Q) {',
      "  await query('INSERT INTO public.synthetic_holds (sheet_id) VALUES ($1)', ['s'])",
      '}',
    ])
    const c = synthetic(migration, caller)
    expect(c.sqlAcquirers).toEqual(['synthetic_guard_row'])
    expect(c.triggerTables).toEqual(['synthetic_holds'])
    expect(c.probes).toContain('sql:synthetic_probe')
    expect(keysOf(c)).toEqual(['multitable/holds.ts :: placeHold :: sql-dml:synthetic_holds'])
    // the migration's own `up` is NOT a TS acquirer just because its SQL text holds both strings
    expect(c.firstOrderAcquirers).toEqual(['multitable/canonical-sheet-fence.ts#acquireCanonicalSheetFence'])
  })

  it('an entry with no caller in the tree is surfaced as a holder of its own', () => {
    const c = synthetic(src('multitable/port.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      'export const hostPort = { lock: async (trx: Q, sheetId: string) => { await fenceWriterEntry(trx, sheetId) } }',
    ]))
    expect(keysOf(c)).toEqual(['multitable/port.ts :: lock :: <no in-tree call>'])
  })

  it('comments produce nothing: no seed, no acquirer, no holder', () => {
    const c = synthetic(src('multitable/prose.ts', [
      '// await fenceWriterEntry(query, sheetId) then UPDATE meta_records SET data = … — meta:auto-number:sheet:x',
      '/* pg_advisory_xact_lock(hashtext(canonicalSheetFenceKey(id))) */',
      'export const nothing = 1',
    ]))
    expect(keysOf(c)).toEqual([])
    expect(c.firstOrderAcquirers).toEqual(['multitable/canonical-sheet-fence.ts#acquireCanonicalSheetFence'])
  })
})

// ── fix round: the census attacks the verifier used, turned into standing tests ──────────────────────

describe('fix round — declaration-keyed census (C1-F1, C1-F2, C1-F4, C1-F5)', () => {
  const withReal = (patch: (rel: string, text: string) => string, ...extra: CensusSource[]): Census =>
    runFenceHolderCensus([...REAL_SOURCES.map((s) => ({ rel: s.rel, text: patch(s.rel, s.text.replace(/\r\n/g, '\n')) })), ...extra])

  it('C1-F1: a NEW function named exactly like an entry (ensureView), taking the fence and writing data, is a holder — guard A reds', () => {
    const collide = src('multitable/c1-collide.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      'export async function ensureView(pool: P, sheetId: string) {',
      '  await pool.transaction(async ({ query }) => {',
      '    await fenceWriterEntry(query, sheetId)',
      "    await query('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [{}, 'r'])",
      '  })',
      '}',
    ])
    const c = withReal((_rel, text) => text, collide)
    expect(unclassified(c, FENCE_HOLDER_LEDGER)).toEqual(['multitable/c1-collide.ts :: ensureView :: fenceWriterEntry'])
  })

  it('C1-F1: an object-literal port named like an entry, opening a transaction around a fence-taking call, is a holder', () => {
    const port = src('multitable/c1-port.ts', [
      "import { ensureObject } from './provisioning'",
      'export const hostApi = {',
      '  ensureObject: async (pool: P, input: I) => pool.transaction(async ({ query }) => ensureObject({ query, ...input })),',
      '}',
    ])
    const c = withReal((_rel, text) => text, port)
    expect(unclassified(c, FENCE_HOLDER_LEDGER)).toEqual(['multitable/c1-port.ts :: ensureObject :: ensureObject'])
  })

  it('C1-F1 / C1-F5: a private function sharing a port\'s name, taking only a row lock, is NOT a holder', () => {
    const c = synthetic(
      src('multitable/port-a.ts', [
        "import { fenceWriterEntry } from './canonical-sheet-fence'",
        'export const ports = { lockThing: async (trx: Q, sheetId: string) => { await fenceWriterEntry(trx, sheetId) } }',
      ]),
      src('multitable/private-b.ts', [
        "async function lockThing(query: Q) { await query('SELECT id FROM meta_recovery_archives WHERE id = $1 FOR SHARE', ['a']) }",
        'export async function reserve(query: Q) { await lockThing(query) }',
      ]),
    )
    expect(keysOf(c)).toEqual(['multitable/port-a.ts :: lockThing :: <no in-tree call>'])
  })

  it('C1-F2: a data write in the CALLER right after a seam that fences on the caller\'s connection is caught (guard C)', () => {
    const anchor = '    const entry = await recheckManualSource(query, source, authorize)\n'
    const target = 'multitable/recovery-archive-manual-admission.ts'
    expect(REAL_SOURCES.find((s) => s.rel === target)!.text.replace(/\r\n/g, '\n')).toContain(anchor)
    const c = withReal((rel, text) => (rel === target
      ? text.replace(anchor, `${anchor}    await query('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [{}, 'r'])\n`)
      : text))
    expect(nonWriterViolations(c, FENCE_HOLDER_LEDGER).some((v) => v.startsWith(`${target} ::`))).toBe(true)
    expect(nonWriterViolations(REAL, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('C1-F4(a): a data write reached through a NEW helper called from a non-data-writer (PATCH /fields) reds the writesVia check', () => {
    const anchor = '          await backfillAutoNumberField(query, sheetId, fieldId, nextProperty, { overwrite: true })\n'
    const target = 'routes/univer-meta.ts'
    const helper = src('multitable/c1-rewrite.ts', [
      'export async function c1RewriteCells(query: Q, sheetId: string, fieldId: string) {',
      "  await query('UPDATE meta_records SET data = data || $1::jsonb WHERE sheet_id = $2', [{ [fieldId]: 'x' }, sheetId])",
      '}',
    ])
    expect(REAL_SOURCES.find((s) => s.rel === target)!.text.replace(/\r\n/g, '\n')).toContain(anchor)
    const c = withReal((rel, text) => (rel === target
      ? `import { c1RewriteCells } from '../multitable/c1-rewrite'\n${text.replace(anchor, `${anchor}          await c1RewriteCells(query, sheetId, fieldId)\n`)}`
      : text), helper)
    expect(writesViaMismatches(c, FENCE_HOLDER_LEDGER)).toEqual([
      'routes/univer-meta.ts :: PATCH /fields/:fieldId :: fenceWriterEntry: writes meta_records.data via [backfillAutoNumberField, c1RewriteCells], ledger names [backfillAutoNumberField]',
    ])
  })

  it('C1-F4(b): a handler literal handed to a convenience wrapper around a seam is checked (the write inside it is seen)', () => {
    const c = synthetic(src('multitable/wrapper.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      'export class Exec {',
      '  private async withTx<T>(sheetId: string, handler: (q: Q) => Promise<T>): Promise<T> {',
      '    return this.pool.transaction(async ({ query }) => {',
      '      await fenceWriterEntry(query, sheetId)',
      '      return handler(query)',
      '    })',
      '  }',
      '  private inSheet<T>(sheetId: string, h: (q: Q) => Promise<T>): Promise<T> {',
      '    return this.withTx(sheetId, (q) => h(q))',
      '  }',
      '  async executeSetField(): Promise<void> {',
      "    await this.inSheet('s', async (q) => {",
      "      await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [{}, 'r'])",
      '    })',
      '  }',
      '}',
    ]))
    const key = keysOf(c).find((k) => k.includes('executeSetField'))!
    expect(key).toBe('multitable/wrapper.ts :: Exec.executeSetField :: inSheet')
    expect(nonWriterViolations(c, [NONWRITER(key, '27', 'synthetic')])).toHaveLength(1)
  })
})

// ── slice 3b: guard E is falsifiable ─────────────────────────────────────────────────────────────────

describe('slice 3b — guard E (免检 by a locked field read after the fence) on synthetic and patched sources', () => {
  const FENCE = '  await enterFence(query, sheetId)'
  const READ = "  const field = await query('SELECT id, type, property FROM meta_fields WHERE id = $1 FOR UPDATE', [fieldId])"
  const WRITE = "  await query('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE sheet_id = $1', [sheetId, fieldId, field])"
  const KEY = 'multitable/convert-like.ts :: convertLike :: enterFence'
  const LEDGER = [LOCKED_READ(EXEMPT(KEY, 'new', 'synthetic'))]
  const converter = (body: string[]): Census => synthetic(src('multitable/convert-like.ts', [
    "import { acquireCanonicalSheetFence } from './canonical-sheet-fence'",
    'async function enterFence(query: Q, sheetId: string) { await acquireCanonicalSheetFence(query, sheetId) }',
    'export async function convertLike(query: Q, pool: P, sheetId: string, fieldId: string, flag: boolean) {',
    ...body,
    '}',
  ]))

  it('fence → locked field read → data write passes; FOR SHARE is a row lock too', () => {
    const c = converter([FENCE, READ, WRITE])
    expect(keysOf(c)).toEqual([KEY])
    expect(lockedFieldReadViolations(c, LEDGER)).toEqual([])
    expect(lockedFieldReadViolations(converter([FENCE, READ.replace('FOR UPDATE', 'FOR SHARE'), WRITE]), LEDGER)).toEqual([])
  })

  it('a field read taken BEFORE the fence is rejected — that is the snapshot the re-check exists for', () => {
    expect(lockedFieldReadViolations(converter([READ, FENCE, WRITE]), LEDGER)).toEqual([
      `${KEY} (line 5): the locked meta_fields read is before the fence`,
    ])
  })

  it('a field read placed AFTER the first data write is rejected', () => {
    expect(lockedFieldReadViolations(converter([FENCE, WRITE, READ]), LEDGER)).toEqual([
      `${KEY} (line 4): the locked meta_fields read is after the first meta_records.data write`,
    ])
  })

  it('a field read without a row lock is rejected', () => {
    expect(lockedFieldReadViolations(converter([FENCE, READ.replace(' FOR UPDATE', ''), WRITE]), LEDGER)).toEqual([
      `${KEY} (line 4): no locked meta_fields read (SELECT … FROM meta_fields … FOR UPDATE / FOR SHARE) after the fence`,
    ])
  })

  it('a field read inside a branch, or inside a nested callback, is rejected — a path could skip it', () => {
    expect(lockedFieldReadViolations(converter([FENCE, '  let field: unknown', '  if (flag) {', READ.replace('const field =', 'field ='), '  }', WRITE]), LEDGER)).toEqual([
      `${KEY} (line 4): the locked meta_fields read is not a top-level statement of the fenced function`,
    ])
    expect(lockedFieldReadViolations(converter([FENCE, '  const read = async () => {', `  ${READ}`, '  }', WRITE.replace(', field]', ', read]')]), LEDGER)).toEqual([
      `${KEY} (line 4): the locked meta_fields read is not a top-level statement of the fenced function`,
    ])
  })

  it('a field read issued on another connection is rejected — it must be on the fenced query', () => {
    expect(lockedFieldReadViolations(converter([FENCE, READ.replace('await query(', 'await pool.query('), WRITE]), LEDGER)).toEqual([
      `${KEY} (line 4): the locked meta_fields read is issued on pool.query instead of the fenced query query`,
    ])
  })

  it('a ledger key that names no holder, or the reason on a non-免检 verdict, is rejected', () => {
    const c = converter([FENCE, READ, WRITE])
    expect(lockedFieldReadViolations(c, [LOCKED_READ(EXEMPT('multitable/convert-like.ts :: gone :: enterFence', 'new', 'synthetic'))])).toEqual([
      'multitable/convert-like.ts :: gone :: enterFence: no such holder',
    ])
    expect(lockedFieldReadViolations(c, [LOCKED_READ(NONWRITER(KEY, 'new', 'synthetic'))])).toEqual([
      `${KEY}: lockedFieldRead is a reason for a 免检 verdict only`,
    ])
  })

  const TARGET = 'multitable/field-retype-convert-execute.ts'
  const patched = (anchor: string, replacement: string): Census => {
    const original = REAL_SOURCES.find((s) => s.rel === TARGET)!.text.replace(/\r\n/g, '\n')
    expect(original.split(anchor), anchor).toHaveLength(2)
    return runFenceHolderCensus(REAL_SOURCES.map((s) => (s.rel === TARGET ? { rel: s.rel, text: original.replace(anchor, replacement) } : s)))
  }

  it('REAL tree, execute: dropping the row lock from the field read reds guard E', () => {
    const anchor = 'FROM meta_fields WHERE id = $1 FOR UPDATE\','
    const c = patched(anchor, 'FROM meta_fields WHERE id = $1\',')
    const violations = lockedFieldReadViolations(c, FENCE_HOLDER_LEDGER)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(`${CONVERT_EXECUTE_KEY} (line `)
    expect(violations[0]).toContain('no locked meta_fields read')
  })

  it('REAL tree, undo: dropping the row lock from the field read reds guard E', () => {
    const anchor = 'FROM meta_fields WHERE id = $1 FOR UPDATE`,'
    const c = patched(anchor, 'FROM meta_fields WHERE id = $1`,')
    const violations = lockedFieldReadViolations(c, FENCE_HOLDER_LEDGER)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(`${CONVERT_UNDO_KEY} (line `)
    expect(violations[0]).toContain('no locked meta_fields read')
  })

  it('REAL tree: a SECOND direct data write in the conversion, after the locked field read, reds the pinned count', () => {
    const anchor = '  await recordConfigRevision(query, {\n    id: convertRevisionId,'
    const c = patched(anchor, `  await query('UPDATE meta_records SET data = data || $1::jsonb WHERE sheet_id = $2', [{}, sheetId])\n${anchor}`)
    const holder = c.holders.find((h) => h.key === CONVERT_EXECUTE_KEY)!
    // guard E alone would not notice: the locked field read still precedes the FIRST write
    expect(checkLockedFieldReadBeforeFirstDataWrite(holder)).toEqual({ ok: true })
    expect(directRecordDataWritesAfterFence(holder)).toHaveLength(2)
    expect(directRecordDataWritesAfterFence(REAL.holders.find((h) => h.key === CONVERT_EXECUTE_KEY)!)).toHaveLength(1)
  })

  it('REAL tree: a data write reached through a NEW callee of the conversion reds the writesVia check', () => {
    const anchor = '  await recordConfigRevision(query, {\n    id: convertRevisionId,'
    const helper = src('multitable/b3-rewrite.ts', [
      'export async function b3RewriteCells(query: Q, sheetId: string) {',
      "  await query('UPDATE meta_records SET data = data || $1::jsonb WHERE sheet_id = $2', [{}, sheetId])",
      '}',
    ])
    const original = REAL_SOURCES.find((s) => s.rel === TARGET)!.text.replace(/\r\n/g, '\n')
    expect(original.split(anchor)).toHaveLength(2)
    const text = `import { b3RewriteCells } from './b3-rewrite'\n${original.replace(anchor, `  await b3RewriteCells(query, sheetId)\n${anchor}`)}`
    const c = runFenceHolderCensus([...REAL_SOURCES.map((s) => (s.rel === TARGET ? { rel: s.rel, text } : s)), helper])
    expect(writesViaMismatches(c, FENCE_HOLDER_LEDGER)).toEqual([
      `${CONVERT_EXECUTE_KEY}: writes meta_records.data via [b3RewriteCells], ledger names []`,
    ])
  })
})

// ── slice 3b: C2-F1, the two probes of the slice 3a verdict as standing tests ────────────────────────

describe('slice 3b — C2-F1: a write inside the body of an entry or a seam, through a callee, is followed', () => {
  const REWRITE = src('multitable/zz-rewrite.ts', [
    'export async function zzRewriteCells(query: Q, sheetId: string) {',
    "  await query('UPDATE meta_records SET data = data || $1::jsonb WHERE sheet_id = $2', [{}, sheetId])",
    '}',
  ])
  const IMPORT = "import { zzRewriteCells } from './zz-rewrite'\n"
  /** The real tree with ONE file edited in memory (anchor must occur exactly once), plus the new writer module. */
  const patchedReal = (target: string, anchor: string, replacement: string, prefix = ''): Census => {
    const original = REAL_SOURCES.find((s) => s.rel === target)!.text.replace(/\r\n/g, '\n')
    expect(original.split(anchor), anchor).toHaveLength(2)
    const text = `${prefix}${original.replace(anchor, replacement)}`
    return runFenceHolderCensus([...REAL_SOURCES.map((s) => (s.rel === target ? { rel: s.rel, text } : s)), REWRITE])
  }

  it('W1a (synthetic): a callee write one level below an ENTRY is named on the holder that calls the entry', () => {
    const c = synthetic(REWRITE, src('multitable/entry-with-callee.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      "import { zzRewriteCells } from './zz-rewrite'",
      'export async function patchProperty(input: { query: Q; sheetId: string }) {',
      '  await fenceWriterEntry(input.query, input.sheetId)',
      '  await zzRewriteCells(input.query, input.sheetId)',
      '}',
      'export async function caller(pool: P, sheetId: string) {',
      '  await pool.transaction(async ({ query }) => { await patchProperty({ query, sheetId }) })',
      '}',
    ]))
    expect(c.entries).toContain('multitable/entry-with-callee.ts#patchProperty')
    const key = 'multitable/entry-with-callee.ts :: caller :: patchProperty'
    expect(keysOf(c)).toEqual([key])
    const holder = c.holders.find((h) => h.key === key)!
    expect(holder.entryWritesVia).toEqual(['patchProperty>zzRewriteCells'])
    // the holder's own region has no write and calls no writer: the census had nothing to say here before
    expect(holder.writesVia).toEqual([])
    expect(nonWriterViolations(c, [NONWRITER(key, '26', 'synthetic')])).toEqual([])
    expect(entryWritesViaMismatches(c, [NONWRITER(key, '26', 'synthetic')])).toEqual([
      `${key}: the entry body writes meta_records.data via [patchProperty>zzRewriteCells], ledger names []`,
    ])
    expect(entryWritesViaMismatches(c, [ENTRY_VIA(NONWRITER(key, '26', 'synthetic'), ['patchProperty>zzRewriteCells'])])).toEqual([])
  })

  it('W1c (synthetic): a callee write AFTER the handler returns, inside a SEAM, is named on its call site — a 必接 site included', () => {
    const c = synthetic(REWRITE, src('multitable/seam-with-callee.ts', [
      "import { fenceWriterEntry } from './canonical-sheet-fence'",
      "import { zzRewriteCells } from './zz-rewrite'",
      'export class Exec {',
      '  private async withTx<T>(sheetId: string, handler: (q: Q) => Promise<T>): Promise<T> {',
      '    return this.pool.transaction(async ({ query }) => {',
      '      await fenceWriterEntry(query, sheetId)',
      '      const out = await handler(query)',
      '      await zzRewriteCells(query, sheetId)',
      '      return out',
      '    })',
      '  }',
      '  async write(): Promise<void> {',
      "    await this.withTx('s', async (query) => {",
      `      await ${HELPER}(query, 's', snapshot, ['f'])`,
      "      await query('UPDATE meta_records SET data = $1 WHERE id = $2', [])",
      '    })',
      '  }',
      '}',
    ]))
    expect(c.seams).toContain('multitable/seam-with-callee.ts#Exec.withTx')
    const key = 'multitable/seam-with-callee.ts :: Exec.write :: withTx'
    expect(keysOf(c)).toEqual([key])
    // guard B is satisfied — the helper is in the handler, before the handler's write — and cannot see the seam's own
    expect(mustWireViolations(c, [MUST(key, '6', 'synthetic')])).toEqual([])
    expect(entryWritesViaMismatches(c, [MUST(key, '6', 'synthetic')])).toEqual([
      `${key}: the entry body writes meta_records.data via [Exec.withTx>zzRewriteCells], ledger names []`,
    ])
  })

  const PROVISIONING_ANCHOR = '  await fenceWriterEntry(input.query, sheetId)\n  const existing = await input.query(\n    `SELECT id, sheet_id, name, type, property, "order"\n     FROM meta_fields\n     WHERE sheet_id = $1 AND id = $2`,'

  it('W1a (REAL tree): provisioning.patchObjectFieldProperty calling a new writer after its fence reds the guard — and only this check', () => {
    const c = patchedReal(
      'multitable/provisioning.ts',
      PROVISIONING_ANCHOR,
      PROVISIONING_ANCHOR.replace('  const existing', '  await zzRewriteCells(input.query, sheetId)\n  const existing'),
      IMPORT,
    )
    const red = entryWritesViaMismatches(c, FENCE_HOLDER_LEDGER)
    expect(red).toContain('index.ts :: patchObjectFieldProperty :: patchObjectFieldProperty: the entry body writes meta_records.data via [patchObjectFieldProperty>zzRewriteCells], ledger names []')
    expect(red.every((line) => line.includes('[patchObjectFieldProperty>zzRewriteCells]'))).toBe(true)
    // every other check stays green: before C2-F1 the census had no way to notice this write
    expect(c.holders.length).toBe(REAL.holders.length)
    expect(unclassified(c, FENCE_HOLDER_LEDGER)).toEqual([])
    expect(countMismatches(c, FENCE_HOLDER_LEDGER)).toEqual([])
    expect(writesViaMismatches(c, FENCE_HOLDER_LEDGER)).toEqual([])
    expect(nonWriterViolations(c, FENCE_HOLDER_LEDGER)).toEqual([])
    expect(mustWireViolations(c, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('W1c (REAL tree): AutomationExecutor.withTransaction calling a new writer after the handler returns reds every one of its call sites', () => {
    const anchor = '        await fenceWriterEntriesInOrder(query, ids) // L4 fence-first; no-op when the fence flag is OFF\n        return handler(query)\n'
    const target = 'multitable/automation-executor.ts'
    const c = patchedReal(
      target,
      anchor,
      anchor.replace('        return handler(query)\n', '        const out = await handler(query)\n        await zzRewriteCells(query, ids[0])\n        return out\n'),
      IMPORT,
    )
    const sites = FENCE_HOLDER_LEDGER.filter((e) => e.key.startsWith(`${target} :: `) && e.key.endsWith(' :: withTransaction'))
    expect(sites.length).toBeGreaterThanOrEqual(6)
    expect(sites.some((e) => e.verdict === 'must-wire')).toBe(true)
    expect(sites.some((e) => e.verdict === 'exempt')).toBe(true)
    expect(entryWritesViaMismatches(c, FENCE_HOLDER_LEDGER).sort()).toEqual(
      sites.map((e) => `${e.key}: the entry body writes meta_records.data via [AutomationExecutor.withTransaction>zzRewriteCells], ledger names []`).sort(),
    )
    expect(unclassified(c, FENCE_HOLDER_LEDGER)).toEqual([])
    expect(mustWireViolations(c, FENCE_HOLDER_LEDGER)).toEqual([])
    expect(writesViaMismatches(c, FENCE_HOLDER_LEDGER)).toEqual([])
  })

  it('W1b (control): the same write made DIRECTLY in the entry makes it a holder of its own — that path was already red', () => {
    const c = patchedReal(
      'multitable/provisioning.ts',
      PROVISIONING_ANCHOR,
      PROVISIONING_ANCHOR.replace('  const existing', "  await input.query('UPDATE meta_records SET data = data || $1::jsonb WHERE sheet_id = $2', [{}, sheetId])\n  const existing"),
    )
    expect(unclassified(c, FENCE_HOLDER_LEDGER)).toContain('multitable/provisioning.ts :: patchObjectFieldProperty :: fenceWriterEntry')
  })
})
