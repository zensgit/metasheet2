# Staging Migration Schema Probe Summary Development

Date: 2026-05-20

## Summary

This slice adds an offline summary step after `schema-probes.sql`. Operators can
run the SQL against a cloned or backed-up rehearsal database, export the result
as CSV or TSV, then summarize the output without giving the script database
credentials.

The new script does not connect to PostgreSQL, run migrations, call Docker, or
write `kysely_migration`. It only reads text and writes local summary artifacts.

## Files

| File | Change |
| --- | --- |
| `scripts/ops/staging-migration-schema-probe-summary.mjs` | New read-only CSV/TSV parser and summary generator. |
| `scripts/ops/staging-migration-schema-probe-summary.test.mjs` | Unit coverage for CSV, TSV, ambiguity, invalid inputs, and output boundary. |
| `docs/operations/staging-migration-alignment-runbook.md` | Documents the offline summary command after `schema-probes.sql`. |
| `docs/development/staging-migration-schema-probe-summary-development-20260520.md` | This development record. |
| `docs/development/staging-migration-schema-probe-summary-verification-20260520.md` | Verification record for this slice. |

## CLI Contract

```bash
node scripts/ops/staging-migration-schema-probe-summary.mjs \
  --input output/staging-migration-alignment-report/<run>/schema-probe-results.csv \
  --format csv \
  --out-dir output/staging-migration-alignment-report/<run>
```

Stdin is also supported:

```bash
psql "$REHEARSAL_DATABASE_URL" \
  -X --set ON_ERROR_STOP=1 --csv \
  -f output/staging-migration-alignment-report/<run>/schema-probes.sql \
  | node scripts/ops/staging-migration-schema-probe-summary.mjs --format csv
```

Supported input columns:

- `probe_type`
- `migration`
- `target`
- `exists`
- `match_count`
- `matched_schemas`

Supported formats:

- `auto` (default)
- `csv`
- `tsv`

Outputs:

- `schema-probe-summary.json`
- `schema-probe-summary.md`

## Classification

| Status | Rule |
| --- | --- |
| `matched` | `exists=true` and `match_count === 1` |
| `missing` | `exists=false` or `match_count === 0` |
| `ambiguous` | `match_count > 1` or multiple `matched_schemas` |

The report decision is:

| Decision | Meaning |
| --- | --- |
| `schema_probe_targets_present` | Every emitted probe target matched exactly once. Still not a replay safety proof. |
| `manual_review_required` | At least one target is missing or ambiguous. Review before any alignment write. |

Per-migration rollups also emit:

- `all_matched`
- `has_missing`
- `has_ambiguous`
- `mixed_missing_and_ambiguous`

## Guardrails

- No DB URL is accepted by the script.
- No `psql`, Docker, `pnpm`, or migration command is spawned.
- Missing or ambiguous targets do not make the script fail; they are successful
  parsed results requiring human review.
- Malformed input fails with exit code 1 and a direct error message.
- JSON keeps all parsed rows; Markdown is a human summary.
