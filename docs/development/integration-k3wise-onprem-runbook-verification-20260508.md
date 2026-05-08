# Verification: K3 PoC On-Prem Preflight Runbook

**Date**: 2026-05-08
**Design**: `docs/development/integration-k3wise-onprem-runbook-design-20260508.md`
**Files under verification**:
- `docs/operations/k3-poc-onprem-preflight-runbook.md`
- `.gitignore`

---

## Fact-check matrix — runbook ↔ script literal source

Every operator-visible string quoted in the runbook traces to a literal in
`scripts/ops/integration-k3wise-onprem-preflight.mjs` at commit
`b26d3d501` (PR #1433 merge SHA). Confirmed via:

```bash
git show origin/main:scripts/ops/integration-k3wise-onprem-preflight.mjs \
  | grep -nE "(nothing listens on|DNS lookup failed|TCP connect timed out|host .* unreachable|pnpm.*not on PATH|migrations are applied|DB is behind code|kysely_migration|gate-blocked|GATE_BLOCKED|FAIL|PASS|exit 0|exit 1|exit 2)"
```

| Runbook claim | Script source line |
|---|---|
| Decision `0 PASS / 1 FAIL / 2 GATE_BLOCKED` | lines 20–22 (header), 139–141 (`classifyChecks`), 485–487 (MD render) |
| `fail` always wins over `gate-blocked` | line 139 (returns FAIL before checking gate-blocked) |
| `ECONNREFUSED` → "nothing listens on host:port" | line 227 |
| `ENOTFOUND` → "DNS lookup failed for HOST" | line 231 |
| `EHOSTUNREACH` → "host HOST is unreachable" | line 229 |
| `ETIMEDOUT` → "TCP connect timed out" | line 233 |
| Migration check — alignment pass message | line 353 |
| Migration check — drift hint command | line 354 |
| Migration check — `DATABASE_URL not set; cannot query kysely_migration` | line 291 |
| Migration check — `pnpm/tsx not on PATH; …` | line 318 |
| `pendingMigrations` capped at 50 | line 347 (`.slice(0, 50)`) |
| Sanitized URL replaces `<redacted>` for secret query keys | `SECRET_QUERY_PARAM_PATTERN` defined at line 43; `sanitizeUrl()` body lines 64–78; the secret-key replacement loop runs at lines 69–74 |
| Pre-share self-check covers the same secret surfaces the storage-time sanitizer protects | grep set in runbook §"Sharing the artifact safely" (4 checks); see synthetic-leak fixture below for adversarial validation |

## Recipe verification — `--mock` against real Docker prod env

The Docker recipe in runbook §3 is the literal command sequence executed on
machine 142 (`racknerd-0de8668`, Ubuntu 5.15, node v20.20.2, pnpm 10.33.0)
on 2026-05-08:

```
PG_IP=$(docker network inspect metasheet2_default --format '{{range .Containers}}{{if eq .Name "metasheet-postgres"}}{{.IPv4Address}}{{end}}{{end}}' | sed 's:/.*::')
RAW=$(docker exec metasheet-backend printenv DATABASE_URL)
export DATABASE_URL=$(printf '%s' "$RAW" | sed -E "s#^(postgres(ql)?://[^@]+@)[^:/]+#\1$PG_IP#")
unset RAW
export JWT_SECRET=$(docker exec metasheet-backend printenv JWT_SECRET)
cd /home/mainuser/metasheet2
node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir artifacts/integration-k3wise-onprem-preflight/142-real-env
```

Returned `PASS / exit 0`. Result captured in
`artifacts/integration-k3wise-onprem-preflight/142-real-env/preflight.{json,md}`
(local), with `pg.migrations-aligned: pass / applied: 159 / pending: 0` —
i.e., the migration-real-path the unit test suite intentionally cannot cover
was first exercised by following the runbook's recipe.

## Local verification commands

### 1. Markdown links resolve

```bash
# Confirm forward link target exists in repo
test -f docs/operations/integration-k3wise-internal-trial-runbook.md && echo OK

# Confirm script paths cited in runbook exist
test -f scripts/ops/integration-k3wise-onprem-preflight.mjs && echo OK
test -f scripts/ops/integration-k3wise-live-poc-preflight.mjs && echo OK
```

All three return `OK`.

### 2. Pre-share self-check — both clean artifact AND adversarial fixture

The runbook's pre-share self-check has four greps (JSON `password` field,
`eyJ…` JWT shape, secret-keyed URL query params, raw `postgres://user:pass@`
userinfo). Two angles of validation:

**(a) Real, sanitized artifact** — every check returns `0`:

```bash
ART=artifacts/integration-k3wise-onprem-preflight/142-real-env
grep -cE '"password":\s*"[^<]' "$ART"/preflight.json                                                    # → 0
grep -cE 'eyJ[A-Za-z0-9_-]{20,}' "$ART"/preflight.json "$ART"/preflight.md                              # → 0
grep -oE '[?&](access[-_]?token|token|password|secret|sign(ature)?|api[-_]?key|session(_)?id|auth)=[^&"[:space:]]+' \
    "$ART"/preflight.json "$ART"/preflight.md \
  | grep -vEc '=(<redacted>|%3Credacted%3E)$'                                                           # → 0
grep -oE 'postgres(ql)?://[^:/?@[:space:]]+:[^@[:space:]]+@' "$ART"/preflight.json "$ART"/preflight.md \
  | grep -vEc ':(<redacted>|%3Credacted%3E)@$'                                                          # → 0
```

All four return `0` against the real 142 PoC artifact, confirming the new
checks don't false-positive on legitimate sanitized output.

**(b) Synthetic leak fixture** — the new checks catch what the old two miss.

Fixture (an artifact post-edited to introduce a leak the preflight's own
sanitizer would have prevented):

```json
{
  "checks": [
    { "id": "k3.live-config",
      "details": { "apiUrl": "http://k3.example.test:8080/K3API/?access_token=ABC123leak&password=PWleak1234&sign=SIGNleak" } },
    { "id": "env.database-url",
      "details": { "masked": "postgres://metasheet:hunter2_RAW_secret@10.0.0.5:5432/metasheet" } }
  ]
}
```

Running the **old** two-check set against it:

```
"password": JSON-field check → 0   ← MISS (the password leak is in a URL query, not a JSON field)
eyJ JWT-shape check          → 0   ← MISS (no JWT-shaped string)
```

Old self-check would clear this artifact for sharing. That is the gap.

Running the **new** four-check set:

```
JSON-field "password" check  → 0   (no JSON field — same as before)
eyJ JWT-shape check          → 0   (no JWT-shape — same as before)
URL query secret check       → 3   ← CATCHES ?access_token=ABC123leak,
                                       &password=PWleak1234, &sign=SIGNleak
Raw postgres userinfo check  → 1   ← CATCHES postgres://metasheet:hunter2_RAW_secret@
```

The new checks block sharing of the synthetic-leak artifact. Reproducible
with `/tmp/runbook-leak-test/synthetic-leak.json` from the local validation
session that produced this report.

**Acceptable values** — both new checks normalize against `<redacted>` (the
literal string written by `redactString` to stdout/MD) and `%3Credacted%3E`
(the URL-percent-encoded form `JSON.stringify` produces from the same value
inside a `URL` object's query). The grep `-v` filters those acceptable
markers before counting, so a legitimately-sanitized artifact returns `0`.

### 3. Existing test suites unaffected

Doc-only PR + one ignore rule. No script change.

```bash
pnpm verify:integration-k3wise:onprem-preflight   # 14/14 PASS
pnpm verify:integration-k3wise:poc                # 37 unit + mock chain PASS
```

(Both were last green on commit `b26d3d501`; this PR doesn't touch any source
file they cover, so they remain green.)

### 4. Gitignore rule effect

```bash
echo "test" > artifacts/integration-k3wise-onprem-preflight/test/marker
git status --porcelain artifacts/integration-k3wise-onprem-preflight/
# Expected: empty (rule excludes the path)
rm -rf artifacts/integration-k3wise-onprem-preflight/test
```

Empty output confirms the rule is effective.

## CI status

CI is not modified by this PR.

- No CI workflow file is touched.
- No script source is touched, so existing test gates are unaffected.

## Deployment impact

**None.** Doc + ignore rule only.

## Customer GATE status

PR is **outside** the GATE block:

- No real ERP business behaviour, no integration-core changes.
- Stage 1 Lock memory remains in force.

## Worktree

Branch: `codex/integration-k3wise-onprem-runbook-20260508` (forked from
`origin/main` at `1b06bf286`).
Cwd: `/Users/chouhua/Downloads/Github/metasheet2`.
