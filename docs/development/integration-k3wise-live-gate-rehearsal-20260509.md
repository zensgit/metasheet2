# K3 WISE Live GATE — Internal Rehearsal Findings (2026-05-09)

## Purpose

Walk through the C0–C3 sequence documented in
`docs/operations/integration-k3wise-live-gate-execution-package.md` (PR #1445)
end-to-end on a workstation, using a synthetic GATE answer that points at
RFC 6761 reserved `.test` hostnames, to surface friction in the runbook
**before** a real customer GATE arrives.

The rehearsal is read-only: no real K3, no production deployment touched, no
real-customer values used. All artifacts written to
`artifacts/integration-k3wise/internal-trial/rehearsal-20260509/` (gitignored
under the rule added in PR #1442).

## Synthetic GATE answer

Generated from `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample`,
then transformed:

- All hostnames replaced with `*.rehearsal.test` (RFC 6761 reserved — no
  real DNS resolution).
- All credential `password` slots set to the sanctioned
  `<fill-outside-git>` placeholder.
- Identifiers prefixed `rehearsal-` / `REHEARSAL` so accidental greps cannot
  conflate with any real customer.
- `sqlServer.enabled=false` (rehearsal scope is the K3 + PLM + BOM happy
  path).
- File saved to `/tmp/rehearsal-gate-20260509.json` (size 2235 bytes).

## Executed sequence

| Step | Command | Actual outcome | Matches #1445 doc | Notes |
|---|---|---|---|---|
| C0 | `pnpm verify:integration-k3wise:poc` | PASS — 37 unit tests + 9-step end-to-end mock chain | ✓ | <1s, cache-warm |
| C1 (cold) | `node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art>` (no env exported) | **FAIL exit 1** — `env.database-url` and `env.jwt-secret` both fail; downstream checks cascade-skip; `fixtures.k3wise-mock` still passes | Half-match — script behaves correctly, but the C1 row's bare command does not explain how to satisfy its PASS criterion. See **G1**. |
| C1' | `… --mock --skip-tcp --skip-migrations` with synthetic `DATABASE_URL` + `JWT_SECRET` | PASS exit 0 | ✓ | This combo is what a workstation rehearsal actually needs; doc does not show it explicitly |
| C2 | `… --live --gate-file /tmp/rehearsal-gate-20260509.json --skip-tcp --skip-migrations` with synthetic env | **FAIL exit 1** — `k3.live-reachable` returns `ENOTFOUND` for `k3.rehearsal.test`; other 7 checks PASS / skip | ✓ on FAIL path, but **no inline pointer to fix recipes**. See **G2**. |
| C3 | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input /tmp/rehearsal-gate-20260509.json --out-dir <art>` | **PASS** — `ok=true`, `status=preflight-ready`, 2 external systems, 2 pipelines | ✓ matches doc claim exactly | <1s |

## C3 packet content verification

| #1445 claim | Actual packet content |
|---|---|
| Checklist includes GATE-01 / CONN-01 / CONN-02 / DRY-01 / SAVE-01 / FAIL-01 / ROLLBACK-01 (+ BOM-01 when BOM enabled) | All 8 IDs present (order: `GATE-01, CONN-01, CONN-02, DRY-01, SAVE-01, BOM-01, FAIL-01, ROLLBACK-01`) |
| `safety.saveOnly=true / autoSubmit=false / autoAudit=false` | `{"environment":"test","saveOnly":true,"autoSubmit":false,"autoAudit":false,"sqlServerMode":"disabled","productionWriteBlocked":true}` |
| BOM enabled → 2 pipelines | 2 pipelines (`live-poc-plm-material-to-k3-wise-save-only`, `live-poc-plm-bom-to-k3-wise-save-only`) |
| Both pipelines `writeMode=saveOnly` with `target.autoSubmit=false / target.autoAudit=false` | Both confirmed |

C3 is the cleanest step — runbook description and packet output match
verbatim.

## Sanitization & hygiene

| Check | Result |
|---|---|
| Pre-share self-check (Stage E, 4 greps): `"password"` non-redacted | 0 across c1, c2, c3 artifacts |
| eyJ JWT-shape | 0 files |
| URL query secret leak | 0 |
| Raw postgres userinfo | 0 |
| `K3_PASSWORD` literal value (`rehearsal-pw-NOT-real`) anywhere in artifacts | 0 files (env never persisted by either preflight) |
| `K3_USERNAME` literal value (`rehearsal-k3-user`) anywhere in artifacts | 0 files (C2 records `usernamePresent: true`; C3's `credentialPlaceholder()` redacts the value) |
| `.gitignore` rule from #1442 covers `artifacts/integration-k3wise/internal-trial/rehearsal-*/` | ✓ confirmed via marker-file probe (empty `git status`) |

The script's redaction of credentials is consistent with the runbook claim
"K3 credentials recorded as `usernamePresent: true` / `passwordPresent:
true` only — never the raw values".

## Findings

### G1 — C1 row does not state DATABASE_URL / JWT_SECRET as a prerequisite (severity: medium)

**Evidence**: The runbook's C1 row example is
`node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art>`,
and its PASS criterion includes
`pg.tcp-reachable / pg.migrations-aligned / fixtures.k3wise-mock all pass`.
A new operator running C1 in a fresh shell with no env exported sees `FAIL
exit 1` on `env.database-url` and `env.jwt-secret` — neither documented
nor expected from the bare PASS criterion.

**Proposed fix**: Add a "Prerequisites" line under the C1 row of the
runbook. Two operating modes:

1. **Real deploy host** — `DATABASE_URL` and `JWT_SECRET` must already be
   exported. The bridge-IP recipe in
   `docs/operations/k3-poc-onprem-preflight-runbook.md` (PR #1437) shows
   how to populate them on a Docker-deployed host.
2. **Workstation rehearsal** — pass `--skip-tcp --skip-migrations` plus a
   synthetic `DATABASE_URL` (any well-formed `postgres://` string) and a
   synthetic `JWT_SECRET` (any 32+ char string). The C1' row above is the
   pattern that produced PASS in this rehearsal.

### G2 — C2 row's FAIL paths do not cross-link to fix recipes (severity: medium)

**Evidence**: The runbook's C2 row FAIL column says only
`exit 1 (mandatory) or exit 2 (GATE_BLOCKED — customer field still missing)`.
The actual diagnostic content for `k3.live-reachable` failures
(`ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT`, each with a
fix recipe) lives in `docs/operations/k3-poc-onprem-preflight-runbook.md`
under "Per-check failure recipes". A first-time operator hitting
`ENOTFOUND` in C2 has to discover that runbook's existence on their own.

**Proposed fix**: Add a single-sentence cross-link to the C2 row's FAIL
column or as a footnote: "For per-error-code fix recipes
(`ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT`) on
`pg.tcp-reachable` and `k3.live-reachable`, see
`docs/operations/k3-poc-onprem-preflight-runbook.md` § Per-check failure
recipes".

### G3 — Stage E does not warn about `set -o pipefail` (severity: low)

**Evidence**: Stage E lists the 4 pre-share greps as the secret-hygiene
self-check. Nothing flags that piping the preflight script's stdout into
`head` / `tail` / `grep` swallows the script's exit code unless `set -o
pipefail` is set first or the exit code is captured before the pipe.

This rehearsal's own harness fell into the trap: `node ... 2>&1 | head -15;
echo "exit: $?"` prints `exit: 0` regardless of the script's actual exit,
because `head` exits cleanly. An operator using the same shape in their
own evidence-capture wrapper would record false-PASS evidence.

**Proposed fix**: Add one bullet to Stage E: "When wrapping these scripts
in shell pipelines, run `set -o pipefail` first (or capture `$?` directly
from the script before any pipe) — `head` / `tail` / `grep` swallow the
script's non-zero exit otherwise."

## Findings not requiring a fix

- **C0 mock chain**: clean and fast; runbook claim accurate.
- **C3 packet structure**: every detail the runbook claims is present in the
  actual packet output.
- **Credential redaction**: K3 username and password env values do not leak
  into any artifact, matching the script's documented
  `credentialPlaceholder()` / `usernamePresent: true` design.
- **Gitignore coverage**: `artifacts/integration-k3wise/internal-trial/`
  catches all rehearsal subdirectories, no leak risk into the repo.

## Decision and follow-up scope

Option A was chosen on 2026-05-09: a small docs-only follow-up PR
(`codex/integration-k3wise-live-gate-rehearsal-fixups-20260509`) folds the
G1 / G2 / G3 fixes into the runbook in
`docs/operations/integration-k3wise-live-gate-execution-package.md`. This
rehearsal-findings MD is included alongside that PR as the evidence
artifact justifying each fix, so reviewers can trace every line of the
runbook change back to a literal command and a literal failure mode
observed here.

Rationale for choosing A over deferring to the post-GATE cycle: G1
(C1 cold-start trap) is the kind of "first-time operator footgun" that a
customer-facing engagement does not create the opportunity to discover
gracefully — it is better closed on internal evidence now, while the
fix-paths are small and do not depend on customer specifics.

## Artifacts produced by this rehearsal

```
artifacts/integration-k3wise/internal-trial/rehearsal-20260509/
├── c1-mock/preflight.{json,md}
├── c2-live/preflight.{json,md}
└── c3-packet/integration-k3wise-live-poc-packet.{json,md}
```

`/tmp/rehearsal-gate-20260509.json` — synthetic GATE answer used as input.
Not in the repo; safe to delete after this report is reviewed.
