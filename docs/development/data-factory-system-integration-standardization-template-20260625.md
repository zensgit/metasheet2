# System-integration standardization template (2026-06-25)

> Purpose: onboard every new external database/system the **same way**, by walking one 7-layer checklist instead of re-deriving each integration by hand. Each layer names the existing building block to reuse, the per-new-system checklist, and the non-negotiable discipline. Read-first, dormant-by-default, write-gated, values-free throughout. This is a reusable template — it authorizes nothing by itself.

## The 7 layers (in order)

### 1. Source registration
- **Building block:** `external-systems.cjs` registry (tenant/workspace/project scope; role source/target/bidirectional; pipeline-ref-protected; `lastTestedAt`/`lastError`).
- **Checklist:** register the system with `kind` + `role`; kind/role immutable after create; public reads expose only a fingerprint + `hasCredentials`, never plaintext.
- **Discipline:** one registry entry per system; never inline credentials in config.

### 2. Credential store
- **Building block:** `credential-store.cjs` (AES-256-GCM; host-backed `enc:` when `context.services.security`, else local `v1:`; `INTEGRATION_ENCRYPTION_KEY` mandatory in production).
- **Checklist:** provision credentials via the store only — never from request body / preset / browser; verify the prod key is set (startup refuses if missing).
- **Discipline:** credentials never logged, never echoed, never in evidence.

### 3. Object / schema / read
- **Building block:** the source adapter (`erp:*` / `data-source:sql-readonly` / `http` / `bridge:*`); `createReadResult`; reference harvest.
- **Checklist:** declare objects + schema; **read-only first**; the read path is **dormant/fail-closed** (runs only when the object explicitly enables `operations:['read']` — default stays non-read); reject missing keys; **wire-vs-fixture test** (assert the real wire round-trips the harvested fields against a redacted fixture, plus failure-path negatives — not a hand-built object). *(Pattern: K3 Material read smoke #1868.)*
- **Discipline:** no broad/raw query surface; no server-side composition; read adds no write.

### 4. Pipeline runner
- **Building block:** `pipelines.cjs` (define/upsert/list) + `pipeline-runner.cjs` (run state machine: pending→running→succeeded/partial/failed/cancelled; modes incremental/full/manual).
- **Checklist:** wire source→multitable-hub; record source/clean/write/skip/fail counts + capped sanitized `targetWriteSummaries`; ensure re-run idempotency (re-pull add=0/skip=N).
- **Discipline:** import to the multitable hub first (clean/validate there), not point-to-point.

### 5. Provenance / dead-letter
- **Building block:** per-row provenance events (`integration_runs.provenance_events`, by-row view) + dead-letter store (open/replayed/discarded, idempotency-keyed) + single manual replay (#1857).
- **Checklist:** emit per-row lineage (read→mapped→validated→write result+reason); route failures to dead-letter; expose read-only monitoring; replay is single + confirm-gated.
- **Discipline:** provenance/dead-letter payloads redacted; no bulk auto-replay (that's DF-N3, gated).

### 6. Option / template mapping
- **Building block:** `connector-template-derive.cjs` (gated-field templates) + option-sourcing (option-sourced select fields from a contract/config).
- **Checklist:** map the system's enums/dictionaries to option-sourced fields; derive templates with gated fields; keep mapping declaration narrow + declaration-gated.
- **Discipline:** mapping is a declaration the FE/contract validates defensively (malformed → manual/no-op); no silent coercion.

### 7. Write gate / runbook
- **Building block:** the production-write discipline — dormant policy contract + guarded runtime (FOS-4b-3 P1/P2 as the reference) + dry-run (C6) + production runbook + values-free evidence.
- **Checklist:** writes start **dormant / dry-run only**; sandbox-first validation (gate / idempotency / human-field / route-parity, values-free); the **first real write of any kind = a separate explicit owner authorization** (bounded target/route/action/count/short-expiry) + runbook + rollback/evidence.
- **Discipline:** no write enabled by default; no env switch for production; canonical/external write rejected without an explicit server-config policy; manual-confirm rows held; fresh-dry-run-token required.

## New-system onboarding checklist (one row per layer)

```text
☐ 1 source registered (kind/role/scope; credential boundary)            [external-systems]
☐ 2 credentials in the store (prod key set; never request/preset)        [credential-store]
☐ 3 objects/schema; READ-ONLY, dormant/fail-closed; wire-vs-fixture test [source adapter]
☐ 4 pipeline source→multitable-hub; counts; re-run idempotent            [pipelines + runner]
☐ 5 per-row provenance + dead-letter + single confirm-gated replay       [provenance/dead-letter]
☐ 6 option/template mapping (option-sourced; defensive declaration)       [template-derive]
☐ 7 writes dormant/dry-run; sandbox-first; first real write = owner gate  [write gate + runbook]
```

## Discipline (applies to every layer)

```text
read-first         : add the read path before any write capability exists
dormant-by-default : new capability ships off; explicit server-config (not env, not request) to enable
values-free        : evidence/logs carry hashes/kinds/counts only — no ids/values/credentials/SQL/payloads
write-gated        : first real write of any kind = separate explicit owner authorization (per layer 7)
wire-vs-fixture    : any field crossing the real wire has a test asserting it round-trips (not a fixture)
```

## Status of the reference implementation (what already exists to copy)

```text
layers 1–6 : MATURE for the current connectors (K3 WISE WebAPI read #1868 + SQL channel, data-source SQL,
             HTTP, PLM/Yuantus, bridge, multitable hub); provenance DF-N2-2 + dead-letter DF-N1.5 shipped
layer 7    : reference = FOS-4b-3 (P1 contract + P2 dormant runtime + P3 runbook); C6 dry-run; production
             write CLOSED by default — first real write remains an owner gate
```
