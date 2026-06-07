# Data Factory PLM Stock Preparation D3 Duplicate Validation Runbook - 2026-06-07

## Purpose

Validate the `keep_multiple_rows` duplicate resolver shipped in #2372 against the
#2340 246-row sample.

This runbook is a validation gate, not a new development approval. It does not
authorize a production rollout, a large-BOM background apply, or the remaining
duplicate policies (`merge_quantity`, `select_representative`,
`skip_selected`, `source_correction_required`).

## Baseline

Use the same project/sample shape from #2340/#2343:

- prior dry-run: `rowsExpanded=246`, `add=190`, `manual_confirm=28`;
- prior apply-only run wrote the clean rows: `created=190`, `held=28`,
  `failed=0`;
- prior post-apply dry-run: `existingRows=190`, `add=0`, `skip=190`,
  `manual_confirm=28`.

The expected D3 value is that reviewed duplicate groups can resolve through
`keep_multiple_rows` while clean rows remain idempotent.

## Preconditions

- Deployed package includes #2372 or later:
  `b40f0f769 feat(data-factory): resolve keep-multiple duplicate rows`.
- Table action is configured server-side for the stock-preparation target.
- The #2340 sample/project is available on the entity machine.
- The operator has:
  - read permission for dry-run;
  - write/admin permission for apply;
  - admin permission only if saving `table_scope` policies.
- No other production/bulk apply is running for the same target table.

## Values-Free Evidence Rule

Evidence may include only:

- package tag/SHA presence;
- action configured: yes/no;
- counts: `rowsExpanded`, `existingRows`, `add`, `update`, `skip`, `inactive`,
  `manual_confirm`, `created`, `patched`, `failed`, `held`;
- duplicate summary counts:
  - `duplicateExpandedKeyResolution.resolvedGroupCount`;
  - `resolvedRowCount`;
  - `heldGroupCount`;
  - `heldRowCount`;
  - `tableScopeResolvedGroupCount`;
  - `runOnlyResolvedGroupCount`;
  - `heldReasonCounts`;
- policy/effect labels:
  - `keep_multiple_rows`;
  - `table_scope` / `run_only`;
  - `add_decisions_require_ack`;
  - `manual_confirm_held`;
- re-pull status and counts.

Never paste or attach:

- project number;
- component code/name/source id;
- parent/path/idempotency key;
- raw payload preview JSON;
- target sheet id or field ids;
- PLM rows;
- credentials, tokens, connection strings, raw SQL, or stack traces containing
  business values.

## Validation Steps

### 1. Confirm the package and action

Record values-free evidence:

```text
packageIncludesD3=true|false
packageShaPresent=true|false
tableActionConfigured=true|false
operatorHasRead=true|false
operatorHasWriteOrAdmin=true|false
```

Pass criteria:

- package includes #2372 or later;
- table action is configured;
- permissions match the run being attempted.

### 2. Run a pre-policy dry-run

Run dry-run on the #2340 sample before adding a new duplicate policy.

Record:

```text
status=<ready|manual_confirm_required|large_bom_bounded|failed>
rowsExpanded=<count>
existingRows=<count>
add=<count>
update=<count>
skip=<count>
inactive=<count>
manual_confirm=<count>
duplicateGroupCount=<count>
```

Expected:

- clean rows are not added again (`add=0` for the already-applied clean rows);
- duplicate rows remain visible for review unless a policy is already saved;
- no apply is run at this step.

Do not reuse a pre-policy dry-run token after selecting a duplicate policy.
D3 hashes the reviewed policy state and duplicate-resolution summary into the
dry-run revision. A token from this step is expected to fail closed with a
revision mismatch after step 3 changes the policy state.

### 3. Select `keep_multiple_rows`

Choose one path:

- `table_scope`: admin saves `keep_multiple_rows` for the applicable duplicate
  fingerprints, if this table should keep the rule after this validation;
- `run_only`: operator selects `keep_multiple_rows` only for this run, if this
  is a one-off validation.

Choose applicable fingerprints from the D1 values-free group diagnostics, not
from raw PLM rows. Use the grouped cause signals such as parent shape,
stable-discriminator availability/counts, quantity shape, and held reason to
decide which groups are eligible for `keep_multiple_rows`.

Do not choose unsupported policies in this validation. They are intentionally
still review-only/held in D3.

### 4. Run a fresh post-policy dry-run

This is the activation gate. A saved `table_scope` policy is not considered
active until this fresh dry-run shows it in values-free evidence.

The dry-run token used for apply must come from this post-policy dry-run, not
from the pre-policy dry-run in step 2.

Record:

