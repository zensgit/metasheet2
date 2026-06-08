# Data Factory PLM Stock Preparation D4 Held-Group Decision Evidence Template - 2026-06-08

## Purpose

Collect values-free evidence for the duplicate groups that remained held after
D3 `keep_multiple_rows` validation.

This template supports the D4 decision track only. It does not authorize a new
runtime policy, another Apply, production rollout, checkpoint writer work, K3
write, PLM write, external database write, raw SQL, migration, route, or UI
change.

## When To Use

Use this after a D3 validation run shows a clean partial pass:

- clean rows remain idempotent on re-pull;
- resolved duplicate rows re-pull as existing rows;
- remaining duplicate groups are still held fail-closed;
- `heldReasonCounts` includes `missing_stable_discriminator`.

Do not use this template when the dry-run is bounded by a large-BOM scale halt.
If `largeBom=true`, route to the #2342 large-BOM track first; duplicate counts
from a bounded expansion are not authoritative.

## Values-Free Rule

Allowed evidence:

- counts;
- status tokens;
- policy names;
- held reason tokens;
- quantity-shape buckets;
- legacy behavior labels;
- collision fingerprints that are deterministic and non-reversible;
- yes/no capability flags.

Forbidden evidence:

- project number;
- component code, component name, or component source id;
- parent, path, PLM row id, source detail id, source line, or sort line;
- raw idempotency key or base key;
- raw PLM rows;
- payload preview JSON;
- target sheet id or field id;
- credentials, tokens, connection strings, raw SQL, or stack traces containing
  business values.

## D4 Evidence Packet

Fill this packet before selecting a policy. Leave unknowns explicit; do not
guess.

```text
D4 held-group decision evidence:

- sourceRun:
  - packageTagOrCommitPresent:
  - d3ValidationIssue:
  - rowsExpanded:
  - expansionComplete: true | false
  - largeBom: true | false
  - status:

- d3Closeout:
  - cleanRowsIdempotent: true | false
  - resolvedRowsIdempotent: true | false
  - remainingHeldGroupCount:
  - remainingHeldRowCount:
  - heldReasonCounts:
    - <reason-token>: <count>

- duplicateShape:
  - rowsPerGroupDistribution:
    - size2:
    - size3:
    - size4Plus:
  - quantityShapeCounts:
    - all_equal:
    - varied:
    - unknown:
  - parentShapeCounts:
    - same_parent:
    - cross_parent:
    - unknown:
  - stableDiscriminatorCounts:
    - any:
    - sourceDetail:
    - pathParent:
    - sortLine:
  - cleanToCollisionTransitionCount:

- legacyStockPreparationBehavior:
  - confirmed: true | false
  - observedBehavior: reject_or_report | dedup_keep_one | merge_quantity | skip_selected | unknown | other
  - evidenceKind: operator_report | legacy_screen_count | legacy_export_count | customer_policy | unknown
  - valuesFreeNotes:

- recommendedPolicy:
  - policy: source_correction_required | select_representative | skip_selected | merge_quantity | keep_multiple_rows | hold
  - scope: decision_only
  - reason:
  - ownerApprovalRequiredBeforeImplementation: true
  - applyAuthorizedNow: false

- forbiddenEvidenceCheck:
  - projectValuesAbsent: pass | fail
  - componentValuesAbsent: pass | fail
  - parentPathKeysAbsent: pass | fail
  - rawRowsAbsent: pass | fail
  - targetIdsAbsent: pass | fail
  - secretsAbsent: pass | fail
```

## Policy Selection Guide

### Default: `source_correction_required`

Use when:

- legacy behavior is unknown;
- legacy behavior rejects/reports the duplicate;
- no stable row identity exists;
- quantity shape is varied and additive semantics are not confirmed;
- source data looks contradictory rather than additive.

Meaning:

- keep the group held;
- tell the operator/customer the source duplicate needs correction or explicit
  source-side decision;
- do not write PLM;
- do not write MetaSheet rows for that held group.

### `select_representative`

Use only when:

- legacy behavior deduplicates or keeps one row for the same duplicate shape;
- owner provides an explicit representative rule or reviewed selection;
- skipped demand is visible as values-free counts/fingerprints.

Never auto-pick the first row. Never infer the representative from component
code alone.

### `skip_selected`

Use only when:

- owner explicitly chooses which duplicate demand is intentionally ignored;
- skipped demand is recorded values-free;
- the business accepts that skipped rows will not become preparation demand.

No silent drop. No default skip.

### `merge_quantity`

Not the default for `missing_stable_discriminator`.

Use only when:

- legacy behavior confirms additive merge for the same duplicate shape;
- owner accepts that summed quantity is the correct stock-preparation demand;
- varied quantities receive explicit review.

If selected later, the quantity rule must be sum of path quantities, not
pick-one.

### `keep_multiple_rows`

Already validated by D3 for groups with stable discriminators.

Do not reuse it for `missing_stable_discriminator` unless future evidence
proves a stable discriminator for a specific group.

## Stop Rules

Stop and do not implement a policy if:

- `largeBom=true`;
- expansion is incomplete;
- legacy behavior is unknown and the proposed policy is not
  `source_correction_required`;
- any required evidence field contains business values;
- `merge_quantity` is proposed without confirmed additive legacy behavior;
- `select_representative` or `skip_selected` is proposed without explicit
  owner-reviewed selection;
- a policy would silently drop demand, silently pick a row, silently re-key an
  existing row, or create duplicate target rows.

## Issue Reply Template

Paste this to #2343 or the follow-up D4 issue. Keep it values-free.

```text
D4 held-group decision evidence:

- d3Status: clean partial pass | divergence
- expansionComplete: true | false
- largeBom: true | false
- remainingHeldGroupCount:
- remainingHeldRowCount:
- heldReasonCounts:
- quantityShapeCounts:
- parentShapeCounts:
- stableDiscriminatorCounts:
- legacyBehaviorConfirmed: true | false
- legacyObservedBehavior:
- proposedPolicy:
- reason:
- applyAuthorizedNow: false
- valuesFreeEvidence: pass | fail

Decision:
- If legacy behavior is unknown, hold as source_correction_required.
- If legacy behavior confirms dedup/keep-one, open a separate select_representative design/impl slice.
- If legacy behavior confirms explicit skip, open a separate skip_selected design/impl slice.
- If legacy behavior confirms additive merge, open a separate merge_quantity design/impl slice.
- Do not run another Apply from this comment.
```

## Boundary

This document is a template and decision aid. It starts no code path. Every
future executable policy remains separately gated and must require a fresh
dry-run, fresh token, reviewed values-free policy evidence, and explicit owner
acknowledgement before any apply.
