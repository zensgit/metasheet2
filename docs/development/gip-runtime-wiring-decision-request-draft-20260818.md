# GIP runtime wiring — owner decision request (DRAFT, 2026-08-18)

**0. STATUS — DRAFT. This document is NOT an authorization.** Nothing here arms, wires, activates, deploys or
rolls out anything. No code changes with this file. It exists because the GIP line's remaining critical path is
an owner ruling (`remaining-delivery-plan-and-model-allocation-20260806.md` §0/§6) and **no issue currently asks
for that ruling** (`gh issue list --state open --search "gip"` → empty, 2026-08-18). The gate that forbids the
work is `database-system-integration-line-design-and-verification-20260724.md` **Gate / §3.0 / §6**; only the
owner may widen it.

---

## 1. What is requested — and what is not

**Requested: one bounded runtime seam, default OFF.** Authorization to open a *single* admin-only internal route
over the already-landed B1a authority substrate, so that a binding qualification can be produced by the
**server-bound** path (resolver → identity read → canonical-contract lookup → certified HTTP probe action →
prober), behind one env flag that defaults OFF, following the **exact** pattern of the one wired sealed-export
piece (`stockPreparationSqlServerRuntime`, `index.cjs` L292-306 / `http-routes.cjs` L146-150, L5219-5230,
L5322-5325). Flag OFF ⇒ the route is **not registered at all** and the process surface is byte-identical to today.

**NOT requested, and explicitly out of scope:** external write-back; CDC; `bridge.sealed_snapshot.v1` and any
sealed-snapshot bridge work; D2/W3/G1; rollout, deployment, or a flag default of ON; any customer-system
connection; page-size ceiling changes; B1-observability counter/handshake wiring (§4 item 5); B1c cross-page
consistency; #4591 (B2 enforcement, merges LAST); arming any Read Action Profile.

---

## 2. Prerequisites the gate names — status on `main` today

| Prereq (§4 / §3.0) | Status | Evidence |
|---|---|---|
| **1.1** config v2 (`orderingKeySpec`, `actionProfileVersion`) accepted **and persisted** | **DONE** | `lib/read-source-config.cjs` L66-77 (allowlist) **and** L374-379 (`normalizeReadSourceConfig` projection — the second enforcement point); #4601 `cd2670695` |
| **1.2** system identity read, GIP-D0 §6 formula + (β) closed connector-kind registry | **SUBSTRATE DONE / (β) ALIAS MAP OPEN** | `lib/gip-system-identity-read.cjs` L292-303 (four-term formula), L384 `SYSTEM_IDENTITY_KIND_UNCERTIFIED`; but `lib/gip-connector-kind-registry.cjs` **L378 ships EMPTY** (`buildTrustedConnectorKindRegistry([])`). §4.0 ⟲OD2 requires a privately-authorized **real inventory run**; none recorded. #4610 `3f60b3d7d`, probe tool #4603 `97cf62033` |
| **1.3** (γ) first-party canonical object contract registry + backfill | **SUBSTRATE DONE / BACKFILL OPEN** | `lib/gip-canonical-object-contract-registry.cjs` **L570 ships EMPTY**; `assertCanonicalObjectContractRegistryActivationReady` exported (L720). Backfill list absent — same ⟲OD2 ruling. #4610 |
| **1.4** server-bound source executor, δ=(c) HTTP-only, builders by module-private identity | **SUBSTRATE DONE / CERTIFIED ACTIONS OPEN** | `lib/gip-server-bound-source-executor.cjs`; **L365 `CERTIFIED_HTTP_PROBE_ACTION_REGISTRY` ships EMPTY**; #4625 `ebf84f249` |
| **1.5** legacy `probe()` removed/privatised | **DONE** | `lib/gip-binding-qualification-spike.cjs` L335-343 — frozen prober's exact key set is `{ probeFromResolution }`; #4625 |
| **1.6** counter + handshake shapes frozen, **no wiring** | **DONE** | `lib/gip-read-observability-contracts.cjs`; #4625 |
| **B-1** evidence provably from the bound system | **DONE at module level** | `__tests__/gip-server-bound-source-executor.test.cjs` L420 — the "two resolutions bound to DIFFERENT systems must not both qualify" control |
| **B-2** identity ≠ whole-config hash | **DONE / gated on (β)** | as 1.2 |
| **B-3** `canonicalObjectVersion` looked up, never invented | **DONE / gated on (γ)** | as 1.3 |
| **B-4** builders by identity, denylist only defence-in-depth | **DONE** | as 1.4 |
| **B-5** certification only on a **verified** guarantee | **PARTIAL** | evidence-only spike #4620 `ed7a73953`; first certified strategy `(sqlserver, {2019,2022}, rcsi_on)` #4665 `5d785e399`, which refuses under default READ COMMITTED (`SQLSERVER_RCSI_POSTURE_UNPROVEN`). **MySQL: no certified strategy on main ⇒ OPEN** |
| **B-6** v1 = (c), SQL builders unreachable | **DONE** | #4625; SQL builders remain on no probe path |
| §4 item 5 precondition: agent/protocol-version certification-scoped preflight | **UNKNOWN** — no producer located on main | — |
| §4 item 6 customer migration · item 7 #4591 | **OPEN** | #4591 state = OPEN (DRAFT, merges LAST) |

