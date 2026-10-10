#!/usr/bin/env node
/**
 * R12-C — Global History flag manifest (SINGLE SOURCE OF TRUTH).
 *
 * Every fact in this file was read from the cited `packages/core-backend/src` line(s) on 2026-07-12,
 * not copied from `docs/development/multitable-global-history-o2-operator-flag-ladder-20260709.md`
 * (that doc is the thing being fixed — it mislabels `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT` as itself
 * "4c-1 lossy retype revert" when the lossy behavior actually lives behind a SEPARATE flag,
 * `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY`, gated on top of the base flag — see rule R1 below).
 *
 * `scripts/ops/multitable-global-history-flag-status.mjs` imports this manifest and MUST NOT
 * hand-maintain a parallel flag list. If a flag or rule here is deleted or weakened, the tests in
 * `global-history-flag-manifest.test.mjs` fail.
 *
 * ## Activation semantics (the operator footgun, R4/R12-C)
 *
 * `activationValue` is the source-accurate string the flag must equal. Normalization happens ONLY when
 * `caseInsensitive: true`; every other boolean comparison is byte-exact. Two families exist:
 *   - capture/replay/revert flags compare with `=== 'true'` (case-SENSITIVE, no trim in most call sites,
 *     except PIT_RESET/PIT_UNDELETE/SHEET_REVERT which use `.trim().toLowerCase() === 'true'`)
 *   - the retention flag compares with `=== '1'` (NOT `'true'`) — `meta-revision-retention.ts:60`
 * Setting the wrong string for a given flag is silent: the gated code path stays OFF and nothing errors.
 */

/**
 * @typedef {Object} FlagRule
 * @property {string} kind - 'requires' (dependsOn active) | 'requires-exact' (dependsOn equals its activationValue byte-for-byte) | 'conflicts' (target active)
 * @property {string} id - stable violation id reported by flag status
 * @property {string} description
 */

/**
 * @typedef {Object} FlagSpec
 * @property {string} key
 * @property {'boolean'|'numeric'|'enum'|'list'} type - 'list' = comma-separated allowlist; like 'numeric'/'enum'
 *   it is NOT a boolean, so isActivated()/isMisconfiguredTruthy() return false for it by construction and it
 *   can never participate in a dependsOn/conflicts rule (those evaluate activation).
 * @property {string} activationValue - exact string that activates a boolean flag (ignored for numeric/enum)
 * @property {boolean} [caseInsensitive] - true only for the three flags (PIT_RESET/PIT_UNDELETE/SHEET_REVERT) whose source call site lowercases+trims
 * @property {string[]} dependsOn - other flag keys that MUST also be active for this flag's gated effect to be safe/whole
 * @property {string[]} conflictsWith - other flag keys that MUST NOT be active at the same time as this one
 * @property {'low'|'medium'|'high'} danger
 * @property {string} purpose
 * @property {string} source - file:line citation, verified 2026-07-12
 * @property {FlagRule[]} [rules] - illegal-combination rules keyed off this flag (evaluated by evaluateFlagRules)
 */

