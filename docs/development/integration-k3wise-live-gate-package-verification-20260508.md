# Verification: K3 WISE Live GATE Execution Package

**Date**: 2026-05-08
**Design**: `docs/development/integration-k3wise-live-gate-package-design-20260508.md`
**Files under verification**:
- `docs/operations/integration-k3wise-live-gate-execution-package.md`

---

The PR is doc-only with no script, runtime, or CI changes; the verification
matrix below is the entire validation surface. Each row is a literal command
the reviewer can re-run against the runbook at this commit.

## Five-point validation matrix

### 1. No secret example values

The runbook intentionally uses two sanctioned placeholder strings:
`<fill-outside-git>` (for credential slots, copied from
`scripts/ops/integration-k3wise-live-poc-preflight.mjs`'s own `--print-sample`
output) and `<redacted>` / `%3Credacted%3E` (when explaining the on-prem
preflight artifacts' redaction format). Anything else that looks like a
secret would be a leak.

```
RUNBOOK=docs/operations/integration-k3wise-live-gate-execution-package.md
$ grep -cE 'eyJ[A-Za-z0-9_-]{20,}' "$RUNBOOK"                                     → 0
$ grep -cE '\bBearer\s+[A-Za-z0-9._~+/=-]+' "$RUNBOOK"                            → 0
$ grep -oE 'postgres(ql)?://[^:/?@[:space:]]+:[^@[:space:]]+@' "$RUNBOOK" \
    | grep -vEc ':(<redacted>|%3Credacted%3E|<fill-outside-git>)@$'               → 0
$ grep -oE '[?&](access[-_]?token|token|password|secret|sign(ature)?|api[-_]?key|session(_)?id|auth)=[^&"[:space:]]+' "$RUNBOOK" \
    | grep -vEc '=(<redacted>|%3Credacted%3E)$'                                   → 0
```

All four counts are `0`. The only non-zero matches in adjacent contexts are
the sanctioned placeholders themselves (3 mentions of `<fill-outside-git>`
and 2 mentions of `<redacted>`).

### 2. All referenced repo paths exist

Every backticked `scripts/...` or `docs/...` path in the runbook resolves to
a file present in the worktree at this commit:

```
$ for p in $(grep -oE '`(scripts|docs)/[a-zA-Z0-9._/-]+`' "$RUNBOOK" \
              | tr -d '`' | sort -u); do
    [ -e "$p" ] && echo "EXIST $p" || echo "MISS  $p"
  done

EXIST docs/operations/integration-k3wise-internal-trial-runbook.md
EXIST docs/operations/k3-poc-onprem-preflight-runbook.md
EXIST scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
EXIST scripts/ops/integration-k3wise-live-poc-evidence.mjs
EXIST scripts/ops/integration-k3wise-live-poc-preflight.mjs
EXIST scripts/ops/integration-k3wise-onprem-preflight.mjs
EXIST scripts/ops/integration-k3wise-postdeploy-smoke.mjs
```

7/7. No `MISS`.

### 3. env ↔ gate JSON field mapping consistent with existing scripts

The runbook differentiates **script-enforced** fields (where
`normalizeGate()` throws on violation) from **operator-reviewed** fields
(where the customer answer matters at C4 testConnection or later but the
preflight script does not raise on its absence). This section verifies
both classifications are accurate at this commit, including the
counterexamples §3.3 — fields the runbook deliberately marks "not
script-enforced" because reviewing the source proved the script accepts
them as optional.

#### 3.1 env-var set is set-equal to what the on-prem preflight reads

```
$ diff \
    <(grep -oE '\b(K3_API_URL|K3_BASE_URL|K3_ACCT_ID|K3_USERNAME|K3_PASSWORD|DATABASE_URL|JWT_SECRET)\b' \
        "$RUNBOOK" | sort -u) \
    <(grep -oE 'env\.(K3_API_URL|K3_BASE_URL|K3_ACCT_ID|K3_USERNAME|K3_PASSWORD|DATABASE_URL|JWT_SECRET)\b' \
        scripts/ops/integration-k3wise-onprem-preflight.mjs | sed 's/env\.//' | sort -u)

# (no output)
```

`diff` empty → identical sets. Both contain exactly:
`DATABASE_URL`, `JWT_SECRET`, `K3_ACCT_ID`, `K3_API_URL`, `K3_BASE_URL`,
`K3_PASSWORD`, `K3_USERNAME`.

Note: there is **no** `K3_SESSION_ID` env path. This is the C2-vs-C3
divergence the runbook spells out under A.2 — see §3.3 below.

#### 3.2 GATE JSON paths the runbook marks **enforced** map to throw-sites

| Runbook claim | Source line(s) in `integration-k3wise-live-poc-preflight.mjs` |
|---|---|
| `tenantId` required | `REQUIRED_TOP_LEVEL` (line 6) + `requiredString` |
| `workspaceId` required | `REQUIRED_TOP_LEVEL` (line 6) + `requiredString` |
| `k3Wise.version` required | `requiredString(k3Wise.version, 'k3Wise.version')` |
| `k3Wise.apiUrl` http/https required | `validateUrl(k3Wise.apiUrl \|\| k3Wise.baseUrl, 'k3Wise.apiUrl')` |
| `k3Wise.acctId` required | `requiredString(k3Wise.acctId, 'k3Wise.acctId')` |
| `k3Wise.environment` ∈ non-production set | `NON_PRODUCTION_ENVS` whitelist (line 8) |
| `k3Wise.autoSubmit=false` / `k3Wise.autoAudit=false` | `LivePocPreflightError('M2 live PoC packet is Save-only…')` |
| K3 credentials sessionId-OR-(user+pass) | `assertK3AuthContract(k3Wise)` (lines 171–183) |
| `plm.readMethod` required | `requiredString(plm.readMethod, 'plm.readMethod')` (line 386) |
| `plm.baseUrl` http/https when supplied | `if (optionalString(plm.baseUrl)) validateUrl(plm.baseUrl, …)` (line 387) |
| `plm.defaultProductId` ∨ `bom.productId` when `bom.enabled=true` | `bomEnabled && !bomProductId` throws |
| `fieldMappings.material` includes FNumber + FName | `assertRequiredTargetFields(…, MATERIAL_REQUIRED_TARGET_FIELDS, …)` |
| `fieldMappings.bom` includes parent + child + qty when BOM enabled | same with `BOM_REQUIRED_TARGET_FIELDS` |
| `sqlServer.mode` ∈ {readonly, middle-table, stored-procedure} | `normalizeSqlMode` throws otherwise |
| `sqlServer.allowedTables` non-K3-core when mode≠readonly | `writesCoreTable` cross-check at line 349, throw at line 350 |
| `sqlServer.writeCoreTables=false` (or mode=readonly) | same throw at line 350 |
| `rollback.owner` / `rollback.strategy` required | `requiredString(rollback.owner, …)` + `requiredString(rollback.strategy, …)` |

Every path the runbook **explicitly marks "enforced"** maps to a literal
throw-site or whitelist set in the script.

#### 3.3 GATE JSON paths the runbook marks **operator-reviewed (not script-enforced)**

These fields' presence and validity are operator concerns, not preflight
script concerns. The runbook calls them out so operators do not assume a
green C3 means everything is validated.

| Runbook claim | Why not enforced |
|---|---|
| `plm.credentials.{username,password}` operator-reviewed; not script-enforced; surfaces at C4 testConnection | `normalizeGate()` only requires `plm.readMethod`. There is no `requiredString(plm.credentials.username, …)` etc. anywhere in the script. (`grep -nE "plm\.credentials\|requiredString.*plm" scripts/ops/integration-k3wise-live-poc-preflight.mjs` returns only the `readMethod` line.) |
| `sqlServer.server` / `sqlServer.database` operator-reviewed | `optionalString(gate.sqlServer.server) \|\| '<provided-by-customer>'` (line 512), same for `database` (line 513). Missing values fall back to a placeholder string and the build proceeds. |
| `sqlServer.middleTables` not core-table-checked by C3 | The core-table prohibition only iterates `allowedTables`: `const writesCoreTable = allowedTables.some((table) => K3_CORE_TABLES.has(…))` (line 349). A `mode=middle-table` packet with `t_icitem` in `middleTables` passes the build silently. The runbook explicitly warns operators to review this. |
| `sqlServer.storedProcedures` non-empty when `mode=stored-procedure` | `optionalArray(gate.sqlServer.storedProcedures, …)` (line 516). Empty array is accepted; the script does not enforce that procedures are listed. |
| `sqlServer.credentials` operator-reviewed | No `requiredString(sqlServer.credentials.username, …)` etc. |
| C2 (on-prem preflight) sessionId-only support | `checkLiveK3Config` always requires `K3_USERNAME` + `K3_PASSWORD` env vars (lines 379–386 of `integration-k3wise-onprem-preflight.mjs`). There is no env path for sessionId. C3 supports sessionId, C2 does not — a real divergence the runbook surfaces under "C2 vs C3 K3-credential divergence". |

Each "not enforced" claim is supported by literal source-line evidence. The
verification MD therefore does **not** assert "5/5 hard constraints
script-enforced" — it asserts "every claim in the runbook accurately
reflects what the script actually does today, including the limits".

### 4. No production write claim, Save-only contract preserved

#### 4.1 The only `production` mentions are in reject / forbidden contexts

```
$ grep -nE 'production' "$RUNBOOK"

(line in A.1)        K3 environment label … **production is rejected** …
                     one of `test` / `testing` / `uat` / `sandbox` / `staging` / `dev` / `development`
(line in Stage D)    "environment must not be production", "BOM mapping must …
(line in Stage D)    "why production is forbidden", "why BOM requires product
```

Three mentions, all in reject/forbidden/audit contexts. **Zero claims of
production write.** The previously fuzzy "production-like flows" wording
in the See-also section was tightened to "once a real deployment is up"
before this matrix was finalised.

#### 4.2 Save-only is asserted, not bypassed

The runbook's C-step rows treat `autoSubmit=false` and `autoAudit=false` as
contractual:

- A.2 (K3 connection): `autoSubmit` / `autoAudit` rows mark them as "must
  be `false` (Save-only safety) — enforced — packet build throws if true".
- C3 (Build packet): PASS criterion includes `safety.saveOnly=true /
  autoSubmit=false / autoAudit=false`.
- C6 (Material Save-only PoC): PASS criterion enforces 1–3 rows with
  `autoSubmit=false / autoAudit=false`; FAIL criterion explicitly lists
  "row count 0 or > 3; autoSubmit or autoAudit true".
- C7 (BOM Save-only PoC): same Save-only constraint.
- C10 (Evidence compiler): FAIL on `SAVE_ONLY_VIOLATED`,
  `SAVE_ONLY_ROW_COUNT`, `SAVE_ONLY_RUN_ID_REQUIRED`, etc.

No step in the runbook tells the operator to disable, override, or skip the
Save-only contract.

### 5. Live preflight remains blocked until customer GATE arrives

The runbook states this as an explicit invariant in two places:

1. **Conventions section** (highly visible, near the top):

   > Live preflight (Stage C step C2 onward) is gated by customer GATE
   > arrival. Until the customer has supplied A.1–A.6 answers, `--live`
   > runs return `exit 2 / decision=GATE_BLOCKED` by design (the on-prem
   > preflight script raises `gate-blocked` for any missing K3 field).
   > Do not bypass this gate — it is the contract, not a defect.

2. **Stage C row C2**:

   > exit 1 (mandatory) or exit 2 (`GATE_BLOCKED` — customer field still
   > missing)

The "When to use" trigger list also gates "live PoC execution" on receiving
GATE answers.

```
$ grep -nE 'GATE_BLOCKED|gate-blocked|customer GATE|customer.*GATE' "$RUNBOOK" \
    | wc -l
≥ 4
```

## Existing-test-suite regression

Doc-only PR. No script, runtime, or test-fixture file is changed.

```
$ pnpm verify:integration-k3wise:onprem-preflight     # 14/14 PASS
$ pnpm verify:integration-k3wise:poc                  # 37 unit + mock chain PASS
```

Both were last green at the merge of PR #1437; neither test suite reads the
new docs, so they remain green.

## CI status

Not modified. No CI workflow file is touched.

## Deployment impact

**None.** Doc-only.

## Customer GATE status

Outside the GATE block. Stage 1 Lock memory remains in force.

## Worktree

Branch (planned): `codex/integration-k3wise-live-gate-package-20260508`,
forked from `origin/main` once PR #1442 (`docs(integration): expand K3 WISE
internal-trial runbook with host-shell path`) merges.

Until that branch is created, the three files live as untracked drafts on
the operator workstation; they are deliberately NOT staged into PR #1442.

Cwd: `/Users/chouhua/Downloads/Github/metasheet2`.
