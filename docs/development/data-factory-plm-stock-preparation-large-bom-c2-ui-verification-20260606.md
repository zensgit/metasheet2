# Data Factory #2342 C2 - large-BOM bounded UI verification (2026-06-06)

## Scope

This slice adds the operator-facing display for the C1 bounded large-BOM dry-run
state in `IntegrationWorkbenchView`.

It is intentionally UI-only:

- no backend route change;
- no C2/C3/C4 helper change;
- no background full-expansion worker;
- no checkpointed writer;
- no MetaSheet row write;
- no PLM/external database write;
- no K3 path.

This PR is stacked on the C1 bounded-readiness branch because it consumes the C1
response shape.

## UI behavior

When a table action dry-run returns `status='large_bom_bounded'` or
`largeBom=true`, the workbench now shows a dedicated bounded-preview block:

- `大 BOM 有界预览`
- Apply blocked badge
- bounded metrics: rows expanded, read count, and configured cap fields when
  present (`maxRows`, `maxPages`, `maxReadCount`, `maxElapsedMs`)
- error types, values-free
- clear statement that the preview is not authoritative and no dry-run token is
  issued

The regular Apply button remains disabled because the existing apply gate still
requires all of:

- `canApply === true`
- a server dry-run token
- integration write permission
- manual-confirm acknowledgement when needed

C2 does not add any browser-controlled cap or Apply mode.

## Values-free boundary

The UI can show tenant-visible values in other existing workbench surfaces, but
the new bounded block displays only values-free counters and error types.

The copied evidence still comes from the server `evidence` object. Tests assert
that it does not render the project value, component id, or dry-run token.

## Verification

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
git diff --check
```

Covered assertions:

- clicking the real table-action dry-run button with a mocked
  `large_bom_bounded` response renders the bounded block;
- the review summary shows bounded rows/read attempts;
- cap metrics and `max_rows_exceeded` render as values-free diagnostics;
- Apply is disabled and clicking it sends no request;
- the status message says bounded preview / Apply blocked, not "ready to apply";
- no dry-run token is shown;
- evidence does not include the project value, component id, or token.

## Remaining gates

- C3: background full-expansion design.
- C4: checkpointed large apply design.
- C5: entity-machine validation with values-free evidence.

#2343 D1 duplicate handling remains behind the large-sample complete-expansion
decision, because bounded/subset duplicate counts are not authoritative.
