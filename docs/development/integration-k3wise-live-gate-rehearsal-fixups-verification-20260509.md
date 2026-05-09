# Verification: K3 WISE Live GATE Execution Package — Rehearsal Fixups

**Date**: 2026-05-09
**Design**: `docs/development/integration-k3wise-live-gate-rehearsal-fixups-design-20260509.md`
**Files under verification**:
- `docs/operations/integration-k3wise-live-gate-execution-package.md` (modified — G1 / G2 / G3)
- `docs/development/integration-k3wise-live-gate-rehearsal-20260509.md` (new — supporting evidence)

---

This is the symmetric counterpart of PR #1445's verification matrix. PR
#1445 verified that the runbook described the script accurately at the
time of writing. This PR's verification confirms the **patched** runbook
unblocks the operator paths the rehearsal exposed, by re-running C0–C3
under the new instructions.

## 1. G1 fix — C1 cold-start path now reachable from runbook alone

### Before patch (rehearsal observation)

A new operator following the C1 row's example with no env exported gets
`FAIL exit 1` on `env.database-url` and `env.jwt-secret`, with no doc
explaining how to satisfy them.

### After patch — the runbook's "C1 prerequisites" subsection mode 2

Following the patched runbook's workstation-rehearsal recipe verbatim:

```
$ DATABASE_URL='postgres://rehearsal:<fill-outside-git>@127.0.0.1:65432/rehearsal' \
  JWT_SECRET="$(printf 'r%.0s' {1..40})" \
  node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock \
    --skip-tcp --skip-migrations \
    --out-dir <art>

integration-k3wise-onprem-preflight: PASS (exit 0, mode=mock)
  [pass         ] env.database-url
  [pass         ] env.jwt-secret
  [skip         ] pg.tcp-reachable — --skip-tcp
  [skip         ] pg.migrations-aligned — --skip-migrations
  [pass         ] fixtures.k3wise-mock — mock smoke (run-mock-poc-demo.mjs) is runnable offline
  [skip         ] k3.live-config — mock mode does not require K3 endpoint or credentials
  [skip         ] k3.live-reachable — mode=mock
  [skip         ] gate.file-present
```

`exit=0`, `decision=PASS`. The runbook's C1 PASS criterion is now
reachable by following the runbook alone — no external knowledge
required. The real-deploy-host mode 1 still defers to the bridge-IP
recipe in `docs/operations/k3-poc-onprem-preflight-runbook.md`, which
is unchanged and verified by its own PR #1437 evidence.

## 2. G2 fix — C2 FAIL diagnostic now linked to fix recipes

### Before patch (rehearsal observation)

C2 row's FAIL column showed only "exit 1 (mandatory) or exit 2
(`GATE_BLOCKED` — customer field still missing)". When the script
returned `k3.live-reachable: fail / DNS lookup failed for
k3.rehearsal.test / check /etc/hosts or DNS`, the operator had to
discover `k3-poc-onprem-preflight-runbook.md` independently.

### After patch (script behaviour unchanged; doc cross-link added)

Same C2 invocation as before:

```
$ … --live --gate-file <rehearsal-gate.json> --skip-tcp --skip-migrations \
    --timeout-ms 3000 --out-dir <art>

integration-k3wise-onprem-preflight: FAIL (exit 1, mode=live)
  [pass         ] env.database-url
  [pass         ] env.jwt-secret
  [skip         ] pg.tcp-reachable — --skip-tcp
  [skip         ] pg.migrations-aligned — --skip-migrations
  [pass         ] fixtures.k3wise-mock — mock smoke (run-mock-poc-demo.mjs) is runnable offline
  [pass         ] k3.live-config
  [fail         ] k3.live-reachable — DNS lookup failed for k3.rehearsal.test — check /etc/hosts or DNS
  [pass         ] gate.file-present
```

The FAIL row in the patched runbook now reads:

> exit 1 (mandatory) or exit 2 (`GATE_BLOCKED` — customer field still
> missing). For per-error-code fix recipes (`ECONNREFUSED` / `ENOTFOUND`
> / `EHOSTUNREACH` / `ETIMEDOUT`) on `pg.tcp-reachable` and
> `k3.live-reachable`, see
> `docs/operations/k3-poc-onprem-preflight-runbook.md` § "Per-check
> failure recipes".

Cross-link target verified to exist (file present in repo, matching
section heading present per
`grep -nE 'Per-check failure recipes' docs/operations/k3-poc-onprem-preflight-runbook.md`).

## 3. G3 fix — Shell-pipeline exit-code hygiene demonstrated

### The trap

