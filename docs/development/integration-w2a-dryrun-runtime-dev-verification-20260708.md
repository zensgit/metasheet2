# W2-a write-target dry-run runtime — developer verification — 2026-07-08

## Status

Implementation of **W2-a** under the ratified design-lock
`docs/development/integration-write-self-service-w2-dryrun-design-lock-20260708.md` (#3878).
Owner authorized development 2026-07-08. This document records what was built, what it proves,
and — per the lock's §7 disposition — what remains **separate, later, explicit owner opt-in**
(W2-b token issuance, the lookup-classified preview level, the W2 route/UI, W3 sandbox redeem,
W4 production apply).

**Note on the lock's own text:** the lock document's Status line still reads "PROPOSED (owner
ratification pending). Docs-only. This document authorizes NOTHING" and §7 anticipated the first
buildable slice as "the pure dry-run contract + evidence-schema module ... with the dry-run
runtime ... as further separate opt-ins after it." The task that produced this PR carries the
owner's 2026-07-08 authorization to build the **static-preview runtime** (contract validation +
in-memory compose, still zero network) as one consolidated first slice, since the network-bearing
"lookup-classified" level is what the lock's §7 split was actually protecting against building
prematurely — that level remains untouched here. Every hard lock in §4, and every verification
obligation in §5, is satisfied by what follows; nothing in §4 is violated by combining contract
validation with in-memory compose in one module.

Files:
- `plugins/plugin-integration-core/lib/write-target-dry-run-runtime.cjs` (new)
- `plugins/plugin-integration-core/__tests__/write-target-dry-run-runtime.test.cjs` (new, 11 test
  groups, hermetic, no network)
- `plugins/plugin-integration-core/package.json` — `test` chain UNION (appended, nothing dropped)
  + a `test:write-target-dry-run-runtime` convenience script, mirroring the existing per-module
  script convention.

## 1. Scope actually implemented (static-preview level only)

Per design-lock §1.1, W2 admits two preview levels. **Only the first is implemented here:**

- **Static preview (implemented):** re-validates the approved W1 config, byte-checks it against
  its own normalized form, checks the caller supplied the `sandboxSystemId`-matching system
  (never contacted), composes the would-be write body **in memory only** from `fieldMap` per row
  for keying/shape validation, and returns values-free count/boolean evidence. **Zero network.**
- **Lookup-classified preview (NOT implemented, separate future opt-in):** the bounded, read-only
  existence lookup against the sandbox binding to classify would-add/would-update/held. This
  slice always reports `lookupExecuted: false`, and — deliberately — **never** reports
  `wouldAdd` / `wouldUpdate` / `held` (omitted, not zero-faked) and **never** reports
  `canApply: true` / `status: 'ready'` (see §4 below). Nothing here performs a fetch, an
  adapter read, or any I/O of any kind.