**Net:** the B1a redo's *code* is landed; what is missing is the **(β) alias map** and the **(γ) backfill list**,
both of which §4.0 ⟲OD2 puts behind a separately-authorized real inventory run. The wiring below is designed so
that this is *safe*: with both registries empty, flag ON reaches only closed refusals.

---

## 3. Proposed wiring, module by module

One flag: **`INTEGRATION_GIP_BINDING_QUALIFICATION_RUNTIME_ENABLED`**, default **OFF**; enabled only when
`String(env[FLAG] ?? '').trim().toLowerCase() === 'true'` (the shipped `featureEnabled` literal in
`lib/sealed-export/stock-preparation-runtime-config.cjs`) — no `1`, no `yes`, no truthiness.
One capability field: **`capabilities.gipBindingQualificationRuntime`** in `index.cjs` `buildCapabilityStatus()`.
One route, appended to `ROUTES` **only when the runtime object exists**:
`POST /api/integration/internal/gip/binding-qualification/probe` (admin-only).
Handler guard token when the runtime is absent: **`GIP_BINDING_QUALIFICATION_RUNTIME_DISABLED`** (404) — pure
defence-in-depth, since flag OFF means the route was never registered.

| LATENT module | Becomes | Fail-closed reason when unreachable |
|---|---|---|
| `gip-approved-binding-resolver` | constructed inside the gated runtime; the route's only tuple source | `READ_SOURCE_CONFIG_NOT_APPROVED` / resolver's frozen vocabulary |
| `gip-system-identity-read` + `gip-connector-kind-registry` | resolver's certified system-identity authority | `SYSTEM_IDENTITY_KIND_UNCERTIFIED` (empty registry ⇒ **every** kind refuses) |
| `gip-canonical-object-contract-registry` | resolver's certified canonical-object authority; `assertCanonicalObjectContractRegistryActivationReady` runs at construction | `CANONICAL_OBJECT_CONTRACT_UNREGISTERED` |
| `gip-server-bound-source-executor` | executor built at construction; certified HTTP action registry only | `PROBE_EXECUTOR_UNTRUSTED` / action-unregistered |
| `gip-binding-qualification-spike` | `probeFromResolution` is the route's single verb | `PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED` |
| `gip-inert-entry`, `gip-canonical-json`, `gip-profile-certification-contracts`, `gip-profile-compliance-harness` | already required by the above; no new surface | unchanged |
| `gip-read-observability-contracts` | **stays latent** (§4 item 5, own gate; preflight UNKNOWN) | — |
| `gip-bridge-bounded-read-profile` | **stays latent** (arming a profile is forbidden) | — |
| `gip-sqlserver-rcsi-total-order-strategy` | **stays latent** (δ=(c): SQL builders unreachable) | — |
| `gip-sqlserver-snapshot-page-sequence-{executor,strategy}`, `-paged-read-profile` | **stay latent** (B1c) | — |
| `lib/sealed-export/*` | **stays latent** except the already-wired `stockPreparationSqlServerRuntime` | — |