```text
status=<ready|manual_confirm_required|failed>
rowsExpanded=<count>
existingRows=<count>
add=<count>
update=<count>
skip=<count>
inactive=<count>
manual_confirm=<count>
resolvedGroupCount=<count>
resolvedRowCount=<count>
heldGroupCount=<count>
heldRowCount=<count>
tableScopeResolvedGroupCount=<count>
runOnlyResolvedGroupCount=<count>
heldReasonCounts=<keys only, no values>
writeEffect=<add_decisions_require_ack|mixed_duplicate_resolution|manual_confirm_held>
```

Pass criteria:

- resolved groups are explicitly reported before apply;
- `table_scope` policies show under `tableScopeResolvedGroupCount`;
- `run_only` policies show under `runOnlyResolvedGroupCount`;
- unresolved groups remain held with reason counts;
- evidence stays values-free.

Fail criteria:

- a saved policy silently affects apply without appearing in fresh dry-run
  evidence;
- evidence exposes project/component/path/idempotency values;
- clean rows become new `add` decisions again.

### 5. Verify apply acknowledgement gate

Attempting apply without duplicate-resolution acknowledgement must fail or keep
the button disabled.

Record:

```text
applyWithoutDuplicateAckBlocked=true|false
blockCodeOrUiState=<values-free label>
```

Pass criteria:

- resolved duplicate groups require explicit acknowledgement;
- a dry-run token alone is not enough.

### 6. Apply after explicit owner approval

Only run this step after the owner approves the exact dry-run evidence from
step 4.

Record:

```text
ownerApprovalPresent=true
acceptDuplicateResolution=true
applyStatus=<succeeded|partial|failed>
created=<count>
patched=<count>
failed=<count>
held=<count>
```

Pass criteria:

- resolved duplicate rows write through the normal add/update path;
- held groups remain held;
- no PLM write, external DB write, K3 write, or payload/client-plan override is
  involved.

Rollback note: resolved rows created in this step use discriminator-bearing
duplicate keys. If step 7 finds a divergence, the operator may remove only the
newly created resolved duplicate rows by their discriminator-key shape
(`::duplicate:...`) after owner approval. Held groups were never written.

### 7. Re-pull idempotency check

Run a fresh dry-run after apply.

Record:

```text
status=<ready|manual_confirm_required|failed>
existingRows=<count>
add=<count>
update=<count>
skip=<count>
manual_confirm=<count>
resolvedGroupCount=<count>
heldReasonCounts=<keys only, no values>
```

Pass criteria:

- resolved duplicate rows do not add again: `add=0` for the resolved set;
- resolved rows reach `skip` or `update`, both acceptable;
- the base key is not misclassified as `clean_to_collision_requires_review`;
- if all duplicate groups were resolvable, `manual_confirm=0`;
- if some groups remain unresolved, only those groups stay `manual_confirm`.

## Issue Reply Template

Use this template on #2343 or the validation issue. Keep it values-free.

```text
D3 keep_multiple_rows validation result:

- packageIncludesD3:
- tableActionConfigured:
- prePolicyDryRun:
  - rowsExpanded:
  - existingRows:
  - add/update/skip/inactive/manual_confirm:
  - duplicateGroupCount:
- policyPath: table_scope | run_only
- postPolicyDryRun:
  - status:
  - add/update/skip/inactive/manual_confirm:
  - resolvedGroupCount:
  - resolvedRowCount:
  - heldGroupCount:
  - heldReasonCounts:
  - tableScopeResolvedGroupCount:
  - runOnlyResolvedGroupCount:
  - writeEffect:
- applyWithoutDuplicateAckBlocked:
- applyAfterApproval:
  - status:
  - created/patched/failed/held:
- rePull:
  - status:
  - existingRows:
  - add/update/skip/manual_confirm:
  - heldReasonCounts:
- valuesFreeEvidence: pass | fail
- conclusion: pass | divergence
```

## Stop Rules

Stop and report divergence before applying if any of these happens:

- the package does not include #2372 or later;
- the dry-run is `large_bom_bounded` or globally failed;
- saved `table_scope` policy does not appear in fresh dry-run evidence;
- clean rows become new `add` decisions;
- `acceptDuplicateResolution` is not required for resolved groups;
- evidence includes business values or secrets.

Stop after apply and do not run production/bulk apply if:

- re-pull shows resolved duplicate rows as new `add` again;
- base-key rows are held under `clean_to_collision_requires_review` after the
  resolved-key apply;
- failed rows contain anything beyond the reviewed held groups.

## Next Decision

- If the #2340 sample passes: close the D3 validation gate and decide whether
  the next work is large-BOM background expansion/checkpoint apply or another
  duplicate policy.
- If unresolved groups remain: choose the next duplicate strategy based on
  `heldReasonCounts` and the operator's review, not speculation.
- If large-BOM limits block the run: route to the #2342 large-BOM track before
  trusting duplicate counts on a truncated sample.
