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
 *     except PIT_RESET/PIT_UNDELETE which use `.trim().toLowerCase() === 'true'`)
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
 * @property {boolean} [caseInsensitive] - true only for the two flags whose source call site lowercases+trims
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
    dependsOn: [],
    conflictsWith: [],
    danger: 'medium',
    purpose:
      'T8-1 PIT undelete-execute (resurrect face). Gated by `.trim().toLowerCase() === \'true\'` — same case-insensitive family as PIT_RESET. Requires canDeleteRecord (never canEditRecord) at execute plus a typed confirm:\'undelete\'. Inbound links are NOT rebuilt by this flag alone (design-lock L4 A) — see MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND for that layer.',
    // source: packages/core-backend/src/routes/univer-meta.ts:10071
    source: 'packages/core-backend/src/routes/univer-meta.ts:10071',
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
    // source: packages/core-backend/src/multitable/restore-caps.ts:6 (SHEET_REVERT_DEFAULT_MAX_RECORDS=5000), :8-10 (resolveSheetRevertMaxRecords);
    //         consumed at packages/core-backend/src/routes/univer-meta.ts:8680,8969,9918,9933,9980 (retype-revert + sheet-revert/reset ceilings)
    source: 'packages/core-backend/src/multitable/restore-caps.ts:6,8-10',
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
          "OPERATOR ROLLOUT-POLICY STOP / degraded recoverability (NOT a code-illegal combination): MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED is active while MULTITABLE_TOMBSTONE_CAPTURE_ENABLED is not. The code ALLOWS this — the trash row still writes and the record stays restorable — but isSideDoorTombstoneCaptureEnabled() is false, so inbound-edge capture is DEGRADED (zero inbound tombstones; restored records report inboundEdgesRecoverable:false). --strict STOPs here by rollout policy so an operator does not half-enable D-2, not because the code forbids the combination.",
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
