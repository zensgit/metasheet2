# Stock-preparation P4 one-shot repair runbook (2026-07-19)

> Status: owner-controlled migration tool. It is not an HTTP route and does not authorize production
> autopersist. The executable defaults to dry-run and must be retired after the bounded migration
> window. The repair writes internal MetaSheet tables only; `externalWrite` is always `false`.

## Preconditions

1. Deploy a build containing P4 Option A and migrations 066/067.
2. Stop new stock-preparation persist traffic for the affected tenant during the repair window.
3. Prepare one local JSON manifest per candidate from the same approved source material that produced
   the original deterministic plan. Never commit, upload, or paste this manifest into an issue or PR.
4. The manifest must include `tenantId`, `actorId`, and the normal sync-run plan inputs. It must not
   include runtime capabilities or scope overrides (`apply`, `permission`, `recordsApi`, `provisioning`,
   `auditStore`, `lockTenantId`, or `targetProjectId`).

## Dry-run

```bash
pnpm --silent ops:stock-prep-persist-repair-once --input /secure/path/repair.json
```

Accept only one JSON line on stdout with all of the following:

- `status: "PASS"`
- `mode: "dry_run"`
- `result.applied: false`
- `result.evidence.externalWrite: false`
- `result.evidence.valuesFree: true`

Any `FAIL`, malformed output, extra output, duplicate/ambiguous state, projection mismatch, or
unprovable history stops the window. Do not edit database rows to make the tool pass.

Dry-run appends one values-free `persist_repair_once` audit row. It does not create or patch any of
the four snapshot/project records.

## Apply

After owner approval of the dry-run summary, use the exact typed confirmation:

```bash
pnpm --silent ops:stock-prep-persist-repair-once \
  --input /secure/path/repair.json \
  --apply \
  --confirm APPLY_STOCK_PREPARATION_REPAIR_ONCE
```

Success is either `result.outcome: "repaired"` or an idempotent `"noop"`, with
`result.evidence.externalWrite: false` and `result.evidence.valuesFree: true`. The tool can append only
a proven missing line suffix, a missing run/project row, or patch a provably stale project pointer. It
never deletes, deduplicates, or rewrites immutable snapshot rows.

## Verify and retire

1. Re-run the same command in dry-run mode and require `result.repairable: false`.
2. Run the normal exact replay and the stock-preparation read/diff/confirm/generation smoke set.
3. Retain only the values-free JSON summaries and the append-only `persist_repair_once` audit rows.
4. Securely delete the local manifest.
5. After all approved candidates are resolved or refused, remove the root package command and the
   executable repair module in a follow-up PR. Keep migrations 066/067 and audit rows as history.

Refused or ambiguous states remain owner-managed evidence. They are not automatically repaired.
