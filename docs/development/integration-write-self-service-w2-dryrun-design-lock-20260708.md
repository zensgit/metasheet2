# External-API WRITE self-service — W2 dry-run + write-token design-lock — 2026-07-08

## Status

**PROPOSED (owner ratification pending). Docs-only. This document authorizes NOTHING.**
No runtime, no route, no contract module, no evidence builder, no token helper (neither
extraction nor fork), no adapter change, no migration, no UI, no outbound call, no write.
It locks the *design* of rung **W2** of the external-API write self-service ladder
(`integration-core-external-api-write-self-service-direction-design-lock-20260703.md`,
W0 direction lock, #3515) so that the later, separately owner-opted-in W2 implementation
slices have a fixed shape to build against. Every implementation slice named below is a
**separate, later, explicit owner opt-in** — ratifying this lock opts into none of them.

**Hard owner constraint (2026-07-08), restated as binding:** sandbox-first / owner-gated;
the production-write default switches are **not touched** by anything in this rung
(不碰生产写默认开关); **W4 production write is customer-barred** — it is never reachable
by a customer-facing actor and only the owner can ever gate it open. W2 is **dry-run
preview + write-token issuance ONLY — no live external write of any kind.**

## Position in the ladder

| Rung | Scope | Status | Gate |
| --- | --- | --- | --- |
| **W0** | direction design-lock: two-tier write model, ladder, save-time validation, dry-run-first, sandbox-first, delete excluded | ✅ merged (#3515, doc 20260703) | — |
| **W1** | write-target config model + validator + content-keyed versioned store + draft→approved→retired lifecycle | ✅ **MERGED #3548** (`write-target-config.cjs`, `write-target-config-store.cjs`, migration 064) | landed |
| **W2** | **dry-run preview + write-token issuance — THIS LOCK** | 🔒 design PROPOSED; runtime = separate opt-in(s) | no apply, no external write |
| **W3** | sandbox apply — redeems a W2 token against the **sandbox** binding only; re-pull idempotency + human-field-preservation proof | 🔒 | sandbox only; never production |
| **W4** | production apply | 🔒 **customer-barred; owner production gate** | owner-only; two-step confirm + Idempotency-Key |

Each row is a separate opt-in. No slice combines rungs. Ratifying W2's design does not
start W2's implementation, and completing W2's implementation does not start W3.

## 1. Scope of W2

W2 is the rung where a consultant/admin can **prove a write-target config is sound
without anything being written anywhere**:

1. **Dry-run** — validates and previews an **approved** W1 write-target config version
   against the target system **without issuing any external write**. It:
   - re-validates the stored config through the W1 validator and fails closed on a
     draft / retired / missing / non-normalized config;
   - composes the would-be target body **in memory only** from the config's `fieldMap`
     and the supplied cleansing-zone payload rows, for shape validation and
     fingerprinting — the composed body is **never dispatched**;
   - optionally performs a **bounded, read-only key lookup** (see §1.1) to classify each
     row as would-add / would-update / held (ambiguous), producing count-level preview
     evidence;
   - returns **values-free evidence** (§2) that includes an explicit machine-checkable
     assertion that no external write was attempted.
2. **Write-token issuance** — when and only when the dry-run outcome is clean
   (`canApply`), W2 mints a scoped, short-lived **write-intent token** (§3). The token
   is **not a write grant**: in W2 there exists **no code path that redeems it**.
   Redemption is the W3 sandbox-apply rung, a separate future opt-in.

**Explicitly: W2 issues nothing and authorizes nothing that writes to K3 / ERP / PLM or
any other external system.** A fully ratified, fully implemented, fully green W2 still
cannot cause one byte of external mutation.

### 1.1 What the dry-run may and may not touch on the network

- **Production binding: never.** The dry-run resolves **only** the config's
  `sandboxSystemId` binding. The production `systemId` is never resolved, never
  credential-decrypted, never contacted in W2. (W1 already refuses a config whose
  sandbox binding equals production.)
- **Write dispatch: never.** The configured `writePath` / `writeMethod` is never
  dispatched in W2 — not against sandbox, not against production. The dry-run's outbound
  transport is a **read-only guard wrapper** that fail-closes (raises the registered
  coarse code `WRITE_TARGET_DRY_RUN_WRITE_BLOCKED`, §2.2) on any attempt to dispatch a
  write-shaped request. This guard is an internal tripwire invariant, not a policy
  toggle.
- **Read-only lookup: bounded, optional, sandbox-side only.** To classify
  would-add/would-update, the dry-run may resolve the declared `keyField` via the
  platform's existing read-tier machinery (the read self-service spine's probe/read
  discipline: bounded rows, timeout, values-free outcome), against the **sandbox**
  binding. A dry-run with the lookup unavailable degrades to a static preview with
  `lookupExecuted: false` — it does not guess and does not fall back to the write path.
- **Levels.** The design admits two preview levels, both inside this one rung:
  - **static preview** — no network at all: config re-validation + field-map composition
    + payload shape/fingerprint checks;
  - **lookup-classified preview** — static preview plus the bounded read-only lookup.

### 1.2 Two-tier authority (inherited from W0, unchanged)

Dry-run is a **write-tier (consultant/admin) operation** on an approved config version.
The runtime multitable actor tier may at most *invoke* an approved target's dry-run path
where a later slice exposes it; no tier below owner can ever reach a production write,
and no tier at all can reach one in W2 (there is no write to reach).

## 2. Request / evidence contracts

### 2.1 Dry-run request (design shape)

The request carries **no structure** — no endpoint, method, body template, response
path, or credential can ride in at runtime:

- `configId` — an **approved** W1 write-target config version (store `status:
  'approved'`; draft/retired/missing fail closed);
- payload rows drawn from the **authorized cleansing zone** (the data plane the W0 lock
  defines) — bounded by row caps (C6-style `DEFAULT_MAX_ROWS` / hard `MAX_ROWS`
  ceiling);
- tenant / workspace / actor scope (platform-supplied, not caller-forgeable).

The contract layer mirrors the read line's choke-point discipline
(`read-source-probe-contract.cjs`): a strict top-level key allowlist, and a
**normalized-config assertion** — the config consumed by the dry-run must be
byte-identical (stable-stringify) to `validateWriteTargetConfig(raw).normalized`, else
fail closed (`config_not_normalized`), so the dry-run never becomes a second validator
by accident.

### 2.2 Values-free evidence shape

The dry-run returns evidence built from **allowlisted keys only** — the exact idiom of
`READ_SOURCE_PROBE_EVIDENCE_COUNT_KEYS` / `READ_SOURCE_PROBE_EVIDENCE_BOOLEAN_KEYS`:

- **identity/outcome:** `ok`, `configId`, `configVersion`, `status`
  (`'ready' | 'not_applyable'`), `canApply`;
- **counts (integer-clamped allowlist):** `planned`, `wouldAdd`, `wouldUpdate`, `held`,
  `invalid`, `rowCount` — counts only, never rows;
- **booleans (allowlist):** `lookupExecuted`, `capReached`, `timeoutReached`,
  `sandboxBindingResolved`, `tokenIssued`, and the **no-write proof marker** (below);
- **failure surface:** `errorCode` + `errorType`, both **exact-registered** (§2.3);
- **token handoff:** the minted token value appears **once, in the direct response
  only** (like the C6 `dryRunToken`); audit/evidence logs store only a token
  **fingerprint** (hash), never the token, and `tokenExpiresAt`.

**Never present, any code path:** row values, composed body content, field values,
credentials or credential references' resolved material, hostnames, base URLs, endpoint
text, target-system response bodies, or value-carrying error messages. Evidence-builder
discipline is copy-by-allowlist (pick), never spread/passthrough — which per the
repo's wire-drift rule obligates a real round-trip integration test on every field.

**The no-write proof marker.** Evidence carries `externalWriteAttempted: false` — and
this field is **not a constant**: it must be *derived from the read-only transport
guard's counter* (writes attempted = 0). If the guard ever observes a write-shaped
dispatch attempt, the dry-run fails closed with `WRITE_TARGET_DRY_RUN_WRITE_BLOCKED`
and no token is minted. The marker is therefore an assertion the runtime can prove,
not a decoration.

### 2.3 Coarse-code family (exact-registered, fail-closed)

W2 failures surface as a **registered exact-value set** — `safeErrorCode` membership
semantics identical to the read line: **prefix matching is not allowed**; an unknown or
unregistered code degrades to the generic family fallback, never echoes producer text.
The design-level family (final enumeration is sharpened in the contract slice, but the
discipline and these members are locked):

- `WRITE_TARGET_DRY_RUN_CONTRACT_INVALID` (bad request shape / unexpected key)
- `WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND`
- `WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED` (draft/retired)
- `WRITE_TARGET_DRY_RUN_CONFIG_INVALID` / `..._CONFIG_NOT_NORMALIZED`
- `WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING`
- `WRITE_TARGET_DRY_RUN_KEY_MISSING` / `..._PAYLOAD_INVALID` / `..._CAP_REACHED`
- `WRITE_TARGET_DRY_RUN_LOOKUP_AMBIGUOUS`
- `WRITE_TARGET_DRY_RUN_AUTH_FAILED` / `..._NETWORK_FAILED` / `..._TIMEOUT`
- `WRITE_TARGET_DRY_RUN_TOKEN_STORE_UNAVAILABLE`
- `WRITE_TARGET_DRY_RUN_WRITE_BLOCKED` (transport-guard tripwire — internal invariant
  violation, always token-suppressing)
- `WRITE_TARGET_DRY_RUN_FAILED` (the generic clamp target)

## 3. Write-token model (write-intent token, not a write grant)

- **What it binds.** The token is a **random opaque value** (C6 discipline:
  `crypto.randomBytes`, base64url); all meaning lives in the **server-side stored
  record**, which binds: `configId` + `configVersion` + `contentKey`, tenant /
  workspace / actor scope, the **recomputed content/revision hash** over the normalized
  config + payload row fingerprints + counts (C6 `buildRevision`-style — the binding is
  the hash, the token is just random), the **sandbox-only target scope**, `createdAt`,
  and a short TTL `expiresAt` (≤ the C6 default of 30 minutes).
- **What it is NOT.** It is **not a write grant, not a capability, not a credential,
  and not a bearer of data**: no credential material, no endpoint text, no host, no
  payload values in the token or its stored record beyond fingerprints/counts. It is
  not a JWT and carries no claims. Possessing it in W2 grants **nothing** — no W2
  surface accepts it.
- **Redemption is out of W2 scope.** One-time consume, expiry enforcement,
  scope-mismatch rejection, and revision-hash re-verification are the **W3 sandbox
  redeemer's** obligations (a separate gated rung). W2's obligation is only that the
  stored record makes those checks possible — i.e. record-shape compatibility with the
  C6 consume discipline. **W2 ships no redeemer**, and a static check may assert no
  redeem/consume export exists in W2 modules.
- **One scheme, not two.** Per W0 lock #3: the C6 one-time-token helpers are
  file-internal to `external-write-dry-run.cjs` (not exported). The W2 implementation
  must either **extract/promote a shared token helper (with tripwire tests keeping C6
  green)** or **fork the discipline verbatim** — the choice is an implementation-slice
  decision, but a **second, parallel token scheme is forbidden** either way.
- **Issuance condition.** A token is minted only on `canApply === true` (clean dry-run:
  complete payload read, zero invalid, zero held); any failure path — including the
  write-blocked tripwire — suppresses issuance.

## 4. Hard locks / non-goals (all binding on every W2 slice)

1. **No live external write.** No write-method dispatch to any external system, sandbox
   or production, under any input. The read-only transport guard is mandatory and
   fail-closed.
2. **Production untouched.** The production `systemId` is never resolved or contacted;
   **no production-write default switch is added, flipped, or widened** (owner hard
   constraint 2026-07-08); W4 stays customer-barred and owner-gated.
3. **No lifecycle execution.** No Save / Submit / Audit call against any target; the
   `save_only` operation profile remains config metadata in W2.
4. **No delete** (v1 hard exclusion, inherited; W1 already rejects delete-shaped
   configs at save time).
5. **No host-allowlist widening.** Endpoints remain crown-jewel-guarded relative paths
   (`isSafeRelativeReadPath`, reused verbatim) under a registered system's base URL; no
   new hosts, no absolute URLs, no runtime-supplied endpoint/method/body/response-path.
6. **No raw SQL / free-form statement / free-form body** anywhere in the rung.
7. **No credential anywhere visible.** Credentials stay backend references;
   never inline, never echoed, never in evidence, token, stored token record, audit,
   or error text (W1's inline-credential rejection + shared scrubbers inherited).
8. **No token redemption in W2** (redeemer = W3; see §3).
9. **Values-free evidence throughout** — counts, booleans, registered coarse codes,
   fingerprints only.
10. **This document authorizes no runtime.** The W2 contract slice, the W2 dry-run
    runtime slice, the W2 token slice, W3, and W4 are each a **separate explicit owner
    opt-in**; ratifying this lock starts none of them.

## 5. Verification plan (obligations on the future W2 implementation slices)

Since W2 authorizes no runtime today, this section locks what the runtime slices' tests
**must prove** when they are later built (in addition to the repo's standing rules —
package.json test-chain UNION, real-wire round-trip test for every allowlist-copied
evidence field):

1. **Zero outbound write — mutation-provable.** A transport spy/guard test asserts zero
   write-method dispatches across the entire dry-run suite, plus a hostile fixture that
   *attempts* to induce a write and must be observed failing closed with
   `WRITE_TARGET_DRY_RUN_WRITE_BLOCKED` and no token. The guard must be
   **mutation-tested**: flipping/removing the guard (allowing the dispatch) must turn at
   least one test red — a tripwire, not a decoration. `externalWriteAttempted` must be
   proven derived from the guard counter, not hard-coded (a mutant forcing the counter
   non-zero must flip the marker or fail the run).
2. **Values-free evidence — sentinel-scan goldens.** Seed payload rows, credentials,
   hosts, and endpoint text with sentinel strings; string-scan every evidence / error /
   audit output on every code path (success, each coarse-code failure, tripwire) and
   assert zero sentinel leakage. Count/boolean allowlists verified by
   unknown-key-dropped tests.
3. **Token carries no write grant.** The stored token record contains no credential /
   endpoint / host / row values (sentinel scan); no W2 route or export accepts/consumes
   the token (static assertion on module exports + route table); the token appears
   exactly once in the direct response and only a fingerprint in audit.
4. **Fail-closed on config state.** Missing / draft / retired / invalid /
   non-normalized config → registered coarse code, **no lookup dispatch, no token**
   (spy asserts zero outbound on these paths).
5. **Exact-registered coarse codes.** Unknown / prefix-matching / producer-supplied
   codes clamp to `WRITE_TARGET_DRY_RUN_FAILED`; the registered set is asserted as an
   exact frozen enumeration (read-line `safeErrorCode` semantics).
6. **Sandbox-only resolution.** A resolver spy proves the production `systemId` is
   never resolved/decrypted/contacted on any path, including failure paths.
7. **Caps and degradation.** Row cap, timeout, and lookup-unavailable degradation
   (`lookupExecuted: false`, static preview still valid) each covered; cap/timeout
   surfaces as evidence booleans, never as value-carrying errors.

## 6. Foundation (reused, not reinvented — named primitives)

- **W1 (#3548, merged):** `validateWriteTargetConfig` / `normalizeWriteTargetConfig`
  (`write-target-config.cjs`); `createWriteTargetConfigStore` + `contentKeyFor` +
  draft→approved→retired lifecycle + values-free audit
  (`write-target-config-store.cjs`); migration 064
  (`integration_write_target_configs` + audit table). W2 consumes the store's
  **approved** versions read-only; it adds no store mutation beyond token records in
  plugin storage.
- **Read line (#1709, merged):** the probe-contract discipline to mirror
  (`read-source-probe-contract.cjs`) — normalized-config choke point
  (`assertS1NormalizedConfig` idiom), exact-registered coarse-code set +
  `safeErrorCode`, evidence count/boolean key allowlists, bounded probe caps/timeouts;
  the read runtime spine for the read-only key lookup.
- **C6 external-write dry-run (shipped, `external-write-dry-run.cjs`):** the token
  discipline to extract-or-fork (random one-time token + TTL + revision-hash binding +
  consume-once semantics + `SAFE_WRITE_ERROR_CODES` clamp idiom) — **never a second
  scheme**; row caps; the `canApply`-gated issuance pattern.

## 7. Disposition

PROPOSED, pending owner ratification. **Authorizes no runtime, no contract module, no
evidence builder, no token helper extraction or fork, no route, no UI, no outbound
call, no write, no delete, and no production anything.** On explicit owner opt-in, the
first implementable slice is **W2-a: the pure dry-run contract + evidence-schema module**
(no network, no token, no route — the write-side analogue of the read line's S2-a),
with the dry-run runtime and token issuance as further separate opt-ins after it.