Without `set -o pipefail`, a shell pipeline's exit code is the **last
command's** exit code. `head` / `tail` / `grep` typically exit `0`, so
the pipeline silently drops the script's actual exit even when the
script returned `1` or `2`. Custom evidence harnesses fall into this
trap and record false-PASS evidence.

### After patch — Stage E demonstrates both patterns

Live demo run on this commit:

```
$ # without pipefail (BAD)
$ ( node scripts/ops/integration-k3wise-onprem-preflight.mjs --skip-tcp --skip-migrations --out-dir /tmp/discard 2>&1 | head -2 ; echo "  reported exit (head): $?" )
integration-k3wise-onprem-preflight: FAIL (exit 1, mode=mock)
  [fail         ] env.database-url — set DATABASE_URL=… before running backend or migrations
  reported exit (head): 0       ← FALSE PASS

$ # with pipefail (GOOD)
$ ( set -o pipefail ; node scripts/ops/integration-k3wise-onprem-preflight.mjs --skip-tcp --skip-migrations --out-dir /tmp/discard 2>&1 | head -2 ; echo "  reported exit (pipefail): $?" )
integration-k3wise-onprem-preflight: FAIL (exit 1, mode=mock)
  [fail         ] env.database-url — set DATABASE_URL=… before running backend or migrations
  reported exit (pipefail): 1   ← TRUE FAIL
```

The patched Stage E shows both the `set -o pipefail` form and the
"capture `$?` before the pipe" alternative, with example commands
operators can copy-paste.

## 4. C3 unchanged (script untouched, doc claim still accurate)

```
$ node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input <rehearsal-gate.json> --out-dir <art>
{
  "ok": true,
  "status": "preflight-ready",
  "externalSystems": 2,
  "pipelines": 2
}
```

Same packet content, same checklist (`GATE-01 / CONN-01 / CONN-02 /
DRY-01 / SAVE-01 / BOM-01 / FAIL-01 / ROLLBACK-01`), same safety block
(`saveOnly:true / autoSubmit:false / autoAudit:false`). PR #1445's C3
claim continues to hold; no doc change there.

## 5. Five-point hygiene re-check on the patched runbook

Re-running PR #1445's five-point validation matrix against the patched
runbook:

| # | Requirement | Result |
|---|---|---|
| 1 | No secret example values | 4 grep classes return 0; only sanctioned `<fill-outside-git>` / `<redacted>` placeholders present (the new G1 example also uses `<fill-outside-git>`). |
| 2 | All referenced repo paths exist | 7/7 EXIST (the G2 cross-link target `docs/operations/k3-poc-onprem-preflight-runbook.md` is one of the seven and is present on `origin/main`). |
| 3 | env ↔ gate JSON mapping consistent with scripts | env-var set still set-equal to script's `env.X` reads (the new G1 mode-2 example uses exactly `DATABASE_URL` and `JWT_SECRET`); GATE JSON paths still each map to a `normalizeGate()` throw-site, optional-default, or whitelist. |
| 4 | No production write claim, Save-only preserved | 3 `production` mentions, all in reject/forbidden contexts; new G3 demo uses `--skip-tcp --skip-migrations --out-dir /tmp/discard`, no production endpoint involved. |
| 5 | Live remains blocked until customer GATE | C2 row's GATE_BLOCKED still the documented invariant; the new G2 cross-link does not change that — it just clarifies what to do for non-GATE-blocked failures. |

All five remain satisfied after the patch.

## 6. Existing-test-suite regression

Doc-only PR.

```
$ pnpm verify:integration-k3wise:onprem-preflight     # 14/14 PASS
$ pnpm verify:integration-k3wise:poc                  # 37 unit + mock chain PASS
```

Both green. Last green at the merge of PR #1445; this PR doesn't touch
any source they cover.

## 7. Leak self-check on patched-runbook artifacts

```
$ find artifacts/integration-k3wise/internal-trial/rehearsal-postpatch-20260509 -type f \( -name '*.json' -o -name '*.md' \) -exec grep -lE 'eyJ[A-Za-z0-9_-]{20,}|rehearsal-pw-NOT-real' {} +
# (empty)
```

No `eyJ…` JWT-shape, no literal env password values. Stage E's
self-check pattern returns 0 for all four greps.

## CI status

Not modified. No CI workflow file is touched.

## Deployment impact

**None.** Doc-only.

## Customer GATE status

Outside the GATE block. Stage 1 Lock memory remains in force.

## Worktree

Branch: `codex/integration-k3wise-live-gate-rehearsal-fixups-20260509`,
forked from `origin/main` at the post-#1445 tip.
Cwd: `/Users/chouhua/Downloads/Github/metasheet2`.