/** @type {FlagSpec[]} */
export const GLOBAL_HISTORY_FLAG_MANIFEST = Object.freeze([
  {
    key: 'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      'TRANSITION ONLY, and a REGRESSION while on. Schema management (rename/retype/delete a field, 11 gated routes) was split out of multitable:write into multitable:manage-schema, because an operator who may fill a cell must not be able to delete the column. With this flag true, multitable:write is ALSO accepted for canManageFields -- the old fused behaviour returns. Default OFF is the intended end state; the flag exists only so a deployment can stage granting the new code before tightening.',
    source: 'packages/core-backend/src/multitable/manage-schema-permission.ts',
  },
  {
    key: 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: ['MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA'],
    danger: 'high',
    purpose:
      "Field type CONVERSION with value migration, first batch string -> select / multiSelect (design lock docs/development/multitable-field-retype-first-batch-adr-20260926.md, addenda B and C). Default OFF; exact literal 'true' only (no trim, no case folding). Gates all three endpoints: the read-only POST /fields/:fieldId/retype-preview and the execute / undo endpoints. Off: every one of them answers 403 FIELD_RETYPE_CONVERT_DISABLED before any read. TWO-FLAG GATE for everything this feature does to OTHER writers (slice 3a, Decision Register R-22): it runs only while this flag AND the canonical writer fence MULTITABLE_ENABLE_WRITER_FENCE are BOTH on. (1) Post-fence field-schema re-check (ADR §3.11): every record writer that validated a write against a field snapshot taken before the canonical sheet fence re-reads the touched fields FOR SHARE after the fence and refuses 409 FIELD_SCHEMA_CHANGED if a field's type or option set changed while it waited (automation step fails; approval write-back throws; an AI bulk-commit row comes back stale_reprev; a realtime edit has its record document invalidated so its editors are told), and a non-scoped derived-value merge whose target is no longer formula/lookup/rollup is skipped. (2) Automation option validation (ADR §3.12): update_record / create_record check select / multiSelect values against the field's options. EFFECT ON EXISTING AUTOMATION RULES once both flags are on: a rule that writes a value outside the options, a non-string (null included) into a single select, or a malformed multi-select value turns from 'the value lands' into 'the step fails' — on EVERY select / multiSelect column, converted or not. Count the affected rules before switching on (runbook). Either flag off: none of (1) or (2) runs and every writer issues exactly its pre-existing statements. EVERY BACKEND PROCESS that writes records (API, automation and scheduler workers, realtime) must carry the SAME values of BOTH flags: the gate is read from each process's own environment, so a process started without them does not re-check while another process converts. PATCH /fields/:fieldId is NOT affected by this flag: string -> select / multiSelect stays 400 FIELD_RETYPE_NOT_LOSSLESS there either way. With MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA on, all three endpoints refuse 409 FIELD_RETYPE_TRUST_REQUIRED (reason legacy_manage_schema_flag) — hence the conflicts rule. Execute / undo additionally refuse 409 FIELD_RETYPE_TRUST_REQUIRED while the canonical writer fence is off; that is enforced in-process and deliberately NOT modelled as a dependsOn/requires rule, so turning this flag on alone to run the read-only preview is a legal rung. Deploy order: migrations -> writer fence -> this flag. danger=high: execute rewrites a whole column of live record data.",
    source: 'packages/core-backend/src/multitable/field-retype-convert.ts#isFieldRetypeConvertEnabled; packages/core-backend/src/routes/univer-meta.ts#retype-preview,retype-execute,retype-undo; packages/core-backend/src/multitable/field-schema-fence-recheck.ts#isFieldSchemaFenceRecheckEnabled (two-flag gate: writer re-check and automation option validation); packages/core-backend/src/collab/yjs-invalidation.ts#createFieldSchemaRefusalHandler (realtime)',
    rules: [
      {
        kind: 'conflicts',
        id: 'field-retype-convert-with-legacy-manage-schema',
        description:
          'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT is active while MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA is active — the legacy switch lets multitable:write hold schema authority, below the gate field type conversion requires, so every conversion endpoint refuses 409 FIELD_RETYPE_TRUST_REQUIRED. Field type conversion cannot function in this state.',
      },
    ],
  },
  {
    key: 'MULTITABLE_ENABLE_SHEET_CONFIG_REVERT',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'Gates sheet_config revert-preview/execute (Tier-1 config revert). Default OFF; when off, both routes return 403 CONFIG_REVERT_DISABLED (verify exact code string at call sites before relying on it in alerts).',
    // source: packages/core-backend/src/routes/univer-meta.ts:8713 (preview), :8794 (execute) — `!== 'true'` guard
    source: 'packages/core-backend/src/routes/univer-meta.ts:8713,8794',
  },
  {
    key: 'MULTITABLE_ENABLE_CONFIG_UNCREATE',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      'T9-W Tier 3 (U-3): un-create a field/view = DROP the created entity (irreversible: drops the column and every value created after that point). Independent of the other config-revert flags.',
    // source: packages/core-backend/src/routes/univer-meta.ts:8593 (preview), :8807 (execute) — `!== 'true'` guard
    source: 'packages/core-backend/src/routes/univer-meta.ts:8593,8807',
  },
  {
    key: 'MULTITABLE_ENABLE_CONFIG_UNDELETE',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'T9-W Tier 4 (U-4): undelete recreates a deleted field/view definition from its `before` revision, AND — when a matching tombstone set exists (MULTITABLE_TOMBSTONE_CAPTURE_ENABLED was on at delete time) — rehydrates column values (only into records that do NOT already have the key, never clobbering a value written after the recreate), inbound link edges (only between two currently-alive records), and the auto-number sequence next_value. Degrades to DEFINITION-ONLY (values/links/auto-number NOT restored) ONLY for pre-capture deletes or expired tombstones (recreateFieldFromConfig, C1 forward-only). The earlier "definition-only, values not restored" framing was stale.',
    // source: packages/core-backend/src/routes/univer-meta.ts:8611 (preview), :8861 (execute) — `!== 'true'` guard;
    //         :6469 recreateFieldFromConfig (tombstone-gated values/links/auto-number rehydration, else definition-only)
    source: 'packages/core-backend/src/routes/univer-meta.ts:8611,8861,6469',
  },
  {
    key: 'MULTITABLE_ENABLE_PERMISSION_REVERT',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose: 'Gates permission-entity revert-preview/execute. Independent of the other config-revert flags.',
    // source: packages/core-backend/src/routes/univer-meta.ts:8652 (preview), :8908 (execute) — `!== 'true'` guard
    source: 'packages/core-backend/src/routes/univer-meta.ts:8652,8908',
  },
  {
    key: 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'BASE flag for field type/property revert (4c-1). Off ⇒ 403 FIELD_RETYPE_REVERT_DISABLED. This flag alone only covers the LOSSLESS/structural revert envelope; the LOSSY re-interpretation behavior is a SEPARATE, additionally-gated flag (see MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY) — the o2-ladder doc conflates the two, this manifest does not.',
    // source: packages/core-backend/src/routes/univer-meta.ts:8665-8666,8789-8790 (`!== 'true'` guard);
    //         packages/core-backend/src/multitable/lossy-retype-oracle.ts:108 (second half of the AND)
    source:
      'packages/core-backend/src/routes/univer-meta.ts:8665-8666,8789-8790; packages/core-backend/src/multitable/lossy-retype-oracle.ts:108',
  },
  {
    key: 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'],
    conflictsWith: [],
    danger: 'high',
    purpose:
      'R1 — LOSSY double-gate. `isLossyRetypeRevertEnabled()` returns true only when BOTH this flag AND MULTITABLE_ENABLE_FIELD_RETYPE_REVERT equal the exact string \'true\'. LOSSY=true with base=false is not merely inert — an operator reading this flag in isolation would wrongly believe lossy revert is live; it is not (the base 403 fires first). Danger=high because when the base IS on, this unlocks re-interpretation of stored cell values under a restored field configuration (data can be emptied/rewritten, not a value-level recovery).',
    // source: packages/core-backend/src/multitable/lossy-retype-oracle.ts:105-109
    //   export function isLossyRetypeRevertEnabled(env) {
    //     return env.MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY === 'true' && env.MULTITABLE_ENABLE_FIELD_RETYPE_REVERT === 'true'
    //   }
    source: 'packages/core-backend/src/multitable/lossy-retype-oracle.ts:105-109',
    rules: [
      {
        kind: 'requires',
        id: 'lossy-without-base',
        description:
          "MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY is active ('true') but MULTITABLE_ENABLE_FIELD_RETYPE_REVERT is not active — the lossy gate has no effect (isLossyRetypeRevertEnabled requires both), so this flag combination is dead configuration, not a working feature.",
      },
    ],
  },
  {
    key: 'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true, // `.trim().toLowerCase() === 'true'`, same resolution family as SHEET_REVERT/PIT_RESET
    // Gate P2 (2026-07-17): a checkpoint minted without the canonical fence is a DURABLE untrustworthy
    // artifact (torn baseline vs the allocated trusted_since_seq). The route ALSO fails closed at runtime
    // (409 TRUST_CHECKPOINT_FENCE_REQUIRED when the fence flag is off) — this dep is the operator-facing
    // declaration of the same invariant.
    dependsOn: ['MULTITABLE_ENABLE_WRITER_FENCE'],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'W0-1 L5-wire (owner review 2026-07-17): the production caller for activateCheckpoint — POST /sheets/:sheetId/trust-checkpoint-activate provisions a trust checkpoint for one sheet in ONE fenced transaction (canonical fence first, then the design-lock §3 cutover: allocate trusted_since_seq, snapshot live + attributable-trash baselines, supersede the prior active checkpoint, activate). ADDITIVE-ONLY trust provisioning: no destructive write, and activating a checkpoint enables NOTHING by itself — strict mode and Revert/Reset stay behind their own default-OFF flags; a checkpoint is merely the (a)-half of the strict-enablement precondition. Fail-closed: an unattributable trashed-only record aborts the whole activation (409 HISTORY_INCOMPLETE, values-free). Sheet-admin (canManageSheetAccess, D2) floor — provisioning the trust floor for destructive recovery is an admin capability. danger=medium (not high): it writes only checkpoint/baseline rows, never live record data, but it moves the sheet\'s trust floor that later destructive recoveries anchor on, so it is not a plain ops convenience either.',
    source: 'packages/core-backend/src/routes/univer-meta.ts#TRUST_CHECKPOINT_ACTIVATION_ENABLED,/trust-checkpoint-activate',
  },
  {
    key: 'MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST',
    type: 'list',
    // Kept SHORT on purpose: this string is rendered inline on the operator's per-flag status line
    // (multitable-global-history-flag-status.mjs non-boolean branch). The full rationale is in `purpose`.
    activationValue:
      "comma-separated sheet ids (trimmed, EXACT match); UNSET/EMPTY ⇒ refused for EVERY sheet, fail-closed",
    // NOT modeled as a dependsOn of MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION: isActivated() is false for
    // every non-boolean spec (see :414), so a `requires` rule keyed off this list would fire on EVERY posture
    // that has activation on — including the ladder's legitimate `l2-checkpoint` posture — and permanently red
    // the --strict status. The precondition is enforced in-process by the route and documented here instead.
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      "SCOPE gate for trust-checkpoint activation (P2 fix, 2026-08-25). The O-2 enablement ladder's L2-C rung provisions a checkpoint for a NAMED synthetic canary sheet only and explicitly forbids bulk-provisioning customer sheets — before this flag that was CONVENTION and the route accepted any sheet id. Now the route refuses unless the requested sheet id appears verbatim in this list, so owner designation is a precondition by construction. Fail-closed in the operator-relevant direction: leaving it unset does not 'disable the restriction', it disables ACTIVATION ENTIRELY. Danger=medium rather than low because a too-wide value (e.g. pasting customer sheet ids) is what the L2-C rung forbids, and a checkpoint is a durable trust anchor for later destructive recovery. The refusal is values-free: it names the env var and the required action, never the requested sheet id and never the list contents.",
    source:
      'packages/core-backend/src/multitable/trust-checkpoint-activation-authz.ts#TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV,resolveTrustCheckpointSheetAllowlist,isTrustCheckpointSheetAllowlisted; packages/core-backend/src/routes/univer-meta.ts#/trust-checkpoint-activate',
  },
  {
    key: 'MULTITABLE_ENABLE_SHEET_REVERT',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true,
    dependsOn: [],
    conflictsWith: ['MULTITABLE_META_REVISION_RETENTION_ENABLED'],
    danger: 'high',
    purpose:
      'Revert-execute master gate (default OFF): exact-anchor recovery is WIRED (L6 resolveExactAnchor + L7 plan classification + L8 applyExactAnchorRecovery, all-or-nothing in ONE transaction; authority is exactly one historyBatchId or anchorOperationId — free wall-clock asOf refuses 400 EXACT_ANCHOR_REQUIRED, both ids refuse 400 AMBIGUOUS_ANCHOR). Execute is TOKEN-ONLY authority: the verified previewIdentity carries the mode, and a reset-minted token refuses on this surface before any write. Both preview and execute refuse 409 REVERT_RETENTION_CONFLICT whenever meta revision retention is active, matching PIT Reset until recovery-aware retention exists; the conflict is emitted only after authentication, existence hiding, and conservative full-read, but before trust/anchor/reconstruction work. At RUNTIME both preview and execute additionally require the trust pair MULTITABLE_ENABLE_WRITER_FENCE + MULTITABLE_HISTORY_CONTIGUITY_STRICT (409 RECOVERY_TRUST_REQUIRED otherwise; not modeled as a dependsOn rule — the refusal is enforced in-process, values-free). Restores the RESTORABLE projection only (canonical record-restore-diff; derived formula/lookup/rollup values recompute post-commit, never restored history). Exact-anchor undelete/resurrection is fail-closed (409 INBOUND_UNPROVABLE; no executable token is minted for resurrect-bearing plans). Mirrors MULTITABLE_ENABLE_PIT_RESET\'s gate exactly: SAME `String(env).trim().toLowerCase() === \'true\'` resolution (hence caseInsensitive), same canManageSheetAccess (D2) floor + conservative full-table-read gate. danger=high: a whole-sheet-scale destructive bulk write over live record data with no undo. revert-preview stays UNGATED by this flag (read-only; capabilities.sheetRevertEnabled controls FE button visibility) but still refuses without retention, the trust pair, or an executable plan before minting any token.',
    // Source symbols (line numbers intentionally omitted because this route is edited frequently):
    // SHEET_REVERT_ENABLED, the handleExactAnchorExecute REVERT_DISABLED guard, capabilities.sheetRevertEnabled.
    source: 'packages/core-backend/src/routes/univer-meta.ts#SHEET_REVERT_ENABLED,isMetaRevisionRetentionEnabled,sendRecoveryRetentionBlocked,handleExactAnchorPreview,handleExactAnchorExecute,capabilities.sheetRevertEnabled; packages/core-backend/src/multitable/exact-anchor-recovery-route.ts#checkExactAnchorRecoveryTrust',
    rules: [
      {
        kind: 'conflicts',
        id: 'sheet-revert-intent-with-retention-on',
        description:
          "MULTITABLE_ENABLE_SHEET_REVERT is active while MULTITABLE_META_REVISION_RETENTION_ENABLED is active ('1') — exact-anchor Revert refuses every revert-preview and revert-execute call with 409 REVERT_RETENTION_CONFLICT. Revert-to-T cannot function in this state.",
      },
    ],
  },
  {
    key: 'MULTITABLE_ENABLE_PIT_RESET',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true,
    dependsOn: [],
    conflictsWith: ['MULTITABLE_META_REVISION_RETENTION_ENABLED'],
    danger: 'high',
    purpose:
      'R3 — PIT-reset vs retention STOP-SHIP. T8-2 / W0 L8 Reset-to-T (destructive whole-sheet EXACT-ANCHOR restore: historyBatchId/anchorOperationId only — free wall-clock asOf refuses 400 EXACT_ANCHOR_REQUIRED). Execute is TOKEN-ONLY authority with the typed confirm:\'reset\' second step; a revert-minted token refuses on this surface before any write. At RUNTIME both preview and execute also require the trust pair MULTITABLE_ENABLE_WRITER_FENCE + MULTITABLE_HISTORY_CONTIGUITY_STRICT (409 RECOVERY_TRUST_REQUIRED otherwise; enforced in-process, not a dependsOn rule). Gated by PIT_RESET_ENABLED() (`.trim().toLowerCase() === \'true\'`, so \'TRUE\'/\' true \' also activate it — unlike most other flags in this manifest). BOTH reset-preview and reset-execute additionally call isMetaRevisionRetentionEnabled() and refuse with 409 RESET_RETENTION_CONFLICT whenever meta-revision retention is active. An operator who intends to use PIT reset MUST NOT also have retention active.',
    // Anchored by SYMBOL NAME (drift-proof): PIT_RESET_ENABLED + isMetaRevisionRetentionEnabled (compares
    // MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'); both handleExactAnchorPreview('reset') and
    // handleExactAnchorExecute('reset') call the shared blocked-check.
    source: 'packages/core-backend/src/routes/univer-meta.ts#PIT_RESET_ENABLED,isMetaRevisionRetentionEnabled,sendRecoveryRetentionBlocked,handleExactAnchorPreview,handleExactAnchorExecute',
    rules: [
      {
        kind: 'conflicts',
        id: 'pit-reset-intent-with-retention-on',
        description:
          "MULTITABLE_ENABLE_PIT_RESET is active while MULTITABLE_META_REVISION_RETENTION_ENABLED is active ('1') — isMetaRevisionRetentionEnabled() will refuse every reset-preview and reset-execute call with 409 RESET_RETENTION_CONFLICT. Reset-to-T cannot function in this state.",
      },
    ],
  },
  {
    key: 'MULTITABLE_ENABLE_PIT_UNDELETE',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true,
    dependsOn: ['MULTITABLE_ENABLE_SHEET_REVERT'],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'T8-1 PIT undelete-execute (resurrect face). Gated by `.trim().toLowerCase() === \'true\'` — same case-insensitive family as PIT_RESET. On the exact-anchor surfaces (W0 L8) resurrection is currently FAIL-CLOSED regardless of this flag: at-anchor inbound link state cannot be proven, so the L8 apply whole-refuses resurrect-bearing plans (409 INBOUND_UNPROVABLE) and a resurrect-bearing preview never mints an executable token — the preview\'s undeleteBlockedReason merely distinguishes flag-off (UNDELETE_DISABLED) from flag-on-but-authority-missing (INBOUND_UNPROVABLE). Legacy terminal-vintage inbound replay remains under MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND for non-exact-anchor surfaces (record-level restore) only. The undelete face still conceptually rides INSIDE revert-execute, whose SHEET_REVERT master gate is checked FIRST — so undelete requires BOTH gates (and, today, an inbound authority that does not yet exist).',
    // Anchored by SYMBOL NAME (drift-proof, no line numbers): PIT_UNDELETE_ENABLED helper + the
    // undeleteBlockedReason disclosure inside handleExactAnchorPreview.
    source: 'packages/core-backend/src/routes/univer-meta.ts (symbol refs, drift-proof: PIT_UNDELETE_ENABLED helper + the undeleteBlockedReason disclosure in handleExactAnchorPreview; the SHEET_REVERT master gate lives in handleExactAnchorExecute)',
    rules: [
      {
        kind: 'requires',
        id: 'undelete-without-revert-gate',
        description:
          "MULTITABLE_ENABLE_PIT_UNDELETE is active but MULTITABLE_ENABLE_SHEET_REVERT is not — the undelete face rides inside revert-execute, whose master gate (checked FIRST) returns 403 REVERT_DISABLED before the undelete gate is reached. So undelete has no effect without SHEET_REVERT: dead configuration, not a working feature. Enable BOTH to make undelete-revert live.",
      },
    ],
  },
  {
    key: 'MULTITABLE_ENABLE_WRITER_FENCE',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true, // canonical-sheet-fence.ts isWriterFenceEnabled(): `.trim().toLowerCase() === 'true'`
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      "W0-1 L4 canonical sheet-state fence. Default OFF ⇒ byte-identical writer behavior (no fence acquired, no durable-block checks, the auto-number advisory key keeps its pre-L4 single-caller semantics). When ON, every fenced meta_records writer serializes through the per-sheet canonical advisory fence (pg_advisory_xact_lock) and refuses 409 RECOVERY_IN_PROGRESS while a durable recovery writer-block ({fencing,applying,paused_retryable} in meta_sheets.recovery_writer_state) is active; revert/reset-execute claim that durable block across their windows (reset additionally checks it fence-first — the recovery-vs-recovery exclusion). danger=medium, not high: the flag never enables a destructive write (Revert/Reset stay behind their own gates) — it changes writer concurrency semantics (advisory-lock serialization + fail-closed refusal windows), which is a production behavior change but a protective one.",
    // source: packages/core-backend/src/multitable/canonical-sheet-fence.ts:137 (isWriterFenceEnabled) — read by
    //         record-service/record-write-service/records/auto-number-service/univer-meta writer entry points.
    source: 'packages/core-backend/src/multitable/canonical-sheet-fence.ts:137',
  },
  {
    key: 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['MULTITABLE_ENABLE_WRITER_FENCE'],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      "Time Machine archive runtime gate: exact-case-sensitive `=== 'true'`; unset, false, TRUE, and whitespace remain OFF. The dedicated local launcher requires this flag and MULTITABLE_ENABLE_WRITER_FENCE both exact ON, admitted local configuration and FD3 custody unlock before listening. Ordinary server startup without an injected archive composition refuses ON; manual capture also requires explicit policy. This flag has no retention conflict and does not enable prune or retention.",
    source: 'packages/core-backend/src/multitable/recovery-archive-contract.ts#isMultitableRecoveryArchiveEnabled',
    rules: [
      {
        kind: 'requires-exact',
        id: 'archive-without-exact-writer-fence',
        description: 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED is active but MULTITABLE_ENABLE_WRITER_FENCE is not exactly true; the archive worker and local launcher refuse this combination.',
      },
    ],
  },
  {
    key: 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'C7 — 4c-3 replay layer: restore / PIT-resurrect rebuilds inbound link edges from captured tombstones (Option A neighbor-consent). NOTE (advisory, not a code-enforced dependency): replay can only recover edges tombstoned while MULTITABLE_TOMBSTONE_CAPTURE_ENABLED was ALSO on (forward-only, C1) — enabling this flag with capture never having run yields zero replayable edges, not an error. This ordering is NOT gated in code (isRecordUndeleteInboundEnabled has no cross-flag check), so it is intentionally left out of dependsOn/conflictsWith to avoid a false --strict failure; it is documented here only.',
    // source: packages/core-backend/src/multitable/inbound-link-replay.ts:202-203
    source: 'packages/core-backend/src/multitable/inbound-link-replay.ts:202-203',
  },
  {
    key: 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Capture layer: writes link tombstones when a record/field-referencing delete or PIT-reset destroys inbound edges. Default OFF ⇒ byte-identical to pre-4c-2 behavior. Foundation flag other recovery flags build on (advisory ordering, see MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND and MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED purposes).',
    // source: packages/core-backend/src/multitable/tombstone-capture.ts:44-45
    source: 'packages/core-backend/src/multitable/tombstone-capture.ts:44-45',
  },
  {
    key: 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS',
    type: 'numeric',
    activationValue: 'numeric (default 50000; any positive integer overrides)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Fail-closed cap on inbound edges captured per destructive op. Over-cap destroys nothing (TombstoneCaptureCapExceededError propagates; the delete/reset is refused with 422). Numeric, default 50000 when unset/non-positive.',
    // source: packages/core-backend/src/multitable/tombstone-capture.ts:42 (default), :48-51 (resolver)
    source: 'packages/core-backend/src/multitable/tombstone-capture.ts:42,48-51',
  },
  {
    key: 'MULTITABLE_SHEET_REVERT_MAX_RECORDS',
    type: 'numeric',
    activationValue: 'numeric (default 5000; any positive integer overrides, else the default)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'Fail-closed record-count ceiling for whole-sheet revert/reset. Bounds how many records a single revert/reset/undelete may touch — the field-retype revert (incl. lossy), sheet-wide revert, and PIT reset paths REFUSE (not partially apply) when the computed record count exceeds it (D3/PIT-6 fail-closed before the full scan; undelete cannot bypass it). Numeric, default 5000 when unset/non-positive. A too-low value silently blocks legitimate large reverts; an operator running a large-sheet recovery must raise it deliberately.',
    // source: packages/core-backend/src/multitable/restore-caps.ts:15 (SHEET_REVERT_DEFAULT_MAX_RECORDS=5000), :17-19 (resolveSheetRevertMaxRecords reads MULTITABLE_SHEET_REVERT_MAX_RECORDS);
    //         consumed at packages/core-backend/src/routes/univer-meta.ts:8692,8981,9930 (retype-revert + sheet-revert/reset ceilings). Line anchors verified at the PR head (an earlier draft cited a behind-main tree).
    source: 'packages/core-backend/src/multitable/restore-caps.ts:15,17-19',
  },
  {
    key: 'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'],
    conflictsWith: [],
    danger: 'high',
    purpose:
      'R2 — D-2 side-door recoverability (design-lock #4004). Makes the plugin-SDK and automation `delete_record` hard-delete paths write a meta_records_trash row (so the record becomes restorable). Danger=high because the nested-capture rule is easy to half-enable: this flag alone writes trash+anchor but captures ZERO inbound tombstones unless MULTITABLE_TOMBSTONE_CAPTURE_ENABLED is ALSO on — a restored record from that state reports inboundEdgesRecoverable:false (not a bug, but likely not what the operator intended). Also fail-closed on missing schema (meta_records_trash / delete_revision_id): 42P01/42703 propagate and refuse the delete rather than degrading silently.',
    // source: packages/core-backend/src/multitable/side-door-delete-trash.ts:122-123 (isSideDoorDeleteTrashEnabled),
    //         :130-131 (isSideDoorTombstoneCaptureEnabled = isSideDoorDeleteTrashEnabled(env) && isTombstoneCaptureEnabled(env));
    //         packages/core-backend/src/multitable/record-errors.ts:19-23 (typed cap-exceeded error doc, same nesting rule)
    source:
      'packages/core-backend/src/multitable/side-door-delete-trash.ts:122-123,130-131; packages/core-backend/src/multitable/record-errors.ts:19-23',
    rules: [
      {
        kind: 'requires',
        id: 'side-door-without-capture',
        description:
          "OPERATOR ROLLOUT-POLICY STOP / degraded recoverability (NOT a code-illegal combination): MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED is active while MULTITABLE_TOMBSTONE_CAPTURE_ENABLED is not. The code ALLOWS this — the trash row still writes and the record stays restorable — but isSideDoorTombstoneCaptureEnabled() is false, so inbound-edge capture is DEGRADED (zero inbound tombstones; restored records report inboundEdgesRecoverable:false). This STOPs in BOTH default and --strict modes (an unconditional rollout-policy stop, like the other two illegal combos) so an operator does not half-enable D-2 — not because the code forbids the combination.",
      },
    ],
  },
  {
    key: 'MULTITABLE_META_REVISION_RETENTION_ENABLED',
    type: 'boolean',
    activationValue: '1',
    dependsOn: [],
    conflictsWith: ['MULTITABLE_ENABLE_SHEET_REVERT', 'MULTITABLE_ENABLE_PIT_RESET'],
    danger: 'high',
    purpose:
      'R4 — activation value is the EXACT string \'1\', NOT \'true\' (unlike every capture/replay/revert flag above). resolveMetaRevisionRetentionConfig() compares with `=== \'1\'`; setting \'true\' here is a silent no-op (retention stays disabled) — the single biggest operator footgun in this manifest. When active, ages meta_record_revisions AND meta_config_revisions (same knob set governs both, T9 D4) and makes both exact-anchor Revert and PIT Reset refuse after auth/full-read but before trust/anchor/reconstruction work (see MULTITABLE_ENABLE_SHEET_REVERT and MULTITABLE_ENABLE_PIT_RESET). Also caps how far back 4c-1/4c-3 recovery can reach once tombstones age out — field-value tombstones have NO retention floor (link-tombstones referenced by a surviving trash row do; field-value ones do not), a ratified, accepted boundary (owner decision, not a bug).',
    // source: packages/core-backend/src/multitable/meta-revision-retention.ts:60
    source: 'packages/core-backend/src/multitable/meta-revision-retention.ts:60',
  },
  {
    key: 'MULTITABLE_META_REVISION_RETENTION_POLICY',
    type: 'enum',
    activationValue: "'keep-days' selects days-based aging; anything else (incl. unset) = 'keep-last-n'",
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      "Retention policy selector. Only the literal string 'keep-days' selects days-based aging; ANY other value (including unset) selects 'keep-last-n' (the default). No-op unless MULTITABLE_META_REVISION_RETENTION_ENABLED='1'.",
    // source: packages/core-backend/src/multitable/meta-revision-retention.ts:62-63
    source: 'packages/core-backend/src/multitable/meta-revision-retention.ts:62-63',
  },
  {
    key: 'MULTITABLE_META_REVISION_RETENTION_KEEP_N',
    type: 'numeric',
    activationValue: 'numeric (default 200; floored at 10)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'keep-last-n policy: versions retained per record. Default 200, floored at 10 (a mis-set value cannot gut history below the floor). No-op unless retention is active and policy=keep-last-n (the default policy).',
    // source: packages/core-backend/src/multitable/meta-revision-retention.ts:33-34,64-69
    source: 'packages/core-backend/src/multitable/meta-revision-retention.ts:33-34,64-69',
  },
  {
    key: 'MULTITABLE_META_REVISION_RETENTION_DAYS',
    type: 'numeric',
    activationValue: 'numeric (default 365; floored at 30)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'keep-days policy: retention window in days. Default 365, floored at 30. No-op unless retention is active and POLICY=keep-days.',
    // source: packages/core-backend/src/multitable/meta-revision-retention.ts:36-37,70-75
    source: 'packages/core-backend/src/multitable/meta-revision-retention.ts:36-37,70-75',
  },
  {
    key: 'MULTITABLE_META_REVISION_RETENTION_BATCH',
    type: 'numeric',
    activationValue: 'numeric (default 5000; floored at 1)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Per-pass DELETE row cap for the revision-retention sweep (drains a backlog over ticks instead of one long statement). Default 5000, floored at 1.',
    // source: packages/core-backend/src/multitable/meta-revision-retention.ts:39,76-78
    source: 'packages/core-backend/src/multitable/meta-revision-retention.ts:39,76-78',
  },
  {
    key: 'MULTITABLE_META_REVISION_RETENTION_INTERVAL_MS',
    type: 'numeric',
    activationValue: 'numeric ms (default/ceiling 86400000 = 24h; floored at 60000 = 60s)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Scheduler tick interval for the retention janitor. Default and ceiling 24h (86400000ms), floor 60000ms (60s) — an out-of-range value is clamped, not rejected.',
    // source: packages/core-backend/src/multitable/meta-revision-retention.ts:311,314-316,342
    source: 'packages/core-backend/src/multitable/meta-revision-retention.ts:311,314-316,342',
  },
  {
    key: 'MULTITABLE_NOTIFICATION_RETENTION_DAYS',
    type: 'numeric',
    activationValue: 'numeric days (UNSET = OFF; 1..3650 turns it on)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'Retention window (days) for the notification-centre sweep on meta_record_subscription_notifications. DEFAULT OFF: unset / empty / blank / a string that Number() cannot parse into a finite value / <=0 (and anything below 1 whole day) resolves to null and the janitor never starts (zero SQL) — this flag is the ON switch. Parsing is Number(), NOT a decimal-only parse, so JS numeric literals count as numeric and DO turn it on: "0x1e" reads as 30 days and "1e3" as 1000 days. Set to N (clamped to 3650) and rows older than N days are DELETEd, READ AND UNREAD ALIKE (owner default; a "read-only" variant would need an extra read_at predicate in the delete SQL). Deletion is permanent and there is no leader lock, so every instance sweeps.',
    // source: packages/core-backend/src/multitable/notification-retention.ts#MULTITABLE_NOTIFICATION_RETENTION_DAYS (resolveNotificationRetentionDays + the null ⇒ no-op early return in startNotificationRetention)
    source:
      'packages/core-backend/src/multitable/notification-retention.ts#MULTITABLE_NOTIFICATION_RETENTION_DAYS',
  },
  {
    key: 'MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS',
    type: 'numeric',
    activationValue: 'numeric ms (default 86400000 = 24h; clamped to [10000, 604800000])',
    dependsOn: ['MULTITABLE_NOTIFICATION_RETENTION_DAYS'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Tick cadence for the notification-centre retention janitor. Default 24h; an in-range value is clamped to [10s, 7d]; unset / empty / blank / non-numeric / <=0 falls back to the 24h default (it is NOT clamped up to the 10s floor). Inert unless MULTITABLE_NOTIFICATION_RETENTION_DAYS turns the janitor on.',
    // source: packages/core-backend/src/multitable/notification-retention.ts#MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS (resolveNotificationRetentionIntervalMs)
    source:
      'packages/core-backend/src/multitable/notification-retention.ts#MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS',
  },
  {
    key: 'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true, // isContiguityStrictMode(): `.trim().toLowerCase() === 'true'`
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      'W0-1 v3.7 §9.3 — STRICT chain-integrity mode: the exact-seq, ALL-generations, C3 deleted-chain contiguity precheck for destructive Revert/Reset. Default OFF; flag-off is byte-identical to #4269. Gating this ON is the trust-substrate correctness switch, NOT an ops convenience.',
    // source: packages/core-backend/src/multitable/history-integrity-precheck.ts:99-100 (isContiguityStrictMode)
    source: 'packages/core-backend/src/multitable/history-integrity-precheck.ts:100,459',
    // P3-2 FLAG-ON PRECONDITION (design lock §3/§9; L5). This flag — and later Revert/Reset enablement — MUST
    // NOT be relied upon for a sheet unless BOTH: (a) an ACTIVE trust checkpoint exists for the sheet, AND
    // (b) reconstruction causality is satisfied. The MECHANISM for (b) landed with Lane L6-b (the causal
    // reconstructRecordsAtSeq, seq-anchored), and RECONSTRUCTION_CAUSALITY_LANDED flips true in W2's SAME
    // reviewable change that wires legacy Revert/Reset onto the L8 exact-anchor apply (owner ruling
    // 2026-07-17). A checkpoint-bearing sheet can therefore pass this code precondition; gating the strict
    // flag ON remains the operator's separate default-OFF decision ("migration/backfill presence alone never
    // enables recovery"). WIRED
    // (L5 P2): enforced by checkStrictEnablementPrecondition, CALLED from precheckSheetHistoryIntegrity's
    // strict branch (the authoritative strict-mode entry the Revert/Reset routes traverse). The refusal is
    // UNCONDITIONAL on !canEnable (owner P2, 2026-07-16 — an earlier scope-seam exemption for no-checkpoint
    // sheets was a production bypass and is REMOVED); goldens that need the comparator call the exported
    // precheckSheetHistoryIntegrityStrict directly. Do not weaken it to pass. (Not modeled as a cross-flag
    // rule: conditions (a)/(b) are runtime STATE, not other flag env values.)
    enablementPrecondition:
      'L5/P3-2 (checkStrictEnablementPrecondition): requires (a) an active meta_history_trust_checkpoints row for the sheet AND (b) RECONSTRUCTION_CAUSALITY_LANDED. W2 flips the seam true in the same reviewable change that wires legacy Revert/Reset onto the L8 exact-anchor apply (owner ruling 2026-07-17). Checkpoint-less sheets still refuse; checkpoint-bearing sheets can pass this code precondition. The flag itself stays the operator decision (default OFF).',
    enablementPreconditionSource:
      'packages/core-backend/src/multitable/history-trust-precondition.ts (RECONSTRUCTION_CAUSALITY_LANDED, evaluateStrictEnablementPrecondition, checkStrictEnablementPrecondition)',
    enablementEnforcedVia:
      'packages/core-backend/src/multitable/history-integrity-precheck.ts precheckSheetHistoryIntegrity (strict branch) — refuses strict_enablement_unmet UNCONDITIONALLY when canEnable is false (no no-checkpoint exemption)',
  },
  {
    key: 'ELEARNING_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'Master gate for the elearning V0.1 named pilot (video upload → viewing verification → objective exam → automatic grading). Default OFF; exact literal \'true\' only. Session feature `elearning` is this flag and is never inferred from admin role, product mode, or plugin state.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:28-30',
  },
  {
    key: 'ELEARNING_NOTIFICATIONS_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED', 'ELEARNING_CONTENT_ENABLED'],
    conflictsWith: [],
    danger: 'high',
    purpose: 'Opt-in personal learning reminders. Default OFF; exact true only. Unknown external outcomes are fenced, never blindly retried.',
    source: 'packages/core-backend/src/services/elearning-notification-dispatch.ts#isElearningNotificationDispatchEnabled',
  },
  {
    key: 'ELEARNING_CONTENT_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'E-learning content capability gate. Default OFF; exact literal \'true\' only. Independent env read; product surface still requires ELEARNING_ENABLED.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:21-26',
  },
  {
    key: 'ELEARNING_ASSIGNMENT_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'E-learning assignment capability gate. Default OFF; exact literal \'true\' only. Independent env read; product surface still requires ELEARNING_ENABLED.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:21-26',
  },
  {
    key: 'ELEARNING_ASSESSMENT_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'E-learning assessment capability gate. Default OFF; exact literal \'true\' only. Independent env read; product surface still requires ELEARNING_ENABLED.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:21-26',
  },
  {
    key: 'ELEARNING_INCENTIVE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'E-learning incentive capability gate. Default OFF; exact literal \'true\' only. Independent env read; product surface still requires ELEARNING_ENABLED.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:21-26',
  },
  {
    key: 'ELEARNING_ANALYTICS_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'E-learning analytics capability gate. Default OFF; exact literal \'true\' only. Independent env read; product surface still requires ELEARNING_ENABLED.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:21-26',
  },
  {
    key: 'ELEARNING_MEDIA_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'E-learning media capability gate. Default OFF; exact literal \'true\' only. Independent env read; product surface still requires ELEARNING_ENABLED.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts:21-26',
  },
  {
    key: 'ELEARNING_WATCH_CHALLENGE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [
      'ELEARNING_ENABLED',
      'ELEARNING_CONTENT_ENABLED',
      'ELEARNING_MEDIA_ENABLED',
    ],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'L6 watch-challenge gate. Default OFF; exact literal \'true\' only. The route and runtime additionally require the master, content, and media gates, and disabled mode remains byte-compatible with ordinary verified watch progress.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts#ELEARNING_WATCH_CHALLENGE_ENABLED',
  },
  {
    key: 'ELEARNING_ENROLLMENT_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [
      'ELEARNING_ENABLED',
      'ELEARNING_CONTENT_ENABLED',
    ],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Online self-study enrollment gate. Default OFF; exact literal \'true\' only. Enrollment records learner intent but never grants course access or creates assignment effects.',
    source: 'packages/core-backend/src/elearning/feature-flags.ts#ELEARNING_ENROLLMENT_ENABLED',
  },
  {
    key: 'ELEARNING_AUDIENCE_SCAN_TIMEOUT_MS',
    type: 'numeric',
    activationValue: 'numeric ms (default 5000; unset / blank / anything but a plain integer 0..2147483647 after trimming = 5000; 0 = no scan timeout; any other value is clamped to DB_QUERY_TIMEOUT (pool client-side query timeout, default 30000) minus 1000 ms, so the server cancels before the pg client timer does)',
    dependsOn: ['ELEARNING_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      "Issue #6175: statement timeout for the e-learning audience catalog scan (listElearningAudienceCourseMatches, the self-study half of GET /api/elearning/me/courses). The scan reads every active scope rule of the org before the 10,000-rule cap applies, and stale planner statistics right after a bulk import can make one scan take tens of seconds. Applied as a transaction-local setting (set_config(..., true), the function form of SET LOCAL) for that one statement inside the learner-list transaction, and put back right after the scan; it never stays on the pooled connection. Read on every scan: a plain integer of milliseconds from 0 to 2147483647 after trimming; unset, blank, negative, decimal, exponent, hex or signed values fall back to 5000. 0 = no scan timeout: no statement is issued and the connection's own statement_timeout (DB_STATEMENT_TIMEOUT for the main pool) applies as before. On query_canceled (SQLSTATE 57014) the scan is not retried, one values-free warn line `elearning_audience_scan_canceled` {orgId, scanTimeoutMs} is logged, and the route answers 503 {error: 'unavailable'} like every other audience failure. Not a gate: nothing turns on or off, and the default is the intended state. danger=low: too low a value makes the learner course list answer 503 on large catalogs; a value above the connection's own statement_timeout raises the server-side bound for this one statement. No-op unless the e-learning surface is mounted (ELEARNING_ENABLED).",
    source: 'packages/core-backend/src/services/elearning-audience-resolver.ts#resolveElearningAudienceScanTimeoutMs',
  },
  {
    key: 'DINGTALK_TODO_MIRROR_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'Master gate for the DingTalk approval-todo ONE-WAY mirror (plan B, #5772/#5768). Default OFF; exact literal \'true\' only (isDingTalkTodoMirrorEnabled: String(env).trim().toLowerCase() === \'true\'). The sink (both the live eventBus leg and the durable consumer leg) checks this flag FIRST and writes nothing to dingtalk_todo_mirrors when it is off — both legs stay inert. The delivery WORKER (the only code that talks to the DingTalk API) is additionally gated: it is only ever constructed/started in index.ts when this flag is on AND NODE_ENV!==\'test\' AND !VITEST. Danger=medium, not high: an outbound convenience with its own idempotent ledger (ON CONFLICT DO NOTHING on org_id+source_key) — a missing/misconfigured mirror loses no platform state (the durable consumer keeps ACKing regardless).',
    source: 'packages/core-backend/src/integrations/dingtalk/todo-mirror-flag.ts:20,23; packages/core-backend/src/services/dingtalk-todo-mirror-service.ts:15; packages/core-backend/src/services/dingtalk-todo-mirror-worker.ts:25; packages/core-backend/src/index.ts:3924,3943,3959',
  },
  {
    key: 'DINGTALK_TODO_MIRROR_INTERVAL_MS',
    type: 'numeric',
    activationValue: 'numeric ms (default 30000 = 30s; floored at 5000 = 5s via Math.max)',
    dependsOn: ['DINGTALK_TODO_MIRROR_ENABLED'],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Poll interval for the DingTalk todo-mirror delivery worker\'s setInterval tick (runBatch). Number(process.env...) || 30_000 then Math.max(5_000, ...): an unset/blank/non-numeric value falls back to the 30s default, and any in-range or larger value is honoured verbatim — only a value below 5000 gets clamped up to the 5s floor. No-op unless DINGTALK_TODO_MIRROR_ENABLED is active (the worker is never constructed otherwise).',
    source: 'packages/core-backend/src/index.ts:3948',
  },
  {
    key: 'MULTITABLE_BUSINESS_TIMEZONE',
    type: 'enum',
    activationValue: "an IANA timezone id, e.g. 'Asia/Shanghai' (trimmed); unset / blank / any id Intl rejects = 'Asia/Shanghai'",
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      "客户反馈 2026-09-24 #4c (ruling PR #6074): the instance business timezone multitable date-times are DISPLAYED and PARSED in on the web — never the browser's local zone. Storage is unchanged (UTC instants); only the wall clock a person sees/types changes. Echoed as `businessTimezone` on GET /api/multitable/context and /form-context; a dateTime field's own non-UTC property.timezone still wins. Not a gate: nothing turns on or off, and the default (Asia/Shanghai) is the intended state for a China deployment, so leaving it unset needs no action. An invalid value is logged once (without echoing it) and falls back to the default.",
    source: 'packages/core-backend/src/multitable/business-timezone.ts#resolveMultitableBusinessTimezone',
  },
  {
    key: 'MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      "客户反馈 2026-09-24 #4a: operator switch for the WRITE leg of the managed-table display-name relabel (「把系统表的英文表头改成中文」, stock-prep 数据来源与体检). Default OFF; exact literal 'true' only (no trim, no case folding). Off: the dry run still works (it writes nothing), the plugin route answers 409 MANAGED_TABLE_RELABEL_APPLY_DISABLED, and the host primitive itself refuses the write leg (409 MULTITABLE_RELABEL_APPLY_DISABLED) before any statement — enforced at the one place that writes, not only in the route. On: stock-prep:admin (or platform admin) may rename still-English managed-table columns and sheet names to their template Chinese names, compare-and-set, only after a preview whose planDigest the apply must match. Danger=medium: it renames the customer's production managed tables (field renames are revertible from the config history; sheet renames are recorded but not revertible there), and while an apply runs, record inserts to that sheet wait for it to commit.",
    source: 'packages/core-backend/src/multitable/object-display-name-relabel.ts#isManagedTableRelabelApplyEnabled',
  },
  {
    key: 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      "一个项目一张备料表 (ADR adr-stock-prep-project-sheets-20261008, register R-35, slice S1): the operator switch for per-project stock-preparation sheets. Default OFF; exact literal 'true' only (no trim, no case folding), read PER REQUEST (no restart). Off: the three project-sheet routes (GET/POST …/projects/:projectNo/target, GET …/project-targets) answer 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED with zero IO, and every table-action route resolves the deployment env `action.target` byte for byte as before S1. On: (1) a 拉取人员 (stock-prep:pull) may CREATE one managed sheet per business project from the frozen template through the POST route — the named R-11 exception — with the objectId and sheet id derived server-side, an empty closed body, a 200-row-per-tenant cap and an audit row; (2) every stock-prep read and write (dry-run, apply, large-BOM, reconcile, mvp-persist, conflict-policies, carry, export, handoff advance, board) resolves its SHEET from the project registry (migration 087) by projectNo instead of from the env target — an unregistered project is 409 STOCK_PREPARATION_PROJECT_ABSENT, an archived one 409 STOCK_PREPARATION_PROJECT_ARCHIVED on writes, and conflict-policies without ?projectNo= is 400; (3) the tenant wall runs on the resolved sheet on routes that never ran it before; (4) the apply sandbox gate admits the registered project sheet only while the deployment's own env target objectId is already allowlisted (Q6: inherits the sandbox authorization, cannot widen it). Danger=high: it CREATES managed tables on the customer's instance (one per project, capped) and it CHANGES WHERE PULLS WRITE. Switching it off again does NOT restore pre-S1 behaviour for a deployment whose projects were pulled into project sheets: every route goes back to the old mixed env sheet, where #5860's one-sheet-one-project guard refuses every project but one (ADR §8: 关开关 = 停用拉取). The project sheets and their data stay; switching back on restores them. PRECONDITION (fix round 1, 2026-10-09): the switch must NOT be turned on before slice S2 — the customer-pack reinstall onto the project sheets and the manifest controls for the three routes — is merged; four known limitations are recorded in register R-35.",
    source: 'plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs#stockPreparationProjectSheetsEnabled',
  },
  {
    key: 'MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS',
    type: 'list',
    activationValue:
      'comma-separated role ids, each `stock-prep` or `stock-prep_<x>` and existing (trimmed, de-duplicated); UNSET/EMPTY ⇒ no grant is written (G2: an admin grants by hand)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      "一个项目一张备料表 G1 (ADR §2 Q7, addendum A.6, register R-35): the SERVER-CONFIGURED roles that receive `spreadsheet:write` on every project sheet at create time (and on an idempotent create replay), through the host's narrow grant port (multitable/plugin-scope.ts grantSheetRoleWrite → services/stock-preparation-project-sheet-grants.ts). Without it a 拉取人员 creates a sheet the floor cannot open (no grant row, no global multitable:read). Bounded by the host, not by this value: role subjects only, every id inside the `stock-prep` role namespace and existing (a foreign or unknown role refuses the whole grant), the level is the literal spreadsheet:write (never read — intersection mode would lock the floor out of entering values — never admin), ADD-ONLY (ON CONFLICT DO NOTHING, no revoke, no downgrade), only on a sheet the plugin object registry records as this plugin's and this project's with the project-sheet objectId shape; every landed grant that changes the role's level writes a meta_config_revisions row (a role already holding admin gets the write row and no history row). Only read while MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED is on (the create route is 404 otherwise), but NOT modeled as dependsOn: isActivated() is false for every non-boolean spec, so a requires rule keyed off this list would never fire and would only mislead a reader of the status line. Danger=high: it is an authorization write — table-level spreadsheet:write also opens field and view management on that one sheet (the level the floor already holds on today's sheet; ADR §11.7 records the cost).",
    source: 'plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs#resolveProjectSheetGrantRoleIds',
  },
  {
    key: 'MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS',
    type: 'numeric',
    activationValue: 'numeric row count (default 2000; unset / blank / non-integer / < 1 = 2000; capped at 50000 = XLSX_MAX_ROWS)',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      "「复制数据表（含数据）」(design-lock ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md CS-15 / §7.5): the SYNCHRONOUS copy row cap N. A source sheet with more than N live rows is refused 413 COPY_TOO_LARGE before any write (the S3 async job is the path above N and is not built yet). Number(env) parsed once per request via resolveCopySheetSyncMaxRows: unset/blank/non-integer/<1 fall back to 2000, anything above 50000 is clamped to 50000 (the ADR's absolute ceiling, = XLSX_MAX_ROWS). Not a gate: nothing turns on or off; the default covers the customer table (1239 rows). Raising it lengthens one synchronous transaction that holds the source sheet row lock + every participating sheet fence for its duration.",
    source: 'packages/core-backend/src/multitable/copy-sheet-limits.ts#resolveCopySheetSyncMaxRows',
  },
  {
    key: 'TASKS_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    // ASSUMPTION(task-m4): [own-28] danger raised from low: turning this on now depends on a
    // migration that is not applied yet. The purpose names all four route prefixes it mounts.
    danger: 'medium',
    purpose:
      'Mounts the task routes: /api/tasks (P0-A/P0-B), /api/task-settings, /api/task-lists and /api/task-groups (M4). Default OFF; the router factory returns null unless the value is the exact string true, so disabled mode registers none of them. An identical exact-true predicate (packages/core-backend/src/tasks/feature-flag.ts#isTasksEnabled, pinned equal to the mount check by tests/unit/tasks-feature-flag.test.ts) sets the session feature `tasks`: while OFF the web client shows no 任务 top-bar entry or pending badge, /tasks redirects to the home path, and the web client issues no /api/tasks request (with the build-time development feature override off, as in production builds). Since M4 PR-3a the task routes read task_list_items, task_list_members and task_user_settings, so any environment that sets this to true must have the M4 migration (zzzz20261009130000_create_task_m4_tables) applied; without it the task routes answer 500.',
    source: 'packages/core-backend/src/routes/tasks.ts#tasksRouter; packages/core-backend/src/tasks/feature-flag.ts#isTasksEnabled',
  },
  {
    key: 'APPROVAL_CC_UNREAD_BADGE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      "Test report 2026-10-08 T3 (being CC'd shows no prompt). Default OFF; exact literal 'true' only (no trim, no case folding). On: the approval center's 抄送我的 tab shows an unread-CC badge and a per-row dot, from GET /api/approvals/cc-unread-count and the list's per-row ccUnread, both built on one predicate: unread when the viewer has no approval_reads row at or after the newest CC row targeting them. Off: that endpoint answers 404 APPROVAL_CC_UNREAD_BADGE_DISABLED before any query, the list issues no extra query and its rows carry no new key, and the web (session feature approvalCcUnreadBadge) issues no count request. No DDL, no new realtime event, nothing added to the pending/todo counts or their socket events (todo-center lock B). Rollout effect, an owner choice at enablement: historical CC rows count by the same rule, so on the first load every CC a person was never shown since it arrived counts as unread. danger=low: read-only; one count query per approval-center load or tab switch and one id-scoped query per 抄送我的 page.",
    source: 'packages/core-backend/src/services/approval-notify-badge-flags.ts#isApprovalCcUnreadBadgeEnabled',
  },
  {
    key: 'APPROVAL_MINE_OUTCOME_BADGE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      "Test report 2026-10-08 T6 (a requester gets no prompt when their request is rejected). Default OFF; exact literal 'true' only (no trim, no case folding). On: the approval center's 我发起的 tab shows a new-outcome badge and a per-row dot, from GET /api/approvals/mine-outcomes/unseen-count and the list's per-row outcomeUnseen, both built on one predicate: the viewer's own request is in a terminal status, the newest audit row that moved it into that status was written by someone else, and the viewer has no approval_reads row at or after that row. Self-decided outcomes (own withdrawal, own rejection or approval) are never badged. Off: that endpoint answers 404 APPROVAL_MINE_OUTCOME_BADGE_DISABLED before any query, the list issues no extra query and its rows carry no new key, and the web (session feature approvalMineOutcomeBadge) issues no count request. No DDL, no new realtime event (a requester receives no frame when someone else decides; the badge refreshes on the next load or tab switch), nothing added to the pending/todo counts or their socket events (todo-center lock B). Rollout effect, an owner choice at enablement: historical outcomes count by the same rule, so on the first load every finished request whose outcome its requester never opened afterwards counts as new. danger=low: read-only; one count query per approval-center load or tab switch and one id-scoped query per 我发起的 page.",
    source: 'packages/core-backend/src/services/approval-notify-badge-flags.ts#isApprovalMineOutcomeBadgeEnabled',
  },
  {
    key: 'STOCK_PREP_MEMBERS_PAGE_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      "备料「成员与权限」(ADR adr-stock-prep-project-sheets-20261008 §11.4–11.6, slice S5b, register R-39): the operator switch for the /stock-prep workbench's members page. Default OFF; exact literal 'true' only (no trim, no case folding), read PER REQUEST by the four plugin routes (…/stock-preparation/members, …/members/custom-roles, …/members/custom-roles/:roleId, …/members/custom-roles/:roleId/project-targets) AND by the host's narrow members port (packages/core-backend/src/services/stock-preparation-members.ts#stockPrepMembersPageEnabled), each of which answers 404 STOCK_PREP_MEMBERS_PAGE_DISABLED before any IO while it is off — after the plugin's WORKBENCH_ADMIN gate. Off, the web hides the 「成员与权限」 rail item and guards its ?tab=members deep link (both follow the read's answer), so the page is invisible. On: a platform admin or the ADMITTED stock-prep delegated admin (role stock-prep_admin with a stock-prep department / member-group scope; otherwise 403, or 403 ROLE_DELEGATION_SCOPE_REQUIRED) may create and edit server-generated stock-prep_c_<8 hex> roles carrying only stock-prep:read / :operate / :pull (any other code 400; never stock-prep:admin; never an _admin id or a built-in), within the grantor's own current codes (and, for a delegated admin, only while every member of the role is inside their delegated scope; at most 100 custom roles), and add project sheets of their own tenant to such a role through the G1 grant port (add-only, spreadsheet:write, only sheets the grantor can fully write; the project-sheet add also needs MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED, not modeled as dependsOn because the other three routes do not need it). Every change writes an audit row in the admin-users delegation shape. Appoint / revoke / admission use the existing /api/admin/role-delegation routes regardless of this switch. Danger=high: authorization writes (roles, role_permissions, sheet grants) by a non-platform administrator. Locking while ON (owner ruling 2026-10-10, lock only the role being written): there is NO table lock — a custom-role write locks the custom role's own row FOR UPDATE (a create takes a stock-prep-only advisory lock instead, for the 100-role cap) plus FOR SHARE on the grantor's own authority rows (memberships, role codes, direct codes, member groups, admission, delegation scope and, for a project-sheet add, their existing grants on the named sheets); every wait is bounded by a 5 s lock_timeout and every in-lock check runs on the transaction's own connection. user_roles writes for any other role are unaffected; a delegated appointment to the role being written waits for that write and then reviews its committed codes. A project-sheet add runs its G1 calls under those locks, each with the same 5 s lock_timeout, starts no further call after a 15 s budget (409 STOCK_PREP_MEMBERS_BUSY, retryable — the grant is idempotent) and runs one at a time per server process.",
    source: 'plugins/plugin-integration-core/lib/stock-preparation-members.cjs#stockPrepMembersPageEnabled',
  },
  {
    key: 'VITE_MULTITABLE_RANGE_FILL_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    danger: 'low',
    purpose:
      'Opt-in UI gate for multitable rectangular copy and fill. Default OFF; enabled only by the exact build-time string true.',
    source: 'apps/web/src/multitable/utils/grid-range-fill-flags.ts#isGridRangeFillEnabled',
  },
  {
    key: 'ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED',
    type: 'boolean',
    activationValue: 'true',
    dependsOn: [],
    conflictsWith: [],
    // PROPOSED, pending the owner's choice (reviewer finding F3, 2026-10-08): medium because ON lets an
    // employee start a cancellation that, once approved, cancels the leave and returns its balance.
    danger: 'medium',
    purpose:
      "Leave cancel-round product entry (approval change-request lock C v5.9, entry addendum P-1…P-11): the LAUNCH gate of POST /api/attendance/requests/:id/cancel-round, read by the attendance plugin (not by packages/core-backend/src). Default OFF; exact literal 'true' only (no trim, no case folding; '1' / 'yes' / 'TRUE' stay OFF — unlike the plugin's older env flags, it does NOT go through parseBoolean). Off: the launch answers the same 404 body as a never-existing request id, before any read or write. It gates ONLY the launch: the summary read (which reports this flag's state as entryEnabled), the approver decision, the requester's withdraw and the attendance-side pending list are not flag-gated, so a round launched while ON can still be read, decided and withdrawn after it is switched OFF. Read on every call, never cached at module load. danger=medium (PROPOSED, owner to confirm): ON lets an employee start a cancellation of their own approved leave; once the original approvers approve it, the leave is cancelled and its leave balance returned.",
    source: 'plugins/plugin-attendance/index.cjs#isAttendanceCancelRoundEntryEnabled',
  },
])

