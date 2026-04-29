# DingTalk Public Form Mobile Signoff TODO And Autocompile Design - 2026-04-29

## Goal

Make the remaining real DingTalk mobile checks visible and actionable from the
current `mobile-signoff.json` file, then remove the final manual strict-compile
step once the last check passes.

The previous recorder slice removed hand-editing for individual evidence
updates. This slice adds a `--todo` mode that turns the current signoff packet
into a redaction-safe remaining-work report with exact `--record` command
templates for each unfinished scenario. It also adds `--compile-when-ready` for
record mode, so the final successful record writes the strict acceptance packet
automatically.

## Scope

Changed script:

- `scripts/ops/dingtalk-public-form-mobile-signoff.mjs`

Changed tests:

- `scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`

Added docs:

- `docs/development/dingtalk-public-form-mobile-signoff-todo-design-20260429.md`
- `docs/development/dingtalk-public-form-mobile-signoff-todo-verification-20260429.md`

## CLI Contract

Generate a TODO report as files:

```bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --todo mobile-signoff.json \
  --output-dir todo
```

Print the same TODO report to stdout:

```bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --todo mobile-signoff.json
```

Record one check and auto-compile only when all checks are ready:

```bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --record mobile-signoff.json \
  --check-id public-anonymous-submit \
  --status pass \
  --source server-observation \
  --operator qa \
  --summary "Anonymous public form inserted one record." \
  --record-insert-delta 1 \
  --output-dir compiled \
  --compile-when-ready
```

When `--output-dir` is provided, the tool writes:

- `todo.md`: human-readable remaining-check report.
- `todo.json`: machine-readable counts, remaining checks, warnings, and errors.
- `mobile-signoff.redacted.json`: redacted copy of the source packet.

## Report Semantics

The TODO report includes:

- Strict-ready state.
- Pass, fail, pending, skipped, and missing counts.
- Remaining checks with evidence recipes.
- Suggested `--record` command templates.
- Completed checks.
- Validation errors and warnings.

A check is complete only when its status is `pass` and the check-specific
evidence validation has no errors. Pending, missing, skipped, failed, or invalid
checks remain actionable in the report.

Generated suggested commands include `--compile-when-ready` and a `compiled`
output directory next to the source kit. This makes every copied command safe to
use before the kit is complete: unfinished runs print the remaining check IDs
and do not write strict output.

## Autocompile Semantics

`--compile-when-ready` is accepted only with `--record`.

After a successful non-dry-run record:

- The tool validates the whole packet using the TODO completeness rules.
- If any required check remains incomplete, it prints the remaining check IDs
  and exits successfully without writing `summary.json`.
- If every required check is complete and valid, it runs the existing strict
  compile path and writes `summary.json`, `summary.md`, and
  `mobile-signoff.redacted.json`.

`--compile-when-ready` is rejected with `--dry-run`, because dry-run must not
write either the source packet or strict output.

## Secret Handling

The TODO mode reuses the existing validation and redaction path:

- Raw webhook URLs, `access_token` values, DingTalk `SEC...` secrets, bearer
  tokens, JWTs, public form tokens, and DingTalk client secrets are detected.
- File output includes only a redacted source copy.
- The report shows secret-pattern names in validation errors, not raw secret
  values.
- Secret-like input causes a non-zero exit code so the operator fixes the kit
  before strict signoff.

## Operator Flow

1. Run `--init-kit`.
2. Run `--todo` to confirm all nine scenarios are pending.
3. Execute one real DingTalk mobile scenario.
4. Run the suggested `--record` command for that scenario.
5. Re-run `--todo` to see the remaining count.
6. On the last successful `--record`, the strict packet is written automatically
   when `--compile-when-ready` is present.

## Non-goals

- The TODO mode does not call DingTalk.
- The TODO mode does not verify server-side record counts by itself.
- The TODO mode does not create users, forms, grants, or records.
- The TODO mode does not persist raw tokens, temporary passwords, screenshots,
  or webhook secrets.
