# Database & System Integration Line — Design and Verification (2026-07-24)

**Status:** §1 is a **RECORD** of landed, verified facts (head-scoped SHAs). §2–§6 are **PROPOSED / design-first**; the document itself ships no code. What its approval unlocks is defined in **Gate** immediately below — a bounded **authority-substrate** gate, **not** "latent only". **§4 is the single authoritative slice order** and is currently **PENDING RE-RATIFICATION**.

**Gate (owner, 2026-07-24; ⟲B2 REVISED).** The earlier wording — *"unlocks only the B1a latent contract + harness slice"* — is **WITHDRAWN as self-contradictory**: §3.0's boundaries cannot be met inside a latent slice. A real **config v2** changes a **live approved-config validation path**, and the identity read / canonical contract registry / server-bound source executor add **internal derivation and connection paths**. Calling that "contract + harness only" would have let production-path changes land under a gate that never authorized them. The gate is therefore renamed for what it actually is:

> **B1a AUTHORITY-SUBSTRATE gate — PERMITTED, bounded:**
> - **additive** `orderingKeySpec` / `actionProfileVersion` acceptance in the approved-config validator — closed rejection on shape, and **no behaviour change for any config that omits them**;
> - a purpose-built **system identity read** that does **not** decrypt credentials (B-2);
> - a **first-party canonical object contract registry** and its version lookup (B-3);
> - a **server-bound source executor** — resolution-derived handle, first-party statement builders, restricted statement seam — plus certified source-column translation (B-1, B-6);
> - **removal or privatisation** of the legacy `probe()` entry point (B-4).
>
> **STILL FORBIDDEN — each its own later gate:** any HTTP route or otherwise request-reachable surface over the above; any **runtime consumer** of a GIP profile; arming / activation / rollout; telemetry or handshake **wiring** (B1-observability); the **B2 enforcement merge** (**#4591**); sealed-snapshot implementation; page-size ceiling changes; CDC / external write-back / D2 / W3 / G1 (frozen).
>
> **Boundary test, so this cannot be argued case by case:** if a change makes a new behaviour reachable **from a request or from a scheduled run**, it is OUTSIDE this gate — no matter which §3.0 boundary motivated it.

This is the line's single design-and-verification document (owner directive: consolidate closeout facts into one MD; stop letting working memos drift). It absorbs and supersedes the session working memos (`/tmp/gip-decision-memo-20260724.md`, `/tmp/b1-paged-read-certification-design-20260724.md` rev‑1) and the retired ad-hoc inventory SQL (NO-GO; §5).

Owner-review absorption markers used below: ⟲P1-a (ordering-key layering), ⟲P1-b (probe ≠ paged execution), ⟲P2-a (frozen combinations / no silent downgrade), ⟲P2-b (latent vs telemetry), ⟲P3-a (sealed snapshot not the sole exit). Codex-review absorptions (2026-07-24) are marked ⟲C1 (M0 exact-SHA package policy — BLOCKING), ⟲C2 (inventory-zero coverage map), ⟲C3 (#4580 re-cut + typed 422 as merge condition), ⟲C4 (orderBy = fail-fast, not stable pagination), ⟲C5 (per-capability routing, not per-brand). Owner ratify-review absorptions (2026-07-24, round 2) are marked ⟲R1 (exact-SHA exits: two-proof-only + freeze the new SHA), ⟲R2 (deep-immutable resolution, not provenance-only), ⟲R3 (full-tuple resolver), ⟲R4 (M1 = evidence only; the §4 order wins), ⟲R5 (combinations scoped to PAGED_READ), ⟲R6 (orderingKeySpec closed schema). Package/decision round (owner, 2026-07-24 late): ⟲R7 (complete-package two-SHA structure), plus three recorded decisions — package policy (b) with a build-only authorization boundary; B1-observability NOT opened early; B2 re-cut now as Draft **#4591**, superseding #4580. Qualification-authenticity round (owner, 2026-07-24, round 3): ⟲B (the six §3.0 boundaries). Boundary-review round (owner, 2026-07-24, round 4): ⟲B2 — authority-substrate gate replaces the self-contradictory "latent only" wording; `canonicalObjectVersion` = first-party contract version, drift belongs elsewhere; `systemContentKey` freeze material completed; §4 becomes the single authoritative order and is un-ratified until re-approved.

**Doc charter** ⟲Codex: this document is an **execution index + evidence ledger**. Authoritative contracts live in code and their own frozen design docs — referenced here by symbol + SHA, never copied — so this file cannot drift into another competing fact source. Model task cards derived from it must carry **symbol + exact head + acceptance predicate**, not bare line numbers.

---

## 1. RECORD — landed and verified

- **`bridge.bounded_read.v2` MERGED = `7bf2bd7a1`** (PR #4573, squash). **#4565 CLOSED unmerged** — its head `828aeb4d6` carries the pre-hardening fail-open and must never merge.
  - P1a (applied-limit): adapter `read()` verifies the agent-echoed applied limit — `data.limit` present ∧ positive integer ∧ equal to the requested clamp; missing / non-integer / divergent ⇒ fail-closed. `metadata.limit` is sourced from the **verified echo**, so downstream `short_page` reasoning is evidence-backed.
  - P1b (lineage): `profileId`/`actionProfileVersion` bumped to `.v2` — the qualification digest keys on `actionProfileVersion` only, so an authenticated old-v1 qualification now recomputes to `QUALIFICATION_DIGEST_MISMATCH` instead of surviving the hardening.
  - The profile remains **LATENT** (zero runtime consumers, proven by tree-wide grep at merge time). **Agent/protocol-version pin is a hard gate before any activation / arming / runtime wiring** (owner ruling: certification-scoped preflight; NOT the shared adapter; NOT a #4553 digest input).
- **#4583 MERGED = `68bcd9a670`** (data-source read-boundary A-knife):
  - MySQL A5 row bound enforced (previously **none**: an omitted limit issued a whole-table `SELECT`; an over-max limit was served verbatim — `manager.select` passes options straight through, so the adapter is the only chokepoint).
  - **Single frozen adapter registry**: `DEFAULT_ADAPTER_REGISTRY` is the one source; `SUPPORTED_DATA_SOURCE_TYPES` is derived from its keys; both `Object.freeze`d, with mutation-verified negative controls (assignment / replace / delete / push / splice all rejected at runtime).
  - Registry-derived A5 conformance: the suite instantiates from the production registry and derives the SQL set via `isSqlDialect()` — a newly registered SQL adapter is auto-covered (mutation-proven: an unbounded fake adapter grew the suite 11→14 and failed its three A5 cases with zero test edits).
  - Follow-up (P3, no dedicated PR): one freeze negative control keeps a literal six-type anchor (does not participate in coverage derivation); convert to a comment-marked deliberate anchor at next touch of that file.
- **B2 enforcement = #4591 (DRAFT, merges LAST)** ⟲C3 — pure re-cut from current main per owner ruling; **#4580 CLOSED as superseded** (its branch carried the A-half already landed via #4583 and went `DIRTY`). #4591 contents, exactly the owner-listed three: adapter-layer OFFSET-ordering fail-fast guard (offset > 0 without `orderBy` ⇒ fail-closed, all three SQL adapters; registry-derived conformance roster) + **typed closed 422** (`DataSourceOffsetOrderingError` / `DATA_SOURCE_OFFSET_ORDERING_REQUIRED` — previously every non-not-found `/select` failure surfaced as `SELECT_ERROR` 500; the mapping is closed, generic errors still 500, pinned by test) + deletion of MSSQL's non-deterministic `ORDER BY (SELECT NULL)` fallback. **Observability contracts deliberately excluded** (owner ruling — B1-observability slice, own gate). Mutation-verified both ways (guard-neuter reds the fail-closed cases; mapping-removal reds exactly the 422 case); suite 16/16; full unit suite green; `tsc` clean. ⟲C4 honest claim unchanged: fail-fast hardening only — uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c. **Merge order unchanged: LAST** ⟲R4 — after adapter-chokepoint telemetry (B1-observability), the §2-M1 coverage-mapped inventory evidence, and customer migration are complete. M1 itself takes no merge decision.
- **Retired NO-GO**: the ad-hoc inventory SQL — four schema-fact errors (wrong status vocabulary — external-system status is `active/inactive/error`; `integration_pipeline_runs` does not exist, the real table is `integration_runs` per migration 057; no `metrics.pageCount`, real fields are `details`/`rows_read`; `data_sources` shape is inconsistent across migrations ⇒ schema probe first). Replacement: an **in-repo, tested** script run **per customer deployment**, combining DB counts + local `/select` access logs (+ the B1-observability counter once separately authorized). A central-DB count alone cannot prove the absence of on-site HTTP callers.

## 2. M0–M2 acceleration route (owner-set; amendments marked PROPOSED)

**M0 (24–48h, zero product code).** Config owner creates a NEW approved config version (old versions untouched) bound to a provably single-page object — actual rows strictly below the agent-echoed effective limit. Flag-OFF preflight ⇒ `SHORT_PAGE`; then one C-stage flag-ON window; 11-item PASS ⇒ close #4437. ⟲C1 closure claim: that PASS closes #4437 as a **bounded-subset mechanism acceptance** — one tenant, one source; it claims **no large-scale capability**. Stop-loss: if no object can be safely narrowed, stop repeat acceptance and enter the M2 spike.
- ⟲C1 **BLOCKING package-policy decision (owner) — must be made BEFORE M0 runs.** #4437 froze RC-A at release `stock-prep-onprem-rc-a-20260717-d87e086fd` / exact SHA `d87e086fd12…` (2026-07-17, **predates** `7bf2bd7a1`) and forbids repackaging — so rev‑1's precheck "confirm the deployed image includes `7bf2bd7a1`" was **wrong**: it silently swaps the acceptance package against a frozen exact-SHA contract. Worse, the frozen package carries the **pre-hardening adapter**, whose `metadata.limit` is locally fabricated rather than echo-verified — the exact provenance hole #4573 closed — so its `SHORT_PAGE` result alone cannot close a completeness acceptance. ⟲R1 Sound options — **two mutually exclusive exits**: **(a)** keep `d87e086fd` — the old package is acceptable **only** with trusted `DECLARED_TOTAL` or a same-read-bound applied-limit proof; **for the legacy-SQL bridge both are structurally absent** (`DECLARED_TOTAL` is unreachable per the certified `bridge.bounded_read.v2`; the old package carries no in-band applied-limit proof) — so **(a) is empty for this source class**; **(b) recommended: the owner formally revises #4437 — publish, checksum, and FREEZE a new RC-A exact-SHA containing `7bf2bd7a1` — then run the narrowed `SHORT_PAGE` M0.** The config owner can prepare the bounded approved config in parallel under either option.
- ⟲R7 **"New RC-A package" = the COMPLETE on-prem deployment package, NOT the C-stage sidecar.** The sidecar ZIP carries only smoke helpers / PowerShell wrapper / PM2 sample / provenance — it does **not** contain `bridge-agent-readonly-adapter.cjs`; the #4573 fix lives in the server-side plugin. Exit (b) therefore means: build the complete on-prem package at the owner-chosen main SHA (recommended `7bf2bd7a1`, to avoid enlarging the runtime change surface); regenerate manifest + SHA256 + provenance + loopback verification; revise #4437 to record **`serviceRuntimeSha` and `clientHelperSha` separately** — the two smoke helpers are blob-identical between `d87e086fd` and `7bf2bd7a1`, so the helper content hash may carry over, but one `exactSha` must no longer conflate client and server; controlled deploy of the new service package; flag-OFF health verification; only then the bounded-config preflight. **Owner decision recorded — package policy = (b), authorization boundary strict: "build and verify the new complete RC-A package + revise the #4437 pointer" only; NOT deployment, NOT flag-ON — those remain ops-gated steps.**
- `/health` `version` capture (currently `0.1.0`): **asset inventory only** — it records which agent build is deployed; it proves nothing about protocol capability, limit-echo behaviour, or qualification compatibility.

**M1 (3–5 dev days, exactly two dev lines).**
- *Qualification line:* agent/protocol-version **certification-scoped preflight** (hard gate before activation/arming/runtime; does not block #4437).
- *Direct-DB line:* values-free inventory first — and ⟲C2 **"0" only carries migration meaning once the coverage relations and the observation window are explicit.** The evidence set and what each piece covers:
  1. DB inventory (approved configs / pipelines / `integration_runs`) — config-driven plugin reads;
  2. the deployment's full `/select` access log, **with stated retention scope and time window** — ad-hoc HTTP callers, within that window only;
  3. a static tree-wide enumeration of `manager.select` / `adapter.select` callers — in-repo direct entry
     points. ⚠️ **CORRECTED (verified 2026-07-24, independent review + my own re-verification): this group is
     materially LARGER than earlier stated in this document.** Beyond the `/select` route and
     `copyData` (which indeed has no live in-tree caller), there is a **shipped, live multi-page OFFSET
     reader**: `pipeline-runner.cjs` runs `while (page < maxPages)` advancing `cursor = readResult.nextCursor`,
     and the `data-source:sql-readonly` adapter's NON-watermark branch emits
     `nextCursor = String(offset + records.length)` on a full page — so a pipeline over a SQL data source
     pages by OFFSET **with no `orderBy` anywhere on the path**, stopping on a short page
     (`done: !fullPage`) evaluated against LIVE data. Earlier wording in this line implied the offset path
     was merely *reachable*; it is **exercised by shipped pipeline code**. Note the gate precisely: the
     adapter takes the offset branch whenever the request carries no watermark keys (`!hasOwnKeys(request.watermark)`),
     NOT merely when the pipeline mode is non-incremental — so an *incremental* run also pages by offset
     until a watermark has been stored. This raises, not lowers, the priority of the B1a ordering contract
     and the migration that must precede B2;
  4. values-free `unorderedOffsetAttemptCount` at **both** the route and the adapter entries — closes the runtime blind spot, but it is instrumentation. **Owner decision recorded: the B1-observability gate is NOT opened early** — it cannot accelerate #4437 and would add a new runtime deployment surface. M1's inventory therefore rests on items 1–3 and **must state this runtime residual explicitly** in the migration decision, not gloss it; the counter arrives in its §4 slot behind its own gate.

  ⟲R4 **M1 produces inventory evidence only — the B2 merge decision is NOT taken in M1.** Per §4, **#4591** (which superseded #4580) merges **LAST**, and only after adapter-chokepoint telemetry (B1-observability), the coverage-mapped caller inventory, and customer migration are complete: an HTTP access log cannot see plugin-internal or direct adapter callers, so "log-zero" alone can never green-light enforcement. This supersedes the earlier "inventory = 0 ⇒ merge B2" fast path (the conflict between that fast path and the §4 order is adjudicated in favour of §4). Standing rules regardless of counts: new paginated configs must declare a stable **unique** `orderBy` — ⟲C4 **fail-fast hardening, not stable-pagination certification** (presence-only; uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c); any live configs found ⇒ versioned config migration + preflight rejection first; never auto-guess a primary-key order.
- Keep the existing Integration Workbench config/probe/approve UI — **no second connector configurator**. `stock-prep:read/operate` permission split at M1 end; the pilot runs under a controlled admin.

**M2 (only on real-scale evidence from M0/M1).** Ratify scale-D0 first; run the `bridge.sealed_snapshot` feasibility spike; compare "export + signed manifest" vs interactive paging on true change surface; only then decide async job / staging / generation flip / multiset SQL diff. CDC, external write-back, D2 reconciliation, W3 suggestion dates, G1 notifications stay **off** the critical path (frozen).

## 3. B1 design (REVISED — owner findings absorbed)

### 3.0 ⟲B — B1a REDO REQUIRED: six boundaries frozen (redo NOT started)

**Status of the first B1a attempt (#4596 `774bdb5e6`, #4597 `d0313feec`): HELD; redo REQUIRED and NOT
STARTED.** ⟲B2 The earlier heading "B1a IS REDONE" was misread-able as *implementation already redone* — it
was never that. What is done is that the boundaries below are **frozen into the design**; no redo code
exists. Owner review found four P1s and two P2s. Every one is verified — three of them by me re-running the
reviewer's probe and, in one case, finding the defect to be *wider* than reported. The slice's own stated
goal — *forgery is inexpressible by construction* — was **not met**.

**B-1 · A qualification must prove the evidence came from the bound system.**
Two residuals, both **measured by the first attempt's own suite** and both pinned in
`__tests__/gip-binding-qualification-spike.test.cjs` **@ `774bdb5e6`** (⟲B2 symbol + exact head, per the doc
charter — the line numbers alone will rot, and the redo rewrites this file; ⟲B2 also: *not* the resolver
test, which is where an earlier revision of this paragraph wrongly pointed):
- `ratifiedPathRemainsAnOpenConstruction()` **L752-L805** — a qualification minted through the ratified
  `probe()` path over a **foreign field set** still verifies against the resolution, because evidence is
  values-free (`checkedKeyColumnCount` only) and verify therefore cannot see the field set;
- `callerSuppliedQueryRemainsAnOpenConstruction()` **L813-L847** — ONE caller-side answer that touches no
  system at all satisfies **two resolutions bound to different systems**, and both verify.

Both were recorded as accepted "residuals". That grading was wrong: **latency does not make an untrue
qualification trustworthy** — a qualification that verifies against evidence never observed on the bound
system is a false qualification whether or not anything consumes it yet. Required boundary: the source
handle is **derived from the resolution's own system record by a server-bound source executor**, and the
probed field set is derived from the resolution too; no caller may supply the query path. This is a
*precondition* of B1a, not a follow-up to it.

**B-2 · System identity comes from a dedicated lossless identity read — not from hashing the whole config.**

⟲B2 **What the first attempt actually hashes today** — `deriveSystemContentKey`,
`lib/gip-approved-binding-resolver.cjs` L153-L169 @ `774bdb5e6`:

```
{ domain tag, systemId, tenantId, workspaceId, kind, role, config }      // `config` enters WHOLE
```

Two defects, pulling in opposite directions:
- it **over-includes**. `config` enters whole, and the external-system config is an **open-shaped JSON
  object** — `external-systems.cjs` L93 `config: jsonObject(input.config, 'config')`, no key allowlist — so
  every non-identity field a connector happens to store there becomes part of the system's identity. Where a
  config carries a default object or a filter, an ordinary **config edit moves the system content key**: a
  config change presenting itself as a system repoint. This is exactly what B-2's headline rejects.
- it obtains **decrypted credentials** through the adapter read only to discard them at the boundary — an
  unnecessarily wide permission surface for an identity derivation.

⟲B2 **Frozen material the redo's identity read must produce.** The tables below are a **SPEC for the redo**,
not a description of the code above — earlier wording called them a completion of "the ratified formula",
which they are not: the ratified formula does **not** exclude object/filter selection, it includes them by
hashing `config` whole. My own earlier list ("endpoint + auth principal + scope") erred in the other
direction — it dropped `kind`/`role`, which the first attempt does hash and which genuinely are identity.

| INCLUDED | why |
|---|---|
| scheme / domain tag | a future derivation change can neither collide with this one nor impersonate it |
| scope — `tenantId`, `workspaceId`, `systemId` | a config may not bind a system outside its own scope |
| **system / connector kind**, and the read `role` (`source` \| `bidirectional`) | ⟲B2 the same endpoint reached through a *different connector kind* is a **different system**; omitting kind lets two connectors share one identity |
| endpoint / connection identity, and the **auth principal** (its identity, never its secret) | repointing at another host must invalidate qualifications taken against the old one |

| EXCLUDED | why |
|---|---|
| credential material **and secret version** | ⟲B2 a rotation does not change WHICH system this is; a version-sensitive key would churn on every rotation |
| **object / filter selection** | ⟲B2 that is `configContentKey` / binding territory — it would make an ordinary config edit look like a system repoint, and double-count the same fact in two tuple fields. **Not satisfied today** — see the whole-`config` hash above |
| `name`, `status`, `capabilities`, `lastTestedAt`, `lastError` | mutable human label and operational state; `status` is an **admission gate**, not identity |

**B-3 · `canonicalObjectVersion` pins a FIRST-PARTY canonical object contract version.**
⟲B2 **The earlier wording in this section was wrong about the field's job** and is withdrawn: it argued from
*"the code admits it cannot detect source-side schema drift"* (`gip-approved-binding-resolver.cjs`
L232-L252 @ `774bdb5e6`), which invites exactly the wrong
fix — an implementer would try to satisfy it by pushing **external database schema identity into the
canonical contract**. Correct division of responsibility:
- `canonicalObjectVersion` names the version of **our own first-party canonical object contract** — the
  declared canonical fields and semantics of the object, registered and versioned as a first-party artefact.
  Detecting source-side drift is **not** its job and never was.
- **External source schema drift** is carried by **source-catalog evidence**, by the **BindingQualification**,
  and by the **field-mapping qualification proof** — the artefacts actually observed against the live source.

So the real defect in the first attempt is not "it cannot witness the source schema"; it is that it
**invented the version locally**, deriving it from `systemContentKey + objectKey + fieldMap` — a pure
function of inputs **already present elsewhere in the same tuple**, which therefore adds no contract identity
whatsoever. It must be looked up from the first-party canonical object contract registry.

**B-4 · A probe SQL denylist is NOT a security boundary.**
`createProbeStrategyRegistry()` accepts an arbitrary `buildTotalOrderProbeSql`, so SQL-text inspection is the
wrong control surface. Verified — the owner supplied one bypass, and re-running it I found two more of the
same class. ⟲B2 Attribution, so this block is reproducible rather than asserted: guard =
`__internals.assertReadOnlySql` in `lib/gip-binding-qualification-spike.cjs` **@ `d0313feec`** (B1b lane),
whose token list is `RATIFIED_WRITE_TOKEN_PATTERN` + five dialect patterns.
```
control-pass  SELECT 1                                                  <- positive control: the guard is
                                                                           not a blanket refuser
PASSES        SELECT * FROM dblink('conn', 'DE' || 'LETE FROM x') AS t(x int)
PASSES        SELECT * FROM dblink('c', 'DR'||'OP TABLE x') AS t(x int)
PASSES        SELECT * FROM dblink('c', chr(68)||chr(69)||'LETE FROM x') AS t(x int)
BLOCKED       SELECT * FROM dblink('c', 'DELETE FROM x') AS t(x int)    <- negative control
              (PROBE_SQL_NOT_READ_ONLY)
```
Both controls are load-bearing: without the `SELECT 1` pass the block would also be produced by a guard that
refuses everything, and without the un-concatenated `DELETE` refusal it would also be produced by a guard
that is not wired at all. (First re-run of this probe reported all four as BLOCKED — a `TypeError` from
calling a non-exported symbol, caught by the same `catch` that was meant to observe refusals. The controls
are what exposed it.)
String concatenation defeats the token list; `chr()` defeats it with no literal keyword at all. The
7-constructs-to-0 result reported for B1b therefore measures resistance to **accidents, not construction**.
Required boundary: **only first-party builders registered by module-private identity**, or a **restricted
structured query constructor**. The denylist may remain as defense-in-depth; it may never be cited as the
boundary.

**B-5 · "Certified" requires a VERIFIED guarantee, not an honest label.**
B1b registered a SQL Server strategy whose own token reads
`no_single_statement_snapshot_under_default_read_committed` — and it still mints a candidate (verified).
Naming the absence of a guarantee does not fail closed; under the engine default it must **refuse
certification**. MySQL's token names three conditions (InnoDB, autocommit, isolation ≥ READ COMMITTED) and
the code checks **none** — they must be established **empirically on the same connection**. B1b's
certification gate does not open until a **real MySQL / SQL Server capability spike** passes.

**B-6 · Two namespace/closure gaps.** ⟲P2 `orderingKeySpec` `fieldId`s are canonical TARGET fields (the
resolver says so at `gip-approved-binding-resolver.cjs` L102-L120 @ `774bdb5e6`) but were passed straight to
the SQL builder — a **certified source-column translation** is required. ⟲P2 The production approved-config
allowlist (`read-source-config.cjs` `ALLOWED_CONFIG_KEYS`) does not accept `orderingKeySpec` or
`actionProfileVersion`, so the hermetic suite never exercised the real **save → approve → re-read → qualify**
loop; B1a is not provable until a real **config v2** carries these fields.

**Owner-set redo order for B1a:** real config v2 → system identity read with no credential decryption →
first-party canonical contract version → server-bound source executor with field translation → remove or
privatise the legacy `probe()` entry point. ⟲B2 It is transcribed into **§4 step 1**, which is the single
authoritative order; if this line and §4 ever disagree, **§4 wins**.

**Consequence for this line's status:** the earlier conclusion that *"the remaining critical path is owner
decisions, not engineering"* is **withdrawn** — there is real qualification-authenticity implementation work
remaining, and it is the largest unbuilt item on the line. The on-prem M0 track (complete RC-A package build
+ bounded approved config) is independent of B1a/B1b and may proceed in parallel.

### 3.1 ⟲P1-a — the certificate holds the REQUIREMENT; the config holds the FIELDS

The ratified certificate model already carries **`orderingKeyRequirement`** (contracts §certificate fields) — a capability-level *requirement*, never the customer's concrete columns. The concrete **`orderingKeySpec`** (ordered field list + directions) belongs to the **approved config version** (customer/binding-scoped, immutable per version). rev‑1 of this design put `orderingKeyFields` in the certificate — wrong layer; withdrawn.

**B1a core — server-side approved-binding resolver.** Input: `approvedConfigVersionId` (+ principal for authz). ⟲R3 The server derives the **complete qualification input tuple** — `{ actionProfileVersion, systemContentKey, configContentKey, objectKey, canonicalObjectVersion, orderingKeySpec }` — from the same tenant's approved **binding + config + system** records, and from nothing else. Binding only three fields (rev‑2's `{objectKey, orderingKeySpec, configContentKey}`) was insufficient: **any** digest input left caller-supplied re-opens the forgery as "config A + system-or-profile B". Requirements:
  - at resolution time, re-verify the version is STILL approved — **and still within the caller's tenant and scope** — through the existing **`getForRuntime()`** path (`readSourceConfigStore.getForRuntime`, called with scoped input; throws `NOT_APPROVED` for a non-approved version — approval, tenancy and scope are re-checked at resolution time, never assumed from the id);
  - the server **recomputes `configContentKey` from the immutable version body and compares** — it never blindly trusts a stored column;
  - **both probe and verify** re-enter through the resolver — no cached caller-side tuple is honoured;
  - callers cannot override **any** field of the tuple.

  The prober and the qualification-digest inputs accept ONLY this resolution object. Probe evidence stays values-free (`checkedKeyColumnCount` only — field names never enter evidence), so none of these forgeries could be detected after the fact — they must be **inexpressible**, not detectable.
- ⟲R2 **The resolution is deep-immutable, not merely provenance-checked.** WeakSet identity proves where the object came from; it does NOT stop a caller mutating a nested array (e.g. an `orderingKeySpec` entry) inside the probe's **async query window** — a shallow `Object.freeze` leaves nested structures writable. The resolution is therefore built as an **owned clone in the strict canonical-JSON domain, recursively frozen** — Proxy / accessor properties / sparse arrays / symbol keys **rejected** (`deepCloneFrozenCanonical` in `gip-canonical-json` is the reference primitive). **Mandated harness negative control:** mutate the ORIGINAL field array from inside the async query callback and prove the probe still uses the parse-time copy.
- Trust is **object identity** (module-private WeakSet), mirroring the existing probe-strategy registry pattern — a hand-built resolution object is refused.
- Owner adjudication recorded: `configContentKey` being a digest input is **necessary but not sufficient**; the resolver is what turns it into an actual binding.

⟲R6 **`orderingKeySpec` closed schema (frozen in B1a — a contract slice ships an implementable schema, not a slogan):**
- canonical `fieldId`s only — never raw SQL, expressions, or aliases;
- non-empty; duplicate `fieldId`s rejected;
- `direction ∈ {ASC, DESC}` only;
- every `fieldId` must resolve through the SAME approved config version's field mapping — unresolvable ⇒ closed rejection;
- NULLability is deliberately NOT a schema check: NULL keys stay **fail-closed at the qualification probe** (the duplicate/NULL probes), where they are observable against the live source.

### 3.2 ⟲P1-b — a probe certifies ORDER; it does not certify PAGING

`single_statement_mvcc` (and any B1b analog) certifies exactly **one probe statement** under one snapshot claim. It says nothing about a page *sequence*: `DataSourceManager.select()` is pool-per-call — no transaction or connection spans two pages today, and transaction objects cannot be passed into `select()`/`query()`.

Consequences, stated as scope:
- **B1b** (MySQL/MSSQL strategies) closes **total-order qualification** for those dialects — nothing more.
- **PAGED_READ certification additionally requires a page-sequence execution seam**: one certified consistency context spanning all pages (same-connection snapshot transaction, or a token-addressed immutable snapshot), with dialect-certified semantics and its own profile gate. That is **B1c**, design-first, not implied by B1a+B1b.
- Probe-execution seam note: probe SQL uses `GROUP BY`/`HAVING` shapes the structured facade cannot express, so B1b needs a **restricted internal probe-executor seam** — accepts ONLY strategy-minted statements (object-identity trust), read-only, statement-bounded, never reachable from HTTP input. Per the owner's dependency direction, core-backend contributes this bounded seam and nothing else; qualification definitions stay in the GIP layer.

### 3.3 ⟲P2-a — frozen legal combinations; rejection, never silent downgrade

"`PAGED_READ` ⇒ consistency proofs non-empty" is too weak. The certifiable combinations are a **FROZEN table** (extending the existing scale-D0 §2 cross-dimension legality pattern), ⟲R5 **named `PAGED_READ_LEGAL_COMBINATIONS` and consulted ONLY when `acquisitionMode === 'PAGED_READ'`** — it is not a global gate over all modes:

| consistency proof | continuation lifetime |
|---|---|
| `SOURCE_SNAPSHOT_TXN` | `CONNECTION_BOUND` |
| `IMMUTABLE_SNAPSHOT_TOKEN` | `DURABLE_TOKEN` |

`MONOTONIC_VERSION_PIN` is deliberately **unmapped for `PAGED_READ`** in v1: a version pin *detects* drift; it does not make pages mutually consistent — abort-on-drift is a weaker, different contract that would need its own ratification before appearing here. ⟲R5 It **remains legal where already ratified in other modes** — specifically, the ratified `CHANGE_FEED + MONOTONIC_VERSION_PIN + DURABLE_TOKEN` combination is untouched. **Mandated harness negative-control pair:** the existing `CHANGE_FEED` combination still certifies, while an out-of-table `PAGED_READ` combination is refused.

Any other `PAGED_READ` combination ⇒ **closed rejection at certification time** (e.g. `PAGED_READ_COMBINATION_UNSUPPORTED`). **Never silently downgrade to `BOUNDED_READ`**: the profile is refused; a caller that wants bounded semantics certifies a separate bounded profile (the `bridge.bounded_read.v2` pattern — one door per capability).

### 3.4 ⟲P2-b — contracts may be latent; counters cannot

`unorderedOffsetAttemptCount` only means something as **runtime instrumentation**, and a capability handshake is only real at a **wired endpoint** — both are incompatible with "latent" by definition. Therefore B1a freezes the **counter and handshake contract shapes only** — ⟲B2 a statement about *these two artefacts*, not a claim that B1a as a whole is contract-only (see Gate) — with hermetic harness tests:
- counter: name + values-free semantics (counts only, no identifiers);
- handshake: request/response schema — `clientBuild` / `connectorProtocolVersion` / `profileId` / `configVersion` → `READY` / `UPGRADE_REQUIRED` / `CONFIG_MIGRATION_REQUIRED`, version-incompatible ⇒ refuse to run.

**Wiring either is B1-observability — a separate runtime-authorization gate.** ⟲B2 Precision, since the
authority-substrate gate does permit an additive change to the approved-config validator: B1a **wires
neither** the counter nor the handshake into any live path, and adds **no request-reachable surface**. That
is a narrower and true claim than the earlier *"nothing in B1a touches a live path"*, which the config-v2
boundary contradicts.

### 3.5 ⟲P3-a — sealed snapshot's true scope

Sealed export is the **preferred** exit for the bridge / big-data / non-paginatable class (#4437's blocker class). It is **not** the sole exit for SQL sources: a direct SQL database may certify `PAGED_READ` once the B1c connection-bound snapshot reader exists. rev‑1's "multi-page consistency ⇒ sealed-export territory" is corrected to per-source-class — and ⟲C5 the routing decision is made **per capability spike** (does THIS source hold durable snapshots / stable cursors?), never uniformly per database brand.

## 4. Slice order — ⟲B2 PENDING RE-RATIFICATION; this section is the SINGLE authoritative order

**The previous order was ratified BEFORE §3.0 and is superseded.** It described B1a as *latent* and let B1b
register *certified* strategies directly — both now false. It is **un-ratified until the owner re-approves
this section**. Precedence rule, so the document cannot hold two orders at once: **where any earlier
paragraph (§2, §3.x) still implies a different sequencing or a different scope, §4 wins.**

1. **B1a (REDO)** — the authority substrate, in the owner-set order, each step landing behind the
   authority-substrate gate and **none of them request-reachable**:
   1. **real config v2** — `orderingKeySpec` (closed schema, §3.1⟲R6) + `actionProfileVersion` accepted by
      the approved-config validator, additively; the existing test that asserts today's rejection **flips in
      the same PR**, and configs omitting the fields are unaffected;
   2. **system identity read** — purpose-built, lossless, **no credential decryption**, over the frozen
      material of **B-2**;
   3. **first-party canonical object contract registry** + version lookup (**B-3**) — no locally invented
      version;
   4. **server-bound source executor** — handle and field set derived from the resolution, first-party
      statement builders admitted by module-private identity, restricted statement seam, plus **certified
      source-column translation** for `orderingKeySpec` (**B-1**, **B-6**);
   5. **remove or privatise the legacy `probe()` entry point** (**B-4**).
   - Retained from the prior design, unchanged: approved-binding resolver over the full six-field tuple,
     deep-immutable (§3.1⟲R2/⟲R3); qualification input binding through the resolution object for **probe AND
     verify**; `PAGED_READ_LEGAL_COMBINATIONS` (§3.3⟲R5); closed errors; hermetic harness.
   - **Acceptance predicate (not a slogan):** the two measured residuals of §3.0 B-1 must **invert** —
     `ratifiedPathRemainsAnOpenConstruction` and `callerSuppliedQueryRemainsAnOpenConstruction`
     (`gip-binding-qualification-spike.test.cjs` L752-L805 / L813-L847 @ `774bdb5e6`) assert
     *verified: true* today; after the redo the same constructions must produce a **closed refusal**, with a
     positive control proving a genuine server-executed probe still qualifies.
2. **B1b capability spike — REAL MySQL and SQL Server, before any certification.** Empirical only: establish
   on the **same connection** whether the claimed guarantees hold (MySQL: InnoDB, autocommit, isolation ≥
   READ COMMITTED; SQL Server: whether a single-statement snapshot is obtainable at all under the engine
   default). Mints **no certification** and registers **no strategy**. ⟲B2 This step did not exist in the
   ratified order and is the reason B1b previously shipped a strategy whose own token names the **absence**
   of a guarantee (**B-5**).
3. **B1b certification — opens ONLY if step 2 passes**, per dialect and per capability, never per brand.
   Each strategy carries a **verified** snapshot-semantics guarantee, registered per `actionProfileVersion`;
   where the guarantee is unobtainable under the engine default it must **refuse certification** rather than
   mint a candidate. Builders are admitted by **module-private identity**; the SQL denylist is
   defence-in-depth and **may never be cited as the boundary** (**B-4**). Unbound ⇒ `PROBE_STRATEGY_UNBOUND`
   (existing, fail-closed by name). PostgreSQL reuses the shipped reference strategy.
4. **B1c** — cross-page snapshot/session executor: design + per-dialect certification of a page-sequence
   consistency context.
5. **B1-observability** — counter + field-client handshake **wiring**. Separate runtime gate; owner decision
   recorded: **not opened early**.
6. **Customer migration** — in-repo inventory script per deployment; migrate any live configs to the
   versioned shape.
7. **B2 = #4591 enforcement** (adapter ordering guard + typed closed 422 + MSSQL fallback deletion).
   **LAST.** (#4580 CLOSED as superseded — see §1.)

**Parallel and unblocked by all of the above:** the on-prem M0 track — build and verify the complete RC-A
package, and prepare the bounded approved config (§2, authorization boundary strict: build + verify + revise
the #4437 pointer; **not** deployment, **not** flag-ON).

## 5. Implementer landmines (session-verified; read before touching)

- **apps/web error-code tripwire**: `integrationErrorCodeLabels.spec.ts` pins the bridge-adapter error-code array (`length===4` + set equality). A new adapter-owned code requires the FE mirror in the same PR.
- **Agent/protocol version must NOT enter the #4553 qualification digest** (`actionProfileVersion` is the certified single version identity). It is a certification-scoped preflight (owner ruling).
- **The PG probe builder is PG-shaped** (double-quoted identifiers, `LIMIT 1`, `::int` casts) — not portable. MySQL (backticks/`LIMIT`) and MSSQL (brackets/`TOP`/`OFFSET…FETCH`, different isolation story) need their own certified builders (B1b).
- **Trust is object identity** (module-private WeakSet) for strategy registries and the B1a resolver — never duck-type or "brand" objects with public fields.
- **`/select` error mapping** (`routes/data-sources.ts`): the catch maps only "not found" → 404; everything else → 500. The closed-422 mapping is IMPLEMENTED in #4591 (`DataSourceOffsetOrderingError` → 422, closed: generic errors still 500).
- **Inventory scripts: schema-probe FIRST.** Real run table = `integration_runs` (migration 057); there is no `metrics.pageCount` (real fields `details`/`rows_read`); `data_sources` shape varies across migrations. Central-DB counts cannot prove the absence of on-site `/select` callers — per-deployment access logs are required.
- **The offset path is EXERCISED, not merely reachable** — `pipeline-runner.cjs`'s `while (page < maxPages)`
  loop pages the `data-source:sql-readonly` adapter's non-watermark branch via `nextCursor = offset + n`,
  with no `orderBy`. Any statement that the exposure is limited to `copyData` (no live caller) is WRONG.
- **#4580's branch carried the pre-split A-half** — RESOLVED: re-cut from current main as #4591; #4580 CLOSED as superseded. Do not revive the old branch.
- **Bridge feeder test fixtures must echo `data.limit`** — adapter v2 fail-closes without the echo (a fixture that omits it is not "the real agent", which always echoes).
- **Do not raise the 500 single-page bound; do not wire the latent GIP profile** — both owner-gated.
- ⟲B2 **Config v2 is now IN scope, and it is a LIVE validation path.** `read-source-config.cjs`'s
  `ALLOWED_CONFIG_KEYS` does not contain `orderingKeySpec` / `actionProfileVersion`, so a body carrying them
  is rejected **at save time today**, and the B1a suite asserts that rejection *behaviourally*. Adding the
  keys is **additive only** — closed rejection on shape, no behaviour change for configs that omit them —
  and the assertion that pins today's rejection must be **flipped in the same PR**, never deleted.
- ⟲B2 **`canonicalObjectVersion` is a first-party contract version.** Do not attempt to make it witness the
  external source's schema; drift belongs to source-catalog evidence / BindingQualification / field-mapping
  proof (§3.0 B-3). A derivation that is a pure function of the other tuple fields adds nothing.
- ⟲B2 **`systemContentKey` must include the system/connector `kind`** (and read `role`) and must exclude
  secret version and object/filter selection (§3.0 B-2). Same endpoint + different connector kind = a
  **different** system.

## 6. Fences

Nothing in this document authorizes: runtime enforcement (#4591/B2), arming or runtime wiring of any GIP
profile, telemetry/handshake wiring, sealed-snapshot implementation, page-size ceiling changes, CDC /
external write-back / D2 / W3 / G1 work (frozen), or rollout.

⟲B2 Approval unlocks the **B1a authority-substrate gate** as defined verbatim in **Gate** at the head of this
document — **not** "latent contract + harness only", which is withdrawn. That gate permits the five bounded
internal changes of §4 step 1 and forbids every request-reachable or runtime-consuming surface over them;
the one-line test is *"reachable from a request or a scheduled run ⇒ outside the gate."* Every later slice
re-enters its own gate. **§4 is itself pending re-ratification** — until the owner re-approves it, no slice
after B1a step 1 is scheduled by this document.