/** Flat lookup by key, built once. */
export const GLOBAL_HISTORY_FLAG_BY_KEY = Object.freeze(
  Object.fromEntries(GLOBAL_HISTORY_FLAG_MANIFEST.map((spec) => [spec.key, spec])),
)

export const GLOBAL_HISTORY_FLAG_KEYS = Object.freeze(GLOBAL_HISTORY_FLAG_MANIFEST.map((spec) => spec.key))

/**
 * Whether `rawValue` (the literal env string, possibly undefined/null) ACTIVATES `spec` per the exact
 * source-verified comparison for that flag. Numeric/enum specs have no single activation value — this
 * only applies to boolean specs.
 */
export function isActivated(spec, rawValue) {
  if (spec.type !== 'boolean') return false
  const value = String(rawValue ?? '')
  if (spec.caseInsensitive) return value.trim().toLowerCase() === spec.activationValue
  return value === spec.activationValue
}

/**
 * True when `rawValue` is "truthy-looking" (a human would plausibly read it as "on") but does NOT match
 * the exact activation string for this flag — the R4 footgun made visible per-flag instead of globally.
 * Covers both directions: retention='true' (should be '1') and PIT_RESET='1' (should be 'true').
 */
const PLAUSIBLE_TRUE_STRINGS = new Set(['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON'])
export function isMisconfiguredTruthy(spec, rawValue) {
  if (spec.type !== 'boolean') return false
  const value = String(rawValue ?? '')
  if (value === '') return false
  if (isActivated(spec, rawValue)) return false
  return PLAUSIBLE_TRUE_STRINGS.has(value.trim())
}

