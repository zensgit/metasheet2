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
 * `activationValue` is the EXACT string the flag must equal (after `.trim()`, and after `.toLowerCase()`
 * only when `caseInsensitive: true`) for the gated code path to treat it as ON. Two families exist:
 *   - capture/replay/revert flags compare with `=== 'true'` (case-SENSITIVE, no trim in most call sites,
 *     except PIT_RESET/PIT_UNDELETE/SHEET_REVERT which use `.trim().toLowerCase() === 'true'`)
 *   - the retention flag compares with `=== '1'` (NOT `'true'`) — `meta-revision-retention.ts:60`
 * Setting the wrong string for a given flag is silent: the gated code path stays OFF and nothing errors.
 */

/**
 * @typedef {Object} FlagRule
 * @property {string} kind - 'requires' (dependsOn must ALSO be active) | 'conflicts' (dependsOn/target must NOT be active together)
 * @property {string} id - stable violation id, printed by --strict
 * @property {string} description
 */

/**
 * @typedef {Object} FlagSpec
 * @property {string} key
 * @property {'boolean'|'numeric'|'enum'} type
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
    key: 'MULTITABLE_ENABLE_SHEET_REVERT',
    type: 'boolean',
    activationValue: 'true',
    caseInsensitive: true,
    dependsOn: [],
    conflictsWith: [],
    danger: 'high',
    purpose:
      'Interim revert-execute master gate (current-risk mitigation, owner-directed): first-cut generation-aware integrity checks (#4269) improve the older live-vs-latest precheck, but exact committed-event anchoring, the all-writer fence, trust checkpoints, target-generation validation, and Revert outer-transaction atomicity remain required before destructive recovery is enablement-ready. Therefore revert-execute (bulk-overwrites live record field values back to an anchored state across up to MULTITABLE_SHEET_REVERT_MAX_RECORDS records, and resurrects records deleted after that anchor — that resurrect sub-path additionally requires MULTITABLE_ENABLE_PIT_UNDELETE) stays closed by DEFAULT until the complete W0 trust correction lands and passes staging. Mirrors MULTITABLE_ENABLE_PIT_RESET\'s gate exactly: SAME `String(env).trim().toLowerCase() === \'true\'` resolution (hence caseInsensitive here too, unlike the config-revert family above which compares case-sensitively), same canManageSheetAccess (D2) floor. danger=high for the same reason as PIT_RESET, not the medium config-revert flags above: a whole-sheet-scale destructive bulk write over live record data with no undo. revert-preview stays UNGATED (read-only; the FE preview UI still needs to render even while the button that would call execute is hidden — capabilities.sheetRevertEnabled controls that visibility, same flag-derived-capability pattern as pitResetEnabled).',
    // Source symbols (line numbers intentionally omitted because this route is edited frequently):
    // SHEET_REVERT_ENABLED, the /revert-execute REVERT_DISABLED guard, and capabilities.sheetRevertEnabled.
    source: 'packages/core-backend/src/routes/univer-meta.ts#SHEET_REVERT_ENABLED,/revert-execute,capabilities.sheetRevertEnabled',
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
      'R3 — PIT-reset vs retention STOP-SHIP. T8-2 Reset-to-T (destructive whole-sheet PIT restore). Gated by PIT_RESET_ENABLED() (`.trim().toLowerCase() === \'true\'`, so \'TRUE\'/\' true \' also activate it — unlike most other flags in this manifest). BOTH reset-preview and reset-execute additionally call PIT_RESET_RETENTION_BLOCKED() and refuse with 409 RESET_RETENTION_CONFLICT whenever meta-revision retention is active. An operator who intends to use PIT reset MUST NOT also have retention active.',
    // source: packages/core-backend/src/routes/univer-meta.ts:10275 (PIT_RESET_ENABLED),
    //         :10276 (PIT_RESET_RETENTION_BLOCKED — compares MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'),
    //         :10287,:10328 (both preview and execute call the blocked-check)
    // NOTE: the task brief cited univer-meta.ts:10264 for this; the verified line in this checkout is 10276
    // (small file drift since the brief was written) — same function, same rule, confirmed by symbol name.
    source: 'packages/core-backend/src/routes/univer-meta.ts:10275-10276,10287,10328',
    rules: [
      {
        kind: 'conflicts',
        id: 'pit-reset-intent-with-retention-on',
        description:
          "MULTITABLE_ENABLE_PIT_RESET is active while MULTITABLE_META_REVISION_RETENTION_ENABLED is active ('1') — PIT_RESET_RETENTION_BLOCKED() will refuse every reset-preview and reset-execute call with 409 RESET_RETENTION_CONFLICT. Reset-to-T cannot function in this state.",
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
      'T8-1 PIT undelete-execute (resurrect face). Gated by `.trim().toLowerCase() === \'true\'` — same case-insensitive family as PIT_RESET. Requires canDeleteRecord (never canEditRecord) at execute plus a typed confirm:\'undelete\'. Inbound links are NOT rebuilt by this flag alone (design-lock L4 A) — see MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND for that layer. The undelete face rides INSIDE revert-execute, whose SHEET_REVERT master gate (#4261) is checked FIRST — so undelete requires BOTH gates.',
    // Anchored by SYMBOL NAME (drift-proof, no line numbers): PIT_UNDELETE_ENABLED helper + the undelete
    // sub-gate inside revert-execute; the SHEET_REVERT master gate precedes it at the top of revert-execute.
    source: 'packages/core-backend/src/routes/univer-meta.ts (symbol refs, drift-proof: PIT_UNDELETE_ENABLED helper + the undelete sub-gate inside revert-execute; the SHEET_REVERT master gate precedes it at the top of revert-execute)',
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
    conflictsWith: ['MULTITABLE_ENABLE_PIT_RESET'],
    danger: 'high',
    purpose:
      'R4 — activation value is the EXACT string \'1\', NOT \'true\' (unlike every capture/replay/revert flag above). resolveMetaRevisionRetentionConfig() compares with `=== \'1\'`; setting \'true\' here is a silent no-op (retention stays disabled) — the single biggest operator footgun in this manifest. When active, ages meta_record_revisions AND meta_config_revisions (same knob set governs both, T9 D4) and is read by PIT_RESET_RETENTION_BLOCKED() to refuse PIT reset (see MULTITABLE_ENABLE_PIT_RESET). Also caps how far back 4c-1/4c-3 recovery can reach once tombstones age out — field-value tombstones have NO retention floor (link-tombstones referenced by a surviving trash row do; field-value ones do not), a ratified, accepted boundary (owner decision, not a bug).',
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
    // reconstructRecordsAtSeq, seq-anchored), but RECONSTRUCTION_CAUSALITY_LANDED is DELIBERATELY HELD false
    // (owner ruling 2026-07-17): the seam flips only in the PR that wires legacy Revert/Reset onto the L8
    // exact-anchor apply. Until then strict-on refuses EVERY sheet — checkpoint-bearing included
    // (`reconstruction_non_causal`) — the last code-level fail-closed backstop is RETAINED. Gating the strict
    // flag ON remains the operator's default-OFF decision ("migration/backfill presence alone never enables
    // recovery"). WIRED
    // (L5 P2): enforced by checkStrictEnablementPrecondition, CALLED from precheckSheetHistoryIntegrity's
    // strict branch (the authoritative strict-mode entry the Revert/Reset routes traverse). The refusal is
    // UNCONDITIONAL on !canEnable (owner P2, 2026-07-16 — an earlier scope-seam exemption for no-checkpoint
    // sheets was a production bypass and is REMOVED); goldens that need the comparator call the exported
    // precheckSheetHistoryIntegrityStrict directly. Do not weaken it to pass. (Not modeled as a cross-flag
    // rule: conditions (a)/(b) are runtime STATE, not other flag env values.)
    enablementPrecondition:
      'L5/P3-2 (checkStrictEnablementPrecondition): requires (a) an active meta_history_trust_checkpoints row for the sheet AND (b) RECONSTRUCTION_CAUSALITY_LANDED — DELIBERATELY HELD false (owner ruling 2026-07-17): the causal reconstructor mechanism landed with L6-b, but the seam flips only in the PR that wires legacy Revert/Reset onto the L8 exact-anchor apply. Until then strict-on refuses EVERY sheet (checkpoint-bearing included, reason reconstruction_non_causal) — the fail-closed backstop is retained. The flag itself stays the operator decision (default OFF).',
    enablementPreconditionSource:
      'packages/core-backend/src/multitable/history-trust-precondition.ts (RECONSTRUCTION_CAUSALITY_LANDED, evaluateStrictEnablementPrecondition, checkStrictEnablementPrecondition)',
    enablementEnforcedVia:
      'packages/core-backend/src/multitable/history-integrity-precheck.ts precheckSheetHistoryIntegrity (strict branch) — refuses strict_enablement_unmet UNCONDITIONALLY when canEnable is false (no no-checkpoint exemption)',
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
 * Evaluate every `requires`/`conflicts` rule in the manifest against a flat env-like flag map
 * (`{ [key]: string | null | undefined }`). Returns a list of violations; empty = no illegal
 * combination present. Uses EXACT per-flag activation (via `isActivated`), never the loose
 * "looks truthy" heuristic, so it cannot be fooled by the R4 footgun in either direction.
 */
export function evaluateFlagRules(flags) {
  const violations = []
  for (const spec of GLOBAL_HISTORY_FLAG_MANIFEST) {
    const rules = spec.rules || []
    for (const rule of rules) {
      if (rule.kind === 'requires') {
        const selfOn = isActivated(spec, flags[spec.key])
        if (!selfOn) continue
        const unmet = spec.dependsOn.filter((depKey) => {
          const depSpec = GLOBAL_HISTORY_FLAG_BY_KEY[depKey]
          return depSpec && !isActivated(depSpec, flags[depKey])
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
