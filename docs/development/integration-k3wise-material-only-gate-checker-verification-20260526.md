# K3 WISE Material-only GATE Checker — Verification (2026-05-26)

Issue: #1792 · Tool: `scripts/ops/integration-k3wise-gate-contract-check.mjs`
Branch: `integration/k3wise-material-only-gate-checker-20260526`
Design: `integration-k3wise-material-only-gate-checker-design-20260526.md`

All commands are read-only; none contacts K3 WISE or MetaSheet.

## V1. `--help` advertises `--scope`

```
$ node scripts/ops/integration-k3wise-gate-contract-check.mjs --help
...
  --scope <full|material-only>
                      full (default): the unchanged customer GATE-front contract.
                      material-only: smaller subset acceptance for the #1792
                      Material-first dry-run (O1-MAT, O1-MAT-M, O6, one materialDetail
                      sample, and materialOnlySafety answers). A pass returns
                      PASS_MATERIAL_DRY_RUN_READY — NOT a full GATE pass, NOT a
                      Save-only approval; BOM/Submit/Audit/list stay locked.
...
```

## V2. Full-scope behavior is byte-identical to `origin/main`

The original checker (from `origin/main`) and this branch produce identical
full-scope artifacts. `generatedAt`/`inputPath` are the only intended diffs.

```
$ git show origin/main:scripts/ops/integration-k3wise-gate-contract-check.mjs > /tmp/orig-checker.mjs
$ node /tmp/orig-checker.mjs        --init-template /tmp/cmp-orig
$ node scripts/ops/...-check.mjs    --init-template /tmp/cmp-new
$ diff -rq /tmp/cmp-orig /tmp/cmp-new
FULL TEMPLATE BYTE-IDENTICAL

$ diff <(grep -v 'Generated at' /tmp/cmp-orig/out/...md) \
       <(grep -v 'Generated at' /tmp/cmp-new/out/...md)
FULL-CHECK MD IDENTICAL (modulo timestamp)
```

The full template still reports `"sampleCount": 8`, an unfilled full packet still
returns `GATE_BLOCKED` (0 fail / 23 blocked / 0 pass), and the full report shape
carries **no** `scope` / `boundaries` / `materialRead` fields — locked by the test
`full scope is the default and its report shape is unchanged when --scope is omitted`.

## V3. Material-only — unfilled template is `GATE_BLOCKED`

```
$ node ...-check.mjs --init-template /tmp/mo --scope material-only
{ "decision": "TEMPLATE_CREATED", "scope": "material-only", "sampleCount": 1, ... }

$ node ...-check.mjs --scope material-only --input /tmp/mo/k3wise-gate-material-only-packet.template.json --out-dir /tmp/mo/out
{ "ok": false, "decision": "GATE_BLOCKED", "exitCode": 2,
  "summary": { "fail": 0, "blocked": 10, "pass": 0 } }   # 3 read + 5 safety + 2 placeholder-semantics
```

## V4. Material-only — filled packet is `PASS_MATERIAL_DRY_RUN_READY`

After filling O1-MAT (`/K3API/Material/GetDetail`), O1-MAT-M (`POST`), O6, and
`materialOnlySafety` (`materialScopeOnly/bomDeferred/saveOnlySeparateApproval =
true`, `autoSubmit/autoAudit = false`) plus one redacted `materialDetail` sample:

```
{ "ok": true, "decision": "PASS_MATERIAL_DRY_RUN_READY", "exitCode": 0,
  "summary": { "fail": 0, "blocked": 0, "pass": 1 } }
```

Rendered Markdown leads with the boundary block (not a trailing footnote):

```markdown
- Decision: `PASS_MATERIAL_DRY_RUN_READY`
- Stage 1 Lock: `held`

## Boundary (read first)
- This is **Material-only dry-run readiness**, not a full customer GATE pass.
- This does **not** approve Save-only writes.
- This does **not** approve Submit, Audit, or BOM (#1711).
- Save-only still requires a **separate explicit approval** after dry-run review.
- Material-only PASS narrows the validated scope; it does not lift the K3 Stage-1
  lock and does not authorize Save/Submit/Audit/BOM/list/search runtime.
- Authorizes: Read-only Material/GetDetail dry-run only (the path merged in #1868); nothing else.
```

## V5. Material-only safety rejections

- Absolute URL in `O1-MAT` → `FAIL` (`webapiReadList.O1-MAT`, status `fail`).
- Token query in `O1-MAT` (`?access_token=…`) → `FAIL`; evidence does not echo the raw token.
- Raw secret in the `materialDetail` sample (`password`, `?access_token=`) → `FAIL`;
  evidence matches `secret-looking key` and does **not** contain the raw secret values.
- `autoSubmit: true` → `FAIL` (`materialOnlySafety.autoSubmit`).
- `bomDeferred: false` (negated affirmation) → `FAIL` (`materialOnlySafety.bomDeferred`).
- Missing O1-MAT / O6 / `materialDetail` → `GATE_BLOCKED`.
- Missing BOM / pagination / filters / relationship R1–R7 → **does not block** material-only.

## V6. Tests + wiring

```
$ node --test scripts/ops/integration-k3wise-gate-contract-check.test.mjs
ℹ tests 16
ℹ pass 16
ℹ fail 0

$ pnpm run verify:integration-k3wise:gate-contract
ℹ tests 16
ℹ pass 16
ℹ fail 0

$ git diff --check
NO WHITESPACE ERRORS
```

7 pre-existing tests unchanged + 9 new material-only tests, all green. The
existing `verify:integration-k3wise:gate-contract` npm script picks up the new
cases automatically (no script change needed).

## V7. Lock posture

Read-only checker; no K3/MetaSheet contact; no plugin runtime / route / migration
/ RBAC / auth touched. Every report keeps `stage1Lock.status: "held"`. A
Material-only PASS authorizes only the #1868 read-only `Material/GetDetail`
dry-run. Save-only, Submit, Audit, BOM (#1711), list/search, pagination, broad
filters, master-code resolver, and multi-record remain locked; the full customer
GATE is unchanged and still required for any broader scope.