/**
 * Parse a `list`-typed flag value into its ENTRY COUNT — never into the entries themselves.
 *
 * Semantics are deliberately identical to the in-process parser these flags are read by:
 * `resolveTrustCheckpointSheetAllowlist` (packages/core-backend/src/multitable/trust-checkpoint-activation-authz.ts)
 * — split on `,`, trim each entry, drop empty entries. So `''`, `','`, `' , , '` and an absent
 * variable all count 0 (the fail-closed "nothing designated" state), while `'a,,b'` and `' a , b '`
 * both count 2. `countListEntries` is exported so a test can pin those cases against the same table
 * the TypeScript parser's unit suite uses; if the two ever diverge, the operator's count would stop
 * describing what the route actually honours.
 */
export function countListEntries(rawValue) {
  if (typeof rawValue !== 'string') return 0
  return rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length
}

/**
 * The operator-visible rendering of a flag's observed value — the ONLY form that may be printed or
 * serialized by the status helper.
 *
 * Keyed off `spec.type`, never off a flag NAME: a `list` flag's value is a set of IDENTIFIERS (today,
 * the designated trust-checkpoint canary sheet ids), and broadcasting designated-canary identity is
 * not an ops status tool's job — the ladder's L2-C rung designates a named synthetic sheet precisely
 * so that scope stays owner-held. A count-only form still answers the operator's actual question,
 * "is a canary DESIGNATED or not" (0 vs N), and it is what the fail-closed refusal keys off.
 *
 * All of unset / '' / ',' / '   ' collapse to `set(count=0)` on purpose: they are behaviourally
 * IDENTICAL (every one of them refuses activation for every sheet), so distinguishing them on the
 * status line would invite reading "(absent)" as "the restriction is not in force".
 *
 * Every other type keeps its raw value verbatim — boolean/numeric/enum values ARE the operator's
 * signal ('true' / '1' / a row cap) and carry no identifiers. Unobserved non-list flags keep the
 * pre-existing `(absent)` marker.
 */
