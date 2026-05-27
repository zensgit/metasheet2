# K3 WISE Material-only GATE Checker — Design (2026-05-26)

Issue: #1792 (Customer GATE — K3 WISE live PoC intake and dry-run signoff)
Tool: `scripts/ops/integration-k3wise-gate-contract-check.mjs`
Branch: `integration/k3wise-material-only-gate-checker-20260526`

## 1. Why #1792 needs a Material-only fast lane

The original GATE-front checker validates the **full** K3 WISE WebAPI read/list +
relationship-mapping packet in one shot: 12 read answers (O1-MAT … O6), 7
relationship answers (R1–R7), and 8 redacted samples (Material list/detail, BOM
list/detail, flat/tree BOM, unresolved-child, K3 BOM Save shape). That is the
right bar for the full customer GATE, but it is **larger than what the current
#1792 work actually needs**.

The latest owner/operator confirmations on #1792 have narrowed the *first* live
step to a deliberately small slice:

- First live PoC scope is **Material only**; BOM is deferred until Material passes
  and must not be guessed.
- The first Material dry-run preview scope is **minimal** (`FNumber` / `FName`);
  `FModel` and unit mapping stay deferred until the customer confirms fields.
- The only runtime that exists for this is the already-merged **read-only
  `Material/GetDetail`** smoke (#1868). No Save, Submit, Audit, BOM, list/search,
  pagination, broad filters, master-code resolver, or multi-record is approved.

Under the full checker, this Material-first slice can never reach a green
`decision` because it is missing BOM samples, relationship R1–R7, pagination and
filter answers — none of which the customer is being asked to provide yet.
Operators were left reading a permanent `GATE_BLOCKED` for a slice that is, on
its own terms, ready to dry-run. That is the gap this change closes: it adds a
**smaller, explicitly-labelled sub-acceptance** that matches the Material-first
slice, without redefining or weakening the full GATE.

## 2. What the Material-only mode is (and is not)

`--scope material-only` is a **strict subset** of the full contract:

| | Full (`--scope full`, default) | Material-only (`--scope material-only`) |
|---|---|---|
| Read answers required | O1-MAT, O1-MAT-M, O1-BOM, O1-BOM-M, O2-P/T/C, O3-F/M, O4-MAT, O4-BOM, O6 | **O1-MAT, O1-MAT-M, O6 only** |
| Relationship R1–R7 | required | **not required** |
| Samples required | 8 (material + BOM + relationship) | **1 (`materialDetail`)** |
| Safety answers | — | **`materialOnlySafety.answers` (5)** |
| Pass decision | `PASS` | `PASS_MATERIAL_DRY_RUN_READY` |

The Material-only pass decision is intentionally **not** `PASS`. It is
`PASS_MATERIAL_DRY_RUN_READY`, the JSON/Markdown carry `scope: "material-only"`,
and the report leads with a boundary block. A reader who only skims the decision
line cannot mistake it for a full GATE pass.

### New packet section: `materialOnlySafety.answers`

Because the Material-only slice carries safety commitments that the full read/list
packet does not encode, the schema gains an optional `materialOnlySafety.answers`
block. All five are required in material-only mode:

- `materialScopeOnly` — first live scope is Material only. (must affirm)
- `bomDeferred` — BOM is deferred until Material passes. (must affirm)
- `saveOnlySeparateApproval` — Save-only needs a separate explicit approval after
  dry-run review. (must affirm)
- `autoSubmit` — **must be `false`** (boolean, or `no`/`off`/`否`/`关闭`).
- `autoAudit` — **must be `false`** (same).

The three affirmations fail only if explicitly negated (a `false`/`no` value); the
two write-action flags fail unless they are unambiguously false. Anchored matching
is deliberate — a fuzzy "false (but…)" value should be rejected, because these are
safety switches, not prose.

## 3. What is still required / rejected in Material-only mode

Material-only is *smaller*, not *looser*. It still enforces every safety property
that applies to the Material slice:

- `O1-MAT` must be a **relative** path (an absolute `http(s)://` URL → `FAIL`).
- `O1-MAT` must not carry a **secret-looking query** (e.g. `?access_token=…`) → `FAIL`.
- `O1-MAT-M` must be `GET`/`POST`.
- The `materialDetail` sample must contain a material-shaped row (number + name).
- The **sample secret scan is unchanged**: JWT/Bearer/connection-string/secret-key
  values in the sample → `FAIL`, and the evidence never echoes the raw secret.
- Secret hygiene is **not** scope-narrowed: every answer the customer provides
  (read answers + safety answers) is scanned, even fields material-only does not
  require.

Missing required items (O1-MAT / O1-MAT-M / O6 / `materialDetail` / any safety
answer) → `GATE_BLOCKED` (exit 2). Format/secret violations → `FAIL` (exit 1).

## 4. What stays locked (unchanged by this PR)

This change is GATE-front **evidence tooling** only. It is read-only, contacts
neither K3 nor MetaSheet, and touches no plugin runtime, route, DB migration,
RBAC, or auth. `stage1Lock.status` stays `held` in every report. A
Material-only PASS authorizes **nothing beyond** the already-merged read-only
`Material/GetDetail` dry-run (#1868). Explicitly still locked:

- **Save-only** — even after a Material-only PASS and a clean dry-run, Save-only
  needs a separate explicit approval. This checker never approves it.
- **Submit / Audit** — out of scope.
- **BOM / #1711** — relationship runtime stays blocked on relationship evidence;
  do not implement by guessing.
- **list / search, pagination, broad filters, master-code resolver, server-side
  pipeline composition, multi-record** — none approved.
- The **full customer GATE** is unchanged and still required for any broader
  scope. Full-scope checker behavior is byte-identical to before (verified).

## 5. Operator flow

```bash
# 1. Generate the minimal Material-only packet (outside Git)
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --init-template /path/outside-git/k3wise-gate-material-only --scope material-only

# 2. Customer fills O1-MAT / O1-MAT-M / O6 + materialOnlySafety + one redacted materialDetail sample

# 3. Check
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --scope material-only \
  --input /path/outside-git/k3wise-gate-material-only/k3wise-gate-material-only-packet.template.json \
  --out-dir /path/outside-git/k3wise-gate-material-only/check-filled
```

Only on `PASS_MATERIAL_DRY_RUN_READY` does the read-only `Material/GetDetail`
dry-run proceed. Save-only remains a separate, later, explicit decision.

See the companion verification doc:
`integration-k3wise-material-only-gate-checker-verification-20260526.md`.
