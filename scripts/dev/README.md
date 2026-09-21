# `scripts/dev/` — developer-run helpers

Scripts here are run by hand. None of them is wired into CI, none writes to a database, and none
is a substitute for a test.

| Script | One-line usage |
|---|---|
| `probe-group-name-rule.mjs` | `node scripts/dev/probe-group-name-rule.mjs U+3164 U+115F U+2800 请假` — prints `cp / category / defaultIgnorable / visible / verdict` for each code point or string, evaluated by the **real** approval-group name rule (`packages/core-backend/src/services/approval-template-group-name-rule.ts`); no database, no network. |
| `atg-retraction-sweep.sh` | `bash scripts/dev/atg-retraction-sweep.sh` — machine sweep for a retracted claim across the approval template-groups verification MD (gate P2-1). |
| `atg-verification-recount.sh` | `bash scripts/dev/atg-verification-recount.sh` — recounts the error-code census the template-groups verification MD cites (gate P2-2). |

`probe-group-name-rule.mjs` exists because a re-typed predicate is not the shipped one: it imports
the module the HTTP route calls, so checking a code point never means transcribing a character
class. Add `--json` for machine-readable rows, `--cp <hex>` / `--str <text>` to force how an
argument is read, `--help` for the full usage.