export function renderFlagValueForOperator(spec, rawValue) {
  if (isValueRedactedType(spec)) return `set(count=${countListEntries(rawValue)})`
  return rawValue ?? '(absent)'
}

/**
 * The SINGLE definition of "this flag's observed value may not be printed verbatim", stated over the
 * manifest's TYPE taxonomy rather than over a name list. Today that is exactly `list`; registering a
 * second list-typed flag inherits the redaction with no further edit, and a name-keyed guard (the
 * #1882 failure class — "redaction that matches key names only") is structurally impossible here.
 */
export function isValueRedactedType(spec) {
  return Boolean(spec) && spec.type === 'list'
}

/**
 * Evaluate every `requires`/`requires-exact`/`conflicts` rule in the manifest against a flat env-like flag map
 * (`{ [key]: string | null | undefined }`). Returns a list of violations; empty = no illegal
 * combination present. `requires-exact` compares the dependency's raw value with its
 * activationValue; other rules use per-flag activation via `isActivated`.
 */
export function evaluateFlagRules(flags) {
  const violations = []
  for (const spec of GLOBAL_HISTORY_FLAG_MANIFEST) {
    const rules = spec.rules || []
    for (const rule of rules) {
      if (rule.kind === 'requires' || rule.kind === 'requires-exact') {
        const selfOn = isActivated(spec, flags[spec.key])
        if (!selfOn) continue
        const unmet = spec.dependsOn.filter((depKey) => {
          const depSpec = GLOBAL_HISTORY_FLAG_BY_KEY[depKey]
          return depSpec && (rule.kind === 'requires-exact'
            ? flags[depKey] !== depSpec.activationValue
            : !isActivated(depSpec, flags[depKey]))
        })
        if (unmet.length > 0) {
          violations.push({
            id: rule.id,
            flag: spec.key,
            description: rule.description,
            missing: unmet,
          })
        }
      } else if (rule.kind === 'conflicts') {
        const selfOn = isActivated(spec, flags[spec.key])
        if (!selfOn) continue
        const active = spec.conflictsWith.filter((otherKey) => {
          const otherSpec = GLOBAL_HISTORY_FLAG_BY_KEY[otherKey]
          return otherSpec && isActivated(otherSpec, flags[otherKey])
        })
        if (active.length > 0) {
          violations.push({
            id: rule.id,
            flag: spec.key,
            description: rule.description,
            conflicting: active,
          })
        }
      }
    }
  }
  return violations
}