**Tests that change from "asserts LATENT" to "asserts gated":** the LATENT headers of the five wired modules are
rewritten to name the flag and route; `gip-approved-binding-resolver` / `gip-server-bound-source-executor` /
`gip-binding-qualification-spike` / `gip-system-identity-read` / `gip-canonical-object-contract-registry` suites
each gain a flag-ON construction case alongside their existing hermetic ones. Everything else stays as-is.

---

## 4. Negative controls the wiring PR must ship

1. **Flag OFF ⇒ route absent from the registered set** — the literal mirror of the shipped assertion at
   `__tests__/http-routes.test.cjs` L8874 (`'flag-off construction does not register the controlled runtime route'`).
2. **Inert entry gate still refuses** — `__tests__/gip-inert-entry-gate.test.cjs` re-run with the runtime
   constructed: every hostile-matrix cell still pins its exact L1 token, L2 still emits `*_ENTRY_NOT_INERT`.
3. **Registries unchanged** — `__tests__/gip-b1b-registry-unchanged.test.cjs` green **unmodified**: no strategy
   registered, no certification vocabulary widened.
4. **`integration-guard`** (one of main's 9 required checks; runs the whole `plugin-integration-core` CJS chain)
   green on the PR head.
5. **Empty-registry refusal** — flag ON with the shipped empty (β)/(γ) registries ⇒ closed refusal token, **zero**
   outbound calls; plus the **positive control** (harness registries ⇒ one qualification), so 5 is not produced by
   a runtime that refuses everything.
6. **Capability/health parity** — flag OFF ⇒ `capabilities.gipBindingQualificationRuntime === false` and the
   `/api/integration/health` payload is otherwise unchanged.

---

## 5. Rollback

Unset the flag, or set anything other than `true`. The runtime object is then never constructed, the route is
never registered, and the capability field reads `false` — the exact prior surface. **No migration, no new table,
no data, no external call, no persisted state**; `deactivate()` already nulls the runtime handle. Rollback is a
process restart, not a revert.

---

## 6. Owner decision block

The owner may rule by publishing exactly one line:

```text
ownerGipRuntimeWiringDecision=<TOKEN>
```

Candidate tokens (exactly one):

- `APPROVE_WIRING_V1_FLAG_OFF` — authorizes §3 as written: one admin-only internal route, flag default OFF,
  δ=(c) HTTP-only, no profile arming, no observability wiring, no deployment.
- `DEFER_UNTIL_B1A_REDO` — the (β) alias map and (γ) backfill list must land from an authorized inventory run
  first; nothing in §3 may be built until then.
- `REJECT` — the seam is not opened; the modules stay LATENT indefinitely.

Fields the owner must fill alongside the token:

```text
ownerGipRuntimeWiringDecision=
flagDefault=OFF
routeScope=INTERNAL_ADMIN_ONLY
customerSourceAccess=            # NOT_AUTHORIZED | <named exception>
externalWrite=false
betaAliasMapAuthorized=          # YES | NO  (real inventory run for (β))
gammaBackfillAuthorized=         # YES | NO  (real inventory run for (γ))
observabilityWiring=NOT_AUTHORIZED
deployment=NOT_AUTHORIZED
```

---

## 7. Open questions (5)

1. Does `APPROVE_WIRING_V1_FLAG_OFF` also authorize the **(β)/(γ) inventory runs**, or is that a separate
   authorization? With both registries empty the route can only refuse.
2. Is the **agent/protocol-version certification-scoped preflight** (§4 item 5 precondition, §2 M1) a hard gate
   for *this* seam, or only for observability wiring and arming? No producer for it was located on main.
3. Should the route live in `plugin-integration-core`'s `ROUTES` at all, or behind a **cross-plugin
   communication verb** only (no HTTP surface)? The gate forbids "any NEW request-reachable surface"; this
   request asks to widen that by exactly one route.
4. Is **MySQL** expected to reach certification (B-5) before or after this seam? Today only
   `(sqlserver, rcsi_on)` is certified and it is unreachable under δ=(c).
5. Which artefact records the ruling — a new issue, or a comment on **#4437**? This draft is not filed anywhere.

---

*Draft prepared 2026-08-18 against branch `docs/gip-runtime-wiring-decision-request-draft`. Not pushed. Every
status in §2 was read off the working tree at that head; where an artefact is absent it is written UNKNOWN or
OPEN rather than assumed.*
