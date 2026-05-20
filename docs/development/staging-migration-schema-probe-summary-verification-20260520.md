# Staging Migration Schema Probe Summary Verification

Date: 2026-05-20

## Scope

Verify the offline `schema-probes.sql` result summarizer.

No staging DB migration was executed. No database connection was opened. No
`kysely_migration` row was written.

## Checks

| Check | Result |
| --- | --- |
| `node --check scripts/ops/staging-migration-schema-probe-summary.mjs` | PASS |
| `node --test scripts/ops/staging-migration-schema-probe-summary.test.mjs` | PASS, 8 tests |
| `git diff --check` | PASS |

## Unit Coverage

The test suite locks:

- CSV input with matched, missing, and ambiguous targets;
- TSV input from stdin;
- quoted CSV fields containing commas;
- per-migration statuses: `all_matched`, `has_missing`, `has_ambiguous`, and
  `mixed_missing_and_ambiguous`;
- output boundary: exactly `schema-probe-summary.json` and
  `schema-probe-summary.md` are written;
- missing required headers fail clearly;
- invalid boolean and numeric fields fail clearly;
- unsupported `--format` fails clearly;
- missing input fails clearly.

## Boundary Verification

- The script only imports `fs`, `path`, and `url`.
- It does not import `child_process`.
- It does not accept a DB URL argument.
- It does not run migrations or write `kysely_migration`.
- No token/JWT paths were used or committed.

## Live Evidence Status

No live rehearsal DB probe output was available in this slice. The live DB work
remains an operator-controlled step:

1. run `schema-probes.sql` against a cloned or backed-up rehearsal DB;
2. export CSV or TSV;
3. run this summary script on that local artifact;
4. review `manual_review_required` vs `schema_probe_targets_present` before any
   migration alignment write.