Also **not implemented** (unchanged from the lock's disposition — each a separate opt-in):
W2-b write-intent token issuance, the W2 route/UI, W3 sandbox-redeem, W4 production apply.
A static assertion (the module's own export surface) confirms no token-shaped export exists:
`dryRunWriteTarget`, `createWriteDispatchGuard`, `writeTargetDryRunErrorEvidence`, and constants —
no `mintToken`/`issueToken`/`consumeToken`/`redeem*` export anywhere in the module.

## 2. Dry-run evidence contract

`dryRunWriteTarget(input, deps)` returns `{ evidence }` on success. `input` shape (strict
top-level allowlist, `WRITE_TARGET_DRY_RUN_TOP_KEYS`):

```
{
  configRecord: { id, status, version, config },   // a RESHAPED 4-key PROJECTION the caller builds
                                                     // from the W1 store's record; status must be
                                                     // 'approved'. NOT the store's raw ~14-field
                                                     // rowToPublicWriteTargetConfig() shape verbatim
                                                     // -- see §10, this is a wiring-rung obligation.
  payload: { rows: [ {...}, ... ] },                // cleansing-zone rows, bounded
  sandboxSystem: { id, ... },                       // must match config.sandboxSystemId
  maxRows?: number,                                 // optional, clamped to the hard ceiling
}
```

Evidence shape (allowlisted keys only, mirrors `READ_SOURCE_PROBE_EVIDENCE_*` idiom):

| Key | Kind | Notes |
| --- | --- | --- |
| `ok` | boolean | |
| `configId` / `configVersion` | identity | from the config record, never the config body |
| `status` | `'not_applyable'` (always, this slice) | see §4 — `'ready'` requires the lookup level |
| `canApply` | `false` (always, this slice) | see §4 |
| `planned` / `invalid` / `rowCount` | counts | integer-clamped; `wouldAdd`/`wouldUpdate`/`held` reserved, never emitted here |
| `lookupExecuted` | `false` (always, this slice) | |
| `capReached` | boolean | soft row-cap degradation |
| `sandboxBindingResolved` | `true` on success | value-comparison only, never a network resolve |
| `tokenIssued` | `false` (always — no token code exists in this module) | honest constant, not a lie: W2-b hasn't landed |
| `externalWriteAttempted` | boolean, **derived** | see §3 |
| `errorCode` / `errorType` (failure only) | exact-registered | see §5 |

**Never present, on any path:** row values, composed body content, field values, credentials,
hostnames/base URLs, endpoint text, response bodies. The composed per-row body
(`classifyRow`'s `body`) is discarded immediately by the caller and never returned, logged, or
folded into evidence — verified by the sentinel scan (§3.3).

## 3. Zero-outbound-write proof

### 3.1 Structural guarantee (how)

Three independent layers, matching the "structurally incapable" requirement:

1. **Absence.** The module contains **no** call site to any write/network primitive at all: no
   `fetch`, no `http(s).request`, no `adapter.write/upsert/save`, no `insertRows/updateRows`, and
   it never constructs an adapter (`deps.createAdapter` is accepted only for DI/interface parity
   with `read-source-read-runtime.cjs`'s `createAdapter` seam and for the zero-write proof tests —
   it is never referenced in the function body). This is the primary guarantee: there is nothing
   to bypass because there is no dispatch code path to reach.
2. **Static source-scan backstop.** `write-target-dry-run-runtime.test.cjs`'s
   `testStaticSourceScan()` reads the module's own source text and asserts it contains none of
   `.write(` / `.upsert(` / `.save(` / `fetch(` / `http(s).request` / `XMLHttpRequest` /
   `require('node-fetch')` / `.insertRows(` / `.updateRows(` / `require('node:http'|'node:https'|'http'|'https')`.
3. **Write-dispatch guard (the mutation-provable layer).** `createWriteDispatchGuard()` returns an
   object with a real counter (`writeAttempts`) and a single mutator, `blockDispatch(methodName)`,
   which increments the counter **and** throws the registered `WRITE_TARGET_DRY_RUN_WRITE_BLOCKED`
   code — recording an attempt and blocking it are inseparable; there is no way to "attempt" via
   this guard without it being observed. `dryRunWriteTarget` re-checks `guard.writeAttempts > 0`
   as the very first thing it does and refuses the entire run (throws `WRITE_BLOCKED`) if
   non-zero. `evidence.externalWriteAttempted` is independently derived from the same counter
   (`guard.writeAttempts > 0`), so even if the entry check were ever removed, the marker would
   still tell the truth.

### 3.2 Mutation log (all reverted; working tree confirmed clean after each)

Five mutations applied directly to the committed module, each run against
`node __tests__/write-target-dry-run-runtime.test.cjs`, then reverted with
`git checkout -- lib/write-target-dry-run-runtime.cjs` (safe: file was already committed):

| # | Mutation | Result |
| --- | --- | --- |
| 1 | Disabled the top-of-function guard re-check (`if (false && guard.writeAttempts > 0)`) | **RED** — `testWriteDispatchGuard`'s poisoned-guard integration assertion (`assert.throws(...WRITE_BLOCKED)`) failed with "Missing expected exception" |
| 2 | Hardcoded `evidence.externalWriteAttempted = false` (dropped the derived parameter) | **RED** — the poisoned-guard unit assertion on `buildSuccessEvidence` failed (`false !== true`) |
| 3 | Widened sandbox-binding check to also accept `sandboxId === config.systemId` (production) | **RED** — `testSandboxOnly`'s "production systemId must fail closed" assertion failed with "Missing expected exception" |
| 4 | Injected an actual reachable dispatch: `deps.createAdapter(input.sandboxSystem).upsert(...)` right before the success return | **RED, immediately** — the hostile spy adapter (throws if called) fired on the very first happy-path test (`testHappyDryRun`), uncaught, crashing the whole run; **also independently** flagged by the static source-scan pattern (`.upsert(` match confirmed programmatically before revert) |
| 5 | Widened the approved-status gate to also accept `'draft'` | **RED** — `testFailClosedConfigState`'s draft-config assertion failed with "Missing expected exception" |

After each mutation: `git checkout -- plugins/plugin-integration-core/lib/write-target-dry-run-runtime.cjs`
restored the exact committed content (confirmed via `git diff --stat` producing no output). Final
state re-verified: `git status --short` clean, full chain green (`pnpm --filter plugin-integration-core
test`, exit 0) after mutation experiments concluded.

### 3.3 Values-free sentinel scan

`testValuesFreeSentinelScan()` plants sentinel strings in: row field values
(`SENTINEL-ROW-VALUE-9f8e`, `Widget-Secret-Spec`), and a poisoned `sandboxSystem` object carrying
extra fields a careless caller might attach (`credentials.bearerToken: 'SENTINEL-TOKEN-abc123'`,
`config.baseUrl: 'https://sentinel-host.internal'`) — fields the module never reads (only
`sandboxSystem.id` is consulted). It then JSON-stringifies the evidence from the happy path and
from every failure path (draft-config, production-system, empty-payload) plus the thrown error's
`message`/`code`/`reason` and the `writeTargetDryRunErrorEvidence(error)` projection, and asserts
none of the sentinels appear anywhere. All pass — the evidence/error surface literally cannot
carry these fields because it is built key-by-key from a fixed allowlist (never spread/passthrough).

## 4. `canApply` / `status` — deliberate non-goal, not an oversight

This slice's dry-run **never** returns `status: 'ready'` or `canApply: true`. Design-lock §3 gates
write-token issuance on `canApply === true` (clean dry-run: complete read, zero invalid, zero
held). "Held" (ambiguous existing-row) detection requires the lookup-classified level, which this
slice does not implement. Rather than read the lock's wording narrowly (zero held vacuously true
when no lookup ever ran) and risk a future W2-b minting a write-intent token off a run that never
checked for row ambiguity, `status`/`canApply` are hard-pinned to `'not_applyable'`/`false`
regardless of how clean the static preview is. `tokenIssued` is correspondingly always `false` — an
honest constant reflecting that no token-minting code exists in this module at all, not a
placeholder hiding a gap.

## 5. Sandbox-only proof

`assertSandboxBinding(config, sandboxSystem)` performs exactly one comparison:
`sandboxSystem.id === config.sandboxSystemId` (after a type/trim guard). It never reads
`config.systemId` for any resolution purpose — only implicitly, in that a value equal to
`config.systemId` will (by W1's own save-time guarantee that `systemId !== sandboxSystemId`) fail
the equality check and fall through to the fail-closed branch. Verified by:
- `testSandboxOnly`: production system, wrong system, empty object, and entirely-missing
  `sandboxSystem` all throw `WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING`.
- Mutation #3 above: widening the comparison to accept `config.systemId` turns this red.
- No code path ever passes `sandboxSystem` (or anything derived from it) to a network call —
  there is no network call in the module (§3.1).

## 6. Fail-closed matrix

| Condition | Code | Reachable via |
| --- | --- | --- |
| Top-level shape violation / unexpected key | `WRITE_TARGET_DRY_RUN_CONTRACT_INVALID` | `assertContractShape` |
| `configRecord` missing/null/non-object | `WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND` | `assertApprovedNormalizedConfig` |
| `configRecord.status` is `draft` / `retired` / anything but `approved` | `WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED` | same |
| `configRecord.config` fails the W1 validator | `WRITE_TARGET_DRY_RUN_CONFIG_INVALID` | same |
| `configRecord.config` valid but not byte-identical to its own normalized form | `WRITE_TARGET_DRY_RUN_CONFIG_NOT_NORMALIZED` | same |
| `sandboxSystem` missing / malformed / not matching `sandboxSystemId` (incl. production) | `WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING` | `assertSandboxBinding` |
| `payload.rows` not a non-empty array of plain objects | `WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID` | `assertPayloadShape` |
| `payload.rows.length` exceeds the hard ceiling (10000) | `WRITE_TARGET_DRY_RUN_CAP_REACHED` | same |
| every row fails to resolve `keyField` (total failure) | `WRITE_TARGET_DRY_RUN_KEY_MISSING` | `dryRunWriteTarget` |
| guard already observed a write-dispatch attempt | `WRITE_TARGET_DRY_RUN_WRITE_BLOCKED` | `dryRunWriteTarget` entry re-check |
| anything else / unregistered producer code | `WRITE_TARGET_DRY_RUN_FAILED` (generic clamp) | `safeErrorCode` |

Partial per-row key-missing is **not** a hard failure — it surfaces as the `invalid` count
alongside `planned`, so the caller still gets a useful partial preview (`testKeyMissing`'s
"partial" case).

Row caps: bounded C6-style (`DEFAULT_MAX_ROWS = 100`, hard `MAX_ROWS = 10000`). Above the default
but under the hard ceiling degrades softly (`capReached: true`, still `ok: true`); above the hard
ceiling is rejected wholesale (`CAP_REACHED` thrown, no compose).

## 7. Exact-registered coarse-code family

Registered (`WRITE_TARGET_DRY_RUN_ERROR_CODES`, frozen, exact-membership `safeErrorCode` — no
prefix matching): `CONTRACT_INVALID`, `CONFIG_NOT_FOUND`, `CONFIG_NOT_APPROVED`, `CONFIG_INVALID`,
`CONFIG_NOT_NORMALIZED`, `SANDBOX_BINDING_MISSING`, `KEY_MISSING`, `PAYLOAD_INVALID`,
`CAP_REACHED`, `WRITE_BLOCKED`, `FAILED` — i.e. only the codes **this slice can actually produce**.

Deliberately **not** registered: `LOOKUP_AMBIGUOUS`, `AUTH_FAILED`, `NETWORK_FAILED`, `TIMEOUT`,
`TOKEN_STORE_UNAVAILABLE` — these require the network-bearing lookup level or token issuance,
neither of which exists in this module. Registering them now would be untestable dead
enumeration; they will be added additively (never repurposed) when the lookup-classified level
and W2-b land. `WriteTargetDryRunError`'s constructor itself clamps any unregistered/prefix-like
code to `WRITE_TARGET_DRY_RUN_FAILED` at construction time (`testExactCodeFamilyAndClamp`), and
`writeTargetDryRunErrorEvidence` clamps both `errorCode` and `errorType` independently for
non-`WriteTargetDryRunError` errors.

## 8. Test summary

`plugins/plugin-integration-core/__tests__/write-target-dry-run-runtime.test.cjs`, 11 groups, all
green, hermetic (no network, no persistence, no route):

A. Happy dry-run (values-free evidence, adapter spy never called) · B. Zero-write proof (hostile
throwing adapter injected, dry-run still succeeds) · C. Sandbox-only (production/wrong/missing
system fail closed) · D. Fail-closed config states (missing/draft/retired/invalid/not-normalized)
· E. Payload shape/caps (invalid shapes, hard-ceiling reject, soft-cap degrade, bad `maxRows`) ·
F. KEY_MISSING (total vs. partial failure) · G. Values-free sentinel scan (every path) · H.
Exact-code family + generic clamp (frozen exact list, deferred codes absent, clamp behavior) · I.
Write-dispatch guard (real throw+tally, derived-not-hardcoded marker, poisoned-guard integration
proof) · J. Static source-scan backstop · K. `__internals` sanity (prototype-safe path walk,
per-row classification) · L. No token-shaped export (static scan of `module.exports` +
`__internals` keys for `mint`/`issue`/`token`/`consume`/`redeem` — backs the §9 claim below).

Wired into the plugin's single `test` script as a UNION (appended, nothing dropped) plus a
`test:write-target-dry-run-runtime` convenience script matching the existing per-module
convention. Full chain verified green end-to-end: `pnpm --filter plugin-integration-core test`,
exit code 0, re-confirmed after all mutation experiments were reverted.

## 9. Explicitly NOT in this slice (separate, later, explicit owner opt-ins)

- **W2-b write-intent token issuance** — no token is ever minted; no token-shaped export exists in
  this module (`dryRunWriteTarget`, `createWriteDispatchGuard`, `writeTargetDryRunErrorEvidence`,
  and constants only — no `mint*`/`issue*`/`consume*`/`redeem*`).
- **Lookup-classified preview** — the bounded, read-only sandbox existence lookup is not
  implemented; `lookupExecuted` is always `false`, `wouldAdd`/`wouldUpdate`/`held` are never
  emitted, and `canApply`/`status:'ready'` are unreachable (§4).
- **W2 route/UI** — no HTTP route, no UI surface; this is a pure library module only.
- **W3 sandbox-redeem** — no redeemer exists anywhere in this codebase change; redemption remains
  entirely out of scope, per the lock's §3 "W2 ships no redeemer."
- **W4 production apply** — untouched; production `systemId` is never contacted; no
  production-write default switch is added, flipped, or widened.

Each of the above is a separate, later, explicit owner opt-in, exactly as the design-lock's §7
disposition and §4.10 require.

## 10. Honest gap — one lock clause NOT fully proven (store-integration, deferred to wiring)

Everything in §1-9 is proven against this module in isolation, hermetically. One thing is
**not** proven, and should not be read as proven by the green test suite: **the real W1
config-store record has not been exercised against this module.**

- `write-target-config-store.cjs`'s `rowToPublicWriteTargetConfig` returns a record with roughly
  14 fields (`tenantId`, `workspaceId`, `sandboxSystemId`, `contentKey`, `createdBy`, `updatedBy`,
  `createdAt`, `updatedAt`, ... plus `id`/`status`/`version`/`config`). This module's
  `assertContractShape`/`assertApprovedNormalizedConfig` enforce a **strict 4-key allowlist**
  (`id`, `status`, `version`, `config`) on `configRecord` and will reject a real store row
  verbatim with `config_record_unexpected_field` (clamped to `WRITE_TARGET_DRY_RUN_CONTRACT_INVALID`).
  **This is by design, not a bug** — the module deliberately consumes a narrow, values-free
  projection rather than trusting an arbitrary caller-supplied object — but it means the future
  wiring rung MUST explicitly reshape the store's row into this module's 4-key input (or this
  module's allowlist must be revisited); which of the two is correct is a wiring-rung decision,
  not decided here.
- The store's `get()` also runs the stored `config` through `sanitizeIntegrationPayload` and
  version-injection before returning it (`rowToPublicWriteTargetConfig`). This module's
  byte-identity check (`stableStringify(configRecord.config) === stableStringify(validateWriteTargetConfig(configRecord.config).normalized)`)
  has only been tested against synthetic fixtures built directly from
  `validateWriteTargetConfig(raw).normalized` — **never against a config that has round-tripped
  through the real store's save→get path.** If `sanitizeIntegrationPayload` (or the version
  field the store injects) perturbs the config's shape in any way the W1 validator doesn't
  also normalize away, every real (non-synthetic) dry-run would fail closed with
  `WRITE_TARGET_DRY_RUN_CONFIG_NOT_NORMALIZED` — fail-closed, not a silent-wrong-answer risk, but
  untested and worth a real-store round-trip test before or during wiring.

This mirrors the read-line's own precedent (`read-source-read-runtime.test.cjs` also tests
against synthetic normalized configs, not a live `read-source-config-store` round-trip) and
store-wiring is explicitly out of scope for W2-a per the design-lock's §7 disposition — so this
is **not a defect in this slice**, but it is the one clause this PR cannot claim is fully proven
end-to-end. Recommended follow-up for the route/wiring rung: a real-store round-trip test
(`saveVersion` → `approve` → `get` → feed the row into `dryRunWriteTarget`, reshaped as needed)
before this module is wired to anything the store actually produces.
