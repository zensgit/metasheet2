# Database & System Integration Line — Design and Verification (2026-07-24)

**Status, per section** (⟲B2-self — an earlier blanket "§2–§6 are PROPOSED" was wrong: a *proposed* fence bounds nothing, and §5 is code fact): **§1** = RECORD of landed, verified facts (head-scoped SHAs). **§2** = owner-set route **with decisions already taken** (package policy (b); B1-observability not opened early; M0-A authorized). **§3** = design, ⟲-absorbed. **§4** = the single authoritative slice order, **RATIFIED** (owner, 2026-07-25, @ `a7c562d34`) — **a proposed amendment to step 1.4 (⟲OD3: core-backend seam removal) is in flight and is NOT yet ruled; see Gate bullet 4 and §4 step 1.4. The B-6 obligation (A)/(B) split at the same step is a separate, already-ruled (δ) clarification, not gated by OD3 — see §3.0 B-6 and the (δ) row.** **§5** = session-verified code fact, same evidentiary grade as §1. **§6** = **binding** fences. The document itself ships no code. What its approval unlocks is defined in **Gate** immediately below — a bounded **authority-substrate** gate, **not** "latent only". **§4 is the single authoritative slice order** and is **RATIFIED** (owner, 2026-07-25, @ `a7c562d34`); **⟲OD3's proposed amendment to it remains PROPOSED, pending owner ruling, not part of the ratified text.**

**Gate (owner, 2026-07-24; ⟲B2 REVISED).** The earlier wording — *"unlocks only the B1a latent contract + harness slice"* — is **WITHDRAWN as self-contradictory**: §3.0's boundaries cannot be met inside a latent slice. A real **config v2** changes a **live approved-config validation path**, and the identity read / canonical contract registry / server-bound source executor add **internal derivation and connection paths**. Calling that "contract + harness only" would have let production-path changes land under a gate that never authorized them. The gate is therefore renamed for what it actually is:

> **B1a AUTHORITY-SUBSTRATE gate — PERMITTED, bounded:**
> - **additive** `orderingKeySpec` / `actionProfileVersion` acceptance in the approved-config validator — closed rejection on shape, and **no behaviour change for any config that omits them**;
> - a purpose-built **system identity read** implementing the ratified GIP-D0 §6 formula (B-2). ⟲OD The flat "does not decrypt credentials" wording is withdrawn as unsatisfiable — the auth principal and scope live in the **encrypted credential envelope**, not in `config` — and is **replaced by the ruled rule (owner decision (α), 2026-07-25)**: decrypt **only inside the `credential-store` boundary**, only **briefly**, only to extract **connector-certified** principal/scope material; **domain-separated HMAC / canonicalise immediately, then discard the plaintext**; **secrets and principal plaintext never enter evidence, logs or errors**. Full text and the rotation semantics at §4 step 1.2;
> - a **first-party canonical object contract registry** and its version lookup (B-3);
> - a **server-bound source executor** — resolution-derived handle, first-party statement builders, restricted statement seam — plus certified source-column translation (B-1, B-4, B-6). ⟲B2-self This bullet **includes the bounded core-backend statement seam** of §3.2 (not request-reachable, accepts only strategy-minted statements); it is named here because every other bullet is plugin-layer, and a second-package production change permitted only by implication is the very thing owner finding P1-1 was raised about. **⟲OD3 — RETRACTION FIRST: an earlier revision of this bullet stamped it "AMENDED (owner, 2026-07-26)" and asserted the bounded core-backend statement seam was already removed from this gate. No such ruling exists — that authority claim is WITHDRAWN.** ⟲OD3 is instead a **PROPOSED amendment, submitted 2026-07-26 and pending owner ruling**: remove the bounded core-backend statement seam from this gate; it would defer with the SQL path to (b′) + B1c. Reasoning, under decision (δ)'s **already-ruled (2026-07-25) v1 = (c)**, on three counts: §3.2's *entire* justification for the seam is that **probe SQL** uses `GROUP BY`/`HAVING` shapes the structured facade cannot express — and (c) makes SQL **unreachable** in v1, so the requirement has no v1 source; §3.2's named consumer is **B1b's SQL builders**, which (c) also makes unreachable, so the seam would ship with **zero v1 consumers**; and it lives in a **second package**, so building it now would land unreachable production code in core-backend under an "already authorized" reading — which is exactly what owner finding P1-1 was raised about. **If ruled, v1 step 1.4 becomes plugin-layer and HTTP-only, and the seam re-enters with (b′) + B1c, behind that gate. Until ruled, the bullet above — seam and translation in-gate, per B-1/B-4/B-6 — is the authorized text; the proposal is not.** ⟲B2-self **Credential and connection scope, stated rather than left silent:** this executor unavoidably needs connection material. ⟲OD **TWO MATERIALS, TWO RULES — an earlier draft applied the identity rule to both, which no implementer could satisfy** (you cannot simultaneously "discard the secret" and "complete an authenticated connection"):
>   - **identity material** (principal / scope, for `systemContentKey`) → decision (α): decrypt inside the `credential-store` boundary, **domain-separated HMAC / canonicalise immediately, discard the plaintext**. HMAC applies **here and only here**;
>   - **authentication secret** (for actually connecting) → **consumed inside the boundary by a `credential-store` / connector-owned factory**, which returns an **opaque handle / execution closure**. The secret is **never returned to, held by, or reachable from the executor**; the executor holds only the opaque handle. HMAC is **not** applicable — a hashed secret cannot authenticate.
>
>   Both share the same never-into-evidence-logs-or-errors constraint. Execution is **only against a harness / fixture source, or a first-party engine instance**; **any connection to a live customer system is outside this gate** and is its own ops-gated step (⟲B2-self *not* §4 step 2, which an earlier revision named by default — that step runs against first-party engine instances and never claimed customer connection);
> - **removal or privatisation** of the legacy `probe()` entry point — ⟲B2-self this closes **B-1**'s first residual (the caller-supplied tuple / `keyColumns` path), **not B-4**; B-4 is closed by **bullet 4's module-private builder identity and by §4 step 3** — ⟲B2-self naming step 3 alone (an earlier draft) reads as putting builder identity outside this gate, which bullet 4 contradicts;
> - the previously-designed B1a internals that are **not** request-reachable and are unchanged by ⟲B: full-tuple resolver (**minus** `canonicalObjectVersion`, which now comes from bullet 3's registry), deep-immutable resolution, `PAGED_READ_LEGAL_COMBINATIONS`, closed errors, hermetic harness (§4 step 1, "Retained") — **plus** §3.4's counter and handshake **contract shapes**, hermetic tests only, **no wiring**. ⟲B2-self This bullet exists because withdrawing the "latent contract + harness" clause withdrew the only sentence that authorized these artefacts, while §4 and §3.4 still schedule them — a regression this revision introduced, not an inherited one.
>
> **STILL FORBIDDEN — each its own later gate:** any HTTP route or otherwise request-reachable surface over the above **beyond the one carve-out below**; any **runtime consumer** of a GIP profile; arming / activation / rollout; telemetry or handshake **wiring** (B1-observability); the **B2 enforcement merge** (**#4591**); sealed-snapshot implementation; page-size ceiling changes; CDC / external write-back / D2 / W3 / G1 (frozen).
>
> **Boundary test — stated as a permission and a prohibition, not as a one-line slogan.** ⟲B2-self Two earlier drafts failed here. The first said *"reachable from a request or a scheduled run ⇒ outside the gate"*, which **excludes the gate's own first permitted item**; the second tried to save it with an "additive acceptance" carve-out, which still leaves *"config v2 makes a save request behave differently"* true and the test self-contradicting. The gate is therefore stated directly:
> - **PERMITTED on the existing draft/save path:** validation and persistence of the **new fields only**. Nothing else about that path changes.
> - **FORBIDDEN — any NEW instance of these, reachable from a request or a scheduled run:** qualification execution; read of an external source; side effect; route. ⟲B2-self *"new"* is load-bearing on all four, not decoration: read as absolutes, two are **already false of the shipped surface** — `POST /api/integration/external-systems/:id/read-source-probe` (`http-routes.cjs` L20 @ `774bdb5e6`) is a shipped route whose handler performs a **credentialed outbound probe**. The gate forbids *adding* to that surface; it does not pretend the surface is empty.
>
> The approved-config validator is request-reachable — `POST /api/integration/read-source-configs` (`http-routes.cjs` L21) → `read-source-config-store.cjs` L205 `saveVersion` → L212 `validateReadSourceConfig` → `read-source-config.cjs` L139 `ALLOWED_CONFIG_KEYS` — and §4 step 1.1 is the **only** in-gate item that touches it. ⟲B2-self **Two enforcement points, not one:** the allowlist decides *acceptance*; `normalizeReadSourceConfig` (`read-source-config.cjs` L277-L304) decides *persistence* — it is an explicit **key-by-key projection** returning `Object.freeze(out)`, and the store persists and hashes **that** projection (`read-source-config-store.cjs` L216-L217, L244). **Allowlisting alone accepts the fields and silently discards them.** (All @ `774bdb5e6`.)

This is the line's single design-and-verification document (owner directive: consolidate closeout facts into one MD; stop letting working memos drift). It absorbs and supersedes the session working memos (`/tmp/gip-decision-memo-20260724.md`, `/tmp/b1-paged-read-certification-design-20260724.md` rev‑1) and the retired ad-hoc inventory SQL (NO-GO; §5).

Owner-review absorption markers used below: ⟲P1-a (ordering-key layering), ⟲P1-b (probe ≠ paged execution), ⟲P2-a (frozen combinations / no silent downgrade), ⟲P2-b (latent vs telemetry), ⟲P3-a (sealed snapshot not the sole exit). Codex-review absorptions (2026-07-24) are marked ⟲C1 (M0 exact-SHA package policy — BLOCKING), ⟲C2 (inventory-zero coverage map), ⟲C3 (#4580 re-cut + typed 422 as merge condition), ⟲C4 (orderBy = fail-fast, not stable pagination), ⟲C5 (per-capability routing, not per-brand). Owner ratify-review absorptions (2026-07-24, round 2) are marked ⟲R1 (exact-SHA exits: two-proof-only + freeze the new SHA), ⟲R2 (deep-immutable resolution, not provenance-only), ⟲R3 (full-tuple resolver), ⟲R4 (M1 = evidence only; the §4 order wins), ⟲R5 (combinations scoped to PAGED_READ), ⟲R6 (orderingKeySpec closed schema). Package/decision round (owner, 2026-07-24 late): ⟲R7 (complete-package two-SHA structure), plus three recorded decisions — package policy (b) with a build-only authorization boundary; B1-observability NOT opened early; B2 re-cut now as Draft **#4591**, superseding #4580. Qualification-authenticity round (owner, 2026-07-24, round 3): ⟲B (the six §3.0 boundaries). Boundary-review round (owner, 2026-07-24, round 4): ⟲B2 — authority-substrate gate replaces the self-contradictory "latent only" wording; `canonicalObjectVersion` = first-party contract version, drift belongs elsewhere; `systemContentKey` freeze material completed; §4 becomes the single authoritative order, **re-ratified by the owner 2026-07-25 @ `a7c562d34`**. ⟲Codex marks the doc-charter absorption. **⟲OD3 — RETRACTION: an earlier revision of this legend marked ⟲OD3 as a "(δ)-consistency amendment ruled by the owner on 2026-07-26." No such ruling exists; that claim is WITHDRAWN.** ⟲OD3 instead marks a **PROPOSED (δ)-consistency amendment, submitted 2026-07-26 and pending owner ruling** — it recommends that the bounded core-backend statement seam leave B1a step 1.4 and travel with the SQL path to (b′) + B1c (Gate bullet 4, §3.2, §4 step 1.4), and separately clarifies that B-6's SQL-side source-column translation (not the HTTP-side `fieldMap` translation, which stays v1) has no v1 source under already-ruled decision (δ). **Until ruled, the seam remains in-gate as ratified.** **⟲OD2** marks the **post-ratification amendments ruled by the owner on 2026-07-25** (§4 step 1.1's characterisation-test wording; the M0-A loopback check). **⟲OD** marks the **owner decisions ruled 2026-07-25** — the four in the §4.0 roster, plus the approved narrow widening of GIP-D0 §9.2. **⟲B2-self** marks defects in **this revision's own earlier drafts**, corrected in place and tagged rather than silently fixed, so a reader can see which sentences have already been wrong once. Provenance is mixed and is **not** claimed as self-review throughout: the GIP-D0 retraction, the Gate boundary-test restatement and the three SQL Server outcomes came from the **owner's precheck** on the intermediate head; the rest came from adversarial review passes and from self-review.

**Upstream contracts this ledger defers to** (⟲B2-self added — their absence is how an implementation artefact
came to be quoted here as "the ratified formula"): **`GIP-D0` general integration platform design lock**
(`docs/development/gip-d0-general-integration-platform-design-lock-20260723.md`, landed on main via #4553
`a53a199b1`) — authoritative for `systemContentKey` / `roleBindingFingerprint` / `secretVersionId` and the
system-vs-config identity split; and the ratified certification contracts in
`gip-profile-certification-contracts.cjs`. Where this ledger and an upstream lock disagree, **the lock wins**
and this ledger is the thing to fix.

⟲B2-self **One declared exception, because otherwise that rule refuses this document's own gate.** GIP-D0 is
**RATIFIED NARROW**: §9.2 / §10 unlock implementation of exactly three things — *profile schema, compliance
harness, read-only qualification spike*. The authority-substrate gate below permits items in **none** of
the three: the **live approved-config validator** change and the **bounded core-backend statement seam**. The
gate is owner-dated **2026-07-24**, one day after the lock, so this is read as a deliberate **widening of
GIP-D0 §9.2. **⟲OD APPROVED by the owner, 2026-07-25, at exactly this scope — unlocked, and this is the SOLE
current authoritative list:**
1. **config v2 additive validation / persistence**;
2. the **internal authority substrate**;
3. the **restricted statement seam**, reachable from **fixture / first-party engine** only.

**⟲OD3 — RETRACTION: an earlier revision of this paragraph asserted, as an already-ruled fact, that the
widening's live scope "NARROWS to the validator change alone." No such ruling exists; that claim is
WITHDRAWN.** ⟲OD3 is instead a **PROPOSED amendment, submitted 2026-07-26 and pending owner ruling**: if the
seam-deferral proposal at Gate bullet 4 is ruled, item 3 above would **narrow to the plugin-layer restricted
statement seam**; its **core-backend component** would defer, its unlock travelling with (b′) + B1c and
requiring re-approval there. Narrowing an approved scope needs no new authorization, but this note is recorded
now — before any ruling — because a reader comparing the approved three-item list against this document must
not conclude an item went missing silently. **Until ruled, item 3 above stands unchanged, in full, as part of
the sole authoritative list; this paragraph is a forward-looking pending note, not a second live scope.**

**Still forbidden under the widening:** ⟲OD **any NEW request surface or other request-reachable behaviour,
with exactly one exception — validation and persistence of the new fields on the EXISTING draft/save path**
(item 1 above; the Gate's boundary test states it identically). An earlier draft wrote "the request surface"
as an unconditional prohibition while item 1 unlocks a change on that very path — the same self-contradiction
the boundary test was rewritten to remove, repeated one section away. Also still forbidden, without
exception: the **scheduler**, any **runtime consumer**, **arming**, **deployment**, **rollout**. On everything
else — and on **all contract material**, including `systemContentKey` — the lock wins unchanged.

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
- **B2 enforcement = #4591 (DRAFT, merges LAST)** ⟲C3 — pure re-cut from current main per owner ruling; **#4580 CLOSED as superseded** (its branch carried the A-half already landed via #4583 and went `DIRTY`). #4591 contents, exactly the owner-listed three: adapter-layer OFFSET-ordering fail-fast guard (offset > 0 without `orderBy` ⇒ fail-closed, all three SQL adapters; registry-derived conformance roster) + **typed closed 422** (`DataSourceOffsetOrderingError` / `DATA_SOURCE_OFFSET_ORDERING_REQUIRED` — previously every non-not-found `/select` failure surfaced as `SELECT_ERROR` 500; the mapping is closed, generic errors still 500, pinned by test) + deletion of MSSQL's non-deterministic `ORDER BY (SELECT NULL)` fallback. **Observability contracts deliberately excluded** (owner ruling — B1-observability slice, own gate). Mutation-verified both ways (guard-neuter reds the fail-closed cases; mapping-removal reds exactly the 422 case); suite 16/16; full unit suite green; `tsc` clean. ⟲C4 honest claim unchanged: fail-fast hardening only — uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c. **Merge order and preconditions: §4 item 7** ⟲B2-self — this RECORD bullet previously carried a three-item precondition set of its own, which §4 (six preceding items) contradicts; §1 records landed facts and schedules nothing. M1 itself takes no merge decision.
- **Retired NO-GO**: the ad-hoc inventory SQL — four schema-fact errors (wrong status vocabulary — external-system status is `active/inactive/error`; `integration_pipeline_runs` does not exist, the real table is `integration_runs` per migration 057; no `metrics.pageCount`, real fields are `details`/`rows_read`; `data_sources` shape is inconsistent across migrations ⇒ schema probe first). Replacement: an **in-repo, tested** script run **per customer deployment**, combining DB counts + local `/select` access logs (+ the B1-observability counter once separately authorized). A central-DB count alone cannot prove the absence of on-site HTTP callers.

## 2. M0–M2 acceleration route (owner-set; amendments marked PROPOSED)

**M0 — ⟲B2-self TWO PHASES (§4's parallel track names both).** The old "24–48h, zero product code" headline
is stale against exit (b) below, which requires building, checksumming and controlled-deploying a new complete
package. **M0-A = authorized now** (build + verify the package, revise the #4437 pointer, prepare the bounded
config). **M0-B = ops-gated** (controlled deploy → flag-OFF health → preflight → flag-ON window → 11-item
PASS). The rest of this paragraph describes M0-B's acceptance content. Config owner creates a NEW approved config version (old versions untouched) bound to a provably single-page object — actual rows strictly below the agent-echoed effective limit. Flag-OFF preflight ⇒ `SHORT_PAGE`; then one C-stage flag-ON window; 11-item PASS ⇒ close #4437. ⟲C1 closure claim: that PASS closes #4437 as a **bounded-subset mechanism acceptance** — one tenant, one source; it claims **no large-scale capability**. Stop-loss: if no object can be safely narrowed, stop repeat acceptance and enter the M2 spike.
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

**Status.** ⟲B2-self Stated per slice — an earlier revision lumped both PRs together as "the first B1a
attempt", which #4597 is not:
- **First B1a attempt: #4596 `774bdb5e6` — HELD; redo REQUIRED and NOT STARTED.**
- **First B1b attempt: #4597 `d0313feec`** (stacked on it) — **HELD, and superseded by §4 steps 2-3**, which
  require the real-DB capability spike before any strategy may be registered. B-4 and B-5 below are findings
  against *this* PR; it is not retargeted to main.

⟲B2 The earlier heading "B1a IS REDONE" was misread-able as *implementation already redone* — it was never
that. What is done is that the boundaries below are **frozen into the design**; no redo code exists. Owner
review found four P1s and two P2s; they are written up as **six** boundaries because two of the P1s each
carry two independent requirements (B-1's source handle and field set; B-5's SQL Server and MySQL
guarantees), and B-6 collects the round's two P2s. Every finding is verified — three of them by me re-running
the reviewer's probe and, in one case, finding the defect to be *wider* than reported. The slice's own stated
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

⟲B2-self **RETRACTION FIRST: this section previously said "the ratified formula hashes `config` whole." That
is FALSE.** It described **#4596's first implementation**, not the ratified spec, and the two are different —
which is the same mis-attribution class as citing the wrong test file, one layer up. The ledger had never
cited the design lock at all, which is how an implementation artefact came to be quoted as the contract.

**RATIFIED — `GIP-D0` design lock §6, landed on main via #4553** (`a53a199b1`,
`docs/development/gip-d0-general-integration-platform-design-lock-20260723.md`):

```
systemContentKey = hash( system/connector kind
                       + endpoint identity
                       + stable authPrincipalKey
                       + authTenantScopeKey )
```
with the boundaries fixed in the same lock: **object / filter / data-selection scope belongs to
`configContentKey`**; **`secretVersionId` enters security evidence and runtime re-verification only, never
business baseline lineage** (same principal, rotated key ⇒ **no** baseline rebuild; principal or data-permission
scope changes ⇒ re-verify and produce new lineage); and **`actionProfileVersion` must not move
`systemContentKey`** — upgrading the read implementation is not "the external system changed" (the profile is
pinned separately in `roleBindings[]`).

**WHAT #4596 ACTUALLY BUILT — a deviation from that lock, not an instance of it** (`deriveSystemContentKey`,
`lib/gip-approved-binding-resolver.cjs` **L552-L581**, hashed `material` object at L571-L579, @ `774bdb5e6`
— ⟲B2-self an earlier revision cited L153-L169, which is the `// D2.` **design comment** restating the
formula in prose; the charter asks for symbol + head, and this was the one citation whose symbol and line
range pointed at different things):

```
{ domain tag, systemId, tenantId, workspaceId, kind, role, config }      // `config` enters WHOLE
```

Three deviations, and the middle one is the one that matters:
- **`config` enters whole.** The external-system config is an open-shaped JSON object
  (`external-systems.cjs` L93 `config: jsonObject(input.config, 'config')` — no key allowlist), so every
  non-identity field a connector stores there joins the system identity. A config carrying a default object or
  filter makes an ordinary **config edit move the system content key** — precisely the split GIP-D0 §6 draws
  between `systemContentKey` and `configContentKey`.
- **`role` and the raw `systemId` / `tenantId` / `workspaceId` are added.** ⟲B2-self An earlier revision of
  this section proposed **keeping** `kind` *and* `role` and called it "completing the ratified formula". Wrong
  twice over: the ratified formula contains neither `role` nor the raw ids, so this was an **amendment
  presented as a completion**. Owner ruling: **do not add them** — `role` is an admission / capability
  re-verification item, and the binding + config already pin which system record is in play. If they are ever
  wanted, that is a **new amendment requiring its own ratification**, never a "completion".
- it obtains **decrypted credentials** through the adapter read only to discard them at the boundary — an
  unnecessarily wide permission surface for an identity derivation. ⟲B2-self **But note what the ratified
  formula then requires**, because the two facts together are decision (α) at §4 step 1.2: `authPrincipalKey`
  and `authTenantScopeKey` are **not in `config`** for any shipped connector kind — the K3 WISE WebAPI adapter
  reads `username` and `acctId`/`accountSet` from `credentials` (`adapters/k3-wise-webapi-adapter.cjs`
  L1555-L1557), the HTTP adapter reads `username`/`password` from `credentials`
  (`adapters/http-adapter.cjs` L131), and that envelope is what `credential-store.cjs` encrypts. So "derive
  the ratified identity" and "never decrypt" **cannot both hold today**. ⟲OD **Ruled (α):** decrypt only
  inside the `credential-store` boundary, briefly, for connector-certified principal/scope material;
  domain-separated HMAC / canonicalise immediately; discard the plaintext; never let a secret or a principal
  in the clear reach evidence, logs or errors. Rotation with an unchanged principal and scope leaves
  `systemContentKey` **unchanged**; a changed principal or permission scope **forces lineage rebuild and
  re-qualification**. ⟲OD **Scope of that rule: identity material only.** The **connection secret** is
  consumed inside the boundary by a **connector-owned factory** returning an **opaque handle / execution
  closure**, never exposed to the executor — HMAC-and-discard is meaningless for it, since a hashed secret
  cannot authenticate.

**The redo implements the ratified formula.** So the material below is not a new spec; it is GIP-D0 §6:

| INCLUDED (GIP-D0 §6) | note |
|---|---|
| system / connector **kind** | the same endpoint reached through a different connector kind is a **different** system |
| **endpoint identity** | a repoint must invalidate qualifications taken against the old endpoint |
| stable **`authPrincipalKey`** | the principal's identity — never its secret |
| **`authTenantScopeKey`** | the authenticated principal's **tenant / permission domain** — not our internal `tenantId`/`workspaceId` |

⟲B2-self **EXCLUDED, split by WHERE THE EXCLUSION COMES FROM** — an earlier revision headed this table *"why (per the lock)"*, attributing to GIP-D0 two rows it does not contain. Verified: the lock has **zero** occurrences of `capabilities` / `lastTestedAt`, and its only `role*` tokens are `roleBindingFingerprint` / `roleBindings` / `roleId` / `roleType` — **scenario** roles, a different concept from the external-system `role` field. Same mis-attribution class as the previous two, so provenance is now on every row:

| EXCLUDED | source | why |
|---|---|---|
| object / filter / data-selection scope | **GIP-D0 §6** | carried by **`configContentKey`**; including it makes a config edit look like a system repoint |
| `secretVersionId`, credential material | **GIP-D0 §6** | security evidence + runtime re-verification only; a key rotation must **not** rebuild the business baseline |
| `actionProfileVersion` | **GIP-D0 §6** | pinned separately in `roleBindings[]`; upgrading the read implementation must not read as "the external system changed" |
| `role`, raw `systemId` / `tenantId` / `workspaceId` | **owner ruling, round-4 precheck** — *not* the lock | absent from the ratified formula; `role` is an admission/capability re-verification item, and binding/config already pin the system record. Adding them = a new **amendment**, not a completion |
| `name`, `status`, `capabilities`, `lastTestedAt`, `lastError` | **#4596's own D2 comment** (L162-L166), retained as sound — *not* the lock | mutable label and operational state; `status` is an **admission gate**, not identity |

**The implementation obligation the narrow formula carries — and it is real.** "Endpoint identity" and
"`authPrincipalKey`" must be *extracted* from the stored system record, and the config has **no schema**:
nothing states where a given connector kind keeps its endpoint or principal (`baseUrl`, `connectionString`,
`jdbcUrl`, `host`+`port`, something nested). An extraction that guesses is **silently blind** — a system
repointed through an undeclared key would keep its identity, which is the realized forgery #4596 was fixing.
Two mandatory conditions, and they are the reason #4596 over-corrected into hashing everything:
1. **A per-connector-kind certified identity declaration** — for each `kind`, which stored keys carry endpoint
   and principal. First-party and versioned, like the canonical object contract of B-3.
2. **Fail closed on an undeclared kind** — ⟲OD ruled (β): the connector-kind registry is **first-party and
   CLOSED**, existing aliases are **mapped explicitly**, an unknown kind fails closed for GIP binding with
   **`SYSTEM_IDENTITY_KIND_UNCERTIFIED`**, the registry is **never auto-extended from customer free strings**,
   and **legacy paths keep working** — the refusal scopes to GIP binding, not to what already functions.
3. ⟲B2-self **`authTenantScopeKey` needs the same treatment and currently has none.** The formula has four
   hashed terms; `kind` is on the record and the declaration above covers endpoint and principal — but
   `authTenantScopeKey` has **no stated source, no extraction rule and no fail-closed rule**, and the
   upstream lock does not supply one either (GIP-D0 §6 names it in the formula and in the boundary paragraph
   but never says where it is read from). For the connector class B1b/B1c target it may sit in the same
   encrypted envelope as the principal. It must be declared per kind and fail closed exactly like the other
   two, or the redo ships a formula one term of which is unsourced. Losslessness stays enforced at the read: the record is
   the **stored** one, never a sanitized projection — `assertLosslessSystemIdentityConfig`'s refusals are
   retained, since hashing `sanitizeIntegrationPayload`'s output was a **realized** forgery reproduced in five
   classes, three of them key-name-independent truncation.

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
whose guard is **two ratified patterns** (`RATIFIED_WRITE_TOKEN_PATTERN`, `RATIFIED_ROW_LOCK_CLAUSE_PATTERN`)
plus **four dialect patterns**, exposed as `__internals.readOnlyGuardPatterns` (⟲B2-self an earlier revision
wrote "one + five" — the total is six either way, so the tabulated result is unaffected, but a block sold as
reproducible must name the artefact correctly).
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

**B-6 · Two namespace/closure gaps** (⟲B2-self retagged: these are the **round-3 ⟲B** set's two P2s — an
earlier revision marked them with a bare ⟲P2, which the legend already assigns to round-1 items).
⟲B `orderingKeySpec` `fieldId`s are canonical TARGET fields (the
resolver says so at `gip-approved-binding-resolver.cjs` L102-L120 @ `774bdb5e6`) but were passed straight to
the SQL builder — a **certified source-column translation** is required. ⟲B The production approved-config
allowlist (`read-source-config.cjs` `ALLOWED_CONFIG_KEYS`) does not accept `orderingKeySpec` or
`actionProfileVersion`, so the hermetic suite never exercised the real **save → approve → re-read → qualify**
loop; B1a is not provable until a real **config v2** carries these fields.

⟲B2-self **The translation's INPUT ARTEFACT DOES NOT EXIST — do not schedule this as a sub-bullet without
saying so.** The resolver header states it outright: the target → source-column translation *"needs a
per-system column mapping that does not exist today"* and *"a probe strategy may NOT guess it"*
(`gip-approved-binding-resolver.cjs` L102-L120 @ `774bdb5e6`). Worse than unbuilt, it may be **categorically
absent for this config shape**: a `fieldMap.source` is a **dotted HTTP response path** (`'Data.FQty'`) and a
`target` is a cleansing-zone column id (`'material_code'`), while the approved-config plane is HTTP-shaped
(`readPath` / `readMethod` / `containerPaths` are the allowlisted keys) and the probe emits **SQL identifiers**
against `objectKey` — so for an HTTP-shaped config **neither side of `fieldMap` is a SQL column**.
⟲B2-self **And the obvious escape hatch is STRUCTURALLY EMPTY — an earlier revision offered it anyway.**
"Scope the executor to SQL-shaped sources only" scopes it to the **empty set**: every valid approved
read-source config is HTTP-shaped **by construction** — `readMethod ∈ {GET, POST}` and `readPath` are
validated **unconditionally, with no mode exemption** (`read-source-config.cjs` L166-L167), `mode` is
restricted to four HTTP read modes (L19), and `ALLOWED_CONFIG_KEYS` (L52-L58) carries **no SQL-source key at
all** — and the resolver binds exactly this plane (`getForRuntime`). So the approved-config plane admits no
SQL source today, which also means B1b's certified SQL builders are **unreachable from it**.

**⟲OD RULED (owner, 2026-07-25) — v1 = (c).** The three branches were:
- **(a)** name and build the artefact that supplies per-system **source column names**, inside step 1.4;
- **(b′)** extend the approved-config plane to admit a **SQL-shaped source class** — itself a gated change to
  a live validator, larger than step 1.1;
- **(c)** ✅ **CHOSEN** — B1a admits **connector-owned, NAMED, CERTIFIED HTTP probe actions only**; the **SQL
  builders stay unreachable**, which is the accepted v1 outcome rather than a gap to route around.

Explicitly refused for v1, so neither can be reached for on schedule pressure: **widening `approved-config`
to a SQL-shaped class**, and **inventing a source-column artefact**. The SQL path is deferred to a later
**(b′) + B1c** step behind **its own gate**.

⟲B2-self **Cross-reference — everything above is obligation (A) only; a second, separate obligation (B) is
NOT deferred (see §4 step 1.4 for the split).** This section and the (δ) ruling above are SQL-framed throughout
because obligation **(A)** — `orderingKeySpec`'s SQL target `fieldId` → source column, for a SQL builder — is
the only translation this ruling reaches; it has no v1 source and is deferred to (b′) + B1c, as stated. A
**second, distinct B-6 obligation, (B)** — HTTP `fieldMap` → response path / field set, for the certified
HTTP probe surface v1 actually runs — is **not covered by the SQL ruling above and is not deferred**: it
remains **v1 work**, derived server-side from the approved resolution (B-1), never supplied or interpreted by
the caller. A reader who stops at this section should not conclude B-6 in its entirety is deferred to
(b′) + B1c — only (A) is. See §4 step 1.4 for the named (A)/(B) split.

**Owner-set redo order for B1a** (as given; ⟲B2-self the second item's "no credential decryption" is now
known **unsatisfiable as stated** — see §4 step 1.2 decision (α) — and is carried here verbatim only because
this line records the owner's instruction, not the resolved design): real config v2 → system identity read
with no credential decryption →
first-party canonical contract version → server-bound source executor with field translation → remove or
privatise the legacy `probe()` entry point. ⟲B2 It is transcribed into **§4 step 1**, which is the single
authoritative order; if this line and §4 ever disagree, **§4 wins**.

**Consequence for this line's status:** the earlier conclusion that *"the remaining critical path is owner
decisions, not engineering"* is **withdrawn** — there is real qualification-authenticity implementation work
remaining, and it is the largest unbuilt item on the line. The on-prem M0 track (complete RC-A package build
+ bounded approved config) is independent of B1a/B1b and may proceed in parallel.

### 3.1 ⟲P1-a — the certificate holds the REQUIREMENT; the config holds the FIELDS

The ratified certificate model already carries **`orderingKeyRequirement`** (contracts §certificate fields) — a capability-level *requirement*, never the customer's concrete columns. The concrete **`orderingKeySpec`** (ordered field list + directions) belongs to the **approved config version** (customer/binding-scoped, immutable per version). rev‑1 of this design put `orderingKeyFields` in the certificate — wrong layer; withdrawn.

**B1a core — server-side approved-binding resolver.** Input: `approvedConfigVersionId` (+ principal for authz). ⟲R3 The server derives the **complete qualification input tuple** — `{ actionProfileVersion, systemContentKey, configContentKey, objectKey, canonicalObjectVersion, orderingKeySpec }` — from the same tenant's approved **binding + config + system** records — ⟲B2-self **and, after ⟲B, from one
further first-party source: `canonicalObjectVersion` is LOOKED UP from the canonical object contract registry
(§3.0 B-3), never derived here.** The pre-⟲B formulation ("and from nothing else") reinstated exactly the
locally-invented derivation B-3 withdraws, in a paragraph §4 endorses as retained; the registry is a fourth
**server-side** source and is still never caller-suppliable, which is the property that clause existed to
protect. ⟲B2-self **And after B-2 there is a FIFTH:** `systemContentKey` is no longer a pure derivation from
the system record either — it is a lookup against the **per-connector-kind identity declaration** registry
(§3.0 B-2). Both registries are first-party, versioned and server-side; neither is caller-suppliable. Apart
from those two fields: from those records and nothing else. Binding only three fields (rev‑2's `{objectKey, orderingKeySpec, configContentKey}`) was insufficient: **any** digest input left caller-supplied re-opens the forgery as "config A + system-or-profile B". Requirements:
  - at resolution time, re-verify the version is STILL approved — **and still within the caller's tenant and scope** — through the existing **`getForRuntime()`** path (`readSourceConfigStore.getForRuntime`, called with scoped input; throws `ReadSourceConfigNotApprovedError` for a non-approved version — ⟲B2-self an earlier revision wrote a bare `NOT_APPROVED` token, which does not exist in the module — approval, tenancy and scope are re-checked at resolution time, never assumed from the id);
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
- Probe-execution seam note: probe SQL uses `GROUP BY`/`HAVING` shapes the structured facade cannot express, so a **restricted internal probe-executor seam** is needed — accepts ONLY strategy-minted statements (object-identity trust), read-only, statement-bounded, never reachable from HTTP input. Per the owner's dependency direction, core-backend contributes this bounded seam and nothing else; qualification definitions stay in the GIP layer. ⟲B2-self **Which slice owns it, as currently ratified: B1a step 1.4** — it is named in the Gate's fourth permitted bullet, and **B1b merely consumes it**. The earlier wording ("B1b needs…") put the same artefact behind a different gate than the one authorizing it, and left a second-package (core-backend) production change permitted only by implication. **⟲OD3 — RETRACTION: an earlier revision of this note asserted "NOT B1a step 1.4 — it defers to (b′) + B1c" as an owner ruling dated 2026-07-26. No such ruling exists; that claim is WITHDRAWN.** ⟲OD3 is instead a **PROPOSED amendment, submitted 2026-07-26 and pending owner ruling**, recommending the opposite of the ownership stated above: that this seam move OUT of B1a step 1.4 and defer to (b′) + B1c. Reasoning: both prior wordings ("B1b needs…" and "step 1.4's gate") were written **before** decision (δ) fixed v1 = (c) (ruled 2026-07-25); under (c) the seam's justification (SQL `GROUP BY`/`HAVING`) and its consumer (B1b's SQL builders) are **both unreachable in v1**, so assigning it to 1.4 would build a second-package production surface nothing can call. **If ruled, it would travel with the SQL path** to (b′) + B1c. **Until ruled, ownership remains B1a step 1.4, as stated above.**

### 3.3 ⟲P2-a — frozen legal combinations; rejection, never silent downgrade

"`PAGED_READ` ⇒ consistency proofs non-empty" is too weak. The certifiable combinations are a **FROZEN table** (extending the existing scale-D0 §2 cross-dimension legality pattern), ⟲R5 **named `PAGED_READ_LEGAL_COMBINATIONS` and consulted ONLY when `acquisitionMode === 'PAGED_READ'`** — it is not a global gate over all modes:

| consistency proof | continuation lifetime |
|---|---|
| `SOURCE_SNAPSHOT_TXN` | `CONNECTION_BOUND` |
| `IMMUTABLE_SNAPSHOT_TOKEN` | `DURABLE_TOKEN` |

`MONOTONIC_VERSION_PIN` is deliberately **unmapped for `PAGED_READ`** in v1: a version pin *detects* drift; it does not make pages mutually consistent — abort-on-drift is a weaker, different contract that would need its own ratification before appearing here. ⟲R5 It **remains legal where already ratified in other modes** — specifically, the ratified `CHANGE_FEED + MONOTONIC_VERSION_PIN + DURABLE_TOKEN` combination is untouched. **Mandated harness negative-control pair:** the existing `CHANGE_FEED` combination still certifies, while an out-of-table `PAGED_READ` combination is refused.

Any other `PAGED_READ` combination ⇒ **closed rejection at certification time** — ⟲B2-self reusing the rule tokens minted at `774bdb5e6` — the **HELD** #4596 head; they are **NOT on main** (0 occurrences at `origin/main`, 5 there) — `PAGED_READ_REQUIRES_CONSISTENCY_PROOF` and `PAGED_READ_LEGAL_COMBINATION` (`gip-profile-certification-contracts.cjs` @ `774bdb5e6`), which the redo re-lands under these exact names. An earlier draft wrote *"the contracts module already ships"* — **false, and the same held-PR-quoted-as-shipped class as the GIP-D0 error**; contrast §4 step 3's `PROBE_STRATEGY_UNBOUND`, which genuinely **is** on main (2 occurrences) and is correctly labelled "existing"; an earlier revision invented a third name (`PAGED_READ_COMBINATION_UNSUPPORTED`), which invites exactly the drift this table exists to prevent. **Never silently downgrade to `BOUNDED_READ`**: the profile is refused; a caller that wants bounded semantics certifies a separate bounded profile (the `bridge.bounded_read.v2` pattern — one door per capability).

### 3.4 ⟲P2-b — contracts may be latent; counters cannot

`unorderedOffsetAttemptCount` only means something as **runtime instrumentation**, and a capability handshake is only real at a **wired endpoint** — both are incompatible with "latent" by definition. Therefore B1a freezes the **counter and handshake contract shapes only** — ⟲B2 a statement about *these two artefacts*, not a claim that B1a as a whole is contract-only (see Gate) — with hermetic harness tests:
- counter: name + values-free semantics (counts only, no identifiers);
- handshake: request/response schema — `clientBuild` / `connectorProtocolVersion` / `profileId` / `configVersion` → `READY` / `UPGRADE_REQUIRED` / `CONFIG_MIGRATION_REQUIRED`, version-incompatible ⇒ refuse to run.

**Wiring either is B1-observability — §4 item 5, a separate runtime-authorization gate.** Freezing the two
shapes is **§4 step 1.6**, inside B1a. ⟲B2 Precision, since the authority-substrate gate does permit an
additive change to the approved-config validator: B1a **wires neither** the counter nor the handshake into any
live path, and the only thing it changes on a request path is **validation and persistence of the two new
config fields** (Gate). ⟲B2-self Two earlier formulations were false here — *"nothing in B1a touches a live
path"*, and its replacement *"adds no request-reachable surface"* — both for the same reason: the
approved-config validator is behind a live route.

### 3.5 ⟲P3-a — sealed snapshot's true scope

Sealed export is the **preferred** exit for the bridge / big-data / non-paginatable class (#4437's blocker class). It is **not** the sole exit for SQL sources: a direct SQL database may certify `PAGED_READ` once the B1c connection-bound snapshot reader exists. rev‑1's "multi-page consistency ⇒ sealed-export territory" is corrected to per-source-class — and ⟲C5 the routing decision is made **per capability spike** (does THIS source hold durable snapshots / stable cursors?), never uniformly per database brand.

## 4. Slice order — **RATIFIED** (owner, 2026-07-25, @ `a7c562d34`); this section is the SINGLE authoritative order

### 4.0 ⟲OD Decision roster — ALL FOUR, ruled 2026-07-25

⟲B2-self This roster exists because an earlier revision listed **three** blocking decisions in its summaries
while the body carried a **fourth** (the canonical contract registry) as an inline "open" note — so the
roster, not the text, was the defect. Every decision that gates a step is listed here, and any future one is
added here first.

| # | decision | ruling | lands in |
|---|---|---|---|
| **(α)** | identity read vs credential decryption | **(i)** — **two materials, two rules.** *Identity material* (principal/scope): bounded decryption **inside the `credential-store` boundary**, **domain-separated HMAC / canonicalise immediately, discard plaintext**. *Authentication secret*: **consumed inside the boundary by a connector-owned factory returning an opaque handle / execution closure**, never reachable from the executor — **HMAC does not apply**. Shared: neither may reach evidence, logs or errors. Rotation with unchanged principal+scope ⇒ `systemContentKey` unchanged; changed principal **or** permission scope ⇒ **rebuild lineage and re-qualify** | §4 steps 1.2 / 1.4, Gate bullets 2 and 4, §3.0 B-2 |
| **(β)** | connector-`kind` vocabulary | **first-party CLOSED registry**; existing aliases **explicitly mapped**; unknown kind ⇒ fail closed for GIP binding with **`SYSTEM_IDENTITY_KIND_UNCERTIFIED`**; **never** auto-extended from customer free strings; **legacy paths keep working** | §4 step 1.2, §3.0 B-2 |
| **(γ)** | canonical object contract registry | **first-party only**; immutable registration by **`contractId` + `version`**, versions **append-only**; **no auto-synthesis from customer config**; unregistered ⇒ values-free **`CANONICAL_OBJECT_CONTRACT_UNREGISTERED`**; **inventory + backfill existing references BEFORE activation** | §4 step 1.3, §3.0 B-3 |
| **(δ)** | B-6 source-column translation scope (⟲B2-self **note: this ruling is obligation (A) only** — SQL target `fieldId` → source column; a separate **obligation (B)** — HTTP `fieldMap` → response path — is **NOT** deferred by it; see the (A)/(B) split at §4 step 1.4) | **v1 = (c)** — connector-owned, **named, certified HTTP probe actions only**; **SQL builders stay unreachable**; **no** SQL-shaped widening of `approved-config` and **no** invented source-column artefact; SQL path (obligation (A)) deferred to **(b′) + B1c** behind its own gate | §4 step 1.4, §3.0 B-6 |

**⟲OD2 An inventory TOOL is not an inventory RESULT — the roster's (β)/(γ) inputs are still absent.** The
probe tooling built for those decisions runs its CI against a **fake executor with no real database**, so it
establishes only that the tool behaves; it produces **no** alias map and **no** backfill list. Owner ruling:
**B1a-2 may build the empty registries and the fail-closed substrate now**, but the concrete **(β) alias map**
and **(γ) canonical-contract backfill list** must wait for a **privately-authorized real inventory run** —
which is separately ops-gated (§4 step 1.2/1.3, and the read-only authorization noted in §2 M1). Do not let a
green tool suite read as a completed inventory.

**Consequence: steps 1.2, 1.3 and 1.4 are no longer NOT STARTABLE.** What still gates item 1 is
re-ratification of this section, nothing else.


**The previous order was ratified BEFORE §3.0 and is superseded.** It described B1a as *latent* and let B1b
register *certified* strategies directly — both now false. It was un-ratified pending owner re-approval, and is now **RATIFIED (owner, 2026-07-25, @ `a7c562d34`)**. Precedence rule, stated once and covering the whole document so two orders cannot coexist:
**all sequencing and scope — including B2's preconditions — is §4's.** Where **any other section,
including §5, §6 and the Gate**, implies a different sequencing or scope, **§4 wins**. ⟲B2-self The earlier
form enumerated only §1/§2/§3.x, so a §4↔§6 conflict had no tiebreak while the rule advertised itself as
covering the document. Two honest caveats rather than an overclaim: **§1 is a record and should schedule
nothing** — where it still does (the §1 P3 follow-up note), that is a defect in §1, not a competing order;
and §4 **imports** two gates it does not itself schedule a producer for — the agent/protocol-version preflight
and the `stock-prep:read/operate` permission split — both of which live in §2 M1 and are named here as
preconditions rather than re-hosted.

1. **B1a (REDO)** — the authority substrate. Substeps 1.1-1.5 are the **owner-set order verbatim**;
   ⟲B2-self **1.6 is added by this revision** (it traces to round-1 ⟲P2-b, not to the owner's instruction) and
   is flagged so re-ratification is not asked to approve an addition under the owner's own label. Each step
   lands behind the authority-substrate gate:
   1. **real config v2** — `orderingKeySpec` (closed schema, §3.1⟲R6) + `actionProfileVersion` accepted by
      the approved-config validator **and carried through `normalizeReadSourceConfig` into the stored body**,
      additively; and configs omitting the fields are unaffected.
      **⟲OD2 AMENDED (owner, 2026-07-25).** This clause previously read *"the existing test that asserts
      today's rejection **flips in the same PR**"*. **There is no such test**, and the error is the ledger's
      own: `gip-approved-binding-resolver.cjs` and the suite that asserted that rejection behaviourally exist
      only in the now-CLOSED **#4596**, never on `main` — a **held-PR artefact written into the ratified text
      as if it were a fact about `main`**, the same class the ledger documents at §3.0 B-2 and §5. Verified at
      `402f04982`: no test in the read-source-config validator or store names either key. **Ruled replacement:
      add a NAMED pre-change-RED / post-change-GREEN characterisation test, and RETAIN the pre-existing generic
      unknown-key negative control.** Do not describe this as flipping an existing test.
      ⟲B2-self **Acceptance predicate, because an allowlist-only change satisfies mere acceptance while
      dropping the fields** — `normalizeReadSourceConfig` (`read-source-config.cjs` L277-L304 @ `774bdb5e6`)
      copies key by key, so a key merely allowlisted never reaches storage, and `contentKeyFor` hashes that
      projection. Both required: **(i)** save a body carrying both fields, re-read the stored row, assert both
      survive into `config`; **(ii)** assert two bodies in the same family differing **only** in
      `orderingKeySpec` mint **different** `content_key`s and different versions — otherwise they collapse and
      the idempotent-save path (`read-source-config-store.cjs` L231-L233) returns the *older* version, i.e.
      `configContentKey` silently stops pinning ordering behaviour, which is the property §3.1 and the
      qualification digest both rest on. Without (i) and (ii) the step ships green and B-6's real
      **save → approve → re-read → qualify** loop stays unproven while looking proven.
      ⟲B2-self **Record the direction-case
      decision here, because this step is where the code says it belongs:** the same validator already carries
      a LOWERCASE vocabulary — `RESOLVER_SORT_DIRECTIONS = ['asc','desc']` for `resolverSortDirection`
      (`read-source-config.cjs` L27 @ `774bdb5e6`) — while ⟲R6 freezes `orderingKeySpec.direction` as
      UPPERCASE `ASC`/`DESC`, and the resolver header assigns the reconciliation to *"the gated change that
      adds `orderingKeySpec` to the config allowlist"*, i.e. this step. **Decision to ratify: keep both as
      they are** — `orderingKeySpec` uppercase-strict, `resolverSortDirection` lowercase — because a
      read-time normalizer would let two textually different approved bodies (different `configContentKey`s,
      different digests) behave identically, and the content key would stop pinning behaviour. Pin the choice
      by test in the same PR; do not leave the two vocabularies unremarked in one config body.
   2. **system identity read** — purpose-built, lossless, implementing the **ratified GIP-D0 §6 formula**
      (§3.0 B-2) plus the per-connector-kind certified identity declaration and its fail-closed refusal for an
      undeclared kind. **⟲OD Both blockers are now RULED (owner, 2026-07-25); this step is STARTABLE.**
      - **(α) RULED — option (i): bounded decryption inside the credential-store boundary.** The problem it
        answers: `authPrincipalKey` / `authTenantScopeKey` do **not** live in `config` for any shipped
        connector kind — they are in the **AES-256-GCM credential envelope** (K3 WISE WebAPI takes `username`
        and `acctId`/`accountSet` from `credentials`, `adapters/k3-wise-webapi-adapter.cjs` L1555-L1557; the
        HTTP adapter takes `username`/`password` from `credentials`, `adapters/http-adapter.cjs` L131). The
        ruled design:
        - decrypt **only within the `credential-store` boundary**, and only **briefly**, to extract the
          **connector-certified** principal / scope material;
        - **immediately** apply a **domain-separated HMAC / canonicalisation**, then **discard the plaintext**;
        - **secrets and principal plaintext must never enter evidence, logs, or errors** — this is a
          fail-closed rule, not a code-review preference, and belongs in the same negative-control class as the
          values-free evidence guarantees elsewhere in this design;
        - **rotation semantics, which are the observable contract:** key rotated, principal and permission
          scope unchanged ⇒ `systemContentKey` **unchanged**. Principal **or** permission scope changed ⇒
          lineage **must be rebuilt and the binding re-qualified**. Both directions want a test.
        - ⟲OD **This rule governs IDENTITY MATERIAL ONLY.** The **authentication secret** used to actually
          connect is a different material with a different rule: it is **consumed inside the boundary by a
          `credential-store` / connector-owned factory** that returns an **opaque handle / execution
          closure**, and it is **never returned to, held by, or reachable from** the executor (step 1.4).
          **HMAC is not applicable to it** — a hashed secret cannot authenticate, so an implementer told to
          "HMAC and discard" the connection credential could not both discard it and connect. Only the
          never-into-evidence-logs-or-errors constraint is shared by both materials.
      - **(β) RULED — a first-party CLOSED connector-kind registry.** The problem it answers: `kind` is a
        free-form `requiredString` with **no vocabulary anywhere** (`external-systems.cjs` L91 — contrast
        `VALID_ROLES` / `VALID_STATUSES`, enumerated and exported) and is **immutable after creation**
        (L253-L254), so every stored system carries an arbitrary operator-supplied string. The ruled design:
        - the registry is **first-party and closed**; **existing aliases must be mapped EXPLICITLY**;
        - an unknown kind **fails closed for GIP binding** with **`SYSTEM_IDENTITY_KIND_UNCERTIFIED`**;
        - the registry may **never be auto-extended from customer free strings**;
        - and it **must not disturb the existing usability of legacy paths** — the fail-closed applies to GIP
          binding, not to what already works. That last clause is the one an implementer is most likely to
          break, so it wants an explicit negative control: a system whose kind is uncertified still works on
          its pre-GIP path while being refused a GIP binding.
   3. **first-party canonical object contract registry** + version lookup (**B-3**) — no locally invented
      version. **⟲OD RULED (owner, 2026-07-25) — this was the FOURTH open decision**, and ⟲B2-self an earlier
      revision listed it as open here while omitting it from the decision roster, so it read as a note rather
      than a blocker. The ruled design:
      - **first-party only.** Contracts are registered **immutably** by **`contractId` + `version`**; versions
        are **append-only** — a registered version is never edited;
      - **no auto-synthesis from customer config** — the failure mode this closes is precisely B-3's
        "invented locally";
      - an unregistered object ⇒ **values-free `CANONICAL_OBJECT_CONTRACT_UNREGISTERED`**;
      - **inventory and backfill existing references BEFORE activation** — today every approved config derives
        a version, so without the backfill an unregistered object silently becomes unbindable at cutover;
   4. **server-bound source executor** — handle and field set derived from the resolution, first-party
      statement builders admitted by **module-private identity** (**B-4**), restricted statement seam
      (including the bounded core-backend seam of §3.2, **as currently ratified** — see the pending ⟲OD3
      proposal below), plus **certified source-column translation** for `orderingKeySpec` (**B-1**, **B-6**).

      **B-6 is two separate translation obligations, not one — do not read either as covering the other:**
      - **(A) SQL target `fieldId` → source column**, for `orderingKeySpec`'s use by a SQL builder. Per
        decision (δ), **ruled 2026-07-25 (v1 = (c))**: SQL builders stay unreachable in v1, so this translation
        has **no v1 source** — it is **deferred to (b′) + B1c**, travelling with the SQL path.
      - **(B) HTTP `fieldMap` → response path / field set**, for the certified HTTP probe surface v1 actually
        runs. This is **not deferred — it is v1 work**: the field set the executor probes for must be
        **derived server-side from the approved resolution** (**B-1**), never supplied or interpreted by the
        caller; leaving it undone would let a connector or caller decide which response fields count as which
        target field, precisely the field-set forgery B-1 requires be inexpressible.

      **⟲OD3 — RETRACTION FIRST: an earlier revision of this step stamped "The bounded core-backend seam of
      §3.2 is REMOVED from this step" and restated v1 scope as "a plugin-layer, HTTP-only executor," both
      marked "(owner, 2026-07-26)." No such ruling exists — both claims are WITHDRAWN.** ⟲OD3 is instead a
      **PROPOSED amendment, submitted 2026-07-26 and pending owner ruling**: remove the bounded core-backend
      seam from this step (per Gate bullet 4's matching proposal; it would defer with the SQL path to (b′) +
      B1c), and restate v1 scope positively — a plugin-layer, HTTP-only executor whose handle and field set
      derive from the resolution (**B-1**), admitting only connector-owned, named, certified HTTP probe
      actions (**B-4**), and deriving obligation (B) above server-side from that same resolution. Reasoning:
      under decision (δ)'s v1 = (c), the seam's justification (SQL `GROUP BY`/`HAVING`) and its consumer
      (B1b's SQL builders) are both unreachable in v1, so retaining the seam in this step would build a
      second-package production surface nothing can call. **Until ruled, the step above — seam included — is
      the authorized text; the positive plugin-layer-only restatement is the proposal, not yet the gate's
      text.** Obligation (A) is unaffected either way: it has no v1 source because decision (δ) already makes
      SQL unreachable in v1, independent of whether ⟲OD3 is ruled.

      **⟲OD RULED (owner, 2026-07-25) — B-6 v1 = option (c);** ⟲B2-self this
      line previously said "picks (a) or (b)", a **stale label** against the authoritative three branches
      (a)/(b′)/(c). The ruling, and its consequences stated plainly:
      - B1a admits **connector-owned, NAMED, CERTIFIED HTTP probe actions only**;
      - **SQL builders stay unreachable** — that is the accepted v1 outcome, not a gap to work around;
      - **do NOT** widen `approved-config` to a SQL-shaped source class to make schedule, and **do NOT**
        invent a source-column artefact. Both are explicitly refused for v1;
      - obligation (A), the SQL path, is deferred to a later **(b′) + B1c** step behind **its own gate**.
      So the non-existent per-system SQL source-column mapping is no longer a blocker: v1 does not need it,
      because v1 does not reach a SQL source. **Obligation (B) is separate from obligation (A) and remains
      v1 work**, applied within the certified HTTP probe-action surface;
   5. **remove or privatise the legacy `probe()` entry point** — ⟲B2-self this closes **B-1**'s first
      residual (the caller-supplied tuple / `keyColumns` path). It is **not** B-4's closure; B-4 is closed by
      1.4's builder identity and by step 3. An earlier revision tagged this (B-4) in two places;
   6. **freeze the counter + handshake contract shapes** (§3.4) — hermetic tests only, **no wiring**.
      ⟲B2-self Listed as a substep because withdrawing the "latent contract + harness" clause removed the only
      sentence that scheduled them.
   - Retained from the prior design, unchanged: approved-binding resolver over the full six-field tuple,
     deep-immutable (§3.1⟲R2/⟲R3) — **minus `canonicalObjectVersion`, which now comes from step 1.3's
     registry rather than being derived**; qualification input binding through the resolution object for
     **probe AND verify**; `PAGED_READ_LEGAL_COMBINATIONS` (§3.3⟲R5); closed errors; hermetic harness.
   - **Acceptance predicate — construction-level, split per residual.** ⟲B2-self An earlier version said
     simply "both residuals must invert", which fails twice: residual 1's construction goes through the
     prober object's own `probe()` **method** (`gip-binding-qualification-spike.cjs` L360-L371 @ `774bdb5e6` —
     *not* a module export; see the residual-1 bullet below) that step 1.5 removes, so it yields a **missing
     method**, not a refusal — and the
     cheapest way to satisfy "must produce a closed refusal" literally would be to **keep** `probe()` and add
     a check, i.e. *detection*, which B-1 explicitly rejects in favour of inexpressibility. Residual 2, by
     contrast, inverts the moment `query` leaves the resolution-bound input allowlist — so on its own it only
     measures "step 1.4 was performed":
     - **residual 1** (`ratifiedPathRemainsAnOpenConstruction`, L752-L805 @ `774bdb5e6`): ⟲B2-self an earlier
       wording said *"`probe()` absent from the module's exports"* — that assertion **passes today** and is
       therefore **vacuous**: `probe` is not a module export at all, it is a method on the frozen object
       returned by `createBindingQualificationProber` (`gip-binding-qualification-spike.cjs` L360-L371), which
       is exactly how the residual test reaches it. Bind the predicate to the surface the entry point actually
       lives on: **assert the EXACT key set of that frozen prober object** — `probeFromResolution` and nothing
       that accepts a caller-supplied tuple — so a re-addition **under any name** reds. The case is then
       **RETIRED as inexpressible**, not "refused". If the entry point is privatised rather than removed, a
       **named closed reason** instead;
     - **residual 2** (`callerSuppliedQueryRemainsAnOpenConstruction`, L813-L847 @ `774bdb5e6`): a
       caller-supplied `query`/handle is refused with a **named closed reason**;
     - **NEW negative control, which is the one that actually carries B-1:** two resolutions bound to
       **different systems** must **not** both qualify from a single executor answer — i.e. the handle
       demonstrably derives from each resolution's own system record. Without this, the pair above proves
       only that an argument was removed;
     - **positive control:** a probe executed **through the server-bound executor against the harness
       source** still qualifies.
     - ⟲B2-self **Read this before re-ratifying:** the last two controls run **through step 1.4**, which is
       scoped by B-6's ⟲OD ruling to the **certified HTTP probe-action surface** (v1 = (c)) — so these controls
       are exercised there, not against a SQL source, and the first two controls **alone are not sufficient** (residual 2 inverts the moment
       `query` leaves the input allowlist, which measures that a step was performed, not that evidence came
       from the bound system).
2. **B1b capability spike — REAL MySQL and SQL Server, before any certification.** Empirical only, on the
   **same connection**; mints **no certification** and registers **no strategy**. ⟲B2-self **Runs against
   FIRST-PARTY engine instances only.** Everything this step establishes is engine capability, which a
   first-party instance proves; connecting to **any customer system** is a **separate ops-gated step** with
   its own scope, consent, credential handling and read-only assertion — treated like M0-B, and **not**
   ratified by re-ratifying §4. An earlier revision's Gate parked live-customer connection "in step 2", which
   this step never claimed and does not bound. ⟲B2 This step did not exist
   in the ratified order and is the reason B1b shipped a strategy whose own token names the **absence** of a
   guarantee (**B-5**).
   - **MySQL:** InnoDB, autocommit, isolation ≥ READ COMMITTED — all three established empirically, not named
     in a token.
   - **SQL Server — ⟲B2-self freeze THREE outcomes, not one.** An earlier version asked only whether a
     single-statement snapshot is obtainable *under the engine default*, which fails safe but **silently
     discards two legitimate capabilities**:
     1. **default READ COMMITTED, no RCSI** ⇒ **refuse certification**;
     2. **RCSI enabled** ⇒ certifiable as its **own separate profile**, after same-connection empirical proof;
     3. **explicit SNAPSHOT transaction** ⇒ **must be proven by the later connection-bound seam (B1c)** — a
        single-statement B1b strategy may **not** claim it.
3. **B1b certification — opens ONLY if step 2 passes**, per dialect and per capability, never per brand.
   Each strategy carries a **verified** snapshot-semantics guarantee, registered per `actionProfileVersion`;
   where the guarantee is unobtainable it must **refuse certification** rather than mint a candidate.
   Builders are admitted by **module-private identity**; the SQL denylist is defence-in-depth and **may never
   be cited as the boundary** (**B-4**). Unbound ⇒ `PROBE_STRATEGY_UNBOUND` (existing, fail-closed by name).
   PostgreSQL reuses the shipped reference strategy.
4. **B1c** — cross-page snapshot/session executor: design + per-dialect certification of a page-sequence
   consistency context; and the only place an explicit SNAPSHOT transaction claim may be established.
5. **B1-observability** — counter + field-client handshake **wiring**. Separate runtime gate; owner decision
   recorded: **not opened early**. ⟲B2-self **Precondition, carried here because §4 wins over §2 and would
   otherwise unschedule an owner-ruled hard gate:** the **agent/protocol-version certification-scoped
   preflight** (§2 M1, §1) is a **hard gate before this item and before any activation / arming / runtime
   wiring**.
6. **Customer migration** — in-repo inventory script per deployment; migrate any live configs to the
   versioned shape.
7. **B2 = #4591 enforcement** (adapter ordering guard + typed closed 422 + MSSQL fallback deletion).
   **LAST**, after items 1-6. (#4580 CLOSED as superseded — see §1.)

**Out of this order, deliberately:** §2's **M2** is an evidence-gated track (scale-D0 ratification, sealed-
snapshot feasibility spike) — nothing in it is scheduled here, and it enters on M0/M1 evidence.

**Parallel and unblocked by all of the above: the on-prem M0 track, in TWO phases** — ⟲B2-self named as two,
because an earlier version listed only the first, and since §4 wins on scope that silently deleted the
preflight, the flag-ON window and #4437 closure from everything this document schedules:
- **M0-A (authorized now):** build and verify the complete RC-A package at the owner-chosen SHA (**⟲OD2 ruled: `7bf2bd7a1`** — not current main, to avoid enlarging the runtime change surface), regenerate
  manifest / SHA256 / provenance / **loopback verification**, revise the #4437 pointer, and prepare the bounded
  approved config. **Not** deployment, **not** flag-ON.
- **⟲OD2 The "loopback verification" output was a SPECIFICATION GAP, and the owner ruled it CLOSED BY BUILDING
  THE CHECK — not by amending the contract away.** Verified: `scripts/ops/multitable-onprem-package-verify.sh`
  records **four** checks (checksum / required-content / deployability-contract / no-github-links) and performs
  **no** loopback check, while attendance's equivalent verifier does. Ruled design: **port attendance's rule —
  the frontend bundle must not embed a loopback `VITE_API_URL` / base** — with **positive AND negative
  fixtures** (a bundle that embeds a loopback value MUST fail; without the negative fixture the check is
  unfalsifiable) and a **fifth reported field**. The check may be executed by the **current standalone
  verification tool against `7bf2bd7a1`'s artifacts**, recorded under a **separate `verificationToolSha`** —
  **never conflated into `serviceRuntimeSha`**, which is the exact conflation ⟲R7 exists to prevent. Owner's
  own inspection of run **30148584851**'s A1 artifacts found the forbidden pattern **absent**, so this is
  expected to be completing the proof, not changing service code; a real embedded loopback value would be a
  different and far larger problem and must be escalated, not fixed in place.
- **⟲OD2 A1 vs M0-A, stated so the verdicts cannot drift:** build + verify executed at `7bf2bd7a1` with
  `publish_release=false` (run 30148584851) is **A1 PASS**. **M0-A remains open** pending the loopback check
  above and the owner-only **A2** publish/freeze act.
- **M0-B (ops-gated, its own authorization):** controlled deploy of the new service package → flag-OFF health
  verification → bounded-config flag-OFF preflight (`SHORT_PAGE`) → one C-stage flag-ON window → 11-item PASS
  ⇒ closes #4437 as a bounded-subset mechanism acceptance.

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
  ⟲B2-self **The allowlist is the REJECTION gate; `normalizeReadSourceConfig` (L277-L304) is the PERSISTENCE
  gate, and `contentKeyFor` runs on its output.** Add the keys in **both** places, or the save succeeds with
  the fields absent from storage **and** from the content key — and the flipped assertion goes green anyway.
- ⟲B2 **`canonicalObjectVersion` is a first-party contract version.** Do not attempt to make it witness the
  external source's schema; drift belongs to source-catalog evidence / BindingQualification / field-mapping
  proof (§3.0 B-3). A derivation that is a pure function of the other tuple fields adds nothing.
- ⟲OD **Three ruled fail-closed reasons are now part of the contract, values-free:**
  `SYSTEM_IDENTITY_KIND_UNCERTIFIED` (unknown connector kind, GIP binding only — legacy paths keep working)
  and `CANONICAL_OBJECT_CONTRACT_UNREGISTERED` (unregistered object). Both are **closed reasons**, not
  generic errors, and neither may carry an identifier or a value. The third rule has no token because it is a
  prohibition: under (α), a **secret or a principal in the clear must never reach evidence, a log or an
  error**.
- ⟲OD **Do not apply one credential rule to two materials.** *Identity material* → decrypt inside the
  `credential-store` boundary, HMAC/canonicalise immediately, discard. *Connection secret* → consumed inside
  the boundary by a **connector-owned factory** that hands back an **opaque handle / execution closure**;
  the executor never sees it and **must not** try to HMAC it. Conflating the two produces an instruction no
  implementation can satisfy — discard the secret *and* complete an authenticated connection.
- ⟲OD **Rotation is an observable contract, so test both directions:** key rotated with principal and
  permission scope unchanged ⇒ `systemContentKey` **unchanged**; principal **or** permission scope changed ⇒
  lineage **rebuilt** and the binding **re-qualified**.
- ⟲B2-self **`systemContentKey`'s contract is `GIP-D0` §6, NOT `deriveSystemContentKey` as shipped in
  #4596.** The ratified formula is `hash(kind + endpoint identity + authPrincipalKey + authTenantScopeKey)`;
  the shipped code hashes the whole `config` plus `role` and the raw ids, which is a **deviation**. Do not
  read the implementation as the spec — that mistake is what produced a whole round of this document. `role`
  and the raw ids stay **out**; adding them would be a new amendment needing its own ratification.

## 6. Fences

Nothing in this document authorizes: runtime enforcement (#4591/B2), arming or runtime wiring of any GIP
profile, telemetry/handshake wiring, sealed-snapshot implementation, page-size ceiling changes, CDC /
external write-back / D2 / W3 / G1 work (frozen), or rollout.

⟲B2 Approval unlocks the **B1a authority-substrate gate** as defined verbatim in **Gate** at the head of this
document — **not** "latent contract + harness only", which is withdrawn. That gate permits the **six** bounded
internal changes of §4 item 1 (⟲B2-self *six*, not five: substep **1.6** freezes the counter-and-handshake
shapes, while §4 item 1's separate **"Retained"** bullet carries the resolver / combinations / closed errors /
harness — the Gate's sixth permitted bullet covers **both**, and the withdrawn clause had been the only thing
authorizing either). On the request path it permits **validation and persistence of the two new config fields
and nothing else**; qualification execution, external-source reads, new side effects and new routes stay
forbidden from any request or scheduled run. Every later slice re-enters its own gate. **§4 is itself pending
re-ratification** — until the owner re-approves it, nothing after **B1a (§4 item 1)** is scheduled by this
document, other than the parallel on-prem track — ⟲B2-self **both phases of it, M0-A *and* the ops-gated
M0-B**. Naming M0-A alone here would re-commit the exact fault §4's M0 note was added to prevent: deleting
the preflight, the flag-ON window and #4437 closure from everything the document schedules.
